/**
 * observability-engine.js
 * SOKONI Platform — Observability Cloud Functions Backend v1.0
 *
 * Exports:
 *   obsIngestTelemetry      onCall  — batch ingest telemetry events (public auth)
 *   obsGetErrorReport       onCall  — aggregated error report (admin only)
 *   obsGetPerformanceReport onCall  — P50/P75/P95/P99 Web Vitals (admin only)
 *   obsGetRealTimeMetrics   onCall  — last-5-minute live snapshot (admin only)
 *   obsScheduledAggregation onSchedule every 1 hour — rollup + 30-day cleanup
 *   obsGetAuditLog          onCall  — paginated audit log search (admin only)
 *   obsCreateAlert          onCall  — create metric alert rule (admin only)
 *   obsCheckAlerts          onSchedule every 5 minutes — evaluate alert thresholds
 *   obsDistributedTrace     onCall  — record a distributed trace span (authenticated)
 *   obsHealthProbe          onRequest — public health-check endpoint
 *
 * (c) 2026 SOKONI. All rights reserved.
 */

'use strict';

const functions         = require('firebase-functions/v2');
const { onCall, onRequest, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule }   = require('firebase-functions/v2/scheduler');
const admin            = require('firebase-admin');

// admin.initializeApp() is called in index.js — do NOT call it here
const db     = () => admin.firestore();
const logger = functions.logger;

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────

const REGION            = 'us-central1';
const VERSION           = '1.0.0';

const COL_TELEMETRY     = '_sokoniTelemetry';   // raw client batches (fallback path)
const COL_ERRORS        = '_sokoniErrors';       // individual error events
const COL_PERF          = '_sokoniPerf';         // individual performance events
const COL_EVENTS        = '_sokoniEvents';       // individual analytics events + logs
const COL_METRICS_HOURLY= '_sokoniMetricsHourly'; // pre-aggregated hourly rollups
const COL_ALERTS        = '_sokoniAlerts';       // alert rule configuration
const COL_ALERT_FIRED   = '_sokoniAlertFired';   // alert breach records
const COL_TRACES        = '_sokoniTraces';       // distributed trace data
const COL_AUDIT         = 'auditLog';            // platform-wide audit log
const COL_ADMIN_NOTIF   = 'adminNotifications';  // admin notification inbox

const MAX_BATCH_INGEST  = 500;   // max events per obsIngestTelemetry call
const BATCH_WRITE_SIZE  = 400;   // Firestore batch write limit (safe ceiling)
const REALTIME_WINDOW_MS= 5 * 60 * 1000;  // 5 minutes in ms
const TRACE_TTL_DAYS    = 7;
const RETENTION_DAYS    = 30;

// ─────────────────────────────────────────────────────────────────────────────
// SHARED HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Verify caller is an admin (custom claim admin=true or superAdmin=true).
 * Throws HttpsError on failure.
 */
async function assertAdmin(auth) {
  if (!auth || !auth.uid) {
    throw new HttpsError('unauthenticated', 'Authentication required.');
  }
  try {
    const userRecord = await admin.auth().getUser(auth.uid);
    const claims = userRecord.customClaims || {};
    if (!claims.admin && !claims.superAdmin) {
      throw new HttpsError('permission-denied', 'Admin access required.');
    }
  } catch (err) {
    if (err.code === 'functions/unauthenticated' || err.code === 'functions/permission-denied') {
      throw err;
    }
    logger.error('assertAdmin failed', { uid: auth.uid, err: err.message });
    throw new HttpsError('internal', 'Authorization check failed.');
  }
}

/**
 * Verify caller is authenticated (any role).
 * Throws HttpsError on failure.
 */
function assertAuth(auth) {
  if (!auth || !auth.uid) {
    throw new HttpsError('unauthenticated', 'Authentication required.');
  }
}

/**
 * Compute statistical percentiles from a sorted numeric array.
 * Input must be pre-sorted ascending.
 */
function percentiles(sorted) {
  if (!sorted.length) return { p50: 0, p75: 0, p95: 0, p99: 0, count: 0, min: 0, max: 0, avg: 0 };
  const n = sorted.length;
  const at = (p) => sorted[Math.min(Math.ceil(p / 100 * n) - 1, n - 1)];
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    p50  : at(50),
    p75  : at(75),
    p95  : at(95),
    p99  : at(99),
    count: n,
    min  : sorted[0],
    max  : sorted[n - 1],
    avg  : Math.round(sum / n),
  };
}

/**
 * ISO timestamp string from a Date or milliseconds value.
 */
function toISO(d) {
  try {
    if (!d) return new Date().toISOString();
    if (typeof d === 'number') return new Date(d).toISOString();
    if (d instanceof Date)    return d.toISOString();
    return String(d);
  } catch {
    return new Date().toISOString();
  }
}

