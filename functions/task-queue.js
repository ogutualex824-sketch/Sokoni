'use strict';

/**
 * SOKONI Distributed Task Queue & Job Scheduler  v1.0.0
 * ======================================================
 * Background task processing backed by Firestore.
 * All Cloud Functions are exported with the `tq` prefix so they can be
 * cherry-picked into functions/index.js without touching this file.
 *
 * Collections
 * ───────────
 *   _sokoniTaskQueue/{taskId}
 *     type, payload, status, priority, priorityValue,
 *     retryCount, maxRetries, scheduledFor, startedAt,
 *     completedAt, failedAt, errorMessage, result,
 *     workerId, createdAt, createdBy, tags[]
 *
 *   _sokoniWorkers/{workerId}
 *     workerId, lastHeartbeat, tasksProcessed, currentTask,
 *     status, startedAt, completedAt
 *
 * Required Firestore composite indexes
 * ─────────────────────────────────────
 *   Collection: _sokoniTaskQueue
 *   1. status ASC, priority ASC, scheduledFor ASC  (worker processor)
 *   2. status ASC, completedAt DESC                (stats + cleanup)
 *   3. status ASC, cancelledAt ASC                 (cleanup)
 *   4. status ASC, failedAt ASC                    (dead-letter query)
 *
 * @module task-queue
 * @version 1.0.0
 * @since 2026-07-08
 */

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule }         = require('firebase-functions/v2/scheduler');
const functions              = require('firebase-functions/v2');
const admin                  = require('firebase-admin');
const crypto                 = require('crypto');

if (!admin.apps.length) admin.initializeApp();

const db     = () => admin.firestore();
const logger = functions.logger;

const _h = {};

// ─── Constants ────────────────────────────────────────────────────────────────

/** Firestore collection names */
const COL_QUEUE   = '_sokoniTaskQueue';
const COL_WORKERS = '_sokoniWorkers';

/** All recognised task types */
const TASK_TYPES = Object.freeze([
  'SEND_NOTIFICATION',
  'PROCESS_IMAGE',
  'GENERATE_REPORT',
  'SYNC_ANALYTICS',
  'WARM_CACHE',
  'CLEANUP_OLD_DATA',
  'SEND_BULK_EMAIL',
  'INDEX_PRODUCTS',
  'COMPUTE_RECOMMENDATIONS',
  'PROCESS_PAYOUT',
]);

/** Task statuses */
const STATUS = Object.freeze({
  PENDING:     'pending',
  RUNNING:     'running',
  COMPLETED:   'completed',
  CANCELLED:   'cancelled',
  DEAD_LETTER: 'dead_letter',
});

/** Priority labels and their sort values (lower = higher priority) */
const PRIORITY_MAP = Object.freeze({ critical: 0, high: 1, normal: 2, low: 3 });
const PRIORITY_LABELS = Object.freeze(Object.keys(PRIORITY_MAP));

/** Processor batch sizes per priority tier */
const BATCH = Object.freeze({ critical: 10, high: 10, normal: 10, low: 5 });

const DEFAULT_MAX_RETRIES  = 3;
const BULK_ENQUEUE_MAX     = 100;
const CLEANUP_COMPLETED_D  = 7;    // days to retain completed tasks
const CLEANUP_CANCELLED_D  = 1;    // days to retain cancelled tasks
const CLEANUP_WORKER_H     = 1;    // hours to retain idle worker records

/** onCall options — enforce App Check across all TQ endpoints */
const CALL_OPTS  = Object.freeze({ region: 'us-central1', enforceAppCheck: true });
const SCHED_OPTS = Object.freeze({ region: 'us-central1', timeoutSeconds: 540 });

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Firestore server timestamp shorthand */
const _ts = () => admin.firestore.FieldValue.serverTimestamp();

/** Firestore Timestamp from a JS Date */
const _fromDate = (d) => admin.firestore.Timestamp.fromDate(d);

/** Firestore Timestamp for now */
const _nowTs = () => admin.firestore.Timestamp.now();

/** Milliseconds from now as a Timestamp */
const _tsAfterMs = (ms) => _fromDate(new Date(Date.now() + ms));

/** Generate a cryptographically random task ID */
function _taskId(type) {
  const rand = crypto.randomBytes(6).toString('hex');
  return `task_${type.toLowerCase()}_${Date.now()}_${rand}`;
}

/** Generate a worker ID for the current invocation */
function _workerId() {
  return `worker_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
}

/**
 * Exponential backoff: retry n → delay in ms.
 * n=1 → 30 s, n=2 → 120 s, n=3 → 480 s  (capped at 60 min)
 */
function _backoffMs(n) {
  return Math.min(30_000 * Math.pow(4, n - 1), 3_600_000);
}

/** Sanitise a string — strip HTML-injectable chars, enforce max length */
function _san(v, max = 2000) {
  if (typeof v !== 'string') return '';
  return v.replace(/[<>"'`]/g, '').trim().slice(0, max);
}

/** Assert caller is authenticated */
function _requireAuth(auth) {
  if (!auth?.uid) {
    throw new HttpsError('unauthenticated', 'Authentication required.');
  }
}

/** Assert caller holds admin or superAdmin custom claim */
function _requireAdmin(auth) {
  _requireAuth(auth);
  if (!auth.token?.admin && !auth.token?.superAdmin) {
    throw new HttpsError('permission-denied', 'Admin privileges required.');
  }
}

