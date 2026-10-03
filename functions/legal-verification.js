'use strict';
/**
 * SOKONI — LEGAL VERIFICATION AUTHORITY  (CHANGELOG 220 · docs/LEGAL_VERIFICATION.md)
 * ============================================================================================
 * An advocate is bookable on SOKONI only when TWO independent authorities agree:
 *
 *   1. SOKONI administrative verification — an AdminOS decision on the advocate's application
 *      (applicationDecide → application-lifecycle.applyDecision → applyAdminDecision below).
 *   2. LSK professional verification — the Law Society of Kenya practising status, taken from the
 *      official LSK source: Mode A an AUTHORIZED integration (lsk-adapter.js — NOT AVAILABLE today),
 *      Mode B an administrator checking the official LSK advocate search and recording the evidence.
 *
 * Admin approval alone is NOT "LSK verified". LSK evidence alone is NOT a SOKONI approval. The ONE
 * predicate that combines them is `eligibility()`; every surface that decides whether an advocate may
 * be listed, requested or booked calls it (legal-hub.js directory + consultation request, and the
 * canonical availability gate ent-availability.loadCalendar via bookingGate()). The browser may hide
 * an advocate; only this module decides.
 *
 * WHY THE EXISTING REGISTRY WAS NOT TRUSTWORTHY (the reason this module exists)
 *   - approveLegalProvider required a numeric `role >= 4` claim that nothing mints (event-hub.js:210),
 *     so no real administrator could approve an advocate; it is retired (legal-hub.js).
 *   - An AdminOS approval of a `legal` application wrote NOTHING to legalProviders
 *     (application-lifecycle DELEGATED_ROLES) — it only granted the `provider` claim.
 *   - The one `active` record (T.M.M) had a blank LSK number and verified:false, written by a script.
 *   - The public directory mapped every listed advocate to "✅ LSK".
 *
 * STATE (all server-written; firestore.rules: write:false on every collection below)
 *   legalProviders/{uid}.verification   the SUMMARY the predicate reads — admin.status, lsk.{status,
 *                                       practiceStatus, source, checkedAtMs, validUntilMs},
 *                                       providerLink.status, eligibility.{bookable, code}
 *   legalProviders/{uid}.status         a DERIVED label for legacy readers ('active' only when eligible)
 *   legalVerifications/{uid}            PRIVATE current detail: reviewer, reason, P.105, name returned,
 *                                       evidence reference, notes (admin read only)
 *   legalVerificationEvents/{id}        APPEND-ONLY history: actor, action, target, previous, next,
 *                                       reason, time (admin read only). Nothing is ever overwritten.
 *
 * LSK PRACTISING YEAR. LSK practising certificates run January–December, so an "Active" result is
 * current only until the end of the practising year it was checked in (Africa/Nairobi). A shorter
 * maximum age is CONFIGURABLE (platformConfig/legalVerificationPolicy.maxEvidenceAgeDays) and unset
 * by default — no interval is invented here. Staleness is evaluated at READ time, so a verification
 * cannot silently stay current by nobody touching it.
 *
 * BOOKING/PAYMENT — CONNECTED by Legal Hub L4 (owner brief 2026-10-03), the "one reviewed change" this header
 * reserved: LEGAL_BOOKING_ENABLED flips, and the projection opens the canonical identity + consultation service
 * ONLY while eligibility() holds. Money then runs on the shared rails and nowhere else:
 *   bookingCreateService → providerBookings (server price) → createPaymentIntent (service_booking) → IntaSend →
 *   verified webhook → paid_held → completion PIN → settleOnPinRelease → ONE calculateCommission → wallet.
 * Commission lane: none added. provider-hub sends Legal down the generic provider lane = RATES.services 5%, which
 * equals RATES.legal (agreed with sokoni-2f, commission authority); commission-config is untouched.
 * The eligibility predicate itself is UNCHANGED (owner-locked b24b052).
 */
const { HttpsError } = require('firebase-functions/v2/https');
const admin = require('firebase-admin');
const ADMIN = require('./admin-claim');
const LSK = require('./lsk-adapter');

const _db = () => admin.firestore();
const _FV = () => admin.firestore.FieldValue;
const _ts = () => _FV().serverTimestamp();

const PROV_BY = 'legal-verification';
const ADMIN_STATES = ['pending', 'approved', 'rejected', 'suspended'];
const LSK_STATES = ['pending', 'verified', 'failed', 'expired', 'suspended', 'unknown'];
/* The practising statuses LSK's public search reports. Only `Active` can pass the gate. */
const PRACTICE_STATUSES = ['Active', 'Inactive', 'Struck Off', 'Suspended', 'Unknown', 'Deceased'];
const PRACTICE_TO_LSK = { Active: 'verified', Inactive: 'failed', 'Struck Off': 'failed', Deceased: 'failed', Suspended: 'suspended', Unknown: 'unknown' };
const SOURCES = Object.freeze({
  OFFICIAL_SOURCE_MANUAL: 'lsk_official_source_manual',     /* Mode B — an admin checked the official LSK search */
  AUTHORIZED_INTEGRATION: 'lsk_authorized_integration',     /* Mode A — an authorized LSK integration answered */
});
const SOURCE_LABEL = {
  [SOURCES.OFFICIAL_SOURCE_MANUAL]: 'Official LSK source — checked and recorded by a SOKONI administrator (manual)',
  [SOURCES.AUTHORIZED_INTEGRATION]: 'Authorized LSK integration (automated)',
};
const EAT_MS = 3 * 3600 * 1000;   /* Africa/Nairobi, no DST */

