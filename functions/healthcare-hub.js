'use strict';
/**
 * Healthcare Hub v1.0 â€” SOKONI Platform
 * Provider registration, appointment booking, health records, prescriptions
 * 15 Cloud Functions | enforceAppCheck: true | region: us-central1
 */

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const admin = require('firebase-admin');

const REGION = 'us-central1';
const CF_OPTS = { region: REGION, enforceAppCheck: true };
const db = () => admin.firestore();
const FieldValue = admin.firestore.FieldValue;
/* The canonical admin authority (CHANGELOG 222, Healthcare security slice 2). The numeric
   `customClaims.role >= 4` this module used is minted by NOTHING (event-hub.js:210), so every admin
   branch here was dead — and a numeric claim must never be invented to revive it. */
const ADMIN = require('./admin-claim');
exports._h = {};

function requireAuth(req) {
  if (!req.auth) throw new HttpsError('unauthenticated', 'Authentication required');
  return req.auth.uid;
}
function san(s, max = 200) { return s == null ? '' : String(s).trim().slice(0, max); }

const SPECIALIZATIONS = [
  'general_practice', 'pediatrics', 'obstetrics', 'cardiology', 'dermatology',
  'dentistry', 'ophthalmology', 'orthopedics', 'psychiatry', 'physiotherapy',
  'nutrition', 'pharmacy', 'laboratory', 'radiology', 'oncology', 'other',
];

/* â”€â”€ 1. registerHealthProvider â”€â”€ */
exports.registerHealthProvider = onCall(CF_OPTS, exports._h.registerHealthProvider = async (req) => {
  const uid = requireAuth(req);
  const { name, specialization, bio, qualifications, licenseNumber, clinic,
          address, city, county, phone, consultationFee, currency,
          languages, insuranceAccepted, isOnline } = req.data;

  if (!name || !specialization || !licenseNumber) {
    throw new HttpsError('invalid-argument', 'name, specialization, licenseNumber required');
  }
  if (!SPECIALIZATIONS.includes(specialization)) {
    throw new HttpsError('invalid-argument', 'Invalid specialization');
  }

  const existing = await db().collection('healthProviders')
    .where('uid', '==', uid).limit(1).get();
  if (!existing.empty) throw new HttpsError('already-exists', 'Provider profile already exists');

  const ref = db().collection('healthProviders').doc(uid);
  await ref.set({
    providerId: uid, uid,
    name: san(name, 120), specialization,
    bio: san(bio, 2000), qualifications: san(qualifications, 500),
    licenseNumber: san(licenseNumber, 60),
    clinic: san(clinic, 120), address: san(address, 300),
    city: san(city, 80), county: san(county, 80), country: 'Kenya',
    phone: san(phone, 20),
    consultationFee: parseFloat(consultationFee) || 0,
    currency: currency === 'USD' ? 'USD' : 'KES',
    languages: Array.isArray(languages) ? languages.slice(0, 5).map(l => san(l, 30)) : ['English', 'Swahili'],
    insuranceAccepted: Array.isArray(insuranceAccepted) ? insuranceAccepted.slice(0, 10).map(i => san(i, 50)) : [],
    isOnline: Boolean(isOnline),
    status: 'pending',
    rating: 0, ratingCount: 0,
    totalAppointments: 0, completedAppointments: 0,
    isAvailable: true,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });
  return { providerId: uid, status: 'pending' };
});

/* â”€â”€ 2. approveHealthProvider â”€â”€ */
/* RETIRED (CHANGELOG 222). A standalone healthcare approval beside the AdminOS application decision
   (applicationDecide → application-lifecycle → providers/{uid}, ADR-014) — a second approval authority,
   gated on a numeric role nothing mints, that set `status:'active'` directly. It never had a client
   caller. The export stays so a deployed caller gets a plain answer; it reads and writes nothing. */
