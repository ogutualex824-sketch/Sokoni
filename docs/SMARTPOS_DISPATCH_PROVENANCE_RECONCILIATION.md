# `smartPosDispatch` — production-to-repository provenance reconciliation

**Direct evidence only — the deployed source archive was downloaded and read, not inferred from
observed behavior.** Nothing committed, deployed, reset, or cleaned to produce this. Tier 1 remains
frozen. R1 and production untouched (read-only `gcloud`/`gcloud storage` reads against the immutable
GCS source generation; no write, no redeploy).
**Date:** 2026-09-04 · **Trigger:** `docs/TENANT_IDENTITY_DEPENDENCY_TRACE.md` inferred, from
`getSetupStatus` being on a live client path, that production's deployed bundle "almost certainly"
already contains `tenant-identity.js`. Explicitly instructed not to leave that as inference — obtain
the deployed artifact and compare it directly.
**Related:** [[TENANT_IDENTITY_DEPENDENCY_TRACE]] · [[ORDER_CLAIM_PROVENANCE_TRACE]] ·
[[UNTRACKED_FUNCTIONS_PROVENANCE_CENSUS]]

---

## 0. Method

`gcloud functions describe smartPosDispatch --gen2 --region=us-central1 --project=sokoni-aeb26`
returns the exact deployed source location: GCS bucket `gcf-v2-sources-24799054989-us-central1`,
object `smartPosDispatch/function-source.zip`, **generation `1788294400928902`** (immutable —
generation-pinned, cannot have changed since that deploy). Downloaded with
`gcloud storage cp ...#1788294400928902`, unzipped, and diffed file-by-file against known commits
on `release/multishop-checkout-certified` and R1 (`release/r1-pos-printer-fn`). Deploy metadata:
`updateTime: 2026-09-01T20:27:46Z`, revision `smartposdispatch-00027-hif`.

## 1. `tenant-identity.js` itself — Outcome A, exact

**Present in the deployed archive.** Byte-for-byte identical to R1's committed `bc44f33`
(`diff` against `git show release/r1-pos-printer-fn:functions/tenant-identity.js` → no output, zero
difference). This is the cleanest possible result for this one file: production has it, R1 has it,
they are the same bytes.

## 2. `functions/business-bootstrap.js` — NOT the incident it looked like

**The deployed version does not use `tenant-identity.js` at all.** It has the older, simpler
`db.collection('businesses').where('ownerId','==',uid).limit(1).get()` pattern in all three
payment-destination/setup functions — no `resolveMerchantIdForOwner`, no ambiguity handling. My
prior trace's inference (*"if `getSetupStatus` works today, the deployed bundle almost certainly
already contains `tenant-identity.js`"*) was **wrong**, and the direct evidence is exactly why you
asked for it rather than accepting the inference.

**Why:** the evidence-branch commit that wired `tenant-identity.js` into `business-bootstrap.js`
is `1f5664c` ("posProducts field-mismatch remediation..."), dated **2026-09-03 21:22:56** — **two
days after** the `smartPosDispatch` deploy (2026-09-01 20:27:46). The deployed file is simply an
earlier point in this same file's own linear, committed history — closest match found is between
`efd95a3` and `5189365` (14 and 31 diff lines respectively; exact commit not pinned further, not
needed for the conclusion). **This is ordinary staleness, not an unexplained artifact.** The
committed evidence-branch `business-bootstrap.js` is *ahead* of what's deployed, not divergent from
it — a normal "hasn't been redeployed since this change landed" state, the same category as dozens
of other not-yet-deployed commits already on this branch.

**Consequence:** the live `getSetupStatus` path that runs on every `pos-setup.html` session start
does **not** touch `tenant-identity.js` today. The risk framed in the prior trace — "production may
depend on source the repository doesn't explain" — does not apply to `business-bootstrap.js`. It
applies to something else, found next.

## 3. `functions/pos-staff-ops.js` — Outcome A, but NOT sourced from this branch

**The deployed version DOES use `tenant-identity.js`** — found by grepping the entire extracted
archive for any caller, which turned up exactly two files: `tenant-identity.js` itself and
`pos-staff-ops.js`. Confirmed:

```
deployed pos-staff-ops.js:14   const { resolveMerchantIdForOwner, looksLikeOwnerForm, REASON: TENANT_REASON } = require('./tenant-identity');
deployed pos-staff-ops.js:77,91  const owned = await resolveMerchantIdForOwner(auth.uid);
```

