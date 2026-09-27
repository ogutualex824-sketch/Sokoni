/* SOKONI — Entertainment Rate Cards, Quotes and Booking Discounts  functions/ent-rate-cards.js
 * ============================================================================================
 * Rate cards are VERSIONED prices that feed the canonical booking pricing — they are not a second
 * price list. A booking made on a rate card stores { rateCardId, rateCardVersion, price, currency,
 * pricingAuthority } and is NEVER re-priced: a new version applies to new bookings only.
 *
 *   entRateCards/{cardId}                         the card (owner, service, segment, visibility)
 *   entRateCards/{cardId}/versions/{n}            IMMUTABLE price versions
 *   entRateCardEligibility/{cardId}_{uid}         who may book a non-public segment (owner-granted)
 *   entQuotes/{quoteId}                           a provider's custom quote for one buyer
 *   mktCouponCodes/{id}  (Marketing authority)    booking discounts — scope 'ent_booking'
 *   mktCouponRedemptions/{couponId}_{bookingRef}  one redemption per booking (create-once)
 *
 * VISIBILITY (what the public API may say):
 *   PUBLIC        price shown                    ENQUIRY_ONLY  "Request a quote" — no price
 *   BOOKING_ONLY  price shown only at checkout   PRIVATE       only to eligible buyers / owner / admin
 * SEGMENTS other than PUBLIC (MEMBER, CORPORATE, EVENT, PACKAGE, SEASONAL, PROMOTIONAL) are
 * bookable only by a buyer the SERVER finds eligible — the buyer never chooses a price.
 *
 * Every final amount is computed here. The browser sends ids and a coupon CODE; never an amount or
 * a discount. Accepting a quote is not a payment — it only lets the buyer reserve and pay.
 */
'use strict';
const admin = require('firebase-admin');
const { HttpsError } = require('firebase-functions/v2/https');

const COL = Object.freeze({ CARDS: 'entRateCards', VERSIONS: 'versions', ELIG: 'entRateCardEligibility', QUOTES: 'entQuotes',
  COUPONS: 'mktCouponCodes', REDEEM: 'mktCouponRedemptions', AUDIT: 'entRateCardAudit' });
const VISIBILITY = Object.freeze(['PUBLIC', 'ENQUIRY_ONLY', 'BOOKING_ONLY', 'PRIVATE']);
const SEGMENTS = Object.freeze(['PUBLIC', 'MEMBER', 'CORPORATE', 'EVENT', 'PACKAGE', 'SEASONAL', 'PROMOTIONAL']);
const UNITS = Object.freeze(['booking', 'hour', 'day']);
const QUOTE = Object.freeze({ SENT: 'SENT', ACCEPTED: 'ACCEPTED', DECLINED: 'DECLINED', EXPIRED: 'EXPIRED', WITHDRAWN: 'WITHDRAWN', CONVERTED: 'CONVERTED' });
const PRICING_AUTHORITY = 'ent-rate-cards@1';
const MAX_PRICE_CENTS = 100000000;        /* KES 1,000,000 per booking */

const _db = () => admin.firestore();
const _FV = () => admin.firestore.FieldValue;
let _now = () => Date.now();
const fail = (code, msg, details) => { throw new HttpsError(code, msg, details); };
const _san = (s, n) => String(s == null ? '' : s).replace(/[<>]/g, '').trim().slice(0, n || 200);
const _need = (req) => { const u = req && req.auth && req.auth.uid; if (!u) fail('unauthenticated', 'Sign in required.'); return u; };
const _tok = (req) => (req && req.auth && req.auth.token) || {};
const _isAdmin = (req) => { const t = _tok(req); return t.admin === true || t.superAdmin === true || t.role === 'admin' || t.role === 'superAdmin'; };
const _isSuper = (req) => { const t = _tok(req); return t.superAdmin === true || t.role === 'superAdmin'; };
const _cents = (v) => { const n = Math.round(Number(v)); if (!Number.isFinite(n) || n < 0 || n > MAX_PRICE_CENTS) fail('invalid-argument', 'Enter a valid price.'); return n; };
const _ms = (v) => (v == null ? null : typeof v === 'number' ? v : v.toMillis ? v.toMillis() : Date.parse(v));

async function _audit(entry) {
  try { await _db().collection(COL.AUDIT).add(Object.assign({ at: _now(), createdAt: _FV().serverTimestamp() }, entry)); }
  catch (e) { console.error('[ent-rate-cards] audit failed', e.message); }
}

/* The calendar (and so the owner) a card belongs to — the availability authority resolves it. */
async function _ownerCal(req, d) {
  const uid = _need(req);
  const AV = require('./ent-availability');
  const key = AV.calKeyFor(d) || ('svc_' + uid);
  const cal = await AV.loadCalendar(key);
  if (cal.ownerUid !== uid) fail('permission-denied', 'This business is not yours.');
  return { uid, cal };
}

