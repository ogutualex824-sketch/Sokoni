# SOKONI v1.0.0 — Production Readiness Sprint: FINAL Executive GO / NO-GO

**Date:** 2026-07-12 · **HEAD:** `70e684d` · **Branch:** `main`

# 🔴 VERDICT: **NO-GO**

**One Critical blocker remains.** Everything else is green or resolved. The blocker is bounded and cheap to close — but it must not be waved through, because the failure mode is silent destruction of production infrastructure.

---

## 🔴 CRITICAL BLOCKER — CB1: 154 live Cloud Functions are not managed by source

**Finding.** The deployed backend does not match the repository. **1,410 functions are deployed; 1,257 are exported from `index.js`.** The remaining **154 are live, billing, and invisible to source control.**

**Why this is Critical (not merely hygiene):**
- **A routine `firebase deploy --only functions` DELETES all 154.** Firebase removes any deployed function absent from source. One standard deploy command silently destroys production infrastructure.
- **It breaks P7 outright.** "Every deployment must be reversible" is impossible: you cannot reproduce, roll back to, or redeploy the current production state from the repo.
- **Necessity is unverified.** The evidence strongly suggests they are *superseded leftovers* from the earlier dispatcher-consolidation (`platformInfraDispatch` is exported **and** deployed and serves the `obs*` / `searchSync` / `ts*` handler registries; `search-sync.js` has **0 exports** = library-only; Algolia is now **queue-based** — `algoliaQueueMonitor`, `algoliaReprocessDLQ`, `algoliaBackfill`). **But "strongly suggests" is not proof, and nobody has confirmed they serve zero live traffic.**

**What was fixed this sprint (`70e684d`):** **54 orphans recovered into source** — including **all 30 transactional email triggers** (`emailOnOrderCreated`, `emailOnPaymentSuccess`, `emailOnSellerPayout`, `emailOnUserCreate`, disputes, bookings, deliveries…), plus `webhook-engine` (7), `reliability-engine` (7), `task-queue` (5), `email-dmarc` (3), `api-gateway` (2). **A deploy would have silently killed every transactional email on the platform.** Orphans: **208 → 154**. All 6 modules load cleanly; guard passes.

### Minimum actions to reach GO
1. Pull **30-day invocation counts** for the 154 (Cloud Console → Cloud Run metrics, or `gcloud monitoring`).
2. **Zero invocations** → delete them (`firebase functions:delete <name>`). This *also* clears CB1, reclaims ~154 Cloud Run services of quota headroom, and cuts idle cost.
3. **Non-zero invocations** → recover their source (they predate the consolidation) and export from `index.js`.
4. Re-run `firebase functions:list` and confirm **deployed == exported**. Only then is the deployment reproducible.

> ⚠️ **Until CB1 is closed: NEVER run `firebase deploy --only functions`.** Use targeted deploys (`--only functions:<name>`) exclusively. Every deploy this sprint was targeted for exactly this reason.

---

## ✅ Verified this sprint (evidence, not assertion)

| Priority | Result |
|---|---|
| **P2 — App Check** | ✅ **PASS.** Exactly **one** `initializeAppCheck()` (`firebase.js:84`). Debug token is **correctly gated to localhost** (`sokoni-appcheck.js:69` — `localhost`/`127.0.0.1`/`[::1]` only); the `= true` fallback is *inside* that branch, so **production never sets a debug token** and attests via reCAPTCHA v3. |
| **P3 — SendGrid** | ✅ **PASS.** `SENDGRID_API_KEY` in Secret Manager is a **real key** (`SG.…`), not a placeholder. **No hardcoded secrets** in client code. ⚠️ *Note:* the 30 email triggers that consume it were orphaned until `70e684d` — they are now under source control. |
| **P4 — Cloud Run quota** | ✅ **No longer a blocker.** 1,410 deployed vs a ~1,500 ceiling. Deleting the 154 (CB1) drops to ~1,256 — comfortable headroom. **Removed from the blocker list**, per the sprint's instruction. |
| **P1 — Authentication** | ✅ Previously verified E2E in a real browser against the live project (email/password create→sign-in→delete, password reset, email verification, Google OAuth handoff, phone OTP reCAPTCHA, zero 403s). Google OAuth attests on production **without** debug tokens. |
| **Guards / tests** | ✅ Architecture guard PASS (1,257 exports, 0 collisions, within budget) · CompanyIdentity PASS (862 files) · Legal Compliance suite **29/29 PASS**. |
| **Live health** | ✅ All key routes HTTP 200 (`/`, onboarding, provider-onboarding, pos-setup, pos, legal-centre, checkout, wallet, search, admin-os). |

