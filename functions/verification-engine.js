/* ═══════════════════════════════════════════════════════════════════════════
   SOKONI Verification Engine — the ONE authoritative decision path.

   Replaces a flow that could never complete in either direction:

     · SUBMIT  — verification.html never wrote applicantUid, so every create was
                 denied by the rule requiring applicantUid == auth.uid. It failed
                 even earlier: the duplicate-check query filtered on `email`,
                 which the read rule cannot satisfy, so the query itself was
                 rejected. Zero requests were ever stored.
     · APPROVE — verification-admin.html issued FIVE sequential un-transacted
                 writes. The second (setDoc on verifications/{uid}) was a CREATE,
                 and the create rule had no admin branch, so it threw and aborted
                 the remaining three. The request was left `approved` with no
                 badge, no notification and no audit entry.

   Both ends are now server-owned and both collections are `write: if false` for
   clients. The decision is ONE transaction: request state, canonical facet,
   audit event and notification commit together or not at all.
   ═══════════════════════════════════════════════════════════════════════════ */

'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const logger = require('firebase-functions/logger');
const admin  = require('firebase-admin');

if (!admin.apps.length) admin.initializeApp();
const db         = admin.firestore();
const FieldValue = admin.firestore.FieldValue;
const Timestamp  = admin.firestore.Timestamp;

const V = require('./verification-vocabulary');

const REGION = 'us-central1';
const OPEN_STATES = ['pending'];

/* ── Guards ──────────────────────────────────────────────────────────────── */

function _assertAuth(req) {
  if (!req.auth) throw new HttpsError('unauthenticated', 'Sign in required.');
  return req.auth.uid;
}

function _assertAdmin(req) {
  if (!req.auth) throw new HttpsError('unauthenticated', 'Sign in required.');
  const t = req.auth.token || {};
  if (t.admin !== true && t.superAdmin !== true) {
    throw new HttpsError('permission-denied', 'Administrator access required.');
  }
  return req.auth.uid;
}

/* Approved roles from VERIFIED CUSTOM CLAIMS only.
   Deliberately not users.roles and not any client-supplied field: those are
   writable by the account holder, and eligibility that trusts them is the same
   forged-flag class closed elsewhere in this release. */
function _approvedRoles(req) {
  const t = req.auth && req.auth.token ? req.auth.token : {};
  const out = [];
  for (const role of ['buyer', 'seller', 'provider', 'mechanic', 'rider',
                      'health', 'legal', 'landlord', 'tenant', 'admin', 'staff']) {
    if (t[role] === true) out.push(role);
  }
  return out;
}

function _str(v, max) {
  return String(v == null ? '' : v).trim().slice(0, max || 500);
}

/* Accepts an ISO string or epoch ms; returns a Timestamp or null. */
function _toTimestamp(v) {
  if (v == null || v === '') return null;
  const ms = typeof v === 'number' ? v : Date.parse(v);
  if (isNaN(ms)) throw new HttpsError('invalid-argument', 'expiresAt must be an ISO date or epoch milliseconds.');
  return Timestamp.fromMillis(ms);
}

/* ── 1. verificationSubmit ───────────────────────────────────────────────────
   The applicant is ALWAYS req.auth.uid. There is no uid parameter. */

