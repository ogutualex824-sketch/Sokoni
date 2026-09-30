#!/usr/bin/env node
/**
 * posSyncToMarketplace — WHO may move a shop's inventory (security slice, 2026-09-30).
 *
 * Before: the only gate was `request.auth`, so ANY signed-in account could move ANY product's stock and soldCount,
 * and the idempotency record was keyed by saleId ALONE, so anyone could claim another shop's sale id first and that
 * shop's real sync was dropped as a "duplicate".
 *
 * The invariants (owner, 2026-09-30):
 *   - shop-employees.resolveShopAccess is THE authorization authority (owner / corroborated employee / admin, from data)
 *   - product ownership comes from the STORED product (shopId || sellerUid) — never from saleId, branchId or items
 *   - a mixed-shop sale is REJECTED WHOLE — nothing partially moved
 *   - the idempotency key is shop + sale
 *
 *   PO1 the shop's owner syncs a sale: metered stock 10 → 7, soldCount +3, an unmetered service moves counters only;
 *       the claim is keyed shop + sale
 *   PO2 the same sync again is idempotent: duplicate, nothing moves twice
 *   PO3 a corroborated cashier of the shop syncs: allowed
 *   PO4 a stranger (signed in, no relation to the shop) → permission-denied; ZERO mutation, no claim
 *   PO5 an employee of ANOTHER shop syncing this shop's product → refused; zero mutation
 *   PO6 a FORGED employee record (it names the forger as the shop's owner; the shop document disagrees) → refused
 *   PO7 a MIXED-shop sale by this shop's owner (own product + another shop's) → the WHOLE sync refused; even the
 *       owner's own item does not move; no claim
 *   PO8 the sale-id reservation race: another shop claims sale id S for itself, and a legacy saleId-only claim of S
 *       exists — this shop's real sync of S still applies
 *   PO9 a corroborated employee whose role cannot sell (inventory) → refused
 *   PO10 a platform admin (claims) → allowed
 *
 * Real modules (pos-retail, shop-employees, shared/sellability) over the transactional fake Firestore. No network.
 *   node scripts/test-possync-ownership.js
 */
'use strict';
process.env.GCLOUD_PROJECT = 'demo-possync-ownership';
delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
const path = require('path'), Module = require('module');
const ROOT = path.resolve(__dirname, '..'), FN = path.join(ROOT, 'functions');
const { makeFakeFirestore } = require('./lib/fake-firestore-txn');
const F = makeFakeFirestore({ clock: () => Date.now() }); const db = F.db;
const say = console.log; console.log = console.info = console.warn = console.error = console.debug = () => {};
let pass = 0, fail = 0;
const ck = (l, ok, d) => { say('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined && d !== '' ? '   [' + String(typeof d === 'object' ? JSON.stringify(d) : d).slice(0, 400) + ']' : '')); ok ? pass++ : fail++; };
class HttpsError extends Error { constructor(c, m, d) { super(m); this.code = c; this.details = d; } }
const CLAIMS = { admin1: { admin: true } };
const authApi = { getUser: async (uid) => ({ uid, customClaims: CLAIMS[uid] || {} }) };
const ADMIN = { apps: [{}], initializeApp: () => ({}), app: () => ({}), firestore: Object.assign(() => db, { FieldValue: F.FieldValue, Timestamp: F.Timestamp, FieldPath: F.FieldPath }), auth: () => authApi, messaging: () => ({ send: async () => ({}) }) };
const onCallStub = (_o, h) => (h || _o);
const origReq = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === 'firebase-admin/firestore') return { getFirestore: () => db, FieldValue: F.FieldValue, Timestamp: F.Timestamp, FieldPath: F.FieldPath };
  if (id === 'firebase-admin/auth') return { getAuth: () => authApi };
  if (id === 'firebase-admin') return ADMIN;
  if (id === 'firebase-functions/v2/https') return { onCall: onCallStub, onRequest: onCallStub, HttpsError };
  if (id === 'firebase-functions/v2') return { scheduler: { onSchedule: (_o, h) => h }, firestore: { onDocumentUpdated: (_o, h) => h, onDocumentCreated: (_o, h) => h }, https: { onCall: onCallStub, HttpsError } };
  if (id === 'firebase-functions/v2/scheduler') return { onSchedule: (_o, h) => h };
  if (id === 'firebase-functions/v2/firestore') return { onDocumentWritten: (_o, h) => h, onDocumentCreated: (_o, h) => h, onDocumentUpdated: (_o, h) => h };
  if (id === 'firebase-functions/logger' || id === 'firebase-functions') return { logger: { info() {}, warn() {}, error() {} }, info() {}, warn() {}, error() {}, debug() {} };
  if (id === 'firebase-functions/params') return { defineSecret: (n) => ({ name: n, value: () => 'test-secret' }), defineString: () => ({ value: () => '' }), defineInt: () => ({ value: () => 0 }) };
  if (id === './company-identity') return { COMPANY: { name: 'SOKONI' } };
  if (id === './sokoni-at') return new Proxy({}, { get: (_, k) => (k === 'secrets' ? [] : () => { throw new Error('SMS must never be sent by a test'); }) });
  return origReq.apply(this, arguments);
};
const load = (p) => { try { return require(p); } catch (e) { return { __err: e.message }; } };
const PR = load(path.join(FN, 'pos-retail.js'));
const get = async (p) => { const s = await db.doc(p).get(); return s.exists ? s.data() : null; };
const all = async (c) => (await db.collection(c).get()).docs.map((d) => Object.assign({ id: d.id }, d.data()));
const out = async (p) => { try { return { ok: await p }; } catch (e) { return { err: e.code || 'error', msg: String(e.message) }; } };
const has = (o, k) => !!o && Object.prototype.hasOwnProperty.call(o, k);
const sync = (uid, saleId, items) => PR.posSyncToMarketplace({ auth: { uid, token: {} }, data: { branchId: 'main', saleId, items } });
const P = (id, shop, d) => db.doc('products/' + id).set(Object.assign({ name: id, price: 100, shopId: shop, sellerUid: shop, status: 'active' }, d || {}));
/* the state a refusal must leave untouched: stock, soldCount and claims */
const snap = async () => ({ paper: await get('products/paper'), print: await get('products/print'), mugB: await get('products/mugB'), claims: (await all('posSyncIdempotency')).map((c) => c.id).sort() });
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

