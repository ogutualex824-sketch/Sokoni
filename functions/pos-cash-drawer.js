/* ================================================================
   SOKONI SmartPOS — Cash Drawer Cloud Functions v1.0
   functions/pos-cash-drawer.js

   8 Cloud Functions providing server-side audit logging, config
   management, till event recording, and shift reconciliation for
   the universal cash drawer system.

   Collections:
     posDrawerLog/{id}       — one doc per drawer open/fail event
     posTillEvents/{id}      — cash in/out/safe drop/pickup/float events
     posDrawerConfig/{regId} — per-register drawer configuration

   Exports:
     cdOpenDrawer        — log a drawer event (auto or manual)
     cdGetAuditLog       — query drawer events (admin/manager)
     cdGetConfig         — get drawer config for a register
     cdSetConfig         — update drawer config (admin)
     cdRecordCashEvent   — record a till movement event
     cdGetShiftSummary   — shift cash summary + expected vs actual
     cdGetReconciliation — full shift reconciliation for end-of-day
     cdGetDiagnostics    — aggregated diagnostics (last open, error rate)
================================================================ */
'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const logger                 = require('firebase-functions/logger');
const admin                  = require('firebase-admin');

const REGION = 'us-central1';
const OPTS   = { region: REGION, enforceAppCheck: true };

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

const _safeCents = v => Math.max(0, Math.round(Number(v) || 0));

/* ── Valid event types ─────────────────────────────────────────────── */
const DRAWER_OPEN_TYPES = new Set([
  'sale', 'split_cash', 'manual', 'shift_open', 'shift_close',
  'refund', 'exchange', 'test',
]);
const TILL_EVENT_TYPES = new Set([
  'cash_in', 'cash_out', 'safe_drop', 'cash_pickup',
  'opening_float', 'closing_float',
]);

/* ════════════════════════════════════════════════════════════════════
   cdOpenDrawer — log a drawer open (or failed open) event
   Called by sokoni-cash-drawer.js after every open attempt.
   Does NOT control hardware — that is the client SDK's responsibility.
════════════════════════════════════════════════════════════════════ */
exports.cdOpenDrawer = onCall(OPTS, async (req) => {
  const auth = _auth(req);
  const {
    type = 'manual', outcome = 'success', error: errMsg = null,
    merchantId, branchId, registerId, cashierId, cashierName,
    role, reason, amount, receiptNo, shiftId, ts,
  } = req.data || {};

  if (!DRAWER_OPEN_TYPES.has(type))
    throw new HttpsError('invalid-argument', `Unknown drawer event type: "${type}".`);

  const doc = {
    type:        _san(type, 32),
    outcome:     outcome === 'success' ? 'success' : 'failed',
    error:       errMsg ? _san(errMsg, 256) : null,
    merchantId:  _san(merchantId, 64),
    branchId:    _san(branchId,   64),
    registerId:  _san(registerId, 64),
    uid:         auth.uid,
    cashierId:   _san(cashierId || auth.uid, 64),
    cashierName: _san(cashierName, 64),
    role:        _san(role, 32),
    reason:      _san(reason, 128),
    amount:      amount != null ? _safeCents(amount) : null,
    receiptNo:   _san(receiptNo, 32),
    shiftId:     _san(shiftId, 64),
    clientTs:    Number(ts) || Date.now(),
    serverTs:    _now(),
  };

  try {
    const ref = await _db().collection('posDrawerLog').add(doc);
    logger.info('[CashDrawer] Open logged', { id: ref.id, type, outcome, uid: auth.uid });
    return { id: ref.id, ok: true };
  } catch (err) {
    logger.error('[CashDrawer] Log failed', { err: err.message, uid: auth.uid });
    throw new HttpsError('internal', 'Failed to log drawer event.');
  }
});

