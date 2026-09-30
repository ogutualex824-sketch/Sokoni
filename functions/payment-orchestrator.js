'use strict';
/**
 * SOKONI Payment Orchestrator v2.0
 * Unified payment engine with full lifecycle management.
 * Every payment flows through a single state machine:
 *   created → pending → processing → succeeded | failed | cancelled
 * Every state transition emits a platform event.
 *
 * Supports: M-Pesa (IntaSend STK), Cards (IntaSend), Wallet, Bank Transfer
 */

const { onCall, HttpsError }  = require('firebase-functions/v2/https');
const { onSchedule }          = require('firebase-functions/v2/scheduler');
const { defineSecret }        = require('firebase-functions/params');
const admin                   = require('firebase-admin');
const logger                  = require('firebase-functions/logger');

const INTASEND_SK = defineSecret('INTASEND_PRIVATE_KEY');

const db   = admin.firestore;
const now  = () => admin.firestore.FieldValue.serverTimestamp();
const incr = (n) => admin.firestore.FieldValue.increment(n);

/* ── Rate limiter (Firestore-backed, cross-instance safe) ── */
async function _rateLimit(key, maxCalls, windowSec) {
  const ref  = admin.firestore().collection('rateLimits').doc(`pay_${key}`);
  const win  = Math.floor(Date.now() / (windowSec * 1000));
  const docId = `${key}_${win}`;
  const limitRef = admin.firestore().collection('rateLimits').doc(docId);
  let ok = false;
  await admin.firestore().runTransaction(async (t) => {
    const snap = await t.get(limitRef);
    const count = snap.exists ? (snap.data().count || 0) : 0;
    if (count < maxCalls) {
      t.set(limitRef, { count: count + 1, expiresAt: Date.now() + windowSec * 1000 }, { merge: true });
      ok = true;
    }
  });
  return ok;
}

