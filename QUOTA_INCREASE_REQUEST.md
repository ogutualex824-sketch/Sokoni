# GCP Quota Increase Request — SOKONI Cloud Functions

**Purpose:** Unblock deployment of 187 pending Cloud Functions (Gen2 = Cloud Run
services) that currently fail with `HTTP 429 — insufficient quota` in `us-central1`.

## Project identifiers (for the form)
| Field | Value |
|---|---|
| Project ID | `sokoni-aeb26` |
| Project number | `24799054989` |
| Region | `us-central1` |
| Currently deployed functions | ~1512 |
| Pending (blocked) | 187 |
| Target capacity (with headroom) | ~1800 functions |

---

## How to file
GCP Console → **IAM & Admin → Quotas & System Limits**
(direct: https://console.cloud.google.com/iam-admin/quotas?project=sokoni-aeb26)
→ paste each **metric name** below into the filter → tick the row for
**region `us-central1`** → **Edit Quotas** / **Request increase** → enter the
"Requested limit" → submit with the justification text at the bottom.

---

## Quotas to raise (in priority order)

### 1. Cloud Run — CPU allocation (the primary blocker)
- **Service:** Cloud Run Admin API (`run.googleapis.com`)
- **Metric / limit name:** **"CPU allocation without committed use (Total, per region)"**
  (may also appear as **"Total CPU"** per region)
- **Region:** `us-central1`
- **Why:** each Gen2 function is a Cloud Run service that reserves CPU; 187 new
  services can't be created at the current ceiling.
- **Requested limit:** **2400 vCPU** (covers ~1800 functions @ ~1 vCPU + burst headroom)

### 2. Cloud Run — Services per region (secondary ceiling — check this too)
- **Service:** Cloud Run Admin API (`run.googleapis.com`)
- **Metric / limit name:** **"Services"** / **"Container instances per region"**
  (default is often **1000 services per region** — already exceeded at 1512, so a prior
  bump exists; raise it again to clear the new set)
- **Region:** `us-central1`
- **Requested limit:** **2000 services**

### 3. Cloud Build — concurrent builds (avoids slow/failed rollout of a large batch)
- **Service:** Cloud Build API (`cloudbuild.googleapis.com`)
- **Metric / limit name:** **"Concurrent builds"**
- **Region:** global / `us-central1`
- **Requested limit:** **50** (default is often 10–30; a 187-function deploy builds many images)

### 4. Cloud Functions API (usually fine, but verify)
- **Service:** Cloud Functions API (`cloudfunctions.googleapis.com`)
- **Metrics to eyeball:** **"Function CPU"**, **"Function instances"** per region — raise
  only if the form shows usage near the limit.

---

## Justification text (paste into the request's reason field)

> SOKONI is a production multi-vendor commerce platform running ~1,512 Gen2 Cloud
> Functions in us-central1. We are rolling out 187 additional functions (financial
> settlement, POS terminal integration, subscriptions, session security, and the
> async job engine) that are code-complete but failing to create with
> "insufficient quota / could not create Cloud Run service." We are requesting an
> increase to the regional Cloud Run CPU allocation (and service-count limit) to
> accommodate ~1,800 total functions with modest burst headroom. Traffic is steady
> production load; this is platform expansion, not a spike test.

---

## After approval
Quota changes usually apply within minutes–hours. Then, from the repo root
(with the npm fetch-timeout workaround), deploy the async job engine **first** to
restore background processing, then the rest:

```powershell
npm config set fetch-timeout 3000; npm config set fetch-retry-mintimeout 1000
# 1) restore job processing first (11 async* workers)
firebase deploy --only "functions:asyncWorker,functions:asyncSweeper,functions:asyncEnqueue,functions:asyncEventRouter,functions:asyncCancel,functions:asyncRetryJob,functions:asyncPauseQueue,functions:asyncGetDashboard,functions:asyncGetJobs,functions:asyncInspect,functions:asyncCleanup" --project sokoni-aeb26
# 2) then everything else that is new/changed
firebase deploy --only functions --force --project sokoni-aeb26
npm config delete fetch-timeout; npm config delete fetch-retry-mintimeout
```

_Full pending list: `PENDING_FUNCTIONS.txt` (187 names)._
