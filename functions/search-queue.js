/**
 * SOKONI Search Queue Manager — Unified Control Plane
 *
 * Provides a single interface over both `algoliaQueue` and `typesenseQueue`
 * Firestore collections. This module does NOT process the queues; that is the
 * responsibility of algolia-queue.js (processAlgoliaQueue) and
 * typesense-queue.js (processTypesenseQueue). Its purpose is orchestration,
 * observability, and emergency control.
 *
 * Exports:
 *   enqueueToAll(item)              — add to both queues atomically
 *   getQueueStats()                 — Callable: read-only queue depth + DLQ
 *   purgeCompleted(olderThanMs)     — Callable: delete done items
 *   pauseQueue(engine)              — Callable: set pause flag in Firestore
 *   resumeQueue(engine)             — Callable: clear pause flag
 *   redriveFromDLQ(engine, limit)   — Callable: move DLQ items back to pending
 *
 * Queue pause/resume flags are stored at:
 *   searchConfig/queueControl  { algoliaPaused: bool, typesensePaused: bool }
 * Processors (algolia-queue.js, typesense-queue.js) MUST check this flag at
 * the start of each scheduled run.
 *
 * All callable CFs enforce admin-only access via request.auth.token.admin.
 *
 * Firestore collections consumed:
 *   algoliaQueue        — Algolia pending / processing / done / failed items
 *   algoliaQueueDLQ     — Algolia dead-letter queue
 *   typesenseQueue      — Typesense pending / processing / done / failed items
 *   typesenseQueueDLQ   — Typesense dead-letter queue
 *   searchConfig        — Queue control flags
 */

'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret }       = require('firebase-functions/params');
const { getFirestore, FieldValue, Timestamp } = require('firebase-admin/firestore');
const admin = require('firebase-admin');
/* firebase-admin has no .logger export — logger.* threw
   'Cannot read properties of undefined' on every call. */
const logger = require('firebase-functions/logger');

if (!admin.apps.length) admin.initializeApp();

const { enqueue: algoliaEnqueue } = require('./algolia-queue');
const { enqueue: typesenseEnqueue, PRIORITY } = require('./typesense-queue');

/* ── Secrets ──────────────────────────────────────────────────────────── */

const ALGOLIA_ADMIN_KEY  = defineSecret('ALGOLIA_ADMIN_KEY');
const TYPESENSE_ADMIN_KEY = defineSecret('TYPESENSE_ADMIN_KEY');

/* ── Constants ────────────────────────────────────────────────────────── */

const ALGOLIA_QUEUE_COL   = 'algoliaQueue';
const ALGOLIA_DLQ_COL     = 'algoliaQueueDLQ';
const TYPESENSE_QUEUE_COL = 'typesenseQueue';
const TYPESENSE_DLQ_COL   = 'typesenseQueueDLQ';
const QUEUE_CONFIG_DOC    = 'searchConfig/queueControl';

/** Valid engine identifiers accepted by control callables */
const VALID_ENGINES = new Set(['algolia', 'typesense', 'both']);

/* ── Helpers ──────────────────────────────────────────────────────────── */

/** @returns {import('firebase-admin/firestore').Firestore} */
function _db() { return getFirestore(); }

/**
 * Splits an array into fixed-size chunks.
 * @template T
 * @param {T[]}    arr
 * @param {number} size
 * @returns {T[][]}
 */
function _chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * Asserts the caller is an authenticated admin.
 * @param {object} request - Firebase Functions v2 callable request
 * @throws {HttpsError} permission-denied if not admin
 */
function _assertAdmin(request) {
  if (!request.auth?.token?.admin) {
    throw new HttpsError('permission-denied', 'Admin authentication required.');
  }
}

/**
 * Validates that the engine parameter is one of the accepted values.
 * @param {string|undefined} engine
 * @param {boolean}          allowBoth - whether 'both' is a valid value
 * @throws {HttpsError} invalid-argument
 */
function _assertEngine(engine, allowBoth = true) {
  const valid = allowBoth ? VALID_ENGINES : new Set(['algolia', 'typesense']);
  if (!engine || !valid.has(engine)) {
    throw new HttpsError(
      'invalid-argument',
      `engine must be one of: ${[...valid].join(', ')}. Received: "${engine}"`
    );
  }
}

/**
 * Count documents in a collection matching a single-field equality filter.
 * Uses Firestore server-side COUNT aggregate.
 *
 * @param {string} col    - Collection name
 * @param {string} field  - Field to filter on
 * @param {*}      value  - Expected value
 * @returns {Promise<number>}
 */
