'use strict';
/**
 * SOKONI Finance OS — Sprint 4.3
 * Budgeting | Expense Management | Bank Reconciliation |
 * Tax Calendar | Financial Statements | Petty Cash | Invoices
 * 37 Cloud Functions
 */

const { onCall } = require('firebase-functions/v2/https');
const admin      = require('firebase-admin');
const { defineSecret } = require('firebase-functions/params');

const SENDGRID_KEY = defineSecret('SENDGRID_API_KEY');

// ── helpers ──────────────────────────────────────────────────────────────────
function _db()  { return admin.firestore(); }
function _fv()  { return admin.firestore.FieldValue; }
function _ts()  { return admin.firestore.FieldValue.serverTimestamp(); }
function _id()  { return _db().collection('_').doc().id; }

function _uid(req) {
  if (!req.auth || !req.auth.uid) throw new Error('unauthenticated');
  return req.auth.uid;
}

async function _assertShop(uid, shopId) {
  if (!shopId) throw new Error('shopId required');
  const snap = await _db().collection('shops').doc(shopId).get();
  if (!snap.exists) throw new Error('shop not found');
  const shop = snap.data();
  if (shop.ownerId === uid) return 'owner';
  const userSnap = await _db().collection('users').doc(uid).get();
  if (userSnap.exists && userSnap.data().role === 'admin') return 'admin';
  const empSnap = await _db().collection('shopEmployees')
    .where('shopId', '==', shopId).where('userId', '==', uid).limit(1).get();
  if (empSnap.empty) throw new Error('forbidden');
  return empSnap.docs[0].data().role || 'employee';
}

async function _assertShopManager(uid, shopId) {
  const role = await _assertShop(uid, shopId);
  if (role === 'employee') throw new Error('manager or owner access required');
  return role;
}

const _CALL = { region: 'us-central1', enforceAppCheck: true };

// Handler registry — consumed by finance-sprint-dispatch.js
exports._h = {};

// ─────────────────────────────────────────────────────────────────────────────
// BUDGETING  (6 CFs)
// Collections: budgets/{id}
// ─────────────────────────────────────────────────────────────────────────────

exports.budgetCreate = onCall(_CALL, exports._h.budgetCreate = async (req) => {
  const uid = _uid(req);
  const { shopId, name, period, startDate, endDate, totalAmount, categories, currency } = req.data;
  await _assertShopManager(uid, shopId);
  if (!name || !period || !startDate || !endDate || !totalAmount) throw new Error('Missing required fields');
  if (!['monthly', 'quarterly', 'annual', 'custom'].includes(period)) throw new Error('invalid period');
  if (totalAmount <= 0) throw new Error('totalAmount must be > 0');
  const cats = Array.isArray(categories) ? categories : [];
  if (cats.reduce((s, c) => s + (c.allocated || 0), 0) > totalAmount) throw new Error('allocations exceed totalAmount');
  const id = _id();
  await _db().collection('budgets').doc(id).set({
    id, shopId, name, period,
    startDate: new Date(startDate).toISOString(),
    endDate:   new Date(endDate).toISOString(),
    totalAmount, currency: currency || 'KES',
    categories: cats.map(c => ({ name: c.name, allocated: c.allocated || 0, spent: 0 })),
    status: 'active', createdBy: uid, createdAt: _ts(), updatedAt: _ts(),
  });
  return { budgetId: id };
});

exports.budgetUpdate = onCall(_CALL, exports._h.budgetUpdate = async (req) => {
  const uid = _uid(req);
  const { budgetId, shopId } = req.data;
  await _assertShopManager(uid, shopId);
  const snap = await _db().collection('budgets').doc(budgetId).get();
  if (!snap.exists || snap.data().shopId !== shopId) throw new Error('budget not found');
  const upd = { updatedAt: _ts() };
  if (req.data.name)       upd.name       = req.data.name;
  if (req.data.totalAmount > 0) upd.totalAmount = req.data.totalAmount;
  if (req.data.categories) upd.categories = req.data.categories;
  if (req.data.status)     upd.status     = req.data.status;
  await _db().collection('budgets').doc(budgetId).update(upd);
  return { success: true };
});

exports.budgetGet = onCall(_CALL, exports._h.budgetGet = async (req) => {
  const uid = _uid(req);
  const { budgetId, shopId } = req.data;
  await _assertShop(uid, shopId);
  const snap = await _db().collection('budgets').doc(budgetId).get();
  if (!snap.exists || snap.data().shopId !== shopId) throw new Error('budget not found');
  const b = snap.data();
  const totalSpent = (b.categories || []).reduce((s, c) => s + (c.spent || 0), 0);
  return { budget: { ...b, totalSpent, remaining: b.totalAmount - totalSpent } };
});

exports.budgetList = onCall(_CALL, exports._h.budgetList = async (req) => {
  const uid = _uid(req);
  const { shopId, status } = req.data;
  await _assertShop(uid, shopId);
  const snap = await _db().collection('budgets').where('shopId', '==', shopId).limit(50).get();
  let budgets = snap.docs.map(d => d.data());
  if (status) budgets = budgets.filter(b => b.status === status);
  budgets.sort((a, b) => {
    const ta = a.createdAt ? (a.createdAt.toMillis ? a.createdAt.toMillis() : 0) : 0;
    const tb = b.createdAt ? (b.createdAt.toMillis ? b.createdAt.toMillis() : 0) : 0;
    return tb - ta;
  });
  return { budgets };
});

