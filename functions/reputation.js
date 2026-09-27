/* SOKONI — Provider Reputation Authority  functions/reputation.js
 * ============================================================================================
 * Followers, ratings, reviews, review moderation and sharing for providers (artists, service
 * providers, approved creators taking bookings), venues and creators — ONE authority that EXTENDS the
 * existing stores (owner decisions 2026-09-27, see docs/PROVIDER_REPUTATION.md):
 *
 *   follows/{uid}--{type}--{id}        the EXISTING follow store. For type provider | venue | creator
 *                                      it is now SERVER-written (client writes denied by the rules).
 *   providerReviews/{reviewId}         the EXISTING canonical provider review store (one review per
 *                                      completed booking). Extended to venues (id ven_{bookingId}).
 *   providers/{uid} · venues/{id} ·    the entity's own PUBLIC doc carries the server-derived aggregate:
 *   creators/{uid}                     rating · reviewCount · ratingSum · ratingDist · followerCount ·
 *                                      shareCount · shareHandle · repV (rating aggregate server-derived) · followV (followerCount server-maintained).
 *   providerProfiles/{uid}             private mirror kept for existing readers (search sort, KPIs).
 *   reports/{rep_…}                    the EXISTING trust-and-safety report store (controlled reasons).
 *   shareHandles/{handle}              public share handle → entity (no uid in any share link).
 *   shareEvents/{…}                    one counted share event per user / entity / day.
 *   reputationAudit                    every moderation / recount.
 *
 * NEVER trusted from the client: reviewer, provider, rating aggregate, counts, eligibility, verified.
 * Reviewer = request.auth.uid. Provider / venue = derived from the booking. Aggregates are written in
 * the SAME transaction that changes a review or a follow.
 */
'use strict';
const admin = require('firebase-admin');
const { HttpsError } = require('firebase-functions/v2/https');
const crypto = require('crypto');

const COL = Object.freeze({ FOLLOWS: 'follows', REVIEWS: 'providerReviews', REPORTS: 'reports', HANDLES: 'shareHandles',
  SHARES: 'shareEvents', AUDIT: 'reputationAudit' });
const TYPES = Object.freeze(['provider', 'venue', 'creator']);
const REPORT_REASONS = Object.freeze(['HARASSMENT', 'SPAM', 'PERSONAL_INFORMATION', 'FRAUD_ALLEGATION', 'IRRELEVANT', 'ABUSIVE', 'OTHER']);
const REVIEW_STATUS = Object.freeze({ PUBLISHED: 'published', HIDDEN: 'hidden', REMOVED: 'removed' });
/* Policy (documented, not client-settable): a review is possible within 60 days of the experience;
   the author may edit it 3 times within 14 days of posting. */
const POLICY = Object.freeze({ REVIEW_WINDOW_MS: 60 * 86400000, EDIT_WINDOW_MS: 14 * 86400000, MAX_EDITS: 3 });
const BASE_URL = 'https://mysokoni.co.ke';
const REP_VERSION = 1;

const _db = () => admin.firestore();
const _FV = () => admin.firestore.FieldValue;
let _now = () => Date.now();
const fail = (code, msg, details) => { throw new HttpsError(code, msg, details); };
const _san = (s, n) => String(s == null ? '' : s).replace(/[<>]/g, '').replace(/[\u0000-\u0008\u000B-\u001F]/g, '').trim().slice(0, n || 200);
const _need = (req) => { const u = req && req.auth && req.auth.uid; if (!u) fail('unauthenticated', 'Sign in required.'); return u; };
const _tok = (req) => (req && req.auth && req.auth.token) || {};
const _isAdmin = (req) => { const t = _tok(req); return t.admin === true || t.superAdmin === true || t.role === 'admin' || t.role === 'superAdmin'; };
const _isSuper = (req) => { const t = _tok(req); return t.superAdmin === true || t.role === 'superAdmin'; };
const _ms = (v) => (v == null ? null : typeof v === 'number' ? v : v.toMillis ? v.toMillis() : Number.isFinite(Date.parse(v)) ? Date.parse(v) : null);
const _idOk = (v) => /^[A-Za-z0-9_-]{1,128}$/.test(String(v || ''));
const followId = (uid, type, id) => `${uid}--${type}--${String(id).replace(/[^a-zA-Z0-9]/g, '_')}`;
/* "Achieng Otieno" → "Achieng O." — a public review never carries a full name, uid or contact. */
function publicName(full) {
  const p = String(full || '').trim().split(/\s+/).filter(Boolean);
  if (!p.length) return 'SOKONI customer';
  return p.length > 1 ? `${p[0].slice(0, 30)} ${p[p.length - 1][0].toUpperCase()}.` : p[0].slice(0, 30);
}

/* ── entities ─────────────────────────────────────────────────────────────────────────── */
const ENTITY = {
  provider: { col: 'providers', public: (d) => d && ['active', 'approved'].includes(d.status) && d.suspended !== true, owner: (id) => id, name: (d) => d.businessName || d.name },
  venue: { col: 'venues', public: (d) => d && d.status === 'active', owner: (id, d) => d.ownerId, name: (d) => d.name },
  creator: { col: 'creators', public: (d) => d && d.state === 'ACTIVE', owner: (id) => id, name: (d) => d.displayName || d.name },
};
function _type(t) { const x = String(t || ''); if (!TYPES.includes(x)) fail('invalid-argument', 'Unknown profile type.'); return x; }
function _ref(type, id) { return _db().collection(ENTITY[type].col).doc(String(id)); }
async function loadEntity(type, id) {
  _type(type);
  if (!_idOk(id)) fail('invalid-argument', 'Unknown profile.');
  const s = await _ref(type, id).get();
  if (!s.exists) fail('not-found', 'Profile not found.');
  const d = s.data();
  return { type, id: String(id), data: d, ownerUid: ENTITY[type].owner(String(id), d), name: _san(ENTITY[type].name(d), 120) || 'SOKONI', isPublic: !!ENTITY[type].public(d) };
}

