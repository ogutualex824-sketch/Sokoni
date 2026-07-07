'use strict';

const { onCall }          = require('firebase-functions/v2/https');
const { onSchedule }      = require('firebase-functions/v2/scheduler');
const { onDocumentCreated } = require('firebase-functions/v2/firestore');
const { defineSecret }    = require('firebase-functions/params');
const { getFirestore, FieldValue, Timestamp } = require('firebase-admin/firestore');
const { initializeApp, getApps } = require('firebase-admin/app');

if (!getApps().length) initializeApp();
const db = getFirestore();

// Email secret needed by the EmailHandler inside async-job-handlers.js
const SENDGRID_API_KEY = defineSecret('SENDGRID_API_KEY');

const { handlers, JOB_TYPES } = require('./async-job-handlers');

// ── Collections ───────────────────────────────────────────────────────────────
const JOBS_COL  = 'asyncJobs';
const DLQ_COL   = 'asyncDeadLetter';
const EVENTS_COL = 'platformEvents';
const QUEUE_CFG = 'asyncQueueConfig';

// ── Enums ─────────────────────────────────────────────────────────────────────
const STATUS = {
  QUEUED:      'queued',
  WAITING:     'waiting',
  RUNNING:     'running',
  RETRYING:    'retrying',
  COMPLETED:   'completed',
  CANCELLED:   'cancelled',
  FAILED:      'failed',
  DEAD_LETTER: 'dead_letter',
};

const PRIORITY = { CRITICAL: 0, HIGH: 1, NORMAL: 2, LOW: 3, BACKGROUND: 4 };
const PRIORITY_LABEL = ['CRITICAL', 'HIGH', 'NORMAL', 'LOW', 'BACKGROUND'];

// Exponential backoff: 30s → 2m → 8m → 32m → 128m
const BACKOFF_MS = [30_000, 120_000, 480_000, 1_920_000, 7_680_000];

const LOCK_TTL_MS      = 300_000; // 5-minute worker lock
const MAX_SWEEPER_BATCH = 10;

// ── Auth guards ───────────────────────────────────────────────────────────────
function _auth(req) {
  if (!req.auth) throw new Error('Unauthenticated');
  return req.auth;
}
function _admin(req) {
  const auth = _auth(req);
  if (!auth.token.admin && !auth.token.superAdmin) throw new Error('Admin only');
  return auth;
}

// ── Core execution (distributed-locked) ──────────────────────────────────────
async function _executeJob(jobId, secrets = {}) {
  const jobRef = db.collection(JOBS_COL).doc(jobId);

  const claimed = await db.runTransaction(async tx => {
    const snap = await tx.get(jobRef);
    if (!snap.exists) return false;
    const job = snap.data();
    const now = Date.now();

    const executable =
      [STATUS.QUEUED, STATUS.RETRYING, STATUS.WAITING].includes(job.status) &&
      (!job.lockedUntil || job.lockedUntil.toMillis() < now) &&
      (!job.scheduledFor || job.scheduledFor.toMillis() <= now);

    if (!executable) return false;

    tx.update(jobRef, {
      status:         STATUS.RUNNING,
      startedAt:      Timestamp.now(),
      lockedUntil:    Timestamp.fromMillis(now + LOCK_TTL_MS),
      workerInstance: `cf-worker-${now}`,
      auditLog:       FieldValue.arrayUnion({ ts: Timestamp.now(), event: 'claimed' }),
    });
    return true;
  });

  if (!claimed) return;

  const snap    = await jobRef.get();
  const job     = { jobId, ...snap.data() };
  const handler = handlers[job.type];

  if (!handler) {
    await jobRef.update({
      status:   STATUS.FAILED,
      error:    `No handler for type: ${job.type}`,
      auditLog: FieldValue.arrayUnion({ ts: Timestamp.now(), event: 'failed', reason: 'no_handler' }),
    });
    return;
  }

  const helpers = {
    async updateProgress(current, total, message) {
      await jobRef.update({ progress: { current, total, message } });
    },
    db,
    secrets,
  };

  try {
    const result = await handler.execute(job, helpers);
    await jobRef.update({
      status:      STATUS.COMPLETED,
      result:      result || null,
      completedAt: Timestamp.now(),
      lockedUntil: null,
      auditLog:    FieldValue.arrayUnion({ ts: Timestamp.now(), event: 'completed' }),
    });
  } catch (err) {
    const canRetry   = handler.canRetry ? handler.canRetry(err) : true;
    const nextCount  = (job.retryCount || 0) + 1;
    const maxRetries = job.maxRetries ?? (JOB_TYPES[job.type]?.maxRetries ?? 3);

    if (canRetry && nextCount <= maxRetries) {
      const delayMs    = BACKOFF_MS[Math.min((job.retryCount || 0), BACKOFF_MS.length - 1)];
      const retryAfter = Timestamp.fromMillis(Date.now() + delayMs);
      await jobRef.update({
        status:       STATUS.RETRYING,
        retryCount:   nextCount,
        retryDelayMs: delayMs,
        scheduledFor: retryAfter,
        error:        err.message,
        lockedUntil:  null,
        auditLog:     FieldValue.arrayUnion({ ts: Timestamp.now(), event: 'retry', attempt: nextCount, reason: err.message }),
      });
    } else {
      const dlqData = { ...(await jobRef.get()).data(), jobId, status: STATUS.DEAD_LETTER, failedAt: Timestamp.now(), finalError: err.message };
      await db.collection(DLQ_COL).doc(jobId).set(dlqData);
      await jobRef.update({
        status:      STATUS.DEAD_LETTER,
        error:       err.message,
        lockedUntil: null,
        auditLog:    FieldValue.arrayUnion({ ts: Timestamp.now(), event: 'dead_letter', reason: err.message }),
      });
    }
  }
}

