/* ================================================================
   SOKONI Commission Engine — Rule Management CFs  v2.0
   7 Cloud Functions:
     createCommissionRule     — admin: create any rule type
     updateCommissionRule     — admin: edit existing rule
     deleteCommissionRule     — admin: soft-delete (sets isActive=false)
     listCommissionRules      — admin: paginated list with filters
     previewCommission        — admin + seller: live calculation preview
     getSellerEarningsReport  — seller: earnings breakdown from ledger
     getAdminRevenueByHub     — admin: hub-level revenue breakdown
================================================================ */
'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const logger                 = require('firebase-functions/logger');
const admin                  = require('firebase-admin');

const REGION = 'us-central1';
const OPT    = { region: REGION, enforceAppCheck: true, timeoutSeconds: 30, memory: '256MiB' };
const OPT60  = { region: REGION, enforceAppCheck: true, timeoutSeconds: 60, memory: '256MiB' };

function _db()  { return admin.firestore(); }
function _now() { return admin.firestore.FieldValue.serverTimestamp(); }

function _assertAdmin(req) {
  if (!req.auth?.token?.admin && !req.auth?.token?.superAdmin)
    throw new HttpsError('permission-denied', 'Admin access required');
}

/* Valid rule types */
const RULE_TYPES = new Set(['percentage', 'fixed', 'percentage_plus_fixed', 'tiered', 'commission_holiday']);

/* Valid hub categories */
const CATEGORIES = new Set([
  'marketplace', 'services', 'food_delivery', 'bookings', 'events',
  'digital_products', 'property', 'vehicles', 'jobs', 'classifieds',
  'healthcare', 'education', 'legal', 'insurance', 'logistics',
  'financial_services', 'pharmacy', 'freelancers', 'hotels', 'hub',
  'subscriptions', 'advertising', 'all',
]);

function _validateRule(data) {
  const { type, category, rate, amountCents, tiers, minCommissionCents, maxCommissionCents,
          activeFrom, activeTo, entityId, entityType, description, isActive } = data;

  if (!type || !RULE_TYPES.has(type))
    throw new HttpsError('invalid-argument', `type must be one of: ${[...RULE_TYPES].join(', ')}`);

  if (!category || !CATEGORIES.has(category))
    throw new HttpsError('invalid-argument', `category must be one of: ${[...CATEGORIES].join(', ')}`);

  if (type === 'percentage' || type === 'percentage_plus_fixed') {
    if (typeof rate !== 'number' || rate < 0 || rate > 100)
      throw new HttpsError('invalid-argument', 'rate must be 0–100 for percentage rules');
  }
  if (type === 'fixed' || type === 'percentage_plus_fixed') {
    if (typeof amountCents !== 'number' || !Number.isInteger(amountCents) || amountCents < 0)
      throw new HttpsError('invalid-argument', 'amountCents must be a non-negative integer');
  }
  if (type === 'tiered') {
    if (!Array.isArray(tiers) || tiers.length === 0)
      throw new HttpsError('invalid-argument', 'tiered rules require at least one tier');
    for (const t of tiers) {
      if (typeof t.rate !== 'number' || t.rate < 0 || t.rate > 100)
        throw new HttpsError('invalid-argument', 'each tier.rate must be 0–100');
    }
  }
  if (type === 'commission_holiday') {
    if (!activeFrom || !activeTo)
      throw new HttpsError('invalid-argument', 'commission_holiday requires activeFrom and activeTo');
  }
  if (entityId && !entityType)
    throw new HttpsError('invalid-argument', 'entityType required when entityId is set (seller|hub|buyer)');
  if (minCommissionCents != null && (!Number.isInteger(minCommissionCents) || minCommissionCents < 0))
    throw new HttpsError('invalid-argument', 'minCommissionCents must be a non-negative integer');
  if (maxCommissionCents != null && (!Number.isInteger(maxCommissionCents) || maxCommissionCents < 0))
    throw new HttpsError('invalid-argument', 'maxCommissionCents must be a non-negative integer');
  if (minCommissionCents != null && maxCommissionCents != null && minCommissionCents > maxCommissionCents)
    throw new HttpsError('invalid-argument', 'minCommissionCents must be <= maxCommissionCents');
}