async function _countWhere(col, field, value) {
  const snap = await _db().collection(col).where(field, '==', value).count().get();
  return snap.data().count;
}

/* ═══════════════════════════════════════════════════════════════════════════
   enqueueToAll — PUBLIC HELPER (non-callable)
   Enqueues a document change to BOTH algoliaQueue and typesenseQueue in
   parallel. Errors from one engine are captured independently of the other.
════════════════════════════════════════════════════════════════════════════ */

/**
 * Enqueues a single item into both Algolia and Typesense queues simultaneously.
 * Intended for use by background jobs and admin tools that need to bypass the
 * Firestore trigger path (e.g. bulk re-index, admin-initiated re-sync).
 *
 * @param {{
 *   collection:  string,
 *   docId:       string,
 *   operation:   'upsert'|'partial'|'delete',
 *   data?:       object|null,
 *   beforeData?: object|null,
 *   priority?:   number,
 * }} item
 * @returns {Promise<{
 *   algolia:    boolean,
 *   typesense:  boolean,
 *   errors:     string[],
 * }>}
 */
async function enqueueToAll(item) {
  if (!item || !item.collection || !item.docId || !item.operation) {
    throw new Error('[SearchQueue] enqueueToAll: collection, docId, and operation are required');
  }

  const errors = [];

  const [algoliaResult, typesenseResult] = await Promise.allSettled([
    algoliaEnqueue({
      collection:  item.collection,
      docId:       item.docId,
      operation:   item.operation,
      data:        item.data   || null,
      beforeData:  item.beforeData || null,
    }),
    typesenseEnqueue({
      collection:  item.collection,
      docId:       item.docId,
      /* Typesense queue does not support 'partial'; map to 'upsert' */
      operation:   item.operation === 'partial' ? 'upsert' : item.operation,
      data:        item.data   || null,
      beforeData:  item.beforeData || null,
      priority:    item.priority !== undefined ? item.priority : PRIORITY.NORMAL,
    }),
  ]);

  const algoliaOk   = algoliaResult.status === 'fulfilled';
  const typesenseOk = typesenseResult.status === 'fulfilled';

  if (!algoliaOk) {
    const msg = algoliaResult.reason?.message || String(algoliaResult.reason);
    errors.push(`[Algolia] ${msg}`);
    logger.error('[SearchQueue] Algolia enqueue failed', {
      collection: item.collection,
      docId:      item.docId,
      error:      msg,
    });
  }

  if (!typesenseOk) {
    const msg = typesenseResult.reason?.message || String(typesenseResult.reason);
    errors.push(`[Typesense] ${msg}`);
    logger.error('[SearchQueue] Typesense enqueue failed', {
      collection: item.collection,
      docId:      item.docId,
      error:      msg,
    });
  }

  return { algolia: algoliaOk, typesense: typesenseOk, errors };
}

/* ═══════════════════════════════════════════════════════════════════════════
   getQueueStats — Admin Callable
   Returns current queue depth and DLQ size for both engines plus a combined
   summary. All counts are computed server-side using Firestore COUNT aggregates
   to minimise read cost.
════════════════════════════════════════════════════════════════════════════ */

/**
 * Returns queue depth statistics for both engines.
 * Callable: admin only.
 *
 * Response shape:
 * {
 *   algolia:  { pending, processing, done, failed, dlq },
 *   typesense:{ pending, processing, done, failed, dlq },
 *   combined: { pending, processing, done, failed, dlq, total },
 *   pauseFlags: { algoliaPaused, typesensePaused },
 *   recordedAt: ISO string,
 * }
 */
