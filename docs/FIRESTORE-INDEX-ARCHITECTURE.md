# Firestore Index Architecture

*SOKONI Platform — index inventory, capacity strategy, governance, rollback, migration plan.*
*Last verified against the live project: **2026-07-12**.*

Related: [[RELEASE_v1.0.0_RC2]] · [[OPERATIONS_GUIDE]] · [[Payments]] · [[SmartPOS]]

---

## ⚠️ Correction: the "200-index hard limit" was false

Previous revisions of this document stated a **200-index hard limit** (*"Current: 182. Reserve: 18 slots. Trigger review at 190"*). That number was never verified against Google's API. It propagated between documents until it read as fact, and it drove real decisions: a "never add — migrate to `sokoni-ops`" rule, a migration plan, and a proposal to **delete production indexes to free slots**.

**Measured directly on 2026-07-12:**

| Source | Value |
|---|---|
| `serviceusage` quota — `Composite Indexes Per Database` | **1000** (this *is* the default limit) |
| Firestore Admin API — `(default)` | **266** composite indexes, all `READY` |
| Firestore Admin API — `sokoni-ops` | **28** composite indexes, all `READY` |

**`(default)` is at 266 / 1000 — 27% used, 734 slots free.** The database was never near a cap. (It already held 254 indexes while the docs claimed a 200 ceiling — which alone disproves the ceiling.)

**Consequences:**
- ❌ Do **not** delete indexes to "free slots". No slots are needed.
- ❌ Do **not** migrate collections to `sokoni-ops` for capacity reasons.
- ✅ New indexes may be added directly to `(default)`.
- ✅ Capacity is now **measured**, never assumed.

> **Keep this lesson.** Capacity claims must come from `scripts/index-capacity-report.js`. Never from memory, and never from this file — the table below is a snapshot and will drift.

---

## 🚨 Deploy landmine — read before touching indexes

`firestore.indexes.json` declares **212** indexes. **266** are deployed.

A plain `firebase deploy --only firestore:indexes` will offer to **prune the 54 deployed indexes the file does not track**. Accepting that prompt drops live indexes and breaks the queries behind them.

**Before any index deploy:** reconcile the file against the deployed set, or explicitly review the prune list. **Never accept the prompt blind.**

---

## Inventory (snapshot — regenerate before relying on it)

```bash
npm run report:index-capacity              # human-readable
node scripts/index-capacity-report.js --json
```

| Database | Used | Limit | % | Operational | Product | Status |
|---|---:|---:|---:|---:|---:|---|
| `(default)` | 266 | 1000 | 26.6% | 44 | 222 | ✅ HEALTHY |
| `sokoni-ops` | 28 | 1000 | 2.8% | 14 | 14 | ✅ HEALTHY |

Heaviest collections in `(default)`: `posCashEvents` (8) · `bookings` (7) · `orders` (7) · `_sokoniTaskQueue` (5) · `packageRequests` (4) · `priceAlerts` (4).

---

## Architecture principles

| Principle | Implementation |
|---|---|
| **One index per access pattern** | No speculative indexes; each maps to ≥1 real query, named in the registry |
| **Search engines own search** | Algolia/Typesense handle text search, category browse and filtering. Firestore owns ownership and transactional queries only |
| **Add freely, remove carefully** | Adding is cheap (734 slots free). **Removing** requires runtime evidence — see below |
| **Measured capacity** | Thresholds are % of the verified 1000 limit, reported by a script |
| **Prefer collection-group indexes** | One collection-group index beats N per-tenant indexes, at the same cost |

---

## Capacity strategy

Thresholds are a percentage of the **real** 1000 limit. The old 190/195/198/200 warnings were derived from the false cap and are **retired**.

| Threshold | Level | Action |
|---:|---|---|
| 800 (80%) | **WARN** | Review growth; begin planning the operational-collection migration |
| 900 (90%) | **HIGH** | Execute the migration plan; audit orphans with runtime evidence |
| 950 (95%) | **CRITICAL** | `index-capacity-report.js` exits non-zero; block non-essential additions |

At 27% there is **no forecast pressure**. Re-assess at WARN.

---

## Governance policy — orphan indexes are rejected

Enforced by `scripts/verify-index-governance.js` (wired into `predeploy`; also `npm run verify:indexes`).

Every index in `firestore.indexes.json` needs an entry in `docs/index-registry.json`, keyed by `collection|field:order,...`:

```json
"asyncJobs|status:ASCENDING,lockedUntil:ASCENDING": {
  "purpose": "Recover jobs whose worker died holding the lock",
  "feature": "Async Jobs",
  "query": "asyncSweeper: where(status==RUNNING).where(lockedUntil<=now)",
  "owner": "Platform/Infra",
  "dateAdded": "2026-07-12",
  "expectedLifespan": "permanent"
}
```

Required: `purpose` · `feature` · `query` · `owner` · `dateAdded` · `expectedLifespan`.

**Grandfathering:** the 200 pre-existing indexes are marked `{ "legacy": true }` and exempt, so the gate is adoptable today without a wall of failures. **New indexes are not exempt.** Backfill legacy entries opportunistically — when you touch a feature, document its indexes.

The gate also flags **stale registry entries** (documented but no longer deployed).

---

## Evidence policy for REMOVAL

**Static analysis is not sufficient to remove an index.** A collection may be queried from Firestore Rules, tenant subcollections, admin tooling, or a Cloud Function that builds queries by string concatenation — none of which a code search reliably sees.

