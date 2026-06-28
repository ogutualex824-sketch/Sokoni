/* ================================================================
   SOKONI PLATFORM — SECURITY INCIDENT RESPONSE  v1.0.0  |  2026-06-28
   functions/security-incident-response.js

   Administrative incident response workflows covering user suspension,
   store locking, session revocation, device blocking, payment method
   disabling, and full incident lifecycle management (create → update
   → timeline → resolve).

   Collections used:
     securityIncidents/{auto-id}                       — incident records
     securityAuditLog/{auto-id}                        — immutable audit trail
     securityDevices/{userId}/devices/{deviceId}       — device trust registry
     sellers/{sellerId}                                — seller profile
     users/{userId}                                    — user profile (optional)

   Auth:
     All CFs require authentication.
     All CFs except revokeUserSessions (self-revoke) require admin
     (role >= 4, or token.admin === true, or token.superAdmin === true).

   Incident status machine:
     open → investigating → contained → resolved
     (dismissed is allowed from any state by admin)

   Exports (11 CFs):
     suspendUser           — disable user + revoke tokens
     unsuspendUser         — restore user access
     lockStore             — lock a seller store (trading/payments/full)
     unlockStore           — restore store access
     revokeUserSessions    — revoke Firebase refresh tokens
     blockDevice           — mark a device as blocked in trust registry
     disablePaymentMethod  — disable mpesa/card/wallet/all for a seller
     createIncident        — open a new security incident
     updateIncident        — advance status and append timeline event
     getIncidents          — list/filter incidents (admin only)
     getIncidentTimeline   — full incident + related audit log entries
================================================================ */
'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const admin                  = require('firebase-admin');

const FieldValue = admin.firestore.FieldValue;
const db         = () => admin.firestore();

/* ── Shared CF options ──────────────────────────────────────────── */
const CF_OPTIONS = { region: 'us-central1', enforceAppCheck: true };

/* ── Role constants ─────────────────────────────────────────────── */
const ROLE = {
  cashier: 0, supervisor: 1, manager: 2,
  owner: 3, admin: 4, super_admin: 5,
};

/* ── Valid enumerations ─────────────────────────────────────────── */
const VALID_LOCK_TYPES     = new Set(['trading', 'payments', 'full']);
const VALID_PAY_METHODS    = new Set(['mpesa', 'card', 'wallet', 'all']);
const VALID_SEVERITIES     = new Set(['low', 'medium', 'high', 'critical']);
const VALID_INC_STATUSES   = new Set(['open', 'investigating', 'contained', 'resolved']);

/* Allowed forward status transitions */
const STATUS_TRANSITIONS = {
  open:          new Set(['investigating', 'contained', 'resolved']),
  investigating: new Set(['contained', 'resolved']),
  contained:     new Set(['resolved']),
  resolved:      new Set(), /* Terminal */
};

/* ── Auth helpers ───────────────────────────────────────────────── */
function _requireAuth(auth) {
  if (!auth?.uid) throw new HttpsError('unauthenticated', 'Sign in required.');
}

function _isElevated(auth) {
  return ['admin', 'super_admin', 4, 5].includes(auth?.token?.role) ||
    auth?.token?.admin     === true ||
    auth?.token?.superAdmin === true;
}

function _requireAdmin(auth) {
  _requireAuth(auth);
  if (!_isElevated(auth)) {
    throw new HttpsError('permission-denied', 'Admin access required.');
  }
}

/* ── Input sanitisation ─────────────────────────────────────────── */
function _san(val, maxLen = 200) {
  if (typeof val !== 'string') return '';
  return val.replace(/<[^>]*>/g, '').trim().slice(0, maxLen);
}

/* ── Structured logger ──────────────────────────────────────────── */
function _log(severity, message, meta = {}) {
  const entry = JSON.stringify({ severity, message, service: 'security-incident-response', ...meta });
  if (severity === 'ERROR')        console.error(entry);
  else if (severity === 'WARNING') console.warn(entry);
  else                             console.log(entry);
}