/* ════════════════════════════════════════════════════════════════════
   cdGetAuditLog — query drawer open events (manager/admin only)
════════════════════════════════════════════════════════════════════ */
exports.cdGetAuditLog = onCall(OPTS, async (req) => {
  _auth(req);
  if (!_isManager(req)) throw new HttpsError('permission-denied', 'Manager access required.');

  const { merchantId, branchId, registerId, limit = 100, startAfterTs } = req.data || {};
  if (!merchantId) throw new HttpsError('invalid-argument', 'merchantId required.');

  let q = _db().collection('posDrawerLog')
    .where('merchantId', '==', _san(merchantId, 64))
    .orderBy('clientTs', 'desc')
    .limit(Math.min(Number(limit) || 100, 500));

  if (branchId)    q = q.where('branchId',    '==', _san(branchId, 64));
  if (registerId)  q = q.where('registerId',  '==', _san(registerId, 64));
  if (startAfterTs) q = q.startAfter(Number(startAfterTs));

  const snap = await q.get();
  return {
    events: snap.docs.map(d => ({ id: d.id, ...d.data(), serverTs: undefined })),
    count:  snap.size,
  };
});

/* ════════════════════════════════════════════════════════════════════
   cdGetConfig — get drawer config for a register
════════════════════════════════════════════════════════════════════ */
exports.cdGetConfig = onCall(OPTS, async (req) => {
  _auth(req);
  const { merchantId, registerId } = req.data || {};
  if (!merchantId || !registerId)
    throw new HttpsError('invalid-argument', 'merchantId and registerId required.');

  const docId = `${_san(merchantId, 64)}_${_san(registerId, 64)}`;
  const snap  = await _db().collection('posDrawerConfig').doc(docId).get();
  return snap.exists ? snap.data() : {
    openMode:       'after_receipt',
    connectionType: 'printer',
    drawerPin:      'pin2',
    requireManager: false,
    allowedRoles:   ['admin', 'superAdmin', 'manager', 'supervisor', 'cashier'],
    openOnCashOnly: true,
  };
});

/* ════════════════════════════════════════════════════════════════════
   cdSetConfig — update drawer config (admin only)
════════════════════════════════════════════════════════════════════ */
exports.cdSetConfig = onCall(OPTS, async (req) => {
  _auth(req);
  if (!_isAdmin(req)) throw new HttpsError('permission-denied', 'Admin access required.');

  const { merchantId, registerId, config } = req.data || {};
  if (!merchantId || !registerId || !config)
    throw new HttpsError('invalid-argument', 'merchantId, registerId, and config required.');

  const VALID_MODES  = ['after_payment', 'after_receipt', 'before_receipt', 'manual_only', 'never'];
  const VALID_CONN   = ['printer', 'usb', 'serial', 'ethernet', 'bluetooth'];
  const VALID_PINS   = ['pin2', 'pin5'];
  const VALID_ROLES  = ['admin', 'superAdmin', 'manager', 'supervisor', 'cashier'];

  const clean = {};
  if (config.openMode      && VALID_MODES.includes(config.openMode))         clean.openMode       = config.openMode;
  if (config.connectionType && VALID_CONN.includes(config.connectionType))   clean.connectionType = config.connectionType;
  if (config.drawerPin     && VALID_PINS.includes(config.drawerPin))         clean.drawerPin      = config.drawerPin;
  if (typeof config.requireManager === 'boolean')                            clean.requireManager = config.requireManager;
  if (typeof config.openOnCashOnly === 'boolean')                            clean.openOnCashOnly = config.openOnCashOnly;
  if (config.ethernetHost) clean.ethernetHost = _san(config.ethernetHost, 128);
  if (config.ethernetPort) clean.ethernetPort = Math.max(1, Math.min(65535, Number(config.ethernetPort) || 9100));
  if (Array.isArray(config.allowedRoles)) {
    clean.allowedRoles = config.allowedRoles.filter(r => VALID_ROLES.includes(r));
  }

  const docId = `${_san(merchantId, 64)}_${_san(registerId, 64)}`;
  await _db().collection('posDrawerConfig').doc(docId).set({
    ...clean,
    merchantId: _san(merchantId, 64),
    registerId: _san(registerId, 64),
    updatedBy:  req.auth.uid,
    updatedAt:  _now(),
  }, { merge: true });

  logger.info('[CashDrawer] Config updated', { merchantId, registerId, by: req.auth.uid });
  return { ok: true };
});

