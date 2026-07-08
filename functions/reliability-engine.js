/* ================================================================
   SOKONI — Reliability Engine  v1.0.0  |  2026-07-08
   functions/reliability-engine.js

   9 Cloud Functions for distributed task management, circuit-breaker
   administration, health probing, and ops-centre dashboards.

   Callable (admin-gated unless noted):
     relEnqueueTask           — any auth — add task to retry queue
     relGetDeadLetterQueue    — admin — list failed tasks (paginated)
     relRetryDeadLetter       — admin — requeue one dead-letter task
     relPurgeDeadLetter       — admin — batch-delete old dead tasks
     relCircuitBreakerState   — admin — read / force CB states
     relHealthProbeAll        — admin — live probe of all services
     relGetSystemMetrics      — admin — queue + CB + health summary

   Scheduled:
     relScheduledHealthCheck   — every 5 minutes — probe + alert on 3x failure
     relScheduledRetryProcessor — every 1 minute — process pending tasks

   Firestore collections:
     _sokoniTaskQueue/{taskId}       distributed task queue
     _sokoniCircuitBreakers/{name}   server-side CB state store
     _sokoniHealth/{ts}              health check history (24 h window)
     _sokoniAlertFired               fired alert records
     _health/probe                   Firestore connectivity probe doc

   Task handler registration:
     Call registerTaskHandler('myType', async payload => { ... })
     at module-load time from any file that requires this module.
     The scheduled processor invokes registered handlers by taskType.

   Do NOT import or re-export from functions/index.js.
================================================================ */
'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule }         = require('firebase-functions/v2/scheduler');
const admin                  = require('firebase-admin');
const logger                 = require('firebase-functions/logger');
const https                  = require('https');

/* ── Firestore shorthands ────────────────────────────────────── */
const _db  = () => admin.firestore();
const _ts  = () => admin.firestore.FieldValue.serverTimestamp();

/* ── CF option presets ───────────────────────────────────────── */
const _cfg = {
  enforceAppCheck: true,
  region:          'us-central1',
  memory:          '256MiB',
};
const _cfgHeavy = {
  enforceAppCheck: true,
  region:          'us-central1',
  memory:          '512MiB',
  timeoutSeconds:  120,
};
const _cfgSched = {
  region:   'us-central1',
  timeZone: 'Africa/Nairobi',
  memory:   '256MiB',
};

/* ── Admin assertion ─────────────────────────────────────────── */
function _assertAdmin(req) {
  if (!req.auth?.uid) throw new HttpsError('unauthenticated', 'Authentication required.');
  const t = req.auth?.token ?? {};
  if (!t.admin && !t.superAdmin)
    throw new HttpsError('permission-denied', 'Admin access required.');
  return req.auth.uid;
}

/* ── Unique task ID ──────────────────────────────────────────── */
function _taskId() {
  return 'tsk_' + Date.now().toString(36) + '_' +
         Math.random().toString(36).slice(2, 8);
}

/* ── Structured audit log ────────────────────────────────────── */
function _audit(action, meta = {}) {
  logger.info(JSON.stringify({ audit: true, action, ...meta }));
}

/* ================================================================
   IN-MEMORY TASK HANDLER REGISTRY
   ─────────────────────────────────
   Handlers must be registered at module-load time so they are
   available when the scheduled processor function runs.

   Example (in another module):
     const { registerTaskHandler } = require('./reliability-engine');
     registerTaskHandler('sendNotification', async payload => {
       await sendPushNotification(payload.userId, payload.message);
     });
================================================================ */
const _taskHandlers = new Map();

/**
 * Register a handler for a task type.
 * Must be called at module-load time.
 *
 * @param {string}   taskType
 * @param {Function} handler   async (payload: object) => any
 */
function registerTaskHandler(taskType, handler) {
  if (typeof handler !== 'function')
    throw new TypeError(`Handler for '${taskType}' must be a function.`);
  _taskHandlers.set(taskType, handler);
  logger.info(`[reliability] Handler registered: '${taskType}'`);
}
exports.registerTaskHandler = registerTaskHandler;

/* ================================================================
   HEALTH CHECK HELPERS
   Each helper returns { status, latencyMs[, error] }.
   'healthy' | 'unhealthy' | 'not_configured' | 'error'
================================================================ */