exports.approveHealthProvider = onCall(CF_OPTS, exports._h.approveHealthProvider = async (req) => {
  requireAuth(req);
  throw new HttpsError('failed-precondition',
    'Healthcare provider approval is made in AdminOS (application review). Nothing was changed.',
    { code: 'HEALTH_APPROVAL_MOVED' });
});

/* â”€â”€ 3. getHealthProviders â”€â”€ */
exports.getHealthProviders = onCall(CF_OPTS, exports._h.getHealthProviders = async (req) => {
  const { specialization, city, isOnline, limit = 24, cursor } = req.data;

  let q = db().collection('healthProviders')
    .where('status', '==', 'active')
    .orderBy('rating', 'desc')
    .limit(Math.min(50, parseInt(limit) || 24));

  if (specialization && SPECIALIZATIONS.includes(specialization)) {
    q = db().collection('healthProviders')
      .where('status', '==', 'active')
      .where('specialization', '==', specialization)
      .orderBy('rating', 'desc')
      .limit(Math.min(50, parseInt(limit) || 24));
  }

  if (cursor) {
    const c = await db().collection('healthProviders').doc(cursor).get();
    if (c.exists) q = q.startAfter(c);
  }

  const snap = await q.get();
  let providers = snap.docs.map(d => {
    const p = d.data();
    return {
      providerId: p.providerId, name: p.name, specialization: p.specialization,
      clinic: p.clinic, city: p.city, county: p.county,
      consultationFee: p.consultationFee, currency: p.currency,
      rating: p.rating, ratingCount: p.ratingCount,
      isOnline: p.isOnline, isAvailable: p.isAvailable,
      languages: p.languages, insuranceAccepted: p.insuranceAccepted,
    };
  });

  if (city) providers = providers.filter(p => (p.city || '').toLowerCase().includes(city.toLowerCase()));
  if (isOnline) providers = providers.filter(p => p.isOnline);

  const nextCursor = snap.docs.length === Math.min(50, parseInt(limit) || 24)
    ? snap.docs[snap.docs.length - 1].id : null;
  return { providers, nextCursor };
});

/* â”€â”€ 4. getHealthProvider â”€â”€ */
exports.getHealthProvider = onCall(CF_OPTS, exports._h.getHealthProvider = async (req) => {
  const { providerId } = req.data;
  if (!providerId) throw new HttpsError('invalid-argument', 'providerId required');
  const snap = await db().collection('healthProviders').doc(providerId).get();
  if (!snap.exists || snap.data().status !== 'active') throw new HttpsError('not-found', 'Provider not found');
  return snap.data();
});

