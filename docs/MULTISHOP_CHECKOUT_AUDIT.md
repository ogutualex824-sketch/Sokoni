# Multi-Shop Cart / Shop-Scoped Settlement — Checkout Audit

**Read-only. Nothing modified, deployed, seeded, or configured.**
**Date:** 2026-08-27
**Related:** [[CHECKOUT_CONTRACT]] · [[POS_MANUAL_TILL_PAYMENT]] · [[MERCHANT_OWNED_PAYMENTS]] · [[RIDE_SERVICES_MONEY_AUDIT]]

---

## 0. HEADLINE — the proposal conflicts with what is already built

> **Proposed:** the cart *may* be multi-shop; checkout partitions it into shop-scoped payments.
> **Implemented:** the cart *may not* be multi-shop at all, and checkout **rejects** rather
> than partitions.

The single-shop rule is already enforced — but **one layer earlier than the proposal assumes**,
and by refusal rather than by splitting.

| Layer | Today | Proposal needs |
|---|---|---|
| Cart | **refuses** a cross-shop add (`sokoni-cart.js:189`, returns `false`, fires `sokoni:cart-rejected`) | **allow** it |
| Checkout | **rejects** — *"Cart spans multiple sellers; check out one shop at a time."* (`payment-purposes.js:256`) | **partition** into N flows |
| Order writer | re-validates and throws on mixed sellers | unchanged |

So this is not "add a missing feature." It is **relaxing a deliberately-built, tested guard**
(`test-single-shop-checkout.js`, 29/0) and replacing refusal with partitioning. That is a
larger and riskier change than the framing suggests, and it should be decided as such.

The *settlement* invariant the proposal wants — one payment, one shop — **already holds and
would continue to hold.** Only the cart-level restriction would be lifted.

## A. Current architecture trace

```
product page
   └── SokoniCart.add(item)
          └── cartSeller(arr) — first item's sellerUid becomes the cart's shop
          └── cross-shop add → RETURN FALSE + 'sokoni:cart-rejected'   ← blocks here
   ↓
checkout
   └── createPaymentIntent (payment-purposes.js)
          └── seller set DERIVED from products/{id}.sellerUid — never client-supplied
          └── orderSellers.length > 1 → fail('failed-precondition')     ← rejects here
   ↓
_finalizeMarketplacePayment (index.js)
   └── _lineSellers re-derived → throws on >1                           ← defence in depth
   ↓
orders/{id}  status: paid, channel: "online", sellerUid unambiguous
   ↓
commission (commissionLedger, PER_SALE_48H on completion)
   ↓
delivery components on the order
```

**Separately, and not connected to the above:**

```
pos.html / pos.js  (MERCHANT-operated)
   └── M-PESA Till → reference → payment.complete({method:'mpesa_till_manual'})
          └── PosDB.transactions → syncQueue → PosSyncEngine
                 └── posTransactions/{id}          (client-writable)
                        └── pos-retail-mirror → posRetailSales   (ANALYTICS ONLY)
                        └── onPosTransactionMpesaRef → reference uniqueness claim
```

## B. Matrix — the twelve questions

| # | Question | Verdict | Evidence |
|---|---|---|---|
| 1 | Cart can hold multiple shops? | **NO — blocked** | `sokoni-cart.js:189` returns `false`, fires `sokoni:cart-rejected` |
| 2 | Checkout partitions by shop? | **MISSING** | `payment-purposes.js:256` **rejects**; no partition logic exists |
| 3 | Shop-scoped order/payment identifier? | **EXISTS** | `sellerUid` derived from product docs; Single-Shop Invariant guarantees it is unambiguous |
| 4 | Manual Till flow works for a shop? | **EXISTS** | deployed today; `mpesa_till_manual`, reference claim, receipt tender |
| 5 | Unregistered shop can have a manual Till? | **EXISTS** | gated on seller agreement + shop ownership, NOT registration — see §B2 |
| 6 | Buy/Checkout can route to that Till flow? | **MISSING** | `checkout.html`, `cart.html`, `product.html` → **0** references to `mpesa_till`. It is POS-only |
| 7 | POS confirmation advances order/payment state? | **NO** | `pos.js` writes to `orders`: **0**. POS creates `posTransactions`, never an order |
| 8 | Receipt records the manual Till reference? | **EXISTS** | tender array → `PosPrintService.payment()` → `Code:` line; deployed `a9d8dec` |
| 9 | Commission consumes the resulting sale? | **NO** | `pos-retail-mirror.js` has **0** commission refs; mirrors to `posRetailSales` for analytics, "NO payment execution" |
| 10 | Delivery on a shop-scoped order? | **EXISTS** | components on the order; custody follows the order's rail |
| 11 | Where the merchant-owned delivery gate applies | **DEFINED** | [[MERCHANT_OWNED_PAYMENTS]] §8b — before any merchant-owned order carries a non-zero delivery fee |
| 12 | Any code lets one payment span shops? | **NO** | three independent layers refuse; 29/0 suite asserts each |

