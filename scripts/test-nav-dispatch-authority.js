#!/usr/bin/env node
/* SECURITY HOTFIX 2026-10-03 — navigation dispatch / delivery authority (functions/navigation.js).
 *
 *   node scripts/test-nav-dispatch-authority.js
 *   BASE=dda12d11c4 node scripts/test-nav-dispatch-authority.js   (the LIVE archive, byte-identical — must FAIL)
 *
 * Drives the REAL callables (.run) of navDispatchRider / navCompleteTrip / navUpdateTripStatus / navSubmitPOD /
 * navAssignTrip on an in-memory Firestore (firebase-admin replaced in the require cache). The exploit row X-1 replays
 * the live attack end to end: a stranger makes themselves the rider on someone's order and completes the trip.
 */
'use strict';
const path = require('path'), fs = require('fs'), { execSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const { fakeDb } = require('./lib/fake-firestore');
let pass = 0, fail = 0;
const ck = (id, ok, m, got) => { console.log('  ' + (ok ? 'PASS' : 'FAIL') + ' ' + id + ' ' + m + (ok || got === undefined ? '' : '   [got ' + JSON.stringify(got).slice(0, 220) + ']')); ok ? pass++ : fail++; };

let NAV = path.join(ROOT, 'functions', 'navigation.js');
if (process.env.BASE) {
  const tmp = path.join(ROOT, 'functions', '.navbase-' + process.pid + '.js');
  fs.writeFileSync(tmp, execSync('git show ' + process.env.BASE + ':functions/navigation.js', { cwd: ROOT }));
  process.on('exit', () => { try { fs.unlinkSync(tmp); } catch (_) {} });
  NAV = tmp;
}
let DB = fakeDb({});
const FN = path.join(ROOT, 'functions');
const realFS = require(require.resolve('firebase-admin/firestore', { paths: [FN] }));
const adminPath = require.resolve('firebase-admin', { paths: [FN] });
const fsFn = () => new Proxy({}, { get: (_, k) => (k === 'getAll' ? (...refs) => Promise.all(refs.map((r) => r.get())) : DB[k]) });
fsFn.FieldValue = realFS.FieldValue;
require.cache[adminPath] = { id: adminPath, filename: adminPath, loaded: true, exports: { firestore: fsFn, apps: [1], initializeApp() {}, auth: () => ({}) } };
const atPath = path.join(FN, 'sokoni-at.js');
require.cache[atPath] = { id: atPath, filename: atPath, loaded: true, exports: { atSendSMS: async () => ({}), secrets: [] } };
const N = require(NAV);
const run = async (fn, uid, data, token) => { try { return await N[fn].run({ auth: uid ? { uid, token: token || {} } : null, data }); } catch (e) { return { err: e.code || String(e.message).slice(0, 80), msg: e.message }; } };
const S = () => DB._store;

const ADMIN = { admin: true };
function world(order) {
  return {
    orders: { O1: Object.assign({ sellerUid: 'seller1', uid: 'buyer1', status: 'paid', paymentVerified: true, paymentStatus: 'paid', deliveryLat: -1.28, deliveryLng: 36.8, pickupLat: -1.29, pickupLng: 36.81 }, order || {}) },
    drivers: { rider1: { available: true, rating: 4.8 }, attacker: { available: false } },
    riderLocations: { rider1: { status: 'active', lat: -1.29, lng: 36.81 } },
  };
}

(async () => {
  console.log('\nnav dispatch authority   ' + (process.env.BASE ? 'BASE=' + process.env.BASE : 'this tree') + '\n');

  /* ── X: the live exploit, end to end ── */
  DB = fakeDb(world());
  let r = await run('navDispatchRider', 'attacker', { orderId: 'O1', manualRiderId: 'attacker' });
  const tripId = r && r.tripId || (Object.keys(S().trips || {})[0]);
  let c = tripId ? await run('navCompleteTrip', 'attacker', { tripId }) : { err: 'no-trip' };
  ck('X-1', S().orders.O1.status !== 'delivered' && S().orders.O1.riderId !== 'attacker',
    'EXPLOIT: a stranger cannot make themselves the rider on someone\'s order and mark it delivered (payout trigger)', { dispatch: r, complete: c, order: S().orders.O1 });
  ck('X-2', r && r.err === 'permission-denied' && !S().trips, 'a stranger\'s dispatch is refused before any trip is written', r);

  DB = fakeDb(world());
  r = await run('navDispatchRider', 'attacker', { orderId: 'O1' });
  ck('X-3', r && r.err === 'permission-denied' && !S().trips, "a stranger cannot even AUTO-dispatch someone else's order (the dispatch guard on its own)", r);

  /* ── D: dispatch authority ── */
  DB = fakeDb(world());
  r = await run('navDispatchRider', 'seller1', { orderId: 'O1', manualRiderId: 'attacker' });
  ck('D-1', r.err === 'permission-denied' && !S().trips, 'the SELLER cannot choose a specific rider (admin decision)', r);
  r = await run('navDispatchRider', 'seller1', { orderId: 'O1' });
  const t1 = Object.values(S().trips || {})[0] || {};
  ck('D-2', !r.err && t1.riderId === 'rider1' && t1.dispatchedBy === 'seller1' && t1.dispatchAuthority === 'seller' && S().orders.O1.riderId === 'rider1',
    'the seller CAN auto-dispatch their own paid order; the trip records the authority', { r, t1 });
  r = await run('navDispatchRider', 'seller1', { orderId: 'O1' });
  ck('D-3', r.err === 'failed-precondition', 'a second non-admin dispatch on an order that already has a rider is refused', r);
  DB = fakeDb(world({ paymentVerified: false, paymentStatus: 'pending', status: 'pending_payment' }));
  r = await run('navDispatchRider', 'seller1', { orderId: 'O1' });
  ck('D-4', r.err === 'failed-precondition' && !S().trips, 'an UNPAID order is not dispatched by the seller', r);
  DB = fakeDb(world({ status: 'delivered' }));
  r = await run('navDispatchRider', 'seller1', { orderId: 'O1' });
  ck('D-5', r.err === 'failed-precondition', 'a terminal (delivered) order is not re-dispatched', r);
  DB = fakeDb(world());
  r = await run('navDispatchRider', 'ops', { orderId: 'O1', manualRiderId: 'rider1' }, ADMIN);
  ck('D-6', !r.err && Object.values(S().trips)[0].dispatchAuthority === 'admin', 'an ADMIN can dispatch a chosen rider', r);
  DB = fakeDb(world());
  r = await run('navDispatchRider', 'ops', { orderId: 'O1', manualRiderId: 'ghost' }, ADMIN);
  ck('D-7', r.err === 'not-found', 'an admin\'s manual rider must exist', r);

  /* ── C: completion delivers only under authority ── */
  DB = fakeDb(world());
  await run('navDispatchRider', 'seller1', { orderId: 'O1' });
  let tid = Object.keys(S().trips)[0];
  r = await run('navCompleteTrip', 'rider1', { tripId: tid });
  ck('C-1', r.ok && r.orderDelivered === true && S().orders.O1.status === 'delivered', 'CONTROL: the dispatched rider completes the trip and the paid order is delivered (the payout rail still works)', r);
  DB = fakeDb(world());
  DB._store.trips = { T9: { orderId: 'O1', riderId: 'attacker', status: 'assigned', stops: [] } };   /* a LEGACY trip with no recorded authority */
  r = await run('navCompleteTrip', 'attacker', { tripId: 'T9' });
  ck('C-2', r.ok && r.orderDelivered === false && S().orders.O1.status !== 'delivered', 'a trip with no recorded dispatch authority completes WITHOUT delivering the order', r);
  DB = fakeDb(world({ riderId: 'attacker', tripId: 'T5' }));
  DB._store.trips = { T5: { orderId: 'O1', riderId: 'attacker', status: 'assigned', stops: [] } };   /* left by the OLD exploit: rider matches, no authority */
  r = await run('navCompleteTrip', 'attacker', { tripId: 'T5' });
  ck('C-2b', r.orderDelivered === false && S().orders.O1.status !== 'delivered', 'a trip with no recorded authority does not deliver even when its rider matches the order (the authority guard on its own)', r);
  DB = fakeDb(world({ riderId: 'rider1', assignedDriverUid: 'rider1' }));
  DB._store.trips = { T8: { orderId: 'O1', riderId: 'attacker', status: 'assigned', dispatchedBy: 'seller1', dispatchAuthority: 'seller', stops: [] } };
  r = await run('navCompleteTrip', 'attacker', { tripId: 'T8' });
  ck('C-3', r.orderDelivered === false && S().orders.O1.status !== 'delivered', 'a seller trip whose rider is not the order\'s rider does not deliver', r);
  DB = fakeDb(world({ paymentVerified: false, paymentStatus: 'pending', status: 'confirmed', riderId: 'rider1' }));
  DB._store.trips = { T7: { orderId: 'O1', riderId: 'rider1', status: 'assigned', dispatchedBy: 'ops', dispatchAuthority: 'admin', stops: [] } };
  r = await run('navCompleteTrip', 'rider1', { tripId: 'T7' });
  ck('C-4', r.orderDelivered === false && S().orders.O1.status === 'confirmed', 'an UNPAID order is never delivered by a trip (no payout on an unpaid order)', r);
  DB = fakeDb(world({ status: 'cancelled', riderId: 'rider1' }));
  DB._store.trips = { T6: { orderId: 'O1', riderId: 'rider1', status: 'assigned', dispatchedBy: 'ops', dispatchAuthority: 'admin', stops: [] } };
  r = await run('navCompleteTrip', 'rider1', { tripId: 'T6' });
  ck('C-5', r.orderDelivered === false && S().orders.O1.status === 'cancelled', 'a cancelled order stays cancelled', r);

  /* ── U: trip status updates never deliver ── */
  DB = fakeDb(world());
  await run('navDispatchRider', 'seller1', { orderId: 'O1' });
  tid = Object.keys(S().trips)[0];
  r = await run('navUpdateTripStatus', 'rider1', { tripId: tid, status: 'completed' });
  ck('U-1', S().orders.O1.status !== 'delivered', 'navUpdateTripStatus("completed") no longer flips the order to delivered', S().orders.O1.status);
  r = await run('navUpdateTripStatus', 'rider1', { tripId: tid, status: 'en_route_delivery' });
  ck('U-2', S().orders.O1.status === 'out_for_delivery', 'CONTROL: progress statuses still reach the order for its own rider', S().orders.O1.status);
  DB._store.trips.TX = { orderId: 'O1', riderId: 'attacker', status: 'assigned', stops: [] };
  const before = S().orders.O1.status;
  await run('navUpdateTripStatus', 'attacker', { tripId: 'TX', status: 'arrived_delivery' });
  ck('U-3', S().orders.O1.status === before, 'an unauthorised trip cannot move the order', S().orders.O1.status);

  /* ── P: proof-of-delivery path ── */
  DB = fakeDb(world());
  DB._store.trips = { TP: { orderId: 'O1', riderId: 'attacker', status: 'assigned', stops: [{ type: 'delivery', status: 'pending' }] } };
  r = await run('navSubmitPOD', 'attacker', { tripId: 'TP', stopIdx: 0, podType: 'photo', value: 'https://x/y.jpg' });
  ck('P-1', S().orders.O1.status !== 'delivered' && !Object.values(S().driverEarningQueue || {}).length, 'POD on an unauthorised trip neither delivers the order nor queues earnings', { r, q: S().driverEarningQueue });

  /* ── A: admin manual trip ── */
  DB = fakeDb(world());
  r = await run('navAssignTrip', 'ops', { riderId: 'rider1', orderId: 'O1', stops: [{ type: 'delivery', lat: 1, lng: 1 }] }, ADMIN);
  const ta = Object.values(S().trips || {})[0] || {};
  ck('A-1', ta.dispatchAuthority === 'admin' && ta.dispatchedBy === 'ops', 'an admin-created trip records its authority', ta);
  r = await run('navAssignTrip', 'seller1', { riderId: 'seller1', orderId: 'O1', stops: [{ type: 'delivery', lat: 1, lng: 1 }] });
  ck('A-2', r.err === 'permission-denied', 'CONTROL: navAssignTrip stays admin-only', r);

  console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('CRASH (no verdict): ' + (e && e.stack || e)); process.exit(2); });
