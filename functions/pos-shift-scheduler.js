/* ================================================================
   SOKONI SmartPOS 3.0 — Shift Scheduling & Roster Management
   functions/pos-shift-scheduler.js  v1.0  (2026-07-07)

   Exports:
     createShiftTemplate    — define a reusable shift pattern
     publishWeeklyRoster    — publish the week's shifts for a branch
     assignShift            — assign a staff member to a shift
     swapShiftRequest       — employee requests a shift swap
     approveShiftSwap       — manager approves/declines swap
     setStaffAvailability   — employee marks unavailability windows
     getRoster              — fetch published roster for a branch/date range
     getRosterGaps          — find shifts with no assigned staff
     getStaffRoster         — individual staff schedule
     acknowledgeShift       — employee confirms they've seen their shift
     schedulerWeeklyDigest  — SCHEDULED: weekly roster summary + gap alerts
================================================================ */
'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule }         = require('firebase-functions/v2/scheduler');
const admin                  = require('firebase-admin');

/* Same load-time guard as merchant-shift-gate.js, and for the same reason: the
   certification harness stubs firebase-admin, so `admin.apps` is undefined and `.length`
   threw before this module finished loading — a crash reported as a harness fault rather
   than as a failing check, which reads like broken tooling instead of untested money code.
   Production behaviour is unchanged; the accessor below is lazy either way. */
if (!admin.apps || !admin.apps.length) {
  try { admin.initializeApp(); } catch (_) { /* stubbed admin: initialised lazily */ }
}
const db     = () => admin.firestore();
const TS     = () => admin.firestore.FieldValue.serverTimestamp();
const _CF    = { region: 'us-central1', enforceAppCheck: true };
const _SCHED = { region: 'us-central1', schedule: '0 7 * * 1', timeZone: 'Africa/Nairobi' }; // Mon 07:00

const { assertMerchantAccess, canAccessMerchant } = require('./merchant-authority');

/* ── TENANT BINDING ────────────────────────────────────────────────────────
   _requireRole below answers "does this caller hold a manager claim ANYWHERE".
   It is a GLOBAL claim, never scoped to the seller being acted on, and it was
   the only gate on this module. So a holder of that claim could publish or
   modify a roster for ANY sellerId, and any signed-in caller could read one:
   ten callables took the tenant from request.data and never checked it.

   That is the defect class where a check against a caller-controlled value is
   worse than no check, and it matters more here than it looks: this roster is
   intended to become an authorization input for Merchant V2 shift access. A
   store the restricted party can author would make that feature's guarantee
   void — an employee could grant themselves a shift.

   assertMerchantAccess is the SAME helper the procurement callables use — self
   access, businesses/{id}.ownerId, declared adminUids, an unforgeable admin
   claim, and FAIL CLOSED on an unknown merchant. No second authority is
   introduced.

   _requireRole is GONE. It was kept here as a preliminary capability check on the
   reasoning that a global role is still useful as long as it cannot stand in for
   tenancy. That reasoning assumed the claim it read existed; it did not, so the
   check could only ever refuse — including the owner. It is replaced below by a
   level resolved FOR THE TENANT, which answers capability and tenancy in one
   decision rather than stacking a global check in front of a scoped one. */
async function _assertSeller(auth, sellerId) {
  return assertMerchantAccess(auth, sellerId);
}

/* Callables addressed by a DOCUMENT ID rather than a tenant. The id proves
   nothing on its own — anyone can name one — so the stored document is read to
   learn which tenant it belongs to, and THAT is what gets authorized. The read
   is unavoidable: it is how the tenant becomes known. Nothing is returned to
   the caller and nothing is mutated before the check. */
async function _assertRoster(auth, rosterId, opts) {
  if (!rosterId) throw new HttpsError('invalid-argument', 'rosterId required');
  const snap = await db().collection('posRosters').doc(String(rosterId)).get();
  if (!snap.exists) throw new HttpsError('not-found', 'Roster not found');
  const roster = snap.data() || {};

  /* One way in: authority over the merchant that owns the roster. */
  if (await canAccessMerchant(auth, roster.sellerId)) return { snap, roster };

  /* The other: being ROSTERED on it. An employee acting on their own shift —
     acknowledging it, asking to swap it — has no authority over the merchant
     and must not need any; requiring it here would lock every employee out of
     their own schedule. Assignment is the proof of belonging, and each caller
     still re-checks the SPECIFIC slot it was given ("You are not assigned to
     this shift"), so this widens who may look up the roster, never what they
     may then do to it. */
  if (opts && opts.orAssigned) {
    const assigned = (roster.slots || []).some((sl) =>
      ((sl && sl.assignedStaff) || []).some((a) => a && a.uid === auth.uid));
    if (assigned) return { snap, roster };
  }

  throw new HttpsError('permission-denied', 'Not authorised for this roster.');
}