/** Strip secrets from an arbitrary payload object (non-recursive for performance) */
function _maskPayload(payload) {
  if (!payload || typeof payload !== 'object') return payload || {};
  const REDACT = new Set(['password', 'secret', 'token', 'key', 'pin', 'privatekey', 'apikey', 'credential']);
  return Object.fromEntries(
    Object.entries(payload).map(([k, v]) =>
      REDACT.has(k.toLowerCase()) ? [k, '***REDACTED***'] : [k, v]
    )
  );
}

// ─── Task Handlers ────────────────────────────────────────────────────────────
//
// Each handler receives the full task document (plain object).
// Must return a serialisable result object (stored in task.result).
// Throw to signal failure — the processor handles retry/DLQ logic.
//

/**
 * SEND_NOTIFICATION
 * Writes a notification document into `notifications/` so the
 * sokoni-notif-engine picks it up for push/in-app delivery.
 */
async function _handleSendNotification(task) {
  const { userId, title, body, data, channel } = task.payload || {};
  if (!userId) throw new Error('SEND_NOTIFICATION: payload.userId is required.');
  if (!title)  throw new Error('SEND_NOTIFICATION: payload.title is required.');

  const ref = db().collection('notifications').doc();
  await ref.set({
    userId,
    title:   _san(title, 200),
    body:    _san(body || '', 1000),
    data:    data || {},
    channel: channel || 'in_app',
    status:  'pending',
    source:  'task_queue',
    taskId:  task.taskId,
    createdAt: _ts(),
  });

  logger.info('[TQ:SEND_NOTIFICATION] queued', { taskId: task.taskId, userId, channel, notifId: ref.id });
  return { notificationId: ref.id, delivered: false, scheduled: true };
}

/**
 * PROCESS_IMAGE
 * Not yet implemented — throws so the task is routed to retry / dead-letter
 * instead of silently completing with placeholder data.
 * Production: wire to a dedicated image-processing Cloud Function
 * backed by Sharp / Cloud Vision / Imagekit.
 */
async function _handleProcessImage(task) {
  throw new Error('PROCESS_IMAGE handler not yet implemented — wire to image pipeline CF');
}

/**
 * GENERATE_REPORT
 * Creates a job record in `reportJobs/` which the report-generation
 * Cloud Function monitors via Firestore trigger.
 */
async function _handleGenerateReport(task) {
  const { reportType, merchantId, userId, dateRange, format } = task.payload || {};
  if (!reportType) throw new Error('GENERATE_REPORT: payload.reportType is required.');

  const ref = db().collection('reportJobs').doc();
  await ref.set({
    reportType:  _san(reportType, 100),
    merchantId:  merchantId || null,
    userId:      userId     || null,
    dateRange:   dateRange  || null,
    format:      format     || 'pdf',
    status:      'queued',
    source:      'task_queue',
    taskId:      task.taskId,
    createdAt:   _ts(),
  });

  logger.info('[TQ:GENERATE_REPORT] job queued', { taskId: task.taskId, reportType, jobId: ref.id });
  return { reportJobId: ref.id, queued: true };
}

/**
 * SYNC_ANALYTICS
 * Aggregates order analytics for a merchant and upserts a snapshot
 * document in `merchantAnalytics/`.
 */
async function _handleSyncAnalytics(task) {
  const { merchantId, period } = task.payload || {};
  if (!merchantId) throw new Error('SYNC_ANALYTICS: payload.merchantId is required.');

  const targetPeriod = period || 'daily';
  const dateKey      = task.payload.dateKey || new Date().toISOString().split('T')[0];
  const startOfDay   = new Date(dateKey + 'T00:00:00Z');
  const endOfDay     = new Date(dateKey + 'T23:59:59.999Z');

  const ordersSnap = await db()
    .collection('orders')
    .where('merchantId', '==', merchantId)
    .where('status',     '==', 'completed')
    .where('createdAt',  '>=', startOfDay)
    .where('createdAt',  '<',  endOfDay)
    .orderBy('createdAt', 'asc')
    .limit(1000)
    .get();

  let totalRevenue = 0;
  ordersSnap.forEach((d) => { totalRevenue += (d.data().totalAmount || 0); });

  const totalOrders = ordersSnap.size;

  await db()
    .collection('merchantAnalytics')
    .doc(`${merchantId}_${targetPeriod}_${dateKey}`)
    .set(
      {
        merchantId,
        period:        targetPeriod,
        dateKey,
        totalOrders,
        totalRevenue,
        avgOrderValue: totalOrders > 0 ? parseFloat((totalRevenue / totalOrders).toFixed(2)) : 0,
        syncedAt:      _ts(),
        taskId:        task.taskId,
      },
      { merge: true }
    );

  logger.info('[TQ:SYNC_ANALYTICS] snapshot written', { taskId: task.taskId, merchantId, dateKey, totalOrders });
  return { merchantId, period: targetPeriod, dateKey, totalOrders, totalRevenue };
}

/**
 * WARM_CACHE
 * Executes predefined popular queries and writes the result counts
 * into `_sokoniCache/` with a 15-minute TTL so client-side
 * staleWhileRevalidate can serve them instantly.
 */
