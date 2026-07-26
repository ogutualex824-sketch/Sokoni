/* ================================================================
   SOKONI FinOS — Universal Transaction Router  v2.0  (12 CFs)
   ────────────────────────────────────────────────────────────
   Extension layer on top of finos.js / finos-utils.js.
   Provides:
     • Universal Transaction Router   finosRecordTransaction
     • Escrow Engine                  finosCreateEscrow / finosReleaseEscrow
                                      finosDisputeEscrow / finosResolveDispute
     • Settlement Rules               finosGetSettlementRules / finosUpdateSettlementRules
     • Auto-settlement                finosProcessSettlements (scheduled hourly)
     • Revenue Analytics              finosGetRevenueAnalytics
     • Bank Payout                    finosRequestBankPayout
     • Admin Dashboard                finosGetAdminDashboard
     • Receipt Generation             finosGenerateReceipt

   All monetary values in KES integer cents. Every write is idempotent.
================================================================ */
'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule }         = require('firebase-functions/v2/scheduler');
const logger                 = require('firebase-functions/logger');
const admin                  = require('firebase-admin');
const U                      = require('./finos-utils');

const REGION = 'us-central1';

function _db()  { return admin.firestore(); }
function _now() { return admin.firestore.FieldValue.serverTimestamp(); }
function _uid(req) { return req.auth?.uid || null; }
function _assertAuth(req) {
  if (!_uid(req)) throw new HttpsError('unauthenticated', 'Login required');
}
function _assertAdmin(req) {
  if (!req.auth?.token?.admin && !req.auth?.token?.superAdmin)
    throw new HttpsError('permission-denied', 'Admin access required');
}

/* ─────────────────────────────────────────────────────────────
   HUB TYPE → CATEGORY MAPPING
   Maps any SOKONI hub to its FinOS commission category.
──────────────────────────────────────────────────────────────*/
const HUB_CATEGORY_MAP = {
  marketplace: 'marketplace', shopping: 'marketplace',
  food_delivery: 'food_delivery', restaurant: 'food_delivery',
  services: 'services', home_services: 'services', healthcare: 'healthcare',
  legal: 'legal', education: 'education',
  property: 'property', property_agent: 'property', bnb: 'hotel', hotel: 'hotel',
  vehicles: 'vehicles', car_dealer: 'vehicles', car_hub: 'vehicles',
  events: 'events', entertainment: 'events',
  jobs: 'jobs', freelancer: 'jobs',
  digital_products: 'digital_products',
  logistics: 'hub', delivery: 'hub', driver: 'hub',
  ai_services: 'digital_products',
  pos: 'marketplace',
  subscriptions: 'subscriptions',
  advertising: 'advertising',
  insurance: 'services',
  pharmacy: 'healthcare',
  sports: 'events', fitness: 'services',
  b2b: 'marketplace',
  default: 'marketplace',
};

/* ─────────────────────────────────────────────────────────────
   ESCROW STATES
──────────────────────────────────────────────────────────────*/
const ES = {
  HELD:             'held',
  RELEASED:         'released',
  DISPUTED:         'disputed',
  REFUNDED:         'refunded',
  PARTIALLY_REFUNDED: 'partially_refunded',
  CANCELLED:        'cancelled',
};

/* ─────────────────────────────────────────────────────────────
   DEFAULT SETTLEMENT RULES PER HUB  (Firestore overrides these)
──────────────────────────────────────────────────────────────*/
const DEFAULT_SETTLEMENT_RULES = {
  marketplace:   { holdDays: 2,  autoRelease: true,  requireBuyerConfirm: false, disputeWindowDays: 7  },
  food_delivery: { holdDays: 0,  autoRelease: true,  requireBuyerConfirm: false, disputeWindowDays: 1  },
  property:      { holdDays: 7,  autoRelease: true,  requireBuyerConfirm: true,  disputeWindowDays: 30 },
  vehicles:      { holdDays: 5,  autoRelease: true,  requireBuyerConfirm: true,  disputeWindowDays: 14 },
  events:        { holdDays: 0,  autoRelease: true,  requireBuyerConfirm: false, disputeWindowDays: 3  },
  hotel:         { holdDays: 1,  autoRelease: true,  requireBuyerConfirm: false, disputeWindowDays: 7  },
  healthcare:    { holdDays: 1,  autoRelease: true,  requireBuyerConfirm: false, disputeWindowDays: 7  },
  services:      { holdDays: 2,  autoRelease: true,  requireBuyerConfirm: true,  disputeWindowDays: 7  },
  logistics:     { holdDays: 0,  autoRelease: true,  requireBuyerConfirm: false, disputeWindowDays: 2  },
  subscriptions: { holdDays: 0,  autoRelease: true,  requireBuyerConfirm: false, disputeWindowDays: 7  },
  default:       { holdDays: 2,  autoRelease: true,  requireBuyerConfirm: false, disputeWindowDays: 7  },
};

/* ─────────────────────────────────────────────────────────────
   INTERNAL: load settlement rules for a hub type
──────────────────────────────────────────────────────────────*/
async function _getSettlementRule(db, hubType) {
  const snap = await db.collection('finosSettlementRules').doc(hubType).get().catch(() => null);
  if (snap && snap.exists) return snap.data();
  const snap2 = await db.collection('finosSettlementRules').doc('default').get().catch(() => null);
  if (snap2 && snap2.exists) return snap2.data();
  return DEFAULT_SETTLEMENT_RULES[hubType] || DEFAULT_SETTLEMENT_RULES.default;
}

/* ─────────────────────────────────────────────────────────────
   INTERNAL: verify payment exists in Firestore
──────────────────────────────────────────────────────────────*/
async function _verifyPayment(db, paymentRef) {
  /* Path 1: initiateSTKPush writes to payments/{trackingId} */
  const paySnap = await db.collection('payments').doc(paymentRef).get();
  if (paySnap.exists && paySnap.data().status === 'completed') return true;
  /* Path 2: verifyIntasendPayment writes to orders with trackingId */
  const ordSnap = await db.collection('orders')
    .where('trackingId', '==', paymentRef).where('status', '==', 'paid').limit(1).get();
  if (!ordSnap.empty) return true;
  return false;
}

