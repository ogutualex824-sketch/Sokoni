# Financial Lineage Adjudication — Release B, concept pass

**Status:** READ-ONLY. Nothing changed. No calculation touched, no value copied.
**Scope of this pass:** CONCEPT 1 (Gross Order Amount) and the entry to CONCEPT 2
(Commission). Concepts 3–7 are not started.

Companion to [[DATA_LINEAGE_REGISTER]]. See also [[reference_canonical_collections]],
[[project_commission_engine]], [[project_product_settlement]].

---

## CONCEPT 1 — Gross Order Amount

### AUTHORITATIVE FACT

```
collection      orders
document        SKN<12-hex>            (server-minted, crypto.randomBytes)
fields          orderTotal             gateway-confirmed amount
                total                  SAME VALUE, second field
                escrow.held            SAME VALUE, third copy
                deliveryFee            carried from the checkout session
                discount.{totalCents, promoCents, promoFundedBy,
                          loyaltyCents, loyaltyFundedBy}
writer          functions/index.js  ~L2862-2932   (IntaSend webhook verify path)
immutable after ORDER CREATION — see the qualification below
```

**The value never comes from the client.**

```js
const confirmedAmount = apiAmount > 0 ? apiAmount : 0; // never trust client amount
```

`apiAmount` is read back from the gateway. Two guards sit above the write: a
`payment_price_mismatch` audit when `confirmedAmount < serverTotal - 1`, and an
equivalent check against `expectedTotal`. The order document and its idempotency
record are written in **one transaction**, with a replay check that commits no writes
if the verification record already exists.

### STATUS — `REAL`, with one qualification and one open question

**Qualification — the amount is stored THREE times.** `orderTotal`, `total` and
`escrow.held` are assigned the same variable at creation. Today they cannot disagree,
because one statement writes all three. They are still three fields that a future
writer could update independently, and a reader has no way to know which is
authoritative. Recorded as a **duplicate-field** risk, not a defect: no drift exists.

**Open question — immutability is UNPROVEN, not established.** No writer in
`functions/` mutates `total`, `orderTotal` or `escrow.held` after creation; that is
verified. What is **not** verified is whether the *served* Firestore ruleset permits a
client to. `firestore.rules.live` in this repo is known stale
([[reference_deployed_ruleset_authority]]), so the repo file cannot answer it. Until
the served ruleset is read, the correct status is:

```
immutable after payment:   NOT ESTABLISHED
```

### DERIVATIONS

```
settlement gross    order-settlement    _grossCents = total − deliveryFee
                    (recorded in the writer's own comment: settling on `total`
                     alone over-paid the seller by the delivery amount)
```

### DUPLICATES — two, both LATENT

Recorded because a latent duplicate is a live one as soon as somebody wires it up.
**Neither is currently invoked.** Both were verified by looking for callers, not by
assuming from the file's comments.

**DUP-1 · `sokoni-orders.js` → `createOrder()`**

```js
const commissionPct = opts.commissionPct ?? 12;                       // hardcoded default
const commissionAmt = Math.round((opts.orderTotal || 0) * commissionPct / 100);
const sellerNet     = (opts.orderTotal || 0) - commissionAmt;         // client-side net
const driverNet     = Math.round(deliveryFee * 0.88);                 // hardcoded split
```

Takes `orderTotal` **from the caller** and writes `orderTotal`, `sokoniTotalCut` and
`escrow` to the order document. That is a second gross-amount origin, a second
commission calculation and a second seller-net calculation, all client-side.

*Callers: none.* Loaded by `admin.html`, `checkout.html`, `driver.html`,
`profile.html`, `seller.html`; invoked by nothing. The file's own header says wiring it
into checkout as-is "will break ordering platform-wide".

Classification: **DUPLICATE-AUTHORITY (latent)**.

**DUP-2 · `sokoni-payment-engine.js`**

Writes `paymentStatus: 'paid'` to an order client-side and posts ledger splits against
a `platform:revenue` account using its own `tax.commission / amt` share.

*Callers: none.* `window.SokoniPaymentEngine` is exposed and loaded by 10+ pages
including `cart.html`, `checkout.html` and `index.html`; no page calls a method on it.

Classification: **DUPLICATE-AUTHORITY (latent)**.

> Neither duplicate is a discrepancy to reconcile. Both are second implementations to
> **delete or subordinate** once the authority is confirmed — and deleting them is a
> separate slice with its own proof, not part of this adjudication.

---

## CONCEPT 2 — Commission (entry only, NOT adjudicated)

What is established so far:

| | |
|---|---|
| canonical store | `commissionLedger` ([[reference_canonical_collections]]) |
| references in `functions/` | `collection("commissionLedger")` × 11 |
| independent client calculators | DUP-1 (12% default), DUP-2 (`tax.commission / amt`) — both latent |
| authoritative calculation | **NOT YET IDENTIFIED** |

The next step is to find the single writer of `commissionLedger` and its inputs
(seller, shop, category/rate, gross, fees) — not to compare numbers between pages.

---

## Method note

Every claim above was checked for **callers**, not inferred from the code's own
comments. `createOrder` reads exactly like a live order writer, and its neighbouring
comment reads exactly like a warning about a live path; it is neither. Had this pass
reported DUP-1 as a live duplicate commission calculation — which is what it looks
like on the page — the next slice would have been sent to fix code that never runs.

## Not done, and deliberately

- CONCEPT 3 seller net · 4 platform revenue · 5 ledger · 6 analytics · 7 subscriptions,
  wallet, refunds, payouts, POS
- The served-ruleset read that would settle order-amount immutability
- Any change to `_costEfficiency()`, `f4422b4`, or any financial calculation
