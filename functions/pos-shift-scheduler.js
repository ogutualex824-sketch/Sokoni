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

if (!admin.apps.length) admin.initializeApp();
const db     = () => admin.firestore();
const TS     = () => admin.firestore.FieldValue.serverTimestamp();
const _CF    = { region: 'us-central1', enforceAppCheck: true };
const _SCHED = { region: 'us-central1', schedule: '0 7 * * 1', timeZone: 'Africa/Nairobi' }; // Mon 07:00

/* ── Auth helpers ──────────────────────────────────────────── */
function _requireAuth(req) {
  if (!req.auth) throw new HttpsError('unauthenticated', 'Login required');
  return req.auth;
}
function _requireRole(auth, minRole) {
  const levels = { cashier: 0, supervisor: 1, manager: 2, owner: 3, admin: 4 };
  const posRole = auth.token?.posRole || auth.token?.role || 'cashier';
  const userLvl = levels[posRole] ?? 0;
  const reqLvl  = levels[minRole]  ?? 0;
  if (userLvl < reqLvl)
    throw new HttpsError('permission-denied', `Requires ${minRole} role or above`);
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

/* ================================================================
   createShiftTemplate
   Define a reusable shift pattern: name, start/end, required staff,
   roles needed, applicable days.
   Input: { sellerId, name, startTime, endTime, requiredStaff,
            rolesNeeded?, days?, description? }
================================================================ */
exports.createShiftTemplate = onCall(_CF, async (request) => {
  const auth = _requireAuth(request);
  _requireRole(auth, 'manager');

  const { sellerId, name, startTime, endTime, requiredStaff, rolesNeeded, days, description } = request.data;
  if (!sellerId)      throw new HttpsError('invalid-argument', 'sellerId required');
  if (!name)          throw new HttpsError('invalid-argument', 'name required');
  if (!startTime)     throw new HttpsError('invalid-argument', 'startTime required');
  if (!endTime)       throw new HttpsError('invalid-argument', 'endTime required');
  if (!requiredStaff) throw new HttpsError('invalid-argument', 'requiredStaff required');

  _isoTime(startTime);
  _isoTime(endTime);
  if (startTime >= endTime && !(startTime > '22:00' && endTime < '06:00'))
    throw new HttpsError('invalid-argument', 'startTime must be before endTime (except overnight shifts)');

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
  _requireRole(auth, 'manager');

  const { sellerId, branchId, weekStartDate, slots } = request.data;
  if (!sellerId)       throw new HttpsError('invalid-argument', 'sellerId required');
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
  _requireRole(auth, 'supervisor');

  const { rosterId, slotIndex, staffUid, note } = request.data;
  if (!rosterId)           throw new HttpsError('invalid-argument', 'rosterId required');
  if (slotIndex == null)   throw new HttpsError('invalid-argument', 'slotIndex required');
  if (!staffUid)           throw new HttpsError('invalid-argument', 'staffUid required');

  const rosterSnap = await db().collection('posRosters').doc(rosterId).get();
  if (!rosterSnap.exists) throw new HttpsError('not-found', 'Roster not found');
  const roster = rosterSnap.data();

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

  const rosterSnap = await db().collection('posRosters').doc(rosterId).get();
  if (!rosterSnap.exists) throw new HttpsError('not-found', 'Roster not found');
  const roster = rosterSnap.data();
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
    _requireRole(auth, 'manager');
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
  _requireAuth(request);
  const { sellerId, branchId, startDate, endDate } = request.data;
  if (!sellerId)   throw new HttpsError('invalid-argument', 'sellerId required');
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
  _requireRole(auth, 'supervisor');

  const { sellerId, branchId } = request.data;
  const startDate = request.data.startDate || _today();
  const endDate   = request.data.endDate   || _today();
  if (!sellerId) throw new HttpsError('invalid-argument', 'sellerId required');

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

  const rosterSnap = await db().collection('posRosters').doc(rosterId).get();
  if (!rosterSnap.exists) throw new HttpsError('not-found', 'Roster not found');
  const roster  = rosterSnap.data();
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