async function _handleWarmCache(task) {
  const { queries } = task.payload || {};
  const targets     = Array.isArray(queries) && queries.length
    ? queries
    : ['featured_products', 'top_merchants', 'trending_categories'];

  const results   = [];
  const CACHE_TTL = 15 * 60 * 1000; // 15 minutes

  for (const key of targets) {
    try {
      let snap;
      switch (key) {
        case 'featured_products':
          snap = await db().collection('products')
            .where('featured', '==', true)
            .where('status',   '==', 'active')
            .orderBy('salesCount', 'desc')
            .limit(50).get();
          break;
        case 'top_merchants':
          snap = await db().collection('merchants')
            .where('status', '==', 'active')
            .orderBy('rating', 'desc')
            .limit(20).get();
          break;
        case 'trending_categories':
          snap = await db().collection('categories')
            .where('active', '==', true)
            .orderBy('viewCount', 'desc')
            .limit(30).get();
          break;
        default:
          logger.warn('[TQ:WARM_CACHE] unknown query key', { key });
          results.push({ key, status: 'skipped', reason: 'unknown_key' });
          continue;
      }

      await db().collection('_sokoniCache').doc(key).set({
        key,
        count:     snap.size,
        cachedAt:  _ts(),
        expiresAt: _tsAfterMs(CACHE_TTL),
        taskId:    task.taskId,
      });

      results.push({ key, status: 'warmed', count: snap.size });
    } catch (err) {
      logger.error('[TQ:WARM_CACHE] query error', { key, error: err.message });
      results.push({ key, status: 'error', error: err.message });
    }
  }

  const warmedCount = results.filter((r) => r.status === 'warmed').length;
  logger.info('[TQ:WARM_CACHE] complete', { taskId: task.taskId, warmed: warmedCount });
  return { warmed: warmedCount, results };
}

/**
 * CLEANUP_OLD_DATA
 * Deletes stale telemetry/log documents in Firestore in 500-doc batches.
 * Caller specifies which collections and the age threshold.
 */
async function _handleCleanupOldData(task) {
  const { collections: targets, olderThanDays } = task.payload || {};
  const daysThreshold = typeof olderThanDays === 'number' ? olderThanDays : 30;
  const cutoff        = _fromDate(new Date(Date.now() - daysThreshold * 86_400_000));

  const defaultTargets = [
    { name: 'telemetry',  field: 'recordedAt' },
    { name: 'debugLogs',  field: 'createdAt'  },
    { name: 'auditTrail', field: 'createdAt'  },
  ];

  const resolvedTargets = Array.isArray(targets) && targets.length ? targets : defaultTargets;
  const BATCH_SIZE      = 500;
  const summary         = [];

  logger.info('[TQ:CLEANUP_OLD_DATA] start', {
    taskId:    task.taskId,
    daysThreshold,
    collections: resolvedTargets.map((t) => (typeof t === 'string' ? t : t.name)),
  });

  for (const target of resolvedTargets) {
    const colName = typeof target === 'string' ? target : target.name;
    const field   = typeof target === 'string' ? 'createdAt' : (target.field || 'createdAt');
    let   deleted = 0;
    let   hasMore = true;

    while (hasMore) {
      const snap = await db()
        .collection(colName)
        .where(field, '<', cutoff)
        .limit(BATCH_SIZE)
        .get();

      if (snap.empty) { hasMore = false; break; }

      const batch = db().batch();
      snap.docs.forEach((d) => batch.delete(d.ref));
      await batch.commit();
      deleted += snap.size;
      if (snap.size < BATCH_SIZE) hasMore = false;
    }

    summary.push({ collection: colName, deleted });
    logger.info('[TQ:CLEANUP_OLD_DATA] collection done', { collection: colName, deleted });
  }

  return { cutoffDate: new Date(Date.now() - daysThreshold * 86_400_000).toISOString(), collections: summary };
}

/**
 * SEND_BULK_EMAIL
 * Fans out a bulk-email job into individual records in `emailQueue/`
 * that the email-service Cloud Function processes.
 */
async function _handleSendBulkEmail(task) {
  const { recipients, template, subject, data } = task.payload || {};
  if (!Array.isArray(recipients) || recipients.length === 0)
    throw new Error('SEND_BULK_EMAIL: payload.recipients[] is required and non-empty.');
  if (!template)
    throw new Error('SEND_BULK_EMAIL: payload.template is required.');

  const CHUNK = 500;
  let queued  = 0;

  for (let i = 0; i < recipients.length; i += CHUNK) {
    const batch = db().batch();
    recipients.slice(i, i + CHUNK).forEach((r) => {
      const ref  = db().collection('emailQueue').doc();
      const toAddr  = typeof r === 'string' ? r : r.email;
      const rData   = typeof r === 'object'  ? r : {};
      batch.set(ref, {
        to:            _san(toAddr, 254),
        recipientData: rData,
        template:      _san(template, 100),
        subject:       _san(subject || '', 200),
        data:          data || {},
        status:        'pending',
        source:        'bulk_email_task',
        parentTaskId:  task.taskId,
        createdAt:     _ts(),
      });
      queued++;
    });
    await batch.commit();
  }

  logger.info('[TQ:SEND_BULK_EMAIL] queued', { taskId: task.taskId, template, queued });
  return { queued, template, recipientCount: recipients.length };
}

/**
 * INDEX_PRODUCTS
 * Creates a `searchIndexJobs/` record consumed by the enterprise
 * search platform to re-index changed products.
 */
