/* test-quick-charge-sale.js — Step 2 (2026-09-30): QUICK CHARGE is a line on ONE canonical till sale.
 *
 * Owner: "use till and poscheckout" — a quick charge (a described, cashier-priced service or fee) completes through the
 * canonical till sale authority (posCompleteCheckout), priced by the existing pure core (shared/pos-service-pricing.js,
 * quick_charge lane). Not a product: no stock, no offers, never a shadow product. Customer, points, payment proof,
 * receipt and commission are the sale's own.
 *
 * REAL posCompleteCheckout (pos-zero-friction), pos-service-pricing, pos-customer-scope, loyalty-points (+ wallet-engine
 * resolver), payment-purposes pricer, over the transactional fake Firestore. Firebase Auth stubbed. No network, no SMS.
 *
 * PROVES
 *   QS1 a quick-charge-only cash sale is a canonical sale: posRetailSales carries the line (no product, priceSource
 *       quick_charge, attributed to the cashier, the server's figure), the receipt lists it, no product is touched
 *   QS2 mixed: a product + a quick charge — the product's stock is taken ONCE, the quick line takes none; the total is both
 *   QS3 refused before anything is written: no description · zero amount · above the KES 20,000 quick-charge ceiling ·
 *       a "quick charge" carrying a productId (a shadow product) · a subtotal that disagrees with the server
 *   QS4 the pre-sale check (dryRun) prices the quick charge exactly as the sale will; a quick-only cart has no offer
 *   QS5 customer + points: a quick charge with an attached customer (no typed phone) earns SOKONI points for THAT
 *       customer (1 per KES 10, the server's amount) ONCE — a retry of the same sale earns nothing more; a customer with
 *       no SOKONI account earns nothing; another shop's customer is refused
 *   QS6 the payment is SALE-BOUND: the Quick Charge pricer marks it (and refuses intent-level points on it); a PAID
 *       sale-bound payment completes the sale with M-PESA as its proof; the webhook leaves the receipt and points to the
 *       sale (STRUCTURAL: the webhook is inline in index.js)
 *
 *   node scripts/test-quick-charge-sale.js
 */
