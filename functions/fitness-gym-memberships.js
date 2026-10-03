/* ============================================================================
   FITNESS — GYM-SIDE MEMBERSHIP READS (contract "FINAL RELEASE" e3, 2026-10-03; sokoni-e3; NOT deployed)
   ----------------------------------------------------------------------------
   fitnessGymMemberships({ status?, limit?, cursor? }) → { rows, nextCursor }
   fitnessGymMembership({ membershipId })             → { membership, attendance, settlement }
   fitnessScannerStatus()                             → { canScan, role, reason? }

   AUTHORIZATION — one path, shared with the check-in (fitness-attendance.resolveGymScope):
     owner  providers/{uid} exists → the gym IS uid
     staff  an ACTIVE workspaceMemberships row with the explicit 'attendance' permission in the gym's business, the
            business resolved from providers/{gym}.linkedBusinessId (verified ownerId), re-checked by
            workforce-identity._assertBusinessPermission. 'attendance' is BOTH the scan and the view permission: a
            person who may record attendance needs to see whom they are admitting; nobody else (cashier 'customers',
            receptionist 'bookings') sees gym memberships.
     gate   approved provider + business-workspace 'memberships' module (PENDING until sokoni-5b ships the key)
   The request NEVER names the gym: providerId / businessId in the payload are ignored.

   WHAT A ROW RETURNS, AND WHY (data minimisation):
     member.displayName only — to recognise the member at the door. Never the member's uid, phone or email.
     plan + period + state fields the gym already owns (title, months, start/end, status, paymentStatus, refund state).
     attendance counts from the server ledger fields; remaining = sessionsIncluded − (attendedSessions − voidedSessions)
     when a cap exists, else null (UI: "Unlimited"). Unknown → null, never 0.
   ============================================================================ */
'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const logger = require('firebase-functions/logger');
const FA = require('./fitness-attendance');

const COL = 'providerMemberships';
const MAX_LIMIT = 50;
const DEFAULT_LIMIT = 20;
const ATTENDANCE_LIMIT = 100;
const PAYOUT_LIMIT = 60;                                   /* periodCount ≤ 60 → at most 60 settlement rows */
const ID_RE = /^[A-Za-z0-9_-]{6,128}$/;
/* The UI tabs → the statuses 2f / this lane write. 'all' = no status filter. */
const STATUS_TABS = Object.freeze({
  active: ['active'],
  pending: ['pending_payment'],
  expired: ['expired'],
  refund: ['refund_requested', 'refunded'],
  all: null,
});
const PAID = Object.freeze(['paid_held', 'partially_released', 'released']);

const _db = () => FA._db();
const _iso = (v) => { const d = FA._date(v); return d && !isNaN(d.getTime()) ? d.toISOString() : null; };
const _int = (v) => (Number.isInteger(v) ? v : null);

const SCOPE_MSG = Object.freeze({
  NOT_APPROVED: "This gym isn't approved to manage memberships right now.",
  BUSINESS_LINK_MISSING: "Staff access isn't set up for this gym yet.",
  NO_PERMISSION: "You don't have permission to view this gym's memberships.",
  MODULE_NOT_AVAILABLE: "Memberships aren't enabled for this business.",
  MULTIPLE_GYMS: 'You are staff at more than one gym. Ask the gym owner for access to this view.',
});

async function _scope(req) {
  const uid = req.auth && req.auth.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in required.');
  const s = await FA.resolveGymScope(uid);
  if (!s.ok) throw new HttpsError(s.reason === FA.SCOPE.NO_PERMISSION ? 'permission-denied' : 'failed-precondition', SCOPE_MSG[s.reason] || SCOPE_MSG.NO_PERMISSION, { reason: s.reason });
  return s;
}

/** Pure: a membership doc → the gym-facing row (no member identifiers except displayName, filled by the caller). */
function rowOf(id, m, displayName) {
  const cap = Number.isInteger(m.sessionsIncluded) && m.sessionsIncluded > 0 ? m.sessionsIncluded : null;
  /* attendedSessions is written ONLY by the check-in path; absent AND no firstAttendedAt = the ledger is empty by
     construction → a canonical 0. Absent WITH a firstAttendedAt = inconsistent → unknown (null). */
  const attended = _int(m.attendedSessions) != null ? m.attendedSessions : (m.firstAttendedAt ? null : 0);
  const voided = _int(m.voidedSessions) != null ? m.voidedSessions : 0;
  const remaining = cap != null && attended != null ? Math.max(0, cap - (attended - voided)) : null;
  let endsAt = null;
  if (PAID.includes(m.paymentStatus) && m.startAt) {
    try { endsAt = _iso(require('./membership-settlement').endsAt(m)); } catch (_) { endsAt = null; }
  }
  return {
    membershipId: id,
    member: { displayName: displayName || null },
    title: typeof m.title === 'string' ? m.title : null,
    periodCount: _int(m.periodCount), periodUnit: typeof m.periodUnit === 'string' ? m.periodUnit : null,
    startAt: PAID.includes(m.paymentStatus) ? _iso(m.startAt) : null,   /* before payment the start is only requested */
    endsAt,
    sessionsIncluded: cap,
    attendedSessions: attended,
    remaining,
    lastAttendedAt: _iso(m.lastAttendedAt),
    status: typeof m.status === 'string' ? m.status : null,
    paymentStatus: typeof m.paymentStatus === 'string' ? m.paymentStatus : null,
    refundState: (m.refund && typeof m.refund.state === 'string') ? m.refund.state : null,
    refundEligible: m.refundEligible === false ? false : (attended === 0 ? true : null),
    releasedPeriods: _int(m.releasedPeriods),
    releasedCents: _int(m.releasedCents),
  };
}

