/**
 * SOKONI Search Admin — Unified Search Platform Control Plane
 *
 * Master admin interface over both Algolia and Typesense engines.
 * All operations require Firebase custom claim `admin: true`.
 *
 * Exports:
 *   searchSetup          — provision both engines from scratch
 *   searchBackfillAll    — full Firestore → both engines backfill
 *   searchSystemReport   — comprehensive health + metrics report
 *   searchGetSecuredKeys — user-scoped API keys for both engines
 *   searchConfigUpdate   — update platform-level search settings
 *   searchGetStats       — combined queue + index statistics
 *
 * Architecture notes:
 *   - Does NOT call other callable CFs — uses imported modules directly
 *   - Every mutation is journalled to adminAuditLogs
 *   - Algolia setup delegates to AlgoliaClient + INDEX_SETTINGS
 *   - Typesense setup delegates to TypesenseClient + COLLECTION_SCHEMAS
 *   - Secured keys delegate to the HMAC generators in respective modules
 *
 * @module search-admin
 */

'use strict';

const https = require('https');
const http  = require('http');

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret }       = require('firebase-functions/params');
const admin                  = require('firebase-admin');
/* firebase-admin has no .logger export — logger.* threw
   'Cannot read properties of undefined' on every call. */
const logger = require('firebase-functions/logger');

if (!admin.apps.length) admin.initializeApp();
const db = admin.firestore();

/* ── Secrets ──────────────────────────────────────────────────────────────── */

const ALGOLIA_ADMIN_KEY    = defineSecret('ALGOLIA_ADMIN_KEY');
const ALGOLIA_SEARCH_KEY   = defineSecret('ALGOLIA_SEARCH_KEY');
const TYPESENSE_ADMIN_KEY  = defineSecret('TYPESENSE_ADMIN_KEY');
const TYPESENSE_SEARCH_KEY = defineSecret('TYPESENSE_SEARCH_KEY');

/* ── Shared CF options ───────────────────────────────────────────────────── */

const CF_OPTS = { region: 'us-central1', memory: '512MiB', timeoutSeconds: 300 };

/* ── Auth guards ─────────────────────────────────────────────────────────── */

/**
 * Asserts the caller holds admin custom claim.
 * @param {object} req - Firebase callable request object
 * @returns {string} Caller UID
 * @throws {HttpsError} permission-denied if not admin
 */
function _assertAdmin(req) {
  if (!req.auth?.token?.admin) throw new HttpsError('permission-denied', 'Admin required');
  return req.auth.uid;
}

/**
 * Asserts the caller is authenticated (any role).
 * @param {object} req - Firebase callable request object
 * @returns {string} Caller UID
 * @throws {HttpsError} unauthenticated if no session
 */
function _assertAuth(req) {
  if (!req.auth?.uid) throw new HttpsError('unauthenticated', 'Authentication required');
  return req.auth.uid;
}

/* ── Helpers ──────────────────────────────────────────────────────────────── */

const _now = () => admin.firestore.FieldValue.serverTimestamp();

/**
 * Lazy-loads AlgoliaClient to avoid secret access at module init time.
 * @param {string} adminKey - ALGOLIA_ADMIN_KEY secret value
 * @returns {AlgoliaClient}
 */
function _algoliaClient(adminKey) {
  const appId = process.env.ALGOLIA_APP_ID;
  if (!appId || !adminKey || adminKey === 'not_configured') {
    throw new HttpsError('failed-precondition', 'Algolia not configured (missing ALGOLIA_APP_ID or ALGOLIA_ADMIN_KEY).');
  }
  const { AlgoliaClient } = require('./algolia-indexer');
  return new AlgoliaClient(appId, adminKey);
}

/**
 * Builds a Typesense client from env-configured node list.
 * @param {string} adminKey - TYPESENSE_ADMIN_KEY secret value
 * @returns {TypesenseClient}
 */
function _typesenseClient(adminKey) {
  if (!adminKey || adminKey === 'not_configured') {
    throw new HttpsError('failed-precondition', 'Typesense not configured (missing TYPESENSE_ADMIN_KEY).');
  }
  const { TypesenseClient } = require('./typesense-client');
  const nodes = (process.env.TYPESENSE_NODES || `${process.env.TYPESENSE_HOST || 'localhost'}:${process.env.TYPESENSE_PORT || '443'}:https`)
    .split(',').map(s => s.trim()).filter(Boolean);
  return new TypesenseClient(nodes, adminKey, { timeoutMs: 20_000, maxRetries: 3 });
}

/**
 * Simple HTTPS POST/GET helper for search engine REST APIs.
 * @param {string} url
 * @param {'GET'|'POST'|'PUT'|'DELETE'} method
 * @param {object} headers
 * @param {object|null} body
 * @param {number} [timeoutMs=5000]
 * @returns {Promise<{status: number, body: object}>}
 */
