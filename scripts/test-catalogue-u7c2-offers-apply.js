/* test-catalogue-u7c2-offers-apply.js — universal catalogue U7c2 (2026-09-29): the merchant's live offers are APPLIED
 * BY THE SERVER, identically, everywhere money is taken — and what the cart and till SHOW is the same server figure.
 *
 * Owner: "offers and discounts must show in cart … and reflect for both online and shop sale POS till sales";
 * "displayed amount = cart amount = server-authorised amount = payment amount = order amount = receipt amount".
 *
 * REAL functions/shop-offers.js (quoteShopOffers, quoteForCaller, recordRedemptionsForOrder), payment-purposes
 * product_order, payment-attribution, _finalizeMarketplacePayment (extracted verbatim, own module scope) and
 * pos-zero-friction.posCompleteCheckout — over the transactional fake Firestore.
 *
 *   Laptop KES 75,000 · Weekend Flash Sale 10% on the laptop (live) · shop A
 *
 * PROVES
 *   AP1 the resolver: a live offer applies; a draft, an expired offer, another shop's offer and an exhausted one do
 *       not; an AGREED buyer price is left out of the offer basket; an unreadable store says so (never "no offers")
 *   AP2 online charge (product_order): total = 67,500; the intent metadata carries the discount + the offer; an
 *       expired sale charges 75,000; an unreadable store REFUSES rather than overcharge
 *   AP3 the display quote (online) equals the charge — same subtotal, discount and total
 *   AP4 payment: the offer figures reach the order ONLY from the server intent (a client-meta discount is ignored);
 *       finalisation records the discount on the order and ONE redemption per (order, offer) — a replay adds none
 *   AP5 the till: the same offer, the same price — the till quote = the sale's authoritative total; a device showing
 *       the undiscounted total is refused (nothing written); the sale and receipt carry the offer; one redemption
 *   AP6 the sales limit: once an offer has been redeemed up to its limit, neither the online charge nor the till
 *       applies it
 *   AP7 the card session's wiring: offers applied per shop before the promo code, a promo code does not stack on a
 *       shop offer, the session and the order carry the discount, and redemptions are recorded on payment
 *
 *   node scripts/test-catalogue-u7c2-offers-apply.js
 */
