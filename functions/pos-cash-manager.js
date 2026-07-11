/* ================================================================
   SOKONI SmartPOS — Cash Manager Cloud Functions v3.0
   functions/pos-cash-manager.js

   15 Cloud Functions covering the full enterprise cash lifecycle:
   event logging, session management, manager approval, live balance,
   shift reports, EOD reconciliation, drawer event logging, branch
   summaries, manager close approvals, and cashier performance.

   Collections:
     posCashSessions/{sessionId}    — shift sessions
     posCashEvents/{id}             — immutable event ledger
     posDrawerEvents/{id}           — immutable drawer open log
     posCloseApprovals/{id}         — manager close-approval requests

   Exports:
     cmRecordCashEvent       — log any cash event (universal)
     cmApproveFloat          — manager approval / float adjustment
     cmSafeDrop              — formal safe-drop with optional approval
     cmGetLiveTillBalance    — server-side computed balance
     cmGetShiftReport        — full single-shift reconciliation
     cmGetEndOfDay           — EOD report across all tills
     cmGetAuditTrail         — paginated, filterable audit log
     cmGetManagerQueue       — pending approvals for managers
     cmApprovePendingEvent   — approve a pending safe drop / float
     cmGetCashierPerformance — per-cashier summary for a date range
     cmLogDrawerOpen         — immutable drawer event log
     cmGetDrawerHistory      — paginated drawer history per register
     cmGetBranchSummary      — cross-register branch reconciliation
     cmRequestCloseApproval  — cashier requests manager sign-off
     cmApproveRegisterClose  — manager approves / rejects close
================================================================ */
'use strict';

const { HttpsError } = require('firebase-functions/v2/https');
const logger         = require('firebase-functions/logger');
const admin          = require('firebase-admin');

const db  = () => admin.firestore();
const now = () => admin.firestore.FieldValue.serverTimestamp();

/* ── Auth helpers ──────────────────────────────────────────────── */
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
function _isCashier(req) {
  const t = req.auth?.token;
  return !!(t?.admin || t?.superAdmin || t?.manager || t?.supervisor || t?.cashier);
}

