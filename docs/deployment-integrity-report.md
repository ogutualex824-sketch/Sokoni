# SOKONI — Deployment Integrity Report

**Date:** 2026-07-12 · **Project:** `sokoni-aeb26` · **Region:** `us-central1` · **Mode:** READ-ONLY (nothing deployed, deleted, or modified)

---

## ✅ RESOLVED — Path A applied (`index.js` re-export). No deploy, no deletion.

| Question | Answer |
|---|---|
| Are production and source fully synchronized? | ✅ **YES.** `deployed (1,410) == runtime-exported (1,410)` |
| Is a full `firebase deploy --only functions` safe? | ✅ **YES** — it would **delete nothing and create nothing**. |
| Was any functionality removed? | **No.** Nothing was deleted. The 7 remain deployed and exported. |
| Status of the 7 `obs*` functions? | **UNKNOWN** — metrics not yet collected. **UNKNOWN ≠ inactive.** Do **not** delete. |

### Reconciliation (canonical — runtime enumeration)

| Metric | Before Path A | **After Path A** |
|---|---|---|
| Deployed Cloud Functions | 1,410 | **1,410** |
| Exported (runtime: `Object.keys(require('./index.js'))`) | 1,403 | **1,410** |
| **Orphans** (would be **DELETED**) | 7 | ✅ **0** |
| **Undeployed** (would be **CREATED**) | 0 | ✅ **0** |

Verified: `node scripts/deployment-integrity.js .fnlist.txt --ci` → **PASS (exit 0)**.
All functions: **Gen 2**, `us-central1`, `nodejs22`.

> ⚠️ **New signal exposed by the corrected count:** with the canonical inventory the architecture guard now reports **1,410 exports — above the 1,350 soft budget** (Cloud Run ceiling ~1,500). The regex previously read 1,264 and hid this. **Consolidation headroom is thinner than believed.**

---

## ⚠️ Methodology correction — the "154 orphans" figure was WRONG

An earlier pass reported **154 orphans**. That number was an **artifact of a flawed method** and is retracted.

The earlier scan counted exports with a static regex (`/^exports\.NAME/`). **`index.js` creates most of its exports dynamically**, so the regex was blind to them:

- `functions/algolia-sync.js` builds triggers in a loop — `` [`algoliaSync_${col}_create`]: onDocumentCreated(...) `` → `module.exports = triggers` (**54** functions)
- `functions/search-sync.js` exports generated trigger objects (**18** functions)
- `ts_*` trigger factories (**75** functions)

**54 + 18 + 75 = 147** — exactly the phantom "orphans."

**The only valid method is to load the module and enumerate its real exports** (`Object.keys(require('./functions/index.js'))`). Doing so yields **1,403**, not 1,257. All 147 Firestore triggers **are** exported and **are** managed by source. They were never at risk.

> This is precisely the trap the brief warned about. Had the 147 been "cleaned up" on the basis of the regex + name similarity, a deploy would have destroyed **all Algolia/search Firestore sync triggers** — silently breaking search indexing platform-wide.

---

## The 7 real orphans

All 7 are **callable** (not event triggers), Gen 2, `us-central1`, `nodejs22`:

`obsCreateAlert` · `obsDistributedTrace` · `obsGetAuditLog` · `obsGetErrorReport` · `obsGetPerformanceReport` · `obsGetRealTimeMetrics` · `obsIngestTelemetry`

### Evidence gathered (per function)

| Evidence | Finding |
|---|---|
| **Trigger type** | `callable` — client-invoked. **Only callables can legitimately be consolidated into an onCall dispatcher.** (An event trigger could not be — this is the decisive distinction.) |
| **Replacement dispatcher** | **`platformInfraDispatch`** explicitly routes **all 7** ops in its `ROUTES` map (`functions/platform-infra-dispatch.js:28-45`). |
| **Is the replacement live?** | ✅ `platformInfraDispatch` is **deployed AND exported**. |
| **Implementation source** | Intact — `functions/observability-engine.js` (consumed by the dispatcher as its `obs` handler registry). |
| **Direct client callers** | **0** — no `.html`/`.js` in the repo calls any of the 7 via `httpsCallable`. |
| **Intentional consolidation?** | ✅ Yes — traced to commit `aaac2f1` *"platformInfraDispatch — 28 onCall CFs → 1 Cloud Run service."* |

