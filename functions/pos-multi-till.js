/* ================================================================
   SOKONI SmartPOS — Multi-Till handlers v1.0
   functions/pos-multi-till.js

   9 handlers for register lifecycle management, live floor
   monitoring, and per-till performance reporting.
   Consumed by smartpos-dispatch.js via exports._h.

   Collections:
     posRegisters/{merchantId}_{registerId}  — static register config
     posTillState/{merchantId}_{registerId}  — live till heartbeat (client-written)
     posTillEvents/{id}                      — significant floor events

   Handlers (op names):
     mtRegisterCreate      — create a register (admin)
     mtRegisterUpdate      — update register config (admin)
     mtRegisterDelete      — soft-delete (admin)
     mtRegisterList        — list registers (manager+)
     mtRegisterAssign      — assign/unassign cashier (manager+)
     mtGetLiveFloor        — all active till states (manager+)
     mtGetFloorSummary     — aggregated store KPIs (manager+)
     mtGetRegisterStats    — per-register performance stats (manager+)
     mtRecordTillEvent     — log a floor event (cashier+)
================================================================ */
'use strict';

const { HttpsError } = require('firebase-functions/v2/https');
const logger         = require('firebase-functions/logger');
const admin          = require('firebase-admin');

function _db()  { return admin.firestore(); }
function _now() { return admin.firestore.FieldValue.serverTimestamp(); }

function _auth(req) {
  if (!req.auth?.uid) throw new HttpsError('unauthenticated', 'Authentication required.');
  return req.auth;
}

function _isAdmin(req) {
  const t = req.auth?.token;
  return !!(t?.admin || t?.superAdmin);
}

function _isManager(req) {
  const t = req.auth?.token;
  return !!(t?.admin || t?.superAdmin || t?.manager || t?.supervisor);
}

