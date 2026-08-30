# Release gate debt — measured 2026-08-30

The full gate **does not pass at the commit currently serving production**. This is a
pre-existing condition of the repository, established by running the gate at the live commit
itself rather than by inference.

Related: [[reference_release_gate_integrity]], [[project_merchant_shell_pos_integration]].

## The two runs

Both runs were clean measurements (`foreignBrowsersAtStart: 0`) and were run **sequentially** —
two gates on one machine corrupt each other's browser-suite verdicts.

| | baseline `0a3beb7` (LIVE) | corrected tree `e2bb14a` |
|---|---|---|
| exit | **1** | **1** |
| PASS | 214 | 217 |
| **FAIL (the only blocking verdict)** | **14** | **12** |
| QUARANTINE / STALE / ENV / TIMEOUT | 4 / 0 / 66 / 0 | 4 / 0 / 66 / 0 |

`test-inventory.js:460` is the entire exit condition:

```js
if (GATE && summary.fail > 0) process.exit(1);
```

`:75` states outright that **TIMEOUT is not a defect verdict**; ENV, QUARANTINE and STALE do not
gate either. Only FAIL blocks. Everything else is coverage context.

## The 12 suites that fail identically at both commits

Pre-existing debt. Not attributable to any current work.

```
test-cache-version-floor      test-merchant-order-share
test-cart-readers             test-merchant-products-2c-media
test-cart-universal           test-pos-financial-trace
test-home-logo-routing        test-role-authority
test-merchant-exit-contract   test-stories-rules
test-merchant-exit-runtime    test-subscription-consistency
```

## Newly introduced by the POS boot repair: NONE

The set difference is empty in that direction. This is meaningful rather than merely absent,
because **the same method caught a real regression from the same repair**: `test-pos-wizard-gate`
passes at `0a3beb7`, failed in the intermediate tree `beaa52d`, and was traced to the refactor
pinning text the refactor itself had replaced. A method that has never detected anything proves
nothing when it reports nothing; this one has.

## The two apparent "fixes" are NOT fixes — do not record them as such

| suite | reality |
|---|---|
| `test-deploy-rollback-guard` | **RIG ARTIFACT.** Fails 3/3 at baseline, passes 3/3 in the current tree, so the difference reproduces — but the failing assertion is `tree is at the live commit (0a3beb7) — allowing`. It fails *because the control worktree was created at exactly the live commit*. A property of the measurement, not of the code. |
| `test-merchant-home-back` | **VARIANCE.** Passes 3/3 standalone in BOTH trees; failed only inside the baseline's concurrent gate run. |

The honest comparable baseline is therefore **13**, of which 12 are shared with the current tree.

**A lower FAIL count is not success.** The intermediate tree scored 13 against the baseline's 14
*while containing a genuine regression* — it was numerically ahead only because two unstable
suites happened not to fire in that run. Failure **identity** and **reproducibility** decide this,
never the count.

## How this debt survived unnoticed

`npm run deploy:hosting` runs **no npm audit chain**: npm fires `pre<name>` only for the script of
that exact name, `predeploy` exists and `predeploy:hosting` does not. Only `firebase.json`'s own
hosting `predeploy` always runs. Two standing refusals had therefore never been executed against a
release:

* `saSidebarCollapsed` unclassified in the admin localStorage ratchet since `8f99418`
* two production indexes untracked in source, so an index deploy would have **pruned** them

Both are now resolved without raising any baseline: the key was classified as the UI preference it
is (ratchet unchanged at 45), and the indexes were adopted via the tool's own `--sync`, which never
modifies production.

## The gate contaminates its own evidence

In `firebase.json`, hosting `predeploy` runs in this order:

```
bump-sw-version -> generate-version -> ... -> gate-inventory
```

The version bump **dirties the tree before the gate reads it**, and ~9 suites carry scope guards
that read `git diff --name-only HEAD`. So every gate artifact produced during a deploy describes a
tree that already differs from the commit it names. `docs/release-gates/beaa52d.json` was such an
artifact and was removed from `docs/` rather than left standing as an apparent release record.

## Status

Release remains **BLOCKED** — legitimately, by 12 pre-existing failures. No bypass, no
`--update-baseline`, no override. The POS boot repair (`31589a6` + `e2bb14a`) is certified by its
own suite (38/0, four mutants killed) and is **not implicated by this gate**, but it stays
**unreleased**, and POS stays **NOT GREEN** until a handset survives physical acceptance.