/* ─────────────────────────────────────────────────────────────
   1. finosRecordTransaction — callable
   UNIVERSAL ENTRY POINT: every hub calls this for any payment.
   Routes automatically through commission, wallets, and optionally escrow.
──────────────────────────────────────────────────────────────*/
exports.finosRecordTransaction = onCall(
  { region: REGION, timeoutSeconds: 60, memory: '256MiB', invoker: 'private' },
  async (request) => {
    _assertAuth(request);
    const {
      hubType, transactionId, amountCents, sellerId, buyerId,
      deliveryFeeCents, riderId, tipCents, paymentRef,
      useEscrow, metadata,
    } = request.data;

    if (!transactionId || !amountCents || !sellerId)
      throw new HttpsError('invalid-argument', 'transactionId, amountCents, sellerId required');
    if (!Number.isInteger(amountCents) || amountCents <= 0)
      throw new HttpsError('invalid-argument', 'amountCents must be a positive integer (KES cents)');
    if (amountCents > 50_000_000)
      throw new HttpsError('invalid-argument', 'Transaction exceeds maximum allowed (KES 500,000)');

    const hub      = (hubType || 'marketplace').toLowerCase();
    const category = HUB_CATEGORY_MAP[hub] || HUB_CATEGORY_MAP.default;
    const db       = _db();
    const caller   = _uid(request);

    /* Idempotency — lock FIRST before any financial work.
       Using create() so only one concurrent request proceeds; all others detect the lock. */
    const ikey    = U.generateIdempotencyKey(['utr', transactionId, hub]);
    const idempRef = db.collection('finosIdempotency').doc(ikey);
    let lockAcquired = false;
    try {
      await idempRef.create({
        key: ikey, status: 'pending', result: null,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        expireAt:  admin.firestore.Timestamp.fromMillis(Date.now() + 86400000 * 7),
      });
      lockAcquired = true;
    } catch (lockErr) {
      if (lockErr.code !== 6 && !lockErr.message?.includes('ALREADY_EXISTS')) throw lockErr;
      /* Another request already holds or completed this key */
      const snap = await idempRef.get();
      if (snap.exists && snap.data().status === 'completed') {
        return { ...snap.data().result, duplicate: true };
      }
      throw new HttpsError('aborted', 'Duplicate transaction — this payment is already being processed. Retry in a moment.');
    }

    /* Payment verification (skip for system-initiated calls like subscriptions) */
    if (paymentRef) {
      const verified = await _verifyPayment(db, paymentRef);
      if (!verified) throw new HttpsError('failed-precondition', 'Payment not confirmed. Call after STK push success.');
    }

    /* Fraud check */
    await U.checkFinancialFraud(db, { entityId: caller, entityType: 'buyer', eventType: 'purchase', amountCents });

    /* Commission */
    const comm = await U.calculateCommission(db, { orderAmountCents: amountCents, category, sellerId });
    const vat  = U.calculateVAT(comm.commissionCents, category);

    const deliveryCents  = Math.round(deliveryFeeCents || 0);
    const tipCts         = Math.round(tipCents || 0);
    const riderEarnings  = deliveryCents > 0 ? Math.round(deliveryCents * 0.88) : 0;
    const platformDeliv  = deliveryCents - riderEarnings;

    /* Determine escrow policy */
    const rule      = await _getSettlementRule(db, hub);
    const shouldEscrow = useEscrow != null ? useEscrow : (rule.holdDays > 0);

    /* ── Ledger: payment received ── */
    await U.createLedgerEntry(db, {
      type: 'payment_received', amountCents,
      debitAccount:  U.ACCOUNTS.EXTERNAL_GATEWAY,
      creditAccount: U.ACCOUNTS.PLATFORM_CLEARING,
      description:   `[${hub.toUpperCase()}] Payment — txn ${transactionId}`,
      orderId: transactionId, sellerId, buyerId, category,
      metadata: { hubType: hub, commission: comm, vat, ...(metadata || {}) },
      createdBy: caller, idempotencyKey: U.generateIdempotencyKey(['utr_recv', transactionId]),
    });

    /* ── Ledger: commission ── */
    await U.createLedgerEntry(db, {
      type: 'commission', amountCents: comm.commissionCents,
      debitAccount:  U.ACCOUNTS.PLATFORM_CLEARING,
      creditAccount: U.ACCOUNTS.PLATFORM_REVENUE,
      description:   `Commission (${comm.effectiveRate}%) — ${hub} txn ${transactionId}`,
      orderId: transactionId, sellerId, category,
      metadata: { rate: comm.effectiveRate, ruleId: comm.ruleId, hubType: hub },
      idempotencyKey: U.generateIdempotencyKey(['utr_comm', transactionId]),
    });

    /* ── VAT on commission ── */
    if (vat.taxCents > 0) {
      await U.createLedgerEntry(db, {
        type: 'tax', amountCents: vat.taxCents,
        debitAccount:  U.ACCOUNTS.PLATFORM_REVENUE,
        creditAccount: U.ACCOUNTS.PLATFORM_TAX,
        description:   `VAT (${vat.taxRate}%) on commission — ${transactionId}`,
        orderId: transactionId, sellerId, category,
        metadata: { taxType: 'VAT', hubType: hub },
        idempotencyKey: U.generateIdempotencyKey(['utr_vat', transactionId]),
      });
    }

    /* ── Delivery + tip ── */
    if (deliveryCents > 0 && riderId) {
      await U.createLedgerEntry(db, {
        type: 'delivery_fee', amountCents: riderEarnings,
        debitAccount:  U.ACCOUNTS.PLATFORM_CLEARING,
        creditAccount: U.ACCOUNTS.rider(riderId),
        description:   `Delivery fee — ${transactionId}`,
        orderId: transactionId, riderId,
        metadata: { gross: deliveryCents, platformCut: platformDeliv },
        idempotencyKey: U.generateIdempotencyKey(['utr_del', transactionId]),
      });
    }
    if (tipCts > 0 && riderId) {
      await U.createLedgerEntry(db, {
        type: 'tip', amountCents: tipCts,
        debitAccount:  U.ACCOUNTS.PLATFORM_CLEARING,
        creditAccount: U.ACCOUNTS.rider(riderId),
        description:   `Tip — ${transactionId}`, orderId: transactionId, riderId,
        idempotencyKey: U.generateIdempotencyKey(['utr_tip', transactionId]),
      });
    }

    let escrowId = null;

    if (shouldEscrow) {
      /* ── ESCROW PATH: hold seller funds ── */
      const releaseAt = new Date(Date.now() + (rule.holdDays || 2) * 86400000);
      const escrowRef = db.collection('escrows').doc();
      escrowId        = escrowRef.id;

      await db.runTransaction(async (txn) => {
        /* Credit platform commission immediately */
        U.creditWalletTxn(txn, db, 'platform_master', 'platform',
          comm.commissionCents + platformDeliv,
          { description: `Commission ${transactionId}`, orderId: transactionId, type: 'commission' });

        if (riderId && (riderEarnings + tipCts) > 0) {
          U.creditWalletTxn(txn, db, riderId, 'rider', riderEarnings + tipCts,
            { description: `Delivery ${transactionId}`, orderId: transactionId, type: 'delivery_earning' });
        }

        /* Hold seller earnings in escrow — NOT credited to wallet yet */
        txn.set(escrowRef, {
          id:            escrowId,
          transactionId,
          hubType:       hub,
          category,
          sellerId,
          buyerId:       buyerId || null,
          grossCents:    amountCents,
          commissionCents: comm.commissionCents,
          sellerNetCents:  comm.sellerNetCents,
          vatCents:        vat.taxCents,
          deliveryCents:   deliveryCents,
          riderNetCents:   riderEarnings,
          status:        ES.HELD,
          releaseAt:     admin.firestore.Timestamp.fromDate(releaseAt),
          requireBuyerConfirm: rule.requireBuyerConfirm || false,
          disputeWindowDays:   rule.disputeWindowDays || 7,
          heldAt:        _now(),
          releasedAt:    null,
          disputedAt:    null,
          resolvedAt:    null,
          paymentRef:    paymentRef || null,
          metadata:      metadata  || {},
          createdBy:     caller,
        });
      });

      await U.createLedgerEntry(db, {
        type: 'escrow_hold', amountCents: comm.sellerNetCents,
        debitAccount:  U.ACCOUNTS.PLATFORM_CLEARING,
        creditAccount: U.ACCOUNTS.PLATFORM_HOLDS,
        description:   `Escrow hold — ${hub} ${transactionId}`,
        orderId: transactionId, sellerId, category,
        metadata: { escrowId, releaseAt: releaseAt.toISOString(), holdDays: rule.holdDays },
        idempotencyKey: U.generateIdempotencyKey(['utr_escrow', transactionId]),
      });

      await db.collection('notifications').add({
        userId: sellerId, type: 'escrow', priority: 'normal',
        title: 'Payment in Escrow',
        body: `KES ${(comm.sellerNetCents / 100).toFixed(0)} is held in escrow for transaction ${transactionId}. Funds release in ${rule.holdDays} days.`,
        data: { transactionId, escrowId, releaseAt: releaseAt.toISOString() },
        read: false, createdAt: _now(),
      }).catch(() => {});

    } else {
      /* ── DIRECT CREDIT PATH: credit seller immediately ── */
      await db.runTransaction(async (txn) => {
        U.creditWalletTxn(txn, db, sellerId, 'seller', comm.sellerNetCents,
          { description: `[${hub}] Order ${transactionId}`, orderId: transactionId, type: 'order_earning' });
        if (riderId && (riderEarnings + tipCts) > 0) {
          U.creditWalletTxn(txn, db, riderId, 'rider', riderEarnings + tipCts,
            { description: `Delivery ${transactionId}`, orderId: transactionId, type: 'delivery_earning' });
        }
        U.creditWalletTxn(txn, db, 'platform_master', 'platform',
          comm.commissionCents + platformDeliv,
          { description: `Commission ${transactionId}`, orderId: transactionId, type: 'commission' });
      });

      await U.createLedgerEntry(db, {
        type: 'seller_earning', amountCents: comm.sellerNetCents,
        debitAccount:  U.ACCOUNTS.PLATFORM_CLEARING,
        creditAccount: U.ACCOUNTS.seller(sellerId),
        description:   `Seller net — ${hub} ${transactionId}`,
        orderId: transactionId, sellerId, category,
        metadata: { hubType: hub },
        idempotencyKey: U.generateIdempotencyKey(['utr_earn', transactionId]),
      });
    }

    /* ── Daily snapshot counter ── */
    const today = new Date().toISOString().slice(0, 10);
    await db.collection('finosHubCounters').doc(`${hub}_${today}`).set({
      hubType: hub, date: today,
      transactionCount: admin.firestore.FieldValue.increment(1),
      amountCents:      admin.firestore.FieldValue.increment(amountCents),
      commissionCents:  admin.firestore.FieldValue.increment(comm.commissionCents),
      sellerNetCents:   admin.firestore.FieldValue.increment(comm.sellerNetCents),
    }, { merge: true }).catch(() => {});

    await U.writeAuditLog(db, {
      action:     'transaction_recorded', entityId: transactionId, entityType: 'transaction',
      after:      { amountCents, commissionCents: comm.commissionCents, sellerNetCents: comm.sellerNetCents, escrowId, hubType: hub },
      performedBy: caller,
    });

    const result = {
      status:   shouldEscrow ? 'escrowed' : 'credited',
      transactionId, hubType: hub,
      amountCents, commissionCents: comm.commissionCents,
      sellerNetCents: comm.sellerNetCents,
      vatCents: vat.taxCents, commissionRate: comm.effectiveRate,
      escrowId,
    };
    /* Update the idempotency lock record to 'completed' so concurrent retries can return the cached result */
    await idempRef.update({ status: 'completed', result, completedAt: admin.firestore.FieldValue.serverTimestamp() });
    logger.info('[finos-router] Transaction recorded', { transactionId, hub, commissionCents: comm.commissionCents, escrow: shouldEscrow });
    return result;
  }
);

