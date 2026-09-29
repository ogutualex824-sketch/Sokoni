/* test-product-offers.js — buyer price offers, honoured at checkout ONLY by the server (T2b, 2026-09-29)
 *   REAL functions/product-offers.js through the REAL messagesDispatch, the REAL payment-purposes.validateOrderLines
 *   (product_order + multi-shop quote) and the REAL _finalizeMarketplacePayment, extracted verbatim from
 *   functions/index.js, all over the fake Firestore.
 *
 * OWNER RULES (docs/PRODUCT_OFFERS.md): per-product opt-in · floor 50% · 24 h hold · the agreed qty only · commission
 * on the paid (agreed) amount.
 *
 * PROVES
 *   PO1 offers are refused where the seller has not opted in; signed-out and own-product are refused
 *   PO2 the floor and the ceiling: < 50% refused, ≥ list price refused; a valid offer is a server record + a note in
 *       the product conversation (the seller's merchant-v2 Messages)
 *   PO3 turns: the proposer cannot answer themselves, a stranger cannot act; the seller counters, the buyer's counter
 *       below the floor is refused, the buyer accepts → 24 h hold
 *   PO4 only one open negotiation per product and buyer
 *   PO5 checkout charges the agreed price only through the server: validateOrderLines prices the line at the agreed
 *       amount and keeps the offerId; lines without an offer keep the catalogue price
 *   PO6 checkout REFUSES a misused offer: another buyer, over the agreed qty (also split across two lines), another
 *       product, expired, not accepted
 *   PO7 the seller turns offers on/off — only for their own product
 *   PO8 payment success consumes the offer (state purchased, the order recorded); a second paid order on it is
 *       FLAGGED in offerOveruseAlerts, never refused; the receipt line shows the charged price
 *   PO9 the client never states a price: checkout sends offerId only; createCheckoutSession prices through the same
 *       resolver; the product page hides Make-an-offer unless the seller opted in
 *
 *   node scripts/test-product-offers.js
 */
'use strict';
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:1';
process.env.GCLOUD_PROJECT = 'demo-product-offers';
delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
delete process.env.K_SERVICE; delete process.env.FUNCTION_TARGET;
const fs = require('fs');
const Path = require('path');
const ROOT = Path.resolve(__dirname, '..');
const FN = Path.join(ROOT, 'functions');
const { makeFakeFirestore } = require('./lib/fake-firestore-txn');
let NOW = Date.parse('2026-09-29T09:00:00Z');
const realNow = Date.now; Date.now = () => NOW;
const F = makeFakeFirestore({ clock: () => NOW });
const db = F.db;
const say = console.log; console.log = console.info = console.warn = console.error = console.debug = () => {};
const stub = (m, exp) => { const p = m.startsWith('./') ? Path.join(FN, m + '.js') : require.resolve(m, { paths: [FN] }); require.cache[p] = { id: p, filename: p, loaded: true, exports: exp }; };
const ADMIN = { apps: [{}], initializeApp: () => ({}), app: () => ({}), firestore: Object.assign(() => db, { FieldValue: F.FieldValue, Timestamp: F.Timestamp, FieldPath: F.FieldPath }),
  auth: () => ({ getUser: async (u) => ({ uid: u, customClaims: {} }) }), messaging: () => ({ send: async () => ({}) }) };
stub('firebase-admin/firestore', { getFirestore: () => db, FieldValue: F.FieldValue, Timestamp: F.Timestamp, FieldPath: F.FieldPath });
stub('firebase-admin', ADMIN);
const run = (fn) => (req) => (typeof fn.run === 'function' ? fn.run(req) : fn(req));
const DISP = require(Path.join(FN, 'messages-dispatch.js'));
const PP = require(Path.join(FN, 'payment-purposes.js'));