async function _handleIndexProducts(task) {
  const { merchantId, productIds, fullReindex } = task.payload || {};
  const productIdsArr = Array.isArray(productIds) ? productIds : [];
  let   toIndex       = [];

  if (productIdsArr.length > 0) {
    // Fetch in chunks of 10 (Firestore `in` limit)
    for (let i = 0; i < productIdsArr.length; i += 10) {
      const chunk = productIdsArr.slice(i, i + 10);
      const snap  = await db().collection('products')
        .where(admin.firestore.FieldPath.documentId(), 'in', chunk)
        .get();
      snap.forEach((d) => toIndex.push(d.id));
    }
  } else if (merchantId) {
    const snap = await db().collection('products')
      .where('merchantId', '==', merchantId)
      .where('status',     '==', 'active')
      .limit(500).get();
    snap.forEach((d) => toIndex.push(d.id));
  }

  const jobRef = db().collection('searchIndexJobs').doc();
  await jobRef.set({
    productIds:  toIndex,
    merchantId:  merchantId || null,
    fullReindex: fullReindex || false,
    status:      'queued',
    taskId:      task.taskId,
    createdAt:   _ts(),
  });

  logger.info('[TQ:INDEX_PRODUCTS] index job created', { taskId: task.taskId, jobId: jobRef.id, count: toIndex.length });
  return { indexJobId: jobRef.id, productsQueued: toIndex.length, merchantId: merchantId || null };
}

/**
 * COMPUTE_RECOMMENDATIONS
 * Creates a `recommendationJobs/` record consumed by the AI
 * recommendation pipeline to refresh personalised rankings for a
 * user segment.
 */
async function _handleComputeRecommendations(task) {
  const { segmentId, userIds, model } = task.payload || {};

  const jobRef = db().collection('recommendationJobs').doc();
  await jobRef.set({
    segmentId: segmentId || null,
    userIds:   Array.isArray(userIds) ? userIds : [],
    model:     _san(model || 'collaborative_filter_v2', 100),
    status:    'queued',
    source:    'task_queue',
    taskId:    task.taskId,
    createdAt: _ts(),
  });

  logger.info('[TQ:COMPUTE_RECOMMENDATIONS] job created', {
    taskId: task.taskId, jobId: jobRef.id, segmentId, users: (userIds || []).length,
  });
  return { jobId: jobRef.id, segmentId: segmentId || null, usersQueued: (userIds || []).length };
}

/**
 * PROCESS_PAYOUT
 * Validates an approved withdrawal, guards against double-processing via
 * a status transition check inside a transaction, then creates a
 * `payoutJobs/` record for the payment orchestrator.
 */
async function _handleProcessPayout(task) {
  const { withdrawalId, merchantId, amount, currency, method } = task.payload || {};

  if (!withdrawalId) throw new Error('PROCESS_PAYOUT: payload.withdrawalId is required.');
  if (!merchantId)   throw new Error('PROCESS_PAYOUT: payload.merchantId is required.');
  if (typeof amount !== 'number' || amount <= 0)
    throw new Error('PROCESS_PAYOUT: payload.amount must be a positive number.');

  const withdrawalRef = db().collection('withdrawals').doc(withdrawalId);

  // Atomic status transition: approved → processing
  const { alreadyProcessed } = await db().runTransaction(async (tx) => {
    const snap = await tx.get(withdrawalRef);
    if (!snap.exists) throw new Error(`Withdrawal ${withdrawalId} not found.`);

    const w = snap.data();

    // Idempotency guard
    if (w.status === 'processing' || w.status === 'completed') {
      return { alreadyProcessed: true };
    }
    if (w.status !== 'approved') {
      throw new Error(`Withdrawal ${withdrawalId} is not approved (current: ${w.status}).`);
    }

    tx.update(withdrawalRef, {
      status:                'processing',
      processingStartedAt:   _ts(),
      processingTaskId:      task.taskId,
    });
    return { alreadyProcessed: false };
  });

  if (alreadyProcessed) {
    logger.warn('[TQ:PROCESS_PAYOUT] already processing/completed', { withdrawalId });
    return { withdrawalId, status: 'already_processing' };
  }

  const jobRef = db().collection('payoutJobs').doc();
  await jobRef.set({
    withdrawalId,
    merchantId,
    amount,
    currency:  currency || 'KES',
    method:    method   || 'mpesa',
    status:    'queued',
    taskId:    task.taskId,
    createdAt: _ts(),
  });

  logger.info('[TQ:PROCESS_PAYOUT] payout job queued', {
    taskId: task.taskId, withdrawalId, payoutJobId: jobRef.id, amount, currency,
  });
  return { withdrawalId, payoutJobId: jobRef.id, status: 'processing', amount, currency: currency || 'KES' };
}

// ─── Handler Registry ─────────────────────────────────────────────────────────

const HANDLERS = Object.freeze({
  SEND_NOTIFICATION:     _handleSendNotification,
  PROCESS_IMAGE:         _handleProcessImage,
  GENERATE_REPORT:       _handleGenerateReport,
  SYNC_ANALYTICS:        _handleSyncAnalytics,
  WARM_CACHE:            _handleWarmCache,
  CLEANUP_OLD_DATA:      _handleCleanupOldData,
  SEND_BULK_EMAIL:       _handleSendBulkEmail,
  INDEX_PRODUCTS:        _handleIndexProducts,
  COMPUTE_RECOMMENDATIONS: _handleComputeRecommendations,
  PROCESS_PAYOUT:        _handleProcessPayout,
});

// ─── Cloud Functions ──────────────────────────────────────────────────────────

/**
 * tqEnqueue
 * ─────────
 * Add a single task to the queue.
 *
 * Request  { type, payload?, priority?, scheduledFor?, maxRetries?, tags? }
 * Response { taskId, type, priority, scheduledFor, status }
 */
