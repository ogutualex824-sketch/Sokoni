#!/usr/bin/env node
'use strict';
/* ============================================================================
   COMMERCIAL FACTS — one owner each, and the amounts agree end to end (release gate §9)
   ----------------------------------------------------------------------------
   For a commission-bearing sale on every lane:
       rate authority → engine (calculateCommission) → ledger row → invoice amount
   must be ONE number: the invoice module reads the ledger, the ledger holds the engine's
   result, the engine reads the authority. For subscriptions:
       PLANS price → payment intent amount → (finalized payment) → invoice amount
   The emulator e2e (test-subscription-invoice-e2e.js) proves the finalized-payment half with
   real handlers; this suite proves the pricing half and the commission chain, pure.

   Also asserts the authority set is closed: every rate table lives in commission-config.js
   (verify-commission-single-source), the provider lane has no second mapping, the period
   arithmetic has one copy, and the invoice modules never compute an amount.

   Usage: node scripts/test-commercial-facts-invariants.js
   ============================================================================ */
const fs = require('fs');
const path = require('path');
process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:1';
const ROOT = path.resolve(__dirname, '..');
const NM = path.join(ROOT, 'functions', 'node_modules');
const admin = require(path.join(NM, 'firebase-admin'));
if (!admin.apps.length) admin.initializeApp({ projectId: 'sokoni-facts-test' });

let pass = 0, fail = 0;
const ck = (label, ok, detail) => { if (ok) { pass++; console.log(`  PASS  ${label}`); } else { fail++; console.log(`  FAIL  ${label}${detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''}`); } };
const src = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/* Firestore stubs: subscriptions for the engine, a ledger for the invoice module */
const snap = (data, id) => ({ exists: !!data, data: () => data, id });
let PROVIDER_DOCS = {}, SUB_DOCS = {};
const engineDb = {
  collection(name) {
    return {
      doc(id) { return { async get() {
        if (name === 'providerSubscriptions') return snap(PROVIDER_DOCS[id] || null, id);
        if (name === 'subscriptions') return snap(SUB_DOCS[id] || null, id);
        return snap(null, id);
      } }; },
      where() { return this; }, limit() { return this; },
      async get() { return { docs: [], empty: true, size: 0 }; },
    };
  },
};
const gfPath = require.resolve('firebase-admin/firestore', { paths: [NM] });
const realGf = require(gfPath);
require.cache[gfPath].exports = { ...realGf, getFirestore: () => engineDb };

const CC = require(path.join(ROOT, 'functions', 'commission-config'));
const FU = require(path.join(ROOT, 'functions', 'finos-utils'));
const SB = require(path.join(ROOT, 'functions', 'sub-billing'));

/* the ONE fiscal engine, stubbed at its boundary and counted */
const engineCalls = [];
const etimsPath = require.resolve(path.join(ROOT, 'functions', 'etims.js'));
require.cache[etimsPath] = { id: etimsPath, filename: etimsPath, loaded: true, exports: { _issuePlatformInvoice: async (a) => { engineCalls.push(a); return { invoiceId: 'inv_' + a.reference }; } } };

async function invoiceFor(ledgerRow) {
  let updated = null;
  const ledgerDb = {
    collection(name) { return { doc(id) { return { async get() {
      if (name === 'commissionLedger') return snap(ledgerRow, id);
      if (name === 'revenueConfig' && id === 'commission_vat') return snap({ enabled: true, inclusive: true, decidedBy: 'fixture' }, id);
      return snap(null, id);
    } }; } }; },
    async runTransaction(fn) { return fn({ async get() { return snap(ledgerRow, 'row'); }, update(_r, patch) { updated = patch; } }); },
  };
  require.cache[gfPath].exports = { ...realGf, getFirestore: () => ledgerDb };
  const ciPath = require.resolve(path.join(ROOT, 'functions', 'commission-invoice.js'));
  delete require.cache[ciPath];
  const CI = require(ciPath);
  const res = await CI.issueForReceivable('row', { actor: 'facts' });
  require.cache[gfPath].exports = { ...realGf, getFirestore: () => engineDb };
  return { res, updated, call: engineCalls[engineCalls.length - 1] };
}

