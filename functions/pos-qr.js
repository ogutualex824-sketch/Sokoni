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

const _verify                 = require('./shared/intasend-verify');
const _gateway                = require('./shared/stk-gateway');
const _identity               = require('./shared/merchant-identity');
const https                   = require('https');

const QR_SIGNING_SECRET   = defineSecret('QR_SIGNING_SECRET');
const INTASEND_PRIVATE_KEY = defineSecret('INTASEND_PRIVATE_KEY');

/* A v2 FUNCTION REACHES A SECRET ONLY IF IT NAMES IT, however correct the code is. B9.4.3 shipped
   a rail whose signing secret was declared on the two callables that READ handoff codes and missed
   on the one that MINTS them — in production every acceptance refused NO_SIGNING_KEY. So the
   completion callable, which is the one that now calls IntaSend, declares the key explicitly.
   `OPT` keeps the narrower set: only the two callables that talk to IntaSend — the SENDER
   (initiatePOSQRPayment, P2) and the VERIFIER (completePOSQRPayment, P1) — carry the key. */
const OPT       = { region: 'us-central1', enforceAppCheck: true, memory: '256MiB', secrets: [QR_SIGNING_SECRET] };
const OPT128    = { region: 'us-central1', enforceAppCheck: true, memory: '128MiB', secrets: [QR_SIGNING_SECRET] };
const OPT_GATEWAY = { region: 'us-central1', enforceAppCheck: true, memory: '256MiB',
  secrets: [QR_SIGNING_SECRET, INTASEND_PRIVATE_KEY] };

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

/* One spelling of the masked number, so the two "prompt sent" branches cannot drift into
   showing the customer a differently-formatted phone for the same event. */