function _httpsRequest(url, method, headers, body, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const parsed  = new URL(url);
    const payload = body ? JSON.stringify(body) : null;
    const lib     = parsed.protocol === 'https:' ? https : http;
    const opts = {
      hostname: parsed.hostname,
      port:     parsed.port || 443,
      path:     parsed.pathname + parsed.search,
      method,
      headers: {
        'Content-Type':   'application/json',
        'User-Agent':     'SOKONI-SearchAdmin/1.0',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
        ...headers,
      },
    };
    const req = lib.request(opts, res => {
      let raw = '';
      res.on('data', c => { raw += c; });
      res.on('end', () => {
        let parsed_body;
        try { parsed_body = JSON.parse(raw); } catch (_) { parsed_body = { raw }; }
        resolve({ status: res.statusCode, body: parsed_body });
      });
    });
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('Request timeout')); });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/**
 * Write an entry to the adminAuditLogs collection (non-blocking).
 * @param {string} action
 * @param {string} uid
 * @param {object} metadata
 */
function _audit(action, uid, metadata = {}) {
  db.collection('adminAuditLogs').add({
    action,
    by:        uid,
    category:  'search',
    ...metadata,
    createdAt: _now(),
  }).catch(err => logger.warn('[SearchAdmin] Audit write failed', { action, error: err.message }));
}

/* ══════════════════════════════════════════════════════════════════════════════
   1. searchSetup — provision both engines from scratch
══════════════════════════════════════════════════════════════════════════════ */

/**
 * Provisions all Algolia indexes (settings, replicas, synonyms, rules) and all
 * Typesense collections from scratch. Safe to re-run — updates existing config.
 *
 * Steps:
 *   1. Mark setup as in-progress in searchConfig/setup
 *   2. Apply INDEX_SETTINGS (including virtual replicas) to Algolia
 *   3. Apply GLOBAL_SYNONYMS to commerce indexes in Algolia
 *   4. Apply INDEX_RULES to Algolia
 *   5. Create / update all Typesense collections from COLLECTION_SCHEMAS
 *   6. Mark setup complete and return structured results
 *
 * @type {import('firebase-functions/v2/https').CallableFunction}
 */
