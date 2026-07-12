# SOKONI v1.0.0 — RC1 Stabilization: Executive GO / NO-GO Report

**Date:** 2026-07-12 · **HEAD:** `0794f9b` · **Branch:** `main`

# 🔴 VERDICT: **NO-GO**

**Update (`02f1a6f`): C3 is RESOLVED and deployed.** **Three** critical blockers remain — C1 (dirty tree), C2 (provider onboarding broken), C4 (legal integration incomplete). C2 and C4 are both **queued to land the instant C1 clears** (a watcher is armed on the agent's files); neither is technically hard. Detail + remediation below.

---

## Verification actually performed (evidence-based)

| Check | Result |
|---|---|
| Architecture guard (dispatchers/quota/duplicates) | ✅ PASS — 0 collisions, budget respected |
| CompanyIdentity/brand guard | ✅ PASS — 862 files |
| Legal Compliance test suite | ✅ **29/29 PASS** (`node scripts/test-legal-compliance.js`) |
| Live entry points (15 pages: home, login, signup, onboarding, pos-setup, pos, provider-dashboard, legal-centre, checkout, wallet, search, jobs, property, healthcare, admin-os) | ✅ **all HTTP 200** |
| Critical dispatchers live | ✅ 7/7 (smartPos, provider, onboarding, subscriptions, legal, adminOs, services) |
| **Authentication + App Check** (browser E2E, live project) | ✅ **PASS — production-ready.** See section below |
| Cloud Function inventory | 1410 deployed · 1203 exported · **208 orphans** · 1 non-function export (`COLLECTION_REGISTRY`, benign) |
| Composite indexes | 226 defined (4 uncommitted/undeployed) |

### ⚠️ NOT verified (cannot be, from this environment — do not read as passing)
Payments E2E (M-PESA/IntaSend live money), PWA offline/install/background-sync, accessibility audit, dark/light-mode visual pass, search ranking/perf under load, monitoring/alerting/backup restore, cold-start latency, bundle size. **These require a device, emulator, or load harness.** They must be executed before GO.

---

## ✅ Authentication & App Check — PRODUCTION-READY (verified 2026-07-12)

Verified in a real Chromium against the **live `sokoni-aeb26` project** (Playwright, not static analysis). A root-cause defect was found and fixed: `FIREBASE_APPCHECK_DEBUG_TOKEN = true` minted a **new random, unregistered** debug token per browser profile → `403 App attestation failed` → and a failed App Check token fetch **aborts every Firebase Auth request before it is sent**. Proven by A/B: with App Check on, `identitytoolkit` received **zero** requests and all methods returned `auth/network-request-failed`; with it off, the identical calls succeeded. Fix: the *registered* token is now pinned from `localStorage` on localhost (`firebase.js`, `sokoni-appcheck.js`).

| Check | Result |
|---|---|
| App Check `exchangeDebugToken` (localhost) | ✅ **200** — App Check JWT issued (`"provider":"debug"`, TTL 3600s) |
| App Check token generation + **refresh** | ✅ 930-char token; forced refresh issues a new token |
| App Check init **before** Auth | ✅ `initializeAppCheck()` precedes `getAuth()` — [firebase.js:84-92](../firebase.js#L84-L92) |
| Production attestation (`mysokoni.co.ke`) | ✅ **no** debug token set; attests via `exchangeRecaptchaV3Token` |
| Remaining HTTP 403s | ✅ **ZERO** across App Check, Auth and Firestore |
| Email/Password E2E (create → sign-in → delete) | ✅ PASS — real account created, signed in, deleted |
| Password Reset | ✅ PASS — `sendOobCode` 200, reset email sent |
| Email Verification | ✅ PASS — verification email sent |
| Google OAuth | ✅ Popup opens to `/__/auth/handler`; localhost + prod are authorized domains, provider enabled |
| Phone OTP | ✅ Invisible reCAPTCHA renders; `recaptchaParams` 200 |
| Temporary debug code removed | ✅ `security.js` `AUTH DEBUG` block deleted; rejection suppression restored |

**Residual manual steps (cannot be automated — require a human, not defects):** completing a Google login needs real Google credentials, and receiving an OTP needs a real handset. Both were driven to the provider handoff successfully. **Developer note:** each dev must pin the registered token once per browser — `localStorage.setItem('SOKONI_APPCHECK_DEBUG_TOKEN', '<uuid>')`.

This section **does not change the overall verdict** — C1/C2/C4 below are unrelated to authentication and remain open.

---

## 🔴 CRITICAL BLOCKERS (all must clear)

### C1 — Release freeze is impossible: 163 uncommitted files
The working tree has **163 modified + 4 untracked files** (a concurrent agent's in-progress global logo-path migration, plus `onboarding.html`, `provider-onboarding.html`, `sokoni-provider.js`, `firestore.rules`, `firestore.indexes.json`). You cannot tag, snapshot, or roll back a release from a dirty, half-migrated tree — the build is not reproducible.
**Remediation:** the agent commits (or the sweep is reverted); confirm `git status` clean; then tag.

### C2 — Service Provider onboarding is broken end-to-end
Audited: the provider wizard **cannot save a draft, cannot activate a subscription, and cannot publish** (4 frontend↔backend contract bugs — draft sends a numeric step where the backend requires a named string; the wizard never calls `providerSelectPlan`/`providerActivateSubscription`, so `providerPublish`'s subscription precondition always fails; publish field-map mismatch; resume shape mismatch). **A service provider literally cannot complete registration.**
**Remediation:** the 4 fixes are specified with file:line in `PROVIDER_ONBOARDING_GAPS.md` — a ~1-hour pass, blocked only by C1.

### ~~C3 — 12 of 15 role dashboards do not exist~~ → ✅ **RESOLVED** (`02f1a6f`, deployed)
The UEOE `DASHBOARD_MAP` routed 12 roles (hotel/restaurant/pharmacy/driver/courier/employer/freelancer/healthcare/manufacturer/ngo/school/finance) to `*-dashboard.html` pages that **did not exist** — those roles completed onboarding and landed on a **404** dead-end.
**Fixed:** every entry now routes to an **existing** page (verified: 13 distinct targets, **0 missing**) — driver/courier→`driver.html`, hotel→`bnb-manage.html`, restaurant/pharmacy→`pos.html`, employer→`job-post.html`, freelancer→`jobs.html`, healthcare→`healthcare.html`, school→`education.html`, manufacturer/ngo/finance→`business-os.html`. Respects the feature freeze (a stability fix, **not** 12 new dashboards); point any role back at a purpose-built dashboard when one ships.

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
| Security | **85** | App Check **now verified working end-to-end** (was silently 403-ing and blocking all auth) + guards + server-side legal enforcement (no forged acceptance, server timestamps/IP, immutable audit) + ownership checks. Deducted: rules uncommitted/unreviewed (H5). |
| Authentication | **95** | Email/Password, Password Reset, Email Verification, Google OAuth and Phone OTP all verified against the live project; App Check attests with zero 403s. Deducted: final Google-login and OTP-SMS steps need a human. |
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
