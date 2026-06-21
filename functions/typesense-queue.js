/**
 * SOKONI Typesense Priority Queue Processor v2.0
 *
 * Architecture:
 *  - Firestore trigger writes to `typesenseQueue/{collection}_{docId}` (deterministic key = no duplicates)
 *  - 5-tier priority system: URGENT(0) → HIGH(1) → NORMAL(2) → LOW(3) → BATCH(4)
 *  - Scheduled CF drains the queue every minute — processes in priority order, max 10 000 docs/run
 *  - 4 retry attempts: [0, 30, 120, 600] second delays
 *  - Re-queue pattern: if doc updated while processing, `_requeue: true` resets it to pending
 *  - Dead-Letter Queue (DLQ) after all retries exhausted → `typesenseQueueDLQ`
 *  - Daily monitor: alerts if DLQ > 50, purges done items older than 7 days
 *  - Admin callable: reprocess DLQ items, force-retry by collection
 */

'use strict';

const { onSchedule }               = require('firebase-functions/v2/scheduler');
const { onCall, HttpsError }       = require('firebase-functions/v2/https');
const { defineSecret }             = require('firebase-functions/params');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { TypesenseClient, COLLECTION_MAP, _chunk, _sleep } = require('./typesense-client');

const TYPESENSE_ADMIN_KEY = defineSecret('TYPESENSE_ADMIN_KEY');
const TYPESENSE_NODES_VAR = process.env.TYPESENSE_NODES || '';

const QUEUE_COL     = 'typesenseQueue';
const DLQ_COL       = 'typesenseQueueDLQ';
const MAX_ATTEMPTS  = 4;
const BATCH_SIZE    = 10_000;
/* seconds to wait before re-attempting at each failure count */
const RETRY_DELAYS  = [0, 30, 120, 600];

/* ── 5-tier priority ────────────────────────────────────────────────────
   URGENT:  price/stock changes — must be searchable within seconds
   HIGH:    new listings / active status changes
   NORMAL:  metadata edits, description changes
   LOW:     review aggregation, rating updates
   BATCH:   bulk re-index, non-critical fields
──────────────────────────────────────────────────────────────────────── */

const PRIORITY = { URGENT: 0, HIGH: 1, NORMAL: 2, LOW: 3, BATCH: 4 };

function _getPriority(collection, operation, changedFields = []) {
  if (operation === 'delete') return PRIORITY.HIGH;
  const urgentFields = ['price', 'inStock', 'stockQty', 'status', 'active', 'isOpen'];
  if (changedFields.some(f => urgentFields.includes(f))) return PRIORITY.URGENT;
  const highCollections = ['sokoni_products', 'sokoni_events', 'sokoni_restaurants', 'sokoni_jobs'];
  if (highCollections.includes(collection)) {
    if (operation === 'create') return PRIORITY.HIGH;
    return PRIORITY.NORMAL;
  }
  if (collection === 'sokoni_reviews') return PRIORITY.LOW;
  return PRIORITY.NORMAL;
}

/* ── Client factory ─────────────────────────────────────────────────── */

function _makeClient(adminKey) {
  const nodes = TYPESENSE_NODES_VAR
    ? TYPESENSE_NODES_VAR.split(',').map(s => s.trim()).filter(Boolean)
    : ['localhost:8108:http'];
  return new TypesenseClient(nodes, adminKey, {
    timeoutMs:     12_000,
    maxRetries:    1,  /* queue handles outer retries */
    cbThreshold:   3,
    cbCooldownMs:  20_000,
  });
}

/* ═══════════════════════════════════════════════════════════════════
   PUBLIC ENQUEUE HELPER
   Called by typesense-sync.js triggers.
   Also exported for direct use from admin tools.
════════════════════════════════════════════════════════════════════ */

