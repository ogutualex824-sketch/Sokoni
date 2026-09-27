'use strict';
/**
 * Entertainment Hub v1.0 — SOKONI Platform
 * Entertainment listings: streaming, movies, shows, comedy, live performances
 * 9 Cloud Functions | enforceAppCheck: true | region: us-central1
 */

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const admin = require('firebase-admin');

const REGION = 'us-central1';
const CF_OPTS = { region: REGION, enforceAppCheck: true };
const db = () => admin.firestore();
const auth = () => admin.auth();
const FieldValue = admin.firestore.FieldValue;

function requireAuth(req) {
  if (!req.auth) throw new HttpsError('unauthenticated', 'Authentication required');
  return req.auth.uid;
}
async function getRole(uid) {
  const tok = await auth().getUser(uid);
  return (tok.customClaims || {}).role || 0;
}
function san(s, max = 200) { return s == null ? '' : String(s).trim().slice(0, max); }

const ENT_CATEGORIES = [
  'movie', 'series', 'documentary', 'comedy_show', 'music_video', 'podcast',
  'live_performance', 'sports_highlight', 'animation', 'short_film', 'other',
];

const ENT_TYPES = ['free', 'ppv', 'subscription'];

/* ── 1. createEntertainmentListing ── */
exports.createEntertainmentListing = onCall(CF_OPTS, async (req) => {
  const uid = requireAuth(req);
  const role = await getRole(uid);
  if (role < 2) throw new HttpsError('permission-denied', 'Creator/seller role required');

  const {
    title, description, category, entType, price, currency,
    thumbnailUrl, trailerUrl, streamingUrl,
    duration, releaseYear, genre, language, rating,
    cast, tags, ageRating,
  } = req.data;

  if (!title || !category || !entType) {
    throw new HttpsError('invalid-argument', 'title, category, entType required');
  }
  if (!ENT_CATEGORIES.includes(category)) throw new HttpsError('invalid-argument', 'Invalid category');
  if (!ENT_TYPES.includes(entType)) throw new HttpsError('invalid-argument', 'Invalid entType');
  if (entType === 'ppv' && !price) throw new HttpsError('invalid-argument', 'Price required for ppv type');

  const ref = db().collection('entertainmentListings').doc();
  /* The stream URL is a SECRET: entertainmentListings is publicly readable when
     active (firestore.rules), so a URL on the listing doc was readable by anyone
     regardless of purchase. It lives in a server-only sidecar instead. */
  await db().collection('entertainmentListingSecrets').doc(ref.id).set({
    listingId: ref.id, streamingUrl: san(streamingUrl, 500), updatedAt: FieldValue.serverTimestamp(),
  });
  await ref.set({
    listingId: ref.id, creatorUid: uid,
    title: san(title, 150), description: san(description, 3000),
    category, entType,
    price: entType === 'free' ? 0 : (parseFloat(price) || 0),
    currency: currency === 'USD' ? 'USD' : 'KES',
    thumbnailUrl: san(thumbnailUrl, 500),
    trailerUrl: san(trailerUrl, 500),
    duration: parseInt(duration) || null, // minutes
    releaseYear: parseInt(releaseYear) || null,
    genre: san(genre, 60), language: san(language, 60) || 'English',
    rating: san(rating, 10), // BBFC/KFCB rating e.g. PG-13
    cast: Array.isArray(cast) ? cast.slice(0, 10).map(c => san(c, 80)) : [],
    tags: Array.isArray(tags) ? tags.slice(0, 10).map(t => san(t, 30)) : [],
    ageRating: ['G', 'PG', 'PG-13', '15', '18', 'R', 'NC-17'].includes(ageRating) ? ageRating : 'PG',
    status: 'draft',
    viewCount: 0, purchaseCount: 0, likeCount: 0,
    contentRating: 0, contentRatingCount: 0,
    createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
  });
  return { listingId: ref.id, status: 'draft' };
});