/* ── Sanitisation ─────────────────────────────────────────────── */
const _san = (v, max = 128) =>
  typeof v === 'string' ? v.replace(/[<>"'&]/g, '').slice(0, max) : '';
const _cents = v => Math.max(0, Math.round(Number(v) || 0));

/* ── Valid event types ─────────────────────────────────────────── */
const VALID_TYPES = new Set([
  'register_open','register_close','cash_sale','cash_refund',
  'cash_in','cash_out','safe_drop','cash_pickup','float_adjustment',
]);

const VALID_IN_CATS  = new Set(['float_topup','petty_cash_return','bank_change','misc_deposit','other']);
const VALID_OUT_CATS = new Set(['petty_cash','supplier_payment','safe_drop','bank_deposit','emergency','other']);

/* ── Balance computation (mirrors client) ─────────────────────── */
function _computeBalance(events, openingFloatCents = 0) {
  let cashSales = 0, cashRefunds = 0, cashIn = 0, cashOut = 0,
      safeDrops = 0, cashPickups = 0, adjustments = 0;

  for (const ev of events) {
    switch (ev.type) {
      case 'cash_sale':       cashSales    += ev.amountCents || 0; break;
      case 'cash_refund':     cashRefunds  += ev.amountCents || 0; break;
      case 'cash_in':         cashIn       += ev.amountCents || 0; break;
      case 'cash_out':        cashOut      += ev.amountCents || 0; break;
      case 'safe_drop':       safeDrops    += ev.amountCents || 0; break;
      case 'cash_pickup':     cashPickups  += ev.amountCents || 0; break;
      case 'float_adjustment':adjustments  += ev.adjustmentCents || 0; break;
    }
  }
  const expected = openingFloatCents + cashSales - cashRefunds
                 + cashIn - cashOut - safeDrops - cashPickups + adjustments;
  return { openingFloatCents, cashSales, cashRefunds, cashIn,
           cashOut, safeDrops, cashPickups, adjustments, expected };
}

/* ════════════════════════════════════════════════════════════════
   cmRecordCashEvent — universal event logger (all event types)
   Called by the client SDK queue for offline sync + real-time.
════════════════════════════════════════════════════════════════ */
async function cmRecordCashEvent(req) {
  const auth = _auth(req);
  if (!_isCashier(req)) throw new HttpsError('permission-denied', 'Cashier access required.');

  const {
    type, shiftId, registerId, merchantId, branchId,
    cashierId, cashierName, amountCents, adjustmentCents,
    reason, note, category, safeLocation, witness,
    transactionRef, approvedBy, openingDenoms, countedDenoms,
    varianceExplanation, expectedCents, varianceCents,
    devices, clientTs,
  } = req.data || {};

  if (!VALID_TYPES.has(type)) throw new HttpsError('invalid-argument', `Unknown event type: "${type}"`);
  if (!merchantId || !shiftId) throw new HttpsError('invalid-argument', 'merchantId and shiftId required.');

  // Category validation for cash in/out
  if (type === 'cash_in'  && category && !VALID_IN_CATS.has(category))
    throw new HttpsError('invalid-argument', 'Invalid cash_in category.');
  if (type === 'cash_out' && category && !VALID_OUT_CATS.has(category))
    throw new HttpsError('invalid-argument', 'Invalid cash_out category.');

  const doc = {
    type:                _san(type, 32),
    shiftId:             _san(shiftId, 128),
    registerId:          _san(registerId || '', 32),
    merchantId:          _san(merchantId, 64),
    branchId:            _san(branchId || 'default', 64),
    cashierId:           _san(cashierId || auth.uid, 64),
    cashierName:         _san(cashierName || '', 64),
    amountCents:         _cents(amountCents),
    adjustmentCents:     Math.round(Number(adjustmentCents) || 0),
    reason:              _san(reason || '', 256),
    note:                _san(note || '', 256),
    category:            _san(category || '', 64),
    safeLocation:        _san(safeLocation || '', 128),
    witness:             _san(witness || '', 64),
    transactionRef:      _san(transactionRef || '', 64),
    approvedBy:          _san(approvedBy || '', 64),
    openingDenoms:       openingDenoms && typeof openingDenoms === 'object' ? openingDenoms : null,
    countedDenoms:       countedDenoms && typeof countedDenoms === 'object' ? countedDenoms : null,
    varianceExplanation: _san(varianceExplanation || '', 512),
    expectedCents:       _cents(expectedCents),
    varianceCents:       Math.round(Number(varianceCents) || 0),
    devices:             devices && typeof devices === 'object' ? devices : null,
    uid:                 auth.uid,
    ts:                  now(),
    clientTs:            Number(clientTs) || Date.now(),
  };

  const ref = await db().collection('posCashEvents').add(doc);

  // Update session document
  if (type === 'register_open') {
    const sessionId = `${_san(merchantId,64)}_${_san(registerId||'',32)}`;
    await db().collection('posCashSessions').doc(sessionId).set({
      shiftId:             doc.shiftId,
      registerId:          doc.registerId,
      merchantId:          doc.merchantId,
      branchId:            doc.branchId,
      cashierId:           doc.cashierId,
      cashierName:         doc.cashierName,
      openingFloatCents:   doc.amountCents,
      openingDenoms:       doc.openingDenoms,
      devices:             doc.devices,
      approvedBy:          doc.approvedBy,
      openedAt:            now(),
      status:              'open',
      updatedAt:           now(),
    }, { merge: true }); /* merge:true preserves data from crashes/interrupted closes */
  }

  if (type === 'register_close') {
    const sessionId = `${_san(merchantId,64)}_${_san(registerId||'',32)}`;
    await db().collection('posCashSessions').doc(sessionId).update({
      status:              'closed',
      closedAt:            now(),
      closingCountedCents: doc.amountCents,
      closingDenoms:       doc.countedDenoms,
      varianceCents:       doc.varianceCents,
      expectedCents:       doc.expectedCents,
      varianceExplanation: doc.varianceExplanation,
      approvedBy:          doc.approvedBy,
      updatedAt:           now(),
    });
  }

  logger.info('[CashMgr] event recorded', { type, shiftId, merchantId, by: auth.uid });
  return { id: ref.id, ok: true };
}

/* ════════════════════════════════════════════════════════════════
   cmApproveFloat — manager approves or adjusts the opening float
════════════════════════════════════════════════════════════════ */
async function cmApproveFloat(req) {
  _auth(req);
  if (!_isManager(req)) throw new HttpsError('permission-denied', 'Manager access required.');

  const { registerId, merchantId, approvedFloatCents, adjustmentCents, note = '' } = req.data || {};
  if (!merchantId || !registerId) throw new HttpsError('invalid-argument', 'merchantId and registerId required.');

  const sessionId = `${_san(merchantId,64)}_${_san(registerId,32)}`;
  const snap = await db().collection('posCashSessions').doc(sessionId).get();
  if (!snap.exists) throw new HttpsError('not-found', 'Session not found.');

  const data = snap.data();
  const newFloat = _cents(approvedFloatCents ?? data.openingFloatCents) +
                   Math.round(Number(adjustmentCents) || 0);

  await db().collection('posCashSessions').doc(sessionId).update({
    openingFloatCents: Math.max(0, newFloat),
    approvedBy:        req.auth.uid,
    approvedAt:        now(),
    updatedAt:         now(),
  });

  // Log the adjustment
  if (adjustmentCents) {
    await db().collection('posCashEvents').add({
      type: 'float_adjustment', shiftId: data.shiftId,
      registerId: data.registerId, merchantId: data.merchantId,
      branchId: data.branchId, cashierId: data.cashierId, cashierName: data.cashierName,
      adjustmentCents: Math.round(Number(adjustmentCents) || 0),
      amountCents: 0, approvedBy: req.auth.uid,
      note: _san(note, 256), uid: req.auth.uid, ts: now(), clientTs: Date.now(),
    });
  }

  return { ok: true, newFloat };
}

/* ════════════════════════════════════════════════════════════════
   cmSafeDrop — formal safe drop with optional manager approval
════════════════════════════════════════════════════════════════ */
async function cmSafeDrop(req) {
  const auth = _auth(req);
  if (!_isCashier(req)) throw new HttpsError('permission-denied', 'Cashier access required.');

  const {
    merchantId, registerId, shiftId, cashierId, cashierName,
    amountCents, safeLocation, witness, note = '', requiresApproval = false,
  } = req.data || {};

  if (!merchantId || !shiftId || !amountCents)
    throw new HttpsError('invalid-argument', 'merchantId, shiftId, amountCents required.');

  const cents = _cents(amountCents);
  if (cents <= 0) throw new HttpsError('invalid-argument', 'Amount must be > 0.');

  const doc = {
    type: 'safe_drop', shiftId: _san(shiftId, 128),
    registerId: _san(registerId || '', 32), merchantId: _san(merchantId, 64),
    cashierId: _san(cashierId || auth.uid, 64), cashierName: _san(cashierName || '', 64),
    amountCents: cents,
    safeLocation: _san(safeLocation || '', 128),
    witness: _san(witness || '', 64),
    note: _san(note, 256), uid: auth.uid,
    approvalRequired: requiresApproval, approved: !requiresApproval,
    ts: now(), clientTs: Date.now(),
  };

  const ref = await db().collection('posCashEvents').add(doc);
  logger.info('[CashMgr] safe_drop recorded', { shiftId, amountCents: cents });
  return { id: ref.id, ok: true, requiresApproval };
}

/* ════════════════════════════════════════════════════════════════
   cmGetLiveTillBalance — server-computed balance from events
════════════════════════════════════════════════════════════════ */
async function cmGetLiveTillBalance(req) {
  _auth(req);
  if (!_isManager(req)) throw new HttpsError('permission-denied', 'Manager access required.');

  const { merchantId, registerId, shiftId } = req.data || {};
  if (!merchantId || !shiftId) throw new HttpsError('invalid-argument', 'merchantId and shiftId required.');

  let q = db().collection('posCashEvents')
    .where('merchantId', '==', _san(merchantId, 64))
    .where('shiftId',    '==', _san(shiftId, 128));
  if (registerId) q = q.where('registerId', '==', _san(registerId, 32));
  q = q.orderBy('ts').limit(2000);

  const snap  = await q.get();
  const evts  = snap.docs.map(d => d.data());
  const open  = evts.find(e => e.type === 'register_open');
  const bal   = _computeBalance(evts, open?.amountCents || 0);

  return { balance: bal, eventCount: evts.length, asOf: Date.now() };
}

/* ════════════════════════════════════════════════════════════════
   cmGetShiftReport — full reconciliation for a single shift
════════════════════════════════════════════════════════════════ */
async function cmGetShiftReport(req) {
  _auth(req);
  if (!_isManager(req)) throw new HttpsError('permission-denied', 'Manager access required.');

  const { shiftId, merchantId } = req.data || {};
  if (!shiftId || !merchantId) throw new HttpsError('invalid-argument', 'shiftId and merchantId required.');

  const snap = await db().collection('posCashEvents')
    .where('merchantId', '==', _san(merchantId, 64))
    .where('shiftId',    '==', _san(shiftId, 128))
    .orderBy('ts')
    .get();

  const events  = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  const openEv  = events.find(e => e.type === 'register_open');
  const closeEv = events.find(e => e.type === 'register_close');
  const bal     = _computeBalance(events, openEv?.amountCents || 0);

  return {
    shiftId,
    registerId:    openEv?.registerId,
    cashierId:     openEv?.cashierId,
    cashierName:   openEv?.cashierName,
    openedAt:      openEv?.clientTs,
    closedAt:      closeEv?.clientTs,
    status:        closeEv ? 'closed' : 'open',
    balance:       bal,
    variance:      closeEv ? {
      varianceCents: closeEv.varianceCents,
      varianceKES:   (closeEv.varianceCents || 0) / 100,
      status:        closeEv.varianceCents === 0 ? 'balanced'
                   : closeEv.varianceCents  > 0  ? 'over' : 'short',
      explanation:   closeEv.varianceExplanation || '',
    } : null,
    events,
    eventCount:    events.length,
  };
}

/* ════════════════════════════════════════════════════════════════
   cmGetEndOfDay — cross-till EOD reconciliation report
════════════════════════════════════════════════════════════════ */
async function cmGetEndOfDay(req) {
  _auth(req);
  if (!_isManager(req)) throw new HttpsError('permission-denied', 'Manager access required.');

  const { merchantId, branchId, dateStr } = req.data || {};
  if (!merchantId) throw new HttpsError('invalid-argument', 'merchantId required.');

  // dateStr: 'YYYY-MM-DD'; default = today Kenya time
  const tz     = 'Africa/Nairobi';
  const target = dateStr || new Date().toLocaleDateString('en-CA', { timeZone: tz });
  const [y, m, d] = target.split('-').map(Number);
  const dayStart  = new Date(Date.UTC(y, m - 1, d, -3, 0, 0)).getTime();   // midnight EAT = UTC-3
  const dayEnd    = dayStart + 86400000;

  let q = db().collection('posCashEvents')
    .where('merchantId', '==', _san(merchantId, 64))
    .where('clientTs',   '>=', dayStart)
    .where('clientTs',   '<',  dayEnd);
  if (branchId) q = q.where('branchId', '==', _san(branchId, 64));
  q = q.orderBy('clientTs');

  const snap   = await q.get();
  const events = snap.docs.map(d => ({ id: d.id, ...d.data() }));

  // Group by register
  const byReg = {};
  for (const ev of events) {
    if (!byReg[ev.registerId]) byReg[ev.registerId] = [];
    byReg[ev.registerId].push(ev);
  }

  const tills = [];
  let totCashSales = 0, totCashRefunds = 0, totSafeDrops = 0, totVariance = 0;

  for (const [regId, evts] of Object.entries(byReg)) {
    const openEv  = evts.find(e => e.type === 'register_open');
    const closeEv = evts.find(e => e.type === 'register_close');
    const bal     = _computeBalance(evts, openEv?.amountCents || 0);
    totCashSales   += bal.cashSales;
    totCashRefunds += bal.cashRefunds;
    totSafeDrops   += bal.safeDrops;
    totVariance    += closeEv?.varianceCents || 0;
    tills.push({
      registerId: regId,
      cashierName: openEv?.cashierName || '—',
      balance: bal,
      closed: !!closeEv,
      varianceCents: closeEv?.varianceCents || 0,
    });
  }

  return {
    date:     target,
    branchId: branchId || 'all',
    tills,
    summary: {
      totalCashSales:   totCashSales,
      totalCashRefunds: totCashRefunds,
      totalSafeDrops:   totSafeDrops,
      totalVariance:    totVariance,
      tillCount:        tills.length,
      closedCount:      tills.filter(t => t.closed).length,
    },
    eventCount: events.length,
    asOf: Date.now(),
  };
}

/* ════════════════════════════════════════════════════════════════
   cmGetAuditTrail — paginated, filterable immutable audit log
════════════════════════════════════════════════════════════════ */
async function cmGetAuditTrail(req) {
  _auth(req);
  if (!_isManager(req)) throw new HttpsError('permission-denied', 'Manager access required.');

  const {
    merchantId, registerId, cashierId, type, dateFrom, dateTo, limit = 50,
  } = req.data || {};
  if (!merchantId) throw new HttpsError('invalid-argument', 'merchantId required.');

  let q = db().collection('posCashEvents')
    .where('merchantId', '==', _san(merchantId, 64));

  if (registerId) q = q.where('registerId', '==', _san(registerId, 32));
  if (cashierId)  q = q.where('cashierId',  '==', _san(cashierId,  64));
  if (type && VALID_TYPES.has(type)) q = q.where('type', '==', type);
  if (dateFrom)   q = q.where('clientTs',   '>=', Number(dateFrom));
  if (dateTo)     q = q.where('clientTs',   '<=', Number(dateTo));

  q = q.orderBy('clientTs', 'desc').limit(Math.min(Number(limit) || 50, 500));
  const snap = await q.get();

  return {
    events:     snap.docs.map(d => ({ id: d.id, ...d.data() })),
    count:      snap.size,
    hasMore:    snap.size === Math.min(Number(limit) || 50, 500),
  };
}

/* ════════════════════════════════════════════════════════════════
   cmGetManagerQueue — pending float/safe-drop approvals
════════════════════════════════════════════════════════════════ */
async function cmGetManagerQueue(req) {
  _auth(req);
  if (!_isManager(req)) throw new HttpsError('permission-denied', 'Manager access required.');

  const { merchantId } = req.data || {};
  if (!merchantId) throw new HttpsError('invalid-argument', 'merchantId required.');

  const snap = await db().collection('posCashEvents')
    .where('merchantId',      '==', _san(merchantId, 64))
    .where('approvalRequired','==', true)
    .where('approved',        '==', false)
    .orderBy('ts', 'desc')
    .limit(50)
    .get();

  return { items: snap.docs.map(d => ({ id: d.id, ...d.data() })), count: snap.size };
}

/* ════════════════════════════════════════════════════════════════
   cmApprovePendingEvent — manager approves a pending safe drop / float
════════════════════════════════════════════════════════════════ */
async function cmApprovePendingEvent(req) {
  _auth(req);
  if (!_isManager(req)) throw new HttpsError('permission-denied', 'Manager access required.');

  const { eventId, merchantId, note = '' } = req.data || {};
  if (!eventId || !merchantId) throw new HttpsError('invalid-argument', 'eventId and merchantId required.');

  const ref  = db().collection('posCashEvents').doc(_san(eventId, 128));
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Event not found.');

  const data = snap.data();
  if (data.merchantId !== _san(merchantId, 64))
    throw new HttpsError('permission-denied', 'Cross-merchant access denied.');
  if (!data.approvalRequired)
    throw new HttpsError('failed-precondition', 'Event does not require approval.');
  if (data.approved)
    throw new HttpsError('already-exists', 'Event already approved.');

  await ref.update({
    approved:   true,
    approvedBy: req.auth.uid,
    approvedAt: now(),
    approvalNote: _san(note, 256),
  });

  logger.info('[CashMgr] event approved', { eventId, by: req.auth.uid });
  return { ok: true };
}

/* ════════════════════════════════════════════════════════════════
   cmGetCashierPerformance — per-cashier summary for a date range
════════════════════════════════════════════════════════════════ */
async function cmGetCashierPerformance(req) {
  _auth(req);
  if (!_isManager(req)) throw new HttpsError('permission-denied', 'Manager access required.');

  const { merchantId, branchId, dateFrom, dateTo } = req.data || {};
  if (!merchantId) throw new HttpsError('invalid-argument', 'merchantId required.');

  let q = db().collection('posCashEvents')
    .where('merchantId', '==', _san(merchantId, 64));
  if (branchId)  q = q.where('branchId',  '==', _san(branchId, 64));
  if (dateFrom)  q = q.where('clientTs',  '>=', Number(dateFrom));
  if (dateTo)    q = q.where('clientTs',  '<=', Number(dateTo));
  q = q.orderBy('clientTs').limit(5000);

  const snap      = await q.get();
  const truncated = snap.size === 5000;
  const events    = snap.docs.map(d => d.data());

  const cashiers = {};
  for (const ev of events) {
    const key  = ev.cashierId || ev.uid || 'unknown';
    const name = ev.cashierName || key;
    if (!cashiers[key]) cashiers[key] = {
      cashierId: key, cashierName: name, registerId: ev.registerId,
      cashSales: 0, cashRefunds: 0, cashIn: 0, cashOut: 0,
      safeDrops: 0, registerOpens: 0, registerCloses: 0,
      variance: 0, sessionCount: 0,
    };
    const c = cashiers[key];
    switch (ev.type) {
      case 'cash_sale':      c.cashSales    += ev.amountCents || 0; break;
      case 'cash_refund':    c.cashRefunds  += ev.amountCents || 0; break;
      case 'cash_in':        c.cashIn       += ev.amountCents || 0; break;
      case 'cash_out':       c.cashOut      += ev.amountCents || 0; break;
      case 'safe_drop':      c.safeDrops    += ev.amountCents || 0; break;
      case 'register_open':  c.registerOpens++; c.sessionCount++; break;
      case 'register_close': c.registerCloses++; c.variance += (ev.varianceCents || 0); break;
    }
  }

  return {
    cashiers: Object.values(cashiers).sort((a, b) => b.cashSales - a.cashSales),
    eventCount: events.length,
    truncated,
    asOf: Date.now(),
  };
}

/* ════════════════════════════════════════════════════════════════
   cmLogDrawerOpen — immutable drawer-open event record
   Called client-side after every auto or manual drawer open.
════════════════════════════════════════════════════════════════ */
const VALID_DRAWER_REASONS = new Set([
  'payment','refund','exchange','safe_drop','cash_in','cash_out',
  'register_open','register_close','manual','pickup','test',
]);

async function cmLogDrawerOpen(req) {
  _auth(req);
  const { merchantId, registerId, reason, deviceId = '', branch = '', role = 'cashier' } = req.data || {};
  if (!merchantId || !registerId) throw new HttpsError('invalid-argument', 'merchantId and registerId required.');
  if (!VALID_DRAWER_REASONS.has(reason)) throw new HttpsError('invalid-argument', `Invalid reason. Valid: ${[...VALID_DRAWER_REASONS].join(', ')}`);

  const rnd = Math.random().toString(36).slice(2, 7);
  const id  = `drevt_${_san(merchantId,32)}_${_san(registerId,32)}_${Date.now()}_${rnd}`;
  await db().collection('posDrawerEvents').doc(id).set({
    id,
    merchantId:  _san(merchantId, 64),
    registerId:  _san(registerId, 64),
    userId:      req.auth.uid,
    userName:    _san(req.auth.token?.name || 'Unknown', 128),
    role:        _san(role, 32),
    reason,
    deviceId:    _san(deviceId, 128),
    branch:      _san(branch, 128),
    ts:          Date.now(),
    createdAt:   now(),
  });
  logger.info('[CashMgr] drawer opened', { merchantId, registerId, reason, uid: req.auth.uid });
  return { ok: true, id };
}

/* ════════════════════════════════════════════════════════════════
   cmGetDrawerHistory — paginated drawer events per register
════════════════════════════════════════════════════════════════ */
async function cmGetDrawerHistory(req) {
  _auth(req);
  const { merchantId, registerId, limitN = 100, before } = req.data || {};
  if (!merchantId) throw new HttpsError('invalid-argument', 'merchantId required.');

  let q = db().collection('posDrawerEvents')
    .where('merchantId', '==', _san(merchantId, 64))
    .orderBy('ts', 'desc')
    .limit(Math.min(Number(limitN) || 100, 500));
  if (registerId) q = q.where('registerId', '==', _san(registerId, 64));
  if (before)     q = q.startAfter(Number(before));

  const snap = await q.get();
  return { events: snap.docs.map(d => d.data()), count: snap.size };
}

/* ════════════════════════════════════════════════════════════════
   cmGetBranchSummary — cross-register reconciliation for a branch
════════════════════════════════════════════════════════════════ */
async function cmGetBranchSummary(req) {
  _auth(req);
  if (!_isManager(req)) throw new HttpsError('permission-denied', 'Manager access required.');

  const { merchantId, branch = '', date } = req.data || {};
  if (!merchantId || !date) throw new HttpsError('invalid-argument', 'merchantId and date required.');

  /* Use EAT (UTC+3) midnight to match cmGetEndOfDay day boundaries */
  const [y, m, d2] = date.split('-').map(Number);
  const dayStart = new Date(Date.UTC(y, m - 1, d2, -3, 0, 0)).getTime();
  const dayEnd   = new Date(Date.UTC(y, m - 1, d2, 20, 59, 59, 999)).getTime();
  const LIMIT    = 10000;

  let q = db().collection('posCashEvents')
    .where('merchantId', '==', _san(merchantId, 64))
    .where('clientTs',   '>=', dayStart)
    .where('clientTs',   '<=', dayEnd);
  if (branch) q = q.where('branchId', '==', _san(branch, 128)); /* push filter into query */
  q = q.limit(LIMIT);

  const snap     = await q.get();
  const truncated = snap.size === LIMIT;
  const registers = {};

  for (const doc of snap.docs) {
    const ev = doc.data();
    const rid = ev.registerId || 'unknown';
    if (!registers[rid]) registers[rid] = {
      registerId: rid, branch: ev.branchId || '', cashierName: ev.cashierName || '',
      openingFloat: 0, cashSales: 0, cashRefunds: 0,
      cashIn: 0, cashOut: 0, safeDrops: 0, adjustments: 0,
      drawerOpens: 0, variance: null, status: 'open',
    };
    const r = registers[rid];
    const amt = ev.amountCents || 0;
    switch (ev.type) {
      case 'register_open':    r.openingFloat += amt; r.drawerOpens++; break;
      case 'cash_sale':        r.cashSales    += amt; break;
      case 'cash_refund':      r.cashRefunds  += amt; break;
      case 'cash_in':          r.cashIn       += amt; break;
      case 'cash_out':         r.cashOut      += amt; break;
      case 'safe_drop':        r.safeDrops    += amt; break;
      case 'float_adjustment': r.adjustments  += amt; break;
      case 'register_close':   r.variance = ev.varianceCents || 0; r.status = 'closed'; break;
    }
  }

  const rows = Object.values(registers).map(r => ({
    ...r,
    expected: r.openingFloat + r.cashSales - r.cashRefunds + r.cashIn - r.cashOut - r.safeDrops + r.adjustments,
  }));

  const tot = (field) => rows.reduce((s, r) => s + (r[field] || 0), 0);
  return {
    branch: branch || 'All',
    date,
    registers: rows,
    truncated,
    totals: {
      openingFloat: tot('openingFloat'), cashSales: tot('cashSales'),
      cashRefunds: tot('cashRefunds'),   cashIn: tot('cashIn'),
      cashOut: tot('cashOut'),           safeDrops: tot('safeDrops'),
      expected: tot('expected'),         variance: tot('variance'),
      drawerOpens: tot('drawerOpens'),
    },
  };
}

/* ════════════════════════════════════════════════════════════════
   cmRequestCloseApproval — cashier submits close for manager sign-off
════════════════════════════════════════════════════════════════ */
async function cmRequestCloseApproval(req) {
  _auth(req);
  const { merchantId, registerId, countedCents, varianceCents, varianceExplanation = '' } = req.data || {};
  if (!merchantId || !registerId) throw new HttpsError('invalid-argument', 'merchantId and registerId required.');

  /* Idempotency: return existing pending request if one already exists */
  const existing = await db().collection('posCloseApprovals')
    .where('merchantId', '==', _san(merchantId, 64))
    .where('registerId', '==', _san(registerId, 64))
    .where('status',     '==', 'pending')
    .limit(1)
    .get();
  if (!existing.empty) {
    const doc = existing.docs[0].data();
    return { ok: true, id: doc.id, reused: true };
  }

  const id  = `clappr_${_san(merchantId,32)}_${_san(registerId,32)}_${Date.now()}`;
  await db().collection('posCloseApprovals').doc(id).set({
    id,
    merchantId:          _san(merchantId, 64),
    registerId:          _san(registerId, 64),
    requestedBy:         req.auth.uid,
    requestedByName:     _san(req.auth.token?.name || 'Unknown', 128),
    countedCents:        _cents(countedCents),
    varianceCents:       Math.round(Number(varianceCents) || 0),
    varianceExplanation: _san(varianceExplanation, 512),
    status:      'pending',
    requestedAt: Date.now(),
    createdAt:   now(),
  });
  logger.info('[CashMgr] close approval requested', { merchantId, registerId, uid: req.auth.uid });
  return { ok: true, id };
}

/* ════════════════════════════════════════════════════════════════
   cmApproveRegisterClose — manager approves or rejects a close request
════════════════════════════════════════════════════════════════ */
async function cmApproveRegisterClose(req) {
  _auth(req);
  if (!_isManager(req)) throw new HttpsError('permission-denied', 'Manager access required.');

  const { approvalId, merchantId, approved = true, note = '' } = req.data || {};
  if (!approvalId || !merchantId) throw new HttpsError('invalid-argument', 'approvalId and merchantId required.');

  const ref  = db().collection('posCloseApprovals').doc(_san(approvalId, 128));
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Approval request not found.');

  const data = snap.data();
  if (data.merchantId !== _san(merchantId, 64)) throw new HttpsError('permission-denied', 'Merchant mismatch.');
  if (data.status !== 'pending')               throw new HttpsError('failed-precondition', 'Already processed.');

  await ref.update({
    status:        approved ? 'approved' : 'rejected',
    approvedBy:    req.auth.uid,
    approvedByName: _san(req.auth.token?.name || 'Unknown', 128),
    approvalNote:  _san(note, 256),
    processedAt:   Date.now(),
  });
  logger.info('[CashMgr] close approval processed', { approvalId, approved, by: req.auth.uid });
  return { ok: true, approved };
}

exports._h = {
  cmRecordCashEvent,
  cmApproveFloat,
  cmSafeDrop,
  cmGetLiveTillBalance,
  cmGetShiftReport,
  cmGetEndOfDay,
  cmGetAuditTrail,
  cmGetManagerQueue,
  cmApprovePendingEvent,
  cmGetCashierPerformance,
  cmLogDrawerOpen,
  cmGetDrawerHistory,
  cmGetBranchSummary,
  cmRequestCloseApproval,
  cmApproveRegisterClose,
};