exports.searchSetup = onCall(
  {
    ...CF_OPTS,
    timeoutSeconds: 540,
    memory:         '1GiB',
    secrets:        [ALGOLIA_ADMIN_KEY, TYPESENSE_ADMIN_KEY],
  },
  async (req) => {
    const uid = _assertAdmin(req);
    const startMs = Date.now();

    /* Mark setup started */
    await db.doc('searchConfig/setup').set({
      requestedAt:      _now(),
      requestedBy:      uid,
      algoliaStatus:    'pending',
      typesenseStatus:  'pending',
      phase:            'setting_up',
    }, { merge: true });

    /* ── Algolia setup ──────────────────────────────────────────────── */
    let algoliaResult = { status: 'error', error: null, indexesConfigured: 0, virtualReplicas: 0, synonymSets: 0, ruleSets: 0 };

    try {
      const algolia  = _algoliaClient(ALGOLIA_ADMIN_KEY.value());
      const {
        INDEX_SETTINGS,
        GLOBAL_SYNONYMS,
        INDEX_RULES,
      } = require('./algolia-admin');

      const _COMMON_SEARCH_SETTINGS = {
        removeWordsIfNoResults:            'allOptional',
        advancedSyntax:                    true,
        queryLanguages:                    ['en'],
        indexLanguages:                    ['en'],
        ignorePlurals:                     true,
        removeStopWords:                   ['en'],
        maxValuesPerFacet:                 100,
        maxFacetHits:                      20,
        paginationLimitedTo:               1000,
        allowCompressionOfIntegerArray:    true,
        restrictHighlightAndSnippetArrays: true,
        keepDiacriticsOnCharacters:        'àâäèêëîïôùûüÿ',
      };

      const PRIMARY_INDEXES = new Set([
        'sokoni_products', 'sokoni_shops', 'sokoni_services', 'sokoni_events',
        'sokoni_properties', 'sokoni_vehicles', 'sokoni_jobs', 'sokoni_users',
        'sokoni_categories', 'sokoni_brands', 'sokoni_collections', 'sokoni_coupons',
      ]);

      const indexResults = {};
      let primaryCount   = 0;
      let replicaCount   = 0;

      /* Apply primary index settings first */
      for (const [key, settings] of Object.entries(INDEX_SETTINGS)) {
        if (key.startsWith('_vr_')) continue;
        const effective = PRIMARY_INDEXES.has(key)
          ? Object.assign({}, _COMMON_SEARCH_SETTINGS, settings)
          : settings;
        try {
          const res = await algolia.setIndexSettings(key, effective);
          indexResults[key] = { ok: true, taskID: res.taskID };
          primaryCount++;
        } catch (err) {
          indexResults[key] = { ok: false, error: err.message };
          logger.error('[SearchSetup] Algolia index config failed', { index: key, error: err.message });
        }
      }

      /* Apply virtual replica settings */
      for (const [key, settings] of Object.entries(INDEX_SETTINGS)) {
        if (!key.startsWith('_vr_')) continue;
        const replicaIndex = key.slice(4); /* strip '_vr_' */
        try {
          const res = await algolia.setIndexSettings(replicaIndex, settings);
          indexResults[replicaIndex] = { ok: true, taskID: res.taskID, isVirtualReplica: true };
          replicaCount++;
        } catch (err) {
          indexResults[replicaIndex] = { ok: false, error: err.message, isVirtualReplica: true };
          logger.error('[SearchSetup] Algolia replica config failed', { index: replicaIndex, error: err.message });
        }
      }

      /* Apply synonyms to commerce indexes */
      const synonymIndexes = ['sokoni_products', 'sokoni_shops', 'sokoni_services', 'sokoni_events', 'sokoni_jobs'];
      let synonymSets = 0;
      for (const idx of synonymIndexes) {
        try {
          await algolia.saveSynonyms(idx, GLOBAL_SYNONYMS, true);
          synonymSets++;
        } catch (err) {
          logger.warn('[SearchSetup] Algolia synonym upload failed', { index: idx, error: err.message });
        }
      }

      /* Apply merchandising rules */
      let ruleSets = 0;
      for (const [indexName, rules] of Object.entries(INDEX_RULES)) {
        try {
          await algolia.saveRules(indexName, rules, true);
          ruleSets++;
        } catch (err) {
          logger.warn('[SearchSetup] Algolia rule upload failed', { index: indexName, error: err.message });
        }
      }

      algoliaResult = {
        status:           'ok',
        indexesConfigured: primaryCount,
        virtualReplicas:  replicaCount,
        synonymSets,
        ruleSets,
        detail:           indexResults,
      };

      await db.doc('searchConfig/setup').update({ algoliaStatus: 'complete' });
    } catch (err) {
      algoliaResult.error = err.message;
      logger.error('[SearchSetup] Algolia setup failed', { error: err.message });
      await db.doc('searchConfig/setup').update({ algoliaStatus: 'error', algoliaError: err.message }).catch(() => {});
    }

    /* ── Typesense setup ────────────────────────────────────────────── */
    let typesenseResult = { status: 'error', error: null, collectionsCreated: 0, collectionsUpdated: 0 };

    try {
      const ts = _typesenseClient(TYPESENSE_ADMIN_KEY.value());
      const { COLLECTION_SCHEMAS } = require('./typesense-client');

      let created = 0;
      let updated = 0;

      for (const [name, schema] of Object.entries(COLLECTION_SCHEMAS)) {
        try {
          const exists = await ts.collectionExists(name);
          if (exists) {
            /* Patch fields only — avoids downtime */
            const fieldsToAdd = schema.fields.filter(f => f.name !== 'id');
            await ts.updateCollectionFields(name, fieldsToAdd);
            updated++;
          } else {
            await ts.createCollection(schema);
            created++;
          }
        } catch (err) {
          /* Log but do not abort — partial success is still useful */
          logger.warn('[SearchSetup] Typesense collection error', { collection: name, error: err.message });
        }
      }

      typesenseResult = { status: 'ok', collectionsCreated: created, collectionsUpdated: updated };
      await db.doc('searchConfig/setup').update({ typesenseStatus: 'complete' });
    } catch (err) {
      typesenseResult.error = err.message;
      logger.error('[SearchSetup] Typesense setup failed', { error: err.message });
      await db.doc('searchConfig/setup').update({ typesenseStatus: 'error', typesenseError: err.message }).catch(() => {});
    }

    const completedAt = new Date().toISOString();
    const durationMs  = Date.now() - startMs;

    await db.doc('searchConfig/setup').update({ phase: 'complete', completedAt: _now() }).catch(() => {});

    _audit('search_setup', uid, { algoliaStatus: algoliaResult.status, typesenseStatus: typesenseResult.status, durationMs });

    logger.info('[SearchSetup] Complete', { algoliaResult, typesenseResult, durationMs });

    return {
      ok:          algoliaResult.status === 'ok' && typesenseResult.status === 'ok',
      algolia:     algoliaResult,
      typesense:   typesenseResult,
      completedAt,
      durationMs,
    };
  }
);

/* ══════════════════════════════════════════════════════════════════════════════
   2. searchBackfillAll — full Firestore → both engines backfill
══════════════════════════════════════════════════════════════════════════════ */

/**
 * Triggers a full re-index of ALL registered collections into both search engines
 * by writing items in batches of 500 to the respective queue collections.
 *
 * Uses COLLECTION_REGISTRY as the source of truth for which collections
 * to index and which engines they target. Collections with engine:'none' are
 * skipped. Applies the same skip-guard as algolia-queue.js (_shouldSkip).
 *
 * @type {import('firebase-functions/v2/https').CallableFunction}
 */
