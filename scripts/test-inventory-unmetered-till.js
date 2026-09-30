#!/usr/bin/env node
/**
 * Inventory convergence — Phase A: the TILL keeps ONE meaning of stock (2026-09-30).
 *
 * The invariant (owner, 2026-09-30), from functions/shared/sellability.stockOf:
 *   stock === 0         → metered, sold out
 *   stock  >  0         → metered, available
 *   no numeric stock    → UNMETERED — stock is never created, decremented or returned
 *
 * Before this slice posCompleteCheckout read an absent stock as 9999 in its check but still wrote increment(-qty),
 * CREATING stock: -qty — so a printing service sold once and was then refused ("Insufficient stock") for ever. The
 * refund did the mirror: increment(+qty) on an absent field made a service metered with a tiny stock.
 *
 *   IA1 the cyber basket (the owner's acceptance case): printing (a catalogue service with NO stock field) 20×10 +
 *       A4 envelopes 5×20 (stock 50) + scanning (quick charge) 3×30 → ONE M-PESA payment, ONE sale, ONE receipt,
 *       KES 390; envelopes 50 → 45; printing gets NO stock field; the scanning line has no product; the attached
 *       customer earns 39 points for THAT customer
 *   IA2 the same basket again (a new payment) succeeds: envelopes 45 → 40; printing still has no stock field and its
 *       sales counter moved (sold 40); the sale lines record what they took (stockDeducted 5 / 0)
 *   IA3 metered: stock 5, qty 2 → 3 · stock 1, qty 2 → refused, stock stays 1, no sale · stock 0 → refused (sold out)
 *   IA4 the pre-sale check (dryRun) shows a stock delta for the metered envelope ONLY — never a fake 0 → 0 for printing
 *   IA5 refund: the envelopes come back exactly (40 → 45); printing gets NO stock field; the refund record says what it
 *       returned (stockReturned 5 / 0)
 *   IA6 a sale recorded BEFORE stockDeducted existed: an unmetered item still gets no stock on refund; a metered one
 *       gets its qty back
 *   IA7 a package: the metered component is taken, the unmetered component's stock is never created
 *   IA8 one rule with the online checkout: a product carrying only the legacy `stockQty` is unmetered at the till too
 *       (sellability.stockOf reads `stock` only) — it sells and no `stock` field is created
 *
 * Real modules over the transactional fake Firestore. No network, no SMS.
 *   node scripts/test-inventory-unmetered-till.js
 */
