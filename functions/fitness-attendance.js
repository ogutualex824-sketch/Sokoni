/* ============================================================================
   FITNESS MEMBERSHIP ATTENDANCE — QR check-in ledger (owner 2026-10-03, OWNER POLICY #2; sokoni-e3)
   ----------------------------------------------------------------------------
   PAID ≠ CHECKED-IN ≠ COMPLETED ≠ SETTLED. This module owns ONLY the middle two:
     PAID      verified payment webhook (5b) + membership-settlement.js (2f)   — never written here
     CHECKED-IN this module: fitnessCheckIn appends a ledger row + the membership's attendance fields
     COMPLETED  this module: fitnessCompleteSession marks a ledger row completed (no money, no refund effect)
     SETTLED   membership-settlement.js (2f) — releaseDueSlices / the 06:00 sweep. A check-in is NOT a payment proof;
               it only lets 2f's authority release money that a verified webhook already holds.

   OWNED FIELDS on providerMemberships/{id} (contract 8bbfb34 §13 — ONLY this check-in path writes them):
     attendedSessions (int ≥ 0, never decreases) · firstAttendedAt (server timestamp, set once) ·
     refundEligible (false from the first valid check-in, never set back) · lastAttendedAt ·
     voidedSessions (int ≥ 0 — admin corrections; restores ENTITLEMENT only, never refund eligibility)
   LEDGER: providerMemberships/{id}/attendance/{attId} — append-only; corrections change status to
     'voided_by_admin' and add providerMemberships/{id}/attendanceCorrections/{attId}; nothing is ever deleted.

   REUSE (scratchpad fitness-attendance-reuse.md, docs/FITNESS_MEMBERSHIP_ATTENDANCE.md):
     signing   event-ops.credentialHash (SOKONI_HMAC_KEY, the platform credential secret) with domain 'fitmem1|'
     owner     provider-ops convention: the gym IS providers/{uid}; scanner must be providerMemberships.providerId
     staff     BLOCKED on BUSINESS_IDENTITY_PENDING (business-workspace `staff` module) — _staffAuthority denies
     admin     AdminOS predicate token.admin || token.superAdmin
     audit     adminAudit (AdminOS; rules: admin read, write false)
     period    membership-settlement.endsAt (one period computation)

   NEVER from the client: attendedSessions, sessionsUsed/Remaining, refundEligible, timestamps, providerId, buyerUid,
   membership state. The only client inputs are the signed token, an optional sessionRef, ids and a correction reason.
   ============================================================================ */
'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const logger = require('firebase-functions/logger');
const admin = require('firebase-admin');
const crypto = require('crypto');

const COL = 'providerMemberships';
const AUDIT = 'adminAudit';
const TOKEN_VERSION = 'fm1';
const DOMAIN = 'fitmem1|';
const TOKEN_TTL_MS = 5 * 60 * 1000;          /* short-lived: the member app refreshes it */
const CLOCK_SKEW_MS = 60 * 1000;
const ID_RE = /^[A-Za-z0-9_-]{6,128}$/;
const SESSION_RE = /^[A-Za-z0-9_-]{1,64}$/;
const PAID = Object.freeze(['paid_held', 'partially_released', 'released']);
const EAT_OFFSET_MS = 3 * 60 * 60 * 1000;    /* Africa/Nairobi: UTC+3, no DST */

/* Human messages for the owner's reject list. Never include another gym's or member's data. */
const REASONS = Object.freeze({
  token_invalid: { code: 'invalid-argument', msg: 'This QR code is not valid. Ask the member to refresh it in their app.' },
  token_expired: { code: 'deadline-exceeded', msg: 'This QR code has expired. Ask the member to refresh it in their app.' },
  not_found: { code: 'not-found', msg: 'Membership not found.' },
  no_permission: { code: 'permission-denied', msg: "You don't have permission to record attendance for this gym." },
  other_gym: { code: 'permission-denied', msg: 'This membership is not for your gym.' },
  self_scan: { code: 'permission-denied', msg: 'You cannot check yourself in.' },
  wrong_member: { code: 'failed-precondition', msg: 'This QR code does not belong to this membership holder.' },
  expired: { code: 'failed-precondition', msg: 'This membership has expired.' },
  cancelled: { code: 'failed-precondition', msg: 'This membership has been cancelled.' },
  suspended: { code: 'failed-precondition', msg: 'This membership is suspended.' },
  not_covered: { code: 'failed-precondition', msg: 'This membership does not cover a session right now.' },
  entitlement_exhausted: { code: 'failed-precondition', msg: 'All sessions on this membership have been used.' },
});

