'use strict';
/**
 * SOKONI SmartPOS — Self-Healing Engine v1.0
 *
 * Runs every 5 minutes via Cloud Scheduler. Detects and auto-repairs:
 *  1. Stuck payment sessions
 *  2. Failed sync queue items
 *  3. Inventory integrity (negative quantities)
 *  4. Loyalty ledger drift
 *  5. Stale device heartbeats
 *  6. Unresolved critical alerts (escalation)
 *  7. Bootstrap cache staleness
 *
 * Manual trigger available via onCall for admin use.
 * Full run history written to `selfHealLog/{logId}`.
 */

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule }         = require('firebase-functions/v2/scheduler');
const admin                  = require('firebase-admin');

const db     = admin.firestore();
const F      = admin.firestore.FieldValue;
const REGION = 'us-central1';
const OPT    = { region: REGION, enforceAppCheck: true };

/* ── Structured logger ──────────────────────────────────────────────────────── */
function createLogger(runId) {
  const base = { service: 'self-heal', runId };
  return {
    info:  (msg, x = {}) => console.log(JSON.stringify({ severity: 'INFO',    message: msg, ...base, ...x })),
    warn:  (msg, x = {}) => console.warn(JSON.stringify({ severity: 'WARNING', message: msg, ...base, ...x })),
    error: (msg, x = {}) => console.error(JSON.stringify({ severity: 'ERROR',  message: msg, ...base, ...x })),
  };
}

/* ── Admin alert writer ─────────────────────────────────────────────────────── */
async function _writeAdminAlert({ severity, category, title, detail, meta = {} }) {
  await db.collection('adminAlerts').add({
    severity,
    category,
    title,
    detail,
    resolved: false,
    source:   'self_heal_engine',
    createdAt: F.serverTimestamp(),
    ...meta,
  });
}

/* ═══════════════════════════════════════════════════════════════════════════════
   CHECK 1 — Stuck Payment Sessions
   Finds sessions stuck in a non-terminal state for > 30 minutes and expires them.
═══════════════════════════════════════════════════════════════════════════════ */
async function checkStuckPayments(log) {
  const TERMINAL    = ['COMPLETED', 'FAILED', 'EXPIRED', 'VOIDED', 'ARCHIVED'];
  const cutoff      = new Date(Date.now() - 30 * 60 * 1000); // 30 min ago
  const result      = { check: 'stuck_payments', count: 0, fixed: 0, errors: 0 };

  try {
    /* Firestore doesn't support NOT IN on a non-equality field with range — use
       a compound approach: query on updatedAt < cutoff, then filter in-memory.   */
    const snap = await db.collection('paymentSessions')
      .where('updatedAt', '<', cutoff)
      .limit(100)
      .get();

    const stuck = snap.docs.filter(d => !TERMINAL.includes(d.data().status));
    result.count = stuck.length;

    await Promise.all(stuck.map(async docSnap => {
      try {
        const data = docSnap.data();
        /* Write a remoteCommand so the device/server can reconcile if still alive */
        await db.collection('paymentSessions').doc(docSnap.id).update({
          status:   'EXPIRED',
          expiredAt: F.serverTimestamp(),
          updatedAt: F.serverTimestamp(),
          _auditNote: 'auto-expired by self-heal engine (stuck > 30 min)',
          _previousStatus: data.status,
        });

        /* Also emit a remoteCommand for any listening POS device */
        if (data.deviceId) {
          await db.collection('posDevices').doc(data.deviceId)
            .collection('remoteCommands')
            .add({
              command:   'expire_payment_session',
              sessionId: docSnap.id,
              reason:    'session_stuck',
              issuedAt:  F.serverTimestamp(),
              executed:  false,
            });
        }

        result.fixed++;
      } catch (err) {
        result.errors++;
        log.error('Failed to expire stuck payment session', { sessionId: docSnap.id, err: err.message });
      }
    }));

  } catch (err) {
    log.error('checkStuckPayments failed', { err: err.message });
    result.error = err.message;
  }

  log.info('check:stuck_payments', result);
  return { ...result, status: result.errors > 0 ? 'partial' : 'ok' };
}

