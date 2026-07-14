'use strict';
/**
 * SOKONI Platform Event Bus — Cloud Functions
 * Central event-driven backbone for the entire platform.
 * Every module publishes events here; other modules subscribe.
 *
 * Event lifecycle:
 *   Publish → Stored in Firestore `platformEvents/{eventId}`
 *             → Fanned out to all registered subscribers (CF triggers)
 *             → Dead-letter if subscriber fails 3 times
 *
 * Event naming convention: domain.noun.verb (past tense)
 *   Examples: order.payment.completed, pos.cart.updated, delivery.rider.assigned
 */

const { onCall, onRequest, HttpsError } = require('firebase-functions/v2/https');
const { onDocumentCreated }             = require('firebase-functions/v2/firestore');
const { onSchedule }                    = require('firebase-functions/v2/scheduler');
const admin                             = require('firebase-admin');

const db  = admin.firestore;
const now = () => admin.firestore.FieldValue.serverTimestamp();

/* ── Event Schema ─────────────────────────────────────────────────────────
  {
    eventId:     string  (auto)
    type:        string  e.g. "order.payment.completed"
    domain:      string  e.g. "order" | "pos" | "delivery" | "inventory" ...
    noun:        string  e.g. "payment" | "cart" | "rider"
    verb:        string  e.g. "completed" | "updated" | "assigned"
    payload:     object  (domain-specific data)
    metadata: {
      publishedAt: Timestamp
      publishedBy: string   (userId or 'system')
      correlationId: string (trace across multiple events for one business flow)
      causationId:   string (the eventId that caused this event, if any)
      sessionId:     string (POS session, user session, etc.)
      version:       '1.0'
    }
    delivery: {
      attempts:    number
      lastAttempt: Timestamp
      subscribers: string[]  (which subscribers received this)
      failed:      string[]  (which subscribers failed)
    }
    status: 'pending' | 'delivered' | 'partial' | 'dead_letter'
  }
──────────────────────────────────────────────────────────────────────── */

/* ── Canonical event types ── */
const EVENT_TYPES = {
  /* Orders */
  ORDER_CREATED:           'order.order.created',
  ORDER_ACCEPTED:          'order.order.accepted',
  ORDER_PACKED:            'order.order.packed',
  ORDER_READY:             'order.order.ready',
  ORDER_COMPLETED:         'order.order.completed',
  ORDER_CANCELLED:         'order.order.cancelled',
  ORDER_REFUNDED:          'order.order.refunded',
  /* Payments */
  PAYMENT_CREATED:         'payment.transaction.created',
  PAYMENT_PENDING:         'payment.transaction.pending',
  PAYMENT_PROCESSING:      'payment.transaction.processing',
  PAYMENT_COMPLETED:       'payment.transaction.completed',
  PAYMENT_FAILED:          'payment.transaction.failed',
  PAYMENT_CANCELLED:       'payment.transaction.cancelled',
  PAYMENT_REFUNDED:        'payment.transaction.refunded',
  /* POS */
  POS_SESSION_OPENED:      'pos.session.opened',
  POS_SESSION_CLOSED:      'pos.session.closed',
  POS_CART_UPDATED:        'pos.cart.updated',
  POS_CHECKOUT_COMPLETED:  'pos.checkout.completed',
  POS_DEVICE_JOINED:       'pos.device.joined',
  POS_DEVICE_LEFT:         'pos.device.left',
  /* Inventory */
  INVENTORY_UPDATED:       'inventory.stock.updated',
  INVENTORY_LOW:           'inventory.stock.low',
  INVENTORY_DEPLETED:      'inventory.stock.depleted',
  PRODUCT_PUBLISHED:       'inventory.product.published',
  PRODUCT_UNPUBLISHED:     'inventory.product.unpublished',
  /* Delivery */
  DELIVERY_REQUESTED:      'delivery.shipment.requested',
  RIDER_ASSIGNED:          'delivery.rider.assigned',
  DELIVERY_STARTED:        'delivery.shipment.started',
  DELIVERY_COMPLETED:      'delivery.shipment.completed',
  DELIVERY_FAILED:         'delivery.shipment.failed',
  /* Reviews */
  REVIEW_ADDED:            'review.review.added',
  REVIEW_FLAGGED:          'review.review.flagged',
  /* Users */
  USER_REGISTERED:         'user.account.registered',
  USER_VERIFIED:           'user.account.verified',
  SELLER_APPROVED:         'user.seller.approved',
};

