#!/usr/bin/env node
'use strict';
/* ============================================================================
   Foundation disbursements (impact.js 12–14e, rebuilt 2026-10-01) — real handlers on the Firestore fake;
   IntaSend B2C helper and the send-money status endpoint stubbed at the module / fetch boundary.
     A  initiate: validated destination (MPESA/BANK/TILL/PAYBILL), available = balance − reserved,
        grant headroom, idempotent on requestId
     B  three different people: initiator ≠ approver ≠ authorizer(superAdmin)
     C  authorize CLAIMS (processing + reservation) before paying; a second call cannot pay twice
     D  M-PESA: gateway accept ≠ completed; ledger debited ONLY on IntaSend "Completed"; gateway refusal
        releases funds; status "Failed" releases funds
     E  manual rails: record (reference) → a DIFFERENT admin confirms → debit; fail releases
     F  cancel before authorization; admin views mask destinations
     G  counterproof: the original authorize marks completed and debits on the initiate response
   node scripts/test-foundation-disbursements.js
   ============================================================================ */
const path = require('path'), fs = require('fs'), Module = require('module');
const ROOT = path.resolve(__dirname, '..');
const FN = path.join(ROOT, 'functions');
const { makeFakeFirestore } = require('./lib/fake-firestore-txn');
let pass = 0, fail = 0;
const ck = (l, ok, d) => { if (ok) { pass++; console.log('  PASS  ' + l); } else { fail++; console.log('  FAIL  ' + l + (d !== undefined ? '  -> ' + JSON.stringify(d).slice(0, 400) : '')); } };
process.env.INTASEND_PRIVATE_KEY = 'test-only-not-a-secret';

const B2C = { calls: [], mode: 'accept' };
let STATUS = { status: 'Processing' };
global.fetch = async (url, opts) => {
  if (/send-money\/status/.test(url)) return { ok: true, json: async () => ({ transactions: [STATUS] }) };
  throw new Error('unexpected fetch ' + url);
};
function setup() {
  const F = makeFakeFirestore();
  const ff = () => F.db; ff.FieldValue = F.FieldValue; ff.Timestamp = F.Timestamp;
  const fa = Module._resolveFilename('firebase-admin', { id: path.join(FN, 'x.js'), filename: path.join(FN, 'x.js'), paths: Module._nodeModulePaths(FN) });
  require.cache[fa] = { id: fa, filename: fa, loaded: true, exports: { apps: [1], initializeApp() {}, firestore: ff } };
  const fu = require.resolve(path.join(FN, 'finos-utils.js'));
  require.cache[fu] = { id: fu, filename: fu, loaded: true, exports: { intasendB2C: async (key, args) => {
    B2C.calls.push(args);
    if (B2C.mode === 'refuse') { const e = new Error('IntaSend B2C failed (400)'); e.gateway = { code: 'INSUFFICIENT_FLOAT' }; throw e; }
    return { tracking_id: 'TRK' + B2C.calls.length };
  } } };
  return F;
}
function load(file) { const f = require.resolve(file); delete require.cache[f]; return require(f); }
const run = async (M, fn, uid, data, token = {}) => { try { return { ok: true, v: await M[fn].run({ auth: uid ? { uid, token } : null, data }) }; } catch (e) { return { ok: false, code: e.code, msg: e.message }; } };
const ADM = { admin: true }, SUP = { superAdmin: true };
const rid = (n) => 'a1b2c3d4-0000-4000-8000-' + String(n).padStart(12, '0');
const bal = async (F) => (await F.db.collection('impactBalance').doc('current').get()).data() || {};
const dsb = async (F, id) => (await F.db.collection('impactDisbursements').doc(id).get()).data();
const ledger = (F) => [...F.db._store.keys()].filter((k) => k.startsWith('impactLedger/'));

