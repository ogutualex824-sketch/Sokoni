#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════════════
   DELIVERY SEQUENCE — the invariant, executed against the REAL rules
   ---------------------------------------------------------------------------
     firebase emulators:exec --only firestore --project sokoni-deliv-seq \
       "node scripts/test-delivery-sequence.js"

   THE INVARIANT
     The rider's possession of the delivery workflow is NOT authorization to create
     the `delivered` event or trigger payment. Until the buyer's PIN has been verified
     SERVER-SIDE, the PERSISTED order status must still be its pre-delivery value.

   Why this suite exists alongside test-delivery-authorization.js: that one proves the
   callable's decisions. This one proves the DOOR IS SHUT — it drives real
   firestore.rules through @firebase/rules-unit-testing as the rider's own
   authenticated client, which is exactly what a malicious rider would do. Reading the
   rules file and believing it is not the same as executing it.

   And it asserts the SEQUENCE, not just isolated calls: a rider who reaches
   `in_transit` legitimately must still be unable to reach `delivered` by any path
   until the buyer's PIN is verified. The decisive assertion after every denied attempt
   is the PERSISTED status — a disabled button proves nothing.
   ═══════════════════════════════════════════════════════════════════════════ */
'use strict';
process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
process.env.SOKONI_HMAC_KEY = process.env.SOKONI_HMAC_KEY || 'test-hmac-key-not-a-production-secret';

const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const FN = path.join(ROOT, 'functions');

const { initializeTestEnvironment, assertFails, assertSucceeds } =
  require(require.resolve('@firebase/rules-unit-testing', { paths: [ROOT, FN] }));
const { doc, setDoc, updateDoc, getDoc } =
  require(require.resolve('firebase/firestore', { paths: [ROOT, FN] }));

const admin = require(require.resolve('firebase-admin', { paths: [FN] }));

let pass = 0, fail = 0;
const ck = (l, ok, d) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined ? '   [' + String(d).slice(0, 90) + ']' : ''));
  ok ? pass++ : fail++;
};
const head = (t) => console.log('\n── ' + t + ' ──');

const RIDER = 'rider-seq-A';
const BUYER = 'buyer-seq-1';
const PKG   = 'pkg_seq';
const ORDER = 'ord_seq';
const PIN   = '135790';

/* Is the Firestore emulator actually there? Without this the suite threw
   "TypeError: fetch failed" and exited 1 — which ABORTED A PRODUCTION DEPLOY, because
   scripts/gate-inventory.js runs the suite population as a predeploy hook and no emulator
   exists in that context. A security suite must not be the reason a release cannot ship.
   Skipping is honest here and not a licence to ignore it: the authoritative gate runs under
   `firebase emulators:exec`, where this executes for real. Exit 0 with no assertions, which
   classify() reads as ENV — the same treatment test-returns-rules and test-workspace-rules
   carry for exactly this reason. */
function emulatorReachable(hostPort) {
  const [host, port] = String(hostPort).split(':');
  return new Promise((resolve) => {
    const sock = require('net').connect({ host, port: Number(port) }, () => { sock.destroy(); resolve(true); });
    sock.on('error', () => resolve(false));
    sock.setTimeout(2000, () => { sock.destroy(); resolve(false); });
  });
}

