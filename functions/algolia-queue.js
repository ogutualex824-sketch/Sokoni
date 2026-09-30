/**
 * SOKONI Algolia Queue Processor
 *
 * Design: Queue-based, idempotent, fault-tolerant indexing pipeline.
 *
 * Flow:
 *   Firestore trigger writes to algoliaQueue/{collection}_{docId}
 *   ↓
 *   processAlgoliaQueue (scheduled every 30s) reads pending items
 *   ↓
 *   Batch-transforms and pushes to Algolia (max 1 000 per batch call)
 *   ↓
 *   Success → marks item 'done'
 *   Failure → increments attempts, schedules retry with exponential backoff
 *   Max attempts exceeded → moves to algoliaQueueDLQ (dead-letter queue)
 *   ↓
 *   algoliaQueueMonitor (scheduled daily) alerts admin on DLQ depth
 *
 * Deduplication:
 *   Queue item ID = `${collection}_${docId}` — collisions overwrite the stale
 *   entry with the latest data, ensuring only one pending write per document.
 *
 * Batch efficiency:
 *   Items are grouped by (index, operation) and flushed in Algolia batch calls.
 *   A single schedule invocation can process up to 5 000 items.
 */

'use strict';

const { onSchedule }         = require('firebase-functions/v2/scheduler');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret }       = require('firebase-functions/params');
const admin                  = require('firebase-admin');

const { AlgoliaClient, COLLECTION_INDEX_MAP, buildPartialUpdate, _chunk } = require('./algolia-indexer');
const { sanitizeRecord } = require('./algolia-sanitize');

const ALGOLIA_ADMIN_KEY = defineSecret('ALGOLIA_ADMIN_KEY');

/* ── Constants ──────────────────────────────────────────────────────────── */

const MAX_ATTEMPTS    = 4;
const BATCH_LIMIT     = 5000;   // items per schedule run
const ALGOLIA_BATCH   = 1000;   // Algolia hard limit per batch call
const RETRY_DELAYS    = [0, 30, 120, 600]; // seconds for attempts 0-3

/* ── Helpers ──────────────────────────────────────────────────────────── */

function _client() {
  const appId  = process.env.ALGOLIA_APP_ID;
  const key    = ALGOLIA_ADMIN_KEY.value();
  if (!appId || !key || key === 'not_configured') return null;
  return new AlgoliaClient(appId, key);
}

function _db() { return admin.firestore(); }

function _now() { return admin.firestore.FieldValue.serverTimestamp(); }

/* ── Queue item structure ─────────────────────────────────────────────── */
/*
  algoliaQueue/{collection}_{docId}  {
    queueId:      string,            // == doc ID
    collection:   string,
    docId:        string,
    indexName:    string,
    operation:    'upsert' | 'partial' | 'delete',
    data:         object | null,     // full snapshot (upsert/partial); null (delete)
    beforeData:   object | null,     // previous snapshot for diff (partial only)
    status:       'pending' | 'processing' | 'done' | 'failed' | 'dlq',
    attempts:     number,
    nextAttemptAt: Timestamp,
    createdAt:    Timestamp,
    updatedAt:    Timestamp,
    error:        string | null,
  }
*/

/* ══════════════════════════════════════════════════════════════════════
   ENQUEUE  — write a queue item (upsert or delete)
══════════════════════════════════════════════════════════════════════ */

