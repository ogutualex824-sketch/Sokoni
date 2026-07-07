'use strict';

const { onCall }     = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { getFirestore, FieldValue, Timestamp } = require('firebase-admin/firestore');
const { initializeApp, getApps } = require('firebase-admin/app');

if (!getApps().length) initializeApp();
const db = getFirestore();

const REGION = 'us-central1';

// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------

function _admin(req) {
  if (!req.auth || (!req.auth.token.admin && !req.auth.token.superAdmin)) {
    throw new Error('PERMISSION_DENIED: admin or superAdmin token required');
  }
}

function _auth(req) {
  if (!req.auth) {
    throw new Error('UNAUTHENTICATED: sign-in required');
  }
}

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

/** Returns a Date representing midnight (UTC) today. */
function _todayStart() {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

/** Returns a Date representing the start of the current hour (UTC). */
function _hourStart() {
  const d = new Date();
  d.setUTCMinutes(0, 0, 0);
  return d;
}

/** Count documents in a collection matching a query builder function. */
async function _count(queryFn) {
  const snap = await queryFn().count().get();
  return snap.data().count;
}

// ---------------------------------------------------------------------------
// 1. opsGetMasterDashboard
// ---------------------------------------------------------------------------

exports.opsGetMasterDashboard = onCall(
  { region: REGION, timeoutSeconds: 60 },
  async (req) => {
    _admin(req);

    const now        = new Date();
    const todayStart = _todayStart();
    const hourStart  = _hourStart();

    // ------------------------------------------------------------------
    // All count queries run in parallel via Promise.all
    // ------------------------------------------------------------------
    const [
      ordersToday,
      ordersThisHour,
      ordersCompleted,
      ordersFailed,
      ordersRefunded,
      disputesOpen,
      activeBuyers,
      activeSellersCount,
      paymentsPending,
      paymentsFailedToday,
      payoutQueue,
      asyncQueued,
      asyncRunning,
      asyncFailed,
      asyncDLQ,
      asyncRetrying,
      emailQueuePending,
      smsQueuePending,
      pushQueuePending,
      posActiveSessions,
      activeAlertsCount,
      revenueSnap,
      redisHealthDoc,
      firestorePingDoc,
    ] = await Promise.all([
      // Marketplace — orders
      _count(() => db.collection('orders')
        .where('createdAt', '>=', Timestamp.fromDate(todayStart))),

      _count(() => db.collection('orders')
        .where('createdAt', '>=', Timestamp.fromDate(hourStart))),

      _count(() => db.collection('orders')
        .where('status', '==', 'completed')
        .where('createdAt', '>=', Timestamp.fromDate(todayStart))),

      _count(() => db.collection('orders')
        .where('status', '==', 'failed')
        .where('createdAt', '>=', Timestamp.fromDate(todayStart))),

      _count(() => db.collection('orders')
        .where('status', '==', 'refunded')
        .where('createdAt', '>=', Timestamp.fromDate(todayStart))),

      // Disputes
      _count(() => db.collection('disputes')
        .where('status', 'in', ['open', 'escalated'])),

      // Active buyers — lastSeen in last 24 h
      _count(() => db.collection('users')
        .where('lastSeen', '>=', Timestamp.fromDate(new Date(now.getTime() - 86_400_000)))),

      // Active sellers
      _count(() => db.collection('sellers')
        .where('status', '==', 'active')),

      // Payments
      _count(() => db.collection('payments')
        .where('status', '==', 'pending')),

      _count(() => db.collection('payments')
        .where('status', '==', 'failed')
        .where('createdAt', '>=', Timestamp.fromDate(todayStart))),

      _count(() => db.collection('payments')
        .where('status', '==', 'payout_queued')),

      // Async jobs
      _count(() => db.collection('asyncJobs').where('status', '==', 'queued')),
      _count(() => db.collection('asyncJobs').where('status', '==', 'running')),
      _count(() => db.collection('asyncJobs').where('status', '==', 'failed')),
      _count(() => db.collection('asyncDeadLetter')),
      _count(() => db.collection('asyncJobs').where('status', '==', 'retrying')),

      // Notification queues
      _count(() => db.collection('emailQueue').where('status', '==', 'pending')),
      _count(() => db.collection('smsQueue').where('status', '==', 'pending')),
      _count(() => db.collection('pushQueue').where('status', '==', 'pending')),

      // POS
      _count(() => db.collection('posSessions').where('status', '==', 'active')),

      // Ops alerts
      _count(() => db.collection('opsAlerts').where('status', '==', 'active')),

      // Revenue: sum 'total' from completed orders today (limit 500)
      db.collection('orders')
        .where('status', '==', 'completed')
        .where('createdAt', '>=', Timestamp.fromDate(todayStart))
        .select('total')
        .limit(500)
        .get(),

      // Redis health doc
      db.collection('systemHealth').doc('redisHealth').get(),

      // Firestore ping
      db.collection('systemConfig').doc('health').get(),
    ]);

    // Revenue sum
    let revenueToday = 0;
    revenueSnap.forEach((doc) => {
      revenueToday += Number(doc.data().total) || 0;
    });

    // Checkout success rate (completed / all today)
    const checkoutSuccessRate = ordersToday > 0
      ? Math.round((ordersCompleted / ordersToday) * 10000) / 100
      : 0;

    // Firestore health
    const firestoreOk = firestorePingDoc !== undefined;

    // Redis status
    const redisStatus = redisHealthDoc.exists
      ? (redisHealthDoc.data().status || 'unknown')
      : 'unknown';

    return {
      ts: Timestamp.now(),
      marketplace: {
        ordersToday,
        ordersThisHour,
        revenueToday,
        checkoutSuccessRate,
        refunds: ordersRefunded,
        disputes: disputesOpen,
        activeBuyers,
        activeSellers: activeSellersCount,
      },
      payments: {
        pending: paymentsPending,
        failedToday: paymentsFailedToday,
        payoutQueueSize: payoutQueue,
      },
      asyncJobs: {
        queued: asyncQueued,
        running: asyncRunning,
        failed: asyncFailed,
        dlq: asyncDLQ,
        retrying: asyncRetrying,
      },
      notifications: {
        emailQueuePending,
        smsQueuePending,
        pushQueuePending,
      },
      pos: {
        activeSessions: posActiveSessions,
      },
      alerts: {
        active: activeAlertsCount,
      },
      infrastructure: {
        firestoreOk,
        redisStatus,
      },
    };
  }
);

// ---------------------------------------------------------------------------
// 2. opsGetAlerts
// ---------------------------------------------------------------------------

exports.opsGetAlerts = onCall(
  { region: REGION, timeoutSeconds: 30 },
  async (req) => {
    _admin(req);

    const { status = 'active', severity, limit = 50 } = req.data || {};

    let query = db.collection('opsAlerts')
      .where('status', '==', status)
      .orderBy('createdAt', 'desc')
      .limit(Math.min(Number(limit) || 50, 200));

    if (severity) {
      query = db.collection('opsAlerts')
        .where('status', '==', status)
        .where('severity', '==', severity)
        .orderBy('createdAt', 'desc')
        .limit(Math.min(Number(limit) || 50, 200));
    }

    const snap = await query.get();
    const alerts = [];
    snap.forEach((doc) => alerts.push({ alertId: doc.id, ...doc.data() }));
    return { alerts };
  }
);

// ---------------------------------------------------------------------------
// 3. opsAcknowledgeAlert
// ---------------------------------------------------------------------------

exports.opsAcknowledgeAlert = onCall(
  { region: REGION, timeoutSeconds: 30 },
  async (req) => {
    _admin(req);

    const { alertId, note } = req.data || {};
    if (!alertId) throw new Error('INVALID_ARGUMENT: alertId is required');

    await db.collection('opsAlerts').doc(alertId).update({
      status:          'acknowledged',
      acknowledgedBy:  req.auth.uid,
      acknowledgedAt:  Timestamp.now(),
      note:            note || '',
    });

    return { success: true, alertId };
  }
);

// ---------------------------------------------------------------------------
// 4. opsCreateAlert
// ---------------------------------------------------------------------------

const VALID_SEVERITIES = new Set(['critical', 'high', 'medium', 'low', 'info']);

exports.opsCreateAlert = onCall(
  { region: REGION, timeoutSeconds: 30 },
  async (req) => {
    _admin(req);

    const { title, message, severity, subsystem, metadata } = req.data || {};

    if (!title || !message)  throw new Error('INVALID_ARGUMENT: title and message are required');
    if (!VALID_SEVERITIES.has(severity)) {
      throw new Error('INVALID_ARGUMENT: severity must be critical|high|medium|low|info');
    }

    const ref = db.collection('opsAlerts').doc();
    const alertId = ref.id;

    await ref.set({
      alertId,
      title,
      message,
      severity,
      subsystem:  subsystem  || 'platform',
      metadata:   metadata   || {},
      status:     'active',
      createdAt:  Timestamp.now(),
      createdBy:  req.auth.uid,
    });

    return { success: true, alertId };
  }
);

// ---------------------------------------------------------------------------
// 5. opsGetPostLaunchMetrics
// ---------------------------------------------------------------------------

const MS = {
  hour:  3_600_000,
  day:   86_400_000,
  week:  604_800_000,
  month: 2_592_000_000, // 30 days
};

exports.opsGetPostLaunchMetrics = onCall(
  { region: REGION, timeoutSeconds: 60 },
  async (req) => {
    _admin(req);

    const period = (req.data && req.data.period) || 'day';
    if (!MS[period]) {
      throw new Error('INVALID_ARGUMENT: period must be hour|day|week|month');
    }

    const since = Timestamp.fromDate(new Date(Date.now() - MS[period]));

    const [
      ordersTotal,
      revenueSnap,
      newUsers,
      newSellers,
      failedPayments,
      refunds,
      disputes,
      asyncJobsTotal,
      asyncJobsFailed,
      alertsTriggered,
    ] = await Promise.all([
      _count(() => db.collection('orders')
        .where('createdAt', '>=', since)),

      db.collection('orders')
        .where('status', '==', 'completed')
        .where('createdAt', '>=', since)
        .select('total')
        .limit(1000)
        .get(),

      _count(() => db.collection('users')
        .where('createdAt', '>=', since)),

      _count(() => db.collection('sellers')
        .where('createdAt', '>=', since)),

      _count(() => db.collection('payments')
        .where('status', '==', 'failed')
        .where('createdAt', '>=', since)),

      _count(() => db.collection('orders')
        .where('status', '==', 'refunded')
        .where('createdAt', '>=', since)),

      _count(() => db.collection('disputes')
        .where('createdAt', '>=', since)),

      _count(() => db.collection('asyncJobs')
        .where('createdAt', '>=', since)),

      _count(() => db.collection('asyncJobs')
        .where('status', '==', 'failed')
        .where('createdAt', '>=', since)),

      _count(() => db.collection('opsAlerts')
        .where('createdAt', '>=', since)),
    ]);

    let revenueTotal = 0;
    revenueSnap.forEach((doc) => {
      revenueTotal += Number(doc.data().total) || 0;
    });

    return {
      period,
      since: since.toDate().toISOString(),
      ts: Timestamp.now(),
      ordersTotal,
      revenueTotal,
      newUsers,
      newSellers,
      failedPayments,
      refunds,
      disputes,
      asyncJobsTotal,
      asyncJobsFailed,
      alertsTriggered,
    };
  }
);

// ---------------------------------------------------------------------------
// 6. opsScheduledHealthCheck — every 5 minutes
// ---------------------------------------------------------------------------

exports.opsScheduledHealthCheck = onSchedule(
  { schedule: 'every 5 minutes', region: REGION, timeoutSeconds: 120 },
  async () => {
    const now = Timestamp.now();

    // --- Firestore ping ---
    let firestoreOk = false;
    try {
      await db.collection('systemConfig').doc('health').get();
      firestoreOk = true;
    } catch (_) {
      firestoreOk = false;
    }

    // --- Async queue depth ---
    let asyncQueueDepth = 0;
    try {
      const snap = await db.collection('asyncJobs')
        .where('status', '==', 'queued')
        .count()
        .get();
      asyncQueueDepth = snap.data().count;
    } catch (_) {
      asyncQueueDepth = -1;
    }

    // Auto-alert if queue is overloaded
    if (asyncQueueDepth > 100) {
      try {
        await db.collection('opsAlerts').add({
          title:     'Async Job Queue Overloaded',
          message:   `asyncJobs queued count: ${asyncQueueDepth} (threshold: 100)`,
          severity:  'high',
          subsystem: 'asyncJobs',
          metadata:  { asyncQueueDepth },
          status:    'active',
          createdAt: now,
          createdBy: 'system',
        });
      } catch (_) {
        // non-fatal — health snapshot will still be written
      }
    }

    // --- Unacknowledged critical alerts older than 30 min ---
    let criticalAlertsUnacked = 0;
    try {
      const thirtyMinAgo = Timestamp.fromDate(new Date(Date.now() - 1_800_000));
      const critSnap = await db.collection('opsAlerts')
        .where('status', '==', 'active')
        .where('severity', '==', 'critical')
        .where('createdAt', '<=', thirtyMinAgo)
        .count()
        .get();
      criticalAlertsUnacked = critSnap.data().count;
    } catch (_) {
      criticalAlertsUnacked = -1;
    }

    // --- Overall status ---
    let overallStatus = 'healthy';
    if (!firestoreOk || criticalAlertsUnacked > 0) {
      overallStatus = 'critical';
    } else if (asyncQueueDepth > 100) {
      overallStatus = 'degraded';
    }

    // --- Write health snapshot ---
    await db.collection('systemHealth').doc('latest').set({
      ts: now,
      firestoreOk,
      asyncQueueDepth,
      criticalAlertsUnacked,
      overallStatus,
    });

    console.info(
      `[opsScheduledHealthCheck] status=${overallStatus} ` +
      `firestoreOk=${firestoreOk} asyncQueue=${asyncQueueDepth} ` +
      `criticalUnacked=${criticalAlertsUnacked}`
    );
  }
);