'use strict';
process.env.GCLOUD_PROJECT = 'demo-u7c2';
delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
const fs = require('fs'), path = require('path'), Module = require('module');
const ROOT = path.resolve(__dirname, '..'), FN = path.join(ROOT, 'functions');
const { makeFakeFirestore } = require('./lib/fake-firestore-txn');
const F = makeFakeFirestore({ clock: () => Date.now() }); const db = F.db;
const say = console.log; console.log = console.info = console.warn = console.error = console.debug = () => {};
let pass = 0, fail = 0;
const ck = (l, ok, d) => { say('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined && d !== '' ? '   [' + String(typeof d === 'object' ? JSON.stringify(d) : d).slice(0, 320) + ']' : '')); ok ? pass++ : fail++; };
class HttpsError extends Error { constructor(c, m, d) { super(m); this.code = c; this.details = d; } }
const ADMIN = { apps: [{}], initializeApp: () => ({}), app: () => ({}), firestore: Object.assign(() => db, { FieldValue: F.FieldValue, Timestamp: F.Timestamp, FieldPath: F.FieldPath }), auth: () => ({}) };
const origReq = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === 'firebase-admin/firestore') return { getFirestore: () => db, FieldValue: F.FieldValue, Timestamp: F.Timestamp, FieldPath: F.FieldPath };
  if (id === 'firebase-admin') return ADMIN;
  if (id === 'firebase-functions/v2/https') return { onCall: (_o, h) => (h || _o), onRequest: (_o, h) => (h || _o), HttpsError };
  if (id === 'firebase-functions/v2/scheduler') return { onSchedule: (_o, h) => h };
  if (id === 'firebase-functions/v2/firestore') return { onDocumentWritten: (_o, h) => h, onDocumentCreated: (_o, h) => h, onDocumentUpdated: (_o, h) => h };
  if (id === 'firebase-functions/logger') return { info() {}, warn() {}, error() {}, debug() {} };
  if (id === 'firebase-functions/params') return { defineSecret: (n) => ({ name: n, value: () => '0' }) };
  if (id === './pos-audit') return { writeAudit: () => {} };
  if (id === './workforce-identity') return { _assertBusinessPermission: async () => { throw new HttpsError('permission-denied', 'no membership'); } };
  if (id === './tenant-identity') return { resolveMerchantIdForOwner: async () => ({ ok: false }) };
  if (id === './shop-employees') return {
    resolveShopAccess: async (uid, shopId) => { if (uid === shopId) return { role: 'owner', via: 'owner', shopOwnerId: uid }; throw new HttpsError('permission-denied', 'no access'); },
    capabilitiesForRole: () => ['sell', 'discount'] };
  return origReq.apply(this, arguments);
};
const load = (p) => { try { return require(p); } catch (e) { return { __err: e.message }; } };
const SO = load(path.join(FN, 'shop-offers.js'));
const PP = load(path.join(FN, 'payment-purposes.js'));
const PA = load(path.join(FN, 'payment-attribution.js'));
const ZF = load(path.join(FN, 'pos-zero-friction.js'));
const src = (f) => { try { return fs.readFileSync(path.join(ROOT, f), 'utf8'); } catch (_) { return ''; } };
const get = async (p) => { const s = await db.doc(p).get(); return s.exists ? s.data() : null; };
const count = async (c) => (await db.collection(c).get()).docs.length;
const codeOf = async (p) => { try { await p; return null; } catch (e) { return (e.details && e.details.code) || e.code || e.message; } };
function extractFinalize() {
  const s = src('functions/index.js'), i = s.indexOf('async function _finalizeMarketplacePayment(');
  if (i < 0) return null;
  let d = 0, j = s.indexOf('{', s.indexOf(')', i));
  for (let k = j; k < s.length; k++) { if (s[k] === '{') d++; else if (s[k] === '}' && --d === 0) { j = k; break; } }
  const fnRequire = (id) => require(id.startsWith('./') ? path.join(FN, id) : id);
  try { return new Function('require', 'return (' + s.slice(i, j + 1) + ')')(fnRequire); } catch (_) { return null; }
}

const A = 'shopA', B = 'shopB';
const DAY = 864e5;
async function reset(offers) {
  for (const c of ['shopOffers', 'shopOfferRedemptions', 'orders', 'posTransactions', 'posRetailSales', 'posReceipts', 'posIdempotency']) {
    for (const d of (await db.collection(c).get()).docs) await d.ref.delete();
  }
  await db.doc('products/laptop').set({ name: 'Laptop', price: 75000, stock: 5, sellerUid: A, shopId: A, status: 'active', isVisible: true });
  await db.doc('products/mouse').set({ name: 'Mouse', price: 1000, stock: 20, sellerUid: A, shopId: A, status: 'active', isVisible: true });
  for (const [id, o] of Object.entries(offers || {})) await db.doc('shopOffers/' + id).set(Object.assign({ shopId: A, sellerUid: A }, o));
}
const FLASH = { type: 'percentage', template: 'flashSale', status: 'live', name: 'Weekend Flash Sale', percent: 10,
  qualifyingListingIds: ['laptop'], endsAt: new Date(Date.now() + 2 * DAY).toISOString() };

