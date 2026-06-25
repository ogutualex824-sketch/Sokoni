# Scaling Triggers — SOKONI v2.0

**Owner:** Engineering  
**Principle:** No architectural change without an objective threshold being reached.

---

## Why this document exists

Every "let's scale it up" decision that is made before the threshold is reached costs
engineering time that should be spent on user value. This document defines the exact
conditions under which each architectural change becomes necessary.

Until a threshold is reached: the current architecture is sufficient. Prioritise simplicity.

---

## Firestore Scaling Triggers

### Trigger 1 — Paginate heavy admin functions
**Threshold:** Product catalogue > 2,000 active products  
**Current state:** Products ≈ TBD at launch  
**Action when triggered:**  
Refactor `getMarketplaceQualityReport`, `getMarketplaceSellerHealth`, and `getPlatformHealthScores`
to use cursor-based pagination (`startAfter(lastDoc)`) instead of `limit(2000)`.  
**Lead time:** 1 sprint (1 week)

### Trigger 2 — Introduce Firestore TTL policies
**Threshold:** Any collection exceeds 100,000 documents  
**Current candidates:**  
- `healthSnapshots` — pruned to 30 days already (manual delete in CF)
- `productViewDedup` — short-lived session data
- `searchQueryLog` — daily aggregates, grows forever  
**Action when triggered:**  
Enable Firestore TTL (time-to-live) on the identified collection's `expiresAt` field.
Add `expiresAt` field when writing new documents.  
**Lead time:** 2 days

### Trigger 3 — Index budget audit
**Threshold:** Firestore composite indexes reach 196/200  
**Current state:** 192/200  
**Action when triggered:**  
1. Run a query analysis across all CFs to identify which indexes are never used
2. Remove unused indexes (test removal in staging first)
3. Document freed slots  
**Lead time:** 1 sprint

### Trigger 4 — Read/write sharding
**Threshold:** Firestore reads exceed 40,000/day for 3 consecutive days  
**Current state:** < 5,000/day estimated  
**Action when triggered:**  
1. Identify the hot collection (Firebase Console → Firestore → Usage)
2. Consider aggregation (write totals at event time; read aggregates on dashboard)
3. Consider Redis/Memorystore cache layer if Firestore proves the bottleneck  
**Lead time:** 2–3 sprints

---

## Cloud Functions Scaling Triggers

### Trigger 5 — Functions concurrency tuning
**Threshold:** Any single CF exceeds 1,000 concurrent invocations at peak  
**Current state:** maxInstances set on all user-facing CFs  
**Action when triggered:**  
Increase `maxInstances` for the affected CF and review its cold-start latency.
Consider splitting high-load CFs into smaller units.  
**Lead time:** 1 day

### Trigger 6 — Scheduled job review
**Threshold:** Total scheduled CF runs exceed 500/day  
**Current state:** 8 scheduled jobs at fixed intervals ≈ 56 runs/day  
**Action when triggered:**  
1. Audit which scheduled jobs produce outputs that are actually consumed
2. Merge jobs that can share a single run (e.g., daily digest + ops report → one function)
3. Consider moving low-priority jobs to weekly instead of daily  
**Lead time:** 1 sprint

---

## Search Scaling Triggers

### Trigger 7 — Algolia plan upgrade
**Threshold:** Indexed products > 8,000 OR monthly searches > 8,000  
**Current state:** Products ≈ 100–200 at launch; searches ≈ 500/month  
**Action when triggered:**  
Upgrade from Algolia Free to Algolia Grow plan.
Review index structure for efficiency before upgrading.  
**Lead time:** 1 day (plan change) + 1 sprint (index optimisation)

### Trigger 8 — Search result caching
**Threshold:** Algolia costs exceed $50/month OR latency > 200ms  
**Action when triggered:**  
Implement a CF-side cache for the top 50 most-queried search terms (24-hour TTL in Firestore).
Do not over-engineer — only cache the proven hot terms from `getSearchInsights`.  
**Lead time:** 3 days

---

## Storage Scaling Triggers

### Trigger 9 — Image compression enforcement
**Threshold:** Storage > 4 GB total  
**Current state:** < 100 MB  
**Action when triggered:**  
1. Add server-side image compression in `media-engine.js` (resize to max 1200px, convert to WebP)
2. Add a one-time migration CF to compress existing oversized images
3. Enforce 2 MB max upload per image (already in UI; add CF-side validation)  
**Lead time:** 1 sprint

---

## Architecture Scaling Triggers

### Trigger 10 — CDN / multi-region consideration
**Threshold:** > 50,000 monthly active users  
**Current state:** < 1,000 MAU at launch  
**Action when triggered:**  
1. Enable Firebase Hosting CDN (already automatic via Firebase)
2. Evaluate whether Cloud Functions should be deployed in `europe-west1` for EU users
3. Review if a regional Firestore database (currently `(default)` region) needs to change  
**Lead time:** 1–2 sprints

### Trigger 11 — Separate admin backend
**Threshold:** > 1,000 daily admin tool uses OR admin CFs account for > 20% of invocations  
**Current state:** Admin tools are co-deployed with production CFs  
**Action when triggered:**  
Move admin-only Cloud Functions to a separate Firebase project (`sokoni-admin-aeb26`)
to isolate admin traffic and cost from production traffic.  
**Lead time:** 2 sprints

### Trigger 12 — Introduce a queue / background processing
**Threshold:** > 1,000 daily orders OR order processing CF timeout errors begin  
**Current state:** Order processing is synchronous CF calls  
**Action when triggered:**  
Introduce Cloud Tasks (Firebase extension or GCP) to move order confirmation emails,
invoice generation, and commission calculations to an async queue.  
**Lead time:** 2–3 sprints

---

## User Scale Triggers

| Users / Orders | Trigger | Action |
|----------------|---------|--------|
| 100 active sellers | — | No action — current architecture handles this |
| 500 active sellers | Trigger 1 | Paginate heavy admin scans |
| 1,000 MAU | — | No action — run monthly cost review |
| 10,000 MAU | Trigger 10 | CDN / multi-region review |
| 50,000 MAU | Trigger 11 | Separate admin backend |
| 1,000 daily orders | Trigger 12 | Async queue for order processing |
| 10,000 products | Trigger 7 | Algolia plan upgrade |
| 100,000 products | Trigger 4 | Firestore read/write sharding |

---

## How to use this document

1. Check this table in every sprint planning.
2. If any threshold has been crossed, raise it as a mandatory engineering item.
3. Do not attempt to "pre-solve" a trigger before the threshold is crossed.
4. When a trigger action is completed, update the "Current state" row with the new reality.

---

*Premature optimisation is the root of all evil — and the root of a lot of wasted engineering sprints.*
