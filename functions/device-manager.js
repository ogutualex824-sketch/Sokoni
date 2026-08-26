/* ================================================================
   SOKONI SmartPOS — Device Manager v1.0
   functions/device-manager.js | 2026-06-29

   Server-side device lifecycle management:
   register, heartbeat, remote commands, lockdown, decommission,
   and nightly cleanup of stale devices.

   9 Cloud Functions:
     registerDevice       — provision a new or reinstalled device
     deviceHeartbeat      — keepalive + remote command delivery
     lockDevice           — admin: lock UI via next heartbeat
     unlockDevice         — admin: restore normal operation
     remoteLogout         — admin: clear cashier session
     remoteUpdate         — admin: trigger SW / app update
     decommissionDevice   — admin: wipe and retire device
     getDeviceList        — owner/admin: list with online status
     cleanupStaleDevices  — scheduled: suspend inactive devices

   Collection:  posDevices/{deviceId}
                deviceAuditLog/{deviceId}_{timestamp}

   Region: us-central1 | Runtime: Node.js 22
   Platform: Firebase Gen2 Cloud Functions
================================================================ */
'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule }         = require('firebase-functions/v2/scheduler');
const admin  = require('firebase-admin');
const crypto = require('crypto');

const db     = admin.firestore();
const F      = admin.firestore.FieldValue;
const REGION = 'us-central1';

/* ── CF options ─────────────────────────────────────────────────── */
const OPT = {
  region:          REGION,
  enforceAppCheck: true,
  timeoutSeconds:  30,
  memory:          '256MiB',
};

// Heartbeat is called every 30 s; skip App Check to reduce latency
const OPT_HEARTBEAT = {
  region:         REGION,
  timeoutSeconds: 10,
  memory:         '128MiB',
};

/* ── Constants ──────────────────────────────────────────────────── */
const DEVICE_TYPES  = ['pos_terminal', 'mobile_pos', 'kiosk', 'tablet'];
const PLATFORMS     = ['web', 'android', 'ios', 'windows', 'linux'];
const OFFLINE_AFTER = 5 * 60 * 1000;    // 5 minutes → mark offline in getDeviceList
const STALE_DAYS    = 30;               // days before cleanupStaleDevices suspends

/* ── UUID v4 regex ──────────────────────────────────────────────── */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function _isUUID(s) { return typeof s === 'string' && UUID_RE.test(s); }

/* ── Structured logger ──────────────────────────────────────────── */
function _log(severity, message, extra = {}) {
  const fn = severity === 'ERROR'   ? console.error
           : severity === 'WARNING' ? console.warn
           : console.log;
  fn(JSON.stringify({ severity, message, service: 'device-manager', ...extra }));
}

/* ── Sanitise strings ───────────────────────────────────────────── */
function _san(v, max = 500) {
  if (typeof v !== 'string') return String(v || '').slice(0, max);
  return v.replace(/[<>"'&]/g, c => ({
    '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '&': '&amp;',
  }[c])).trim().slice(0, max);
}

/* ── HttpsError shorthand ───────────────────────────────────────── */
function _err(msg, code = 'invalid-argument') {
  throw new HttpsError(code, msg);
}

/* ── Require authenticated uid ──────────────────────────────────── */
function _requireAuth(req) {
  if (!req.auth?.uid) _err('Authentication required.', 'unauthenticated');
  return req.auth.uid;
}

/* ── Admin / super-admin check ──────────────────────────────────── */
function _isAdmin(req) {
  return !!(req.auth?.token?.admin || req.auth?.token?.superAdmin);
}

