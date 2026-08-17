# Business Hub mode-scoping — OPEN defect

**Status:** OPEN — confirmed by code trace, deliberately not fixed
**Raised:** 2026-08-17, during local verification of the undeployed `rc/combined` tip
**Branch:** `rc/combined` @ `d4622b0` (undeployed; live is `5b0b8de` / v525)
**Prerequisite:** CLOSED — see [[#The prerequisite that had to land first]]
**Related:** [[ROLE_AUTHORITY]] · [[NAVIGATION_CONTRACT]] · [[RELEASE_STATE]]

---

## The requirement

Switching the acting role from **Seller → Buyer** must remove the Business Hub from
`profile.html`. Acting as a buyer should not present merchant operations.

## Current behaviour

It does not. The hub stays on screen, for **two independent reasons** — neither of which is a
regression from `6a803c9` / `e927360` / `d4622b0`.

### 1. The predicate is possession, not mode

`_renderBusinessHub()` (`profile.html`) gates every module on `_isSellerUser(u)` /
`_isProviderUser(u)`, which resolve through `_hasRole(role, u)` →
`SokoniRoleAuthority.isApproved(role)`.

`isApproved()` reads `_approved`, the set derived from signed claims. `setActiveRole()` writes
`users/{uid}.activeRole` and `_activeRole` and **never touches `_approved`**. So after switching
to Buyer, `isApproved('seller')` is still `true`, and the Marketplace / Finance / Insights
modules plus the `upIdBusiness` identity link all still render.

The current design intent is explicit in the source: the hub *"renders ONLY the modules the user
can access, and a seller+provider sees BOTH (no exclusive roles)"* — an **identity** surface,
not an acting-mode surface.

### 2. It is not re-run on a switch

`switchRole()` calls `renderRoleSwitcher()` and dispatches `sokoniRoleChanged`, but never
`renderHeaderCard()` — and **nothing in `profile.html` listens for `sokoniRoleChanged`**. The
only re-render path is `_repaintOnRoleAuthority()`, which fires once when claims land. So even
with the predicate corrected, the hub would only update on a full reload.

### What `e927360` actually fixed

Narrower than the requirement implies, and real: the header's `_skSwitchRole` now defers to
`RA.setActiveRole()` and mirrors locally only on `{ok:true}`, so the header and the authority no
longer disagree about the acting role. It does not make the hub mode-scoped, because approval is
not what a switch changes.

---

## The prerequisite that had to land first

Gating the hub on `RA.getActiveRole()` **while the acting role did not survive a page load**
would have hidden the Business Hub from every seller on every load — reintroducing exactly the
silent-vanishing regression `6a803c9` had just closed.

`_activeRole` initialised to `BASELINE` on every module load and nothing read back the persisted
value, so `getActiveRole()` returned `buyer` on every fresh load. That is now fixed
(`_restoreActiveRole()`, role-authority **148/0**, negative control verified) and is a hard
dependency of any fix below.

---

## Fix specification

1. **Add an acting-role predicate** — approved **and** active — and gate the operational modules
   in `_renderBusinessHub()` on it. Keep `isApproved` as the possession test; do not overload it.
2. **Keep `upAnalyticsCard` ("Your SOKONI identities") identity-scoped.** It is the honest
   statement of what the account holds, and with the role switcher it is the way back. Scoping it
   to mode would strand a buyer-acting seller with no visible route to their own workspace.
3. **Leave `admin` unscoped.** RA deliberately excludes `admin` from workspace roles
   (`isApproved('admin')` is always false; `sokoni-permissions.js` is the RBAC authority), so
   acting-mode has no meaning for it. `rider` / `provider` are workspace roles and scope normally.
4. **Move `_syncMyStoreBtn()` and `_syncMyServicesBtn()` with it.** The source already records
   that an inline copy of the seller test was *"a fifth decision site"* which let two buttons in
   one header disagree. Leaving them on possession recreates that split.
5. **Add the missing re-render.** Listen for `sokoniRoleChanged` / `sokoniActiveRoleChanged` →
   `renderHeaderCard()`, echo-guarded in the manner of `e927360`'s existing bridge.

### Blast radius

Contained. `isApproved()` is consumed only by `profile.html` (and RA itself); `getActiveRole()`
is read at `profile.html:3809` and `shared-header.js:1802`.

### Consequence requiring sign-off

A seller acting as Buyer **loses** the Marketplace / Finance / Insights modules until they switch
back. That is the requirement as stated, but it changes a shipped surface's behaviour for every
multi-role account — an RC-freeze decision under [[RC_CHANGE_POLICY]], which is why this is
recorded rather than implemented.

---

## Verification notes

Two traps that will otherwise produce a false result:

- **Account choice.** `ogutualex824@gmail.com` (`uwpD5gx3…`) owns no shop and holds no seller
  claim; the KASS SHOP and the granted claim belong to `alexochieng3030@gmail.com` (`D5Ql2…`).
  Running the seller half of the lifecycle on the former shows a hidden Business Hub and **passes
  for the wrong reason**. Seller steps must run as `D5Ql2…`.
- **Build under test.** Live is `5b0b8de` / v525 and is *behind* these commits. Testing against
  production validates the old runtime, not `rc/combined`. Serve the `rc/combined` worktree
  locally and assert a code marker — `version.json` in that tree is deploy residue and still
  reads `5b0b8de`.