/* The aggregate as the SERVER maintains it. A provider doc written before this authority (repV
   absent) may carry an owner-written rating — it is never shown; the server-written private mirror
   (providerProfiles, from bookingSubmitReview) is used instead until the recount marks the doc. */
async function aggregateOf(type, id, entityData) {
  const d = entityData || ((await _ref(type, id).get()).data() || {});
  const count = (x) => (typeof x === 'number' ? x : null);
  const fc = _followCounted(d) ? d.followerCount : null;   /* an owner-written legacy followerCount is unknown, never shown */
  if (d.repV) {
    return { rating: d.reviewCount > 0 ? Math.round((d.ratingSum / d.reviewCount) * 100) / 100 : null, reviewCount: count(d.reviewCount) || 0,
      ratingDist: d.ratingDist || null, followerCount: fc, verifiedAggregate: true };
  }
  if (type === 'provider') {
    const p = (await _db().collection('providerProfiles').doc(String(id)).get()).data() || {};
    const n = Number(p.reviewCount) || 0; const sum = Number(p.ratingSum);
    return { rating: n > 0 ? Math.round(((Number.isFinite(sum) ? sum : Number(p.rating) * n) / n) * 100) / 100 : null, reviewCount: n,
      ratingDist: null, followerCount: fc, verifiedAggregate: true };
  }
  return { rating: null, reviewCount: 0, ratingDist: null, followerCount: fc, verifiedAggregate: false };
}
/* TWO markers, never one: repV = the RATING aggregate is server-derived (set only by a review write or
   a recount); followV = followerCount is server-maintained (set by a follow / unfollow / recount).
   A follow must never make a legacy owner-written rating look server-derived. */
function _followCounted(d) { return !!(d && d.followV && typeof d.followerCount === 'number'); }

/* Baseline for a counter the first time the server touches an entity (legacy client-written follows). */
async function _followBase(type, id, excludeUid) {
  const s = await _db().collection(COL.FOLLOWS).where('type', '==', type).where('entityId', '==', String(id)).limit(5000).get().catch(() => ({ docs: [] }));
  return s.docs.filter((x) => !excludeUid || x.data().uid !== excludeUid).length;
}

async function _audit(entry) {
  try { await _db().collection(COL.AUDIT).add(Object.assign({ at: _now(), createdAt: _FV().serverTimestamp() }, entry)); }
  catch (e) { console.error('[reputation] audit write failed', e.message); }
}

const _h = {};

/* ═══ FOLLOWERS ═══════════════════════════════════════════════════════════════════════════ */
_h.repFollow = async (req) => {
  const uid = _need(req);
  const d = req.data || {};
  const type = _type(d.type); const id = String(d.id || '');
  const ent = await loadEntity(type, id);
  if (!ent.isPublic) fail('failed-precondition', 'This profile cannot be followed right now.');
  if (ent.ownerUid === uid) fail('failed-precondition', 'You cannot follow your own profile.');
  const fRef = _db().collection(COL.FOLLOWS).doc(followId(uid, type, id));
  const eRef = _ref(type, id);
  const base = _followCounted(ent.data) ? null : await _followBase(type, id, uid);
  let out = null;
  await _db().runTransaction(async (txn) => {
    const [f, e] = [await txn.get(fRef), await txn.get(eRef)];
    const counted = _followCounted(e.data());   /* server-maintained since a recount / first server follow */
    const cur = counted ? e.data().followerCount : (base || 0);             /* base = everyone ELSE's follows */
    if (f.exists && f.data().via === 'server') { out = { following: true, followerCount: cur, already: true }; return; }
    txn.set(fRef, { uid, type, entityId: id, entityName: ent.name, showMe: d.showMe === true, via: 'server', createdAt: f.exists ? (f.data().createdAt || _FV().serverTimestamp()) : _FV().serverTimestamp() });
    /* A legacy client-written follow is ADOPTED: already inside a server-maintained count (the recount
       counts every follow doc), so it is not counted twice. */
    const next = counted ? (f.exists ? cur : cur + 1) : cur + 1;
    txn.set(eRef, { followerCount: Math.max(0, next), followV: REP_VERSION }, { merge: true });
    out = { following: true, followerCount: Math.max(0, next) };
  });
  return out;
};
_h.repUnfollow = async (req) => {
  const uid = _need(req);
  const d = req.data || {};
  const type = _type(d.type); const id = String(d.id || '');
  if (!_idOk(id)) fail('invalid-argument', 'Unknown profile.');
  const fRef = _db().collection(COL.FOLLOWS).doc(followId(uid, type, id));
  const eRef = _ref(type, id);
  const eSnap = await eRef.get();
  if (!eSnap.exists) fail('not-found', 'Profile not found.');
  const base = _followCounted(eSnap.data()) ? null : await _followBase(type, id, null);
  let out = null;
  await _db().runTransaction(async (txn) => {
    const [f, e] = [await txn.get(fRef), await txn.get(eRef)];
    const counted = _followCounted(e.data());
    const cur = counted ? e.data().followerCount : (base || 0);
    if (!f.exists) { out = { following: false, followerCount: cur, already: true }; return; }
    txn.delete(fRef);
    const next = Math.max(0, cur - 1);      /* never negative (uncounted: base already includes this follow) */
    txn.set(eRef, { followerCount: next, followV: REP_VERSION }, { merge: true });
    out = { following: false, followerCount: next };
  });
  return out;
};
/** The follower chooses whether the provider may see their first name (default: private). */
_h.repFollowVisibility = async (req) => {
  const uid = _need(req);
  const d = req.data || {};
  const type = _type(d.type); const id = String(d.id || '');
  if (!_idOk(id)) fail('invalid-argument', 'Unknown profile.');
  const fRef = _db().collection(COL.FOLLOWS).doc(followId(uid, type, id));
  const f = await fRef.get();
  if (!f.exists || f.data().via !== 'server') fail('failed-precondition', 'Follow this profile first.');
  await fRef.update({ showMe: d.showMe === true });
  return { showMe: d.showMe === true };
};
/** The caller's follow state for up to 50 profiles (signed-out → all false). */
_h.repFollowState = async (req) => {
  const uid = req.auth && req.auth.uid;
  const items = (Array.isArray((req.data || {}).items) ? req.data.items : []).slice(0, 50);
  const out = {};
  for (const it of items) {
    if (!it || !TYPES.includes(it.type) || !_idOk(it.id)) continue;
    const key = `${it.type}:${it.id}`;
    out[key] = uid ? (await _db().collection(COL.FOLLOWS).doc(followId(uid, it.type, it.id)).get()).exists : false;
  }
  return { following: out };
};
/**
 * The provider's followers. Count always; a follower appears BY NAME only if they chose to be shown
 * (showMe). Never a uid, email, phone, booking or payment. Only the profile's owner may ask.
 */