exports.budgetRecordExpense = onCall(_CALL, exports._h.budgetRecordExpense = async (req) => {
  const uid = _uid(req);
  const { budgetId, shopId, categoryName, amount } = req.data;
  await _assertShop(uid, shopId);
  if (!categoryName || !amount || amount <= 0) throw new Error('categoryName and amount required');
  await _db().runTransaction(async tx => {
    const ref  = _db().collection('budgets').doc(budgetId);
    const snap = await tx.get(ref);
    if (!snap.exists || snap.data().shopId !== shopId) throw new Error('budget not found');
    const cats = (snap.data().categories || []).map(c =>
      c.name === categoryName ? { ...c, spent: (c.spent || 0) + amount } : c
    );
    tx.update(ref, { categories: cats, updatedAt: _ts() });
  });
  return { success: true };
});

exports.budgetGetAlerts = onCall(_CALL, exports._h.budgetGetAlerts = async (req) => {
  const uid = _uid(req);
  const { shopId } = req.data;
  await _assertShop(uid, shopId);
  const snap = await _db().collection('budgets')
    .where('shopId', '==', shopId).where('status', '==', 'active').limit(20).get();
  const alerts = [];
  snap.docs.forEach(d => {
    const b = d.data();
    (b.categories || []).forEach(c => {
      if (!c.allocated) return;
      const pct = ((c.spent || 0) / c.allocated) * 100;
      if (pct >= 80) alerts.push({
        budgetId: b.id, budgetName: b.name, category: c.name,
        allocated: c.allocated, spent: c.spent || 0,
        pct: Math.round(pct), severity: pct >= 100 ? 'exceeded' : 'warning',
      });
    });
  });
  return { alerts };
});

// ─────────────────────────────────────────────────────────────────────────────
// EXPENSE MANAGEMENT  (7 CFs)
// Collections: expenseClaims/{id}
// ─────────────────────────────────────────────────────────────────────────────

exports.expenseCreate = onCall(_CALL, exports._h.expenseCreate = async (req) => {
  const uid = _uid(req);
  const { shopId, amount, category, description, receiptUrl, date, currency } = req.data;
  await _assertShop(uid, shopId);
  if (!amount || amount <= 0) throw new Error('amount must be > 0');
  if (!description) throw new Error('description required');
  const id = _id();
  await _db().collection('expenseClaims').doc(id).set({
    id, shopId, submittedBy: uid,
    amount, currency: currency || 'KES',
    category: category || 'general',
    description, receiptUrl: receiptUrl || null,
    expenseDate: date ? new Date(date).toISOString() : new Date().toISOString(),
    status: 'pending',
    approvedBy: null, approvedAt: null,
    rejectedBy: null, rejectedReason: null, rejectedAt: null,
    paidAt: null, paymentRef: null, paymentMethod: null,
    createdAt: _ts(), updatedAt: _ts(),
  });
  return { expenseId: id };
});

exports.expenseApprove = onCall(_CALL, exports._h.expenseApprove = async (req) => {
  const uid = _uid(req);
  const { shopId, expenseId, note } = req.data;
  await _assertShopManager(uid, shopId);
  await _db().runTransaction(async tx => {
    const ref  = _db().collection('expenseClaims').doc(expenseId);
    const snap = await tx.get(ref);
    if (!snap.exists || snap.data().shopId !== shopId) throw new Error('expense not found');
    if (snap.data().status !== 'pending') throw new Error('expense is not pending');
    if (snap.data().submittedBy === uid) throw new Error('cannot approve your own expense');
    tx.update(ref, { status: 'approved', approvedBy: uid, approvedAt: _ts(), approvalNote: note || null, updatedAt: _ts() });
  });
  return { success: true };
});

exports.expenseReject = onCall(_CALL, exports._h.expenseReject = async (req) => {
  const uid = _uid(req);
  const { shopId, expenseId, reason } = req.data;
  await _assertShopManager(uid, shopId);
  if (!reason) throw new Error('rejection reason required');
  await _db().runTransaction(async tx => {
    const ref  = _db().collection('expenseClaims').doc(expenseId);
    const snap = await tx.get(ref);
    if (!snap.exists || snap.data().shopId !== shopId) throw new Error('expense not found');
    if (snap.data().status !== 'pending') throw new Error('expense is not pending');
    tx.update(ref, { status: 'rejected', rejectedBy: uid, rejectedReason: reason, rejectedAt: _ts(), updatedAt: _ts() });
  });
  return { success: true };
});

