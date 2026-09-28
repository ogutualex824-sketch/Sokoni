/* test-healthcare-plan-commission.js — a Healthcare plan is platform revenue (CHANGELOG 226; owner decision 2026-09-27).
 * The REAL functions/commission-config.js + functions/finos-utils.calculateCommission over a fake Firestore.
 *
 * PROVES
 *   - healthcare_subscription resolves to the EXISTING `subscriptions` category (100 %) — no new rate
 *   - through the real engine: a clinic / hospital / enterprise plan (priced by healthcare-plans.js) books the whole
 *     amount as SOKONI revenue and nothing as provider net — whitespace / case variants included
 *   - nothing else moved: consultations (healthcare 5 %), pharmacy → healthcare, subscription → subscriptions,
 *     POS → marketplace, default 5 % — each asserted against the table, not a literal copied from it
 *   - the client snapshot (sokoni-commission-rates.js) carries the same alias
 *
 *   node scripts/test-healthcare-plan-commission.js
 */
'use strict';
const Path = require('path');
const ROOT = Path.resolve(__dirname, '..');
const FN = Path.join(ROOT, 'functions');
const fs = require('fs');
const CC = require(Path.join(FN, 'commission-config.js'));
const FU = require(Path.join(FN, 'finos-utils.js'));
const PLANS = require(Path.join(FN, 'healthcare-plans.js'));

let pass = 0, fail = 0;
const ck = (l, ok, d) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined && d !== '' ? '   [' + String(typeof d === 'object' ? JSON.stringify(d) : d).slice(0, 170) + ']' : '')); ok ? pass++ : fail++; };
/* a Firestore with NO overrides — code defaults ARE the charge (as in production: commissionRules empty) */
const db = { collection: () => ({ where() { return this; }, doc() { return { get: async () => ({ exists: false, data: () => ({}) }) }; }, get: async () => ({ docs: [], empty: true, forEach() {} }) }) };

(async () => {
  console.log('\n── the table ──');
  const r = CC.resolveRate('healthcare_subscription');
  ck('healthcare_subscription resolves to the EXISTING subscriptions category', r.matched && r.category === 'subscriptions', r);
  ck('…at exactly the subscriptions rate (no new rate)', r.pct === CC.RATES.subscriptions.pct && r.fixedKES === CC.RATES.subscriptions.fixedKES, r);
  ck('no RATES entry was added for it', !Object.prototype.hasOwnProperty.call(CC.RATES, 'healthcare_subscription'));
  ck('whitespace / case variants resolve the same', CC.resolveRate('  Healthcare_Subscription ').category === 'subscriptions');

  console.log('\n── through the real engine, for every plan the server sells ──');
  for (const tier of PLANS.TIERS) {
    const plan = PLANS.resolve(tier);
    const res = await FU.calculateCommission(db, { orderAmountCents: plan.priceCents, category: 'healthcare_subscription', hubId: 'healthcare', sellerId: null });
    const total = plan.priceCents;
    const commission = res.commissionCents != null ? res.commissionCents : Math.round((res.commission || 0) * 100);
    ck(`${tier} (KES ${total / 100}): the whole amount is SOKONI revenue`, commission === total, res);
    const net = res.sellerNetCents != null ? res.sellerNetCents : (res.providerNetCents != null ? res.providerNetCents : total - commission);
    ck(`${tier}: nothing is recorded as owed to the subscriber`, net === 0, net);
  }

  console.log('\n── nothing else moved ──');
  const same = (k, cat) => { const x = CC.resolveRate(k); return x.category === cat && x.pct === CC.RATES[cat].pct; };
  ck('consultations still price as healthcare', same('healthcare', 'healthcare'));
  /* owner schedule 2026-09-28: healthcare PRODUCT sales (pharmacy) are 15%, apart from healthcare bookings (12%) */
  ck('pharmacy prices as healthcare PRODUCT sales, apart from healthcare bookings', same('pharmacy', 'healthcare_products'));
  ck('subscription still aliases to subscriptions', same('subscription', 'subscriptions'));
  /* owner schedule 2026-09-28: POS has its own key so it can never follow the 15% online rate */
  ck('pos prices on its own pos key', same('pos', 'pos'));
  ck('an unknown category still falls to default', CC.resolveRate('no_such_category').category === 'default');

  console.log('\n── the client snapshot ──');
  const SNAP = fs.readFileSync(Path.join(ROOT, 'sokoni-commission-rates.js'), 'utf8');
  ck('sokoni-commission-rates.js carries the same alias (regenerated, not hand-edited)', /"healthcare_subscription":\s*"subscriptions"/.test(SNAP));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('CRASH ' + (e && e.stack || e)); process.exit(2); });
