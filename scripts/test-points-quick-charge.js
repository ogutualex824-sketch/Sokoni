/* test-points-quick-charge.js — Quick Charge × SOKONI points (2026-09-29).
 * Quick Charge spends points through the SAME buyer-confirmed till redemption the POS uses — bound to the Quick Charge
 * transaction (its sale id), priced by the one Quick Charge price authority (payment-purposes pos_till_sale), spent by
 * the webhook when the rest is PAID, receipted in the canonical posReceipts store, reversed by the one refund rule.
 *
 * PROVES
 *   QC1 1,000 confirmed points take KES 100 off a KES 1,000 charge (server value; client figures ignored); retry-stable
 *   QC2 bound: no sale id / another charge / another shop / buyer-typed Till / over 25% / unconfirmed / unknown -> refused
 *   QC3 PAID spends the hold once, earns on the money once; a refund reverses both through the established rules
 *   QC4 (STRUCTURAL) webhook wiring: one authority, spend on PAID, redemption consumed, components, canonical receipt
 */
'use strict';
process.env.GCLOUD_PROJECT = 'demo-points-qc';
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

const PP = (() => { try { return require(path.join(FN, 'payment-purposes.js')); } catch (e) { return { __err: e.message }; } })();
const LPE = (() => { try { return require(path.join(FN, 'loyalty-points.js')); } catch (e) { return { __err: e.message }; } })();
const src = (f) => { try { return require('fs').readFileSync(path.join(ROOT, f), 'utf8'); } catch (_) { return ''; } };
const TILL_A = { sokoniTillId: 'TILLA', shopId: A, branchId: 'main', merchantUid: A, status: 'ACTIVE', currency: 'KES' };
const TILL_B = { sokoniTillId: 'TILLB', shopId: B, branchId: 'main', merchantUid: B, status: 'ACTIVE', currency: 'KES' };
const qcPrice = (uid, till, extra) => PP.PURPOSES.pos_till_sale.price(uid, Object.assign({ sokoniTillId: till, items: [{ name: 'Haircut', price: 1000, qty: 1 }] }, extra || {}));
const held = async (saleKey, total, pts) => { const r = await start('cashA', A, { saleKey, saleTotalKES: total || 1000, points: pts || 1000 }); await confirm('cashA', A, r.redemptionId, await codeFor(r.redemptionId)); return r; };