/* The version in force at a moment: the highest version whose window contains it. */
async function currentVersion(cardId, card, atMs) {
  const at = atMs == null ? _now() : atMs;
  const n = Number(card.currentVersion) || 0;
  for (let v = n; v >= 1 && v > n - 10; v--) {
    const s = await _db().collection(COL.CARDS).doc(cardId).collection(COL.VERSIONS).doc(String(v)).get();
    if (!s.exists) continue;
    const x = s.data();
    if ((x.effectiveFrom == null || x.effectiveFrom <= at) && (x.effectiveTo == null || at < x.effectiveTo)) return x;
  }
  return null;
}
async function isEligible(cardId, card, uid) {
  if (!uid) return false;
  if (uid === card.ownerUid) return true;
  if (card.segment === 'PUBLIC' && card.visibility !== 'PRIVATE') return true;
  const e = await _db().collection(COL.ELIG).doc(`${cardId}_${uid}`).get();
  if (!e.exists) return false;
  const exp = _ms(e.data().expiresAt);
  return !(exp && exp <= _now());
}
function priceFor(version, durationMins) {
  const unit = version.unit || 'booking';
  const dur = Math.max(1, Number(durationMins) || Number(version.durationMins) || 60);
  const per = Number(version.priceCents) || 0;
  if (unit === 'hour') return per * Math.ceil(dur / 60);
  if (unit === 'day') return per * Math.ceil(dur / 1440);
  return per;
}

/**
 * Resolve the commercial terms of a booking (outside the transaction). Returns
 *   { priceCents, depositCents|null, durationMins|null, availability (rate-card buffers) | null,
 *     rateCard: { id, version } | null, quote: { id } | null, pricingAuthority }
 * `base` is the price the service's own pricing engine computed (used when no card / quote).
 * Throws permission / precondition errors in buyer-safe words.
 */
async function resolveTerms({ calKey, ownerUid, serviceId, buyerUid, rateCardId, quoteId, base }) {
  if (quoteId) {
    const qs = await _db().collection(COL.QUOTES).doc(String(quoteId)).get();
    if (!qs.exists) fail('not-found', 'Quote not found.');
    const q = qs.data();
    if (q.buyerUid !== buyerUid) fail('permission-denied', 'This quote is not yours.');
    if (q.calKey !== calKey) fail('failed-precondition', 'This quote is for another provider.');
    if (q.serviceId && serviceId && q.serviceId !== serviceId) fail('failed-precondition', 'This quote is for another service.');
    if (q.status !== QUOTE.ACCEPTED) fail('failed-precondition', q.status === QUOTE.SENT ? 'Accept the quote before booking.' : 'This quote can no longer be booked.');
    if (_ms(q.expiresAt) && _ms(q.expiresAt) <= _now()) fail('failed-precondition', 'This quote has expired.');
    return { priceCents: q.finalCents, depositCents: null, durationMins: q.durationMins || null, availability: null,
      rateCard: q.rateCardId ? { id: q.rateCardId, version: q.rateCardVersion || null } : null, quote: { id: qs.id, date: q.date || null, startTime: q.startTime || null },
      pricingAuthority: PRICING_AUTHORITY + ':quote' };
  }
  if (rateCardId) {
    const cs = await _db().collection(COL.CARDS).doc(String(rateCardId)).get();
    if (!cs.exists) fail('not-found', 'Rate card not found.');
    const c = cs.data();
    if (c.calKey !== calKey || c.ownerUid !== ownerUid) fail('failed-precondition', 'This rate card belongs to another provider.');
    if (c.status !== 'ACTIVE') fail('failed-precondition', 'This rate card is no longer offered.');
    if (c.serviceId && serviceId && c.serviceId !== serviceId) fail('failed-precondition', 'This rate card is for another service.');
    if (c.visibility === 'ENQUIRY_ONLY') fail('failed-precondition', 'This service is priced by quote. Send an enquiry to request one.');
    if (!(await isEligible(cs.id, c, buyerUid))) fail('permission-denied', 'This rate is not available to your account.');
    const v = await currentVersion(cs.id, c);
    if (!v) fail('failed-precondition', 'This rate card has no price in force.');
    const dur = v.durationMins || null;
    const avail = {};
    ['bufferBeforeMins', 'bufferAfterMins', 'minNoticeMins', 'horizonDays'].forEach((k) => { if (v[k] != null) avail[k] = v[k]; });
    if (Array.isArray(v.bookableDays) && v.bookableDays.length) avail.days = v.bookableDays;
    if (dur) avail.durationMins = dur;
    return { priceCents: priceFor(v, dur || (base && base.durationMins)), depositCents: v.depositCents != null ? v.depositCents : null, durationMins: dur,
      availability: Object.keys(avail).length ? avail : null, rateCard: { id: cs.id, version: v.version }, quote: null, pricingAuthority: PRICING_AUTHORITY };
  }
  return { priceCents: base ? base.priceCents : 0, depositCents: null, durationMins: null, availability: null, rateCard: null, quote: null,
    pricingAuthority: base && base.authority ? base.authority : 'service-pricing' };
}

