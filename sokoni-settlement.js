/* ================================================================
   SOKONI — Settlement client wrapper
   sokoni-settlement.js  →  window.SokoniSettlement

   Thin client for the consolidated settlementDispatch Cloud Function. Callers
   use SokoniSettlement.call('opName', data) instead of individual callables,
   mirroring the loyalty/analytics dispatcher client pattern. Preserves the
   original per-op API contract (same op names, same payloads, same responses).

   Requires firebase-functions-compat + firebase.js on the page.
================================================================ */
(function (w) {
  'use strict';
  var _fn = null;
  function _dispatch() {
    if (!_fn) _fn = firebase.functions().httpsCallable('settlementDispatch');
    return _fn;
  }
  var API = {
    /* Generic: SokoniSettlement.call('settlementPreview', {...}) → Promise<data> */
    call: function (op, data) {
      return _dispatch()(Object.assign({ op: op }, data || {})).then(function (r) { return r.data; });
    },
    /* Named convenience wrappers (same contracts as the former individual CFs). */
    getContext:        function ()   { return API.call('settlementGetContext'); },
    getDashboard:      function ()   { return API.call('settlementGetDashboard'); },
    preview:           function (d)  { return API.call('settlementPreview', d); },
    previewMethod:     function (d)  { return API.call('settlementPreviewMethod', d); },
    getRoutingConfig:  function ()   { return API.call('settlementGetRoutingConfig'); },
    setRoutingConfig:  function (d)  { return API.call('settlementSetRoutingConfig', d); },
    getProviders:      function ()   { return API.call('settlementGetProviders'); },
    setProvider:       function (d)  { return API.call('settlementSetProvider', d); },
    validatePath:      function (d)  { return API.call('settlementValidatePath', d); },
    getCheckoutConfig: function ()   { return API.call('getCheckoutPaymentConfig'); },
    getPaymentConfig:  function ()   { return API.call('adminGetPaymentConfig'); },
    setPaymentConfig:  function (d)  { return API.call('adminSetPaymentConfig', d); },
  };
  w.SokoniSettlement = API;
})(typeof window !== 'undefined' ? window : this);