exports.searchBackfillAll = onCall(
  {
    ...CF_OPTS,
    timeoutSeconds: 540,
    memory:         '1GiB',
    secrets:        [ALGOLIA_ADMIN_KEY, TYPESENSE_ADMIN_KEY],
  },
  async (req) => {
    const uid    = _assertAdmin(req);
    const startMs = Date.now();
    const { targetCollection } = req.data || {};

    const { COLLECTION_REGISTRY } = require('./search-sync');
    const { enqueue: algoliaEnqueue } = require('./algolia-queue');
    const { enqueue: typesenseEnqueue, PRIORITY } = require('./typesense-queue');

    const PAGE_SIZE = 500;
    const summary   = {};
    let   totalEnqueued = 0;

    const collectionsToProcess = targetCollection
      ? [targetCollection]
      : Object.keys(COLLECTION_REGISTRY);

    /* De-duplicate: multiple registry keys (e.g. deals + auctions) share an index
       but have distinct Firestore collections — process by firestoreCollection. */
    const seen = new Set();

    for (const key of collectionsToProcess) {
      const entry = COLLECTION_REGISTRY[key];
      if (!entry) {
        logger.warn('[SearchBackfill] Unknown collection key, skipping', { key });
        continue;
      }

      const fsCol = entry.firestoreCollection;
      if (seen.has(fsCol)) continue;
      seen.add(fsCol);

      /* Skip engine:none (e.g. orders registered for future use only) */
      if (entry.engine === 'none') {
        summary[fsCol] = { enqueued: 0, skipped: 0, reason: 'engine:none' };
        continue;
      }

      let enqueued = 0;
      let skipped  = 0;
      let lastDoc  = null;
      let hasMore  = true;

      try {
        while (hasMore) {
          let q = db.collection(fsCol).orderBy('__name__').limit(PAGE_SIZE);
          if (lastDoc) q = q.startAfter(lastDoc);

          const snap = await q.get();
          if (snap.empty) { hasMore = false; break; }

          const indexable = snap.docs.filter(doc => {
            const d = doc.data();
            if (!d || d._noIndex === true) return false;
            const status = d.status;
            if (status === 'draft' || status === 'deleted' || status === 'banned' ||
                status === 'spam'  || status === 'suspended' || status === 'archived' ||
                status === 'inactive') return false;
            if (fsCol === 'users' && d.private === true) return false;
            return true;
          });

          skipped += (snap.docs.length - indexable.length);

          /* Enqueue to Algolia if applicable */
          if (entry.algoliaIndex && entry.engine !== 'typesense') {
            await Promise.allSettled(indexable.map(doc =>
              algoliaEnqueue({
                collection: fsCol,
                docId:      doc.id,
                operation:  'upsert',
                data:       doc.data(),
              })
            ));
          }

          /* Enqueue to Typesense if applicable */
          if (entry.typesenseCollection && entry.engine !== 'algolia') {
            await Promise.allSettled(indexable.map(doc =>
              typesenseEnqueue({
                collection: fsCol,
                docId:      doc.id,
                operation:  'upsert',
                data:       doc.data(),
                priority:   entry.priority,
              })
            ));
          }

          enqueued += indexable.length;
          lastDoc   = snap.docs[snap.docs.length - 1];
          if (snap.size < PAGE_SIZE) hasMore = false;
        }
      } catch (err) {
        logger.error('[SearchBackfill] Collection error', { collection: fsCol, error: err.message });
        summary[fsCol] = { enqueued, skipped, error: err.message };
        continue;
      }

      totalEnqueued     += enqueued;
      summary[fsCol]     = { enqueued, skipped, algoliaIndex: entry.algoliaIndex, typesenseCollection: entry.typesenseCollection };

      logger.info('[SearchBackfill] Collection queued', { collection: fsCol, enqueued, skipped });
    }

    const durationMs = Date.now() - startMs;

    _audit('search_backfill_all', uid, { totalEnqueued, collectionsProcessed: Object.keys(summary).length, durationMs, targetCollection: targetCollection || 'all' });

    return { ok: true, totalEnqueued, byCollection: summary, durationMs };
  }
);

/* ══════════════════════════════════════════════════════════════════════════════
   3. searchSystemReport — comprehensive health + metrics report
══════════════════════════════════════════════════════════════════════════════ */

/**
 * Generates a full diagnostic report of the search platform:
 *   - Algolia index health (record counts, pending tasks, queue depth)
 *   - Typesense node health and collection counts
 *   - Queue depths (pending / failed / DLQ) for both engines
 *   - Sync lag per collection (time since last successful sync event)
 *   - Recent search-category admin alerts
 *   - Platform config (primary engine, feature flags)
 *
 * @type {import('firebase-functions/v2/https').CallableFunction}
 */