/* ════════════════════════════════════════════════════════════════════
   cdRecordCashEvent — log a till movement (cash in/out/safe drop/etc.)
   These events feed the shift reconciliation report.
════════════════════════════════════════════════════════════════════ */
exports.cdRecordCashEvent = onCall(OPTS, async (req) => {
  const auth = _auth(req);
  const {
    type, amount, merchantId, branchId, registerId,
    cashierId, cashierName, role, note, shiftId, ts,
  } = req.data || {};

  if (!TILL_EVENT_TYPES.has(type))
    throw new HttpsError('invalid-argument', `Unknown till event type: "${type}".`);

  const amtCents = _safeCents(amount);
  if (amtCents < 0) throw new HttpsError('invalid-argument', 'Amount must be non-negative.');

  const doc = {
    type:        _san(type, 32),
    amountCents: amtCents,
    merchantId:  _san(merchantId, 64),
    branchId:    _san(branchId,   64),
    registerId:  _san(registerId, 64),
    uid:         auth.uid,
    cashierId:   _san(cashierId || auth.uid, 64),
    cashierName: _san(cashierName, 64),
    role:        _san(role, 32),
    note:        _san(note || '', 256),
    shiftId:     _san(shiftId || '', 64),
    clientTs:    Number(ts) || Date.now(),
    serverTs:    _now(),
  };

  try {
    const ref = await _db().collection('posTillEvents').add(doc);
    logger.info('[CashDrawer] Till event recorded', { id: ref.id, type, amtCents, uid: auth.uid });
    return { id: ref.id, ok: true };
  } catch (err) {
    logger.error('[CashDrawer] Till event failed', { err: err.message });
    throw new HttpsError('internal', 'Failed to record till event.');
  }
});

/* ════════════════════════════════════════════════════════════════════
   cdGetShiftSummary — expected vs actual cash for a shift
════════════════════════════════════════════════════════════════════ */
exports.cdGetShiftSummary = onCall(OPTS, async (req) => {
  _auth(req);
  if (!_isManager(req)) throw new HttpsError('permission-denied', 'Manager access required.');

  const { merchantId, branchId, registerId, shiftId, closingFloat } = req.data || {};
  if (!merchantId) throw new HttpsError('invalid-argument', 'merchantId required.');

  let q = _db().collection('posTillEvents')
    .where('merchantId', '==', _san(merchantId, 64));
  if (branchId)   q = q.where('branchId',   '==', _san(branchId,   64));
  if (registerId) q = q.where('registerId', '==', _san(registerId, 64));
  if (shiftId)    q = q.where('shiftId',    '==', _san(shiftId,    64));

  const tillSnap = await q.get();
  const till = { openingFloat: 0, cashSales: 0, cashIn: 0, cashOut: 0, safeDrop: 0, cashPickup: 0 };
  tillSnap.forEach(d => {
    const { type, amountCents } = d.data();
    if (type === 'opening_float') till.openingFloat = amountCents;
    if (type === 'cash_in')       till.cashIn       += amountCents;
    if (type === 'cash_out')      till.cashOut      += amountCents;
    if (type === 'safe_drop')     till.safeDrop     += amountCents;
    if (type === 'cash_pickup')   till.cashPickup   += amountCents;
  });

  // Sum cash sales from posDrawerLog (type=sale, outcome=success)
  let dq = _db().collection('posDrawerLog')
    .where('merchantId', '==', _san(merchantId, 64))
    .where('type', '==', 'sale')
    .where('outcome', '==', 'success');
  if (branchId)   dq = dq.where('branchId',   '==', _san(branchId,   64));
  if (registerId) dq = dq.where('registerId', '==', _san(registerId, 64));
  if (shiftId)    dq = dq.where('shiftId',    '==', _san(shiftId,    64));
  const drawerSnap = await dq.get();
  drawerSnap.forEach(d => {
    const { amount } = d.data();
    if (amount) till.cashSales += _safeCents(amount);
  });

  const expectedCents = till.openingFloat + till.cashSales + till.cashIn
                      - till.cashOut - till.safeDrop + till.cashPickup;
  const actualCents   = closingFloat != null ? _safeCents(closingFloat) : null;
  const varianceCents = actualCents != null ? (actualCents - expectedCents) : null;

  return {
    ...till,
    expectedCents,
    actualCents,
    varianceCents,
    status: varianceCents != null
      ? (Math.abs(varianceCents) < 100 ? 'balanced' : varianceCents > 0 ? 'over' : 'short')
      : 'pending_close',
  };
});