function _buildRuleDoc(data, adminUid) {
  const {
    type, category, rate, amountCents, tiers,
    minCommissionCents, maxCommissionCents,
    activeFrom, activeTo,
    entityId, entityType,
    description, priority, isActive,
  } = data;

  const doc = {
    type,
    category,
    isActive:             isActive !== false,
    description:          description || '',
    priority:             typeof priority === 'number' ? priority : 0,
    entityId:             entityId  || null,
    entityType:           entityType || null,
    minCommissionCents:   minCommissionCents ?? null,
    maxCommissionCents:   maxCommissionCents ?? null,
    activeFrom:           activeFrom ? new Date(activeFrom) : null,
    activeTo:             activeTo   ? new Date(activeTo)   : null,
    createdBy:            adminUid,
    updatedBy:            adminUid,
    updatedAt:            _now(),
  };

  if (type === 'percentage')              { doc.rate = rate; }
  if (type === 'fixed')                   { doc.amountCents = amountCents; }
  if (type === 'percentage_plus_fixed')   { doc.rate = rate; doc.amountCents = amountCents; }
  if (type === 'tiered')                  { doc.tiers = tiers; }
  if (type === 'commission_holiday')      { doc.rate = 0; doc.amountCents = 0; }

  return doc;
}

/* ─────────────────────────────────────────────────────────────
   1. createCommissionRule
──────────────────────────────────────────────────────────────*/
exports.createCommissionRule = onCall(
  OPT,
  async (req) => {
    _assertAdmin(req);
    _validateRule(req.data);

    const db   = _db();
    const doc  = _buildRuleDoc(req.data, req.auth.uid);
    doc.createdAt = _now();

    const ref  = await db.collection('commissionRules').add(doc);

    await db.collection('finosAuditLog').add({
      action:    'commission_rule_created',
      ruleId:    ref.id,
      rule:      doc,
      adminUid:  req.auth.uid,
      createdAt: _now(),
    });

    logger.info('[commission] Rule created', { ruleId: ref.id, type: doc.type, category: doc.category });
    return { ruleId: ref.id, status: 'created' };
  }
);

/* ─────────────────────────────────────────────────────────────
   2. updateCommissionRule
──────────────────────────────────────────────────────────────*/
exports.updateCommissionRule = onCall(
  OPT,
  async (req) => {
    _assertAdmin(req);
    const { ruleId, ...rest } = req.data;
    if (!ruleId) throw new HttpsError('invalid-argument', 'ruleId required');

    _validateRule(rest);

    const db      = _db();
    const ref     = db.collection('commissionRules').doc(ruleId);
    const snap    = await ref.get();
    if (!snap.exists) throw new HttpsError('not-found', 'Commission rule not found');

    const before  = snap.data();
    const updates = _buildRuleDoc(rest, req.auth.uid);
    delete updates.createdBy;   /* preserve original creator */
    delete updates.createdAt;

    await ref.update(updates);

    await db.collection('finosAuditLog').add({
      action:    'commission_rule_updated',
      ruleId,
      before,
      after:     updates,
      adminUid:  req.auth.uid,
      createdAt: _now(),
    });

    logger.info('[commission] Rule updated', { ruleId });
    return { ruleId, status: 'updated' };
  }
);

/* ─────────────────────────────────────────────────────────────
   3. deleteCommissionRule  (soft delete)
──────────────────────────────────────────────────────────────*/
exports.deleteCommissionRule = onCall(
  OPT,
  async (req) => {
    _assertAdmin(req);
    const { ruleId } = req.data;
    if (!ruleId) throw new HttpsError('invalid-argument', 'ruleId required');

    const db   = _db();
    const ref  = db.collection('commissionRules').doc(ruleId);
    const snap = await ref.get();
    if (!snap.exists) throw new HttpsError('not-found', 'Rule not found');

    await ref.update({ isActive: false, deletedAt: _now(), deletedBy: req.auth.uid, updatedAt: _now() });

    await db.collection('finosAuditLog').add({
      action:   'commission_rule_deleted',
      ruleId,
      adminUid: req.auth.uid,
      createdAt: _now(),
    });

    logger.info('[commission] Rule deactivated', { ruleId });
    return { ruleId, status: 'deleted' };
  }
);

