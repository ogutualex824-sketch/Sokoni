#!/usr/bin/env node
/* test-pos-loyalty-redemption.js — the till cannot mint or burn loyalty points (port of main's Q0a redemption rule).
 *
 *   node scripts/test-pos-loyalty-redemption.js                 # the fix — must PASS
 *   COUNTERPROOF=1 node scripts/test-pos-loyalty-redemption.js  # pos-zero-friction.js @ 4e9607b — failures ARE defects
 *
 * CALLS the REAL posCompleteCheckout (harness copied from test-pos-gate-behavioural.js: the real merchant-identity
 * authority, the documents it reads seeded; Firebase stubbed; no network, no production). The counterproof loads the
 * 4e9607b module from a temp file inside functions/ (so its relative requires resolve), always removed.
 *
 * PROVES
 *   L1  a NEGATIVE redemption is refused (invalid-argument) — before, −500 MINTED 500 points
 *   L2  non-numbers / fractions are refused ("5", NaN, true, 1.5, []) — before, they coerced or wrote NaN
 *   L3  a POSITIVE redemption is refused (failed-precondition) — before, it burned points while the total never moved
 *   L4  a customer.id that is not a single document id is refused
 *   L5  every refusal happens before anything is written (no sale, no points)
 *   L6  control: redemption 0 (or omitted) completes a normal sale — zero stays valid
 */
'use strict';
const fs = require('fs');
const cp = require('child_process');
const path = require('path');
const Module = require('module');
const ROOT = path.resolve(__dirname, '..');
const FN = path.join(ROOT, 'functions');
const CPM = !!process.env.COUNTERPROOF;

let pass = 0, fail = 0;
const ck = (label, ok, detail) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + label + (detail !== undefined && detail !== '' ? '   [' + String(typeof detail === 'object' ? JSON.stringify(detail) : detail).slice(0, 160) + ']' : '')); ok ? pass++ : fail++; };
class HttpsError extends Error { constructor(code, message, details) { super(message); this.code = code; this.details = details; } }
const CTL = { membershipOk: false, liabilities: [], ledgerUnreadable: false, shopsUnreadable: false };
const DOCS = new Map();
let AUTO = 0;
const FieldValue = { serverTimestamp: () => 'TS', increment: (n) => ({ __inc: n }) };

function makeDb() {
  const mk = (name, filters) => ({
    doc(id) {
      /* like Firestore: doc() with no id auto-generates one (the checkout's saleId is db.collection('_').doc().id) */
      if (id === undefined) id = 'auto_' + (++AUTO);
      const key = name + '/' + id;
      return { _key: key, id,
        async get() { const d = DOCS.get(key); return { exists: !!d, id, data: () => (d ? Object.assign({}, d) : undefined) }; },
        async set(v) { DOCS.set(key, Object.assign({}, DOCS.get(key) || {}, v)); },
        async create(v) { if (DOCS.has(key)) { const e = new Error('ALREADY_EXISTS'); e.code = 6; throw e; } DOCS.set(key, Object.assign({}, v)); },
        async update(v) { DOCS.set(key, Object.assign({}, DOCS.get(key) || {}, v)); } };
    },
    where(f, _op, v) { return mk(name, filters.concat([[f, v]])); }, orderBy() { return this; }, limit() { return this; },
    async get() { const rows = name === 'posCommissionLiabilities' ? CTL.liabilities : []; const kept = rows.filter((r) => filters.every(([f, v]) => r[f] === v));
      return { docs: kept.map((r, i) => ({ id: 'L' + i, data: () => r })), empty: kept.length === 0, forEach(cb) { kept.forEach((r, i) => cb({ id: 'L' + i, data: () => r })); } }; },
  });
  return { collection: (n) => mk(n, []),
    async runTransaction(fn) { const w = []; const t = { async get(r) { return r.get(); }, set(r, v) { w.push([r._key, v]); }, update(r, v) { w.push([r._key, v]); }, create(r, v) { w.push([r._key, v]); } };
      const out = await fn(t); for (const [k, v] of w) DOCS.set(k, Object.assign({}, DOCS.get(k) || {}, v)); return out; } };
}
const DB = makeDb();

let tmp = null;
let file = path.join(FN, 'pos-zero-friction.js');
if (CPM) {
  tmp = path.join(FN, '.cp-' + process.pid + '-pos-zero-friction.js');
  fs.writeFileSync(tmp, cp.execFileSync('git', ['show', '4e9607b:functions/pos-zero-friction.js'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64e6 }));
  file = tmp;
}
const cleanup = () => { if (tmp) { try { fs.unlinkSync(tmp); } catch (_) {} } };
const orig = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === 'firebase-admin/firestore') return { getFirestore: () => DB, FieldValue, Timestamp: { now: () => ({ toMillis: () => Date.now() }) } };
  if (id === 'firebase-admin') return { apps: [1], initializeApp: () => {}, auth: () => ({}), firestore: Object.assign(() => DB, { FieldValue, Timestamp: { now: () => ({ toMillis: () => Date.now() }) } }) };
  if (id === 'firebase-functions/v2/https') return { onCall: (_o, h) => h, HttpsError };
  if (id === 'firebase-functions/v2/scheduler') return { onSchedule: (_o, h) => h };
  if (id === 'firebase-functions/v2/firestore') return { onDocumentWritten: (_o, h) => h, onDocumentCreated: (_o, h) => h, onDocumentUpdated: (_o, h) => h };
  if (id === 'firebase-functions/logger') return { info() {}, warn() {}, error() {}, debug() {} };
  if (id === 'firebase-functions/params') return { defineSecret: (n) => ({ name: n, value: () => '0' }) };
  if (id === './pos-audit') return { writeAudit: () => {} };
  if (id === './workforce-identity') return { _assertBusinessPermission: async () => { if (!CTL.membershipOk) throw new HttpsError('permission-denied', 'no membership'); return true; } };
  if (id === './tenant-identity') return { resolveMerchantIdForOwner: async () => ({ ok: false }) };
  return orig.apply(this, arguments);
};
let ZF, loadErr = null;
try { ZF = require(file); } catch (e) { loadErr = e; }
Module.prototype.require = orig;

