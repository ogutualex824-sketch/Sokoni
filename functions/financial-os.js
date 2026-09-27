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
/* The in-app notification feed. This writes the `notifications` collection DIRECTLY and
   does NOT go through notify.js — so it gets no preferences, no quiet hours, no dedupe and no
   audit row, and it sends no push, SMS or email. That is pre-existing behaviour and is NOT
   changed here.

   What IS added is the business ANCHOR, so these records can join the unified timeline. It is
   additive: a call site that has no anchor in scope passes none and the row records itself as
   unanchored, exactly as before. An anchor is read from the payload by the ONE shared
   resolver, which returns null rather than guessing — putting a real notification under the
   wrong business relationship is worse than leaving it unjoinable. */
const _ENV = require('./shared/communication-envelope');

async function _notify(uid, type, payload) {
  try {
    const a = _ENV.anchorFrom(payload || {});
    await db().collection('notifications').add({
      uid, type, ...payload, read: false, createdAt: now(),
      anchorType: a ? a.anchorType : null,
      anchorId: a ? a.anchorId : null,
      anchored: !!a,
    });
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
    region:          REGION,
    timeoutSeconds:  60,
    memory:          '256MiB',
    enforceAppCheck: true,
    secrets:         [INTASEND_PRIVATE_KEY],
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

    /* Generate stable payRef before any async work — avoids re-generation on transaction retries */
    const payRef    = ref || `fos_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

    /* Rate limit + optional idempotency — both inside a transaction to prevent TOCTOU races */
    const rateLimitRef = db().collection('fosRateLimits').doc(`pay_init_${uid}`);
    const idemRef      = ref ? db().collection('fosPaymentIdempotency').doc(payRef) : null;
    let isReplay = false; let replayData = null;

    await db().runTransaction(async (txn) => {
      /* 1. Idempotency check — only when caller supplied an explicit ref */
      if (idemRef) {
        const idemSnap = await txn.get(idemRef);
        if (idemSnap.exists) { isReplay = true; replayData = idemSnap.data(); return; }
      }
      /* 2. Rate-limit check (read inside tx prevents concurrent bypass) */
      const rlSnap = await txn.get(rateLimitRef);
      const rlData = rlSnap.data() || {};
      const windowMs = 60000;
      const nowMs    = Date.now();
      const inWindow = rlData.windowStart && (nowMs - rlData.windowStart) < windowMs;
      if (rlData.count >= 3 && inWindow)
        throw new HttpsError('resource-exhausted', 'Too many payment requests. Wait a moment.');
      /* 3. Increment rate-limit counter atomically */
      txn.set(rateLimitRef, {
        count:       inWindow ? rlData.count + 1 : 1,
        windowStart: inWindow ? rlData.windowStart : nowMs,
      });
      /* 4. Mark idempotency key consumed */
      if (idemRef) txn.set(idemRef, { payRef, uid, createdAt: now() });
    });

    if (isReplay) return { payRef: replayData.payRef, idempotent: true };
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

    /* Idempotency — use create() for atomic "set-if-not-exists" so two concurrent
       webhook deliveries cannot both slip through the check before either writes */
    const idKey = `webhook_${provider}_${apiRef}`;
    const idRef = db().collection('finosIdempotency').doc(idKey);
    try {
      await idRef.create({ idKey, apiRef, provider, processedAt: now(), lockedAt: now() });
    } catch (lockErr) {
      if (lockErr.code === 6 || lockErr.message?.includes('ALREADY_EXISTS')) {
        res.status(200).json({ status: 'duplicate_skipped' });
        return;
      }
      throw lockErr;
    }

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

  /* Calculate commission via existing finos-utils.
   *
   * The `fsdb` first argument is NOT optional. It was missing here, and the consequences
   * were silent and total: calculateCommission(db, {opts}) bound `db` to the options
   * object, leaving `opts` undefined, so destructuring it threw a TypeError. The catch
   * below swallowed that, commissionCents stayed 0, and netCents became the FULL gross —
   * so every payment that completed through fosSecureWebhook credited the seller 100% and
   * the platform nothing. Not for legal only: for every hub on this code path.
   * Proven by calling the real function both ways: KES 5,000 legal consultation ->
   * commission KES 600 when db is passed, KES 0 when it is not.
   *
   * Commission failures must never be silent again — see the review-queue block below,
   * which now also refuses to settle rather than settling at zero. */
  let commissionCents = 0;
  let commissionFailed = false;
  let commissionRate = null;
  try {
    const { calculateCommission } = require('./finos-utils');
    const result = await calculateCommission(fsdb, {
      orderAmountCents: tx.amountCents,
      category:         tx.hubType,
      sellerId:         tx.sellerUid,
    });
    commissionCents = result.commissionCents || 0;
    commissionRate  = result.effectiveRate ?? null;
  } catch (commErr) {
    commissionFailed = true;
    console.error('[FOS] Commission calc failed — flagging for manual review', txId, commErr.message);
  }

  /* If the commission could not be computed, do NOT settle. Crediting the seller the full
     gross and "flagging for review" means the money is already gone by the time a human
     looks. Leave the transaction PENDING_REVIEW so it can be replayed once the cause is
     fixed — an unsettled payment is recoverable; an over-credited wallet is not. */
  if (commissionFailed) {
    await fsdb.collection('fosReviewQueue').add({
      type: 'commission_calc_failure',
      txId, payRef,
      hubType:    tx.hubType,
      sellerUid:  tx.sellerUid,
      amountCents: tx.amountCents,
      note: 'Settlement withheld — commission could not be computed. Nothing was credited.',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    await txRef.update({
      status: 'PENDING_REVIEW',
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    logger.error('[FOS] Settlement withheld, commission unavailable', { txId, payRef });
    return;
  }

  const netCents = tx.amountCents - commissionCents;

  await fsdb.runTransaction(async (txn) => {
    /* Update fosTransaction */
    txn.update(txRef, {
      status:          'COMPLETED',
      commissionCents,
      commissionRate,
      netCents,
      checkoutId:      checkoutId || tx.checkoutId,
      completedAt:     now(),
      updatedAt:       now(),
    });

    /* Mark the SOURCE document paid.
     *
     * Nothing on this path ever did. fosSecureWebhook updated `payments`, `fosTransactions`
     * and `wallets` — but the thing the user actually booked stayed `pending` forever, so a
     * paid legal consultation still looked unpaid to both the client and the advocate.
     * The link is metadata.consultationId, stamped at initiation. */
    const consultId = tx.metadata && tx.metadata.consultationId;
    if (consultId) {
      txn.set(fsdb.collection('legalConsultations').doc(consultId), {
        paymentStatus:  'paid',
        status:         'confirmed',
        paidAmountCents: tx.amountCents,
        payRef,
        paidAt:         now(),
        updatedAt:      now(),
      }, { merge: true });
    }

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
    fosTransactionId: txId, payRef, amountCents: tx.amountCents,
    commissionCents, commissionRate, netCents,
  });
  /* The old commission-failure review-queue write lived here, AFTER the wallets were
     already credited at zero commission. It is gone: the failure path now returns above,
     before any money moves. */
}

/* ════════════════════════════════════════════════════════════
   REFUND EXECUTION — exactly one provider call, exactly one local settlement.

   The defect this replaces (docs/CREATOR_HUB.md §Refund audit): after IntaSend
   had ACCEPTED a refund, any later exception (a transient Firestore failure in
   the finalize transaction, a missing fosTransactions doc) landed in a catch that
   set the request back to 'approved' — and fosApproveRefund would then send a
   SECOND refund. An unknown outcome (dropped connection, 5xx, timeout) was also
   treated as retryable, and the admin auto-approve path called the gateway
   without the 'processing' lock, so a concurrent approval could race it.

   State machine (fosRefundQueue.status):
     pending | approved | failed   EXECUTABLE — may take the lock
     processing (+executionId)     one execution in flight; never re-executable
     processed                     provider refunded AND local settlement done
     provider_succeeded            provider refunded, local settlement pending
     outcome_unknown               provider outcome NOT known — never retried
                                   automatically; fosResolveRefund with evidence
     rejected                      terminal
   Provider idempotency: IntaSend's chargeback call carries no idempotency key
   (none is documented for this account), so exactly-once is enforced HERE: one
   call per execution, and a retry is allowed ONLY after a definitive 4xx
   rejection that proves no refund happened.
════════════════════════════════════════════════════════════ */
const REFUND_EXECUTABLE = new Set(['pending', 'approved', 'failed']);
/* A definitive rejection: the provider answered and refused. 408/409/425/429
   are NOT proof that nothing happened. */
function _isDefinitiveRejection(httpStatus) {
  const s = Number(httpStatus);
  return Number.isInteger(s) && s >= 400 && s < 500 && ![408, 409, 425, 429].includes(s);
}

/* Patch the refund only if THIS execution still owns it. A failed write leaves
   'processing', which is not executable — the safe failure. */
async function _markRefundExecution(refundRef, executionId, patch) {
  try {
    await db().runTransaction(async (txn) => {
      const snap = await txn.get(refundRef);
      if (!snap.exists) return;
      const rd = snap.data();
      if (rd.status !== 'processing' || rd.executionId !== executionId) return;
      txn.update(refundRef, { ...patch, updatedAt: now() });
    });
  } catch (e) {
    logger.error('[FOS/refund] could not record execution outcome — request stays locked in processing', { refundId: refundRef.id, err: e.message });
  }
}

/* Local settlement, exactly once. Allowed from 'processing' owned by this
   execution, or — only via fosResolveRefund — from provider_succeeded /
   outcome_unknown. 'processed' is an idempotent no-op. */
async function _settleRefund(refundRef, { executionId = null, resolving = false, providerRefundId = null, actorUid = null, resolution = null } = {}) {
  const fsdb = db();
  try {
    return await fsdb.runTransaction(async (txn) => {
      const snap = await txn.get(refundRef);
      if (!snap.exists) throw new HttpsError('not-found', 'Refund request not found');
      const refund = snap.data();
      if (refund.status === 'processed') return { ok: true, already: true, refund };
      const owned = refund.status === 'processing' && executionId && refund.executionId === executionId;
      const resolvable = resolving && ['provider_succeeded', 'outcome_unknown', 'processing'].includes(refund.status);
      if (!owned && !resolvable) return { ok: false, refused: refund.status, refund };
      /* reads before writes */
      const txSnap = refund.fosTransactionId ? await txn.get(fsdb.collection('fosTransactions').doc(refund.fosTransactionId)) : null;
      txn.update(refundRef, {
        status: 'processed', refundId: providerRefundId || refund.providerRefundId || null,
        processedAt: now(), updatedAt: now(), approvedBy: actorUid || refund.approvedBy || null,
        ...(resolution ? { resolution } : {}),
      });
      if (refund.sellerUid) {
        txn.set(fsdb.collection('wallets').doc(refund.sellerUid), {
          availableCents: admin.firestore.FieldValue.increment(-refund.amountCents),
          refundedCents:  admin.firestore.FieldValue.increment(refund.amountCents),
          updatedAt:      now(),
        }, { merge: true });
      }
      if (txSnap && txSnap.exists) {
        txn.update(txSnap.ref, {
          status:        refund.refundType === 'full' ? 'REFUNDED' : 'PARTIALLY_REFUNDED',
          refundedCents: admin.firestore.FieldValue.increment(refund.amountCents),
          refundedAt:    now(),
          updatedAt:     now(),
        });
      }
      return { ok: true, refund };
    });
  } catch (e) {
    if (e instanceof HttpsError) throw e;
    logger.error('[FOS/refund] local settlement failed after provider success', { refundId: refundRef.id, err: e.message });
    return { ok: false, error: e.message };
  }
}

/* Notifications, audit and the Creator hook run AFTER settlement and can never
   change the refund's status — each is isolated. */
async function _afterRefundSettled(refundId, refund, actorUid, source) {
  try {
    await _notify(refund.buyerUid, 'refund_processed', {
      title: 'Refund processed ✓',
      body:  'KES ' + Number(refund.amountKES || 0).toLocaleString() + ' refund has been initiated back to your M-PESA.',
      amountKES: refund.amountKES,
    });
  } catch (e) { logger.warn('[FOS/refund] notify failed (refund stands)', { refundId, err: e.message }); }
  try { await _audit('refund_processed', actorUid, { refundId, amountKES: refund.amountKES, buyerUid: refund.buyerUid, source }); } catch (_) { /* audit is best-effort */ }
  if (refund.payRef) {
    try {
      /* No-op unless the payment is a Creator Hub film purchase; never throws. */
      await require('./creator-hub').onFilmRefundProcessed({ payRef: refund.payRef, refundId, amountCents: refund.amountCents, source });
    } catch (e) { logger.error('[FOS/refund] creator reversal hook failed (refund stands)', { refundId, err: e.message }); }
    try {
      /* No-op unless the payment is an event ticket (event-settlement.js). A full refund
         revokes the tickets and reverses the HELD settlement exactly once through the
         entitlement engine; a partial refund is recorded for AdminOS. Never throws here. */
      await require('./event-settlement').onEventRefundProcessed({ payRef: refund.payRef, refundId, amountCents: refund.amountCents, source });
    } catch (e) { logger.error('[FOS/refund] event reversal hook failed (refund stands)', { refundId, err: e.message }); }
  }
}

async function _executeRefund(refundId, actorUid, source) {
  const fsdb = db();
  const refundRef = fsdb.collection('fosRefundQueue').doc(refundId);
  const executionId = require('crypto').randomBytes(12).toString('hex');
  let refund;
  try {
    await fsdb.runTransaction(async (txn) => {
      const snap = await txn.get(refundRef);
      if (!snap.exists) throw new HttpsError('not-found', 'Refund request not found');
      const rd = snap.data();
      if (!REFUND_EXECUTABLE.has(rd.status)) {
        throw new HttpsError('failed-precondition', `Refund already ${rd.status} — it cannot be executed again`);
      }
      refund = rd;
      txn.update(refundRef, {
        status: 'processing', executionId, executionStartedAt: now(), approvedBy: actorUid,
        attempts: admin.firestore.FieldValue.increment(1), updatedAt: now(),
      });
    });
  } catch (e) {
    if (e instanceof HttpsError) throw e;
    throw new HttpsError('aborted', 'Concurrency conflict — please retry');
  }

  let result;
  try {
    const adapter = getAdapter(refund.provider || 'intasend', { key: INTASEND_PRIVATE_KEY.value() });
    result = await adapter.initiateRefund({ originalRef: refund.payRef, amountKES: refund.amountKES, reason: refund.reason });
  } catch (e) {
    logger.error('[FOS/refund] provider call threw — OUTCOME UNKNOWN', { refundId, executionId, err: e.message });
    await _markRefundExecution(refundRef, executionId, { status: 'outcome_unknown', outcomeError: String(e.message || e).slice(0, 300) });
    return { refundId, status: 'outcome_unknown', message: 'The provider did not confirm the outcome. Verify in IntaSend, then resolve — do not re-approve.' };
  }
  if (!result || !result.success) {
    const httpStatus = result ? result.httpStatus : null;
    if (_isDefinitiveRejection(httpStatus)) {
      await _markRefundExecution(refundRef, executionId, { status: 'failed', error: (result && result.error) || 'rejected', httpStatus });
      return { refundId, status: 'failed', error: (result && result.error) || 'rejected' };
    }
    logger.error('[FOS/refund] provider outcome not definitive — OUTCOME UNKNOWN', { refundId, executionId, httpStatus });
    await _markRefundExecution(refundRef, executionId, { status: 'outcome_unknown', outcomeError: String((result && result.error) || 'no response').slice(0, 300), httpStatus: httpStatus || null });
    return { refundId, status: 'outcome_unknown', message: 'The provider did not confirm the outcome. Verify in IntaSend, then resolve — do not re-approve.' };
  }

  const settled = await _settleRefund(refundRef, { executionId, providerRefundId: result.refundId, actorUid });
  if (!settled.ok) {
    await _markRefundExecution(refundRef, executionId, { status: 'provider_succeeded', providerRefundId: result.refundId || null });
    return { refundId, status: 'provider_succeeded', providerRefundId: result.refundId || null,
      message: 'Refunded by the provider; local settlement is pending — settle it with fosResolveRefund.' };
  }
  await _afterRefundSettled(refundId, settled.refund, actorUid, source);
  return { refundId, status: 'processed', providerRefundId: result.refundId };
}

/* ════════════════════════════════════════════════════════════
   CF 3. fosSubmitRefund
   Any admin or authorized user creates a refund request.
   Refund goes into a queue (fosRefundQueue) pending admin
   approval unless auto_approve conditions are met.
════════════════════════════════════════════════════════════ */
/* The submit handler is a named function so the Entertainment refund wizard (event-refunds.js)
   submits through EXACTLY this authority — the same buyer-owns-payment check, the same one-request-
   per-transaction id, the same admin-review queue. There is no second refund-request writer. */
async function _submitRefundHandler(req, opts = {}) {
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
      /* Creator Hub: a film purchase's payments doc has uid = the BUYER and no
         seller. Without this, sellerUid fell back to tx.uid (the buyer, whose
         wallet the finalize step would debit) and buyerUid to the caller (an
         admin). The creators' side is reversed by the royalty ledger in
         creator-hub.onFilmRefundProcessed — never by a wallet debit here. */
      const _fi = await db().collection('paymentIntents').doc(payRef).get();
      const _im = _fi.exists ? (_fi.data().metadata || {}) : {};
      /* Event tickets (2026-09-27 readiness sweep): a refund of an event_ticket payment enters ONLY
         through the Entertainment paths that price it — the buyer's refund wizard (eligibility,
         penalty, tickets suspended at the gate) or the AdminOS cancelled-event op (amount from the
         payment record). A direct fosSubmitRefund skipped all of that: the ticket stayed admissible
         while its refund was pending, and the pending queue doc held the organizer's settlement. */
      if (_fi.exists && _fi.data().purpose === 'event_ticket' && opts.via !== 'event_wizard' && opts.via !== 'event_admin') {
        throw new HttpsError('failed-precondition', 'Event ticket refunds are requested from the ticket (refund wizard), or by an administrator from AdminOS › Entertainment.');
      }
      if (_fi.exists && _fi.data().purpose === 'film_access') {
        tx = { ...pd, payRef, buyerUid: pd.uid, sellerUid: null, uid: null, creatorFilm: true,
               amountKES: Number(pd.amount) || null };
      } else {
        /* Any other payRef-only payment: payments.uid is the PAYER. It is the
           buyer, never the seller — debiting it would take the refund out of the
           buyer's own wallet. The seller comes from the server-minted intent
           (the same attribution the webhook credits); with no intent there is
           no seller to debit. */
        tx = { ...pd, payRef, buyerUid: pd.uid, uid: null,
               sellerUid: _im.sellerUid || _im.merchantUid || _im.providerId || null,
               amountKES: Number(pd.amount) || null };
      }
    }

    if (!isAdmin && tx.buyerUid !== auth.uid)
      throw new HttpsError('permission-denied', 'Not authorized to refund this transaction');

    /* Validate refund does not exceed the original payment amount */
    const originalAmountKES = tx.amountKES || (tx.amountCents ? tx.amountCents / 100 : null);
    if (originalAmountKES !== null && amountKES > originalAmountKES)
      throw new HttpsError('invalid-argument',
        `Refund (KES ${amountKES}) exceeds original payment (KES ${originalAmountKES})`);

    const autoApprove = isAdmin;
    const status      = autoApprove ? 'approved' : 'pending';

    /* Idempotency — deterministic doc ID (one per txId) prevents duplicate refunds under race conditions.
       The transaction guarantees the check-and-set is atomic; a collection query outside a tx cannot. */
    let isReplayRefund = false; let replayRefundData = null;
    const refundRef = db().collection('fosRefundQueue').doc('ref_' + txId);

    await db().runTransaction(async (txn) => {
      const snap = await txn.get(refundRef);
      if (snap.exists) { isReplayRefund = true; replayRefundData = snap.data(); return; }
      txn.set(refundRef, {
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
    });

    if (isReplayRefund) {
      return {
        refundId: refundRef.id,
        status:   replayRefundData.status,
        existing: true,
        message:  'A refund request for this transaction is already in progress.',
      };
    }

    await _audit('refund_submitted', auth.uid, {
      refundId: refundRef.id, fosTransactionId: txId, amountKES, reason, autoApprove,
    });

    if (!autoApprove) {
      return { refundId: refundRef.id, status: 'pending', message: 'Refund submitted for admin review.' };
    }

    /* Auto-approve: an admin submitted it — execute now, through the SAME locked
       execution as fosApproveRefund (no second, lock-free gateway path). */
    return _executeRefund(refundRef.id, auth.uid, 'fosSubmitRefund');
}

exports.fosSubmitRefund = onCall(
  {
    region:          REGION,
    timeoutSeconds:  60,
    memory:          '256MiB',
    enforceAppCheck: true,
    secrets:         [INTASEND_PRIVATE_KEY],
  },
  (req) => _submitRefundHandler(req),
);

/* ════════════════════════════════════════════════════════════
   CF 4. fosApproveRefund
   Admin approves a pending refund and processes it immediately.
════════════════════════════════════════════════════════════ */
exports.fosApproveRefund = onCall(
  {
    region:          REGION,
    timeoutSeconds:  60,
    memory:          '256MiB',
    enforceAppCheck: true,
    secrets:         [INTASEND_PRIVATE_KEY],
  },
  async (req) => {
    _requireAdmin(req);
    const { refundId, reject: doReject = false, rejectReason } = req.data || {};
    if (!refundId) throw new HttpsError('invalid-argument', 'refundId required');

    /* PAY-1 fix: atomically lock with status='processing' so concurrent admin calls
       cannot both pass the status check and fire the payment gateway twice. */
    let refund;
    const fsdb = db();

    if (doReject) {
      const refSnap = await fsdb.collection('fosRefundQueue').doc(refundId).get();
      if (!refSnap.exists) throw new HttpsError('not-found', 'Refund request not found');
      const rd = refSnap.data();
      if (rd.status === 'processed' || rd.status === 'rejected' || rd.status === 'processing') {
        throw new HttpsError('failed-precondition', `Refund already ${rd.status}`);
      }
      await refSnap.ref.update({ status: 'rejected', rejectReason, updatedAt: now() });
      /* An event ticket whose refund was declined returns to "no refund" — so it can be admitted again. */
      try { await require('./event-settlement').onEventRefundRejected({ payRef: rd.payRef, refundId, reason: rejectReason }); }
      catch (e) { logger.error('[FOS/refund] event reject hook failed (rejection stands)', { refundId, err: e.message }); }
      await _notify(rd.buyerUid, 'refund_rejected', {
        title: 'Refund request declined',
        body:  rejectReason || 'Your refund request was reviewed and declined.',
      });
      return { status: 'rejected' };
    }

    /* One locked execution (see _executeRefund): exactly one provider call, exactly
       one local settlement. A definitive provider rejection keeps the old contract
       (throws 'internal'); an unknown outcome is NOT an error to retry. */
    const out = await _executeRefund(refundId, req.auth.uid, 'fosApproveRefund');
    if (out.status === 'failed') throw new HttpsError('internal', `Refund failed: ${out.error}`);
    return out;
  }
);

/* ════════════════════════════════════════════════════════════
   CF 4b. fosResolveRefund
   Super admin, with evidence from the IntaSend dashboard, resolves a refund the
   system could not finish on its own:
     provider_succeeded → outcome 'refunded'     settle locally (once)
     outcome_unknown    → 'refunded'             settle locally (once)
                        → 'not_refunded'         back to 'failed' (executable)
     processing (stale, > 10 min, crashed run)   same as outcome_unknown
   Never calls the provider.
════════════════════════════════════════════════════════════ */
exports.fosResolveRefund = onCall(
  { region: REGION, timeoutSeconds: 60, memory: '256MiB', enforceAppCheck: true },
  async (req) => {
    _requireAuth(req);
    if (!req.auth.token?.superAdmin) throw new HttpsError('permission-denied', 'Super admin only');
    const { refundId, outcome, evidence, providerRefundId } = req.data || {};
    if (!refundId) throw new HttpsError('invalid-argument', 'refundId required');
    if (!['refunded', 'not_refunded'].includes(outcome)) throw new HttpsError('invalid-argument', "outcome must be 'refunded' or 'not_refunded'");
    const ev = String(evidence || '').trim();
    if (ev.length < 5) throw new HttpsError('invalid-argument', 'evidence (IntaSend reference) required');
    const fsdb = db();
    const refundRef = fsdb.collection('fosRefundQueue').doc(refundId);
    const snap = await refundRef.get();
    if (!snap.exists) throw new HttpsError('not-found', 'Refund request not found');
    const rd = snap.data();
    const startedMs = rd.executionStartedAt && rd.executionStartedAt.toMillis ? rd.executionStartedAt.toMillis() : 0;
    const staleProcessing = rd.status === 'processing' && startedMs && Date.now() - startedMs > 10 * 60 * 1000;
    if (!(rd.status === 'provider_succeeded' || rd.status === 'outcome_unknown' || staleProcessing)) {
      throw new HttpsError('failed-precondition', `Refund is ${rd.status} — nothing to resolve`);
    }
    const resolution = { by: req.auth.uid, outcome, evidence: ev.slice(0, 300), atMs: Date.now() };
    if (outcome === 'not_refunded') {
      if (rd.status === 'provider_succeeded') throw new HttpsError('failed-precondition', 'The provider confirmed this refund — it cannot be marked not refunded');
      await fsdb.runTransaction(async (txn) => {
        const cur = await txn.get(refundRef);
        if (cur.data().status !== rd.status) throw new HttpsError('aborted', 'Refund changed — reload');
        txn.update(refundRef, { status: 'failed', resolution, updatedAt: now() });
      });
      await _audit('refund_resolved_not_refunded', req.auth.uid, { refundId, evidence: resolution.evidence });
      return { refundId, status: 'failed' };
    }
    const settled = await _settleRefund(refundRef, { resolving: true, providerRefundId: providerRefundId || rd.providerRefundId || null, actorUid: req.auth.uid, resolution });
    if (!settled.ok) throw new HttpsError('aborted', 'Settlement did not complete — retry');
    if (!settled.already) await _afterRefundSettled(refundId, settled.refund, req.auth.uid, 'fosResolveRefund');
    await _audit('refund_resolved_refunded', req.auth.uid, { refundId, evidence: resolution.evidence });
    return { refundId, status: 'processed', already: !!settled.already };
  }
);

/* ════════════════════════════════════════════════════════════
   CF 5. fosGenerateInvoice
   Produces a structured invoice record from a completed transaction.
   Stored in fosInvoices/{invoiceId} and returned to the caller.
════════════════════════════════════════════════════════════ */
exports.fosGenerateInvoice = onCall(
  {
    region:          REGION,
    timeoutSeconds:  30,
    memory:          '256MiB',
    enforceAppCheck: true,
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
    region:          REGION,
    timeoutSeconds:  120,
    memory:          '512MiB',
    enforceAppCheck: true,
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
    region:          REGION,
    timeoutSeconds:  30,
    memory:          '128MiB',
    enforceAppCheck: true,
    secrets:         [INTASEND_PRIVATE_KEY],
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
    region:          REGION,
    timeoutSeconds:  60,
    memory:          '512MiB',
    enforceAppCheck: true,
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

/* Test seam (pure, no I/O). */
exports._refundInternals = { REFUND_EXECUTABLE, _isDefinitiveRejection };

/* Internal (not a Cloud Function): the refund-request authority, for the Entertainment refund
   wizard. index.js re-exports financial-os callables BY NAME, so this is never deployed. */
exports._internal = Object.assign(exports._internal || {}, { submitRefund: _submitRefundHandler });
