# SOKONI Typesense Search Architecture v2.0

**Status:** Production  
**Scale Target:** 1,000,000+ concurrent users, 50M+ searchable documents  
**Last Updated:** 2026-06-20

---

## Overview

SOKONI's search infrastructure is powered by a self-hosted Typesense cluster providing sub-150ms p99 latency at scale. The architecture is split across three layers:

1. **Cloud Functions pipeline** — ingestion, indexing, monitoring, backup, reconciliation
2. **Browser engine** — multi-layer cached client with voice, geo, and offline support
3. **Recommendations engine** — personalisation, FBT, cross-sell, upsell, zero-result recovery

---

## Architecture Diagram

```
┌──────────────────────────────────────────────────────────────┐
│                       BROWSER CLIENTS                        │
│                                                              │
│  sokoni-typesense-engine.js        sokoni-search-recs.js     │
│  ├── L1 Memory Cache (30s)         ├── Co-occurrence Matrix  │
│  ├── L2 SessionStorage (5min)      ├── Recently Viewed       │
│  ├── L3 IndexedDB (1hr SWR)        ├── FBT / Cross-sell      │
│  ├── Multi-node Round-robin        ├── Upsell                │
│  ├── Per-node Circuit Breaker      ├── Personalised Feed     │
│  ├── Voice Search (en-KE)          └── Zero-result Recovery  │
│  ├── Geo Filter/Sort                                         │
│  ├── Offline Queue (IndexedDB)                               │
│  ├── Hover Prefetch                                          │
│  └── Infinite Scroll Cursor                                  │
└───────────────────────┬──────────────────────────────────────┘
                        │ X-TYPESENSE-API-KEY (scoped, short-lived)
┌───────────────────────▼──────────────────────────────────────┐
│                   TYPESENSE HA CLUSTER                       │
│                                                              │
│   Node 1 ──── Node 2 ──── Node 3                            │
│   (leader)    (follower)  (follower)                         │
│   443/https   443/https   443/https                          │
│                                                              │
│   25 Collections  ·  Aliases  ·  Synonyms  ·  Presets       │
└───────────────────────┬──────────────────────────────────────┘
                        │ Admin API key (Firebase Secrets)
┌───────────────────────▼──────────────────────────────────────┐
│                  CLOUD FUNCTIONS (Node 18)                   │
│                                                              │
│  SYNC (75 triggers)          QUEUE (priority)                │
│  ├── 25 collections × 3      ├── URGENT  (price/stock)       │
│  └── onCreate/Update/Delete  ├── HIGH    (new listings)      │
│                              ├── NORMAL  (edits)             │
│  ADMIN                       ├── LOW     (reviews)           │
│  ├── createCollections       └── BATCH   (re-index)          │
│  ├── backfill                                                │
│  ├── collectionStats         SECURED KEYS                    │
│  ├── canaryDeploy            ├── HMAC-SHA256 scoped keys     │
│  └── deleteOrphans           ├── Per-role TTL/RPH            │
│                              └── IP + user rate limits       │
│  MONITOR (every 5/15min)                                     │
│  ├── nodeStatuses            RECONCILE (daily 04:00)         │
│  ├── latencyProbes (p99)     ├── Count divergence check      │
│  ├── queueDepth check        ├── 200-doc spot checks         │
│  └── adminAlerts             └── Auto-repair enqueue         │
│                                                              │
│  BACKUP (daily 01:00)        ANALYTICS                       │
│  ├── 25 collections JSONL    ├── search events               │
│  ├── Firestore (< 5k docs)   ├── click/conversion            │
│  ├── Cloud Storage (≥ 5k)    ├── autocomplete                │
│  └── 7d/4w/3m rotation       └── trending generation         │
└───────────────────────┬──────────────────────────────────────┘
                        │ Firestore triggers
┌───────────────────────▼──────────────────────────────────────┐
│                    FIRESTORE (Source of Truth)               │
│                                                              │
│  Business Collections (25 mapped Typesense targets)         │
│  Queue: typesenseQueue · typesenseQueueDLQ                  │
│  Monitor: tsMonitor · tsHealthLog · tsLatencyLog            │
│  Backup: tsBackupMeta · tsBackupDocs                        │
│  Reconcile: tsReconcileLog                                  │
│  Keys: tsKeyAuditLog · tsRateLimits                         │
│  Analytics: tsSearchEvents · tsQueryStats · tsClickStats    │
└──────────────────────────────────────────────────────────────┘
```