/* ── Discounts (Marketing authority: mktCouponCodes, scope 'ent_booking') ────────────────── */
async function findCoupon(ownerUid, code) {
  const c = String(code || '').toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 32);
  if (!c) return null;
  const s = await _db().collection(COL.COUPONS).where('merchantId', '==', ownerUid).where('code', '==', c).limit(1).get();
  return s.empty ? null : { ref: s.docs[0].ref, id: s.docs[0].id };
}
/** Decide a coupon against a price. Pure over the coupon doc; returns discount cents or a refusal. */
function couponDiscount(cp, { priceCents, serviceId, nowMs }) {
  if (!cp || cp.status !== 'active') return { ok: false, reason: 'This code is not active.' };
  if (cp.scope !== 'ent_booking') return { ok: false, reason: 'This code is not valid for bookings.' };
  const from = _ms(cp.validFrom); const to = _ms(cp.validTo);
  if (from && from > nowMs) return { ok: false, reason: 'This code is not valid yet.' };
  if (to && to <= nowMs) return { ok: false, reason: 'This code has expired.' };
  if (cp.usageLimit != null && Number(cp.usedCount || 0) >= Number(cp.usageLimit)) return { ok: false, reason: 'This code has been used up.' };
  if (Array.isArray(cp.allowedServices) && cp.allowedServices.length && !cp.allowedServices.includes(serviceId)) return { ok: false, reason: 'This code is not valid for this service.' };
  let d = 0;
  if (cp.type === 'percent') d = Math.floor(priceCents * Math.min(100, Math.max(0, Number(cp.value) || 0)) / 100);
  else if (cp.type === 'flat') d = Math.round((Number(cp.value) || 0) * 100);
  if (cp.maxDiscount != null) d = Math.min(d, Math.round(Number(cp.maxDiscount) * 100));
  d = Math.max(0, Math.min(d, priceCents));
  return { ok: true, discountCents: d };
}

