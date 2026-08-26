# Administration — `super-admin.html` vs `superadmin.html`

**Date:** 2026-08-26
**Status:** DECIDED — option 3, canonical + legacy alias
**Blocking:** Administration section certification (deliberately not started until this resolved)

> This decision was **deferred once before** — CHANGELOG line 7925: *"Deferred (need a
> canonical decision or are larger than a quick fix): unify the two admin→super-admin
> destinations."* It is resolved here.

---

## Comparison

| Question | `super-admin.html` | `superadmin.html` |
|---|---|---|
| **Size** | 96,223 bytes | 47,444 bytes |
| **Cloud Functions called** | **12** — `getPlatformHealthScores`, `getTopBusinessPriorities`, `setUserRole`, `suspendUser`, `applicationList`, `applicationReconcile`, `applicationDecide`, `getMerchantFinancials`, `adminGetPendingPayouts`, `adminPayoutOps`, `adminProcessPayout`, `sendPlatformBroadcast` | **1** — `setUserRole` |
| **Collections** | `auditLog`, `loyaltyRules`, `orders`, `platformBroadcasts`, `platformConfig`, `products`, `users` | `auditLog`, `orders`, `payments`, `reports`, `sellers`, `users` |
| **Authorization** | `claims.superAdmin !== true` -> deny. **STRICT superAdmin**, plus passcode 3026 as a second factor | `!claims.superAdmin && !claims.admin` -> deny. **Accepts `admin` too** — weaker than its own comment, which says "requires superAdmin JWT claim" (audit D4) |
| **`setUserRole` contract** | `fn({uid, role})` — **CORRECT**, matches `functions/super-admin.js` | `setRoleFn({email, role})` — **BROKEN (E1)**. Server destructures `{uid, role}` and throws `INVALID_ARGUMENT`; there is no email->uid resolution. Every Grant/Revoke Role call fails. |
| **`suspendUser`** | `fn({uid, suspend})` — **CORRECT**, calls the CF that disables the Auth account | Direct `updateDoc(users/{uid}, {suspended:true})` — **COSMETIC (E2)**. Never disables the Auth account; nothing reads `users.suspended` on any auth path, so a "suspended" user keeps a valid session. |
| **Inbound references** | `admin-os.html:343` (nav item), `admin-os.html:375` (quick link) — both `target="_blank"` | `admin.html:783` (sidebar button `#link-superadmin`) — **1 reference** |
| **Outbound / deep links** | — | — |
| **Service-worker precache** | `/super-admin` (service-worker.js:192) | `/superadmin` (service-worker.js:132) |
| **Tests / CI / config** | none | none |
| **Unique functionality** | Applications lifecycle, payouts, merchant financials, platform broadcasts, loyalty rules, platform config, health scores | `payments` / `reports` / `sellers` collection VIEWS only — **no callable behind them** beyond the broken `setUserRole` |
| **Canonical candidate** | **YES** | no |

---

## Decision — option 3: canonical + legacy alias

**`super-admin.html` is canonical.**

It is not a close call:

1. **12 callables vs 1.** It is a full platform console; the other is a thin viewer.
2. **It is a strict superset of the other's ACTIONS.** Both `setUserRole` and `suspendUser`
   exist in `super-admin.html`, implemented **correctly**.
3. **Both of `superadmin.html`'s admin actions are defective** — E1 (role grant/revoke always
   throws) and E2 (suspend never disables the account). Its only unique content is three
   read-only collection views.
4. **Its gate is weaker** — it admits `admin` where its own comment claims superAdmin-only.

`superadmin.html` is therefore not a second console worth keeping active: it is a legacy page
whose write paths are broken and whose gate is looser than the console it duplicates.

### Why not option 1 (delete outright)

The dependency scan found a **service-worker precache entry** (`/superadmin`,
service-worker.js:132). A precached route implies it was a real destination, so bookmarks and
deep links plausibly exist. Deleting the file would 404 them.

### Why not option 2 (retain both)

Its three unique collection views (`payments`, `reports`, `sellers`) have no callable behind
them, and keeping a second superAdmin console with a **weaker gate** and two **broken write
paths** is a liability, not a feature.

---

## Migration plan

| Step | Status |
|---|---|
| 1. Migrate the single inbound reference `admin.html:783` -> `super-admin.html` | **DONE** |
| 2. Registry already records `superadmin.html` as `duplicateOf: 'super-admin.html'`, rendered as "Super Admin Console (legacy)" and de-prioritised to mobile tier 3 | already true |
| 3. Remove `/superadmin` from the service-worker precache | **NOT DONE — needs approval** |
| 4. Convert `superadmin.html` to a one-hop redirect to `super-admin.html` | **NOT DONE — needs approval** |
| 5. Delete the file | **NOT DONE — only after 3 and 4 have shipped and traffic is confirmed zero** |

Steps 3–5 touch deployment behaviour and are left for an explicit decision. Nothing was
deleted; the dependency scan is the evidence base for when it is safe.

**One hop, not a chain.** If step 4 proceeds, `superadmin.html` should redirect directly to
`super-admin.html` — never via an intermediate. The point is to preserve deep links while
ending the second active console, not to build a redirect maze.

### If instead it is kept active

Then E1 and E2 must be fixed there, and its gate tightened to `superAdmin === true`. Leaving
a console whose Grant Role silently always fails is worse than removing it: an operator
believes a role was granted when nothing happened.

---

## Certification consequence

`superadmin.html` stays in the registry as a legacy alias and is certified with the
Administration section, so its navigation and responsive behaviour remain measured while it
exists. Being legacy is not a reason to leave it unmeasured.

---

## Related

`docs/ADMIN_ROUTING_NAVIGATION_AUDIT.md` (B1 duplicates, D4 gate, E1/E2 defects) ·
`docs/ADMIN_SURFACE_CENSUS.md` · `sokoni-admin-nav.js`