async function enqueue({ collection, docId, operation, data = null, beforeData = null }) {
  const mapping = COLLECTION_INDEX_MAP[collection];
  if (!mapping) return; // collection not indexed

  const queueId   = `${collection}_${docId}`;
  const queueRef  = _db().collection('algoliaQueue').doc(queueId);

  const existing = await queueRef.get();

  /* If item is currently being processed, flag it for re-processing */
  if (existing.exists && existing.data().status === 'processing') {
    await queueRef.update({
      operation,
      data:         data || null,
      beforeData:   beforeData || null,
      _requeue:     true,
      updatedAt:    _now(),
    });
    return;
  }

  const item = {
    queueId,
    collection,
    docId,
    indexName:     mapping.index,
    operation,                         // upsert | partial | delete
    data:          data || null,
    beforeData:    beforeData || null,
    status:        'pending',
    attempts:      0,
    nextAttemptAt: admin.firestore.Timestamp.now(),
    createdAt:     existing.exists ? existing.data().createdAt : _now(),
    updatedAt:     _now(),
    error:         null,
  };

  await queueRef.set(item);

  /* ── Global search fanout ────────────────────────────────────────────
     When a collection has globalSearch:true, also write a shadow entry
     to global_search index via a gs__{collection} queue item.
     Queue ID: gs__{collection}_{docId}  (distinct from primary item)
     objectID in global_search: {collection}_{docId}  (prefixed)
  ──────────────────────────────────────────────────────────────────── */
  if (mapping.globalSearch) {
    const gsCollection = `gs__${collection}`;
    const gsDocId      = `${collection}_${docId}`;   // prefixed objectID
    const gsQueueId    = `gs__${collection}_${docId}`;
    const gsRef        = _db().collection('algoliaQueue').doc(gsQueueId);

    const gsItem = {
      queueId:       gsQueueId,
      collection:    gsCollection,
      docId:         gsDocId,
      indexName:     'global_search',
      operation:     operation === 'delete' ? 'delete' : 'upsert',
      data:          operation !== 'delete' ? (data || null) : null,
      beforeData:    null,   // global writes are always full upserts — no partial
      status:        'pending',
      attempts:      0,
      nextAttemptAt: admin.firestore.Timestamp.now(),
      createdAt:     _now(),
      updatedAt:     _now(),
      error:         null,
    };
    await gsRef.set(gsItem);
  }
}

/* ══════════════════════════════════════════════════════════════════════
   PROCESS QUEUE  — scheduled every 5 minutes
══════════════════════════════════════════════════════════════════════ */

const processAlgoliaQueue = onSchedule(
  {
    schedule:        'every 5 minutes',   // 5-min latency is acceptable; saves 80% of invocations vs 1-min
    timeoutSeconds:  540,
    memory:          '512MiB',
    secrets:         [ALGOLIA_ADMIN_KEY],
  },
  async () => {
    const algolia = _client();
    if (!algolia) {
      console.log('[AlgoliaQueue] Algolia not configured — skipping');
      return;
    }

    const db  = _db();

    /* Honour the admin pause flag (set by pauseQueue({ engine: 'algolia' })) */
    const ctrlSnap = await db.collection('searchConfig').doc('queueControl').get();
    if (ctrlSnap.exists && ctrlSnap.data().algoliaPaused === true) {
      console.log('[AlgoliaQueue] Queue is paused — skipping this run');
      return;
    }

    const now = admin.firestore.Timestamp.now();

    /* Fetch pending items whose nextAttemptAt has passed */
    const snap = await db.collection('algoliaQueue')
      .where('status', 'in', ['pending', 'failed'])
      .where('nextAttemptAt', '<=', now)
      .orderBy('nextAttemptAt', 'asc')
      .limit(BATCH_LIMIT)
      .get();

    if (snap.empty) return;

    console.log(`[AlgoliaQueue] Processing ${snap.size} items`);

    /* Mark all as 'processing' atomically (prevents double-processing) */
    const batch = db.batch();
    snap.docs.forEach(doc => {
      batch.update(doc.ref, { status: 'processing', updatedAt: _now() });
    });
    await batch.commit();

    /* Group items by (indexName, operation) for efficient batching */
    const groups = {}; // `${indexName}:${op}` → [{ doc, item }]
    for (const doc of snap.docs) {
      const item = doc.data();
      const key  = `${item.indexName}:${item.operation}`;
      if (!groups[key]) groups[key] = [];
      groups[key].push({ doc, item });
    }

    const results = await Promise.allSettled(
      Object.entries(groups).map(([key, entries]) =>
        _processGroup(algolia, db, key, entries)
      )
    );

    /* Log any unexpected top-level failures */
    results.forEach((r, i) => {
      if (r.status === 'rejected') {
        console.error(`[AlgoliaQueue] Group processing error:`, r.reason);
      }
    });
  }
);

