'use strict';

/**
 * @fileoverview SOKONI HR & Payroll Engine â€” Kenya-specific Firebase Cloud Functions
 * @module hr-payroll
 * @description
 *   Provides 12 Cloud Functions covering the full HR & Payroll lifecycle:
 *   - Staff management (add, dashboard)
 *   - Attendance tracking (clock-in/out, reports)
 *   - Payroll processing (run, approve, payslips, summary)
 *   - Leave management (request, approve)
 *   - Training management (assign, complete)
 *
 *   All statutory deductions follow Kenya Finance Act 2024/2025 rates:
 *   PAYE (progressive), NHIF, NSSF (Tier I + II), Housing Levy.
 *
 * @requires PAYROLL_ENCRYPTION_KEY â€” AES-256-GCM key (hex) stored in Secret Manager
 */

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const admin = require('firebase-admin');
const { defineSecret } = require('firebase-functions/params');
const crypto = require('crypto');

const db = admin.firestore();
const F = admin.firestore.FieldValue;
const REGION = 'us-central1';
const OPT = { region: REGION, enforceAppCheck: true };

/** AES-256-GCM encryption key for bank account details */
const PAYROLL_ENCRYPTION_KEY = defineSecret('PAYROLL_ENCRYPTION_KEY');
const _h = {};

// â”€â”€â”€ Kenya Statutory Deduction Tables (Finance Act 2024/2025) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * PAYE progressive tax bands (monthly gross, KES).
 * Each band applies to income within its bracket.
 */
const PAYE_BANDS = [
  { max: 24000,    rate: 0.10  },
  { max: 32333,    rate: 0.25  },
  { max: 500000,   rate: 0.30  },
  { max: 800000,   rate: 0.325 },
  { max: Infinity, rate: 0.35  },
];

/** Personal relief deducted from gross PAYE liability (KES/month) */
const PAYE_RELIEF = 2400;

/**
 * NHIF contribution lookup table (monthly gross â†’ flat contribution, KES).
 */
const NHIF_BANDS = [
  { max: 5999,     amount: 150  },
  { max: 7999,     amount: 300  },
  { max: 11999,    amount: 400  },
  { max: 14999,    amount: 500  },
  { max: 19999,    amount: 600  },
  { max: 24999,    amount: 750  },
  { max: 29999,    amount: 850  },
  { max: 34999,    amount: 900  },
  { max: 39999,    amount: 950  },
  { max: 44999,    amount: 1000 },
  { max: 49999,    amount: 1100 },
  { max: 59999,    amount: 1200 },
  { max: 69999,    amount: 1300 },
  { max: 79999,    amount: 1400 },
  { max: 89999,    amount: 1500 },
  { max: 99999,    amount: 1600 },
  { max: Infinity, amount: 1700 },
];

/** NSSF Tier I pensionable pay ceiling (KES) */
const NSSF_TIER1_LIMIT = 7000;
/** NSSF Tier II pensionable pay ceiling (KES) */
const NSSF_TIER2_LIMIT = 36000;
/** NSSF contribution rate (employee & employer each) */
const NSSF_RATE = 0.06;
/** Affordable Housing Levy rate (employee & employer each) */
const HOUSING_LEVY_RATE = 0.015;

// â”€â”€â”€ Statutory Deduction Helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * Calculate NHIF contribution from gross salary.
 * @param {number} gross - Monthly gross salary (KES)
 * @returns {number} NHIF deduction (KES)
 */
function calculateNHIF(gross) {
  for (const band of NHIF_BANDS) {
    if (gross <= band.max) return band.amount;
  }
  return 1700; // fallback: top band
}

/**
 * Calculate NSSF contributions (Tier I + Tier II) per NSSF Act 2013.
 * Tier I: 6% of first KES 7,000 (max KES 420/month employee)
 * Tier II: 6% of next KES 29,000 pensionable pay (max KES 1,740/month)
 * @param {number} gross - Monthly gross salary (KES)
 * @returns {{ tier1: number, tier2: number, total: number }}
 */
function calculateNSSF(gross) {
  const tier1 = Math.min(gross, NSSF_TIER1_LIMIT) * NSSF_RATE; // max 420
  const tier2 =
    Math.max(0, Math.min(gross, NSSF_TIER2_LIMIT) - NSSF_TIER1_LIMIT) *
    NSSF_RATE; // max 1740
  return {
    tier1: Math.round(tier1 * 100) / 100,
    tier2: Math.round(tier2 * 100) / 100,
    total: Math.round((tier1 + tier2) * 100) / 100,
  };
}

/**
 * Calculate PAYE (Pay As You Earn) using Kenya progressive bands.
 * Personal relief of KES 2,400/month is applied after band calculation.
 * @param {number} taxableIncome - Monthly taxable income (KES)
 * @returns {number} Net PAYE payable (KES), minimum 0
 */
