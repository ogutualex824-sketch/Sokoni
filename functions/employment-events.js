'use strict';
/**
 * SOKONI Employment History — the append-only record of who established,
 * changed, suspended or ended a salary-bearing relationship.
 *
 * ADR-035 §6. Gate 3 mechanism #4.
 *
 * ── WHAT THIS IS ────────────────────────────────────────────────────────────
 * A BUILDER, not a writer. `employmentEvent()` returns `{ ref, payload }` so
 * the caller can pass it to `t.set(ref, payload)` INSIDE the same transaction
 * as the state change it records — the record and its event land together or
 * not at all. Modelled on `booking-events.js`, which exists for exactly this.
 *
 * It has NO CALLER yet, deliberately. Every one of the twelve events is
 * performed by a mechanism that does not exist: binding (#3), uid uniqueness
 * (#1), work status (#5), shop assignment (#7). This is the capability those
 * will consume, certified on its own contract rather than on a workflow.
 *
 * ── WHY IT VALIDATES, WHEN bookingEvent DOES NOT ────────────────────────────
 * Firestore rules cannot express "and the actor combination is coherent", nor
 * "and this status transition matches the event named". Writes are CF-only, so
 * this function is the ONLY enforcement point between a caller and the audit
 * record. A builder that accepted whatever it was handed would produce a
 * history that cannot be trusted to mean what it says.
 *
 * ── THE ONE INVARIANT MOST LIKELY TO BE LOST ────────────────────────────────
 * `record_edited` may NOT change either status axis. Without that, a
 * suspension could be written as an ordinary edit and an auditor asking "who
 * suspended this employee?" would have to infer the answer from which fields
 * happened to change. Every lifecycle transition has its own event precisely so
 * that question has a direct answer.
 */

const { HttpsError } = require('firebase-functions/v2/https');
const admin = require('firebase-admin');

const COLLECTION = 'employmentEvents';

/** The twelve canonical employment events (ADR-035 §6, amended 2026-09-20). */
const EVENTS = Object.freeze({
  ESTABLISHED: 'employment_established',
  INVITE_SENT: 'invite_sent',
  INVITE_ACCEPTED: 'invite_accepted',
  INVITE_REVOKED: 'invite_revoked',
  UID_REBOUND: 'uid_rebound',
  LEAVE_GRANTED: 'leave_granted',
  LEAVE_ENDED: 'leave_ended',
  SUSPENDED: 'employment_suspended',
  SUSPENSION_LIFTED: 'suspension_lifted',
  TERMINATED: 'employment_terminated',
  REINSTATED: 'employment_reinstated',
  RECORD_EDITED: 'record_edited',
});

const EMPLOYMENT_STATUS = Object.freeze(['pending', 'active', 'terminated']);
const WORK_STATUS = Object.freeze(['working', 'on_leave', 'suspended']);

/* ── The transition table ──────────────────────────────────────────────────
   `from` / `to` describe the REQUIRED status shape. `null` means the status
   itself must be null; `'*'` matches any value of that axis. `same: true`
   means previousStatus and newStatus must be identical on BOTH axes.

   `disc` names the caller-supplied id that makes a recurring event's document
   key unique. Events that can happen only once per employment have none, so
   their key is fixed and a retry is idempotent by construction. */