exports.tqEnqueue = onCall(CALL_OPTS, _h.tqEnqueue = async ({ data, auth }) => {
  _requireAuth(auth);

  const {
    type,
    payload      = {},
    priority     = 'normal',
    scheduledFor = null,
    maxRetries   = DEFAULT_MAX_RETRIES,
    tags         = [],
  } = data || {};

  // ── Validate type ──
  if (!type || !TASK_TYPES.includes(type)) {
    throw new HttpsError(
      'invalid-argument',
      `Invalid task type "${type}". Supported: ${TASK_TYPES.join(', ')}.`
    );
  }

  // ── Validate priority ──
  if (!PRIORITY_LABELS.includes(priority)) {
    throw new HttpsError(
      'invalid-argument',
      `Invalid priority "${priority}". Must be one of: ${PRIORITY_LABELS.join(', ')}.`
    );
  }

  // ── Validate / resolve scheduledFor ──
  let scheduledForTs;
  if (scheduledFor) {
    const d = new Date(scheduledFor);
    if (isNaN(d.getTime())) {
      throw new HttpsError('invalid-argument', 'scheduledFor must be a valid ISO 8601 date string.');
    }
    scheduledForTs = _fromDate(d);
  } else {
    scheduledForTs = _nowTs();
  }

  // ── Validate maxRetries ──
  const retries = typeof maxRetries === 'number'
    ? Math.min(Math.max(0, Math.floor(maxRetries)), 10)
    : DEFAULT_MAX_RETRIES;

  // ── Validate tags ──
  const taskTags = Array.isArray(tags)
    ? tags.slice(0, 10).map((t) => _san(String(t), 50))
    : [];

  const taskId = _taskId(type);

  await db().collection(COL_QUEUE).doc(taskId).set({
    taskId,
    type,
    payload:       payload || {},
    status:        STATUS.PENDING,
    priority,
    priorityValue: PRIORITY_MAP[priority],
    retryCount:    0,
    maxRetries:    retries,
    scheduledFor:  scheduledForTs,
    startedAt:     null,
    completedAt:   null,
    failedAt:      null,
    errorMessage:  null,
    result:        null,
    workerId:      null,
    createdAt:     _ts(),
    createdBy:     auth.uid,
    tags:          taskTags,
  });

  logger.info('[TQ] enqueued', { taskId, type, priority });

  return {
    taskId,
    type,
    priority,
    scheduledFor: scheduledForTs.toDate().toISOString(),
    status:       STATUS.PENDING,
  };
});

// ─────────────────────────────────────────────────────────────────────────────

/**
 * tqGetStatus
 * ───────────
 * Retrieve the full status of a task.
 * Non-admin callers must own the task; sensitive payload fields are redacted.
 *
 * Request  { taskId }
 * Response  task document (payload redacted for non-admins)
 */
exports.tqGetStatus = onCall(CALL_OPTS, _h.tqGetStatus = async ({ data, auth }) => {
  _requireAuth(auth);

  const { taskId } = data || {};
  if (!taskId || typeof taskId !== 'string') {
    throw new HttpsError('invalid-argument', 'taskId is required.');
  }

  const snap = await db().collection(COL_QUEUE).doc(_san(taskId, 120)).get();
  if (!snap.exists) {
    throw new HttpsError('not-found', `Task "${taskId}" not found.`);
  }

  const task    = { ...snap.data() };
  const isAdmin = !!(auth.token?.admin || auth.token?.superAdmin);

  if (!isAdmin) {
    if (task.createdBy !== auth.uid) {
      throw new HttpsError('permission-denied', 'You do not own this task.');
    }
    // Redact sensitive payload fields for non-admin callers
    task.payload = _maskPayload(task.payload);
  }

  return task;
});

// ─────────────────────────────────────────────────────────────────────────────

/**
 * tqCancelTask  (admin)
 * ─────────────────────
 * Cancel a task that is currently pending.
 * Running, completed, or dead-letter tasks cannot be cancelled.
 *
 * Request  { taskId }
 * Response { taskId, status, cancelledAt }
 */
exports.tqCancelTask = onCall(CALL_OPTS, _h.tqCancelTask = async ({ data, auth }) => {
  _requireAuth(auth);

  const { taskId } = data || {};
  if (!taskId || typeof taskId !== 'string') {
    throw new HttpsError('invalid-argument', 'taskId is required.');
  }

  const taskRef = db().collection(COL_QUEUE).doc(_san(taskId, 120));

  const cancelledAt = await db().runTransaction(async (tx) => {
    const snap = await tx.get(taskRef);
    if (!snap.exists) {
      throw new HttpsError('not-found', `Task "${taskId}" not found.`);
    }
    const task = snap.data();
    const isAdmin = auth.token?.admin || auth.token?.superAdmin;
    if (!isAdmin && task.createdBy !== auth.uid) {
      throw new HttpsError('permission-denied', 'You can only cancel your own tasks.');
    }
    const { status } = task;
    if (status !== STATUS.PENDING) {
      throw new HttpsError(
        'failed-precondition',
        `Task cannot be cancelled — current status is "${status}". Only pending tasks may be cancelled.`
      );
    }
    const now = new Date().toISOString();
    tx.update(taskRef, {
      status:      STATUS.CANCELLED,
      cancelledAt: _ts(),
      cancelledBy: auth.uid,
    });
    return now;
  });

  logger.info('[TQ] cancelled', { taskId, cancelledBy: auth.uid });
  return { taskId, status: STATUS.CANCELLED, cancelledAt };
});