/* ── Auth helpers ──────────────────────────────────────────── */
function _requireAuth(req) {
  if (!req.auth) throw new HttpsError('unauthenticated', 'Login required');
  return req.auth;
}
/* ── WHO MAY MANAGE A ROSTER ───────────────────────────────────────────────
   This replaces a gate that could never open. _requireRole() scored the caller
   from auth.token.posRole || auth.token.role and defaulted to 'cashier'. No
   function in this repository mints either: claimsFor() and
   application-lifecycle.js write per-role BOOLEANS (claims.seller = true), and
   the only role STRING ever minted is role:"superAdmin" on the one-time
   bootstrap in index.js — a value absent from the level map below, so it
   scored 0 as well. Every caller therefore scored 0, and the five gated
   callables were unreachable by the shop owner, by a platform admin, and by
   everyone else. Proven at runtime in
   scripts/probe-shift-scheduler-reachability.js before this change.

   The level is now resolved FOR THE TENANT BEING ACTED ON, from the authority
   that already exists, in this order:

     platform admin  — an unforgeable boolean claim
     owner           — canAccessMerchant(), the same helper _assertSeller uses
     manager         — a CORROBORATED shopEmployees record at a shop this
                       tenant owns

   A global claim is not consulted at all, because a global answer cannot bind a
   tenant: that is the defect class this module's own tenant-binding comment
   describes, and re-introducing it here would undo it.

   The corroboration is the one resolveShopAccess performs, reusing its own
   exported primitive rather than restating the rule: a forged employment record
   names the forger as owner, the real shop document names the real one, and the
   two will not agree. Without it, an employee could write themselves a manager
   record and then author the roster that governs their own shift access —
   which is precisely the guarantee f8b5e02 depends on. */
const { EMPLOYEES, SHOP_ROLES, shopOwnerOf } = require('./shop-employees');

const LEVELS = { cashier: 0, supervisor: 1, manager: 2, owner: 3, admin: 4 };

/* The employment vocabulary has no 'supervisor'. manager is the only staff role
   that manages a roster; cashier, inventory and support are staff who are
   rostered, not staff who roster. Anything unlisted stays at 0 — a new
   employment role must be granted scheduling authority deliberately, never by
   being added to SHOP_ROLES. */
const EMPLOYMENT_LEVEL = { manager: LEVELS.manager };

/* The uid whose shops belong to this tenant. sellerId is usually the owner's own
   uid, which assertMerchantAccess treats as self-access. When a merchant runs
   under a distinct businesses/{id}, the owner is named there. Anything else
   resolves to null and the employment path simply does not apply — FAIL CLOSED,
   the same posture assertMerchantAccess takes on an unknown merchant. */
async function _tenantOwnerUid(sellerId) {
  const sid = String(sellerId || '');
  if (!sid) return null;
  try {
    const snap = await db().collection('businesses').doc(sid).get();
    if (snap.exists) {
      const owner = String((snap.data() || {}).ownerId || '');
      if (owner) return owner;
    }
  } catch (_) { /* an unreadable authority is not an authorising one */ }
  return sid;
}

/**
 * Every CORROBORATED, ACTIVE employment `uid` holds at the tenant owned by
 * `tenantOwner`, as employment roles.
 *
 * ONE scan, used for two different questions — "what may this caller do here"
 * and "does this person work here" — so the two can never drift into disagreeing
 * about what counts as employment.
 *
 * The corroboration is resolveShopAccess's: a forged record names the forger as
 * the shop's owner, the real shop document names the real one, and the two will
 * not agree. Without it a person could write themselves onto any roster.
 */
async function _employmentRolesAt(uid, tenantOwner) {
  const u = String(uid || '');
  const owner = String(tenantOwner || '');
  if (!u || !owner) return [];
  const snap = await db().collection(EMPLOYEES).where('uid', '==', u).get();
  const roles = [];
  for (const doc of snap.docs) {
    const e = doc.data() || {};
    if (e.active === false) continue;
    if (!SHOP_ROLES.includes(e.role)) continue;
    const shopId = String(e.shopId || '');
    if (!shopId) continue;
    const shopSnap = await db().collection('shops').doc(shopId).get();
    if (!shopSnap.exists) continue;
    const ownerUid = shopOwnerOf(shopSnap.data() || {});
    if (!ownerUid) continue;
    if (String(e.shopOwnerId || '') !== String(ownerUid)) continue;   /* corroboration */
    if (String(ownerUid) !== owner) continue;                         /* and the right tenant */
    roles.push(e.role);
  }
  return roles;
}

async function _employmentLevel(auth, sellerId) {
  const uid = String((auth && auth.uid) || '');
  if (!uid) return 0;
  const tenantOwner = await _tenantOwnerUid(sellerId);
  if (!tenantOwner) return 0;
  const roles = await _employmentRolesAt(uid, tenantOwner);
  return roles.reduce((best, r) => Math.max(best, EMPLOYMENT_LEVEL[r] || 0), 0);
}

/**
 * May `staffUid` be put on this tenant's roster at all?
 *
 * A roster names who works when. Writing somebody onto one who does not work
 * there produces a staffing record about a person with no relationship to the
 * merchant — and the roster is an authorization INPUT for Merchant V2 shift
 * access, so the set of names in it should never be wider than the set of people
 * who work there. assignShift previously took staffUid on trust.
 *
 * The tenant OWNER counts: a sole trader who works their own counter has no
 * shopEmployees record and must still be rosterable.
 */
async function _isTenantMember(sellerId, staffUid) {
  const who = String(staffUid || '');
  if (!who) return false;
  const tenantOwner = await _tenantOwnerUid(sellerId);
  if (!tenantOwner) return false;
  if (who === tenantOwner) return true;
  const roles = await _employmentRolesAt(who, tenantOwner);
  return roles.length > 0;
}

async function _levelFor(auth, sellerId) {
  const t = (auth && auth.token) || {};
  if (t.admin === true || t.superAdmin === true) return LEVELS.admin;
  if (await canAccessMerchant(auth, sellerId)) return LEVELS.owner;
  return _employmentLevel(auth, sellerId);
}