(async () => {
  console.log('Foundation disbursements — three people, reserve, settle on confirmation\n');
  let F = setup();
  let M = load(path.join(FN, 'impact.js'));
  await F.db.collection('impactBalance').doc('current').set({ balance: 10000, verifiedBalance: 10000, reservedKES: 0, totalReceived: 10000 });
  await F.db.collection('impactGrants').doc('g1').set({ status: 'approved', approvedAmount: 3000 });

  /* A */
  const a1 = await run(M, 'impactInitiateDisbursement', 'adm1', { requestId: rid(1), amount: 2000, beneficiaryName: 'Mama Mboga', description: 'Restock after flood', destinationType: 'MPESA', destination: { phone: '0712345678' }, grantId: 'g1' }, ADM);
  const a2 = await run(M, 'impactInitiateDisbursement', 'adm1', { requestId: rid(1), amount: 9999, beneficiaryName: 'x', description: 'y', destinationType: 'MPESA', destination: { phone: '0712345678' } }, ADM);
  const a3 = await run(M, 'impactInitiateDisbursement', 'adm1', { requestId: rid(2), amount: 1500, beneficiaryName: 'x', description: 'y', destinationType: 'MPESA', destination: { phone: '0712345678' }, grantId: 'g1' }, ADM);
  const a4 = await run(M, 'impactInitiateDisbursement', 'adm1', { requestId: rid(3), amount: 20000, beneficiaryName: 'x', description: 'y', destinationType: 'MPESA', destination: { phone: '0712345678' } }, ADM);
  const a5 = await run(M, 'impactInitiateDisbursement', 'adm1', { requestId: rid(4), amount: 500, beneficiaryName: 'x', description: 'y', destinationType: 'PAYBILL', destination: { paybillNumber: '12' } }, ADM);
  const a6 = await run(M, 'impactInitiateDisbursement', 'user', { requestId: rid(5), amount: 500, beneficiaryName: 'x', description: 'y', destinationType: 'MPESA', destination: { phone: '0712345678' } });
  ck('A1 initiate → pending_approval; same requestId returns the same payout (not a second); grant headroom, balance, bad paybill, non-admin all refused',
    a1.ok && a1.v.status === 'pending_approval' && a2.ok && a2.v.already === true && (await dsb(F, 'DSB_' + rid(1))).amount === 2000
    && !a3.ok && /grant/.test(a3.msg) && !a4.ok && /Insufficient/.test(a4.msg) && !a5.ok && a5.code === 'invalid-argument' && a6.code === 'permission-denied', { a1, a2, a3, a4, a5, a6 });
  ck('A2 nothing reserved or debited at initiation', (await bal(F)).reservedKES === 0 && ledger(F).length === 0);

  /* B */
  const D1 = 'DSB_' + rid(1);
  const b1 = await run(M, 'impactApproveDisbursement', 'adm1', { disbursementId: D1 }, ADM);
  const b2 = await run(M, 'impactApproveDisbursement', 'adm2', { disbursementId: D1 }, ADM);
  const b3 = await run(M, 'impactAuthorizeDisbursement', 'adm3', { disbursementId: D1 }, ADM);
  const b4 = await run(M, 'impactAuthorizeDisbursement', 'adm2', { disbursementId: D1 }, { ...ADM, ...SUP });
  ck('B1 initiator cannot approve; a plain admin cannot authorize; the approver cannot authorize', !b1.ok && b2.ok && !b3.ok && b3.code === 'permission-denied' && !b4.ok && b4.code === 'permission-denied', { b1, b3, b4 });

  /* C + D */
  const c1 = await run(M, 'impactAuthorizeDisbursement', 'sup1', { disbursementId: D1 }, SUP);
  const c2 = await run(M, 'impactAuthorizeDisbursement', 'sup1', { disbursementId: D1 }, SUP);
  ck('C1 authorize claims + pays ONCE; the second call is refused (already processing)', c1.ok && c1.v.status === 'processing' && c1.v.trackingId === 'TRK1' && !c2.ok && c2.code === 'failed-precondition' && B2C.calls.length === 1 && B2C.calls[0].phone === '254712345678', { c1, c2, calls: B2C.calls });
  ck('D1 gateway ACCEPTED is not completed: 2,000 reserved, nothing debited', (await dsb(F, D1)).status === 'processing' && (await bal(F)).reservedKES === 2000 && ledger(F).length === 0, await bal(F));
  const d1 = await run(M, 'impactRefreshDisbursementStatus', 'adm2', { disbursementId: D1 }, ADM);
  ck('D2 IntaSend still Processing → stays processing', d1.ok && d1.v.status === 'processing' && ledger(F).length === 0);
  STATUS = { status: 'Completed', transaction_id: 'QWE123' };
  const d2 = await run(M, 'impactRefreshDisbursementStatus', 'adm2', { disbursementId: D1 }, ADM);
  const d3 = await run(M, 'impactRefreshDisbursementStatus', 'adm2', { disbursementId: D1 }, ADM);
  const b = await bal(F);
  ck('D3 Completed → ONE ledger debit, balance 8,000, reservation released, grant disbursed; a refresh replay changes nothing',
    d2.ok && d2.v.status === 'completed' && d3.ok && d3.v.status === 'completed' && ledger(F).length === 1 && b.balance === 8000 && b.reservedKES === 0 && (await F.db.collection('impactGrants').doc('g1').get()).data().disbursedKES === 2000, { d2, d3, b });
  /* refusal path */
  await run(M, 'impactInitiateDisbursement', 'adm1', { requestId: rid(6), amount: 1000, beneficiaryName: 'x', description: 'y', destinationType: 'MPESA', destination: { phone: '0722000000' } }, ADM);
  await run(M, 'impactApproveDisbursement', 'adm2', { disbursementId: 'DSB_' + rid(6) }, ADM);
  B2C.mode = 'refuse';
  const d4 = await run(M, 'impactAuthorizeDisbursement', 'sup1', { disbursementId: 'DSB_' + rid(6) }, SUP);
  B2C.mode = 'accept';
  ck('D4 gateway refuses → failed, funds released, nothing debited, clear error', !d4.ok && d4.code === 'unavailable' && (await dsb(F, 'DSB_' + rid(6))).status === 'failed' && (await bal(F)).reservedKES === 0 && ledger(F).length === 1, { d4, s: (await dsb(F, 'DSB_' + rid(6))).status });
  await run(M, 'impactInitiateDisbursement', 'adm1', { requestId: rid(7), amount: 700, beneficiaryName: 'x', description: 'y', destinationType: 'MPESA', destination: { phone: '0733000000' } }, ADM);
  await run(M, 'impactApproveDisbursement', 'adm2', { disbursementId: 'DSB_' + rid(7) }, ADM);
  await run(M, 'impactAuthorizeDisbursement', 'sup1', { disbursementId: 'DSB_' + rid(7) }, SUP);
  STATUS = { status: 'Failed' };
  const d5 = await run(M, 'impactRefreshDisbursementStatus', 'adm2', { disbursementId: 'DSB_' + rid(7) }, ADM);
  ck('D5 IntaSend reports Failed → failed, released, no debit', d5.ok && d5.v.status === 'failed' && (await bal(F)).reservedKES === 0 && ledger(F).length === 1, d5);

  /* E — manual rail */
  const e0 = await run(M, 'impactInitiateDisbursement', 'adm1', { requestId: rid(8), amount: 3000, beneficiaryName: 'St. Mary School', description: 'Fees term 1', destinationType: 'PAYBILL', destination: { paybillNumber: '522522', accountRef: 'ADM-7781' } }, ADM);
  const E = 'DSB_' + rid(8);
  await run(M, 'impactApproveDisbursement', 'adm2', { disbursementId: E }, ADM);
  const e1 = await run(M, 'impactAuthorizeDisbursement', 'sup1', { disbursementId: E }, SUP);
  ck('E1 PAYBILL authorize → processing, NO gateway call, 3,000 reserved', e0.ok && e1.ok && e1.v.rail === 'manual' && B2C.calls.length === 3 && (await bal(F)).reservedKES === 3000, { e1, calls: B2C.calls.length });
  const e2 = await run(M, 'impactRecordManualDisbursement', 'adm3', { disbursementId: E, action: 'confirm' }, ADM);
  const e3 = await run(M, 'impactRecordManualDisbursement', 'adm3', { disbursementId: E, action: 'record', providerReference: 'RFT88' }, ADM);
  const e4 = await run(M, 'impactRecordManualDisbursement', 'adm3', { disbursementId: E, action: 'confirm' }, ADM);
  ck('E2 confirm before record refused; record → awaiting_confirmation; the recorder cannot confirm their own', !e2.ok && e3.ok && e3.v.status === 'awaiting_confirmation' && !e4.ok && e4.code === 'permission-denied' && ledger(F).length === 1, { e2, e3, e4 });
  const e5 = await run(M, 'impactRecordManualDisbursement', 'adm1', { disbursementId: E, action: 'confirm' }, ADM);
  const e6 = await run(M, 'impactRecordManualDisbursement', 'adm1', { disbursementId: E, action: 'confirm' }, ADM);
  ck('E3 a different admin confirms → debit once (balance 5,000), released; double confirm refused', e5.ok && !e6.ok && ledger(F).length === 2 && (await bal(F)).balance === 5000 && (await bal(F)).reservedKES === 0, { e5, e6, b: await bal(F) });

  /* F */
  await run(M, 'impactInitiateDisbursement', 'adm1', { requestId: rid(9), amount: 400, beneficiaryName: 'x', description: 'y', destinationType: 'BANK', destination: { bankName: 'KCB', accountName: 'Jane W', accountNumber: '1234567890' } }, ADM);
  const f1 = await run(M, 'impactCancelDisbursement', 'adm2', { disbursementId: 'DSB_' + rid(9), note: 'Duplicate request' }, ADM);
  const f2 = await run(M, 'impactCancelDisbursement', 'adm2', { disbursementId: E, note: 'too late' }, ADM);
  ck('F1 cancel before authorization works; a completed payout cannot be cancelled', f1.ok && !f2.ok && f2.code === 'failed-precondition');
  const f3 = await run(M, 'impactAdminFoundationData', 'adm2', { view: 'disbursements' }, ADM);
  const f4 = await run(M, 'impactAdminFoundationData', 'adm2', { view: 'summary' }, ADM);
  const f5 = await run(M, 'impactAdminFoundationData', 'user', { view: 'summary' });
  const txt = JSON.stringify(f3.v);
  ck('F2 admin list masks destinations (no full phone / account / paybill account)', f3.ok && !/712345678|1234567890|ADM-7781/.test(txt) && /\*\*\*\*/.test(txt), txt.slice(0, 300));
  ck('F3 summary from aggregates (balance, available, counts); non-admin refused', f4.ok && f4.v.balance.balance === 5000 && f4.v.balance.available === 5000 && f4.v.disbursements.completed === 2 && f4.v.disbursements.failed === 2 && f5.code === 'permission-denied', f4.v);

  /* H — donation refund through the same chain */
  await F.db.collection('foundationDonations').doc('PLG_donor_x').set({ uid: 'donor', status: 'completed', amount: 1200, grossKES: 1200, feeKES: 30, programmeId: 'edu1', providerReference: 'INV9', receiptId: 'SKF-INV9' });
  await F.db.collection('foundationDonations').doc('PLG_donor_p').set({ uid: 'donor', status: 'pledged', amount: 500 });
  await F.db.collection('foundationStats').doc('current').set({ totalDonations: 1200 });
  await F.db.collection('impactCampaigns').doc('edu1').set({ raised: 1200, status: 'active' });
  const h0 = await run(M, 'impactInitiateDisbursement', 'adm1', { requestId: rid(20), amount: 500, beneficiaryName: 'x', description: 'refund', destinationType: 'MPESA', destination: { phone: '0711000000' }, refundOfPledgeId: 'PLG_donor_p' }, ADM);
  const h1 = await run(M, 'impactInitiateDisbursement', 'adm1', { requestId: rid(21), amount: 1500, beneficiaryName: 'x', description: 'refund', destinationType: 'MPESA', destination: { phone: '0711000000' }, refundOfPledgeId: 'PLG_donor_x' }, ADM);
  const h2 = await run(M, 'impactInitiateDisbursement', 'adm1', { requestId: rid(22), amount: 1200, beneficiaryName: 'Donor', description: 'Donor asked for refund', destinationType: 'MPESA', destination: { phone: '0711000000' }, refundOfPledgeId: 'PLG_donor_x' }, ADM);
  const h3 = await run(M, 'impactInitiateDisbursement', 'adm1', { requestId: rid(23), amount: 100, beneficiaryName: 'Donor', description: 'again', destinationType: 'MPESA', destination: { phone: '0711000000' }, refundOfPledgeId: 'PLG_donor_x' }, ADM);
  ck('H1 refund: only a completed donation, never more than received, never two at once', !h0.ok && !h1.ok && h2.ok && !h3.ok && h3.code === 'already-exists', { h0, h1, h3 });
  const R = 'DSB_' + rid(22);
  await run(M, 'impactApproveDisbursement', 'adm2', { disbursementId: R }, ADM);
  await run(M, 'impactAuthorizeDisbursement', 'sup1', { disbursementId: R }, SUP);
  const pBefore = (await F.db.collection('foundationDonations').doc('PLG_donor_x').get()).data();
  const disbursedBefore = (await bal(F)).totalDisbursed || 0;
  ck('H2 refund accepted by the gateway is NOT refunded yet (donation still completed)', pBefore.status === 'completed');
  STATUS = { status: 'Completed', transaction_id: 'RF1' };
  await run(M, 'impactRefreshDisbursementStatus', 'adm2', { disbursementId: R }, ADM);
  const pAfter = (await F.db.collection('foundationDonations').doc('PLG_donor_x').get()).data();
  const refundEntries = [...F.db._store.keys()].filter((k) => k.startsWith('impactLedger/')).map((k) => F.db._store.get(k).data).filter((e) => e.type === 'refund');
  ck('H3 on confirmation: ONE refund reversal entry, donation refunded (record kept), stats and programme raised reduced, not counted as disbursed',
    pAfter.status === 'refunded' && pAfter.amount === 1200 && refundEntries.length === 1 && refundEntries[0].debit === 1200 && refundEntries[0].meta.reversalOf === 'INV9'
    && (await F.db.collection('foundationStats').doc('current').get()).data().totalDonations === 0 && (await F.db.collection('impactCampaigns').doc('edu1').get()).data().raised === 0 && ((await bal(F)).totalDisbursed || 0) === disbursedBefore, { pAfter, refundEntries });

  /* G — counterproof */
  const orig = path.join(FN, '.orig-impact-dsb.js');
  fs.writeFileSync(orig, require('child_process').execSync('git show 3a38f35:functions/impact.js', { cwd: ROOT }).toString());
  let httpsCalls = 0;
  const realHttps = require('https').request;
  require('https').request = (opts, cb) => { httpsCalls++; const { EventEmitter } = require('events'); const res = new EventEmitter(); res.statusCode = 200; const req = new EventEmitter(); req.write = () => {}; req.end = () => { cb(res); res.emit('data', JSON.stringify({ tracking_id: 'OLD1' })); res.emit('end'); }; return req; };
  try {
    F = setup();
    const O = load(orig);
    await F.db.collection('impactBalance').doc('current').set({ balance: 10000 });
    await F.db.collection('impactDisbursements').doc('old').set({ status: 'pending_authorization', approvedBy: 'adm2', initiatedBy: 'adm1', amount: 5000, beneficiaryPhone: '0712345678', beneficiaryName: 'x', description: 'y' });
    const g1 = await run(O, 'impactAuthorizeDisbursement', 'sup1', { disbursementId: 'old' }, SUP);
    ck('G1 counterproof: the original marks "completed" and debits 5,000 on the INITIATE response (no provider confirmation)',
      g1.ok && httpsCalls === 1 && (await dsb(F, 'old')).status === 'completed' && (await bal(F)).balance === 5000, { g1, httpsCalls });
  } finally { require('https').request = realHttps; fs.unlinkSync(orig); }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('  CRASH', e); process.exit(2); });