exports.expenseMarkPaid = onCall(_CALL, exports._h.expenseMarkPaid = async (req) => {
  const uid = _uid(req);
  const { shopId, expenseId, paymentRef, paymentMethod } = req.data;
  await _assertShopManager(uid, shopId);
  await _db().runTransaction(async tx => {
    const ref  = _db().collection('expenseClaims').doc(expenseId);
    const snap = await tx.get(ref);
    if (!snap.exists || snap.data().shopId !== shopId) throw new Error('expense not found');
    if (snap.data().status !== 'approved') throw new Error('expense must be approved first');
    tx.update(ref, {
      status: 'paid', paidAt: _ts(), paidBy: uid,
      paymentRef: paymentRef || null, paymentMethod: paymentMethod || 'cash', updatedAt: _ts(),
    });
  });
  return { success: true };
});

exports.expenseGetMine = onCall(_CALL, exports._h.expenseGetMine = async (req) => {
  const uid = _uid(req);
  const { shopId, status } = req.data;
  await _assertShop(uid, shopId);
  const snap = await _db().collection('expenseClaims').where('submittedBy', '==', uid).limit(100).get();
  let expenses = snap.docs.map(d => d.data()).filter(e => e.shopId === shopId);
  if (status) expenses = expenses.filter(e => e.status === status);
  expenses.sort((a, b) => _mills(b.createdAt) - _mills(a.createdAt));
  return { expenses };
});

exports.expenseGetPending = onCall(_CALL, exports._h.expenseGetPending = async (req) => {
  const uid = _uid(req);
  const { shopId } = req.data;
  await _assertShopManager(uid, shopId);
  const snap = await _db().collection('expenseClaims')
    .where('shopId', '==', shopId).where('status', '==', 'pending').limit(100).get();
  const expenses = snap.docs.map(d => d.data())
    .sort((a, b) => _mills(a.createdAt) - _mills(b.createdAt)); // oldest first
  return { expenses };
});

exports.expenseList = onCall(_CALL, exports._h.expenseList = async (req) => {
  const uid = _uid(req);
  const { shopId, status, limit: lim } = req.data;
  await _assertShopManager(uid, shopId);
  const snap = await _db().collection('expenseClaims')
    .where('shopId', '==', shopId).limit(_clamp(lim, 1, 200, 100)).get();
  let expenses = snap.docs.map(d => d.data());
  if (status) expenses = expenses.filter(e => e.status === status);
  return { expenses: expenses.sort((a, b) => _mills(b.createdAt) - _mills(a.createdAt)) };
});

// ─────────────────────────────────────────────────────────────────────────────
// BANK RECONCILIATION  (5 CFs)
// Collections: bankStatements/{id}, bankStatementEntries/{id}
// ─────────────────────────────────────────────────────────────────────────────

exports.reconImportStatement = onCall(_CALL, exports._h.reconImportStatement = async (req) => {
  const uid = _uid(req);
  const { shopId, bankName, periodStart, periodEnd, entries } = req.data;
  await _assertShopManager(uid, shopId);
  if (!Array.isArray(entries) || !entries.length) throw new Error('entries array required');
  if (entries.length > 500) throw new Error('max 500 entries per import');

  const statId  = _id();
  const batch   = _db().batch();
  const statRef = _db().collection('bankStatements').doc(statId);
  batch.set(statRef, {
    id: statId, shopId, bankName: bankName || 'Bank',
    periodStart: periodStart || null, periodEnd: periodEnd || null,
    entryCount: entries.length, matchedCount: 0,
    importedBy: uid, importedAt: _ts(), status: 'in_progress',
  });
  entries.forEach(e => {
    const entRef = _db().collection('bankStatementEntries').doc(_id());
    const amt = parseFloat(e.amount) || 0;
    batch.set(entRef, {
      statementId: statId, shopId,
      date: e.date || null, description: e.description || '',
      amount: amt, type: amt >= 0 ? 'credit' : 'debit',
      reference: e.reference || null,
      matched: false, matchedTransactionId: null, isExternal: false,
      createdAt: _ts(),
    });
  });
  await batch.commit();
  return { statementId: statId, entryCount: entries.length };
});

exports.reconGetUnmatched = onCall(_CALL, exports._h.reconGetUnmatched = async (req) => {
  const uid = _uid(req);
  const { shopId, statementId } = req.data;
  await _assertShop(uid, shopId);
  const snap = await _db().collection('bankStatementEntries')
    .where('shopId', '==', shopId).limit(500).get();
  let entries = snap.docs.map(d => d.data());
  if (statementId) entries = entries.filter(e => e.statementId === statementId);
  entries = entries.filter(e => !e.matched && !e.isExternal);
  entries.sort((a, b) => (b.date || '') > (a.date || '') ? 1 : -1);
  return { entries };
});

exports.reconMatchTransaction = onCall(_CALL, exports._h.reconMatchTransaction = async (req) => {
  const uid = _uid(req);
  const { shopId, entryId, transactionId } = req.data;
  await _assertShopManager(uid, shopId);
  await _db().runTransaction(async tx => {
    const entRef  = _db().collection('bankStatementEntries').doc(entryId);
    const entSnap = await tx.get(entRef);
    if (!entSnap.exists || entSnap.data().shopId !== shopId) throw new Error('entry not found');
    if (entSnap.data().matched) throw new Error('entry already matched');
    tx.update(entRef, { matched: true, matchedTransactionId: transactionId, matchedBy: uid, matchedAt: _ts() });
    const statRef = _db().collection('bankStatements').doc(entSnap.data().statementId);
    tx.update(statRef, { matchedCount: _fv().increment(1), updatedAt: _ts() });
  });
  return { success: true };
});

