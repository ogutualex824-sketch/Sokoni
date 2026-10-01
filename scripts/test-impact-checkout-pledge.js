#!/usr/bin/env node
'use strict';
/* ============================================================================
   impactCheckoutDonate — a checkout donation is a PLEDGE, never minted as completed
   ----------------------------------------------------------------------------
   PROVEN live 2026-10-01 (impactcheckoutdonate-00007-seh, impact.js identical to this tree; found by
   sokoni-aa's community census): any signed-in user could record a 'completed' donation, a Foundation
   ledger credit and higher foundationStats for any amount 1–100,000 — no order or payment check.
   Real handler via .run on the in-memory Firestore fake.
     A  no order / malformed id / another buyer's order → refused, nothing written
     B  the order's buyer → ONE pledge (status 'pledged'); NO ledger entry; NO stats change
     C  a retry is a no-op (still one pledge); amounts outside 1–100,000 handled as before
     D  counterproof: the original code mints a completed donation + ledger credit for a stranger
   node scripts/test-impact-checkout-pledge.js
   ============================================================================ */
const path = require('path'), fs = require('fs'), Module = require('module');
const ROOT = path.resolve(__dirname, '..');
const FN = path.join(ROOT, 'functions');
const { makeFakeFirestore } = require('./lib/fake-firestore-txn');
let pass = 0, fail = 0;
const ck = (l, ok, d) => { if (ok) { pass++; console.log('  PASS  ' + l); } else { fail++; console.log('  FAIL  ' + l + (d !== undefined ? '  -> ' + JSON.stringify(d).slice(0, 300) : '')); } };
function setup() {
  const F = makeFakeFirestore();
  const ff = () => F.db; ff.FieldValue = F.FieldValue; ff.Timestamp = F.Timestamp;
  const fa = Module._resolveFilename('firebase-admin', { id: path.join(FN, 'x.js'), filename: path.join(FN, 'x.js'), paths: Module._nodeModulePaths(FN) });
  require.cache[fa] = { id: fa, filename: fa, loaded: true, exports: { apps: [1], initializeApp() {}, firestore: ff } };
  return F;
}
function load(file) { const f = require.resolve(file); delete require.cache[f]; return require(f); }
const keys = (F, pre) => [...F.db._store.keys()].filter((k) => k.startsWith(pre));
async function run(M, uid, data) { try { return { ok: true, v: await M.impactCheckoutDonate.run({ auth: uid ? { uid, token: {} } : null, data }) }; } catch (e) { return { ok: false, code: e.code }; } }