_h.repFollowers = async (req) => {
  const uid = _need(req);
  const d = req.data || {};
  const type = _type(d.type || 'provider'); const id = String(d.id || uid);
  const ent = await loadEntity(type, id);
  if (ent.ownerUid !== uid) fail('permission-denied', 'Only the profile owner can see its followers.');
  const s = await _db().collection(COL.FOLLOWS).where('type', '==', type).where('entityId', '==', id).limit(500).get();
  const visible = []; let hidden = 0;
  for (const x of s.docs) {
    const f = x.data();
    if (f.showMe !== true) { hidden++; continue; }
    const u = (await _db().collection('users').doc(f.uid).get()).data() || {};
    visible.push({ name: publicName(u.displayName || u.name), since: _ms(f.createdAt) });
  }
  visible.sort((a, b) => (b.since || 0) - (a.since || 0));
  const agg = await aggregateOf(type, id, ent.data);
  return { followerCount: agg.followerCount, visible: visible.slice(0, 200), hiddenCount: hidden, truncated: s.docs.length >= 500 };
};

/* ═══ REVIEWS ═════════════════════════════════════════════════════════════════════════════ */
/**
 * Eligibility — the explicit rule. A review is tied to a REAL SOKONI experience:
 *   providerBookings: the caller is its customer; it is COMPLETED (or its show-up was verified and
 *     settled and its time has ended); never cancelled / declined / no-show / refunded; within 60 days.
 *   bookings (venue core): the caller is its customer; COMPLETED, or checked in and its time has ended;
 *     paid (or free); never cancelled / no-show / refunded; within 60 days; the venue's owner matches.
 * An enquiry, a profile view, a follow or an unpaid / cancelled booking is NEVER eligible.
 */
function eligibility(source, b, uid, nowMs) {
  if (!b) return { ok: false, code: 'not-found', why: 'Booking not found.' };
  const end = Number(b.endTs) || _ms(b.completedAt) || _ms(b.scheduledAt) || 0;
  if (source === 'providerBookings') {
    if (b.customerUid !== uid) return { ok: false, code: 'permission-denied', why: 'Not your booking.' };
    if (['cancelled', 'declined', 'no_show'].includes(b.status) || ['refunded'].includes(b.paymentStatus)) return { ok: false, code: 'failed-precondition', why: 'A cancelled or refunded booking cannot be reviewed.' };
    const done = b.status === 'completed' || (b.settledTrigger === 'show_up' && b.paymentStatus === 'settled' && end && nowMs >= end);
    if (!done) return { ok: false, code: 'failed-precondition', why: 'You can review a booking only after it is completed.' };
  } else if (source === 'bookings') {
    if (b.customerId !== uid) return { ok: false, code: 'permission-denied', why: 'Not your booking.' };
    if (['cancelled', 'no_show', 'rejected'].includes(b.status) || ['refunded', 'partially_refunded'].includes(b.paymentStatus)) return { ok: false, code: 'failed-precondition', why: 'A cancelled or refunded booking cannot be reviewed.' };
    if (b.requiresPayment === true && b.paymentStatus !== 'paid') return { ok: false, code: 'failed-precondition', why: 'Only a paid booking can be reviewed.' };
    const done = b.status === 'completed' || (!!b.checkIn && end && nowMs >= end);
    if (!done) return { ok: false, code: 'failed-precondition', why: 'You can review a booking only after it is completed.' };
  } else return { ok: false, code: 'invalid-argument', why: 'Unknown booking.' };
  if (end && nowMs > end + POLICY.REVIEW_WINDOW_MS) return { ok: false, code: 'failed-precondition', why: 'The review window for this booking has closed.' };
  return { ok: true };
}
/* A review's doc id IS its booking id (one review per booking). The public never sees it: they see an
   opaque one-way id, stored on the review so a report can resolve it (recount backfills older reviews). */
