# Shop communication — a contract boundary, not a missing mount

> **Finding date:** 2026-09-22 · **Method:** identity-chain trace through `firestore.rules`,
> `functions/shared/merchant-identity.js`, `admin-os.js`, `business-bootstrap.js` and `store.html`
> · **Gate:** `scripts/test-shop-communication-boundary.js`
>
> **Outcome: NOT MOUNTED, and deliberately not claimed.** Shop-level communication cannot be
> expressed in the frozen Connect authority. Adding it is an authority-contract decision.
>
> Related: [[DELIVERY_ANCHOR_AUTHORITY]] · [[SOKONI_CONNECT]]

## The chain, traced

```
auth.uid
  ↓
shops/{uid}                     rules: match /shops/{uid}, update iff request.auth.uid == uid
  ↓                             the document id IS the owner's uid
products/{id}.sellerUid         the canonical seller identity (never the shop doc)
  ↓
CA.RELATIONSHIPS.inquiry        anchored on products/{id}, pairs buyer:seller, ceiling chat
```

### What is authoritative

| Question | Answer | Evidence |
|---|---|---|
| Canonical shop document | `shops/{uid}` | `match /shops/{uid}` with `request.auth.uid == uid` |
| Canonical shop id | **the owner's uid** | same rule; `store.html` calls it *"Firebase seller UID"* |
| Owner/merchant relationship | `ownerId \|\| sellerUid \|\| uid` | `_shopOwner` in `admin-os.js:1750` |
| Seller identity for commerce | `products/{id}.sellerUid` | `merchant-identity.js`, and the existing `inquiry` anchor |
| Existing resolver to reuse | `merchant-identity.js` / `_shopOwner` | no new lookup was written |

A live census recorded in `business-bootstrap.js`: **of 108 products, 103 carry
`products.shopId == the OWNER'S UID` and ZERO carry a `SOK-` merchantId.** So today the shop
identifier *is* the owner's uid in production data.

But the codebase deliberately refuses to depend on that. `admin-os.js` resolves shops by
**ownership**, with the comment:

> *Fall back to ownership, never to `shopId = uid`: a seller whose declared shop does not exist is
> a DIFFERENT finding from one whose shop is simply recorded under another id, and collapsing them
> hides the first.*

`business-wallet.js` anticipates a migration away from it. So `shopId == uid` is a **migration
state, not a contract** — which is itself a reason not to build an anchor on it.

## Why it stops here

**There is no `shop` relationship in `CA.RELATIONSHIPS`.** The six are `order`, `inquiry`,
`booking`, `delivery`, `supply`, `support`.

The nearest is `inquiry` — *"A pre-purchase enquiry against a published listing"*, `buyer:seller`,
with a deliberate **chat-only ceiling** because an enquiry is self-asserted. It is anchored on
`products/{id}`: **the client supplies a listing, and the SERVER derives the seller from it.**

A shop anchor would be `shops/{uid}`, so its `anchorId` **is a person's uid**. And that uid is not
obscure:

- `shops` is world-readable — `allow read: if true` — so shop ids are enumerable;
- `store.html` carries it in the URL: `const storeId = params.get("id"); /* Firebase seller UID */`.

Connect is built so that **no client ever names a counterparty**. There is no `calleeUid`
parameter anywhere in `connect-calls.js`, by design. Every anchor is a *business object that names
a person* — an order, a booking, a listing, a delivery, a support case. A shop anchor inverts that:
the client would hand the server a uid taken from the address bar, and the server would open a
channel to whoever it names.

That is not a mount. It is a change to the invariant the authority exists to enforce.

## The decision required

Shop-level communication needs one of:

1. **Route it through `inquiry`.** "Message this shop" becomes "message about this listing",
   anchored on a real `products/{id}`. Already supported, already chat-ceilinged, nothing new to
   build. Loses the ability to contact a shop that has no listings.
2. **A new `shop` relationship in the frozen authority**, with an explicit decision about what
   makes the relationship real — because "this uid is a shop" is true of every seller on the
   platform, which is a directory, not a relationship.

**Option 2 is an authority-contract change and is not taken here.** The frozen contract is frozen
for the reason this document illustrates: the pressure to add one more relationship always arrives
attached to a surface somebody wants to ship.

## Status

**BLOCKED at the contract boundary — not partial, not claimed.**

`store.html` is **not mounted** and shop communication is **removed from the claimed surface**
until the relationship question above is answered deliberately. The gate asserts the absence,
with a positive control that the detector *can* see a mounted surface
(`delivery-tracking.html`), so "not mounted" cannot pass by being blind.
