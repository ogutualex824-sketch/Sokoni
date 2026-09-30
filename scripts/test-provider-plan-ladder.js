#!/usr/bin/env node
'use strict';
/* ============================================================================
   PROVIDER BOOKING LADDER — plan id → canonical rate → engine → ledger row → invoice, one chain
   ----------------------------------------------------------------------------
   Owner schedule 2026-09-28: provider bookings are priced by the provider's PLAN at
   20 / 15 / 10 / 7 / 5 (Free Trial / Starter / Professional / Business / Enterprise),
   keyed by PLAN ID in commission-config.PROVIDER_PLAN_RATES. This suite proves:

     A  the authority: every id resolves to its rate; unknown / legacy → highest (20%), flagged
     B  subscription-core delegates to it (no document commissionRate, no role default)
     C  finos-utils.calculateCommission (what previewCommission and the webhook use) charges
        exactly that rate on a provider booking, records the plan, applies no KES 10 floor
     D  a commissionLedger row built from that result invoices for EXACTLY the same amount
        through commission-invoice.issueForReceivable (amount read from the row, never recomputed)
     E  the client snapshot exposes the same table (providerPct)
     NC negative control: the harness can fail

   Pure: stub Firestore, engine stubbed at its boundary. Usage: node scripts/test-provider-plan-ladder.js
   ============================================================================ */
const path = require('path');
process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:1';
const ROOT = path.resolve(__dirname, '..');
const admin = require(path.join(ROOT, 'functions', 'node_modules', 'firebase-admin'));
if (!admin.apps.length) admin.initializeApp({ projectId: 'sokoni-provider-ladder-test' });
const CC = require(path.join(ROOT, 'functions', 'commission-config'));

let pass = 0, fail = 0;
const ck = (label, ok, detail) => { if (ok) { pass++; console.log(`  PASS  ${label}`); } else { fail++; console.log(`  FAIL  ${label}${detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''}`); } };

/* ── stub Firestore: providerSubscriptions/{uid} holds the plan; nothing else exists ─────── */
let PROVIDER_DOCS = {};
const snap = (data, id) => ({ exists: !!data, data: () => data, id });
function makeDb() {
  return {
    collection(name) {
      return {
        doc(id) {
          return {
            async get() {
              if (name === 'providerSubscriptions') return snap(PROVIDER_DOCS[id] || null, id);
              return snap(null, id);
            },
          };
        },
        where() { return this; }, limit() { return this; },
        async get() { return { docs: [], empty: true, size: 0 }; },
      };
    },
  };
}
/* subscription-core reads through firebase-admin/firestore getFirestore(); point it at the stub
   BEFORE the module loads (it captures the function at require time). */
const stubDb = makeDb();
const gfPath = require.resolve('firebase-admin/firestore', { paths: [path.join(ROOT, 'functions', 'node_modules')] });
const realGf = require(gfPath);
require.cache[gfPath].exports = { ...realGf, getFirestore: () => stubDb };

const core = require(path.join(ROOT, 'functions', 'subscription-core'));
const FU   = require(path.join(ROOT, 'functions', 'finos-utils'));

