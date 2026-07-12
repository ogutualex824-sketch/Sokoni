'use strict';
/**
 * SOKONI Provider Ops — post-onboarding dashboard + service management handlers.
 *
 * Fills the gaps left by provider-onboarding.js (which owns onboarding/publish):
 *   • 7 dashboard handlers the Provider Dashboard already calls but that did not
 *     exist (bookings actions, earnings, payout, reviews).
 *   • Subscription COMMISSION enforcement — applied at booking completion, the
 *     one place real money is computed (rate read from providerSubscriptions).
 *   • LISTINGS-LIMIT enforcement — providerServices respects plan limits.listings.
 *   • Creates the 4 collections the onboarding module only named in a comment:
 *     providerPortfolio, providerServices, providerCalendar, providerAnalytics.
 *
 * All ops route through providerDispatch — ZERO new Cloud Run services.
 * Every op requires auth and verifies resource ownership (providerId === uid).
 */

const { HttpsError }               = require('firebase-functions/v2/https');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const logger                       = require('firebase-functions/logger');

const _db  = () => getFirestore();
const _ts  = () => FieldValue.serverTimestamp();
const _inc = (n) => FieldValue.increment(n);
const _san = (v, n = 500) => String(v == null ? '' : v).slice(0, n).replace(/[<>]/g, '');

function _uid(req) {
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Authentication required.');
  return uid;
}

/* Default commission if a provider somehow has no subscription doc (free-trial rate). */
const _DEFAULT_COMMISSION = 0.20;

/* Read the provider's effective commission rate from their live subscription. */
async function _commissionRate(uid) {
  const snap = await _db().collection('providerSubscriptions').doc(uid).get();
  const rate = snap.exists ? Number(snap.data().commissionRate) : NaN;
  return Number.isFinite(rate) && rate >= 0 && rate <= 1 ? rate : _DEFAULT_COMMISSION;
}

/* Load a booking and assert the caller owns it. Returns {ref, data}. */
async function _ownBooking(uid, bookingId) {
  const id = _san(bookingId, 128);
  if (!id) throw new HttpsError('invalid-argument', 'bookingId is required.');
  const ref  = _db().collection('providerBookings').doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Booking not found.');
  const data = snap.data();
  if (data.providerId !== uid) throw new HttpsError('permission-denied', 'Not your booking.');
  return { ref, data };
}

const _h = {};
exports._h = _h;

/* ── 1. providerConfirmBooking ───────────────────────────────────────────────
   pending → confirmed. Also mirrors the slot into providerCalendar. */
_h.providerConfirmBooking = async (req) => {
  const uid = _uid(req);
  const { ref, data } = await _ownBooking(uid, req.data?.bookingId);
  if (!['pending', 'requested'].includes(data.status)) {
    throw new HttpsError('failed-precondition', `Cannot confirm a booking that is "${data.status}".`);
  }
  const batch = _db().batch();
  batch.update(ref, { status: 'confirmed', confirmedAt: _ts(), updatedAt: _ts() });
  // providerCalendar — busy slot (idempotent doc id = booking id)
  batch.set(_db().collection('providerCalendar').doc(ref.id), {
    providerId: uid, bookingId: ref.id, status: 'busy',
    scheduledAt: data.scheduledAt || null, service: _san(data.service, 200),
    customerName: _san(data.customerName, 200), createdAt: _ts(),
  }, { merge: true });
  await batch.commit();
  return { success: true, status: 'confirmed' };
};

/* ── 2. providerDeclineBooking ───────────────────────────────────────────────
   pending → declined. Frees any calendar hold. */
_h.providerDeclineBooking = async (req) => {
  const uid = _uid(req);
  const { ref, data } = await _ownBooking(uid, req.data?.bookingId);
  if (['completed', 'cancelled'].includes(data.status)) {
    throw new HttpsError('failed-precondition', `Cannot decline a "${data.status}" booking.`);
  }
  const batch = _db().batch();
  batch.update(ref, { status: 'declined', declinedAt: _ts(), updatedAt: _ts(),
    declineReason: _san(req.data?.reason, 300) || null });
  batch.delete(_db().collection('providerCalendar').doc(ref.id));
  await batch.commit();
  return { success: true, status: 'declined' };
};