/** Write then read a Firestore probe document; 2 s budget. */
async function _checkFirestore() {
  const start = Date.now();
  try {
    const ref = _db().collection('_health').doc('probe');
    await Promise.race([
      (async () => {
        await ref.set({ probe: true, checkedAt: _ts() });
        await ref.get();
      })(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('Timeout')), 2_000)),
    ]);
    return { status: 'healthy', latencyMs: Date.now() - start };
  } catch (err) {
    return { status: 'unhealthy', latencyMs: Date.now() - start, error: err.message };
  }
}

/** Ping Redis via ioredis; 1.5 s budget. Skipped when REDIS_URL is unset. */
async function _checkRedis() {
  const url = process.env.REDIS_URL;
  if (!url) return { status: 'not_configured', latencyMs: 0 };

  const start = Date.now();
  let client;
  try {
    const Redis = require('ioredis');  // already a project dependency
    client = new Redis(url, {
      lazyConnect:          true,
      connectTimeout:       1_500,
      enableReadyCheck:     false,
      maxRetriesPerRequest: 0,
      retryStrategy:        () => null,   // no auto-retry
    });
    await Promise.race([
      (async () => { await client.connect(); await client.ping(); })(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('Redis ping timeout')), 1_500)),
    ]);
    return { status: 'healthy', latencyMs: Date.now() - start };
  } catch (err) {
    return { status: 'unhealthy', latencyMs: Date.now() - start, error: err.message };
  } finally {
    if (client) { try { client.disconnect(); } catch (_) {} }
  }
}

/** HEAD request to IntaSend API; 3 s budget. */
async function _checkIntaSend() {
  const start = Date.now();
  try {
    await _headRequest('api.intasend.com', '/api/v1/', 3_000);
    return { status: 'healthy', latencyMs: Date.now() - start };
  } catch (err) {
    return { status: 'unhealthy', latencyMs: Date.now() - start, error: err.message };
  }
}

/** HEAD request to Anthropic API; 3 s budget. */
async function _checkAnthropic() {
  const start = Date.now();
  try {
    await _headRequest('api.anthropic.com', '/v1/', 3_000);
    return { status: 'healthy', latencyMs: Date.now() - start };
  } catch (err) {
    return { status: 'unhealthy', latencyMs: Date.now() - start, error: err.message };
  }
}

/** Minimal HTTPS HEAD helper. Resolves with HTTP status code. */
function _headRequest(hostname, path, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`HEAD https://${hostname}${path} timed out after ${timeoutMs} ms`)),
      timeoutMs
    );
    const req = https.request({ hostname, path, method: 'HEAD' }, res => {
      clearTimeout(timer);
      resolve(res.statusCode);
    });
    req.on('error', err => { clearTimeout(timer); reject(err); });
    req.end();
  });
}

/** Run all four probes concurrently; never throws. */
async function _runAllChecks() {
  const [fs, rd, is, an] = await Promise.allSettled([
    _checkFirestore(),
    _checkRedis(),
    _checkIntaSend(),
    _checkAnthropic(),
  ]);
  function _unwrap(r) {
    return r.status === 'fulfilled' ? r.value : { status: 'error', error: r.reason?.message };
  }
  return {
    firestore: _unwrap(fs),
    redis:     _unwrap(rd),
    intasend:  _unwrap(is),
    anthropic: _unwrap(an),
  };
}

/* ================================================================
   1. relEnqueueTask  ─ onCall (any authenticated user)
   ────────────────────────────────────────────────────
   Input:  { taskType, payload, priority, maxRetries, scheduleFor }
   Output: { taskId }
================================================================ */
exports.relEnqueueTask = onCall(_cfg, async req => {
  if (!req.auth) throw new HttpsError('unauthenticated', 'Authentication required.');

  const {
    taskType,
    payload    = {},
    priority   = 'NORMAL',
    maxRetries = 3,
    scheduleFor,
  } = req.data || {};

  if (!taskType || typeof taskType !== 'string')
    throw new HttpsError('invalid-argument', 'taskType (non-empty string) is required.');

  const validPriorities = ['HIGH', 'NORMAL', 'LOW'];
  const normP = (priority + '').toUpperCase();
  if (!validPriorities.includes(normP))
    throw new HttpsError('invalid-argument',
      `priority must be one of: ${validPriorities.join(', ')}`);

  const scheduleDate = scheduleFor ? new Date(scheduleFor) : new Date();
  if (isNaN(scheduleDate.getTime()))
    throw new HttpsError('invalid-argument', 'scheduleFor must be a valid ISO timestamp.');

  const taskId = _taskId();

  await _db().collection('_sokoniTaskQueue').doc(taskId).set({
    taskId,
    taskType,
    payload,
    priority:    normP,
    maxRetries:  Math.min(Math.max(parseInt(maxRetries) || 3, 1), 10),
    retryCount:  0,
    status:      'pending',
    scheduleFor: scheduleDate,
    createdBy:   req.auth.uid,
    createdAt:   _ts(),
    updatedAt:   _ts(),
  });

  logger.info('[rel] Task enqueued', { taskId, taskType, priority: normP });
  return { taskId };
});

