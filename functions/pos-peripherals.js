/* ================================================================
   SOKONI SmartPOS 2.0 — Peripheral Management Cloud Functions
   functions/pos-peripherals.js  v1.0  (2026-07-06)

   Exports:
     posRegisterPeripheral
     posUpdatePeripheralStatus
     posRemovePeripheral
     posGetPeripherals
     posCreateCustomerDisplay
     posUpdateCustomerDisplay
================================================================ */
'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onDocumentWritten }  = require('firebase-functions/v2/firestore');
const admin                  = require('firebase-admin');
const { checkRateLimit }     = require('./redis-rate-limiter');

const db  = () => admin.firestore();
const FieldValue = admin.firestore.FieldValue;
const Timestamp  = admin.firestore.Timestamp;

/* ── Auth guard helper ──────────────────────────────────────── */
function requireAuth(auth) {
  if (!auth || !auth.uid) throw new HttpsError('unauthenticated', 'Sign in required');
}

/* ── Role guard: seller or admin ────────────────────────────── */
async function requirePosAccess(uid) {
  const snap = await db().collection('users').doc(uid).get();
  const data = snap.data() || {};
  const role = data.role || '';
  if (!['seller', 'pos_operator', 'admin', 'superadmin'].includes(role))
    throw new HttpsError('permission-denied', 'POS access required');
  return data;
}

/* ── Peripheral document helper ─────────────────────────────── */
function peripheralPath(merchantId, deviceId) {
  return `merchants/${merchantId}/posPeripherals/${deviceId}`;
}

/* ================================================================
   posRegisterPeripheral
   Registers a new peripheral device to a POS merchant account.
   Input: { merchantId, deviceId?, type, transport, name, vendor,
            model, protocol, config }
   Output: { id, created }
================================================================ */
exports.posRegisterPeripheral = onCall({ region: 'us-central1' }, async (request) => {
  requireAuth(request.auth);
  await checkRateLimit(request, 'pos');
  await requirePosAccess(request.auth.uid);

  const { merchantId, type, transport, name, vendor, model, protocol, config } = request.data;
  if (!merchantId) throw new HttpsError('invalid-argument', 'merchantId required');
  if (!type)       throw new HttpsError('invalid-argument', 'type required');
  if (!name)       throw new HttpsError('invalid-argument', 'name required');

  /* Verify caller belongs to this merchant */
  const userSnap = await db().collection('users').doc(request.auth.uid).get();
  const userData = userSnap.data() || {};
  if (userData.merchantId !== merchantId && !['admin','superadmin'].includes(userData.role))
    throw new HttpsError('permission-denied', 'Not authorised for this merchant');

  /* Auto-generate ID or use provided */
  const deviceId = request.data.deviceId || db().collection('tmp').doc().id;
  const ref = db().doc(peripheralPath(merchantId, deviceId));

  const payload = {
    id:         deviceId,
    merchantId,
    type,
    transport:  transport || 'unknown',
    name:       name.trim().slice(0, 100),
    vendor:     (vendor  || '').slice(0, 100),
    model:      (model   || '').slice(0, 100),
    protocol:   (protocol|| '').slice(0, 50),
    config:     config   || {},
    status:     'registered',
    health:     'unknown',
    registeredBy: request.auth.uid,
    registeredAt: Timestamp.now(),
    updatedAt:    Timestamp.now(),
    lastSeenAt:   null,
    connectedAt:  null,
    errorMsg:     null,
  };

  await ref.set(payload, { merge: false });

  /* Audit */
  await _auditLog(merchantId, {
    action: 'peripheral_registered',
    deviceId, deviceType: type, transport, name, vendor,
    uid: request.auth.uid,
  });

  return { id: deviceId, created: true };
});

/* ================================================================
   posUpdatePeripheralStatus
   Called by the POS device to heartbeat / report status.
   Input: { merchantId, deviceId, status, health, errorMsg? }
================================================================ */
exports.posUpdatePeripheralStatus = onCall({ region: 'us-central1' }, async (request) => {
  requireAuth(request.auth);

  const { merchantId, deviceId, status, health, errorMsg } = request.data;
  if (!merchantId) throw new HttpsError('invalid-argument', 'merchantId required');
  if (!deviceId)   throw new HttpsError('invalid-argument', 'deviceId required');

  const VALID_STATUSES = ['connected','disconnected','error','reconnecting','idle'];
  if (status && !VALID_STATUSES.includes(status))
    throw new HttpsError('invalid-argument', 'Invalid status value');

  const ref = db().doc(peripheralPath(merchantId, deviceId));
  const update = {
    updatedAt:  Timestamp.now(),
    lastSeenAt: Timestamp.now(),
  };
  if (status)    update.status  = status;
  if (health)    update.health  = health;
  if (errorMsg !== undefined) update.errorMsg = errorMsg || null;
  if (status === 'connected') update.connectedAt = Timestamp.now();

  await ref.update(update);
  return { ok: true };
});

