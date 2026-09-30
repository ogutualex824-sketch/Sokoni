/* ================================================================
   SOKONI FinOS — Financial Operating System  (18 Gen2 CFs)
   All monetary values in KES integer cents internally.
   Every write is idempotent. No client-side financial trust.
================================================================ */
'use strict';

const { onCall, onRequest, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule }                    = require('firebase-functions/v2/scheduler');
const { defineSecret }                  = require('firebase-functions/params');
const logger                            = require('firebase-functions/logger');
const admin                             = require('firebase-admin');
const Anthropic                         = require('@anthropic-ai/sdk');
const crypto                            = require('crypto');

const U = require('./finos-utils');

const REGION             = 'us-central1';
const INTASEND_PRIV      = defineSecret('INTASEND_PRIVATE_KEY');
const ANTHROPIC_API_KEY  = defineSecret('ANTHROPIC_API_KEY');

function _db()  { return admin.firestore(); }
function _now() { return admin.firestore.FieldValue.serverTimestamp(); }
function _uid(req) { return req.auth?.uid || null; }
function _assertAuth(req)  { if (!_uid(req))              throw new HttpsError('unauthenticated', 'Login required'); }
function _assertAdmin(req) {
  if (!req.auth?.token?.admin && !req.auth?.token?.superAdmin)
    throw new HttpsError('permission-denied', 'Admin access required');
}

/* ─────────────────────────────────────────────────────────────
   1. recordPayment — callable
   Records an incoming payment, distributes earnings to wallets.
──────────────────────────────────────────────────────────────*/
exports.recordPayment = onCall(
  { region: REGION, timeoutSeconds: 60, memory: '256MiB', invoker: 'private', enforceAppCheck: true },
  async (request) => {
    _assertAuth(request);
    const {
      orderId, orderAmountCents, category, sellerId, riderId, buyerId,
      deliveryFeeCents, tipCents, idempotencyKey,
    } = request.data;

    if (!orderId || !orderAmountCents || !sellerId)
      throw new HttpsError('invalid-argument', 'orderId, orderAmountCents, sellerId required');
    if (!Number.isInteger(orderAmountCents) || orderAmountCents <= 0)
      throw new HttpsError('invalid-argument', 'orderAmountCents must be a positive integer (KES cents)');

    const ikey = idempotencyKey || U.generateIdempotencyKey(['payment', orderId]);
    const cached = await U.checkIdempotency(_db(), ikey);
    if (cached) return { ...cached.result, duplicate: true };

    /* Commission & tax */
    const comm = await U.calculateCommission(_db(), { orderAmountCents, category, sellerId });
    const vat  = U.calculateVAT(comm.commissionCents, category);

    const deliveryCents = Math.round(deliveryFeeCents || 0);
    const tipCts        = Math.round(tipCents || 0);
    const riderEarnings = Math.round(deliveryCents * 0.88); /* Rider keeps 88% of delivery fee */
    const platformDeliv = deliveryCents - riderEarnings;

    const db = _db();

    /* ── Ledger entries: all written atomically in one batch ──────────────
       createLedgerEntry() internally runs a per-entry mini-transaction.
       To avoid partial writes when the function crashes mid-sequence we
       inline the doc construction and commit everything in a single batch.
       The outer idempotency key (ikey) guards the whole function, so
       duplicate invocations are rejected before the batch is built.
    ─────────────────────────────────────────────────────────────────────*/
    const ledgerBatch = db.batch();
    const _now_ts = admin.firestore.FieldValue.serverTimestamp;
    const createdBy = _uid(request);

    /* Helper: add one ledger entry + idempotency record to the batch */
    const batchLedger = (entryData) => {
      const ref  = db.collection('ledger').doc();
      const data = {
        id:             ref.id,
        type:           entryData.type,
        amountCents:    entryData.amountCents,
        currency:       'KES',
        debitAccount:   entryData.debitAccount,
        creditAccount:  entryData.creditAccount,
        description:    entryData.description   || '',
        orderId:        entryData.orderId        || null,
        sellerId:       entryData.sellerId       || null,
        riderId:        entryData.riderId        || null,
        buyerId:        entryData.buyerId        || null,
        category:       entryData.category       || null,
        metadata:       entryData.metadata       || {},
        status:         'settled',
        reversalRef:    null,
        createdBy:      entryData.createdBy      || 'system',
        idempotencyKey: entryData.idempotencyKey,
        createdAt:      _now_ts(),
        settledAt:      _now_ts(),
      };
      ledgerBatch.set(ref, data);
      ledgerBatch.set(db.collection('finosIdempotency').doc(entryData.idempotencyKey), {
        key:       entryData.idempotencyKey,
        result:    { ledgerId: ref.id },
        createdAt: _now_ts(),
      });
    };

    /* Ledger: payment received from gateway */
    batchLedger({
      type: 'payment_received', amountCents: orderAmountCents,
      debitAccount:  U.ACCOUNTS.EXTERNAL_GATEWAY,
      creditAccount: U.ACCOUNTS.PLATFORM_CLEARING,
      description:   `Payment for order ${orderId}`,
      orderId, sellerId, buyerId, category,
      metadata: { commission: comm, vat },
      createdBy, idempotencyKey: ikey,
    });

    /* Ledger: seller earning */
    const sellerKey = U.generateIdempotencyKey(['seller_earn', orderId]);
    batchLedger({
      type: 'seller_earning', amountCents: comm.sellerNetCents,
      debitAccount:  U.ACCOUNTS.PLATFORM_CLEARING,
      creditAccount: U.ACCOUNTS.seller(sellerId),
      description:   `Seller net for order ${orderId}`,
      orderId, sellerId, category, idempotencyKey: sellerKey,
    });

    /* Ledger: platform commission */
    const commKey = U.generateIdempotencyKey(['commission', orderId]);
    batchLedger({
      type: 'commission', amountCents: comm.commissionCents,
      debitAccount:  U.ACCOUNTS.PLATFORM_CLEARING,
      creditAccount: U.ACCOUNTS.PLATFORM_REVENUE,
      description:   `Commission (${comm.effectiveRate}%) for order ${orderId}`,
      orderId, sellerId, category, metadata: { rate: comm.effectiveRate, ruleId: comm.ruleId },
      idempotencyKey: commKey,
    });

    /* Ledger: VAT on commission */
    if (vat.taxCents > 0) {
      const vatKey = U.generateIdempotencyKey(['vat', orderId]);
      batchLedger({
        type: 'tax', amountCents: vat.taxCents,
        debitAccount:  U.ACCOUNTS.PLATFORM_REVENUE,
        creditAccount: U.ACCOUNTS.PLATFORM_TAX,
        description:   `VAT (${vat.taxRate}%) on commission for order ${orderId}`,
        orderId, sellerId, category, metadata: { taxType: 'VAT', taxRate: vat.taxRate },
        idempotencyKey: vatKey,
      });
    }

    /* Ledger: delivery fee → rider */
    if (deliveryCents > 0 && riderId) {
      const delKey = U.generateIdempotencyKey(['delivery_fee', orderId]);
      batchLedger({
        type: 'delivery_fee', amountCents: riderEarnings,
        debitAccount:  U.ACCOUNTS.PLATFORM_CLEARING,
        creditAccount: U.ACCOUNTS.rider(riderId),
        description:   `Delivery fee for order ${orderId}`,
        orderId, riderId, metadata: { grossDelivery: deliveryCents, platformCut: platformDeliv },
        idempotencyKey: delKey,
      });
    }

    /* Ledger: tip → rider */
    if (tipCts > 0 && riderId) {
      const tipKey = U.generateIdempotencyKey(['tip', orderId]);
      batchLedger({
        type: 'tip', amountCents: tipCts,
        debitAccount: U.ACCOUNTS.PLATFORM_CLEARING,
        creditAccount: U.ACCOUNTS.rider(riderId),
        description: `Tip for order ${orderId}`, orderId, riderId, idempotencyKey: tipKey,
      });
    }

    /* Commit all ledger entries atomically */
    await ledgerBatch.commit();

    /* Wallet credits — idempotency guard prevents double-credit if CF crashes
       between ledgerBatch.commit() and here, then retries before markIdempotency */
    const walletIdemKey = `wallet_credit:${orderId}`;
    const walletIdemRef = db.collection('finosWalletIdempotency').doc(walletIdemKey);
    const walletIdemSnap = await walletIdemRef.get();
    if (!walletIdemSnap.exists) {
      await db.runTransaction(async (txn) => {
        const sentinel = await txn.get(walletIdemRef);
        if (sentinel.exists) return; // another concurrent invocation already completed
        U.creditWalletTxn(txn, db, sellerId, 'seller', comm.sellerNetCents, { description: `Order ${orderId}`, orderId, type: 'order_earning' });
        if (riderId && (riderEarnings + tipCts) > 0) {
          U.creditWalletTxn(txn, db, riderId, 'rider', riderEarnings + tipCts, { description: `Delivery+tip ${orderId}`, orderId, type: 'delivery_earning' });
        }
        U.creditWalletTxn(txn, db, 'platform_master', 'platform', comm.commissionCents + platformDeliv, { description: `Commission+platform delivery ${orderId}`, orderId, type: 'commission' });
        txn.set(walletIdemRef, { orderId, creditedAt: admin.firestore.FieldValue.serverTimestamp() });
      });
    }

    /* Update order with financial fingerprint */
    await db.collection('packageRequests').doc(orderId).update({
      financialProcessed: true, commissionRate: comm.effectiveRate,
      commissionCents: comm.commissionCents, sellerNetCents: comm.sellerNetCents,
      vatCents: vat.taxCents, deliveryRiderNetCents: riderEarnings,
      financialProcessedAt: _now(),
    }).catch(() => {});

    await U.writeAuditLog(_db(), {
      action: 'payment_recorded', entityId: orderId, entityType: 'order',
      after: { orderAmountCents, commissionCents: comm.commissionCents, sellerNetCents: comm.sellerNetCents },
      performedBy: _uid(request),
    });

    const result = { status: 'recorded', orderId, commission: comm, vat };
    await U.markIdempotency(_db(), ikey, result);
    logger.info('[finos] Payment recorded', { orderId, commissionCents: comm.commissionCents });
    return result;
  }
);

