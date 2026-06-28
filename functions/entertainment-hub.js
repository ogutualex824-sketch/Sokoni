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
  await ref.set({
    listingId: ref.id, creatorUid: uid,
    title: san(title, 150), description: san(description, 3000),
    category, entType,
    price: entType === 'free' ? 0 : (parseFloat(price) || 0),
    currency: currency === 'USD' ? 'USD' : 'KES',
    thumbnailUrl: san(thumbnailUrl, 500),
    trailerUrl: san(trailerUrl, 500),
    streamingUrl: san(streamingUrl, 500), // only revealed after purchase
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

  if (listing.entType === 'free') {
    // Free content — just log access
    const ref = db().collection('entertainmentPurchases').doc();
    await ref.set({
      purchaseId: ref.id, buyerUid: uid, listingId,
      price: 0, currency: listing.currency, status: 'completed',
      idempotencyKey, createdAt: FieldValue.serverTimestamp(),
    });
    return { purchaseId: ref.id, streamingUrl: listing.streamingUrl, status: 'completed' };
  }

  const existing = await db().collection('entertainmentPurchases')
    .where('buyerUid', '==', uid).where('listingId', '==', listingId)
    .where('status', '==', 'completed').limit(1).get();
  if (!existing.empty) return { purchaseId: existing.docs[0].id, alreadyOwned: true };

  const platformFee = Math.round(listing.price * 0.15 * 100) / 100; // 15% on PPV
  const ref = db().collection('entertainmentPurchases').doc();
  await db().runTransaction(async t => {
    t.set(ref, {
      purchaseId: ref.id, buyerUid: uid, listingId,
      creatorUid: listing.creatorUid, title: listing.title,
      price: listing.price, currency: listing.currency,
      platformFee, creatorAmount: listing.price - platformFee,
      status: 'pending_payment', idempotencyKey,
      createdAt: FieldValue.serverTimestamp(),
    });
    t.update(db().collection('entertainmentListings').doc(listingId), {
      purchaseCount: FieldValue.increment(1), updatedAt: FieldValue.serverTimestamp(),
    });
    t.set(idemRef, { purchaseId: ref.id, createdAt: FieldValue.serverTimestamp() });
  });
  return { purchaseId: ref.id, status: 'pending_payment', price: listing.price };
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
  if (rating < 1 || rating > 5) throw new HttpsError('invalid-argument', 'Rating 1–5');

  await db().runTransaction(async t => {
    const ref = db().collection('entertainmentListings').doc(listingId);
    const snap = await t.get(ref);
    if (!snap.exists) throw new HttpsError('not-found', 'Content not found');
    const l = snap.data();
    const newCount = l.contentRatingCount + 1;
    const newRating = ((l.contentRating * l.contentRatingCount) + rating) / newCount;
    t.update(ref, {
      contentRating: Math.round(newRating * 10) / 10,
      contentRatingCount: newCount, updatedAt: FieldValue.serverTimestamp(),
    });
    const reviewRef = db().collection('entertainmentReviews').doc();
    t.set(reviewRef, {
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
  const totalRevenue = listings.reduce((s, l) => s + ((l.price || 0) * (l.purchaseCount || 0)), 0);
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