/* ── Audit log writer ───────────────────────────────────────────── */
async function _audit(firestore, payload) {
  await firestore.collection('securityAuditLog').add({
    ...payload,
    createdAt: FieldValue.serverTimestamp(),
  });
}

/* ── Timeline event factory ─────────────────────────────────────── */
function _timelineEvent(event, actorId, notes = '') {
  return {
    event,
    at:    new Date().toISOString(),
    by:    actorId,
    notes: _san(notes, 500),
  };
}

/* ================================================================
   1. suspendUser
   Admin-only.
   Sets suspended custom claim, revokes all refresh tokens,
   opens a securityIncident, and writes to audit log.
================================================================ */
exports.suspendUser = onCall(CF_OPTIONS, async (req) => {
  _requireAdmin(req.auth);

  const { targetUserId, reason, duration } = req.data;

  if (!targetUserId) throw new HttpsError('invalid-argument', 'targetUserId is required.');
  if (!reason)       throw new HttpsError('invalid-argument', 'reason is required.');

  const firestore   = db();
  const actorId     = req.auth.uid;
  const now         = Date.now();
  const sanitizedReason = _san(reason, 500);

  /* ── Read existing claims to preserve them ────────────────────── */
  let existingClaims = {};
  try {
    const userRecord  = await admin.auth().getUser(targetUserId);
    existingClaims    = userRecord.customClaims || {};
  } catch (err) {
    if (err.code === 'auth/user-not-found') {
      throw new HttpsError('not-found', `User ${targetUserId} not found.`);
    }
    throw err;
  }

  /* ── Set suspended claim ──────────────────────────────────────── */
  await admin.auth().setCustomUserClaims(targetUserId, {
    ...existingClaims,
    suspended:     true,
    suspendedAt:   now,
    suspendedBy:   actorId,
    suspendReason: sanitizedReason,
  });

  /* ── Revoke all refresh tokens (forces re-authentication) ─────── */
  await admin.auth().revokeRefreshTokens(targetUserId);

  /* ── Open incident ────────────────────────────────────────────── */
  const incidentRef = firestore.collection('securityIncidents').doc();
  const incidentId  = incidentRef.id;
  const createdAt   = FieldValue.serverTimestamp();

  await incidentRef.set({
    incidentId,
    type:          'user_suspended',
    severity:      'high',
    title:         `User suspended: ${targetUserId}`,
    description:   sanitizedReason,
    status:        'active',
    targetUserId,
    actorId,
    reason:        sanitizedReason,
    duration:      duration || null,
    createdAt,
    affectedUsers: [targetUserId],
    timeline:      [_timelineEvent('suspended', actorId, sanitizedReason)],
    resolvedAt:    null,
    resolvedBy:    null,
  });

  /* ── Audit log ────────────────────────────────────────────────── */
  await _audit(firestore, {
    action:       'user_suspended',
    targetUserId,
    actorId,
    incidentId,
    reason:       sanitizedReason,
    duration:     duration || null,
  });

  _log('INFO', 'User suspended', { targetUserId, actorId, incidentId });

  return { incidentId, suspended: true };
});

