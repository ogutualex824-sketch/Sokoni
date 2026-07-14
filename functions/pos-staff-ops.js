'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const admin = require('firebase-admin');
if (!admin.apps.length) admin.initializeApp();

exports._h = {}; // handler registry — consumed by smartpos-dispatch.js
const db = admin.firestore();

const _CF = { region: 'us-central1', enforceAppCheck: true };
const _TS = () => admin.firestore.FieldValue.serverTimestamp();

function _requireAuth(req) {
  if (!req.auth) throw new HttpsError('unauthenticated', 'Login required');
  return req.auth;
}

function _requireRole(auth, minRole) {
  const levels = { cashier: 0, supervisor: 1, manager: 2, owner: 3 };
  const userLevel = levels[auth.token?.posRole || 'cashier'] ?? 0;
  const required = levels[minRole] ?? 0;
  if (userLevel < required)
    throw new HttpsError('permission-denied', `Requires ${minRole} role`);
}

function _requireSeller(data) {
  if (!data.sellerId || typeof data.sellerId !== 'string')
    throw new HttpsError('invalid-argument', 'sellerId is required');
  return data.sellerId;
}

function _today() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

function _currentMonth() {
  return new Date().toISOString().slice(0, 7); // YYYY-MM
}

/**
 * Safely converts a Firestore Timestamp or Date to a JS Date.
 */
function _toDate(val) {
  if (!val) return null;
  if (val.toDate) return val.toDate();
  if (val instanceof Date) return val;
  return new Date(val);
}

/**
 * Round a number to 2 decimal places.
 */
function _round2(n) {
  return Math.round(n * 100) / 100;
}

// ---------------------------------------------------------------------------
// A. SHIFT MANAGEMENT
// ---------------------------------------------------------------------------

/**
 * openShift — creates a new shift for the authenticated cashier.
 * Ensures no duplicate open shift exists for this cashier+seller.
 *
 * Input: { sellerId, openingCash, branchId, cashierName }
 */
exports.openShift = onCall(_CF, exports._h.openShift = async (req) => {
  const auth = _requireAuth(req);
  const { data } = req;
  const sellerId = _requireSeller(data);
  const cashierUid = auth.uid;
  const cashierName = data.cashierName || auth.token?.name || 'Unknown';
  const branchId = data.branchId || 'default';
  const openingCash = Number(data.openingCash ?? 0);

  if (isNaN(openingCash) || openingCash < 0)
    throw new HttpsError('invalid-argument', 'openingCash must be a non-negative number');

  // Check no open shift exists for this cashier+seller
  const existingSnap = await db.collection('posShifts')
    .where('sellerId', '==', sellerId)
    .where('cashierUid', '==', cashierUid)
    .where('status', '==', 'open')
    .limit(1)
    .get();

  if (!existingSnap.empty) {
    const existing = existingSnap.docs[0];
    throw new HttpsError('already-exists', `Shift already open: ${existing.id}`);
  }

  const shiftRef = db.collection('posShifts').doc();
  const shiftData = {
    sellerId,
    cashierUid,
    cashierName,
    branchId,
    status: 'open',
    openingCash,
    closingCash: null,
    openedAt: _TS(),
    closedAt: null,
    totalSales: 0,
    totalTransactions: 0,
    cashSales: 0,
    mpesaSales: 0,
    cardSales: 0,
    qrSales: 0,
    discountsGiven: 0,
    refundsGiven: 0,
    voidCount: 0,
    notes: data.notes || '',
    createdAt: _TS(),
    updatedAt: _TS(),
  };

  await shiftRef.set(shiftData);

  return { shiftId: shiftRef.id, message: 'Shift opened successfully', openingCash };
});

/**
 * closeShift — closes the authenticated cashier's open shift.
 * Aggregates all sales for this shift from posRetailSales.
 *
 * Input: { sellerId, closingCash, notes }
 */