/* ── owner ops ─────────────────────────────────────────────────────────────────────────── */
const _h = {};
function _versionInput(v) {
  const x = v || {};
  const unit = UNITS.includes(x.unit) ? x.unit : 'booking';
  const out = { priceCents: _cents(x.priceCents), currency: 'KES', unit,
    durationMins: x.durationMins != null ? Math.min(1440 * 7, Math.max(15, Math.round(Number(x.durationMins) || 0))) : null,
    depositCents: x.depositCents != null ? _cents(x.depositCents) : null,
    bufferBeforeMins: x.bufferBeforeMins != null ? Math.min(720, Math.max(0, Math.round(Number(x.bufferBeforeMins) || 0))) : null,
    bufferAfterMins: x.bufferAfterMins != null ? Math.min(720, Math.max(0, Math.round(Number(x.bufferAfterMins) || 0))) : null,
    minNoticeMins: x.minNoticeMins != null ? Math.min(86400, Math.max(0, Math.round(Number(x.minNoticeMins) || 0))) : null,
    horizonDays: x.horizonDays != null ? Math.min(730, Math.max(1, Math.round(Number(x.horizonDays) || 0))) : null,
    bookableDays: Array.isArray(x.bookableDays) ? x.bookableDays.map(Number).filter((d) => d >= 0 && d <= 6).slice(0, 7) : null,
    terms: _san(x.terms, 1000) || null };
  if (out.depositCents != null && out.depositCents > out.priceCents) fail('invalid-argument', 'The deposit cannot exceed the price.');
  return out;
}
_h.entRateCardCreate = async (req) => {
  const d = req.data || {};
  const { uid, cal } = await _ownerCal(req, d);
  const name = _san(d.name, 120);
  if (name.length < 2) fail('invalid-argument', 'Name the rate card.');
  const visibility = VISIBILITY.includes(d.visibility) ? d.visibility : 'PUBLIC';
  const segment = SEGMENTS.includes(d.segment) ? d.segment : 'PUBLIC';
  let serviceId = null;
  if (d.serviceId) { const AV = require('./ent-availability'); const svc = await AV.loadService(cal, d.serviceId); serviceId = svc ? svc.id : null; }
  const v = _versionInput(d.version);
  const ref = _db().collection(COL.CARDS).doc();
  const batch = _db().batch();
  batch.set(ref, { cardId: ref.id, ownerUid: uid, calKey: cal.calKey, serviceId, name, description: _san(d.description, 500) || null,
    visibility, segment, status: 'ACTIVE', currentVersion: 1, createdAt: _FV().serverTimestamp(), updatedAt: _FV().serverTimestamp() });
  batch.set(ref.collection(COL.VERSIONS).doc('1'), Object.assign({ version: 1, cardId: ref.id, effectiveFrom: _now(), effectiveTo: null, createdBy: uid, createdAt: _FV().serverTimestamp() }, v));
  await batch.commit();
  await _audit({ cardId: ref.id, actor: uid, action: 'create', visibility, segment, priceCents: v.priceCents });
  return { ok: true, cardId: ref.id, version: 1 };
};
/** A price change is a NEW version. Earlier versions are never edited — confirmed bookings keep theirs. */
_h.entRateCardNewVersion = async (req) => {
  const d = req.data || {};
  const uid = _need(req);
  const cardId = _san(d.cardId, 128);
  const v = _versionInput(d.version);
  const ref = _db().collection(COL.CARDS).doc(cardId);
  let next = 0;
  await _db().runTransaction(async (txn) => {
    const s = await txn.get(ref);
    if (!s.exists) fail('not-found', 'Rate card not found.');
    const c = s.data();
    if (c.ownerUid !== uid) fail('permission-denied', 'This rate card is not yours.');
    if (c.status !== 'ACTIVE') fail('failed-precondition', 'Archived rate cards cannot change.');
    const cur = Number(c.currentVersion) || 0;
    const prevRef = ref.collection(COL.VERSIONS).doc(String(cur));
    const prev = await txn.get(prevRef);
    next = cur + 1;
    const at = _now();
    if (prev.exists && (prev.data().effectiveTo == null || prev.data().effectiveTo > at)) txn.update(prevRef, { effectiveTo: at });
    txn.create(ref.collection(COL.VERSIONS).doc(String(next)), Object.assign({ version: next, cardId, effectiveFrom: at, effectiveTo: null, createdBy: uid, createdAt: _FV().serverTimestamp() }, v));
    txn.update(ref, { currentVersion: next, updatedAt: _FV().serverTimestamp() });
  });
  await _audit({ cardId, actor: uid, action: 'new_version', version: next, priceCents: v.priceCents });
  return { ok: true, cardId, version: next };
};
_h.entRateCardUpdate = async (req) => {
  const d = req.data || {};
  const uid = _need(req);
  const ref = _db().collection(COL.CARDS).doc(_san(d.cardId, 128));
  const s = await ref.get();
  if (!s.exists) fail('not-found', 'Rate card not found.');
  if (s.data().ownerUid !== uid) fail('permission-denied', 'This rate card is not yours.');
  const patch = { updatedAt: _FV().serverTimestamp() };
  if (d.name != null) patch.name = _san(d.name, 120);
  if (d.description != null) patch.description = _san(d.description, 500) || null;
  if (d.visibility != null) { if (!VISIBILITY.includes(d.visibility)) fail('invalid-argument', 'Unknown visibility.'); patch.visibility = d.visibility; }
  if (d.segment != null) { if (!SEGMENTS.includes(d.segment)) fail('invalid-argument', 'Unknown segment.'); patch.segment = d.segment; }
  if (d.status != null) { if (!['ACTIVE', 'ARCHIVED'].includes(d.status)) fail('invalid-argument', 'Unknown status.'); patch.status = d.status; }
  await ref.update(patch);
  await _audit({ cardId: ref.id, actor: uid, action: 'update', fields: Object.keys(patch) });
  return { ok: true };
};
_h.entRateCardList = async (req) => {
  const d = req.data || {};
  const { cal } = await _ownerCal(req, d);
  const s = await _db().collection(COL.CARDS).where('calKey', '==', cal.calKey).limit(100).get();
  const cards = [];
  for (const doc of s.docs) {
    const c = doc.data();
    const vs = await doc.ref.collection(COL.VERSIONS).limit(50).get();
    cards.push(Object.assign({ id: doc.id }, c, { versions: vs.docs.map((x) => x.data()).sort((a, b) => b.version - a.version) }));
  }
  return { cards };
};
_h.entRateCardGrant = async (req) => {
  const d = req.data || {};
  const uid = _need(req);
  const cardId = _san(d.cardId, 128); const buyer = _san(d.uid, 128);
  const s = await _db().collection(COL.CARDS).doc(cardId).get();
  if (!s.exists || s.data().ownerUid !== uid) fail('permission-denied', 'This rate card is not yours.');
  if (!buyer || buyer === uid) fail('invalid-argument', 'Choose a customer.');
  if (d.revoke) await _db().collection(COL.ELIG).doc(`${cardId}_${buyer}`).delete();
  else await _db().collection(COL.ELIG).doc(`${cardId}_${buyer}`).set({ cardId, uid: buyer, grantedBy: uid, expiresAt: d.expiresAt ? Number(d.expiresAt) : null, createdAt: _FV().serverTimestamp() });
  await _audit({ cardId, actor: uid, action: d.revoke ? 'revoke' : 'grant', buyer });
  return { ok: true };
};

