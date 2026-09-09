# Slice 1 — provenance for the three blocked modules

**From:** `9e5609e` · **Worktree:** `C:/temp/sok-slice1` · **Date:** 2026-09-09
**Read-only.** No implementation changed, nothing merged, nothing deployed.

Same methodology that resolved `merchant-inventory` and `delivery-pin`: deployed bundle →
module blob → `git hash-object` → exact match against every commit touching that path. No
nearest-commit, ancestry, export-count or "candidate looks safer" reasoning was used.

---

## Provenance table

| module | deployed generation(s) | deployed blob(s) | repository match | provenance | candidate differs? | safe to resolve? |
|---|---|---|---|---|---|---|
| **`delivery-authority`** | all four sampled (`bdc55173`, `ab2614e8`, `3514f795`, `3b87ebc6`) | **`ea9eda7d`** — one blob | **`3583202`** 2026-08-16 | 🟢 **PROVEN** | **yes** → `7e97e158` | 🔴 no — semantic review |
| **`index`** | `bdc55173`/`3514f795`/`3b87ebc6` · `ab2614e8` | `773f1993` · `2ba14e09` | **`d6655bd`** 2026-08-19 · **`919333e`** 2026-08-28 | 🟢 **PROVEN ×2** | **yes** → `96cfd3f5` | 🔴 no — two lineages |
| **`application-lifecycle`** | `bdc55173`+`3b87ebc6` · `ab2614e8` · `3514f795` | `a026e995` · `b1f10fa7` · `d78a47c5` | **`2ba509b`** 08-15 · **`c4013d1`** 09-06 · **`ed1c16b`** 08-24 | 🟢 **PROVEN ×3** | **yes** → `2f7ab118` | 🔴 no — three lineages |

**Every deployed blob was matched.** Nothing is UNPROVEN or UNRECOVERABLE here — a better
outcome than the payment-destination pair, which remains unrecoverable and untouched.

---

## `delivery-authority` — the clean one

**One blob across every generation sampled.** Whatever else diverges, production runs a single
version of this library: `ea9eda7d` → **`3583202`**.

That is the strongest provenance of the three, and it makes sense — it is a shared library
consumed by `dispatch.js` and `fulfilment-scan.js`, not a deployed function, so it moves only
when something rebuilds around it.

**Production-side authority: `3583202:functions/delivery-authority.js`.**

The candidate differs (`7e97e158`). Not resolved — reported for semantic review.

---

## `index` — two lineages, as expected

The aggregator tracks whatever generation each service was built in:

```
773f1993 -> d6655bd  2026-08-19   3 of 4 sampled generations
2ba14e09 -> 919333e  2026-08-28   generation ab2614e8
```

No single production-side authority exists. Resolving `index` means resolving **per export**,
against whichever lineage that export's service was built from — which is why it was always
correct to leave it last.

---

## ⚠️ `application-lifecycle` — three lineages, and one is a security fix

```
a026e995 -> 2ba509b  2026-08-15  feat(roles): Phase 2 canonical role provisioning
d78a47c5 -> ed1c16b  2026-08-24  approval now provisions the role
b1f10fa7 -> c4013d1  2026-09-06  fix(security): an application could approve itself
```

`c4013d1` fixes a **live privilege escalation** — *"the guard was lost in reconciliation… had
been reporting a LIVE privilege escalation in production, red for weeks among forty other
failures."*

**Which export runs which version:**

| export | generation | source | has the fix? |
|---|---|---|---|
| `applicationLifecycle` | `ab2614e8` | `c4013d1` | 🟢 **yes** |
| `applicationDecide` | `3514f795` | `ed1c16b` | 🔴 no |
| `applicationReconcile` | `3514f795` | `ed1c16b` | 🔴 no |
| `applicationList` | `bdc55173` | `2ba509b` | 🔴 no |

**The good news:** `applicationLifecycle` — the trigger the vulnerability was actually in — is
running the **fixed** build. The fix reached the function that needed it.

**The open question, flagged not answered:** all three blobs contain `applyDecision` (6
occurrences each), but self-approval guard markers count **16 in `c4013d1` against 5 in both
older blobs**. `applicationDecide` and `applicationReconcile` run a build without the
strengthened guard. Whether either reaches the same decision path is a **security question
requiring semantic review**, and this slice is provenance only — it is recorded, not resolved,
and emphatically not fixed by copying candidate code.

---

## Answers

**Which have PROVEN lineage?** All three. Every deployed blob matched a commit exactly.

**Which remain blocked?** All three — for *resolution*, not for evidence:

* `delivery-authority` — single proven authority, but the candidate changes it → semantic review
* `index` — two lineages; no single production side exists
* `application-lifecycle` — three lineages, one carrying a security fix the others lack

**Exact production-side authority where one exists:**

```
delivery-authority   3583202:functions/delivery-authority.js   blob ea9eda7d
index                NONE — d6655bd (blob 773f1993) or 919333e (blob 2ba14e09) per export
application-lifecycle NONE — 2ba509b / ed1c16b / c4013d1 per export
```

**Does the candidate contain changes?** **Yes, to all three** — `2f7ab118`, `7e97e158`,
`96cfd3f5`, none matching any deployed blob. **STOPPED as instructed. Nothing resolved.**

---

## Next required gate

Semantic review of the three candidate deltas, taken separately, and in this order:

1. **`delivery-authority`** — one proven production authority makes this a genuine two-way
   comparison; the tractable one.
2. **`application-lifecycle`** — needs the security question answered first: does the missing
   guard matter for `applicationDecide` / `applicationReconcile`? That is a security finding in
   its own right, independent of the merge.
3. **`index`** — last, per export, after the modules it aggregates are settled.

The candidate improving security or tests is **not** a reason to merge any of them. Those are
semantic decisions that follow provenance; they do not substitute for it.