function calculatePAYE(taxableIncome) {
  let tax = 0;
  let previousMax = 0;

  for (const band of PAYE_BANDS) {
    if (taxableIncome <= previousMax) break;
    const bandIncome = Math.min(taxableIncome, band.max) - previousMax;
    tax += bandIncome * band.rate;
    previousMax = band.max;
    if (band.max === Infinity) break;
  }

  const netPaye = tax - PAYE_RELIEF;
  return Math.max(0, Math.round(netPaye * 100) / 100);
}

/**
 * Compute full statutory deductions breakdown for a given gross salary.
 * Taxable income = gross - NSSF employee total (NSSF is pre-tax).
 * @param {number} grossSalary - Monthly gross salary (KES)
 * @returns {{
 *   gross: number,
 *   nhif: number,
 *   nssf: { tier1: number, tier2: number, total: number },
 *   housingLevy: number,
 *   taxableIncome: number,
 *   paye: number,
 *   totalDeductions: number,
 *   netSalary: number,
 *   employerNSSF: number,
 *   employerHousingLevy: number
 * }}
 */
function calculateDeductions(grossSalary) {
  const nhif = calculateNHIF(grossSalary);
  const nssf = calculateNSSF(grossSalary);
  const housingLevy = Math.round(grossSalary * HOUSING_LEVY_RATE * 100) / 100;

  // NSSF is deducted before PAYE is computed
  const taxableIncome = Math.max(0, grossSalary - nssf.total);
  const paye = calculatePAYE(taxableIncome);

  const totalDeductions =
    Math.round((nhif + nssf.total + housingLevy + paye) * 100) / 100;
  const netSalary =
    Math.round((grossSalary - totalDeductions) * 100) / 100;

  // Employer-side statutory costs
  const employerNSSF = nssf.total; // employer matches employee NSSF
  const employerHousingLevy =
    Math.round(grossSalary * HOUSING_LEVY_RATE * 100) / 100;

  return {
    gross: Math.round(grossSalary * 100) / 100,
    nhif,
    nssf,
    housingLevy,
    taxableIncome: Math.round(taxableIncome * 100) / 100,
    paye,
    totalDeductions,
    netSalary,
    employerNSSF,
    employerHousingLevy,
  };
}

// â”€â”€â”€ Encryption Helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * Encrypt plaintext using AES-256-GCM.
 * @param {string} plaintext - Data to encrypt
 * @param {string} keyHex - 64-character hex key (32 bytes)
 * @returns {string} JSON string containing iv, encryptedData, and tag (all hex)
 */
function encryptData(plaintext, keyHex) {
  const key = Buffer.from(keyHex, 'hex');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return JSON.stringify({
    iv: iv.toString('hex'),
    encryptedData: encrypted.toString('hex'),
    tag: tag.toString('hex'),
  });
}

/**
 * Decrypt AES-256-GCM encrypted data produced by encryptData.
 * @param {string} encryptedJson - JSON string from encryptData
 * @param {string} keyHex - 64-character hex key (32 bytes)
 * @returns {string} Decrypted plaintext
 */
function decryptData(encryptedJson, keyHex) {
  const { iv, encryptedData, tag } = JSON.parse(encryptedJson);
  const key = Buffer.from(keyHex, 'hex');
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    key,
    Buffer.from(iv, 'hex')
  );
  decipher.setAuthTag(Buffer.from(tag, 'hex'));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(encryptedData, 'hex')),
    decipher.final(),
  ]);
  return decrypted.toString('utf8');
}

// â”€â”€â”€ Date / Calendar Helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * Count working days (Mondayâ€“Friday) in a given month.
 * @param {string} yearMonth - Format 'YYYY-MM'
 * @returns {number} Number of weekdays in that month
 */
function getWorkingDaysInMonth(yearMonth) {
  const [year, month] = yearMonth.split('-').map(Number);
  const daysInMonth = new Date(year, month, 0).getDate();
  let workingDays = 0;
  for (let d = 1; d <= daysInMonth; d++) {
    const dow = new Date(year, month - 1, d).getDay(); // 0=Sun, 6=Sat
    if (dow !== 0 && dow !== 6) workingDays++;
  }
  return workingDays;
}

/**
 * Get today's date string in Africa/Nairobi timezone (YYYY-MM-DD).
 * @returns {string}
 */
function getNairobiDateString() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Nairobi' });
}

// â”€â”€â”€ Auth Guard Helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * Assert the caller has admin or manager role.
 * @param {object} auth - req.auth from onCall
 * @throws {HttpsError} PERMISSION_DENIED if not admin or manager
 */
function assertAdminOrManager(auth) {
  if (!auth) {
    throw new HttpsError('unauthenticated', 'Authentication required.');
  }
  if (!auth.token.admin && !auth.token.manager) {
    throw new HttpsError(
      'permission-denied',
      'Admin or manager role required.'
    );
  }
}

/**
 * Assert the caller has admin role.
 * @param {object} auth - req.auth from onCall
 * @throws {HttpsError} PERMISSION_DENIED if not admin
 */
