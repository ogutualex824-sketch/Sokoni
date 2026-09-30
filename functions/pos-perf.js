'use strict';

/**
 * SmartPOS 4.0 — Performance Monitoring & Benchmarking
 * Records POS operation events and produces speed/benchmark reports.
 */

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const admin = require('firebase-admin');

if (!admin.apps.length) admin.initializeApp();

function db() { return admin.firestore(); }

const REGION = 'us-central1';

/* ── Speed targets (SmartPOS 4.0 spec) ── */
const TARGETS_MS = {
  new_sale_complete:    10000,
  barcode_scan:           100,
  receipt_print:         2000,
  mpesa_stk_push:        5000,
  payment_confirmation:  8000,
  product_search:         500,
  customer_lookup:        300,
  loyalty_award:          500,
  refund_complete:       5000,
  report_load:           3000,
  dashboard_load:        2000,
};

const EVENT_TYPES = Object.keys(TARGETS_MS);

/* ──────────────────────────────────────────────────────
   recordPosEvent
   Called from the POS frontend to record a timed operation.
   Input: { eventType, durationMs, metadata? }
─────────────────────────────────────────────────────── */
exports.recordPosEvent = onCall({ region: REGION }, async (req) => {
  const { eventType, durationMs, metadata = {} } = req.data;
  const sellerId = req.auth?.uid;
  if (!sellerId) throw new HttpsError('unauthenticated', 'Authentication required');

  if (!EVENT_TYPES.includes(eventType))
    throw new HttpsError('invalid-argument', `Unknown event type: ${eventType}`);
  if (typeof durationMs !== 'number' || durationMs < 0 || durationMs > 300000)
    throw new HttpsError('invalid-argument', 'durationMs must be 0–300000');

  const target = TARGETS_MS[eventType];
  const passed = durationMs <= target;
  const ratio  = durationMs / target;

  const event = {
    sellerId,
    eventType,
    durationMs,
    targetMs: target,
    passed,
    ratio: Math.round(ratio * 100) / 100,
    day: new Date().toISOString().slice(0, 10),
    ts: admin.firestore.FieldValue.serverTimestamp(),
    metadata: _sanitiseMeta(metadata),
  };

  /* Write event */
  await db().collection('posPerfEvents').add(event);

  /* Update daily rollup (atomic) */
  const rollupRef = db().collection('posPerfRollup').doc(`${sellerId}_${event.day}_${eventType}`);
  await rollupRef.set({
    sellerId, eventType, day: event.day,
    count: admin.firestore.FieldValue.increment(1),
    passCount: admin.firestore.FieldValue.increment(passed ? 1 : 0),
    failCount: admin.firestore.FieldValue.increment(passed ? 0 : 1),
    totalMs:   admin.firestore.FieldValue.increment(durationMs),
    targetMs:  target,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });

  /* Update min/max inside a transaction to avoid race conditions */
  await db().runTransaction(async tx => {
    const doc = await tx.get(rollupRef);
    const cur = doc.data() || {};
    const updates = {};
    if (cur.minMs === undefined || durationMs < cur.minMs) updates.minMs = durationMs;
    if (cur.maxMs === undefined || durationMs > cur.maxMs) updates.maxMs = durationMs;
    if (Object.keys(updates).length) tx.update(rollupRef, updates);
  });

  return { recorded: true, passed, durationMs, targetMs: target, ratio };
});


/* ──────────────────────────────────────────────────────
   getPosPerfMetrics
   Returns aggregated performance metrics for a seller.
   Input: { days? (default 7), eventType? }
─────────────────────────────────────────────────────── */
exports.getPosPerfMetrics = onCall({ region: REGION }, async (req) => {
  const { days = 7, eventType } = req.data || {};
  const sellerId = req.auth?.uid;
  if (!sellerId) throw new HttpsError('unauthenticated', 'Authentication required');
  if (days < 1 || days > 90) throw new HttpsError('invalid-argument', 'days must be 1–90');

  const since = new Date();
  since.setDate(since.getDate() - days);
  const sinceDay = since.toISOString().slice(0, 10);

  let q = db().collection('posPerfRollup')
    .where('sellerId', '==', sellerId)
    .where('day', '>=', sinceDay)
    .orderBy('day', 'desc')
    .limit(500);

  if (eventType) q = q.where('eventType', '==', eventType);

  const snap = await q.get();
  const rows = snap.docs.map(d => d.data());

  /* Aggregate by event type */
  const byType = {};
  for (const r of rows) {
    if (!byType[r.eventType]) {
      byType[r.eventType] = {
        eventType: r.eventType, targetMs: r.targetMs,
        totalCount: 0, passCount: 0, failCount: 0,
        totalMs: 0, minMs: Infinity, maxMs: 0,
      };
    }
    const agg = byType[r.eventType];
    agg.totalCount += r.count || 0;
    agg.passCount  += r.passCount || 0;
    agg.failCount  += r.failCount || 0;
    agg.totalMs    += r.totalMs || 0;
    if (r.minMs && r.minMs < agg.minMs) agg.minMs = r.minMs;
    if (r.maxMs && r.maxMs > agg.maxMs) agg.maxMs = r.maxMs;
  }

  const metrics = Object.values(byType).map(a => ({
    eventType:   a.eventType,
    targetMs:    a.targetMs,
    totalCount:  a.totalCount,
    passRate:    a.totalCount > 0 ? Math.round((a.passCount / a.totalCount) * 1000) / 10 : null,
    avgMs:       a.totalCount > 0 ? Math.round(a.totalMs / a.totalCount) : null,
    minMs:       a.minMs === Infinity ? null : a.minMs,
    maxMs:       a.maxMs || null,
    status:      _status(a.totalCount > 0 ? a.passCount / a.totalCount : 1),
  }));

  /* Overall score */
  const overall = _overallScore(metrics);

  return { days, metrics, overall, generatedAt: new Date().toISOString() };
});


