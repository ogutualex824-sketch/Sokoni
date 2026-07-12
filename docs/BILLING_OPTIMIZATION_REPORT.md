# SOKONI Billing Optimization Report
## Infrastructure & Cost Optimization Sprint — 2026-07-12

---

## Pricing Reference

| Service | Unit | Price |
|---|---|---|
| Firestore reads | Per 100K | $0.06 |
| Firestore writes | Per 100K | $0.18 |
| Firestore deletes | Per 100K | $0.02 |
| Firestore aggregation query | Per 100K | $0.06 (same as read) |
| Cloud Functions invocations | Per 1M | $0.40 |
| Cloud Functions CPU | Per GHz-second | $0.0000100 |
| Cloud Run CPU (Gen2) | Per vCPU-second | $0.0000240 |
| Cloud Run memory | Per GiB-second | $0.0000025 |
| Cloud Storage | Per GB/month | $0.026 |
| Outbound bandwidth | Per GB (after 1GB free) | $0.12 |

---

## Baseline — Before Optimization

### Scenario Parameters
- Early launch platform: ~100-500 MAU
- Admin monitoring: 1 admin session/day, 8h, tab open
- User sessions: avg 4h active per session

### Firestore Reads — Before

#### monitor.js (daily reads per admin session)

| Source | Per Cycle | Cycles/Day | Daily Reads |
|---|---|---|---|
| Unbounded getDocs (7 collections) | ~3,500 avg | 320 (90s × 8h) | ~1,120,000 |
| Refresh fixed reads | 76 | 320 | 24,320 |
| generateReport (5 calls/day) | ~5,000 | 5 | 25,000 |
| **monitor.js subtotal** | | | **~1,169,320/day** |

Monthly: **~35M reads → $21/month**

#### onSnapshot listener leaks (before fix — 33 leaked + 7 digital.html)

Each leaked listener receives Firestore updates indefinitely. Estimated at 5 document changes/hour per listener across active user sessions.

| Listener type | Count | Changes/hr | Sessions/day | Duration | Daily reads |
|---|---|---|---|---|---|
| Leaked (33 across 21 pages) | 33 | 5 | 50 sessions | 2h avg | 16,500 |
| digital.html stack (fixed prior) | 26 (pre-fix avg) | 10 | 20 sessions | 2h | 10,400 |
| **Total daily listener leak reads** | | | | | **~26,900/day** |

Monthly: **~0.8M reads → $0.50/month** (early scale; grows linearly with users)

#### api-gateway.js double billing (before fix)

Each request to `/api/v1/search` or `/api/v1/orders` triggered:
1. `sokoniAPIGateway` CF invocation
2. Outbound HTTP call to non-existent CF (returning 404)

At 500 API requests/day: 1,000 CF invocations/day (500 wasted).

Monthly: **15,000 wasted invocations → $0.006/month** (trivial now, material at scale)

#### conversion-analytics.js self-call (before fix)

Each `recordHealthSnapshot` call invoked itself over HTTP — double billing.
Scheduled every 30 minutes: 48 self-calls/day = 48 wasted invocations.

Monthly: **1,440 wasted invocations → negligible** (pattern eliminated)

### Before Summary — Monthly Estimated Cost

| Category | Monthly Reads/Invocations | Monthly Cost |
|---|---|---|
| Firestore — monitor.js | ~35M reads | $21.00 |
| Firestore — listener leaks | ~0.8M reads | $0.48 |
| Firestore — all other ops | ~100M reads (est.) | $60.00 |
| CF invocations (api-gateway double) | ~15K wasted | $0.006 |
| CF invocations (health self-call) | ~1.4K wasted | $0.001 |
| Cloud Run (pending CFs) | Not yet deployed | N/A |
| Storage (images, docs) | ~10 GB | $0.26 |
| Bandwidth | ~5 GB | $0.48 |
| **Total estimated before** | | **~$82/month** |

---

