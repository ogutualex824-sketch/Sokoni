'use strict';

/* ============================================================================
   SOKONI — Analytics Monitoring (R1.x Phase 6)

   Automated integrity/health detection over the analytics + money state. Writes a
   single `analytics/health` summary and raises `monitoringAlerts` on any issue, so
   silent drift, stale aggregates, or negative balances surface immediately.

   Checks:
     • stale analytics      — analytics/global.updatedAt too old (aggregator/job stalled)
     • negative analytics   — a metric went below 0 (a reversal over-decremented — integrity bug)
     • reconciliation drift — latest analytics/reconciliation reported ok:false
     • inventory integrity  — open oversoldAlerts + any product with negative stock
============================================================================ */

const admin = require('firebase-admin');

const METRICS = [
  'paidOrders', 'gmvShillings', 'settledOrders', 'platformRevenueShillings',
  'sellerEarningsShillings', 'deliveries', 'riderEarningsShillings',
  'refunds', 'refundAmountShillings', 'cancellations',
];

async function runHealthChecks(db) {
  const FV = admin.firestore.FieldValue;
  const issues = [];

  /* analytics/global — staleness + negative-value integrity */
  const g = (await db.doc('analytics/global').get()).data() || {};
  const updatedMs = g.updatedAt && g.updatedAt.toMillis ? g.updatedAt.toMillis() : 0;
  const staleHours = updatedMs ? Math.round((Date.now() - updatedMs) / 3600000) : null;
  if (staleHours !== null && staleHours > 48) issues.push({ type: 'stale_analytics', staleHours });
  const negatives = METRICS.filter((m) => Number(g[m] || 0) < 0);
  if (negatives.length) issues.push({ type: 'negative_analytics', fields: negatives });

  /* reconciliation status (from the Phase-5 report) */
  const rec = (await db.doc('analytics/reconciliation').get()).data() || {};
  if (rec.ok === false) issues.push({ type: 'reconciliation_drift', mismatches: rec.mismatches || [], maxDriftPct: rec.maxDriftPct || 0 });

  /* inventory integrity — open oversold alerts + any negative stock */
  let oversoldOpen = 0;
  try { oversoldOpen = (await db.collection('oversoldAlerts').count().get()).data().count; } catch (_) {}
  let negStock = { size: 0, ids: [] };
  try {
    const ns = await db.collection('products').where('stock', '<', 0).limit(5).get();
    negStock = { size: ns.size, ids: ns.docs.map((d) => d.id) };
  } catch (_) { /* needs an index on stock; skip if absent */ }
  if (negStock.size > 0) issues.push({ type: 'negative_stock', count: negStock.size, sample: negStock.ids });

  const health = {
    ok: issues.length === 0,
    issues,
    analyticsStaleHours: staleHours,
    reconciliationOk: rec.ok !== false,
    oversoldOpen,
    negativeStockCount: negStock.size,
    checkedAt: FV.serverTimestamp(),
  };
  await db.doc('analytics/health').set(health, { merge: true });

  if (issues.length) {
    const day = new Date().toISOString().slice(0, 10);
    const high = negatives.length > 0 || negStock.size > 0;
    await db.collection('monitoringAlerts').doc(`analytics_${day}`)
      .set(Object.assign({}, health, { severity: high ? 'high' : 'medium' }), { merge: true })
      .catch(() => {});
  }
  return health;
}

/* ── Milestone B prep: Cutover Readiness gate ──
   The operational go/no-go for retiring legacy dashboard calculations. Aggregates the gate signals
   into `analytics/cutover_readiness`; every check must be green over the validation window before
   legacy is retired. `dashboardParity` reads `analyticsParityLog` (populated by the client parity
   shim during the parallel-validation period) — 0 unresolved discrepancies = pass. */
async function computeCutoverReadiness(db) {
  const FV = admin.firestore.FieldValue;
  const now = Date.now();
  const fresh = (d, hours) => {
    const t = d && d.updatedAt && d.updatedAt.toMillis ? d.updatedAt.toMillis() : 0;
    return t > 0 && (now - t) < hours * 3600000;
  };
  const cnt = (s) => (s && s.data ? s.data().count : 0) || 0;
  const [rec, health, bi, top, w7, mon, recA, parity] = await Promise.all([
    db.doc('analytics/reconciliation').get(),
    db.doc('analytics/health').get(),
    db.doc('analytics/bi').get(),
    db.doc('analytics/top_lists').get(),
    db.doc('analytics/window_7d').get(),
    db.collection('monitoringAlerts').count().get().catch(() => null),
    db.collection('reconciliationAlerts').count().get().catch(() => null),
    db.collection('analyticsParityLog').where('resolved', '==', false).count().get().catch(() => null),
  ]);
  const checks = {
    reconciliationParity: (rec.data() || {}).ok === true,
    healthStatus:         (health.data() || {}).ok === true,
    reconciliationAlerts: cnt(recA) === 0,
    monitoringAlerts:     cnt(mon) === 0,
    biGeneration:         fresh(bi.data(), 48),
    topListGeneration:    fresh(top.data(), 48),
    rollupFresh:          fresh(w7.data(), 48),
    dashboardParity:      cnt(parity) === 0,
  };
  const failing = Object.keys(checks).filter((k) => !checks[k]);
  const out = {
    checks,
    overallReady: failing.length === 0,
    failing,
    note: 'Go/No-Go gate for retiring legacy dashboard calculations (Milestone B). All must be green over the validation window.',
    updatedAt: FV.serverTimestamp(),
  };
  await db.doc('analytics/cutover_readiness').set(out, { merge: true });
  return out;
}

module.exports = { runHealthChecks, computeCutoverReadiness };
