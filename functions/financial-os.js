/* ================================================================
   SOKONI Financial OS v1.0 — Unified Financial Operating System
   8 Cloud Functions filling the gaps in the existing 37 financial CFs.

   These CFs do NOT duplicate existing logic — they layer on top of it:
     fosInitiatePayment    — provider-agnostic STK push entry point
     fosSecureWebhook      — webhook with proper HMAC validation (replaces
                             the unvalidated webhookPaymentCallback)
     fosSubmitRefund       — creates a refund request (admin-approval queue)
     fosApproveRefund      — admin processes an approved refund
     fosGenerateInvoice    — produces a structured invoice record
     fosExportReport       — returns CSV-compatible financial export data
     fosGetProviderHealth  — health checks all registered payment providers
     fosGetAdminConsole    — single aggregated admin data call
================================================================ */
'use strict';

const { onCall, onRequest, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret }                  = require('firebase-functions/params');
const logger                             = require('firebase-functions/logger');
const admin                              = require('firebase-admin');
const { getAdapter, listAdapters }       = require('./payment-adapters');

const INTASEND_PRIVATE_KEY = defineSecret('INTASEND_PRIVATE_KEY');
const REGION               = 'us-central1';

const db  = () => admin.firestore();
const now = () => admin.firestore.FieldValue.serverTimestamp();
const ts  = (d) => admin.firestore.Timestamp.fromDate(new Date(d));

/* ── Auth helpers ── */
function _requireAuth(req) {
  if (!req.auth) throw new HttpsError('unauthenticated', 'Login required');
  return req.auth;
}
function _requireAdmin(req) {
  const auth = _requireAuth(req);
  if (!req.auth.token?.admin && !req.auth.token?.superAdmin)
    throw new HttpsError('permission-denied', 'Admin access required');
  return auth;
}

/* ── Audit writer ── */
async function _audit(action, actorUid, data) {
  try {
    await db().collection('finosAudit').add({
      action, actorUid, ...data, timestamp: now(),
    });
  } catch (_) {}
}

/* ── Notification ── */
async function _notify(uid, type, payload) {
  try {
    await db().collection('notifications').add({ uid, type, ...payload, read: false, createdAt: now() });
  } catch (_) {}
}