**Controls run:** `checkout.html`/`cart.html`/`product.html` returning 0 was checked against
`pos.js` returning 5 for the same term, so the detector demonstrably finds it where present.
`pos.js` orders-refs of 0 was checked against `index.js` returning 20.

## B2. Three findings added 2026-08-27 — Q5 closed, two new

### Q5 — CLOSED: **EXISTS.** An unregistered shop can sell and can hold a Till

Selling is gated on **seller-agreement acknowledgement + admin approval**, not on business
registration. `application-lifecycle.js:972` states the gate: the 5% per-sale commission
(minimum KES 10) and *"the fact that SOKONI does not deduct it from the customer's payment."*
No registration or KRA-PIN requirement appears anywhere in that file.
**Control:** the probe found 8 `HttpsError` throws in the same file, so it sees requirements
where they exist.

`savePaymentDestination` throws only on: not signed in · no active shop · **shop not yours** ·
type not TILL/PAYBILL · number not 5–7 digits. **No registration check.**

> The commercial premise holds: *"start selling, upgrade your payment capability as you
> qualify"* is supported by the current authorisation design rather than fighting it.

### N1 — the payment-mode resolver **already exists**

`payment-destinations.js → resolveActiveDestination(sellerUid)` returns a tri-state that maps
onto the proposed modes exactly:

| Return | Proposed mode |
|---|---|
| `null` — no verified destination | **cannot complete checkout** |
| `{ blocked: 'production_not_authorized', destination }` | **`manual_till`** |
| `{ blocked: null, destination }` | **`daraja_stk`** |

The middle case is **not an error branch** — it is a documented state with its own reason
string, written precisely because a verified Till can exist while the platform STK rail is
unauthorised.

> **`checkoutPaymentMode` should be a PROJECTION of this function, not a new concept.**
> Introducing an independent mode field would create a second source of truth about a shop's
> payment capability — the same failure as a second commission table.

**Status: EXISTS · called by nothing.** Wiring it is the smallest possible change; defining a
parallel mode enum would be the largest mistake available here.

### N2 — partial cart clearing is **MISSING**, and it is not owned by the cart

`clear()` is `_write([])` — all or nothing. Item-level removals exist (`removeAt`,
`removeById`, `removeAllById`, `removeByCartId`); **nothing removes by seller.**

The module says why, and it is a warning worth heeding:

> *"clear() exists so the eventual checkout migration has somewhere to land. It is **NOT
> called from anywhere yet**: `checkout.html` owns cart clearing as part of the order
> lifecycle and stays closed until its own verified slice."*

So *"clear only the settled shop's items"* lands on **`checkout.html`** — a file explicitly
described as closed pending its own verified slice — not on `sokoni-cart.js`. The primitive
(`removeBySeller`) belongs in the cart module; the **caller** sits behind a gate.

**Do not assume adding `clearShop()` to the cart module completes this.** It supplies the
primitive; the lifecycle decision is elsewhere.

### What none of this changes

**G3/G4 stand.** A manual-Till sale that produces no `order` produces no commission, whichever
mode selected it. `pos.js` → `orders`: **0** (control: `index.js` → 20);
`pos-retail-mirror.js` commission refs: **0**, mirroring for analytics with *"NO payment
execution"*.