/* ─────────────────────────────────────────────────────────────
   2. processRefund — callable
   Full or partial refund with ledger reversal + wallet clawback.
──────────────────────────────────────────────────────────────*/
exports.processRefund = onCall(
  { region: REGION, timeoutSeconds: 60, memory: '256MiB', invoker: 'private', enforceAppCheck: true },
  async (request) => {
    _assertAuth(request);
    const { orderId, refundAmountCents, reason, fullRefund, buyerPhone } = request.data;
    if (!orderId || (!refundAmountCents && !fullRefund))
      throw new HttpsError('invalid-argument', 'orderId and refundAmountCents (or fullRefund:true) required');

    const db = _db();
    const orderSnap = await db.collection('packageRequests').doc(orderId).get();
    if (!orderSnap.exists) throw new HttpsError('not-found', 'Order not found');
    const order = orderSnap.data();

    /* Ownership check: caller must be the buyer OR an admin */
    const callerUid   = _uid(request);
    const callerAdmin = request.auth?.token?.admin || request.auth?.token?.superAdmin;
    if (!callerAdmin && order.buyerUid !== callerUid)
      throw new HttpsError('permission-denied', 'You may only refund your own orders');

    const ikey = U.generateIdempotencyKey(['refund', orderId, String(refundAmountCents || 'full')]);
    const cached = await U.checkIdempotency(db, ikey);
    if (cached) return { ...cached.result, duplicate: true };

    const orderAmtCents = order.orderAmountCents || Math.round((order.total || 0) * 100);
    const refundCts     = fullRefund ? orderAmtCents : Math.min(refundAmountCents, orderAmtCents);
    const ratio         = orderAmtCents > 0 ? refundCts / orderAmtCents : 0;

    /* Fraud check: refund cannot exceed original order */
    if (refundCts > orderAmtCents)
      throw new HttpsError('invalid-argument', `Refund (${refundCts}) exceeds order amount (${orderAmtCents})`);

    const commClawback  = Math.round((order.commissionCents || 0) * ratio);
    const sellerClawback= Math.round((order.sellerNetCents  || 0) * ratio);
    const vatClawback   = Math.round((order.vatCents        || 0) * ratio);
    const sellerId      = order.sellerId || order.shopOwnerId;

    /* Ledger entries */
    await U.createLedgerEntry(db, {
      type: 'refund', amountCents: refundCts,
      debitAccount:  U.ACCOUNTS.PLATFORM_CLEARING,
      creditAccount: U.ACCOUNTS.EXTERNAL_GATEWAY,
      description:   `Refund for order ${orderId}: ${reason || 'customer request'}`,
      orderId, sellerId, buyerId: order.buyerUid, category: order.category,
      metadata: { ratio, reason, commClawback, sellerClawback },
      idempotencyKey: ikey,
    });

    if (commClawback > 0) {
      await U.createLedgerEntry(db, {
        type: 'commission_reversal', amountCents: commClawback,
        debitAccount:  U.ACCOUNTS.PLATFORM_REVENUE,
        creditAccount: U.ACCOUNTS.PLATFORM_CLEARING,
        description: `Commission reversal for refund ${orderId}`,
        orderId, sellerId, idempotencyKey: U.generateIdempotencyKey(['comm_rev', orderId, String(refundCts)]),
      });
    }

    if (vatClawback > 0) {
      await U.createLedgerEntry(db, {
        type: 'tax_reversal', amountCents: vatClawback,
        debitAccount:  U.ACCOUNTS.PLATFORM_TAX,
        creditAccount: U.ACCOUNTS.PLATFORM_REVENUE,
        description: `VAT reversal for refund ${orderId}`,
        orderId, idempotencyKey: U.generateIdempotencyKey(['vat_rev', orderId, String(refundCts)]),
      });
    }

    /* Wallet clawback from seller */
    if (sellerId && sellerClawback > 0) {
      await db.runTransaction(async (txn) => {
        await U.debitWalletTxn(txn, db, sellerId, sellerClawback, {
          description: `Refund clawback for order ${orderId}`,
          orderId, type: 'refund_deduction', allowNegative: true,
        });
        /* txn.update, not db...update. This previously wrote through `db`,
           which put it OUTSIDE the transaction it sits inside: Firestore
           retries a contended transaction callback, so each retry incremented
           again, and an aborted transaction rolled back the debit on line 292
           while leaving this increment applied. lifetimeRefunds is a display
           statistic (one reader: commission.js:410 -> seller-earnings.html),
           so the exposure was a wrong number on a dashboard rather than
           spendable balance — but the write is now atomic with the debit. */
        txn.update(db.collection('wallets').doc(sellerId), {
          lifetimeRefunds: admin.firestore.FieldValue.increment(sellerClawback),
        });
      });
    }

    /* Update order */
    await db.collection('packageRequests').doc(orderId).update({
      status: 'refund_processed', refundProcessed: true,
      refundAmountCents: refundCts, refundReason: reason || null,
      refundAt: _now(),
    }).catch(() => {});

    /* Queue buyer refund via SMS */
    if (buyerPhone || order.buyerPhone) {
      await db.collection('smsQueue').add({
        phone: buyerPhone || order.buyerPhone,
        message: `SOKONI: Refund of KES ${(refundCts / 100).toFixed(0)} for order ${orderId} has been processed. Allow 3-5 business days for M-Pesa reversal.`,
        createdAt: _now(), status: 'pending',
      }).catch(() => {});
    }

    await U.writeAuditLog(db, {
      action: 'refund_processed', entityId: orderId, entityType: 'order',
      after: { refundCts, sellerClawback, commClawback }, performedBy: _uid(request),
    });

    const result = { status: 'refunded', orderId, refundAmountCents: refundCts, sellerClawback };
    await U.markIdempotency(db, ikey, result);
    logger.info('[finos] Refund processed', { orderId, refundCts });
    return result;
  }
);