/* ─────────────────────────────────────────────────────────────
   2. finosCreateEscrow — callable
   Manually create an escrow hold (for deposits, property, etc.)
──────────────────────────────────────────────────────────────*/
exports.finosCreateEscrow = onCall(
  { region: REGION, timeoutSeconds: 30, memory: '128MiB', invoker: 'private' },
  async (request) => {
    _assertAuth(request);
    const { transactionId, amountCents, sellerId, buyerId, hubType, holdDays, reason } = request.data;
    if (!transactionId || !amountCents || !sellerId)
      throw new HttpsError('invalid-argument', 'transactionId, amountCents, sellerId required');

    const db      = _db();
    const hub     = (hubType || 'marketplace').toLowerCase();
    const rule    = await _getSettlementRule(db, hub);
    const days    = holdDays != null ? holdDays : rule.holdDays;
    const releaseAt = new Date(Date.now() + days * 86400000);

    const ikey = U.generateIdempotencyKey(['create_escrow', transactionId]);
    const cached = await U.checkIdempotency(db, ikey);
    if (cached) return { ...cached.result, duplicate: true };

    const escrowRef = db.collection('escrows').doc();
    await escrowRef.set({
      id: escrowRef.id, transactionId, hubType: hub,
      sellerId, buyerId: buyerId || null,
      grossCents: amountCents, sellerNetCents: amountCents,
      commissionCents: 0, vatCents: 0,
      status: ES.HELD, holdDays: days,
      releaseAt: admin.firestore.Timestamp.fromDate(releaseAt),
      requireBuyerConfirm: rule.requireBuyerConfirm || false,
      disputeWindowDays: rule.disputeWindowDays || 7,
      reason: reason || 'Escrow hold',
      heldAt: _now(), releasedAt: null, disputedAt: null, resolvedAt: null,
      createdBy: _uid(request),
    });

    await U.createLedgerEntry(db, {
      type: 'escrow_hold', amountCents,
      debitAccount: U.ACCOUNTS.EXTERNAL_GATEWAY, creditAccount: U.ACCOUNTS.PLATFORM_HOLDS,
      description: `Manual escrow — ${hub} txn ${transactionId}`,
      orderId: transactionId, sellerId, buyerId,
      metadata: { escrowId: escrowRef.id, holdDays: days, reason },
      idempotencyKey: ikey,
    });

    const result = { escrowId: escrowRef.id, status: ES.HELD, releaseAt: releaseAt.toISOString() };
    await U.markIdempotency(db, ikey, result);
    logger.info('[finos-router] Escrow created', { escrowId: escrowRef.id, transactionId });
    return result;
  }
);