exports.searchSystemReport = onCall(
  {
    ...CF_OPTS,
    timeoutSeconds: 60,
    secrets:        [ALGOLIA_ADMIN_KEY, TYPESENSE_ADMIN_KEY],
  },
  async (req) => {
    _assertAdmin(req);
    const startMs = Date.now();

    /* ── Algolia index health ──────────────────────────────────────── */
    const algoliaIndexes = {};
    try {
      const algolia = _algoliaClient(ALGOLIA_ADMIN_KEY.value());
      const PRIMARY_INDEX_NAMES = [
        'sokoni_products', 'sokoni_shops', 'sokoni_services', 'sokoni_events',
        'sokoni_properties', 'sokoni_vehicles', 'sokoni_jobs', 'sokoni_users',
        'sokoni_categories', 'sokoni_brands', 'sokoni_collections', 'sokoni_coupons',
      ];
      const results = await Promise.allSettled(
        PRIMARY_INDEX_NAMES.map(async name => {
          const stats = await algolia.getIndexStats(name);
          return {
            index:         name,
            entries:       stats.entries        || 0,
            dataSize:      stats.dataSize        || 0,
            fileSize:      stats.fileSize        || 0,
            pendingTasks:  stats.toBeIndexedNb   || 0,
            lastBuildSecs: stats.lastBuildTimeS  || 0,
          };
        })
      );
      PRIMARY_INDEX_NAMES.forEach((name, i) => {
        const r = results[i];
        algoliaIndexes[name] = r.status === 'fulfilled'
          ? { ok: true,  ...r.value }
          : { ok: false, error: r.reason?.message };
      });
    } catch (err) {
      logger.warn('[SearchReport] Algolia health check failed', { error: err.message });
    }

    /* ── Algolia queue stats ──────────────────────────────────────── */
    const algoliaQueue = { pending: 0, failed: 0, dlq: 0 };
    try {
      const [pendingSnap, failedSnap, dlqSnap] = await Promise.all([
        db.collection('algoliaQueue').where('status', '==', 'pending').count().get(),
        db.collection('algoliaQueue').where('status', '==', 'failed').count().get(),
        db.collection('algoliaQueueDLQ').limit(1).count().get(),
      ]);
      algoliaQueue.pending = pendingSnap.data().count;
      algoliaQueue.failed  = failedSnap.data().count;
      algoliaQueue.dlq     = dlqSnap.data().count;
    } catch (err) {
      logger.warn('[SearchReport] Algolia queue count failed', { error: err.message });
    }

    /* ── Typesense node + collection health ───────────────────────── */
    const typesenseNodes       = [];
    const typesenseCollections = {};
    try {
      const ts = _typesenseClient(TYPESENSE_ADMIN_KEY.value());
      const [nodeStatuses, collections] = await Promise.all([
        ts.nodeStatuses(),
        ts.listCollections(),
      ]);
      nodeStatuses.forEach(n => typesenseNodes.push(n));
      if (Array.isArray(collections)) {
        collections.forEach(col => {
          typesenseCollections[col.name] = {
            numDocuments: col.num_documents || 0,
            fields:       col.fields?.length || 0,
          };
        });
      }
    } catch (err) {
      logger.warn('[SearchReport] Typesense health check failed', { error: err.message });
    }

    /* ── Typesense queue stats ────────────────────────────────────── */
    const typesenseQueue = { pending: 0, failed: 0, dlq: 0 };
    try {
      const [pendingSnap, failedSnap, dlqSnap] = await Promise.all([
        db.collection('typesenseQueue').where('status', '==', 'pending').count().get(),
        db.collection('typesenseQueue').where('status', '==', 'failed').count().get(),
        db.collection('typesenseQueueDLQ').limit(1).count().get(),
      ]);
      typesenseQueue.pending = pendingSnap.data().count;
      typesenseQueue.failed  = failedSnap.data().count;
      typesenseQueue.dlq     = dlqSnap.data().count;
    } catch (err) {
      logger.warn('[SearchReport] Typesense queue count failed', { error: err.message });
    }

    /* ── Sync lag per collection ──────────────────────────────────── */
    const syncLag = {};
    try {
      const snapshots = await db.collection('searchSyncStatus')
        .orderBy('lastSyncedAt', 'desc')
        .limit(50)
        .get();
      snapshots.forEach(doc => {
        const d = doc.data();
        const lag = d.lastSyncedAt ? (Date.now() - d.lastSyncedAt.toMillis()) : null;
        syncLag[doc.id] = {
          lastSyncedAt: d.lastSyncedAt?.toDate?.()?.toISOString() || null,
          lagMs:        lag,
          lagMinutes:   lag !== null ? Math.round(lag / 60000) : null,
          lastOp:       d.lastOp || null,
          errors:       d.errorCount || 0,
        };
      });
    } catch (err) {
      logger.warn('[SearchReport] Sync lag query failed', { error: err.message });
    }

    /* ── Recent search-category alerts ───────────────────────────── */
    const recentAlerts = [];
    try {
      const alertSnap = await db.collection('adminAlerts')
        .where('category', '==', 'search')
        .orderBy('createdAt', 'desc')
        .limit(20)
        .get();
      alertSnap.forEach(doc => {
        const d = doc.data();
        recentAlerts.push({
          id:        doc.id,
          severity:  d.severity || 'info',
          message:   d.message,
          createdAt: d.createdAt?.toDate?.()?.toISOString() || null,
          resolved:  d.resolved || false,
        });
      });
    } catch (err) {
      logger.warn('[SearchReport] Alert query failed', { error: err.message });
    }

    /* ── Platform config ──────────────────────────────────────────── */
    let searchConfig = {};
    try {
      const cfgSnap = await db.doc('searchConfig/settings').get();
      if (cfgSnap.exists) searchConfig = cfgSnap.data();
    } catch (err) {
      logger.warn('[SearchReport] Config read failed', { error: err.message });
    }

    /* ── Performance latency (P50 / P95 / P99 from stored analytics) */
    const latency = { p50: null, p95: null, p99: null, sampleSize: 0 };
    try {
      const perfSnap = await db.doc('searchAnalytics/latencyAggregate').get();
      if (perfSnap.exists) {
        const d = perfSnap.data();
        Object.assign(latency, {
          p50:        d.p50 || null,
          p95:        d.p95 || null,
          p99:        d.p99 || null,
          sampleSize: d.sampleSize || 0,
          windowHours: d.windowHours || null,
        });
      }
    } catch (err) {
      logger.warn('[SearchReport] Latency read failed', { error: err.message });
    }

    const generatedAt = new Date().toISOString();
    const reportMs    = Date.now() - startMs;

    return {
      ok: true,
      generatedAt,
      reportMs,
      config:    searchConfig,
      algolia: {
        indexes: algoliaIndexes,
        queue:   algoliaQueue,
      },
      typesense: {
        nodes:       typesenseNodes,
        collections: typesenseCollections,
        queue:       typesenseQueue,
      },
      syncLag,
      recentAlerts,
      latency,
    };
  }
);