exports.reconMarkExternal = onCall(_CALL, exports._h.reconMarkExternal = async (req) => {
  const uid = _uid(req);
  const { shopId, entryId, note } = req.data;
  await _assertShopManager(uid, shopId);
  const ref  = _db().collection('bankStatementEntries').doc(entryId);
  const snap = await ref.get();
  if (!snap.exists || snap.data().shopId !== shopId) throw new Error('entry not found');
  await ref.update({ isExternal: true, externalNote: note || null, markedBy: uid, markedAt: _ts() });
  return { success: true };
});

exports.reconGetSummary = onCall(_CALL, exports._h.reconGetSummary = async (req) => {
  const uid = _uid(req);
  const { shopId, statementId } = req.data;
  await _assertShop(uid, shopId);
  const statSnap = await _db().collection('bankStatements').doc(statementId).get();
  if (!statSnap.exists || statSnap.data().shopId !== shopId) throw new Error('statement not found');
  const entSnap = await _db().collection('bankStatementEntries')
    .where('statementId', '==', statementId).limit(600).get();
  const entries   = entSnap.docs.map(d => d.data());
  const credits   = entries.filter(e => e.amount >= 0).reduce((s, e) => s + e.amount, 0);
  const debits    = entries.filter(e => e.amount  < 0).reduce((s, e) => s + Math.abs(e.amount), 0);
  const matched   = entries.filter(e => e.matched).length;
  const external  = entries.filter(e => e.isExternal).length;
  const unmatched = entries.filter(e => !e.matched && !e.isExternal).length;
  return {
    statement: statSnap.data(),
    summary: {
      totalEntries: entries.length, matched, external, unmatched,
      totalCredits: credits, totalDebits: debits, netFlow: credits - debits,
      matchRate: entries.length ? Math.round((matched / entries.length) * 100) : 0,
    },
  };
});

// ─────────────────────────────────────────────────────────────────────────────
// TAX FILING CALENDAR  (4 CFs)
// Collections: taxFilings/{id}
// ─────────────────────────────────────────────────────────────────────────────

const _TAX_TYPES = ['vat', 'paye', 'withholding', 'corporate', 'rental', 'turnover', 'other'];

exports.taxFilingCreate = onCall(_CALL, exports._h.taxFilingCreate = async (req) => {
  const uid = _uid(req);
  const { shopId, type, period, dueDate, amount, description } = req.data;
  await _assertShopManager(uid, shopId);
  if (!_TAX_TYPES.includes(type)) throw new Error('invalid tax type');
  if (!period || !dueDate) throw new Error('period and dueDate required');
  const due = new Date(dueDate);
  const id  = _id();
  await _db().collection('taxFilings').doc(id).set({
    id, shopId, type, period,
    dueDate: due.toISOString(),
    amount: amount || null, currency: 'KES',
    description: description || null,
    status: due > new Date() ? 'upcoming' : 'overdue',
    filedAt: null, reference: null, filedBy: null,
    createdBy: uid, createdAt: _ts(), updatedAt: _ts(),
  });
  return { filingId: id };
});

exports.taxFilingMarkFiled = onCall(_CALL, exports._h.taxFilingMarkFiled = async (req) => {
  const uid = _uid(req);
  const { shopId, filingId, reference, amount } = req.data;
  await _assertShopManager(uid, shopId);
  if (!reference) throw new Error('filing reference required');
  await _db().runTransaction(async tx => {
    const ref  = _db().collection('taxFilings').doc(filingId);
    const snap = await tx.get(ref);
    if (!snap.exists || snap.data().shopId !== shopId) throw new Error('filing not found');
    if (snap.data().status === 'filed') throw new Error('already filed');
    const upd = { status: 'filed', filedAt: _ts(), reference, filedBy: uid, updatedAt: _ts() };
    if (amount) upd.amount = amount;
    tx.update(ref, upd);
  });
  return { success: true };
});

exports.taxFilingGetDue = onCall(_CALL, exports._h.taxFilingGetDue = async (req) => {
  const uid = _uid(req);
  const { shopId, daysAhead } = req.data;
  await _assertShop(uid, shopId);
  const snap = await _db().collection('taxFilings').where('shopId', '==', shopId).limit(100).get();
  const now    = new Date();
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() + _clamp(daysAhead, 1, 365, 30));
  const filings = snap.docs.map(d => d.data())
    .filter(f => f.status !== 'filed')
    .map(f => {
      const due = new Date(f.dueDate);
      return { ...f, isOverdue: due < now, daysUntilDue: Math.ceil((due - now) / 86400000) };
    })
    .filter(f => f.isOverdue || new Date(f.dueDate) <= cutoff)
    .sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate));
  return { filings };
});