// ── Event → Job routing table ─────────────────────────────────────────────────
const EVENT_ROUTES = {
  'order.created':         [{ type: 'ANALYTICS', priority: PRIORITY.NORMAL }, { type: 'LOYALTY_UPDATE', priority: PRIORITY.HIGH }, { type: 'SELLER_NOTIFICATION', priority: PRIORITY.HIGH }],
  'order.completed':       [{ type: 'ANALYTICS', priority: PRIORITY.NORMAL }, { type: 'LOYALTY_UPDATE', priority: PRIORITY.HIGH }, { type: 'RECEIPT', priority: PRIORITY.HIGH }],
  'order.cancelled':       [{ type: 'ANALYTICS', priority: PRIORITY.LOW }, { type: 'SELLER_NOTIFICATION', priority: PRIORITY.NORMAL }],
  'payment.completed':     [{ type: 'ANALYTICS', priority: PRIORITY.HIGH }, { type: 'LOYALTY_UPDATE', priority: PRIORITY.HIGH }],
  'payment.failed':        [{ type: 'ANALYTICS', priority: PRIORITY.HIGH }, { type: 'PUSH', priority: PRIORITY.CRITICAL }],
  'product.created':       [{ type: 'PRODUCT_INDEX', priority: PRIORITY.NORMAL }, { type: 'SEARCH_INDEX', priority: PRIORITY.LOW }],
  'product.updated':       [{ type: 'PRODUCT_INDEX', priority: PRIORITY.NORMAL }, { type: 'SEARCH_INDEX', priority: PRIORITY.LOW }],
  'product.deleted':       [{ type: 'SEARCH_INDEX', priority: PRIORITY.NORMAL }],
  'review.created':        [{ type: 'ANALYTICS', priority: PRIORITY.LOW }, { type: 'SELLER_NOTIFICATION', priority: PRIORITY.NORMAL }],
  'user.registered':       [{ type: 'EMAIL', priority: PRIORITY.HIGH }, { type: 'ANALYTICS', priority: PRIORITY.LOW }],
  'subscription.renewed':  [{ type: 'EMAIL', priority: PRIORITY.HIGH }, { type: 'ANALYTICS', priority: PRIORITY.LOW }],
  'subscription.expired':  [{ type: 'EMAIL', priority: PRIORITY.HIGH }, { type: 'PUSH', priority: PRIORITY.HIGH }],
  'inventory.low_stock':   [{ type: 'INVENTORY_ALERT', priority: PRIORITY.HIGH }, { type: 'SELLER_NOTIFICATION', priority: PRIORITY.HIGH }],
  'etims.invoice_ready':   [{ type: 'ETIMS', priority: PRIORITY.HIGH }],
  'report.requested':      [{ type: 'REPORT_GENERATE', priority: PRIORITY.NORMAL }],
  'pos.sale_completed':    [{ type: 'RECEIPT', priority: PRIORITY.HIGH }, { type: 'ANALYTICS', priority: PRIORITY.NORMAL }],
  'driver.assigned':       [{ type: 'PUSH', priority: PRIORITY.HIGH }, { type: 'SMS', priority: PRIORITY.HIGH }],
  'event.ticket_sold':     [{ type: 'EMAIL', priority: PRIORITY.HIGH }, { type: 'ANALYTICS', priority: PRIORITY.NORMAL }],
  'bulk.import_requested': [{ type: 'BULK_IMPORT', priority: PRIORITY.LOW }],
  'bulk.export_requested': [{ type: 'BULK_EXPORT', priority: PRIORITY.LOW }],
  'ai.content_flag':       [{ type: 'AI_PROCESS', priority: PRIORITY.HIGH }],
  'image.uploaded':        [{ type: 'IMAGE_OPT', priority: PRIORITY.BACKGROUND }],
};

