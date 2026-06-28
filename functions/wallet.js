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

const { onCall } = require('firebase-functions/v2/https');
const { getFirestore, FieldValue, Timestamp } = require('firebase-admin/firestore');
const { defineSecret } = require('firebase-functions/params');

const INTASEND_KEY = defineSecret('INTASEND_PRIVATE_KEY');

// ─── Helpers ───────────────────────────────────────────────────────────────

function _requireAuth(ctx) {
  if (!ctx.auth) throw new Error('UNAUTHENTICATED: Login required');
}

function _requireAdmin(ctx) {
  if (!ctx.auth?.token?.admin && !ctx.auth?.token?.superAdmin) {
    throw new Error('FORBIDDEN: Admin access required');
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

exports.getWalletBalance = onCall({ cors: true }, async (request) => {
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
  { cors: true, secrets: [INTASEND_KEY] },
  async (request) => {
    _requireAuth(request);

    const db = getFirestore();
    const uid = request.auth.uid;
    const { amount, phone } = request.data || {};

    // Validate amount
    const amt = Number(amount);
    if (!Number.isInteger(amt) || amt < 10 || amt > 70000) {
      throw new Error('INVALID_ARGUMENT: Amount must be a whole number between KSh 10 and KSh 70,000');
    }

    // Validate & normalize phone
    const normalizedPhone = _normalizePhone(phone);
    if (!normalizedPhone) {
      throw new Error('INVALID_ARGUMENT: Phone must be a valid Kenyan number (07XX or 01XX, with or without country code)');
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
      const client = new IntaSend(
        process.env.INTASEND_PRIVATE_KEY || INTASEND_KEY.value(),
        { testMode: process.env.NODE_ENV !== 'production' }
      );

      const response = await client.collection().charge({
        first_name: 'SOKONI',
        last_name: 'Wallet',
        email: 'wallet@mysokoni.co.ke',
        host: 'https://mysokoni.co.ke',
        amount: amt,
        currency: 'KES',
        api_ref: txId,
        phone_number: normalizedPhone,
      });

      invoiceId = response?.invoice?.invoice_id ?? response?.id ?? null;
      await txRef.update({ invoiceId });
    } catch (err) {
      // IntaSend failure — mark transaction failed and surface a clean error
      await txRef.update({ status: 'failed' });
      await walletRef.update({ pendingTopUp: null });
      console.error('[wallet] IntaSend STK push error:', err.message);
      throw new Error('PAYMENT_FAILED: Unable to initiate M-Pesa prompt. Please try again or contact support.');
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
  { cors: true, secrets: [INTASEND_KEY] },
  async (request) => {
    _requireAuth(request);

    const db = getFirestore();
    const uid = request.auth.uid;
    const { txId } = request.data || {};

    if (!txId) throw new Error('INVALID_ARGUMENT: txId is required');

    const txRef = db.collection('walletTransactions').doc(_san(txId, 128));
    const txSnap = await txRef.get();

    if (!txSnap.exists) throw new Error('NOT_FOUND: Transaction not found');

    const tx = txSnap.data();
    if (tx.uid !== uid) throw new Error('FORBIDDEN: This transaction does not belong to you');
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
      const client = new IntaSend(
        process.env.INTASEND_PRIVATE_KEY || INTASEND_KEY.value(),
        { testMode: process.env.NODE_ENV !== 'production' }
      );

      const result = await client.collection().status(tx.invoiceId);
      invoiceStatus = result?.invoice?.state ?? result?.state ?? null;
    } catch (err) {
      console.error('[wallet] IntaSend status check error:', err.message);
      throw new Error('PAYMENT_CHECK_FAILED: Unable to verify payment status. Please try again shortly.');
    }

    // Normalise IntaSend states
    const paid = invoiceStatus === 'COMPLETE';
    const failed = ['FAILED', 'CANCELLED', 'EXPIRED'].includes(invoiceStatus);

    if (paid) {
      const walletRef = db.collection('wallets').doc(uid);
      let newBalance = 0;

      await db.runTransaction(async (t) => {
        const walletSnap = await t.get(walletRef);
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

exports.spendFromWallet = onCall({ cors: true }, async (request) => {
  _requireAuth(request);

  const db = getFirestore();
  const uid = request.auth.uid;
  const { amount, orderId, description } = request.data || {};

  const amt = Number(amount);
  if (!Number.isInteger(amt) || amt <= 0) {
    throw new Error('INVALID_ARGUMENT: Amount must be a positive whole number');
  }
  if (!orderId) throw new Error('INVALID_ARGUMENT: orderId is required');

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

    if (!walletSnap.exists) throw new Error('WALLET_NOT_FOUND: Wallet does not exist');

    const current = walletSnap.data().balance ?? 0;
    if (current < amt) {
      throw new Error(`INSUFFICIENT_FUNDS: Wallet balance (KSh ${current}) is less than required KSh ${amt}`);
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

exports.getWalletTransactions = onCall({ cors: true }, async (request) => {
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

exports.requestSellerPayout = onCall({ cors: true }, async (request) => {
  _requireAuth(request);

  const db = getFirestore();
  const uid = request.auth.uid;
  const { amount, method, accountNumber, bankCode, bankName } = request.data || {};

  const amt = Number(amount);
  if (!Number.isInteger(amt) || amt < 500) {
    throw new Error('INVALID_ARGUMENT: Minimum payout amount is KSh 500');
  }

  const validMethods = ['mpesa', 'bank'];
  if (!validMethods.includes(method)) {
    throw new Error('INVALID_ARGUMENT: method must be "mpesa" or "bank"');
  }

  const sanitizedAccount = _san(accountNumber, 30);
  if (!sanitizedAccount) {
    throw new Error('INVALID_ARGUMENT: accountNumber is required');
  }

  if (method === 'mpesa') {
    const normalizedPhone = _normalizePhone(sanitizedAccount);
    if (!normalizedPhone) {
      throw new Error('INVALID_ARGUMENT: M-Pesa account must be a valid Kenyan phone number');
    }
  }

  if (method === 'bank' && !bankCode) {
    throw new Error('INVALID_ARGUMENT: bankCode is required for bank payouts');
  }

  // Check wallet balance
  const walletSnap = await db.collection('wallets').doc(uid).get();
  const balance = walletSnap.exists ? (walletSnap.data().balance ?? 0) : 0;
  if (balance < amt) {
    throw new Error(`INSUFFICIENT_FUNDS: Available balance (KSh ${balance}) is less than requested KSh ${amt}`);
  }

  const reqId = _genId('pout');
  await db.collection('payoutRequests').doc(reqId).set({
    sellerUid: uid,
    amount: amt,
    method,
    accountNumber: sanitizedAccount,
    bankCode: method === 'bank' ? _san(bankCode, 20) : null,
    bankName: method === 'bank' ? _san(bankName, 100) : null,
    status: 'pending',
    note: null,
    processedAt: null,
    createdAt: Timestamp.now(),
  });

  return {
    success: true,
    requestId: reqId,
    message: 'Payout request submitted. Processing within 1–3 business days.',
  };
});

// ─── 7. getPayoutHistory ───────────────────────────────────────────────────

exports.getPayoutHistory = onCall({ cors: true }, async (request) => {
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

exports.adminProcessPayout = onCall({ cors: true }, async (request) => {
  _requireAuth(request);
  _requireAdmin(request);

  const db = getFirestore();
  const { requestId, status, note } = request.data || {};

  if (!requestId) throw new Error('INVALID_ARGUMENT: requestId is required');

  const validStatuses = ['approved', 'rejected', 'paid'];
  if (!validStatuses.includes(status)) {
    throw new Error('INVALID_ARGUMENT: status must be "approved", "rejected", or "paid"');
  }

  const reqRef = db.collection('payoutRequests').doc(_san(requestId, 128));
  const reqSnap = await reqRef.get();

  if (!reqSnap.exists) throw new Error('NOT_FOUND: Payout request not found');

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
      const [walletSnap, txSnap] = await Promise.all([t.get(walletRef), t.get(txRef)]);

      if (!txSnap.exists) {
        const current = walletSnap.exists ? (walletSnap.data().balance ?? 0) : 0;
        const newBalance = Math.max(0, current - payout.amount);

        if (walletSnap.exists) {
          t.update(walletRef, { balance: newBalance });
        } else {
          t.set(walletRef, {
            uid: payout.sellerUid,
            balance: 0,
            currency: 'KES',
            lastTopUp: null,
            pendingTopUp: null,
            createdAt: Timestamp.now(),
          });
        }

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
  } else {
    await reqRef.update(update);
  }

  return { success: true };
});

// ─── 9. adminGetPendingPayouts ─────────────────────────────────────────────

exports.adminGetPendingPayouts = onCall({ cors: true }, async (request) => {
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

exports.refundToWallet = onCall({ cors: true }, async (request) => {
  _requireAuth(request);

  const db = getFirestore();
  const callerUid = request.auth.uid;
  const { orderId, amount, reason, targetUid } = request.data || {};

  // Determine whose wallet to credit
  let recipientUid = callerUid;
  if (targetUid && targetUid !== callerUid) {
    _requireAdmin(request);
    recipientUid = _san(targetUid, 128);
  }

  const amt = Number(amount);
  if (!Number.isInteger(amt) || amt <= 0) {
    throw new Error('INVALID_ARGUMENT: Refund amount must be a positive whole number');
  }
  if (!orderId) throw new Error('INVALID_ARGUMENT: orderId is required');

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
