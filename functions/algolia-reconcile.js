/**
 * SOKONI Algolia Reconciliation
 *
 * Scheduled daily: spot-checks a random sample of Firestore documents against
 * the corresponding Algolia index to detect and repair divergence.
 *
 * Divergence scenarios caught:
 *   1. Document exists in Firestore as active but is MISSING from Algolia
 *      → enqueues an 'upsert' to re-index it
 *   2. Document exists in Algolia but is DELETED / DRAFT in Firestore
 *      → enqueues a 'delete' to remove it from the index
 *   3. Key indexed field (price, status, name) differs between Firestore and Algolia
 *      → enqueues a 'upsert' to refresh the stale record
 *
 * Architecture:
 *   - Spot-checks 200 random docs per collection per run (manageable cost)
 *   - Uses Algolia's getObjects API to batch-fetch up to 1000 objects at once
 *   - Auto-repairs divergent items by re-enqueueing them via algolia-queue
 *   - Writes a daily report to Firestore (platformMetrics/algoliaReconcile)
 *   - Fires an admin alert when divergence rate > 1%
 *   - algoliaVerifyDoc callable: admin can verify a single document on demand
 */

'use strict';

const { onSchedule }         = require('firebase-functions/v2/scheduler');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret }       = require('firebase-functions/params');
const admin                  = require('firebase-admin');

const { AlgoliaClient, COLLECTION_INDEX_MAP, TRANSFORMERS } = require('./algolia-indexer');
const { enqueue }                                           = require('./algolia-queue');

const ALGOLIA_ADMIN_KEY = defineSecret('ALGOLIA_ADMIN_KEY');

/* ── Constants ───────────────────────────────────────────────────────────── */

/* Docs to spot-check per collection per run — enough to detect systemic issues */
const SAMPLE_SIZE      = 200;
/* Divergence rate above which an admin alert is fired */
const ALERT_THRESHOLD  = 0.01; // 1%
/* Fields checked for field-level divergence (key commerce signals only) */
const FIELD_CHECK_KEYS = ['status', 'name', 'title', 'price', 'inStock'];

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

/**
 * Checks whether data in `fsRecord` (Firestore) matches `algoliaRecord`.
 * Returns true if the records are semantically in sync.
 */
function _inSync(fsRecord, algoliaRecord, transformer, docId) {
  if (!algoliaRecord) return false; // missing from Algolia
  const transformed = transformer(docId, fsRecord);
  if (!transformed) return false;
  for (const key of FIELD_CHECK_KEYS) {
    if (key in transformed && transformed[key] !== algoliaRecord[key]) return false;
  }
  return true;
}

/**
 * Batch-fetch objects from Algolia using the getObjects API.
 * Returns a Map<objectID, record|null>.
 */
async function _algoliaGetObjects(algolia, indexName, objectIDs) {
  if (objectIDs.length === 0) return new Map();
  try {
    const res = await algolia._request(
      'POST',
      '/1/indexes/*/objects',
      {
        requests: objectIDs.map(id => ({
          indexName,
          objectID:             id,
          attributesToRetrieve: [...FIELD_CHECK_KEYS, 'objectID'],
        })),
      }
    );
    const map = new Map();
    (res.results || []).forEach(r => {
      map.set(r.objectID, r.objectID ? r : null);
    });
    return map;
  } catch (err) {
    console.error(`[AlgoliaReconcile] getObjects failed for ${indexName}:`, err.message);
    return new Map();
  }
}

/* ══════════════════════════════════════════════════════════════════════
   algoliaReconcile  — scheduled daily at 03:30
══════════════════════════════════════════════════════════════════════ */

