# B3 — Clean push / provenance gate

> # 🔴 **B3 = BLOCKED**
>
> A clean **push** path exists and is certified below. A clean **deploy** path does **not**.
>
> The RC lineage diverged from production on 2026-08-13. Production carries **576 commits the
> RC does not have**. A hosting deploy from this tree would drop all 576 **and** publish 65
> uncommitted files — and the rollback guard **allows it** (verified, exit 0).

**Date:** 2026-09-10
**Subject tree:** `release/multishop-checkout-certified` @ `c6a1e68` (primary worktree)
**Live production:** `d592d8f` — confirmed live by the guard's own fetch of production `version.json`
**Mode:** read-only provenance gate. Nothing pushed, nothing deployed, nothing staged.

Related: [[B1_PRODUCTION_ONLY_FUNCTIONS_DISPOSITION]] · [[RELEASE_GO_NOGO_de79337]]

---

## 1. Push and deploy are different operations — the distinction carries this gate

This is the single most important finding, because the risk everyone is guarding against
attaches to only one of the two.

| | What travels | Do the 238 dirty entries travel? |
|---|---|---|
| **`git push`** | Commits reachable from the branch ref | **No.** Uncommitted work is not in any commit |
| **`firebase deploy --only hosting`** | The **working tree** — `firebase.json` sets `"public": "."` | **Yes.** 65 of them (§3) |

So "don't push the shared dirty worktree" is the right instinct aimed at the wrong verb: a
**push** from this tree is inherently clean. A **deploy** from it is not, and that is where the
contamination actually occurs.

---

## 2. Push scope — certified clean

* `release/multishop-checkout-certified` **does not exist on origin.** Live remote has 21 heads
  and **zero** `release/*` branches.
* **208 commits** are reachable from `c6a1e68` and from no origin ref, spanning
  **2026-08-15 → 2026-09-09**.
* Staged content: **0**. Nothing is queued that could sweep another workstream's work into a commit.

> ### ⚠️ Two probe corrections made during this gate
>
> **`git log --oneline --not --remotes=origin | wc -l` returned `0`** — and that zero was
> **vacuous**. With only a negative revision given, git adds no default `HEAD`, so the walk had
> no positive tip and visited nothing. Exit code 0, output empty, conclusion wrong. The correct
> form names the tip explicitly: `git rev-list --count HEAD --not --remotes='origin/*'` → **208**.
>
> **The first hosting-scope probe reported 238 of 238 ignored.** count == total is the alarm, not
> the answer. The bug: the glob `**/.*` was translated to `^.*\.[^/]*$`, which matches any
> filename containing a dot — i.e. nearly every file. The probe was rewritten with a **self-test**
> that asserts four known-published paths and five known-ignored paths before it will report
> anything, and it now refuses to print a result if that self-test fails.

---

## 3. Deploy scope — NOT clean. 65 files would be published.

`firebase.json` → `hosting.public = "."`, so a hosting deploy publishes the repo root **as it
sits on disk**. Applying the real `hosting.ignore` list to the 238 dirty entries:

| | Count |
|---|---|
| Dirty entries total | 238 (88 modified, 150 untracked) |
| Ignored by `hosting.ignore` | 173 |
| **Would be published to production** | **65** (53 modified, 12 untracked) |

`docs/**`, `scripts/**`, `functions/**` and `**/*.md` are ignored, so documentation and Cloud
Functions sources do **not** reach hosting. What does reach it includes the core customer
surface — `index.html`, `pos.js`, `seller.js`, `auth.js`, `script.js`, `service-worker.js`,
`version.json` — and, notably, **`_sign-harness.html`**, a test harness that would go live, plus
the stray artifact `functions_index.js.rails.json`.

---

## 4. Lineage — the RC does not contain production

```
                        3dcf572  (2026-08-13, merge base)
                       /        \
        576 commits  ↙            ↘  208 commits
                    /              \
        d592d8f  ●  LIVE            ●  c6a1e68  RC tip
        (2026-09-02)                   (2026-09-09)
```

* `git merge-base --is-ancestor d592d8f c6a1e68` → **false.** The RC does **not** contain production.
* `git rev-list --left-right --count d592d8f...c6a1e68` → **576 / 208**.

**576 commits of shipped production work are absent from the RC.** Deploying `c6a1e68` to
hosting would remove all of them from live. This is not a theoretical risk — it is the exact
failure mode `CLAUDE.md` records as having repeatedly reverted the earn page.

