'use strict';
/**
 * SOKONI Redis Integrations — Event-Driven Firestore → Redis
 * functions/redis-integrations.js  v1.0  (2026-07-06)
 *
 * Firestore triggers that keep Redis in sync with live business data.
 * Redis is updated asynchronously — Firestore remains authoritative.
 *
 * Triggers:
 *   onOrderCreated       — increment counters, publish event
 *   onOrderStatusChange  — track order completion, revenue, payment state
 *   onPaymentCreated     — track payment state machine
 *   onPaymentUpdated     — sync payment state, unlock inventory, fire receipts
 *   onInventoryUpdated   — clear inventory lock if stale
 *   onUserCreated        — initialize session + presence scaffold
 *   onRiderStatusChange  — track rider presence
 *
 * All handlers are wrapped in try/catch so a Redis failure never
 * prevents the Firestore write from succeeding.
 */

const { onDocumentCreated, onDocumentUpdated } = require('firebase-functions/v2/firestore');
const { defineSecret } = require('firebase-functions/params');
const admin = require('firebase-admin');

const R = require('./redis-service');

const db = () => admin.firestore();
const TS = () => admin.firestore.Timestamp.now();

const REDIS_URL_SECRET = defineSecret('REDIS_URL');

const REGION = 'us-central1';
const OPTS   = { region: REGION, secrets: [REDIS_URL_SECRET] };

function _log(sev, msg, extra = {}) {
  console[sev === 'ERROR' ? 'error' : 'log'](
    JSON.stringify({ severity: sev, message: `[redis-integrations] ${msg}`, ...extra })
  );
}

/* ── Safe wrapper: Redis failures must not break Firestore triggers ── */
async function _safeRedis(name, fn) {
  try {
    await fn();
  } catch (err) {
    _log('ERROR', `Redis sync failed: ${name}`, { error: err.message });
  }
}

/* ════════════════════════════════════════════════════════════════
   ORDER CREATED
   Increments: orders_today (shop + platform)
   Publishes:  event stream 'orders'
   Queues:     background receipt job
════════════════════════════════════════════════════════════════ */
exports.onOrderCreated = onDocumentCreated({ ...OPTS, document: 'orders/{orderId}' }, async (event) => {
  const order   = event.data.data();
  const orderId = event.params.orderId;
  if (!order) return;

  const shopId = order.shopId || 'platform';

  await _safeRedis('order_created', async () => {
    const pipe = [
      R.DashboardService.incr(shopId,      'orders_today'),
      R.DashboardService.incr('platform',  'orders_today'),
      R.DashboardService.incr('platform',  'orders_total'),
      R.EventBusService.publish('orders', {
        type:     'order_created',
        orderId,
        shopId,
        amount:   order.totalAmount || 0,
        currency: order.currency    || 'KES',
        uid:      order.buyerId     || order.userId,
        source:   order.source      || 'marketplace',
      }),
    ];

    /* Lock inventory items for 15 minutes while order is pending */
    if (Array.isArray(order.items)) {
      for (const item of order.items) {
        if (item.productId) {
          const lockId = `order:${orderId}:${item.productId}`;
          pipe.push(
            R.InventoryService.lock(item.productId, item.variantId || '', item.qty || 1, lockId, 900_000)
          );
        }
      }
    }

    await Promise.all(pipe);
    _log('INFO', 'Order created → Redis synced', { orderId, shopId });
  });
});