/* ─────────────────────────────────────────────────────────────
   4. listCommissionRules
──────────────────────────────────────────────────────────────*/
exports.listCommissionRules = onCall(
  OPT,
  async (req) => {
    _assertAdmin(req);
    const { includeInactive, category, type, entityId } = req.data || {};

    const db = _db();
    let q    = db.collection('commissionRules');

    if (!includeInactive) q = q.where('isActive', '==', true);
    if (category)         q = q.where('category', '==', category);
    if (type)             q = q.where('type',     '==', type);
    if (entityId)         q = q.where('entityId', '==', entityId);

    const snap  = await q.orderBy('priority', 'desc').limit(200).get();
    const rules = snap.docs.map(d => ({
      id: d.id,
      ...d.data(),
      createdAt: d.data().createdAt?.toMillis?.() || null,
      updatedAt: d.data().updatedAt?.toMillis?.() || null,
      activeFrom: d.data().activeFrom?.toMillis?.() || null,
      activeTo:   d.data().activeTo?.toMillis?.()   || null,
    }));

    return { rules, total: rules.length };
  }
);

/* ─────────────────────────────────────────────────────────────
   5. previewCommission — live calc for admin + sellers
──────────────────────────────────────────────────────────────*/
exports.previewCommission = onCall(
  OPT,
  async (req) => {
    if (!req.auth) throw new HttpsError('unauthenticated', 'Login required');

    const { orderAmountKES, category, sellerId } = req.data;
    if (!orderAmountKES || !category)
      throw new HttpsError('invalid-argument', 'orderAmountKES and category required');
    if (typeof orderAmountKES !== 'number' || orderAmountKES <= 0)
      throw new HttpsError('invalid-argument', 'orderAmountKES must be a positive number');

    const U = require('./finos-utils');
    const db = _db();
    const orderAmountCents = Math.round(orderAmountKES * 100);

    const comm = await U.calculateCommission(db, {
      orderAmountCents,
      category,
      sellerId: sellerId || null,
    });

    const vat  = U.calculateVAT(comm.commissionCents, category);
    const wht  = U.calculateWHT(comm.sellerNetCents);

    return {
      orderAmountKES,
      category,
      effectiveRate:       comm.effectiveRate,
      commissionKES:       comm.commissionCents   / 100,
      sellerNetKES:        comm.sellerNetCents     / 100,
      vatKES:              vat.taxCents            / 100,
      vatRate:             vat.taxRate,
      vatExempt:           !!vat.isExempt,
      whtKES:              wht.whtCents            / 100,
      whtRate:             wht.whtRate,
      ruleId:              comm.ruleId,
      ruleSource:          comm.ruleSource,
      sellerReceivesKES:   (comm.sellerNetCents - wht.whtCents) / 100,
    };
  }
);