/* Tenancy and capability in ONE decision. The level can only be reached by
   holding authority over THIS sellerId, so this replaces the old
   _requireRole + _assertSeller pair rather than sitting in front of it — and it
   is never weaker: everyone who satisfied _assertSeller scores owner or above. */
async function _requireSellerRole(auth, sellerId, minRole) {
  if (!sellerId) throw new HttpsError('invalid-argument', 'sellerId required');
  const have = await _levelFor(auth, sellerId);
  if (have < (LEVELS[minRole] ?? 0))
    throw new HttpsError('permission-denied', `Requires ${minRole} role or above`);
  return have;
}

/* The same decision for callables addressed by a roster id. The id proves
   nothing, so the stored document names the tenant and THAT is what is scored.
   Nothing is returned or mutated before the check. */
async function _requireRosterRole(auth, rosterId, minRole) {
  if (!rosterId) throw new HttpsError('invalid-argument', 'rosterId required');
  const snap = await db().collection('posRosters').doc(String(rosterId)).get();
  if (!snap.exists) throw new HttpsError('not-found', 'Roster not found');
  const roster = snap.data() || {};
  const have = await _levelFor(auth, roster.sellerId);
  if (have < (LEVELS[minRole] ?? 0))
    throw new HttpsError('permission-denied', 'Not authorised for this roster.');
  return { snap, roster, level: have };
}
function _san(v, max = 200) {
  return typeof v === 'string' ? v.replace(/[<>"'`]/g, '').trim().slice(0, max) : '';
}
function _today() { return new Date().toISOString().slice(0, 10); }
function _isoDate(v) {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v))
    throw new HttpsError('invalid-argument', `Invalid date: ${v} (expected YYYY-MM-DD)`);
  return v;
}
function _isoTime(v) {
  if (typeof v !== 'string' || !/^\d{2}:\d{2}$/.test(v))
    throw new HttpsError('invalid-argument', `Invalid time: ${v} (expected HH:MM)`);
  return v;
}

/* ── Weekday names ─────────────────────────────────────────── */
const WEEKDAYS = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];

/* ══ SHIFT TIME SEMANTICS ═══════════════════════════════════════════════════
   startTime/endTime are LOCAL WALL-CLOCK in the shop's configured timezone.
   Deciding whether a shift is running therefore needs an actual instant, not a
   string comparison — '23:30' > '05:00' is true and means nothing about time.

   The offset is read from Intl at the instant in question rather than assumed.
   Africa/Nairobi is UTC+3 today, but a hardcoded +3 is a latent bug the moment a
   rule changes, and a zone with DST would be wrong twice a year. This mirrors
   pos-business-day-gate.js, which already refuses that shortcut, including its
   two hard-won details: some ICU builds report hour '24' at midnight, and the
   offset needs a second pass to converge across a DST boundary.

   NOT wired into any authorization path yet. This slice establishes correct
   semantics so the shift-access slice has something sound to build on. */

/** Is this a timezone this runtime can actually resolve? Intl is the authority. */
function isValidTimezone(tz) {
  if (typeof tz !== 'string' || !tz.trim()) return false;
  /* Shape first: Intl accepts some non-IANA aliases, and 'UTC' or a bare offset
     is not a shop location. Require Region/City. */
  if (!/^[A-Za-z][A-Za-z0-9_+-]*\/[A-Za-z0-9_+\-/]+$/.test(tz)) return false;
  try { new Intl.DateTimeFormat('en-CA', { timeZone: tz }); return true; }
  catch (_) { return false; }
}

function _partsAt(ms, tz) {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = {};
  for (const { type, value } of f.formatToParts(new Date(ms))) p[type] = value;
  const hour = (Number(p.hour) === 24) ? 0 : Number(p.hour);   /* ICU '24' at midnight */
  return { y: Number(p.year), m: Number(p.month), d: Number(p.day),
           hour, min: Number(p.minute), sec: Number(p.second) };
}

/** The zone's offset from UTC at a given instant, in ms. Derived, never assumed. */
function _offsetMsAt(ms, tz) {
  const p = _partsAt(ms, tz);
  return Date.UTC(p.y, p.m - 1, p.d, p.hour, p.min, p.sec) - (ms - (ms % 1000));
}

/** The instant at which `YYYY-MM-DD HH:MM` occurred in `tz`. */
function instantFor(dateStr, timeStr, tz, dayOffset) {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  const [hh, mm]  = String(timeStr).split(':').map(Number);
  const wall = Date.UTC(y, m - 1, d + (dayOffset || 0), hh, mm, 0);
  /* Two passes: read the offset near the target, then at the corrected instant,
     so the result converges even when a DST change sits between them. */
  let t = wall - _offsetMsAt(wall, tz);
  t = wall - _offsetMsAt(t, tz);
  return t;
}

/**
 * Is a rostered shift running at `now`?
 *
 *   08:00 -> 17:00   same calendar day
 *   21:00 -> 05:00   crosses midnight, ends the NEXT day
 *   08:00 -> 08:00   REJECTED — see below
 *
 * The interval is half-open, [start, end): a shift ending at 17:00 is over AT
 * 17:00. The closeout allowance is a separate decision and deliberately not
 * folded in here.
 *
 * `now` is always explicit so this is deterministic and testable. Nothing reads
 * a browser or server local timezone.
 */