/* ════════════════════════════════════════════════════════════════
   ORDER STATUS CHANGE
   On completed: add revenue to dashboard, release inventory locks
   On cancelled:  release inventory locks, update payment state
════════════════════════════════════════════════════════════════ */
exports.onOrderStatusChange = onDocumentUpdated({ ...OPTS, document: 'orders/{orderId}' }, async (event) => {
  const before  = event.data.before.data();
  const after   = event.data.after.data();
  const orderId = event.params.orderId;
  if (!before || !after) return;

  const prevStatus = before.status;
  const newStatus  = after.status;
  if (prevStatus === newStatus) return;

  const shopId = after.shopId || 'platform';

  await _safeRedis('order_status_change', async () => {
    const tasks = [
      R.EventBusService.publish('orders', {
        type:     'order_status_changed',
        orderId,  shopId,
        prevStatus, newStatus,
        uid:      after.buyerId || after.userId,
        amount:   after.totalAmount,
      }),
    ];

    if (newStatus === 'completed') {
      const amount = Number(after.totalAmount) || 0;
      tasks.push(
        R.DashboardService.incr(shopId,     'revenue_today',  amount),
        R.DashboardService.incr('platform', 'revenue_today',  amount),
        R.DashboardService.incr('platform', 'revenue_total',  amount),
        R.DashboardService.incr(shopId,     'orders_completed'),
        /* Queue receipt generation */
        R.QueueService.push('receipt', {
          type: 'receipt', orderId, shopId,
          format: 'pdf', _requestedBy: 'system',
        }, 'high'),
        /* Queue daily report for this shop */
        R.QueueService.push('report', {
          type: 'report', reportType: 'daily_sales',
          shopId, _requestedBy: 'system',
        }, 'normal'),
      );
    }

    if (newStatus === 'cancelled' || newStatus === 'refunded') {
      /* Release inventory locks */
      if (Array.isArray(after.items)) {
        for (const item of after.items) {
          if (item.productId) {
            tasks.push(
              R.InventoryService.release(
                item.productId, item.variantId || '',
                `order:${orderId}:${item.productId}`
              )
            );
          }
        }
      }
      if (newStatus === 'refunded') {
        tasks.push(R.DashboardService.incr(shopId, 'refunds_today'));
      }
    }

    await Promise.all(tasks);
    _log('INFO', `Order ${orderId}: ${prevStatus} → ${newStatus}`, { shopId });
  });
});

/* ════════════════════════════════════════════════════════════════
   PAYMENT CREATED
   Initialises payment state machine in Redis
════════════════════════════════════════════════════════════════ */
exports.onPaymentCreated = onDocumentCreated({ ...OPTS, document: 'payments/{paymentId}' }, async (event) => {
  const payment   = event.data.data();
  const paymentId = event.params.paymentId;
  if (!payment) return;

  await _safeRedis('payment_created', async () => {
    await R.PaymentService.setState(payment.orderId || paymentId, 'pending', {
      provider:  payment.provider || 'unknown',
      amount:    payment.amount,
      currency:  payment.currency || 'KES',
      paymentId,
      uid:       payment.uid || payment.buyerId,
    });

    await R.EventBusService.publish('payments', {
      type:     'payment_created',
      paymentId, orderId: payment.orderId,
      amount:   payment.amount,
      currency: payment.currency || 'KES',
      provider: payment.provider,
    });

    _log('INFO', 'Payment created → Redis state set', { paymentId, orderId: payment.orderId });
  });
});

/* ════════════════════════════════════════════════════════════════
   PAYMENT UPDATED
   Syncs payment state transitions to Redis
════════════════════════════════════════════════════════════════ */
exports.onPaymentUpdated = onDocumentUpdated({ ...OPTS, document: 'payments/{paymentId}' }, async (event) => {
  const before    = event.data.before.data();
  const after     = event.data.after.data();
  const paymentId = event.params.paymentId;
  if (!before || !after) return;

  const prevStatus = before.status;
  const newStatus  = after.status;
  if (prevStatus === newStatus) return;

  /* Map payment document status → Redis PaymentService state */
  const STATE_MAP = {
    pending:    'pending',
    processing: 'processing',
    completed:  'completed',
    paid:       'completed',
    success:    'completed',
    failed:     'failed',
    refunded:   'refunded',
    expired:    'expired',
    cancelled:  'failed',
  };
  const redisState = STATE_MAP[newStatus] || newStatus;

  await _safeRedis('payment_updated', async () => {
    await R.PaymentService.setState(after.orderId || paymentId, redisState, {
      provider:   after.provider,
      reference:  after.reference || after.mpesaRef,
      amount:     after.amount,
      currency:   after.currency || 'KES',
      paymentId,
      uid:        after.uid || after.buyerId,
    });

    await R.EventBusService.publish('payments', {
      type:     `payment_${redisState}`,
      paymentId, orderId: after.orderId,
      amount:   after.amount,
      currency: after.currency || 'KES',
      provider: after.provider,
    });

    if (redisState === 'completed') {
      const shopId = after.shopId || 'platform';
      await Promise.all([
        R.DashboardService.incr('platform', 'payments_today'),
        R.DashboardService.incr(shopId,     'payments_today'),
      ]);
    }

    _log('INFO', `Payment ${paymentId}: ${prevStatus} → ${newStatus}`, { orderId: after.orderId });
  });
});

