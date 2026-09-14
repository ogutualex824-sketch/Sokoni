'use strict';
/**
 * VERIFICATION AUTHORITY — the converged contract for official application verification.
 *
 * One engine, role-specific documents. `providerVerification` already had the governed review
 * workflow (status, priorDecisions[], reviewedBy/At, reviewNotes); `driverVerification` already
 * had the structured identifiers and a DERIVED documentsComplete. Neither is replaced and no
 * third schema is introduced — this is their union, with the two-reviewer and capability
 * machinery the assisted route requires.
 *
 * WHAT THIS FILE DOES NOT DO
 * It does not select a vendor, fix a region, set a retention period, or choose a confidence
 * threshold. It does not delete anything: disposal stays blocked until the surviving-evidence
 * contract is settled, because deletion is irreversible and building the sweep first destroys the
 * record of how a decision was reached.
 */

const STATE = Object.freeze({
  UNSUBMITTED: 'unsubmitted',
  PENDING_REVIEW: 'pending_review',
  /* Kept verbatim from the existing providerVerification vocabulary. Renaming a live status
     token would silently reclassify every record that already carries it. */
  ON_FILE: 'verified_on_file',
  REJECTED: 'rejected',
  INCOMPLETE: 'incomplete',      /* driverVerification's existing token */
});

/** Statuses that mean "documents are established". Allowlist, never a denylist — an unknown
 *  status must not read as verified. */
const VERIFIED_STATES = new Set([STATE.ON_FILE, 'verified']);

/* ── CAPABILITY ────────────────────────────────────────────────────────────────────────────────
 * Ordinary AdminOS access is NOT verification authority.
 *
 * `admin-os-dispatch.js` applies the same admin/superAdmin check to every op, so today any admin
 * is implicitly an identity reviewer. Identity and biometric review is a narrower job than admin
 * user-management: it decides whether a person becomes officially real on the platform. The
 * capability is therefore explicit, and its ABSENCE denies — an admin without it is not a
 * reviewer.
 */
const CAPABILITY = 'application_verification_reviewer';

function hasVerificationCapability(claims) {
  const c = claims || {};
  /* superAdmin is the one inherited authority: it already governs who may hold capabilities at
     all, so requiring it to also grant itself this one would be circular. Plain `admin` is NOT
     sufficient — that is the whole point of this boundary. */
  if (c.superAdmin === true) return true;
  const caps = c.capabilities;
  if (Array.isArray(caps)) return caps.indexOf(CAPABILITY) !== -1;
  if (caps && typeof caps === 'object') return caps[CAPABILITY] === true;
  return false;
}

function assertVerificationReviewer(claims) {
  if (!hasVerificationCapability(claims)) {
    const e = new Error('Verification reviewer capability required. An admin claim alone does not '
      + 'authorise identity or biometric review.');
    e.code = 'permission-denied';
    throw e;
  }
}

/* ── DOCUMENT PATHS ────────────────────────────────────────────────────────────────────────────
 * The applicant identifies WHICH document they uploaded; the server decides WHERE it lives.
 *
 * The intake previously stored a client-supplied URL string it never validated — it did not
 * create the object, confirm it existed, or confirm it lived in a bucket SOKONI controls. Two
 * consequences: provenance was asserted rather than established, and a disposal job could not be
 * guaranteed able to delete material a verification record points at, which would make the
 * retention promise unprovable for that record.
 *
 * A path the server constructs is a path the server can delete.
 */
const DOC_KINDS = Object.freeze(['nationalId', 'businessReg', 'licence', 'kraPin', 'selfie']);

function documentPath(uid, kind) {
  if (!uid || typeof uid !== 'string') throw new Error('documentPath: uid required');
  if (DOC_KINDS.indexOf(kind) === -1) throw new Error('documentPath: unknown document kind: ' + kind);
  return 'documents/' + uid + '/' + kind;
}

/**
 * Translate what an applicant submitted into server-owned references.
 * Accepts a set of document KINDS, never URLs. Anything not in DOC_KINDS is refused rather than
 * ignored — silently dropping an unknown kind would let a client think it had submitted something
 * the reviewer will never see.
 */
function resolveSubmittedDocuments(uid, kinds) {
  const list = Array.isArray(kinds) ? kinds : [];
  const unknown = list.filter((k) => DOC_KINDS.indexOf(k) === -1);
  if (unknown.length) throw new Error('unknown document kind(s): ' + unknown.join(', '));
  const out = {};
  list.forEach((k) => { out[k + 'Path'] = documentPath(uid, k); });
  return out;
}

/* ── DERIVED STATE ─────────────────────────────────────────────────────────────────────────────
 * documentsComplete and the official flag are DERIVED. A derived flag that can also be written
 * directly is two authorities disagreeing — the defect class this track has now met three times.
 */
function deriveDocumentsComplete(record, requiredKinds) {
  const r = record || {};
  const required = Array.isArray(requiredKinds) ? requiredKinds : [];
  const missing = required.filter((k) => !r[k + 'Path'] && !r[k]);
  return { documentsComplete: missing.length === 0, documentsMissing: missing };
}

/**
 * THE OFFICIAL PREDICATE. Every component is server-established; none may be client-supplied.
 *
 *     official = applicationApproved && identityVerified && faceVerified(where required)
 *                && humanReviewCompleted
 */