async function _names(uids) {
  const out = new Map();
  await Promise.all([...new Set(uids)].map(async (u) => { out.set(u, await FA.memberDisplayName(u)); }));
  return out;
}

async function gymMembershipsHandler(req) {
  const scope = await _scope(req);
  const d = req.data || {};
  const providerId = scope.providerId;                          /* NEVER d.providerId / d.businessId */
  const tab = d.status == null || d.status === '' ? 'all' : String(d.status);
  if (!Object.prototype.hasOwnProperty.call(STATUS_TABS, tab)) throw new HttpsError('invalid-argument', 'Unknown status filter.');
  const limit = d.limit == null ? DEFAULT_LIMIT : Number(d.limit);
  if (!Number.isInteger(limit) || limit < 1) throw new HttpsError('invalid-argument', 'limit must be a positive integer.');
  const n = Math.min(limit, MAX_LIMIT);

  let q = _db().collection(COL).where('providerId', '==', providerId);
  if (STATUS_TABS[tab]) q = q.where('status', 'in', STATUS_TABS[tab]);
  q = q.orderBy('createdAt', 'desc');
  if (d.cursor != null && d.cursor !== '') {
    const c = String(d.cursor);
    if (!ID_RE.test(c)) throw new HttpsError('invalid-argument', 'Invalid cursor.');
    const cs = await _db().collection(COL).doc(c).get();
    if (!cs.exists || (cs.data() || {}).providerId !== providerId) throw new HttpsError('invalid-argument', 'Invalid cursor.');
    q = q.startAfter(cs);
  }
  const snap = await q.limit(n + 1).get();
  const docs = snap.docs.slice(0, n);
  const names = await _names(docs.map((x) => String((x.data() || {}).buyerUid || '')).filter(Boolean));
  const rows = docs.map((x) => { const m = x.data() || {}; return rowOf(x.id, m, names.get(String(m.buyerUid || ''))); });
  const nextCursor = snap.docs.length > n && docs.length ? docs[docs.length - 1].id : null;
  logger.info('[fitness-gym] list', { providerId, role: scope.role, tab, count: rows.length });
  return { rows, nextCursor };
}

async function gymMembershipHandler(req) {
  const scope = await _scope(req);
  const id = String((req.data && req.data.membershipId) || '');
  if (!ID_RE.test(id)) throw new HttpsError('invalid-argument', 'membershipId required.');
  const ref = _db().collection(COL).doc(id);
  const snap = await ref.get();
  /* another gym's membership is indistinguishable from a missing one */
  if (!snap.exists || (snap.data() || {}).providerId !== scope.providerId) throw new HttpsError('not-found', 'Membership not found.', { reason: 'not_found' });
  const m = snap.data() || {};
  const [name, att, pay] = await Promise.all([
    FA.memberDisplayName(m.buyerUid),
    ref.collection('attendance').orderBy('checkedInAt', 'desc').limit(ATTENDANCE_LIMIT).get(),
    _db().collection('providerPayouts').where('sourceType', '==', 'membership').where('membershipId', '==', id)
      .where('providerId', '==', scope.providerId).limit(PAYOUT_LIMIT).get(),
  ]);
  const attendance = att.docs.map((x) => { const a = x.data() || {}; return {
    attendanceId: x.id, checkedInAt: _iso(a.checkedInAt), status: typeof a.status === 'string' ? a.status : null,
    method: a.method || null, actorRole: a.actorRole || null, sessionRef: a.sessionRef || null, completedAt: _iso(a.completedAt),
  }; });
  const releases = pay.docs.map((x) => { const p = x.data() || {}; return {
    periodIndex: _int(p.periodIndex), grossCents: _int(p.gross), commissionCents: _int(p.commission), netCents: _int(p.net),
    status: p.status || null, settledAt: _iso(p.settledAt),
  }; }).sort((a, b) => (a.periodIndex == null ? 1e9 : a.periodIndex) - (b.periodIndex == null ? 1e9 : b.periodIndex));
  const netKnown = releases.length > 0 && releases.every((r) => r.netCents != null);
  logger.info('[fitness-gym] detail', { providerId: scope.providerId, role: scope.role, membershipId: id, attendance: attendance.length, releases: releases.length });
  return {
    membership: rowOf(id, m, name),
    attendance,
    attendanceTruncated: att.docs.length >= ATTENDANCE_LIMIT,
    settlement: {
      releases,
      releasedPeriods: _int(m.releasedPeriods),
      releasedCents: _int(m.releasedCents),
      /* sum of the provider's net from the canonical providerPayouts rows; null when there are none or any is unknown */
      netSettledCents: netKnown ? releases.reduce((s, r) => s + r.netCents, 0) : null,
    },
  };
}

async function scannerStatusHandler(req) {
  const uid = req.auth && req.auth.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in required.');
  const s = await FA.resolveGymScope(uid);
  if (s.ok) return { canScan: true, role: s.role };
  return { canScan: false, role: s.role || null, reason: s.reason };
}

const OPTS = { region: 'us-central1', enforceAppCheck: true, maxInstances: 20 };
const fitnessGymMemberships = onCall(OPTS, gymMembershipsHandler);
const fitnessGymMembership = onCall(OPTS, gymMembershipHandler);
const fitnessScannerStatus = onCall(OPTS, scannerStatusHandler);

module.exports = {
  fitnessGymMemberships, fitnessGymMembership, fitnessScannerStatus,
  rowOf, STATUS_TABS, MAX_LIMIT,
  _h: { gymMembershipsHandler, gymMembershipHandler, scannerStatusHandler },
};
