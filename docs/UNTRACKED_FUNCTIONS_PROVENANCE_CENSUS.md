# Untracked `functions/*.js` — provenance census

**Read-only. Nothing committed, deployed, reset, or cleaned to produce this. Tier 1 deployment
remains frozen; R1 and production untouched.**
**Date:** 2026-09-04 · **Trigger:** clean-checkout `firebase-tools` worktree failed to load
`functions/index.js` (`MODULE_NOT_FOUND: ./order-claim`) while reapplying Tier 1 commits onto
`release/multishop-checkout-certified`.
**Related:** [[MULTISHOP_STACK_PROVENANCE_MANIFEST]] · [[COMMISSION_INVOICE_SPEC]] ·
[[SOKONI_TILL_QR_PAYMENT_TRACE]] · [[POS_MANUAL_TILL_PAYMENT]] · [[MANUAL_TILL_ORDER_CONTRACT]] ·
[[SUBSCRIPTION_LAPSE_AUDIT]]

---

## 0. The two questions, kept separate

**1. Is the committed branch deployable?** **PROVEN NO.** `functions/index.js` at
`release/multishop-checkout-certified`'s HEAD (identical to `fa5082b`, confirmed byte-for-byte —
the file carries no local modification of its own) contains an unconditional, module-scope
`require('./order-claim')` and `require('./manual-till-orders')`. Neither file exists anywhere in
this repository's committed git history, on any branch. A clean checkout cannot load this file.

**2. Did production run this uncommitted code?** **UNPROVEN, and the evidence now points the other
way.** See §4.

---

## 1. The 14 untracked files — per-file census

