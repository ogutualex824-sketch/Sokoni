# Shared Product Writer — 2b-0 certification

**Status:** CERTIFIED (implemented + certified). **NOT deployed.**
**Date:** 2026-08-20
**Module:** `sokoni-merchant-data.js`
**Suites:** `scripts/test-merchant-product-writer.js` (37/0),
`scripts/test-merchant-product-writer-emulator.mjs` (46/0)

Related: [[MERCHANT_PRODUCTS_CONVERSION_AUDIT]] · [[MERCHANT_SURFACE_AUDIT]] ·
[[MERCHANT_2D2_QUEUE]]

---

## Why the writer was certified before the UI

Products was about to acquire a *second* write path. `seller.js` writes product
documents by importing the Firestore SDK inline; a native module doing the same
would leave two writers for one collection, free to drift apart — the shape of
defect already recorded for `posRetailSales`, where writer and reader disagreed
about field names and POS sales silently vanished from reporting.

So the write authority was built and proven on its own, against the real
transaction engine and the real ruleset, before any UI could depend on it.

## What the writer is, and is not

`createProduct` / `updateProduct` / `deleteProduct` / `productDraftId`, plus the
pure projections `productProjections` and `mirrorsComplete`.

It deliberately **cannot**:

| Not this                 | Because                                                     |
|--------------------------|-------------------------------------------------------------|
| upload media             | 2c's slice; a product is valid with no pictures             |
| write `productCounters`  | READ ONLY for this conversion — and `allow write: if false` |
| re-implement plan limits | `canPublishProduct` is **consulted**, never reproduced       |
| read a cache to decide   | Firestore is the truth                                       |
| move a product's shop    | `shopId`/`sellerUid` are stripped from every patch           |

## The property that mattered most

> A refused `canPublishProduct` must perform **zero** mutation — not a write
> followed by an error.

Proven twice, and both times by observation rather than by return value:

- **Logic suite** — the adapter records every write it is asked to perform; after
  a refusal that record is empty. A negative control confirms an *allowed* create
  does appear in the same log, so the empty log is real absence and not a blind
  adapter.
- **Emulator suite** — after a refusal the `products` collection is queried
  through a rules-*bypassing* context. "Nothing was written" means the server has
  nothing. Reading through a normal context would have let a merely *denied* read
  masquerade as an empty collection, turning every negative test into a false pass.

The gate is also proven to run *before* the write, not after: a gate consulted
afterwards turns a refusal into a rollback, and a failed rollback leaves the
merchant holding a product their plan forbids.

## Defence in depth

The client gate is not the only gate. With `productCounters` seeded at the limit
and `canPublish` **omitted entirely** — modelling a bypassed client — Firestore
itself refuses the write via `withinProductLimit()`. A negative control drops the
counter below the limit and the identical call succeeds, so the refusal is
attributable to the limit rather than to a broken call.

## Two contract defects the live ruleset exposed

1. **Price floor.** The writer accepted `price >= 0`; the live rule requires
   `price > 0` (`validPrice`). A free product would have been accepted by the
   form and then refused by Firestore — the exact false-success shape the writer
   exists to prevent. Now `> 0`, with the rule cited at the check.
2. **Cost was lossy.** `costPrice` was not carried, so every mirrored product
   would have reported a zero cost and therefore a 100% margin. Now carried and
   asserted through the mapping.

## Creating a product is not one write

`seller.js:1008-1071` writes the canonical record and then mirrors it:

```
products/{id}                              canonical storefront   (blocking)
tenants/{uid}/inventory_products/{id}       Inventory Manager
posProducts/{id}                            POS checkout catalogue
```

Those mirrors are why an uploaded product is sellable at the till at all. A
native writer that wrote only the canonical record would have created products
invisible at POS and absent from Inventory — a regression against `seller.html`
that no test of the canonical write would have caught.

Two deliberate departures from the code being replaced:

- The projections are **pure functions**, so the field mapping is certifiable on
  its own. Mapping is where mirror divergence lives.
- The old mirrors are fire-and-forget (`.catch(function(){})`), which turns a
  denied mirror into a reported success. Here each mirror's outcome is
  **returned**. A mirror failure never fails the create — the canonical record is
  the merchant's revenue path and is already committed — but it is never hidden
  either, so the UI can say *"created, not yet at the till"* instead of an
  unqualified success. A replay repairs a mirror that failed the first time.

## Idempotency

`productDraftId` is deterministic per (shop, draft attempt), so a double tap or a
retry after a dropped response computes the same id and claims the same document.
Create uses a **transaction** rather than `get()`-then-`set()`. Five simultaneous
creates of the same draft produced exactly one product against the real engine.

## Known limits, recorded rather than closed

- **`shopId` isolation is client-side only.** The live rule pins `sellerUid` to
  `request.auth.uid` and says nothing about `shopId`, so a merchant with two
  shops is separated by the *writer*, not by rules. Not a regression —
  `seller.js` never enforced it either — but it must not be mistaken for a
  server-enforced boundary.
- **App Check** is not enforced by the emulator; production enforces it.
- **`productCounters` drift** is untouched by design.

---

## FINDING — `isActive()` and claim-less tokens

**Not a writer defect. Not fixed here. Needs a production check before the
Products UI can ship.**

`firestore.rules.live:30` gates `create` on five collections — `products`,
`orders`, `bookings`, `providers`, `conversations` (lines 867, 569, 363, 340,
910) — through:

```
function isActive() {
  return request.auth != null &&
         (request.auth.token.deactivated != true ||
          request.auth.token.admin == true ||
          request.auth.token.superAdmin == true);
}
```

Measured in the emulator against the live ruleset:

| token                    | create `products` | create `conversations` |
|--------------------------|-------------------|------------------------|
| no custom claims         | **DENIED**        | **DENIED**             |
| `deactivated: false`     | ALLOWED           | ALLOWED                |
| `deactivated: true`      | DENIED            | —                      |
| `admin: true`            | ALLOWED           | —                      |

Reading a **missing** key on `request.auth.token` raises an evaluation error
rather than yielding false, and `||` recovers only when a later operand is
literally true. A token carrying none of the three keys therefore fails all three
operands and is refused.

`functions/account-status.js:37-38` sets `deactivated: true` on deactivation and
**deletes** the claim on reactivation, so an ordinary, never-deactivated account
carries none of the three. The gate entered the ruleset in `39a03c9`
(2026-07-27).

This is an emulator measurement. Before treating it as a live outage it needs one
production observation, which is cheap and read-only:

> Does any `products` document have `createdAt` after **2026-07-27**, created by
> a non-admin seller?

- **If yes** — production tolerates the missing key and the emulator's evaluator
  is stricter; record that difference and move on.
- **If no** — client-direct product creation has been denied platform-wide since
  2026-07-27, and the fix is a rules edit (`token.get('deactivated', false)`),
  which the emulator confirms is admitted for a claim-less token.

Either way it is settled by observation, not by argument. It is filed here rather
than patched because a rules change is a release action, the compiled ruleset has
**1,693 bytes** of headroom, and the RC is frozen to critical fixes.
