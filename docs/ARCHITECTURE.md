# SOKONI Enterprise Architecture

**Version:** 2.0  
**Date:** 2026-06-28  
**Status:** Production

---

## Overview

SOKONI is a cloud-native, event-driven, enterprise commerce platform built on Firebase + Google Cloud. The architecture is designed to scale from a single-store POS to a multi-branch, multi-vendor marketplace serving millions of users without requiring architectural rewrites.

---

## Layered Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│  PRESENTATION LAYER                                                  │
│  Web (PWA) │ Mobile (responsive) │ SmartPOS │ Admin OS │ Super Admin │
└────────────────────────────┬────────────────────────────────────────┘
                             │ HTTPS / Firebase SDK
┌────────────────────────────▼────────────────────────────────────────┐
│  API LAYER — Firebase Cloud Functions (Gen2, Node.js 22)             │
│  Callable APIs │ HTTP Webhooks │ Scheduled Jobs │ Firestore Triggers  │
└────────────────────────────┬────────────────────────────────────────┘
                             │ Admin SDK
┌────────────────────────────▼────────────────────────────────────────┐
│  APPLICATION LAYER — Business Services                               │
│  Order Engine │ Payment Orchestrator │ Delivery Engine               │
│  Inventory Engine │ POS Engine │ Foundation Engine                   │
│  AI Engine │ Notification Engine │ Commission Engine                 │
└───────────────────┬───────────────────────┬─────────────────────────┘
                    │                       │
┌───────────────────▼──────────┐  ┌────────▼────────────────────────┐
│  EVENT BUS (Firestore-backed) │  │  REDIS — Operational Layer       │
│  platform-event-bus.js        │  │  Live POS sync │ Presence        │
│  Publish → Fan-out → Deliver  │  │  Carts │ Sessions │ Rate limits   │
└───────────────────────────────┘  └─────────────────────────────────┘
                    │
┌───────────────────▼────────────────────────────────────────────────┐
│  INFRASTRUCTURE LAYER                                                │
│  Firestore (system of record) │ Cloud Storage │ Firebase Auth        │
│  Secret Manager │ Cloud Scheduler │ Cloud Logging │ Cloud Monitoring  │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Event-Driven Architecture

### Platform Event Bus

All platform modules communicate via events, not direct function calls. This enables:
- Loose coupling between modules
- Reliable async processing
- Audit trail for every business action
- Easy addition of new subscribers without modifying existing code

**File:** `functions/platform-event-bus.js`  
**Collection:** `platformEvents/{eventId}`

### Event Naming Convention

```
domain.noun.verb   (all lowercase, past tense)

Examples:
  order.payment.completed
  pos.cart.updated
  delivery.rider.assigned
  inventory.stock.depleted
  foundation.donation.received
```

### Canonical Event Types

| Event | Trigger |
|-------|---------|
| `order.order.created` | New order placed |
| `order.order.completed` | Order delivered |
| `payment.transaction.completed` | Payment confirmed |
| `payment.transaction.failed` | Payment failed |
| `pos.session.opened` | POS session started |
| `pos.cart.updated` | Cart item changed |
| `delivery.rider.assigned` | Rider picks up order |
| `inventory.stock.low` | Stock below threshold |
| `foundation.donation.received` | Donation captured |

### Event Lifecycle

```
Created → Stored in platformEvents → Subscriber registry checked
       → Fan-out to subscribers → Delivered / Dead Letter
       → Retry if failed (max 3) → dead_letter after max attempts
```

---

## SmartPOS 2.0 Architecture

### Multi-Device Session Model

```
┌─────────────────────────────────────────────────────────────┐
│                  posSessions/{sessionId}                      │
│                                                               │
│  devices:  { deviceId: { uid, name, role, lastSeen } }       │
│  cart:     { productId: { name, price, qty, discount } }     │
│  memberUids: string[]  (for Firestore security rules)         │
│  cartTotal, cartTax, cartSubtotal, cartDiscount               │
│  status: 'open' | 'closed'                                   │
│  sessionCode: '123456'  (6-digit easy-join code)             │
└──────────────────────┬──────────────────────────────────────┘
                       │ onSnapshot listener
         ┌─────────────┼─────────────┐
    Desktop POS    Phone (cashier)   Tablet (manager)
    (host device)  (secondary)       (secondary)
```

### Session Flow

