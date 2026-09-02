# Rules consolidation — Group B certification

**Date:** 2026-09-02
**Transformation:** served `59af870d` → `candidate-a` → **`firestore.rules.candidate-b`**
**Status:** **CERTIFIED EVIDENCE COMPLETE / ACCEPTANCE PENDING.**
Not released. Acceptance is a separate decision from publication, and neither has been given.

> **The evidence proves candidate-B. It does not by itself authorise accepting B as a
> production Rules change.** Those are different claims, and the first compile failure is
> why: Group A and Group B were each correct in isolation and their COMPOSITION was
> invalid. Certifying transformations independently and composing them blindly is exactly
> what that failure rules out.

**The artifact under test is the composed one.** `candidate-b` was built FROM
`candidate-a`, not from served — verified empirically rather than assumed: all 20 Group A
block paths are present in served, absent in candidate-a, and still absent in candidate-b;
the 5 single-line blocks Group A missed are present in served AND candidate-a, and absent
only in candidate-b. So every figure in the gate below is `served -> (A+B)`.

Related: [[RULES_GROUP_A_CERTIFICATION]] · [[ADR-014-server-backed-stories]] ·
`docs/RULES_CONSOLIDATION_CANDIDATES.md`

---

## What changed

307 constant-false `allow` clauses removed (344 → 6; the 6 remaining are in policy-excluded
scopes), plus 5 single-line inert blocks Group A had missed, plus 1 block left empty by the
composition of A and B.

| | source | compiled | free |
|---|---|---|---|
| served `59af870d` | 252,640 ch | 255,551 B | 449 |
| candidate-a | 250,242 ch | 253,623 B | 2,377 |
| **candidate-b** | **241,528 ch** | **243,121 B** | **12,879** |

Marginal gain of B over A: **10,502 compiled bytes**.

## The gate — B-specific, nothing inherited from A

| # | condition | result |
|---|---|---|
| 1 | 20,940-case served ↔ candidate-B | **0 divergences**; ALLOW 4,581 ↔ 4,581 |
| 2 | contemporaneous 20,940-case served ↔ served | **0 divergences**; ALLOW 4,581 ↔ 4,581 |
| 3 | sabotage against **candidate-b** | **8 divergences**, all DENY→ALLOW on `invitations` |
| 4 | zero empty/unclosed match blocks | **0**, with served as a **0-control** |
| 5 | granting clauses | **1,316 → 1,316** |
| 6 | `shopEmployees.shopOwnerId` | **byte-identical**; occurrence count unchanged |
| 7 | excluded scopes | **10/10 identical occurrence counts** |
| 8 | nothing added or rewritten | every candidate code line derives from a served code line |
| 9 | compiled size under ceiling | **243,121 B**, 12,879 free |
| 10 | production `cloud.firestore` | `59af870d`, `updateTime` unchanged; 3 releases, no strays |

Each of 1–3 was run against candidate-b at full scale. The determinism control was run
**after** the equivalence run rather than cited from Group A's gate: a control that is not
contemporaneous with the run it validates is weaker evidence.

## Group B was rejected once, and why that matters

The first candidate-b **failed to compile** — ruleset CREATE refused, meaning invalid
syntax, not a size limit.

**Root cause, probed rather than inferred:** an empty `match /a/{id} { }` is a **syntax
error**, and so is a block containing only a comment. A normal block was accepted as the
control.

It appeared only **cumulatively**. Group A removed the nested `/versions/{version}` block
inside `legalAgreements` — correct, it granted nothing, and candidate-a compiled and
released cleanly. Group B then removed the parent's own constant-false clause and the parent
had nothing left. **Neither group alone produced it**, so no amount of per-group testing
could have found it; only compiling the composed artifact did.

This is now a standing rule:

> **Safe removal requires both semantic equivalence and composed-artifact validity.**
> A clause proven inert is not thereby proven deletable.

The transformer gained a fixpoint pass that removes emptied containers (no rules and no
block both mean deny), keeps their comments, and iterates — emptying a child can empty its
parent — with a postcondition asserting zero empty blocks.

## Two probes were wrong before the file was

- The first empty-block detector reported **29**. It popped single-line blocks before
  counting their content. The true answer was **1**, established by running the same
  detector against served as a **0-control**.
- A regex was corrupted by `node -e` shell escaping — a known, previously recorded hazard
  walked into again. Fixed with `new RegExp(...)` and the editor rather than the shell.

Neither was caught by the transformation being correct. Both were caught by a control.

## A gap in Group A, disclosed

Group A required a block to span multiple lines (`end > start`), so it silently skipped
**5 single-line inert blocks**: `etimsCredentials`, `etimsSequences`,
`etimsReconciliations`, `hubCredentials`, `hubSequences`. That is an **under-removal** —
nothing wrong was removed — so Group A's acceptance stands unaffected. They are folded into
Group B.

## A correction to the gate itself

`verify-candidate-gate.js` counted `allow` occurrences in **raw** text, including inside
comments — served contains three, one of them a line reading
``// the `allow write: if false` guard in the Digital Products Hub section``. It reported
1,319 granting clauses where the code contains **1,316**.

Harmless while both sides carried identical comments. **Not** harmless for Group B, which
deliberately keeps comments whose clause was removed: comment-resident `allow` text can
shift, so a contaminated count could fail spuriously or cancel out a real change. The gate
now decomments before counting. Group A was re-verified under the corrected gate: **10/0**.

## What this does NOT establish

- **Not released.** Publication is a separate decision under its own authorization.
- **Equivalence is over the corpus, not over all inputs.** 698 scopes × 6 personas ×
  5 methods is broad sampling. `get()` lookups into other collections resolve against no
  data, so cross-document conditions are not exercised.
- **The six remaining constant-false clauses** are in excluded scopes and were deliberately
  left alone.