/* ─────────────────────────────────────────────────────────────
   6. getSellerEarningsReport
   Returns structured earnings breakdown from the double-entry
   ledger for the calling seller. No admin access to other sellers.
──────────────────────────────────────────────────────────────*/
exports.getSellerEarningsReport = onCall(
  OPT,
  async (req) => {
    if (!req.auth) throw new HttpsError('unauthenticated', 'Login required');
    const uid = req.auth.uid;

    const {
      periodStart,  /* ISO date string, e.g. "2026-01-01" */
      periodEnd,    /* ISO date string, e.g. "2026-01-31" */
      category,     /* optional filter */
      pageSize = 50,
      cursor,       /* lastCreatedAtMs from previous page */
    } = req.data || {};

    const db   = _db();
    const now  = Date.now();
    const startMs = periodStart ? new Date(periodStart).getTime() : now - 30 * 86400000;
    const endMs   = periodEnd   ? new Date(periodEnd).getTime()   : now;

    if (isNaN(startMs) || isNaN(endMs)) throw new HttpsError('invalid-argument', 'Invalid periodStart or periodEnd');
    if (endMs - startMs > 366 * 86400000) throw new HttpsError('invalid-argument', 'Date range must be <= 366 days');

    /* Query ledger entries where sellerId === uid and type is an earning entry */
    const EARNING_TYPES = ['seller_earning', 'seller_credit', 'payment_received'];
    const DEDUCTION_TYPES = ['commission', 'platform_fee', 'refund_clawback', 'wht', 'wht_deduction'];

    const startTs = admin.firestore.Timestamp.fromMillis(startMs);
    const endTs   = admin.firestore.Timestamp.fromMillis(endMs);

    let earningsQ = db.collection('ledger')
      .where('sellerId', '==', uid)
      .where('createdAt', '>=', startTs)
      .where('createdAt', '<=', endTs)
      .orderBy('createdAt', 'desc')
      .limit(pageSize + 1);

    if (category) earningsQ = earningsQ.where('category', '==', category);
    if (cursor)   earningsQ = earningsQ.startAfter(admin.firestore.Timestamp.fromMillis(cursor));

    const snap = await earningsQ.get();
    const hasMore = snap.size > pageSize;
    const docs = snap.docs.slice(0, pageSize);

    /* Also fetch wallet summary in parallel */
    const walletSnap = await db.collection('wallets').doc(uid).get();
    const wallet = walletSnap.exists ? walletSnap.data() : {};

    /* Aggregate totals from this page + period */
    let grossCents = 0, commissionCents = 0, refundCents = 0;
    const entries = docs.map(d => {
      const e = d.data();
      const amtKES = e.amountCents / 100;
      const isEarning   = EARNING_TYPES.includes(e.type)   || e.creditAccount?.startsWith('seller:');
      const isDeduction = DEDUCTION_TYPES.includes(e.type) || (e.debitAccount?.startsWith('seller:') && e.type !== 'reversal');
      if (isEarning && e.type !== 'reversal')   grossCents      += e.amountCents || 0;
      if (e.type === 'commission' || e.type === 'platform_fee') commissionCents += e.amountCents || 0;
      if (e.type === 'refund_clawback')          refundCents     += e.amountCents || 0;
      return {
        id:          d.id,
        type:        e.type,
        amountKES:   amtKES,
        direction:   isEarning ? 'credit' : 'debit',
        description: e.description || '',
        orderId:     e.orderId  || null,
        category:    e.category || null,
        createdAt:   e.createdAt?.toMillis?.() || null,
        status:      e.status || 'settled',
      };
    });

    const netCents = grossCents - commissionCents - refundCents;

    return {
      period:           { startMs, endMs },
      summary: {
        grossKES:         grossCents      / 100,
        commissionKES:    commissionCents / 100,
        refundsKES:       refundCents     / 100,
        netKES:           netCents        / 100,
      },
      wallet: {
        availableKES:     (wallet.availableBalance    || 0) / 100,
        pendingKES:       (wallet.pendingBalance      || 0) / 100,
        heldKES:          (wallet.heldBalance         || 0) / 100,
        withdrawableKES:  (wallet.withdrawableBalance || 0) / 100,
        lifetimeEarningsKES: (wallet.lifetimeEarnings || 0) / 100,
        lifetimeWithdrawalsKES: (wallet.lifetimeWithdrawals || 0) / 100,
        lifetimeRefundsKES: (wallet.lifetimeRefunds   || 0) / 100,
      },
      entries,
      hasMore,
      nextCursor: hasMore ? docs[docs.length - 1].data().createdAt?.toMillis?.() || null : null,
    };
  }
);

