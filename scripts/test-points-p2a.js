/* test-points-p2a.js — SOKONI Points P2a (2026-09-29): SPENDING ONLINE. One rate, held points, one price on every rail.
 *
 * Owner: "10 points = KES 1 … the shop where the redemption occurs funds that redemption"; "P2 changes the canonical rate
 * everywhere from KES 0.50 / point to KES 0.10 / point. That must be one server authority"; "Both M-Pesa and card must
 * receive the same KES 900 payable amount"; "points should remain subject to the existing maximum 25% of order value".
 *
 * REAL functions/loyalty-points-spend.js, loyalty-points.js, shop-offers.quoteForCaller, payment-purposes product_order
 * (the M-PESA charge), payment-attribution, and _finalizeMarketplacePayment (extracted verbatim) over the transactional
 * fake Firestore (optimistic retry — concurrency is real here). createCheckoutSession and verifyIntasendPayment are
 * inline in index.js: their wiring is checked STRUCTURALLY (PS11) and labelled so — their arithmetic is the shared
 * module exercised below.
 *
 *   Mouse KES 1,000 · Laptop KES 75,000 (Weekend Flash Sale 10%) · shop A · buyer balances seeded per case
 *
 * PROVES
 *   PS1  the rate: 10 points = KES 1; cap = min(points, 25% of goods after offers, payable − 1), whole shillings;
 *        funding split across shops by goods
 *   PS2  PARITY: the same cart costs the same on M-PESA (product_order) and card (session hold) — 1,000 → 900 using
 *        1,000 points — and the checkout display quote says exactly that
 *   PS3  the M-PESA intent: a retry re-prices to the SAME amount without holding twice; switching points off releases them
 *   PS3b a DOUBLE TAP (two concurrent intents for ONE order): priced alike, held ONCE — never twice, never lost
 *   PS4  the 25% ceiling holds against a large balance, and is taken on goods AFTER the shop's offer
 *   PS5  client-supplied figures are ignored: a points amount / rate in the request, and points in legacy meta
 *   PS6  CONCURRENCY: two orders priced at once against 1,000 points — exactly one gets them; the balance never goes
 *        negative; the other pays in full and is told why
 *   PS7  spent exactly once: the payment consumes the hold (a replay adds nothing); the ledger names the SPENDING shop
 *        as funder and the earn lot (another shop) the points came from
 *   PS8  an abandoned order's hold is released (balance + lot restored); an expired hold whose payment DID land is
 *        consumed, never released
 *   PS9  a payment landing after its hold was released re-deducts; if the points are gone the sale stands and the
 *        shortfall is flagged — never refused
 *   PS10 the order records points only when spent (finalisation)
 *   PS11 wiring (STRUCTURAL): the card session holds via the same authority and no longer trims held points; the verify
 *        transaction reads the hold before its first write and spends it; the uncapped increment(−points) is gone; the
 *        webhook spends the order hold; checkout.html has no rate of its own and sends redeemLoyalty on M-PESA too
 *   PS12 no legacy substitution: a shop-local posCustomers balance is never spent; a blocked account redeems nothing;
 *        the till still refuses the legacy loyaltyRedeemPoints figure
 *
 *   node scripts/test-points-p2a.js
 */
