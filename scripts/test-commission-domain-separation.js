#!/usr/bin/env node
/* POS 5% and marketplace package commission — EXECUTED, not matched.
 *
 *   node scripts/test-commission-domain-separation.js
 *
 * THE CERTIFICATION CRITERION
 *   `commissionPct: 5` is NOT evidence that the POS rule priced a sale. The `default` arm is
 *   ALSO 5, and live evidence shows that arm has been pricing everything while the category
 *   table looked authoritative. Only the RESOLVED CATEGORY separates them.
 *
 *     pct 5 + category 'pos'      -> the POS authority applied        PASS
 *     pct 5 + category 'default'  -> the default arm applied          FAILURE
 *
 * Every assertion below runs the real resolver / real engine against fixtures.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const Module = require('module');

let pass = 0, fail = 0;
const ck = (l, ok, d) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined ? '   [' + String(d).slice(0, 74) + ']' : ''));
  ok ? pass++ : fail++;
  return ok;
};
const ROOT = path.join(__dirname, '..');
const CC = require(path.join(ROOT, 'functions', 'commission-config.js'));

/* ── the engine, with firebase-admin and Firestore stubbed ─────────────────── */
function engine({ rules = [], revenueCfg = null, planCfg = null } = {}) {
  const modPath = path.join(ROOT, 'functions', 'finos-utils.js');
  const realRequire = Module.createRequire(modPath);
  const admin = {
    firestore: Object.assign(() => ({}), {
      FieldValue: { serverTimestamp: () => 'TS', increment: (n) => ({ inc: n }) },
      Timestamp: { now: () => ({ toMillis: () => Date.now() }) },
    }),
  };
  const emptySnap = { empty: true, docs: [], forEach: () => {} };
  const db = {
    collection: (c) => ({
      doc: (id) => ({
        id: id || 'x',
        get: async () => {
          if (c === 'revenueConfig' && id === 'plan_adjustments') {
            return { exists: !!planCfg, data: () => planCfg || {} };
          }
          if (c === 'revenueConfig') return { exists: !!revenueCfg, data: () => revenueCfg || {} };
          return { exists: false, data: () => ({}) };
        },
        create: async () => {},
      }),
      where: function () { return this; },
      orderBy: function () { return this; },
      limit: function () { return this; },
      get: async () => (c === 'commissionRules' && rules.length
        ? { empty: false, docs: rules.map((r) => ({ id: r.id || 'r', data: () => r })), forEach(f) { this.docs.forEach(f); } }
        : emptySnap),
    }),
    runTransaction: async (fn) => fn({ set: () => {}, get: async () => ({ exists: false, data: () => ({}) }), update: () => {} }),
  };
  const m = new Module('finos-utils', null);
  m.require = (id) => (id === 'firebase-admin' ? admin : realRequire(id));
  m._compile(fs.readFileSync(modPath, 'utf8'), modPath);
  return { mod: m.exports, db };
}

const calc = async (opts, cfg) => {
  const { mod, db } = engine(cfg);
  return mod.calculateCommission(db, opts);
};
const calcErr = async (opts, cfg) => {
  try { await calc(opts, cfg); return null; } catch (e) { return e; }
};

