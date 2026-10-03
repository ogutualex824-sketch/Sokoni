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
     staff     workforce-identity._assertBusinessPermission(uid, <gym business>, 'attendance') — the existing
               permission-keyed guard (never a third one). The gym's business is resolved SERVER-side from the canonical
               link providers/{providerId}.linkedBusinessId, verified against businesses/{id}.ownerId; no link →
               BUSINESS_LINK_MISSING (never inferred from businesses.where(ownerId), never from the client).
               'attendance' has NO role default: cashier / trainer / receptionist never get it automatically.
     gym gate  providers/{providerId} approved (active|approved, not suspended) + business-workspace.assertModule
               'memberships' once sokoni-5b ships that module (until then the gate reports PENDING and the ownership
               checks alone decide — docs/FITNESS_MEMBERSHIP_ATTENDANCE.md §Staff authorization)
     notify    notify.js (the ONE sender; same convention as membership-settlement._notify), best-effort after commit
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
  business_link_missing: { code: 'failed-precondition', msg: "Staff attendance isn't set up for this gym yet. Ask the gym owner to scan." },
  not_approved: { code: 'failed-precondition', msg: "This gym isn't approved to record attendance right now." },
  module_unavailable: { code: 'failed-precondition', msg: "Memberships aren't enabled for this business." },
});

/* The workforce permission key that lets a staff member scan / view memberships for a gym. Registered in
   workforce-identity ALL_PERMISSIONS with NO role default (owner decision: cashier/trainer/employee NOT automatic). */
const ATTENDANCE_PERMISSION = 'attendance';
const APPROVED_PROVIDER_STATES = Object.freeze(['active', 'approved']);   /* booking-service / fitness-membership-create */
const MODULE_KEY = 'memberships';                                          /* business-workspace module (sokoni-5b) */
/* Scanner-status reasons (contract): NOT_APPROVED | BUSINESS_LINK_MISSING | NO_PERMISSION; + MODULE_NOT_AVAILABLE once
   the 'memberships' module gate is enforced, + MULTIPLE_GYMS for a staff member authorized at more than one gym. */
const SCOPE = Object.freeze({ NOT_APPROVED: 'NOT_APPROVED', BUSINESS_LINK_MISSING: 'BUSINESS_LINK_MISSING', NO_PERMISSION: 'NO_PERMISSION',
  MODULE_NOT_AVAILABLE: 'MODULE_NOT_AVAILABLE', MULTIPLE_GYMS: 'MULTIPLE_GYMS' });

/* Overridable ONLY by the suite (in-memory Firestore; emulator proof is QUEUED). */
const _hooks = { db: null, ts: null, now: null, release: null, staffAuthority: null, correlationId: null, wfi: null, moduleGate: null, notify: null };
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

/* ── gym ↔ business linkage, staff authority, gym gate ───────────────────── */
const _wfi = () => _hooks.wfi || require('./workforce-identity');
const _str = (v) => (typeof v === 'string' ? v : '');

/**
 * The gym's canonical business id, resolved SERVER-side → { ok:true, businessId } | { ok:false, reason, detail }.
 * The ONLY link read is providers/{providerId}.linkedBusinessId (server-written by approval provisioning — see the
 * docs' hand-off; it does not exist on any lineage yet). It is accepted only if businesses/{id} exists, is owned by
 * this provider (ownerId), is not malformed (merchantId, when present, equals the doc id — tenant-identity's rule)
 * and is not inactive. NEVER inferred from businesses.where(ownerId == providerId): an owner may hold a shop, a
 * delivery business and a gym, and picking one is inventing the bridge.
 */
async function resolveGymBusiness(providerId) {
  const missing = (detail) => ({ ok: false, reason: SCOPE.BUSINESS_LINK_MISSING, detail });
  if (!_str(providerId)) return missing('no_provider');
  const p = await _db().collection('providers').doc(providerId).get();
  if (!p.exists) return missing('no_provider');
  const id = _str((p.data() || {}).linkedBusinessId);
  if (!ID_RE.test(id)) return missing('no_link');
  const b = await _db().collection('businesses').doc(id).get();
  if (!b.exists) return missing('business_absent');
  const bd = b.data() || {};
  if (bd.ownerId !== providerId) return missing('owner_mismatch');
  if (bd.merchantId && bd.merchantId !== id) return missing('malformed');
  if (bd.status && bd.status !== 'active') return missing('inactive');
  return { ok: true, businessId: id };
}

/**
 * Staff authority for ONE gym: the caller must hold an ACTIVE workspace membership in THAT gym's business with the
 * explicit 'attendance' permission — decided by workforce-identity._assertBusinessPermission (imported, never copied).
 * → { allowed:true, role:'staff', businessId } | { allowed:false, reason }
 */