exports.closeShift = onCall(_CF, exports._h.closeShift = async (req) => {
  const auth = _requireAuth(req);
  const { data } = req;
  const sellerId = _requireSeller(data);
  const cashierUid = auth.uid;
  const closingCash = Number(data.closingCash ?? 0);

  if (isNaN(closingCash) || closingCash < 0)
    throw new HttpsError('invalid-argument', 'closingCash must be a non-negative number');

  try {
  // Fetch the open shift
  const shiftSnap = await db.collection('posShifts')
    .where('sellerId', '==', sellerId)
    .where('cashierUid', '==', cashierUid)
    .where('status', '==', 'open')
    .limit(1)
    .get();

  if (shiftSnap.empty)
    throw new HttpsError('not-found', 'No open shift found for this cashier');

  const shiftDoc = shiftSnap.docs[0];
  const shiftId = shiftDoc.id;

  // Aggregate sales from posRetailSales for this shiftId
  const salesSnap = await db.collection('posRetailSales')
    .where('shiftId', '==', shiftId)
    .get();

  let totalSales = 0;
  let totalTransactions = 0;
  let cashSales = 0;
  let mpesaSales = 0;
  let cardSales = 0;
  let qrSales = 0;
  let discountsGiven = 0;
  let refundsGiven = 0;
  let voidCount = 0;

  for (const doc of salesSnap.docs) {
    const s = doc.data();
    if (s.status === 'voided') {
      voidCount++;
      continue;
    }
    if (s.status === 'refunded') {
      refundsGiven += Number(s.grandTotal || 0);
      continue;
    }
    const amount = Number(s.grandTotal || 0);
    totalSales += amount;
    totalTransactions++;
    discountsGiven += Number(s.discountTotal || 0);

    /* payments is an array of { method, amount } — aggregate by method */
    for (const p of (s.payments || [])) {
      const pm  = (p.method || '').toLowerCase();
      const amt = Number(p.amount || 0);
      if (pm === 'cash')                  cashSales  += amt;
      else if (pm === 'mpesa' || pm === 'm-pesa') mpesaSales += amt;
      else if (pm === 'card')             cardSales  += amt;
      else if (pm === 'qr')               qrSales    += amt;
    }
  }

  const summary = {
    status: 'closed',
    closingCash: _round2(closingCash),
    closedAt: _TS(),
    totalSales: _round2(totalSales),
    totalTransactions,
    cashSales: _round2(cashSales),
    mpesaSales: _round2(mpesaSales),
    cardSales: _round2(cardSales),
    qrSales: _round2(qrSales),
    discountsGiven: _round2(discountsGiven),
    refundsGiven: _round2(refundsGiven),
    voidCount,
    notes: data.notes || shiftDoc.data().notes || '',
    updatedAt: _TS(),
  };

  await shiftDoc.ref.update(summary);

  return {
    shiftId,
    message: 'Shift closed successfully',
    summary: {
      ...summary,
      openingCash: shiftDoc.data().openingCash,
      cashierName: shiftDoc.data().cashierName,
      branchId: shiftDoc.data().branchId,
    },
  };
  } catch (err) {
    logger.error('[closeShift] failed', { sellerId, cashierUid, error: err.message });
    if (err instanceof HttpsError) throw err;
    throw new HttpsError('internal', 'Shift close failed — please retry');
  }
});

/**
 * getCurrentShift — returns the open shift for the authenticated cashier.
 *
 * Input: { sellerId }
 */
exports.getCurrentShift = onCall(_CF, exports._h.getCurrentShift = async (req) => {
  const auth = _requireAuth(req);
  const { data } = req;
  const sellerId = _requireSeller(data);
  const cashierUid = auth.uid;

  const snap = await db.collection('posShifts')
    .where('sellerId', '==', sellerId)
    .where('cashierUid', '==', cashierUid)
    .where('status', '==', 'open')
    .limit(1)
    .get();

  if (snap.empty) return { shift: null };

  const doc = snap.docs[0];
  return { shift: { id: doc.id, ...doc.data() } };
});

/**
 * getShiftHistory — returns shift history for a seller.
 * Role: manager+
 *
 * Input: { sellerId, cashierUid?, startDate?, endDate?, limit? }
 */
exports.getShiftHistory = onCall(_CF, exports._h.getShiftHistory = async (req) => {
  const auth = _requireAuth(req);
  _requireRole(auth, 'manager');
  const { data } = req;
  const sellerId = _requireSeller(data);

  let query = db.collection('posShifts')
    .where('sellerId', '==', sellerId);

  if (data.cashierUid) query = query.where('cashierUid', '==', data.cashierUid);

  query = query.orderBy('openedAt', 'desc').limit(Math.min(Number(data.limit || 50), 100));

  const snap = await query.get();
  const shifts = snap.docs.map(d => ({ id: d.id, ...d.data() }));

  // Client-side date filter if provided (Firestore timestamps make range queries complex with other wheres)
  const filtered = shifts.filter(s => {
    const opened = _toDate(s.openedAt);
    if (!opened) return true;
    if (data.startDate && opened < new Date(data.startDate)) return false;
    if (data.endDate && opened > new Date(data.endDate + 'T23:59:59Z')) return false;
    return true;
  });

  return { shifts: filtered, total: filtered.length };
});

// ---------------------------------------------------------------------------
// B. CLOCK-IN / CLOCK-OUT + ATTENDANCE
// ---------------------------------------------------------------------------

/**
 * clockIn — records clock-in for today.
 * Creates or updates attendance doc keyed: ${sellerId}_${cashierUid}_${YYYY-MM-DD}
 *
 * Input: { sellerId, cashierName, expectedStartTime? (HH:MM, default '08:00') }
 */
exports.clockIn = onCall(_CF, exports._h.clockIn = async (req) => {
  const auth = _requireAuth(req);
  const { data } = req;
  const sellerId = _requireSeller(data);
  const cashierUid = auth.uid;
  const cashierName = data.cashierName || auth.token?.name || 'Unknown';
  const today = _today();
  const docId = `${sellerId}_${cashierUid}_${today}`;
  const docRef = db.collection('posAttendance').doc(docId);

  const existing = await docRef.get();
  if (existing.exists && existing.data().clockInAt)
    throw new HttpsError('already-exists', 'Already clocked in for today');

  // Calculate late minutes
  const expectedStartStr = data.expectedStartTime || '08:00';
  const [expHour, expMin] = expectedStartStr.split(':').map(Number);
  const now = new Date();
  const expectedStart = new Date(now);
  expectedStart.setHours(expHour, expMin, 0, 0);

  const diffMs = now - expectedStart;
  const lateMinutes = diffMs > 0 ? Math.round(diffMs / 60000) : 0;
  const status = lateMinutes > 0 ? 'late' : 'present';

  const attendanceData = {
    sellerId,
    cashierUid,
    cashierName,
    date: today,
    clockInAt: _TS(),
    clockOutAt: null,
    hoursWorked: null,
    status,
    lateMinutes,
    notes: data.notes || '',
    expectedStartTime: expectedStartStr,
    updatedAt: _TS(),
  };

  if (!existing.exists) {
    attendanceData.createdAt = _TS();
    await docRef.set(attendanceData);
  } else {
    await docRef.update({
      clockInAt: _TS(),
      status,
      lateMinutes,
      updatedAt: _TS(),
    });
  }

  return { attendanceId: docId, status, lateMinutes, message: 'Clocked in successfully' };
});

