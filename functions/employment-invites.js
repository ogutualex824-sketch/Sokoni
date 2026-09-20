'use strict';
/**
 * SOKONI Employment Invitations — binding a real human to an employment record.
 *
 * ADR-035 §3, §6. Gate 3 mechanism #3.
 *
 * ── WHAT THIS IS ────────────────────────────────────────────────────────────
 * The first consumer of `employmentEvent()`. Three operations — send, accept,
 * revoke — each writing its state change and its history entry in ONE
 * transaction, so the record and the event that explains it land together or
 * not at all.
 *
 * ── BINDING IS TWO-SIDED ────────────────────────────────────────────────────
 * An owner naming a uid is an assertion about who gets paid, made by the party
 * paying. So the organization INVITES and the holder of the account ACCEPTS.
 * The identity anchor is `invite.email === request.auth.token.email` — the
 * proven anchor from `acceptShopInvite`, which this is modelled on. Knowing an
 * employee number proves nothing; holding the invited mailbox does.
 *
 * ── MODELLED ON shopInvites, DELIBERATELY NOT REUSING IT ────────────────────
 * Copied: a server-minted token, a 7-day expiry, pending → accepted|revoked,
 * and email-bound acceptance. NOT copied:
 *
 *   · `allow get: if true`. shopInvites is world-readable by token, which is
 *     tolerable for a document carrying an email and a shop role. An employment
 *     invitation names a salary-bearing relationship, so this collection is
 *     entirely CF-only and the token is a CALLABLE capability, never a read key.
 *   · the non-transactional acceptance — four sequential writes, where two
 *     concurrent accepts could both observe `pending`.
 *   · `data.expiresAt.toDate()` unguarded, which throws TypeError rather than
 *     refusing when the field is absent.
 *   · writing `users/{uid}.role = 'employee'`. Employment binding must not
 *     silently re-role a person on the platform.
 *
 * shopInvites, acceptShopInvite, inviteShopEmployee, revokeShopInvite and
 * shopEmployees are untouched by this module.
 *
 * ── WHAT THIS DELIBERATELY DOES NOT DO ──────────────────────────────────────
 * KNOWN PRE-#1 GAP: acceptance binds a uid WITHOUT enforcing the
 * `(businessId, uid)` uniqueness invariant of ADR-035 §4. Two active employment
 * records for one person in one business remain reachable until mechanism #1
 * lands. Stated, not overlooked — enforcing it here would pull #1's undecided
 * mechanism (claim document vs transactional query) into the binding gate.
 *
 * Also absent: work status (#5), shop assignment (#7), payability (#6) and any
 * history-read callable.
 */

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const admin = require('firebase-admin');
const crypto = require('crypto');
const { resolveMerchantAccess } = require('./merchant-authority');
const { employmentEvent, EVENTS } = require('./employment-events');

const db = admin.firestore();
const F = admin.firestore.FieldValue;
const OPT = { region: 'us-central1', enforceAppCheck: true };
const _h = {};

const INVITES = 'employmentInvites';
const STAFF = 'hrStaff';
const INVITE_TTL_MS = 7 * 86400000;

/** Invitation lifecycle. `superseded` is owned by THIS collection, not by the
    employment history: replacing an invitation changes no employment state
    (pending → pending), so it is not an employment event (ADR-035 §6). */
const INVITE_STATUS = Object.freeze(['pending', 'accepted', 'revoked', 'superseded']);

const PENDING = Object.freeze({ employmentStatus: 'pending', workStatus: null });
const WORKING = Object.freeze({ employmentStatus: 'active', workStatus: 'working' });
const ENDED = Object.freeze({ employmentStatus: 'terminated', workStatus: null });

function _auth (req) {
  if (!req.auth || !req.auth.uid) throw new HttpsError('unauthenticated', 'Sign in required.');
  return req.auth;
}
function _str (v, max) { return String(v == null ? '' : v).trim().slice(0, max); }

/** A reason is required on every employment transition (ADR-010). */
function _reason (v) {
  if (typeof v !== 'string' || v.trim() === '') {
    throw new HttpsError('invalid-argument', 'reason is required and must be non-empty.');
  }
  return v.trim();
}

/**
 * ESTABLISHMENT AUTHORITY. Creating, replacing or ending an employment
 * relationship is owner authority, not merchant access (ADR-035 §2):
 *   `admin` — in adminUids, but access is not employment authority
 *   `self`  — merchantId === uid, which reads NO document and cannot even
 *             confirm the organization exists
 * The resolver decides the provenance ONCE; the caller records what it decided.
 */
async function _assertOwner (auth, businessId) {
  const { merchantId, via } = await resolveMerchantAccess(auth, businessId);
  if (via !== 'owner' && via !== 'platform') {
    throw new HttpsError('permission-denied',
      'Only the business owner may manage employment invitations.');
  }
  return { merchantId, via };
}

