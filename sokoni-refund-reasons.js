/* ════════════════════════════════════════════════════════════════════════════
   SOKONI — refund / return / dispute reasons: the BROWSER MIRROR.

   The authority is functions/refund-reasons.js. This file carries the same list
   for pages that cannot load a server module; scripts/test-refund-reasons.js
   FAILS if the two differ by a single code, label or flag. Do not edit one
   without the other.
   ════════════════════════════════════════════════════════════════════════════ */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.SokoniRefundReasons = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  var REASONS = [
    { code: 'not_received',              label: 'Item never arrived',                        dispute: true,  return: false, refund: true },
    { code: 'not_as_described',          label: 'Significantly different from the listing',  dispute: true,  return: true,  refund: true },
    { code: 'counterfeit',               label: 'Counterfeit or not authentic',              dispute: true,  return: false, refund: true },
    { code: 'wrong_item',                label: 'Wrong item sent',                           dispute: true,  return: true,  refund: true },
    { code: 'damaged',                   label: 'Arrived damaged',                           dispute: true,  return: true,  refund: true },
    { code: 'defective',                 label: 'Defective or not working',                  dispute: true,  return: true,  refund: true },
    { code: 'billing_error',             label: 'Charged the wrong amount',                  dispute: true,  return: false, refund: true },
    { code: 'buyer_request',             label: 'Changed my mind',                           dispute: false, return: true,  refund: true },
    { code: 'seller_cancelled',          label: 'Cancelled by the seller',                   dispute: false, return: false, refund: true },
    { code: 'seller_failed_to_dispatch', label: 'Seller did not dispatch',                   dispute: false, return: false, refund: true },
    { code: 'other',                     label: 'Other',                                     dispute: true,  return: true,  refund: true }
  ];
  var ALIASES = { overcharged: 'billing_error', changed_mind: 'buyer_request', damaged_in_transit: 'damaged' };
  function canonical(input) {
    var s = typeof input === 'string' ? input.trim() : '';
    for (var i = 0; i < REASONS.length; i++) if (REASONS[i].code === s) return s;
    return ALIASES[s] || null;
  }
  function labelOf(code) {
    var c = canonical(code);
    for (var i = 0; i < REASONS.length; i++) if (REASONS[i].code === c) return REASONS[i].label;
    return null;
  }
  function allowedFor(context) { return REASONS.filter(function (r) { return r[context]; }).map(function (r) { return r.code; }); }
  return { REASONS: REASONS, ALIASES: ALIASES, canonical: canonical, labelOf: labelOf, allowedFor: allowedFor };
}));