/**
 * clockOut — records clock-out for today.
 * Calculates hoursWorked. If < 4 hours, marks as half_day.
 *
 * Input: { sellerId, notes? }
 */
exports.clockOut = onCall(_CF, exports._h.clockOut = async (req) => {
  const auth = _requireAuth(req);
  const { data } = req;
  const sellerId = _requireSeller(data);
  const cashierUid = auth.uid;
  const today = _today();
  const docId = `${sellerId}_${cashierUid}_${today}`;
  const docRef = db.collection('posAttendance').doc(docId);

  const doc = await docRef.get();
  if (!doc.exists)
    throw new HttpsError('not-found', 'No clock-in record found for today');

  const record = doc.data();
  if (!record.clockInAt)
    throw new HttpsError('failed-precondition', 'Must clock in before clocking out');
  if (record.clockOutAt)
    throw new HttpsError('already-exists', 'Already clocked out for today');

  const clockIn = _toDate(record.clockInAt);
  const now = new Date();
  const hoursWorked = _round2((now - clockIn) / 3600000);
  let status = record.status;
  if (hoursWorked < 4) status = 'half_day';

  await docRef.update({
    clockOutAt: _TS(),
    hoursWorked,
    status,
    notes: data.notes || record.notes || '',
    updatedAt: _TS(),
  });

  return { attendanceId: docId, hoursWorked, status, message: 'Clocked out successfully' };
});

/**
 * getAttendance — returns attendance records for a seller/cashier.
 * Role: manager+
 *
 * Input: { sellerId, cashierUid?, startDate, endDate }
 */
exports.getAttendance = onCall(_CF, exports._h.getAttendance = async (req) => {
  const auth = _requireAuth(req);
  _requireRole(auth, 'manager');
  const { data } = req;
  const sellerId = _requireSeller(data);

  let query = db.collection('posAttendance').where('sellerId', '==', sellerId);
  if (data.cashierUid) query = query.where('cashierUid', '==', data.cashierUid);
  query = query.orderBy('date', 'desc').limit(200);

  const snap = await query.get();
  let records = snap.docs.map(d => ({ id: d.id, ...d.data() }));

  if (data.startDate)
    records = records.filter(r => r.date >= data.startDate);
  if (data.endDate)
    records = records.filter(r => r.date <= data.endDate);

  return { attendance: records, total: records.length };
});

/**
 * getAttendanceSummary — returns per-staff summary for a period.
 * Role: manager+
 *
 * Input: { sellerId, period (YYYY-MM) }
 */
exports.getAttendanceSummary = onCall(_CF, exports._h.getAttendanceSummary = async (req) => {
  const auth = _requireAuth(req);
  _requireRole(auth, 'manager');
  const { data } = req;
  const sellerId = _requireSeller(data);
  const period = data.period || _currentMonth();

  if (!/^\d{4}-\d{2}$/.test(period))
    throw new HttpsError('invalid-argument', 'period must be YYYY-MM');

  const startDate = `${period}-01`;
  // Last day of month
  const [yr, mo] = period.split('-').map(Number);
  const lastDay = new Date(yr, mo, 0).getDate();
  const endDate = `${period}-${String(lastDay).padStart(2, '0')}`;

  const snap = await db.collection('posAttendance')
    .where('sellerId', '==', sellerId)
    .where('date', '>=', startDate)
    .where('date', '<=', endDate)
    .get();

  const byStaff = {};
  for (const doc of snap.docs) {
    const r = doc.data();
    if (!byStaff[r.cashierUid]) {
      byStaff[r.cashierUid] = {
        cashierUid: r.cashierUid,
        cashierName: r.cashierName,
        totalDays: 0,
        presentDays: 0,
        absentDays: 0,
        lateDays: 0,
        halfDays: 0,
        totalHours: 0,
        totalLateMinutes: 0,
      };
    }
    const entry = byStaff[r.cashierUid];
    entry.totalDays++;
    if (r.status === 'present') entry.presentDays++;
    else if (r.status === 'absent') entry.absentDays++;
    else if (r.status === 'late') { entry.presentDays++; entry.lateDays++; }
    else if (r.status === 'half_day') { entry.presentDays++; entry.halfDays++; }
    entry.totalHours += Number(r.hoursWorked || 0);
    entry.totalLateMinutes += Number(r.lateMinutes || 0);
  }

  const summary = Object.values(byStaff).map(s => ({
    ...s,
    totalHours: _round2(s.totalHours),
    avgHoursPerDay: s.presentDays > 0 ? _round2(s.totalHours / s.presentDays) : 0,
  }));

  return { period, summary, staffCount: summary.length };
});

// ---------------------------------------------------------------------------
// C. SALES COMMISSIONS
// ---------------------------------------------------------------------------

