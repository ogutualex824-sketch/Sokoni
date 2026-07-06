# SOKONI Redis Architecture

**Status:** Production  
**Version:** v2.0  
**Last updated:** 2026-07-07  
**Previous:** v1.0 (2026-06-28)

---

## Table of Contents

1. [Why Redis?](#1-why-redis)
2. [Architecture Overview](#2-architecture-overview)
3. [File Map](#3-file-map)
4. [Module Dependency Map](#4-module-dependency-map)
5. [Service Layer Reference](#5-service-layer-reference)
6. [Key Naming Conventions](#6-key-naming-conventions)
7. [TTL Strategy](#7-ttl-strategy)
8. [Event-Driven Triggers (v2.0)](#8-event-driven-triggers-v20)
9. [Queue Worker Architecture (v2.0)](#9-queue-worker-architecture-v20)
10. [Rate Limiter Middleware (v2.0)](#10-rate-limiter-middleware-v20)
11. [Client SDK — sokoni-redis.js v2.0](#11-client-sdk--sokoni-redisjs-v20)
12. [Offline Queue (v2.0)](#12-offline-queue-v20)
13. [SmartPOS Real-Time Sync (v2.0)](#13-smartpos-real-time-sync-v20)
14. [Monitoring — redis-monitor.html v2.0](#14-monitoring--redis-monitorhtml-v20)
15. [Failover and Recovery](#15-failover-and-recovery)
16. [Deployment](#16-deployment)
17. [Scalability](#17-scalability)
18. [Performance Impact](#18-performance-impact)
19. [Cost Considerations](#19-cost-considerations)
20. [Recovery Procedures](#20-recovery-procedures)
21. [Changelog](#21-changelog)

---

## 1. Why Redis?

Firestore is SOKONI's source of truth. It is consistent, durable, and globally replicated. But Firestore is not designed for the sub-10ms latency that real-time UX demands, nor for high-frequency coordination operations like distributed locking and rate limiting.

| Scenario | Without Redis | With Redis |
|---|---|---|
| Dashboard refresh | 200–400ms Firestore read | 2–5ms Redis read |
| POS cart sync across 4 devices | Firestore listener (50–200ms lag) | Redis poll + pub/sub (<10ms propagation) |
| Rate limiting (auth, payments) | Firestore transaction per request | Redis INCR + EXPIRE (~1ms) |
| Payment lock (prevent double-charge) | Firestore transaction (50–150ms) | Redis NX lock (2–5ms) |
| Session validation | Firestore read per request | Redis GET (~1ms) |
| AI response caching | Repeated Anthropic API calls ($0.015/1k tokens) | Redis cache (free after first call) |
| Job queue dispatch | Firestore query + scan | Redis ZPOPMIN on Sorted Set (~1ms) |
| Inventory reservation | Firestore transaction per item | Redis NX lock per item (~2ms) |

**Principle:** Redis accelerates SOKONI; it never replaces Firestore. Every permanent business record is written to Firestore first. Redis holds only temporary, operational state with mandatory TTLs. If Redis disappears entirely, the platform continues operating — more slowly but without data loss.

---

## 2. Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│  CLIENT LAYER                                                           │
│  pos.html  checkout.html  redis-monitor.html                           │
│  sokoni-redis.js v2.0 (session, presence, offline queue, cart sync)    │
└────────────────────────────────┬────────────────────────────────────────┘
                                 │  HTTPS Callable Cloud Functions
┌────────────────────────────────▼────────────────────────────────────────┐
│  CLOUD FUNCTIONS LAYER                                                  │
│                                                                         │
│  redis-layer.js          redis-rate-limiter.js    redis-integrations.js │
│  (30 callable CFs)       (middleware)             (8 Firestore triggers) │
│       │                       │                        │               │
│       ▼                       ▼                        ▼               │
│  redis-service.js        applied in                applied to           │
│  (service objects)       pos-peripherals.js        orders, payments,    │
│       │                  (+ future CFs)            inventory, users,    │
│       │                                            riders, delivery     │
│       │                                                  │             │
│       ▼                                                  ▼             │
│  redis-jobs.js  ◄── redisScheduledQueueWorker (every 1 min)           │
│  (job handlers)     dispatches: email, notification, sms,              │
│                     receipt, ai, report, bulk, payment                  │
└────────────────────────────────┬────────────────────────────────────────┘
                                 │
                    ┌────────────▼────────────┐
                    │       Redis              │
                    │  Google Cloud Memorystore │
                    │  or Redis Cloud           │
                    │  (ioredis connection)     │
                    └────────────┬─────────────┘
                                 │  Firestore is always authoritative
                    ┌────────────▼─────────────┐
                    │      Firestore            │
                    │  (source of truth)        │
                    └──────────────────────────┘
```

**Data flow rules:**
- Client → Redis (via CF) for fast reads (session, cart, dashboard)
- Client → Firestore (via CF) for all writes that must persist
- Redis → Firestore never happens (Redis never writes to Firestore directly)
- Firestore triggers → Redis (via `redis-integrations.js`) to keep Redis current after Firestore writes

---

## 3. File Map

| File | Role | Layer |
|---|---|---|
| `functions/redis-service.js` | Service objects, raw Redis client, TTL constants, `secureSet`, `redactForCache`, `isFallback` | Core |
| `functions/redis-layer.js` | 30 Gen2 callable CFs + 2 scheduled CFs exposing the service layer | Cloud Functions |
| `functions/redis-jobs.js` | Queue job handlers (email, SMS, FCM, AI, receipt, report, bulk, payment) | Queue Worker |
| `functions/redis-rate-limiter.js` | `checkRateLimit` / `withRateLimit` middleware; 13 action profiles | Middleware |
| `functions/redis-integrations.js` | 8 Firestore `onDocumentCreated`/`onDocumentUpdated` triggers mirroring events to Redis | Event Triggers |
| `sokoni-redis.js` | Client-side SDK — session, presence, offline queue, cart sync, rate awareness, device heartbeats | Client SDK |
| `redis-monitor.html` | Super Admin observability dashboard (premium dark UI, 10 panels) | Observability |

---

## 4. Module Dependency Map

| Application Module | Redis Services Used | Direction |
|---|---|---|
| `pos.html` (SmartPOS cashier) | `SessionService`, `PresenceService`, `POSService.syncCart`, `InventoryService`, `EventBusService` | Client SDK |
| `checkout.html` | `SessionService`, `PaymentService.lock`, `InventoryService.lock`, `DashboardService.incr` | Client SDK |
| `pos-peripherals.js` | `checkRateLimit('pos')` on register + customer-display update | Rate Limiter |
| `payment-orchestrator.js` | Own `_rateLimit` helper (pre-Redis); Redis `PaymentService` via event trigger | Indirect |
| `firebase.js` / login | `SessionService.create` on sign-in | Client SDK |
| `KASS AI Concierge` | `CacheService.aiGet` / `.aiSet` (response cache) | CF |
| Enterprise Search | `CacheService.searchGet` / `.searchSet` (result cache) | CF |
| Admin OS / Super Admin | `DashboardService`, `redisAdminMetrics` CF | CF |
| `redis-monitor.html` | `redisAdminMetrics` CF + Firestore `redisJobAudit` | Observability |
| Rider dispatch | `PresenceService` (online/offline), `LockService` (job lock) | CF + Trigger |
| Notification engine | `QueueService.push('notification', ...)` | CF |
| Email CFs | `QueueService.push('email', ...)` | CF |
| Order flow (orders collection) | `onOrderCreated` trigger → counter incr + inventory lock | Trigger |
| Payment flow | `onPaymentCreated/Updated` trigger → state machine + stream | Trigger |

---

## 5. Service Layer Reference

Import named services — never use `ioredis` directly in business code:

```javascript
const {
  CacheService,
  SessionService,
  LockService,
  PresenceService,
  RateLimitService,
  DashboardService,
  PaymentService,
  POSService,
  InventoryService,
  EventBusService,
  QueueService,
} = require('./redis-service');
```

### CacheService

| Method | Signature | TTL |
|---|---|---|
| `get(key)` | `→ value \| null` | — |
| `set(key, value, ttlSec)` | `→ void` | Required |
| `del(key)` | `→ void` | — |
| `getOrSet(key, fetchFn, ttlSec)` | `→ value` | Required |
| `aiGet(hash)` | `→ string \| null` | — |
| `aiSet(hash, response)` | `→ void` | `TTL.AI` (1h) |
| `searchGet(hash)` | `→ results \| null` | — |
| `searchSet(hash, results)` | `→ void` | `TTL.SEARCH` (5m) |

### SessionService

| Method | Signature |
|---|---|
| `create(uid, sessionId, meta)` | Creates session + adds to sessions SET |
| `get(uid, sessionId)` | Returns session data or null |
| `touch(uid, sessionId)` | Resets TTL (heartbeat) |
| `revoke(uid, sessionId)` | Deletes session + removes from SET |
| `revokeAll(uid)` | Revokes all sessions for user |
| `list(uid)` | Returns array of session IDs |

### LockService

| Method | Signature |
|---|---|
| `acquire(resource, lockId, ttlMs)` | Returns `true` if acquired, `false` if already locked |
| `release(resource, lockId)` | Releases lock (Lua atomic — only releases own lock) |
| `extend(resource, lockId, ttlMs)` | Extends TTL of existing lock |

### PresenceService

| Method | Signature |
|---|---|
| `set(role, uid, meta)` | Marks user online for role |
| `remove(role, uid)` | Marks user offline |
| `get(role)` | Returns array of online members for role |
| `getAll()` | Returns map `{role: members[]}` |

### RateLimitService

| Method | Signature |
|---|---|
| `check(identifier, action, maxRequests, windowSeconds)` | Returns `{ allowed, count, remaining }` |

### DashboardService

| Method | Signature |
|---|---|
| `incr(shopId, metric, by?)` | Increment a counter (default `by=1`) |
| `get(shopId)` | Returns all metrics for shopId |
| `set(shopId, metrics, ttlSec)` | Bulk-set metrics |

### PaymentService

| Method | Signature |
|---|---|
| `lock(orderId, lockId, ttlMs)` | Prevent double-charge: returns `true` if locked |
| `unlock(orderId, lockId)` | Release payment lock |
| `setState(orderId, state, meta)` | Update payment FSM state |
| `getState(orderId)` | Returns `{ state, meta, updatedAt }` |

### POSService

| Method | Signature |
|---|---|
| `setState(shopId, terminalId, state)` | Sync full terminal state |
| `getState(shopId, terminalId?)` | Get one terminal or all terminals for shop |
| `publish(shopId, event)` | Publish POS event to shop channel |

### InventoryService

| Method | Signature |
|---|---|
| `lock(productId, variantId, qty, lockId, ttlMs)` | Reserve stock; fails if already locked |
| `release(productId, variantId, lockId)` | Release reservation |
| `getLock(productId, variantId)` | Returns current lock or null |

### EventBusService

| Method | Signature |
|---|---|
| `publish(stream, event)` | `XADD sokoni:stream:{stream} MAXLEN ~10000` |
| `read(stream, lastId, count)` | `XREAD COUNT {count} STREAMS sokoni:stream:{stream} {lastId}` |
| `getLength(stream)` | `XLEN sokoni:stream:{stream}` |

### QueueService

| Method | Signature |
|---|---|
| `push(queueName, job, priority?)` | `ZADD sokoni:queue:{name} {score} {job}` |
| `pop(queueName, count?)` | `ZPOPMIN sokoni:queue:{name} {count}` |
| `depth(queueName)` | `ZCARD sokoni:queue:{name}` |
| `depthAll()` | Returns depths for all 8 queues |

---

## 6. Key Naming Conventions

All keys follow `sokoni:{domain}:{...identifiers}`. The `_k(...parts)` helper in `redis-service.js` constructs them and enforces the prefix:

| Domain | Pattern | Example |
|---|---|---|
| Cache | `sokoni:cache:{key}` | `sokoni:cache:search:abc123` |
| Session | `sokoni:session:{uid}:{sid}` | `sokoni:session:uid_xyz:sess_abc` |
| Sessions SET | `sokoni:sessions:{uid}` | `sokoni:sessions:uid_xyz` |
| Lock | `sokoni:lock:{resource}` | `sokoni:lock:payment:ord_123` |
| Presence | `sokoni:presence:{role}:{uid}` | `sokoni:presence:cashier:uid_xyz` |
| Presence index | `sokoni:presenceIdx:{role}` | `sokoni:presenceIdx:rider` |
| Dashboard | `sokoni:dashboard:{shopId}:{metric}` | `sokoni:dashboard:shop_1:revenue_today` |
| Payment | `sokoni:payment:{orderId}` | `sokoni:payment:ord_456` |
| POS state | `sokoni:pos:{shopId}:{terminalId}` | `sokoni:pos:shop_1:term_a` |
| POS channel | `sokoni:pos:ch:{shopId}` | `sokoni:pos:ch:shop_1` |
| Inventory lock | `sokoni:inv:lock:{productId}:{variantId}` | `sokoni:inv:lock:prod_99:var_red` |
| Stream | `sokoni:stream:{name}` | `sokoni:stream:orders` |
| Queue | `sokoni:queue:{name}` | `sokoni:queue:email` |
| Rate | `sokoni:rate:{action}:{identifier}` | `sokoni:rate:payment:uid_xyz` |

**Enforcement:**
- `_assertSafeKey()` rejects any key not starting with `sokoni:`.
- `_assertSafeKey()` rejects keys matching `/password|secret|apikey|token.*plain|private_key/i`.
- No key may exceed 256 characters.
- Identifiers are sanitised before interpolation — no raw user input in key names.
- `SCAN` with wildcards is permitted only in admin/monitoring paths (`redisAdminMetrics` CF).

---

## 7. TTL Strategy

Every Redis key has an expiry. The `TTL` constant object in `redis-service.js` is the single source of truth. No code outside that file should hardcode TTL values.

| Constant | Value | Rationale |
|---|---|---|
| `TTL.PRESENCE` | 90s | Heartbeat interval is 55s → 35s grace before stale detection |
| `TTL.SESSION` | 86,400s (24h) | Standard web session |
| `TTL.SESSION_EXTENDED` | 2,592,000s (30d) | "Remember me" login |
| `TTL.SEARCH` | 300s (5m) | Fresh enough for UX; stale inventory is acceptable at 5m |
| `TTL.DASHBOARD` | 60s (1m) | Soft real-time; Firestore is the exact source |
| `TTL.AI` | 3,600s (1h) | Anthropic API calls are expensive; prompt drift is unlikely in 1h |
| `TTL.POS` | 3,600s (1h) | Clears after one shift of inactivity |
| `TTL.PAYMENT` | 900s (15m) | STK push / card webhook must arrive within 15 min |
| `TTL.LOCK_MS` | 30,000ms | Auto-expires abandoned general-purpose locks |
| `TTL.INVENTORY_LOCK_MS` | 120,000ms | Survives slow checkout flows (up to 2 minutes) |
| `TTL.STREAM_MAX` | 10,000 entries | Ring buffer; old events are auto-trimmed by `MAXLEN ~10000` |
| `TTL.CACHE_DEFAULT` | 300s | Fallback TTL for unspecified cache calls |

**Design rule:** When in doubt, use a shorter TTL. A cache miss costs one Firestore read. An indefinite key costs unbounded memory and causes silent staleness.

**TTL enforcement:** `secureSet()` throws if called without a TTL or with `ttlSeconds > 2,592,000` (30 days).

---

## 8. Event-Driven Triggers (v2.0)

`functions/redis-integrations.js` bridges Firestore writes to Redis state updates. These are Firestore triggers — they fire after every Firestore document write and update Redis asynchronously.

**Safety guarantee:** Every handler is wrapped in `_safeRedis(name, fn)`. If Redis is unavailable or throws, the trigger completes silently. The Firestore write is never rolled back due to a Redis failure.

### Trigger Table

| Trigger | Firestore Path | What Redis Gets Updated |
|---|---|---|
| `onOrderCreated` | `orders/{orderId}` | `DashboardService.incr` orders_today (shop + platform); `InventoryService.lock` for each item (15m); `EventBusService.publish('orders', ...)` |
| `onOrderStatusChange` | `orders/{orderId}` | On `completed`: revenue_today, orders_completed, queue receipt + report; On `cancelled`/`refunded`: release inventory locks, incr refunds_today |
| `onPaymentCreated` | `payments/{paymentId}` | `PaymentService.setState('pending')`, publish to `payments` stream |
| `onPaymentUpdated` | `payments/{paymentId}` | `PaymentService.setState(mappedState)`, publish to `payments` stream; on `completed` incr payments_today |
| `onInventoryUpdated` | `products/{productId}` | Publish inventory_updated event; on `stockQty=0` publish out_of_stock event |
| `onUserCreated` | `users/{uid}` | `DashboardService.incr('platform', 'users_total')`, publish user_registered |
| `onRiderStatusChange` | `riders/{riderId}` | `PresenceService.set/remove('rider', ...)`, publish rider_status_changed |
| `onDeliveryStatusChange` | `deliveries/{deliveryId}` | Publish delivery_status_changed; on `delivered` incr deliveries_completed_today |

### Payment State Machine

Firestore `payments.status` is mapped to the Redis payment state by `STATE_MAP`:

```
Firestore status   →   Redis PaymentService state
─────────────────────────────────────────────────
pending            →   pending
processing         →   processing
completed / paid   →   completed
success            →   completed
failed / cancelled →   failed
refunded           →   refunded
expired            →   expired
```

Redis state is ephemeral (TTL 15m). Firestore is authoritative for permanent payment records.

---

## 9. Queue Worker Architecture (v2.0)

The queue system has two parts:

**1. Enqueue** — any Cloud Function calls `QueueService.push(queueName, job, priority)`:
```javascript
// From within any CF handler
await QueueService.push('email', {
  to: 'user@example.com',
  subject: 'Your order is confirmed',
  templateId: 'order_confirmed',
  dynamicTemplateData: { orderNumber: 'ORD-123' },
});
```

**2. Dequeue + Dispatch** — `redisScheduledQueueWorker` runs every minute and processes up to 10 jobs per queue per cycle:

```
redisScheduledQueueWorker (every 60s)
│
├── QueueService.pop('payment', 10)   → dispatch → handle internally
├── QueueService.pop('receipt', 10)   → dispatch → Firestore receipt.status + Redis cache
├── QueueService.pop('email', 10)     → dispatch → SendGrid REST API
├── QueueService.pop('notification',10)→ dispatch → FCM admin.messaging()
├── QueueService.pop('sms', 10)       → dispatch → Africa's Talking API
├── QueueService.pop('ai', 10)        → dispatch → Anthropic claude-haiku-4-5 + AI cache
├── QueueService.pop('report', 10)    → dispatch → Firestore aggregation
└── QueueService.pop('bulk', 10)      → dispatch → Firestore batch writes
```

### Retry and Dead-Letter

`dispatch(queue, job)` in `redis-jobs.js`:
- `MAX_RETRIES = 3` — each handler is called up to 3 times before failure
- Backoff: `2^retries × 5000ms` (5s, 10s, 20s between retries within a cycle)
- On final failure: writes to `redisJobDeadLetter` (Firestore collection) + `redisJobAudit`
- Dead-letter records include: `queue`, `job`, `error`, `retries`, `failedAt`
- Dead-letter is never auto-deleted — requires manual investigation

### Handler Implementations

| Queue | Handler | External API | Error handling |
|---|---|---|---|
| `email` | `handleEmail` | SendGrid `POST /v3/mail/send` | Log + dead-letter on non-2xx |
| `notification` | `handleNotification` | FCM `admin.messaging().send()` | Removes stale tokens on `registration-token-not-registered` |
| `sms` | `handleSMS` | Africa's Talking `POST /messaging` | Max 20 recipients, max 918 chars per message |
| `receipt` | `handleReceipt` | Firestore (orders collection) | Updates `receipt.status`, caches receipt-ready in Redis |
| `ai` | `handleAI` | Anthropic (`claude-haiku-4-5-20251001`) | Checks Redis AI cache first; PII-redacted before storing |
| `report` | `handleReport` | Firestore aggregation | `daily_sales`: groups orders by shopId/date; `commission_summary`: groups ledger |
| `bulk` | `handleBulk` | Firestore batch | SAFE_LIMIT = 500 items per batch |

---

## 10. Rate Limiter Middleware (v2.0)

`functions/redis-rate-limiter.js` provides a drop-in middleware for callable Cloud Functions.

**Graceful degradation:** If Redis is unavailable (`isFallback() === true`), all rate-limit checks return `{ allowed: true, fallback: true }` — the platform is never blocked by Redis unavailability.

### Usage

```javascript
const { checkRateLimit, withRateLimit } = require('./redis-rate-limiter');

// Inline check (throws HttpsError if exceeded)
exports.myFunc = onCall(opts, async (req) => {
  await checkRateLimit(req, 'payment');
  // ... handler code
});

// Wrapper style
exports.myFunc = onCall(opts, withRateLimit('checkout', async (req) => {
  // ... handler code
}));
```

### Action Profiles

| Action | Max Requests | Window | Key By | User Message |
|---|---|---|---|---|
| `auth` | 10 | 60s | IP | Too many sign-in attempts |
| `otp` | 5 | 300s | IP | Too many OTP requests |
| `checkout` | 20 | 60s | UID | Too many checkout requests |
| `payment` | 5 | 60s | UID | Too many payment attempts |
| `ai` | 30 | 3,600s | UID | AI quota reached (hourly) |
| `search` | 120 | 60s | IP | Search rate limit exceeded |
| `webhook` | 200 | 60s | IP | Webhook rate limit exceeded |
| `admin` | 60 | 60s | UID | Admin API rate limit exceeded |
| `listing` | 50 | 3,600s | UID | Too many listings (hourly) |
| `review` | 10 | 3,600s | UID | Review limit (10/hour) |
| `pos` | 600 | 60s | UID | POS operation rate limit exceeded |
| `notification` | 100 | 60s | UID | Notification rate limit exceeded |
| `default` | 100 | 60s | UID | Rate limit exceeded |

### Currently Wired

| Cloud Function | Action |
|---|---|
| `posRegisterPeripheral` | `pos` |
| `posUpdateCustomerDisplay` | `pos` |

All other functions use Firestore-native rate limiting or no limiting. Redis rate limiting is additive — it does not replace existing checks.

---

## 11. Client SDK — sokoni-redis.js v2.0

`sokoni-redis.js` is the browser-side SDK. It wraps all 30+ Redis Cloud Functions behind a clean API so frontend code never calls Firebase Functions directly for Redis operations.

### Initialisation

```javascript
// On page load, after Firebase auth
await SokoniRedis.init('cashier', { shopId, terminalId }, {
  autoFlushOffline: true,          // auto-flush offline queue when connectivity returns
  offlineProgressFn: (p) => { }   // optional progress callback
});

// On logout
await SokoniRedis.destroy();
```

### Top-Level Namespaces

| Namespace | Purpose |
|---|---|
| `SokoniRedis.session` | `create`, `get`, `revoke`, `revokeAll`, `list` |
| `SokoniRedis.presence` | `start`, `stop`, `heartbeat`, `updateMeta`, `getOnline`, `getAllCounts` |
| `SokoniRedis.device` | `register`, `startHeartbeat`, `stopHeartbeat`, `getAll` |
| `SokoniRedis.pos` | `syncCart`, `getState`, `getAllTerminals`, `publish`, `subscribeTerminal`, `subscribeShop` |
| `SokoniRedis.offline` | `enqueue`, `flush`, `depth`, `hasPending` |
| `SokoniRedis.inventory` | `lock`, `release` |
| `SokoniRedis.dashboard` | `get`, `set`, `incr`, `livePoll` |
| `SokoniRedis.payment` | `lock`, `unlock`, `setState`, `getState`, `pollUntilComplete` |
| `SokoniRedis.cache` | `get`, `set`, `getOrFetch` |
| `SokoniRedis.rateLimit` | `track`, `remaining`, `exceeded` |
| `SokoniRedis.events` | `publish`, `subscribe`, `unsubscribe` |
| `SokoniRedis.queue` | `push`, `depth` |
| `SokoniRedis.admin` | `getMetrics`, `rateCheck` |
| `SokoniRedis.connectivity` | `enableAutoFlush` |

---

## 12. Offline Queue (v2.0)

The offline queue allows SmartPOS to operate without network connectivity and synchronise automatically when connectivity returns.

### Storage Strategy

Primary storage: **IndexedDB** (`sokoni_offline` database, `queue` object store).  
Fallback: **localStorage** ring buffer (last 100 items) when IndexedDB is unavailable.

Both storage layers contain only non-sensitive operational data — no payment credentials, no PII.

### Lifecycle

```
Device goes offline
      │
      ▼
POS attempts cart sync
      │
      ▼
SokoniRedis.pos.syncCart() → Redis CF returns { fallback: true }
      │
      ▼
Application calls: await SokoniRedis.offline.enqueue('pos_cart_sync', { shopId, terminalId, state })
      │
      ▼
Record saved to IndexedDB with status = 'pending'
      │
      │  ... device offline for N minutes ...
      │
      ▼
Device goes online → window 'online' event fires
      │
      ▼
SokoniRedis.connectivity.enableAutoFlush() detects depth > 0
      │
      ▼
SokoniRedis.offline.flush(onProgress)
  ├── type 'pos_cart_sync' → SokoniRedis.pos.syncCart()
  ├── type 'order'         → DashboardService.incr
  └── type 'payment'       → PaymentService.setState
      │
      ▼
Successful items → status = 'synced'
Failed items     → status = 'failed' (retried next flush)
```

### Supported Queue Types

| Type | Replay Action |
|---|---|
| `pos_cart_sync` | `SokoniRedis.pos.syncCart(shopId, terminalId, state)` |
| `order` | `DashboardService.incr(shopId, 'orders_today')` |
| `payment` | `PaymentService.setState(orderId, state, meta)` |

Custom types are accepted and marked `synced` without action (safe ignore for future extensibility).

---

## 13. SmartPOS Real-Time Sync (v2.0)

Multiple devices in the same shop (cashier terminal, manager tablet, customer display, back-office PC) all need the same live cart view. Redis provides the coordination layer.

### Sync Flow

```
Cashier adds item
      │
      ▼
SPos.cart.add(item) → updates local state
      │
      ▼
SokoniRedis.pos.syncCart(shopId, terminalId, state)
  → redisPosSetState CF
  → Redis: SET sokoni:pos:{shopId}:{terminalId} {json} EX 3600
  → Redis: XADD sokoni:stream:pos_events
      │
      ▼
Other devices polling subscribeTerminal / subscribeShop
  → redisPosGetState CF (every 500ms / 1000ms)
  → JSON hash diff: only fires callback when state changes
      │
      ▼
Manager tablet updates → customer display updates
```

### Subscription API

```javascript
// Cashier terminal: sync my cart out
await SokoniRedis.pos.syncCart(shopId, terminalId, cartState);

// Manager tablet: watch all terminals
const stop = SokoniRedis.pos.subscribeShop(shopId, (terminals) => {
  renderTerminalMap(terminals);
}, 1000);

// Customer display: watch one terminal
const stop = SokoniRedis.pos.subscribeTerminal(shopId, terminalId, (state) => {
  renderCartDisplay(state);
}, 500);

// Stop when done
stop();
```

### Latency

- Cashier keystroke → Redis write: ~5–15ms (CF round-trip)
- Redis write → other device sees change: 500ms poll interval (configurable down to 100ms)
- Total end-to-end: ~500–600ms typical; sub-100ms with interval=100ms

---

## 14. Monitoring — redis-monitor.html v2.0

Access at `/redis-monitor.html`. Requires Super Admin (`token.claims.admin || token.claims.superAdmin`).

### Panels

| Panel | Data Source | Refresh |
|---|---|---|
| KPI row (memory, hit rate, ops/sec, sessions) | `redisAdminMetrics` CF | 15s auto |
| Connection health (uptime, clients, commands, hits/misses) | `redisAdminMetrics` CF | 15s auto |
| Memory detail (used, peak, total system, fragmentation ratio, evictions) | `redisAdminMetrics` CF | 15s auto |
| Platform totals (sessions, POS terminals, locks, queued jobs, online presence) | `redisAdminMetrics` CF | 15s auto |
| Queue depths (8 queues with bar charts) | `redisAdminMetrics` CF | 15s auto |
| Event stream lengths (8 streams with entry counts) | `redisAdminMetrics` CF | 15s auto |
| POS terminal map (cards with shop, total, items, payment status) | `redisAdminMetrics` CF | 15s auto |
| Online presence (chips per role) | `redisAdminMetrics` CF | 15s auto |
| Active locks (key, remaining TTL) | `redisAdminMetrics` CF | 15s auto |
| Rate limit violations (recent blocked requests with action + identifier) | `redisAdminMetrics` CF | 15s auto |
| Job audit log (last 30 jobs with queue, status, timestamp) | Firestore `redisJobAudit` | On each load |
| Slowlog (slowest Redis commands with duration µs) | `redisAdminMetrics` CF | 15s auto |
| Error log | `redisAdminMetrics` CF | 15s auto |

### Alert Thresholds

| Metric | Concern | Action |
|---|---|---|
| Memory > 80% | Near OOM | Scale instance or clear stale keys |
| Hit rate < 50% sustained | Cache not working | Check TTL strategy, key naming |
| Queue depth > 1,000 | Worker falling behind | Check worker logs, scale frequency |
| Active locks > 50 | Possible deadlock | Investigate lock holders, check LockService.release calls |
| Slowlog > 20 entries | Query performance issue | Identify and optimise slow commands |
| Any error | Operational issue | Check Cloud Logging for context |

---

## 15. Failover and Recovery

### When Redis Goes Down

1. `_getClient()` returns `null` after 5 failed connection retries (exponential backoff).
2. `isFallback()` returns `true` platform-wide.
3. Every service method returns a safe default (`null`, `[]`, `false`, `{fallback:true}`).
4. CF responses include `{ fallback: true }` — clients detect this and adapt.
5. **Critical flows continue:** orders, payments, and checkouts route through Firestore transactions.
6. **Degraded features:** presence shows all users offline; sessions require re-authentication on next request; rate limits fail open; POS sync pauses until reconnect; dashboard reads from Firestore directly.
7. Error logged to Cloud Logging with `severity: ERROR` and `message: [Redis] Connection failed`.

### Auto-Recovery

1. `ioredis` retryStrategy retries with exponential backoff (max 3s between attempts).
2. On reconnect, `_fallback` resets to `false` on `connect` event.
3. Fresh keys are written on next requests — no stale data problem (all keys had TTLs).
4. Client-side: `SokoniRedis.offline.flush()` fires on `window online` event.
5. POS terminals resume syncing within one poll interval (500ms).
6. `redis-monitor.html` shows "Connected" within 15 seconds.

**No manual intervention is required** for Redis recovery unless the outage lasts longer than session TTL (24h) — in which case users must re-authenticate.

### What Redis Loss Can Never Cause

- **Data loss** — all business records live in Firestore
- **Missed payments** — payment orchestrator has its own Firestore-native state machine
- **Failed orders** — order flow is Firestore-first
- **Lost inventory** — inventory counts are authoritative in Firestore
- **Inaccessible files** — static assets served from Firebase Hosting, independent of Redis

---

## 16. Deployment

### Step 1 — Provision Redis

**Option A — Google Cloud Memorystore (recommended for production)**

```bash
gcloud redis instances create sokoni-redis \
  --size=1 \
  --region=us-central1 \
  --redis-version=redis_7_0 \
  --tier=standard \
  --transit-encryption-mode=SERVER_AUTHENTICATION \
  --project=sokoni-aeb26

# Get IP and port
gcloud redis instances describe sokoni-redis \
  --region=us-central1 \
  --project=sokoni-aeb26 \
  --format='get(host,port)'
```

Memorystore requires a **VPC Connector** for Cloud Functions access:

```bash
gcloud compute networks vpc-access connectors create sokoni-connector \
  --region=us-central1 \
  --subnet=default \
  --subnet-project=sokoni-aeb26 \
  --min-instances=2 \
  --max-instances=10
```

Add to `firebase.json` under `functions`:
```json
"vpcConnector": "sokoni-connector",
"vpcConnectorEgressSettings": "PRIVATE_RANGES_ONLY"
```

**Option B — Redis Cloud (development / staging)**

1. Create account at `app.redislabs.com`
2. Create a Fixed 250 MB database (~$7/month)
3. Copy the connection string: `rediss://default:{password}@{host}:{port}`

### Step 2 — Store Secret

```bash
firebase functions:secrets:set REDIS_URL
# Paste the rediss:// connection URL when prompted
```

### Step 3 — Deploy Cloud Functions

Full deploy (picks up all exports from `functions/index.js`):
```bash
firebase deploy --only functions
```

Targeted deploy (Redis layer only):
```bash
# Core Redis CFs (30 callables + 2 scheduled)
firebase deploy --only \
  functions:redisSessionCreate,\
  functions:redisSessionGet,\
  functions:redisSessionRevoke,\
  functions:redisSessionRevokeAll,\
  functions:redisSessionList,\
  functions:redisPresenceHeartbeat,\
  functions:redisPresenceGet,\
  functions:redisPresenceRemove,\
  functions:redisPosSetState,\
  functions:redisPosGetState,\
  functions:redisPosPublish,\
  functions:redisInventoryLock,\
  functions:redisInventoryRelease,\
  functions:redisDashboardGet,\
  functions:redisDashboardSet,\
  functions:redisDashboardIncr,\
  functions:redisCacheGet,\
  functions:redisCacheSet,\
  functions:redisPaymentLock,\
  functions:redisPaymentUnlock,\
  functions:redisPaymentSetState,\
  functions:redisPaymentGetState,\
  functions:redisEventPublish,\
  functions:redisEventRead,\
  functions:redisQueuePush,\
  functions:redisQueueDepth,\
  functions:redisRateCheck,\
  functions:redisAdminMetrics,\
  functions:redisScheduledPresenceCleanup,\
  functions:redisScheduledQueueWorker

# v2.0: Firestore → Redis event triggers
firebase deploy --only \
  functions:onOrderCreated,\
  functions:onOrderStatusChange,\
  functions:onPaymentCreated,\
  functions:onPaymentUpdated,\
  functions:onInventoryUpdated,\
  functions:onUserCreated,\
  functions:onRiderStatusChange,\
  functions:onDeliveryStatusChange
```

### Step 4 — Verify

1. Open `redis-monitor.html` as Super Admin
2. Confirm "Connected" status and non-zero memory
3. Place a test order and confirm `orders_today` counter increments
4. Send a test email via the queue and confirm it appears in job audit log

---

## 17. Scalability

### Horizontal Scaling

Redis is accessed by all Cloud Function instances simultaneously. `ioredis` handles this — each CF instance creates its own connection (lazy-connect, connection pool). Memorystore Standard (HA) supports up to 65,000 concurrent connections.

### Queue Worker Scaling

The scheduled queue worker runs every minute. If job volume exceeds 10 jobs/queue/minute, increase `BATCH` in `redisScheduledQueueWorker` or add a second scheduled function on a staggered schedule.

### Multi-Region

For multi-region Firestore + multi-region CF deployments:
- Use **Redis Enterprise Active-Active** (active replication across regions) or
- Use **separate Redis instances per region** with region-affinity routing
- The key schema is region-neutral — no changes required

### Future Microservices

Application code imports named service objects (`CacheService`, `SessionService`, etc.), not `ioredis` directly. Swapping the underlying store (Redis → Dragonfly, Redis Cloud → Memorystore, `ioredis` → `@redis/client`) requires changes only to `functions/redis-service.js`.

---

## 18. Performance Impact

### Latency Comparison

| Operation | Firestore | Redis |
|---|---|---|
| Session validation | 30–80ms | 1–3ms |
| Rate limit check | 50–150ms (transaction) | 1–2ms |
| Dashboard read | 100–300ms | 2–5ms |
| Search cache hit | Full query (varies) | 1–3ms |
| AI response cache hit | 2,000–8,000ms (Anthropic API) | 1–3ms |
| POS cart sync | 50–200ms (Firestore listener) | 10ms propagation |

### Firestore Read Reduction

| Feature | Reads saved per user action |
|---|---|
| Dashboard refresh (every 5s, 10 metrics) | 10 reads → 0 (Redis hit) |
| Session validation per CF call | 1 read → 0 |
| Rate limit per payment attempt | 2 reads → 0 (Redis INCR) |
| Search (popular queries) | 20–100 reads → 0 (cache hit) |
| AI responses (repeated questions) | ~50 reads → 0 |

Estimated Firestore cost reduction: **40–70%** under sustained load once session and dashboard caching are fully used.

---

## 19. Cost Considerations

### Google Cloud Memorystore (us-central1)

| Tier | Size | Est. cost/month | Suitable for |
|---|---|---|---|
| Basic (no HA) | 1 GB | ~$35 | Development / staging |
| Standard (HA) | 1 GB | ~$70 | Phase 0 production |
| Standard (HA) | 5 GB | ~$175 | 50,000+ sessions/day |
| Standard (HA) | 10 GB | ~$350 | 200,000+ sessions/day |

VPC Connector adds ~$15–40/month depending on throughput.

### Redis Cloud

| Plan | Size | Cost/month | Suitable for |
|---|---|---|---|
| Free | 30 MB | $0 | Development only |
| Fixed | 250 MB | ~$7 | Phase 0 / low volume |
| Fixed | 1 GB | ~$25 | Moderate traffic |
| Flexible | scales | pay-as-you-go | High volume |

### Break-Even Calculation

Firestore read cost: $0.06 per 100,000 reads.

If Redis caches 100,000 session checks/day:
- Firestore cost saved: 100k × $0.06/100k = $0.06/day = **$1.80/month**

At 1 million sessions/day: **$18/month** saved — Redis Cloud 250 MB ($7) pays for itself at ~400,000 sessions/day.

At 50M dashboard reads/month (10 reads × 5M refreshes): **$30/month** saved.

**Recommendation:** Start with Redis Cloud Fixed 250 MB ($7/month). Migrate to Memorystore Standard when monthly Firestore reads exceed 50M or POS terminals exceed 20.

---

## 20. Recovery Procedures

### Runbook: Redis Completely Unavailable

1. Platform continues operating. No action required to keep orders flowing.
2. Check `redis-monitor.html` → "Redis offline" status.
3. Check Cloud Logging: filter `message="[Redis] Connection failed"`.
4. Verify `REDIS_URL` secret is set: `firebase functions:secrets:access REDIS_URL`.
5. Test connectivity from Cloud Shell to Redis endpoint.
6. If Memorystore: check VPC Connector status and firewall rules.
7. If Redis Cloud: check Redis Labs dashboard for instance status.
8. Once connectivity restored: functions auto-reconnect. Monitor `redis-monitor.html` for "Connected" within 15s.

### Runbook: Memory Pressure (> 80%)

1. Open `redis-monitor.html` → Memory panel.
2. Check `fragmentation_ratio` — if > 2.0, restart Redis (defragmentation).
3. Identify largest keyspaces via `redisAdminMetrics` → keyspace section.
4. If search cache is large: reduce `TTL.SEARCH` temporarily.
5. If POS state is large: verify TTL is set correctly (1h idle expiry).
6. Scale up Redis instance if sustained growth.

### Runbook: Queue Depth Spiking

1. Open `redis-monitor.html` → Queue Depths panel.
2. Identify which queue is growing (email, sms, ai, etc.).
3. Check `redisJobAudit` (Firestore) for failed jobs — look for repeated `status: 'failed'`.
4. Check `redisJobDeadLetter` (Firestore) for max-retry items — identify the error.
5. Fix the underlying issue (bad API key, quota exceeded, network timeout).
6. Dead-letter items require manual replay: read from `redisJobDeadLetter`, re-enqueue via `QueueService.push`.

### Runbook: Stale POS Session After Crash

1. POS terminal crashed during an active shift.
2. Redis POS state has TTL 1h — will expire automatically.
3. If immediate recovery needed: call `redisPosSetState` with `paymentStatus: 'idle'` to clear.
4. Firestore orders are unaffected — only Redis ephemeral state is stale.

---

## 21. Changelog

| Version | Date | Summary |
|---|---|---|
| v1.0 | 2026-06-28 | Initial Redis layer — 30 CFs, service objects, SOC, basic monitoring |
| v2.0 | 2026-07-07 | Queue worker completion (8 queues, real job dispatch); 8 Firestore event triggers; Redis rate limiter middleware; `sokoni-redis.js` v2.0 (offline queue, POS cart sync, device heartbeats); `redis-monitor.html` v2.0 (premium dark UI, 13 panels); rate limiting wired into pos-peripherals.js; `pos.html` + `checkout.html` fully wired |

---

## Related Documents

- [[REDIS_SECURITY]] — Key security controls, TTL enforcement, PII redaction
- [[SmartPOS Phase 2 Enterprise Retail]] — POS architecture that Redis accelerates
- [[FinOS v2.0 — Unified Financial OS]] — Payment flows using Redis coordination
- [[Platform Registry + Event Bus]] — Platform event architecture
- [[Enterprise Notification Center]] — Notification queue integration
- [[SOKONI Impact Enterprise Platform v1.0]] — Platform overview
- [[Security Stack]] — Auth and rate limiting architecture
- [[FIRESTORE-INDEX-ARCHITECTURE]] — Complementary Firestore architecture
