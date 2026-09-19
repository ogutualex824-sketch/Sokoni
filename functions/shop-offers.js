/* ══════════════════════════════════════════════════════════════════════════════
   SOKONI — MERCHANT OFFERS, SERVER SIDE                        (Gate P, implementation)
   functions/shop-offers.js

   The write authority for merchant offers, and the only thing permitted to decide what a
   merchant offer takes off a real basket.

   ── WHY A NEW COLLECTION, AND NOT ONE OF THE TWO THAT EXIST ─────────────────────────────
   `offers`     is the platform-ADMIN product price-drop mechanism: productId, offerPrice,
                originalPrice, one active per product, governed by rules with isAdmin().
   `promotions` is admin content AND admin promo codes — a banner engine in promotions.js
                and coupon documents in finos.js, sharing one collection with no
                discriminator. Its redemption ledger, promotionUsage, carries FUNDING
                ATTRIBUTION (fundedBy / platformFundingPct / sellerFundingPct).

   A merchant's bundle discount is merchant-funded by definition. Writing it into that
   ledger would file merchant money against a platform funding split — a settlement
   attribution error, not a naming inconvenience. So: a third collection, its own
   redemption ledger, and neither of the other two touched.

   ── WHY THE SEMANTICS ARE IMPLEMENTED TWICE ─────────────────────────────────────────────
   `firebase deploy --only functions` uploads functions/ and nothing else, so a
   require('../sokoni-promotion-model.js') resolves on a developer's machine and throws
   MODULE_NOT_FOUND in production. functions/auth-policy.js already faced this and settled
   it: implement the semantics twice, deliberately, and hold the two together with a
   CONTRACT rather than with hope.

     scripts/offer-resolution-vectors.json   baskets + offers -> expected outcome
     scripts/test-offer-engine-parity.js     replays every vector against BOTH the client
                                             resolver and this one, pairwise

   A shared constant would only prove the two agree about a string. The vectors prove they
   agree about MONEY, which is the only place a disagreement matters.

   ── WHAT THE CLIENT MAY SAY ─────────────────────────────────────────────────────────────
   A client may NAME an offer. It may never assert a discount, a subtotal or a total. Every
   figure below is computed here from the persisted document and a server-computed basket —
   the same rule createCheckoutSession already applies to promo codes, and for the same
   reason: checkout once subtracted a discount from the figure it DISPLAYED while charging
   the undiscounted one.
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const admin = require('firebase-admin');
const logger = require('firebase-functions/logger');
const { resolveShopAccess, capabilitiesForRole } = require('./shop-employees');

if (!admin.apps.length) admin.initializeApp();
const _db = () => admin.firestore();

const REGION = 'us-central1';
const COL = 'shopOffers';
const COL_REDEMPTIONS = 'shopOfferRedemptions';

/* ── THE ROLE POLICY, STATED RATHER THAN INFERRED ────────────────────────────────────────
   An offer IS a discount, so writing one requires the capability the platform already uses
   for discounting. owner / admin / manager hold it; cashier, inventory and support do not.

   Draft and publish share this gate DELIBERATELY. Gating only publish would be a locked
   door beside an open window: whoever may edit a live offer's price has already set the
   price, whatever the status field says at the moment they save. Widening draft authorship
   later is an owner decision, and would be a change to this one constant. */
const OFFER_WRITE_CAPABILITY = 'discount';

const TYPES = new Set(['percentage', 'fixed', 'bundle', 'buyXgetY',
                       'spendAndSave', 'freeDelivery', 'freeItem']);
const STATUSES = new Set(['draft', 'scheduled', 'live', 'archived']);
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

function _n(v, d) { const x = Number(v); return Number.isFinite(x) ? x : (d === undefined ? 0 : d); }
function _arr(v) { return Array.isArray(v) ? v : []; }
function _minutesOf(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || ''));
  return m ? (Number(m[1]) * 60 + Number(m[2])) : null;
}