'use strict';
process.env.GCLOUD_PROJECT = 'demo-points-p2a';
delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
const fs = require('fs'), path = require('path'), Module = require('module');
const ROOT = path.resolve(__dirname, '..'), FN = path.join(ROOT, 'functions');
const { makeFakeFirestore } = require('./lib/fake-firestore-txn');
const F = makeFakeFirestore({ clock: () => Date.now(), strictReadOrder: true }); const db = F.db;
const say = console.log; console.log = console.info = console.warn = console.error = console.debug = () => {};
let pass = 0, fail = 0;
const ck = (l, ok, d) => { say('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined && d !== '' ? '   [' + String(typeof d === 'object' ? JSON.stringify(d) : d).slice(0, 340) + ']' : '')); ok ? pass++ : fail++; };
class HttpsError extends Error { constructor(c, m, d) { super(m); this.code = c; this.details = d; } }
const ADMIN = { apps: [{}], initializeApp: () => ({}), app: () => ({}), firestore: Object.assign(() => db, { FieldValue: F.FieldValue, Timestamp: F.Timestamp, FieldPath: F.FieldPath }), auth: () => ({}) };
const origReq = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === 'firebase-admin/firestore') return { getFirestore: () => db, FieldValue: F.FieldValue, Timestamp: F.Timestamp, FieldPath: F.FieldPath };
  if (id === 'firebase-admin') return ADMIN;
  if (id === 'firebase-functions/v2/https') return { onCall: (_o, h) => (h || _o), onRequest: (_o, h) => (h || _o), HttpsError };
  if (id === 'firebase-functions/v2/scheduler') return { onSchedule: (_o, h) => h };
  if (id === 'firebase-functions/v2/firestore') return { onDocumentWritten: (_o, h) => h, onDocumentCreated: (_o, h) => h, onDocumentUpdated: (_o, h) => h };
  if (id === 'firebase-functions/logger' || id === 'firebase-functions') return { logger: { info() {}, warn() {}, error() {} }, info() {}, warn() {}, error() {}, debug() {} };
  if (id === 'firebase-functions/params') return { defineSecret: (n) => ({ name: n, value: () => 'test-secret' }), defineString: () => ({ value: () => '' }), defineInt: () => ({ value: () => 0 }) };
  if (id === './pos-audit') return { writeAudit: () => {} };
  if (id === './workforce-identity') return { _assertBusinessPermission: async () => { throw new HttpsError('permission-denied', 'no'); } };
  if (id === './tenant-identity') return { resolveMerchantIdForOwner: async () => ({ ok: false }) };
  if (id === './shop-employees') return { resolveShopAccess: async (uid, shopId) => { if (uid === shopId) return { role: 'owner' }; throw new HttpsError('permission-denied', 'no'); }, capabilitiesForRole: () => ['sell'] };
  return origReq.apply(this, arguments);
};
const load = (p) => { try { return require(p); } catch (e) { return { __err: e.message }; } };
const PS = load(path.join(FN, 'loyalty-points-spend.js'));
const PP = load(path.join(FN, 'payment-purposes.js'));
const PA = load(path.join(FN, 'payment-attribution.js'));
const SO = load(path.join(FN, 'shop-offers.js'));
const ZF = load(path.join(FN, 'pos-zero-friction.js'));
const src = (f) => { try { return fs.readFileSync(path.join(ROOT, f), 'utf8'); } catch (_) { return ''; } };
const get = async (p) => { const s = await db.doc(p).get(); return s.exists ? s.data() : null; };
const all = async (c) => (await db.collection(c).get()).docs.map((d) => Object.assign({ id: d.id }, d.data()));
const codeOf = async (p) => { try { await p; return null; } catch (e) { return e.code || e.message; } };
function extractFinalize() {
  const s = src('functions/index.js'), i = s.indexOf('async function _finalizeMarketplacePayment(');
  if (i < 0) return null;
  let d = 0, j = s.indexOf('{', s.indexOf(')', i));
  for (let k = j; k < s.length; k++) { if (s[k] === '{') d++; else if (s[k] === '}' && --d === 0) { j = k; break; } }
  const fnRequire = (id) => require(id.startsWith('./') ? path.join(FN, id) : id);
  try { return new Function('require', 'return (' + s.slice(i, j + 1) + ')')(fnRequire); } catch (_) { return null; }
}
const A = 'shopA', B = 'shopB', DAY = 864e5;
async function wipe() {
  for (const c of ['shopOffers', 'shopOfferRedemptions', 'orders', 'pointsHolds', 'loyaltyLedger', 'pointsRedemptionAlerts', 'paymentIntents', 'checkoutSessions', 'loyaltyAccounts', 'posCustomers']) {
    for (const d of (await db.collection(c).get()).docs) await d.ref.delete();
  }
  await db.doc('products/mouse').set({ name: 'Mouse', price: 1000, stock: 50, sellerUid: A, shopId: A, status: 'active', isVisible: true });
  await db.doc('products/pen').set({ name: 'Pen', price: 400, stock: 50, sellerUid: A, shopId: A, status: 'active', isVisible: true });
  await db.doc('products/laptop').set({ name: 'Laptop', price: 75000, stock: 5, sellerUid: A, shopId: A, status: 'active', isVisible: true });
}
const acct = (uid, balance, extra) => db.doc('loyaltyAccounts/' + uid).set(Object.assign({ uid, balance, loyaltyId: 'SKN-' + uid, status: 'active' }, extra || {}));
const lot = (id, uid, shop, pts, ageMs) => db.doc('loyaltyLedger/' + id).set({ uid, type: 'earn', issuerShopId: shop, points: pts, pointsRemaining: pts, createdAt: F.Timestamp.fromMillis(Date.now() - (ageMs || 0)) });
const price = (uid, orderId, items, extra) => PP.PURPOSES.product_order.price(uid, Object.assign({ orderId, items }, extra || {}));

