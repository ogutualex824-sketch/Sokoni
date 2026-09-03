# merchantIdentity — the missing dependency (Part 3)

**Status:** 🟢 **TRACED · DESIGNED · IMPLEMENTED · CERTIFIED (pure core). COMMITTED · STACKED.
NOT ON R1 · NOT DEPLOYED.** Part 3 of "Till Approval Automation + Unified Dashboard Profile."
Production remains `d592d8f`/v632, untouched.
**Date:** 2026-09-04

---

## The finding

`merchant-v2.html`'s own `resolveShop()` (its core identity-resolution step, run once per
session before anything else in the shell can work) calls `_callable('merchantIdentity')({
shopId })` and expects back `{capabilities: [...], shop: {...}, servedBy}`. **This callable did
not exist anywhere in `functions/*.js` on this branch** — confirmed by grep, not assumed. This
predates this workstream; it was not introduced by Parts 1-2. It means: for any real,
authenticated session (owner or employee), `merchant-v2.html`'s identity step would throw or
hang, independent of Till & QR, independent of Switch Shop. The Part 2 browser check did not
catch this because it never reached this code path (no live Firebase session existed in that
check to trigger it) — flagged here explicitly rather than left as an unverified assumption.

## Design — built on the authority that already exists, not a new one

`functions/shop-employees.js` already exports `resolveShopAccess(uid, shopId)` — the
already-corroborated authority ("2D-2" fix: an employee record is believed only when
`shops/{shopId}` itself agrees it names that uid as owner; a forged `shopEmployees` record naming
a different owner is refused). `merchantIdentity` is a thin `onCall` wrapper around it:

```
merchantIdentity({shopId})
  -> resolveShopAccess(auth.uid, shopId)   [pre-existing, unmodified]
  -> capabilitiesForRole(access.role)      [NEW, pure, certified]
  -> shop projection from shops/{shopId}   [name/logo/phone/email/address/city]
  -> { capabilities, shop, servedBy: access.via, role: access.role }
```

**Deliberately not named `functions/merchant-identity.js`.** That exact filename is expected by a
different, unmerged branch (`release/merchant-identity`, which has its own `resolveActor`/
`_internal` export shape) and is referenced by another in-progress, not-mine, currently-dirty
file in this working tree (`pos-zero-friction.js`'s `require('./merchant-identity')._internal`).
Creating a file with that name now, with a different internal shape, would set up a real
collision for whoever reconciles that branch later. Added to `shop-employees.js` instead — the
natural home, since it's a thin wrapper around that file's own authority.

**`ROLE_CAPABILITIES` — first defined here, not ported from an assumption.** No
`ROLE_CAPABILITIES` table existed anywhere on this branch before this change (confirmed by grep).
`'sell'` is the only capability any current shell code actually checks
(`merchant-v2.html`'s `can('sell')`). The rest of the table is conservative, forward-looking
scaffolding for `shop-employees.js`'s own `SHOP_ROLES` vocabulary
(`cashier`/`manager`/`inventory`/`support`) plus `owner`/`admin` — least-privilege by default
(`support` gets nothing beyond being recognised), not copied from the missing branch's own
(unread, unverified) table.

**A real bug found and fixed during its own certification:** `capabilitiesForRole`'s first draft
returned the live array stored in `ROLE_CAPABILITIES[role]` directly. `Object.freeze()` on the
table is shallow — it stops keys being reassigned, but does **not** freeze the arrays it holds —
so a caller mutating its "own" capability list would have silently corrupted the shared table for
every future resolution of that role. Caught by the certification suite itself (a test asserting
mutation-isolation failed against the first implementation), fixed with `.slice()`.

## Certification

`scripts/test-merchant-identity.js` — **15/15**, pure-core (no Firestore; `resolveShopAccess`
itself is pre-existing and not re-certified here, only this slice's own addition). Covers: every
role resolves its intended capability set; `owner` gets `settings`, `cashier` does not
(role-differentiated, not a flat grant); **the security property that matters most** — an
unrecognised/malformed role resolves to an EMPTY capability list, never full access (fail closed,
not fail open); mutation-isolation (the bug above, now guarded); a negative control; and a
sabotage control proving a fail-open regression in this exact function would be caught (a
weakened copy that defaults unknown roles to `owner`'s capabilities was proven to wrongly grant
`settings`, and the real module was proven, side by side, to still refuse it).

## What this slice does NOT do

Does not touch `resolveShopAccess`, `resolveOwnedShopId`, `listShopEmployees`, or
`removeShopEmployee` — all pre-existing, all unmodified. Does not build the shop-membership
resolver (Part 4, next) or the Switch Shop UI. Does not create `functions/merchant-identity.js`
(deliberately, see above). Not deployed. Does not touch `C:/temp/sok-r1`.

## Related

`functions/shop-employees.js` (`merchantIdentity`, `capabilitiesForRole`, `ROLE_CAPABILITIES` —
new; `resolveShopAccess` — pre-existing, read, reused unmodified) · `merchant-v2.html`
(`resolveShop()`, the caller this callable answers — read, not modified) ·
`scripts/test-merchant-identity.js` (certification, 15/15)
