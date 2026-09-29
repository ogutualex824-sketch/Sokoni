/* test-points-p2b.js — SOKONI Points P2b (2026-09-29): PAY WITH POINTS AT THE TILL, confirmed by the BUYER.
 *
 * Owner: "SOKONI sends a one-time confirmation code to that phone. The buyer reads the code back to the cashier … Only
 * the server can authorize the redemption … bound to buyer/account, shop, redemption amount, points amount, expiry,
 * one-time-use state"; "Shop B absorbs KES 50.00"; 25% everywhere; commission on the money received; KRA: points are a
 * shop discount for tax. Adversarial: wrong buyer / shop / code, expired, reused, altered points or KES, insufficient,
 * concurrent, retry, cross-shop, legacy POS record.
 *
 * REAL loyalty-points-spend (tillStart / tillConfirm / tillCancel / validateTillTender), loyalty-points, sms-service
 * (QUEUE ONLY — the code is read back out of the queued text, as the buyer would), and pos-zero-friction
 * posCompleteCheckout over the transactional fake Firestore. Firebase Auth is stubbed.
 *
 *   Shop A (Mama Duka) · Soap KES 250 · buyer Jane 0712 345 678 with 1,000 points
 *
 * PROVES
 *   PB1  start: this shop's staff only; the value comes from the server (500 pts = KES 50.00; capped at 25% of the
 *        sale); the code is NOT in the response, it is QUEUED to the buyer (security category) and stored only hashed
 *   PB2  confirm: a wrong code counts down and locks at 5; another shop cannot confirm; an expired code is refused;
 *        the right code HOLDS the points (1,000 → 500, held 500)
 *   PB3  CONCURRENT confirms with the right code hold the points ONCE; a repeated confirm is a harmless replay
 *   PB4  the sale: KES 1,000 = 500 points (KES 50) + KES 950 cash — completes; the hold and the code are consumed;
 *        the ledger names shop A as funder; the receipt shows points and money; the buyer earns on the 950 only
 *   PB5  the confirmation is bound to its sale: a retry of the SAME sale returns it (no second spend); another sale,
 *        and a reuse after it was spent, are refused
 *   PB6  altered figures are refused BEFORE anything is written: amount ≠ KES 50, a 'loyalty' tender, no confirmation
 *   PB7  cross-shop: shop A's confirmation cannot pay shop B's sale
 *   PB8  25% at the till: a KES 150 sale cannot take KES 50 of points (at most KES 37)
 *   PB9  insufficient: points spent elsewhere between the code and the confirm → nothing held, the redemption failed
 *   PB10 cancel releases the held points
 *   PB11 the books: points are not money (drawer route; electronic 0; pointsCents); commission on KES 950; the VAT
 *        estimate is on the reduced price and counts quantities
 *   PB13 every business that sells accepts SOKONI Points Terms v1.0 (the spending business funds the points)
 *   PB12 no legacy substitution: loyaltyRedeemPoints still refused; a number known only to the shop-local POS CRM has
 *        no SOKONI points to spend
 *
 *   node scripts/test-points-p2b.js
 */
'use strict';
process.env.GCLOUD_PROJECT = 'demo-points-p2b';
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