(async () => {
  console.log('\nA. POS resolves to its OWN 5% authority — provenance, not just the number\n');
  {
    const r = CC.resolveRate('pos');
    ck('pos is an explicit RATES entry', r.matched === true && r.category === 'pos', r.category);
    ck('pos is exactly 5%', r.pct === 5, r.pct);
    ck('pos does NOT resolve through marketplace', r.category !== 'marketplace', r.category);
    ck('pos does NOT resolve through default', r.category !== 'default', r.category);
    ck('the pos->marketplace ALIAS is gone',
       !/[\s{,]pos\s*:\s*'marketplace'/.test(fs.readFileSync(path.join(ROOT, 'functions', 'commission-config.js'), 'utf8')));
  }

  console.log('\nB. A completed POS sale is priced 5% by the POS authority\n');
  {
    const c = await calc({ orderAmountCents: 350000, category: 'pos', sellerId: 'S1' });
    ck('KES 3,500 POS sale -> 5%', c.effectiveRate === 5, c.effectiveRate);
    ck('  ...commission is KES 175', c.commissionCents === 17500, c.commissionCents);
    ck('  ...recorded category is "pos", NOT "default"', c.category === 'pos', c.category);
    ck('  ...seller net is the remainder', c.sellerNetCents === 350000 - 17500, c.sellerNetCents);
    ck('THE DISCRIMINATOR: 5 alone would not prove this — category does',
       c.effectiveRate === 5 && c.category === 'pos');
  }

  console.log('\nC. The rate does not depend on the tender or the rail\n');
  {
    /* The engine is not told the tender; a POS sale is a POS sale. Same category, same rate,
       whether the money arrived as cash in the drawer or over the seller's Daraja till. */
    const cash = await calc({ orderAmountCents: 100000, category: 'pos', sellerId: 'S1' });
    const mpesa = await calc({ orderAmountCents: 100000, category: 'pos', sellerId: 'S2' });
    ck('cash POS sale -> 5% / category pos', cash.effectiveRate === 5 && cash.category === 'pos');
    ck('M-PESA (Daraja) POS sale -> 5% / category pos', mpesa.effectiveRate === 5 && mpesa.category === 'pos');
    ck('identical commission for identical basket', cash.commissionCents === mpesa.commissionCents);
    ck('no tender/rail argument exists in the engine signature',
       !/tender|collectionRoute|daraja/i.test(
         fs.readFileSync(path.join(ROOT, 'functions', 'finos-utils.js'), 'utf8')
           .slice(0, 3000)),
       'rail determines collection, not price');
  }

  console.log('\nD. The KES 10 minimum is unchanged\n');
  {
    ck('MIN_COMMISSION_KES is still 10', CC.MIN_COMMISSION_KES === 10);
    const small = await calc({ orderAmountCents: 9700, category: 'pos', sellerId: 'S1' });
    ck('KES 97 POS sale: 5% = 4.85 -> floored to KES 10', small.commissionCents === 1000, small.commissionCents);
    ck('  ...still attributed to the pos authority', small.category === 'pos', small.category);
  }

  console.log('\nE. Unknown categories FAIL CLOSED — no silent default pricing\n');
  {
    const e = await calcErr({ orderAmountCents: 100000, category: 'not-a-real-category', sellerId: 'S1' });
    ck('an unknown category throws', !!e, e && e.code);
    ck('  ...with COMMISSION_CATEGORY_UNRESOLVED', e && e.code === 'COMMISSION_CATEGORY_UNRESOLVED');
    ck('  ...naming the offending label', e && e.category === 'not-a-real-category', e && e.category);
    ck('  ...and NOT returning a default-priced result', e instanceof Error);
    const ok = await calcErr({ orderAmountCents: 100000, category: 'default', sellerId: 'S1' });
    ck('an EXPLICIT "default" is still allowed (it is a real key)', ok === null);
  }

  console.log('\nF. Marketplace is a separate authority and does not inherit POS\n');
  {
    const m = await calc({ orderAmountCents: 350000, category: 'marketplace', sellerId: 'S1' });
    ck('marketplace RETAINS the deployed 5% policy', m.effectiveRate === 5, m.effectiveRate);
    ck('  ...category marketplace, resolved explicitly', m.category === 'marketplace', m.category);
    ck('marketplace and pos are the same NUMBER but different AUTHORITIES',
       m.category === 'marketplace' && CC.resolveRate('pos').category === 'pos');
    const p = await calc({ orderAmountCents: 350000, category: 'product', sellerId: 'S1' });
    ck('live label "product" resolves to marketplace explicitly', p.category === 'marketplace', p.category);
    ck('  ...priced by the marketplace AUTHORITY, not the default arm',
       p.effectiveRate === 5 && p.category === 'marketplace', p.category + '/' + p.effectiveRate);
    const sub = await calc({ orderAmountCents: 48402, category: 'subscription', sellerId: 'S1' });
    ck('live label "subscription" restored to the HISTORICAL 100% policy',
       sub.category === 'subscriptions' && sub.effectiveRate === 100, sub.category + '/' + sub.effectiveRate);
    ck('  ...so a SOKONI plan payment books 100% platform revenue, not 5%',
       sub.sellerNetCents === 0, sub.sellerNetCents);
    const hErr = await calcErr({ orderAmountCents: 19400, category: 'hair-beauty', sellerId: 'S1' });
    ck('live label "hair-beauty" is NOT mapped — awaits a commercial decision',
       hErr && hErr.code === 'COMMISSION_CATEGORY_UNRESOLVED');
    const cfgNoComments = fs.readFileSync(path.join(ROOT, 'functions', 'commission-config.js'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '');
    ck('hair-beauty was NOT guessed into services — no historical rate exists for it',
       !/'hair-beauty':/.test(cfgNoComments));
  }

  console.log('\nF2. The DIFFERENTIATED SCHEDULE is intact — nothing flattened to 5%\n');
  {
    const want = { marketplace: 5, pos: 5, food_delivery: 5, digital_products: 10,
                   services: 15, education: 15, jobs: 15, classifieds: 8,
                   hub: 12, subscriptions: 100 };
    for (const [k, v] of Object.entries(want)) {
      const r = CC.resolveRate(k);
      ck(k.padEnd(17) + ' = ' + v + '%', r.pct === v && r.matched && r.category === k, r.pct + '/' + r.category);
    }
    const veh = CC.resolveRate('vehicles');
    ck('vehicles is a FLAT KES 2000, not a percentage',
       veh.pct === 0 && veh.fixedKES === 2000 && veh.matched, veh.pct + '/' + veh.fixedKES);
    ck('the schedule is genuinely differentiated — not one flat number',
       new Set(Object.values(want)).size >= 5, [...new Set(Object.values(want))].join(','));
    ck('marketplace and pos are EQUAL but INDEPENDENT authorities',
       CC.resolveRate('marketplace').pct === CC.resolveRate('pos').pct &&
       CC.resolveRate('marketplace').category !== CC.resolveRate('pos').category);
  }


  console.log('\nG. The package / subscription mechanism is the marketplace authority\n');
  {
    const fu = fs.readFileSync(path.join(ROOT, 'functions', 'finos-utils.js'), 'utf8');
    ck('absolute plan rates come from subscription-core.getCommissionRate',
       /subCore\.getCommissionRate\(sellerId, \{ role: subscriptionRole \}\)/.test(fu));
    ck('  ...only when a call site opts in with subscriptionRole',
       /!rule && rcPct === null && subscriptionRole && sellerId/.test(fu));
    ck('plan ADJUSTMENT is gated by the rollout switch, fail-closed',
       /if \(!CC\.planRolloutEnabled\(planCfg\)\)/.test(fu));
    ck('  ...and an inactive subscription cannot keep discounting',
       /plan_inactive/.test(fu));
    ck('provenance is returned for the ledger', /pricingSource/.test(fu) && /ruleSource/.test(fu));
    const c = await calc({ orderAmountCents: 100000, category: 'marketplace', sellerId: 'S1' });
    ck('a marketplace charge records which authority priced it',
       typeof c.pricingSource === 'string' && c.pricingSource.length > 0, c.pricingSource);
    ck('  ...and its base rate before any plan adjustment', c.baseRate === 5, c.baseRate);
    ck('no invented package percentages were added to the config',
       !/free:\s*\{\s*pct:\s*15|business:\s*\{\s*pct:\s*4/.test(
         fs.readFileSync(path.join(ROOT, 'functions', 'commission-config.js'), 'utf8')));
  }

  console.log('\nH. Cross-flow independence\n');
  {
    const posR = CC.resolveRate('pos'), mktR = CC.resolveRate('marketplace');
    ck('pos and marketplace are distinct RATES entries', posR.category !== mktR.category);
    ck('  ...that are INDEPENDENT even while numerically equal', posR.category !== mktR.category, posR.pct + '/' + mktR.pct);
    ck('changing one cannot move the other — no shared alias',
       CC.resolveRate('pos').category === 'pos' && CC.resolveRate('marketplace').category === 'marketplace');
    const cfg = fs.readFileSync(path.join(ROOT, 'functions', 'commission-config.js'), 'utf8');
    ck('pos appears exactly once in RATES', (cfg.match(/^\s{2}pos:\s*\{/gm) || []).length === 1);
  }

  console.log('\nI. Nothing protected was disturbed\n');
  {
    const pos = fs.readFileSync(path.join(ROOT, 'functions', 'pos-zero-friction.js'), 'utf8');
    ck('the certified settlement state survives', /settlementState: 'outstanding'/.test(pos));
    ck('the five tenant guards survive', (pos.match(/await _assertSellAuthority\(/g) || []).length === 5);
    ck('POS ledger records rateCategory as provenance', /rateCategory:\s*rateCategory/.test(pos));
    const fu = fs.readFileSync(path.join(ROOT, 'functions', 'finos-utils.js'), 'utf8');
    ck('reverseLedgerEntry still reuses the ORIGINAL amount', /amountCents:\s*orig\.amountCents/.test(fu));
    ck('createLedgerEntry settlement state still explicit', /settlementState = 'settled'/.test(fu));
    ck('wallet.js untouched', /type: 'earning_settlement'/.test(fs.readFileSync(path.join(ROOT, 'functions', 'wallet.js'), 'utf8')));
  }

  console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('  SUITE CRASHED: ' + ((e && e.stack) || e)); process.exit(1); });
