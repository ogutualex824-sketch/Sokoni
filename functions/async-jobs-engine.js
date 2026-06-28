'use strict';

/**
 * SOKONI Async Jobs Engine v1.0
 * Resilient background processing: priority queues, retries, DLQ, monitoring.
 */

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule }         = require('firebase-functions/v2/scheduler');
const { onDocumentCreated }  = require('firebase-functions/v2/firestore');
const admin = require('firebase-admin');
const crypto = require('crypto');

// ── Constants ──────────────────────────────────────────────────────────────

const PRIORITIES = { CRITICAL: 0, HIGH: 1, NORMAL: 2, LOW: 3, BACKGROUND: 4 };
const S = {
  QUEUED:      'queued',
  WAITING:     'waiting',
  RUNNING:     'running',
  RETRYING:    'retrying',
  COMPLETED:   'completed',
  CANCELLED:   'cancelled',
  FAILED:      'failed',
  DEAD_LETTER: 'dead_letter'
};

const LOCK_TTL_MS     = 300_000;   // 5 min worker lock
const BATCH_SIZE      = 8;         // jobs per scheduler run
const CLEANUP_DAYS    = 30;
const MAX_AUDIT       = 20;

const VALID_JOB_TYPES = new Set([
  'EMAIL', 'SMS', 'PUSH', 'RECEIPT', 'PDF', 'ETIMS',
  'INVENTORY_RECALC', 'INVENTORY_ALERT', 'ANALYTICS', 'ANALYTICS_AGGREGATE',
  'REPORT', 'REPORT_GENERATE', 'IMAGE_OPT', 'AI_PROCESS',
  'PRODUCT_INDEX', 'SEARCH_INDEX', 'RECO_UPDATE',
  'WEBHOOK', 'BULK_IMPORT', 'BULK_EXPORT',
  'SCHEDULED_CLEANUP', 'DB_MAINTENANCE', 'BACKUP_VERIFY',
  'REDIS_WARMUP', 'EXTERNAL_SYNC',
  'LOYALTY_UPDATE', 'SELLER_NOTIFICATION', 'CUSTOMER_SEGMENT'
]);

const VALID_PRIORITIES = new Set(['CRITICAL', 'HIGH', 'NORMAL', 'LOW', 'BACKGROUND']);
const CALL_OPTS = { region: 'us-central1', enforceAppCheck: true };

// ── Helpers ────────────────────────────────────────────────────────────────

const db = () => admin.firestore();
const fv = () => admin.firestore.FieldValue;
const ts = () => admin.firestore.FieldValue.serverTimestamp();

