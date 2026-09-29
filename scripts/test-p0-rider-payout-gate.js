/* test-p0-rider-payout-gate.js — P0 rider-payout self-credit, SERVER half of a paired change.
 *
 * The finding (2026-09-29, emulator-proven): onOrderStatusChange credited the rider wallet on ANY
 * transition to `delivered` — no payment check, no delivery proof, no check the rider was real or
 * assigned. A client-made order naming itself seller + rider, marked delivered by its "seller",
 * paid KES 88,000 of a 100,000 fee. The gate now requires server-only facts before crediting.
 *
 * Drives the REAL functions (completeDeliveryWithPin, buyerConfirmDelivery, onOrderStatusChange)
 * from FUNCTIONS_DIR (default: ../functions) against the Firestore emulator. Orders are seeded as
 * server flows would seed them; the trigger is invoked with the exact before/after documents.
 *   FUNCTIONS_DIR=functions firebase emulators:exec --only firestore --project demo-p0gate \
 *     "node scripts/test-p0-rider-payout-gate.js"
 * Point FUNCTIONS_DIR at a pre-fix tree too: the P0 rows must FAIL there.
 */
'use strict';
const path = require('path'), crypto = require('crypto');
if (!process.env.FIRESTORE_EMULATOR_HOST) { console.log('CRASH needs FIRESTORE_EMULATOR_HOST (never run against production)'); process.exit(2); }
if (!/^demo-/.test(process.env.GCLOUD_PROJECT || '')) { console.log('CRASH needs a demo-* GCLOUD_PROJECT'); process.exit(2); }
process.env.SOKONI_HMAC_KEY = process.env.SOKONI_HMAC_KEY || 'p0-test-hmac-key-not-a-secret';
process.env.FUNCTIONS_EMULATOR = 'true';
const FN_DIR = path.resolve(process.env.FUNCTIONS_DIR || path.join(__dirname, '..', 'functions'));
let pass = 0, fail = 0;
const ck = (label, ok, got) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + label + (ok ? '' : '   [got ' + got + ']')); ok ? pass++ : fail++; };