Before removing any index, collect **all four**:

1. **30-day query usage** — Cloud Monitoring `firestore.googleapis.com/document/read_count`, by collection.
2. **Runtime query tracing** — confirm no compound query resolves to it.
3. **Cloud Logging evidence** — zero `FAILED_PRECONDITION` through a canary window.
4. **Rules + subcollection review** — the index may serve a rules-side or tenant-scoped read.

### Current candidates — **all ON HOLD, none actioned**

| Candidate | Where | Decision |
|---|---|---|
| `operationsReports` | `sokoni-ops` | 🛑 **HOLD.** Removal was justified solely by the false 200/200 cap. `sokoni-ops` is at **2.8%** — removal frees nothing and carries non-zero risk. Needs a reason beyond capacity. |
| `reportSchedules` | `sokoni-ops` | 🛑 **HOLD.** As above. |
| `walletTxns` | `(default)` | 🛑 **HOLD.** Requires the 4-point evidence above. **Money path — highest caution.** |
| `inventory_grn` | `(default)` | 🛑 **DO NOT MODIFY.** Rules + docs + tenant subcollections mean static search is insufficient. |
| `inventory_stockcounts` | `(default)` | 🛑 **DO NOT MODIFY.** As above. |

---

## Rollback procedure (index removal)

An index is **pure derived data** — deleting one destroys no documents. But it **immediately breaks every query that needs it** (`FAILED_PRECONDITION`), and rebuilding is **not instant** (minutes to hours on a large collection). Treat removal as a production change with a real blast radius.

**Before removing:**
1. Record the exact spec (collection, ordered fields, directions, query scope) in `docs/index-registry.json` — **this is the rollback artifact**.
2. Snapshot: `node scripts/index-capacity-report.js --json > backup/indexes-YYYY-MM-DD.json`.

**To roll back:**
1. Re-create from the recorded spec (Admin API `indexes.create`, or restore the entry in `firestore.indexes.json` and deploy).
2. Wait for `state: READY` — **queries fail until the build completes.** This is the recovery window.
3. Confirm with `npm run report:index-capacity`; check Cloud Logging for `FAILED_PRECONDITION`.

**Rollout guidance:** remove in a low-traffic window; watch Cloud Logging for a full business cycle before removing the next one. **Never batch removals.**

---

## Migration plan — operational collections → `sokoni-ops`

> **Status: PLAN ONLY. Do not execute.**
> Capacity is at **27%**. There is **currently no reason to run this.** Retained as a v1.1+ contingency for when `(default)` crosses the 80% WARN threshold.

**Candidates** (operational only, no product surface):
`_sokoniTaskQueue` (5 indexes) · `_sokoniPerf` (1) · `_sokoniErrors` (1) · `webhookDeliveries` (2) — **9 indexes**, ~1% of the limit. The payoff is small, which is a further reason not to rush it.

**Requirements:** no downtime · no data loss · no API changes · backward compatible · reversible.

### Phases

**Phase 0 — Evidence.** Confirm each collection is written and read *only* by infrastructure code. Check Firestore Rules and tenant subcollections. Capture a 30-day read/write profile. **If any product path touches it, it is not a candidate.**

**Phase 1 — Dual-write.** Add a small data-access shim per collection so call sites never change (**no API changes**). Write to `(default)` **and** `sokoni-ops`; reads stay on `(default)`. Fully reversible — delete the shim.

**Phase 2 — Backfill.** Copy historical documents to `sokoni-ops`. Idempotent, resumable, keyed by document ID. Verify parity: document counts **and** a sampled field-level diff. **Nothing is deleted** — no data-loss exposure.

**Phase 3 — Read cutover.** Flip reads to `sokoni-ops` one collection at a time, behind a feature flag. Dual-write continues, so **rollback is flipping the flag** — no data movement. Soak each collection for a full business cycle.

**Phase 4 — Decommission.** Only after a clean soak: stop dual-writing. **Retain `(default)` data and indexes for ≥30 days** — this is the rollback window. Then drop the old indexes one at a time, per the rollback procedure.

### Verification (every phase)
- Document counts match across databases.
- Sampled field-level diff is clean.
- Zero `FAILED_PRECONDITION` in Cloud Logging.
- The owning scheduled jobs run green through a full cycle.
- `npm run report:index-capacity` reflects the expected change.

### Rollback by phase
| Phase | Rollback |
|---|---|
| 1 | Remove the dual-write shim. Nothing else changed. |
| 2 | Delete the backfilled copies. `(default)` untouched. |
| 3 | Flip the read flag back — dual-write means data is already current. |
| 4 | Re-create indexes from `docs/index-registry.json`; repoint reads. **The only phase with a real recovery window** — hence the 30-day retention. |

---

## Future scaling strategy

1. **Measure, don't assume.** Every capacity claim comes from the report script. The false cap in this very document is the cautionary tale.
2. **Prevent orphans at the door.** The governance gate is far cheaper than a cleanup — and it was a cleanup that produced the false-cap panic.
3. **Close the 212↔266 drift.** It is a live deploy hazard, not a bookkeeping nit.
4. **Split by workload, not by panic.** If `(default)` nears 80%, move *operational* collections out first — no product surface, lowest blast radius.
5. **Search stays in the search engine.** Firestore indexes are for ownership and transactional access, not for browse/filter.
