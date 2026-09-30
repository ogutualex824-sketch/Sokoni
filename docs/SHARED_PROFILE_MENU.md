# Shared Profile Menu (`sokoni-profile-menu.js`)

**Status:** built and statically certified 2026-09-30 on `59effdf`; browser certification QUEUED (browser hold); NOT deployed.
**Owner ask:** "in merchant dash there is no profile icon in header with the role drop down".

## What it is

The ONE avatar → account dropdown → role switcher control. It used to live inline in
`shared-header.js`, so every page that carries the marketplace header had it and the merchant
shell — [[MERCHANT_V2_TARGET_ARCHITECTURE|merchant-v2.html]], which deliberately replaces that
header with its own chrome — did not.

It is now a mountable module, `sokoni-profile-menu.js`, with a single implementation used by
both surfaces:

| Surface | How it gets the control |
|---|---|
| Every `shared-header.js` page (≈180) | The header injects `/sokoni-profile-menu.js` (idempotent bootstrap, same shape as the `sw-register.js` / role-authority bootstraps) and keeps only the avatar slot `.sk-acct-wrap > #sk-nav-avatar` in its nav. `index.html`'s static nav is unchanged. |
| `merchant-v2.html` | Loads `sokoni-permissions.js`, `sokoni-role-authority.js`, `sokoni-profile-menu.js` by tag and calls `SokoniProfileMenu.mount(document.getElementById('hdr-acct'), { size: 44 })` into the header's `.hdr-actions`. |

The popup markup moved **verbatim**; `scripts/test-merchant-profile-menu.js` holds `index.html`'s
dropdown DOM byte-identical (whitespace-normalised) to the `59effdf` tree.

## Authority — no second source of roles

* Workspace roles: `SokoniRoleAuthority.getApprovedRoles()` (signed token claims) once
  `isVerified()`; the `sokoniUser` localStorage mirror only while unverified.
* Acting role: `SokoniRoleAuthority.getActiveRole()`, mirror as first-paint stopgap.
* Administration entries: `SokoniPermissions.hasRole('admin' | 'superAdmin')`.
* Switching: `window._skSwitchRole(role)` → `RA.setActiveRole(role)` (persists
  `users/{uid}.activeRole`, server rule decides) → mirror → `RA.hubFor(role)` navigation.
  Refusals (`not-approved`, `not-verified`, `signed-out`, `rejected-by-server`) are surfaced and
  nothing switches.
* The legacy floating `sokoni-profile-switcher.js` (its DASH map sends `merchant` to `pos.html`)
  is a second switcher and is **not** loaded by the shell. See [[ROLE_AUTHORITY_AUDIT]].

## API

```js
SokoniProfileMenu.mount(hostEl, { size?: number, ariaLabel?: string })
  // -> { el, button, refresh(), destroy() } | null
  // Renders <div class="sk-acct-wrap" id="sk-acct-wrap"><button id="sk-nav-avatar" class="sk-pm-avatar"
  //   aria-haspopup="menu" aria-expanded="false"> into hostEl. A host that already contains
  //   #sk-acct-wrap (the shared header) is adopted. The control is a per-page singleton.
SokoniProfileMenu.open() / close() / toggle(event) / isOpen()
```

Globals the markup's `onclick` strings resolve to (defined here, once):
`window._skToggleAcct`, `_skCloseAcct`, `_skSwitchRole`, `_skEnterAdmin`,
`_skSignOutFromAcct`, `_skSwitchWorkspace`.

Repaints on `sokoniActiveRoleChanged`, `sokoniRoleChanged`, `sokoniRolesReady`,
`sokoniRoleAuthorityReady`, `sokoniAdminContextChanged`, `sokoniWorkspaceChanged`,
`sokoniAuthReady`. The `_SK_LS_KEEP` sign-out allow-list (mirror of `firebase.js`
`_SOKONI_LS_KEEP`, held byte-identical by `scripts/test-signout-keep-parity.js`) lives here now.

## Accessibility

Avatar is a `<button>` (44px target in the shell); `aria-expanded` mirrors state; Escape closes
and returns focus to the avatar; outside click closes; the menu is clamped inside the viewport.

## Certification

* Static (run): `test-merchant-routes` 65/0 · `test-mv2-1-sidebar` 14/0 · `test-inshell-chrome`
  30/0 · `test-customer-nav` 62/0 · `test-role-switch-routing` 50/0 · `test-signout-keep-parity`
  7/0 · `before-role-entry-coordination` 16/1/1 unproven (identical at the 59effdf baseline).
* Browser (QUEUED under the browser hold): `scripts/test-merchant-profile-menu.js`,
  `scripts/test-header-candidate.js` (must stay 11/0), `scripts/test-merchant-route-gate.js`.

Related: [[Authentication]] · [[MERCHANT_V2_TARGET_ARCHITECTURE]] · [[ROLE_AUTHORITY_AUDIT]] ·
[[ADMIN_ROLES]]