/* ──────────────────────────────────────────────────────
   getPosSpeedReport
   Full benchmark report — all targets, pass/fail, percentile band.
   Input: { day? (default today) }
─────────────────────────────────────────────────────── */
exports.getPosSpeedReport = onCall({ region: REGION }, async (req) => {
  const { day = new Date().toISOString().slice(0, 10) } = req.data || {};
  const sellerId = req.auth?.uid;
  if (!sellerId) throw new HttpsError('unauthenticated', 'Authentication required');

  /* Fetch today's rollup */
  const snap = await db().collection('posPerfRollup')
    .where('sellerId', '==', sellerId)
    .where('day', '==', day)
    .get();

  const rollupMap = {};
  snap.docs.forEach(d => { rollupMap[d.data().eventType] = d.data(); });

  /* Build report for every defined event type */
  const report = EVENT_TYPES.map(et => {
    const r   = rollupMap[et];
    const tgt = TARGETS_MS[et];
    if (!r || r.count === 0) {
      return { eventType: et, targetMs: tgt, count: 0, status: 'no_data', passRate: null, avgMs: null };
    }
    const passRate = Math.round((r.passCount / r.count) * 1000) / 10;
    const avgMs    = r.count > 0 ? Math.round(r.totalMs / r.count) : null;
    return {
      eventType: et,
      targetMs:  tgt,
      count:     r.count,
      passCount: r.passCount,
      failCount: r.failCount,
      passRate,
      avgMs,
      minMs:     r.minMs || null,
      maxMs:     r.maxMs || null,
      status:    _status(r.passCount / r.count),
      grade:     _grade(passRate),
    };
  });

  const scored   = report.filter(r => r.passRate !== null);
  const avgScore = scored.length
    ? Math.round(scored.reduce((s, r) => s + r.passRate, 0) / scored.length)
    : null;

  return {
    day,
    sellerId,
    report,
    summary: {
      totalEventTypes: EVENT_TYPES.length,
      typesWithData:   scored.length,
      overallPassRate: avgScore,
      grade:           avgScore !== null ? _grade(avgScore) : 'N/A',
      targets:         TARGETS_MS,
    },
    generatedAt: new Date().toISOString(),
  };
});


/* ──────────────────────────────────────────────────────
   posScheduledPerfRollup
   Nightly aggregation at 01:00 EAT — keeps monthly roll-ups.
─────────────────────────────────────────────────────── */
exports.posScheduledPerfRollup = onSchedule(
  { region: REGION, schedule: '0 22 * * *', timeZone: 'UTC' },
  async () => {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const day    = yesterday.toISOString().slice(0, 10);
    const month  = day.slice(0, 7);

    const snap = await db().collection('posPerfRollup')
      .where('day', '==', day)
      .get();

    if (snap.empty) return;

    /* Group by seller + eventType */
    const monthly = {};
    snap.docs.forEach(doc => {
      const d   = doc.data();
      const key = `${d.sellerId}_${month}_${d.eventType}`;
      if (!monthly[key]) {
        monthly[key] = { sellerId: d.sellerId, month, eventType: d.eventType, targetMs: d.targetMs, count: 0, passCount: 0, failCount: 0, totalMs: 0, minMs: Infinity, maxMs: 0 };
      }
      const m = monthly[key];
      m.count     += d.count || 0;
      m.passCount += d.passCount || 0;
      m.failCount += d.failCount || 0;
      m.totalMs   += d.totalMs || 0;
      if (d.minMs && d.minMs < m.minMs) m.minMs = d.minMs;
      if (d.maxMs && d.maxMs > m.maxMs) m.maxMs = d.maxMs;
    });

    const batch = db().batch();
    Object.entries(monthly).forEach(([key, m]) => {
      if (m.minMs === Infinity) m.minMs = null;
      batch.set(db().collection('posPerfMonthly').doc(key), {
        ...m,
        passRate: m.count > 0 ? Math.round((m.passCount / m.count) * 1000) / 10 : null,
        avgMs:    m.count > 0 ? Math.round(m.totalMs / m.count) : null,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
    });
    await batch.commit();
  }
);


/* ── Helpers ── */
function _status(passRatio) {
  if (passRatio >= 0.97) return 'excellent';
  if (passRatio >= 0.90) return 'good';
  if (passRatio >= 0.75) return 'warning';
  return 'critical';
}

function _grade(pct) {
  if (pct >= 97) return 'A+';
  if (pct >= 93) return 'A';
  if (pct >= 90) return 'B+';
  if (pct >= 85) return 'B';
  if (pct >= 75) return 'C';
  return 'F';
}

function _overallScore(metrics) {
  const scored = metrics.filter(m => m.passRate !== null);
  if (!scored.length) return null;
  const avg = scored.reduce((s, m) => s + m.passRate, 0) / scored.length;
  return { passRate: Math.round(avg * 10) / 10, grade: _grade(avg) };
}

function _sanitiseMeta(meta) {
  if (!meta || typeof meta !== 'object') return {};
  const safe = {};
  const allowed = ['branch', 'deviceId', 'cashierId', 'productCount', 'paymentMethod', 'errorCode'];
  for (const k of allowed) {
    if (meta[k] !== undefined) safe[k] = String(meta[k]).slice(0, 128);
  }
  return safe;
}
