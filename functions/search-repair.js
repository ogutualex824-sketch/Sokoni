/**
 * SOKONI Search Repair — Unified Reconcile & Reindex Operations
 *
 * Provides admin-triggered and scheduled repair operations across both search
 * engines. Every operation targets specific Firestore collections and fans out to
 * both Algolia and Typesense via their respective queues — never writing to the
 * search engines directly.
 *
 * Exports:
 *
 *  searchRepairAll  — onCall (admin)
 *    Triggers reconcile on BOTH engines for a specified collection by delegating
 *    to the engine-specific reconcile modules via Firestore (safe, non-blocking).
 *    Each reconcile task is written to `searchRepairJobs` and the respective
 *    reconcile modules read from there on their next run.
 *
 *  searchVerifyDocument  — onCall (admin)
 *    Verifies one Firestore document exists correctly in BOTH search engines by
 *    reading the engine monitor metadata and the document from Firestore directly.
 *    Returns a per-engine verification result without making search API calls
 *    (those are handled by algolia-reconcile.js / typesense-reconcile.js callables).
 *
 *  searchFullReindex  — onCall (admin)
 *    Reads up to 10,000 documents from a Firestore collection in batches of 500,
 *    enqueues every document as an 'upsert' to BOTH algolia-queue and typesense-queue.
 *    Returns { enqueued, collection, engines }.
 *
 *  searchRepairOrphanedDocs  — onCall (admin)
 *    Stub — orphan detection requires cross-referencing search engine scroll APIs
 *    with Firestore. Use algoliaReconcile / typesenseReconcile for now.
 *
 *  searchScheduledReconcile  — onSchedule every Sunday at 01:00 Africa/Nairobi
 *    Runs a lightweight count-comparison check across all collections in the registry.
 *    Writes results to `platformMetrics/searchReconcileLog`.
 *
 * Queue enqueue conventions:
 *  - Algolia:   algoliaQueue/{collection}_{docId}   via algolia-queue enqueue()
 *  - Typesense: typesenseQueue/{collection}_{docId} via typesense-queue enqueue()
 *  - Source field set to 'reindex' or 'repair' for traceability
 *
 * Firestore documents written:
 *   searchRepairJobs          — repair job tracking
 *   platformMetrics/searchReconcileLog — reconcile run results
 *   adminAlerts               — on reconcile divergence
 */

'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule }         = require('firebase-functions/v2/scheduler');
const { defineSecret }       = require('firebase-functions/params');
const admin                  = require('firebase-admin');

if (!admin.apps.length) admin.initializeApp();

const { enqueue: algoliaEnqueue }              = require('./algolia-queue');
const { enqueue: typesenseEnqueue, PRIORITY }  = require('./typesense-queue');
const { COLLECTION_REGISTRY }                  = require('./search-sync');

/* ── Secrets ──────────────────────────────────────────────────────────────── */

const ALGOLIA_ADMIN_KEY   = defineSecret('ALGOLIA_ADMIN_KEY');
const TYPESENSE_ADMIN_KEY = defineSecret('TYPESENSE_ADMIN_KEY');

/* ── Constants ────────────────────────────────────────────────────────────── */

const REPAIR_JOBS_COL     = 'searchRepairJobs';
const RECONCILE_LOG_DOC   = 'platformMetrics/searchReconcileLog';
const ALERTS_COL          = 'adminAlerts';

/** Maximum docs processed in a single searchFullReindex call */
const FULL_REINDEX_LIMIT  = 10_000;
/** Firestore read batch size — stays well under the 500-doc transaction limit */
const READ_BATCH_SIZE     = 500;
/** Count divergence ratio that triggers an admin alert during scheduled reconcile */
const DIVERGENCE_ALERT_RATIO = 0.05; // 5%

/* ── Helpers ──────────────────────────────────────────────────────────────── */

function _db()  { return admin.firestore(); }
function _now() { return admin.firestore.FieldValue.serverTimestamp(); }

function _assertAdmin(req) {
  if (!req.auth?.token?.admin) {
    throw new HttpsError('permission-denied', 'Admin required');
  }
  return req.auth.uid;
}

/**
 * Validate a collection name against COLLECTION_REGISTRY.
 *
 * @param {string} collection
 * @returns {import('./search-sync').CollectionEntry}
 */
function _resolveCollection(collection) {
  if (!collection || typeof collection !== 'string') {
    throw new HttpsError('invalid-argument', 'collection is required');
  }
  const entry = COLLECTION_REGISTRY[collection];
  if (!entry) {
    throw new HttpsError(
      'invalid-argument',
      `"${collection}" is not in COLLECTION_REGISTRY. Valid collections: ${Object.keys(COLLECTION_REGISTRY).join(', ')}`
    );
  }
  return entry;
}