/* ════════════════════════════════════════════════════════════════════
   cdGetReconciliation — full end-of-day reconciliation with per-event detail
════════════════════════════════════════════════════════════════════ */
exports.cdGetReconciliation = onCall(OPTS, async (req) => {
  _auth(req);
  if (!_isManager(req)) throw new HttpsError('permission-denied', 'Manager access required.');

  const { merchantId, branchId, registerId, shiftId, dateStr } = req.data || {};
  if (!merchantId) throw new HttpsError('invalid-argument', 'merchantId required.');

  // Fetch all till events and drawer opens for this shift/date
  const [tillSnap, drawerSnap] = await Promise.all([
    (async () => {
      let q = _db().collection('posTillEvents').where('merchantId', '==', _san(merchantId, 64));
      if (branchId)   q = q.where('branchId',   '==', _san(branchId,   64));
      if (registerId) q = q.where('registerId', '==', _san(registerId, 64));
      if (shiftId)    q = q.where('shiftId',    '==', _san(shiftId,    64));
      return q.orderBy('clientTs', 'asc').limit(1000).get();
    })(),
    (async () => {
      let q = _db().collection('posDrawerLog').where('merchantId', '==', _san(merchantId, 64));
      if (branchId)   q = q.where('branchId',   '==', _san(branchId,   64));
      if (registerId) q = q.where('registerId', '==', _san(registerId, 64));
      if (shiftId)    q = q.where('shiftId',    '==', _san(shiftId,    64));
      return q.orderBy('clientTs', 'asc').limit(1000).get();
    })(),
  ]);

  const tillEvents   = tillSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  const drawerEvents = drawerSnap.docs.map(d => ({ id: d.id, ...d.data() }));

  const openCount   = drawerEvents.filter(e => e.outcome === 'success').length;
  const failCount   = drawerEvents.filter(e => e.outcome === 'failed').length;
  const manualCount = drawerEvents.filter(e => e.type === 'manual' && e.outcome === 'success').length;

  return {
    till:        tillEvents,
    drawer:      drawerEvents,
    summary: {
      totalOpens:   openCount,
      failedOpens:  failCount,
      manualOpens:  manualCount,
      saleOpens:    openCount - manualCount,
    },
  };
});

/* ════════════════════════════════════════════════════════════════════
   cdGetDiagnostics — aggregated drawer health (last 24h)
════════════════════════════════════════════════════════════════════ */
exports.cdGetDiagnostics = onCall(OPTS, async (req) => {
  _auth(req);
  if (!_isAdmin(req)) throw new HttpsError('permission-denied', 'Admin access required.');

  const { merchantId, branchId, registerId } = req.data || {};
  if (!merchantId) throw new HttpsError('invalid-argument', 'merchantId required.');

  const since = Date.now() - 86400000; // 24h
  let q = _db().collection('posDrawerLog')
    .where('merchantId', '==', _san(merchantId, 64))
    .where('clientTs', '>=', since)
    .orderBy('clientTs', 'desc')
    .limit(200);
  if (branchId)   q = q.where('branchId',   '==', _san(branchId,   64));
  if (registerId) q = q.where('registerId', '==', _san(registerId, 64));

  const snap = await q.get();
  const events = snap.docs.map(d => d.data());

  const totalOpens = events.filter(e => e.outcome === 'success').length;
  const failedOpens = events.filter(e => e.outcome === 'failed').length;
  const lastSuccess = events.find(e => e.outcome === 'success')?.clientTs || null;
  const lastFailed  = events.find(e => e.outcome === 'failed')?.clientTs  || null;
  const errors      = events.filter(e => e.outcome === 'failed').slice(0, 10).map(e => ({
    ts: e.clientTs, type: e.type, error: e.error, cashier: e.cashierName,
  }));

  return {
    totalOpens24h:  totalOpens,
    failedOpens24h: failedOpens,
    successRate:    totalOpens + failedOpens > 0
      ? Math.round((totalOpens / (totalOpens + failedOpens)) * 100)
      : 100,
    lastSuccess,
    lastFailed,
    recentErrors:   errors,
  };
});
