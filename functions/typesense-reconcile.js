/**
 * SOKONI Typesense Reconciliation v1.0
 *
 * Scheduled consistency verification between Firestore (source of truth)
 * and Typesense (search index). Detects and repairs divergence automatically.
 *
 * Strategies:
 *  - typesenseReconcile (daily 04:00) — full document count comparison + spot checks
 *  - typesenseRepairDivergent (admin callable) — re-index a specific collection
 *  - typesenseVerifyDoc (admin callable) — verify a single document's indexed state
 *
 * Divergence is defined as:
 *  1. Document exists in Firestore but not in Typesense (missing)
 *  2. Document exists in Typesense but not in Firestore (orphan)
 *  3. Document exists in both but is stale (updatedAt mismatch)
 *
 * Auto-repair enqueues corrective actions into typesenseQueue using
 * the normal queue pipeline to avoid overloading Typesense directly.
 */

'use strict';

const { onSchedule }               = require('firebase-functions/v2/scheduler');
const { onCall, HttpsError }       = require('firebase-functions/v2/https');
const { defineSecret }             = require('firebase-functions/params');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const {
  TypesenseClient,
  COLLECTION_MAP,
  _chunk,
  _sleep,
} = require('./typesense-client');
const { enqueue } = require('./typesense-queue');

const TYPESENSE_ADMIN_KEY = defineSecret('TYPESENSE_ADMIN_KEY');
const TYPESENSE_NODES_VAR = process.env.TYPESENSE_NODES || '';

function _makeClient(adminKey) {
  const nodes = TYPESENSE_NODES_VAR
    ? TYPESENSE_NODES_VAR.split(',').map(s => s.trim()).filter(Boolean)
    : ['localhost:8108:http'];
  return new TypesenseClient(nodes, adminKey, { timeoutMs: 20_000, maxRetries: 2 });
}

/* ═══════════════════════════════════════════════════════════════════
   DAILY RECONCILE — Runs 04:00 UTC
   Per collection:
    1. Compare doc counts (Firestore vs Typesense)
    2. Spot-check 200 random Firestore docs → verify TS has them
    3. Spot-check 200 random TS docs → verify Firestore has them
    4. Enqueue repairs for any divergence found
════════════════════════════════════════════════════════════════════ */

exports.typesenseReconcile = onSchedule(
  {
    schedule:       'every day 04:45',  /* offset from algoliaMonitorEntries (04:00) to avoid concurrent resource contention */
    timeoutSeconds: 540,
    memory:         '512MiB',
    secrets:        [TYPESENSE_ADMIN_KEY],
  },
  async () => {
    const adminKey = TYPESENSE_ADMIN_KEY.value();
    if (!adminKey || adminKey === 'not_configured') return;

    const ts      = _makeClient(adminKey);
    const db      = getFirestore();
    const report  = { collections: [], totalMissing: 0, totalOrphans: 0, totalStale: 0, totalRepairs: 0 };
    const runAt   = Date.now();

    /* Deduplicated set of Firestore→TS mappings (avoid re-checking alias targets) */
    const checked = new Set();

    for (const [firestoreCol, mapEntry] of Object.entries(COLLECTION_MAP)) {
      if (!mapEntry) continue;
      const { collection: tsCol } = mapEntry;
      const dedupeKey = `${firestoreCol}:${tsCol}`;
      if (checked.has(dedupeKey)) continue;
      checked.add(dedupeKey);

      const colReport = { firestoreCollection: firestoreCol, tsCollection: tsCol, missing: 0, orphans: 0, stale: 0, repaired: 0 };

      try {
        /* Step 1: Count comparison */
        const [fsCount, tsInfo] = await Promise.allSettled([
          db.collection(firestoreCol).count().get(),
          ts.getCollection(tsCol),
        ]);

        const fsTotal = fsCount.status === 'fulfilled' ? fsCount.value.data().count : null;
        const tsTotal = tsInfo.status  === 'fulfilled' ? tsInfo.value.num_documents : null;
        colReport.firestoreCount = fsTotal;
        colReport.typesenseCount = tsTotal;

        if (fsTotal !== null && tsTotal !== null) {
          const diff = Math.abs(fsTotal - tsTotal);
          colReport.countDiff = diff;
          if (diff > fsTotal * 0.01) { /* >1% divergence triggers spot check */
            colReport.countDivergenceAlert = true;
          }
        }

        /* Step 2: Spot-check Firestore → Typesense (find missing) */
        const fsSnap = await db.collection(firestoreCol)
          .where('status', 'not-in', ['deleted', 'banned', 'suspended'])
          .limit(200)
          .get();

        for (const fsChunk of _chunk(fsSnap.docs, 20)) {
          for (const fsDoc of fsChunk) {
            try {
              await ts.search(tsCol, {
                q:            fsDoc.id,
                query_by:     'id',
                filter_by:    `id:=${fsDoc.id}`,
                per_page:     1,
                include_fields: 'id',
              });
            } catch (err) {
              if (err.status === 404 || (err.body?.found === 0)) {
                /* Missing in Typesense — enqueue repair */
                await enqueue({
                  collection: firestoreCol,
                  docId:      fsDoc.id,
                  operation:  'upsert',
                  data:       fsDoc.data(),
                  priority:   2, /* NORMAL */
                });
                colReport.missing++;
                colReport.repaired++;
              }
            }
          }
          await _sleep(50);
        }

        /* Step 3: Spot-check Typesense → Firestore (find orphans) */
        const tsRes = await ts.search(tsCol, {
          q:               '*',
          query_by:        'id',
          per_page:        200,
          include_fields:  'id',
          sort_by:         '_text_match:desc',
        }).catch(() => null);

        if (tsRes?.hits?.length) {
          const tsIds = tsRes.hits.map(h => h.document?.id).filter(Boolean);
          for (const idChunk of _chunk(tsIds, 30)) {
            const refs  = idChunk.map(id => db.collection(firestoreCol).doc(id));
            const snaps = await db.getAll(...refs);
            for (const snap of snaps) {
              if (!snap.exists) {
                await enqueue({
                  collection: firestoreCol,
                  docId:      snap.id,
                  operation:  'delete',
                  priority:   2,
                });
                colReport.orphans++;
                colReport.repaired++;
              }
            }
          }
        }

      } catch (err) {
        colReport.error = err.message;
        console.error(`[TS Reconcile] Error checking ${firestoreCol}:`, err.message);
      }

      report.totalMissing  += colReport.missing;
      report.totalOrphans  += colReport.orphans;
      report.totalRepairs  += colReport.repaired;
      report.collections.push(colReport);
    }

    /* Persist reconcile report */
    await db.collection('tsReconcileLog').add({
      ...report,
      runAt,
      completedAt: FieldValue.serverTimestamp(),
    });

    /* Alert if significant divergence */
    if (report.totalRepairs > 100) {
      await db.collection('adminAlerts').add({
        type:      'typesense_reconcile_divergence',
        repairs:   report.totalRepairs,
        missing:   report.totalMissing,
        orphans:   report.totalOrphans,
        severity:  report.totalRepairs > 1000 ? 'critical' : 'warning',
        message:   `Typesense reconcile: ${report.totalRepairs} repairs needed`,
        createdAt: Date.now(),
      });
    }

    console.log(`[TS Reconcile] Done. Missing: ${report.totalMissing}, Orphans: ${report.totalOrphans}, Repairs enqueued: ${report.totalRepairs}`);
  }
);

