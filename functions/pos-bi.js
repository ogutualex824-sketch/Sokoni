'use strict';

/**
 * pos-bi.js
 * SOKONI SmartPOS — Business Intelligence Cloud Functions
 *
 * Sections:
 *   A. Executive Dashboard     (getExecutiveDashboard)
 *   B. Revenue Analytics       (getRevenueDrilldown, getRevenueTrend)
 *   C. Inventory Health Score  (getInventoryHealthScore)
 *   D. Customer Growth Metrics (getCustomerGrowthMetrics)
 *   E. Staff Productivity      (getStaffProductivityMetrics)
 *   F. Category Performance    (getCategoryPerformance)
 *   G. Revenue Forecast        (getRevenueForecast)
 *   H. Payment Trend Analysis  (getPaymentTrends)
 *   I. Scheduled: biDailySnapshot
 */

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule }         = require('firebase-functions/v2/scheduler');
const admin                  = require('firebase-admin');
if (!admin.apps.length) admin.initializeApp();
const db = admin.firestore();

// ─────────────────────────────────────────────
// Shared Config & Utilities
// ─────────────────────────────────────────────

const _CF  = { region: 'us-central1', enforceAppCheck: true };
const _TS  = () => admin.firestore.FieldValue.serverTimestamp();

/**
 * Assert authenticated caller.
 * @param {import('firebase-functions/v2/https').CallableRequest} req
 * @returns {import('firebase-functions/v2/https').CallableRequest['auth']}
 */
function _requireAuth(req) {
  if (!req.auth) throw new HttpsError('unauthenticated', 'Login required');
  return req.auth;
}

/**
 * Assert minimum POS role.
 * Role hierarchy: cashier(0) < supervisor(1) < manager(2) < owner(3)
 * @param {import('firebase-functions/v2/https').CallableRequest['auth']} auth
 * @param {'cashier'|'supervisor'|'manager'|'owner'} minRole
 */
function _requireRole(auth, minRole) {
  const levels = { cashier: 0, supervisor: 1, manager: 2, owner: 3 };
  if ((levels[auth.token?.posRole || 'cashier'] ?? 0) < (levels[minRole] ?? 0))
    throw new HttpsError('permission-denied', `Requires ${minRole} role`);
}

/**
 * Sanitize a string value: strip dangerous chars, cap length.
 * @param {unknown} v
 * @param {number} [max=200]
 * @returns {string}
 */