/* ================================================================
   2. unsuspendUser
   Admin-only.
   Removes the suspended claim and updates the incident timeline.
================================================================ */
exports.unsuspendUser = onCall(CF_OPTIONS, async (req) => {
  _requireAdmin(req.auth);

  const { targetUserId, incidentId, notes = '' } = req.data;

  if (!targetUserId) throw new HttpsError('invalid-argument', 'targetUserId is required.');

  const firestore   = db();
  const actorId     = req.auth.uid;
  const now         = Date.now();

  /* ── Read existing claims ─────────────────────────────────────── */
  let existingClaims = {};
  try {
    const userRecord  = await admin.auth().getUser(targetUserId);
    existingClaims    = userRecord.customClaims || {};
  } catch (err) {
    if (err.code === 'auth/user-not-found') {
      throw new HttpsError('not-found', `User ${targetUserId} not found.`);
    }
    throw err;
  }

  if (!existingClaims.suspended) {
    throw new HttpsError('failed-precondition', 'User is not currently suspended.');
  }

  /* ── Remove suspended claim ───────────────────────────────────── */
  const { suspended, suspendedAt, suspendedBy, suspendReason, ...cleanClaims } = existingClaims;
  await admin.auth().setCustomUserClaims(targetUserId, {
    ...cleanClaims,
    suspended:     false,
    unsuspendedAt: now,
    unsuspendedBy: actorId,
  });

  /* ── Update incident timeline ─────────────────────────────────── */
  if (incidentId) {
    const incidentRef = firestore.doc(`securityIncidents/${incidentId}`);
    const incidentSnap = await incidentRef.get();
    if (incidentSnap.exists) {
      await incidentRef.update({
        status:     'resolved',
        resolvedAt: FieldValue.serverTimestamp(),
        resolvedBy: actorId,
        timeline:   FieldValue.arrayUnion(
          _timelineEvent('unsuspended', actorId, _san(notes, 500)),
        ),
      });
    }
  }

  /* ── Audit log ────────────────────────────────────────────────── */
  await _audit(firestore, {
    action:       'user_unsuspended',
    targetUserId,
    actorId,
    incidentId:   incidentId || null,
    notes:        _san(notes, 500),
  });

  _log('INFO', 'User unsuspended', { targetUserId, actorId, incidentId });

  return { unsuspended: true };
});

/* ================================================================
   3. lockStore
   Admin-only.
   Locks a seller store for trading, payments, or both.
================================================================ */
exports.lockStore = onCall(CF_OPTIONS, async (req) => {
  _requireAdmin(req.auth);

  const { sellerId, reason, lockType } = req.data;

  if (!sellerId)  throw new HttpsError('invalid-argument', 'sellerId is required.');
  if (!reason)    throw new HttpsError('invalid-argument', 'reason is required.');
  if (!VALID_LOCK_TYPES.has(lockType)) {
    throw new HttpsError('invalid-argument', `lockType must be one of: ${[...VALID_LOCK_TYPES].join(', ')}`);
  }

  const firestore = db();
  const actorId   = req.auth.uid;
  const sanitizedReason = _san(reason, 500);

  /* ── Verify seller exists ─────────────────────────────────────── */
  const sellerRef  = firestore.doc(`sellers/${sellerId}`);
  const sellerSnap = await sellerRef.get();
  if (!sellerSnap.exists) throw new HttpsError('not-found', `Seller ${sellerId} not found.`);

  /* ── Apply lock ───────────────────────────────────────────────── */
  await sellerRef.update({
    locked:     true,
    lockType,
    lockReason: sanitizedReason,
    lockedAt:   FieldValue.serverTimestamp(),
    lockedBy:   actorId,
  });

  /* ── Open incident ────────────────────────────────────────────── */
  const incidentRef = firestore.collection('securityIncidents').doc();
  const incidentId  = incidentRef.id;

  await incidentRef.set({
    incidentId,
    type:            'store_locked',
    severity:        lockType === 'full' ? 'high' : 'medium',
    title:           `Store locked (${lockType}): ${sellerId}`,
    description:     sanitizedReason,
    status:          'active',
    sellerId,
    actorId,
    lockType,
    reason:          sanitizedReason,
    createdAt:       FieldValue.serverTimestamp(),
    affectedSellers: [sellerId],
    timeline:        [_timelineEvent(`store_locked_${lockType}`, actorId, sanitizedReason)],
    resolvedAt:      null,
    resolvedBy:      null,
  });

  /* ── Audit log ────────────────────────────────────────────────── */
  await _audit(firestore, {
    action:     'store_locked',
    sellerId,
    lockType,
    actorId,
    incidentId,
    reason:     sanitizedReason,
  });

  _log('INFO', 'Store locked', { sellerId, lockType, actorId, incidentId });

  return { sellerId, locked: true, lockType };
});

