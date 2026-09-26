#!/usr/bin/env node
'use strict';
/**
 * CERTIFICATION — the commission authority resolves only its OWN table keys.
 *
 *   node scripts/test-commission-own-property.js
 *
 * The defect (measured on 45bcc44): the rate tables in functions/commission-config.js are plain
 * object literals read with bare `TABLE[k]`, so an INHERITED name matched:
 *   - resolveRate('constructor' | '__proto__')  -> { category:'constructor', matched:true } with no
 *     pct. calculateCommission returned commission NaN; the webhook's `commissionCents ? … : 0`
 *     recorded sokoniCut 0 and providerNet = the whole sale, and — nothing having thrown — nothing
 *     reached commissionReviewQueue. The category is the caller's own payment `meta.category`.
 *   - resolveMarketplaceRate('constructor' | '__proto__') -> THREW.
 *
 * Proves, with no rate literal (every expectation derives from the authority):
 *   X  every name Object.prototype carries resolves as an UNKNOWN key on every resolver, and the
 *      real engine charges the authorised fallback — finite, non-zero, never the whole sale
 *   Q  every LEGITIMATE key, unknown and empty input resolves IDENTICALLY to the pre-repair
 *      resolver (loaded privately from git at BASE_REV), so no rate policy moved
 *   M  the KES minimum and the POS lane are unchanged
 *
 *   REPAIR_ROOT  tree under test (default: this repo). Pointed at the pre-repair tree it must FAIL.
 * No emulator, no network.
 */
const path = require('path');
const fs = require('fs');
const Module = require('module');
const { execSync } = require('child_process');

const ROOT = path.resolve(process.env.REPAIR_ROOT || path.join(__dirname, '..'));
const FN = path.join(ROOT, 'functions');
const BASE_REV = process.env.BASE_REV || '45bcc44';

let pass = 0, fail = 0;
const ck = (label, ok, detail) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + label + (detail !== undefined && detail !== '' ? '   [' + String(detail).slice(0, 170) + ']' : ''));
  ok ? pass++ : fail++;
};
const safe = (fn) => { try { return { v: fn() }; } catch (e) { return { err: e.message }; } };

const orig = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === 'firebase-admin') return { firestore: Object.assign(() => ({}), { FieldValue: { serverTimestamp: () => 'ts' }, Timestamp: { now: () => ({ toMillis: () => Date.now() }) } }) };
  if (id === 'firebase-functions/v2/https') return { onCall: (_o, h) => h, HttpsError: class extends Error {} };
  if (id === 'firebase-functions/logger') return { info() {}, warn() {}, error() {}, debug() {} };
  if (id === 'firebase-functions/params') return { defineSecret: (name) => ({ name, value: () => '0' }) };
  return orig.apply(this, arguments);
};
const CC = require(path.join(FN, 'commission-config.js'));
const U = require(path.join(FN, 'finos-utils.js'));
const SE = require(path.join(FN, 'settlement-engine.js'));
Module.prototype.require = orig;

/* The PRE-REPAIR resolver, compiled privately from git — the equivalence baseline. */
function loadBase() {
  const src = execSync(`git show ${BASE_REV}:functions/commission-config.js`, { cwd: path.join(__dirname, '..'), encoding: 'utf8' });
  const file = path.join(FN, '__base_commission_config__.js');
  const m = new Module(file, module); m.filename = file; m.paths = Module._nodeModulePaths(FN);
  m._compile(src, file);
  return m.exports;
}
const BASE = loadBase();

const makeDb = () => { const empty = { empty: true, docs: [], forEach() {} }; return { collection() { return { doc() { return { async get() { return { exists: false, data: () => undefined }; } }; }, where() { return this; }, async get() { return empty; } }; } }; };
const withPlan = (tier) => { const s = require(path.join(FN, 'subscription-core.js')); s.resolveSubscription = async () => ({ found: true, tier, planId: tier, status: 'active', features: {} }); s.isActive = (x) => x === 'active'; };

/* Every name an object literal inherits — not just the two that were reported. */
const INHERITED = [...new Set([...Object.getOwnPropertyNames(Object.prototype), 'constructor', '__proto__'])];

