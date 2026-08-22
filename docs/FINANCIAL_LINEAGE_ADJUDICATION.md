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

## CONCEPT 3b — Settlement gross: which field is actually consumed

### The measurement

```js
/* functions/order-settlement.js */
function _grossCents(order) {
  const total    = Number(order.orderTotal != null ? order.orderTotal : order.total) || 0;
  const delivery = Number(order.deliveryFee || 0);
  return Math.max(0, Math.round((total - delivery) * 100));
}
```

**Settlement consumes `orders.orderTotal`, falling back to `orders.total`.**
It does **not** read `paidAmount`, `escrow.held`, or `sellerPayments.amount`.

Of the three CONCEPT 1 duplicate fields, `orderTotal` is therefore the *de facto*
settlement authority — established by a preference order inside one helper, not by any
declared contract.

### The settlement path

| | |
|---|---|
| RAIL | **both — the path is rail-agnostic** |
| WRITER | `exports.onOrderStatusChange`, `onDocumentUpdated("orders/{orderId}")`, on `status → completed`, → `order-settlement.settleOrder` |
| ORDER READ | `orders/{orderId}` |
| GROSS FIELD READ | `orderTotal ?? total` |
| DELIVERY FIELD | `order.deliveryFee` — carried onto the order from the checkout session on the IntaSend rail |
| COMMISSION | `settlement-engine.computeSettlement` → `finos-utils.calculateCommission` — **the same single rate authority as CONCEPT 2** |
| SELLER NET | `breakdown.sellerNetCents`, over `gross = (orderTotal ?? total) − deliveryFee`, with the **platform-funded** discount slice added back |
| RECORDED RESULT | `settlements/{orderId}` (deterministic → exactly-once), seller wallet credit, wallet transaction, balanced ledger |

There is **one** settlement path, and it settles any order that reaches `completed`
regardless of which rail paid it.

### AUTHORITY

```
IntaSend rail                    REAL
                                 the same webhook writes orderTotal, total and
                                 escrow.held from the gateway amount, and settlement
                                 reads orderTotal. Gross is gateway-verified end to end.

Daraja rail, order created
by the payment                   REAL
                                 the absent-order branch sets total and orderTotal
                                 from the gateway paidAmount.

Daraja rail, PRE-EXISTING order  AMBIGUOUS  ← settlement-integrity concern
                                 the payment writes paidAmount and does NOT write
                                 orderTotal/total. Settlement then pays the seller on
                                 orderTotal — a field the payment never verified —
                                 while the gateway-verified figure on the very same
                                 document is ignored.
```

This resolves the question CONCEPT 3 left open, and it resolves it the unfavourable way:
the unreconciled `total` ↔ `paidAmount` relationship **is** a settlement-integrity
concern, not merely a data-model tidiness issue. If the two ever differ on a
Daraja-paid pre-existing order, the seller is paid on the unverified one and nothing
detects it.

### What is NOT wrong here

Worth stating, because the surrounding code is careful and a reader skimming the
finding could conclude otherwise:

- the commission rate is the canonical engine on every path, including settlement;
- settlement is exactly-once by deterministic document id, transactionally guarded on
  `settlementStatus`, and a replay is a no-op;
- delivery fee is excluded from seller gross deliberately and is split separately;
- the platform-funded discount slice is added back, so the merchant does not absorb
  loyalty points SOKONI itself issued;
- orders predating the discount block yield 0 and settle exactly as before.

### STILL NOT ESTABLISHED

```
who writes orderTotal on a pre-existing order          UNIDENTIFIED
whether a client may write it (served ruleset)         NOT ESTABLISHED
whether total and paidAmount ever actually diverge     NOT MEASURED — needs production
                                                       data, not source reading
```

The last one is the decisive question and **source reading cannot answer it**. A
read-only production query comparing `total`, `orderTotal` and `paidAmount` on
Daraja-paid orders would settle whether this is a live discrepancy or a latent one.

### Deliberately not done