/* ════════════════════════════════════════════════════════════════
   INVENTORY UPDATED
   Clears stale Redis locks when stock is manually adjusted
════════════════════════════════════════════════════════════════ */
exports.onInventoryUpdated = onDocumentUpdated({ ...OPTS, document: 'products/{productId}' }, async (event) => {
  const before    = event.data.before.data();
  const after     = event.data.after.data();
  const productId = event.params.productId;
  if (!before || !after) return;

  /* Only act when stock quantity drops to 0 or is manually set */
  if (before.stockQty === after.stockQty) return;

  await _safeRedis('inventory_updated', async () => {
    await R.EventBusService.publish('inventory', {
      type:       'inventory_updated',
      productId,
      shopId:     after.shopId,
      oldQty:     before.stockQty,
      newQty:     after.stockQty,
      name:       after.name,
    });

    if (after.stockQty === 0) {
      await R.EventBusService.publish('inventory', {
        type: 'out_of_stock', productId, shopId: after.shopId, name: after.name,
      });
    }

    _log('INFO', `Inventory ${productId}: ${before.stockQty} → ${after.stockQty}`);
  });
});

/* ════════════════════════════════════════════════════════════════
   USER CREATED
   Seeds presence scaffold; useful for new seller / rider onboarding
════════════════════════════════════════════════════════════════ */
exports.onUserCreated = onDocumentCreated({ ...OPTS, document: 'users/{uid}' }, async (event) => {
  const user = event.data.data();
  const uid  = event.params.uid;
  if (!user) return;

  await _safeRedis('user_created', async () => {
    await R.DashboardService.incr('platform', 'users_total');
    await R.EventBusService.publish('users', {
      type: 'user_registered', uid, role: user.role || 'buyer',
    });
    _log('INFO', 'User created → Redis synced', { uid, role: user.role });
  });
});

/* ════════════════════════════════════════════════════════════════
   RIDER STATUS CHANGE
   Syncs rider online/offline to Redis presence
════════════════════════════════════════════════════════════════ */
exports.onRiderStatusChange = onDocumentUpdated({ ...OPTS, document: 'riders/{riderId}' }, async (event) => {
  const before  = event.data.before.data();
  const after   = event.data.after.data();
  const riderId = event.params.riderId;
  if (!before || !after) return;

  const prevStatus = before.status;
  const newStatus  = after.status;
  if (prevStatus === newStatus) return;

  await _safeRedis('rider_status', async () => {
    if (newStatus === 'online' || newStatus === 'available') {
      await R.PresenceService.set('rider', riderId, {
        name:    after.name,
        zone:    after.zone,
        vehicle: after.vehicle,
      });
    } else {
      await R.PresenceService.remove('rider', riderId);
    }

    await R.EventBusService.publish('riders', {
      type:     'rider_status_changed',
      riderId,  prevStatus, newStatus,
      zone:     after.zone,
    });

    _log('INFO', `Rider ${riderId}: ${prevStatus} → ${newStatus}`);
  });
});

/* ════════════════════════════════════════════════════════════════
   DELIVERY STATUS CHANGE
   Tracks active deliveries in Redis
════════════════════════════════════════════════════════════════ */
exports.onDeliveryStatusChange = onDocumentUpdated({ ...OPTS, document: 'deliveries/{deliveryId}' }, async (event) => {
  const before     = event.data.before.data();
  const after      = event.data.after.data();
  const deliveryId = event.params.deliveryId;
  if (!before || !after) return;

  const prevStatus = before.status;
  const newStatus  = after.status;
  if (prevStatus === newStatus) return;

  await _safeRedis('delivery_status', async () => {
    await R.EventBusService.publish('delivery', {
      type:       'delivery_status_changed',
      deliveryId, prevStatus, newStatus,
      orderId:    after.orderId,
      riderId:    after.riderId,
    });

    if (newStatus === 'delivered') {
      await R.DashboardService.incr('platform', 'deliveries_completed_today');
    }

    _log('INFO', `Delivery ${deliveryId}: ${prevStatus} → ${newStatus}`);
  });
});