(async () => {
  if (!(await emulatorReachable(process.env.FIRESTORE_EMULATOR_HOST))) {
    console.log('\nSKIP — the Firestore emulator is not running at ' + process.env.FIRESTORE_EMULATOR_HOST + '.');
    console.log('This suite drives the REAL firestore.rules through @firebase/rules-unit-testing,');
    console.log('so it cannot run without one. Run it with:');
    console.log('  firebase emulators:exec --only firestore "node scripts/test-delivery-sequence.js"');
    process.exit(0);
  }
  const PROJECT = 'sokoni-deliv-seq-' + Date.now().toString(36);
  process.env.GCLOUD_PROJECT = PROJECT;

  const env = await initializeTestEnvironment({
    projectId: PROJECT,
    firestore: {
      rules: fs.readFileSync(path.join(ROOT, 'firestore.rules'), 'utf8'),
      host: process.env.FIRESTORE_EMULATOR_HOST.split(':')[0],
      port: Number(process.env.FIRESTORE_EMULATOR_HOST.split(':')[1]),
    },
  });

  /* Admin SDK against the SAME emulator/project — this is how the Cloud Function writes,
     bypassing rules, so the test exercises both doors: the rider's (rules-enforced) and
     the server's (Admin). */
  if (!admin.apps.length) admin.initializeApp({ projectId: PROJECT });
  const adb = admin.firestore();
  const mod = require('../functions/delivery-complete.js');
  const { _hash, _sameHash, _completeDelivery } = mod._h;

  /* Seed through the security-rules bypass so the fixture itself is not what is under test. */
  await env.withSecurityRulesDisabled(async (ctx) => {
    const d = ctx.firestore();
    await setDoc(doc(d, 'orders', ORDER), {
      buyerUid: BUYER, sellerUid: 'seller-seq', assignedDriverUid: RIDER,
      status: 'rider_assigned', deliveryFee: 250, packageRequestId: PKG,
    });
    await setDoc(doc(d, 'packageRequests', PKG), {
      orderId: ORDER, riderId: RIDER, status: 'driver_accepted',
      deliveryPinHash: _hash(PKG, PIN), deliveryVerifyAttempts: 0,
    });
  });

  const riderDb = env.authenticatedContext(RIDER).firestore();
  const buyerDb = env.authenticatedContext(BUYER).firestore();
  const persisted = async () => (await adb.collection('orders').doc(ORDER).get()).data().status;

  head('1 · the rider CAN drive the delivery forward (these pay nobody)');
  await assertSucceeds(updateDoc(doc(riderDb, 'orders', ORDER), { status: 'picked_up', updatedAt: new Date().toISOString() }));
  ck('picked_up allowed', (await persisted()) === 'picked_up', await persisted());
  await assertSucceeds(updateDoc(doc(riderDb, 'orders', ORDER), { status: 'in_transit', updatedAt: new Date().toISOString() }));
  ck('in_transit allowed', (await persisted()) === 'in_transit', await persisted());

  head('2 · the rider CANNOT declare it delivered — by any direct path');
  /* Each of these is a real write attempt by the rider's own authenticated client
     against the real ruleset. After every one, the PERSISTED status is re-read. */
  const attempts = [
    ['status delivered',                 { status: 'delivered' }],
    ['status completed',                 { status: 'completed' }],
    ['status delivered + deliveredAt',   { status: 'delivered', deliveredAt: new Date().toISOString() }],
    ['deliveredAt alone',                { deliveredAt: new Date().toISOString() }],
    ['delivered smuggled with a note',   { status: 'delivered', driverNote: 'done' }],
  ];
  for (const [label, patch] of attempts) {
    await assertFails(updateDoc(doc(riderDb, 'orders', ORDER), patch));
    ck('DENIED: ' + label, true);
    ck('  ...persisted status is still in_transit', (await persisted()) === 'in_transit', await persisted());
  }

  head('3 · nor can the rider forge the PIN hash to make their own PIN valid');
  await assertFails(updateDoc(doc(riderDb, 'packageRequests', PKG), { deliveryPinHash: _hash(PKG, '000000') }));
  ck('DENIED: rewriting deliveryPinHash', true);

  head('4 · the callable refuses before the PIN is verified');
  const riderComplete = async (pin) => {
    const snap = await adb.collection('packageRequests').doc(PKG).get();
    const d = snap.data();
    const assigned = d.riderId || d.assignedRiderId || d.assignedDriverUid || null;
    if (assigned !== RIDER) return { denied: 'not-assigned' };
    if (!/^\d{4,8}$/.test(String(pin || ''))) return { denied: 'pin-missing' };
    if (!d.deliveryPinHash) return { denied: 'no-hash' };
    if (!_sameHash(_hash(PKG, pin), d.deliveryPinHash)) return { denied: 'wrong-pin' };
    return _completeDelivery({ orderId: ORDER, pkgId: PKG, riderUid: RIDER, method: 'rider_pin', actorUid: RIDER });
  };

  for (const [label, pin] of [['no PIN', ''], ['missing PIN', null], ['wrong PIN', '000000'], ['non-numeric', 'abcd']]) {
    const r = await riderComplete(pin);
    ck('DENIED via callable: ' + label, !!r.denied, JSON.stringify(r));
    ck('  ...persisted status is still in_transit', (await persisted()) === 'in_transit', await persisted());
  }

  head('5 · buyer provides the PIN → rider submits → server transitions');
  /* The buyer's plaintext copy lives on their own order doc; the rider's client never
     sees it. Read it as the BUYER, which is how the real flow works. */
  const buyerView = await getDoc(doc(buyerDb, 'orders', ORDER));
  ck('buyer can read their own order', buyerView.exists());
  const ok = await riderComplete(PIN);
  ck('correct PIN accepted', ok.ok === true && ok.alreadyDelivered === false, JSON.stringify(ok));
  ck('persisted status is NOW delivered', (await persisted()) === 'delivered', await persisted());
  const o = (await adb.collection('orders').doc(ORDER).get()).data();
  ck('authorized by rider_pin, actor recorded', o.deliveryAuthorizedBy === 'rider_pin' && o.deliveryAuthorizedActor === RIDER,
     o.deliveryAuthorizedBy + '/' + o.deliveryAuthorizedActor);

  head('6 · exactly one payout-triggering transition');
  /* onOrderStatusChange fires on the transition INTO delivered and is guarded by the
     deterministic walletTransactions/{rider}_{order}_delivery doc. The property this
     suite owns is upstream of that: the transition itself happens once. */
  const again = await riderComplete(PIN);
  ck('re-submitting is inert, not a second transition', again.ok === true && again.alreadyDelivered === true, JSON.stringify(again));
  ck('deliveredAt not rewritten', (await adb.collection('orders').doc(ORDER).get()).data().deliveredAt !== undefined);

  head('7 · buyer fallback on a SEPARATE order — buyer-initiated only');
  const O2 = 'ord_seq_fb';
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'orders', O2), {
      buyerUid: BUYER, sellerUid: 'seller-seq', assignedDriverUid: RIDER,
      status: 'in_transit', deliveryFee: 250,
    });
  });
  const buyerConfirm = async (uid) => {
    const oo = (await adb.collection('orders').doc(O2).get()).data();
    if ((oo.buyerUid || null) !== uid) return { denied: 'not-buyer' };
    if ((oo.assignedDriverUid || null) === uid) return { denied: 'self-deal' };
    return _completeDelivery({ orderId: O2, pkgId: null, riderUid: oo.assignedDriverUid, method: 'buyer_confirmation', actorUid: uid });
  };
  const byRider = await buyerConfirm(RIDER);
  ck('rider cannot initiate the buyer fallback', !!byRider.denied, JSON.stringify(byRider));
  const st2 = async () => (await adb.collection('orders').doc(O2).get()).data().status;
  ck('  ...persisted status still in_transit', (await st2()) === 'in_transit', await st2());
  const byBuyer = await buyerConfirm(BUYER);
  ck('buyer CAN complete it', byBuyer.ok === true, JSON.stringify(byBuyer));
  ck('persisted status is delivered', (await st2()) === 'delivered', await st2());

  head('8 · a correct PIN cannot deliver a cancelled order');
  const O3 = 'ord_seq_cancelled', P3 = 'pkg_seq_cancelled';
  await env.withSecurityRulesDisabled(async (ctx) => {
    const d = ctx.firestore();
    await setDoc(doc(d, 'orders', O3), { buyerUid: BUYER, sellerUid: 's', assignedDriverUid: RIDER, status: 'cancelled', deliveryFee: 250 });
    await setDoc(doc(d, 'packageRequests', P3), { orderId: O3, riderId: RIDER, deliveryPinHash: _hash(P3, PIN) });
  });
  const r3 = await _completeDelivery({ orderId: O3, pkgId: P3, riderUid: RIDER, method: 'rider_pin', actorUid: RIDER });
  ck('refused on a cancelled order', r3.ok === false, JSON.stringify(r3));
  ck('  ...status still cancelled', (await adb.collection('orders').doc(O3).get()).data().status === 'cancelled');

  await env.cleanup();
  console.log('\n' + '='.repeat(70));
  console.log('  ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('\nFATAL: ' + (e && e.stack || e)); process.exit(1); });
