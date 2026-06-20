/**
 * SOKONI Typesense Monitor v1.0
 *
 * Cluster health monitoring, latency tracking, SLA alerting, slow query detection.
 *
 *  typesenseMonitorHealth     — scheduled every 5 min: node ping, alert on failure
 *  typesenseMonitorLatency    — scheduled every 15 min: p50/p95/p99 latency probe
 *  typesenseGetDashboard      — admin callable: returns aggregated health + SLA data
 *  typesenseMonitorCleanup    — weekly: purge old metric records
 *
 * SLA targets:
 *  - Search latency p99 < 150ms
 *  - Cluster availability > 99.9%
 *  - Queue depth < 10 000 pending
 *  - DLQ depth < 50 failed
 *
 * Alerts are written to:
 *  - Firestore `adminAlerts` collection (for admin dashboard)
 *  - Firestore `tsHealthLog` collection (time-series for SLA reporting)
 */

'use strict';

const { onSchedule }               = require('firebase-functions/v2/scheduler');
const { onCall, HttpsError }       = require('firebase-functions/v2/https');
const { defineSecret }             = require('firebase-functions/params');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const {
  TypesenseClient,
  COLLECTION_SCHEMAS,
  _sleep,
} = require('./typesense-client');

const TYPESENSE_ADMIN_KEY = defineSecret('TYPESENSE_ADMIN_KEY');
const TYPESENSE_NODES_VAR = process.env.TYPESENSE_NODES || '';

const HEALTH_LOG_COL   = 'tsHealthLog';
const LATENCY_LOG_COL  = 'tsLatencyLog';
const ALERT_COL        = 'adminAlerts';

/* SLA thresholds */
const SLA = {
  latencyP99Ms:   150,   /* p99 search must complete within 150ms */
  queueMaxDepth:  10_000,
  dlqMaxDepth:    50,
};

function _makeClient(adminKey) {
  const nodes = TYPESENSE_NODES_VAR
    ? TYPESENSE_NODES_VAR.split(',').map(s => s.trim()).filter(Boolean)
    : ['localhost:8108:http'];
  return new TypesenseClient(nodes, adminKey, {
    timeoutMs:   5_000,
    maxRetries:  1,
    cbThreshold: 2,
  });
}

/* ── Alert writer ───────────────────────────────────────────────── */

async function _alert(db, { type, severity, message, metadata = {} }) {
  await db.collection(ALERT_COL).add({
    type,
    severity,
    message,
    ...metadata,
    createdAt: FieldValue.serverTimestamp(),
    resolved:  false,
  });
}

/* ── Percentile helper ──────────────────────────────────────────── */

function _percentile(sortedArr, p) {
  if (!sortedArr.length) return 0;
  const idx = Math.ceil((p / 100) * sortedArr.length) - 1;
  return sortedArr[Math.max(0, idx)];
}

/* ═══════════════════════════════════════════════════════════════════
   HEALTH CHECK — Every 5 minutes
   Pings each node, checks cluster state, records uptime metrics.
════════════════════════════════════════════════════════════════════ */

exports.typesenseMonitorHealth = onSchedule(
  {
    schedule:       'every 5 minutes',
    timeoutSeconds: 60,
    memory:         '256MiB',
    secrets:        [TYPESENSE_ADMIN_KEY],
  },
  async () => {
    const adminKey = TYPESENSE_ADMIN_KEY.value();
    if (!adminKey || adminKey === 'not_configured') return;

    const ts  = _makeClient(adminKey);
    const db  = getFirestore();
    const now = Date.now();

    const nodeResults = await ts.nodeStatuses();
    const healthyCount = nodeResults.filter(n => n.status === 'healthy').length;
    const totalCount   = nodeResults.length;
    const allHealthy   = healthyCount === totalCount;
    const majorityOk   = healthyCount > totalCount / 2;

    /* Write health snapshot */
    await db.collection(HEALTH_LOG_COL).add({
      nodes:        nodeResults,
      healthyCount,
      totalCount,
      allHealthy,
      timestamp:    now,
    });

    /* Alert conditions */
    if (!majorityOk) {
      await _alert(db, {
        type:     'typesense_cluster_down',
        severity: 'critical',
        message:  `Typesense cluster CRITICAL: only ${healthyCount}/${totalCount} nodes healthy`,
        metadata: { healthyCount, totalCount, nodes: nodeResults },
      });
    } else if (!allHealthy) {
      await _alert(db, {
        type:     'typesense_node_down',
        severity: 'warning',
        message:  `Typesense node degraded: ${healthyCount}/${totalCount} healthy`,
        metadata: { healthyCount, totalCount, nodes: nodeResults },
      });
    }

    /* Check queue depth */
    const [queueSnap, dlqSnap] = await Promise.allSettled([
      db.collection('typesenseQueue').where('status', '==', 'pending').count().get(),
      db.collection('typesenseQueueDLQ').where('status', '==', 'failed').count().get(),
    ]);

    const queueDepth = queueSnap.status  === 'fulfilled' ? queueSnap.value.data().count  : 0;
    const dlqDepth   = dlqSnap.status    === 'fulfilled' ? dlqSnap.value.data().count     : 0;

    if (queueDepth > SLA.queueMaxDepth) {
      await _alert(db, {
        type:     'typesense_queue_deep',
        severity: queueDepth > SLA.queueMaxDepth * 2 ? 'critical' : 'warning',
        message:  `Typesense queue depth: ${queueDepth} (SLA: ${SLA.queueMaxDepth})`,
        metadata: { queueDepth },
      });
    }

    if (dlqDepth > SLA.dlqMaxDepth) {
      await _alert(db, {
        type:     'typesense_dlq_high',
        severity: 'warning',
        message:  `Typesense DLQ: ${dlqDepth} failed items`,
        metadata: { dlqDepth },
      });
    }

    /* Update live status doc for dashboard */
    await db.doc('tsMonitor/status').set({
      healthy:      allHealthy,
      healthyNodes: healthyCount,
      totalNodes:   totalCount,
      queueDepth,
      dlqDepth,
      updatedAt:    now,
    });
  }
);