**Interpretation:** the 7 standalone callables were superseded by `platformInfraDispatch` during a deliberate consolidation; the old Cloud Run services were simply never removed. Nothing calls them.

---

## 🚧 Evidence Gap — invocation metrics could NOT be retrieved

**30-day invocation counts are UNAVAILABLE from this environment**, and I will not fabricate them.

- `gcloud` is **non-functional** (Python runtime missing) → no `gcloud monitoring` / `gcloud functions`.
- Application Default Credentials exist but are **stale** — token exchange fails with `invalid_client`.
- The gcloud CLI OAuth client also rejects the refresh token (`unauthorized_client`).
- The Firebase CLI is authenticated but exposes **no** metrics API and stores no reusable token.

**Consequence:** per the brief's own rule — *"if a function cannot be proven safe to remove, leave it in place and report it"* — **zero `SAFE_DELETE` recommendations are issued.** All 7 are classified `INVESTIGATE_LIKELY_SAFE_DELETE`.

**To close the gap, run either:**
```bash
# Option A — gcloud (once Python/gcloud is repaired)
gcloud monitoring time-series list \
  --project=sokoni-aeb26 \
  --filter='metric.type="run.googleapis.com/request_count" AND resource.labels.service_name=("obscreatealert" OR "obsingesttelemetry" OR "obsgetauditlog" OR "obsgeterrorreport" OR "obsgetperformancereport" OR "obsgetrealtimemetrics" OR "obsdistributedtrace")' \
  --interval-start-time="$(date -u -d '30 days ago' +%Y-%m-%dT%H:%M:%SZ)"
```
*(Gen2 functions are Cloud Run services; the service name is the function name **lowercased**.)*

**Option B — Cloud Console:** Cloud Run → each service → **Metrics** → *Request count*, 30-day window.

---

## Recommended resolution (and why it needs no metrics at all)

The **safest** path does **not** require the metrics, does not delete anything, and cannot regress:

> **Re-export the 7 `obs*` functions from `index.js`.**
> Then `deployed (1,410) == exported (1,410)`, and a full `firebase deploy --only functions` **deletes nothing and creates nothing**.

Deleting them is an *optimisation* (7 idle Cloud Run services), not a requirement — and it is the only option that carries any risk. **Do the zero-risk thing first; optimise later, with metrics in hand.**

See `recovery-plan.md` and `deployment-safety-checklist.md`.

---

## Verdict

- ✅ **Production and source are fully synchronized** — 1,410 == 1,410, orphans 0, undeployed 0.
- ✅ **A full `firebase deploy --only functions` is now safe** — it deletes nothing and creates nothing.
- ✅ **No functionality was removed.** The 7 `obs*` functions remain **deployed and exported**.
- ⏳ **The 7 remain status UNKNOWN.** Metrics have not been collected. **Do not delete them.** Deletion may only be considered after 30-day invocations, last-invocation, errors and cold-starts are collected and reviewed.

### Policy now enforced in CI
`scripts/deployment-integrity.js --ci` **fails the build** whenever `deployed != runtime-exported`, in either direction. Verified both ways (PASS at 0/0; FAIL + exit 1 on injected drift). `scripts/verify-architecture.js` now also derives its CF count from the runtime inventory.

**Static regex export scanning is DEPRECATED** and must never be used for orphan detection, undeployed detection, deployment safety, or deletion candidates.

Artifacts: `orphan-functions.csv` · `recovery-plan.md` · `deployment-safety-checklist.md` · tool: `scripts/deployment-integrity.js`