/** The employment must exist and still be PENDING for any invitation act. */
function _requirePendingEmployment (snap, staffId) {
  if (!snap.exists) {
    throw new HttpsError('not-found', `No employment record ${staffId}.`);
  }
  const d = snap.data() || {};
  if (d.employmentStatus !== 'pending') {
    /* FAILS CLOSED. An invitation must never RESURRECT an employment: a
       terminated record stays terminated even when the token and the email are
       both valid. */
    throw new HttpsError('failed-precondition',
      `Employment ${staffId} is '${d.employmentStatus}', not 'pending'.`);
  }
  return d;
}

/* ══════════════════════════════════════════════════════════════════════════
   1. SEND — and RESEND, which supersedes whatever was live
   ══════════════════════════════════════════════════════════════════════════ */
/**
 * Issue an invitation for a pending employment. Re-issuing supersedes every
 * invitation that was still pending, so ONE employment has AT MOST ONE
 * acceptable invitation while every issuance stays in the history.
 *
 * @param {object} data
 * @param {string} data.staffId  `${merchantId}_${employeeNumber}`
 * @param {string} data.reason   REQUIRED
 * @returns {{ token: string, staffId: string, supersededCount: number }}
 */
const sendEmploymentInvite = onCall(OPT, _h.sendEmploymentInvite = async (req) => {
  const auth = _auth(req);
  const staffId = _str(req.data && req.data.staffId, 200);
  if (!staffId || staffId.includes('/')) {
    throw new HttpsError('invalid-argument', 'A valid staffId is required.');
  }
  const reason = _reason(req.data && req.data.reason);

  const staffRef = db.collection(STAFF).doc(staffId);

  /* The organization is read off the EMPLOYMENT RECORD, never taken from the
     request — the record-anchored pattern (ADR-035, mechanism #2). */
  const pre = await staffRef.get();
  const preData = _requirePendingEmployment(pre, staffId);
  const businessId = preData.merchantId;
  if (!businessId) {
    throw new HttpsError('permission-denied', 'Employment record names no organization.');
  }
  const { via } = await _assertOwner(auth, businessId);

  const email = _str(preData.email, 320).toLowerCase();
  if (!email) {
    throw new HttpsError('failed-precondition',
      'This employment record has no email address, so there is nobody to invite.');
  }

  const token = crypto.randomUUID();
  const inviteRef = db.collection(INVITES).doc(token);

  /* Built outside the transaction — employmentEvent performs no I/O. */
  const ev = employmentEvent({
    businessId, staffId,
    event: EVENTS.INVITE_SENT,
    previousStatus: PENDING, newStatus: PENDING,
    actorType: 'human', changedBy: auth.uid, changedVia: via,
    inviteId: token,
    reason,
  });

  const supersededCount = await db.runTransaction(async (t) => {
    /* ALL READS FIRST. */
    const staffSnap = await t.get(staffRef);
    _requirePendingEmployment(staffSnap, staffId);

    const liveQ = db.collection(INVITES)
      .where('staffId', '==', staffId)
      .where('status', '==', 'pending');
    const live = await t.get(liveQ);

    /* WRITES. Supersede first, so at no point do two pending invitations
       exist — and because it is one transaction, a failure anywhere leaves the
       previous invitation PENDING rather than stranded as superseded. */
    live.docs.forEach((d) => {
      t.update(d.ref, {
        status: 'superseded',
        supersededAt: F.serverTimestamp(),
        supersededByToken: token,
        supersededByUid: auth.uid,
      });
    });

    t.set(inviteRef, {
      token, businessId, staffId, email,
      status: 'pending',
      createdBy: auth.uid,
      createdAt: F.serverTimestamp(),
      expiresAt: admin.firestore.Timestamp.fromDate(new Date(Date.now() + INVITE_TTL_MS)),
      acceptedByUid: null, acceptedAt: null,
      revokedByUid: null, revokedAt: null,
    });

    t.set(ev.ref, ev.payload);
    return live.size;
  });

  return { token, staffId, supersededCount };
});

/* ══════════════════════════════════════════════════════════════════════════
   2. ACCEPT — the invitee, and nobody else
   ══════════════════════════════════════════════════════════════════════════ */
/**
 * Bind the authenticated identity to the employment the invitation names.
 *
 * NO OWNER AUTHORIZATION. The acceptor is the employee; requiring owner
 * authority here would refuse the one person entitled to act. The anchor is
 * email equality against the Firebase token, and the actor is recorded as
 * `changedVia: 'invitee'` (ADR-035 §6) — a human, with a known uid, who is
 * neither owner nor platform nor system.
 *
 * @param {object} data
 * @param {string} data.token
 * @param {string} data.reason  REQUIRED
 */