/* ─────────────────────────────────────────────────────────────
   3. requestPayout — callable
   Seller or rider requests a payout to M-Pesa.
──────────────────────────────────────────────────────────────*/
exports.requestPayout = onCall(
  { region: REGION, timeoutSeconds: 30, memory: '128MiB', invoker: 'private',
    enforceAppCheck: true, secrets: [INTASEND_PRIV] },
  async (request) => {
    _assertAuth(request);
    /* RETIRED — earnings now converge into wallets.balance (see sweepEarningsToWallet);
       this FinOS payout reads availableBalance and would double-pay against the swept
       balance. Withdrawals go through the wallet (requestSellerPayout) only. */
    throw new HttpsError('failed-precondition',
      'Withdrawals now go through your SOKONI Wallet (Wallet → Withdraw). This method is retired.');
    /* eslint-disable no-unreachable */
    const uid = _uid(request);
    const { amountCents, phone, entityType } = request.data;

    if (!amountCents || !phone)
      throw new HttpsError('invalid-argument', 'amountCents and phone required');
    if (!Number.isInteger(amountCents) || amountCents < 100)
      throw new HttpsError('invalid-argument', 'Minimum payout is KES 1 (100 cents)');

    const db = _db();
    const wallet = await U.getOrInitWallet(db, uid, entityType || 'seller');
    if ((wallet.availableBalance || 0) < amountCents)
      throw new HttpsError('failed-precondition', `Insufficient balance. Available: KES ${((wallet.availableBalance || 0) / 100).toFixed(0)}`);

    /* Fraud check */
    await U.checkFinancialFraud(db, { entityId: uid, entityType: entityType || 'seller', eventType: 'payout', amountCents });

    /* WHT deduction */
    const wht      = U.calculateWHT(amountCents);
    const netCents = wht.netCents;

    const ikey    = U.generateIdempotencyKey(['payout_request', uid, String(amountCents), String(Date.now())]);
    const payoutRef = db.collection('payouts').doc();

    await db.runTransaction(async (txn) => {
      U.holdWalletTxn(txn, db, uid, amountCents, { description: `Payout hold ${payoutRef.id}` });
      txn.set(payoutRef, {
        id:              payoutRef.id,
        entityId:        uid,
        entityType:      entityType || 'seller',
        grossCents:      amountCents,
        whtCents:        wht.whtCents,
        netCents,
        currency:        'KES',
        phone:           String(phone).replace(/\D/g, '').replace(/^0/, '254'),
        method:          'mpesa',
        status:          'pending',
        attempts:        0,
        idempotencyKey:  ikey,
        createdAt:       _now(),
        createdAtMs:     Date.now(),
        retryAt:         null,
      });
    });

    /* Ledger: payout initiated */
    await U.createLedgerEntry(db, {
      type: 'payout_initiated', amountCents,
      debitAccount:  U.ACCOUNTS.seller(uid),
      creditAccount: U.ACCOUNTS.PLATFORM_HOLDS,
      description:   `Payout initiated to ${phone}`,
      metadata:      { payoutId: payoutRef.id, whtCents: wht.whtCents },
      idempotencyKey: ikey,
    });

    await U.writeAuditLog(db, { action: 'payout_requested', entityId: uid, entityType: entityType || 'seller',
      after: { amountCents, netCents, whtCents: wht.whtCents, payoutId: payoutRef.id }, performedBy: uid });

    logger.info('[finos] Payout requested', { payoutId: payoutRef.id, uid, amountCents });
    return { status: 'pending', payoutId: payoutRef.id, grossCents: amountCents, whtCents: wht.whtCents, netCents };
  }
);

/* ─────────────────────────────────────────────────────────────
   4. processPendingPayouts — scheduled every 30 min
   Processes pending payouts via IntaSend B2C.
──────────────────────────────────────────────────────────────*/
exports.processPendingPayouts = onSchedule(
  { schedule: 'every 30 minutes', region: REGION, secrets: [INTASEND_PRIV],
    timeoutSeconds: 540, memory: '256MiB' },
  async () => {
    const db      = _db();
    const privKey = INTASEND_PRIV.value();

    /* Recover payouts stuck in 'processing' for >10 min (CF crash recovery) */
    const stuckCutoff = admin.firestore.Timestamp.fromMillis(Date.now() - 10 * 60 * 1000);
    const stuckSnap   = await db.collection('payouts')
      .where('status', '==', 'processing')
      .where('processingAt', '<', stuckCutoff)
      .limit(50).get().catch(() => null);
    if (stuckSnap && !stuckSnap.empty) {
      const resetBatch = db.batch();
      stuckSnap.docs.forEach(d => resetBatch.update(d.ref, { status: 'pending', failureReason: 'Recovered from stuck processing state' }));
      await resetBatch.commit().catch(e => logger.error('[finos] Stuck-payout reset failed', { error: e.message }));
      logger.warn('[finos] Reset stuck payouts', { count: stuckSnap.size });
    }

    const snap    = await db.collection('payouts').where('status', '==', 'pending').limit(100).get();
    if (snap.empty) return;

    let processed = 0, failed = 0;
    for (const doc of snap.docs) {
      const payout = doc.data();
      /* Skip if retry hold not yet passed */
      if (payout.retryAt && payout.retryAt.toMillis() > Date.now()) continue;

      /* ── MANDATORY duplicate-payout protection ──────────────────────────
         Orders settled via NATIVE SPLIT are paid directly by the payment
         gateway (seller net → seller account, commission → platform collection
         account) and MUST
         NEVER enter the B2C payout queue. Split-settled orders normally never
         create a payout doc at all; this is the defense-in-depth guard that
         quarantines any that slip through, guaranteeing exactly one settlement
         path per transaction. DO NOT REMOVE. */
      if (payout.settlementMethod === 'split' || payout.splitSettled === true) {
        await doc.ref.update({
          status:        'skipped_split',
          skippedReason: 'split-settled — paid directly by gateway; B2C payout suppressed',
          skippedAt:     _now(),
        }).catch(() => {});
        logger.warn('[finos] Duplicate-payout guard: skipped B2C for split-settled order', {
          payoutId: doc.id, orderId: payout.orderId || null,
        });
        continue;
      }

      try {
        await doc.ref.update({ status: 'processing', processingAt: _now() });
        const resp = await U.intasendB2C(privKey, {
          phone:      payout.phone,
          amountKES:  (payout.netCents / 100).toFixed(0),
          reference:  payout.id,
          remarks:    'SOKONI Earnings Payout',
        });

        await db.runTransaction(async (txn) => {
          U.settleHoldTxn(txn, db, payout.entityId, payout.grossCents, { description: `Payout ${payout.id} settled` });
          txn.update(doc.ref, { status: 'completed', completedAt: _now(), intasendRef: resp?.tracking_id || null, attempts: (payout.attempts || 0) + 1 });
        });

        await U.createLedgerEntry(db, {
          type: 'payout_settled', amountCents: payout.grossCents,
          debitAccount:  U.ACCOUNTS.PLATFORM_HOLDS,
          creditAccount: U.ACCOUNTS.EXTERNAL_MPESA,
          description:   `Payout settled ${payout.id}`,
          metadata:      { payoutId: payout.id, netCents: payout.netCents },
          idempotencyKey: U.generateIdempotencyKey(['payout_settled', payout.id]),
        });

        /* WHT tax record */
        if (payout.whtCents > 0) {
          await U.createLedgerEntry(db, {
            type: 'tax', amountCents: payout.whtCents,
            debitAccount: U.ACCOUNTS.PLATFORM_HOLDS, creditAccount: U.ACCOUNTS.PLATFORM_TAX,
            description: `WHT on payout ${payout.id}`, metadata: { taxType: 'WHT', payoutId: payout.id },
            idempotencyKey: U.generateIdempotencyKey(['wht', payout.id]),
          });
        }

        processed++;
        logger.info('[finos] Payout completed', { payoutId: payout.id });
      } catch (e) {
        failed++;
        const attempts = (payout.attempts || 0) + 1;
        const maxRetry = 3;
        if (attempts >= maxRetry) {
          /* Release hold, mark failed */
          await db.runTransaction(async (txn) => {
            U.releaseHoldTxn(txn, db, payout.entityId, payout.grossCents, { description: `Payout failed ${payout.id}` });
            txn.update(doc.ref, { status: 'failed', failedAt: _now(), failureReason: e.message, attempts });
          });
          logger.error('[finos] Payout permanently failed', { payoutId: payout.id, error: e.message });
        } else {
          const retryDelay = [0, 900000, 1800000][attempts] || 3600000; /* 0/15min/30min */
          await doc.ref.update({
            status: 'pending', attempts, failureReason: e.message,
            retryAt: admin.firestore.Timestamp.fromMillis(Date.now() + retryDelay),
          });
        }
      }
    }
    logger.info('[finos] Payout batch done', { processed, failed, total: snap.size });
  }
);