// ─────────────────────────────────────────────────────────────────────────────

/**
 * tqGetQueueStats  (admin)
 * ────────────────────────
 * Return a queue health snapshot:
 *   - task counts by status
 *   - pending counts by priority
 *   - throughput (last hour / last 24 h)
 *   - average wait time (scheduledFor → startedAt) of last 100 completed tasks
 *   - dead-letter count and oldest dead-letter task
 *
 * Request  {}
 * Response { generatedAt, statusCounts, priorityCounts, throughput,
 *            averageWaitMs, averageWaitSeconds, deadLetter }
 */
exports.tqGetQueueStats = onCall(CALL_OPTS, _h.tqGetQueueStats = async ({ auth }) => {
  _requireAdmin(auth);

  const now        = Date.now();
  const oneHourAgo = _fromDate(new Date(now - 3_600_000));
  const oneDayAgo  = _fromDate(new Date(now - 86_400_000));

  // ── Status counts (parallel) ──
  const statusCounts = {};
  await Promise.all(
    Object.values(STATUS).map(async (s) => {
      const agg = await db().collection(COL_QUEUE).where('status', '==', s).count().get();
      statusCounts[s] = agg.data().count;
    })
  );

  // ── Pending counts by priority ──
  const priorityCounts = {};
  await Promise.all(
    PRIORITY_LABELS.map(async (p) => {
      const agg = await db().collection(COL_QUEUE)
        .where('status',   '==', STATUS.PENDING)
        .where('priority', '==', p)
        .count().get();
      priorityCounts[p] = agg.data().count;
    })
  );

  // ── Throughput: completed tasks ──
  const [lastHourSnap, lastDaySnap] = await Promise.all([
    db().collection(COL_QUEUE)
      .where('status',      '==', STATUS.COMPLETED)
      .where('completedAt', '>=', oneHourAgo)
      .count().get(),
    db().collection(COL_QUEUE)
      .where('status',      '==', STATUS.COMPLETED)
      .where('completedAt', '>=', oneDayAgo)
      .count().get(),
  ]);

  // ── Average wait time from last 100 completed tasks ──
  const recentSnap = await db().collection(COL_QUEUE)
    .where('status', '==', STATUS.COMPLETED)
    .orderBy('completedAt', 'desc')
    .limit(100)
    .get();

  let totalWaitMs = 0;
  let waitSamples = 0;
  recentSnap.forEach((doc) => {
    const { scheduledFor, startedAt } = doc.data();
    if (scheduledFor?.toMillis && startedAt?.toMillis) {
      const ms = startedAt.toMillis() - scheduledFor.toMillis();
      if (ms >= 0) { totalWaitMs += ms; waitSamples++; }
    }
  });
  const avgWaitMs = waitSamples > 0 ? Math.round(totalWaitMs / waitSamples) : 0;

  // ── Dead-letter oldest task ──
  let oldestDeadLetter = null;
  const dlSnap = await db().collection(COL_QUEUE)
    .where('status', '==', STATUS.DEAD_LETTER)
    .orderBy('failedAt', 'asc')
    .limit(1)
    .get();

  if (!dlSnap.empty) {
    const d = dlSnap.docs[0].data();
    oldestDeadLetter = {
      taskId:       d.taskId,
      type:         d.type,
      failedAt:     d.failedAt,
      errorMessage: d.errorMessage,
      retryCount:   d.retryCount,
    };
  }

  return {
    generatedAt:     new Date().toISOString(),
    statusCounts,
    priorityCounts,
    throughput: {
      lastHour: lastHourSnap.data().count,
      last24h:  lastDaySnap.data().count,
    },
    averageWaitMs,
    averageWaitSeconds: Math.round(avgWaitMs / 1000),
    deadLetter: {
      count:   statusCounts[STATUS.DEAD_LETTER] || 0,
      oldest:  oldestDeadLetter,
    },
  };
});

// ─────────────────────────────────────────────────────────────────────────────

/**
 * tqWorkerProcessor  (scheduled: every 1 minute)
 * ────────────────────────────────────────────────
 * Main queue processor.
 *
 * Per run:
 *   1. Fetch up to 10 CRITICAL + 10 HIGH + 10 NORMAL + 5 LOW pending tasks
 *      whose scheduledFor <= now(), ordered CRITICAL → HIGH → NORMAL → LOW
 *   2. Claim each task inside a Firestore transaction to prevent double-claiming
 *   3. Execute the registered handler
 *   4. On success: mark completed
 *   5. On error: increment retryCount
 *        if retryCount >= maxRetries → dead_letter
 *        else → re-queue with exponential backoff
 */
