/* ============================================================================
   SOKONI COMMISSION RATES — GENERATED FILE. DO NOT EDIT.
   ----------------------------------------------------------------------------
   Source of truth : functions/commission-config.js
   Regenerate with : node scripts/build-commission-snapshot.js
   Enforced by     : scripts/verify-commission-single-source.js (fails the deploy if
                     this file and the config disagree)

   Every client-side commission percentage comes from here. Do not hardcode a rate in a
   page, and do not write `|| 10` as a fallback — a wrong rate shown to a seller is worse
   than no rate at all. Use SokoniCommission.pct(category), which returns the platform
   default (5%) for anything it does not recognise.

   These are DISPLAY rates. The authoritative figure for a real order comes from the server
   (previewCommission / calculateCommission), which also applies commissionRules overrides
   and commission holidays that this table knows nothing about.
============================================================================ */
;(function (window) {
  'use strict';

  var RATES = {
    "marketplace": {
      "pct": 15,
      "fixedKES": 0
    },
    "food_delivery": {
      "pct": 15,
      "fixedKES": 0
    },
    "property": {
      "pct": 0,
      "fixedKES": 5000
    },
    "vehicles": {
      "pct": 2,
      "fixedKES": 0
    },
    "healthcare": {
      "pct": 5,
      "fixedKES": 0
    },
    "healthcare_products": {
      "pct": 15,
      "fixedKES": 0
    },
    "legal": {
      "pct": 5,
      "fixedKES": 0
    },
    "events": {
      "pct": 5,
      "fixedKES": 0
    },
    "hotel": {
      "pct": 15,
      "fixedKES": 0
    },
    "digital_products": {
      "pct": 10,
      "fixedKES": 0
    },
    "event_tickets": {
      "pct": 5,
      "fixedKES": 0
    },
    "ppv": {
      "pct": 15,
      "fixedKES": 0
    },
    "entertainment_bookings": {
      "pct": 5,
      "fixedKES": 0
    },
    "services": {
      "pct": 5,
      "fixedKES": 0
    },
    "home_services": {
      "pct": 5,
      "fixedKES": 0
    },
    "car_rental": {
      "pct": 5,
      "fixedKES": 0
    },
    "pos": {
      "pct": 5,
      "fixedKES": 0
    },
    "fitness": {
      "pct": 5,
      "fixedKES": 0
    },
    "sports_venue_bookings": {
      "pct": 5,
      "fixedKES": 0
    },
    "sports_coaching": {
      "pct": 5,
      "fixedKES": 0
    },
    "sports_tournament_entry": {
      "pct": 5,
      "fixedKES": 0
    },
    "construction_service": {
      "pct": 0,
      "fixedKES": 0
    },
    "construction_equipment_rental": {
      "pct": 0,
      "fixedKES": 0
    },
    "construction_featured": {
      "pct": 0,
      "fixedKES": 0
    },
    "construction_delivery_margin": {
      "pct": 0,
      "fixedKES": 0
    },
    "electronics": {
      "pct": 15,
      "fixedKES": 0
    },
    "education": {
      "pct": 5,
      "fixedKES": 0
    },
    "jobs": {
      "pct": 0,
      "fixedKES": 0
    },
    "classifieds": {
      "pct": 8,
      "fixedKES": 0
    },
    "hub": {
      "pct": 17,
      "fixedKES": 0
    },
    "subscriptions": {
      "pct": 100,
      "fixedKES": 0
    },
    "advertising": {
      "pct": 100,
      "fixedKES": 0
    },
    "saas": {
      "pct": 0,
      "fixedKES": 0
    },
    "b2b_order": {
      "pct": 0,
      "fixedKES": 0
    },
    "default": {
      "pct": 5,
      "fixedKES": 0
    }
  };

  var ALIASES = {
    "product": "marketplace",
    "products": "marketplace",
    "shopping": "marketplace",
    "b2b": "b2b_order",
    "wholesale": "b2b_order",
    "b2b_wholesale": "b2b_order",
    "rfq": "b2b_order",
    "till": "pos",
    "quick_charge": "pos",
    "quickcharge": "pos",
    "subscription": "subscriptions",
    "healthcare_subscription": "subscriptions",
    "restaurant": "food_delivery",
    "food": "food_delivery",
    "insurance": "services",
    "gym": "fitness",
    "fitness_hub": "fitness",
    "fitness-hub": "fitness",
    "personal_training": "fitness",
    "car-rental": "car_rental",
    "car_hire": "car_rental",
    "car-hire": "car_rental",
    "pharmacy": "healthcare_products",
    "property_agent": "property",
    "bnb": "hotel",
    "car_dealer": "vehicles",
    "car_hub": "vehicles",
    "entertainment": "events",
    "sports": "events",
    "sports_venue": "sports_venue_bookings",
    "coaching": "sports_coaching",
    "coach_booking": "sports_coaching",
    "tournament_entry": "sports_tournament_entry",
    "tournament": "sports_tournament_entry",
    "phones": "electronics",
    "phone": "electronics",
    "smartphones": "electronics",
    "laptops": "electronics",
    "laptop": "electronics",
    "tablets": "electronics",
    "tablet": "electronics",
    "computers": "electronics",
    "device_accessories": "electronics",
    "cement": "marketplace",
    "steel": "marketplace",
    "timber": "marketplace",
    "roofing": "marketplace",
    "bricks": "marketplace",
    "tiles": "marketplace",
    "paint": "marketplace",
    "plumbing-materials": "marketplace",
    "electrical-materials": "marketplace",
    "windows-doors": "marketplace",
    "construction-tools": "marketplace",
    "sand-gravel": "marketplace",
    "safety-ppe": "marketplace",
    "building-materials": "marketplace",
    "hardware": "marketplace",
    "construction": "marketplace",
    "contractor": "construction_service",
    "welding": "construction_service",
    "fabrication": "construction_service",
    "electrical-contractor": "construction_service",
    "plumbing-contractor": "construction_service",
    "construction-contractor": "construction_service",
    "welding-fabrication": "construction_service",
    "construction-company": "construction_service",
    "construction-services": "construction_service",
    "construction-transport": "construction_service",
    "construction-architect": "construction_service",
    "equipment-rental": "construction_equipment_rental",
    "equipment_rental": "construction_equipment_rental",
    "plant-hire": "construction_equipment_rental",
    "freelancer": "jobs",
    "freelance": "jobs",
    "gig": "jobs",
    "gigs": "jobs",
    "logistics": "hub",
    "delivery": "hub",
    "driver": "hub",
    "digital": "digital_products",
    "ai_services": "digital_products"
  };

  /* MARKETPLACE lane — commission by the seller's PLAN, on orders SOKONI brought them. */
  var MARKETPLACE_PLAN_PCT = {
    "free": 15,
    "professional": 15,
    "business": 15,
    "enterprise": 15
  };

  /* POS / TILL lane — shop sales the merchant made themselves. FLAT, every plan. A
     subscription buys a better marketplace rate and changes NOTHING at the till. */
  var POS_FLAT_PCT = 5;
  var MARKETPLACE_PLAN_ALIAS = {"seller_free":"free","seller_basic":"professional","seller_pro":"business","seller_enterprise":"enterprise","free":"free","basic":"professional","pro":"business","professional":"professional","business":"business","enterprise":"enterprise","starter":"professional","growth":"business"};
  var MARKETPLACE_DEFAULT_PLAN = "free";


  /* RAW category labels priced by the plan ladder. "pos" is deliberately ABSENT even though
     it ALIASES to marketplace — keying on the resolved category would put every till sale on
     the ladder and triple a Free merchant's till commission. */
  var MARKETPLACE_CATEGORIES = ["marketplace","product","products","shopping"];

  var MIN_COMMISSION_KES = 10;

  /* Resolve a hub OR category name to its rate. Mirrors commission-config.resolveRate(). */
  function resolve(key) {
    var k = String(key || '').trim().toLowerCase();
    var category = RATES[k] ? k : (ALIASES[k] || null);
    if (!category || !RATES[category]) {
      return { pct: RATES.default.pct, fixedKES: RATES.default.fixedKES, category: 'default', matched: false };
    }
    return { pct: RATES[category].pct, fixedKES: RATES[category].fixedKES, category: category, matched: true };
  }

  window.SokoniCommission = {
    /* The percentage for a hub/category. Never returns undefined, so no caller needs a fallback. */
    pct: function (key) { return resolve(key).pct; },
    /* The flat fee (e.g. vehicles: KES 2,000), 0 for most hubs. */
    fixedKES: function (key) { return resolve(key).fixedKES; },
    resolve: resolve,
    RATES: RATES,
    ALIASES: ALIASES,
    MIN_COMMISSION_KES: MIN_COMMISSION_KES,

    /* The rate a seller on planId pays on a MARKETPLACE order. An unrecognised or absent
       plan resolves to Free — the HIGHEST rate — so a display can never under-quote. */
    marketplacePct: function (planId) {
      var k = String(planId || '').trim().toLowerCase();
      /* Aliases are resolved by the server authority at build time (MARKETPLACE_PLAN_ALIAS); an
         unknown spelling falls to the DEFAULT plan, which is the highest rate — never the cheapest. */
      if (!Object.prototype.hasOwnProperty.call(MARKETPLACE_PLAN_PCT, k)) k = MARKETPLACE_PLAN_ALIAS[k] || MARKETPLACE_DEFAULT_PLAN;
      if (!Object.prototype.hasOwnProperty.call(MARKETPLACE_PLAN_PCT, k)) k = MARKETPLACE_DEFAULT_PLAN;
      return MARKETPLACE_PLAN_PCT[k];
    },
    /* The rate on a POS / till sale. Takes no plan, because it does not depend on one. */
    posPct: function () { return POS_FLAT_PCT; },
    /* The rate EVERY service booking pays (owner 2026-10-03: flat 5 %, provider-paid at settlement, on every plan). */
    providerBookingPct: function () { return resolve('services').pct; },
    isMarketplaceSellerSale: function (cat) {
      return MARKETPLACE_CATEGORIES.indexOf(String(cat || '').trim().toLowerCase()) !== -1;
    },
    MARKETPLACE_PLAN_PCT: MARKETPLACE_PLAN_PCT,
    POS_FLAT_PCT: POS_FLAT_PCT,

    /* Refresh from the server so a rate change reaches clients without a client rebuild.
       Merges in place, so anything already rendered keeps working. */
    refresh: function () {
      try {
        if (!window.firebase || !firebase.functions) return Promise.resolve(false);
        return firebase.functions().httpsCallable('getCommissionConfig')({})
          .then(function (res) {
            var d = res && res.data;
            if (!d || !d.rates) return false;
            RATES = d.rates;
            ALIASES = d.aliases || ALIASES;
            MIN_COMMISSION_KES = d.minKES != null ? d.minKES : MIN_COMMISSION_KES;
            window.SokoniCommission.RATES = RATES;
            window.SokoniCommission.ALIASES = ALIASES;
            return true;
          })
          .catch(function () { return false; });
      } catch (e) { return Promise.resolve(false); }
    },
  };

  /* Declarative binding for copy that states a rate — one mechanism, no page-level literals.
       <span data-sokoni-rate="marketplace"></span>                       -> "15%"  (or "KES 2,000" for a flat fee)
       <span data-sokoni-rate="marketplace" data-sokoni-rate-format="keep"></span> -> "85%"  (the seller share)
     A category the authority does not know renders an em dash — never the default bucket, never a guess.
     Runs on DOMContentLoaded and again after refresh(); SokoniCommission.fill(root) re-binds injected markup. */
  function fill(root) {
    var scope = root && root.querySelectorAll ? root : (typeof document !== "undefined" ? document : null);
    if (!scope) return 0;
    var nodes = scope.querySelectorAll("[data-sokoni-rate]"), n = 0;
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i], r = resolve(el.getAttribute("data-sokoni-rate"));
      var fmt = el.getAttribute("data-sokoni-rate-format") || "pct";
      var text = "—";
      if (r.matched) {
        if (r.fixedKES && !r.pct) text = "KES " + Number(r.fixedKES).toLocaleString();
        else if (fmt === "keep") text = (100 - r.pct) + "%";
        else text = r.pct + "%";
      }
      el.textContent = text; n++;
    }
    return n;
  }
  window.SokoniCommission.fill = fill;
  if (typeof document !== "undefined") {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", function () { fill(document); });
    else fill(document);
  }
  var _refresh = window.SokoniCommission.refresh;
  window.SokoniCommission.refresh = function () { return _refresh().then(function (ok) { if (ok) fill(document); return ok; }); };
})(window);
