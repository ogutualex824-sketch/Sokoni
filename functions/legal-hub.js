'use strict';
/**
 * Legal Services Hub v1.0 — SOKONI Platform
 * Lawyer/firm registration, consultations, document services
 * 9 Cloud Functions | enforceAppCheck: true | region: us-central1
 */

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const admin = require('firebase-admin');

const REGION = 'us-central1';
/* The ONE Legal eligibility predicate (admin verification + current LSK verification) — CHANGELOG 220. */
const LV = require('./legal-verification');
const CF_OPTS = { region: REGION, enforceAppCheck: true };
const db = () => admin.firestore();
const FieldValue = admin.firestore.FieldValue;

function requireAuth(req) {
  if (!req.auth) throw new HttpsError('unauthenticated', 'Authentication required');
  return req.auth.uid;
}
function san(s, max = 200) { return s == null ? '' : String(s).trim().slice(0, max); }

/* THE Legal taxonomy (Legal Hub L1) — six groups × five services, ONE source. The old 15-value list is the
   taxonomy's LEGACY_SPECIALIZATIONS: still accepted from older clients and kept on old profiles, never extended. */
const TAX = require('./shared/legal-taxonomy');
const LEGAL_SPECIALIZATIONS = TAX.LEGACY_SPECIALIZATIONS;

/* Legal Hub L2 — two application types on ONE identity record (legalProviders/{uid}) and ONE review item
   (applications/legal_{uid}). An ADVOCATE applies as a person. A LAW FIRM applies as an organisation through its
   responsible advocate: the account holder is that advocate, so the ONE eligibility predicate (admin approval +
   that advocate's current LSK verification — legal-verification.js, owner-locked b24b052) is unchanged.
   Firm-only facts (registration number, offices, declared team) are admin-reviewed data, never a credential:
   a declared team member is NOT shown as verified anywhere until a team-verification path exists. */
const ENTITY_TYPES = ['advocate', 'firm'];
function _offices(v) {
  return (Array.isArray(v) ? v : []).slice(0, 10).map((o) => ({ name: san(o && o.name, 80), county: san(o && o.county, 80), address: san(o && o.address, 200) }))
    .filter((o) => o.name || o.county || o.address);
}
function _team(v) {
  return (Array.isArray(v) ? v : []).slice(0, 50).map((m) => ({ name: san(m && m.name, 120), lskNumber: san(m && m.lskNumber, 60), role: san(m && m.role, 60) }))
    .filter((m) => m.name);
}