/* ═══════════════════════════════════════════════════════════════════════════════
   CHECK 2 — Failed Sync Queue Items
   Resets retryable items so the next sync pass picks them up again.
═══════════════════════════════════════════════════════════════════════════════ */
async function checkSyncQueue(log) {
  const cutoff = new Date(Date.now() - 60 * 60 * 1000); // 1 hour ago
  const result = { check: 'sync_queue', count: 0, retried: 0, errors: 0 };

  try {
    const snap = await db.collection('syncQueue')
      .where('status', '==', 'failed')
      .where('updatedAt', '<', cutoff)
      .limit(200)
      .get();

    /* Filter: only items that haven't exhausted retries */
    const retryable = snap.docs.filter(d => (d.data().retryCount || 0) < 5);
    result.count = retryable.length;

    const now = new Date();
    await Promise.all(retryable.map(async docSnap => {
      try {
        const data = docSnap.data();
        const nextRetryCount = (data.retryCount || 0) + 1;
        /* Exponential back-off: 2^retryCount minutes */
        const backoffMs = Math.pow(2, nextRetryCount) * 60 * 1000;
        const nextAttemptAt = new Date(now.getTime() + backoffMs);

        await db.collection('syncQueue').doc(docSnap.id).update({
          status:         'pending',
          retryCount:     nextRetryCount,
          nextAttemptAt:  nextAttemptAt,
          updatedAt:      F.serverTimestamp(),
          _retryReason:  'self_heal_engine_reset',
        });
        result.retried++;
      } catch (err) {
        result.errors++;
        log.error('Failed to reset sync queue item', { itemId: docSnap.id, err: err.message });
      }
    }));

  } catch (err) {
    log.error('checkSyncQueue failed', { err: err.message });
    result.error = err.message;
  }

  log.info('check:sync_queue', result);
  return { ...result, status: result.count > 0 ? 'issues_found' : 'ok' };
}

/* ═══════════════════════════════════════════════════════════════════════════════
   CHECK 3 — Inventory Integrity
   Flags any posProducts records with negative quantities. Does NOT auto-fix —
   flags for human review to prevent masking data entry errors.
═══════════════════════════════════════════════════════════════════════════════ */
async function checkInventoryIntegrity(log) {
  const result = { check: 'inventory_integrity', negativeQtyCount: 0, errors: 0 };

  try {
    const snap = await db.collection('posProducts')
      .where('qty', '<', 0)
      .limit(100)
      .get();

    result.negativeQtyCount = snap.size;

    if (snap.size > 0) {
      /* Write a single grouped alert rather than flooding adminAlerts */
      const affected = snap.docs.slice(0, 20).map(d => ({
        productId:  d.id,
        name:       d.data().name || 'Unknown',
        qty:        d.data().qty,
        merchantId: d.data().merchantId || null,
        branchId:   d.data().branchId || null,
      }));

      await _writeAdminAlert({
        severity: 'warning',
        category: 'inventory',
        title:    `Negative inventory detected: ${snap.size} product(s)`,
        detail:   'One or more POS products have negative stock quantities. Manual review required.',
        meta: {
          affectedCount: snap.size,
          affectedSample: affected,
          requiresHumanReview: true,
        },
      });
    }

  } catch (err) {
    log.error('checkInventoryIntegrity failed', { err: err.message });
    result.error = err.message;
  }

  log.info('check:inventory_integrity', result);
  return { ...result, status: result.negativeQtyCount > 0 ? 'issues_found' : 'ok' };
}