/* Overridable ONLY by the suite (in-memory Firestore; emulator proof is QUEUED). */
const _hooks = { db: null, ts: null, now: null, release: null, staffAuthority: null, correlationId: null };
const _db = () => _hooks.db || admin.firestore();
const _ts = () => (_hooks.ts ? _hooks.ts() : admin.firestore.FieldValue.serverTimestamp());
const _now = () => (_hooks.now ? _hooks.now() : new Date());
const _cid = () => (_hooks.correlationId ? _hooks.correlationId() : crypto.randomUUID());
const _sign = (payloadB64) => require('./event-ops').credentialHash(DOMAIN + payloadB64);
const _settlement = () => require('./membership-settlement');

function _refuse(reason, detail) {
  const r = REASONS[reason] || REASONS.not_covered;
  throw new HttpsError(r.code, r.msg, Object.assign({ reason }, detail || {}));
}
function _date(v) {
  if (!v) return null;
  if (v instanceof Date) return v;
  if (typeof v.toDate === 'function') return v.toDate();
  if (typeof v._seconds === 'number') return new Date(v._seconds * 1000);
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}
const _isAdmin = (req) => !!(req.auth && req.auth.token && (req.auth.token.admin === true || req.auth.token.superAdmin === true));

/* ── token ───────────────────────────────────────────────────────────────── */
/** Mint a signed membership token. Payload carries ids + times only (no PII). */
function mintToken({ membershipId, buyerUid, providerId }, nowMs) {
  const iat = Math.floor(nowMs);
  const payload = { m: String(membershipId), b: String(buyerUid), p: String(providerId), iat, exp: iat + TOKEN_TTL_MS };
  const b64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return { token: `${TOKEN_VERSION}.${b64}.${_sign(b64)}`, exp: payload.exp };
}

/** The ONLY way a token string becomes trusted → { ok, claims } | { ok:false, reason }. Constant-time compare. */
function verifyToken(token, nowMs) {
  if (typeof token !== 'string' || token.length > 1024) return { ok: false, reason: 'token_invalid' };
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== TOKEN_VERSION || !/^[A-Za-z0-9_-]+$/.test(parts[1]) || !/^[0-9a-f]{64}$/.test(parts[2])) return { ok: false, reason: 'token_invalid' };
  const a = Buffer.from(parts[2], 'hex');
  const b = Buffer.from(_sign(parts[1]), 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, reason: 'token_invalid' };
  let c;
  try { c = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')); } catch (_) { return { ok: false, reason: 'token_invalid' }; }
  if (!c || !ID_RE.test(String(c.m)) || typeof c.b !== 'string' || !c.b || typeof c.p !== 'string' || !c.p
      || !Number.isFinite(c.iat) || !Number.isFinite(c.exp) || c.exp - c.iat !== TOKEN_TTL_MS) return { ok: false, reason: 'token_invalid' };
  if (c.iat > nowMs + CLOCK_SKEW_MS) return { ok: false, reason: 'token_invalid' };
  if (nowMs > c.exp) return { ok: false, reason: 'token_expired' };
  return { ok: true, claims: { membershipId: c.m, buyerUid: c.b, providerId: c.p, iat: c.iat, exp: c.exp } };
}

/* ── pure decisions ──────────────────────────────────────────────────────── */
/** Day key in Africa/Nairobi — one check-in per member per local day unless a sessionRef names a session. */
function localDay(d) { return new Date(d.getTime() + EAT_OFFSET_MS).toISOString().slice(0, 10); }
function attendanceIdFor(sessionRef, now) { return sessionRef ? `s_${sessionRef}` : `d_${localDay(now)}`; }

/** May this membership be checked in at `now`? → null | reasonCode. Reads the record only (never the request). */
function checkInRefusal(m, now) {
  const st = m.status;
  if (st !== 'active') {
    if (st === 'expired') return 'expired';
    if (st === 'cancelled') return 'cancelled';
    if (st === 'suspended') return 'suspended';
    return 'not_covered';                       /* pending_payment, refund_requested, refunded, disputed, unknown */
  }
  if (!PAID.includes(m.paymentStatus)) return 'not_covered';   /* defence in depth: never unpaid */
  let start, end;
  try { start = _date(m.startAt); end = _settlement().endsAt(m); } catch (_) { return 'not_covered'; }
  if (!start || now.getTime() < start.getTime()) return 'not_covered';
  if (now.getTime() >= end.getTime()) return 'expired';
  const cap = Number(m.sessionsIncluded);
  if (Number.isInteger(cap) && cap > 0) {
    const used = (Number(m.attendedSessions) || 0) - (Number(m.voidedSessions) || 0);
    if (used >= cap) return 'entitlement_exhausted';
  }
  return null;
}