(async () => {
  console.log(`\nCommission authority — own-property lookups   (tree: ${ROOT}; baseline ${BASE_REV})\n`);
  const def = CC.resolveRate('zz-no-such-category');
  const defPlan = CC.resolveMarketplaceRate('zz-no-such-plan');
  ck('X0  CONTROL — the fallbacks the collisions must land on are the authorised ones',
    def.category === 'default' && def.matched === false && defPlan.plan === CC.MARKETPLACE_DEFAULT_PLAN && defPlan.matched === false,
    `category default ${def.pct}%, plan ${defPlan.plan} ${defPlan.pct}%`);

  console.log('\nPART X — every inherited name is an UNKNOWN key\n');
  {
    const bad = [];
    for (const n of INHERITED) {
      const r = safe(() => CC.resolveRate(n));
      if (r.err || r.v.category !== 'default' || r.v.matched !== false || r.v.pct !== def.pct) bad.push(n + ':' + (r.err || JSON.stringify(r.v)));
    }
    ck(`X1  resolveRate: all ${INHERITED.length} inherited names -> the category default (${def.pct}%), unmatched`, bad.length === 0, bad.join(' | ') || INHERITED.join(' '));
  }
  {
    const bad = INHERITED.filter((n) => { const r = safe(() => CC.categoryForHub(n)); return r.err || r.v !== 'default'; });
    ck('X2  categoryForHub: every inherited name -> default', bad.length === 0, bad.join(', '));
  }
  {
    const bad = [];
    for (const n of INHERITED) {
      const r = safe(() => CC.resolveMarketplaceRate(n));
      if (r.err || r.v.plan !== defPlan.plan || r.v.matched !== false || r.v.pct !== defPlan.pct) bad.push(n + ':' + (r.err || JSON.stringify(r.v)));
    }
    ck(`X3  resolveMarketplaceRate: every inherited name -> the default plan (${defPlan.plan}, ${defPlan.pct}%), no throw`, bad.length === 0, bad.join(' | '));
  }
  {
    const bad = INHERITED.filter((n) => { const r = safe(() => CC.resolvePosRate(n)); return r.err || r.v.pct !== CC.resolvePosRate('zz').pct; });
    ck('X4  resolvePosRate: every inherited name -> the POS default (already guarded; must stay so)', bad.length === 0, bad.join(', '));
  }

  console.log('\nPART E — the real engine, on both inputs that reach the authority\n');
  const GROSS = 1000000;
  const expectDefault = Math.max(Math.round(GROSS * def.pct / 100), CC.MIN_COMMISSION_KES * 100);
  const expectPlan = Math.max(Math.round(GROSS * defPlan.rateFraction), CC.MIN_COMMISSION_KES * 100);
  for (const n of ['constructor', '__proto__']) {
    withPlan('seller_free');
    const c = await U.calculateCommission(makeDb(), { orderAmountCents: GROSS, category: n, sellerId: 'S' }).catch((e) => ({ err: e.message }));
    ck(`E1  category=${n.padEnd(11)}: finite commission at the category default = ${expectDefault}`,
      !c.err && Number.isFinite(c.commissionCents) && c.commissionCents === expectDefault && c.effectiveRate === def.pct,
      c.err || `${c.commissionCents} cents @ ${c.effectiveRate}%`);
    /* The webhook's own arithmetic (index.js webhookIntasend), verbatim. */
    const sokoniCut = !c.err && c.commissionCents ? Math.round(c.commissionCents / 100) : 0;
    ck(`E2  category=${n.padEnd(11)}: the webhook records a real cut, not 0 / the whole sale to the payee`,
      sokoniCut === Math.round(expectDefault / 100), `sokoniCut ${sokoniCut}, providerNet ${GROSS / 100 - sokoniCut} of ${GROSS / 100}`);
    const b = await SE.computeSettlement(makeDb(), { grossCents: GROSS, category: n, sellerId: 'S' }).catch((e) => ({ err: e.message }));
    ck(`E3  category=${n.padEnd(11)}: settlement keeps the commission (seller is NOT credited the whole gross)`,
      !b.err && b.commission.cents === expectDefault && b.sellerNetCents === GROSS - expectDefault, b.err || `${b.commission.cents} / ${b.sellerNetCents}`);
    withPlan(n);
    const p = await U.calculateCommission(makeDb(), { orderAmountCents: GROSS, category: 'product', sellerId: 'S' }).catch((e) => ({ err: e.message }));
    ck(`E4  plan=${n.padEnd(15)}: no throw; the default plan at ${defPlan.pct}% = ${expectPlan}`,
      !p.err && p.commissionCents === expectPlan && p.marketplacePlan === defPlan.plan, p.err || `${p.commissionCents} cents, plan ${p.marketplacePlan}`);
  }

  console.log('\nPART Q — every legitimate key resolves IDENTICALLY to the pre-repair resolver\n');
  {
    const keys = [...Object.keys(BASE.RATES), ...Object.keys(BASE.ALIASES), 'zz-unknown', '', '   ', null, undefined, 'PRODUCT', ' Marketplace '];
    const diff = keys.filter((k) => JSON.stringify(CC.resolveRate(k)) !== JSON.stringify(BASE.resolveRate(k)));
    ck(`Q1  resolveRate: ${keys.length} legitimate / unknown / empty keys unchanged`, diff.length === 0, diff.map(String).join(', '));
    const hubs = keys.filter((k) => CC.categoryForHub(k) !== BASE.categoryForHub(k));
    ck('Q2  categoryForHub unchanged for the same keys', hubs.length === 0, hubs.map(String).join(', '));
  }
  {
    const planKeys = [...Object.keys(BASE.MARKETPLACE_PLAN_RATES), 'seller_free', 'seller_basic', 'seller_pro', 'seller_enterprise',
      'starter', 'growth', 'basic', 'pro', 'Free', ' BUSINESS ', 'platinum', 'zz-unknown', '', null, undefined];
    const diff = planKeys.filter((k) => JSON.stringify(CC.resolveMarketplaceRate(k)) !== JSON.stringify(BASE.resolveMarketplaceRate(k)));
    ck(`Q3  resolveMarketplaceRate: ${planKeys.length} plans / aliases / unknown / empty unchanged`, diff.length === 0, diff.map(String).join(', '));
    const posDiff = planKeys.filter((k) => JSON.stringify(CC.resolvePosRate(k)) !== JSON.stringify(BASE.resolvePosRate(k)));
    ck('Q4  resolvePosRate unchanged for the same inputs', posDiff.length === 0, posDiff.map(String).join(', '));
  }
  ck('Q5  the rate TABLES themselves are unchanged (no policy moved)',
    JSON.stringify(CC.RATES) === JSON.stringify(BASE.RATES) && JSON.stringify(CC.ALIASES) === JSON.stringify(BASE.ALIASES)
      && JSON.stringify(CC.MARKETPLACE_PLAN_RATES) === JSON.stringify(BASE.MARKETPLACE_PLAN_RATES)
      && JSON.stringify(CC.POS_PLAN_RATES) === JSON.stringify(BASE.POS_PLAN_RATES)
      && CC.MIN_COMMISSION_KES === BASE.MIN_COMMISSION_KES && CC.MARKETPLACE_DEFAULT_PLAN === BASE.MARKETPLACE_DEFAULT_PLAN);

  console.log('\nPART M — minimum and POS, through the engine\n');
  {
    withPlan('seller_free');
    const small = Math.floor(CC.MIN_COMMISSION_KES * 100 / defPlan.rateFraction) - 100;
    const r = await U.calculateCommission(makeDb(), { orderAmountCents: small, category: 'product', sellerId: 'S' });
    ck(`M1  the KES ${CC.MIN_COMMISSION_KES} minimum still sets the commission below the crossover (KES ${small / 100})`,
      r.commissionCents === CC.MIN_COMMISSION_KES * 100, String(r.commissionCents));
    const pos = await SE.computeSettlement(makeDb(), { grossCents: GROSS, category: 'pos', sellerId: 'S', hubId: 'pos' });
    ck('M2  a POS sale through the engine is priced at the till authority\'s rate', pos.commission.rate === CC.resolvePosRate('seller_free').pct,
      pos.commission.rate + '% vs ' + CC.resolvePosRate('seller_free').pct + '%');
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('\nsuite crashed:', e.stack); process.exit(2); });