/* ─────────────────────────────────────────────────────────────────
   _assertDeviceAdmin
   Verifies caller is a platform admin, OR the merchant owner.
   merchantId is read from the device doc to prevent ID spoofing.
───────────────────────────────────────────────────────────────── */
async function _assertDeviceAdmin(req, deviceDoc) {
  const uid = _requireAuth(req);
  if (_isAdmin(req)) return uid;

  const merchantId  = deviceDoc.data().merchantId;
  const [bizSnap, merchantSnap] = await Promise.all([
    db.collection('businesses').doc(merchantId).get(),
    db.collection('merchants').doc(merchantId).get(),
  ]);

  const isOwner =
    (bizSnap.exists && bizSnap.data().ownerId === uid) ||
    (merchantSnap.exists && (
      merchantSnap.data().ownerId === uid ||
      (Array.isArray(merchantSnap.data().adminUids) && merchantSnap.data().adminUids.includes(uid))
    ));

  if (!isOwner) _err('Only the merchant owner or platform admin may perform this action.', 'permission-denied');
  return uid;
}

/* ─────────────────────────────────────────────────────────────────
   _assertMerchantAdmin
   Same guard but works off a merchantId directly (not from a device
   doc).  Used in getDeviceList.
───────────────────────────────────────────────────────────────── */
async function _assertMerchantAdmin(req, merchantId) {
  const uid = _requireAuth(req);
  if (_isAdmin(req)) return uid;

  const [bizSnap, merchantSnap] = await Promise.all([
    db.collection('businesses').doc(merchantId).get(),
    db.collection('merchants').doc(merchantId).get(),
  ]);

  const isOwner =
    (bizSnap.exists && bizSnap.data().ownerId === uid) ||
    (merchantSnap.exists && (
      merchantSnap.data().ownerId === uid ||
      (Array.isArray(merchantSnap.data().adminUids) && merchantSnap.data().adminUids.includes(uid))
    ));

  if (!isOwner) _err('Access denied.', 'permission-denied');
  return uid;
}