(async () => {
  if (typeof PS.tillStart !== 'function' || typeof ZF.posCompleteCheckout !== 'function') { ck('PB0 till redemption exists', false, PS.__err || ZF.__err || 'tillStart missing'); say(`\n${pass} passed, ${fail} failed`); process.exit(1); }
  await db.doc('users/jane').set({ phoneNumber: JANE, displayName: 'Jane Wanjiru' }); AUTH.users.jane = { uid: 'jane', phoneNumber: JANE };
  await db.doc('shops/' + A).set({ name: 'Mama Duka', sellerUid: A }); await db.doc('shops/' + B).set({ name: 'Duka B', sellerUid: B });
  await db.doc('users/' + A).set({ displayName: 'Owner A' }); await db.doc('users/' + B).set({ displayName: 'Owner B' });
  await db.doc('merchants/' + A).set({ vatStatus: 'registered' });
  await db.doc('products/soap').set({ name: 'Soap', price: 250, stock: 100, sellerUid: A, shopId: A, status: 'active', isVisible: true });
  await db.doc('products/soapB').set({ name: 'Soap', price: 250, stock: 100, sellerUid: B, shopId: B, status: 'active', isVisible: true });

  /* PB1 */
  await reset();
  const stranger = await codeOf(start('mallory', A));
  const unknown = await codeOf(PS.tillStart(db, { uid: 'cashA', data: { shopId: A, phone: '0700999888', saleKey: 'SALE-0001', saleTotalKES: 1000 } }));
  const r1 = await start('cashA', A);
  const capped = await start('cashA', A, { saleKey: 'SALE-0002', points: 5000 });
  const doc1 = await get('tillRedemptions/' + r1.redemptionId);
  const msg1 = (await queued()).find((m) => m.template === 'points_redeem_code');
  const code1 = await codeFor(r1.redemptionId);
  ck('PB1 start: staff only; server values (500 pts = KES 50.00; 5,000 asked on a 1,000 sale capped to 1,000 pts = KES 100); the code is queued to the buyer, never returned, stored hashed',
    stranger === 'permission-denied' && unknown === 'not-found' && r1.points === 500 && r1.kes === 50 && r1.valueText === 'KES 50.00' && r1.maskedPhone === '••••678'
    && capped.points === 1000 && capped.kes === 100 && !JSON.stringify(r1).includes(String(code1)) && !!code1
    && msg1 && msg1.to === JANE && /Mama Duka/.test(msg1.body || '') && doc1.codeHash && doc1.codeHash !== code1 && !JSON.stringify(doc1).includes(code1)
    && require(path.join(FN, 'sms-service.js')).render('points_redeem_code', { code: '1' }).pref === 'security',
    { stranger, unknown, r1: { points: r1.points, kes: r1.kes, v: r1.valueText }, capped: [capped.points, capped.kes], code: !!code1 });

  /* PB2 */
  const p2 = {};
  try {
    p2.wrong = await msgOf(confirm('cashA', A, r1.redemptionId, '000000' === code1 ? '111111' : '000000'));
    p2.otherShop = await codeOf(confirm('cashB', B, r1.redemptionId, code1));
    p2.lockR = await start('cashA', A, { saleKey: 'SALE-LOCK' });
    for (let i = 0; i < 5; i++) await codeOf(confirm('cashA', A, p2.lockR.redemptionId, '999999' === (await codeFor(p2.lockR.redemptionId)) ? '888888' : '999999'));
    p2.locked = (await get('tillRedemptions/' + p2.lockR.redemptionId)).status;
    p2.lockedRight = await codeOf(confirm('cashA', A, p2.lockR.redemptionId, await codeFor(p2.lockR.redemptionId)));
    p2.expR = await start('cashA', A, { saleKey: 'SALE-EXP' });
    await db.doc('tillRedemptions/' + p2.expR.redemptionId).set({ expiresAtMs: Date.now() - 1 }, { merge: true });
    p2.expired = await codeOf(confirm('cashA', A, p2.expR.redemptionId, await codeFor(p2.expR.redemptionId)));
    p2.ok1 = await confirm('cashA', A, r1.redemptionId, code1);
    p2.acc1 = await get('loyaltyAccounts/jane');
  } catch (e) { p2.err = e.message; }
  const acc1 = p2.acc1 || {};
  ck('PB2 confirm: a wrong code counts down, 5 lock it (even the right code then fails); another shop is refused; an expired code is refused; the right code HOLDS 500',
    /4 tries left/.test(p2.wrong || '') && p2.otherShop === 'permission-denied' && p2.locked === 'locked' && p2.lockedRight === 'failed-precondition' && p2.expired === 'deadline-exceeded'
    && p2.ok1 && p2.ok1.points === 500 && acc1.balance === 500 && acc1.heldPoints === 500 && ((await get('tillRedemptions/' + r1.redemptionId)) || {}).status === 'confirmed',
    { wrong: p2.wrong, otherShop: p2.otherShop, locked: p2.locked, lockedRight: p2.lockedRight, expired: p2.expired, bal: acc1.balance, held: acc1.heldPoints, err: p2.err });

  /* PB3 */
  await reset();
  const r3 = await start('cashA', A, { saleKey: 'SALE-0003' }); const c3 = await codeFor(r3.redemptionId);
  const both = await Promise.allSettled([confirm('cashA', A, r3.redemptionId, c3), confirm('cashA', A, r3.redemptionId, c3)]);
  const again = await confirm('cashA', A, r3.redemptionId, c3).then((x) => x, (e) => ({ err: e.code }));
  const acc3 = await get('loyaltyAccounts/jane');
  ck('PB3 two confirms at once hold the points ONCE (1,000 → 500); a repeated confirm is a replay, not a second hold',
    acc3.balance === 500 && acc3.heldPoints === 500 && both.filter((x) => x.status === 'fulfilled').length >= 1 && again.ok === true,
    { both: both.map((x) => x.status === 'fulfilled' ? 'ok' : x.reason.code), again, bal: acc3.balance, held: acc3.heldPoints });

  /* PB4 + PB11 */
  await reset();
  const r4 = await start('cashA', A, { saleKey: 'SALE-0004' }); await confirm('cashA', A, r4.redemptionId, await codeFor(r4.redemptionId));
  let s4 = null, e4 = null;
  try { s4 = await sale('SALE-0004', A, [{ method: 'points', amount: 50, redemptionId: r4.redemptionId }, { method: 'cash', amount: 950 }], { buyerPhone: JANE }); } catch (e) { e4 = e.message; }
  const acc4 = await get('loyaltyAccounts/jane');
  const red4 = (await all('loyaltyLedger')).filter((l) => l.type === 'redeem');
  const earn4 = await get('loyaltyLedger/earn__till__' + (s4 && s4.saleId));
  const rec4 = s4 && await get('posReceipts/' + s4.saleId);
  const sale4 = s4 && await get('posRetailSales/' + s4.saleId);
  ck('PB4 KES 1,000 = 500 points (KES 50) + 950 cash: completes; hold + code consumed; ledger funder = shop A; receipt shows points and money; earns 95 (on 950 only)',
    s4 && s4.saleId && acc4.balance === 500 + 95 && acc4.heldPoints === 0 && acc4.totalRedeemed === 500 && red4.length === 1 && red4[0].fundingShopId === A && red4[0].points === -500
    && (await get('pointsHolds/till__' + r4.redemptionId)).status === 'consumed' && (await get('tillRedemptions/' + r4.redemptionId)).status === 'consumed'
    && ((rec4 && rec4.pointsRedeemed) || (s4.receipt && s4.receipt.pointsRedeemed) || {}).kes === 50 && (((rec4 || s4.receipt) || {}).paidInMoney === 950)
    && earn4 && earn4.points === 95 && sale4 && sale4.pointsRedeemed && sale4.pointsRedeemed.fundingShopId === A,
    { err: e4, bal: acc4.balance, held: acc4.heldPoints, red: red4.map((l) => [l.fundingShopId, l.points]), earn: earn4 && earn4.points, rec: rec4 && [rec4.pointsRedeemed, rec4.paidInMoney] });
  const pos = sale4 && sale4.position, com = sale4 && sale4.commission, tax = sale4 && sale4.tax;
  ck('PB11 the books: points are not money (drawer route, electronic 0, pointsCents 5000); commission basis KES 950; VAT estimated on 950 across quantity 4',
    pos && pos.pointsCents === 5000 && pos.electronicCents === 0 && pos.cashCents === 95000 && sale4.collectionRoute === 'CASH_IN_DRAWER'
    && com && com.basisCents === 95000 && tax && tax.totalCents === 95000,
    { pos, basis: com && com.basisCents, tax: tax && { total: tax.totalCents, taxable: tax.taxableCents, vat: tax.vatCents }, route: sale4 && sale4.collectionRoute });

  /* PB5 */
  let retry = null; try { retry = await sale('SALE-0004', A, [{ method: 'points', amount: 50, redemptionId: r4.redemptionId }, { method: 'cash', amount: 950 }]); } catch (e) { retry = { err: e.message }; }
  const reuse = await msgOf(sale('SALE-0005', A, [{ method: 'points', amount: 50, redemptionId: r4.redemptionId }, { method: 'cash', amount: 950 }]));
  const acc5 = await get('loyaltyAccounts/jane');
  await reset();
  const r5 = await start('cashA', A, { saleKey: 'SALE-0006' }); await confirm('cashA', A, r5.redemptionId, await codeFor(r5.redemptionId));
  const otherSale = await msgOf(sale('SALE-0007', A, [{ method: 'points', amount: 50, redemptionId: r5.redemptionId }, { method: 'cash', amount: 950 }]));
  ck('PB5 bound to its sale: a retry of the SAME sale returns it without a second spend; another sale (after it was spent, or before) is refused',
    retry && retry.saleId === (s4 && s4.saleId) && acc5.balance === 595 && acc5.totalRedeemed === 500 && /different sale/.test(reuse || '') && /different sale/.test(otherSale || ''),
    { retry: retry && (retry.saleId || retry.err), reuse, otherSale, bal: acc5.balance });

  /* PB6 */
  const salesBefore = (await all('posRetailSales')).length;
  const altered = await msgOf(sale('SALE-0006', A, [{ method: 'points', amount: 100, redemptionId: r5.redemptionId }, { method: 'cash', amount: 900 }]));
  const aliased = await msgOf(sale('SALE-0006', A, [{ method: 'loyalty', amount: 50, redemptionId: r5.redemptionId }, { method: 'cash', amount: 950 }]));
  const bare = await msgOf(sale('SALE-0006', A, [{ method: 'points', amount: 50 }, { method: 'cash', amount: 950 }]));
  const stillHeld = (await get('pointsHolds/till__' + r5.redemptionId)).status;
  ck('PB6 altered figures refused before anything is written: KES 100 for a KES 50 confirmation, a "loyalty" tender, a points tender with no confirmation',
    /exactly KES 50/.test(altered || '') && /confirmation code/.test(aliased || '') && /confirmation code/.test(bare || '')
    && (await all('posRetailSales')).length === salesBefore && stillHeld === 'held', { altered, aliased, bare, stillHeld });

  /* PB7 */
  const crossB = await msgOf(ZF.posCompleteCheckout({ data: { idempotencyKey: 'SALE-0006', merchantId: B, items: [{ productId: 'soapB', qty: 4, unitPrice: 250 }], subtotal: 1000, grandTotal: 1000,
    payments: [{ method: 'points', amount: 50, redemptionId: r5.redemptionId }, { method: 'cash', amount: 950 }] }, auth: { uid: B, token: { posRole: 'cashier' } } }));
  ck('PB7 cross-shop: shop A\'s confirmation cannot pay shop B\'s sale', /another shop/.test(crossB || ''), crossB);

  /* PB8 */
  const tiny = await msgOf(ZF.posCompleteCheckout({ data: { idempotencyKey: 'SALE-0006', merchantId: A, items: [{ productId: 'soap', qty: 1, unitPrice: 250 }], subtotal: 250, grandTotal: 150, discountTotal: 100,
    payments: [{ method: 'points', amount: 50, redemptionId: r5.redemptionId }, { method: 'cash', amount: 100 }] }, auth: { uid: A, token: { posRole: 'cashier' } } }));
  ck('PB8 25% at the till: a KES 150 sale (after a 100 discount) cannot take KES 50 of points — at most KES 37', String(tiny || '').includes('at most 25% of this sale (KES 37)'), tiny);

  /* PB9 */
  await reset();
  const r9 = await start('cashA', A, { saleKey: 'SALE-0009' });
  await db.doc('loyaltyAccounts/jane').set({ balance: 100 }, { merge: true });          /* spent elsewhere meanwhile */
  const insuff = await codeOf(confirm('cashA', A, r9.redemptionId, await codeFor(r9.redemptionId)));
  ck('PB9 points spent elsewhere between the code and the confirm: nothing is held and the redemption is marked failed',
    insuff === 'failed-precondition' && (await get('tillRedemptions/' + r9.redemptionId)).status === 'failed' && (await get('loyaltyAccounts/jane')).balance === 100
    && !(await get('pointsHolds/till__' + r9.redemptionId)), insuff);

  /* PB10 */
  await reset();
  const r10 = await start('cashA', A, { saleKey: 'SALE-0010' }); await confirm('cashA', A, r10.redemptionId, await codeFor(r10.redemptionId));
  const mid = (await get('loyaltyAccounts/jane')).balance;
  const cx = await PS.tillCancel(db, { uid: 'cashA', data: { shopId: A, redemptionId: r10.redemptionId } });
  const acc10 = await get('loyaltyAccounts/jane');
  ck('PB10 cancel releases the held points (500 → 1,000) and closes the redemption', mid === 500 && cx.released && acc10.balance === 1000 && acc10.heldPoints === 0
    && (await get('tillRedemptions/' + r10.redemptionId)).status === 'cancelled', { mid, bal: acc10.balance });

  /* PB12 */
  await db.doc('posCustomers/legacy1').set({ merchantId: A, phone: '254733000111', loyaltyPoints: 40000 });
  const legacyStart = await codeOf(PS.tillStart(db, { uid: 'cashA', data: { shopId: A, phone: '0733000111', saleKey: 'SALE-0012', saleTotalKES: 1000 } }));
  const legacyRedeem = await codeOf(sale('SALE-0013', A, [{ method: 'cash', amount: 1000 }], { loyaltyRedeemPoints: 500 }));
  ck('PB12 no legacy substitution: a number known only to the shop-local POS CRM (40,000 points there) has no SOKONI points to spend; loyaltyRedeemPoints still refused',
    legacyStart === 'not-found' && legacyRedeem === 'failed-precondition', { legacyStart, legacyRedeem });

  /* PB13 — every business agreement says who pays */
  let p13 = {};
  try {
    const LA = require(path.join(FN, 'legal-agreements.js'));
    const selling = ['merchant', 'provider', 'property', 'hotel', 'restaurant', 'healthcare', 'event_organizer', 'creator', 'venue_owner'];
    p13.missing = selling.filter((r) => !(LA.ROLE_AGREEMENTS[r] || []).some((a) => a.id === 'sokoni-points-terms' && a.version === '1.0'));
    p13.wrongly = ['driver', 'rider', 'employer'].filter((r) => (LA.ROLE_AGREEMENTS[r] || []).some((a) => a.id === 'sokoni-points-terms'));
    const t = (LA.ROLE_AGREEMENTS.merchant || []).find((a) => a.id === 'sokoni-points-terms') || {};
    p13.funding = (t.keyPoints || []).some((k) => /YOU fund that discount/.test(k)) && (t.keyPoints || []).some((k) => /10 points are worth KES 1/.test(k));
    p13.page = /id="sokoni-points"[\s\S]{0,1200}you fund that discount/.test(require('fs').readFileSync(path.join(ROOT, 'legal.html'), 'utf8'));
  } catch (e) { p13.err = e.message; }
  ck('PB13 every business that sells (9 roles) accepts SOKONI Points Terms v1.0, which says the business where points are SPENT funds them; drivers, riders and employers do not; the public Seller Agreement carries the same clause',
    p13.missing && p13.missing.length === 0 && p13.wrongly.length === 0 && p13.funding && p13.page, p13);

  say(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { say('CRASH ' + (e && e.stack || e)); process.exit(2); });