/* ════════════════════════════════════════════════════════════
   CF 1. fosInitiatePayment
   Provider-agnostic payment initiation. Any hub calls this
   instead of calling `initiateSTKPush` directly.

   Params:
     hubType, transactionType, sellerUid, amountKES,
     phone, ref?, provider='intasend', narrative?,
     metadata?: { orderId?, bookingId?, ... }
════════════════════════════════════════════════════════════ */
exports.fosInitiatePayment = onCall(
  {
    region:         REGION,
    timeoutSeconds: 60,
    memory:         '256MiB',
    secrets:        [INTASEND_PRIVATE_KEY],
  },
  async (req) => {
    const auth = _requireAuth(req);
    const uid  = auth.uid;
    const {
      hubType        = 'marketplace',
      transactionType = 'order',
      sellerUid,
      amountKES,
      phone,
      ref,
      provider       = 'intasend',
      narrative,
      metadata       = {},
    } = req.data || {};

    if (!sellerUid)  throw new HttpsError('invalid-argument', 'sellerUid required');
    if (!amountKES || amountKES <= 0) throw new HttpsError('invalid-argument', 'amountKES must be > 0');
    if (!phone)      throw new HttpsError('invalid-argument', 'phone required');
    if (amountKES > 500000) throw new HttpsError('invalid-argument', 'Amount exceeds KES 500,000 limit');

    /* Rate limit: max 3 payment initiations per user per minute */
    const rateLimitRef = db().collection('fosRateLimits').doc(`pay_init_${uid}`);
    const rlSnap = await rateLimitRef.get();
    const rlData = rlSnap.data() || {};
    const windowMs = 60000;
    if (rlData.count >= 3 && rlData.windowStart && (Date.now() - rlData.windowStart) < windowMs)
      throw new HttpsError('resource-exhausted', 'Too many payment requests. Wait a moment.');
    await rateLimitRef.set({
      count:       rlData.count && (Date.now() - (rlData.windowStart || 0)) < windowMs ? rlData.count + 1 : 1,
      windowStart: rlData.windowStart && (Date.now() - rlData.windowStart) < windowMs ? rlData.windowStart : Date.now(),
    });

    const payRef    = ref || `fos_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const amountCents = Math.round(amountKES * 100);

    /* Create pending transaction record */
    const txRef = db().collection('fosTransactions').doc();
    await txRef.set({
      buyerUid:        uid,
      sellerUid,
      hubType,
      transactionType,
      amountCents,
      commissionCents: 0,
      netCents:        amountCents,
      status:          'PENDING',
      provider,
      payRef,
      checkoutId:      null,
      metadata,
      createdAt:       now(),
      updatedAt:       now(),
    });

    /* Create payment shadow record (for backward compat with existing webhook handlers) */
    await db().collection('payments').doc(payRef).set({
      ref:       payRef,
      uid,
      sellerUid,
      amount:    amountKES,
      currency:  'KES',
      status:    'PENDING',
      provider,
      fosTransactionId: txRef.id,
      meta:      { hubType, transactionType, ...metadata },
      createdAt: now(),
      updatedAt: now(),
    });

    /* Initiate payment via adapter */
    const privateKey = INTASEND_PRIVATE_KEY.value();
    const sandbox    = process.env.INTASEND_SANDBOX === 'true';
    const adapter    = getAdapter(provider, { key: privateKey, sandbox });
    const result     = await adapter.initiatePayment({ phone, amountKES, ref: payRef, narrative });

    if (!result.success) {
      await txRef.update({ status: 'INITIATION_FAILED', updatedAt: now() });
      await db().collection('payments').doc(payRef).update({ status: 'FAILED', updatedAt: now() });
      logger.error('[FOS] Payment initiation failed', { payRef, error: result.error });
      throw new HttpsError('internal', result.error || 'Payment initiation failed');
    }

    /* Update with checkout ID from provider */
    await txRef.update({ checkoutId: result.checkoutId, updatedAt: now() });
    await db().collection('payments').doc(payRef).update({ checkoutId: result.checkoutId, updatedAt: now() });

    await _audit('payment_initiated', uid, {
      fosTransactionId: txRef.id,
      payRef,
      amountKES,
      provider,
      hubType,
    });

    logger.info('[FOS] Payment initiated', { txId: txRef.id, payRef, amountKES, provider });

    return {
      fosTransactionId: txRef.id,
      payRef,
      checkoutId: result.checkoutId,
      status:     'PENDING',
    };
  }
);

/* ════════════════════════════════════════════════════════════
   CF 2. fosSecureWebhook
   Provider-agnostic webhook with proper HMAC-SHA256 validation.
   Replaces the unvalidated webhookPaymentCallback in finos.js.
   Route: POST /fosSecureWebhook?provider=intasend
════════════════════════════════════════════════════════════ */
exports.fosSecureWebhook = onRequest(
  {
    region:         REGION,
    timeoutSeconds: 30,
    memory:         '256MiB',
    secrets:        [INTASEND_PRIVATE_KEY],
  },
  async (req, res) => {
    if (req.method !== 'POST') { res.status(405).send('Method not allowed'); return; }

    const provider  = (req.query.provider || req.body?.provider || 'intasend').toLowerCase();
    const rawBody   = req.rawBody || Buffer.from(JSON.stringify(req.body));
    const signature = req.headers['x-intasend-signature'] || req.headers['x-signature'] || '';
    const secret    = INTASEND_PRIVATE_KEY.value();

    /* Signature validation */
    const adapter = getAdapter(provider, { key: secret });
    if (!adapter.verifyWebhookSignature(rawBody, signature, secret)) {
      logger.warn('[FOS/webhook] Invalid signature', { provider, ip: req.ip });
      res.status(401).json({ error: 'Invalid signature' });
      return;
    }

    const body = req.body;

    /* Parse IntaSend payload */
    const invoiceState = body?.invoice?.state || body?.state;
    const apiRef       = body?.invoice?.api_ref || body?.api_ref;
    const checkoutId   = body?.invoice?.invoice_id || body?.invoice_id;
    const netAmount    = parseFloat(body?.invoice?.net_amount || body?.net_amount || '0');

    if (!apiRef) { res.status(400).json({ error: 'Missing api_ref' }); return; }

    /* Idempotency */
    const idKey   = `webhook_${provider}_${apiRef}`;
    const idSnap  = await db().collection('finosIdempotency').doc(idKey).get();
    if (idSnap.exists) { res.status(200).json({ status: 'duplicate_skipped' }); return; }

    if (invoiceState === 'COMPLETE' && netAmount > 0) {
      /* Update payment record */
      const paySnap = await db().collection('payments').doc(apiRef).get();
      if (paySnap.exists) {
        await paySnap.ref.update({ status: 'COMPLETE', checkoutId, updatedAt: now() });

        /* If linked to a fosTransaction, complete it */
        const payData = paySnap.data();
        if (payData.fosTransactionId) {
          await _processFOSTransaction(payData.fosTransactionId, {
            payRef: apiRef, netAmount, provider, checkoutId,
          }).catch(err => logger.error('[FOS/webhook] processFOSTransaction error', { err: err.message }));
        }
      }

      /* Record idempotency */
      await db().collection('finosIdempotency').doc(idKey).set({
        idKey, apiRef, provider, processedAt: now(),
      });

      logger.info('[FOS/webhook] Payment processed', { apiRef, netAmount, provider });
    }

    res.status(200).json({ status: 'ok' });
  }
);

/* Internal: complete a fosTransaction after payment confirmed */
async function _processFOSTransaction(txId, { payRef, netAmount, provider, checkoutId }) {
  const fsdb  = db();
  const txRef = fsdb.collection('fosTransactions').doc(txId);
  const txSnap = await txRef.get();
  if (!txSnap.exists) return;

  const tx = txSnap.data();
  if (tx.status === 'COMPLETED') return; /* Already processed */

  /* Calculate commission via existing finos-utils */
  let commissionCents = 0;
  try {
    const { calculateCommission } = require('./finos-utils');
    const result = await calculateCommission({
      orderAmountCents: tx.amountCents,
      category:         tx.hubType,
      sellerId:         tx.sellerUid,
    });
    commissionCents = result.commissionCents || 0;
  } catch (_) {}

  const netCents = tx.amountCents - commissionCents;

  await fsdb.runTransaction(async (txn) => {
    /* Update fosTransaction */
    txn.update(txRef, {
      status:          'COMPLETED',
      commissionCents,
      netCents,
      checkoutId:      checkoutId || tx.checkoutId,
      completedAt:     now(),
      updatedAt:       now(),
    });

    /* Credit seller wallet */
    const walletRef = fsdb.collection('wallets').doc(tx.sellerUid);
    txn.set(walletRef, {
      availableCents: admin.firestore.FieldValue.increment(netCents),
      lifetimeCents:  admin.firestore.FieldValue.increment(netCents),
      updatedAt:      now(),
    }, { merge: true });

    /* Credit platform commission wallet */
    const platformRef = fsdb.collection('wallets').doc('__platform__');
    txn.set(platformRef, {
      availableCents: admin.firestore.FieldValue.increment(commissionCents),
      lifetimeCents:  admin.firestore.FieldValue.increment(commissionCents),
      updatedAt:      now(),
    }, { merge: true });
  });

  /* Notify buyer and seller */
  await _notify(tx.buyerUid, 'payment_confirmed', {
    title: 'Payment confirmed',
    body:  `Your payment of KES ${(tx.amountCents / 100).toLocaleString()} was received.`,
    payRef,
  });

  await _audit('transaction_completed', tx.buyerUid, {
    fosTransactionId: txId, payRef, amountCents: tx.amountCents, commissionCents, netCents,
  });
}

/* ════════════════════════════════════════════════════════════
   CF 3. fosSubmitRefund
   Any admin or authorized user creates a refund request.
   Refund goes into a queue (fosRefundQueue) pending admin
   approval unless auto_approve conditions are met.
════════════════════════════════════════════════════════════ */
exports.fosSubmitRefund = onCall(
  {
    region:         REGION,
    timeoutSeconds: 30,
    memory:         '256MiB',
  },
  async (req) => {
    const auth = _requireAuth(req);
    const {
      fosTransactionId,
      payRef,
      amountKES,
      reason,
      refundType = 'full',
    } = req.data || {};

    if (!fosTransactionId && !payRef)
      throw new HttpsError('invalid-argument', 'fosTransactionId or payRef required');
    if (!amountKES || amountKES <= 0)
      throw new HttpsError('invalid-argument', 'amountKES must be > 0');
    if (!reason)
      throw new HttpsError('invalid-argument', 'reason required');

    const isAdmin = req.auth.token?.admin || req.auth.token?.superAdmin;
    const amountCents = Math.round(amountKES * 100);

    /* Look up transaction */
    let tx = null;
    let txId = fosTransactionId;
    if (fosTransactionId) {
      const snap = await db().collection('fosTransactions').doc(fosTransactionId).get();
      if (!snap.exists) throw new HttpsError('not-found', 'Transaction not found');
      tx   = snap.data();
      txId = snap.id;
    } else {
      const snap = await db().collection('payments').doc(payRef).get();
      if (!snap.exists) throw new HttpsError('not-found', 'Payment record not found');
      const pd = snap.data();
      txId = pd.fosTransactionId || payRef;
      tx   = pd;
    }

    if (!isAdmin && tx.buyerUid !== auth.uid)
      throw new HttpsError('permission-denied', 'Not authorized to refund this transaction');

    /* Auto-approve for admins or small amounts (<= KES 500) */
    const autoApprove = isAdmin || amountKES <= 500;
    const status      = autoApprove ? 'approved' : 'pending';

    const refundRef = await db().collection('fosRefundQueue').add({
      fosTransactionId: txId,
      payRef:           tx.payRef || payRef,
      buyerUid:         tx.buyerUid || auth.uid,
      sellerUid:        tx.sellerUid || tx.uid || null,
      amountKES,
      amountCents,
      reason,
      refundType,
      provider:         tx.provider || 'intasend',
      status,
      requestedBy:      auth.uid,
      approvedBy:       autoApprove ? auth.uid : null,
      createdAt:        now(),
      updatedAt:        now(),
    });

    await _audit('refund_submitted', auth.uid, {
      refundId: refundRef.id, fosTransactionId: txId, amountKES, reason, autoApprove,
    });

    if (!autoApprove) {
      return { refundId: refundRef.id, status: 'pending', message: 'Refund submitted for admin review.' };
    }

    /* Auto-approve flow: return refundId for fosApproveRefund to process */
    return { refundId: refundRef.id, status: 'approved', autoApprove: true };
  }
);

/* ════════════════════════════════════════════════════════════
   CF 4. fosApproveRefund
   Admin approves a pending refund and processes it immediately.
════════════════════════════════════════════════════════════ */
exports.fosApproveRefund = onCall(
  {
    region:         REGION,
    timeoutSeconds: 60,
    memory:         '256MiB',
    secrets:        [INTASEND_PRIVATE_KEY],
  },
  async (req) => {
    _requireAdmin(req);
    const { refundId, reject: doReject = false, rejectReason } = req.data || {};
    if (!refundId) throw new HttpsError('invalid-argument', 'refundId required');

    const refSnap = await db().collection('fosRefundQueue').doc(refundId).get();
    if (!refSnap.exists) throw new HttpsError('not-found', 'Refund request not found');
    const refund = refSnap.data();

    if (refund.status === 'processed' || refund.status === 'rejected')
      throw new HttpsError('failed-precondition', `Refund already ${refund.status}`);

    if (doReject) {
      await refSnap.ref.update({ status: 'rejected', rejectReason, updatedAt: now() });
      await _notify(refund.buyerUid, 'refund_rejected', {
        title: 'Refund request declined',
        body:  rejectReason || 'Your refund request was reviewed and declined.',
      });
      return { status: 'rejected' };
    }

    /* Process via adapter */
    const privateKey = INTASEND_PRIVATE_KEY.value();
    const adapter    = getAdapter(refund.provider || 'intasend', { key: privateKey });
    const result     = await adapter.initiateRefund({
      originalRef: refund.payRef,
      amountKES:   refund.amountKES,
      reason:      refund.reason,
    });

    if (!result.success) {
      logger.error('[FOS/refund] Adapter refund failed', { refundId, error: result.error });
      await refSnap.ref.update({ status: 'failed', error: result.error, updatedAt: now() });
      throw new HttpsError('internal', `Refund failed: ${result.error}`);
    }

    const fsdb = db();
    await fsdb.runTransaction(async (txn) => {
      /* Update refund queue record */
      txn.update(refSnap.ref, {
        status:     'processed',
        refundId:   result.refundId,
        processedAt: now(),
        updatedAt:  now(),
        approvedBy: req.auth.uid,
      });

      /* Clawback from seller wallet */
      if (refund.sellerUid) {
        const walletRef = fsdb.collection('wallets').doc(refund.sellerUid);
        txn.set(walletRef, {
          availableCents: admin.firestore.FieldValue.increment(-refund.amountCents),
          refundedCents:  admin.firestore.FieldValue.increment(refund.amountCents),
          updatedAt:      now(),
        }, { merge: true });
      }

      /* Update fosTransaction if linked */
      if (refund.fosTransactionId) {
        const txRef = fsdb.collection('fosTransactions').doc(refund.fosTransactionId);
        txn.update(txRef, {
          status:        refund.refundType === 'full' ? 'REFUNDED' : 'PARTIALLY_REFUNDED',
          refundedCents: admin.firestore.FieldValue.increment(refund.amountCents),
          refundedAt:    now(),
          updatedAt:     now(),
        });
      }
    });

    await _notify(refund.buyerUid, 'refund_processed', {
      title: 'Refund processed ✓',
      body:  `KES ${refund.amountKES.toLocaleString()} refund has been initiated back to your M-PESA.`,
      amountKES: refund.amountKES,
    });

    await _audit('refund_approved', req.auth.uid, {
      refundId, amountKES: refund.amountKES, buyerUid: refund.buyerUid,
    });

    return { status: 'processed', providerRefundId: result.refundId };
  }
);

/* ════════════════════════════════════════════════════════════
   CF 5. fosGenerateInvoice
   Produces a structured invoice record from a completed transaction.
   Stored in fosInvoices/{invoiceId} and returned to the caller.
════════════════════════════════════════════════════════════ */
exports.fosGenerateInvoice = onCall(
  {
    region:         REGION,
    timeoutSeconds: 30,
    memory:         '256MiB',
  },
  async (req) => {
    const auth = _requireAuth(req);
    const { fosTransactionId, payRef } = req.data || {};
    if (!fosTransactionId && !payRef)
      throw new HttpsError('invalid-argument', 'fosTransactionId or payRef required');

    /* Fetch transaction */
    let tx = null, txId = fosTransactionId;
    if (fosTransactionId) {
      const snap = await db().collection('fosTransactions').doc(fosTransactionId).get();
      if (!snap.exists) throw new HttpsError('not-found', 'Transaction not found');
      tx = snap.data(); txId = snap.id;
    } else {
      const snap = await db().collection('payments').doc(payRef).get();
      if (!snap.exists) throw new HttpsError('not-found', 'Payment not found');
      tx = snap.data(); txId = payRef;
    }

    /* Access control */
    const isAdmin = req.auth.token?.admin || req.auth.token?.superAdmin;
    if (!isAdmin && tx.buyerUid !== auth.uid && tx.sellerUid !== auth.uid)
      throw new HttpsError('permission-denied', 'Access denied');

    /* Check for existing invoice */
    const existing = await db().collection('fosInvoices')
      .where('fosTransactionId', '==', txId).limit(1).get();
    if (!existing.empty) return { invoice: existing.docs[0].data(), id: existing.docs[0].id };

    /* Fetch buyer and seller names */
    const [buyerSnap, sellerSnap] = await Promise.all([
      db().collection('users').doc(tx.buyerUid || '').get().catch(() => null),
      db().collection('users').doc(tx.sellerUid || '').get().catch(() => null),
    ]);

    const invoiceNumber = `INV-${Date.now().toString(36).toUpperCase()}`;
    const invoiceDate   = new Date().toISOString().split('T')[0];

    const invoice = {
      invoiceNumber,
      invoiceDate,
      fosTransactionId: txId,
      payRef:           tx.payRef || payRef,
      hubType:          tx.hubType || 'marketplace',
      transactionType:  tx.transactionType || 'order',
      buyer: {
        uid:   tx.buyerUid,
        name:  buyerSnap?.data()?.displayName || buyerSnap?.data()?.name || 'Customer',
        email: buyerSnap?.data()?.email || '',
        phone: buyerSnap?.data()?.phoneNumber || '',
      },
      seller: {
        uid:     tx.sellerUid,
        name:    sellerSnap?.data()?.businessName || sellerSnap?.data()?.displayName || 'Seller',
        email:   sellerSnap?.data()?.email || '',
      },
      subtotalCents:     tx.amountCents || 0,
      commissionCents:   tx.commissionCents || 0,
      netCents:          tx.netCents || (tx.amountCents - (tx.commissionCents || 0)),
      currency:          'KES',
      status:            tx.status || 'COMPLETED',
      items:             tx.items || tx.metadata?.items || [],
      metadata:          tx.metadata || tx.meta || {},
      platform:          'SOKONI',
      websiteUrl:        'https://mysokoni.co.ke',
      createdAt:         now(),
    };

    const invRef = await db().collection('fosInvoices').add(invoice);
    return { invoice: { ...invoice, id: invRef.id }, id: invRef.id };
  }
);

/* ════════════════════════════════════════════════════════════
   CF 6. fosExportReport
   Returns paginated financial data in a CSV-compatible format.
   Admin only.
════════════════════════════════════════════════════════════ */
exports.fosExportReport = onCall(
  {
    region:         REGION,
    timeoutSeconds: 120,
    memory:         '512MiB',
  },
  async (req) => {
    _requireAdmin(req);
    const {
      reportType  = 'transactions',
      periodStart,
      periodEnd,
      hubType,
      pageSize    = 500,
      cursor,
    } = req.data || {};

    const maxRows  = 2000;
    const rowCount = Math.min(pageSize, maxRows);
    const fsdb     = db();
    const rows     = [];

    if (reportType === 'transactions') {
      let q = fsdb.collection('fosTransactions').orderBy('createdAt', 'desc').limit(rowCount);
      if (periodStart) q = q.where('createdAt', '>=', admin.firestore.Timestamp.fromDate(new Date(periodStart)));
      if (periodEnd)   q = q.where('createdAt', '<=', admin.firestore.Timestamp.fromDate(new Date(periodEnd)));
      if (hubType)     q = q.where('hubType', '==', hubType);
      if (cursor)      q = q.startAfter(await fsdb.collection('fosTransactions').doc(cursor).get());
      const snap = await q.get();
      snap.forEach(d => {
        const tx = d.data();
        rows.push({
          id:             d.id,
          date:           tx.createdAt?.toDate?.()?.toISOString() || '',
          hubType:        tx.hubType || '',
          type:           tx.transactionType || '',
          buyerUid:       tx.buyerUid || '',
          sellerUid:      tx.sellerUid || '',
          amountKES:      (tx.amountCents || 0) / 100,
          commissionKES:  (tx.commissionCents || 0) / 100,
          netKES:         (tx.netCents || 0) / 100,
          status:         tx.status || '',
          provider:       tx.provider || '',
          payRef:         tx.payRef || '',
        });
      });
      return { reportType, rows, count: rows.length, nextCursor: rows[rows.length - 1]?.id || null };
    }

    if (reportType === 'refunds') {
      let q = fsdb.collection('fosRefundQueue').orderBy('createdAt', 'desc').limit(rowCount);
      if (cursor) q = q.startAfter(await fsdb.collection('fosRefundQueue').doc(cursor).get());
      const snap = await q.get();
      snap.forEach(d => {
        const r = d.data();
        rows.push({
          id:        d.id,
          date:      r.createdAt?.toDate?.()?.toISOString() || '',
          buyerUid:  r.buyerUid || '',
          sellerUid: r.sellerUid || '',
          amountKES: r.amountKES || 0,
          reason:    r.reason || '',
          type:      r.refundType || '',
          status:    r.status || '',
          payRef:    r.payRef || '',
        });
      });
      return { reportType, rows, count: rows.length, nextCursor: rows[rows.length - 1]?.id || null };
    }

    if (reportType === 'wallets') {
      const snap = await fsdb.collection('wallets').orderBy('lifetimeCents', 'desc').limit(rowCount).get();
      snap.forEach(d => {
        const w = d.data();
        rows.push({
          uid:           d.id,
          availableKES:  (w.availableCents || 0) / 100,
          pendingKES:    (w.pendingCents   || 0) / 100,
          heldKES:       (w.heldCents      || 0) / 100,
          lifetimeKES:   (w.lifetimeCents  || 0) / 100,
          refundedKES:   (w.refundedCents  || 0) / 100,
        });
      });
      return { reportType, rows, count: rows.length };
    }

    throw new HttpsError('invalid-argument', `Unknown reportType: ${reportType}`);
  }
);

/* ════════════════════════════════════════════════════════════
   CF 7. fosGetProviderHealth
   Pings all registered payment providers and returns their
   health status. Admin only.
════════════════════════════════════════════════════════════ */
exports.fosGetProviderHealth = onCall(
  {
    region:         REGION,
    timeoutSeconds: 30,
    memory:         '128MiB',
    secrets:        [INTASEND_PRIVATE_KEY],
  },
  async (req) => {
    _requireAdmin(req);
    const adapters  = listAdapters();
    const privateKey = INTASEND_PRIVATE_KEY.value();
    const sandbox    = process.env.INTASEND_SANDBOX === 'true';

    const results = await Promise.all(
      adapters.map(async (name) => {
        try {
          const adapter = getAdapter(name, { key: privateKey, sandbox });
          return await adapter.healthCheck();
        } catch (e) {
          return { provider: name, healthy: false, error: e.message, latencyMs: 0 };
        }
      })
    );

    /* Recent payment failure rate from last 1 hour */
    const oneHourAgo = admin.firestore.Timestamp.fromDate(new Date(Date.now() - 3600000));
    const recentSnap = await db().collection('payments')
      .where('createdAt', '>=', oneHourAgo)
      .limit(200)
      .get();

    let totalRecent = 0, failedRecent = 0;
    recentSnap.forEach(d => {
      totalRecent++;
      if (d.data().status === 'FAILED') failedRecent++;
    });

    return {
      providers:   results,
      last1hStats: {
        total:       totalRecent,
        failed:      failedRecent,
        successRate: totalRecent > 0 ? Math.round((1 - failedRecent / totalRecent) * 100) : 100,
      },
      generatedAt: new Date().toISOString(),
    };
  }
);

/* ════════════════════════════════════════════════════════════
   CF 8. fosGetAdminConsole
   Single call that aggregates live financial KPIs, recent
   transactions, pending refunds, pending payouts, and
   provider health. Powers the fos-admin.html dashboard.
   Admin only.
════════════════════════════════════════════════════════════ */
exports.fosGetAdminConsole = onCall(
  {
    region:         REGION,
    timeoutSeconds: 60,
    memory:         '512MiB',
  },
  async (req) => {
    _requireAdmin(req);
    const fsdb = db();

    /* Date boundaries */
    const now_dt    = new Date();
    const todayStart = new Date(now_dt); todayStart.setHours(0, 0, 0, 0);
    const weekStart  = new Date(now_dt); weekStart.setDate(weekStart.getDate() - 7);
    const monthStart = new Date(now_dt); monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);

    /* Run all queries concurrently */
    const [
      todaySnap, weekSnap, pendingRefunds, pendingPayouts,
      openDisputes, recentTx, walletSnap,
    ] = await Promise.all([
      /* Today's completed fosTransactions */
      fsdb.collection('fosTransactions')
        .where('status', '==', 'COMPLETED')
        .where('createdAt', '>=', ts(todayStart))
        .limit(500)
        .get(),

      /* This week's completed */
      fsdb.collection('fosTransactions')
        .where('status', '==', 'COMPLETED')
        .where('createdAt', '>=', ts(weekStart))
        .limit(1000)
        .get(),

      /* Pending refunds */
      fsdb.collection('fosRefundQueue')
        .where('status', '==', 'pending')
        .orderBy('createdAt', 'desc')
        .limit(50)
        .get(),

      /* Pending payouts */
      fsdb.collection('payouts')
        .where('status', '==', 'pending')
        .orderBy('createdAt', 'desc')
        .limit(50)
        .get().catch(() => fsdb.collection('fosPayouts')
          .where('status', '==', 'pending')
          .limit(50).get()),

      /* Open disputes */
      fsdb.collection('escrows')
        .where('status', '==', 'disputed')
        .limit(50)
        .get().catch(() => ({ empty: true, docs: [] })),

      /* Recent 20 transactions */
      fsdb.collection('fosTransactions')
        .orderBy('createdAt', 'desc')
        .limit(20)
        .get(),

      /* Platform wallet */
      fsdb.collection('wallets').doc('__platform__').get().catch(() => null),
    ]);

    /* Aggregate today */
    let todayRevCents = 0, todayCommCents = 0, todayTxCount = 0;
    todaySnap.forEach(d => {
      const tx = d.data();
      todayRevCents  += tx.amountCents || 0;
      todayCommCents += tx.commissionCents || 0;
      todayTxCount++;
    });

    /* Aggregate week */
    let weekRevCents = 0, weekCommCents = 0, weekTxCount = 0;
    weekSnap.forEach(d => {
      const tx = d.data();
      weekRevCents  += tx.amountCents || 0;
      weekCommCents += tx.commissionCents || 0;
      weekTxCount++;
    });

    const kes = (c) => Math.round(c / 100);
    const platformWallet = walletSnap?.data() || {};

    return {
      kpis: {
        todayRevenueKES:     kes(todayRevCents),
        todayCommissionKES:  kes(todayCommCents),
        todayTransactions:   todayTxCount,
        weekRevenueKES:      kes(weekRevCents),
        weekCommissionKES:   kes(weekCommCents),
        weekTransactions:    weekTxCount,
        platformBalanceKES:  kes(platformWallet.availableCents || 0),
      },
      queues: {
        pendingRefunds:  pendingRefunds.size,
        pendingPayouts:  pendingPayouts.size,
        openDisputes:    openDisputes.docs?.length || 0,
      },
      pendingRefundsList: pendingRefunds.docs.map(d => ({
        id:         d.id,
        amountKES:  d.data().amountKES,
        reason:     d.data().reason,
        buyerUid:   d.data().buyerUid,
        createdAt:  d.data().createdAt?.toDate?.()?.toISOString() || '',
      })),
      recentTransactions: recentTx.docs.map(d => ({
        id:             d.id,
        hubType:        d.data().hubType,
        amountCents:    d.data().amountCents,
        commissionCents: d.data().commissionCents,
        status:         d.data().status,
        provider:       d.data().provider,
        payRef:         d.data().payRef,
        createdAt:      d.data().createdAt?.toDate?.()?.toISOString() || '',
      })),
      generatedAt: new Date().toISOString(),
    };
  }
);
