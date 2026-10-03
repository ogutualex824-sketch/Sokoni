#!/usr/bin/env node
'use strict';
/* ============================================================================
   Foundation reconciliation — "recorded" vs "verified paid" (2026-10-01). Real handlers on the fake.
     A  a recorded-but-unverified balance pays NOTHING out (verifiedBalance missing = 0 = blocked)
     B  classify: completed-without-provider-evidence → REQUIRES_RECONCILIATION; status/amount untouched;
        webhook-verified records stay verified; snapshot written
     C  propose/confirm by two DIFFERENT admins: verify credits verifiedBalance once; close posts an
        append-only adjustment debit and unwinds stats/programme; nothing deleted
     D  public dashboard: available = verified − reserved; unverified shown only as requiresReconciliation
     E  a completed payout decrements verifiedBalance (cannot be spent twice)
   node scripts/test-foundation-reconciliation.js
   ============================================================================ */
const path = require('path'), Module = require('module');
const ROOT = path.resolve(__dirname, '..');
const FN = path.join(ROOT, 'functions');
const { makeFakeFirestore } = require('./lib/fake-firestore-txn');
let pass = 0, fail = 0;
const ck = (l, ok, d) => { if (ok) { pass++; console.log('  PASS  ' + l); } else { fail++; console.log('  FAIL  ' + l + (d !== undefined ? '  -> ' + JSON.stringify(d).slice(0, 400) : '')); } };
process.env.INTASEND_PRIVATE_KEY = 'test-only-not-a-secret';
const F = makeFakeFirestore();
const ff = () => F.db; ff.FieldValue = F.FieldValue; ff.Timestamp = F.Timestamp;
const fa = Module._resolveFilename('firebase-admin', { id: path.join(FN, 'x.js'), filename: path.join(FN, 'x.js'), paths: Module._nodeModulePaths(FN) });
require.cache[fa] = { id: fa, filename: fa, loaded: true, exports: { apps: [1], initializeApp() {}, firestore: ff } };
const fu = require.resolve(path.join(FN, 'finos-utils.js'));
require.cache[fu] = { id: fu, filename: fu, loaded: true, exports: { intasendB2C: async () => ({ tracking_id: 'TRK1' }) } };
/* IntaSend stubs: send-money status (payouts) and collection status (shared intasend-status helper) */
const COLLECTIONS = { INVQ88: { invoice_id: 'INVQ88', state: 'COMPLETE', value: 3000, currency: 'KES' }, INVLOW: { invoice_id: 'INVLOW', state: 'COMPLETE', value: 300, currency: 'KES' }, INVPEND: { invoice_id: 'INVPEND', state: 'PENDING', value: 3000, currency: 'KES' }, INVUSD: { invoice_id: 'INVUSD', state: 'COMPLETE', value: 3000, currency: 'USD' } };
let COLLECTION_DOWN = false;
global.fetch = async (url) => {
  if (/payment\/collection\//.test(url)) {
    if (COLLECTION_DOWN) return { ok: false, status: 503, json: async () => ({}) };
    const ref = decodeURIComponent(String(url).split('invoice_id=')[1] || '');
    return { ok: true, status: 200, json: async () => ({ results: COLLECTIONS[ref] ? [COLLECTIONS[ref]] : [] }) };
  }
  return { ok: true, json: async () => ({ transactions: [{ status: 'Completed', transaction_id: 'X1' }] }) };
};
const M = require(path.join(FN, 'impact.js'));
const run = async (fn, uid, data, token = {}) => { try { return { ok: true, v: await M[fn].run({ auth: uid ? { uid, token } : null, data }) }; } catch (e) { return { ok: false, code: e.code, msg: e.message }; } };
const ADM = { admin: true }, SUP = { superAdmin: true };
const bal = async () => (await F.db.collection('impactBalance').doc('current').get()).data() || {};
const don = async (id) => (await F.db.collection('foundationDonations').doc(id).get()).data();
const ledger = () => [...F.db._store.keys()].filter((k) => k.startsWith('impactLedger/')).map((k) => F.db._store.get(k).data);
const rid = (n) => 'b1c2d3e4-0000-4000-8000-' + String(n).padStart(12, '0');