'use strict';
process.env.GCLOUD_PROJECT = 'demo-inventory-unmetered-till';
delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
const path = require('path'), Module = require('module');
const ROOT = path.resolve(__dirname, '..'), FN = path.join(ROOT, 'functions');
const { makeFakeFirestore } = require('./lib/fake-firestore-txn');
const F = makeFakeFirestore({ clock: () => Date.now() }); const db = F.db;
const say = console.log; console.log = console.info = console.warn = console.error = console.debug = () => {};
let pass = 0, fail = 0;
const ck = (l, ok, d) => { say('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined && d !== '' ? '   [' + String(typeof d === 'object' ? JSON.stringify(d) : d).slice(0, 420) + ']' : '')); ok ? pass++ : fail++; };
class HttpsError extends Error { constructor(c, m, d) { super(m); this.code = c; this.details = d; } }
const AUTH = { users: {} };
const authApi = {
  createUser: async () => { throw new Error('not in this suite'); },
  getUserByPhoneNumber: async (p) => { const u = Object.values(AUTH.users).find((x) => x.phoneNumber === p); if (!u) { const e = new Error('nf'); e.code = 'auth/user-not-found'; throw e; } return u; },
  getUser: async (uid) => AUTH.users[uid] || { customClaims: {} },
};
const ADMIN = { apps: [{}], initializeApp: () => ({}), app: () => ({}), firestore: Object.assign(() => db, { FieldValue: F.FieldValue, Timestamp: F.Timestamp, FieldPath: F.FieldPath }), auth: () => authApi, messaging: () => ({ send: async () => ({}) }) };
const origReq = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === 'firebase-admin/firestore') return { getFirestore: () => db, FieldValue: F.FieldValue, Timestamp: F.Timestamp, FieldPath: F.FieldPath };
  if (id === 'firebase-admin/auth') return { getAuth: () => authApi };
  if (id === 'firebase-admin') return ADMIN;
  if (id === 'firebase-functions/v2/https') return { onCall: (_o, h) => (h || _o), onRequest: (_o, h) => (h || _o), HttpsError };
  if (id === 'firebase-functions/v2/scheduler') return { onSchedule: (_o, h) => h };
  if (id === 'firebase-functions/v2/firestore') return { onDocumentWritten: (_o, h) => h, onDocumentCreated: (_o, h) => h, onDocumentUpdated: (_o, h) => h };
  if (id === 'firebase-functions/logger' || id === 'firebase-functions') return { logger: { info() {}, warn() {}, error() {} }, info() {}, warn() {}, error() {}, debug() {} };
  if (id === 'firebase-functions/params') return { defineSecret: (n) => ({ name: n, value: () => 'test-secret' }), defineString: () => ({ value: () => '' }), defineInt: () => ({ value: () => 0 }) };
  if (id === './pos-audit') return { writeAudit: () => {} };
  if (id === './workforce-identity') return { _assertBusinessPermission: async () => { throw new HttpsError('permission-denied', 'no'); } };
  if (id === './tenant-identity') return { resolveMerchantIdForOwner: async () => ({ ok: false }) };
  if (id === './sokoni-at') return new Proxy({}, { get: (_, k) => (k === 'secrets' ? [] : () => { throw new Error('SMS must never be sent by a test'); }) });
  if (id === './shop-employees') return { resolveShopAccess: async (uid, shopId) => {
    const r = { 'shopA|shopA': 'owner', 'cashA|shopA': 'cashier' }[uid + '|' + shopId];
    if (!r) throw new HttpsError('permission-denied', 'no access'); return { role: r }; }, capabilitiesForRole: () => ['sell'] };
  return origReq.apply(this, arguments);
};
const load = (p) => { try { return require(p); } catch (e) { return { __err: e.message }; } };
const ZF = load(path.join(FN, 'pos-zero-friction.js'));
const SC = load(path.join(FN, 'pos-customer-scope.js'));
const PPX = load(path.join(FN, 'payment-purposes.js'));
const get = async (p) => { const s = await db.doc(p).get(); return s.exists ? s.data() : null; };
const all = async (c) => (await db.collection(c).get()).docs.map((d) => Object.assign({ id: d.id }, d.data()));
const out = async (p) => { try { return { ok: await p }; } catch (e) { return { err: e.code || 'error', msg: String(e.message) }; } };
const A = 'shopA';
const QC = (description, unitPrice, qty) => ({ quickCharge: true, description, unitPrice, qty: qty || 1 });
const total = (items) => items.reduce((n, it) => n + (Number(it.unitPrice) || 0) * (Number(it.qty) || 1), 0);
const sale = (key, items, extra) => ZF.posCompleteCheckout({ auth: { uid: A, token: { posRole: 'cashier' } }, data: Object.assign({
  idempotencyKey: key, merchantId: A, items, subtotal: total(items), grandTotal: total(items), discountTotal: 0, taxTotal: 0,
  payments: [{ method: 'cash', amount: total(items) }] }, extra || {}) });
const refund = (saleId, items, key) => ZF.posProcessRefund({ data: { saleId, items, reason: 'customer returned it', merchantId: A, idempotencyKey: key || ('R-' + saleId) },
  auth: { uid: A, token: { posRole: 'owner' } } });
