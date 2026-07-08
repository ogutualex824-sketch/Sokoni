# SOKONI Scalability Playbook

**Version:** 1.0  
**Status:** Active  
**Date:** 2026-07-08  
**Audience:** Engineering team, CTO, infrastructure lead  
**Related:** [[ARCHITECTURE]] [[SCALABILITY_REVIEW]] [[SCALING_TRIGGERS]]

This document is the forward-looking scalability playbook. It defines growth gates, scaling patterns, traffic models, database scaling strategy, and the concrete actions required at each scale milestone. For a point-in-time review of the current architecture's capacity, see [[SCALABILITY_REVIEW]].

---

## Table of Contents

1. [Scaling Targets](#1-scaling-targets)
2. [Horizontal Scaling Patterns](#2-horizontal-scaling-patterns)
3. [Database Scaling](#3-database-scaling)
4. [Traffic Patterns](#4-traffic-patterns)
5. [Growth Projections and Architecture Gates](#5-growth-projections-and-architecture-gates)
6. [Cost Scaling Model](#6-cost-scaling-model)
7. [Scaling Anti-Patterns to Avoid](#7-scaling-anti-patterns-to-avoid)
8. [Runbook — How to Scale Each Component](#8-runbook--how-to-scale-each-component)

---

## 1. Scaling Targets

These are the quantified goals that all architecture decisions are evaluated against.

### 1.1 Concurrency Targets

| Metric | Launch Target | 12-Month Target | 3-Year Target |
|---|---|---|---|
| Concurrent users (web) | 5,000 | 100,000 | 1,000,000 |
| Concurrent POS terminals | 200 | 2,000 | 20,000 |
| Concurrent delivery riders | 100 | 2,000 | 20,000 |
| Concurrent AI conversations (KASS) | 50 | 1,000 | 10,000 |

### 1.2 Throughput Targets

| Metric | Launch Target | 12-Month Target | 3-Year Target |
|---|---|---|---|
| Orders per day | 1,000 | 50,000 | 500,000 |
| Transactions per day | 5,000 | 100,000 | 1,000,000 |
| Search queries per day | 50,000 | 2,000,000 | 20,000,000 |
| Notifications per day | 20,000 | 1,000,000 | 10,000,000 |
| Firestore reads per day | 500,000 | 25,000,000 | 250,000,000 |
| Firestore writes per day | 100,000 | 5,000,000 | 50,000,000 |

### 1.3 Latency Targets (to be maintained at all scale levels)

| Operation | Target P50 | Target P95 | Target P99 |
|---|---|---|---|
| API response (cached, Redis) | < 5ms | < 15ms | < 50ms |
| API response (Firestore read) | < 30ms | < 100ms | < 300ms |
| API response (Firestore write) | < 50ms | < 150ms | < 500ms |
| Payment initiation | < 500ms | < 2s | < 5s |
| Search (Typesense) | < 50ms | < 150ms | < 400ms |
| AI response (cached) | < 10ms | < 30ms | < 100ms |
| AI response (live) | < 2s | < 5s | < 10s |
| Page load (PWA, cached) | < 1s | < 2s | < 3s |
| Page load (first visit) | < 2s | < 3.5s | < 5s |

**Principle:** Latency targets are hard ceilings. Adding capacity must not be accompanied by latency regression. If adding a feature increases P95 by > 20%, it requires a performance review before deployment.

### 1.4 Availability Target

**Target SLA:** 99.9% uptime (8.7 hours downtime/year allowance).

- Payment processing: 99.95% (4.4 hours/year)
- SmartPOS (offline-capable): 99.5% online (offline mode covers planned downtime)
- Search: 99.9% (Firestore fallback means search is never completely down)

---

## 2. Horizontal Scaling Patterns

### 2.1 Cloud Functions — Auto-Scale by Design

Cloud Functions Gen2 scales automatically. Each function invocation runs in an isolated container instance. GCP manages provisioning, load balancing, and scaling.

**Current configuration:**
```
maxInstances:  1,000 (GCP default cap; increase via quota request)
minInstances:  1 for critical paths (payment, checkout, search)
               0 for all other functions (scale-to-zero)
concurrency:   80 requests per instance (Gen2 default; tunable)
memory:        256MB default; 512MB for AI + analytics functions
cpu:           1 vCPU default; 2 vCPU for heavy AI/PDF generation
timeout:       60s default; 540s for batch/scheduled functions
```

**Scaling guarantee:** Cloud Functions auto-scale handles 5x–100x traffic spikes without intervention, within 30–60 seconds of increased load. No manual scaling action is required.

**What engineers must do to enable auto-scaling:**
1. Keep functions stateless — no in-memory caches that differ between instances
2. Make all handlers idempotent — duplicate invocations produce the same result
3. Use distributed locking (Redis NX) for shared resource access
4. Use atomic Firestore transactions for balance deductions and sequential counters

**Warning signs that auto-scaling is failing:**
- CF error rate spikes on traffic increase (rather than latency increase then recovery)
- Quota-exceeded errors in Cloud Logging → request quota increase from GCP
- Memory OOM errors → increase `memory` setting for the function

### 2.2 Stateless Design

No Cloud Function instance stores any mutable state in process memory between requests. This is what allows horizontal scaling.

**Prohibited patterns:**
```javascript
// NEVER: in-process cache that grows between requests
let productCache = {};
exports.getProduct = onCall({}, async (req) => {
  if (productCache[req.data.id]) return productCache[req.data.id];  // WRONG
  ...
});

// CORRECT: use Redis with TTL or Firestore for caching
exports.getProduct = onCall({}, async (req) => {
  const cached = await RedisCache.get(`product:${req.data.id}`);
  if (cached) return cached;
  ...
});
```

**Allowed in-process state:**
- Firestore client singleton (`const db = admin.firestore()`) — connection pooling, not business state
- Redis client singleton — connection pooling only
- Read-only configuration loaded at cold start (feature flags, environment config)

### 2.3 Queue-Based Load Levelling

Traffic spikes are absorbed by queues rather than passed directly to downstream systems. This prevents spike-induced failures and smooths load.

**Current queues (Redis-backed):**
```
notification   → dispatched at 10/second (Africa's Talking SMS rate limit)
email          → dispatched at 100/second (SendGrid rate limit)
ai             → dispatched at 5/second (Anthropic rate limit)
receipt        → dispatched at 50/second
sms            → dispatched at 10/second
report         → dispatched at 2/second (heavy computation)
bulk           → dispatched at 1/second (import jobs)
webhook        → dispatched at 20/second
```

**How it absorbs spikes:**
- At month-end, 10,000 notification requests may arrive in 60 seconds
- Without queue: notification CF receives 10,000 concurrent invocations; Africa's Talking rate-limited; most fail
- With queue: 10,000 items pushed to Redis notification queue; worker dispatches at 10/second (rate-limited); all delivered within ~17 minutes; no failures

**Queue depth monitoring:** Alert fires if any queue exceeds depth 1,000. This indicates queue worker is behind and upstream needs to slow down.

### 2.4 Read-Replica Pattern (Future Gate 2)

At 500K DAU, Firestore reads may become the primary cost centre. At that point, introduce a read-cache tier:

```
Current: Client → Cloud Function → Firestore
Future:  Client → Cloud Function → Redis (cache miss?) → Firestore

Cache layer:
  Product catalog:     Redis, 60s TTL
  Seller profiles:     Redis, 300s TTL
  Category listing:    Redis, 60s TTL
  Platform config:     Redis, 3600s TTL (static config)
  
Invalidation: Firestore trigger on document write → Redis DEL on affected keys
```

This alone can reduce Firestore reads by 60–80% for catalog-heavy traffic patterns.

---

## 3. Database Scaling

### 3.1 Firestore — Native Horizontal Scaling

Firestore scales automatically to millions of documents per collection, thousands of concurrent connections, and millions of reads/writes per second across the database. The per-collection and per-database limits that matter are:

| Limit | Value | SOKONI Status |
|---|---|---|
| Composite indexes per database | 200 | 197+ (critical — see §3.5) |
| Document size | 1MB | All documents < 10KB |
| Writes per document per second | 1 | Mitigated by distributed counters |
| Writes per collection per second | No hard limit | Distributes via Firestore tablets |
| Reads per second (total) | No hard limit | Scales automatically |

### 3.2 Hot Document Problem

A "hot document" is a single Firestore document receiving more than 1 write/second. This is the most common Firestore scaling failure mode.

**Risk inventory:**
```
High risk:   Platform counters (total orders, total GMV)
             → Mitigated: distributed counters (10 shards)

Medium risk: Merchant daily analytics document
             → Mitigated: FieldValue.increment (server-side, atomic, batch-friendly)

Low risk:    Individual product.stockQty
             → At 10,000 sales/day for a single product:
                = 0.12 writes/second → well within limit
             → At 1M sales/day: = 11 writes/second → WOULD hit limit
             → Mitigation: Redis inventory reservation; Firestore deducted
                only on confirmed payment (not on each reservation)

No risk:     Orders collection, payments, notifications
             → Each document written once; reads dominate
```

### 3.3 Large Collection — Time-Based Partitioning

At high volume, querying across all documents in a large collection becomes expensive. Time-based partitioning keeps query windows small.

**Pattern: Annual partitioned collections (planned for Gate 3)**

When `orders` collection exceeds 5 million documents:
```
Current:   orders/{auto-id}                  all time
Partitioned: orders_2026/{auto-id}
             orders_2027/{auto-id}
             ...
```

Query within year: direct to `orders_2026`
Query cross-year: fan-out with `Promise.all([q2026, q2025])` merged in CF

**When to partition:** When a collection exceeds 5 million documents AND query time on the collection regularly exceeds 500ms P95. Partitioning before this point adds complexity without benefit.

### 3.4 Backup and Recovery

| Mechanism | Coverage | RPO | RTO |
|---|---|---|---|
| PITR (Point-in-Time Recovery) | All Firestore data | 1 minute | ~30 minutes |
| Nightly export to Cloud Storage | All Firestore data | 24 hours | ~4 hours |
| Redis — no backup | Operational state only | N/A (fallback to Firestore) | Immediate |
| Cloud Storage — no PITR | Media files | 24 hours (lifecycle rule) | ~1 hour |

**Recovery procedure:**
1. Minor data loss (< 7 days): use PITR to restore to a point-in-time
2. Major incident requiring rollback: restore from nightly export (Cloud Storage → Firestore import)
3. Partial collection restore: restore nightly export to a temporary database, copy specific documents

### 3.5 Index Budget Management

**Current state:** 197+ of 200 composite indexes used. 2–3 slots remaining.

**Gate criteria before adding a new index:**
1. Check `docs/FIRESTORE-INDEX-ARCHITECTURE.md` — is an equivalent index already covering this query?
2. Can the query be restructured to use an existing index?
3. Is this for a consumer-facing feature (justified) or admin analytics (use `sokoni-ops` second DB)?

**Index hygiene process (quarterly):**
1. Export all indexes from Firebase CLI: `firebase firestore:indexes`
2. Compare against query logs (Cloud Logging) — identify indexes with zero reads in 90 days
3. Do NOT delete them. Flag as "candidate for `sokoni-ops` migration"
4. When new indexes are needed and primary DB is full, migrate flagged indexes to `sokoni-ops`

### 3.6 Redis — Scaling the Operational Layer

Current Redis: Google Cloud Memorystore, Standard tier, 1GB, single zone.

| Scale Gate | Redis Action |
|---|---|
| > 500 concurrent POS terminals | Upgrade to 4GB Memorystore instance |
| > 2,000 concurrent riders | Upgrade to 8GB, enable read replica |
| > 1,000 active payment locks simultaneously | Increase memory; monitor eviction rate |
| > 10,000 concurrent users | Cluster mode (Redis 7 Cluster, 3 primaries) |
| Multi-region expansion | Redis Enterprise Active-Active or regional Memorystore per region |

**Memory sizing formula:**
```
POS cart (per terminal): ~2KB
Rider presence (per rider): ~0.5KB
User session (per active user): ~1KB
Rate limit counters (per active user): ~0.2KB
Queue items (per queued job): ~1KB

At 10,000 concurrent users:
  Sessions:         10,000 × 1KB  = 10MB
  Rate limiters:    10,000 × 0.2KB = 2MB
  POS carts (500 terminals): 500 × 2KB = 1MB
  Queued jobs:      5,000 × 1KB   = 5MB
  AI cache:         ~100MB (most impactful)
  Search cache:     ~50MB
  Total estimate:   ~170MB

Current 1GB Memorystore provides 5× headroom at this scale.
Upgrade to 4GB at >5,000 concurrent users.
```

---

## 4. Traffic Patterns

### 4.1 Daily Traffic Profile (Kenya)

SOKONI traffic follows predictable daily patterns aligned with Kenyan daily rhythms:

```
Traffic intensity (relative to daily average = 1.0×):

00:00  ██░░░░░░░░░░░░  0.15× (very low — night)
01:00  █░░░░░░░░░░░░░  0.10×
02:00  █░░░░░░░░░░░░░  0.08×
03:00  █░░░░░░░░░░░░░  0.07×
04:00  █░░░░░░░░░░░░░  0.08×
05:00  ██░░░░░░░░░░░░  0.15×
06:00  ████░░░░░░░░░░  0.40× (morning commute starts)
07:00  ████████░░░░░░  0.80× (commute peak)
08:00  ██████████░░░░  1.00× (peak 1: commute + work start)
09:00  ████████░░░░░░  0.85×
10:00  ██████░░░░░░░░  0.70×
11:00  ███████░░░░░░░  0.75×
12:00  █████████░░░░░  0.95× (lunch hour starts)
13:00  ██████████████  1.40× (PEAK 2: lunch orders)
14:00  ██████████░░░░  1.10×
15:00  ████████░░░░░░  0.80×
16:00  ████████░░░░░░  0.85× (schools out, commute)
17:00  ██████████░░░░  1.05×
18:00  █████████████░  1.30× (evening commute + home delivery)
19:00  ██████████████  1.50× (PEAK 3: evening shopping)
20:00  █████████████░  1.35× (peak evening)
21:00  ████████████░░  1.20×
22:00  █████████░░░░░  0.90×
23:00  ████░░░░░░░░░░  0.40×
```

**Implication:** System must handle 1.5× average at 19:00–20:00 every day. Infrastructure sizing must use 2× average as the baseline to provide safety headroom.

### 4.2 Weekly Traffic Profile

```
Monday     0.90× average   (start of week, moderate)
Tuesday    1.00× average
Wednesday  1.05× average   (mid-week peak)
Thursday   1.00× average
Friday     1.20× average   (end-of-week; payday for many weekly workers)
Saturday   1.40× average   (weekend shopping; highest day)
Sunday     1.10× average
```

**Implication:** Saturday evening (Saturday + 19:00–20:00) is the absolute peak period. Deployments must not be scheduled on Saturday.

### 4.3 Monthly Traffic Profile

**Salary days** create the largest single traffic spikes:
- Government salaries: 15th or last business day of month
- Corporate salaries: 25th–31st of month
- Expected spike: 2×–3× normal traffic on salary days

**Planning for salary-day spikes:**
1. Run `firebase functions:config` to enable `PEAK_MODE=true` flag 24h before expected salary date
2. Pre-warm critical CFs by warming minInstances on checkout and payment functions
3. Increase Redis memory allocation temporarily
4. Defer non-critical scheduled jobs on the day
5. Alert threshold lowered from P95 > 3s to P95 > 2s (earlier warning)

### 4.4 Geographic Distribution (Kenya)

| Region | Traffic Share | Key Feature Usage |
|---|---|---|
| Nairobi (CBD + suburbs) | 60% | Marketplace, SmartPOS, Delivery, Jobs |
| Mombasa | 15% | Marketplace, Food Hub, Property |
| Kisumu | 8% | Marketplace, Healthcare, Education |
| Nakuru | 5% | Marketplace, Vehicles |
| Eldoret | 4% | Marketplace, Healthcare |
| Other Kenya | 8% | Marketplace |

**Implication for infrastructure:**
- Single-region deployment (`us-central1`) adds ~200–250ms latency to all Kenyan users (via Google backbone)
- Firebase Hosting CDN caches static assets at regional PoPs — page load is fast
- API calls (Cloud Functions) go to `us-central1` — 200–250ms one-way RTT from Kenya
- Future: consider `africa-south1` (Johannesburg) for API deployment when it supports Gen2 CFs

### 4.5 Device and Network Distribution

| Metric | Distribution | Design Implication |
|---|---|---|
| Mobile traffic | 85% | Mobile-first PWA; all layouts tested at 375px |
| Desktop traffic | 15% | Desktop layout tested at 1440px |
| Android share | 78% of mobile | Primary test device |
| iOS share | 22% of mobile | Secondary; Web Bluetooth/USB limited |
| 4G/LTE | 55% | Target network |
| 3G | 30% | Must be functional; max 500ms API round-trip |
| 2G/EDGE | 15% | Service Worker offline cache is critical for this segment |
| Data saver mode | 35% | Lazy loading, WebP, minimal JS on critical paths |

**Network latency budget at 3G:**
```
DNS lookup:    50ms
TCP connect:   150ms
TLS handshake: 150ms
HTTP request:  50ms (via Firebase SDK)
API response:  150ms (CF execution)
DOM processing:100ms
Total RTT:     ~650ms

This is within the 1s LCP target for a cached PWA shell.
First-visit load at 3G: ~3.5s (within P95 target of 3.5s).
```

---

## 5. Growth Projections and Architecture Gates

### 5.1 Growth Gate Overview

| Gate | Users (DAU) | Daily Transactions | Key Architecture Action |
|---|---|---|---|
| Current | 1K–10K | 5K–50K | None — baseline architecture |
| Gate 1 | 100K | 500K | minInstances on critical CFs; Redis caching expansion |
| Gate 2 | 500K | 2.5M | Multi-region Firestore; CDN expansion; search scaling |
| Gate 3 | 1M | 5M | Collection sharding; Redis cluster; read cache layer |
| Gate 4 | 5M | 25M | Full service isolation; dedicated databases per domain |
| Gate 5 | 10M+ | 50M+ | Separate data centres; event streaming (Pub/Sub); BigQuery |

### 5.2 Gate 1 — 100K DAU / 500K Daily Transactions

**Trigger:** Sustained 100K DAU for 2 weeks, or 500K daily transactions for 1 week.

**What changes:**

```
Cloud Functions:
  Add minInstances: 1 to:
    verifyIntasendPayment
    checkoutSessions
    sokoniSearch
    createPayment
    posUpdateCart
    sendNotification
    updatePosSession

Redis:
  Upgrade Memorystore to 4GB (from 1GB)
  Enable Redis AUTH (if not already enforced)
  Expand AI response cache TTL from 1h to 4h (more cache hits at volume)
  Add product catalog cache: Redis, 60s TTL (reduce Firestore reads)

Firestore:
  Review index usage; migrate any zero-use indexes to sokoni-ops
  Enable Firestore multi-region (nam5) — planned, gate 1 is the trigger

CDN:
  Enable Cloudflare for all traffic (not just canary)
  Set Cloudflare cache TTL: 60s for /api/catalog/* (public catalog endpoints)
  Enable Cloudflare rate limiting (5,000 req/min per IP) as first-line DDoS defence

Search:
  Review Typesense plan tier — upgrade if hitting record/operation limits
  Enable Algolia as active failover (not passive): circuit breaker threshold = 3 failures

Monitoring:
  Lower alert thresholds (P95 latency > 1.5s instead of 3s)
  Add per-function cold start monitoring
  Add Firestore read cost daily budget alert
```

**Estimated cost increase at Gate 1:** 3×–5× current Firebase bill.  
**Bottleneck at Gate 1:** Most likely Cloud Function cold starts on payment paths.

### 5.3 Gate 2 — 500K DAU / 2.5M Daily Transactions

**Trigger:** Sustained 500K DAU for 2 weeks.

**What changes:**

```
Firestore:
  Multi-region must be active (should have been done at Gate 1 — if not, mandatory now)
  Implement distributed counters for platform metrics (10 shards each)
  Introduce time-bucketed analytics events (hourly bucket pattern)
  Begin migrating heavy analytical queries to BigQuery

Cloud Functions:
  Increase minInstances: 2 on critical paths (2 instances always warm)
  Add region: ['us-central1', 'africa-south1'] if available, else ['us-central1']
  Audit and increase maxInstances caps: payment → 2000, search → 2000

Redis:
  Upgrade to Redis cluster (3 primary shards) via Memorystore Cluster
  Implement consistent hashing for key distribution across shards
  Add Redis replica for read scaling of non-transactional lookups

Search:
  Typesense: enable multi-node cluster (3 nodes minimum for HA)
  Algolia: upgrade to Business plan (higher operation limits)
  Add search result caching layer in Redis (reduce Typesense calls by ~70%)

CDN:
  Enable CDN for API responses via Cloudflare:
    /api/catalog/* → 60s CDN cache (vary: Accept-Language)
    /api/products/{id} → 300s CDN cache
    /api/search/* → 30s CDN cache with query-key normalisation
  Configure Cloudflare Workers for edge authentication check (JWT verification at edge)

Email and SMS:
  Upgrade SendGrid plan to accommodate volume
  Add Africa's Talking dedicated short code (reduces SMS cost at scale)
  Implement email batching: aggregate daily digest instead of one email per event
```

**Estimated cost increase at Gate 2:** 10×–15× current Firebase bill.  
**Bottleneck at Gate 2:** Firestore write throughput for high-frequency collections (analytics events, notifications).

### 5.4 Gate 3 — 1M DAU / 5M Daily Transactions

**Trigger:** Sustained 1M DAU for 2 weeks.

**What changes:**

```
Architecture restructuring required:

Firestore:
  Partition orders collection by year: orders_2026, orders_2027
  Partition analytics events by day: analyticsEvents_{YYYY-MM-DD}
  Move all analytical workloads to BigQuery (daily export pipeline)
  Implement change data capture (CDC) to BigQuery for real-time analytics
  Review all collections > 10M documents for partitioning

Read cache layer:
  Introduce dedicated cache service (separate Redis cluster, read-only)
  Cache all product catalog reads: TTL 300s
  Cache all seller profiles: TTL 600s
  Cache all category listings: TTL 120s
  Cache invalidation: pub/sub pattern (write → invalidation message → cache DEL)

Search:
  Consider Typesense cluster with geographic distribution
  Implement search personalisation: per-user ranking based on purchase history

Notifications:
  Move to dedicated Cloud Pub/Sub topic per notification channel
  Replace Redis-queued notifications with Pub/Sub push subscriptions
  Pub/Sub provides 7-day message retention and guaranteed delivery

Payment processing:
  Introduce dedicated payment processing service (separate CF namespace)
  Add IntaSend webhook processing to dedicated high-minInstances function (minInstances: 5)
  Consider adding a secondary payment provider for redundancy

Monitoring:
  Introduce OpenTelemetry distributed tracing
  Deploy Cloud Trace for all CF invocations
  Add per-user error budget tracking (SLO-based alerting)
  Introduce synthetic monitoring: browser-based end-to-end tests every 5 minutes
```

**Estimated cost increase at Gate 3:** 30×–50× current Firebase bill.  
**Bottleneck at Gate 3:** Firestore write throughput for analytics and notification collections.

### 5.5 Gate 4 — 5M DAU / 25M Daily Transactions

**Trigger:** Sustained 5M DAU.

**What changes:**

```
Full microservices isolation:
  Each service domain gets its own Firestore database (orders, payments, marketplace, etc.)
  Cross-domain queries go through service APIs, not direct Firestore access
  Service-to-service authentication via GCP service accounts (not Firebase Auth)

Infrastructure:
  Move from Cloud Functions to Cloud Run services for high-throughput domains
  Payment processing: dedicated Cloud Run service (always-on, auto-scaled)
  Search: dedicated Cloud Run service wrapping Typesense client
  AI: dedicated Cloud Run service with GPU-backed instances for ML models

BigQuery:
  Real-time BigQuery Streaming API for analytics events
  Looker Studio dashboards for merchant analytics (replace custom analytics CF)
  ML models trained on BigQuery data exported to Vertex AI

Redis:
  Dedicated Redis instances per domain (payment locks, AI cache, session cache)
  Redis active-active multi-region for global platform

Global expansion:
  Cloudflare Workers for global edge routing
  Firestore in multiple regions with routing rules
  Payment providers per region (IntaSend Kenya; Flutterwave West Africa; etc.)
```

**Estimated cost at Gate 4:** Budget planning required; likely $50K–$200K/month infrastructure.

### 5.6 Gate 5 — 10M+ DAU

At this scale, SOKONI is one of the largest consumer platforms in sub-Saharan Africa. The architecture becomes indistinguishable from Tier-1 platform engineering:
- Event streaming via Cloud Pub/Sub or Apache Kafka
- Dedicated data warehouse (BigQuery)
- ML model serving via Vertex AI
- Multi-cloud redundancy
- Dedicated SRE team with on-call rotation
- SOC 2 Type II certification

This gate is referenced for planning purposes only. Architecture decisions at Gates 1–3 must not be over-engineered for Gate 5.

---

## 6. Cost Scaling Model

### 6.1 Firebase Cost Drivers (in order of impact at scale)

1. **Cloud Functions invocations and compute time** — scales linearly with API call volume
2. **Firestore reads** — the largest cost driver at scale (catalog reads dominate)
3. **Firestore writes** — lower cost per operation but high volume
4. **Cloud Storage egress** — product images; mitigated by CDN caching
5. **Firebase Hosting bandwidth** — static assets; mitigated by SW cache + CDN
6. **Outbound data (internet egress)** — Firebase SDK, webhook deliveries

### 6.2 Cost Optimisation Techniques (in priority order)

| Technique | Impact | Effort | When to implement |
|---|---|---|---|
| Redis catalog caching (60s TTL) | Reduces Firestore reads by 60–80% | Low | Gate 1 |
| WebP images (30–50% smaller) | Reduces Storage egress | Low | Already implemented |
| Service Worker (SW cache) | Reduces Hosting bandwidth by 60% on repeat visits | Low | Already implemented |
| Lazy image loading | Reduces bandwidth per page view | Low | Already implemented |
| Field selection (`select()`) | Reduces Firestore read bytes | Medium | Gate 1 — audit all reads |
| Pagination (cursor-based) | Prevents unbounded reads | Medium | Already implemented |
| Analytics to BigQuery | Removes high-volume Firestore read/write for analytics | High | Gate 2 |
| Cloudflare caching for catalog API | Reduces CF invocations by 40–70% for public catalog | Medium | Gate 1 |
| minInstances reduction (non-critical) | Reduces idle CF cost | Low | Ongoing audit |

### 6.3 Firestore Read Reduction via Field Selection

Firestore charges per document read, regardless of how many fields are read. However, using projected queries (`.select()`) reduces bandwidth cost.

For high-frequency collection scans:
```javascript
// EXPENSIVE: reads all fields (charged per document)
const snap = await db.collection('products').where('categoryId', '==', id).get();

// CHEAPER: reads only needed fields (same per-document charge but less network transfer)
const snap = await db.collection('products')
  .where('categoryId', '==', id)
  .select('name', 'price', 'thumbnailUrl', 'sellerId', 'rating')
  .get();
```

At 1M product reads/day with 200-field documents vs 5-field projected reads: estimated 40× bandwidth reduction (cost saving on egress; per-document charge unchanged).

---

## 7. Scaling Anti-Patterns to Avoid

These are the patterns that look like solutions but create new problems at scale. They are documented here to prevent re-introduction.

### 7.1 Global Singleton Counter Documents

**Anti-pattern:**
```javascript
// BAD: single document receiving thousands of increments per minute
await db.collection('stats').doc('platform').update({
  totalOrders: FieldValue.increment(1)
});
```

**Problem:** Hits Firestore's 1 write/second per document limit. At 100 orders/minute, this causes write contention and throttle errors.

**Correct pattern:** Distributed counters (10 shards, pick random shard per write; sum all shards on read).

---

### 7.2 Unbounded Collection Scans

**Anti-pattern:**
```javascript
// BAD: reads all documents with no limit
const snap = await db.collection('orders').where('status', '==', 'pending').get();
```

**Problem:** At 1 million orders, this reads 1 million documents. Cost scales with collection size.

**Correct pattern:** Always paginate with cursor-based pagination. Admin functions that genuinely need full scans should run as scheduled jobs that aggregate incrementally, not on-demand.

---

### 7.3 Nested Arrays for High-Cardinality Data

**Anti-pattern:**
```javascript
// BAD: orderItems stored as array inside order document
orders/{orderId}: {
  items: [{ productId, qty, price }, { productId, qty, price }, ...]
}
```

**Problem:** Firestore document size limit is 1MB. An order with many items will approach this limit. Array-in-document also prevents efficient querying of individual items.

**Correct pattern:** Subcollection `orders/{orderId}/items/{itemId}` for variable-length data.

---

### 7.4 Real-Time Listeners on Large Collections

**Anti-pattern:**
```javascript
// BAD: subscribing to the entire orders collection
db.collection('orders').onSnapshot(snap => { ... });
```

**Problem:** At 1 million orders, this downloads the entire collection on first listen and re-downloads changed documents on every write. Enormous bandwidth and Firestore cost.

**Correct pattern:** Scoped listeners — always include a `where()` clause limiting scope (e.g. `where('sellerId', '==', uid)`).

---

### 7.5 Synchronous Webhook Processing

**Anti-pattern:**
```javascript
// BAD: long-running business logic in webhook handler
exports.intasendWebhook = onRequest({}, async (req, res) => {
  await verifyPayment(req.body);
  await updateOrder(req.body);
  await calculateCommission(req.body);
  await sendNotification(req.body);
  await updateLoyaltyPoints(req.body);
  res.json({ ok: true });  // 5+ seconds later
});
```

**Problem:** Webhook providers (IntaSend) retry if they don't receive a response within 10–30 seconds. Long processing causes retries, duplicate events, and cascade failures.

**Correct pattern:** Acknowledge immediately, process asynchronously via event bus:
```javascript
exports.intasendWebhook = onRequest({}, async (req, res) => {
  verifyHMAC(req);                          // fast
  await EventBus.publish('payment.webhook.received', req.body);  // fast
  res.json({ ok: true });                   // < 200ms total
  // Event bus subscriber processes asynchronously
});
```

---

## 8. Runbook — How to Scale Each Component

### 8.1 Scaling Cloud Functions (quota increase)

When CF invocations hit quota limits:
1. Check current quota: GCP Console → IAM & Admin → Quotas → filter "Cloud Run" → "Cloud Run requests per 100 seconds"
2. Request quota increase: click "Edit Quotas" → select region `us-central1` → set new limit → submit request (usually granted within 48h)
3. While waiting: reduce maxInstances on non-critical CFs to free capacity for critical paths

### 8.2 Scaling Firestore (index overflow)

When primary Firestore DB hits 200 index limit:
1. Run `firebase firestore:indexes --project sokoni-aeb26 > current-indexes.json`
2. Identify analytical queries in `current-indexes.json` (high-cardinality, admin-only)
3. For each candidate: update the query to use `sokoni-ops` Firestore client
4. Delete the index from primary DB: `firebase firestore:delete-index --index-id {id}`
5. Add the index to `sokoni-ops`: add to `firestore-ops.indexes.json` and deploy
6. Update `docs/FIRESTORE-INDEX-ARCHITECTURE.md` with the migration record

### 8.3 Scaling Redis (memory increase)

When Redis memory utilisation > 80%:
1. Check current memory: Redis Monitor (`redis-monitor.html`) → Memory panel
2. Identify largest key groups: `MEMORY USAGE sokoni:ai:cache:*` in Redis CLI
3. Option A: Reduce cache TTLs (AI cache 1h → 30m; search cache 60s → 30s) — immediate, small impact
4. Option B: Upgrade Memorystore instance size (GCP Console → Memorystore → Edit → change tier)
   - Note: Memorystore resize requires a failover; Firestore fallback activates during ~30s failover
   - Schedule for lowest-traffic period (03:00–05:00 EAT)

### 8.4 Scaling the Notification System

When notification queue depth > 1,000 (backlog building):
1. Check queue worker health: `redisScheduledQueueWorker` in CF logs — is it running?
2. If worker is healthy but queue is deep: rate limit from downstream provider (Africa's Talking SMS)
   - Short-term: increase notification worker concurrency (`maxInstances` on worker CF)
   - Long-term: batch SMS notifications (aggregate > 1 notification to same user into single SMS)
3. If worker is failing: check CF error logs for the cause, fix, redeploy

### 8.5 Responding to a Traffic Spike

When monitoring shows traffic at 5× normal:
1. Check CF auto-scaling: GCP Console → Cloud Functions → select function → "Max active instances" — it should be auto-scaling
2. Check error rate: if < 2%, auto-scaling is working; no action needed
3. If error rate > 2%: check which function is failing (Cloud Logging filter: `severity=ERROR`)
4. For payment CFs: increase `minInstances` immediately to 3 via Cloud Console
5. For DB errors: check Firestore quota (GCP Console → Quotas → Firestore)
6. Post-incident: document the spike in `docs/ops-reports/` and adjust baseline capacity

---

## Related Documents

- [[ARCHITECTURE]] — Full platform architecture reference (v4.0)
- [[SCALABILITY_REVIEW]] — Point-in-time review of current capacity (2026-06-25)
- [[SCALING_TRIGGERS]] — 12 scaling trigger thresholds with automated responses
- [[OPS_RUNBOOK]] — Day-to-day operational procedures
- [[COST_GOVERNANCE]] — Cost management policies and budget controls
- [[PERFORMANCE_BUDGET]] — Performance budgets per page and API endpoint
- [[ROADMAP]] — Feature roadmap and planned phases

---

*Last updated: 2026-07-08 | Version: 1.0 | Next review: at Gate 1 (100K DAU)*