/* ─────────────────────────────────────────────────────────────
   7. getAdminRevenueByHub
   Admin: real-time hub-level revenue breakdown aggregated from
   the finosHubCounters collection + finosSnapshots for trend data.
──────────────────────────────────────────────────────────────*/
exports.getAdminRevenueByHub = onCall(
  OPT,
  async (req) => {
    if (!req.auth?.token?.admin && !req.auth?.token?.superAdmin)
      throw new HttpsError('permission-denied', 'Admin access required');

    const { periodDays = 30 } = req.data || {};
    if (![7, 14, 30, 90, 365].includes(periodDays))
      throw new HttpsError('invalid-argument', 'periodDays must be 7, 14, 30, 90, or 365');

    const db  = _db();
    const now = Date.now();

    /* Pull hub counters (running totals) */
    const countersSnap = await db.collection('finosHubCounters').get().catch(() => null);
    const hubData = {};
    if (countersSnap) {
      countersSnap.docs.forEach(d => {
        hubData[d.id] = d.data();
      });
    }

    /* Pull daily snapshots for the period to compute period-specific revenue */
    const periodStartMs = now - periodDays * 86400000;
    const snapSnap = await db.collection('finosSnapshots')
      .where('dateMs', '>=', periodStartMs)
      .orderBy('dateMs', 'asc')
      .limit(370)
      .get().catch(() => null);

    const snapshots = snapSnap ? snapSnap.docs.map(d => d.data()) : [];

    /* Aggregate period revenue by hub from snapshots */
    const periodByHub = {};
    snapshots.forEach(snap => {
      const byHub = snap.byHub || {};
      Object.keys(byHub).forEach(hub => {
        if (!periodByHub[hub]) periodByHub[hub] = { revenueCents: 0, transactionCount: 0, commissionCents: 0 };
        periodByHub[hub].revenueCents      += byHub[hub].revenueCents      || 0;
        periodByHub[hub].transactionCount  += byHub[hub].transactionCount  || 0;
        periodByHub[hub].commissionCents   += byHub[hub].commissionCents   || 0;
      });
    });

    /* Merge lifetime totals with period data */
    const allHubs = new Set([...Object.keys(hubData), ...Object.keys(periodByHub)]);
    const hubs = [...allHubs].map(hub => {
      const lifetime = hubData[hub] || {};
      const period   = periodByHub[hub] || {};
      return {
        hub,
        lifetime: {
          revenueKES:       (lifetime.totalRevenueCents || 0)     / 100,
          transactionCount: lifetime.totalTransactions  || 0,
          commissionKES:    (lifetime.totalCommissionCents || 0)  / 100,
        },
        period: {
          revenueKES:       (period.revenueCents    || 0) / 100,
          transactionCount: period.transactionCount  || 0,
          commissionKES:    (period.commissionCents  || 0) / 100,
        },
      };
    }).sort((a, b) => b.period.revenueKES - a.period.revenueKES);

    /* Platform totals */
    const totals = hubs.reduce((acc, h) => {
      acc.periodRevenueKES      += h.period.revenueKES;
      acc.periodTransactions    += h.period.transactionCount;
      acc.periodCommissionKES   += h.period.commissionKES;
      acc.lifetimeRevenueKES    += h.lifetime.revenueKES;
      acc.lifetimeTransactions  += h.lifetime.transactionCount;
      return acc;
    }, { periodRevenueKES: 0, periodTransactions: 0, periodCommissionKES: 0, lifetimeRevenueKES: 0, lifetimeTransactions: 0 });

    /* Daily trend for the period */
    const dailyTrend = snapshots.map(s => ({
      date:        s.dateStr || null,
      dateMs:      s.dateMs  || null,
      revenueKES:  (s.totalRevenueCents || 0) / 100,
      payoutsKES:  (s.totalPayoutsCents || 0) / 100,
      refundsKES:  (s.totalRefundsCents || 0) / 100,
      transactions: s.transactionCount || 0,
    }));

    logger.info('[commission] getAdminRevenueByHub', { periodDays, hubCount: hubs.length });
    return { periodDays, generatedAt: now, totals, hubs, dailyTrend };
  }
);

