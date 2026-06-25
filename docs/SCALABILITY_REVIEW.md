# SOKONI Scalability Review — v1.2

**Date:** 2026-06-25  
**Scope:** Architecture review using current production data and design decisions

---

## 1. Firestore

### Current state
- 190/200 composite indexes — **10 slots remaining**
- Primary concern: index pressure as platform expands

### Scaling well
- Per-user subcollections (`recentlyViewed/{uid}/items`, `savedSearches/{uid}/searches`) — linear fan-out, no cross-user queries
- Daily aggregate pattern (`funnelStats/{date}`, `ops_reports/{date}`) — O(days) reads regardless of event volume
- Hourly health snapshots with 30-day pruning — bounded storage

### Pressure points
| Pattern | Current scale | Risk at 100k users |
|---------|-------------|-------------------|
| `products` collection full scan | ~2000 docs | **HIGH** — `getMarketplaceQualityReport` scans up to 2000 products. Will need pagination or offload to BigQuery at >10k products |
| `orders` cross-seller queries | Bounded per seller | LOW — seller-scoped queries don't fan out |
| `priceAlerts` batch check (scheduler) | 500 alerts/run | MEDIUM — at 50k alerts, needs multi-batch pagination |
| `searchAnalytics` 30-day window | ~5k docs/day | MEDIUM — TTL policy needed |

### Recommendations
1. **Add Firestore TTL policy** on `searchAnalytics` (90-day retention) and `productViewDedup` (1-day) — prevents unbounded growth
2. **Paginate `getMarketplaceQualityReport`** — add cursor-based pagination when product count exceeds 2000
3. **Index budget management** — before v1.3, audit which indexes are actually queried (Firebase Console → Firestore → Usage). Remove unused compound indexes to free slots.
4. **Reserve 5 index slots for v1.3** — do not add speculative indexes for features not yet built

---

## 2. Cloud Functions

### Current state
- ~160+ deployed functions (Gen2, Node 22)
- Mix of `onCall`, `onSchedule`, `onDocumentUpdated`, `onRequest`
- Scheduled functions: daily ops report, weekly security, hourly health snapshot, daily price alerts, 6h product trending

### Scaling well
- `maxInstances` caps on public callables (e.g. `recordFunnelEvent` = 200) prevent runaway costs
- Fire-and-forget pattern for non-critical tracking (funnel events, recently viewed)
- `FieldValue.increment` for aggregates — avoids contention on hot documents

### Pressure points
| Function | Concern | Mitigation |
|---------|---------|-----------|
| `recordSearchQuery` | 200 maxInstances, but at high volume this might throttle | Monitor concurrency in Cloud Console |
| `triggerPriceAlerts` | Processes up to 500 alerts per run, emails each in serial | Batch email sends; paginate at 50k alerts |
| `recordHealthSnapshot` | Calls external `systemHealthCheck` API hourly | Add 10s timeout guard |
| Email trigger functions (31 deployed) | Cold start latency on low-volume events | Set `minInstances: 0` (current) is fine; upgrade to `minInstances: 1` only if email SLA requires it |

### Recommendations
1. **Audit scheduled function overlap** — currently 6+ scheduled jobs. Review whether any can be consolidated to reduce Cold Start contention.
2. **Idempotency on payment triggers** — `onOrderPaidUpdateStats` should guard against duplicate Firestore trigger fires (already using `FieldValue.increment` but verify).
3. **Function cold start SLA** — for user-facing callables (search, checkout), if p95 cold start > 2s, set `minInstances: 1` for those specific functions.

---

## 3. Search (Algolia)

### Scaling well
- Algolia handles scale natively — no action needed until the plan's record/operation limits are approached
- `algolia-sync.js` batch writes on product changes — efficient

### Pressure points
| Area | Risk |
|------|------|
| Index sync on bulk product import | If seller imports 500+ products at once, sync queue may back up |
| Algolia plan limits | Review plan tier when catalogue exceeds 10k records |

### Recommendations
1. **Monitor Algolia usage** monthly — check records count, search operations, and plan limits in the Algolia dashboard
2. **Implement index rate limiting** in `algolia-sync.js` for bulk imports — max 50 products/minute

---

## 4. Storage

### Current state
- Firebase Storage for product images
- No observed storage pressure

### Recommendations
1. **Image compression on upload** — enforce max 2MB per product image; resize to max 1200px on server via `media-engine.js`
2. **Storage lifecycle rules** — delete images for products archived >180 days
3. **CDN caching** — Firebase Storage URLs are CDN-backed by default; verify Cache-Control headers are set to `public, max-age=86400`

---

## 5. Hosting & CDN

### Current state
- Firebase Hosting (CDN-backed, global)
- `cleanUrls: true`, no `.html` extensions in URLs
- Service Worker v293 handles offline caching

### Scaling well
- Firebase Hosting scales to any traffic volume automatically
- SW cache strategy offloads repeat visits

### Recommendations
1. **Code splitting** — the 130+ HTML pages each load multiple deferred JS files. Consider inlining critical CSS and deferring non-critical scripts.
2. **Lazy load images** — ensure all product grid images use `loading="lazy"` (verified in category.js)
3. **Preconnect hints** — add `<link rel="preconnect" href="https://www.gstatic.com">` and Algolia domain to all pages

---

## 6. Scalability Verdict

| Component | Current Capacity | Next Review Trigger |
|-----------|----------------|-------------------|
| Firestore | ✅ Healthy (190/200 indexes) | When catalogue > 5k products |
| Cloud Functions | ✅ Healthy | When monthly invocations > 500k |
| Algolia | ✅ Healthy | When catalogue > 10k records |
| Storage | ✅ Healthy | When storage > 5GB |
| Hosting | ✅ Unlimited (CDN) | No trigger needed |
| Email (SendGrid) | ✅ Healthy | When emails/day > plan limit |

**No architectural changes required now.** Review again at 1,000 active sellers or 10,000 monthly orders — whichever comes first.