/* ── 2. publishEntertainmentListing ── */
exports.publishEntertainmentListing = onCall(CF_OPTS, async (req) => {
  const uid = requireAuth(req);
  const { listingId } = req.data;
  if (!listingId) throw new HttpsError('invalid-argument', 'listingId required');

  const ref = db().collection('entertainmentListings').doc(listingId);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Listing not found');
  /* Creator Hub films publish only through review (creator-hub.js). This legacy
     self-publish would otherwise make an unreviewed draft public. */
  if (snap.data().creatorHub === true) throw new HttpsError('failed-precondition', 'Creator Hub films are published through review.');
  const role = await getRole(uid);
  if (snap.data().creatorUid !== uid && role < 4) throw new HttpsError('permission-denied', 'Not authorized');

  await ref.update({ status: 'active', publishedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
  return { ok: true };
});

/* ── 3. getEntertainmentListing ── */
exports.getEntertainmentListing = onCall(CF_OPTS, async (req) => {
  const uid = req.auth?.uid;
  const { listingId } = req.data;
  if (!listingId) throw new HttpsError('invalid-argument', 'listingId required');

  const snap = await db().collection('entertainmentListings').doc(listingId).get();
  if (!snap.exists || snap.data().status !== 'active') throw new HttpsError('not-found', 'Not found');
  const listing = { ...snap.data() };
  delete listing.streamingUrl;   /* legacy docs may still carry it; the sidecar is the source */
  if (listing.creatorHub === true) {
    /* Creator Hub films never carry a URL: playback is a short-lived signed
       grant from creatorDispatch playback.authorize. */
    return listing;
  }
  const _secret = await db().collection('entertainmentListingSecrets').doc(listingId).get();
  listing.streamingUrl = _secret.exists ? _secret.data().streamingUrl : (snap.data().streamingUrl || '');

  // Only reveal streaming URL for free content or after purchase
  if (listing.entType !== 'free' && uid) {
    const purchaseSnap = await db().collection('entertainmentPurchases')
      .where('buyerUid', '==', uid).where('listingId', '==', listingId)
      .where('status', '==', 'completed').limit(1).get();
    if (purchaseSnap.empty) delete listing.streamingUrl;
  } else if (listing.entType !== 'free') {
    delete listing.streamingUrl;
  }

  db().collection('entertainmentListings').doc(listingId).update({ viewCount: FieldValue.increment(1) }).catch(() => {});
  return listing;
});

/* ── 4. listEntertainmentContent ── */
exports.listEntertainmentContent = onCall(CF_OPTS, async (req) => {
  const { category, entType, genre, limit = 24, cursor } = req.data;

  let q = db().collection('entertainmentListings')
    .where('status', '==', 'active')
    .orderBy('viewCount', 'desc')
    .limit(Math.min(50, parseInt(limit) || 24));

  if (category && ENT_CATEGORIES.includes(category)) {
    q = db().collection('entertainmentListings')
      .where('status', '==', 'active')
      .where('category', '==', category)
      .orderBy('viewCount', 'desc')
      .limit(Math.min(50, parseInt(limit) || 24));
  } else if (entType && ENT_TYPES.includes(entType)) {
    q = db().collection('entertainmentListings')
      .where('status', '==', 'active')
      .where('entType', '==', entType)
      .orderBy('viewCount', 'desc')
      .limit(Math.min(50, parseInt(limit) || 24));
  }

  if (cursor) {
    const c = await db().collection('entertainmentListings').doc(cursor).get();
    if (c.exists) q = q.startAfter(c);
  }

  const snap = await q.get();
  let listings = snap.docs.map(d => {
    const l = d.data();
    return { listingId: l.listingId, title: l.title, category: l.category,
      entType: l.entType, price: l.price, currency: l.currency,
      thumbnailUrl: l.thumbnailUrl, trailerUrl: l.trailerUrl,
      duration: l.duration, genre: l.genre, language: l.language,
      releaseYear: l.releaseYear, ageRating: l.ageRating, cast: (l.cast || []).slice(0, 3),
      viewCount: l.viewCount, contentRating: l.contentRating, purchaseCount: l.purchaseCount };
  });

  if (genre) listings = listings.filter(l => (l.genre || '').toLowerCase().includes(genre.toLowerCase()));

  const nextCursor = snap.docs.length === Math.min(50, parseInt(limit) || 24)
    ? snap.docs[snap.docs.length - 1].id : null;
  return { listings, nextCursor };
});

/* ── 5. searchEntertainment ── */
exports.searchEntertainment = onCall(CF_OPTS, async (req) => {
  const { query, limit = 20 } = req.data;
  if (!query) throw new HttpsError('invalid-argument', 'query required');
  const q = query.toLowerCase();
  const snap = await db().collection('entertainmentListings')
    .where('status', '==', 'active').orderBy('viewCount', 'desc').limit(200).get();
  const results = snap.docs.map(d => d.data())
    .filter(l =>
      l.title.toLowerCase().includes(q) ||
      (l.description || '').toLowerCase().includes(q) ||
      (l.genre || '').toLowerCase().includes(q) ||
      (l.cast || []).some(c => c.toLowerCase().includes(q)) ||
      (l.tags || []).some(t => t.toLowerCase().includes(q))
    )
    .slice(0, Math.min(40, parseInt(limit) || 20))
    .map(l => ({ listingId: l.listingId, title: l.title, category: l.category,
      entType: l.entType, price: l.price, thumbnailUrl: l.thumbnailUrl, viewCount: l.viewCount }));
  return { results };
});

/* ── 6. purchaseEntertainment (PPV) ── */
exports.purchaseEntertainment = onCall(CF_OPTS, async (req) => {
  const uid = requireAuth(req);
  const { listingId, idempotencyKey } = req.data;
  if (!listingId || !idempotencyKey) throw new HttpsError('invalid-argument', 'listingId and idempotencyKey required');

  const idemRef = db().collection('entertainmentPurchaseIdempotency').doc(idempotencyKey);
  if ((await idemRef.get()).exists) return { purchaseId: (await idemRef.get()).data().purchaseId, idempotent: true };

  const snap = await db().collection('entertainmentListings').doc(listingId).get();
  if (!snap.exists || snap.data().status !== 'active') throw new HttpsError('not-found', 'Content not found');
  const listing = snap.data();
  if (listing.creatorHub === true) throw new HttpsError('failed-precondition', 'Buy Creator Hub films through checkout (film_access).');

  if (listing.entType === 'free') {
    const _sec = await db().collection('entertainmentListingSecrets').doc(listingId).get();
    listing.streamingUrl = _sec.exists ? _sec.data().streamingUrl : (listing.streamingUrl || '');
    // Free content — just log access
    const ref = db().collection('entertainmentPurchases').doc();
    await ref.set({
      purchaseId: ref.id, buyerUid: uid, listingId,
      price: 0, currency: listing.currency, status: 'completed',
      idempotencyKey, createdAt: FieldValue.serverTimestamp(),
    });
    return { purchaseId: ref.id, streamingUrl: listing.streamingUrl, status: 'completed' };
  }

  /* PAID LEGACY LISTINGS ARE CLOSED (Entertainment convergence, 2026-09-26).
     This wrote an entertainmentPurchases doc at 'pending_payment' and incremented purchaseCount
     BEFORE any payment — and no payment purpose, webhook branch or entitlement adapter ever
     completed it, so a buyer could never receive the content and the listing's counters (and the
     creator dashboard's revenue) counted sales that never happened. Paid entertainment is sold
     through Creator Hub (purpose film_access: server price, capability-gated checkout, entitlement,
     30 / 70 royalty ledger). Production held ZERO entertainmentListings / entertainmentPurchases
     when this was closed (read-only count 2026-09-26), so nothing live depended on it. */
  throw new HttpsError('failed-precondition',
    'Paid entertainment is sold through Creator Hub. This listing cannot be purchased here.');
});

/* ── 7. getMyEntertainmentPurchases ── */
exports.getMyEntertainmentPurchases = onCall(CF_OPTS, async (req) => {
  const uid = requireAuth(req);
  const snap = await db().collection('entertainmentPurchases')
    .where('buyerUid', '==', uid)
    .orderBy('createdAt', 'desc').limit(50).get();
  return { purchases: snap.docs.map(d => d.data()) };
});

/* ── 8. rateEntertainmentContent ── */
exports.rateEntertainmentContent = onCall(CF_OPTS, async (req) => {
  const uid = requireAuth(req);
  const { listingId, rating, review } = req.data;
  if (!listingId || !rating) throw new HttpsError('invalid-argument', 'listingId and rating required');
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(String(listingId))) throw new HttpsError('invalid-argument', 'listingId is invalid');
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) throw new HttpsError('invalid-argument', 'Rating 1–5');

  /* 2026-09-27 (readiness sweep): any signed-in account could post UNLIMITED ratings on any listing —
     including Creator Hub films, which live in this collection — and move its public score at will.
     Now: one rating per viewer per listing (deterministic id, create-once), and only from a viewer who
     actually has access: a Creator Hub film through contentAccess, a legacy listing through a purchase. */
  const reviewRef = db().collection('entertainmentReviews').doc(`${listingId}_${uid}`);
  await db().runTransaction(async t => {
    const ref = db().collection('entertainmentListings').doc(listingId);
    const snap = await t.get(ref);
    if (!snap.exists) throw new HttpsError('not-found', 'Content not found');
    const l = snap.data();
    const prior = await t.get(reviewRef);
    if (prior.exists) throw new HttpsError('already-exists', 'You have already rated this.');
    const access = l.creatorHub === true
      ? await t.get(db().collection('contentAccess').doc(`${uid}_${listingId}`))
      : await t.get(db().collection('entertainmentPurchases').where('buyerUid', '==', uid).where('listingId', '==', listingId).limit(1));
    const has = l.creatorHub === true ? access.exists : !access.empty;
    if (!has) throw new HttpsError('permission-denied', 'Only viewers who have watched this can rate it.');
    const prevCount = Number(l.contentRatingCount) || 0;
    const newCount = prevCount + 1;
    const newRating = (((Number(l.contentRating) || 0) * prevCount) + rating) / newCount;
    t.update(ref, {
      contentRating: Math.round(newRating * 10) / 10,
      contentRatingCount: newCount, updatedAt: FieldValue.serverTimestamp(),
    });
    t.create(reviewRef, {
      reviewId: reviewRef.id, listingId, reviewerUid: uid,
      rating, review: san(review, 500), createdAt: FieldValue.serverTimestamp(),
    });
  });
  return { ok: true };
});

