'use strict';
/**
 * SOKONI — Buyer price offers  (2026-09-29, product conversations T2b)
 * ============================================================================================
 * A buyer offers a price for N units; the seller accepts, rejects or counters; the buyer may accept or counter back.
 * An accepted price is honoured at checkout — ONLY by the server pricers (payment-purposes.validateOrderLines and
 * index.js createCheckoutSession), through applyOfferToLine below. The client never states a price.
 *
 * Before: the product page's offer and seller.html's offer inbox lived in localStorage (sokoniOffers) — no seller
 * ever saw an offer, "accepted" changed nothing at checkout.
 *
 * OWNER RULES (2026-09-29, docs/PRODUCT_OFFERS.md):
 *   · a product receives offers only when its seller turned "Accept offers" on (products/{id}.acceptOffers === true)
 *   · the lowest buyer offer is 50% of the listed price; a seller's counter is free (above 0, at most the list price)
 *   · an accepted price holds for 24 h, for the offer's quantity only
 *   · commission is charged on what was actually paid (the agreed price) — settlement already uses the paid amount
 *
 * ONE record per (product, buyer): productOffers/{productId}__{buyerUid}. A new offer after a final state starts a
 * new round on the same record (history kept). Every step is a transaction; whose turn it is is enforced here.
 * The negotiation is visible in the product conversation (product_enquiry — the same thread as questions) as system
 * notes carrying { offerId, kind:'offer', state, amount, qty, by }.
 *
 * CONSUMPTION: _finalizeMarketplacePayment (index.js) marks the offer 'purchased' for the paid order inside its
 * order transaction; a second paid order on the same offer is FLAGGED in offerOveruseAlerts, never refused (the money
 * is already taken — the house rule for post-payment races).
 *
 * Ops (routed by messages-dispatch.js): productOfferSend · productOfferRespond · productOfferWithdraw ·
 *                                       productOfferMine · productOfferSettings
 */
const { HttpsError } = require('firebase-functions/v2/https');
const admin = require('firebase-admin');

const _db = () => admin.firestore();
const _ts = () => admin.firestore.FieldValue.serverTimestamp();
const fail = (code, msg, details) => { throw new HttpsError(code, msg, details); };

const RULES = Object.freeze({
  floorShare: 0.5,               /* owner: minimum buyer offer = 50% of the listed price */
  holdMs: 24 * 3600 * 1000,      /* owner: an accepted price holds for 24 h */
  maxRounds: 6,                  /* offers + counters on one round before it must be settled */
  maxQty: 99,
  perBuyerPerDay: 20,
});
const OPEN = ['pending'];                    /* waiting for the other party (proposedBy says who proposed) */
const HIDDEN_STATES = ['archived', 'deleted', 'draft', 'suspended', 'hidden'];

const listPriceOf = (p) => Number(p.salePrice || p.price || 0);
const kes = (n) => 'KES ' + Math.round(n).toLocaleString('en-KE');
const offerIdOf = (productId, buyerUid) => `${productId}__${buyerUid}`;
const _clean = (s, n) => String(s == null ? '' : s).trim().slice(0, n);

/** The state a reader should see — an accepted offer past its hold reads as expired. */
function effectiveState(o, now) {
  if (!o) return null;
  if (o.state === 'accepted' && !o.consumedOrderId && Number(o.expiresAt) > 0 && now >= Number(o.expiresAt)) return 'expired';
  return o.state || null;
}

function _publicView(id, o, now) {
  const st = effectiveState(o, now);
  return {
    offerId: id, productId: o.productId, productName: o.productName || null, state: st,
    amount: o.amount, qty: o.qty, listPrice: o.listPrice, proposedBy: o.proposedBy, round: o.round || 1,
    expiresAt: st === 'accepted' ? Number(o.expiresAt) || null : null,
    turn: st === 'pending' ? (o.proposedBy === 'buyer' ? 'seller' : 'buyer') : null,
    conversationId: o.conversationId || null,
    history: (o.history || []).slice(-12),
  };
}

