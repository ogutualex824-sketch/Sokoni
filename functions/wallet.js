'use strict';

/**
 * SOKONI Wallet & Seller Payouts — Cloud Functions
 * Firebase Gen2 / Node.js 22
 *
 * Collections (single-field queries only, no composite indexes):
 *   wallets/{uid}
 *   walletTransactions/{txId}
 *   payoutRequests/{reqId}
 */

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { getFirestore, FieldValue, Timestamp } = require('firebase-admin/firestore');
const { defineSecret } = require('firebase-functions/params');
const { checkRateLimit } = require('./redis-rate-limiter');   /* HIGH-06 — existing limiter, not a new one */

const INTASEND_KEY = defineSecret('INTASEND_PRIVATE_KEY');

// ─── Helpers ───────────────────────────────────────────────────────────────

function _requireAuth(ctx) {
  if (!ctx.auth) throw new HttpsError('unauthenticated', 'Login required');
}

function _requireAdmin(ctx) {
  if (!ctx.auth?.token?.admin && !ctx.auth?.token?.superAdmin) {
    throw new HttpsError('permission-denied', 'Admin access required');
  }
}

/** Sanitise a string: strip HTML tags, trim, truncate. */
function _san(s, max = 300) {
  return s == null ? '' : String(s).replace(/<[^>]*>/g, '').trim().slice(0, max);
}