/* ══ SCHEMA ══════════════════════════════════════════════════════════════════
   Authoritative normalisation. Absent stays ABSENT: minSpend 0 is a rule that always
   qualifies, an absent minSpend is no rule at all, and storing one as the other changes
   what customers are charged. */
function normaliseOffer(input, ownership) {
  const o = input || {};
  if (!TYPES.has(String(o.type))) {
    throw new HttpsError('invalid-argument', `Unknown offer type "${o.type}".`);
  }
  const rec = {
    /* OWNERSHIP IS SERVER-DERIVED. Whatever the payload said is discarded — this is the
       single most important line in the file. */
    shopId: String(ownership.shopId),
    sellerUid: String(ownership.shopOwnerId || ownership.shopId),
    type: String(o.type),
    status: STATUSES.has(String(o.status)) ? String(o.status) : 'draft',
    schemaVersion: 1,
  };
  if (o.name != null && String(o.name).trim()) rec.name = String(o.name).slice(0, 140);

  for (const k of ['percent', 'amount', 'bundlePrice', 'regularValue', 'buyQty', 'getQty',
                   'maxFreeItems', 'minSpend', 'maxDiscount', 'inventoryLimit',
                   'perCustomerLimit', 'totalRedemptionLimit', 'priority']) {
    if (o[k] === undefined || o[k] === null || o[k] === '') continue;
    const v = Number(o[k]);
    if (!Number.isFinite(v)) throw new HttpsError('invalid-argument', `${k} must be a number.`);
    if (v < 0) throw new HttpsError('invalid-argument', `${k} cannot be negative.`);
    rec[k] = v;
  }
  if (rec.type === 'percentage' && (rec.percent === undefined || rec.percent > 100)) {
    throw new HttpsError('invalid-argument', 'percent must be between 0 and 100.');
  }
  if (rec.type === 'bundle' && rec.bundlePrice === undefined) {
    throw new HttpsError('invalid-argument', 'A bundle needs a bundlePrice.');
  }
  if (rec.type === 'fixed' && rec.amount === undefined) {
    throw new HttpsError('invalid-argument', 'A fixed offer needs an amount.');
  }

  for (const k of ['freeItemId', 'stacking', 'fulfilment', 'startsAt', 'endsAt',
                   'template', 'summary']) {
    if (o[k] != null && String(o[k]).trim()) rec[k] = String(o[k]).slice(0, 300);
  }
  for (const k of ['qualifyingListingIds', 'locations', 'fulfilments']) {
    const a = _arr(o[k]).map(x => String(x).slice(0, 200)).filter(Boolean);
    if (a.length) rec[k] = a.slice(0, 200);
  }
  const items = _arr(o.items).map(it => {
    if (!it || typeof it !== 'object') return null;
    const row = {};
    if (it.listingId != null && String(it.listingId).trim()) row.listingId = String(it.listingId).slice(0, 200);
    if (it.name != null && String(it.name).trim()) row.name = String(it.name).slice(0, 140);
    if (it.qty !== undefined && it.qty !== null && it.qty !== '') row.qty = _n(it.qty, 1);
    if (it.price !== undefined && it.price !== null && it.price !== '') row.price = _n(it.price, 0);
    return Object.keys(row).length ? row : null;
  }).filter(Boolean);
  if (items.length) rec.items = items.slice(0, 100);

  /* A blank schedule and "no schedule" must not become two different things — the first
     would make isLive() evaluate an empty window. */
  const s = o.schedule;
  if (s && typeof s === 'object') {
    const sched = {};
    const days = _arr(s.days).map(d => String(d).slice(0, 3).toLowerCase())
                             .filter(d => DAYS.includes(d));
    if (days.length) sched.days = days;
    if (s.from != null && String(s.from).trim()) sched.from = String(s.from).slice(0, 5);
    if (s.to != null && String(s.to).trim()) sched.to = String(s.to).slice(0, 5);
    if (Object.keys(sched).length) rec.schedule = sched;
  }
  return rec;
}