function assertAdmin(auth) {
  if (!auth) {
    throw new HttpsError('unauthenticated', 'Authentication required.');
  }
  if (!auth.token.admin) {
    throw new HttpsError('permission-denied', 'Admin role required.');
  }
}

// â”€â”€â”€ Cloud Function 1: addStaffMember â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * Add a new staff member to the HR registry.
 * Bank account details are encrypted at rest using AES-256-GCM.
 *
 * @param {object} data
 * @param {string} data.merchantId
 * @param {string} data.name
 * @param {string} data.employeeNumber
 * @param {string} data.department
 * @param {string} data.position
 * @param {number} data.grossSalary - Monthly gross (KES)
 * @param {string} data.startDate - ISO date string
 * @param {object} [data.bankAccount] - { bankName, accountNumber, branchCode }
 * @param {string} [data.kraPin]
 * @param {string} [data.phone]
 * @param {string} [data.email]
 * @returns {{ staffId: string, message: string }}
 */
const addStaffMember = onCall(
  { ...OPT, secrets: [PAYROLL_ENCRYPTION_KEY] },
  _h.addStaffMember = async (req) => {
    assertAdminOrManager(req.auth);

    const {
      merchantId,
      name,
      employeeNumber,
      department,
      position,
      grossSalary,
      startDate,
      bankAccount,
      kraPin,
      phone,
      email,
    } = req.data;

    // â”€â”€ Input validation â”€â”€
    if (!merchantId || !name || !employeeNumber || !department || !position) {
      throw new HttpsError(
        'invalid-argument',
        'merchantId, name, employeeNumber, department and position are required.'
      );
    }
    if (typeof grossSalary !== 'number' || grossSalary <= 0) {
      throw new HttpsError(
        'invalid-argument',
        'grossSalary must be a positive number.'
      );
    }
    if (!startDate || isNaN(Date.parse(startDate))) {
      throw new HttpsError(
        'invalid-argument',
        'startDate must be a valid date string (e.g. 2025-07-01).'
      );
    }

    // â”€â”€ Duplicate employee number check â”€â”€
    // ── Encrypt bank account details ──
    let encryptedBankAccount = null;
    if (bankAccount && typeof bankAccount === 'object') {
      const keyHex = PAYROLL_ENCRYPTION_KEY.value();
      encryptedBankAccount = encryptData(JSON.stringify(bankAccount), keyHex);
    }

    // Deterministic doc ID prevents duplicate employee numbers atomically —
    // two concurrent calls for the same merchantId+employeeNumber both resolve
    // to the same doc; the transaction ensures only the first one wins.
    const staffId  = `${merchantId}_${employeeNumber}`;
    const staffRef = db.collection('hrStaff').doc(staffId);

    await db.runTransaction(async t => {
      const snap = await t.get(staffRef);
      if (snap.exists) throw new HttpsError('already-exists', `Employee number ${employeeNumber} already exists for this merchant.`);
      t.set(staffRef, {
        merchantId, name, employeeNumber, department, position, grossSalary,
        startDate, bankAccount: encryptedBankAccount,
        kraPin: kraPin || null, phone: phone || null, email: email || null,
        status: 'active', uid: null,
        createdAt: F.serverTimestamp(), createdBy: req.auth.uid,
      });
    });

    return { staffId, message: 'Staff member added successfully.' };
  }
);

// â”€â”€â”€ Cloud Function 2: recordAttendance â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * Record clock-in or clock-out for a staff member.
 *
 * @param {object} data
 * @param {string} data.merchantId
 * @param {string} data.staffId
 * @param {'clock_in'|'clock_out'} data.action
 * @param {string} [data.timestamp] - ISO timestamp (defaults to now)
 * @returns {{ success: boolean, docId: string }}
 */
const recordAttendance = onCall(OPT, _h.recordAttendance = async (req) => {
  if (!req.auth) {
    throw new HttpsError('unauthenticated', 'Authentication required.');
  }

  const { merchantId, staffId, action, timestamp } = req.data;

  if (!merchantId || !staffId) {
    throw new HttpsError(
      'invalid-argument',
      'merchantId and staffId are required.'
    );
  }
  if (action !== 'clock_in' && action !== 'clock_out') {
    throw new HttpsError(
      'invalid-argument',
      "action must be 'clock_in' or 'clock_out'."
    );
  }

  const today = getNairobiDateString();
  const docId = `${merchantId}_${staffId}_${today}`;
  const ref = db.collection('hrAttendance').doc(docId);
  const now = timestamp ? new Date(timestamp) : new Date();

  if (action === 'clock_in') {
    await ref.set(
      {
        merchantId,
        staffId,
        date: today,
        clockIn: F.serverTimestamp(),
        clockInMs: now.getTime(),
        status: 'present',
        updatedAt: F.serverTimestamp(),
      },
      { merge: true }
    );
  } else {
    // clock_out
    const snap = await ref.get();
    if (!snap.exists) {
      throw new HttpsError(
        'not-found',
        'No clock-in record found for today. Please clock in first.'
      );
    }
    const data = snap.data();
    const clockInMs = data.clockInMs || now.getTime();
    const hoursWorked = Math.round(((now.getTime() - clockInMs) / 3600000) * 100) / 100;

    // Detect late arrivals: clock-in after 09:00 Nairobi time
    const clockInHour = new Date(clockInMs).toLocaleString('en-US', {
      timeZone: 'Africa/Nairobi',
      hour: 'numeric',
      hour12: false,
    });
    const isLate = parseInt(clockInHour, 10) >= 9;

    await ref.update({
      clockOut: F.serverTimestamp(),
      clockOutMs: now.getTime(),
      hoursWorked,
      isLate,
      updatedAt: F.serverTimestamp(),
    });
  }

  return { success: true, docId };
});