/**
 * setCommissionRate — sets commission rate for a cashier or 'default'.
 * Role: owner
 *
 * Input: { sellerId, cashierUid? (omit for default), rate (percentage 0-100) }
 */
exports.setCommissionRate = onCall(_CF, exports._h.setCommissionRate = async (req) => {
  const auth = _requireAuth(req);
  _requireRole(auth, 'owner');
  const { data } = req;
  const sellerId = _requireSeller(data);
  const rate = Number(data.rate);

  if (isNaN(rate) || rate < 0 || rate > 100)
    throw new HttpsError('invalid-argument', 'rate must be a number between 0 and 100');

  const target = data.cashierUid || 'default';
  const docId = `${sellerId}_${target}`;
  const docRef = db.collection('posCommissionRates').doc(docId);

  await docRef.set({
    sellerId,
    cashierUid: target,
    rate,
    setBy: auth.uid,
    updatedAt: _TS(),
    createdAt: _TS(),
  }, { merge: true });

  return { docId, rate, target, message: 'Commission rate updated' };
});

/**
 * getCommissionRate — returns commission rate for a cashier (falls back to default).
 * Role: manager+
 *
 * Input: { sellerId, cashierUid }
 */
exports.getCommissionRate = onCall(_CF, exports._h.getCommissionRate = async (req) => {
  const auth = _requireAuth(req);
  _requireRole(auth, 'manager');
  const { data } = req;
  const sellerId = _requireSeller(data);
  const cashierUid = data.cashierUid || auth.uid;

  const specificDoc = await db.collection('posCommissionRates')
    .doc(`${sellerId}_${cashierUid}`).get();

  if (specificDoc.exists) {
    return { rate: specificDoc.data().rate, source: 'specific', cashierUid };
  }

  const defaultDoc = await db.collection('posCommissionRates')
    .doc(`${sellerId}_default`).get();

  const rate = defaultDoc.exists ? defaultDoc.data().rate : 2; // 2% fallback
  return { rate, source: defaultDoc.exists ? 'default' : 'system_fallback', cashierUid };
});

/**
 * calculateMonthlyCommission — calculates and stores commission for a cashier.
 * Role: manager+
 *
 * Input: { sellerId, cashierUid, month (YYYY-MM) }
 */
exports.calculateMonthlyCommission = onCall(_CF, exports._h.calculateMonthlyCommission = async (req) => {
  const auth = _requireAuth(req);
  _requireRole(auth, 'manager');
  const { data } = req;
  const sellerId = _requireSeller(data);
  const cashierUid = data.cashierUid;
  const month = data.month || _currentMonth();

  if (!cashierUid) throw new HttpsError('invalid-argument', 'cashierUid is required');
  if (!/^\d{4}-\d{2}$/.test(month))
    throw new HttpsError('invalid-argument', 'month must be YYYY-MM');

  // Determine date range
  const startDate = new Date(`${month}-01T00:00:00.000Z`);
  const [yr, mo] = month.split('-').map(Number);
  const endDate = new Date(yr, mo, 0, 23, 59, 59, 999);

  // Fetch sales for this cashier in this month
  const salesSnap = await db.collection('posRetailSales')
    .where('sellerId', '==', sellerId)
    .where('cashierUid', '==', cashierUid)
    .where('createdAt', '>=', startDate)
    .where('createdAt', '<=', endDate)
    .get();

  let totalSales = 0;
  let totalTransactions = 0;
  let totalRefunds = 0;
  const breakdown = [];

  for (const doc of salesSnap.docs) {
    const s = doc.data();
    if (s.status === 'voided') continue;
    const amount = Number(s.total || 0);
    if (s.status === 'refunded') {
      totalRefunds += amount;
    } else {
      totalSales += amount;
      totalTransactions++;
    }
    breakdown.push({ saleId: doc.id, total: amount, status: s.status, date: s.createdAt });
  }

  const netSales = _round2(totalSales - totalRefunds);

  // Get commission rate (specific or default)
  const specificRateDoc = await db.collection('posCommissionRates')
    .doc(`${sellerId}_${cashierUid}`).get();
  let commissionRate = 2;
  let rateSource = 'system_fallback';
  if (specificRateDoc.exists) {
    commissionRate = specificRateDoc.data().rate;
    rateSource = 'specific';
  } else {
    const defaultRateDoc = await db.collection('posCommissionRates')
      .doc(`${sellerId}_default`).get();
    if (defaultRateDoc.exists) {
      commissionRate = defaultRateDoc.data().rate;
      rateSource = 'default';
    }
  }

  const commissionAmount = _round2((netSales * commissionRate) / 100);

  const commissionDocId = `${sellerId}_${cashierUid}_${month}`;
  const commissionRef = db.collection('posCommissions').doc(commissionDocId);

  const commissionData = {
    sellerId,
    cashierUid,
    month,
    totalSales: _round2(totalSales),
    totalRefunds: _round2(totalRefunds),
    netSales,
    totalTransactions,
    commissionRate,
    rateSource,
    commissionAmount,
    approved: false,
    paidAt: null,
    paidBy: null,
    calculatedBy: auth.uid,
    calculatedAt: _TS(),
    updatedAt: _TS(),
  };

  await commissionRef.set(commissionData, { merge: true });

  return {
    commissionId: commissionDocId,
    month,
    cashierUid,
    totalSales: _round2(totalSales),
    netSales,
    commissionRate,
    commissionAmount,
    totalTransactions,
  };
});