/* â”€â”€ 5. bookAppointment â”€â”€ */
exports.bookAppointment = onCall(CF_OPTS, exports._h.bookAppointment = async (req) => {
  const uid = requireAuth(req);
  const { providerId, dateTime, reason, isOnline, idempotencyKey } = req.data;
  if (!providerId || !dateTime || !idempotencyKey) {
    throw new HttpsError('invalid-argument', 'providerId, dateTime, idempotencyKey required');
  }
  if (new Date(dateTime) < new Date()) throw new HttpsError('invalid-argument', 'Appointment must be in the future');

  // Round to 30-min bucket for the slot-lock document key
  const apptMs   = new Date(dateTime).getTime();
  const bucketMs = Math.floor(apptMs / (30 * 60000)) * (30 * 60000);
  const slotKey  = new Date(bucketMs).toISOString().replace(/[:.]/g, '-');

  // Fetch provider outside the transaction (read-only, no races)
  const provSnap = await db().collection('healthProviders').doc(providerId).get();
  if (!provSnap.exists || provSnap.data().status !== 'active') {
    throw new HttpsError('not-found', 'Provider not found or unavailable');
  }
  const prov = provSnap.data();

  const idemRef  = db().collection('healthApptIdempotency').doc(idempotencyKey);
  // Slot-lock doc prevents double-bookings without needing a query inside the transaction
  const lockRef  = db().collection('healthSlotLocks').doc(`${providerId}_${slotKey}`);
  const apptRef  = db().collection('healthAppointments').doc();

  let result;
  try {
    result = await db().runTransaction(async t => {
      const [idemSnap, lockSnap] = await Promise.all([t.get(idemRef), t.get(lockRef)]);
      if (idemSnap.exists) return { appointmentId: idemSnap.data().appointmentId, idempotent: true };
      if (lockSnap.exists) throw new HttpsError('resource-exhausted', 'This time slot is already booked. Please choose another.');

      t.set(lockRef, { providerId, slotKey, appointmentId: apptRef.id, createdAt: FieldValue.serverTimestamp() });
      t.set(apptRef, {
        appointmentId: apptRef.id, patientUid: uid, providerId,
        providerName: prov.name, specialization: prov.specialization,
        dateTime: new Date(dateTime).toISOString(),
        reason: san(reason, 500), isOnline: Boolean(isOnline),
        consultationFee: prov.consultationFee, currency: prov.currency,
        status: 'pending', idempotencyKey, slotKey,
        createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
      });
      t.update(db().collection('healthProviders').doc(providerId), {
        totalAppointments: FieldValue.increment(1), updatedAt: FieldValue.serverTimestamp(),
      });
      t.set(idemRef, { appointmentId: apptRef.id, createdAt: FieldValue.serverTimestamp() });
      return { appointmentId: apptRef.id, status: 'pending' };
    });
  } catch (err) {
    if (err && err.httpErrorCode) throw err;
    throw new HttpsError('internal', 'Booking failed. Please try again.');
  }
  return result;
});

/* â”€â”€ 6. getMyAppointments (patient) â”€â”€ */
exports.getMyAppointments = onCall(CF_OPTS, exports._h.getMyAppointments = async (req) => {
  const uid = requireAuth(req);
  const { status, limit = 20 } = req.data;
  /* status is filtered in memory, not in the query. Chaining .where('status')
     after .orderBy('dateTime') would require a 3-field composite index
     (patientUid + status + dateTime); the base query already needs a 2-field
     one (patientUid + dateTime), which is what we provision. Filtering the
     handful of rows the limit returns is cheaper than a second index, and
     matches getProviderAppointments, which already filters in memory. */
  const q = db().collection('healthAppointments')
    .where('patientUid', '==', uid)
    .orderBy('dateTime', 'desc')
    .limit(Math.min(50, parseInt(limit) || 20));
  const snap = await q.get();
  let appts = snap.docs.map(d => d.data());
  if (status) appts = appts.filter(a => a.status === status);
  return { appointments: appts };
});

/* â”€â”€ 7. getProviderAppointments â”€â”€ */
exports.getProviderAppointments = onCall(CF_OPTS, exports._h.getProviderAppointments = async (req) => {
  const uid = requireAuth(req);
  const { date, status, limit = 50 } = req.data;
  const isAdmin = ADMIN.isAdmin(req);
  const providerId = isAdmin && req.data.providerId ? String(req.data.providerId) : uid;

  let q = db().collection('healthAppointments')
    .where('providerId', '==', providerId)
    .orderBy('dateTime', 'asc')
    .limit(Math.min(100, parseInt(limit) || 50));

  const snap = await q.get();
  let appts = snap.docs.map(d => d.data());
  if (date) appts = appts.filter(a => a.dateTime.startsWith(date));
  if (status) appts = appts.filter(a => a.status === status);
  return { appointments: appts };
});