/* ─────────────────────────────────────────────────────────────
   8. processSettlement
   Admin-only. Releases escrow, credits seller wallet, writes
   double-entry ledger entry. Idempotent on orderId.
──────────────────────────────────────────────────────────────*/
exports.processSettlement = onCall(
  OPT60,
  async (req) => {
    _assertAdmin(req);
    const uid = req.auth.uid;
    const { orderId, sellerNetCents, commissionCents, category, sellerId, description } = req.data;

    if (!orderId)  throw new HttpsError('invalid-argument', 'orderId required');
    if (!sellerId) throw new HttpsError('invalid-argument', 'sellerId required');
    if (typeof sellerNetCents !== 'number' || !Number.isInteger(sellerNetCents) || sellerNetCents < 0)
      throw new HttpsError('invalid-argument', 'sellerNetCents must be a non-negative integer');
    if (typeof commissionCents !== 'number' || !Number.isInteger(commissionCents) || commissionCents < 0)
      throw new HttpsError('invalid-argument', 'commissionCents must be a non-negative integer');

    const db            = _db();
    const FieldValue    = admin.firestore.FieldValue;
    const settlementRef = db.collection('settlements').doc(orderId);

    await db.runTransaction(async (txn) => {
      /* Idempotency guard inside transaction — prevents double-settlement under concurrency */
      const existingSnap = await txn.get(settlementRef);
      if (existingSnap.exists) {
        logger.warn('[commission] processSettlement — duplicate blocked', { orderId });
        throw new HttpsError('already-exists', 'Settlement already processed');
      }

      const walletRef  = db.collection('wallets').doc(sellerId);
      const walletSnap = await txn.get(walletRef);

      /* Write settlement record */
      txn.set(settlementRef, {
        orderId,
        sellerId,
        sellerNetCents,
        commissionCents,
        category:    category    || null,
        status:      'settled',
        settledAt:   _now(),
        settledBy:   uid,
        description: description || '',
      });

      /* Create or update seller wallet */
      if (!walletSnap.exists) {
        txn.set(walletRef, {
          sellerId,
          availableBalance:    sellerNetCents,
          withdrawableBalance: 0,
          pendingBalance:      0,
          heldBalance:         0,
          lifetimeEarnings:    sellerNetCents,
          lifetimeWithdrawals: 0,
          lifetimeRefunds:     0,
          createdAt:           _now(),
          updatedAt:           _now(),
        });
      } else {
        txn.update(walletRef, {
          availableBalance: FieldValue.increment(sellerNetCents),
          lifetimeEarnings: FieldValue.increment(sellerNetCents),
          updatedAt:        _now(),
        });
      }

      /* Double-entry ledger */
      txn.set(db.collection('ledger').doc(), {
        type:        'seller_earning',
        sellerId,
        orderId,
        amountCents: sellerNetCents,
        description: description || `Settlement for order ${orderId}`,
        category:    category    || null,
        createdAt:   _now(),
      });
    });

    logger.info('[commission] processSettlement complete', { orderId, sellerId, sellerNetCents });
    return { orderId, settled: true, sellerNetKES: sellerNetCents / 100 };
  }
);

/* ─────────────────────────────────────────────────────────────
   9. requestWithdrawal
   Auth required (seller). Deducts withdrawableBalance and creates
   a pending withdrawal record in a single atomic transaction.
──────────────────────────────────────────────────────────────*/
exports.requestWithdrawal = onCall(
  OPT,
  async (req) => {
    if (!req.auth) throw new HttpsError('unauthenticated', 'Login required');
    const uid = req.auth.uid;
    const { amountCents, method, accountDetails = {} } = req.data;

    if (typeof amountCents !== 'number' || !Number.isInteger(amountCents) || amountCents < 10000)
      throw new HttpsError('invalid-argument', 'amountCents must be an integer >= 10000 (KES 100 minimum)');
    if (!['mpesa', 'bank'].includes(method))
      throw new HttpsError('invalid-argument', "method must be 'mpesa' or 'bank'");

    const db         = _db();
    const FieldValue = admin.firestore.FieldValue;

    /* Pre-check withdrawable balance (fast fail before transaction) */
    const walletSnap = await db.collection('wallets').doc(uid).get();
    if (!walletSnap.exists)
      throw new HttpsError('failed-precondition', 'Wallet not found — no earnings available for withdrawal');
    const withdrawable = walletSnap.data().withdrawableBalance || 0;
    if (withdrawable < amountCents)
      throw new HttpsError(
        'failed-precondition',
        `Insufficient withdrawable balance. Available: KES ${(withdrawable / 100).toFixed(2)}, Requested: KES ${(amountCents / 100).toFixed(2)}`
      );

    /* Pre-generate withdrawal ID so it can be returned to the caller */
    const withdrawalRef = db.collection('withdrawals').doc();
    const withdrawalId  = withdrawalRef.id;

    await db.runTransaction(async (txn) => {
      const walletRef     = db.collection('wallets').doc(uid);
      const walletTxnSnap = await txn.get(walletRef);
      const bal           = walletTxnSnap.data()?.withdrawableBalance || 0;

      /* Re-validate inside transaction to guard against race conditions */
      if (bal < amountCents)
        throw new HttpsError('failed-precondition', 'Insufficient withdrawable balance — concurrent request detected');

      txn.update(walletRef, {
        withdrawableBalance: FieldValue.increment(-amountCents),
        pendingBalance:      FieldValue.increment(amountCents),
        updatedAt:           _now(),
      });

      txn.set(withdrawalRef, {
        withdrawalId,
        sellerId:       uid,
        amountCents,
        method,
        accountDetails,
        status:         'pending',
        requestedAt:    _now(),
      });
    });

    logger.info('[commission] requestWithdrawal', { withdrawalId, uid, amountCents, method });
    return { withdrawalId, amountKES: amountCents / 100, status: 'pending' };
  }
);