/** Generate a short random ID suitable for Firestore doc IDs. */
function _genId(prefix = 'tx') {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${ts}_${rand}`;
}

/**
 * Normalize Kenyan phone to 254XXXXXXXXX (10-digit local or +254/254 prefix).
 * Returns null if format is unrecognised.
 */
function _normalizePhone(raw) {
  const cleaned = String(raw).replace(/\s+/g, '');
  const match = cleaned.match(/^(?:254|\+254|0)([17]\d{8})$/);
  if (!match) return null;
  return `254${match[1]}`;
}

/** Ensure a wallet document exists; returns the doc reference. */
async function _ensureWallet(db, uid) {
  const ref = db.collection('wallets').doc(uid);
  const snap = await ref.get();
  if (!snap.exists) {
    await ref.set({
      uid,
      balance: 0,
      currency: 'KES',
      lastTopUp: null,
      pendingTopUp: null,
      createdAt: Timestamp.now(),
    });
  }
  return ref;
}

// ─── 1. getWalletBalance ───────────────────────────────────────────────────

exports.getWalletBalance = onCall({ cors: true, enforceAppCheck: true }, async (request) => {
  _requireAuth(request);

  const db = getFirestore();
  const callerUid = request.auth.uid;
  const { targetUid } = request.data || {};

  let uid = callerUid;
  if (targetUid && targetUid !== callerUid) {
    _requireAdmin(request);
    uid = _san(targetUid, 128);
  }

  const ref = await _ensureWallet(db, uid);
  const snap = await ref.get();
  const data = snap.data();

  return {
    uid,
    balance: data.balance ?? 0,
    currency: data.currency ?? 'KES',
    lastTopUp: data.lastTopUp ?? null,
    pendingTopUp: data.pendingTopUp ?? null,
  };
});

// ─── 2. initiateWalletTopUp ────────────────────────────────────────────────

exports.initiateWalletTopUp = onCall(
  { cors: true, enforceAppCheck: true, secrets: [INTASEND_KEY] },
  async (request) => {
    _requireAuth(request);
    /* HIGH-06: throttle a money/privilege endpoint. Throws resource-exhausted. */
    await checkRateLimit(request, 'payment');

    const db = getFirestore();
    const uid = request.auth.uid;
    const { amount, phone } = request.data || {};

    // Validate amount
    const amt = Number(amount);
    if (!Number.isInteger(amt) || amt < 10 || amt > 70000) {
      throw new HttpsError('invalid-argument', 'Amount must be a whole number between KSh 10 and KSh 70,000');
    }

    // Validate & normalize phone
    const normalizedPhone = _normalizePhone(phone);
    if (!normalizedPhone) {
      throw new HttpsError('invalid-argument', 'Phone must be a valid Kenyan number (07XX or 01XX, with or without country code)');
    }

    // Create pending transaction
    const txId = _genId('wtop');
    const txRef = db.collection('walletTransactions').doc(txId);
    await txRef.set({
      uid,
      type: 'pending',
      amount: amt,
      description: 'Wallet top-up via M-Pesa',
      status: 'pending',
      mpesaRef: null,
      invoiceId: null,
      createdAt: Timestamp.now(),
    });

    // Flag pending top-up on wallet (creates wallet doc if needed)
    const walletRef = db.collection('wallets').doc(uid);
    const walletSnap = await walletRef.get();
    if (!walletSnap.exists) {
      await walletRef.set({
        uid,
        balance: 0,
        currency: 'KES',
        lastTopUp: null,
        pendingTopUp: txId,
        createdAt: Timestamp.now(),
      });
    } else {
      await walletRef.update({ pendingTopUp: txId });
    }

    // Initiate IntaSend STK Push
    let invoiceId = null;
    try {
      const IntaSend = require('intasend-node');
      /* intasend-node takes THREE POSITIONAL args:
             IntaSend(publishable_key, secret_key, test_mode)
         This was called as IntaSend(key, { testMode }) — so the secret landed in
         the publishable slot and an OBJECT became secret_key. The client sends
         `Authorization: Bearer ${secret_key}`, i.e. "Bearer [object Object]",
         and IntaSend answered HTTP 500 on every STK push. test_mode was also
         left undefined. Matches the working call in payment-orchestrator.js. */
      const client = new IntaSend(
        '',                                        /* publishable key — unused for collection */
        INTASEND_KEY.value(),                      /* secret key */
        process.env.FUNCTIONS_EMULATOR === 'true'  /* test mode only under the emulator */
      );

      /* Use mpesaStkPush (→ /api/v1/payment/mpesa-stk-push/), the endpoint that
         actually pushes the M-Pesa PIN prompt to the phone — the same one the
         working subscription flow hits via initiateSTKPush.

         The previous call, collection().charge(), posts to /api/v1/checkout/
         (see node_modules/intasend-node/dist/collection.js): it mints a hosted-
         checkout invoice AND blanks the secret key, so it returns 200 with an
         invoice but never sends an STK. That is the exact divergence — the call
         "succeeded" server-side while no prompt reached the phone. method and
         currency are injected by the SDK; the checkout-only name/email/host
         fields are not part of the STK push. Response still carries
         invoice.invoice_id, so the invoiceId capture and the confirm/webhook/
         sweep paths below are unchanged. */
      const response = await client.collection().mpesaStkPush({
        amount:       amt,
        phone_number: normalizedPhone,
        api_ref:      txId,
        narrative:    'SOKONI wallet top-up',
      });

      invoiceId = response?.invoice?.invoice_id ?? response?.id ?? null;
      await txRef.update({ invoiceId });
    } catch (err) {
      // IntaSend failure — mark transaction failed and surface a clean error
      await txRef.update({ status: 'failed' });
      await walletRef.update({ pendingTopUp: null });
      /* err.message was `undefined` for IntaSend transport errors, so the real
         cause (HTTP 500 from a malformed Authorization header) never reached the
         logs — only a generic "contact support". Log whatever the error actually
         carries, without leaking the credential. */
      console.error('[wallet] IntaSend STK push error:', {
        message: err && err.message,
        status:  err && (err.status || err.statusCode),
        body:    (() => { try { return JSON.stringify(err).slice(0, 500); } catch (_) { return String(err); } })(),
      });
      throw new HttpsError('unavailable', 'Unable to initiate M-Pesa prompt. Please try again or contact support.');
    }

    return {
      txId,
      invoiceId,
      message: 'M-Pesa prompt sent to your phone. Enter your PIN to complete the top-up.',
    };
  }
);

// ─── 3. confirmWalletTopUp ─────────────────────────────────────────────────

exports.confirmWalletTopUp = onCall(
  { cors: true, secrets: [INTASEND_KEY], enforceAppCheck: true },
  async (request) => {
    _requireAuth(request);

    const db = getFirestore();
    const uid = request.auth.uid;
    const { txId } = request.data || {};

    if (!txId) throw new HttpsError('invalid-argument', 'txId is required');

    const txRef = db.collection('walletTransactions').doc(_san(txId, 128));
    const txSnap = await txRef.get();

    if (!txSnap.exists) throw new HttpsError('not-found', 'Transaction not found');

    const tx = txSnap.data();
    if (tx.uid !== uid) throw new HttpsError('permission-denied', 'This transaction does not belong to you');
    if (tx.status === 'completed') {
      return { status: 'completed', amount: tx.amount };
    }
    if (tx.status === 'failed') {
      return { status: 'failed' };
    }
    if (!tx.invoiceId) {
      return { status: 'pending' };
    }

    // Poll IntaSend for payment status
    let invoiceStatus = null;
    try {
      const IntaSend = require('intasend-node');
      /* intasend-node takes THREE POSITIONAL args:
             IntaSend(publishable_key, secret_key, test_mode)
         This was called as IntaSend(key, { testMode }) — so the secret landed in
         the publishable slot and an OBJECT became secret_key. The client sends
         `Authorization: Bearer ${secret_key}`, i.e. "Bearer [object Object]",
         and IntaSend answered HTTP 500 on every STK push. test_mode was also
         left undefined. Matches the working call in payment-orchestrator.js. */
      const client = new IntaSend(
        '',                                        /* publishable key — unused for collection */
        INTASEND_KEY.value(),                      /* secret key */
        process.env.FUNCTIONS_EMULATOR === 'true'  /* test mode only under the emulator */
      );

      const result = await client.collection().status(tx.invoiceId);
      invoiceStatus = result?.invoice?.state ?? result?.state ?? null;
    } catch (err) {
      console.error('[wallet] IntaSend status check error:', err.message);
      throw new HttpsError('unavailable', 'Unable to verify payment status. Please try again shortly.');
    }

    // Normalise IntaSend states
    const paid = invoiceStatus === 'COMPLETE';
    const failed = ['FAILED', 'CANCELLED', 'EXPIRED'].includes(invoiceStatus);

    if (paid) {
      const walletRef = db.collection('wallets').doc(uid);
      let newBalance = 0;

      await db.runTransaction(async (t) => {
        // Read BOTH wallet and txRef inside the transaction so Firestore detects
        // conflicts from a concurrent confirmWalletTopUp or sweep call
        const [walletSnap, txCheck] = await Promise.all([t.get(walletRef), t.get(txRef)]);

        // Already credited by a concurrent request — return idempotently
        if (txCheck.exists && txCheck.data().status === 'completed') {
          newBalance = walletSnap.exists ? (walletSnap.data().balance ?? 0) : 0;
          return;
        }

        const current = walletSnap.exists ? (walletSnap.data().balance ?? 0) : 0;
        newBalance = current + tx.amount;

        if (!walletSnap.exists) {
          t.set(walletRef, {
            uid,
            balance: newBalance,
            currency: 'KES',
            lastTopUp: Timestamp.now(),
            pendingTopUp: null,
            createdAt: Timestamp.now(),
          });
        } else {
          t.update(walletRef, {
            balance: newBalance,
            lastTopUp: Timestamp.now(),
            pendingTopUp: null,
          });
        }

        t.update(txRef, { status: 'completed', updatedAt: Timestamp.now() });
      });

      return { status: 'completed', amount: tx.amount, balance: newBalance };
    }

    if (failed) {
      await txRef.update({ status: 'failed', updatedAt: Timestamp.now() });
      await db.collection('wallets').doc(uid).update({ pendingTopUp: null });
      return { status: 'failed' };
    }

    return { status: 'pending' };
  }
);

// ─── 4. spendFromWallet ────────────────────────────────────────────────────

exports.spendFromWallet = onCall({ cors: true, enforceAppCheck: true }, async (request) => {
  _requireAuth(request);
  /* HIGH-06: throttle a money/privilege endpoint. Throws resource-exhausted. */
  await checkRateLimit(request, 'payment');

  const db = getFirestore();
  const uid = request.auth.uid;
  const { amount, orderId, description } = request.data || {};

  const amt = Number(amount);
  if (!Number.isInteger(amt) || amt <= 0) {
    throw new HttpsError('invalid-argument', 'Amount must be a positive whole number');
  }
  if (!orderId) throw new HttpsError('invalid-argument', 'orderId is required');

  const sanitizedOrderId = _san(orderId, 128);
  const desc = _san(description, 300) || `Payment for order ${sanitizedOrderId}`;

  // Idempotency: stable doc ID prevents double-spend
  const txId = `${uid}_${sanitizedOrderId}_spend`;
  const txRef = db.collection('walletTransactions').doc(txId);
  const walletRef = db.collection('wallets').doc(uid);

  let newBalance = 0;

  await db.runTransaction(async (t) => {
    const [txSnap, walletSnap] = await Promise.all([t.get(txRef), t.get(walletRef)]);

    // Already processed — return stored result
    if (txSnap.exists && txSnap.data().status === 'completed') {
      newBalance = walletSnap.exists ? walletSnap.data().balance ?? 0 : 0;
      return;
    }

    if (!walletSnap.exists) throw new HttpsError('not-found', 'Wallet does not exist');

    const current = walletSnap.data().balance ?? 0;
    if (current < amt) {
      throw new HttpsError('failed-precondition', 'Insufficient wallet balance');
    }

    newBalance = current - amt;
    t.update(walletRef, { balance: newBalance });
    t.set(txRef, {
      uid,
      type: 'debit',
      amount: amt,
      description: desc,
      orderId: sanitizedOrderId,
      status: 'completed',
      createdAt: Timestamp.now(),
    });
  });

  return { success: true, newBalance, txId };
});

// ─── 5. getWalletTransactions ──────────────────────────────────────────────

exports.getWalletTransactions = onCall({ cors: true, enforceAppCheck: true }, async (request) => {
  _requireAuth(request);

  const db = getFirestore();
  const uid = request.auth.uid;
  const page = Math.max(1, Number(request.data?.page) || 1);
  const PAGE_SIZE = 50;

  // Single-field query on uid (no composite index needed)
  const snap = await db
    .collection('walletTransactions')
    .where('uid', '==', uid)
    .limit(PAGE_SIZE + 1)
    .get();

  const all = snap.docs.map((d) => ({ id: d.id, ...d.data() }));

  // Sort descending by createdAt in JS (avoids composite index)
  all.sort((a, b) => {
    const ta = a.createdAt?.toMillis?.() ?? 0;
    const tb = b.createdAt?.toMillis?.() ?? 0;
    return tb - ta;
  });

  // Manual pagination
  const offset = (page - 1) * PAGE_SIZE;
  const slice = all.slice(offset, offset + PAGE_SIZE);
  const hasMore = all.length > offset + PAGE_SIZE;

  return {
    transactions: slice.map((tx) => ({
      id: tx.id,
      type: tx.type,
      amount: tx.amount,
      description: tx.description,
      status: tx.status,
      orderId: tx.orderId ?? null,
      mpesaRef: tx.mpesaRef ?? null,
      createdAt: tx.createdAt,
    })),
    page,
    hasMore,
  };
});

// ─── 6. requestSellerPayout ────────────────────────────────────────────────

exports.requestSellerPayout = onCall({ cors: true, enforceAppCheck: true }, async (request) => {
  _requireAuth(request);
  /* HIGH-06: throttle a money/privilege endpoint. Throws resource-exhausted. */
  await checkRateLimit(request, 'payment');

  const db = getFirestore();
  const uid = request.auth.uid;
  const { amount, method, accountNumber, bankCode, bankName } = request.data || {};

  const amt = Number(amount);
  if (!Number.isInteger(amt) || amt < 500) {
    throw new HttpsError('invalid-argument', 'Minimum payout amount is KSh 500');
  }

  const validMethods = ['mpesa', 'bank'];
  if (!validMethods.includes(method)) {
    throw new HttpsError('invalid-argument', 'method must be "mpesa" or "bank"');
  }

  const sanitizedAccount = _san(accountNumber, 30);
  if (!sanitizedAccount) {
    throw new HttpsError('invalid-argument', 'accountNumber is required');
  }

  if (method === 'mpesa') {
    const normalizedPhone = _normalizePhone(sanitizedAccount);
    if (!normalizedPhone) {
      throw new HttpsError('invalid-argument', 'M-Pesa account must be a valid Kenyan phone number');
    }
  }

  if (method === 'bank' && !bankCode) {
    throw new HttpsError('invalid-argument', 'bankCode is required for bank payouts');
  }

  /* Atomically check velocity + balance, reserve amount, and create request */
  const reqId       = _genId('pout');
  const walletRef   = db.collection('wallets').doc(uid);
  const reqRef      = db.collection('payoutRequests').doc(reqId);
  const velocityRef = db.collection('payoutVelocity').doc(uid);
  const today       = new Date().toISOString().slice(0, 10);

  await db.runTransaction(async (t) => {
    const [walletSnap, velocitySnap] = await Promise.all([t.get(walletRef), t.get(velocityRef)]);

    /* FRD-1: velocity gate — max 3 payout requests per seller per calendar day */
    const vel = velocitySnap.exists ? velocitySnap.data() : null;
    const todayCount = (vel && vel.date === today) ? (vel.count || 0) : 0;
    if (todayCount >= 3) {
      throw new HttpsError('resource-exhausted', 'Maximum 3 payout requests per day. Please try again tomorrow.');
    }

    const balance = walletSnap.exists ? (walletSnap.data().balance ?? 0) : 0;
    if (balance < amt) {
      throw new HttpsError('failed-precondition', 'Insufficient wallet balance for this payout');
    }

    t.set(velocityRef, { date: today, count: todayCount + 1, updatedAt: Timestamp.now() }, { merge: true });
    t.update(walletRef, { balance: balance - amt, pendingPayout: FieldValue.increment(amt) });
    t.set(reqRef, {
      sellerUid:     uid,
      amount:        amt,
      method,
      accountNumber: sanitizedAccount,
      bankCode:      method === 'bank' ? _san(bankCode, 20) : null,
      bankName:      method === 'bank' ? _san(bankName, 100) : null,
      status:        'pending',
      note:          null,
      processedAt:   null,
      createdAt:     Timestamp.now(),
    });
  });

  return {
    success: true,
    requestId: reqId,
    message: 'Payout request submitted. Processing within 1–3 business days.',
  };
});

// ─── 7. getPayoutHistory ───────────────────────────────────────────────────

exports.getPayoutHistory = onCall({ cors: true, enforceAppCheck: true }, async (request) => {
  _requireAuth(request);

  const db = getFirestore();
  const uid = request.auth.uid;

  // Single-field query on sellerUid
  const snap = await db
    .collection('payoutRequests')
    .where('sellerUid', '==', uid)
    .limit(20)
    .get();

  const payouts = snap.docs.map((d) => ({ id: d.id, ...d.data() }));

  // Sort descending by createdAt in JS
  payouts.sort((a, b) => {
    const ta = a.createdAt?.toMillis?.() ?? 0;
    const tb = b.createdAt?.toMillis?.() ?? 0;
    return tb - ta;
  });

  return {
    payouts: payouts.map((p) => ({
      id: p.id,
      amount: p.amount,
      method: p.method,
      status: p.status,
      note: p.note ?? null,
      processedAt: p.processedAt ?? null,
      createdAt: p.createdAt,
    })),
  };
});

// ─── 8. adminProcessPayout ─────────────────────────────────────────────────

exports.adminProcessPayout = onCall({ cors: true, enforceAppCheck: true }, async (request) => {
  _requireAuth(request);
  _requireAdmin(request);

  const db = getFirestore();
  const { requestId, status, note } = request.data || {};

  if (!requestId) throw new HttpsError('invalid-argument', 'requestId is required');

  const validStatuses = ['approved', 'rejected', 'paid'];
  if (!validStatuses.includes(status)) {
    throw new HttpsError('invalid-argument', 'status must be "approved", "rejected", or "paid"');
  }

  const reqRef = db.collection('payoutRequests').doc(_san(requestId, 128));
  const reqSnap = await reqRef.get();

  if (!reqSnap.exists) throw new HttpsError('not-found', 'Payout request not found');

  const update = {
    status,
    note: _san(note, 500) || null,
    processedAt: Timestamp.now(),
    processedBy: request.auth.uid,
  };

  // If marking as paid, also record a debit transaction on the seller's wallet
  if (status === 'paid') {
    const payout = reqSnap.data();
    const walletRef = db.collection('wallets').doc(payout.sellerUid);
    const txId = `${payout.sellerUid}_${requestId}_payout`;
    const txRef = db.collection('walletTransactions').doc(txId);

    await db.runTransaction(async (t) => {
      const txSnap = await t.get(txRef);

      if (!txSnap.exists) {
        // Balance was already reserved at request time (requestSellerPayout deducted it).
        // Only release pendingPayout — do NOT deduct balance again.
        t.update(walletRef, { pendingPayout: FieldValue.increment(-payout.amount) });

        t.set(txRef, {
          uid: payout.sellerUid,
          type: 'payout',
          amount: payout.amount,
          description: `Payout via ${payout.method.toUpperCase()} — ref ${requestId}`,
          status: 'completed',
          createdAt: Timestamp.now(),
        });
      }

      t.update(reqRef, update);
    });
  } else if (status === 'rejected') {
    const payout = reqSnap.data();
    if (!['pending', 'approved'].includes(payout.status)) {
      throw new HttpsError('failed-precondition', `Cannot reject payout with current status: ${payout.status}`);
    }
    const walletRef = db.collection('wallets').doc(payout.sellerUid);
    await db.runTransaction(async (t) => {
      // Restore the balance that was reserved when the payout was requested
      t.update(walletRef, {
        balance:       FieldValue.increment(payout.amount),
        pendingPayout: FieldValue.increment(-payout.amount),
      });
      t.update(reqRef, update);
    });
  } else {
    // status === 'approved' — admin acknowledgement only, no wallet change needed
    await reqRef.update(update);
  }

  return { success: true };
});

// ─── 9. adminGetPendingPayouts ─────────────────────────────────────────────

exports.adminGetPendingPayouts = onCall({ cors: true, enforceAppCheck: true }, async (request) => {
  _requireAuth(request);
  _requireAdmin(request);

  const db = getFirestore();

  // Single-field query on status
  const snap = await db
    .collection('payoutRequests')
    .where('status', '==', 'pending')
    .limit(50)
    .get();

  const payouts = snap.docs.map((d) => ({ id: d.id, ...d.data() }));

  // Sort oldest-first so admins process in FIFO order
  payouts.sort((a, b) => {
    const ta = a.createdAt?.toMillis?.() ?? 0;
    const tb = b.createdAt?.toMillis?.() ?? 0;
    return ta - tb;
  });

  return {
    payouts: payouts.map((p) => ({
      id: p.id,
      sellerUid: p.sellerUid,
      amount: p.amount,
      method: p.method,
      // Mask sensitive account details — admin UI should request full details separately
      accountNumberMasked: p.accountNumber
        ? `${'*'.repeat(Math.max(0, p.accountNumber.length - 4))}${p.accountNumber.slice(-4)}`
        : null,
      bankName: p.bankName ?? null,
      status: p.status,
      createdAt: p.createdAt,
    })),
  };
});

// ─── 10. refundToWallet ────────────────────────────────────────────────────

exports.refundToWallet = onCall({ cors: true, enforceAppCheck: true }, async (request) => {
  _requireAuth(request);
  // Refunds must always be admin-initiated to prevent self-enrichment.
  // User-facing return/dispute flows route through the disputes system for approval.
  _requireAdmin(request);

  const db = getFirestore();
  const callerUid = request.auth.uid;
  const { orderId, amount, reason, targetUid } = request.data || {};

  // Determine whose wallet to credit
  const recipientUid = (targetUid && _san(targetUid, 128)) || callerUid;

  const amt = Number(amount);
  if (!Number.isInteger(amt) || amt <= 0) {
    throw new HttpsError('invalid-argument', 'Refund amount must be a positive whole number');
  }
  if (!orderId) throw new HttpsError('invalid-argument', 'orderId is required');

  const sanitizedOrderId = _san(orderId, 128);
  const desc = _san(reason, 300) || `Refund for order ${sanitizedOrderId}`;

  // Idempotency: stable doc ID prevents duplicate refunds
  const txId = `${recipientUid}_${sanitizedOrderId}_refund`;
  const txRef = db.collection('walletTransactions').doc(txId);
  const walletRef = db.collection('wallets').doc(recipientUid);

  let newBalance = 0;

  await db.runTransaction(async (t) => {
    const [txSnap, walletSnap] = await Promise.all([t.get(txRef), t.get(walletRef)]);

    // Already refunded — idempotent return
    if (txSnap.exists && txSnap.data().status === 'completed') {
      newBalance = walletSnap.exists ? walletSnap.data().balance ?? 0 : 0;
      return;
    }

    const current = walletSnap.exists ? (walletSnap.data().balance ?? 0) : 0;
    newBalance = current + amt;

    if (!walletSnap.exists) {
      t.set(walletRef, {
        uid: recipientUid,
        balance: newBalance,
        currency: 'KES',
        lastTopUp: null,
        pendingTopUp: null,
        createdAt: Timestamp.now(),
      });
    } else {
      t.update(walletRef, { balance: newBalance });
    }

    t.set(txRef, {
      uid: recipientUid,
      type: 'refund',
      amount: amt,
      description: desc,
      orderId: sanitizedOrderId,
      refundedBy: callerUid,
      status: 'completed',
      createdAt: Timestamp.now(),
    });
  });

  return { success: true, newBalance };
});

// ─── Scheduled: clear stale pending wallet top-ups ─────────────────────────
// Q2 fix: pendingTopUp set during initiateWalletTopUp but never cleared if
// the user never calls confirmWalletTopUp (network loss, app kill, etc.)

const { onSchedule } = require('firebase-functions/v2/scheduler');

exports.sweepStaleWalletTopUps = onSchedule(
  { schedule: 'every 30 minutes', timeZone: 'Africa/Nairobi', secrets: [INTASEND_KEY] },
  async () => {
    const db      = getFirestore();
    const cutoff  = Timestamp.fromMillis(Date.now() - 30 * 60 * 1000); // 30 min ago
    const stale   = await db.collection('walletTransactions')
      .where('status', '==', 'pending')
      .where('createdAt', '<', cutoff)
      .limit(50)
      .get();

    if (stale.empty) return;

    let resolved = 0;
    for (const doc of stale.docs) {
      const tx = doc.data();
      let finalStatus = 'expired';

      /* Poll IntaSend if we have an invoiceId */
      if (tx.invoiceId) {
        try {
          const IntaSend = require('intasend-node');
          /* Positional args — see the note at the STK push call site. */
          const client   = new IntaSend('', INTASEND_KEY.value(), process.env.FUNCTIONS_EMULATOR === 'true');
          const result   = await client.collection().status(tx.invoiceId);
          const state    = (result?.invoice?.state || result?.state || '').toUpperCase();
          if (state === 'COMPLETE') {
            finalStatus = 'completed';
          } else if (['FAILED', 'CANCELLED', 'EXPIRED'].includes(state)) {
            finalStatus = 'failed';
          } else {
            continue; // still genuinely pending — skip
          }
        } catch (_) { /* IntaSend unreachable — expire anyway */ }
      }

      await db.runTransaction(async t => {
        const walletRef  = db.collection('wallets').doc(tx.uid);
        // Read both wallet and the transaction doc so Firestore detects conflicts
        // from a concurrent confirmWalletTopUp that may have already credited the wallet
        const [walletSnap, txCheck] = await Promise.all([t.get(walletRef), t.get(doc.ref)]);

        // Already resolved by a concurrent call — skip to avoid double credit
        if (txCheck.exists && txCheck.data().status !== 'pending') return;

        t.update(doc.ref, { status: finalStatus, resolvedAt: Timestamp.now(), resolvedBy: 'sweepStaleWalletTopUps' });
        if (walletSnap.exists && walletSnap.data().pendingTopUp === doc.id) {
          t.update(walletRef, { pendingTopUp: null });
        }
        if (finalStatus === 'completed') {
          const amt = tx.amount || 0;
          t.update(walletRef, { balance: FieldValue.increment(amt), lastTopUp: Timestamp.now() });
        }
      }).catch(e => console.error('[sweepStaleWalletTopUps] txn error:', e.message));

      resolved++;
    }
    console.log(`[sweepStaleWalletTopUps] Resolved ${resolved}/${stale.size} stale top-ups`);
  }
);
