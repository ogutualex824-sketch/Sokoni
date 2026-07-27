# MiniShop is unreachable: the `shops` collection has no writer

**Status:** OPEN — needs an architecture decision, not a patch
**Found:** 2026-07-26
**Severity:** the entire MiniShop subsystem cannot be entered by any merchant

---

## The finding

`shops` contains **zero documents** in production. Nothing in the codebase
creates one — verified by searching every `.set(` / `.add(` against
`collection('shops')` across the repo. There is no writer.

Ten modules **read** it, including the whole MiniShop chain and
`merchant-success`.

```
$ shops?pageSize=5   ->  0 documents
$ writers of shops/  ->  none
$ readers of shops/  ->  analytics-engine, automation-engine, etims,
                         finance-os-sprint43, jobs, logistics-plus,
                         marketplace-extensions, merchant-success,
                         minishop, minishop-page …
```

## Why this explains the whole MiniShop story

`claimMinishopHandle` → `_assertShopOwner(shopId, uid)` → reads
`shops/{shopId}` → `NOT_FOUND` → throws `not-found: Shop not found.`

**No merchant has ever been able to claim a handle, because it is structurally
impossible.** That is why every handle probed during the 2026-07-26 session
(`kass`, `kass-shop`, `kassshop`, `sokoni`, `demo`, `test`, `bravilex`) returned
404, and why the per-shop link preview work shipped that day has never once run
its happy path against real data.

It also means `getMinishopPublic` 404s for everyone, and `minishop-admin`'s
`loadShopData` finds nothing, leaving `_state.shopId` null — which is why the
analytics tiles could not load even after being wired to real sources.

## A second, independent bug in the same path

Even if a `shops/` document existed, the admin would not find it:

| code | field used |
|---|---|
| `minishop-admin.html` `loadShopData` | `where('ownerId', '==', uid)` |
| `functions/minishop.js` `_assertShopOwner` | `snap.data().sellerUid !== uid` |

Two different field names for the same relationship. Fixing the missing writer
without fixing this would produce a shop the owner still cannot open.

## Where merchants actually live

| collection | populated? | owner field | written by |
|---|---|---|---|
| `users/{uid}` | yes | — | onboarding, auth |
| `sellers/{uid}` | yes | `uid` | onboarding scripts, seller registry |
| `businesses/{id}` | yes | `ownerId` | business bootstrap (KASS = `SOK-GL58F7`) |
| **`shops/{id}`** | **no — empty** | `sellerUid` | **nothing** |

## Options — this is a decision, not a fix

**A. Backfill `shops/` from `sellers/`.** Fast, unblocks MiniShop immediately.
But it creates a fourth store for the same entity, which is precisely the
duplication that the config-schema convergence on the same day existed to
remove. It would need its own resolver within a week.

**B. Point MiniShop at the existing seller record.** One store, no new
duplication, architecturally consistent with the convergence work. Larger: it
touches `claimMinishopHandle`, `_assertShopOwner`, `getMinishopPublic`,
`getMyMinishop`, `minishopPage` and the admin's `loadShopData`.

**C. Decide `shops/` is the canonical per-shop entity and give it a writer.**
Correct if the model is genuinely one seller → many shops (which `sellerUid`
implies). Requires deciding what creates a shop, and when.

The `sellerUid` field name suggests C was the original intent. The empty
collection suggests it was never finished.

**Recommendation: B**, unless one seller genuinely needs multiple shops. It is
the only option that does not add a fourth home for the same merchant.

This is payment- and identity-adjacent, so it belongs in front of the
[[Architecture Review Gate]] rather than being patched in.

## What is NOT blocked by this

Everything built on 2026-07-26 is correct and will work the moment a shop
exists — the prerenderer, the config schema convergence, the resolver, the
admin redesign, the auth-gate ceiling. None of them assume a populated `shops/`;
they fail closed and honestly against an empty one. This gap is upstream of all
of it.

---

Related: [[MiniShop]] · [[PUBLIC_PAGE_PRERENDER]] · [[reference_minishop_config_split]]
