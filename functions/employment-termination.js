'use strict';
/**
 * SOKONI — MECHANISM #8: ACCEPTED-EMPLOYMENT TERMINATION
 * ADR-035 §4 (the frozen transition) and "Mechanism numbering, and the
 * termination assignment" (#8 assigned 2026-09-21, `terminationId` resolved).
 *
 *     active / working  ──terminate──▶  terminated / null
 *
 * ── WHY A SEPARATE MODULE ───────────────────────────────────────────────────
 * `employment-invites.js` is named for invitations, and termination is not one.
 * It is a distinct lifecycle operation: §4 records that `revokeEmploymentInvite`
 * sees only a PENDING employment and is FORBIDDEN from being extended to reach
 * an accepted one. Keeping them apart is the point, not tidiness.
 *
 * ── NOT EXPORTED FROM functions/index.js, DELIBERATELY ──────────────────────
 * No callable of mechanism #1, #3 or #4 is re-exported there either — the whole
 * employment workstream is built and certified but not wired into the deployable
 * surface. #8 follows that convention. It is therefore UNREACHABLE IN PRODUCTION
 * by design, and wiring it up is a separate decision with its own authorization.
 *
 * ── WHAT THIS MUST NOT BECOME ───────────────────────────────────────────────
 * #8 owns ONE transition. It does not own `on_leave`, `suspended`, work-status
 * policy (#6), shop assignment, shop-employee removal, or the UNRESOLVED
 * mechanisms #5 and #7. Termination cannot revoke a shop assignment in any case:
 * `shopEmployees` is keyed `{shopId}_{uid}` against `hrStaff`'s
 * `{merchantId}_{employeeNumber}`, no module reads both, and ADR-016 forbids
 * inventing the bridge.
 */

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const admin = require('firebase-admin');
const crypto = require('crypto');
const { resolveMerchantAccess } = require('./merchant-authority');
const { employmentEvent, EVENTS } = require('./employment-events');
const { CLAIMS, claimId } = require('./employment-invites');

const db = admin.firestore();
const F = admin.firestore.FieldValue;
const OPT = { region: 'us-central1', enforceAppCheck: true };
const _h = {};

const STAFF = 'hrStaff';

/* The two status shapes this transition moves between. `ACTIVE_FROM` uses the
   wildcard the event spec declares — an employment may be terminated from
   `working`, and (once #6 and the work-status mechanism exist) from any other
   work status. `employmentStatus` is what decides, never `workStatus`. */
const ENDED = Object.freeze({ employmentStatus: 'terminated', workStatus: null });

function _auth (req) {
  if (!req.auth || !req.auth.uid) throw new HttpsError('unauthenticated', 'Sign in required.');
  return req.auth;
}
function _str (v, max) {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}
/** A reason is required on every employment transition (ADR-010). */
function _reason (v) {
  if (typeof v !== 'string' || v.trim() === '') {
    throw new HttpsError('invalid-argument', 'reason is required and must be non-empty.');
  }
  return v.trim();
}

/**
 * ENDING an employment is OWNER authority, not merchant access (ADR-035 §2):
 *   `admin` — in adminUids, but access is not employment authority
 *   `self`  — merchantId === uid, which reads NO document and cannot even
 *             confirm the organization exists
 * Identical to the boundary establishment and revocation already use.
 */
async function _assertOwner (auth, businessId) {
  const { merchantId, via } = await resolveMerchantAccess(auth, businessId);
  if (via !== 'owner' && via !== 'platform') {
    throw new HttpsError('permission-denied',
      'Only the business owner may end an employment relationship.');
  }
  return { merchantId, via };
}

/* ══════════════════════════════════════════════════════════════════════════
   terminateEmployment — the ONE transition mechanism #8 owns
   ══════════════════════════════════════════════════════════════════════════ */
/**
 * End an ACCEPTED employment, releasing the uid it occupies.
 *
 * @param {object} data
 * @param {string} data.staffId   the employment record, `{merchantId}_{employeeNumber}`
 * @param {string} data.reason    REQUIRED, non-empty
 */