async function enqueue({ collection, docId, operation, data, beforeData, priority }) {
  const db      = getFirestore();
  const tsEntry = COLLECTION_MAP[collection];
  if (!tsEntry) return; /* not a mapped collection */

  const tsCollection = tsEntry.collection;
  const docRef       = db.collection(QUEUE_COL).doc(`${collection}_${docId}`);
  const now          = Date.now();

  /* Detect changed fields for priority escalation */
  let changedFields = [];
  if (beforeData && data) {
    changedFields = Object.keys(data).filter(k => JSON.stringify(data[k]) !== JSON.stringify(beforeData[k]));
  }

  const resolvedPriority = priority !== undefined
    ? priority
    : _getPriority(tsCollection, operation, changedFields);

  const snap = await docRef.get();

  if (snap.exists) {
    const existing = snap.data();
    if (existing.status === 'processing') {
      /* Doc being processed right now — set requeue flag */
      await docRef.update({
        _requeue:      true,
        operation,
        data:          data || null,
        priority:      Math.min(resolvedPriority, existing.priority || PRIORITY.NORMAL),
        updatedAt:     now,
      });
      return;
    }
    /* Overwrite pending item — higher priority wins */
    await docRef.set({
      collection,
      tsCollection,
      docId,
      operation,
      data:          data || null,
      priority:      Math.min(resolvedPriority, existing.priority || PRIORITY.NORMAL),
      attempts:      existing.attempts || 0,
      status:        'pending',
      nextAttemptAt: now,
      createdAt:     existing.createdAt || now,
      updatedAt:     now,
    });
    return;
  }

  /* New queue item */
  await docRef.set({
    collection,
    tsCollection,
    docId,
    operation,
    data:          data || null,
    priority:      resolvedPriority,
    attempts:      0,
    status:        'pending',
    nextAttemptAt: now,
    createdAt:     now,
    updatedAt:     now,
  });
}

/* ═══════════════════════════════════════════════════════════════════
   PROCESS QUEUE — scheduled every 1 minute
════════════════════════════════════════════════════════════════════ */

