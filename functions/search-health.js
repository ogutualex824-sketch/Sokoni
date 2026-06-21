/**
 * SOKONI Search Health — Unified HTTP Health Endpoint
 *
 * A single HTTP GET endpoint (`searchHealth`) consumed by:
 *  - Uptime monitors (UptimeRobot, Checkly, etc.)
 *  - Load balancers / k8s readiness probes
 *  - Admin dashboards requiring a quick platform pulse
 *
 * What it checks (in parallel, 4-second timeout per engine):
 *  1. Algolia  — GET /1/indexes (search-only API key, proves the index is reachable)
 *  2. Typesense — GET /health   (cluster health endpoint)
 *  3. Queue depths — pending counts in `algoliaQueue` and `typesenseQueue`
 *  4. Last successful sync timestamp from `searchConfig/lastSync`
 *
 * Response codes:
 *  200  all engines healthy
 *  206  degraded (one engine down, or queues above warning threshold)
 *  503  both engines down
 *
 * Never calls another Cloud Function — all reads are direct Firestore or raw HTTPS.
 */

'use strict';

const { onRequest }  = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const admin          = require('firebase-admin');
const https          = require('https');
const http           = require('http');

if (!admin.apps.length) admin.initializeApp();

/* ── Secrets ──────────────────────────────────────────────────────────────── */

const ALGOLIA_ADMIN_KEY   = defineSecret('ALGOLIA_ADMIN_KEY');
const TYPESENSE_ADMIN_KEY = defineSecret('TYPESENSE_ADMIN_KEY');

/* ── Constants ────────────────────────────────────────────────────────────── */

/** Queue depth beyond which status becomes 'degraded' even if engines are up */
const QUEUE_WARN_THRESHOLD = 5_000;

/** Per-engine ping hard timeout in ms */
const PING_TIMEOUT_MS = 4_000;

/* ── Helpers ──────────────────────────────────────────────────────────────── */

function _db() { return admin.firestore(); }

/**
 * Fire a raw HTTP/HTTPS GET using the specified transport module.
 * Resolves with { ok, statusCode, latencyMs, error? }.
 * Never rejects — network errors and timeouts are surfaced as ok: false.
 *
 * @param {typeof https | typeof http} transport - Node https or http module
 * @param {Object} opts - Node request options
 */
function _rawGet(transport, opts) {
  return new Promise((resolve) => {
    const start = Date.now();
    const req   = transport.request(opts, (res) => {
      // Drain the response so the socket is released promptly
      res.resume();
      res.on('end', () => {
        resolve({
          ok:         res.statusCode >= 200 && res.statusCode < 300,
          statusCode: res.statusCode,
          latencyMs:  Date.now() - start,
        });
      });
    });
    req.on('error', (err) => {
      resolve({ ok: false, statusCode: 0, latencyMs: Date.now() - start, error: err.message });
    });
    req.setTimeout(PING_TIMEOUT_MS, () => {
      req.destroy();
      resolve({ ok: false, statusCode: 0, latencyMs: PING_TIMEOUT_MS, error: 'timeout' });
    });
    req.end();
  });
}

/** Convenience wrapper — always uses HTTPS transport */
function _httpsGet(opts) {
  return _rawGet(https, opts);
}

/**
 * Race an async operation against a timeout.
 *
 * @param {Promise<any>} promise
 * @param {number} ms
 * @returns {Promise<any>}
 */
function _withTimeout(promise, ms) {
  const timeout = new Promise((resolve) =>
    setTimeout(() => resolve({ ok: false, statusCode: 0, latencyMs: ms, error: 'timeout' }), ms)
  );
  return Promise.race([promise, timeout]);
}

/**
 * Ping Algolia /1/indexes using the search-only API key stored in Firestore config.
 * We use the search-only key (not the admin key secret) because:
 *  - Health checks should use the lowest-privilege path
 *  - The search key is non-sensitive and stored in Firestore config
 *
 * @param {Object} config - { appId, algoliaSearchKey }
 * @returns {Promise<{ok, statusCode, latencyMs, error?}>}
 */
async function _pingAlgolia(config) {
  if (!config.appId || !config.algoliaSearchKey) {
    return { ok: false, statusCode: 0, latencyMs: 0, error: 'missing_config' };
  }
  return _withTimeout(
    _httpsGet({
      hostname: `${config.appId}-dsn.algolia.net`,
      path:     '/1/indexes',
      method:   'GET',
      headers:  {
        'X-Algolia-Application-Id': config.appId,
        'X-Algolia-API-Key':        config.algoliaSearchKey,
      },
    }),
    PING_TIMEOUT_MS
  );
}

/**
 * Ping Typesense /health endpoint.
 *
 * @param {Object} config - { typesenseHost, typesensePort, typesenseProtocol }
 * @returns {Promise<{ok, statusCode, latencyMs, error?}>}
 */
