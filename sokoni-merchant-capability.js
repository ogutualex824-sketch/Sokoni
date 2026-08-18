/* ══════════════════════════════════════════════════════════════════════════════
   SOKONI — MERCHANT SHELL CAPABILITY NEGOTIATION
   ══════════════════════════════════════════════════════════════════════════════
   ONE route registry, TWO shells that can render different amounts of it.

   sokoni-merchant-routes.js states the PREFERRED way a destination should mount.
   It does NOT state what a given shell can actually do. Merchant v2 renders nine
   surfaces natively that Merchant v1 has no renderer for; if the registry's
   preference were taken as an instruction, v1 would open seven live surfaces as
   blank panels. A registry must never be able to break a shell just by being
   adopted — that would make it a hidden breaking-change mechanism rather than a
   contract.

   So the decision is split:

     registry  ->  "this destination is BEST rendered natively"
     shell     ->  "I can / cannot render that natively"
     this file ->  resolves the pair into exactly one honest outcome

   OUTCOMES (exhaustive — every route resolves to one of these, never to nothing)

     native      the shell has a renderer. Mount it.
     downgrade   the shell has no renderer, but the destination exists as a legacy
                 seller.js section. Mount that instead. The merchant reaches the
                 same capability by the older road; nothing blanks, nothing lies.
     withhold    the shell has no renderer AND there is no legacy equivalent,
                 because the surface is genuinely new. The route is removed from
                 every navigation projection so no button can promise it, and a
                 direct deep-link renders a named "not available in this shell"
                 panel — never a blank, and never a silent bounce to Dashboard
                 (the registry's own hard rule: an unknown id is a LOUD failure).

   WHY THE FALLBACKS ARE NOT INVENTED
   Every `sec` in LEGACY below is copied verbatim from the descriptor the SAME
   route carried in rc/combined's registry (c5f7151) before it was upgraded to
   native. This file therefore restores information that already shipped and was
   already gate-proven; it does not author a new mapping. Two of them are
   non-obvious and would have been guessed wrong:  kra-tax -> 'tax',
   shop -> 'store'.  That is precisely why they are recovered, not derived.

   WHY THIS IS A SIDECAR AND NOT A FIELD IN THE REGISTRY
   The certified registry is preserved byte-identical (48,364 bytes, sha256
   2b8fc08d...) as the artifact Merchant v2 was certified against. Adding a field
   to it would end that identity before integration has even been agreed. When
   the registry is next opened for integration, LEGACY should be folded in as a
   per-route `fallback:{}` and this map deleted — see
   docs/MERCHANT_SHELL_CAPABILITY.md. Until then the overlay keeps the certified
   artifact clean and keeps this reversible.

   NOTE ON `sell` AND `inventory`
   These two withhold rather than downgrade, deliberately. `sell` is the
   phone-first till and POS is a counter-scale application; the registry is
   explicit that they are separate destinations and the merchant suites enforce
   the wall between them. Falling `sell` back to POS would quietly merge exactly
   what the platform has decided must stay apart. `inventory` likewise no longer
   aliases the POS inventory tab. A new capability with no old equivalent is
   absent, not approximated.

   No DOM, no Firestore, no globals touched. Pure and callable from node so the
   gate can prove it without a browser.
   ══════════════════════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  /* Legacy seller.js section for each route the certified registry upgraded to
     native. Source: rc/combined sokoni-merchant-routes.js @ c5f7151.
     A route absent from this map has NO legacy equivalent and will withhold. */
  var LEGACY = {
    customers: 'customers',
    disputes:  'disputes',
    'kra-tax': 'tax',      /* NOT 'kra-tax' — DASH_PAGES key is 'tax'   */
    marketing: 'marketing',
    messages:  'messages',
    shop:      'store',    /* NOT 'shop'  — DASH_PAGES key is 'store'   */
    staff:     'team'      /* NOT 'staff' — DASH_PAGES key is 'team'    */
  };

  /* Routes that are native in the certified registry and were ALSO native in
     rc/combined. Every shell that ever rendered the registry already renders
     these, so they are not part of the negotiation surface. Kept explicit so the
     gate can assert the negotiation surface is exactly the delta and has not
     silently grown. */
  var ALWAYS_NATIVE = [
    'dashboard', 'orders', 'analytics', 'revenue', 'reports',
    'payments', 'availability', 'settings', 'devices'
  ];

  function has (caps, id) {
    if (!caps) return false;
    if (typeof caps.canRenderNative === 'function') return !!caps.canRenderNative(id);
    if (caps.native && typeof caps.native === 'object') return !!caps.native[id];
    return false;
  }

  /* Resolve ONE route against ONE shell's capabilities.
     Returns a descriptor the shell can mount directly — the caller never has to
     re-derive kind/sec/src. `route` is not mutated. */
  function negotiate (route, caps) {
    if (!route || !route.id) throw new Error('[capability] negotiate() needs a route');
    var id = route.id;

    /* Only a native PREFERENCE is negotiable. pos / seller / page / exit routes
       mount identically in both shells and are passed through untouched. */
    if (route.kind !== 'native') {
      return { id: id, outcome: 'native', kind: route.kind, sec: route.sec,
               src: route.src, tab: route.tab, name: route.name,
               reason: 'not a native route; no negotiation required' };
    }

    if (has(caps, id)) {
      return { id: id, outcome: 'native', kind: 'native', name: route.name,
               reason: 'shell declares a native renderer' };
    }

    if (Object.prototype.hasOwnProperty.call(LEGACY, id)) {
      return { id: id, outcome: 'downgrade', kind: 'seller', sec: LEGACY[id],
               name: route.name,
               reason: 'no native renderer in this shell; legacy seller.js section exists' };
    }

    return { id: id, outcome: 'withhold', kind: null, name: route.name,
             reason: 'no native renderer in this shell and no legacy equivalent exists' };
  }

  /* Resolve the WHOLE registry for one shell. Returns every route with its
     outcome — withheld ones included, so a caller can render an honest panel for
     a deep-link instead of pretending the id is unknown. */
  function negotiateAll (routes, caps) {
    return (routes || []).map(function (r) { return negotiate(r, caps); });
  }

  /* The list every navigation projection (sidebar, drawer, bottom nav, command
     palette) must build from. Withheld routes are removed here and ONLY here —
     a projection that filters on its own would be a second list, which the route
     contract forbids. */
  function projectNav (routes, caps) {
    var out = [];
    (routes || []).forEach(function (r) {
      if (negotiate(r, caps).outcome !== 'withhold') out.push(r);
    });
    return out;
  }

  global.SokoniMerchantCapability = {
    LEGACY: LEGACY,
    ALWAYS_NATIVE: ALWAYS_NATIVE,
    negotiate: negotiate,
    negotiateAll: negotiateAll,
    projectNav: projectNav
  };
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));

if (typeof module !== 'undefined' && module.exports) {
  module.exports = (typeof window !== 'undefined' ? window : globalThis).SokoniMerchantCapability;
}