/* ═══════════════════════════════════════════════════════════════════════════════
   CHECK 4 — Loyalty Ledger Drift
   Samples up to 20 loyalty accounts and verifies their `points` field matches
   the sum of their `loyaltyTransactions` sub-collection. Drift > 10 points
   triggers an admin alert for manual reconciliation.
═══════════════════════════════════════════════════════════════════════════════ */
async function checkLoyaltyLedgerDrift(log) {
  const SAMPLE_SIZE  = 20;
  const DRIFT_THRESH = 10;
  const result       = { check: 'loyalty_drift', sampled: 0, drifted: 0, errors: 0 };

  try {
    /* Firestore has no RANDOM() — use a timestamp-based scatter sample */
    const snap = await db.collection('loyaltyAccounts')
      .orderBy('updatedAt', 'desc')
      .limit(SAMPLE_SIZE)
      .get();

    result.sampled = snap.size;

    await Promise.all(snap.docs.map(async docSnap => {
      try {
        const account      = docSnap.data();
        const storedPoints = Number(account.points) || 0;

        /* Sum loyaltyTransactions sub-collection */
        const txSnap = await db.collection('loyaltyAccounts')
          .doc(docSnap.id)
          .collection('loyaltyTransactions')
          .get();

        const computedPoints = txSnap.docs.reduce((sum, tx) => {
          return sum + (Number(tx.data().points) || 0);
        }, 0);

        const drift = Math.abs(storedPoints - computedPoints);
        if (drift > DRIFT_THRESH) {
          result.drifted++;
          await _writeAdminAlert({
            severity: 'warning',
            category: 'loyalty',
            title:    `Loyalty ledger drift detected for account ${docSnap.id}`,
            detail:   `Stored: ${storedPoints} pts | Computed from transactions: ${computedPoints} pts | Drift: ${drift} pts`,
            meta: {
              accountId:       docSnap.id,
              customerId:      account.customerId || null,
              storedPoints,
              computedPoints,
              drift,
              requiresHumanReview: true,
            },
          });
        }
      } catch (err) {
        result.errors++;
        log.error('Failed to check loyalty account', { accountId: docSnap.id, err: err.message });
      }
    }));

  } catch (err) {
    log.error('checkLoyaltyLedgerDrift failed', { err: err.message });
    result.error = err.message;
  }

  log.info('check:loyalty_drift', result);
  return { ...result, status: result.drifted > 0 ? 'issues_found' : 'ok' };
}

/* ═══════════════════════════════════════════════════════════════════════════════
   CHECK 5 — Stale Device Heartbeats
   Marks active POS devices as connectivity = 'offline' when they haven't sent
   a heartbeat in > 2 hours. Does NOT change device status (that's device-manager).
═══════════════════════════════════════════════════════════════════════════════ */
async function checkStaleDeviceHeartbeats(log) {
  const cutoff = new Date(Date.now() - 2 * 60 * 60 * 1000); // 2 hours ago
  const result = { check: 'stale_devices', count: 0, updated: 0, errors: 0 };

  try {
    const snap = await db.collection('posDevices')
      .where('status', '==', 'active')
      .where('lastSeenAt', '<', cutoff)
      .limit(100)
      .get();

    /* Further filter: only those not already marked offline */
    const stale = snap.docs.filter(d => d.data().connectivity !== 'offline');
    result.count = stale.length;

    await Promise.all(stale.map(async docSnap => {
      try {
        await db.collection('posDevices').doc(docSnap.id).update({
          connectivity:            'offline',
          connectivityUpdatedAt:   F.serverTimestamp(),
          _connectivityReason:    'no_heartbeat_2h',
        });
        result.updated++;
      } catch (err) {
        result.errors++;
        log.error('Failed to mark device offline', { deviceId: docSnap.id, err: err.message });
      }
    }));

  } catch (err) {
    log.error('checkStaleDeviceHeartbeats failed', { err: err.message });
    result.error = err.message;
  }

  log.info('check:stale_devices', result);
  return { ...result, status: result.count > 0 ? 'issues_found' : 'ok' };
}