### 4.1 The rollback guard does not stop this — verified, not assumed

```
$ node scripts/deploy/guard-no-rollback.js
  [rollback-guard] local c6a1e68 is not behind live d592d8f — allowing deploy.
  exit code: 0        ← deploy ALLOWED
```

The guard is honest about its own rule, in its header: abort only when *"HEAD is an ANCESTOR of
live"*; **"otherwise (ahead / diverged / live commit unknown here) → allowed."** Our tree is
**diverged**, not behind, so `--is-ancestor` is false and the guard passes it.

The guard was built for the *stale-worktree* case and closes it correctly. It is blind to the
*divergent-lineage* case, which is the case we are actually in. This is live empirical
confirmation of the concern already recorded as SLICE 2 in [[RELEASE_GO_NOGO_de79337]] —
ancestry-based protection cannot, on its own, refuse an unreviewed divergent lineage.

---

## 5. Functions side — better protected, and one live hazard

**The closure gate passes, and reads the right subject:**

```
FUNCTIONS REQUIRE-CLOSURE GATE
  ref               : HEAD   (git tree, NOT the filesystem)
  modules reachable : 336
  unresolved        : NONE
  PASS — the deploy entrypoint graph closes from a clean checkout of HEAD.
```

Because it reads the **git tree** rather than the filesystem, it is immune to the working tree's
mess *and* it would correctly fail a partial commit of the hazard below.

**The hazard — another workstream's in-flight POS commission rail:**

`functions/index.js` carries **18 uncommitted lines** adding an unguarded top-level
`require('./pos-commission-surface')` and three new exports — `posGateStatus`,
`posSettleCommission`, `posCommissionReminder`. Every module that chain needs is **untracked**:

| Module | State |
|---|---|
| `functions/pos-commission-surface.js` | untracked (on disk, not in HEAD) |
| `functions/pos-commission-rail.js` | untracked |
| `functions/money-authority.js` | untracked |
| `functions/pos-sale-commission.js` | untracked |
| `functions/commission-settlement-authority.js` | untracked |

Committing `functions/index.js` **without** those five would put an unresolvable `require` at the
top level of the deploy entrypoint — every function fails to load, not just commission. The
closure gate catches exactly this, which is why it must never be bypassed while this work is in
flight. **Untouched by this gate:** it is commission code and another workstream's, on both counts
out of bounds.

---

## 6. Correction: there are not seven dirty files

The brief for this slice referred to *"the seven dirty files belonging to the other workstream."*
**No such set of seven could be reproduced.** The measured state is **238 dirty entries** — 88
modified, 150 untracked — spread across many workstreams. The nearest plausible seven is the
commission rail in §5 (five untracked modules + `functions/index.js` + `sokoni-commission-rates.js`),
but that is a reconstruction, not a measurement, and the commission workstream's dirty footprint
is in fact larger than seven.

Rather than guess at which seven were meant, this gate applied the **strictly more conservative**
rule: **touch nothing dirty except the two files this slice authored** — `CHANGELOG.md` (pure
prepend) and its own documents.

---

## 7. What would make B3 pass

1. **Reconcile the lineage.** 576 production commits must be brought into the RC, or the RC
   abandoned in favour of a branch that already contains them. This is SLICE 1 in
   [[RELEASE_GO_NOGO_de79337]] — 173 conflicted paths, its own authorized slice, in a dedicated
   worktree. **Not authorized, not attempted here.**
2. **Close the guard's divergence blindness** (SLICE 2), so a divergent lineage cannot deploy
   unreviewed. Note the design constraint already on record: a naive ancestry test would have
   failed the cherry-picked convergences it was meant to protect.
3. **Deploy from a clean tree only.** A deploy must run from a worktree with zero dirty entries,
   never from the shared primary tree, or 65 uncommitted files ride along.

## 8. What was done, and not done

* ✅ Read-only measurement, plus two self-corrected probes (§2).
* ✅ Ran three existing gates read-only: closure gate (PASS), rollback guard (ALLOW — the finding),
  and confirmed `guard-functions-safety.js` is **absent** from this candidate, as previously recorded.
* ❌ **No push. No deploy. No staging.** Nothing added to the index.
* ❌ No dirty file touched except this slice's own (§6). Commission, payment, wallet/ledger and
  Loyalty code all untouched.
* ❌ Lineage reconciliation not attempted.