async function _loadProduct(db, productId) {
  const s = await db.collection('products').doc(productId).get();
  if (!s.exists) fail('not-found', 'That product is no longer available.');
  const p = s.data() || {};
  const sellerUid = p.sellerUid || p.sellerId || null;
  if (!sellerUid) fail('failed-precondition', 'This product has no seller.');
  if (p.isVisible === false || HIDDEN_STATES.includes(String(p.status || '').toLowerCase())) fail('failed-precondition', 'That product is not available.');
  return { p, sellerUid };
}

async function _note(db, conversationId, key, text, o, id) {
  if (!conversationId) return;
  await require('./messages').postSystemMessage(db, conversationId, key, text,
    { offerId: id, kind: 'offer', state: o.state, amount: o.amount, qty: o.qty, by: o.proposedBy, tag: 'ENQUIRIES' });
}

const _h = {};

/** Buyer → an offer for N units. { productId, amount, qty? } */
_h.productOfferSend = async (req) => {
  const uid = req.auth && req.auth.uid;
  if (!uid) fail('unauthenticated', 'Sign in to make an offer.');
  if (req.auth.token && req.auth.token.deactivated === true) fail('permission-denied', 'Your account is deactivated.');
  const d = req.data || {};
  const productId = _clean(d.productId, 128);
  if (!productId || productId.includes('/')) fail('invalid-argument', 'productId is required.');
  const amount = Math.round(Number(d.amount));
  const qty = Math.round(Number(d.qty == null ? 1 : d.qty));
  if (!(amount > 0)) fail('invalid-argument', 'Enter your offer in KES.');
  if (!(qty >= 1 && qty <= RULES.maxQty)) fail('invalid-argument', 'Choose how many you want (1–99).');
  const db = _db();
  const { p, sellerUid } = await _loadProduct(db, productId);
  if (sellerUid === uid) fail('failed-precondition', 'This is your own product.');
  if (p.acceptOffers !== true) fail('failed-precondition', 'This seller is not taking offers on this product.', { code: 'OFFERS_OFF' });
  const list = listPriceOf(p);
  if (!(list > 0)) fail('failed-precondition', 'This product has no price.');
  const floor = Math.ceil(list * RULES.floorShare);
  if (amount < floor) fail('invalid-argument', `The lowest offer for this product is ${kes(floor)}.`, { code: 'BELOW_FLOOR', floor });
  if (amount >= list) fail('invalid-argument', `That is the listed price (${kes(list)}) — add it to your cart instead.`, { code: 'NOT_BELOW_PRICE' });
  if (typeof p.stock === 'number' && qty > p.stock) fail('failed-precondition', `Only ${p.stock} available.`, { code: 'STOCK' });

  /* the product conversation (same thread as questions) — the seller answers in merchant-v2 › Messages */
  const MSG = require('./messages');
  const pair = offerIdOf(productId, uid);
  const { conversationId } = await MSG.ensureAnchoredConversation(db, { transactionType: 'product_enquiry', transactionId: pair,
    title: `Question · ${_clean(p.name || p.title || 'your product', 80)}`, participants: [uid, sellerUid],
    metadata: { productId, productName: _clean(p.name || p.title, 120), shopId: p.shopId || sellerUid, price: list } });

  const ref = db.collection('productOffers').doc(pair);
  const limRef = db.collection('productEnquiryLimits').doc('o_' + uid);
  const now = Date.now(); const day = new Date(now + 3 * 3600000).toISOString().slice(0, 10);
  let out;
  await db.runTransaction(async (t) => {
    const [s, l] = [await t.get(ref), await t.get(limRef)];
    const cur = s.exists ? s.data() : null;
    const st = effectiveState(cur, now);
    if (st === 'pending') fail('failed-precondition', cur.proposedBy === 'buyer' ? 'Your offer is waiting for the seller.' : 'The seller countered — reply to that first.', { code: 'OPEN_OFFER' });
    if (st === 'accepted') fail('failed-precondition', 'You already have an agreed price — buy it before it expires.', { code: 'ACCEPTED' });
    const ld = l.exists ? l.data() : {};
    const count = ld.day === day ? Number(ld.count) || 0 : 0;
    if (count >= RULES.perBuyerPerDay) fail('resource-exhausted', 'You have made the maximum number of offers for today.', { code: 'RATE_LIMITED' });
    const round = (cur && Number(cur.round)) ? Number(cur.round) + 1 : 1;
    out = { productId, productName: _clean(p.name || p.title, 120), sellerUid, buyerUid: uid, shopId: p.shopId || sellerUid, conversationId,
      listPrice: list, amount, qty, proposedBy: 'buyer', state: 'pending', round, moves: 1, expiresAt: null, acceptedAt: null, consumedOrderId: null,
      history: [...((cur && cur.history) || []).slice(-20), { by: 'buyer', action: 'offer', amount, qty, at: now }], updatedAt: _ts() };
    t.set(ref, Object.assign({}, out, cur ? {} : { createdAt: _ts() }));
    t.set(limRef, { day, count: count + 1, updatedAt: now });
  });
  await _note(db, conversationId, `offer_${pair}_${out.round}_1`, `Offer: ${kes(amount)} each for ${qty} (listed ${kes(list)}).`, out, pair);
  return { ok: true, offer: _publicView(pair, out, now) };
};