/* ─────────────────────────────────────────────────────────────
   5. applyPromoCode — callable
   Validates promo and returns discount details. Consumption on order completion.
──────────────────────────────────────────────────────────────*/
exports.applyPromoCode = onCall(
  { region: REGION, timeoutSeconds: 30, memory: '128MiB', invoker: 'private', enforceAppCheck: true },
  async (request) => {
    _assertAuth(request);
    const { code, orderAmountCents, category, orderId } = request.data;
    if (!code || !orderAmountCents) throw new HttpsError('invalid-argument', 'code and orderAmountCents required');

    const db     = _db();
    const result = await U.validatePromoCode(db, { code, buyerUid: _uid(request), orderAmountCents, category });
    if (!result.valid) throw new HttpsError('failed-precondition', result.error);

    /* Record usage */
    if (orderId) {
      await U.recordPromoUsage(db, { promoId: result.promoId, promoCode: result.promoCode, buyerUid: _uid(request), orderId, discountCents: result.discountCents });
      /* Ledger: promotion subsidy */
      await U.createLedgerEntry(db, {
        type: 'promotion', amountCents: result.discountCents,
        debitAccount:  result.fundedBy === 'seller' ? U.ACCOUNTS.seller(result.fundingEntityId || '') : U.ACCOUNTS.PLATFORM_PROMOS,
        creditAccount: U.ACCOUNTS.EXTERNAL_GATEWAY,
        description:   `Promo ${result.promoCode} discount for order ${orderId}`,
        orderId, buyerId: _uid(request),
        metadata:      { promoId: result.promoId, discountType: result.discountType, platformPct: result.platformPct },
        idempotencyKey: U.generateIdempotencyKey(['promo', result.promoId, orderId]),
      });
    }

    logger.info('[finos] Promo applied', { code, discountCents: result.discountCents });
    return result;
  }
);

/* ─────────────────────────────────────────────────────────────
   6. createPromotion — callable (admin)
──────────────────────────────────────────────────────────────*/
exports.createPromotion = onCall(
  { region: REGION, timeoutSeconds: 30, memory: '128MiB', invoker: 'private', enforceAppCheck: true },
  async (request) => {
    _assertAdmin(request);
    const data = request.data;
    if (!data.code || !data.discountType) throw new HttpsError('invalid-argument', 'code and discountType required');

    const db  = _db();
    const ref = db.collection('promotions').doc();
    await ref.set({
      id:              ref.id,
      code:            String(data.code).toUpperCase().trim(),
      type:            data.type            || 'coupon',
      discountType:    data.discountType,
      discountValue:   data.discountValue   || 0,
      discountValueCents: data.discountValueCents || 0,
      maxDiscountCents:data.maxDiscountCents || null,
      minOrderAmountCents: data.minOrderAmountCents || 0,
      fundedBy:        data.fundedBy        || 'platform',
      fundingEntityId: data.fundingEntityId || null,
      platformFundingPct: data.platformFundingPct || 100,
      sellerFundingPct:   data.sellerFundingPct   || 0,
      usageLimit:      data.usageLimit      || null,
      perUserLimit:    data.perUserLimit    || null,
      usageCount:      0,
      category:        data.category        || null,
      isActive:        true,
      startDate:       data.startDate ? admin.firestore.Timestamp.fromMillis(new Date(data.startDate).getTime()) : _now(),
      endDate:         data.endDate   ? admin.firestore.Timestamp.fromMillis(new Date(data.endDate).getTime())   : null,
      createdBy:       _uid(request),
      createdAt:       _now(),
    });

    await U.writeAuditLog(db, { action: 'promotion_created', entityId: ref.id, entityType: 'promotion', after: { code: data.code }, performedBy: _uid(request) });
    logger.info('[finos] Promotion created', { promoId: ref.id, code: data.code });
    return { promoId: ref.id, code: data.code };
  }
);

/* ─────────────────────────────────────────────────────────────
   7. billingSubscriptions — scheduled daily 06:00 EAT
   Charges sellers with active subscription plans.
──────────────────────────────────────────────────────────────*/
exports.billingSubscriptions = onSchedule(
  { schedule: '0 3 * * *', timeZone: 'Africa/Nairobi', region: REGION, timeoutSeconds: 540, memory: '256MiB' },
  async () => {
    const db  = _db();
    const now = Date.now();
    const snap = await db.collection('subscriptions').where('status', '==', 'active').get().catch(() => null);
    if (!snap || snap.empty) { logger.info('[finos] No active subscriptions'); return; }

    let billed = 0, skipped = 0;
    for (const doc of snap.docs) {
      const sub = doc.data();
      const nextBilling = sub.nextBillingAt?.toMillis?.() || 0;
      if (nextBilling > now) { skipped++; continue; }

      const amountCents = Math.round((sub.priceKES || 0) * 100);
      if (!amountCents || !sub.entityId) { skipped++; continue; }

      const ikey = U.generateIdempotencyKey(['sub_bill', doc.id, String(nextBilling)]);
      const cached = await U.checkIdempotency(db, ikey);
      if (cached) { skipped++; continue; }

      try {
        /* Debit seller wallet */
        await db.runTransaction(async (txn) => {
          await U.debitWalletTxn(txn, db, sub.entityId, amountCents, {
            description: `${sub.planName || 'Subscription'} billing`, type: 'subscription', allowNegative: false,
          });
        });

        await U.createLedgerEntry(db, {
          type: 'subscription', amountCents,
          debitAccount: U.ACCOUNTS.seller(sub.entityId),
          creditAccount: U.ACCOUNTS.PLATFORM_REVENUE,
          description: `Subscription billing: ${sub.planName || doc.id}`,
          sellerId: sub.entityId,
          metadata: { subscriptionId: doc.id, planName: sub.planName, periodDays: sub.periodDays || 30 },
          idempotencyKey: ikey,
        });

        /* Advance next billing date */
        const periodMs = (sub.periodDays || 30) * 86400000;
        await doc.ref.update({
          lastBilledAt: _now(), nextBillingAt: admin.firestore.Timestamp.fromMillis(now + periodMs),
        });
        billed++;
      } catch (e) {
        /* Grace period: mark payment_failed, suspend after 3 consecutive failures */
        const failures = (sub.consecutiveFailures || 0) + 1;
        await doc.ref.update({
          paymentStatus: 'failed', consecutiveFailures: failures,
          lastFailedAt: _now(), lastFailureReason: e.message,
          status: failures >= 3 ? 'suspended' : 'active',
        });
        logger.warn('[finos] Subscription billing failed', { subId: doc.id, error: e.message });
      }
    }
    logger.info('[finos] Subscription billing done', { billed, skipped, total: snap.size });
  }
);

