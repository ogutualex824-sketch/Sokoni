# G1 — Rules lineage guard, design

**DESIGN ONLY. `scripts/guard-rules-lineage.js` has NOT been modified.** No rules change, no
candidate change, no deployment. G2 (implementation) requires its own authorization.

Purpose: make the guard capable of passing on the authorized release lineage **without weakening
the security boundary it exists to enforce**.

---

## 1. Why it currently cannot pass

    FIX = '80297d4'   contained ONLY in audit/employee-attribution

The fix reached the release line as **`776248b`** — *"bring 80297d4 into this lineage so the tree
matches production"*, whose body records *"Cherry-pick of 80297d4 (was contained only in
audit/employee-attribution)."* It is an ancestor of `release/merchant-launch-rc` HEAD and of
`8472af9c`. `82cd8bf` later refined the same clause, preserving all three constraints.

So the lineage check pins an original SHA that **by construction can never be an ancestor of a
release branch**, while the content it protects is present on the branch, in production, and in the
candidate. The check is not wrong about security; it is wrong about how security work travels
between branches in this repo.

---

## 2. Design principle

> The required security change is present in the authorized release lineage — **including
> recognised cherry-picked or re-authored provenance** — and the resulting `users/{userId}` clause
> satisfies the content invariant.

Pinning one original SHA makes every future legitimate transport of security work a deploy
outage. The guard should be hard to *satisfy falsely*, not hard to satisfy *correctly*.

---

## 3. Lineage — four options, with what each costs

| | approach | verdict |
|---|---|---|
| **A** | `FIX = '776248b'` | Works today, fails identically the next time a fix is cherry-picked. Moves the single point of failure rather than removing it. |
| **B** | Allowlist of SHAs (`80297d4`, `776248b`, …) | Honest and explicit, but grows forever and every entry needs its own review. Acceptable as a stopgap; poor as a design. |
| **C** | Drop lineage, rely on content alone | **Rejected** — the owner ruled not to weaken the guard, and the two-check design exists because either alone can be defeated. |
| **D** | **Provenance by content-introduction** — require that the invariant text was introduced by a commit reachable from HEAD, established with `git log -S '<invariant>' HEAD`, and that at least one such commit exists | Survives cherry-picks and re-authoring because it asks *"did this protection enter this history deliberately?"* rather than *"is this exact SHA here?"* |

**Recommended: D, with B as the migration path** — carry the explicit allowlist while D is proven,
then retire it. Neither is weaker than today: both still require the content invariant.

**D must not degrade to a text search.** `git log -S` on the working tree alone would pass for any
tree that merely *contains* the text. The check is that a commit **reachable from HEAD** introduced
it — which is what distinguishes authorized provenance from a hand-edited file.

---

## 4. Content — one hardening the current implementation needs

The content check selects the block with:

    src.match(/match\s+\/users\/\{userId\}\s*\{[\s\S]*?\n\s*\}/)

**First textual match, no depth awareness.** Measured in the current ruleset:

    match /users/{userId}   brace depth 2   TOP-LEVEL          <- the one that matters
    match /users/{uid}      brace depth 3   nested in /typingIndicators/

Today the top-level block happens to come first, so the guard reads the correct one. **That is
ordering luck, not design.** If a nested `users` block were ever authored above the top-level one,
the guard would validate the wrong block and report a protection that the deployed rules do not
have — while the permissive block shipped.

**Requirement:** select the block by **path and nesting depth** (top-level under
`/databases/{db}/documents`), not by first textual match. And if **more than one** top-level
`users` block exists, **abort** — duplicate top-level blocks UNION, so the first block's guards
would be void, and that is precisely the HC-01 failure class.

The three constraints themselves are unchanged: `request.auth.uid != userId`, the `activeRole`
exclusion, and `noPrivilegeEscalation()`.

---

## 5. G3 certification criteria — the guard must FAIL these

Owner's list, plus what each needs to be a real test rather than a restatement:

| # | case | expected |
|---|---|---|
| 1 | current release lineage (`merchant-launch-rc` + candidate) | **PASS** |
| 2 | 80297d4-equivalent content, cherry-picked provenance | **PASS** |
| 3 | clause lacking `uid != userId` | **ABORT** |
| 4 | clause lacking the `activeRole` exclusion | **ABORT** |
| 5 | clause lacking scoped `isAdmin()` behaviour | **ABORT** |
| 6 | invariant text present but NOT introduced by any commit reachable from HEAD (hand-edited file) | **ABORT** — this is what stops D degrading into a text search |
| 7 | a second TOP-LEVEL `users` block added | **ABORT** — new, from §4 |
| 8 | a nested `users` block placed ABOVE the top-level one | **PASS**, and the guard must still read the top-level block — new, from §4 |
| 9 | `release/multishop-checkout-certified` | **ABORT** — it genuinely lacks two of three constraints; a guard that passed it would be broken |
| 10 | the combined candidate | **byte- and semantically unchanged** by G2 |

Case 9 is the useful control: a real branch that *should* fail. A guard proven only against
synthetic mutations has never met a genuine stale lineage.

---

## 6. Out of scope for G2

Changing `firestore.rules` · regenerating the candidate · deploying · touching
`release-firestore-rules.js` · repairing `release/multishop-checkout-certified` · broadening to
other `users/{userId}` behaviour.

**The multishop finding stays a separate record**: that branch lacks `uid != userId` and the
`activeRole` exclusion, and is not the deploy target. It must not be "fixed" to make a guard test
pass — it is case 9's fixture precisely because it is genuinely deficient.