exports.taxFilingGetHistory = onCall(_CALL, exports._h.taxFilingGetHistory = async (req) => {
  const uid = _uid(req);
  const { shopId, type } = req.data;
  await _assertShop(uid, shopId);
  const snap = await _db().collection('taxFilings').where('shopId', '==', shopId).limit(100).get();
  let filings = snap.docs.map(d => d.data());
  if (type) filings = filings.filter(f => f.type === type);
  filings.sort((a, b) => (b.period > a.period ? 1 : -1));
  return { filings };
});

// ─────────────────────────────────────────────────────────────────────────────
// FINANCIAL STATEMENTS  (4 CFs)
// Derived from ledgerEntries + transactions collections
// ─────────────────────────────────────────────────────────────────────────────

const _REVENUE_KEYWORDS = ['sales', 'revenue', 'income', 'commission_income', 'service_revenue', 'interest_income'];

exports.finStmtGetPL = onCall(_CALL, exports._h.finStmtGetPL = async (req) => {
  const uid = _uid(req);
  const { shopId, startDate, endDate } = req.data;
  await _assertShopManager(uid, shopId);
  if (!startDate || !endDate) throw new Error('startDate and endDate required');

  const start = new Date(startDate);
  const end   = new Date(endDate); end.setHours(23, 59, 59, 999);

  const snap = await _db().collection('ledgerEntries').where('shopId', '==', shopId).limit(5000).get();
  const entries = snap.docs.map(d => d.data()).filter(e => {
    const d = e.date ? (e.date.toDate ? e.date.toDate() : new Date(e.date)) : null;
    return d && d >= start && d <= end;
  });

  const revenue = {}, expenses = {};
  entries.forEach(e => {
    const cat = (e.category || e.account || 'other').toLowerCase();
    const amt = Math.abs(e.amount || 0);
    const isRev = _REVENUE_KEYWORDS.some(k => cat.includes(k));
    if (isRev) revenue[cat]  = (revenue[cat]  || 0) + amt;
    else       expenses[cat] = (expenses[cat] || 0) + amt;
  });

  const totalRevenue  = Object.values(revenue).reduce((s, v) => s + v, 0);
  const totalExpenses = Object.values(expenses).reduce((s, v) => s + v, 0);
  return {
    period: { startDate, endDate },
    revenue:  Object.entries(revenue).map(([k, v]) => ({ account: k, amount: Math.round(v * 100) / 100 })),
    expenses: Object.entries(expenses).map(([k, v]) => ({ account: k, amount: Math.round(v * 100) / 100 })),
    totalRevenue: Math.round(totalRevenue * 100) / 100,
    totalExpenses: Math.round(totalExpenses * 100) / 100,
    grossProfit: Math.round((totalRevenue - totalExpenses) * 100) / 100,
    netProfit:   Math.round((totalRevenue - totalExpenses) * 100) / 100,
    currency: 'KES',
  };
});

exports.finStmtGetBalanceSheet = onCall(_CALL, exports._h.finStmtGetBalanceSheet = async (req) => {
  const uid = _uid(req);
  const { shopId, asOfDate } = req.data;
  await _assertShopManager(uid, shopId);

  const cutoff = asOfDate ? new Date(asOfDate) : new Date();
  cutoff.setHours(23, 59, 59, 999);

  const snap = await _db().collection('ledgerEntries').where('shopId', '==', shopId).limit(10000).get();
  const entries = snap.docs.map(d => d.data()).filter(e => {
    const d = e.date ? (e.date.toDate ? e.date.toDate() : new Date(e.date)) : null;
    return d && d <= cutoff;
  });

  const assets = {}, liabilities = {};
  const _LIAB_KEYWORDS = ['payable', 'loan', 'debt', 'vat_payable', 'liability'];
  entries.forEach(e => {
    const cat = (e.category || e.account || 'other').toLowerCase();
    const amt = e.type === 'debit' ? (e.amount || 0) : -(e.amount || 0);
    const isLiab = _LIAB_KEYWORDS.some(k => cat.includes(k));
    if (isLiab) liabilities[cat] = (liabilities[cat] || 0) + amt;
    else        assets[cat]      = (assets[cat] || 0) + amt;
  });

  const totalAssets      = Object.values(assets).reduce((s, v) => s + v, 0);
  const totalLiabilities = Object.values(liabilities).reduce((s, v) => s + v, 0);
  return {
    asOfDate: cutoff.toISOString().split('T')[0],
    assets:      Object.entries(assets).map(([k, v]) => ({ account: k, amount: Math.round(v * 100) / 100 })),
    liabilities: Object.entries(liabilities).map(([k, v]) => ({ account: k, amount: Math.round(v * 100) / 100 })),
    totalAssets:      Math.round(totalAssets * 100) / 100,
    totalLiabilities: Math.round(totalLiabilities * 100) / 100,
    equity:           Math.round((totalAssets - totalLiabilities) * 100) / 100,
    currency: 'KES',
  };
});