// â”€â”€â”€ Cloud Function 3: getAttendanceReport â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * Aggregate attendance data for a merchant over a given month.
 *
 * @param {object} data
 * @param {string} data.merchantId
 * @param {string} data.month - Format 'YYYY-MM'
 * @returns {{ month: string, records: Array }}
 */
const getAttendanceReport = onCall(OPT, _h.getAttendanceReport = async (req) => {
  assertAdminOrManager(req.auth);

  const { merchantId, month } = req.data;
  if (!merchantId || !month || !/^\d{4}-\d{2}$/.test(month)) {
    throw new HttpsError(
      'invalid-argument',
      "merchantId and month ('YYYY-MM') are required."
    );
  }

  const monthStart = `${month}-01`;
  const monthEnd = `${month}-31`; // safe upper bound for string comparison

  const snap = await db
    .collection('hrAttendance')
    .where('merchantId', '==', merchantId)
    .where('date', '>=', monthStart)
    .where('date', '<=', monthEnd)
    .get();

  const workingDays = getWorkingDaysInMonth(month);
  const byStaff = {};

  snap.forEach((doc) => {
    const d = doc.data();
    if (!byStaff[d.staffId]) {
      byStaff[d.staffId] = {
        staffId: d.staffId,
        daysPresent: 0,
        totalHours: 0,
        lateCount: 0,
      };
    }
    const rec = byStaff[d.staffId];
    if (d.status === 'present') rec.daysPresent++;
    if (d.hoursWorked) rec.totalHours += d.hoursWorked;
    if (d.isLate) rec.lateCount++;
  });

  const records = Object.values(byStaff).map((rec) => ({
    ...rec,
    daysAbsent: Math.max(0, workingDays - rec.daysPresent),
    totalHours: Math.round(rec.totalHours * 100) / 100,
  }));

  return { month, workingDays, records };
});

// â”€â”€â”€ Cloud Function 4: runPayroll â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * Process payroll for all active staff in a merchant for a given period.
 * Prorates salary based on actual attendance vs working days.
 *
 * @param {object} data
 * @param {string} data.merchantId
 * @param {string} data.period - 'YYYY-MM'
 * @param {string} [data.approvedBy]
 * @returns {{ runId: string, staffCount: number, totalGross: number, totalNet: number, summary: object }}
 */