/* ─────────────────────────────────────────────────────────────
   8. billingAdvertising — scheduled daily 07:00 EAT
   Deducts daily ad spend from advertiser wallets.
──────────────────────────────────────────────────────────────*/
exports.billingAdvertising = onSchedule(
  { schedule: '0 4 * * *', timeZone: 'Africa/Nairobi', region: REGION, timeoutSeconds: 540, memory: '256MiB' },
  async () => {
    const db  = _db();
    const today = new Date().toISOString().slice(0, 10);
    const snap = await db.collection('adCampaigns').where('status', '==', 'active').get().catch(() => null);
    if (!snap || snap.empty) return;

    let billed = 0;
    for (const doc of snap.docs) {
      const ad = doc.data();
      const dailyBudgetCents = Math.round((ad.dailyBudgetKES || 0) * 100);
      if (!dailyBudgetCents || !ad.advertiserId) continue;

      const ikey = U.generateIdempotencyKey(['ad_bill', doc.id, today]);
      const cached = await U.checkIdempotency(db, ikey);
      if (cached) continue;

      /* Check actual spend vs budget — use impressionCost from analytics */
      const spendSnap = await db.collection('adAnalytics').doc(`${doc.id}_${today}`).get().catch(() => null);
      const actualSpendCents = Math.round(((spendSnap?.data()?.revenueKES) || ad.dailyBudgetKES || 0) * 100);
      const billCents = Math.min(actualSpendCents, dailyBudgetCents);
      if (billCents <= 0) continue;

      try {
        await db.runTransaction(async (txn) => {
          await U.debitWalletTxn(txn, db, ad.advertiserId, billCents, {
            description: `Ad spend: ${ad.name || doc.id} (${today})`, type: 'ad_billing', allowNegative: false,
          });
        });

        await U.createLedgerEntry(db, {
          type: 'advertising', amountCents: billCents,
          debitAccount: U.ACCOUNTS.ad(ad.advertiserId), creditAccount: U.ACCOUNTS.PLATFORM_REVENUE,
          description: `Ad billing ${ad.name || doc.id} — ${today}`,
          metadata: { campaignId: doc.id, date: today, billCents },
          idempotencyKey: ikey,
        });

        /* Pause if balance exhausted */
        const wallet = await U.getOrInitWallet(db, ad.advertiserId, 'advertiser');
        if ((wallet.availableBalance || 0) < dailyBudgetCents) {
          await doc.ref.update({ status: 'paused_budget', pausedAt: _now() });
        }
        billed++;
      } catch (e) {
        await doc.ref.update({ status: 'paused_budget', pausedAt: _now(), pauseReason: e.message });
        logger.warn('[finos] Ad billing failed', { campaignId: doc.id, error: e.message });
      }
    }
    logger.info('[finos] Ad billing done', { billed, total: snap.size });
  }
);

/* ─────────────────────────────────────────────────────────────
   9. detectFinancialFraud — scheduled every hour
   Scans for suspicious financial patterns platform-wide.
──────────────────────────────────────────────────────────────*/
exports.detectFinancialFraud = onSchedule(
  { schedule: 'every 60 minutes', region: REGION, timeoutSeconds: 300, memory: '256MiB' },
  async () => {
    const db  = _db();
    const now = Date.now();
    const hour = 3600000;

    /* Deterministic ID helper — prevents duplicate alerts across hourly scan runs */
    const hourBucket = Math.floor(now / 3600000);  // changes every hour
    const dayBucket  = Math.floor(now / 86400000); // changes every day
    const _upsertAlert = async (id, data) => {
      const ref = db.collection('fraudAlerts').doc(id);
      const snap = await ref.get().catch(() => null);
      if (snap && snap.exists && snap.data().status === 'resolved') return; // already handled
      await ref.set({ ...data, updatedAt: _now(), createdAt: snap?.exists ? snap.data().createdAt : _now() },
        { merge: true }).catch(() => {});
    };

    /* Pattern 1: Multiple large refunds in < 1h (possible fraud) */
    const refundCutoff = admin.firestore.Timestamp.fromMillis(now - hour);
    const refundSnap = await db.collection('ledger')
      .where('type', '==', 'refund')
      .where('createdAt', '>=', refundCutoff)
      .get().catch(() => null);
    if (refundSnap) {
      const recentRefunds = refundSnap.docs;
      if (recentRefunds.length >= 10) {
        await _upsertAlert(`refund_spike_${hourBucket}`, {
          type: 'financial', subType: 'refund_spike',
          count: recentRefunds.length, windowH: 1,
          severity: 'high', status: 'open',
          detail: `${recentRefunds.length} refunds in 1h`,
        });
      }
    }

    /* Pattern 2: Payouts to same phone from multiple accounts */
    const payoutCutoff = admin.firestore.Timestamp.fromMillis(now - 86400000);
    const payoutSnap = await db.collection('payouts')
      .where('status', '==', 'completed')
      .where('completedAt', '>=', payoutCutoff)
      .get().catch(() => null);
    if (payoutSnap) {
      const phoneCounts = {};
      payoutSnap.docs.forEach(d => {
        const phone = d.data().phone;
        phoneCounts[phone] = (phoneCounts[phone] || new Set());
        phoneCounts[phone].add(d.data().entityId);
      });
      for (const [phone, entities] of Object.entries(phoneCounts)) {
        if (entities.size >= 3) {
          const safePhone = phone.replace(/[^0-9+]/g, '').slice(0, 20);
          await _upsertAlert(`phone_abuse_${safePhone}_${dayBucket}`, {
            type: 'financial', subType: 'multiple_entities_same_phone',
            phone, entityCount: entities.size, severity: 'high', status: 'open',
            detail: `${entities.size} different accounts paying to same phone ${phone}`,
          });
        }
      }
    }

    /* Pattern 3: Promo abuse — same user applying multiple codes in 24h */
    const promoCutoff = admin.firestore.Timestamp.fromMillis(now - 86400000);
    const usageSnap = await db.collection('promotionUsage')
      .where('usedAt', '>=', promoCutoff)
      .get().catch(() => null);
    if (usageSnap) {
      const userCodes = {};
      usageSnap.docs.forEach(d => {
        const data = d.data();
        userCodes[data.buyerUid] = (userCodes[data.buyerUid] || 0) + 1;
      });
      for (const [uid, count] of Object.entries(userCodes)) {
        if (count >= 5) {
          await _upsertAlert(`promo_abuse_${uid}_${dayBucket}`, {
            type: 'financial', subType: 'promo_abuse',
            entityId: uid, entityType: 'buyer', count,
            severity: 'medium', status: 'open',
            detail: `${count} promos used in 24h by ${uid}`,
          });
        }
      }
    }

    logger.info('[finos] Fraud scan complete');
  }
);