/* ── scanner authorization (owner; staff BLOCKED) ─────────────────────────── */
/* The staff seam. Default: DENY. Staff scanning needs a provider → business identity (business-workspace `staff`
   is NOT_IMPLEMENTED: BUSINESS_IDENTITY_PENDING). When it lands this calls workforce-identity
   _assertBusinessPermission(uid, businessId, 'attendance') — never a third guard, never a role default. */
async function _staffAuthority(uid, providerId) {
  if (_hooks.staffAuthority) return _hooks.staffAuthority(uid, providerId);
  return { allowed: false, blocked: 'STAFF_ATTENDANCE_BLOCKED_BUSINESS_IDENTITY_PENDING' };
}

/** → { actorRole } or throws. Distinguishes "another gym" from "no permission" without revealing either gym. */
async function assertScanner(uid, m) {
  if (uid === m.providerId) {
    if (uid === m.buyerUid) _refuse('self_scan');
    return { actorRole: 'owner' };
  }
  const staff = await _staffAuthority(uid, m.providerId);
  if (staff && staff.allowed === true) {
    if (uid === m.buyerUid) _refuse('self_scan');
    return { actorRole: String(staff.role || 'staff') };
  }
  const isProvider = (await _db().collection('providers').doc(String(uid)).get()).exists;
  _refuse(isProvider ? 'other_gym' : 'no_permission');
}

/* ── audit (AdminOS adminAudit; never fails the operation) ────────────────── */
async function _audit(row) {
  try {
    await _db().collection(AUDIT).add(Object.assign({ hub: 'fitness', createdAt: _ts() }, row));
  } catch (e) {
    logger.error('[fitness-attendance] audit failed', { action: row.action, err: (e && e.message) || 'Error' });
  }
}

async function _refusalAudit(action, req, extra, err) {
  const reason = (err && err.details && err.details.reason) || (err && err.code) || 'error';
  await _audit(Object.assign({ action, outcome: 'refused', reason, performedBy: (req.auth && req.auth.uid) || null }, extra || {}));
}

/* ── handlers (exported for the suite; wrapped by onCall below) ───────────── */
async function membershipQrHandler(req) {
  const uid = req.auth && req.auth.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in required.');
  const id = String((req.data && req.data.membershipId) || '');
  if (!ID_RE.test(id)) throw new HttpsError('invalid-argument', 'membershipId required.');
  const snap = await _db().collection(COL).doc(id).get();
  if (!snap.exists || snap.data().buyerUid !== uid) _refuse('not_found');    /* never confirm someone else's id */
  const m = snap.data();
  const refusal = checkInRefusal(m, _now());
  if (refusal) _refuse(refusal);
  const t = mintToken({ membershipId: id, buyerUid: m.buyerUid, providerId: m.providerId }, _now().getTime());
  return { token: t.token, expiresAt: new Date(t.exp).toISOString(), ttlSeconds: TOKEN_TTL_MS / 1000 };
}

