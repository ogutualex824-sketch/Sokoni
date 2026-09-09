# Slice 1 — governance state after provenance reconstruction

**Worktree:** `C:/temp/sok-slice1` · **Date:** 2026-09-09 · Read-only. Nothing deployed, invoked or mutated.
**Supersedes** the `d592d8f`-based inventory in `03c5c6f`.

---

## A · Inventory recomputed against `d6655bd`

`git merge-tree --write-tree d6655bd c6a1e68`, merge base `3dcf572`:

```
vs d592d8f (superseded)   44 conflicted paths
vs d6655bd (proven)       26 conflicted paths
```

**Two of the seven authority modules stop conflicting entirely** — their conflicts were
artifacts of the wrong baseline:

| module | vs `d592d8f` | vs `d6655bd` |
|---|---|---|
| `business-bootstrap` | conflict | **clean** |
| `procurement` | conflict | **clean** |
| `application-lifecycle` · `delivery-authority` · `delivery-pin` · `index` · `merchant-inventory` | conflict | conflict |

### `d6655bd` is NOT a production baseline either — and the numbers say so

| | exports | of which deployed |
|---|---|---|
| `d6655bd` | 1502 | **934** |
| `d592d8f` | 1514 | **944** |

`d592d8f` covers *more* deployed names by count. Neither dominates. Of the seven critical live
functions, `d6655bd` contains only `posInitiateTerminalPaymentV1` and
`posCancelTerminalPaymentV1`; the other five are absent from it too.

**`d6655bd` is the largest identity-proven component lineage — not "the production commit".**
The 82% figure is a coverage statistic, never a baseline claim.

---

## B · Seven-module provenance

Method: module → the exports `index.js` re-exports from it → deployed service → generation →
traced to a commit **by blob identity**.

**A refinement that matters:** generations `3514f795` and `3b87ebc6` both trace to `d6655bd`.
The `firebase-functions-hash` label therefore varies with config, not only source — so **54
generations are far fewer than 54 distinct sources**, and several modules collapse to one
lineage once traced.

| module | live exports | distinct sources | provenance | status |
|---|---|---|---|---|
| `procurement` | 11 | **1** — `d6655bd` | 🟢 PROVEN | 🟢 **SAFE** — also merges clean |
| `business-bootstrap` | 5 | **1** — `d6655bd` | 🟢 PROVEN | 🟢 **SAFE** — also merges clean |
| `merchant-inventory` | 1 | **1** — `d6655bd` | 🟢 PROVEN | 🟡 **RESOLVABLE** against `d6655bd` |
| `delivery-pin` | 3 | **1** — `d6655bd` (gens `3b87ebc6`+`bdc55173`) | 🟢 PROVEN | 🟡 **RESOLVABLE** against `d6655bd` |
| `application-lifecycle` | 4 | **2** — `d6655bd` **and** `919333e` | 🟢 PROVEN, but split | 🔴 **BLOCKED** — no single production version |
| `delivery-authority` | 0 (library) | via `dispatch.js`, `fulfilment-scan.js` | ⚪ UNPROVEN | 🔴 **BLOCKED** — consumers not traced |
| `index` | aggregator | spans every generation | ⚪ UNPROVEN | 🔴 **BLOCKED** — by construction |

`application-lifecycle` is the instructive one: its four live exports were deployed from **two
different commits** — `applicationlifecycle` from `919333e` (2026-08-28, *sandbox callback
lane*), the others from `d6655bd`. There is no single "production version" of that file to
preserve, so any per-hunk *keep production* decision would be ambiguous.

`delivery-authority` is a **shared library**, not a deployed function — one `module.exports`,
consumed by `functions/dispatch.js` and `functions/fulfilment-scan.js`. Its production version
is whatever those consumers were built from, which is not yet traced.

---

## C · Payment destination — isolated governance finding

```
getPaymentDestination      generation f51ce5e8   2 services
savePaymentDestination     index.js 12,947 lines
                           blob 2bc29012078afbf38081d48ab30a0ca1c2e26c0c
```

**🔴 UNRECOVERABLE.** Re-confirmed by direct trace: the blob is absent from the repository —
not a commit, not a dangling object. Deployed from an uncommitted working tree.

These decide **where a payment goes**. They were **not** reconstructed from `d6655bd`, the
candidate, neighbouring commits, or similarly named implementations — doing so would invent a
payment-routing implementation and present it as the running one.

**Minimum evidence before this pair can be reconciled:**

1. The deployed artifact is itself recoverable — `gs://gcf-v2-sources-…/getPaymentDestination/function-source.zip#1787679346641132` and the Artifact Registry image are immutable and readable. **The running implementation can be preserved as an artifact even though its git source cannot.**
2. Recovery therefore means: extract the deployed `index.js`, diff the two functions' implementations against the nearest candidate, and have a human ratify that the difference is intended — reconstructing *source to match the artifact*, never the reverse.
3. Until ratified, neither function may be changed, redeployed or merged.

Nothing about them was altered.

---

## D · Where Slice 1 stands

| | modules |
|---|---|
| 🟢 safe to proceed (proven single lineage **and** merge clean) | `procurement`, `business-bootstrap` |
| 🟡 resolvable against `d6655bd` (proven single lineage, conflicts remain) | `merchant-inventory`, `delivery-pin` |
| 🔴 blocked | `application-lifecycle` (2 lineages), `delivery-authority` (consumers untraced), `index` (aggregator) |

**Recommendation — do not merge as one operation.** Slice 1 was specified as a single
reconciliation against a single production baseline. That premise is now disproven, and the
evidence supports a different shape:

* resolve `merchant-inventory` and `delivery-pin` against `d6655bd`, where *keep production* has one unambiguous meaning;
* leave `procurement` and `business-bootstrap` alone — they merge clean;
* treat `application-lifecycle` as a per-export reconciliation across `d6655bd` and `919333e`;
* trace `dispatch.js` / `fulfilment-scan.js` before touching `delivery-authority`;
* resolve `index` **last**, since it aggregates everything above;
* handle the payment-destination pair as artifact recovery, outside the merge entirely.

**SLICE 1 MERGE: 🔴 STILL BLOCKED** — but the blocked surface is now 3 modules, not 7.

```
seven modules resolved            0
seven modules blocked             3   (application-lifecycle, delivery-authority, index)
seven modules unblocked           4   (2 clean, 2 resolvable against a proven lineage)
payment-destination pair          UNRECOVERABLE — isolated, untouched
production deployment             NO
production mutation               NO
```
