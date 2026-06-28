# SOKONI Redis Architecture

**Status:** Production  
**Version:** v1.0  
**Last updated:** 2026-06-28

---

## Why Redis?

Firestore is SOKONI's source of truth. It is consistent, durable, and globally replicated. But Firestore is not designed for the sub-10ms latency that real-time UX demands:

| Scenario | Without Redis | With Redis |
|---|---|---|
| Dashboard refresh | 200–400ms Firestore read | 2–5ms Redis read |
| POS cart sync across 4 devices | Firestore realtime listener (50–200ms) | Redis pub/sub + 500ms poll (<10ms propagation) |
| Rate limiting (auth, payments) | Firestore transaction per request | Redis INCR + EXPIRE (~1ms) |
| Payment lock (prevent double-charge) | Firestore transaction (50–150ms) | Redis NX lock (2–5ms) |
| Session validation | Firestore read per request | Redis GET (~1ms) |
| AI response caching | Repeated Anthropic API calls ($0.015/1k tokens) | Redis cache (free after first call) |

Redis is placed between clients and Firestore as a high-speed coordination and caching layer. Firestore writes still happen for every permanent record — Redis only holds temporary, operational state.

---

## Module Map

Which application modules depend on which services:

| Module | Services Used |
|---|---|
| `checkout.html` | `PaymentService` (lock/unlock), `InventoryService` (lock), `DashboardService` (incr orders) |
| `pos.js` / SmartPOS | `POSService` (sync state), `LockService` (shift lock), `InventoryService` (reserve), `SessionService` (cashier) |
| `sokoni-redis.js` (client SDK) | All services via CF wrappers |
| `firebase.js` / login | `SessionService` (create on sign-in), `PresenceService` (start heartbeat) |
| `KASS AI Concierge` | `CacheService.aiGet/.aiSet` (response cache) |
| Enterprise Search | `CacheService.searchGet/.searchSet` (result cache) |
| Admin OS / Super Admin | `DashboardService`, `redisAdminMetrics` CF |
| `redis-monitor.html` | `redisAdminMetrics` CF |
| Payment flow (IntaSend / M-Pesa) | `PaymentService.lock`, `EventBusService.publish('payments', ...)` |
| Rider dispatch | `PresenceService` (rider online status), `LockService` (job lock) |
| Notification engine | `QueueService.push('notification', ...)` |
| Email CFs | `QueueService.push('email', ...)` |

---

## Service Objects

Import a specific service rather than touching Redis directly:

```javascript
const { CacheService, SessionService, LockService } = require('./redis-service');

// Cache an AI response for 1 hour
await CacheService.aiSet(promptHash, response);

// Create a session on login
await SessionService.create(uid, sessionId, { role: 'seller' });

// Acquire a payment lock
const locked = await LockService.acquire(`payment:${orderId}`, lockId, 30_000);
```

### Available Services

| Service | Methods |
|---|---|
| `CacheService` | `get`, `set`, `del`, `getOrSet`, `aiGet`, `aiSet`, `searchGet`, `searchSet` |
| `SessionService` | `create`, `get`, `touch`, `revoke`, `revokeAll`, `list` |
| `LockService` | `acquire`, `release`, `extend` |
| `PresenceService` | `set`, `remove`, `get`, `getAll` |
| `RateLimitService` | `check(identifier, action, maxRequests, windowSeconds)` |
| `DashboardService` | `incr`, `get`, `set` |
| `PaymentService` | `setState`, `getState`, `lock`, `unlock` |
| `POSService` | `setState`, `getState`, `getAllTerminals`, `publish` |
| `InventoryService` | `lock`, `release`, `getLock` |
| `EventBusService` | `publish`, `read`, `getLength` |
| `QueueService` | `push`, `pop`, `depth`, `depthAll` |

---

## Key Naming Conventions

All keys are prefixed `sokoni:` followed by a domain segment:

```
sokoni:{domain}:{...identifiers}
```

| Domain | Pattern | Description |
|---|---|---|
| `cache` | `sokoni:cache:{key}` | Generic cache entries |
| `session` | `sokoni:session:{uid}:{sessionId}` | Session data |
| `sessions` | `sokoni:sessions:{uid}` | SET of session IDs per user |
| `lock` | `sokoni:lock:{resource}` | Distributed lock |
| `presence` | `sokoni:presence:{role}:{uid}` | Live presence record |
| `presenceIdx` | `sokoni:presenceIdx:{role}` | SET of UIDs online per role |
| `dashboard` | `sokoni:dashboard:{shopId}:{metric}` | Metric counter |
| `payment` | `sokoni:payment:{orderId}` | Payment state machine |
| `pos` | `sokoni:pos:{shopId}:{terminalId}` | POS terminal state |
| `pos:ch` | `sokoni:pos:ch:{shopId}` | POS pub/sub channel |
| `inv:lock` | `sokoni:inv:lock:{productId}:{variantId}` | Inventory reservation |
| `stream` | `sokoni:stream:{name}` | Redis Stream (event bus) |
| `queue` | `sokoni:queue:{name}` | Sorted Set job queue |
| `rate` | `sokoni:rate:{action}:{identifier}` | Rate-limit counter |

