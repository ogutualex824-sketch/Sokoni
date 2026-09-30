'use strict';
/**
 * SOKONI Operations Center — Cloud Functions
 * Enterprise observability, health monitoring, and self-healing.
 * Powers the real-time Ops Dashboard (ops-center.html).
 *
 * Monitors:
 *   Firestore, Cloud Functions, Payments, POS, Search,
 *   Notifications, Deliveries, Event Bus, Redis, API latency,
 *   Error rates, Queue depth, Device connections
 */

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule }         = require('firebase-functions/v2/scheduler');
const admin                  = require('firebase-admin');

const now  = () => admin.firestore.FieldValue.serverTimestamp();

/* ── Auth helper ── */
function _adminRequired(req) {
  const auth   = req.auth;
  const claims = auth ? (auth.token || {}) : {};
  const isAdmin = claims.admin || claims.role === 'admin' || claims.role === 'super_admin';
  if (!auth || !isAdmin) throw new HttpsError('permission-denied', 'Admin access required');
  return auth;
}

/* ── Snapshot a metric collection count ── */
async function _count(collection, filters = []) {
  try {
    let q = admin.firestore().collection(collection);
    filters.forEach(([field, op, val]) => { q = q.where(field, op, val); });
    const snap = await q.count().get();
    return snap.data().count;
  } catch (e) {
    return -1; /* -1 = query failed */
  }
}

/* ═══════════════════════════════════════════════════════════
   CF 1: getPlatformHealth — master health snapshot
   Returns live counts + statuses for all subsystems.
   Called every 30s by the Ops Dashboard.
═══════════════════════════════════════════════════════════ */
exports.getPlatformHealth = onCall({ enforceAppCheck: true }, async (request) => {
  _adminRequired(request);

  const threshold5m  = new Date(Date.now() - 5  * 60 * 1000);
  const threshold1h  = new Date(Date.now() - 60 * 60 * 1000);
  const threshold24h = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const [
    /* Orders */
    ordersTotal, ordersActive, ordersPending,
    /* Payments */
    paymentsToday, paymentsFailed, paymentsStuck,
    /* POS */
    posSessionsOpen, posDevicesConnected,
    /* Event Bus */
    eventsPending, eventsDead,
    /* Users */
    usersOnline,
    /* Deliveries */
    deliveriesActive,
    /* Inventory */
    stockAlerts,
  ] = await Promise.all([
    _count('orders'),
    _count('orders', [['status', 'in', ['pending','accepted','packed','ready']]]),
    _count('orders', [['status', '==', 'pending']]),
    _count('payments', [['createdAt', '>', threshold24h]]),
    _count('payments', [['status', '==', 'failed'], ['updatedAt', '>', threshold24h]]),
    _count('payments', [['status', 'in', ['pending','processing']], ['updatedAt', '<', threshold5m]]),
    _count('posSessions', [['status', '==', 'open']]),
    _count('posSessions', [['status', '==', 'open']]), /* device count = session sum */
    _count('platformEvents', [['status', '==', 'pending']]),
    _count('platformEvents', [['status', '==', 'dead_letter']]),
    /* lastActive, not lastSeen. session-manager.js:touchSession writes lastActive
       and nothing has ever written lastSeen, so this counter always read zero. */
    _count('userSessions', [['lastActive', '>', threshold5m]]),
    _count('deliveries', [['status', 'in', ['assigned','in_transit']]]),
    _count('products', [['stockAlert', '==', true]]),
  ]);

  /* Self-healing triggers */
  const alerts = [];
  if (paymentsStuck > 10) alerts.push({ level: 'critical', system: 'payments', message: `${paymentsStuck} payments stuck in pending >5m` });
  if (eventsDead > 50)    alerts.push({ level: 'warning',  system: 'event_bus', message: `${eventsDead} dead-letter events need review` });
  if (stockAlerts > 20)   alerts.push({ level: 'info',     system: 'inventory', message: `${stockAlerts} products low on stock` });

  return {
    timestamp: new Date().toISOString(),
    status: alerts.some(a => a.level === 'critical') ? 'degraded' : 'healthy',
    alerts,
    subsystems: {
      orders: {
        total:   ordersTotal,
        active:  ordersActive,
        pending: ordersPending,
        status:  'ok',
      },
      payments: {
        today:   paymentsToday,
        failed:  paymentsFailed,
        stuck:   paymentsStuck,
        status:  paymentsStuck > 10 ? 'degraded' : 'ok',
      },
      pos: {
        openSessions:     posSessionsOpen,
        connectedDevices: posDevicesConnected,
        status:           'ok',
      },
      eventBus: {
        pending:     eventsPending,
        dead_letter: eventsDead,
        status:      eventsDead > 50 ? 'degraded' : 'ok',
      },
      users: {
        online:    usersOnline,
        status:    'ok',
      },
      deliveries: {
        active:  deliveriesActive,
        status:  'ok',
      },
      inventory: {
        stockAlerts,
        status: stockAlerts > 20 ? 'warning' : 'ok',
      },
    },
  };
});

