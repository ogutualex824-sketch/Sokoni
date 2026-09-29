/* test-points-refunds.js — Refunds × SOKONI points (2026-09-29, owner: fix first).
 * A refund used to leave the sale's points in place (earned points kept; spent points not given back — a till refund
 * repaid that part in CASH) and refunded the LIST price even on a discounted sale. REAL posCompleteCheckout,
 * posProcessRefund, order-settlement.handleOrderRefund and loyalty-points-spend over the transactional fake.
 *
 * PROVES
 *   RP1 full till refund of 500 pts + 950 cash: 950 money back, 500 points back, 95 earned taken back
 *   RP2 a replayed refund changes nothing
 *   RP3 an offer-discounted sale refunds what was paid, not the list price
 *   RP4 a partial refund moves money and points in the same proportion
 *   RP5 earned points already spent: taken from what is there, shortfall flagged, never negative, refund stands
 *   RP6 an online order refund gives back the spent points and takes back the earned — once
 *   RP7 a sale without points refunds exactly as before
 *   RP8 one sale's refund never touches another sale's points
 */
'use strict';
process.env.GCLOUD_PROJECT = 'demo-points-refunds';
delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
const path = require('path'), Module = require('module');
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
  if (id === './shop-employees') return { resolveShopAccess: async (uid, shopId) => {
    const r = { 'shopA|shopA': 'owner', 'cashA|shopA': 'cashier', 'shopB|shopB': 'owner', 'cashB|shopB': 'cashier' }[uid + '|' + shopId];
    if (!r) throw new HttpsError('permission-denied', 'no access'); return { role: r }; }, capabilitiesForRole: () => ['sell'] };
  return origReq.apply(this, arguments);
};
const load = (p) => { try { return require(p); } catch (e) { return { __err: e.message }; } };
const PS = load(path.join(FN, 'loyalty-points-spend.js'));
const ZF = load(path.join(FN, 'pos-zero-friction.js'));
const get = async (p) => { const s = await db.doc(p).get(); return s.exists ? s.data() : null; };
const all = async (c) => (await db.collection(c).get()).docs.map((d) => Object.assign({ id: d.id }, d.data()));
const codeOf = async (p) => { try { await p; return null; } catch (e) { return e.code || e.message; } };
const msgOf = async (p) => { try { await p; return null; } catch (e) { return String(e.message || ''); } };
const A = 'shopA', B = 'shopB', JANE = '+254712345678';
const queued = async () => (await all('smsQueue')).concat(await all('sms_queue')).concat(await all('smsOutbox'));
const codeFor = async (rid) => { const m = (await queued()).find((x) => x.template === 'points_redeem_code' && String(x.dedupeKey || x.id || '').includes(rid)); const t = m && (m.body || m.text || ''); const x = /Code (\d{6})/.exec(t); return x ? x[1] : null; };
async function reset(balance) {
  for (const c of ['tillRedemptions', 'tillRedeemCodes', 'pointsHolds', 'loyaltyLedger', 'posRetailSales', 'posReceipts', 'posIdempotency', 'posTransactions', 'smsQueue', 'sms_queue', 'smsOutbox']) {
    for (const d of (await db.collection(c).get()).docs) await d.ref.delete();
  }
  await db.doc('loyaltyAccounts/jane').set({ uid: 'jane', loyaltyId: 'SKN-J', balance: balance == null ? 1000 : balance, status: 'active' });
}
const start = (who, shop, extra) => PS.tillStart(db, { uid: who, data: Object.assign({ shopId: shop, phone: '0712 345 678', saleKey: 'SALE-0001', saleTotalKES: 1000, points: 500 }, extra || {}) });
const confirm = (who, shop, rid, code) => PS.tillConfirm(db, { uid: who, data: { shopId: shop, redemptionId: rid, code } });
const sale = (key, shop, pays, extra) => ZF.posCompleteCheckout({ data: Object.assign({ idempotencyKey: key, merchantId: shop, items: [{ productId: 'soap' + (shop === B ? 'B' : ''), qty: 4, unitPrice: 250 }],
  subtotal: 1000, grandTotal: 1000, discountTotal: 0, taxTotal: 0, payments: pays }, extra || {}), auth: { uid: shop, token: { posRole: 'cashier' } } });

