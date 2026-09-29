/* test-erp-update-tenant-scope.js — 2026-09-29: posReceiveErpUpdate may only touch documents that belong to the
 * seller its API key is pinned to.
 *
 * Found in the U7 census: the handler proved the KEY belonged to body.sellerId, then updated
 * posPurchaseOrders/{body.poId} and orders/{body.orderId} without checking either belonged to that seller — so any
 * merchant's write-enabled key could mark another shop's purchase order received or rewrite another shop's order.
 *
 * REAL functions/pos-integrations-api.js posReceiveErpUpdate (the HTTP handler), over the fake Firestore.
 *
 * PROVES
 *   ER1 own purchase order → received; own order → erpStatus written (positive controls)
 *   ER2 another shop's purchase order is refused and left untouched
 *   ER3 another shop's order is refused and left untouched
 *   ER4 a missing document and a foreign document give the SAME answer (no id probing)
 *   ER5 an erpStatus outside the fixed list is refused; a path-shaped id is refused
 *
 *   node scripts/test-erp-update-tenant-scope.js
 */
'use strict';
process.env.GCLOUD_PROJECT = 'demo-erp-scope';
delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
const path = require('path'), Module = require('module'), crypto = require('crypto');
const ROOT = path.resolve(__dirname, '..'), FN = path.join(ROOT, 'functions');
const { makeFakeFirestore } = require('./lib/fake-firestore-txn');
const F = makeFakeFirestore({ clock: () => Date.now() }); const db = F.db;
const say = console.log; console.log = console.info = console.warn = console.error = console.debug = () => {};
let pass = 0, fail = 0;
const ck = (l, ok, d) => { say('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined && d !== '' ? '   [' + String(typeof d === 'object' ? JSON.stringify(d) : d).slice(0, 300) + ']' : '')); ok ? pass++ : fail++; };
class HttpsError extends Error { constructor(c, m) { super(m); this.code = c; } }
const firestoreFn = Object.assign(() => db, { FieldValue: F.FieldValue, Timestamp: F.Timestamp, FieldPath: F.FieldPath });
const ADMIN = { apps: [{}], initializeApp: () => ({}), app: () => ({}), firestore: firestoreFn, auth: () => ({}) };
const origReq = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === 'firebase-admin') return ADMIN;
  if (id === 'firebase-admin/firestore') return { getFirestore: () => db, FieldValue: F.FieldValue, Timestamp: F.Timestamp };
  if (id === 'firebase-functions/v2/https') return { onCall: (_o, h) => (h || _o), onRequest: (_o, h) => (h || _o), HttpsError };
  if (id === 'firebase-functions/v2/scheduler') return { onSchedule: (_o, h) => h };
  if (id === 'firebase-functions/logger') return { info() {}, warn() {}, error() {}, debug() {} };
  if (id === 'firebase-functions/params') return { defineSecret: (n) => ({ name: n, value: () => '0' }) };
  return origReq.apply(this, arguments);
};
let API; try { API = require(path.join(FN, 'pos-integrations-api.js')); } catch (e) { API = { __err: e.message }; }
const get = async (p) => { const s = await db.doc(p).get(); return s.exists ? s.data() : null; };

const KEY = 'sk_test_A';
async function call(body) {
  const res = { code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; }, set() { return this; }, send(b) { this.body = b; return this; } };
  await API.posReceiveErpUpdate({ method: 'POST', headers: { authorization: 'Bearer ' + KEY }, body, query: {} }, res);
  return res;
}

(async () => {
  if (typeof API.posReceiveErpUpdate !== 'function') { ck('ER0 the handler loads', false, API.__err); say(`\n${pass} passed, ${fail} failed`); process.exit(1); }
  await db.doc('posApiKeys/k1').set({ keyHash: crypto.createHash('sha256').update(KEY).digest('hex'), active: true, sellerId: 'sellerA', permissions: ['read', 'write'], name: 'ERP A' });
  await db.doc('posPurchaseOrders/poA').set({ sellerId: 'sellerA', status: 'ordered' });
  await db.doc('posPurchaseOrders/poB').set({ sellerId: 'sellerB', status: 'ordered' });
  await db.doc('orders/ordA').set({ sellerUid: 'sellerA', status: 'paid' });
  await db.doc('orders/ordB').set({ sellerUid: 'sellerB', status: 'paid' });

  const r1 = await call({ sellerId: 'sellerA', type: 'po_received', poId: 'poA' });
  const r2 = await call({ sellerId: 'sellerA', type: 'fulfilment_update', orderId: 'ordA', status: 'shipped' });
  const poA = await get('posPurchaseOrders/poA'), ordA = await get('orders/ordA');
  ck('ER1 own purchase order → received; own order → erpStatus (controls)',
    r1.code === 200 && poA.status === 'received' && r2.code === 200 && ordA.erpStatus === 'shipped', { r1: r1.code, po: poA.status, r2: r2.code, erp: ordA.erpStatus });

  const r3 = await call({ sellerId: 'sellerA', type: 'po_received', poId: 'poB' });
  const poB = await get('posPurchaseOrders/poB');
  ck('ER2 another shop\'s purchase order is refused and untouched', r3.code !== 200 && poB.status === 'ordered' && poB.erpUpdateId === undefined, { code: r3.code, body: r3.body, status: poB.status });

  const r4 = await call({ sellerId: 'sellerA', type: 'fulfilment_update', orderId: 'ordB', status: 'cancelled' });
  const ordB = await get('orders/ordB');
  ck('ER3 another shop\'s order is refused and untouched', r4.code !== 200 && ordB.erpStatus === undefined, { code: r4.code, body: r4.body, erp: ordB.erpStatus });

  const r5 = await call({ sellerId: 'sellerA', type: 'fulfilment_update', orderId: 'nope', status: 'shipped' });
  ck('ER4 a missing document and a foreign document give the same answer', r5.code === r4.code && JSON.stringify(r5.body) === JSON.stringify(r4.body), { missing: r5.body, foreign: r4.body });

  const r6 = await call({ sellerId: 'sellerA', type: 'fulfilment_update', orderId: 'ordA', status: '<script>' });
  const r7 = await call({ sellerId: 'sellerA', type: 'po_received', poId: 'poA/../poB' });
  const ordA2 = await get('orders/ordA');
  ck('ER5 an unlisted erpStatus and a path-shaped id are refused', r6.code !== 200 && ordA2.erpStatus === 'shipped' && r7.code !== 200, { r6: r6.code, r7: r7.code });

  say(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { say('CRASH ' + (e && e.stack || e)); process.exit(2); });
