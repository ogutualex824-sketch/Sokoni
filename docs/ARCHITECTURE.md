# SOKONI Next-Generation Enterprise Platform Architecture

**Status:** Production  
**Version:** 3.0  
**Date:** 2026-07-07  
**Previous:** v2.0 (2026-06-28)

---

## Table of Contents

1. [Vision and Guiding Principles](#1-vision-and-guiding-principles)
2. [Platform Overview](#2-platform-overview)
3. [Layered Architecture](#3-layered-architecture)
4. [Application Layer — Core Engines](#4-application-layer--core-engines)
5. [Event-Driven Architecture](#5-event-driven-architecture)
6. [SmartPOS Ecosystem](#6-smartpos-ecosystem)
7. [Payment Orchestration](#7-payment-orchestration)
8. [Redis Operational Layer](#8-redis-operational-layer)
9. [Observability and Operations Center](#9-observability-and-operations-center)
10. [Self-Healing Architecture](#10-self-healing-architecture)
11. [Data Architecture](#11-data-architecture)
12. [Security Architecture](#12-security-architecture)
13. [API Design Patterns](#13-api-design-patterns)
14. [Scalability Design](#14-scalability-design)
15. [Developer Experience Standards](#15-developer-experience-standards)
16. [Infrastructure Map](#16-infrastructure-map)
17. [Performance Targets](#17-performance-targets)
18. [Module Catalog](#18-module-catalog)
19. [Deployment Architecture](#19-deployment-architecture)
20. [Architecture Decision Records](#20-architecture-decision-records)

---

## 1. Vision and Guiding Principles

### Vision

SOKONI is a unified digital commerce ecosystem for Kenya and East Africa. The architecture must support the full spectrum of business scale — from a single-person hawker using SmartPOS to a 200-branch retail chain — without requiring a rewrite at any scale transition. Every architectural decision is tested against the question: _does this hold at 10x current scale?_

### Guiding Principles

**1. Firestore is the truth.** Every business record, financial transaction, and audit event is written to Firestore first and lives there permanently. Redis, Algolia, and any other secondary store are caches and coordination layers — not records.

**2. Failure is assumed.** Every module is written assuming that its dependencies (Redis, Search, third-party APIs) can fail at any time. Graceful degradation is not an edge case — it is the default execution path.

**3. Events, not calls.** Modules communicate via a platform event bus. A payment completion triggers downstream effects (inventory release, notification, commission calculation, loyalty points) by publishing one event. Subscribing modules react independently. No module calls another module's functions directly.

**4. One contract per engine.** Each engine exposes a stable typed interface. Internal implementation can change freely. External callers depend only on the contract.

**5. Operational transparency.** Every significant action — every order, every payment, every delivery state change, every admin action — is observable in real time from the Operations Center. Nothing is invisible.

**6. Security by default.** Authentication, authorisation, rate limiting, input sanitisation, and audit logging are applied at the perimeter (API layer) before business logic executes. No engine assumes a clean input without validation.

**7. Build for maintenance.** Code that is written once but read a thousand times must be clear. Reuse over repetition. Named services over scattered inline logic. Documentation is part of the deliverable.

---

## 2. Platform Overview

SOKONI is composed of nine platform verticals, all sharing a common infrastructure:

| Vertical | Description | Key Modules |
|---|---|---|
| **Marketplace** | Multi-vendor e-commerce | Product catalog, orders, reviews, seller management |
| **SmartPOS** | Cloud-connected point of sale | POS engine, peripheral hub, payment terminals, customer display |
| **Logistics** | Delivery management | Rider dispatch, tracking, GPS, delivery pricing |
| **Services** | Professional service bookings | Venue/resource booking, job board, healthcare, legal, education |
| **Foundation** | Social impact vertical | Donation engine, disbursements, impact reporting |
| **AI** | AI-powered assistance | KASS concierge, AI subscriptions, creative studio |
| **SmartFinance** | Financial management | Commission engine, FinOS, payroll, eTIMS, reconciliation |
| **Commerce OS** | Business operations suite | HR, procurement, marketing engine, business health |
| **Enterprise** | Platform administration | Admin OS, Super Admin, analytics, CRM, B2B wholesale |

---

## 3. Layered Architecture

```
╔══════════════════════════════════════════════════════════════════════════════╗
║  PRESENTATION LAYER                                                          ║
║                                                                              ║
║  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────────────┐  ║
║  │  Web PWA │ │  Mobile  │ │ SmartPOS │ │  Admin   │ │   Super Admin    │  ║
║  │(Chromium)│ │(Responsive│ │(pos.html)│ │(admin-os)│ │(super-admin.html)│  ║
║  └────┬─────┘ └────┬─────┘ └────┬─────┘ └────┬─────┘ └────────┬─────────┘  ║
╚═══════╪══════════════╪══════════════╪══════════════╪═══════════════╪══════════╝
        │              │              │              │               │
        │  Firebase SDK (Firestore listener, Auth, Functions, Storage)
        │              │              │              │               │
╔═══════╪══════════════╪══════════════╪══════════════╪═══════════════╪══════════╗
║  API LAYER                                                                   ║
║                                                                              ║
║  ┌─────────────────────┐  ┌─────────────────┐  ┌──────────────────────────┐ ║
║  │  Callable Functions │  │   HTTP Functions │  │   Firestore Triggers     │ ║
║  │  (enforceAppCheck)  │  │   (Webhooks,     │  │   (onCreated/Updated)    │ ║
║  │  Auth-gated         │  │    Public APIs)  │  │   event-driven reactions │ ║
║  └──────────┬──────────┘  └────────┬─────────┘  └───────────┬──────────────┘ ║
║             │                      │                         │               ║
║  ┌──────────▼──────────────────────▼─────────────────────────▼─────────────┐ ║
║  │  MIDDLEWARE: Auth guard │ Rate limiter │ Input validation │ App Check    │ ║
║  └──────────────────────────────────────────────────────────────────────────┘ ║
╚═══════════════════════════════════════════════════════════════════════════════╝
        │
╔═══════▼═══════════════════════════════════════════════════════════════════════╗
║  APPLICATION LAYER — Business Engines                                        ║
║                                                                              ║
║  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐ ║
║  │ Order Engine │  │Payment Engine│  │Delivery Engine│  │Inventory Engine  │ ║
║  └──────────────┘  └──────────────┘  └──────────────┘  └──────────────────┘ ║
║  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐ ║
║  │   AI Engine  │  │ Notif Engine │  │   POS Engine │  │Foundation Engine │ ║
║  └──────────────┘  └──────────────┘  └──────────────┘  └──────────────────┘ ║
║                                                                              ║
║  ┌──────────────────────────────────────────────────────────────────────────┐ ║
║  │  PLATFORM EVENT BUS  (platform-event-bus.js)                             │ ║
║  │  Publish → Fan-out → Subscribe → Deliver → Dead-letter → Retry          │ ║
║  └──────────────────────────────────────────────────────────────────────────┘ ║
╚═══════════════════════════════════════════════════════════════════════════════╝
        │                            │
╔═══════▼════════════╗    ╔══════════▼═══════════════════════════════════════╗
║  REDIS — FAST LAYER ║    ║  INFRASTRUCTURE LAYER                           ║
║  (operational state) ║    ║                                                 ║
║  • Live POS sync    ║    ║  ┌─────────────────────────────────────────┐    ║
║  • Active sessions  ║    ║  │  Firestore (source of truth)             │    ║
║  • Presence/locks   ║    ║  │  Cloud Storage  │  Firebase Auth          │    ║
║  • Rate limiting    ║    ║  │  Algolia        │  Typesense               │    ║
║  • Job queues       ║    ║  │  Secret Manager │  Cloud Scheduler         │    ║
║  • Dashboard counters║   ║  │  Cloud Logging  │  Cloud Monitoring        │    ║
║  • Search/AI cache  ║    ║  └─────────────────────────────────────────┘    ║
║  Graceful fallback  ║    ╚══════════════════════════════════════════════════╝
╚═════════════════════╝
```

### Layer Responsibilities

| Layer | Owns | Does Not Own |
|---|---|---|
| Presentation | UI state, local form validation, UX flow | Business rules, data persistence |
| API | Authentication, authorisation, rate limiting, input validation, routing | Business logic |
| Application | Business rules, state transitions, event publishing | Data storage, presentation |
| Event Bus | Event routing, fan-out, delivery guarantees, dead-letter | Business logic of subscribers |
| Redis | Ephemeral operational state, coordination | Permanent records |
| Infrastructure | Durable storage, auth, compute | Application concerns |

---

## 4. Application Layer — Core Engines

Each engine is a self-contained set of Cloud Functions with a stable external interface. Engines communicate exclusively via the event bus or direct CF calls — never by sharing Firestore collections directly without a defined contract.

### 4.1 Order Engine

**Files:** `functions/orders.js`, `functions/order-lifecycle.js`  
**Collections:** `orders`, `orderItems`, `orderHistory`

Responsibilities:
- Accept new orders from marketplace, POS, and B2B channels
- Validate: product existence, stock availability, pricing integrity, seller status
- Assign order numbers (sequential, human-readable: `ORD-240706-00123`)
- Manage order status lifecycle: `draft → confirmed → processing → packed → shipped → delivered → completed`
- Publish `order.*` events on every state transition
- Support multi-seller orders (split into sub-orders per seller)
- Calculate and record applicable commissions via Commission Engine

Order state machine:
```
draft
  └─► confirmed ──► processing ──► packed ──► shipped ──► delivered ──► completed
  │       │             │            │
  └───────┴─────────────┴────────────┴──────────────────────────────► cancelled
                                                                           │
                                                                        refunded
```

### 4.2 Payment Engine

**Files:** `functions/payment-orchestrator.js`  
**Collections:** `payments`, `paymentHistory`, `paymentIdempotency`

Responsibilities:
- Provide a single entry point for all payment methods
- Enforce idempotency: reject duplicate payment attempts for the same order
- Manage the payment state machine with validated transitions
- Support: M-Pesa (IntaSend STK), Cards (IntaSend), Wallet (internal), Bank Transfer (future), QR (SmartPOS)
- Publish `payment.*` events on every state transition
- Never trust client-side payment confirmation
- Timeout detection: auto-fail payments stuck in `processing` for >30 minutes

Payment state machine:
```
created ──► pending ──► processing ──► succeeded
                │             │
                └─────────────┴──────────────────► failed ──► refunded
                              │
                              └──────────────────► cancelled
```

Every state transition:
1. Validated against `ALLOWED_TRANSITIONS` map (illegal jumps throw `FailedPrecondition`)
2. Appends to `history[]` with `actor`, `timestamp`, `reason`
3. Publishes `payment.transaction.{state}` platform event
4. Is idempotent: same transition twice is a no-op, not an error

### 4.3 Delivery Engine

**Files:** `functions/delivery.js`, `functions/sokoni-navigation.js`  
**Collections:** `deliveries`, `riders`, `dispatchQueue`

Responsibilities:
- Accept delivery requests from orders
- Match orders to available, nearby riders (8-factor dispatch scoring)
- Track delivery state: `queued → assigned → picked_up → in_transit → delivered`
- GPS tracking with spoofing detection
- Automated driver suspension on excessive cancellations (≥10 auto-suspend)
- QR code verification on pickup and delivery
- Customer signature capture
- CSAT (customer satisfaction) collection on delivery completion
- Publish `delivery.*` events on state changes

### 4.4 Inventory Engine

**Files:** `functions/inventory.js`, `functions/pos-inventory.js`  
**Collections:** `products`, `inventory`, `inventoryHistory`, `stockAlerts`

Responsibilities:
- Maintain authoritative stock counts in Firestore
- Redis provides real-time reservation locks (15-minute TTL per order, 2-minute TTL per checkout)
- FEFO (First Expired, First Out) batch tracking for perishables
- AVCO (Average Cost) inventory valuation
- Low-stock alerts (threshold-based, published as `inventory.stock.low` events)
- Automatic sync between Marketplace and SmartPOS inventory
- Audit trail for every stock movement

Inventory reservation pattern:
```
Checkout begins
  └─► Redis InventoryService.lock(productId, variantId, qty, lockId, 120_000ms)
         │
         ▼
   Payment succeeds
         │
         ├─► Firestore: decrement product.stockQty (authoritative)
         └─► Redis: release lock (cleanup)

   Payment fails / timeout
         └─► Redis: lock expires automatically (no cleanup needed)
```

### 4.5 AI Engine

**Files:** `functions/ai-engine.js`, `sokoni-creative.js`  
**Collections:** `aiJobs`, `aiSessions`, `mediaAssets`, `brandKits`

Responsibilities:
- KASS AI Concierge: contextual commerce assistance using Claude claude-haiku-4-5-20251001 with Firestore tool use
- AI Subscriptions: 4 tiers (Free → Enterprise) with credit/boost system
- Creative Studio: AI-generated product descriptions, marketing copy, image captions
- AI response caching: expensive Anthropic calls cached in Redis for 1 hour
- PII redaction before caching (KRA PIN, phone, email, card numbers)
- Queue-backed AI jobs via `QueueService.push('ai', job)` for background processing

Model selection:
| Use case | Model | Rationale |
|---|---|---|
| KASS conversational | `claude-haiku-4-5-20251001` | Fast, low-cost for real-time chat |
| Business insights | `claude-sonnet-4-6` | Better reasoning for analytics summaries |
| Document generation | `claude-sonnet-4-6` | Long-form quality |

### 4.6 Notification Engine

**Files:** `functions/notifications.js`, `sokoni-notif-engine.js`  
**Collections:** `notifications`, `notificationQueue`, `notificationPreferences`

Responsibilities:
- 5 priority tiers: `urgent`, `high`, `normal`, `low`, `silent`
- 20 notification categories with per-category DND settings
- Multi-channel dispatch: FCM push, SMS (Africa's Talking), email (SendGrid)
- Redis queue with batch processing: `QueueService.push('notification', job)`
- Token lifecycle: invalid FCM tokens auto-removed on send failure
- Template system: 53 email templates, dynamic variable substitution

Queue architecture:
```
Event published (e.g. order.order.created)
        │
        ▼
Notification Engine subscribes to event
        │
        ▼
Creates notification records in Firestore
        │
        ▼
Pushes to Redis notification queue (priority-aware)
        │
        ▼
redisScheduledQueueWorker dispatches every minute
        │
        ├─► FCM (admin.messaging) for push
        ├─► Africa's Talking for SMS
        └─► SendGrid for email
```

### 4.7 POS Engine

**Files:** `functions/pos.js`, `functions/pos-peripherals.js`, `pos.html`  
**Collections:** `posSessions`, `posTransactions`, `merchants/posPeripherals`

See [[#6-smartpos-ecosystem]] for full specification.

### 4.8 Foundation Engine

**Files:** `functions/foundation.js`  
**Collections:** `foundationCampaigns`, `donations`, `foundationDisbursements`, `foundationLedger`

Responsibilities:
- Accept donations with optional anonymity
- Three-tier disbursement model: immediate, scheduled, campaign-end
- Separate ledger (never commingled with marketplace revenue)
- Impact reporting and transparency dashboard
- Foundation donation receipts for donors
- Publish `foundation.donation.received` events

### 4.9 Commission Engine

**Files:** `functions/commission.js`  
**Collections:** `commissionRules`, `commissionLedger`, `sellerEarnings`

Responsibilities:
- 6 rule types: `percentage`, `fixed`, `percentage_plus_fixed`, `tiered`, `commission_holiday`, `custom`
- Live preview before rule activation
- Per-seller, per-category, per-product rule scoping
- Double-entry ledger: every commission creates matching debit/credit entries
- Automatic calculation triggered by `payment.transaction.completed` events
- Seller earnings reports with hub-level breakdown

---

## 5. Event-Driven Architecture

### 5.1 Why Events

Tight coupling is the primary cause of platform brittleness. If the Order Engine calls the Notification Engine directly, then:
- Notification failures abort order creation
- Orders cannot be processed if Notifications is deployed
- Adding a new subscriber (e.g. Loyalty Engine) requires modifying Orders

The event bus inverts this: Order Engine publishes one event. Any number of modules subscribe independently. Adding a new subscriber requires zero changes to Order Engine.

### 5.2 Platform Event Bus

**File:** `functions/platform-event-bus.js`  
**Collection:** `platformEvents/{eventId}`

#### Event Schema

```javascript
{
  id:            string,   // auto-generated
  type:          string,   // domain.noun.verb (lowercase, past tense)
  version:       string,   // '1.0' (semver for schema evolution)
  payload:       object,   // event-specific data
  publishedAt:   Timestamp,
  publishedBy:   string,   // uid or service identifier
  correlationId: string,   // business flow trace ID (e.g. orderId)
  status:        'pending' | 'processing' | 'delivered' | 'dead_letter',
  retries:       number,   // 0–3
  subscribers:   string[], // [subscriberId, ...]
  deliveredTo:   string[], // subscribers that have processed
}
```

#### Naming Convention

```
domain.noun.verb   (all lowercase, past tense)

order.order.created
order.order.completed
order.order.cancelled

payment.transaction.completed
payment.transaction.failed
payment.transaction.refunded

delivery.rider.assigned
delivery.delivery.started
delivery.delivery.completed

inventory.stock.updated
inventory.stock.depleted
inventory.stock.replenished

pos.session.opened
pos.session.closed
pos.cart.updated
pos.payment.completed

foundation.donation.received
foundation.disbursement.completed

product.product.published
product.product.delisted
product.review.added

user.user.registered
user.seller.approved

notification.notification.sent
notification.notification.failed
```

#### Event Lifecycle

```
publishEvent(type, payload, correlationId)
      │
      ▼
Stored in platformEvents/{id}  (status: pending)
      │
      ▼
deliverEvent(eventId)  — looks up eventSubscribers
      │
      ├─► forEach subscriber: HTTP POST to subscriber endpoint
      │   │
      │   ├─► 200 OK → mark subscriber delivered
      │   │
      │   └─► Error → increment retries
      │         │
      │         ├─► retries < 3 → re-queue with backoff
      │         └─► retries ≥ 3 → status = dead_letter
      │
      ▼
All subscribers delivered → status = delivered
```

#### Dead Letter Recovery

Dead-letter events are visible in the Operations Center. Recovery options:
1. **Auto-replay**: `selfHeal.replayDeadEvents()` — resets status to `pending`
2. **Manual replay**: Admin triggers `replay_dead_events` action from ops-center.html
3. **Threshold trigger**: If `dead_letter > 100`, `snapshotPlatformMetrics` (5-min scheduler) auto-replays

### 5.3 Canonical Event Catalog

| Event | Published By | Key Subscribers |
|---|---|---|
| `order.order.created` | Order Engine | Notification, Inventory (lock), Payment |
| `order.order.completed` | Order Engine | Commission, Loyalty, Notification, Foundation |
| `order.order.cancelled` | Order Engine | Inventory (release), Notification, Payment (refund trigger) |
| `payment.transaction.completed` | Payment Engine | Order (status update), Commission, Loyalty, Notification, Redis (state sync) |
| `payment.transaction.failed` | Payment Engine | Order (status update), Notification |
| `delivery.rider.assigned` | Delivery Engine | Notification (buyer + rider), POS (update) |
| `delivery.delivery.completed` | Delivery Engine | Order (complete), Payment (release escrow), Notification, CSAT |
| `inventory.stock.depleted` | Inventory Engine | Notification (seller), Search (mark unavailable) |
| `pos.session.opened` | POS Engine | Presence (Redis), Notification (manager) |
| `pos.payment.completed` | POS Engine | Inventory (deduct), Commission, Loyalty, Receipt queue |
| `foundation.donation.received` | Foundation Engine | Notification, Foundation ledger, eTIMS |
| `user.seller.approved` | Auth/Admin Engine | Notification (welcome), Subscription (start trial) |

### 5.4 Event Bus vs Redis Streams

Both systems handle events; they serve different purposes:

| Dimension | Platform Event Bus (Firestore) | Redis Streams |
|---|---|---|
| Durability | Permanent (Firestore) | Ephemeral (TTL ring buffer) |
| Purpose | Business event audit trail | Operational real-time feed |
| Subscriber model | Registered subscribers | Polling-based |
| Recovery | Manual/auto replay | Not expected to replay |
| Examples | Order created, payment completed | POS cart updated, rider location |
| Retention | Forever | Max 10,000 entries |

Use Firestore event bus for business events that must not be lost. Use Redis streams for real-time operational signals where a missed event is acceptable.

---

## 6. SmartPOS Ecosystem

### 6.1 Architecture Principles

SmartPOS is a real-time distributed system, not a local application. Every device (cashier terminal, manager tablet, employee phone, customer display) connects to the same session state stored in Firestore, with Redis providing sub-second synchronisation between polling intervals.

**Key constraint:** Every POS operation that affects money or stock must go through a Cloud Function, never client-side only. Client devices are input surfaces; Cloud Functions are the source of truth.

### 6.2 Session Model

```
posSessions/{sessionId}
│
├─ devices: { [deviceId]: { uid, name, role, lastSeen } }
│
├─ cart: { [productId:variantId]: { name, price, qty, discount } }
│
├─ memberUids: string[]          ← Firestore rules use this for access control
│
├─ cartTotal, cartTax, cartSubtotal, cartDiscount
│
├─ status: 'open' | 'payment' | 'closed'
│
├─ sessionCode: '123456'         ← 6-digit easy-join code
│
└─ shiftId, cashierId, merchantId, branchId
```

All cart mutations go through `updatePosCart` — a transactional CF that prevents concurrent-write conflicts.

### 6.3 Multi-Device Synchronisation

```
┌─────────────────────────────────────────────────────────────┐
│              Synchronisation Stack                           │
│                                                              │
│  Layer 1: Firestore onSnapshot (< 100ms, push)              │
│  ─────────────────────────────────────────────              │
│  Firestore listener on posSessions/{id} fires on every      │
│  change. All connected devices receive updates              │
│  simultaneously without polling.                            │
│                                                              │
│  Layer 2: Redis POSService (< 10ms, pull 500ms)             │
│  ─────────────────────────────────────────────              │
│  Redis stores a denormalised copy of cart state.            │
│  Customer display polls at 500ms interval.                  │
│  Manager tablet polls shop-wide at 1000ms.                  │
│  JSON hash diff suppresses no-op callbacks.                 │
│                                                              │
│  Layer 3: BroadcastChannel (< 1ms, same-device tabs)        │
│  ─────────────────────────────────────────────              │
│  When multiple tabs open on the same device, the            │
│  customer display SDK uses BroadcastChannel for             │
│  zero-latency same-origin messaging.                        │
│                                                              │
│  Layer 4: Offline IndexedDB queue                           │
│  ─────────────────────────────────────────────              │
│  When offline: cart ops queue in IndexedDB.                 │
│  On reconnect: flush queue through auth'd CF calls.         │
└─────────────────────────────────────────────────────────────┘
```

### 6.4 Universal Peripheral Hub

**File:** `sokoni-device-hub.js`  
**Singleton:** `window.SokoniDeviceHub`

The peripheral hub provides a unified API across four transport protocols. Application code calls `hub.connect(deviceId)` without knowing whether the device is USB, Bluetooth, Serial, or network-attached.

```
SokoniDeviceHub
  │
  ├─ UsbAdapter     (WebUSB API)
  │    └─ USB_VID_MAP: 20+ vendor/device-type pairs
  │
  ├─ BluetoothAdapter (Web Bluetooth API)
  │    └─ BT_SERVICE_MAP: 6 GATT service UUIDs → device type
  │
  ├─ SerialAdapter   (Web Serial API)
  │    └─ Baud rate negotiation, flow control
  │
  └─ NetworkAdapter  (TCP/HTTP)
       └─ Persisted in localStorage; auto-reconnect on startup

Device types: printer | scanner | payment_terminal | cash_drawer |
              customer_display | weight_scale | label_printer | card_reader

Events: connected | disconnected | discovered | error | health_change
```

Reconnect strategy: exponential backoff — `Math.min(3000 × 2^attempt, 60000)ms`, max 8 attempts.

### 6.5 Universal Payment Terminal

**File:** `sokoni-payment-terminal.js`  
**Singleton:** `window.SokoniTerminal`

Twelve terminal drivers behind one interface:

```
SokoniTerminalManager.charge(request)
  │
  ├─ IntaSendDriver     M-Pesa STK push; polls /api/payments/mpesa/status 3s×30 (90s timeout)
  ├─ StripeDriver       Stripe Terminal SDK; collectPaymentMethod → processPayment
  ├─ PaxDriver          POSLINK HTTP; GET ?command=T00&TransType=01&Amount=…
  ├─ IngenicoDriver     HTTP + JSON; vendor-specific auth header
  ├─ VerifoneDriver     VHQ protocol over TCP
  ├─ CastlesDriver      USB HID + network dual-mode
  ├─ NewlandDriver      Network API
  ├─ SunmiDriver        Network API (Sunmi Cloud)
  ├─ NexgoDriver        NexGo cloud + network
  ├─ BBPOSDriver        Bluetooth GATT
  ├─ MiuraDriver        Bluetooth + USB
  └─ VirtualDriver      Configurable auto-approve (demo / testing)
```

Adding a new vendor: implement the `BaseTerminalDriver` interface (`connect`, `charge`, `refund`, `status`, `disconnect`) and call `SokoniTerminal.register(name, vendorId, config)`. Zero changes to any existing code.

### 6.6 Customer Display

**Files:** `sokoni-customer-display.js`, `customer-display.html`

The customer display is a separate browser window (or second screen) that mirrors the active cart in real time.

Communication channels (priority order):
1. `BroadcastChannel` — same-device tabs, < 1ms
2. `window.postMessage` — cross-origin iframes
3. Firestore `posCustomerDisplays` — cross-device

Display screens: `idle` | `cart` | `payment` | `approved` | `declined` | `promo` | `branding`

60-second idle timer returns to branding screen automatically.

### 6.7 Peripheral Cloud Functions

**File:** `functions/pos-peripherals.js`

| Function | Purpose |
|---|---|
| `posRegisterPeripheral` | Register a device to a merchant with ownership validation |
| `posUpdatePeripheralStatus` | Heartbeat / health report from device |
| `posRemovePeripheral` | Remove device; emits TTL-gated `force_disconnect` signal |
| `posGetPeripherals` | List devices; strips `apiKey`, `token`, `secret`, `password` from config |
| `posCreateCustomerDisplay` | Create/reset display session document |
| `posUpdateCustomerDisplay` | Update display state; 32 KB payload guard |
| `posCleanupPeripheralSignals` | TTL cleanup trigger (auto-fires on write) |

---

## 7. Payment Orchestration

### 7.1 Design Goals

One payment function. One state machine. One audit trail. No payment method should have a private flow that bypasses the orchestrator.

**Anti-patterns this architecture eliminates:**
- Payment confirmed client-side before server-side verification
- Duplicate STK pushes (idempotency key enforced per order)
- Silent payment failures (every terminal state emits an event)
- Orphaned pending payments (timeout sweep auto-fails after 30 minutes)

### 7.2 Full Lifecycle

```
Client: initiateCheckout(cart, paymentMethod)
        │
        ▼
CF: createPayment(orderId, amount, method)
    ├─ Validate: amount, currency, ownership, duplicate guard
    ├─ Acquire Redis payment lock (prevents race condition)
    ├─ Create payments/{paymentId} with status: 'created'
    ├─ Publish payment.transaction.created event
    └─ Return paymentId

CF: initiatePayment(paymentId, phone?)
    ├─ Validate state transition: created → pending
    ├─ Dispatch to provider driver (M-Pesa, Card, Wallet)
    ├─ Update status: pending → processing
    ├─ Publish payment.transaction.processing event
    └─ Return provider reference (checkoutUrl, stkRef, etc.)

Provider callback / polling:
    ├─ IntaSend webhook / client poll → confirmPayment(paymentId, ref)
    ├─ CF validates provider response (HMAC / direct API verification)
    ├─ Update: processing → succeeded | failed
    └─ Publish payment.transaction.completed | .failed event

Background: paymentTimeoutSweep (every 5 min)
    └─ Payments stuck in processing > 30 min → failed
       └─ Publish payment.transaction.failed event
```

### 7.3 Provider Drivers

Each provider is encapsulated in `payment-orchestrator.js`:

| Provider | Mechanism | Verification |
|---|---|---|
| M-Pesa (IntaSend STK) | STK push to phone | Poll IntaSend API; verify status=COMPLETE |
| Cards (IntaSend) | Hosted checkout URL | IntaSend webhook callback + HMAC |
| Wallet | Internal Firestore transaction | Atomic balance check + deduction |
| QR (POS) | Generate payment QR | Firestore listener; signed QR (HMAC) |

### 7.4 Idempotency

The `paymentIdempotency` collection prevents duplicate charges:
```
paymentIdempotency/{orderId_method_amount_hash}
  └─ createdAt: Timestamp (TTL: 24h)
```

If a create request arrives with a matching key, the existing `paymentId` is returned — no new payment is created.

---

## 8. Redis Operational Layer

Redis accelerates SOKONI but is not required for correctness. See [[REDIS_ARCHITECTURE]] for full specification.

### Summary: What Redis Manages

| Category | Examples | TTL |
|---|---|---|
| **Coordination** | Payment locks, inventory reservations, distributed locks | 15–120 seconds |
| **Sessions** | Active user sessions (complement Firebase Auth) | 24 hours |
| **Presence** | Online POS terminals, active riders, online users | 90 seconds |
| **POS sync** | Live cart state per terminal | 1 hour |
| **Dashboards** | Revenue today, orders today, payments today | 60 seconds |
| **Queues** | Email, notification, SMS, AI, receipt, report, bulk | Processed within 1 minute |
| **Event streams** | orders, payments, inventory, users, riders, delivery | Max 10,000 entries |
| **Cache** | Search results, AI responses, session data | 5 min – 1 hour |
| **Rate limits** | Per-UID and per-IP counters per action | 60s – 1 hour |

### Summary: What Redis Never Manages

Orders, payments, inventory history, customer data, seller profiles, financial records, audit logs, product catalogs. These live exclusively in Firestore.

### Fallback Guarantee

When Redis is unavailable, `isFallback()` returns `true` and every service returns a safe default. Critical flows (orders, payments, checkouts) continue via Firestore. The platform degrades in speed — never in correctness.

---

## 9. Observability and Operations Center

### 9.1 Operations Center

**File:** `functions/operations-center.js`  
**UI:** `ops-center.html`

The Operations Center is the single pane of glass for the SOKONI platform. It surfaces the health of every major subsystem in real time.

```
ops-center.html
│
├─ Orders          active / pending / stuck
├─ Payments        today total / failed 24h / stuck >5m
├─ POS Sessions    open count / device count / recent transactions
├─ Event Bus       pending / dead-letter count / delivery rate
├─ Redis           connection / memory / hit rate / queue depths
├─ Search          Typesense / Algolia connection / index health
├─ Deliveries      in-transit / overdue / rider availability
├─ Notifications   queued / sent / failed / delivery rates by channel
├─ Foundation      donations today / disbursement queue
├─ AI Engine       request count / cache hit rate / spend today
├─ Users           online last 5m / new today / auth failures
└─ Infrastructure  CF error rate / P95 latency / memory / CPU
```

### 9.2 Redis Monitor

**File:** `redis-monitor.html` (Super Admin only)

13-panel real-time dashboard at 15-second auto-refresh:
- KPI row: memory %, hit rate, ops/sec, active sessions
- Connection: uptime, connected clients, total commands, hits/misses
- Memory: used, peak, system total, fragmentation ratio, evictions
- Platform totals: sessions, POS terminals, active locks, queued jobs, online presence
- Queue depths: 8 queues with bar charts
- Event stream lengths: 8 streams
- POS terminal map: per-terminal cart state cards
- Online presence grid
- Active lock details
- Rate limit violations log
- Job audit log (from Firestore `redisJobAudit`)
- Slowlog
- Error log

### 9.3 Metric Collection

`snapshotPlatformMetrics` (Cloud Scheduler, every 5 minutes):
- Reads operational state from Firestore collections
- Writes `opsMetrics/{timestamp}` snapshot (7-day retention)
- Triggers self-healing checks (see §10)

### 9.4 Cloud Monitoring Alerts

19 configured alerts:

| Alert | Severity | Threshold |
|---|---|---|
| CF error rate | CRITICAL | > 2% |
| CF P95 latency | WARNING | > 3s |
| Payment failure rate | CRITICAL | > 5% |
| Payment stuck | WARNING | > 5 stuck payments |
| Memory > 85% | WARNING | — |
| Redis connection loss | CRITICAL | Any disconnection |
| Redis memory > 80% | WARNING | — |
| Dead-letter events | WARNING | > 100 |
| Order stuck | WARNING | > 10 orders in processing for > 30m |
| Auth failure spike | WARNING | > 50 failures in 5m |
| Health endpoint down | CRITICAL | Any failure |
| Queue depth > 1000 | WARNING | Per queue |
| Stock depleted | INFO | Per product |
| POS session errors | WARNING | > 5 errors |
| Delivery overdue | WARNING | > 10 overdue |
| API rate limit violations | INFO | > 100/min |
| Search index lag | WARNING | > 5m behind |
| Disk > 80% (Memorystore) | WARNING | — |
| Cold start > 2s | INFO | — |

### 9.5 Structured Logging Convention

All Cloud Functions use structured JSON logs:

```javascript
console.log(JSON.stringify({
  severity: 'INFO',          // INFO | WARNING | ERROR | CRITICAL
  message:  '[engine] description',
  // Context fields
  orderId, paymentId, userId, shopId,
  // Performance
  durationMs: Date.now() - start,
  // Never include
  // password, token, apiKey, cardNumber, phone (unless last 4 digits)
}));
```

Log fields are queryable in Cloud Logging with structured filters.

---

## 10. Self-Healing Architecture

The platform is designed to recover automatically from the most common failure modes without human intervention.

### 10.1 Recovery Map

| Failure | Detection | Auto-Recovery | Manual Escalation |
|---|---|---|---|
| Redis unavailable | `isFallback()` check | Immediate Firestore fallback; ioredis reconnect backoff | If > 1 hour: check VPC connector, Redis instance status |
| Stuck payment (> 30m in processing) | `paymentTimeoutSweep` (every 5m) | Auto-fail → `payment.transaction.failed` event | If recurrent: investigate provider webhook delivery |
| Dead-letter event (> 3 retries) | `snapshotPlatformMetrics` (every 5m) | Auto-replay if count > 100 | If > 1000: investigate subscriber endpoint health |
| Stale POS session (idle > 24h) | `posSessionCleanup` (every 6h) | Auto-close session + notify devices | — |
| Failed queue job (> 3 retries) | Queue worker counts `_retries` | Write to `redisJobDeadLetter` Firestore collection | Review dead-letter, fix root cause, re-enqueue |
| Offline POS device | Client-side: `window offline` event | Queue ops to IndexedDB; flush on reconnect | If > 1 hour offline: alert manager |
| Lost rider connection | `PresenceService.remove('rider', id)` on TTL expiry | Mark rider unavailable; re-dispatch if active delivery | Ops team contacts rider |
| Cloud Function cold start spike | Cloud Monitoring alert | Auto-scaled by GCP | Min instances 1 for critical functions |
| Inventory lock orphan | TTL auto-expiry (2 minutes) | Lock released automatically | — |
| Payment lock orphan | TTL auto-expiry (30 seconds) | Lock released automatically | — |
| Search index out of sync | `recordHealthSnapshot` alert | Re-index trigger from Firestore trigger | If persistent: full re-sync script |

### 10.2 Self-Healing Cloud Functions

`runScheduledSelfHeal` (every 15 minutes):

```
1. retryStuckPayments
   └─ Query: payments where status IN ('pending','processing')
             AND updatedAt < now - 30m
   └─ Action: status → 'failed', publish event

2. replayDeadEvents
   └─ Query: platformEvents where status = 'dead_letter' LIMIT 50
   └─ Action: status → 'pending', retries → 0

3. closeStaleSessions
   └─ Query: posSessions where status = 'open'
             AND updatedAt < now - 24h
   └─ Action: status → 'closed', notify member devices

4. releaseOrphanedLocks
   └─ Redis: scan sokoni:lock:* → check TTL
   └─ Action: locks with TTL < 0 are already expired (ioredis handles this)

5. reconcileInventory
   └─ Query: products where pendingReconciliation = true
   └─ Action: recalculate stockQty from inventory history, clear flag
```

### 10.3 Offline POS Recovery

```
Device loses connectivity
        │
        ▼
POS cart operations → IndexedDB queue (sokoni_offline DB)
Status indicators: "Offline mode — changes will sync when reconnected"
        │
        ▼
Network returns → window.online event
        │
        ▼
SokoniRedis.connectivity.enableAutoFlush() triggers
        │
        ▼
SokoniRedis.offline.flush() replays queued operations
  ├── pos_cart_sync → redisPosSetState CF
  ├── order         → DashboardService.incr
  └── payment       → PaymentService.setState
        │
        ▼
IndexedDB items marked 'synced'
Manager console shows: "X operations synced successfully"
```

---

## 11. Data Architecture

### 11.1 Collection Hierarchy

```
Firestore Root
│
├─ users/{uid}                    User profiles, roles, preferences
│  └─ fcmTokens/{tokenId}         FCM push tokens
│
├─ sellers/{sellerId}             Seller profiles, bank details, KYC status
│
├─ products/{productId}           Product catalog
│  └─ variants/{variantId}        Product variants (size, colour)
│
├─ orders/{orderId}               All marketplace orders
│  └─ items/{itemId}              Line items
│
├─ payments/{paymentId}           Full payment lifecycle
│  └─ history/{txId}              State machine transition log
│
├─ paymentIdempotency/{key}       Duplicate prevention (24h TTL)
│
├─ deliveries/{deliveryId}        Delivery records
│  └─ trackingPoints/{pointId}    GPS breadcrumbs
│
├─ riders/{riderId}               Rider profiles + status
│
├─ platformEvents/{eventId}       Platform event bus log
├─ eventSubscribers/{id}          Event bus subscriber registry
│
├─ posSessions/{sessionId}        SmartPOS multi-device sessions
├─ posTransactions/{txId}         POS transaction records
│
├─ merchants/{merchantId}         Merchant profiles
│  └─ posPeripherals/{deviceId}   Registered POS peripherals
│  └─ posAudit/{entryId}          POS audit log
│
├─ notifications/{notifId}        Notification records
├─ platformEvents/{eventId}       Event bus
│
├─ commissionRules/{ruleId}       Commission configuration
├─ commissionLedger/{entryId}     Double-entry commission records
│
├─ inventory/{productId}          Authoritative inventory records
│  └─ movements/{movId}           Stock movement history
│
├─ foundationCampaigns/{id}       Foundation campaigns
├─ donations/{donationId}         Donation records
├─ foundationLedger/{entryId}     Foundation financial records
│
├─ opsMetrics/{timestamp}         5-minute platform metric snapshots
├─ selfHealLog/{logId}            Self-healing action audit trail
│
├─ redisJobAudit/{jobId}          Queue worker job audit log
├─ redisJobDeadLetter/{jobId}     Failed jobs after max retries
│
├─ aiJobs/{jobId}                 Background AI job results
├─ aiSessions/{sessionId}         KASS conversation context
│
├─ _migrations/{migrationId}      Migration state tracking
└─ _health/{checkId}              Health check records
```

### 11.2 Data Partitioning Strategy

Firestore collections are designed to avoid hot spots:

- **Orders:** stored flat in `orders/` collection; shopId and buyerId are indexed for queries. No subcollection under seller or buyer (avoids document size growth).
- **Inventory movements:** subcollection under product to keep movements co-located with product.
- **POS audit:** subcollection under merchant, not a root collection, since it is always queried per merchant.
- **Notifications:** flat root collection; queryable by uid + createdAt index.

### 11.3 Firestore Index Architecture

- 197+ composite indexes (approaching 200/200 limit)
- When limit is reached: use `sokoni-ops` second Firestore database for new indexes
- Never drop existing indexes: `feedback_index_management.md`
- Index candidates for second DB: high-cardinality analytical queries (BI, reporting)

### 11.4 Data Ownership Rules

| Data Type | Firestore | Redis | Cloud Storage |
|---|---|---|---|
| Orders (permanent) | ✓ authoritative | ✗ | ✗ |
| Payment records | ✓ authoritative | ✗ | ✗ |
| Customer PII | ✓ authoritative | ✗ never | ✗ |
| Product catalog | ✓ authoritative | cache TTL | ✗ |
| Active cart | ✓ posSessions | ✓ sync copy | ✗ |
| Session token | ✓ reference | ✓ operational | ✗ |
| Receipt PDF | ✗ | ✗ | ✓ |
| Product images | ✗ reference | ✗ | ✓ |
| AI-generated content | ✓ aiJobs | ✓ cache 1h | ✓ |
| Search index | ✗ | ✗ | Algolia/Typesense |

---

## 12. Security Architecture

### 12.1 Defence Layers

```
Request ──► Firebase App Check ──► Firebase Auth ──► CF Auth guard
              (attestation)         (identity)         (claims check)
                  │                     │                   │
                  ▼                     ▼                   ▼
           Reject bots          Identify user         Verify role
                                                      (ABAC claims)
                                                           │
                                                           ▼
                                                    Rate limit check
                                                    (Redis / own guard)
                                                           │
                                                           ▼
                                                    Input validation
                                                    (sanitise all fields)
                                                           │
                                                           ▼
                                                    Business logic
                                                           │
                                                           ▼
                                                    Audit log write
                                                    (securityAuditLog)
```

### 12.2 Role-Based Access Control

8 roles with claim-based enforcement:

| Role | Claims | Firestore Rules Access |
|---|---|---|
| Guest | (none) | Public product reads only |
| Buyer | `buyer: true` | Own orders, own payments, own profile |
| Seller | `seller: true` | Own products, own shop orders, own sessions |
| Service Provider | `provider: true` | Own listings, own bookings |
| Driver/Rider | `rider: true` | Assigned deliveries, own rider profile |
| Business Owner | `owner: true` | All merchant data, POS sessions |
| Admin | `admin: true` | Platform-wide read + moderated writes |
| Super Admin | `superAdmin: true` | Full access + security operations |

Claims set by Cloud Functions via `admin.auth().setCustomUserClaims()` — never by clients.

### 12.3 Payment Security

- Idempotency key on every payment attempt
- HMAC signing on QR-based POS payments
- IntaSend webhook HMAC verification before payment state update
- Redis payment lock (NX) prevents double-charge race conditions
- Client-side payment confirmation never trusted: always verify via Cloud Function + provider API
- Payments stuck in `processing` for > 30 minutes are auto-failed

### 12.4 Secret Management

All secrets in Google Secret Manager. No secrets in code, `.env` files committed to git, or Cloud Logging:

| Secret | Usage |
|---|---|
| `INTASEND_PRIVATE_KEY` | M-Pesa / Card payment provider |
| `QR_SIGNING_SECRET` / `SOKONI_HMAC_KEY` | POS QR HMAC |
| `SENDGRID_API_KEY` | Email delivery |
| `REDIS_URL` | Redis connection (optional) |
| `ANTHROPIC_API_KEY` | AI engine |
| `AT_API_KEY` / `AT_USERNAME` | Africa's Talking SMS |
| `LOYALTY_HMAC_SECRET` | Offline loyalty sync |
| `PAYMENT_HMAC_SECRET` | Payment integrity |
| `PAYROLL_ENCRYPTION_KEY` | Payroll data at rest |
| `ALGOLIA_ADMIN_KEY` | Search index admin |

### 12.5 XSS Prevention

All dynamic DOM insertion uses explicit escaping:
```javascript
function _esc(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;')
                      .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
// Never: element.innerHTML = userValue;
// Always: element.innerHTML = _esc(userValue); or element.textContent = userValue;
```

### 12.6 Firestore Security Rules

Architecture principle: deny everything by default, explicitly allow by role.

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    // Default: deny all
    match /{document=**} { allow read, write: if false; }

    // Public product catalog: read-only for all authenticated users
    match /products/{productId} {
      allow read: if request.auth != null;
      allow write: if request.auth.token.seller == true || request.auth.token.admin == true;
    }
    // ... per-collection rules
  }
}
```

---

## 13. API Design Patterns

### 13.1 Callable Functions (Primary Pattern)

All client-facing business operations use `onCall` with `enforceAppCheck: true`:

```javascript
exports.createOrder = onCall({ enforceAppCheck: true }, async (request) => {
  // 1. Extract and validate auth
  const auth = _authRequired(request);
  // 2. Rate limit
  await checkRateLimit(request, 'checkout');
  // 3. Validate and sanitise input
  const { cart, paymentMethod } = _validateInput(request.data);
  // 4. Business logic
  const orderId = await OrderEngine.create({ uid: auth.uid, cart, paymentMethod });
  // 5. Return typed response
  return { ok: true, orderId };
});
```

### 13.2 HTTP Functions (Webhooks and Public APIs)

Used for: payment provider webhooks, public health checks, MiniShop public APIs.

```javascript
exports.intasendWebhook = onRequest(
  { cors: false },
  async (req, res) => {
    // 1. Verify HMAC signature before processing
    if (!verifyHMAC(req.body, req.headers['x-intasend-signature'])) {
      return res.status(401).json({ error: 'Invalid signature' });
    }
    // 2. Process idempotently
    await PaymentEngine.handleWebhook(req.body);
    res.json({ ok: true });
  }
);
```

### 13.3 Firestore Triggers

Used for: real-time reactions, cache invalidation, event publishing, Redis sync.

```javascript
exports.onOrderCreated = onDocumentCreated(
  { document: 'orders/{orderId}' },
  async (event) => {
    const order = event.data.data();
    // Wrapped in try/catch — trigger failure must never affect Firestore write
    try {
      await EventBus.publish('order.order.created', { orderId: event.params.orderId, ...order });
      await RedisSync.syncOrderCreated(order);
    } catch (err) {
      console.error(JSON.stringify({ severity: 'ERROR', message: err.message }));
    }
  }
);
```

### 13.4 Scheduled Functions

Used for: maintenance, self-healing, metric snapshots, queue processing.

```javascript
exports.redisScheduledQueueWorker = onSchedule(
  { schedule: '* * * * *', timeZone: 'Africa/Nairobi' },
  async () => {
    // Process up to 10 jobs per queue per minute
    for (const queue of QUEUE_PRIORITY_ORDER) {
      const jobs = await QueueService.pop(queue, 10);
      for (const job of jobs) await dispatch(queue, job);
    }
  }
);
```

### 13.5 Input Sanitisation Standard

```javascript
function _san(value, maxLength = 200) {
  if (typeof value !== 'string') throw new HttpsError('invalid-argument', `Expected string`);
  const clean = value.trim().replace(/[<>'"]/g, '');
  if (clean.length > maxLength) throw new HttpsError('invalid-argument', `Value too long`);
  return clean;
}

function _validateAmount(amount) {
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0 || n > 10_000_000)
    throw new HttpsError('invalid-argument', 'Invalid amount');
  return Math.round(n * 100) / 100; // 2dp
}
```

---

## 14. Scalability Design

### 14.1 Horizontal Scaling

Firebase Cloud Functions Gen2 scale to zero and scale out to thousands of instances automatically. Design constraints for horizontal scale:

- **Stateless functions:** no global mutable state in CF instances (no in-memory caches that differ between instances)
- **Idempotent handlers:** duplicate invocations (from retries) produce the same result
- **Distributed locking:** Redis NX locks prevent concurrent-write conflicts on shared resources
- **Atomic Firestore transactions:** for balance deductions, stock decrements, and sequential counters

### 14.2 Database Scaling

| Scenario | Firestore Handles | Redis Handles |
|---|---|---|
| 10,000 concurrent buyers | ✓ (Firestore scales automatically) | Session validation cached |
| 1,000 concurrent POS terminals | ✓ (Firestore onSnapshot) | Cart state + metrics in Redis |
| 100,000 search queries/hour | Algolia/Typesense (not Firestore) | Search result cache |
| 10,000 rate-limit checks/min | Would be 10k Firestore reads | Redis INCR (< 1ms each) |
| 50 concurrent deliveries | ✓ | Rider presence in Redis |

### 14.3 Multi-Branch / Franchise Support

The data model supports multi-branch operations natively:

```
merchants/{merchantId}
  ├─ branches: { [branchId]: { name, location, managers } }
  ├─ branchId is stored on every order, POS session, and inventory record
  └─ Analytics can be queried per-branch or aggregated across branches

sellers/{sellerId}
  └─ shopIds: [shopId1, shopId2, ...]   // one seller, multiple shops
```

No architectural changes are required to support franchise chains — branch filtering is a query parameter, not a schema change.

### 14.4 Multi-Region (Future)

Current deployment: `us-central1` (lowest latency to East Africa via Google backbone).

When traffic justifies multi-region:
1. Firestore: enable multi-region (already possible; requires billing upgrade)
2. Cloud Functions: add `europe-west1` and `asia-east1` replicas
3. Redis: Redis Enterprise Active-Active for cross-region sync, or regional Redis instances with region-affinity routing
4. Search: Typesense replication / Algolia multi-region
5. CDN: Firebase Hosting is already global CDN

The key namespace and event schemas are region-neutral — no data migrations required.

---

## 15. Developer Experience Standards

### 15.1 Shared Services Pattern

Never implement cross-cutting concerns (auth check, rate limit, input sanitisation, event publish) inline in every handler. Use shared modules:

```javascript
// functions/shared/auth.js
function requireAuth(request, requiredClaim = null) { ... }
function requireAdmin(request) { ... }
function requireSeller(request) { ... }

// functions/shared/validation.js
function sanitise(value, maxLen) { ... }
function validateAmount(amount) { ... }
function validatePhone(phone) { ... }

// functions/shared/events.js
async function publishEvent(type, payload, correlationId) { ... }
```

### 15.2 Engine Interface Contract

Every engine exposes its interface through a clear export pattern:

```javascript
// functions/order-engine.js

/**
 * Create a new order.
 * @param {object} params - { uid, cart, paymentMethod, shippingAddress }
 * @returns {{ orderId: string }}
 * @throws HttpsError on validation failure
 */
async function createOrder(params) { ... }

/**
 * Transition order to next status.
 * @param {string} orderId
 * @param {string} newStatus - 'processing' | 'packed' | 'shipped' | 'delivered' | 'completed'
 * @param {string} actorUid
 * @returns {{ ok: boolean }}
 * @throws HttpsError on illegal transition
 */
async function transitionOrder(orderId, newStatus, actorUid) { ... }

module.exports = { createOrder, transitionOrder, cancelOrder, getOrder };
```

### 15.3 Typed Interfaces (JSDoc)

SOKONI uses JSDoc type annotations throughout Cloud Function code. These serve as executable documentation — readable by IDEs and searchable by grep:

```javascript
/**
 * @typedef {Object} OrderItem
 * @property {string} productId
 * @property {string} [variantId]
 * @property {number} qty
 * @property {number} unitPrice
 * @property {string} sellerId
 */

/**
 * @typedef {Object} CreateOrderParams
 * @property {string} uid
 * @property {OrderItem[]} cart
 * @property {'mpesa'|'card'|'wallet'} paymentMethod
 * @property {string} [shippingAddress]
 */
```

### 15.4 Adding a New Hub or Feature

Checklist for adding a new platform vertical:

1. **Define the collection schema** — document in `docs/` before writing code
2. **Define the events** — add to event catalog in §5.3
3. **Write the engine module** — one file per engine, one interface contract
4. **Wire the API layer** — add to `functions/index.js`
5. **Write Firestore security rules** — follow least-privilege pattern
6. **Add Firestore indexes** — document in FIRESTORE-INDEX-ARCHITECTURE.md
7. **Update event subscribers** — register the new engine for relevant events
8. **Add monitoring** — surface in Operations Center
9. **Write documentation** — update ARCHITECTURE.md and create a vertical-specific doc
10. **Update CHANGELOG.md** — with files affected, security implications, deployment steps

### 15.5 Health Check Contract

Every engine implements a health check function:

```javascript
exports.healthCheck = onCall({}, async (request) => {
  const checks = {
    firestore: await checkFirestoreConnectivity(),
    redis:     await checkRedisConnectivity(),  // optional
    search:    await checkSearchConnectivity(), // if applicable
  };
  const healthy = Object.values(checks).every(c => c.ok);
  return { ok: healthy, checks, timestamp: Date.now() };
});
```

### 15.6 Performance Benchmarks

Target metrics per CF category:

| CF Type | P50 | P95 | P99 |
|---|---|---|---|
| Read (cached, Redis) | < 5ms | < 15ms | < 50ms |
| Read (Firestore) | < 30ms | < 100ms | < 300ms |
| Write (Firestore) | < 50ms | < 150ms | < 500ms |
| Payment initiation | < 500ms | < 2s | < 5s |
| AI response (cached) | < 10ms | < 30ms | < 100ms |
| AI response (uncached) | < 2s | < 5s | < 10s |
| Search | < 50ms | < 200ms | < 500ms |
| Event publish | < 100ms | < 300ms | < 1s |

---

## 16. Infrastructure Map

```
Google Cloud Platform (project: sokoni-aeb26)
│
├─ Firebase
│  ├─ Hosting          Static assets, PWA, CDN (global)
│  ├─ Auth             Email/phone/OAuth, custom claims
│  ├─ Firestore        System of record, multi-region
│  ├─ Cloud Functions  Gen2, Node.js 22, us-central1 (1000+ functions)
│  ├─ Cloud Storage    Media files, receipts, backups
│  ├─ App Check        Attestation (ReCaptcha v3 for web)
│  └─ Remote Config    Feature flags, A/B config
│
├─ Cloud Infrastructure
│  ├─ Cloud Scheduler  30+ scheduled jobs (queue worker, health snapshots, cleanup)
│  ├─ Secret Manager   All secrets (never in code)
│  ├─ Cloud Logging    Structured JSON logs from all CFs
│  ├─ Cloud Monitoring 19 alert policies + custom dashboards
│  └─ VPC Connector    Required for Cloud Functions → Memorystore connectivity
│
├─ Redis
│  ├─ Google Cloud Memorystore (Standard, 1GB, us-central1) — production
│  └─ Redis Cloud (Fixed 250MB) — development/staging alternative
│
├─ Search
│  ├─ Typesense (managed cloud)  Primary search engine, Swahili NLP
│  └─ Algolia (managed cloud)    Fallback / analytics search
│
├─ External APIs
│  ├─ IntaSend       M-Pesa STK push + card payments
│  ├─ Africa's Talking  SMS delivery
│  ├─ SendGrid       Transactional email (53 templates)
│  ├─ Anthropic      AI (claude-haiku-4-5, claude-sonnet-4-6)
│  └─ OSRM          Route calculation for delivery
│
└─ CDN / Edge
   ├─ Firebase Hosting CDN  (static assets, PWA shell)
   └─ Cloudflare (optional) Canary traffic splitting, WAF, DDoS
```

---

## 17. Performance Targets

### Page Load

| Page | Target (cached PWA) | Target (first load) |
|---|---|---|
| Marketplace home | < 1s | < 3s |
| Product detail | < 500ms | < 2s |
| Checkout | < 500ms | < 2s |
| POS (pos.html) | < 1s | < 3s |
| Admin OS | < 2s | < 5s |

### API Latency

| Operation | Target | Ceiling |
|---|---|---|
| Session validation (Redis) | < 3ms | 15ms |
| Rate limit check (Redis) | < 2ms | 10ms |
| Firestore read (indexed) | < 30ms | 100ms |
| CF cold start (Gen2) | < 300ms | 800ms |
| CF hot path | < 100ms | 500ms |
| Payment initiation (M-Pesa) | < 2s | 5s |
| STK push to phone | < 5s | 15s |
| Search result (cached) | < 3ms | 15ms |
| Search result (live) | < 50ms | 200ms |
| AI response (cached) | < 5ms | 30ms |
| AI response (uncached) | < 3s | 8s |
| POS cart sync (Redis poll) | < 500ms | 1s |
| POS cart sync (Firestore) | < 100ms | 300ms |

### Throughput Targets

| Metric | Target at launch | Target at scale |
|---|---|---|
| Concurrent users | 5,000 | 500,000 |
| Orders per minute | 100 | 10,000 |
| POS transactions per minute | 500 | 50,000 |
| API requests per second | 1,000 | 100,000 |
| Notifications per minute | 10,000 | 1,000,000 |

---

## 18. Module Catalog

A complete inventory of all platform modules with their status:

| Module | File(s) | Status | Vertical |
|---|---|---|---|
| Order Engine | `orders.js` | Live | Marketplace |
| Payment Orchestrator v2 | `payment-orchestrator.js` | Live | Payments |
| Commission Engine | `commission.js` | Live | Finance |
| Delivery Engine | `delivery.js` | Live | Logistics |
| Rider Navigation | `sokoni-navigation.js` | Live | Logistics |
| Inventory Engine | `inventory.js` | Live | Marketplace |
| SmartPOS Engine | `pos.js` | Live | POS |
| POS Peripheral Hub | `sokoni-device-hub.js` | Live | POS |
| POS Payment Terminal | `sokoni-payment-terminal.js` | Live | POS |
| POS Customer Display | `sokoni-customer-display.js` | Live | POS |
| POS Peripherals CF | `pos-peripherals.js` | Live | POS |
| Foundation Engine | `foundation.js` | Live | Foundation |
| Notification Engine | `notifications.js` | Live | Platform |
| Platform Event Bus | `platform-event-bus.js` | Live | Platform |
| Operations Center | `operations-center.js` | Live | Platform |
| Self-Healing Engine | `self-heal.js` | Live | Platform |
| Redis Service Layer | `redis-service.js` | Live | Infrastructure |
| Redis Cloud Functions | `redis-layer.js` | Live | Infrastructure |
| Redis Job Handlers | `redis-jobs.js` | Live | Infrastructure |
| Redis Rate Limiter | `redis-rate-limiter.js` | Live | Infrastructure |
| Redis Integrations | `redis-integrations.js` | Live | Infrastructure |
| KASS AI Concierge | `kass.js` | Live | AI |
| AI Engine | `ai-engine.js` | Live | AI |
| AI Creative Studio | `sokoni-creative.js` | Live | AI |
| Enterprise Search | `sokoni-search-pro.js` | Live | Search |
| Loyalty Engine v2 | `loyalty.js` | Live | Commerce |
| Subscription Engine | `sub-engine.js` | Live | Commerce |
| Financial OS v2 | `financial-os.js` | Live | Finance |
| eTIMS Integration | `etims.js` | Live | Finance |
| Business Bootstrap | `business-bootstrap.js` | Live | Platform |
| Device Manager | `device-manager.js` | Live | Platform |
| Universal Auth | `firebase.js` | Live | Auth |
| App Check | `sokoni-appcheck.js` | Live | Security |
| Security Engine | `security.js` | Live | Security |
| Venue Booking | `booking.js` | Live | Services |
| Event Hub | `events.js` | Live | Services |
| Education Hub | `education.js` | Live | Services |
| CRM Engine | `crm.js` | Live | Enterprise |
| BI Analytics | `bi-advanced.js` | Live | Enterprise |
| Commerce OS | `platform-core.js` | Live | Commerce OS |
| HR / Payroll | `hr-payroll.js` | Live | Commerce OS |
| Workflow Automation | `sokoni-wap.js` | Live | Platform |
| GIP Geo Intelligence | `sokoni-gip.js` | Live | Platform |
| Redis Client SDK | `sokoni-redis.js` | Live | Client |
| Nav Engine | `sokoni-nav-engine.js` | Live | Client |
| Drawer System | `sokoni-drawer.js` | Live | Client |
| Payment Trust | `sokoni-payment-trust.js` | Live | Client |
| Delivery Pricing | `sokoni-delivery-pricing.js` | Live | Client |
| Universal Printer v3 | `sokoni-universal-printer.js` | Live | POS |
| Manager Auth Engine | `pos-manager-auth.js` | Live | POS |

---

## 19. Deployment Architecture

See [[deployment/ARCHITECTURE]] for full CI/CD specification.

**Summary:**
- Pre-deploy safety gate blocks if payments in-flight, POS sessions open, queue depth > 50
- 6-stage canary rollout: 1% → 5% → 10% → 25% → 50% → 100%
- Auto-rollback on 3 consecutive health check failures
- Feature flags via Firebase Remote Config (all new features default `false`)
- Firestore migrations: Expand → Migrate → Contract pattern
- Nightly backups: Firestore (30 days), Storage (7 days), Typesense (14 days)

**New in v3.0 — deploy the Redis v2.0 integration layer:**
```bash
firebase deploy --only \
  functions:onOrderCreated,\
  functions:onOrderStatusChange,\
  functions:onPaymentCreated,\
  functions:onPaymentUpdated,\
  functions:onInventoryUpdated,\
  functions:onUserCreated,\
  functions:onRiderStatusChange,\
  functions:onDeliveryStatusChange,\
  functions:redisScheduledQueueWorker
```

---

## 20. Architecture Decision Records

### ADR-001: Firestore as System of Record (Not Redis)

**Decision:** All permanent business records (orders, payments, inventory, customers) are written to Firestore. Redis holds only ephemeral operational state.

**Rationale:** Redis has no durable backup, no point-in-time recovery, no ACID guarantees, and TTL-based expiry. Firestore provides all of these. Redis provides speed; Firestore provides correctness. Use each for what it does best.

**Consequence:** Every Redis operation must be redundant with Firestore. Losing Redis at any moment must be a speed degradation, not a data loss event.

---

### ADR-002: Event Bus over Direct Module Calls

**Decision:** Modules communicate via the platform event bus rather than direct Cloud Function calls.

**Rationale:** Direct calls create tight coupling. If Notification Engine is down, it should not abort order creation. If Loyalty Engine is added 6 months later, it should not require modifying Order Engine. Events invert the dependency.

**Consequence:** Business flows span multiple event-driven steps. Debugging requires tracing correlationId through the event log. Operations Center must surface dead-letter events.

---

### ADR-003: Graceful Redis Degradation (Never Fail Open on Security)

**Decision:** Redis unavailability causes platform speed degradation, not security failure. Rate limiting fails open (allows requests) when Redis is unavailable.

**Rationale:** Rate limiting is defence against sustained abuse. Blocking all users because Redis is down causes more harm than a brief rate-limit gap. Critical security controls (authentication, authorisation, payment verification) are Firestore-backed and unaffected by Redis availability.

**Consequence:** During a Redis outage, rate limiting does not apply. Brute-force protection must rely on Firestore-backed counters for OTP and auth endpoints.

---

### ADR-004: Universal Adapter Pattern for POS Hardware

**Decision:** All POS hardware (payment terminals, printers, scanners) is accessed through a vendor-agnostic adapter layer. Core POS code never calls vendor APIs directly.

**Rationale:** Kenya's market has 12+ payment terminal vendors, 5+ printer protocols, and no standard. Locking in to one vendor's API would make hardware migration prohibitively expensive. The adapter layer means adding a new vendor requires one new driver file, not a POS rewrite.

**Consequence:** Adapter interfaces must be stable. Breaking changes to `BaseTerminalDriver` or `SokoniDeviceHub` adapter protocols require updating all existing drivers.

---

### ADR-005: IndexedDB for Offline Queue (Not Service Worker Cache)

**Decision:** SmartPOS offline operations are queued in IndexedDB, not intercepted by Service Worker.

**Rationale:** Service Worker cache is appropriate for static assets. Business transactions (cart updates, orders) need structured storage, retry logic, and authentication — none of which Service Worker provides naturally. IndexedDB gives full control over the queue lifecycle.

**Consequence:** The Service Worker handles static asset caching only. IndexedDB queue requires explicit flush on reconnect via `SokoniRedis.offline.flush()`.

---

## Related Documents

- [[REDIS_ARCHITECTURE]] — Full Redis layer specification (v2.0)
- [[REDIS_SECURITY]] — Redis security controls and TTL strategy
- [[FIRESTORE-INDEX-ARCHITECTURE]] — Index governance and scaling
- [[deployment/ARCHITECTURE]] — CI/CD pipeline and rollback procedures
- [[SECURITY_CERTIFICATION]] — Full security audit and certification
- [[SMARTPOS_PRODUCTION_READINESS_REPORT]] — SmartPOS certification
- [[OPS_RUNBOOK]] — Day-to-day operational procedures
- [[deployment/DISASTER_RECOVERY]] — Full disaster recovery guide
- [[V2_ROADMAP]] — Feature roadmap and planned capabilities
- [[SCALABILITY_REVIEW]] — Detailed scalability analysis