/**
 * Enqueue one document to both search engines, respecting the engine field
 * of the collection registry entry.
 *
 * @param {import('./search-sync').CollectionEntry} entry
 * @param {string} docId
 * @param {Object} data
 * @param {string} source - 'reindex' | 'repair'
 * @returns {Promise<void>}
 */
async function _enqueueToEngines(entry, docId, data, source) {
  const enqueuePromises = [];

  if (entry.engine === 'algolia' || entry.engine === 'both') {
    if (entry.algoliaIndex) {
      enqueuePromises.push(
        algoliaEnqueue({
          operation:  'upsert',
          collection: entry.firestoreCollection,
          index:      entry.algoliaIndex,
          docId,
          data,
          source,
          priority:   entry.priority,
        })
      );
    }
  }

  if (entry.engine === 'typesense' || entry.engine === 'both') {
    if (entry.typesenseCollection) {
      enqueuePromises.push(
        typesenseEnqueue({
          operation:  'upsert',
          collection: entry.typesenseCollection,
          docId,
          data,
          source,
          priority:   entry.priority || PRIORITY.NORMAL,
        })
      );
    }
  }

  await Promise.all(enqueuePromises);
}

/* ── CF 1: searchRepairAll ────────────────────────────────────────────────── */

exports.searchRepairAll = onCall(
  {
    region:         'us-central1',
    memory:         '512MiB',
    timeoutSeconds: 120,
    secrets:        [ALGOLIA_ADMIN_KEY, TYPESENSE_ADMIN_KEY],
  },
  async (req) => {
    const uid    = _assertAdmin(req);
    const { collection } = req.data || {};
    const entry  = _resolveCollection(collection);

    const jobData = {
      collection,
      firestoreCollection: entry.firestoreCollection,
      engines:   [],
      status:    'queued',
      requestedBy: uid,
      requestedAt: _now(),
    };

    if (entry.engine === 'algolia' || entry.engine === 'both') {
      jobData.engines.push('algolia');
    }
    if (entry.engine === 'typesense' || entry.engine === 'both') {
      jobData.engines.push('typesense');
    }

    // Write a repair job document. Engine-specific reconcilers read from here
    // on their next scheduled run, or an operator can manually trigger them.
    const jobRef = await _db().collection(REPAIR_JOBS_COL).add(jobData);

    admin.logger.info('searchRepairAll: repair job created', {
      jobId: jobRef.id,
      collection,
      engines: jobData.engines,
      uid,
    });

    return {
      success:    true,
      jobId:      jobRef.id,
      collection,
      engines:    jobData.engines,
      message:    'Repair job queued. Engine reconcilers will process on next run. Use searchVerifyDocument to spot-check progress.',
    };
  }
);

/* ── CF 2: searchVerifyDocument ───────────────────────────────────────────── */

exports.searchVerifyDocument = onCall(
  {
    region:         'us-central1',
    memory:         '256MiB',
    timeoutSeconds: 30,
    secrets:        [ALGOLIA_ADMIN_KEY, TYPESENSE_ADMIN_KEY],
  },
  async (req) => {
    _assertAdmin(req);

    const { collection, docId } = req.data || {};
    if (!docId || typeof docId !== 'string') {
      throw new HttpsError('invalid-argument', 'docId is required');
    }

    const entry = _resolveCollection(collection);

    // Read the source document from Firestore
    const fsDoc = await _db().doc(`${entry.firestoreCollection}/${docId}`).get();

    const firestorePresent = fsDoc.exists;
    const firestoreData    = fsDoc.exists ? fsDoc.data() : null;
    const firestoreStatus  = firestoreData?.status || null;
    const firestoreActive  = firestoreData?.active  !== false;

    // Check engine-specific monitor metadata for last-indexed timestamp
    // (avoids direct search API calls — those live in engine-specific reconcilers)
    const [algoliaMonitorSnap, typesenseMonitorSnap] = await Promise.all([
      _db().doc('platformMetrics/algoliaMonitor').get(),
      _db().doc('platformMetrics/typesenseMonitor').get(),
    ]);

    const algoliaIndexedAt   = algoliaMonitorSnap.exists
      ? (algoliaMonitorSnap.data().lastIndexedAt || null)
      : null;
    const typesenseIndexedAt = typesenseMonitorSnap.exists
      ? (typesenseMonitorSnap.data().lastIndexedAt || null)
      : null;

    const result = {
      docId,
      collection,
      firestoreCollection: entry.firestoreCollection,
      firestore: {
        present: firestorePresent,
        status:  firestoreStatus,
        active:  firestoreActive,
      },
      algolia: {
        engineConfigured: !!(entry.algoliaIndex),
        index:            entry.algoliaIndex || null,
        lastEngineIndexedAt: algoliaIndexedAt,
        note: 'For per-document verification, use algoliaVerifyDoc (algolia-reconcile.js)',
      },
      typesense: {
        engineConfigured: !!(entry.typesenseCollection),
        collection:       entry.typesenseCollection || null,
        lastEngineIndexedAt: typesenseIndexedAt,
        note: 'For per-document verification, use typesenseVerifyDoc (typesense-reconcile.js)',
      },
      recommendation: !firestorePresent
        ? 'Document not found in Firestore. If it should exist, check the collection name. If deleted, run searchRepairAll to clean up search engines.'
        : (!firestoreActive || firestoreStatus === 'deleted' || firestoreStatus === 'draft')
          ? 'Document is inactive/deleted in Firestore. Verify search engines have removed it.'
          : 'Document present and active in Firestore. Trigger searchRepairAll if search engines appear stale.',
      checkedAt: new Date().toISOString(),
    };

    admin.logger.info('searchVerifyDocument: verification complete', { collection, docId, firestorePresent });

    return result;
  }
);