/* ─────────────────────────────────────────────────────────────
   3. finosReleaseEscrow — callable
   Release escrow funds to seller wallet.
──────────────────────────────────────────────────────────────*/
exports.finosReleaseEscrow = onCall(
  { region: REGION, timeoutSeconds: 30, memory: '128MiB', invoker: 'private' },
  async (request) => {
    _assertAuth(request);
    const { escrowId, reason } = request.data;
    if (!escrowId) throw new HttpsError('invalid-argument', 'escrowId required');

    const db   = _db();
    const snap = await db.collection('escrows').doc(escrowId).get();
    if (!snap.exists) throw new HttpsError('not-found', 'Escrow not found');
    const e = snap.data();

    if (e.status !== ES.HELD)
      throw new HttpsError('failed-precondition', `Escrow is ${e.status}, only held escrows can be released`);

    /* Check if buyer confirmation required */
    const caller = _uid(request);
    const isAdmin = request.auth?.token?.admin || request.auth?.token?.superAdmin;
    if (e.requireBuyerConfirm && caller !== e.buyerId && !isAdmin) {
      throw new HttpsError('permission-denied', 'Buyer confirmation required to release this escrow');
    }

    const ikey = U.generateIdempotencyKey(['release_escrow', escrowId]);
    const cached = await U.checkIdempotency(db, ikey);
    if (cached) return { ...cached.result, duplicate: true };

    await db.runTransaction(async (txn) => {
      U.creditWalletTxn(txn, db, e.sellerId, 'seller', e.sellerNetCents,
        { description: `Escrow release — ${e.transactionId}`, orderId: e.transactionId, type: 'escrow_release' });
      txn.update(snap.ref, { status: ES.RELEASED, releasedAt: _now(), releaseReason: reason || 'Released', releasedBy: caller });
    });

    await U.createLedgerEntry(db, {
      type: 'escrow_release', amountCents: e.sellerNetCents,
      debitAccount:  U.ACCOUNTS.PLATFORM_HOLDS,
      creditAccount: U.ACCOUNTS.seller(e.sellerId),
      description:   `Escrow released — ${e.hubType} txn ${e.transactionId}`,
      orderId: e.transactionId, sellerId: e.sellerId,
      metadata: { escrowId, reason: reason || 'Released' },
      idempotencyKey: ikey,
    });

    await db.collection('notifications').add({
      userId: e.sellerId, type: 'payment', priority: 'high',
      title: 'Funds Released',
      body: `KES ${(e.sellerNetCents / 100).toFixed(0)} has been released to your wallet from transaction ${e.transactionId}.`,
      data: { escrowId, transactionId: e.transactionId }, read: false, createdAt: _now(),
    }).catch(() => {});

    await U.writeAuditLog(db, {
      action: 'escrow_released', entityId: escrowId, entityType: 'escrow',
      before: { status: ES.HELD }, after: { status: ES.RELEASED, releasedBy: caller },
      performedBy: caller,
    });

    const result = { status: ES.RELEASED, escrowId, sellerNetCents: e.sellerNetCents };
    await U.markIdempotency(db, ikey, result);
    logger.info('[finos-router] Escrow released', { escrowId, sellerNetCents: e.sellerNetCents });
    return result;
  }
);

/* ─────────────────────────────────────────────────────────────
   4. finosDisputeEscrow — callable (buyer or admin)
   Raise a dispute on a held escrow.
──────────────────────────────────────────────────────────────*/
exports.finosDisputeEscrow = onCall(
  { region: REGION, timeoutSeconds: 30, memory: '128MiB', invoker: 'private' },
  async (request) => {
    _assertAuth(request);
    const { escrowId, reason, evidence } = request.data;
    if (!escrowId || !reason) throw new HttpsError('invalid-argument', 'escrowId and reason required');

    const db   = _db();
    const snap = await db.collection('escrows').doc(escrowId).get();
    if (!snap.exists) throw new HttpsError('not-found', 'Escrow not found');
    const e = snap.data();
    if (e.status !== ES.HELD)
      throw new HttpsError('failed-precondition', `Cannot dispute escrow in status: ${e.status}`);

    const caller = _uid(request);
    const isAdmin = request.auth?.token?.admin || request.auth?.token?.superAdmin;
    if (!isAdmin && caller !== e.buyerId && caller !== e.sellerId)
      throw new HttpsError('permission-denied', 'Only buyer, seller, or admin can dispute');

    /* Check dispute window */
    const disputeDeadline = new Date((e.heldAt?.toMillis?.() || Date.now()) + (e.disputeWindowDays || 7) * 86400000);
    if (Date.now() > disputeDeadline.getTime() && !isAdmin)
      throw new HttpsError('deadline-exceeded', `Dispute window (${e.disputeWindowDays} days) has closed`);

    await snap.ref.update({
      status: ES.DISPUTED, disputedAt: _now(),
      disputeReason: reason, disputeEvidence: evidence || null,
      disputedBy: caller,
    });

    /* Notify admin */
    await db.collection('notifications').add({
      userId: 'platform_admin', type: 'dispute', priority: 'high',
      title: 'Escrow Dispute Filed',
      body: `Dispute filed on escrow ${escrowId} for transaction ${e.transactionId}: "${reason}"`,
      data: { escrowId, transactionId: e.transactionId, disputedBy: caller }, read: false, createdAt: _now(),
    }).catch(() => {});

    await U.writeAuditLog(db, {
      action: 'escrow_disputed', entityId: escrowId, entityType: 'escrow',
      before: { status: ES.HELD }, after: { status: ES.DISPUTED, reason },
      performedBy: caller,
    });

    logger.info('[finos-router] Escrow disputed', { escrowId, reason });
    return { status: ES.DISPUTED, escrowId };
  }
);