/**
 * Converts an ISO string or timestamp to a Firestore Timestamp.
 * Falls back to now on any error.
 */
function toTimestamp(val) {
  try {
    if (val instanceof admin.firestore.Timestamp) return val;
    if (typeof val === 'string') return admin.firestore.Timestamp.fromDate(new Date(val));
    if (typeof val === 'number') return admin.firestore.Timestamp.fromMillis(val);
  } catch { /* ignore */ }
  return admin.firestore.Timestamp.now();
}

/**
 * Safely escape a string value for storage (prevents Firestore injection patterns).
 */
function safeStr(val, maxLen = 500) {
  if (val === undefined || val === null) return null;
  return String(val).slice(0, maxLen);
}

/**
 * Write an admin notification document (fire-and-forget, never throws).
 */
async function adminNotify(subject, body, metadata) {
  try {
    await db().collection(COL_ADMIN_NOTIF).add({
      subject    : safeStr(subject, 200),
      body       : safeStr(body, 2000),
      metadata   : metadata || null,
      source     : 'observability-engine',
      read       : false,
      priority   : 'high',
      createdAt  : admin.firestore.FieldValue.serverTimestamp(),
    });
  } catch (err) {
    logger.error('[obs] adminNotify failed', { err: err.message });
  }
}

/**
 * Fan-out a single telemetry event to the correct specialized collection.
 * Returns the target collection name, or null if event was rejected.
 */
function resolveCollection(event) {
  const t = (event.type || '').toLowerCase();
  if (t === 'error')                              return COL_ERRORS;
  if (t === 'perf' || t === 'vital'
      || t === 'navtiming' || t === 'slowresource'
      || t === 'longtask'  || t === 'customtimer') return COL_PERF;
  if (t === 'event' || t === 'pageview'
      || t === 'identify' || t === 'log'
      || t === 'funnelenter' || t === 'funnelexit') return COL_EVENTS;
  return null; // unknown type — skip
}

/**
 * Validate the minimum schema for a telemetry event.
 * Returns true if valid, false if it should be rejected.
 */