(async () => {
  if (typeof SO.quoteShopOffers !== 'function') { ck('AP0 the U7c2 resolver exists', false, SO.__err || 'quoteShopOffers missing'); }

  /* AP1 */
  let ap1 = {};
  try {
    await reset({ f1: FLASH, d1: Object.assign({}, FLASH, { status: 'draft', percent: 50 }),
      x1: Object.assign({}, FLASH, { endsAt: new Date(Date.now() - DAY).toISOString(), percent: 40 }),
      b1: Object.assign({}, FLASH, { shopId: B, percent: 30 }) });
    const lines = [{ productId: 'laptop', qty: 1, unitPrice: 75000, shopId: A }];
    ap1.live = await SO.quoteShopOffers(db, { shopId: A, lines });
    ap1.agreed = await SO.quoteShopOffers(db, { shopId: A, lines: [{ productId: 'laptop', qty: 1, unitPrice: 70000, offerId: 'po1', shopId: A }] });
    await reset({ f1: Object.assign({}, FLASH, { totalRedemptionLimit: 1 }) });
    await db.doc('shopOfferRedemptions/o0__f1').set({ offerId: 'f1', shopId: A });
    ap1.exhausted = await SO.quoteShopOffers(db, { shopId: A, lines });
    const broken = { collection: () => ({ where: () => ({ where: () => ({ limit: () => ({ get: async () => { throw new Error('boom'); } }) }) }) }) };
    ap1.down = await SO.quoteShopOffers(broken, { shopId: A, lines });
  } catch (e) { ap1.err = e.message; }
  ck('AP1 only the live offer applies (not draft/expired/other shop/exhausted); agreed prices excluded; an unreadable store says so',
    ap1.live && ap1.live.discount === 7500 && ap1.live.applied.length === 1 && ap1.live.applied[0].id === 'f1'
    && ap1.agreed && ap1.agreed.discount === 0 && ap1.exhausted && ap1.exhausted.discount === 0 && ap1.down && ap1.down.unavailable === true,
    { live: ap1.live && ap1.live.discount, agreed: ap1.agreed && ap1.agreed.discount, exhausted: ap1.exhausted && ap1.exhausted.discount, down: ap1.down, err: ap1.err });

  /* AP2 */
  const price = (items, extra) => PP.PURPOSES.product_order.price('buyer1', Object.assign({ orderId: 'ORD1', items }, extra || {}));
  let ap2 = {};
  try {
    await reset({ f1: FLASH });
    ap2.on = await price([{ productId: 'laptop', qty: 1 }]);
    await reset({ f1: Object.assign({}, FLASH, { endsAt: new Date(Date.now() - 1000).toISOString() }) });
    ap2.off = await price([{ productId: 'laptop', qty: 1 }]);
    await reset({ f1: FLASH });
    /* the offer STORE is unreadable (every other collection still works) */
    const origCol = db.collection.bind(db);
    db.collection = (n) => (n === 'shopOffers'
      ? { where: () => ({ where: () => ({ limit: () => ({ get: async () => { throw new Error('offer store down'); } }) }) }), doc: (id) => origCol(n).doc(id) }
      : origCol(n));
    try { ap2.down = await codeOf(price([{ productId: 'laptop', qty: 1 }])); } finally { db.collection = origCol; }
  } catch (e) { ap2.err = e.message; }
  const m = ap2.on && ap2.on.metadata;
  ck('AP2 online charge = 67,500 with the discount + offer in the intent; expired = 75,000; unreadable store REFUSES',
    ap2.on && ap2.on.amountCents === 6750000 && m && m.offerDiscount === 7500 && m.offersApplied.length === 1 && m.offerShopId === A
    && ap2.off && ap2.off.amountCents === 7500000 && ap2.down === 'failed-precondition',
    { on: ap2.on && ap2.on.amountCents, disc: m && m.offerDiscount, off: ap2.off && ap2.off.amountCents, down: ap2.down, err: ap2.err });

  /* AP3 */
  let q3 = null;
  try { await reset({ f1: FLASH }); q3 = await SO.quoteForCaller(db, { uid: 'buyer1', data: { items: [{ productId: 'laptop', qty: 1 }, { productId: 'mouse', qty: 2 }] } }); } catch (e) { q3 = { err: e.message }; }
  let c3 = null; try { c3 = await price([{ productId: 'laptop', qty: 1 }, { productId: 'mouse', qty: 2 }]); } catch (e) { c3 = { err: e.message }; }
  ck('AP3 the online display quote equals the charge (subtotal 77,000 · discount 7,500 · total 69,500)',
    q3 && q3.subtotal === 77000 && q3.discount === 7500 && q3.total === 69500 && c3 && c3.amountCents === q3.total * 100
    && q3.shops[0].applied[0].label === 'Weekend Flash Sale', { quote: q3 && { s: q3.subtotal, d: q3.discount, t: q3.total, err: q3.err }, charge: c3 && (c3.amountCents || c3.err) });

  /* AP4 */
  const finalize = extractFinalize();
  let ap4 = {};
  try {
    const intent = { purpose: 'product_order', metadata: m };
    ap4.fromIntent = PA.mergeAttribution({ intent, legacyMeta: {} });
    ap4.fromClient = PA.mergeAttribution({ intent: null, legacyMeta: { offerDiscount: 99999, offersApplied: [{ id: 'fake', amount: 99999 }] } });
    await reset({ f1: FLASH });
    const opts = { checkoutId: 'R1', orderId: 'ORD1', sellerUid: A, callerUid: 'buyer1', amount: 67500, pathLabel: 'intasend', writeSellerPayment: false,
      items: m.items, offerDiscount: m.offerDiscount, offersApplied: m.offersApplied, offerShopId: m.offerShopId };
    ap4.r = await finalize(db, ADMIN, opts);
    await finalize(db, ADMIN, opts);                                  /* replay */
    ap4.order = await get('orders/ORD1'); ap4.reds = await count('shopOfferRedemptions');
    ap4.red = await get('shopOfferRedemptions/ORD1__f1');
  } catch (e) { ap4.err = e.message; }
  const wh = src('functions/index.js');
  ck('AP4 offer figures come ONLY from the intent; finalisation records the discount on the order and ONE redemption per (order, offer)',
    ap4.fromIntent && ap4.fromIntent.offerDiscount === 7500 && ap4.fromClient && ap4.fromClient.offerDiscount === 0 && ap4.fromClient.offersApplied.length === 0
    && ap4.order && ap4.order.offerDiscount === 7500 && ap4.order.offersApplied.length === 1 && ap4.reds === 1 && ap4.red && ap4.red.discount === 7500
    && /offerDiscount: attribution\.offerDiscount \|\| 0,/.test(wh) && /discount:\s+_offerDisc,/.test(wh) && /Math\.round\(amount - \(_subtotal - _offerDisc\)\)/.test(wh),
    { intent: ap4.fromIntent && ap4.fromIntent.offerDiscount, client: ap4.fromClient && ap4.fromClient.offerDiscount, order: ap4.order && ap4.order.offerDiscount, reds: ap4.reds, err: ap4.err });

  /* AP5 — the till */
  let ap5 = {};
  if (!ZF || typeof ZF.posCompleteCheckout !== 'function') ap5.err = 'till did not load: ' + (ZF && ZF.__err);
  else try {
    await reset({ f1: FLASH });
    await db.doc('shops/' + A).set({ name: 'Tech Hub', sellerUid: A }); await db.doc('users/' + A).set({ displayName: 'Owner A' });
    let seq = 0;
    const till = (total) => ZF.posCompleteCheckout({ data: { idempotencyKey: 'IK' + (++seq), merchantId: A, items: [{ productId: 'laptop', qty: 1, unitPrice: 75000 }],
      subtotal: 75000, grandTotal: total, discountTotal: 0, taxTotal: 0, payments: [{ method: 'cash', amount: total }] }, auth: { uid: A, token: { posRole: 'cashier' } } })
      .then((r) => r, (e) => ({ err: e.code + ' | ' + e.message }));
    ap5.quote = await SO.quoteForCaller(db, { uid: A, data: { channel: 'till', shopId: A, items: [{ productId: 'laptop', qty: 1 }] } });
    ap5.stale = await till(75000);
    ap5.staleWrites = await count('posRetailSales');
    ap5.ok = await till(ap5.quote.total);
    const sales = (await db.collection('posRetailSales').get()).docs.map((d) => d.data());
    ap5.sale = sales[0]; ap5.reds = await count('shopOfferRedemptions');
    ap5.foreignQuote = await codeOf(SO.quoteForCaller(db, { uid: B, data: { channel: 'till', shopId: A, items: [{ productId: 'laptop', qty: 1 }] } }));
  } catch (e) { ap5.err = e.message; }
  ck('AP5 the till: quote 67,500 = the sale total; an undiscounted device total is refused unwritten; sale + receipt carry the offer; one redemption',
    ap5.quote && ap5.quote.total === 67500 && ap5.stale && /Total mismatch/.test(ap5.stale.err || '') && ap5.staleWrites === 0
    && ap5.ok && ap5.ok.saleId && ap5.sale && ap5.sale.grandTotal === 67500 && ap5.sale.offerDiscount === 7500 && ap5.sale.offersApplied.length === 1
    && ap5.ok.receipt && ap5.ok.receipt.discount === 7500 && ap5.ok.receipt.offersApplied.length === 1 && ap5.reds === 1 && ap5.foreignQuote === 'permission-denied',
    { quote: ap5.quote && ap5.quote.total, stale: ap5.stale && String(ap5.stale.err).slice(0, 70), sale: ap5.sale && ap5.sale.grandTotal, reds: ap5.reds, foreign: ap5.foreignQuote, err: ap5.err });

  /* AP6 — the sales limit, online and at the till */
  let ap6 = {};
  try {
    await reset({ f1: Object.assign({}, FLASH, { totalRedemptionLimit: 1 }) });
    await db.doc('shopOfferRedemptions/PRIOR__f1').set({ offerId: 'f1', shopId: A });
    ap6.online = await price([{ productId: 'laptop', qty: 1 }]);
    ap6.till = await SO.quoteForCaller(db, { uid: A, data: { channel: 'till', shopId: A, items: [{ productId: 'laptop', qty: 1 }] } });
  } catch (e) { ap6.err = e.message; }
  ck('AP6 an offer at its limit applies nowhere (online 75,000; till 75,000)',
    ap6.online && ap6.online.amountCents === 7500000 && ap6.till && ap6.till.total === 75000, { online: ap6.online && ap6.online.amountCents, till: ap6.till && ap6.till.total, err: ap6.err });

  /* AP7 — the card session's wiring (index.js scope) */
  ck('AP7 card session: offers per shop before the promo; no promo stacking on a shop offer; session + order carry it; redemptions on payment',
    /_SO\.quoteShopOffers\(db, \{ shopId: _sid, lines: sessionItems\.filter/.test(wh) && /else if \(_promoCode && offerDiscount > 0\)/.test(wh)
    && /const _grossTotal = Math\.round\(serverSubtotal - offerDiscount \+ safeDeliveryFee - deliveryWaived\)/.test(wh)   /* + a waived delivery (owner decision 2, AP12) */
    && /offerDiscount,\s+\/\* U7c2: server-applied shop offers/.test(wh) && /\.\.\.\(\(sessionDoc && \(Number\(sessionDoc\.offerDiscount\) > 0 \|\| Number\(sessionDoc\.deliveryWaived\) > 0\)\) \? \{\s+offerDiscount: Math\.max\(0, Math\.round\(Number\(sessionDoc\.offerDiscount\)/.test(wh)
    && /recordRedemptionsForOrder\(db, \{ orderId, shopId: k, buyerUid: sessionDoc\.uid \|\| null, applied: _byShop\[k\], source: "card" \}\)/.test(wh)
    && /exports\.shopOfferQuote\s+= _shopOffers\.shopOfferQuote;/.test(wh));

  /* AP9 — the display quote for a visitor who has not signed in */
  let ap9 = {};
  try {
    await reset({ f1: FLASH });
    ap9.anon = await SO.quoteForCaller(db, { uid: null, data: { items: [{ productId: 'laptop', qty: 1, offerId: 'someone-elses' }] } });
    ap9.till = await codeOf(SO.quoteForCaller(db, { uid: null, data: { channel: 'till', shopId: A, items: [{ productId: 'laptop', qty: 1 }] } }));
  } catch (e) { ap9.err = e.message; }
  ck('AP9 a signed-out visitor sees the same offer (agreed-price references dropped); the till quote refuses a signed-out caller',
    ap9.anon && ap9.anon.total === 67500 && ap9.anon.shops[0].lines[0].agreedPrice === false && ap9.till === 'unauthenticated',
    { anon: ap9.anon && ap9.anon.total, till: ap9.till, err: ap9.err });

  /* AP10 — checkout's display is the server's figure, and the cart hand-off is a code, never a discount */
  const ckh = src('checkout.html');
  ck('AP10 checkout shows the server quote (shopOfferQuote) in its total and takes a CODE from the cart, never a percentage',
    /httpsCallable\('shopOfferQuote'\)/.test(ckh) && /- promoSaving - shopOfferDisc - shopDeliveryWaived;/.test(ckh) && /id="shopOfferRow"/.test(ckh)
    && /_appliedPromoCode = String\(saved\.code\)\.trim\(\)\.toUpperCase\(\);\s+promoDiscount = 0;/.test(ckh) && !/promoDiscount = saved\.discount;/.test(ckh));

  /* AP11 — an OFFLINE sale replayed after an offer went live is recorded at what the customer paid, never lost */
  let ap11 = {};
  if (ZF && typeof ZF.posCompleteCheckout === 'function') try {
    await reset({ f1: FLASH });
    await db.doc('shops/' + A).set({ name: 'Tech Hub', sellerUid: A }); await db.doc('users/' + A).set({ displayName: 'Owner A' });
    let n = 0;
    const replay = (total, meta) => ZF.posCompleteCheckout({ data: { idempotencyKey: 'OFF' + (++n), merchantId: A, items: [{ productId: 'laptop', qty: 1, unitPrice: 75000 }],
      subtotal: 75000, grandTotal: total, discountTotal: 0, taxTotal: 0, payments: [{ method: 'cash', amount: total }], metadata: meta },
      auth: { uid: A, token: { posRole: 'cashier' } } }).then(() => 'ok', (e) => e.code + ' | ' + e.message);
    const q = { offlineQueuedAt: Date.now() - 3600e3 };
    ap11.shelf = await replay(75000, q);
    ap11.withOffer = await replay(67500, q);
    const origCol = db.collection.bind(db);
    db.collection = (nm) => (nm === 'shopOffers' ? { where: () => ({ where: () => ({ limit: () => ({ get: async () => { throw new Error('down'); } }) }) }), doc: (id) => origCol(nm).doc(id) } : origCol(nm));
    try { ap11.downOffline = await replay(75000, q); ap11.downLive = await replay(75000, undefined); } finally { db.collection = origCol; }
    const sales = (await db.collection('posRetailSales').get()).docs.map((d) => d.data());
    ap11.totals = sales.map((s) => [s.grandTotal, s.offerSkipped || null]).sort();
    ap11.reds = await count('shopOfferRedemptions');
  } catch (e) { ap11.err = e.message; }
  ck('AP11 offline replay: a shelf-price queued sale is recorded as paid (offerSkipped, no redemption); one showing the offer gets it; an outage never drops a queued sale — but still refuses a live one',
    ap11.shelf === 'ok' && ap11.withOffer === 'ok' && ap11.downOffline === 'ok' && /^failed-precondition \| The shop's offers could not be checked/.test(ap11.downLive || '')
    && JSON.stringify(ap11.totals) === JSON.stringify([[67500, null], [75000, 'offline_replay'], [75000, 'offline_replay']]) && ap11.reds === 1, ap11);

  /* AP12 — owner decision (2026-09-29): free delivery applies on the CARD rail too, shop-funded */
  let ap12 = {};
  try {
    await reset({ fd: { type: 'freeDelivery', template: 'freeDelivery', status: 'live', name: 'Free delivery over 1,000', minSpend: 1000 } });
    ap12.one = await SO.quoteForCaller(db, { uid: 'buyer1', data: { deliveryFee: 300, items: [{ productId: 'mouse', qty: 2 }] } });
    ap12.below = await SO.quoteForCaller(db, { uid: 'buyer1', data: { deliveryFee: 3000, items: [{ productId: 'mouse', qty: 2 }] } });
    await db.doc('products/other').set({ name: 'Other', price: 2000, stock: 5, sellerUid: B, shopId: B, status: 'active', isVisible: true });
    ap12.two = await SO.quoteForCaller(db, { uid: 'buyer1', data: { deliveryFee: 300, items: [{ productId: 'mouse', qty: 2 }, { productId: 'other', qty: 1 }] } });
  } catch (e) { ap12.err = e.message; }
  ck('AP12 free delivery on every rail: the shown fee is waived (single shop, goods ≥ fee); the card session charges goods + 0 and the order keeps the rider fee so settlement takes it from the SHOP',
    ap12.one && ap12.one.deliveryWaived === 300 && ap12.one.shops[0].applied.some((a) => a.kind === 'delivery')
    && ap12.below && ap12.below.deliveryWaived === 0 && ap12.two && ap12.two.deliveryWaived === 0
    && /deliveryFee: _single \? safeDeliveryFee : 0/.test(wh) && /\(serverSubtotal - _disc\) >= safeDeliveryFee/.test(wh)
    && /Math\.round\(serverSubtotal - offerDiscount \+ safeDeliveryFee - deliveryWaived\)/.test(wh)
    && /deliveryWaived: Math\.round\(Number\(sessionDoc\.deliveryWaived\)\), deliveryPaidByBuyer: 0/.test(wh)
    && /deliveryFee:\s+Number\(\(sessionDoc && sessionDoc\.deliveryFee\) \|\| 0\)/.test(wh),
    { one: ap12.one && ap12.one.deliveryWaived, below: ap12.below && ap12.below.deliveryWaived, two: ap12.two && ap12.two.deliveryWaived, err: ap12.err });

  /* AP8 — Quick Charge cannot masquerade as the catalogue */
  let ap8 = {};
  try {
    const QA = require(path.join(FN, 'sokoni-qr-authority.js'));
    const till = { sokoniTillId: 'T1', shopId: A, branchId: 'b', merchantUid: A, status: 'ACTIVE', currency: 'KES' };   /* the producer's own vocabulary (checkTillPayable) */
    const payable = typeof QA.checkTillPayable === 'function' ? QA.checkTillPayable(till) : { ok: true };
    ap8.payable = payable.ok;
    const r = QA.priceTillSale({ till, callerUid: A, data: { items: [{ name: 'Laptop', price: 5, qty: 1, productId: 'laptop', offerId: 'x' }] } });
    ap8.line = r.metadata.items[0]; ap8.orderId = r.metadata.orderId; ap8.amount = r.amountCents;
  } catch (e) { ap8.err = e.message; }
  ck('AP8 Quick Charge: a free-typed line keeps only name/price/qty — no productId, no order — so it moves no catalogue stock and takes no offer',
    ap8.line && Object.keys(ap8.line).sort().join(',') === 'name,price,qty' && ap8.orderId === undefined && ap8.amount === 500
    && /const _isProductPay = !!_pm\.orderId/.test(wh), ap8);

  say(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { say('CRASH ' + (e && e.stack || e)); process.exit(2); });