'use strict';
process.env.GCLOUD_PROJECT = 'demo-quick-charge-sale';
delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
const path = require('path'), Module = require('module'), fs = require('fs');
const ROOT = path.resolve(__dirname, '..'), FN = path.join(ROOT, 'functions');
const { makeFakeFirestore } = require('./lib/fake-firestore-txn');
const F = makeFakeFirestore({ clock: () => Date.now() }); const db = F.db;
const say = console.log; console.log = console.info = console.warn = console.error = console.debug = () => {};
let pass = 0, fail = 0;
const ck = (l, ok, d) => { say('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined && d !== '' ? '   [' + String(typeof d === 'object' ? JSON.stringify(d) : d).slice(0, 360) + ']' : '')); ok ? pass++ : fail++; };
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
    const r = { 'shopA|shopA': 'owner', 'cashA|shopA': 'cashier', 'shopB|shopB': 'owner' }[uid + '|' + shopId];
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
const A = 'shopA', B = 'shopB';
const QC = (description, unitPrice, qty) => ({ quickCharge: true, description, unitPrice, qty: qty || 1 });
const sale = (key, items, extra, who) => ZF.posCompleteCheckout({ auth: { uid: who || A, token: { posRole: 'cashier' } }, data: Object.assign({
  idempotencyKey: key, merchantId: A, items,
  subtotal: items.reduce((n, it) => n + (Number(it.unitPrice) || 0) * (Number(it.qty) || 1), 0),
  grandTotal: items.reduce((n, it) => n + (Number(it.unitPrice) || 0) * (Number(it.qty) || 1), 0),
  discountTotal: 0, taxTotal: 0,
  payments: [{ method: 'cash', amount: items.reduce((n, it) => n + (Number(it.unitPrice) || 0) * (Number(it.qty) || 1), 0) }],
}, extra || {}) });
const saleOf = async (key) => (await all('posRetailSales')).find((x) => x.idempotencyKey === key || x.id === key) || null;

(async () => {
  if (typeof ZF.posCompleteCheckout !== 'function' || !SC.saveOwned || !PPX.PURPOSES) { ck('QS0 the sale authority loads', false, ZF.__err || SC.__err || PPX.__err); say(`\n${pass} passed, ${fail} failed`); process.exit(1); }
  await db.doc('shops/' + A).set({ name: 'Mama Duka', sellerUid: A }); await db.doc('shops/' + B).set({ name: 'Duka B', sellerUid: B });
  await db.doc('users/' + A).set({ displayName: 'Owner A' }); await db.doc('users/' + B).set({ displayName: 'Owner B' });
  await db.doc('products/soap').set({ name: 'Soap', price: 250, stock: 100, sellerUid: A, shopId: A, status: 'active', isVisible: true });

  /* QS1 */
  const n0 = (await get('products/soap')).stock;
  const r1 = await out(sale('QS1-SALE', [QC('Delivery to Kilimani', 1500)]));
  const s1 = await saleOf('QS1-SALE') || (await all('posRetailSales'))[0] || {};
  const l1 = (s1.items || [])[0] || {};
  const rc1 = r1.ok && r1.ok.saleId ? await get('posReceipts/' + r1.ok.saleId) : null;
  ck('QS1 a quick-charge-only cash sale is a canonical sale: the line has no product, priceSource quick_charge, the operator attributed, the server figure; receipted; no product touched',
    r1.ok && s1.items && s1.items.length === 1 && l1.productId === null && l1.priceSource === 'quick_charge' && l1.authorizedBy === A && l1.unitPrice === 1500 && l1.name === 'Delivery to Kilimani'
    && s1.grandTotal === 1500 && rc1 && (rc1.items || []).some((i) => i.priceSource === 'quick_charge' && i.name === 'Delivery to Kilimani') && (await get('products/soap')).stock === n0,
    { err: r1.msg, line: l1, total: s1.grandTotal });

  /* QS2 */
  const r2 = await out(sale('QS2-SALE', [{ productId: 'soap', qty: 2, unitPrice: 250 }, QC('Gift wrapping', 100)]));
  const s2 = await saleOf('QS2-SALE') || {};
  ck('QS2 mixed: a product + a quick charge — the product stock is taken ONCE (100 → 98), the quick line takes none; the total is both (600)',
    r2.ok && (await get('products/soap')).stock === 98 && s2.grandTotal === 600 && (s2.items || []).length === 2, { err: r2.msg, stock: (await get('products/soap')).stock, total: s2.grandTotal });

  /* QS3 */
  const before = (await all('posRetailSales')).length;
  const q3 = [
    await out(sale('QS3-A', [QC('', 500)])),
    await out(sale('QS3-B', [QC('Tailoring', 0)])),
    await out(sale('QS3-C', [QC('Big job', 25000)])),
    await out(sale('QS3-D', [{ quickCharge: true, productId: 'soap', description: 'Soap', unitPrice: 1, qty: 1 }])),
    await out(ZF.posCompleteCheckout({ auth: { uid: A, token: {} }, data: { idempotencyKey: 'QS3-E', merchantId: A, items: [QC('Repair', 900)], subtotal: 90, grandTotal: 90, discountTotal: 0, taxTotal: 0, payments: [{ method: 'cash', amount: 90 }] } })),
  ];
  ck('QS3 refused before anything is written: no description · zero · above the KES 20,000 ceiling · a quick charge carrying a productId · a subtotal the server disagrees with',
    q3.every((x) => x.err) && (await all('posRetailSales')).length === before && /description/.test(q3[0].msg) && /limit/.test(q3[2].msg) && /catalogue/.test(q3[3].msg) && /Subtotal mismatch/.test(q3[4].msg),
    q3.map((x) => x.msg && x.msg.slice(0, 60)));

  /* QS4 */
  const dry = await out(ZF.posCompleteCheckout({ auth: { uid: A, token: {} }, data: { dryRun: true, idempotencyKey: 'QS4', merchantId: A, items: [QC('Callout fee', 700)], subtotal: 700, grandTotal: 700, payments: [] } }));
  ck('QS4 the pre-sale check prices the quick charge as the sale will (700), with the line and no offer',
    dry.ok && dry.ok.serverSubtotal === 700 && (dry.ok.items || []).some((i) => i.priceSource === 'quick_charge') && (dry.ok.offerDiscount === 0 || dry.ok.offerDiscount === null) && (dry.ok.offersApplied || []).length === 0,
    dry.ok || dry.msg);

  /* QS5 */
  await db.doc('users/jane').set({ phoneNumber: '+254722376801', displayName: 'Jane Wanjiru' }); AUTH.users.jane = { uid: 'jane', phoneNumber: '+254722376801' };
  await db.doc('loyaltyAccounts/jane').set({ uid: 'jane', loyaltyId: 'SKN-J', balance: 0, status: 'active' });
  const jane = await SC.saveOwned(db, A, { phone: '0722376801', name: 'Jane Wanjiru', by: A });
  const tom = await SC.saveOwned(db, A, { phone: '0733000999', name: 'Tom No-Account', by: A });
  const bCust = await SC.saveOwned(db, B, { phone: '0744000111', name: 'Other Shop Customer', by: B });
  const r5 = await out(sale('QS5-SALE', [QC('Screen repair', 2350)], { customer: { id: jane.id } }));
  const bal1 = (await get('loyaltyAccounts/jane')).balance;
  const r5b = await out(sale('QS5-SALE', [QC('Screen repair', 2350)], { customer: { id: jane.id } }));   /* the same sale, retried */
  const bal2 = (await get('loyaltyAccounts/jane')).balance;
  const r5c = await out(sale('QS5-TOM', [QC('Screen repair', 2350)], { customer: { id: tom.id } }));
  const r5d = await out(sale('QS5-X', [QC('Screen repair', 2350)], { customer: { id: bCust.id } }));
  const s5 = await saleOf('QS5-SALE') || {};
  ck('QS5 an attached customer (no typed phone) earns SOKONI points for THAT customer: 235 on KES 2,350, ONCE (a retry adds none); no SOKONI account → none; another shop\'s customer refused',
    r5.ok && bal1 === 235 && r5b.ok && bal2 === 235 && s5.customer && s5.customer.id === jane.id && r5c.ok && (r5c.ok.pointsEarned || {}).points === 0 && r5d.err === 'permission-denied',
    { r5: r5.msg, bal1, bal2, tom: r5c.ok && r5c.ok.pointsEarned, x: r5d.err });

  /* QS6 */
  const TILL = { sokoniTillId: 'TILLA', shopId: A, branchId: 'main', merchantUid: A, status: 'ACTIVE', currency: 'KES' };
  await db.doc('sokoniTills/TILLA').set(TILL);
  const q6 = await out(PPX.PURPOSES.pos_till_sale.price(A, { sokoniTillId: 'TILLA', saleId: 'QS6-SALE', saleBound: true, items: [{ name: 'Till sale', price: 800, qty: 1 }] }));
  const q6b = await out(PPX.PURPOSES.pos_till_sale.price(A, { sokoniTillId: 'TILLA', saleId: 'QS6-SALE', saleBound: true, pointsRedemptionId: 'r_x', items: [{ name: 'Till sale', price: 800, qty: 1 }] }));
  const ref = q6.ok && q6.ok.preferredRef;
  if (ref) await db.doc('paymentIntents/' + ref).set({ ref, uid: A, purpose: 'pos_till_sale', amount: 800, metadata: q6.ok.metadata, status: 'paid', paymentRef: 'IS-1' });
  const r6 = await out(sale('QS6-SALE', [QC('Plumbing callout', 800)], { payments: [{ method: 'mpesa', amount: 800, intentRef: ref }] }));
  const s6 = await saleOf('QS6-SALE') || {};
  const ix = fs.readFileSync(path.join(FN, 'index.js'), 'utf8');
  const wh = ix.slice(ix.indexOf('const _saleBound = !!('), ix.indexOf('} else if (_decision.action === "flag_mismatch")'));
  ck('QS6 the payment is SALE-BOUND (pricer marks it; refuses intent-level points on it); the PAID payment completes the quick-charge sale as M-PESA proof; the webhook leaves receipt + points to the sale (STRUCTURAL)',
    q6.ok && q6.ok.metadata.saleBound === true && q6b.err === 'failed-precondition' && /points tender/.test(q6b.msg || '') && r6.ok && (s6.payments || []).some((p) => p.method === 'mpesa' && p.intentRef === ref)
    && /if \(!_saleBound\) try \{[\s\S]*posReceipts[\s\S]*if \(!_saleBound\) try \{[\s\S]*earnForSale/.test(wh),
    { q6b: q6b.msg, r6: r6.msg, pay: s6.payments });

  /* QS7 */
  const q7 = await out(PPX.PURPOSES.pos_till_sale.price(A, { sokoniTillId: 'TILLA', saleId: 'QS7-SALE', saleBound: true, items: [{ name: 'Till sale', price: 1000, qty: 1 }] }));
  const ref7 = q7.ok && q7.ok.preferredRef;
  if (ref7) await db.doc('paymentIntents/' + ref7).set({ ref: ref7, uid: A, purpose: 'pos_till_sale', amount: 1000, metadata: q7.ok.metadata, status: 'paid', paymentRef: 'IS-7' });
  const snap7 = async () => ({ stock: (await get('products/soap')).stock, sales: (await all('posRetailSales')).length, receipts: (await all('posReceipts')).length,
    pts: (await get('loyaltyAccounts/jane')).balance, claim: ref7 ? await get('posPaymentClaims/' + ref7) : 'no-ref' });
  const b7 = await snap7();
  const r7 = await out(sale('QS7-SALE', [{ productId: 'soap', qty: 2, unitPrice: 250 }, { quickCharge: true, productId: 'soap', description: 'Soap again', unitPrice: 500, qty: 1 }],
    { customer: { id: jane.id }, payments: [{ method: 'mpesa', amount: 1000, intentRef: ref7 }] }));
  const a7 = await snap7();
  /* positive control: the SAME basket without the stray productId, on the SAME payment, does move every observed field */
  const r7c = await out(sale('QS7-SALE', [{ productId: 'soap', qty: 2, unitPrice: 250 }, QC('Soap again', 500)],
    { customer: { id: jane.id }, payments: [{ method: 'mpesa', amount: 1000, intentRef: ref7 }] }));
  const c7 = await snap7();
  ck('QS7 a quick charge carrying a productId is refused BEFORE anything moves — in a mixed basket, with a points-eligible customer and a PAID sale-bound payment: no sale, no stock taken, no receipt, no points, the payment NOT consumed; the corrected basket on the same payment then moves all five (positive control)',
    !!ref7 && r7.err && /catalogue/.test(r7.msg || '') && a7.stock === b7.stock && a7.sales === b7.sales && a7.receipts === b7.receipts && a7.pts === b7.pts && a7.claim === null
    && r7c.ok && c7.stock === b7.stock - 2 && c7.sales === b7.sales + 1 && c7.receipts === b7.receipts + 1 && c7.pts === b7.pts + 100 && !!c7.claim,
    { r7: r7.msg, r7c: r7c.msg, b7, a7, c7 });

  /* QS8 */
  await db.doc('products/printing').set({ name: 'Printing (per page)', price: 10, sellerUid: A, shopId: A, status: 'active', isVisible: true, type: 'service' });   /* NO stock field = UNMETERED (inventory convergence A) */
  await db.doc('products/envelope').set({ name: 'A4 Envelope', price: 20, stock: 50, sellerUid: A, shopId: A, status: 'active', isVisible: true });
  const q8 = await out(PPX.PURPOSES.pos_till_sale.price(A, { sokoniTillId: 'TILLA', saleId: 'QS8-CYBER', saleBound: true, items: [{ name: 'Till sale', price: 390, qty: 1 }] }));
  const ref8 = q8.ok && q8.ok.preferredRef;
  if (ref8) await db.doc('paymentIntents/' + ref8).set({ ref: ref8, uid: A, purpose: 'pos_till_sale', amount: 390, metadata: q8.ok.metadata, status: 'paid', paymentRef: 'IS-8' });
  const s8b = (await all('posRetailSales')).length, rc8b = (await all('posReceipts')).length;
  const r8 = await out(sale('QS8-CYBER', [{ productId: 'printing', qty: 20, unitPrice: 10 }, { productId: 'envelope', qty: 5, unitPrice: 20 }, QC('Scanning 3 pages', 30, 3)],
    { payments: [{ method: 'mpesa', amount: 390, intentRef: ref8 }] }));
  const s8 = await saleOf('QS8-CYBER') || {};
  const lines8 = s8.items || [];
  const pr8 = await get('products/printing');
  ck('QS8 the cyber shop: printing (a catalogue service with NO stock field) + envelopes (stocked) + scanning (a quick charge) = ONE sale, ONE M-PESA payment, ONE receipt, KES 390; envelopes 50 → 45, printing keeps no stock figure',
    r8.ok && (await all('posRetailSales')).length === s8b + 1 && (await all('posReceipts')).length === rc8b + 1 && Number(s8.grandTotal) === 390
    && lines8.length === 3 && lines8.some((l) => l.productId === 'printing' && l.qty === 20) && lines8.some((l) => l.productId === 'envelope' && l.qty === 5)
    && lines8.some((l) => l.priceSource === 'quick_charge' && l.lineTotal === 90)
    && (await get('products/envelope')).stock === 45 && pr8 && pr8.stock === undefined
    && (s8.payments || []).length === 1 && s8.payments[0].intentRef === ref8 && !!(await get('posPaymentClaims/' + ref8)),
    { r8: r8.msg, total: s8.grandTotal, lines: lines8.map((l) => [l.productId, l.qty, l.unitPrice, l.lineTotal, l.priceSource]), env: (await get('products/envelope')).stock, printStock: pr8 && pr8.stock, pay: s8.payments });

  say(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { say('CRASH ' + (e && e.stack || e)); process.exit(2); });
