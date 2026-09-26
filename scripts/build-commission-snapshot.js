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

/* THE PLAN-NAME TABLE COMES FROM THE SERVER, NOT FROM THIS TEMPLATE.
   The browser's plan lookup used to be a hand-written map inside the template below
   ({ free:'seller_free', basic:'seller_basic', … }, falling back to 'seller_free'). When the
   2026-09-13 packages renamed the plans, the TABLE regenerated with the new keys and the
   hand-written map did not — so marketplacePct() returned `undefined` for 11 of 15 spellings,
   and `--check` still said "in sync", because both sides came from the same stale template.

   `MARKETPLACE_TIER_ALIASES` is not exported by commission-config.js, and this repair does not
   change server code. So it is read from the REAL config source: compiled in a private module
   with one line appended that hands the constant out. The file itself is never modified. A
   rename of the constant makes this THROW (fail closed), and every entry is then cross-checked
   against the exported resolver, so the table the browser gets is provably the one the server
   resolves with — not a parse, and not a guess. */
function loadServerTierAliases() {
  const Module = require('module');
  const file = path.join(__dirname, '..', 'functions', 'commission-config.js');
  const src = fs.readFileSync(file, 'utf8')
    + '\n;module.exports.__SNAPSHOT_TIER_ALIASES__ = MARKETPLACE_TIER_ALIASES;\n';
  const m = new Module(file, module);
  m.filename = file;
  m.paths = Module._nodeModulePaths(path.dirname(file));
  m._compile(src, file);
  const t = m.exports.__SNAPSHOT_TIER_ALIASES__;
  if (!t || typeof t !== 'object') throw new Error('commission-config.js: MARKETPLACE_TIER_ALIASES not found');
  const out = {};
  for (const [spelling, plan] of Object.entries(t)) {
    const r = CC.resolveMarketplaceRate(spelling);
    if (!r.matched || r.plan !== plan) {
      throw new Error(`plan alias ${spelling} -> ${plan} disagrees with resolveMarketplaceRate (${r.plan}, matched=${r.matched})`);
    }
    out[spelling] = plan;
  }
  return out;
}
const marketplaceTierAliases = loadServerTierAliases();
const marketplaceDefaultPlan = CC.MARKETPLACE_DEFAULT_PLAN;
if (!Object.prototype.hasOwnProperty.call(marketplacePlanPct, marketplaceDefaultPlan)) {
  throw new Error('MARKETPLACE_DEFAULT_PLAN ' + marketplaceDefaultPlan + ' is not a plan in MARKETPLACE_PLAN_RATES');
}
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

  /* Other spellings of those plans -> the plan. Copied from the SERVER's table
     (commission-config MARKETPLACE_TIER_ALIASES) at build time, never written by hand here. */
  var MARKETPLACE_TIER_ALIASES = ${JSON.stringify(marketplaceTierAliases, null, 2).replace(/\n/g, '\n  ')};

  /* The plan an unrecognised, empty or absent plan resolves to — the server's own
     MARKETPLACE_DEFAULT_PLAN, which is the HIGHEST rate, so a display can never under-quote. */
  var MARKETPLACE_DEFAULT_PLAN = ${JSON.stringify(marketplaceDefaultPlan)};

  /* Mirrors commission-config.resolveMarketplaceRate(): the plan and whether it was recognised. */
  function resolveMarketplacePlan(planId) {
    var raw = String(planId == null ? '' : planId).trim().toLowerCase();
    var key = Object.prototype.hasOwnProperty.call(MARKETPLACE_PLAN_PCT, raw) ? raw
      : (Object.prototype.hasOwnProperty.call(MARKETPLACE_TIER_ALIASES, raw) ? MARKETPLACE_TIER_ALIASES[raw] : null);
    return key !== null ? { plan: key, matched: true } : { plan: MARKETPLACE_DEFAULT_PLAN, matched: false };
  }

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
`;

/* SEMANTIC PARITY — the browser must ANSWER what the server answers, not merely match the text
   this template produces. Text equality alone passed while marketplacePct() returned undefined
   for 11 of 15 spellings, because the generator and the committed file shared the same stale
   template. This evaluates the COMMITTED file as a browser would and asks it, for every plan the
   server knows, every alias, a genuinely unknown plan and empty input, what the server says. */
function parityProblems(source) {
  const vm = require('vm');
  const sandbox = { window: {} };
  try { vm.runInNewContext(source, sandbox, { timeout: 2000 }); } catch (e) { return ['snapshot does not evaluate: ' + e.message]; }
  const S = sandbox.window.SokoniCommission;
  if (!S || typeof S.marketplacePct !== 'function') return ['snapshot exposes no marketplacePct()'];
  const probes = [...Object.keys(CC.MARKETPLACE_PLAN_RATES), ...Object.keys(marketplaceTierAliases),
    'zz-unknown-plan', '', '   ', null, undefined];
  const out = [];
  for (const p of probes) {
    const srv = CC.resolveMarketplaceRate(p);
    const b = S.marketplacePct(p);
    const bp = typeof S.marketplacePlan === 'function' ? S.marketplacePlan(p) : null;
    if (b !== srv.pct) out.push(`marketplacePct(${JSON.stringify(p)}) browser ${b} vs server ${srv.pct}`);
    if (!bp || bp.plan !== srv.plan || bp.matched !== srv.matched) {
      out.push(`marketplacePlan(${JSON.stringify(p)}) browser ${JSON.stringify(bp)} vs server ${srv.plan}/${srv.matched}`);
    }
  }
  if (S.posPct() !== CC.resolvePosRate(CC.POS_DEFAULT_PLAN).pct) out.push(`posPct browser ${S.posPct()} vs server ${CC.resolvePosRate(CC.POS_DEFAULT_PLAN).pct}`);
  if (S.MIN_COMMISSION_KES !== CC.MIN_COMMISSION_KES) out.push(`MIN_COMMISSION_KES browser ${S.MIN_COMMISSION_KES} vs server ${CC.MIN_COMMISSION_KES}`);
  return out;
}

if (process.argv.includes('--check')) {
  const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
  if (current.trim() !== body.trim()) {
    console.error('sokoni-commission-rates.js is STALE — it disagrees with functions/commission-config.js.');
    console.error('Run: node scripts/build-commission-snapshot.js');
    process.exit(1);
  }
  const problems = parityProblems(current);
  if (problems.length) {
    console.error('sokoni-commission-rates.js is in sync as TEXT but its answers disagree with the server:');
    for (const p of problems) console.error('  - ' + p);
    process.exit(1);
  }
  console.log('sokoni-commission-rates.js is in sync with commission-config.js (text and answers)');
  process.exit(0);
}

fs.writeFileSync(OUT, body);
console.log('Wrote sokoni-commission-rates.js (' + Object.keys(rates).length + ' categories, '
  + Object.keys(CC.ALIASES).length + ' aliases)');