/* ================================================================
   4. unlockStore
   Admin-only.
   Removes the store lock and updates the incident timeline.
================================================================ */
exports.unlockStore = onCall(CF_OPTIONS, async (req) => {
  _requireAdmin(req.auth);

  const { sellerId, incidentId, notes = '' } = req.data;

  if (!sellerId) throw new HttpsError('invalid-argument', 'sellerId is required.');

  const firestore = db();
  const actorId   = req.auth.uid;

  /* ── Verify seller exists and is locked ──────────────────────── */
  const sellerRef  = firestore.doc(`sellers/${sellerId}`);
  const sellerSnap = await sellerRef.get();
  if (!sellerSnap.exists) throw new HttpsError('not-found', `Seller ${sellerId} not found.`);
  if (!sellerSnap.data().locked) {
    throw new HttpsError('failed-precondition', 'Store is not currently locked.');
  }

  /* ── Remove lock ──────────────────────────────────────────────── */
  await sellerRef.update({
    locked:       false,
    lockType:     null,
    lockReason:   null,
    unlockedAt:   FieldValue.serverTimestamp(),
    unlockedBy:   actorId,
  });

  /* ── Update incident timeline ─────────────────────────────────── */
  if (incidentId) {
    const incidentRef  = firestore.doc(`securityIncidents/${incidentId}`);
    const incidentSnap = await incidentRef.get();
    if (incidentSnap.exists) {
      await incidentRef.update({
        status:     'resolved',
        resolvedAt: FieldValue.serverTimestamp(),
        resolvedBy: actorId,
        timeline:   FieldValue.arrayUnion(
          _timelineEvent('store_unlocked', actorId, _san(notes, 500)),
        ),
      });
    }
  }

  /* ── Audit log ────────────────────────────────────────────────── */
  await _audit(firestore, {
    action:     'store_unlocked',
    sellerId,
    actorId,
    incidentId: incidentId || null,
    notes:      _san(notes, 500),
  });

  _log('INFO', 'Store unlocked', { sellerId, actorId, incidentId });

  return { sellerId, unlocked: true };
});

/* ================================================================
   5. revokeUserSessions
   Revokes all Firebase refresh tokens for a user.
   Admin can do this for any user.
   A user may revoke their own sessions (self-revoke).
================================================================ */
exports.revokeUserSessions = onCall(CF_OPTIONS, async (req) => {
  _requireAuth(req.auth);

  const { targetUserId, reason = '' } = req.data;

  if (!targetUserId) throw new HttpsError('invalid-argument', 'targetUserId is required.');

  /* Allow self-revoke; require admin for revoking another user's sessions */
  const isSelf = req.auth.uid === targetUserId;
  if (!isSelf && !_isElevated(req.auth)) {
    throw new HttpsError('permission-denied', 'Admin access required to revoke another user\'s sessions.');
  }

  const firestore   = db();
  const actorId     = req.auth.uid;
  const revokedAt   = new Date().toISOString();

  /* ── Revoke tokens ────────────────────────────────────────────── */
  try {
    await admin.auth().revokeRefreshTokens(targetUserId);
  } catch (err) {
    if (err.code === 'auth/user-not-found') {
      throw new HttpsError('not-found', `User ${targetUserId} not found.`);
    }
    throw err;
  }

  /* ── Audit log ────────────────────────────────────────────────── */
  await _audit(firestore, {
    action:       'sessions_revoked',
    targetUserId,
    actorId,
    isSelfRevoke: isSelf,
    reason:       _san(reason, 300),
    revokedAt,
  });

  _log('INFO', 'User sessions revoked', { targetUserId, actorId, isSelf });

  return { revoked: true, revokedAt };
});