const runPayroll = onCall(
  { ...OPT, secrets: [PAYROLL_ENCRYPTION_KEY] },
  _h.runPayroll = async (req) => {
    assertAdminOrManager(req.auth);

    const { merchantId, period } = req.data;
    if (!merchantId || !period || !/^\d{4}-\d{2}$/.test(period)) {
      throw new HttpsError(
        'invalid-argument',
        "merchantId and period ('YYYY-MM') are required."
      );
    }

    // â”€â”€ Guard: prevent duplicate runs â”€â”€
    // Deterministic runId + transaction gate prevents concurrent duplicate runs
    const runId  = `${merchantId}_${period}`;
    const runRef = db.collection('hrPayrollRuns').doc(runId);
    await db.runTransaction(async t => {
      const snap = await t.get(runRef);
      if (snap.exists) throw new HttpsError('already-exists', `Payroll for ${period} has already been run for this merchant.`);
      t.set(runRef, { merchantId, period, status: 'processing', createdBy: req.auth.uid, createdAt: F.serverTimestamp() });
    });

    // â”€â”€ Fetch active staff â”€â”€
    const staffSnap = await db
      .collection('hrStaff')
      .where('merchantId', '==', merchantId)
      .where('status', '==', 'active')
      .get();

    if (staffSnap.empty) {
      throw new HttpsError('not-found', 'No active staff found for this merchant.');
    }

    // â”€â”€ Fetch attendance for the period â”€â”€
    const monthStart = `${period}-01`;
    const monthEnd = `${period}-31`;
    const attendanceSnap = await db
      .collection('hrAttendance')
      .where('merchantId', '==', merchantId)
      .where('date', '>=', monthStart)
      .where('date', '<=', monthEnd)
      .get();

    // Build attendance lookup: staffId â†’ daysWorked
    const attendanceMap = {};
    attendanceSnap.forEach((doc) => {
      const d = doc.data();
      if (d.status === 'present') {
        attendanceMap[d.staffId] = (attendanceMap[d.staffId] || 0) + 1;
      }
    });

    const workingDays = getWorkingDaysInMonth(period);
    // runId and runRef were created by the transaction gate above
    let totalGross = 0;
    let totalNet = 0;
    let totalPAYE = 0;
    let totalNHIF = 0;
    let totalNSSF = 0;
    let totalHousingLevy = 0;
    let totalEmployerNSSF = 0;
    let totalEmployerHousingLevy = 0;
    let staffCount = 0;

    // Firestore WriteBatch cap is 500 ops; chunk payslips to stay under the limit
    const CHUNK = 499;
    const staffDocs = staffSnap.docs;
    const attendanceRecorded = attendanceSnap.size > 0;
    const round = (n) => Math.round(n * 100) / 100;

    for (let i = 0; i < staffDocs.length; i += CHUNK) {
      const chunk = staffDocs.slice(i, i + CHUNK);
      const batch = db.batch();
      chunk.forEach((staffDoc) => {
        const staff    = staffDoc.data();
        const staffId  = staffDoc.id;
        const daysWorked = attendanceMap[staffId] || 0;
        const adjustedGross = attendanceRecorded
          ? staff.grossSalary * (daysWorked / workingDays)
          : staff.grossSalary;
        const deductions = calculateDeductions(adjustedGross);

        batch.set(db.collection('hrPayslips').doc(`${runId}_${staffId}`), {
          runId, staffId, merchantId, period,
          employeeNumber: staff.employeeNumber,
          name: staff.name, department: staff.department, position: staff.position,
          grossSalary: staff.grossSalary, daysWorked, workingDays,
          adjustedGross: deductions.gross,
          nhif: deductions.nhif, nssf: deductions.nssf, housingLevy: deductions.housingLevy,
          taxableIncome: deductions.taxableIncome, paye: deductions.paye,
          totalDeductions: deductions.totalDeductions, netSalary: deductions.netSalary,
          employerNSSF: deductions.employerNSSF, employerHousingLevy: deductions.employerHousingLevy,
          status: 'draft', createdAt: F.serverTimestamp(),
        });

        totalGross += deductions.gross;
        totalNet += deductions.netSalary;
        totalPAYE += deductions.paye;
        totalNHIF += deductions.nhif;
        totalNSSF += deductions.nssf.total;
        totalHousingLevy += deductions.housingLevy;
        totalEmployerNSSF += deductions.employerNSSF;
        totalEmployerHousingLevy += deductions.employerHousingLevy;
        staffCount++;
      });
      await batch.commit();
    }

    // Update run doc from 'processing' → 'draft' with computed totals
    await runRef.update({
      status: 'draft',
      totalGross: round(totalGross),
      totalNet: round(totalNet),
      totalPAYE: round(totalPAYE),
      totalNHIF: round(totalNHIF),
      totalNSSF: round(totalNSSF),
      totalHousingLevy: round(totalHousingLevy),
      totalEmployerNSSF: round(totalEmployerNSSF),
      totalEmployerHousingLevy: round(totalEmployerHousingLevy),
      totalEmployerCost: round(totalGross + totalEmployerNSSF + totalEmployerHousingLevy),
      workingDays, staffCount,
    });

    return {
      runId,
      staffCount,
      totalGross: round(totalGross),
      totalNet: round(totalNet),
      summary: {
        totalPAYE: round(totalPAYE),
        totalNHIF: round(totalNHIF),
        totalNSSF: round(totalNSSF),
        totalHousingLevy: round(totalHousingLevy),
        totalEmployerCost: round(totalGross + totalEmployerNSSF + totalEmployerHousingLevy),
      },
    };
  }
);

// â”€â”€â”€ Cloud Function 5: approvePayrollRun â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * Approve a draft payroll run (admin only).
 *
 * @param {object} data
 * @param {string} data.runId
 * @returns {{ runId: string, status: 'approved' }}
 */
const approvePayrollRun = onCall(OPT, _h.approvePayrollRun = async (req) => {
  assertAdmin(req.auth);

  const { runId } = req.data;
  if (!runId) {
    throw new HttpsError('invalid-argument', 'runId is required.');
  }

  const runRef = db.collection('hrPayrollRuns').doc(runId);

  await db.runTransaction(async t => {
    const runSnap = await t.get(runRef);
    if (!runSnap.exists) throw new HttpsError('not-found', 'Payroll run not found.');
    if (runSnap.data().status !== 'draft') throw new HttpsError('failed-precondition', 'Only draft payroll runs can be approved.');
    t.update(runRef, { status: 'approved', approvedBy: req.auth.uid, approvedAt: F.serverTimestamp() });
  });

  return { runId, status: 'approved' };
});

