/**
 * SOKONI Search Worker — Unified Queue Coordinator
 *
 * Orchestrates both queue processors (Algolia + Typesense) without duplicating
 * their processing logic. This module is responsible for:
 *
 *  searchQueueCoordinator  — every 2 minutes
 *    Reads pause flags, counts pending items on both queues, writes metrics to
 *    `searchConfig/workerStatus`, and raises admin alerts if either queue exceeds
 *    the depth warning threshold (1 000 items).
 *
 *  searchDLQSweep  — daily at 03:00 Africa/Nairobi
 *    Sweeps dead-letter queues on both engines. Documents with fewer than 3
 *    prior attempts are moved back to their respective pending queues. Runs up
 *    to 100 docs per engine per execution.
 *
 *  searchQueueRecovery  — onCall (admin only)
 *    Manual trigger for admins. Calls both queue processors to handle one
 *    immediate batch. Implemented here via direct Firestore batch-status reset
 *    (rather than invoking other CFs) to ensure atomic, observable recovery.
 *
 * Firestore documents read/written:
 *   searchConfig/queueControl   — { algoliaEnabled, typesenseEnabled }
 *   searchConfig/workerStatus   — metrics written each coordinator run
 *   algoliaQueue                — counted for queue depth
 *   typesenseQueue              — counted for queue depth
 *   algoliaQueueDLQ             — read + deleted during sweep
 *   typesenseQueueDLQ           — read + deleted during sweep
 *   adminAlerts                 — written when queue depth exceeds threshold
 */

'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule }         = require('firebase-functions/v2/scheduler');
const { defineSecret }       = require('firebase-functions/params');
const admin                  = require('firebase-admin');

if (!admin.apps.length) admin.initializeApp();

/* ── Secrets (declared so Cloud Functions runtime resolves them) ──────────── */

const ALGOLIA_ADMIN_KEY   = defineSecret('ALGOLIA_ADMIN_KEY');
const TYPESENSE_ADMIN_KEY = defineSecret('TYPESENSE_ADMIN_KEY');

/* ── Constants ────────────────────────────────────────────────────────────── */

const ALGOLIA_QUEUE_COL     = 'algoliaQueue';
const ALGOLIA_DLQ_COL       = 'algoliaQueueDLQ';
const TYPESENSE_QUEUE_COL   = 'typesenseQueue';
const TYPESENSE_DLQ_COL     = 'typesenseQueueDLQ';
const QUEUE_CONTROL_DOC     = 'searchConfig/queueControl';
const WORKER_STATUS_DOC     = 'searchConfig/workerStatus';

/** Per-engine DLQ items re-queued per sweep run */
const DLQ_SWEEP_LIMIT = 100;
/** Max DLQ retry attempts before a doc is left in DLQ permanently */
const MAX_DLQ_ATTEMPTS = 3;
/** Queue depth that triggers an admin alert */
const DEPTH_ALERT_THRESHOLD = 1_000;

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
 * Count documents matching a status in a queue collection without reading them.
 *
 * @param {string} col
 * @param {string} status
 * @returns {Promise<number>}
 */
async function _countByStatus(col, status) {
  try {
    const snap = await _db().collection(col).where('status', '==', status).count().get();
    return snap.data().count;
  } catch (err) {
    admin.logger.warn(`_countByStatus: failed for ${col}/${status}`, { error: err.message });
    return -1;
  }
}

/**
 * Write an alert to `adminAlerts`.
 *
 * @param {string} message
 * @param {Object} meta
 */
async function _writeAlert(message, meta = {}) {
  try {
    await _db().collection('adminAlerts').add({
      category:  'search',
      severity:  'warning',
      message,
      meta,
      resolved:  false,
      createdAt: _now(),
    });
  } catch (err) {
    admin.logger.error('_writeAlert: failed', { error: err.message });
  }
}

/**
 * Re-queue one DLQ batch for a single engine.
 * Reads up to `limit` docs from the DLQ where `attempts < maxAttempts`,
 * writes them back to the main queue with `status: 'pending'` and
 * incremented attempt count, then deletes from the DLQ.
 *
 * @param {string} dlqCol     - DLQ collection name
 * @param {string} queueCol   - Main queue collection name
 * @param {number} limit      - Max docs to process
 * @param {number} maxAttempts
 * @returns {Promise<{requeued: number, skipped: number}>}
 */