/* ══ RESOLUTION ══════════════════════════════════════════════════════════════
   The client's mirror of this lives in sokoni-promotion-model.js. The two are held
   together by scripts/offer-resolution-vectors.json, replayed pairwise. */
function isLive(offer, at) {
  const o = offer || {};
  const now = at instanceof Date ? at : new Date();
  if (o.status && o.status !== 'live' && o.status !== 'active') return false;
  if (o.startsAt && now < new Date(o.startsAt)) return false;
  if (o.endsAt && now > new Date(o.endsAt)) return false;
  const s = o.schedule;
  if (!s) return true;
  const days = _arr(s.days).map(d => String(d).slice(0, 3).toLowerCase());
  if (days.length && !days.includes(DAYS[now.getDay()])) return false;
  if (s.from || s.to) {
    const f = _minutesOf(s.from), t = _minutesOf(s.to);
    /* FAIL CLOSED on a broken window rather than running for ever. */
    if (f === null || t === null) return false;
    const cur = now.getHours() * 60 + now.getMinutes();
    if (f <= t ? (cur < f || cur > t) : (cur < f && cur > t)) return false;
  }
  return true;
}

function withinLimits(offer, usage) {
  const o = offer || {}, u = usage || {};
  /* ABSENT IS UNMETERED, NEVER EXHAUSTED. */
  if (o.totalRedemptionLimit != null && _n(u.totalRedemptions) >= _n(o.totalRedemptionLimit)) return false;
  if (o.perCustomerLimit != null && _n(u.customerRedemptions) >= _n(o.perCustomerLimit)) return false;
  if (o.inventoryLimit != null && _n(u.inventorySold) >= _n(o.inventoryLimit)) return false;
  return true;
}

function qualifies(offer, basket) {
  const o = offer || {}, b = basket || {}, lines = _arr(b.lines);
  const subtotal = _n(b.subtotal, lines.reduce((s, l) => s + _n(l.price) * _n(l.qty, 1), 0));
  if (o.minSpend != null && subtotal < _n(o.minSpend)) return false;
  if (o.fulfilment && b.fulfilment && o.fulfilment !== b.fulfilment) return false;
  const ids = _arr(o.qualifyingListingIds);
  if (ids.length && !lines.some(l => ids.includes(l.listingId))) return false;
  if (o.type === 'buyXgetY') {
    const qty = lines.filter(l => !ids.length || ids.includes(l.listingId))
                     .reduce((s, l) => s + _n(l.qty, 1), 0);
    if (qty < _n(o.buyQty, 1)) return false;
  }
  if (o.type === 'bundle' && _arr(o.items).length) {
    const ok = _arr(o.items).every(it =>
      lines.some(l => l.listingId === it.listingId && _n(l.qty, 1) >= _n(it.qty, 1)));
    if (!ok) return false;
  }
  return true;
}

function discountOf(offer, basket, runningTotal) {
  const o = offer || {}, b = basket || {}, lines = _arr(b.lines);
  const base = _n(runningTotal, _n(b.subtotal));
  const ids = _arr(o.qualifyingListingIds);
  const scoped = ids.length
    ? lines.filter(l => ids.includes(l.listingId)).reduce((s, l) => s + _n(l.price) * _n(l.qty, 1), 0)
    : base;

  switch (o.type) {
    case 'percentage':   return Math.round(scoped * (_n(o.percent) / 100));
    case 'fixed':        return Math.min(_n(o.amount), base);
    case 'spendAndSave': return Math.min(_n(o.amount), base);
    case 'bundle': {
      const worth = _arr(o.items).reduce((s, it) => {
        const l = lines.filter(x => x.listingId === it.listingId)[0];
        return s + (l ? _n(l.price) * _n(it.qty, 1) : 0);
      }, 0);
      return Math.max(0, worth - _n(o.bundlePrice));
    }
    case 'buyXgetY': {
      const elig = lines.filter(l => !ids.length || ids.includes(l.listingId))
                        .slice().sort((a, c) => _n(a.price) - _n(c.price));
      const need = _n(o.buyQty, 1) + _n(o.getQty, 1);
      const unit = elig.length ? _n(elig[0].price) : 0;
      const total = elig.reduce((s, l) => s + _n(l.qty, 1), 0);
      let free = Math.floor(total / need) * _n(o.getQty, 1);
      if (o.maxFreeItems != null) free = Math.min(free, _n(o.maxFreeItems));
      return free * unit;
    }
    case 'freeDelivery': return _n(b.deliveryFee);
    case 'freeItem': {
      const fl = lines.filter(l => l.listingId === o.freeItemId)[0];
      return fl ? _n(fl.price) : 0;
    }
    default: return 0;
  }
}