(async () => {
  if (typeof PR.posSyncToMarketplace !== 'function') { ck('PO0 posSyncToMarketplace loads', false, PR.__err); say(`\n${pass} passed, ${fail} failed`); process.exit(1); }
  /* shop A (owner uid ownerA ≠ shop id, as in real data) and shop B */
  await db.doc('shops/shopA').set({ name: 'Cyber A', sellerUid: 'ownerA' });
  await db.doc('shops/shopB').set({ name: 'Duka B', sellerUid: 'ownerB' });
  await db.doc('shopEmployees/shopA_cashA').set({ shopId: 'shopA', uid: 'cashA', role: 'cashier', shopOwnerId: 'ownerA', active: true });
  await db.doc('shopEmployees/shopB_cashB').set({ shopId: 'shopB', uid: 'cashB', role: 'cashier', shopOwnerId: 'ownerB', active: true });
  await db.doc('shopEmployees/shopA_invA').set({ shopId: 'shopA', uid: 'invA', role: 'inventory', shopOwnerId: 'ownerA', active: true });
  /* a FORGED record: filed under shop A, but it names the forger as the owner — the shop document says ownerA */
  await db.doc('shopEmployees/shopA_evil').set({ shopId: 'shopA', uid: 'evil', role: 'manager', shopOwnerId: 'evil', active: true });
  await P('paper', 'shopA', { stock: 10 }); await P('print', 'shopA'); await P('mugB', 'shopB', { stock: 5 });

  /* PO1 */
  const r1 = await out(sync('ownerA', 'S1', [{ productId: 'paper', qtyDeducted: 3 }, { productId: 'print', qtyDeducted: 20 }]));
  const s1 = await snap();
  ck('PO1 the shop owner syncs a sale: paper 10 → 7 and soldCount 3; the unmetered print service moves counters only; the claim is keyed shop + sale (shopA_S1)',
    r1.ok && r1.ok.synced === 2 && s1.paper.stock === 7 && s1.paper.soldCount === 3 && !has(s1.print, 'stock') && s1.print.soldCount === 20 && same(s1.claims, ['shopA_S1']),
    { r1: r1.ok || r1.msg, paper: s1.paper && [s1.paper.stock, s1.paper.soldCount], claims: s1.claims });

  /* PO2 */
  const r2 = await out(sync('ownerA', 'S1', [{ productId: 'paper', qtyDeducted: 3 }]));
  ck('PO2 the same sync again is idempotent: duplicate, paper stays 7',
    r2.ok && r2.ok.duplicate === true && (await get('products/paper')).stock === 7, r2.ok || r2.msg);

  /* PO3 */
  const r3 = await out(sync('cashA', 'S2', [{ productId: 'paper', qtyDeducted: 1 }]));
  ck('PO3 a corroborated cashier of the shop syncs: allowed (paper 7 → 6)', r3.ok && (await get('products/paper')).stock === 6, r3.ok || r3.msg);

  /* PO4..PO6 — refusals must leave NOTHING moved and NOTHING claimed */
  const b4 = await snap();
  const r4 = await out(sync('stranger', 'S3', [{ productId: 'paper', qtyDeducted: 5 }]));
  const r5 = await out(sync('cashB', 'S4', [{ productId: 'paper', qtyDeducted: 5 }]));
  const r6 = await out(sync('evil', 'S5', [{ productId: 'paper', qtyDeducted: 5 }]));
  const a4 = await snap();
  ck('PO4 a stranger (signed in, no relation) → permission-denied; zero mutation, no claim',
    r4.err === 'permission-denied' && same(b4, a4), { r4: r4.msg });
  ck('PO5 a cashier of ANOTHER shop syncing this shop\'s product → permission-denied; zero mutation',
    r5.err === 'permission-denied' && same(b4, a4), { r5: r5.msg });
  ck('PO6 a FORGED employee record (names the forger as owner; the shop document says ownerA) → permission-denied; zero mutation',
    r6.err === 'permission-denied' && same(b4, a4), { r6: r6.msg });

  /* PO7 */
  const b7 = await snap();
  const r7 = await out(sync('ownerA', 'S6', [{ productId: 'paper', qtyDeducted: 1 }, { productId: 'mugB', qtyDeducted: 1 }]));
  const a7 = await snap();
  ck('PO7 a MIXED-shop sale by shop A\'s owner (own paper + shop B\'s mug) → the WHOLE sync refused; even the owner\'s own paper does not move; no claim',
    r7.err === 'permission-denied' && /different shops/.test(r7.msg || '') && same(b7, a7), { r7: r7.msg, paper: a7.paper.stock, mugB: a7.mugB.stock });

  /* PO8 */
  const r8a = await out(sync('ownerB', 'S7', [{ productId: 'mugB', qtyDeducted: 1 }]));   /* shop B uses sale id S7 for itself */
  await db.doc('posSyncIdempotency/S7').set({ saleId: 'S7', uid: 'squatter' });           /* a legacy saleId-only claim of S7 */
  const p8 = (await get('products/paper')).stock;
  const r8 = await out(sync('ownerA', 'S7', [{ productId: 'paper', qtyDeducted: 2 }]));
  ck('PO8 the sale-id reservation race: shop B claimed S7 for itself and a legacy saleId-only claim of S7 exists — shop A\'s real sync of S7 STILL applies (paper −2)',
    r8a.ok && r8.ok && r8.ok.duplicate !== true && (await get('products/paper')).stock === p8 - 2 && !!(await get('posSyncIdempotency/shopA_S7')) && !!(await get('posSyncIdempotency/shopB_S7')),
    { r8a: r8a.ok || r8a.msg, r8: r8.ok || r8.msg, paper: [p8, (await get('products/paper')).stock] });

  /* PO9 */
  const b9 = await snap();
  const r9 = await out(sync('invA', 'S8', [{ productId: 'paper', qtyDeducted: 1 }]));
  ck('PO9 a corroborated employee whose role cannot sell (inventory) → permission-denied; zero mutation',
    r9.err === 'permission-denied' && same(b9, await snap()), { r9: r9.msg });

  /* PO10 */
  const p10 = (await get('products/paper')).stock;
  const r10 = await out(sync('admin1', 'S9', [{ productId: 'paper', qtyDeducted: 1 }]));
  ck('PO10 a platform admin (claims) → allowed', r10.ok && (await get('products/paper')).stock === p10 - 1, r10.ok || r10.msg);

  /* PO11 — the race the in-transaction re-check exists for: the product changes shop AFTER the authorization pass
     read it and BEFORE its stock transaction runs. Simulated deterministically: the next runTransaction first moves
     the product to shop B. */
  await P('stapler', 'shopA', { stock: 8 });
  const _origTxn = db.runTransaction;
  db.runTransaction = async function (fn) {
    db.runTransaction = _origTxn;
    await db.doc('products/stapler').update({ shopId: 'shopB', sellerUid: 'shopB' });
    return _origTxn.call(db, fn);
  };
  const r11 = await out(sync('ownerA', 'S10', [{ productId: 'stapler', qtyDeducted: 3 }]));
  db.runTransaction = _origTxn;
  const st11 = await get('products/stapler');
  ck('PO11 a product that changes shop between the authorization read and its stock transaction is NOT written (stock stays 8, no soldCount) and the item is reported',
    r11.ok && r11.ok.synced === 0 && (r11.ok.errors || []).some((e) => /no longer belongs/.test(e)) && st11.stock === 8 && !has(st11, 'soldCount'),
    { r11: r11.ok || r11.msg, stapler: st11 && [st11.stock, st11.soldCount] });

  say(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { say('CRASH ' + (e && e.stack || e)); process.exit(2); });