| File | First observed (mtime) | Git history (`--all`) | Callers within `functions/` | Doc/spec found | Classification |
|---|---|---|---|---|---|
| `order-claim.js` | 2026-08-27 19:41 | **none, anywhere** | `index.js` (unconditional, top-level) | **none found** — not in the provenance manifest's own table, not in any doc, not even named in a contract | **C — provenance missing.** See §2. Not safe to guess at; not safe to silently include. |
| `manual-till-orders.js` | 2026-08-27 17:25 | none | `index.js`, `manual-till-policy.js` | `docs/MANUAL_TILL_ORDER_CONTRACT.md` (paired, written 12 min later — same work session) + row in `docs/MULTISHOP_STACK_PROVENANCE_MANIFEST.md` §1 | **B — foreign/parallel candidate, well-documented.** Explicitly gated: manifest §4/§6 says `manual_payment` must stay OFF until this lifecycle is "separately certified" — a decision never made. |
| `manual-till-policy.js` | 2026-08-27 17:15 (10 min before its caller) | none | `manual-till-orders.js` | referenced in `docs/SOKONI_TILL_QR_PAYMENT_TRACE.md` | **B — same cluster as `manual-till-orders.js`**, its policy/config collaborator. |
| `commission-invoice.js` | 2026-08-27 13:20 | none | `index.js` | **Full spec**, `docs/COMMISSION_INVOICE_SPEC.md`: *"BUILT 52/0 · NOT DEPLOYED · NO INVOICE CAN ISSUE"* — deliberately built and certified, deployment blocked by an **unset Firestore config** (`revenueConfig/commission_vat`) and two unresolved business decisions, not by code quality. | **A — proven canonical, deliberately gated on a config/business decision, not a code defect.** |
| `commission-vat-policy.js` | 2026-08-27 13:18 (2 min before `commission-invoice.js`) | none | `commission-invoice.js`, **and `functions/etims.js`** (tracked, currently has uncommitted local edits) | `docs/COMMISSION_INVOICE_SPEC.md` | **A — same unit as `commission-invoice.js`.** Its second caller (`etims.js`, a tracked file) means etims.js's *own* uncommitted working changes already assume this file exists — a second, independent load-bearing edge into this cluster. |
| `pos-mpesa-refs.js` | 2026-08-27 01:37 | **1 commit** (`233ac4d`), present on `backup/pre-rebase-09ae8d8`, `candidate/p9-entry-reconciled`, `chore/adopt-entitlements-index`, `chore/remove-hosting-workflow`, `evidence/tenant-authority-on-12c6676` — **not** on this lineage or R1 | `index.js`, `manual-till-orders.js` | **Full spec**, `docs/POS_MANUAL_TILL_PAYMENT.md`: certified 57/0, explicit deploy plan (`claimPosMpesaReference` + sync trigger, named-function deploy) | **B — proven foreign port.** Working copy is byte-identical to the committed version on `candidate/p9-entry-reconciled`. Real, tested, deliberately-scoped work from a separate lineage that was never merged here. |
| `tenant-identity.js` | 2026-09-01 12:27 | **1 commit** (`bc44f33`), present on `release/functions-converged-6775b09`, `release/r1-fold-candidate`, **`release/r1-pos-printer-fn` (R1 itself)** | `business-bootstrap.js`, `pos-retail-engine.js`, `pos-staff-ops.js`, `pos-zero-friction.js` (all four **tracked**, all four currently have uncommitted local edits) | committed on R1 as part of "P15C — offline shift registration" | **B — proven foreign port from R1.** Working copy is byte-identical to R1's committed version. Someone has been actively hand-porting R1's `tenant-identity.js` into this lineage's POS files, uncommitted, in progress. |
| `money-authority.js` | 2026-09-02 17:22 | none | `commission-settlement-authority.js`, `good-morning-gate.js`, `pos-sale-commission.js`, `wallet-money-adapter.js` (all four untracked, all four in this same cluster) | **Directly traced**, `docs/SOKONI_TILL_QR_PAYMENT_TRACE.md` (dated 2026-09-03, one day after this file's mtime): *"correct shape, confirmed unwired — nothing calls this"*; `classifyCustody()`/`planSaleAccounting()` named and assessed explicitly | **A — proven canonical candidate, confirmed correct shape by an independent prior trace, confirmed unwired.** |
| `pos-sale-commission.js` | 2026-09-02 17:50 | none | none found within `functions/` | same trace doc: *"the correct shape, needs wiring"*, `planSaleCommission()`/`planSaleAccounting()` named explicitly | **A — same as `money-authority.js`.** Its own trace doc states nothing calls it yet. |
| `commission-settlement-authority.js` | 2026-09-02 17:38 | none | none found (itself calls `money-authority.js`) | **none found by name** — postdates the 09-03 trace doc's likely working set by name, though same architectural family | **D — work-in-progress, undocumented by name.** Extends the traced `money-authority.js` core; not itself independently specified. |
| `wallet-money-adapter.js` | 2026-09-02 17:18 | none | none found (itself calls `money-authority.js`) | none found by name | **D — work-in-progress, undocumented by name.** Same family as above. |
| `good-morning-gate.js` | 2026-09-02 17:45 | none | none found (itself calls `money-authority.js` and `commission-settlement-authority.js`) | none found by name | **D — work-in-progress, undocumented by name.** Same family. |
| `receipt-number-authority.js` | 2026-09-02 18:32 | none | none found | none found by name | **D — work-in-progress, undocumented by name.** Same mtime cluster (09-02), no confirmed caller at all — the least-anchored file in the whole set. |
| `free-entitlement.js` | 2026-09-02 18:02 | none | none found | `docs/SUBSCRIPTION_LAPSE_AUDIT.md`: *"new, unwired... never throws — runs inside expiry sweeps where a throw strands the rest of the batch"* — a real design rationale, unrelated to the money-authority cluster despite the shared mtime window | **A — proven canonical candidate, documented design, confirmed unwired.** Coincidental same-day authorship, different feature. |

**Summary:** 4 files proven canonical (A: `commission-invoice.js`, `commission-vat-policy.js`,
`money-authority.js`, `pos-sale-commission.js`, `free-entitlement.js` — five, correcting the count),
3 files proven foreign ports (B: `manual-till-orders.js`, `manual-till-policy.js`,
`pos-mpesa-refs.js`, `tenant-identity.js` — four), 4 files work-in-progress with no independent
documentation (D: `commission-settlement-authority.js`, `wallet-money-adapter.js`,
`good-morning-gate.js`, `receipt-number-authority.js`), and **1 file with provenance missing**
(`order-claim.js`) — none Generated, none Obsolete, none fully Unknown.

---

## 2. `order-claim.js` — special attention, per your instruction

**Why `fa5082b` introduced an unconditional import with no committed module: it didn't, not
directly.** The commit's own message says so, verbatim:

> "functions/index.js's SOLE multi-shop change is one `createMultiShopCheckoutQuote` re-export
> (hunk-proven; `darajaSTKPush` and `_finalizeMarketplacePayment` untouched)."
>
> "**DEPLOY CONSTRAINT: NAMED-FUNCTION deploy ONLY** — `createPaymentIntent`,
> `createMultiShopCheckoutQuote`, `getShopCheckoutMode` — coupled with hosting. **NEVER deploy FULL
> index.js: it would smuggle unrelated untracked callables (manual-till-orders, order-claim,
> commission-invoice, pos-mpesa-refs) live.** Reconcile onto release-b/live before any deploy."

`fa5082b` committed `functions/index.js` as a whole file. The `order-claim`/`manual-till-orders`
requires were **already sitting in the working tree, uncommitted, before this commit** — the
commit captured them as a side effect of committing the file, not as a deliberate addition. The
author knew this (the message names all four hazard files by exact filename) and chose a
**process-level mitigation instead of a code-level one**: never run a full-file functions deploy,
only ever deploy the three specific functions this commit actually intended to ship. There is no
automated gate enforcing this — `scripts/predeploy-syntax-gate.js` only runs `node --check`, which
parses syntax and would **not** catch a missing-module `require()` at deploy time. The safety here
is a sentence in a commit message, not a mechanism.

**`order-claim.js` itself remains genuinely unaccounted for.** Unlike every other file in this
census, it has:
- no git history on any branch, ever
- no row in `docs/MULTISHOP_STACK_PROVENANCE_MANIFEST.md`'s own file-by-file table (out of that
  manifest's stated scope — it covers the multi-shop *checkout* stack; "Atomic order claim
  (multi-employee POS distribution)," per its own inline comment in `index.js`, is a different
  feature)