/* ── public ────────────────────────────────────────────────────────────────────────────── */
/**
 * What a storefront may show. PUBLIC → price; ENQUIRY_ONLY → quote only; BOOKING_ONLY → no price
 * (it appears at checkout); PRIVATE and non-public segments → only to an eligible signed-in buyer.
 * Never returns versions, owner ids, eligibility or audit.
 */
_h.entRateCardsPublic = async (req) => {
  const d = req.data || {};
  const AV = require('./ent-availability');
  const key = AV.calKeyFor(d);
  if (!key) fail('invalid-argument', 'Choose a provider.');
  const viewer = req.auth && req.auth.uid;
  const s = await _db().collection(COL.CARDS).where('calKey', '==', key).limit(100).get();
  const out = [];
  for (const doc of s.docs) {
    const c = doc.data();
    if (c.status !== 'ACTIVE') continue;
    if (d.serviceId && c.serviceId && c.serviceId !== d.serviceId) continue;
    const restricted = c.visibility === 'PRIVATE' || c.segment !== 'PUBLIC';
    if (restricted && !(await isEligible(doc.id, c, viewer))) continue;
    const row = { id: doc.id, name: c.name, description: c.description || null, serviceId: c.serviceId || null, segment: c.segment, visibility: c.visibility };
    if (c.visibility === 'ENQUIRY_ONLY') { row.quote = true; out.push(row); continue; }
    const v = await currentVersion(doc.id, c);
    if (!v) continue;
    row.unit = v.unit; row.durationMins = v.durationMins || null; row.currency = v.currency;
    if (c.visibility === 'BOOKING_ONLY') row.priceAtCheckout = true;
    else row.priceCents = v.priceCents;
    out.push(row);
  }
  return { calKey: key, cards: out };
};