No change to `_grossCents`. No copy of `paidAmount` into `total`. No settlement
recalculation. Recording which fact the settlement system already treats as
authoritative was the whole task, and it now has an answer: **`orderTotal`**.


---

## CONCEPT 3c — Production read-only comparison

Run: `node scripts/audit-order-gross-consistency.js` (Admin SDK, **zero write calls**).

```
orders examined:            9
payment methods present:    {"mpesa_intasend": 9}

A_CONSISTENT                  6
B_UNVERIFIED_GROSS            1
C_INTERNAL_GROSS_DIVERGENCE   0
D_SETTLEMENT_INPUT_MISSING    0
E_UNADJUDICATED               2

SETTLED while orderTotal != paidAmount:  1
```

### First: there are no Daraja orders at all

All nine are `mpesa_intasend`. **The Daraja pre-existing-order branch has never
executed in production.** The CONCEPT 3b ambiguity is therefore *latent*, not live —
it cannot have mispaid anyone yet because the rail has produced no orders.

Nine orders total is also worth stating plainly: this is pre-launch volume, and no
conclusion about production financial health should be drawn from it.

### Second: the escalation row does NOT survive inspection — and my classifier overstated it

`SKN0178R32` — `orderTotal=100, total=100, paidAmount=97, settlementStatus="settled"`.

Direct inspection of that order:

```
settlements/SKN0178R32           ABSENT
walletTransactions for order     0
settledAt                        absent
order status                     confirmed   (never reached "completed")
```

**`settleOrder` has never run for it.** Nobody was paid on 100 against a gateway 97.

Two corrections to my own audit:

1. **The escalation counter was case-broken.** It compared `settlementStatus === 'SETTLED'`
   while the stored value is `'settled'`, so it printed `0` for a record listed two
   lines below it as settled. Fixed — but it is exactly the inverted control this
   programme keeps finding, and it failed in the direction of false reassurance.
2. **`B_UNVERIFIED_GROSS` may be a category error on this rail.** `paidAmount` of 97
   against a `100` order with `deliveryFee: 0` is consistent with IntaSend reporting
   **net of gateway charges**. If so, comparing `orderTotal` to `paidAmount` compares
   gross to net, and the row is not a discrepancy at all. Recorded as a **question**,
   not a verdict; the script now carries that caveat in its own output.

**No incident is declared.** The condition you set — a settled order paid on an
unverified figure — is not met: no settlement record exists for the flagged order.

### Third, and this is the real finding: `settlementStatus` has TWO VOCABULARIES

```
functions/order-settlement.js   STATES.SETTLED = 'SETTLED'      ← uppercase
functions/index.js  _finalizeMarketplacePayment
                                paidFields.settlementStatus = opts.settlementStatus
                                and webhookIntasend passes "settled"   ← lowercase
```

`settleOrder`'s replay guard is **case-sensitive**:

```js
if (st === STATES.SETTLED)  return { outcome: 'already-settled' };   /* replay no-op */
```

A lowercase `'settled'` does not match it. Production state right now:

```
settlementStatus tally     { settled: 7, undefined: 2 }     ← 7 lowercase
order status tally         { confirmed: 5, delivered: 1, in_transit: 1,
                             pending_payment: 2 }           ← 0 completed
```

Seven of nine orders carry the lowercase marker. `settleOrder` is invoked by
`onOrderStatusChange` when an order reaches **`completed`**. If one of those seven
reaches `completed`, the guard does not match, `settleOrder` proceeds, and:

```js
t.set(wRef, { balance: FV.increment(withdrawable), … }, { merge: true });
```

`FieldValue.increment` is **not idempotent**. The deterministic ids on
`walletTransactions`, `settlements` and `ledger` make those documents replay-safe —
but the wallet balance increment is not protected by them.

```
LATENT DOUBLE-CREDIT EXPOSURE
  reachable when      an order carrying lowercase "settled" reaches status "completed"
  currently blocked   only by the fact that no order has reached "completed" yet
  nearest state       one order is "delivered" — the step before completion
```