/* â”€â”€ 8. updateAppointmentStatus â”€â”€ */
exports.updateAppointmentStatus = onCall(CF_OPTS, exports._h.updateAppointmentStatus = async (req) => {
  const uid = requireAuth(req);
  const { appointmentId, status, notes } = req.data;
  if (!appointmentId || !status) throw new HttpsError('invalid-argument', 'appointmentId and status required');
  const VALID = ['confirmed', 'cancelled', 'completed', 'no_show'];
  if (!VALID.includes(status)) throw new HttpsError('invalid-argument', 'Invalid status');

  /* The canonical admin claim, read from the verified token (no Auth round-trip). */
  const isAdm = ADMIN.isAdmin(req);

  const ref = db().collection('healthAppointments').doc(appointmentId);
  await db().runTransaction(async t => {
    const snap = await t.get(ref);
    if (!snap.exists) throw new HttpsError('not-found', 'Appointment not found');
    const appt = snap.data();

    if (appt.patientUid !== uid && appt.providerId !== uid && !isAdm) {
      throw new HttpsError('permission-denied', 'Not authorized');
    }
    /* WHO DECIDES AN APPOINTMENT HAPPENED (CHANGELOG 213). The patient could mark their own appointment
       'completed' — and a completed appointment is what makes a rating eligible, so the reviewer decided
       their own eligibility. Only the provider (or an admin) confirms, completes or records a no-show;
       the patient may cancel. */
    const isProviderSide = appt.providerId === uid || isAdm;
    if (status !== 'cancelled' && !isProviderSide) {
      throw new HttpsError('permission-denied', 'Only the provider can mark this appointment ' + status + '.');
    }

    const updates = { status, updatedAt: FieldValue.serverTimestamp() };
    if (notes) updates.notes = san(notes, 1000);
    if (status === 'completed') updates.completedAt = FieldValue.serverTimestamp();
    if (status === 'cancelled') updates.cancelledAt = FieldValue.serverTimestamp();

    t.update(ref, updates);

    if (status === 'completed') {
      t.update(db().collection('healthProviders').doc(appt.providerId), {
        completedAppointments: FieldValue.increment(1),
        updatedAt: FieldValue.serverTimestamp(),
      });
    }

    // Release slot lock when appointment ends so the slot is bookable again
    if ((status === 'cancelled' || status === 'completed') && appt.slotKey) {
      t.delete(db().collection('healthSlotLocks').doc(`${appt.providerId}_${appt.slotKey}`));
    }
  });
  return { ok: true };
});

/* â”€â”€ 9. createHealthRecord (provider only) â”€â”€ */
/* ══ CLINICAL WRITE AUTHORIZATION (CHANGELOG 223 — Healthcare security slice 3) ══════════════════
   A provider may write a medical record or prescription ONLY for a patient with whom they hold a
   confirmed clinical relationship. createHealthRecord / createPrescription used to take `patientUid`
   straight from the request: an active provider could chart and prescribe against ANY account.

   The relationship authority is the CANONICAL booking that exists today — providerBookings/{id},
   written only by the server (booking-service / provider-ops; firestore.rules write:false):
     • providerId      == the caller                     (who treats)
     • customerUid     == the patient — DERIVED from the booking, never taken from the request
     • commissionHub   == 'healthcare'                   (server-stamped from the provider's DECIDED
                                                           AdminOS application — not self-declared)
     • status          ∈ confirmed | completed           (not pending / cancelled / declined / no-show)
     • paymentStatus   ∈ paid_held | settled             (paid, never refunded — a provider can confirm
                                                           an UNPAID booking, so "confirmed" alone is weak)
   No healthcare booking engine is activated or added for this: healthAppointments (the hub's parallel
   engine, which ADR-015 retires) is deliberately NOT an authorization basis.

   The provider IDENTITY gate is unchanged (healthProviders/{uid}.status == 'active'). Which identity
   clinical writes require is ADR-014's decision (not authorized) — until then both must hold, so
   clinical writes stay unreachable in production; the relationship boundary is correct before anyone
   can reach it.

   Every write appends a content-free audit row (healthClinicalAudit: actor · patient · provider · action ·
   record ref · booking = authorization basis · time — never the diagnosis or medicines), in the SAME
   transaction. Records are APPEND-ONLY (no update/delete path; rules write:false). A correction /
   amendment workflow is a clinical-records policy decision, recorded in CHANGELOG 223, not invented here. */