(async () => {
  if (typeof PS.validateQuickChargeRedemption !== 'function') { ck('QC0 Quick Charge uses the till redemption authority', false, PS.__err || 'validateQuickChargeRedemption missing'); say(`\n${pass} passed, ${fail} failed`); process.exit(1); }
  await db.doc('users/jane').set({ phoneNumber: JANE, displayName: 'Jane Wanjiru' }); AUTH.users.jane = { uid: 'jane', phoneNumber: JANE };
  await db.doc('shops/' + A).set({ name: 'Mama Duka', sellerUid: A }); await db.doc('shops/' + B).set({ name: 'Duka B', sellerUid: B });
  await db.doc('sokoniTills/TILLA').set(TILL_A); await db.doc('sokoniTills/TILLB').set(TILL_B);

  /* QC1 */
  await reset();
  let q1 = {};
  try {
    const r = await held('QCSALE001');
    const p = await qcPrice(A, 'TILLA', { saleId: 'QCSALE001', pointsRedemptionId: r.redemptionId, pointsDiscount: 999, amount: 1 });
    q1 = { amount: p.amountCents / 100, md: p.metadata };
    q1.again = (await qcPrice(A, 'TILLA', { saleId: 'QCSALE001', pointsRedemptionId: r.redemptionId })).amountCents / 100;
    q1.plain = (await qcPrice(A, 'TILLA', {})).amountCents / 100;
  } catch (e) { q1.err = e.message; }
  ck('QC1 a KES 1,000 Quick Charge with 1,000 confirmed points asks the customer for KES 900; the server read the value (a client KES 999 is ignored); the intent records sale total, points and funding shop; a retry prices the same; without points it is 1,000',
    q1.amount === 900 && q1.md && q1.md.saleTotal === 1000 && q1.md.pointsRedeemed === 1000 && q1.md.pointsDiscount === 100 && q1.md.pointsFunding[0].shopId === A
    && q1.again === 900 && q1.plain === 1000, q1);

  /* QC2 — binding */
  await reset(5000);
  let q2 = {};
  try {
    const r = await held('QCSALE002');
    q2.noSale = await msgOf(qcPrice(A, 'TILLA', { pointsRedemptionId: r.redemptionId }));
    q2.otherSale = await msgOf(qcPrice(A, 'TILLA', { saleId: 'QCSALE999', pointsRedemptionId: r.redemptionId }));
    q2.otherShop = await msgOf(qcPrice(B, 'TILLB', { saleId: 'QCSALE002', pointsRedemptionId: r.redemptionId }));
    q2.buyerTyped = await msgOf(PP.PURPOSES.pos_till_sale.price(A, { sokoniTillId: 'TILLA', amount: 1000, saleId: 'QCSALE002', pointsRedemptionId: r.redemptionId }));
    q2.over25 = await msgOf(qcPrice(A, 'TILLA', { saleId: 'QCSALE002', pointsRedemptionId: r.redemptionId, items: [{ name: 'Tip', price: 200, qty: 1 }] }));
    const pending = await start('cashA', A, { saleKey: 'QCSALE003', saleTotalKES: 1000, points: 500 });
    q2.unconfirmed = await msgOf(qcPrice(A, 'TILLA', { saleId: 'QCSALE003', pointsRedemptionId: pending.redemptionId }));
    q2.fake = await msgOf(qcPrice(A, 'TILLA', { saleId: 'QCSALE004', pointsRedemptionId: 'fakeRedemption01' }));
  } catch (e) { q2.err = e.message; }
  ck('QC2 the points are bound: refused with no sale id, for another charge, on another shop\'s Till, on a buyer-typed Till payment, above 25% of THIS charge, when not confirmed, and for an unknown confirmation',
    /sale reference/.test(q2.noSale || '') && /different sale/.test(q2.otherSale || '') && /another shop/.test(q2.otherShop || '') && /cashier rings up/.test(q2.buyerTyped || '')
    && /at most 25%/.test(q2.over25 || '') && /not confirmed/.test(q2.unconfirmed || '') && /Unknown points confirmation/.test(q2.fake || ''), q2);

  /* QC3 — PAID: spent once, earn once on the money, refund linkage */
  await reset();
  let q3 = {};
  try {
    const r = await held('QCSALE005');
    const p = await qcPrice(A, 'TILLA', { saleId: 'QCSALE005', pointsRedemptionId: r.redemptionId, buyerPhone: JANE });
    const intentRef = 'POSTILL-TILLA-QCSALE005';
    const md = p.metadata;
    /* exactly what the webhook's PAID branch does (functions/index.js — Quick Charge × points) */
    const paid = async () => {
      await PS.consumeHold(db, { channel: 'till', ref: md.pointsRedemptionId, uid: md.pointsBuyerUid, orderId: intentRef, saleRef: intentRef,
        expect: { points: md.pointsRedeemed, kes: md.pointsDiscount, fundingShops: md.pointsFunding } });
      await LPE.earnForSale(db, { buyerPhone: JANE, issuerShopId: A, saleId: intentRef, amountKES: p.amountCents / 100, source: 'quick' });
    };
    await paid(); await paid();
    q3.acc = await get('loyaltyAccounts/jane');
    q3.redeems = (await all('loyaltyLedger')).filter((l) => l.type === 'redeem');
    q3.earns = (await all('loyaltyLedger')).filter((l) => l.type === 'earn' && l.orderId === intentRef);
    q3.refund = await PS.refundOrderPoints(db, { orderId: intentRef, refundKey: 'qc_refund_' + intentRef, ratio: 1 });
    q3.accAfter = await get('loyaltyAccounts/jane');
  } catch (e) { q3.err = e.message; }
  ck('QC3 when the rest is PAID the held 1,000 are spent ONCE (a replayed webhook changes nothing), 90 are earned on the KES 900 paid in money ONCE, and a refund of that charge reverses both through the same rules',
    q3.acc && q3.acc.balance === 90 && q3.acc.heldPoints === 0 && q3.redeems.length === 1 && q3.redeems[0].fundingShopId === A && q3.earns.length === 1 && q3.earns[0].points === 90
    && q3.refund && q3.refund.restored === 1000 && q3.refund.reversed === 90 && q3.accAfter.balance === 1000,
    { bal: q3.acc && q3.acc.balance, redeems: q3.redeems && q3.redeems.length, earns: q3.earns && q3.earns.map((e) => e.points), refund: q3.refund, after: q3.accAfter && q3.accAfter.balance, err: q3.err });

  /* QC4 — wiring (STRUCTURAL: the webhook is inline in index.js) */
  const ix = src('functions/index.js'), pp = src('functions/payment-purposes.js');
  const w = {
    oneAuthority: /require\('\.\/loyalty-points-spend'\)\.validateQuickChargeRedemption\(db\(\)/.test(pp) && !/quickCharge.*loyalty/i.test(src('functions/loyalty-points.js')),
    spendsOnPaid: /_PSq\.consumeHold\(db, \{ channel: "till", ref: String\(_rid\), uid: _qmd\.pointsBuyerUid \|\| null, orderId: _intentRef2/.test(ix),
    redemptionConsumed: /\.doc\(String\(_rid\)\)\.set\(\{ status: "consumed", saleId: _intentRef2/.test(ix),
    components: /paymentComponents: _components/.test(ix) && /method: "points", amount: Number\(_qmd\.pointsDiscount\)/.test(ix),
    canonicalReceipt: /db\.collection\("posReceipts"\)\.doc\(_intentRef2\)\.create\(\{/.test(ix) && /pointsRedeemed: \{ points: Number\(_qmd\.pointsRedeemed\)/.test(ix) && /paidInMoney: amount/.test(ix),
    earnOnMoney: /saleId: _intentRef2, amountKES: amount, source: "quick"/.test(ix),
  };
  ck('QC4 (STRUCTURAL) the pricer calls the one till redemption authority; the webhook spends the hold on PAID keyed by the intent, marks the redemption consumed, records the payment components, writes the receipt to the canonical posReceipts store with points and money, and earns on the money only',
    Object.values(w).every(Boolean), w);

  say(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { say('CRASH ' + (e && e.stack || e)); process.exit(2); });