**Rules:**
- Never use `*` in runtime key construction (use SCAN for admin/monitoring only).
- Identifiers are sanitised to `[a-zA-Z0-9_-]` before use as key components.
- No key may store permanent business records.

---

## TTL Strategy

Every Redis key has an expiry. The `TTL` constant object in `redis-service.js` is the single source of truth:

| Constant | Value | Rationale |
|---|---|---|
| `TTL.PRESENCE` | 90s | Heartbeat is 60s → 30s grace before stale detection |
| `TTL.SESSION` | 86,400s (24h) | Standard web session |
| `TTL.SESSION_EXTENDED` | 2,592,000s (30d) | "Remember me" |
| `TTL.SEARCH` | 300s (5m) | Fresh enough for UX; stale inventory acceptable |
| `TTL.DASHBOARD` | 60s (1m) | Soft real-time; Firestore is exact source |
| `TTL.AI` | 3,600s (1h) | AI responses are expensive; prompt drift unlikely in 1h |
| `TTL.POS` | 3,600s (1h) | Clears after one shift's inactivity |
| `TTL.PAYMENT` | 900s (15m) | STK push / webhook must arrive within 15 min |
| `TTL.LOCK_MS` | 30,000ms | Auto-expires abandoned locks |
| `TTL.INVENTORY_LOCK_MS` | 120,000ms | Survives slow checkout flows |
| `TTL.RATE_SHORT` | 60s | Auth / OTP windows |
| `TTL.RATE_MEDIUM` | 900s | Payment / checkout windows |
| `TTL.RATE_LONG` | 3,600s | AI / search windows |
| `TTL.STREAM_MAX` | 10,000 entries | Ring buffer; old events auto-trimmed |
| `TTL.CACHE_DEFAULT` | 300s | Fallback for unspecified caches |

**Principle:** When in doubt, use a shorter TTL. The worst outcome of a short TTL is a cache miss; the worst outcome of no TTL is unbounded memory growth.

---

## Deployment

### Provisioning Redis

**Option A — Google Cloud Memorystore (Recommended for production)**

```bash
# Create a 1GB Standard Tier instance with Redis 7.0
gcloud redis instances create sokoni-redis \
  --size=1 \
  --region=us-central1 \
  --redis-version=redis_7_0 \
  --tier=standard \
  --transit-encryption-mode=SERVER_AUTHENTICATION \
  --project=sokoni-aeb26

# Get the host IP
gcloud redis instances describe sokoni-redis \
  --region=us-central1 \
  --project=sokoni-aeb26 \
  --format='get(host,port)'
```

The REDIS_URL for Memorystore is: `redis://:{AUTH_STRING}@{HOST}:6379`  
With TLS (recommended): `rediss://:{AUTH_STRING}@{HOST}:6378`

**Option B — Redis Cloud (Free tier for development)**

1. Create account at `app.redislabs.com`
2. Create a free 30MB database
3. Copy the connection string (format: `redis://default:{password}@{host}:{port}`)

### Setting the Secret

```bash
firebase functions:secrets:set REDIS_URL
# Paste the connection URL when prompted
```

### Deploying the Redis Layer

```bash
firebase deploy --only functions:redisSessionCreate,functions:redisPresenceHeartbeat,...
```

Or use the full deploy which picks up all exports from `functions/index.js`.

### Network Configuration (Memorystore)

Cloud Functions in the default network cannot reach Memorystore without a VPC connector:

```bash
# Create serverless VPC connector
gcloud compute networks vpc-access connectors create sokoni-connector \
  --region=us-central1 \
  --subnet=default \
  --subnet-project=sokoni-aeb26 \
  --min-instances=2 \
  --max-instances=10

# Add to firebase.json under functions:
# "vpcConnector": "sokoni-connector",
# "vpcConnectorEgressSettings": "PRIVATE_RANGES_ONLY"
```

---

## Monitoring

Access the Redis Monitor at: `/redis-monitor.html` (Super Admin only).

### Metrics Exposed

| Metric | Source | Alert Threshold |
|---|---|---|
| Connection status | `r.info('all')` | Any disconnection |
| Memory used | `used_memory_human` | > 80% of instance size |
| Cache hit rate | `keyspace_hits / (hits + misses)` | < 50% sustained |
| Ops / sec | `instantaneous_ops_per_sec` | Unexpected spike |
| Active sessions | SCAN `sokoni:session:*:*` | — |
| Connected POS terminals | SCAN `sokoni:pos:*:*` | — |
| Active locks | SCAN `sokoni:lock:*` | > 50 (possible deadlock) |
| Slow operations | `SLOWLOG LEN` | > 20 (possible query issue) |
| Error count | CF instance counter | Any errors |
| Queue depth (per queue) | `ZCARD sokoni:queue:{name}` | > 1000 (worker falling behind) |
| Presence per role | `SCARD sokoni:presenceIdx:{role}` | — |