function isValidEvent(event) {
  if (!event || typeof event !== 'object')        return false;
  if (!event.type || typeof event.type !== 'string') return false;
  if (!event.timestamp || typeof event.timestamp !== 'string') return false;
  if (!event.sessionId || typeof event.sessionId !== 'string') return false;
  // Sanitise: reject absurdly large events (>8KB serialised)
  if (JSON.stringify(event).length > 8192)        return false;
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. obsIngestTelemetry — onCall
//    Accepts a batch of events, validates, fans out to specialized collections.
// ─────────────────────────────────────────────────────────────────────────────

const obsIngestTelemetry = onCall(
  { region: REGION, maxInstances: 50, enforceAppCheck: true },
  async (request) => {
    const { data, auth } = request;

    // Allow authenticated or unauthenticated (public telemetry)
    const uid = auth ? auth.uid : null;

    // Validate top-level structure
    if (!data || !Array.isArray(data.events)) {
      throw new HttpsError('invalid-argument', 'Request must include an events array.');
    }

    const rawEvents = data.events;
    if (rawEvents.length > MAX_BATCH_INGEST) {
      throw new HttpsError(
        'invalid-argument',
        `Batch too large. Maximum ${MAX_BATCH_INGEST} events per request.`
      );
    }

    let ingested = 0;
    let rejected = 0;

    // Group valid events by target collection
    const buckets = {
      [COL_ERRORS]: [],
      [COL_PERF]  : [],
      [COL_EVENTS]: [],
    };

    for (const event of rawEvents) {
      if (!isValidEvent(event)) { rejected++; continue; }

      const col = resolveCollection(event);
      if (!col) { rejected++; continue; }

      // Stamp server-side metadata
      buckets[col].push({
        ...event,
        _uid        : uid,
        _receivedAt : new Date().toISOString(),
        _ingested   : true,
      });
      ingested++;
    }

    // Write each bucket in Firestore batch writes (≤400 per batch)
    const batchWrite = async (colName, docs) => {
      for (let i = 0; i < docs.length; i += BATCH_WRITE_SIZE) {
        const chunk = docs.slice(i, i + BATCH_WRITE_SIZE);
        const batch = db().batch();
        for (const doc of chunk) {
          const ref = db().collection(colName).doc();
          batch.set(ref, doc);
        }
        await batch.commit();
      }
    };

    await Promise.all([
      buckets[COL_ERRORS].length  ? batchWrite(COL_ERRORS,  buckets[COL_ERRORS])  : null,
      buckets[COL_PERF].length    ? batchWrite(COL_PERF,    buckets[COL_PERF])    : null,
      buckets[COL_EVENTS].length  ? batchWrite(COL_EVENTS,  buckets[COL_EVENTS])  : null,
    ].filter(Boolean));

    logger.info('[obs] ingest complete', { ingested, rejected, uid });
    return { ingested, rejected };
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// 2. obsGetErrorReport — onCall (admin only)
//    Returns aggregated error data with frequency ranking and trend data.
// ─────────────────────────────────────────────────────────────────────────────

const obsGetErrorReport = onCall(
  { region: REGION, maxInstances: 10, enforceAppCheck: true },
  async (request) => {
    await assertAdmin(request.auth);
    const data = request.data || {};

    // Parse + validate filters
    const from     = data.from     ? new Date(data.from)     : new Date(Date.now() - 24 * 3600 * 1000);
    const to       = data.to       ? new Date(data.to)       : new Date();
    const severity = data.severity ? safeStr(data.severity, 20) : null;
    const page     = data.page     ? safeStr(data.page, 500)    : null;
    const limit    = Math.min(Number(data.limit) || 100, 500);

    if (isNaN(from.getTime()) || isNaN(to.getTime())) {
      throw new HttpsError('invalid-argument', 'Invalid date range.');
    }
    if (from >= to) {
      throw new HttpsError('invalid-argument', 'from must be before to.');
    }

    // Query _sokoniErrors
    let query = db().collection(COL_ERRORS)
      .where('timestamp', '>=', from.toISOString())
      .where('timestamp', '<=', to.toISOString())
      .orderBy('timestamp', 'desc')
      .limit(limit);

    if (severity) query = query.where('severity', '==', severity);
    if (page)     query = query.where('page', '==', page);

    const snapshot = await query.get();
    const docs = snapshot.docs.map(d => d.data());

    // Aggregate: frequency map keyed by error message
    const freqMap = new Map();  // message → { count, severity, firstSeen, lastSeen, pages, users }
    const hourBuckets = {};     // 'YYYY-MM-DDTHH' → count
    const affectedUsers = new Set();

    for (const doc of docs) {
      const key = safeStr(doc.message, 300) || 'unknown';
      const sev = doc.severity || 'ERROR';
      const ts  = doc.timestamp || '';
      const usr = doc.userId;

      if (usr) affectedUsers.add(usr);

      // Hourly bucketing for trend
      if (ts.length >= 13) {
        const hour = ts.slice(0, 13); // 'YYYY-MM-DDTHH'
        hourBuckets[hour] = (hourBuckets[hour] || 0) + 1;
      }

      if (!freqMap.has(key)) {
        freqMap.set(key, {
          message  : key,
          count    : 0,
          severity : sev,
          firstSeen: ts,
          lastSeen : ts,
          pages    : new Set(),
          name     : safeStr(doc.name, 100),
        });
      }
      const entry = freqMap.get(key);
      entry.count++;
      if (ts < entry.firstSeen) entry.firstSeen = ts;
      if (ts > entry.lastSeen)  entry.lastSeen  = ts;
      if (doc.page) entry.pages.add(safeStr(doc.page, 200));
    }

    // Serialise Sets
    const topErrors = [...freqMap.values()]
      .sort((a, b) => b.count - a.count)
      .slice(0, 50)
      .map(e => ({ ...e, pages: [...e.pages].slice(0, 10) }));

    // Build trend array sorted by hour
    const trend = Object.entries(hourBuckets)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([hour, count]) => ({ hour, count }));

    return {
      summary: {
        totalErrors   : docs.length,
        uniqueErrors  : freqMap.size,
        affectedUsers : affectedUsers.size,
        from          : from.toISOString(),
        to            : to.toISOString(),
        filters       : { severity, page, limit },
      },
      topErrors,
      trend,
    };
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// 3. obsGetPerformanceReport — onCall (admin only)
//    Returns P50/P75/P95/P99 per Web Vital metric, plus worst-performing pages.
// ─────────────────────────────────────────────────────────────────────────────

const obsGetPerformanceReport = onCall(
  { region: REGION, maxInstances: 10, enforceAppCheck: true },
  async (request) => {
    await assertAdmin(request.auth);
    const data = request.data || {};

    const from  = data.from ? new Date(data.from) : new Date(Date.now() - 24 * 3600 * 1000);
    const to    = data.to   ? new Date(data.to)   : new Date();
    const page  = data.page ? safeStr(data.page, 500) : null;

    if (isNaN(from.getTime()) || isNaN(to.getTime())) {
      throw new HttpsError('invalid-argument', 'Invalid date range.');
    }

    // [H-5] orderBy before limit to get the most recent samples when capped
    let query = db().collection(COL_PERF)
      .where('timestamp', '>=', from.toISOString())
      .where('timestamp', '<=', to.toISOString())
      .where('type', '==', 'perf')
      .orderBy('timestamp', 'desc')
      .limit(5000); // cap reads

    if (page) query = query.where('page', '==', page);

    const snapshot = await query.get();
    const docs = snapshot.docs.map(d => d.data());

    // Bucket values per metric, and per page
    const metricBuckets = {};  // metric → number[]
    const pageBuckets   = {};  // page → { metric → number[] }

    for (const doc of docs) {
      const metric = safeStr(doc.metric, 50);
      const value  = typeof doc.value === 'number' ? doc.value : null;
      const pg     = safeStr(doc.page, 300) || '/unknown';

      if (!metric || value === null) continue;

      if (!metricBuckets[metric]) metricBuckets[metric] = [];
      metricBuckets[metric].push(value);

      if (!pageBuckets[pg]) pageBuckets[pg] = {};
      if (!pageBuckets[pg][metric]) pageBuckets[pg][metric] = [];
      pageBuckets[pg][metric].push(value);
    }

    // Compute percentiles per metric
    const metricPercentiles = {};
    for (const [metric, values] of Object.entries(metricBuckets)) {
      values.sort((a, b) => a - b);
      metricPercentiles[metric] = percentiles(values);
    }

    // Compute worst pages per key metric (LCP primary)
    const worstPages = Object.entries(pageBuckets)
      .map(([pg, metrics]) => {
        const lcpVals = (metrics['LCP'] || []).sort((a, b) => a - b);
        return {
          page  : pg,
          lcp   : lcpVals.length ? percentiles(lcpVals) : null,
          fcp   : metrics['FCP'] ? percentiles([...metrics['FCP']].sort((a, b) => a - b)) : null,
          ttfb  : metrics['TTFB'] ? percentiles([...metrics['TTFB']].sort((a, b) => a - b)) : null,
          samples: Object.values(metrics).reduce((s, v) => s + v.length, 0),
        };
      })
      .filter(p => p.lcp !== null)
      .sort((a, b) => (b.lcp.p75 || 0) - (a.lcp.p75 || 0))
      .slice(0, 20);

    return {
      summary: {
        totalSamples: docs.length,
        from        : from.toISOString(),
        to          : to.toISOString(),
        page        : page || 'all',
      },
      metrics: metricPercentiles,
      worstPages,
    };
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// 4. obsGetRealTimeMetrics — onCall (admin only)
//    Snapshot of the last 5 minutes: active sessions, error rate, avg LCP, top pages.
// ─────────────────────────────────────────────────────────────────────────────

const obsGetRealTimeMetrics = onCall(
  { region: REGION, maxInstances: 20, enforceAppCheck: true },
  async (request) => {
    await assertAdmin(request.auth);

    const windowStart = new Date(Date.now() - REALTIME_WINDOW_MS).toISOString();
    const now         = new Date().toISOString();

    // [H-2] orderBy before limit on both event and error queries
    const [eventsSnap, errorsSnap, perfSnap] = await Promise.all([
      db().collection(COL_EVENTS)
        .where('timestamp', '>=', windowStart)
        .orderBy('timestamp', 'desc')
        .limit(2000)
        .get(),
      db().collection(COL_ERRORS)
        .where('timestamp', '>=', windowStart)
        .orderBy('timestamp', 'desc')
        .limit(2000)
        .get(),
      db().collection(COL_PERF)
        .where('timestamp', '>=', windowStart)
        .where('metric', '==', 'LCP')
        .limit(1000)
        .get(),
    ]);

    const events = eventsSnap.docs.map(d => d.data());
    const errors = errorsSnap.docs.map(d => d.data());
    const perf   = perfSnap.docs.map(d => d.data());

    // Active sessions: unique sessionIds across events + errors
    const sessionSet = new Set();
    for (const e of [...events, ...errors]) {
      if (e.sessionId) sessionSet.add(e.sessionId);
    }

    // Error rate: errors / (events + errors)
    const totalActivity = events.length + errors.length;
    const errorRate     = totalActivity > 0
      ? Math.round((errors.length / totalActivity) * 1000) / 10  // percentage to 1dp
      : 0;

    // Average LCP
    const lcpValues = perf.map(d => d.value).filter(v => typeof v === 'number');
    const avgLCP    = lcpValues.length
      ? Math.round(lcpValues.reduce((a, b) => a + b, 0) / lcpValues.length)
      : null;

    // Top pages by traffic (events only)
    const pageCount = {};
    for (const e of events) {
      if (e.page) {
        const pg = safeStr(e.page, 300);
        pageCount[pg] = (pageCount[pg] || 0) + 1;
      }
    }
    const topPages = Object.entries(pageCount)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 10)
      .map(([page, count]) => ({ page, count }));

    // Error breakdown by severity
    const severityBreakdown = {};
    for (const err of errors) {
      const s = err.severity || 'ERROR';
      severityBreakdown[s] = (severityBreakdown[s] || 0) + 1;
    }

    return {
      windowStart,
      windowEnd       : now,
      activeSessions  : sessionSet.size,
      errorRate       : errorRate,        // %
      errorCount      : errors.length,
      eventCount      : events.length,
      avgLCP,                             // ms, null if no data
      topPages,
      severityBreakdown,
      capturedAt      : now,
    };
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// 5. obsScheduledAggregation — onSchedule every 1 hour
//    Pre-aggregates metrics and prunes raw events older than 30 days.
// ─────────────────────────────────────────────────────────────────────────────

const obsScheduledAggregation = onSchedule(
  { schedule: 'every 60 minutes', region: REGION, timeoutSeconds: 540 },
  async () => {
    const now       = new Date();
    const hourStart = new Date(now);
    hourStart.setMinutes(0, 0, 0);
    const prevHourStart = new Date(hourStart.getTime() - 3600 * 1000);
    const prevHourEnd   = new Date(hourStart.getTime() - 1);

    const fromISO = prevHourStart.toISOString();
    const toISO   = prevHourEnd.toISOString();

    // Pad to YYYY-MM-DD-HH
    const hourKey = [
      prevHourStart.getUTCFullYear(),
      String(prevHourStart.getUTCMonth() + 1).padStart(2, '0'),
      String(prevHourStart.getUTCDate()).padStart(2, '0'),
      String(prevHourStart.getUTCHours()).padStart(2, '0'),
    ].join('-');

    logger.info('[obs] aggregation starting', { hourKey, fromISO, toISO });

    // Read last hour from all specialized collections
    const [errSnap, perfSnap, evtSnap] = await Promise.all([
      db().collection(COL_ERRORS)
        .where('timestamp', '>=', fromISO)
        .where('timestamp', '<=', toISO)
        .limit(5000)
        .get(),
      db().collection(COL_PERF)
        .where('timestamp', '>=', fromISO)
        .where('timestamp', '<=', toISO)
        .limit(5000)
        .get(),
      db().collection(COL_EVENTS)
        .where('timestamp', '>=', fromISO)
        .where('timestamp', '<=', toISO)
        .limit(5000)
        .get(),
    ]);

    // [M-5] Warn when any query hits the 5000-doc cap — rollup data may be incomplete
    if (errSnap.size >= 5000) {
      logger.warn('[obs] rollup hit 5000-doc cap — data may be incomplete', { collection: COL_ERRORS });
    }
    if (perfSnap.size >= 5000) {
      logger.warn('[obs] rollup hit 5000-doc cap — data may be incomplete', { collection: COL_PERF });
    }
    if (evtSnap.size >= 5000) {
      logger.warn('[obs] rollup hit 5000-doc cap — data may be incomplete', { collection: COL_EVENTS });
    }

    const errors   = errSnap.docs.map(d => d.data());
    const perfs    = perfSnap.docs.map(d => d.data());
    const events   = evtSnap.docs.map(d => d.data());

    // Compute rollup metrics
    const lcpValues = perfs.filter(p => p.metric === 'LCP' && typeof p.value === 'number')
                          .map(p => p.value).sort((a, b) => a - b);
    const fcpValues = perfs.filter(p => p.metric === 'FCP' && typeof p.value === 'number')
                          .map(p => p.value).sort((a, b) => a - b);
    const clsValues = perfs.filter(p => p.metric === 'CLS' && typeof p.value === 'number')
                          .map(p => p.value).sort((a, b) => a - b);

    const errorsBySeverity = {};
    for (const e of errors) {
      const s = e.severity || 'ERROR';
      errorsBySeverity[s] = (errorsBySeverity[s] || 0) + 1;
    }

    const pageCount = {};
    for (const e of events) {
      if (e.page) pageCount[safeStr(e.page, 300)] = (pageCount[safeStr(e.page, 300)] || 0) + 1;
    }
    const topPages = Object.entries(pageCount)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 10)
      .map(([page, count]) => ({ page, count }));

    const uniqueSessions = new Set(
      [...errors, ...events].map(d => d.sessionId).filter(Boolean)
    ).size;

    const rollup = {
      hourKey,
      fromISO,
      toISO,
      errorCount      : errors.length,
      eventCount      : events.length,
      perfCount       : perfs.length,
      uniqueSessions,
      errorsBySeverity,
      topPages,
      lcp : percentiles(lcpValues),
      fcp : percentiles(fcpValues),
      cls : percentiles(clsValues),
      aggregatedAt    : admin.firestore.FieldValue.serverTimestamp(),
    };

    await db().collection(COL_METRICS_HOURLY).doc(hourKey).set(rollup, { merge: true });
    logger.info('[obs] hourly rollup written', { hourKey, errors: errors.length, events: events.length });

    // ── 30-day cleanup ──
    const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 3600 * 1000).toISOString();

    await Promise.all([
      _deleteOldDocs(COL_ERRORS,     cutoff),
      _deleteOldDocs(COL_PERF,       cutoff),
      _deleteOldDocs(COL_EVENTS,     cutoff),
      _deleteOldDocs(COL_TELEMETRY,  cutoff),
    ]);

    logger.info('[obs] 30-day cleanup complete', { cutoff });
  }
);

/** Delete documents older than cutoff ISO date in batches of 500. */
async function _deleteOldDocs(colName, cutoffISO) {
  let totalDeleted = 0;
  let keepGoing    = true;

  while (keepGoing) {
    const snap = await db().collection(colName)
      .where('timestamp', '<', cutoffISO)
      .limit(500)
      .get();

    if (snap.empty) { keepGoing = false; break; }

    const batch = db().batch();
    for (const doc of snap.docs) batch.delete(doc.ref);
    await batch.commit();

    totalDeleted += snap.size;
    keepGoing = snap.size === 500;
  }

  if (totalDeleted > 0) {
    logger.info('[obs] deleted old docs', { colName, totalDeleted, cutoffISO });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. obsGetAuditLog — onCall (admin only)
//    Paginated search of the platform-wide auditLog collection.
// ─────────────────────────────────────────────────────────────────────────────

const obsGetAuditLog = onCall(
  { region: REGION, maxInstances: 10, enforceAppCheck: true },
  async (request) => {
    await assertAdmin(request.auth);
    const data = request.data || {};

    const userId   = data.userId ? safeStr(data.userId, 128)   : null;
    const action   = data.action ? safeStr(data.action, 100)   : null;
    const from     = data.from   ? new Date(data.from)         : new Date(Date.now() - 7 * 24 * 3600 * 1000);
    const to       = data.to     ? new Date(data.to)           : new Date();
    const limit    = Math.min(Number(data.limit) || 50, 200);
    const startAfter = data.startAfter || null; // document ID for pagination cursor

    if (isNaN(from.getTime()) || isNaN(to.getTime())) {
      throw new HttpsError('invalid-argument', 'Invalid date range.');
    }

    let query = db().collection(COL_AUDIT)
      .where('timestamp', '>=', from.toISOString())
      .where('timestamp', '<=', to.toISOString())
      .orderBy('timestamp', 'desc');

    if (userId) query = query.where('userId', '==', userId);
    if (action) query = query.where('action', '==', action);

    // [L-3] Throw when cursor document no longer exists
    if (startAfter) {
      const cursorDoc = await db().collection(COL_AUDIT).doc(startAfter).get();
      if (!cursorDoc.exists) {
        throw new HttpsError('not-found', 'Pagination cursor is no longer valid; restart from page 1.');
      }
      query = query.startAfter(cursorDoc);
    }

    query = query.limit(limit + 1); // fetch one extra to detect next page

    const snap = await query.get();
    const docs = snap.docs.slice(0, limit).map(d => ({ id: d.id, ...d.data() }));
    const hasMore = snap.size > limit;
    const nextCursor = hasMore ? snap.docs[limit - 1].id : null;

    return {
      entries   : docs,
      count     : docs.length,
      hasMore,
      nextCursor,
      filters   : { userId, action, from: from.toISOString(), to: to.toISOString(), limit },
    };
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// 7. obsCreateAlert — onCall (admin only)
//    Persist a metric alert rule to _sokoniAlerts/{alertId}.
// ─────────────────────────────────────────────────────────────────────────────

// [H-4] avgFCP and avgTTFB removed — they are always null in evaluation and mislead alert authors
const VALID_METRICS     = ['errorRate', 'errorCount', 'avgLCP', 'activeSessionCount'];
const VALID_COMPARISONS = ['gt', 'lt', 'gte', 'lte', 'eq'];

const obsCreateAlert = onCall(
  { region: REGION, maxInstances: 5, enforceAppCheck: true },
  async (request) => {
    await assertAdmin(request.auth);
    const data = request.data || {};

    // Validate required fields
    const metric      = safeStr(data.metric, 50);
    const threshold   = Number(data.threshold);
    const comparison  = safeStr(data.comparison, 10);
    const notifyEmail = safeStr(data.notifyEmail, 255);

    if (!metric || !VALID_METRICS.includes(metric)) {
      throw new HttpsError('invalid-argument',
        `metric must be one of: ${VALID_METRICS.join(', ')}`);
    }
    if (isNaN(threshold)) {
      throw new HttpsError('invalid-argument', 'threshold must be a numeric value.');
    }
    if (!comparison || !VALID_COMPARISONS.includes(comparison)) {
      throw new HttpsError('invalid-argument',
        `comparison must be one of: ${VALID_COMPARISONS.join(', ')}`);
    }
    if (notifyEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(notifyEmail)) {
      throw new HttpsError('invalid-argument', 'notifyEmail is not a valid email address.');
    }

    const alertRef = db().collection(COL_ALERTS).doc();
    const alertName = safeStr(data.name, 200) || `${metric} ${comparison} ${threshold}`;
    const alertDesc = safeStr(data.description, 500) || null;

    const alertDoc = {
      alertId     : alertRef.id,
      metric,
      threshold,
      comparison,
      notifyEmail : notifyEmail || null,
      name        : alertName,
      description : alertDesc,
      active      : true,
      createdBy   : request.auth.uid,
      createdAt   : admin.firestore.FieldValue.serverTimestamp(),
      updatedAt   : admin.firestore.FieldValue.serverTimestamp(),
      fireCount   : 0,
    };

    await alertRef.set(alertDoc);
    logger.info('[obs] alert created', { alertId: alertRef.id, metric, threshold, comparison });

    // [H-1] Build return value without FieldValue sentinels
    const returnNow = new Date().toISOString();
    return {
      alertId     : alertRef.id,
      metric,
      threshold,
      comparison,
      notifyEmail : notifyEmail || null,
      name        : alertName,
      description : alertDesc,
      active      : true,
      createdBy   : request.auth.uid,
      createdAt   : returnNow,
      updatedAt   : returnNow,
      fireCount   : 0,
    };
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// 8. obsCheckAlerts — onSchedule every 5 minutes
//    Evaluate all active alert rules; fire notifications on threshold breaches.
// ─────────────────────────────────────────────────────────────────────────────

const obsCheckAlerts = onSchedule(
  { schedule: 'every 5 minutes', region: REGION, timeoutSeconds: 120 },
  async () => {
    // Load all active alerts
    const alertsSnap = await db().collection(COL_ALERTS)
      .where('active', '==', true)
      .limit(200)
      .get();

    if (alertsSnap.empty) return;

    // Compute current real-time metrics (reuse the 5-min window)
    const windowStart = new Date(Date.now() - REALTIME_WINDOW_MS).toISOString();

    // [H-3] orderBy before limit on event and error queries
    const [evtSnap, errSnap, perfSnap] = await Promise.all([
      db().collection(COL_EVENTS).where('timestamp', '>=', windowStart).orderBy('timestamp', 'desc').limit(2000).get(),
      db().collection(COL_ERRORS).where('timestamp', '>=', windowStart).orderBy('timestamp', 'desc').limit(2000).get(),
      db().collection(COL_PERF).where('timestamp', '>=', windowStart)
          .where('metric', '==', 'LCP').limit(1000).get(),
    ]);

    const eventCount  = evtSnap.size;
    const errorCount  = errSnap.size;
    const totalCount  = eventCount + errorCount;
    const errorRate   = totalCount > 0 ? (errorCount / totalCount) * 100 : 0;

    const sessions = new Set();
    for (const d of [...evtSnap.docs, ...errSnap.docs]) {
      const sid = d.data().sessionId;
      if (sid) sessions.add(sid);
    }
    const activeSessionCount = sessions.size;

    const lcpVals = perfSnap.docs.map(d => d.data().value).filter(v => typeof v === 'number');
    const avgLCP  = lcpVals.length
      ? lcpVals.reduce((a, b) => a + b, 0) / lcpVals.length
      : null;

    // [H-4] avgFCP and avgTTFB removed from currentMetrics
    const currentMetrics = {
      errorRate,
      errorCount,
      avgLCP,
      activeSessionCount,
    };

    // Evaluate each alert
    const checkBatch = db().batch();
    const fires      = [];

    for (const alertDoc of alertsSnap.docs) {
      const alert = alertDoc.data();
      const current = currentMetrics[alert.metric];

      if (current === null || current === undefined) continue;

      let breached = false;
      switch (alert.comparison) {
        case 'gt':  breached = current >  alert.threshold; break;
        case 'lt':  breached = current <  alert.threshold; break;
        case 'gte': breached = current >= alert.threshold; break;
        case 'lte': breached = current <= alert.threshold; break;
        case 'eq':  breached = current === alert.threshold; break;
      }

      if (!breached) continue;

      // Write breach record
      const firedId  = `${alertDoc.id}_${Date.now()}`;
      const firedRef = db().collection(COL_ALERT_FIRED).doc(firedId);
      checkBatch.set(firedRef, {
        alertId    : alertDoc.id,
        alertName  : alert.name || alert.metric,
        metric     : alert.metric,
        threshold  : alert.threshold,
        comparison : alert.comparison,
        currentValue: current,
        notifyEmail: alert.notifyEmail || null,
        firedAt    : admin.firestore.FieldValue.serverTimestamp(),
      });

      // [M-2] Use serverTimestamp consistently for updatedAt and lastFiredAt
      checkBatch.update(alertDoc.ref, {
        fireCount   : admin.firestore.FieldValue.increment(1),
        lastFiredAt : admin.firestore.FieldValue.serverTimestamp(),
        updatedAt   : admin.firestore.FieldValue.serverTimestamp(),
      });

      fires.push({ alertId: alertDoc.id, metric: alert.metric, current, threshold: alert.threshold });
    }

    if (fires.length > 0) {
      await checkBatch.commit();
      logger.warn('[obs] alerts fired', { count: fires.length, fires });

      // Notify admin
      const now = new Date().toISOString();
      await adminNotify(
        `[SOKONI Observability] ${fires.length} alert(s) triggered`,
        fires.map(f =>
          `• ${f.metric}: current=${f.current?.toFixed(2)}, threshold=${f.threshold}`
        ).join('\n'),
        { fires, evaluatedAt: now }
      );
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// 9. obsDistributedTrace — onCall (authenticated)
//    Records a distributed trace span with 7-day TTL.
// ─────────────────────────────────────────────────────────────────────────────

const obsDistributedTrace = onCall(
  { region: REGION, maxInstances: 30, enforceAppCheck: true },
  async (request) => {
    assertAuth(request.auth);
    const data = request.data || {};

    // Validate required fields
    const traceId   = safeStr(data.traceId, 64);
    const spanId    = safeStr(data.spanId, 64);
    const operation = safeStr(data.operation, 200);

    if (!traceId || !/^[a-zA-Z0-9_-]{1,64}$/.test(traceId)) {
      throw new HttpsError('invalid-argument', 'traceId must be 1-64 alphanumeric characters.');
    }
    if (!spanId || !/^[a-zA-Z0-9_-]{1,64}$/.test(spanId)) {
      throw new HttpsError('invalid-argument', 'spanId must be 1-64 alphanumeric characters.');
    }
    if (!operation) {
      throw new HttpsError('invalid-argument', 'operation is required.');
    }

    const duration = typeof data.duration === 'number' ? data.duration : null;
    const status   = safeStr(data.status, 20) || 'ok';

    if (duration !== null && (duration < 0 || duration > 3_600_000)) {
      throw new HttpsError('invalid-argument', 'duration must be between 0 and 3,600,000 ms.');
    }

    if (!['ok', 'error', 'timeout', 'cancelled'].includes(status)) {
      throw new HttpsError('invalid-argument', 'status must be ok | error | timeout | cancelled.');
    }

    // [M-4] Validate tags size before writing
    const tags = (data.tags && typeof data.tags === 'object' && !Array.isArray(data.tags))
                   ? data.tags
                   : {};
    if (tags && JSON.stringify(tags).length > 4096) {
      throw new HttpsError('invalid-argument', 'tags object exceeds 4KB limit.');
    }

    const expiresAt = new Date(Date.now() + TRACE_TTL_DAYS * 24 * 3600 * 1000);

    const spanDoc = {
      traceId,
      spanId,
      parentSpanId: safeStr(data.parentSpanId, 64) || null,
      operation,
      duration,
      status,
      tags,
      uid         : request.auth.uid,
      recordedAt  : new Date().toISOString(),
      expiresAt   : expiresAt.toISOString(),
    };

    // [M-3] Use .create() to prevent span overwrites; return idempotent flag if already exists
    try {
      await db()
        .collection(COL_TRACES)
        .doc(traceId)
        .collection('spans')
        .doc(spanId)
        .create(spanDoc);
    } catch (err) {
      if (err.code === 'already-exists' || err.code === 6) {
        return { traceId, spanId, idempotent: true };
      }
      throw err;
    }

    return { traceId, spanId, expiresAt: spanDoc.expiresAt };
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// 10. obsHealthProbe — onRequest (public)
//     Lightweight health-check for load balancers and uptime monitors.
//     Always returns 200. Never reveals internal error details.
// ─────────────────────────────────────────────────────────────────────────────

const obsHealthProbe = onRequest(
  { region: REGION, maxInstances: 10 },
  async (req, res) => {
    // CORS: allow uptime monitors from any origin
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate');

    if (req.method === 'OPTIONS') {
      res.status(204).send('');
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.status(405).json({ status: 'error', message: 'Method not allowed.' });
      return;
    }

    // Optional deep-probe: attempt a lightweight Firestore read
    let firestoreOk = true;
    let firestoreLatencyMs = null;
    if (req.query.deep === 'true') {
      try {
        const t0 = Date.now();
        await db().collection('_sokoniHealth').doc('probe').get();
        firestoreLatencyMs = Date.now() - t0;
      } catch {
        firestoreOk = false;
      }
    }

    const payload = {
      status             : 'healthy',
      timestamp          : new Date().toISOString(),
      region             : REGION,
      version            : VERSION,
      ...(req.query.deep === 'true' ? {
        firestore: { ok: firestoreOk, latencyMs: firestoreLatencyMs },
      } : {}),
    };

    res.status(200).json(payload);
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  obsIngestTelemetry,
  obsGetErrorReport,
  obsGetPerformanceReport,
  obsGetRealTimeMetrics,
  obsScheduledAggregation,
  obsGetAuditLog,
  obsCreateAlert,
  obsCheckAlerts,
  obsDistributedTrace,
  obsHealthProbe,
};
