# Switch Shop — the shop-membership resolver (Part 4)

**Status:** 🟢 **TRACED · DESIGNED · IMPLEMENTED · CERTIFIED (pure core). COMMITTED · STACKED.
NOT ON R1 · NOT DEPLOYED.** Part 4 of "Till Approval Automation + Unified Dashboard Profile."
Production remains `d592d8f`/v632, untouched.
**Date:** 2026-09-04

---

## Trace — why this is genuinely new, not a wiring exercise

Researched before writing any code: **no function anywhere in this codebase already answers
"every shop this uid may operate."** Two separate employment systems exist —
`shops`/`shopEmployees` (what `merchant-v2.html` and `merchantIdentity`, Part 3, actually use) and
`functions/workforce-identity.js`'s disjoint `businesses`/`workspaceMemberships` space (a
different, POS-shift-oriented tenant model — `functions/tenant-identity.js`'s own header already
describes this codebase as having "two disjoint tenant spaces"). Every existing code path treats
owner-vs-employee as two separate branches, never a unified list:
`shop-employees.js`'s own `resolveShopAccess` answers "what may I do at THIS shop" for one named
shop, not "which shops." `resolveOwnedShopId` explicitly **throws** if an account owns more than
one shop via the field-union lookup — a single-answer function, not a list. **Scoped deliberately
to the `shops`/`shopEmployees` space only** (a decision made explicitly, not defaulted) — pulling
in `workforce-identity.js`'s separate model would conflate two systems with different
authorization shapes for no benefit this workstream needs.

## Design — one new resolver, reusing the exact corroboration already proven

`functions/shop-employees.js` gains `getMyShopWorkspaces()` (no parameters — always the caller's
own uid) → `{ workspaces: [{shopId, shopName, role, via, isActive}, ...] }`.

```
own shop        shops/{uid} direct match, then the ownerId/sellerUid/ownerUid field-union scan
                 (mirrors resolveOwnedShopId's own field list, but never throws on multiple —
                 a list has no such constraint to violate)
                     ↓
employee shops   shopEmployees WHERE uid == caller, for each candidate:
                     - active !== false
                     - role is a known SHOP_ROLES value
                     - shopOwnerId matches the ACTUAL owner read from shops/{shopId}
                       (shopOwnerOf's own field union) — THE corroboration, unchanged from
                       resolveShopAccess: a forged record names the forger as owner; the real
                       shop names the real one; they disagree, and the candidate is silently
                       dropped, never surfaced as "denied" (which would tell a prober which
                       check failed)
```

**Why a client cannot smuggle a fake shop into this list, traced precisely:** `firestore.rules`
lets a client CREATE a `shopEmployees` doc naming any `shopId` — but only with
`shopOwnerId == request.auth.uid` (their OWN authenticated identity, which they cannot forge).
For a forged doc to survive corroboration here, `shopOwnerId` would need to equal the REAL
owner of the named `shopId` — which is never the attacker's own uid unless they genuinely are
that shop's owner. The list is therefore exactly as trustworthy as `resolveShopAccess` already
is; this is the same guarantee, restructured from a single lookup into a scan.

**Response shape mirrors `resolveShopAccess`'s own vocabulary** (`role`, `via:'owner'|'employee'`)
so a consumer (the header switcher, the login "Choose Shop" step) never has to learn a second one.
`isActive` reflects the shop's own `status` field (`suspended` → `false`) — a suspended shop still
appears (so a merchant can see why they were locked out) rather than silently vanishing.

## Certification

`scripts/test-merchant-identity.js` (extended, now covering Parts 3 and 4) — **23/23**. The new
`_workspaceEntry(...)` helper (pure — no Firestore) is certified directly: shop name from data,
fallback to "My Shop" when absent (never blank), sanitisation (no raw `<`/`>` survive a hostile
shop name), `isActive` correctly reflecting `suspended` status, and correct behaviour when shop
data is entirely absent (does not throw). The corroboration scan itself is I/O-bound (real
Firestore reads across `shops` and `shopEmployees`) and is certified by the code-path trace
above — it reuses `shopOwnerOf` and the identical corroboration condition
`resolveShopAccess` already enforces, letter for letter, not a re-derived approximation of it.

## What this slice does NOT do

Does not touch `resolveShopAccess`, `resolveOwnedShopId`, `merchantIdentity` (Part 3),
`listShopEmployees`, or `removeShopEmployee` — all pre-existing or already-committed, all
unmodified. Does not include `workforce-identity.js`'s `businesses`/`workspaceMemberships` space
— an explicit scoping decision, not an oversight. Does not build the Switch Shop UI (Merchant V2
header, next) or the login "Choose Shop" step (also next) — this is the resolver both will call.
Not deployed. Does not touch `C:/temp/sok-r1`.

## Related

`functions/shop-employees.js` (`getMyShopWorkspaces`, `_workspaceEntry` — new;
`resolveShopAccess`, `resolveOwnedShopId`, `shopOwnerOf` — pre-existing, reused unmodified) ·
`docs/MERCHANT_IDENTITY_CALLABLE.md` (Part 3, `merchantIdentity` — the sibling per-shop resolver
this list complements) · `scripts/test-merchant-identity.js` (certification, 23/23)