/* ── Metadata sanitizer — allowlist + size guard ── */
const META_ALLOWLIST = new Set(['serviceDesc', 'note', 'referralCode', 'couponCode', 'channel', 'deviceId']);
function _sanitizeMeta(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out = {};
  for (const k of META_ALLOWLIST) {
    if (raw[k] !== undefined && typeof raw[k] === 'string') {
      out[k] = raw[k].replace(/[<>"']/g, '').slice(0, 256);
    }
  }
  return out;
}

/* ── Payment status machine ── */
const STATUS = {
  CREATED:    'created',
  PENDING:    'pending',
  PROCESSING: 'processing',
  SUCCEEDED:  'succeeded',
  FAILED:     'failed',
  CANCELLED:  'cancelled',
  REFUNDED:   'refunded',
};

const ALLOWED_TRANSITIONS = {
  [STATUS.CREATED]:    [STATUS.PENDING, STATUS.CANCELLED],
  [STATUS.PENDING]:    [STATUS.PROCESSING, STATUS.FAILED, STATUS.CANCELLED],
  [STATUS.PROCESSING]: [STATUS.SUCCEEDED, STATUS.FAILED],
  [STATUS.SUCCEEDED]:  [STATUS.REFUNDED],
  [STATUS.FAILED]:     [],
  [STATUS.CANCELLED]:  [],
  [STATUS.REFUNDED]:   [],
};

/* ── Provider IDs ── */
const PROVIDER = {
  MPESA:    'mpesa',
  CARD:     'card',
  WALLET:   'wallet',
  BANK:     'bank',
  QR:       'qr',
};

/* ── Helpers ── */
function _san(v, max) {
  if (typeof v !== 'string') return '';
  return v.replace(/[<>"']/g, '').slice(0, max);
}

function _authRequired(req) {
  if (!req.auth) throw new HttpsError('unauthenticated', 'Authentication required');
  return req.auth;
}

function _validateTransition(currentStatus, nextStatus) {
  const allowed = ALLOWED_TRANSITIONS[currentStatus];
  if (!allowed) throw new HttpsError('failed-precondition', 'Unknown payment status: ' + currentStatus);
  if (!allowed.includes(nextStatus)) {
    throw new HttpsError('failed-precondition', `Cannot transition from ${currentStatus} to ${nextStatus}`);
  }
}

function _validateAmount(amount, currency = 'KES') {
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new HttpsError('invalid-argument', 'amount must be a positive number');
  }
  if (currency !== 'KES') {
    throw new HttpsError('invalid-argument', 'Only KES supported in current version');
  }
  const amountCents = Math.round(amount * 100);
  if (amountCents < 100) throw new HttpsError('invalid-argument', 'Minimum payment is KSh 1.00');
  if (amount > 300000) throw new HttpsError('invalid-argument', 'Maximum amount is KES 300,000');
}

function _emitEvent(type, payload, correlationId) {
  return admin.firestore().collection('platformEvents').add({
    type,
    domain: type.split('.')[0],
    noun:   type.split('.')[1] || '',
    verb:   type.split('.')[2] || '',
    payload,
    metadata: {
      publishedAt:    now(),
      publishedBy:    'payment-orchestrator',
      correlationId:  correlationId || null,
      causationId:    null,
      sessionId:      null,
      version:        '1.0',
    },
    delivery: { attempts: 0, lastAttempt: null, subscribers: [], failed: [] },
    status:    'pending',
    createdAt: now(),
  });
}

/* ═══════════════════════════════════════════════════════════
   CF 1: createPayment — initiate a payment (returns paymentId)
   Idempotency key prevents duplicate payments.
═══════════════════════════════════════════════════════════ */
exports.createPayment = onCall({ enforceAppCheck: true }, async (request) => {
  const auth = _authRequired(request);

  if (!await _rateLimit(`create_${auth.uid}`, 10, 60)) {
    throw new HttpsError('resource-exhausted', 'Too many payment requests. Please wait a moment.');
  }

  const {
    amount, currency = 'KES', provider, orderId, referenceId,
    idempotencyKey, metadata: meta = {},
  } = request.data || {};

  _validateAmount(amount, currency);
  if (!provider || !Object.values(PROVIDER).includes(provider)) {
    throw new HttpsError('invalid-argument', 'Invalid payment provider');
  }
  if (!orderId && !referenceId) {
    throw new HttpsError('invalid-argument', 'orderId or referenceId required');
  }

  /* Idempotency: client key takes precedence; if absent, derive a stable key
     from (buyerId + orderId/referenceId) so browser refreshes don't double-charge */
  const stableRef = orderId || referenceId;
  const resolvedKey = idempotencyKey
    ? _san(idempotencyKey, 128)
    : require('crypto').createHash('sha256').update(`${auth.uid}|${stableRef}`).digest('hex');

  const existing = await admin.firestore()
    .collection('payments')
    .where('idempotencyKey', '==', resolvedKey)
    .where('buyerId', '==', auth.uid)
    .limit(1)
    .get();
  if (!existing.empty) {
    return { paymentId: existing.docs[0].id, status: STATUS.CREATED, idempotent: true };
  }

  const ref       = admin.firestore().collection('payments').doc();
  const paymentId = ref.id;

  await ref.set({
    paymentId,
    buyerId:        auth.uid,
    amount:         Math.round(amount * 100) / 100,   // KES float — display/legacy
    amountCents:    Math.round(amount * 100),          // integer cents — FinOS/arithmetic
    currency,
    provider,
    orderId:        orderId       ? _san(orderId, 64)       : null,
    referenceId:    referenceId   ? _san(referenceId, 128)  : null,
    idempotencyKey: resolvedKey,
    status:         STATUS.CREATED,
    attempts:       0,
    maxAttempts:    3,
    metadata:       _sanitizeMeta(meta),
    history: [{
      status:    STATUS.CREATED,
      at:        new Date().toISOString(),
      actor:     auth.uid,
    }],
    createdAt:      now(),
    updatedAt:      now(),
  });

  await _emitEvent('payment.transaction.created', {
    paymentId, buyerId: auth.uid, amount, currency, provider, orderId,
  }, paymentId);

  return { paymentId, status: STATUS.CREATED };
});

/* ═══════════════════════════════════════════════════════════
   CF 2: initiatePayment — kick off provider-specific flow
   M-Pesa: STK push | Card: checkout URL | Wallet: deduct
═══════════════════════════════════════════════════════════ */
exports.initiatePayment = onCall(
  { enforceAppCheck: true, secrets: [INTASEND_SK] },
  async (request) => {
    const auth = _authRequired(request);

    if (!await _rateLimit(`initiate_${auth.uid}`, 5, 60)) {
      throw new HttpsError('resource-exhausted', 'Too many payment initiation requests. Please wait a moment.');
    }

    const { paymentId, phone } = request.data || {};

    if (!paymentId) throw new HttpsError('invalid-argument', 'paymentId required');

    const ref  = admin.firestore().collection('payments').doc(_san(paymentId, 40));
    const snap = await ref.get();
    if (!snap.exists) throw new HttpsError('not-found', 'Payment not found');

    const payment = snap.data();
    if (payment.buyerId !== auth.uid) throw new HttpsError('permission-denied', 'Access denied');

    _validateTransition(payment.status, STATUS.PENDING);

    if (payment.attempts >= payment.maxAttempts) {
      throw new HttpsError('resource-exhausted', 'Maximum payment attempts reached');
    }

    await ref.update({
      status:    STATUS.PENDING,
      attempts:  incr(1),
      updatedAt: now(),
      history:   admin.firestore.FieldValue.arrayUnion({
        status: STATUS.PENDING, at: new Date().toISOString(), actor: auth.uid,
      }),
    });

    await _emitEvent('payment.transaction.pending', {
      paymentId, buyerId: auth.uid, provider: payment.provider,
    }, paymentId);

    let providerResult = {};

    if (payment.provider === PROVIDER.MPESA) {
      const normalizedPhone = (phone || '').replace(/^0/, '254').replace(/^\+/, '');
      if (!/^2547\d{8}$/.test(normalizedPhone)) {
        throw new HttpsError('invalid-argument', 'Invalid Kenyan phone number');
      }

      /* IntaSend STK push */
      const IntaSend = require('intasend-node');
      const sdk = new IntaSend(
        '',
        INTASEND_SK.value(),
        process.env.FUNCTIONS_EMULATOR === 'true' ? true : false
      );

      const stkResult = await sdk.collection().charge({
        first_name:    '',
        last_name:     '',
        email:         '',
        host:          'https://mysokoni.co.ke',
        amount:        payment.amount,
        phone_number:  normalizedPhone,
        api_ref:       paymentId,
        narrative:     'SOKONI Payment',
      });

      providerResult = {
        checkoutRequestId: stkResult.id,
        phone: normalizedPhone,
      };

      await ref.update({
        'providerData.checkoutRequestId': stkResult.id,
        'providerData.phone':             normalizedPhone,
        updatedAt: now(),
      });
    } else if (payment.provider === PROVIDER.CARD) {
      providerResult = {
        checkoutUrl: `https://payment.intasend.com/pay/checkout/?ref=${encodeURIComponent(paymentId)}`,
      };
    } else if (payment.provider === PROVIDER.WALLET) {
      /* Wallet deduction — handled by wallet engine */
      providerResult = { walletDeduction: true };
    }

    return { paymentId, status: STATUS.PENDING, provider: payment.provider, ...providerResult };
  }
);

/* ═══════════════════════════════════════════════════════════
   CF 3: confirmPayment — called by webhook or client poll
   Marks payment succeeded/failed.
═══════════════════════════════════════════════════════════ */
exports.confirmPayment = onCall({ enforceAppCheck: true }, async (request) => {
  /* Payment confirmation must only be triggered by the payment gateway webhook
     (fosSecureWebhook / webhookIntasend), never by end-user client calls.
     Allowing buyers to self-confirm lets them mark a payment succeeded without
     actually paying, bypassing the entire payment flow. */
  const auth   = _authRequired(request);
  const claims = auth.token || {};
  const isAdmin = claims.admin || claims.role === 'admin' || claims.role === 'super_admin';
  if (!isAdmin) {
    throw new HttpsError(
      'permission-denied',
      'Payment confirmation is handled automatically by the payment gateway. Contact support if your payment is not reflecting.'
    );
  }
  const { paymentId, succeeded, failReason, providerRef } = request.data || {};

  if (!paymentId) throw new HttpsError('invalid-argument', 'paymentId required');

  const ref  = admin.firestore().collection('payments').doc(_san(paymentId, 40));
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Payment not found');

  const payment = snap.data();

  const nextStatus = succeeded ? STATUS.SUCCEEDED : STATUS.FAILED;
  _validateTransition(payment.status, nextStatus);

  await ref.update({
    status:                   nextStatus,
    'providerData.ref':       providerRef || null,
    'providerData.failReason': failReason || null,
    updatedAt:                now(),
    ...(nextStatus === STATUS.SUCCEEDED ? { paidAt: now() } : { failedAt: now() }),
    history: admin.firestore.FieldValue.arrayUnion({
      status: nextStatus, at: new Date().toISOString(), actor: 'system',
    }),
  });

  const eventType = succeeded
    ? 'payment.transaction.completed'
    : 'payment.transaction.failed';

  await _emitEvent(eventType, {
    paymentId,
    buyerId:   payment.buyerId,
    amount:    payment.amount,
    currency:  payment.currency,
    provider:  payment.provider,
    orderId:   payment.orderId,
    failReason: failReason || null,
  }, paymentId);

  return { paymentId, status: nextStatus };
});

/* ═══════════════════════════════════════════════════════════
   CF 4: refundPayment — initiate a refund
═══════════════════════════════════════════════════════════ */
exports.refundPayment = onCall({ enforceAppCheck: true }, async (request) => {
  const auth   = request.auth;
  const claims = auth ? (auth.token || {}) : {};
  const isAdmin = claims.admin || claims.role === 'admin' || claims.role === 'super_admin';
  if (!isAdmin) throw new HttpsError('permission-denied', 'Admin access required for refunds');

  const { paymentId, amount: refundAmount, reason } = request.data || {};
  if (!paymentId) throw new HttpsError('invalid-argument', 'paymentId required');

  const ref  = admin.firestore().collection('payments').doc(_san(paymentId, 40));
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Payment not found');

  const payment = snap.data();
  _validateTransition(payment.status, STATUS.REFUNDED);

  const amount = refundAmount || payment.amount;
  // Use integer-cent comparison to avoid float rounding errors
  const refundCents   = Math.round(amount * 100);
  const originalCents = payment.amountCents || Math.round(payment.amount * 100);
  if (refundCents > originalCents) {
    throw new HttpsError('invalid-argument', 'Refund cannot exceed original payment');
  }

  await ref.update({
    status:           STATUS.REFUNDED,
    refundAmount:     amount,                  // KES float — display/legacy
    refundAmountCents: refundCents,            // integer cents — FinOS compatibility
    refundReason:     reason ? _san(reason, 500) : null,
    refundInitiator:  auth.uid,
    refundedAt:       now(),
    updatedAt:        now(),
    history: admin.firestore.FieldValue.arrayUnion({
      status: STATUS.REFUNDED, at: new Date().toISOString(), actor: auth.uid, amount,
    }),
  });

  await _emitEvent('payment.transaction.refunded', {
    paymentId, buyerId: payment.buyerId, amount, currency: payment.currency,
    provider: payment.provider, orderId: payment.orderId, reason,
  }, paymentId);

  return { paymentId, status: STATUS.REFUNDED, refundAmount: amount };
});

/* ═══════════════════════════════════════════════════════════
   CF 5: getPayment — get payment details
═══════════════════════════════════════════════════════════ */
exports.getPayment = onCall({ enforceAppCheck: true }, async (request) => {
  const auth = _authRequired(request);
  const { paymentId } = request.data || {};
  if (!paymentId) throw new HttpsError('invalid-argument', 'paymentId required');

  const snap = await admin.firestore().collection('payments').doc(_san(paymentId, 40)).get();
  if (!snap.exists) throw new HttpsError('not-found', 'Payment not found');

  const payment = snap.data();
  const claims = auth.token || {};
  const isAdmin = claims.admin || claims.role === 'admin' || claims.role === 'super_admin';

  if (!isAdmin && payment.buyerId !== auth.uid) {
    throw new HttpsError('permission-denied', 'Access denied');
  }

  return payment;
});

/* ═══════════════════════════════════════════════════════════
   Scheduled: auto-fail payments stuck in pending > 30 min
═══════════════════════════════════════════════════════════ */
exports.paymentTimeoutSweep = onSchedule(
  { schedule: 'every 5 minutes', timeZone: 'Africa/Nairobi' },
  async () => {
    const threshold = new Date(Date.now() - 30 * 60 * 1000);
    const stale = await admin.firestore()
      .collection('payments')
      .where('status', 'in', [STATUS.PENDING, STATUS.PROCESSING])
      .where('updatedAt', '<', threshold)
      .limit(100)
      .get();

    if (stale.empty) return;

    const batch = admin.firestore().batch();
    stale.docs.forEach(d => {
      batch.update(d.ref, {
        status:     STATUS.FAILED,
        failedAt:   now(),
        updatedAt:  now(),
        'providerData.failReason': 'timeout',
        history: admin.firestore.FieldValue.arrayUnion({
          status: STATUS.FAILED, at: new Date().toISOString(), actor: 'system', reason: 'timeout',
        }),
      });
    });
    await batch.commit();

    /* Emit events */
    await Promise.all(stale.docs.map(d => {
      const p = d.data();
      return _emitEvent('payment.transaction.failed', {
        paymentId: p.paymentId, buyerId: p.buyerId, amount: p.amount,
        provider: p.provider, failReason: 'timeout',
      }, p.paymentId);
    }));

    console.log(`[PaymentOrchestrator] Timed out ${stale.size} payments`);
  }
);

exports.STATUS   = STATUS;
exports.PROVIDER = PROVIDER;