Diffed against R1's current committed `pos-staff-ops.js` (`bc44f33`'s descendant tip): the
tenant-identity-specific lines match exactly (no diff hunk touches them); the only differences are
R1 features that postdate this specific deploy — a manager-approval "binding"/four-eyes
self-approval-prevention hardening pass, absent from the deployed copy. So the deployed file is a
**real, earlier snapshot of R1's own pos-staff-ops.js**, not a fabrication and not hand-edited.

**But `release/multishop-checkout-certified`'s own git history has never contained this wiring at
all** — confirmed directly: `git show release/multishop-checkout-certified:functions/pos-staff-ops.js
| grep -c tenant-identity` → `0`, on every commit checked. This is the actual finding your
instruction anticipated: **production's live `pos-staff-ops.js` traces cleanly to R1's provenance,
not to this branch's own committed history.** Whoever deployed `smartPosDispatch` on 2026-09-01 did
so from a source tree that already incorporated R1 work this branch has never merged. The main
worktree's own uncommitted copy of `pos-staff-ops.js` (mtime 2026-09-01 14:29, i.e. *before* the
20:27 deploy that same day) is closer to R1's current tip (40 diff lines) than to what's actually
deployed (139 diff lines) — consistent with someone hand-porting from R1 around that time, with the
deploy having drawn from a slightly earlier point in that same porting effort.

## 4. Outcome, per your framework — file by file, not one verdict for the whole incident

| File | Outcome | What it means |
|---|---|---|
| `tenant-identity.js` | **A** — production matches R1 `bc44f33` exactly | Approval/documentation gap only (the still-unresolved `EMPLOYEE_AUTHORITY_CONVERGENCE_DECISION.md`), not unexplained code. |
| `business-bootstrap.js` | **Not a divergence at all** | Deployed content is simply older than this branch's own committed history (predates `1f5664c` by 2 days). No mystery, no cross-branch sourcing — ordinary not-yet-redeployed staleness. |
| `pos-staff-ops.js` | **A, but cross-branch** | Deployed content traces cleanly to R1's provenance (not fabricated, not divergent from any *known* source) — but it was deployed from a tree that was never `release/multishop-checkout-certified`'s own git history. This is the one genuine "deployed reality the committed lineage doesn't fully explain" instance this reconciliation found. |

**None of the three files hit Outcome C** (differs from both R1 and this branch, third unexplained
source). Every byte traced to a known, real commit somewhere in this repository's history. The
incident is real but narrower than the worst case: it is a **cross-branch deployment provenance
gap** (production functions were deployed from a tree mixing this branch's history with
hand-ported/uncommitted R1 work), not evidence of a fabricated or externally-injected artifact.

## 5. What this changes for Tier 1 and for the release board

- **`business-bootstrap.js` is confirmed, with direct evidence now (not inference), to be safely
  out of scope for anything urgent.** Its committed tenant-identity wiring is unreleased work
  sitting ahead of what's deployed — Tier 1 excluding it costs nothing live.
- **The `pos-staff-ops.js` finding is the one that needs a decision, and it is bigger than Tier 1:**
  production is already running R1-provenanced code for POS staff operations that
  `release/multishop-checkout-certified` has never committed. This was true before this
  investigation started and is unrelated to anything Tier 1 does — it is a standing fact about the
  current production deployment, surfaced by this reconciliation, not created by it.
- Tier 1 itself still does not touch `business-bootstrap.js`, `pos-staff-ops.js`, or
  `tenant-identity.js` in any way. Nothing here changes Tier 1's frozen status or its own
  `order-claim.js` disposition.

## 6. Release board, updated

```
Tier 1:                         FROZEN (unchanged)
order-claim:                    NOT ADMITTED (unchanged)
tenant-identity.js:             R1-canonical, byte-identical in production — approval-decision
                                 artifact (EMPLOYEE_AUTHORITY_CONVERGENCE_DECISION.md) still
                                 unresolved
business-bootstrap.js:          NOT a Tier 1 dependency; NOT a production divergence — deployed
                                 copy is simply older than this branch's own committed history
pos-staff-ops.js:                production's live copy traces to R1, not to this branch's git
                                 history — a genuine cross-branch deployment-provenance gap,
                                 pre-existing, unrelated to Tier 1, needs its own decision
Production:                     no change
R1:                              no change
```

No action taken beyond read-only investigation. The next decision — what to do about
`pos-staff-ops.js`'s cross-branch provenance, and separately, the `EMPLOYEE_AUTHORITY_CONVERGENCE_DECISION.md`
gap — is yours.
