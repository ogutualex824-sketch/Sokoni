# Checkout Contract

**Status:** DRAFT — for review · **Date:** 2026-08-26
**Deployed:** no.

Governs cart, checkout, payment-intent creation, order creation and fulfilment.
Deliberately separate from [[COMMISSION_ENFORCEMENT_CONTRACT]] — this rule is broader than
commission, and folding it in would turn that document into a general business-rules dump.

Related: [[Payments]] · [[Orders]] · [[RECEIPT_CONTRACT]] · [[Marketplace]]

---

## 1. The Single-Shop Checkout Invariant

> **A checkout transaction MUST contain products belonging to exactly one shop/seller.
> Multiple quantities and multiple distinct products from that same shop are permitted.
> A transaction containing products from more than one shop MUST be rejected before order
> creation. The seller set MUST be derived from authoritative product documents, never from
> a client-supplied `shopId`/`sellerUid`. No order document may be created before this
> invariant passes.**

### Permitted

```
KASS ├── Product A
     ├── Product B  ×3
     └── Product C        →  ONE CHECKOUT  →  ONE KASS ORDER
```

Any number of distinct products, any quantities, any categories — one shop.

### Rejected

```
KASS   → Product A
SHOP B → Product X        →  CHECKOUT  →  ✗ REJECTED
```

### Why

Fulfilment. One order carrying two sellers' products has no single answer to *who ships
this, from where, and who is accountable if it does not arrive*. Every downstream
system — delivery assignment, rider dispatch, the receipt's fulfilment block, settlement,
returns — assumes one seller. The invariant is what makes that assumption safe rather than
lucky.

---

## 2. Rules

| Case | Outcome |
|---|---|
| Multiple distinct products, one seller | **allow** |
| Multiple quantities, one seller | **allow** |
| Products from two or more sellers | **reject** |
| A referenced product has no `sellerUid` | **reject — never fall back** |
| Client supplies `sellerUid`/`shopId` | **ignored as authority** |

**Missing `sellerUid` is a rejection, not a gap to fill.** A product whose seller cannot be
established from its own document is not checkout-able. Falling back to a client-supplied
value would let the browser name the seller for exactly the products where the server could
not — the worst possible case to trust it.

---

## 3. Enforcement — four layers

```
ADD TO CART
   ↓  client blocks a mixed-shop cart                    ← UX
CREATE PAYMENT INTENT
   ↓  server derives sellers from `products` documents   ← AUTHORITY
   ↓  exactly one seller?  ── NO ──▶ REJECT
PAYMENT
   ↓
FINALIZE
   ↓  revalidate before the order write                  ← DEFENCE IN DEPTH
CREATE ONE-SELLER ORDER
   ↓
FULFILMENT
```

**The UX layer is convenience; the server layer is the rule.** A client-side cart
restriction can always be bypassed — by a stale tab, a crafted request, or a future client
that forgets. Server validation stands whether or not the client behaves.

**The finalize assertion is not redundant.** `createPaymentIntent` rejects mixed carts, but
`_finalizeMarketplacePayment` is the boundary that actually *writes* the order. An
invariant enforced only upstream of the writer is one refactor away from being unenforced.

---

## 4. Cart behaviour

When the cart holds Shop A and the shopper adds a Shop B product: **do not add it, and do
not silently replace the cart.** Silent merging loses the shopper's work; silent replacement
loses it more quietly.

Explain the reason rather than presenting a limit:

> **Your cart is from KASS Shop**
> This product is sold by another shop. SOKONI checkout supports one shop per order so your
> delivery can be handled correctly.
> `[ Continue with KASS ]` `[ Start a new cart ]`

The delivery justification is the honest one and makes the rule feel like design rather
than arbitrary restriction.

---

## 5. Current state (audited 2026-08-26)

| Layer | Status |
|---|---|
| Cart blocks mixed shops | **NOT IMPLEMENTED** — `sokoni-cart.js` has zero `sellerUid`/`shopId` references |
| Server rejects mixed sellers | **IMPLEMENTED** — `functions/payment-purposes.js:255-257` |
| Sellers derived from `products` | **IMPLEMENTED** — chunked reads of the products collection |
| Missing `sellerUid` rejected | **NOT IMPLEMENTED** — falls back to `data.sellerUid` (client) |
| Finalize-time revalidation | **NOT IMPLEMENTED** |

`checkout.html:2121` mints `purpose: 'product_order'`, so the implemented server check is on
the live path.

Note `checkout.html:2074` derives a `_sUid` from the first cart item. That value is **not**
the authority — the server re-derives independently — but it should not be mistaken for one.

---

## 6. Acceptance

1. One seller, many products and quantities → checkout succeeds.
2. Two sellers → rejected at `createPaymentIntent`, **before** any order document exists.
3. A product with no `sellerUid` → rejected, with no client fallback consulted.
4. A client-supplied `sellerUid` that disagrees with product data → ignored.
5. Cart refuses a cross-shop add and offers both paths; nothing is silently merged or replaced.
6. `_finalizeMarketplacePayment` refuses to write an order whose lines span sellers.
7. Every rejection leaves **no** order, no payment intent consumed, and no partial state.
8. Negative controls prove each detector can fail.