(async () => {
  console.log('Provider booking ladder — plan id → rate → engine → ledger → invoice\n');

  /* A — the authority */
  const want = { provider_free: 20, starter: 15, pro: 10, business: 7, enterprise: 5 };
  ck('A1 PROVIDER_PLAN_RATES is exactly the owner schedule, keyed by plan id',
     JSON.stringify(Object.fromEntries(Object.entries(CC.PROVIDER_PLAN_RATES).map(([k, v]) => [k, v.pct]))) === JSON.stringify(want), CC.PROVIDER_PLAN_RATES);
  for (const [id, pct] of Object.entries(want)) {
    const r = CC.resolveProviderRate(id);
    ck(`A2 ${id.padEnd(14)} -> ${pct}% (matched, source = the authority)`, r.pct === pct && r.matched === true && r.rateFraction === pct / 100 && /PROVIDER_PLAN_RATES$/.test(r.source), r);
  }
  const unk = CC.resolveProviderRate('nonsense');
  ck('A3 unknown plan -> HIGHEST rate (20%), matched=false, source says so', unk.pct === 20 && unk.matched === false && /unknown plan/.test(unk.source), unk);
  ck('A4 absent plan (null) -> 20%', CC.resolveProviderRate(null).pct === 20);
  for (const legacy of ['provider_basic', 'provider_pro']) {
    const r = CC.resolveProviderRate(legacy);
    ck(`A5 legacy ${legacy} -> 20% fail-closed AND flagged legacyUnmapped (owner mapping required)`, r.pct === 20 && r.matched === false && r.legacyUnmapped === true, r);
  }
  ck('A6 case / whitespace tolerant on the id', CC.resolveProviderRate('  Pro ').pct === 10);
  ck('A7 the 16/12/8/4 and 15/10/5/0 ladders are NOT what this table returns', !Object.values(CC.PROVIDER_PLAN_RATES).some((v) => [16, 12, 8, 4].includes(v.pct)) && CC.resolveProviderRate('starter').pct !== 10);

  /* B — subscription-core delegates */
  PROVIDER_DOCS = { P1: { plan: 'business', status: 'active', commissionRate: 0.01 } };
  ck('B1 an ACTIVE provider on business pays 7% — the document commissionRate (1%) is IGNORED', (await core.getCommissionRate('P1', { role: 'provider' })) === 0.07);
  const pr = await core.getProviderPlanRate('P1');
  ck('B2 getProviderPlanRate carries provenance: plan business, matched, active', pr.plan === 'business' && pr.matched === true && pr.active === true, pr);
  PROVIDER_DOCS = { P2: { plan: 'business', status: 'expired', expiryDate: Date.now() - 86400000 } };   /* status is recomputed from dates — a stale word alone cannot expire a plan */
  ck('B3 an EXPIRED business plan is charged as Free (20%) — an inactive plan buys nothing', (await core.getCommissionRate('P2', { role: 'provider' })) === 0.20);
  PROVIDER_DOCS = {};
  ck('B4 no subscription document at all -> 20%, not a role default of some other number', (await core.getCommissionRate('P3', { role: 'provider' })) === 0.20);

  /* C — the engine */
  PROVIDER_DOCS = { P4: { plan: 'pro', status: 'active' } };
  const r4 = await FU.calculateCommission(makeDb(), { orderAmountCents: 1000000, category: 'services', sellerId: 'P4', hubId: 'provider', subscriptionRole: 'provider' });
  ck('C1 KES 10,000 booking on Professional (pro) -> commission KES 1,000 (10%)', r4.commissionCents === 100000 && r4.effectiveRate === 10, { c: r4.commissionCents, rate: r4.effectiveRate });
  ck('C2 the result names the plan and the authority', r4.providerPlan === 'pro' && r4.providerPlanMatched === true && /PROVIDER_PLAN_RATES/.test(r4.providerRateSource || ''), { plan: r4.providerPlan, src: r4.providerRateSource });
  ck('C3 pricingSource = subscription_plan_rate (compatibility mode)', /subscription_plan_rate/.test(r4.pricingSource), r4.pricingSource);
  PROVIDER_DOCS = { P5: { plan: 'enterprise', status: 'active' } };
  const r5 = await FU.calculateCommission(makeDb(), { orderAmountCents: 2000, category: 'services', sellerId: 'P5', hubId: 'provider', subscriptionRole: 'provider' });
  ck('C4 KES 20 booking on Enterprise -> KES 1 (5%), NO KES 10 floor on the provider lane', r5.commissionCents === 100, r5.commissionCents);
  PROVIDER_DOCS = { P6: { plan: 'provider_basic', status: 'active' } };
  const r6 = await FU.calculateCommission(makeDb(), { orderAmountCents: 1000000, category: 'services', sellerId: 'P6', hubId: 'provider', subscriptionRole: 'provider' });
  ck('C5 legacy provider_basic booking -> 20% and flagged legacyUnmapped on the result', r6.commissionCents === 200000 && r6.providerPlanLegacyUnmapped === true, { c: r6.commissionCents, flag: r6.providerPlanLegacyUnmapped });
  const r7 = await FU.calculateCommission(makeDb(), { orderAmountCents: 1000000, category: 'services', sellerId: 'P4', hubId: 'provider' });
  ck('C6 WITHOUT subscriptionRole the same booking takes the services category rate (' + CC.resolveRate('services').pct + '%) — the lane is opt-in, as documented', r7.effectiveRate === CC.resolveRate('services').pct && r7.providerPlan === null, r7.effectiveRate);

  /* D — ledger row → invoice, amount equality through the ONE engine (stubbed at its boundary) */
  {
    const etimsPath = require.resolve(path.join(ROOT, 'functions', 'etims.js'));
    const calls = [];
    require.cache[etimsPath] = { id: etimsPath, filename: etimsPath, loaded: true, exports: { _issuePlatformInvoice: async (a) => { calls.push(a); return { invoiceId: 'inv_' + a.reference }; } } };
    const row = { billingModel: 'PER_SALE_48H', collectionStatus: 'DUE', invoiceId: null, sellerUid: 'P4', totalOwed: r4.commissionCents / 100, totalOutstanding: r4.commissionCents / 100, commissionPct: r4.effectiveRate, grossAmount: r4.orderAmountCents / 100, orderId: 'BK1' };
    let updated = null;
    const ledgerDb = {
      collection(name) { return { doc(id) { return { async get() { return name === 'commissionLedger' ? snap(row, id) : (name === 'revenueConfig' && id === 'commission_vat' ? snap({ enabled: true, inclusive: true, decidedBy: 'fixture' }, id) : snap(null, id)); } }; } }; },
      async runTransaction(fn) { return fn({ async get(ref) { return snap(row, 'row1'); }, update(ref, patch) { updated = patch; } }); },
    };
    require.cache[gfPath].exports = { ...realGf, getFirestore: () => ledgerDb };
    const CI = require(path.join(ROOT, 'functions', 'commission-invoice'));
    const res = await CI.issueForReceivable('row1', { actor: 'test' });
    require.cache[gfPath].exports = realGf;
    ck('D1 the receivable built from the engine result invoices for EXACTLY the engine amount (KES 1,000)', res.ok === true && calls.length === 1 && calls[0].amount === r4.commissionCents / 100 && calls[0].feeType === 'commission', { res, call: calls[0] });
    ck('D2 the invoice claim is written back (invoiceId) and the amount was never recomputed by the invoice module', updated && updated.invoiceId === 'inv_row1' && !('totalOwed' in updated), updated);
    ck('D3 the description states the plan rate the ledger recorded (10%)', /^10%/.test(calls[0].description), calls[0].description);
  }

  /* E — the client snapshot exposes the same table */
  {
    global.window = {};
    require(path.join(ROOT, 'sokoni-commission-rates.js'));
    const S = global.window.SokoniCommission;
    ck('E1 snapshot providerPct matches the authority for every plan id + unknown', typeof S.providerPct === 'function' && Object.entries(want).every(([k, v]) => S.providerPct(k) === v) && S.providerPct('nonsense') === 20, S.PROVIDER_PLAN_PCT);
  }

  console.log('\nNC. negative control (must FAIL)');
  console.log(`  ${CC.resolveProviderRate('pro').pct === 99 ? 'PASS' : 'FAIL'}  NC deliberately false assertion — expected FAIL`);
  console.log(`\n${pass} passed, ${fail} failed (negative control excluded)`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('  CRASH', e); process.exit(2); });