/* ── Validate event type ── */
function _parseType(type) {
  const parts = type.split('.');
  if (parts.length !== 3) throw new Error('Event type must be domain.noun.verb: ' + type);
  const [domain, noun, verb] = parts;
  if (!domain || !noun || !verb) throw new Error('Empty event type segment in: ' + type);
  return { domain, noun, verb };
}

/* ── Sanitize ── */
function _san(v, max) {
  if (typeof v !== 'string') return '';
  return v.replace(/[<>"']/g, '').slice(0, max);
}

/* ── SSRF guard: only allow HTTPS URLs to public hosts ── */
function _validateCallbackUrl(raw) {
  if (!raw) return null;
  let parsed;
  try { parsed = new URL(raw); } catch { throw new HttpsError('invalid-argument', 'callbackUrl must be a valid URL'); }
  if (parsed.protocol !== 'https:') throw new HttpsError('invalid-argument', 'callbackUrl must use HTTPS');
  const h = parsed.hostname;
  /* Block private/link-local/loopback ranges */
  if (/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1|0\.0\.0\.0|169\.254\.)/.test(h)) {
    throw new HttpsError('invalid-argument', 'callbackUrl must point to a public host');
  }
  return parsed.toString().slice(0, 512);
}

/* ═══════════════════════════════════════════════════════════
   CF 1: publishEvent — any module calls this to emit an event
═══════════════════════════════════════════════════════════ */
exports.publishEvent = onCall({ enforceAppCheck: true }, async (request) => {
  const auth    = request.auth;
  const { type, payload, correlationId, causationId, sessionId } = request.data || {};

  if (!type || typeof type !== 'string') throw new HttpsError('invalid-argument', 'type is required');
  if (!payload || typeof payload !== 'object') throw new HttpsError('invalid-argument', 'payload is required');

  const { domain, noun, verb } = _parseType(type);

  const eventRef = admin.firestore().collection('platformEvents').doc();
  const eventId  = eventRef.id;

  await eventRef.set({
    eventId,
    type,
    domain:  _san(domain, 40),
    noun:    _san(noun, 40),
    verb:    _san(verb, 40),
    payload, /* payload is stored as-is; subscribers validate their expected shape */
    metadata: {
      publishedAt:    now(),
      publishedBy:    auth ? auth.uid : 'system',
      correlationId:  correlationId ? _san(correlationId, 64) : eventId,
      causationId:    causationId   ? _san(causationId, 64)   : null,
      sessionId:      sessionId     ? _san(sessionId, 64)     : null,
      version:        '1.0',
    },
    delivery: {
      attempts:    0,
      lastAttempt: null,
      subscribers: [],
      failed:      [],
    },
    status: 'pending',
    createdAt: now(),
  });

  return { eventId, type, status: 'published' };
});

/* ═══════════════════════════════════════════════════════════
   CF 2: getEvent — retrieve a specific event (admin/debug)
═══════════════════════════════════════════════════════════ */
exports.getEvent = onCall({ enforceAppCheck: true }, async (request) => {
  const auth = request.auth;
  if (!auth) throw new HttpsError('unauthenticated', 'Authentication required');

  const { eventId } = request.data || {};
  if (!eventId) throw new HttpsError('invalid-argument', 'eventId is required');

  const snap = await admin.firestore().collection('platformEvents').doc(eventId).get();
  if (!snap.exists) throw new HttpsError('not-found', 'Event not found');

  const ev = snap.data();
  /* Only allow the publisher or admins to read event details */
  const claims = auth.token || {};
  const isAdmin = claims.admin || claims.role === 'admin' || claims.role === 'super_admin';
  if (!isAdmin && ev.metadata.publishedBy !== auth.uid) {
    throw new HttpsError('permission-denied', 'Access denied');
  }

  return ev;
});

/* ═══════════════════════════════════════════════════════════
   CF 3: queryEvents — list events by domain/type/status
═══════════════════════════════════════════════════════════ */
exports.queryEvents = onCall({ enforceAppCheck: true }, async (request) => {
  const auth = request.auth;
  const claims = auth ? (auth.token || {}) : {};
  const isAdmin = claims.admin || claims.role === 'admin' || claims.role === 'super_admin';
  if (!isAdmin) throw new HttpsError('permission-denied', 'Admin access required');

  const { domain, type, status, limit: lim = 50, startAfter } = request.data || {};
  let q = admin.firestore().collection('platformEvents')
    .orderBy('createdAt', 'desc')
    .limit(Math.min(lim, 200));

  if (domain) q = q.where('domain', '==', _san(domain, 40));
  if (type)   q = q.where('type',   '==', _san(type, 120));
  if (status) q = q.where('status', '==', _san(status, 20));

  if (startAfter) {
    const startSnap = await admin.firestore().collection('platformEvents').doc(startAfter).get();
    if (startSnap.exists) q = q.startAfter(startSnap);
  }

  const results = await q.get();
  return {
    events: results.docs.map(d => d.data()),
    count:  results.size,
  };
});

/* ═══════════════════════════════════════════════════════════
   CF 4: replayEvent — re-deliver a stuck/failed event
═══════════════════════════════════════════════════════════ */
exports.replayEvent = onCall({ enforceAppCheck: true }, async (request) => {
  const auth   = request.auth;
  const claims = auth ? (auth.token || {}) : {};
  const isAdmin = claims.admin || claims.role === 'admin' || claims.role === 'super_admin';
  if (!isAdmin) throw new HttpsError('permission-denied', 'Admin access required');

  const { eventId } = request.data || {};
  if (!eventId) throw new HttpsError('invalid-argument', 'eventId is required');

  await admin.firestore().collection('platformEvents').doc(eventId).update({
    status:              'pending',
    'delivery.attempts': 0,
    'delivery.failed':   [],
  });

  return { eventId, status: 'queued_for_replay' };
});

/* ═══════════════════════════════════════════════════════════
   CF 5: getEventStats — dashboard metrics
═══════════════════════════════════════════════════════════ */
exports.getEventStats = onCall({ enforceAppCheck: true }, async (request) => {
  const auth   = request.auth;
  const claims = auth ? (auth.token || {}) : {};
  const isAdmin = claims.admin || claims.role === 'admin' || claims.role === 'super_admin';
  if (!isAdmin) throw new HttpsError('permission-denied', 'Admin access required');

  const db = admin.firestore();
  const [pending, delivered, partial, dead] = await Promise.all([
    db.collection('platformEvents').where('status', '==', 'pending').count().get(),
    db.collection('platformEvents').where('status', '==', 'delivered').count().get(),
    db.collection('platformEvents').where('status', '==', 'partial').count().get(),
    db.collection('platformEvents').where('status', '==', 'dead_letter').count().get(),
  ]);

  return {
    pending:     pending.data().count,
    delivered:   delivered.data().count,
    partial:     partial.data().count,
    dead_letter: dead.data().count,
    total: pending.data().count + delivered.data().count + partial.data().count + dead.data().count,
  };
});

/* ═══════════════════════════════════════════════════════════
   Firestore trigger: fan out on new event
   Reads subscriber registry from `eventSubscribers` collection
   and marks delivery status.
═══════════════════════════════════════════════════════════ */
exports.onPlatformEventCreated = onDocumentCreated(
  'platformEvents/{eventId}',
  async (event) => {
    const data    = event.data.data();
    const eventId = event.params.eventId;
    const type    = data.type;

    /* Look up subscribers for this event type */
    const subscriberSnaps = await admin.firestore()
      .collection('eventSubscribers')
      .where('eventTypes', 'array-contains', type)
      .where('active', '==', true)
      .get();

    if (subscriberSnaps.empty) {
      /* No subscribers — mark delivered immediately */
      await event.data.ref.update({ status: 'delivered', 'delivery.subscribers': [] });
      return;
    }

    /* Fan out to each subscriber (log delivery intent) */
    const subscriberIds = subscriberSnaps.docs.map(d => d.id);

    await event.data.ref.update({
      'delivery.subscribers': subscriberIds,
      'delivery.attempts':    admin.firestore.FieldValue.increment(1),
      'delivery.lastAttempt': now(),
    });

    /* In a real implementation, each subscriber could be a Pub/Sub topic
       or a CF webhook. For Phase 1, we store the intent and let each
       domain's CF poll its own domain events from Firestore.
       Phase 2: migrate to Pub/Sub for true fan-out. */
  }
);

/* ═══════════════════════════════════════════════════════════
   CF 6: registerEventSubscriber — register a module as subscriber
   (admin only — called during module deployment)
═══════════════════════════════════════════════════════════ */
exports.registerEventSubscriber = onCall({ enforceAppCheck: true }, async (request) => {
  const auth   = request.auth;
  const claims = auth ? (auth.token || {}) : {};
  const isAdmin = claims.admin || claims.role === 'admin' || claims.role === 'super_admin';
  if (!isAdmin) throw new HttpsError('permission-denied', 'Admin access required');

  const { subscriberId, name, eventTypes, callbackUrl, description } = request.data || {};

  if (!subscriberId || !eventTypes || !Array.isArray(eventTypes)) {
    throw new HttpsError('invalid-argument', 'subscriberId and eventTypes[] required');
  }

  await admin.firestore().collection('eventSubscribers').doc(subscriberId).set({
    subscriberId: _san(subscriberId, 64),
    name:         _san(name || subscriberId, 128),
    description:  _san(description || '', 500),
    eventTypes:   eventTypes.map(t => _san(t, 120)).slice(0, 50),
    callbackUrl:  callbackUrl ? _validateCallbackUrl(callbackUrl) : null,
    active:       true,
    createdAt:    now(),
    updatedAt:    now(),
  }, { merge: true });

  return { subscriberId, status: 'registered', eventTypes };
});

/* ═══════════════════════════════════════════════════════════
   Scheduled: clean up delivered events older than 30 days
   Dead-letter events kept for 90 days for debugging
═══════════════════════════════════════════════════════════ */
exports.eventBusCleanup = onSchedule(
  { schedule: 'every 24 hours', timeZone: 'Africa/Nairobi' },
  async () => {
    const db      = admin.firestore();
    const thirtyD = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const ninetyD = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);

    /* Delete old delivered events */
    const delivered = await db.collection('platformEvents')
      .where('status', '==', 'delivered')
      .where('createdAt', '<', thirtyD)
      .limit(500)
      .get();

    /* Delete old dead-letter events */
    const dead = await db.collection('platformEvents')
      .where('status', '==', 'dead_letter')
      .where('createdAt', '<', ninetyD)
      .limit(500)
      .get();

    const batch = db.batch();
    delivered.docs.forEach(d => batch.delete(d.ref));
    dead.docs.forEach(d => batch.delete(d.ref));
    await batch.commit();

    console.log(`[EventBus] Cleanup: ${delivered.size} delivered + ${dead.size} dead events removed`);
  }
);

/* ── Export event types for use in other modules ── */
exports.EVENT_TYPES = EVENT_TYPES;