// â”€â”€â”€ Cloud Function 6: getPayslip â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * Retrieve a payslip for a staff member (own record or admin/manager).
 *
 * @param {object} data
 * @param {string} data.runId
 * @param {string} data.staffId
 * @returns {object} Payslip data
 */
const getPayslip = onCall(OPT, _h.getPayslip = async (req) => {
  if (!req.auth) {
    throw new HttpsError('unauthenticated', 'Authentication required.');
  }

  const { runId, staffId } = req.data;
  if (!runId || !staffId) {
    throw new HttpsError('invalid-argument', 'runId and staffId are required.');
  }

  // Verify caller is the employee, admin, or manager
  const staffSnap = await db.collection('hrStaff').doc(staffId).get();
  if (!staffSnap.exists) {
    throw new HttpsError('not-found', 'Staff record not found.');
  }

  const staff = staffSnap.data();
  const callerUid = req.auth.uid;
  const isOwner = staff.uid && staff.uid === callerUid;
  const isPrivileged = req.auth.token.admin || req.auth.token.manager;

  if (!isOwner && !isPrivileged) {
    throw new HttpsError(
      'permission-denied',
      'You do not have permission to view this payslip.'
    );
  }

  const payslipSnap = await db
    .collection('hrPayslips')
    .doc(`${runId}_${staffId}`)
    .get();

  if (!payslipSnap.exists) {
    throw new HttpsError('not-found', 'Payslip not found.');
  }

  return payslipSnap.data();
});

// â”€â”€â”€ Cloud Function 7: getPayrollSummary â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * Get full payroll run summary including all payslips.
 *
 * @param {object} data
 * @param {string} data.merchantId
 * @param {string} data.period - 'YYYY-MM'
 * @returns {{ run: object, payslips: Array }}
 */
const getPayrollSummary = onCall(OPT, _h.getPayrollSummary = async (req) => {
  assertAdminOrManager(req.auth);

  const { merchantId, period } = req.data;
  if (!merchantId || !period) {
    throw new HttpsError(
      'invalid-argument',
      'merchantId and period are required.'
    );
  }

  const runSnap = await db
    .collection('hrPayrollRuns')
    .where('merchantId', '==', merchantId)
    .where('period', '==', period)
    .limit(1)
    .get();

  if (runSnap.empty) {
    throw new HttpsError(
      'not-found',
      `No payroll run found for ${period}.`
    );
  }

  const runDoc = runSnap.docs[0];
  const runId = runDoc.id;

  const payslipsSnap = await db
    .collection('hrPayslips')
    .where('runId', '==', runId)
    .get();

  const payslips = payslipsSnap.docs.map((d) => ({ id: d.id, ...d.data() }));

  return { run: { id: runId, ...runDoc.data() }, payslips };
});

// â”€â”€â”€ Cloud Function 8: requestLeave â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * Submit a leave request for a staff member.
 *
 * @param {object} data
 * @param {string} data.staffId
 * @param {string} data.merchantId
 * @param {'annual'|'sick'|'maternity'|'paternity'|'unpaid'} data.type
 * @param {string} data.startDate - ISO date string (YYYY-MM-DD)
 * @param {string} data.endDate - ISO date string (YYYY-MM-DD)
 * @param {string} data.reason
 * @returns {{ leaveId: string, leaveDays: number }}
 */
const requestLeave = onCall(OPT, _h.requestLeave = async (req) => {
  if (!req.auth) {
    throw new HttpsError('unauthenticated', 'Authentication required.');
  }

  const ALLOWED_TYPES = ['annual', 'sick', 'maternity', 'paternity', 'unpaid'];
  const { staffId, merchantId, type, startDate, endDate, reason } =
    req.data;

  if (!staffId || !merchantId || !type || !startDate || !endDate) {
    throw new HttpsError(
      'invalid-argument',
      'staffId, merchantId, type, startDate and endDate are required.'
    );
  }
  if (!ALLOWED_TYPES.includes(type)) {
    throw new HttpsError(
      'invalid-argument',
      `type must be one of: ${ALLOWED_TYPES.join(', ')}.`
    );
  }
  if (isNaN(Date.parse(startDate)) || isNaN(Date.parse(endDate))) {
    throw new HttpsError(
      'invalid-argument',
      'startDate and endDate must be valid date strings.'
    );
  }
  if (startDate > endDate) {
    throw new HttpsError(
      'invalid-argument',
      'startDate must be on or before endDate.'
    );
  }

  // Calendar days inclusive
  const msPerDay = 86400000;
  const leaveDays =
    Math.round((Date.parse(endDate) - Date.parse(startDate)) / msPerDay) + 1;

  const leaveRef = db.collection('hrLeaves').doc();
  const leaveId = leaveRef.id;

  const batch = db.batch();

  batch.set(leaveRef, {
    staffId,
    merchantId,
    type,
    startDate,
    endDate,
    leaveDays,
    reason: reason || '',
    status: 'pending',
    requestedAt: F.serverTimestamp(),
    requestedBy: req.auth.uid,
  });

  // Notify manager/admin
  const alertRef = db
    .collection('adminAlerts')
    .doc(merchantId)
    .collection('alerts')
    .doc();

  batch.set(alertRef, {
    type: 'leave_request',
    staffId,
    leaveId,
    leaveType: type,
    leaveDays,
    startDate,
    endDate,
    message: `Leave request (${type}, ${leaveDays} day${leaveDays !== 1 ? 's' : ''}) submitted by staff ${staffId}.`,
    read: false,
    createdAt: F.serverTimestamp(),
  });

  await batch.commit();

  return { leaveId, leaveDays };
});

