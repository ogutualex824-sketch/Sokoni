/* ================================================================
   SOKONI — Public Payment Config loader (client)
   sokoni-pay-config.js  →  window.SOKONI_PAY

   Fetches the centralized, checkout-only payment config from the backend
   (getCheckoutPaymentConfig) so client pages never hardcode Paybill/Till
   values. Any element with data-sk-pay="<field>" has its text replaced with
   the config value once loaded.

   FALLBACK-SAFE: if the fetch fails or is slow, whatever literal is already in
   the element (the previous hardcoded value) remains visible — payment
   instructions never render blank. This makes centralization non-breaking.

   Requires firebase-functions-compat + firebase.js already on the page.
================================================================ */
(function (w, d) {
  'use strict';
  if (w.__SK_PAY_LOADED) return;
  w.__SK_PAY_LOADED = true;

  function apply(cfg) {
    w.SOKONI_PAY = cfg;
    try {
      d.querySelectorAll('[data-sk-pay]').forEach(function (el) {
        var k = el.getAttribute('data-sk-pay');
        if (cfg && cfg[k] != null && String(cfg[k]).length) el.textContent = String(cfg[k]);
      });
      w.dispatchEvent(new Event('sokoni-pay-ready'));
    } catch (_) {}
  }

  function load() {
    try {
      if (!w.firebase || !firebase.functions) return;         // no SDK → keep literal fallbacks
      firebase.functions().httpsCallable('getCheckoutPaymentConfig')({})
        .then(function (r) { if (r && r.data) apply(r.data); })
        .catch(function () { /* keep literal fallbacks */ });
    } catch (_) { /* keep literal fallbacks */ }
  }

  if (d.readyState === 'loading') d.addEventListener('DOMContentLoaded', load);
  else load();
})(window, document);
