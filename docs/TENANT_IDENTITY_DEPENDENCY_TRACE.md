# `business-bootstrap.js` → `tenant-identity.js` — dependency/provenance trace

**Read-only. Nothing committed, deployed, reset, or cleaned to produce this. Tier 1 remains frozen.
R1 and production untouched.**
**Date:** 2026-09-04 · **Trigger:** `docs/UNTRACKED_FUNCTIONS_PROVENANCE_CENSUS.md` §5 flagged
`functions/business-bootstrap.js`'s committed `require('./tenant-identity')` as a fourth instance of
the order-claim.js pattern, structurally different (woven into real logic, not a bounded block) and
requiring its own targeted trace before any action.
**Related:** [[ORDER_CLAIM_PROVENANCE_TRACE]] · [[UNTRACKED_FUNCTIONS_PROVENANCE_CENSUS]]

---

## 0. Headline finding, ahead of the detail

This is not the same shape of problem as `order-claim.js`. `order-claim.js`'s callables
(`claimOrder`/`releaseOrderClaim`) were confirmed **not deployed** — neutralizing them regressed
nothing live. Here, the opposite: **the code path that uses `tenant-identity.js` is real,
currently deployed, and appears to be actively exercised by real merchants opening
`pos-setup.html` right now.** This looks less like "should Tier 1 admit unowned code" and more
like "production may already be running code that was never committed to this repository" — a
finding bigger than Tier 1's own scope, surfaced here because Tier 1's dependency-closure work is
what found it.

## 1. The chain, traced end to end

```
functions/index.js
  → const bootstrap = require('./business-bootstrap');     (line 12579)
      → only re-exports: bootstrapDevice, getIncrementalSync,
        invalidateBootstrapCache, getBusinessConfig, validateDeviceAccess
        (none of these touch tenant-identity.js)

functions/smartpos-dispatch.js
  → const bizBootstrap = require('./business-bootstrap');   (line 35)
  → const _H = _merge(..., bizBootstrap._h);                (line 58)
      → bizBootstrap._h.getSetupStatus        = _getSetupStatus       (USES tenant-identity.js)
      → bizBootstrap._h.savePaymentDestination = _savePaymentDestination (USES tenant-identity.js)
      → bizBootstrap._h.getPaymentDestination  = _getPaymentDestination  (USES tenant-identity.js)
  → exports.smartPosDispatch = onCall(...)                  ← ONE real, live Cloud Function
      routes on req.data.op to whichever _H[op] matches

Checked all 10 other modules merged into _H (pos-crm-pro, pos-completeness, pos-staff-ops,
pos-inventory-pro, pos-accounting, pos-retail-engine, pos-integrations, pos-hq, pos-multi-till,
pos-cash-manager): none defines getSetupStatus/savePaymentDestination/getPaymentDestination, so
none shadows business-bootstrap.js's versions (_merge()'s "first wins" rule never triggers here).
```

## 2. Is `smartPosDispatch` actually live? Yes.

`firebase functions:list` (checked directly): `smartPosDispatch │ v2 │ callable │ us-central1 │
512 │ nodejs22` — present, deployed.

## 3. Are the tenant-identity-dependent ops actually called by real client code?

Grepped every `.html`/`.js` file outside `functions/` for `op:'getSetupStatus'` /
`'savePaymentDestination'` / `'getPaymentDestination'` (both literal and the `SPOS('...')` /
`CF('...')` factory patterns this codebase uses).

**Split result, precise:**

| Operation | Real client caller | Reaches `tenant-identity.js`? |
|---|---|---|
| `getPaymentDestination` | `pos-setup.html` via `CF('getPaymentDestination')` — a **direct** top-level callable | **No.** `CF()` calls `exports.getPaymentDestination` from `functions/payment-destinations.js` directly, NOT through `smartPosDispatch`. That file's `getPaymentDestination`/`savePaymentDestination` use their own `_resolveScope(uid)` — grepped the whole file for `tenant-identity`/`resolveMerchantIdForOwner`: zero matches. |
| `savePaymentDestination` | same — `CF('savePaymentDestination')` | **No**, same reason. `business-bootstrap.js`'s own `_h.savePaymentDestination`/`_h.getPaymentDestination` are reachable in principle via `smartPosDispatch({op:'savePaymentDestination'})` but no client code was found calling them that way — they appear to be dead from the real UI's perspective. |
| `getSetupStatus` | `pos-setup.html` via `SPOS('getSetupStatus')` — routes through `smartPosDispatch` | **Yes, conditionally.** One call site (`renderSetupChecklist`, line 3758) always passes an explicit `merchantId`, which skips the resolver. **Two call sites do not** — the `_auth.onAuthStateChanged` handler that runs on every authenticated page load of `pos-setup.html` (lines 3900 and 3926, `SPOS('getSetupStatus')({})`, no `merchantId`) — deciding whether to send the merchant straight to POS or resume the setup wizard. **This path calls `resolveMerchantIdForOwner(uid)` on every session start.** |

## 4. What this means