/* Legal booking through the canonical engine stays OFF until the payment slice. Read through
   module.exports so the flip is one reviewed edit (and a test can exercise the eligible branch). */
const LEGAL_BOOKING_ENABLED = true;   /* L4 2026-10-03 — gated per advocate by eligibility(); see header */
function bookingEnabled() { return module.exports.LEGAL_BOOKING_ENABLED === true; }

/* ── pure helpers ──────────────────────────────────────────────────────────────────────── */
const _san = (s, n) => String(s == null ? '' : s).replace(/[<>]/g, '').trim().slice(0, n);

/** "P.105/1234/05", "p105/1234/2005", "P.105 / 1234 / 05" → "P.105/1234/05" (null when malformed). */
function normP105(raw) {
  const m = String(raw || '').toUpperCase().replace(/\s+/g, '').match(/^P\.?105\/(\d{1,6})\/(\d{2}|\d{4})$/);
  if (!m) return null;
  return 'P.105/' + String(Number(m[1])) + '/' + (m[2].length === 4 ? m[2].slice(2) : m[2]);
}

const _nameTokens = (s) => String(s || '').toLowerCase().replace(/^advocate\s+/, '').replace(/[^a-z\s'-]/g, ' ').split(/\s+/).filter((t) => t.length >= 2);
/** The LSK name must be the registered advocate's: ≥2 shared name tokens (1 when either side has one). */
function nameMatches(registered, returned) {
  const a = new Set(_nameTokens(registered)); const b = _nameTokens(returned);
  if (!a.size || !b.length) return false;
  const shared = b.filter((t) => a.has(t)).length;
  return shared >= Math.min(2, a.size, b.length);
}

function canonPractice(raw) {
  const k = String(raw || '').trim().toLowerCase().replace(/\s+/g, ' ');
  return PRACTICE_STATUSES.find((p) => p.toLowerCase() === k) || null;
}

/** End of the LSK practising year (31 Dec, 23:59:59.999 Africa/Nairobi) containing `ms`. */
function practisingYearEndMs(ms) {
  const y = new Date(ms + EAT_MS).getUTCFullYear();
  return Date.UTC(y + 1, 0, 1) - EAT_MS - 1;
}

function validUntilMs(checkedAtMs, pol) {
  let until = practisingYearEndMs(checkedAtMs);
  const days = pol && pol.maxEvidenceAgeDays;
  if (days) until = Math.min(until, checkedAtMs + days * 86400000);
  return until;
}

/**
 * THE Legal eligibility predicate. Pure: reads only the server-written summary on the advocate doc,
 * and evaluates staleness against `now`. Never trusts a stored `bookable` — it re-derives.
 * @returns {{bookable: boolean, code: string|null}}
 */
function eligibility(lp, now) {
  const t = Number.isFinite(now) ? now : Date.now();
  if (!lp) return { bookable: false, code: 'NOT_REGISTERED' };
  if (lp.quarantined === true) return { bookable: false, code: 'QUARANTINED' };
  const v = (lp.verification && typeof lp.verification === 'object') ? lp.verification : {};
  const a = ADMIN_STATES.includes(v.admin && v.admin.status) ? v.admin.status : 'pending';
  if (a !== 'approved') return { bookable: false, code: 'ADMIN_' + a.toUpperCase() };
  const l = (v.lsk && typeof v.lsk === 'object') ? v.lsk : {};
  const ls = LSK_STATES.includes(l.status) ? l.status : 'pending';
  if (ls !== 'verified') return { bookable: false, code: 'LSK_' + ls.toUpperCase() };
  if (l.practiceStatus !== 'Active') return { bookable: false, code: 'LSK_NOT_ACTIVE' };
  if (!Object.values(SOURCES).includes(l.source)) return { bookable: false, code: 'LSK_SOURCE_UNKNOWN' };
  if (!(Number(l.validUntilMs) > t)) return { bookable: false, code: 'LSK_STALE' };
  if (!(v.providerLink && v.providerLink.status === 'linked')) return { bookable: false, code: 'PROVIDER_NOT_LINKED' };
  return { bookable: true, code: null };
}

function derivedStatus(lp, el) {
  if (el.bookable) return 'active';
  const a = lp && lp.verification && lp.verification.admin && lp.verification.admin.status;
  if (a === 'rejected') return 'rejected';
  if (a === 'suspended') return 'suspended';
  if (a !== 'approved') return 'pending_review';
  return 'pending_verification';
}

/** What a public surface may say about an advocate — never evidence, reviewer, notes or P.105. */
function publicVerification(lp, now) {
  const el = eligibility(lp, now);
  const l = (lp && lp.verification && lp.verification.lsk) || {};
  return {
    sokoniVerified: el.bookable,
    lskVerified: el.bookable,                       /* never true unless the canonical state is verified AND current */
    lskPractisingYear: el.bookable && l.checkedAtMs ? new Date(Number(l.checkedAtMs) + EAT_MS).getUTCFullYear() : null,
  };
}

/* A provider that PRESENTS as legal (self-editable category text) without a legal record is an
   unverified advocate — the same rule Entertainment applies (ent-availability claimsEnt). */
const LEGAL_WORDS = /\b(law|legal|advocate|advocates|lawyer|lawyers|attorney|notary|conveyanc\w*)\b/i;
function claimsLegal(p) {
  if (!p) return false;
  return LEGAL_WORDS.test([p.category, p.subcategory, p.hubType].filter(Boolean).join(' '));
}

/**
 * The canonical availability authority asks HERE whether a provider may take bookings on Legal
 * grounds. null = no Legal objection. A code = NOT bookable (private code, never shown publicly).
 */
async function bookingGate(db, providerId, providerDoc, now) {
  const uid = String(providerId || '');
  if (!uid) return null;
  const s = await db.collection('legalProviders').doc(uid).get();
  const lp = s.exists ? s.data() : null;
  if (!lp && !claimsLegal(providerDoc) && !(providerDoc && providerDoc.legalProviderId)) return null;
  const el = eligibility(lp, now);
  if (!el.bookable) return 'LEGAL_' + el.code;
  if (!bookingEnabled()) return 'LEGAL_BOOKING_NOT_ENABLED';
  return null;
}

async function policy(db) {
  try {
    const s = await db.collection('platformConfig').doc('legalVerificationPolicy').get();
    const d = Number(s.exists ? (s.data() || {}).maxEvidenceAgeDays : NaN);
    return { maxEvidenceAgeDays: Number.isFinite(d) && d > 0 ? Math.floor(d) : null };
  } catch (_) { return { maxEvidenceAgeDays: null }; }
}

/* ── the projection: one derivation, written in the SAME transaction as the event ─────────── */
function _linkDecision(uid, prov) {
  if (!prov) return 'create';
  if (prov.provisionedBy === PROV_BY || prov.legalProviderId === uid) return 'linked';
  const st = String(prov.status || '');
  if (!st || ['pending', 'pending_approval', 'draft'].includes(st)) return 'adopt';
  return 'conflict';     /* an active provider of another kind — never merged, never repriced */
}

function _reads(txn, db, uid) {
  return Promise.all([
    txn.get(db.collection('legalProviders').doc(uid)),
    txn.get(db.collection('legalVerifications').doc(uid)),
    txn.get(db.collection('providers').doc(uid)),
    txn.get(db.collection('providerServices').doc('legal_consult_' + uid)),
    txn.get(db.collection('lawyers').doc(uid)),
  ]);
}

/** Write the derived summary, provider link, consultation service and public card. */
function _project(txn, db, uid, lp, snaps, now, opts) {
  const [, , provS, svcS, lawS] = snaps;
  const prov = provS.exists ? provS.data() : null;
  const v = Object.assign({}, lp.verification || {});
  const adminStatus = v.admin && v.admin.status;
  let link = v.providerLink || null;
  /* Link the canonical identity when (and only when) the advocate is administratively approved. */
  if (adminStatus === 'approved' && !(link && link.status === 'linked')) {
    const d = _linkDecision(uid, prov);
    link = d === 'conflict'
      ? { status: 'conflict', atMs: now, reason: 'providers/' + uid + ' is an active provider of another kind' }
      : { status: 'linked', atMs: now, how: d };
  }
  if (link) v.providerLink = link;
  const el = eligibility(Object.assign({}, lp, { verification: v }), now);
  v.eligibility = { bookable: el.bookable, code: el.code, derivedAtMs: now };
  const status = derivedStatus({ verification: v }, el);
  txn.set(db.collection('legalProviders').doc(uid), { verification: v, status, updatedAt: _ts() }, { merge: true });

  if (link && link.status === 'linked') {
    const pState = el.bookable ? 'active' : (adminStatus === 'approved' ? 'pending_verification' : 'suspended');
    txn.set(db.collection('providers').doc(uid), Object.assign({
      uid, providerId: uid, legalProviderId: uid, provisionedBy: PROV_BY,
      name: lp.name || '', businessName: lp.firmName || lp.name || '', category: 'legal', hubType: 'legal',
      status: pState, suspended: pState === 'suspended',
      /* L4: discoverable + bookable through the generic engine EXACTLY while the ONE predicate holds. A lapsed LSK
         check, an admin suspension or a quarantine re-projects these to false (the booking gate refuses as well). */
      searchable: el.bookable, isPublic: el.bookable, available: el.bookable, acceptsBookings: el.bookable,
      entityType: lp.entityType === 'firm' ? 'firm' : 'advocate',
      legalVerification: { bookable: el.bookable, code: el.code },
      updatedAt: _ts(),
    }, prov ? {} : { createdAt: _ts() }), { merge: true });
    /* The consultation rate card. Active only while eligible AND priced: a KES 0 consultation would be a booking
       with nothing to pay and nothing to settle, so it stays off until the advocate sets a fee. */
    const priceCents = Math.max(0, Math.round((Number(lp.consultationFee) || 0) * 100));
    if (!svcS.exists) {
      txn.set(db.collection('providerServices').doc('legal_consult_' + uid), {
        providerId: uid, name: 'Legal consultation', category: 'legal', legalConsultation: true, priceType: 'fixed',
        price: priceCents, currency: 'KES',
        durationMins: 60, active: el.bookable && priceCents > 0, createdBy: PROV_BY, createdAt: _ts(), updatedAt: _ts(),
      });
    } else if ((svcS.data() || {}).createdBy === PROV_BY) {
      txn.set(db.collection('providerServices').doc('legal_consult_' + uid),
        { active: el.bookable && Number((svcS.data() || {}).price) > 0, updatedAt: _ts() }, { merge: true });
    }
  }

  /* The public directory card (lawyers/{uid}) exists only while the advocate is eligible. */
  const law = lawS.exists ? lawS.data() : null;
  if (el.bookable) {
    const pv = publicVerification(Object.assign({}, lp, { verification: v }), now);
    txn.set(db.collection('lawyers').doc(uid), {
      name: lp.name || '', firm: lp.firmName || '', specialty: (lp.specializations || []).join(', '),
      practice: (lp.specializations || [])[0] || 'other', location: lp.county || lp.location || '', city: lp.county || '',
      description: _san(lp.bio, 300), languages: lp.languages || [], isOnline: lp.isOnline === true,
      practiceAreas: require('./shared/legal-taxonomy').areasOfProfile(lp), entityType: lp.entityType === 'firm' ? 'firm' : 'advocate',
      sokoniVerified: true, lskVerified: pv.lskVerified, lskPractisingYear: pv.lskPractisingYear,
      projectedBy: PROV_BY, status: 'active', searchable: true, updatedAt: _ts(),
    });
  } else if (law && law.projectedBy === PROV_BY) {
    txn.delete(db.collection('lawyers').doc(uid));
  }
  return { eligibility: el, providerLink: link, status };
}

function _event(txn, db, e, id) {
  const ref = id ? db.collection('legalVerificationEvents').doc(id) : db.collection('legalVerificationEvents').doc();
  txn.set(ref, Object.assign({ createdAt: _ts() }, e));
  return ref.id;
}

/* ── 1. SOKONI administrative verification (called by application-lifecycle ONLY) ─────────── */
const DECISION_STATUS = { approved: 'approved', rejected: 'rejected', suspended: 'suspended' };

/**
 * Apply an AdminOS decision on a `legal` application. The caller (applyDecision) has already
 * established the decision's authority (applicationDecide's server record + admin claim).
 * Idempotent per decision: the event id derives from the server decision record.
 */
async function applyAdminDecision(db, { uid, app, appId, status, decidedBy }) {
  const next = DECISION_STATUS[status];
  if (!next) return { collection: 'legalProviders', id: uid, action: 'ignored', status };
  if (!uid || !decidedBy) throw new Error('legal decision requires uid and decidedBy');
  let decAt = null; let reason = null;
  try {
    const d = await db.collection('applicationDecisions').doc(String(appId)).get();
    if (d.exists) { decAt = d.data().decidedAtMs || null; reason = d.data().reason || null; }
  } catch (_) { /* fall back below */ }
  if (!reason) reason = (app && (app.reviewReason || app.decisionReason)) || null;
  const eventId = ('adm_' + appId + '_' + next + '_' + (decAt || decidedBy)).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 140);
  const now = Date.now();
  let out = null;
  await db.runTransaction(async (txn) => {
    const snaps = await _reads(txn, db, uid);
    const evS = await txn.get(db.collection('legalVerificationEvents').doc(eventId));
    const qS = await txn.get(db.collection('legalProviderQuarantine').doc(uid));
    if (evS.exists) { out = { idempotent: true }; return; }
    /* A quarantined identity (e.g. the legacy T.M.M record) is never re-created by a decision. */
    if (qS.exists) throw new Error('legal identity ' + uid + ' is quarantined (' + (qS.data().reason || 'legacy record') + ') — release it deliberately before any decision');
    const [lpS, verS] = snaps;
    let lp = lpS.exists ? lpS.data() : null;
    if (lp && lp.quarantined === true) throw new Error('legal record is quarantined');
    if (!lp) {
      /* An application that reached AdminOS without a Legal record (another intake page): the Legal
         record is created FROM the application — the registry is never skipped again. */
      const a = app || {};
      lp = {
        providerId: uid, uid, source: 'application:' + appId,
        name: _san(a.name || a.fullName || a.businessName, 120), firmName: _san(a.firm || a.firmName, 120),
        licenseNumber: _san(a.licenseNumber || a.rollNo || a.lskNumber, 60), phone: _san(a.phone || a.phoneNumber, 20),
        county: _san(a.county || (a.location && a.location.county) || a.city, 80), country: 'Kenya',
        specializations: ['other'], consultationFee: 0, currency: 'KES', isOnline: true,
        rating: 0, ratingCount: 0, totalConsultations: 0, createdAt: _ts(),
      };
      txn.set(db.collection('legalProviders').doc(uid), lp, { merge: true });
    }
    const ver = verS.exists ? verS.data() : {};
    const prev = (ver.admin && ver.admin.status) || ((lp.verification && lp.verification.admin && lp.verification.admin.status) || 'pending');
    lp = Object.assign({}, lp, { verification: Object.assign({}, lp.verification || {}, { admin: { status: next, reviewedAtMs: now, eventId } }) });
    const res = _project(txn, db, uid, lp, snaps, now);
    txn.set(db.collection('legalVerifications').doc(uid), {
      uid, admin: { status: next, reviewedBy: decidedBy, reviewedAtMs: now, reason: _san(reason, 500) || null, applicationId: String(appId), eventId },
      updatedAt: _ts(),
    }, { merge: true });
    _event(txn, db, {
      uid, kind: 'admin_decision', actor: decidedBy, action: 'admin_' + next, target: 'legalProviders/' + uid,
      previous: prev, next, reason: _san(reason, 500) || null, applicationId: String(appId), atMs: now,
      eligibility: res.eligibility, providerLink: res.providerLink || null,
    }, eventId);
    out = res;
  });
  return Object.assign({ collection: 'legalProviders', id: uid, action: 'legal_admin_' + next }, out || {});
}

/* ── 2. LSK professional verification ──────────────────────────────────────────────────── */
/**
 * Record an LSK result. `source` is set by the CALLING PATH (Mode A adapter / Mode B admin op),
 * never by the client. Identity-bound: the P.105 must be the advocate's registered number; a name
 * that does not match is recorded as a FAILED verification (evidence of a mismatch), never refused
 * silently and never passed.
 */
async function _recordLsk(db, { uid, actor, source, p105Number, verifiedName, practiceStatus, checkedAtMs, evidenceRef, notes, integrationRef }) {
  const now = Date.now();
  const pol = await policy(db);
  let out = null;
  await db.runTransaction(async (txn) => {
    const snaps = await _reads(txn, db, uid);
    const [lpS, verS] = snaps;
    if (!lpS.exists) throw new HttpsError('not-found', 'No Legal record for this advocate.');
    const lp = lpS.data();
    if (lp.quarantined === true) throw new HttpsError('failed-precondition', 'This Legal record is quarantined.');
    const registered = normP105(lp.licenseNumber);
    if (!registered) throw new HttpsError('failed-precondition', 'The advocate has no valid registered P.105 number to verify.', { code: 'NO_REGISTERED_P105' });
    if (registered !== p105Number) throw new HttpsError('failed-precondition', 'That P.105 number is not the one this advocate registered (' + registered + ').', { code: 'P105_MISMATCH' });
    const matched = nameMatches(lp.name, verifiedName);
    let status = matched ? PRACTICE_TO_LSK[practiceStatus] : 'failed';
    const until = validUntilMs(checkedAtMs, pol);
    if (status === 'verified' && !(until > now)) status = 'expired';
    const ver = verS.exists ? verS.data() : {};
    const prev = ver.lsk || null;
    const eventRef = db.collection('legalVerificationEvents').doc();
    const summary = { status, practiceStatus, source, checkedAtMs, validUntilMs: until, nameMatched: matched, eventId: eventRef.id };
    const next = Object.assign({}, lp, { verification: Object.assign({}, lp.verification || {}, { lsk: summary }) });
    const res = _project(txn, db, uid, next, snaps, now);
    txn.set(db.collection('legalVerifications').doc(uid), {
      uid, lsk: Object.assign({}, summary, {
        p105Number, verifiedName, reviewedBy: actor, recordedAtMs: now, evidenceRef: evidenceRef || null,
        integrationRef: integrationRef || null, notes: notes || null, sourceLabel: SOURCE_LABEL[source],
      }), updatedAt: _ts(),
    }, { merge: true });
    txn.set(eventRef, {
      uid, kind: 'lsk_check', actor, action: 'lsk_' + status, target: 'legalProviders/' + uid,
      previous: prev ? { status: prev.status, practiceStatus: prev.practiceStatus, checkedAtMs: prev.checkedAtMs, source: prev.source } : null,
      next: { status, practiceStatus, checkedAtMs, validUntilMs: until, source },
      p105Number, verifiedName, nameMatched: matched, evidenceRef: evidenceRef || null, integrationRef: integrationRef || null,
      reason: notes || null, atMs: now, eligibility: res.eligibility, createdAt: _ts(),
    });
    out = Object.assign({ lsk: summary, auditRef: eventRef.id }, res);
  });
  return out;
}

/* ── the application record (so every advocate reaches AdminOS review) ─────────────────── */
async function ensureApplication(db, uid, lp) {
  const ref = db.collection('applications').doc('legal_' + uid);
  const s = await ref.get();
  if (s.exists) return { applicationId: ref.id, created: false };
  await ref.set({
    uid, role: 'legal', type: 'legal', hub: 'legal', category: 'legal', source: 'legal-hub',
    name: lp.name || '', firmName: lp.firmName || '', phone: lp.phone || '', email: lp.email || '',
    licenseNumber: lp.licenseNumber || '', county: lp.county || '',
    status: 'pending', createdAt: _ts(), updatedAt: _ts(),
  });
  return { applicationId: ref.id, created: true };
}

/* ── AdminOS ops (merged into adminOsDispatch; every op re-checks the canonical admin claim) ── */
function _requireAdmin(req) {
  if (!req || !req.auth || !req.auth.uid) throw new HttpsError('unauthenticated', 'Sign in required.');
  if (!ADMIN.isAdmin(req)) throw new HttpsError('permission-denied', 'Administrators only.');
  return req.auth.uid;
}
const _uidArg = (d) => { const u = _san(d && d.uid, 128); if (!u || /[\/]/.test(u)) throw new HttpsError('invalid-argument', 'uid is required.'); return u; };

function _summary(id, lp, now) {
  const v = (lp && lp.verification) || {};
  const l = v.lsk || {};
  const el = eligibility(lp, now);
  return {
    uid: id, name: lp.name || '', firmName: lp.firmName || '', registeredP105: lp.licenseNumber || '',
    specializations: lp.specializations || [], county: lp.county || '',
    /* Legal Hub L7: AdminOS tells a LAWYER from a LAW FIRM and sees the canonical practice areas (taxonomy ids). */
    entityType: lp.entityType === 'firm' ? 'firm' : 'advocate',
    practiceAreas: require('./shared/legal-taxonomy').areasOfProfile(lp),
    specialistRequested: require('./shared/legal-taxonomy').specialistRequestedOf(lp),
    specialistConfirmed: require('./shared/legal-taxonomy').specialistConfirmedOf(lp),
    firm: lp.entityType === 'firm' && lp.firm ? { registrationNumber: lp.firm.registrationNumber || '', offices: (lp.firm.offices || []).length,
      teamDeclared: (lp.firm.teamDeclared || []).length, teamVerified: false } : null,
    admin: (v.admin && v.admin.status) || 'pending',
    lsk: { status: l.status || 'pending', practiceStatus: l.practiceStatus || null, source: l.source || null,
      sourceLabel: SOURCE_LABEL[l.source] || null, checkedAtMs: l.checkedAtMs || null, validUntilMs: l.validUntilMs || null,
      stale: !!(l.status === 'verified' && !(Number(l.validUntilMs) > now)) },
    providerLink: v.providerLink || null, eligibility: el, legacyStatus: lp.status || null,
    legacyUnverified: !v.admin && !v.lsk,
  };
}

const _adminH = {};

_adminH.legalAdminList = async (req) => {
  _requireAdmin(req);
  const db = _db(); const now = Date.now();
  const view = _san(req.data && req.data.view, 20) || 'all';
  if (view === 'quarantined') {
    const q = await db.collection('legalProviderQuarantine').limit(200).get();
    return { view, quarantined: q.docs.map((d) => ({ uid: d.id, label: d.data().label || null, reason: d.data().reason || null, removedAtMs: d.data().removedAtMs || null, scriptVersion: d.data().scriptVersion || null })) };
  }
  const snap = await db.collection('legalProviders').limit(300).get();
  let rows = snap.docs.map((d) => _summary(d.id, d.data(), now));
  if (view === 'bookable') rows = rows.filter((r) => r.eligibility.bookable);
  else if (view === 'pending') rows = rows.filter((r) => !r.eligibility.bookable && r.admin !== 'rejected');
  /* L7: lawyer vs law-firm filter (an unknown value lists nothing, never everyone). */
  const et = _san(req.data && req.data.entityType, 12);
  if (et) rows = ['advocate', 'firm'].includes(et) ? rows.filter((r) => r.entityType === et) : [];
  return { view, advocates: rows, lskIntegration: { available: LSK.available(), statement: LSK.STATUS.reason } };
};

/* L10 — confirm / revoke a SPECIALIST practice area (criminal law, immigration, tax) for one advocate. Owner decision
   2026-10-03: these are separately configured, admin-confirmed services. Audited (legalVerificationEvents + adminAudit).
   Confirming needs the advocate's own request; it never changes booking eligibility (that stays eligibility()). */
_adminH.legalAdminConfirmSpecialist = async (req) => {
  const actor = _requireAdmin(req);
  const d = req.data || {};
  const uid = _uidArg(d);
  const TAX = require('./shared/legal-taxonomy');
  const area = _san(d.area, 40).toLowerCase();
  if (!TAX.isSpecialist(area)) throw new HttpsError('invalid-argument', 'Not a specialist practice area.', { code: 'NOT_SPECIALIST_AREA' });
  const confirm = d.confirm === true;
  const reason = _san(d.reason, 500);
  if (reason.length < 3) throw new HttpsError('invalid-argument', 'A reason is required (what you checked).');
  const db = _db(); const ref = db.collection('legalProviders').doc(uid);
  const evRef = db.collection('legalVerificationEvents').doc();
  await db.runTransaction(async (txn) => {
    const s = await txn.get(ref);
    if (!s.exists) throw new HttpsError('not-found', 'No Legal record for this advocate.');
    const lp = s.data();
    if (confirm && TAX.specialistRequestedOf(lp).indexOf(area) < 0) throw new HttpsError('failed-precondition', 'The advocate has not requested this specialist area.', { code: 'NOT_REQUESTED' });
    const cur = TAX.normalizeSpecialist(lp.specialistConfirmed);
    const next = confirm ? (cur.indexOf(area) > -1 ? cur : cur.concat([area])) : cur.filter((a) => a !== area);
    txn.set(ref, { specialistConfirmed: next, updatedAt: _ts() }, { merge: true });
    txn.set(evRef, { uid, type: confirm ? 'specialist_confirmed' : 'specialist_revoked', area, reason, actor, atMs: Date.now(), createdAt: _ts() });
  });
  await db.collection('adminAudit').add({ action: confirm ? 'legal_specialist_confirm' : 'legal_specialist_revoke', targetUid: uid, area, reason, performedBy: actor, createdAt: _ts() }).catch(() => {});
  return { ok: true, uid, area, confirmed: confirm };
};

_adminH.legalAdminGet = async (req) => {
  _requireAdmin(req);
  const db = _db(); const uid = _uidArg(req.data); const now = Date.now();
  const [lpS, verS, provS, evS, appS] = await Promise.all([
    db.collection('legalProviders').doc(uid).get(),
    db.collection('legalVerifications').doc(uid).get(),
    db.collection('providers').doc(uid).get(),
    db.collection('legalVerificationEvents').where('uid', '==', uid).limit(200).get(),
    db.collection('applications').where('uid', '==', uid).limit(20).get(),
  ]);
  if (!lpS.exists) throw new HttpsError('not-found', 'No Legal record for this advocate.');
  const prov = provS.exists ? provS.data() : null;
  const apps = appS.docs.map((d) => ({ id: d.id, role: d.data().role || null, status: d.data().status || null, decidedBy: d.data().decidedBy || null }))
    .filter((a) => a.role === 'legal' || /^legal_/.test(a.id));
  return {
    advocate: _summary(uid, lpS.data(), now),
    private: verS.exists ? verS.data() : null,
    provider: prov ? { status: prov.status || null, provisionedBy: prov.provisionedBy || null, legalProviderId: prov.legalProviderId || null, acceptsBookings: prov.acceptsBookings !== false } : null,
    applications: apps,
    events: evS.docs.map((d) => Object.assign({ id: d.id }, d.data(), { createdAt: undefined })).sort((a, b) => (b.atMs || 0) - (a.atMs || 0)),
    bookingEnabled: bookingEnabled(),
    lskIntegration: { available: LSK.available(), statement: LSK.STATUS.reason },
  };
};

/** Mode B — the administrator checked the OFFICIAL LSK advocate search; record what it said. */
_adminH.legalAdminRecordLsk = async (req) => {
  const actor = _requireAdmin(req);
  const d = req.data || {};
  const uid = _uidArg(d);
  const p105Number = normP105(d.p105Number);
  if (!p105Number) throw new HttpsError('invalid-argument', 'Enter the practising number exactly as LSK shows it (P.105/…/…).');
  const practiceStatus = canonPractice(d.practiceStatus);
  if (!practiceStatus) throw new HttpsError('invalid-argument', 'Practising status must be one LSK reports: ' + PRACTICE_STATUSES.join(', ') + '.');
  const verifiedName = _san(d.verifiedName, 120);
  if (verifiedName.length < 3) throw new HttpsError('invalid-argument', 'Enter the name LSK returned.');
  const evidenceRef = _san(d.evidenceRef, 300);
  if (evidenceRef.length < 3) throw new HttpsError('invalid-argument', 'An evidence reference is required (what you checked and where it is kept).');
  const checkedAtMs = typeof d.checkedAt === 'number' ? d.checkedAt : Date.parse(String(d.checkedAt || ''));
  if (!Number.isFinite(checkedAtMs)) throw new HttpsError('invalid-argument', 'Enter the date you checked LSK.');
  if (checkedAtMs > Date.now() + 5 * 60000) throw new HttpsError('invalid-argument', 'The check date cannot be in the future.');
  if (checkedAtMs < Date.now() - 400 * 86400000) throw new HttpsError('invalid-argument', 'That check is too old to record — check LSK again.');
  return _recordLsk(_db(), { uid, actor, source: SOURCES.OFFICIAL_SOURCE_MANUAL, p105Number, verifiedName, practiceStatus, checkedAtMs, evidenceRef, notes: _san(d.notes, 500) || null });
};

/** Mode A — an authorized LSK integration. Refuses plainly while none is configured. */
_adminH.legalAdminRunLskCheck = async (req) => {
  const actor = _requireAdmin(req);
  const uid = _uidArg(req.data);
  if (!LSK.available()) return { available: false, statement: LSK.STATUS.reason };
  const lpS = await _db().collection('legalProviders').doc(uid).get();
  if (!lpS.exists) throw new HttpsError('not-found', 'No Legal record for this advocate.');
  const p105Number = normP105(lpS.data().licenseNumber);
  if (!p105Number) throw new HttpsError('failed-precondition', 'The advocate has no valid registered P.105 number.');
  const r = await LSK.lookup(p105Number);
  const practiceStatus = canonPractice(r && r.practiceStatus);
  if (!r || !practiceStatus || normP105(r.p105Number) !== p105Number) throw new HttpsError('internal', 'The LSK integration returned an unusable result.');
  return _recordLsk(_db(), { uid, actor, source: SOURCES.AUTHORIZED_INTEGRATION, p105Number, verifiedName: _san(r.name, 120),
    practiceStatus, checkedAtMs: Number(r.checkedAtMs) || Date.now(), evidenceRef: null, integrationRef: _san(r.reference, 200) || null, notes: null });
};

/** Re-verification: the current LSK result stops counting until a new check is recorded. */
_adminH.legalAdminRequestRecheck = async (req) => {
  const actor = _requireAdmin(req);
  const uid = _uidArg(req.data);
  const reason = _san(req.data && req.data.reason, 500);
  if (reason.length < 3) throw new HttpsError('invalid-argument', 'A reason is required.');
  const db = _db(); const now = Date.now();
  let out = null;
  await db.runTransaction(async (txn) => {
    const snaps = await _reads(txn, db, uid);
    const [lpS, verS] = snaps;
    if (!lpS.exists) throw new HttpsError('not-found', 'No Legal record for this advocate.');
    const lp = lpS.data();
    const prev = (verS.exists && verS.data().lsk) || (lp.verification && lp.verification.lsk) || null;
    const eventRef = db.collection('legalVerificationEvents').doc();
    const summary = { status: 'pending', practiceStatus: null, source: null, checkedAtMs: null, validUntilMs: null, recheckRequestedAtMs: now, eventId: eventRef.id };
    const res = _project(txn, db, uid, Object.assign({}, lp, { verification: Object.assign({}, lp.verification || {}, { lsk: summary }) }), snaps, now);
    txn.set(db.collection('legalVerifications').doc(uid), { uid, lsk: Object.assign({}, summary, { requestedBy: actor, reason }), lskPrevious: prev, updatedAt: _ts() }, { merge: true });
    txn.set(eventRef, { uid, kind: 'lsk_recheck_requested', actor, action: 'lsk_recheck_requested', target: 'legalProviders/' + uid,
      previous: prev ? { status: prev.status, practiceStatus: prev.practiceStatus || null, checkedAtMs: prev.checkedAtMs || null, source: prev.source || null } : null,
      next: { status: 'pending' }, reason, atMs: now, eligibility: res.eligibility, createdAt: _ts() });
    out = res;
  });
  return out;
};

/** Put an advocate who has no application (legacy registration) into the AdminOS review queue. */
_adminH.legalAdminOpenReview = async (req) => {
  _requireAdmin(req);
  const db = _db(); const uid = _uidArg(req.data);
  const s = await db.collection('legalProviders').doc(uid).get();
  if (!s.exists) throw new HttpsError('not-found', 'No Legal record for this advocate.');
  if (s.data().quarantined === true) throw new HttpsError('failed-precondition', 'This Legal record is quarantined.');
  return ensureApplication(db, uid, s.data());
};

module.exports = {
  eligibility, bookingGate, bookingEnabled, LEGAL_BOOKING_ENABLED, publicVerification, derivedStatus, claimsLegal,
  applyAdminDecision, ensureApplication, normP105, nameMatches, canonPractice, practisingYearEndMs, validUntilMs,
  PRACTICE_STATUSES, SOURCES, SOURCE_LABEL, PROV_BY, _adminH,
};
