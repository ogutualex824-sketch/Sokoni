# Admin OS — Gap Audit

**Status:** COMPLETE (audit only — no implementation) · **Date:** 2026-08-03
**Scope:** `admin-os.html` (19-panel SPA) · `sokoni-aos.js` (`window.SokoniAOS` engine) · `functions/admin-os.js` (~50 handlers) · `functions/admin-os-dispatch.js` (single dispatcher) · admin ops scattered in `wallet.js`/`disputes.js`/`account-status.js`/`admin-invitations.js`/`reviews.js`.
**Principle:** extend, do not rebuild — same as Provider OS. Frozen wallet/finance core is **read-only** to Admin OS.

---

## Architecture reality (read first)

- **One deployed callable.** All Admin-OS reads funnel through `adminOsDispatch` (`admin-os-dispatch.js:29`) → `adminOs._h[op]` registry (`admin-os.js:16`, ~50 ops). Only `adminOsDispatch` is re-exported in `index.js:10141`; the individual `onCall` wrappers register into `_h` as a side-effect and are **not** separately deployed. A handful of admin ops are standalone exports (`wallet.adminProcessPayout`, `disputes.adminGetAllDisputes`, `account-status.adminSetAccountActive`, `admin-invitations.*`, `reviews.adminModerateReview`).
- **`admin-os.html` uses `sokoni-aos.js`, NOT `admin-api.js`** (verified: `admin-os.html:578`; zero `AdminAPI` refs). `sokoni-aos.js` has its own dispatch: a whitelist (`_ADMIN_OS_OPS`, `:82`) routes through `adminOsDispatch`; non-whitelisted ops are called as **direct standalone callables**; several panels read **Firestore directly**.
- **`admin-api.js` (`window.AdminAPI`, the "one canonical data layer") is dead code relative to Admin OS** — only the older `admin.html` loads it. Its 17 `adminGet*` ops (`admin-api.js:145-161`) are unused by `admin-os.html`. The two admin frontends expose **disjoint op sets against the same dispatcher**.
- **Auth = Firebase custom claims** (not Firestore role). But two checkers disagree: admin-os.js `_requireAdmin` (`:7`) accepts only boolean `token.admin`/`superAdmin`; the shared `admin-claim.js isAdmin()` (`:39`) also honours `token.role==='admin'`/legacy spellings and is used only by `disputes.js`. An admin provisioned with `role:'admin'` but no `admin:true` passes disputes, fails every other admin-OS op. No missing-guard gaps found.

---

## 19-module gap table (owner's target list)

| Module | Backend | Frontend | Status | Priority |
|---|---|---|---|---|
| **Executive Dashboard** | ⚠️ `adminGetExecutiveDashboard` (AO:427) exists but **unused**; float+GMV only via separate `adminGetFinance`; **no health** | Present — `panel-dashboard`, 19 KPI cards via `adminGetPlatformOverview` + live listeners | **Partial** | **High** |
| Finance | ✅ `adminGetFinance` (AO:510, canonical 6-source + `reconciliation`) | Present — `panel-financial` | Complete | Low |
| Payments | ✅ `adminGetPayments` (AO:666) | Partial — folded into financial, no dedicated panel | Partial | Med |
| Withdrawals | ✅ `aosGetPendingPayouts` (AO:992) + `wallet.adminProcessPayout` | Present — financial ▸ Payouts | **Bug** — `adminApprovePayouts` (AO:1010) writes deprecated `payouts` | **High** |
| Users | ✅ `adminSearchUsers/GetUser/UpdateUserRole` + `account-status`/invitations | Present — `panel-users` | Complete | Low |
| Providers | ✅ `adminGetProviders` (AO:741, **unused**) | Partial — `panel-services` reads `providers` **direct** (non-canonical) | Partial | Med |
| Products | ✅ `adminGetProducts` (AO:920) | Present — marketplace ▸ Products | Complete | Low |
| Services | ✅ `adminGetServices` (AO:759, **unused**) | Partial — direct Firestore | Partial | Med |
| Orders | ✅ `adminGetOrders` (AO:895) | Present — marketplace ▸ Orders | Complete | Low |
| Bookings | ✅ `adminGetBookings` (AO:948, canonical `providerBookings`, **unused**) | **Missing panel** (KPI only) | Missing (FE) | Med |
| Analytics | ✅ `adminGetAnalytics` + cohort/funnel/retention | Partial — funnel/cohort ship **hard-coded zero fallbacks** | Partial | Med |
| Reviews | ✅ `adminGetReviews`/`adminRemoveReview` + `reviews.adminModerateReview` | **Broken** — UI calls non-whitelisted `adminModerateReview` name-mismatch (`sokoni-aos.js:363` vs whitelist `:89`) | **Broken** | **High** |
| Support | ✅ `adminGetSupportTickets`/`Resolve` | Present — `panel-support` | Complete | Low |
| Disputes | ✅ `adminGetDisputes` (AO:1019) + `disputes.js:235` | Present — financial ▸ Disputes | Partial — **duplicate registration** shape risk (§ below) | Med |
| Notifications | ✅ `adminGetNotifications`/`SendPush`/comms | Present — `panel-comms` | Complete | Low |
| **System Health** | ❌ **GAP** — no infra-health op; `systemHealthCheck` is an unwired `onRequest`; `getPlatformHealthScores` is *business* health, not infra | Missing panel (only an uptime % chip) | **Missing** | **High** |
| **Merchant Pipeline** | ❌ **GAP** — no funnel-stage aggregation op | Missing (external quick-link only, `admin-os.html:326`) | **Missing** | **High** |
| Reports | ⚠️ `adminGetReports` = **alias to `adminGetFinance`** (AO:890); no distinct report/export | Missing — ad-hoc JSON dump / analytics CSV | Missing | Med |
| **eTIMS Monitoring** | ❌ **GAP** — `etims*.js` exist but no admin op surfaces status/invoices | Missing (static "KRA ACTIVE" text, `admin-os.html:511`) | **Missing** | Low (KRA-blocked) |

