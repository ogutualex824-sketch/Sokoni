/* ============================================================
   SOKONI SmartPOS — Accounting Engine v1.0
   Firebase Gen2 Cloud Functions

   Implements a complete double-entry accounting system
   aligned with Kenya Revenue Authority (KRA) requirements.

   Currency: KES
   VAT: 16% tax-inclusive (KRA standard)
   Tax Framework: KRA VAT Act

   Sections:
     A. Chart of Accounts
     B. Journal Entries
     C. Profit & Loss Report
     D. Balance Sheet
     E. Cash Flow Statement
     F. VAT Report
     G. Expense Tracking
     H. Accounting Period Close
     I. Accounting Export
     J. Scheduled: monthlyAccountingSnapshot
============================================================ */

'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule }         = require('firebase-functions/v2/scheduler');
const admin  = require('firebase-admin');
const crypto = require('crypto');

if (!admin.apps.length) admin.initializeApp();

exports._h = {}; // handler registry — consumed by smartpos-dispatch.js
const db = admin.firestore();

/* ── Config ─────────────────────────────────────────────────── */
const _CF  = { region: 'us-central1', enforceAppCheck: true };
const _TS  = () => admin.firestore.FieldValue.serverTimestamp();
const _INC = (n) => admin.firestore.FieldValue.increment(n);

const KES_SCALE  = 2;          /* decimal places for KES */
const VAT_RATE   = 0.16;       /* 16% KRA VAT             */
const MAX_BATCH  = 500;        /* Firestore batch limit   */

/* ── Auth helpers ───────────────────────────────────────────── */
function _requireAuth(req) {
  if (!req.auth) throw new HttpsError('unauthenticated', 'Login required');
  return req.auth;
}

function _requireRole(auth, minRole) {
  const levels = { cashier: 0, supervisor: 1, manager: 2, owner: 3 };
  const userLevel = levels[auth.token?.posRole || 'cashier'] ?? 0;
  const required  = levels[minRole] ?? 0;
  if (userLevel < required)
    throw new HttpsError('permission-denied', `Requires ${minRole} role`);
}