This has **not** fired: zero settlement records, zero wallet transactions, zero
completed orders. It is an exposure, not damage.

### STATUS

```
Daraja gross ambiguity           LATENT — rail has produced no production orders
settled-on-unverified-figure     NOT FOUND — flagged row has no settlement record
paidAmount gross-vs-net          OPEN QUESTION — likely net of gateway charges
settlementStatus vocabulary      TWO, and settleOrder's replay guard is case-sensitive
double-credit exposure           LATENT, unfired, gated on the first "completed" order
```

### Deliberately not done

No field normalised, no case corrected, no guard changed, no value copied. Fixing the
vocabulary split is a code change to a money path and needs its own slice, its own
before-proof and its own deploy decision — not a patch appended to an audit.


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

---

---

---

## RELEASE B.1 — settlement exactly-once (FIX, functions-only, undeployed)

### The invariant

> For one order, the seller's withdrawable balance is credited exactly once,
> regardless of webhook delivery, trigger retry, or settlement replay.

### What was actually exposed — narrower than first reported

The before-proof corrected my own account. **A generic replay was already safe**:
`settleOrder` writes `settlementStatus: STATES.SETTLED` inside the same transaction,
so a retry sees the canonical uppercase value and no-ops (row P3 passes on the
unfixed code). The exposure was specifically the **unrecognised state string**:

```
_finalizeMarketplacePayment (index.js)  writes  "settled"   ← lowercase, 7 prod orders
order-settlement STATES.SETTLED                 "SETTLED"
guards compared with  ===
```

An order carrying the lowercase marker — already credited by the FinOS path the
marker exists to record — would settle again on reaching `completed`, crediting the
wallet a second time. One extra credit, not unbounded.

The same `===` affected **six guard sites across five functions**, and not uniformly:

| function | consequence of the lowercase value |
|---|---|
| `settleOrder` | settles an already-credited order → **double credit** |
| `markRefundedIfUnsettled` | marks a settled order REFUNDED while the seller keeps the credit |
| `reverseSettledOrder` | refuses to reverse it (`not-settled`) |
| `handleOrderRefund` | does not route a refund to the reversal path |
| `autoConfirmDeliveredOrders` | re-processes it |

### The fix — two defences, one of which is not a string

**1 · The exactly-once boundary is now a RECORD.** `settleOrder`'s transaction reads
`settlements/{orderId}` and returns `already-settled` if it exists.

Deterministic ids already made `settlements`, `walletTransactions` and `ledger`
replay-safe — a repeated `.set()` on the same id overwrites. `FieldValue.increment`
does **not** overwrite, so the balance was the single write a second pass could
double, and nothing but a string comparison stood in front of it. The record is
written in the same transaction, so a concurrent second attempt conflicts, retries,
and sees it.

**2 · `_isState()` compares canonically.** Applied at all seven comparison sites. This
does **not** rename anything and does **not** change what any writer stores —
`settlement-dashboard.html` reads the lowercase value, so re-casing the writer is a
separate and wider slice. It makes the *reader* tolerant of both spellings, which is
the half that governs money.

### Proof — `scripts/proof-settlement-exactly-once.js`

**BEFORE 7/2 → AFTER 9/0**, failing exactly the two defences added.

| | before | after |
|---|---|---|
| P1 fresh settlement credits once | PASS | PASS |
| P2 one settlement / wallet txn / ledger entry | PASS | PASS |
| P3 replay does not credit twice | PASS | PASS |
| P4 replay leaves one of each record | PASS | PASS |
| **P5 lowercase "settled" recognised** | **FAIL** | **PASS** |
| P6 CONTROL canonical "SETTLED" still blocks | PASS | PASS |
| P7 CONTROL another order's record does not block this one | PASS | PASS |
| P8 CONTROL an eligible order still settles | PASS | PASS |
| **P9 the RECORD blocks even when state says HELD** | **FAIL** | **PASS** |