/* ================================================================
   2. relGetDeadLetterQueue  ─ onCall (admin)
   ───────────────────────────────────────────
   Filter by taskType, from, to.  Cursor pagination via pageToken.
   Output: { tasks[], total, hasMore, nextPageToken }
================================================================ */
exports.relGetDeadLetterQueue = onCall(_cfg, async req => {
  _assertAdmin(req);

  const {
    taskType,
    from,
    to,
    pageSize  = 20,
    pageToken = null,
  } = req.data || {};

  const limit = Math.min(Math.max(parseInt(pageSize) || 20, 1), 100);

  let q = _db()
    .collection('_sokoniTaskQueue')
    .where('status', '==', 'dead_letter')
    .orderBy('createdAt', 'desc');

  /* Equality filters can stack freely with the orderBy field. */
  if (taskType) q = q.where('taskType', '==', taskType);
  if (from)     q = q.where('createdAt', '>=', new Date(from));
  if (to)       q = q.where('createdAt', '<=', new Date(to));

  /* Cursor pagination. */
  if (pageToken) {
    const pivot = await _db().collection('_sokoniTaskQueue').doc(pageToken).get();
    if (pivot.exists) q = q.startAfter(pivot);
  }

  /* Fetch limit+1 to determine whether a next page exists. */
  const snap    = await q.limit(limit + 1).get();
  const hasMore = snap.docs.length > limit;
  const page    = snap.docs.slice(0, limit);

  /* Total dead-letter count (separate aggregate query). */
  const totalSnap = await _db()
    .collection('_sokoniTaskQueue')
    .where('status', '==', 'dead_letter')
    .count()
    .get();

  return {
    tasks:         page.map(d => ({ id: d.id, ...d.data() })),
    total:         totalSnap.data().count,
    hasMore,
    nextPageToken: hasMore ? page[page.length - 1].id : null,
  };
});

/* ================================================================
   3. relRetryDeadLetter  ─ onCall (admin)
   ─────────────────────────────────────────
   Reset one dead-letter task back to pending.
   Input:  { taskId }
   Output: { taskId, requeued: true }
================================================================ */
exports.relRetryDeadLetter = onCall(_cfg, async req => {
  const adminUid = _assertAdmin(req);
  const { taskId } = req.data || {};

  if (!taskId) throw new HttpsError('invalid-argument', 'taskId is required.');

  const ref = _db().collection('_sokoniTaskQueue').doc(taskId);
  const doc = await ref.get();

  if (!doc.exists)
    throw new HttpsError('not-found', `Task '${taskId}' not found.`);

  const { status } = doc.data();
  if (status !== 'dead_letter')
    throw new HttpsError('failed-precondition',
      `Task '${taskId}' is in status '${status}', not 'dead_letter'.`);

  await ref.update({
    status:               'pending',
    retryCount:           0,
    scheduleFor:          new Date(),    // run on next processor tick
    requeuedAt:           _ts(),
    requeuedBy:           adminUid,
    updatedAt:            _ts(),
    deadLetterReason:     admin.firestore.FieldValue.delete(),
    deadLetterAt:         admin.firestore.FieldValue.delete(),
  });

  _audit('relRetryDeadLetter', { taskId, adminUid });
  logger.info('[rel] Dead-letter task requeued', { taskId });
  return { taskId, requeued: true };
});

