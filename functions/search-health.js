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
 * Response codes — driven by CUSTOMER IMPACT, not by a roll-up of every backend:
 *  200  customer search is healthy (a REQUIRED engine is serving). An optional
 *       backend may still be down — see `redundancy` and `engines[].required`.
 *  206  degraded — a required engine is down but another can serve, or the
 *       indexing queue for a required engine is above the warning threshold.
 *  503  down — no engine can serve customer search.
 *
 * `status` answers "can a customer search right now?". `redundancy` answers
 * "are the secondary backends healthy?". Collapsing the two made the endpoint
 * report the whole subsystem as degraded while customer search was fine — an
 * alert that overstates impact gets muted, which is worse than no alert.
 *
 * Never calls another Cloud Function — all reads are direct Firestore or raw HTTPS.
 */

'use strict';

const { onRequest }  = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const admin          = require('firebase-admin');
/* firebase-admin has no .logger export — logger.* threw
   'Cannot read properties of undefined' on every call. */
const logger = require('firebase-functions/logger');
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
      /* Keep the error CODE, not just the message — the code is what
         distinguishes a dead hostname (ENOTFOUND) from a refused connection
         (ECONNREFUSED) from a TLS rejection. The message alone loses that. */
      resolve({
        ok: false, statusCode: 0, latencyMs: Date.now() - start,
        error: err.message, errorCode: err.code || null, errorObj: err,
      });
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

/* ══════════════════════════════════════════════════════════════════════
   FAILURE TAXONOMY

   A health check that collapses every failure into one message costs an
   operator a full investigation to learn something the probe already knew.
   Concretely: Typesense reported `missing_config` while the real fault was a
   cluster hostname that no longer resolves — two different problems, two
   different owners, one indistinguishable message.

   Each code below names the LAYER that failed, so the report says where to
   look rather than merely that something is wrong.
══════════════════════════════════════════════════════════════════════ */
const FAIL = {
  CONFIG_MISSING:   'CONFIG_MISSING',    // we never had enough config to try
  DNS_FAILURE:      'DNS_FAILURE',       // hostname does not resolve
  CONNECT_FAILURE:  'CONNECT_FAILURE',   // resolved, but TCP refused/unreachable
  TLS_FAILURE:      'TLS_FAILURE',       // connected, TLS handshake rejected
  TIMEOUT:          'TIMEOUT',           // no answer within budget
  AUTH_FAILURE:     'AUTH_FAILURE',      // reached it; credentials rejected
  COLLECTION_ERROR: 'COLLECTION_ERROR',  // authenticated; index/collection missing
  HTTP_ERROR:       'HTTP_ERROR',        // reachable, unexpected status
  HEALTHY:          'HEALTHY',
};

/**
 * Map a Node socket/DNS/TLS error to the layer that actually failed.
 * Node reports these as error codes on the request; anything unrecognised is
 * returned as CONNECT_FAILURE rather than guessed at.
 */
function _classifyTransportError(err) {
  const code = (err && (err.code || err.errno)) || '';
  const msg  = String((err && err.message) || err || '');

  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || /getaddrinfo/i.test(msg)) {
    return FAIL.DNS_FAILURE;
  }
  if (/CERT|SSL|TLS|DEPTH_ZERO|SELF_SIGNED|ERR_TLS/i.test(code) || /certificate|SSL|TLS/i.test(msg)) {
    return FAIL.TLS_FAILURE;
  }
  if (code === 'ECONNREFUSED' || code === 'EHOSTUNREACH' || code === 'ENETUNREACH' || code === 'ECONNRESET') {
    return FAIL.CONNECT_FAILURE;
  }
  if (code === 'ETIMEDOUT' || msg === 'timeout') return FAIL.TIMEOUT;
  return FAIL.CONNECT_FAILURE;
}

/**
 * Map an HTTP status from a reached endpoint to the layer that failed.
 * A 401/403 proves DNS, TCP and TLS all succeeded — the fault is credentials,
 * which is a different owner from a dead host.
 */
function _classifyHttpStatus(status) {
  if (status >= 200 && status < 300) return FAIL.HEALTHY;
  if (status === 401 || status === 403) return FAIL.AUTH_FAILURE;
  if (status === 404) return FAIL.COLLECTION_ERROR;
  return FAIL.HTTP_ERROR;
}

/** Build the per-engine result in one shape, whatever the outcome. */
function _result(raw) {
  if (raw.error && raw.statusCode === 0) {
    const code = raw.error === 'timeout'
      ? FAIL.TIMEOUT
      : _classifyTransportError(raw.errorObj || { code: raw.errorCode, message: raw.error });
    return {
      status:     'down',
      failure:    code,
      statusCode: 0,
      latencyMs:  raw.latencyMs || 0,
      error:      raw.error,
    };
  }
  const code = _classifyHttpStatus(raw.statusCode);
  return {
    status:     code === FAIL.HEALTHY ? 'ok' : 'down',
    failure:    code,
    statusCode: raw.statusCode,
    latencyMs:  raw.latencyMs || 0,
    error:      code === FAIL.HEALTHY ? null : raw.error || null,
  };
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
    return {
      status: 'down', failure: FAIL.CONFIG_MISSING, statusCode: 0, latencyMs: 0,
      error: 'missing_config',
      detail: !config.appId ? 'appId absent from searchConfig/engines'
                            : 'algoliaSearchKey absent from searchConfig/engines',
    };
  }
  const raw = await _withTimeout(
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
  return _result(raw);
}