No emulator and no production data: `settleOrder(db, adminSdk, orderId)` takes both
handles as parameters, so recording fakes observe every write, and
`settlement-engine` is stubbed through `require.cache`. The asserted quantity is the
**wallet balance**, not an outcome string.

P7 and P9 are the rows that stop this passing for the wrong reason. P7 proves the new
guard is not simply blocking everything; P9 proves the record guard does independent
work rather than riding on the case fix.

### Scope

`functions/order-settlement.js` only. **Not deployed** — a Functions deploy is its own
boundary. Untouched, deliberately: `orderTotal`/`total`/`paidAmount` authority, Shape-A
vs Shape-B commission, CONCEPT 4, analytics, the Daraja ambiguity, and what
`index.js` writes.

---

## RELEASE B.1 — DEPLOYED 2026-08-22, and what the deploy actually did

### The CLI exited 0 while reporting four errors

```
Error: There was an error deploying functions:
- Error Failed to set invoker function emailSubscriptionReminders in region us-central1
- Error Failed to update function accountDeactivate in region us-central1
- Error Failed to update function getTypesenseSearchKey in region us-central1
- Error Failed to set invoker function searchQueueCoordinator in region us-central1
[exited with code 0]
```

**Exit code 0 is not evidence of success here.** Neither is the log: it was piped
through `tail -60`, which discarded every per-function progress line, so the four
errors and a list of URLs are all that survived. Establishing what deployed required
asking Google, not reading the CLI.

### Per-function state — Cloud Functions v2 API

Deploy window 07:23–08:20 UTC. Every target updated inside it.

| function | state | updateTime (UTC) |
|---|---|---|
| `onOrderStatusChange` | ACTIVE | 07:32:15 |
| `getPlatformHealthScores` | ACTIVE | 08:09:57 |
| `getTopBusinessPriorities` | ACTIVE | 08:17:54 |
| `onPackageRequestChanged` | ACTIVE | 07:32:00 — **created**, 1691 → 1692 |

### The four reported errors left NO broken state

| function | trigger | outcome |
|---|---|---|
| `accountDeactivate` | callable | updated 07:45 — the "failed update" landed |
| `getTypesenseSearchKey` | callable | updated 08:13 — same |
| `emailSubscriptionReminders` | schedule | updated 07:35, **has** `run.invoker` for the compute SA |
| `searchQueueCoordinator` | schedule | updated 08:15, **has** `run.invoker` for the compute SA |

Transient retry noise on a 1692-function deploy, not damage. A control makes that
readable: `autoconfirmdeliveredorders`, which was **not** reported as failing, has
**no** `run.invoker` binding at all — so a missing binding is not itself evidence of
breakage, and the two that were reported have theirs.

> Recorded for later, not as a finding: `autoconfirmdeliveredorders` is the sweep that
> moves delivered orders to `completed`, which is what triggers settlement. Whether the
> absent binding affects it is unestablished — Firebase may invoke v2 scheduled
> functions by another path. It is unrelated to this release and predates it.

### Platform Health — verified at the query level, read-only

Both shapes run against production directly, without invoking the callable:

```
OLD  ops_reports.orderBy('__name__','desc').limit(7)   THREW 9 FAILED_PRECONDITION
NEW  getAll(7 date keys)                               SUCCEEDED — 7/7 docs present

OLD  funnelStats.orderBy('__name__','desc').limit(30)  THREW 9
NEW  getAll(30 date keys)                              SUCCEEDED — 0/30 present
```

The old query **still throws today**, so the index genuinely does not exist and the
fix is what removes the failure — not an index that quietly appeared.

**A new observation from that run:** 7 of 7 `ops_reports` documents exist but **none
carries `paymentSuccessRate`**. `_operationalHealth` will therefore compute
`avgPayRate = null` and mark that dimension missing. The code handles it correctly;
the dimension simply has no data behind it. Recorded, not fixed.

### What is NOT established by this deploy