exports.finStmtGetCashFlow = onCall(_CALL, exports._h.finStmtGetCashFlow = async (req) => {
  const uid = _uid(req);
  const { shopId, startDate, endDate } = req.data;
  await _assertShopManager(uid, shopId);
  if (!startDate || !endDate) throw new Error('startDate and endDate required');

  const start = new Date(startDate);
  const end   = new Date(endDate); end.setHours(23, 59, 59, 999);

  const snap = await _db().collection('transactions').where('shopId', '==', shopId).limit(5000).get();
  const txs  = snap.docs.map(d => d.data()).filter(tx => {
    const d = tx.createdAt ? (tx.createdAt.toDate ? tx.createdAt.toDate() : new Date(tx.createdAt)) : null;
    return d && d >= start && d <= end && tx.status === 'completed';
  });

  let operating = 0, investing = 0, financing = 0;
  const _INV_TYPES = ['equipment', 'property', 'investment'];
  const _FIN_TYPES = ['loan', 'equity', 'dividend'];
  txs.forEach(tx => {
    const amt  = tx.amount || 0;
    const type = (tx.type || '').toLowerCase();
    if (_INV_TYPES.includes(type))      { investing  -= amt; }
    else if (_FIN_TYPES.includes(type)) { financing  += type === 'dividend' ? -amt : amt; }
    else {
      operating += (type === 'sale' || type === 'credit') ? amt : -amt;
    }
  });

  return {
    period: { startDate, endDate },
    operating: { total: Math.round(operating * 100) / 100, label: 'Operating Activities' },
    investing: { total: Math.round(investing * 100) / 100, label: 'Investing Activities' },
    financing: { total: Math.round(financing * 100) / 100, label: 'Financing Activities' },
    netCashFlow: Math.round((operating + investing + financing) * 100) / 100,
    currency: 'KES',
  };
});

exports.finStmtExport = onCall(_CALL, exports._h.finStmtExport = async (req) => {
  const uid = _uid(req);
  const { shopId, type, startDate, endDate } = req.data;
  await _assertShopManager(uid, shopId);
  if (!type || !startDate || !endDate) throw new Error('type, startDate, endDate required');
  // Returns metadata — client calls the specific statement CF and renders to CSV
  return {
    shopId, type, startDate, endDate,
    generatedAt: new Date().toISOString(),
    instructions: 'Call finStmtGetPL / finStmtGetBalanceSheet / finStmtGetCashFlow and export the returned arrays as CSV.',
  };
});

// ─────────────────────────────────────────────────────────────────────────────
// PETTY CASH  (5 CFs)
// Collections: pettyCashFunds/{id}, pettyCashTransactions/{id}
// ─────────────────────────────────────────────────────────────────────────────

exports.pettyCashCreate = onCall(_CALL, exports._h.pettyCashCreate = async (req) => {
  const uid = _uid(req);
  const { shopId, name, openingBalance, currency } = req.data;
  await _assertShopManager(uid, shopId);
  if (!name || !openingBalance || openingBalance <= 0) throw new Error('name and openingBalance required');
  const id = _id();
  const batch = _db().batch();
  batch.set(_db().collection('pettyCashFunds').doc(id), {
    id, shopId, name,
    balance: openingBalance, openingBalance,
    currency: currency || 'KES',
    status: 'active', createdBy: uid, createdAt: _ts(), updatedAt: _ts(),
  });
  batch.set(_db().collection('pettyCashTransactions').doc(_id()), {
    fundId: id, shopId, type: 'opening', amount: openingBalance,
    description: 'Opening balance', by: uid, at: _ts(),
  });
  await batch.commit();
  return { fundId: id };
});

exports.pettyCashDisburse = onCall(_CALL, exports._h.pettyCashDisburse = async (req) => {
  const uid = _uid(req);
  const { shopId, fundId, amount, description, category, receiptRef } = req.data;
  await _assertShop(uid, shopId);
  if (!amount || amount <= 0) throw new Error('amount must be > 0');
  if (!description) throw new Error('description required');
  await _db().runTransaction(async tx => {
    const ref  = _db().collection('pettyCashFunds').doc(fundId);
    const snap = await tx.get(ref);
    if (!snap.exists || snap.data().shopId !== shopId) throw new Error('fund not found');
    if (snap.data().status !== 'active') throw new Error('fund not active');
    if (snap.data().balance < amount) throw new Error('insufficient petty cash balance');
    tx.update(ref, { balance: _fv().increment(-amount), updatedAt: _ts() });
    tx.set(_db().collection('pettyCashTransactions').doc(_id()), {
      fundId, shopId, type: 'disbursement', amount,
      description, category: category || 'general',
      receiptRef: receiptRef || null, by: uid, at: _ts(),
    });
  });
  return { success: true };
});

exports.pettyCashReplenish = onCall(_CALL, exports._h.pettyCashReplenish = async (req) => {
  const uid = _uid(req);
  const { shopId, fundId, amount, reference } = req.data;
  await _assertShopManager(uid, shopId);
  if (!amount || amount <= 0) throw new Error('amount must be > 0');
  await _db().runTransaction(async tx => {
    const ref  = _db().collection('pettyCashFunds').doc(fundId);
    const snap = await tx.get(ref);
    if (!snap.exists || snap.data().shopId !== shopId) throw new Error('fund not found');
    tx.update(ref, { balance: _fv().increment(amount), updatedAt: _ts() });
    tx.set(_db().collection('pettyCashTransactions').doc(_id()), {
      fundId, shopId, type: 'replenishment', amount,
      description: 'Replenishment' + (reference ? ' — Ref: ' + reference : ''),
      reference: reference || null, by: uid, at: _ts(),
    });
  });
  return { success: true };
});