/* ─────────────────────────────────────────────────────────────
   10. approveWithdrawal
   Admin-only. Moves pendingBalance to lifetimeWithdrawals and
   marks the withdrawal as approved. Writes a ledger entry.
──────────────────────────────────────────────────────────────*/
exports.approveWithdrawal = onCall(
  OPT,
  async (req) => {
    _assertAdmin(req);
    const uid = req.auth.uid;
    const { withdrawalId, paymentReference = '' } = req.data;
    if (!withdrawalId) throw new HttpsError('invalid-argument', 'withdrawalId required');

    const db            = _db();
    const FieldValue    = admin.firestore.FieldValue;
    const withdrawalRef = db.collection('withdrawals').doc(withdrawalId);

    const withdrawalSnap = await withdrawalRef.get();
    if (!withdrawalSnap.exists) throw new HttpsError('not-found', 'Withdrawal not found');
    const wd = withdrawalSnap.data();
    if (wd.status !== 'pending')
      throw new HttpsError('failed-precondition', `Withdrawal is not pending (current status: ${wd.status})`);

    const { sellerId, amountCents } = wd;

    await db.runTransaction(async (txn) => {
      /* Re-check status inside transaction — prevents double-approval under concurrency */
      const wdSnap = await txn.get(withdrawalRef);
      if (!wdSnap.exists || wdSnap.data().status !== 'pending') {
        throw new HttpsError('failed-precondition', 'Withdrawal is no longer pending');
      }
      txn.update(withdrawalRef, {
        status:           'approved',
        approvedBy:       uid,
        approvedAt:       _now(),
        paymentReference: paymentReference || '',
      });

      txn.update(db.collection('wallets').doc(sellerId), {
        pendingBalance:      FieldValue.increment(-amountCents),
        lifetimeWithdrawals: FieldValue.increment(amountCents),
        updatedAt:           _now(),
      });

      txn.set(db.collection('ledger').doc(), {
        type:             'withdrawal',
        sellerId,
        amountCents,
        description:      'Withdrawal approved',
        withdrawalId,
        paymentReference: paymentReference || '',
        createdAt:        _now(),
      });
    });

    logger.info('[commission] approveWithdrawal', { withdrawalId, sellerId, amountCents });
    return { withdrawalId, approved: true };
  }
);

/* ─────────────────────────────────────────────────────────────
   11. rejectWithdrawal
   Admin-only. Reverts the balance hold: restores withdrawableBalance
   and clears pendingBalance. Does not write a ledger entry.
──────────────────────────────────────────────────────────────*/
exports.rejectWithdrawal = onCall(
  OPT,
  async (req) => {
    _assertAdmin(req);
    const uid = req.auth.uid;
    const { withdrawalId, reason = '' } = req.data;
    if (!withdrawalId) throw new HttpsError('invalid-argument', 'withdrawalId required');

    const db            = _db();
    const FieldValue    = admin.firestore.FieldValue;
    const withdrawalRef = db.collection('withdrawals').doc(withdrawalId);

    const withdrawalSnap = await withdrawalRef.get();
    if (!withdrawalSnap.exists) throw new HttpsError('not-found', 'Withdrawal not found');
    const wd = withdrawalSnap.data();
    if (wd.status !== 'pending')
      throw new HttpsError('failed-precondition', `Withdrawal is not pending (current status: ${wd.status})`);

    const { sellerId, amountCents } = wd;

    await db.runTransaction(async (txn) => {
      /* Re-check status inside transaction — prevents double-rejection / double-balance-restore under concurrency */
      const wdSnap = await txn.get(withdrawalRef);
      if (!wdSnap.exists || wdSnap.data().status !== 'pending') {
        throw new HttpsError('failed-precondition', 'Withdrawal is no longer pending');
      }
      txn.update(withdrawalRef, {
        status:          'rejected',
        rejectedBy:      uid,
        rejectedAt:      _now(),
        rejectionReason: reason || '',
      });

      txn.update(db.collection('wallets').doc(sellerId), {
        withdrawableBalance: FieldValue.increment(amountCents),
        pendingBalance:      FieldValue.increment(-amountCents),
        updatedAt:           _now(),
      });
    });

    logger.info('[commission] rejectWithdrawal', { withdrawalId, sellerId, reason });
    return { withdrawalId, rejected: true };
  }
);