async function checkInHandler(req) {
  const uid = req.auth && req.auth.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in required.');
  const d = req.data || {};
  const correlationId = _cid();
  const now = _now();
  let membershipId = null, providerId = null;
  try {
    const sessionRef = d.sessionRef == null || d.sessionRef === '' ? null : String(d.sessionRef);
    if (sessionRef !== null && !SESSION_RE.test(sessionRef)) throw new HttpsError('invalid-argument', 'sessionRef is invalid.');
    const v = verifyToken(d.token, now.getTime());
    if (!v.ok) _refuse(v.reason);
    membershipId = v.claims.membershipId;
    const ref = _db().collection(COL).doc(membershipId);
    const pre = await ref.get();
    if (!pre.exists) _refuse('not_found');
    const m0 = pre.data();
    providerId = m0.providerId || null;
    const scanner = await assertScanner(uid, m0);              /* authorization BEFORE any state is revealed */
    if (v.claims.providerId !== m0.providerId) _refuse('other_gym');
    if (v.claims.buyerUid !== m0.buyerUid) _refuse('wrong_member');

    const attId = attendanceIdFor(sessionRef, now);
    const attRef = ref.collection('attendance').doc(attId);
    let out = null;
    await _db().runTransaction(async (t) => {
      /* reads first */
      const ms = await t.get(ref);
      const as = await t.get(attRef);
      if (!ms.exists) _refuse('not_found');
      const m = ms.data();
      if (m.providerId !== m0.providerId || m.buyerUid !== m0.buyerUid) _refuse('wrong_member');
      if (as.exists) {                                         /* duplicate scan → the existing result, unchanged */
        const a = as.data();
        out = { duplicate: true, attendanceId: attId, status: a.status, firstCheckIn: false,
                attendedSessions: Number(m.attendedSessions) || 0, sessionsIncluded: Number(m.sessionsIncluded) || null };
        return;
      }
      const refusal = checkInRefusal(m, now);
      if (refusal) _refuse(refusal);
      const prior = Number(m.attendedSessions) || 0;
      const first = prior === 0 && !m.firstAttendedAt;
      t.create(attRef, {
        membershipId, memberUid: m.buyerUid, providerId: m.providerId, sessionRef, checkedInAt: _ts(),
        method: 'qr', actorUid: uid, actorRole: scanner.actorRole, status: 'checked_in', completedAt: null, correlationId,
      });
      const patch = { attendedSessions: prior + 1, lastAttendedAt: _ts(), updatedAt: _ts() };
      if (first) { patch.firstAttendedAt = _ts(); patch.refundEligible = false; }
      else if (m.refundEligible !== false) patch.refundEligible = false;   /* heal toward "used"; never back */
      t.update(ref, patch);
      out = { duplicate: false, attendanceId: attId, status: 'checked_in', firstCheckIn: first,
              attendedSessions: prior + 1, sessionsIncluded: Number(m.sessionsIncluded) || null };
    });
    await _audit({ action: out.duplicate ? 'fitness_checkin_duplicate' : 'fitness_checkin', outcome: 'ok', membershipId, providerId,
                   attendanceId: out.attendanceId, performedBy: uid, actorRole: scanner.actorRole, firstCheckIn: out.firstCheckIn, correlationId });
    if (out.firstCheckIn) {
      try {
        const rel = _hooks.release || ((id) => _settlement().releaseDueSlices(id));
        await rel(membershipId);
      } catch (e) {
        /* never fails the check-in; the 06:00 membershipReleaseSweep is the fallback */
        logger.error('[fitness-attendance] releaseDueSlices after first check-in failed', { membershipId, correlationId, err: (e && e.message) || 'Error' });
      }
    }
    logger.info('[fitness-attendance] check-in', { membershipId, providerId, attendanceId: out.attendanceId, duplicate: out.duplicate, first: out.firstCheckIn, correlationId });
    return Object.assign({ ok: true, correlationId }, out);
  } catch (e) {
    await _refusalAudit('fitness_checkin', req, { membershipId, providerId, correlationId }, e);
    if (e instanceof HttpsError) throw e;
    logger.error('[fitness-attendance] check-in error', { correlationId, err: (e && e.message) || 'Error' });
    throw new HttpsError('unavailable', 'Attendance could not be recorded. Please try again.', { correlationId });
  }
}

function _ids(d) {
  const membershipId = String((d && d.membershipId) || '');
  const attendanceId = String((d && d.attendanceId) || '');
  if (!ID_RE.test(membershipId) || !/^[sd]_[A-Za-z0-9_-]{1,64}$/.test(attendanceId)) throw new HttpsError('invalid-argument', 'membershipId and attendanceId required.');
  return { membershipId, attendanceId };
}

async function completeSessionHandler(req) {
  const uid = req.auth && req.auth.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in required.');
  const correlationId = _cid();
  let ids = {}, providerId = null;
  try {
    ids = _ids(req.data);
    const ref = _db().collection(COL).doc(ids.membershipId);
    const pre = await ref.get();
    if (!pre.exists) _refuse('not_found');
    providerId = pre.data().providerId || null;
    const scanner = await assertScanner(uid, pre.data());
    const attRef = ref.collection('attendance').doc(ids.attendanceId);
    let out = null;
    await _db().runTransaction(async (t) => {
      const as = await t.get(attRef);
      if (!as.exists) throw new HttpsError('not-found', 'Attendance record not found.');
      const a = as.data();
      if (a.status === 'completed') { out = { duplicate: true, status: 'completed' }; return; }
      if (a.status !== 'checked_in') throw new HttpsError('failed-precondition', 'This attendance record cannot be completed.', { reason: 'not_checked_in' });
      t.update(attRef, { status: 'completed', completedAt: _ts(), completedBy: uid, completedByRole: scanner.actorRole });
      out = { duplicate: false, status: 'completed' };
    });
    await _audit({ action: 'fitness_session_completed', outcome: 'ok', membershipId: ids.membershipId, attendanceId: ids.attendanceId, providerId,
                   performedBy: uid, actorRole: scanner.actorRole, duplicate: out.duplicate, correlationId });
    return Object.assign({ ok: true, correlationId, attendanceId: ids.attendanceId }, out);
  } catch (e) {
    await _refusalAudit('fitness_session_completed', req, { membershipId: ids.membershipId || null, attendanceId: ids.attendanceId || null, providerId, correlationId }, e);
    if (e instanceof HttpsError) throw e;
    logger.error('[fitness-attendance] complete error', { correlationId, err: (e && e.message) || 'Error' });
    throw new HttpsError('unavailable', 'Could not complete the session. Please try again.', { correlationId });
  }
}