const MERCHANT = 'SHOP_KASS_001';
let keySeq = 0;
function reset() {
  DOCS.clear(); CTL.membershipOk = false; CTL.liabilities = [];
  DOCS.set('shops/' + MERCHANT, { name: 'KASS Shop' });
  DOCS.set('users/' + MERCHANT, { displayName: 'Owner Ann' });
  DOCS.set('businesses/' + MERCHANT, { ownerId: 'SOMEONE_ELSE' });
  DOCS.set('products/P1', { name: 'Rice', price: 100, stock: 50, trackInventory: true, shopId: MERCHANT, sellerUid: MERCHANT });
  DOCS.set('posCustomers/' + MERCHANT + '_254700000001', { sellerId: MERCHANT, phone: '254700000001', loyaltyPoints: 100 });
}
const CUST = { id: MERCHANT + '_254700000001', phone: '254700000001' };
const call = async (over) => {
  try {
    const r = await ZF.posCompleteCheckout({ data: Object.assign({ idempotencyKey: 'IK_' + (++keySeq), merchantId: MERCHANT,
      items: [{ productId: 'P1', qty: 1, unitPrice: 100 }], subtotal: 100, grandTotal: 100, discountTotal: 0, taxTotal: 0,
      payments: [{ method: 'cash', amount: 100 }] }, over), auth: { uid: MERCHANT, token: { posRole: 'cashier' } } });
    return { ok: true, result: r };
  } catch (e) { return { ok: false, code: e && e.code, message: e && e.message }; }
};
const sales = () => [...DOCS.keys()].filter((k) => k.indexOf('posRetailSales/') === 0).length;
const points = () => (DOCS.get('posCustomers/' + CUST.id) || {}).loyaltyPoints;

(async () => {
  try {
    console.log('\nSOURCE: pos-zero-friction.js @ ' + (CPM ? '4e9607b (before) — failures below ARE the defects' : 'working tree (fix)'));
    ck('L0  pos-zero-friction loads', !loadErr, loadErr && loadErr.message);
    if (loadErr) { console.log('\nCANNOT PROCEED — refusing to report vacuous results.\n'); process.exit(2); }

    reset();
    const neg = await call({ customer: CUST, loyaltyRedeemPoints: -500 });
    ck('L1  a NEGATIVE redemption is refused (invalid-argument)', !neg.ok && neg.code === 'invalid-argument' && /loyaltyRedeemPoints/.test(neg.message || ''), { ok: neg.ok, code: neg.code, points: points() });

    const bad = [];
    for (const v of ['5', NaN, true, 1.5, []]) { reset(); const r = await call({ customer: CUST, loyaltyRedeemPoints: v }); if (r.ok || r.code !== 'invalid-argument') bad.push(String(v) + '→' + (r.ok ? 'ACCEPTED pts=' + points() : r.code)); }
    ck('L2  non-numbers / fractions are refused ("5", NaN, true, 1.5, [])', bad.length === 0, bad);

    reset();
    const pos = await call({ customer: CUST, loyaltyRedeemPoints: 50 });
    ck('L3  a POSITIVE redemption is refused (failed-precondition)', !pos.ok && pos.code === 'failed-precondition' && /cannot be redeemed/.test(pos.message || ''), { ok: pos.ok, code: pos.code, points: points() });

    reset();
    const slash = await call({ customer: { id: 'x/../other', phone: '254700000001' } });
    ck('L4  a customer.id that is not a single document id is refused', !slash.ok && slash.code === 'invalid-argument' && /customer\.id/.test(slash.message || ''), { ok: slash.ok, code: slash.code });

    reset();
    await call({ customer: CUST, loyaltyRedeemPoints: -500 });
    ck('L5  a refusal writes nothing (no sale, points unchanged)', sales() === 0 && points() === 100, { sales: sales(), points: points() });

    reset();
    const zero = await call({ customer: CUST, loyaltyRedeemPoints: 0 });
    const zeroSale = sales();
    reset();
    const omitted = await call({ customer: CUST });
    ck('L6  control: redemption 0 / omitted completes a normal sale', zero.ok && omitted.ok && zeroSale === 1 && sales() === 1, { zero: zero.ok ? 'ok' : zero.code + ' ' + zero.message, omitted: omitted.ok ? 'ok' : omitted.code });
  } finally { cleanup(); }
  console.log(`\n${pass} passed, ${fail} failed`);
  if (CPM) console.log('(counter-proof: failures here ARE the defects; L0 and L6 are controls and must pass in both modes)');
  process.exit(fail ? 1 : 0);
})().catch((e) => { cleanup(); console.log('CRASH ' + (e && e.stack || e)); process.exit(2); });