/* ================================================================
   6. blockDevice
   Admin-only.
   Marks a device as blocked in the device trust registry.
   Blocked devices are rejected by the fraud scoring engine.
================================================================ */
exports.blockDevice = onCall(CF_OPTIONS, async (req) => {
  _requireAdmin(req.auth);

  const { targetUserId, deviceId, reason } = req.data;

  if (!targetUserId) throw new HttpsError('invalid-argument', 'targetUserId is required.');
  if (!deviceId)     throw new HttpsError('invalid-argument', 'deviceId is required.');
  if (!reason)       throw new HttpsError('invalid-argument', 'reason is required.');

  const firestore = db();
  const actorId   = req.auth.uid;
  const sanitizedReason = _san(reason, 300);

  /* ── Upsert device record ─────────────────────────────────────── */
  const deviceRef = firestore.doc(`securityDevices/${targetUserId}/devices/${deviceId}`);
  await deviceRef.set(
    {
      deviceId,
      userId:       targetUserId,
      blocked:      true,
      trusted:      false,
      trustScore:   0,
      blockedAt:    FieldValue.serverTimestamp(),
      blockedBy:    actorId,
      blockReason:  sanitizedReason,
      updatedAt:    FieldValue.serverTimestamp(),
    },
    { merge: true },
  );

  /* ── Audit log ────────────────────────────────────────────────── */
  await _audit(firestore, {
    action:       'device_blocked',
    targetUserId,
    deviceId:     _san(deviceId, 128),
    actorId,
    reason:       sanitizedReason,
  });

  _log('INFO', 'Device blocked', { targetUserId, deviceId, actorId });

  return { deviceId, blocked: true };
});

/* ================================================================
   7. disablePaymentMethod
   Admin-only.
   Disables a specific payment method (or all) for a seller.
================================================================ */
exports.disablePaymentMethod = onCall(CF_OPTIONS, async (req) => {
  _requireAdmin(req.auth);

  const { sellerId, method, reason } = req.data;

  if (!sellerId) throw new HttpsError('invalid-argument', 'sellerId is required.');
  if (!VALID_PAY_METHODS.has(method)) {
    throw new HttpsError('invalid-argument', `method must be one of: ${[...VALID_PAY_METHODS].join(', ')}`);
  }
  if (!reason) throw new HttpsError('invalid-argument', 'reason is required.');

  const firestore = db();
  const actorId   = req.auth.uid;
  const sanitizedReason = _san(reason, 300);

  /* ── Verify seller exists ─────────────────────────────────────── */
  const sellerRef  = firestore.doc(`sellers/${sellerId}`);
  const sellerSnap = await sellerRef.get();
  if (!sellerSnap.exists) throw new HttpsError('not-found', `Seller ${sellerId} not found.`);

  /* ── Build update payload ─────────────────────────────────────── */
  const methodsToDisable = method === 'all'
    ? ['mpesa', 'card', 'wallet']
    : [method];

  const updatePayload = {};
  for (const m of methodsToDisable) {
    updatePayload[`paymentMethods.${m}.enabled`]        = false;
    updatePayload[`paymentMethods.${m}.disabledAt`]     = FieldValue.serverTimestamp();
    updatePayload[`paymentMethods.${m}.disabledBy`]     = actorId;
    updatePayload[`paymentMethods.${m}.disableReason`]  = sanitizedReason;
  }

  await sellerRef.update(updatePayload);

  /* ── Audit log ────────────────────────────────────────────────── */
  await _audit(firestore, {
    action:    'payment_method_disabled',
    sellerId,
    method,
    actorId,
    reason:    sanitizedReason,
  });

  _log('INFO', 'Payment method disabled', { sellerId, method, actorId });

  return { sellerId, method, disabled: true };
});

