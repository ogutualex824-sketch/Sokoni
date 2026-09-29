/* test-p0-rider-payout-rules.js — P0 rider-payout self-credit, RULES half of a paired change.
 *
 * The finding (2026-09-29, emulator-proven): an ordinary client created an order naming itself
 * seller + rider with any deliveryFee, set it `delivered` through the seller branch of the
 * orders rule, and onOrderStatusChange credited ~88% of the fee to its withdrawable wallet
 * (KES 88,000 from a 100,000 fee). The server half gates the credit on server-only facts; this
 * half closes the client write path. The two are independent — either alone refuses the attack.
 *
 * Emulator-backed; ruleset = RULES_FILE (use firestore.rules.build — the deployed artifact).
 *   RULES_FILE=firestore.rules.build firebase emulators:exec --only firestore --project demo-p0rules \
 *     "node scripts/test-p0-rider-payout-rules.js"
 * Run it against the pre-fix baseline too (git show ad5ef6d:firestore.rules.build): the P0 rows
 * must FAIL there, or this suite is not testing the change.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { initializeTestEnvironment, assertFails, assertSucceeds } = require(require.resolve('@firebase/rules-unit-testing', { paths: [process.cwd(), path.resolve(__dirname, '..')] }));
const RULES = process.env.RULES_FILE;
const HOST = process.env.FIRESTORE_EMULATOR_HOST || '';
if (!RULES || !HOST) { console.log('CRASH needs RULES_FILE and FIRESTORE_EMULATOR_HOST'); process.exit(2); }
const [host, port] = HOST.split(':');
let pass = 0, fail = 0;
const ck = async (label, p, allowed) => { let ok; try { await (allowed ? assertSucceeds(p) : assertFails(p)); ok = true; } catch (_) { ok = false; } console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + label); ok ? pass++ : fail++; };
(async () => {
  const text = fs.readFileSync(path.resolve(RULES), 'utf8');
  console.log('\nRULES: ' + path.basename(RULES) + ' (' + Buffer.byteLength(text) + ' B)');
  const env = await initializeTestEnvironment({ projectId: 'demo-p0rules', firestore: { rules: text, host, port: Number(port) } });
  await env.clearFirestore();   /* creates must be creates: leftover docs would be evaluated as updates */
  const seed = (id, d) => env.withSecurityRulesDisabled(async (c) => { await c.firestore().doc('orders/' + id).set(d); });
  const A = 'attackerA', S = 'sellerS', B = 'buyerB';
  const a = env.authenticatedContext(A, { deactivated: false }).firestore();
  const t = { toMillis: () => 0 };
  console.log('\n── P0: the attack path is closed ──');
  await ck('P1  create order naming self as seller AND rider with a fee', a.doc('orders/p1').set({ uid: A, buyerUid: A, sellerUid: A, assignedDriverUid: A, deliveryFee: 100000, status: 'pending' }), false);
  await ck('P2  create order with a non-null riderId', a.doc('orders/p2').set({ uid: A, buyerUid: A, sellerUid: S, riderId: A, status: 'pending' }), false);
  await ck('P3  create order carrying a pre-filled delivery proof', a.doc('orders/p3').set({ uid: A, buyerUid: A, sellerUid: S, deliveryAuthorizedBy: 'rider_pin', status: 'pending' }), false);
  await ck('P4  create order carrying deliveryAuthorizedActor', a.doc('orders/p4').set({ uid: A, buyerUid: A, sellerUid: S, deliveryAuthorizedActor: A, status: 'pending' }), false);
  await ck('P5  create order carrying deliveredAt', a.doc('orders/p5').set({ uid: A, buyerUid: A, sellerUid: S, deliveredAt: 1, status: 'pending' }), false);
  await seed('s1', { uid: B, buyerUid: B, sellerUid: A, status: 'confirmed' });
  await ck('P6  seller marks an order delivered', a.doc('orders/s1').update({ status: 'delivered', updatedAt: 1 }), false);
  await ck('P7  seller marks an order completed', a.doc('orders/s1').update({ status: 'completed', updatedAt: 1 }), false);
  console.log('\n── legitimate flows are preserved ──');
  await ck('L1  checkout pre-write shape (_ckPersistPendingOrder): sellerUid, deliveryFee, pending_payment',
    a.doc('orders/l1').set({ orderId: 'l1', uid: A, buyerUid: A, sellerUid: S, sellerName: 'Shop', items: [], subtotal: 500, deliveryFee: 150, total: 650, orderTotal: 650, status: 'pending_payment', hub: 'marketplace', pricing: { subtotal: 500, deliveryFee: 150, total: 650 }, statusHistory: [] }), true);
  await ck('L2  sokoni-orders createOrder shape: assignedDriverUid null, driverNet', a.doc('orders/l2').set({ id: 'l2', uid: A, buyerUid: A, sellerUid: S, items: [], orderTotal: 500, deliveryFee: 150, deliveryComm: 18, driverNet: 132, assignedDriverUid: null, status: 'pending_payment', statusHistory: [] }), true);
  await ck('L3  seller moves an order to processing', a.doc('orders/s1').update({ status: 'processing', updatedAt: 1 }), true);
  await ck('L4  seller moves an order to shipped', a.doc('orders/s1').update({ status: 'shipped', updatedAt: 1 }), true);
  await seed('b1', { uid: A, buyerUid: A, sellerUid: S, status: 'pending_payment' });
  await ck('L5  buyer cancels their own order', a.doc('orders/b1').update({ status: 'cancelled', updatedAt: 1 }), true);
  await seed('r1', { uid: B, buyerUid: B, sellerUid: S, assignedDriverUid: A, status: 'in_transit' });
  await ck('L6  assigned rider moves to picked_up', a.doc('orders/r1').update({ status: 'picked_up', updatedAt: 1 }), true);
  await ck('L7  assigned rider still CANNOT set delivered (existing control kept)', a.doc('orders/r1').update({ status: 'delivered', updatedAt: 1 }), false);
  await env.cleanup();
  console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('CRASH ' + (e && e.message)); process.exit(2); });