function publicReviewId(reviewId) { return 'rv_' + crypto.createHash('sha256').update('sokoni-review|' + String(reviewId)).digest('hex').slice(0, 24); }
function _distAdd(dist, rating, delta) { const x = Object.assign({ 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }, dist || {}); x[rating] = Math.max(0, (Number(x[rating]) || 0) + delta); return x; }
/* aggregate change, staged in the caller's transaction (entity + provider mirror already read) */
function _stageAggregate(txn, target, eSnapData, mirror, deltaCount, deltaSum, distChanges) {
  const e = eSnapData || {};
  const baseCount = e.repV ? Number(e.reviewCount) || 0 : (mirror ? Number(mirror.reviewCount) || 0 : 0);
  const baseSum = e.repV ? Number(e.ratingSum) || 0 : (mirror ? (Number.isFinite(Number(mirror.ratingSum)) ? Number(mirror.ratingSum) : Math.round((Number(mirror.rating) || 0) * baseCount)) : 0);
  let dist = e.repV ? (e.ratingDist || null) : null;
  for (const [r, dd] of distChanges) dist = _distAdd(dist, r, dd);
  const count = Math.max(0, baseCount + deltaCount); const sum = Math.max(0, baseSum + deltaSum);
  const rating = count ? Math.round((sum / count) * 100) / 100 : 0;
  txn.set(target.eRef, { rating, reviewCount: count, ratingSum: sum, ratingDist: dist, repV: REP_VERSION, reputationUpdatedAt: _FV().serverTimestamp() }, { merge: true });
  if (target.mirrorRef) txn.set(target.mirrorRef, { rating, reviewCount: count, ratingSum: sum, updatedAt: _FV().serverTimestamp() }, { merge: true });
  return { rating, reviewCount: count };
}
function _target(entityType, entityId) {
  return { eRef: _ref(entityType, entityId), mirrorRef: entityType === 'provider' ? _db().collection('providerProfiles').doc(String(entityId)) : null };
}

/**
 * THE review writer. Called by the canonical bookingSubmitReview (service engine) and repSubmitReview
 * (either engine). Reviewer = auth; provider / venue = derived from the booking; aggregate in the same
 * transaction; replay-safe (deterministic review id = one review per booking).
 */
async function submitReview(req, fixedSource) {
  const uid = _need(req);
  const d = req.data || {};
  const source = fixedSource || (d.source === 'bookings' ? 'bookings' : 'providerBookings');
  const bookingId = _san(d.bookingId, 200);
  const rating = Math.round(Number(d.rating));
  const text = _san(d.text, 1000);
  if (!_idOk(bookingId)) fail('invalid-argument', 'bookingId is required.');
  if (!(rating >= 1 && rating <= 5) || String(rating) !== String(Number(d.rating))) fail('invalid-argument', 'rating must be an integer 1–5.');
  const bRef = _db().collection(source).doc(bookingId);
  const reviewId = source === 'bookings' ? `ven_${bookingId}` : bookingId;      /* service ids unchanged (back-compat) */
  const rRef = _db().collection(COL.REVIEWS).doc(reviewId);
  const pre = (await bRef.get()).data();
  if (!pre) fail('not-found', 'Booking not found.');
  const entityType = source === 'bookings' ? 'venue' : 'provider';
  const entityId = source === 'bookings' ? String(pre.venueId || '') : String(pre.providerId || '');
  if (!_idOk(entityId)) fail('failed-precondition', 'This booking has no reviewable provider.');
  if (entityType === 'venue') {
    const v = (await _ref('venue', entityId).get()).data();
    if (!v || v.ownerId !== pre.ownerId) fail('failed-precondition', 'This booking has no reviewable venue.');
  }
  const ownerUid = entityType === 'venue' ? pre.ownerId : entityId;
  if (ownerUid === uid) fail('permission-denied', 'You cannot review your own business.');
  const tgt = _target(entityType, entityId);
  const reviewer = (await _db().collection('users').doc(uid).get()).data() || {};
  let outcome = null;
  await _db().runTransaction(async (txn) => {
    outcome = null;
    const b = (await txn.get(bRef)).data();
    const r = await txn.get(rRef);
    const e = (await txn.get(tgt.eRef)).data() || {};
    const m = tgt.mirrorRef ? (await txn.get(tgt.mirrorRef)).data() || {} : null;
    const el = eligibility(source, b, uid, _now());
    if (!el.ok) fail(el.code, el.why);
    if (r.exists) { outcome = { alreadyReviewed: true, reviewId }; return; }
    txn.set(rRef, {
      entityType, entityId, providerId: ownerUid, customerUid: uid, publicId: publicReviewId(reviewId),
      customerName: publicName(reviewer.displayName || reviewer.name || b.customerName),
      sourceRef: `${source}/${bookingId}`, bookingId,
      serviceId: b.serviceId || null, service: _san(b.service || b.venueName, 120) || null,
      rating, text, verified: true, status: REVIEW_STATUS.PUBLISHED, edits: 0, reportCount: 0, reply: null,
      bookingStatusAtReview: b.status || null, createdAt: _FV().serverTimestamp(), createdAtMs: _now(), updatedAt: _FV().serverTimestamp(),
    });
    const agg = _stageAggregate(txn, tgt, e, m, 1, rating, [[rating, 1]]);
    txn.update(bRef, { reviewedAt: _FV().serverTimestamp(), reviewRating: rating, updatedAt: _FV().serverTimestamp() });
    outcome = { created: true, reviewId, ownerUid, agg };
  });
  if (outcome.alreadyReviewed) return { success: true, alreadyReviewed: true, reviewId };
  try {
    await require('./notify').notify({ uid: outcome.ownerUid, type: 'rep_new_review', title: 'New review', body: `${rating}★ from a verified customer.`,
      deepLink: '/provider-dashboard.html', dedupeKey: `rep_new_review_${reviewId}`, awaitDelivery: false });
  } catch (_) { /* best-effort */ }
  return { success: true, created: true, reviewId, rating };
}
_h.repSubmitReview = (req) => submitReview(req, null);

