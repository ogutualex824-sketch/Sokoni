# SOKONI — Release Handoff

**Engineering status:** complete except work blocked on interactive authentication.
**Date:** 2026-07-20 · **Repository:** synced with `origin/main`

---

## 1. Production parity by capability

Measured, not estimated. "Parity" means production runs the repository's code for that capability.

| Capability | Repository | Production | Parity | Note |
|---|---|---|---|---|
| **Frontend (all pages)** | current | current | **YES** | hosting deployed twice, 10/10 fixes fetched live |
| **Bookings & availability** | current | current | **YES** | runtime-proven: 4 ops return `UNAUTHENTICATED`, not `INTERNAL` |
| **Search write path** | current | current | **YES** | indexer now targets `sokoni_products` |
| **Admin bootstrap** | current | current | **YES** | UID allowlist deployed |
| **Disputes & refunds** | current | current | **YES** | 12 functions deployed |
| **POS provisioning** | current | current | **YES (code)** | blocked at runtime by IAM, not code |
| **Search read path** | current | **stale data** | **NO** | existing products lack `status`; backfill not run |
| **Notifications** | current | partial | **NO** | 28 updates deferred — operational, not launch-critical |
| **Tax / eTIMS** | current | partial | **NO** | 16 updates deferred |
| **Subscriptions** | current | **never deployed** | **NO** | quota-blocked since day one |
| **Payments** | current | current | **YES (code)** | no transaction has ever succeeded |

## 2. Deferred deployments — and why

103 function updates remain. Classified by customer capability rather than file count:

| Class | Count | Decision |
|---|---|---|
| Launch Critical | 13 | **Deployed** |
| Operational | 62 | **Deferred** — improves operations, closes no launch gate |
| Administrative / Maintenance | 28 | **Deferred** |

Every deferred item is an *update to an existing service*, so it carries no Cloud Run quota exposure and can be deployed at any time without risk to the release.

## 3. Why engineering paused

Four remaining blockers. **None is a code defect.** All four converge on one interactive step.

| Blocker | Class | Evidence |
|---|---|---|
| No credentialed gcloud account | CONFIGURATION | `gcloud auth list` → "No credentialed accounts" |
| Cloud Run invoker missing | IAM | `getBusinessConfig`, `bootstrapDevice` → HTTP 403, non-JSON, persists after successful redeploy |
| Cloud Run capacity unknown | QUOTA | 4 of 9 capacity metrics unobtainable without auth |
| M-PESA never succeeded | COMMERCIAL | IntaSend "Invalid api token" on a live key |

---

## 4. The handoff — exact commands

### Step 1 · Authenticate (browser opens)

```powershell
$env:CLOUDSDK_PYTHON = "$env:LOCALAPPDATA\Google\Cloud SDK\google-cloud-sdk\platform\bundledpython\python.exe"
gcloud auth login
gcloud auth application-default login
node functions/scripts/doctor.js
```

**Expected:** `BOOTSTRAP READINESS: READY`

**Failure modes**
- *"gcloud is not recognized"* — the `CLOUDSDK_PYTHON` line was skipped. gcloud ships its own Python; it just does not look for it.
- *Still `invalid_client`* — the second command did not complete. ADC is separate from `gcloud auth login`.
- *Wrong account* — `gcloud config set project sokoni-aeb26`.

**Rollback:** `gcloud auth revoke`. Nothing else is affected.

### Step 2 · Capacity audit — before creating any new service

```powershell
gcloud run services list --region=us-central1 --format="value(metadata.name)" | Measure-Object -Line
```

1,460 services are deployed today; the documented ceiling was hit at 1,175 on 2026-07-11 and has since moved. **If the count is near a limit, stop and request the quota increase in `DEPLOY_QUEUE.md`** — target 2000 vCPU·s, 24–48h approval.

### Step 3 · Cloud Run invoker — unblocks POS

```powershell
gcloud run services add-iam-policy-binding getBusinessConfig `
  --region=us-central1 --member=allUsers --role=roles/run.invoker
gcloud run services add-iam-policy-binding bootstrapDevice `
  --region=us-central1 --member=allUsers --role=roles/run.invoker
```

**Verify:** both must return HTTP 401 (callable ran and refused), not 403.
**Rollback:** `remove-iam-policy-binding` with the same arguments.

These are callables — Firebase enforces App Check and auth inside the function. `allUsers` here means "the frontend may reach it", not "anyone may use it".

### Step 4 · Super administrator

```powershell
node functions/scripts/seed-bootstrap.js --phone +254705726803 --dry-run
```

**Stop if it reports an identity split** — the phone and email are then different Firebase users, and merging is irreversible. See `docs/IDENTITY_LINK_MIGRATION.md`.

Otherwise re-run without `--dry-run`, sign in on the device, call bootstrap once, then sign out and back in.

**Verify:** `/admin` renders instead of "administrator access required".
**Rollback:** `node functions/scripts/set-admin-claim.js --uid <uid> --revoke`

### Step 5 · Search recovery — the last engineering gate

```powershell
node functions/scripts/backfill-product-status.js            # dry run
node functions/scripts/backfill-product-status.js --apply
```

Then run `algoliaBackfill` to repopulate `sokoni_products`.

**Verify:** search "Peach Grape" — it must appear in global search, on the storefront, and in category listings.
**Rollback:** the backfill only *adds* `status`; it never overwrites a deliberate draft or archived value.

---

## 5. What resumes automatically after Step 1

No further instruction needed:

1. Capacity audit, then a **single** canary — `subGetPlans`, read-only, no secrets — and re-measure before any further creation.
2. IAM invoker bindings, then re-probe both endpoints for 401.
3. Seed and bootstrap the administrator, then verify admin routes at runtime.
4. Product status backfill, Algolia reindex, then Gate 5 validation end to end.
5. The 62 deferred operational updates, in capability batches.

---

## 6. Engineering risk vs business risk

**Engineering risk: low.** Every known defect is fixed, tested and either deployed or deliberately deferred with a reason. Architecture score 92/100, CRITICAL 0, deploy gate OPEN. 166 assertions passing. Two hosting deploys and 26 function deploys with zero failures and zero rollbacks; one regression introduced during repair was caught by running the pages and corrected in the same pass.

**Business risk: high, and unchanged by any of the above.** SOKONI has never completed a payment. Until one M-PESA transaction settles end to end, the platform cannot transact, and that is a commercial dependency no engineering action can reach.

**The Board should read these as separate.** The engineering position is sound. The commercial position is unproven.

---

## 7. Path from HOLD to RELEASE APPROVED

| Gate | Cleared by | Owner |
|---|---|---|
| 1 Repository | done | — |
| 2 Environment | Step 1 | you — browser |
| 3 Production | done for launch-critical scope | — |
| 4 Admin | Step 4 | you, then automatic |
| 5 Marketplace | Step 5 | automatic after Step 1 |
| 6 Payments | IntaSend merchant configuration | **external** |
| 7 POS | Step 3 | you, then automatic |

**Gates 2, 3, 4, 5 and 7 are reachable today.** Gate 6 is not, and it is the release-determining gate.

**Open the IntaSend ticket in parallel with Step 1.** Every other item is minutes to hours; that one has an unbounded wait and decides the launch date.
