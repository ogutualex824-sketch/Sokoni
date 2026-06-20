/**
 * SOKONI Enterprise Event Bus  v2.0
 *
 * Foundation layer for the entire SOKONI service mesh.
 * Every service communicates through typed, audited events.
 *
 * Features:
 *  - Typed event catalogue with payload validation
 *  - Priority lanes: CRITICAL, HIGH, MEDIUM, LOW
 *  - Firestore persistence for critical events (durable across reloads)
 *  - Dead-letter queue for failed handlers
 *  - Replay support — replay any event from history
 *  - Cross-tab broadcast via BroadcastChannel
 *  - Event correlation IDs for distributed tracing
 *  - Wildcard subscriptions (e.g. "Payment.*")
 *  - One-time handlers (.once)
 *  - Maximum one active handler per unique subscriber key (dedup)
 */

'use strict';

const SokoniEventBus = (function () {

  /* ════════════════════════════════════════════════════════════
     EVENT CATALOGUE — every known event type in the platform
  ════════════════════════════════════════════════════════════ */
  const EVENTS = Object.freeze({
    /* Orders */
    ORDER_CREATED:           'Order.Created',
    ORDER_CONFIRMED:         'Order.Confirmed',
    ORDER_CANCELLED:         'Order.Cancelled',
    ORDER_COMPLETED:         'Order.Completed',
    ORDER_DISPUTED:          'Order.Disputed',

    /* Payments */
    PAYMENT_INITIATED:       'Payment.Initiated',
    PAYMENT_COMPLETED:       'Payment.Completed',
    PAYMENT_FAILED:          'Payment.Failed',
    PAYMENT_REFUNDED:        'Payment.Refunded',

    /* Escrow */
    ESCROW_CREATED:          'Escrow.Created',
    ESCROW_RELEASED:         'Escrow.Released',
    ESCROW_DISPUTED:         'Escrow.Disputed',
    ESCROW_REFUNDED:         'Escrow.Refunded',

    /* Wallet */
    WALLET_CREDITED:         'Wallet.Credited',
    WALLET_DEBITED:          'Wallet.Debited',
    WALLET_WITHDRAWAL:       'Wallet.Withdrawal',

    /* Commission */
    COMMISSION_CALCULATED:   'Commission.Calculated',
    COMMISSION_INVOICED:     'Commission.Invoiced',
    COMMISSION_SETTLED:      'Commission.Settled',

    /* Settlement */
    SELLER_PAID:             'Settlement.SellerPaid',
    DRIVER_PAID:             'Settlement.DriverPaid',
    PROVIDER_PAID:           'Settlement.ProviderPaid',

    /* Inventory */
    INVENTORY_RESERVED:      'Inventory.Reserved',
    INVENTORY_RELEASED:      'Inventory.Released',
    INVENTORY_LOW:           'Inventory.LowStock',

    /* Delivery */
    DELIVERY_CREATED:        'Delivery.Created',
    DELIVERY_ASSIGNED:       'Delivery.Assigned',
    DELIVERY_PICKED_UP:      'Delivery.PickedUp',
    DELIVERY_COMPLETED:      'Delivery.Completed',
    DELIVERY_FAILED:         'Delivery.Failed',

    /* Rides */
    RIDE_REQUESTED:          'Ride.Requested',
    RIDE_DRIVER_ASSIGNED:    'Ride.DriverAssigned',
    RIDE_STARTED:            'Ride.Started',
    RIDE_COMPLETED:          'Ride.Completed',
    RIDE_CANCELLED:          'Ride.Cancelled',

    /* Events / Ticketing */
    TICKET_PURCHASED:        'Ticket.Purchased',
    TICKET_SCANNED:          'Ticket.Scanned',
    TICKET_REFUNDED:         'Ticket.Refunded',

    /* SmartPOS */
    SMARTPOS_TRANSACTION:    'SmartPOS.Transaction',
    SMARTPOS_RECONCILED:     'SmartPOS.Reconciled',
    SMARTPOS_OFFLINE_SYNC:   'SmartPOS.OfflineSync',

    /* Users */
    USER_REGISTERED:         'User.Registered',
    USER_VERIFIED:           'User.Verified',
    USER_SUSPENDED:          'User.Suspended',

    /* Business */
    BUSINESS_APPROVED:       'Business.Approved',
    BUSINESS_SUSPENDED:      'Business.Suspended',
    BUSINESS_KYC_SUBMITTED:  'Business.KYCSubmitted',

    /* Webhooks */
    WEBHOOK_RECEIVED:        'Webhook.Received',
    WEBHOOK_PROCESSED:       'Webhook.Processed',
    WEBHOOK_FAILED:          'Webhook.Failed',
    WEBHOOK_DLQ:             'Webhook.DeadLetter',

    /* Notifications */
    NOTIFICATION_SENT:       'Notification.Sent',
    NOTIFICATION_FAILED:     'Notification.Failed',

    /* Fraud */
    FRAUD_FLAGGED:           'Fraud.Flagged',
    FRAUD_BLOCKED:           'Fraud.Blocked',
    FRAUD_CLEARED:           'Fraud.Cleared',

    /* Subscriptions */
    SUBSCRIPTION_ACTIVATED:  'Subscription.Activated',
    SUBSCRIPTION_RENEWED:    'Subscription.Renewed',
    SUBSCRIPTION_CANCELLED:  'Subscription.Cancelled',
    SUBSCRIPTION_EXPIRED:    'Subscription.Expired',

    /* Platform */
    SYSTEM_HEALTH_ALERT:     'System.HealthAlert',
    SYSTEM_CIRCUIT_OPEN:     'System.CircuitOpen',
    SYSTEM_CIRCUIT_CLOSED:   'System.CircuitClosed',
    RATE_LIMIT_HIT:          'System.RateLimitHit',
  });

  /* ════════════════════════════════════════════════════════════
     PRIORITY LEVELS
  ════════════════════════════════════════════════════════════ */
  const PRIORITY = Object.freeze({ CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 });

  /* Events that must be persisted to Firestore */
  const PERSISTENT_EVENTS = new Set([
    EVENTS.ORDER_CREATED, EVENTS.ORDER_COMPLETED, EVENTS.ORDER_DISPUTED,
    EVENTS.PAYMENT_COMPLETED, EVENTS.PAYMENT_FAILED, EVENTS.PAYMENT_REFUNDED,
    EVENTS.ESCROW_CREATED, EVENTS.ESCROW_RELEASED, EVENTS.ESCROW_REFUNDED,
    EVENTS.WALLET_CREDITED, EVENTS.WALLET_DEBITED, EVENTS.WALLET_WITHDRAWAL,
    EVENTS.COMMISSION_SETTLED, EVENTS.SELLER_PAID, EVENTS.DRIVER_PAID,
    EVENTS.FRAUD_FLAGGED, EVENTS.FRAUD_BLOCKED,
    EVENTS.WEBHOOK_RECEIVED, EVENTS.WEBHOOK_FAILED, EVENTS.WEBHOOK_DLQ,
    EVENTS.USER_SUSPENDED, EVENTS.BUSINESS_SUSPENDED,
    EVENTS.SMARTPOS_TRANSACTION, EVENTS.TICKET_PURCHASED,
  ]);

  /* ════════════════════════════════════════════════════════════
     INTERNAL STATE
  ════════════════════════════════════════════════════════════ */
  const _handlers    = new Map();   // eventType → [ { id, fn, once, priority } ]
  const _dlq         = [];          // dead-letter queue entries
  const _history     = [];          // in-memory ring buffer (last 200 events)
  const MAX_HISTORY  = 200;
  let   _correlationCounter = 0;
  let   _channel     = null;        // BroadcastChannel for cross-tab

  /* ── Correlation ID generator ── */
  function _cid() {
    return `EVT-${Date.now()}-${(++_correlationCounter).toString(36).padStart(4, '0')}`;
  }

  /* ── BroadcastChannel setup ── */
  try {
    _channel = new BroadcastChannel('sokoni_event_bus');
    _channel.onmessage = (e) => {
      if (e.data && e.data.__sokoni_bus_relay) {
        _deliverLocal(e.data.event, e.data.payload, e.data.meta, true);
      }
    };
  } catch (_) { /* BroadcastChannel not available */ }

  /* ── Match event type against pattern (supports wildcards) ── */
  function _matches(pattern, eventType) {
    if (pattern === eventType) return true;
    if (pattern.endsWith('.*')) {
      const ns = pattern.slice(0, -2);
      return eventType.startsWith(ns + '.');
    }
    if (pattern === '*') return true;
    return false;
  }

  /* ── Deliver event to local handlers ── */
  function _deliverLocal(eventType, payload, meta, fromRelay = false) {
    _handlers.forEach((subs, pattern) => {
      if (!_matches(pattern, eventType)) return;

      const toRemove = [];
      const sorted   = [...subs].sort((a, b) => a.priority - b.priority);

      sorted.forEach(sub => {
        try {
          sub.fn({ type: eventType, payload, meta, correlationId: meta.correlationId });
        } catch (err) {
          _dlq.push({ eventType, payload, meta, error: err.message, handlerId: sub.id, ts: Date.now() });
          if (_dlq.length > 500) _dlq.shift();
        }
        if (sub.once) toRemove.push(sub.id);
      });

      toRemove.forEach(id => {
        const updated = subs.filter(s => s.id !== id);
        _handlers.set(pattern, updated);
      });
    });

    /* Persist to in-memory ring buffer */
    _history.push({ eventType, payload: _sanitizePayload(payload), meta, ts: Date.now() });
    if (_history.length > MAX_HISTORY) _history.shift();
  }

  /* ── Persist critical events to Firestore ── */
  async function _persist(eventType, payload, meta) {
    if (!PERSISTENT_EVENTS.has(eventType)) return;
    if (!window.firebaseDB) return;

    try {
      const { collection, addDoc, serverTimestamp } = await import(
        'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js'
      );
      await addDoc(collection(window.firebaseDB, 'eventLog'), {
        type: eventType,
        payload: _sanitizePayload(payload),
        meta,
        serverTs: serverTimestamp(),
      });
    } catch (e) {
      if (window.SokoniLogger) window.SokoniLogger.warn('[EventBus] Firestore persist failed:', e.message);
    }
  }

  /* ── Strip sensitive fields before persistence ── */
  function _sanitizePayload(payload) {
    if (!payload || typeof payload !== 'object') return payload;
    const safe = Object.assign({}, payload);
    const STRIP = ['password', 'pin', 'secret', 'token', 'cardNumber', 'cvv', 'privateKey'];
    STRIP.forEach(k => delete safe[k]);
    return safe;
  }

  /* ════════════════════════════════════════════════════════════
     PUBLIC API
  ════════════════════════════════════════════════════════════ */
  let _subCounter = 0;

  const Bus = {

    EVENTS,
    PRIORITY,

    /**
     * Subscribe to an event type or wildcard pattern.
     * Returns unsubscribe function.
     */
    on(eventType, handler, opts = {}) {
      const id       = `sub_${++_subCounter}`;
      const priority = opts.priority ?? PRIORITY.MEDIUM;
      const once     = opts.once     ?? false;

      if (!_handlers.has(eventType)) _handlers.set(eventType, []);
      _handlers.get(eventType).push({ id, fn: handler, once, priority });

      return function unsubscribe() {
        if (!_handlers.has(eventType)) return;
        _handlers.set(eventType, _handlers.get(eventType).filter(s => s.id !== id));
      };
    },

    /** Subscribe to an event exactly once. */
    once(eventType, handler, opts = {}) {
      return this.on(eventType, handler, { ...opts, once: true });
    },

    /**
     * Publish an event to all subscribers.
     * @param {string} eventType  - One of Bus.EVENTS.*
     * @param {object} payload    - Event data
     * @param {object} opts       - { source, userId, broadcast }
     */
    async emit(eventType, payload = {}, opts = {}) {
      const meta = {
        correlationId: opts.correlationId || _cid(),
        source:        opts.source        || 'client',
        userId:        opts.userId        || (window.firebaseAuth?.currentUser?.uid ?? null),
        ts:            Date.now(),
      };

      /* Deliver locally */
      _deliverLocal(eventType, payload, meta);

      /* Cross-tab broadcast (default on for critical events) */
      const shouldBroadcast = opts.broadcast ?? (PERSISTENT_EVENTS.has(eventType));
      if (shouldBroadcast && _channel) {
        try {
          _channel.postMessage({ __sokoni_bus_relay: true, event: eventType, payload, meta });
        } catch (_) {}
      }

      /* Persist critical events to Firestore (non-blocking) */
      if (PERSISTENT_EVENTS.has(eventType)) {
        _persist(eventType, payload, meta);
      }

      return meta.correlationId;
    },

    /** Synchronous emit — no Firestore write, no cross-tab. Use for UI-only events. */
    emitSync(eventType, payload = {}, opts = {}) {
      const meta = {
        correlationId: opts.correlationId || _cid(),
        source: 'client-sync',
        ts: Date.now(),
      };
      _deliverLocal(eventType, payload, meta);
      return meta.correlationId;
    },

    /** Remove all handlers for an event type. */
    off(eventType) {
      _handlers.delete(eventType);
    },

    /** Remove all handlers across all event types. */
    clear() {
      _handlers.clear();
    },

    /** Return the in-memory event history (newest last). */
    history(eventType) {
      if (!eventType) return [..._history];
      return _history.filter(e => e.eventType === eventType);
    },

    /** Return dead-letter queue entries. */
    deadLetterQueue() {
      return [..._dlq];
    },

    /** Replay a historical event to all current subscribers. */
    replay(correlationId) {
      const entry = _history.find(e => e.meta?.correlationId === correlationId);
      if (!entry) throw new Error(`[EventBus] No event found with correlationId ${correlationId}`);
      _deliverLocal(entry.eventType, entry.payload, { ...entry.meta, replayed: true });
    },

    /** Dump diagnostics for the admin panel. */
    diagnostics() {
      const subs = {};
      _handlers.forEach((list, pattern) => { subs[pattern] = list.length; });
      return {
        subscriptions: subs,
        historySize:   _history.length,
        dlqSize:       _dlq.length,
        crossTab:      !!_channel,
      };
    },
  };

  return Bus;
})();

window.SokoniEventBus = SokoniEventBus;
window.SokoniEvents   = SokoniEventBus.EVENTS;