/* ADMIN-only. Appends a correction; voids the row; NEVER resets refundEligible / firstAttendedAt / attendedSessions
   (owner: nobody may reset attendance to regain refund eligibility — refund exceptions are AdminOS-approved through
   the canonical refund authority, not here). Restores one ENTITLEMENT session via voidedSessions. */
async function correctAttendanceHandler(req) {
  const uid = req.auth && req.auth.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in required.');
  const correlationId = _cid();
  let ids = {};
  try {
    if (!_isAdmin(req)) _refuse('no_permission');
    ids = _ids(req.data);
    const reason = String((req.data && req.data.reason) || '').replace(/[<>]/g, '').trim().slice(0, 500);
    if (reason.length < 3) throw new HttpsError('invalid-argument', 'A correction reason is required.');
    const ref = _db().collection(COL).doc(ids.membershipId);
    const attRef = ref.collection('attendance').doc(ids.attendanceId);
    const corrRef = ref.collection('attendanceCorrections').doc(ids.attendanceId);
    let out = null;
    await _db().runTransaction(async (t) => {
      const ms = await t.get(ref);
      const as = await t.get(attRef);
      if (!ms.exists) _refuse('not_found');
      if (!as.exists) throw new HttpsError('not-found', 'Attendance record not found.');
      const a = as.data();
      if (a.status === 'voided_by_admin') { out = { duplicate: true, status: a.status }; return; }
      t.create(corrRef, { membershipId: ids.membershipId, attendanceId: ids.attendanceId, previousStatus: a.status,
                          status: 'voided_by_admin', reason, actorUid: uid, actorRole: 'admin', correctedAt: _ts(), correlationId,
                          note: 'Refund lock unchanged: attendance corrections never restore refund eligibility.' });
      t.update(attRef, { status: 'voided_by_admin', voidedAt: _ts(), voidedBy: uid, voidReason: reason });
      t.update(ref, { voidedSessions: (Number(ms.data().voidedSessions) || 0) + 1, updatedAt: _ts() });
      out = { duplicate: false, status: 'voided_by_admin' };
    });
    await _audit({ action: 'fitness_attendance_corrected', outcome: 'ok', membershipId: ids.membershipId, attendanceId: ids.attendanceId,
                   performedBy: uid, actorRole: 'admin', reason, duplicate: out.duplicate, correlationId });
    return Object.assign({ ok: true, correlationId, attendanceId: ids.attendanceId, refundLockUnchanged: true }, out);
  } catch (e) {
    await _refusalAudit('fitness_attendance_corrected', req, { membershipId: ids.membershipId || null, attendanceId: ids.attendanceId || null, correlationId }, e);
    if (e instanceof HttpsError) throw e;
    logger.error('[fitness-attendance] correction error', { correlationId, err: (e && e.message) || 'Error' });
    throw new HttpsError('unavailable', 'Could not record the correction. Please try again.', { correlationId });
  }
}

/* ── deployables (NOT deployed) ──────────────────────────────────────────── */
const _secrets = () => [require('./event-ops').SOKONI_HMAC_KEY];
const OPTS = { region: 'us-central1', enforceAppCheck: true, maxInstances: 20 };
const fitnessMembershipQr = onCall(Object.assign({ secrets: _secrets() }, OPTS), membershipQrHandler);
const fitnessCheckIn = onCall(Object.assign({ secrets: _secrets() }, OPTS), checkInHandler);
const fitnessCompleteSession = onCall(OPTS, completeSessionHandler);
const fitnessCorrectAttendance = onCall(OPTS, correctAttendanceHandler);

module.exports = {
  fitnessMembershipQr, fitnessCheckIn, fitnessCompleteSession, fitnessCorrectAttendance,
  mintToken, verifyToken, checkInRefusal, attendanceIdFor, localDay, REASONS, TOKEN_TTL_MS, COL,
  _h: { membershipQrHandler, checkInHandler, completeSessionHandler, correctAttendanceHandler },
  _test: { use: (h) => Object.assign(_hooks, h || {}) },
};
