# PROVENANCE GAP — merchant-identity

**Status:** OPEN — blocks any Functions deployment from `feat/integrations-control-center`
**Severity:** DEPLOYMENT SAFETY (not estate cleanup)
**Raised:** 2026-09-21, by Phase 3 of the Functions restructuring
**Detector:** `scripts/function-registration-provenance.js` (read-only)

Related: [[RELEASE_STATE]] · [[GCP_COST_ARCHITECTURE_IMPLEMENTATION]]

---

## The finding

`functions/merchant-identity.js` defines two callables that are **live in production**:

- `employeeSaleAuthorize`
- `adminLinkMerchantAccounts`

Neither is registered by this branch's `functions/index.js`.

## The module is not unreachable — only the callables are unregistered

This is not dead code. `functions/pos-zero-friction.js:15` does:

```js
const { resolveActor } = require('./merchant-identity')._internal;
```

So the file **ships** with a deploy and its `_internal.resolveActor` executes. What is missing is
a registration path for the two callables. The distinction matters: the repair is not "make the
module reachable".

## A basename collision hides it

`index.js` line 23 requires a **different** module with the same basename:

```js
const _merchantIdentity = require("./shared/merchant-identity"); /* STK narrative */
```

`functions/shared/merchant-identity.js` and `functions/merchant-identity.js` are separate files
with separate export surfaces. Reading `index.js` alone, the root module looks wired in. It is not.

## It is not a regression on this line

| Question | Answer |
|---|---|
| Registering commit | `f194c02` — *feat(identity): merchant identity + employee sale authority* |
| Is `f194c02` an ancestor of HEAD? | **No** |
| Commits on this branch touching the registration | **None** |
| Branches containing `f194c02` | **98** |

This branch never had the registration. It is lineage divergence, not a lost edit — the same root
cause as the 24 other cross-lineage names in the Phase 3 join, distinguished only by the source
module also being present here.

## Why there is no casual fix

The deployed estate is a **union of deploys from several lineages**, and no single branch's
`index.js` explains it:

| Lineage | Registers `employeeSaleAuthorize`? |
|---|---|
| `feat/integrations-control-center` (here) | no |
| `release/multishop-checkout-certified` | **no** |
| `release/multishop-on-e52fdc5` | **yes** |

The function is live, yet the lineage recorded as production's functions source does not register
it. Adding the export to this branch would therefore **invent a composition no lineage has**, and
would do so in the one file that decides what a deploy ships.

**This needs a lineage decision by the owner, not an edit.**

## Consequence

`firebase deploy --only functions` deletes what the deploy does not contain. A functions deploy
from this worktree omits both callables, so it would **remove two live production callables**.

This is an independent reason the GCP evidence reader cannot be deployed from this worktree, on
top of the foreign-file ownership blocker already recorded.

## What would resolve it

Not a code change in isolation. In order:

1. Establish which lineage production's `merchant-identity` callables were deployed from.
2. Decide whether this branch is intended to carry them at all.
3. If yes, take the registration through a merge from the owning lineage — not a hand-written
   `exports.X =` line composed here.
4. Re-run `node scripts/function-registration-provenance.js` and confirm the open-question count
   drops to zero.

## Do not

- Do not add `exports.employeeSaleAuthorize` / `exports.adminLinkMerchantAccounts` to this
  branch's `index.js` to make the detector green. That is fixing the gauge.
- Do not delete `functions/merchant-identity.js` as an unused module. It is required by
  `pos-zero-friction.js`, and both callables are live.
- Do not treat the 24 cross-lineage names as related work. They have no source module here; this
  one does, which is why it is a deployment hazard and they are not.