/* ─────────────────────────────────────────────────────────────
   12. getWithdrawals
   Auth required. Sellers see only their own withdrawals; admins
   see all. Supports status filter and cursor-based pagination.
──────────────────────────────────────────────────────────────*/
exports.getWithdrawals = onCall(
  OPT,
  async (req) => {
    if (!req.auth) throw new HttpsError('unauthenticated', 'Login required');
    const uid     = req.auth.uid;
    const isAdmin = !!(req.auth.token?.admin || req.auth.token?.superAdmin);
    const { status, pageSize = 20, cursor } = req.data || {};

    const safePageSize = Math.min(Math.max(1, Number(pageSize) || 20), 100);

    const db = _db();
    let q    = db.collection('withdrawals');

    /* Scope: sellers only see their own withdrawals */
    if (!isAdmin) q = q.where('sellerId', '==', uid);
    if (status)   q = q.where('status',   '==', status);

    q = q.orderBy('requestedAt', 'desc').limit(safePageSize + 1);

    if (cursor) q = q.startAfter(admin.firestore.Timestamp.fromMillis(cursor));

    const snap    = await q.get();
    const hasMore = snap.size > safePageSize;
    const docs    = snap.docs.slice(0, safePageSize);

    const withdrawals = docs.map(d => {
      const data = d.data();
      return {
        id:               d.id,
        withdrawalId:     data.withdrawalId     || d.id,
        sellerId:         data.sellerId,
        amountCents:      data.amountCents,
        amountKES:        (data.amountCents || 0) / 100,
        method:           data.method,
        accountDetails:   data.accountDetails   || {},
        status:           data.status,
        paymentReference: data.paymentReference || null,
        rejectionReason:  data.rejectionReason  || null,
        requestedAt:      data.requestedAt?.toMillis?.()  || null,
        approvedAt:       data.approvedAt?.toMillis?.()   || null,
        rejectedAt:       data.rejectedAt?.toMillis?.()   || null,
      };
    });

    const nextCursor = hasMore
      ? docs[docs.length - 1].data().requestedAt?.toMillis?.() || null
      : null;

    logger.info('[commission] getWithdrawals', { uid, isAdmin, status, count: withdrawals.length });
    return { withdrawals, hasMore, nextCursor };
  }
);

/* ─────────────────────────────────────────────────────────────────────────────
   getCommissionConfig — the ONLY way a client may learn a commission rate.
   ─────────────────────────────────────────────────────────────────────────────
   sokoni-pay.js, sokoni-revenue.js, finos.html and revenue.html each used to carry their
   own hardcoded copy of the rate table, and they had already drifted apart from the server
   and from each other (bnb.html defaulted to 10% while bnb-manage.html defaulted to 5% for
   the same category). Clients now fetch the table from here.

   Read-only, no side effects, and it deliberately requires no admin claim: a seller must be
   able to see what they will be charged. It returns the DEFAULT table only. It does not
   apply commissionRules overrides or commission holidays — for a real, order-specific,
   authoritative figure the caller must use previewCommission(), which runs the full engine.
   That distinction is the point: this endpoint is for DISPLAY, never for computing money.
───────────────────────────────────────────────────────────────────────────── */
exports.getCommissionConfig = onCall(
  OPT,
  async (req) => {
    if (!req.auth) throw new HttpsError('unauthenticated', 'Login required');
    const CC = require('./commission-config');
    return {
      rates:      CC.RATES,
      aliases:    CC.ALIASES,
      minKES:     CC.MIN_COMMISSION_KES,
      /* Callers must not cache this indefinitely — a rate change has to be able to reach them. */
      ttlSeconds: 3600,
      /* Loud reminder in the payload itself, for anyone reading a network trace. */
      note: 'Display only. Use previewCommission() for the authoritative figure on a real order.',
    };
  }
);