/* ═══════════════════════════════════════════════════════════
   CF 2: getMetricHistory — time-series data for charts
═══════════════════════════════════════════════════════════ */
exports.getMetricHistory = onCall({ enforceAppCheck: true }, async (request) => {
  _adminRequired(request);
  const { metric, hours = 24 } = request.data || {};

  const since = new Date(Date.now() - hours * 60 * 60 * 1000);
  const snaps = await admin.firestore()
    .collection('opsMetrics')
    .where('metric', '==', metric || 'platform_health')
    .where('recordedAt', '>', since)
    .orderBy('recordedAt', 'asc')
    .limit(288) /* max 288 points (5-min intervals for 24h) */
    .get();

  return {
    metric,
    points: snaps.docs.map(d => ({
      value:      d.data().value,
      recordedAt: d.data().recordedAt,
    })),
  };
});

/* ═══════════════════════════════════════════════════════════
   CF 3: triggerSelfHeal — manually trigger recovery action
═══════════════════════════════════════════════════════════ */
exports.triggerSelfHeal = onCall({ enforceAppCheck: true }, async (request) => {
  const auth = _adminRequired(request);
  const { action, targetId } = request.data || {};

  const ACTIONS = {
    retry_stuck_payments: async () => {
      const threshold5m = new Date(Date.now() - 5 * 60 * 1000);
      const stuck = await admin.firestore()
        .collection('payments')
        .where('status', 'in', ['pending', 'processing'])
        .where('updatedAt', '<', threshold5m)
        .where('attempts', '<', 3)
        .limit(50)
        .get();

      const batch = admin.firestore().batch();
      stuck.docs.forEach(d => {
        batch.update(d.ref, {
          status:    'pending',
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          history: admin.firestore.FieldValue.arrayUnion({
            status: 'retry', at: new Date().toISOString(), actor: 'self-heal',
          }),
        });
      });
      await batch.commit();
      return { affected: stuck.size, action: 'retry_stuck_payments' };
    },

    replay_dead_events: async () => {
      const dead = await admin.firestore()
        .collection('platformEvents')
        .where('status', '==', 'dead_letter')
        .limit(100)
        .get();

      const batch = admin.firestore().batch();
      dead.docs.forEach(d => {
        batch.update(d.ref, {
          status:              'pending',
          'delivery.attempts': 0,
          'delivery.failed':   [],
        });
      });
      await batch.commit();
      return { affected: dead.size, action: 'replay_dead_events' };
    },

    close_stale_pos_sessions: async () => {
      const threshold24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const stale = await admin.firestore()
        .collection('posSessions')
        .where('status', '==', 'open')
        .where('lastActivityAt', '<', threshold24h)
        .limit(50)
        .get();

      const batch = admin.firestore().batch();
      stale.docs.forEach(d => {
        batch.update(d.ref, {
          status:     'closed',
          closeReason: 'auto_cleanup',
          closedAt:    admin.firestore.FieldValue.serverTimestamp(),
        });
      });
      await batch.commit();
      return { affected: stale.size, action: 'close_stale_pos_sessions' };
    },
  };

  if (!action || !ACTIONS[action]) {
    throw new HttpsError('invalid-argument', `Unknown action: ${action}. Valid: ${Object.keys(ACTIONS).join(', ')}`);
  }

  const result = await ACTIONS[action]();

  /* Audit log */
  await admin.firestore().collection('selfHealLog').add({
    action,
    targetId:    targetId || null,
    result,
    triggeredBy: auth.uid,
    triggeredAt: now(),
  });

  return result;
});

