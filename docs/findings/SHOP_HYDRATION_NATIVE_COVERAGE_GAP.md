# The native Shop surface has no hydration coverage

**Status:** OPEN gap (no known defect) · **Found:** 2026-08-26 while re-scoping the deployment gate

Related: [[PRINT_BRIDGE_E2E_CHECKLIST]] · [[project_merchant_consolidation]]

---

`scripts/test-shop-setup-hydration.js` exists because a real device kept losing shop values
between a proven backend and the form. It excludes cause (3) — *the UI overwrote the form after
the response* — by stubbing `getShopProfile` and asking what the form actually holds.

It drives **`seller.html#store`**. That is the LEGACY surface, and it is now reached only through
the redirect's escape hatch (`?legacy=1`) or an embedded frame.

## The two surfaces do not share an authority

| | surface | authority |
|---|---|---|
| legacy | `seller.html#store` | **`getShopProfile`** |
| native | `sokoni-merchant-store-ui.js`, route `shop` `kind:'native'` | **`getMyMinishop` / `saveMinishop`** |

So pointing the suite at merchant-v2 would not test the same thing — it would silently stop
testing `getShopProfile` and start testing a different call. The suite was therefore left on the
legacy surface, with `?legacy=1` requested explicitly.

## What that leaves uncovered

**The surface merchants actually use has no equivalent test.** The `shop` route is native, so a
merchant editing their storefront goes through `getMyMinishop`/`saveMinishop` — and nothing asserts
that a canonical value survives to that form. The defect class the legacy suite guards against
(the UI overwriting a hydrated form) is not surface-specific; it is exactly the kind of thing a
second implementation reproduces independently.

This is a **coverage gap, not a known defect**. Nothing here says the native surface is wrong —
only that if it were wrong in the same way, no test would say so.

## Deliberately not closed here

Writing that coverage means mounting `SokoniMerchantStoreUI` against a stubbed `getMyMinishop` and
asserting the form afterwards. That is its own slice with its own proof obligation, and it does not
belong inside a deployment-gate re-scoping — the same reason the printer bridge stayed frozen
throughout this work.

**Do not delete or re-point the legacy suite when that coverage is written.** Both surfaces are
live: the legacy shell still mounts in a frame for `kind:'seller'` routes, and `getShopProfile` is
still its authority.
