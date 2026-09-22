# Delivery anchor authority

> **Finding date:** 2026-09-22 · **Method:** writer/reader trace across `functions/`, client
> modules and `firestore.rules` · **Gate:** `scripts/test-delivery-anchor-authority.js`
>
> Related: [[SOKONI_CONNECT]] · [[SOKONI_COMMUNICATION_ENGINE]]

## The question

Connect's delivery anchor resolved `deliveries/{anchorId}`. Both user-facing delivery surfaces
read `packageRequests`. One of them was wrong, and the wrong one could not be chosen by
convenience: an anchor that resolves the wrong document does not fail loudly — it **succeeds
quietly against an unrelated record** and authorizes a conversation between strangers.

## The answer: they are different products

They are not two names for one thing. They are two collections serving two businesses.

| | `packageRequests` | `deliveries` |
|---|---|---|
| **Product** | marketplace order fulfilment | SOKONI Delivery Hub (send a parcel) |
| **Participants** | `buyerUid`, `sellerUid`, `assignedDriverId` | `senderUid`, `assignedRiderId` |
| **Has an order?** | yes, `orderId` | no |
| **Has a seller?** | yes | **no** |
| **Document id** | `"DEL" + apiRef` — server-minted, deterministic, idempotent | Firestore auto-id |
| **Business key** | *is* the document id | a `deliveryRef` **field**, `'DEL-' + base36` |
| **Written by** | `dispatch.js`, `delivery-pin.js`, `delivery-complete.js`, `seller-handover.js`, `finos.js`, `index.js` | `delivery-hub.js` — **the browser**, and nothing else |
| **Rules** | `create: if claimsOwner()` | `create: if isAuthed() && senderUid == request.auth.uid` |

`packageRequests` carries the entire server-side lifecycle: dispatch cascade, handover PIN,
completion, seller handover and the FinOS rider payout. `deliveries` carries none of it.

### The production UI already knew

`delivery-tracking.html` names both and keeps a source flag:

```js
/* ── Source flag — 'pkg' (packageRequests) or 'hub' (deliveries) ── */
```

It listens on `packageRequests` first and, after 4 seconds with no data, falls back to
`DeliveryHub.listenDeliveryByRef(ref)` — which queries `where('deliveryRef', '==', ref)`, the
**field**, because the hub document's id is an auto-id and never was the ref.

## The decision

**The delivery anchor is `packageRequests`.** The frozen C1 authority settles it without
needing a judgement call:

```
RELATIONSHIPS.delivery
  describe: "An assigned delivery binds the rider to both ends of the job"
  pairs:    rider:buyer, rider:seller
```

Both ends — buyer *and* seller — is the marketplace shape exactly. The hub has one end
(a sender) and a rider.

## Two defects this exposed

1. **The collection was wrong.** `deliveries/{anchorId}` could never have resolved a hub
   delivery either, because a hub document is keyed by an auto-id and addressed by a
   `deliveryRef` field. The resolver was wrong for *both* collections.

2. **`resolveActor` was called positionally.** Its signature is
   `resolveActor({ uid, token, delivery, order })`, and the call passed
   `(callerUid, d, order)`. `uid` arrived `undefined`, the function returned `null` on its first
   line, and **every delivery anchor refused every caller, always**. The surface had never been
   mounted, so nobody saw it — mounting it would have shipped a dead button.

## Courier communication is a GAP, not a feature

The hub relationship is sender↔rider. There is **no `sender` role** in `CA.ROLES`, and no
`rider:sender` pair in the frozen `delivery` relationship. Supporting it means deliberately
amending a frozen contract — a decision, not an implementation detail.

So hub courier communication is **not mounted and not claimed**. It is recorded here as a
data-model gap awaiting an authority amendment. Aliasing a hub ref into the `delivery` anchor to
make a button appear is precisely the move this document exists to prevent.

## Why the key spaces do not rescue a mistake

Marketplace ids are `"DEL" + apiRef`; hub refs are `'DEL-' + base36`. The hyphen happens to
separate them today. **The resolver must not depend on that.** Neither generator knows the other
exists, so nothing prevents a future collision, and a prefix check would look like a safety net
while quietly becoming an aliasing rule. The resolver depends on the **collection**, and the gate
asserts it does not sniff the id shape.

## Evidence

`scripts/test-delivery-anchor-authority.js`. Beyond the source assertions it executes the
mandate's required regression: one document in **each** collection under the **same** id — the
worst case — and proves that a hub rider is not a party to the marketplace document and a
marketplace buyer is not a party to the hub document. Had the resolver read the wrong collection,
a hub rider would have been authorized to call a marketplace buyer: two strangers bound by nothing
but a coincidence of identifier.

Positive controls accompany every refusal, so the assertions cannot pass by refusing everyone.

**Status: TESTED.** No production document has been read. Confirming that live `packageRequests`
records carry the participants this resolver expects requires production access and is part of
§24 production smoke.