/* ================================================================
   posRemovePeripheral
   Admin / merchant owner can permanently remove a device.
   Input: { merchantId, deviceId, reason? }
================================================================ */
exports.posRemovePeripheral = onCall({ region: 'us-central1' }, async (request) => {
  requireAuth(request.auth);
  await requirePosAccess(request.auth.uid);

  const { merchantId, deviceId, reason } = request.data;
  if (!merchantId) throw new HttpsError('invalid-argument', 'merchantId required');
  if (!deviceId)   throw new HttpsError('invalid-argument', 'deviceId required');

  /* Fetch device first for audit record */
  const snap = await db().doc(peripheralPath(merchantId, deviceId)).get();
  if (!snap.exists) throw new HttpsError('not-found', 'Peripheral not found');
  const devData = snap.data();

  /* Check ownership */
  const userSnap = await db().collection('users').doc(request.auth.uid).get();
  const userData = userSnap.data() || {};
  if (userData.merchantId !== merchantId && !['admin','superadmin'].includes(userData.role))
    throw new HttpsError('permission-denied', 'Not authorised for this merchant');

  await db().doc(peripheralPath(merchantId, deviceId)).delete();

  await _auditLog(merchantId, {
    action: 'peripheral_removed',
    deviceId,
    deviceType: devData.type,
    deviceName: devData.name,
    reason: (reason || '').slice(0, 200),
    uid: request.auth.uid,
  });

  /* Broadcast removal signal via Firestore so the device disconnects */
  await db().collection('posPeripheralSignals').add({
    merchantId,
    deviceId,
    signal: 'force_disconnect',
    issuedBy: request.auth.uid,
    issuedAt: Timestamp.now(),
    ttl:      Timestamp.fromMillis(Date.now() + 60_000),
  });

  return { removed: true };
});

/* ================================================================
   posGetPeripherals
   Returns all peripherals registered to a merchant.
   Input: { merchantId, type? (filter by type) }
================================================================ */
exports.posGetPeripherals = onCall({ region: 'us-central1' }, async (request) => {
  requireAuth(request.auth);

  const { merchantId, type } = request.data;
  if (!merchantId) throw new HttpsError('invalid-argument', 'merchantId required');

  /* Verify access */
  const userSnap = await db().collection('users').doc(request.auth.uid).get();
  const userData = userSnap.data() || {};
  if (userData.merchantId !== merchantId && !['admin','superadmin'].includes(userData.role))
    throw new HttpsError('permission-denied', 'Not authorised for this merchant');

  let query = db().collection(`merchants/${merchantId}/posPeripherals`);
  if (type) query = query.where('type', '==', type);

  const snap = await query.get();
  const devices = snap.docs.map(d => {
    const { config, ...rest } = d.data();
    /* Strip sensitive config fields before returning to client */
    const safeConfig = { ...config };
    delete safeConfig.apiKey;
    delete safeConfig.token;
    delete safeConfig.secret;
    delete safeConfig.password;
    return { ...rest, config: safeConfig };
  });

  return { devices, total: devices.length };
});

/* ================================================================
   posCreateCustomerDisplay
   Creates / resets the customer display session document.
   Input: { merchantId, sessionId, branding? }
================================================================ */
exports.posCreateCustomerDisplay = onCall({ region: 'us-central1' }, async (request) => {
  requireAuth(request.auth);
  await requirePosAccess(request.auth.uid);

  const { merchantId, sessionId, branding } = request.data;
  if (!merchantId) throw new HttpsError('invalid-argument', 'merchantId required');
  if (!sessionId)  throw new HttpsError('invalid-argument', 'sessionId required');

  const payload = {
    merchantId,
    sessionId,
    type:      'idle',
    branding:  branding || {},
    cart:      [],
    subtotal:  0, discount: 0, tax: 0, total: 0,
    currency:  'KES',
    status:    'idle',
    createdBy: request.auth.uid,
    createdAt: Timestamp.now(),
    updatedAt: Timestamp.now(),
  };

  await db().collection('posCustomerDisplays').doc(sessionId).set(payload, { merge: false });
  return { ok: true, sessionId };
});

/* ================================================================
   posUpdateCustomerDisplay
   POS updates the customer display state (cart, payment screen, etc).
   Input: { sessionId, type, ...payload }
================================================================ */
exports.posUpdateCustomerDisplay = onCall({ region: 'us-central1' }, async (request) => {
  requireAuth(request.auth);
  await checkRateLimit(request, 'pos');

  const { sessionId, ...payload } = request.data;
  if (!sessionId) throw new HttpsError('invalid-argument', 'sessionId required');

  /* Limit payload size */
  const payloadStr = JSON.stringify(payload);
  if (payloadStr.length > 32_768)
    throw new HttpsError('invalid-argument', 'Payload too large (max 32KB)');

  await db().collection('posCustomerDisplays').doc(sessionId).update({
    ...payload,
    updatedAt: Timestamp.now(),
  });

  return { ok: true };
});

/* ================================================================
   Auto-cleanup: posPeripheralSignals TTL trigger
   Deletes expired signal documents to avoid unbounded growth.
================================================================ */
exports.posCleanupPeripheralSignals = onDocumentWritten(
  { document: 'posPeripheralSignals/{signalId}', region: 'us-central1' },
  async (event) => {
    const data = event.data?.after?.data();
    if (!data) return;
    if (!data.ttl) return;
    const ttlMs = data.ttl.toMillis ? data.ttl.toMillis() : data.ttl;
    if (Date.now() > ttlMs) {
      await event.data.after.ref.delete();
    }
  }
);

/* ── Internal: audit log ─────────────────────────────────────── */
async function _auditLog(merchantId, entry) {
  try {
    await db().collection(`merchants/${merchantId}/posAudit`).add({
      ...entry,
      createdAt: Timestamp.now(),
      environment: process.env.NODE_ENV || 'production',
    });
  } catch {}
}