exports.processTypesenseQueue = onSchedule(
  {
    schedule:       'every 1 minutes',
    timeoutSeconds: 540,
    memory:         '512MiB',
    secrets:        [TYPESENSE_ADMIN_KEY],
  },
  async () => {
    const adminKey = TYPESENSE_ADMIN_KEY.value();
    if (!adminKey || adminKey === 'not_configured') {
      console.warn('[TS Queue] TYPESENSE_ADMIN_KEY not configured — skipping');
      return;
    }

    const db     = getFirestore();
    const ts     = _makeClient(adminKey);
    const nowMs  = Date.now();

    /* Fetch pending items in priority order — up to BATCH_SIZE across all priorities */
    const snap = await db.collection(QUEUE_COL)
      .where('status', '==', 'pending')
      .where('nextAttemptAt', '<=', nowMs)
      .orderBy('nextAttemptAt')
      .orderBy('priority')
      .limit(BATCH_SIZE)
      .get();

    if (snap.empty) return;

    /* Sort in-memory by [priority ASC, nextAttemptAt ASC] for deterministic order */
    const items = snap.docs
      .map(d => ({ ref: d.ref, ...d.data() }))
      .sort((a, b) => (a.priority - b.priority) || (a.nextAttemptAt - b.nextAttemptAt));

    /* Mark all as processing atomically in batches of 500 */
    for (const chunk of _chunk(items, 500)) {
      const batch = db.batch();
      chunk.forEach(item => batch.update(item.ref, { status: 'processing', processingStartedAt: nowMs }));
      await batch.commit();
    }

    /* Group by tsCollection + operation for JSONL batching */
    const groups = new Map(); /* key: "tsCollection:operation" */
    for (const item of items) {
      const key = `${item.tsCollection}:${item.operation}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(item);
    }

    const succeeded = new Set();
    const failed    = new Map(); /* docKey → error */

    for (const [key, group] of groups) {
      const [tsCollection, operation] = key.split(':');
      try {
        await _processGroup(ts, tsCollection, operation, group, succeeded, failed);
      } catch (groupErr) {
        /* Group-level failure — mark all items in group as failed */
        for (const item of group) {
          if (!succeeded.has(item.ref.id)) {
            failed.set(item.ref.id, groupErr.message || String(groupErr));
          }
        }
      }
    }

    /* Finalize: mark done / retry / DLQ */
    const doneSet   = [...succeeded];
    const failedArr = [...failed.entries()];

    /* Mark succeeded */
    for (const chunk of _chunk(doneSet, 500)) {
      const batch = db.batch();
      for (const refId of chunk) {
        const item = items.find(i => i.ref.id === refId);
        if (!item) continue;
        if (item._requeue) {
          batch.update(item.ref, {
            status:        'pending',
            _requeue:      FieldValue.delete(),
            nextAttemptAt: Date.now(),
            processingStartedAt: FieldValue.delete(),
          });
        } else {
          batch.update(item.ref, {
            status:     'done',
            doneAt:     Date.now(),
            processingStartedAt: FieldValue.delete(),
          });
        }
      }
      await batch.commit();
    }

    /* Handle failures */
    for (const [refId, errMsg] of failedArr) {
      const item = items.find(i => i.ref.id === refId);
      if (!item) continue;
      await _handleFailure(db, item, errMsg);
    }

    console.log(`[TS Queue] Run complete. Success: ${succeeded.size}, Failed: ${failed.size}, Total: ${items.length}`);
  }
);

/* ── Process a single tsCollection:operation group ───────────────────── */

async function _processGroup(ts, tsCollection, operation, items, succeeded, failed) {
  if (operation === 'delete') {
    /* Deletes must run individually (Typesense has no bulk delete by ID list) */
    for (const item of items) {
      try {
        await ts.deleteDocument(tsCollection, item.docId);
        succeeded.add(item.ref.id);
      } catch (err) {
        if (err.status === 404) {
          succeeded.add(item.ref.id); /* Already gone — treat as success */
        } else {
          failed.set(item.ref.id, err.message || String(err));
        }
      }
    }
    return;
  }

  /* upsert / create → JSONL batch */
  const tsEntry = Object.values(COLLECTION_MAP).find(m => m.collection === tsCollection);
  const results = await ts.importDocuments(
    tsCollection,
    items
      .map(item => {
        try {
          const doc = tsEntry?.transformer?.(item.docId, item.data || {});
          return doc ? { ...doc, id: item.docId } : null;
        } catch (_) { return null; }
      })
      .filter(Boolean),
    'upsert'
  );

  /* Map results back to items by position */
  let resultIdx = 0;
  for (const item of items) {
    const doc = tsEntry?.transformer?.(item.docId, item.data || {});
    if (!doc) { succeeded.add(item.ref.id); continue; } /* null = intentionally excluded */
    const res = results[resultIdx++];
    if (res && res.success === false) {
      failed.set(item.ref.id, res.error || 'Typesense import error');
    } else {
      succeeded.add(item.ref.id);
    }
  }
}

/* ── Failure handler: retry or DLQ ──────────────────────────────────── */

async function _handleFailure(db, item, errorMsg) {
  const attempts = (item.attempts || 0) + 1;
  if (attempts >= MAX_ATTEMPTS) {
    /* Move to DLQ */
    await db.collection(DLQ_COL).doc(item.ref.id).set({
      ...item,
      status:    'failed',
      failedAt:  Date.now(),
      lastError: errorMsg,
      attempts,
      ref:       undefined,
    });
    await item.ref.delete();
    return;
  }
  const delayMs  = (RETRY_DELAYS[attempts] || 600) * 1000;
  await item.ref.update({
    status:        'pending',
    attempts,
    lastError:     errorMsg,
    nextAttemptAt: Date.now() + delayMs,
    processingStartedAt: FieldValue.delete(),
  });
}

/* ═══════════════════════════════════════════════════════════════════
   REPROCESS DLQ — Admin callable
════════════════════════════════════════════════════════════════════ */

exports.typesenseReprocessDLQ = onCall(
  {
    secrets:        [TYPESENSE_ADMIN_KEY],
    timeoutSeconds: 60,
    memory:         '256MiB',
  },
  async ({ auth, data: callData }) => {
    if (!auth?.token?.admin) throw new HttpsError('permission-denied', 'Admin only');
    const db    = getFirestore();
    const limit = Math.min(parseInt(callData?.limit) || 100, 500);
    let query   = db.collection(DLQ_COL).where('status', '==', 'failed').limit(limit);
    if (callData?.collection) {
      query = query.where('collection', '==', callData.collection);
    }
    const snap   = await query.get();
    if (snap.empty) return { requeued: 0 };

    let requeued = 0;
    for (const chunk of _chunk(snap.docs, 500)) {
      const batch = db.batch();
      for (const doc of chunk) {
        const d = doc.data();
        const qRef = db.collection(QUEUE_COL).doc(doc.id);
        batch.set(qRef, {
          ...d,
          status:        'pending',
          attempts:      0,
          nextAttemptAt: Date.now(),
          requeuedAt:    Date.now(),
          failedAt:      FieldValue.delete(),
        });
        batch.delete(doc.ref);
        requeued++;
      }
      await batch.commit();
    }
    return { requeued };
  }
);

/* ═══════════════════════════════════════════════════════════════════
   FORCE RETRY BY COLLECTION — Admin callable
   Resets all pending items for a given Firestore collection.
════════════════════════════════════════════════════════════════════ */

exports.typesenseForceRetry = onCall(
  {
    secrets:        [TYPESENSE_ADMIN_KEY],
    timeoutSeconds: 60,
    memory:         '256MiB',
  },
  async ({ auth, data: callData }) => {
    if (!auth?.token?.admin) throw new HttpsError('permission-denied', 'Admin only');
    if (!callData?.collection) throw new HttpsError('invalid-argument', 'collection required');
    const db   = getFirestore();
    const snap = await db.collection(QUEUE_COL)
      .where('collection', '==', callData.collection)
      .limit(500).get();
    if (snap.empty) return { reset: 0 };
    const batch = db.batch();
    snap.docs.forEach(d => batch.update(d.ref, {
      status: 'pending', attempts: 0, nextAttemptAt: Date.now(),
    }));
    await batch.commit();
    return { reset: snap.size };
  }
);

/* ═══════════════════════════════════════════════════════════════════
   QUEUE MONITOR — Daily 06:00
   Alerts when DLQ is large, reports queue depth by priority, purges old done items.
════════════════════════════════════════════════════════════════════ */

exports.typesenseQueueMonitor = onSchedule(
  {
    schedule:       'every day 06:00',
    timeoutSeconds: 120,
    memory:         '256MiB',
    secrets:        [TYPESENSE_ADMIN_KEY],
  },
  async () => {
    const db  = getFirestore();
    const now = Date.now();

    /* DLQ depth */
    const dlqSnap = await db.collection(DLQ_COL)
      .where('status', '==', 'failed').limit(1000).get();

    if (dlqSnap.size > 50) {
      await db.collection('adminAlerts').add({
        type:      'typesense_dlq_high',
        count:     dlqSnap.size,
        message:   `Typesense DLQ has ${dlqSnap.size} failed items — manual reprocessing needed`,
        createdAt: now,
        severity:  dlqSnap.size > 500 ? 'critical' : 'warning',
      });
      console.warn(`[TS Monitor] DLQ depth: ${dlqSnap.size}`);
    }

    /* Pending depth by priority */
    const pendingSnap = await db.collection(QUEUE_COL)
      .where('status', '==', 'pending').limit(1000).get();

    const byPriority = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0 };
    pendingSnap.docs.forEach(d => {
      const p = d.data().priority ?? PRIORITY.NORMAL;
      byPriority[p] = (byPriority[p] || 0) + 1;
    });

    /* Stale processing items (stuck > 10 min) */
    const stuckThreshold = now - 10 * 60 * 1000;
    const stuckSnap = await db.collection(QUEUE_COL)
      .where('status', '==', 'processing')
      .where('processingStartedAt', '<', stuckThreshold)
      .limit(200).get();

    if (!stuckSnap.empty) {
      const batch = db.batch();
      stuckSnap.docs.forEach(d => batch.update(d.ref, {
        status: 'pending', nextAttemptAt: now, processingStartedAt: FieldValue.delete(),
      }));
      await batch.commit();
      console.warn(`[TS Monitor] Reset ${stuckSnap.size} stuck processing items`);
    }

    /* Purge done items older than 7 days */
    const cutoff = now - 7 * 86_400_000;
    const doneSnap = await db.collection(QUEUE_COL)
      .where('status', '==', 'done')
      .where('doneAt', '<', cutoff)
      .limit(1000).get();

    if (!doneSnap.empty) {
      for (const chunk of _chunk(doneSnap.docs, 500)) {
        const batch = db.batch();
        chunk.forEach(d => batch.delete(d.ref));
        await batch.commit();
      }
    }

    /* Write stats to Firestore for admin dashboard */
    await db.collection('tsQueueStats').doc('latest').set({
      dlqDepth:          dlqSnap.size,
      pendingByPriority: byPriority,
      pendingTotal:      pendingSnap.size,
      stuckReset:        stuckSnap.size,
      donesPurged:       doneSnap.size,
      recordedAt:        now,
    });

    console.log(`[TS Monitor] DLQ: ${dlqSnap.size}, Pending: ${pendingSnap.size}, Done purged: ${doneSnap.size}`);
  }
);

module.exports.enqueue  = enqueue;
module.exports.PRIORITY = PRIORITY;