const terminateEmployment = onCall(OPT, _h.terminateEmployment = async (req) => {
  const auth = _auth(req);
  const staffId = _str(req.data && req.data.staffId, 200);
  if (!staffId || staffId.includes('/')) {
    throw new HttpsError('invalid-argument', 'A valid staffId is required.');
  }
  const reason = _reason(req.data && req.data.reason);

  const staffRef = db.collection(STAFF).doc(staffId);

  /* The organization is read off the EMPLOYMENT RECORD, never taken from the
     request — the record-anchored pattern establishment already uses. */
  const pre = await staffRef.get();
  if (!pre.exists) throw new HttpsError('not-found', `No employment record ${staffId}.`);
  const businessId = (pre.data() || {}).merchantId;
  if (!businessId) {
    throw new HttpsError('permission-denied', 'Employment record names no organization.');
  }
  const { via } = await _assertOwner(auth, businessId);

  /* ── terminationId: ONCE, HERE, BEFORE THE TRANSACTION ───────────────────
     ADR-035, "terminationId — RESOLVED". The transaction callback below may
     execute MANY times: Firestore re-runs it on contention. Minting the id
     inside it would make EVENT IDENTITY DEPEND ON FIRESTORE'S RETRY BEHAVIOUR
     — a different discriminator per attempt, and a different event document
     each time. The event doc id is `${staffId}_terminated_${terminationId}`,
     so a stable id means every retry of ONE logical termination writes the
     SAME row.

     The defect would be invisible in ordinary testing, because a transaction
     that never contends never retries. That is why this line is here and not
     four lines lower, and why the certification asserts its position. */
  const terminationId = crypto.randomUUID();

  const out = await db.runTransaction(async (t) => {
    /* ── ALL READS FIRST. ── */
    const staffSnap = await t.get(staffRef);
    if (!staffSnap.exists) {
      throw new HttpsError('not-found', `No employment record ${staffId}.`);
    }
    const staff = staffSnap.data() || {};

    /* PRECONDITION 1 — the employment is ACTIVE.
       This is also the REPLAY GUARD. #8 is STATE-GATED idempotent, not
       caller-key idempotent: a client that retries after a successful
       termination arrives with a NEW terminationId and is refused here, so no
       second event is ever written. Two concurrent attempts both read this
       document, therefore CONTEND; the loser re-reads `terminated` and fails
       exactly here. */
    if (staff.employmentStatus !== 'active') {
      throw new HttpsError('failed-precondition',
        `Employment ${staffId} is '${staff.employmentStatus}', not 'active'.`);
    }

    /* PRECONDITION 2 — a uid EXISTS.
       An active employment with uid null never acquired an occupancy claim, so
       there would be nothing to release and no identity to record. */
    const uid = _str(staff.uid, 200);
    if (!uid) {
      throw new HttpsError('failed-precondition',
        `Employment ${staffId} is active but bound to no uid.`);
    }

    /* PRECONDITION 3 — the claim EXISTS and BELONGS TO THIS EMPLOYMENT.
       THE LOAD-BEARING ONE, and the reason this is a read-then-verify rather
       than a bare delete. `create()` refuses a document that already exists;
       `delete()` on an absent document — or on one belonging to ANOTHER
       employment — SUCCEEDS SILENTLY. A handler that blind-deleted
       `{businessId}_{uid}` would release someone else's occupancy and report
       success. A successful delete() is therefore NOT proof that the correct
       claim existed and was revoked; only this correspondence check is.

       Reading `staffId` here is NOT consulting the claim as an employment
       authority — hrStaff holds employment state. It establishes WHICH claim
       this transaction is entitled to delete. */
    const claimRef = db.collection(CLAIMS).doc(claimId(businessId, uid));
    const claimSnap = await t.get(claimRef);
    if (!claimSnap.exists) {
      throw new HttpsError('failed-precondition',
        `Employment ${staffId} holds no occupancy claim; refusing to terminate.`);
    }
    const claimStaffId = _str((claimSnap.data() || {}).staffId, 200);
    if (claimStaffId !== staffId) {
      throw new HttpsError('failed-precondition',
        'The occupancy claim for this uid belongs to a different employment.');
    }

    /* Built outside the writes — employmentEvent performs no I/O. The uid is
       RETAINED, so previousUid/newUid are deliberately left unset: recording
       them would suggest the binding changed, and `uid_rebound` is the event
       for that. */
    const ev = employmentEvent({
      businessId, staffId,
      event: EVENTS.TERMINATED,
      previousStatus: { employmentStatus: 'active', workStatus: staff.workStatus },
      newStatus: ENDED,
      actorType: 'human', changedBy: auth.uid, changedVia: via,
      terminationId,
      reason,
    });

    /* ── WRITES. ── */
    /* uid is RETAINED — ADR-035 §4. It is the historical identity binding; the
       CLAIM, not hrStaff.uid, decides current occupancy. §5 separately forbids
       setting uid = null to make someone unavailable. */
    t.update(staffRef, {
      employmentStatus: ENDED.employmentStatus,
      workStatus: ENDED.workStatus,
      terminatedAt: F.serverTimestamp(),
      terminatedBy: auth.uid,
    });
    /* The verified claim, and only it. Deleting BEFORE the termination commits
       would free the uid while the employment is still active — the mirror of
       the defect mechanism #1's certification calls M3. One transaction makes
       the ordering unobservable, which is the point. */
    t.delete(claimRef);
    t.set(ev.ref, ev.payload);

    return { staffId, businessId, uid, terminationId };
  });

  return { success: true, staffId: out.staffId, terminationId: out.terminationId };
});

module.exports = {
  _h,
  terminateEmployment,
  STAFF,
};