/* ================================================================
   4. relPurgeDeadLetter  ─ onCall (admin)
   ─────────────────────────────────────────
   Batch-delete dead-letter tasks older than `olderThan`.
   Input:  { olderThan }  ISO timestamp
   Output: { deleted: N }
================================================================ */
exports.relPurgeDeadLetter = onCall(_cfgHeavy, async req => {
  const adminUid = _assertAdmin(req);
  const { olderThan } = req.data || {};

  if (!olderThan)
    throw new HttpsError('invalid-argument', 'olderThan timestamp is required.');

  const cutoff = new Date(olderThan);
  if (isNaN(cutoff.getTime()))
    throw new HttpsError('invalid-argument', 'olderThan must be a valid timestamp.');

  let deleted = 0;

  /* Delete in 500-doc batches to stay within Firestore limits. */
  while (true) {
    const snap = await _db()
      .collection('_sokoniTaskQueue')
      .where('status',    '==', 'dead_letter')
      .where('createdAt', '<',  cutoff)
      .limit(500)
      .get();

    if (snap.empty) break;

    const batch = _db().batch();
    snap.docs.forEach(d => batch.delete(d.ref));
    await batch.commit();
    deleted += snap.docs.length;

    if (snap.docs.length < 500) break;   // last page
  }

  _audit('relPurgeDeadLetter', { deleted, cutoff: cutoff.toISOString(), adminUid });
  logger.info('[rel] Dead-letter tasks purged', { deleted });
  return { deleted };
});

/* ================================================================
   5. relCircuitBreakerState  ─ onCall (admin)
   ─────────────────────────────────────────────
   GET  (no name/action)  → list all CB states from Firestore.
   POST (name + action)   → force_open | force_close | reset a CB.
   Output GET:  { breakers[] }
   Output POST: { name, action, success: true }
================================================================ */
exports.relCircuitBreakerState = onCall(_cfg, async req => {
  const adminUid = _assertAdmin(req);
  const { name, action } = req.data || {};

  if (action && name) {
    /* ── Mutate ─────────────────────────────────────────────── */
    const validActions = ['force_open', 'force_close', 'reset'];
    if (!validActions.includes(action))
      throw new HttpsError('invalid-argument',
        `action must be one of: ${validActions.join(', ')}`);

    const ref = _db().collection('_sokoniCircuitBreakers').doc(name);

    let patch;
    if (action === 'force_open') {
      patch = {
        state:    'OPEN',
        openedAt: _ts(),
        forcedBy: adminUid,
        forcedAt: _ts(),
        updatedAt: _ts(),
      };
    } else if (action === 'force_close') {
      patch = {
        state:    'CLOSED',
        failures: [],
        successes: 0,
        openedAt: null,
        forcedBy: adminUid,
        forcedAt: _ts(),
        updatedAt: _ts(),
      };
    } else /* reset */ {
      patch = {
        state:     'CLOSED',
        failures:  [],
        successes: 0,
        rejections: 0,
        openedAt:  null,
        forcedBy:  null,
        forcedAt:  null,
        updatedAt: _ts(),
      };
    }

    await ref.set(patch, { merge: true });
    _audit('relCircuitBreakerState', { name, action, adminUid });
    logger.info('[rel] Circuit breaker changed', { name, action });
    return { name, action, success: true };

  } else {
    /* ── Read all ──────────────────────────────────────────── */
    const snap = await _db().collection('_sokoniCircuitBreakers').limit(100).get();
    return {
      breakers: snap.docs.map(d => ({ name: d.id, ...d.data() })),
    };
  }
});

/* ================================================================
   6. relHealthProbeAll  ─ onCall (admin)
   ───────────────────────────────────────
   Probe Firestore, Redis, IntaSend, Anthropic.
   Output: { firestore, redis, intasend, anthropic } each with
           { status, latencyMs[, error] }
================================================================ */
exports.relHealthProbeAll = onCall(_cfgHeavy, async req => {
  _assertAdmin(req);
  const results = await _runAllChecks();
  logger.info('[rel] Health probe completed', results);
  return results;
});

