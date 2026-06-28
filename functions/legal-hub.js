'use strict';
/**
 * Legal Services Hub v1.0 — SOKONI Platform
 * Lawyer/firm registration, consultations, document services
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

const LEGAL_SPECIALIZATIONS = [
  'family_law', 'property_law', 'employment_law', 'corporate_law', 'criminal_law',
  'immigration', 'intellectual_property', 'tax_law', 'conveyancing', 'debt_recovery',
  'drafting', 'notary', 'mediation', 'litigation', 'other',
];

/* ── 1. registerLegalProvider ── */
exports.registerLegalProvider = onCall(CF_OPTS, async (req) => {
  const uid = requireAuth(req);
  const { name, firmName, specializations, licenseNumber, bio,
          location, county, phone, consultationFee, currency,
          languages, isOnline, yearsOfExperience } = req.data;

  if (!name || !specializations || !licenseNumber) {
    throw new HttpsError('invalid-argument', 'name, specializations, licenseNumber required');
  }
  const specs = Array.isArray(specializations)
    ? specializations.filter(s => LEGAL_SPECIALIZATIONS.includes(s)).slice(0, 5)
    : [];
  if (!specs.length) throw new HttpsError('invalid-argument', 'At least one valid specialization required');

  const existing = await db().collection('legalProviders').where('uid', '==', uid).limit(1).get();
  if (!existing.empty) throw new HttpsError('already-exists', 'Profile already exists');

  const ref = db().collection('legalProviders').doc(uid);
  await ref.set({
    providerId: uid, uid,
    name: san(name, 120), firmName: san(firmName, 120),
    specializations: specs, licenseNumber: san(licenseNumber, 60),
    bio: san(bio, 2000),
    location: san(location, 150), county: san(county, 80), country: 'Kenya',
    phone: san(phone, 20),
    consultationFee: parseFloat(consultationFee) || 0,
    currency: currency === 'USD' ? 'USD' : 'KES',
    languages: Array.isArray(languages) ? languages.slice(0, 5).map(l => san(l, 30)) : ['English', 'Swahili'],
    isOnline: Boolean(isOnline),
    yearsOfExperience: parseInt(yearsOfExperience) || 0,
    status: 'pending',
    rating: 0, ratingCount: 0, totalConsultations: 0,
    createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
  });
  return { providerId: uid, status: 'pending' };
});

/* ── 2. approveLegalProvider (admin) ── */
exports.approveLegalProvider = onCall(CF_OPTS, async (req) => {
  const uid = requireAuth(req);
  const role = await getRole(uid);
  if (role < 4) throw new HttpsError('permission-denied', 'Admin required');
  const { providerId, action, reason } = req.data;
  if (!providerId || !['approve', 'reject'].includes(action)) {
    throw new HttpsError('invalid-argument', 'providerId and action required');
  }
  const ref = db().collection('legalProviders').doc(providerId);
  if (!(await ref.get()).exists) throw new HttpsError('not-found', 'Provider not found');
  await ref.update({
    status: action === 'approve' ? 'active' : 'rejected',
    reviewedBy: uid, reviewedAt: FieldValue.serverTimestamp(),
    reviewNotes: san(reason, 500), updatedAt: FieldValue.serverTimestamp(),
  });
  return { ok: true };
});

/* ── 3. getLegalProviders ── */
exports.getLegalProviders = onCall(CF_OPTS, async (req) => {
  const { specialization, county, isOnline, limit = 24, cursor } = req.data;

  let q = db().collection('legalProviders')
    .where('status', '==', 'active')
    .orderBy('rating', 'desc')
    .limit(Math.min(50, parseInt(limit) || 24));

  if (specialization && LEGAL_SPECIALIZATIONS.includes(specialization)) {
    q = db().collection('legalProviders')
      .where('status', '==', 'active')
      .where('specializations', 'array-contains', specialization)
      .orderBy('rating', 'desc')
      .limit(Math.min(50, parseInt(limit) || 24));
  }

  if (cursor) {
    const c = await db().collection('legalProviders').doc(cursor).get();
    if (c.exists) q = q.startAfter(c);
  }

  const snap = await q.get();
  let providers = snap.docs.map(d => {
    const p = d.data();
    return { providerId: p.providerId, name: p.name, firmName: p.firmName,
      specializations: p.specializations, county: p.county,
      consultationFee: p.consultationFee, currency: p.currency,
      rating: p.rating, ratingCount: p.ratingCount,
      isOnline: p.isOnline, yearsOfExperience: p.yearsOfExperience, languages: p.languages };
  });

  if (county) providers = providers.filter(p => (p.county || '').toLowerCase().includes(county.toLowerCase()));
  if (isOnline) providers = providers.filter(p => p.isOnline);

  const nextCursor = snap.docs.length === Math.min(50, parseInt(limit) || 24)
    ? snap.docs[snap.docs.length - 1].id : null;
  return { providers, nextCursor };
});

/* ── 4. getLegalProvider ── */
exports.getLegalProvider = onCall(CF_OPTS, async (req) => {
  const { providerId } = req.data;
  if (!providerId) throw new HttpsError('invalid-argument', 'providerId required');
  const snap = await db().collection('legalProviders').doc(providerId).get();
  if (!snap.exists || snap.data().status !== 'active') throw new HttpsError('not-found', 'Provider not found');
  return snap.data();
});

