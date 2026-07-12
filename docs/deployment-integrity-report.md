# SOKONI — Deployment Integrity Report

**Date:** 2026-07-12 · **Project:** `sokoni-aeb26` · **Region:** `us-central1` · **Mode:** READ-ONLY (nothing deployed, deleted, or modified)

---

## Executive answer

| Question | Answer |
|---|---|
| Are production and source fully synchronized? | **NO — but the gap is 7 functions, not 154.** |
| Is a full `firebase deploy --only functions` safe **right now**? | **NO.** It would **delete 7** live functions. |
| Is any production *functionality* at risk of being lost? | **Very likely not** — all 7 are superseded, but this is **not yet proven** (see Evidence Gap). |
| Can this be closed safely? | **Yes — trivially.** Re-export 7 functions → `deployed == exported` → a full deploy becomes a no-op. |

### Reconciliation (authoritative)

| Metric | Count |
|---|---|
| Deployed Cloud Functions | **1,410** |
| Exported by `functions/index.js` (**runtime enumeration**) | **1,403** |
| **Orphans** — deployed, NOT in source (would be **DELETED**) | **7** |
| **Undeployed** — in source, NOT deployed (would be **CREATED**) | **0** |

All functions: **Gen 2**, `us-central1`, `nodejs22`.

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

- **Production and source are NOT fully synchronized** (7-function delta).
- **A full functions deploy is NOT currently safe** — it would delete 7 live services.
- **No production *functionality* appears to be at risk** — the 7 are superseded by a live dispatcher with zero callers — but this rests on static evidence, not invocation metrics.
- **After the 7 are re-exported, a full deploy is provably safe** (zero deletions, zero creations).

**Until then: targeted deploys only** (`firebase deploy --only functions:<name>`).

Artifacts: `orphan-functions.csv` · `recovery-plan.md` · `deployment-safety-checklist.md` · tool: `scripts/deployment-integrity.js`
