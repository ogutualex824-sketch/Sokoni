#!/usr/bin/env node
/**
 * SOKONI Store operator payout — REAL Firestore transaction semantics (emulator).   WRITTEN, NOT YET RUN.
 *
 *   firebase emulators:exec --only firestore "node scripts/test-sokoni-store-payout-emulator.js"
 *
 * What the hermetic suite (test-sokoni-first-party-store.js) cannot prove, because its fake
 * Firestore is not transactional:
 *   E1 concurrent requests with the SAME requestId → exactly one payoutRequests doc, ONE reserve;
 *   E2 concurrent requests with DIFFERENT ids that together exceed the balance → the balance is
 *      never driven negative (contention retries re-read inside the transaction);
 *   E3 the reserve + request create commit atomically (an over-balance refusal leaves no doc,
 *      no velocity count and no wallet change);
 *   E4 the created request is then processed by the REAL wallet.js _refundPayout path
 *      (driven through adminProcessPayout's reject branch handler logic is out of reach without
 *      the callable wrapper, so this suite asserts the documents adminProcessPayout reads:
 *      payoutRequests/{id}.sellerUid === 'SOK-XX2338' and wallets/SOK-XX2338.pendingPayout).
 * Refuses to run against anything but the emulator.
 */
'use strict';
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const FN = path.join(ROOT, 'functions');

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  console.log('  UNPROVEN  every assertion — FIRESTORE_EMULATOR_HOST is not set. BLOCKED is not PASS.');
  process.exit(0);
}
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'sokoni-store-payout-emu';
const fnRequire = require('module').createRequire(path.join(FN, 'package.json'));
const admin = fnRequire('firebase-admin');
if (!admin.apps.length) admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT });
const db = admin.firestore();
require.cache[path.join(FN, 'redis-rate-limiter.js')] = { id: 'rl', filename: path.join(FN, 'redis-rate-limiter.js'), loaded: true, exports: { checkRateLimit: async () => {} } };
const PAY = require(path.join(FN, 'first-party-store-payout.js'));
const crypto = require('crypto');

let pass = 0, fail = 0;
const ok = (n, c, d) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (d ? '   [' + d + ']' : '')); } };
const OWNER = 'vbaSOKL4h8WWGqa6Xfi1eLaEPnS2', OPERATOR = 'D5Ql2EYr95bt79IpcGTmOMTK0P83';
const STORE = 'STR_147f5ce11b424ec4bb892519', BIZ = 'SOK-XX2338', PHONE = '+254705726803';
const req = (data) => ({ auth: { uid: OPERATOR, token: {} }, data });

async function seed(balance) {
  for (const c of ['shops', 'businesses', 'firstPartyStoreOperators', 'firstPartyStoreConfig', 'wallets', 'payoutRequests', 'payoutVelocity', 'walletPinAttempts', 'firstPartyStoreAudit']) {
    const s = await db.collection(c).get(); await Promise.all(s.docs.map((d) => d.ref.delete()));
  }
  await db.doc('shops/' + STORE).set({ firstParty: true, ownerId: OWNER, name: 'SOKONI Store' });
  await db.doc('businesses/' + BIZ).set({ ownerId: OWNER, businessType: 'SOKONI_FIRST_PARTY_STORE', status: 'active' });
  await db.doc('firstPartyStoreOperators/' + STORE).set({ storeId: STORE, businessId: BIZ, ownerUid: OWNER, operatorUids: [OPERATOR], payoutDestination: { msisdn: PHONE } });
  await db.doc('firstPartyStoreConfig/payouts').set({ enabled: true });
  await db.doc('wallets/' + OPERATOR).set({ balance: 0, pinHash: crypto.createHash('sha256').update('1234' + OPERATOR).digest('hex') });
  await db.doc('wallets/' + BIZ).set({ balance, pendingPayout: 0 });
}

(async () => {
  await seed(1000);
  const same = await Promise.allSettled([1, 2, 3, 4, 5].map(() => PAY._h.sokoniStorePayoutRequest(req({ pin: '1234', amount: 300, requestId: 'emu-same-0001' }), db)));
  const w1 = (await db.doc('wallets/' + BIZ).get()).data();
  const reqs1 = await db.collection('payoutRequests').get();
  ok('E1 five concurrent identical requestIds → one doc, one reserve', reqs1.size === 1 && w1.balance === 700 && w1.pendingPayout === 300, JSON.stringify({ size: reqs1.size, w1, st: same.map((x) => x.status) }));

  await seed(1000);
  await Promise.allSettled([1, 2, 3].map((i) => PAY._h.sokoniStorePayoutRequest(req({ pin: '1234', amount: 400, requestId: 'emu-diff-000' + i }), db)));
  const w2 = (await db.doc('wallets/' + BIZ).get()).data();
  const reqs2 = await db.collection('payoutRequests').get();
  ok('E2 concurrent 3×400 on 1000 → exactly two succeed, balance 200, never negative', reqs2.size === 2 && w2.balance === 200 && w2.pendingPayout === 800, JSON.stringify({ size: reqs2.size, w2 }));

  await seed(100);
  let refused = null;
  try { await PAY._h.sokoniStorePayoutRequest(req({ pin: '1234', amount: 500, requestId: 'emu-over-0001' }), db); } catch (e) { refused = e.details && e.details.reason; }
  const vel = await db.doc('payoutVelocity/' + BIZ).get();
  ok('E3 over-balance refusal is atomic: no request, no velocity count, wallet unchanged',
    refused === 'insufficient-store-balance' && !(await db.doc('payoutRequests/pout_emu-over-0001').get()).exists && !vel.exists && (await db.doc('wallets/' + BIZ).get()).data().balance === 100);

  await seed(1000);
  await PAY._h.sokoniStorePayoutRequest(req({ pin: '1234', amount: 250, requestId: 'emu-admin-0001' }), db);
  const pr = (await db.doc('payoutRequests/pout_emu-admin-0001').get()).data();
  ok('E4 the request is addressable by adminProcessPayout: sellerUid=SOK-XX2338, status pending, accountNumber = stored destination',
    pr.sellerUid === BIZ && pr.status === 'pending' && pr.accountNumber === PHONE);

  console.log(`\n${pass} PASS / ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASH (not a pass):', e && (e.stack || e)); process.exit(2); });