/* ── 1. registerLegalProvider ── */
exports.registerLegalProvider = onCall(CF_OPTS, async (req) => {
  const uid = requireAuth(req);
  const d = req.data || {};
  const { name, firmName, specializations, licenseNumber, bio,
          location, county, phone, consultationFee, currency,
          languages, isOnline, yearsOfExperience } = d;
  const entityType = d.entityType == null ? 'advocate' : String(d.entityType);
  if (!ENTITY_TYPES.includes(entityType)) throw new HttpsError('invalid-argument', 'entityType must be advocate or firm');

  if (!name || !licenseNumber) {
    throw new HttpsError('invalid-argument', 'name and licenseNumber (the responsible advocate\'s LSK admission number) required');
  }
  if (entityType === 'firm' && !san(firmName, 120)) throw new HttpsError('invalid-argument', 'firmName is required for a law-firm application');
  const specs = Array.isArray(specializations)
    ? specializations.filter(s => LEGAL_SPECIALIZATIONS.includes(s)).slice(0, 5)
    : [];
  const practiceAreas = TAX.normalizeAreas(d.practiceAreas);
  if (!specs.length && !practiceAreas.length) throw new HttpsError('invalid-argument', 'Choose at least one practice area');

  const existing = await db().collection('legalProviders').where('uid', '==', uid).limit(1).get();
  if (!existing.empty) throw new HttpsError('already-exists', 'Profile already exists');
  /* A quarantined legacy identity (CHANGELOG 220) is not re-created by registering again. */
  if ((await db().collection('legalProviderQuarantine').doc(uid).get()).exists) {
    throw new HttpsError('failed-precondition', 'This account cannot register as an advocate. Contact SOKONI support.');
  }

  const ref = db().collection('legalProviders').doc(uid);
  await ref.set({
    providerId: uid, uid,
    entityType,
    name: san(name, 120), firmName: san(firmName, 120),
    specializations: specs, practiceAreas, licenseNumber: san(licenseNumber, 60),
    ...(entityType === 'firm' ? { firm: {
      registrationNumber: san(d.firmRegistrationNumber, 60), description: san(d.firmDescription, 2000),
      offices: _offices(d.offices), representativeRole: san(d.representativeRole, 60),
      teamDeclared: _team(d.team), teamVerified: false,
    } } : {}),
    bio: san(bio, 2000),
    location: san(location, 150), county: san(county, 80), country: 'Kenya',
    phone: san(phone, 20),
    consultationFee: parseFloat(consultationFee) || 0,
    currency: currency === 'USD' ? 'USD' : 'KES',
    languages: Array.isArray(languages) ? languages.slice(0, 5).map(l => san(l, 30)) : ['English', 'Swahili'],
    isOnline: Boolean(isOnline),
    yearsOfExperience: parseInt(yearsOfExperience) || 0,
    /* Server-set, never from the request: both authorities start pending (CHANGELOG 220). */
    status: 'pending_review',
    verification: {
      admin: { status: 'pending' }, lsk: { status: 'pending' },
      eligibility: { bookable: false, code: 'ADMIN_PENDING', derivedAtMs: Date.now() },
    },
    rating: 0, ratingCount: 0, totalConsultations: 0,
    createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
  });
  /* The application IS the AdminOS review item (applicationDecide → Legal Verification Authority). */
  const app = await LV.ensureApplication(db(), uid, {
    name: san(name, 120), firmName: san(firmName, 120), phone: san(phone, 20),
    licenseNumber: san(licenseNumber, 60), county: san(county, 80),
  });
  /* AdminOS must tell a LAWYER application from a LAW-FIRM application (L2). Merged onto the ONE review item;
     never a decision field. */
  await db().collection('applications').doc(app.applicationId).set({
    legalEntityType: entityType, applicationType: entityType === 'firm' ? 'law_firm' : 'lawyer',
    practiceAreas, practiceGroups: TAX.groupsOf(practiceAreas), updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
  return { providerId: uid, status: 'pending_review', applicationId: app.applicationId, entityType };
});

/* ── 2. approveLegalProvider (admin) ── */
/* RETIRED (CHANGELOG 220). It required a numeric `role >= 4` claim that nothing mints, so no real
   administrator could ever pass it, and it set `status:'active'` directly — an approval with no LSK
   evidence. Advocate approval is the AdminOS application decision (applicationDecide) feeding the
   Legal Verification Authority; LSK verification is recorded separately. The export stays so a
   deployed caller gets a plain answer instead of a missing function. It writes nothing. */
exports.approveLegalProvider = onCall(CF_OPTS, async (req) => {
  requireAuth(req);
  throw new HttpsError('failed-precondition',
    'Advocate approval has moved to AdminOS › Legal Verification (application review + LSK verification). Nothing was changed.',
    { code: 'LEGAL_APPROVAL_MOVED' });
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
  /* `status == 'active'` is only a coarse pre-filter: the ONE predicate decides (a stale LSK check or a
     legacy record written 'active' by a script — T.M.M — is not listed). CHANGELOG 220. */
  const now = Date.now();
  let providers = snap.docs.filter(d => LV.eligibility(d.data(), now).bookable).map(d => _publicAdvocate(d.data(), now));

  /* Taxonomy filters (L1) run over the eligible set in memory: no new composite index, and an unknown id
     filters to NOTHING (never "ignore the filter and show everyone"). */
  const area = req.data.practiceArea, group = req.data.practiceGroup, et = req.data.entityType;
  if (area) providers = TAX.isArea(area) ? providers.filter(p => p.practiceAreas.includes(area)) : [];
  if (group) providers = TAX.isGroup(group) ? providers.filter(p => p.practiceGroups.includes(group)) : [];
  if (et) providers = ENTITY_TYPES.includes(et) ? providers.filter(p => p.entityType === et) : [];
  if (county) providers = providers.filter(p => (p.county || '').toLowerCase().includes(county.toLowerCase()));
  if (isOnline) providers = providers.filter(p => p.isOnline);

  const nextCursor = snap.docs.length === Math.min(50, parseInt(limit) || 24)
    ? snap.docs[snap.docs.length - 1].id : null;
  return { providers, nextCursor };
});

/* What a PUBLIC surface may carry: profile + the two verification facts. Never the licence number,
   phone, reviewer, evidence or audit references. */
function _publicAdvocate(p, now) {
  const pv = LV.publicVerification(p, now);
  const areas = TAX.areasOfProfile(p);
  const rated = Number(p.ratingCount) > 0;
  return { providerId: p.providerId, name: p.name, firmName: p.firmName,
    entityType: p.entityType === 'firm' ? 'firm' : 'advocate',
    specializations: p.specializations, practiceAreas: areas, practiceGroups: TAX.groupsOf(areas), county: p.county,
    offices: p.entityType === 'firm' && p.firm ? p.firm.offices || [] : undefined,
    bio: p.bio || '',
    consultationFee: Number(p.consultationFee) > 0 ? p.consultationFee : null, currency: p.currency,
    /* an unrated advocate has NO rating — never 0 shown as a score, never a default 5 (L1/no-fakes) */
    rating: rated ? p.rating : null, ratingCount: rated ? p.ratingCount : 0,
    isOnline: p.isOnline, yearsOfExperience: p.yearsOfExperience, languages: p.languages,
    sokoniVerified: pv.sokoniVerified, lskVerified: pv.lskVerified, lskPractisingYear: pv.lskPractisingYear };
}

/* ── 4. getLegalProvider ── */
exports.getLegalProvider = onCall(CF_OPTS, async (req) => {
  const { providerId } = req.data;
  if (!providerId) throw new HttpsError('invalid-argument', 'providerId required');
  const snap = await db().collection('legalProviders').doc(String(providerId)).get();
  const now = Date.now();
  if (!snap.exists || !LV.eligibility(snap.data(), now).bookable) throw new HttpsError('not-found', 'Provider not found');
  return _publicAdvocate(snap.data(), now);
});

/* ── 5. bookLegalConsultation ── */
/* RETIRED by Legal Hub L4 (2026-10-03). It wrote legalConsultations with NO payment, NO hold, NO PIN and NO
   settlement, and it skipped the canonical booking gate. Legal consultations are now canonical provider bookings:
   providerDispatch → bookingCreateService (providerId = the advocate, serviceId = legal_consult_{uid}) → IntaSend.
   The export stays so a cached client gets a plain answer; it writes NOTHING. History (getMyLegalConsultations,
   getProviderConsultations) stays readable. */
exports.bookLegalConsultation = onCall(CF_OPTS, async (req) => {
  requireAuth(req);
  throw new HttpsError('failed-precondition', 'Legal consultations are booked and paid through SOKONI bookings now. Please refresh the page and book again. Nothing was charged or recorded.', { code: 'LEGAL_BOOKING_MOVED' });
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
  /* The canonical admin claim (admin-claim.js), not the numeric `role >= 4` nothing mints (CHANGELOG 220). */
  const isAdm = require('./admin-claim').isAdmin(req);
  if (c.clientUid !== uid && c.providerId !== uid && !isAdm) throw new HttpsError('permission-denied', 'Not authorized');
  /* Only the provider (or an admin) confirms, completes, reschedules or records a no-show: a completed
     consultation is what makes a rating eligible, so the client cannot decide it (CHANGELOG 213). */
  if (status !== 'cancelled' && c.providerId !== uid && !isAdm) {
    throw new HttpsError('permission-denied', 'Only the provider can mark this consultation ' + status + '.');
  }

  const updates = { status, updatedAt: FieldValue.serverTimestamp() };
  if (notes) updates.notes = san(notes, 1000);
  if (status === 'completed') updates.completedAt = FieldValue.serverTimestamp();
  await ref.update(updates);
  return { ok: true };
});

/* ── 9. rateLegalProvider ── */
exports.rateLegalProvider = onCall(CF_OPTS, async (req) => {
  const uid = requireAuth(req);
  const { providerId, consultationId, rating: rawRating, review } = req.data || {};
  if (!consultationId || typeof consultationId !== 'string') {
    throw new HttpsError('invalid-argument', 'consultationId required');
  }
  /* The provider rated is the CONSULTATION's; a client providerId is only cross-checked (CHANGELOG 213). */
  const { intRating, addRating } = require('./shared/hub-rating');
  const rating = intRating(rawRating);

  /* ── ATOMIC rating ──
     The `rated` guard used to be read OUTSIDE the transaction (a get() before runTransaction),
     while the flag was set inside it. Two concurrent rate calls for the same completed
     consultation could both pass the outside check and both apply ratingCount+1, corrupting the
     provider's aggregate. The consultation is now read and the `rated`/ownership/status guards
     are all evaluated INSIDE the transaction, so a repeat sees rated:true and is rejected. */
  const consultRef = db().collection('legalConsultations').doc(consultationId);

  await db().runTransaction(async (t) => {
    const cSnap = await t.get(consultRef);
    if (!cSnap.exists) throw new HttpsError('not-found', 'Consultation not found');
    const c = cSnap.data();
    if (c.clientUid !== uid) throw new HttpsError('permission-denied', 'Not your consultation');
    if (c.status !== 'completed') throw new HttpsError('failed-precondition', 'Can only rate completed consultations');
    if (c.rated) throw new HttpsError('already-exists', 'Already rated');
    if (providerId && providerId !== c.providerId) throw new HttpsError('permission-denied', 'This consultation was with a different provider.');
    if (c.providerId === uid) throw new HttpsError('permission-denied', 'You cannot rate yourself.');
    const provRef = db().collection('legalProviders').doc(String(c.providerId));
    const pSnap = await t.get(provRef);
    if (!pSnap.exists) throw new HttpsError('not-found', 'Provider not found');
    t.update(provRef, { ...addRating(pSnap.data(), rating), updatedAt: FieldValue.serverTimestamp() });
    t.update(consultRef, {
      rated: true, rating, review: san(review, 500), ratedAt: FieldValue.serverTimestamp(),
    });
  });
  return { ok: true };
});

/* ── Legal Hub L2/L3 — the applicant's own profile + application, through legalDispatch (no new Cloud Function).
   Every op authenticates itself first; the dispatcher is a router, not an authorization boundary. ── */
const _h = {};
/* Self-editable, PUBLIC profile facts. Everything else is protected:
   name / licenseNumber / firmName / entityType / firm.registrationNumber identify the advocate or firm that SOKONI
   and the LSK check verified — a change there is a re-verification, done through AdminOS, never self-service;
   status / verification / rating / counts are server-owned. */
const SELF_EDITABLE = ['bio', 'location', 'county', 'languages', 'isOnline', 'practiceAreas', 'consultationFee', 'yearsOfExperience', 'phone'];
const FIRM_EDITABLE = ['description', 'offices', 'team'];

function _selfPatch(cur, d) {
  const p = {};
  if ('bio' in d) p.bio = san(d.bio, 2000);
  if ('location' in d) p.location = san(d.location, 150);
  if ('county' in d) p.county = san(d.county, 80);
  if ('phone' in d) p.phone = san(d.phone, 20);
  if ('languages' in d) p.languages = Array.isArray(d.languages) ? d.languages.slice(0, 5).map((l) => san(l, 30)).filter(Boolean) : [];
  if ('isOnline' in d) p.isOnline = d.isOnline === true;
  if ('yearsOfExperience' in d) p.yearsOfExperience = Math.max(0, Math.min(70, parseInt(d.yearsOfExperience, 10) || 0));
  if ('consultationFee' in d) {
    const f = Number(d.consultationFee);
    if (!Number.isFinite(f) || f < 0 || f > 10000000) throw new HttpsError('invalid-argument', 'consultationFee must be a KES amount between 0 and 10,000,000');
    p.consultationFee = Math.round(f);
  }
  if ('practiceAreas' in d) {
    const a = TAX.normalizeAreas(d.practiceAreas);
    if (!a.length) throw new HttpsError('invalid-argument', 'Choose at least one practice area');
    p.practiceAreas = a;
  }
  if (cur.entityType === 'firm') {
    const f = Object.assign({}, cur.firm || {});
    let touched = false;
    if ('firmDescription' in d) { f.description = san(d.firmDescription, 2000); touched = true; }
    if ('offices' in d) { f.offices = _offices(d.offices); touched = true; }
    if ('team' in d) { f.teamDeclared = _team(d.team); f.teamVerified = false; touched = true; }
    if (touched) p.firm = f;
  }
  return p;
}
const PROTECTED = ['name', 'licenseNumber', 'firmName', 'entityType', 'firmRegistrationNumber', 'status', 'verification', 'rating', 'ratingCount', 'uid', 'providerId'];

_h.legalMyProfile = async (req) => {
  const uid = requireAuth(req);
  const [ps, as] = await Promise.all([db().collection('legalProviders').doc(uid).get(), db().collection('applications').doc('legal_' + uid).get()]);
  if (!ps.exists) return { exists: false };
  const p = ps.data(), a = as.exists ? as.data() : null, now = Date.now();
  const el = LV.eligibility(p, now), pv = LV.publicVerification(p, now);
  return {
    exists: true,
    profile: Object.assign(_publicAdvocate(p, now), {
      phone: p.phone || '', location: p.location || '', licenseNumber: p.licenseNumber || '',
      firm: p.entityType === 'firm' ? { registrationNumber: (p.firm && p.firm.registrationNumber) || '', description: (p.firm && p.firm.description) || '',
        offices: (p.firm && p.firm.offices) || [], team: (p.firm && p.firm.teamDeclared) || [], teamVerified: false } : null,
    }),
    application: a ? { id: as.id, type: a.applicationType || (p.entityType === 'firm' ? 'law_firm' : 'lawyer'), status: a.status || 'pending',
      reviewReason: a.reviewReason || null, decidedAtMs: a.decidedAt && a.decidedAt.toMillis ? a.decidedAt.toMillis() : null,
      submittedAtMs: a.createdAt && a.createdAt.toMillis ? a.createdAt.toMillis() : null } : null,
    verification: { sokoniVerified: pv.sokoniVerified, lskVerified: pv.lskVerified, lskPractisingYear: pv.lskPractisingYear, bookable: el.bookable, code: el.code },
    editable: SELF_EDITABLE.concat(p.entityType === 'firm' ? FIRM_EDITABLE : []),
  };
};

_h.legalUpdateProfile = async (req) => {
  const uid = requireAuth(req);
  const d = req.data || {};
  const tried = PROTECTED.filter((k) => k in d);
  if (tried.length) {
    throw new HttpsError('failed-precondition', 'These details are verified by SOKONI and can only be changed through a re-verification request: ' + tried.join(', ') + '. Nothing was changed.', { code: 'LEGAL_PROTECTED_FIELD', fields: tried });
  }
  const ref = db().collection('legalProviders').doc(uid);
  const out = await db().runTransaction(async (t) => {
    const svcRef = db().collection('providerServices').doc('legal_consult_' + uid);
    const [s, sv] = await Promise.all([t.get(ref), t.get(svcRef)]);
    if (!s.exists) throw new HttpsError('not-found', 'No Legal profile for this account. Register first.');
    const patch = _selfPatch(s.data(), d);
    if (!Object.keys(patch).length) throw new HttpsError('invalid-argument', 'Nothing to update.');
    t.update(ref, Object.assign({}, patch, { updatedAt: FieldValue.serverTimestamp() }));
    /* The consultation rate card (server price authority) follows the fee, in cents. It is active again only while
       the advocate is still eligible and priced — a self-service edit never opens booking on its own. */
    if ('consultationFee' in patch && sv.exists && sv.data().createdBy === LV.PROV_BY) {
      const cents = Math.round(patch.consultationFee * 100);
      t.set(svcRef, { price: cents, active: LV.eligibility(s.data(), Date.now()).bookable && cents > 0, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    }
    return Object.keys(patch);
  });
  return { ok: true, updated: out };
};

/* NEEDS INFORMATION → resubmit: the applicant answers an AdminOS request_info and the application returns to the
   queue as 'pending'. It can ONLY leave info_requested; it never approves, and it re-reads the status in a txn. */
_h.legalResubmitApplication = async (req) => {
  const uid = requireAuth(req);
  const d = req.data || {};
  const note = san(d.note, 1000);
  const appRef = db().collection('applications').doc('legal_' + uid);
  const lpRef = db().collection('legalProviders').doc(uid);
  await db().runTransaction(async (t) => {
    const [as, ls] = await Promise.all([t.get(appRef), t.get(lpRef)]);
    if (!as.exists || !ls.exists) throw new HttpsError('not-found', 'No Legal application for this account.');
    if (as.data().status !== 'info_requested') throw new HttpsError('failed-precondition', 'SOKONI has not asked for more information on this application.', { code: 'NOT_INFO_REQUESTED' });
    const tried = PROTECTED.filter((k) => k in d);
    if (tried.length) throw new HttpsError('failed-precondition', 'Verified details cannot be changed here: ' + tried.join(', ') + '. Nothing was changed.', { code: 'LEGAL_PROTECTED_FIELD', fields: tried });
    const patch = _selfPatch(ls.data(), d);
    if (Object.keys(patch).length) t.update(lpRef, Object.assign({}, patch, { updatedAt: FieldValue.serverTimestamp() }));
    t.update(appRef, { status: 'pending', statusCanonical: 'pending', applicantResponse: note || null,
      applicantRespondedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
      ...(patch.practiceAreas ? { practiceAreas: patch.practiceAreas, practiceGroups: TAX.groupsOf(patch.practiceAreas) } : {}) });
  });
  return { ok: true, status: 'pending' };
};

/* The taxonomy itself, for any client that cannot load the generated browser copy. Public, no auth. */
_h.legalTaxonomy = async () => ({ groups: TAX.GROUPS, legacy: TAX.LEGACY_TO_AREA, maxAreas: TAX.MAX_AREAS });

module.exports = {
  _h,
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