/** The author edits their review: within 14 days of posting, at most 3 times, while published. */
_h.repEditReview = async (req) => {
  const uid = _need(req);
  const d = req.data || {};
  const rRef = _db().collection(COL.REVIEWS).doc(_san(d.reviewId, 200));
  const pre = (await rRef.get()).data();
  if (!pre) fail('not-found', 'Review not found.');
  if (pre.customerUid !== uid) fail('permission-denied', 'Only the author can edit a review.');
  const tgt = _target(pre.entityType || 'provider', pre.entityId || pre.providerId);
  const rating = d.rating != null ? Math.round(Number(d.rating)) : null;
  if (rating != null && !(rating >= 1 && rating <= 5)) fail('invalid-argument', 'rating must be an integer 1–5.');
  await _db().runTransaction(async (txn) => {
    const r = (await txn.get(rRef)).data();
    const e = (await txn.get(tgt.eRef)).data() || {};
    const m = tgt.mirrorRef ? (await txn.get(tgt.mirrorRef)).data() || {} : null;
    if (r.status !== REVIEW_STATUS.PUBLISHED) fail('failed-precondition', 'This review can no longer be edited.');
    if ((Number(r.edits) || 0) >= POLICY.MAX_EDITS) fail('failed-precondition', 'This review has been edited the maximum number of times.');
    const created = Number(r.createdAtMs) || _ms(r.createdAt) || 0;
    if (_now() - created > POLICY.EDIT_WINDOW_MS) fail('failed-precondition', 'The edit window for this review has closed.');
    const patch = { edits: (Number(r.edits) || 0) + 1, edited: true, editedAt: _FV().serverTimestamp(), updatedAt: _FV().serverTimestamp() };
    if (d.text != null) patch.text = _san(d.text, 1000);
    if (rating != null && rating !== r.rating) {
      patch.rating = rating;
      _stageAggregate(txn, tgt, e, m, 0, rating - r.rating, [[r.rating, -1], [rating, 1]]);
    }
    txn.update(rRef, patch);
  });
  return { ok: true };
};

/** Report a review (controlled reasons). Creates a moderation case; NEVER changes the rating. */
_h.repReportReview = async (req) => {
  const uid = _need(req);
  const d = req.data || {};
  let reviewId = _san(d.reviewId, 200);
  const reason = String(d.reason || '');
  if (!REPORT_REASONS.includes(reason)) fail('invalid-argument', 'Choose a reason.');
  if (/^rv_[0-9a-f]{24}$/.test(reviewId)) {        /* the public id from repReviews */
    const hit = await _db().collection(COL.REVIEWS).where('publicId', '==', reviewId).limit(1).get();
    if (hit.empty) fail('not-found', 'Review not found.');
    reviewId = hit.docs[0].id;
  } else if (!reviewId) fail('invalid-argument', 'Review not found.');
  const rRef = _db().collection(COL.REVIEWS).doc(reviewId);
  const repRef = _db().collection(COL.REPORTS).doc(`rep_${reviewId}_${uid}`.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 300));
  await _db().runTransaction(async (txn) => {
    const [r, rp] = [await txn.get(rRef), await txn.get(repRef)];
    if (!r.exists || r.data().status === REVIEW_STATUS.REMOVED) fail('not-found', 'Review not found.');
    if (rp.exists) fail('already-exists', 'You already reported this review.');
    txn.set(repRef, { entityType: 'providerReview', entityId: reviewId, reason, detail: _san(d.detail, 500), reportedBy: uid,
      reporterRole: r.data().providerId === uid ? 'provider' : 'user', status: 'pending',
      severity: ['HARASSMENT', 'FRAUD_ALLEGATION', 'PERSONAL_INFORMATION'].includes(reason) ? 'high' : 'normal',
      createdAt: _FV().serverTimestamp(), reviewedBy: null, resolution: null, reviewedAt: null });
    txn.update(rRef, { reportCount: _FV().increment(1), lastReportedAt: _FV().serverTimestamp() });
  });
  return { ok: true };
};

/** PUBLIC reviews of a profile: published only; no uid, booking id, amount, contact or PIN. */
_h.repReviews = async (req) => {
  const d = req.data || {};
  const type = _type(d.type); const id = String(d.id || '');
  if (!_idOk(id)) fail('invalid-argument', 'Unknown profile.');
  if (type === 'creator') return { reviews: [], note: 'Creator bookings are reviewed on the creator\'s provider profile.' };
  const q = type === 'venue'
    ? _db().collection(COL.REVIEWS).where('entityId', '==', id)
    : _db().collection(COL.REVIEWS).where('providerId', '==', id);
  const s = await q.limit(300).get();
  const viewer = req.auth && req.auth.uid;
  const rows = s.docs.map((x) => Object.assign({ id: x.id }, x.data()))
    .filter((r) => (type === 'venue' ? r.entityType === 'venue' : r.entityType !== 'venue'))
    .filter((r) => (r.status || REVIEW_STATUS.PUBLISHED) === REVIEW_STATUS.PUBLISHED)
    .map((r) => ({ id: r.publicId || publicReviewId(r.id), rating: r.rating, text: r.text || '', author: publicName(r.customerName), verified: r.verified !== false,
      service: r.service || null, edited: !!r.edited, createdAt: Number(r.createdAtMs) || _ms(r.createdAt),
      reply: r.reply ? { text: typeof r.reply === 'string' ? r.reply : r.reply.text, at: _ms(r.repliedAt) } : null, mine: !!viewer && r.customerUid === viewer }))
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  const lim = Math.min(50, Math.max(1, Number(d.limit) || 20));
  const before = Number(d.before) || null;
  const rest = before ? rows.filter((r) => (r.createdAt || 0) < before) : rows;
  return { reviews: rest.slice(0, lim), more: rest.length > lim };
};