### Defects found and fixed across the RC sprints
- **P0 — 9 SmartPOS handlers crashed on every call** (`recordPOSSale`, `getPOSCustomer`, …): declared `async (req)` but called `_adminOrSeller(request)`; `request` was never a parameter. Proven by execution (before: 9 `ReferenceError`; after: 0). Fixed + deployed.
- **C2 — Provider onboarding could never complete** (4 contract bugs). Fixed + live.
- **C3 — 12 roles landed on 404s** after onboarding. Fixed + live.
- **C1 — 238-file dirty tree** + incomplete logo migration. Completed (**~2MB lighter per page**) and committed.
- **CB1 (partial) — 54 orphans recovered**, incl. all transactional email.

---

## 📊 Scorecard

| Dimension | Score | Basis |
|---|---:|---|
| **Authentication** | **95** | Full E2E in a real browser; zero 403s; correct init order; prod attests via reCAPTCHA. |
| **Legal Compliance** | **95** | Engine + universal gate in every flow; server-side enforcement (dark-launched); immutable audit; **29/29 tests**. |
| **Security** | **85** | App Check correct, no hardcoded secrets, server-side ownership/enforcement everywhere. Deducted: `firestore.rules` still unreviewed. |
| **Scalability** | **88** | Dispatcher-per-domain architecture; quota headroom restored. |
| **Reliability** | **72** | P0 + C2 + C3 fixed; guards/tests green. **Deducted hard for CB1** — a standard deploy destroys prod. |
| **Performance** | **80** | ~2MB lighter pages; index-free queries; caching. Cold-start/bundle still unmeasured. |
| **Billing Efficiency** | **65** | **154 idle services billing for nothing**; 286 schedulers + 153 triggers unaudited; 200 composite indexes (at the limit). |
| **Payments** | **—** | **UNVERIFIED.** No live M-PESA/IntaSend E2E was run. Not scored — scoring it would be fabrication. |
| **Accessibility** | **—** | **UNVERIFIED.** No audit run. Not scored. |
| **Production Readiness** | **70** | Gated by CB1 + the unverified set. |

*(Payments and Accessibility are deliberately left unscored rather than guessed.)*

---

## Remaining blockers

| ID | Severity | Blocker |
|---|---|---|
| **CB1** | 🔴 **Critical** | 154 live functions unmanaged by source; a full functions deploy deletes them; deployment not reproducible/reversible (P7). |
| B2 | 🟠 High | **Payments E2E never verified** (M-PESA/IntaSend real money). |
| B3 | 🟠 High | **`firestore.rules` unreviewed** and uncommitted-history; must be security-reviewed before any rules deploy. |
| B4 | 🟠 High | Money-path **device smoke test** not run (`SMOKE_TEST_DISPATCH_RENAMES.md`) after the wallet/admin handler renames. |
| B5 | 🟡 Medium | **Subscription write split-brain** — reads unified via `subscription-core`; writes still diverge across 5 stores. |
| B6 | 🟡 Medium | **PWA** offline/install/background-sync unverified. |
| B7 | 🟡 Medium | **Monitoring/alerting/backup-restore drill** not executed. |
| B8 | 🟡 Medium | **Billing audit incomplete** — 286 schedulers, 153 triggers, 200 indexes never reviewed for duplication/polling waste. |
| B9 | 🟢 Low | **Accessibility audit** never run. |
| B10 | 🟢 Low | IntaSend split settlement decision (split disabled; collect-then-payout is the safe default). |

---

## Bottom line

**NO-GO for v1.0.0** — solely because of **CB1**. It is not a code defect; it is a **deployment-integrity** defect, and it is the single most dangerous item in the repo: the most ordinary command in the Firebase toolchain (`firebase deploy --only functions`) currently destroys 154 pieces of live infrastructure.

**CB1 is cheap to close** — one metrics query, then either delete or re-export. Do that, confirm `deployed == exported`, and the release has **no remaining Critical blockers**. Run **B2 (payments E2E)** and **B3 (rules review)** before taking real money, and v1.0.0 is a **GO**.

Related: [[RELEASE_v1.0.0_GO_NOGO]] · [[SMOKE_TEST_DISPATCH_RENAMES]] · [[SUBSCRIPTION_CONSOLIDATION]] · [[LEGAL_ACCEPTANCE_FRAMEWORK]]