/* ================================================================
   7. relScheduledHealthCheck  ─ every 5 minutes
   ───────────────────────────────────────────────
   • Probes all four services concurrently.
   • Writes result to _sokoniHealth/{timestamp}.
   • If any service is unhealthy for 3 consecutive checks, writes
     a CRITICAL alert to _sokoniAlertFired.
   • Prunes _sokoniHealth docs older than 24 h (rolling window).
================================================================ */
exports.relScheduledHealthCheck = onSchedule(
  { ..._cfgSched, schedule: '*/5 * * * *' },
  async () => {
    const results = await _runAllChecks();
    const nowMs   = Date.now();
    const docId   = nowMs.toString();

    /* Persist snapshot. */
    await _db().collection('_sokoniHealth').doc(docId).set({
      ...results,
      checkedAt: new Date(nowMs),
      serverTs:  _ts(),
    });

    /* Identify unhealthy services (ignore 'not_configured'). */
    const unhealthy = Object.entries(results)
      .filter(([, v]) => v.status !== 'healthy' && v.status !== 'not_configured')
      .map(([k]) => k);

    if (unhealthy.length > 0) {
      /* Load last 3 snapshots (descending). The one we just wrote is included. */
      const recent = await _db()
        .collection('_sokoniHealth')
        .orderBy('checkedAt', 'desc')
        .limit(3)
        .get();

      /* Fire alert only when all 3 most-recent snapshots show the same failure. */
      if (recent.size >= 3) {
        const allFailing = recent.docs.every(d => {
          const data = d.data();
          return unhealthy.every(svc => {
            const s = data[svc]?.status;
            return s && s !== 'healthy' && s !== 'not_configured';
          });
        });

        if (allFailing) {
          const recentAlertSnap = await _db().collection('_sokoniAlertFired')
            .where('type', '==', 'health_check_failure')
            .where('firedAt', '>=', new Date(Date.now() - 30 * 60 * 1000)) // 30-min cooldown
            .limit(1)
            .get();
          if (!recentAlertSnap.empty) {
            logger.info('[rel] health alert suppressed — within cooldown window');
            return; // skip writing duplicate alert
          }
          await _db().collection('_sokoniAlertFired').add({
            type:     'health_check_consecutive_failure',
            services: unhealthy,
            results,
            severity: 'CRITICAL',
            firedAt:  _ts(),
          });
          logger.error('[rel] ALERT: 3 consecutive health check failures',
            { unhealthy, results });
        }
      }
    }

    /* Prune snapshots older than 24 h (up to 100 per run). */
    const cutoff = new Date(nowMs - 24 * 60 * 60_000);
    const stale  = await _db()
      .collection('_sokoniHealth')
      .where('checkedAt', '<', cutoff)
      .limit(100)
      .get();

    if (!stale.empty) {
      const b = _db().batch();
      stale.docs.forEach(d => b.delete(d.ref));
      await b.commit();
    }

    logger.info('[rel] Scheduled health check complete',
      { unhealthy, stale_pruned: stale.size });
  }
);

/* ================================================================
   8. relScheduledRetryProcessor  ─ every minute
   ──────────────────────────────────────────────
   • Reads up to 50 tasks with status='pending' and scheduleFor ≤ now.
   • Uses a Firestore transaction to lock each task (status →
     'processing') preventing duplicate execution across instances.
   • Calls the registered handler; on success sets status='completed'.
   • On failure: increments retryCount; if ≥ maxRetries sets
     status='dead_letter'; otherwise reschedules with exponential
     backoff (2^retryCount seconds, capped at 1 hour).
================================================================ */
const _PROC_BATCH = 50;