function isShiftActive({ shiftDate, startTime, endTime, timezone, now }) {
  if (!isValidTimezone(timezone)) return { active: false, reason: 'invalid-timezone' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(shiftDate))) return { active: false, reason: 'invalid-date' };
  if (!/^\d{2}:\d{2}$/.test(String(startTime)) || !/^\d{2}:\d{2}$/.test(String(endTime))) {
    return { active: false, reason: 'invalid-time' };
  }
  const [sh, sm] = String(startTime).split(':').map(Number);
  const [eh, em] = String(endTime).split(':').map(Number);
  if (sh > 23 || eh > 23 || sm > 59 || em > 59) return { active: false, reason: 'invalid-time' };

  /* EQUAL START AND END. Read as a zero-length shift, not a 24-hour one. The
     scheduler has never defined it, and guessing "24 hours" would hand someone a
     full day of access from a value they may well have typed by mistake. */
  if (startTime === endTime) return { active: false, reason: 'zero-length-shift' };

  const startMs = instantFor(shiftDate, startTime, timezone, 0);
  const overnight = endTime < startTime;
  const endMs = instantFor(shiftDate, endTime, timezone, overnight ? 1 : 0);
  const t = (typeof now === 'number') ? now : Date.now();

  return {
    active: t >= startMs && t < endMs,
    overnight,
    startMs,
    endMs,
    reason: null,
  };
}

/* ================================================================
   createShiftTemplate
   Define a reusable shift pattern: name, start/end, required staff,
   roles needed, applicable days.
   Input: { sellerId, name, startTime, endTime, requiredStaff,
            rolesNeeded?, days?, description? }
================================================================ */
exports.createShiftTemplate = onCall(_CF, async (request) => {
  const auth = _requireAuth(request);

  const { sellerId, name, startTime, endTime, requiredStaff, rolesNeeded, days, description } = request.data;
  /* Tenancy AND capability, before any write. */
  await _requireSellerRole(auth, sellerId, 'manager');
  if (!name)          throw new HttpsError('invalid-argument', 'name required');
  if (!startTime)     throw new HttpsError('invalid-argument', 'startTime required');
  if (!endTime)       throw new HttpsError('invalid-argument', 'endTime required');
  if (!requiredStaff) throw new HttpsError('invalid-argument', 'requiredStaff required');

  _isoTime(startTime);
  _isoTime(endTime);
  /* OVERNIGHT IS A PROPERTY OF THE INTERVAL, NOT OF THE CLOCK FACE. The old rule
     allowed an overnight shift only when `startTime > '22:00' && endTime < '06:00'`,
     which rejected 21:00-05:00 and 22:00-07:00 — both ordinary night shifts — for
     no reason other than where the string sorted. Any start after any end simply
     crosses midnight; the only genuinely undefined case is start === end, which is
     refused rather than guessed at as a 24-hour shift. */
  if (startTime === endTime)
    throw new HttpsError('invalid-argument', 'startTime and endTime cannot be identical.');

  const validDays = (days || WEEKDAYS).filter(d => WEEKDAYS.includes(d.toLowerCase()));

  const ref  = db().collection('posShiftTemplates').doc();
  const data = {
    id:             ref.id,
    sellerId:       _san(sellerId, 100),
    name:           _san(name, 100),
    description:    _san(description || '', 300),
    startTime,
    endTime,
    requiredStaff:  Math.max(1, Math.min(parseInt(requiredStaff) || 1, 50)),
    rolesNeeded:    Array.isArray(rolesNeeded) ? rolesNeeded.slice(0, 10) : [],
    days:           validDays,
    isActive:       true,
    createdBy:      auth.uid,
    createdAt:      TS(),
    updatedAt:      TS(),
  };
  await ref.set(data);
  return { id: ref.id, created: true };
});

/* ================================================================
   publishWeeklyRoster
   Create the week's shift slots from templates (or manually).
   Input: { sellerId, branchId, weekStartDate, slots: [
     { templateId?, date, startTime, endTime, requiredStaff, role, notes }
   ]}
================================================================ */
exports.publishWeeklyRoster = onCall(_CF, async (request) => {
  const auth = _requireAuth(request);

  const { sellerId, branchId, weekStartDate, slots } = request.data;
  /* Tenancy AND capability, before any write. */
  await _requireSellerRole(auth, sellerId, 'manager');
  if (!weekStartDate)  throw new HttpsError('invalid-argument', 'weekStartDate required');
  if (!Array.isArray(slots) || slots.length === 0)
    throw new HttpsError('invalid-argument', 'slots[] required');

  _isoDate(weekStartDate);

  /* Validate and normalise each slot */
  const validatedSlots = slots.map((s, i) => {
    if (!s.date)      throw new HttpsError('invalid-argument', `slots[${i}].date required`);
    if (!s.startTime) throw new HttpsError('invalid-argument', `slots[${i}].startTime required`);
    if (!s.endTime)   throw new HttpsError('invalid-argument', `slots[${i}].endTime required`);
    _isoDate(s.date);
    _isoTime(s.startTime);
    _isoTime(s.endTime);
    return {
      templateId:    s.templateId || null,
      date:          s.date,
      startTime:     s.startTime,
      endTime:       s.endTime,
      requiredStaff: Math.max(1, parseInt(s.requiredStaff) || 1),
      role:          _san(s.role || 'cashier', 50),
      notes:         _san(s.notes || '', 200),
      assignedStaff: [],
      status:        'open',
    };
  });

  /* Idempotent: update if roster already exists for this week/branch */
  const rosterId = `${sellerId}_${branchId || 'main'}_${weekStartDate}`;
  const rosterRef = db().collection('posRosters').doc(rosterId);

  await rosterRef.set({
    id:            rosterId,
    sellerId:      _san(sellerId, 100),
    branchId:      _san(branchId || 'main', 100),
    weekStartDate,
    slots:         validatedSlots,
    status:        'published',
    publishedBy:   auth.uid,
    publishedAt:   TS(),
    updatedAt:     TS(),
  }, { merge: false });

  /* Notify all staff in this branch of new roster */
  await _notifyRosterPublished(sellerId, branchId, weekStartDate, auth.uid);

  return { rosterId, slotsCreated: validatedSlots.length };
});