/* ── quotes ────────────────────────────────────────────────────────────────────────────── */
_h.entQuoteCreate = async (req) => {
  const d = req.data || {};
  const { uid, cal } = await _ownerCal(req, d);
  const buyerUid = _san(d.buyerUid, 128);
  const enquiryId = d.enquiryId ? _san(d.enquiryId, 128) : null;
  if (enquiryId) {
    const e = await _db().collection('entEnquiries').doc(enquiryId).get();
    if (!e.exists || e.data().providerUid !== uid || e.data().buyerUid !== buyerUid) fail('permission-denied', 'That enquiry is not yours.');
    if (['CLOSED', 'EXPIRED', 'BLOCKED', 'CONVERTED'].includes(e.data().status)) fail('failed-precondition', 'That enquiry is closed.');
  } else if (!buyerUid) fail('invalid-argument', 'Choose the customer.');
  let serviceId = null;
  if (d.serviceId) { const AV = require('./ent-availability'); const svc = await AV.loadService(cal, d.serviceId); serviceId = svc ? svc.id : null; }
  const priceCents = _cents(d.priceCents);
  let discountCents = d.discountCents != null ? _cents(d.discountCents) : 0;
  if (discountCents > priceCents) fail('invalid-argument', 'The discount cannot exceed the price.');
  const days = Math.min(30, Math.max(1, Math.round(Number(d.validDays) || 7)));
  const date = d.date && require('./shared/ent-availability-core').isDate(d.date) ? d.date : null;
  const ref = _db().collection(COL.QUOTES).doc();
  const q = { quoteId: ref.id, ownerUid: uid, buyerUid, enquiryId, calKey: cal.calKey, serviceId,
    rateCardId: d.rateCardId ? _san(d.rateCardId, 128) : null, rateCardVersion: d.rateCardVersion != null ? Number(d.rateCardVersion) : null,
    description: _san(d.description, 1000), date, startTime: date && /^\d{2}:\d{2}$/.test(String(d.startTime || '')) ? d.startTime : null,
    durationMins: d.durationMins != null ? Math.min(1440 * 7, Math.max(15, Math.round(Number(d.durationMins) || 0))) : null,
    priceCents, discountCents, finalCents: priceCents - discountCents, currency: 'KES',
    terms: _san(d.terms, 1000) || null, status: QUOTE.SENT, expiresAt: _now() + days * 86400000,
    createdAt: _FV().serverTimestamp(), updatedAt: _FV().serverTimestamp() };
  if (q.rateCardId) {
    const cs = await _db().collection(COL.CARDS).doc(q.rateCardId).get();
    if (!cs.exists || cs.data().ownerUid !== uid) fail('permission-denied', 'That rate card is not yours.');
    q.rateCardVersion = q.rateCardVersion || cs.data().currentVersion;
  }
  await ref.set(q);
  if (enquiryId) await require('./ent-enquiries').transition(enquiryId, 'PROPOSAL_SENT', { quoteId: ref.id, by: uid, note: 'A quote was sent.' });
  await _audit({ quoteId: ref.id, actor: uid, action: 'quote_create', finalCents: q.finalCents });
  return { ok: true, quoteId: ref.id, finalCents: q.finalCents };
};
/** The buyer accepts or declines. Accepting is NOT a payment — it unlocks reserve-and-pay. */
_h.entQuoteRespond = async (req) => {
  const d = req.data || {};
  const uid = _need(req);
  const ref = _db().collection(COL.QUOTES).doc(_san(d.quoteId, 128));
  const accept = d.accept === true;
  let enquiryId = null;
  await _db().runTransaction(async (txn) => {
    const s = await txn.get(ref);
    if (!s.exists) fail('not-found', 'Quote not found.');
    const q = s.data();
    if (q.buyerUid !== uid) fail('permission-denied', 'This quote is not yours.');
    if (q.status !== QUOTE.SENT) fail('failed-precondition', 'This quote has already been answered.');
    if (_ms(q.expiresAt) <= _now()) { txn.update(ref, { status: QUOTE.EXPIRED, updatedAt: _FV().serverTimestamp() }); return; }
    enquiryId = q.enquiryId || null;
    txn.update(ref, { status: accept ? QUOTE.ACCEPTED : QUOTE.DECLINED, respondedAt: _now(), updatedAt: _FV().serverTimestamp() });
  });
  const after = (await ref.get()).data();
  if (after.status === QUOTE.EXPIRED) fail('failed-precondition', 'This quote has expired.');
  if (enquiryId && accept) await require('./ent-enquiries').transition(enquiryId, 'BOOKING_PENDING', { by: uid, note: 'The quote was accepted.' }).catch(() => {});
  return { ok: true, status: after.status };
};
_h.entQuoteWithdraw = async (req) => {
  const uid = _need(req);
  const ref = _db().collection(COL.QUOTES).doc(_san((req.data || {}).quoteId, 128));
  await _db().runTransaction(async (txn) => {
    const s = await txn.get(ref);
    if (!s.exists || s.data().ownerUid !== uid) fail('permission-denied', 'This quote is not yours.');
    if (![QUOTE.SENT, QUOTE.ACCEPTED].includes(s.data().status)) fail('failed-precondition', 'This quote can no longer be withdrawn.');
    txn.update(ref, { status: QUOTE.WITHDRAWN, updatedAt: _FV().serverTimestamp() });
  });
  return { ok: true };
};
_h.entQuoteList = async (req) => {
  const uid = _need(req);
  const asOwner = (req.data || {}).as === 'provider';
  const s = await _db().collection(COL.QUOTES).where(asOwner ? 'ownerUid' : 'buyerUid', '==', uid).limit(100).get();
  const now = _now();
  return { quotes: s.docs.map((x) => { const q = x.data(); const st = q.status === QUOTE.SENT && _ms(q.expiresAt) <= now ? QUOTE.EXPIRED : q.status;
    return { id: x.id, status: st, calKey: q.calKey, serviceId: q.serviceId, description: q.description, date: q.date, startTime: q.startTime, durationMins: q.durationMins,
      priceCents: q.priceCents, discountCents: q.discountCents, finalCents: q.finalCents, currency: q.currency, expiresAt: q.expiresAt, terms: q.terms, enquiryId: q.enquiryId,
      counterparty: asOwner ? q.buyerUid : null, bookingId: q.bookingId || null }; }) };
};

