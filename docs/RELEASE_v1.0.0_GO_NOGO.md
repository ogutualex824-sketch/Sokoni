# SOKONI v1.0.0 — RC1 Stabilization: Executive GO / NO-GO Report

**Date:** 2026-07-12 · **HEAD:** `0794f9b` · **Branch:** `main`

# 🔴 VERDICT: **NO-GO**

Four **critical** blockers prevent a v1.0.0 freeze. None are unfixable; three are small, one is a coordination problem. Detail + remediation below.

---

## Verification actually performed (evidence-based)

| Check | Result |
|---|---|
| Architecture guard (dispatchers/quota/duplicates) | ✅ PASS — 0 collisions, budget respected |
| CompanyIdentity/brand guard | ✅ PASS — 862 files |
| Legal Compliance test suite | ✅ **29/29 PASS** (`node scripts/test-legal-compliance.js`) |
| Live entry points (15 pages: home, login, signup, onboarding, pos-setup, pos, provider-dashboard, legal-centre, checkout, wallet, search, jobs, property, healthcare, admin-os) | ✅ **all HTTP 200** |
| Critical dispatchers live | ✅ 7/7 (smartPos, provider, onboarding, subscriptions, legal, adminOs, services) |
| Cloud Function inventory | 1410 deployed · 1203 exported · **208 orphans** · 1 non-function export (`COLLECTION_REGISTRY`, benign) |
| Composite indexes | 226 defined (4 uncommitted/undeployed) |

### ⚠️ NOT verified (cannot be, from this environment — do not read as passing)
Payments E2E (M-PESA/IntaSend live money), PWA offline/install/background-sync, accessibility audit, dark/light-mode visual pass, search ranking/perf under load, monitoring/alerting/backup restore, cold-start latency, bundle size. **These require a device, emulator, or load harness.** They must be executed before GO.

---

## 🔴 CRITICAL BLOCKERS (all must clear)

