'use strict';

/* ============================================================================
   SOKONI — Analytics Rollup (R1.x Phase 3, historical buckets)

   The aggregator writes `analytics/daily_YYYY-MM-DD` on every event. This job folds
   those daily buckets into the period aggregates dashboards need, so no dashboard
   scans collections for a "last 30 days" or "this quarter" number:

     analytics/window_7d              rolling last 7 days
     analytics/window_30d             rolling last 30 days
     analytics/month_YYYY-MM          calendar month
     analytics/quarter_YYYY-Qn        calendar quarter
     analytics/year_YYYY              calendar year
   (Today = analytics/daily_<today> · Yesterday = analytics/daily_<yesterday> · Lifetime = analytics/global.)

   Global-scoped only for now (bounded: ~366 daily reads/run). Per-shop period rollups are a
   deferred optimization — shops already have summary (lifetime) + daily buckets.
============================================================================ */

const admin = require('firebase-admin');

const METRICS = [
  'paidOrders', 'gmvShillings', 'settledOrders', 'gmvSettledShillings',
  'platformRevenueShillings', 'sellerEarningsShillings', 'deliveries', 'riderEarningsShillings',
  'refunds', 'refundAmountShillings', 'cancellations',
];
const _zero = () => Object.fromEntries(METRICS.map((m) => [m, 0]));
const _dstr = (d) => d.toISOString().slice(0, 10);

/** Roll global daily buckets into window/period aggregates. `asOf` (ms) lets tests pin "now". */
async function rollupGlobal(db, asOf) {
  const FV = admin.firestore.FieldValue;
  const now = asOf ? new Date(asOf) : new Date();
  const todayMonth = _dstr(now).slice(0, 7);
  const todayYear  = _dstr(now).slice(0, 4);
  const q = Math.floor(now.getUTCMonth() / 3) + 1;

  /* read the last 366 daily buckets by deterministic id (no index needed) */
  const dates = [];
  for (let i = 0; i < 366; i++) {
    const d = new Date(now);
    d.setUTCDate(now.getUTCDate() - i);
    dates.push(_dstr(d));
  }
  const snaps = await db.getAll(...dates.map((ds) => db.doc(`analytics/daily_${ds}`)));

  const w7 = _zero(), w30 = _zero(), month = _zero(), quarter = _zero(), year = _zero();
  snaps.forEach((s, i) => {
    if (!s.exists) return;
    const data = s.data() || {};
    const ds = dates[i];
    const sameYear = ds.slice(0, 4) === todayYear;
    const dq = Math.floor((Number(ds.slice(5, 7)) - 1) / 3) + 1;
    for (const m of METRICS) {
      const v = Number(data[m] || 0);
      if (v === 0) continue;
      if (i < 7) w7[m] += v;
      if (i < 30) w30[m] += v;
      if (ds.slice(0, 7) === todayMonth) month[m] += v;
      if (sameYear) year[m] += v;
      if (sameYear && dq === q) quarter[m] += v;
    }
  });

  const stamp = (obj, extra) => Object.assign({}, obj, extra, { updatedAt: FV.serverTimestamp() });
  const quarterId = `${todayYear}-Q${q}`;
  await Promise.allSettled([
    db.doc('analytics/window_7d').set(stamp(w7, { window: '7d' }), { merge: true }),
    db.doc('analytics/window_30d').set(stamp(w30, { window: '30d' }), { merge: true }),
    db.doc(`analytics/month_${todayMonth}`).set(stamp(month, { period: todayMonth }), { merge: true }),
    db.doc(`analytics/quarter_${quarterId}`).set(stamp(quarter, { period: quarterId }), { merge: true }),
    db.doc(`analytics/year_${todayYear}`).set(stamp(year, { period: todayYear }), { merge: true }),
  ]);
  return { w7, w30, month, quarter, year, quarterId, monthId: todayMonth, yearId: todayYear };
}

/* ── R1.x Phase 4: Business Intelligence (derived ratios) ──
   Pre-compute the ratio metrics dashboards show, straight from the canonical aggregates, so no
   dashboard divides raw counts itself (and every dashboard shows the SAME BI numbers). Writes
   `analytics/bi` with a lifetime + last-30-days block. Dimensional BI (top products, peak hours,
   CLV, inventory turnover) needs per-dimension aggregation → Phase 4b. */
