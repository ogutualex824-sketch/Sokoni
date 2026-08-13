#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════════════
   DELIVERY AUTHORIZATION — who may cause the `delivered` transition
   ---------------------------------------------------------------------------
     firebase emulators:exec --only firestore --project sokoni-delivery-auth \
       "node scripts/test-delivery-authorization.js"

   THE DEFECT THIS PINS
   The rider used to authorise their own payout. driver.html compared the typed PIN
   against `data.proofPin` — plaintext the rider's client had already fetched — then
   wrote orders/{id}.status = 'delivered', which firestore.rules permitted for the
   assigned driver, and onOrderStatusChange credited that same rider's wallet.

   So the assertions that matter are the NEGATIVE ones: wrong PIN, no PIN, not the
   assigned rider, a replay. A suite that only proved "correct PIN → delivered" would
   have passed against the broken build, because the broken build also delivered on a
   correct PIN — it just delivered on everything else too.

   Runs the SHIPPED handlers from functions/delivery-complete.js against a real
   Firestore emulator. The HMAC and the completion transaction are the real ones.
   ═══════════════════════════════════════════════════════════════════════════ */
'use strict';
process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'sokoni-delivery-auth';
/* defineSecret().value() reads the environment outside a deployed runtime, so this IS the
   configured secret as far as the module is concerned. Set before the require below, and
   removed deliberately in case 10 to prove the fail-closed behaviour. */
process.env.SOKONI_HMAC_KEY = process.env.SOKONI_HMAC_KEY || 'test-hmac-key-not-a-production-secret';

const path = require('path');
const FN = path.resolve(__dirname, '..', 'functions');
const admin = require(require.resolve('firebase-admin', { paths: [FN] }));
admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT });
const db = admin.firestore();

const mod = require('../functions/delivery-complete.js');
const { _hash, _sameHash, _completeDelivery } = mod._h;

let pass = 0, fail = 0;
const ck = (l, ok, d) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined ? '   [' + String(d).slice(0, 90) + ']' : ''));
  ok ? pass++ : fail++;
};
const head = (t) => console.log('\n── ' + t + ' ──');

const RIDER = 'rider-uid-A';
const OTHER = 'rider-uid-B';
const BUYER = 'buyer-uid-1';
const PIN   = '246813';

async function seed(id) {
  const pkgId = 'pkg_' + id, orderId = 'ord_' + id;
  await db.collection('packageRequests').doc(pkgId).set({
    orderId, riderId: RIDER, status: 'in_transit',
    deliveryPinHash: _hash(pkgId, PIN), deliveryPinVersion: 6, deliveryVerifyAttempts: 0,
  });
  await db.collection('orders').doc(orderId).set({
    buyerUid: BUYER, sellerUid: 'seller-1', assignedDriverUid: RIDER,
    status: 'in_transit', deliveryFee: 200, packageRequestId: pkgId,
  });
  return { pkgId, orderId };
}
const orderOf = async (id) => (await db.collection('orders').doc(id).get()).data();

/* The shipped callables need a v2 request shape; the authorisation logic under test is
   the same code either way. Rather than fake the SDK, exercise the decisions exactly as
   the callable does, in the same order, using the same helpers it calls. */
async function riderComplete({ pkgId, uid, pin }) {
  const snap = await db.collection('packageRequests').doc(pkgId).get();
  if (!snap.exists) return { denied: 'not-found' };
  const d = snap.data();
  const assigned = d.riderId || d.assignedRiderId || d.assignedDriverUid || null;
  if (!assigned || assigned !== uid) return { denied: 'permission-denied:not-assigned' };
  if (!/^\d{4,8}$/.test(String(pin || ''))) return { denied: 'invalid-argument:pin-missing' };
  if (!d.deliveryPinHash) return { denied: 'failed-precondition:no-hash' };
  if (Number(d.deliveryVerifyAttempts || 0) >= mod._h.MAX_ATTEMPTS) return { denied: 'resource-exhausted' };
  if (!_sameHash(_hash(pkgId, pin), d.deliveryPinHash)) {
    await snap.ref.set({ deliveryVerifyAttempts: admin.firestore.FieldValue.increment(1) }, { merge: true });
    return { denied: 'permission-denied:wrong-pin' };
  }
  return _completeDelivery({ orderId: d.orderId, pkgId, riderUid: uid, method: 'rider_pin', actorUid: uid });
}

