/* ============================================================================
   SOKONI — Till / POS M-PESA on the IntaSend POS rail (one adapter, every till surface)
   ----------------------------------------------------------------------------
   WHY: the till (till.html) and merchant-v2's Sell tab wired the sell engine to
   `darajaSTKPush`, and pos-checkout.html called `posSendMpesa`. Neither function exists in
   production (Daraja outbound was retired), so every STK attempt failed with the SDK's generic
   "internal". The live rail is `posInitiateIntasendPayment` (mints a postill_ reference, raises
   ONE prompt per idempotency key, refuses a shop the caller cannot act for) and the webhook's
   POS finaliser writes posPaymentStatus/{ref}, which `posCheckPaymentStatus` reads back.

   This file translates the sell engine's two calls onto that pair and changes nothing else:
     callStk({ sellerUid, phone, amount, description })  → posInitiateIntasendPayment
     callVerify({ checkoutId })                          → posCheckPaymentStatus
   Requesting money and confirming money stay two separate calls: only the server's payment
   record (written by the IntaSend webhook) can turn a request into a payment.

   Usage:  ctx.callStk    = SokoniPosStk.callStk(nameToCallable)
           ctx.callVerify = SokoniPosStk.callVerify(nameToCallable)
   where nameToCallable(name) returns a callable (window.sokoniCallable or the page's _callable).
   ============================================================================ */
(function (g) {
  'use strict';
  /* One prompt per attempt. A double tap is already stopped by the sell engine's phase state; a
     deliberate resend after a failure or timeout is a NEW attempt and must raise a new prompt. */
  function attemptKey(shopId) {
    var r = '';
    try { var a = new Uint32Array(2); g.crypto.getRandomValues(a); r = a[0].toString(36) + a[1].toString(36); }
    catch (_) { r = Math.random().toString(36).slice(2, 10); }
    return 'till_' + String(shopId || 'shop').slice(0, 40) + '_' + Date.now().toString(36) + '_' + r;
  }
  var merchantOf = Object.create(null);     /* ref → shop, so the status read can use its fallback */

  function callStk(factory) {
    var fn = typeof factory === 'function' ? factory('posInitiateIntasendPayment') : null;
    if (typeof fn !== 'function') return null;
    return function (a) {
      a = a || {};
      var shopId = String(a.sellerUid || a.merchantId || '');
      return fn({
        merchantId: shopId, idempotencyKey: attemptKey(shopId), phone: a.phone,
        amountKES: Number(a.amount), narrative: String(a.description || 'POS sale').slice(0, 60),
      }).then(function (r) {
        var d = (r && r.data) || r || {};
        if (!d.ref) throw new Error('The payment request did not return a reference.');
        if (d.state === 'failed') throw new Error(d.error || 'M-Pesa did not accept the payment request. Try again.');
        merchantOf[d.ref] = shopId;
        return { data: { ref: d.ref, checkoutId: d.ref, state: d.state || 'pending', reused: !!d.reused } };
      });
    };
  }

  function callVerify(factory) {
    var fn = typeof factory === 'function' ? factory('posCheckPaymentStatus') : null;
    if (typeof fn !== 'function') return null;
    return function (a) {
      a = a || {};
      var ref = String(a.checkoutId || a.ref || '');
      var req = { ref: ref };
      if (merchantOf[ref]) req.merchantId = merchantOf[ref];
      return fn(req).then(function (r) {
        var d = (r && r.data) || r || {};
        return { data: { status: String(d.status || 'pending'), transactionRef: d.transactionRef || ref, reason: d.reason || null } };
      });
    };
  }

  g.SokoniPosStk = { callStk: callStk, callVerify: callVerify, _attemptKey: attemptKey };
})(typeof window !== 'undefined' ? window : globalThis);
