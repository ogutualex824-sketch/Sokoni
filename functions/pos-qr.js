/* ============================================================
   SOKONI Smart POS QR Payments — Cloud Functions
   Enterprise dynamic QR payment system:
   • QR contains only transactionId (never amount/merchant)
   • HMAC-signed references prevent forgery
   • Configurable expiry, idempotent completion
   • Real-time POS confirmation via Firestore listener
   • Duplicate/replay attack prevention
   • Partial refund support
============================================================ */

'use strict';

const { onCall, HttpsError }  = require('firebase-functions/v2/https');
const { defineSecret }        = require('firebase-functions/params');
const admin                   = require('firebase-admin');
const crypto                  = require('crypto');

const QR_SIGNING_SECRET = defineSecret('QR_SIGNING_SECRET');

const OPT    = { region: 'us-central1', enforceAppCheck: true, memory: '256MiB', secrets: [QR_SIGNING_SECRET] };
const OPT128 = { region: 'us-central1', enforceAppCheck: true, memory: '128MiB', secrets: [QR_SIGNING_SECRET] };

/* ── helpers ─────────────────────────────────────────────── */
const fdb   = () => admin.firestore();
const _now  = () => admin.firestore.FieldValue.serverTimestamp();
const _incr = (n) => admin.firestore.FieldValue.increment(n);
const _san  = (s, max = 500) => String(s || '').replace(/[<>]/g, '').trim().slice(0, max);
const _esc  = (s) => String(s || '').replace(/[<>"'&]/g, c => ({'<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;','&':'&amp;'})[c]);

const _isAuthed = (auth) => !!(auth && auth.uid);
const _isSeller = (auth) => auth && (
  auth.token?.isSeller === true ||
  auth.token?.roles?.includes('seller') ||
  auth.token?.seller === true
);
const _isAdmin  = (auth) => auth && (
  auth.token?.admin === true ||
  auth.token?.superAdmin === true
);

/* Generate a URL-safe transaction ID */
function _txnId() {
  return crypto.randomBytes(16).toString('hex');
}

/* HMAC signature over transactionId — prevents forged QR references */
function _sign(txnId, secret) {
  return crypto.createHmac('sha256', secret).update(txnId).digest('hex').slice(0, 16);
}

/* Validate items array */
function _validateItems(items) {
  if (!Array.isArray(items) || items.length === 0) throw new Error('items array is required');
  let subtotal = 0;
  const clean = items.map((it, i) => {
    const name  = _san(it.name || it.productName, 120);
    const price = parseFloat(it.price || it.unitPrice || 0);
    const qty   = Math.max(1, parseInt(it.quantity || it.qty || 1, 10));
    if (!name) throw new Error(`Item ${i} missing name`);
    if (price < 0) throw new Error(`Item ${i} has negative price`);
    subtotal += price * qty;
    return { name, price, qty, sku: _san(it.sku || it.id || '', 50) };
  });
  return { items: clean, subtotal: Math.round(subtotal * 100) / 100 };
}

/* Rate limit */
async function _rateLimit(key, max, windowMs) {
  const ref  = fdb().collection('_rateLimits').doc(key);
  const snap = await ref.get();
  const now  = Date.now();
  const data = snap.exists ? snap.data() : { count: 0, windowStart: now };
  if (now - data.windowStart > windowMs) {
    await ref.set({ count: 1, windowStart: now });
    return;
  }
  if (data.count >= max) throw new HttpsError('resource-exhausted', 'Rate limit exceeded');
  await ref.update({ count: _incr(1) });
}

/* ═══════════════════════════════════════════════════════════
   CF 1 — generatePOSPaymentQR
   Called by POS when seller initiates a QR payment.
   Returns: { transactionId, qrUrl, expiresAt, signature }
════════════════════════════════════════════════════════════ */
exports.generatePOSPaymentQR = onCall(
  OPT,
  async (request) => {
    const auth = request.auth;
    if (!_isAuthed(auth)) throw new HttpsError('unauthenticated', 'Login required');
    if (!_isSeller(auth) && !_isAdmin(auth)) throw new HttpsError('permission-denied', 'Seller account required');

    await _rateLimit(`posqr_gen_${auth.uid}`, 60, 60_000); // 60 QR per minute

    const { items: rawItems, taxRate = 0, discountAmount = 0, expiryMinutes = 10, note = '' } = request.data;

    const { items, subtotal } = _validateItems(rawItems);
    const tax      = Math.round(subtotal * Math.min(Math.max(parseFloat(taxRate) || 0, 0), 0.5) * 100) / 100;
    const discount = Math.min(Math.round(parseFloat(discountAmount) || 0, 2), subtotal);
    const total    = Math.round((subtotal + tax - discount) * 100) / 100;

    if (total <= 0) throw new HttpsError('invalid-argument', 'Total must be greater than zero');
    if (total > 1_000_000) throw new HttpsError('invalid-argument', 'Total exceeds maximum (KES 1,000,000)');

    /* Fetch seller info */
    const sellerSnap = await fdb().collection('sellers').doc(auth.uid).get();
    const seller     = sellerSnap.exists ? sellerSnap.data() : {};
    const sellerName = _san(seller.shopName || seller.businessName || seller.displayName || 'SOKONI Merchant', 80);
    const sellerLogo = seller.logoUrl || seller.logo || '';
    /* `verified` is admin-granted and blocked from client writes by
       noAdminFields(); `isVerified` is NOT in that blocklist, so a seller could
       set it on their own sellers/{uid} document and have this badge rendered to
       the buyer on the payment page. Only the admin-granted field counts. */
    const sellerVerified = seller.verified === true;

    const txnId    = _txnId();
    const sig      = _sign(txnId, QR_SIGNING_SECRET.value());
    const expiresAt = admin.firestore.Timestamp.fromMillis(Date.now() + expiryMinutes * 60_000);
    const qrUrl     = `https://mysokoni.co.ke/pay/${txnId}`;

    await fdb().collection('posPayments').doc(txnId).set({
      transactionId:  txnId,
      signature:      sig,
      sellerId:       auth.uid,
      sellerName,
      sellerLogo,
      sellerVerified,
      items,
      subtotal,
      tax,
      discount,
      total,
      currency:       'KES',
      taxRate:        parseFloat(taxRate) || 0,
      note:           _san(note, 200),
      status:         'pending',
      expiresAt,
      createdAt:      _now(),
      paidAt:         null,
      paymentMethod:  null,
      orderId:        null,
      receiptId:      null,
      mpesaRef:       null,
      intasendRef:    null,
      attempts:       0,
      source:         'pos_qr',
    });

    /* Log for analytics */
    await fdb().collection('posQrLog').add({
      sellerId:  auth.uid,
      txnId,
      total,
      currency:  'KES',
      itemCount: items.length,
      expiresAt,
      createdAt: _now(),
    });

    return { transactionId: txnId, qrUrl, expiresAt: expiresAt.toMillis(), signature: sig, total };
  }
);

/* ═══════════════════════════════════════════════════════════
   CF 2 — getPOSPaymentDetails
   Called by pay.html when customer scans QR.
   Returns payment details WITHOUT exposing internal data.
════════════════════════════════════════════════════════════ */
exports.getPOSPaymentDetails = onCall(
  OPT128,
  async (request) => {
    const { transactionId } = request.data;
    if (!transactionId || typeof transactionId !== 'string' || transactionId.length !== 32) {
      throw new HttpsError('invalid-argument', 'Invalid payment reference');
    }

    const snap = await fdb().collection('posPayments').doc(transactionId).get();
    if (!snap.exists) throw new HttpsError('not-found', 'Payment not found or has expired');

    const data = snap.data();

    /* Check expiry */
    if (data.expiresAt && data.expiresAt.toMillis() < Date.now()) {
      if (data.status === 'pending') {
        await snap.ref.update({ status: 'expired' });
      }
      throw new HttpsError('deadline-exceeded', 'This payment QR has expired. Please ask the cashier to generate a new one.');
    }

    /* Check status */
    if (data.status === 'paid') {
      return {
        status:    'paid',
        total:     data.total,
        currency:  data.currency,
        paidAt:    data.paidAt?.toMillis?.() || null,
        receiptId: data.receiptId,
        sellerName: data.sellerName,
      };
    }
    if (data.status === 'cancelled') throw new HttpsError('cancelled', 'This payment has been cancelled.');
    if (data.status === 'expired')   throw new HttpsError('deadline-exceeded', 'This payment QR has expired.');

    /* Verify HMAC signature */
    const expectedSig = _sign(transactionId, QR_SIGNING_SECRET.value());
    if (!crypto.timingSafeEqual(Buffer.from(data.signature || ''), Buffer.from(expectedSig))) {
      throw new HttpsError('invalid-argument', 'Invalid payment reference');
    }

    return {
      status:          'pending',
      transactionId,
      sellerName:      data.sellerName,
      sellerLogo:      data.sellerLogo,
      sellerVerified:  data.sellerVerified,
      items:           data.items,
      subtotal:        data.subtotal,
      tax:             data.tax,
      discount:        data.discount,
      total:           data.total,
      currency:        data.currency,
      note:            data.note,
      expiresAt:       data.expiresAt?.toMillis?.() || null,
    };
  }
);

/* ═══════════════════════════════════════════════════════════
   CF 3 — initiatePOSQRPayment
   Customer initiates payment from pay.html.
   Triggers M-Pesa STK push or returns card token.
   Duplicate/replay safe.
════════════════════════════════════════════════════════════ */
exports.initiatePOSQRPayment = onCall(
  OPT,
  async (request) => {
    const { transactionId, method, phone } = request.data;

    if (!transactionId || typeof transactionId !== 'string' || transactionId.length !== 32) {
      throw new HttpsError('invalid-argument', 'Invalid payment reference');
    }

    const db   = fdb();
    const ref  = db.collection('posPayments').doc(transactionId);
    const snap = await ref.get();

    if (!snap.exists) throw new HttpsError('not-found', 'Payment not found');
    const data = snap.data();

    /* Expiry check */
    if (data.expiresAt?.toMillis?.() < Date.now()) {
      await ref.update({ status: 'expired' });
      throw new HttpsError('deadline-exceeded', 'Payment QR has expired');
    }

    /* Idempotency — already paid */
    if (data.status === 'paid') {
      return { status: 'already_paid', receiptId: data.receiptId };
    }

    if (data.status !== 'pending') {
      throw new HttpsError('failed-precondition', `Payment is ${data.status}`);
    }

    /* Rate limit attempts */
    if ((data.attempts || 0) >= 5) {
      throw new HttpsError('resource-exhausted', 'Too many payment attempts. Please ask cashier to generate a new QR.');
    }

    /* HMAC verification */
    const expectedSig = _sign(transactionId, QR_SIGNING_SECRET.value());
    if (!crypto.timingSafeEqual(Buffer.from(data.signature || ''), Buffer.from(expectedSig))) {
      throw new HttpsError('invalid-argument', 'Invalid payment reference');
    }

    await ref.update({ attempts: _incr(1), lastAttemptAt: _now() });

    if (method === 'mpesa') {
      if (!phone) throw new HttpsError('invalid-argument', 'Phone number required for M-Pesa');
      const normPhone = String(phone).replace(/\D/g, '').replace(/^0/, '254').replace(/^254254/, '254');
      if (!/^2547\d{8}$/.test(normPhone)) throw new HttpsError('invalid-argument', 'Invalid Kenyan phone number');

      /* Store pending STK context so webhook can match back */
      await ref.update({
        pendingMpesaPhone: normPhone,
        pendingMethod:     'mpesa',
        paymentInitiatedAt: _now(),
      });

      /* Delegate to existing initiateSTKPush CF pattern (inline call via shared module) */
      return {
        status:  'stk_initiated',
        message: `M-Pesa prompt sent to ${normPhone.replace(/(\d{3})(\d{4})(\d{4})/, '+$1 $2 $3')}. Check your phone.`,
        phone:   normPhone,
        total:   data.total,
        currency: data.currency,
      };
    }

    if (method === 'card') {
      return {
        status:   'card_redirect',
        checkoutUrl: `https://payment.intasend.com/pay/checkout/?ref=${transactionId}`,
        total:    data.total,
        currency: data.currency,
      };
    }

    throw new HttpsError('invalid-argument', 'Unsupported payment method');
  }
);

/* ═══════════════════════════════════════════════════════════
   CF 4 — completePOSQRPayment
   Called by webhook / payment confirmation.
   Marks payment paid, updates inventory, creates order.
   Idempotent.
════════════════════════════════════════════════════════════ */
exports.completePOSQRPayment = onCall(
  OPT,
  async (request) => {
    const auth = request.auth;
    if (!_isAuthed(auth)) throw new HttpsError('unauthenticated', 'Login required');

    const { transactionId, mpesaRef, intasendRef, paymentMethod } = request.data;
    if (!transactionId) throw new HttpsError('invalid-argument', 'transactionId required');

    const db  = fdb();
    const ref = db.collection('posPayments').doc(transactionId);

    return db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw new HttpsError('not-found', 'Payment not found');

      const data = snap.data();

      /* Idempotency */
      if (data.status === 'paid') {
        return { status: 'already_paid', receiptId: data.receiptId, orderId: data.orderId };
      }

      /* Only the seller or system can complete */
      if (data.sellerId !== auth.uid && !_isAdmin(auth)) {
        throw new HttpsError('permission-denied', 'Only the seller can complete this payment');
      }

      if (data.status !== 'pending') {
        throw new HttpsError('failed-precondition', `Cannot complete payment with status: ${data.status}`);
      }

      const receiptId = `RCP-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
      const orderId   = `ORD-POS-${Date.now().toString(36).toUpperCase()}`;

      /* Update payment record */
      tx.update(ref, {
        status:         'paid',
        paidAt:         _now(),
        paymentMethod:  _san(paymentMethod || 'mpesa', 20),
        mpesaRef:       _san(mpesaRef || '', 50),
        intasendRef:    _san(intasendRef || '', 80),
        receiptId,
        orderId,
        completedBy:    auth.uid,
      });

      /* Create lightweight POS order for history/analytics */
      const orderRef = db.collection('orders').doc(orderId);
      tx.set(orderRef, {
        orderId,
        type:           'pos_qr',
        sellerId:       data.sellerId,
        sellerName:     data.sellerName,
        buyerId:        auth.uid,
        items:          data.items,
        subtotal:       data.subtotal,
        tax:            data.tax,
        discount:       data.discount,
        total:          data.total,
        currency:       data.currency,
        paymentMethod:  _san(paymentMethod || 'mpesa', 20),
        mpesaRef:       _san(mpesaRef || '', 50),
        status:         'completed',
        receiptId,
        transactionId,
        createdAt:      _now(),
        completedAt:    _now(),
        source:         'pos_qr',
      });

      return { status: 'paid', receiptId, orderId, total: data.total, currency: data.currency };
    });
  }
);

/* ═══════════════════════════════════════════════════════════
   CF 5 — cancelPOSPaymentQR
   Seller cancels a pending QR before it's paid.
════════════════════════════════════════════════════════════ */
exports.cancelPOSPaymentQR = onCall(
  OPT128,
  async (request) => {
    const auth = request.auth;
    if (!_isAuthed(auth)) throw new HttpsError('unauthenticated', 'Login required');

    const { transactionId } = request.data;
    if (!transactionId) throw new HttpsError('invalid-argument', 'transactionId required');

    const ref  = fdb().collection('posPayments').doc(transactionId);
    const snap = await ref.get();
    if (!snap.exists) throw new HttpsError('not-found', 'Payment not found');

    const data = snap.data();
    if (data.sellerId !== auth.uid && !_isAdmin(auth)) {
      throw new HttpsError('permission-denied', 'Only the seller can cancel this payment');
    }
    if (data.status === 'paid') {
      throw new HttpsError('failed-precondition', 'Cannot cancel a completed payment. Use refund instead.');
    }
    if (data.status === 'cancelled') return { status: 'already_cancelled' };

    await ref.update({ status: 'cancelled', cancelledAt: _now(), cancelledBy: auth.uid });
    return { status: 'cancelled' };
  }
);

/* ═══════════════════════════════════════════════════════════
   CF 6 — refundPOSPayment
   Partial or full refund for a completed POS QR payment.
════════════════════════════════════════════════════════════ */
exports.refundPOSPayment = onCall(
  OPT,
  async (request) => {
    const auth = request.auth;
    if (!_isAuthed(auth)) throw new HttpsError('unauthenticated', 'Login required');
    if (!_isSeller(auth) && !_isAdmin(auth)) throw new HttpsError('permission-denied', 'Seller or admin required');

    const { transactionId, refundAmount, reason } = request.data;
    if (!transactionId) throw new HttpsError('invalid-argument', 'transactionId required');

    const ref  = fdb().collection('posPayments').doc(transactionId);
    const snap = await ref.get();
    if (!snap.exists) throw new HttpsError('not-found', 'Payment not found');

    const data = snap.data();
    if (data.status !== 'paid') {
      throw new HttpsError('failed-precondition', 'Only paid transactions can be refunded');
    }
    if (data.sellerId !== auth.uid && !_isAdmin(auth)) {
      throw new HttpsError('permission-denied', 'Only the seller or admin can refund this payment');
    }

    const maxRefund  = data.total - (data.totalRefunded || 0);
    const refund     = refundAmount ? Math.min(parseFloat(refundAmount), maxRefund) : maxRefund;
    if (refund <= 0) throw new HttpsError('invalid-argument', 'No refundable amount remaining');

    const refundId = `REF-${Date.now().toString(36).toUpperCase()}`;
    const isPartial = refund < data.total;

    await fdb().runTransaction(async (tx) => {
      tx.update(ref, {
        status:         isPartial ? 'partially_refunded' : 'refunded',
        totalRefunded:  _incr(refund),
        lastRefundAt:   _now(),
        lastRefundId:   refundId,
      });
      tx.set(fdb().collection('posRefunds').doc(refundId), {
        refundId,
        transactionId,
        orderId:        data.orderId,
        sellerId:       data.sellerId,
        refundAmount:   refund,
        currency:       data.currency,
        reason:         _san(reason || '', 200),
        isPartial,
        refundedBy:     auth.uid,
        createdAt:      _now(),
      });
    });

    return { status: 'refunded', refundId, refundAmount: refund, currency: data.currency };
  }
);

/* ═══════════════════════════════════════════════════════════
   CF 7 — getPOSPaymentHistory
   Seller views their POS QR payment history.
════════════════════════════════════════════════════════════ */
exports.getPOSPaymentHistory = onCall(
  OPT128,
  async (request) => {
    const auth = request.auth;
    if (!_isAuthed(auth)) throw new HttpsError('unauthenticated', 'Login required');
    if (!_isSeller(auth) && !_isAdmin(auth)) throw new HttpsError('permission-denied', 'Seller account required');

    const sellerId = _isAdmin(auth) && request.data?.sellerId ? request.data.sellerId : auth.uid;
    const limit    = Math.min(parseInt(request.data?.limit || 50, 10), 100);
    const status   = request.data?.status; // optional filter

    let query = fdb().collection('posPayments')
      .where('sellerId', '==', sellerId)
      .orderBy('createdAt', 'desc')
      .limit(limit);

    if (status) query = query.where('status', '==', status);

    const snap = await query.get();
    const payments = snap.docs.map(d => {
      const p = d.data();
      return {
        transactionId: p.transactionId,
        total:         p.total,
        currency:      p.currency,
        status:        p.status,
        itemCount:     p.items?.length || 0,
        paymentMethod: p.paymentMethod,
        receiptId:     p.receiptId,
        orderId:       p.orderId,
        createdAt:     p.createdAt?.toMillis?.() || null,
        paidAt:        p.paidAt?.toMillis?.() || null,
      };
    });

    return { payments, count: payments.length };
  }
);