/* Booking discounts, created through the Marketing store. */
_h.entDiscountCreate = async (req) => {
  const d = req.data || {};
  const { uid, cal } = await _ownerCal(req, d);
  const code = String(d.code || '').toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 32);
  if (code.length < 4) fail('invalid-argument', 'Use a code of at least 4 letters or numbers.');
  const type = d.type === 'flat' ? 'flat' : 'percent';
  const value = Number(d.value);
  if (!(value > 0) || (type === 'percent' && value > 90)) fail('invalid-argument', type === 'percent' ? 'A percentage between 1 and 90.' : 'Enter the amount off.');
  const campaign = _san(d.campaign, 80);
  if (campaign.length < 2) fail('invalid-argument', 'Name the campaign.');
  const validFrom = Number(d.validFrom) || _now(); const validTo = Number(d.validTo);
  if (!(validTo > validFrom)) fail('invalid-argument', 'Set an expiry after the start.');
  const usageLimit = Math.max(1, Math.min(100000, Math.round(Number(d.usageLimit) || 0)));
  if (!Number(d.usageLimit)) fail('invalid-argument', 'Set a usage limit.');
  const existing = await findCoupon(uid, code);
  if (existing) fail('already-exists', 'You already have that code.');
  const svcIds = Array.isArray(d.allowedServices) ? d.allowedServices.map((x) => _san(x, 128)).filter(Boolean).slice(0, 50) : [];
  const ref = _db().collection(COL.COUPONS).doc();
  await ref.set({ merchantId: uid, code, scope: 'ent_booking', calKey: cal.calKey, campaign, type, value,
    maxDiscount: d.maxDiscount != null ? Math.max(0, Number(d.maxDiscount) || 0) : null, usageLimit, usedCount: 0,
    allowedServices: svcIds, validFrom: admin.firestore.Timestamp.fromMillis(validFrom), validTo: admin.firestore.Timestamp.fromMillis(validTo),
    status: 'active', createdBy: uid, createdAt: _FV().serverTimestamp() });
  await _audit({ couponId: ref.id, actor: uid, action: 'discount_create', campaign, type, value, usageLimit });
  return { ok: true, couponId: ref.id };
};
_h.entDiscountList = async (req) => {
  const uid = _need(req);
  const s = await _db().collection(COL.COUPONS).where('merchantId', '==', uid).limit(100).get();
  return { discounts: s.docs.map((x) => { const c = x.data(); if (c.scope !== 'ent_booking') return null;
    return { id: x.id, code: c.code, campaign: c.campaign, type: c.type, value: c.value, maxDiscount: c.maxDiscount, usageLimit: c.usageLimit, usedCount: c.usedCount || 0,
      validFrom: _ms(c.validFrom), validTo: _ms(c.validTo), status: c.status, allowedServices: c.allowedServices || [] }; }).filter(Boolean) };
};
_h.entDiscountDisable = async (req) => {
  const uid = _need(req);
  const ref = _db().collection(COL.COUPONS).doc(_san((req.data || {}).couponId, 128));
  const s = await ref.get();
  if (!s.exists || s.data().merchantId !== uid || s.data().scope !== 'ent_booking') fail('permission-denied', 'That code is not yours.');
  await ref.update({ status: 'disabled', updatedAt: _FV().serverTimestamp() });
  await _audit({ couponId: ref.id, actor: uid, action: 'discount_disable' });
  return { ok: true };
};

/**
 * CHECKOUT SUMMARY — what the buyer confirms before CONFIRM & PAY, computed by the SAME functions
 * the booking create uses (service pricing / venue pricing → rate card or quote → discount). The
 * returned totalCents is what the buyer sends back as expectedTotalCents: if the authority's total
 * moved in between, the create answers "Price changed" and nothing is reserved or charged.
 * Also returns the slot's CURRENT public state, so "That time was just booked" shows before paying.
 */
