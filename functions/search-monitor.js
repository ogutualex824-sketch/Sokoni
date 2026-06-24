/**
 * SOKONI Search Monitor — Unified Health Dashboard
 *
 * Aggregates health data from both Algolia and Typesense engine monitors into a
 * single source of truth for operators. Engine monitors (algolia-monitor.js,
 * typesense-monitor.js) write their data to Firestore; this module reads those
 * documents directly — it never invokes other Cloud Functions.
 *
 * Exports:
 *
 *  searchGetUnifiedDashboard  — onCall (admin)
 *    Returns the combined dashboard: engine health, queue depths, system status,
 *    uptime estimates, and unresolved search alerts.
 *
 *  searchSystemHealth  — onSchedule every 15 minutes
 *    Reads both engine monitor docs, determines overall status, writes a time-series
 *    snapshot to `searchHealthHistory`, updates `searchConfig/systemHealth`, and
 *    creates an admin alert if status is degraded or critical.
 *
 *  searchGetHealthHistory  — onCall (admin)
 *    Returns up to 30 days of health snapshots from `searchHealthHistory`.
 *
 *  searchResolveAlert  — onCall (admin)
 *    Marks a single `adminAlerts` document (category == 'search') as resolved.
 *
 * Firestore documents read:
 *   platformMetrics/algoliaMonitor   — written by algolia-monitor.js
 *   platformMetrics/typesenseMonitor — written by typesense-monitor.js
 *   searchConfig/systemHealth        — current system health (written by this module)
 *   searchHealthHistory              — time-series collection (written by this module)
 *   adminAlerts                      — search alerts (written by engine monitors)
 *   algoliaQueue / typesenseQueue    — queue depth counts
 *   algoliaQueueDLQ / typesenseQueueDLQ — DLQ depth counts
 */

'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule }         = require('firebase-functions/v2/scheduler');
const { defineSecret }       = require('firebase-functions/params');
const admin                  = require('firebase-admin');
const logger                 = require('firebase-functions/logger');

if (!admin.apps.length) admin.initializeApp();

/* ── Secrets ──────────────────────────────────────────────────────────────── */

const ALGOLIA_ADMIN_KEY   = defineSecret('ALGOLIA_ADMIN_KEY');
const TYPESENSE_ADMIN_KEY = defineSecret('TYPESENSE_ADMIN_KEY');

/* ── Constants ────────────────────────────────────────────────────────────── */

const ALGOLIA_MONITOR_DOC   = 'platformMetrics/algoliaMonitor';
const TYPESENSE_MONITOR_DOC = 'platformMetrics/typesenseMonitor';
const SYSTEM_HEALTH_DOC     = 'searchConfig/systemHealth';
const HEALTH_HISTORY_COL    = 'searchHealthHistory';
const ALERTS_COL            = 'adminAlerts';

const ALGOLIA_QUEUE_COL     = 'algoliaQueue';
const ALGOLIA_DLQ_COL       = 'algoliaQueueDLQ';
const TYPESENSE_QUEUE_COL   = 'typesenseQueue';
const TYPESENSE_DLQ_COL     = 'typesenseQueueDLQ';

/** How far back searchGetHealthHistory looks */
const HISTORY_DAYS = 30;

/** Limit on unresolved alerts returned in dashboard */
const ACTIVE_ALERTS_LIMIT = 20;

/* ── Helpers ──────────────────────────────────────────────────────────────── */

function _db()  { return admin.firestore(); }
function _now() { return admin.firestore.FieldValue.serverTimestamp(); }

function _assertAdmin(req) {
  if (!req.auth?.token?.admin) {
    throw new HttpsError('permission-denied', 'Admin required');
  }
}

/**
 * Count queue documents by status without reading their payloads.
 *
 * @param {string} col
 * @param {string} status
 * @returns {Promise<number>}
 */
async function _countByStatus(col, status) {
  try {
    const snap = await _db().collection(col).where('status', '==', status).count().get();
    return snap.data().count;
  } catch (_) {
    return -1;
  }
}

/**
 * Read queue stats for one engine (pending, processing, failed, dlq).
 *
 * @param {string} queueCol
 * @param {string} dlqCol
 * @returns {Promise<{pending, processing, failed, dlq}>}
 */
async function _queueStats(queueCol, dlqCol) {
  const [pending, processing, failed, dlq] = await Promise.all([
    _countByStatus(queueCol, 'pending'),
    _countByStatus(queueCol, 'processing'),
    _countByStatus(queueCol, 'failed'),
    _countByStatus(dlqCol,   'dlq'),
  ]);
  return { pending, processing, failed, dlq };
}

/**
 * Determine overall system status from two engine statuses.
 * 'healthy'  — both engines ok
 * 'degraded' — one engine has issues (non-ok status or missing data)
 * 'critical' — both engines down
 *
 * Engine status is read from the `status` field of each monitor document.
 * If the field is absent or the document is missing, that engine is treated as down.
 *
 * @param {string|null} algoliaStatus
 * @param {string|null} typesenseStatus
 * @returns {'healthy'|'degraded'|'critical'}
 */