const getQueueStats = onCall(
  {
    secrets:        [ALGOLIA_ADMIN_KEY, TYPESENSE_ADMIN_KEY],
    timeoutSeconds: 60,
    memory:         '256MiB',
  },
  async request => {
    _assertAdmin(request);

    const db = _db();

    /* Run all 10 COUNT queries + config fetch in parallel */
    const [
      aPending, aProcessing, aDone, aFailed, aDlq,
      tPending, tProcessing, tDone, tFailed, tDlq,
      configSnap,
    ] = await Promise.all([
      _countWhere(ALGOLIA_QUEUE_COL,   'status', 'pending'),
      _countWhere(ALGOLIA_QUEUE_COL,   'status', 'processing'),
      _countWhere(ALGOLIA_QUEUE_COL,   'status', 'done'),
      _countWhere(ALGOLIA_QUEUE_COL,   'status', 'failed'),
      db.collection(ALGOLIA_DLQ_COL).count().get().then(s => s.data().count),

      _countWhere(TYPESENSE_QUEUE_COL, 'status', 'pending'),
      _countWhere(TYPESENSE_QUEUE_COL, 'status', 'processing'),
      _countWhere(TYPESENSE_QUEUE_COL, 'status', 'done'),
      _countWhere(TYPESENSE_QUEUE_COL, 'status', 'failed'),
      db.collection(TYPESENSE_DLQ_COL).count().get().then(s => s.data().count),

      db.doc(QUEUE_CONFIG_DOC).get(),
    ]);

    const pauseFlags = configSnap.exists
      ? {
          algoliaPaused:   Boolean(configSnap.data().algoliaPaused),
          typesensePaused: Boolean(configSnap.data().typesensePaused),
        }
      : { algoliaPaused: false, typesensePaused: false };

    const algolia   = { pending: aPending, processing: aProcessing, done: aDone, failed: aFailed, dlq: aDlq };
    const typesense = { pending: tPending, processing: tProcessing, done: tDone, failed: tFailed, dlq: tDlq };

    const combined = {
      pending:    aPending    + tPending,
      processing: aProcessing + tProcessing,
      done:       aDone       + tDone,
      failed:     aFailed     + tFailed,
      dlq:        aDlq        + tDlq,
      total:      (aPending + aProcessing + aDone + aFailed + aDlq) +
                  (tPending + tProcessing + tDone + tFailed + tDlq),
    };

    const stats = { algolia, typesense, combined, pauseFlags, recordedAt: new Date().toISOString() };

    /* Persist latest stats snapshot for dashboard reads without re-querying */
    await db.doc('searchConfig/queueStats').set({ ...stats, updatedAt: FieldValue.serverTimestamp() });

    logger.info('[SearchQueue] Stats snapshot recorded', {
      combinedPending: combined.pending,
      combinedDlq:     combined.dlq,
    });

    return stats;
  }
);

/* ═══════════════════════════════════════════════════════════════════════════
   purgeCompleted — Admin Callable
   Deletes 'done' items older than the supplied threshold from one or both
   queues. Runs in Firestore batch deletes (500 per commit).
════════════════════════════════════════════════════════════════════════════ */

/**
 * Deletes completed queue items older than `olderThanMs` milliseconds.
 * Callable: admin only.
 *
 * Request data: { olderThanMs?: number, engine?: 'algolia'|'typesense'|'both' }
 * Response:     { algoliaDeleted: number, typesenseDeleted: number }
 */
const purgeCompleted = onCall(
  {
    secrets:        [ALGOLIA_ADMIN_KEY, TYPESENSE_ADMIN_KEY],
    timeoutSeconds: 120,
    memory:         '256MiB',
  },
  async request => {
    _assertAdmin(request);

    const olderThanMs = Number(request.data?.olderThanMs) || 7 * 24 * 60 * 60 * 1000; // default: 7 days
    const engine      = request.data?.engine || 'both';
    _assertEngine(engine);

    if (olderThanMs < 60_000) {
      throw new HttpsError('invalid-argument', 'olderThanMs must be at least 60 000 ms (1 minute).');
    }

    const db      = _db();
    const cutoffMs = Date.now() - olderThanMs;

    /**
     * Purge done items from a single queue collection.
     * algoliaQueue uses Firestore Timestamps for updatedAt;
     * typesenseQueue uses epoch milliseconds for doneAt.
     *
     * @param {string} col         - Queue collection name
     * @param {string} tsField     - Timestamp field name ('updatedAt' | 'doneAt')
     * @param {boolean} useTimestamp - true = Firestore Timestamp; false = number
     * @returns {Promise<number>}
     */
    async function _purgeQueue(col, tsField, useTimestamp) {
      const cutoff = useTimestamp
        ? Timestamp.fromMillis(cutoffMs)
        : cutoffMs;

      const snap = await db.collection(col)
        .where('status', '==', 'done')
        .where(tsField, '<', cutoff)
        .limit(2000)
        .get();

      if (snap.empty) return 0;

      let deleted = 0;
      for (const batch_docs of _chunk(snap.docs, 500)) {
        const batch = db.batch();
        batch_docs.forEach(d => batch.delete(d.ref));
        await batch.commit();
        deleted += batch_docs.length;
      }
      return deleted;
    }

    let algoliaDeleted   = 0;
    let typesenseDeleted = 0;

    const tasks = [];
    if (engine === 'algolia' || engine === 'both') {
      tasks.push(
        _purgeQueue(ALGOLIA_QUEUE_COL, 'updatedAt', true).then(n => { algoliaDeleted = n; })
      );
    }
    if (engine === 'typesense' || engine === 'both') {
      tasks.push(
        _purgeQueue(TYPESENSE_QUEUE_COL, 'doneAt', false).then(n => { typesenseDeleted = n; })
      );
    }

    await Promise.all(tasks);

    logger.info('[SearchQueue] purgeCompleted', {
      engine,
      olderThanMs,
      algoliaDeleted,
      typesenseDeleted,
    });

    return { algoliaDeleted, typesenseDeleted };
  }
);