/**
 * approveCommission — marks a commission record as approved and paid.
 * Role: owner
 *
 * Input: { commissionId, paidAt? }
 */
exports.approveCommission = onCall(_CF, exports._h.approveCommission = async (req) => {
  const auth = _requireAuth(req);
  _requireRole(auth, 'owner');
  const { data } = req;

  if (!data.commissionId) throw new HttpsError('invalid-argument', 'commissionId is required');

  const docRef = db.collection('posCommissions').doc(data.commissionId);
  const doc = await docRef.get();
  if (!doc.exists) throw new HttpsError('not-found', 'Commission record not found');

  if (doc.data().approved)
    throw new HttpsError('already-exists', 'Commission already approved');

  await docRef.update({
    approved: true,
    paidAt: data.paidAt ? new Date(data.paidAt) : _TS(),
    paidBy: auth.uid,
    updatedAt: _TS(),
  });

  return { commissionId: data.commissionId, message: 'Commission approved successfully' };
});

/**
 * getCommissionsSummary — returns all cashiers' commission totals for a period.
 * Role: manager+
 *
 * Input: { sellerId, month (YYYY-MM) }
 */
exports.getCommissionsSummary = onCall(_CF, exports._h.getCommissionsSummary = async (req) => {
  const auth = _requireAuth(req);
  _requireRole(auth, 'manager');
  const { data } = req;
  const sellerId = _requireSeller(data);
  const month = data.month || _currentMonth();

  const snap = await db.collection('posCommissions')
    .where('sellerId', '==', sellerId)
    .where('month', '==', month)
    .get();

  const commissions = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  const totalCommission = _round2(commissions.reduce((s, c) => s + (c.commissionAmount || 0), 0));
  const totalNetSales = _round2(commissions.reduce((s, c) => s + (c.netSales || 0), 0));
  const unpaidCount = commissions.filter(c => !c.approved).length;

  return { month, commissions, totalCommission, totalNetSales, unpaidCount, staffCount: commissions.length };
});

// ---------------------------------------------------------------------------
// D. APPROVAL WORKFLOWS
// ---------------------------------------------------------------------------

/**
 * createApprovalRequest — creates a pending approval workflow item.
 * Expires in 5 minutes.
 *
 * Input: { sellerId, type, requestData }
 *   type: 'discount' | 'refund' | 'void' | 'price_override' | 'drawer_open'
 *   requestData: { amount?, reason?, saleId?, ... }
 */
exports.createApprovalRequest = onCall(_CF, exports._h.createApprovalRequest = async (req) => {
  const auth = _requireAuth(req);
  const { data } = req;
  const sellerId = _requireSeller(data);
  const requestedBy = auth.uid;
  const requestedByName = data.requestedByName || auth.token?.name || 'Unknown';

  const VALID_TYPES = ['discount', 'refund', 'void', 'price_override', 'drawer_open'];
  if (!VALID_TYPES.includes(data.type))
    throw new HttpsError('invalid-argument', `type must be one of: ${VALID_TYPES.join(', ')}`);

  const now = new Date();
  const expiresAt = new Date(now.getTime() + 5 * 60 * 1000); // +5 minutes

  const approvalRef = db.collection('posApprovals').doc();
  const approvalData = {
    sellerId,
    type: data.type,
    requestedBy,
    requestedByName,
    requestData: data.requestData || {},
    status: 'pending',
    reviewedBy: null,
    reviewedAt: null,
    reviewNotes: null,
    createdAt: _TS(),
    expiresAt,
    updatedAt: _TS(),
  };

  await approvalRef.set(approvalData);

  return {
    approvalId: approvalRef.id,
    status: 'pending',
    expiresAt: expiresAt.toISOString(),
    message: 'Approval request created',
  };
});

/**
 * reviewApproval — approves or rejects a pending request.
 * Role: supervisor+
 *
 * Input: { approvalId, decision ('approved'|'rejected'), notes? }
 */
exports.reviewApproval = onCall(_CF, exports._h.reviewApproval = async (req) => {
  const auth = _requireAuth(req);
  _requireRole(auth, 'supervisor');
  const { data } = req;

  if (!data.approvalId) throw new HttpsError('invalid-argument', 'approvalId is required');
  if (!['approved', 'rejected'].includes(data.decision))
    throw new HttpsError('invalid-argument', "decision must be 'approved' or 'rejected'");

  const docRef = db.collection('posApprovals').doc(data.approvalId);
  const doc = await docRef.get();
  if (!doc.exists) throw new HttpsError('not-found', 'Approval request not found');

  const approval = doc.data();

  if (approval.status !== 'pending')
    throw new HttpsError('failed-precondition', `Approval already ${approval.status}`);

  const now = new Date();
  const expiresAt = _toDate(approval.expiresAt);
  if (expiresAt && now > expiresAt)
    throw new HttpsError('deadline-exceeded', 'Approval request has expired');

  await docRef.update({
    status: data.decision,
    reviewedBy: auth.uid,
    reviewedAt: _TS(),
    reviewNotes: data.notes || '',
    updatedAt: _TS(),
  });

  return { approvalId: data.approvalId, status: data.decision, message: `Approval ${data.decision}` };
});

/**
 * getPendingApprovals — returns unexpired pending approvals for a seller.
 * Role: supervisor+
 *
 * Input: { sellerId }
 */