(async () => {
  console.log('\nFUNCTIONS: ' + FN_DIR);
  const mod = require(path.join(FN_DIR, 'index.js'));
  const admin = require(require.resolve('firebase-admin', { paths: [FN_DIR] }));
  const db = admin.firestore();
  const trig = mod.onOrderStatusChange, pinFn = mod.completeDeliveryWithPin, buyFn = mod.buyerConfirmDelivery;
  for (const c of await db.listCollections()) { const s = await c.get(); await Promise.all(s.docs.map(d => d.ref.delete())); }
  const snapOf = async (id) => (await db.collection('orders').doc(id).get()).data();
  const fire = (id, before, after) => trig.run({ data: { before: { data: () => before }, after: { data: () => after } }, params: { orderId: id } });
  const credit = async (rider, id) => { const t = await db.collection('walletTransactions').doc(`${rider}_${id}_delivery`).get(); return t.exists ? t.get('amount') : 0; };
  const bal = async (rider) => { const w = await db.collection('wallets').doc(rider).get(); return w.exists ? (w.get('balance') || 0) : 0; };
  const hmac = (pkg, pin) => crypto.createHmac('sha256', process.env.SOKONI_HMAC_KEY).update(pkg + '|' + pin).digest('hex');
  const A = 'attackerA', B = 'buyerB', S = 'sellerS', RID = 'riderOk1', RID2 = 'riderOk2', RNA = 'riderNotApproved';
  await db.collection('drivers').doc(RID).set({ uid: RID, approved: true, status: 'approved' });
  await db.collection('drivers').doc(RID2).set({ uid: RID2, approved: true, status: 'approved' });
  let n = 0;
  const order = async (over = {}, rider = RID) => {
    const id = 'o' + (++n), pkg = 'DEL' + id;
    over = Object.fromEntries(Object.entries(over).filter(([, v]) => v !== undefined));
    await db.collection('orders').doc(id).set(Object.assign({ uid: B, buyerUid: B, sellerUid: S, assignedDriverUid: rider, riderId: rider, deliveryFee: 1000,
      paymentVerified: true, paidAmount: 5000, status: 'in_transit', packageRequestId: pkg, deliveryRef: pkg }, over));
    await db.collection('packageRequests').doc(pkg).set({ orderId: id, assignedDriverUid: rider, riderId: rider, deliveryPinHash: hmac(pkg, '123456'), status: 'in_transit' });
    return { id, pkg };
  };
  const step = async (o, fn) => { const before = await snapOf(o.id); let err = null; try { await fn(); } catch (e) { err = e.code || e.message; }
    const after = await snapOf(o.id); if (before.status !== after.status) await fire(o.id, before, after); return err; };
  const viaPin = (o, caller, pin) => step(o, () => pinFn.run({ auth: { uid: caller }, data: { deliveryRef: o.pkg, pin } }));
  const viaBuyer = (o, caller) => step(o, () => buyFn.run({ auth: { uid: caller }, data: { orderId: o.id } }));
  const rawDelivered = async (o) => { const before = await snapOf(o.id); await db.collection('orders').doc(o.id).set({ status: 'delivered' }, { merge: true }); await fire(o.id, before, await snapOf(o.id)); };

  console.log('\n── P0: refused ──');
  { const o = await order({ uid: A, buyerUid: A, sellerUid: A, assignedDriverUid: A, riderId: A, deliveryFee: 100000, paymentVerified: undefined, paidAmount: undefined, status: 'pending' }, A);
    await rawDelivered(o); const c = await credit(A, o.id); ck('G1  self-made order, seller-set delivered → no credit', c === 0, c); }
  { const o = await order({}, RNA); await viaPin(o, RNA, '123456'); const c = await credit(RNA, o.id); ck('G2  rider not an approved driver, valid PIN → no credit', c === 0, c); }
  { const o = await order(); await rawDelivered(o); const c = await credit(RID, o.id); ck('G3  assigned rider, delivered without proof → no credit', c === 0, c); }
  { const o = await order(); const e = await viaPin(o, RID, '999999'); const c = await credit(RID, o.id); ck('G4  invalid PIN → refused, no credit', !!e && c === 0, e + '/' + c); }
  { const o = await order(); const e = await viaPin(o, RID2, '123456'); const c = (await credit(RID, o.id)) + (await credit(RID2, o.id)); ck('G5  wrong rider with correct PIN → refused, no credit', !!e && c === 0, e + '/' + c); }
  { const o = await order({ paymentVerified: false, status: 'confirmed' }); await viaBuyer(o, B); const c = await credit(RID, o.id); ck('G6  unpaid order, buyer confirmation → no credit', c === 0, c); }
  { const o = await order({ sellerUid: RID }); await viaPin(o, RID, '123456'); const c = await credit(RID, o.id); ck('G7  rider is the seller → no credit', c === 0, c); }
  { const o = await order({ deliveryAuthorizedBy: 'buyer_confirmation' }); await rawDelivered(o); const c = await credit(RID, o.id); ck('G8  proof pre-seeded before the transition → no credit', c === 0, c); }
  { const o = await order({ deliveryFee: 9000, paidAmount: 5000 }); await viaPin(o, RID, '123456'); const c = await credit(RID, o.id); ck('G9  fee exceeds server paidAmount → no credit', c === 0, c); }
  { const o = await order({}, RID); await db.collection('packageRequests').doc(o.pkg).set({ assignedDriverUid: RID2, riderId: RID2 }, { merge: true });
    await viaPin(o, RID2, '123456'); const c = (await credit(RID, o.id)) + (await credit(RID2, o.id)); ck('G10 PIN proven by another rider than the credited one → no credit', c === 0, c); }
  { const fees = (await db.collection('deliveryFees').where('status', '==', 'withheld').get()).size; ck('G11 each refusal is recorded as deliveryFees "withheld"', fees >= 7, fees); }

  console.log('\n── legitimate payouts preserved ──');
  let pinOrder;
  { const o = await order(); pinOrder = o; const e = await viaPin(o, RID, '123456'); const c = await credit(RID, o.id); ck('L1  valid rider PIN → credited once (880 of 1000 at the hub rate)', !e && c === 880, e + '/' + c); }
  { const o = await order(); const e = await viaBuyer(o, B); const c = await credit(RID, o.id); ck('L2  valid buyer confirmation → credited once', !e && c === 880, e + '/' + c); }
  { const b0 = await bal(RID); await viaPin(pinOrder, RID, '123456'); const snap = await snapOf(pinOrder.id);
    await fire(pinOrder.id, Object.assign({}, snap, { status: 'in_transit', deliveryAuthorizedBy: null }), snap);
    const d = (await bal(RID)) - b0; ck('L3  repeated completion + re-fired event → no second credit', d === 0, d); }
  { const o = await order({ paidAmount: undefined }); const e = await viaPin(o, RID, '123456'); const c = await credit(RID, o.id); ck('L4  paid order without a recorded paidAmount → still credited', !e && c === 880, e + '/' + c); }

  console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('CRASH ' + (e && e.stack)); process.exit(2); });
