# Phase 4.2 — Codebase Split + Multi-Region Runbook (P0-4)

**Goal:** permanently clear the Cloud Run per-region CPU quota ceiling that blocks all
new-function deploys, by (1) splitting the single 1,785-export functions codebase into
domain codebases, and (2) distributing latency-tolerant codebases across a second region.
**Non-destructive:** no function is deleted; nothing changes for clients. Function IDs and
call sites are unchanged — only *where the code is built/deployed* changes.

> ⚠️ **Sequencing rule:** do **not** run this against production first. Stand up the
> `sokoni-staging` project (Step 0) and rehearse the whole runbook there. The audit's #1
> DevOps risk (P1-7) is that there is no pre-prod isolation.

Related: [[PHASE_4_ARCHITECTURE_AUDIT]] · [[DEPLOY_QUEUE]]

---

## Why this works (the arithmetic)
- Every Gen2 function = one Cloud Run service; **"CPU allocation without committed use" is a per-region quota.**
- ~1,800 services all in `us-central1` → the region's CPU allocation is exhausted → HTTP 429 on every new-service create.
- **Splitting services across 2–3 regions multiplies effective quota** (each region has its own allocation), and **splitting the monolith into codebases** shrinks each cold-start bundle and isolates deploy blast radius. Together they end the ceiling *and* stop it recurring.

---

## Step 0 — Staging project (prerequisite, one-time)

```bash
# Create an isolated staging project (or reuse an existing non-prod one)
gcloud projects create sokoni-staging --name="SOKONI Staging"
# Link billing (replace with your billing account id)
gcloud billing projects link sokoni-staging --billing-account=XXXXXX-XXXXXX-XXXXXX
# Enable the same APIs as prod
gcloud services enable run.googleapis.com cloudfunctions.googleapis.com \
  cloudbuild.googleapis.com firestore.googleapis.com firebaseappcheck.googleapis.com \
  --project sokoni-staging
```

Add the target to `.firebaserc`:
```json
{
  "projects": { "default": "sokoni-aeb26", "staging": "sokoni-staging" },
  "targets": {}
}
```
Update CI `deploy-staging` to `--project sokoni-staging` (today it points at prod — DEV-1).

---

## Step 1 — Define codebase boundaries

Convert `firebase.json`'s single `functions` **object** into an **array of codebases**.
Proposed boundaries (by the module families the audit found — pos:22, algolia:13,
search:9, typesense:9, security:9, inventory:11, loyalty, finos, …):

| Codebase | Domain | Source dir | Region(s) | Why |
|---|---|---|---|---|
| `core-commerce` | orders, cart, checkout, products, delivery, reviews | `functions-core/` | us-central1 **+** europe-west1 | hot buyer paths; warm + multi-region |
| `payments` | IntaSend/Daraja, wallet, escrow, finos | `functions-payments/` | us-central1 (+ warm) | revenue path; `minInstances` |
| `pos` | SmartPOS (22 modules) | `functions-pos/` | us-central1 | large, self-contained |
| `search` | **ONE** backend (retire the other two) | `functions-search/` | us-central1 | consolidate 31→~10 modules (P2-1) |
| `loyalty` | loyalty, rewards, subscriptions | `functions-loyalty/` | us-central1 | |
| `admin` | admin-os, ops, analytics, back-office | `functions-admin/` | **europe-west1** | latency-tolerant → 2nd region |
| `triggers` | Firestore doc triggers + schedulers (160 + 95) | `functions-triggers/` | **europe-west1** | latency-tolerant → 2nd region |
| `ai` | KASS / sokoniChat | `functions-ai/` | us-central1 | warm for chat |

> Moving `admin` + `triggers` (≈250+ services) to `europe-west1` alone frees a large
> slice of the `us-central1` allocation immediately — that is the fastest single lever.

`firebase.json` shape (each codebase is an entry; keep global runtime defaults):
```jsonc
{
  "functions": [
    { "source": "functions-core",     "codebase": "core-commerce", "runtime": "nodejs22" },
    { "source": "functions-payments", "codebase": "payments",      "runtime": "nodejs22" },
    { "source": "functions-pos",      "codebase": "pos",           "runtime": "nodejs22" },
    { "source": "functions-search",   "codebase": "search",        "runtime": "nodejs22" },
    { "source": "functions-loyalty",  "codebase": "loyalty",       "runtime": "nodejs22" },
    { "source": "functions-admin",    "codebase": "admin",         "runtime": "nodejs22" },
    { "source": "functions-triggers", "codebase": "triggers",      "runtime": "nodejs22" },
    { "source": "functions-ai",       "codebase": "ai",            "runtime": "nodejs22" }
  ]
}
```