/* ─────────────────────────────────────────────────────────────
   5. finosResolveDispute — callable (admin only)
   Resolve a disputed escrow: release to seller, refund buyer, or split.
──────────────────────────────────────────────────────────────*/
exports.finosResolveDispute = onCall(
  { region: REGION, timeoutSeconds: 60, memory: '256MiB', invoker: 'private' },
  async (request) => {
    _assertAdmin(request);
    const { escrowId, resolution, splitSellerPct, resolutionNote } = request.data;
    /* resolution: 'release_to_seller' | 'refund_to_buyer' | 'split' */
    if (!escrowId || !resolution) throw new HttpsError('invalid-argument', 'escrowId and resolution required');
    const validResolutions = ['release_to_seller', 'refund_to_buyer', 'split'];
    if (!validResolutions.includes(resolution))
      throw new HttpsError('invalid-argument', `resolution must be one of: ${validResolutions.join(', ')}`);

    const db   = _db();
    const snap = await db.collection('escrows').doc(escrowId).get();
    if (!snap.exists) throw new HttpsError('not-found', 'Escrow not found');
    const e = snap.data();
    if (e.status !== ES.DISPUTED)
      throw new HttpsError('failed-precondition', `Escrow must be in disputed status (is: ${e.status})`);

    const caller       = _uid(request);
    const ikey         = U.generateIdempotencyKey(['resolve_dispute', escrowId, resolution]);
    const cached       = await U.checkIdempotency(db, ikey);
    if (cached) return { ...cached.result, duplicate: true };

    const sellerPct    = resolution === 'split' ? Math.max(0, Math.min(100, splitSellerPct || 50)) : (resolution === 'release_to_seller' ? 100 : 0);
    const buyerPct     = 100 - sellerPct;
    const sellerCents  = Math.round(e.sellerNetCents * sellerPct / 100);
    const buyerCents   = e.sellerNetCents - sellerCents;

    await db.runTransaction(async (txn) => {
      if (sellerCents > 0) {
        U.creditWalletTxn(txn, db, e.sellerId, 'seller', sellerCents,
          { description: `Dispute resolved — ${e.transactionId}`, orderId: e.transactionId, type: 'dispute_resolution' });
      }
      /* Buyer refund portion stays in PLATFORM_HOLDS pending M-PESA reversal */
      txn.update(snap.ref, {
        status:           resolution === 'split' ? ES.PARTIALLY_REFUNDED : (sellerPct === 100 ? ES.RELEASED : ES.REFUNDED),
        resolvedAt:       _now(),
        resolution,
        resolutionNote:   resolutionNote || null,
        splitSellerPct:   sellerPct, splitBuyerPct: buyerPct,
        splitSellerCents: sellerCents,  splitBuyerCents: buyerCents,
        resolvedBy:       caller,
      });
    });

    /* Ledger entries for resolution */
    if (sellerCents > 0) {
      await U.createLedgerEntry(db, {
        type: 'dispute_resolution_seller', amountCents: sellerCents,
        debitAccount: U.ACCOUNTS.PLATFORM_HOLDS, creditAccount: U.ACCOUNTS.seller(e.sellerId),
        description: `Dispute resolved (${sellerPct}% to seller) — ${e.transactionId}`,
        orderId: e.transactionId, sellerId: e.sellerId,
        metadata: { escrowId, resolution, sellerPct },
        idempotencyKey: U.generateIdempotencyKey(['dispute_seller', escrowId]),
      });
    }
    if (buyerCents > 0) {
      await U.createLedgerEntry(db, {
        type: 'dispute_resolution_buyer', amountCents: buyerCents,
        debitAccount: U.ACCOUNTS.PLATFORM_HOLDS, creditAccount: U.ACCOUNTS.EXTERNAL_GATEWAY,
        description: `Dispute refund (${buyerPct}% to buyer) — ${e.transactionId}`,
        orderId: e.transactionId, buyerId: e.buyerId,
        metadata: { escrowId, resolution, buyerPct },
        idempotencyKey: U.generateIdempotencyKey(['dispute_buyer', escrowId]),
      });
    }

    /* Notifications */
    const notifications = [
      { userId: e.sellerId, body: `Dispute on ${e.transactionId} resolved. KES ${(sellerCents / 100).toFixed(0)} added to your wallet.` },
      e.buyerId && { userId: e.buyerId, body: `Dispute on ${e.transactionId} resolved. KES ${(buyerCents / 100).toFixed(0)} will be refunded.` },
    ].filter(Boolean);
    for (const n of notifications) {
      await db.collection('notifications').add({
        ...n, type: 'dispute', priority: 'high', title: 'Dispute Resolved',
        data: { escrowId, transactionId: e.transactionId }, read: false, createdAt: _now(),
      }).catch(() => {});
    }

    await U.writeAuditLog(db, {
      action: 'dispute_resolved', entityId: escrowId, entityType: 'escrow',
      before: { status: ES.DISPUTED },
      after: { resolution, sellerCents, buyerCents, resolutionNote },
      performedBy: caller,
    });

    const result = { status: 'resolved', escrowId, resolution, sellerCents, buyerCents };
    await U.markIdempotency(db, ikey, result);
    logger.info('[finos-router] Dispute resolved', { escrowId, resolution, sellerCents, buyerCents });
    return result;
  }
);

/* ─────────────────────────────────────────────────────────────
   6. finosGetSettlementRules — callable
──────────────────────────────────────────────────────────────*/
exports.finosGetSettlementRules = onCall(
  { region: REGION, timeoutSeconds: 15, memory: '128MiB', invoker: 'private' },
  async (request) => {
    _assertAdmin(request);
    const db   = _db();
    const snap = await db.collection('finosSettlementRules').get().catch(() => null);
    const stored = snap ? snap.docs.map(d => ({ hubType: d.id, ...d.data() })) : [];
    const merged = Object.entries(DEFAULT_SETTLEMENT_RULES).map(([hubType, defaults]) => {
      const override = stored.find(s => s.hubType === hubType) || {};
      return { hubType, ...defaults, ...override, isOverridden: !!stored.find(s => s.hubType === hubType) };
    });
    return { rules: merged };
  }
);