async function _sweepDLQ(dlqCol, queueCol, limit, maxAttempts) {
  const db = _db();
  let requeued = 0;
  let skipped  = 0;

  const dlqSnap = await db
    .collection(dlqCol)
    .where('status', '==', 'dlq')
    .where('attempts', '<', maxAttempts)
    .limit(limit)
    .get();

  if (dlqSnap.empty) return { requeued: 0, skipped: 0 };

  // Process in chunks of 500 to stay within Firestore batch limits
  const docs   = dlqSnap.docs;
  const CHUNK  = 500;

  for (let i = 0; i < docs.length; i += CHUNK) {
    const batch = db.batch();
    const slice = docs.slice(i, i + CHUNK);

    for (const dlqDoc of slice) {
      const data     = dlqDoc.data();
      const attempts = (data.attempts || 0) + 1;

      if (attempts >= maxAttempts) {
        skipped++;
        continue;
      }

      // Write back to main queue — deterministic key matches original
      const queueRef = db.collection(queueCol).doc(dlqDoc.id);
      batch.set(queueRef, {
        ...data,
        status:      'pending',
        attempts,
        requeuedAt:  _now(),
        requeueSource: 'dlq_sweep',
      }, { merge: false });

      // Delete from DLQ
      batch.delete(dlqDoc.ref);
      requeued++;
    }

    await batch.commit();
  }

  return { requeued, skipped };
}

/* ── CF 1: searchQueueCoordinator ─────────────────────────────────────────── */

exports.searchQueueCoordinator = onSchedule(
  {
    schedule:       'every 5 minutes',
    region:         'us-central1',
    timeZone:       'Africa/Nairobi',
    memory:         '256MiB',
    timeoutSeconds: 60,
    secrets:        [ALGOLIA_ADMIN_KEY, TYPESENSE_ADMIN_KEY],
  },
  async () => {
    const db = _db();

    /* ── Read queue control flags ─────────────────────────────────────────── */
    let queueControl = { algoliaEnabled: true, typesenseEnabled: true };
    try {
      const ctrlSnap = await db.doc(QUEUE_CONTROL_DOC).get();
      if (ctrlSnap.exists) {
        const d = ctrlSnap.data();
        queueControl = {
          algoliaEnabled:   d.algoliaEnabled   !== false,
          typesenseEnabled: d.typesenseEnabled !== false,
        };
      }
    } catch (err) {
      admin.logger.warn('searchQueueCoordinator: could not read queueControl', { error: err.message });
    }

    /* ── Count pending items ──────────────────────────────────────────────── */
    const [algoliaDepth, typesenseDepth] = await Promise.all([
      _countByStatus(ALGOLIA_QUEUE_COL,   'pending'),
      _countByStatus(TYPESENSE_QUEUE_COL, 'pending'),
    ]);

    const activeEngines = [
      queueControl.algoliaEnabled   ? 'algolia'   : null,
      queueControl.typesenseEnabled ? 'typesense' : null,
    ].filter(Boolean);

    /* ── Write metrics ────────────────────────────────────────────────────── */
    const metrics = {
      algoliaQueueDepth:   algoliaDepth,
      typesenseQueueDepth: typesenseDepth,
      algoliaEnabled:      queueControl.algoliaEnabled,
      typesenseEnabled:    queueControl.typesenseEnabled,
      activeEngines,
      lastRun:             _now(),
    };

    try {
      await db.doc(WORKER_STATUS_DOC).set(metrics, { merge: true });
    } catch (err) {
      admin.logger.error('searchQueueCoordinator: failed to write workerStatus', { error: err.message });
    }

    /* ── Alert if queue depth exceeds threshold ───────────────────────────── */
    const alerts = [];
    if (algoliaDepth > DEPTH_ALERT_THRESHOLD) {
      alerts.push(_writeAlert(
        `Algolia queue depth ${algoliaDepth} exceeds threshold ${DEPTH_ALERT_THRESHOLD}`,
        { engine: 'algolia', depth: algoliaDepth }
      ));
    }
    if (typesenseDepth > DEPTH_ALERT_THRESHOLD) {
      alerts.push(_writeAlert(
        `Typesense queue depth ${typesenseDepth} exceeds threshold ${DEPTH_ALERT_THRESHOLD}`,
        { engine: 'typesense', depth: typesenseDepth }
      ));
    }
    if (alerts.length) await Promise.all(alerts);

    admin.logger.info('searchQueueCoordinator: complete', {
      algoliaDepth,
      typesenseDepth,
      activeEngines,
    });
  }
);