---

## Confirmed defects (fix before/with feature work)

1. **`adminApprovePayouts` writes the deprecated `payouts` collection** (AO:1010) while the real queue is `payoutRequests` → bulk-approve **silently no-ops** against what the payout engine reads. *Money-adjacent; wallet core is frozen — route through the canonical `wallet.adminProcessPayout` path rather than reimplementing. Owner sign-off before touching the payout flow.*
2. **Review moderation is a dead handler** — `sokoni-aos.js:363` calls `adminModerateReview` which is neither whitelisted (`:89` has `adminRemoveReview`) nor routed → approve/reject does nothing.
3. **Duplicate handler registrations** (later wins): `adminGetDisputes` (AO:864 enveloped vs :1019 raw → **:1019 wins, `{disputes:[]}` not `{items}`**), `adminGetReviews` (:870 vs :1042), `adminGetSupportTickets` (:338 vs :882). Verify each consumer's expected shape — mismatch risks empty Disputes/Reviews panes.
4. **Non-canonical live KPI listeners** in `sokoni-aos.js`: pending payouts read `payouts` (`:126`, should be `payoutRequests`), service bookings read venue `bookings` (`:135`, should be `providerBookings`), plus `businesses` (`:132`). Same stale-mirror class the Provider OS `db` bugs were.
5. **Non-canonical direct Firestore panels** (violate the "no admin page reads Firestore directly" rule): services `providers`, delivery `deliveries`, refunds `refundRequests`, security `activeSessions`/`approvalRequests`/`securityEvents`, pos `posShifts`, search `searchInsights`.
6. **Auth-checker inconsistency** (see Architecture) — a `role:'admin'`-only admin is denied by admin-OS ops but allowed by disputes.

## UI stubs / placeholders (present but not real)

Delivery "Live Rider Map" (static links), AI module toggles (hard-coded `checked`, never hydrated), Analytics funnel/cohort (zero-value fallbacks rendered as data), Financial "Report" tab (raw `JSON.stringify`), `editBanner` (stub toast), Config company-info (static Bravilex/KRA text).

## Unused-but-available backend (wire, don't rebuild)

`adminGetExecutiveDashboard`, `adminGetBookings`, `adminGetPayments`, `adminGetProviders`, `adminGetServices`, `adminSetFeaturedShop`/`ListFeaturedShops` — all deployed via dispatch, no `admin-os.html` caller.

---

## Cross-cutting

- **Loading UX:** every panel has an inline spinner + most have friendly empty states (`_emptyMsg`/`_emptyRow`), but **no skeletons** (the skeleton lives only in the unused `admin-api.js`) and **no per-panel retry** (only a global 10s watchdog — added in the recent polish sprint). Adopt the Provider OS `.sk-row` + retry conventions.
- **Nav:** own sidebar (`SokoniAOS.navigate`, `data-no-header`), mobile hamburger. All 19 entries map 1:1 to a panel; no duplicates. Coherent — no unification needed (unlike the buyer surfaces).
- **Data-layer reconciliation:** decide the fate of `admin-api.js` — either retire it (Admin OS ignores it) or converge Admin OS onto it. Currently it's the documented "canonical layer" yet dead for the primary console.

---

## Proposed implementation order (top-down, extend-only) — awaiting owner priority

1. **Correctness pass (P0):** fix `adminApprovePayouts` stale-write (owner sign-off, route via canonical), review-moderation handler, duplicate-registration shape mismatches, and the stale KPI listeners (`payouts`→`payoutRequests`, `bookings`→`providerBookings`).
2. **Executive Dashboard (P1):** switch to `adminGetExecutiveDashboard`; add total users, GMV, wallet float (from `adminGetFinance`), and a real System-Health rollup; the command-center KPIs the owner listed.
3. **New modules (P2):** **System Health** panel (needs one new admin op wrapping infra checks — CF/queue/gateway/email/SMS), **Merchant Pipeline** (needs one aggregation op over the onboarding stages), **Reports** (formalize beyond the finance alias), **eTIMS Monitoring** (deferred — KRA-blocked, wire when eTIMS deploys).
4. **Promote to canonical (P2):** wire the unused `adminGetBookings`/`Payments`/`Providers`/`Services`; move direct-Firestore panels behind callables.
5. **Polish (P3):** skeletons + per-panel retry; replace the six UI stubs with real data or honest empty states.

**Net:** like Provider OS, Admin OS is substantial and backend-rich — the work is wiring unused ops, fixing drift/bugs, adding **4 genuinely-missing modules** (System Health, Merchant Pipeline, Reports, eTIMS Monitoring), and polish. Only System Health and Merchant Pipeline need net-new backend (thin aggregations); everything else already has an op.
