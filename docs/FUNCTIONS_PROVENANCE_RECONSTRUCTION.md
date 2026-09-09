# Functions production lineage — provenance reconstruction

**Worktree:** `C:/temp/sok-slice1` · **Date:** 2026-09-09 · **Read-only.** Nothing deployed, invoked, restarted or mutated.

---

## Verdict

**There is no single production Functions commit.** Production is **54 independently deployed
generations** across 1002 Cloud Run services, and `d592d8f` is **not one of them**.

Two generations are **PROVEN** by an immutable chain. One is **unrecoverable** — its deployed
source does not exist in the repository at all.

---

## Method — evidence, not inference

Cloud Run exposes the deployed source bundle directly:

```
service
  → metadata.annotations["run.googleapis.com/build-source-location"]
  → gs://gcf-v2-sources-.../<Fn>/function-source.zip#<generation>
  → index.js
  → git hash-object
  → search all 387 commits touching functions/index.js for that exact blob
```

That is identity, not resemblance. Export counts and dates were used only to pick which
generations to trace — never to conclude a match. `metadata.labels["firebase-functions-hash"]`
groups services deployed together, so one trace settles a whole generation.

---

## Provenance table

| generation | services | source commit | date | confidence |
|---|---|---|---|---|
| `bdc55173…` | **820** | **`d6655bd`** *subscription release preflight* | 2026-08-19 | 🟢 **PROVEN** |
| `f0da65f2…` | 5 | **`7d115bc`** *seller 5% 48-hour receivable* | 2026-08-29 | 🟢 **PROVEN** |
| `f51ce5e8…` | 2 | **NONE — not in the repository** | — | 🔴 **UNRECOVERABLE** |
| 51 further generations | 175 | not traced | — | ⚪ **UNPROVEN** |

`d592d8f` — the Hosting build stamp — appears **nowhere**. Its `functions/index.js` is 13,067
lines; the deployed bulk is 12,791. It is a hosting lineage, and using it as the Functions
baseline is what would have deleted seven live functions.

---

## 🔴 The unrecoverable one

```
getPaymentDestination      deployed source index.js  12,947 lines
savePaymentDestination     blob 2bc29012078afbf38081d48ab30a0ca1c2e26c0c
```

**That blob is absent from the repository entirely** — not a commit, not a dangling object.
These two functions were deployed from an **uncommitted working tree**, and the exact source
now serving production cannot be reconstructed from git.

They are the payment-destination authority: **they decide where a payment goes.**

This is the "unreproducible dirty build" recorded in the release notes, now located precisely
rather than described in general. It is a governance finding in its own right, independent of
Slice 1.

---

## The seven critical live functions

| function | generation | source | confidence |
|---|---|---|---|
| `getPaymentDestination` | `f51ce5e8` | **none — uncommitted** | 🔴 UNRECOVERABLE |
| `savePaymentDestination` | `f51ce5e8` | **none — uncommitted** | 🔴 UNRECOVERABLE |
| `posInitiateTerminalPaymentV1` | `bdc55173` | `d6655bd` | 🟢 PROVEN |
| `posCancelTerminalPaymentV1` | `bdc55173` | `d6655bd` | 🟢 PROVEN |
| `sweepCommissionDue` | `f0da65f2` | `7d115bc` | 🟢 PROVEN |
| `getCommissionBalance` | `f0da65f2` | `7d115bc` | 🟢 PROVEN |
| `getSellerRestriction` | `f0da65f2` | `7d115bc` | 🟢 PROVEN |

All seven remain live and untouched. `sweepCommissionDue` — observed returning 200 at
`2026-09-09T07:15:14.860854Z` during recovery verification — traces to `7d115bc`, a commit on
`fix/seller-commission-48h-obligation`. **It is not disposable candidate code**, and a merge
based on `d592d8f` would have removed it.

## The two source-only functions

| function | classification |
|---|---|
| `posCommissionDailyCollection` | **never deployed** — present in `d592d8f` source, absent from every region |
| `posCommissionReconcile` | **never deployed** — same |

Neither deleted, neither deployed. Preserving them *because production has them* would preserve
something production does not have.

---

## Correct Slice 1 base

**Model C — multiple independently deployed component lineages.** Not A, and the evidence
refuses to be forced into A.

* 820 / 1002 services (**82%**) → `d6655bd`. The closest thing to a single production Functions
  baseline, and the only defensible *approximation*.
* 182 services come from 53 other generations, 175 of them untraced.
* 2 services come from source that no longer exists.

So "preserve production behaviour" has **no single referent**. For the majority it means
`d6655bd`; for `sweepCommissionDue` it means `7d115bc`; for the payment-destination pair it
means *a source that cannot be recovered*.

---

## SLICE 1 MERGE: 🔴 STILL BLOCKED

Resolving the seven authority modules requires knowing which tree encodes production behaviour
for each hunk. For most it would be `d6655bd` rather than `d592d8f` — a different base than the
one authorised — and for the payment-destination path no base exists.

**Recommended, in order:**

1. **Re-run the merge against `d6655bd`.** It is PROVEN and covers 82% of production. The 44-path
   inventory was computed against `d592d8f` and must be recomputed.
2. **Treat the payment-destination pair as its own recovery task.** Decompile-by-diff from the
   deployed zip, or accept the deployed artifact as the reference and reconstruct source to
   match. Either way it is not a merge decision.
3. **Trace the remaining 51 generations** only as far as the seven modules require.

## State

```
conflicts resolved        0        production deployed        NO
files modified            0        production mutated         NO
functions source changed  NO       functions invoked          NO
wallet/fraud/payment      NO       shared tree touched        NO
firestore.rules           NO       worktree                   clean
firebase.json             NO
```