/* ─────────────────────────────────────────────────────────────
   10. generateDailySnapshot — scheduled daily 00:30 EAT
   Aggregates all financial data into a daily snapshot.
──────────────────────────────────────────────────────────────*/
exports.generateDailySnapshot = onSchedule(
  { schedule: '30 21 * * *', timeZone: 'UTC', region: REGION, timeoutSeconds: 540, memory: '512MiB' },
  async () => {
    const db      = _db();
    const nairobi = new Date(new Date().toLocaleString('en-US', { timeZone: 'Africa/Nairobi' }));
    const date    = nairobi.toISOString().slice(0, 10).replace(/-/g, '');
    const dateStr = nairobi.toISOString().slice(0, 10);

    /* Yesterday's date window */
    const dayStart = new Date(dateStr);
    const dayEnd   = new Date(dayStart.getTime() + 86400000);
    const tsStart  = admin.firestore.Timestamp.fromDate(dayStart);
    const tsEnd    = admin.firestore.Timestamp.fromDate(dayEnd);

    /* Fetch ledger entries for yesterday */
    const ledgerSnap = await db.collection('ledger')
      .where('createdAt', '>=', tsStart).where('createdAt', '<', tsEnd).get().catch(() => null);
    const entries = ledgerSnap ? ledgerSnap.docs.map(d => d.data()) : [];

    const aggregate = (type) => entries.filter(e => e.type === type).reduce((s, e) => s + (e.amountCents || 0), 0);

    const snapshot = {
      date, dateStr,
      totalRevenueCents:       aggregate('payment_received'),
      commissionCents:         aggregate('commission'),
      sellerEarningsCents:     aggregate('seller_earning'),
      riderEarningsCents:      entries.filter(e => e.type === 'delivery_fee' || e.type === 'tip').reduce((s, e) => s + (e.amountCents || 0), 0),
      refundsCents:            aggregate('refund'),
      payoutsCents:            aggregate('payout_settled'),
      subscriptionRevCents:    aggregate('subscription'),
      adRevenueCents:          aggregate('advertising'),
      vatCollectedCents:       entries.filter(e => e.type === 'tax' && e.metadata?.taxType === 'VAT').reduce((s, e) => s + (e.amountCents || 0), 0),
      whtCollectedCents:       entries.filter(e => e.type === 'tax' && e.metadata?.taxType === 'WHT').reduce((s, e) => s + (e.amountCents || 0), 0),
      promotionsCents:         aggregate('promotion'),
      transactionCount:        entries.filter(e => e.type === 'payment_received').length,
      refundCount:             entries.filter(e => e.type === 'refund').length,
      payoutCount:             entries.filter(e => e.type === 'payout_settled').length,
      generatedAt:             _now(),
    };
    snapshot.netRevenueCents  = snapshot.commissionCents + snapshot.subscriptionRevCents + snapshot.adRevenueCents;
    snapshot.grossProfitCents = snapshot.netRevenueCents - snapshot.refundsCents;

    await db.collection('finosSnapshots').doc(`snapshot_${date}`).set(snapshot, { merge: false });
    logger.info('[finos] Daily snapshot generated', { date, revenueCents: snapshot.totalRevenueCents });
  }
);

/* ─────────────────────────────────────────────────────────────
   11. reconcileLedger — scheduled daily 01:30 EAT
   Checks that all ledger entries net to zero (balanced books).
──────────────────────────────────────────────────────────────*/
exports.reconcileLedger = onSchedule(
  { schedule: '30 22 * * *', timeZone: 'UTC', region: REGION, timeoutSeconds: 300, memory: '256MiB' },
  async () => {
    const db   = _db();
    const snap = await db.collection('ledger').where('status', '==', 'settled').get().catch(() => null);
    if (!snap) return;

    const balances = {};
    snap.docs.forEach(d => {
      const e = d.data();
      balances[e.debitAccount]  = (balances[e.debitAccount]  || 0) - e.amountCents;
      balances[e.creditAccount] = (balances[e.creditAccount] || 0) + e.amountCents;
    });

    const totalNet = Object.values(balances).reduce((s, v) => s + v, 0);
    const balanced = totalNet === 0;

    await db.collection('finosSnapshots').doc('ledger_reconciliation').set({
      balances, totalNet, balanced, lastChecked: _now(), entryCount: snap.size,
    }, { merge: true });

    if (!balanced) {
      logger.error('[finos] LEDGER IMBALANCE DETECTED', { totalNet, entryCount: snap.size });
      await db.collection('fraudAlerts').add({
        type: 'financial', subType: 'ledger_imbalance',
        severity: 'critical', status: 'open', totalNet, createdAt: _now(),
        detail: `Ledger net = ${totalNet} (should be 0)`,
      }).catch(() => {});
    } else {
      logger.info('[finos] Ledger balanced', { entryCount: snap.size });
    }
  }
);

/* ─────────────────────────────────────────────────────────────
   12. getFinancialReport — callable
   Returns aggregated report for a date range.
──────────────────────────────────────────────────────────────*/
exports.getFinancialReport = onCall(
  { region: REGION, timeoutSeconds: 120, memory: '512MiB', invoker: 'private', enforceAppCheck: true },
  async (request) => {
    _assertAdmin(request);
    const { startDate, endDate, entityId, entityType } = request.data;
    if (!startDate || !endDate) throw new HttpsError('invalid-argument', 'startDate and endDate required (YYYY-MM-DD)');

    const db   = _db();
    const tsStart = admin.firestore.Timestamp.fromDate(new Date(startDate));
    const tsEnd   = admin.firestore.Timestamp.fromDate(new Date(new Date(endDate).getTime() + 86400000));

    /* Load snapshots in range */
    const snapshotSnap = await db.collection('finosSnapshots')
      .where('dateStr', '>=', startDate).where('dateStr', '<=', endDate).get().catch(() => null);
    const snapshots    = snapshotSnap ? snapshotSnap.docs.map(d => d.data()) : [];

    const sumField = (f) => snapshots.reduce((s, sn) => s + (sn[f] || 0), 0);

    const report = {
      period: { startDate, endDate, days: snapshots.length },
      revenue: {
        totalCents:        sumField('totalRevenueCents'),
        commissionCents:   sumField('commissionCents'),
        subscriptionCents: sumField('subscriptionRevCents'),
        advertisingCents:  sumField('adRevenueCents'),
        netRevenueCents:   sumField('netRevenueCents'),
        grossProfitCents:  sumField('grossProfitCents'),
      },
      payouts: {
        sellerEarningsCents: sumField('sellerEarningsCents'),
        riderEarningsCents:  sumField('riderEarningsCents'),
        payoutsCents:        sumField('payoutsCents'),
        payoutCount:         sumField('payoutCount'),
      },
      refunds: {
        refundsCents: sumField('refundsCents'),
        refundCount:  sumField('refundCount'),
        refundRatePct: snapshots.length > 0 ? Math.round(sumField('refundsCents') / Math.max(sumField('totalRevenueCents'), 1) * 100) : 0,
      },
      tax: {
        vatCollectedCents: sumField('vatCollectedCents'),
        whtCollectedCents: sumField('whtCollectedCents'),
        promotionsCents:   sumField('promotionsCents'),
      },
      activity: {
        transactionCount: sumField('transactionCount'),
        dailyBreakdown:   snapshots.map(sn => ({
          date:         sn.dateStr,
          revenueCents: sn.totalRevenueCents,
          profitCents:  sn.grossProfitCents,
          transactions: sn.transactionCount,
        })).sort((a, b) => a.date.localeCompare(b.date)),
      },
    };

    logger.info('[finos] Financial report generated', { startDate, endDate });
    return report;
  }
);

