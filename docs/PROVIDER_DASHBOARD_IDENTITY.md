# Provider Dashboard — shared identity widget reuse (Part 7)

**Status:** 🟢 **TRACED · IMPLEMENTED · CERTIFIED (pure core, already 18/18 from Part 5 +
served-page browser check with live interaction). COMMITTED · STACKED. NOT ON R1 · NOT
DEPLOYED.** Part 7 of "Till Approval Automation + Unified Dashboard Profile" — the last part of
this workstream. Production remains `d592d8f`/v632, untouched.
**Date:** 2026-09-04

---

## The point of this slice: zero new component code

`provider-dashboard.html` now loads the **exact same two files** Merchant V2's header uses —
`sokoni-dashboard-profile.js` and `sokoni-dashboard-profile-core.js` — unmodified, byte-for-byte.
No provider-specific fork, no second `mount()` implementation. This is the concrete proof of the
"one shared role/profile component" requirement: the only thing this slice writes is a
**host-specific config**, exactly the shape the component was designed for from the start.

## Trace — this page's actual layout, not assumed

`provider-dashboard.html` has `data-no-header="true"` (its own sidebar chrome, not the top-bar
`shared-header.js` injects elsewhere) and previously had **no profile/avatar identity control at
all** — only a non-interactive sidebar block (`.sb-provider`: avatar/name/plan text) and a
**third, separate, hardcoded sign-out implementation** (`onclick="firebase.auth().signOut()..."`),
bypassing the canonical `sokoniSignOut()` exactly like Merchant V2's `doSignOut()` did before
Part 5 fixed it. Both gaps are closed the same way here.

## Wiring — mounted where this page's own layout actually puts identity controls

The old sidebar sign-out `<button>` is replaced with `<div id="dash-identity">`, mounted from a
new `_mountDashIdentity(profile, user)` — called once, from inside `loadDashboard(user)` (the
page's own existing bootstrap, which only runs after a real session and a successful backend
fetch). Config:

```
displayName:       profile.name || user.displayName || 'Provider'
currentRoleLabel:   'Service Provider'
profileHref:        '/profile.html'
accountSettingsHref: '/account-centre.html'
availableRoles:      []   -- same reasoning as Part 5: no multi-role account surface to
                             switch between yet; an empty list is what makes the shared
                             component skip its role section entirely, not invent one
signOut:             canonical window.sokoniSignOut(), with a fallback only if unavailable
```

**No `getWorkspaces` supplied, deliberately.** A provider account has no shops-workspace concept
anywhere in this codebase (confirmed by the same Part 4 trace that scoped `getMyShopWorkspaces` to
the `shops`/`shopEmployees` space) — omitting the field is exactly what the shared component was
built for: the shop-switcher trigger simply does not render. This is the literal, working proof of
"without creating a second identity system" — there is no provider-side workspace list invented
to fill the gap.

## Certification

**Pure core:** already certified in Part 5 — `scripts/test-dashboard-profile-core.js`, 18/18. This
slice adds no new logic to `sokoni-dashboard-profile-core.js` or `.js`; reusing an already-certified
component is the point, not a reason to re-certify it under a new name.

**Served-page browser check**, this time with a real methodology finding worth recording: a direct
navigation never reaches a mountable state locally — an inline `DOMContentLoaded` listener already
in this page (`firebase.auth().onAuthStateChanged` → redirect to `login.html` when signed out,
independent of and in addition to `auth-guard.js`'s own redirect) tears the DOM down before any
check can run, with no live backend to prevent it. The check seeded a fake authenticated session
(`localStorage`/a stubbed `onAuthStateChanged`, test harness only, no production code touched) to
actually exercise the mount — confirmed:
- Both scripts 200/`application/javascript` via the browser's network log, real byte counts (2790
  / 11868 bytes — not empty stubs).
- `window.SokoniDashboardProfileCore`/`SokoniDashboardProfile` load with exactly their known API
  surface, no collision with anything else this page defines.
- **The old insecure sign-out is verifiably gone**: every `onclick` attribute on the page was
  scanned; zero matches for `firebase.auth().signOut()` in any executable path (the string
  appears exactly once, inside this slice's own code comment documenting the fix).
- The widget mounted against the real `#dash-identity` element and was clicked: the profile popup
  opened showing "Test Provider", Profile/Account Settings links, and Sign Out — **with no
  shop-switcher trigger present**, confirmed correct rather than a bug.
- Sidebar nav (all 9 items), the "+ Add Another Role" link, and overall layout confirmed unaffected
  by a screenshot.

## What this slice does NOT do

Does not modify `sokoni-dashboard-profile.js` or `sokoni-dashboard-profile-core.js` — reused
exactly as Part 5 built them. Does not invent a provider-side "workspace" concept. Does not touch
`sokoni-provider.js`, the booking/service surfaces, or anything else on this page beyond the
sidebar footer and `loadDashboard()`'s one new call. Not deployed. Does not touch
`C:/temp/sok-r1`.

---

## Workstream closed: "Till Approval Automation + Unified Dashboard Profile"

All 8 parts traced, implemented, certified, documented, and committed on the evidence branch:

| Part | What | Commit |
|---|---|---|
| 1 | Till Approval Automation (auto-issue on merchant approval) | `c3b8de9` |
| 2 | Till & QR surface in Merchant V2 | `1ebc58e` |
| 3 | `merchantIdentity` — the missing dependency | `230643a` |
| 4 | `getMyShopWorkspaces` — Switch Shop resolver | `622d55a` |
| 5 | Merchant V2 header — shop switcher + profile dropdown | `acfd437` |
| 8 | KASS Shop Till backfill (dry-run verified) | `7b49e34` |
| 6 | Login — Choose Shop | `ef62142` |
| 7 | Provider Dashboard — shared identity widget reuse | *this commit* |

R1 (`8fc3673`) confirmed untouched throughout every single commit. Production `d592d8f`/v632
unchanged. Ready for the final R1 reconciliation pass.

## Related

`docs/MERCHANT_V2_HEADER_IDENTITY.md` (Part 5, the component this slice reuses unmodified) ·
`sokoni-dashboard-profile.js`, `sokoni-dashboard-profile-core.js` (unchanged) ·
`provider-dashboard.html` (`_mountDashIdentity`, sidebar markup, script tags)