(async () => {
  console.log('impactCheckoutDonate — pledge, not mint\n');
  let F = setup();
  let M = load(path.join(FN, 'impact.js'));
  await F.db.collection('orders').doc('o1').set({ buyerUid: 'buyerA', total: 1200, status: 'pending_payment' });

  const a1 = await run(M, 'buyerA', { amount: 500, orderId: 'nope' });
  const a2 = await run(M, 'buyerA', { amount: 500, orderId: '../x' });
  const a3 = await run(M, 'stranger', { amount: 100000, orderId: 'o1' });
  ck('A1 unknown order → not-found; malformed id → invalid-argument; another buyer\'s order → permission-denied',
    !a1.ok && a1.code === 'not-found' && !a2.ok && a2.code === 'invalid-argument' && !a3.ok && a3.code === 'permission-denied', { a1, a2, a3 });
  ck('A2 refusals wrote nothing', keys(F, 'foundationDonations/').length === 0 && keys(F, 'impactLedger/').length === 0 && keys(F, 'impactBalance/').length === 0 && keys(F, 'foundationStats/').length === 0);

  const b = await run(M, 'buyerA', { amount: 500, orderId: 'o1', destination: 'Schools' });
  const don = (await F.db.collection('foundationDonations').doc('CHK_o1').get()).data();
  ck('B1 the buyer gets ONE pledge (status pledged, amount, order linked)', b.ok && b.v.status === 'pledged' && don && don.status === 'pledged' && don.amount === 500 && don.orderId === 'o1' && !don.completedAt, { b, don });
  ck('B2 NO Foundation ledger entry and NO stats change', keys(F, 'impactLedger/').length === 0 && keys(F, 'impactBalance/').length === 0 && keys(F, 'foundationStats/').length === 0, [...F.db._store.keys()]);
  const c = await run(M, 'buyerA', { amount: 900, orderId: 'o1' });
  ck('C1 a retry is a no-op (one pledge, original amount kept)', c.ok && c.v.alreadyPledged === true && keys(F, 'foundationDonations/').length === 1 && (await F.db.collection('foundationDonations').doc('CHK_o1').get()).data().amount === 500, c);
  const c0 = await run(M, 'buyerA', { amount: 0, orderId: 'o1' });
  const cBig = await run(M, 'buyerA', { amount: 100001, orderId: 'o1' });
  ck('C2 amount 0 is a no-op; over 100,000 is refused', c0.ok && c0.v.skipped === true && !cBig.ok && cBig.code === 'invalid-argument');

  /* E — standalone Foundation pledge (impactPledgeDonation) */
  const runP = async (uid, data) => { try { return { ok: true, v: await M.impactPledgeDonation.run({ auth: uid ? { uid, token: {} } : null, data }) }; } catch (e) { return { ok: false, code: e.code, msg: e.message }; } };
  const rid = '3f2b8c1e-9a4d-4b6e-8f10-2c3d4e5f6a7b';
  const e1 = await runP('donorA', { amount: 250, destination: 'Water', requestId: rid });
  const e2 = await runP('donorA', { amount: 9999, destination: 'Other', requestId: rid });
  const plg = (await F.db.collection('foundationDonations').doc('PLG_donorA_' + rid).get()).data();
  ck('E1 standalone pledge: PLG_<uid>_<requestId>, status pledged, amount kept', e1.ok && e1.v.pledgeId === 'PLG_donorA_' + rid && plg && plg.status === 'pledged' && plg.amount === 250 && plg.orderId === null, { e1, plg });
  ck('E2 a retried tap (same requestId) returns the SAME pledge — never a second one', e2.ok && e2.v.alreadyPledged === true && e2.v.amount === 250 && keys(F, 'foundationDonations/PLG_').length === 1, e2);
  const e3 = await runP('donorA', { amount: 250, requestId: 'not-a-uuid' });
  const e4 = await runP('donorA', { amount: 5, requestId: '4a2b8c1e-9a4d-4b6e-8f10-2c3d4e5f6a7b' });
  const e5 = await runP('donorA', { amount: 100001, requestId: '5a2b8c1e-9a4d-4b6e-8f10-2c3d4e5f6a7b' });
  const e6 = await runP(null, { amount: 250, requestId: '6a2b8c1e-9a4d-4b6e-8f10-2c3d4e5f6a7b' });
  ck('E3 bad requestId / below KES 10 / above 100,000 / signed out → refused', !e3.ok && e3.code === 'invalid-argument' && !e4.ok && !e5.ok && !e6.ok && e6.code === 'unauthenticated', { e3, e4, e5, e6 });
  ck('E4 still NO ledger, NO balance, NO stats after pledges', keys(F, 'impactLedger/').length === 0 && keys(F, 'impactBalance/').length === 0 && keys(F, 'foundationStats/').length === 0);
  const origRT = F.db.runTransaction; F.db.runTransaction = async () => { throw new Error('contention'); };
  const e7 = await runP('donorB', { amount: 300, requestId: '7a2b8c1e-9a4d-4b6e-8f10-2c3d4e5f6a7b' });
  F.db.runTransaction = origRT;
  ck('E5 rate limiter unavailable → refused (fail closed), no pledge written', !e7.ok && e7.code === 'unavailable' && keys(F, 'foundationDonations/PLG_donorB').length === 0, e7);

  /* D — counterproof on the original code */
  const orig = path.join(FN, '.orig-impact.js');
  fs.writeFileSync(orig, require('child_process').execSync('git show c7e26b6:functions/impact.js', { cwd: ROOT }).toString());
  try {
    F = setup();
    const O = load(orig);
    const d = await run(O, 'stranger', { amount: 100000, orderId: 'whatever' });
    const minted = keys(F, 'foundationDonations/').map((k) => F.db._store.get(k).data);
    ck('D1 counterproof: the ORIGINAL code mints a completed donation + ledger credit for a stranger with no order', d.ok && minted.some((x) => x.status === 'completed' && x.amount === 100000) && keys(F, 'impactLedger/').length === 1 && keys(F, 'impactBalance/').length === 1, { d, minted: minted.length, keys: [...F.db._store.keys()] });
  } finally { fs.unlinkSync(orig); }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('  CRASH', e); process.exit(2); });