/** PUBLIC summaries for storefronts / cards: rating, count, distribution, followers (≤ 30). */
_h.repSummary = async (req) => {
  const items = (Array.isArray((req.data || {}).items) ? req.data.items : []).slice(0, 30);
  const out = {};
  for (const it of items) {
    if (!it || !TYPES.includes(it.type) || !_idOk(it.id)) continue;
    const s = await _ref(it.type, it.id).get();
    if (!s.exists || !ENTITY[it.type].public(s.data())) { out[`${it.type}:${it.id}`] = null; continue; }
    const a = await aggregateOf(it.type, it.id, s.data());
    out[`${it.type}:${it.id}`] = { rating: a.rating, reviewCount: a.reviewCount, ratingDist: a.ratingDist, followerCount: a.followerCount,
      verified: it.type === 'provider' ? s.data().verified === true : it.type === 'venue' ? true : s.data().verificationStatus === 'APPROVED' };
  }
  return { summaries: out };
};

/** The signed-in customer's reviews and the bookings they can still review. */
_h.repMyReviews = async (req) => {
  const uid = _need(req);
  const now = _now();
  const mine = (await _db().collection(COL.REVIEWS).where('customerUid', '==', uid).limit(100).get()).docs
    .map((x) => { const r = x.data(); return { id: x.id, rating: r.rating, text: r.text, status: r.status || 'published', entityType: r.entityType || 'provider', service: r.service || null,
      edits: Number(r.edits) || 0, editableUntil: (Number(r.createdAtMs) || _ms(r.createdAt) || 0) + POLICY.EDIT_WINDOW_MS, reply: r.reply ? (typeof r.reply === 'string' ? r.reply : r.reply.text) : null }; });
  const reviewed = new Set(mine.map((r) => r.id));
  const eligible = [];
  const pb = await _db().collection('providerBookings').where('customerUid', '==', uid).limit(100).get();
  for (const x of pb.docs) if (!reviewed.has(x.id) && eligibility('providerBookings', x.data(), uid, now).ok) eligible.push({ source: 'providerBookings', bookingId: x.id, service: x.data().service || null, date: x.data().date || null });
  const vb = await _db().collection('bookings').where('customerId', '==', uid).limit(100).get();
  for (const x of vb.docs) if (x.data().venueId && !reviewed.has('ven_' + x.id) && eligibility('bookings', x.data(), uid, now).ok) eligible.push({ source: 'bookings', bookingId: x.id, service: x.data().venueName || null, date: x.data().date || null });
  return { reviews: mine, eligible };
};

/** Owner dashboard: reputation (aggregate + recent + reported), audience, sharing activity. */
_h.repDashboard = async (req) => {
  const uid = _need(req);
  const d = req.data || {};
  const type = _type(d.type || 'provider'); const id = String(d.id || uid);
  const ent = await loadEntity(type, id);
  if (ent.ownerUid !== uid) fail('permission-denied', 'This profile is not yours.');
  const agg = await aggregateOf(type, id, ent.data);
  let reviews = [];
  if (type !== 'creator') {
    const q = type === 'venue' ? _db().collection(COL.REVIEWS).where('entityId', '==', id) : _db().collection(COL.REVIEWS).where('providerId', '==', uid);
    reviews = (await q.limit(200).get()).docs.map((x) => Object.assign({ id: x.id }, x.data()))
      .filter((r) => (type === 'venue' ? r.entityType === 'venue' : r.entityType !== 'venue') && r.status !== REVIEW_STATUS.REMOVED)
      .map((r) => ({ id: r.id, rating: r.rating, text: r.text, author: publicName(r.customerName), status: r.status || 'published', reportCount: Number(r.reportCount) || 0,
        reply: r.reply ? (typeof r.reply === 'string' ? r.reply : r.reply.text) : null, service: r.service || null, createdAt: Number(r.createdAtMs) || _ms(r.createdAt) }))
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  }
  return { profile: { type, id, name: ent.name, isPublic: ent.isPublic }, reputation: agg, recent: reviews.slice(0, 50),
    reported: reviews.filter((r) => r.reportCount > 0).slice(0, 50),
    sharing: { shareCount: typeof ent.data.shareCount === 'number' ? ent.data.shareCount : null, handle: ent.data.shareHandle || null } };
};

/* ═══ SHARING ═════════════════════════════════════════════════════════════════════════════ */
function _slug(name) { return String(name || 'sokoni').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'sokoni'; }
async function handleFor(type, id, ent) {
  if (ent.data.shareHandle) return ent.data.shareHandle;
  for (let i = 0; i < 5; i++) {
    const h = `${_slug(ent.name)}-${crypto.randomBytes(3).toString('hex')}`;
    const hRef = _db().collection(COL.HANDLES).doc(h);
    let got = null;
    await _db().runTransaction(async (txn) => {
      const [hs, es] = [await txn.get(hRef), await txn.get(_ref(type, id))];
      if (es.data() && es.data().shareHandle) { got = es.data().shareHandle; return; }
      if (hs.exists) return;
      txn.create(hRef, { type, id, createdAt: _FV().serverTimestamp() });
      txn.set(_ref(type, id), { shareHandle: h }, { merge: true });
      got = h;
    });
    if (got) return got;
  }
  fail('unavailable', 'Could not create a share link. Try again.');
  return null;
}
/**
 * A clean public link — a HANDLE, never a uid, phone, email, PIN, payment reference or conversation id.
 *   provider / venue / creator → /p.html?h=<handle>   · a service → &s=<serviceId> · an event → /event-hub.html?event=<eventId>
 */