// â”€â”€â”€ Cloud Function 9: approveLeave â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * Approve or reject a pending leave req.
 *
 * @param {object} data
 * @param {string} data.leaveId
 * @param {boolean} data.approved
 * @param {string} [data.notes]
 * @returns {{ leaveId: string, status: 'approved'|'rejected' }}
 */
const approveLeave = onCall(OPT, _h.approveLeave = async (req) => {
  assertAdminOrManager(req.auth);

  const { leaveId, approved, notes } = req.data;
  if (!leaveId || typeof approved !== 'boolean') {
    throw new HttpsError(
      'invalid-argument',
      'leaveId and approved (boolean) are required.'
    );
  }

  const leaveRef = db.collection('hrLeaves').doc(leaveId);
  const leaveSnap = await leaveRef.get();

  if (!leaveSnap.exists) {
    throw new HttpsError('not-found', 'Leave request not found.');
  }
  if (leaveSnap.data().status !== 'pending') {
    throw new HttpsError(
      'failed-precondition',
      'Only pending leave requests can be approved or rejected.'
    );
  }

  const newStatus = approved ? 'approved' : 'rejected';
  const leaveData = leaveSnap.data();

  const batch = db.batch();

  batch.update(leaveRef, {
    status: newStatus,
    approvedBy: req.auth.uid,
    approvedAt: F.serverTimestamp(),
    notes: notes || '',
  });

  // Notify the staff member
  const notifRef = db.collection('notifications').doc();
  batch.set(notifRef, {
    userId: leaveData.requestedBy,
    staffId: leaveData.staffId,
    type: 'leave_decision',
    title: `Leave Request ${newStatus.charAt(0).toUpperCase() + newStatus.slice(1)}`,
    body: `Your ${leaveData.type} leave request (${leaveData.leaveDays} day${leaveData.leaveDays !== 1 ? 's' : ''}, ${leaveData.startDate} â€“ ${leaveData.endDate}) has been ${newStatus}.`,
    notes: notes || '',
    read: false,
    createdAt: F.serverTimestamp(),
  });

  await batch.commit();

  return { leaveId, status: newStatus };
});

// â”€â”€â”€ Cloud Function 10: assignTraining â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * Create and assign a training module to one or more staff members.
 *
 * @param {object} data
 * @param {string} data.merchantId
 * @param {string} data.title
 * @param {string} data.description
 * @param {string[]} data.assignedTo - Array of staffIds
 * @param {string} data.dueDate - ISO date string
 * @returns {{ trainingId: string, assignedCount: number }}
 */
const assignTraining = onCall(OPT, _h.assignTraining = async (req) => {
  assertAdminOrManager(req.auth);

  const { merchantId, title, description, assignedTo, dueDate } = req.data;

  if (!merchantId || !title || !dueDate) {
    throw new HttpsError(
      'invalid-argument',
      'merchantId, title and dueDate are required.'
    );
  }
  if (!Array.isArray(assignedTo) || assignedTo.length === 0) {
    throw new HttpsError(
      'invalid-argument',
      'assignedTo must be a non-empty array of staffIds.'
    );
  }
  if (isNaN(Date.parse(dueDate))) {
    throw new HttpsError(
      'invalid-argument',
      'dueDate must be a valid date string.'
    );
  }

  const trainingRef = db.collection('hrTraining').doc();
  const trainingId = trainingRef.id;
  const batch = db.batch();

  batch.set(trainingRef, {
    merchantId,
    title,
    description: description || '',
    assignedTo,
    completedBy: [],
    dueDate,
    status: 'active',
    createdBy: req.auth.uid,
    createdAt: F.serverTimestamp(),
  });

  // Notify each assigned staff member
  for (const staffId of assignedTo) {
    const notifRef = db.collection('notifications').doc();
    batch.set(notifRef, {
      staffId,
      type: 'training_assigned',
      title: `New Training: ${title}`,
      body: `You have been assigned training: "${title}". Due: ${dueDate}.`,
      trainingId,
      read: false,
      createdAt: F.serverTimestamp(),
    });
  }

  await batch.commit();

  return { trainingId, assignedCount: assignedTo.length };
});

