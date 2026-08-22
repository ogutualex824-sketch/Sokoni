# Financial Lineage Adjudication — Release B, concept pass

**Status:** READ-ONLY. Nothing changed. No calculation touched, no value copied.
**Scope of this pass:** CONCEPT 1 (Gross Order Amount), CONCEPT 2 (Commission) and
CONCEPT 3 (gross authority for seller net). Concepts 4–7 are not started.

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


## CONCEPT 2 — Commission

### AUTHORITATIVE CALCULATION — one engine, and it holds

```
functions/finos-utils.js   calculateCommission(db, {
                             orderAmountCents, category, sellerId, hubId })
                           -> { effectiveRate, commissionCents, fixedKES, audit }
```

**Every server path computes the rate through this one function.** No second rate
engine was found on any live path. The failure branch deliberately refuses a
hardcoded fallback:

```js
/* Do not apply a hardcoded fallback rate — this would over-charge marketplace
   sellers (3%) by 7 percentage points. Instead, flag the entry for manual review */
commissionPct = null; sokoniCut = 0;   // + commissionReviewQueue entry
```

That is the correct behaviour for an unknown rate: refuse, record, escalate.

### AUTHORITATIVE FACT — one collection, TWO RECORD SHAPES

> **AMENDED BY CONCEPT 3.** The two shapes are RAIL-SEGREGATED, not redundant: an
> IntaSend payment never produces Shape A, and a Daraja payment never produces Shape B.
> The `DUPLICATE-AUTHORITY (shape)` labels below overstate the cause. The reader
> defect is unchanged. See CONCEPT 3.

`commissionLedger` is written by **three live server paths** in two incompatible
shapes.

**SHAPE A** — `exports.onSellerPaymentCreated`, trigger `sellerPayments/{paymentId}`

```
doc id     commissionLedger/{paymentId}          deterministic
fields     sellerUid, paymentId, orderId, mpesaCode, hub,
           grossAmount, commissionPct, fixedFee, commissionKES, totalOwed,
           baseRate, planId, planName, adjustment, reason, engineVersion
```

Exactly-once with respect to money: the existence check, the ledger write and the
`sellerBilling` increments are one transaction, and a redelivery returns before
incrementing. Carries the full rate audit — the rule, plan and adjustment that
produced the charge remain reproducible.

**SHAPE B** — `exports.intasendWebhook` **and** `exports.webhookIntasend`

```
doc id     commissionLedger/{apiRef}             deterministic, set+merge
fields     ref, checkoutId, uid, providerName, category,
           commissionPct, sokoniCut, providerNet, serviceTotal,
           status:"auto_collected", source
```

No audit breakdown. **Two exported HTTP endpoints write this identical record**,
distinguishable only by `source: "intasend_webhook"` vs `"webhookIntasend"`.

### The same concepts under different names

| concept | Shape A | Shape B |
|---|---|---|
| party | `sellerUid` | `uid` |
| gross | `grossAmount` | `serviceTotal` |
| commission | `commissionKES` (+`totalOwed`) | `sokoniCut` |
| counterparty net | — | `providerNet` |
| rate audit | 7 fields | none |
| precision | 2 dp | **whole KES** (`Math.round(cents/100)`) |

### DOWNSTREAM READERS — and a live consequence

```
seller-revenue.html   commissionLedger.where("sellerUid","==",uid)
                      reads .totalOwed, .grossAmount
```

Shape B records carry **no `sellerUid`** and **no `totalOwed`/`grossAmount`**. The
equality filter therefore excludes every Shape-B record from the seller revenue page —
not as a wrong number, but as an entire class of records that is silently absent.

**This is a lineage defect, not a display bug, and it is recorded — not fixed.** The
correct repair is decided at the authority level (one shape, or an explicit projection),
never by copying `uid` into `sellerUid` across the collection.

### A lineage break worth noting

Shape A's gross is `sellerPayments.amount` — **not** `orders.total`, the CONCEPT 1
authoritative fact. Whether `sellerPayments.amount` derives from the order gross is a
separate, unanswered question and is the first item of the next pass.

### CLASSIFICATION

| path | classification |
|---|---|
| `finos-utils.calculateCommission` | **REAL** — single rate authority |
| `onSellerPaymentCreated` → Shape A | **REAL** — exactly-once, audited |
| `intasendWebhook` → Shape B | **DUPLICATE-AUTHORITY** (shape) |
| `webhookIntasend` → Shape B | **DUPLICATE-AUTHORITY** (shape + duplicate endpoint) |
| `seller-revenue.html` | **DERIVED**, over an incomplete subset |
| `admin.html` (`sokoniCommissionLedger`, `sokoniCommissions` in localStorage) | **MIRROR** candidate, unadjudicated |
| `sokoni-orders.js` 12% default | **UNUSED** — no callers |
| `sokoni-payment-engine.js` share split | **UNUSED** — no callers |

### STATUS

