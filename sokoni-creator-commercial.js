/* ═══════════════════════════════════════════════════════════════════════════
   creator-commercial.js — THE Creator Hub commercial authority.

   Owner decision 2026-09-26: Creator pay-per-view is split
       SOKONI 30 %  /  Creator (rights-holder) royalty pool 70 %
   of the NET distributable basis = gross − IntaSend provider fee − tax/levy.

   It is deliberately NOT commission-config.js. That file is the platform-wide
   rate authority (marketplace 5 %, legacy `ppv` 15 %, …) and Creator Hub is a
   distinct commercial vertical: changing either must never move the other.
   scripts/test-creator-callback.js proves both directions.

   Integer basis points only (10000 = 100 %). Frozen: a policy object cannot be
   mutated at runtime, and a policy whose shares do not sum to 10000 is refused
   at load, not at the first sale.

   UMD: the server requires it; subscriptions.html (the Monetisation & Pricing
   page) loads the byte-identical copy sokoni-creator-commercial.js, so the page
   can only ever show the split the server applies.
   ═══════════════════════════════════════════════════════════════════════════ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SokoniCreatorCommercial = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const BPS_TOTAL = 10000;

  const CREATOR_PPV = Object.freeze({
    policyId: 'creator_ppv_v1',
    domain: 'creator',
    productType: 'pay_per_view',          /* entertainment / film purchase or rental */
    basis: 'NET_OF_PROVIDER_FEE',         /* gross − provider fee − tax, NOT gross */
    sokoniCommissionBps: 3000,
    creatorPoolBps: 7000,
    effectiveFrom: '2026-09-26',
    decidedBy: 'owner',
  });

  function assertPolicy(p) {
    const ok = p && Number.isSafeInteger(p.sokoniCommissionBps) && Number.isSafeInteger(p.creatorPoolBps)
      && p.sokoniCommissionBps >= 0 && p.creatorPoolBps >= 0
      && p.sokoniCommissionBps + p.creatorPoolBps === BPS_TOTAL
      && p.basis === 'NET_OF_PROVIDER_FEE';
    if (!ok) { const e = new Error('creator commercial policy invalid: shares must be integer bps summing to 10000 on the net basis'); e.code = 'policy_invalid'; throw e; }
    return p;
  }
  assertPolicy(CREATOR_PPV);   /* fail at load, never at the first sale */

  /** The policy governing a Creator sale. One policy today; versioned by policyId. */
  function policyFor(/* sale */) { return CREATOR_PPV; }

  /** Display helper: "30%" from bps, never a hand-typed number. */
  function pctLabel(bps) { const n = bps / 100; return (Number.isInteger(n) ? String(n) : n.toFixed(2)) + '%'; }

  return { BPS_TOTAL, CREATOR_PPV, assertPolicy, policyFor, pctLabel };
}));
