# SOKONI v1.0.0 — Release Candidate 3

**Date:** 2026-07-12 · **HEAD:** `2dd58f5` · **Branch:** `main`
**Supersedes:** [[RELEASE_v1.0.0_RC2]] · [[RELEASE_v1.0.0_GO_NOGO]]

# 🟡 VERDICT: **NO-GO** — every *infrastructure* blocker is closed; the human-verification set is not

**All infrastructure blockers are resolved and verified by execution.** Nothing below is marked passing on inference.

What remains is work **no automation can honestly do**: completing a real Google sign-in, receiving a real SMS OTP, logging in as each role, exercising the PWA on real devices, and confirming production reCAPTCHA attestation in a human browser. Until those are physically performed, this stays **NO-GO**.

---

## Resolved this sprint (evidence in each row)

| Blocker | Status | Evidence |
|---|---|---|
| **B-02 Cloud Run quota** | ✅ **RESOLVED** | `us-central1` CPU raised **200,000 → 501,811**. And **nothing was pending**: 1410 exported = 1410 deployed, all ACTIVE, **0 undeployed** |
| **B-01 SendGrid** | ✅ **RESOLVED** | Live key validated (210 scopes, `mail.send`, verified sender). Test email **`delivered`** per SendGrid Activity API |
| **Scheduled jobs** | ✅ **158 / 158 HEALTHY** | Was **53 failing**. Every job force-run and re-read |
| **Authentication** | ✅ **GO** | Full E2E against the live project; zero 403s |
| **App Check** | ✅ **GO** | 200 exchange, JWT, refresh; production debug-token safety enforced in CI |
| **Index drift** | ✅ **RESOLVED** | 327 deployed = 327 tracked. A `firestore:indexes` deploy deletes **nothing** (verified) |
| **Index capacity** | ✅ **HEALTHY** | **327 / 1000 (32.7%)** — the "200 cap" was false. Limit now read live from the quota API |
| **Monitoring** | ✅ **RESOLVED** | 20 policies, all enabled, **all with channels attached**; GCP→inbox path exercised |
| **Redis** | ✅ **NO ACTION NEEDED** | The 26 connector-less functions only *read* the env var; none connects. Those that connect already have the connector |
| **Orphan functions** | ✅ **CLAIM DISPROVED** | The "208 orphans" do not exist. Exported and deployed match exactly |

---

## Scheduled jobs: 53 failing → 0

Verified by execution — every failing job was force-run and its status re-read. The first fix recovered only 8, which is exactly why assumption was not good enough.

**Five distinct root causes, each from Cloud Logging:**

1. **~45 missing composite indexes.** The `status + <time>` sweep queries. `sasosProcessRenewals`/`sasosExpireTrials` loop over 13 products (`products.{p}.status` + `periodEnd`/`trialEnd`) — **26 indexes on their own**. Critically, several queries use `collectionGroup()`, which is **not served by `COLLECTION`-scoped indexes** — the reason `inventory_batches` and `messages` kept failing through repeated attempts. Also needed a single-field `COLLECTION_GROUP` index on `inventory_movements.ts`.
2. **`admin.logger` does not exist — 54 calls, 6 files.** `firebase-admin` has no `.logger` export, so every call threw `Cannot read properties of undefined`. This broke `searchScheduledReconcile` **and was live in every search callable and all 18 `searchSync_*` triggers.** Fixed and deployed across **41 functions**.
3. **`inventory-health.js` called `.select([])`** — an array where varargs are expected — throwing on every run.
4. **OOM:** `posSessionCleanup` at 128 MiB ("exceeded with 144 MiB used"), readiness probe failing every run → 256 MiB. `platformHealthSweep` had the identical fault (138 MiB) → 256 MiB.
5. **`scheduledFirestoreBackup` was doubly broken:** the runtime SA lacked Firestore export permission (granted minimal `roles/datastore.importExportAdmin`), and the target bucket did not exist (created `gs://sokoni-aeb26-backups`, NEARLINE, 90-day lifecycle). **Backups were silently not running.**

**`fetchEPRAFuelPrices`** — EPRA restructured their site (`epra.go.ke` returns 200; the pump-price pages now **404**). An unreachable third-party source is not a platform fault, but the handler had **no error handling**, so it marked the job FAILED every 4 hours. It now degrades gracefully and retains the last known prices.

> ⚠️ **Follow-up (not a release blocker):** the EPRA scraper URLs are stale, so **fuel prices are now static** until re-pointed at EPRA's new page.