/* ── Process a single group of (indexName, operation) items ─────────── */

/**
 * Send a set of {item, obj} tuples, isolating failures.
 *
 * Algolia fails a batch call as a unit, so the previous code marked EVERY item
 * in the group failed when one record was rejected — and on retry the same bad
 * record failed them all again, until the whole set reached the DLQ. One
 * malformed document could therefore stop indexing for an unbounded number of
 * unrelated products, which is exactly what happened on 2026-07-24.
 *
 * Now a rejected chunk is retried one record at a time. The offender is the
 * only item marked failed; everything else indexes normally and the queue
 * continues. Costs one extra round trip per record only in the rare failing
 * chunk — the happy path is unchanged.
 */
async function _flushIsolating(algolia, db, indexName, tuples, send, label) {
  for (const chunk of _chunk(tuples, ALGOLIA_BATCH)) {
    try {
      await send(indexName, chunk.map(t => t.obj));
      for (const { item } of chunk) await _markDone(db, item.queueId);
      continue;
    } catch (err) {
      console.error(
        `[AlgoliaQueue] ${label} batch of ${chunk.length} rejected (${err.message}) — ` +
        'retrying individually so one bad record cannot block the rest'
      );
    }
    let recovered = 0;
    for (const t of chunk) {
      try {
        await send(indexName, [t.obj]);
        await _markDone(db, t.item.queueId);
        recovered++;
      } catch (e2) {
        console.error(
          `[AlgoliaQueue] ${label} FAILED objectID=${t.obj && t.obj.objectID} ` +
          `(${t.item.collection}/${t.item.docId}) — ${e2.message}`
        );
        await _handleFailure(db, t.item, e2.message);
      }
    }
    console.warn(
      `[AlgoliaQueue] ${label} isolation: ${recovered}/${chunk.length} recovered, ` +
      `${chunk.length - recovered} isolated`
    );
  }
}

async function _processGroup(algolia, db, groupKey, entries) {
  const [indexName, operation] = groupKey.split(':');

  /* Build Algolia objects */
  const transformed = [];
  const toDelete    = [];

  for (const { item } of entries) {
    try {
      if (operation === 'delete') {
        toDelete.push(item.docId);
      } else if (operation === 'partial' && item.beforeData && item.data) {
        const partial = buildPartialUpdate(item.beforeData, item.data, item.collection, item.docId);
        if (partial) transformed.push({ item, obj: partial, isPartial: true });
        // If no diff detected, still mark as done (noop)
        else await _markDone(db, item.queueId);
      } else {
        const mapping = COLLECTION_INDEX_MAP[item.collection];
        if (!mapping) continue;
        const obj = mapping.transformer(item.docId, item.data || {});
        if (obj) transformed.push({ item, obj, isPartial: false });
      }
    } catch (err) {
      console.error(`[AlgoliaQueue] Transform error for ${item.queueId}:`, err.message);
      await _handleFailure(db, item, err.message);
    }
  }

  /* ── Sanitise before batching ──────────────────────────────────────────
     Algolia rejects the WHOLE batch when one record is over 10,000 bytes, so a
     single malformed document used to stall indexing for every product queued
     beside it — observed 2026-07-24, 26+ consecutive upserts failing on one
     product carrying a 195KB base64 image.

     Every record is now sanitised with the same helpers the backfill uses, and
     anything still oversized is failed INDIVIDUALLY here rather than being
     allowed into a shared batch. A malformed document degrades itself, never
     its neighbours. */
  const batchable = [];
  for (const t of transformed) {
    const clean = sanitizeRecord(t.obj);
    if (clean.actions.length) {
      console.warn(
        `[AlgoliaQueue] sanitised objectID=${t.obj.objectID} ` +
        `(${t.item.collection}/${t.item.docId}) → ${clean.bytes} bytes: ${clean.actions.join('; ')}`
      );
    }
    if (!clean.ok) {
      console.error(
        `[AlgoliaQueue] OVERSIZED objectID=${t.obj.objectID} ` +
        `(${t.item.collection}/${t.item.docId}) — ${clean.reason}. ` +
        'Isolated; the rest of the batch is unaffected.'
      );
      await _handleFailure(db, t.item, `oversized record: ${clean.reason}`);
      continue;
    }
    t.obj = clean.record;
    batchable.push(t);
  }
  transformed.length = 0;
  transformed.push(...batchable);

  /* Batch delete */
  if (toDelete.length > 0) {
    try {
      for (const chunk of _chunk(toDelete, ALGOLIA_BATCH)) {
        await algolia.deleteObjects(indexName, chunk);
      }
      for (const { item } of entries.filter(e => e.item.operation === 'delete')) {
        await _markDone(db, item.queueId);
      }
    } catch (err) {
      for (const { item } of entries.filter(e => e.item.operation === 'delete')) {
        await _handleFailure(db, item, err.message);
      }
    }
  }

  /* Batch upsert (full) */
  const fullUpserts = transformed.filter(t => !t.isPartial);
  if (fullUpserts.length > 0) {
    await _flushIsolating(algolia, db, indexName, fullUpserts,
      (idx, objs) => algolia.saveObjects(idx, objs), 'upsert');
  }

  /* Batch partial update */
  const partials = transformed.filter(t => t.isPartial);
  if (partials.length > 0) {
    await _flushIsolating(algolia, db, indexName, partials,
      (idx, objs) => algolia.partialUpdateObjects(idx, objs), 'partial');
  }

  /* Handle re-queued items (changed while processing) */
  const requeued = entries.filter(({ item }) => item._requeue);
  for (const { item } of requeued) {
    await _db().collection('algoliaQueue').doc(item.queueId).update({
      status:    'pending',
      _requeue:  admin.firestore.FieldValue.delete(),
      updatedAt: _now(),
    });
  }
}

