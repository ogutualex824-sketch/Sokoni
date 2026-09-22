# PROVENANCE GAP — merchant-identity

**Status:** **RESOLVED ON THE RELEASE LINEAGE, 2026-09-22** — still OPEN on
`feat/integrations-control-center`, and correctly so. See *Resolution* at the end.
The blocker is closed by PORTING ONTO THE LIVE LINEAGE, which is where the registration
already lives — not by any edit to this branch.
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

---

## Resolution — 2026-09-22

**The gap closes structurally, by the port. Nothing was edited to achieve it.**

The document's own prescription was:

> take the registration through a merge from the owning lineage — not a hand-written
> `exports.X =` line composed here.

The owning lineage turned out to be the one the release is already being built on.

### Step 1 — which lineage deployed production's callables

Measured, not assumed:

| Ref | Contains `f194c02` (the registering commit)? |
|---|---|
| `feat/integrations-control-center` (HEAD here) | **no** |
| `release/multishop-checkout-certified` | no |
| `release/multishop-on-e52fdc5` | yes |
| **`ship/catalogue-port-on-live` — THE LIVE LINEAGE, `111dbd7`** | **yes** |

The live hosting lineage carries the registering commit. This was the missing fact: the
original finding established that *some* lineage registered the callables, but not that the
**production lineage itself** did.

### Step 2 — verified in the release tree, not inferred

In `C:/temp/sok-commsport` (`release/comms-on-live`, clean at `111dbd7`):

```
functions/merchant-identity.js:205   exports.employeeSaleAuthorize    = onCall(...)
functions/merchant-identity.js:335   exports.adminLinkMerchantAccounts = onCall(...)
functions/index.js:11509             const merchantIdentity = require('./merchant-identity');
functions/index.js:11511             exports.employeeSaleAuthorize     = merchantIdentity.employeeSaleAuthorize;
functions/index.js:11512             exports.adminLinkMerchantAccounts = merchantIdentity.adminLinkMerchantAccounts;
```

Both callables are defined **and** registered, bound from the **root** module — not the
`shared/merchant-identity.js` twin whose basename collision hid the gap here. The release
tree does not even require the shared twin, so the collision does not exist there.

### Step 3 — the decision this needed

The document said *"this needs a lineage decision by the owner, not an edit"*. The decision
is made by the release strategy already agreed: **the release is built by porting
Communications onto `111dbd7`, not by deploying this branch.** The registration is
inherited by the release tree because it was already in the lineage. No composition is
invented, and no `exports.X =` line is hand-written anywhere.

### Step 4 — the regression

`scripts/test-merchant-identity-provenance.js` encodes the rule rather than the symptom:

> registration present **⇒** it was inherited, i.e. `f194c02` is an ancestor of HEAD.

A tree that registers the callables **without** carrying that commit has had the line
hand-written into it — the prohibited repair — and the gate fails on exactly that. It also
refuses a half-registration, which would deploy one live callable and delete the other.

Run in both trees, it passes for opposite reasons:

```
feat/integrations-control-center   15/0   STATE: does NOT carry the registration. Deployment blocked.
release/comms-on-live              17/0   STATE: CARRIES the registration (lineage-inherited).
```

The ancestry probe carries its own positive control (HEAD is an ancestor of HEAD; an unknown
commit is not), so section 3 cannot pass by being unable to tell.

### What is still true

- **An unfiltered `firebase deploy --only functions` from this branch remains unsafe** and the
  gate still says so. Nothing here relaxes that.
- `functions/merchant-identity.js` must still not be deleted as unused —
  `pos-zero-friction.js` requires it for `._internal.resolveActor`, asserted by the gate.
- The **24 other cross-lineage names** are untouched and remain out of scope.
- `scripts/function-registration-provenance.js` must still be re-run **on the ported tree**
  to confirm the open-question count reads zero there. That tree does not yet carry the
  detector or `scripts/infra/deployed-functions.txt`; both arrive with the port. Until that
  run, this resolution is evidenced at file level but **not yet confirmed by the original
  detector**.