/* ─────────────────────────────────────────────────────────────────
   _writeAuditLog
   Writes an immutable entry to deviceAuditLog.
   Non-blocking — failures are logged but never propagate.
───────────────────────────────────────────────────────────────── */
function _writeAuditLog(deviceId, type, by, extra = {}) {
  const logId = `${deviceId}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
  db.collection('deviceAuditLog').doc(logId).set({
    deviceId,
    type,
    by,
    at: F.serverTimestamp(),
    ...extra,
  }).catch(e => _log('WARNING', 'deviceAuditLog write failed', { deviceId, type, error: e.message }));
}

/* ═══════════════════════════════════════════════════════════════════
   CF 1 — registerDevice
   Provisions a new POS device or re-registers after reinstall.
   Idempotent — safe to call on every app launch.
═══════════════════════════════════════════════════════════════════ */
exports.registerDevice = onCall(OPT, async (req) => {
  const uid = _requireAuth(req);

  const {
    deviceId,
    merchantId,
    branchId,
    deviceName,
    deviceType,
    platform,
    osVersion,
    appVersion,
    screenResolution,
  } = req.data || {};

  /* ── Input validation ─────────────────────────────────────── */
  if (!deviceId)   _err('deviceId is required.');
  if (!merchantId) _err('merchantId is required.');
  if (!branchId)   _err('branchId is required.');
  if (!_isUUID(deviceId)) {
    _err('deviceId must be a valid UUID v4.  Generate one on the client with crypto.randomUUID().');
  }
  if (deviceType && !DEVICE_TYPES.includes(deviceType)) {
    _err(`deviceType must be one of: ${DEVICE_TYPES.join(', ')}.`);
  }
  if (platform && !PLATFORMS.includes(platform)) {
    _err(`platform must be one of: ${PLATFORMS.join(', ')}.`);
  }

  const safeDeviceId   = deviceId.toLowerCase();
  const safeMerchantId = _san(merchantId, 128);
  const safeBranchId   = _san(branchId, 128);

  /* ── Verify caller belongs to merchant ────────────────────── */
  const [bizSnap, merchantSnap, staffSnap] = await Promise.all([
    db.collection('businesses').doc(safeMerchantId).get(),
    db.collection('merchants').doc(safeMerchantId).get(),
    db.collection('posStaff')
      .where('branchId', '==', safeBranchId)
      .where('uid', '==', uid)
      .where('status', '==', 'active')
      .limit(1)
      .get(),
  ]);

  if (!_isAdmin(req)) {
    const isOwner =
      (bizSnap.exists && bizSnap.data().ownerId === uid) ||
      (merchantSnap.exists && (
        merchantSnap.data().ownerId === uid ||
        (Array.isArray(merchantSnap.data().adminUids) && merchantSnap.data().adminUids.includes(uid))
      ));
    if (!isOwner && staffSnap.empty) {
      _err('You do not have permission to register a device for this merchant.', 'permission-denied');
    }
  }

  const deviceRef = db.collection('posDevices').doc(safeDeviceId);
  const existing  = await deviceRef.get();
  const isNew     = !existing.exists;

  /* ── Decommissioned devices may not be re-registered ─────── */
  if (existing.exists && existing.data().status === 'decommissioned') {
    _err('This device has been decommissioned and cannot be re-registered.  Contact your administrator.', 'permission-denied');
  }

  const now      = F.serverTimestamp();
  const payload  = {
    deviceId:         safeDeviceId,
    merchantId:       safeMerchantId,
    branchId:         safeBranchId,
    cashierId:        uid,
    deviceName:       _san(deviceName || 'POS Device', 200),
    deviceType:       deviceType || 'pos_terminal',
    platform:         platform || 'web',
    osVersion:        _san(osVersion || '', 100),
    appVersion:       _san(appVersion || '', 50),
    screenResolution: _san(screenResolution || '', 50),
    status:           'active',
    lastSeenAt:       now,
    lastSyncAt:       now,
    remoteCommand:    null,
    ...(isNew ? { registeredAt: now, batteryLevel: null, connectivity: null, ipAddress: null } : {}),
  };

  await deviceRef.set(payload, { merge: true });

  _writeAuditLog(safeDeviceId, isNew ? 'registered' : 'reregistered', uid, {
    merchantId: safeMerchantId,
    branchId:   safeBranchId,
    platform,
    appVersion,
  });

  _log('INFO', isNew ? 'Device registered' : 'Device re-registered', {
    deviceId: safeDeviceId,
    merchantId: safeMerchantId,
    uid,
  });

  return { registered: true, deviceId: safeDeviceId, isNew };
});

/* ═══════════════════════════════════════════════════════════════════
   CF 2 — deviceHeartbeat
   Called every 30 s by an active POS device.
   Updates presence data and delivers any pending remote command.
   App Check intentionally omitted — frequent, lightweight call.
═══════════════════════════════════════════════════════════════════ */
exports.deviceHeartbeat = onCall(OPT_HEARTBEAT, async (req) => {
  // Heartbeat still requires authentication
  const uid = _requireAuth(req);

  const {
    deviceId,
    batteryLevel  = null,
    connectivity  = null,
    appVersion    = null,
    cashierId     = null,
  } = req.data || {};

  if (!deviceId) _err('deviceId is required.');

  const safeDeviceId = _san(deviceId, 200);
  const deviceRef    = db.collection('posDevices').doc(safeDeviceId);

  let command = null;

  // Use a transaction to atomically read the command and clear it
  await db.runTransaction(async tx => {
    const snap = tx.get(deviceRef);
    const doc  = await snap;

    if (!doc.exists) _err('Device not found.', 'not-found');
    if (doc.data().status === 'decommissioned') {
      // Always deliver wipe command to decommissioned devices
      command = doc.data().remoteCommand || { type: 'wipe', issuedAt: new Date().toISOString() };
      // Don't update anything — device should not be posting heartbeats
      return;
    }

    const pending = doc.data().remoteCommand;

    const update = {
      lastSeenAt:  F.serverTimestamp(),
      appVersion:  _san(appVersion || doc.data().appVersion || '', 50),
    };

    if (batteryLevel !== null && typeof batteryLevel === 'number') {
      update.batteryLevel = Math.min(100, Math.max(0, batteryLevel));
    }
    if (connectivity) {
      update.connectivity = _san(connectivity, 50);
    }
    if (cashierId) {
      update.cashierId = _san(cashierId, 128);
    }

    if (pending) {
      command = pending;
      update.remoteCommand = null;   // clear after delivery
    }

    tx.update(deviceRef, update);
  });

  return {
    ok:         true,
    command:    command || null,
    serverTime: new Date().toISOString(),
  };
});

/* ═══════════════════════════════════════════════════════════════════
   CF 3 — lockDevice
   Admin / owner: queue a lock command to be delivered on the
   device's next heartbeat.  Device freezes its UI on receipt.
═══════════════════════════════════════════════════════════════════ */
exports.lockDevice = onCall(OPT, async (req) => {
  const uid = _requireAuth(req);

  const { deviceId, reason = 'Administrative lock' } = req.data || {};
  if (!deviceId) _err('deviceId is required.');

  const safeDeviceId = _san(deviceId, 200);
  const deviceRef    = db.collection('posDevices').doc(safeDeviceId);
  const deviceSnap   = await deviceRef.get();

  if (!deviceSnap.exists) _err('Device not found.', 'not-found');
  if (deviceSnap.data().status === 'decommissioned') {
    _err('Cannot lock a decommissioned device.', 'failed-precondition');
  }

  await _assertDeviceAdmin(req, deviceSnap);

  const command = {
    type:     'lock',
    issuedAt: new Date().toISOString(),
    issuedBy: uid,
    payload:  { reason: _san(reason, 500) },
  };

  await deviceRef.update({
    remoteCommand: command,
    status:        'locked',
  });

  _writeAuditLog(safeDeviceId, 'locked', uid, { reason: command.payload.reason });

  _log('INFO', 'lockDevice', { deviceId: safeDeviceId, by: uid, reason });
  return { queued: true, command };
});

/* ═══════════════════════════════════════════════════════════════════
   CF 4 — unlockDevice
   Admin / owner: restore a locked device to active status.
═══════════════════════════════════════════════════════════════════ */
exports.unlockDevice = onCall(OPT, async (req) => {
  const uid = _requireAuth(req);

  const { deviceId } = req.data || {};
  if (!deviceId) _err('deviceId is required.');

  const safeDeviceId = _san(deviceId, 200);
  const deviceRef    = db.collection('posDevices').doc(safeDeviceId);
  const deviceSnap   = await deviceRef.get();

  if (!deviceSnap.exists) _err('Device not found.', 'not-found');
  if (deviceSnap.data().status === 'decommissioned') {
    _err('Cannot unlock a decommissioned device.', 'failed-precondition');
  }

  await _assertDeviceAdmin(req, deviceSnap);

  await deviceRef.update({
    status:        'active',
    remoteCommand: null,
  });

  _writeAuditLog(safeDeviceId, 'unlocked', uid);

  _log('INFO', 'unlockDevice', { deviceId: safeDeviceId, by: uid });
  return { unlocked: true };
});

/* ═══════════════════════════════════════════════════════════════════
   CF 5 — remoteLogout
   Admin / owner: clear the cashier session on a device.
   The device receives the logout command on next heartbeat and
   returns to the login screen.
═══════════════════════════════════════════════════════════════════ */
exports.remoteLogout = onCall(OPT, async (req) => {
  const uid = _requireAuth(req);

  const { deviceId } = req.data || {};
  if (!deviceId) _err('deviceId is required.');

  const safeDeviceId = _san(deviceId, 200);
  const deviceRef    = db.collection('posDevices').doc(safeDeviceId);
  const deviceSnap   = await deviceRef.get();

  if (!deviceSnap.exists) _err('Device not found.', 'not-found');

  await _assertDeviceAdmin(req, deviceSnap);

  const command = {
    type:     'logout',
    issuedAt: new Date().toISOString(),
    issuedBy: uid,
    payload:  {},
  };

  await deviceRef.update({ remoteCommand: command });

  _writeAuditLog(safeDeviceId, 'remote_logout', uid);

  _log('INFO', 'remoteLogout', { deviceId: safeDeviceId, by: uid });
  return { queued: true, command };
});

/* ═══════════════════════════════════════════════════════════════════
   CF 6 — remoteUpdate
   Admin / owner: instruct the device to update its service worker /
   application to a target version.
═══════════════════════════════════════════════════════════════════ */
exports.remoteUpdate = onCall(OPT, async (req) => {
  const uid = _requireAuth(req);

  const { deviceId, targetVersion } = req.data || {};
  if (!deviceId)      _err('deviceId is required.');
  if (!targetVersion) _err('targetVersion is required.');

  const safeDeviceId     = _san(deviceId, 200);
  const safeTargetVersion = _san(targetVersion, 50);

  const deviceRef  = db.collection('posDevices').doc(safeDeviceId);
  const deviceSnap = await deviceRef.get();

  if (!deviceSnap.exists) _err('Device not found.', 'not-found');
  if (deviceSnap.data().status === 'decommissioned') {
    _err('Cannot update a decommissioned device.', 'failed-precondition');
  }

  await _assertDeviceAdmin(req, deviceSnap);

  const command = {
    type:     'update',
    issuedAt: new Date().toISOString(),
    issuedBy: uid,
    payload:  { targetVersion: safeTargetVersion },
  };

  await deviceRef.update({ remoteCommand: command });

  _writeAuditLog(safeDeviceId, 'remote_update', uid, { targetVersion: safeTargetVersion });

  _log('INFO', 'remoteUpdate', { deviceId: safeDeviceId, targetVersion: safeTargetVersion, by: uid });
  return { queued: true, command };
});

/* ═══════════════════════════════════════════════════════════════════
   CF 7 — decommissionDevice
   Admin / owner: retire a device permanently.
   Sets status → 'decommissioned' and queues a wipe command.
   Device clears all local data and logs out on next heartbeat.
═══════════════════════════════════════════════════════════════════ */
exports.decommissionDevice = onCall(OPT, async (req) => {
  const uid = _requireAuth(req);

  const { deviceId, reason = 'Device decommissioned by administrator' } = req.data || {};
  if (!deviceId) _err('deviceId is required.');

  const safeDeviceId = _san(deviceId, 200);
  const deviceRef    = db.collection('posDevices').doc(safeDeviceId);
  const deviceSnap   = await deviceRef.get();

  if (!deviceSnap.exists) _err('Device not found.', 'not-found');
  if (deviceSnap.data().status === 'decommissioned') {
    return { decommissioned: true, alreadyDecommissioned: true };
  }

  await _assertDeviceAdmin(req, deviceSnap);

  const command = {
    type:     'wipe',
    issuedAt: new Date().toISOString(),
    issuedBy: uid,
    payload:  { reason: _san(reason, 500) },
  };

  await deviceRef.update({
    status:           'decommissioned',
    decommissionedAt: F.serverTimestamp(),
    remoteCommand:    command,
  });

  _writeAuditLog(safeDeviceId, 'decommissioned', uid, { reason: command.payload.reason });

  _log('INFO', 'decommissionDevice', { deviceId: safeDeviceId, by: uid, reason });
  return { decommissioned: true, command };
});

/* ═══════════════════════════════════════════════════════════════════
   CF 8 — getDeviceList
   Admin / owner: list all devices for a merchant, optionally
   filtered by branch.  Devices are marked online/offline based on
   lastSeenAt recency (> 5 minutes = offline).
═══════════════════════════════════════════════════════════════════ */
exports.getDeviceList = onCall(OPT, async (req) => {
  const uid = _requireAuth(req);

  const { merchantId, branchId = null } = req.data || {};
  if (!merchantId) _err('merchantId is required.');

  const safeMerchantId = _san(merchantId, 128);

  await _assertMerchantAdmin(req, safeMerchantId);

  let query = db.collection('posDevices')
    .where('merchantId', '==', safeMerchantId);

  if (branchId) {
    query = query.where('branchId', '==', _san(branchId, 128));
  }

  const snap    = await query.orderBy('lastSeenAt', 'desc').limit(200).get();
  const nowMs   = Date.now();

  const devices = snap.docs.map(d => {
    const dev         = d.data();
    const lastSeenAt  = dev.lastSeenAt?.toDate ? dev.lastSeenAt.toDate() : null;
    const onlineStatus = lastSeenAt && (nowMs - lastSeenAt.getTime() < OFFLINE_AFTER)
      ? 'online'
      : 'offline';

    return {
      deviceId:         dev.deviceId,
      merchantId:       dev.merchantId,
      branchId:         dev.branchId,
      deviceName:       dev.deviceName,
      deviceType:       dev.deviceType,
      platform:         dev.platform,
      appVersion:       dev.appVersion,
      status:           dev.status,
      onlineStatus,
      cashierId:        dev.cashierId || null,
      batteryLevel:     dev.batteryLevel ?? null,
      connectivity:     dev.connectivity || null,
      lastSeenAt:       lastSeenAt ? lastSeenAt.toISOString() : null,
      lastSyncAt:       dev.lastSyncAt?.toDate ? dev.lastSyncAt.toDate().toISOString() : null,
      registeredAt:     dev.registeredAt?.toDate ? dev.registeredAt.toDate().toISOString() : null,
      decommissionedAt: dev.decommissionedAt?.toDate ? dev.decommissionedAt.toDate().toISOString() : null,
      hasPendingCommand: !!dev.remoteCommand,
    };
  });

  const summary = {
    total:          devices.length,
    online:         devices.filter(d => d.onlineStatus === 'online').length,
    offline:        devices.filter(d => d.onlineStatus === 'offline').length,
    active:         devices.filter(d => d.status === 'active').length,
    locked:         devices.filter(d => d.status === 'locked').length,
    suspended:      devices.filter(d => d.status === 'suspended').length,
    decommissioned: devices.filter(d => d.status === 'decommissioned').length,
  };

  _log('INFO', 'getDeviceList', { merchantId: safeMerchantId, uid, count: devices.length });
  return { devices, summary };
});

/* ═══════════════════════════════════════════════════════════════════
   CF 9 — cleanupStaleDevices (scheduled)
   Runs daily at 04:00 UTC (07:00 EAT).
   Devices that have not been seen in 30 days are moved to
   'suspended' — not decommissioned, so the merchant can reinstate.
   Writes an adminAlert for visibility.
═══════════════════════════════════════════════════════════════════ */
exports.cleanupStaleDevices = onSchedule(
  { schedule: '0 4 * * *', region: REGION, timeoutSeconds: 300, memory: '256MiB' },
  async (_event) => {
    _log('INFO', 'cleanupStaleDevices — start');

    const staleCutoff = new Date(Date.now() - STALE_DAYS * 24 * 60 * 60 * 1000);

    const staleSnap = await db.collection('posDevices')
      .where('status', '==', 'active')
      .where('lastSeenAt', '<', staleCutoff)
      .limit(500)
      .get();

    if (staleSnap.empty) {
      _log('INFO', 'cleanupStaleDevices — no stale devices found');
      return;
    }

    const batch   = db.batch();
    const deviceIds = [];

    staleSnap.docs.forEach(doc => {
      batch.update(doc.ref, {
        status:      'suspended',
        suspendedAt: F.serverTimestamp(),
        suspendedBy: 'system',
      });
      deviceIds.push(doc.id);
    });

    // Write a single admin alert summarising the cleanup
    const alertRef = db.collection('adminAlerts').doc();
    batch.set(alertRef, {
      type:      'stale_devices_suspended',
      severity:  'info',
      message:   `${deviceIds.length} POS device(s) suspended — no activity for ${STALE_DAYS}+ days.`,
      deviceIds,
      count:     deviceIds.length,
      createdAt: F.serverTimestamp(),
      resolved:  false,
    });

    await batch.commit();

    // Write audit log for each suspended device (non-blocking)
    deviceIds.forEach(id => _writeAuditLog(id, 'auto_suspended_stale', 'system', { staleDays: STALE_DAYS }));

    _log('INFO', 'cleanupStaleDevices — complete', { suspended: deviceIds.length, deviceIds });
  }
);


/* ═══════════════════════════════════════════════════════════════════════════════
   registerPrinterHost — declare THIS device the shop's printer host
   ═══════════════════════════════════════════════════════════════════════════════
   The desktop SOKONI PWA holds the Bluetooth link to the P58E. A phone sale must never
   reach that printer directly; it creates durable work, and an authorised host executes it.
   This establishes who that host is.

   THE CALLER NEVER SUPPLIES merchantId. It is read from the STORED posDevices document, so
   a phone cannot name somebody else's shop and become its print destination. The device
   record is the ownership fact; the request is only a pointer to it.

   `printerHost: true` is NOT the authority. The authority is the server-verified chain:

       authenticated user -> owns/administers the shop -> that shop owns this device

   which is why this is a callable and why posDevices remains `allow write: if false` for
   clients. No rules change accompanies this.

   AUTHORISATION is the same check registerDevice already makes — businesses.ownerId,
   merchants.ownerId, merchants.adminUids, or active posStaff on the branch — reused rather
   than re-derived, so the two functions cannot drift into two answers about who runs a shop.
   It is also the server mirror of the rules' ownsBiz(), so client reads and server writes
   agree on what ownership means.

   ONE ACTIVE HOST PER SHOP. A second registration is REFUSED unless the caller passes
   replace:true. Two desktops silently sharing print responsibility is how one sale becomes
   two receipts, and the atomic transaction below is what makes the winner unambiguous.

   DEVICE IDS ARE TAKEN AS FOUND. registerDevice demands a UUID v4; bootstrapDevice writes
   any sanitised string, and production holds both. Re-imposing UUID validation here would
   make a bootstrap-created desktop permanently ineligible to host.

   MIGRATION INVARIANT: scripts/migrate-canonical-business.js re-identifies devices and
   stamps mergedFrom/mergedAt (present on 5 of 20 live devices). It does not carry
   printerHost across. If that migration runs again, a merchant silently loses their print
   destination and must re-register. Documented rather than automated: the migration is a
   one-off, and guessing which of two merged devices should host is worse than asking.
   ═══════════════════════════════════════════════════════════════════════════════ */
exports.registerPrinterHost = onCall(OPT, async (req) => {
  const uid = _requireAuth(req);
  const { deviceId, printerIdentity, replace } = req.data || {};

  if (!deviceId) _err('deviceId is required.');
  /* Taken as found — see the note above on the two id vocabularies. */
  const safeDeviceId = _san(String(deviceId), 200);

  const deviceRef = db.collection('posDevices').doc(safeDeviceId);
  const deviceSnap = await deviceRef.get();
  if (!deviceSnap.exists) {
    _err('That device is not registered. Register the device before making it a printer host.',
         'not-found');
  }

  const device = deviceSnap.data() || {};
  /* THE SHOP, from the record. Never from the request. */
  const merchantId = device.merchantId;
  const branchId = device.branchId || null;
  if (!merchantId) {
    _err('That device has no shop on its record, so it cannot host a printer.', 'failed-precondition');
  }

  /* ── Authorisation: identical to registerDevice ─────────────────────────── */
  const [bizSnap, merchantSnap, staffSnap] = await Promise.all([
    db.collection('businesses').doc(merchantId).get(),
    db.collection('merchants').doc(merchantId).get(),
    branchId
      ? db.collection('posStaff')
          .where('branchId', '==', branchId)
          .where('uid', '==', uid)
          .where('status', '==', 'active')
          .limit(1)
          .get()
      : Promise.resolve({ empty: true }),
  ]);

  if (!_isAdmin(req)) {
    const isOwner =
      (bizSnap.exists && bizSnap.data().ownerId === uid) ||
      (merchantSnap.exists && (
        merchantSnap.data().ownerId === uid ||
        (Array.isArray(merchantSnap.data().adminUids) && merchantSnap.data().adminUids.includes(uid))
      ));
    if (!isOwner && staffSnap.empty) {
      _err('You do not have permission to set a printer host for this shop.', 'permission-denied');
    }
  }

  const ident = printerIdentity || {};
  const printerDeviceKey = ident.deviceKey ? _san(String(ident.deviceKey), 200) : null;
  const printerTransport = ident.transport ? _san(String(ident.transport), 32) : 'bluetooth';
  const printerName = ident.name ? _san(String(ident.name), 120) : null;

  /* ── The assignment, atomically ─────────────────────────────────────────── */
  const result = await db.runTransaction(async (txn) => {
    /* Every existing host for this shop. A query inside the transaction so a second desktop
       racing the same registration cannot slip between the read and the write. */
    const hostsSnap = await txn.get(
      db.collection('posDevices')
        .where('merchantId', '==', merchantId)
        .where('printerHost', '==', true)
        .limit(10)
    );

    const others = hostsSnap.docs.filter((d) => d.id !== safeDeviceId);

    /* Re-registering the same device is idempotent: it refreshes the identity and the
       heartbeat, and does not create a second host or need `replace`. */
    const alreadyThis = hostsSnap.docs.some((d) => d.id === safeDeviceId);

    if (others.length && !replace) {
      const err = new HttpsError(
        'already-exists',
        'This shop already has a printer host. Pass replace to move printing to this device.',
      );
      err.details = { currentHost: others[0].id, currentHostName: (others[0].data() || {}).printerName || null };
      throw err;
    }

    /* Replacement clears the previous host IN THE SAME TRANSACTION, so the shop is never
       momentarily hostless and never briefly double-hosted. */
    others.forEach((d) => {
      txn.update(d.ref, {
        printerHost: false,
        printerHostReplacedAt: F.serverTimestamp(),
        printerHostReplacedBy: safeDeviceId,
      });
    });

    /* ADDITIVE. Only printerHost* fields are written; deviceId, merchantId, branchId,
       cashierId, status, connectivity and the heartbeats are untouched. */
    const patch = {
      printerHost: true,
      printerHostLastSeenAt: F.serverTimestamp(),
      printerTransport,
    };
    if (!alreadyThis) patch.printerHostAt = F.serverTimestamp();
    if (printerDeviceKey) patch.printerDeviceKey = printerDeviceKey;
    if (printerName) patch.printerName = printerName;
    txn.set(deviceRef, patch, { merge: true });

    return { replaced: others.map((d) => d.id), wasAlreadyHost: alreadyThis };
  });

  _log('INFO', 'printer host registered', {
    deviceId: safeDeviceId, merchantId, uid,
    replaced: result.replaced, idempotent: result.wasAlreadyHost,
  });

  return {
    ok: true,
    deviceId: safeDeviceId,
    merchantId,
    printerHost: true,
    replaced: result.replaced,
    alreadyHost: result.wasAlreadyHost,
  };
});

/* ── Exports ─────────────────────────────────────────────────────── */
module.exports = {
  registerDevice:      exports.registerDevice,
  registerPrinterHost: exports.registerPrinterHost,
  deviceHeartbeat:     exports.deviceHeartbeat,
  lockDevice:          exports.lockDevice,
  unlockDevice:        exports.unlockDevice,
  remoteLogout:        exports.remoteLogout,
  remoteUpdate:        exports.remoteUpdate,
  decommissionDevice:  exports.decommissionDevice,
  getDeviceList:       exports.getDeviceList,
  cleanupStaleDevices: exports.cleanupStaleDevices,
};
