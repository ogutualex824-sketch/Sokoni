# Analytics Engine Roadmap (R1.x)

> Single source of truth for platform analytics. Foundation shipped in RC; the full buildout is a
> post-`v1.0.0` initiative. Build order below is deliberate — **reconciliation (item 6) first**,
> because it is what proves parity and gates everything else.

Related: [[Commerce Lifecycle]] · [[Settlement Engine]] · [[Commission System]] · [[Payments]]

---

## Status

| Layer | State |
|---|---|
| **Foundation** — canonical aggregates, exactly-once event hooks, platform-fee = canonical commission, real-time client subscriber | ✅ **SHIPPED** — QA-verified exactly-once |
| **Phase 5 — Reconciliation** (`analytics-reconcile.js`, scheduled + `adminReconcileAnalytics`, backfill) | ✅ **BUILT + VERIFIED** (drift-detection PASS) |
| **Phase 2 — Trigger coverage: refund + cancellation** (parity-preserving reversals) | ✅ **BUILT + VERIFIED** |
| **Phase 3 — Historical buckets** (`analytics-rollup.js`: 7d/30d/month/quarter/year) | ✅ **BUILT + VERIFIED** |
| **Phase 4 — BI ratios** (`computeBI` → `analytics/bi`: AOV, refund/cancel/settlement rate, gross/net) | ✅ **BUILT + VERIFIED** |
| **Phase 6 — Monitoring** (`analytics-monitor.js` → `analytics/health` + `monitoringAlerts`) | ✅ **BUILT + VERIFIED** |
| **Phase 4b — Dimensional BI** (`bumpOrderDimensions`/`bumpDeliveryHour` + `computeTopLists`: top products/categories, peak sales/delivery hours, per-customer CLV → `productAnalytics`/`categoryAnalytics`/`users/{uid}/analytics/summary`/`analytics/hourly_*`/`analytics/top_lists`) | ✅ **BUILT + VERIFIED** |
| **Phase 1 — Dashboard migration** | ⏳ **BLOCKED** on the rules release (client can't read the docs until then) |
| **Phase 7 — Release gate execution** (load / DR / offline-sync tests) | ⏳ needs infra/load runs |
| **Enterprise items** — branch analytics · immutable audit ledger (ledger/auditLogs exist; add hash-chain) · retention/archival · analytics versioning · **integrity-rebuild ≈ reconcile+backfill (built)** · RBAC analytics (needs rules) | ⏳ backlog |

The daily `scheduledAnalyticsReconcile` job now runs **rollup → BI → reconcile → health** in sequence.
**Do not mark analytics "complete" until the Phase-7 release gate passes.**

---

## What shipped (RC foundation)

**Server — `functions/analytics-aggregator.js`** maintains the canonical documents with atomic,
contention-free `FieldValue.increment` writes, fed ONLY from exactly-once event points:

| Canonical doc | Scope |
|---|---|
| `analytics/global` | lifetime, platform-wide |
| `analytics/daily_YYYY-MM-DD` | per-day, platform-wide |
| `shops/{shopId}/analytics/summary` | lifetime, per shop |
| `shops/{shopId}/analytics/daily_YYYY-MM-DD` | per-day, per shop |

**Hooks (in `index.js` order triggers):**
- **paid** (`onNewOrderCreated` + `onOrderStatusChange`, marker-guarded `claimPaidCount`) → `paidOrders`, `gmvShillings`
- **delivered** (`onOrderStatusChange`, guarded by the rider-credit) → `deliveries`, `riderEarningsShillings`
- **completed** (`onOrderStatusChange`, after `settleOrder` returns `settled`) → `settledOrders`, `gmvSettledShillings`, `platformRevenueShillings` (**= the canonical commission from the settlement engine, never a dashboard `%`**), `sellerEarningsShillings`

**Rules:** shop owner reads `shops/{id}/analytics/*`; admin reads `analytics/global`; only Cloud Functions write. *(Release pending — see Known Issues.)*

**Client — `sokoni-analytics.js` (`window.SokoniAnalytics`)** `subscribeGlobal(cb)` / `subscribeShop(shopId, cb)` — real-time `onSnapshot` with an 8s-watchdog poll fallback for iOS App Check; exposes `fmt.platformFee` derived from canonical revenue.

**Design invariants (keep):** increments only from exactly-once points; platform fee is always the canonical commission; fire-and-forget (an analytics hiccup never blocks the money path); units are shillings (matching wallet balances).

---

## Infrastructure task (NOT an application defect) — Firestore rules release
The default-DB `cloud.firestore` rules release is a stuck resource: `firebase deploy --only firestore:rules`
returns `409 "entity already exists"` on **both** CLI 15.24 and 15.26; the Rules REST update endpoint
rejects every documented body shape. **Preferred order:** (a) release from a clean **CI runner**; (b) if it
persists, a scheduled **maintenance window** to delete + recreate the release with rollback ready.
**Never force a delete on the live app** — a rules-less window denies all Firestore access. Non-blocking
meanwhile: the engine writes via Admin SDK. This is the only open infrastructure task before the release
is completely closed.

---

## R1.x phased plan

### Phase 1 — Analytics completion
Migrate every dashboard to `SokoniAnalytics.subscribe*`: Seller · Admin · POS · Finance · Inventory ·
Orders · Wallet · Rider Hub · Branch · Analytics page · KASS AI. Eliminate all duplicate/page-level
calculation. **No page computes revenue independently.** One dashboard at a time; verify parity against
`analytics/global` after each.

### Phase 2 — Trigger coverage (every business event → one source)
Orders · payments · inventory · products · wallet · deliveries · riders · merchants · branches · refunds ·
returns · services · bookings · jobs · ads · reviews · notifications · subscriptions · loyalty. Same
additive, exactly-once pattern as the 3 shipped hooks (deterministic marker or settle-style outcome).

### Phase 3 — Historical buckets (pre-computed)
Today · Yesterday · 7 Days · 30 Days · Monthly · Quarterly · Yearly · Lifetime. Daily buckets exist; add a
scheduled rollup folding days → week/month/quarter/year so dashboards never scan collections.

### Phase 4 — Business intelligence
GMV · Net Revenue · Gross Revenue · Commission · Merchant Earnings · Rider Earnings · Refund Rate ·
Cancellation Rate · AOV · CLV · Repeat Purchase Rate · Peak Sales Hours · Peak Delivery Hours ·
Best-Selling Products · Best Categories · Inventory Turnover.

### Phase 5 — Reconciliation (HIGHEST PRIORITY — the analytics release gate)
Scheduled jobs assert each link of the chain and alert immediately on any mismatch beyond threshold:
```
Orders     == Revenue
Payments   == Wallet
Wallet     == Settlement
Settlement == Commission
Commission == Analytics
Analytics  == Dashboard
```
This is the parity proof; it must exist before dashboards are trusted. Build it FIRST of the R1.x work.

### Phase 6 — Monitoring
Automated detection: failed trigger executions · duplicate events · missing analytics updates ·
settlement mismatches · inventory drift · revenue drift · wallet imbalance · trigger latency ·
Firestore write failures.

### Phase 7 — Release gate (close R1.x only when ALL pass)
Dashboard parity · financial reconciliation · inventory reconciliation · analytics reconciliation ·
performance testing · offline-sync testing · large-scale load testing · disaster-recovery validation.

---

## Cutover plan — dashboard migration (safeguarded)

Once the rules release is done, migrate in this order (do NOT skip the parallel-validation gate):

1. **Deploy the rules** (CI runner or maintenance window) — unblocks client reads.
2. **Enable RBAC** for analytics docs (shop owner / branch manager / rider / finance / admin scopes).
3. **Migrate each dashboard** to `SokoniAnalytics` — one surface at a time.
4. **Parallel-validation period (the safeguard — do not skip):** keep the legacy calculation running
   ALONGSIDE `SokoniAnalytics` (hidden is fine), and log every discrepancy automatically for several
   days of real production traffic. Suggested mechanism: a small client shim that computes both, diffs
   the headline metrics, and writes mismatches to an `analyticsParityLog` collection (or console) with
   {metric, legacy, canonical, page, at}. This is a client-side complement to the server Phase-5
   reconciliation — it proves the DASHBOARDS agree, not just the aggregates.
5. **Retire legacy** per dashboard ONLY once its parity variance stays at zero (or within the defined
   tolerance) across the validation window. Remove the legacy calculation then.
6. **Run load / failover / offline-sync validation** (Phase 7).
7. **Tag the analytics subsystem production-complete** once all gates pass.

Rationale: the backend is verified exactly-once, but the risk on cutover is a DASHBOARD reading or
formatting a number differently than the legacy code did. Parallel validation catches that before the
canonical engine becomes the sole source for any UI.

## Milestone B — prepared assets (so the rules release is the ONLY remaining dependency)

Ready on disk / deployed now, waiting only on the rules release:
- **RBAC analytics rules — FINALIZED in `firestore.rules`** (ready to deploy the moment the release is fixed):
  `shops/{uid}/analytics` = shop owner + admin · `analytics/{doc}` (global) = admin · `branches/{branchId}/analytics`
  = branch owner (parent `sellerId`) + admin · `users/{uid}/analytics` = the user themselves (rider CLV / buyer
  spend) + admin · `productAnalytics`/`categoryAnalytics`/`analyticsParityLog` = admin. All CF-write-only.
- **Cutover Readiness gate — BUILT** (`analytics/cutover_readiness`, verified): reconciliationParity · healthStatus ·
  reconciliation/monitoring alerts = 0 · bi/topList/rollup fresh · dashboardParity (0 unresolved `analyticsParityLog`).
  Daily job recomputes it; admin callable `{readiness:true}`. **Go/No-Go for retiring legacy.**
- **Client** `sokoni-analytics.js` (`SokoniAnalytics.subscribe*`) live.

Still to build for Milestone B (client-side, testable only after rules read-access): the `analyticsParityLog`
shim (compute legacy + canonical, diff, log discrepancies), the admin Cutover Readiness *page*, load-test
scripts, and the offline-sync test.

## Staged rollout (do NOT big-bang) — after the rules release
1. Deploy fixed rules → **verify RBAC manually** (admin reads global; seller reads only their shop; branch
   manager reads only their branch; rider/buyer read only their own; buyer blocked from restricted docs).
2. Enable `SokoniAnalytics` on the **Admin Dashboard first**; run **parity validation 24–48h** (parityLog at 0).
3. Roll out **Seller → POS → Rider Hub → remaining surfaces**, one at a time, parity-validating each.
4. **Retire legacy calculations only after sustained parity** (Cutover Readiness gate green across the window).
5. Run **load / DR / offline-sync** validation → **tag analytics production-complete**.

## Rollback procedure (per dashboard)
Each migrated dashboard keeps its legacy calculation behind a flag until retired. If parity variance exceeds
tolerance or a discrepancy is logged: flip the flag back to legacy for that surface (instant, no deploy if the
flag is a remote-config/localStorage toggle), keep the canonical read running in shadow, investigate via the
`analyticsParityLog` entry, fix, re-validate. The server aggregates are never the risk (verified exactly-once);
the risk is a client read/format difference — so rollback is always a client-side flag flip, never a data change.

## Final Go/No-Go — analytics production-complete (ALL must be ✅)
Do not declare the analytics subsystem production-ready until every item passes:

| Check | Required |
|---|---|
| Firestore rules deployed (rules release unblocked) | ✅ |
| RBAC verified (admin/seller/branch/rider/buyer scopes) | ✅ |
| Admin dashboard parity | ✅ |
| Seller dashboard parity | ✅ |
| POS parity | ✅ |
| Rider dashboard parity | ✅ |
| `analyticsParityLog` clean (0 unresolved) | ✅ |
| Cutover Readiness gate GREEN | ✅ |
| Reconciliation healthy | ✅ |
| Load test passed | ✅ |
| Offline sync passed | ✅ |
| Rollback verified | ✅ |

## Enterprise hardening (add to R1.x backlog)
1. **Branch-level analytics** — ✅ **BUILT + VERIFIED**: `bumpAnalytics` writes `branches/{branchId}/analytics/summary`+`daily_*` whenever an order carries a `branchId` (POS / click-and-collect); the shop summary remains the consolidated view.
2. **Immutable audit ledger** for all financial events — settlements/investigations fully traceable
   (extends the canonical `ledger` + `auditLogs`; append-only, hash-chainable).
3. **Data retention & archival** — roll old historical analytics to cold storage; keep operational
   datasets small while preserving reporting.
4. **Analytics versioning** — schema changes roll out without breaking older dashboards.
5. **Automated integrity jobs** — periodically REBUILD aggregates from canonical transactions and diff
   against live analytics to catch silent drift (the trust backstop behind Phase 5).
6. **Role-based analytics permissions** — sellers / branch managers / riders / finance / admins each
   see only the metrics relevant to their role (extends the Firestore analytics rules).

---

## Known issues
- **Rules release stuck** — non-blocking; needs CI or a maintenance window (see Infrastructure task).
- 3 unreferenced rulesets were created during release-fix attempts (harmless; immutable, unreleased).