const OS = (() => { try { return require(path.join(FN, 'order-settlement.js')); } catch (e) { return { __err: e.message }; } })();
const LPE = (() => { try { return require(path.join(FN, 'loyalty-points.js')); } catch (e) { return { __err: e.message }; } })();
const refund = (saleId, items, key) => ZF.posProcessRefund({ data: { saleId, items, reason: 'customer returned it', merchantId: A, idempotencyKey: key || ('R-' + saleId) },
  auth: { uid: A, token: { posRole: 'owner' } } });
const pointsSale = async (key, qty) => {
  const r = await start('cashA', A, { saleKey: key, saleTotalKES: 250 * qty, points: 500 });
  await confirm('cashA', A, r.redemptionId, await codeFor(r.redemptionId));
  return sale(key, A, [{ method: 'points', amount: r.kes, redemptionId: r.redemptionId }, { method: 'cash', amount: 250 * qty - r.kes }], { buyerPhone: JANE,
    items: [{ productId: 'soap', qty, unitPrice: 250 }], subtotal: 250 * qty, grandTotal: 250 * qty });
};

(async () => {
  if (typeof PS.applyPointsRefundTx !== 'function' || typeof ZF.posProcessRefund !== 'function') { ck('RP0 the refund × points authority exists', false, PS.__err || ZF.__err || 'applyPointsRefundTx missing'); say(`\n${pass} passed, ${fail} failed`); process.exit(1); }
  await db.doc('users/jane').set({ phoneNumber: JANE, displayName: 'Jane Wanjiru' }); AUTH.users.jane = { uid: 'jane', phoneNumber: JANE };
  await db.doc('shops/' + A).set({ name: 'Mama Duka', sellerUid: A }); await db.doc('users/' + A).set({ displayName: 'Owner A' });
  await db.doc('products/soap').set({ name: 'Soap', price: 250, stock: 100, sellerUid: A, shopId: A, status: 'active', isVisible: true });
  await db.doc('products/laptop').set({ name: 'Laptop', price: 75000, stock: 5, sellerUid: A, shopId: A, status: 'active', isVisible: true });

  /* RP1 + RP2 — full refund of a points sale */
  await reset();
  let s1 = null, r1 = null, r1b = null, e1 = null;
  try {
    s1 = await pointsSale('SALE-RP1', 4);
    const afterSale = await get('loyaltyAccounts/jane');
    r1 = await refund(s1.saleId, [{ productId: 'soap', qty: 4 }]);
    r1b = await refund(s1.saleId, [{ productId: 'soap', qty: 4 }]).catch((e) => ({ err: e.message }));
    e1 = { afterSale: afterSale.balance };
  } catch (e) { e1 = { err: e.message }; }
  const acc1 = await get('loyaltyAccounts/jane');
  const rows1 = (await all('loyaltyLedger')).filter((l) => /_reversal$/.test(l.type || ''));
  const rec1 = r1 && await get('posRefunds/' + r1.refundId);
  ck('RP1 a full refund of KES 1,000 = 500 points + 950 cash: 950 goes back as MONEY (not 1,000), the 500 points come back as points, the 95 earned are taken back — the buyer is back where they started',
    s1 && r1 && r1.refundTotal === 950 && r1.pointsRestored === 500 && r1.pointsReversed === 95 && e1.afterSale === 500 + 95 && acc1.balance === 1000
    && rows1.length === 2 && rows1.some((l) => l.type === 'redeem_reversal' && l.fundingShopId === A && l.points === 500) && rows1.some((l) => l.type === 'earn_reversal' && l.points === -95)
    && rec1 && rec1.listValue === 1000 && rec1.pointsValueShareKES === 50,
    { r1, acc: acc1.balance, rows: rows1.map((l) => [l.type, l.points]), e1 });
  const acc1b = await get('loyaltyAccounts/jane');
  ck('RP2 a replayed refund changes nothing (no second money, no second points)', r1b && (r1b.idempotent === true || /already/i.test(r1b.err || '')) && acc1b.balance === 1000
    && (await all('loyaltyLedger')).filter((l) => /_reversal$/.test(l.type || '')).length === 2, { r1b, bal: acc1b.balance });

  /* RP3 — a discounted sale refunds what was paid, not the list price */
  await reset();
  let r3 = null, s3 = null;
  try {
    await db.doc('shopOffers/fl').set({ shopId: A, sellerUid: A, type: 'percentage', template: 'flashSale', status: 'live', name: 'Flash', percent: 10, qualifyingListingIds: ['laptop'], endsAt: new Date(Date.now() + 864e5).toISOString() });
    s3 = await ZF.posCompleteCheckout({ data: { idempotencyKey: 'SALE-RP3', merchantId: A, items: [{ productId: 'laptop', qty: 1, unitPrice: 75000 }], subtotal: 75000, grandTotal: 67500,
      payments: [{ method: 'cash', amount: 67500 }] }, auth: { uid: A, token: { posRole: 'cashier' } } });
    r3 = await refund(s3.saleId, [{ productId: 'laptop', qty: 1 }]);
  } catch (e) { r3 = { err: e.message }; }
  await db.doc('shopOffers/fl').delete();
  ck('RP3 a KES 75,000 laptop sold at 67,500 under a shop offer refunds 67,500 — not the list price', r3 && r3.refundTotal === 67500, r3);

  /* RP4 — partial refund */
  await reset();
  let r4 = null;
  try { const s4 = await pointsSale('SALE-RP4', 4); r4 = await refund(s4.saleId, [{ productId: 'soap', qty: 2 }], 'R-RP4-half'); } catch (e) { r4 = { err: e.message }; }
  const acc4 = await get('loyaltyAccounts/jane');
  ck('RP4 refunding 2 of 4: half the money (475), half the points given back (250), half the earned taken back (47)',
    r4 && r4.refundTotal === 475 && r4.pointsRestored === 250 && r4.pointsReversed === 47 && acc4.balance === 500 + 95 + 250 - 47, { r4, bal: acc4.balance });

  /* RP5 — earned points already spent */
  await reset();
  let r5 = null;
  try {
    const s5 = await pointsSale('SALE-RP5', 4);
    await db.doc('loyaltyAccounts/jane').set({ balance: 0 }, { merge: true });            /* spent elsewhere meanwhile */
    r5 = await refund(s5.saleId, [{ productId: 'soap', qty: 4 }]);
  } catch (e) { r5 = { err: e.message }; }
  const alerts5 = await all('pointsRefundAlerts'); const acc5 = await get('loyaltyAccounts/jane');
  ck('RP5 the earned points were already spent: the refund still goes through, the 500 given back cover 95 taken back, and nothing goes negative',
    r5 && r5.refundTotal === 950 && r5.pointsRestored === 500 && r5.pointsReversed === 95 && acc5.balance === 405 && alerts5.length === 0, { r5, bal: acc5.balance, alerts: alerts5.length });
  await reset();
  let r5b = null;
  try {
    const s5b = await ZF.posCompleteCheckout({ data: { idempotencyKey: 'SALE-RP5B', merchantId: A, items: [{ productId: 'soap', qty: 4, unitPrice: 250 }], subtotal: 1000, grandTotal: 1000,
      payments: [{ method: 'cash', amount: 1000 }], buyerPhone: JANE }, auth: { uid: A, token: { posRole: 'cashier' } } });
    await db.doc('loyaltyAccounts/jane').set({ balance: 40 }, { merge: true });
    r5b = await refund(s5b.saleId, [{ productId: 'soap', qty: 4 }]);
  } catch (e) { r5b = { err: e.message }; }
  const al5b = await all('pointsRefundAlerts'); const acc5b = await get('loyaltyAccounts/jane');
  ck('RP5b 100 earned, only 40 left: 40 are taken, the 60 shortfall is flagged, the balance is 0 (never negative), and the money refund stands',
    r5b && r5b.refundTotal === 1000 && r5b.pointsReversed === 40 && acc5b.balance === 0 && al5b.length === 1 && al5b[0].shortfall === 60, { r5b, bal: acc5b.balance, alerts: al5b.map((a) => a.shortfall) });

  /* RP6 — online order refund */
  await reset();
  let o6 = {};
  try {
    await db.doc('orders/ORD-RP6').set({ sellerUid: A, settlementStatus: 'HELD', total: 900 });
    await PS.placeHold(db, { uid: 'jane', channel: 'order', ref: 'ORD-RP6', points: 1000, kes: 100, fundingShops: [{ shopId: A, kes: 100, points: 1000 }] });
    await PS.consumeHold(db, { channel: 'order', ref: 'ORD-RP6', orderId: 'ORD-RP6', saleRef: 'PAY6' });
    await LPE.earnForSale(db, { buyerUid: 'jane', issuerShopId: A, saleId: 'ORD-RP6', amountKES: 900, source: 'online' });
    o6.before = (await get('loyaltyAccounts/jane')).balance;
    o6.res = await OS.handleOrderRefund(db, ADMIN, 'ORD-RP6', { reason: 'customer_request', refundRef: 'RFD1' });
    o6.after = (await get('loyaltyAccounts/jane')).balance;
    o6.res2 = await OS.handleOrderRefund(db, ADMIN, 'ORD-RP6', { reason: 'customer_request', refundRef: 'RFD1' });
    o6.after2 = (await get('loyaltyAccounts/jane')).balance;
  } catch (e) { o6.err = e.message; }
  ck('RP6 an online order refunded in full: its 1,000 spent points come back and its 90 earned go — once (a repeated refund changes nothing)',
    o6.before === 90 && o6.res && o6.res.points && o6.res.points.restored === 1000 && o6.res.points.reversed === 90 && o6.after === 1000 && o6.after2 === 1000,
    { before: o6.before, pts: o6.res && o6.res.points, after: o6.after, after2: o6.after2, err: o6.err });

  /* RP7 — no points on the sale */
  await reset();
  let r7 = null;
  try { const s7 = await ZF.posCompleteCheckout({ data: { idempotencyKey: 'SALE-RP7', merchantId: A, items: [{ productId: 'soap', qty: 4, unitPrice: 250 }], subtotal: 1000, grandTotal: 1000,
    payments: [{ method: 'cash', amount: 1000 }] }, auth: { uid: A, token: { posRole: 'cashier' } } }); r7 = await refund(s7.saleId, [{ productId: 'soap', qty: 4 }]); } catch (e) { r7 = { err: e.message }; }
  ck('RP7 a sale with no points refunds exactly as before (KES 1,000, no points rows)', r7 && r7.refundTotal === 1000 && !r7.pointsRestored && !r7.pointsReversed
    && (await all('loyaltyLedger')).filter((l) => /_reversal$/.test(l.type || '')).length === 0, r7);

  /* RP8 — isolation */
  await reset();
  let iso = {};
  try {
    const sA = await pointsSale('SALE-RP8A', 4);
    const sB = await ZF.posCompleteCheckout({ data: { idempotencyKey: 'SALE-RP8B', merchantId: A, items: [{ productId: 'soap', qty: 4, unitPrice: 250 }], subtotal: 1000, grandTotal: 1000,
      payments: [{ method: 'cash', amount: 1000 }], buyerPhone: JANE }, auth: { uid: A, token: { posRole: 'cashier' } } });
    await refund(sA.saleId, [{ productId: 'soap', qty: 4 }]);
    iso.bEarn = await get('loyaltyLedger/earn__till__' + sB.saleId);
  } catch (e) { iso.err = e.message; }
  ck('RP8 refunding one sale never touches another sale\'s points', iso.bEarn && iso.bEarn.points === 100 && !iso.bEarn.reversedPoints, iso);

  say(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { say('CRASH ' + (e && e.stack || e)); process.exit(2); });