exports.verificationSubmit = onCall({ region: REGION }, async (req) => {
  const uid   = _assertAuth(req);
  const facet = V.canonicalFacet(req.data && req.data.facet);

  if (!facet) {
    throw new HttpsError('invalid-argument',
      'A valid verification type is required. Received: ' + _str(req.data && req.data.facet, 40));
  }

  /* Eligibility is decided against approved claims, server-side. */
  if (!V.isEligible(facet, _approvedRoles(req))) {
    throw new HttpsError('permission-denied',
      'Your account is not eligible for this verification type.');
  }

  /* One open request per (applicant, facet). This is the check the old client
     tried to do with an `email` query the rules could never permit. */
  const dupe = await db.collection('verificationRequests')
    .where('applicantUid', '==', uid)
    .where('facet', '==', facet)
    .where('state', 'in', OPEN_STATES)
    .limit(1)
    .get();

  if (!dupe.empty) {
    throw new HttpsError('already-exists',
      'You already have a pending application for this verification. Please wait for it to be reviewed.');
  }

  const f = (req.data && req.data.fields) || {};
  const ref = db.collection('verificationRequests').doc();

  await ref.set({
    requestId:    ref.id,
    applicantUid: uid,                       /* from auth — never from the client */
    facet,
    state:        'pending',
    submittedAt:  FieldValue.serverTimestamp(),
    evidence:     (Array.isArray(req.data && req.data.evidence) ? req.data.evidence : [])
                    .slice(0, 10).map(e => _str(e, 500)),
    fields: {
      fullName:     _str(f.fullName, 120),
      idNumber:     _str(f.idNumber, 40),
      phone:        _str(f.phone, 30),
      email:        _str(f.email, 160),
      practiceName: _str(f.practiceName, 160),
      kraPin:       _str(f.kraPin, 30),
      address:      _str(f.address, 240),
      county:       _str(f.county, 80),
      description:  _str(f.description, 2000),
      links:        _str(f.links, 500),
    },
  });

  logger.info('[verification] submitted', { uid, facet, requestId: ref.id });
  return { requestId: ref.id, facet, state: 'pending' };
});

/* ── 2. verificationDecide ───────────────────────────────────────────────────
   NOTE: there is no `uid` parameter, by design. The applicant is read from the
   request document, so this cannot be repurposed into a generic writer. */

exports.verificationDecide = onCall({ region: REGION }, async (req) => {
  const adminUid = _assertAdmin(req);
  const d        = req.data || {};
  const requestId = _str(d.requestId, 128);
  const decision  = _str(d.decision, 20);
  const reason    = _str(d.reason, 1000) || null;

  if (!requestId) throw new HttpsError('invalid-argument', 'requestId is required.');
  if (decision !== 'approved' && decision !== 'rejected') {
    throw new HttpsError('invalid-argument', "decision must be 'approved' or 'rejected'.");
  }

  const expiresAt = _toTimestamp(d.expiresAt);
  const adminEmail = (req.auth.token && req.auth.token.email) || adminUid;

  const reqRef   = db.collection('verificationRequests').doc(requestId);
  const auditRef = db.collection('adminLog').doc();
  const notifRef = db.collection('notifications').doc();

  const result = await db.runTransaction(async (tx) => {
    /* ── all reads first ── */
    const reqSnap = await tx.get(reqRef);
    if (!reqSnap.exists) throw new HttpsError('not-found', 'Verification request not found.');

    const request = reqSnap.data();
    const uid     = request.applicantUid;               /* <-- the ONLY source of uid */
    const facet   = V.canonicalFacet(request.facet);

    if (!uid)   throw new HttpsError('failed-precondition', 'Request has no applicant.');
    if (!facet) throw new HttpsError('failed-precondition', 'Request has no valid facet.');

    if (decision === 'approved' && V.expiryRequired(facet) && !expiresAt) {
      throw new HttpsError('invalid-argument',
        'This verification requires an expiry date (expiresAt).');
    }

    const verRef  = db.collection('verifications').doc(uid);
    const verSnap = await tx.get(verRef);
    const existing = verSnap.exists ? (verSnap.data() || {}) : {};
    const current  = (existing.facets || {})[facet] || null;

    /* ── idempotency ──
       The same decision, already applied from the same request, is a no-op.
       A DIFFERENT decision on the same request is a legitimate correction and
       proceeds. */
    if (request.state === decision && current &&
        current.requestId === requestId &&
        current.state === (decision === 'approved' ? 'approved' : 'rejected')) {
      return { ok: true, unchanged: true, uid, facet };
    }

    /* ── writes ── */
    tx.set(reqRef, {
      state:      decision,
      decidedAt:  FieldValue.serverTimestamp(),
      decidedBy:  adminEmail,
      reason,
    }, { merge: true });

    tx.set(verRef, {
      uid,
      facets: {
        [facet]: {
          state:     decision === 'approved' ? 'approved' : 'rejected',
          decidedAt: FieldValue.serverTimestamp(),
          decidedBy: adminEmail,
          requestId,
          reason,
          expiresAt: decision === 'approved' ? (expiresAt || null) : null,
        },
      },
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });

    tx.set(auditRef, {
      action:      'verification.' + decision,
      adminEmail,
      adminUid,
      targetUid:   uid,
      facet,
      requestId,
      reason,
      createdAt:   FieldValue.serverTimestamp(),
    });

    tx.set(notifRef, {
      userId: uid,
      type:   'verification_' + decision,
      title:  decision === 'approved' ? "You're verified" : 'Verification update',
      body:   decision === 'approved'
                ? 'Your ' + facet.replace(/_/g, ' ') + ' verification has been approved.'
                : 'Your ' + facet.replace(/_/g, ' ') + ' verification was not approved.'
                  + (reason ? ' Reason: ' + reason : '') + ' You may re-apply.',
      read:      false,
      createdAt: FieldValue.serverTimestamp(),
    });

    return { ok: true, unchanged: false, uid, facet };
  });

  logger.info('[verification] decided', { requestId, decision, ...result });
  return result;
});