/* ══════════════════════════════════════════════════════════════════════════════
   4. searchGetSecuredKeys — user-scoped API keys for both engines
══════════════════════════════════════════════════════════════════════════════ */

/**
 * Returns short-lived, user-scoped search API keys for BOTH Algolia and Typesense.
 * Admin users receive extended TTL and unrestricted access.
 * All key issuances are recorded to searchKeys/{uid} for audit.
 *
 * The keys are generated using the same HMAC logic as the dedicated
 * algolia-secured-keys.js and typesense-secured-keys.js modules, ensuring
 * consistency without duplicating rate-limit infrastructure.
 *
 * @type {import('firebase-functions/v2/https').CallableFunction}
 */
exports.searchGetSecuredKeys = onCall(
  {
    ...CF_OPTS,
    timeoutSeconds: 15,
    secrets:        [ALGOLIA_SEARCH_KEY, TYPESENSE_SEARCH_KEY],
  },
  async (req) => {
    const uid      = _assertAuth(req);
    const isAdmin  = Boolean(req.auth?.token?.admin);
    const role     = req.auth?.token?.role || (isAdmin ? 'admin' : 'buyer');
    const now      = Math.floor(Date.now() / 1000);

    const SEARCH_INDEXES = [
      'sokoni_products', 'sokoni_products_price_asc', 'sokoni_products_price_desc',
      'sokoni_products_newest', 'sokoni_products_rating', 'sokoni_products_popular',
      'sokoni_shops', 'sokoni_services', 'sokoni_services_price_asc',
      'sokoni_services_newest', 'sokoni_events', 'sokoni_events_soonest',
      'sokoni_events_popular', 'sokoni_properties', 'sokoni_properties_price_asc',
      'sokoni_properties_price_desc', 'sokoni_properties_newest',
      'sokoni_vehicles', 'sokoni_vehicles_price_asc', 'sokoni_vehicles_price_desc',
      'sokoni_vehicles_newest', 'sokoni_vehicles_year_desc',
      'sokoni_jobs', 'sokoni_jobs_newest', 'sokoni_jobs_deadline',
      'sokoni_users', 'sokoni_categories', 'sokoni_brands',
      'sokoni_collections', 'sokoni_coupons',
    ];

    const TS_COLLECTIONS = [
      'sokoni_products', 'sokoni_shops', 'sokoni_services', 'sokoni_events',
      'sokoni_properties', 'sokoni_vehicles', 'sokoni_jobs', 'sokoni_users',
      'sokoni_categories', 'sokoni_brands', 'sokoni_collections', 'sokoni_coupons',
      'sokoni_hotels', 'sokoni_sports', 'sokoni_healthcare', 'sokoni_education',
      'sokoni_professionals', 'sokoni_reviews',
    ];

    const algoliaKey  = ALGOLIA_SEARCH_KEY.value();
    const typesenseKey = TYPESENSE_SEARCH_KEY.value();

    const algoliaNotConfigured   = !algoliaKey   || algoliaKey   === 'not_configured';
    const typesenseNotConfigured = !typesenseKey || typesenseKey === 'not_configured';

    /* Algolia secured key */
    let algoliaResult = { apiKey: '', appId: process.env.ALGOLIA_APP_ID || '', expires: 0, degraded: true };
    if (!algoliaNotConfigured) {
      const algoliaTokenTTL  = isAdmin ? 14400 : 3600;
      const algoliaValidUntil = now + algoliaTokenTTL;
      const algoliaRestrictions = {
        validUntil:            algoliaValidUntil,
        userToken:             uid,
        restrictIndices:       SEARCH_INDEXES.join(','),
        enablePersonalization: true,
        analyticsTags:         [`role_${role}`, 'app_sokoni', 'platform_web'].join(','),
        ...(!isAdmin ? { filters: 'status:active OR status:published' } : {}),
      };
      const paramStr = Object.entries(algoliaRestrictions)
        .filter(([, v]) => v !== undefined && v !== null && v !== '')
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
        .join('&');
      const crypto = require('crypto');
      const hmac   = crypto.createHmac('sha256', algoliaKey).update(paramStr).digest('hex');
      const key    = Buffer.from(hmac + paramStr).toString('base64');
      algoliaResult = {
        apiKey:  key,
        appId:   process.env.ALGOLIA_APP_ID || '',
        expires: algoliaValidUntil,
        ttl:     algoliaTokenTTL,
        degraded: false,
      };
    }

    /* Typesense scoped key */
    let typesenseResult = { apiKey: '', host: process.env.TYPESENSE_HOST || '', expires: 0, degraded: true };
    if (!typesenseNotConfigured) {
      const tsTTL      = isAdmin ? 14400 : 3600;
      const tsExpires  = now + tsTTL;
      const tsParams   = {
        filter_by:         !isAdmin ? 'status:=active' : undefined,
        expires_at:        tsExpires,
        collection:        TS_COLLECTIONS,
        search_cutoff_ms:  200,
      };
      /* Remove undefined */
      Object.keys(tsParams).forEach(k => { if (tsParams[k] === undefined) delete tsParams[k]; });
      const crypto     = require('crypto');
      const paramsJson = JSON.stringify(tsParams);
      const tsHmac     = crypto.createHmac('sha256', typesenseKey).update(paramsJson).digest('hex');
      const tsKey      = Buffer.from(tsHmac + paramsJson).toString('base64');
      typesenseResult  = {
        apiKey:  tsKey,
        host:    process.env.TYPESENSE_HOST || '',
        port:    parseInt(process.env.TYPESENSE_PORT || '443', 10),
        expires: tsExpires,
        ttl:     tsTTL,
        degraded: false,
      };
    }

    /* Audit (non-blocking) */
    db.doc(`searchKeys/${uid}`).set({
      uid,
      role,
      isAdmin,
      algoliaIssued:   !algoliaResult.degraded,
      typesenseIssued: !typesenseResult.degraded,
      issuedAt:        _now(),
      expiresAt:       admin.firestore.Timestamp.fromMillis((algoliaResult.expires || 0) * 1000),
    }, { merge: true }).catch(() => {});

    return { algolia: algoliaResult, typesense: typesenseResult, role, uid };
  }
);