/* ═══════════════════════════════════════════════════════════════════════════
   pauseQueue — Admin Callable
   Sets a pause flag in Firestore. Each queue processor (algolia-queue.js,
   typesense-queue.js) MUST check this flag and return early when set.
════════════════════════════════════════════════════════════════════════════ */

/**
 * Pauses processing for one or both queue engines.
 * Callable: admin only.
 *
 * Request data: { engine: 'algolia'|'typesense'|'both', reason?: string }
 * Response:     { paused: string[], configPath: string }
 */
const pauseQueue = onCall(
  {
    secrets:        [ALGOLIA_ADMIN_KEY, TYPESENSE_ADMIN_KEY],
    timeoutSeconds: 30,
    memory:         '256MiB',
  },
  async request => {
    _assertAdmin(request);

    const engine = request.data?.engine;
    _assertEngine(engine);

    const reason  = String(request.data?.reason || 'Admin pause').slice(0, 500);
    const pausedAt = FieldValue.serverTimestamp();
    const pausedBy = request.auth.uid;
    const paused   = [];
    const update   = { reason, pausedAt, pausedBy };

    if (engine === 'algolia' || engine === 'both') {
      update.algoliaPaused   = true;
      update.algoliaPausedAt = pausedAt;
      paused.push('algolia');
    }
    if (engine === 'typesense' || engine === 'both') {
      update.typesensePaused   = true;
      update.typesensePausedAt = pausedAt;
      paused.push('typesense');
    }

    await _db().doc(QUEUE_CONFIG_DOC).set(update, { merge: true });

    logger.warn('[SearchQueue] Queue PAUSED', { engine, reason, pausedBy });

    await _db().collection('adminAlerts').add({
      type:      'search_queue_paused',
      severity:  'warning',
      engine,
      reason,
      pausedBy,
      message:   `Search queue paused for: ${paused.join(', ')}. Reason: ${reason}`,
      createdAt: FieldValue.serverTimestamp(),
    });

    return { paused, configPath: QUEUE_CONFIG_DOC };
  }
);

/* ═══════════════════════════════════════════════════════════════════════════
   resumeQueue — Admin Callable
   Clears the pause flag so the scheduled queue processors resume on their
   next invocation (within 1 minute).
════════════════════════════════════════════════════════════════════════════ */

/**
 * Resumes processing for one or both queue engines.
 * Callable: admin only.
 *
 * Request data: { engine: 'algolia'|'typesense'|'both' }
 * Response:     { resumed: string[], configPath: string }
 */
const resumeQueue = onCall(
  {
    secrets:        [ALGOLIA_ADMIN_KEY, TYPESENSE_ADMIN_KEY],
    timeoutSeconds: 30,
    memory:         '256MiB',
  },
  async request => {
    _assertAdmin(request);

    const engine = request.data?.engine;
    _assertEngine(engine);

    const resumedBy = request.auth.uid;
    const resumed   = [];
    const update    = {
      resumedBy,
      resumedAt: FieldValue.serverTimestamp(),
    };

    if (engine === 'algolia' || engine === 'both') {
      update.algoliaPaused    = false;
      update.algoliaPausedAt  = FieldValue.delete();
      resumed.push('algolia');
    }
    if (engine === 'typesense' || engine === 'both') {
      update.typesensePaused   = false;
      update.typesensePausedAt = FieldValue.delete();
      resumed.push('typesense');
    }

    await _db().doc(QUEUE_CONFIG_DOC).set(update, { merge: true });

    logger.info('[SearchQueue] Queue RESUMED', { engine, resumedBy });

    return { resumed, configPath: QUEUE_CONFIG_DOC };
  }
);

