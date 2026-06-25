# Cost Governance — SOKONI v2.0

**Owner:** Engineering / Finance  
**Enforced from:** v2.0 (2026-06-25)  
**Review cycle:** Monthly

---

## Principle

Every infrastructure cost must be justified by the user value it delivers.
An idle scheduled function that runs 30 times a month and touches 2,000 documents
costs money even if no user ever clicks on its output.

Before adding infrastructure, ask: what user outcome does this serve?

---

## Cost Inventory

### Firestore

| Component | Est. reads/month | Est. writes/month | Notes |
|-----------|-----------------|------------------|-------|
| Order writes (on purchase) | — | ~100/month at launch | Low volume |
| Product view tracking (recordProductView) | — | ~5,000/month | Deduplicated per session |
| Health snapshots (hourly) | — | ~720/month | 24 × 30 |
| Daily ops reports | — | 30/month | scheduledDailyOpsReport |
| Funnel stats | — | ~150/month | addToCart + checkout steps |
| Price alerts check (daily) | ~1,000/month | ~50/month (triggered) | triggerPriceAlerts |
| Seller performance aggregate | ~2,000/month | ~300/month | aggregateSellerPerformance daily |
| Admin reports (on-demand) | ~3,000/month | 0 | Variable; admin tools only |
| **Total estimate** | **< 20,000/month** | **< 10,000/month** | **Well within free tier at launch** |

**Free tier:** 50,000 reads/day, 20,000 writes/day.  
At current volume, SOKONI will not exceed the Firestore free tier for the first 60–90 days.

**Watch signals:**
- Reads spike beyond 40,000/day → identify which collection or function is responsible
- Writes spike beyond 15,000/day → check for runaway triggers

---

### Cloud Functions

| Tier | Count | Estimated invocations/month |
|------|-------|-----------------------------|
| Scheduled | 8 | Fixed by schedule (hourly/daily) |
| Public user-facing | ~15 | Proportional to active users |
| Admin on-demand | ~30 | Low volume; used by admin team |
| Auth-required user | ~20 | Proportional to active users |
| **Total CFs deployed** | **160+** | — |

**Free tier:** 2,000,000 invocations/month.  
At launch volume, billing will not begin for Cloud Functions for at least 6 months.

**Watch signals:**
- Any single function exceeding 100,000 invocations/month → review for abuse or optimisation
- Memory-intensive functions (512 MiB) invoked by users → add `maxInstances` guard if not present

---

### Cloud Storage

| Type | Estimate | Notes |
|------|---------|-------|
| Product images | ~500 MB | Grows with seller count |
| Media assets (creative studio) | ~100 MB | Admin uploads |
| Receipts / documents | ~50 MB | PDF generation |
| **Total** | **< 1 GB** | — |

**Free tier:** 5 GB.  
At current growth rate, storage billing begins when > 200 active sellers with media uploads.

**Watch signals:**
- Storage grows above 4 GB → enforce max upload size per seller (already 2 MB per image)
- Large single files → check media-engine.js compression enforcement

---

### Algolia Search

Current plan: **Free (10,000 records, 10,000 searches/month)**.

| Metric | Current | Limit |
|--------|---------|-------|
| Indexed products | ~100 at launch | 10,000 |
| Searches/month | ~500 at launch | 10,000 |

**Upgrade trigger:** When monthly active search sessions approach 8,000, evaluate Algolia Grow plan.

---

### Email (SendGrid)

Current plan: Free tier via SMTP relay.

| Metric | Current | Free tier limit |
|--------|---------|----------------|
| Emails/day | ~10–50 (transactional) | 100/day |
| Monthly | ~500 | 2,000–3,000/month |

**Upgrade trigger:** When daily transactional email exceeds 80/day, upgrade to SendGrid Essentials.

Costly email patterns to avoid:
- Bulk newsletters without unsubscribe tracking → deliverability damage
- Sending order notifications on every status update (batch them)
- Price alert emails more than once per user per day

---

### Firebase Hosting

Hosting is on the **Spark (free) plan** — static assets, no dynamic compute.  
Cost: $0 indefinitely for static hosting.