exports.tqWorkerProcessor = onSchedule(
  { ...SCHED_OPTS, schedule: 'every 1 minutes' },
  async (_event) => {
    const wId  = _workerId();
    const nowTs = _nowTs();

    logger.info('[TQ:Worker] started', { workerId: wId });

    // Register worker heartbeat
    const workerRef = db().collection(COL_WORKERS).doc(wId);
    await workerRef.set({
      workerId:       wId,
      status:         'active',
      lastHeartbeat:  nowTs,
      tasksProcessed: 0,
      currentTask:    null,
      startedAt:      nowTs,
    });

    // Fetch tasks by priority in parallel
    const [critSnap, highSnap, normSnap, lowSnap] = await Promise.all([
      db().collection(COL_QUEUE)
        .where('status',       '==', STATUS.PENDING)
        .where('priority',     '==', 'critical')
        .where('scheduledFor', '<=', nowTs)
        .orderBy('scheduledFor', 'asc')
        .limit(BATCH.critical).get(),

      db().collection(COL_QUEUE)
        .where('status',       '==', STATUS.PENDING)
        .where('priority',     '==', 'high')
        .where('scheduledFor', '<=', nowTs)
        .orderBy('scheduledFor', 'asc')
        .limit(BATCH.high).get(),

      db().collection(COL_QUEUE)
        .where('status',       '==', STATUS.PENDING)
        .where('priority',     '==', 'normal')
        .where('scheduledFor', '<=', nowTs)
        .orderBy('scheduledFor', 'asc')
        .limit(BATCH.normal).get(),

      db().collection(COL_QUEUE)
        .where('status',       '==', STATUS.PENDING)
        .where('priority',     '==', 'low')
        .where('scheduledFor', '<=', nowTs)
        .orderBy('scheduledFor', 'asc')
        .limit(BATCH.low).get(),
    ]);

    // Merge in priority order: CRITICAL first
    const allDocs = [
      ...critSnap.docs,
      ...highSnap.docs,
      ...normSnap.docs,
      ...lowSnap.docs,
    ];

    if (allDocs.length === 0) {
      logger.info('[TQ:Worker] no tasks', { workerId: wId });
      await workerRef.update({ status: 'idle', lastHeartbeat: _ts() });
      return;
    }

    logger.info('[TQ:Worker] processing', { workerId: wId, count: allDocs.length });

    let processed = 0;

    for (const doc of allDocs) {
      const taskRef = doc.ref;
      let   taskData;

      // ── Claim the task atomically ──
      try {
        taskData = await db().runTransaction(async (tx) => {
          const fresh = await tx.get(taskRef);
          if (!fresh.exists || fresh.data().status !== STATUS.PENDING) return null;
          tx.update(taskRef, {
            status:     STATUS.RUNNING,
            startedAt:  _ts(),
            workerId:   wId,
          });
          return { taskId: fresh.id, ...fresh.data() };
        });
      } catch (txErr) {
        logger.warn('[TQ:Worker] claim failed', { docId: doc.id, error: txErr.message });
        continue;
      }

      if (!taskData) continue; // Already claimed by another invocation

      // Update worker heartbeat with current task
      await workerRef.update({ currentTask: taskData.taskId, lastHeartbeat: _ts() });

      // ── Execute handler ──
      try {
        const handler = HANDLERS[taskData.type];
        if (!handler) throw new Error(`No handler for task type "${taskData.type}".`);

        const result = await handler(taskData);

        await taskRef.update({
          status:      STATUS.COMPLETED,
          completedAt: _ts(),
          result:      result || null,
          errorMessage: null,
        });

        processed++;
        logger.info('[TQ:Worker] completed', { taskId: taskData.taskId, type: taskData.type });

      } catch (err) {
        const newRetry = (taskData.retryCount || 0) + 1;
        const maxRetry = taskData.maxRetries  ?? DEFAULT_MAX_RETRIES;

        logger.error('[TQ:Worker] task failed', {
          taskId:    taskData.taskId,
          type:      taskData.type,
          error:     err.message,
          retry:     newRetry,
          maxRetry,
        });

        if (newRetry >= maxRetry) {
          // Move to dead letter
          await taskRef.update({
            status:       STATUS.DEAD_LETTER,
            failedAt:     _ts(),
            errorMessage: err.message,
            retryCount:   newRetry,
          });
          logger.warn('[TQ:Worker] → dead_letter', { taskId: taskData.taskId, retries: newRetry });
        } else {
          // Re-queue with exponential backoff
          const backoff = _backoffMs(newRetry);
          await taskRef.update({
            status:       STATUS.PENDING,
            retryCount:   newRetry,
            scheduledFor: _tsAfterMs(backoff),
            lastError:    err.message,
            workerId:     null,
            startedAt:    null,
          });
          logger.info('[TQ:Worker] → retry', {
            taskId: taskData.taskId, retry: newRetry, backoffMs: backoff,
          });
        }
      }
    }

    // Finalise worker record
    await workerRef.update({
      status:         'idle',
      currentTask:    null,
      tasksProcessed: processed,
      completedAt:    _ts(),
      lastHeartbeat:  _ts(),
    });

    logger.info('[TQ:Worker] done', { workerId: wId, processed });
  }
);

// ─────────────────────────────────────────────────────────────────────────────

/**
 * tqScheduledCleanup  (scheduled: every 24 hours)
 * ──────────────────────────────────────────────────
 * Purge old completed tasks (>7 days), cancelled tasks (>1 day),
 * and stale worker heartbeat records (idle >1 hour).
 * All deletes are executed in 500-doc batches to stay within Firestore limits.
 *
 * Response { cleanedAt, completedTasksDeleted, cancelledTasksDeleted,
 *            workerRecordsDeleted, totalDeleted }
 */