/** Either party, on their turn → accept | reject | counter. { offerId, action, amount? } */
_h.productOfferRespond = async (req) => {
  const uid = req.auth && req.auth.uid;
  if (!uid) fail('unauthenticated', 'Sign in required.');
  const d = req.data || {};
  const offerId = _clean(d.offerId, 300);
  const action = String(d.action || '');
  if (!offerId || offerId.includes('/')) fail('invalid-argument', 'offerId is required.');
  if (!['accept', 'reject', 'counter'].includes(action)) fail('invalid-argument', 'action must be accept, reject or counter.');
  const db = _db();
  const ref = db.collection('productOffers').doc(offerId);
  const now = Date.now();
  let o, note;
  await db.runTransaction(async (t) => {
    const s = await t.get(ref);
    if (!s.exists) fail('not-found', 'That offer no longer exists.');
    o = s.data() || {};
    const role = uid === o.sellerUid ? 'seller' : uid === o.buyerUid ? 'buyer' : null;
    if (!role) fail('permission-denied', 'This offer is not yours.', { code: 'NOT_A_PARTY' });
    if (effectiveState(o, now) !== 'pending') fail('failed-precondition', 'This offer is no longer open.', { code: 'NOT_OPEN' });
    if (o.proposedBy === role) fail('failed-precondition', 'It is the other party\'s turn.', { code: 'NOT_YOUR_TURN' });
    const hist = (o.history || []).slice(-20);
    if (action === 'accept') {
      o = Object.assign({}, o, { state: 'accepted', acceptedAt: now, expiresAt: now + RULES.holdMs, acceptedBy: role,
        history: [...hist, { by: role, action: 'accept', amount: o.amount, qty: o.qty, at: now }] });
      note = `${role === 'seller' ? 'Seller' : 'Buyer'} accepted ${kes(o.amount)} each for ${o.qty}. The price holds for 24 hours.`;
    } else if (action === 'reject') {
      o = Object.assign({}, o, { state: 'rejected', history: [...hist, { by: role, action: 'reject', amount: o.amount, qty: o.qty, at: now }] });
      note = `${role === 'seller' ? 'Seller' : 'Buyer'} declined the offer of ${kes(o.amount)}.`;
    } else {
      const amount = Math.round(Number(d.amount));
      if (!(amount > 0)) fail('invalid-argument', 'Enter the counter price in KES.');
      if (amount >= o.listPrice) fail('invalid-argument', `A counter must be below the listed price (${kes(o.listPrice)}).`, { code: 'NOT_BELOW_PRICE' });
      if (role === 'buyer' && amount < Math.ceil(o.listPrice * RULES.floorShare)) fail('invalid-argument', `The lowest offer is ${kes(Math.ceil(o.listPrice * RULES.floorShare))}.`, { code: 'BELOW_FLOOR' });
      if ((Number(o.moves) || 1) >= RULES.maxRounds) fail('failed-precondition', 'Too many counters — accept or decline.', { code: 'TOO_MANY_ROUNDS' });
      o = Object.assign({}, o, { amount, proposedBy: role, moves: (Number(o.moves) || 1) + 1,
        history: [...hist, { by: role, action: 'counter', amount, qty: o.qty, at: now }] });
      note = `${role === 'seller' ? 'Seller' : 'Buyer'} countered: ${kes(amount)} each for ${o.qty}.`;
    }
    o.updatedAt = _ts();
    t.set(ref, o);
  });
  await _note(db, o.conversationId, `offer_${offerId}_${o.round}_${o.history.length}`, note, o, offerId);
  return { ok: true, offer: _publicView(offerId, o, now) };
};