/* ═══════════════════════════════════════════════════════════════════
   LATENCY PROBE — Every 15 minutes
   Runs a real search against each collection category and records latency.
   Alerts if p99 exceeds SLA target.
════════════════════════════════════════════════════════════════════ */

exports.typesenseMonitorLatency = onSchedule(
  {
    schedule:       'every 15 minutes',
    timeoutSeconds: 120,
    memory:         '256MiB',
    secrets:        [TYPESENSE_ADMIN_KEY],
  },
  async () => {
    const adminKey = TYPESENSE_ADMIN_KEY.value();
    if (!adminKey || adminKey === 'not_configured') return;

    const ts  = _makeClient(adminKey);
    const db  = getFirestore();
    const now = Date.now();

    /* Probe queries — representative of real user searches */
    const probes = [
      { collection: 'sokoni_products',  q: 'phone',   query_by: 'name,category' },
      { collection: 'sokoni_shops',     q: 'shop',    query_by: 'name' },
      { collection: 'sokoni_services',  q: 'service', query_by: 'name,category' },
      { collection: 'sokoni_events',    q: 'event',   query_by: 'title,category' },
      { collection: 'sokoni_jobs',      q: 'software',query_by: 'title,skills' },
      { collection: 'sokoni_hotels',    q: 'hotel',   query_by: 'name' },
      { collection: 'sokoni_education', q: 'course',  query_by: 'title,subject' },
    ];

    const latencies = [];

    for (const probe of probes) {
      const t0 = Date.now();
      try {
        await ts.search(probe.collection, {
          q:              probe.q,
          query_by:       probe.query_by,
          per_page:       10,
          search_cutoff_ms: 200,
        });
        const elapsed = Date.now() - t0;
        latencies.push({ ...probe, latencyMs: elapsed, ok: true });
      } catch (err) {
        latencies.push({ ...probe, latencyMs: Date.now() - t0, ok: false, error: err.message });
      }
      await _sleep(200); /* avoid spamming the cluster */
    }

    const successLatencies = latencies.filter(l => l.ok).map(l => l.latencyMs).sort((a, b) => a - b);
    const p50  = _percentile(successLatencies, 50);
    const p95  = _percentile(successLatencies, 95);
    const p99  = _percentile(successLatencies, 99);
    const pMax = successLatencies[successLatencies.length - 1] || 0;

    await db.collection(LATENCY_LOG_COL).add({
      probes,
      p50, p95, p99,
      maxLatency:  pMax,
      sampleCount: successLatencies.length,
      timestamp:   now,
    });

    if (p99 > SLA.latencyP99Ms) {
      await _alert(db, {
        type:     'typesense_latency_sla_breach',
        severity: p99 > SLA.latencyP99Ms * 2 ? 'critical' : 'warning',
        message:  `Search latency SLA breach: p99=${p99}ms (target: <${SLA.latencyP99Ms}ms)`,
        metadata: { p50, p95, p99, maxLatency: pMax },
      });
    }

    await db.doc('tsMonitor/latency').set({ p50, p95, p99, maxLatency: pMax, updatedAt: now });

    console.log(`[TS Monitor] Latency p50=${p50}ms p95=${p95}ms p99=${p99}ms`);
  }
);