exports.getPendingApprovals = onCall(_CF, exports._h.getPendingApprovals = async (req) => {
  const auth = _requireAuth(req);
  _requireRole(auth, 'supervisor');
  const { data } = req;
  const sellerId = _requireSeller(data);

  const now = new Date();

  const snap = await db.collection('posApprovals')
    .where('sellerId', '==', sellerId)
    .where('status', '==', 'pending')
    .orderBy('createdAt', 'asc')
    .limit(50)
    .get();

  const approvals = snap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .filter(a => {
      const exp = _toDate(a.expiresAt);
      return !exp || now <= exp;
    });

  return { approvals, total: approvals.length };
});

/**
 * checkApproval — polls the current status of an approval request.
 * Used by cashiers to check if their request was reviewed.
 *
 * Input: { approvalId }
 */
exports.checkApproval = onCall(_CF, exports._h.checkApproval = async (req) => {
  _requireAuth(req);
  const { data } = req;
  if (!data.approvalId) throw new HttpsError('invalid-argument', 'approvalId is required');

  const doc = await db.collection('posApprovals').doc(data.approvalId).get();
  if (!doc.exists) throw new HttpsError('not-found', 'Approval request not found');

  const a = doc.data();
  const now = new Date();
  const exp = _toDate(a.expiresAt);
  const expired = exp && now > exp && a.status === 'pending';

  return {
    approvalId: data.approvalId,
    status: expired ? 'expired' : a.status,
    type: a.type,
    reviewedBy: a.reviewedBy || null,
    reviewedAt: a.reviewedAt || null,
    reviewNotes: a.reviewNotes || null,
    expiresAt: a.expiresAt ? (exp ? exp.toISOString() : null) : null,
    expired,
  };
});

// ---------------------------------------------------------------------------
// E. CASH RECONCILIATION
// ---------------------------------------------------------------------------

/**
 * submitCashCount — submits physical cash count at end of shift.
 * Calculates variance against expected closing balance.
 *
 * Input: {
 *   sellerId, shiftId, countedAmount, notes?,
 *   denominations?: [{ denomination: number, count: number }]
 * }
 */
exports.submitCashCount = onCall(_CF, exports._h.submitCashCount = async (req) => {
  const auth = _requireAuth(req);
  const { data } = req;
  const sellerId = _requireSeller(data);
  const cashierUid = auth.uid;
  const shiftId = data.shiftId;
  const countedAmount = Number(data.countedAmount);

  if (!shiftId) throw new HttpsError('invalid-argument', 'shiftId is required');
  if (isNaN(countedAmount) || countedAmount < 0)
    throw new HttpsError('invalid-argument', 'countedAmount must be a non-negative number');

  // Read shift for expected closing
  const shiftDoc = await db.collection('posShifts').doc(shiftId).get();
  if (!shiftDoc.exists) throw new HttpsError('not-found', 'Shift not found');

  const shift = shiftDoc.data();
  if (shift.sellerId !== sellerId)
    throw new HttpsError('permission-denied', 'Shift does not belong to this seller');

  const openingBalance = Number(shift.openingCash || 0);
  const cashSales = Number(shift.cashSales || 0);
  const expectedClosing = _round2(openingBalance + cashSales);
  const variance = _round2(countedAmount - expectedClosing);

  let status;
  if (Math.abs(variance) < 0.01) status = 'balanced';
  else if (variance > 0) status = 'over';
  else status = 'short';

  // Validate denominations if provided
  const denominations = Array.isArray(data.denominations) ? data.denominations : [];
  const denominationTotal = denominations.reduce(
    (sum, d) => sum + Number(d.denomination || 0) * Number(d.count || 0), 0
  );
  const denominationsMismatch = denominations.length > 0 &&
    Math.abs(denominationTotal - countedAmount) > 0.01;

  if (denominationsMismatch)
    throw new HttpsError('invalid-argument',
      `Denominations total (${denominationTotal}) does not match countedAmount (${countedAmount})`);

  const recRef = db.collection('posCashReconciliation').doc();
  const recData = {
    sellerId,
    cashierUid,
    shiftId,
    date: _today(),
    openingBalance,
    totalCashSales: cashSales,
    expectedClosing,
    actualCounted: countedAmount,
    denominations,
    variance,
    varianceExplained: data.varianceExplained || '',
    status,
    notes: data.notes || '',
    createdBy: cashierUid,
    createdAt: _TS(),
    updatedAt: _TS(),
  };

  await recRef.set(recData);

  return {
    reconciliationId: recRef.id,
    expectedClosing,
    actualCounted: countedAmount,
    variance,
    status,
    message: `Cash count submitted. Status: ${status} (variance: ${variance >= 0 ? '+' : ''}${variance})`,
  };
});

/**
 * getCashReconciliation — returns reconciliation records for a seller.
 * Role: manager+
 *
 * Input: { sellerId, startDate?, endDate?, limit? }
 */
exports.getCashReconciliation = onCall(_CF, exports._h.getCashReconciliation = async (req) => {
  const auth = _requireAuth(req);
  _requireRole(auth, 'manager');
  const { data } = req;
  const sellerId = _requireSeller(data);

  let query = db.collection('posCashReconciliation')
    .where('sellerId', '==', sellerId)
    .orderBy('createdAt', 'desc')
    .limit(Math.min(Number(data.limit || 50), 100));

  const snap = await query.get();
  let records = snap.docs.map(d => ({ id: d.id, ...d.data() }));

  if (data.startDate) records = records.filter(r => r.date >= data.startDate);
  if (data.endDate) records = records.filter(r => r.date <= data.endDate);

  return { reconciliations: records, total: records.length };
});