const _maskPhone = (p) => String(p).replace(/(\d{3})(\d{3})(\d{3})(\d{3})/, '+$1 $2 $3 $4');

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
    const sellerVerified = !!(seller.verified || seller.isVerified);

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
  OPT_GATEWAY,
  async (request) => {
    const { transactionId, method, phone } = request.data;

    if (!transactionId || typeof transactionId !== 'string' || transactionId.length !== 32) {
      throw new HttpsError('invalid-argument', 'Invalid payment reference');
    }

    /* ── P2 — THE CALLER NAMES A SALE AND A PHONE. IT DOES NOT NAME A PRICE. ──────────────
       The amount comes from `posPayments/{id}.total`, written by the server at QR creation
       from validated items. A payload carrying an amount is REFUSED rather than ignored:
       silently dropping it would teach a caller that sending it is harmless, and would hide a
       client that believes it is setting the charge. Same reasoning as Gate C's
       `assertNoCheckoutPricing`. */
    const _forbidden = ['amount', 'total', 'subtotal', 'tax', 'discount', 'currency', 'items']
      .filter((f) => (request.data || {})[f] !== undefined);
    if (_forbidden.length) {
      throw new HttpsError('invalid-argument',
        'The sale total is server-authoritative; remove: ' + _forbidden.join(', '));
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

      /* ── P2 — THE PROMPT IS ACTUALLY SENT ────────────────────────────────────────────────
         What stood here wrote `pendingMpesaPhone`, answered "M-Pesa prompt sent… Check your
         phone", and called NO GATEWAY, under a comment reading "Delegate to existing
         initiateSTKPush CF pattern". There was no delegation. The customer stood at the till
         waiting for a prompt that was never going to arrive — 5 of the rail's stuck `pending`
         rows are exactly that.

         CREATED ≠ PROMPTED ≠ ACCEPTED ≠ PAID. This function may establish that the gateway
         ACCEPTED the request. It must never mark the payment complete or create an order:
         only `completePOSQRPayment` may do that, and only after independently verifying with
         IntaSend (P1). */

      /* ── 1. SINGLE-FLIGHT, BEFORE THE GATEWAY ───────────────────────────────────────────
         A reservation taken AFTER the request cannot prevent the second request — the window
         it needs to cover is exactly the one it would be sitting outside of. `create()` is
         atomic: two taps race, one wins, the loser converges on the winner's outcome instead
         of issuing a second prompt (and a second potential charge). */
      const attemptRef = db.collection('paymentAttempts').doc(transactionId);
      let reserved = false;
      try {
        await attemptRef.create({
          transactionId, sellerId: data.sellerId, phone: normPhone,
          amount: data.total, state: 'RESERVED', createdAt: _now(),
        });
        reserved = true;
      } catch (e) {
        /* ALREADY_EXISTS (code 6): somebody got here first. Report what that attempt became
           rather than starting a second one. */
        const prior = (await attemptRef.get()).data() || {};
        if (prior.state === 'GATEWAY_ACCEPTED') {
          return {
            status:  'stk_initiated',
            message: `M-Pesa prompt sent to ${_maskPhone(normPhone)}. Check your phone.`,
            phone:   normPhone, total: data.total, currency: data.currency,
            checkoutId: prior.checkoutId || null, deduplicated: true,
          };
        }
        throw new HttpsError('aborted',
          'A payment request for this sale is already in progress. Please wait.');
      }

      /* ── 2. WHO THE CUSTOMER IS PAYING ──────────────────────────────────────────────────
         Resolved through the certified authority, from `shops/{sellerId}.name` — NOT from
         `data.sellerName`, which `generatePOSPaymentQR` fills with a
         `|| 'SOKONI Merchant'` fallback that merchant-identity exists to forbid. Unresolved
         yields the platform-only string; it never names a shop it cannot prove. */
      let _identityShop = _identity.resolveMerchantIdentity([], {});
      try {
        const shopSnap = await db.collection('shops').doc(String(data.sellerId)).get();
        if (shopSnap.exists) {
          _identityShop = _identity.resolveMerchantIdentity(
            [String(data.sellerId)], { [String(data.sellerId)]: shopSnap.data() || {} });
        }
      } catch (_) { /* fail closed to the platform-only narrative */ }

      /* ── 3. Send ────────────────────────────────────────────────────────────────────────
         The amount is `data.total` — written by the server at QR creation from validated
         items. The caller supplies a phone and nothing else that touches money. */
      const payload = _gateway.buildPayload({
        phone:      normPhone,
        amountKES:  data.total,
        narrative:  _identity.narrativeFor(_identityShop, { channel: 'till', amountKES: data.total }),
        apiRef:     transactionId,
      });

      let outcome, gwStatus = 0, gwData = null;
      try {
        const res = await _gateway.pushSTK({
          payload, privateKey: INTASEND_PRIVATE_KEY.value(),
          sandbox: process.env.INTASEND_SANDBOX === 'true', https,
        });
        gwStatus = res.status; gwData = res.data;
        outcome = _gateway.classifyOutcome(gwStatus);
      } catch (e) {
        /* A non-answer. NOT a rejection: the request may have been processed. */
        outcome = 'OUTCOME_UNKNOWN';
      }

      if (outcome === 'GATEWAY_ACCEPTED') {
        const checkoutId = _gateway.checkoutIdOf(gwData);
        await attemptRef.update({ state: 'GATEWAY_ACCEPTED', checkoutId, acceptedAt: _now() });
        await ref.update({
          pendingMpesaPhone:  normPhone,
          pendingMethod:      'mpesa',
          paymentInitiatedAt: _now(),
          stkState:           'GATEWAY_ACCEPTED',
          gatewayCheckoutId:  checkoutId,
        });
        /* "Sent" is claimed HERE and nowhere else — the one branch where the gateway said yes. */
        return {
          status:  'stk_initiated',
          message: `M-Pesa prompt sent to ${_maskPhone(normPhone)}. Check your phone.`,
          phone:   normPhone, total: data.total, currency: data.currency, checkoutId,
        };
      }

      if (outcome === 'GATEWAY_REJECTED') {
        /* The gateway ANSWERED, and said no. Nothing is in flight, so release the reservation
           and let the cashier try again. */
        await attemptRef.delete().catch(() => {});
        throw new HttpsError('failed-precondition',
          'The payment provider refused the request. Please try again.');
      }

      /* OUTCOME_UNKNOWN — 5xx or no answer at all. The reservation is HELD, deliberately:
         no response is not no charge, and releasing it would let a retry issue a second
         prompt for a request that may already have reached the customer. */
      await attemptRef.update({ state: 'OUTCOME_UNKNOWN', heldAt: _now() }).catch(() => {});
      throw new HttpsError('unavailable',
        'We could not confirm the payment request reached M-PESA. Check the customer\'s phone before retrying.');
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
  OPT_GATEWAY,
  async (request) => {
    const auth = request.auth;
    if (!_isAuthed(auth)) throw new HttpsError('unauthenticated', 'Login required');

    /* ── P1 — THE CALLER'S REFERENCES ARE NOT EVIDENCE ────────────────────────────────────
       This used to destructure `mpesaRef` / `intasendRef` from request.data, run them through a
       length sanitiser, and write `status: 'paid'` plus a completed order. A string is not a
       payment: the seller was authorising their own sale, and a fabricated reference was
       indistinguishable from a real one.

       They are still accepted — a cashier reading a code off their phone is a reasonable thing
       for a UI to send — but they are recorded as a CLAIM and never consulted to decide the
       outcome. What decides it is `shared/intasend-verify`, asked about the reference WE own.

       STK INITIATION IS NOT PAYMENT CONFIRMATION. P2 may successfully create the IntaSend
       transaction and put a prompt on the customer's phone; this handler still requires the
       gateway's own record to report COMPLETE before anything becomes paid. */
    const { transactionId, mpesaRef, intasendRef, paymentMethod } = request.data;
    if (!transactionId) throw new HttpsError('invalid-argument', 'transactionId required');

    const db  = fdb();
    const ref = db.collection('posPayments').doc(transactionId);

    /* ── Verify BEFORE the transaction opens ──────────────────────────────────────────────
       Firestore transactions may not perform network I/O: the retry that makes them atomic
       would re-issue the call. The read below is therefore a pre-check whose figures are
       re-asserted inside the transaction against the document as it is then. */
    const preSnap = await ref.get();
    if (!preSnap.exists) throw new HttpsError('not-found', 'Payment not found');
    const pre = preSnap.data() || {};
    if (pre.status === 'paid') {
      return { status: 'already_paid', receiptId: pre.receiptId, orderId: pre.orderId };
    }
    if (pre.sellerId !== auth.uid && !_isAdmin(auth)) {
      throw new HttpsError('permission-denied', 'Only the seller can complete this payment');
    }

    /* The anchor is OUR transactionId — the api_ref P2's sender puts on the gateway record.
       Deliberately not `intasendRef` from the caller: verifying a reference the caller chose
       would let them point us at somebody else's completed payment. */
    const _verdict = await _verify.verifyPayment({
      reference:      transactionId,
      expectedAmount: Number(pre.total),
      privateKey:     INTASEND_PRIVATE_KEY.value(),
      sandbox:        process.env.INTASEND_SANDBOX === 'true',
      fetchImpl:      fetch,
    });
    if (!_verdict.verified) {
      /* FAIL CLOSED, AND WRITE NOTHING. Not a status change, not an attempt counter — a refusal
         that mutated the document would let a caller drive state by failing repeatedly. */
      throw new HttpsError('failed-precondition',
        'Payment could not be verified with the provider: ' + _verdict.reason);
    }

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

      /* ── P1 — DETERMINISTIC IDS, DERIVED FROM THE TRANSACTION ────────────────────────────
         These were `Date.now()` plus random bytes, so two confirmations of the SAME payment
         produced two different orderIds. The status guard above stops the common case, but a
         retry racing a partial failure could still mint a second order for one sale — and an
         order id that cannot be recomputed cannot be reconciled afterwards either.

         Derived from `transactionId` instead: the same sale always yields the same pair, so a
         duplicate confirmation overwrites rather than multiplies. The hash is truncated for
         readability on a receipt; collision risk across one merchant's sales is negligible and
         the document id itself is still the transaction. */
      const _idHash = crypto.createHash('sha256').update(String(transactionId)).digest('hex')
        .slice(0, 10).toUpperCase();
      const receiptId = `RCP-${_idHash}`;
      const orderId   = `ORD-POS-${_idHash}`;

      /* Update payment record */
      tx.update(ref, {
        status:         'paid',
        paidAt:         _now(),
        paymentMethod:  _san(paymentMethod || 'mpesa', 20),
        /* The caller's strings are kept as a CLAIM for the cashier's own reconciliation, and
           named so nobody later mistakes them for proof. What the gateway said is recorded
           separately, alongside the figure it actually reported. */
        claimedMpesaRef:    _san(mpesaRef || '', 50),
        claimedIntasendRef: _san(intasendRef || '', 80),
        gatewayState:       _verdict.state,
        gatewayAmount:      _verdict.amount,
        gatewayInvoiceId:   _verdict.invoiceId || null,
        gatewayTrackingId:  _verdict.trackingId || null,
        verifiedAt:         _now(),
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
        /* The ORDER records what the gateway confirmed, not what the caller typed. An order is
           the document the rest of the platform reconciles against; a claimed reference on it
           would propagate the caller's assertion into every downstream reader. */
        gatewayInvoiceId: _verdict.invoiceId || null,
        gatewayAmount:    _verdict.amount,
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
