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
      "pct": 0,
      "fixedKES": 2000
    },
    "healthcare": {
      "pct": 12,
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
      "pct": 14,
      "fixedKES": 0
    },
    "car_rental": {
      "pct": 16,
      "fixedKES": 0
    },
    "pos": {
      "pct": 5,
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
    "default": {
      "pct": 5,
      "fixedKES": 0
    }
  };

  var ALIASES = {
    "product": "marketplace",
    "products": "marketplace",
    "shopping": "marketplace",
    "b2b": "marketplace",
    "till": "pos",
    "quick_charge": "pos",
    "quickcharge": "pos",
    "subscription": "subscriptions",
    "healthcare_subscription": "subscriptions",
    "restaurant": "food_delivery",
    "food": "food_delivery",
    "insurance": "services",
    "fitness": "services",
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

    /* The rate a seller on planId pays on a MARKETPLACE order. An unrecognised or absent
       plan resolves to Free — the HIGHEST rate — so a display can never under-quote. */
    marketplacePct: function (planId) {
      var k = String(planId || '').trim().toLowerCase();
      /* Mirrors commission-config.MARKETPLACE_TIER_ALIASES exactly. 'starter' and
         'business' are deliberately absent there and must stay absent here — a client
         that resolved them would quote a rate the server does not charge. */
      var alias = { free:'seller_free', basic:'seller_basic', pro:'seller_pro',
                    enterprise:'seller_enterprise' };
      if (!Object.prototype.hasOwnProperty.call(MARKETPLACE_PLAN_PCT, k)) k = alias[k] || 'seller_free';
      return MARKETPLACE_PLAN_PCT[k];
    },
    /* The rate on a POS / till sale. Takes no plan, because it does not depend on one. */
    posPct: function () { return POS_FLAT_PCT; },
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
})(window);