/* ═══════════════════════════════════════════════════════════════════════════════
   CHECK 6 — Unresolved Critical Alerts
   Escalates critical adminAlerts that have been open for > 24 hours by writing
   a super-admin escalation alert. Prevents silent failures from going unnoticed.
═══════════════════════════════════════════════════════════════════════════════ */
async function checkUnresolvedCriticalAlerts(log) {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000); // 24 hours ago
  const result = { check: 'unresolved_alerts', count: 0, escalated: 0, errors: 0 };

  try {
    const snap = await db.collection('adminAlerts')
      .where('severity', '==', 'critical')
      .where('resolved', '==', false)
      .where('createdAt', '<', cutoff)
      .limit(50)
      .get();

    /* Skip alerts that were themselves generated by escalation to avoid loops */
    const eligible = snap.docs.filter(d => d.data().source !== 'self_heal_escalation');
    result.count = eligible.length;

    await Promise.all(eligible.map(async docSnap => {
      try {
        const original = docSnap.data();
        await _writeAdminAlert({
          severity: 'critical',
          category: 'escalation',
          title:    `ESCALATION: Unresolved critical alert for > 24h — "${original.title}"`,
          detail:   `Alert ${docSnap.id} has been unresolved for over 24 hours. Immediate super-admin attention required.`,
          meta: {
            originalAlertId:  docSnap.id,
            originalCategory: original.category,
            originalTitle:    original.title,
            originalCreatedAt: original.createdAt,
            escalatedTo:      'super_admin',
            source:           'self_heal_escalation',
          },
        });
        result.escalated++;
      } catch (err) {
        result.errors++;
        log.error('Failed to escalate alert', { alertId: docSnap.id, err: err.message });
      }
    }));

  } catch (err) {
    log.error('checkUnresolvedCriticalAlerts failed', { err: err.message });
    result.error = err.message;
  }

  log.info('check:unresolved_alerts', result);
  return { ...result, status: result.count > 0 ? 'issues_found' : 'ok' };
}

/* ═══════════════════════════════════════════════════════════════════════════════
   CHECK 7 — Bootstrap Cache Staleness
   Removes bootstrapCache entries older than 10 minutes so devices always get
   fresh bootstrap data on their next request.
═══════════════════════════════════════════════════════════════════════════════ */
async function checkBootstrapCacheStaleness(log) {
  const cutoff = new Date(Date.now() - 10 * 60 * 1000); // 10 minutes ago
  const result = { check: 'bootstrap_cache', purged: 0, errors: 0 };

  try {
    const snap = await db.collection('bootstrapCache')
      .where('builtAt', '<', cutoff)
      .limit(100)
      .get();

    if (!snap.empty) {
      /* Batch delete — Firestore supports up to 500 ops per batch */
      const batch = db.batch();
      snap.docs.forEach(d => batch.delete(d.ref));
      await batch.commit();
      result.purged = snap.size;
    }

  } catch (err) {
    log.error('checkBootstrapCacheStaleness failed', { err: err.message });
    result.error = err.message;
  }

  log.info('check:bootstrap_cache', result);
  return { ...result, status: 'ok' };
}

/* ═══════════════════════════════════════════════════════════════════════════════
   Core: Run all checks, write log, return summary
═══════════════════════════════════════════════════════════════════════════════ */
async function _runAllChecks(runType = 'scheduled') {
  const runId = crypto.randomUUID();
  const log   = createLogger(runId);
  const startedAt = new Date();

  log.info('Self-heal run starting', { type: runType });

  /* ── Execute all checks in parallel ── */
  const [
    r1, r2, r3, r4, r5, r6, r7,
  ] = await Promise.all([
    checkStuckPayments(log),
    checkSyncQueue(log),
    checkInventoryIntegrity(log),
    checkLoyaltyLedgerDrift(log),
    checkStaleDeviceHeartbeats(log),
    checkUnresolvedCriticalAlerts(log),
    checkBootstrapCacheStaleness(log),
  ]);

  const results = [r1, r2, r3, r4, r5, r6, r7];

  /* ── Tally ── */
  const issuesFound = results.reduce((acc, r) => {
    if (r.status === 'issues_found' || r.status === 'partial') acc++;
    return acc;
  }, 0);

  const issuesFixed = (r1.fixed || 0) + (r2.retried || 0) + (r5.updated || 0) + (r7.purged || 0);

  /* ── Overall health ── */
  let overallStatus = 'healthy';
  if (r3.negativeQtyCount > 0 || r6.count > 5) {
    overallStatus = 'critical';
  } else if (issuesFound > 0) {
    overallStatus = 'degraded';
  }

  const completedAt = new Date();

  /* ── Persist run log ── */
  const logEntry = {
    runId,
    type:          runType,
    startedAt:     F.serverTimestamp(),
    completedAt:   completedAt.toISOString(),
    durationMs:    completedAt.getTime() - startedAt.getTime(),
    checksRun:     results.length,
    issuesFound,
    issuesFixed,
    results,
    overallStatus,
  };

  const logRef = await db.collection('selfHealLog').add(logEntry);

  /* ── Escalate if critical ── */
  if (overallStatus === 'critical') {
    await _writeAdminAlert({
      severity: 'critical',
      category: 'self_heal',
      title:    'Self-Heal Engine — CRITICAL platform state detected',
      detail:   `Run ${runId} found critical issues. See selfHealLog/${logRef.id} for full details.`,
      meta: {
        runId,
        selfHealLogId:  logRef.id,
        issuesFound,
        issuesFixed,
        overallStatus,
      },
    });
  }

  log.info('Self-heal run complete', { runId, overallStatus, issuesFound, issuesFixed });

  return {
    runId,
    selfHealLogId: logRef.id,
    overallStatus,
    checksRun:     results.length,
    issuesFound,
    issuesFixed,
    durationMs:    completedAt.getTime() - startedAt.getTime(),
    results,
  };
}