`business-bootstrap.js`'s `_getSetupStatus` — the function actually reading
`resolveMerchantIdForOwner` from `tenant-identity.js` — is not dead code and not merely deployed-
but-dormant. It sits in a real, frequently-hit path: the auth-state handler that decides "go
straight to POS" vs. "resume setup wizard" for every merchant who opens `pos-setup.html` without
first navigating through a flow that already knows their `merchantId`. If this path is genuinely
working in production today (no reported outage), the necessary conclusion is that **the currently
deployed `smartPosDispatch` Cloud Function bundle already contains `tenant-identity.js`'s code** —
sourced from wherever it was when that function was last deployed, which was not from this
repository's committed git history, because `tenant-identity.js` has never been committed to
`release/multishop-checkout-certified`.

This reframes the risk. It is not "should Tier 1 import untested code to fix a load error." It is:
**production's live functions may already differ from what git says is deployable, in a path real
merchants hit on every session start** — independent of Tier 1 entirely.

## 5. The three questions, answered

**Is `tenant-identity.js` already canonical on R1?** The working copy is confirmed byte-identical
to R1's own committed version (`bc44f33`, "P15C — offline shift registration via the callable sync
route"). The file itself is a small, careful, fail-closed identity resolver
(`functions/tenant-identity.js`, 99 lines) with an unusually rigorous internal audit — it names
exactly which of 13 similar lookups elsewhere are and aren't safe, and explains why, rather than
asserting a blanket guarantee. It references its own census document,
`docs/TENANT_IDENTITY_CENSUS.md` — which **exists on disk but is itself untracked** (`??`, mtime
2026-09-01 11:35, 52 minutes before `tenant-identity.js`'s own 12:27), and does **not** exist on R1
either (`git show release/r1-pos-printer-fn:docs/TENANT_IDENTITY_CENSUS.md` → not found). So: the
*implementation* is R1-canonical; its own *spec* is not committed anywhere, including on R1.

That census doc itself names a blocker: `**Blocks:** [[EMPLOYEE_AUTHORITY_CONVERGENCE_DECISION]]`
— also untracked, same-minute mtime, headed **"DECISION ARTIFACT — no code changed... Status:
DECISION ARTIFACT"** and opening with *"the three systems do not agree on what a shop is"* — i.e.
whoever produced this census explicitly flagged that a human decision was needed before the
identity work should proceed, and `tenant-identity.js` was written roughly an hour later anyway,
already partially wired into a committed file (`business-bootstrap.js`). Whether that decision was
actually made (elsewhere, undocumented) or the implementation moved ahead of it is not something
this trace can determine from the repository alone.

**Is `business-bootstrap.js` itself an approved Tier 1 dependency?** No — none of Tier 1's four
approved features (SMS, Moderator, Employee, Platform Health) call into it. Its presence in the
require graph is purely structural: `functions/index.js` is one monolithic entry point for ~380
functions, so requiring it at all pulls in everything transitively, Tier 1-relevant or not — the
same mechanism that made `order-claim.js` "required" without being used.

**Can the three payment-destination functions operate without the identity dependency?** Two of
three, functionally, already do — from the real client's perspective, `getPaymentDestination` and
`savePaymentDestination` never reach `tenant-identity.js`, because the client calls the
`payment-destinations.js` versions instead. The third, `getSetupStatus`, cannot be assumed safe to
touch: it is live, it is hit on every `pos-setup.html` session start via the no-`merchantId` call
path, and its own internal comment history (the `posProducts` vs `products.shopId` catalogue fix
documented inline) shows this is actively maintained, not abandoned code.

## 6. Disposition, per your framework — not decided here

- **Canonical dependency** (provenance + ownership proven, admit and certify): the *code* clears
  the R1-provenance bar (byte-identical to a real committed R1 file). The *decision record* does
  not — the census and its blocking decision doc are both uncommitted, and the decision doc itself
  says a choice was still pending when it was written.
- **Foreign dependency** (valid elsewhere, outside Tier 1, isolate and remove): straightforward for
  `getPaymentDestination`/`savePaymentDestination` (confirmed unreached via this path). Not
  straightforward for `getSetupStatus` — "isolate and remove" from Tier 1's `business-bootstrap.js`
  would only affect Tier 1's own branch, not production's actually-running function, so it would
  not fix the live discrepancy this trace surfaced, and if Tier 1 ever deploys `smartPosDispatch`
  it would need its own answer for what `getSetupStatus` should do without the resolver.
- **Unresolved dependency** (leave Tier 1 frozen): consistent with everything found. Tier 1 does
  not need `getSetupStatus` for anything in its own scope, and the live-production question this
  trace surfaced is bigger than Tier 1 and better decided on its own terms, not folded into a
  reliability/admin release under time pressure.

No action taken. `functions/index.js` (Tier 1's copy) still does not load cleanly end-to-end.
`business-bootstrap.js` untouched. `tenant-identity.js` and `docs/TENANT_IDENTITY_CENSUS.md` /
`docs/EMPLOYEE_AUTHORITY_CONVERGENCE_DECISION.md` not added anywhere.