/* ================================================================
   8. createIncident
   Admin-only.
   Opens a new security incident with full metadata.
================================================================ */
exports.createIncident = onCall(CF_OPTIONS, async (req) => {
  _requireAdmin(req.auth);

  const {
    type,
    severity,
    title,
    description,
    affectedUsers   = [],
    affectedSellers = [],
    metadata        = {},
  } = req.data;

  if (!type)        throw new HttpsError('invalid-argument', 'type is required.');
  if (!title)       throw new HttpsError('invalid-argument', 'title is required.');
  if (!description) throw new HttpsError('invalid-argument', 'description is required.');
  if (!VALID_SEVERITIES.has(severity)) {
    throw new HttpsError('invalid-argument', `severity must be one of: ${[...VALID_SEVERITIES].join(', ')}`);
  }
  if (!Array.isArray(affectedUsers)) {
    throw new HttpsError('invalid-argument', 'affectedUsers must be an array.');
  }
  if (!Array.isArray(affectedSellers)) {
    throw new HttpsError('invalid-argument', 'affectedSellers must be an array.');
  }

  const firestore     = db();
  const actorId       = req.auth.uid;
  const incidentRef   = firestore.collection('securityIncidents').doc();
  const incidentId    = incidentRef.id;
  const sanitizedDesc = _san(description, 1000);
  const now           = FieldValue.serverTimestamp();

  await incidentRef.set({
    incidentId,
    type:            _san(type, 100),
    severity,
    title:           _san(title, 200),
    description:     sanitizedDesc,
    status:          'open',
    createdAt:       now,
    createdBy:       actorId,
    affectedUsers:   affectedUsers.slice(0, 500),
    affectedSellers: affectedSellers.slice(0, 100),
    metadata,
    timeline:        [_timelineEvent('created', actorId, sanitizedDesc)],
    resolvedAt:      null,
    resolvedBy:      null,
  });

  /* ── Audit log ────────────────────────────────────────────────── */
  await _audit(firestore, {
    action:     'incident_created',
    incidentId,
    type:       _san(type, 100),
    severity,
    actorId,
  });

  _log('INFO', 'Security incident created', { incidentId, type, severity, actorId });

  return { incidentId };
});

/* ================================================================
   9. updateIncident
   Admin-only.
   Advance incident status and/or append a timeline event.
   Validates forward-only status transitions.
================================================================ */
exports.updateIncident = onCall(CF_OPTIONS, async (req) => {
  _requireAdmin(req.auth);

  const { incidentId, status, notes, action } = req.data;

  if (!incidentId) throw new HttpsError('invalid-argument', 'incidentId is required.');
  if (!action)     throw new HttpsError('invalid-argument', 'action is required.');

  const firestore    = db();
  const actorId      = req.auth.uid;
  const incidentRef  = firestore.doc(`securityIncidents/${incidentId}`);
  const incidentSnap = await incidentRef.get();

  if (!incidentSnap.exists) {
    throw new HttpsError('not-found', `Incident ${incidentId} not found.`);
  }

  const current = incidentSnap.data();

  /* ── Validate status transition ───────────────────────────────── */
  if (status) {
    if (!VALID_INC_STATUSES.has(status)) {
      throw new HttpsError('invalid-argument', `Invalid status: ${status}. Must be one of: ${[...VALID_INC_STATUSES].join(', ')}`);
    }
    const allowedNext = STATUS_TRANSITIONS[current.status];
    if (allowedNext && !allowedNext.has(status)) {
      throw new HttpsError('failed-precondition',
        `Cannot transition from '${current.status}' to '${status}'. Allowed: ${[...(allowedNext || [])].join(', ') || 'none (terminal)'}`);
    }
  }

  /* ── Build update payload ─────────────────────────────────────── */
  const updatePayload = {
    timeline: FieldValue.arrayUnion(
      _timelineEvent(_san(action, 100), actorId, _san(notes || '', 500)),
    ),
    updatedAt: FieldValue.serverTimestamp(),
  };

  if (status) {
    updatePayload.status = status;
    if (status === 'resolved') {
      updatePayload.resolvedAt = FieldValue.serverTimestamp();
      updatePayload.resolvedBy = actorId;
    }
  }

  await incidentRef.update(updatePayload);

  /* ── Audit log ────────────────────────────────────────────────── */
  await _audit(firestore, {
    action:      'incident_updated',
    incidentId,
    fromStatus:  current.status,
    toStatus:    status || current.status,
    actorId,
    notes:       _san(notes || '', 500),
  });

  _log('INFO', 'Incident updated', { incidentId, fromStatus: current.status, toStatus: status, actorId });

  return { incidentId, status: status || current.status };
});