/* ── 3. providerCompleteBooking ──────────────────────────────────────────────
   confirmed/in_progress → completed. Computes commission from the provider's
   subscription and writes a pending providerPayouts entry + analytics rollup.
   This is the enforcement point for commissionRate. Idempotent per booking. */
_h.providerCompleteBooking = async (req) => {
  const uid = _uid(req);
  const { ref, data } = await _ownBooking(uid, req.data?.bookingId);
  if (data.status === 'completed') return { success: true, status: 'completed', alreadyDone: true };
  if (!['confirmed', 'in_progress', 'pending'].includes(data.status)) {
    throw new HttpsError('failed-precondition', `Cannot complete a "${data.status}" booking.`);
  }

  const gross      = Math.max(0, Math.round(Number(data.price) || 0)); // cents
  const rate       = await _commissionRate(uid);
  const commission = Math.round(gross * rate);
  const net        = gross - commission;
  const dayKey     = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

  const batch = _db().batch();
  batch.update(ref, { status: 'completed', completedAt: _ts(), updatedAt: _ts() });

  // Earnings ledger entry (deterministic id = booking id → idempotent, no double pay)
  batch.set(_db().collection('providerPayouts').doc(ref.id), {
    providerId: uid, bookingId: ref.id, gross, commission, commissionRate: rate,
    net, amount: net, currency: 'KES', method: null, reference: null,
    status: 'pending', createdAt: _ts(),
  }, { merge: true });

  // Profile counters
  batch.set(_db().collection('providerProfiles').doc(uid),
    { bookingCount: _inc(1), lifetimeGrossKes: _inc(gross), updatedAt: _ts() }, { merge: true });

  // providerAnalytics — daily rollup (id = uid_YYYY-MM-DD)
  batch.set(_db().collection('providerAnalytics').doc(`${uid}_${dayKey}`), {
    providerId: uid, date: dayKey, bookingsCompleted: _inc(1),
    grossCents: _inc(gross), commissionCents: _inc(commission), netCents: _inc(net),
    updatedAt: _ts(),
  }, { merge: true });

  await batch.commit();
  logger.info('providerCompleteBooking', { uid, bookingId: ref.id, gross, commission, net });
  return { success: true, status: 'completed', gross, commission, net };
};

/* ── 4. providerGetEarnings ──────────────────────────────────────────────────
   Aggregates providerPayouts over `days`. All amounts in cents. */
_h.providerGetEarnings = async (req) => {
  const uid  = _uid(req);
  const days = Math.min(365, Math.max(1, Number(req.data?.days) || 30));
  const since = new Date(Date.now() - days * 86400000);

  // Single-field equality (auto-indexed) + in-memory date filter → no composite index.
  const snap = await _db().collection('providerPayouts')
    .where('providerId', '==', uid).limit(2000).get();

  let gross = 0, commission = 0, net = 0, pending = 0, paid = 0;
  const byDay = {};
  const payouts = [];
  for (const doc of snap.docs) {
    const p = doc.data();
    const created = p.createdAt?.toDate ? p.createdAt.toDate() : null;
    if (created && created < since) continue;
    gross += p.gross || 0; commission += p.commission || 0; net += p.net || 0;
    if (p.status === 'paid') paid += p.net || 0; else pending += p.net || 0;
    const d = p.createdAt?.toDate ? p.createdAt.toDate() : new Date();
    const k = d.toISOString().slice(5, 10); // MM-DD
    byDay[k] = (byDay[k] || 0) + (p.net || 0);
    if (p.status !== 'pending') {
      payouts.push({ id: doc.id, net: p.net || 0, method: p.method || null,
        reference: p.reference || null, status: p.status, createdAt: p.createdAt || null });
    }
  }
  const dailyRevenue = Object.keys(byDay).sort().map((date) => ({ date, net: byDay[date] }));
  return { gross, commission, net, pending, paid, dailyRevenue,
    payouts: payouts.sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0)).slice(0, 20),
    currency: 'KES', days };
};