function isOfficial(record, opts) {
  const r = record || {};
  const requireFace = !(opts && opts.requireFace === false);

  if (r.applicationApproved !== true) return { official: false, reason: 'application_not_approved' };
  if (r.documentsComplete !== true) return { official: false, reason: 'documents_incomplete' };
  if (!VERIFIED_STATES.has(String(r.status || ''))) {
    return { official: false, reason: 'status_not_verified:' + (r.status || 'absent') };
  }
  /* The human decision is the authority. An automated score is evidence and can never stand in
     for it — which is why this reads humanDecision and not faceMatchScore. */
  if (r.humanDecision !== 'approved') return { official: false, reason: 'no_human_approval' };

  if (requireFace) {
    /* ABSENT face evidence is NOT a pass. With the null adapter both are null, so this denies —
       deliberately. The assisted route is how such an applicant becomes official. */
    const assisted = r.verificationRoute === 'assisted';
    const automatedOk = r.livenessResult === 'pass'
      && typeof r.faceMatchScore === 'number' && Number.isFinite(r.faceMatchScore);
    if (!assisted && !automatedOk) return { official: false, reason: 'face_evidence_absent' };
  }
  return { official: true, reason: 'official' };
}

/* ── TWO-REVIEWER DECISIONS ────────────────────────────────────────────────────────────────────
 * The assisted route requires TWO independent reviewers. Separation of duties on the exception
 * path, without creating a second identity tier — an assisted approval yields the same official
 * status, or the fallback becomes a lesser identity and the exclusion it exists to prevent
 * returns by another door.
 */
function requiredReviewers(record) {
  return (record && record.verificationRoute === 'assisted') ? 2 : 1;
}

/**
 * Apply one reviewer's decision, returning the Firestore patch. Pure — no I/O — so the rules it
 * encodes can be tested without an emulator and cannot be bypassed by a caller that forgets a step.
 *
 * @throws when the actor may not decide, or would occupy both reviewer seats.
 */
function applyReviewerDecision(current, input) {
  const cur = current || {};
  const { actor, subjectUid, decision, reason, claims, now } = input || {};

  assertVerificationReviewer(claims);

  if (!actor) throw new Error('reviewer uid required');
  /* An administrator is still an applicant when the subject is themselves. */
  if (actor === subjectUid) {
    const e = new Error('You cannot decide your own verification.');
    e.code = 'permission-denied';
    throw e;
  }
  if (['approve', 'reject'].indexOf(decision) === -1) {
    throw new Error('decision must be "approve" or "reject"');
  }
  const why = String(reason || '').slice(0, 500).replace(/[<>]/g, '');
  if (decision === 'reject' && !why) {
    throw new Error('A rejection needs a reason the applicant can act on.');
  }

  const need = requiredReviewers(cur);
  const first = cur.reviewer1 || null;

  /* THE SECOND SEAT IS A DIFFERENT PERSON. This is NOT the same check as self-approval: two
     approvals from one reviewer defeats separation of duties even when that reviewer is not the
     applicant. */
  if (need === 2 && first && first === actor) {
    const e = new Error('A second, independent reviewer is required — you have already reviewed this.');
    e.code = 'failed-precondition';
    throw e;
  }

  const ts = now || new Date().toISOString();
  const patch = {};

  /* Preserve the existing append-only history rather than replacing it. */
  if (cur.status && cur.status !== STATE.PENDING_REVIEW) {
    const prior = Array.isArray(cur.priorDecisions) ? cur.priorDecisions : [];
    patch.priorDecisions = prior.slice(-9).concat([{
      status: cur.status, reviewedBy: cur.reviewer1 || cur.reviewedBy || null,
      reviewedAt: cur.reviewedAt1 || cur.reviewedAt || null, reason: cur.reviewNotes || null,
    }]);
  }

  if (!first) {
    patch.reviewer1 = actor;
    patch.reviewedAt1 = ts;
  } else {
    patch.reviewer2 = actor;
    patch.reviewedAt2 = ts;
  }
  patch.reviewNotes = why || null;

  const seats = (patch.reviewer2 || cur.reviewer2) ? 2 : 1;
  const complete = seats >= need;

  if (!complete) {
    /* One reviewer cannot finish a two-review decision. The record stays pending and says why. */
    patch.status = STATE.PENDING_REVIEW;
    patch.humanDecision = null;
    patch.decisionPending = 'awaiting_second_reviewer';
    return { patch, complete: false, seatsFilled: seats, seatsRequired: need };
  }

  patch.status = decision === 'approve' ? STATE.ON_FILE : STATE.REJECTED;
  patch.humanDecision = decision === 'approve' ? 'approved' : 'rejected';
  patch.decisionAt = ts;
  patch.decisionPending = null;
  patch.previousStatus = cur.status || null;
  return { patch, complete: true, seatsFilled: seats, seatsRequired: need };
}

/** Re-issuing the decision a record already carries changes nothing — so a double-tapped button
 *  or a retry cannot manufacture a second review event, which matters once two are required. */
function isIdempotentRepeat(current, decision) {
  const cur = current || {};
  const next = decision === 'approve' ? STATE.ON_FILE : STATE.REJECTED;
  return cur.status === next && !cur.decisionPending;
}

module.exports = {
  STATE, VERIFIED_STATES, CAPABILITY, DOC_KINDS,
  hasVerificationCapability, assertVerificationReviewer,
  documentPath, resolveSubmittedDocuments,
  deriveDocumentsComplete, isOfficial,
  requiredReviewers, applyReviewerDecision, isIdempotentRepeat,
};