/* ================================================================
   10. getIncidents
   Admin-only.
   List and filter security incidents ordered by createdAt desc.
================================================================ */
exports.getIncidents = onCall(CF_OPTIONS, async (req) => {
  _requireAdmin(req.auth);

  const {
    status,
    severity,
    limit     = 50,
    startDate,
    endDate,
  } = req.data;

  const safeLimit = Math.max(1, Math.min(200, Number(limit) || 50));
  const firestore = db();

  let query = firestore.collection('securityIncidents').orderBy('createdAt', 'desc');

  if (status)   query = query.where('status',   '==', status);
  if (severity) query = query.where('severity', '==', severity);

  if (startDate) {
    const start = new Date(startDate);
    if (!isNaN(start.getTime())) query = query.where('createdAt', '>=', start);
  }
  if (endDate) {
    const end = new Date(endDate);
    if (!isNaN(end.getTime())) query = query.where('createdAt', '<=', end);
  }

  const snap      = await query.limit(safeLimit).get();
  const incidents = snap.docs.map(d => {
    const data = d.data();
    /* Strip potentially large timeline from list view for performance */
    const { timeline, ...summary } = data;
    return { ...summary, timelineLength: Array.isArray(timeline) ? timeline.length : 0 };
  });

  return { incidents, count: incidents.length };
});

/* ================================================================
   11. getIncidentTimeline
   Admin-only.
   Returns the full incident document (including timeline) plus
   related securityAuditLog entries that reference this incidentId.
================================================================ */
exports.getIncidentTimeline = onCall(CF_OPTIONS, async (req) => {
  _requireAdmin(req.auth);

  const { incidentId } = req.data;

  if (!incidentId) throw new HttpsError('invalid-argument', 'incidentId is required.');

  const firestore    = db();
  const incidentRef  = firestore.doc(`securityIncidents/${incidentId}`);

  const [incidentSnap, auditSnap] = await Promise.all([
    incidentRef.get(),
    firestore
      .collection('securityAuditLog')
      .where('incidentId', '==', incidentId)
      .orderBy('createdAt', 'asc')
      .limit(500)
      .get(),
  ]);

  if (!incidentSnap.exists) {
    throw new HttpsError('not-found', `Incident ${incidentId} not found.`);
  }

  const incident   = incidentSnap.data();
  const auditEvents = auditSnap.docs.map(d => d.data());

  return {
    incident,
    auditTrail: auditEvents,
  };
});

/* ── Module exports ─────────────────────────────────────────────── */
module.exports = {
  suspendUser:           exports.suspendUser,
  unsuspendUser:         exports.unsuspendUser,
  lockStore:             exports.lockStore,
  unlockStore:           exports.unlockStore,
  revokeUserSessions:    exports.revokeUserSessions,
  blockDevice:           exports.blockDevice,
  disablePaymentMethod:  exports.disablePaymentMethod,
  createIncident:        exports.createIncident,
  updateIncident:        exports.updateIncident,
  getIncidents:          exports.getIncidents,
  getIncidentTimeline:   exports.getIncidentTimeline,
};