async function _staffAuthority(uid, providerId) {
  if (_hooks.staffAuthority) return _hooks.staffAuthority(uid, providerId);
  const link = await resolveGymBusiness(providerId);
  if (!link.ok) return { allowed: false, reason: SCOPE.BUSINESS_LINK_MISSING };
  const businessId = link.businessId;
  try {
    await _wfi()._assertBusinessPermission(uid, businessId, ATTENDANCE_PERMISSION);
  } catch (e) {
    if (e && (e.code === 'permission-denied' || e.code === 'not-found')) return { allowed: false, reason: SCOPE.NO_PERMISSION };
    throw e;
  }
  return { allowed: true, role: 'staff', businessId };
}

/** The 'memberships' module gate (sokoni-5b's capability engine). → { ok:true, state:'enforced'|'pending' } | { ok:false, reason } */
async function moduleGate(providerId) {
  if (_hooks.moduleGate) return _hooks.moduleGate(providerId);
  const BW = require('./business-workspace');
  /* PENDING until business-workspace.MODULES carries 'memberships' (hand-off text in the docs). assertModule on an
     unknown key would refuse EVERY gym (WORKSPACE_MODULE_UNKNOWN), so the gate engages the day the key ships. */
  if (!BW.MODULES || !Object.prototype.hasOwnProperty.call(BW.MODULES, MODULE_KEY) || typeof BW.assertModule !== 'function') return { ok: true, state: 'pending' };
  try {
    await BW.assertModule(_db(), providerId, MODULE_KEY, HttpsError);
    return { ok: true, state: 'enforced' };
  } catch (e) {
    if (e instanceof HttpsError && e.code === 'failed-precondition') return { ok: false, reason: SCOPE.MODULE_NOT_AVAILABLE, detail: (e.details && e.details.code) || null };
    throw e;
  }
}

/** The gym itself may operate memberships: approved provider + module gate. → null | SCOPE reason */
async function gymRefusal(providerId) {
  const p = await _db().collection('providers').doc(String(providerId)).get();
  const d = p.exists ? (p.data() || {}) : null;
  if (!d || !APPROVED_PROVIDER_STATES.includes(String(d.status || '')) || d.suspended === true) return SCOPE.NOT_APPROVED;
  const g = await moduleGate(String(providerId));
  return g.ok ? null : SCOPE.MODULE_NOT_AVAILABLE;
}
const _gymRefusalCode = (r) => (r === SCOPE.NOT_APPROVED ? 'not_approved' : 'module_unavailable');

/** → { actorRole } or throws. Distinguishes "another gym" from "no permission" without revealing either gym. */
async function assertScanner(uid, m) {
  let actorRole = null;
  if (uid === m.providerId) {
    if (uid === m.buyerUid) _refuse('self_scan');
    actorRole = 'owner';
  } else {
    const staff = await _staffAuthority(uid, m.providerId);
    if (staff && staff.allowed === true) {
      if (uid === m.buyerUid) _refuse('self_scan');
      actorRole = String(staff.role || 'staff');
    } else {
      const isProvider = (await _db().collection('providers').doc(String(uid)).get()).exists;
      if (isProvider) _refuse('other_gym');
      /* 'link missing' is told ONLY to someone who holds 'attendance' in a business this gym's owner owns — a stranger
         or the member scanning their own code learns nothing about the gym's configuration. */
      _refuse(staff && staff.reason === SCOPE.BUSINESS_LINK_MISSING && await _attendanceAtOwner(uid, m.providerId) ? 'business_link_missing' : 'no_permission');
    }
  }
  const gr = await gymRefusal(m.providerId);
  if (gr) _refuse(_gymRefusalCode(gr));
  return { actorRole };
}

/** Does the caller hold an ACTIVE 'attendance' membership in ANY business owned by ownerUid? (refusal wording only — never a grant) */
async function _attendanceAtOwner(uid, ownerUid) {
  const q = await _db().collection('workspaceMemberships').where('uid', '==', uid).where('status', '==', 'active').limit(10).get();
  for (const d of q.docs) {
    const w = d.data() || {};
    if (!Array.isArray(w.permissions) || !w.permissions.includes(ATTENDANCE_PERMISSION) || !ID_RE.test(_str(w.businessId))) continue;
    const b = await _db().collection('businesses').doc(w.businessId).get();
    if (b.exists && (b.data() || {}).ownerId === ownerUid) return true;
  }
  return false;
}

/**
 * Staff discovery for the READ callables (which carry no gym in the request): the gyms whose business this caller is
 * an active 'attendance' member of. Discovery only — authorization is still _staffAuthority (the workforce guard).
 * Bounded: ≤10 memberships. → { gyms:[{providerId, businessId}], unlinked:boolean }
 */
async function _staffGyms(uid) {
  const q = await _db().collection('workspaceMemberships').where('uid', '==', uid).where('status', '==', 'active').limit(10).get();
  const gyms = []; let unlinked = false;
  for (const d of q.docs) {
    const w = d.data() || {};
    if (!Array.isArray(w.permissions) || !w.permissions.includes(ATTENDANCE_PERMISSION) || !ID_RE.test(_str(w.businessId))) continue;
    const b = await _db().collection('businesses').doc(w.businessId).get();
    const owner = b.exists ? _str((b.data() || {}).ownerId) : '';
    if (!owner) { unlinked = true; continue; }
    const link = await resolveGymBusiness(owner);
    if (link.ok && link.businessId === w.businessId) gyms.push({ providerId: owner, businessId: w.businessId });
    else if (link.detail !== 'no_provider') unlinked = true;          /* a non-gym business is not a missing gym link */
  }
  return { gyms, unlinked };
}

