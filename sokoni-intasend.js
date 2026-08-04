/**
 * SOKONI IntaSend Payment Engine  v2.0  (Production)
 *
 * Replaces ALL simulated payment flows with real IntaSend M-Pesa STK Push.
 *
 * Architecture:
 *   Client → Cloud Function (initiateSTKPush)
 *          → IntaSend API → M-Pesa STK Push to customer's phone
 *          → Customer enters PIN
 *          → IntaSend webhook → Cloud Function (intasendWebhook)
 *          → Firestore payments/{ref}.status = 'COMPLETE'
 *   Client polls payments/{ref} via Firestore realtime listener
 *   On COMPLETE → unlock booking, record commission
 *
 * Security guarantees:
 *   • No client-side payment approval — all confirmations via server webhook
 *   • Idempotency — duplicate STK pushes for same ref are blocked
 *   • Timeout — 90s M-Pesa PIN entry window, then auto-fail
 *   • Auth required — initiateSTKPush refuses unauthenticated callers
 */

(function (window) {
  'use strict';

  const log  = window.SokoniLogger || { log: ()=>{}, warn: ()=>{}, error: ()=>{} };
  const POLL_INTERVAL_MS   = 5000;   /* Poll Firestore every 5 seconds */
  const MAX_POLL_ATTEMPTS  = 18;     /* 18 × 5s = 90s M-Pesa PIN timeout */
  const CF_REGION          = 'us-central1';

  /* Active payment state — prevents opening two modals simultaneously */
  let _activePayment = null;

  /* ══════════════════════════════════════════════════════════════
     IDEMPOTENCY STORE  — sessionStorage keyed by idempotency key
     Prevents duplicate STK pushes if the user double-clicks or
     the page reloads mid-payment.
  ══════════════════════════════════════════════════════════════ */
  function _getIdempotencyKey(ref) {
    try {
      const store = JSON.parse(sessionStorage.getItem('_sk_pay_idem') || '{}');
      return store[ref] || null;
    } catch (_) { return null; }
  }

  function _setIdempotencyKey(ref, checkoutId) {
    try {
      const store = JSON.parse(sessionStorage.getItem('_sk_pay_idem') || '{}');
      store[ref] = checkoutId;
      sessionStorage.setItem('_sk_pay_idem', JSON.stringify(store));
    } catch (_) {}
  }

  function _clearIdempotencyKey(ref) {
    try {
      const store = JSON.parse(sessionStorage.getItem('_sk_pay_idem') || '{}');
      delete store[ref];
      sessionStorage.setItem('_sk_pay_idem', JSON.stringify(store));
    } catch (_) {}
  }

  /* ══════════════════════════════════════════════════════════════
     CLOUD FUNCTION CALLER  — generic callable wrapper
  ══════════════════════════════════════════════════════════════ */
  async function _callFunction(name, data) {
    const { getFunctions, httpsCallable } = await import(
      'https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js'
    );
    const fns = getFunctions(window.firebaseApp, CF_REGION);
    const fn  = httpsCallable(fns, name);
    const result = await fn(data);
    return result.data;
  }

  /* ══════════════════════════════════════════════════════════════
     FIRESTORE PAYMENT LISTENER  — realtime poll via onSnapshot
  ══════════════════════════════════════════════════════════════ */
  async function _waitForPaymentConfirmation(paymentRef, onStatus) {
    const { doc, onSnapshot } = await import(
      'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js'
    );
    const db = window.firebaseDB;
    if (!db) throw new Error('Firestore not ready');

    return new Promise((resolve, reject) => {
      let attempts = 0;
      let intervalId = null;
      let unsubscribe = null;

      const _done = (status, data) => {
        if (unsubscribe) unsubscribe();
        clearInterval(intervalId);
        if (status === 'COMPLETE') resolve(data);
        else reject(new Error(status === 'TIMEOUT' ? 'Payment timed out. Please try again.' : `Payment ${status}: ${data.failReason || 'Unknown error'}`));
      };

      /* Realtime Firestore listener */
      unsubscribe = onSnapshot(
        doc(db, 'payments', paymentRef),
        (snap) => {
          if (!snap.exists()) return;
          const d = snap.data();
          const status = d.status;
          log.log('Payment status update:', status);
          if (onStatus) onStatus(status, d);
          if (status === 'COMPLETE' || status === 'FAILED' || status === 'CANCELLED') {
            _done(status, d);
          }
        },
        (err) => {
          log.warn('Payment listener error, falling back to polling:', err.message);
        }
      );

      /* Fallback timeout */
      intervalId = setInterval(() => {
        attempts++;
        if (attempts >= MAX_POLL_ATTEMPTS) {
          _done('TIMEOUT', { failReason: 'No response from M-Pesa within 90 seconds.' });
        }
      }, POLL_INTERVAL_MS);
    });
  }

  /* ══════════════════════════════════════════════════════════════
     PHONE NORMALISATION  — ensures E.164 Kenya format (2547XXXXXXXX)
  ══════════════════════════════════════════════════════════════ */
  function _normalizePhone(phone) {
    const clean = String(phone || '').replace(/\D/g, '');
    if (/^254[17]\d{8}$/.test(clean)) return clean;     /* Already E.164 */
    if (/^0[17]\d{8}$/.test(clean))   return '254' + clean.slice(1);
    return null; /* Invalid */
  }

  /* ══════════════════════════════════════════════════════════════
     RECEIPT GENERATION
  ══════════════════════════════════════════════════════════════ */
  function _buildReceipt(ref, paymentData, options) {
    return {
      receiptRef:    ref,
      transactionId: paymentData.transactionId || paymentData.checkoutId,
      amount:        paymentData.amount || options.amount,
      currency:      'KES',
      phone:         options.phone,
      provider:      options.providerName || 'Service Provider',
      service:       options.serviceDesc  || 'SOKONI Service',
      sokoniCut:     options.sokoniCut,
      providerNet:   options.providerNet,
      timestamp:     new Date().toISOString(),
      status:        'PAID',
    };
  }

  /* ══════════════════════════════════════════════════════════════
     COMMISSION RECORDING TO FIRESTORE  (replaces localStorage)
  ══════════════════════════════════════════════════════════════ */
  async function _recordCommission(ref, feeRecord) {
    const auth = window.firebaseAuth;
    const db   = window.firebaseDB;
    if (!auth?.currentUser || !db) return;

    try {
      const { doc, setDoc, serverTimestamp } = await import(
        'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js'
      );
      await setDoc(doc(db, 'bookingFees', ref), {
        ...feeRecord,
        uid:       auth.currentUser.uid,
        amount:    feeRecord.totalPaid || feeRecord.amount,
        type:      'booking_fee',
        savedAt:   serverTimestamp(),
        source:    'intasend_confirmed',
      });
      log.log('Commission recorded for ref:', ref);
    } catch (err) {
      log.error('Commission record failed:', err.message);
    }
  }

  /* ══════════════════════════════════════════════════════════════
     MAIN: initiateSTKPush
     Called by sokoni-pay.js showGateway() when user taps Pay.
     Returns the receipt object on success, throws on failure.
  ══════════════════════════════════════════════════════════════ */
  async function initiateSTKPush(phone, amount, ref, options) {
    const auth = window.firebaseAuth;

    /* Auth guard */
    if (!auth?.currentUser) {
      throw new Error('You must be signed in to make a payment.');
    }

    /* Phone validation */
    const e164Phone = _normalizePhone(phone);
    if (!e164Phone) {
      throw new Error('Invalid M-Pesa number. Use format 07XXXXXXXX or 01XXXXXXXX.');
    }

    /* Amount validation */
    const amountKES = Math.round(Number(amount));
    if (!amountKES || amountKES < 1 || amountKES > 150000) {
      throw new Error('Invalid payment amount.');
    }

    /* Idempotency — if we already have a checkoutId for this ref, reuse it */
    const existingCheckout = _getIdempotencyKey(ref);
    if (existingCheckout) {
      log.log('Reusing existing checkout:', existingCheckout, 'for ref:', ref);
      return { checkoutId: existingCheckout, reused: true };
    }

    /* Prevent double-submit */
    if (_activePayment && _activePayment !== ref) {
      throw new Error('Another payment is already in progress. Please wait.');
    }
    _activePayment = ref;

    try {
      log.log('Initiating STK Push — ref:', ref, 'amount:', amountKES);

      const result = await _callFunction('initiateSTKPush', {
        phone:   e164Phone,
        amount:  amountKES,
        ref,
        meta: {
          providerName: options.providerName  || '',
          serviceDesc:  options.serviceDesc   || '',
          category:     options.category      || 'default',
          uid:          auth.currentUser.uid,
          /* Booking linkage — the webhook creates bookings/{ref} + notifies both
             parties on COMPLETE. Only present for on-platform service bookings. */
          ...(options.type          ? { type:          options.type }          : {}),
          ...(options.providerId    ? { providerId:    options.providerId }    : {}),
          ...(options.providerPhone ? { providerPhone: options.providerPhone } : {}),
          /* Marketplace product linkage — the webhook credits the SELLER
             (meta.sellerUid, since the caller is the BUYER) and finalises the
             order (meta.orderId → paid + meta.items → stock decrement). Only
             present for buyer-initiated product checkouts. */
          ...(options.orderId    ? { orderId:    options.orderId }    : {}),
          ...(options.sellerUid  ? { sellerUid:  options.sellerUid }  : {}),
          ...(options.sellerName ? { sellerName: options.sellerName } : {}),
          ...(options.hub        ? { hub:        options.hub }        : {}),
          ...(Array.isArray(options.items) ? { items: options.items } : {}),
        },
      });

      if (!result.success || !result.checkoutId) {
        throw new Error(result.message || 'Failed to initiate M-Pesa payment.');
      }

      /* Store idempotency key to prevent duplicate pushes on retry */
      _setIdempotencyKey(ref, result.checkoutId);
      log.log('STK Push sent, checkoutId:', result.checkoutId);

      return { checkoutId: result.checkoutId };

    } catch (err) {
      _activePayment = null;
      _clearIdempotencyKey(ref);
      throw err;
    }
  }

  /* ══════════════════════════════════════════════════════════════
     MAIN: waitForConfirmation
     Waits for IntaSend webhook to confirm payment via Firestore.
     Calls onStatus(status) on each state change.
     Resolves with receipt on success, rejects on failure/timeout.
  ══════════════════════════════════════════════════════════════ */
  async function waitForConfirmation(ref, options, onStatus) {
    try {
      const paymentData = await _waitForPaymentConfirmation(ref, onStatus);

      /* Payment confirmed — record commission to Firestore */
      const feeRecord = {
        ref,
        providerName:  options.providerName  || '',
        category:      options.category      || 'default',
        totalPaid:     options.amount,
        sokoniCut:     options.sokoniCut     || 0,
        providerNet:   options.providerNet   || options.amount,
        commissionPct: options.commissionPct || 0,
        phone:         options.phone         || '',
        providerPhone: options.providerPhone || '',
        serviceDesc:   options.serviceDesc   || '',
        status:        'paid',
        paymentType:   options.fullPayment ? 'full_service' : 'deposit',
        createdAt:     Date.now(),
        confirmedVia:  'intasend_webhook',
      };
      await _recordCommission(ref, feeRecord);

      const receipt = _buildReceipt(ref, paymentData, { ...options, phone: options.phone });

      _clearIdempotencyKey(ref);
      _activePayment = null;

      return receipt;

    } catch (err) {
      _clearIdempotencyKey(ref);
      _activePayment = null;
      throw err;
    }
  }

  /* ══════════════════════════════════════════════════════════════
     MAIN: cancelPayment
     Cancels a pending STK push via Cloud Function.
  ══════════════════════════════════════════════════════════════ */
  async function cancelPayment(ref) {
    try {
      await _callFunction('cancelPayment', { ref });
      _clearIdempotencyKey(ref);
      _activePayment = null;
      log.log('Payment cancelled:', ref);
    } catch (err) {
      log.warn('Cancel payment failed:', err.message);
    }
  }

  /* ══════════════════════════════════════════════════════════════
     EXPORTS
  ══════════════════════════════════════════════════════════════ */
  window.SokoniIntaSend = {
    initiateSTKPush,
    waitForConfirmation,
    cancelPayment,
    normalizePhone: _normalizePhone,
  };

})(window);