/* ── Input / sanitisation helpers ───────────────────────────── */
function _san(s, max = 500) {
  return String(s || '').replace(/[<>"'&]/g, '').trim().slice(0, max);
}

function _kes(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  return Math.round(v * 100) / 100;           /* round to 2dp */
}

function _requireStr(val, name) {
  if (!val || typeof val !== 'string' || !val.trim())
    throw new HttpsError('invalid-argument', `${name} is required`);
  return val.trim();
}

function _requireNum(val, name, min = 0) {
  const n = Number(val);
  if (!Number.isFinite(n) || n < min)
    throw new HttpsError('invalid-argument', `${name} must be a number >= ${min}`);
  return n;
}

function _requireDate(val, name) {
  if (!val) throw new HttpsError('invalid-argument', `${name} is required`);
  const d = new Date(val);
  if (isNaN(d.getTime())) throw new HttpsError('invalid-argument', `${name} is not a valid date`);
  return d;
}

/* ── ID generators ──────────────────────────────────────────── */
function _newId(prefix = 'ACC') {
  const ymd  = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const rand = crypto.randomBytes(6).toString('hex').toUpperCase();
  return `${prefix}-${ymd}-${rand}`;
}

/* ── Structured logger ──────────────────────────────────────── */
function _log(severity, message, extra = {}) {
  console[severity === 'ERROR' ? 'error' : severity === 'WARNING' ? 'warn' : 'log'](
    JSON.stringify({ severity, message, service: 'pos-accounting', ...extra })
  );
}

/* ── Date helpers ───────────────────────────────────────────── */
function _startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function _endOfDay(d) {
  const x = new Date(d);
  x.setHours(23, 59, 59, 999);
  return x;
}

function _periodStartEnd(period) {
  /* period = 'YYYY-MM' */
  const [y, m] = period.split('-').map(Number);
  const start  = new Date(y, m - 1, 1);
  const end    = new Date(y, m, 0, 23, 59, 59, 999);   /* last day of month */
  return { start, end };
}

/* ── Account type resolver ──────────────────────────────────── */
function _accountType(code) {
  const n = Number(code);
  if (n >= 1000 && n <= 1999) return 'asset';
  if (n >= 2000 && n <= 2999) return 'liability';
  if (n >= 3000 && n <= 3999) return 'equity';
  if (n >= 4000 && n <= 4999) return 'revenue';
  if (n >= 5000 && n <= 5999) return 'cogs';
  if (n >= 6000 && n <= 6999) return 'expense';
  return 'unknown';
}

/* ── Standard chart of accounts seed data ───────────────────── */
const STANDARD_ACCOUNTS = [
  /* Assets */
  { code: '1001', name: 'Cash on Hand',        type: 'asset',     subType: 'current' },
  { code: '1002', name: 'Bank Account',         type: 'asset',     subType: 'current' },
  { code: '1003', name: 'M-Pesa Float',         type: 'asset',     subType: 'current' },
  { code: '1100', name: 'Accounts Receivable',  type: 'asset',     subType: 'current' },
  { code: '1200', name: 'Inventory',            type: 'asset',     subType: 'current' },
  { code: '1300', name: 'Prepaid Expenses',     type: 'asset',     subType: 'current' },
  /* Liabilities */
  { code: '2001', name: 'Accounts Payable',     type: 'liability', subType: 'current' },
  { code: '2100', name: 'VAT Payable',          type: 'liability', subType: 'current' },
  { code: '2200', name: 'PAYE Payable',         type: 'liability', subType: 'current' },
  { code: '2300', name: 'Customer Deposits',    type: 'liability', subType: 'current' },
  /* Equity */
  { code: '3001', name: 'Owner Equity',         type: 'equity',    subType: 'equity'  },
  { code: '3100', name: 'Retained Earnings',    type: 'equity',    subType: 'equity'  },
  /* Revenue */
  { code: '4001', name: 'Sales Revenue',        type: 'revenue',   subType: 'operating' },
  { code: '4002', name: 'Service Revenue',      type: 'revenue',   subType: 'operating' },
  { code: '4003', name: 'Other Income',         type: 'revenue',   subType: 'other'     },
  /* Cost of Goods Sold */
  { code: '5001', name: 'Cost of Goods Sold',  type: 'cogs',      subType: 'cogs'      },
  { code: '5002', name: 'Purchase Returns',    type: 'cogs',      subType: 'cogs'      },
  /* Expenses */
  { code: '6001', name: 'Salaries & Wages',    type: 'expense',   subType: 'operating' },
  { code: '6002', name: 'Rent',               type: 'expense',   subType: 'operating' },
  { code: '6003', name: 'Utilities',          type: 'expense',   subType: 'operating' },
  { code: '6004', name: 'Marketing',          type: 'expense',   subType: 'operating' },
  { code: '6005', name: 'Delivery',           type: 'expense',   subType: 'operating' },
  { code: '6006', name: 'Other Expenses',     type: 'expense',   subType: 'operating' },
];

/* Map expense category → account code */
const EXPENSE_ACCOUNT_MAP = {
  salaries:  '6001',
  rent:      '6002',
  utilities: '6003',
  marketing: '6004',
  delivery:  '6005',
  supplies:  '6006',
  drawings:  '3001',   /* owner drawings reduce Owner Equity */
  other:     '6006',
};

/* Map payment method → asset account code */
const PAYMENT_ACCOUNT_MAP = {
  cash:   '1001',
  mpesa:  '1003',
  bank:   '1002',
  card:   '1002',
  credit: '1100',  /* accounts receivable for credit sales */
};

/* ═══════════════════════════════════════════════════════════════
   INTERNAL HELPERS  (not exported)
═══════════════════════════════════════════════════════════════ */

/**
 * _postJournalEntry
 * Core double-entry writer.  Always call inside a Firestore transaction
 * or use the public createJournalEntry callable for external writes.
 *
 * @param {FirebaseFirestore.Transaction} txn  — active Firestore transaction
 * @param {object} entry — journal entry payload
 * @returns {string} new journal entry id
 */
async function _postJournalEntry(txn, entry) {
  const { sellerId, entryDate, description, reference, lines, createdBy } = entry;

  if (!Array.isArray(lines) || lines.length < 2)
    throw new HttpsError('invalid-argument', 'Journal entry requires at least 2 lines');

  let totalDebits  = 0;
  let totalCredits = 0;

  const cleanLines = lines.map((l, i) => {
    const debit  = _kes(l.debit  || 0);
    const credit = _kes(l.credit || 0);
    if (debit < 0 || credit < 0)
      throw new HttpsError('invalid-argument', `Line ${i}: amounts must be >= 0`);
    if (debit > 0 && credit > 0)
      throw new HttpsError('invalid-argument', `Line ${i}: a line cannot have both debit and credit`);
    if (debit === 0 && credit === 0)
      throw new HttpsError('invalid-argument', `Line ${i}: line must have debit or credit`);
    totalDebits  += debit;
    totalCredits += credit;
    return {
      accountCode: _san(l.accountCode, 10),
      accountName: _san(l.accountName, 100),
      debit,
      credit,
    };
  });

  /* Round to cents before comparison to avoid floating-point drift */
  const roundedDebits  = Math.round(totalDebits  * 100);
  const roundedCredits = Math.round(totalCredits * 100);
  const isBalanced     = roundedDebits === roundedCredits;

  if (!isBalanced)
    throw new HttpsError(
      'invalid-argument',
      `Journal entry is not balanced: debits=${_kes(totalDebits)} credits=${_kes(totalCredits)}`
    );

  const entryId  = _newId('JRN');
  const entryRef = db.collection('posJournalEntries').doc(entryId);

  txn.set(entryRef, {
    sellerId:     _san(sellerId, 64),
    entryDate:    entryDate instanceof Date ? admin.firestore.Timestamp.fromDate(entryDate) : entryDate,
    description:  _san(description, 500),
    reference:    reference ? _san(reference, 100) : null,
    lines:        cleanLines,
    totalDebits:  _kes(totalDebits),
    totalCredits: _kes(totalCredits),
    isBalanced,
    status:       'posted',
    createdBy:    createdBy || null,
    createdAt:    _TS(),
  });

  /* Update account balances in posAccountBalances */
  for (const line of cleanLines) {
    const balKey = `${sellerId}_${line.accountCode}`;
    const balRef = db.collection('posAccountBalances').doc(balKey);
    const acctType = _accountType(line.accountCode);

    /*
     * Normal balance convention:
     *   Assets, COGS, Expenses  → debit increases, credit decreases
     *   Liabilities, Equity, Revenue → credit increases, debit decreases
     */
    let balanceChange = 0;
    if (['asset', 'cogs', 'expense'].includes(acctType)) {
      balanceChange = line.debit - line.credit;
    } else {
      balanceChange = line.credit - line.debit;
    }

    txn.set(
      balRef,
      {
        sellerId,
        accountCode: line.accountCode,
        accountName: line.accountName,
        accountType: acctType,
        balance:     _INC(_kes(balanceChange)),
        updatedAt:   _TS(),
      },
      { merge: true }
    );
  }

  return entryId;
}

/**
 * _getAccountBalance
 * Reads the current balance for one account.
 *
 * @param {string} sellerId
 * @param {string} accountCode
 * @returns {Promise<number>}
 */
async function _getAccountBalance(sellerId, accountCode) {
  const balKey  = `${sellerId}_${accountCode}`;
  const balSnap = await db.collection('posAccountBalances').doc(balKey).get();
  return balSnap.exists ? _kes(balSnap.data().balance || 0) : 0;
}

/* ═══════════════════════════════════════════════════════════════
   SECTION A — CHART OF ACCOUNTS
═══════════════════════════════════════════════════════════════ */

/**
 * initializeChartOfAccounts
 * Role: owner
 * Seeds the standard Kenyan double-entry chart for a seller.
 * Skips accounts that already exist (idempotent).
 */
exports.initializeChartOfAccounts = onCall(_CF, exports._h.initializeChartOfAccounts = async (req) => {
  const auth     = _requireAuth(req);
  _requireRole(auth, 'owner');

  const { sellerId } = req.data;
  _requireStr(sellerId, 'sellerId');

  if (auth.uid !== sellerId && !auth.token?.admin && !auth.token?.superAdmin)
    throw new HttpsError('permission-denied', 'Cannot initialise accounts for another seller');

  const colRef   = db.collection('posAccounts');
  const batch    = db.batch();
  let   created  = 0;

  /* Check which accounts already exist */
  const existChecks = await Promise.all(
    STANDARD_ACCOUNTS.map(a => colRef.doc(`${sellerId}_${a.code}`).get())
  );

  for (let i = 0; i < STANDARD_ACCOUNTS.length; i++) {
    if (existChecks[i].exists) continue;
    const acct   = STANDARD_ACCOUNTS[i];
    const docRef = colRef.doc(`${sellerId}_${acct.code}`);
    batch.set(docRef, {
      sellerId,
      code:        acct.code,
      name:        acct.name,
      type:        acct.type,
      subType:     acct.subType,
      isSystem:    true,
      isActive:    true,
      description: '',
      createdBy:   auth.uid,
      createdAt:   _TS(),
      updatedAt:   _TS(),
    });
    created++;
  }

  if (created > 0) await batch.commit();

  _log('INFO', 'initializeChartOfAccounts', { sellerId, created, uid: auth.uid });

  return { success: true, created, message: `${created} accounts initialised` };
});

/**
 * getChartOfAccounts
 * Returns all accounts for a seller grouped by type.
 */
exports.getChartOfAccounts = onCall(_CF, exports._h.getChartOfAccounts = async (req) => {
  const auth = _requireAuth(req);

  const { sellerId } = req.data;
  _requireStr(sellerId, 'sellerId');

  if (auth.uid !== sellerId && !auth.token?.admin && !auth.token?.superAdmin)
    throw new HttpsError('permission-denied', 'Access denied');

  const snap = await db.collection('posAccounts')
    .where('sellerId', '==', sellerId)
    .where('isActive', '==', true)
    .orderBy('code', 'asc')
    .get();

  const grouped = {
    asset:     [],
    liability: [],
    equity:    [],
    revenue:   [],
    cogs:      [],
    expense:   [],
  };

  snap.docs.forEach(d => {
    const a = { id: d.id, ...d.data() };
    /* Remove server timestamps from response */
    delete a.createdAt;
    delete a.updatedAt;
    const t = a.type || 'expense';
    if (grouped[t]) grouped[t].push(a);
  });

  return { success: true, accounts: grouped, total: snap.size };
});

/**
 * createAccount
 * Role: manager+
 * Creates a custom account outside the standard chart.
 */
exports.createAccount = onCall(_CF, exports._h.createAccount = async (req) => {
  const auth = _requireAuth(req);
  _requireRole(auth, 'manager');

  const { sellerId, code, name, type, subType = 'other', description = '' } = req.data;
  _requireStr(sellerId, 'sellerId');
  _requireStr(code, 'code');
  _requireStr(name, 'name');
  _requireStr(type, 'type');

  const validTypes = ['asset', 'liability', 'equity', 'revenue', 'cogs', 'expense'];
  if (!validTypes.includes(type))
    throw new HttpsError('invalid-argument', `type must be one of: ${validTypes.join(', ')}`);

  const cleanCode = _san(code, 10);
  const docId     = `${sellerId}_${cleanCode}`;
  const existing  = await db.collection('posAccounts').doc(docId).get();
  if (existing.exists)
    throw new HttpsError('already-exists', `Account ${cleanCode} already exists`);

  const acctData = {
    sellerId,
    code:        cleanCode,
    name:        _san(name, 100),
    type,
    subType:     _san(subType, 50),
    isSystem:    false,
    isActive:    true,
    description: _san(description, 500),
    createdBy:   auth.uid,
    createdAt:   _TS(),
    updatedAt:   _TS(),
  };

  await db.collection('posAccounts').doc(docId).set(acctData);

  _log('INFO', 'createAccount', { sellerId, code: cleanCode, uid: auth.uid });

  return { success: true, id: docId, ...acctData };
});

/* ═══════════════════════════════════════════════════════════════
   SECTION B — JOURNAL ENTRIES
═══════════════════════════════════════════════════════════════ */

/**
 * createJournalEntry
 * Role: manager+
 * Public callable for manual journal entries.
 * Enforces double-entry balance rule.
 */
exports.createJournalEntry = onCall(_CF, exports._h.createJournalEntry = async (req) => {
  const auth = _requireAuth(req);
  _requireRole(auth, 'manager');

  const { sellerId, entryDate, description, reference, lines } = req.data;
  _requireStr(sellerId, 'sellerId');
  _requireStr(description, 'description');

  const eDate = entryDate ? new Date(entryDate) : new Date();
  if (isNaN(eDate.getTime()))
    throw new HttpsError('invalid-argument', 'entryDate is not a valid date');

  /* Check period is not closed */
  const periodKey = `${sellerId}_${eDate.getFullYear()}-${String(eDate.getMonth() + 1).padStart(2, '0')}`;
  const periodSnap = await db.collection('posAccountingPeriods').doc(periodKey).get();
  if (periodSnap.exists && periodSnap.data().status === 'closed')
    throw new HttpsError('failed-precondition', 'Accounting period is closed. Cannot post entries.');

  let entryId;
  await db.runTransaction(async (txn) => {
    entryId = await _postJournalEntry(txn, {
      sellerId,
      entryDate: eDate,
      description,
      reference: reference || null,
      lines,
      createdBy: auth.uid,
    });
  });

  _log('INFO', 'createJournalEntry', { sellerId, entryId, uid: auth.uid });

  return { success: true, entryId };
});

/**
 * getJournalEntries
 * Query by sellerId, optional date range, optional reference.
 */
exports.getJournalEntries = onCall(_CF, exports._h.getJournalEntries = async (req) => {
  const auth = _requireAuth(req);

  const { sellerId, startDate, endDate, reference, limit: lim = 100 } = req.data;
  _requireStr(sellerId, 'sellerId');

  if (auth.uid !== sellerId && !auth.token?.admin && !auth.token?.superAdmin)
    throw new HttpsError('permission-denied', 'Access denied');

  let query = db.collection('posJournalEntries')
    .where('sellerId', '==', sellerId)
    .orderBy('entryDate', 'desc');

  if (startDate) {
    query = query.where('entryDate', '>=', admin.firestore.Timestamp.fromDate(new Date(startDate)));
  }
  if (endDate) {
    query = query.where('entryDate', '<=', admin.firestore.Timestamp.fromDate(_endOfDay(new Date(endDate))));
  }
  if (reference) {
    query = db.collection('posJournalEntries')
      .where('sellerId', '==', sellerId)
      .where('reference', '==', _san(reference, 100))
      .orderBy('entryDate', 'desc');
  }

  const safeLimit = Math.min(Number(lim) || 100, 100);
  const snap = await query.limit(safeLimit).get();

  const entries = snap.docs.map(d => ({ id: d.id, ...d.data() }));

  return { success: true, entries, count: entries.length };
});

/**
 * voidJournalEntry
 * Role: owner
 * Creates a reversing entry (swaps debit/credit). Marks original as voided.
 */
exports.voidJournalEntry = onCall(_CF, exports._h.voidJournalEntry = async (req) => {
  const auth = _requireAuth(req);
  _requireRole(auth, 'owner');

  const { entryId, reason = 'Void authorised by owner' } = req.data;
  _requireStr(entryId, 'entryId');

  const origRef  = db.collection('posJournalEntries').doc(entryId);
  const origSnap = await origRef.get();

  if (!origSnap.exists)
    throw new HttpsError('not-found', 'Journal entry not found');

  const orig = origSnap.data();

  if (orig.status === 'voided')
    throw new HttpsError('already-exists', 'Entry is already voided');

  /* Verify seller ownership */
  if (orig.sellerId !== req.auth.uid && !auth.token?.admin && !auth.token?.superAdmin)
    throw new HttpsError('permission-denied', 'Access denied');

  /* Build reversing lines (swap debit↔credit) */
  const reversingLines = orig.lines.map(l => ({
    accountCode: l.accountCode,
    accountName: l.accountName,
    debit:       l.credit,
    credit:      l.debit,
  }));

  let reversingId;
  await db.runTransaction(async (txn) => {
    /* Mark original as voided */
    txn.update(origRef, {
      status:    'voided',
      voidedBy:  auth.uid,
      voidedAt:  _TS(),
      voidReason: _san(reason, 500),
    });

    /* Post reversing entry */
    reversingId = await _postJournalEntry(txn, {
      sellerId:    orig.sellerId,
      entryDate:   new Date(),
      description: `REVERSAL: ${orig.description}`,
      reference:   `VOID_${entryId}`,
      lines:       reversingLines,
      createdBy:   auth.uid,
    });
  });

  _log('INFO', 'voidJournalEntry', { entryId, reversingId, uid: auth.uid });

  return { success: true, reversingEntryId: reversingId };
});

/* ═══════════════════════════════════════════════════════════════
   SECTION C — PROFIT & LOSS REPORT
═══════════════════════════════════════════════════════════════ */

/**
 * getProfitAndLoss
 * Aggregates revenue, COGS and expenses for a date range.
 */
exports.getProfitAndLoss = onCall(_CF, exports._h.getProfitAndLoss = async (req) => {
  const auth = _requireAuth(req);

  const { sellerId, startDate, endDate } = req.data;
  _requireStr(sellerId, 'sellerId');

  if (auth.uid !== sellerId && !auth.token?.admin && !auth.token?.superAdmin)
    throw new HttpsError('permission-denied', 'Access denied');

  const start = _startOfDay(_requireDate(startDate, 'startDate'));
  const end   = _endOfDay(_requireDate(endDate, 'endDate'));

  const startTs = admin.firestore.Timestamp.fromDate(start);
  const endTs   = admin.firestore.Timestamp.fromDate(end);

  /* ── Revenue & COGS from posSales ─────────────────────────── */
  const [salesSnap, expensesSnap] = await Promise.all([
    db.collection('posSales')
      .where('sellerId', '==', sellerId)
      .where('createdAt', '>=', startTs)
      .where('createdAt', '<=', endTs)
      .where('status', '!=', 'voided')
      .get(),
    db.collection('posExpenses')
      .where('sellerId', '==', sellerId)
      .where('createdAt', '>=', startTs)
      .where('createdAt', '<=', endTs)
      .where('deleted', '!=', true)
      .get(),
  ]);

  let salesRevenue   = 0;
  let serviceRevenue = 0;
  let otherIncome    = 0;
  let totalCOGS      = 0;

  salesSnap.docs.forEach(d => {
    const sale = d.data();
    const saleType = sale.saleType || 'product';

    if (saleType === 'service') {
      serviceRevenue += _kes(sale.netAmount || sale.total || 0);
    } else if (saleType === 'other') {
      otherIncome += _kes(sale.netAmount || sale.total || 0);
    } else {
      salesRevenue += _kes(sale.netAmount || sale.total || 0);
    }

    /* COGS from line items with costPrice */
    if (Array.isArray(sale.items)) {
      sale.items.forEach(item => {
        const qty       = Number(item.qty)       || 0;
        const costPrice = Number(item.costPrice) || 0;
        totalCOGS += qty * costPrice;
      });
    } else if (sale.costAmount != null) {
      totalCOGS += _kes(sale.costAmount);
    }
  });

  totalCOGS = _kes(totalCOGS);

  /* ── Expenses ─────────────────────────────────────────────── */
  const expenseByCategory = {};
  let   totalExpenses     = 0;

  expensesSnap.docs.forEach(d => {
    const exp = d.data();
    if (exp.deleted) return;
    const cat = _san(exp.category || 'other', 50);
    const amt = _kes(exp.amount || 0);
    expenseByCategory[cat] = _kes((expenseByCategory[cat] || 0) + amt);
    totalExpenses += amt;
  });

  totalExpenses = _kes(totalExpenses);

  const totalRevenue    = _kes(salesRevenue + serviceRevenue + otherIncome);
  const grossProfit     = _kes(totalRevenue - totalCOGS);
  const grossMargin     = totalRevenue > 0
    ? _kes((grossProfit / totalRevenue) * 100) : 0;
  const operatingProfit = _kes(grossProfit - totalExpenses);
  const netProfit       = operatingProfit;   /* No financing charges in current model */
  const netMargin       = totalRevenue > 0
    ? _kes((netProfit / totalRevenue) * 100) : 0;

  const expensesByCategory = Object.entries(expenseByCategory).map(([name, amount]) => ({
    name, amount,
  })).sort((a, b) => b.amount - a.amount);

  return {
    success: true,
    revenue: {
      sales:       _kes(salesRevenue),
      services:    _kes(serviceRevenue),
      otherIncome: _kes(otherIncome),
      total:       totalRevenue,
    },
    cogs: {
      total: totalCOGS,
    },
    grossProfit,
    grossMargin,
    expenses: {
      byCategory: expensesByCategory,
      total:      totalExpenses,
    },
    operatingProfit,
    netProfit,
    netMargin,
    salesCount:    salesSnap.size,
    expenseCount:  expensesSnap.size,
    period: {
      start: start.toISOString(),
      end:   end.toISOString(),
    },
  };
});

/* ═══════════════════════════════════════════════════════════════
   SECTION D — BALANCE SHEET
═══════════════════════════════════════════════════════════════ */

/**
 * getBalanceSheet
 * Role: manager+
 * Reads posAccountBalances to produce a balance sheet as of a date.
 */
exports.getBalanceSheet = onCall(_CF, exports._h.getBalanceSheet = async (req) => {
  const auth = _requireAuth(req);
  _requireRole(auth, 'manager');

  const { sellerId, asOfDate } = req.data;
  _requireStr(sellerId, 'sellerId');

  if (auth.uid !== sellerId && !auth.token?.admin && !auth.token?.superAdmin)
    throw new HttpsError('permission-denied', 'Access denied');

  const asOf = asOfDate ? new Date(asOfDate) : new Date();

  /* Read all account balances */
  const balSnap = await db.collection('posAccountBalances')
    .where('sellerId', '==', sellerId)
    .get();

  /* Also read account metadata for display names */
  const acctSnap = await db.collection('posAccounts')
    .where('sellerId', '==', sellerId)
    .where('isActive', '==', true)
    .get();

  const acctMeta = {};
  acctSnap.docs.forEach(d => {
    const a = d.data();
    acctMeta[a.code] = { name: a.name, subType: a.subType || 'current' };
  });

  const sheet = {
    assets:      { current: [], fixed: [], total: 0 },
    liabilities: { current: [], longTerm: [], total: 0 },
    equity:      { items: [], total: 0 },
  };

  balSnap.docs.forEach(d => {
    const bal  = d.data();
    const code = bal.accountCode;
    const type = bal.accountType || _accountType(code);
    const meta = acctMeta[code] || { name: bal.accountName || code, subType: 'current' };
    const balance = _kes(bal.balance || 0);

    const item = { code, name: meta.name, balance };

    if (type === 'asset') {
      if (meta.subType === 'fixed') {
        sheet.assets.fixed.push(item);
      } else {
        sheet.assets.current.push(item);
      }
      sheet.assets.total = _kes(sheet.assets.total + balance);
    } else if (type === 'liability') {
      if (meta.subType === 'longTerm') {
        sheet.liabilities.longTerm.push(item);
      } else {
        sheet.liabilities.current.push(item);
      }
      sheet.liabilities.total = _kes(sheet.liabilities.total + balance);
    } else if (type === 'equity') {
      sheet.equity.items.push(item);
      sheet.equity.total = _kes(sheet.equity.total + balance);
    }
    /* Revenue/COGS/Expense accounts roll into Retained Earnings on the BS — not listed individually */
  });

  /* Sort each section by code */
  const _sortByCode = (arr) => arr.sort((a, b) => a.code.localeCompare(b.code));
  _sortByCode(sheet.assets.current);
  _sortByCode(sheet.assets.fixed);
  _sortByCode(sheet.liabilities.current);
  _sortByCode(sheet.liabilities.longTerm);
  _sortByCode(sheet.equity.items);

  const liabPlusEquity = _kes(sheet.liabilities.total + sheet.equity.total);
  const isBalanced     = Math.abs(sheet.assets.total - liabPlusEquity) < 0.01;

  return {
    success: true,
    assets:      sheet.assets,
    liabilities: sheet.liabilities,
    equity:      sheet.equity,
    isBalanced,
    variance:    _kes(Math.abs(sheet.assets.total - liabPlusEquity)),
    asOfDate:    asOf.toISOString(),
  };
});

/* ═══════════════════════════════════════════════════════════════
   SECTION E — CASH FLOW STATEMENT
═══════════════════════════════════════════════════════════════ */

/**
 * getCashFlow
 * Role: manager+
 * Indirect method cash flow for the given period.
 */
exports.getCashFlow = onCall(_CF, exports._h.getCashFlow = async (req) => {
  const auth = _requireAuth(req);
  _requireRole(auth, 'manager');

  const { sellerId, startDate, endDate } = req.data;
  _requireStr(sellerId, 'sellerId');

  if (auth.uid !== sellerId && !auth.token?.admin && !auth.token?.superAdmin)
    throw new HttpsError('permission-denied', 'Access denied');

  const start   = _startOfDay(_requireDate(startDate, 'startDate'));
  const end     = _endOfDay(_requireDate(endDate, 'endDate'));
  const startTs = admin.firestore.Timestamp.fromDate(start);
  const endTs   = admin.firestore.Timestamp.fromDate(end);

  const [salesSnap, expensesSnap] = await Promise.all([
    db.collection('posSales')
      .where('sellerId', '==', sellerId)
      .where('createdAt', '>=', startTs)
      .where('createdAt', '<=', endTs)
      .where('status', '!=', 'voided')
      .get(),
    db.collection('posExpenses')
      .where('sellerId', '==', sellerId)
      .where('createdAt', '>=', startTs)
      .where('createdAt', '<=', endTs)
      .where('deleted', '!=', true)
      .get(),
  ]);

  /* Operating inflows: cash + mpesa sales only (actual cash received) */
  let cashInflow    = 0;
  let mpesaInflow   = 0;
  let cardInflow    = 0;
  let creditSales   = 0;

  const inflowByMethod = {};

  salesSnap.docs.forEach(d => {
    const sale   = d.data();
    const method = (sale.paymentMethod || 'cash').toLowerCase();
    const amount = _kes(sale.total || 0);

    inflowByMethod[method] = _kes((inflowByMethod[method] || 0) + amount);

    if (method === 'cash')  cashInflow  += amount;
    else if (method === 'mpesa') mpesaInflow += amount;
    else if (method === 'bank' || method === 'card') cardInflow += amount;
    else if (method === 'credit') creditSales += amount;
  });

  const operatingInflow = _kes(cashInflow + mpesaInflow + cardInflow);

  /* Operating outflows: expenses (excluding owner drawings) */
  let operatingOutflow = 0;
  let ownerDrawings    = 0;

  expensesSnap.docs.forEach(d => {
    const exp = d.data();
    if (exp.deleted) return;
    const cat    = exp.category || 'other';
    const amount = _kes(exp.amount || 0);
    if (cat === 'drawings') {
      ownerDrawings += amount;
    } else {
      operatingOutflow += amount;
    }
  });

  operatingOutflow = _kes(operatingOutflow);
  ownerDrawings    = _kes(ownerDrawings);

  const operatingNet = _kes(operatingInflow - operatingOutflow);

  /* Investing: stub — property/equipment not tracked yet */
  const investingNet = 0;

  /* Financing: owner drawings */
  const financingNet = _kes(-ownerDrawings);  /* outflow */

  const netCashChange = _kes(operatingNet + investingNet + financingNet);

  return {
    success: true,
    operating: {
      inflow:         operatingInflow,
      inflowByMethod,
      outflow:        operatingOutflow,
      net:            operatingNet,
      breakdown: {
        cashSales:    _kes(cashInflow),
        mpesaSales:   _kes(mpesaInflow),
        cardSales:    _kes(cardInflow),
        creditSales:  _kes(creditSales),
      },
    },
    investing: {
      note: 'Property/equipment not yet tracked',
      net:  investingNet,
    },
    financing: {
      ownerDrawings,
      net: financingNet,
    },
    netCashChange,
    period: {
      start: start.toISOString(),
      end:   end.toISOString(),
    },
  };
});

/* ═══════════════════════════════════════════════════════════════
   SECTION F — VAT REPORT
═══════════════════════════════════════════════════════════════ */

/**
 * getVATReport
 * Role: manager+
 * KRA VAT3 return data for a given period (YYYY-MM).
 * KES VAT is 16% tax-inclusive.
 */
exports.getVATReport = onCall(_CF, exports._h.getVATReport = async (req) => {
  const auth = _requireAuth(req);
  _requireRole(auth, 'manager');

  const { sellerId, period } = req.data;
  _requireStr(sellerId, 'sellerId');
  _requireStr(period, 'period');

  if (!/^\d{4}-\d{2}$/.test(period))
    throw new HttpsError('invalid-argument', 'period must be YYYY-MM');

  if (auth.uid !== sellerId && !auth.token?.admin && !auth.token?.superAdmin)
    throw new HttpsError('permission-denied', 'Access denied');

  const { start, end } = _periodStartEnd(period);
  const startTs = admin.firestore.Timestamp.fromDate(start);
  const endTs   = admin.firestore.Timestamp.fromDate(end);

  /* Filing deadline: 20th of following month */
  const [year, month] = period.split('-').map(Number);
  const nextMonth  = month === 12 ? 1 : month + 1;
  const nextYear   = month === 12 ? year + 1 : year;
  const filingDeadline = `${nextYear}-${String(nextMonth).padStart(2, '0')}-20`;

  const [salesSnap, expensesSnap] = await Promise.all([
    db.collection('posSales')
      .where('sellerId', '==', sellerId)
      .where('createdAt', '>=', startTs)
      .where('createdAt', '<=', endTs)
      .where('status', '!=', 'voided')
      .get(),
    db.collection('posExpenses')
      .where('sellerId', '==', sellerId)
      .where('createdAt', '>=', startTs)
      .where('createdAt', '<=', endTs)
      .where('deleted', '!=', true)
      .get(),
  ]);

  /* Output VAT — from sales */
  const saleLines = [];
  let   outputVAT = 0;
  let   netSales  = 0;

  salesSnap.docs.forEach(d => {
    const sale = d.data();
    /* Use stored taxAmount if available; otherwise calculate from total (16% inclusive) */
    const total      = _kes(sale.total || 0);
    const taxAmount  = sale.taxAmount != null
      ? _kes(sale.taxAmount)
      : _kes(total * VAT_RATE / (1 + VAT_RATE));
    const netAmount  = _kes(total - taxAmount);

    outputVAT += taxAmount;
    netSales  += netAmount;

    saleLines.push({
      saleId:        d.id,
      receiptNumber: sale.receiptNumber || null,
      date:          sale.createdAt?.toDate?.()?.toISOString?.() || null,
      customer:      sale.customerName  || 'Walk-in',
      grossAmount:   total,
      netAmount,
      vatAmount:     taxAmount,
      vatRate:       16,
    });
  });

  outputVAT = _kes(outputVAT);
  netSales  = _kes(netSales);

  /* Input VAT — from expenses with vatRate > 0 */
  const expenseLines = [];
  let   inputVAT     = 0;

  expensesSnap.docs.forEach(d => {
    const exp = d.data();
    if (exp.deleted) return;
    const vatAmt = _kes(exp.vatAmount || 0);
    if (vatAmt > 0) {
      inputVAT += vatAmt;
      expenseLines.push({
        expenseId:     d.id,
        date:          exp.createdAt?.toDate?.()?.toISOString?.() || null,
        vendor:        exp.vendorName || 'Unknown vendor',
        receiptNumber: exp.receiptNumber || null,
        grossAmount:   _kes(exp.amount || 0),
        vatAmount:     vatAmt,
        netAmount:     _kes(exp.netAmount || (exp.amount || 0) - vatAmt),
      });
    }
  });

  inputVAT = _kes(inputVAT);

  const netVATPayable = _kes(outputVAT - inputVAT);

  return {
    success: true,
    period,
    filingDeadline,
    outputVAT: {
      taxableNetSales: netSales,
      vatCollected:    outputVAT,
      lineItems:       saleLines,
      count:           saleLines.length,
    },
    inputVAT: {
      vatPaid:   inputVAT,
      lineItems: expenseLines,
      count:     expenseLines.length,
    },
    netVATPayable,
    vatPayableDirection: netVATPayable >= 0 ? 'payable_to_kra' : 'credit_from_kra',
    kraVATRate:          16,
    currency:            'KES',
  };
});

/* ═══════════════════════════════════════════════════════════════
   SECTION G — EXPENSE TRACKING
═══════════════════════════════════════════════════════════════ */

const EXPENSE_CATEGORIES = [
  'rent', 'salaries', 'utilities', 'marketing',
  'delivery', 'supplies', 'drawings', 'other',
];

const PAYMENT_METHODS_EXPENSE = ['cash', 'mpesa', 'bank', 'card'];

/**
 * createExpense
 * Role: manager+
 * Creates expense record and auto-posts double-entry journal.
 */
exports.createExpense = onCall(_CF, exports._h.createExpense = async (req) => {
  const auth = _requireAuth(req);
  _requireRole(auth, 'manager');

  const {
    sellerId,
    amount,
    category       = 'other',
    description,
    paymentMethod  = 'cash',
    receiptNumber  = '',
    vendorName     = '',
    attachmentUrl  = '',
    vatRate        = 0,
  } = req.data;

  _requireStr(sellerId, 'sellerId');
  _requireStr(description, 'description');
  const cleanAmount = _requireNum(amount, 'amount', 0.01);

  if (!EXPENSE_CATEGORIES.includes(category))
    throw new HttpsError('invalid-argument', `category must be one of: ${EXPENSE_CATEGORIES.join(', ')}`);

  if (!PAYMENT_METHODS_EXPENSE.includes(paymentMethod))
    throw new HttpsError('invalid-argument', `paymentMethod must be one of: ${PAYMENT_METHODS_EXPENSE.join(', ')}`);

  /* VAT calculation on expense */
  const vatRateFrac = Number(vatRate) > 0 ? Number(vatRate) / 100 : 0;
  const vatAmount   = vatRateFrac > 0 ? _kes(cleanAmount * vatRateFrac / (1 + vatRateFrac)) : 0;
  const netAmount   = _kes(cleanAmount - vatAmount);

  const expenseId  = _newId('EXP');
  const expenseRef = db.collection('posExpenses').doc(expenseId);

  /* Map to account codes */
  const expAcctCode = EXPENSE_ACCOUNT_MAP[category] || '6006';
  const expAcct     = STANDARD_ACCOUNTS.find(a => a.code === expAcctCode);
  const expAcctName = expAcct ? expAcct.name : 'Other Expenses';

  const payAcctCode = PAYMENT_ACCOUNT_MAP[paymentMethod] || '1001';
  const payAcct     = STANDARD_ACCOUNTS.find(a => a.code === payAcctCode);
  const payAcctName = payAcct ? payAcct.name : 'Cash on Hand';

  const expenseData = {
    sellerId,
    amount:        cleanAmount,
    vatAmount,
    netAmount,
    vatRate:       vatRateFrac * 100,
    category:      _san(category, 50),
    description:   _san(description, 500),
    paymentMethod: _san(paymentMethod, 20),
    receiptNumber: _san(receiptNumber, 50),
    vendorName:    _san(vendorName, 100),
    attachmentUrl: _san(attachmentUrl, 1000),
    deleted:       false,
    createdBy:     auth.uid,
    createdAt:     _TS(),
    updatedAt:     _TS(),
  };

  /* Build journal lines:
     Debit: Expense account (increases expense)
     Credit: Cash/Bank account (decreases asset) */
  const journalLines = [
    {
      accountCode: expAcctCode,
      accountName: expAcctName,
      debit:       cleanAmount,
      credit:      0,
    },
    {
      accountCode: payAcctCode,
      accountName: payAcctName,
      debit:       0,
      credit:      cleanAmount,
    },
  ];

  /* If VAT is present, split the debit into net + VAT Input */
  // For simplicity, we post to expense account at gross; VAT input is tracked on the expense doc
  // A more advanced split would use a VAT Input account (not in standard chart here)

  let entryId;
  await db.runTransaction(async (txn) => {
    txn.set(expenseRef, expenseData);

    entryId = await _postJournalEntry(txn, {
      sellerId,
      entryDate:   new Date(),
      description: `Expense: ${_san(description, 100)}`,
      reference:   expenseId,
      lines:       journalLines,
      createdBy:   auth.uid,
    });
  });

  _log('INFO', 'createExpense', { sellerId, expenseId, amount: cleanAmount, category, uid: auth.uid });

  return { success: true, expenseId, journalEntryId: entryId, ...expenseData };
});

/**
 * getExpenses
 * Query by sellerId with optional category + date range.
 */
exports.getExpenses = onCall(_CF, exports._h.getExpenses = async (req) => {
  const auth = _requireAuth(req);

  const { sellerId, category, startDate, endDate, limit: lim = 100 } = req.data;
  _requireStr(sellerId, 'sellerId');

  if (auth.uid !== sellerId && !auth.token?.admin && !auth.token?.superAdmin)
    throw new HttpsError('permission-denied', 'Access denied');

  let query = db.collection('posExpenses')
    .where('sellerId', '==', sellerId)
    .where('deleted', '!=', true);

  if (category && EXPENSE_CATEGORIES.includes(category)) {
    query = query.where('category', '==', category);
  }

  if (startDate) {
    query = query.where('createdAt', '>=', admin.firestore.Timestamp.fromDate(new Date(startDate)));
  }
  if (endDate) {
    query = query.where('createdAt', '<=', admin.firestore.Timestamp.fromDate(_endOfDay(new Date(endDate))));
  }

  query = query.orderBy('createdAt', 'desc');

  const safeLimit = Math.min(Number(lim) || 100, 100);
  const snap      = await query.limit(safeLimit).get();

  const expenses = snap.docs.map(d => ({ id: d.id, ...d.data() }));

  return { success: true, expenses, count: expenses.length };
});

/**
 * updateExpense
 * Role: manager+
 * Update allowed fields only.
 */
exports.updateExpense = onCall(_CF, exports._h.updateExpense = async (req) => {
  const auth = _requireAuth(req);
  _requireRole(auth, 'manager');

  const { expenseId, description, category, amount, receiptNumber, vatRate } = req.data;
  _requireStr(expenseId, 'expenseId');

  const expRef  = db.collection('posExpenses').doc(expenseId);
  const expSnap = await expRef.get();

  if (!expSnap.exists)  throw new HttpsError('not-found',    'Expense not found');
  if (expSnap.data().deleted) throw new HttpsError('not-found', 'Expense not found');
  if (expSnap.data().sellerId !== auth.uid && !auth.token?.admin && !auth.token?.superAdmin)
    throw new HttpsError('permission-denied', 'Access denied');

  const updates = { updatedAt: _TS(), updatedBy: auth.uid };

  if (description != null) updates.description   = _san(description, 500);
  if (category    != null) {
    if (!EXPENSE_CATEGORIES.includes(category))
      throw new HttpsError('invalid-argument', 'Invalid category');
    updates.category = category;
  }
  if (receiptNumber != null) updates.receiptNumber = _san(receiptNumber, 50);

  if (amount != null) {
    const newAmount = _requireNum(amount, 'amount', 0.01);
    const vr = vatRate != null ? Number(vatRate) / 100 : (expSnap.data().vatRate || 0) / 100;
    updates.amount    = newAmount;
    updates.vatAmount = vr > 0 ? _kes(newAmount * vr / (1 + vr)) : 0;
    updates.netAmount = _kes(newAmount - updates.vatAmount);
  }

  await expRef.update(updates);

  _log('INFO', 'updateExpense', { expenseId, uid: auth.uid });

  return { success: true, expenseId };
});

/**
 * deleteExpense
 * Role: owner
 * Soft delete.
 */
exports.deleteExpense = onCall(_CF, exports._h.deleteExpense = async (req) => {
  const auth = _requireAuth(req);
  _requireRole(auth, 'owner');

  const { expenseId } = req.data;
  _requireStr(expenseId, 'expenseId');

  const expRef  = db.collection('posExpenses').doc(expenseId);
  const expSnap = await expRef.get();

  if (!expSnap.exists || expSnap.data().deleted)
    throw new HttpsError('not-found', 'Expense not found');
  if (expSnap.data().sellerId !== auth.uid && !auth.token?.admin && !auth.token?.superAdmin)
    throw new HttpsError('permission-denied', 'Access denied');

  await expRef.update({
    deleted:   true,
    deletedBy: auth.uid,
    deletedAt: _TS(),
  });

  _log('INFO', 'deleteExpense', { expenseId, uid: auth.uid });

  return { success: true };
});

/**
 * getExpenseSummary
 * Returns total expenses by category for a date range.
 */
exports.getExpenseSummary = onCall(_CF, exports._h.getExpenseSummary = async (req) => {
  const auth = _requireAuth(req);

  const { sellerId, startDate, endDate } = req.data;
  _requireStr(sellerId, 'sellerId');

  if (auth.uid !== sellerId && !auth.token?.admin && !auth.token?.superAdmin)
    throw new HttpsError('permission-denied', 'Access denied');

  const start   = _startOfDay(_requireDate(startDate, 'startDate'));
  const end     = _endOfDay(_requireDate(endDate, 'endDate'));
  const startTs = admin.firestore.Timestamp.fromDate(start);
  const endTs   = admin.firestore.Timestamp.fromDate(end);

  const snap = await db.collection('posExpenses')
    .where('sellerId', '==', sellerId)
    .where('createdAt', '>=', startTs)
    .where('createdAt', '<=', endTs)
    .where('deleted', '!=', true)
    .get();

  const byCategory = {};
  let   grandTotal = 0;

  snap.docs.forEach(d => {
    const exp = d.data();
    if (exp.deleted) return;
    const cat = exp.category || 'other';
    const amt = _kes(exp.amount || 0);
    byCategory[cat] = _kes((byCategory[cat] || 0) + amt);
    grandTotal += amt;
  });

  const summary = Object.entries(byCategory)
    .map(([category, total]) => ({
      category,
      total,
      percentage: grandTotal > 0 ? _kes((total / grandTotal) * 100) : 0,
    }))
    .sort((a, b) => b.total - a.total);

  return {
    success:    true,
    summary,
    grandTotal: _kes(grandTotal),
    count:      snap.size,
    period: {
      start: start.toISOString(),
      end:   end.toISOString(),
    },
  };
});

/* ═══════════════════════════════════════════════════════════════
   SECTION H — ACCOUNTING PERIOD CLOSE
═══════════════════════════════════════════════════════════════ */

/**
 * closeAccountingPeriod
 * Role: owner
 * Marks a period closed, preventing further journal entries.
 * Creates a retained earnings closing entry.
 */
exports.closeAccountingPeriod = onCall(_CF, exports._h.closeAccountingPeriod = async (req) => {
  const auth = _requireAuth(req);
  _requireRole(auth, 'owner');

  const { sellerId, period } = req.data;
  _requireStr(sellerId, 'sellerId');
  _requireStr(period, 'period');

  if (!/^\d{4}-\d{2}$/.test(period))
    throw new HttpsError('invalid-argument', 'period must be YYYY-MM');

  if (auth.uid !== sellerId && !auth.token?.admin && !auth.token?.superAdmin)
    throw new HttpsError('permission-denied', 'Access denied');

  const periodDocId = `${sellerId}_${period}`;
  const periodRef   = db.collection('posAccountingPeriods').doc(periodDocId);
  const periodSnap  = await periodRef.get();

  if (periodSnap.exists && periodSnap.data().status === 'closed')
    throw new HttpsError('already-exists', `Period ${period} is already closed`);

  const { start, end } = _periodStartEnd(period);

  /* Compute net income for the period (P&L roll-up) */
  const startTs = admin.firestore.Timestamp.fromDate(start);
  const endTs   = admin.firestore.Timestamp.fromDate(end);

  const [salesSnap, expensesSnap] = await Promise.all([
    db.collection('posSales')
      .where('sellerId', '==', sellerId)
      .where('createdAt', '>=', startTs)
      .where('createdAt', '<=', endTs)
      .where('status', '!=', 'voided')
      .get(),
    db.collection('posExpenses')
      .where('sellerId', '==', sellerId)
      .where('createdAt', '>=', startTs)
      .where('createdAt', '<=', endTs)
      .where('deleted', '!=', true)
      .get(),
  ]);

  let totalRevenue  = 0;
  let totalCOGS     = 0;
  let totalExpenses = 0;

  salesSnap.docs.forEach(d => {
    const sale = d.data();
    totalRevenue += _kes(sale.netAmount || sale.total || 0);
    if (Array.isArray(sale.items)) {
      sale.items.forEach(item => {
        totalCOGS += (Number(item.qty) || 0) * (Number(item.costPrice) || 0);
      });
    } else if (sale.costAmount != null) {
      totalCOGS += _kes(sale.costAmount);
    }
  });

  expensesSnap.docs.forEach(d => {
    const exp = d.data();
    if (!exp.deleted) totalExpenses += _kes(exp.amount || 0);
  });

  const netIncome = _kes(totalRevenue - totalCOGS - totalExpenses);

  let closingEntryId = null;

  await db.runTransaction(async (txn) => {
    /* Closing entry: transfer net income to Retained Earnings */
    if (Math.abs(netIncome) > 0) {
      /*
       * If profitable: Debit Sales Revenue (4001) / Credit Retained Earnings (3100)
       * If a loss:     Debit Retained Earnings (3100) / Credit Expense accounts
       * Simplified closing: use a single summary line pair
       */
      const closingLines = netIncome >= 0
        ? [
            { accountCode: '4001', accountName: 'Sales Revenue',    debit: _kes(netIncome), credit: 0 },
            { accountCode: '3100', accountName: 'Retained Earnings', debit: 0, credit: _kes(netIncome) },
          ]
        : [
            { accountCode: '3100', accountName: 'Retained Earnings', debit: _kes(Math.abs(netIncome)), credit: 0 },
            { accountCode: '6006', accountName: 'Other Expenses',    debit: 0, credit: _kes(Math.abs(netIncome)) },
          ];

      closingEntryId = await _postJournalEntry(txn, {
        sellerId,
        entryDate:   end,
        description: `Period closing entry — ${period}`,
        reference:   `CLOSE_${period}`,
        lines:       closingLines,
        createdBy:   auth.uid,
      });
    }

    /* Mark period as closed */
    txn.set(periodRef, {
      sellerId,
      period,
      status:          'closed',
      closedBy:        auth.uid,
      closedAt:        _TS(),
      netIncome,
      totalRevenue:    _kes(totalRevenue),
      totalCOGS:       _kes(totalCOGS),
      totalExpenses:   _kes(totalExpenses),
      closingEntryId:  closingEntryId || null,
      periodStart:     admin.firestore.Timestamp.fromDate(start),
      periodEnd:       admin.firestore.Timestamp.fromDate(end),
      createdAt:       _TS(),
    }, { merge: true });
  });

  _log('INFO', 'closeAccountingPeriod', { sellerId, period, netIncome, closingEntryId, uid: auth.uid });

  return {
    success:         true,
    period,
    status:          'closed',
    netIncome,
    closingEntryId,
  };
});

/**
 * getAccountingPeriods
 * Returns list of accounting periods with status.
 */
exports.getAccountingPeriods = onCall(_CF, exports._h.getAccountingPeriods = async (req) => {
  const auth = _requireAuth(req);

  const { sellerId } = req.data;
  _requireStr(sellerId, 'sellerId');

  if (auth.uid !== sellerId && !auth.token?.admin && !auth.token?.superAdmin)
    throw new HttpsError('permission-denied', 'Access denied');

  const snap = await db.collection('posAccountingPeriods')
    .where('sellerId', '==', sellerId)
    .orderBy('period', 'desc')
    .limit(24)          /* last 2 years */
    .get();

  const periods = snap.docs.map(d => {
    const data = d.data();
    return {
      id:              d.id,
      period:          data.period,
      status:          data.status || 'open',
      netIncome:       data.netIncome       || null,
      totalRevenue:    data.totalRevenue    || null,
      totalExpenses:   data.totalExpenses   || null,
      closedBy:        data.closedBy        || null,
      closedAt:        data.closedAt        || null,
      closingEntryId:  data.closingEntryId  || null,
    };
  });

  return { success: true, periods, count: periods.length };
});

/* ═══════════════════════════════════════════════════════════════
   SECTION I — ACCOUNTING EXPORT
═══════════════════════════════════════════════════════════════ */

/* QuickBooks / Xero compatible column order */
const QB_COLUMNS = [
  'Date', 'TransactionType', 'Num', 'Name', 'Memo',
  'Account', 'Debit', 'Credit', 'Currency',
];

/**
 * exportAccountingData
 * Role: owner
 * Returns journal entries + P&L as structured data for download.
 * format = 'csv' | 'json'
 */
exports.exportAccountingData = onCall(_CF, exports._h.exportAccountingData = async (req) => {
  const auth = _requireAuth(req);
  _requireRole(auth, 'owner');

  const { sellerId, format = 'json', startDate, endDate } = req.data;
  _requireStr(sellerId, 'sellerId');

  if (!['csv', 'json'].includes(format))
    throw new HttpsError('invalid-argument', 'format must be csv or json');

  if (auth.uid !== sellerId && !auth.token?.admin && !auth.token?.superAdmin)
    throw new HttpsError('permission-denied', 'Access denied');

  const start   = _startOfDay(_requireDate(startDate, 'startDate'));
  const end     = _endOfDay(_requireDate(endDate, 'endDate'));
  const startTs = admin.firestore.Timestamp.fromDate(start);
  const endTs   = admin.firestore.Timestamp.fromDate(end);

  /* Fetch journal entries for period */
  const journalSnap = await db.collection('posJournalEntries')
    .where('sellerId', '==', sellerId)
    .where('entryDate', '>=', startTs)
    .where('entryDate', '<=', endTs)
    .orderBy('entryDate', 'asc')
    .limit(500)
    .get();

  /* Flatten journal entries to transaction lines */
  const rows = [];
  journalSnap.docs.forEach(d => {
    const entry = d.data();
    const dateStr = entry.entryDate?.toDate?.()?.toISOString?.()?.slice(0, 10) || '';
    (entry.lines || []).forEach(line => {
      rows.push({
        Date:            dateStr,
        TransactionType: 'Journal',
        Num:             d.id,
        Name:            entry.description || '',
        Memo:            entry.reference   || '',
        Account:         `${line.accountCode} - ${line.accountName}`,
        Debit:           line.debit  > 0 ? _kes(line.debit)  : '',
        Credit:          line.credit > 0 ? _kes(line.credit) : '',
        Currency:        'KES',
        Status:          entry.status || 'posted',
      });
    });
  });

  /* Fetch P&L summary */
  const [salesSnap, expensesSnap] = await Promise.all([
    db.collection('posSales')
      .where('sellerId', '==', sellerId)
      .where('createdAt', '>=', startTs)
      .where('createdAt', '<=', endTs)
      .where('status', '!=', 'voided')
      .get(),
    db.collection('posExpenses')
      .where('sellerId', '==', sellerId)
      .where('createdAt', '>=', startTs)
      .where('createdAt', '<=', endTs)
      .where('deleted', '!=', true)
      .get(),
  ]);

  let totalRevenue  = 0;
  let totalCOGS     = 0;
  let totalExpenses = 0;
  const expByCat    = {};

  salesSnap.docs.forEach(d => {
    const s = d.data();
    totalRevenue += _kes(s.netAmount || s.total || 0);
    if (Array.isArray(s.items)) {
      s.items.forEach(i => {
        totalCOGS += (Number(i.qty) || 0) * (Number(i.costPrice) || 0);
      });
    }
  });

  expensesSnap.docs.forEach(d => {
    const e = d.data();
    if (e.deleted) return;
    const cat = e.category || 'other';
    const amt = _kes(e.amount || 0);
    expByCat[cat] = _kes((expByCat[cat] || 0) + amt);
    totalExpenses += amt;
  });

  const grossProfit = _kes(totalRevenue - totalCOGS);
  const netProfit   = _kes(grossProfit - totalExpenses);

  const pl = {
    totalRevenue:    _kes(totalRevenue),
    totalCOGS:       _kes(totalCOGS),
    grossProfit,
    totalExpenses:   _kes(totalExpenses),
    expensesByCategory: expByCat,
    netProfit,
    currency:        'KES',
    period:          { start: start.toISOString(), end: end.toISOString() },
  };

  if (format === 'json') {
    return {
      success:        true,
      format:         'json',
      journalEntries: rows,
      profitAndLoss:  pl,
      exportedAt:     new Date().toISOString(),
      recordCount:    rows.length,
      columns:        QB_COLUMNS,
    };
  }

  /* Build CSV string (QuickBooks IIF-style) */
  const escape = (v) => {
    const s = String(v == null ? '' : v);
    /* Wrap in quotes if contains comma, quote, or newline */
    if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };

  const csvLines = [QB_COLUMNS.join(',')];
  rows.forEach(r => {
    csvLines.push(QB_COLUMNS.map(col => escape(r[col] ?? '')).join(','));
  });

  const csvString = csvLines.join('\n');

  return {
    success:     true,
    format:      'csv',
    csv:         csvString,
    profitAndLoss: pl,
    exportedAt:  new Date().toISOString(),
    recordCount: rows.length,
  };
});

/* ═══════════════════════════════════════════════════════════════
   SECTION J — SCHEDULED: MONTHLY ACCOUNTING SNAPSHOT
   Runs every 24 hours. On the 1st of each month, creates a
   P&L snapshot for the previous month in posAccountingPeriods.
═══════════════════════════════════════════════════════════════ */

exports.monthlyAccountingSnapshot = onSchedule(
  {
    schedule:        'every 24 hours',
    timeZone:        'Africa/Nairobi',
    region:          'us-central1',
    memory:          '512MiB',
    timeoutSeconds:  540,
  },
  async (_event) => {
    const now = new Date();

    /* Only run on the 1st of each month (Nairobi time) */
    if (now.getDate() !== 1) {
      _log('INFO', 'monthlyAccountingSnapshot: not 1st of month, skipping');
      return;
    }

    /* Determine previous month */
    const prevMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const year      = prevMonth.getFullYear();
    const month     = String(prevMonth.getMonth() + 1).padStart(2, '0');
    const period    = `${year}-${month}`;

    const { start, end } = _periodStartEnd(period);
    const startTs = admin.firestore.Timestamp.fromDate(start);
    const endTs   = admin.firestore.Timestamp.fromDate(end);

    _log('INFO', `monthlyAccountingSnapshot: generating snapshot for ${period}`);

    /* Find all unique sellerIds that had sales in the period */
    const salesSnap = await db.collection('posSales')
      .where('createdAt', '>=', startTs)
      .where('createdAt', '<=', endTs)
      .select('sellerId')
      .get();

    const sellerIds = [...new Set(salesSnap.docs.map(d => d.data().sellerId).filter(Boolean))];

    _log('INFO', `monthlyAccountingSnapshot: found ${sellerIds.length} sellers for ${period}`);

    let snapshots = 0;
    const errors  = [];

    for (const sellerId of sellerIds) {
      try {
        /* Skip if period already has a snapshot */
        const periodDocId  = `${sellerId}_${period}`;
        const periodDocRef = db.collection('posAccountingPeriods').doc(periodDocId);
        const periodDoc    = await periodDocRef.get();

        if (periodDoc.exists && periodDoc.data().snapshotCreatedAt) {
          _log('INFO', `monthlyAccountingSnapshot: ${periodDocId} already snapshotted, skipping`);
          continue;
        }

        /* Compute P&L for this seller */
        const [sellerSalesSnap, sellerExpensesSnap] = await Promise.all([
          db.collection('posSales')
            .where('sellerId', '==', sellerId)
            .where('createdAt', '>=', startTs)
            .where('createdAt', '<=', endTs)
            .where('status', '!=', 'voided')
            .get(),
          db.collection('posExpenses')
            .where('sellerId', '==', sellerId)
            .where('createdAt', '>=', startTs)
            .where('createdAt', '<=', endTs)
            .where('deleted', '!=', true)
            .get(),
        ]);

        let totalRevenue  = 0;
        let totalCOGS     = 0;
        let totalExpenses = 0;
        const expByCat    = {};

        sellerSalesSnap.docs.forEach(d => {
          const s = d.data();
          totalRevenue += _kes(s.netAmount || s.total || 0);
          if (Array.isArray(s.items)) {
            s.items.forEach(i => {
              totalCOGS += (Number(i.qty) || 0) * (Number(i.costPrice) || 0);
            });
          } else if (s.costAmount != null) {
            totalCOGS += _kes(s.costAmount);
          }
        });

        sellerExpensesSnap.docs.forEach(d => {
          const e = d.data();
          if (e.deleted) return;
          const cat = e.category || 'other';
          const amt = _kes(e.amount || 0);
          expByCat[cat] = _kes((expByCat[cat] || 0) + amt);
          totalExpenses += amt;
        });

        const grossProfit = _kes(totalRevenue - totalCOGS);
        const netIncome   = _kes(grossProfit - totalExpenses);

        /* Store or merge snapshot into posAccountingPeriods */
        await periodDocRef.set(
          {
            sellerId,
            period,
            status:              periodDoc.exists ? periodDoc.data().status : 'open',
            totalRevenue:        _kes(totalRevenue),
            totalCOGS:           _kes(totalCOGS),
            grossProfit,
            totalExpenses:       _kes(totalExpenses),
            expensesByCategory:  expByCat,
            netIncome,
            salesCount:          sellerSalesSnap.size,
            expenseCount:        sellerExpensesSnap.size,
            currency:            'KES',
            periodStart:         admin.firestore.Timestamp.fromDate(start),
            periodEnd:           admin.firestore.Timestamp.fromDate(end),
            snapshotCreatedAt:   admin.firestore.FieldValue.serverTimestamp(),
            snapshotVersion:     1,
          },
          { merge: true }
        );

        snapshots++;
        _log('INFO', `monthlyAccountingSnapshot: snapshotted ${sellerId} for ${period}`, {
          totalRevenue: _kes(totalRevenue),
          netIncome,
        });
      } catch (err) {
        errors.push({ sellerId, error: err.message });
        _log('ERROR', `monthlyAccountingSnapshot: error for ${sellerId}`, { error: err.message });
      }
    }

    _log('INFO', 'monthlyAccountingSnapshot: complete', {
      period,
      sellersProcessed: sellerIds.length,
      snapshots,
      errors: errors.length,
    });
  }
);
