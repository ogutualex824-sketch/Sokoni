# ESCALATION — `functions/order-claim.js` has no provenance

**Status: OPEN · owner UNKNOWN · blocks every functions deploy from this branch**
Raised 2026-09-05 · Disposition **C — escalated, unresolved** (unchanged since the 2026-09-04 census)
**Related:** [[UNTRACKED_FUNCTIONS_PROVENANCE_CENSUS]] · [[SUPPLY_A_TO_M_RELEASE_RECORD]] ·
[[ORDER_CLAIM_PROVENANCE_TRACE]]

---

## What is being asked

**Someone who owns this feature must decide one of two things.** No engineering work should
proceed on it until they have.

```
EITHER   obtain the authoritative owner/spec  →  certify  →  commit
OR       the feature is obsolete: remove its require/export  →  certify the index graph  →  commit the removal
```

Both paths end in a commit that makes `functions/index.js` load from a clean checkout. Neither
path may be substituted by any of the following, which are explicitly forbidden:

* **Do not commit a guessed implementation.** There is no spec to guess against.
* **Do not preserve the require merely because the file exists in another worktree or on
  someone's disk.** A module existing somewhere on disk is not deployable provenance.
* **Do not suppress, weaken, or bypass the closure gate to make a deploy possible.**

This decision belongs to the owner of the order-claim feature. It is **not** the Supply
workstream's to make, and the Supply workstream has not made it.

---

## Why it is unowned

`order-claim.js` is the only module in the entire untracked census with nothing behind it:

| evidence sought | result |
|---|---|
| git history on any branch, ever (`git log --all`) | **none** |
| row in `docs/MULTISHOP_STACK_PROVENANCE_MANIFEST.md` | **none** — out of that manifest's stated scope |
| contract, spec, ADR or trace document anywhere in `docs/` | **none** |
| callers | exactly one: `functions/index.js`, unconditional, module-scope |
| what `claimOrder` / `releaseOrderClaim` are supposed to do | knowable only by reading the file's own source |

Compare the other three blockers, each of which **does** have an owner and a documented reason
for being where it is:

| module | why it is blocked | who decides |
|---|---|---|
| `manual-till-orders` | **B — gated.** `manual_payment` must stay OFF until its contract and certification are complete (`docs/MANUAL_TILL_ORDER_CONTRACT.md`) | its feature owner |
| `commission-invoice` | **A — canonical, gated.** Spec exists and it was certified 52/0, but `revenueConfig/commission_vat` is unset and two business decisions are open (`docs/COMMISSION_INVOICE_SPEC.md`) | founder / finance |
| `pos-mpesa-refs` | **B — proven foreign port.** Committed at `233ac4d`, certified 57/0, on other lineages; this branch does not carry it | whoever owns that port's integration |

`order-claim` has none of that. It is the only *truly unowned* blocker in the set.

---

## How it got into the committed tree

`fa5082b` ("Rail-B multi-shop checkout") committed `functions/index.js` **as a whole file**. The
`require('./order-claim')` line was already sitting in the working tree, uncommitted, before
that commit — it was captured as a side effect of committing the file, not added deliberately.

The author knew. `fa5082b`'s own commit message names all four hazard files by exact filename:

> **DEPLOY CONSTRAINT: NAMED-FUNCTION deploy ONLY** — `createPaymentIntent`,
> `createMultiShopCheckoutQuote`, `getShopCheckoutMode` — coupled with hosting. **NEVER deploy
> FULL index.js: it would smuggle unrelated untracked callables (manual-till-orders,
> order-claim, commission-invoice, pos-mpesa-refs) live.**

The mitigation was a **sentence in a commit message**. As of 2026-09-05 it is also a mechanism:
`scripts/gate-functions-require-closure.js` runs first in `firebase.json`'s
`functions.predeploy` chain and fails the deploy. **The gate being red today is the correct
result, not a defect to route around.**

---

## Did it ever reach production?

**Almost certainly not, and two independent checks agree.**

* `firebase functions:list` (~380 live functions) has **zero** entries for `claimOrder` or
  `releaseOrderClaim`, while known-live functions sharing the same file (`webhookIntasend`,
  `onOrderStatusChange`, `notifySend`) **are** present — so the query method itself works.
* `docs/MULTISHOP_STACK_PROVENANCE_MANIFEST.md` §3 (2026-08-30) reached the same conclusion five
  days earlier by reading the immutable GCS source archives for the deployed functions.

This is consistent with the named-function deploy discipline actually having been followed. It
is **not** evidence that the code is safe, correct, or wanted — only that it does not appear to
be running.

---

## What the owner needs to answer

1. **Does the feature still exist as a product intention?** "Atomic order claim (multi-employee
   POS distribution)" is the only description of it anywhere, and it is an inline comment in
   `index.js`.
2. **If yes** — who holds the authoritative source, and where is its spec? The file on this disk
   is one candidate, not a certified one, and must not be committed on the strength of being the
   only copy anyone can find.
3. **If no** — may the `require` and its exports be removed from `index.js`? That is a one-commit
   change plus a closure re-certification, and it would take the blocker count from 4 to 3.

---

## Verifying the current state

```
node scripts/gate-functions-require-closure.js
```

Exit 1 today, naming `order-claim` with `committed on any ref: NEVER — no provenance anywhere`.
When this escalation is resolved either way, that line disappears from the gate's output — which
is the acceptance test for this document.

**No deployment may be attempted while this is open.** Production remains `d592d8f` / v632.