function _bi(a) {
  a = a || {};
  const paid    = Number(a.paidOrders || 0);
  const gmv     = Number(a.gmvShillings || 0);
  const settled = Number(a.settledOrders || 0);
  const pct = (num, den) => (den > 0 ? Math.round((num / den) * 10000) / 100 : 0);
  return {
    grossRevenueShillings:    gmv,
    netPlatformRevShillings:  Number(a.platformRevenueShillings || 0),
    merchantEarningsShillings: Number(a.sellerEarningsShillings || 0),
    riderEarningsShillings:   Number(a.riderEarningsShillings || 0),
    gmvSettledShillings:      Number(a.gmvSettledShillings || 0),
    paidOrders:               paid,
    settledOrders:            settled,
    deliveries:               Number(a.deliveries || 0),
    avgOrderValueShillings:   paid > 0 ? Math.round(gmv / paid) : 0,
    refundRatePct:            pct(Number(a.refunds || 0), paid),
    cancellationRatePct:      pct(Number(a.cancellations || 0), paid),
    settlementRatePct:        pct(settled, paid),
    deliverySuccessRatePct:   pct(Number(a.deliveries || 0), paid),
    refundAmountShillings:    Number(a.refundAmountShillings || 0),
  };
}

/** Compute BI from lifetime (analytics/global) + last-30-days (analytics/window_30d); write analytics/bi. */
async function computeBI(db) {
  const FV = admin.firestore.FieldValue;
  const [g, w30] = await Promise.all([
    db.doc('analytics/global').get(),
    db.doc('analytics/window_30d').get(),
  ]);
  const bi = { lifetime: _bi(g.data()), last30d: _bi(w30.data()), updatedAt: FV.serverTimestamp() };
  await db.doc('analytics/bi').set(bi, { merge: true });
  return bi;
}

/* ── R1.x Phase 4b: top lists + peak hours (pre-computed from the dimensional docs) ──
   Reads productAnalytics / categoryAnalytics / hourly_* and writes ONE dashboard-ready doc so
   no dashboard runs its own top-N query or hour scan. */
async function computeTopLists(db) {
  const FV = admin.firestore.FieldValue;
  const [prodSnap, catSnap, hs, hd] = await Promise.all([
    db.collection('productAnalytics').orderBy('unitsSold', 'desc').limit(20).get().catch(() => ({ docs: [] })),
    db.collection('categoryAnalytics').orderBy('unitsSold', 'desc').limit(20).get().catch(() => ({ docs: [] })),
    db.doc('analytics/hourly_sales').get(),
    db.doc('analytics/hourly_delivery').get(),
  ]);
  const topProducts = prodSnap.docs.map((d) => ({
    productId: d.id, name: (d.data().name || null),
    unitsSold: Number(d.data().unitsSold || 0), revenueShillings: Number(d.data().revenueShillings || 0),
  }));
  const topCategories = catSnap.docs.map((d) => ({
    category: d.data().category || d.id,
    unitsSold: Number(d.data().unitsSold || 0), revenueShillings: Number(d.data().revenueShillings || 0),
  }));
  const salesH = hs.data() || {}, delH = hd.data() || {};
  let peakSalesHourUTC = null, peakSalesOrders = -1, peakDeliveryHourUTC = null, peakDeliveries = -1;
  for (let h = 0; h < 24; h++) {
    const o = Number(salesH[`h${h}_orders`] || 0);
    if (o > peakSalesOrders) { peakSalesOrders = o; peakSalesHourUTC = h; }
    const dc = Number(delH[`h${h}_deliveries`] || 0);
    if (dc > peakDeliveries) { peakDeliveries = dc; peakDeliveryHourUTC = h; }
  }
  const out = {
    topProducts, topCategories,
    peakSalesHourUTC, peakSalesOrders: Math.max(0, peakSalesOrders),
    peakDeliveryHourUTC, peakDeliveries: Math.max(0, peakDeliveries),
    note: 'hours are UTC; EAT = UTC+3',
    updatedAt: FV.serverTimestamp(),
  };
  await db.doc('analytics/top_lists').set(out, { merge: true });
  return { topProducts: topProducts.length, topCategories: topCategories.length, peakSalesHourUTC, peakDeliveryHourUTC };
}

module.exports = { rollupGlobal, computeBI, computeTopLists, METRICS };