/* ── 5. bookLegalConsultation ── */
exports.bookLegalConsultation = onCall(CF_OPTS, async (req) => {
  const uid = requireAuth(req);
  const { providerId, dateTime, matter, isOnline, idempotencyKey } = req.data;
  if (!providerId || !dateTime || !matter || !idempotencyKey) {
    throw new HttpsError('invalid-argument', 'providerId, dateTime, matter, idempotencyKey required');
  }

  const idemRef = db().collection('legalConsultIdempotency').doc(idempotencyKey);
  if ((await idemRef.get()).exists) return { consultationId: (await idemRef.get()).data().consultationId, idempotent: true };

  const provSnap = await db().collection('legalProviders').doc(providerId).get();
  if (!provSnap.exists || provSnap.data().status !== 'active') throw new HttpsError('not-found', 'Provider not found');
  const prov = provSnap.data();
  if (new Date(dateTime) < new Date()) throw new HttpsError('invalid-argument', 'dateTime must be in the future');

  const ref = db().collection('legalConsultations').doc();
  const batch = db().batch();
  batch.set(ref, {
    consultationId: ref.id, clientUid: uid, providerId,
    providerName: prov.name, firmName: prov.firmName,
    specializations: prov.specializations,
    dateTime: new Date(dateTime).toISOString(),
    matter: san(matter, 2000), isOnline: Boolean(isOnline),
    consultationFee: prov.consultationFee, currency: prov.currency,
    status: 'pending', idempotencyKey,
    createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
  });
  batch.update(db().collection('legalProviders').doc(providerId), {
    totalConsultations: FieldValue.increment(1), updatedAt: FieldValue.serverTimestamp(),
  });
  batch.set(idemRef, { consultationId: ref.id, createdAt: FieldValue.serverTimestamp() });
  await batch.commit();
  return { consultationId: ref.id, status: 'pending' };
});

/* ── 6. getMyLegalConsultations (client) ── */
exports.getMyLegalConsultations = onCall(CF_OPTS, async (req) => {
  const uid = requireAuth(req);
  const snap = await db().collection('legalConsultations')
    .where('clientUid', '==', uid)
    .orderBy('dateTime', 'desc').limit(30).get();
  return { consultations: snap.docs.map(d => d.data()) };
});

/* ── 7. getProviderConsultations ── */
exports.getProviderConsultations = onCall(CF_OPTS, async (req) => {
  const uid = requireAuth(req);
  const { date, status } = req.data;
  const snap = await db().collection('legalConsultations')
    .where('providerId', '==', uid)
    .orderBy('dateTime', 'asc').limit(100).get();
  let consultations = snap.docs.map(d => d.data());
  if (date) consultations = consultations.filter(c => c.dateTime.startsWith(date));
  if (status) consultations = consultations.filter(c => c.status === status);
  return { consultations };
});

/* ── 8. updateConsultationStatus ── */
exports.updateConsultationStatus = onCall(CF_OPTS, async (req) => {
  const uid = requireAuth(req);
  const { consultationId, status, notes } = req.data;
  if (!consultationId || !status) throw new HttpsError('invalid-argument', 'consultationId and status required');
  const VALID = ['confirmed', 'cancelled', 'completed', 'no_show', 'rescheduled'];
  if (!VALID.includes(status)) throw new HttpsError('invalid-argument', 'Invalid status');

  const ref = db().collection('legalConsultations').doc(consultationId);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Consultation not found');
  const c = snap.data();
  const role = await getRole(uid);
  if (c.clientUid !== uid && c.providerId !== uid && role < 4) throw new HttpsError('permission-denied', 'Not authorized');

  const updates = { status, updatedAt: FieldValue.serverTimestamp() };
  if (notes) updates.notes = san(notes, 1000);
  if (status === 'completed') updates.completedAt = FieldValue.serverTimestamp();
  await ref.update(updates);
  return { ok: true };
});

/* ── 9. rateLegalProvider ── */
exports.rateLegalProvider = onCall(CF_OPTS, async (req) => {
  const uid = requireAuth(req);
  const { providerId, consultationId, rating, review } = req.data;
  if (!providerId || !consultationId || !rating) {
    throw new HttpsError('invalid-argument', 'providerId, consultationId, rating required');
  }
  if (rating < 1 || rating > 5) throw new HttpsError('invalid-argument', 'Rating 1–5');

  const consultSnap = await db().collection('legalConsultations').doc(consultationId).get();
  if (!consultSnap.exists) throw new HttpsError('not-found', 'Consultation not found');
  const c = consultSnap.data();
  if (c.clientUid !== uid) throw new HttpsError('permission-denied', 'Not your consultation');
  if (c.status !== 'completed') throw new HttpsError('failed-precondition', 'Can only rate completed consultations');
  if (c.rated) throw new HttpsError('already-exists', 'Already rated');

  await db().runTransaction(async t => {
    const provRef = db().collection('legalProviders').doc(providerId);
    const provSnap = await t.get(provRef);
    if (!provSnap.exists) throw new HttpsError('not-found', 'Provider not found');
    const p = provSnap.data();
    const newCount = p.ratingCount + 1;
    const newRating = ((p.rating * p.ratingCount) + rating) / newCount;
    t.update(provRef, { rating: Math.round(newRating * 10) / 10, ratingCount: newCount, updatedAt: FieldValue.serverTimestamp() });
    t.update(db().collection('legalConsultations').doc(consultationId), {
      rated: true, rating, review: san(review, 500), ratedAt: FieldValue.serverTimestamp(),
    });
  });
  return { ok: true };
});

module.exports = {
  registerLegalProvider:    exports.registerLegalProvider,
  approveLegalProvider:     exports.approveLegalProvider,
  getLegalProviders:        exports.getLegalProviders,
  getLegalProvider:         exports.getLegalProvider,
  bookLegalConsultation:    exports.bookLegalConsultation,
  getMyLegalConsultations:  exports.getMyLegalConsultations,
  getProviderConsultations: exports.getProviderConsultations,
  updateConsultationStatus: exports.updateConsultationStatus,
  rateLegalProvider:        exports.rateLegalProvider,
};