- no contract, spec, ADR, or trace document anywhere in `docs/`
- one caller (`index.js`, unconditional) and no way to confirm what `claimOrder`/
  `releaseOrderClaim` are actually supposed to do beyond reading the file's own source

Per your classification: **C — proven required (by the committed `index.js`), provenance
missing.** Not to be guessed at, reconstructed, or approved by inference from its filename. Escalated,
not resolved, by this census.

---

## 3. Is `.firebaseignore` or deploy config relevant?

**No `.firebaseignore` exists anywhere in the repo** (root or `functions/`) — checked directly, no
exclusion mechanism could have kept these files out of a deploy or explains their absence from
production. `firebase.json`'s `functions.source` is the whole `functions/` directory with no
include/exclude filtering beyond the default `.gitignore`-adjacent Firebase defaults. The only thing
standing between "untracked file in the working tree" and "deployed to production" is whether
`firebase deploy` was invoked as a full-directory deploy or a named-function deploy — a human
decision each time, not a config-enforced boundary. This directly supports §2's finding: the
mitigation that has (so far) kept `order-claim.js` etc. off production is procedural discipline
recorded in a commit message, not tooling.

---

## 4. Production-deployed provenance vs. `fa5082b` vs. the dirty worktree

**Method 1 — live function inventory.** `firebase functions:list` (3,425 lines, ~380 functions) has
**zero** entries for `claimOrder`, `releaseOrderClaim`, `createManualTillOrder`,
`attestManualTillPayment`, or `getMyShopWorkspaces` (a later, definitely-committed evidence-branch
function, checked as a control). Known-live functions that share the same file (`webhookIntasend`,
`onOrderStatusChange`, `notifySend`) **are** present, confirming the query method itself works.

**Method 2 — independent prior finding.** `docs/MULTISHOP_STACK_PROVENANCE_MANIFEST.md` §3, dated
2026-08-30, reached the same conclusion by a different and more rigorous method — reading the
actual immutable GCS source archive generations for `createPaymentIntent`/`recordPayment`/
`posCompleteCheckout`/`verifyIntasendPayment`: *"Absent from every archive: `product_order` purpose
· single-shop guard · `_finalizeMarketplacePayment` single-shop invariant."* Two independent checks,
five days apart, agree.

**Method 3 — deploy timestamp sanity check.** `webhookIntasend`'s live `updateTime` is
`2026-08-30T15:13:18Z`, close to `fa5082b`'s commit time. This does not itself prove which source
was deployed, only that *some* functions deploy happened around then — consistent with, but not
proof of, the "named-function only" deploy the commit message describes.

**Conclusion, in your framing:**
- **PROVEN:** the clean committed branch cannot load `functions/index.js`.
- **PROVEN:** the dirty worktree contains the missing dependency files (14 of them, not just the
  two `index.js` requires).
- **PROVEN (new, this pass):** the commit message that introduced the broken requires explicitly
  documents why — the requires rode along uncommitted-to-committed, and a **named-function-only**
  deploy discipline was declared as the mitigation.
- **UNPROVEN, and now less likely than initially suspected:** that production was ever deployed
  from the dirty worktree wholesale. The live function inventory shows the callables that *would*
  exist if it had been are absent, which is more consistent with the named-function deploy
  discipline having actually been followed than with a full dirty-tree deploy having happened.
- **BLOCKER, unchanged:** source provenance must be reconciled — specifically `order-claim.js`
  (Outcome C, escalated) — before any production deployment, Tier 1 included, since Tier 1's own
  release gate requires a clean-checkout deploy of the target branch, and that branch still cannot
  load `functions/index.js` today.

---

## 5. What this means for Tier 1