/* ================================================================
   assignShift
   Assign a staff member to a specific slot in the roster.
   Input: { rosterId, slotIndex, staffUid, note? }
================================================================ */
exports.assignShift = onCall(_CF, async (request) => {
  const auth = _requireAuth(request);

  const { rosterId, slotIndex, staffUid, note } = request.data;
  if (slotIndex == null)   throw new HttpsError('invalid-argument', 'slotIndex required');
  if (!staffUid)           throw new HttpsError('invalid-argument', 'staffUid required');

  /* AUTHORIZED LOOKUP. The rosterId is caller-supplied and proves nothing; the
     stored document names the tenant, and that is what is scored. Nothing is
     returned or mutated before the check. */
  const { snap: rosterSnap, roster } = await _requireRosterRole(auth, rosterId, 'supervisor');

  /* AUTHORISED CALLER IS NOT THE WHOLE INVARIANT. Being allowed to write this
     tenant's roster does not make every uid a valid thing to write into it, and
     staffUid was taken on trust — so a manager (or the owner) could roster
     somebody who works nowhere, or somebody who works for a different merchant.
     Checked AFTER the caller's authority, so this never becomes an oracle for
     "does this uid work here" that an unauthorised caller could query. */
  if (!(await _isTenantMember(roster.sellerId, staffUid)))
    throw new HttpsError('failed-precondition', 'That person is not on this shop\'s team.');

  if (slotIndex < 0 || slotIndex >= roster.slots.length)
    throw new HttpsError('out-of-range', `slotIndex ${slotIndex} out of range`);

  const slot = roster.slots[slotIndex];

  /* Check max staff cap */
  if ((slot.assignedStaff || []).length >= slot.requiredStaff)
    throw new HttpsError('resource-exhausted', 'Slot is fully staffed');

  /* Check if staff already assigned */
  if ((slot.assignedStaff || []).some(a => a.uid === staffUid))
    throw new HttpsError('already-exists', 'Staff member already assigned to this slot');

  /* Check availability conflicts */
  const conflict = await _checkAvailabilityConflict(
    staffUid, roster.sellerId, slot.date, slot.startTime, slot.endTime
  );
  if (conflict)
    throw new HttpsError('failed-precondition', `Staff has marked unavailability on ${slot.date} ${slot.startTime}–${slot.endTime}`);

  /* Update slot */
  const updatedSlots = [...roster.slots];
  updatedSlots[slotIndex] = {
    ...slot,
    assignedStaff: [
      ...(slot.assignedStaff || []),
      { uid: staffUid, assignedBy: auth.uid, assignedAt: new Date().toISOString(), note: _san(note || '', 200), acknowledged: false },
    ],
    status: (slot.assignedStaff || []).length + 1 >= slot.requiredStaff ? 'filled' : 'partial',
  };

  await db().collection('posRosters').doc(rosterId).update({
    slots:     updatedSlots,
    updatedAt: TS(),
  });

  /* Notify assigned staff */
  await _notifyShiftAssigned(staffUid, roster.sellerId, slot);

  return { assigned: true, slot: updatedSlots[slotIndex] };
});

/* ================================================================
   swapShiftRequest
   Employee requests to swap their shift with another employee.
   Input: { rosterId, mySlotIndex, targetUid, reason? }
================================================================ */
exports.swapShiftRequest = onCall(_CF, async (request) => {
  const auth = _requireAuth(request);

  const { rosterId, mySlotIndex, targetUid, reason } = request.data;
  if (!rosterId)         throw new HttpsError('invalid-argument', 'rosterId required');
  if (mySlotIndex == null) throw new HttpsError('invalid-argument', 'mySlotIndex required');
  if (!targetUid)        throw new HttpsError('invalid-argument', 'targetUid required');

  /* AUTHORIZED LOOKUP. The rosterId is caller-supplied and proves nothing; the
     stored document names the tenant, and that is what is authorized. Nothing is
     returned or mutated before the check. */
  const { snap: rosterSnap, roster } = await _assertRoster(auth, rosterId, { orAssigned: true });
  const slot   = roster.slots[mySlotIndex];
  if (!slot) throw new HttpsError('not-found', 'Slot not found');

  const isAssigned = (slot.assignedStaff || []).some(a => a.uid === auth.uid);
  if (!isAssigned)
    throw new HttpsError('permission-denied', 'You are not assigned to this shift');

  const swapRef = db().collection('posShiftSwaps').doc();
  await swapRef.set({
    id:          swapRef.id,
    rosterId,
    slotIndex:   mySlotIndex,
    requestorUid: auth.uid,
    targetUid,
    date:        slot.date,
    startTime:   slot.startTime,
    endTime:     slot.endTime,
    reason:      _san(reason || '', 300),
    status:      'pending_target',  // target must accept, then manager approves
    targetAccepted: null,
    managerApproved: null,
    createdAt:   TS(),
    updatedAt:   TS(),
  });

  return { swapId: swapRef.id, status: 'pending_target' };
});

