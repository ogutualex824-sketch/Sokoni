/* ============================================================
   SOKONI — hub reviews client (owner 2026-10-03)
   window.SokoniHubReviews

   ONE client for property and sports-venue reviews. Pages never write a review
   to Firestore or to localStorage any more. They REQUEST one:

     page → submitReview({ targetType, targetId, rating, body })   (Cloud Function)
          → server: signed-in identity, eligibility (a viewing / booking in
            YOUR name for this target), duplicate, rate limit
          → reviews/{uid_targetType_targetId}  status: 'pending'
          → AdminOS moderation queue → approved → getReviews (public)

   HONEST STATE ONLY:
     submit() resolves { ok:true, status:'pending' } ONLY when the server answered
     with a review id and status 'pending'. Anything else is { ok:false, reason,
     message }: the page must show it, never "Review submitted".
     load() resolves { ok:true, reviews } (approved only) or { ok:false }: a failed
     read is UNKNOWN, never "no reviews".

   The browser sends no name, no author, no uid, no status. The server derives
   the display name from the account.
============================================================ */
;(function () {
'use strict';

const TYPES = ['property', 'sports_venue'];
const MESSAGES = {
  NOT_SIGNED_IN:      'Sign in to leave a review.',
  NOT_ELIGIBLE:       'Only customers with a viewing or booking for this listing can review it.',
  DUPLICATE:          'You have already reviewed this. Your review is with our moderators.',
  RATE_LIMITED:       'Too many reviews in a short time. Please try again later.',
  UNSUPPORTED_TARGET: 'Reviews are not available here yet.',
  BAD_RATING:         'Please choose a rating from 1 to 5 stars.',
  BAD_BODY:           'Please write between 10 and 2000 characters.',
  UNAVAILABLE:        'Reviews are unavailable right now. Please try again.',
  UNCONFIRMED:        'We could not confirm your review was received. Please try again.',
};
const msg = (reason) => MESSAGES[reason] || MESSAGES.UNAVAILABLE;

function _ready () {
  if (typeof window.waitForFirebaseReady === 'function') {
    return Promise.race([window.waitForFirebaseReady(), new Promise((r) => setTimeout(r, 8000))]);
  }
  return Promise.resolve();
}

/* Test seam only (scripts/test-hub-review-clients.js): replaces the network call, nothing else. */
let _caller = null;
async function _call (name, data) {
  if (_caller) return _caller(name, data);
  await _ready();
  if (!window.firebaseApp) throw Object.assign(new Error('firebase unavailable'), { code: 'unavailable' });
  const mod = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js');
  const res = await mod.httpsCallable(mod.getFunctions(window.firebaseApp, 'us-central1'), name)(data);
  return res && res.data;
}

function _reasonOf (e) {
  const r = e && e.details && e.details.reason;
  if (r && MESSAGES[r]) return r;
  const c = String((e && e.code) || '').replace(/^functions\//, '');
  if (c === 'unauthenticated') return 'NOT_SIGNED_IN';
  if (c === 'resource-exhausted') return 'RATE_LIMITED';
  if (c === 'already-exists') return 'DUPLICATE';
  if (c === 'failed-precondition' || c === 'permission-denied') return 'NOT_ELIGIBLE';
  return 'UNAVAILABLE';
}

/** submit({ targetType, targetId, rating, body }) → { ok:true, status:'pending', reviewId } | { ok:false, reason, message } */
async function submit (input) {
  const i = input || {};
  const fail = (reason) => ({ ok: false, reason, message: msg(reason) });
  if (!TYPES.includes(i.targetType) || !i.targetId) return fail('UNSUPPORTED_TARGET');
  const rating = Number(i.rating);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) return fail('BAD_RATING');
  const body = String(i.body == null ? '' : i.body).trim();
  if (body.length < 10 || body.length > 2000) return fail('BAD_BODY');
  await _ready();
  if (!(window.firebaseAuth && window.firebaseAuth.currentUser)) return fail('NOT_SIGNED_IN');
  let res;
  try {
    res = await _call('submitReview', { targetType: i.targetType, targetId: String(i.targetId), rating, body });
  } catch (e) {
    return fail(_reasonOf(e));
  }
  if (!res || res.status !== 'pending' || !res.reviewId) return fail('UNCONFIRMED');
  return { ok: true, status: 'pending', reviewId: res.reviewId };
}

/** load(targetType, targetId) → { ok:true, reviews:[approved…] } | { ok:false } */
async function load (targetType, targetId) {
  if (!TYPES.includes(targetType) || !targetId) return { ok: false };
  try {
    const res = await _call('getReviews', { targetType, targetId: String(targetId), sort: 'recent', limit: 20 });
    return { ok: true, reviews: (res && Array.isArray(res.reviews)) ? res.reviews : [] };
  } catch (_) {
    return { ok: false };
  }
}

/** Average of LOADED approved reviews, or null when unknown / none (render "—", never an invented figure). */
function average (reviews) {
  const r = (reviews || []).map((x) => Number(x.rating)).filter((n) => n >= 1 && n <= 5);
  return r.length ? (r.reduce((a, b) => a + b, 0) / r.length) : null;
}

window.SokoniHubReviews = { submit, load, average, message: msg, TYPES, _setCaller: (fn) => { _caller = fn; } };
})();