/* ─────────────────────────────────────────────────────────────
   7. finosUpdateSettlementRules — callable (admin)
──────────────────────────────────────────────────────────────*/
exports.finosUpdateSettlementRules = onCall(
  { region: REGION, timeoutSeconds: 15, memory: '128MiB', invoker: 'private' },
  async (request) => {
    _assertAdmin(request);
    const { hubType, holdDays, autoRelease, requireBuyerConfirm, disputeWindowDays } = request.data;
    if (!hubType) throw new HttpsError('invalid-argument', 'hubType required');

    const db = _db();
    const update = {};
    if (holdDays           != null) update.holdDays           = Math.max(0, Math.min(90, holdDays));
    if (autoRelease        != null) update.autoRelease        = !!autoRelease;
    if (requireBuyerConfirm!= null) update.requireBuyerConfirm= !!requireBuyerConfirm;
    if (disputeWindowDays  != null) update.disputeWindowDays  = Math.max(1, Math.min(180, disputeWindowDays));
    update.updatedAt = _now(); update.updatedBy = _uid(request);

    await db.collection('finosSettlementRules').doc(hubType).set(update, { merge: true });

    await U.writeAuditLog(db, {
      action: 'settlement_rules_updated', entityId: hubType, entityType: 'settlement_rules',
      after: update, performedBy: _uid(request),
    });

    logger.info('[finos-router] Settlement rules updated', { hubType, update });
    return { status: 'updated', hubType, ...update };
  }
);

/* ─────────────────────────────────────────────────────────────
   8. finosProcessSettlements — scheduled hourly
   Auto-releases held escrows whose releaseAt timestamp has passed.
──────────────────────────────────────────────────────────────*/
exports.finosProcessSettlements = onSchedule(
  { schedule: 'every 60 minutes', region: REGION, timeoutSeconds: 540, memory: '256MiB' },
  async () => {
    const db  = _db();
    const now = admin.firestore.Timestamp.now();

    const snap = await db.collection('escrows')
      .where('status', '==', ES.HELD)
      .where('releaseAt', '<=', now)
      .get().catch(() => null);

    if (!snap || snap.empty) { logger.info('[finos-router] No escrows to settle'); return; }

    let released = 0, skipped = 0;
    for (const doc of snap.docs) {
      const e = doc.data();

      /* Skip if buyer confirmation still required */
      if (e.requireBuyerConfirm) { skipped++; continue; }

      const ikey = U.generateIdempotencyKey(['auto_settle', doc.id]);
      const cached = await U.checkIdempotency(db, ikey);
      if (cached) { skipped++; continue; }

      try {
        await db.runTransaction(async (txn) => {
          U.creditWalletTxn(txn, db, e.sellerId, 'seller', e.sellerNetCents,
            { description: `Auto-settlement — ${e.transactionId}`, orderId: e.transactionId, type: 'escrow_release' });
          txn.update(doc.ref, { status: ES.RELEASED, releasedAt: admin.firestore.FieldValue.serverTimestamp(), releaseReason: 'Auto-settlement', releasedBy: 'system' });
        });

        await U.createLedgerEntry(db, {
          type: 'escrow_release', amountCents: e.sellerNetCents,
          debitAccount:  U.ACCOUNTS.PLATFORM_HOLDS,
          creditAccount: U.ACCOUNTS.seller(e.sellerId),
          description:   `Auto-settlement — ${e.hubType} ${e.transactionId}`,
          orderId: e.transactionId, sellerId: e.sellerId,
          metadata: { escrowId: doc.id, autoSettled: true },
          idempotencyKey: ikey,
        });
        await U.markIdempotency(db, ikey, { released: true });

        await db.collection('notifications').add({
          userId: e.sellerId, type: 'payment', priority: 'normal',
          title: 'Funds Released',
          body: `KES ${(e.sellerNetCents / 100).toFixed(0)} has been released from escrow for transaction ${e.transactionId}.`,
          data: { escrowId: doc.id }, read: false, createdAt: admin.firestore.FieldValue.serverTimestamp(),
        }).catch(() => {});

        released++;
      } catch (err) {
        logger.error('[finos-router] Auto-settlement failed', { escrowId: doc.id, error: err.message });
      }
    }
    logger.info('[finos-router] Settlement batch done', { released, skipped, total: snap.size });
  }
);