/* ═══════════════════════════════════════════════════════════════════
   DASHBOARD — Admin callable
   Returns aggregated health, SLA, latency, and queue data for admin panel.
════════════════════════════════════════════════════════════════════ */

exports.typesenseGetDashboard = onCall(
  {
    secrets:        [TYPESENSE_ADMIN_KEY],
    timeoutSeconds: 30,
    memory:         '256MiB',
  },
  async ({ auth }) => {
    if (!auth?.token?.admin) throw new HttpsError('permission-denied', 'Admin only');
    const db = getFirestore();

    const [
      statusDoc,
      latencyDoc,
      recentAlerts,
      latencyHistory,
      healthHistory,
      queueStats,
    ] = await Promise.allSettled([
      db.doc('tsMonitor/status').get(),
      db.doc('tsMonitor/latency').get(),
      db.collection(ALERT_COL)
        .where('resolved', '==', false)
        .orderBy('createdAt', 'desc')
        .limit(20).get(),
      db.collection(LATENCY_LOG_COL)
        .orderBy('timestamp', 'desc').limit(24).get(),
      db.collection(HEALTH_LOG_COL)
        .orderBy('timestamp', 'desc').limit(24).get(),
      db.doc('tsQueueStats/latest').get(),
    ]);

    return {
      currentStatus:  statusDoc.status  === 'fulfilled' ? statusDoc.value.data()  : null,
      currentLatency: latencyDoc.status === 'fulfilled' ? latencyDoc.value.data() : null,
      queueStats:     queueStats.status === 'fulfilled' ? queueStats.value.data() : null,
      activeAlerts:   recentAlerts.status === 'fulfilled'
        ? recentAlerts.value.docs.map(d => ({ id: d.id, ...d.data() }))
        : [],
      latencyHistory: latencyHistory.status === 'fulfilled'
        ? latencyHistory.value.docs.map(d => d.data())
        : [],
      healthHistory:  healthHistory.status === 'fulfilled'
        ? healthHistory.value.docs.map(d => d.data())
        : [],
      slaTargets:     SLA,
    };
  }
);

/* ═══════════════════════════════════════════════════════════════════
   RESOLVE ALERT — Admin callable
════════════════════════════════════════════════════════════════════ */

exports.typesenseResolveAlert = onCall(
  {
    timeoutSeconds: 15,
    memory:         '128MiB',
  },
  async ({ auth, data: callData = {} }) => {
    if (!auth?.token?.admin) throw new HttpsError('permission-denied', 'Admin only');
    const { alertId } = callData;
    if (!alertId) throw new HttpsError('invalid-argument', 'alertId required');
    const db = getFirestore();
    await db.collection(ALERT_COL).doc(alertId).update({
      resolved:    true,
      resolvedAt:  FieldValue.serverTimestamp(),
      resolvedBy:  auth.uid,
    });
    return { resolved: true };
  }
);

/* ═══════════════════════════════════════════════════════════════════
   MONITOR CLEANUP — Weekly Sunday 05:00
   Purge old health logs, latency logs, resolved alerts older than 30 days.
════════════════════════════════════════════════════════════════════ */

exports.typesenseMonitorCleanup = onSchedule(
  {
    schedule:       'every sunday 05:00',
    timeoutSeconds: 120,
    memory:         '256MiB',
  },
  async () => {
    const db       = getFirestore();
    const cutoff30 = Date.now() - 30 * 86_400_000;
    const cutoff7  = Date.now() -  7 * 86_400_000;

    const collections = [
      { col: HEALTH_LOG_COL,  field: 'timestamp',  cutoff: cutoff7 },
      { col: LATENCY_LOG_COL, field: 'timestamp',  cutoff: cutoff30 },
    ];

    let totalDeleted = 0;
    for (const { col, field, cutoff } of collections) {
      const snap = await db.collection(col)
        .where(field, '<', cutoff).limit(1000).get();
      if (!snap.empty) {
        const { _chunk: chunk } = require('./typesense-client');
        for (const c of chunk(snap.docs, 500)) {
          const batch = db.batch();
          c.forEach(d => batch.delete(d.ref));
          await batch.commit();
          totalDeleted += c.length;
        }
      }
    }

    /* Resolved alerts older than 30 days */
    const alertSnap = await db.collection(ALERT_COL)
      .where('resolved', '==', true)
      .where('resolvedAt', '<', new Date(cutoff30))
      .limit(500).get();

    if (!alertSnap.empty) {
      const batch = db.batch();
      alertSnap.docs.forEach(d => batch.delete(d.ref));
      await batch.commit();
      totalDeleted += alertSnap.size;
    }

    console.log(`[TS Monitor Cleanup] Deleted ${totalDeleted} records`);
  }
);