/* ─────────────────────────────────────────────────────────────
   13. getAIFinancialInsights — callable
   Uses Claude claude-haiku-4-5 to analyse snapshots and return structured insights.
──────────────────────────────────────────────────────────────*/
exports.getAIFinancialInsights = onCall(
  { region: REGION, timeoutSeconds: 120, memory: '512MiB', invoker: 'private',
    enforceAppCheck: true, secrets: [ANTHROPIC_API_KEY] },
  async (request) => {
    _assertAdmin(request);
    const db = _db();

    /* Load last 30 days of snapshots */
    const cutoff = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const snap   = await db.collection('finosSnapshots')
      .where('dateStr', '>=', cutoff).get().catch(() => null);
    const snapshots = snap ? snap.docs.map(d => d.data()).sort((a,b) => a.dateStr?.localeCompare(b.dateStr)) : [];

    /* Open fraud alerts */
    const fraudSnap = await db.collection('fraudAlerts').where('status', '==', 'open').get().catch(() => null);
    const openAlerts = fraudSnap ? fraudSnap.size : 0;

    /* Wallet for platform master */
    const masterWallet = await U.getOrInitWallet(db, 'platform_master', 'platform');

    const summary = {
      period:               '30 days',
      snapshotsCount:       snapshots.length,
      totalRevenue:         `KES ${(snapshots.reduce((s, sn) => s + (sn.totalRevenueCents || 0), 0) / 100).toFixed(0)}`,
      totalCommission:      `KES ${(snapshots.reduce((s, sn) => s + (sn.commissionCents || 0), 0) / 100).toFixed(0)}`,
      totalRefunds:         `KES ${(snapshots.reduce((s, sn) => s + (sn.refundsCents || 0), 0) / 100).toFixed(0)}`,
      totalPayouts:         `KES ${(snapshots.reduce((s, sn) => s + (sn.payoutsCents || 0), 0) / 100).toFixed(0)}`,
      totalSubscriptions:   `KES ${(snapshots.reduce((s, sn) => s + (sn.subscriptionRevCents || 0), 0) / 100).toFixed(0)}`,
      totalAds:             `KES ${(snapshots.reduce((s, sn) => s + (sn.adRevenueCents || 0), 0) / 100).toFixed(0)}`,
      openFraudAlerts:      openAlerts,
      platformBalance:      `KES ${((masterWallet.availableBalance || 0) / 100).toFixed(0)}`,
      dailyTrend:           snapshots.slice(-7).map(sn => ({ date: sn.dateStr, revenue: `KES ${((sn.totalRevenueCents || 0) / 100).toFixed(0)}`, profit: `KES ${((sn.grossProfitCents || 0) / 100).toFixed(0)}` })),
    };

    const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY.value() });
    const response  = await anthropic.messages.create({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      messages:   [{
        role:    'user',
        content: `You are the AI financial analyst for SOKONI, a Kenyan marketplace platform. Analyse this 30-day financial summary and provide concise, actionable insights for the platform operators.

Financial Data:
${JSON.stringify(summary, null, 2)}

Return a JSON object with these exact fields:
{
  "healthScore": <number 0-100>,
  "healthLabel": "<Excellent|Good|Fair|Poor|Critical>",
  "summary": "<2-3 sentence executive summary>",
  "insights": [<up to 5 string insights>],
  "risks": [<up to 3 string risk observations>],
  "recommendations": [<up to 4 actionable string recommendations>],
  "cashFlowForecast": "<brief 7-day cash flow outlook>"
}`,
      }],
    });

    let insights;
    try {
      const text = response.content[0]?.text || '{}';
      const json = text.match(/\{[\s\S]*\}/)?.[0] || '{}';
      insights = JSON.parse(json);
    } catch {
      insights = { healthScore: 0, healthLabel: 'Unknown', summary: 'AI analysis unavailable', insights: [], risks: [], recommendations: [] };
    }

    logger.info('[finos] AI insights generated');
    return { insights, summary };
  }
);

/* ─────────────────────────────────────────────────────────────
   14. webhookPaymentCallback — onRequest (IntaSend webhook)
   Handles IntaSend payment confirmation webhooks.
──────────────────────────────────────────────────────────────*/
exports.webhookPaymentCallback = onRequest(
  { region: REGION, timeoutSeconds: 30, memory: '128MiB', secrets: [INTASEND_PRIV] },
  async (req, res) => {
    if (req.method !== 'POST') { res.status(405).send('Method Not Allowed'); return; }

    /* HMAC-SHA256 signature validation — IntaSend sends X-IntaSend-Signature header */
    const sig = req.headers['x-intasend-signature'] || req.headers['x-is-signature'] || '';
    try {
      const privKey  = INTASEND_PRIV.value();
      const rawBody  = req.rawBody || Buffer.from(JSON.stringify(req.body));
      const expected = crypto.createHmac('sha256', privKey).update(rawBody).digest('hex');
      const sigBuf   = Buffer.from(sig.length === expected.length ? sig : '0'.repeat(expected.length), 'hex');
      const expBuf   = Buffer.from(expected, 'hex');
      if (!crypto.timingSafeEqual(sigBuf, expBuf)) {
        logger.warn('[finos] webhookPaymentCallback: invalid HMAC', { sigPrefix: sig.slice(0, 8) });
        res.status(401).json({ error: 'Invalid signature' });
        return;
      }
    } catch (hmacErr) {
      logger.error('[finos] webhookPaymentCallback: HMAC check failed', { error: hmacErr.message });
      res.status(500).json({ error: 'Signature verification error' });
      return;
    }

    const payload   = req.body;
    const invoiceId = payload?.invoice?.invoice_id || payload?.tracking_id;
    const state     = payload?.invoice?.state || payload?.state;
    const amountKES = parseFloat(payload?.invoice?.net_amount || payload?.amount || 0);

    if (!invoiceId || !amountKES) { res.status(400).json({ error: 'Invalid payload' }); return; }
    if (state !== 'COMPLETE') { res.status(200).json({ received: true, ignored: true }); return; }

    const db = _db();
    /* Find order by IntaSend checkout ID */
    const orderSnap = await db.collection('packageRequests')
      .where('intasendCheckoutId', '==', invoiceId).get().catch(() => null);

    if (!orderSnap || orderSnap.empty) {
      logger.warn('[finos] Webhook: no order found for invoice', { invoiceId });
      res.status(200).json({ received: true, orderNotFound: true });
      return;
    }

    const orderDoc = orderSnap.docs[0];
    const order    = orderDoc.data();
    const orderId  = orderDoc.id;

    const amountCents = Math.round(amountKES * 100);

    try {
      /* Trigger recordPayment logic inline */
      const comm = await U.calculateCommission(db, {
        orderAmountCents: amountCents, category: order.category || 'marketplace',
        sellerId: order.sellerId || order.shopOwnerId,
      });
      const vat = U.calculateVAT(comm.commissionCents, order.category || 'marketplace');

      await db.runTransaction(async (txn) => {
        // Read orderDoc inside the transaction so Firestore's conflict detection
        // can catch concurrent webhook deliveries for the same invoice
        const orderCheck = await txn.get(orderDoc.ref);
        if (!orderCheck.exists || orderCheck.data().financialProcessed) return;

        const sellerId = order.sellerId || order.shopOwnerId;
        if (sellerId) U.creditWalletTxn(txn, db, sellerId, 'seller', comm.sellerNetCents, { description: `Order ${orderId}`, orderId, type: 'order_earning' });
        U.creditWalletTxn(txn, db, 'platform_master', 'platform', comm.commissionCents, { description: `Commission ${orderId}`, orderId, type: 'commission' });
        txn.update(orderDoc.ref, { financialProcessed: true, commissionCents: comm.commissionCents, sellerNetCents: comm.sellerNetCents, vatCents: vat.taxCents, financialProcessedAt: admin.firestore.FieldValue.serverTimestamp() });
      });

      const ikey = U.generateIdempotencyKey(['webhook_payment', invoiceId]);
      await U.createLedgerEntry(db, {
        type: 'payment_received', amountCents,
        debitAccount: U.ACCOUNTS.EXTERNAL_GATEWAY, creditAccount: U.ACCOUNTS.PLATFORM_CLEARING,
        description: `IntaSend webhook payment ${invoiceId}`, orderId,
        sellerId: order.sellerId || order.shopOwnerId, metadata: { invoiceId, state },
        idempotencyKey: ikey,
      });

      logger.info('[finos] Webhook payment processed', { invoiceId, orderId, amountCents });
      res.status(200).json({ received: true, processed: true });
    } catch (e) {
      logger.error('[finos] Webhook processing failed', { invoiceId, error: e.message });
      res.status(500).json({ error: e.message });
    }
  }
);