function _buildJobFromEvent(event, route) {
  const typeConfig = JOB_TYPES[route.type] || {};
  return {
    type:          route.type,
    status:        STATUS.QUEUED,
    priority:      route.priority,
    priorityLabel: PRIORITY_LABEL[route.priority],
    ownerId:       event.ownerId || '',
    workspaceId:   event.workspaceId || '',
    payload:       { eventType: event.type, eventId: event.id || '', ...(event.data || {}) },
    retryCount:    0,
    maxRetries:    typeConfig.maxRetries ?? 3,
    retryDelayMs:  BACKOFF_MS[0],
    result:        null,
    error:         null,
    progress:      { current: 0, total: 0, message: '' },
    correlationId: event.correlationId || event.id || '',
    idempotencyKey: `${event.id}-${route.type}`,
    scheduledFor:  null,
    createdAt:     Timestamp.now(),
    startedAt:     null,
    completedAt:   null,
    workerInstance: null,
    lockedUntil:   null,
    auditLog:      [{ ts: Timestamp.now(), event: 'created_from_event', source: event.type }],
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// CF 1 — asyncEnqueue  (onCall)
// Create a new background job with idempotency guard
// ═════════════════════════════════════════════════════════════════════════════
exports.asyncEnqueue = onCall({ region: 'us-central1', timeoutSeconds: 30 }, async req => {
  _auth(req);
  const {
    type, payload = {}, priority = PRIORITY.NORMAL,
    idempotencyKey, scheduledFor, workspaceId, correlationId,
  } = req.data;

  if (!type || !handlers[type]) throw new Error(`Unknown job type: ${type}`);
  if (priority < 0 || priority > 4) throw new Error('Priority must be 0–4');

  if (idempotencyKey) {
    const existing = await db.collection(JOBS_COL)
      .where('idempotencyKey', '==', idempotencyKey).limit(1).get();
    if (!existing.empty) {
      const doc = existing.docs[0];
      return { jobId: doc.id, status: doc.data().status, idempotent: true };
    }
  }

  const typeConfig  = JOB_TYPES[type] || {};
  const jobRef      = db.collection(JOBS_COL).doc();
  const jobId       = jobRef.id;
  const scheduledTs = scheduledFor ? Timestamp.fromMillis(Number(scheduledFor)) : null;

  const job = {
    jobId,
    type,
    status:        scheduledTs ? STATUS.WAITING : STATUS.QUEUED,
    priority:      Number(priority),
    priorityLabel: PRIORITY_LABEL[Number(priority)],
    ownerId:       req.auth.uid,
    workspaceId:   workspaceId || '',
    payload,
    retryCount:    0,
    maxRetries:    typeConfig.maxRetries ?? 3,
    retryDelayMs:  BACKOFF_MS[0],
    result:        null,
    error:         null,
    progress:      { current: 0, total: 0, message: '' },
    correlationId: correlationId || jobId,
    idempotencyKey: idempotencyKey || jobId,
    scheduledFor:  scheduledTs,
    createdAt:     Timestamp.now(),
    startedAt:     null,
    completedAt:   null,
    workerInstance: null,
    lockedUntil:   null,
    auditLog:      [{ ts: Timestamp.now(), event: 'enqueued', by: req.auth.uid }],
  };

  await jobRef.set(job);
  return { jobId, status: job.status };
});

// ═════════════════════════════════════════════════════════════════════════════
// CF 2 — asyncWorker  (onDocumentCreated asyncJobs/{jobId})
// Immediate execution for critical/high priority non-scheduled jobs
// ═════════════════════════════════════════════════════════════════════════════
exports.asyncWorker = onDocumentCreated(
  { document: `${JOBS_COL}/{jobId}`, region: 'us-central1', timeoutSeconds: 540, secrets: [SENDGRID_API_KEY] },
  async event => {
    const job = event.data?.data();
    if (!job) return;
    // Sweeper handles lower priorities; skip scheduled jobs
    if (job.scheduledFor || job.priority > PRIORITY.NORMAL) return;
    await _executeJob(event.params.jobId, { sendgridKey: SENDGRID_API_KEY.value() });
  }
);

// ═════════════════════════════════════════════════════════════════════════════
// CF 3 — asyncSweeper  (every 1 minutes)
// Picks up all pending work: low priority, retries, scheduled, crashed workers
// ═════════════════════════════════════════════════════════════════════════════
exports.asyncSweeper = onSchedule(
  { schedule: 'every 1 minutes', region: 'us-central1', timeoutSeconds: 540, secrets: [SENDGRID_API_KEY] },
  async () => {
    const now = Timestamp.now();

    // Load paused priority queues
    const pauseSnap = await db.collection(QUEUE_CFG).doc('pausedQueues').get();
    const pausedSet = new Set(pauseSnap.exists ? (pauseSnap.data().paused || []) : []);

    // Recover crashed workers: RUNNING but lock expired
    const crashedSnap = await db.collection(JOBS_COL)
      .where('status', '==', STATUS.RUNNING)
      .where('lockedUntil', '<=', now)
      .limit(5).get();

    for (const doc of crashedSnap.docs) {
      await doc.ref.update({
        status:         STATUS.QUEUED,
        lockedUntil:    null,
        workerInstance: null,
        auditLog:       FieldValue.arrayUnion({ ts: now, event: 'recovered_crashed_worker' }),
      });
    }

    // Collect jobs to run (priority order)
    const [queuedSnap, retryingSnap, waitingSnap] = await Promise.all([
      db.collection(JOBS_COL).where('status', '==', STATUS.QUEUED)
        .orderBy('priority').orderBy('createdAt').limit(MAX_SWEEPER_BATCH).get(),
      db.collection(JOBS_COL).where('status', '==', STATUS.RETRYING)
        .where('scheduledFor', '<=', now).limit(MAX_SWEEPER_BATCH).get(),
      db.collection(JOBS_COL).where('status', '==', STATUS.WAITING)
        .where('scheduledFor', '<=', now).limit(MAX_SWEEPER_BATCH).get(),
    ]);

    const seen  = new Set();
    const toRun = [];

    for (const snap of [queuedSnap, retryingSnap, waitingSnap]) {
      for (const doc of snap.docs) {
        if (seen.has(doc.id)) continue;
        seen.add(doc.id);
        if (!pausedSet.has(doc.data().priority)) toRun.push(doc.id);
      }
    }

    const _sweepSecrets = { sendgridKey: SENDGRID_API_KEY.value() };
    for (const jobId of toRun) {
      await _executeJob(jobId, _sweepSecrets).catch(e => console.error(`Sweeper: ${jobId}`, e.message));
    }
  }
);

// ═════════════════════════════════════════════════════════════════════════════
// CF 4 — asyncEventRouter  (onDocumentCreated platformEvents/{eventId})
// Maps platform events to one or more background jobs
// ═════════════════════════════════════════════════════════════════════════════
exports.asyncEventRouter = onDocumentCreated(
  { document: `${EVENTS_COL}/{eventId}`, region: 'us-central1', timeoutSeconds: 60 },
  async event => {
    const data  = event.data?.data();
    if (!data) return;

    const eventType = data.type || data.eventType;
    const routes    = EVENT_ROUTES[eventType];
    if (!routes?.length) return;

    const enriched = { id: event.params.eventId, ...data };
    const batch    = db.batch();

    for (const route of routes) {
      const job    = _buildJobFromEvent(enriched, route);
      const jobRef = db.collection(JOBS_COL).doc();
      batch.set(jobRef, { ...job, jobId: jobRef.id });
    }

    await batch.commit();
  }
);

// ═════════════════════════════════════════════════════════════════════════════
// CF 5 — asyncCancel  (onCall)
// Cancel a queued/waiting/retrying job (owner or admin)
// ═════════════════════════════════════════════════════════════════════════════
exports.asyncCancel = onCall({ region: 'us-central1', timeoutSeconds: 30 }, async req => {
  const auth = _auth(req);
  const { jobId, reason } = req.data;
  if (!jobId) throw new Error('jobId required');

  const jobRef = db.collection(JOBS_COL).doc(jobId);
  await db.runTransaction(async tx => {
    const snap = await tx.get(jobRef);
    if (!snap.exists) throw new Error('Job not found');
    const job = snap.data();

    const isOwner = job.ownerId === auth.uid;
    const isAdmin = auth.token.admin || auth.token.superAdmin;
    if (!isOwner && !isAdmin) throw new Error('Forbidden');

    if (![STATUS.QUEUED, STATUS.WAITING, STATUS.RETRYING].includes(job.status))
      throw new Error(`Cannot cancel: status is ${job.status}`);

    tx.update(jobRef, {
      status:   STATUS.CANCELLED,
      auditLog: FieldValue.arrayUnion({ ts: Timestamp.now(), event: 'cancelled', by: auth.uid, reason: reason || '' }),
    });
  });

  return { success: true };
});

// ═════════════════════════════════════════════════════════════════════════════
// CF 6 — asyncRetryJob  (onCall, admin)
// Retry a failed/DLQ job, resetting retry counter
// ═════════════════════════════════════════════════════════════════════════════
exports.asyncRetryJob = onCall({ region: 'us-central1', timeoutSeconds: 60 }, async req => {
  const auth = _admin(req);
  const { jobId, fromDlq } = req.data;
  if (!jobId) throw new Error('jobId required');

  const srcRef = fromDlq
    ? db.collection(DLQ_COL).doc(jobId)
    : db.collection(JOBS_COL).doc(jobId);

  const snap = await srcRef.get();
  if (!snap.exists) throw new Error('Job not found');
  const job  = snap.data();

  const jobRef = db.collection(JOBS_COL).doc(jobId);

  if (fromDlq) {
    await jobRef.set({
      ...job,
      status:       STATUS.QUEUED,
      retryCount:   0,
      error:        null,
      lockedUntil:  null,
      scheduledFor: null,
      auditLog:     [...(job.auditLog || []), { ts: Timestamp.now(), event: 'replayed_from_dlq', by: auth.uid }],
    });
  } else {
    await jobRef.update({
      status:       STATUS.QUEUED,
      retryCount:   0,
      error:        null,
      lockedUntil:  null,
      scheduledFor: null,
      auditLog:     FieldValue.arrayUnion({ ts: Timestamp.now(), event: 'admin_retry', by: auth.uid }),
    });
  }

  return { success: true, jobId };
});

// ═════════════════════════════════════════════════════════════════════════════
// CF 7 — asyncPauseQueue  (onCall, admin)
// Pause or resume a specific priority level (0–4)
// ═════════════════════════════════════════════════════════════════════════════
exports.asyncPauseQueue = onCall({ region: 'us-central1', timeoutSeconds: 30 }, async req => {
  const auth = _admin(req);
  const { priority, paused } = req.data;
  if (priority === undefined || typeof paused !== 'boolean') throw new Error('priority and paused required');

  const cfgRef = db.collection(QUEUE_CFG).doc('pausedQueues');
  if (paused) {
    await cfgRef.set({ paused: FieldValue.arrayUnion(Number(priority)) }, { merge: true });
  } else {
    await cfgRef.set({ paused: FieldValue.arrayRemove(Number(priority)) }, { merge: true });
  }

  return { success: true, priority, paused };
});

// ═════════════════════════════════════════════════════════════════════════════
// CF 8 — asyncGetDashboard  (onCall, admin)
// Live KPI counts + recent 20 jobs + paused queue state
// ═════════════════════════════════════════════════════════════════════════════
exports.asyncGetDashboard = onCall({ region: 'us-central1', timeoutSeconds: 30 }, async req => {
  _admin(req);

  const [qSnap, rSnap, fSnap, dlqSnap, cSnap, retrySnap, pauseSnap] = await Promise.all([
    db.collection(JOBS_COL).where('status', '==', STATUS.QUEUED).count().get(),
    db.collection(JOBS_COL).where('status', '==', STATUS.RUNNING).count().get(),
    db.collection(JOBS_COL).where('status', '==', STATUS.FAILED).count().get(),
    db.collection(DLQ_COL).count().get(),
    db.collection(JOBS_COL).where('status', '==', STATUS.COMPLETED).count().get(),
    db.collection(JOBS_COL).where('status', '==', STATUS.RETRYING).count().get(),
    db.collection(QUEUE_CFG).doc('pausedQueues').get(),
  ]);

  const recentSnap = await db.collection(JOBS_COL)
    .orderBy('createdAt', 'desc').limit(20).get();

  const recent = recentSnap.docs.map(d => {
    const j = d.data();
    return {
      jobId: d.id, type: j.type, status: j.status,
      priority: j.priority, priorityLabel: j.priorityLabel,
      ownerId: j.ownerId, retryCount: j.retryCount,
      error: j.error, createdAt: j.createdAt, completedAt: j.completedAt,
    };
  });

  return {
    kpis: {
      queued:    qSnap.data().count,
      running:   rSnap.data().count,
      failed:    fSnap.data().count,
      dlq:       dlqSnap.data().count,
      completed: cSnap.data().count,
      retrying:  retrySnap.data().count,
    },
    pausedQueues: pauseSnap.exists ? (pauseSnap.data().paused || []) : [],
    recent,
  };
});

// ═════════════════════════════════════════════════════════════════════════════
// CF 9 — asyncGetJobs  (onCall, admin)
// Paginated, filtered job list
// ═════════════════════════════════════════════════════════════════════════════
exports.asyncGetJobs = onCall({ region: 'us-central1', timeoutSeconds: 30 }, async req => {
  _admin(req);
  const { status, type, priority, limit = 50, startAfter, fromDlq } = req.data;

  const col  = fromDlq ? DLQ_COL : JOBS_COL;
  let query  = db.collection(col).orderBy('createdAt', 'desc').limit(Math.min(Number(limit), 200));

  if (status)             query = query.where('status', '==', status);
  if (type)               query = query.where('type', '==', type);
  if (priority !== undefined) query = query.where('priority', '==', Number(priority));

  if (startAfter) {
    const cursor = await db.collection(col).doc(startAfter).get();
    if (cursor.exists) query = query.startAfter(cursor);
  }

  const snap = await query.get();
  const jobs = snap.docs.map(d => {
    const j = d.data();
    return {
      jobId: d.id, type: j.type, status: j.status,
      priority: j.priority, priorityLabel: j.priorityLabel,
      ownerId: j.ownerId, retryCount: j.retryCount,
      error: j.error, createdAt: j.createdAt, completedAt: j.completedAt,
      scheduledFor: j.scheduledFor,
    };
  });

  return { jobs, count: jobs.length };
});

// ═════════════════════════════════════════════════════════════════════════════
// CF 10 — asyncInspect  (onCall, admin)
// Full job detail including payload and audit log
// ═════════════════════════════════════════════════════════════════════════════
exports.asyncInspect = onCall({ region: 'us-central1', timeoutSeconds: 30 }, async req => {
  _admin(req);
  const { jobId, fromDlq } = req.data;
  if (!jobId) throw new Error('jobId required');

  const snap = await db.collection(fromDlq ? DLQ_COL : JOBS_COL).doc(jobId).get();
  if (!snap.exists) throw new Error('Job not found');

  return { jobId, ...snap.data() };
});

// ═════════════════════════════════════════════════════════════════════════════
// CF 11 — asyncCleanup  (every day 03:30)
// Purge completed/cancelled jobs >30 days; DLQ entries >90 days
// ═════════════════════════════════════════════════════════════════════════════
exports.asyncCleanup = onSchedule(
  { schedule: 'every day 03:30', region: 'us-central1', timeoutSeconds: 540 },
  async () => {
    const cutoff30d = Timestamp.fromMillis(Date.now() - 30 * 86_400_000);
    const cutoff90d = Timestamp.fromMillis(Date.now() - 90 * 86_400_000);
    const batch     = db.batch();
    let   count     = 0;

    for (const status of [STATUS.COMPLETED, STATUS.CANCELLED]) {
      const snap = await db.collection(JOBS_COL)
        .where('status', '==', status)
        .where('createdAt', '<=', cutoff30d)
        .limit(400).get();
      for (const doc of snap.docs) { batch.delete(doc.ref); count++; }
    }

    const dlqSnap = await db.collection(DLQ_COL)
      .where('failedAt', '<=', cutoff90d).limit(100).get();
    for (const doc of dlqSnap.docs) { batch.delete(doc.ref); count++; }

    if (count > 0) await batch.commit();
    console.log(`asyncCleanup: purged ${count} docs`);
  }
);