```
Seller → createPosSession() → sessionCode (6 digits)
Staff  → joinPosSession({ code }) → all devices get Firestore listener
Cart   → updatePosCart() → CF transaction → all devices see update instantly
Close  → closePosSession() → all listeners notified → session archived
```

### Universal Terminal Driver

**File:** `pos-terminal-driver.js`

```
PosTerminalDriver
  ├── register(driver)      — plug in new vendors without core changes
  ├── connect(vendorId)     — WebUSB / network / Bluetooth
  ├── autoConnect()         — try all registered drivers in order
  ├── charge(opts)          — unified payment call
  └── on(event, fn)         — terminal event subscription

Registered drivers:
  intasend   — Software (always available, M-Pesa + Cards)
  ingenico   — USB / Network / Bluetooth stub
  verifone   — USB / Network stub
  pax        — USB / Network / WiFi stub
  castles    — USB / Bluetooth stub
  newland    — USB / Network stub
  sunmi      — Network / WiFi stub
  nexgo      — USB / Network stub
  bbpos      — Bluetooth / Audio-jack stub
  miura      — Bluetooth / USB stub
  stripe     — Bluetooth / USB / WiFi stub
```

Hardware stubs show up in the terminal selection UI immediately. Real driver implementations are added per vendor without modifying any core files.

---

## Payment Orchestrator v2.0

**File:** `functions/payment-orchestrator.js`

### Payment State Machine

```
created → pending → processing → succeeded
       ↘         ↘            ↘
      cancelled  failed       ← (any terminal state)
                               ↓
                            refunded
```

Every transition:
1. Is validated against allowed transitions (no illegal jumps)
2. Appends to `history[]` with actor + timestamp
3. Emits a `payment.transaction.*` platform event
4. Idempotency key prevents duplicate payments

### Provider Support

| Provider | Method | Implementation |
|----------|--------|---------------|
| `mpesa` | IntaSend STK Push | `initiatePayment` |
| `card` | IntaSend checkout redirect | `initiatePayment` |
| `wallet` | Internal wallet deduction | `initiatePayment` |
| `bank` | Bank transfer (future) | stub |
| `qr` | Smart QR (pos-qr.js) | `generatePOSPaymentQR` |

---

## Operations Center

**File:** `functions/operations-center.js`  
**UI:** `ops-center.html`

### Monitored Systems

- Orders (active, pending)
- Payments (today, failed 24h, stuck >5m)
- POS sessions (open, devices connected)
- Event Bus (pending, dead-letter)
- Users (online last 5m)
- Deliveries (in transit)
- Inventory (stock alerts)

### Self-Healing Actions

| Action | Effect |
|--------|--------|
| `retry_stuck_payments` | Reset pending payments stuck >5m back to pending |
| `replay_dead_events` | Reset dead-letter events to pending for re-delivery |
| `close_stale_pos_sessions` | Close sessions idle >24h |

### Metric History

`opsMetrics` collection stores 5-minute snapshots for 7 days:
- `orders_active`
- `payments_today`
- `payments_failed_24h`
- `pos_open_sessions`
- `events_dead_letter`

---

## Redis Layer (Operational State)

**File:** `functions/redis-service.js`

Redis handles **temporary operational state only**. All permanent records remain in Firestore.

| Service | Purpose |
|---------|---------|
| `CacheService` | Search results, AI responses, computed aggregates |
| `SessionService` | Active user sessions (complement to Firebase Auth) |
| `LockService` | Distributed locks (inventory, payments, slots) |
| `PresenceService` | Device heartbeats, POS connections |
| `RateLimitService` | API rate limiting (per UID + IP) |
| `DashboardService` | Real-time dashboard counters |
| `PaymentService` | STK context, pending payment state |
| `POSService` | Live cart state, active tills |
| `InventoryService` | Real-time stock counts |
| `EventBusService` | Pub/Sub for platform events |
| `QueueService` | Background job queues |

**REDIS_URL** — set via `firebase functions:secrets:set REDIS_URL` or `.env` file.  
All Redis services degrade gracefully to Firestore fallback when Redis is unavailable.

---

## Infrastructure Layer

### Firestore — System of Record

All permanent data lives in Firestore. Never store authoritative financial or business data exclusively in Redis.

Key collections:

