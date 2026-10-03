/* ═══════════════════════════════════════════════════════════════════════════
   SokoniMpesa — RETIRED (2026-10-03)
   ═══════════════════════════════════════════════════════════════════════════
   This module sent M-Pesa STK pushes through Safaricom's Daraja API (darajaSTKPush). The owner retired
   Daraja on 2026-10-03: SOKONI collects through IntaSend only, and the Daraja functions no longer exist.

   It is kept as a tiny stub ON PURPOSE. Several hub pages (car hire, car tracking, healthcare, legal,
   digital, delivery) choose their payment path with `if (window.SokoniMpesa)`. Deleting the global would
   send some of them into older fallbacks that are worse than an honest refusal: a contract created with
   no payment, or a WhatsApp hand-off. So pay() refuses immediately — no phone prompt, no network call —
   and each caller takes the failure path it already implements.

   Those hubs need server-priced IntaSend purposes before they can take money online; until then the
   buyer is told plainly that nothing was charged.
   ═══════════════════════════════════════════════════════════════════════════ */
(function (G) {
  'use strict';
  var MESSAGE = "Online M-Pesa payment for this service isn't available yet. You have not been charged.";

  function _say(msg) {
    try {
      if (typeof G._showToast === 'function') return G._showToast(msg, 'warning');
      if (typeof G._skToast === 'function') return G._skToast(msg);
    } catch (_) {}
    try { G.alert(msg); } catch (_) {}
  }

  var SokoniMpesa = {
    RETIRED: true,
    /** Always refuses. Resolves 'unavailable' and calls onFailure('unavailable'). Never charges. */
    pay: function (opts) {
      var o = opts || {};
      _say(MESSAGE);
      try { if (typeof o.onFailure === 'function') o.onFailure('unavailable'); } catch (_) {}
      return Promise.resolve('unavailable');
    },
  };

  G.SokoniMpesa = SokoniMpesa;
}(typeof window !== 'undefined' ? window : globalThis));
