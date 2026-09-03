/* ================================================================
   SOKONI Till payment page — pure client-side core (Q8)

   No DOM, no Firebase, no network. Loaded as a plain classic script by
   pay-q.html (window.SokoniPayQCore) so its logic is directly certifiable
   with Node — scripts/test-pay-q-core.js — the same "pure core, certified
   in isolation" methodology this whole Till/QR programme (Q5-Q7) already
   uses, applied here to the one client-side file in the programme.

   THE ONE INVARIANT THIS FILE EXISTS TO PROVE BY CONSTRUCTION:
   for a dynamic QR (an already-created paymentIntents/{ref}), the amount
   handed to initiateSTKPush is ALWAYS the server-resolved figure
   (`resolved.amount`) — buildStkRequest() has NO parameter through which a
   buyer-typed amount could reach it for that case. A permanent Till QR's
   buyer-typed amount is validated here, but only ever becomes the SEED for
   createPaymentIntent — never itself the figure sent to initiateSTKPush
   (that comes back from the server's own response, see pay-q.html).
================================================================ */
(function (root) {
  'use strict';

  /** /pay/q/{token} -> token, or null. */
  function parseToken(pathname) {
    const m = String(pathname || '').match(/\/pay\/q\/([^/]+)/);
    return m ? decodeURIComponent(m[1]) : null;
  }

  /** Kenyan MSISDN, normalised to 254XXXXXXXXX, or null if invalid. */
  function validPhone(raw) {
    const digits = String(raw || '').replace(/\s+/g, '');
    if (/^254[17]\d{8}$/.test(digits)) return digits;
    if (/^0[17]\d{8}$/.test(digits)) return '254' + digits.slice(1);
    return null;
  }

  function fmt(amount, currency) {
    const n = Number(amount || 0);
    return `${currency || 'KES'} ${n.toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }

  /**
   * Given the already-resolved QR data (from resolveSokoniQR) and a raw,
   * buyer-typed amount string (only meaningful for the permanent-Till case),
   * decide what happens next. Pure — the caller performs the actual network
   * calls; this only decides WHAT to ask for and WHAT is wrong.
   *
   * Returns one of:
   *   { ok:false, reason }                                   — refuse, show reason
   *   { ok:true, mode:'create_intent', sokoniTillId, amount } — permanent QR:
   *       mint a NEW intent for this seed amount (createPaymentIntent)
   *   { ok:true, mode:'use_existing', ref, amount }           — dynamic QR:
   *       pay the ALREADY-EXISTING intent at its OWN amount — `rawAmountInput`
   *       is not even read in this branch, by construction.
   */
  function decidePaymentAction({ resolved, rawAmountInput }) {
    if (!resolved || (resolved.type !== 'till' && resolved.type !== 'intent')) {
      return { ok: false, reason: 'This payment link could not be resolved.' };
    }

    if (resolved.type === 'intent') {
      if (resolved.status === 'paid') return { ok: false, reason: 'This payment has already been completed.' };
      if (!resolved.ref) return { ok: false, reason: 'This payment link is missing its reference.' };
      const amt = Number(resolved.amount);
      if (!(amt > 0)) return { ok: false, reason: 'This payment has no valid amount.' };
      /* rawAmountInput is intentionally NOT consulted here — see file header. */
      return { ok: true, mode: 'use_existing', ref: resolved.ref, amount: amt };
    }

    /* type === 'till' — permanent QR, buyer types the amount. */
    if (!resolved.sokoniTillId) return { ok: false, reason: 'This Till could not be identified.' };
    const seed = Number(rawAmountInput);
    if (!Number.isFinite(seed) || seed <= 0) return { ok: false, reason: 'Enter a valid amount.' };
    return { ok: true, mode: 'create_intent', sokoniTillId: resolved.sokoniTillId, amount: seed };
  }

  /**
   * Given what a createPaymentIntent/resolveSokoniQR call already returned,
   * build the EXACT initiateSTKPush payload — the server's own returned
   * ref/amount, never a value re-derived from the DOM.
   */
  function buildStkRequest({ phone, ref, amount }) {
    const p = validPhone(phone);
    if (!p) return { ok: false, reason: 'Enter a valid Safaricom number.' };
    if (!ref) return { ok: false, reason: 'Missing payment reference.' };
    if (!(Number(amount) > 0)) return { ok: false, reason: 'Missing payment amount.' };
    return { ok: true, request: { phone: p, ref, amount } };
  }

  const api = { parseToken, validPhone, fmt, decidePaymentAction, buildStkRequest };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SokoniPayQCore = api;
})(typeof window !== 'undefined' ? window : globalThis);