/* ═══════════════════════════════════════════════════════════════════════════
   redriveFromDLQ — Admin Callable
   Moves items from the dead-letter queue back to the main queue with reset
   attempt counters. Both Algolia and Typesense DLQs are supported.

   algoliaQueueDLQ items use status: 'dlq'.
   typesenseQueueDLQ items use status: 'failed'.
════════════════════════════════════════════════════════════════════════════ */

/**
 * Re-drives dead-letter queue items back into the main queue for reprocessing.
 * Callable: admin only.
 *
 * Request data: {
 *   engine:      'algolia'|'typesense',
 *   limit?:      number (1–500, default 100),
 *   collection?: string (optional: filter by Firestore collection name),
 * }
 * Response: { requeued: number, engine: string }
 */
const redriveFromDLQ = onCall(
  {
    secrets:        [ALGOLIA_ADMIN_KEY, TYPESENSE_ADMIN_KEY],
    timeoutSeconds: 120,
    memory:         '256MiB',
  },
  async request => {
    _assertAdmin(request);

    const engine = request.data?.engine;
    _assertEngine(engine, false /* 'both' not allowed — caller must specify one engine */);

    const limit      = Math.min(Math.max(parseInt(request.data?.limit) || 100, 1), 500);
    const filterCol  = request.data?.collection || null;

    const isAlgolia    = engine === 'algolia';
    const dlqCol       = isAlgolia ? ALGOLIA_DLQ_COL   : TYPESENSE_DLQ_COL;
    const queueCol     = isAlgolia ? ALGOLIA_QUEUE_COL  : TYPESENSE_QUEUE_COL;

    /*
     * algoliaQueueDLQ marks items status: 'dlq'
     * typesenseQueueDLQ marks items status: 'failed'
     */
    const dlqStatus = isAlgolia ? 'dlq' : 'failed';

    const db = _db();
    let query = db.collection(dlqCol).where('status', '==', dlqStatus).limit(limit);
    if (filterCol) {
      query = query.where('collection', '==', filterCol);
    }

    const snap = await query.get();
    if (snap.empty) {
      logger.info('[SearchQueue] redriveFromDLQ: DLQ is empty', { engine, filterCol });
      return { requeued: 0, engine };
    }

    let requeued = 0;

    for (const chunk of _chunk(snap.docs, 500)) {
      const batch = db.batch();

      for (const doc of chunk) {
        const item   = doc.data();
        const queueRef = db.collection(queueCol).doc(doc.id);

        if (isAlgolia) {
          /*
           * Algolia queue items use Firestore Timestamps for nextAttemptAt.
           * Re-set to pending with 0 attempts so the next run picks them up.
           */
          batch.set(queueRef, {
            ...item,
            status:        'pending',
            attempts:      0,
            nextAttemptAt: Timestamp.now(),
            error:         null,
            updatedAt:     FieldValue.serverTimestamp(),
            requeuedAt:    FieldValue.serverTimestamp(),
          });
        } else {
          /*
           * Typesense queue items use epoch milliseconds.
           * Remove the DLQ-specific fields that don't belong in the main queue.
           */
          const { ref: _ref, failedAt: _failedAt, lastError: _lastError, ...rest } = item;
          batch.set(queueRef, {
            ...rest,
            status:        'pending',
            attempts:      0,
            nextAttemptAt: Date.now(),
            requeuedAt:    Date.now(),
          });
        }

        /* Remove from DLQ after writing to main queue */
        batch.delete(doc.ref);
        requeued++;
      }

      await batch.commit();
    }

    logger.info('[SearchQueue] redriveFromDLQ complete', { engine, filterCol, requeued });

    return { requeued, engine };
  }
);

/* ═══════════════════════════════════════════════════════════════════════════
   EXPORTS
════════════════════════════════════════════════════════════════════════════ */

module.exports = {
  /** Enqueue a document change to both Algolia and Typesense queues. */
  enqueueToAll,

  /** Callable: return queue depth stats for both engines + combined summary. */
  getQueueStats,

  /** Callable: delete 'done' items older than N ms from one or both queues. */
  purgeCompleted,

  /** Callable: set the pause flag so queue processors stop on next tick. */
  pauseQueue,

  /** Callable: clear the pause flag so queue processors resume. */
  resumeQueue,

  /** Callable: move DLQ items back to pending for one engine. */
  redriveFromDLQ,
};