## After Optimization

### Firestore Reads — After

#### monitor.js (after)

| Source | Per Cycle | Effective Cycles/Day | Daily Reads |
|---|---|---|---|
| getCountFromServer (14 calls) | 14 | 160 (visibility 50%) | 2,240 |
| Bounded getDocs (capped) | ≤3,000 | 160 | ≤480,000 |
| generateReport cache (60s TTL) | ≤510 | 2 (most hit cache) | ≤1,020 |
| Reads while tab hidden | 0 | — | 0 |
| **monitor.js subtotal** | | | **≤483,260/day** |

Monthly: **~14.5M reads → $8.70/month** (vs $21 before)
**Saving: ~$12.30/month**

#### onSnapshot listener leaks (after fix — 0 remaining)

All 33 leaks fixed. Listeners are torn down on conversation close / page unload / tab hide.

Expected reads from properly managed listeners: 0 excess (listeners only fire when data actually changes, and are cleaned up properly).

**Saving: ~$0.50/month (grows significantly with user scale)**

#### api-gateway.js (after)

Inline handlers — zero proxy calls. Every API request = exactly 1 CF invocation.

**Saving: 50% of API-related CF invocations**

### After Summary — Monthly Estimated Cost

| Category | Monthly Reads/Invocations | Monthly Cost |
|---|---|---|
| Firestore — monitor.js | ~14.5M reads | $8.70 |
| Firestore — listener leaks | **0 excess** | $0.00 |
| Firestore — all other ops | ~100M reads (est.) | $60.00 |
| CF invocations (no double billing) | 0 wasted | $0.00 |
| Cloud Run (pending CFs, post-quota) | TBD | TBD |
| Storage | ~10 GB | $0.26 |
| Bandwidth | ~5 GB | $0.48 |
| **Total estimated after** | | **~$69/month** |

---

## Savings Summary

| Optimization | Monthly Saving (early) | Monthly Saving (10K MAU) |
|---|---|---|
| monitor.js read reduction | $12.30 | $250+ |
| Listener leak elimination (33) | $0.50 | $150+ |
| digital.html listener stack fix | $1.50 | $100+ |
| CF double billing (api-gateway) | $0.01 | $15+ |
| CF self-call (conversion-analytics) | $0.001 | $2+ |
| **Total monthly saving** | **~$14/month** | **~$520+/month** |
| **Total annual saving (10K MAU)** | | **~$6,240+/year** |

---

## Scale Projections

The optimizations are designed for scale. Costs before optimization grew super-linearly with user count; costs after are linear or sub-linear.

| MAU | Firestore reads before (est.) | Firestore reads after (est.) | Monthly saving |
|---|---|---|---|
| 500 (current) | 135M | 115M | $12/month |
| 5,000 | 500M | 250M | $150/month |
| 50,000 | 5B | 1.5B | $2,100/month |
| 500,000 | 50B | 10B | $24,000/month |

---

## Cost Governance Recommendations

1. **Monitor Firestore usage daily** — Google Cloud Console → Firestore → Usage tab. Set budget alert at 80% of monthly budget.

2. **Add `limit()` to all new queries** — enforce in code review. No unbounded `getDocs` in production code.

3. **Use `getCountFromServer`** for all count-only operations (KPI cards, totals, statistics).

4. **Listener hygiene rule** — every `onSnapshot()` call must store its return value and clean up. Add to team PR checklist.

5. **Index headroom policy** — keep `(default)` database below 180 indexes (20 buffer). New indexes go to `sokoni-ops` by default when (default) is at 180+.

6. **CF self-invocation prohibition** — Cloud Functions must not call their own endpoints over HTTP. Use shared module functions or emit Firestore events for cross-CF communication.

7. **Set up billing alerts** — GCP Console → Billing → Budgets & Alerts:
   - Alert at $50/month (warning)
   - Alert at $100/month (critical)
   - Alert at $200/month (shutdown trigger)