/** Buyer withdraws an open offer. { offerId } */
_h.productOfferWithdraw = async (req) => {
  const uid = req.auth && req.auth.uid;
  if (!uid) fail('unauthenticated', 'Sign in required.');
  const offerId = _clean((req.data || {}).offerId, 300);
  if (!offerId || offerId.includes('/')) fail('invalid-argument', 'offerId is required.');
  const db = _db(); const ref = db.collection('productOffers').doc(offerId); const now = Date.now();
  let o;
  await db.runTransaction(async (t) => {
    const s = await t.get(ref);
    if (!s.exists) fail('not-found', 'That offer no longer exists.');
    o = s.data() || {};
    if (o.buyerUid !== uid) fail('permission-denied', 'Only the buyer can withdraw this offer.', { code: 'NOT_BUYER' });
    const st = effectiveState(o, now);
    if (st !== 'pending' && st !== 'accepted') fail('failed-precondition', 'This offer is no longer open.', { code: 'NOT_OPEN' });
    o = Object.assign({}, o, { state: 'withdrawn', history: [...(o.history || []).slice(-20), { by: 'buyer', action: 'withdraw', amount: o.amount, qty: o.qty, at: now }], updatedAt: _ts() });
    t.set(ref, o);
  });
  await _note(db, o.conversationId, `offer_${offerId}_${o.round}_${o.history.length}`, 'The buyer withdrew the offer.', o, offerId);
  return { ok: true, offer: _publicView(offerId, o, now) };
};

/** The caller's offer on a product (buyer) — the product page's state. { productId } */
_h.productOfferMine = async (req) => {
  const uid = req.auth && req.auth.uid;
  if (!uid) fail('unauthenticated', 'Sign in required.');
  const productId = _clean((req.data || {}).productId, 128);
  if (!productId || productId.includes('/')) fail('invalid-argument', 'productId is required.');
  const s = await _db().collection('productOffers').doc(offerIdOf(productId, uid)).get();
  return { ok: true, offer: s.exists ? _publicView(s.id, s.data() || {}, Date.now()) : null };
};