/* ── CF 2: searchDLQSweep ─────────────────────────────────────────────────── */

exports.searchDLQSweep = onSchedule(
  {
    schedule:       '0 3 * * *',
    region:         'us-central1',
    timeZone:       'Africa/Nairobi',
    memory:         '512MiB',
    timeoutSeconds: 300,
    secrets:        [ALGOLIA_ADMIN_KEY, TYPESENSE_ADMIN_KEY],
  },
  async () => {
    admin.logger.info('searchDLQSweep: starting daily DLQ sweep');

    const [algoliaResult, typesenseResult] = await Promise.allSettled([
      _sweepDLQ(ALGOLIA_DLQ_COL,   ALGOLIA_QUEUE_COL,   DLQ_SWEEP_LIMIT, MAX_DLQ_ATTEMPTS),
      _sweepDLQ(TYPESENSE_DLQ_COL, TYPESENSE_QUEUE_COL, DLQ_SWEEP_LIMIT, MAX_DLQ_ATTEMPTS),
    ]);

    const algoliaSummary = algoliaResult.status === 'fulfilled'
      ? algoliaResult.value
      : { requeued: 0, skipped: 0, error: algoliaResult.reason?.message };

    const typesenseSummary = typesenseResult.status === 'fulfilled'
      ? typesenseResult.value
      : { requeued: 0, skipped: 0, error: typesenseResult.reason?.message };

    admin.logger.info('searchDLQSweep: complete', {
      algolia:   algoliaSummary,
      typesense: typesenseSummary,
    });

    // Persist sweep log for audit
    try {
      await _db().collection('searchDLQSweepLog').add({
        algolia:    algoliaSummary,
        typesense:  typesenseSummary,
        ranAt:      _now(),
      });
    } catch (err) {
      admin.logger.warn('searchDLQSweep: failed to write sweep log', { error: err.message });
    }
  }
);

/* ── CF 3: searchQueueRecovery ────────────────────────────────────────────── */

exports.searchQueueRecovery = onCall(
  {
    region:         'us-central1',
    memory:         '512MiB',
    timeoutSeconds: 120,
    secrets:        [ALGOLIA_ADMIN_KEY, TYPESENSE_ADMIN_KEY],
  },
  async (req) => {
    const uid = _assertAdmin(req);

    const { engine = 'both', batchSize = 50 } = req.data || {};

    const validEngines = new Set(['algolia', 'typesense', 'both']);
    if (!validEngines.has(engine)) {
      throw new HttpsError('invalid-argument', 'engine must be "algolia", "typesense", or "both"');
    }

    const safeLimit = Math.min(Math.max(1, batchSize), 200); // guard: 1–200

    /**
     * Re-mark up to `safeLimit` 'processing' or 'failed' items as 'pending'
     * so the next scheduled queue run picks them up.
     */
    async function _resetStuck(col, limit) {
      const snap = await _db()
        .collection(col)
        .where('status', 'in', ['processing', 'failed'])
        .limit(limit)
        .get();

      if (snap.empty) return 0;

      const batch = _db().batch();
      snap.docs.forEach((doc) => {
        batch.update(doc.ref, {
          status:          'pending',
          recoveredAt:     _now(),
          recoveredBy:     uid,
          recoverySource:  'manual',
        });
      });
      await batch.commit();
      return snap.docs.length;
    }

    const results = {};

    if (engine === 'algolia' || engine === 'both') {
      results.algolia = await _resetStuck(ALGOLIA_QUEUE_COL, safeLimit).catch((err) => ({
        error: err.message,
        reset: 0,
      }));
    }

    if (engine === 'typesense' || engine === 'both') {
      results.typesense = await _resetStuck(TYPESENSE_QUEUE_COL, safeLimit).catch((err) => ({
        error: err.message,
        reset: 0,
      }));
    }

    admin.logger.info('searchQueueRecovery: manual recovery triggered', { uid, engine, results });

    return { success: true, engine, results, triggeredAt: new Date().toISOString() };
  }
);