- **The settlement guard is not directly observable.** `order-settlement.js` is a
  module inside `index.js`, not its own deployed function, so there is no deployed
  artefact to read. The evidence is: `onOrderStatusChange` updated inside the deploy
  window, the tree contained both guards, and the local proof is 9/0 including the
  P7/P9 controls. Behavioural confirmation would require settling a real order, and
  we agreed not to manufacture one.
- **POS claim shapes** need an authenticated call.
- **D1 is untouched.** `_costEfficiency()` still returns `indexCount = 192`,
  `scheduledCount = 8`, `heavyCFs = 4` and stamps `dataComplete: true`. Platform
  Health returning scores now makes it a *more convincing* untrustworthy metric, not
  a fixed one.

---

## Auto-confirm sweep — read-only inspection (concern CLOSED)

### First, a correction to my own observation

I flagged `autoconfirmdeliveredorders` as having no `run.invoker` binding. **It is not a
deployed function at all.** `autoConfirmDeliveredOrders` is a helper folded into
`exports.expireOldEscrows` — the source says so explicitly: *"Folded into THIS existing
scheduler (no new Cloud Run service)."* My IAM query hit a Cloud Run name that is not
the sweep, and `getIamPolicy` returned an empty policy rather than a 404, which read
like a finding. The concern was about the wrong object.

### The real sweep, measured

```
expireOldEscrows                      ACTIVE, updated 2026-08-22T07:35:20Z (this deploy)
firebase-schedule-expireOldEscrows-us-central1
  schedule        every 24 hours (UTC)
  state           ENABLED
  lastAttemptTime 2026-08-21T13:01:08Z
  status          {}          ← empty = the last attempt succeeded
logs              executed 08-19, 08-20, 08-21 at 13:01 UTC
```

**Healthy. No evidence of failure.** Concern closed as the sweep being operational.

### An unexplained residue, recorded not resolved

`SKN084IE2Z` — `status: delivered`, `deliveredAt` a real Timestamp **15.7 days** old,
no dispute flags, against a 3-day window (`_systemConfig/settlement` is absent, so the
default applies). Under the **pre-B.1** code it satisfied every condition in
`autoConfirmDeliveredOrders`, and the sweep ran daily for twelve of those days. It was
never auto-confirmed.

Why is **NOT ESTABLISHED**. The `functions:log` view renders the sweep's own
`console.log` bodies as empty lines, so neither
`[Maintenance] auto-confirmed N delivered order(s)` nor `auto-confirm sweep failed`
can be seen. Candidate explanations — a throw earlier in `expireOldEscrows`, or the
order reaching `delivered` more recently than `deliveredAt` suggests — are untested.

### Why this no longer matters for safety

After B.1 the same order is **correctly skipped**: `_isState('settled', STATES.SETTLED)`
now matches, so the sweep `continue`s and never advances it to `completed`. The
double-credit path is closed for it regardless of the historical reason.

And the residue is corroborating evidence rather than a worry: an order that met every
condition for twelve days under vulnerable code and was never confirmed is consistent
with the production audit finding **0 settlement records and 0 wallet transactions**.
Two independent observations agreeing that the double credit never happened.

> Standing note: this order will now remain `delivered` permanently. That is a
> reporting/lifecycle question, not a money question — the wallet was already credited
> by the path its lowercase marker records. It belongs to CONCEPT 3's close, not here.

---

## CONCEPT 3 — CLOSING CORRECTION: the settlement path I adjudicated has never run

Three findings, each of which changes an earlier conclusion in this document.

### 1 · `orders.orderTotal` is written by the BROWSER

`checkout.html` creates the order before payment:

```js
subtotal, deliveryFee, total, orderTotal: total,
status: "pending_payment",
statusHistory: [{ status: "pending_payment", at: Date.now(), by: _uid }],
```

`total` is a **client-computed cart total**. So the field `_grossCents()` consumes —
`orderTotal ?? total` — originates in the browser on every checkout-created order.

CONCEPT 1 recorded *"the value never comes from the client."* That is true of the
**webhook-created** path and false of the **checkout-created** path. Both are live.

### 2 · The pre-existing-order branch is NOT Daraja-only, and it HAS executed