const SPEC = Object.freeze({
  [EVENTS.ESTABLISHED]: { from: null, to: { e: 'pending', w: null }, key: () => 'employment_established' },
  [EVENTS.INVITE_SENT]: { from: { e: 'pending', w: null }, to: { e: 'pending', w: null }, key: () => 'invite_sent' },
  [EVENTS.INVITE_ACCEPTED]: { from: { e: 'pending', w: null }, to: { e: 'active', w: 'working' }, requiresNewUid: true, key: () => 'invite_accepted' },
  /* A revoked invitation ENDS the relationship. Leaving it `pending` would
     create a record nothing can ever close (ADR-035 §6, decided 2026-09-20). */
  [EVENTS.INVITE_REVOKED]: { from: { e: 'pending', w: null }, to: { e: 'terminated', w: null }, key: () => 'invite_revoked' },
  [EVENTS.UID_REBOUND]: { same: true, requiresRebind: true, disc: 'transitionId', key: d => `uid_rebound_${d}` },
  [EVENTS.LEAVE_GRANTED]: { from: { e: 'active', w: 'working' }, to: { e: 'active', w: 'on_leave' }, disc: 'leaveId', key: d => `leave_${d}_granted` },
  [EVENTS.LEAVE_ENDED]: { from: { e: 'active', w: 'on_leave' }, to: { e: 'active', w: 'working' }, disc: 'leaveId', key: d => `leave_${d}_ended` },
  [EVENTS.SUSPENDED]: { from: { e: 'active', w: 'working' }, to: { e: 'active', w: 'suspended' }, disc: 'suspensionId', key: d => `suspension_${d}_started` },
  [EVENTS.SUSPENSION_LIFTED]: { from: { e: 'active', w: 'suspended' }, to: { e: 'active', w: 'working' }, disc: 'suspensionId', key: d => `suspension_${d}_lifted` },
  [EVENTS.TERMINATED]: { from: { e: 'active', w: '*' }, to: { e: 'terminated', w: null }, disc: 'terminationId', key: d => `terminated_${d}` },
  [EVENTS.REINSTATED]: { from: { e: 'terminated', w: null }, to: { e: 'active', w: 'working' }, disc: 'reinstatementId', key: d => `reinstated_${d}` },
  /* THE MASQUERADE GUARD. Ordinary employment DATA only — position,
     department, grossSalary, startDate, phone, email. Neither axis may move. */
  [EVENTS.RECORD_EDITED]: { same: true, disc: 'editId', key: d => `edited_${d}` },
});

function bad (msg) { throw new HttpsError('invalid-argument', msg); }

/** A document-id fragment must not address another path or be empty. */
function isIdFragment (v) {
  return typeof v === 'string' && v.length > 0 && v.length <= 200 && !v.includes('/');
}

/** Validate a status object, or null. Returns a normalised copy. */
function normaliseStatus (s, label) {
  if (s === null || s === undefined) return null;
  if (typeof s !== 'object') bad(`${label} must be an object or null.`);
  const e = s.employmentStatus;
  const w = s.workStatus === undefined ? null : s.workStatus;
  if (!EMPLOYMENT_STATUS.includes(e)) {
    bad(`${label}.employmentStatus must be one of ${EMPLOYMENT_STATUS.join(', ')}.`);
  }
  if (w !== null && !WORK_STATUS.includes(w)) {
    bad(`${label}.workStatus must be null or one of ${WORK_STATUS.join(', ')}.`);
  }
  /* workStatus is meaningful only while employed (ADR-035 §5). */
  if (e !== 'active' && w !== null) {
    bad(`${label}.workStatus must be null when employmentStatus is '${e}'.`);
  }
  if (e === 'active' && w === null) {
    bad(`${label}.workStatus is required when employmentStatus is 'active'.`);
  }
  return { employmentStatus: e, workStatus: w };
}

function statusMatches (actual, want) {
  if (want === null) return actual === null;
  if (actual === null) return false;
  if (want.e !== '*' && actual.employmentStatus !== want.e) return false;
  if (want.w !== '*' && actual.workStatus !== want.w) return false;
  return true;
}
function sameStatus (a, b) {
  if (a === null || b === null) return a === b;
  return a.employmentStatus === b.employmentStatus && a.workStatus === b.workStatus;
}
function describe (want) {
  return want === null ? 'null' : `{${want.e}, ${want.w === null ? 'null' : want.w}}`;
}

/**
 * Build an employmentEvents record.
 *
 * Returns `{ ref, payload }` for `t.set(ref, payload)` inside the transaction
 * that performs the state change. THIS FUNCTION NEVER WRITES.
 *
 * @param {object} o
 * @param {string} o.businessId      SOK-XXXXXX — the employing organization
 * @param {string} o.staffId         `${merchantId}_${employeeNumber}`
 * @param {string} o.event           one of EVENTS
 * @param {string} o.reason          REQUIRED, non-empty — what changed without why
 *                                   answers the easy question (ADR-010)
 * @param {'human'|'system'} o.actorType
 * @param {string|null} o.changedBy  uid; null ONLY when actorType is 'system'
 * @param {'owner'|'platform'|'system'} o.changedVia
 *                                   the `via` resolveMerchantAccess ALREADY
 *                                   returned — never re-derived from a token
 * @param {object|null} [o.previousStatus] { employmentStatus, workStatus }
 * @param {object|null} [o.newStatus]
 * @param {string|null} [o.previousUid]  uid_rebound only
 * @param {string|null} [o.newUid]       uid_rebound / invite_accepted
 * @param {string} [o.transitionId|o.leaveId|o.suspensionId|o.terminationId|o.reinstatementId|o.editId]
 *                                   the discriminator this event requires
 * @returns {{ref: object, payload: object}}
 * @throws  {HttpsError} invalid-argument
 */