/* ═══════════════════════════════════════════════════════════
   CF 4: getErrorLog — recent error summary across platform
═══════════════════════════════════════════════════════════ */
exports.getErrorLog = onCall({ enforceAppCheck: true }, async (request) => {
  _adminRequired(request);
  const { hours = 1, limit: lim = 100 } = request.data || {};

  const since = new Date(Date.now() - hours * 60 * 60 * 1000);
  const snaps = await admin.firestore()
    .collection('platformErrors')
    .where('recordedAt', '>', since)
    .orderBy('recordedAt', 'desc')
    .limit(Math.min(lim, 500))
    .get();

  return {
    errors: snaps.docs.map(d => d.data()),
    count:  snaps.size,
    since:  since.toISOString(),
  };
});

/* ═══════════════════════════════════════════════════════════
   Scheduled: snapshot platform metrics every 5 minutes
═══════════════════════════════════════════════════════════ */
exports.snapshotPlatformMetrics = onSchedule(
  { schedule: 'every 5 minutes', timeZone: 'Africa/Nairobi' },
  async () => {
    const db = admin.firestore();
    const threshold24h = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const [ordersActive, paymentsToday, paymentsFailed, posOpen, eventsDead] = await Promise.all([
      _count('orders', [['status', 'in', ['pending','accepted','packed','ready']]]),
      _count('payments', [['createdAt', '>', threshold24h]]),
      _count('payments', [['status', '==', 'failed'], ['updatedAt', '>', threshold24h]]),
      _count('posSessions', [['status', '==', 'open']]),
      _count('platformEvents', [['status', '==', 'dead_letter']]),
    ]);

    const metrics = [
      { metric: 'orders_active',      value: ordersActive },
      { metric: 'payments_today',     value: paymentsToday },
      { metric: 'payments_failed_24h',value: paymentsFailed },
      { metric: 'pos_open_sessions',  value: posOpen },
      { metric: 'events_dead_letter', value: eventsDead },
    ];

    const batch = db.batch();
    metrics.forEach(m => {
      const ref = db.collection('opsMetrics').doc();
      batch.set(ref, { ...m, recordedAt: now() });
    });
    await batch.commit();

    /* Self-healing: auto-replay if too many dead events */
    if (eventsDead > 100) {
      const dead = await db.collection('platformEvents')
        .where('status', '==', 'dead_letter')
        .where('delivery.attempts', '<', 3)
        .limit(50)
        .get();

      if (!dead.empty) {
        const healBatch = db.batch();
        dead.docs.forEach(d => {
          healBatch.update(d.ref, {
            status:              'pending',
            'delivery.attempts': 0,
          });
        });
        await healBatch.commit();
        console.log(`[OpsCenter] Self-healed: replayed ${dead.size} dead events`);
      }
    }

    /* Clean old metrics (keep 7 days) */
    const oldMetrics = await db.collection('opsMetrics')
      .where('recordedAt', '<', new Date(Date.now() - 7 * 24 * 60 * 60 * 1000))
      .limit(500)
      .get();

    if (!oldMetrics.empty) {
      const cleanBatch = db.batch();
      oldMetrics.docs.forEach(d => cleanBatch.delete(d.ref));
      await cleanBatch.commit();
    }

    console.log('[OpsCenter] Metrics snapshot complete');
  }
);