const acceptEmploymentInvite = onCall(OPT, _h.acceptEmploymentInvite = async (req) => {
  const auth = _auth(req);
  const token = _str(req.data && req.data.token, 200);
  if (!token || token.includes('/')) {
    throw new HttpsError('invalid-argument', 'A valid token is required.');
  }
  const reason = _reason(req.data && req.data.reason);

  const callerEmail = _str(auth.token && auth.token.email, 320).toLowerCase();
  if (!callerEmail) {
    throw new HttpsError('failed-precondition',
      'Your account has no email address, so an invitation cannot be matched to it.');
  }

  const inviteRef = db.collection(INVITES).doc(token);

  const out = await db.runTransaction(async (t) => {
    /* ALL READS FIRST. */
    const inviteSnap = await t.get(inviteRef);
    if (!inviteSnap.exists) throw new HttpsError('not-found', 'Invalid invitation.');
    const inv = inviteSnap.data() || {};

    /* Replay, revocation and supersession all land here: only `pending` is
       acceptable, so a superseded token is refused exactly as a revoked one is. */
    if (inv.status !== 'pending') {
      throw new HttpsError('failed-precondition',
        `This invitation is '${inv.status}' and can no longer be accepted.`);
    }
    /* GUARDED, unlike acceptShopInvite: a missing expiresAt refuses rather than
       throwing TypeError out of `.toDate()`. */
    const exp = inv.expiresAt && typeof inv.expiresAt.toDate === 'function'
      ? inv.expiresAt.toDate() : null;
    if (!exp) throw new HttpsError('failed-precondition', 'This invitation has no expiry.');
    if (exp < new Date()) {
      throw new HttpsError('deadline-exceeded', 'This invitation has expired.');
    }
    /* THE IDENTITY ANCHOR. */
    if (_str(inv.email, 320).toLowerCase() !== callerEmail) {
      throw new HttpsError('permission-denied',
        'This invitation was sent to a different email address.');
    }

    const staffRef = db.collection(STAFF).doc(String(inv.staffId));
    const staffSnap = await t.get(staffRef);
    /* THE RESURRECTION GUARD — the employment itself, not merely the invite. */
    _requirePendingEmployment(staffSnap, String(inv.staffId));

    const ev = employmentEvent({
      businessId: inv.businessId, staffId: inv.staffId,
      event: EVENTS.INVITE_ACCEPTED,
      previousStatus: PENDING, newStatus: WORKING,
      newUid: auth.uid,
      actorType: 'human', changedBy: auth.uid, changedVia: 'invitee',
      reason,
    });

    /* WRITES. */
    t.update(staffRef, {
      uid: auth.uid,
      employmentStatus: 'active',
      workStatus: 'working',
      boundAt: F.serverTimestamp(),
    });
    t.update(inviteRef, {
      status: 'accepted', acceptedByUid: auth.uid, acceptedAt: F.serverTimestamp(),
    });
    t.set(ev.ref, ev.payload);

    return { staffId: inv.staffId, businessId: inv.businessId };
  });

  return { success: true, staffId: out.staffId, businessId: out.businessId };
});

/* ══════════════════════════════════════════════════════════════════════════
   3. REVOKE — owner or platform, and it ENDS the employment
   ══════════════════════════════════════════════════════════════════════════ */
/**
 * Revoke a pending invitation. Per ADR-035 §6 this ENDS the pending employment
 * relationship: `pending → terminated`. Reconsidered and affirmed 2026-09-20 —
 * leaving the record `pending` would create one nothing can ever close.
 *
 * @param {object} data
 * @param {string} data.token
 * @param {string} data.reason  REQUIRED
 */
const revokeEmploymentInvite = onCall(OPT, _h.revokeEmploymentInvite = async (req) => {
  const auth = _auth(req);
  const token = _str(req.data && req.data.token, 200);
  if (!token || token.includes('/')) {
    throw new HttpsError('invalid-argument', 'A valid token is required.');
  }
  const reason = _reason(req.data && req.data.reason);

  const inviteRef = db.collection(INVITES).doc(token);

  /* The organization comes off the invitation, never the request. */
  const pre = await inviteRef.get();
  if (!pre.exists) throw new HttpsError('not-found', 'Invalid invitation.');
  const businessId = (pre.data() || {}).businessId;
  if (!businessId) {
    throw new HttpsError('permission-denied', 'Invitation names no organization.');
  }
  const { via } = await _assertOwner(auth, businessId);

  await db.runTransaction(async (t) => {
    const inviteSnap = await t.get(inviteRef);
    if (!inviteSnap.exists) throw new HttpsError('not-found', 'Invalid invitation.');
    const inv = inviteSnap.data() || {};
    if (inv.status !== 'pending') {
      throw new HttpsError('failed-precondition',
        `This invitation is '${inv.status}' and cannot be revoked.`);
    }

    const staffRef = db.collection(STAFF).doc(String(inv.staffId));
    const staffSnap = await t.get(staffRef);
    _requirePendingEmployment(staffSnap, String(inv.staffId));

    const ev = employmentEvent({
      businessId: inv.businessId, staffId: inv.staffId,
      event: EVENTS.INVITE_REVOKED,
      previousStatus: PENDING, newStatus: ENDED,
      actorType: 'human', changedBy: auth.uid, changedVia: via,
      reason,
    });

    t.update(inviteRef, {
      status: 'revoked', revokedByUid: auth.uid, revokedAt: F.serverTimestamp(),
    });
    t.update(staffRef, { employmentStatus: 'terminated', workStatus: null });
    t.set(ev.ref, ev.payload);
  });

  return { success: true };
});

module.exports = {
  _h,
  sendEmploymentInvite,
  acceptEmploymentInvite,
  revokeEmploymentInvite,
  INVITES,
  INVITE_STATUS,
};
