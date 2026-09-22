# Shop communication — a contract boundary, not a missing mount

> **Finding date:** 2026-09-22 · **Method:** identity-chain trace through `firestore.rules`,
> `functions/shared/merchant-identity.js`, `admin-os.js`, `business-bootstrap.js` and `store.html`
> · **Gate:** `scripts/test-shop-communication-boundary.js`
>
> **Outcome: RESOLVED without a new relationship.** Shop-level communication is delivered as an
> **inquiry about a listing**. `shops/{uid}` never enters Connect authorization. A *generic*
> "message this shop" with no listing remains unsupported by design.
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
| Canonical shop id | **the shop document id (`storeId`)** — *not necessarily a uid* | deployed `match /shops/{storeId}` |
| Ownership | **`ownerId` is primary**; `uid == storeId` is a fallback for documents lacking it | deployed rule body, verified against `ad2033ad` |
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

## The decision taken

Option 1. **"Message Shop" is presentation over `inquiry`.**

```
Shop surface -> a published listing of that shop -> productId
             -> products/{productId}.sellerUid  (SERVER derives)
             -> inquiry (buyer:seller, chat ceiling)
```

The buyer reads *"Message shop"*; the relationship recorded is buyer ↔ seller about that listing.
`store.html` is mounted on that basis, and `shops/{uid}` is not an anchor anywhere.

**Why the choice of listing does not matter.** The storefront loads its products with
`where("sellerUid", "==", uid)`, so *every* listing on the page derives the **same** seller.
Picking the first cannot change the recipient.

**Why a lying client gains nothing.** A client that substitutes another product simply reaches
*that* product's seller about *that* product — which `inquiry` already permits. It cannot reach a
person of its choosing, because it never names one.

**`roleLabel` is presentation only.** It replaces the displayed noun. The verb comes from the
server-allowed channel, the channels come from the server response, and the request payload is
built from `targetRole` + `channel` — both server-supplied. A label cannot change who is
contacted.

**Still unsupported, deliberately:** a shop with no live listing gets no button. A generic
"message this shop" would need the UID-addressed relationship this document refuses.

---

## The options that were weighed

Shop-level communication needed one of:

1. **Route it through `inquiry`.** "Message this shop" becomes "message about this listing",
   anchored on a real `products/{id}`. Already supported, already chat-ceilinged, nothing new to
   build. Loses the ability to contact a shop that has no listings.
2. **A new `shop` relationship in the frozen authority**, with an explicit decision about what
   makes the relationship real — because "this uid is a shop" is true of every seller on the
   platform, which is a directory, not a relationship.

**Option 2 was not taken.** It would require deciding what a shop relationship *means* — buyer to
owner? to employees? to which employee? what happens when ownership changes? Those are real
authority questions, and a new anchor would hide them rather than answer them. The frozen contract
is frozen for exactly this reason: the pressure to add one more relationship always arrives
attached to a surface somebody wants to ship.

## Status

**Shop communication: BUILT and TESTED**, via `inquiry`. `store.html` is mounted.
Gate: `scripts/test-shop-inquiry-mount.js`.

**The boundary still stands** and is still gated: no Connect anchor resolves `shops/{uid}`, the
mount function names no uid, and a shop with no live listing draws nothing. Those absences carry a
positive control, so they cannot pass by being blind.

No browser has loaded this page — this is source-level evidence, not a real-device result.

## Correction — 2026-09-22

An earlier version of this document stated that the canonical shop id **is the owner's uid**,
citing `match /shops/{uid}` with `request.auth.uid == uid`. **That was the Git lineage, not
production.** Fetching the deployed ruleset (`ad2033ad`) showed the live rule is:

```
match /shops/{storeId} {
  allow read:   if true;
  allow update: if isAdmin()
    || (isAuthed()
        && (resource.data.ownerId == request.auth.uid
            || (!("ownerId" in resource.data) && request.auth.uid == storeId))
        && ... field allowlist including timezone, with format validation);
}
```

So **`ownerId` is the primary ownership authority**, and `uid == storeId` survives only as a
compatibility fallback for shop documents that do not carry one. Do not read that as "every
shop has migrated" — the fallback exists precisely because some have not, and this document
claims nothing about the proportion.

**None of this changes the Communications contract.** Connect does not authorize through
`shops` at all. Product inquiry begins at the listing:

```
MiniShop -> published product -> products/{productId}.sellerUid -> inquiry relationship
```

The conclusion of this document therefore stands — a shop identifier is client-enumerable and
must not become a Connect anchor — but one fact supporting it was stale, and a stale supporting
fact in a security document is worth correcting even when the conclusion survives.
