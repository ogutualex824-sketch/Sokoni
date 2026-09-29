# Buyer price offers — negotiate, agree, pay the agreed price

**Status:** implemented on `slice/c4-category-matrix` on 2026-09-29 (T2b). **Not deployed.**

Related: [[DISPUTES_AND_REPORTS_AUTHORITY]], [[Payments]], [[Orders]], [[Messages]], [[CHECKOUT_CONTRACT]]

## Owner rules (decided 2026-09-29)

| Rule | Value |
|---|---|
| Which products | Seller opts in **per product** ("Accept price offers"), off by default |
| Lowest buyer offer | **50%** of the listed price. A seller's counter may be any price above 0 and below the list price. |
| Hold | An accepted price holds **24 hours** |
| Quantity | The offer names **N units**; the agreed price covers only those N |
| Commission | On the **agreed (paid)** price. Settlement already uses the paid amount. |

## The authority: `functions/product-offers.js`

There is **one record per product and buyer**: `productOffers/{productId}__{buyerUid}`. A new offer after a final
state starts a new round on the same record, and the history is kept.

| State | Meaning |
|---|---|
| `pending` | Waiting for the other party. `proposedBy` shows who proposed. |
| `accepted` | Agreed. `expiresAt` = acceptance + 24 h. Reads as `expired` after that. |
| `rejected` / `withdrawn` | Closed |
| `purchased` | A paid order used it (`consumedOrderId`) |

Ops (on the existing `messagesDispatch`; there is no new Cloud Function):

| Op | Who | What |
|---|---|---|
| `productOfferSend` | buyer | offer `{productId, amount, qty}` |
| `productOfferRespond` | the party whose turn it is | `accept` / `reject` / `counter` |
| `productOfferWithdraw` | buyer | withdraw an open or accepted offer |
| `productOfferMine` | buyer | their offer on a product (product page state) |
| `productOfferSettings` | the product's seller | `acceptOffers` on or off |

**Negotiation rules:**
- Turns are enforced in a transaction: the proposer cannot answer their own offer, and a stranger cannot act.
- Six moves at most, then the offer must be accepted or declined.
- Limit: 20 offers per buyer per day.
- Every step posts a system note into the **product conversation** (`product_enquiry`, the same thread as questions).
  The seller answers it in **merchant-v2 › Messages** with Accept / Decline / Counter.

## Checkout: the only way an agreed price reaches a charge

The cart line carries **`offerId` only**, and no price is trusted. Two server pricers honour it through one resolver
(`offerResolver`):

- `payment-purposes.validateOrderLines`, which serves both `product_order` (the M-Pesa charge) and the multi-shop
  quote;
- `index.js createCheckoutSession`, the card session. `verifyIntasendPayment` then checks the paid amount against the
  session total.

A line is **refused, never silently re-priced**, when the offer:
- belongs to another buyer;
- is for another product;
- is not accepted;
- is expired;
- is already used;
- or is over the agreed quantity, including when split across two lines.

`verifyIntasendPayment`'s legacy no-session fallback re-prices at the catalogue price, so an offer line on that path is
rejected as an underpayment. It fails closed.

**Consumption:**
- `_finalizeMarketplacePayment` marks the offer `purchased` with the paid order, inside the same order transaction.
- A second paid order on the same offer is a race after payment. It is **flagged** in `offerOveruseAlerts` and **never
  refused**, because the money is already taken. This follows the platform's oversell rule.
- The receipt line shows the price actually charged.

## Surfaces

- **Product page:** "🏷️ Offer" appears only when the product accepts offers. The panel is drawn from the server state:
  send, waiting, the seller's counter (Accept / Decline / Counter), and agreed with a countdown and "Buy N at KES X".
- **merchant-v2 › Inventory:** the product sheet has the "Accept price offers" switch. It flips only after the server
  confirms.
- **merchant-v2 › Messages:** offer notes show Accept / Decline / Counter on the seller's turn. A counter uses the price
  typed in the composer.

## Known limits

- **Staff:** employees cannot answer offers yet. This needs a merchant-identity capability (T2c).
- **Firestore rules** for `productOffers` / `offerOveruseAlerts` are not written. Both are server-only and denied by
  default. Stage 3.
- **Promos and loyalty** in `createCheckoutSession` still apply on top of an agreed price.
- **seller.html's offer inbox** (localStorage) is reference only and untouched.
- **Not deployed.** It needs functions (`messagesDispatch`, `createPaymentIntent`, `createCheckoutSession`, the
  IntaSend webhook path in `index.js`) plus hosting.