const CLINICAL_STATUSES = ['confirmed', 'completed'];
const CLINICAL_PAID = ['paid_held', 'settled'];
const _reqId = (v) => { const r = String(v || '').trim(); if (!/^[A-Za-z0-9_-]{8,64}$/.test(r)) throw new HttpsError('invalid-argument', 'requestId (8–64 letters, digits, - or _) is required so a retry cannot duplicate the record.'); return r; };

/** Inside a transaction: the qualifying booking, or a refusal. Reads only — callers write after. */
async function _clinicalBasis(t, uid, bookingId) {
  const bid = String(bookingId || '').trim();
  if (!bid || /[\/]/.test(bid)) throw new HttpsError('invalid-argument', 'bookingId of the consultation is required.');
  const [bSnap, pSnap] = await Promise.all([
    t.get(db().collection('providerBookings').doc(bid)),
    t.get(db().collection('healthProviders').doc(uid)),
  ]);
  if (!pSnap.exists || pSnap.data().status !== 'active') throw new HttpsError('permission-denied', 'Active provider account required');
  const b = bSnap.exists ? bSnap.data() : null;
  /* one message for every failure: the caller learns nothing about bookings that are not theirs */
  const deny = () => new HttpsError('permission-denied', 'No confirmed, paid healthcare consultation between you and this patient.', { code: 'NO_CLINICAL_RELATIONSHIP' });
  if (!b || b.providerId !== uid || !b.customerUid || b.customerUid === uid) throw deny();
  if (b.commissionHub !== 'healthcare') throw deny();
  if (!CLINICAL_STATUSES.includes(b.status) || !CLINICAL_PAID.includes(b.paymentStatus)) throw deny();
  return { booking: b, bookingId: bid, patientUid: b.customerUid, provider: pSnap.data() };
}

function _audit(t, row) {
  t.set(db().collection('healthClinicalAudit').doc(), Object.assign({ createdAt: FieldValue.serverTimestamp(), atMs: Date.now() }, row));
}

exports.createHealthRecord = onCall(CF_OPTS, exports._h.createHealthRecord = async (req) => {
  const uid = requireAuth(req);
  const d = req.data || {};
  if (!d.diagnosis) throw new HttpsError('invalid-argument', 'diagnosis required');
  const requestId = _reqId(d.requestId);
  /* d.patientUid is IGNORED — the patient is the booking's customer (CHANGELOG 223) */
  let out = null;
  await db().runTransaction(async (t) => {
    const basis = await _clinicalBasis(t, uid, d.bookingId);
    const ref = db().collection('healthRecords').doc(('hr_' + basis.bookingId + '_' + requestId).slice(0, 150));
    const ex = await t.get(ref);
    if (ex.exists) { out = { recordId: ref.id, idempotent: true }; return; }
    t.set(ref, {
      recordId: ref.id, patientUid: basis.patientUid, providerId: uid,
      providerName: basis.provider.name || '',
      specialization: basis.provider.specialization || null,
      bookingId: basis.bookingId,
      diagnosis: san(d.diagnosis, 2000),
      treatment: san(d.treatment, 2000),
      notes: san(d.notes, 2000),
      followUpDate: d.followUpDate ? new Date(d.followUpDate).toISOString() : null,
      createdAt: FieldValue.serverTimestamp(),
    });
    _audit(t, { actor: uid, action: 'record_create', patientUid: basis.patientUid, providerId: uid,
      ref: 'healthRecords/' + ref.id, basis: 'providerBookings/' + basis.bookingId });
    out = { recordId: ref.id };
  });
  return out;
});

