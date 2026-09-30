#!/usr/bin/env node
'use strict';
/* ============================================================================
   PROVIDER BOOKING LADDER — plan id → canonical rate → engine → ledger row → invoice; FAIL CLOSED
   ----------------------------------------------------------------------------
   Owner schedule 2026-09-28: provider bookings are priced by the provider's PLAN at
   20 / 15 / 10 / 7 / 5, keyed by PLAN ID in commission-config.PROVIDER_PLAN_RATES.
   Owner 2026-09-30: known id → known rate; aliased historical spelling → its plan;
   unknown or RETIRED id → REFUSED (never an arbitrary rate). No plan at all = Free (20%).

     A  the authority: known / alias / none / retired / unknown
     B  subscription-core delegates; a refused plan is an ERROR, not a number
     C  finos-utils.calculateCommission charges the plan rate, records the plan, no floor;
        a booking on a retired or unknown plan THROWS provider_plan_refused (fail closed)
     D  a commissionLedger row built from the engine result invoices for EXACTLY that amount
     E  retired plans are hidden from sale (PLANS isActive:false) and refused by createPaymentIntent
     F  the client snapshot mirrors the server (alias → rate, unknown → null)
     NC negative control

   Pure: stub Firestore, fiscal engine stubbed at its boundary. node scripts/test-provider-plan-ladder.js
   ============================================================================ */
const fs = require('fs');
const path = require('path');
process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:1';
const ROOT = path.resolve(__dirname, '..');
const NM = path.join(ROOT, 'functions', 'node_modules');
const admin = require(path.join(NM, 'firebase-admin'));
if (!admin.apps.length) admin.initializeApp({ projectId: 'sokoni-provider-ladder-test' });
const CC = require(path.join(ROOT, 'functions', 'commission-config'));

let pass = 0, fail = 0;
const ck = (label, ok, detail) => { if (ok) { pass++; console.log(`  PASS  ${label}`); } else { fail++; console.log(`  FAIL  ${label}${detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''}`); } };

let PROVIDER_DOCS = {};
const snap = (data, id) => ({ exists: !!data, data: () => data, id });
function makeDb() {
  return {
    collection(name) {
      return {
        doc(id) { return { async get() { return snap(name === 'providerSubscriptions' ? (PROVIDER_DOCS[id] || null) : null, id); } }; },
        where() { return this; }, limit() { return this; },
        async get() { return { docs: [], empty: true, size: 0 }; },
      };
    },
  };
}
const stubDb = makeDb();
const gfPath = require.resolve('firebase-admin/firestore', { paths: [NM] });
const realGf = require(gfPath);
require.cache[gfPath].exports = { ...realGf, getFirestore: () => stubDb };

const core = require(path.join(ROOT, 'functions', 'subscription-core'));
const FU   = require(path.join(ROOT, 'functions', 'finos-utils'));
const SB   = require(path.join(ROOT, 'functions', 'sub-billing'));