function _overallStatus(algoliaStatus, typesenseStatus) {
  const aOk = algoliaStatus   === 'ok' || algoliaStatus   === 'healthy';
  const tOk = typesenseStatus === 'ok' || typesenseStatus === 'healthy';

  if (aOk && tOk)  return 'healthy';
  if (!aOk && !tOk) return 'critical';
  return 'degraded';
}

/**
 * Naively estimate uptime percentage from recent health history.
 * Falls back to '–' if insufficient data.
 *
 * @param {string} engine   - 'algolia' or 'typesense'
 * @param {FirebaseFirestore.QuerySnapshot} historySnap
 * @returns {string}
 */
function _estimateUptime(engine, historySnap) {
  if (historySnap.empty) return '–';
  let total = 0;
  let up    = 0;
  historySnap.forEach((doc) => {
    const d = doc.data();
    total++;
    const status = engine === 'algolia' ? d.algoliaStatus : d.typesenseStatus;
    if (status === 'ok' || status === 'healthy') up++;
  });
  if (total === 0) return '–';
  return `${((up / total) * 100).toFixed(1)}%`;
}

/* ── CF 1: searchGetUnifiedDashboard ─────────────────────────────────────── */

exports.searchGetUnifiedDashboard = onCall(
  {
    region:         'us-central1',
    memory:         '512MiB',
    timeoutSeconds: 30,
    secrets:        [ALGOLIA_ADMIN_KEY, TYPESENSE_ADMIN_KEY],
  },
  async (req) => {
    _assertAdmin(req);

    const db = _db();
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 2); // 48h history for uptime estimate

    /* ── Parallel reads ─────────────────────────────────────────────────── */
    const [
      algoliaMonitorSnap,
      typesenseMonitorSnap,
      algoliaQueueStats,
      typesenseQueueStats,
      activeAlertsSnap,
      systemHealthSnap,
      recentHistorySnap,
      lastSyncSnap,
    ] = await Promise.all([
      db.doc(ALGOLIA_MONITOR_DOC).get(),
      db.doc(TYPESENSE_MONITOR_DOC).get(),
      _queueStats(ALGOLIA_QUEUE_COL,   ALGOLIA_DLQ_COL),
      _queueStats(TYPESENSE_QUEUE_COL, TYPESENSE_DLQ_COL),
      db.collection(ALERTS_COL)
        .where('category', '==', 'search')
        .where('resolved', '==', false)
        .orderBy('createdAt', 'desc')
        .limit(ACTIVE_ALERTS_LIMIT)
        .get(),
      db.doc(SYSTEM_HEALTH_DOC).get(),
      db.collection(HEALTH_HISTORY_COL)
        .where('recordedAt', '>=', cutoff)
        .orderBy('recordedAt', 'desc')
        .limit(200)
        .get(),
      db.doc('searchConfig/lastSync').get(),
    ]);

    /* ── Extract engine monitor data ────────────────────────────────────── */
    const algoliaData   = algoliaMonitorSnap.exists   ? algoliaMonitorSnap.data()   : {};
    const typesenseData = typesenseMonitorSnap.exists ? typesenseMonitorSnap.data() : {};

    const algoliaStatus   = algoliaData.status   || 'unknown';
    const typesenseStatus = typesenseData.status  || 'unknown';

    /* ── System-level aggregates ────────────────────────────────────────── */
    const systemHealth   = systemHealthSnap.exists ? systemHealthSnap.data() : {};
    const lastSyncData   = lastSyncSnap.exists     ? lastSyncSnap.data()     : {};

    const primaryEngine  = systemHealth.primaryEngine || 'algolia';
    const overallStatus  = _overallStatus(algoliaStatus, typesenseStatus);

    /* ── Uptime estimates from recent history ───────────────────────────── */
    const uptimeAlgolia   = _estimateUptime('algolia',   recentHistorySnap);
    const uptimeTypesense = _estimateUptime('typesense', recentHistorySnap);

    /* ── Count active syncs last 24h from history ───────────────────────── */
    const yesterday = new Date(Date.now() - 86_400_000);
    let activeSyncsLast24h = 0;
    recentHistorySnap.forEach((doc) => {
      const d = doc.data();
      const ts = d.recordedAt?.toDate ? d.recordedAt.toDate() : null;
      if (ts && ts >= yesterday && (d.algoliaStatus === 'ok' || d.typesenseStatus === 'ok')) {
        activeSyncsLast24h++;
      }
    });

    /* ── Build alerts array ─────────────────────────────────────────────── */
    const alerts = activeAlertsSnap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));

    /* ── Assemble dashboard ─────────────────────────────────────────────── */
    return {
      algolia:   algoliaData,
      typesense: typesenseData,
      queues: {
        algolia:   algoliaQueueStats,
        typesense: typesenseQueueStats,
      },
      system: {
        primaryEngine,
        overallStatus,
        uptime: {
          algolia:   uptimeAlgolia,
          typesense: uptimeTypesense,
        },
        lastSyncAt:         lastSyncData.updatedAt || null,
        activeSyncsLast24h,
      },
      alerts,
      generatedAt: new Date().toISOString(),
    };
  }
);