const algoliaReconcile = onSchedule(
  {
    schedule:       'every day 03:30',
    timeoutSeconds: 540,
    memory:         '512MiB',
    secrets:        [ALGOLIA_ADMIN_KEY],
  },
  async () => {
    const algolia = _client();
    if (!algolia) {
      console.log('[AlgoliaReconcile] Algolia not configured — skipping');
      return;
    }

    const db  = _db();
    const now = Date.now();

    /* Collections to reconcile: only the main commerce collections */
    const reconcileTargets = [
      { collection: 'products',    index: 'sokoni_products',   transformer: TRANSFORMERS.products   },
      { collection: 'sellers',     index: 'sokoni_shops',      transformer: TRANSFORMERS.sellers    },
      { collection: 'providers',   index: 'sokoni_services',   transformer: TRANSFORMERS.services   },
      { collection: 'events',      index: 'sokoni_events',     transformer: TRANSFORMERS.events     },
      { collection: 'properties',  index: 'sokoni_properties', transformer: TRANSFORMERS.properties },
      { collection: 'cars',        index: 'sokoni_vehicles',   transformer: TRANSFORMERS.cars       },
      { collection: 'digitalJobs', index: 'sokoni_jobs',       transformer: TRANSFORMERS.digitalJobs },
    ];

    const report = {
      runAt:       new Date().toISOString(),
      collections: {},
      totalChecked:     0,
      totalDivergent:   0,
      totalRepaired:    0,
    };

    for (const { collection, index, transformer } of reconcileTargets) {
      const colReport = { checked: 0, missing: 0, stale: 0, extraInAlgolia: 0, repaired: 0, errors: 0 };

      try {
        /* Randomly-offset sample using a synthetic startAt cursor.
           Firestore doc IDs are base62 random strings; using a random
           26-char prefix skips roughly (cursor-pos / alphabet-size) of
           the collection, distributing coverage across multiple daily runs. */
        const CURSOR_CHARS   = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        const randomCursor   = Array.from({ length: 10 }, () =>
          CURSOR_CHARS[Math.floor(Math.random() * CURSOR_CHARS.length)]
        ).join('');

        let snap = await db.collection(collection)
          .orderBy('__name__')
          .startAt(randomCursor)
          .limit(SAMPLE_SIZE)
          .get();

        /* If random cursor is near the end of the collection, wrap to the beginning */
        if (snap.size < SAMPLE_SIZE) {
          const remaining = SAMPLE_SIZE - snap.size;
          const wrapSnap  = await db.collection(collection)
            .orderBy('__name__')
            .limit(remaining)
            .get();
          /* Merge docs, de-duplicate by id */
          const merged    = new Map([...snap.docs, ...wrapSnap.docs].map(d => [d.id, d]));
          snap = { docs: [...merged.values()], size: merged.size, empty: merged.size === 0 };
        }

        if (snap.empty) {
          report.collections[collection] = colReport;
          continue;
        }

        /* Separate into indexable vs skip-worthy docs */
        const indexable = [];
        const toDelete  = [];

        for (const doc of snap.docs) {
          const d = doc.data();
          if (!d) continue;
          if (d._noIndex === true) continue;

          const isDraft   = d.status === 'draft' || d.status === 'deleted';
          const isPrivate = collection === 'users' && (d.private === true || d.status === 'banned');

          if (isDraft || isPrivate) {
            toDelete.push(doc.id);
          } else {
            indexable.push({ id: doc.id, data: d });
          }
        }

        colReport.checked = snap.size;
        report.totalChecked += snap.size;

        /* 1. Verify indexable docs exist and match in Algolia */
        const indexableIDs = indexable.map(d => d.id);
        const algoliaMap   = await _algoliaGetObjects(algolia, index, indexableIDs);

        for (const { id, data } of indexable) {
          const algoliaRecord = algoliaMap.get(id);

          if (!algoliaRecord) {
            /* MISSING from Algolia — re-enqueue for indexing */
            colReport.missing++;
            report.totalDivergent++;
            await enqueue({ collection, docId: id, operation: 'upsert', data }).catch(() => {});
            colReport.repaired++;
            report.totalRepaired++;
          } else if (!_inSync(data, algoliaRecord, transformer, id)) {
            /* STALE in Algolia — key field differs */
            colReport.stale++;
            report.totalDivergent++;
            await enqueue({ collection, docId: id, operation: 'upsert', data }).catch(() => {});
            colReport.repaired++;
            report.totalRepaired++;
          }
        }

        /* 2. Verify draft/deleted docs are NOT in Algolia (orphan check) */
        if (toDelete.length > 0) {
          const deleteMap = await _algoliaGetObjects(algolia, index, toDelete);
          for (const id of toDelete) {
            if (deleteMap.get(id)) {
              /* Found in Algolia but should have been deleted */
              colReport.extraInAlgolia++;
              report.totalDivergent++;
              await enqueue({ collection, docId: id, operation: 'delete' }).catch(() => {});
              colReport.repaired++;
              report.totalRepaired++;
            }
          }
        }

      } catch (err) {
        console.error(`[AlgoliaReconcile] Error on ${collection}:`, err.message);
        colReport.errors++;
      }

      report.collections[collection] = colReport;
      console.log(`[AlgoliaReconcile] ${collection}: checked=${colReport.checked} missing=${colReport.missing} stale=${colReport.stale} repaired=${colReport.repaired}`);
    }

    /* Persist daily report */
    await db.collection('platformMetrics').doc('algoliaReconcile').set({
      ...report,
      durationMs: Date.now() - now,
      updatedAt:  _now(),
    }, { merge: true });

    /* Store in history for trend analysis */
    await db.collection('algoliaReconcileHistory').add({
      ...report,
      durationMs: Date.now() - now,
      createdAt:  _now(),
    });

    /* Alert admin if divergence rate exceeds threshold */
    const divergenceRate = report.totalChecked > 0
      ? report.totalDivergent / report.totalChecked
      : 0;

    if (divergenceRate > ALERT_THRESHOLD) {
      await db.collection('adminAlerts').add({
        type:            'algolia_reconcile_divergence',
        severity:        divergenceRate > 0.05 ? 'critical' : 'warning',
        message:         `Algolia reconciliation: ${report.totalDivergent} of ${report.totalChecked} sampled docs diverged (${(divergenceRate * 100).toFixed(1)}%). ${report.totalRepaired} auto-repaired.`,
        divergenceRate,
        totalDivergent:  report.totalDivergent,
        totalChecked:    report.totalChecked,
        totalRepaired:   report.totalRepaired,
        collections:     report.collections,
        createdAt:       _now(),
      });
      console.warn(`[AlgoliaReconcile] HIGH DIVERGENCE: ${(divergenceRate * 100).toFixed(1)}% — admin alert fired`);
    }

    console.log(`[AlgoliaReconcile] Complete — checked:${report.totalChecked} divergent:${report.totalDivergent} repaired:${report.totalRepaired} (${Date.now() - now}ms)`);
  }
);