/* ================================================================
   approveShiftSwap
   Manager (or target) acts on a swap request.
   Input: { swapId, action: 'accept_target'|'reject_target'|'approve'|'reject', note? }
================================================================ */
exports.approveShiftSwap = onCall(_CF, async (request) => {
  const auth = _requireAuth(request);
  const { swapId, action, note } = request.data;
  if (!swapId)  throw new HttpsError('invalid-argument', 'swapId required');
  if (!action)  throw new HttpsError('invalid-argument', 'action required');

  const validActions = ['accept_target','reject_target','approve','reject'];
  if (!validActions.includes(action))
    throw new HttpsError('invalid-argument', `action must be one of: ${validActions.join(', ')}`);

  const swapSnap = await db().collection('posShiftSwaps').doc(swapId).get();
  if (!swapSnap.exists) throw new HttpsError('not-found', 'Swap request not found');
  const swap = swapSnap.data();

  const update = { updatedAt: TS() };

  if (action === 'accept_target' || action === 'reject_target') {
    if (auth.uid !== swap.targetUid)
      throw new HttpsError('permission-denied', 'Only the target staff can accept/reject this swap');
    update.targetAccepted = action === 'accept_target';
    update.status = action === 'accept_target' ? 'pending_manager' : 'rejected_by_target';

  } else if (action === 'approve' || action === 'reject') {
    /* The swap document stores a rosterId, not a tenant, so the tenant is
       resolved through it. A global manager claim previously let anyone approve
       anyone's swap; approval is a management act over THIS merchant's roster. */
    await _requireRosterRole(auth, swap.rosterId, 'manager');
    if (swap.status !== 'pending_manager')
      throw new HttpsError('failed-precondition', 'Swap is not awaiting manager approval');
    update.managerApproved = action === 'approve';
    update.managedBy = auth.uid;
    update.managerNote = _san(note || '', 200);
    update.status = action === 'approve' ? 'approved' : 'rejected_by_manager';

    if (action === 'approve') {
      /* Execute the swap in the roster */
      await _executeShiftSwap(swap);
    }
  }

  await db().collection('posShiftSwaps').doc(swapId).update(update);
  return { swapId, status: update.status };
});

/* ================================================================
   setStaffAvailability
   Employee marks periods when they are NOT available to work.
   Input: { sellerId, staffUid?, entries: [{ date, startTime, endTime, reason }] }
================================================================ */
exports.setStaffAvailability = onCall(_CF, async (request) => {
  const auth = _requireAuth(request);

  /* Employees set their own; managers can set for any staff */
  const isManager = ['manager','owner','admin'].includes(auth.token?.posRole || auth.token?.role || '');
  const staffUid  = isManager && request.data.staffUid ? request.data.staffUid : auth.uid;

  const { sellerId, entries } = request.data;
  if (!sellerId) throw new HttpsError('invalid-argument', 'sellerId required');
  /* isManager above is a GLOBAL claim. Setting your own availability needs no
     tenant authority; setting anyone else's does, and the claim alone is not it. */
  if (String(staffUid) !== String(auth.uid)) await _assertSeller(auth, sellerId);
  if (!Array.isArray(entries) || entries.length === 0)
    throw new HttpsError('invalid-argument', 'entries[] required');

  const validatedEntries = entries.slice(0, 50).map((e, i) => {
    if (!e.date) throw new HttpsError('invalid-argument', `entries[${i}].date required`);
    _isoDate(e.date);
    return {
      date:      e.date,
      startTime: e.startTime ? _isoTime(e.startTime) && e.startTime : '00:00',
      endTime:   e.endTime   ? _isoTime(e.endTime)   && e.endTime   : '23:59',
      reason:    _san(e.reason || '', 200),
      allDay:    !e.startTime && !e.endTime,
    };
  });

  /* Store per-staff availability doc (merge to allow incremental additions) */
  const availRef = db().collection('posStaffAvailability')
    .doc(`${sellerId}_${staffUid}`);
  await availRef.set({
    sellerId:  _san(sellerId, 100),
    staffUid,
    entries:   validatedEntries,
    updatedBy: auth.uid,
    updatedAt: TS(),
  }, { merge: true });

  return { saved: validatedEntries.length };
});

/* ================================================================
   getRoster
   Fetch the published roster for a branch and date range.
   Input: { sellerId, branchId?, startDate, endDate }
================================================================ */
exports.getRoster = onCall(_CF, async (request) => {
  const auth = _requireAuth(request);
  const { sellerId, branchId, startDate, endDate } = request.data;
  /* BEFORE the query: a roster names who works when, and reading another
     merchant's is a staffing leak even though nothing is mutated.

     Scored at SUPERVISOR, matching getRosterGaps, so a corroborated manager may
     read the week they are allowed to publish. It was owner-only, which made the
     manager authority granted in ab2d50a unusable in practice: publishing merges
     into the existing week, so a manager who cannot READ the roster cannot safely
     WRITE it either — their first save would republish over everything already
     there. Widened deliberately, and only to the level that already governs the
     roster's other reads. */
  await _requireSellerRole(auth, sellerId, 'supervisor');
  if (!startDate)  throw new HttpsError('invalid-argument', 'startDate required');
  if (!endDate)    throw new HttpsError('invalid-argument', 'endDate required');

  _isoDate(startDate);
  _isoDate(endDate);

  let q = db().collection('posRosters')
    .where('sellerId', '==', sellerId)
    .where('weekStartDate', '>=', startDate)
    .where('weekStartDate', '<=', endDate);

  if (branchId) q = q.where('branchId', '==', branchId);

  const snap = await q.orderBy('weekStartDate', 'asc').limit(20).get();
  return { rosters: snap.docs.map(d => d.data()) };
});