/**
 * THE AUTHORITATIVE CALCULATION. Returns { subtotal, discount, deliveryFee, total,
 * applied[], rejected[] } from the PERSISTED offer and a SERVER-COMPUTED basket.
 */
function resolve(basket, offers, context) {
  const b = basket || {}, ctx = context || {};
  const at = ctx.at instanceof Date ? ctx.at : new Date();
  const lines = _arr(b.lines);
  const subtotal = _n(b.subtotal, lines.reduce((s, l) => s + _n(l.price) * _n(l.qty, 1), 0));
  let deliveryFee = _n(b.deliveryFee);
  const applied = [], rejected = [];

  let candidates = _arr(offers).filter(o => {
    if (!o || !TYPES.has(o.type)) { rejected.push({ offer: o && o.id, why: 'unknown offer type' }); return false; }
    if (!isLive(o, at)) { rejected.push({ offer: o.id, why: 'not live now' }); return false; }
    if (!withinLimits(o, (ctx.usage || {})[o.id])) { rejected.push({ offer: o.id, why: 'redemption limit reached' }); return false; }
    if (!qualifies(o, b)) { rejected.push({ offer: o.id, why: 'basket does not qualify' }); return false; }
    return true;
  });

  const exclusives = candidates.filter(o => o.stacking === 'exclusive');
  if (exclusives.length) {
    const best = exclusives.slice().sort((a, c) =>
      discountOf(c, b, subtotal) - discountOf(a, b, subtotal))[0];
    candidates.forEach(o => { if (o !== best) rejected.push({ offer: o.id, why: 'excluded by ' + best.id }); });
    candidates = [best];
  }

  candidates.sort((a, c) => _n(c.priority) - _n(a.priority));

  let running = subtotal, discount = 0;
  candidates.forEach(o => {
    if (o.type === 'freeDelivery') {
      if (deliveryFee > 0) {
        applied.push({ id: o.id, label: o.name || o.type, type: o.type, amount: deliveryFee, kind: 'delivery' });
        deliveryFee = 0;
      }
      return;
    }
    let d = discountOf(o, b, running);
    if (o.maxDiscount != null) d = Math.min(d, _n(o.maxDiscount));
    d = Math.max(0, Math.min(d, running));
    if (d <= 0) { rejected.push({ offer: o.id, why: 'no discount produced' }); return; }
    applied.push({ id: o.id, label: o.name || o.type, type: o.type, amount: d, kind: 'discount' });
    discount += d; running -= d;
  });

  return {
    subtotal, discount, deliveryFee,
    total: Math.max(0, subtotal - discount) + deliveryFee,
    applied, rejected,
  };
}

/* ══ IDEMPOTENCY ═════════════════════════════════════════════════════════════
   Derived from the shop and the merchant's own draft token — never from a clock, so a retry
   after a dropped response claims the SAME document instead of creating a second offer.
   Deliberately the same shape as the product writer's productDraftId. */
