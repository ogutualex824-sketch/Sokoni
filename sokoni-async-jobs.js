/**
 * SokoniAsyncJobs — Client SDK for the SOKONI Async Jobs Engine v1.0
 * Usage: SokoniAsyncJobs.create(type, payload, options)
 */
(function (window) {
  'use strict';

  const JOB_TYPES = [
    'EMAIL','SMS','PUSH','RECEIPT','PDF','ETIMS',
    'INVENTORY_RECALC','INVENTORY_ALERT','ANALYTICS','ANALYTICS_AGGREGATE',
    'REPORT','REPORT_GENERATE','IMAGE_OPT','AI_PROCESS',
    'PRODUCT_INDEX','SEARCH_INDEX','RECO_UPDATE',
    'WEBHOOK','BULK_IMPORT','BULK_EXPORT',
    'SCHEDULED_CLEANUP','DB_MAINTENANCE','BACKUP_VERIFY',
    'REDIS_WARMUP','EXTERNAL_SYNC',
    'LOYALTY_UPDATE','SELLER_NOTIFICATION','CUSTOMER_SEGMENT'
  ];

  const PRIORITIES  = ['CRITICAL','HIGH','NORMAL','LOW','BACKGROUND'];
  const TERMINAL    = new Set(['completed','cancelled','failed','dead_letter']);

  function _fn(name) {
    if (!window._sokoniApp) throw new Error('Firebase app not initialised');
    return firebase.functions().httpsCallable(name);
  }

  function _call(name, data) {
    return _fn(name)(data).then(r => r.data);
  }

  // ── Core ─────────────────────────────────────────────────────────────────

  const SokoniAsyncJobs = {

    /** Create any job type */
    create(type, payload = {}, options = {}) {
      if (!JOB_TYPES.includes(type)) throw new Error(`Unknown job type: ${type}`);
      const {
        priority = 'NORMAL', workspaceId = '',
        idempotencyKey = '', scheduledFor = null,
        maxRetries = 3, correlationId = ''
      } = options;
      return _call('createJob', {
        type, payload, priority, workspaceId,
        idempotencyKey, scheduledFor, maxRetries, correlationId
      });
    },

    /** Shortcut: queue an email */
    sendEmail(to, subject, html, options = {}) {
      return _call('submitEmailJob', { to, subject, html, ...options });
    },

    /** Shortcut: queue a webhook delivery */
    deliverWebhook(url, payload, webhookId, secret) {
      return _call('submitWebhookJob', { url, payload, webhookId, secret });
    },

    // ── Status ────────────────────────────────────────────────────────────

    status(jobId) {
      return _call('getJob', { jobId });
    },

    myJobs(options = {}) {
      return _call('getMyJobs', options);
    },

    cancel(jobId) {
      return _call('cancelJob', { jobId });
    },

    // ── Realtime ──────────────────────────────────────────────────────────

    /**
     * Watch a job in realtime via Firestore.
     * Returns unsubscribe function.
     * callback(err, job)
     */
    watch(jobId, callback) {
      const db  = firebase.firestore();
      const ref = db.collection('asyncJobs').doc(jobId);
      return ref.onSnapshot(snap => {
        if (!snap.exists) { callback(null, null); return; }
        const j = snap.data();
        callback(null, {
          jobId:       j.jobId,
          type:        j.type,
          status:      j.status,
          priority:    j.priorityLabel,
          progress:    j.progress,
          result:      j.result,
          error:       j.error,
          retryCount:  j.retryCount,
          createdAt:   j.createdAt?.toMillis?.()   || null,
          completedAt: j.completedAt?.toMillis?.() || null
        });
      }, err => callback(err, null));
    },

    /**
     * Poll until a terminal status is reached.
     * Resolves with job on completion, rejects on failure.
     */
    waitFor(jobId, options = {}) {
      const { pollMs = 3000, timeoutMs = 300_000 } = options;
      const start = Date.now();
      return new Promise((resolve, reject) => {
        const tick = async () => {
          if (Date.now() - start > timeoutMs) {
            return reject(new Error(`waitFor: job ${jobId} timed out after ${timeoutMs}ms`));
          }
          try {
            const job = await SokoniAsyncJobs.status(jobId);
            if (TERMINAL.has(job.status)) {
              if (job.status === 'completed') resolve(job);
              else reject(Object.assign(new Error(job.error?.message || job.status), { job }));
            } else {
              setTimeout(tick, pollMs);
            }
          } catch (e) { reject(e); }
        };
        tick();
      });
    },

    // ── Admin namespace ───────────────────────────────────────────────────

    admin: {
      dashboard(hours = 24)   { return _call('getJobDashboard', { hours }); },
      queueDepth()            { return _call('getQueueDepth', {}); },
      workerStats()           { return _call('getWorkerStats', {}); },
      inspect(jobId)          { return _call('inspectJob', { jobId }); },
      retry(jobId)            { return _call('retryJob', { jobId }); },
      replayDLQ(dlqId)        { return _call('replayDLQJob', { dlqId }); },
      pauseQueue(priority)    { return _call('pauseQueue', { priority }); },
      resumeQueue(priority)   { return _call('resumeQueue', { priority }); },
      bulkCancel(opts)        { return _call('bulkCancelJobs', opts); }
    },

    JOB_TYPES,
    PRIORITIES
  };

  window.SokoniAsyncJobs = SokoniAsyncJobs;

})(window);
