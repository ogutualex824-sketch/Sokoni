/* ══════════════════════════════════════════════════════════════════════════
   SOKONI — Beta access control

   The invite-only model's authority layer. Everything else in the beta brief —
   waitlist experience, onboarding, dashboards, gamification — is presentation
   that sits on top of this. None of it is worth building until access itself is
   unforgeable.

   WHY CUSTOM CLAIMS, NOT A FIRESTORE READ
   Gating on a users/{uid} field means every gated page pays a Firestore read
   before it can render, and a client that skips the read is ungated. A custom
   claim travels inside the signed ID token: it costs nothing to read, cannot be
   forged, and — critically — is presented to Firestore RULES and to every Cloud
   Function automatically, so the same decision is enforced at every layer
   without each one re-implementing it.

   firestore.rules:65 already prevents a client writing betaStatus to its own
   user document (added when the field was introduced). This module is the only
   thing that may grant access, and it runs on the Admin SDK.

   STATES (from the brief)
     pending     applied, awaiting review        -> waitlist experience
     waitlisted  reviewed, not yet admitted      -> waitlist experience
     approved    full marketplace access
     founder     approved + founder recognition
     internal    staff
     suspended   access withdrawn, recoverable
     rejected    declined
   ══════════════════════════════════════════════════════════════════════════ */
'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const admin = require('firebase-admin');
const logger = require('firebase-functions/logger');
const { checkRateLimit } = require('./redis-rate-limiter');

const STATES = Object.freeze([
  'pending', 'waitlisted', 'approved', 'founder', 'internal', 'suspended', 'rejected',
]);

/* The only states that may enter the marketplace. Deliberately a allowlist, not
   a blocklist: a state added later is denied until someone decides otherwise,
   rather than silently admitted. */
const ADMITTED = Object.freeze(['approved', 'founder', 'internal']);

const USER_TYPES = Object.freeze(['buyer', 'merchant', 'rider', 'provider']);

function _assertAuth(req) {
  const uid = req.auth && req.auth.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in to continue.');
  return uid;
}

function _assertAdmin(req) {
  const uid = _assertAuth(req);
  const c = req.auth.token || {};
  if (!c.admin && !c.superAdmin) throw new HttpsError('permission-denied', 'Admin access required.');
  return uid;
}

const cut = (v, n) => (v == null ? null : String(v).slice(0, n));

/* ── betaApply ────────────────────────────────────────────────────────────
   A user asks to join. Deliberately does NOT set betaStatus to anything
   admitted — an application is a request, never a grant. */
exports.betaApply = onCall(
  { cors: true, enforceAppCheck: true, region: 'us-central1' },
  async (request) => {
    const uid = _assertAuth(request);
    await checkRateLimit(request, 'auth', { maxRequests: 5, windowSeconds: 3600 });

    const d = request.data || {};
    const userType = USER_TYPES.includes(d.userType) ? d.userType : 'buyer';

    const db = getFirestore();
    const userRef = db.collection('users').doc(uid);
    const snap = await userRef.get();
    const existing = snap.exists ? (snap.data() || {}) : {};

    /* Re-applying must never reset an existing decision — that would let a
       rejected or suspended user launder themselves back to pending. */
    if (existing.betaStatus && existing.betaStatus !== 'pending') {
      return { ok: true, unchanged: true, betaStatus: existing.betaStatus };
    }

    await userRef.set({
      betaStatus:      'pending',
      betaUserType:    userType,
      betaAppliedAt:   FieldValue.serverTimestamp(),
      betaCounty:      cut(d.county, 60),
      betaReferral:    cut(d.referral, 60),
      betaMotivation:  cut(d.motivation, 500),
    }, { merge: true });

    await db.collection('betaApplications').add({
      uid, userType,
      county: cut(d.county, 60), referral: cut(d.referral, 60),
      motivation: cut(d.motivation, 500),
      status: 'pending',
      email: (request.auth.token && request.auth.token.email) || null,
      createdAt: FieldValue.serverTimestamp(),
    });

    logger.info('[beta] application received', { uid, userType });
    return { ok: true, betaStatus: 'pending' };
  });

/* ── betaReview — admin decision, the ONLY path that grants access ──────── */
exports.betaReview = onCall(
  { cors: true, enforceAppCheck: true, region: 'us-central1' },
  async (request) => {
    const actor = _assertAdmin(request);
    await checkRateLimit(request, 'admin', { maxRequests: 120, windowSeconds: 60 });

    const { uid, decision, note } = request.data || {};
    if (!uid) throw new HttpsError('invalid-argument', 'uid required.');
    if (!STATES.includes(decision)) {
      throw new HttpsError('invalid-argument', 'decision must be one of: ' + STATES.join(', '));
    }

    const db = getFirestore();

    /* The claim is the enforcement point. Merge rather than replace: overwriting
       would silently strip admin/superAdmin from a staff account being admitted
       to the beta, which is a privilege LOSS bug that is easy to ship and hard
       to notice. */
    const user = await admin.auth().getUser(uid).catch(() => null);
    if (!user) throw new HttpsError('not-found', 'User not found.');

    const claims = Object.assign({}, user.customClaims || {}, {
      betaStatus: decision,
      betaAdmitted: ADMITTED.includes(decision),
    });
    await admin.auth().setCustomUserClaims(uid, claims);

    /* Mirrored to Firestore for querying and for the admin console. The CLAIM is
       authoritative; this copy is for listing and reporting. */
    await db.collection('users').doc(uid).set({
      betaStatus:      decision,
      betaReviewedAt:  FieldValue.serverTimestamp(),
      betaReviewedBy:  actor,
      betaReviewNote:  cut(note, 500),
    }, { merge: true });

    await db.collection('auditLog').add({
      action: 'beta_review', uid, decision, actor,
      note: cut(note, 500), ts: FieldValue.serverTimestamp(),
    });

    /* A revoked token forces the next request to fetch fresh claims. Without
       this a suspended user keeps marketplace access for up to an hour, which is
       the entire point of suspending them. */
    if (!ADMITTED.includes(decision)) {
      await admin.auth().revokeRefreshTokens(uid).catch((e) =>
        logger.warn('[beta] token revoke failed', { uid, err: e && e.message }));
    }

    logger.info('[beta] reviewed', { uid, decision, actor });
    return { ok: true, uid, betaStatus: decision, admitted: ADMITTED.includes(decision) };
  });

/* ── betaGetAccess — what the caller may do ─────────────────────────────── */
exports.betaGetAccess = onCall(
  { cors: true, enforceAppCheck: true, region: 'us-central1' },
  async (request) => {
    const uid = _assertAuth(request);
    const c = request.auth.token || {};

    /* Read the CLAIM first. The Firestore copy is a fallback for accounts
       reviewed before claims existed, and for the window between a review and
       the client refreshing its token. */
    let status = c.betaStatus || null;
    if (!status) {
      const snap = await getFirestore().collection('users').doc(uid).get();
      status = (snap.exists && snap.data().betaStatus) || null;
    }

    return {
      betaStatus: status || 'none',
      admitted:   ADMITTED.includes(status),
      /* Staff bypass the beta entirely — an admin locked out of their own
         platform by its access gate is a failure mode worth designing out. */
      isStaff:    !!(c.admin || c.superAdmin),
      claimPresent: !!c.betaStatus,
    };
  });

exports.BETA_STATES = STATES;
exports.BETA_ADMITTED = ADMITTED;