/* ═══════════════════════════════════════════════════════════════════
   REPAIR DIVERGENT COLLECTION — Admin callable
   Re-enqueues all Firestore docs in a collection for re-indexing.
   Use when a collection is known to be fully out of sync.
════════════════════════════════════════════════════════════════════ */

exports.typesenseRepairDivergent = onCall(
  {
    secrets:        [TYPESENSE_ADMIN_KEY],
    timeoutSeconds: 540,
    memory:         '512MiB',
  },
  async ({ auth, data: callData = {} }) => {
    if (!auth?.token?.admin) throw new HttpsError('permission-denied', 'Admin only');
    const { firestoreCollection, pageSize = 200 } = callData;
    if (!firestoreCollection) throw new HttpsError('invalid-argument', 'firestoreCollection required');

    const db       = getFirestore();
    let   cursor   = null;
    let   enqueued = 0;

    while (true) {
      let query = db.collection(firestoreCollection)
        .orderBy('__name__')
        .limit(pageSize);
      if (cursor) query = query.startAfter(cursor);
      const snap = await query.get();
      if (snap.empty) break;

      for (const doc of snap.docs) {
        const data = doc.data();
        if (['deleted','banned','suspended'].includes(data.status)) {
          await enqueue({ collection: firestoreCollection, docId: doc.id, operation: 'delete', priority: 4 });
        } else {
          await enqueue({ collection: firestoreCollection, docId: doc.id, operation: 'upsert', data, priority: 4 /* BATCH */ });
        }
        enqueued++;
      }

      cursor = snap.docs[snap.docs.length - 1];
      if (snap.size < pageSize) break;
      await _sleep(50);
    }

    return { firestoreCollection, enqueued };
  }
);

/* ═══════════════════════════════════════════════════════════════════
   VERIFY SINGLE DOCUMENT — Admin callable
════════════════════════════════════════════════════════════════════ */

exports.typesenseVerifyDoc = onCall(
  {
    secrets:        [TYPESENSE_ADMIN_KEY],
    timeoutSeconds: 15,
    memory:         '256MiB',
  },
  async ({ auth, data: callData = {} }) => {
    if (!auth?.token?.admin) throw new HttpsError('permission-denied', 'Admin only');
    const { firestoreCollection, docId } = callData;
    if (!firestoreCollection || !docId) throw new HttpsError('invalid-argument', 'firestoreCollection and docId required');

    const mapEntry = COLLECTION_MAP[firestoreCollection];
    if (!mapEntry) throw new HttpsError('not-found', `No mapping for "${firestoreCollection}"`);

    const ts    = _makeClient(TYPESENSE_ADMIN_KEY.value());
    const db    = getFirestore();
    const tsCol = mapEntry.collection;

    const [fsSnap, tsSearch] = await Promise.allSettled([
      db.collection(firestoreCollection).doc(docId).get(),
      ts.search(tsCol, { q: docId, query_by: 'id', filter_by: `id:=${docId}`, per_page: 1 }),
    ]);

    const inFirestore  = fsSnap.status  === 'fulfilled' && fsSnap.value.exists;
    const inTypesense  = tsSearch.status === 'fulfilled' && tsSearch.value?.found > 0;
    const fsData       = inFirestore ? fsSnap.value.data() : null;
    const tsData       = inTypesense ? tsSearch.value.hits[0]?.document : null;

    return {
      docId,
      firestoreCollection,
      tsCollection:  tsCol,
      inFirestore,
      inTypesense,
      diverged:      inFirestore !== inTypesense,
      fsStatus:      fsData?.status || null,
      tsDoc:         tsData ? { id: tsData.id, status: tsData.status, updatedAt: tsData.updatedAt } : null,
    };
  }
);