/* ── 5. providerRequestPayout ────────────────────────────────────────────────
   Moves all pending earnings to "requested" (settled by the payout scheduler). */
_h.providerRequestPayout = async (req) => {
  const uid = _uid(req);
  const snap = await _db().collection('providerPayouts')
    .where('providerId', '==', uid).limit(600).get();
  const pending = snap.docs.filter((d) => d.data().status === 'pending');
  if (!pending.length) throw new HttpsError('failed-precondition', 'No pending earnings to pay out.');

  const reference = `PO-${uid.slice(0, 6).toUpperCase()}-${new Date().toISOString().slice(0, 10)}`;
  let total = 0;
  const batch = _db().batch();
  pending.forEach((d) => { total += d.data().net || 0;
    batch.update(d.ref, { status: 'requested', payoutRef: reference, requestedAt: _ts() }); });
  await batch.commit();
  return { success: true, reference, amount: total, count: pending.length, currency: 'KES' };
};

/* ── 6. providerGetReviews ───────────────────────────────────────────────────
   Reviews + rating distribution for the caller's profile. */
_h.providerGetReviews = async (req) => {
  const uid = _uid(req);
  // Single-field equality (auto-indexed) + in-memory sort → no composite index.
  const snap = await _db().collection('providerReviews')
    .where('providerId', '==', uid).limit(200).get();

  const distribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  let sum = 0;
  const reviews = snap.docs.map((d) => {
    const r = d.data();
    const rating = Math.max(1, Math.min(5, Math.round(Number(r.rating) || 0)));
    distribution[rating] = (distribution[rating] || 0) + 1;
    sum += rating;
    return { id: d.id, customerName: _san(r.customerName, 120) || 'Customer',
      rating, text: _san(r.text, 1000), reply: r.reply ? _san(r.reply, 1000) : null,
      createdAt: r.createdAt || null,
      _sort: r.createdAt?.toDate ? r.createdAt.toDate().getTime() : 0 };
  }).sort((a, b) => b._sort - a._sort).map(({ _sort, ...r }) => r);
  const total = reviews.length;
  return { total, averageRating: total ? sum / total : 0, distribution, reviews };
};

/* ── 7. providerReplyReview ──────────────────────────────────────────────────
   Provider replies to a review on their own profile. */
_h.providerReplyReview = async (req) => {
  const uid   = _uid(req);
  const id    = _san(req.data?.reviewId, 128);
  const reply = _san(req.data?.reply, 1000).trim();
  if (!id)    throw new HttpsError('invalid-argument', 'reviewId is required.');
  if (!reply) throw new HttpsError('invalid-argument', 'reply text is required.');
  const ref  = _db().collection('providerReviews').doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Review not found.');
  if (snap.data().providerId !== uid) throw new HttpsError('permission-denied', 'Not your review.');
  await ref.update({ reply, repliedAt: _ts(), updatedAt: _ts() });
  return { success: true };
};

/* ── 8. providerSavePortfolio ────────────────────────────────────────────────
   Persists portfolio items (step 11). Creates providerPortfolio. Client uploads
   media to Storage first and passes the resulting URLs. */