---

## Collections (25 Total)

| Collection | Firestore Source(s) | Key Query Fields | Geo |
|---|---|---|---|
| `sokoni_products` | `products` | name, brand, category, tags | ✓ |
| `sokoni_shops` | `sellers` | name, category, tags | ✓ |
| `sokoni_services` | `providers`, `services` | name, category, providerName | ✓ |
| `sokoni_events` | `events` | title, category, venue | ✓ |
| `sokoni_properties` | `propertyListings`, `properties` | title, type, amenities | ✓ |
| `sokoni_vehicles` | `cars` | make, model, features | ✓ |
| `sokoni_jobs` | `jobs`, `digitalJobs`, `digitalGigs` | title, company, skills | ✓ |
| `sokoni_hotels` | `bnbListings`, `hotels` | name, amenities, roomTypes | ✓ |
| `sokoni_restaurants` | `foods` | name, cuisine, features | ✓ |
| `sokoni_sports` | `fitness_clubs`, `fitness_classes` | name, sport, facility | ✓ |
| `sokoni_healthcare` | `healthcare` | name, specialties | ✓ |
| `sokoni_education` | `education` | title, subject, level | ✗ |
| `sokoni_professionals` | `lawyers` | name, profession, skills | ✓ |
| `sokoni_reviews` | `reviews`, `digitalReviews`, `legalReviews` | comment, tags | ✗ |
| `sokoni_users` | `users` | displayName, bio, skills | ✓ |
| `sokoni_categories` | `categories` | name, description | ✗ |
| `sokoni_brands` | `brands` | name, description | ✗ |
| `sokoni_collections` | `collections` | name, tags | ✗ |
| `sokoni_coupons` | `coupons` | code, name, description | ✗ |
| `sokoni_support` | `support` | title, content | ✗ |
| `sokoni_faq` | `faq` | question, answer | ✗ |
| `sokoni_blog` | `blog` | title, content, tags | ✗ |
| `sokoni_announcements` | `announcements` | title, body | ✗ |
| `sokoni_tourism` | `tourism` | name, activities | ✓ |
| `sokoni_entertainment` | `entertainment` | name, genre, artistName | ✓ |

---

## Ranking Fields

Every document in every collection carries four computed ranking fields:

| Field | Formula | Use |
|---|---|---|
| `_popularityScore` | `log1p(orders×3 + views×1 + reviews×2) + featured_bonus` | Default sort |
| `_salesScore` | `log1p(orders×3 + conversions×5)` | Sales-weighted ranking |
| `_clickScore` | `log1p(clicks×1 + views×0.1)` | Engagement ranking |
| `_conversionScore` | `log1p((orders/views)×1000)` | High-intent ranking |

Scores are recomputed in the Firestore trigger transformer on every write.

---

## Priority Queue (5 Tiers)

```
URGENT (0)  — price, stock, status changes     → processed first
HIGH   (1)  — new products, events, jobs        → within 30s
NORMAL (2)  — edits, metadata updates           → within 2min
LOW    (3)  — reviews, ratings                  → within 10min
BATCH  (4)  — bulk re-index, reconcile repairs  → background
```

Processing order: `nextAttemptAt ASC` fetched from Firestore, then sorted in-memory by `[priority ASC, nextAttemptAt ASC]`.

Dead-letter queue: items failing 4 times → `typesenseQueueDLQ`. Reprocessable via `typesenseReprocessDLQ`.

---

## Zero-Downtime Reindex (Blue-Green)

1. Create versioned collection: `sokoni_products_v2`  
2. Run `typesenseBackfill` into `sokoni_products_v2`  
3. Apply synonyms and presets to `sokoni_products_v2`  
4. Swap alias atomically: `sokoni_products` → `sokoni_products_v2`  
5. Traffic is now on the new collection with no downtime