_h.repShareLink = async (req) => shareLink(req.data || {});
/** The link builder, also used server-side (provider QR codes — functions/provider-onboarding.js). */
async function shareLink(d) {
  if (d.type === 'event') {
    if (!_idOk(d.id)) fail('invalid-argument', 'Unknown event.');
    const ev = (await _db().collection('events').doc(String(d.id)).get()).data();
    if (!ev || !['live', 'published', 'active'].includes(String(ev.status || '').toLowerCase())) fail('failed-precondition', 'This event is not public.');
    return { url: `${BASE_URL}/event-hub.html?event=${encodeURIComponent(d.id)}`, title: _san(ev.title, 120) };
  }
  const type = _type(d.type); const ent = await loadEntity(type, d.id);
  if (!ent.isPublic) fail('failed-precondition', 'This profile is not public.');
  const h = await handleFor(type, ent.id, ent);
  let url = `${BASE_URL}/p.html?h=${encodeURIComponent(h)}`; let title = ent.name;
  if (d.serviceId) {
    if (type !== 'provider' || !_idOk(d.serviceId)) fail('invalid-argument', 'Unknown service.');
    const sv = (await _db().collection('providerServices').doc(String(d.serviceId)).get()).data();
    if (!sv || sv.providerId !== ent.id || sv.active === false || sv.removedAt) fail('failed-precondition', 'This service is not public.');
    url += `&s=${encodeURIComponent(d.serviceId)}`; title = `${_san(sv.name, 80)} · ${ent.name}`;
  }
  return { url, title };
}
/** Resolve a share handle to the in-app page (public). */
_h.repResolveHandle = async (req) => {
  const d = req.data || {};
  const h = String(d.h || '');
  if (!/^[a-z0-9-]{3,48}$/.test(h)) fail('not-found', 'This link is not valid.');
  const s = await _db().collection(COL.HANDLES).doc(h).get();
  if (!s.exists) fail('not-found', 'This link is not valid.');
  const { type, id } = s.data();
  const ent = await loadEntity(type, id);
  if (!ent.isPublic) fail('not-found', 'This profile is not available.');
  const sv = d.s && _idOk(d.s) ? `&service=${encodeURIComponent(d.s)}` : '';
  /* A provider lands on a HANDLE url too, so the address bar a visitor may copy never carries the uid;
     the page resolves the handle with this same op (the id is returned for that page only). */
  const path = type === 'provider' ? `/provider-profile.html?h=${encodeURIComponent(h)}${sv}`
    : type === 'venue' ? `/venue-booking.html?venue=${encodeURIComponent(id)}` : `/creator.html?creator=${encodeURIComponent(id)}`;
  return { path, type, id: String(id), name: ent.name };
};
/**
 * Record ONE share event (a share action — not a person, not a follow, not a rating). Signed-in only;
 * one counted event per user / profile / day; never touches followers or ratings.
 */
_h.repShareEvent = async (req) => {
  const uid = req.auth && req.auth.uid;
  if (!uid) return { counted: false };
  const d = req.data || {};
  const type = _type(d.type);
  if (!_idOk(d.id)) fail('invalid-argument', 'Unknown profile.');
  const channel = ['whatsapp', 'copy', 'native', 'facebook', 'x', 'telegram', 'email', 'sms', 'other'].includes(d.channel) ? d.channel : 'other';
  const day = new Date(_now() + 3 * 3600000).toISOString().slice(0, 10);
  const evRef = _db().collection(COL.SHARES).doc(`${type}_${d.id}_${uid}_${day}`);
  const eRef = _ref(type, d.id);
  let counted = false;
  await _db().runTransaction(async (txn) => {
    const [ev, e] = [await txn.get(evRef), await txn.get(eRef)];
    if (!e.exists || ev.exists) return;
    txn.create(evRef, { type, id: String(d.id), channel, day, createdAt: _FV().serverTimestamp() });
    txn.set(eRef, { shareCount: (Number(e.data().shareCount) || 0) + 1 }, { merge: true });
    counted = true;
  });
  return { counted };
};

/* ═══ AdminOS › Reviews & Reputation ══════════════════════════════════════════════════════ */
const _adminH = {};
_adminH.repAdminReviews = async (req) => {
  if (!_isAdmin(req)) fail('permission-denied', 'Admin only.');
  const d = req.data || {};
  let q = _db().collection(COL.REVIEWS);
  if (d.reported) q = q.where('reportCount', '>', 0);
  else if (d.status) q = q.where('status', '==', _san(d.status, 20));
  else if (d.entityId) q = q.where(d.entityType === 'venue' ? 'entityId' : 'providerId', '==', _san(d.entityId, 128));
  const s = await q.limit(100).get();
  const reps = await _db().collection(COL.REPORTS).where('entityType', '==', 'providerReview').limit(300).get().catch(() => ({ docs: [] }));
  const byReview = {};
  reps.docs.forEach((x) => { const r = x.data(); (byReview[r.entityId] = byReview[r.entityId] || []).push({ id: x.id, reason: r.reason, status: r.status, role: r.reporterRole || null }); });
  return { reviews: s.docs.map((x) => { const r = x.data(); return { id: x.id, entityType: r.entityType || 'provider', entityId: r.entityId || r.providerId, rating: r.rating, text: r.text,
    status: r.status || 'published', reportCount: Number(r.reportCount) || 0, reports: byReview[x.id] || [], sourceRef: r.sourceRef || (r.bookingId ? 'providerBookings/' + r.bookingId : null),
    moderation: r.moderation || null, createdAt: Number(r.createdAtMs) || _ms(r.createdAt) }; }) };
};
/**
 * hide / restore (admin) · remove (super admin). Reason required, audited. The aggregate excludes a
 * hidden / removed review and includes it again on restore — in the same transaction. The booking /
 * order that made the review eligible is NEVER touched.
 */