### Cloud Monitoring Alerts (recommended)

```bash
# Memory pressure alert
gcloud monitoring policies create \
  --notification-channels={CHANNEL_ID} \
  --display-name="Redis memory > 80%" ...
```

---

## Failover and Recovery

### What happens when Redis goes down

1. `_getClient()` returns `null` after 5 failed connection retries.
2. `isFallback()` returns `true`.
3. Every service method returns a safe default (`null`, `[]`, `false`, `0`).
4. All CF responses include `{ fallback: true }` so clients know to adapt.
5. Critical flows (orders, payments, checkout) continue via Firestore — no orders are lost.
6. Presence, sessions, POS sync, and rate limiting degrade gracefully.
7. The error is logged to Cloud Logging with severity ERROR.

### Recovery

When Redis reconnects:
1. `ioredis` auto-reconnects (retryStrategy: exponential backoff, max 3s).
2. `_fallback` flag resets to `false` on `connect` event.
3. Fresh keys are written on the next requests.
4. No manual intervention required.
5. The monitor will show "Live" status within 15 seconds.

### What is never stored in Redis

- Orders
- Payment records
- Inventory counts
- Customer data
- Seller profiles
- Financial records
- Audit logs

These live exclusively in Firestore. Redis loss never causes data loss.

---

## Performance Impact

### Latency improvement

| Operation | Firestore | Redis |
|---|---|---|
| Session check | 30–80ms | 1–3ms |
| Rate limit check | 50–150ms (transaction) | 1–2ms |
| Dashboard read | 100–300ms | 2–5ms |
| Search cache hit | N/A (full query) | 1–3ms |
| AI response cache hit | 2,000–8,000ms (Anthropic API) | 1–3ms |

### Firestore read reduction

| Feature | Reads saved per user action |
|---|---|
| Dashboard refresh (every 5s) | 6–10 reads → 0 (Redis hit) |
| Session validation per CF call | 1 read → 0 (Redis GET) |
| Rate limit per payment attempt | 2 reads → 0 (Redis INCR) |
| Search (popular queries) | 20–100 reads → 0 (cache hit) |

Estimated Firestore cost reduction: **40–70%** under sustained load.

---

## Cost Considerations

### Google Cloud Memorystore pricing (us-central1)

| Tier | Size | Est. cost/month |
|---|---|---|
| Basic (no HA) | 1 GB | ~$35 |
| Standard (HA) | 1 GB | ~$70 |
| Standard (HA) | 5 GB | ~$175 |

### Redis Cloud

| Plan | Size | Cost/month |
|---|---|---|
| Free | 30 MB | $0 |
| Fixed | 250 MB | ~$7 |
| Fixed | 1 GB | ~$25 |

### Recommended starting point

Start with Redis Cloud Fixed 250 MB ($7/month) for Phase 0. Migrate to Memorystore Standard when:
- Monthly Firestore reads exceed 50M (Memorystore pays for itself in read savings)
- POS terminal count exceeds 20
- Session count exceeds 10,000 concurrent

### Break-even calculation

If average session check costs 1 Firestore read at $0.06/100k reads:
- 100,000 sessions/day × $0.06/100k = $0.06/day = $1.80/month saved
- At 1M sessions/day: $18/month saved — Memorystore already paying for itself

---

## Scalability

### Horizontal scaling

Redis is accessed by all Cloud Function instances simultaneously. ioredis handles this correctly — each CF instance creates its own connection (lazy-connect). Memorystore Standard (HA) supports up to 65,000 connections.

### Multi-region

For multi-region Firestore + multi-region CF deployment, use **Redis Enterprise Active-Active** or **Redis Cluster** across regions. Each region connects to its nearest Redis endpoint. The key schema is designed to be region-neutral.

### Future microservices

Because application code imports named service objects (`CacheService`, `SessionService`, etc.) rather than ioredis directly, swapping the underlying Redis implementation (e.g. switching from ioredis to a Redis cluster client, or replacing Redis with another in-memory store) requires changes only to `redis-service.js` — not to any business logic.

---

## Related Documents

- [[SmartPOS Phase 2 Enterprise Retail]]
- [[FinOS v2.0 — Unified Financial OS]]
- [[Platform Registry + Event Bus]]
- [[Enterprise Notification Center]]
- [[SOKONI Impact Enterprise Platform v1.0]]
- [[Security Stack]]