/* ─────────────────────────────────────────────────────────────
   15. reverseTransaction — callable (admin)
   Emergency reversal of a specific ledger entry.
──────────────────────────────────────────────────────────────*/
exports.reverseTransaction = onCall(
  { region: REGION, timeoutSeconds: 30, memory: '128MiB', invoker: 'private', enforceAppCheck: true },
  async (request) => {
    _assertAdmin(request);
    const { ledgerId, reason } = request.data;
    if (!ledgerId || !reason) throw new HttpsError('invalid-argument', 'ledgerId and reason required');

    const result = await U.reverseLedgerEntry(_db(), ledgerId, { reason, adminUid: _uid(request) });
    await U.writeAuditLog(_db(), { action: 'transaction_reversed', entityId: ledgerId, entityType: 'ledger', after: { reason }, performedBy: _uid(request) });
    logger.warn('[finos] Transaction reversed', { ledgerId, reason, admin: _uid(request) });
    return result;
  }
);

/* ─────────────────────────────────────────────────────────────
   16. adjustWallet — callable (admin)
   Manual wallet adjustment with mandatory audit trail.
──────────────────────────────────────────────────────────────*/
exports.adjustWallet = onCall(
  { region: REGION, timeoutSeconds: 30, memory: '128MiB', invoker: 'private', enforceAppCheck: true },
  async (request) => {
    _assertAdmin(request);
    const { entityId, amountCents, direction, reason, entityType } = request.data;
    if (!entityId || !amountCents || !direction || !reason)
      throw new HttpsError('invalid-argument', 'entityId, amountCents, direction (credit|debit), and reason are required');
    if (!Number.isInteger(amountCents) || amountCents <= 0)
      throw new HttpsError('invalid-argument', 'amountCents must be a positive integer');

    const db     = _db();
    const wallet = await U.getOrInitWallet(db, entityId, entityType || 'seller');
    const ikey   = U.generateIdempotencyKey(['adjustment', entityId, String(amountCents), direction, String(Date.now())]);

    await db.runTransaction(async (txn) => {
      if (direction === 'credit') {
        U.creditWalletTxn(txn, db, entityId, entityType || 'seller', amountCents, { description: `Admin adjustment: ${reason}`, type: 'adjustment' });
      } else {
        await U.debitWalletTxn(txn, db, entityId, amountCents, { description: `Admin adjustment: ${reason}`, type: 'adjustment', allowNegative: true });
      }
    });

    await U.createLedgerEntry(db, {
      type: 'adjustment', amountCents,
      debitAccount:  direction === 'credit' ? U.ACCOUNTS.PLATFORM_REVENUE : U.ACCOUNTS.seller(entityId),
      creditAccount: direction === 'credit' ? U.ACCOUNTS.seller(entityId) : U.ACCOUNTS.PLATFORM_REVENUE,
      description:   `Admin adjustment (${direction}): ${reason}`,
      metadata: { entityId, direction, reason, adminUid: _uid(request), walletBefore: wallet.availableBalance || 0 },
      createdBy: _uid(request), idempotencyKey: ikey,
    });

    await U.writeAuditLog(db, {
      action: 'wallet_adjusted', entityId, entityType: entityType || 'seller',
      before: { balance: wallet.availableBalance }, after: { adjustmentCents: amountCents, direction },
      metadata: { reason }, performedBy: _uid(request),
    });

    logger.warn('[finos] Wallet adjusted', { entityId, amountCents, direction, admin: _uid(request) });
    return { status: 'adjusted', entityId, amountCents, direction };
  }
);

/* ─────────────────────────────────────────────────────────────
   17. getWalletStatement — callable
   Returns paginated wallet transaction history.
──────────────────────────────────────────────────────────────*/
exports.getWalletStatement = onCall(
  { region: REGION, timeoutSeconds: 30, memory: '128MiB', invoker: 'private', enforceAppCheck: true },
  async (request) => {
    _assertAuth(request);
    const uid     = _uid(request);
    const { entityId, limit: pageLimit, startAfter: cursor } = request.data;

    /* Sellers/riders read their own; admins can read anyone */
    const targetId = (request.auth?.token?.admin || request.auth?.token?.superAdmin) ? (entityId || uid) : uid;
    const pageSize = Math.min(pageLimit || 20, 50);

    const db     = _db();
    const wallet = await U.getOrInitWallet(db, targetId, 'unknown');

    let query = db.collection('wallets').doc(targetId).collection('transactions')
      .orderBy('createdAt', 'desc').limit(pageSize);
    if (cursor) query = query.startAfter(admin.firestore.Timestamp.fromMillis(cursor));

    const snap = await query.get();
    const transactions = snap.docs.map(d => ({ id: d.id, ...d.data() }));

    return {
      entityId:         targetId,
      availableBalance: wallet.availableBalance || 0,
      heldBalance:      wallet.heldBalance      || 0,
      lifetimeEarnings: wallet.lifetimeEarnings || 0,
      lifetimeWithdrawals: wallet.lifetimeWithdrawals || 0,
      currency:         'KES',
      transactions,
      hasMore:          snap.size === pageSize,
      nextCursor:       snap.size === pageSize ? snap.docs[snap.docs.length - 1].data().createdAt?.toMillis?.() : null,
    };
  }
);

/* ─────────────────────────────────────────────────────────────
   18. calculateTaxBreakdown — callable
   Returns full tax breakdown for a given order amount + category.
──────────────────────────────────────────────────────────────*/
exports.calculateTaxBreakdown = onCall(
  { region: REGION, timeoutSeconds: 10, memory: '128MiB', invoker: 'private', enforceAppCheck: true },
  async (request) => {
    _assertAuth(request);
    const { orderAmountCents, category, payoutAmountCents } = request.data;
    if (!orderAmountCents) throw new HttpsError('invalid-argument', 'orderAmountCents required');

    const db   = _db();
    const comm = await U.calculateCommission(db, { orderAmountCents, category: category || 'marketplace', sellerId: null });
    const vat  = U.calculateVAT(comm.commissionCents, category || 'marketplace');
    const wht  = payoutAmountCents ? U.calculateWHT(payoutAmountCents) : null;

    return {
      input: { orderAmountCents, category: category || 'marketplace' },
      commission: comm,
      vat,
      wht: wht || { note: 'WHT calculated at payout time' },
      summary: {
        buyerPays:       orderAmountCents,
        sellerReceives:  comm.sellerNetCents,
        platformGets:    comm.commissionCents - vat.taxCents,
        kraVAT:          vat.taxCents,
        kraWHT:          payoutAmountCents ? wht.whtCents : 'calculated at payout',
      },
    };
  }
);