// â”€â”€â”€ Cloud Function 11: markTrainingComplete â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * Mark a staff member's training as completed.
 * If all assigned staff have completed, marks the training as fully done.
 *
 * @param {object} data
 * @param {string} data.trainingId
 * @param {string} data.staffId
 * @returns {{ trainingId: string, staffId: string, allCompleted: boolean }}
 */
const markTrainingComplete = onCall(OPT, _h.markTrainingComplete = async (req) => {
  if (!req.auth) {
    throw new HttpsError('unauthenticated', 'Authentication required.');
  }

  const { trainingId, staffId } = req.data;
  if (!trainingId || !staffId) {
    throw new HttpsError(
      'invalid-argument',
      'trainingId and staffId are required.'
    );
  }

  const trainingRef = db.collection('hrTraining').doc(trainingId);
  const trainingSnap = await trainingRef.get();

  if (!trainingSnap.exists) {
    throw new HttpsError('not-found', 'Training record not found.');
  }

  const training = trainingSnap.data();

  if (!training.assignedTo.includes(staffId)) {
    throw new HttpsError(
      'failed-precondition',
      'This staff member is not assigned to this training.'
    );
  }

  // Verify caller is the employee or admin/manager
  const staffSnap = await db.collection('hrStaff').doc(staffId).get();
  if (staffSnap.exists) {
    const staff = staffSnap.data();
    const isOwner = staff.uid && staff.uid === req.auth.uid;
    const isPrivileged = req.auth.token.admin || req.auth.token.manager;
    if (!isOwner && !isPrivileged) {
      throw new HttpsError(
        'permission-denied',
        'You can only mark your own training as complete.'
      );
    }
  }

  // Prevent duplicate completion entries
  if (training.completedBy.includes(staffId)) {
    const allCompleted = training.assignedTo.every((id) =>
      training.completedBy.includes(id)
    );
    return { trainingId, staffId, allCompleted };
  }

  const updatedCompletedBy = [...training.completedBy, staffId];
  const allCompleted = training.assignedTo.every((id) =>
    updatedCompletedBy.includes(id)
  );

  const update = {
    completedBy: F.arrayUnion(staffId),
    updatedAt: F.serverTimestamp(),
  };
  if (allCompleted) {
    update.status = 'completed';
    update.completedAt = F.serverTimestamp();
  }

  await trainingRef.update(update);

  return { trainingId, staffId, allCompleted };
});

// â”€â”€â”€ Cloud Function 12: getStaffDashboard â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * Return aggregated HR dashboard statistics for a merchant.
 *
 * @param {object} data
 * @param {string} data.merchantId
 * @returns {{
 *   activeStaff: number,
 *   presentToday: number,
 *   pendingLeaves: number,
 *   activeTrainings: number,
 *   lastPayroll: object|null,
 *   today: string
 * }}
 */
const getStaffDashboard = onCall(OPT, _h.getStaffDashboard = async (req) => {
  assertAdminOrManager(req.auth);

  const { merchantId } = req.data;
  if (!merchantId) {
    throw new HttpsError('invalid-argument', 'merchantId is required.');
  }

  const today = getNairobiDateString();

  // â”€â”€ Fire all queries in parallel â”€â”€
  const [
    activeStaffSnap,
    attendanceTodaySnap,
    pendingLeavesSnap,
    activeTrainingsSnap,
    lastPayrollSnap,
  ] = await Promise.all([
    // a. Active staff count
    db
      .collection('hrStaff')
      .where('merchantId', '==', merchantId)
      .where('status', '==', 'active')
      .get(),

    // b. Today's attendance
    db
      .collection('hrAttendance')
      .where('merchantId', '==', merchantId)
      .where('date', '==', today)
      .where('status', '==', 'present')
      .get(),

    // c. Pending leave requests
    db
      .collection('hrLeaves')
      .where('merchantId', '==', merchantId)
      .where('status', '==', 'pending')
      .get(),

    // d. Active trainings
    db
      .collection('hrTraining')
      .where('merchantId', '==', merchantId)
      .where('status', '==', 'active')
      .get(),

    // e. Most recent payroll run
    db
      .collection('hrPayrollRuns')
      .where('merchantId', '==', merchantId)
      .orderBy('createdAt', 'desc')
      .limit(1)
      .get(),
  ]);

  const lastPayroll = lastPayrollSnap.empty
    ? null
    : { id: lastPayrollSnap.docs[0].id, ...lastPayrollSnap.docs[0].data() };

  return {
    activeStaff: activeStaffSnap.size,
    presentToday: attendanceTodaySnap.size,
    pendingLeaves: pendingLeavesSnap.size,
    activeTrainings: activeTrainingsSnap.size,
    lastPayroll,
    today,
  };
});

// â”€â”€â”€ Module Exports â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

module.exports = {
  _h,
  addStaffMember,
  recordAttendance,
  getAttendanceReport,
  runPayroll,
  approvePayrollRun,
  getPayslip,
  getPayrollSummary,
  requestLeave,
  approveLeave,
  assignTraining,
  markTrainingComplete,
  getStaffDashboard,
};