| Collection | Purpose |
|-----------|---------|
| `orders` | All orders, permanent record |
| `payments` | Payment lifecycle (Orchestrator v2) |
| `platformEvents` | Event bus event log |
| `posSessions` | SmartPOS multi-device sessions |
| `eventSubscribers` | Event bus subscriber registry |
| `opsMetrics` | 5-min metric snapshots (7-day retention) |
| `selfHealLog` | Audit log of self-healing actions |
| `products` | Product catalog |
| `users` | User profiles |
| `sellers` | Seller profiles |

### Security Rules Architecture

All collections follow the principle of least privilege:
- Guests: read public data only
- Buyers: read/write their own orders, payments
- Sellers: manage their own products, sessions, orders
- Admins: full access with audit logging
- Cloud Functions (Admin SDK): bypass rules for server-side operations

### Secret Manager

All secrets stored in Google Secret Manager. Access only via `defineSecret()` or `process.env` for non-blocking deploys.

| Secret | Usage |
|--------|-------|
| `INTASEND_PRIVATE_KEY` | IntaSend payment SDK |
| `QR_SIGNING_SECRET` | HMAC signing for POS QR transactions |
| `SENDGRID_API_KEY` | Email delivery |
| `REDIS_URL` | Redis connection (optional — degrades gracefully) |

---

## Performance Targets

| Metric | Target |
|--------|--------|
| Cold start (Gen2 CF) | < 500ms |
| Hot callable CF | < 200ms |
| Firestore read | < 50ms |
| POS cart sync (onSnapshot) | < 100ms |
| STK push initiation | < 3s |
| Page load (PWA cached) | < 1s |

---

## Scalability Design

- **Horizontal**: Firebase/GCP auto-scales all CFs
- **Stateless CFs**: no in-memory state between invocations
- **Event-driven**: modules decouple via event bus (no direct cross-module CF calls)
- **Redis operational layer**: absorbs hot-path reads/writes before Firestore
- **Multi-region**: Firestore multi-region available; CFs in `us-central1` (extend as needed)
- **POS**: Firestore `onSnapshot` scales to thousands of concurrent sessions natively
- **Franchise support**: Session codes, multi-branch seller profiles, per-branch analytics planned

---

## Self-Healing & Reliability

1. **Stuck payments**: `paymentTimeoutSweep` (every 5m) auto-fails payments stuck >30m
2. **Dead events**: `snapshotPlatformMetrics` (every 5m) auto-replays if >100 dead
3. **Stale POS sessions**: `posSessionCleanup` (every 6h) closes idle >24h sessions
4. **Event bus cleanup**: `eventBusCleanup` (daily) deletes delivered >30d, dead >90d
5. **Redis fallback**: All Redis services return `{ fallback: true }` when unavailable
6. **Offline POS**: IndexedDB queue + Firestore sync on reconnect (via pos-sync.js)

---

## Developer Guide

### Publishing an Event

```javascript
// From any Cloud Function or client
const publishEvent = httpsCallable(fn, 'publishEvent');
await publishEvent({
  type: 'order.order.created',
  payload: { orderId, buyerId, amount, sellerId },
  correlationId: orderId, // trace this business flow
});
```

### Subscribing to Events

```javascript
// From admin or CF:
const registerEventSubscriber = httpsCallable(fn, 'registerEventSubscriber');
await registerEventSubscriber({
  subscriberId: 'inventory-engine',
  name: 'Inventory Engine',
  eventTypes: ['order.order.completed', 'inventory.stock.low'],
});
// Then query platformEvents where type in subscribed types
```

### Adding a Terminal Driver

```javascript
// Create new driver extending BaseTerminalDriver pattern
class MyVendorDriver {
  constructor() {
    this.vendorId   = 'myvendor';
    this.vendorName = 'My Vendor Terminal';
    this.connected  = false;
  }
  connect(config) { /* WebUSB / network init */ }
  charge(opts)    { /* Send amount to terminal */ }
  refund(opts)    { /* Request refund */ }
  status()        { /* Return health/battery */ }
}
// Register:
PosTerminalDriver.register(new MyVendorDriver());
```

---

## Related Documentation

- [[SmartPOS]] — Full POS feature documentation
- [[Payments]] — Payment flow and M-Pesa integration
- [[Events]] — Platform event types and subscribers
- [[Security]] — Security rules and access control
- [[Deployment]] — Firebase deploy procedures
- [[Redis]] — Redis layer setup and fallback behaviour