function offerDraftId(shopId, draftToken) {
  const basis = String(shopId) + '::' + String(draftToken);
  let h = 0;
  for (let i = 0; i < basis.length; i++) h = ((h << 5) - h + basis.charCodeAt(i)) | 0;
  return 'off_' + String(shopId).slice(0, 12) + '_' + Math.abs(h).toString(36);
}

/* ══ AUTHORISATION ═══════════════════════════════════════════════════════════ */
async function authoriseOfferWrite(uid, shopId) {
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in required.');
  if (!shopId) throw new HttpsError('invalid-argument', 'shopId is required.');
  /* The SHOP decides, never a claim in the payload. resolveShopAccess throws
     permission-denied for anyone who is not owner, a corroborated employee, or a platform
     admin — the explicit via:'admin' branch is preserved, not inferred. */
  const access = await resolveShopAccess(uid, shopId);
  const caps = capabilitiesForRole(access.role) || [];
  if (!caps.includes(OFFER_WRITE_CAPABILITY)) {
    throw new HttpsError('permission-denied',
      `A ${access.role} cannot create or change offers.`);
  }
  return access;
}

/* ══ WRITE ═══════════════════════════════════════════════════════════════════ */
async function upsertOffer(db, { uid, shopId, offer, draftToken, offerId }) {
  const access = await authoriseOfferWrite(uid, shopId);
  const rec = normaliseOffer(offer, { shopId, shopOwnerId: access.shopOwnerId });

  if (!offerId && !draftToken) {
    throw new HttpsError('invalid-argument',
      'draftToken is required (it makes the create idempotent).');
  }
  const id = offerId ? String(offerId) : offerDraftId(shopId, draftToken);
  const ref = db.collection(COL).doc(id);

  const outcome = await db.runTransaction(async (t) => {
    const snap = await t.get(ref);
    if (snap.exists) {
      const cur = snap.data() || {};
      /* CROSS-SHOP WRITE IS REFUSED AGAINST THE STORED DOCUMENT, not the payload. */
      if (String(cur.shopId || '') !== String(shopId)) {
        throw new HttpsError('permission-denied', 'That offer belongs to another shop.');
      }
      /* shopId and sellerUid are never patchable — an offer cannot change hands. */
      const patch = Object.assign({}, rec);
      delete patch.shopId; delete patch.sellerUid;
      t.set(ref, Object.assign({}, patch, {
        updatedBy: uid, updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }), { merge: true });
      return { id, created: false, replayed: !offerId };
    }
    t.set(ref, Object.assign({}, rec, {
      id,
      createdBy: uid,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }));
    return { id, created: true, replayed: false };
  });

  logger.info('[shop-offers] upsert', { id, shopId, via: access.via, created: outcome.created });
  return Object.assign({ ok: true, role: access.role }, outcome);
}

async function listShopOffers(db, { uid, shopId }) {
  /* Reading is gated by shop ACCESS, not by the write capability — a cashier may see what
     is running without being able to change it. Cross-shop reads are impossible because the
     query is pinned to the shop the caller was authorised against. */
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in required.');
  await resolveShopAccess(uid, shopId);
  const snap = await db.collection(COL).where('shopId', '==', String(shopId)).limit(300).get();
  return { ok: true, offers: snap.docs.map(d => Object.assign({ id: d.id }, d.data())) };
}

/* ══ REDEMPTION — ITS OWN LEDGER ═════════════════════════════════════════════
   NOT promotionUsage. That ledger records who FUNDED a platform discount
   (fundedBy / platformFundingPct / sellerFundingPct); a merchant offer is merchant-funded
   by definition, and filing it there would attribute merchant money to a platform split. */
