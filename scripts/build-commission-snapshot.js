#!/usr/bin/env node
'use strict';
/**
 * Generates sokoni-commission-rates.js — the browser's copy of the commission rates.
 *
 * Why a generated snapshot rather than a runtime fetch:
 * clients render "you will be charged X%" the instant a page paints. If the rates arrived
 * asynchronously, the first paint would have nothing to show and the old code's magic
 * fallbacks (`|| 10`) would fire — which is exactly the bug being removed: bnb.html defaulted
 * to 10% while bnb-manage.html defaulted to 5% for the SAME category. A build-time snapshot
 * means the browser always has the real numbers, with no window in which it invents one.
 *
 * The snapshot cannot drift: scripts/verify-commission-single-source.js re-runs this
 * generator and fails the deploy if the committed file differs from the config.
 * SokoniPay also refreshes from getCommissionConfig() at runtime, so a config change that
 * ships without a client rebuild still converges.
 *
 * Run: node scripts/build-commission-snapshot.js          (writes the file)
 *      node scripts/build-commission-snapshot.js --check  (exit 1 if stale — used by the guard)
 */
const fs = require('fs');
const path = require('path');

const CC = require(path.join(__dirname, '..', 'functions', 'commission-config.js'));
const OUT = path.join(__dirname, '..', 'sokoni-commission-rates.js');

/* Strip the provenance notes — the browser does not need them, and they would double the file. */
const rates = {};
for (const [k, v] of Object.entries(CC.RATES)) rates[k] = { pct: v.pct, fixedKES: v.fixedKES };

/* The two LANE schedules. Without these the browser knows only the category table, so a
   pricing page would show every seller a flat 5% while the engine charges a Free seller 15%
   — the same "shown 3%, charged 5%" split that already happened once on this platform, and
   worse, because the gap is 3x rather than 2 points. */
const marketplacePlanPct = {};
for (const [k, v] of Object.entries(CC.MARKETPLACE_PLAN_RATES)) marketplacePlanPct[k] = v.rateFraction * 100;
const posFlatPct = CC.POS_FLAT_RATE_FRACTION * 100;
const marketplaceCategories = Array.from(CC.MARKETPLACE_SELLER_CATEGORIES);

const body = `/* ============================================================================
   SOKONI COMMISSION RATES — GENERATED FILE. DO NOT EDIT.
   ----------------------------------------------------------------------------
   Source of truth : functions/commission-config.js
   Regenerate with : node scripts/build-commission-snapshot.js
   Enforced by     : scripts/verify-commission-single-source.js (fails the deploy if
                     this file and the config disagree)

   Every client-side commission percentage comes from here. Do not hardcode a rate in a
   page, and do not write \`|| 10\` as a fallback — a wrong rate shown to a seller is worse
   than no rate at all. Use SokoniCommission.pct(category), which returns the platform
   default (5%) for anything it does not recognise.

   These are DISPLAY rates. The authoritative figure for a real order comes from the server
   (previewCommission / calculateCommission), which also applies commissionRules overrides
   and commission holidays that this table knows nothing about.
============================================================================ */
;(function (window) {
  'use strict';

  var RATES = ${JSON.stringify(rates, null, 2).replace(/\n/g, '\n  ')};

  var ALIASES = ${JSON.stringify(CC.ALIASES, null, 2).replace(/\n/g, '\n  ')};

  /* MARKETPLACE lane — commission by the seller's PLAN, on orders SOKONI brought them. */
  var MARKETPLACE_PLAN_PCT = ${JSON.stringify(marketplacePlanPct, null, 2).replace(/\n/g, '\n  ')};

  /* POS / TILL lane — shop sales the merchant made themselves. FLAT, every plan. A
     subscription buys a better marketplace rate and changes NOTHING at the till. */
  var POS_FLAT_PCT = ${posFlatPct};

  /* RAW category labels priced by the plan ladder. "pos" is deliberately ABSENT even though
     it ALIASES to marketplace — keying on the resolved category would put every till sale on
     the ladder and triple a Free merchant's till commission. */
  var MARKETPLACE_CATEGORIES = ${JSON.stringify(marketplaceCategories)};

  var MIN_COMMISSION_KES = ${CC.MIN_COMMISSION_KES};

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
`;

if (process.argv.includes('--check')) {
  const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
  if (current.trim() !== body.trim()) {
    console.error('sokoni-commission-rates.js is STALE — it disagrees with functions/commission-config.js.');
    console.error('Run: node scripts/build-commission-snapshot.js');
    process.exit(1);
  }
  console.log('sokoni-commission-rates.js is in sync with commission-config.js');
  process.exit(0);
}

fs.writeFileSync(OUT, body);
console.log('Wrote sokoni-commission-rates.js (' + Object.keys(rates).length + ' categories, '
  + Object.keys(CC.ALIASES).length + ' aliases)');