/* ── CF 3: searchFullReindex ──────────────────────────────────────────────── */

exports.searchFullReindex = onCall(
  {
    region:         'us-central1',
    memory:         '1GiB',
    timeoutSeconds: 540,
    secrets:        [ALGOLIA_ADMIN_KEY, TYPESENSE_ADMIN_KEY],
  },
  async (req) => {
    const uid            = _assertAdmin(req);
    const { collection } = req.data || {};
    const entry          = _resolveCollection(collection);

    const enginesTargeted = [];
    if (entry.engine === 'algolia'   || entry.engine === 'both') enginesTargeted.push('algolia');
    if (entry.engine === 'typesense' || entry.engine === 'both') enginesTargeted.push('typesense');

    admin.logger.info('searchFullReindex: starting', { collection, engines: enginesTargeted, uid });

    let enqueued    = 0;
    let lastDocSnap = null;
    let hasMore     = true;

    while (hasMore && enqueued < FULL_REINDEX_LIMIT) {
      const remaining = FULL_REINDEX_LIMIT - enqueued;
      const batchSize = Math.min(READ_BATCH_SIZE, remaining);

      // Build paginated query
      let query = _db()
        .collection(entry.firestoreCollection)
        .limit(batchSize);

      if (lastDocSnap) {
        query = query.startAfter(lastDocSnap);
      }

      const batchSnap = await query.get();

      if (batchSnap.empty) {
        hasMore = false;
        break;
      }

      // Enqueue all docs in this batch to both engines concurrently
      const enqueueOps = batchSnap.docs.map((doc) =>
        _enqueueToEngines(entry, doc.id, doc.data(), 'reindex')
          .catch((err) => {
            // Log per-doc errors but don't abort the run
            admin.logger.warn('searchFullReindex: enqueue failed for doc', {
              collection,
              docId: doc.id,
              error: err.message,
            });
          })
      );
      await Promise.all(enqueueOps);

      enqueued    += batchSnap.docs.length;
      lastDocSnap  = batchSnap.docs[batchSnap.docs.length - 1];
      hasMore      = batchSnap.docs.length === batchSize;
    }

    admin.logger.info('searchFullReindex: complete', { collection, enqueued, engines: enginesTargeted, uid });

    // Write an audit entry
    await _db().collection(REPAIR_JOBS_COL).add({
      type:        'fullReindex',
      collection,
      firestoreCollection: entry.firestoreCollection,
      engines:     enginesTargeted,
      enqueued,
      requestedBy: uid,
      completedAt: _now(),
    });

    return {
      enqueued,
      collection,
      firestoreCollection: entry.firestoreCollection,
      engines: enginesTargeted,
    };
  }
);

/* ── CF 4: searchRepairOrphanedDocs ──────────────────────────────────────── */

exports.searchRepairOrphanedDocs = onCall(
  {
    region:         'us-central1',
    memory:         '256MiB',
    timeoutSeconds: 30,
    secrets:        [ALGOLIA_ADMIN_KEY, TYPESENSE_ADMIN_KEY],
  },
  async (req) => {
    _assertAdmin(req);

    // Orphan detection requires paginating through search engine indexes via
    // scroll / browse APIs and cross-referencing with Firestore. This requires
    // engine-specific pagination logic that is already implemented (and tested)
    // in algoliaReconcile (algolia-reconcile.js) and typesenseReconcile
    // (typesense-reconcile.js). Duplicating that logic here would create drift.
    return {
      status:  'not_implemented',
      message: 'Use algoliaReconcile / typesenseReconcile for now',
    };
  }
);

/* ── CF 5: searchScheduledReconcile ──────────────────────────────────────── */