_h.providerSavePortfolio = async (req) => {
  const uid   = _uid(req);
  const d     = req.data || {};
  const clamp = (arr, n, len) => (Array.isArray(arr) ? arr.slice(0, n).map((x) => _san(x, len)) : []);
  await _db().collection('providerPortfolio').doc(uid).set({
    providerId: uid,
    images:    clamp(d.images, 30, 600),
    videos:    clamp(d.videos, 10, 600),
    projects:  Array.isArray(d.projects) ? d.projects.slice(0, 30).map((p) => ({
      title: _san(p?.title, 200), description: _san(p?.description, 1000), url: _san(p?.url, 600),
    })) : [],
    certificates: clamp(d.certificates, 20, 600),
    documents:    clamp(d.documents, 20, 600),
    website:  _san(d.website, 300),
    socials:  (d.socials && typeof d.socials === 'object') ? {
      facebook: _san(d.socials.facebook, 300), instagram: _san(d.socials.instagram, 300),
      twitter:  _san(d.socials.twitter, 300),  linkedin:  _san(d.socials.linkedin, 300),
      tiktok:   _san(d.socials.tiktok, 300),   youtube:   _san(d.socials.youtube, 300),
    } : {},
    updatedAt: _ts(),
  }, { merge: true });
  // Reflect completeness on the profile so dashboard profileCompletion counts it.
  await _db().collection('providerProfiles').doc(uid)
    .set({ portfolio: clamp(d.images, 30, 600), updatedAt: _ts() }, { merge: true });
  return { success: true };
};

/* ── 9. providerGetPortfolio ─────────────────────────────────────────────────*/
_h.providerGetPortfolio = async (req) => {
  const uid  = _uid(req);
  const snap = await _db().collection('providerPortfolio').doc(uid).get();
  return { portfolio: snap.exists ? snap.data() : null };
};

/* ── 10. providerAddService — enforces plan limits.listings ──────────────────
   Creates providerServices; a provider cannot exceed their subscription's
   listing cap (-1 = unlimited). This is the listings-limit enforcement point. */
_h.providerAddService = async (req) => {
  const uid = _uid(req);
  const d   = req.data || {};
  const name = _san(d.name, 200).trim();
  if (!name) throw new HttpsError('invalid-argument', 'Service name is required.');

  const [subSnap, svcSnap] = await Promise.all([
    _db().collection('providerSubscriptions').doc(uid).get(),
    _db().collection('providerServices').where('providerId', '==', uid).limit(200).get(),
  ]);
  const activeCount = svcSnap.docs.filter((d) => d.data().active !== false).length;
  const cap = subSnap.exists ? Number(subSnap.data().limits?.listings) : 1;
  if (cap !== -1 && activeCount >= cap) {
    throw new HttpsError('resource-exhausted',
      `Your plan allows ${cap} active service${cap === 1 ? '' : 's'}. Upgrade to add more.`);
  }
  const ref = await _db().collection('providerServices').add({
    providerId: uid, name, category: _san(d.category, 120), subcategory: _san(d.subcategory, 120),
    description: _san(d.description, 1000), priceType: _san(d.priceType, 40) || 'quotation',
    price: Math.max(0, Math.round(Number(d.price) || 0)), active: true,
    createdAt: _ts(), updatedAt: _ts(),
  });
  return { success: true, serviceId: ref.id, remaining: cap === -1 ? -1 : cap - activeCount - 1 };
};

/* ── 11. providerListServices ────────────────────────────────────────────────*/
_h.providerListServices = async (req) => {
  const uid  = _uid(req);
  const snap = await _db().collection('providerServices')
    .where('providerId', '==', uid).limit(100).get();
  return { services: snap.docs.map((d) => ({ id: d.id, ...d.data() })) };
};

/* ── 12. providerRemoveService ───────────────────────────────────────────────
   Soft-delete (active:false) so listing counts free up without losing history. */
_h.providerRemoveService = async (req) => {
  const uid = _uid(req);
  const id  = _san(req.data?.serviceId, 128);
  if (!id) throw new HttpsError('invalid-argument', 'serviceId is required.');
  const ref  = _db().collection('providerServices').doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Service not found.');
  if (snap.data().providerId !== uid) throw new HttpsError('permission-denied', 'Not your service.');
  await ref.update({ active: false, removedAt: _ts(), updatedAt: _ts() });
  return { success: true };
};

module.exports = { _h };