/* ── 3. verificationRevoke ───────────────────────────────────────────────────
   Revocation is first-class: the old flow could reject a request while leaving
   an approved badge standing, because it had no way to say "no longer true". */

exports.verificationRevoke = onCall({ region: REGION }, async (req) => {
  const adminUid = _assertAdmin(req);
  const d     = req.data || {};
  const uid   = _str(d.uid, 128);
  const facet = V.canonicalFacet(d.facet);
  const reason = _str(d.reason, 1000) || null;

  if (!uid)   throw new HttpsError('invalid-argument', 'uid is required.');
  if (!facet) throw new HttpsError('invalid-argument', 'A valid facet is required.');

  const adminEmail = (req.auth.token && req.auth.token.email) || adminUid;
  const verRef   = db.collection('verifications').doc(uid);
  const auditRef = db.collection('adminLog').doc();
  const notifRef = db.collection('notifications').doc();

  const result = await db.runTransaction(async (tx) => {
    const verSnap = await tx.get(verRef);
    if (!verSnap.exists) throw new HttpsError('not-found', 'No verification record for this account.');

    const current = ((verSnap.data() || {}).facets || {})[facet] || null;
    if (!current) throw new HttpsError('not-found', 'That verification was never granted.');
    if (current.state === 'revoked') return { ok: true, unchanged: true, uid, facet };

    tx.set(verRef, {
      facets: {
        [facet]: {
          state:     'revoked',
          decidedAt: FieldValue.serverTimestamp(),
          decidedBy: adminEmail,
          requestId: current.requestId || null,
          reason,
          expiresAt: null,
        },
      },
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });

    tx.set(auditRef, {
      action: 'verification.revoked', adminEmail, adminUid,
      targetUid: uid, facet, reason, createdAt: FieldValue.serverTimestamp(),
    });

    tx.set(notifRef, {
      userId: uid, type: 'verification_revoked',
      title: 'Verification update',
      body:  'Your ' + facet.replace(/_/g, ' ') + ' verification has been withdrawn.'
             + (reason ? ' Reason: ' + reason : ''),
      read: false, createdAt: FieldValue.serverTimestamp(),
    });

    return { ok: true, unchanged: false, uid, facet };
  });

  logger.info('[verification] revoked', { uid, facet, adminUid });
  return result;
});