(async () => {
  console.log('Provider booking ladder — plan id → rate → engine → ledger → invoice, fail closed\n');

  const want = { provider_free: 20, starter: 15, pro: 10, business: 7, enterprise: 5 };
  ck('A1 PROVIDER_PLAN_RATES is exactly the owner schedule, keyed by plan id',
     JSON.stringify(Object.fromEntries(Object.entries(CC.PROVIDER_PLAN_RATES).map(([k, v]) => [k, v.pct]))) === JSON.stringify(want), CC.PROVIDER_PLAN_RATES);
  for (const [id, pct] of Object.entries(want)) {
    const r = CC.resolveProviderRate(id);
    ck(`A2 ${id.padEnd(14)} -> ${pct}% (matched, not refused, source = the authority)`, r.ok && !r.refused && r.pct === pct && r.matched === true && r.rateFraction === pct / 100 && r.source === 'commission-config.PROVIDER_PLAN_RATES', r);
  }
  const none = CC.resolveProviderRate(null), blank = CC.resolveProviderRate('  ');
  ck('A3 NO plan (null / blank) -> Free 20%: a known commercial state, not a fallback', none.ok && none.pct === 20 && none.plan === 'provider_free' && blank.pct === 20, { none, blank });
  const ft = CC.resolveProviderRate('free_trial');
  ck('A4 historical spelling free_trial (every production providerSubscriptions doc) -> provider_free 20%, aliasOf recorded', ft.ok && ft.pct === 20 && ft.plan === 'provider_free' && ft.aliasOf === 'free_trial', ft);
  for (const legacy of ['provider_basic', 'provider_pro']) {
    const r = CC.resolveProviderRate(legacy);
    ck(`A5 RETIRED ${legacy} -> REFUSED (provider_plan_retired), pct null — never an arbitrary rate`, r.refused === true && r.ok === false && r.reason === 'provider_plan_retired' && r.pct === null && r.rateFraction === null, r);
  }
  const unk = CC.resolveProviderRate('nonsense_plan');
  ck('A6 UNKNOWN plan -> REFUSED (provider_plan_unknown), pct null', unk.refused === true && unk.reason === 'provider_plan_unknown' && unk.pct === null, unk);
  ck('A7 case / whitespace tolerant on a known id', CC.resolveProviderRate('  Pro ').pct === 10);
  ck('A8 the alias table is exactly { free_trial } and the retired list exactly the two legacy ids',
     JSON.stringify(CC.PROVIDER_PLAN_ALIASES) === '{"free_trial":"provider_free"}' && JSON.stringify(CC.PROVIDER_RETIRED_IDS) === '["provider_basic","provider_pro"]', { a: CC.PROVIDER_PLAN_ALIASES, r: CC.PROVIDER_RETIRED_IDS });

  PROVIDER_DOCS = { P1: { plan: 'business', status: 'active', commissionRate: 0.01 } };
  ck('B1 an ACTIVE provider on business pays 7% — the document commissionRate (1%) is IGNORED', (await core.getCommissionRate('P1', { role: 'provider' })) === 0.07);
  const pr = await core.getProviderPlanRate('P1');
  ck('B2 getProviderPlanRate carries provenance: plan business, matched, active', pr.plan === 'business' && pr.matched === true && pr.active === true, pr);
  PROVIDER_DOCS = { P2: { plan: 'business', status: 'expired', expiryDate: Date.now() - 86400000 } };
  ck('B3 an EXPIRED business plan is charged as Free (20%) — an inactive plan buys nothing', (await core.getCommissionRate('P2', { role: 'provider' })) === 0.20);
  PROVIDER_DOCS = {};
  ck('B4 no subscription document at all -> 20% (Free), not a role default of some other number', (await core.getCommissionRate('P3', { role: 'provider' })) === 0.20);
  PROVIDER_DOCS = { P5: { plan: 'free_trial', status: 'active' } };
  const ftr = await core.getProviderPlanRate('P5');
  ck('B5 the production spelling free_trial resolves through the alias to 20%', ftr.pct === 20 && ftr.plan === 'provider_free' && ftr.aliasOf === 'free_trial', ftr);
  for (const [uid, plan] of [['P6', 'provider_basic'], ['P7', 'provider_pro'], ['P8', 'nonsense_plan']]) {
    PROVIDER_DOCS = { [uid]: { plan, status: 'active' } };
    let err = null; try { await core.getCommissionRate(uid, { role: 'provider' }); } catch (e) { err = e; }
    ck(`B6 an ACTIVE subscription on ${plan} -> ERROR provider_plan_refused (${plan.startsWith('provider_') ? 'retired' : 'unknown'}), no number returned`, err && err.code === 'provider_plan_refused' && /provider_plan_(retired|unknown)/.test(err.reason), err && { code: err.code, reason: err.reason });
  }

  PROVIDER_DOCS = { P4: { plan: 'pro', status: 'active' } };
  const r4 = await FU.calculateCommission(makeDb(), { orderAmountCents: 1000000, category: 'services', sellerId: 'P4', hubId: 'provider', subscriptionRole: 'provider' });
  ck('C1 KES 10,000 booking on Professional (pro) -> commission KES 1,000 (10%)', r4.commissionCents === 100000 && r4.effectiveRate === 10, { c: r4.commissionCents, rate: r4.effectiveRate });
  ck('C2 the result names the plan and the authority', r4.providerPlan === 'pro' && r4.providerPlanMatched === true && r4.providerRateSource === 'commission-config.PROVIDER_PLAN_RATES', { plan: r4.providerPlan, src: r4.providerRateSource });
  ck('C3 pricingSource = subscription_plan_rate (compatibility mode)', /subscription_plan_rate/.test(r4.pricingSource), r4.pricingSource);
  PROVIDER_DOCS = { P9: { plan: 'enterprise', status: 'active' } };
  const r5 = await FU.calculateCommission(makeDb(), { orderAmountCents: 2000, category: 'services', sellerId: 'P9', hubId: 'provider', subscriptionRole: 'provider' });
  ck('C4 KES 20 booking on Enterprise -> KES 1 (5%), NO KES 10 floor on the provider lane', r5.commissionCents === 100, r5.commissionCents);
  PROVIDER_DOCS = { P10: { plan: 'free_trial', status: 'active' } };
  const r6 = await FU.calculateCommission(makeDb(), { orderAmountCents: 1000000, category: 'services', sellerId: 'P10', hubId: 'provider', subscriptionRole: 'provider' });
  ck('C5 a free_trial provider is charged 20% and the result records aliasOf', r6.commissionCents === 200000 && r6.providerPlan === 'provider_free' && r6.providerPlanAliasOf === 'free_trial', { c: r6.commissionCents, alias: r6.providerPlanAliasOf });
  for (const [uid, plan] of [['P11', 'provider_basic'], ['P12', 'provider_pro'], ['P13', 'nonsense_plan']]) {
    PROVIDER_DOCS = { [uid]: { plan, status: 'active' } };
    let err = null, res = null; try { res = await FU.calculateCommission(makeDb(), { orderAmountCents: 1000000, category: 'services', sellerId: uid, hubId: 'provider', subscriptionRole: 'provider' }); } catch (e) { err = e; }
    ck(`C6 a booking on ${plan} is REFUSED by the engine (throws provider_plan_refused) — never priced at the category default`, err && err.code === 'provider_plan_refused' && res === null, err ? { code: err.code, reason: err.reason } : res && { priced: res.effectiveRate });
  }
  PROVIDER_DOCS = { P4: { plan: 'pro', status: 'active' } };
  const r7 = await FU.calculateCommission(makeDb(), { orderAmountCents: 1000000, category: 'services', sellerId: 'P4', hubId: 'provider' });
  ck('C7 WITHOUT subscriptionRole the same booking takes the services category rate (' + CC.resolveRate('services').pct + '%) — the lane is opt-in, as documented', r7.effectiveRate === CC.resolveRate('services').pct && r7.providerPlan === null, r7.effectiveRate);

  {
    const etimsPath = require.resolve(path.join(ROOT, 'functions', 'etims.js'));
    const calls = [];
    require.cache[etimsPath] = { id: etimsPath, filename: etimsPath, loaded: true, exports: { _issuePlatformInvoice: async (a) => { calls.push(a); return { invoiceId: 'inv_' + a.reference }; } } };
    const row = { billingModel: 'PER_SALE_48H', collectionStatus: 'DUE', invoiceId: null, sellerUid: 'P4', totalOwed: r4.commissionCents / 100, totalOutstanding: r4.commissionCents / 100, commissionPct: r4.effectiveRate, grossAmount: r4.orderAmountCents / 100, orderId: 'BK1' };
    let updated = null;
    const ledgerDb = {
      collection(name) { return { doc(id) { return { async get() { return name === 'commissionLedger' ? snap(row, id) : (name === 'revenueConfig' && id === 'commission_vat' ? snap({ enabled: true, applicability: 'taxable', inclusive: true, decidedBy: 'fixture' }, id) : snap(null, id)); } }; } }; },
      async runTransaction(fn) { return fn({ async get() { return snap(row, 'row1'); }, update(_r, patch) { updated = patch; } }); },
    };
    require.cache[gfPath].exports = { ...realGf, getFirestore: () => ledgerDb };
    const CI = require(path.join(ROOT, 'functions', 'commission-invoice'));
    const res = await CI.issueForReceivable('row1', { actor: 'test' });
    require.cache[gfPath].exports = { ...realGf, getFirestore: () => stubDb };
    ck('D1 the receivable built from the engine result invoices for EXACTLY the engine amount (KES 1,000), taxCategory from the policy', res.ok === true && calls.length === 1 && calls[0].amount === r4.commissionCents / 100 && calls[0].feeType === 'commission' && calls[0].taxCategory === 'standard', { res, call: calls[0] });
    ck('D2 the invoice claim is written back (invoiceId + tax category) and the amount was never recomputed', updated && updated.invoiceId === 'inv_row1' && updated.invoiceTaxCategory === 'standard' && !('totalOwed' in updated), updated);
    ck('D3 the description states the plan rate the ledger recorded (10%)', /^10%/.test(calls[0].description), calls[0].description);
  }

  ck('E1 PLANS.provider_basic and PLANS.provider_pro are isActive:false with a retired date (hidden by subGetPlans)', SB.PLANS.provider_basic.isActive === false && SB.PLANS.provider_pro.isActive === false && SB.PLANS.provider_basic.retired === '2026-09-30' && SB.PLANS.provider_pro.retired === '2026-09-30');
  ck('E2 the canonical provider plans stay purchasable', ['provider_free', 'starter', 'pro', 'business'].every((id) => SB.PLANS[id] && SB.PLANS[id].isActive !== false));
  const PI = fs.readFileSync(path.join(ROOT, 'functions', 'payment-intents.js'), 'utf8');
  ck('E3 createPaymentIntent refuses an inactive plan ("no longer available") — so a retired id cannot be bought', /plan\.isActive === false\) throw new HttpsError\('failed-precondition', 'This plan is no longer available\.'\)/.test(PI));
  const plansHtml = fs.readFileSync(path.join(ROOT, 'plans.html'), 'utf8');
  ck('E4 plans.html no longer marks the retired provider_pro as the popular plan', !/service_provider:'provider_pro'/.test(plansHtml) && /service_provider:'pro'/.test(plansHtml));

  {
    global.window = {};
    require(path.join(ROOT, 'sokoni-commission-rates.js'));
    const S = global.window.SokoniCommission;
    ck('F1 snapshot providerPct: every known id, the alias, no plan -> server values; retired / unknown -> null',
       Object.entries(want).every(([k, v]) => S.providerPct(k) === v) && S.providerPct('free_trial') === 20 && S.providerPct(null) === 20
       && S.providerPct('provider_pro') === null && S.providerPct('provider_basic') === null && S.providerPct('nonsense') === null, S.PROVIDER_PLAN_PCT);
  }

  console.log('\nNC. negative control (must FAIL)');
  console.log(`  ${CC.resolveProviderRate('pro').pct === 99 ? 'PASS' : 'FAIL'}  NC deliberately false assertion — expected FAIL`);
  console.log(`\n${pass} passed, ${fail} failed (negative control excluded)`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('  CRASH', e); process.exit(2); });