/**
 * getCashVarianceSummary — returns total over/short variance by cashier for a period.
 * Role: manager+
 *
 * Input: { sellerId, startDate, endDate }
 */
exports.getCashVarianceSummary = onCall(_CF, exports._h.getCashVarianceSummary = async (req) => {
  const auth = _requireAuth(req);
  _requireRole(auth, 'manager');
  const { data } = req;
  const sellerId = _requireSeller(data);

  const snap = await db.collection('posCashReconciliation')
    .where('sellerId', '==', sellerId)
    .orderBy('createdAt', 'desc')
    .limit(500)
    .get();

  let records = snap.docs.map(d => ({ id: d.id, ...d.data() }));

  if (data.startDate) records = records.filter(r => r.date >= data.startDate);
  if (data.endDate) records = records.filter(r => r.date <= data.endDate);

  const byCashier = {};
  for (const r of records) {
    if (!byCashier[r.cashierUid]) {
      byCashier[r.cashierUid] = {
        cashierUid: r.cashierUid,
        sessionCount: 0,
        totalVariance: 0,
        totalOver: 0,
        totalShort: 0,
        balancedCount: 0,
        overCount: 0,
        shortCount: 0,
      };
    }
    const entry = byCashier[r.cashierUid];
    entry.sessionCount++;
    entry.totalVariance += r.variance || 0;
    if (r.status === 'over') { entry.overCount++; entry.totalOver += r.variance || 0; }
    else if (r.status === 'short') { entry.shortCount++; entry.totalShort += Math.abs(r.variance || 0); }
    else entry.balancedCount++;
  }

  const summary = Object.values(byCashier).map(s => ({
    ...s,
    totalVariance: _round2(s.totalVariance),
    totalOver: _round2(s.totalOver),
    totalShort: _round2(s.totalShort),
  }));

  const grandVariance = _round2(summary.reduce((s, c) => s + c.totalVariance, 0));

  return {
    startDate: data.startDate || null,
    endDate: data.endDate || null,
    summary,
    grandVariance,
    staffCount: summary.length,
  };
});

// ---------------------------------------------------------------------------
// F. PERFORMANCE DASHBOARD
// ---------------------------------------------------------------------------

/**
 * getStaffPerformanceDashboard — returns per-cashier performance metrics.
 * Role: manager+
 *
 * Input: { sellerId, period (YYYY-MM) }
 */
exports.getStaffPerformanceDashboard = onCall(_CF, exports._h.getStaffPerformanceDashboard = async (req) => {
  const auth = _requireAuth(req);
  _requireRole(auth, 'manager');
  const { data } = req;
  const sellerId = _requireSeller(data);
  const period = data.period || _currentMonth();

  if (!/^\d{4}-\d{2}$/.test(period))
    throw new HttpsError('invalid-argument', 'period must be YYYY-MM');

  const [yr, mo] = period.split('-').map(Number);
  const startDate = new Date(`${period}-01T00:00:00.000Z`);
  const endDate = new Date(yr, mo, 0, 23, 59, 59, 999);

  // Fetch sales for the period
  const salesSnap = await db.collection('posRetailSales')
    .where('sellerId', '==', sellerId)
    .where('createdAt', '>=', startDate)
    .where('createdAt', '<=', endDate)
    .get();

  // Aggregate sales by cashier
  const salesByStaff = {};
  for (const doc of salesSnap.docs) {
    const s = doc.data();
    const uid = s.cashierUid;
    if (!uid) continue;
    if (!salesByStaff[uid]) {
      salesByStaff[uid] = {
        cashierUid: uid,
        cashierName: s.cashierName || 'Unknown',
        totalSales: 0,
        totalTransactions: 0,
        totalDiscounts: 0,
        totalRefunds: 0,
        refundCount: 0,
      };
    }
    const entry = salesByStaff[uid];
    if (s.status === 'voided') continue;
    if (s.status === 'refunded') {
      entry.totalRefunds += Number(s.total || 0);
      entry.refundCount++;
      continue;
    }
    entry.totalSales += Number(s.total || 0);
    entry.totalTransactions++;
    entry.totalDiscounts += Number(s.discount || 0);
  }

  // Fetch attendance for the period
  const attSnap = await db.collection('posAttendance')
    .where('sellerId', '==', sellerId)
    .where('date', '>=', `${period}-01`)
    .where('date', '<=', `${period}-${String(new Date(yr, mo, 0).getDate()).padStart(2, '0')}`)
    .get();

  const attByStaff = {};
  let workingDays = 0;
  const datesSeen = new Set();
  for (const doc of attSnap.docs) {
    const r = doc.data();
    if (!datesSeen.has(r.date)) { datesSeen.add(r.date); workingDays++; }
    if (!attByStaff[r.cashierUid]) {
      attByStaff[r.cashierUid] = { hoursWorked: 0, presentDays: 0 };
    }
    attByStaff[r.cashierUid].hoursWorked += Number(r.hoursWorked || 0);
    if (['present', 'late', 'half_day'].includes(r.status))
      attByStaff[r.cashierUid].presentDays++;
  }

  // Fetch commissions for the period
  const commSnap = await db.collection('posCommissions')
    .where('sellerId', '==', sellerId)
    .where('month', '==', period)
    .get();

  const commByStaff = {};
  for (const doc of commSnap.docs) {
    const c = doc.data();
    commByStaff[c.cashierUid] = c.commissionAmount || 0;
  }

  // Combine all staff UIDs
  const allUids = new Set([
    ...Object.keys(salesByStaff),
    ...Object.keys(attByStaff),
  ]);

  const dashboard = [];
  for (const uid of allUids) {
    const sales = salesByStaff[uid] || {
      cashierUid: uid, cashierName: 'Unknown',
      totalSales: 0, totalTransactions: 0, totalDiscounts: 0, totalRefunds: 0, refundCount: 0,
    };
    const att = attByStaff[uid] || { hoursWorked: 0, presentDays: 0 };
    const commissionEarned = commByStaff[uid] || 0;

    const hoursWorked = _round2(att.hoursWorked);
    const salesPerHour = hoursWorked > 0 ? _round2(sales.totalSales / hoursWorked) : 0;
    const avgBasketSize = sales.totalTransactions > 0
      ? _round2(sales.totalSales / sales.totalTransactions) : 0;
    const refundRate = sales.totalTransactions > 0
      ? _round2((sales.refundCount / sales.totalTransactions) * 100) : 0;
    const attendanceRate = workingDays > 0
      ? _round2((att.presentDays / workingDays) * 100) : 0;

    dashboard.push({
      cashierUid: uid,
      cashierName: sales.cashierName,
      totalSales: _round2(sales.totalSales),
      totalTransactions: sales.totalTransactions,
      avgBasketSize,
      hoursWorked,
      salesPerHour,
      discountsGiven: _round2(sales.totalDiscounts),
      refundRate,
      attendanceRate,
      presentDays: att.presentDays,
      workingDays,
      commissionEarned: _round2(commissionEarned),
    });
  }

  // Sort by totalSales descending
  dashboard.sort((a, b) => b.totalSales - a.totalSales);

  return {
    period,
    sellerId,
    workingDays,
    staffCount: dashboard.length,
    dashboard,
  };
});