_adminH.repAdminModerate = async (req) => {
  if (!_isAdmin(req)) fail('permission-denied', 'Admin only.');
  const d = req.data || {};
  const action = String(d.action || '');
  if (!['hide', 'restore', 'remove'].includes(action)) fail('invalid-argument', 'Unknown action.');
  if (action === 'remove' && !_isSuper(req)) fail('permission-denied', 'Removing a review needs a super admin.');
  const reason = _san(d.reason, 500);
  if (reason.length < 5) fail('invalid-argument', 'A reason is required.');
  const rRef = _db().collection(COL.REVIEWS).doc(_san(d.reviewId, 200));
  const pre = (await rRef.get()).data();
  if (!pre) fail('not-found', 'Review not found.');
  const tgt = _target(pre.entityType || 'provider', pre.entityId || pre.providerId);
  const to = action === 'hide' ? REVIEW_STATUS.HIDDEN : action === 'remove' ? REVIEW_STATUS.REMOVED : REVIEW_STATUS.PUBLISHED;
  let from = null;
  await _db().runTransaction(async (txn) => {
    const r = (await txn.get(rRef)).data();
    const e = (await txn.get(tgt.eRef)).data() || {};
    const m = tgt.mirrorRef ? (await txn.get(tgt.mirrorRef)).data() || {} : null;
    from = r.status || REVIEW_STATUS.PUBLISHED;
    if (from === to) return;
    if (from === REVIEW_STATUS.REMOVED) fail('failed-precondition', 'A removed review cannot be changed.');
    const wasCounted = from === REVIEW_STATUS.PUBLISHED; const counted = to === REVIEW_STATUS.PUBLISHED;
    if (wasCounted !== counted) _stageAggregate(txn, tgt, e, m, counted ? 1 : -1, counted ? r.rating : -r.rating, [[r.rating, counted ? 1 : -1]]);
    txn.update(rRef, { status: to, moderation: { action, by: req.auth.uid, reason, at: _now() }, updatedAt: _FV().serverTimestamp() });
  });
  const reps = await _db().collection(COL.REPORTS).where('entityId', '==', rRef.id).limit(100).get().catch(() => ({ docs: [] }));
  for (const x of reps.docs) if (x.data().status === 'pending') await x.ref.update({ status: 'resolved', resolution: action, reviewedBy: req.auth.uid, reviewedAt: _FV().serverTimestamp() }).catch(() => {});
  await _audit({ actor: req.auth.uid, role: _isSuper(req) ? 'superAdmin' : 'admin', action: 'review_' + action, reviewId: rRef.id, from, to, reason });
  try {
    const notify = require('./notify').notify;
    for (const u of [pre.customerUid, pre.providerId]) if (u) await notify({ uid: u, type: 'rep_review_moderated', title: 'Review update', body: action === 'restore' ? 'A review was restored.' : 'A review was hidden after moderation.', dedupeKey: `rep_mod_${rRef.id}_${action}_${u}`, awaitDelivery: false });
  } catch (_) { /* best-effort */ }
  return { ok: true, from, to };
};
_adminH.repAdminEntity = async (req) => {
  if (!_isAdmin(req)) fail('permission-denied', 'Admin only.');
  const d = req.data || {};
  const ent = await loadEntity(_type(d.type), d.id);
  const agg = await aggregateOf(ent.type, ent.id, ent.data);
  const audit = await _db().collection(COL.AUDIT).where('entityId', '==', ent.id).limit(50).get().catch(() => ({ docs: [] }));
  return { type: ent.type, id: ent.id, name: ent.name, ownerUid: ent.ownerUid, isPublic: ent.isPublic, reputation: agg,
    shareCount: typeof ent.data.shareCount === 'number' ? ent.data.shareCount : null, audit: audit.docs.map((x) => x.data()) };
};
/** Super admin: recompute a profile's aggregate from its published reviews and its follow records. */
_adminH.repAdminRecount = async (req) => {
  if (!_isSuper(req)) fail('permission-denied', 'Super admin only.');
  const d = req.data || {};
  const reason = _san(d.reason, 500);
  if (reason.length < 5) fail('invalid-argument', 'A reason is required.');
  const ent = await loadEntity(_type(d.type), d.id);
  const r = await recount(ent.type, ent.id);
  await _audit({ actor: req.auth.uid, role: 'superAdmin', action: 'recount', entityType: ent.type, entityId: ent.id, reason, result: r });
  return r;
};
/** Derive the aggregate from the authoritative records (also used by scripts/migrate-reputation.js). */
async function recount(type, id) {
  let reviews = [];
  if (type !== 'creator') {
    const q = type === 'venue' ? _db().collection(COL.REVIEWS).where('entityId', '==', String(id)) : _db().collection(COL.REVIEWS).where('providerId', '==', String(id));
    const snap = await q.limit(5000).get();
    for (const x of snap.docs) if (!x.data().publicId) await x.ref.set({ publicId: publicReviewId(x.id) }, { merge: true });   /* backfill */
    reviews = snap.docs.map((x) => x.data()).filter((r) => (type === 'venue' ? r.entityType === 'venue' : r.entityType !== 'venue') && (r.status || 'published') === 'published');
  }
  const dist = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }; let sum = 0;
  reviews.forEach((r) => { const x = Math.max(1, Math.min(5, Math.round(Number(r.rating) || 0))); dist[x]++; sum += x; });
  const followers = await _followBase(type, id, null);
  const rating = reviews.length ? Math.round((sum / reviews.length) * 100) / 100 : 0;
  await _ref(type, id).set({ rating, reviewCount: reviews.length, ratingSum: sum, ratingDist: dist, followerCount: followers, repV: REP_VERSION, followV: REP_VERSION, reputationUpdatedAt: _FV().serverTimestamp() }, { merge: true });
  if (type === 'provider') await _db().collection('providerProfiles').doc(String(id)).set({ rating, reviewCount: reviews.length, ratingSum: sum }, { merge: true });
  return { rating: reviews.length ? rating : null, reviewCount: reviews.length, ratingDist: dist, followerCount: followers };
}

module.exports = { COL, TYPES, REPORT_REASONS, REVIEW_STATUS, POLICY, _h, _adminH, publicReviewId, shareLink,
  followId, publicName, eligibility, submitReview, aggregateOf, recount, loadEntity,
  _setClock: (fn) => { _now = fn || (() => Date.now()); } };