/* ─────────────────────────────────────────────────────────────
   9. finosGetRevenueAnalytics — callable (admin)
   Hub/category/seller breakdown + 30-day trend + 7-day forecast.
──────────────────────────────────────────────────────────────*/
exports.finosGetRevenueAnalytics = onCall(
  { region: REGION, timeoutSeconds: 60, memory: '512MiB', invoker: 'private' },
  async (request) => {
    _assertAdmin(request);
    const { days: rangeDays = 30 } = request.data;
    const db = _db();

    /* Load hub counters for last N days */
    const cutoff = new Date(Date.now() - rangeDays * 86400000).toISOString().slice(0, 10);
    const counterSnap = await db.collection('finosHubCounters').get().catch(() => null);
    const counters = counterSnap
      ? counterSnap.docs.map(d => d.data()).filter(c => (c.date || '') >= cutoff)
      : [];

    /* Load daily snapshots */
    const snapSnap = await db.collection('finosSnapshots').where('dateStr', '>=', cutoff).get().catch(() => null);
    const snapshots = snapSnap ? snapSnap.docs.map(d => d.data()) : [];

    /* By hub */
    const byHub = {};
    counters.forEach(c => {
      if (!byHub[c.hubType]) byHub[c.hubType] = { transactionCount: 0, amountCents: 0, commissionCents: 0 };
      byHub[c.hubType].transactionCount += c.transactionCount || 0;
      byHub[c.hubType].amountCents      += c.amountCents      || 0;
      byHub[c.hubType].commissionCents  += c.commissionCents  || 0;
    });

    /* Daily trend */
    const dailyTrend = snapshots
      .sort((a, b) => (a.dateStr || '').localeCompare(b.dateStr || ''))
      .map(s => ({
        date:            s.dateStr,
        revenueCents:    s.totalRevenueCents    || 0,
        commissionCents: s.commissionCents      || 0,
        refundsCents:    s.refundsCents         || 0,
        transactionCount:s.transactionCount     || 0,
      }));

    /* 7-day forecast via linear regression on last 14 days */
    const last14 = dailyTrend.slice(-14);
    let forecastDailyCents = 0;
    if (last14.length >= 7) {
      const n   = last14.length;
      const xs  = last14.map((_, i) => i);
      const ys  = last14.map(d => d.commissionCents);
      const sumX = xs.reduce((a, b) => a + b, 0);
      const sumY = ys.reduce((a, b) => a + b, 0);
      const sumXY = xs.reduce((s, x, i) => s + x * ys[i], 0);
      const sumX2 = xs.reduce((s, x) => s + x * x, 0);
      const slope = (n * sumXY - sumX * sumY) / Math.max(n * sumX2 - sumX * sumX, 1);
      const intercept = (sumY - slope * sumX) / n;
      forecastDailyCents = Math.max(0, Math.round(intercept + slope * n));
    } else if (last14.length > 0) {
      forecastDailyCents = Math.round(last14.reduce((s, d) => s + d.commissionCents, 0) / last14.length);
    }

    /* Summary */
    const totals = {
      revenueCents:     snapshots.reduce((s, sn) => s + (sn.totalRevenueCents   || 0), 0),
      commissionCents:  snapshots.reduce((s, sn) => s + (sn.commissionCents     || 0), 0),
      refundsCents:     snapshots.reduce((s, sn) => s + (sn.refundsCents        || 0), 0),
      payoutsCents:     snapshots.reduce((s, sn) => s + (sn.payoutsCents        || 0), 0),
      subRevCents:      snapshots.reduce((s, sn) => s + (sn.subscriptionRevCents|| 0), 0),
      adRevCents:       snapshots.reduce((s, sn) => s + (sn.adRevenueCents      || 0), 0),
      vatCents:         snapshots.reduce((s, sn) => s + (sn.vatCollectedCents   || 0), 0),
      txCount:          snapshots.reduce((s, sn) => s + (sn.transactionCount    || 0), 0),
    };

    /* Open escrows */
    const escrowSnap = await db.collection('escrows').where('status', '==', ES.HELD).get().catch(() => null);
    const escrowTotal = escrowSnap ? escrowSnap.docs.reduce((s, d) => s + (d.data().sellerNetCents || 0), 0) : 0;
    const disputeSnap = await db.collection('escrows').where('status', '==', ES.DISPUTED).get().catch(() => null);

    /* Pending payouts */
    const payoutSnap = await db.collection('payouts').where('status', '==', 'pending').get().catch(() => null);
    const pendingPayoutCents = payoutSnap ? payoutSnap.docs.reduce((s, d) => s + (d.data().grossCents || 0), 0) : 0;

    logger.info('[finos-router] Revenue analytics generated', { rangeDays, snapshots: snapshots.length });
    return {
      rangeDays, totals, byHub, dailyTrend,
      forecast: {
        dailyRevenueCents: forecastDailyCents,
        weeklyRevenueCents: forecastDailyCents * 7,
        monthlyRevenueCents: forecastDailyCents * 30,
        confidence: last14.length >= 14 ? 'medium' : 'low',
      },
      liveMetrics: {
        escrowHeldCents:    escrowTotal,
        escrowHeldCount:    escrowSnap?.size || 0,
        activeDisputeCount: disputeSnap?.size || 0,
        pendingPayoutCents,
        pendingPayoutCount: payoutSnap?.size || 0,
      },
    };
  }
);

/* ─────────────────────────────────────────────────────────────
   10. finosRequestBankPayout — callable
   Initiates a bank transfer withdrawal (queued for manual processing).
──────────────────────────────────────────────────────────────*/
exports.finosRequestBankPayout = onCall(
  { region: REGION, timeoutSeconds: 30, memory: '128MiB', invoker: 'private' },
  async (request) => {
    _assertAuth(request);
    /* RETIRED — earnings converge into wallets.balance (sweepEarningsToWallet); this
       reads availableBalance and would double-pay. Use the wallet withdrawal only. */
    throw new HttpsError('failed-precondition',
      'Withdrawals now go through your SOKONI Wallet (Wallet → Withdraw). This method is retired.');
    /* eslint-disable no-unreachable */
    const uid = _uid(request);
    const { amountCents, bankName, accountNumber, accountName, entityType } = request.data;

    if (!amountCents || !bankName || !accountNumber || !accountName)
      throw new HttpsError('invalid-argument', 'amountCents, bankName, accountNumber, accountName required');
    if (!Number.isInteger(amountCents) || amountCents < 100_00) /* min KES 1000 */
      throw new HttpsError('invalid-argument', 'Minimum bank payout is KES 1,000');

    const db     = _db();
    await U.getOrInitWallet(db, uid, entityType || 'seller');
    await U.checkFinancialFraud(db, { entityId: uid, entityType: entityType || 'seller', eventType: 'payout', amountCents });

    const wht        = U.calculateWHT(amountCents);
    const netCents   = wht.netCents;
    const ikey       = U.generateIdempotencyKey(['bank_payout', uid, String(amountCents), String(Date.now())]);
    const payoutRef  = db.collection('payouts').doc();
    const walletRef  = db.collection('wallets').doc(uid);

    await db.runTransaction(async (txn) => {
      // Re-read wallet INSIDE the transaction so Firestore detects concurrent
      // payout requests that would overdraft the same balance
      const walletSnap = await txn.get(walletRef);
      const available  = walletSnap.exists ? ((walletSnap.data().availableBalance || walletSnap.data().balance) ?? 0) : 0;
      if (available < amountCents)
        throw new HttpsError('failed-precondition', `Insufficient balance. Available: KES ${(available / 100).toFixed(0)}`);

      U.holdWalletTxn(txn, db, uid, amountCents, { description: `Bank payout hold ${payoutRef.id}` });
      txn.set(payoutRef, {
        id: payoutRef.id, entityId: uid, entityType: entityType || 'seller',
        grossCents: amountCents, whtCents: wht.whtCents, netCents,
        currency: 'KES', method: 'bank_transfer',
        bankName, accountNumber, accountName,
        status: 'pending_review', /* Bank payouts require admin review */
        attempts: 0, idempotencyKey: ikey,
        notes: 'Bank transfer — requires admin manual processing',
        createdAt: _now(), createdAtMs: Date.now(), retryAt: null,
      });
    });

    await U.createLedgerEntry(db, {
      type: 'payout_initiated', amountCents,
      debitAccount: U.ACCOUNTS.seller(uid), creditAccount: U.ACCOUNTS.PLATFORM_HOLDS,
      description: `Bank payout initiated — ${bankName} ${accountNumber.slice(-4)}`,
      metadata: { payoutId: payoutRef.id, method: 'bank_transfer', whtCents: wht.whtCents },
      idempotencyKey: ikey,
    });

    await U.writeAuditLog(db, {
      action: 'bank_payout_requested', entityId: uid, entityType: entityType || 'seller',
      after: { amountCents, netCents, bankName, payoutId: payoutRef.id }, performedBy: uid,
    });

    logger.info('[finos-router] Bank payout requested', { payoutId: payoutRef.id, uid, amountCents });
    return { status: 'pending_review', payoutId: payoutRef.id, grossCents: amountCents, whtCents: wht.whtCents, netCents };
  }
);