(async () => {
  console.log('Foundation reconciliation — recorded vs verified paid\n');
  /* legacy contamination: two pre-fix mints (completed, no provider evidence) + one verified webhook donation */
  await F.db.collection('foundationDonations').doc('CHK_o1').set({ uid: 'b1', status: 'completed', amount: 5000, orderId: 'o1', programmeId: 'edu1', method: 'Checkout Add-On' });
  await F.db.collection('foundationDonations').doc('CHK_o2').set({ uid: 'b2', status: 'completed', amount: 3000, orderId: 'o2', method: 'Checkout Add-On' });
  await F.db.collection('foundationDonations').doc('PLG_d1_x').set({ uid: 'd1', status: 'completed', amount: 1000, grossKES: 1000, feeKES: 30, providerReference: 'INV1', receiptId: 'SKF-INV1' });
  await F.db.collection('foundationDonations').doc('PLG_d2_y').set({ uid: 'd2', status: 'pledged', amount: 700 });
  await F.db.collection('impactBalance').doc('current').set({ balance: 8970, totalReceived: 9000 });   /* NO verifiedBalance yet */
  await F.db.collection('foundationStats').doc('current').set({ totalDonations: 9000 });
  await F.db.collection('impactCampaigns').doc('edu1').set({ raised: 5000, status: 'active' });

  /* A */
  const a1 = await run('impactInitiateDisbursement', 'adm1', { requestId: rid(1), amount: 500, beneficiaryName: 'x', description: 'y', destinationType: 'MPESA', destination: { phone: '0712345678' } }, ADM);
  ck('A1 recorded balance 8,970 but NO verified money → payout refused (fail closed)', !a1.ok && a1.code === 'failed-precondition' && /VERIFIED/.test(a1.msg), a1);

  /* B */
  const b0 = await run('impactReconcileFoundation', 'user', { action: 'classify' });
  const b1 = await run('impactReconcileFoundation', 'adm1', { action: 'classify' }, ADM);
  const c1d = await don('CHK_o1');
  ck('B1 non-admin refused; classify: 3 recorded, 1 verified, 2 unverified held, 1 pledged', b0.code === 'permission-denied' && b1.ok && b1.v.counts.recorded === 3 && b1.v.counts.verifiedPaid === 1 && b1.v.counts.unverified === 2 && b1.v.counts.held === 2 && b1.v.counts.pledged === 1 && b1.v.amounts.unverified === 8000, b1);
  ck('B2 unverified records marked REQUIRES_RECONCILIATION with status and amount untouched; verified one unmarked',
    c1d.reconciliation.state === 'REQUIRES_RECONCILIATION' && c1d.status === 'completed' && c1d.amount === 5000 && !(await don('PLG_d1_x')).reconciliation, c1d);
  ck('B3 snapshot written', !!(await F.db.collection('foundationReconciliation').doc('current').get()).data());

  /* C */
  const c0 = await run('impactReconcileFoundation', 'adm1', { action: 'propose_verify', donationId: 'CHK_o2' }, ADM);
  const p1 = await run('impactReconcileFoundation', 'adm1', { action: 'propose_verify', donationId: 'CHK_o2', providerReference: 'NOSUCH1' }, ADM);
  const p2 = await run('impactReconcileFoundation', 'adm1', { action: 'propose_verify', donationId: 'CHK_o2', providerReference: 'INVLOW' }, ADM);
  const p3 = await run('impactReconcileFoundation', 'adm1', { action: 'propose_verify', donationId: 'CHK_o2', providerReference: 'INVPEND' }, ADM);
  const p4 = await run('impactReconcileFoundation', 'adm1', { action: 'propose_verify', donationId: 'CHK_o2', providerReference: 'INVUSD' }, ADM);
  ck('P0 WRONG_CURRENCY: IntaSend shows USD 3000 for the reference → refused', !p4.ok && /USD 3000/.test(p4.msg), p4);
  ck('P1 IntaSend is asked: unknown reference / different amount / not COMPLETE → proposal refused', !p1.ok && /no payment/.test(p1.msg) && !p2.ok && /KES 300/.test(p2.msg) && !p3.ok && /PENDING/.test(p3.msg), { p1, p2, p3 });
  const c1 = await run('impactReconcileFoundation', 'adm1', { action: 'propose_verify', donationId: 'CHK_o2', providerReference: 'INVQ88' }, ADM);
  const c2 = await run('impactReconcileFoundation', 'adm1', { action: 'confirm', donationId: 'CHK_o2' }, ADM);
  const c3 = await run('impactReconcileFoundation', 'adm2', { action: 'confirm', donationId: 'CHK_o2' }, ADM);
  const c4 = await run('impactReconcileFoundation', 'adm2', { action: 'confirm', donationId: 'CHK_o2' }, ADM);
  ck('C1 verify needs a provider reference; IntaSend confirms it; proposer cannot confirm; second admin confirms → verifiedBalance 3,000, evidence provider_confirmed; replay refused',
    !c0.ok && c1.ok && c1.v.providerCheck === 'provider_confirmed' && (await don('CHK_o2')).reconciliation.evidence === 'provider_confirmed' && !c2.ok && c2.code === 'permission-denied' && c3.ok && c3.v.state === 'VERIFIED_PAID' && (await bal()).verifiedBalance === 3000 && !c4.ok, { c0, c2, c3, c4, b: await bal() });
  const c5 = await run('impactReconcileFoundation', 'adm2', { action: 'propose_close', donationId: 'CHK_o1', note: 'Order o1 was paid without the add-on; no donation money received' }, ADM);
  const c6 = await run('impactReconcileFoundation', 'adm1', { action: 'confirm', donationId: 'CHK_o1' }, ADM);
  const adj = ledger().filter((e) => e.type === 'adjustment');
  const after = await don('CHK_o1');
  ck('C2 close (two admins): one append-only adjustment debit 5,000; recorded balance 3,970; stats and programme raised unwound; record kept as CLOSED_NO_PAYMENT',
    c5.ok && c6.ok && adj.length === 1 && adj[0].debit === 5000 && adj[0].meta.reversalOf === 'CHK_o1' && (await bal()).balance === 3970
    && (await F.db.collection('foundationStats').doc('current').get()).data().totalDonations === 4000 && (await F.db.collection('impactCampaigns').doc('edu1').get()).data().raised === 0
    && after.status === 'completed' && after.amount === 5000 && after.reconciliation.state === 'CLOSED_NO_PAYMENT', { c5, c6, adj, after, b: await bal() });
  const c7 = await run('impactReconcileFoundation', 'adm1', { action: 'propose_close', donationId: 'PLG_d1_x', note: 'x' }, ADM);
  ck('C3 a webhook-verified donation cannot be put through reconciliation', !c7.ok && c7.code === 'failed-precondition');

  await F.db.collection('foundationDonations').doc('CHK_o9').set({ uid: 'b9', status: 'completed', amount: 400, orderId: 'o9', reconciliation: { state: 'REQUIRES_RECONCILIATION' } });
  COLLECTION_DOWN = true;
  const u1 = await run('impactReconcileFoundation', 'adm1', { action: 'propose_verify', donationId: 'CHK_o9', providerReference: 'INVDOWN1' }, ADM);
  COLLECTION_DOWN = false;
  const u2 = await run('impactReconcileFoundation', 'adm2', { action: 'confirm', donationId: 'CHK_o9' }, ADM);
  const u3 = await run('impactReconcileFoundation', 'adm2', { action: 'confirm', donationId: 'CHK_o9', acknowledgeUnchecked: true }, ADM);
  ck('P2 IntaSend unreachable → proposal flagged unchecked; confirm refused without explicit acknowledgement; with it → VERIFIED_PAID (evidence unchecked)',
    u1.ok && u1.v.providerCheck === 'unchecked' && !u2.ok && u2.code === 'failed-precondition' && u3.ok && (await don('CHK_o9')).reconciliation.evidence === 'unchecked', { u1, u2, u3 });

  /* D */
  await F.db.collection('impactBalance').doc('current').set({ verifiedBalance: 3000 + 970, reservedKES: 0 }, { merge: true });   /* + the webhook-verified net */
  await F.db.collection('impactBalance').doc('current').set({ balance: 9970 }, { merge: true });   /* simulate a later unverified mint */
  const d1 = await run('impactGetPublicDashboard', null, {});
  ck('D1 public: available = verified (3,970); the 6,000 recorded without proof is only "requires reconciliation"', d1.ok && d1.v.balance.available === 3970 && d1.v.balance.verified === 3970 && d1.v.balance.requiresReconciliation === 6000, d1.v && d1.v.balance);
  const d2 = await run('impactAdminFoundationData', 'adm1', { view: 'summary' }, ADM);
  ck('D2 admin summary separates recorded / verified / available / requires reconciliation and carries the snapshot', d2.ok && d2.v.balance.recorded === 9970 && d2.v.balance.verified === 3970 && d2.v.balance.available === 3970 && d2.v.balance.requiresReconciliation === 6000 && d2.v.reconciliation && d2.v.reconciliation.counts.recorded === 3, d2.v);
  const d3 = await run('impactAdminFoundationData', 'adm1', { view: 'donations', status: 'requires_reconciliation' }, ADM);
  ck('D3 admin filter "requires reconciliation" lists only held records (none left after both were reconciled)', d3.ok && d3.v.rows.length === 0, d3.v);

  /* E */
  await run('impactInitiateDisbursement', 'adm1', { requestId: rid(2), amount: 3000, beneficiaryName: 'x', description: 'y', destinationType: 'MPESA', destination: { phone: '0712345678' } }, ADM);
  await run('impactApproveDisbursement', 'adm2', { disbursementId: 'DSB_' + rid(2) }, ADM);
  await run('impactAuthorizeDisbursement', 'sup1', { disbursementId: 'DSB_' + rid(2) }, SUP);
  const e0 = await run('impactInitiateDisbursement', 'adm1', { requestId: rid(3), amount: 1000, beneficiaryName: 'x', description: 'y', destinationType: 'MPESA', destination: { phone: '0712345678' } }, ADM);
  await run('impactRefreshDisbursementStatus', 'adm2', { disbursementId: 'DSB_' + rid(2) }, ADM);
  const b = await bal();
  ck('E1 while 3,000 is reserved, only 970 verified is available (1,000 refused); on completion verifiedBalance drops to 970', !e0.ok && /VERIFIED/.test(e0.msg) && b.verifiedBalance === 970 && b.reservedKES === 0, { e0, b });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('  CRASH', e); process.exit(2); });
