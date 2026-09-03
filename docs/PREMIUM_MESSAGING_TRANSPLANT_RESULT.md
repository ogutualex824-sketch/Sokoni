# Premium messaging server transplant — result

**Status:** ✅ CLEAN SLICE — certified and committed. **Not yet on `release/r1-pos-printer-fn`'s
branch ref.** `C:/temp/sok-r1` was not touched at any point.
**Date:** 2026-09-03 · **Result commit:** `96c3244` (tag `pending-premium-messaging-r1`), parent
`8fc3673` (exact tip of the frozen manifest).

Prerequisite reading: `docs/PREMIUM_MESSAGING_PATCH_PLAN.md` (the plan this executes exactly, with
one line-ending fix noted below that the plan didn't anticipate).

---

## What happened, in order

1. **New isolated worktree**, `git worktree add <scratch> 8fc3673 --detach` — a separate location
   from `C:/temp/sok-r1`, `node_modules` copied in read-only.
2. **Baseline gate run** on the clean tree, before any edit: `GATE PASSED` (16 modules, 106
   handlers, 0 frozen debt) — confirms the starting point matches the frozen manifest exactly.
3. **Isolated certification written and run** against a scratch copy of the evidence branch's
   `functions/messages.js` (not r1's tree) — 39 real assertions covering `reactToMessage` (auth,
   participant-scoping, the 8-emoji allowlist, deleted-message refusal, one-reaction-per-user
   replace semantics, a second participant's reaction being independent, `emoji:null` removal),
   `addRiderToConversation` (auth, non-participant/self-add refusal, the 3-participant cap,
   already-a-participant short-circuit, admin bypass, the honest `enforcedBy: 'NOT_YET_ENFORCED'`
   report), and `expireOldChatMessages` (all 10 retention carve-out cases named in the original
   commit message, plus the cutoff boundary and default-delete-on-unrecognised-shape property).
   Two real bugs were found and fixed **in the test harness itself** during this step (a
   dotted-field-path merge-order bug, a timestamp-comparability bug) — not in the source under
   test. Final result: 39/39.
4. **Surgical insertion** at the two exact anchor points identified in the patch plan — confirmed
   present, unmodified, in `8fc3673` before inserting.
5. **One-line `functions/index.js` re-export** added for `expireOldChatMessages` (an `onSchedule`
   function needs this to deploy at all; `reactToMessage`/`addRiderToConversation` need none —
   confirmed both branches' `messages-dispatch.js` are byte-identical and resolve ops dynamically).
6. **Line-ending fix, not anticipated by the patch plan.** r1's `functions/messages.js` is
   consistently CRLF (confirmed: 1096 of 1097 lines in `8fc3673`, the one exception being a
   trailing-split artifact, not a real line). The inserted text initially landed as LF, creating a
   real inconsistency. Normalized the whole file to CRLF before committing — this is *why* the
   insertion is CRLF, matching the file's own established convention, not a stylistic choice.
   `git diff --check` still flags the inserted CRLF lines as "trailing whitespace" — confirmed this
   is a **pre-existing characteristic of every line in this file**, not something introduced by
   this change: `core.autocrlf` is unset, `core.safecrlf=false`, no `.gitattributes` override, and
   touching *any* pre-existing untouched CRLF line in the same file triggers the identical warning.
   Not a real defect; `git commit` itself is not blocked by `--check` findings.
7. **Full regression, re-run against the actual edited tree**: master gate + all 16 existing r1
   certification scripts — identical results to the pre-edit baseline, 100% pass. Export count:
   1519 → 1520 (exactly the one new re-export; `git diff --stat`: 271 insertions, 0 deletions across
   both files — a perfectly clean, purely additive slice).
8. **Isolated certification re-run against the actual transplanted file** (not the scratch copy) —
   39/39, unchanged.
9. **Committed** in the detached-HEAD worktree. Parent confirmed exactly `8fc3673`.

## Why the branch ref was not moved — and what "committed but not stacked" means here

`release/r1-pos-printer-fn` still points to `8fc3673` — verified before and after
(`git rev-parse release/r1-pos-printer-fn`). The new commit `96c3244` exists, is fully valid, and
would fast-forward the branch cleanly (its parent is the exact current tip) — but moving the branch
ref requires either `git branch -f` (which git itself refuses: the branch is checked out in
`C:/temp/sok-r1`) or a lower-level `update-ref`, which would work mechanically but would silently
change what `HEAD` means in that dirty worktree out from under whoever is working there — every
file they haven't touched would suddenly appear "modified" relative to a HEAD that moved without
their knowledge. That is a real disruption, not a formality, and it is exactly the "do not touch
`C:/temp/sok-r1`" boundary applied one layer indirectly. **Not done.**

The commit is anchored by a git tag (`pending-premium-messaging-r1`) so it survives independently
of any worktree and isn't garbage-collected while unreferenced by a branch.

## What happens next (not decided or executed here)

The moment `C:/temp/sok-r1`'s in-progress 18b work is committed there, one of two things is true:
- If that commit's parent is `8fc3673` (the same tip this transplant is based on), `96c3244` and
  the 18b commit are **siblings** — one needs to be rebased onto the other (order to be decided;
  neither depends on the other's files, so either order should apply cleanly, but that's a claim to
  verify, not assume).
- The branch ref can then be fast-forwarded to whichever final commit results, safely, since the
  worktree would no longer be dirty.

Not attempted here, per "18b remains waiting."

## Certification summary

| check | result |
|---|---|
| Baseline gate (pre-edit) | PASSED — 16 modules, 106 handlers, 0 frozen debt |
| Isolated cert, scratch copy | 39/39 (2 harness bugs found and fixed along the way) |
| Full regression, post-edit (gate + 16 scripts) | 100% pass, identical to baseline |
| Isolated cert, actual transplanted file | 39/39 |
| `git diff --stat` | 271 insertions, 0 deletions, 2 files — purely additive |
| Existing exports/behavior | untouched (confirmed both before and after) |

## Related

`docs/PREMIUM_MESSAGING_PATCH_PLAN.md` · `docs/PREMIUM_MESSAGING_READINESS.md` ·
`docs/R1_RELEASE_CANDIDATE_MANIFEST.md` (item 15, updated) · `docs/RELEASE_STACK_LEDGER.md`