exports.tqScheduledCleanup = onSchedule(
  { ...SCHED_OPTS, schedule: 'every 24 hours' },
  async (_event) => {
    const now             = new Date();
    const completedCutoff = _fromDate(new Date(now - CLEANUP_COMPLETED_D * 86_400_000));
    const cancelledCutoff = _fromDate(new Date(now - CLEANUP_CANCELLED_D * 86_400_000));
    const workerCutoff    = _fromDate(new Date(now - CLEANUP_WORKER_H   * 3_600_000));
    const BATCH_SIZE      = 500;

    logger.info('[TQ:Cleanup] starting', {
      completedCutoff: completedCutoff.toDate().toISOString(),
      cancelledCutoff: cancelledCutoff.toDate().toISOString(),
    });

    async function _purgeBatch(query) {
      let total = 0;
      let more  = true;
      while (more) {
        const snap = await query.limit(BATCH_SIZE).get();
        if (snap.empty) { more = false; break; }
        const b = db().batch();
        snap.docs.forEach((d) => b.delete(d.ref));
        await b.commit();
        total += snap.size;
        if (snap.size < BATCH_SIZE) more = false;
      }
      return total;
    }

    const [completedDeleted, cancelledDeleted] = await Promise.all([
      _purgeBatch(
        db().collection(COL_QUEUE)
          .where('status',      '==', STATUS.COMPLETED)
          .where('completedAt', '<',  completedCutoff)
      ),
      _purgeBatch(
        db().collection(COL_QUEUE)
          .where('status',      '==', STATUS.CANCELLED)
          .where('cancelledAt', '<',  cancelledCutoff)
      ),
    ]);

    // Clean up stale idle worker records
    const workerSnap = await db().collection(COL_WORKERS)
      .where('status',        '==', 'idle')
      .where('lastHeartbeat', '<',  workerCutoff)
      .limit(BATCH_SIZE).get();

    let workersDeleted = 0;
    if (!workerSnap.empty) {
      const b = db().batch();
      workerSnap.docs.forEach((d) => b.delete(d.ref));
      await b.commit();
      workersDeleted = workerSnap.size;
    }

    const result = {
      cleanedAt:             now.toISOString(),
      completedTasksDeleted: completedDeleted,
      cancelledTasksDeleted: cancelledDeleted,
      workerRecordsDeleted:  workersDeleted,
      totalDeleted:          completedDeleted + cancelledDeleted + (workersDeleted || 0),
    };

    logger.info('[TQ:Cleanup] done', result);
    return result;
  }
);

// ─────────────────────────────────────────────────────────────────────────────

/**
 * tqBulkEnqueue  (admin)
 * ───────────────────────
 * Enqueue up to 100 tasks in a single request using Firestore batch writes.
 * All tasks are validated before any write occurs (fail-fast).
 *
 * Request  { tasks: Array<{ type, payload?, priority?, scheduledFor?, maxRetries?, tags? }> }
 * Response { taskIds[], count, enqueuedBy }
 */
exports.tqBulkEnqueue = onCall(CALL_OPTS, _h.tqBulkEnqueue = async ({ data, auth }) => {
  _requireAdmin(auth);

  const { tasks } = data || {};
  if (!Array.isArray(tasks) || tasks.length === 0) {
    throw new HttpsError('invalid-argument', 'tasks[] must be a non-empty array.');
  }
  if (tasks.length > BULK_ENQUEUE_MAX) {
    throw new HttpsError(
      'invalid-argument',
      `Maximum ${BULK_ENQUEUE_MAX} tasks per bulk request. Received: ${tasks.length}.`
    );
  }

  // ── Validate all tasks before writing (fail-fast) ──
  const validPriorities = new Set(PRIORITY_LABELS);
  tasks.forEach((t, i) => {
    if (!t.type || !TASK_TYPES.includes(t.type)) {
      throw new HttpsError(
        'invalid-argument',
        `tasks[${i}]: invalid type "${t.type}". Supported: ${TASK_TYPES.join(', ')}.`
      );
    }
    const p = t.priority || 'normal';
    if (!validPriorities.has(p)) {
      throw new HttpsError('invalid-argument', `tasks[${i}]: invalid priority "${p}".`);
    }
  });

  // ── Write in 500-doc batches ──
  const CHUNK    = 500;
  const taskIds  = [];

  for (let i = 0; i < tasks.length; i += CHUNK) {
    const batch = db().batch();
    tasks.slice(i, i + CHUNK).forEach((t) => {
      const taskId   = _taskId(t.type);
      const priority = t.priority || 'normal';

      let scheduledForTs;
      if (t.scheduledFor) {
        const d = new Date(t.scheduledFor);
        scheduledForTs = isNaN(d.getTime()) ? _nowTs() : _fromDate(d);
      } else {
        scheduledForTs = _nowTs();
      }

      const retries = typeof t.maxRetries === 'number'
        ? Math.min(Math.max(0, Math.floor(t.maxRetries)), 10)
        : DEFAULT_MAX_RETRIES;

      batch.set(db().collection(COL_QUEUE).doc(taskId), {
        taskId,
        type:          t.type,
        payload:       t.payload || {},
        status:        STATUS.PENDING,
        priority,
        priorityValue: PRIORITY_MAP[priority],
        retryCount:    0,
        maxRetries:    retries,
        scheduledFor:  scheduledForTs,
        startedAt:     null,
        completedAt:   null,
        failedAt:      null,
        errorMessage:  null,
        result:        null,
        workerId:      null,
        createdAt:     _ts(),
        createdBy:     auth.uid,
        tags:          Array.isArray(t.tags) ? t.tags.slice(0, 10).map((v) => _san(String(v), 50)) : [],
      });

      taskIds.push(taskId);
    });
    await batch.commit();
  }

  logger.info('[TQ] bulk enqueued', { count: taskIds.length, by: auth.uid });

  return {
    taskIds,
    count:       taskIds.length,
    enqueuedBy:  auth.uid,
  };
});

exports._h = _h;
