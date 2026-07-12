# SOKONI — Deployment Integrity Recovery Plan

**Scope:** eliminate the 7-function delta between production (1,410) and source (1,403) so that a full `firebase deploy --only functions` is provably safe.
**Constraint honoured:** this plan **proposes**; it does not deploy, delete, or modify production.

---

## Recovery table

| Function | Trigger | Status | 30-day Invocations | Recommendation |
|---|---|---|---|---|
| `obsCreateAlert` | callable | UNKNOWN | **UNAVAILABLE** | Investigate → Recover Source (preferred) |
| `obsDistributedTrace` | callable | UNKNOWN | **UNAVAILABLE** | Investigate → Recover Source (preferred) |
| `obsGetAuditLog` | callable | UNKNOWN | **UNAVAILABLE** | Investigate → Recover Source (preferred) |
| `obsGetErrorReport` | callable | UNKNOWN | **UNAVAILABLE** | Investigate → Recover Source (preferred) |
| `obsGetPerformanceReport` | callable | UNKNOWN | **UNAVAILABLE** | Investigate → Recover Source (preferred) |
| `obsGetRealTimeMetrics` | callable | UNKNOWN | **UNAVAILABLE** | Investigate → Recover Source (preferred) |
| `obsIngestTelemetry` | callable | UNKNOWN | **UNAVAILABLE** | Investigate → Recover Source (preferred) |

**Safe Delete: 0 issued.** No function may be classified `Safe Delete` without invocation evidence. Status is `UNKNOWN` — *not* `Inactive* — because it is unmeasured, not measured-as-zero.

**Recover Source: 0 required for correctness** — the *implementation* is intact (`functions/observability-engine.js`); only the **export** is missing.

---

## Two valid paths

> ## ✅ PATH A HAS BEEN APPLIED
> The 7 functions are now re-exported from `functions/index.js`.
> **Runtime inventory: 1,410 exported == 1,410 deployed · orphans 0 · undeployed 0.**
> CI gate: **PASS**. A full functions deploy would now delete nothing.
> **The 7 remain deployed, exported, and status UNKNOWN. Do not delete them.**

---

### ✅ Path A — RE-EXPORT (applied: zero-risk, no metrics needed)

Make source a complete superset of production. A full deploy then deletes nothing.

1. Append to `functions/index.js`:
   ```js
   /* Observability standalone callables — kept exported so a full deploy does not
      delete them. Superseded by platformInfraDispatch; retained for compatibility. */
   const _obsStandalone = require('./observability-engine');
   exports.obsCreateAlert          = _obsStandalone.obsCreateAlert;
   exports.obsDistributedTrace     = _obsStandalone.obsDistributedTrace;
   exports.obsGetAuditLog          = _obsStandalone.obsGetAuditLog;
   exports.obsGetErrorReport       = _obsStandalone.obsGetErrorReport;
   exports.obsGetPerformanceReport = _obsStandalone.obsGetPerformanceReport;
   exports.obsGetRealTimeMetrics   = _obsStandalone.obsGetRealTimeMetrics;
   exports.obsIngestTelemetry      = _obsStandalone.obsIngestTelemetry;
   ```
   ✅ **Verified (runtime check):** all 7 are already exported from `observability-engine.js` as **deployable `onCall` function objects** (each carries a `__endpoint`). No wrapping is required — the re-export above is sufficient and correct as written.
2. Re-run the reconciler → expect **orphans: 0, undeployed: 0**:
   ```bash
   firebase functions:list > .fnlist.txt
   node scripts/deployment-integrity.js .fnlist.txt
   ```
3. A full deploy is now safe (it will simply *update* all 1,410).

**Risk: none.** Nothing is deleted; the 7 keep working exactly as today.

---

### ⚙️ Path B — DELETE (optimisation only; requires evidence)

Only after **proving** 30-day invocations = 0.

1. **Obtain metrics** (see `deployment-integrity-report.md` → Evidence Gap).
2. **If any function has > 0 invocations** → abort deletion; use **Path A** and find the caller (a server-side or external client not visible in this repo).
3. **If all are 0**, confirm no dependent infrastructure before deleting:
   - Cloud Scheduler jobs targeting them → `gcloud scheduler jobs list`
   - Eventarc triggers → `gcloud eventarc triggers list`
   - Pub/Sub subscriptions → `gcloud pubsub subscriptions list`
   - Firestore triggers → N/A (all 7 are `callable`, so **none**)
   - External webhooks / partner integrations calling the callable URL directly
4. Delete **one at a time**, lowest-risk first, verifying the platform between each:
   ```bash
   firebase functions:delete obsDistributedTrace --region us-central1 --force
   ```
5. Re-run the reconciler after each deletion.

**Benefit:** reclaims 7 idle Cloud Run services (cost + quota headroom).
**Risk:** if any hidden caller exists, it breaks. This is why Path A comes first.

---

## Recommended sequence

1. **Do Path A now.** It closes the deployment-integrity blocker immediately, at zero risk, without needing Cloud Monitoring.
2. **Then** repair `gcloud` and pull the 30-day metrics at leisure.
3. **Then** optionally execute Path B to reclaim the 7 idle services.

This ordering means the release is never blocked on a metrics query.

---

## What does NOT need recovery

The previously-reported **147 "orphaned" Firestore triggers** (`algoliaSync_*`, `searchSync_*`, `ts_*`) are **fully exported and managed by source** — they were a false positive from a static-regex export scan that could not see dynamically-generated exports. **No action required. Do not delete them.** They are the live Algolia/search Firestore sync layer.

Related: `deployment-integrity-report.md` · `orphan-functions.csv` · `deployment-safety-checklist.md`