```
rate calculation      REAL              one engine, no live duplicate
recorded fact         DUPLICATE-AUTHORITY   one collection, two shapes, three writers
reader completeness   DEFECT (recorded)     Shape B invisible to seller revenue
gross provenance      NOT ESTABLISHED       sellerPayments.amount vs orders.total
```

### Not done

Whether the two Shape-B endpoints are both *receiving* traffic (both are exported and
deployable; only production logs can say which the gateway calls). No change proposed.


---

## CONCEPT 3 — Seller Net · gross authority first

### The question was the right one, and the answer re-frames CONCEPT 2

`sellerPayments.amount` and `orders.total` are **not two authorities for one fact**.
They are the gross fact on **two different payment rails**, and the rails are mutually
exclusive by construction.

```
INTASEND RAIL   webhookIntasend / intasendWebhook
                gateway apiAmount
                   ├─→ orders.{orderTotal,total,escrow.held}   (CONCEPT 1 writer)
                   ├─→ commissionLedger/{apiRef}               SHAPE B
                   ├─→ walletTransactions
                   └─→ _finalizeMarketplacePayment(..., writeSellerPayment: FALSE)
                                                               ← no sellerPayments
DARAJA RAIL     darajaSTKCallback
                gateway paidAmount
                   ├─→ sellerPayments/{checkoutId}             amount: paidAmount
                   │      └─trigger→ commissionLedger/{paymentId}  SHAPE A
                   └─→ order finalisation (see the split below)
```

`writeSellerPayment: false` is passed **explicitly** on the IntaSend rail, and the
finaliser's own comment states why: *"the IntaSend path already records the sale via
commissionLedger + walletTransactions; only the Daraja path needs this."*

**Correction to CONCEPT 2.** That section classified Shape B as
`DUPLICATE-AUTHORITY (shape)`, which implies redundancy. The evidence is
*segregation*: one collection holding two rail-specific schemas that never describe the
same payment. The **reader consequence stands unchanged and remains a defect** —
`seller-revenue.html` still cannot see Shape B — but the cause is a shared collection
with no shared contract, not a duplicated implementation. The remaining true duplicate
in CONCEPT 2 is the pair of exported endpoints `intasendWebhook` **and**
`webhookIntasend` writing identical Shape-B records.

### AUTHORITATIVE GROSS — depends on the rail AND on whether the order pre-existed

`_finalizeMarketplacePayment` branches, and the two branches do not agree about gross:

```js
/* order EXISTS  */ txn.update(orderRef, paidFields)   // status, paymentVerified,
                                                       // paidAmount: amount
                                                       // total / orderTotal NOT written
/* order ABSENT  */ txn.set(orderRef, { …, amount, total: amount, orderTotal: amount })
```

So there is a **fourth amount field**, `orders.paidAmount`, and on the Daraja rail it is
the gateway-verified figure — while `orders.total` on a **pre-existing** order is left
exactly as it was written, by whoever created it.

```
CONCEPT 1 said:  orders.total is gateway-authoritative      (IntaSend rail — TRUE)
CONCEPT 3 finds: on the Daraja rail, for a pre-existing order,
                 orders.total is NOT written by the payment at all;
                 orders.paidAmount is the gateway figure.
```

Nothing reconciles `total` against `paidAmount`. If they differ, no code notices.

### STATUS

```
sellerPayments.amount vs orders.total   RESOLVED — rail-segregated, not competing
gross on IntaSend rail                  REAL — gateway apiAmount
gross on Daraja rail, new order         REAL — gateway paidAmount, writes all fields
gross on Daraja rail, existing order    NOT ESTABLISHED — total is inherited, and its
                                        writer is unidentified; paidAmount is the only
                                        gateway-verified figure on that document
total vs paidAmount reconciliation      NONE FOUND
SELLER NET                              NOT YET ADJUDICATED
```

### Why CONCEPT 3 does not close here

Seller net cannot be adjudicated until it is known which gross the settlement writer
consumes, and on a Daraja-rail order that gross is currently ambiguous. The next step is
the settlement writer's actual read — not a calculation review — followed by
`sellerBilling`, wallet credit and payout.

### Deliberately not done

No repair of Shape B. No reconciliation of `total` against `paidAmount`. No deletion.
Establishing who writes a pre-existing order's `total` is the next measurement, and it
connects directly to the still-open CONCEPT 1 question of whether a client can write it.


---

## Method note

Every claim above was checked for **callers**, not inferred from the code's own
comments. `createOrder` reads exactly like a live order writer, and its neighbouring
comment reads exactly like a warning about a live path; it is neither. Had this pass
reported DUP-1 as a live duplicate commission calculation — which is what it looks
like on the page — the next slice would have been sent to fix code that never runs.

## Not done, and deliberately

- CONCEPT 3 seller net · 4 platform revenue · 5 ledger · 6 settlement/payout ·
  7 analytics; then subscriptions, wallet, refunds, delivery fee, POS as separate domains
- The served-ruleset read that would settle order-amount immutability
- Any change to `_costEfficiency()`, `f4422b4`, or any financial calculation

---

---