(async () => {
  console.log('Commercial facts — one owner each, amounts agree end to end\n');

  /* ── 1. commission chain on every lane ─────────────────────────────────────────────── */
  console.log('1. rate authority → engine → ledger → invoice, per lane');
  const lanes = [
    { label: 'online product (marketplace, seller_pro plan)', opts: { category: 'product', sellerId: 'S1' }, setup: () => { SUB_DOCS = { S1: { uid: 'S1', planId: 'seller_pro', tier: 'seller_pro', status: 'active' } }; }, wantPct: CC.resolveMarketplaceRate('seller_pro').pct },
    { label: 'POS / Till (absolute lane)', opts: { category: 'pos', sellerId: 'S1', hubId: 'pos' }, setup: () => {}, wantPct: CC.RATES.pos.pct },
    { label: 'provider booking on Professional (pro)', opts: { category: 'services', sellerId: 'P1', hubId: 'provider', subscriptionRole: 'provider' }, setup: () => { PROVIDER_DOCS = { P1: { plan: 'pro', status: 'active' } }; }, wantPct: CC.resolveProviderRate('pro').pct },
    { label: 'healthcare booking (category rate)', opts: { category: 'healthcare', sellerId: 'H1' }, setup: () => {}, wantPct: CC.resolveRate('healthcare').pct },
    { label: 'car rental (category rate)', opts: { category: 'car_rental', sellerId: 'C1' }, setup: () => {}, wantPct: CC.resolveRate('car_rental').pct },
  ];
  for (const lane of lanes) {
    lane.setup();
    const r = await FU.calculateCommission(engineDb, { orderAmountCents: 1000000, ...lane.opts });
    ck(`1a ${lane.label}: engine rate == authority rate (${lane.wantPct}%)`, r.effectiveRate === lane.wantPct && r.commissionCents === Math.round(1000000 * lane.wantPct / 100), { rate: r.effectiveRate, cents: r.commissionCents, src: r.pricingSource });
    const row = { billingModel: 'PER_SALE_48H', collectionStatus: 'DUE', invoiceId: null, sellerUid: lane.opts.sellerId, totalOwed: r.commissionCents / 100, totalOutstanding: r.commissionCents / 100, commissionPct: r.effectiveRate, grossAmount: r.orderAmountCents / 100, orderId: 'O_' + lane.opts.category };
    const { res, updated, call } = await invoiceFor(row);
    ck(`1b ${lane.label}: invoice amount == ledger amount == engine amount (KES ${r.commissionCents / 100})`, res.ok === true && call.amount === r.commissionCents / 100 && call.feeType === 'commission' && updated && updated.invoiceId && !('totalOwed' in updated), { res: res.reason, invoiced: call && call.amount });
  }
  /* flat-fee lanes: the fee, not a percentage, is what the ledger must carry */
  for (const [cat, fee] of [['vehicles', 2000], ['property', 5000]]) {
    const r = await FU.calculateCommission(engineDb, { orderAmountCents: 100000000, category: cat, sellerId: 'V1' });
    ck(`1c ${cat}: KES 1,000,000 sale -> flat KES ${fee}, invoice would carry exactly that`, r.commissionCents === fee * 100 && r.effectiveRate === 0, { cents: r.commissionCents, rate: r.effectiveRate });
  }

  /* ── 2. subscription pricing: PLANS → intent amount (the finalized-payment half is the e2e) ── */
  console.log('\n2. PLANS price → payment intent amount (server-derived; the e2e proves payment → invoice)');
  const PI = strip(src('functions/payment-intents.js'));
  ck('2a createPaymentIntent prices subscriptions from sub-billing PLANS, not from the request', /require\('\.\/sub-billing'\)/.test(PI) && /PLANS\[planId\]/.test(PI) && !/request\.data\.amount|data\.amount\b/.test(PI));
  const p = SB.PLANS.seller_basic;
  ck('2b PLANS.seller_basic monthly price is in cents and non-zero (99900)', p && p.price && p.price.monthly === 99900, p && p.price);
  ck('2c subscription revenue is 100% platform revenue in the commission authority', CC.resolveRate('subscription').pct === 100 && CC.resolveRate('subscriptions').pct === 100 && CC.resolveRate('healthcare_subscription').pct === 100);

  /* ── 3. the authority set is closed ────────────────────────────────────────────────── */
  console.log('\n3. one owner each');
  const FUsrc = strip(src('functions/finos-utils.js'));
  const SCsrc = strip(src('functions/subscription-core.js'));
  const POsrc = strip(src('functions/provider-ops.js'));
  ck('3a provider rate: subscription-core delegates to commission-config.resolveProviderRate; no local provider table', /resolveProviderRate/.test(SCsrc) && !/provider:\s*0\.\d+.*\n[\s\S]{0,40}getCommissionRate/.test(SCsrc));
  ck('3b provider-ops and finos-utils obtain the provider rate ONLY through subscription-core', /subCore\.getCommissionRate\(uid, \{ role: 'provider' \}\)/.test(POsrc) && /getProviderPlanRate|getCommissionRate/.test(FUsrc) && !/PROVIDER_PLAN_RATES\s*=/.test(FUsrc) && !/PROVIDER_PLAN_RATES\s*=/.test(POsrc));
  ck('3c no executable 20/15/10/7/5 table exists outside commission-config.js', ['functions/finos-utils.js', 'functions/provider-ops.js', 'functions/provider-hub.js', 'functions/subscription-core.js', 'functions/sub-billing.js', 'functions/subscription-catalog.js'].every((f) => !/\b20\b[^\n]{0,20}\b15\b[^\n]{0,20}\b10\b[^\n]{0,20}\b7\b[^\n]{0,20}\b5\b/.test(strip(src(f)))));
  const periodOwners = ['functions/index.js', 'functions/sub-billing.js', 'functions/sub-engine.js', 'functions/entitlement-adapters.js', 'functions/payment-reconciliation.js', 'functions/subscription-pay-methods.js'];
  ck('3d period arithmetic: all six subscription writers call subscription-period.js; none does setMonth/PERIOD_DAYS itself',
     periodOwners.every((f) => /subscription-period/.test(src(f))) && periodOwners.every((f) => !/PERIOD_DAYS\s*=\s*\{/.test(strip(src(f)))) && periodOwners.filter((f) => /setMonth\(/.test(strip(src(f)))).length === 0,
     periodOwners.filter((f) => /setMonth\(/.test(strip(src(f))) || /PERIOD_DAYS\s*=\s*\{/.test(strip(src(f)))));
  const CIsrc = strip(src('functions/commission-invoice.js')), SIsrc = strip(src('functions/subscription-invoice.js'));
  ck('3e neither invoice module computes an amount (no * rate, no pct / 100)', !/\*\s*(rate|pct|commissionPct)|\/\s*100\s*\*/.test(CIsrc) && !/\*\s*(rate|pct)|\/\s*100\s*\*/.test(SIsrc));
  ck('3f both invoice modules issue through the ONE engine (etims._issuePlatformInvoice) and nothing else', (CIsrc.match(/_issuePlatformInvoice\(/g) || []).length === 1 && (SIsrc.match(/_issuePlatformInvoice\(/g) || []).length === 1 && !/etimsInvoices/.test(SIsrc + CIsrc.replace(/etimsInvoices\/\{invoiceId\}/g, '')));
  const IDX = strip(src('functions/index.js'));
  ck('3g subscription activation: index.js webhooks and activateSubscription hold no subscriptions/{uid} writer (reconcilePaidIntent is the one transition)', !/subData\.paymentRef !== apiRef/.test(IDX) && !/txn\.set\(subDocRef/.test(IDX) && (IDX.match(/reconcilePaidIntent\(/g) || []).length >= 1);

  console.log('\nNC. negative control (must FAIL)');
  console.log(`  ${CC.RATES.pos.pct === 99 ? 'PASS' : 'FAIL'}  NC deliberately false assertion — expected FAIL`);
  console.log(`\n${pass} passed, ${fail} failed (negative control excluded)`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('  CRASH', e); process.exit(2); });
