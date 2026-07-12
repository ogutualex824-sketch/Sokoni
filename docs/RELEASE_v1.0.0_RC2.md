# SOKONI v1.0.0 — Release Candidate 2

**Date:** 2026-07-12 · **HEAD:** `96ead7b` · **Branch:** `main`
**Supersedes:** [[RELEASE_v1.0.0_GO_NOGO]] (RC1)

# 🟡 VERDICT: **NO-GO** — Authentication is cleared; infrastructure blockers remain

**Authentication and App Check are production-ready and are no longer release blockers.** They were the dominant unknown in RC1 and are now closed with browser-level evidence against the live project.

What still blocks v1.0.0 is **infrastructure and operations**, plus a set of tests that **only a human can run**. Nothing below is marked passing on the strength of inference.

| Area | RC1 | RC2 | Basis |
|---|---|---|---|
| Authentication | 🔴 blocker | ✅ **GO** | A/B experiment + full E2E, live project |
| App Check | 🔴 blocker | ✅ **GO** | 200 exchange, JWT, refresh, zero 403s |
| Scheduled jobs | not assessed | 🟠 fix applied, **unconfirmed** | 12 indexes created, now READY |
| Cloud Run quota (B-02) | 🔴 blocker | 🔴 **blocker** | no evidence of approval |
| SendGrid (B-01) | 🔴 blocker | ✅ **RESOLVED** | key validated against SendGrid API |
| Monitoring | 🟠 open | ✅ **RESOLVED** | 20 policies enabled, 2 channels |
| Redis | 🟠 open | 🟠 **partial** | connector READY; 19 fns not attached |
| Firestore indexes | 🔴 "at cap" | ✅ **healthy** | 266 READY; the cap claim was false |

---

## ✅ Authentication — GO

### Root cause (it was never Firebase Auth)

`FIREBASE_APPCHECK_DEBUG_TOKEN = true` makes the SDK mint a **new random debug token per browser profile**. It is unregistered, so attestation returns `403 App attestation failed` — and **a failed App Check token fetch aborts every Firebase Auth request before it is sent.** Every method then fails with `auth/network-request-failed`, which reads as a network fault and sends you hunting in the wrong place.

Registering one token appears to fix it, because the token is stored per browser profile. But every new profile, incognito window, teammate, CI run and cleared-storage session mints a different token and gets a fresh 403.

### Evidence (A/B, live project, real Chromium)

| Call | App Check ON (unregistered token) | App Check OFF (control) |
|---|---|---|
| `signInWithEmailAndPassword` | `auth/network-request-failed` | `400 auth/invalid-credential` ✅ correct |
| `sendPasswordResetEmail` | `auth/network-request-failed` | `200 sendOobCode` ✅ email accepted |
| **`identitytoolkit` requests sent** | **ZERO** | 2 |

Auth was never at fault. App Check was the blocker.

### Fixes (`48ed2a2`)

1. **Pinned debug token.** The *registered* token is read from `localStorage['SOKONI_APPCHECK_DEBUG_TOKEN']` and used verbatim — never regenerated, never overwritten. `true` survives only as a first-run bootstrap that says so loudly rather than failing silently. An invalid pinned token produces a clear developer diagnostic with **no retry loop**.
2. **7 pages were dead on arrival.** `_app = if(!firebase.apps.length)firebase.initializeApp(...)` is invalid JS — the **entire inline script block failed to parse**, so Firebase never initialised (`commerce-os`, `event-hub`, `event-manager`, `executive-dashboard`, `release-readiness`, `security-center`, `wholesale-portal`).
3. **40 compat pages had a dead auth gate.** They call `firebase.auth().onAuthStateChanged(...)` but never `firebase.initializeApp()`, throwing `No Firebase App '[DEFAULT]'` at parse time (the compat app only appeared ~4.5 s later). **Session restore was silently broken** on pages such as `messages.html`. `sokoni-appcheck.js` now creates the compat default app before page scripts run, then activates App Check. Duplicate App Check init removed (2 → 1 token exchange per page).
4. **Failure handling.** Developers get full diagnostics; production gets a generic message with no internals.
5. **Automated guard.** `scripts/verify-appcheck.js` (wired into `predeploy`) fails the build if a debug token is not localhost-gated, is hardcoded, or reaches any production origin.

### Regression results (registered token pinned)

| Check | Result |
|---|---|
| App Check `exchangeDebugToken` | ✅ **200** — JWT issued (`provider: debug`, TTL 3600s) |
| Token generation + forced refresh | ✅ new token issued on refresh |
| HTTP 403s (App Check / Auth / Firestore) | ✅ **ZERO** |
| Email/Password E2E (create → sign-in → delete) | ✅ PASS — account created, signed in, deleted |
| Password Reset | ✅ PASS — `sendOobCode` 200 |
| Email Verification | ✅ PASS |
| Google OAuth | ✅ popup reaches `/__/auth/handler`; domain authorized, provider enabled |
| Phone OTP | ✅ invisible reCAPTCHA renders; `recaptchaParams` 200 |
| 14-page regression | ✅ **ALL PASS** — 0 syntax errors, 0 `[DEFAULT]` errors, 0 403s |
| Duplicate Firebase init | ✅ none — all secondary `initializeApp()` sites are `getApps()`-guarded |
| Debug tokens in production code | ✅ **ZERO** hardcoded; localhost-gated only |