Tier 1's reapplication of the SMS fix and Moderator hardening (both cherry-picked cleanly onto
`release/tier1-admin-notification-reliability`, both targeted-certified) never touched
`order-claim.js` or its neighbors. The blocker is inherited from the base branch, not introduced by
Tier 1's own work. Tier 1 cannot deploy functions until `functions/index.js` loads from a clean
checkout — which means either (a) `order-claim.js`'s provenance is resolved and it is committed (or
explicitly stubbed/removed) upstream of Tier 1, or (b) Tier 1 deploys functions by explicit
named-function list (matching `fa5082b`'s own documented discipline) rather than a full-directory
deploy, with that list excluding anything that touches the unresolved requires. Both are your call,
not mine to pick.

## 6. Open questions for you

1. `order-claim.js` — provenance unresolved. Reconstruct from spec (none exists), ask whoever wrote
   it, or treat `claimOrder`/`releaseOrderClaim` as out of scope entirely (remove the require,
   confirm nothing else depends on it) until it has one?
2. The four B-classified foreign ports (`manual-till-orders.js`+`manual-till-policy.js`,
   `pos-mpesa-refs.js`, `tenant-identity.js`) are real, tested, documented work from other
   lineages/branches. Do any belong in Tier 1, Tier 2, or neither?
3. The four D-classified work-in-progress files
   (`commission-settlement-authority.js`/`wallet-money-adapter.js`/`good-morning-gate.js`/
   `receipt-number-authority.js`) extend the traced-and-confirmed `money-authority.js` core but have
   no independent spec. Worth a dedicated trace pass before Tier 2, given Tier 2 is already the
   payment-critical release?
4. Should Tier 1's functions deploy explicitly adopt `fa5082b`'s "named-function only" discipline as
   a standing rule, given there is no tooling enforcement of it today?

---

## 7. Addendum — 2026-09-05 · one row resolved, and Open Question 4 answered

**This appends to the census above; none of its analysis is rewritten.** Two things changed
after it was written, one of them caused by this session.

### `tenant-identity.js` — row resolved, no longer untracked

Committed to `release/multishop-checkout-certified` at **`24f50ba`** under founder
authorisation. Not a reconstruction: the working copy was byte-identical to an already-committed
blob.

```
25d2c19 blob : 4d89a1da854f8a05e41147661dfff42654a4bf3b
working file : 4d89a1da854f8a05e41147661dfff42654a4bf3b
cmp          : identical, no differing byte, 4242 bytes both sides
```

The census recorded its provenance as `bc44f33` on R1; the newest committed instance is
`25d2c19` (2026-09-04), reachable from `feature/sales-control-centre-approvals` and
`feature/void-permission-convergence`. Same content either way. All five consumers resolve
against it: `business-bootstrap.js`, `pos-retail-engine.js`, `pos-staff-ops.js`,
`pos-zero-friction.js`, `procurement.js`.

**Its classification changes from B (foreign port) to RESOLVED.** The remaining thirteen rows
stand exactly as written.

### Open Question 4 now has a mechanism, not just a discipline

The census's §3 found that the only thing between an untracked working file and production was
whether someone typed a full-directory or a named-function deploy — *"procedural discipline
recorded in a commit message, not tooling"* — and Open Question 4 asked whether that should
become a standing rule given nothing enforced it.

`scripts/gate-functions-require-closure.js` now enforces the measurable half. It walks the
**transitive require graph from `functions/index.js`** over the **git tree** (`git ls-tree` +
`git cat-file --batch`), never the filesystem, and exits non-zero when a module the entrypoint
needs is not in the tree. A module sitting untracked on someone's disk is reported as
**`present-UNTRACKED  <- NOT CLOSURE: a deploy uses a checkout, not this disk`**.

At `HEAD` it fails, naming exactly the four this census identified:

| module | on disk | committed on any ref |
|---|---|---|
| `order-claim` | present-UNTRACKED | **never** |
| `manual-till-orders` | present-UNTRACKED | **never** |
| `commission-invoice` | present-UNTRACKED | **never** |
| `pos-mpesa-refs` | present-UNTRACKED | `233ac4d` |

Certified by `scripts/test-functions-require-closure-gate.js` — **41 checks, 5 sabotage
catches**. The non-vacuity control matters most: the same gate **passes** on `fa5082b^`, the
commit immediately before the broken requires landed, walking 321 modules cleanly. Same gate,
same repo, two refs, opposite verdicts — which also independently confirms this census's finding
that closure broke at `fa5082b`.

**The gate is NOT wired into `firebase.json`'s predeploy hooks.** Wiring it is a
deployment-configuration change and remains a founder decision. It is a standalone check today:

```
node scripts/gate-functions-require-closure.js            # scan HEAD
node scripts/gate-functions-require-closure.js --ref X    # scan any ref
```

### What is still open

Open Questions 1, 2 (for the remaining ports) and 3 are unchanged and remain founder decisions.
`order-claim.js` in particular is still Outcome **C — provenance missing**, and nothing in this
addendum resolves it. **No deployment has been performed.**
