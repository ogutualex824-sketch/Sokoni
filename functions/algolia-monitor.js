/**
 * SOKONI Algolia Search Monitor
 *
 * Two scheduled probes:
 *
 * 1. algoliaMonitorHealth  — every 15 minutes
 *    • Fires a canary search (query: "test") against all 12 primary indexes
 *    • Records latency per index
 *    • Alerts if any index responds in > 500ms or returns an error
 *    • Tracks P50 / P95 latency per index over time
 *
 * 2. algoliaMonitorEntries  — daily at 04:00
 *    • Records entry counts for all primary indexes
 *    • Detects sudden drops (> 10% decrease day-over-day) — sign of accidental mass deletion
 *    • Tracks build times — sustained high build times indicate high ingest volume
 *
 * Callables (admin only):
 *   algoliaGetMonitorDashboard  — returns latest health + trend data for admin UI
 *   algoliaGetLatencyHistory    — returns per-index latency history (last 7 days)
 *   algoliaResolveMonitorAlert  — mark an alert as resolved
 */

'use strict';

const { onSchedule }         = require('firebase-functions/v2/scheduler');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret }       = require('firebase-functions/params');
const admin                  = require('firebase-admin');

const { AlgoliaClient } = require('./algolia-indexer');

const ALGOLIA_ADMIN_KEY = defineSecret('ALGOLIA_ADMIN_KEY');

/* ── Constants ───────────────────────────────────────────────────────────── */

const PRIMARY_INDEXES = [
  'sokoni_products', 'sokoni_shops', 'sokoni_services', 'sokoni_events',
  'sokoni_properties', 'sokoni_vehicles', 'sokoni_jobs', 'sokoni_users',
  'sokoni_categories', 'sokoni_brands', 'sokoni_collections', 'sokoni_coupons',
];

const LATENCY_WARNING_MS  = 300;  // warn if any index takes > 300ms
const LATENCY_CRITICAL_MS = 500;  // alert if any index takes > 500ms
const ENTRY_DROP_THRESHOLD = 0.10; // alert on > 10% entry count drop day-over-day

/* ── Helpers ─────────────────────────────────────────────────────────────── */

function _client() {
  const appId = process.env.ALGOLIA_APP_ID;
  const key   = ALGOLIA_ADMIN_KEY.value();
  if (!appId || !key || key === 'not_configured') return null;
  return new AlgoliaClient(appId, key);
}

function _db()  { return admin.firestore(); }
function _now() { return admin.firestore.FieldValue.serverTimestamp(); }

function _assertAdmin(request) {
  if (!request.auth?.token?.admin) throw new HttpsError('permission-denied', 'Admin only.');
}