/* ─────────────────────────────────────────────────────────────
   11. finosGetAdminDashboard — callable (admin)
   Single call that returns all live metrics for the admin console.
──────────────────────────────────────────────────────────────*/
exports.finosGetAdminDashboard = onCall(
  { region: REGION, timeoutSeconds: 60, memory: '512MiB', invoker: 'private' },
  async (request) => {
    _assertAdmin(request);
    const db = _db();

    const today     = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const last7days = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);

    const [
      todaySnap, yesterdaySnap, weekSnaps,
      pendingPayoutsSnap, bankPayoutsSnap,
      heldEscrowsSnap, disputedEscrowsSnap,
      fraudSnap, platformWallet,
    ] = await Promise.all([
      db.collection('finosSnapshots').doc(`snapshot_${today.replace(/-/g, '')}`).get().catch(() => null),
      db.collection('finosSnapshots').doc(`snapshot_${yesterday.replace(/-/g, '')}`).get().catch(() => null),
      db.collection('finosSnapshots').where('dateStr', '>=', last7days).get().catch(() => null),
      db.collection('payouts').where('status', '==', 'pending').get().catch(() => null),
      db.collection('payouts').where('status', '==', 'pending_review').get().catch(() => null),
      db.collection('escrows').where('status', '==', ES.HELD).get().catch(() => null),
      db.collection('escrows').where('status', '==', ES.DISPUTED).get().catch(() => null),
      db.collection('fraudAlerts').where('status', '==', 'open').get().catch(() => null),
      U.getOrInitWallet(db, 'platform_master', 'platform'),
    ]);

    const todayData  = todaySnap?.exists ? todaySnap.data() : {};
    const yDay       = yesterdaySnap?.exists ? yesterdaySnap.data() : {};
    const weekData   = weekSnaps ? weekSnaps.docs.map(d => d.data()) : [];
    const weekRev    = weekData.reduce((s, d) => s + (d.commissionCents || 0), 0);
    const weekTx     = weekData.reduce((s, d) => s + (d.transactionCount || 0), 0);

    return {
      today: {
        revenueCents:    todayData.totalRevenueCents   || 0,
        commissionCents: todayData.commissionCents     || 0,
        transactionCount:todayData.transactionCount    || 0,
        refundsCents:    todayData.refundsCents        || 0,
        subRevCents:     todayData.subscriptionRevCents|| 0,
      },
      yesterday: {
        revenueCents:    yDay.totalRevenueCents   || 0,
        commissionCents: yDay.commissionCents     || 0,
        transactionCount:yDay.transactionCount    || 0,
      },
      week: { commissionCents: weekRev, transactionCount: weekTx },
      platform: {
        availableBalanceCents: platformWallet.availableBalance || 0,
        heldBalanceCents:      platformWallet.heldBalance      || 0,
        lifetimeRevenueCents:  platformWallet.lifetimeEarnings || 0,
      },
      live: {
        pendingPayoutCount:     pendingPayoutsSnap?.size || 0,
        pendingPayoutCents:     pendingPayoutsSnap?.docs.reduce((s, d) => s + (d.data().grossCents || 0), 0) || 0,
        bankPayoutPendingCount: bankPayoutsSnap?.size || 0,
        escrowHeldCount:        heldEscrowsSnap?.size  || 0,
        escrowHeldCents:        heldEscrowsSnap?.docs.reduce((s, d) => s + (d.data().sellerNetCents || 0), 0) || 0,
        activeDisputeCount:     disputedEscrowsSnap?.size || 0,
        openFraudAlerts:        fraudSnap?.size        || 0,
      },
    };
  }
);

/* ─────────────────────────────────────────────────────────────
   12. finosGenerateReceipt — callable
   Generates a receipt record for any transaction type.
──────────────────────────────────────────────────────────────*/
exports.finosGenerateReceipt = onCall(
  { region: REGION, timeoutSeconds: 30, memory: '128MiB', invoker: 'private' },
  async (request) => {
    _assertAuth(request);
    const {
      transactionId, hubType, amountCents, commissionCents,
      sellerNetCents, buyerName, sellerName, description,
      items, paymentMethod,
    } = request.data;
    if (!transactionId || !amountCents) throw new HttpsError('invalid-argument', 'transactionId and amountCents required');

    const db   = _db();
    const uid  = _uid(request);
    const ikey = U.generateIdempotencyKey(['receipt', transactionId]);
    const cached = await U.checkIdempotency(db, ikey);
    if (cached) return { ...cached.result, duplicate: true };

    const receiptRef = db.collection('receipts').doc();
    const receiptNo  = `SK${Date.now().toString(36).toUpperCase()}`;
    const receiptData = {
      id:              receiptRef.id,
      receiptNumber:   receiptNo,
      transactionId,
      hubType:         hubType || 'marketplace',
      amountCents:     amountCents,
      commissionCents: commissionCents || 0,
      sellerNetCents:  sellerNetCents  || 0,
      vatCents:        commissionCents ? Math.round(commissionCents * 0.16) : 0,
      currency:        'KES',
      buyerUid:        uid,
      buyerName:       buyerName    || 'Customer',
      sellerName:      sellerName   || 'SOKONI Seller',
      description:     description  || `${hubType || 'SOKONI'} transaction`,
      items:           items        || [],
      paymentMethod:   paymentMethod|| 'M-PESA',
      platform:        'SOKONI',
      platformAddress: 'Nairobi, Kenya | sokoni.co.ke',
      generatedAt:     _now(),
      generatedBy:     uid,
    };

    await receiptRef.set(receiptData);

    /* Queue email notification */
    await db.collection('emailQueue').add({
      to:        uid,
      template:  'receipt',
      data:      { receiptNumber: receiptNo, amountKES: (amountCents / 100).toFixed(0), transactionId, hubType },
      createdAt: _now(), status: 'pending',
    }).catch(() => {});

    const result = { receiptId: receiptRef.id, receiptNumber: receiptNo };
    await U.markIdempotency(db, ikey, result);
    logger.info('[finos-router] Receipt generated', { receiptId: receiptRef.id, transactionId });
    return result;
  }
);