const saleOf = async (key) => (await all('posRetailSales')).find((x) => x.idempotencyKey === key || x.id === key) || null;
const has = (o, k) => !!o && Object.prototype.hasOwnProperty.call(o, k);
/* a paid, sale-bound M-PESA payment for one sale (the pricer's own metadata) */
const paid = async (saleKey, amount) => {
  const q = await PPX.PURPOSES.pos_till_sale.price(A, { sokoniTillId: 'TILLA', saleId: saleKey, saleBound: true, items: [{ name: 'Till sale', price: amount, qty: 1 }] });
  await db.doc('paymentIntents/' + q.preferredRef).set({ ref: q.preferredRef, uid: A, purpose: 'pos_till_sale', amount, metadata: q.metadata, status: 'paid', paymentRef: 'IS-' + saleKey });
  return q.preferredRef;
};
const CYBER = () => [{ productId: 'printing', qty: 20, unitPrice: 10 }, { productId: 'envelope', qty: 5, unitPrice: 20 }, QC('Scanning 3 pages', 30, 3)];

(async () => {
  if (typeof ZF.posCompleteCheckout !== 'function' || typeof ZF.posProcessRefund !== 'function' || !PPX.PURPOSES) {
    ck('IA0 the sale and refund authorities load', false, ZF.__err || PPX.__err); say(`\n${pass} passed, ${fail} failed`); process.exit(1);
  }
  await db.doc('shops/' + A).set({ name: 'Cyber Point', sellerUid: A });
  await db.doc('users/' + A).set({ displayName: 'Owner A' });   /* the owner's user record: how the sale resolves who is selling */
  await db.doc('sokoniTills/TILLA').set({ sokoniTillId: 'TILLA', shopId: A, branchId: 'main', merchantUid: A, status: 'ACTIVE', currency: 'KES' });
  /* printing: a catalogue SERVICE with NO stock field and NO trackInventory flag — the case that used to break */
  await db.doc('products/printing').set({ name: 'Printing (per page)', price: 10, sellerUid: A, shopId: A, status: 'active', isVisible: true, type: 'service' });
  await db.doc('products/envelope').set({ name: 'A4 Envelope', price: 20, stock: 50, sellerUid: A, shopId: A, status: 'active', isVisible: true });
  await db.doc('users/jane').set({ phoneNumber: '+254722376801', displayName: 'Jane Wanjiru' }); AUTH.users.jane = { uid: 'jane', phoneNumber: '+254722376801' };
  await db.doc('loyaltyAccounts/jane').set({ uid: 'jane', loyaltyId: 'SKN-J', balance: 0, status: 'active' });
  const jane = await SC.saveOwned(db, A, { phone: '0722376801', name: 'Jane Wanjiru', by: A });

  /* IA1 */
  const s0 = (await all('posRetailSales')).length, rc0 = (await all('posReceipts')).length;
  const ref1 = await paid('CYBER-1', 390);
  const r1 = await out(sale('CYBER-1', CYBER(), { customer: { id: jane.id }, payments: [{ method: 'mpesa', amount: 390, intentRef: ref1 }] }));
  const x1 = await saleOf('CYBER-1') || {};
  const p1 = await get('products/printing');
  ck('IA1 the cyber basket: printing (NO stock field) + envelopes + scanning → ONE M-PESA payment, ONE sale, ONE receipt, KES 390; envelopes 50 → 45; printing gets NO stock field; scanning has no product; Jane earns 39 pts',
    r1.ok && (await all('posRetailSales')).length === s0 + 1 && (await all('posReceipts')).length === rc0 + 1 && Number(x1.grandTotal) === 390
    && (x1.payments || []).length === 1 && x1.payments[0].intentRef === ref1 && !!(await get('posPaymentClaims/' + ref1))
    && (await get('products/envelope')).stock === 45 && !has(p1, 'stock') && !has(p1, 'inventoryVersion')
    && (x1.items || []).some((l) => l.priceSource === 'quick_charge' && l.productId === null && l.lineTotal === 90)
    && (await get('loyaltyAccounts/jane')).balance === 39,
    { r1: r1.msg, total: x1.grandTotal, env: (await get('products/envelope')).stock, printing: p1 && { stock: p1.stock, iv: p1.inventoryVersion, sold: p1.sold }, pts: (await get('loyaltyAccounts/jane')).balance });

  /* IA2 */
  const ref2 = await paid('CYBER-2', 390);
  const r2 = await out(sale('CYBER-2', CYBER(), { payments: [{ method: 'mpesa', amount: 390, intentRef: ref2 }] }));
  const x2 = await saleOf('CYBER-2') || {};
  const p2 = await get('products/printing');
  const ln = (x, id) => (x.items || []).find((l) => l.productId === id) || {};
  ck('IA2 the SAME basket again succeeds: envelopes 45 → 40; printing still has NO stock field and its sales counter moved (sold 40); the lines record what they took (envelope 5, printing 0)',
    r2.ok && (await get('products/envelope')).stock === 40 && !has(p2, 'stock') && p2.sold === 40
    && ln(x2, 'envelope').stockDeducted === 5 && ln(x2, 'printing').stockDeducted === 0,
    { r2: r2.msg, env: (await get('products/envelope')).stock, printing: p2 && { stock: p2.stock, sold: p2.sold }, took: [ln(x2, 'envelope').stockDeducted, ln(x2, 'printing').stockDeducted] });

  /* IA3 */
  await db.doc('products/pen').set({ name: 'Pen', price: 30, stock: 5, sellerUid: A, shopId: A, status: 'active', isVisible: true });
  await db.doc('products/flash').set({ name: 'Flash disk', price: 800, stock: 1, sellerUid: A, shopId: A, status: 'active', isVisible: true });
  await db.doc('products/file').set({ name: 'Box file', price: 150, stock: 0, sellerUid: A, shopId: A, status: 'active', isVisible: true });
  const r3a = await out(sale('M-PEN', [{ productId: 'pen', qty: 2, unitPrice: 30 }]));
  const n3 = (await all('posRetailSales')).length;
  const r3b = await out(sale('M-FLASH', [{ productId: 'flash', qty: 2, unitPrice: 800 }]));
  const r3c = await out(sale('M-FILE', [{ productId: 'file', qty: 1, unitPrice: 150 }]));
  ck('IA3 metered: stock 5, qty 2 → 3 · stock 1, qty 2 → refused, stock stays 1, no sale · stock 0 → refused (sold out)',
    r3a.ok && (await get('products/pen')).stock === 3 && r3b.err && /Insufficient stock/.test(r3b.msg) && (await get('products/flash')).stock === 1
    && r3c.err && /Insufficient stock/.test(r3c.msg) && (await get('products/file')).stock === 0 && (await all('posRetailSales')).length === n3,
    { pen: (await get('products/pen')).stock, flash: [r3b.msg, (await get('products/flash')).stock], file: [r3c.msg, (await get('products/file')).stock] });

  /* IA4 */
  const dry = await out(ZF.posCompleteCheckout({ auth: { uid: A, token: {} }, data: { dryRun: true, idempotencyKey: 'DRY', merchantId: A, items: CYBER(), subtotal: 390, grandTotal: 390, payments: [] } }));
  const deltas = (dry.ok && dry.ok.stockDeltas) || [];
  ck('IA4 the pre-sale check shows a stock delta for the metered envelope ONLY (40 → 35) — never a fake 0 → 0 for printing',
    dry.ok && deltas.length === 1 && deltas[0].productId === 'envelope' && deltas[0].from === 40 && deltas[0].to === 35,
    deltas);

  /* IA5 */
  const rf = await out(refund(x2.id, [{ productId: 'envelope', qty: 5 }, { productId: 'printing', qty: 20 }]));
  const p5 = await get('products/printing');
  const rec5 = (await all('posRefunds')).find((x) => x.saleId === x2.id) || {};
  const ret = (id) => ((rec5.items || []).find((i) => i.productId === id) || {}).stockReturned;
  ck('IA5 refund: the envelopes come back exactly (40 → 45); printing gets NO stock field (sold 40 → 20); the refund record says what it returned (5 / 0)',
    rf.ok && (await get('products/envelope')).stock === 45 && !has(p5, 'stock') && p5.sold === 20 && ret('envelope') === 5 && ret('printing') === 0,
    { rf: rf.msg, env: (await get('products/envelope')).stock, printing: p5 && { stock: p5.stock, sold: p5.sold }, returned: [ret('envelope'), ret('printing')] });

  /* IA6 */
  await db.doc('products/typing').set({ name: 'Typing (per page)', price: 50, sellerUid: A, shopId: A, status: 'active', isVisible: true });
  await db.doc('products/paper').set({ name: 'Paper ream', price: 600, stock: 10, sellerUid: A, shopId: A, status: 'active', isVisible: true });
  await db.doc('posRetailSales/OLD-1').set({ id: 'OLD-1', idempotencyKey: 'OLD-1', merchantId: A, status: 'completed', subtotal: 1700, grandTotal: 1700,
    items: [{ productId: 'typing', name: 'Typing (per page)', qty: 10, unitPrice: 50 }, { productId: 'paper', name: 'Paper ream', qty: 2, unitPrice: 600 }],
    payments: [{ method: 'cash', amount: 1700 }], createdAt: Date.now() });
  const rf6 = await out(refund('OLD-1', [{ productId: 'typing', qty: 10 }, { productId: 'paper', qty: 2 }]));
  ck('IA6 a sale from BEFORE stockDeducted was recorded: the unmetered item still gets no stock on refund; the metered one gets its qty back (10 → 12)',
    rf6.ok && !has(await get('products/typing'), 'stock') && (await get('products/paper')).stock === 12,
    { rf6: rf6.msg, typing: (await get('products/typing')).stock, paper: (await get('products/paper')).stock });

  /* IA7 */
  await db.doc('products/binding').set({ name: 'Binding service', price: 100, sellerUid: A, shopId: A, status: 'active', isVisible: true });
  await db.doc('products/cover').set({ name: 'Clear cover', price: 40, stock: 20, sellerUid: A, shopId: A, status: 'active', isVisible: true });
  await db.doc('products/bindpack').set({ name: 'Bind a report', price: 180, sellerUid: A, shopId: A, status: 'active', isVisible: true, trackInventory: false, listingType: 'package',
    components: [{ productId: 'binding', qty: 1 }, { productId: 'cover', qty: 2 }] });
  const r7 = await out(sale('PACK-1', [{ productId: 'bindpack', qty: 1, unitPrice: 180 }]));
  const b7 = await get('products/binding');
  ck('IA7 a package: the metered component is taken (covers 20 → 18); the unmetered component (binding) never gets a stock field',
    r7.ok && (await get('products/cover')).stock === 18 && !has(b7, 'stock'),
    { r7: r7.msg, cover: (await get('products/cover')).stock, binding: b7 && b7.stock });

  /* IA8 */
  await db.doc('products/legacy').set({ name: 'Legacy stapler', price: 250, stockQty: 0, sellerUid: A, shopId: A, status: 'active', isVisible: true });
  const S = require(path.join(FN, 'shared', 'sellability.js'));
  const r8 = await out(sale('LEG-1', [{ productId: 'legacy', qty: 1, unitPrice: 250 }]));
  const l8 = await get('products/legacy');
  ck('IA8 one rule with online checkout: a product with only the legacy `stockQty` is unmetered to sellability AND the till — it sells, and no `stock` field is created',
    S.stockOf(l8).metered === false && r8.ok && !has(l8, 'stock') && l8.stockQty === 0,
    { r8: r8.msg, metered: S.stockOf(l8).metered, stock: l8 && l8.stock });

  say(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { say('CRASH ' + (e && e.stack || e)); process.exit(2); });