Production shows two order shapes, distinguishable by `deliveryFee`:

| shape | count | orderTotal | paidAmount | deliveryFee | creator |
|---|---:|---:|---:|---|---|
| webhook-created | 6 | 97 | 97 | absent | payment (absent-order branch) |
| checkout-created | 3 | 100 | 97 / absent | `0` | browser |

`SKN0178R32` is the live instance: created by the client at **100**
(`statusHistory[0].by = <uid>`, `status: pending_payment`, `escrow: null`), paid 25
seconds later, gateway confirmed **97**, and the payment wrote only `paidAmount`.
`orderTotal` still reads 100.

CONCEPT 3c recorded the pre-existing-order ambiguity as *"latent — the Daraja rail has
produced no production orders."* The **rail** claim was right; the framing was wrong.
`_finalizeMarketplacePayment` is called by the IntaSend rail too, so the branch is
rail-agnostic and has executed.

### 3 · `settleOrder` has NEVER RUN — the money moves on another rail entirely

```
settlements collection            0 documents
walletTransactions *_ordersettle  0
```

Every actual seller credit came from a different path:

```
webhookIntasend
  amount (gateway)
  sokoniCut = calculateCommission(amount)          ← the canonical rate engine
  netShillings = amount − sokoniCut
  → wallets/{sellerUid}.balance += netShillings    DIRECT, shillings
  → walletTransactions  type "booking_earning"
  → idempotent via payments/{apiRef}.walletCreditedAt inside the transaction
  → commissionLedger/{apiRef}                      SHAPE B
  → order settlementStatus = "settled"             ← the lowercase marker
```

plus `sweepEarningsToWallet` (`every 5 minutes`) moving the cents rails
(`withdrawableBalance`/`availableBalance`) into `balance` as
`type: 'earning_settlement'` — 8 such transactions on the one seller, summing exactly
to the observed balance of 1530.

**So CONCEPT 3b adjudicated a settlement writer that has never executed.** Its analysis
of `_grossCents` remains accurate about that code; it is simply not the path the money
took.

### The safety conclusion — and it is reassuring

```
LIVE rail (FinOS webhook)   gross = GATEWAY amount        ✓ never the client figure
DORMANT rail (settleOrder)  gross = orderTotal ?? total   ✗ client-written on checkout orders
```

The client-written 100 on `SKN0178R32` was **not** used for its credit — the credit used
the gateway's 97. The client figure is consumed only by `settleOrder`, and every
IntaSend-paid order receives the lowercase `settled` marker from
`_finalizeMarketplacePayment`, so after B.1 `settleOrder` always skips them.

**Before B.1 that marker did not match the guard.** Had `settleOrder` ever run on
`SKN0178R32`, it would have paid the seller on the browser's 100 rather than the
gateway's 97 — a double credit computed from an unverified figure. B.1 closed both
halves of that at once, which was not visible when B.1 was written.

### CONCEPT 3 — CLOSE (qualified)

```
seller net, LIVE rail            REAL — gateway gross, canonical commission, idempotent
seller net, settleOrder rail     BUILT, DEPLOYED, NEVER EXECUTED
duplicate authority              TWO complete settlement implementations
orderTotal provenance            CLIENT-WRITTEN on checkout-created orders
total ↔ paidAmount               NOT a gateway-fee artefact — six orders are 97/97/97;
                                 only client-created orders diverge
served-rule immutability         STILL OPEN (clients demonstrably CREATE orders;
                                 whether they may UPDATE amounts is unestablished)
SKN084IE2Z lifecycle             OPEN — permanently `delivered`, operational not money
```

### For CONCEPT 4

The platform-revenue question now has a concrete first target: **`sokoniCut` recorded on
`commissionLedger/{apiRef}` by the webhook is the live commission fact**, not anything
`settleOrder` writes — because `settleOrder` writes nothing. Any revenue figure derived
from `settlements` or from `ledger/{orderId}_*` is derived from an **empty collection**.
