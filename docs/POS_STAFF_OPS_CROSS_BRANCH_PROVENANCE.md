# `pos-staff-ops.js` — cross-branch deployment provenance record

**Status:** OPEN — pre-existing production condition, confirmed with direct evidence, tracked
separately from Tier 1 and from the order-claim.js / tenant-identity.js investigations that
surfaced it. Not to be folded into the Admin/Notification release; not to be "fixed" as a side
effect of another release.
**Date opened:** 2026-09-04 · **Found during:** `docs/SMARTPOS_DISPATCH_PROVENANCE_RECONCILIATION.md`
(§3), itself triggered by Tier 1's `functions/index.js` dependency-closure work.
**Related:** [[SMARTPOS_DISPATCH_PROVENANCE_RECONCILIATION]] · [[TENANT_IDENTITY_DEPENDENCY_TRACE]] ·
[[EMPLOYEE_AUTHORITY_CONVERGENCE_DECISION]]

---

## The finding, stated once, precisely

Production's currently-deployed `smartPosDispatch` Cloud Function (GCS source generation
`1788294400928902`, deployed `2026-09-01T20:27:46Z`, revision `smartposdispatch-00027-hif`)
contains a `functions/pos-staff-ops.js` whose `resolveMerchantIdForOwner`/`tenant-identity.js`
wiring is **byte-identical to R1's own committed history** (`release/r1-pos-printer-fn`, descended
from `bc44f33`) but **has never existed in any commit on `release/multishop-checkout-certified`**
— confirmed directly: `git show release/multishop-checkout-certified:functions/pos-staff-ops.js |
grep -c tenant-identity` returns `0` on every commit checked on that branch.

This was established by downloading and reading the actual deployed source archive from GCS
(`gcloud storage cp gs://gcf-v2-sources-24799054989-us-central1/smartPosDispatch/function-source.zip#1788294400928902`),
not inferred from observed runtime behavior — per the release-hygiene lesson this investigation
produced: **the deployed artifact, not the current worktree or even the current branch tip, is the
authority for "what is live."**

## What this is, and is not

**Is:** a genuine cross-branch deployment-provenance gap. Whoever ran the `smartPosDispatch` deploy
on 2026-09-01 did so from a source tree that already incorporated R1 work — either a hand-port, a
different local checkout, or some combination — that this branch's own git history has never
recorded. The code itself is real, traces to a known commit (R1's), and is not fabricated or
externally injected.

**Is not:** a Tier 1 concern. None of Tier 1's four approved features (SMS delivery, Moderator
hardening, Employee authorization, Platform Health) touch `pos-staff-ops.js`. Explicitly not
brought into Tier 1's reapplication — mixing a production-lineage provenance question into a
focused Admin/Notification release would make that release's boundary less trustworthy, per your
instruction.

**Is not (yet) proven unsafe.** The deployed code is an earlier, real snapshot of R1's own staff-ops
authority work — it is missing R1's later manager-approval "binding"/four-eyes hardening pass, but
nothing found here indicates the deployed version is broken or behaving incorrectly. This record
tracks a provenance gap, not a live defect.

## Why it matters anyway

`release/multishop-checkout-certified` is treated throughout this session as the source of truth
for what should be deployable and what's actually live. This is the first confirmed instance where
that assumption doesn't hold: a real, currently-running Cloud Function's behavior is governed by
code this branch's own history cannot produce, from a clean checkout, no matter how far back you
walk it. Any future redeploy of `smartPosDispatch` from this branch's actual committed history
(without first reconciling this) would **regress** `pos-staff-ops.js`'s employee-authority behavior
back to whatever this branch's own commits contain today — which is nothing, since the wiring was
never committed here at all. That regression risk is real and independent of anything Tier 1 does.

## What resolving this requires

Not a code fix. A provenance decision:

1. Confirm whether the R1-derived `pos-staff-ops.js` behavior currently live in production is the
   **intended** behavior (i.e., was this deploy deliberate, using a known source, even if
   undocumented) or an **accidental** consequence of deploying from the wrong tree.
2. If intended: the missing commit needs to land on `release/multishop-checkout-certified`'s own
   history — either by cherry-picking the relevant R1 work, or by an explicit note that this branch
   now tracks a known, accepted divergence from its own git history until reconciled.
3. If accidental: decide whether to leave production as-is (it may be working correctly) or
   redeploy deliberately from a chosen, known-good source — understanding that a redeploy from this
   branch's current committed history would remove the tenant-identity wiring `pos-staff-ops.js`
   currently has live.
4. Either path intersects `docs/EMPLOYEE_AUTHORITY_CONVERGENCE_DECISION.md` — the still-open
   decision artifact that was supposed to govern whether/how `tenant-identity.js`'s employee-
   authority model gets adopted at all. Resolving that decision first will likely determine the
   answer here too, since `pos-staff-ops.js`'s tenant-identity usage is one instance of exactly the
   convergence question that document poses.

## Explicitly not touched by this record

- `functions/pos-staff-ops.js` — neither the committed evidence-branch copy nor the deployed
  artifact was modified.
- No redeploy, no rollback, no commit admitting R1 work onto this branch.
- Tier 1 (`release/tier1-admin-notification-reliability`) — unaffected, stays frozen for its own,
  separate reasons (`order-claim.js` provenance, per `docs/ORDER_CLAIM_PROVENANCE_TRACE.md`).
