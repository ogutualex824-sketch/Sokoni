# AR KEEP — the discriminating experiment, designed not executed

**Date:** 2026-09-26 · **Read-only. No Artifact Registry mutation performed.**
**Status:** experiment DESIGNED; execution requires authorization that overrides a standing
prohibition. See §6.

---

## 1 · Current state, re-measured (memory was stale)

| | recorded in memory | measured today |
|---|---|---|
| packages, us-central1 | 22 | **1,775** |
| packages, us-east1 | — | 4 |
| versions total, us-central1 | 22 | **24** |
| versions per package | 1 | **1** |

The **1 version per package** figure — the one the whole argument rests on — still holds. The
24 versions are **12 rebuilt functions × 2 packages each** (the function image plus its
`<function>/cache` companion).

Rebuilt functions: `pos_complete_checkout`, `complete_p_o_s_q_r_payment`, `connect_dispatch`,
`resolve_merchant_context`, `process_typesense_queue`, `profile_get_public_profile`,
`list_suppliers`, `list_purchase_orders`, `get_purchase_order`, `get_inbound_supply_orders`,
`set_supply_participation`, `update_supplier`.

> **A false start worth recording.** Collapsing package paths with `sed 's|.*/||'` merged twelve
> distinct `<function>/cache` packages into a single name reading "12 versions" — which looked
> exactly like the discriminating condition this experiment needs. It was an artifact of the
> measurement, not a property of the registry. Reading the raw rows disproved it.
> **A count is not a finding until you have seen the rows it came from.**

## 2 · Policies — confirmed present and enforcing, both repositories

| policy | action | condition |
|---|---|---|
| `firebase-functions-cleanup` | **DELETE** | `olderThan: 86400s`, `tagState: ANY` |
| `sokoni-recovery-protection` | **KEEP** | `mostRecentVersions.keepCount: 10` |

`cleanupPolicyDryRun` unset on both → **ENFORCING**.

## 3 · What has changed since 2026-09-22 — one explanation is now dead

The 09-22 conclusion was that survival proved nothing because nothing was **age-eligible**.
That is no longer true.

| | |
|---|---|
| newest image | 2026-09-22T23:28:39Z |
| now | 2026-09-26T04:25Z |
| age of the **newest** version | **77 hours** |
| DELETE threshold | 24 hours |

**Every one of the 24 versions is now age-eligible for deletion, and every one still exists.**
"Nothing was eligible" can no longer explain their survival.

## 4 · But it still does not discriminate

Two hypotheses remain, and the evidence cannot separate them:

| hypothesis | consistent with what we see? |
|---|---|
| **H1** — KEEP is protecting them | yes |
| **H2** — the sweep is not running at all | yes |

Audit logs, 7-day window, instrument verified by positive control first (a
`gcloud logging` call that failed on the Python path would have returned an empty result that
looked like "no deletions"):

| method | count |
|---|---|
| `GetRepository` | 172 |
| `ListPackages` | 121 |
| `ListVersions` | 12 |
| `Docker-*` (upload/manifest) | 41 |
| **`BatchDeleteVersions`** | **0** |

The only deletions are five `Docker-DeleteManifest` calls on 2026-09-22 by
`24799054989-compute@developer.gserviceaccount.com` — the **compute** service account doing
build-time manifest overwrites during that day's function deploys. **Not** the Artifact
Registry service agent, and **not** a policy sweep.

So deletion machinery demonstrably works for builds, while **no policy sweep deletion has been
observed at all**. H2 stays alive.

### Why the estate cannot resolve this on its own

With `keepCount: 10` applied **per package**, a package holding 1 version always has that
version inside its own top-10. **No version in this registry can ever be simultaneously
age-eligible and outside the KEEP set.** The configuration structurally cannot produce the
observation that would separate H1 from H2.

That is the same conclusion as 09-22, reached from the opposite direction: then nothing was
eligible; now everything is eligible and nothing is unprotected.

## 5 · The experiment that would discriminate

**Control variable: VERSION COUNT per package, not elapsed time.**

```
one package, ≥ 11 versions, all older than 24h
        │
        ├── versions 1..10  (most recent)  → KEEP-protected AND age-eligible
        └── versions 11+    (oldest)       → age-eligible, NOT KEEP-protected
                                              ── the discriminating set ──
```

| observation after a sweep | conclusion |
|---|---|
| 11+ deleted, 1–10 retained | **KEEP PROVEN** — the policy is what retains them |
| nothing deleted | **sweep is not running** (H2) — KEEP still unproven |
| everything deleted | **KEEP is NOT enforcing** — a live risk to every rebuilt image |

Each outcome is distinguishable, which is exactly what the previous run lacked.

**Required conditions**

1. One package with **≥ 11 versions**.
2. All candidate versions **> 24h old** (so the DELETE condition is satisfiable).
3. A sweep must actually run in the window — and because a no-op sweep logs nothing, the
   experiment needs the deletion of versions 11+ as its own proof that a sweep occurred.
4. The package must be **inert** — owned by no function, referenced by no Cloud Run revision.
   Using a live function's package risks deleting an image a revision depends on, which is the
   original incident.

**Measurement**, read-only: `gcloud artifacts versions list --package=<p>` before and after,
plus an audit-log query for `BatchDeleteVersions` scoped to that package.

## 6 · Why this is NOT executed here

Creating ≥ 11 versions in one package is an **Artifact Registry mutation**. Both routes are
blocked by standing prohibitions:

| route | blocked by |
|---|---|
| push 11 inert artifacts | *"never push, delete or tidy anything in Artifact Registry"* |
| rebuild a function 11 times | rebuilds are individually gated; *"canary #2 is NOT AUTHORIZED"* |

The previous canary was consumed at 28.1h by the very mechanism it was built to detect, and a
second was explicitly refused. **Nothing in the rules-reconciliation lane authorizes this**, and
a direction to *design* the experiment is not authorization to *run* it.

### What authorization would need to say

1. That ≥ 11 versions may be pushed to a **named inert package** in `gcf-artifacts`.
2. Which repository — `us-central1` or `us-east1`.
3. That the package is owned by no function and referenced by no Cloud Run revision.
4. That those versions may be **deleted by the policy** — that is the result, not an accident.
5. Who confirms the estate is quiescent for the window (no deploys, which would add versions
   and confound the count).

**Risk if KEEP does not hold:** the 12 rebuilt function images are age-eligible today. If the
experiment shows KEEP is not enforcing, those images are at risk, and each affected function
cannot create a new revision until rebuilt. That is the outcome the experiment exists to detect
— and a reason to run it deliberately rather than discover it during an incident.

## 7 · Corrections to the standing record

| record | correction |
|---|---|
| "22 packages × 1 version" | **1,775 packages**, 24 versions, still 1 per package |
| "nothing is eligible, so a sweep deletes nothing" | **no longer true** — all 24 are now age-eligible |
| "the sweep-log detector CAN NEVER FIRE" | still true **for this configuration**; §5 is the configuration in which it can |

## 8 · Not done

- No artifact pushed, deleted or tagged. No function rebuilt. No policy changed.
- Whether a sweep runs at all is **UNPROVEN** — no `BatchDeleteVersions` has ever been observed.
- `us-east1` (4 packages) was not enumerated per-package.
- KEEP remains **CONFIGURED, NOT PROVEN** — unchanged since 2026-09-21.