exports.pettyCashGetBalance = onCall(_CALL, exports._h.pettyCashGetBalance = async (req) => {
  const uid = _uid(req);
  const { shopId, fundId } = req.data;
  await _assertShop(uid, shopId);
  const fundSnap = await _db().collection('pettyCashFunds').doc(fundId).get();
  if (!fundSnap.exists || fundSnap.data().shopId !== shopId) throw new Error('fund not found');
  const txSnap = await _db().collection('pettyCashTransactions')
    .where('fundId', '==', fundId).limit(100).get();
  const transactions = txSnap.docs.map(d => d.data()).sort((a, b) => _mills(b.at) - _mills(a.at));
  return { fund: fundSnap.data(), transactions };
});

exports.pettyCashReconcile = onCall(_CALL, exports._h.pettyCashReconcile = async (req) => {
  const uid = _uid(req);
  const { shopId, fundId, physicalCount, note } = req.data;
  await _assertShopManager(uid, shopId);
  if (physicalCount == null || physicalCount < 0) throw new Error('physicalCount required');
  const fundSnap = await _db().collection('pettyCashFunds').doc(fundId).get();
  if (!fundSnap.exists || fundSnap.data().shopId !== shopId) throw new Error('fund not found');
  const fund     = fundSnap.data();
  const variance = physicalCount - fund.balance;
  const batch    = _db().batch();
  batch.set(_db().collection('pettyCashTransactions').doc(_id()), {
    fundId, shopId, type: 'reconciliation',
    amount: Math.abs(variance), variance, physicalCount,
    systemBalance: fund.balance,
    description: 'Physical count reconciliation' + (note ? ' — ' + note : ''),
    by: uid, at: _ts(),
  });
  if (variance !== 0) {
    batch.update(_db().collection('pettyCashFunds').doc(fundId), {
      balance: physicalCount, lastReconciledAt: _ts(), updatedAt: _ts(),
    });
  }
  await batch.commit();
  return { variance, physicalCount, systemBalance: fund.balance, adjusted: variance !== 0 };
});

// ─────────────────────────────────────────────────────────────────────────────
// INVOICES  (6 CFs)
// Collections: invoices/{id}, invoiceCounters/{shopId}
// ─────────────────────────────────────────────────────────────────────────────

async function _nextInvoiceNumber(shopId) {
  let number = 1;
  await _db().runTransaction(async tx => {
    const ref  = _db().collection('invoiceCounters').doc(shopId);
    const snap = await tx.get(ref);
    if (snap.exists) {
      number = (snap.data().lastNumber || 0) + 1;
      tx.update(ref, { lastNumber: number });
    } else {
      tx.set(ref, { lastNumber: 1 });
    }
  });
  return 'INV-' + shopId.slice(0, 4).toUpperCase() + '-' + String(number).padStart(6, '0');
}

exports.invoiceCreate = onCall(_CALL, exports._h.invoiceCreate = async (req) => {
  const uid = _uid(req);
  const { shopId, clientName, clientEmail, clientPhone, items, taxRate, dueDate, notes, currency } = req.data;
  await _assertShop(uid, shopId);
  if (!clientName) throw new Error('clientName required');
  if (!Array.isArray(items) || !items.length) throw new Error('items required');

  const lineItems = items.map(item => {
    const qty   = parseFloat(item.quantity)  || 1;
    const price = parseFloat(item.unitPrice) || 0;
    return { description: item.description || '', quantity: qty, unitPrice: price, total: qty * price };
  });
  const subtotal = lineItems.reduce((s, i) => s + i.total, 0);
  const rate     = Math.max(0, Math.min(100, parseFloat(taxRate) || 0));
  const tax      = Math.round(subtotal * (rate / 100) * 100) / 100;
  const total    = Math.round((subtotal + tax) * 100) / 100;

  const invoiceNumber = await _nextInvoiceNumber(shopId);
  const id = _id();
  await _db().collection('invoices').doc(id).set({
    id, shopId, invoiceNumber,
    clientName, clientEmail: clientEmail || null, clientPhone: clientPhone || null,
    items: lineItems, subtotal, taxRate: rate, tax, total, currency: currency || 'KES',
    notes: notes || null,
    dueDate: dueDate ? new Date(dueDate).toISOString() : null,
    status: 'draft',
    sentAt: null, paidAt: null, voidedAt: null,
    paymentRef: null, paymentMethod: null,
    createdBy: uid, createdAt: _ts(), updatedAt: _ts(),
  });
  return { invoiceId: id, invoiceNumber };
});