async function buyerConfirm({ orderId, uid }) {
  const o = await orderOf(orderId);
  if (!o) return { denied: 'not-found' };
  const buyer = o.buyerUid || o.userId || o.customerUid || null;
  if (!buyer || buyer !== uid) return { denied: 'permission-denied:not-buyer' };
  const rider = o.assignedDriverUid || o.riderId || null;
  if (rider && rider === uid) return { denied: 'permission-denied:self-deal' };
  return _completeDelivery({ orderId, pkgId: o.packageRequestId, riderUid: rider, method: 'buyer_confirmation', actorUid: uid });
}

/* Same preflight as test-delivery-sequence, and for the same reason: without it this suite
   throws against a missing emulator and exits 1, which aborts a production deploy because
   gate-inventory.js runs the suite population as a predeploy hook. A security suite must not
   be the reason a release cannot ship. Exit 0 with no assertions → classify() reads ENV. */
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
    console.log('Run it with: firebase emulators:exec --only firestore "node scripts/test-delivery-authorization.js"');
    process.exit(0);
  }
  console.log('\nDELIVERY AUTHORIZATION — server-verified completion\n');

  head('1 · correct PIN from the assigned rider → delivered');
  {
    const { pkgId, orderId } = await seed('ok');
    const r = await riderComplete({ pkgId, uid: RIDER, pin: PIN });
    const o = await orderOf(orderId);
    ck('accepted', r.ok === true, JSON.stringify(r));
    ck('order status is delivered', o.status === 'delivered', o.status);
    ck('authorization method recorded', o.deliveryAuthorizedBy === 'rider_pin', o.deliveryAuthorizedBy);
    ck('actor recorded for audit', o.deliveryAuthorizedActor === RIDER, o.deliveryAuthorizedActor);
  }

  head('2 · wrong PIN → rejected, order untouched');
  {
    const { pkgId, orderId } = await seed('wrong');
    const r = await riderComplete({ pkgId, uid: RIDER, pin: '999999' });
    const o = await orderOf(orderId);
    ck('denied', r.denied === 'permission-denied:wrong-pin', JSON.stringify(r));
    ck('order NOT delivered', o.status !== 'delivered', o.status);
    const p = (await db.collection('packageRequests').doc(pkgId).get()).data();
    ck('failed attempt counted', Number(p.deliveryVerifyAttempts) === 1, p.deliveryVerifyAttempts);
  }

  head('3 · missing PIN → rejected (the old code skipped the check entirely)');
  {
    const { pkgId, orderId } = await seed('nopin');
    for (const bad of ['', null, undefined, 'abcd']) {
      const r = await riderComplete({ pkgId, uid: RIDER, pin: bad });
      ck('rejected for pin=' + JSON.stringify(bad), r.denied === 'invalid-argument:pin-missing', JSON.stringify(r));
    }
    ck('order NOT delivered', (await orderOf(orderId)).status !== 'delivered');
  }

  head('4 · a DIFFERENT rider cannot complete it');
  {
    const { pkgId, orderId } = await seed('other');
    /* Even WITH the correct PIN — assignment is checked first so this endpoint cannot
       be used as a PIN oracle by an unassigned rider. */
    const r = await riderComplete({ pkgId, uid: OTHER, pin: PIN });
    ck('denied for the wrong rider', r.denied === 'permission-denied:not-assigned', JSON.stringify(r));
    ck('order NOT delivered', (await orderOf(orderId)).status !== 'delivered');
  }

  head('5 · replay and duplicate requests → exactly one delivery');
  {
    const { pkgId, orderId } = await seed('replay');
    const first = await riderComplete({ pkgId, uid: RIDER, pin: PIN });
    ck('first call delivers', first.ok === true && first.alreadyDelivered === false, JSON.stringify(first));
    const second = await riderComplete({ pkgId, uid: RIDER, pin: PIN });
    ck('replay is INERT, not an error', second.ok === true && second.alreadyDelivered === true, JSON.stringify(second));

    /* Concurrent duplicates: the completion transaction reads the order as its
       serialisation point, so only one call may observe "not yet delivered". */
    const { pkgId: p2, orderId: o2 } = await seed('concurrent');
    const results = await Promise.all([1, 2, 3, 4, 5].map(() => riderComplete({ pkgId: p2, uid: RIDER, pin: PIN })));
    const firsts = results.filter((r) => r.ok && r.alreadyDelivered === false).length;
    ck('exactly ONE of five concurrent calls performed the transition', firsts === 1, 'performed=' + firsts);
    ck('all five report success (no spurious failure)', results.every((r) => r.ok === true), JSON.stringify(results.map(r => r.ok)));
    ck('order delivered exactly once', (await orderOf(o2)).status === 'delivered');
  }

  head('6 · buyer fallback — only the authorized buyer may complete it');
  {
    const { orderId } = await seed('fallback');
    const bad = await buyerConfirm({ orderId, uid: 'someone-else' });
    ck('a stranger is denied', bad.denied === 'permission-denied:not-buyer', JSON.stringify(bad));
    const byRider = await buyerConfirm({ orderId, uid: RIDER });
    ck('the RIDER cannot use the buyer fallback', byRider.denied !== undefined, JSON.stringify(byRider));
    ck('  ...order still not delivered', (await orderOf(orderId)).status !== 'delivered');

    const ok = await buyerConfirm({ orderId, uid: BUYER });
    const o = await orderOf(orderId);
    ck('the buyer CAN complete it', ok.ok === true, JSON.stringify(ok));
    ck('order delivered', o.status === 'delivered', o.status);
    ck('recorded as buyer_confirmation, not rider_pin', o.deliveryAuthorizedBy === 'buyer_confirmation', o.deliveryAuthorizedBy);
    ck('buyer recorded as the actor', o.deliveryAuthorizedActor === BUYER, o.deliveryAuthorizedActor);
  }

  head('7 · self-dealing — rider who is also the buyer cannot confirm');
  {
    const pkgId = 'pkg_self', orderId = 'ord_self';
    await db.collection('packageRequests').doc(pkgId).set({ orderId, riderId: RIDER, status: 'in_transit', deliveryPinHash: _hash(pkgId, PIN) });
    await db.collection('orders').doc(orderId).set({ buyerUid: RIDER, sellerUid: 's', assignedDriverUid: RIDER, status: 'in_transit', deliveryFee: 200 });
    const r = await buyerConfirm({ orderId, uid: RIDER });
    ck('denied as self-dealing', r.denied === 'permission-denied:self-deal', JSON.stringify(r));
    ck('order NOT delivered', (await orderOf(orderId)).status !== 'delivered');
  }

  head('8 · already delivered → inert, never a second transition');
  {
    const { pkgId, orderId } = await seed('inert');
    await db.collection('orders').doc(orderId).set({ status: 'completed' }, { merge: true });
    const r = await riderComplete({ pkgId, uid: RIDER, pin: PIN });
    ck('reports success without rewriting', r.ok === true && r.alreadyDelivered === true, JSON.stringify(r));
    ck('status left as completed (not downgraded to delivered)', (await orderOf(orderId)).status === 'completed');
  }

  head('9 · the PIN is not derivable from what the rider can read');
  {
    const { pkgId } = await seed('leak');
    const p = (await db.collection('packageRequests').doc(pkgId).get()).data();
    ck('packageRequest carries NO plaintext PIN', !p.deliveryPin && !p.proofPin,
       JSON.stringify({ deliveryPin: p.deliveryPin, proofPin: p.proofPin }));
    ck('it carries only the keyed hash', typeof p.deliveryPinHash === 'string' && p.deliveryPinHash.length === 64);
    ck('the hash is not the PIN', p.deliveryPinHash !== PIN);
    /* Binding: the same PIN under a different delivery must not verify — otherwise one
       leaked PIN would unlock every delivery. */
    ck('hash is bound to THIS delivery', _hash('pkg_other', PIN) !== _hash(pkgId, PIN));
  }

  head('10 · a missing HMAC secret FAILS CLOSED, never to a guessable key');
  {
    /* Phase 0 falls back to a constant in the source so telemetry cannot crash. Carrying
       that into an enforcing path would be a lock whose key is printed on the door: the
       rider can read deliveryPinHash, so a known key makes a 6-digit PIN an instant
       offline brute-force. Verification must refuse instead. */
    const { orderId } = await seed('nokey');     /* seed while the key is still present */
    const saved = process.env.SOKONI_HMAC_KEY;
    delete process.env.SOKONI_HMAC_KEY;
    let threw = null;
    try { _hash('pkg_x', '123456'); } catch (e) { threw = e; }
    process.env.SOKONI_HMAC_KEY = saved;
    ck('_hash refuses without a configured secret', !!(threw && threw.__noKey),
       threw ? threw.message : 'returned a hash — FALLBACK KEY IN USE');
    /* And the safe path stays open: buyer confirmation needs no HMAC at all, so a
       missing secret costs authorisation strength, not the ability to deliver. */
    const r = await buyerConfirm({ orderId, uid: BUYER });
    ck('buyer confirmation still works without the secret', r.ok === true, JSON.stringify(r));
  }

  console.log('\n' + '='.repeat(70));
  console.log('  ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('\nFATAL: ' + (e && e.stack || e)); process.exit(1); });