---

## Canary Deployment

- `typesenseCanaryDeploy` stores a `tsCanaryConfig/{collectionName}` doc in Firestore
- Contains `{ canaryVersion, trafficPercent, enabled }`
- Browser client can read this doc and route `trafficPercent`% of requests to the canary version
- At 100% traffic, run `typesenseCanaryDeploy` again with `commit: true` to swap the alias permanently

---

## Secured API Keys

Keys are issued by `getTypesenseSearchKey` Cloud Function using HMAC-SHA256 scoped key format:

```
Base64( HMAC-SHA256_hex(JSON.stringify(params), searchOnlyKey) + JSON.stringify(params) )
```

Per-role configuration:

| Role | TTL | RPH | Filter |
|---|---|---|---|
| guest | 15min | 500 | `status:=active` |
| buyer | 1hr | 1,000 | `status:=active` |
| seller | 1hr | 2,000 | none |
| provider | 1hr | 2,000 | none |
| driver | 30min | 1,000 | products/shops/services only |
| moderator | 1hr | 5,000 | none |
| admin | 4hr | 10,000 | none |
| superAdmin | 4hr | 10,000 | none |

Rate limits: sliding 1-hour window per user ID and per IP, stored in `tsRateLimits`. Audit log in `tsKeyAuditLog`.

---

## SLA Targets

| Metric | Target | Alert Threshold |
|---|---|---|
| Search latency p99 | < 150ms | ≥ 150ms → warning, ≥ 300ms → critical |
| Cluster availability | > 99.9% | minority unhealthy → warning, majority → critical |
| Queue depth | < 10,000 | ≥ 10k → warning, ≥ 20k → critical |
| DLQ depth | < 50 | ≥ 50 → warning |

Health checks run every 5 minutes. Latency probes run every 15 minutes against 7 representative collections.

---

## Browser Cache Hierarchy

```
L1 → In-memory Map        30s TTL   2,000 entries LRU
L2 → sessionStorage       5min TTL  persists tab navigation
L3 → IndexedDB            1hr TTL   stale-while-revalidate
```

Cache miss path: L1 → L2 → L3 → Typesense → store in all three.  
Stale L3 hit: return immediately, background-refresh, update cache.

---

## Offline Support

When `navigator.onLine === false`:
- Search requests are stored in `IndexedDB:offline` object store
- `OfflineQueue` listens for the `online` event
- On reconnect, all queued searches are replayed automatically
- The offline queue survives page reloads (IndexedDB is persistent)

---

## Files

| File | Purpose |
|---|---|
| `functions/typesense-client.js` | Node.js CF client: 25 schemas, circuit breaker, connection pool |
| `functions/typesense-queue.js` | 5-tier priority queue processor |
| `functions/typesense-sync.js` | 75 Firestore triggers (25 collections × 3) |
| `functions/typesense-admin.js` | Collection management, blue-green, canary |
| `functions/typesense-reconcile.js` | Daily consistency verification + auto-repair |
| `functions/typesense-monitor.js` | Cluster health + latency SLA + alerting |
| `functions/typesense-backup.js` | Daily backup, rotation, restore |
| `functions/typesense-secured-keys.js` | HMAC scoped key issuance + rate limiting |
| `functions/typesense-analytics.js` | Search analytics aggregation |
| `functions/index.js` | CF exports entrypoint |
| `sokoni-typesense-engine.js` | Browser search client (25 collections) |
| `sokoni-search-recommendations.js` | Personalisation + FBT + cross-sell + upsell |
| `sokoni-config.js` | Platform configuration (collection names, SLA targets) |
| `firestore.indexes.json` | All Firestore composite indexes |

---

## Related Documents

- [[TYPESENSE-DEPLOYMENT]] — step-by-step deployment guide
- [[TYPESENSE-RUNBOOK]] — operations runbook: incidents, scaling, restore
- [[SECURITY]] — API key management, Firestore rules
- [[CHANGELOG]] — version history