exports.invoiceSend = onCall({ ..._CALL, secrets: [SENDGRID_KEY] }, exports._h.invoiceSend = async (req) => {
  const uid = _uid(req);
  const { shopId, invoiceId } = req.data;
  await _assertShop(uid, shopId);
  const ref  = _db().collection('invoices').doc(invoiceId);
  const snap = await ref.get();
  if (!snap.exists || snap.data().shopId !== shopId) throw new Error('invoice not found');
  const inv = snap.data();
  if (inv.status === 'void') throw new Error('cannot send voided invoice');

  if (inv.clientEmail) {
    try {
      const sgKey = SENDGRID_KEY.value();
      if (sgKey && sgKey !== 'placeholder') {
        const https = require('https');
        const dueLabel = inv.dueDate ? new Date(inv.dueDate).toLocaleDateString('en-KE') : 'On receipt';
        const body = JSON.stringify({
          personalizations: [{ to: [{ email: inv.clientEmail, name: inv.clientName }] }],
          from: { email: 'billing@mysokoni.co.ke', name: 'SOKONI Billing' },
          subject: 'Invoice ' + inv.invoiceNumber,
          content: [{
            type: 'text/plain',
            value: 'Dear ' + inv.clientName + ',\n\nInvoice ' + inv.invoiceNumber + '\nAmount: KES ' + inv.total.toLocaleString('en-KE') + '\nDue: ' + dueLabel + '\n\nThank you,\nSOKONI',
          }],
        });
        await new Promise((res, rej) => {
          const r = require('https').request({
            hostname: 'api.sendgrid.com', path: '/v3/mail/send', method: 'POST',
            headers: { Authorization: 'Bearer ' + sgKey, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
          }, rsp => { rsp.resume(); res(rsp.statusCode); });
          r.on('error', rej); r.write(body); r.end();
        });
      }
    } catch (_) { /* email failure is non-fatal */ }
  }

  await ref.update({ status: 'sent', sentAt: _ts(), updatedAt: _ts() });
  return { success: true };
});

exports.invoiceMarkPaid = onCall(_CALL, exports._h.invoiceMarkPaid = async (req) => {
  const uid = _uid(req);
  const { shopId, invoiceId, paymentRef, paymentMethod } = req.data;
  await _assertShop(uid, shopId);
  await _db().runTransaction(async tx => {
    const ref  = _db().collection('invoices').doc(invoiceId);
    const snap = await tx.get(ref);
    if (!snap.exists || snap.data().shopId !== shopId) throw new Error('invoice not found');
    if (snap.data().status === 'paid') throw new Error('already paid');
    if (snap.data().status === 'void') throw new Error('invoice is voided');
    tx.update(ref, {
      status: 'paid', paidAt: _ts(), paidBy: uid,
      paymentRef: paymentRef || null,
      paymentMethod: paymentMethod || 'mpesa', updatedAt: _ts(),
    });
  });
  return { success: true };
});

exports.invoiceVoid = onCall(_CALL, exports._h.invoiceVoid = async (req) => {
  const uid = _uid(req);
  const { shopId, invoiceId, reason } = req.data;
  await _assertShopManager(uid, shopId);
  if (!reason) throw new Error('void reason required');
  await _db().runTransaction(async tx => {
    const ref  = _db().collection('invoices').doc(invoiceId);
    const snap = await tx.get(ref);
    if (!snap.exists || snap.data().shopId !== shopId) throw new Error('invoice not found');
    if (snap.data().status === 'paid') throw new Error('cannot void a paid invoice');
    if (snap.data().status === 'void') throw new Error('already voided');
    tx.update(ref, { status: 'void', voidedAt: _ts(), voidedBy: uid, voidReason: reason, updatedAt: _ts() });
  });
  return { success: true };
});

exports.invoiceGet = onCall(_CALL, exports._h.invoiceGet = async (req) => {
  const uid = _uid(req);
  const { shopId, invoiceId } = req.data;
  await _assertShop(uid, shopId);
  const snap = await _db().collection('invoices').doc(invoiceId).get();
  if (!snap.exists || snap.data().shopId !== shopId) throw new Error('invoice not found');
  return { invoice: snap.data() };
});

exports.invoiceList = onCall(_CALL, exports._h.invoiceList = async (req) => {
  const uid = _uid(req);
  const { shopId, status, limit: lim } = req.data;
  await _assertShop(uid, shopId);
  const snap = await _db().collection('invoices')
    .where('shopId', '==', shopId).limit(_clamp(lim, 1, 200, 100)).get();
  const now  = new Date();
  let invoices = snap.docs.map(d => d.data());
  if (status) invoices = invoices.filter(i => i.status === status);
  invoices.forEach(inv => {
    if (inv.status === 'sent' && inv.dueDate && new Date(inv.dueDate) < now) inv.isOverdue = true;
  });
  invoices.sort((a, b) => _mills(b.createdAt) - _mills(a.createdAt));
  return { invoices };
});

// ─────────────────────────────────────────────────────────────────────────────
// Shared micro-utilities (module-local)
// ─────────────────────────────────────────────────────────────────────────────
function _mills(ts) { return ts ? (ts.toMillis ? ts.toMillis() : new Date(ts).getTime()) : 0; }
function _clamp(v, min, max, def) { const n = parseInt(v); return isNaN(n) ? def : Math.min(max, Math.max(min, n)); }