Mode resolution, partitioning and the payment page are all small. **Making a manual-Till
customer sale produce a commissionable order remains the project.**

## C. The exact gaps

**G1 — cart partitioning does not exist.** Nothing splits a cart by shop, because nothing has
ever needed to: the cart cannot become multi-shop.

**G2 — the Till flow is merchant-side only.** Zero customer-facing surface references it. A
customer has no way to reach it.

**G3 — the POS Till path produces no order.** It writes `posTransactions`; `pos.js` never
touches `orders`. The mirror to `posRetailSales` is explicitly **"NO stock write and NO payment
execution"** — analytics visibility only.

**G4 — therefore no commission.** Commission attaches to `orders` reaching `completed`
(COMMISSION_ENFORCEMENT_CONTRACT §6a). A POS Till sale never becomes an order, so it never
creates a receivable. `pos-retail-mirror.js` contains **zero** commission references.

> **G3+G4 together are the substantive finding.** Routing customer checkout to the existing
> Till flow as-is would produce sales that generate **no order and no commission** — the
> platform would transact and earn nothing, silently.

## D. What can be reused — most of it

| Component | Reuse |
|---|---|
| Seller derivation from product docs | as-is — never trust a client `sellerUid` |
| `mpesa_till_manual` semantics | as-is — `paymentVerified: false`, `paymentAttestedBy: 'operator'` |
| Reference uniqueness claim | as-is — `mpesaReferenceClaims`, deterministic, conflict-not-void |
| Receipt tender array + `Code:` line | as-is |
| Commission authority | as-is — `commission-config.js`, never a second calculator |
| Order lifecycle + 48h receivable | as-is |
| Delivery accounting | as-is; gated by [[MERCHANT_OWNED_PAYMENTS]] §8b |

**Nothing here requires a new payment rail, commission calculator, wallet, or delivery engine.**

## E. Smallest extension — if the rule is adopted

1. **Relax the cart guard** to group rather than refuse — `sokoni-cart.js` keeps `sellerOf`,
   drops the rejection, exposes `groupBySeller()`. The `sokoni:cart-rejected` event and its
   tests retire deliberately, not by accident.
2. **Partition at checkout** — one `createPaymentIntent` per shop group. The server-side
   single-seller assertion stays exactly as it is and now passes by construction.
3. **A customer-facing manual-Till payment surface** for shops without an integrated rail —
   reusing `mpesa_till_manual`, the reference claim, and the attestation fields.
4. **The real work: make a manual-Till customer sale produce an ORDER.** Without this, G4
   stands and the platform earns nothing on those sales. This is a decision about the order
   lifecycle, not a UI task.

Items 1–3 are modest. **Item 4 is the actual project.**

## F. Risks and invariants

* **Settlement invariant is preserved** — one payment, one shop, asserted at three layers.
  Nothing in this proposal weakens it.
* **The cart guard is a real safety property today.** It makes a cross-shop payment
  unreachable rather than merely rejected. Relaxing it moves the whole burden onto the server
  assertion — which is sound, but the belt-and-braces is lost. That should be a conscious
  trade.
* **Never represent manual Till money as SOKONI-observed.** `paymentVerified: false` must
  survive into any customer-facing surface. A customer-entered reference is *weaker* evidence
  than a cashier-entered one, and the record must not blur them.
* **Merchant-owned delivery gate remains in force** — §8b.
* **Do not let a manual-Till order bypass commission** merely because the money is not
  observed. Commission is due on completion, not on observing payment (§6a).

## G. Recommended order

1. **Decide whether the cart guard should be relaxed at all.** It is currently a stronger
   invariant than the proposal requires. This is the fork.
2. **If yes — resolve G3/G4 first.** How does a manual-Till customer sale become an order that
   the commission engine sees? Everything else is cosmetic beside this.
3. Then partitioning (E1–E2), which is small.
4. Then the customer-facing Till surface (E3).
5. Certify end to end: two shops in one cart → two payments → two orders → two commission
   receivables → correct receipts.
6. Delivery only after the §8b gate is satisfied.

**Do not start at step 3.** Building the UI before G3/G4 produces a checkout that takes money
and books nothing.