function employmentEvent (o) {
  if (!o || typeof o !== 'object') bad('An employment event payload is required.');

  const spec = SPEC[o.event];
  if (!spec) {
    bad(`Unknown employment event '${String(o.event)}'. Expected one of: ${Object.values(EVENTS).join(', ')}.`);
  }

  if (!isIdFragment(o.businessId)) bad('businessId is required.');
  if (!isIdFragment(o.staffId)) bad('staffId is required.');

  /* ADR-010 forbids an audit entry without a reason. */
  if (typeof o.reason !== 'string' || o.reason.trim() === '') {
    bad('reason is required and must be non-empty.');
  }

  /* ── The actor. Checked in BOTH directions so the two fields cannot drift
     apart: a human without a uid is unattributable, and a system actor wearing
     a uid is a lie. `changedBy` is a Firebase uid field — never a sentinel. */
  const actorType = o.actorType;
  const changedVia = o.changedVia;
  const changedBy = o.changedBy === undefined ? null : o.changedBy;

  if (actorType !== 'human' && actorType !== 'system') {
    bad("actorType must be 'human' or 'system'.");
  }
  if (actorType === 'human') {
    if (!isIdFragment(changedBy)) bad("actorType 'human' requires changedBy to be a uid.");
    if (changedVia !== 'owner' && changedVia !== 'platform') {
      bad("actorType 'human' requires changedVia to be 'owner' or 'platform'.");
    }
  } else {
    if (changedBy !== null) bad("actorType 'system' requires changedBy to be null.");
    if (changedVia !== 'system') bad("actorType 'system' requires changedVia to be 'system'.");
  }

  /* ── The status transition must match the event that names it. */
  const previousStatus = normaliseStatus(o.previousStatus, 'previousStatus');
  const newStatus = normaliseStatus(o.newStatus, 'newStatus');

  if (spec.same) {
    if (!sameStatus(previousStatus, newStatus)) {
      bad(`'${o.event}' may not change either status axis.`);
    }
  } else {
    if (!statusMatches(previousStatus, spec.from)) {
      bad(`'${o.event}' requires previousStatus ${describe(spec.from)}.`);
    }
    if (!statusMatches(newStatus, spec.to)) {
      bad(`'${o.event}' requires newStatus ${describe(spec.to)}.`);
    }
  }

  /* ── Identity fields. */
  const previousUid = o.previousUid === undefined ? null : o.previousUid;
  const newUid = o.newUid === undefined ? null : o.newUid;

  if (spec.requiresRebind) {
    if (!isIdFragment(previousUid)) bad("'uid_rebound' requires previousUid.");
    if (!isIdFragment(newUid)) bad("'uid_rebound' requires newUid.");
    if (previousUid === newUid) bad("'uid_rebound' requires previousUid and newUid to differ.");
  }
  if (spec.requiresNewUid && !isIdFragment(newUid)) {
    bad(`'${o.event}' requires newUid — the accepted binding.`);
  }

  /* ── The discriminator, which is what makes a RETRY idempotent. An auto-id
     would make every retry a new row; the transition's identity is the key. */
  let disc = null;
  if (spec.disc) {
    disc = o[spec.disc];
    if (!isIdFragment(disc)) bad(`'${o.event}' requires ${spec.disc}.`);
  }

  const ref = admin.firestore().collection(COLLECTION).doc(`${o.staffId}_${spec.key(disc)}`);

  const payload = {
    businessId: o.businessId,
    staffId: o.staffId,
    event: o.event,
    previousUid,
    newUid,
    previousStatus,
    newStatus,
    actorType,
    changedBy,
    changedVia,
    reason: o.reason.trim(),
    at: admin.firestore.FieldValue.serverTimestamp(),
    ts: Date.now(),
  };

  return { ref, payload };
}

module.exports = { employmentEvent, EVENTS, COLLECTION, EMPLOYMENT_STATUS, WORK_STATUS };