/* ================================================================
   getRosterGaps
   Find shifts that are understaffed (assignedStaff.length < requiredStaff).
   Input: { sellerId, branchId?, startDate, endDate? }
================================================================ */
exports.getRosterGaps = onCall(_CF, async (request) => {
  const auth = _requireAuth(request);

  const { sellerId, branchId } = request.data;
  const startDate = request.data.startDate || _today();
  const endDate   = request.data.endDate   || _today();
  /* Tenancy AND capability, before the query. */
  await _requireSellerRole(auth, sellerId, 'supervisor');

  _isoDate(startDate);
  _isoDate(endDate);

  let q = db().collection('posRosters')
    .where('sellerId', '==', sellerId)
    .where('weekStartDate', '>=', startDate)
    .where('weekStartDate', '<=', endDate);
  if (branchId) q = q.where('branchId', '==', branchId);

  const snap = await q.limit(10).get();
  const gaps = [];

  snap.docs.forEach(doc => {
    const roster = doc.data();
    (roster.slots || []).forEach((slot, i) => {
      const assigned = (slot.assignedStaff || []).length;
      if (assigned < slot.requiredStaff) {
        gaps.push({
          rosterId:  doc.id,
          branchId:  roster.branchId,
          slotIndex: i,
          date:      slot.date,
          startTime: slot.startTime,
          endTime:   slot.endTime,
          role:      slot.role,
          required:  slot.requiredStaff,
          assigned,
          shortage:  slot.requiredStaff - assigned,
        });
      }
    });
  });

  gaps.sort((a, b) => a.date.localeCompare(b.date));
  return { gaps, totalGaps: gaps.length };
});

/* ================================================================
   getStaffRoster
   An individual employee's upcoming shifts.
   Input: { sellerId, staffUid?, startDate?, days? }
================================================================ */
exports.getStaffRoster = onCall(_CF, async (request) => {
  const auth = _requireAuth(request);
  const staffUid  = request.data.staffUid || auth.uid;
  const sellerId  = request.data.sellerId;
  const startDate = request.data.startDate || _today();
  const days      = Math.min(request.data.days || 14, 60);

  if (!sellerId) throw new HttpsError('invalid-argument', 'sellerId required');
  /* `staffUid || auth.uid` let any caller name anyone. Reading your OWN
     schedule stays open — the slot filter below only ever matches rows that
     name you, so it cannot reveal a colleague. Asking about SOMEONE ELSE is a
     management act and requires authority over that merchant. */
  if (String(staffUid) !== String(auth.uid)) await _assertSeller(auth, sellerId);
  _isoDate(startDate);

  /* Compute endDate */
  const end = new Date(startDate);
  end.setDate(end.getDate() + days);
  const endDate = end.toISOString().slice(0, 10);

  const snap = await db().collection('posRosters')
    .where('sellerId', '==', sellerId)
    .where('weekStartDate', '>=', startDate)
    .where('weekStartDate', '<=', endDate)
    .orderBy('weekStartDate', 'asc')
    .limit(20).get();

  const myShifts = [];
  snap.docs.forEach(doc => {
    const roster = doc.data();
    (roster.slots || []).forEach((slot, i) => {
      const me = (slot.assignedStaff || []).find(a => a.uid === staffUid);
      if (me) {
        myShifts.push({
          rosterId:      doc.id,
          branchId:      roster.branchId,
          slotIndex:     i,
          date:          slot.date,
          startTime:     slot.startTime,
          endTime:       slot.endTime,
          role:          slot.role,
          notes:         slot.notes,
          acknowledged:  me.acknowledged,
          assignedAt:    me.assignedAt,
        });
      }
    });
  });

  myShifts.sort((a, b) => `${a.date}${a.startTime}`.localeCompare(`${b.date}${b.startTime}`));
  return { staffUid, shifts: myShifts, total: myShifts.length };
});

/* ================================================================
   acknowledgeShift
   Employee confirms they've seen their upcoming shift.
   Input: { rosterId, slotIndex }
================================================================ */
exports.acknowledgeShift = onCall(_CF, async (request) => {
  const auth = _requireAuth(request);
  const { rosterId, slotIndex } = request.data;
  if (!rosterId)       throw new HttpsError('invalid-argument', 'rosterId required');
  if (slotIndex == null) throw new HttpsError('invalid-argument', 'slotIndex required');

  /* AUTHORIZED LOOKUP. The rosterId is caller-supplied and proves nothing; the
     stored document names the tenant, and that is what is authorized. Nothing is
     returned or mutated before the check. */
  const { snap: rosterSnap, roster } = await _assertRoster(auth, rosterId, { orAssigned: true });
  const slot    = roster.slots[slotIndex];
  if (!slot) throw new HttpsError('not-found', 'Slot not found');

  const idx = (slot.assignedStaff || []).findIndex(a => a.uid === auth.uid);
  if (idx === -1)
    throw new HttpsError('permission-denied', 'You are not assigned to this shift');

  const updatedSlots = [...roster.slots];
  const updatedStaff = [...updatedSlots[slotIndex].assignedStaff];
  updatedStaff[idx]  = { ...updatedStaff[idx], acknowledged: true, acknowledgedAt: new Date().toISOString() };
  updatedSlots[slotIndex] = { ...updatedSlots[slotIndex], assignedStaff: updatedStaff };

  await db().collection('posRosters').doc(rosterId).update({
    slots:     updatedSlots,
    updatedAt: TS(),
  });

  return { acknowledged: true };
});