---

## Monthly Cost Review

On the first working day of each month, review:

1. Open Firebase Console → Usage and billing
2. Check: Firestore reads and writes vs free tier
3. Check: Cloud Functions invocations vs free tier
4. Check: Storage used vs 5 GB limit
5. Check: Algolia dashboard → monthly search volume
6. Check: SendGrid dashboard → daily email volume

Document findings in the Monthly Exec Report using `docs/MONTHLY_EXEC_REPORT_TEMPLATE.md`.

---

## Cost Optimisation Rules

### Rule 1: Scheduled functions must justify their frequency

Every scheduled function costs money proportional to how often it runs.
Before changing a schedule (e.g., from daily to hourly), raise a Feature Proposal.

Current schedules are considered optimised for the current scale:

| Function | Schedule | Justification |
|----------|----------|--------------|
| `recordHealthSnapshot` | Every hour | Uptime monitoring requires hourly granularity |
| `scheduledDailyOpsReport` | 06:00 EAT | Daily digest email — 1 run/day optimal |
| `scheduledWeeklySecurityReport` | Monday 07:00 EAT | Security digest — weekly sufficient |
| `aggregateSellerPerformance` | 03:00 UTC daily | Overnight processing, low-traffic time |
| `triggerPriceAlerts` | 07:00 UTC daily | Morning trigger for KE users |
| `generateTrendingProducts` | Every 6 hours | Trending needs freshness without over-cost |
| `cleanupExpiredSubs` | 02:00 UTC daily | Overnight maintenance |
| `aggregateAnalytics` | Every 4 hours | Balance freshness vs Firestore cost |

### Rule 2: Admin-only functions should not be user-facing

Functions that scan thousands of documents (e.g., `getMarketplaceQualityReport`) are
expensive per invocation. They must remain admin-only (`requireAdmin(req)` guard).

Never wire heavy admin functions to public-facing pages.

### Rule 3: Use aggregate collections instead of scanning

When a metric is needed on a dashboard, write it to a small aggregate document at event time
(e.g., `funnelStats/{date}`) rather than scanning `orders` on every dashboard load.

Existing aggregate collections that should be used (not re-scanned):
- `funnelStats/{date}` — conversion funnel counts
- `ops_reports/{date}` — daily operational metrics
- `sellerPerformance/{sellerId}` — seller KPIs
- `searchQueryLog/{date_query}` — search analytics
- `healthSnapshots` — uptime history

### Rule 4: Paginate large queries

Any function that scans more than 100 documents must paginate.  
Current `limit()` values in heavy functions:
- `getMarketplaceQualityReport`: limit(2000) — acceptable for admin
- `getPlatformHealthScores`: limit(300) per sub-query — acceptable for admin

When product count exceeds 2,000, these functions must be refactored to use cursor pagination.
See `docs/SCALING_TRIGGERS.md` for the exact threshold.

### Rule 5: Deduplicate writes

High-frequency events (product views, search queries) must be deduplicated before writing.
Use session fingerprint (e.g., `productViewDedup` in `recordProductView`) to avoid writing
the same event multiple times per user session.

---

## Index Budget Management

Firestore composite indexes are capped at 200.
Current usage: **192 / 200**.

Rules:
- Do not add a new composite index without removing one first if usage is at 196+
- Every 3 months, run a query-to-index audit: are all 192 indexes actually used?
- Single-field queries (e.g., `where("status", "==", "active")`) use auto-indexes — they do NOT count toward the 200 limit. Prefer these where possible.

Index budget impact must be included in every Feature Proposal.

---

## Alert Thresholds

Set up Firebase billing alerts at these levels:

| Threshold | Action |
|-----------|--------|
| $0 (any billing) | Notify immediately — we should be on free tier |
| $10/month | Review usage; identify the cause |
| $50/month | Engineering review; cost optimisation sprint |
| $100/month | Escalate to founder; consider architecture changes |

---

*Cost governance is not about being cheap — it is about ensuring every dollar spent
translates to measurable user value. At pre-revenue stage, protecting the free tier
is a survival constraint.*
