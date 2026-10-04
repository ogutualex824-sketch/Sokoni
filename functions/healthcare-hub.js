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
/* ADR-014 (owner 2026-10-04): the ONE healthcare identity is the canonical providers/{uid} an AdminOS approval projects;
   healthcare-directory is the ONE reader of it (discovery: isDiscoverable · clinical identity: canOperate · public
   shape: publicCard). healthProviders is the RETIRED registry — nothing in this module reads or writes it, so a legacy
   healthProviders record can make no clinic active, listed, searchable, viewable, clinical or rated. */
const HD = require('./healthcare-directory');
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
  /* RETIRED (ADR-014, owner 2026-10-04). It wrote the retired healthProviders registry — a second intake beside the ONE
     application flow (Application → AdminOS approval → providers/{uid} → healthcare classification → discoverable).
     The export stays so a deployed caller gets a plain answer; it reads and writes nothing. */
  requireAuth(req);
  throw new HttpsError('failed-precondition',
    'Healthcare providers apply through SOKONI Applications; an administrator approves the application. Nothing was saved.',
    { code: 'HEALTH_REGISTRATION_MOVED' });
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

/* ══ PUBLIC PROVIDER PROJECTION (CHANGELOG 224 — Healthcare security slice 4) ══════════════════════
   The ONE shape a public (unauthenticated) surface may return about a healthcare provider — a WHITELIST,
   so a field added to the document later is private until it is added here on purpose. getHealthProvider
   used to return the WHOLE document to anyone, signed in or not: licence number, private phone, street
   address, reviewer id and review notes. The list and search built their own field lists; all three now
   share this one.
   providerId stays: booking, messaging and profile routing address a provider by account id today — the
   platform-wide public-handle work is tracked separately and is not a Healthcare exception.
   `sokoniApproved` is only what the server knows (an active, admin-approved record); it never claims a
   professional-council (KMPDC / PPB) verification that SOKONI has not performed. */
/* ADR-014: the public shape is the canonical directory card (healthcare-directory.publicCard) — ONE whitelist. */
const PUBLIC_PROVIDER_FIELDS = HD.PUBLIC_FIELDS;

/* â”€â”€ 3. getHealthProviders â”€â”€ */
exports.getHealthProviders = onCall(CF_OPTS, exports._h.getHealthProviders = async (req) => {
  /* ADR-014: the canonical directory (healthcare-directory.listDirectory — approved, active, public, classified). */
  const { specialization, city, limit = 24 } = req.data || {};
  const category = specialization && require('./healthcare-category').isCategory(specialization) ? specialization : '';
  let providers = await HD.listDirectory(db(), { category, limit: Math.min(50, parseInt(limit) || 24) });
  if (city) providers = providers.filter(p => (p.city || '').toLowerCase().includes(String(city).toLowerCase()));
  return { providers, nextCursor: null };
});

/* â”€â”€ 4. getHealthProvider â”€â”€ */
exports.getHealthProvider = onCall(CF_OPTS, exports._h.getHealthProvider = async (req) => {
  const providerId = (req.data || {}).providerId;
  /* a document id, nothing else: a path, an object or an over-long value never reaches Firestore */
  if (typeof providerId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(providerId)) {
    throw new HttpsError('invalid-argument', 'providerId required');
  }
  /* ADR-014: the canonical provider, shown only while the ONE discovery predicate admits it */
  const p = await HD.readProvider(db(), providerId);
  if (!HD.isDiscoverable(p)) throw new HttpsError('not-found', 'Provider not found');
  /* the same public projection for every caller — signed out, patient, the provider, an admin */
  return HD.publicCard(providerId, p);
});

/* â”€â”€ 5. bookAppointment â”€â”€ */
/* RETIRED (CHANGELOG 234). A second booking path outside the ONE availability authority: it booked against the
   retired healthProviders registry, locked 30-minute buckets in healthSlotLocks instead of claiming the provider's
   calendar (ent-availability), ignored working hours, buffers, blackouts and limits, and took no payment. No page
   loads its only caller (sokoni-health.js). Healthcare appointments are booked through bookingCreateService, which
   claims the slot atomically in the same transaction as the booking. The export stays so a deployed caller gets a
   plain answer; it reads and writes nothing. */