async function recordOfferRedemption(db, { offerId, shopId, buyerUid, orderId, discount }) {
  const offerRef = db.collection(COL).doc(String(offerId));
  const useRef = db.collection(COL_REDEMPTIONS).doc();
  await db.runTransaction(async (t) => {
    const snap = await t.get(offerRef);
    if (!snap.exists) throw new HttpsError('not-found', 'Offer not found.');
    t.set(useRef, {
      offerId: String(offerId), shopId: String(shopId),
      buyerUid: buyerUid || null, orderId: orderId || null,
      discount: _n(discount), redeemedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    t.update(offerRef, { redemptionCount: admin.firestore.FieldValue.increment(1) });
  });
  return { ok: true, offerId: String(offerId) };
}

async function usageFor(db, { offerId, buyerUid }) {
  const total = await db.collection(COL_REDEMPTIONS).where('offerId', '==', String(offerId)).get();
  let customer = 0;
  if (buyerUid) {
    total.forEach(d => { if ((d.data() || {}).buyerUid === buyerUid) customer++; });
  }
  return { totalRedemptions: total.size, customerRedemptions: customer, inventorySold: total.size };
}

/**
 * CHARGE TIME. The client names an offer; this resolves the PERSISTED document against a
 * SERVER-COMPUTED basket and returns the amount. Nothing the client sent about money is
 * read. An offer that is missing, another shop's, not live, malformed or exhausted simply
 * produces no discount — never an error that could block a real purchase.
 */
async function resolveOfferForCharge(db, { shopId, offerIds, basket, buyerUid, at }) {
  const ids = _arr(offerIds).map(String).filter(Boolean).slice(0, 10);
  if (!ids.length) return { discount: 0, deliveryFee: _n(basket && basket.deliveryFee), applied: [], rejected: [] };

  const docs = await Promise.all(ids.map(id => db.collection(COL).doc(id).get()));
  const usage = {};
  const offers = [];
  for (const snap of docs) {
    if (!snap.exists) { continue; }
    const o = Object.assign({ id: snap.id }, snap.data());
    /* CROSS-SHOP: an offer belonging to another shop is not merely refused, it is not
       considered at all. */
    if (String(o.shopId || '') !== String(shopId)) continue;
    usage[o.id] = await usageFor(db, { offerId: o.id, buyerUid });
    offers.push(o);
  }
  const r = resolve(basket, offers, { at, usage });
  return { discount: r.discount, deliveryFee: r.deliveryFee, total: r.total,
           applied: r.applied, rejected: r.rejected };
}

/* ══ CALLABLES ═══════════════════════════════════════════════════════════════ */
exports.shopOfferUpsert = onCall(
  { region: REGION, maxInstances: 20, memory: '256MiB', timeoutSeconds: 30, enforceAppCheck: true },
  async (req) => {
    const uid = req.auth && req.auth.uid;
    const d = req.data || {};
    return upsertOffer(_db(), {
      uid, shopId: d.shopId, offer: d.offer, draftToken: d.draftToken, offerId: d.offerId,
    });
  },
);

exports.shopOfferList = onCall(
  { region: REGION, maxInstances: 20, memory: '256MiB', timeoutSeconds: 30, enforceAppCheck: true },
  async (req) => listShopOffers(_db(), { uid: req.auth && req.auth.uid, shopId: (req.data || {}).shopId }),
);

/* Internals, exported for certification and for the charge path. */
module.exports.COL = COL;
module.exports.COL_REDEMPTIONS = COL_REDEMPTIONS;
module.exports.OFFER_WRITE_CAPABILITY = OFFER_WRITE_CAPABILITY;
module.exports.normaliseOffer = normaliseOffer;
module.exports.isLive = isLive;
module.exports.withinLimits = withinLimits;
module.exports.qualifies = qualifies;
module.exports.discountOf = discountOf;
module.exports.resolve = resolve;
module.exports.offerDraftId = offerDraftId;
module.exports.authoriseOfferWrite = authoriseOfferWrite;
module.exports.upsertOffer = upsertOffer;
module.exports.listShopOffers = listShopOffers;
module.exports.recordOfferRedemption = recordOfferRedemption;
module.exports.usageFor = usageFor;
module.exports.resolveOfferForCharge = resolveOfferForCharge;