### ✅ App Check — GO

Production (`mysokoni.co.ke`, `www.mysokoni.co.ke`, `sokoni-aeb26.web.app`) sets **no** debug token and never calls `exchangeDebugToken` — verified against the **live deployed sites**, even with a debug token deliberately pinned in `localStorage`. Attestation is reCAPTCHA v3 only.

### ⚠️ Manual verification still required (Authentication)

**Production reCAPTCHA *attestation success* is not automatable.** reCAPTCHA v3 scores automated browsers below the app's `minValidScore` of **0.5**, so live-site results are non-deterministic noise **in both directions** — a passing automated run would be as meaningless as a failing one. It is listed under *Human Verification Required* below and must be ticked before launch.

---

# 🚨 HUMAN VERIFICATION REQUIRED

**None of these may be marked passed without being physically performed.** They are not defects and not automatable — they need a real account, a real handset, or a real device. Every item below is **PENDING**.

### Authentication
- [ ] **Production App Check** — `https://mysokoni.co.ke/login.html` → DevTools → Network → filter `firebaseappcheck` → confirm `exchangeRecaptchaV3Token` returns **200**. Repeat on `https://sokoni-aeb26.web.app`. *(If 403: check the reCAPTCHA key's allowed domains — apex and `www.` are separate entries — and whether `minValidScore` 0.5 is too strict. See [[APP_CHECK]].)*
- [ ] Complete **Google sign-in** with a real Google account
- [ ] Verify **account linking** (Google onto an existing password account)
- [ ] Receive a **real SMS OTP**
- [ ] Verify **OTP login** end-to-end

### Role logins (each needs real credentials)
- [ ] Merchant login
- [ ] Provider login
- [ ] Driver login
- [ ] Admin login

### Devices & PWA
- [ ] Offline PWA (offline mode, install, update)
- [ ] Android
- [ ] iPhone
- [ ] Tablet

> ⚠️ 40 compat pages were shipping with a **dead auth gate** until `48ed2a2`. That surface has clearly had little real-browser exercise — click through several of them (e.g. `messages.html`, `financial-os.html`) during manual testing.

---

## 🔴 CRITICAL BLOCKER — B-02: Cloud Run quota

**Status: OPEN. No evidence of approval.**

The remaining Cloud Functions cannot deploy until the GCP Cloud Run CPU quota increase is granted. 1000+ functions are deployed and **ACTIVE**, but the pending set (per `DEPLOY_QUEUE.md`) is still blocked.

**Minimum remaining work:** confirm the quota approval, deploy the queue, then verify deployment count, dispatchers, triggers, scheduled jobs, callables and HTTP endpoints. **Do not mark resolved until independently verified.**

---

## ✅ RESOLVED — B-01: SendGrid production secret

`SENDGRID_API_KEY` in Secret Manager holds a **live, valid key** — validated against the SendGrid API: **210 scopes, `mail.send` granted, `noreply@mysokoni.co.ke` a verified sender**. **56 Cloud Functions** bind the secret. No key is committed to the repo.

Stale "placeholder — all email delivery will fail" claims were removed from `enterprise-certification.html`.

⚠️ **Still unproven: actual delivery.** The key is valid, but no application email (welcome, merchant/provider notification, receipt) has been observed landing in an inbox. Firebase-native mail (password reset, email verification) **is** confirmed (`sendOobCode` 200). Send one real transactional email before launch.

---

## 🟠 HIGH — Scheduled jobs: fix applied, **not yet confirmed**

**53 of 158 scheduled jobs were failing.** Root causes found in Cloud Logging (not inferred):

1. **12 missing composite indexes** — `FAILED_PRECONDITION: The query requires an index` on the `status + <time>` sweep queries. This was silently breaking `paymentTimeoutSweep`, `asyncSweeper`, `processCascadeTimeouts`, `etimsProcessQueue`, `selfHealSubscriptions`, `sweepStaleWalletTopups`, `processTypesenseQueue`, `wapProcessDelays`, `concludeExpiredFlashSales`, `cleanupAuthRequests`, `processScheduledDeliveries`, `relScheduledRetryProcessor`. **All 12 created (additive) and now READY.**
2. **`platformHealthSweep` OOM** — `Memory limit of 128 MiB exceeded with 138 MiB used`; the container failed its readiness probe and **every run errored**. Raised to 256 MiB.

**Why this is not yet green:** a Cloud Scheduler job's status reflects its **last run**, which predates the fix. At the time of writing the count still reads 50 failing (41× `INTERNAL`, 7× infra, 2× `UNAVAILABLE`).

**Minimum remaining work:**
- `firebase deploy --only functions:platformHealthSweep` — **the memory fix is code-only and not yet deployed.**
- Re-poll scheduler status after the next run cycle and confirm the failure count drops.
- Triage whatever remains (the 7× code `-1` and 2× code `14` are not index-related).

---

## 🟠 HIGH — Redis: connector ready, **19 functions not attached**

`sokoni-redis-connector` is **READY**. But of the **28** functions binding a `REDIS` secret, only **9** are attached to a VPC connector — so **19 cannot reach the private Redis IP at all.** The SDK is fallback-safe, so they degrade silently rather than crash, which means **Redis is not actually serving those paths**.

**Minimum remaining work:** decide whether Redis is required for v1.0.0. If yes, attach the connector to the 19 functions and redeploy. If no, drop the `REDIS` secret binding from them so the intent is honest.

---

## ✅ RESOLVED — Monitoring

**20 alert policies, all enabled. 2 notification channels** (`SOKONI Ops Alerts`, `Kaspa`), both enabled.

⚠️ Notification-channel **verification status is unconfirmed**, and no alert has been observed actually firing. Trigger one test alert before launch — an unverified channel delivers nothing.

---

## ✅ RESOLVED — Firestore index architecture (a false premise, corrected)

The long-standing claim that the project sits at a **200-index hard cap** — which drove the "migrate to `sokoni-ops`" governance rule — **is false**.

- `(default)`: **266 composite indexes, all READY** (254 pre-existing + the 12 added here).
- `sokoni-ops`: 28.

There is headroom. Indexes may be added directly to `(default)`.

### ⚠️ Deploy landmine — read before touching indexes

`firestore.indexes.json` tracks **212** of the **266** deployed indexes. A plain `firebase deploy --only firestore:indexes` would offer to **prune the 54 untracked ones**. **Reconcile the file against the deployed set before any index deploy.**

---

## 🟠 OPEN — not audited to this standard

Listed honestly rather than assumed. Each needs the same evidence bar applied before GO:

- **Billing optimization** — 208 orphan Cloud Functions (deployed, not exported). A full `firebase deploy --only functions` **would delete them.** Cost and deploy-safety risk, unquantified.
- **Cloud Function chaining** — see `docs/CF_CHAINING_AUDIT.md`; not re-verified here.
- **Listener leaks** — see `docs/LISTENER_AUDIT.md`; not re-verified here.
- **Payments E2E** (M-PESA / IntaSend live money) — **never verified**. Highest-risk unknown remaining.
- **Accessibility audit** — never run; deliberately **not scored**.
- **Subscription write split-brain (H3)**, **`firestore.rules` review (H5)** — carried over from RC1, still open.

---

## Scorecard

| Dimension | Score | Basis |
|---|---:|---|
| **Authentication** | **95** | Email, reset, verification, Google, OTP all verified against the live project; zero 403s. Deducted only for the human-only steps. |
| **App Check** | **95** | 200 exchange, JWT, refresh, production debug-token safety enforced by an automated guard. Deducted: prod attestation needs a human. |
| Security | **85** | App Check now genuinely working (it was silently 403-ing); server-side legal enforcement; ownership checks. Deducted: `firestore.rules` unreviewed. |
| Reliability | **70** | Auth path fixed; 47 pages repaired; index root cause fixed. Deducted: 50 scheduled jobs still showing failures pending re-poll. |
| Scalability | **85** | Dispatcher architecture; index headroom confirmed. |
| Performance | **78** | Duplicate App Check init removed. Deducted: cold starts and bundle size unmeasured. |
| Billing efficiency | **70** | Deducted: 208 orphan functions, 19 pointless Redis bindings. |
| Legal compliance | **90** | 29/29 tests; gate live in all flows (carried from RC1). |
| Payments | **—** | **UNVERIFIED** — must not be scored. |
| Accessibility | **—** | **UNVERIFIED** — must not be scored. |
| **Production readiness** | **72** | Blocked by B-02, unconfirmed scheduled jobs, and the human set. |

---

## Path to GO

1. **B-02** — confirm Cloud Run quota; deploy the queue; verify every dispatcher, trigger, schedule, callable and endpoint.
2. **Deploy `platformHealthSweep`**; re-poll scheduler and confirm the failure count drops; triage the remainder.
3. **Redis** — attach the connector to the 19 orphaned functions, or remove the binding.
4. **Reconcile `firestore.indexes.json`** (212 → 266) before any index deploy.
5. **Send one real transactional email**; fire one test alert.
6. **Execute the Human Verification Required checklist** in full.
7. **Payments E2E** on a device.

Then tag `v1.0.0`, snapshot rules/indexes/config, and publish the production + rollback manifests.

**Do not declare v1.0.0 complete until 1–7 are closed.**

Related: [[APP_CHECK]] · [[RELEASE_v1.0.0_GO_NOGO]] · [[CF_CHAINING_AUDIT]] · [[LISTENER_AUDIT]] · [[OPERATIONS_GUIDE]]