/**
 * Ping Typesense /health endpoint.
 *
 * @param {Object} config - { typesenseHost, typesensePort, typesenseProtocol }
 * @returns {Promise<{ok, statusCode, latencyMs, error?}>}
 */
async function _pingTypesense(config) {
  /* Fall back to TYPESENSE_NODES ("host:port:protocol"), which is where the
     host actually lives in this deployment. Reading only the Firestore config
     made the probe report CONFIG_MISSING while a perfectly well-specified —
     but dead — host sat in the environment, hiding the real fault. */
  let host     = config.typesenseHost;
  let port     = config.typesensePort;
  let protocol = config.typesenseProtocol;

  if (!host && process.env.TYPESENSE_NODES) {
    const [h, p, proto] = String(process.env.TYPESENSE_NODES).split(':');
    host = h; port = Number(p) || undefined; protocol = proto || undefined;
  }
  if (!host && process.env.TYPESENSE_HOST) host = process.env.TYPESENSE_HOST;

  if (!host) {
    return {
      status: 'down', failure: FAIL.CONFIG_MISSING, statusCode: 0, latencyMs: 0,
      error: 'missing_config',
      detail: 'no typesenseHost in searchConfig/engines and no TYPESENSE_NODES/TYPESENSE_HOST in env',
    };
  }

  const useHttps  = (protocol || 'https') === 'https';
  const resolved  = port || (useHttps ? 443 : 8108);
  const transport = useHttps ? https : http;

  // Typesense /health is unauthenticated — no API key required
  const raw = await _withTimeout(
    _rawGet(transport, { hostname: host, port: resolved, path: '/health', method: 'GET' }),
    PING_TIMEOUT_MS
  );
  const out = _result(raw);
  out.host = host;   /* name the host in the report — the fault is often the host itself */
  return out;
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
      logger.error('searchHealth: failed to read searchConfig/engines', { error: err.message });
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

    /* ── 4. Determine statuses ──────────────────────────────────────────────
       The probes now return a classified {status, failure} rather than a bare
       `ok` boolean, so read that directly. */
    const algoliaStatus   = algoliaPing.status;
    const typesenseStatus = typesensePing.status;

    const algoliaQueueWarn   = algoliaQueueDepth   > QUEUE_WARN_THRESHOLD;
    const typesenseQueueWarn = typesenseQueueDepth > QUEUE_WARN_THRESHOLD;

    /* ── Optional vs required backends ──────────────────────────────────────
       `status` answers ONE question: can a customer search right now? It must
       therefore be driven by the engine that actually serves traffic.

       Algolia is authoritative. Typesense is a secondary backend held for
       redundancy — no production feature requires it to succeed. Folding its
       state into the headline meant the endpoint reported the whole search
       subsystem as `degraded` while customer search was entirely healthy. That
       overstates impact, and an alert that cries wolf gets muted, which is
       worse than no alert.

       Secondary state is not hidden — it is reported under `redundancy`, with
       full per-engine detail below. Operators keep the visibility; the headline
       stops lying about customer impact. */
    const ENGINE_REQUIRED = { algolia: true, typesense: false };

    const requiredDown = (ENGINE_REQUIRED.algolia   && algoliaStatus   === 'down')
                      || (ENGINE_REQUIRED.typesense && typesenseStatus === 'down');
    const anyEngineUp  = algoliaStatus === 'ok' || typesenseStatus === 'ok';
    const requiredQueueWarn = (ENGINE_REQUIRED.algolia   && algoliaQueueWarn)
                           || (ENGINE_REQUIRED.typesense && typesenseQueueWarn);

    let overallStatus;
    if (requiredDown && !anyEngineUp)      overallStatus = 'down';      /* nothing can serve */
    else if (requiredDown)                 overallStatus = 'degraded';  /* primary down, secondary serving */
    else if (requiredQueueWarn)            overallStatus = 'degraded';  /* serving, but indexing lags */
    else                                   overallStatus = 'ok';        /* customer search healthy */

    /* Redundancy: the state of optional backends, reported separately. */
    const optionalDown = (!ENGINE_REQUIRED.typesense && typesenseStatus === 'down')
                      || (!ENGINE_REQUIRED.algolia   && algoliaStatus   === 'down');
    const redundancyStatus = optionalDown ? 'degraded' : 'ok';

    /* ── 5. Build response payload ────────────────────────────────────────── */
    const payload = {
      /* Customer-facing search status — NOT a roll-up of every backend. */
      status: overallStatus,
      /* Optional/secondary backends, reported without inflating `status`. */
      redundancy: redundancyStatus,
      engines: {
        algolia: {
          required:   ENGINE_REQUIRED.algolia,
          status:     algoliaStatus,
          failure:    algoliaPing.failure,      /* which LAYER failed */
          latencyMs:  algoliaPing.latencyMs,
          statusCode: algoliaPing.statusCode,
          error:      algoliaPing.error || null,
          detail:     algoliaPing.detail || null,
        },
        typesense: {
          required:   ENGINE_REQUIRED.typesense,
          status:     typesenseStatus,
          failure:    typesensePing.failure,
          latencyMs:  typesensePing.latencyMs,
          statusCode: typesensePing.statusCode,
          error:      typesensePing.error || null,
          detail:     typesensePing.detail || null,
          host:       typesensePing.host || null,
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

    logger.info('searchHealth', {
      overallStatus,
      algoliaStatus,
      typesenseStatus,
      algoliaLatencyMs:   algoliaPing.latencyMs,
      typesenseLatencyMs: typesensePing.latencyMs,
    });

    res.status(httpCode).json(payload);
  }
);