/* ── Mark an item as successfully processed ─────────────────────────── */
async function _markDone(db, queueId) {
  await db.collection('algoliaQueue').doc(queueId).update({
    status:    'done',
    error:     null,
    updatedAt: _now(),
  });
}

/* ── Handle a failure — retry or DLQ ───────────────────────────────── */
async function _handleFailure(db, item, errorMsg) {
  const attempts = (item.attempts || 0) + 1;

  if (attempts >= MAX_ATTEMPTS) {
    /* Move to DLQ */
    await db.collection('algoliaQueueDLQ').doc(item.queueId).set({
      ...item,
      status:       'dlq',
      error:        errorMsg,
      failedAt:     _now(),
      originalData: item.data,
    });
    await db.collection('algoliaQueue').doc(item.queueId).update({
      status:    'dlq',
      attempts,
      error:     errorMsg,
      updatedAt: _now(),
    });
    console.error(`[AlgoliaQueue] DLQ: ${item.queueId} after ${attempts} attempts — ${errorMsg}`);
    return;
  }

  /* Schedule retry with exponential backoff */
  const delaySeconds   = RETRY_DELAYS[Math.min(attempts, RETRY_DELAYS.length - 1)];
  const nextAttemptAt  = admin.firestore.Timestamp.fromMillis(Date.now() + delaySeconds * 1000);

  await db.collection('algoliaQueue').doc(item.queueId).update({
    status:        'failed',
    attempts,
    error:         errorMsg,
    nextAttemptAt,
    updatedAt:     _now(),
  });
}

/* ══════════════════════════════════════════════════════════════════════
   DLQ REPROCESS  — admin-triggered retry of dead-letter queue items
══════════════════════════════════════════════════════════════════════ */

const algoliaReprocessDLQ = onCall(
  { secrets: [ALGOLIA_ADMIN_KEY], timeoutSeconds: 120 },
  async (request) => {
    if (!request.auth?.token?.admin) throw new HttpsError('permission-denied', 'Admin only.');

    const db   = _db();
    const snap = await db.collection('algoliaQueueDLQ')
      .where('status', '==', 'dlq')
      .limit(500)
      .get();

    if (snap.empty) return { requeued: 0 };

    const batch = db.batch();
    snap.docs.forEach(doc => {
      const item = doc.data();
      const ref  = db.collection('algoliaQueue').doc(item.queueId);
      batch.set(ref, {
        ...item,
        status:        'pending',
        attempts:      0,
        nextAttemptAt: admin.firestore.Timestamp.now(),
        error:         null,
        updatedAt:     _now(),
      });
      /* Remove from DLQ */
      batch.delete(doc.ref);
    });
    await batch.commit();
    return { requeued: snap.size };
  }
);