function _san(v, max = 500) {
  if (typeof v !== 'string') return '';
  return v.replace(/[<>"'`]/g, '').trim().slice(0, max);
}

function _requireAuth(auth) {
  if (!auth?.uid) throw new HttpsError('unauthenticated', 'Authentication required.');
}

function _requireAdmin(auth) {
  _requireAuth(auth);
  if (!auth.token?.admin && !auth.token?.superAdmin) {
    throw new HttpsError('permission-denied', 'Admin access required.');
  }
}

function _genJobId() {
  return `job_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
}

function _backoff(retryCount, baseMs = 2000) {
  const jitter = crypto.randomInt(0, 1000);
  return Math.min(baseMs * Math.pow(2, retryCount), 3_600_000) + jitter;
}

function _audit(existing = [], event) {
  const entry = { ts: new Date().toISOString(), ...event };
  return [...existing, entry].slice(-MAX_AUDIT);
}

function _maskSecrets(payload) {
  if (!payload || typeof payload !== 'object') return payload;
  const KEYS = new Set(['password', 'secret', 'token', 'key', 'card', 'pin', 'cvv', 'pan', 'apikey', 'privatekey']);
  return Object.fromEntries(Object.entries(payload).map(([k, v]) => {
    if (KEYS.has(k.toLowerCase())) return [k, '***REDACTED***'];
    if (v && typeof v === 'object') return [k, _maskSecrets(v)];
    return [k, v];
  }));
}

// ── createJob ──────────────────────────────────────────────────────────────

exports.createJob = onCall(CALL_OPTS, async ({ data, auth }) => {
  _requireAuth(auth);

  const {
    type,
    payload        = {},
    priority       = 'NORMAL',
    workspaceId    = '',
    idempotencyKey = '',
    scheduledFor   = null,
    maxRetries     = 3,
    correlationId  = ''
  } = data || {};

  if (!VALID_JOB_TYPES.has(type)) {
    throw new HttpsError('invalid-argument', `Unknown job type: ${type}`);
  }
  if (!VALID_PRIORITIES.has(priority)) {
    throw new HttpsError('invalid-argument', `Invalid priority: ${priority}`);
  }

  // Idempotency guard
  const iKey = _san(idempotencyKey, 128);
  if (iKey) {
    const existing = await db().collection('asyncJobs')
      .where('idempotencyKey', '==', iKey)
      .where('ownerId', '==', auth.uid)
      .limit(1).get();
    if (!existing.empty) {
      return { jobId: existing.docs[0].id, deduplicated: true };
    }
  }

  // Queue pause check
  const qSnap = await db().collection('asyncQueues').doc(priority).get();
  if (qSnap.exists && qSnap.data().paused) {
    throw new HttpsError('unavailable', `${priority} queue is currently paused.`);
  }

  const jobId  = _genJobId();
  const status = scheduledFor ? S.WAITING : S.QUEUED;

  const job = {
    jobId,
    type,
    status,
    priority:      PRIORITIES[priority],
    priorityLabel: priority,
    ownerId:       auth.uid,
    workspaceId:   _san(workspaceId),
    payload,
    result:        null,
    error:         null,
    retryCount:    0,
    maxRetries:    Math.max(0, Math.min(10, Number(maxRetries) || 3)),
    retryDelayMs:  2000,
    progress:      { current: 0, total: 100, message: 'Queued' },
    correlationId: _san(correlationId, 128),
    idempotencyKey: iKey,
    scheduledFor:  scheduledFor
      ? admin.firestore.Timestamp.fromDate(new Date(scheduledFor))
      : null,
    createdAt:      ts(),
    startedAt:      null,
    completedAt:    null,
    workerInstance: null,
    lockedUntil:    null,
    auditLog: [{ ts: new Date().toISOString(), event: 'created', actor: auth.uid }]
  };

  await db().collection('asyncJobs').doc(jobId).set(job);

  // Non-blocking event emission
  db().collection('platformEvents').add({
    type: 'JobCreated',
    payload: { jobId, jobType: type, priority, ownerId: auth.uid },
    createdAt: ts()
  }).catch(() => {});

  return { jobId, status };
});

// ── getJob ─────────────────────────────────────────────────────────────────

exports.getJob = onCall(CALL_OPTS, async ({ data, auth }) => {
  _requireAuth(auth);
  const jobId = _san(data?.jobId || '');
  if (!jobId) throw new HttpsError('invalid-argument', 'jobId required.');

  const snap = await db().collection('asyncJobs').doc(jobId).get();
  if (!snap.exists) throw new HttpsError('not-found', 'Job not found.');

  const j = snap.data();
  if (j.ownerId !== auth.uid && !auth.token?.admin && !auth.token?.superAdmin) {
    throw new HttpsError('permission-denied', 'Access denied.');
  }

  return {
    jobId:        j.jobId,
    type:         j.type,
    status:       j.status,
    priority:     j.priorityLabel,
    progress:     j.progress,
    retryCount:   j.retryCount,
    maxRetries:   j.maxRetries,
    error:        j.error ? { message: j.error.message, code: j.error.code } : null,
    result:       j.result,
    correlationId: j.correlationId,
    createdAt:    j.createdAt?.toMillis?.() || null,
    startedAt:    j.startedAt?.toMillis?.() || null,
    completedAt:  j.completedAt?.toMillis?.() || null
  };
});

// ── getMyJobs ──────────────────────────────────────────────────────────────

exports.getMyJobs = onCall(CALL_OPTS, async ({ data, auth }) => {
  _requireAuth(auth);
  const { status, type, limit: lim = 20 } = data || {};
  let q = db().collection('asyncJobs')
    .where('ownerId', '==', auth.uid)
    .orderBy('createdAt', 'desc')
    .limit(Math.min(Number(lim) || 20, 100));
  if (status) q = q.where('status', '==', status);
  if (type)   q = q.where('type',   '==', type);
  const snap = await q.get();
  return {
    jobs: snap.docs.map(d => {
      const j = d.data();
      return {
        jobId: j.jobId, type: j.type, status: j.status,
        priority: j.priorityLabel, progress: j.progress,
        createdAt: j.createdAt?.toMillis?.() || null,
        completedAt: j.completedAt?.toMillis?.() || null
      };
    })
  };
});

// ── cancelJob ─────────────────────────────────────────────────────────────

exports.cancelJob = onCall(CALL_OPTS, async ({ data, auth }) => {
  _requireAuth(auth);
  const jobId = _san(data?.jobId || '');
  if (!jobId) throw new HttpsError('invalid-argument', 'jobId required.');

  const ref = db().collection('asyncJobs').doc(jobId);
  await db().runTransaction(async t => {
    const snap = await t.get(ref);
    if (!snap.exists) throw new HttpsError('not-found', 'Job not found.');
    const j = snap.data();
    if (j.ownerId !== auth.uid && !auth.token?.admin) {
      throw new HttpsError('permission-denied', 'Access denied.');
    }
    if (![S.QUEUED, S.WAITING, S.RETRYING].includes(j.status)) {
      throw new HttpsError('failed-precondition', `Cannot cancel job in status: ${j.status}`);
    }
    t.update(ref, {
      status: S.CANCELLED,
      completedAt: ts(),
      auditLog: _audit(j.auditLog, { event: 'cancelled', actor: auth.uid })
    });
  });
  return { cancelled: true };
});

// ── retryJob (admin) ───────────────────────────────────────────────────────

exports.retryJob = onCall(CALL_OPTS, async ({ data, auth }) => {
  _requireAdmin(auth);
  const jobId = _san(data?.jobId || '');
  if (!jobId) throw new HttpsError('invalid-argument', 'jobId required.');

  const ref = db().collection('asyncJobs').doc(jobId);
  await db().runTransaction(async t => {
    const snap = await t.get(ref);
    if (!snap.exists) throw new HttpsError('not-found', 'Job not found.');
    const j = snap.data();
    if (![S.FAILED, S.CANCELLED, S.DEAD_LETTER].includes(j.status)) {
      throw new HttpsError('failed-precondition', `Cannot retry job in status: ${j.status}`);
    }
    t.update(ref, {
      status: S.QUEUED,
      retryCount: 0,
      error: null,
      lockedUntil: null,
      workerInstance: null,
      scheduledFor: null,
      'progress.message': 'Re-queued by admin',
      auditLog: _audit(j.auditLog, { event: 'admin_retry', actor: auth.uid })
    });
  });
  return { retried: true, jobId };
});

// ── replayDLQJob (admin) ───────────────────────────────────────────────────

exports.replayDLQJob = onCall(CALL_OPTS, async ({ data, auth }) => {
  _requireAdmin(auth);
  const dlqId = _san(data?.dlqId || '');
  if (!dlqId) throw new HttpsError('invalid-argument', 'dlqId required.');

  const dlqRef = db().collection('asyncJobsDLQ').doc(dlqId);
  const snap   = await dlqRef.get();
  if (!snap.exists) throw new HttpsError('not-found', 'DLQ entry not found.');

  const original = snap.data();
  const newJobId = _genJobId();
  const batch    = db().batch();

  batch.set(db().collection('asyncJobs').doc(newJobId), {
    ...original,
    jobId:          newJobId,
    status:         S.QUEUED,
    retryCount:     0,
    error:          null,
    lockedUntil:    null,
    workerInstance: null,
    createdAt:      ts(),
    startedAt:      null,
    completedAt:    null,
    auditLog: [{
      ts: new Date().toISOString(),
      event: 'replayed_from_dlq',
      actor: auth.uid,
      originalId: dlqId
    }]
  });
  batch.delete(dlqRef);
  await batch.commit();

  return { jobId: newJobId, replayed: true };
});

// ── pauseQueue / resumeQueue (admin) ──────────────────────────────────────

exports.pauseQueue = onCall(CALL_OPTS, async ({ data, auth }) => {
  _requireAdmin(auth);
  const priority = data?.priority;
  if (!VALID_PRIORITIES.has(priority)) {
    throw new HttpsError('invalid-argument', 'Valid priority required.');
  }
  await db().collection('asyncQueues').doc(priority).set(
    { paused: true, pausedAt: ts(), pausedBy: auth.uid },
    { merge: true }
  );
  return { paused: true, priority };
});

exports.resumeQueue = onCall(CALL_OPTS, async ({ data, auth }) => {
  _requireAdmin(auth);
  const priority = data?.priority;
  if (!VALID_PRIORITIES.has(priority)) {
    throw new HttpsError('invalid-argument', 'Valid priority required.');
  }
  await db().collection('asyncQueues').doc(priority).set(
    { paused: false, resumedAt: ts(), resumedBy: auth.uid },
    { merge: true }
  );
  return { resumed: true, priority };
});

// ── getQueueDepth (admin) ──────────────────────────────────────────────────

exports.getQueueDepth = onCall(CALL_OPTS, async ({ data, auth }) => {
  _requireAdmin(auth);

  const [queued, running, retrying, failed, waiting, dlq] = await Promise.all([
    db().collection('asyncJobs').where('status', '==', S.QUEUED).count().get(),
    db().collection('asyncJobs').where('status', '==', S.RUNNING).count().get(),
    db().collection('asyncJobs').where('status', '==', S.RETRYING).count().get(),
    db().collection('asyncJobs').where('status', '==', S.FAILED).count().get(),
    db().collection('asyncJobs').where('status', '==', S.WAITING).count().get(),
    db().collection('asyncJobsDLQ').count().get()
  ]);

  const byPriority = Object.fromEntries(
    await Promise.all(
      Object.entries(PRIORITIES).map(async ([label, num]) => {
        const s = await db().collection('asyncJobs')
          .where('priority', '==', num)
          .where('status', 'in', [S.QUEUED, S.RETRYING])
          .count().get();
        return [label, s.data().count];
      })
    )
  );

  // Queue pause states
  const queues = await db().collection('asyncQueues').get();
  const queueStates = Object.fromEntries(
    queues.docs.map(d => [d.id, d.data().paused ? 'paused' : 'active'])
  );

  return {
    queued:   queued.data().count,
    running:  running.data().count,
    retrying: retrying.data().count,
    waiting:  waiting.data().count,
    failed:   failed.data().count,
    dlq:      dlq.data().count,
    byPriority,
    queueStates
  };
});

// ── getJobDashboard (admin) ────────────────────────────────────────────────

exports.getJobDashboard = onCall(CALL_OPTS, async ({ data, auth }) => {
  _requireAdmin(auth);
  const hours = Math.min(Number(data?.hours) || 24, 168);
  const since = admin.firestore.Timestamp.fromDate(
    new Date(Date.now() - hours * 3_600_000)
  );

  const [recentSnap, dlqSnap, workerSnap] = await Promise.all([
    db().collection('asyncJobs')
      .where('createdAt', '>=', since)
      .orderBy('createdAt', 'desc')
      .limit(500).get(),
    db().collection('asyncJobsDLQ')
      .orderBy('movedAt', 'desc').limit(50).get(),
    db().collection('asyncWorkers')
      .where('lastHeartbeat', '>=',
        admin.firestore.Timestamp.fromDate(new Date(Date.now() - 300_000)))
      .get()
  ]);

  const jobs = recentSnap.docs.map(d => d.data());
  const total     = jobs.length;
  const completed = jobs.filter(j => j.status === S.COMPLETED).length;
  const failed    = jobs.filter(j => j.status === S.FAILED).length;
  const running   = jobs.filter(j => j.status === S.RUNNING).length;
  const retrying  = jobs.filter(j => j.status === S.RETRYING).length;

  const execTimes = jobs
    .filter(j => j.completedAt && j.startedAt)
    .map(j => j.completedAt.toMillis() - j.startedAt.toMillis());

  const avgExecMs = execTimes.length
    ? Math.round(execTimes.reduce((a, b) => a + b, 0) / execTimes.length)
    : 0;

  const p95ExecMs = execTimes.length
    ? execTimes.sort((a, b) => a - b)[Math.floor(execTimes.length * 0.95)]
    : 0;

  const byType = {};
  const byStatus = {};
  for (const j of jobs) {
    byType[j.type]     = (byType[j.type] || 0) + 1;
    byStatus[j.status] = (byStatus[j.status] || 0) + 1;
  }

  return {
    period:      { hours, since: new Date(Date.now() - hours * 3_600_000).toISOString() },
    summary:     { total, completed, failed, running, retrying, dlq: dlqSnap.size },
    successRate: total > 0 ? Math.round((completed / total) * 100) : 100,
    avgExecMs,
    p95ExecMs,
    byType,
    byStatus,
    activeWorkers: workerSnap.size,
    recentFailed: jobs
      .filter(j => j.status === S.FAILED)
      .slice(0, 15)
      .map(j => ({
        jobId: j.jobId, type: j.type,
        error: j.error?.message, retryCount: j.retryCount,
        createdAt: j.createdAt?.toMillis?.() || null
      })),
    dlqSample: dlqSnap.docs.slice(0, 10).map(d => {
      const j = d.data();
      return { dlqId: d.id, type: j.type, reason: j.dlqReason,
               movedAt: j.movedAt?.toMillis?.() || null };
    })
  };
});

// ── inspectJob (admin) ─────────────────────────────────────────────────────

exports.inspectJob = onCall(CALL_OPTS, async ({ data, auth }) => {
  _requireAdmin(auth);
  const jobId = _san(data?.jobId || '');
  if (!jobId) throw new HttpsError('invalid-argument', 'jobId required.');

  let snap = await db().collection('asyncJobs').doc(jobId).get();
  let inDLQ = false;
  if (!snap.exists) {
    snap = await db().collection('asyncJobsDLQ').doc(jobId).get();
    inDLQ = true;
  }
  if (!snap.exists) throw new HttpsError('not-found', 'Job not found in jobs or DLQ.');

  const j = snap.data();
  return { ...j, payload: _maskSecrets(j.payload), inDLQ };
});

// ── bulkCancelJobs (admin) ─────────────────────────────────────────────────

exports.bulkCancelJobs = onCall(CALL_OPTS, async ({ data, auth }) => {
  _requireAdmin(auth);
  const { type, priorityLabel, olderThanHours = 24 } = data || {};
  const cutoff = admin.firestore.Timestamp.fromDate(
    new Date(Date.now() - (olderThanHours * 3_600_000))
  );

  let q = db().collection('asyncJobs')
    .where('status', 'in', [S.QUEUED, S.WAITING])
    .where('createdAt', '<', cutoff);
  if (type)          q = q.where('type',          '==', type);
  if (priorityLabel) q = q.where('priorityLabel', '==', priorityLabel);

  const snap = await q.limit(200).get();
  if (snap.empty) return { cancelled: 0 };

  const chunks = [];
  for (let i = 0; i < snap.docs.length; i += 400) {
    chunks.push(snap.docs.slice(i, i + 400));
  }
  await Promise.all(chunks.map(chunk => {
    const b = db().batch();
    chunk.forEach(d => {
      b.update(d.ref, {
        status: S.CANCELLED,
        completedAt: ts(),
        auditLog: _audit(d.data().auditLog, { event: 'bulk_cancelled', actor: auth.uid })
      });
    });
    return b.commit();
  }));

  return { cancelled: snap.size };
});

// ── getWorkerStats (admin) ─────────────────────────────────────────────────

exports.getWorkerStats = onCall(CALL_OPTS, async ({ data, auth }) => {
  _requireAdmin(auth);
  const cutoff = admin.firestore.Timestamp.fromDate(new Date(Date.now() - 300_000));
  const snap   = await db().collection('asyncWorkers')
    .where('lastHeartbeat', '>=', cutoff).get();

  return {
    activeWorkers: snap.size,
    workers: snap.docs.map(d => {
      const w = d.data();
      return {
        workerId:      d.id,
        currentJobId:  w.currentJobId,
        jobsProcessed: w.jobsProcessed,
        startedAt:     w.startedAt?.toMillis?.() || null,
        lastHeartbeat: w.lastHeartbeat?.toMillis?.() || null
      };
    })
  };
});

// ── Convenience: submitEmailJob ────────────────────────────────────────────

exports.submitEmailJob = onCall(CALL_OPTS, async ({ data, auth }) => {
  _requireAuth(auth);
  const { to, subject, html, text, templateId, templateData } = data || {};
  if (!to || !subject) throw new HttpsError('invalid-argument', 'to and subject required.');

  const jobId  = _genJobId();
  const status = S.QUEUED;

  await db().collection('asyncJobs').doc(jobId).set({
    jobId, type: 'EMAIL', status,
    priority: PRIORITIES.HIGH, priorityLabel: 'HIGH',
    ownerId: auth.uid, workspaceId: '',
    payload: { to, subject, html, text, templateId, templateData },
    result: null, error: null,
    retryCount: 0, maxRetries: 5, retryDelayMs: 2000,
    progress: { current: 0, total: 100, message: 'Queued' },
    correlationId: '', idempotencyKey: '',
    scheduledFor: null,
    createdAt: ts(), startedAt: null, completedAt: null,
    workerInstance: null, lockedUntil: null,
    auditLog: [{ ts: new Date().toISOString(), event: 'created', actor: auth.uid }]
  });

  return { jobId, status };
});

// ── Convenience: submitWebhookJob ──────────────────────────────────────────

exports.submitWebhookJob = onCall(CALL_OPTS, async ({ data, auth }) => {
  _requireAuth(auth);
  const { url, payload: whPayload, webhookId, secret } = data || {};
  if (!url) throw new HttpsError('invalid-argument', 'url required.');

  const jobId = _genJobId();
  await db().collection('asyncJobs').doc(jobId).set({
    jobId, type: 'WEBHOOK', status: S.QUEUED,
    priority: PRIORITIES.NORMAL, priorityLabel: 'NORMAL',
    ownerId: auth.uid, workspaceId: '',
    payload: { url, payload: whPayload, webhookId, secret },
    result: null, error: null,
    retryCount: 0, maxRetries: 5, retryDelayMs: 2000,
    progress: { current: 0, total: 100, message: 'Queued' },
    correlationId: '', idempotencyKey: '',
    scheduledFor: null,
    createdAt: ts(), startedAt: null, completedAt: null,
    workerInstance: null, lockedUntil: null,
    auditLog: [{ ts: new Date().toISOString(), event: 'created', actor: auth.uid }]
  });

  return { jobId };
});

// ── Scheduler: Process Job Queue ───────────────────────────────────────────

exports.processJobQueue = onSchedule({
  schedule: 'every 1 minutes',
  region:   'us-central1',
  timeoutSeconds: 540
}, async () => {
  const workerId   = `wkr_${crypto.randomBytes(4).toString('hex')}`;
  const lockExpiry = admin.firestore.Timestamp.fromDate(
    new Date(Date.now() + LOCK_TTL_MS)
  );

  await db().collection('asyncWorkers').doc(workerId).set({
    workerId, currentJobId: null, jobsProcessed: 0,
    startedAt: ts(), lastHeartbeat: ts()
  });

  let processed = 0;
  try {
    for (const [label, priorityNum] of Object.entries(PRIORITIES)) {
      if (processed >= BATCH_SIZE) break;

      // Skip paused queues
      const qSnap = await db().collection('asyncQueues').doc(label).get();
      if (qSnap.exists && qSnap.data().paused) continue;

      const now = admin.firestore.Timestamp.now();
      const claimable = await db().collection('asyncJobs')
        .where('status', 'in', [S.QUEUED, S.RETRYING])
        .where('priority', '==', priorityNum)
        .orderBy('createdAt', 'asc')
        .limit(BATCH_SIZE - processed)
        .get();

      for (const doc of claimable.docs) {
        if (processed >= BATCH_SIZE) break;
        const ref = doc.ref;

        const claimed = await db().runTransaction(async t => {
          const fresh = await t.get(ref);
          if (!fresh.exists) return false;
          const j = fresh.data();
          if (![S.QUEUED, S.RETRYING].includes(j.status)) return false;
          if (j.lockedUntil && j.lockedUntil.toMillis() > Date.now()) return false;
          if (j.scheduledFor && j.scheduledFor.toMillis() > Date.now()) return false;

          t.update(ref, {
            status:         S.RUNNING,
            startedAt:      ts(),
            workerInstance: workerId,
            lockedUntil:    lockExpiry,
            'progress.message': 'Processing'
          });
          return true;
        }).catch(() => false);

        if (!claimed) continue;

        await db().collection('asyncWorkers').doc(workerId).update({
          currentJobId:   doc.id,
          lastHeartbeat:  ts()
        }).catch(() => {});

        await _executeJob(doc.data(), ref, workerId);
        processed++;
      }
    }
  } finally {
    await db().collection('asyncWorkers').doc(workerId).delete().catch(() => {});
  }

  if (processed > 0) {
    console.log(`[processJobQueue] worker=${workerId} processed=${processed}`);
  }
});

// ── Trigger: Immediate dispatch for CRITICAL / HIGH ────────────────────────

exports.onJobCreated = onDocumentCreated({
  document: 'asyncJobs/{jobId}',
  region:   'us-central1'
}, async event => {
  const job = event.data?.data();
  if (!job) return;
  if (job.priority > PRIORITIES.HIGH)  return;  // only CRITICAL + HIGH
  if (job.status !== S.QUEUED)         return;

  const workerId   = `imm_${crypto.randomBytes(4).toString('hex')}`;
  const lockExpiry = admin.firestore.Timestamp.fromDate(new Date(Date.now() + LOCK_TTL_MS));
  const ref        = event.data.ref;

  const claimed = await db().runTransaction(async t => {
    const fresh = await t.get(ref);
    if (!fresh.exists || fresh.data().status !== S.QUEUED) return false;
    t.update(ref, {
      status: S.RUNNING, startedAt: ts(),
      workerInstance: workerId, lockedUntil: lockExpiry,
      'progress.message': 'Processing (immediate)'
    });
    return true;
  }).catch(() => false);

  if (!claimed) return;
  await _executeJob(job, ref, workerId);
});

// ── Scheduler: Stuck Job Recovery ─────────────────────────────────────────

exports.jobStuckRecovery = onSchedule({
  schedule: 'every 5 minutes',
  region:   'us-central1'
}, async () => {
  const staleAt = admin.firestore.Timestamp.fromDate(
    new Date(Date.now() - LOCK_TTL_MS)
  );

  const stuck = await db().collection('asyncJobs')
    .where('status',      '==', S.RUNNING)
    .where('lockedUntil', '<',  staleAt)
    .limit(50).get();

  if (stuck.empty) return;

  const b = db().batch();
  const dlqPromises = [];

  for (const doc of stuck.docs) {
    const j       = doc.data();
    const newRetry = (j.retryCount || 0) + 1;

    if (newRetry > j.maxRetries) {
      dlqPromises.push(_moveToDLQ(j.jobId, j, 'worker_timeout'));
      b.update(doc.ref, {
        status: S.DEAD_LETTER, completedAt: ts(),
        error: { message: 'Worker timeout — max retries exceeded', code: 'WORKER_TIMEOUT' },
        lockedUntil: null,
        auditLog: _audit(j.auditLog, { event: 'dead_letter_timeout' })
      });
    } else {
      const delayMs = _backoff(newRetry);
      b.update(doc.ref, {
        status:         S.RETRYING,
        retryCount:     newRetry,
        lockedUntil:    null,
        workerInstance: null,
        scheduledFor:   admin.firestore.Timestamp.fromDate(new Date(Date.now() + delayMs)),
        'error.message': 'Worker timed out — requeueing',
        auditLog: _audit(j.auditLog, { event: 'stuck_recovery', newRetry })
      });
    }
  }

  await Promise.all([b.commit(), ...dlqPromises]);
  console.log(`[jobStuckRecovery] recovered=${stuck.size}`);
});

// ── Scheduler: Daily Cleanup ───────────────────────────────────────────────

exports.jobCleanupScheduled = onSchedule({
  schedule: 'every day 03:30',
  timeZone: 'Africa/Nairobi',
  region:   'us-central1'
}, async () => {
  const cutoff = admin.firestore.Timestamp.fromDate(
    new Date(Date.now() - CLEANUP_DAYS * 86_400_000)
  );

  const old = await db().collection('asyncJobs')
    .where('status',      'in', [S.COMPLETED, S.CANCELLED])
    .where('completedAt', '<',  cutoff)
    .limit(400).get();

  if (!old.empty) {
    const b = db().batch();
    old.docs.forEach(d => b.delete(d.ref));
    await b.commit();
    console.log(`[jobCleanup] deleted=${old.size} completed/cancelled jobs`);
  }

  // Clean stale worker records
  const staleWorkers = await db().collection('asyncWorkers')
    .where('lastHeartbeat', '<',
      admin.firestore.Timestamp.fromDate(new Date(Date.now() - 3_600_000)))
    .get();
  if (!staleWorkers.empty) {
    const b2 = db().batch();
    staleWorkers.docs.forEach(d => b2.delete(d.ref));
    await b2.commit();
  }
});

// ── Internal: Execute Job ──────────────────────────────────────────────────

async function _executeJob(job, ref, workerId) {
  const { handlers } = require('./async-job-handlers');
  const handler = handlers[job.type];

  if (!handler) {
    await ref.update({
      status: S.FAILED,
      completedAt: ts(),
      error: { message: `No handler registered for job type: ${job.type}`, code: 'NO_HANDLER' },
      lockedUntil: null,
      auditLog: _audit(job.auditLog, { event: 'no_handler', type: job.type })
    }).catch(() => {});
    return;
  }

  try {
    // Progress: started
    await ref.update({ 'progress.current': 10, 'progress.message': 'Running handler' })
      .catch(() => {});

    const result = await handler.execute(job);

    await ref.update({
      status: S.COMPLETED,
      completedAt: ts(),
      result: result || null,
      lockedUntil: null,
      'progress.current': 100,
      'progress.message': 'Completed',
      auditLog: _audit(job.auditLog, { event: 'completed', worker: workerId })
    });

  } catch (err) {
    const newRetry = (job.retryCount || 0) + 1;
    const canRetry = handler.canRetry ? handler.canRetry(err) : true;
    const errMsg   = err?.message || 'Unknown error';
    const errCode  = err?.code    || 'HANDLER_ERROR';

    if (canRetry && newRetry <= (job.maxRetries || 3)) {
      const delayMs = _backoff(newRetry, job.retryDelayMs || 2000);
      await ref.update({
        status:         S.RETRYING,
        retryCount:     newRetry,
        error:          { message: errMsg, code: errCode },
        lockedUntil:    null,
        workerInstance: null,
        scheduledFor:   admin.firestore.Timestamp.fromDate(new Date(Date.now() + delayMs)),
        'progress.message': `Retry ${newRetry}/${job.maxRetries}`,
        auditLog: _audit(job.auditLog, { event: 'retry', retryCount: newRetry, error: errMsg })
      }).catch(() => {});
    } else {
      const updated = { ...job, retryCount: newRetry, error: { message: errMsg, code: errCode } };
      await _moveToDLQ(job.jobId, updated, errMsg).catch(() => {});
      await ref.update({
        status:         S.DEAD_LETTER,
        completedAt:    ts(),
        error:          { message: errMsg, code: errCode },
        lockedUntil:    null,
        auditLog: _audit(job.auditLog, { event: 'dead_letter', error: errMsg, retryCount: newRetry })
      }).catch(() => {});
    }

    console.error(`[asyncJobs] job=${job.jobId} type=${job.type} error: ${errMsg}`);
  }
}

async function _moveToDLQ(jobId, job, reason) {
  await db().collection('asyncJobsDLQ').doc(jobId).set({
    ...job,
    movedAt:   ts(),
    dlqReason: reason
  }).catch(e => console.error(`[asyncJobs] DLQ write failed: ${e.message}`));
}