// ---------------------------------------------------------------------------
// G. SCHEDULED: dailyStaffReport
// ---------------------------------------------------------------------------

/**
 * dailyStaffReport — runs at midnight every day.
 * Auto-closes any shifts that are still open (did not close before midnight).
 * Writes a note explaining the auto-close.
 */
exports.dailyStaffReport = onSchedule(
  { schedule: 'every 24 hours', timeZone: 'Africa/Nairobi', region: 'us-central1' },
  async () => {
    const now = new Date();
    const todayStr = now.toISOString().slice(0, 10);

    // Find all open shifts
    const openShiftsSnap = await db.collection('posShifts')
      .where('status', '==', 'open')
      .get();

    if (openShiftsSnap.empty) {
      console.log('[dailyStaffReport] No open shifts found at midnight.');
      return;
    }

    const batch = db.batch();
    let count = 0;

    for (const shiftDoc of openShiftsSnap.docs) {
      const shift = shiftDoc.data();
      const shiftId = shiftDoc.id;

      // Aggregate sales for auto-close summary
      let totalSales = 0;
      let totalTransactions = 0;
      let cashSales = 0;
      let mpesaSales = 0;
      let cardSales = 0;
      let qrSales = 0;
      let discountsGiven = 0;
      let refundsGiven = 0;
      let voidCount = 0;

      try {
        const salesSnap = await db.collection('posRetailSales')
          .where('shiftId', '==', shiftId)
          .get();

        for (const saleDoc of salesSnap.docs) {
          const s = saleDoc.data();
          if (s.status === 'voided') { voidCount++; continue; }
          if (s.status === 'refunded') { refundsGiven += Number(s.total || 0); continue; }
          const amount = Number(s.total || 0);
          totalSales += amount;
          totalTransactions++;
          discountsGiven += Number(s.discount || 0);
          const pm = (s.paymentMethod || '').toLowerCase();
          if (pm === 'cash') cashSales += amount;
          else if (pm === 'mpesa' || pm === 'm-pesa') mpesaSales += amount;
          else if (pm === 'card') cardSales += amount;
          else if (pm === 'qr') qrSales += amount;
        }
      } catch (err) {
        console.error(`[dailyStaffReport] Error aggregating sales for shift ${shiftId}:`, err);
      }

      batch.update(shiftDoc.ref, {
        status: 'closed',
        closingCash: null,
        closedAt: admin.firestore.FieldValue.serverTimestamp(),
        totalSales: _round2(totalSales),
        totalTransactions,
        cashSales: _round2(cashSales),
        mpesaSales: _round2(mpesaSales),
        cardSales: _round2(cardSales),
        qrSales: _round2(qrSales),
        discountsGiven: _round2(discountsGiven),
        refundsGiven: _round2(refundsGiven),
        voidCount,
        notes: `Auto-closed at midnight on ${todayStr}. Original notes: ${shift.notes || ''}`.trim(),
        autoClosedAt: admin.firestore.FieldValue.serverTimestamp(),
        autoClosedDate: todayStr,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      count++;

      // Firestore batch limit is 500 writes
      if (count % 490 === 0) {
        await batch.commit();
      }
    }

    await batch.commit();

    console.log(`[dailyStaffReport] Auto-closed ${count} shift(s) at midnight on ${todayStr}.`);
  }
);