/* â”€â”€ 10. getHealthRecords (patient views own records) â”€â”€ */
exports.getHealthRecords = onCall(CF_OPTS, exports._h.getHealthRecords = async (req) => {
  const uid = requireAuth(req);
  const { limit = 20 } = req.data;   /* a caller-supplied patientUid is ignored */
  /* Each caller reads their OWN records. The numeric-role branch that let an "admin" read any patient
     was dead (nothing mints the claim); it is removed, not revived. Whether any administrator may read a
     patient's clinical records — and under what audit — is decided in security slice 3. */
  const targetUid = uid;

  const snap = await db().collection('healthRecords')
    .where('patientUid', '==', targetUid)
    .orderBy('createdAt', 'desc')
    .limit(Math.min(50, parseInt(limit) || 20))
    .get();
  return { records: snap.docs.map(d => d.data()) };
});

/* â”€â”€ 11. createPrescription â”€â”€ */
exports.createPrescription = onCall(CF_OPTS, exports._h.createPrescription = async (req) => {
  const uid = requireAuth(req);
  const d = req.data || {};
  const medications = Array.isArray(d.medications) ? d.medications : [];
  if (!medications.length) throw new HttpsError('invalid-argument', 'medications required');
  const requestId = _reqId(d.requestId);
  /* d.patientUid is IGNORED — the patient is the booking's customer (CHANGELOG 223) */
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + Math.max(1, Math.min(365, parseInt(d.validDays) || 30)));
  let out = null;
  await db().runTransaction(async (t) => {
    const basis = await _clinicalBasis(t, uid, d.bookingId);
    const ref = db().collection('healthPrescriptions').doc(('rx_' + basis.bookingId + '_' + requestId).slice(0, 150));
    const ex = await t.get(ref);
    if (ex.exists) { out = { prescriptionId: ref.id, idempotent: true }; return; }
    t.set(ref, {
      prescriptionId: ref.id, patientUid: basis.patientUid, providerId: uid,
      providerName: basis.provider.name || '',
      bookingId: basis.bookingId,
      medications: medications.slice(0, 20).map(m => ({
        name: san(m && m.name, 100), dosage: san(m && m.dosage, 100),
        frequency: san(m && m.frequency, 100), duration: san(m && m.duration, 100),
      })),
      instructions: san(d.instructions, 1000),
      expiresAt: expiresAt.toISOString(),
      status: 'active',
      createdAt: FieldValue.serverTimestamp(),
    });
    _audit(t, { actor: uid, action: 'prescription_create', patientUid: basis.patientUid, providerId: uid,
      ref: 'healthPrescriptions/' + ref.id, basis: 'providerBookings/' + basis.bookingId });
    out = { prescriptionId: ref.id };
  });
  return out;
});

/* â”€â”€ 12. getPrescriptions â”€â”€ */
exports.getPrescriptions = onCall(CF_OPTS, exports._h.getPrescriptions = async (req) => {
  const uid = requireAuth(req);
  const snap = await db().collection('healthPrescriptions')
    .where('patientUid', '==', uid)
    .orderBy('createdAt', 'desc')
    .limit(20).get();
  return { prescriptions: snap.docs.map(d => d.data()) };
});

/* â”€â”€ 13. searchHealthProviders â”€â”€ */
exports.searchHealthProviders = onCall(CF_OPTS, exports._h.searchHealthProviders = async (req) => {
  const { query, limit = 20 } = req.data;
  if (!query) throw new HttpsError('invalid-argument', 'query required');
  const q = query.toLowerCase();
  const snap = await db().collection('healthProviders')
    .where('status', '==', 'active').orderBy('rating', 'desc').limit(200).get();
  const results = snap.docs.map(d => d.data())
    .filter(p =>
      p.name.toLowerCase().includes(q) ||
      p.specialization.includes(q) ||
      (p.clinic || '').toLowerCase().includes(q) ||
      (p.city || '').toLowerCase().includes(q)
    )
    .slice(0, Math.min(40, parseInt(limit) || 20))
    .map(p => ({ providerId: p.providerId, name: p.name, specialization: p.specialization,
      clinic: p.clinic, city: p.city, consultationFee: p.consultationFee,
      rating: p.rating, isOnline: p.isOnline }));
  return { results };
});