/* ══════════════════════════════════════════════════════════════════════
   algoliaVerifyDoc  — admin callable: verify a single document
══════════════════════════════════════════════════════════════════════ */

const algoliaVerifyDoc = onCall(
  { secrets: [ALGOLIA_ADMIN_KEY], timeoutSeconds: 15 },
  async (request) => {
    _assertAdmin(request);

    const { collection, docId } = request.data || {};
    if (!collection || !docId) {
      throw new HttpsError('invalid-argument', 'collection and docId are required.');
    }

    const mapping = COLLECTION_INDEX_MAP[collection];
    if (!mapping) throw new HttpsError('invalid-argument', `Unknown collection: ${collection}`);

    const algolia = _client();
    if (!algolia) throw new HttpsError('failed-precondition', 'Algolia not configured.');

    const db = _db();

    /* Fetch Firestore document */
    const fsSnap = await db.collection(collection).doc(docId).get();
    const fsData = fsSnap.exists ? fsSnap.data() : null;

    /* Fetch Algolia record */
    let algoliaRecord = null;
    try {
      algoliaRecord = await algolia._request('GET', `/1/indexes/${mapping.index}/${encodeURIComponent(docId)}`);
    } catch (err) {
      if (err.status !== 404) throw new HttpsError('internal', `Algolia fetch failed: ${err.message}`);
    }

    const inAlgolia   = !!algoliaRecord && !algoliaRecord.message;
    const inFirestore = !!fsData;

    /* Determine sync status */
    let syncStatus = 'unknown';
    if (inFirestore && inAlgolia) {
      const transformed  = mapping.transformer(docId, fsData);
      const allFieldsOk  = FIELD_CHECK_KEYS.every(k => {
        if (!(k in (transformed || {}))) return true;
        return transformed[k] === algoliaRecord[k];
      });
      syncStatus = allFieldsOk ? 'in_sync' : 'stale';
    } else if (inFirestore && !inAlgolia) {
      syncStatus = 'missing_from_algolia';
    } else if (!inFirestore && inAlgolia) {
      syncStatus = 'orphan_in_algolia';
    } else {
      syncStatus = 'not_found_anywhere';
    }

    /* Optionally auto-repair */
    let repaired = false;
    if (syncStatus === 'missing_from_algolia' || syncStatus === 'stale') {
      await enqueue({ collection, docId, operation: 'upsert', data: fsData });
      repaired = true;
    } else if (syncStatus === 'orphan_in_algolia') {
      await enqueue({ collection, docId, operation: 'delete' });
      repaired = true;
    }

    return {
      docId,
      collection,
      indexName:    mapping.index,
      syncStatus,
      inFirestore,
      inAlgolia,
      repaired,
      firestoreStatus: fsData?.status || null,
      algoliaFields:  algoliaRecord ? {
        objectID: algoliaRecord.objectID,
        status:   algoliaRecord.status,
        name:     algoliaRecord.name || algoliaRecord.title,
        price:    algoliaRecord.price,
      } : null,
    };
  }
);

/* ══════════════════════════════════════════════════════════════════════
   algoliaReconcileHistory  — admin callable: get divergence history
══════════════════════════════════════════════════════════════════════ */

const algoliaGetReconcileHistory = onCall(
  { secrets: [ALGOLIA_ADMIN_KEY], timeoutSeconds: 15 },
  async (request) => {
    _assertAdmin(request);
    const db   = _db();
    const snap = await db.collection('algoliaReconcileHistory')
      .orderBy('createdAt', 'desc')
      .limit(30)
      .get();

    return {
      history: snap.docs.map(d => ({
        runAt:          d.data().runAt,
        totalChecked:   d.data().totalChecked,
        totalDivergent: d.data().totalDivergent,
        totalRepaired:  d.data().totalRepaired,
        divergenceRate: d.data().totalChecked > 0
          ? (d.data().totalDivergent / d.data().totalChecked)
          : 0,
        durationMs:     d.data().durationMs,
      })),
    };
  }
);

/* ══════════════════════════════════════════════════════════════════════
   algoliaReconcileStats  — latest stats for admin dashboard
══════════════════════════════════════════════════════════════════════ */

const algoliaReconcileStats = onCall(
  { secrets: [ALGOLIA_ADMIN_KEY], timeoutSeconds: 10 },
  async (request) => {
    _assertAdmin(request);
    const db   = _db();
    const snap = await db.collection('platformMetrics').doc('algoliaReconcile').get();
    return snap.exists ? snap.data() : { totalChecked: 0, totalDivergent: 0 };
  }
);

module.exports = {
  algoliaReconcile,
  algoliaVerifyDoc,
  algoliaGetReconcileHistory,
  algoliaReconcileStats,
};
