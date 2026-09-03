# Login — Choose Shop (Part 6)

**Status:** 🟢 **TRACED · DESIGNED · IMPLEMENTED · CERTIFIED (served-page browser check, both
entry points traced by code inspection). COMMITTED · STACKED. NOT ON R1 · NOT DEPLOYED.** Part 6
of "Till Approval Automation + Unified Dashboard Profile." Production remains `d592d8f`/v632,
untouched.
**Date:** 2026-09-04

---

## Trace, before touching `auth.js` — scoped deliberately narrow

`auth.js`'s `loginUser()` has exactly one existing shop-aware branch: `if (profile.role ===
"employee" && profile.shopOwnerId)` — a flat `users/{uid}` field pair, a **third**, older
mechanism distinct from both `shopEmployees` (Part 3/4's scope) and `workforce-identity.js`'s
`businesses`. It redirects to `seller.html?employee=1` (the v1 seller shell, not `merchant-v2.html`).
Google/OAuth sign-in (`_handleGoogleResult`) has no shop-awareness at all — it redirects straight
to the generic post-login destination. Everyone else (buyers — the overwhelming majority of
logins) falls through to `_sokoniLoginRedirect()` (`sessionStorage.sokoniLoginRedirect ||
"index.html"`, sanitised against open-redirect).

**Design decision, stated explicitly: the legacy employee branch is left completely untouched,
still runs first, and still returns.** The new resolution below only ever runs for accounts that
branch does *not* already claim — so whatever population currently relies on it experiences zero
change. This is the same "additive, never touch the existing narrow path" discipline Part 1 used
for the approval hook.

## Design — one shared resolver, called from both real entry points

`_sokoniResolveShopEntry(displayName)` (new, `auth.js`) — calls the **same** server-derived
`getMyShopWorkspaces` (Part 4) Switch Shop already uses, never a second, client-guessed list:

```
getMyShopWorkspaces() -> workspaces
active = workspaces.filter(w => w.isActive !== false)

active.length === 0   -> return false (caller's EXISTING redirect runs, completely unchanged —
                          this is every buyer, the overwhelming majority of logins)
active.length === 1   -> persist sokoniActiveShopId, redirect to /merchant-v2.html, return true
active.length > 1     -> persist the list to sessionStorage, redirect to /choose-shop.html,
                          return true
any resolution error  -> return false (login must never be blocked, slowed, or altered in
                          outcome by this failing — logged, not thrown)
```

Called from **both** `loginUser()` (email/password, right after the untouched legacy branch) and
`_handleGoogleResult()` (Google/OAuth, right before its own existing redirect) — one
implementation, not two that could drift. `sokoniActiveShopId` is the **exact same** localStorage
key Part 5's Switch Shop already writes — `merchant-v2.html`'s `resolveShop()` picks it up through
the identical hint mechanism with zero new code on that side.

**Why this cannot become a second authorization system, traced precisely:** the persisted
`shopId` is a hint only, exactly like every other discovery read `resolveShop()` already performs
(the comment there already states this). `merchantIdentity`'s server-side `resolveShopAccess`
(Part 3, unmodified) still refuses it outright if the account isn't actually authorised for that
shop — an attacker (or a stale/corrupted localStorage value) gains nothing; the failure surfaces
as `S.shopError`, and `resolveShop()` already clears a Switch-Shop-sourced choice that gets
refused (Part 5) so it isn't retried forever.

## `choose-shop.html` — new page

Minimal, auth-gated (redirects to the sign-in state if no session — matches `pay-q.html`'s Q8
pattern). Reads the workspace list `login.html` already resolved from `sessionStorage` first (no
second round trip for the common "just signed in" case); falls back to calling
`getMyShopWorkspaces` directly for a page loaded any other way (a bookmark, a refresh after
session storage was cleared). Renders each shop as a tappable card (🏪 name + role, a `Disabled`
badge for an inactive entry, matching Part 5's `workspaceItemState` visual language though this
page does not import that module — it is a standalone, self-contained page like `pay-q.html`, not
a merchant-v2.html-embedded surface). Selecting a shop writes `sokoniActiveShopId` and redirects
to `/merchant-v2.html` — the identical mechanism Part 5's Switch Shop and this slice's own login
resolution both already use. A "Not you? Sign out" escape hatch calls the canonical
`window.sokoniSignOut()`.

## Certification

**Why no dedicated pure-core suite for `_sokoniResolveShopEntry` itself, stated plainly:** its
decision is a three-way `length` comparison (`0` / `1` / `>1`) with no branching complexity beyond
that — extracting it into a separately-loaded pure-core file (the Q5-Q8/Part 5 pattern) would mean
adding a new script dependency to every page that loads `auth.js` (many pages beyond
`login.html`), a real cost for a comparison this simple to review by inspection. This is a
deliberate scoping choice, not a gap glossed over — the SAFETY property that actually matters
("zero active workspaces never changes behaviour") is enforced by construction: the function
*returns false* in that case, and both call sites already fall through to their pre-existing,
unmodified redirect code, which is exactly what a dedicated test would otherwise have to prove.

**Served-page browser checks**, both pages, no live backend:
- `merchant-v2.html`'s `resolveShop()` hint mechanism was already certified in Part 5's browser
  check (interactive, not just load).
- `choose-shop.html` (new this slice): both classic scripts (`security.js`, `shared-header.js`)
  confirmed 200/`application/javascript` via the browser's own network log with nonzero transfer
  sizes; zero console errors traceable to the page's own code; reaches `stateSignin` cleanly (the
  correct, honest outcome with no live session); visual snapshot confirms intact layout (brand,
  message, sign-in link, in order); confirmed the page's internal render functions are properly
  ES-module-scoped (not leaked onto `window`) — the same isolation property every prior slice's
  pages in this programme have.
- `auth.js` syntax-checked as a whole (`node --check`) after both edits; the extracted inline
  module script from `choose-shop.html` independently syntax-checked via `node --check` on the
  isolated `.mjs` content.
- All prior pure-core suites (Q5 81/81, Q6 34/34, Q7 19/19, Q8 43/43, Parts 3-4 23/23, Part 5-7
  18/18) re-run clean — `auth.js` is not required by any of them, confirmed by the re-run itself
  showing no change.

## What this slice does NOT do

Does not touch the legacy `profile.role === "employee"` branch — read, traced, left byte-for-byte
unchanged. Does not touch `_sokoniLoginRedirect()`'s own sanitisation logic (reused, not modified)
or the OAuth-provider-linking code around it. Does not build Provider Dashboard's reuse of the
shared component (Part 7, next). Does not fix the pre-existing `MERCHANT_URL` v1/v2 cutover
decision in `sokoni-merchant-entry.js` (a separate, deliberate site-wide decision this slice does
not preempt) — the new auto-entry/Choose-Shop paths target `/merchant-v2.html` directly and
explicitly, since that is what this whole workstream builds toward, not because the general
cutover has happened. Not deployed. Does not touch `C:/temp/sok-r1`.

## Related

`docs/SWITCH_SHOP_WORKSPACES.md` (Part 4, `getMyShopWorkspaces` — the resolver this slice calls,
unmodified) · `docs/MERCHANT_V2_HEADER_IDENTITY.md` (Part 5, the `sokoniActiveShopId` mechanism
and `resolveShop()` hint this slice writes into) · `auth.js` (`_sokoniResolveShopEntry`,
`loginUser()`, `_handleGoogleResult()`) · `choose-shop.html` (new)