/**
 * Which gym may this caller READ / scan for? Never from the request. → { ok:true, providerId, role } | { ok:false, reason }
 *   owner: providers/{uid} exists → that gym (an owner never reads another gym through a staff membership)
 *   staff: exactly one gym from _staffGyms, re-authorized by _staffAuthority; several → MULTIPLE_GYMS (no selector
 *          is accepted from the client — documented limitation)
 * Then the gym gate (approved + 'memberships' module).
 */
async function resolveGymScope(uid) {
  let providerId = null; let role = null;
  const own = await _db().collection('providers').doc(String(uid)).get();
  if (own.exists) { providerId = String(uid); role = 'owner'; } else {
    const s = await _staffGyms(uid);
    if (!s.gyms.length) return { ok: false, reason: s.unlinked ? SCOPE.BUSINESS_LINK_MISSING : SCOPE.NO_PERMISSION };
    if (s.gyms.length > 1) return { ok: false, reason: SCOPE.MULTIPLE_GYMS };
    const a = await _staffAuthority(uid, s.gyms[0].providerId);
    if (!a || a.allowed !== true) return { ok: false, reason: (a && a.reason) || SCOPE.NO_PERMISSION };
    providerId = s.gyms[0].providerId; role = 'staff';
  }
  const gr = await gymRefusal(providerId);
  if (gr) return { ok: false, reason: gr, role };
  return { ok: true, providerId, role };
}

/* ── member display name (the gym needs to recognise who is at the door; nothing else) ── */
async function memberDisplayName(buyerUid) {
  try {
    const u = await _db().collection('users').doc(String(buyerUid)).get();
    if (!u.exists) return null;
    const d = u.data() || {};
    const n = String(d.displayName || d.name || '').replace(/[<>"'`]/g, '').replace(/\s+/g, ' ').trim().slice(0, 60);
    return n || null;
  } catch (_) { return null; }
}

/* ── notifications (notify.js — the ONE sender; never throws into attendance) ── */
async function _notify(args) {
  try {
    if (_hooks.notify) return await _hooks.notify(args);
    if (_hooks.db) return null;
    await require('./notify').notify(Object.assign({ awaitDelivery: false }, args)).catch(() => {});
  } catch (_) { /* best-effort: the attendance is already committed */ }
  return null;
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
        const at = _date(a.checkedInAt);
        out = { duplicate: true, attendanceId: attId, status: a.status, firstCheckIn: false,
                attendedSessions: Number(m.attendedSessions) || 0, sessionsIncluded: Number(m.sessionsIncluded) || null,
                checkedInAt: at ? at.toISOString() : null, title: m.title || null };
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
              attendedSessions: prior + 1, sessionsIncluded: Number(m.sessionsIncluded) || null,
              checkedInAt: now.toISOString(), title: m.title || null };
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
    if (!out.duplicate) {
      /* Member notice via notify.js, AFTER commit, once per ledger row (dedupeKey = the attendance id). Type
         'booking_confirmed' = an existing registered commerce/orders type (2f's convention: reuse registered types;
         a dedicated 'membership_attendance' type is a notify.js hand-off). No PII beyond the member's own plan title. */
      const used = out.attendedSessions - (Number(m0.voidedSessions) || 0);
      const of = out.sessionsIncluded ? `Session ${used} of ${out.sessionsIncluded}.` : 'Unlimited sessions.';
      await _notify({ uid: m0.buyerUid, type: 'booking_confirmed', title: 'Attendance recorded ✅',
        body: `Check-in recorded for ${String(out.title || 'your membership').slice(0, 80)}. ${of}`
          + (out.firstCheckIn ? ' Your membership is now in use, so it can no longer be refunded.' : ''),
        deepLink: '/fitness-hub.html', dedupeKey: `membership_checkin_${membershipId}_${out.attendanceId}` });
    }
    const memberName = await memberDisplayName(m0.buyerUid);
    logger.info('[fitness-attendance] check-in', { membershipId, providerId, attendanceId: out.attendanceId, duplicate: out.duplicate, first: out.firstCheckIn, correlationId });
    return Object.assign({ ok: true, correlationId }, out, { member: { displayName: memberName } });
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
  ATTENDANCE_PERMISSION, SCOPE, MODULE_KEY,
  /* shared with fitness-gym-memberships.js (the gym read callables) — one authorization path, not two */
  resolveGymBusiness, resolveGymScope, moduleGate, gymRefusal, memberDisplayName, _date, _db, _now,
  _h: { membershipQrHandler, checkInHandler, completeSessionHandler, correctAttendanceHandler },
  _test: { use: (h) => Object.assign(_hooks, h || {}) },
};
