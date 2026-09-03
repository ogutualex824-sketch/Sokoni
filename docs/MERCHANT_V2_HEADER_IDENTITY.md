# Merchant V2 header — shop switcher + profile dropdown (Part 5)

**Status:** 🟢 **TRACED · DESIGNED · IMPLEMENTED · CERTIFIED (pure core + served-page browser
check, both live-interaction-tested). COMMITTED · STACKED. NOT ON R1 · NOT DEPLOYED.** Part 5 of
"Till Approval Automation + Unified Dashboard Profile." Production remains `d592d8f`/v632,
untouched.
**Date:** 2026-09-04

---

## Design — one shared component, two hosts (Part 5 builds it, Part 7 reuses it)

`sokoni-dashboard-profile.js` (`window.SokoniDashboardProfile.mount(host, config)`) +
`sokoni-dashboard-profile-core.js` (pure decision logic, `window.SokoniDashboardProfileCore`) —
the exact `sokoni-pay-q-core.js` (Q8) split: DOM glue in one file, the one safety-relevant
decision in a dependency-free file certifiable with Node. Built generic from the start (`config`
carries `displayName`, `currentRoleLabel`, `getWorkspaces`, `onSwitchWorkspace`, `availableRoles`,
`onSwitchRole`, `signOut`, ...) so Part 7 (Provider Dashboard) mounts the identical file, not a
second implementation — a host with no workspace concept simply omits `getWorkspaces` and the
switcher trigger doesn't render, never a stub pretending to work.

**The one safety-relevant decision, pure and certified:** `shouldSwitchWorkspace(w)` — a
workspace item can only ever trigger a switch when the SERVER marked it active (`isActive !==
false`) and it isn't already the current one. The widget never re-derives "is this shop valid"
itself; `getMyShopWorkspaces` (Part 4) is the only input, and this function only guards the
click-handler from acting on a stale/disabled/redundant entry.

## Wiring into `merchant-v2.html`

- New header mount point: `<div id="dash-identity">` inside the existing `.hdr-actions`.
- Two new `<script src>` tags, loaded before `sokoni-merchant-till.js`.
- `paintStatus()` (the shell's own, existing session-paint function) now also calls
  `_paintDashIdentity()` — mounts once, refreshes on every subsequent call. Config fields are
  mutated **in place** on a single persistent object (not replaced each paint) — `mount()`'s
  closure captures that exact reference, so a later `refresh()` sees live data without re-mounting
  or losing popup state.
- `getWorkspaces` calls the real `getMyShopWorkspaces` callable (Part 4) and maps its
  `{shopId, shopName, isActive}` shape to the widget's own `{id, name, isActive}`.
- `onSwitchWorkspace(shopId)` persists the choice to `localStorage.sokoniActiveShopId`, then
  **reloads the page** — deliberate, not a shortcut: this shell mounts a dozen modules that each
  assume one shop for their whole lifetime (`_mounted{}` cache, device state, etc.); a full reload
  is the only way to guarantee none of them still hold the previous shop's data.
- `resolveShop()`'s own discovery step (its "STEP 1" — traced in Part 3's doc) now checks
  `localStorage.sokoniActiveShopId` **first**, before the existing owner/employee reads — but only
  as a **hint about which shop to ask about**, exactly the same non-authoritative role every other
  discovery read there already has (the file's own comment states this explicitly, reused
  verbatim). `merchantIdentity`'s server-side `resolveShopAccess` (Part 3, unmodified) still
  refuses it outright if the account isn't actually authorised — an attacker editing localStorage
  gains nothing. If the server refuses a Switch Shop choice, the stale value is cleared so the
  page doesn't retry the same refused shop forever.

## A real, pre-existing session-teardown bug found and fixed while wiring sign-out

`doSignOut()` previously called `auth.signOut()` directly — bypassing the canonical
`window.sokoniSignOut()` (from `firebase.js`), which tears down Firestore listeners, wipes every
non-infra `localStorage`/`sessionStorage` key, and purges Firestore's IndexedDB persistence. Not
introduced by this slice, but directly relevant to what it builds (a new sign-out entry point) —
fixed rather than perpetuated, with a fallback to the old direct call only if the canonical
function is somehow unavailable. Also now explicitly clears `sokoniActiveShopId` on sign-out — a
real cross-account leak this fix closes on its own: without it, signing out and back in as a
**different** account would silently retain the previous account's shop choice.

## Certification

**Pure core:** `scripts/test-dashboard-profile-core.js` — **18/18** (`shouldSwitchWorkspace`,
`workspaceItemState`, `markCurrent`), negative control, sabotage control (removing the
inactive-workspace check was proven to wrongly allow switching onto a disabled shop; the real
module was proven, side by side, to still refuse it).

**Served-page browser check** (`merchant-v2.html`, local static server, no live backend) — this
time exercising real interaction, not just load/parse:
- Both new scripts confirmed 200 with `application/javascript` content-type via the browser's own
  network log (not just `curl`) — the exact class of failure Q8's check caught, re-verified absent
  here.
- Zero page errors traceable to the new code (58 pre-existing, unrelated 404s for other
  `merchant-v2.html` module scripts genuinely missing from this local checkout — the same,
  already-noted-in-Part-2 gap, unrelated to this slice).
- The widget was mounted directly (real session never resolves without live Firebase, exactly as
  expected — `#dash-identity` stays empty, `S.state` never reaches `'in'`) and **actually clicked**:
  the shop-switcher popup opened showing one enabled and one correctly-disabled (`Disabled` badge)
  entry, matching `workspaceItemState`'s contract; the profile popup opened showing the display
  name and a working "Sign Out" control.
- Header chrome and the rest of the shell confirmed unaffected — no layout breakage, all four
  `.hdr-actions` children present.

## What this slice does NOT do

Does not implement Switch Role's server-side authority (deliberately empty `availableRoles` for
now — this shell has no multi-role account surface to switch between yet; adding one would be
inventing a second role system, exactly what was ruled out). Does not touch Provider Dashboard
(Part 7, next, reuses this exact component). Does not touch the login flow (Part 6). Does not fix
the pre-existing, unrelated missing-script 404s noted in Part 2 and re-confirmed here. Not
deployed. Does not touch `C:/temp/sok-r1`.

## Related

`docs/SWITCH_SHOP_WORKSPACES.md` (Part 4, the resolver this widget's shop switcher calls) ·
`docs/TILL_MERCHANT_V2_SURFACE.md` (Part 2, the module-adapter pattern this reuses) ·
`sokoni-dashboard-profile.js`, `sokoni-dashboard-profile-core.js` (new, shared — Part 7 reuses
these files unmodified) · `merchant-v2.html` (`_paintDashIdentity`, `resolveShop()`'s
`switchChoice` hint, `doSignOut()`'s sign-out fix) · `scripts/test-dashboard-profile-core.js`
(certification, 18/18)