async function _pingTypesense(config) {
  if (!config.typesenseHost) {
    return { ok: false, statusCode: 0, latencyMs: 0, error: 'missing_config' };
  }
  const useHttps  = (config.typesenseProtocol || 'https') === 'https';
  const port      = config.typesensePort || (useHttps ? 443 : 8108);
  const transport = useHttps ? https : http;

  // Typesense /health is unauthenticated — no API key required
  return _withTimeout(
    _rawGet(transport, {
      hostname: config.typesenseHost,
      port,
      path:     '/health',
      method:   'GET',
    }),
    PING_TIMEOUT_MS
  );
}

/**
 * Count documents with `status == 'pending'` in a queue collection.
 * Uses COUNT aggregation to avoid reading all documents.
 *
 * @param {string} collectionName
 * @returns {Promise<number>}
 */
async function _queueDepth(collectionName) {
  try {
    const snap = await _db()
      .collection(collectionName)
      .where('status', '==', 'pending')
      .count()
      .get();
    return snap.data().count;
  } catch (_) {
    return -1; // unavailable
  }
}

/* ── Cloud Function ───────────────────────────────────────────────────────── */

/**
 * searchHealth — HTTP GET health endpoint.
 *
 * Returns a combined health status for both search engines.
 */
exports.searchHealth = onRequest(
  {
    region:         'us-central1',
    memory:         '256MiB',
    timeoutSeconds: 10,
    secrets:        [ALGOLIA_ADMIN_KEY, TYPESENSE_ADMIN_KEY],
    cors:           false,
    invoker:        'public', // uptime monitors do not have auth tokens
  },
  async (req, res) => {
    // Only allow GET
    if (req.method !== 'GET') {
      res.status(405).json({ error: 'Method not allowed' });
      return;
    }

    const checkedAt = new Date().toISOString();

    /* ── 1. Read engine config from Firestore ─────────────────────────────── */
    let engineConfig = {};
    try {
      const snap = await _db().doc('searchConfig/engines').get();
      engineConfig = snap.exists ? snap.data() : {};
    } catch (err) {
      admin.logger.error('searchHealth: failed to read searchConfig/engines', { error: err.message });
    }

    /* ── 2. Read lastSync timestamp ───────────────────────────────────────── */
    let lastSync = null;
    try {
      const snap = await _db().doc('searchConfig/lastSync').get();
      if (snap.exists) {
        const d = snap.data();
        lastSync = {
          algolia:   d.algolia   ? d.algolia.toDate().toISOString()   : null,
          typesense: d.typesense ? d.typesense.toDate().toISOString() : null,
        };
      }
    } catch (_) { /* non-critical */ }

    /* ── 3. Fire all checks in parallel ──────────────────────────────────── */
    const [
      algoliaPing,
      typesensePing,
      algoliaQueueDepth,
      typesenseQueueDepth,
    ] = await Promise.all([
      _pingAlgolia(engineConfig),
      _pingTypesense(engineConfig),
      _queueDepth('algoliaQueue'),
      _queueDepth('typesenseQueue'),
    ]);

    /* ── 4. Determine statuses ────────────────────────────────────────────── */
    const algoliaStatus   = algoliaPing.ok   ? 'ok' : 'down';
    const typesenseStatus = typesensePing.ok ? 'ok' : 'down';

    const algoliaQueueWarn   = algoliaQueueDepth   > QUEUE_WARN_THRESHOLD;
    const typesenseQueueWarn = typesenseQueueDepth > QUEUE_WARN_THRESHOLD;

    let overallStatus;
    if (algoliaStatus === 'down' && typesenseStatus === 'down') {
      overallStatus = 'down';
    } else if (algoliaStatus === 'down' || typesenseStatus === 'down' || algoliaQueueWarn || typesenseQueueWarn) {
      overallStatus = 'degraded';
    } else {
      overallStatus = 'ok';
    }

    /* ── 5. Build response payload ────────────────────────────────────────── */
    const payload = {
      status: overallStatus,
      engines: {
        algolia: {
          status:     algoliaStatus,
          latencyMs:  algoliaPing.latencyMs,
          statusCode: algoliaPing.statusCode,
          error:      algoliaPing.error || null,
        },
        typesense: {
          status:     typesenseStatus,
          latencyMs:  typesensePing.latencyMs,
          statusCode: typesensePing.statusCode,
          error:      typesensePing.error || null,
        },
      },
      queues: {
        algolia: {
          pendingDepth: algoliaQueueDepth,
          warn:         algoliaQueueWarn,
        },
        typesense: {
          pendingDepth: typesenseQueueDepth,
          warn:         typesenseQueueWarn,
        },
      },
      lastSync: lastSync || { algolia: null, typesense: null },
      checkedAt,
    };

    /* ── 6. HTTP status code mapping ──────────────────────────────────────── */
    const httpCode =
      overallStatus === 'ok'       ? 200 :
      overallStatus === 'degraded' ? 206 : 503;

    admin.logger.info('searchHealth', {
      overallStatus,
      algoliaStatus,
      typesenseStatus,
      algoliaLatencyMs:   algoliaPing.latencyMs,
      typesenseLatencyMs: typesensePing.latencyMs,
    });

    res.status(httpCode).json(payload);
  }
);
