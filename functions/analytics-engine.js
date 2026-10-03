'use strict';
/**
 * SOKONI Analytics Engine — Sprint 4.5
 * 34 Cloud Functions across 6 modules:
 *   Sales Analytics (7), Traffic & Funnels (6), Customer Cohorts (5),
 *   Product Performance (6), Real-Time Ops (5), Custom Reports (5)
 */
const { onCall, onSchedule } = require('firebase-functions/v2/https');
const { onSchedule: onSched } = require('firebase-functions/v2/scheduler');
const admin = require('firebase-admin');
const { defineSecret } = require('firebase-functions/params');

// ── helpers ──────────────────────────────────────────────────────────────────
function _db()  { return admin.firestore(); }
function _fv()  { return admin.firestore.FieldValue; }
function _ts()  { return admin.firestore.FieldValue.serverTimestamp(); }
function _id()  { return _db().collection('_').doc().id; }
function _esc(s){ return String(s||'').replace(/[<>"']/g,''); }
function _san(v,max){ return String(v||'').slice(0,max); }

const _CALL = { region: 'us-central1', enforceAppCheck: true };

// Handler registry — consumed by analytics-dispatch.js
exports._h = {};

/** Resolve a period string → { fromMs, toMs } */
function _period(period, customFrom, customTo) {
  const now = Date.now();
  const DAY = 86400000;
  const map = { '1d':1,'7d':7,'14d':14,'30d':30,'60d':60,'90d':90,'180d':180,'365d':365,'ytd':-1 };
  if (period === 'ytd') {
    const jan1 = new Date(new Date().getFullYear(), 0, 1).getTime();
    return { fromMs: jan1, toMs: now };
  }
  if (period === 'custom' && customFrom && customTo) {
    return { fromMs: new Date(customFrom).getTime(), toMs: new Date(customTo).getTime() };
  }
  const days = map[period] || 30;
  return { fromMs: now - days * DAY, toMs: now };
}

/** Bucket a timestamp (ms) into a date label by granularity */
function _bucket(ms, granularity) {
  const d = new Date(ms);
  if (granularity === 'hour') {
    return d.toISOString().slice(0, 13) + ':00';
  }
  if (granularity === 'week') {
    const day = d.getDay();
    const monday = new Date(ms - day * 86400000);
    return 'W:' + monday.toISOString().slice(0, 10);
  }
  if (granularity === 'month') {
    return d.toISOString().slice(0, 7);
  }
  return d.toISOString().slice(0, 10); // day default
}

/** Auto-detect best granularity for a time range */
function _autoGranularity(fromMs, toMs) {
  const diffDays = (toMs - fromMs) / 86400000;
  if (diffDays <= 2)   return 'hour';
  if (diffDays <= 90)  return 'day';
  if (diffDays <= 365) return 'week';
  return 'month';
}

/** Build zero-filled time series map from fromMs to toMs */
function _emptyTimeSeries(fromMs, toMs, granularity) {
  const map = {};
  let cursor = fromMs;
  const DAY = 86400000, HOUR = 3600000;
  const step = granularity === 'hour' ? HOUR : granularity === 'week' ? 7 * DAY : granularity === 'month' ? 30 * DAY : DAY;
  const max = 500; let i = 0;
  while (cursor <= toMs && i++ < max) {
    map[_bucket(cursor, granularity)] = 0;
    cursor += step;
  }
  return map;
}

async function _assertShop(uid, shopId) {
  const shopSnap = await _db().collection('shops').doc(shopId).get();
  if (!shopSnap.exists) throw new Error('Shop not found');
  const d = shopSnap.data();
  if (d.ownerId === uid) return 'owner';
  const empSnap = await _db().collection('shopEmployees').doc(shopId + '_' + uid).get();
  if (empSnap.exists) return empSnap.data().role || 'employee';
  const claims = (await admin.auth().getUser(uid)).customClaims || {};
  if (claims.role === 'admin' || claims.role === 'superAdmin') return 'admin';
  throw new Error('Access denied');
}

async function _assertAdmin(uid) {
  const claims = (await admin.auth().getUser(uid)).customClaims || {};
  if (claims.role !== 'admin' && claims.role !== 'superAdmin') throw new Error('Admin only');
}

// ── clamp helpers ─────────────────────────────────────────────────────────────
function _clampInt(v, lo, hi, def) { const n = parseInt(v); return isNaN(n) ? def : Math.min(hi, Math.max(lo, n)); }

// ══════════════════════════════════════════════════════════════════════════════
// MODULE 1 — SALES ANALYTICS (7 CFs)
// ══════════════════════════════════════════════════════════════════════════════

/** salesGetSummary — revenue, orders, AOV, refunds for a shop/period */
exports.salesGetSummary = onCall(_CALL, exports._h.salesGetSummary = async req => {
  const uid = req.auth?.uid; if (!uid) throw new Error('Unauthenticated');
  const { shopId, period = '30d', customFrom, customTo } = req.data || {};
  if (!shopId) throw new Error('shopId required');
  await _assertShop(uid, shopId);
  const { fromMs, toMs } = _period(period, customFrom, customTo);
  const fromTs = admin.firestore.Timestamp.fromMillis(fromMs);
  const prevFrom = admin.firestore.Timestamp.fromMillis(fromMs - (toMs - fromMs));
  const prevTo   = fromTs;

  // Current period
  const [curSnap, prevSnap, refSnap] = await Promise.all([
    _db().collection('orders').where('shopId', '==', shopId).where('createdAt', '>=', fromTs).limit(2000).get(),
    _db().collection('orders').where('shopId', '==', shopId).where('createdAt', '>=', prevFrom).where('createdAt', '<', prevTo).limit(2000).get(),
    _db().collection('refunds').where('shopId', '==', shopId).where('createdAt', '>=', fromTs).limit(500).get(),
  ]);

  function _agg(docs) {
    return docs.reduce((acc, d) => {
      const data = d.data();
      if (['completed','delivered','paid'].includes(data.status)) {
        acc.revenue += (data.total || 0);
        acc.orders++;
      }
      return acc;
    }, { revenue: 0, orders: 0 });
  }

  const cur  = _agg(curSnap.docs);
  const prev = _agg(prevSnap.docs);
  const refundTotal = refSnap.docs.reduce((s, d) => s + (d.data().amount || 0), 0);

  const pctChange = (key) => prev[key] === 0 ? null : Math.round(((cur[key] - prev[key]) / prev[key]) * 100);

  return {
    period, fromMs, toMs,
    revenue:        cur.revenue,
    orders:         cur.orders,
    aov:            cur.orders ? Math.round(cur.revenue / cur.orders) : 0,
    refunds:        refundTotal,
    netRevenue:     cur.revenue - refundTotal,
    prevRevenue:    prev.revenue,
    prevOrders:     prev.orders,
    revenueChange:  pctChange('revenue'),
    ordersChange:   pctChange('orders'),
  };
});

/** salesGetTimeSeries — revenue + order count bucketed by day/week/month */
exports.salesGetTimeSeries = onCall(_CALL, exports._h.salesGetTimeSeries = async req => {
  const uid = req.auth?.uid; if (!uid) throw new Error('Unauthenticated');
  const { shopId, period = '30d', customFrom, customTo, granularity } = req.data || {};
  if (!shopId) throw new Error('shopId required');
  await _assertShop(uid, shopId);
  const { fromMs, toMs } = _period(period, customFrom, customTo);
  const gran = granularity || _autoGranularity(fromMs, toMs);
  const fromTs = admin.firestore.Timestamp.fromMillis(fromMs);

  const snap = await _db().collection('orders').where('shopId', '==', shopId)
    .where('createdAt', '>=', fromTs).limit(3000).get();

  const revenueMap = _emptyTimeSeries(fromMs, toMs, gran);
  const ordersMap  = { ...revenueMap };
  for (const key of Object.keys(revenueMap)) ordersMap[key] = 0;

  snap.docs.forEach(d => {
    const data = d.data();
    if (!['completed','delivered','paid'].includes(data.status)) return;
    const ms = data.createdAt?.toMillis?.() || 0;
    if (ms < fromMs || ms > toMs) return;
    const key = _bucket(ms, gran);
    if (revenueMap[key] !== undefined) { revenueMap[key] += (data.total || 0); ordersMap[key]++; }
  });

  return {
    granularity: gran,
    series: Object.keys(revenueMap).map(label => ({
      label, revenue: Math.round(revenueMap[label]), orders: ordersMap[label],
    })),
  };
});

/** salesGetByCategory — revenue breakdown by product category */
exports.salesGetByCategory = onCall(_CALL, exports._h.salesGetByCategory = async req => {
  const uid = req.auth?.uid; if (!uid) throw new Error('Unauthenticated');
  const { shopId, period = '30d', customFrom, customTo } = req.data || {};
  if (!shopId) throw new Error('shopId required');
  await _assertShop(uid, shopId);
  const { fromMs, toMs } = _period(period, customFrom, customTo);
  const fromTs = admin.firestore.Timestamp.fromMillis(fromMs);

  const snap = await _db().collection('orderItems').where('shopId', '==', shopId)
    .where('createdAt', '>=', fromTs).limit(5000).get();

  const catMap = {};
  snap.docs.forEach(d => {
    const { category = 'Uncategorised', total = 0, quantity = 1 } = d.data();
    if (!catMap[category]) catMap[category] = { revenue: 0, units: 0, orders: new Set() };
    catMap[category].revenue += total;
    catMap[category].units   += quantity;
    if (d.data().orderId) catMap[category].orders.add(d.data().orderId);
  });

  const rows = Object.entries(catMap).map(([category, v]) => ({
    category, revenue: Math.round(v.revenue), units: v.units, orders: v.orders.size,
  })).sort((a, b) => b.revenue - a.revenue);

  const total = rows.reduce((s, r) => s + r.revenue, 0);
  return { rows: rows.slice(0, 50).map(r => ({ ...r, share: total ? Math.round((r.revenue / total) * 100) : 0 })) };
});

/** salesGetByChannel — marketplace vs POS vs API vs WhatsApp */
exports.salesGetByChannel = onCall(_CALL, exports._h.salesGetByChannel = async req => {
  const uid = req.auth?.uid; if (!uid) throw new Error('Unauthenticated');
  const { shopId, period = '30d' } = req.data || {};
  if (!shopId) throw new Error('shopId required');
  await _assertShop(uid, shopId);
  const { fromMs } = _period(period);
  const fromTs = admin.firestore.Timestamp.fromMillis(fromMs);

  const snap = await _db().collection('orders').where('shopId', '==', shopId)
    .where('createdAt', '>=', fromTs).limit(3000).get();

  const channels = {};
  snap.docs.forEach(d => {
    const data = d.data();
    if (!['completed','delivered','paid'].includes(data.status)) return;
    const ch = data.channel || data.source || 'marketplace';
    if (!channels[ch]) channels[ch] = { revenue: 0, orders: 0 };
    channels[ch].revenue += (data.total || 0);
    channels[ch].orders++;
  });

  return {
    channels: Object.entries(channels).map(([channel, v]) => ({
      channel, revenue: Math.round(v.revenue), orders: v.orders,
    })).sort((a, b) => b.revenue - a.revenue),
  };
});

/** salesGetPaymentMethodBreakdown — M-Pesa vs card vs cash vs wallet */
exports.salesGetPaymentMethodBreakdown = onCall(_CALL, exports._h.salesGetPaymentMethodBreakdown = async req => {
  const uid = req.auth?.uid; if (!uid) throw new Error('Unauthenticated');
  const { shopId, period = '30d' } = req.data || {};
  if (!shopId) throw new Error('shopId required');
  await _assertShop(uid, shopId);
  const { fromMs } = _period(period);
  const fromTs = admin.firestore.Timestamp.fromMillis(fromMs);

  const snap = await _db().collection('orders').where('shopId', '==', shopId)
    .where('createdAt', '>=', fromTs).limit(3000).get();

  const methods = {};
  snap.docs.forEach(d => {
    const data = d.data();
    if (!['completed','delivered','paid'].includes(data.status)) return;
    const m = data.paymentMethod || data.payment?.method || 'unknown';
    if (!methods[m]) methods[m] = { revenue: 0, count: 0 };
    methods[m].revenue += (data.total || 0);
    methods[m].count++;
  });

  const total = Object.values(methods).reduce((s, v) => s + v.revenue, 0);
  return {
    methods: Object.entries(methods).map(([method, v]) => ({
      method, revenue: Math.round(v.revenue), count: v.count,
      share: total ? Math.round((v.revenue / total) * 100) : 0,
    })).sort((a, b) => b.revenue - a.revenue),
  };
});

/** salesGetTopProducts — top N products by revenue, units, or orders */
exports.salesGetTopProducts = onCall(_CALL, exports._h.salesGetTopProducts = async req => {
  const uid = req.auth?.uid; if (!uid) throw new Error('Unauthenticated');
  const { shopId, period = '30d', metric = 'revenue', limit: lim } = req.data || {};
  if (!shopId) throw new Error('shopId required');
  await _assertShop(uid, shopId);
  const n = _clampInt(lim, 5, 50, 20);
  const { fromMs } = _period(period);
  const fromTs = admin.firestore.Timestamp.fromMillis(fromMs);

  const snap = await _db().collection('orderItems').where('shopId', '==', shopId)
    .where('createdAt', '>=', fromTs).limit(5000).get();

  const products = {};
  snap.docs.forEach(d => {
    const { productId, productName, total = 0, quantity = 1 } = d.data();
    if (!productId) return;
    if (!products[productId]) products[productId] = { productId, productName: productName || productId, revenue: 0, units: 0, orders: new Set() };
    products[productId].revenue += total;
    products[productId].units   += quantity;
    if (d.data().orderId) products[productId].orders.add(d.data().orderId);
  });

  const rows = Object.values(products).map(p => ({ ...p, orders: p.orders.size }));
  rows.sort((a, b) => b[metric] - a[metric]);
  return { metric, rows: rows.slice(0, n).map(r => ({ ...r, revenue: Math.round(r.revenue) })) };
});

/** salesGetHourlyHeatmap — order volume by day-of-week × hour-of-day */
exports.salesGetHourlyHeatmap = onCall(_CALL, exports._h.salesGetHourlyHeatmap = async req => {
  const uid = req.auth?.uid; if (!uid) throw new Error('Unauthenticated');
  const { shopId, period = '30d' } = req.data || {};
  if (!shopId) throw new Error('shopId required');
  await _assertShop(uid, shopId);
  const { fromMs } = _period(period);
  const fromTs = admin.firestore.Timestamp.fromMillis(fromMs);

  const snap = await _db().collection('orders').where('shopId', '==', shopId)
    .where('createdAt', '>=', fromTs).limit(3000).get();

  // matrix[dow 0-6][hour 0-23]
  const matrix = Array.from({ length: 7 }, () => new Array(24).fill(0));
  snap.docs.forEach(d => {
    const data = d.data();
    if (!['completed','delivered','paid'].includes(data.status)) return;
    const dt = data.createdAt?.toDate?.() || new Date(data.createdAt?._seconds * 1000 || 0);
    matrix[dt.getDay()][dt.getHours()]++;
  });

  return { matrix, days: ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'] };
});

// ══════════════════════════════════════════════════════════════════════════════
// MODULE 2 — TRAFFIC & FUNNELS (6 CFs)
// ══════════════════════════════════════════════════════════════════════════════

/** analyticsTrackEvent — client-side event ingestion (page views, clicks, etc.) */
exports.analyticsTrackEvent = onCall({ region: 'us-central1', enforceAppCheck: true }, exports._h.analyticsTrackEvent = async req => {
  const uid = req.auth?.uid || null;
  const { shopId, eventType, properties = {} } = req.data || {};
  if (!shopId || !eventType) throw new Error('shopId and eventType required');

  const allowed = ['page_view','product_view','add_to_cart','checkout_start','checkout_complete','search','click'];
  if (!allowed.includes(eventType)) throw new Error('Unknown event type');

  await _db().collection('analyticsEvents').add({
    shopId: _san(shopId, 64),
    uid: uid || null,
    eventType,
    properties: Object.fromEntries(
      Object.entries(properties).slice(0, 20).map(([k, v]) => [_san(k, 50), _san(String(v), 200)])
    ),
    sessionId: _san(properties.sessionId || '', 64),
    createdAt: _ts(),
  });
  return { ok: true };
});

/** analyticsGetFunnel — conversion rates across a defined funnel */
exports.analyticsGetFunnel = onCall(_CALL, exports._h.analyticsGetFunnel = async req => {
  const uid = req.auth?.uid; if (!uid) throw new Error('Unauthenticated');
  const { shopId, period = '30d', funnelSteps } = req.data || {};
  if (!shopId) throw new Error('shopId required');
  await _assertShop(uid, shopId);

  const steps = Array.isArray(funnelSteps) && funnelSteps.length >= 2
    ? funnelSteps.slice(0, 6)
    : ['page_view', 'product_view', 'add_to_cart', 'checkout_start', 'checkout_complete'];

  const { fromMs } = _period(period);
  const fromTs = admin.firestore.Timestamp.fromMillis(fromMs);

  const snap = await _db().collection('analyticsEvents').where('shopId', '==', shopId)
    .where('createdAt', '>=', fromTs).limit(10000).get();

  // Count unique sessions per step (step counts sessions that reached that step at minimum)
  const sessionsByStep = {};
  steps.forEach(s => { sessionsByStep[s] = new Set(); });

  snap.docs.forEach(d => {
    const { eventType, sessionId } = d.data();
    if (steps.includes(eventType) && sessionId) {
      sessionsByStep[eventType].add(sessionId);
    }
  });

  const result = steps.map((step, i) => {
    const count = sessionsByStep[step].size;
    const prev  = i === 0 ? count : sessionsByStep[steps[i - 1]].size;
    return {
      step, count,
      conversionFromPrev: prev ? Math.round((count / prev) * 100) : 0,
      conversionFromTop:  sessionsByStep[steps[0]].size
        ? Math.round((count / sessionsByStep[steps[0]].size) * 100) : 0,
    };
  });

  return { steps: result };
});

/** analyticsGetTopPages — most visited pages/products */
exports.analyticsGetTopPages = onCall(_CALL, exports._h.analyticsGetTopPages = async req => {
  const uid = req.auth?.uid; if (!uid) throw new Error('Unauthenticated');
  const { shopId, period = '7d', limit: lim } = req.data || {};
  if (!shopId) throw new Error('shopId required');
  await _assertShop(uid, shopId);
  const n = _clampInt(lim, 5, 50, 20);
  const { fromMs } = _period(period);
  const fromTs = admin.firestore.Timestamp.fromMillis(fromMs);

  const snap = await _db().collection('analyticsEvents').where('shopId', '==', shopId)
    .where('eventType', '==', 'page_view').where('createdAt', '>=', fromTs).limit(5000).get();

  const pages = {};
  snap.docs.forEach(d => {
    const { properties = {} } = d.data();
    const page = properties.page || properties.url || 'unknown';
    if (!pages[page]) pages[page] = { views: 0, unique: new Set() };
    pages[page].views++;
    if (d.data().uid) pages[page].unique.add(d.data().uid);
    else if (d.data().sessionId) pages[page].unique.add(d.data().sessionId);
  });

  return {
    pages: Object.entries(pages).map(([page, v]) => ({
      page, views: v.views, unique: v.unique.size,
    })).sort((a, b) => b.views - a.views).slice(0, n),
  };
});

/** analyticsGetSearchTerms — what customers search for in your shop */
exports.analyticsGetSearchTerms = onCall(_CALL, exports._h.analyticsGetSearchTerms = async req => {
  const uid = req.auth?.uid; if (!uid) throw new Error('Unauthenticated');
  const { shopId, period = '30d', limit: lim } = req.data || {};
  if (!shopId) throw new Error('shopId required');
  await _assertShop(uid, shopId);
  const n = _clampInt(lim, 5, 50, 20);
  const { fromMs } = _period(period);
  const fromTs = admin.firestore.Timestamp.fromMillis(fromMs);

  const snap = await _db().collection('analyticsEvents').where('shopId', '==', shopId)
    .where('eventType', '==', 'search').where('createdAt', '>=', fromTs).limit(3000).get();

  const terms = {};
  snap.docs.forEach(d => {
    const q = _san((d.data().properties || {}).query || '', 100).toLowerCase().trim();
    if (!q) return;
    terms[q] = (terms[q] || 0) + 1;
  });

  return {
    terms: Object.entries(terms).map(([term, count]) => ({ term, count }))
      .sort((a, b) => b.count - a.count).slice(0, n),
  };
});

/** analyticsGetCartAbandonment — sessions that added to cart but didn't checkout */
exports.analyticsGetCartAbandonment = onCall(_CALL, exports._h.analyticsGetCartAbandonment = async req => {
  const uid = req.auth?.uid; if (!uid) throw new Error('Unauthenticated');
  const { shopId, period = '30d' } = req.data || {};
  if (!shopId) throw new Error('shopId required');
  await _assertShop(uid, shopId);
  const { fromMs } = _period(period);
  const fromTs = admin.firestore.Timestamp.fromMillis(fromMs);

  const snap = await _db().collection('analyticsEvents').where('shopId', '==', shopId)
    .where('createdAt', '>=', fromTs).limit(10000).get();

  const cartSessions    = new Set();
  const checkoutSessions = new Set();

  snap.docs.forEach(d => {
    const { eventType, sessionId } = d.data();
    if (!sessionId) return;
    if (eventType === 'add_to_cart')         cartSessions.add(sessionId);
    if (eventType === 'checkout_complete')   checkoutSessions.add(sessionId);
  });

  const abandoned = [...cartSessions].filter(s => !checkoutSessions.has(s)).length;
  const rate = cartSessions.size ? Math.round((abandoned / cartSessions.size) * 100) : 0;

  return {
    cartSessions:     cartSessions.size,
    completedSessions: checkoutSessions.size,
    abandonedSessions: abandoned,
    abandonmentRate:  rate,
  };
});

/** analyticsGetTrafficSources — referrer breakdown (direct, social, search, etc.) */
exports.analyticsGetTrafficSources = onCall(_CALL, exports._h.analyticsGetTrafficSources = async req => {
  const uid = req.auth?.uid; if (!uid) throw new Error('Unauthenticated');
  const { shopId, period = '30d' } = req.data || {};
  if (!shopId) throw new Error('shopId required');
  await _assertShop(uid, shopId);
  const { fromMs } = _period(period);
  const fromTs = admin.firestore.Timestamp.fromMillis(fromMs);

  const snap = await _db().collection('analyticsEvents').where('shopId', '==', shopId)
    .where('eventType', '==', 'page_view').where('createdAt', '>=', fromTs).limit(5000).get();

  const sources = {};
  snap.docs.forEach(d => {
    const ref = ((d.data().properties || {}).referrer || 'direct').toLowerCase();
    let src = 'direct';
    if (ref.includes('google') || ref.includes('bing')) src = 'organic_search';
    else if (ref.includes('facebook') || ref.includes('instagram') || ref.includes('twitter') || ref.includes('whatsapp')) src = 'social';
    else if (ref !== 'direct' && ref !== '') src = 'referral';
    sources[src] = (sources[src] || 0) + 1;
  });

  const total = Object.values(sources).reduce((s, v) => s + v, 0);
  return {
    sources: Object.entries(sources).map(([source, views]) => ({
      source, views, share: total ? Math.round((views / total) * 100) : 0,
    })).sort((a, b) => b.views - a.views),
  };
});

// ══════════════════════════════════════════════════════════════════════════════
// MODULE 3 — CUSTOMER COHORTS (5 CFs)
// ══════════════════════════════════════════════════════════════════════════════

/** cohortGetRetention — classic N-day cohort retention matrix */
exports.cohortGetRetention = onCall(_CALL, exports._h.cohortGetRetention = async req => {
  const uid = req.auth?.uid; if (!uid) throw new Error('Unauthenticated');
  const { shopId, cohortMonths = 3 } = req.data || {};
  if (!shopId) throw new Error('shopId required');
  await _assertShop(uid, shopId);
  const months = _clampInt(cohortMonths, 1, 12, 3);
  const fromMs = Date.now() - months * 30 * 86400000;
  const fromTs = admin.firestore.Timestamp.fromMillis(fromMs);

  const snap = await _db().collection('orders').where('shopId', '==', shopId)
    .where('createdAt', '>=', fromTs).where('status', '==', 'completed').limit(5000).get();

  // Group orders by buyer, sort chronologically
  const byBuyer = {};
  snap.docs.forEach(d => {
    const { buyerId, createdAt } = d.data();
    if (!buyerId) return;
    if (!byBuyer[buyerId]) byBuyer[buyerId] = [];
    byBuyer[buyerId].push(createdAt?.toMillis?.() || 0);
  });

  // Cohort by first-purchase month
  const cohorts = {};
  Object.values(byBuyer).forEach(orders => {
    orders.sort((a, b) => a - b);
    const firstMonth = _bucket(orders[0], 'month');
    if (!cohorts[firstMonth]) cohorts[firstMonth] = { size: 0, returned: {} };
    cohorts[firstMonth].size++;
    orders.slice(1).forEach(ms => {
      const monthsLater = Math.round((ms - orders[0]) / (30 * 86400000));
      if (monthsLater >= 1) {
        cohorts[firstMonth].returned[monthsLater] = (cohorts[firstMonth].returned[monthsLater] || 0) + 1;
      }
    });
  });

  const maxPeriods = 6;
  const rows = Object.entries(cohorts).map(([month, c]) => ({
    month, size: c.size,
    retention: Array.from({ length: maxPeriods }, (_, i) => {
      const n = c.returned[i + 1] || 0;
      return { period: i + 1, count: n, rate: c.size ? Math.round((n / c.size) * 100) : 0 };
    }),
  })).sort((a, b) => a.month.localeCompare(b.month));

  return { rows };
});

/** cohortGetLTV — average lifetime value by acquisition month */
exports.cohortGetLTV = onCall(_CALL, exports._h.cohortGetLTV = async req => {
  const uid = req.auth?.uid; if (!uid) throw new Error('Unauthenticated');
  const { shopId, cohortMonths = 6 } = req.data || {};
  if (!shopId) throw new Error('shopId required');
  await _assertShop(uid, shopId);
  const months = _clampInt(cohortMonths, 1, 24, 6);
  const fromMs = Date.now() - months * 30 * 86400000;
  const fromTs = admin.firestore.Timestamp.fromMillis(fromMs);

  const snap = await _db().collection('orders').where('shopId', '==', shopId)
    .where('createdAt', '>=', fromTs).where('status', '==', 'completed').limit(5000).get();

  const cohortRevenue = {}, cohortSize = {}, cohortBuyers = {};

  snap.docs.forEach(d => {
    const { buyerId, createdAt, total = 0 } = d.data();
    if (!buyerId) return;
    const ms = createdAt?.toMillis?.() || 0;
    // Track each buyer's first-order month as their cohort
    if (!cohortBuyers[buyerId]) cohortBuyers[buyerId] = { firstMonth: _bucket(ms, 'month'), spent: 0 };
    if (ms < (cohortBuyers[buyerId].firstMs || Infinity)) cohortBuyers[buyerId].firstMonth = _bucket(ms, 'month');
    cohortBuyers[buyerId].spent += total;
  });

  Object.values(cohortBuyers).forEach(b => {
    const m = b.firstMonth;
    if (!cohortRevenue[m]) { cohortRevenue[m] = 0; cohortSize[m] = 0; }
    cohortRevenue[m] += b.spent;
    cohortSize[m]++;
  });

  return {
    cohorts: Object.entries(cohortRevenue).map(([month, rev]) => ({
      month, buyers: cohortSize[month],
      totalRevenue: Math.round(rev),
      avgLTV: cohortSize[month] ? Math.round(rev / cohortSize[month]) : 0,
    })).sort((a, b) => a.month.localeCompare(b.month)),
  };
});

/** cohortGetNewVsReturning — new vs returning buyer ratio */
exports.cohortGetNewVsReturning = onCall(_CALL, exports._h.cohortGetNewVsReturning = async req => {
  const uid = req.auth?.uid; if (!uid) throw new Error('Unauthenticated');
  const { shopId, period = '30d' } = req.data || {};
  if (!shopId) throw new Error('shopId required');
  await _assertShop(uid, shopId);
  const { fromMs, toMs } = _period(period);
  const fromTs  = admin.firestore.Timestamp.fromMillis(fromMs);

  // All orders ever for this shop to determine first-purchase date
  const allSnap = await _db().collection('orders').where('shopId', '==', shopId)
    .where('status', '==', 'completed').limit(5000).get();

  const firstPurchase = {};
  allSnap.docs.forEach(d => {
    const { buyerId, createdAt } = d.data();
    if (!buyerId) return;
    const ms = createdAt?.toMillis?.() || 0;
    if (!firstPurchase[buyerId] || ms < firstPurchase[buyerId]) firstPurchase[buyerId] = ms;
  });

  let newBuyers = 0, returningBuyers = 0, newRevenue = 0, returningRevenue = 0;
  allSnap.docs.forEach(d => {
    const { buyerId, total = 0, createdAt } = d.data();
    if (!buyerId) return;
    const ms = createdAt?.toMillis?.() || 0;
    if (ms < fromMs || ms > toMs) return;
    if (firstPurchase[buyerId] >= fromMs) { newBuyers++; newRevenue += total; }
    else { returningBuyers++; returningRevenue += total; }
  });

  return {
    newBuyers, returningBuyers,
    newRevenue: Math.round(newRevenue), returningRevenue: Math.round(returningRevenue),
    returningRate: (newBuyers + returningBuyers)
      ? Math.round((returningBuyers / (newBuyers + returningBuyers)) * 100) : 0,
  };
});

/** cohortGetChurn — buyers who haven't ordered in N days */
exports.cohortGetChurn = onCall(_CALL, exports._h.cohortGetChurn = async req => {
  const uid = req.auth?.uid; if (!uid) throw new Error('Unauthenticated');
  const { shopId, inactiveDays = 60 } = req.data || {};
  if (!shopId) throw new Error('shopId required');
  await _assertShop(uid, shopId);
  const inactive = _clampInt(inactiveDays, 14, 365, 60);
  const cutoffMs = Date.now() - inactive * 86400000;
  const cutoffTs = admin.firestore.Timestamp.fromMillis(cutoffMs);

  const snap = await _db().collection('orders').where('shopId', '==', shopId)
    .where('status', '==', 'completed').limit(5000).get();

  const lastOrder = {};
  snap.docs.forEach(d => {
    const { buyerId, createdAt } = d.data();
    if (!buyerId) return;
    const ms = createdAt?.toMillis?.() || 0;
    if (!lastOrder[buyerId] || ms > lastOrder[buyerId]) lastOrder[buyerId] = ms;
  });

  const allBuyers = Object.keys(lastOrder).length;
  const churned   = Object.values(lastOrder).filter(ms => ms < cutoffMs).length;
  const active    = allBuyers - churned;

  return {
    allBuyers, active, churned,
    churnRate: allBuyers ? Math.round((churned / allBuyers) * 100) : 0,
    inactiveDays: inactive,
  };
});

/** cohortGetTopBuyers — highest-value customers for a shop */
exports.cohortGetTopBuyers = onCall(_CALL, exports._h.cohortGetTopBuyers = async req => {
  const uid = req.auth?.uid; if (!uid) throw new Error('Unauthenticated');
  const { shopId, period = '90d', limit: lim } = req.data || {};
  if (!shopId) throw new Error('shopId required');
  await _assertShop(uid, shopId);
  const n = _clampInt(lim, 5, 50, 20);
  const { fromMs } = _period(period);
  const fromTs = admin.firestore.Timestamp.fromMillis(fromMs);

  const snap = await _db().collection('orders').where('shopId', '==', shopId)
    .where('createdAt', '>=', fromTs).where('status', '==', 'completed').limit(5000).get();

  const buyers = {};
  snap.docs.forEach(d => {
    const { buyerId, buyerName, buyerPhone, total = 0 } = d.data();
    if (!buyerId) return;
    if (!buyers[buyerId]) buyers[buyerId] = { buyerId, buyerName: buyerName || 'Unknown', buyerPhone: buyerPhone || null, spent: 0, orders: 0 };
    buyers[buyerId].spent  += total;
    buyers[buyerId].orders++;
  });

  return {
    buyers: Object.values(buyers)
      .sort((a, b) => b.spent - a.spent)
      .slice(0, n)
      .map(b => ({ ...b, spent: Math.round(b.spent), aov: Math.round(b.spent / b.orders) })),
  };
});

// ══════════════════════════════════════════════════════════════════════════════
// MODULE 4 — PRODUCT PERFORMANCE (6 CFs)
// ══════════════════════════════════════════════════════════════════════════════

/** productGetSalesVelocity — units/day sold per product */
exports.productGetSalesVelocity = onCall(_CALL, exports._h.productGetSalesVelocity = async req => {
  const uid = req.auth?.uid; if (!uid) throw new Error('Unauthenticated');
  const { shopId, period = '30d', limit: lim } = req.data || {};
  if (!shopId) throw new Error('shopId required');
  await _assertShop(uid, shopId);
  const n = _clampInt(lim, 5, 100, 30);
  const { fromMs, toMs } = _period(period);
  const days = Math.max(1, (toMs - fromMs) / 86400000);
  const fromTs = admin.firestore.Timestamp.fromMillis(fromMs);

  const snap = await _db().collection('orderItems').where('shopId', '==', shopId)
    .where('createdAt', '>=', fromTs).limit(5000).get();

  const products = {};
  snap.docs.forEach(d => {
    const { productId, productName, quantity = 1 } = d.data();
    if (!productId) return;
    if (!products[productId]) products[productId] = { productId, productName: productName || productId, units: 0 };
    products[productId].units += quantity;
  });

  return {
    days: Math.round(days),
    products: Object.values(products).map(p => ({
      ...p, velocity: Math.round((p.units / days) * 10) / 10,
    })).sort((a, b) => b.velocity - a.velocity).slice(0, n),
  };
});

/** productGetReturnRate — refund/return count per product */
exports.productGetReturnRate = onCall(_CALL, exports._h.productGetReturnRate = async req => {
  const uid = req.auth?.uid; if (!uid) throw new Error('Unauthenticated');
  const { shopId, period = '30d' } = req.data || {};
  if (!shopId) throw new Error('shopId required');
  await _assertShop(uid, shopId);
  const { fromMs } = _period(period);
  const fromTs = admin.firestore.Timestamp.fromMillis(fromMs);

  const [ordersSnap, returnsSnap] = await Promise.all([
    _db().collection('orderItems').where('shopId', '==', shopId).where('createdAt', '>=', fromTs).limit(5000).get(),
    _db().collection('returnItems').where('shopId', '==', shopId).where('createdAt', '>=', fromTs).limit(1000).get(),
  ]);

  const sold = {}, returned = {};
  ordersSnap.docs.forEach(d => {
    const { productId, quantity = 1 } = d.data();
    if (productId) sold[productId] = (sold[productId] || 0) + quantity;
  });
  returnsSnap.docs.forEach(d => {
    const { productId, quantity = 1 } = d.data();
    if (productId) returned[productId] = (returned[productId] || 0) + quantity;
  });

  const result = Object.keys(sold).map(productId => ({
    productId,
    sold: sold[productId],
    returned: returned[productId] || 0,
    returnRate: Math.round(((returned[productId] || 0) / sold[productId]) * 100),
  })).filter(r => r.returned > 0).sort((a, b) => b.returnRate - a.returnRate);

  return { products: result.slice(0, 50) };
});

/** productGetReviewSentiment — avg rating and review count per product */
exports.productGetReviewSentiment = onCall(_CALL, exports._h.productGetReviewSentiment = async req => {
  const uid = req.auth?.uid; if (!uid) throw new Error('Unauthenticated');
  const { shopId, limit: lim } = req.data || {};
  if (!shopId) throw new Error('shopId required');
  await _assertShop(uid, shopId);
  const n = _clampInt(lim, 5, 50, 20);

  const snap = await _db().collection('reviews').where('shopId', '==', shopId).limit(2000).get();

  const products = {};
  snap.docs.forEach(d => {
    const { productId, productName, rating = 0 } = d.data();
    if (!productId) return;
    if (!products[productId]) products[productId] = { productId, productName: productName || productId, totalRating: 0, count: 0, dist: {1:0,2:0,3:0,4:0,5:0} };
    products[productId].totalRating += rating;
    products[productId].count++;
    products[productId].dist[Math.round(rating)]++;
  });

  return {
    products: Object.values(products).map(p => ({
      productId: p.productId, productName: p.productName,
      avgRating: Math.round((p.totalRating / p.count) * 10) / 10,
      count: p.count, distribution: p.dist,
    })).sort((a, b) => b.count - a.count).slice(0, n),
  };
});

/** productGetMarginAnalysis — revenue vs cost for products with cost data */
exports.productGetMarginAnalysis = onCall(_CALL, exports._h.productGetMarginAnalysis = async req => {
  const uid = req.auth?.uid; if (!uid) throw new Error('Unauthenticated');
  const { shopId, period = '30d', limit: lim } = req.data || {};
  if (!shopId) throw new Error('shopId required');
  await _assertShop(uid, shopId);
  const n = _clampInt(lim, 5, 50, 20);
  const { fromMs } = _period(period);
  const fromTs = admin.firestore.Timestamp.fromMillis(fromMs);

  const snap = await _db().collection('orderItems').where('shopId', '==', shopId)
    .where('createdAt', '>=', fromTs).limit(5000).get();

  const products = {};
  snap.docs.forEach(d => {
    const { productId, productName, unitPrice = 0, costPrice = 0, quantity = 1 } = d.data();
    if (!productId) return;
    if (!products[productId]) products[productId] = { productId, productName: productName || productId, revenue: 0, cost: 0, units: 0 };
    products[productId].revenue += unitPrice * quantity;
    products[productId].cost    += costPrice * quantity;
    products[productId].units   += quantity;
  });

  return {
    products: Object.values(products)
      .filter(p => p.cost > 0)
      .map(p => ({
        ...p,
        revenue: Math.round(p.revenue), cost: Math.round(p.cost),
        grossProfit: Math.round(p.revenue - p.cost),
        margin: p.revenue ? Math.round(((p.revenue - p.cost) / p.revenue) * 100) : 0,
      }))
      .sort((a, b) => b.grossProfit - a.grossProfit)
      .slice(0, n),
  };
});

/** productGetInventoryTurnover — turnover ratio per product */
exports.productGetInventoryTurnover = onCall(_CALL, exports._h.productGetInventoryTurnover = async req => {
  const uid = req.auth?.uid; if (!uid) throw new Error('Unauthenticated');
  const { shopId, period = '30d' } = req.data || {};
  if (!shopId) throw new Error('shopId required');
  await _assertShop(uid, shopId);
  const { fromMs, toMs } = _period(period);
  const days = Math.max(1, (toMs - fromMs) / 86400000);
  const fromTs = admin.firestore.Timestamp.fromMillis(fromMs);

  const [soldSnap, stockSnap] = await Promise.all([
    _db().collection('orderItems').where('shopId', '==', shopId).where('createdAt', '>=', fromTs).limit(5000).get(),
    _db().collection('warehouseStock').where('shopId', '==', shopId).limit(500).get(),
  ]);

  const sold = {}, productNames = {};
  soldSnap.docs.forEach(d => {
    const { productId, productName, quantity = 1 } = d.data();
    if (!productId) return;
    sold[productId] = (sold[productId] || 0) + quantity;
    if (!productNames[productId]) productNames[productId] = productName || productId;
  });

  const stock = {};
  stockSnap.docs.forEach(d => {
    const { productId, quantityOnHand = 0 } = d.data();
    if (productId) stock[productId] = (stock[productId] || 0) + quantityOnHand;
  });

  const result = Object.keys(sold).map(productId => {
    const soldUnits = sold[productId];
    const onHand    = stock[productId] || 0;
    const avgInv    = (onHand + soldUnits) / 2;
    const turnover  = avgInv > 0 ? Math.round((soldUnits / avgInv) * 10) / 10 : null;
    const daysOnHand = turnover ? Math.round(days / turnover) : null;
    return { productId, productName: productNames[productId], soldUnits, onHand, turnover, daysOnHand };
  }).sort((a, b) => (b.turnover || 0) - (a.turnover || 0));

  return { days: Math.round(days), products: result.slice(0, 50) };
});

/** productGetSlowMovers — products sold fewer than N units in period */
exports.productGetSlowMovers = onCall(_CALL, exports._h.productGetSlowMovers = async req => {
  const uid = req.auth?.uid; if (!uid) throw new Error('Unauthenticated');
  const { shopId, period = '30d', threshold = 3 } = req.data || {};
  if (!shopId) throw new Error('shopId required');
  await _assertShop(uid, shopId);
  const thresh = _clampInt(threshold, 0, 100, 3);
  const { fromMs } = _period(period);
  const fromTs = admin.firestore.Timestamp.fromMillis(fromMs);

  const [soldSnap, productSnap] = await Promise.all([
    _db().collection('orderItems').where('shopId', '==', shopId).where('createdAt', '>=', fromTs).limit(5000).get(),
    _db().collection('products').where('shopId', '==', shopId).where('status', '==', 'active').limit(500).get(),
  ]);

  const sold = {};
  soldSnap.docs.forEach(d => {
    const { productId, quantity = 1 } = d.data();
    if (productId) sold[productId] = (sold[productId] || 0) + quantity;
  });

  const slow = productSnap.docs
    .map(d => ({ productId: d.id, ...d.data(), unitsSold: sold[d.id] || 0 }))
    .filter(p => p.unitsSold <= thresh)
    .sort((a, b) => a.unitsSold - b.unitsSold)
    .slice(0, 50);

  return { threshold: thresh, products: slow.map(p => ({ productId: p.productId, name: p.name || p.title, unitsSold: p.unitsSold, price: p.price || 0 })) };
});

// ══════════════════════════════════════════════════════════════════════════════
// MODULE 5 — REAL-TIME OPS (5 CFs)
// ══════════════════════════════════════════════════════════════════════════════

/** analyticsGetRealtimeSnapshot — live counters for admin dashboard */
exports.analyticsGetRealtimeSnapshot = onCall(_CALL, exports._h.analyticsGetRealtimeSnapshot = async req => {
  const uid = req.auth?.uid; if (!uid) throw new Error('Unauthenticated');
  const { shopId } = req.data || {};
  if (!shopId) throw new Error('shopId required');
  await _assertShop(uid, shopId);

  const todayStart = new Date(); todayStart.setHours(0,0,0,0);
  const todayTs = admin.firestore.Timestamp.fromDate(todayStart);
  const hourAgoTs = admin.firestore.Timestamp.fromMillis(Date.now() - 3600000);

  const [todayOrders, pendingOrders, lastHourRevSnap, openDisputesSnap, lowStockSnap] = await Promise.all([
    _db().collection('orders').where('shopId', '==', shopId).where('createdAt', '>=', todayTs).limit(500).get(),
    _db().collection('orders').where('shopId', '==', shopId).where('status', '==', 'pending').limit(100).get(),
    _db().collection('orders').where('shopId', '==', shopId).where('createdAt', '>=', hourAgoTs).limit(200).get(),
    _db().collection('disputes').where('shopId', '==', shopId).where('status', '==', 'open').limit(50).get(),
    _db().collection('warehouseStock').where('shopId', '==', shopId).where('quantityOnHand', '<=', 5).limit(50).get(),
  ]);

  const todayRevenue = todayOrders.docs
    .filter(d => ['completed','delivered','paid'].includes(d.data().status))
    .reduce((s, d) => s + (d.data().total || 0), 0);

  const lastHourRevenue = lastHourRevSnap.docs
    .filter(d => ['completed','delivered','paid'].includes(d.data().status))
    .reduce((s, d) => s + (d.data().total || 0), 0);

  return {
    todayOrders:      todayOrders.size,
    todayRevenue:     Math.round(todayRevenue),
    pendingOrders:    pendingOrders.size,
    lastHourRevenue:  Math.round(lastHourRevenue),
    openDisputes:     openDisputesSnap.size,
    lowStockSKUs:     lowStockSnap.size,
    timestamp:        Date.now(),
  };
});

/** analyticsGetPlatformSnapshot — platform-wide metrics (admin only) */
exports.analyticsGetPlatformSnapshot = onCall(_CALL, exports._h.analyticsGetPlatformSnapshot = async req => {
  const uid = req.auth?.uid; if (!uid) throw new Error('Unauthenticated');
  await _assertAdmin(uid);

  const todayStart = new Date(); todayStart.setHours(0,0,0,0);
  const todayTs = admin.firestore.Timestamp.fromDate(todayStart);
  const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
  const monthTs = admin.firestore.Timestamp.fromDate(monthStart);

  const [todayOrd, monthOrd, activeShops, pendingVerif, openDisp] = await Promise.all([
    _db().collection('orders').where('createdAt', '>=', todayTs).limit(1000).get(),
    _db().collection('orders').where('createdAt', '>=', monthTs).limit(5000).get(),
    _db().collection('shops').where('status', '==', 'active').limit(2000).get(),
    _db().collection('verificationRequests').where('status', '==', 'pending').limit(100).get(),
    _db().collection('disputes').where('status', '==', 'open').limit(200).get(),
  ]);

  const _rev = docs => docs.filter(d => ['completed','delivered','paid'].includes(d.data().status))
    .reduce((s, d) => s + (d.data().total || 0), 0);

  return {
    todayOrders:   todayOrd.size,
    todayRevenue:  Math.round(_rev(todayOrd.docs)),
    monthOrders:   monthOrd.size,
    monthRevenue:  Math.round(_rev(monthOrd.docs)),
    activeShops:   activeShops.size,
    pendingVerifications: pendingVerif.size,
    openDisputes:  openDisp.size,
    timestamp:     Date.now(),
  };
});

/** analyticsGetOrderStatusBreakdown — current order status distribution */
exports.analyticsGetOrderStatusBreakdown = onCall(_CALL, exports._h.analyticsGetOrderStatusBreakdown = async req => {
  const uid = req.auth?.uid; if (!uid) throw new Error('Unauthenticated');
  const { shopId, period = '7d' } = req.data || {};
  if (!shopId) throw new Error('shopId required');
  await _assertShop(uid, shopId);
  const { fromMs } = _period(period);
  const fromTs = admin.firestore.Timestamp.fromMillis(fromMs);

  const snap = await _db().collection('orders').where('shopId', '==', shopId)
    .where('createdAt', '>=', fromTs).limit(2000).get();

  const statuses = {};
  snap.docs.forEach(d => {
    const s = d.data().status || 'unknown';
    statuses[s] = (statuses[s] || 0) + 1;
  });

  const total = snap.size;
  return {
    total,
    statuses: Object.entries(statuses).map(([status, count]) => ({
      status, count, share: Math.round((count / total) * 100),
    })).sort((a, b) => b.count - a.count),
  };
});

/** analyticsGetAverageDeliveryTime — mean minutes from order creation to delivered */
exports.analyticsGetAverageDeliveryTime = onCall(_CALL, exports._h.analyticsGetAverageDeliveryTime = async req => {
  const uid = req.auth?.uid; if (!uid) throw new Error('Unauthenticated');
  const { shopId, period = '30d' } = req.data || {};
  if (!shopId) throw new Error('shopId required');
  await _assertShop(uid, shopId);
  const { fromMs } = _period(period);
  const fromTs = admin.firestore.Timestamp.fromMillis(fromMs);

  const snap = await _db().collection('orders').where('shopId', '==', shopId)
    .where('status', '==', 'delivered').where('createdAt', '>=', fromTs).limit(2000).get();

  const times = snap.docs.map(d => {
    const data = d.data();
    const created   = data.createdAt?.toMillis?.() || 0;
    const delivered = data.deliveredAt?.toMillis?.() || data.updatedAt?.toMillis?.() || 0;
    return delivered - created;
  }).filter(t => t > 0 && t < 86400000 * 7); // sanity: within 7 days

  if (!times.length) return { avgMinutes: null, samples: 0 };

  times.sort((a, b) => a - b);
  const avg = times.reduce((s, t) => s + t, 0) / times.length;
  const p50 = times[Math.floor(times.length * 0.5)];
  const p95 = times[Math.floor(times.length * 0.95)];

  return {
    samples:    times.length,
    avgMinutes: Math.round(avg / 60000),
    p50Minutes: Math.round(p50 / 60000),
    p95Minutes: Math.round(p95 / 60000),
  };
});

/** analyticsGetStaffPerformance — orders processed per staff member */
exports.analyticsGetStaffPerformance = onCall(_CALL, exports._h.analyticsGetStaffPerformance = async req => {
  const uid = req.auth?.uid; if (!uid) throw new Error('Unauthenticated');
  const { shopId, period = '30d' } = req.data || {};
  if (!shopId) throw new Error('shopId required');
  await _assertShop(uid, shopId);
  const { fromMs } = _period(period);
  const fromTs = admin.firestore.Timestamp.fromMillis(fromMs);

  const snap = await _db().collection('orders').where('shopId', '==', shopId)
    .where('createdAt', '>=', fromTs).limit(3000).get();

  const staff = {};
  snap.docs.forEach(d => {
    const { processedBy, processedByName, total = 0, status } = d.data();
    if (!processedBy) return;
    if (!staff[processedBy]) staff[processedBy] = { staffId: processedBy, name: processedByName || 'Unknown', orders: 0, revenue: 0 };
    staff[processedBy].orders++;
    if (['completed','delivered','paid'].includes(status)) staff[processedBy].revenue += total;
  });

  return {
    staff: Object.values(staff).sort((a, b) => b.revenue - a.revenue)
      .map(s => ({ ...s, revenue: Math.round(s.revenue) })).slice(0, 50),
  };
});

// ══════════════════════════════════════════════════════════════════════════════
// MODULE 6 — CUSTOM REPORTS (5 CFs)
// ══════════════════════════════════════════════════════════════════════════════

/** reportCreate — save a custom report definition */
exports.reportCreate = onCall(_CALL, exports._h.reportCreate = async req => {
  const uid = req.auth?.uid; if (!uid) throw new Error('Unauthenticated');
  const { shopId, name, description, metrics = [], filters = {}, schedule } = req.data || {};
  if (!shopId || !name) throw new Error('shopId and name required');
  await _assertShop(uid, shopId);

  const id = _id();
  await _db().collection('customReports').doc(id).set({
    id, shopId,
    name:        _san(name, 100),
    description: _san(description || '', 300),
    metrics:     (Array.isArray(metrics) ? metrics : []).slice(0, 20).map(m => _san(m, 50)),
    filters:     Object.fromEntries(Object.entries(filters).slice(0, 10).map(([k, v]) => [_san(k, 50), _san(String(v), 100)])),
    schedule:    schedule || null,
    createdBy:   uid,
    createdAt:   _ts(),
    updatedAt:   _ts(),
    lastRunAt:   null,
  });
  return { id };
});

/** reportList — list saved reports for a shop */
exports.reportList = onCall(_CALL, exports._h.reportList = async req => {
  const uid = req.auth?.uid; if (!uid) throw new Error('Unauthenticated');
  const { shopId } = req.data || {};
  if (!shopId) throw new Error('shopId required');
  await _assertShop(uid, shopId);

  const snap = await _db().collection('customReports').where('shopId', '==', shopId).limit(50).get();
  return { reports: snap.docs.map(d => d.data()) };
});

/** reportDelete — delete a saved report */
exports.reportDelete = onCall(_CALL, exports._h.reportDelete = async req => {
  const uid = req.auth?.uid; if (!uid) throw new Error('Unauthenticated');
  const { shopId, reportId } = req.data || {};
  if (!shopId || !reportId) throw new Error('shopId and reportId required');
  await _assertShop(uid, shopId);

  const snap = await _db().collection('customReports').doc(reportId).get();
  if (!snap.exists || snap.data().shopId !== shopId) throw new Error('Report not found');
  await _db().collection('customReports').doc(reportId).delete();
  return { ok: true };
});

/** analyticsExport — export a date-range data dump (CSV-format rows returned) */
exports.analyticsExport = onCall(_CALL, exports._h.analyticsExport = async req => {
  const uid = req.auth?.uid; if (!uid) throw new Error('Unauthenticated');
  const { shopId, dataType = 'orders', period = '30d', customFrom, customTo } = req.data || {};
  if (!shopId) throw new Error('shopId required');
  await _assertShop(uid, shopId);

  const allowed = ['orders', 'orderItems', 'analyticsEvents'];
  if (!allowed.includes(dataType)) throw new Error('Invalid dataType');

  const { fromMs } = _period(period, customFrom, customTo);
  const fromTs = admin.firestore.Timestamp.fromMillis(fromMs);

  const snap = await _db().collection(dataType).where('shopId', '==', shopId)
    .where('createdAt', '>=', fromTs).limit(2000).get();

  const rows = snap.docs.map(d => {
    const data = d.data();
    // Strip PII and internal fields from export
    delete data.buyerPhone; delete data.buyerEmail; delete data.paymentRef;
    delete data.idempotencyKey; delete data.internalNotes;
    return data;
  });

  return { count: rows.length, dataType, rows };
});

/** analyticsSnapshotDaily — scheduled: record daily KPI snapshots per shop */
exports.analyticsSnapshotDaily = require('firebase-functions/v2/scheduler').onSchedule(
  { schedule: 'every day 23:55', timeZone: 'Africa/Nairobi', region: 'us-central1' },
  async () => {
    const db = _db();
    const yesterday = new Date(); yesterday.setDate(yesterday.getDate() - 1);
    const dateStr = yesterday.toISOString().slice(0, 10);
    const dayStart = new Date(dateStr + 'T00:00:00.000Z');
    const dayEnd   = new Date(dateStr + 'T23:59:59.999Z');
    const startTs = admin.firestore.Timestamp.fromDate(dayStart);
    const endTs   = admin.firestore.Timestamp.fromDate(dayEnd);

    const shopsSnap = await db.collection('shops').where('status', '==', 'active').limit(500).get();
    const batch = db.batch();

    await Promise.all(shopsSnap.docs.map(async shopDoc => {
      const shopId = shopDoc.id;
      try {
        const ordSnap = await db.collection('orders').where('shopId', '==', shopId)
          .where('createdAt', '>=', startTs).where('createdAt', '<=', endTs).limit(500).get();
        const revenue = ordSnap.docs.filter(d => ['completed','delivered','paid'].includes(d.data().status))
          .reduce((s, d) => s + (d.data().total || 0), 0);
        const snapRef = db.collection('analyticsSnapshots').doc(shopId + '_' + dateStr);
        batch.set(snapRef, { shopId, date: dateStr, orders: ordSnap.size, revenue: Math.round(revenue), createdAt: _ts() });
      } catch (_) { /* non-fatal per shop */ }
    }));

    await batch.commit();
  }
);
