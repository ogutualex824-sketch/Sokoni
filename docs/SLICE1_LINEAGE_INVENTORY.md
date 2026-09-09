# Slice 1 — lineage reconciliation: conflict inventory

**Worktree:** `C:/temp/sok-slice1` · **Branch:** `rc/lineage-slice1` · **Base:** `d592d8f` (production lineage)
**Merge subject:** `git merge-tree --write-tree d592d8f c6a1e68` · **Date:** 2026-09-09
**Status:** INVENTORY ONLY — no conflict resolved, no merge performed, nothing deployed.

---

## Two findings that change the shape of this slice

### 1 · "Slice 1" names two different pieces of work, and one is already done

The authorisation described rules content (`firestore.rules.candidate-b`, `isSeller()`,
`rolesUnchanged()`, `activeRoleApproved()`, `noSelfGrant()`, `landlordProfiles`/`tenantProfiles`,
the conversations tightening, `posPrintJobs`, `merchantStories`) while citing ROADMAP §7 Slice 1
and its 173-path figure. **Those are different jobs.**

| | A · rules production-lineage reconciliation | B · ROADMAP §7 Slice 1 |
|---|---|---|
| where | `C:/temp/sok-rules-recon`, `rules/production-lineage-reconciliation` | this worktree |
| subject | `firestore.rules` | tree merge `d592d8f` × `c6a1e68` |
| status | ✅ **COMPLETE** — `09dc015`, compiled `dd98409` | ⬜ inventory only |
| result | 671→701 paths, **0 LOST**, 2 changed, 30 added | 44 conflicted paths |

**A is done.** Every protection the authorisation asked to preserve is already preserved and
evidenced there, and the two items `09dc015` flagged as *requiring an explicit decision* —
`posPrintJobs` additive shop-owner read, `merchantStories` authenticated read — are precisely
the two the authorisation approves. Nothing in A needs redoing.

**A's protections are not at risk in B either.** The recorded merge analysis states
`firestore.rules` merges **clean**, and the recomputed inventory confirms it: `firestore.rules`
appears **0** times in the conflict list. B cannot lose a rule it never touches.

### 2 · The conflict surface is 44 paths, not 173

`173` was measured against `de79337`. HEAD has since moved to `c6a1e68`:

```
recorded (de79337)   173 conflicted paths
recomputed (c6a1e68)  44 conflicted paths
```

A **75% reduction**. The four named highest-risk paths all still conflict, so the hard part
remains — but this is no longer the multi-day integration the roadmap describes.

---

## The inventory — 44 paths

| group | n | conflict type | first-pass classification |
|---|---|---|---|
| `functions/` — deploy surface + live authority modules | 7 | semantic, both lineages changed | **MERGE_REQUIRES_REVIEW** |
| config / governance | 2 | semantic | see below |
| `scripts/` — test suites | 7 | semantic | **MERGE_REQUIRES_REVIEW** — a test must never be weakened to merge |
| `docs/` — evidence | 5 | textual | **MERGE_SAFE** (record both lineages' evidence) |
| root app files — HTML/CSS/JS | 23 | textual + semantic | **MERGE_REQUIRES_REVIEW** |

`functions/`: `application-lifecycle.js` · `business-bootstrap.js` · `delivery-authority.js` ·
`delivery-pin.js` · `index.js` · `merchant-inventory.js` · `procurement.js`

### `firebase.json` — RESOLVED DETERMINISTICALLY · **MERGE_SAFE**

The one the record singles out as *"both must survive"*. Read rather than assumed:

```
production   1. guard-functions-safety.js            protects deployed RUNTIME PROPERTIES
candidate    1. gate-functions-require-closure.js    protects GIT-TREE DEPENDENCY CLOSURE
both         2. predeploy-syntax-gate.js
both         3. verify-commission-single-source.js
both         4. verify-delivery-engine-sync.js
both         5. predeploy-payout-gate.js
```

**The two sides differ only in slot 1. Hooks 2–5 are identical on both.** So "both must
survive" has a determinate answer needing no design decision: **six hooks, both guards
retained**. They answer different questions and neither replaces the other — which is exactly
why dropping either would be a silent regression rather than a merge preference.

Resolution: `guard-functions-safety.js`, `gate-functions-require-closure.js`, then hooks 2–5.

### `firestore.indexes.json` — **MERGE_REQUIRES_REVIEW**

Index governance diverged on both sides. Indexes are additive in effect but a *missing* index
is a production latency failure, so the resolution must be a union verified against both
lineages' query surfaces — not a pick.

---

## Classification rules applied

`KEEP_PRODUCTION` · `KEEP_CANDIDATE` · `MERGE_SAFE` · `MERGE_REQUIRES_REVIEW` ·
`DELETE_ONLY_WITH_EVIDENCE` · `BLOCKED — SLICE 2 DECISION REQUIRED`

No path may leave the inventory without an explicit classification. No `-X ours` / `-X theirs`.
Nothing mechanical. Where a resolution depends on the unanswered guard-semantics question,
it is marked **BLOCKED**, never guessed — that question belongs to Slice 2.

---

## What has NOT been done

No conflict resolved · no merge performed · no file in either lineage modified · no test changed ·
no deployment · no rules released · no production pointer moved.

The shared tree (`C:/Users/USER1/OneDrive/Desktop/SOKONI`, **235** uncommitted entries belonging
to other workstreams — up from the 192 recorded) was **not touched**. All analysis used
`git merge-tree`, which writes objects but never the working tree.

---

## Recommended next step

Resolve the 44 in risk order: `firebase.json` (settled above) → `firestore.indexes.json` →
the 7 `functions/` modules → the 7 `scripts/` suites → 23 app files → 5 docs.

The `functions/` modules are the real work: both lineages changed live authority code, so each
needs a semantic read rather than a merge. That is the part worth authorising deliberately, now
that it is known to be 7 files rather than an unbounded 173.