/* ── 9. getCreatorDashboard ── */
exports.getCreatorDashboard = onCall(CF_OPTS, async (req) => {
  const uid = requireAuth(req);
  const snap = await db().collection('entertainmentListings')
    .where('creatorUid', '==', uid).orderBy('createdAt', 'desc').limit(100).get();
  const listings = snap.docs.map(d => d.data());
  const totalViews = listings.reduce((s, l) => s + (l.viewCount || 0), 0);
  /* Revenue from COMPLETED purchases only — the canonical record of money received. It used to be
     price × purchaseCount, and purchaseCount was incremented for purchases that were never paid:
     a fabricated figure (CLAUDE.md UI Data Integrity). A capped read reports null ("unknown"),
     never a truncated sum. */
  const CAP = 1000;
  const paidSnap = await db().collection('entertainmentPurchases')
    .where('creatorUid', '==', uid).where('status', '==', 'completed').limit(CAP).get();
  const totalRevenue = paidSnap.size >= CAP ? null
    : paidSnap.docs.reduce((s, d) => s + (Number(d.data().price) || 0), 0);
  return {
    totalListings: listings.length,
    active: listings.filter(l => l.status === 'active').length,
    totalViews, totalRevenue,
    listings: listings.map(l => ({
      listingId: l.listingId, title: l.title, category: l.category,
      entType: l.entType, status: l.status,
      viewCount: l.viewCount, purchaseCount: l.purchaseCount,
      contentRating: l.contentRating,
    })),
  };
});

module.exports = {
  createEntertainmentListing:  exports.createEntertainmentListing,
  publishEntertainmentListing: exports.publishEntertainmentListing,
  getEntertainmentListing:     exports.getEntertainmentListing,
  listEntertainmentContent:    exports.listEntertainmentContent,
  searchEntertainment:         exports.searchEntertainment,
  purchaseEntertainment:       exports.purchaseEntertainment,
  getMyEntertainmentPurchases: exports.getMyEntertainmentPurchases,
  rateEntertainmentContent:    exports.rateEntertainmentContent,
  getCreatorDashboard:         exports.getCreatorDashboard,
};