exports.relScheduledRetryProcessor = onSchedule(
  { ..._cfgSched, schedule: '* * * * *', timeoutSeconds: 540, memory: '512MiB' },
  async () => {
    const now = new Date();

    const snap = await _db()
      .collection('_sokoniTaskQueue')
      .where('status',      '==', 'pending')
      .where('scheduleFor', '<=', now)
      .orderBy('scheduleFor', 'asc')
      .limit(_PROC_BATCH)
      .get();

    if (snap.empty) {
      logger.info('[rel] Retry processor: no tasks due.');
      return;
    }

    logger.info(`[rel] Retry processor: ${snap.docs.length} tasks due.`);

    for (const docSnap of snap.docs) {
      const task    = { id: docSnap.id, ...docSnap.data() };
      const taskRef = _db().collection('_sokoniTaskQueue').doc(task.id);

      /* ── Optimistic lock via transaction ─────────────────── */
      try {
        await _db().runTransaction(async tx => {
          const fresh = await tx.get(taskRef);
          /* Skip if another instance already claimed or completed this task. */
          if (!fresh.exists || fresh.data().status !== 'pending') {
            const err   = new Error('Task already claimed or gone.');
            err.code    = 'SKIP';
            throw err;
          }
          tx.update(taskRef, {
            status:             'processing',
            processingStartAt:  _ts(),
            updatedAt:          _ts(),
          });
        });
      } catch (lockErr) {
        if (lockErr.code === 'SKIP') continue;
        logger.warn('[rel] Lock failed', { taskId: task.id, error: lockErr.message });
        continue;
      }

      const handler    = _taskHandlers.get(task.taskType);
      const retryCount = (task.retryCount || 0) + 1;
      const maxRetries = task.maxRetries  || 3;

      /* ── No handler registered → dead-letter immediately ─── */
      if (!handler) {
        await taskRef.update({
          status:           'dead_letter',
          retryCount,
          deadLetterReason: `No handler registered for taskType '${task.taskType}'.`,
          deadLetterAt:     _ts(),
          updatedAt:        _ts(),
        });
        logger.warn('[rel] Dead-lettered (no handler)',
          { taskId: task.id, taskType: task.taskType });
        continue;
      }

      /* ── Execute handler ─────────────────────────────────── */
      try {
        await handler(task.payload || {});

        await taskRef.update({
          status:      'completed',
          completedAt: _ts(),
          updatedAt:   _ts(),
        });
        logger.info('[rel] Task completed',
          { taskId: task.id, taskType: task.taskType });

      } catch (handlerErr) {
        if (retryCount >= maxRetries) {
          /* Max retries exhausted → dead-letter. */
          await taskRef.update({
            status:           'dead_letter',
            retryCount,
            deadLetterReason: handlerErr.message,
            deadLetterAt:     _ts(),
            updatedAt:        _ts(),
          });
          logger.error('[rel] Task dead-lettered after max retries',
            { taskId: task.id, taskType: task.taskType, retryCount, error: handlerErr.message });
        } else {
          /* Exponential backoff: 2^retryCount seconds, cap at 1 hour. */
          const backoffMs = Math.min(1_000 * Math.pow(2, retryCount), 3_600_000);
          const nextAt    = new Date(Date.now() + backoffMs);

          await taskRef.update({
            status:      'pending',
            retryCount,
            lastError:   handlerErr.message,
            scheduleFor: nextAt,
            updatedAt:   _ts(),
          });
          logger.info('[rel] Task rescheduled for retry',
            { taskId: task.id, retryCount, maxRetries, nextAt: nextAt.toISOString(), backoffMs });
        }
      }
    }

    logger.info('[rel] Retry processor cycle complete.',
      { processed: snap.docs.length });
  }
);

/* ================================================================
   9. relGetSystemMetrics  ─ onCall (admin)
   ─────────────────────────────────────────
   Returns:
   • Task queue depth by status
   • Oldest dead-letter task age (ms)
   • Circuit breaker state summary
   • Last 24 h health check history
================================================================ */
exports.relGetSystemMetrics = onCall(_cfgHeavy, async req => {
  _assertAdmin(req);

  const statuses = ['pending', 'processing', 'completed', 'dead_letter'];

  /* Run all queries concurrently for low latency. */
  const [countResults, breakersSnap, healthSnap, oldestDLSnap] = await Promise.all([

    /* Task queue depth per status (count aggregation — no documents read). */
    Promise.all(statuses.map(s =>
      _db().collection('_sokoniTaskQueue')
        .where('status', '==', s)
        .count()
        .get()
        .then(r => [s, r.data().count])
    )),

    /* All circuit breaker state docs. */
    _db().collection('_sokoniCircuitBreakers').get(),

    /* Last 24 h of health snapshots (288 docs @ 5-min intervals). */
    _db().collection('_sokoniHealth')
      .orderBy('checkedAt', 'desc')
      .limit(288)
      .get(),

    /* Oldest dead-letter task (for SLA / staleness reporting). */
    _db().collection('_sokoniTaskQueue')
      .where('status', '==', 'dead_letter')
      .orderBy('createdAt', 'asc')
      .limit(1)
      .get(),
  ]);

  /* Build depth map: { pending: N, processing: N, ... } */
  const queueDepth = Object.fromEntries(countResults);

  /* Compute oldest dead-letter age. */
  let oldestDLAgeMs = null;
  if (!oldestDLSnap.empty) {
    const ts = oldestDLSnap.docs[0].data().createdAt;
    if (ts && ts.toDate) oldestDLAgeMs = Date.now() - ts.toDate().getTime();
  }

  return {
    taskQueue: {
      ...queueDepth,
      oldestDeadLetterAgeMs: oldestDLAgeMs,
    },
    circuitBreakers: breakersSnap.docs.map(d => ({
      name:      d.id,
      state:     d.data().state,
      updatedAt: d.data().updatedAt,
    })),
    healthHistory: healthSnap.docs.map(d => ({
      id:        d.id,
      checkedAt: d.data().checkedAt,
      firestore: d.data().firestore,
      redis:     d.data().redis,
      intasend:  d.data().intasend,
      anthropic: d.data().anthropic,
    })),
  };
});