/* ══════════════════════════════════════════════════════════════════════════════
   5. searchConfigUpdate — update platform-level search settings
══════════════════════════════════════════════════════════════════════════════ */

/**
 * Updates the global search platform configuration stored at searchConfig/settings.
 * Settings drive runtime behaviour in search-service.js (engine selection, etc.).
 *
 * Accepted fields:
 *   primaryEngine       — 'algolia' | 'typesense' | 'auto'
 *   algoliaEnabled      — boolean
 *   typesenseEnabled    — boolean
 *   maxResultsPerPage   — number (1–100)
 *   boostRecentDocs     — boolean
 *   enableAutoFallback  — boolean
 *   analyticsEnabled    — boolean
 *   personalizationEnabled — boolean
 *
 * @type {import('firebase-functions/v2/https').CallableFunction}
 */
exports.searchConfigUpdate = onCall(
  { ...CF_OPTS, timeoutSeconds: 15 },
  async (req) => {
    const uid = _assertAdmin(req);
    const {
      primaryEngine,
      algoliaEnabled,
      typesenseEnabled,
      maxResultsPerPage,
      boostRecentDocs,
      enableAutoFallback,
      analyticsEnabled,
      personalizationEnabled,
    } = req.data || {};

    /* Validation */
    if (primaryEngine !== undefined && !['algolia', 'typesense', 'auto'].includes(primaryEngine)) {
      throw new HttpsError('invalid-argument', "primaryEngine must be 'algolia', 'typesense', or 'auto'.");
    }
    if (maxResultsPerPage !== undefined) {
      if (!Number.isInteger(maxResultsPerPage) || maxResultsPerPage < 1 || maxResultsPerPage > 100) {
        throw new HttpsError('invalid-argument', 'maxResultsPerPage must be an integer between 1 and 100.');
      }
    }

    const update = { updatedAt: _now(), updatedBy: uid };
    if (primaryEngine        !== undefined) update.primaryEngine        = primaryEngine;
    if (algoliaEnabled       !== undefined) update.algoliaEnabled       = Boolean(algoliaEnabled);
    if (typesenseEnabled     !== undefined) update.typesenseEnabled     = Boolean(typesenseEnabled);
    if (maxResultsPerPage    !== undefined) update.maxResultsPerPage    = maxResultsPerPage;
    if (boostRecentDocs      !== undefined) update.boostRecentDocs      = Boolean(boostRecentDocs);
    if (enableAutoFallback   !== undefined) update.enableAutoFallback   = Boolean(enableAutoFallback);
    if (analyticsEnabled     !== undefined) update.analyticsEnabled     = Boolean(analyticsEnabled);
    if (personalizationEnabled !== undefined) update.personalizationEnabled = Boolean(personalizationEnabled);

    await db.doc('searchConfig/settings').set(update, { merge: true });
    _audit('search_config_update', uid, { changes: update });

    return { ok: true, updated: update };
  }
);