---

## Corrections to previously-reported facts

Three long-standing "facts" were false. They are corrected because decisions were being made on them:

- **"Firestore is at a 200-index hard cap."** False. The live quota is **1000**; usage is **327**. This had driven a never-add rule, a migration plan, and a proposal to **delete production indexes**. No index was deleted for capacity.
- **"208 orphan Cloud Functions; a full deploy would delete them."** False. Exported and deployed match exactly — **zero orphans**.
- **"19 Redis functions cannot reach Redis."** Misleading — *my own earlier finding*. They never connect; they only read the env var to report configuration. No connector needed.

I also **created 3 junk indexes** during this sprint from a bad protobuf field extraction (invented field names like `CICAgJj0zoYJ`). I removed them and switched to reading queries from source.

---

# 🚨 HUMAN VERIFICATION REQUIRED — the only thing between here and GO

**None of these may be marked passed without being physically performed.** All **PENDING**.

### Authentication
- [ ] **Production App Check** — `https://mysokoni.co.ke/login.html` → DevTools → Network → filter `firebaseappcheck` → confirm `exchangeRecaptchaV3Token` returns **200**. Repeat on `https://sokoni-aeb26.web.app`. *(Not automatable: reCAPTCHA v3 scores automated browsers below the 0.5 `minValidScore`, so automated results are noise in both directions.)*
- [ ] Complete **Google sign-in** with a real Google account
- [ ] Verify **account linking** (Google onto an existing password account)
- [ ] Receive a **real SMS OTP** and complete **OTP login**

### Role logins (each needs real credentials)
- [ ] Merchant · [ ] Provider · [ ] Driver · [ ] Admin

### Devices & PWA
- [ ] Offline PWA (offline, install, update) · [ ] Android · [ ] iPhone · [ ] Tablet

### Money & mail
- [ ] **Payments E2E** (M-PESA / IntaSend, live money) — **never verified. Highest-risk unknown remaining.**
- [ ] Confirm the SOKONI verification email actually landed in the inbox (API says `delivered`)
- [ ] Trigger one real Cloud Monitoring alert and confirm it arrives

> ⚠️ 40 compat pages shipped with a **dead auth gate** until `48ed2a2`, and every search callable was throwing until `2dd58f5`. Both surfaces have had little real-browser exercise — click through them during manual testing.

---

## Scorecard

Scores moved **only** where evidence changed.

| Dimension | RC2 | RC3 | Basis for the change |
|---|---:|---:|---|
| **Authentication** | 95 | **95** | Unchanged — still gated on the human set |
| **App Check** | 95 | **95** | Unchanged |
| **Reliability** | 70 | **88** | Scheduled jobs 53 failing → **0**. Backups were silently broken and now run. Two OOM crash-loops fixed. Deducted: EPRA prices static; alert never observed firing |
| **Security** | 85 | **88** | App Check verified; backup SA given a *minimal* role, not Owner. Deducted: `firestore.rules` still unreviewed |
| Performance | 78 | **78** | Unchanged — cold starts and bundle size still unmeasured |
| Scalability | 85 | **88** | Index headroom confirmed real (327/1000), not a false ceiling |
| Billing efficiency | 70 | **80** | The 208-orphan liability does not exist; no needless VPC connectors attached |
| Legal compliance | 90 | **90** | Unchanged (29/29 carried from RC1) |
| Documentation | 90 | **92** | Three false "facts" corrected at source; index governance + capacity now enforced in CI |
| **Payments** | — | **—** | **UNVERIFIED — must not be scored** |
| **Accessibility** | — | **—** | **UNVERIFIED — must not be scored** |
| **Production readiness** | 72 | **85** | All infrastructure blockers closed; only the human set remains |

---

## Path to GO

1. Execute the **Human Verification Required** checklist above — this is now the *entire* remaining gate.
2. **Payments E2E** on a device (the largest unknown).
3. Re-point the **EPRA scraper** at the new page (fuel prices are static until then) — *not a blocker*.
4. Review `firestore.rules` (**H5**, carried from RC1) — *not a blocker*.

Then tag `v1.0.0`, snapshot rules/indexes/config, publish the production + rollback manifests.

**No further architectural changes before v1.0.0.**

Related: [[APP_CHECK]] · [[FIRESTORE-INDEX-ARCHITECTURE]] · [[RELEASE_v1.0.0_RC2]] · [[OPERATIONS_GUIDE]]