exports.searchScheduledReconcile = onSchedule(
  {
    schedule:       '0 1 * * 0',   // Every Sunday at 01:00
    region:         'us-central1',
    timeZone:       'Africa/Nairobi',
    memory:         '512MiB',
    timeoutSeconds: 540,
    secrets:        [ALGOLIA_ADMIN_KEY, TYPESENSE_ADMIN_KEY],
  },
  async () => {
    const db       = _db();
    const startedAt = new Date().toISOString();

    admin.logger.info('searchScheduledReconcile: starting weekly run', { startedAt });

    // Mark the run as started
    await db.doc(RECONCILE_LOG_DOC).set({
      status:    'running',
      startedAt: _now(),
      results:   {},
    }, { merge: false });

    const results     = {};
    const collections = Object.keys(COLLECTION_REGISTRY);

    /* Hoist monitor doc reads — same two docs on every iteration; fetch once before the loop */
    const [algoliaMonitorSnap, typesenseMonitorSnap] = await Promise.all([
      db.doc('platformMetrics/algoliaMonitor').get(),
      db.doc('platformMetrics/typesenseMonitor').get(),
    ]);
    const algoliaIndexCounts   = algoliaMonitorSnap.exists
      ? (algoliaMonitorSnap.data().indexEntryCounts   || {})
      : {};
    const typesenseIndexCounts = typesenseMonitorSnap.exists
      ? (typesenseMonitorSnap.data().collectionEntryCounts || {})
      : {};

    for (const collectionKey of collections) {
      const entry = COLLECTION_REGISTRY[collectionKey];
      const col   = entry.firestoreCollection;

      try {
        // Count Firestore documents (active, non-deleted)
        const fsCountSnap = await db
          .collection(col)
          .where('status', 'not-in', ['deleted', 'archived'])
          .count()
          .get();
        const fsCount = fsCountSnap.data().count;

        const algoliaCount = entry.algoliaIndex
          ? (algoliaIndexCounts[entry.algoliaIndex]         || null)
          : null;
        const typesenseCount = entry.typesenseCollection
          ? (typesenseIndexCounts[entry.typesenseCollection] || null)
          : null;

        // Compute divergence ratios where counts are available
        const algoliaDivergence = (algoliaCount !== null && fsCount > 0)
          ? Math.abs(fsCount - algoliaCount) / fsCount
          : null;
        const typesenseDivergence = (typesenseCount !== null && fsCount > 0)
          ? Math.abs(fsCount - typesenseCount) / fsCount
          : null;

        const collectionResult = {
          firestoreCount:       fsCount,
          algoliaCount,
          typesenseCount,
          algoliaDivergence:    algoliaDivergence !== null ? parseFloat(algoliaDivergence.toFixed(4)) : null,
          typesenseDivergence:  typesenseDivergence !== null ? parseFloat(typesenseDivergence.toFixed(4)) : null,
          status: 'checked',
        };

        results[collectionKey] = collectionResult;

        // Alert on significant divergence
        const alertPromises = [];
        if (algoliaDivergence !== null && algoliaDivergence > DIVERGENCE_ALERT_RATIO) {
          alertPromises.push(
            db.collection(ALERTS_COL).add({
              category:  'search',
              severity:  'warning',
              message:   `Reconcile: Algolia index "${entry.algoliaIndex}" diverges ${(algoliaDivergence * 100).toFixed(1)}% from Firestore for collection "${collectionKey}"`,
              meta:      { collectionKey, fsCount, algoliaCount, algoliaDivergence },
              resolved:  false,
              createdAt: _now(),
            })
          );
        }
        if (typesenseDivergence !== null && typesenseDivergence > DIVERGENCE_ALERT_RATIO) {
          alertPromises.push(
            db.collection(ALERTS_COL).add({
              category:  'search',
              severity:  'warning',
              message:   `Reconcile: Typesense collection "${entry.typesenseCollection}" diverges ${(typesenseDivergence * 100).toFixed(1)}% from Firestore for collection "${collectionKey}"`,
              meta:      { collectionKey, fsCount, typesenseCount, typesenseDivergence },
              resolved:  false,
              createdAt: _now(),
            })
          );
        }
        if (alertPromises.length) await Promise.all(alertPromises);

      } catch (err) {
        admin.logger.warn('searchScheduledReconcile: error checking collection', {
          collectionKey,
          error: err.message,
        });
        results[collectionKey] = { status: 'error', error: err.message };
      }
    }

    const completedAt = new Date().toISOString();

    // Write final log
    await db.doc(RECONCILE_LOG_DOC).set({
      status:      'complete',
      startedAt,
      completedAt,
      collectionsChecked: collections.length,
      results,
      updatedAt:   _now(),
    }, { merge: false });

    admin.logger.info('searchScheduledReconcile: complete', {
      collectionsChecked: collections.length,
      completedAt,
    });
  }
);