let pass = 0, fail = 0;
const ck = (l, ok, d) => { say('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined && d !== '' ? '   [' + String(typeof d === 'object' ? JSON.stringify(d) : d).slice(0, 260) + ']' : '')); ok ? pass++ : fail++; };
const as = (uid, data) => ({ auth: uid ? { uid, token: { email_verified: true } } : null, data: data || {}, rawRequest: { headers: {} } });
const op = (uid, name, data) => run(DISP.messagesDispatch)(as(uid, Object.assign({ op: name }, data)));
const tryv = async (p) => { try { return await p; } catch (e) { return null; } };
const codeOf = async (p) => { try { await p; return null; } catch (e) { return (e && e.details && e.details.code) || (e && (e.code || e.message)) || 'error'; } };
const get = async (p) => { const s = await db.doc(p).get(); return s.exists ? s.data() : null; };
const src = (f) => { try { return fs.readFileSync(Path.join(ROOT, f), 'utf8'); } catch (_) { return ''; } };

/* the REAL finalize, extracted verbatim from functions/index.js (it takes db + admin as parameters) */
function extractFinalize() {
  const s = src('functions/index.js');
  const i = s.indexOf('async function _finalizeMarketplacePayment(');
  if (i < 0) return null;
  let depth = 0, j = s.indexOf('{', s.indexOf(')', i));
  for (let k = j; k < s.length; k++) { if (s[k] === '{') depth++; else if (s[k] === '}') { depth--; if (depth === 0) { j = k; break; } } }
  try { return new Function('return (' + s.slice(i, j + 1) + ')')(); } catch (_) { return null; }
}

(async () => {
  for (const u of ['sel', 'buy', 'buy2', 'x']) await db.doc('users/' + u).set({ name: u });
  await db.doc('products/pOff').set({ name: 'Kiondo Basket', price: 2000, sellerUid: 'sel', status: 'active', isVisible: true, stock: 10, acceptOffers: true });
  await db.doc('products/pNo').set({ name: 'Sisal Mat', price: 1500, sellerUid: 'sel', status: 'active', isVisible: true, stock: 10 });
  await db.doc('products/pOther').set({ name: 'Beaded Belt', price: 800, sellerUid: 'sel', status: 'active', isVisible: true, stock: 10 });

  say('\n── negotiation ──');
  const off = await codeOf(op('buy', 'productOfferSend', { productId: 'pNo', amount: 1000, qty: 1 }));
  const anon = await codeOf(op(null, 'productOfferSend', { productId: 'pOff', amount: 1500 }));
  const own = await codeOf(op('sel', 'productOfferSend', { productId: 'pOff', amount: 1500 }));
  ck('PO1 no offers without the seller\'s opt-in; signed-out and own product refused', off === 'OFFERS_OFF' && !!anon && !!own, { off, anon, own });

  const low = await codeOf(op('buy', 'productOfferSend', { productId: 'pOff', amount: 999, qty: 2 }));
  const high = await codeOf(op('buy', 'productOfferSend', { productId: 'pOff', amount: 2000, qty: 2 }));
  const sent = await tryv(op('buy', 'productOfferSend', { productId: 'pOff', amount: 1500, qty: 2 }));
  const oid = sent && sent.offer && sent.offer.offerId;
  const rec = oid ? await get('productOffers/' + oid) : null;
  const notes = (await db.collection('conversations').doc('product_enquiry_' + oid).collection('messages').get()).docs.map((d) => d.data());
  ck('PO2 < 50% and ≥ list refused; a valid offer is a server record and a note in the product conversation',
    low === 'BELOW_FLOOR' && high === 'NOT_BELOW_PRICE' && rec && rec.state === 'pending' && rec.proposedBy === 'buyer' && rec.amount === 1500 && rec.qty === 2
    && notes.some((m) => m.type === 'system' && m.event && m.event.offerId === oid && m.event.kind === 'offer' && m.event.state === 'pending'), { low, high, state: rec && rec.state, notes: notes.length });

  const self = await codeOf(op('buy', 'productOfferRespond', { offerId: oid, action: 'accept' }));
  const stranger = await codeOf(op('x', 'productOfferRespond', { offerId: oid, action: 'accept' }));
  const ctr = await tryv(op('sel', 'productOfferRespond', { offerId: oid, action: 'counter', amount: 1800 }));
  const again = await codeOf(op('sel', 'productOfferRespond', { offerId: oid, action: 'accept' }));
  const lowCtr = await codeOf(op('buy', 'productOfferRespond', { offerId: oid, action: 'counter', amount: 900 }));
  const acc = await tryv(op('buy', 'productOfferRespond', { offerId: oid, action: 'accept' }));
  const r2 = await get('productOffers/' + oid);
  ck('PO3 turns enforced; seller counters; buyer counter below floor refused; buyer accepts → 24 h hold at the counter price',
    self === 'NOT_YOUR_TURN' && stranger === 'NOT_A_PARTY' && ctr && ctr.offer.proposedBy === 'seller' && again === 'NOT_YOUR_TURN' && lowCtr === 'BELOW_FLOOR'
    && acc && r2 && r2.state === 'accepted' && r2.amount === 1800 && r2.expiresAt === NOW + 24 * 3600 * 1000, { self, stranger, again, lowCtr, state: r2 && r2.state, amount: r2 && r2.amount });
  const dup = await codeOf(op('buy', 'productOfferSend', { productId: 'pOff', amount: 1500, qty: 1 }));
  const mine = await tryv(op('buy', 'productOfferMine', { productId: 'pOff' }));
  ck('PO4 one negotiation per product and buyer; the buyer reads their agreed price', dup === 'ACCEPTED' && mine && mine.offer.state === 'accepted' && mine.offer.amount === 1800, { dup });

  say('\n── checkout ──');
  const v = await tryv(PP.validateOrderLines('buy', [{ productId: 'pOff', qty: 2, offerId: oid }, { productId: 'pOther', qty: 1 }]));
  const L = v && v.lines;
  ck('PO5 the agreed price is charged ONLY because the server read it; other lines keep the catalogue price',
    v && L[0].unitPrice === 1800 && L[0].offerId === oid && L[0].listUnitPrice === 2000 && L[1].unitPrice === 800 && !L[1].offerId && v.subtotal === 1800 * 2 + 800, v && { sub: v.subtotal, L });
  const byOther = await codeOf(PP.validateOrderLines('buy2', [{ productId: 'pOff', qty: 1, offerId: oid }]));
  const overQty = await codeOf(PP.validateOrderLines('buy', [{ productId: 'pOff', qty: 3, offerId: oid }]));
  const split = await codeOf(PP.validateOrderLines('buy', [{ productId: 'pOff', qty: 2, offerId: oid }, { productId: 'pOff', qty: 1, offerId: oid }]));
  const wrongProd = await codeOf(PP.validateOrderLines('buy', [{ productId: 'pOther', qty: 1, offerId: oid }]));
  const fake = await codeOf(PP.validateOrderLines('buy', [{ productId: 'pOff', qty: 1, offerId: 'pOff__nobody' }]));
  NOW += 24 * 3600 * 1000 + 1000;
  const expired = await codeOf(PP.validateOrderLines('buy', [{ productId: 'pOff', qty: 1, offerId: oid }]));
  const mineExp = await tryv(op('buy', 'productOfferMine', { productId: 'pOff' }));
  NOW -= 24 * 3600 * 1000 + 1000;
  ck('PO6 misuse refused: other buyer, over qty, split over qty, other product, unknown, expired',
    byOther === 'OFFER_NOT_YOURS' && overQty === 'OFFER_QTY' && split === 'OFFER_QTY' && wrongProd === 'OFFER_PRODUCT' && fake === 'OFFER_MISSING'
    && expired === 'OFFER_EXPIRED' && mineExp && mineExp.offer.state === 'expired', { byOther, overQty, split, wrongProd, fake, expired });

  const setOther = await codeOf(op('x', 'productOfferSettings', { productId: 'pNo', acceptOffers: true }));
  const setOk = await tryv(op('sel', 'productOfferSettings', { productId: 'pNo', acceptOffers: true }));
  const pNo = await get('products/pNo');
  ck('PO7 only the product\'s seller turns offers on', setOther === 'NOT_SELLER' && setOk && pNo && pNo.acceptOffers === true, { setOther });

  say('\n── payment success ──');
  const finalize = extractFinalize();
  if (!finalize) ck('PO8 the real finalize could be extracted from index.js', false);
  else {
    const lines = ((v && v.lines) || [{ productId: 'pOff', qty: 2, unitPrice: 1800, sellerUid: 'sel', offerId: oid }]).map((l) => Object.assign({}, l));
    const r1 = await tryv(finalize(db, ADMIN, { checkoutId: 'ORD1', orderId: 'ORD1', sellerUid: 'sel', callerUid: 'buy', amount: 4400, items: lines, pathLabel: 'intasend', writeSellerPayment: false }));
    const o1 = await get('productOffers/' + oid);
    const r2b = await tryv(finalize(db, ADMIN, { checkoutId: 'ORD2', orderId: 'ORD2', sellerUid: 'sel', callerUid: 'buy', amount: 3600, items: [lines[0]], pathLabel: 'intasend', writeSellerPayment: false }));
    const alerts = (await db.collection('offerOveruseAlerts').get()).docs.map((d) => d.data());
    const ord2 = await get('orders/ORD2');
    const recLine = r1 && r1.pricedItems && r1.pricedItems.find((x) => x.productId === 'pOff');
    const afterUse = await codeOf(PP.validateOrderLines('buy', [{ productId: 'pOff', qty: 1, offerId: oid }]));
    ck('PO8 payment consumes the offer; a 2nd paid order is flagged (order still written); receipt shows the charged price; a used offer is refused',
      r1 && r1.finalised && o1 && o1.state === 'purchased' && o1.consumedOrderId === 'ORD1'
      && r2b && r2b.finalised && ord2 && ord2.status === 'paid' && alerts.some((a) => a.offerId === oid && a.orderId === 'ORD2' && a.previousOrderId === 'ORD1')
      && recLine && recLine.unitPrice === 1800 && afterUse === 'OFFER_USED', { state: o1 && o1.state, alerts: alerts.length, recUnit: recLine && recLine.unitPrice, afterUse });
  }

  const idx = src('functions/index.js'), co = src('checkout.html'), pj = src('product.js');
  ck('PO9 the client never states a price: checkout sends offerId; the card session prices through the same resolver; Offer shown only when opted in',
    /i\.offerId \? \{ offerId: String\(i\.offerId\) \} : \{\}/.test(co) && (co.match(/offerId: String\(i\.offerId\)/g) || []).length === 2
    && /const _offerPrice = await require\("\.\/product-offers"\)\.offerResolver\(db, request\.auth\.uid, cartItems, Date\.now\(\)\)/.test(idx)
    && /const \{ unitPrice, offerId: _offerId \} = _offerPrice\(item, pid, qty, _catalogueUnit\)/.test(idx)
    && /product\.acceptOffers === true \? '<button onclick="openMakeOffer\(\)"/.test(pj) && !/localStorage[^\n]*sokoniOffers/.test(pj));

  Date.now = realNow;
  say(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { say('CRASH ' + (e && e.stack || e)); process.exit(2); });