/* ══════════════════════════════════════════════════════════════════════
   QUEUE MONITOR  — daily health check, alerts admin on DLQ depth
══════════════════════════════════════════════════════════════════════ */

const algoliaQueueMonitor = onSchedule(
  {
    schedule:       'every day 06:00',
    timeoutSeconds: 60,
    secrets:        [ALGOLIA_ADMIN_KEY],
  },
  async () => {
    const db = _db();

    const [pendingSnap, failedSnap, dlqSnap] = await Promise.all([
      db.collection('algoliaQueue').where('status', '==', 'pending').count().get(),
      db.collection('algoliaQueue').where('status', '==', 'failed').count().get(),
      db.collection('algoliaQueue').where('status', '==', 'dlq').count().get(),
    ]);

    const stats = {
      pending: pendingSnap.data().count,
      failed:  failedSnap.data().count,
      dlq:     dlqSnap.data().count,
      ts:      new Date().toISOString(),
    };

    console.log('[AlgoliaQueue] Daily health:', stats);

    /* Persist stats for admin dashboard */
    await db.collection('platformMetrics').doc('algoliaQueue').set(stats, { merge: true });

    /* Alert if DLQ is growing */
    if (stats.dlq > 50) {
      await db.collection('adminAlerts').add({
        type:     'algolia_dlq_depth',
        severity: stats.dlq > 500 ? 'critical' : 'warning',
        message:  `Algolia DLQ has ${stats.dlq} items — manual review required`,
        stats,
        createdAt: _now(),
      });
    }

    /*
     * Recover items stuck in 'processing' status.
     * This happens when the Cloud Function times out (max 540s) before
     * completing a batch. Anything processing for > 15 min is assumed dead
     * and reset to 'pending' so the next queue run picks it up.
     */
    const stuckCutoff = admin.firestore.Timestamp.fromMillis(Date.now() - 15 * 60 * 1000);
    const stuckSnap   = await db.collection('algoliaQueue')
      .where('status', '==', 'processing')
      .where('updatedAt', '<', stuckCutoff)
      .limit(500)
      .get();

    if (!stuckSnap.empty) {
      const stuckBatch = db.batch();
      stuckSnap.docs.forEach(d => {
        stuckBatch.update(d.ref, {
          status:        'pending',
          nextAttemptAt: admin.firestore.Timestamp.now(),
          error:         'Reset from stuck processing state (CF timeout)',
          updatedAt:     _now(),
        });
      });
      await stuckBatch.commit();
      console.warn(`[AlgoliaQueue] Reset ${stuckSnap.size} stuck-processing items to pending`);

      if (stuckSnap.size > 10) {
        await db.collection('adminAlerts').add({
          type:     'algolia_queue_stuck',
          severity: 'warning',
          message:  `${stuckSnap.size} queue items were stuck in processing (likely CF timeout)`,
          count:    stuckSnap.size,
          createdAt: _now(),
        });
      }
    }

    /* Auto-purge done items older than 7 days to keep collection lean */
    const cutoff = admin.firestore.Timestamp.fromMillis(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const doneSnap = await db.collection('algoliaQueue')
      .where('status', '==', 'done')
      .where('updatedAt', '<', cutoff)
      .limit(2000)
      .get();

    if (!doneSnap.empty) {
      const purge = db.batch();
      doneSnap.docs.forEach(d => purge.delete(d.ref));
      await purge.commit();
      console.log(`[AlgoliaQueue] Purged ${doneSnap.size} done items`);
    }
  }
);

module.exports = {
  enqueue,
  processAlgoliaQueue,
  algoliaReprocessDLQ,
  algoliaQueueMonitor,
};
