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
      "pct": 5,
      "fixedKES": 0
    },
    "food_delivery": {
      "pct": 5,
      "fixedKES": 0
    },
    "property": {
      "pct": 2,
      "fixedKES": 0
    },
    "vehicles": {
      "pct": 0,
      "fixedKES": 2000
    },
    "healthcare": {
      "pct": 5,
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
      "pct": 5,
      "fixedKES": 0
    },
    "digital_products": {
      "pct": 10,
      "fixedKES": 0
    },
    "event_tickets": {
      "pct": 3,
      "fixedKES": 0
    },
    "ppv": {
      "pct": 15,
      "fixedKES": 0
    },
    "services": {
      "pct": 15,
      "fixedKES": 0
    },
    "education": {
      "pct": 15,
      "fixedKES": 0
    },
    "jobs": {
      "pct": 15,
      "fixedKES": 0
    },
    "classifieds": {
      "pct": 8,
      "fixedKES": 0
    },
    "hub": {
      "pct": 12,
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
    "default": {
      "pct": 5,
      "fixedKES": 0
    }
  };

  var ALIASES = {
    "product": "marketplace",
    "products": "marketplace",
    "shopping": "marketplace",
    "pos": "marketplace",
    "b2b": "marketplace",
    "subscription": "subscriptions",
    "restaurant": "food_delivery",
    "food": "food_delivery",
    "home_services": "services",
    "insurance": "services",
    "fitness": "services",
    "pharmacy": "healthcare",
    "property_agent": "property",
    "bnb": "hotel",
    "car_dealer": "vehicles",
    "car_hub": "vehicles",
    "entertainment": "events",
    "sports": "events",
    "freelancer": "jobs",
    "freelance": "jobs",
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

  /* Other spellings of those plans -> the plan. Copied from the SERVER's table
     (commission-config MARKETPLACE_TIER_ALIASES) at build time, never written by hand here. */
  var MARKETPLACE_TIER_ALIASES = {
    "seller_free": "free",
    "seller_basic": "professional",
    "seller_pro": "business",
    "seller_enterprise": "enterprise",
    "starter": "professional",
    "growth": "business",
    "basic": "professional",
    "pro": "business"
  };

  /* The plan an unrecognised, empty or absent plan resolves to — the server's own
     MARKETPLACE_DEFAULT_PLAN, which is the HIGHEST rate, so a display can never under-quote. */
  var MARKETPLACE_DEFAULT_PLAN = "free";

  /* Mirrors commission-config.resolveMarketplaceRate(): the plan and whether it was recognised. */
  function resolveMarketplacePlan(planId) {
    var raw = String(planId == null ? '' : planId).trim().toLowerCase();
    var key = Object.prototype.hasOwnProperty.call(MARKETPLACE_PLAN_PCT, raw) ? raw
      : (Object.prototype.hasOwnProperty.call(MARKETPLACE_TIER_ALIASES, raw) ? MARKETPLACE_TIER_ALIASES[raw] : null);
    return key !== null ? { plan: key, matched: true } : { plan: MARKETPLACE_DEFAULT_PLAN, matched: false };
  }

  /* POS / TILL lane — shop sales the merchant made themselves. FLAT, every plan. A
     subscription buys a better marketplace rate and changes NOTHING at the till. */
  var POS_FLAT_PCT = 5;

  /* RAW category labels priced by the plan ladder. "pos" is deliberately ABSENT even though
     it ALIASES to marketplace — keying on the resolved category would put every till sale on
     the ladder and triple a Free merchant's till commission. */
  var MARKETPLACE_CATEGORIES = ["marketplace","product","products","shopping","b2b"];

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

    /* The rate a seller on planId pays on a MARKETPLACE order. An unrecognised, empty or absent
       plan resolves to the server's default plan — the HIGHEST rate — so a display can never
       under-quote. Never returns undefined. */
    marketplacePct: function (planId) {
      return MARKETPLACE_PLAN_PCT[resolveMarketplacePlan(planId).plan];
    },
    /* Which plan planId resolves to, and whether it was recognised — the same answer the
       server's resolveMarketplaceRate gives (plan, matched). */
    marketplacePlan: resolveMarketplacePlan,
    /* The rate on a POS / till sale. Takes no plan, because it does not depend on one. */
    posPct: function () { return POS_FLAT_PCT; },
    isMarketplaceSellerSale: function (cat) {
      return MARKETPLACE_CATEGORIES.indexOf(String(cat || '').trim().toLowerCase()) !== -1;
    },
    MARKETPLACE_PLAN_PCT: MARKETPLACE_PLAN_PCT,
    MARKETPLACE_TIER_ALIASES: MARKETPLACE_TIER_ALIASES,
    MARKETPLACE_DEFAULT_PLAN: MARKETPLACE_DEFAULT_PLAN,
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
})(window);
