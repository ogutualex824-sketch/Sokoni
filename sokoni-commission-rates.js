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
    "shopping": "marketplace",
    "pos": "marketplace",
    "b2b": "marketplace",
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

    /* Refresh from the server so a rate change reaches clients without a client rebuild.
       Merges in place, so anything already rendered keeps working. */
    refresh: function () {
      try {
        if (!window.firebase || !firebase.functions) return Promise.resolve(false);
        /* COMMISSION CUTOVER — through the one door. Same handler, same
           response; only the transport changed. */
        return firebase.functions().httpsCallable('commissionDispatch')({ op: 'getCommissionConfig' })
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