function _percentile(arr, p) {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx    = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

/**
 * Fire a minimal search probe against one index and return latency in ms.
 * Returns { latencyMs, ok, error }.
 */
async function _probeIndex(algolia, indexName) {
  const t0 = Date.now();
  try {
    await algolia.search(indexName, {
      query:                'sokoni',
      hitsPerPage:          1,
      analytics:            false,
      clickAnalytics:       false,
      enablePersonalization: false,
      attributesToRetrieve: ['objectID'],
      responseFields:       ['hits', 'nbHits'],
    });
    return { latencyMs: Date.now() - t0, ok: true };
  } catch (err) {
    return { latencyMs: Date.now() - t0, ok: false, error: err.message };
  }
}

/* ══════════════════════════════════════════════════════════════════════
   algoliaMonitorHealth  — scheduled every 2 hours
══════════════════════════════════════════════════════════════════════ */

const algoliaMonitorHealth = onSchedule(
  {
    schedule:       'every 2 hours',
    timeoutSeconds: 120,
    memory:         '256MiB',
    secrets:        [ALGOLIA_ADMIN_KEY],
  },
  async () => {
    const algolia = _client();
    if (!algolia) return;

    const db    = _db();
    const runAt = new Date().toISOString();
    const t0    = Date.now();

    /* Probe all primary indexes in parallel */
    const probeResults = await Promise.allSettled(
      PRIMARY_INDEXES.map(async name => {
        const res = await _probeIndex(algolia, name);
        return { name, ...res };
      })
    );

    const results  = {};
    const warnings = [];
    const errors   = [];

    probeResults.forEach(r => {
      if (r.status === 'rejected') return;
      const { name, latencyMs, ok, error } = r.value;
      results[name] = { latencyMs, ok, error: error || null };

      if (!ok) {
        errors.push({ index: name, error, latencyMs });
      } else if (latencyMs >= LATENCY_CRITICAL_MS) {
        errors.push({ index: name, latencyMs, reason: 'latency_critical' });
      } else if (latencyMs >= LATENCY_WARNING_MS) {
        warnings.push({ index: name, latencyMs, reason: 'latency_warning' });
      }
    });

    const latencies    = Object.values(results).filter(r => r.ok).map(r => r.latencyMs);
    const p50          = _percentile(latencies, 50);
    const p95          = _percentile(latencies, 95);
    const totalMs      = Date.now() - t0;
    const allHealthy   = errors.length === 0;

    const snapshot = {
      runAt,
      allHealthy,
      p50LatencyMs:    p50,
      p95LatencyMs:    p95,
      totalIndexes:    PRIMARY_INDEXES.length,
      healthyIndexes:  PRIMARY_INDEXES.length - errors.length,
      errorCount:      errors.length,
      warningCount:    warnings.length,
      results,
      errors,
      warnings,
      probeDurationMs: totalMs,
    };

    /* Persist latest snapshot */
    await db.collection('platformMetrics').doc('algoliaHealth').set(snapshot, { merge: true });

    /* Store in time-series for trend analysis — keep 7 days (7 × 96 probes = 672 docs) */
    await db.collection('algoliaHealthHistory').add({
      ...snapshot,
      createdAt: _now(),
    });

    /* Fire alert if critical errors */
    if (errors.length > 0) {
      await db.collection('adminAlerts').add({
        type:     'algolia_search_degraded',
        severity: errors.length > 3 ? 'critical' : 'warning',
        message:  `Algolia monitor: ${errors.length} index(es) degraded. P95 latency: ${p95}ms.`,
        errors,
        warnings,
        p95LatencyMs: p95,
        createdAt:    _now(),
        resolved:     false,
      });
      console.error(`[AlgoliaMonitor] DEGRADED: ${errors.length} errors — p50=${p50}ms p95=${p95}ms`);
    }

    if (!allHealthy || p95 >= LATENCY_CRITICAL_MS) {
      console.warn(`[AlgoliaMonitor] Health: ${allHealthy ? 'OK' : 'DEGRADED'} p50=${p50}ms p95=${p95}ms`);
    } else {
      console.log(`[AlgoliaMonitor] Health: OK p50=${p50}ms p95=${p95}ms (${totalMs}ms)`);
    }
  }
);

/* ══════════════════════════════════════════════════════════════════════
   algoliaMonitorEntries  — scheduled daily at 04:00
   Tracks index entry counts and build times; alerts on sudden drops.
══════════════════════════════════════════════════════════════════════ */

const algoliaMonitorEntries = onSchedule(
  {
    schedule:       'every day 04:00',
    timeoutSeconds: 120,
    memory:         '256MiB',
    secrets:        [ALGOLIA_ADMIN_KEY],
  },
  async () => {
    const algolia = _client();
    if (!algolia) return;

    const db    = _db();
    const runAt = new Date().toISOString();

    /* Fetch index stats in parallel */
    const statsResults = await Promise.allSettled(
      PRIMARY_INDEXES.map(async name => {
        const stats = await algolia.getIndexStats(name);
        return {
          name,
          entries:       stats.entries       || 0,
          dataSize:      stats.dataSize      || 0,
          fileSize:      stats.fileSize      || 0,
          buildTimeMs:   (stats.lastBuildTimeS || 0) * 1000,
          pendingTask:   stats.toBeIndexedNb  || 0,
        };
      })
    );

    const entries = {};
    statsResults.forEach(r => {
      if (r.status === 'fulfilled') entries[r.value.name] = r.value;
    });

    /* Load yesterday's snapshot to detect entry drops */
    const yesterday = await db.collection('algoliaEntriesHistory')
      .orderBy('createdAt', 'desc')
      .limit(1)
      .get();

    const prevEntries = yesterday.empty ? {} : (yesterday.docs[0].data().entries || {});
    const drops       = [];

    for (const [name, stats] of Object.entries(entries)) {
      const prev = prevEntries[name]?.entries;
      if (prev && prev > 100 && stats.entries < prev * (1 - ENTRY_DROP_THRESHOLD)) {
        drops.push({
          index:       name,
          prev,
          current:     stats.entries,
          dropPercent: ((1 - stats.entries / prev) * 100).toFixed(1),
        });
      }
    }

    const snapshot = {
      runAt,
      entries,
      drops,
      createdAt: _now(),
    };

    /* Persist */
    await db.collection('algoliaEntriesHistory').add(snapshot);
    await db.collection('platformMetrics').doc('algoliaEntries').set({
      latestRunAt: runAt,
      entries,
      updatedAt:   _now(),
    }, { merge: true });

    /* Alert on entry drops */
    if (drops.length > 0) {
      await db.collection('adminAlerts').add({
        type:     'algolia_entry_count_drop',
        severity: drops.length > 2 ? 'critical' : 'warning',
        message:  `Algolia index entry count dropped significantly: ${drops.map(d => `${d.index} (${d.dropPercent}%)`).join(', ')}`,
        drops,
        createdAt: _now(),
        resolved:  false,
      });
      console.error(`[AlgoliaMonitor] ENTRY DROP DETECTED: ${JSON.stringify(drops)}`);
    }

    console.log(`[AlgoliaMonitor] Entries recorded: ${Object.keys(entries).length} indexes, ${drops.length} drops`);
  }
);

/* ══════════════════════════════════════════════════════════════════════
   algoliaGetMonitorDashboard  — admin callable: full dashboard data
══════════════════════════════════════════════════════════════════════ */

const algoliaGetMonitorDashboard = onCall(
  { secrets: [ALGOLIA_ADMIN_KEY], timeoutSeconds: 15 },
  async (request) => {
    _assertAdmin(request);
    const db = _db();

    const [healthSnap, entriesSnap, alertsSnap] = await Promise.all([
      db.collection('platformMetrics').doc('algoliaHealth').get(),
      db.collection('platformMetrics').doc('algoliaEntries').get(),
      db.collection('adminAlerts')
        .where('type', 'in', ['algolia_search_degraded', 'algolia_entry_count_drop'])
        .where('resolved', '==', false)
        .orderBy('createdAt', 'desc')
        .limit(10)
        .get(),
    ]);

    return {
      health:       healthSnap.exists   ? healthSnap.data()  : null,
      entries:      entriesSnap.exists  ? entriesSnap.data() : null,
      openAlerts:   alertsSnap.docs.map(d => ({ id: d.id, ...d.data() })),
      generatedAt:  new Date().toISOString(),
    };
  }
);

/* ══════════════════════════════════════════════════════════════════════
   algoliaGetLatencyHistory  — admin callable: 7-day latency trend
══════════════════════════════════════════════════════════════════════ */

const algoliaGetLatencyHistory = onCall(
  { secrets: [ALGOLIA_ADMIN_KEY], timeoutSeconds: 15 },
  async (request) => {
    _assertAdmin(request);

    const { indexName = null, hours = 24 } = request.data || {};
    const cutoff = admin.firestore.Timestamp.fromMillis(Date.now() - hours * 3600 * 1000);

    const db   = _db();
    const snap = await db.collection('algoliaHealthHistory')
      .where('createdAt', '>=', cutoff)
      .orderBy('createdAt', 'asc')
      .limit(200)
      .get();

    const history = snap.docs.map(d => {
      const data = d.data();
      return {
        runAt:        data.runAt,
        p50LatencyMs: data.p50LatencyMs,
        p95LatencyMs: data.p95LatencyMs,
        errorCount:   data.errorCount,
        warningCount: data.warningCount,
        ...(indexName && data.results?.[indexName] ? {
          indexLatencyMs: data.results[indexName].latencyMs,
          indexOk:        data.results[indexName].ok,
        } : {}),
      };
    });

    return { history, indexName, hours };
  }
);

/* ══════════════════════════════════════════════════════════════════════
   algoliaResolveMonitorAlert  — admin callable: mark alert resolved
══════════════════════════════════════════════════════════════════════ */

const algoliaResolveMonitorAlert = onCall(
  { secrets: [ALGOLIA_ADMIN_KEY], timeoutSeconds: 10 },
  async (request) => {
    _assertAdmin(request);
    const { alertId } = request.data || {};
    if (!alertId) throw new HttpsError('invalid-argument', 'alertId required');

    await _db().collection('adminAlerts').doc(alertId).update({
      resolved:   true,
      resolvedBy: request.auth.uid,
      resolvedAt: _now(),
    });

    return { ok: true, alertId };
  }
);

/* ══════════════════════════════════════════════════════════════════════
   algoliaMonitorCleanup  — weekly: purge old health history (> 30 days)
══════════════════════════════════════════════════════════════════════ */

const algoliaMonitorCleanup = onSchedule(
  { schedule: 'every sunday 05:00', timeoutSeconds: 300 },
  async () => {
    const db     = _db();
    const cutoff = admin.firestore.Timestamp.fromMillis(Date.now() - 30 * 24 * 3600 * 1000);

    const [healthSnap, entriesSnap] = await Promise.all([
      db.collection('algoliaHealthHistory').where('createdAt', '<', cutoff).limit(2000).get(),
      db.collection('algoliaEntriesHistory').where('createdAt', '<', cutoff).limit(500).get(),
    ]);

    /* Firestore batch max = 500 writes — chunk all refs into pages of 500 */
    const allRefs = [
      ...healthSnap.docs.map(d => d.ref),
      ...entriesSnap.docs.map(d => d.ref),
    ];

    let deleted = 0;
    for (let i = 0; i < allRefs.length; i += 500) {
      const page  = allRefs.slice(i, i + 500);
      const batch = db.batch();
      page.forEach(ref => batch.delete(ref));
      await batch.commit();
      deleted += page.length;
    }

    console.log(`[AlgoliaMonitor] Cleanup: purged ${deleted} old history docs`);
  }
);

module.exports = {
  algoliaMonitorHealth,
  algoliaMonitorEntries,
  algoliaGetMonitorDashboard,
  algoliaGetLatencyHistory,
  algoliaResolveMonitorAlert,
  algoliaMonitorCleanup,
};