_h.entCheckoutQuote = async (req) => {
  const buyerUid = _need(req);
  const d = req.data || {};
  const AV = require('./ent-availability');
  const CORE = require('./shared/ent-availability-core');
  const cal = await AV.loadCalendar(d);
  if (!cal.bookable.ok) fail('failed-precondition', 'This provider is not taking bookings right now.');
  if (!CORE.isDate(d.date) || !/^\d{2}:\d{2}$/.test(String(d.startTime || ''))) fail('invalid-argument', 'Choose a date and time.');
  let serviceName = cal.name || 'Booking'; let baseCents = 0; let feeCents = 0; let durationMins = 60; let serviceId = null;
  if (cal.kind === 'provider') {
    const svc = await AV.loadService(cal, d.serviceId);
    if (!svc) fail('invalid-argument', 'Choose a service.');
    serviceId = svc.id; serviceName = _san(svc.name, 120);
    feeCents = Math.max(0, Math.round(Number(svc.fee) || 0));
    if (svc.pricing && typeof svc.pricing === 'object') {
      const br = require('./service-pricing').computePrice(svc.pricing, { packageId: null, addOns: [], durationMins: undefined }, { date: d.date, startTime: d.startTime, durationMins: undefined, distanceKm: 0 });
      baseCents = Math.max(0, Math.round(Number(br.totalCents) || 0)); durationMins = Math.max(15, Number(br.durationMins) || Number(svc.durationMins) || 30);
    } else { baseCents = Math.max(0, Math.round(Number(svc.price) || 0)); durationMins = Math.max(15, Number(svc.durationMins) || 30); }
  } else {
    const v = cal.raw || {};
    durationMins = Math.max(15, Math.round(Number(d.durationMins) || cal.cfg.durationMins || 60));
    const PS = require('./pricing-schema');
    const s = CORE.toMins(d.startTime);
    const br = PS.compute(PS.normalize(v.pricing), { startMins: s, endMins: s + durationMins, dateStr: d.date, isMember: false, isHoliday: false, addOns: [], promoPct: 0 });
    baseCents = Math.round(Number(br.total || 0) * 100);
  }
  const terms = await resolveTerms({ calKey: cal.calKey, ownerUid: cal.ownerUid, serviceId, buyerUid, rateCardId: d.rateCardId || null, quoteId: d.quoteId || null,
    base: { priceCents: baseCents, durationMins, authority: 'service-pricing' } });
  let priceCents = baseCents; let rateCard = null;
  if (terms.rateCard || terms.quote) { priceCents = terms.priceCents; if (terms.durationMins) durationMins = terms.durationMins; }
  if (terms.rateCard) {
    const c = (await _db().collection(COL.CARDS).doc(terms.rateCard.id).get()).data() || {};
    rateCard = { id: terms.rateCard.id, name: c.name || null, version: terms.rateCard.version };
  }
  let discountCents = 0; let couponNote = null;
  if (d.couponCode) {
    const cp = await findCoupon(cal.ownerUid, d.couponCode);
    if (!cp) couponNote = 'That discount code is not valid here.';
    else {
      const r = couponDiscount((await cp.ref.get()).data(), { priceCents, serviceId, nowMs: Date.now() });
      if (r.ok) discountCents = r.discountCents; else couponNote = r.reason;
    }
  }
  const day = await AV._h.entAvailDay({ auth: req.auth, data: Object.assign({}, cal.kind === 'venue' ? { venueId: cal.id } : { providerId: cal.id }, { serviceId, date: d.date }) });
  const slot = (day.slots || []).find((x) => x.start === d.startTime);
  const policy = (await require('./ent-enquiries').settingsOf(cal.ownerUid)).publicInfo || {};
  const endMin = CORE.toMins(d.startTime) + durationMins;
  return {
    calKey: cal.calKey, serviceId, serviceName, providerName: cal.name || null, date: d.date, start: d.startTime, end: CORE.hhmm(endMin % 1440), durationMins,
    rateCard, quote: terms.quote ? { id: terms.quote.id } : null, currency: 'KES',
    baseCents: priceCents, discountCents, feeCents, totalCents: priceCents - discountCents + feeCents, couponNote,
    slotState: slot ? slot.state : 'UNAVAILABLE',
    paymentMethod: 'M-PESA through SOKONI (held until the booking takes place)',
    refundPolicy: policy.cancellationPolicy || (cal.kind === 'venue'
      ? 'Full refund if you cancel before the venue\'s cancellation window; inside the window the venue\'s cancellation fee is kept. No automatic refund after the start.'
      : 'Full refund if you cancel 24 hours or more before; later cancellations and no-shows keep the deposit. A provider cancellation is always refunded in full.'),
  };
};

/* ── AdminOS ─────────────────────────────────────────────────────────────────────────── */
const _adminH = {};
_adminH.entAdminRateCards = async (req) => {
  if (!_isAdmin(req)) fail('permission-denied', 'Admin only.');
  const d = req.data || {};
  let q = _db().collection(COL.CARDS);
  if (d.ownerUid) q = q.where('ownerUid', '==', _san(d.ownerUid, 128));
  else if (d.calKey) q = q.where('calKey', '==', _san(d.calKey, 140));
  const s = await q.limit(100).get();
  const cards = [];
  for (const doc of s.docs) {
    const c = doc.data();
    const vs = await doc.ref.collection(COL.VERSIONS).limit(20).get();
    cards.push({ id: doc.id, ownerUid: c.ownerUid, calKey: c.calKey, serviceId: c.serviceId, name: c.name, visibility: c.visibility, segment: c.segment, status: c.status,
      currentVersion: c.currentVersion, versions: vs.docs.map((x) => { const v = x.data(); return { version: v.version, priceCents: v.priceCents, unit: v.unit, effectiveFrom: v.effectiveFrom, effectiveTo: v.effectiveTo }; }).sort((a, b) => b.version - a.version) });
  }
  return { cards };
};
_adminH.entAdminRateCardSuspend = async (req) => {
  if (!_isSuper(req)) fail('permission-denied', 'Super admin only.');
  const d = req.data || {};
  const reason = _san(d.reason, 500);
  if (reason.length < 5) fail('invalid-argument', 'A reason is required.');
  const ref = _db().collection(COL.CARDS).doc(_san(d.cardId, 128));
  const s = await ref.get();
  if (!s.exists) fail('not-found', 'Rate card not found.');
  await ref.update({ status: d.restore ? 'ACTIVE' : 'SUSPENDED', moderatedBy: req.auth.uid, moderationReason: reason, updatedAt: _FV().serverTimestamp() });
  await _audit({ cardId: ref.id, actor: req.auth.uid, action: d.restore ? 'admin_restore' : 'admin_suspend', reason });
  return { ok: true };
};

module.exports = { COL, VISIBILITY, SEGMENTS, QUOTE, PRICING_AUTHORITY, _h, _adminH,
  currentVersion, isEligible, priceFor, resolveTerms, findCoupon, couponDiscount,
  _setClock: (fn) => { _now = fn || (() => Date.now()); } };