/** Seller → turn offers on/off for their own product. { productId, acceptOffers } */
_h.productOfferSettings = async (req) => {
  const uid = req.auth && req.auth.uid;
  if (!uid) fail('unauthenticated', 'Sign in required.');
  const d = req.data || {};
  const productId = _clean(d.productId, 128);
  if (!productId || productId.includes('/')) fail('invalid-argument', 'productId is required.');
  if (typeof d.acceptOffers !== 'boolean') fail('invalid-argument', 'acceptOffers must be true or false.');
  const db = _db(); const ref = db.collection('products').doc(productId);
  const s = await ref.get();
  if (!s.exists) fail('not-found', 'Product not found.');
  const p = s.data() || {};
  if ((p.sellerUid || p.sellerId) !== uid) fail('permission-denied', 'Only this product\'s seller can change offers.', { code: 'NOT_SELLER' });
  await ref.set({ acceptOffers: d.acceptOffers, updatedAt: _ts() }, { merge: true });
  return { ok: true, productId, acceptOffers: d.acceptOffers };
};

/* ═══ CHECKOUT — the only way an agreed price reaches a charge ═══════════════════════════════════════════════ */

/**
 * The unit price for one cart line that carries an offerId. Pure over the offer document.
 * Refuses (never silently re-prices) so the buyer is never charged a total they did not see.
 * @returns {{ unitPrice:number, offerId:string, qtyCap:number }}
 */
function offerPriceForLine(offer, { offerId, uid, productId, qty, now }) {
  if (!offer) fail('failed-precondition', 'That agreed price no longer exists. Remove the item and add it again.', { code: 'OFFER_MISSING' });
  if (offer.buyerUid !== uid) fail('permission-denied', 'That agreed price belongs to another buyer.', { code: 'OFFER_NOT_YOURS' });
  if (offer.productId !== productId) fail('failed-precondition', 'That agreed price is for a different product.', { code: 'OFFER_PRODUCT' });
  if (offer.consumedOrderId) fail('failed-precondition', 'That agreed price has already been used.', { code: 'OFFER_USED' });
  const st = effectiveState(offer, now);
  if (st === 'expired') fail('failed-precondition', 'Your agreed price has expired. Remove the item and add it again at the listed price.', { code: 'OFFER_EXPIRED' });
  if (st !== 'accepted') fail('failed-precondition', 'That price has not been agreed.', { code: 'OFFER_NOT_ACCEPTED' });
  if (qty > Number(offer.qty)) fail('failed-precondition', `Your agreed price covers ${offer.qty}. Reduce the quantity.`, { code: 'OFFER_QTY' });
  const unitPrice = Math.round(Number(offer.amount));
  if (!(unitPrice > 0)) fail('failed-precondition', 'That agreed price is invalid.', { code: 'OFFER_INVALID' });
  return { unitPrice, offerId, qtyCap: Number(offer.qty) };
}

/**
 * For the server pricers: reads the offers referenced by the cart lines (one read each) and returns a resolver
 * line → unitPrice. Lines without an offerId keep the catalogue price. The SAME offer on two lines is refused
 * when their quantities together exceed the agreed quantity.
 */
async function offerResolver(db, uid, rawItems, now) {
  const ids = [...new Set((rawItems || []).map((i) => i && i.offerId ? String(i.offerId) : '').filter((s) => s && !s.includes('/')))];
  const offers = {};
  for (const id of ids) {
    const s = await db.collection('productOffers').doc(id).get();
    offers[id] = s.exists ? s.data() : null;
  }
  const used = {};
  return function priceLine(raw, productId, qty, catalogueUnit) {
    const offerId = raw && raw.offerId ? String(raw.offerId) : '';
    if (!offerId) return { unitPrice: catalogueUnit, offerId: null };
    if (offerId.includes('/')) fail('invalid-argument', 'Invalid offer reference.');
    const r = offerPriceForLine(offers[offerId], { offerId, uid, productId, qty, now: now || Date.now() });
    used[offerId] = (used[offerId] || 0) + qty;
    if (used[offerId] > r.qtyCap) fail('failed-precondition', `Your agreed price covers ${r.qtyCap}. Reduce the quantity.`, { code: 'OFFER_QTY' });
    return { unitPrice: r.unitPrice, offerId };
  };
}

module.exports = { _h, RULES, effectiveState, offerPriceForLine, offerResolver, offerIdOf };