### C1 — Release freeze is impossible: 163 uncommitted files
The working tree has **163 modified + 4 untracked files** (a concurrent agent's in-progress global logo-path migration, plus `onboarding.html`, `provider-onboarding.html`, `sokoni-provider.js`, `firestore.rules`, `firestore.indexes.json`). You cannot tag, snapshot, or roll back a release from a dirty, half-migrated tree — the build is not reproducible.
**Remediation:** the agent commits (or the sweep is reverted); confirm `git status` clean; then tag.

### C2 — Service Provider onboarding is broken end-to-end
Audited: the provider wizard **cannot save a draft, cannot activate a subscription, and cannot publish** (4 frontend↔backend contract bugs — draft sends a numeric step where the backend requires a named string; the wizard never calls `providerSelectPlan`/`providerActivateSubscription`, so `providerPublish`'s subscription precondition always fails; publish field-map mismatch; resume shape mismatch). **A service provider literally cannot complete registration.**
**Remediation:** the 4 fixes are specified with file:line in `PROVIDER_ONBOARDING_GAPS.md` — a ~1-hour pass, blocked only by C1.

### C3 — 12 of 15 role dashboards do not exist
The UEOE `DASHBOARD_MAP` routes users to `hotel-dashboard.html`, `restaurant-dashboard.html`, `driver-dashboard.html`, `employer-dashboard.html`, `healthcare-dashboard.html`, `pharmacy-dashboard.html`, `courier-`, `freelancer-`, `manufacturer-`, `ngo-`, `school-`, `finance-dashboard.html` — **none of which exist**. Those roles complete onboarding and land on a **404**. The Driver/Hotel/Restaurant/Healthcare/Employer/Property user journeys **dead-end**.
**Remediation:** build the dashboards, or gate role activation to the roles that have one (Buyer, Merchant, Provider, Rider, Property).

### C4 — Legal compliance integration incomplete
Only the **merchant** flow uses `SokoniLegalGate`. Buyer/Provider/Driver/Rider/Property/Hotel/Restaurant/Pharmacy/Healthcare/Employer/Admin do not. Per the sprint's own gate ("do not mark complete until all onboarding flows use SokoniLegalGate"), **Legal Compliance must not be marked complete**. Server enforcement covers the 5 provider ops only (and is dark-launched).
**Remediation:** one-line `SokoniLegalGate.mount(el,{role})` per flow — blocked only by C1.

---

## 🟠 HIGH (resolve before or immediately after GO)

- **H1 — Money-path smoke test never run.** The dispatcher-rename commit (`8fe29e2`) renamed live wallet (`posGetWalletBalance`/`posRefundToWallet`) and admin payout/dispute handler keys. Behavior-preserving and caller-verified, but **never exercised on an authenticated device**. Checklist ready: `SMOKE_TEST_DISPATCH_RENAMES.md`.
- **H2 — IntaSend split settlement unverified.** Split remains **disabled**; collect-then-payout is the production default. The mandatory duplicate-payout guard is in place. Requires *your* dashboard confirmation before enabling.
- **H3 — Subscription write split-brain.** The **read/enforce** side is unified (`subscription-core`, 3 readers migrated). **Writes** still diverge across 5 stores (`subscriptions` is keyed two incompatible ways by sub-engine vs subscription-os). A single account can hold conflicting records. Diagnostic shipped (`getSubscriptionDivergence`); the write-unification is a flagged migration, **not run**.
- **H4 — 208 orphan Cloud Functions** deployed but not exported. Mostly intentional triggers/schedulers, but **a full `firebase deploy --only functions` would DELETE them.** Billing + deploy-safety risk.
- **H5 — `firestore.rules` uncommitted and unreviewed**, and 4 new indexes undeployed. Rules must be security-reviewed before deploy.

---

## Scorecard

| Dimension | Score | Basis |
|---|---:|---|
| Security | **82** | App Check + guards + server-side legal enforcement (no forged acceptance, server timestamps/IP, immutable audit) + ownership checks. Deducted: rules uncommitted/unreviewed (H5). |
| Performance | **78** | Dispatcher consolidation, index-free queries, version/flag caching. Deducted: 208 orphan services, cold starts & bundle size unmeasured. |
| Reliability | **62** | Guards green, 29/29 tests, all entry points 200. Deducted heavily: provider onboarding broken (C2), 12 dead dashboards (C3). |
| Scalability | **85** | One-service-per-domain dispatcher architecture; quota headroom reclaimed. |
| Accessibility | **—** | **UNVERIFIED** — no audit performed. Must not be scored as passing. |
| Billing efficiency | **72** | Dispatchers avoid per-op sprawl. Deducted: 208 orphans, 226 indexes, idle services unreviewed. |
| Documentation | **90** | Architecture, dispatcher registry, subscription consolidation, legal framework + API reference, gap analyses, smoke-test, this report. |
| Production readiness | **55** | Blocked by C1–C4. |
| **OVERALL** | **≈ 70 / 100** | **NO-GO** |

---

## Remediation path to GO (ordered)

1. **Clear C1** — get the working tree clean (agent commits or sweep reverted). *Everything else is gated on this.*
2. **Fix C2** — provider onboarding contract bugs (~1 hour; spec'd in `PROVIDER_ONBOARDING_GAPS.md`).
3. **Resolve C3** — build the missing dashboards **or** restrict role activation to roles that have one.
4. **Close C4** — drop `SokoniLegalGate.mount` into the remaining 11 flows; enable enforcement per role via `legalSetEnforcement`.
5. **Run H1** smoke test on a device; decide **H2** (IntaSend).
6. Execute the **unverified** set: payments E2E, PWA offline, accessibility, monitoring/backup-restore, load/perf.
7. Then: tag `v1.0.0`, snapshot rules/indexes/config, publish the release manifest + rollback guide.

**Do not tag v1.0.0 until C1–C4 are closed and the unverified set has been executed.**

Related: [[PROVIDER_ONBOARDING_GAPS]] · [[LEGAL_ACCEPTANCE_FRAMEWORK]] · [[SUBSCRIPTION_CONSOLIDATION]] · [[SMOKE_TEST_DISPATCH_RENAMES]] · [[ONBOARDING_ARCHITECTURE_UPGRADE]]