(async () => {
  if (typeof PS.capFor !== 'function') { ck('PS0 the points spending authority exists', false, PS.__err || 'missing'); say(`\n${pass} passed, ${fail} failed`); process.exit(1); }

  /* PS1 */
  const c1 = PS.capFor({ balance: 1000, goodsKES: 1000, payableKES: 1000 });
  const c2 = PS.capFor({ balance: 1005, goodsKES: 1000, payableKES: 1000 });
  const c3 = PS.capFor({ balance: 1000, goodsKES: 200, payableKES: 200 });
  const c4 = PS.capFor({ balance: 1000, goodsKES: 1000, payableKES: 30 });
  const al = PS.allocate(100, [{ shopId: A, goods: 600 }, { shopId: B, goods: 400 }]);
  ck('PS1 10 points = KES 1; cap = min(points, 25% goods, payable − 1) in whole shillings; funding split by goods',
    PS.POINTS_PER_KES === 10 && PS.MAX_REDEEM_PCT === 0.25 && c1.kes === 100 && c1.points === 1000 && c2.points === 1000 && c3.kes === 50 && c4.kes === 29
    && PS.valueOf(500) === 50 && al.length === 2 && al[0].kes === 60 && al[1].kes === 40 && al[0].points === 600,
    { c1, c2, c3, c4, al });

  /* PS2 — parity */
  let p2 = {};
  try {
    await wipe(); await acct('buyM', 1000); await acct('buyC', 1000); await acct('buyQ', 1000);
    const q = await SO.quoteForCaller(db, { uid: 'buyQ', data: { withPoints: true, items: [{ productId: 'mouse', qty: 1 }] } });
    p2.display = q.points;
    const o = await price('buyM', 'ORDM1', [{ productId: 'mouse', qty: 1 }], { redeemLoyalty: true });
    p2.mpesa = { amount: o.amountCents / 100, pts: o.metadata.pointsRedeemed, kes: o.metadata.pointsDiscount, fund: o.metadata.pointsFunding };
    const c = await PS.priceAndHold(db, { uid: 'buyC', channel: 'checkout', ref: 'CS1', redeem: true, goodsKES: 1000, payableKES: 1000, shops: [{ shopId: A, goods: 1000 }] });
    p2.card = { amount: 1000 - c.kes, pts: c.points, kes: c.kes };
    p2.accM = await get('loyaltyAccounts/buyM'); p2.accC = await get('loyaltyAccounts/buyC');
  } catch (e) { p2.err = e.message; }
  ck('PS2 PARITY: 1,000 costs 900 using 1,000 points on M-PESA AND on card; the checkout display quote says KES 100 / 1,000 points',
    p2.mpesa && p2.mpesa.amount === 900 && p2.mpesa.pts === 1000 && p2.card && p2.card.amount === 900 && p2.card.pts === 1000
    && p2.display && p2.display.maxKES === 100 && p2.display.maxPoints === 1000 && p2.display.balance === 1000
    && p2.accM.balance === 0 && p2.accM.heldPoints === 1000 && p2.accC.balance === 0 && p2.mpesa.fund[0].shopId === A,
    { display: p2.display, mpesa: p2.mpesa, card: p2.card, err: p2.err });

  /* PS3 — retry + switch off */
  let p3 = {};
  try {
    const again = await price('buyM', 'ORDM1', [{ productId: 'mouse', qty: 1 }], { redeemLoyalty: true });
    p3.again = again.amountCents / 100; p3.accAfterRetry = (await get('loyaltyAccounts/buyM'));
    const off = await price('buyM', 'ORDM1', [{ productId: 'mouse', qty: 1 }], { redeemLoyalty: false });
    p3.off = off.amountCents / 100; p3.acc = await get('loyaltyAccounts/buyM'); p3.hold = await get('pointsHolds/order__ORDM1');
    p3.plain = (await price('buyM', 'ORDM2', [{ productId: 'mouse', qty: 1 }])).amountCents / 100;
  } catch (e) { p3.err = e.message; }
  ck('PS3 a retried intent re-prices to the SAME 900 without holding twice; switching points off releases them (1,000 again, full price)',
    p3.again === 900 && p3.accAfterRetry.balance === 0 && p3.accAfterRetry.heldPoints === 1000
    && p3.off === 1000 && p3.acc.balance === 1000 && p3.acc.heldPoints === 0 && p3.hold.status === 'released' && p3.plain === 1000,
    { again: p3.again, off: p3.off, bal: p3.acc && p3.acc.balance, held: p3.acc && p3.acc.heldPoints, hold: p3.hold && p3.hold.status, err: p3.err });

  /* PS3b — a DOUBLE TAP: two concurrent intents for the SAME order, with points enough for two holds */
  let p3b = {};
  try {
    await wipe(); await acct('buyD', 5000);
    const r = await Promise.all([1, 2].map(() => price('buyD', 'ORDD1', [{ productId: 'pen', qty: 1 }], { redeemLoyalty: true })));
    p3b.amounts = r.map((x) => x.amountCents / 100);
    p3b.acc = await get('loyaltyAccounts/buyD'); p3b.hold = await get('pointsHolds/order__ORDD1');
  } catch (e) { p3b.err = e.message; }
  ck('PS3b a double tap on ONE order: both intents price 300 (400 − 100), the points are held ONCE (5,000 → 4,000, held 1,000) — never twice, never lost',
    p3b.amounts && p3b.amounts[0] === 300 && p3b.amounts[1] === 300 && p3b.acc.balance === 4000 && p3b.acc.heldPoints === 1000 && p3b.hold.points === 1000,
    { amounts: p3b.amounts, bal: p3b.acc && p3b.acc.balance, held: p3b.acc && p3b.acc.heldPoints, err: p3b.err });

  /* PS4 — 25% ceiling, after offers */
  let p4 = {};
  try {
    await wipe(); await acct('rich', 1000000);
    const o = await price('rich', 'ORDR1', [{ productId: 'mouse', qty: 1 }], { redeemLoyalty: true });
    p4.mouse = { amount: o.amountCents / 100, kes: o.metadata.pointsDiscount };
    await db.doc('shopOffers/f1').set({ shopId: A, sellerUid: A, type: 'percentage', template: 'flashSale', status: 'live', name: 'Flash', percent: 10, qualifyingListingIds: ['laptop'], endsAt: new Date(Date.now() + DAY).toISOString() });
    const l = await price('rich', 'ORDR2', [{ productId: 'laptop', qty: 1 }], { redeemLoyalty: true });
    p4.laptop = { amount: l.amountCents / 100, kes: l.metadata.pointsDiscount, offer: l.metadata.offerDiscount };
  } catch (e) { p4.err = e.message; }
  ck('PS4 the 25% ceiling: a 1,000,000-point buyer takes KES 250 off 1,000; on a 75,000 laptop with a 7,500 offer, 25% of 67,500 = 16,875',
    p4.mouse && p4.mouse.kes === 250 && p4.mouse.amount === 750 && p4.laptop && p4.laptop.offer === 7500 && p4.laptop.kes === 16875 && p4.laptop.amount === 67500 - 16875,
    p4);

  /* PS5 — client figures ignored */
  let p5 = {};
  try {
    await wipe(); await acct('buyX', 1000);
    const o = await price('buyX', 'ORDX1', [{ productId: 'mouse', qty: 1 }], { redeemLoyalty: true, pointsDiscount: 999, pointsRedeemed: 1, pointValueKES: 5, rate: 5 });
    p5.o = { amount: o.amountCents / 100, kes: o.metadata.pointsDiscount, pts: o.metadata.pointsRedeemed };
    p5.legacy = PA.mergeAttribution ? PA.mergeAttribution({ intent: null, legacyMeta: { pointsDiscount: 999, pointsRedeemed: 9999, orderId: 'x' } }) : null;
    p5.intent = PA.mergeAttribution ? PA.mergeAttribution({ intent: { purpose: 'product_order', metadata: { orderId: 'x', pointsRedeemed: 1000, pointsDiscount: 100 } }, legacyMeta: { pointsDiscount: 999 } }) : null;
  } catch (e) { p5.err = e.message; }
  ck('PS5 a points amount / rate in the request is ignored (still 100 off, 1,000 points); points in legacy meta are ignored; the intent is the only source',
    p5.o && p5.o.kes === 100 && p5.o.pts === 1000 && p5.o.amount === 900
    && p5.legacy && p5.legacy.pointsDiscount === 0 && p5.legacy.pointsRedeemed === 0 && p5.intent && p5.intent.pointsDiscount === 100 && p5.intent.pointsRedeemed === 1000,
    { o: p5.o, legacy: p5.legacy && [p5.legacy.pointsDiscount, p5.legacy.pointsRedeemed], intent: p5.intent && p5.intent.pointsDiscount, err: p5.err || (!PA.mergeAttribution && 'no mergeAttribution') });

  /* PS6 — concurrency */
  let p6 = {};
  try {
    await wipe(); await acct('buyR', 1000);
    const r = await Promise.allSettled([
      price('buyR', 'ORDC1', [{ productId: 'mouse', qty: 4 }], { redeemLoyalty: true }),
      price('buyR', 'ORDC2', [{ productId: 'mouse', qty: 4 }], { redeemLoyalty: true }),
    ]);
    p6.r = r.map((x) => x.status === 'fulfilled' ? { amount: x.value.amountCents / 100, pts: x.value.metadata.pointsRedeemed || 0, err: x.value.metadata.pointsError || null } : { rejected: x.reason && x.reason.message });
    p6.acc = await get('loyaltyAccounts/buyR'); p6.holds = (await all('pointsHolds')).filter((h) => h.status === 'held');
  } catch (e) { p6.err = e.message; }
  const got = (p6.r || []).filter((x) => x.pts === 1000), lost = (p6.r || []).filter((x) => x.pts === 0);
  ck('PS6 CONCURRENCY: two orders priced at once against 1,000 points — exactly ONE gets them (3,900); the other pays 4,000 and is told; balance 0, never negative',
    got.length === 1 && got[0].amount === 3900 && lost.length === 1 && lost[0].amount === 4000 && !!lost[0].err
    && p6.acc.balance === 0 && p6.acc.heldPoints === 1000 && p6.holds.length === 1,
    { r: p6.r, bal: p6.acc && p6.acc.balance, held: p6.acc && p6.acc.heldPoints, err: p6.err });

  /* PS7 — spent once; funder = spending shop; lot = issuing shop */
  let p7 = {};
  try {
    await wipe(); await acct('buyL', 1000); await lot('earn__till__B1', 'buyL', B, 700, 3 * DAY); await lot('earn__till__A1', 'buyL', A, 300, DAY);
    await price('buyL', 'ORDL1', [{ productId: 'mouse', qty: 4 }], { redeemLoyalty: true });
    p7.lotsAfterHold = [(await get('loyaltyLedger/earn__till__B1')).pointsRemaining, (await get('loyaltyLedger/earn__till__A1')).pointsRemaining];
    p7.c1 = await PS.consumeHold(db, { channel: 'order', ref: 'ORDL1', orderId: 'ORDL1', saleRef: 'PAY1' });
    p7.c2 = await PS.consumeHold(db, { channel: 'order', ref: 'ORDL1', orderId: 'ORDL1', saleRef: 'PAY1' });
    p7.rows = (await all('loyaltyLedger')).filter((l) => l.type === 'redeem');
    p7.acc = await get('loyaltyAccounts/buyL'); p7.hold = await get('pointsHolds/order__ORDL1');
  } catch (e) { p7.err = e.message; }
  const row = p7.rows && p7.rows[0];
  ck('PS7 consumed exactly once (a replay adds nothing); the ledger names the SPENDING shop A as funder, and the lots drawn — oldest first — came from shop B then A',
    p7.c1 && p7.c1.consumed && p7.c2 && p7.c2.replay && p7.rows.length === 1 && row.fundingShopId === A && row.points === -1000 && row.pointsRedeemed === 1000 && row.valueKES === 100
    && p7.hold.lots.length === 2 && p7.hold.lots[0].issuerShopId === B && p7.hold.lots[0].points === 700 && p7.hold.lots[1].issuerShopId === A && p7.hold.lots[1].points === 300
    && p7.lotsAfterHold[0] === 0 && p7.lotsAfterHold[1] === 0 && p7.acc.balance === 0 && p7.acc.heldPoints === 0 && p7.acc.totalRedeemed === 1000 && p7.hold.status === 'consumed',
    { c1: p7.c1, c2: p7.c2, rows: p7.rows && p7.rows.length, fund: row && row.fundingShopId, lots: p7.hold && p7.hold.lots, acc: p7.acc && [p7.acc.balance, p7.acc.heldPoints, p7.acc.totalRedeemed], err: p7.err });

  /* PS8 — settle expired: unpaid → released (lots restored); paid → consumed */
  let p8 = {};
  try {
    await wipe(); await acct('buyE', 2000); await lot('earn__till__E1', 'buyE', B, 2000, DAY);
    await price('buyE', 'ORDE1', [{ productId: 'pen', qty: 1 }], { redeemLoyalty: true });   /* 25% of 400 = KES 100 → holds 1,000 */
    p8.second = (await price('buyE', 'ORDE2', [{ productId: 'pen', qty: 1 }], { redeemLoyalty: true })).metadata;   /* holds the other 1,000 */
    await db.doc('paymentIntents/ORDE1').set({ status: 'expired' });
    await db.doc('paymentIntents/ORDE2').set({ status: 'paid' });
    for (const id of ['order__ORDE1', 'order__ORDE2']) await db.doc('pointsHolds/' + id).set({ expiresAtMs: Date.now() - 1000 }, { merge: true });
    p8.before = await get('loyaltyAccounts/buyE');
    p8.n = await PS.settleExpired(db, 'buyE');
    p8.h1 = (await get('pointsHolds/order__ORDE1')).status; p8.h2 = (await get('pointsHolds/order__ORDE2')).status;
    p8.acc = await get('loyaltyAccounts/buyE'); p8.lot = (await get('loyaltyLedger/earn__till__E1')).pointsRemaining;
  } catch (e) { p8.err = e.message; }
  ck('PS8 settling expired holds: the UNPAID order is released (balance and its lot restored); the one whose payment landed is CONSUMED, never released',
    p8.n === 2 && p8.h1 === 'released' && p8.h2 === 'consumed' && p8.before.balance === 0 && p8.acc.balance === 1000 && p8.acc.heldPoints === 0 && p8.lot === 1000,
    { second: p8.second && [p8.second.pointsRedeemed, p8.second.pointsError], n: p8.n, h1: p8.h1, h2: p8.h2 || null, bal: p8.acc && p8.acc.balance, held: p8.acc && p8.acc.heldPoints, lot: p8.lot, err: p8.err });

  /* PS9 — payment after release */
  let p9 = {};
  try {
    await wipe(); await acct('buyS', 1000);
    await price('buyS', 'ORDS1', [{ productId: 'mouse', qty: 4 }], { redeemLoyalty: true });
    await PS.releaseHold(db, { channel: 'order', ref: 'ORDS1', reason: 'expired' });
    p9.c = await PS.consumeHold(db, { channel: 'order', ref: 'ORDS1', orderId: 'ORDS1', saleRef: 'P9', expect: { points: 1000, kes: 100, fundingShops: [{ shopId: A, kes: 100, points: 1000 }] } });
    p9.acc = await get('loyaltyAccounts/buyS');
    await acct('buyT', 1000);
    await price('buyT', 'ORDT1', [{ productId: 'mouse', qty: 4 }], { redeemLoyalty: true });
    await PS.releaseHold(db, { channel: 'order', ref: 'ORDT1', reason: 'expired' });
    await db.doc('loyaltyAccounts/buyT').set({ balance: 400 }, { merge: true });            /* spent elsewhere meanwhile */
    p9.t = await PS.consumeHold(db, { channel: 'order', ref: 'ORDT1', orderId: 'ORDT1', saleRef: 'P9b', expect: { points: 1000, kes: 100 } });
    p9.accT = await get('loyaltyAccounts/buyT'); p9.alert = await get('pointsRedemptionAlerts/order__ORDT1');
  } catch (e) { p9.err = e.message; }
  ck('PS9 a payment landing after its hold was released re-deducts (1,000 → 0); if only 400 remain the sale STANDS, 400 are taken and the 600 shortfall is flagged',
    p9.c && p9.c.consumed && p9.c.shortfall === 0 && p9.acc.balance === 0 && p9.t && p9.t.consumed && p9.t.shortfall === 600 && p9.accT.balance === 0
    && p9.alert && p9.alert.shortfall === 600 && p9.alert.status === 'open',
    { c: p9.c, bal: p9.acc && p9.acc.balance, t: p9.t, balT: p9.accT && p9.accT.balance, alert: p9.alert && p9.alert.shortfall, err: p9.err });

  /* PS10 — finalisation records points only when spent */
  let p10 = {};
  const FIN = extractFinalize();
  try {
    await wipe();
    const base = { checkoutId: 'PAYF1', sellerUid: A, callerUid: 'buyF', hub: 'marketplace', amount: 900, phone: '254700000000', mpesaCode: 'Q1', description: 'x',
      items: [{ productId: 'mouse', qty: 1 }], writeSellerPayment: false };
    await FIN(db, ADMIN, Object.assign({}, base, { orderId: 'ORDF1', pointsRedeemed: 1000, pointsDiscount: 100 }));
    await FIN(db, ADMIN, Object.assign({}, base, { checkoutId: 'PAYF2', orderId: 'ORDF2' }));
    p10.o1 = await get('orders/ORDF1'); p10.o2 = await get('orders/ORDF2');
  } catch (e) { p10.err = e.message; }
  ck('PS10 the order records pointsRedeemed / pointsDiscount when points were spent, and nothing when not',
    !!FIN && p10.o1 && p10.o1.pointsRedeemed === 1000 && p10.o1.pointsDiscount === 100 && p10.o2 && !('pointsRedeemed' in p10.o2) && !('pointsDiscount' in p10.o2),
    { o1: p10.o1 && [p10.o1.pointsRedeemed, p10.o1.pointsDiscount], o2: p10.o2 && Object.keys(p10.o2).filter((k) => /points/.test(k)), err: p10.err || (!FIN && 'finalize not extracted') });

  /* PS11 — wiring (structural) */
  const ix = src('functions/index.js'), ckh = src('checkout.html');
  const vIdx = ix.indexOf('exports.verifyIntasendPayment');
  const vSrc = ix.slice(vIdx, vIdx + 60000);
  const w = {
    sessionHold: /priceAndHold\(db, \{ uid: request\.auth\.uid, channel: "checkout", ref: sessionId, redeem: true/.test(ix),
    noTrimPoints: !/loyaltyDiscount = Math\.max\(0, loyaltyDiscount - _trim\)/.test(ix),
    noHalfRate: !/POINTS_TO_KES\s*=\s*0\.5/.test(ix) && !/POINTS_TO_KES/.test(ckh),
    readBeforeWrite: vSrc.indexOf('prepareConsumeTx(tx, db') > -1 && vSrc.indexOf('prepareConsumeTx(tx, db') < vSrc.indexOf('tx.set(db.collection("orders").doc(orderId), orderDoc)'),
    consumeInTx: /_PSv\.consumeHoldTx\(tx, db, _ptsCtx/.test(vSrc),
    noUncapped: !/balance:\s+admin\.firestore\.FieldValue\.increment\(-_pts\)/.test(ix),
    webhookSpends: /consumeHold\(db, \{ channel: "order", ref: String\(_pm\.orderId\)/.test(ix),
    mpesaIntent: /redeemLoyalty:\s+_loyaltyRedeeming === true,/.test(ckh),
    quotePoints: /withPoints: true/.test(ckh) && /_pointsPreview = \(d\.points && !d\.points\.unavailable\) \? d\.points : null;/.test(ckh),
    noLocalBalance: !/JSON\.parse\(localStorage\.getItem\('sokoniLoyalty'\) \|\| '\{\}'\);\s+const pts/.test(ckh),
  };
  ck('PS11 (STRUCTURAL) the card session holds via the one authority and never trims held points; verify reads the hold before its first write and spends it in the transaction; the uncapped increment is gone; the webhook spends the order hold; checkout has no rate and sends redeemLoyalty on M-PESA too',
    Object.values(w).every(Boolean), w);

  /* PS12 — no legacy substitution */
  let p12 = {};
  try {
    await wipe();
    await db.doc('posCustomers/buyP').set({ merchantId: A, loyaltyPoints: 50000, phone: '254711111111' });
    const o = await price('buyP', 'ORDP1', [{ productId: 'mouse', qty: 1 }], { redeemLoyalty: true });
    p12.legacy = { amount: o.amountCents / 100, err: o.metadata.pointsError || null };
    await acct('buyB', 5000, { status: 'blocked' });
    const b = await price('buyB', 'ORDB1', [{ productId: 'mouse', qty: 1 }], { redeemLoyalty: true });
    p12.blocked = { amount: b.amountCents / 100, err: b.metadata.pointsError || null, acc: (await get('loyaltyAccounts/buyB')).balance };
    if (typeof ZF.posCompleteCheckout === 'function') {
      p12.till = await codeOf(ZF.posCompleteCheckout({ data: { idempotencyKey: 'L1', merchantId: A, items: [{ productId: 'mouse', qty: 1, unitPrice: 1000 }], subtotal: 1000, grandTotal: 1000,
        payments: [{ method: 'cash', amount: 1000 }], loyaltyRedeemPoints: 500 }, auth: { uid: A, token: { posRole: 'cashier' } } }));
    }
  } catch (e) { p12.err = e.message; }
  ck('PS12 no legacy substitution: a posCustomers balance of 50,000 is never spent (full 1,000); a blocked account redeems nothing and keeps its points; the till still refuses loyaltyRedeemPoints',
    p12.legacy && p12.legacy.amount === 1000 && !!p12.legacy.err && p12.blocked && p12.blocked.amount === 1000 && p12.blocked.acc === 5000 && !!p12.blocked.err
    && p12.till === 'failed-precondition', p12);

  say(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { say('CRASH ' + (e && e.stack || e)); process.exit(2); });