/* â”€â”€ 14. rateHealthProvider â”€â”€ */
exports.rateHealthProvider = onCall(CF_OPTS, exports._h.rateHealthProvider = async (req) => {
  /* ONE rating per COMPLETED appointment of the CALLER's (CHANGELOG 213). The provider rated is the
     appointment's — a providerId sent by the client is not trusted (one completed appointment could rate
     ANY provider); the rating is an integer 1–5; "already rated" is read inside the transaction. */
  const uid = requireAuth(req);
  const { appointmentId, rating: rawRating, review } = req.data || {};
  if (!appointmentId || typeof appointmentId !== 'string') throw new HttpsError('invalid-argument', 'appointmentId required');
  const { intRating, addRating } = require('./shared/hub-rating');
  const rating = intRating(rawRating);
  const apptRef = db().collection('healthAppointments').doc(appointmentId);
  await db().runTransaction(async t => {
    const apptSnap = await t.get(apptRef);
    if (!apptSnap.exists) throw new HttpsError('not-found', 'Appointment not found');
    const appt = apptSnap.data();
    if (appt.patientUid !== uid) throw new HttpsError('permission-denied', 'Not your appointment');
    if (appt.status !== 'completed') throw new HttpsError('failed-precondition', 'Can only rate completed appointments');
    if (appt.rated) throw new HttpsError('already-exists', 'Already rated');
    if (req.data.providerId && req.data.providerId !== appt.providerId) throw new HttpsError('permission-denied', 'This appointment was with a different provider.');
    if (appt.providerId === uid) throw new HttpsError('permission-denied', 'You cannot rate yourself.');
    const ref = db().collection('healthProviders').doc(String(appt.providerId));
    const provSnap = await t.get(ref);
    if (!provSnap.exists) throw new HttpsError('not-found', 'Provider not found');
    t.update(ref, { ...addRating(provSnap.data(), rating), updatedAt: FieldValue.serverTimestamp() });
    t.update(apptRef, { rated: true, rating, review: san(review, 500), ratedAt: FieldValue.serverTimestamp() });
  });
  return { ok: true };
});

/* â”€â”€ 15. getHealthDashboard (admin) â”€â”€ */
/* RETIRED (CHANGELOG 222). An admin dashboard outside AdminOS (the ONE administrative workspace),
   gated on a numeric role nothing mints, counting the retired healthProviders identity. No client
   caller. It reads and returns nothing. */
exports.getHealthDashboard = onCall(CF_OPTS, exports._h.getHealthDashboard = async (req) => {
  requireAuth(req);
  throw new HttpsError('failed-precondition', 'Healthcare administration is in AdminOS.', { code: 'HEALTH_DASHBOARD_MOVED' });
});

module.exports = {
  registerHealthProvider: exports.registerHealthProvider,
  approveHealthProvider:  exports.approveHealthProvider,
  getHealthProviders:     exports.getHealthProviders,
  getHealthProvider:      exports.getHealthProvider,
  bookAppointment:        exports.bookAppointment,
  getMyAppointments:      exports.getMyAppointments,
  getProviderAppointments:exports.getProviderAppointments,
  updateAppointmentStatus:exports.updateAppointmentStatus,
  createHealthRecord:     exports.createHealthRecord,
  getHealthRecords:       exports.getHealthRecords,
  createPrescription:     exports.createPrescription,
  getPrescriptions:       exports.getPrescriptions,
  searchHealthProviders:  exports.searchHealthProviders,
  rateHealthProvider:     exports.rateHealthProvider,
  getHealthDashboard:     exports.getHealthDashboard,
};