/* ── CF 2: searchSystemHealth ─────────────────────────────────────────────── */

exports.searchSystemHealth = onSchedule(
  {
    schedule:       'every 2 hours',
    region:         'us-central1',
    timeZone:       'Africa/Nairobi',
    memory:         '256MiB',
    timeoutSeconds: 60,
    secrets:        [ALGOLIA_ADMIN_KEY, TYPESENSE_ADMIN_KEY],
  },
  async () => {
    const db = _db();

    /* ── Read engine monitor documents ───────────────────────────────────── */
    const [algoliaSnap, typesenseSnap] = await Promise.all([
      db.doc(ALGOLIA_MONITOR_DOC).get(),
      db.doc(TYPESENSE_MONITOR_DOC).get(),
    ]);

    const algoliaData   = algoliaSnap.exists   ? algoliaSnap.data()   : {};
    const typesenseData = typesenseSnap.exists ? typesenseSnap.data() : {};

    const algoliaStatus   = algoliaData.status   || 'unknown';
    const typesenseStatus = typesenseData.status  || 'unknown';
    const overallStatus   = _overallStatus(algoliaStatus, typesenseStatus);

    /* ── Write time-series snapshot ───────────────────────────────────────── */
    const snapshot = {
      algoliaStatus,
      typesenseStatus,
      overallStatus,
      algoliaLatencyMs:   algoliaData.latencyMs   || null,
      typesenseLatencyMs: typesenseData.latencyMs || null,
      recordedAt:         _now(),
    };

    const snapshotRef = await db.collection(HEALTH_HISTORY_COL).add(snapshot);

    /* ── Overwrite current state document ────────────────────────────────── */
    await db.doc(SYSTEM_HEALTH_DOC).set({
      ...snapshot,
      latestSnapshotId: snapshotRef.id,
      updatedAt:        _now(),
    }, { merge: false });

    /* ── Alert on degraded or critical status ─────────────────────────────── */
    if (overallStatus === 'degraded' || overallStatus === 'critical') {
      await db.collection(ALERTS_COL).add({
        category:  'search',
        severity:  overallStatus === 'critical' ? 'critical' : 'warning',
        message:   `Search system health is ${overallStatus}. Algolia: ${algoliaStatus}, Typesense: ${typesenseStatus}`,
        meta: {
          algoliaStatus,
          typesenseStatus,
          snapshotId: snapshotRef.id,
        },
        resolved:  false,
        createdAt: _now(),
      });
    }

    logger.info('searchSystemHealth: snapshot written', {
      overallStatus,
      algoliaStatus,
      typesenseStatus,
      snapshotId: snapshotRef.id,
    });
  }
);

/* ── CF 3: searchGetHealthHistory ─────────────────────────────────────────── */

exports.searchGetHealthHistory = onCall(
  {
    region:         'us-central1',
    memory:         '256MiB',
    timeoutSeconds: 30,
    secrets:        [ALGOLIA_ADMIN_KEY, TYPESENSE_ADMIN_KEY],
  },
  async (req) => {
    _assertAdmin(req);

    const { days = HISTORY_DAYS } = req.data || {};
    const safeDays = Math.min(Math.max(1, days), HISTORY_DAYS);

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - safeDays);

    const snap = await _db()
      .collection(HEALTH_HISTORY_COL)
      .where('recordedAt', '>=', cutoff)
      .orderBy('recordedAt', 'desc')
      .limit(2000) // ~15-min intervals × 30 days = ~2880 max; 2000 is a safe cap
      .get();

    const history = snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));

    logger.info('searchGetHealthHistory: returned history', { count: history.length, days: safeDays });

    return { history, count: history.length, days: safeDays };
  }
);

/* ── CF 4: searchResolveAlert ─────────────────────────────────────────────── */

exports.searchResolveAlert = onCall(
  {
    region:         'us-central1',
    memory:         '256MiB',
    timeoutSeconds: 30,
    secrets:        [ALGOLIA_ADMIN_KEY, TYPESENSE_ADMIN_KEY],
  },
  async (req) => {
    const uid = req.auth?.uid;
    _assertAdmin(req);

    const { alertId } = req.data || {};
    if (!alertId || typeof alertId !== 'string') {
      throw new HttpsError('invalid-argument', 'alertId is required');
    }

    const alertRef = _db().collection(ALERTS_COL).doc(alertId);
    const alertSnap = await alertRef.get();

    if (!alertSnap.exists) {
      throw new HttpsError('not-found', `Alert ${alertId} not found`);
    }

    const alertData = alertSnap.data();
    if (alertData.category !== 'search') {
      throw new HttpsError('invalid-argument', 'This callable only resolves search alerts');
    }

    if (alertData.resolved) {
      return { success: true, message: 'Alert was already resolved' };
    }

    await alertRef.update({
      resolved:    true,
      resolvedAt:  _now(),
      resolvedBy:  uid || 'admin',
    });

    logger.info('searchResolveAlert: alert resolved', { alertId, resolvedBy: uid });

    return { success: true, alertId };
  }
);