function _san(v, max = 200) {
  if (typeof v !== 'string') return '';
  return v.replace(/[<>"'`\\]/g, '').trim().slice(0, max);
}

/**
 * Coerce to safe finite number.
 * @param {unknown} v
 * @param {number} [def=0]
 * @returns {number}
 */
function _num(v, def = 0) {
  const n = parseFloat(v);
  return isFinite(n) ? n : def;
}

/**
 * Assert a required string field is present and non-empty.
 * @param {unknown} v
 * @param {string} name
 * @returns {string}
 */
function _req(v, name) {
  if (typeof v !== 'string' || !v.trim())
    throw new HttpsError('invalid-argument', `Missing required field: ${name}`);
  return v.trim();
}

/**
 * Round to 2 decimal places.
 * @param {number} n
 * @returns {number}
 */
function _r2(n) { return Math.round(n * 100) / 100; }

/**
 * Structured log helper.
 * @param {'INFO'|'WARNING'|'ERROR'|'NOTICE'} severity
 * @param {string} msg
 * @param {object} [extra]
 */
function _log(severity, msg, extra = {}) {
  const entry = { severity, message: msg, service: 'pos-bi', ...extra };
  if (severity === 'ERROR')        console.error(JSON.stringify(entry));
  else if (severity === 'WARNING') console.warn(JSON.stringify(entry));
  else                             console.log(JSON.stringify(entry));
}

/**
 * Compute ISO date window boundaries for a named period.
 * Returns { currentStart, currentEnd, priorStart, priorEnd } as ISO strings.
 *
 * @param {'today'|'week'|'month'|'quarter'} period
 * @returns {{ currentStart: string, currentEnd: string, priorStart: string, priorEnd: string, days: number }}
 */
function _periodBounds(period) {
  const now = new Date();
  now.setHours(23, 59, 59, 999);

  let currentStart, currentEnd, priorStart, priorEnd, days;

  const toISO = (d) => d.toISOString().slice(0, 10);

  if (period === 'today') {
    const start = new Date(); start.setHours(0, 0, 0, 0);
    const prior = new Date(start); prior.setDate(prior.getDate() - 1);
    const priorEnd_ = new Date(prior); priorEnd_.setHours(23, 59, 59, 999);
    currentStart = toISO(start);
    currentEnd   = toISO(now);
    priorStart   = toISO(prior);
    priorEnd     = toISO(priorEnd_);
    days = 1;
  } else if (period === 'week') {
    const start = new Date(); start.setDate(start.getDate() - 6); start.setHours(0, 0, 0, 0);
    const priorEnd_ = new Date(start); priorEnd_.setDate(priorEnd_.getDate() - 1); priorEnd_.setHours(23, 59, 59, 999);
    const prior = new Date(priorEnd_); prior.setDate(prior.getDate() - 6); prior.setHours(0, 0, 0, 0);
    currentStart = toISO(start);
    currentEnd   = toISO(now);
    priorStart   = toISO(prior);
    priorEnd     = toISO(priorEnd_);
    days = 7;
  } else if (period === 'month') {
    const start = new Date(now.getFullYear(), now.getMonth(), 1);
    const priorEnd_ = new Date(start); priorEnd_.setDate(priorEnd_.getDate() - 1); priorEnd_.setHours(23, 59, 59, 999);
    const prior = new Date(priorEnd_.getFullYear(), priorEnd_.getMonth(), 1);
    currentStart = toISO(start);
    currentEnd   = toISO(now);
    priorStart   = toISO(prior);
    priorEnd     = toISO(priorEnd_);
    days = Math.ceil((now - start) / (1000 * 60 * 60 * 24));
  } else if (period === 'quarter') {
    const quarter = Math.floor(now.getMonth() / 3);
    const start = new Date(now.getFullYear(), quarter * 3, 1);
    const priorEnd_ = new Date(start); priorEnd_.setDate(priorEnd_.getDate() - 1); priorEnd_.setHours(23, 59, 59, 999);
    const prior = new Date(priorEnd_.getFullYear(), Math.floor(priorEnd_.getMonth() / 3) * 3, 1);
    currentStart = toISO(start);
    currentEnd   = toISO(now);
    priorStart   = toISO(prior);
    priorEnd     = toISO(priorEnd_);
    days = Math.ceil((now - start) / (1000 * 60 * 60 * 24));
  } else {
    throw new HttpsError('invalid-argument', "period must be 'today', 'week', 'month', or 'quarter'");
  }

  return { currentStart, currentEnd, priorStart, priorEnd, days };
}

/**
 * Query completed sales for a seller within a date range.
 * Returns array of sale data objects.
 *
 * @param {string} sellerId
 * @param {string} startDate — YYYY-MM-DD
 * @param {string} endDate   — YYYY-MM-DD
 * @param {number} [limitN=3000]
 * @returns {Promise<object[]>}
 */
async function _fetchSales(sellerId, startDate, endDate, limitN = 3000) {
  const snap = await db.collection('posSales')
    .where('sellerId', '==', sellerId)
    .where('saleDate', '>=', startDate)
    .where('saleDate', '<=', endDate)
    .where('status', '==', 'completed')
    .limit(limitN)
    .get();

  return snap.docs.map(d => d.data());
}

/**
 * Compute percentage change between two numbers.
 * Returns null when prior is 0.
 * @param {number} current
 * @param {number} prior
 * @returns {number|null}
 */
function _pctChange(current, prior) {
  if (prior === 0) return current > 0 ? 100 : 0;
  return _r2(((current - prior) / prior) * 100);
}

// ══════════════════════════════════════════════════════════════════════════════
// SECTION A — EXECUTIVE DASHBOARD
// ══════════════════════════════════════════════════════════════════════════════

/**
 * getExecutiveDashboard
 * Role: manager+
 * Returns a comprehensive KPI dashboard for the current and prior period.
 *
 * Input:
 *   sellerId {string}
 *   period   {'today'|'week'|'month'|'quarter'}
 *
 * Output:
 *   {
 *     revenue, grossProfit, netProfit, transactions, newCustomers,
 *     returningCustomers, topBranch, topProduct, topCashier,
 *     inventoryHealth, alerts, period, generatedAt
 *   }
 */
exports.getExecutiveDashboard = onCall(_CF, async (req) => {
  const auth = _requireAuth(req);
  _requireRole(auth, 'manager');

  const sid    = _req(req.data?.sellerId, 'sellerId');
  const period = _san(req.data?.period || 'today', 20);

  const callerSellerId = auth.token?.sellerId;
  const isAdmin = auth.token?.admin || auth.token?.role === 'super_admin';
  if (!isAdmin && callerSellerId !== sid) {
    throw new HttpsError('permission-denied', 'Access denied for this seller');
  }

  const bounds = _periodBounds(period);
  const { currentStart, currentEnd, priorStart, priorEnd } = bounds;

  // Fetch current and prior period sales in parallel, plus customer counts
  const [currentSales, priorSales, allCustomersSnap] = await Promise.all([
    _fetchSales(sid, currentStart, currentEnd, 5000),
    _fetchSales(sid, priorStart, priorEnd, 5000),
    db.collection('posCustomers').where('sellerId', '==', sid).limit(50000).get(),
  ]);

  // ── Revenue & Transaction Metrics ──────────────────────────────────────────

  const sumRevenue = (sales) => sales.reduce((s, sale) => s + _num(sale.totalAmount || sale.total, 0), 0);
  const sumCost    = (sales) => sales.reduce((s, sale) => s + _num(sale.totalCost || sale.costTotal, 0), 0);
  const sumNet     = (sales) => sales.reduce((s, sale) => s + _num(sale.netProfit || (sale.totalAmount - sale.totalCost - (sale.taxAmount || 0)), 0), 0);

  const currentRevenue = _r2(sumRevenue(currentSales));
  const priorRevenue   = _r2(sumRevenue(priorSales));
  const currentCost    = _r2(sumCost(currentSales));
  const currentGP      = _r2(currentRevenue - currentCost);
  const currentNP      = _r2(sumNet(currentSales));
  const currentTxns    = currentSales.length;
  const priorTxns      = priorSales.length;
  const currentAvgBasket = currentTxns > 0 ? _r2(currentRevenue / currentTxns) : 0;

  // ── Customer Metrics ───────────────────────────────────────────────────────

  const customersInPeriod = new Set(currentSales.map(s => s.customerId).filter(Boolean));
  const newCustomerSnap = allCustomersSnap.docs.filter(d => {
    const createdDate = (d.data().createdAt?.toDate?.() || new Date(d.data().createdAt || 0));
    const createdIso  = createdDate.toISOString().slice(0, 10);
    return createdIso >= currentStart && createdIso <= currentEnd;
  });
  const newCustomerIds = new Set(newCustomerSnap.map(d => d.id));
  const newCustomerCount = newCustomerIds.size;
  const returningCustomerCount = [...customersInPeriod].filter(id => !newCustomerIds.has(id)).length;

  // ── Top Branch ─────────────────────────────────────────────────────────────

  const branchRevMap = {};
  for (const sale of currentSales) {
    const bid = sale.branchId || 'unknown';
    branchRevMap[bid] = (branchRevMap[bid] || 0) + _num(sale.totalAmount || sale.total, 0);
  }
  const topBranchEntry = Object.entries(branchRevMap).sort((a, b) => b[1] - a[1])[0];
  let topBranch = null;
  if (topBranchEntry) {
    // Try to get branch name
    let bname = topBranchEntry[0];
    try {
      const bs = await db.collection('sellers').doc(sid).collection('branches').doc(topBranchEntry[0]).get();
      if (bs.exists) bname = bs.data().name || bname;
    } catch (_) { /* ignore */ }
    topBranch = { branchId: topBranchEntry[0], name: bname, revenue: _r2(topBranchEntry[1]) };
  }

  // ── Top Product ────────────────────────────────────────────────────────────

  const productRevMap = {};
  for (const sale of currentSales) {
    if (Array.isArray(sale.items)) {
      for (const item of sale.items) {
        const pid   = item.productId || '';
        const pname = item.productName || item.name || pid;
        const rev   = _num(item.quantity, 1) * _num(item.price || item.unitPrice, 0);
        if (!productRevMap[pid]) productRevMap[pid] = { productId: pid, name: pname, revenue: 0 };
        productRevMap[pid].revenue += rev;
      }
    }
  }
  const topProductEntry = Object.values(productRevMap).sort((a, b) => b.revenue - a.revenue)[0] || null;
  const topProduct = topProductEntry ? { ...topProductEntry, revenue: _r2(topProductEntry.revenue) } : null;

  // ── Top Cashier ────────────────────────────────────────────────────────────

  const cashierRevMap = {};
  for (const sale of currentSales) {
    const uid   = sale.cashierId || sale.staffId || 'unknown';
    const uname = sale.cashierName || sale.staffName || uid;
    if (!cashierRevMap[uid]) cashierRevMap[uid] = { uid, name: uname, revenue: 0, transactions: 0 };
    cashierRevMap[uid].revenue += _num(sale.totalAmount || sale.total, 0);
    cashierRevMap[uid].transactions += 1;
  }
  const topCashierEntry = Object.values(cashierRevMap).sort((a, b) => b.revenue - a.revenue)[0] || null;
  const topCashier = topCashierEntry ? { ...topCashierEntry, revenue: _r2(topCashierEntry.revenue) } : null;

  // ── Inventory Health (lightweight version — full detail in getInventoryHealthScore) ──

  let inventoryHealth = { score: null, lowStockCount: 0, expiringCount: 0 };
  try {
    const lowStockSnap = await db.collection('sellers').doc(sid).collection('products')
      .where('stock', '<=', 10)
      .limit(200)
      .get();

    const now30 = new Date(); now30.setDate(now30.getDate() + 30);
    const expiringSnap = await db.collection('posBatches')
      .where('sellerId', '==', sid)
      .where('expiresAt', '<=', now30.toISOString().slice(0, 10))
      .where('consumed', '==', false)
      .limit(200)
      .get();

    const lowStockCount  = lowStockSnap.size;
    const expiringCount  = expiringSnap.size;
    const score = Math.max(0, 100 - (lowStockCount * 10) - (expiringCount * 2));
    inventoryHealth = { score, lowStockCount, expiringCount };
  } catch (_) { /* non-fatal */ }

  // ── Alerts ─────────────────────────────────────────────────────────────────

  const alerts = [];
  if (currentRevenue < priorRevenue * 0.8) {
    alerts.push({ type: 'warning', message: `Revenue down ${_pctChange(currentRevenue, priorRevenue)}% vs prior period` });
  }
  if (inventoryHealth.lowStockCount > 5) {
    alerts.push({ type: 'warning', message: `${inventoryHealth.lowStockCount} products with low stock` });
  }
  if (inventoryHealth.expiringCount > 0) {
    alerts.push({ type: 'info', message: `${inventoryHealth.expiringCount} batches expiring within 30 days` });
  }
  if (currentAvgBasket < _r2(priorRevenue / (priorTxns || 1)) * 0.85) {
    alerts.push({ type: 'info', message: 'Average basket size trending down vs prior period' });
  }

  return {
    revenue: {
      current: currentRevenue,
      prior: priorRevenue,
      change: _r2(currentRevenue - priorRevenue),
      changePercent: _pctChange(currentRevenue, priorRevenue),
    },
    grossProfit: {
      current: currentGP,
      margin: currentRevenue > 0 ? _r2((currentGP / currentRevenue) * 100) : 0,
    },
    netProfit: {
      current: currentNP,
      margin: currentRevenue > 0 ? _r2((currentNP / currentRevenue) * 100) : 0,
    },
    transactions: {
      current: currentTxns,
      prior: priorTxns,
      change: currentTxns - priorTxns,
      changePercent: _pctChange(currentTxns, priorTxns),
      avgBasket: currentAvgBasket,
    },
    newCustomers: { count: newCustomerCount },
    returningCustomers: { count: returningCustomerCount },
    topBranch,
    topProduct,
    topCashier,
    inventoryHealth,
    alerts,
    period: { name: period, currentStart, currentEnd, priorStart, priorEnd },
    generatedAt: new Date().toISOString(),
  };
});

// ══════════════════════════════════════════════════════════════════════════════
// SECTION B — REVENUE ANALYTICS (DRILL-DOWN)
// ══════════════════════════════════════════════════════════════════════════════

/**
 * getRevenueDrilldown
 * Role: manager+
 * Aggregates sales by the chosen dimension within a date range.
 *
 * Input:
 *   sellerId  {string}
 *   startDate {string} — YYYY-MM-DD
 *   endDate   {string} — YYYY-MM-DD
 *   groupBy   {'product'|'category'|'cashier'|'paymentMethod'|'hour'|'day'|'week'}
 *
 * Output:
 *   { data: [{ dimension, revenue, count, contribution }], total, groupBy, generatedAt }
 */
exports.getRevenueDrilldown = onCall(_CF, async (req) => {
  const auth = _requireAuth(req);
  _requireRole(auth, 'manager');

  const { sellerId, startDate, endDate, groupBy } = req.data;
  const sid   = _req(sellerId, 'sellerId');
  const start = _req(startDate, 'startDate');
  const end   = _req(endDate, 'endDate');

  const validGroupBy = ['product', 'category', 'cashier', 'paymentMethod', 'hour', 'day', 'week'];
  const gb = _san(groupBy, 30);
  if (!validGroupBy.includes(gb)) {
    throw new HttpsError('invalid-argument', `groupBy must be one of: ${validGroupBy.join(', ')}`);
  }

  const callerSellerId = auth.token?.sellerId;
  const isAdmin = auth.token?.admin || auth.token?.role === 'super_admin';
  if (!isAdmin && callerSellerId !== sid) {
    throw new HttpsError('permission-denied', 'Access denied for this seller');
  }

  const sales = await _fetchSales(sid, start, end, 5000);

  // Aggregation map: key -> { revenue, count, label }
  const agg = {};

  const addToAgg = (key, label, revenue) => {
    if (!agg[key]) agg[key] = { key, label, revenue: 0, count: 0 };
    agg[key].revenue += revenue;
    agg[key].count   += 1;
  };

  for (const sale of sales) {
    const saleTotal = _num(sale.totalAmount || sale.total, 0);

    if (gb === 'product') {
      if (Array.isArray(sale.items)) {
        for (const item of sale.items) {
          const pid = item.productId || 'unknown';
          const pname = item.productName || item.name || pid;
          const rev = _num(item.quantity, 1) * _num(item.price || item.unitPrice, 0);
          if (!agg[pid]) agg[pid] = { key: pid, label: pname, revenue: 0, count: 0 };
          agg[pid].revenue += rev;
          agg[pid].count   += 1;
        }
      }
    } else if (gb === 'category') {
      if (Array.isArray(sale.items)) {
        for (const item of sale.items) {
          const cat = item.category || 'Uncategorised';
          const rev = _num(item.quantity, 1) * _num(item.price || item.unitPrice, 0);
          if (!agg[cat]) agg[cat] = { key: cat, label: cat, revenue: 0, count: 0 };
          agg[cat].revenue += rev;
          agg[cat].count   += 1;
        }
      }
    } else if (gb === 'cashier') {
      const uid   = sale.cashierId || sale.staffId || 'unknown';
      const uname = sale.cashierName || sale.staffName || uid;
      addToAgg(uid, uname, saleTotal);
    } else if (gb === 'paymentMethod') {
      const pm = sale.paymentMethod || sale.payment?.method || 'unknown';
      addToAgg(pm, pm, saleTotal);
    } else if (gb === 'hour') {
      const saleTime = sale.saleDate || (sale.createdAt?.toDate?.() || new Date()).toISOString();
      const hour = new Date(saleTime).getHours();
      const label = `${String(hour).padStart(2, '0')}:00`;
      addToAgg(String(hour), label, saleTotal);
    } else if (gb === 'day') {
      const saleDay = (sale.saleDate || '').slice(0, 10);
      addToAgg(saleDay, saleDay, saleTotal);
    } else if (gb === 'week') {
      const saleDate = new Date(sale.saleDate || new Date().toISOString());
      const dayOfWeek = saleDate.getDay();
      const weekStart = new Date(saleDate);
      weekStart.setDate(saleDate.getDate() - dayOfWeek);
      const weekKey = weekStart.toISOString().slice(0, 10);
      addToAgg(weekKey, `Week of ${weekKey}`, saleTotal);
    }
  }

  // Sort and compute contributions
  const totalRevenue = Object.values(agg).reduce((s, v) => s + v.revenue, 0);

  const data = Object.values(agg)
    .map(v => ({
      dimension: v.label,
      key: v.key,
      revenue: _r2(v.revenue),
      count: v.count,
      contribution: totalRevenue > 0 ? _r2((v.revenue / totalRevenue) * 100) : 0,
    }))
    .sort((a, b) => b.revenue - a.revenue);

  return {
    data,
    total: _r2(totalRevenue),
    groupBy: gb,
    saleCount: sales.length,
    period: { startDate: start, endDate: end },
    generatedAt: new Date().toISOString(),
  };
});

// ─────────────────────────────────────────────────────────────────────────────

/**
 * getRevenueTrend
 * Role: manager+
 * Returns a time-series of revenue, transactions, and average basket.
 *
 * Input:
 *   sellerId    {string}
 *   period      {'week'|'month'|'quarter'}  — determines date window
 *   granularity {'daily'|'weekly'|'monthly'}
 *
 * Output:
 *   { series: [{ date, revenue, transactions, avgBasket }], period, granularity, generatedAt }
 */
exports.getRevenueTrend = onCall(_CF, async (req) => {
  const auth = _requireAuth(req);
  _requireRole(auth, 'manager');

  const { sellerId, period, granularity } = req.data;
  const sid  = _req(sellerId, 'sellerId');
  const per  = _san(period || 'month', 20);
  const gran = _san(granularity || 'daily', 20);

  const validGranularities = ['daily', 'weekly', 'monthly'];
  if (!validGranularities.includes(gran)) {
    throw new HttpsError('invalid-argument', `granularity must be one of: ${validGranularities.join(', ')}`);
  }

  const callerSellerId = auth.token?.sellerId;
  const isAdmin = auth.token?.admin || auth.token?.role === 'super_admin';
  if (!isAdmin && callerSellerId !== sid) {
    throw new HttpsError('permission-denied', 'Access denied for this seller');
  }

  // Determine date range based on period
  const now = new Date();
  let startDate;
  if (per === 'week')    { startDate = new Date(now); startDate.setDate(startDate.getDate() - 6); }
  else if (per === 'month')  { startDate = new Date(now.getFullYear(), now.getMonth(), 1); }
  else if (per === 'quarter') { startDate = new Date(now.getFullYear(), Math.floor(now.getMonth() / 3) * 3, 1); }
  else { startDate = new Date(now); startDate.setDate(startDate.getDate() - 29); } // default 30 days

  const startIso = startDate.toISOString().slice(0, 10);
  const endIso   = now.toISOString().slice(0, 10);

  const sales = await _fetchSales(sid, startIso, endIso, 10000);

  // Bucket key function
  const getBucketKey = (saleDateStr) => {
    const d = new Date(saleDateStr || new Date().toISOString());
    if (gran === 'daily') {
      return d.toISOString().slice(0, 10);
    } else if (gran === 'weekly') {
      const dayOfWeek = d.getDay();
      const weekStart = new Date(d);
      weekStart.setDate(d.getDate() - dayOfWeek);
      return weekStart.toISOString().slice(0, 10);
    } else {
      // monthly
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    }
  };

  // Aggregate
  const buckets = {};
  for (const sale of sales) {
    const key = getBucketKey(sale.saleDate || (sale.createdAt?.toDate?.() || new Date()).toISOString());
    if (!buckets[key]) buckets[key] = { date: key, revenue: 0, transactions: 0 };
    buckets[key].revenue      += _num(sale.totalAmount || sale.total, 0);
    buckets[key].transactions += 1;
  }

  const series = Object.values(buckets)
    .map(b => ({
      date: b.date,
      revenue: _r2(b.revenue),
      transactions: b.transactions,
      avgBasket: b.transactions > 0 ? _r2(b.revenue / b.transactions) : 0,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));

  return {
    series,
    period: { name: per, startDate: startIso, endDate: endIso },
    granularity: gran,
    generatedAt: new Date().toISOString(),
  };
});

// ══════════════════════════════════════════════════════════════════════════════
// SECTION C — INVENTORY HEALTH SCORE
// ══════════════════════════════════════════════════════════════════════════════

/**
 * getInventoryHealthScore
 * Role: cashier+
 * Calculates a 0-100 inventory health score for a seller.
 *
 * Scoring:
 *   - 10 points deducted per stockout event (stock === 0)
 *   - 5 points deducted per overstock item (stock > reorderPoint * 5)
 *   - 2 points deducted per expiring batch (expiresAt < 30 days from now)
 *   Score is clamped to [0, 100].
 *
 * Grade:  A ≥ 90  |  B ≥ 75  |  C ≥ 60  |  D ≥ 40  |  F < 40
 *
 * Input:
 *   sellerId {string}
 *
 * Output:
 *   { score, grade, stockoutEvents, overstockItems, expiringCount, expiringValue, turnoverRate, generatedAt }
 */
exports.getInventoryHealthScore = onCall(_CF, async (req) => {
  const auth = _requireAuth(req);

  const sid = _req(req.data?.sellerId, 'sellerId');

  const callerSellerId = auth.token?.sellerId;
  const isAdmin = auth.token?.admin || auth.token?.role === 'super_admin';
  if (!isAdmin && callerSellerId !== sid) {
    throw new HttpsError('permission-denied', 'Access denied for this seller');
  }

  // Fetch all products for this seller
  const productsSnap = await db.collection('sellers').doc(sid)
    .collection('products')
    .limit(2000)
    .get();

  let stockoutEvents = 0;
  let overstockItems = 0;
  let totalStock     = 0;
  let productCount   = 0;

  for (const pd of productsSnap.docs) {
    const data = pd.data();
    const stock        = _num(data.stock, 0);
    const reorderPoint = _num(data.reorderPoint, 5);

    productCount++;
    totalStock += stock;

    if (stock === 0) {
      stockoutEvents++;
    } else if (stock > reorderPoint * 5) {
      overstockItems++;
    }
  }

  // Expiring batches (< 30 days)
  const now30 = new Date(); now30.setDate(now30.getDate() + 30);
  const expiring30Iso = now30.toISOString().slice(0, 10);

  let expiringCount = 0;
  let expiringValue = 0;

  try {
    const batchSnap = await db.collection('posBatches')
      .where('sellerId', '==', sid)
      .where('expiresAt', '<=', expiring30Iso)
      .where('consumed', '==', false)
      .limit(500)
      .get();

    expiringCount = batchSnap.size;
    for (const bd of batchSnap.docs) {
      const bdata = bd.data();
      const remainingQty  = _num(bdata.remainingQty || bdata.quantity, 0);
      const costPrice     = _num(bdata.costPrice || bdata.unitCost, 0);
      expiringValue += remainingQty * costPrice;
    }
  } catch (_) { /* posBatches may not exist yet — gracefully degrade */ }

  // Turnover rate: last 30-day sales / avg stock
  let turnoverRate = 0;
  try {
    const thirtyDaysAgo = new Date(); thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const recentSalesSnap = await db.collection('posSales')
      .where('sellerId', '==', sid)
      .where('saleDate', '>=', thirtyDaysAgo.toISOString().slice(0, 10))
      .where('status', '==', 'completed')
      .limit(3000)
      .get();

    let unitsSold = 0;
    for (const sd of recentSalesSnap.docs) {
      const items = sd.data().items || [];
      for (const item of items) {
        unitsSold += _num(item.quantity, 0);
      }
    }

    const avgDailySales = unitsSold / 30;
    const avgStock      = productCount > 0 ? totalStock / productCount : 0;
    turnoverRate = avgStock > 0 ? _r2((avgDailySales * 30) / avgStock) : 0;
  } catch (_) { /* gracefully degrade */ }

  // Compute score
  const penalties = (stockoutEvents * 10) + (overstockItems * 5) + (expiringCount * 2);
  const score     = Math.max(0, Math.min(100, 100 - penalties));

  // Grade
  const grade = score >= 90 ? 'A'
    : score >= 75 ? 'B'
    : score >= 60 ? 'C'
    : score >= 40 ? 'D'
    : 'F';

  return {
    score,
    grade,
    stockoutEvents,
    overstockItems,
    expiringCount,
    expiringValue: _r2(expiringValue),
    turnoverRate,
    productCount,
    generatedAt: new Date().toISOString(),
  };
});

// ══════════════════════════════════════════════════════════════════════════════
// SECTION D — CUSTOMER GROWTH METRICS
// ══════════════════════════════════════════════════════════════════════════════

/**
 * getCustomerGrowthMetrics
 * Role: manager+
 * Returns customer growth, churn, CLV, repeat rate, and top customer list.
 *
 * Input:
 *   sellerId {string}
 *   period   {'today'|'week'|'month'|'quarter'}
 *
 * Output:
 *   { newCustomers, returningCustomers, churnedCustomers, averageCLV,
 *     repeatRate, topCustomers, period, generatedAt }
 */
exports.getCustomerGrowthMetrics = onCall(_CF, async (req) => {
  const auth = _requireAuth(req);
  _requireRole(auth, 'manager');

  const sid    = _req(req.data?.sellerId, 'sellerId');
  const period = _san(req.data?.period || 'month', 20);

  const callerSellerId = auth.token?.sellerId;
  const isAdmin = auth.token?.admin || auth.token?.role === 'super_admin';
  if (!isAdmin && callerSellerId !== sid) {
    throw new HttpsError('permission-denied', 'Access denied for this seller');
  }

  const bounds = _periodBounds(period);
  const { currentStart, currentEnd, priorStart, priorEnd } = bounds;

  // Fetch customers and sales in parallel
  const [customersSnap, currentSales, priorSales] = await Promise.all([
    db.collection('posCustomers').where('sellerId', '==', sid).limit(50000).get(),
    _fetchSales(sid, currentStart, currentEnd, 5000),
    _fetchSales(sid, priorStart, priorEnd, 5000),
  ]);

  // Build customer maps
  const allCustomers = customersSnap.docs.map(d => ({ id: d.id, ...d.data() }));

  const newCustomerIds = new Set(
    allCustomers
      .filter(c => {
        const createdIso = (c.createdAt?.toDate?.() || new Date(c.createdAt || 0)).toISOString().slice(0, 10);
        return createdIso >= currentStart && createdIso <= currentEnd;
      })
      .map(c => c.id),
  );

  // Customers who purchased in the current period
  const currentPurchaserIds = new Set(currentSales.map(s => s.customerId).filter(Boolean));
  // Customers who purchased in the prior period
  const priorPurchaserIds   = new Set(priorSales.map(s => s.customerId).filter(Boolean));

  const returningCustomers = [...currentPurchaserIds].filter(id => !newCustomerIds.has(id)).length;

  // Churned: purchased in prior period but NOT in current period
  const churnedCustomers = [...priorPurchaserIds].filter(id => !currentPurchaserIds.has(id)).length;

  // CLV: total spend by each customer across all time
  const customerSpend = {};
  for (const sale of [...currentSales, ...priorSales]) {
    const cid = sale.customerId;
    if (!cid) continue;
    customerSpend[cid] = (customerSpend[cid] || 0) + _num(sale.totalAmount || sale.total, 0);
  }

  const totalSpend      = Object.values(customerSpend).reduce((s, v) => s + v, 0);
  const totalCustomers  = allCustomers.length;
  const averageCLV      = totalCustomers > 0 ? _r2(totalSpend / totalCustomers) : 0;

  // Repeat rate
  const totalInPeriod = currentPurchaserIds.size;
  const repeatRate    = totalInPeriod > 0 ? _r2(returningCustomers / totalInPeriod) : 0;

  // Top 10 customers by total spend
  const topCustomers = Object.entries(customerSpend)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([cid, spent]) => {
      const customer = allCustomers.find(c => c.id === cid) || {};
      return {
        customerId: cid,
        name: customer.name || customer.displayName || 'Unknown',
        phone: customer.phone || null,
        totalSpent: _r2(spent),
      };
    });

  return {
    newCustomers: newCustomerIds.size,
    returningCustomers,
    churnedCustomers,
    averageCLV,
    repeatRate,
    topCustomers,
    totalCustomers,
    period: { name: period, currentStart, currentEnd },
    generatedAt: new Date().toISOString(),
  };
});

// ══════════════════════════════════════════════════════════════════════════════
// SECTION E — STAFF PRODUCTIVITY
// ══════════════════════════════════════════════════════════════════════════════

/**
 * getStaffProductivityMetrics
 * Role: manager+
 * Returns per-cashier productivity metrics ranked by sales per hour.
 *
 * Input:
 *   sellerId {string}
 *   period   {'today'|'week'|'month'|'quarter'}
 *
 * Output:
 *   { staff: [{ uid, name, salesPerHour, transactionsPerHour, avgBasket,
 *               discountRate, returnRate, totalRevenue, totalTransactions }],
 *     period, generatedAt }
 */
exports.getStaffProductivityMetrics = onCall(_CF, async (req) => {
  const auth = _requireAuth(req);
  _requireRole(auth, 'manager');

  const sid    = _req(req.data?.sellerId, 'sellerId');
  const period = _san(req.data?.period || 'month', 20);

  const callerSellerId = auth.token?.sellerId;
  const isAdmin = auth.token?.admin || auth.token?.role === 'super_admin';
  if (!isAdmin && callerSellerId !== sid) {
    throw new HttpsError('permission-denied', 'Access denied for this seller');
  }

  const bounds = _periodBounds(period);
  const { currentStart, currentEnd, days } = bounds;

  const sales = await _fetchSales(sid, currentStart, currentEnd, 5000);

  // Per-cashier aggregation
  const cashierMap = {};

  for (const sale of sales) {
    const uid   = sale.cashierId || sale.staffId || 'unknown';
    const uname = sale.cashierName || sale.staffName || uid;

    if (!cashierMap[uid]) {
      cashierMap[uid] = {
        uid,
        name: uname,
        totalRevenue: 0,
        totalTransactions: 0,
        totalDiscount: 0,
        returns: 0,
      };
    }

    const total    = _num(sale.totalAmount || sale.total, 0);
    const discount = _num(sale.discountAmount || sale.discount, 0);
    const isReturn = sale.type === 'return' || sale.isReturn === true;

    cashierMap[uid].totalRevenue       += total;
    cashierMap[uid].totalTransactions  += 1;
    cashierMap[uid].totalDiscount      += discount;
    if (isReturn) cashierMap[uid].returns += 1;
  }

  // Assume 8 working hours per day; days from period
  const workingHours = Math.max(1, days * 8);

  const staff = Object.values(cashierMap).map(c => {
    const avgBasket    = c.totalTransactions > 0 ? _r2(c.totalRevenue / c.totalTransactions) : 0;
    const discountRate = c.totalRevenue > 0 ? _r2((c.totalDiscount / (c.totalRevenue + c.totalDiscount)) * 100) : 0;
    const returnRate   = c.totalTransactions > 0 ? _r2((c.returns / c.totalTransactions) * 100) : 0;

    return {
      uid: c.uid,
      name: c.name,
      totalRevenue: _r2(c.totalRevenue),
      totalTransactions: c.totalTransactions,
      salesPerHour: _r2(c.totalRevenue / workingHours),
      transactionsPerHour: _r2(c.totalTransactions / workingHours),
      avgBasket,
      discountRate,
      returnRate,
    };
  }).sort((a, b) => b.salesPerHour - a.salesPerHour);

  return {
    staff,
    period: { name: period, currentStart, currentEnd, estimatedWorkingHours: workingHours },
    generatedAt: new Date().toISOString(),
  };
});

// ══════════════════════════════════════════════════════════════════════════════
// SECTION F — CATEGORY PERFORMANCE
// ══════════════════════════════════════════════════════════════════════════════

/**
 * getCategoryPerformance
 * Role: manager+
 * Groups sales by product category and returns revenue, units, and contribution.
 *
 * Input:
 *   sellerId  {string}
 *   startDate {string} — YYYY-MM-DD
 *   endDate   {string} — YYYY-MM-DD
 *
 * Output:
 *   { categories: [{ category, revenue, units, margin, contribution, trend }],
 *     total, period, generatedAt }
 */
exports.getCategoryPerformance = onCall(_CF, async (req) => {
  const auth = _requireAuth(req);
  _requireRole(auth, 'manager');

  const { sellerId, startDate, endDate } = req.data;
  const sid   = _req(sellerId, 'sellerId');
  const start = _req(startDate, 'startDate');
  const end   = _req(endDate, 'endDate');

  const callerSellerId = auth.token?.sellerId;
  const isAdmin = auth.token?.admin || auth.token?.role === 'super_admin';
  if (!isAdmin && callerSellerId !== sid) {
    throw new HttpsError('permission-denied', 'Access denied for this seller');
  }

  const diffDays = (new Date(end) - new Date(start)) / (1000 * 60 * 60 * 24);
  if (diffDays < 0 || diffDays > 366) {
    throw new HttpsError('invalid-argument', 'Date range must be between 0 and 366 days');
  }

  // Fetch current and prior period
  const priorStart = new Date(start);
  priorStart.setDate(priorStart.getDate() - Math.ceil(diffDays + 1));
  const priorStartIso = priorStart.toISOString().slice(0, 10);
  const priorEnd = new Date(start);
  priorEnd.setDate(priorEnd.getDate() - 1);
  const priorEndIso = priorEnd.toISOString().slice(0, 10);

  const [currentSales, priorSales] = await Promise.all([
    _fetchSales(sid, start, end, 5000),
    _fetchSales(sid, priorStartIso, priorEndIso, 5000),
  ]);

  const aggregateByCategory = (sales) => {
    const map = {};
    for (const sale of sales) {
      if (!Array.isArray(sale.items)) continue;
      for (const item of sale.items) {
        const cat      = _san(item.category || 'Uncategorised', 100);
        const revenue  = _num(item.quantity, 1) * _num(item.price || item.unitPrice, 0);
        const cost     = _num(item.quantity, 1) * _num(item.costPrice || item.unitCost, 0);
        const units    = _num(item.quantity, 1);
        if (!map[cat]) map[cat] = { revenue: 0, cost: 0, units: 0 };
        map[cat].revenue += revenue;
        map[cat].cost    += cost;
        map[cat].units   += units;
      }
    }
    return map;
  };

  const currentAgg = aggregateByCategory(currentSales);
  const priorAgg   = aggregateByCategory(priorSales);

  const totalRevenue = Object.values(currentAgg).reduce((s, v) => s + v.revenue, 0);

  const categories = Object.entries(currentAgg)
    .map(([cat, v]) => {
      const priorCat  = priorAgg[cat] || { revenue: 0 };
      const margin    = v.revenue > 0 ? _r2(((v.revenue - v.cost) / v.revenue) * 100) : 0;
      const contribution = totalRevenue > 0 ? _r2((v.revenue / totalRevenue) * 100) : 0;
      const trend     = _pctChange(v.revenue, priorCat.revenue);

      return {
        category: cat,
        revenue: _r2(v.revenue),
        units: Math.round(v.units),
        margin,
        contribution,
        trend,
      };
    })
    .sort((a, b) => b.revenue - a.revenue);

  return {
    categories,
    total: _r2(totalRevenue),
    period: { startDate: start, endDate: end },
    generatedAt: new Date().toISOString(),
  };
});

// ══════════════════════════════════════════════════════════════════════════════
// SECTION G — REVENUE FORECAST
// ══════════════════════════════════════════════════════════════════════════════

/**
 * getRevenueForecast
 * Role: manager+
 * Projects revenue for the coming N days using linear regression on the
 * last 90 days of daily totals, blended with a 7-day rolling average.
 *
 * Algorithm:
 *   1. Build daily revenue array for the last 90 days.
 *   2. Compute OLS linear regression: forecast = a + b * dayIndex.
 *   3. Compute 7-day rolling average for the most recent window.
 *   4. Blend: blended = 0.6 * regression + 0.4 * rollingAvg.
 *   5. Compute residual std-dev for confidence interval (±1 σ).
 *   6. Confidence score = 100 - min(50, stdDev / max(mean, 1) * 100).
 *
 * Input:
 *   sellerId    {string}
 *   horizonDays {7|14|30}
 *
 * Output:
 *   { forecast: [{ date, forecast, lower, upper }], confidenceScore, period, generatedAt }
 */
exports.getRevenueForecast = onCall(_CF, async (req) => {
  const auth = _requireAuth(req);
  _requireRole(auth, 'manager');

  const { sellerId, horizonDays } = req.data;
  const sid     = _req(sellerId, 'sellerId');
  const horizon = parseInt(horizonDays, 10);

  if (![7, 14, 30].includes(horizon)) {
    throw new HttpsError('invalid-argument', 'horizonDays must be 7, 14, or 30');
  }

  const callerSellerId = auth.token?.sellerId;
  const isAdmin = auth.token?.admin || auth.token?.role === 'super_admin';
  if (!isAdmin && callerSellerId !== sid) {
    throw new HttpsError('permission-denied', 'Access denied for this seller');
  }

  // Fetch 90 days of historical data
  const historyDays = 90;
  const histStart   = new Date(); histStart.setDate(histStart.getDate() - historyDays);
  const histStartIso = histStart.toISOString().slice(0, 10);
  const todayIso     = new Date().toISOString().slice(0, 10);

  const sales = await _fetchSales(sid, histStartIso, todayIso, 20000);

  // Build day-by-day revenue map
  const dayRevMap = {};
  for (const sale of sales) {
    const day = (sale.saleDate || new Date().toISOString()).slice(0, 10);
    dayRevMap[day] = (dayRevMap[day] || 0) + _num(sale.totalAmount || sale.total, 0);
  }

  // Generate ordered daily array for last 90 days
  const dailyRevenues = [];
  const dailyDates    = [];
  for (let i = historyDays - 1; i >= 0; i--) {
    const d = new Date(); d.setDate(d.getDate() - i);
    const iso = d.toISOString().slice(0, 10);
    dailyDates.push(iso);
    dailyRevenues.push(dayRevMap[iso] || 0);
  }

  const n = dailyRevenues.length;

  // OLS Linear Regression: y = a + bx  (x = 0..n-1)
  const xMean = (n - 1) / 2;
  const yMean = dailyRevenues.reduce((s, v) => s + v, 0) / n;

  let ssXY = 0;
  let ssXX = 0;
  for (let i = 0; i < n; i++) {
    ssXY += (i - xMean) * (dailyRevenues[i] - yMean);
    ssXX += (i - xMean) ** 2;
  }

  const b = ssXX !== 0 ? ssXY / ssXX : 0;  // slope
  const a = yMean - b * xMean;              // intercept

  // 7-day rolling average of the last 7 data points
  const lastWeek = dailyRevenues.slice(-7);
  const rollingAvg = lastWeek.reduce((s, v) => s + v, 0) / Math.max(lastWeek.length, 1);

  // Residuals for std-dev (in-sample)
  let sumSqResiduals = 0;
  for (let i = 0; i < n; i++) {
    const predicted = a + b * i;
    sumSqResiduals += (dailyRevenues[i] - predicted) ** 2;
  }
  const stdDev = n > 1 ? Math.sqrt(sumSqResiduals / (n - 1)) : 0;

  // Confidence score (0-100): penalise high relative dispersion
  const confidenceScore = Math.max(
    0,
    Math.min(100, Math.round(100 - Math.min(50, (stdDev / Math.max(yMean, 1)) * 100))),
  );

  // Build forecast array
  const forecastArr = [];
  for (let i = 0; i < horizon; i++) {
    const futureDate = new Date(); futureDate.setDate(futureDate.getDate() + i + 1);
    const futureDateIso = futureDate.toISOString().slice(0, 10);
    const futureDayIndex = n + i;

    const regressionForecast = Math.max(0, a + b * futureDayIndex);
    const blended = (0.6 * regressionForecast) + (0.4 * rollingAvg);

    forecastArr.push({
      date: futureDateIso,
      forecast: _r2(blended),
      lower: _r2(Math.max(0, blended - stdDev)),
      upper: _r2(blended + stdDev),
    });
  }

  return {
    forecast: forecastArr,
    confidenceScore,
    historicalDays: n,
    historicalMeanRevenue: _r2(yMean),
    trend: b > 0 ? 'increasing' : b < 0 ? 'decreasing' : 'flat',
    trendSlope: _r2(b),
    period: { historyStart: histStartIso, historyEnd: todayIso, horizonDays: horizon },
    generatedAt: new Date().toISOString(),
  };
});

// ══════════════════════════════════════════════════════════════════════════════
// SECTION H — PAYMENT TREND ANALYSIS
// ══════════════════════════════════════════════════════════════════════════════

/**
 * getPaymentTrends
 * Role: manager+
 * Returns a daily time-series of payment method distribution and
 * a current-vs-prior period shift in method preference.
 *
 * Input:
 *   sellerId  {string}
 *   startDate {string} — YYYY-MM-DD
 *   endDate   {string} — YYYY-MM-DD
 *
 * Output:
 *   {
 *     series:  [{ date, mpesa, cash, card, qr, wallet, other }],
 *     summary: { current: {...}, prior: {...}, shift: {...} },
 *     period, generatedAt
 *   }
 */
exports.getPaymentTrends = onCall(_CF, async (req) => {
  const auth = _requireAuth(req);
  _requireRole(auth, 'manager');

  const { sellerId, startDate, endDate } = req.data;
  const sid   = _req(sellerId, 'sellerId');
  const start = _req(startDate, 'startDate');
  const end   = _req(endDate, 'endDate');

  const callerSellerId = auth.token?.sellerId;
  const isAdmin = auth.token?.admin || auth.token?.role === 'super_admin';
  if (!isAdmin && callerSellerId !== sid) {
    throw new HttpsError('permission-denied', 'Access denied for this seller');
  }

  const diffMs   = new Date(end) - new Date(start);
  const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
  if (diffDays < 0 || diffDays > 366) {
    throw new HttpsError('invalid-argument', 'Date range must be 0–366 days');
  }

  // Compute equivalent prior period
  const priorEnd_ = new Date(start); priorEnd_.setDate(priorEnd_.getDate() - 1);
  const priorStart_ = new Date(priorEnd_); priorStart_.setDate(priorStart_.getDate() - diffDays);
  const priorStartIso = priorStart_.toISOString().slice(0, 10);
  const priorEndIso   = priorEnd_.toISOString().slice(0, 10);

  const [currentSales, priorSales] = await Promise.all([
    _fetchSales(sid, start, end, 10000),
    _fetchSales(sid, priorStartIso, priorEndIso, 10000),
  ]);

  // Normalize payment method to one of: mpesa, cash, card, qr, wallet, other
  const normalizeMethod = (method) => {
    const m = (method || 'other').toLowerCase();
    if (m.includes('mpesa') || m.includes('m-pesa') || m.includes('mobile')) return 'mpesa';
    if (m === 'cash') return 'cash';
    if (m.includes('card') || m.includes('visa') || m.includes('mastercard')) return 'card';
    if (m.includes('qr')) return 'qr';
    if (m.includes('wallet') || m.includes('sokoni')) return 'wallet';
    return 'other';
  };

  // Build daily series
  const dayMap = {};
  const emptyDay = () => ({ mpesa: 0, cash: 0, card: 0, qr: 0, wallet: 0, other: 0 });

  for (const sale of currentSales) {
    const day = (sale.saleDate || new Date().toISOString()).slice(0, 10);
    if (!dayMap[day]) dayMap[day] = emptyDay();
    const pm  = normalizeMethod(sale.paymentMethod || sale.payment?.method);
    const amt = _num(sale.totalAmount || sale.total, 0);
    dayMap[day][pm] += amt;
  }

  const series = Object.entries(dayMap)
    .map(([date, v]) => ({ date, ...Object.fromEntries(Object.entries(v).map(([k, vv]) => [k, _r2(vv)])) }))
    .sort((a, b) => a.date.localeCompare(b.date));

  // Current summary totals
  const sumByMethod = (sales) => {
    const totals = emptyDay();
    for (const sale of sales) {
      const pm  = normalizeMethod(sale.paymentMethod || sale.payment?.method);
      totals[pm] += _num(sale.totalAmount || sale.total, 0);
    }
    const grandTotal = Object.values(totals).reduce((s, v) => s + v, 0);
    const pct = {};
    for (const [k, v] of Object.entries(totals)) {
      pct[`${k}Pct`] = grandTotal > 0 ? _r2((v / grandTotal) * 100) : 0;
      totals[k] = _r2(v);
    }
    return { ...totals, ...pct, grandTotal: _r2(grandTotal) };
  };

  const currentSummary = sumByMethod(currentSales);
  const priorSummary   = sumByMethod(priorSales);

  // Shift: difference in % share for each method
  const methods = ['mpesa', 'cash', 'card', 'qr', 'wallet', 'other'];
  const shift = {};
  for (const m of methods) {
    shift[m] = _r2((currentSummary[`${m}Pct`] || 0) - (priorSummary[`${m}Pct`] || 0));
  }

  return {
    series,
    summary: {
      current: currentSummary,
      prior:   priorSummary,
      shift,
    },
    period: { startDate: start, endDate: end, priorStart: priorStartIso, priorEnd: priorEndIso },
    generatedAt: new Date().toISOString(),
  };
});

// ══════════════════════════════════════════════════════════════════════════════
// SECTION I — SCHEDULED: DAILY BI SNAPSHOT
// ══════════════════════════════════════════════════════════════════════════════

/**
 * biDailySnapshot
 * Schedule: every 24 hours at 01:00 UTC.
 * Reads all active sellers with POS enabled and writes a daily KPI snapshot
 * to `posBISnapshots/{sellerId_YYYY-MM-DD}`.
 *
 * This data powers trend charts without requiring expensive real-time aggregation.
 *
 * Snapshot document fields:
 *   sellerId, date, revenue, transactions, avgBasket, newCustomers,
 *   returningCustomers, grossProfit, topProductId, topProductName,
 *   topProductRevenue, paymentMix (object), lowStockCount, createdAt
 */
exports.biDailySnapshot = onSchedule(
  { schedule: 'every 24 hours', timeZone: 'Africa/Nairobi', region: 'us-central1' },
  async (_event) => {
    const yesterday    = new Date(); yesterday.setDate(yesterday.getDate() - 1);
    const dateIso      = yesterday.toISOString().slice(0, 10);
    const snapshotDate = dateIso;

    _log('INFO', 'biDailySnapshot started', { date: snapshotDate });

    // Fetch all sellers with POS enabled
    let sellersSnap;
    try {
      sellersSnap = await db.collection('sellers')
        .where('posEnabled', '==', true)
        .where('active', '==', true)
        .limit(500)
        .get();
    } catch (err) {
      _log('ERROR', 'biDailySnapshot: could not fetch sellers', { err: err.message });
      return;
    }

    if (sellersSnap.empty) {
      _log('INFO', 'biDailySnapshot: no active POS sellers found');
      return;
    }

    let successCount = 0;
    let failCount    = 0;

    // Process sellers in batches to avoid overload
    const SELLER_CONCURRENCY = 10;
    const sellerDocs = sellersSnap.docs;

    for (let i = 0; i < sellerDocs.length; i += SELLER_CONCURRENCY) {
      const chunk = sellerDocs.slice(i, i + SELLER_CONCURRENCY);

      await Promise.all(chunk.map(async (sellerDoc) => {
        const sid = sellerDoc.id;

        try {
          // Fetch yesterday's sales
          const salesSnap = await db.collection('posSales')
            .where('sellerId', '==', sid)
            .where('saleDate', '>=', snapshotDate)
            .where('saleDate', '<=', snapshotDate)
            .where('status', '==', 'completed')
            .limit(5000)
            .get();

          const sales = salesSnap.docs.map(d => d.data());
          const revenue = sales.reduce((s, sale) => s + _num(sale.totalAmount || sale.total, 0), 0);
          const transactions = sales.length;
          const avgBasket    = transactions > 0 ? _r2(revenue / transactions) : 0;
          const totalCost    = sales.reduce((s, sale) => s + _num(sale.totalCost || 0, 0), 0);
          const grossProfit  = _r2(revenue - totalCost);

          // Customer breakdown (new vs returning)
          const purchaserIds = [...new Set(sales.map(s => s.customerId).filter(Boolean))];
          let newCustomers = 0;
          let returningCustomers = 0;

          if (purchaserIds.length > 0 && purchaserIds.length <= 500) {
            const customerSnap = await db.collection('posCustomers')
              .where('sellerId', '==', sid)
              .where(admin.firestore.FieldPath.documentId(), 'in', purchaserIds.slice(0, 30))
              .get();

            for (const cd of customerSnap.docs) {
              const createdIso = (cd.data().createdAt?.toDate?.() || new Date(cd.data().createdAt || 0)).toISOString().slice(0, 10);
              if (createdIso === snapshotDate) newCustomers++;
              else returningCustomers++;
            }
          }

          // Top product
          const productRevMap = {};
          for (const sale of sales) {
            if (Array.isArray(sale.items)) {
              for (const item of sale.items) {
                const pid  = item.productId || '';
                const pname = item.productName || item.name || pid;
                const rev  = _num(item.quantity, 1) * _num(item.price || item.unitPrice, 0);
                if (!productRevMap[pid]) productRevMap[pid] = { pid, pname, rev: 0 };
                productRevMap[pid].rev += rev;
              }
            }
          }
          const topProduct = Object.values(productRevMap).sort((a, b) => b.rev - a.rev)[0] || null;

          // Payment mix
          const paymentMix = {};
          for (const sale of sales) {
            const pm = (sale.paymentMethod || sale.payment?.method || 'other').toLowerCase();
            paymentMix[pm] = (paymentMix[pm] || 0) + _num(sale.totalAmount || sale.total, 0);
          }

          // Low stock count (lightweight)
          let lowStockCount = 0;
          try {
            const lowSnap = await db.collection('sellers').doc(sid).collection('products')
              .where('stock', '<=', 5)
              .count()
              .get();
            lowStockCount = lowSnap.data().count;
          } catch (_) { /* non-fatal */ }

          // Write snapshot
          const snapshotId = `${sid}_${snapshotDate}`;
          await db.collection('posBISnapshots').doc(snapshotId).set({
            sellerId: sid,
            date: snapshotDate,
            revenue: _r2(revenue),
            transactions,
            avgBasket,
            grossProfit,
            newCustomers,
            returningCustomers,
            topProductId:      topProduct?.pid || null,
            topProductName:    topProduct?.pname || null,
            topProductRevenue: topProduct ? _r2(topProduct.rev) : 0,
            paymentMix: Object.fromEntries(
              Object.entries(paymentMix).map(([k, v]) => [k, _r2(v)]),
            ),
            lowStockCount,
            createdAt: _TS(),
          }, { merge: false });

          successCount++;
        } catch (err) {
          failCount++;
          _log('ERROR', 'biDailySnapshot: seller snapshot failed', { sellerId: sid, err: err.message });
        }
      }));
    }

    _log('NOTICE', 'biDailySnapshot completed', {
      date: snapshotDate,
      total: sellerDocs.length,
      successCount,
      failCount,
    });
  },
);