exports.bookAppointment = onCall(CF_OPTS, exports._h.bookAppointment = async (req) => {
  requireAuth(req);
  throw new HttpsError('failed-precondition',
    'Appointments are booked from the provider page on SOKONI. Nothing was booked.',
    { code: 'HEALTH_BOOKING_MOVED' });
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

    /* ADR-014: the completedAppointments counter on the retired healthProviders registry is gone — nothing read it.
       Completion is recorded on the appointment; reputation is the review authority's (reputation.js). */

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

   The provider IDENTITY gate is the canonical providers/{uid} (ADR-014, owner 2026-10-04 —
   healthcare-directory.canOperate): an approved, active, unsuspended healthcare provider. Both the identity
   and the relationship must hold.

   Every write appends a content-free audit row (healthClinicalAudit: actor · patient · provider · action ·
   record ref · booking = authorization basis · time — never the diagnosis or medicines), in the SAME
   transaction. Records are APPEND-ONLY (no update/delete path; rules write:false). A correction /
   amendment workflow is a clinical-records policy decision, recorded in CHANGELOG 223, not invented here. */
/* ONE definition of the clinical relationship, shared with the consultation chat (CHANGELOG 231). */
const { CLINICAL_STATUSES, CLINICAL_PAID } = require('./healthcare-conversations');
const _reqId = (v) => { const r = String(v || '').trim(); if (!/^[A-Za-z0-9_-]{8,64}$/.test(r)) throw new HttpsError('invalid-argument', 'requestId (8–64 letters, digits, - or _) is required so a retry cannot duplicate the record.'); return r; };

/** Inside a transaction: the qualifying booking, or a refusal. Reads only — callers write after. */
async function _clinicalBasis(t, uid, bookingId) {
  const bid = String(bookingId || '').trim();
  if (!bid || /[\/]/.test(bid)) throw new HttpsError('invalid-argument', 'bookingId of the consultation is required.');
  /* ADR-014: the clinical IDENTITY is the canonical providers/{uid} (healthcare-directory.canOperate) — never healthProviders */
  const [bSnap, prov] = await Promise.all([
    t.get(db().collection('providerBookings').doc(bid)),
    HD.readProvider(db(), uid, t),
  ]);
  if (!HD.canOperate(prov)) throw new HttpsError('permission-denied', 'Active provider account required');
  const b = bSnap.exists ? bSnap.data() : null;
  /* one message for every failure: the caller learns nothing about bookings that are not theirs */
  const deny = () => new HttpsError('permission-denied', 'No confirmed, paid healthcare consultation between you and this patient.', { code: 'NO_CLINICAL_RELATIONSHIP' });
  if (!b || b.providerId !== uid || !b.customerUid || b.customerUid === uid) throw deny();
  if (b.commissionHub !== 'healthcare') throw deny();
  if (!CLINICAL_STATUSES.includes(b.status) || !CLINICAL_PAID.includes(b.paymentStatus)) throw deny();
  return { booking: b, bookingId: bid, patientUid: b.customerUid, provider: prov };
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
  const { query, limit = 20 } = req.data || {};
  if (!query) throw new HttpsError('invalid-argument', 'query required');
  const q = String(query).toLowerCase();
  /* ADR-014: search the canonical directory — the same predicate and projection as the listing */
  const rows = await HD.listDirectory(db(), { limit: 60 });
  const results = rows.filter(p =>
    (p.name || '').toLowerCase().includes(q) ||
    (p.category || '').includes(q) || (p.categoryLabel || '').toLowerCase().includes(q) ||
    (p.description || '').toLowerCase().includes(q) ||
    (p.city || '').toLowerCase().includes(q)
  ).slice(0, Math.min(40, parseInt(limit) || 20));
  return { results };
});

/* â”€â”€ 14. rateHealthProvider â”€â”€ */
exports.rateHealthProvider = onCall(CF_OPTS, exports._h.rateHealthProvider = async (req) => {
  /* RETIRED (ADR-014, owner 2026-10-04). It rated against the retired healthAppointments engine and wrote the retired
     healthProviders registry. A clinic is rated through the ONE review authority (reputation.js submitReview) on the
     COMPLETED consultation booking (providerBookings) — which aggregates onto the canonical providers/{uid}. The export
     stays so a deployed caller gets a plain answer; it reads and writes nothing. */
  requireAuth(req);
  throw new HttpsError('failed-precondition', 'Rate your consultation from your bookings on SOKONI. Nothing was saved.',
    { code: 'HEALTH_RATING_MOVED' });
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
  PUBLIC_PROVIDER_FIELDS,
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