const _san = (v, max = 128) =>
  typeof v === 'string' ? v.replace(/[<>"'&]/g, '').slice(0, max) : '';

const VALID_STATUSES = new Set(['active', 'inactive', 'maintenance']);
const VALID_EVENT_TYPES = new Set([
  'till_open', 'till_close', 'cashier_login', 'cashier_logout',
  'printer_error', 'scanner_error', 'drawer_error', 'network_lost',
  'network_restored', 'supervisor_override', 'void', 'refund', 'suspicious_activity',
]);

/* ════════════════════════════════════════════════════════════════════
   mtRegisterCreate — create a new register (admin only)
════════════════════════════════════════════════════════════════════ */
async function mtRegisterCreate(req) {
  _auth(req);
  if (!_isAdmin(req)) throw new HttpsError('permission-denied', 'Admin access required.');

  const { merchantId, branchId, registerId, registerName, devices = {} } = req.data || {};
  if (!merchantId || !registerId || !registerName)
    throw new HttpsError('invalid-argument', 'merchantId, registerId, and registerName are required.');

  const docId = `${_san(merchantId, 64)}_${_san(registerId, 32)}`;

  const existing = await _db().collection('posRegisters').doc(docId).get();
  if (existing.exists) throw new HttpsError('already-exists', `Register "${registerId}" already exists.`);

  const doc = {
    registerId:    _san(registerId,    32),
    registerName:  _san(registerName, 128),
    merchantId:    _san(merchantId,    64),
    branchId:      _san(branchId || 'default', 64),
    status:        'active',
    assignedCashierId:   null,
    assignedCashierName: null,
    assignedManagerId:   null,
    devices: {
      printer:     devices.printer     || null,
      cashDrawer:  devices.cashDrawer  || null,
      scanner:     devices.scanner     || null,
      display:     devices.display     || null,
      terminal:    devices.terminal    || null,
    },
    createdBy:  req.auth.uid,
    createdAt:  _now(),
    updatedAt:  _now(),
  };

  await _db().collection('posRegisters').doc(docId).set(doc);
  logger.info('[MultiTill] Register created', { docId, by: req.auth.uid });
  return { id: docId, registerId, ok: true };
}

/* ════════════════════════════════════════════════════════════════════
   mtRegisterUpdate — update register config (admin only)
════════════════════════════════════════════════════════════════════ */
async function mtRegisterUpdate(req) {
  _auth(req);
  if (!_isAdmin(req)) throw new HttpsError('permission-denied', 'Admin access required.');

  const { merchantId, registerId, patch } = req.data || {};
  if (!merchantId || !registerId || !patch)
    throw new HttpsError('invalid-argument', 'merchantId, registerId, and patch required.');

  const docId = `${_san(merchantId, 64)}_${_san(registerId, 32)}`;
  const snap  = await _db().collection('posRegisters').doc(docId).get();
  if (!snap.exists) throw new HttpsError('not-found', `Register "${registerId}" not found.`);

  const clean = { updatedAt: _now(), updatedBy: req.auth.uid };
  if (patch.registerName && typeof patch.registerName === 'string')
    clean.registerName = _san(patch.registerName, 128);
  if (patch.status && VALID_STATUSES.has(patch.status))
    clean.status = patch.status;
  if (patch.branchId)
    clean.branchId = _san(patch.branchId, 64);

  // Device assignment patch
  if (patch.devices && typeof patch.devices === 'object') {
    const existingDevices = snap.data().devices || {};
    clean.devices = { ...existingDevices };
    ['printer', 'cashDrawer', 'scanner', 'display', 'terminal'].forEach(k => {
      if (k in patch.devices) clean.devices[k] = patch.devices[k] || null;
    });
  }

  await _db().collection('posRegisters').doc(docId).update(clean);
  logger.info('[MultiTill] Register updated', { docId, by: req.auth.uid });
  return { ok: true };
}

/* ════════════════════════════════════════════════════════════════════
   mtRegisterDelete — soft-delete a register (admin only)
════════════════════════════════════════════════════════════════════ */
async function mtRegisterDelete(req) {
  _auth(req);
  if (!_isAdmin(req)) throw new HttpsError('permission-denied', 'Admin access required.');

  const { merchantId, registerId } = req.data || {};
  if (!merchantId || !registerId) throw new HttpsError('invalid-argument', 'merchantId and registerId required.');

  const docId = `${_san(merchantId, 64)}_${_san(registerId, 32)}`;
  await _db().collection('posRegisters').doc(docId).update({
    status:    'deleted',
    deletedBy: req.auth.uid,
    deletedAt: _now(),
    updatedAt: _now(),
  });

  logger.info('[MultiTill] Register deleted', { docId, by: req.auth.uid });
  return { ok: true };
}

/* ════════════════════════════════════════════════════════════════════
   mtRegisterList — list all registers for a merchant (manager+)
════════════════════════════════════════════════════════════════════ */
async function mtRegisterList(req) {
  _auth(req);
  if (!_isManager(req)) throw new HttpsError('permission-denied', 'Manager access required.');

  const { merchantId, branchId, includeInactive = false } = req.data || {};
  if (!merchantId) throw new HttpsError('invalid-argument', 'merchantId required.');

  let q = _db().collection('posRegisters').where('merchantId', '==', _san(merchantId, 64));
  if (branchId) q = q.where('branchId', '==', _san(branchId, 64));
  if (!includeInactive) q = q.where('status', 'in', ['active', 'inactive', 'maintenance']);

  const snap = await q.orderBy('registerName').get();
  return { registers: snap.docs.map(d => ({ id: d.id, ...d.data() })) };
}

/* ════════════════════════════════════════════════════════════════════
   mtRegisterAssign — assign (or unassign) a cashier to a register
════════════════════════════════════════════════════════════════════ */
async function mtRegisterAssign(req) {
  _auth(req);
  if (!_isManager(req)) throw new HttpsError('permission-denied', 'Manager access required.');

  const { merchantId, registerId, cashierId, cashierName, managerId } = req.data || {};
  if (!merchantId || !registerId) throw new HttpsError('invalid-argument', 'merchantId and registerId required.');

  const docId = `${_san(merchantId, 64)}_${_san(registerId, 32)}`;
  const snap  = await _db().collection('posRegisters').doc(docId).get();
  if (!snap.exists) throw new HttpsError('not-found', `Register "${registerId}" not found.`);

  await _db().collection('posRegisters').doc(docId).update({
    assignedCashierId:   cashierId   ? _san(cashierId, 64)   : null,
    assignedCashierName: cashierName ? _san(cashierName, 64) : null,
    assignedManagerId:   managerId   ? _san(managerId, 64)   : null,
    updatedAt:           _now(),
    updatedBy:           req.auth.uid,
  });

  logger.info('[MultiTill] Register assigned', { docId, cashierId, by: req.auth.uid });
  return { ok: true };
}

/* ════════════════════════════════════════════════════════════════════
   mtGetLiveFloor — all active till states (manager+)
   Note: till state is written directly by client SDK to posTillState.
   This CF provides a server-authoritative snapshot (useful for reporting,
   alerts, and clients without Firestore real-time access).
════════════════════════════════════════════════════════════════════ */
async function mtGetLiveFloor(req) {
  _auth(req);
  if (!_isManager(req)) throw new HttpsError('permission-denied', 'Manager access required.');

  const { merchantId, branchId, staleSec = 300 } = req.data || {};
  if (!merchantId) throw new HttpsError('invalid-argument', 'merchantId required.');

  const cutoffMs = Date.now() - (Number(staleSec) || 300) * 1000;
  let q = _db().collection('posTillState')
    .where('merchantId', '==', _san(merchantId, 64))
    .where('clientTs', '>=', cutoffMs);
  if (branchId) q = q.where('branchId', '==', _san(branchId, 64));

  const snap = await q.get();
  const tills = snap.docs.map(d => {
    const data = d.data();
    return {
      id:           d.id,
      registerId:   data.registerId,
      registerName: data.registerName,
      cashierName:  data.cashierName,
      currentState: data.currentState,
      cartTotal:    data.cartTotal || 0,
      cartItemCount: data.cartItemCount || 0,
      salesCount:   data.salesCount || 0,
      salesTotal:   data.salesTotal || 0,
      online:       data.online,
      printerStatus: data.printerStatus,
      lastSeen:     data.clientTs,
    };
  });

  return {
    tills,
    summary: {
      total:   tills.length,
      active:  tills.filter(t => t.currentState !== 'IDLE' && t.currentState !== 'OFFLINE').length,
      online:  tills.filter(t => t.online).length,
      offline: tills.filter(t => !t.online).length,
    },
  };
}

/* ════════════════════════════════════════════════════════════════════
   mtGetFloorSummary — aggregated KPIs for the store floor (manager+)
════════════════════════════════════════════════════════════════════ */
async function mtGetFloorSummary(req) {
  _auth(req);
  if (!_isManager(req)) throw new HttpsError('permission-denied', 'Manager access required.');

  const { merchantId, branchId } = req.data || {};
  if (!merchantId) throw new HttpsError('invalid-argument', 'merchantId required.');

  const now   = Date.now();
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const cutoff = today.getTime();

  // Active till states (last 5 min)
  let tq = _db().collection('posTillState')
    .where('merchantId', '==', _san(merchantId, 64))
    .where('clientTs', '>=', now - 300000);
  if (branchId) tq = tq.where('branchId', '==', _san(branchId, 64));
  const tillSnap = await tq.get();

  const tills = tillSnap.docs.map(d => d.data());
  const salesTotal  = tills.reduce((s, t) => s + (t.salesTotal  || 0), 0);
  const salesCount  = tills.reduce((s, t) => s + (t.salesCount  || 0), 0);
  const onlineTills = tills.filter(t => t.online).length;
  const activeTills = tills.filter(t => t.currentState !== 'IDLE' && t.currentState !== 'OFFLINE').length;

  // Top cashier by session sales
  const sorted = [...tills].sort((a, b) => (b.salesTotal || 0) - (a.salesTotal || 0));
  const topCashier = sorted[0] ? { name: sorted[0].cashierName, total: sorted[0].salesTotal } : null;

  return {
    activeTills,
    onlineTills,
    totalTills:    tills.length,
    sessionSales:  salesCount,
    sessionRevenue: salesTotal,
    topCashier,
    asOf:          now,
  };
}

/* ════════════════════════════════════════════════════════════════════
   mtGetRegisterStats — per-register performance report (manager+)
════════════════════════════════════════════════════════════════════ */
async function mtGetRegisterStats(req) {
  _auth(req);
  if (!_isManager(req)) throw new HttpsError('permission-denied', 'Manager access required.');

  const { merchantId, registerId, branchId, dateStr } = req.data || {};
  if (!merchantId || !registerId) throw new HttpsError('invalid-argument', 'merchantId and registerId required.');

  // Query pos sales for this register (by registerId field which gets added in v1.1)
  // For now: fall back to branchId + cashierName combination from session stats
  const regDocId = `${_san(merchantId, 64)}_${_san(registerId, 32)}`;
  const [regSnap, stateSnap] = await Promise.all([
    _db().collection('posRegisters').doc(regDocId).get(),
    _db().collection('posTillState').doc(regDocId).get(),
  ]);

  if (!regSnap.exists) throw new HttpsError('not-found', 'Register not found.');

  const config = regSnap.data();
  const state  = stateSnap.exists ? stateSnap.data() : {};

  return {
    config,
    live: {
      currentState: state.currentState || 'OFFLINE',
      cashierName:  state.cashierName  || null,
      salesCount:   state.salesCount   || 0,
      salesTotal:   state.salesTotal   || 0,
      online:       state.online       || false,
      lastSeen:     state.clientTs     || null,
      printerStatus: state.printerStatus || 'unknown',
      drawerStatus:  state.drawerStatus  || 'unknown',
    },
  };
}

/* ════════════════════════════════════════════════════════════════════
   mtRecordTillEvent — log a floor event (cashier+)
════════════════════════════════════════════════════════════════════ */
async function mtRecordTillEvent(req) {
  const auth = _auth(req);
  const { type, merchantId, branchId, registerId, cashierId, cashierName, note, severity = 'info' } = req.data || {};

  if (!VALID_EVENT_TYPES.has(type))
    throw new HttpsError('invalid-argument', `Unknown event type: "${type}".`);
  if (!merchantId || !registerId) throw new HttpsError('invalid-argument', 'merchantId and registerId required.');

  const doc = {
    type:        _san(type,        32),
    merchantId:  _san(merchantId,  64),
    branchId:    _san(branchId || 'default', 64),
    registerId:  _san(registerId,  32),
    uid:         auth.uid,
    cashierId:   _san(cashierId || auth.uid, 64),
    cashierName: _san(cashierName, 64),
    note:        _san(note || '',  256),
    severity:    ['info', 'warning', 'error'].includes(severity) ? severity : 'info',
    ts:          _now(),
    clientTs:    Date.now(),
  };

  const ref = await _db().collection('posTillEvents').add(doc);
  return { id: ref.id, ok: true };
}

exports._h = {
  mtRegisterCreate,
  mtRegisterUpdate,
  mtRegisterDelete,
  mtRegisterList,
  mtRegisterAssign,
  mtGetLiveFloor,
  mtGetFloorSummary,
  mtGetRegisterStats,
  mtRecordTillEvent,
};