**Region per codebase** — set once at the top of each codebase's `index.js`:
```js
const { setGlobalOptions } = require('firebase-functions/v2');
setGlobalOptions({ region: 'europe-west1' }); // admin & triggers; us-central1 elsewhere
```

---

## Step 2 — Physically move modules (mechanical, reversible)

Two viable strategies — pick **A** for lowest risk:

**A) Thin re-export shim (recommended, minimal churn).** Keep all module files where they
are; each new `functions-<domain>/index.js` just re-exports the subset it owns:
```js
// functions-admin/index.js
const { setGlobalOptions } = require('firebase-functions/v2');
setGlobalOptions({ region: 'europe-west1' });
module.exports = {
  ...require('../functions/admin-os'),
  ...require('../functions/ops-center'),
  // …only admin-domain modules…
};
```
Each codebase's `package.json` sets `"main": "index.js"` and lists only that domain's deps.
This keeps one source tree, so shared utils don't duplicate, while Firebase treats each as
its own codebase/deploy unit. (Validate that Firebase's discovery loads only the referenced
tree — if it over-includes, fall back to B.)

**B) Hard move.** `git mv` each module into its `functions-<domain>/` dir with a shared
`functions-common/` package for utilities. Cleaner long-term, more churn now.

**Do NOT** keep the giant `functions/index.js` as a codebase — it's what forces every cold
start to load 139k LOC + 121 `defineSecret`s. Split its 1,610 re-exports across the domain
entry points.

---

## Step 3 — Deploy order (staging → prod, per codebase)

```bash
# rehearse on staging
firebase deploy --only functions:admin --project sokoni-staging
firebase deploy --only functions:triggers --project sokoni-staging
# … smoke test …

# prod: move the latency-tolerant codebases to the 2nd region FIRST (frees us-central1)
firebase deploy --only functions:admin --project sokoni-aeb26
firebase deploy --only functions:triggers --project sokoni-aeb26
# then the rest, one codebase at a time, watching quota
firebase deploy --only functions:search --project sokoni-aeb26   # after consolidating to one backend
firebase deploy --only functions:pos --project sokoni-aeb26
# …core-commerce, payments, loyalty, ai…
```

> Deleting the old single-codebase functions happens implicitly as each is re-homed. Firebase
> will prompt to delete the old-region copies — confirm per codebase after verifying the new
> region serves traffic. Client call sites are unchanged (same function names).

---

## Step 4 — Quota increase (parallel track — see QUOTA_INCREASE_REQUEST.md)
Even after region-splitting, request the `us-central1` **and** `europe-west1` Cloud Run CPU
increases so each region has headroom. This plus the split gives durable capacity for the
187 pending CFs and future growth.

---

## Step 5 — Redis VPC connector (unblocks P0-5/P1-1, do alongside)
```bash
gcloud compute networks vpc-access connectors create sokoni-redis-connector \
  --network default --region us-central1 --range 10.8.0.0/28 --project sokoni-aeb26
```
Then keep the `vpcConnector: 'sokoni-redis-connector'` already hard-coded in
`redis-layer.js`/`redis-integrations.js` — the connector will finally exist, restoring locks,
presence, POS sync, and the Redis queue. (Until then, the P0-5 Firestore rate-limit fallback
already shipped keeps brute-force protection alive.)

---

## Expected impact
- **Immediate:** moving `admin`+`triggers` to `europe-west1` frees a large `us-central1`
  slice → new-function deploys succeed again (unblocks the 187 pending CFs).
- **Cold starts:** each function loads only its codebase's modules, not 139k LOC.
- **Blast radius:** a bad module breaks one codebase's deploy, not all ~1,800 functions.
- **Durability:** function count can grow per-domain without re-hitting a single region's ceiling.
- **Resilience:** groundwork for regional failover (multi-region core-commerce).

## Risks & mitigations
| Risk | Mitigation |
|---|---|
| A trigger fires in the wrong/both regions after move | Move triggers to exactly one region; verify no duplicate `onDocument*` across codebases |
| Shim strategy over-includes files | Validate discovery on staging; fall back to hard-move (B) |
| Client latency for EU-region admin calls | Only latency-tolerant/back-office code moves to EU; buyer paths stay us-central1 |
| Firestore trigger region vs data region | Firestore is multi-region `nam5`/config — triggers can run cross-region; confirm on staging |
| Deploy prompts to delete old-region functions | Confirm per codebase only after new region verified healthy |

**Bottom line:** this is the durable fix for the quota ceiling and the biggest single
maintainability win. Rehearse on `sokoni-staging`, move `admin`+`triggers` to `europe-west1`
first for the fastest relief, then split the remainder codebase-by-codebase.
