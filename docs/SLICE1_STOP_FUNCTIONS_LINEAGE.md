# Slice 1 — STOP: the production functions lineage is not `d592d8f`

**Worktree:** `C:/temp/sok-slice1` · **Branch:** `rc/lineage-slice1` · **Base:** `d592d8f`
**Date:** 2026-09-09 · **Status:** HALTED before any conflict was resolved. Nothing merged, nothing changed.

---

## Why this stopped

Three of the slice's own stop conditions fired together:

* production lineage cannot be established
* an export would disappear unexpectedly
* production behaviour cannot be reconstructed from either side

**The deployed function set matches neither lineage in the merge.** Resolving the seven authority
modules against `d592d8f` as "production authority" would have deleted seven live functions,
four of them financial.

---

## The evidence

`functions/index.js`, exports compared by name. Merge base `3dcf572`.

```
production  d592d8f   1514 exports
candidate   c6a1e68   1532 exports
production-only          20
candidate-only           38
```

Then each name was checked against **what is actually running** — 1002 Cloud Run services,
1000 of them in `us-central1`:

| | |
|---|---|
| candidate-only exports **already deployed** | **7 of 38** |
| production-only exports **not deployed** | **2 of 20** |

### The 7 candidate-only exports that are already live

```
getCommissionBalance          savePaymentDestination
getPaymentDestination         sweepCommissionDue
getSellerRestriction          posInitiateTerminalPaymentV1
posCancelTerminalPaymentV1
```

These exist **only in `c6a1e68`**. They are absent from `d592d8f` — and they are running in
production right now. Four touch money directly: the payment-destination pair decides where a
payment goes, the two `posTerminalPayment` callables run POS terminal payments, and
`sweepCommissionDue` is the commission sweep whose post-recovery 2xx at `07:15:14Z` was used
hours ago as evidence that wallet/ledger had recovered.

**A merge treating `d592d8f` as the production side would delete all seven.**

### The 2 production-only exports that were never deployed

```
posCommissionDailyCollection      posCommissionReconcile
```

Confirmed absent across **all** regions, not merely `us-central1`. They exist in `d592d8f`
source and have never run. Preserving them "because production has them" would be preserving
something production does not actually have.

---

## What this means

```
d592d8f      hosting lineage. version.json says so, and Hosting serves it.
             NOT the functions lineage — 7 deployed functions are missing from it.

c6a1e68      candidate. Contains those 7, but is missing 18 deployed production functions.

deployed     a THIRD thing, matching neither side.
```

This is the known **functions provenance divergence**, now measured rather than suspected.
`version.json` is a *hosting* build stamp; it says nothing about which commit the functions were
deployed from, and the two have drifted apart.

**Consequence for Slice 1:** the merge as specified — `d592d8f` × `c6a1e68`, production side
authoritative — encodes a false premise. Neither side is production. Any per-hunk decision of
the form "keep production" would be resolved against a tree that is not what runs.

---

## Explicitly NOT concluded

* **Not** that the candidate should win. It is missing 18 deployed functions.
* **Not** that the deployed set is correct. It contains work never reconciled into either branch,
  which is its own governance problem.
* **Not** that anything should be deployed, reverted, or redeployed to close the gap.

---

## What has to happen before the seven modules can be resolved

**Establish the actual functions deployment lineage.** Until the commit (or set of commits) the
1002 services were built from is known, "preserve production behaviour" has no referent, and the
seven authority modules cannot be resolved semantically — only guessed at.

Candidate approaches, all read-only:

1. Cloud Run revision labels / build provenance on a representative sample of services.
2. Deployment history — which branch each `firebase deploy --only functions` ran from.
3. Reconstruct by export set: find the commit whose `functions/index.js` export list matches the
   1002 deployed names.

Approach 3 is self-checking: the right commit reproduces the deployed set exactly, and a wrong
one is visibly wrong. It needs no external records.

---

## State

| | |
|---|---|
| conflicts resolved | **0** |
| files modified | **0** |
| merge performed | **no** |
| tests changed | **no** |
| deployed | **no** |
| production pointer changed | **no** |
| production data mutated | **no** |
| shared tree touched | **no** (235 uncommitted entries, untouched) |
| worktree | clean |

`firebase.json` remains determinately resolvable (six hooks, both guards) and `firestore.rules`
still merges clean — neither depends on the functions lineage question. The blocker is confined
to the seven `functions/` authority modules, which is precisely where guessing is least
acceptable.