/* ================================================================
   schedulerWeeklyDigest
   Every Monday at 07:00 EAT:
   - Summarise last week's roster coverage
   - Alert managers to current-week staffing gaps
   - Flag upcoming shifts with 0 staff assigned
================================================================ */
exports.schedulerWeeklyDigest = onSchedule(_SCHED, async () => {
  const today      = _today();
  const weekAgo    = _dateAdd(today, -7);
  const nextFriday = _dateAdd(today, 5);

  /* Find all sellers with rosters */
  const sellerSnap = await db().collection('users')
    .where('role', 'in', ['seller', 'owner'])
    .where('posEnabled', '==', true)
    .limit(500).get();

  const promises = sellerSnap.docs.map(async (sellerDoc) => {
    const sellerId = sellerDoc.id;
    try {
      /* Count gaps in coming week */
      const rosterSnap = await db().collection('posRosters')
        .where('sellerId',      '==', sellerId)
        .where('weekStartDate', '>=', today)
        .where('weekStartDate', '<=', nextFriday)
        .limit(5).get();

      let totalGaps = 0, totalShortage = 0;
      rosterSnap.docs.forEach(doc => {
        (doc.data().slots || []).forEach(slot => {
          const shortage = slot.requiredStaff - (slot.assignedStaff || []).length;
          if (shortage > 0) { totalGaps++; totalShortage += shortage; }
        });
      });

      if (totalGaps > 0) {
        await db().collection('posSchedulerAlerts').add({
          sellerId,
          type:          'roster_gap',
          weekStartDate: today,
          totalGaps,
          totalShortage,
          message:       `${totalGaps} shift(s) understaffed — ${totalShortage} staff needed before ${nextFriday}`,
          createdAt:     TS(),
          resolved:      false,
        });
      }
    } catch (err) {
      console.error(JSON.stringify({ severity: 'ERROR', message: err.message, sellerId }));
    }
  });

  await Promise.allSettled(promises);
  console.log(JSON.stringify({ severity: 'INFO', message: '[scheduler] Weekly roster digest complete', date: today }));
});

/* ── Internal helpers ──────────────────────────────────────── */
async function _checkAvailabilityConflict(staffUid, sellerId, date, startTime, endTime) {
  const availSnap = await db().collection('posStaffAvailability')
    .doc(`${sellerId}_${staffUid}`).get();
  if (!availSnap.exists) return false;

  return (availSnap.data().entries || []).some(e => {
    if (e.date !== date) return false;
    if (e.allDay) return true;
    /* Overlap check: shift start < entry end AND shift end > entry start */
    return startTime < e.endTime && endTime > e.startTime;
  });
}

async function _executeShiftSwap(swap) {
  const rosterSnap = await db().collection('posRosters').doc(swap.rosterId).get();
  if (!rosterSnap.exists) return;
  const roster  = rosterSnap.data();
  const slots   = [...roster.slots];
  const slot    = { ...slots[swap.slotIndex] };
  const staff   = [...(slot.assignedStaff || [])];

  /* Replace requestor with target */
  const idx = staff.findIndex(a => a.uid === swap.requestorUid);
  if (idx !== -1) {
    staff[idx] = { uid: swap.targetUid, assignedBy: swap.managedBy, assignedAt: new Date().toISOString(), swappedFrom: swap.requestorUid, acknowledged: false };
  }
  slots[swap.slotIndex] = { ...slot, assignedStaff: staff };
  await db().collection('posRosters').doc(swap.rosterId).update({ slots, updatedAt: TS() });
}

async function _notifyRosterPublished(sellerId, branchId, weekStartDate, publishedBy) {
  try {
    await db().collection('posSchedulerNotifications').add({
      type: 'roster_published', sellerId, branchId: branchId || 'main',
      weekStartDate, publishedBy, createdAt: TS(),
    });
  } catch {}
}

async function _notifyShiftAssigned(staffUid, sellerId, slot) {
  try {
    await db().collection('posSchedulerNotifications').add({
      type: 'shift_assigned', staffUid, sellerId,
      date: slot.date, startTime: slot.startTime, endTime: slot.endTime,
      role: slot.role, createdAt: TS(),
    });
  } catch {}
}

function _dateAdd(dateStr, days) {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

/* ── Test seam ──────────────────────────────────────────────────────────────
   Exported so the time semantics are PROVED rather than described. These are
   pure functions; nothing here is a Cloud Function and index.js must not
   re-export them. */
/** The local calendar date (YYYY-MM-DD) at an instant, in a given zone. Exposed
    so the Merchant V2 shift gate can bound its roster lookup without building a
    second timezone helper — the offset logic lives here and only here. */
function localDateKey (ms, tz) {
  const p = _partsAt(typeof ms === 'number' ? ms : Date.now(), tz);
  const pad = (n) => String(n).padStart(2, '0');
  return p.y + '-' + pad(p.m) + '-' + pad(p.d);
}

exports._internal = { isValidTimezone, isShiftActive, instantFor, localDateKey };