/* ══════════════════════════════════════════════════════════════════════════════
   6. searchGetStats — combined queue + index statistics
══════════════════════════════════════════════════════════════════════════════ */

/**
 * Returns a consolidated statistics object for the search platform admin dashboard:
 *   - Algolia index sizes and record counts
 *   - Typesense collection sizes
 *   - Both engine queue depths + DLQ sizes
 *   - Performance latency distribution (P50/P95/P99) from searchAnalytics
 *   - Recent query volume (last 24h, 7d)
 *
 * Designed for sub-second response — all reads are from Firestore metadata
 * documents written by the background processors, NOT live API calls.
 *
 * @type {import('firebase-functions/v2/https').CallableFunction}
 */
exports.searchGetStats = onCall(
  {
    ...CF_OPTS,
    timeoutSeconds: 20,
    secrets:        [ALGOLIA_ADMIN_KEY, TYPESENSE_ADMIN_KEY],
  },
  async (req) => {
    _assertAdmin(req);

    /* ── Queue depths (Firestore count aggregate — no document reads) */
    const [
      algPending, algFailed, algDlq,
      tsPending,  tsFailed,  tsDlq,
    ] = await Promise.allSettled([
      db.collection('algoliaQueue').where('status', '==', 'pending').count().get(),
      db.collection('algoliaQueue').where('status', '==', 'failed').count().get(),
      db.collection('algoliaQueueDLQ').count().get(),
      db.collection('typesenseQueue').where('status', '==', 'pending').count().get(),
      db.collection('typesenseQueue').where('status', '==', 'failed').count().get(),
      db.collection('typesenseQueueDLQ').count().get(),
    ]);

    const safeCount = r => r.status === 'fulfilled' ? (r.value?.data?.()?.count ?? 0) : 0;

    const queues = {
      algolia: {
        pending: safeCount(algPending),
        failed:  safeCount(algFailed),
        dlq:     safeCount(algDlq),
      },
      typesense: {
        pending: safeCount(tsPending),
        failed:  safeCount(tsFailed),
        dlq:     safeCount(tsDlq),
      },
    };

    /* ── Stored metrics (written by background processors + analytics CFs) */
    const [algoliaMetaSnap, typesenseMetaSnap, latencySnap, volumeSnap] = await Promise.allSettled([
      db.doc('platformMetrics/algoliaIndexes').get(),
      db.doc('platformMetrics/typesenseCollections').get(),
      db.doc('searchAnalytics/latencyAggregate').get(),
      db.doc('searchAnalytics/volumeAggregate').get(),
    ]);

    const algoliaIndexStats    = algoliaMetaSnap.status   === 'fulfilled' && algoliaMetaSnap.value.exists   ? algoliaMetaSnap.value.data()   : {};
    const typesenseColStats    = typesenseMetaSnap.status === 'fulfilled' && typesenseMetaSnap.value.exists ? typesenseMetaSnap.value.data()  : {};
    const latencyStats         = latencySnap.status       === 'fulfilled' && latencySnap.value.exists       ? latencySnap.value.data()        : {};
    const volumeStats          = volumeSnap.status        === 'fulfilled' && volumeSnap.value.exists        ? volumeSnap.value.data()         : {};

    /* ── Recent error count (last 24h) */
    let recentErrors = 0;
    try {
      const since = admin.firestore.Timestamp.fromMillis(Date.now() - 86_400_000);
      const errSnap = await db.collection('adminAlerts')
        .where('category', '==', 'search')
        .where('createdAt', '>=', since)
        .count()
        .get();
      recentErrors = errSnap.data().count;
    } catch (_) { /* non-fatal */ }

    return {
      ok:          true,
      generatedAt: new Date().toISOString(),
      queues,
      algolia: {
        indexes:     algoliaIndexStats,
      },
      typesense: {
        collections: typesenseColStats,
      },
      performance: {
        latency: {
          p50:        latencyStats.p50        || null,
          p95:        latencyStats.p95        || null,
          p99:        latencyStats.p99        || null,
          sampleSize: latencyStats.sampleSize || 0,
          windowHours: latencyStats.windowHours || null,
        },
        volume: {
          last24h: volumeStats.last24h || 0,
          last7d:  volumeStats.last7d  || 0,
          topIndexes: volumeStats.topIndexes || [],
        },
      },
      recentErrors,
    };
  }
);