/* ═══════════════════════════════════════════════════════════════════════════════
   CF 1 — runScheduledSelfHeal
   Fires every 5 minutes via Cloud Scheduler.
═══════════════════════════════════════════════════════════════════════════════ */
const runScheduledSelfHeal = onSchedule(
  { schedule: '*/5 * * * *', region: REGION, timeoutSeconds: 240, memory: '512MiB' },
  async (_event) => {
    try {
      await _runAllChecks('scheduled');
    } catch (err) {
      console.error(JSON.stringify({
        severity: 'ERROR',
        service:  'self-heal',
        message:  'Scheduled self-heal run failed',
        err:      err.message,
        stack:    err.stack,
      }));
    }
  }
);

/* ═══════════════════════════════════════════════════════════════════════════════
   CF 2 — runManualSelfHeal
   Admin-triggered on-demand self-heal. Returns full results to caller.
═══════════════════════════════════════════════════════════════════════════════ */
const runManualSelfHeal = onCall(OPT, async (request) => {
  /* Admin-only guard */
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Authentication required.');
  }
  const claims = request.auth.token || {};
  if (!claims.admin && !claims.superAdmin && !claims.role?.includes('admin')) {
    throw new HttpsError('permission-denied', 'Admin role required to trigger self-heal.');
  }

  try {
    const summary = await _runAllChecks('manual');
    return { success: true, ...summary };
  } catch (err) {
    console.error(JSON.stringify({
      severity: 'ERROR',
      service:  'self-heal',
      message:  'Manual self-heal run failed',
      uid:      request.auth.uid,
      err:      err.message,
    }));
    throw new HttpsError('internal', 'Self-heal run failed: ' + err.message);
  }
});

/* ═══════════════════════════════════════════════════════════════════════════════
   CF 3 — getSelfHealHistory
   Returns paginated self-heal run history. Admin only.
═══════════════════════════════════════════════════════════════════════════════ */
const getSelfHealHistory = onCall(OPT, async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Authentication required.');
  }
  const claims = request.auth.token || {};
  if (!claims.admin && !claims.superAdmin && !claims.role?.includes('admin')) {
    throw new HttpsError('permission-denied', 'Admin role required.');
  }

  const data       = request.data || {};
  const merchantId = data.merchantId || null;
  const limit      = Math.min(Number(data.limit) || 20, 100);

  try {
    let q = db.collection('selfHealLog').orderBy('startedAt', 'desc').limit(limit);
    if (merchantId) {
      q = db.collection('selfHealLog')
        .where('merchantId', '==', merchantId)
        .orderBy('startedAt', 'desc')
        .limit(limit);
    }

    const snap = await q.get();
    const history = snap.docs.map(d => ({
      id: d.id,
      ...d.data(),
      /* Convert Timestamps to ISO strings for JSON serialization */
      startedAt: d.data().startedAt?.toDate?.()?.toISOString() || d.data().startedAt,
    }));

    return { success: true, history, total: history.length };
  } catch (err) {
    console.error(JSON.stringify({
      severity: 'ERROR',
      service:  'self-heal',
      message:  'getSelfHealHistory failed',
      uid:      request.auth.uid,
      err:      err.message,
    }));
    throw new HttpsError('internal', 'Failed to retrieve self-heal history: ' + err.message);
  }
});

/* ── Exports ─────────────────────────────────────────────────────────────────── */
module.exports = {
  runScheduledSelfHeal,
  runManualSelfHeal,
  getSelfHealHistory,
};
