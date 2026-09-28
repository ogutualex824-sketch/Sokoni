# Commission Enforcement Contract

> **R-48H — RETIRED (owner ruling 2026-09-28).** The 48-hour per-sale marketplace commission this document describes (`billingModel: PER_SALE_48H`, a 48 h `dueAt`, a 46 h reminder, the hourly `sweepCommissionDue`, penalties and `sellerRestrictions`) is REMOVED from source. All commission is billed MONTHLY via `generateMonthlyInvoices`; the commission rate authority is unchanged. Production held 0 PER_SALE_48H rows and 0 restrictions at retirement. The deployed `sweepCommissionDue` / `getCommissionBalance` / `getSellerRestriction` are deleted only by a separately authorized production operation. Kept as history.

**Status:** DRAFT — for review · **Date:** 2026-08-26
**Deployed:** no. Nothing in this contract is live.

Related: [[Payments]] · [[FinOS]] · [[SmartPOS]] · [[RECEIPT_CONTRACT]] ·
[[PAYMENT_MIGRATION_MOR]]

---

## 1. The two money flows

They are separate, and conflating them is the defect this contract exists to prevent.

| Money | Collector | Rail |
|---|---|---|
| Customer → merchant sale | **the merchant** | the merchant's own Daraja / Till |
| Merchant → SOKONI (commission, subscription, marketing, premium) | **SOKONI** | IntaSend |

```
CUSTOMER ──sale──▶ MERCHANT'S OWN TILL ──▶ MERCHANT
                                             │
                                    commission owed
                                             ▼
                                    commissionLedger
                                             │
                                        IntaSend
                                             ▼
                                          SOKONI
```

**SOKONI is not the collector for merchant sales.** It is the marketplace and
merchant operating system, and a creditor for its own fees.

### What this retires

`productionAuthorized` exists because SOKONI pushing STK with `PartyB` set to an
arbitrary merchant Till requires a Safaricom **multi-merchant** arrangement. Under the
merchant-owned model SOKONI never becomes `PartyB` for a sale, so there is nothing to
authorize.

**Do not remove that gate yet.** It stays closed until the merchant-owned model is
actually adopted — a gate removed on the strength of a plan, before the plan ships, is
how an unauthorized collection path opens.

### What `paymentDestinations` then means

Not "where SOKONI pushes STK", but **"the merchant's own collection identity, recorded
for reconciliation"**. The field names currently imply the former. Renaming is deferred,
but the meaning is fixed here so no future reader infers a collection model from a name.

---

## 2. What is due

One `commissionLedger` row per completed marketplace sale.

| Field | Rule |
|---|---|
| amount | **5% of gross, minimum KES 10** |
| `billingModel` | `PER_SALE_48H`, stamped at creation |
| `dueAt` | sale + 48h, stamped once, **never recomputed** |
| `commissionPct`, `commissionKES`, `grossAmount`, `totalOwed` | **immutable** once written |

The lifecycle moves *around* those figures; it never rewrites them. A settlement must
stay reproducible years later.

**Migration cutoff is field presence, not a date.** Rows written before this model have
no `billingModel` and no `dueAt`, and can never acquire one. A date cutoff would have made
every historical pending row overdue the moment it shipped.

---

## 3. Lifecycle

```
DUE          sale +0h              visible in Merchant OS, no restriction
REMINDED     due −2h               pre-due notice
OVERDUE      due +0h               GRACE BEGINS — banner, fully operational
RESTRICTED   grace expires         merchant operations gated
PAID         webhook confirmed     restriction cleared automatically

DISPUTED     seller contests       clock PAUSED, restriction lifted — see §6b
WAIVED       dispute upheld        receivable closed at zero, attributable
```

⚠️ **`REMINDED` is a pre-due warning, not grace.** The current implementation has no
distinct post-due grace window — it goes `OVERDUE → restricted`. Grace is a **new state**
to build, not a rename of an existing one.

⚠️ **`DISPUTED` is also a new state to build.** It is reachable from `DUE`, `REMINDED`
**and** `OVERDUE` — a merchant may contest a receivable that has already matured and
already restricted them. Its full semantics are §6b; the entry there is normative and this
table is only a summary.

### Grace is configuration, and fail-closed

`revenueConfig/commission_penalty` (name to be revised — see §7) must exist, be
`enabled: true`, **and** carry a grace duration before any restriction occurs.

> **Missing or unreadable grace configuration ⇒ NO automatic restriction, ever.**

An incomplete config must never lock a merchant out. This mirrors the existing penalty
behaviour, which already refuses to assess a fee without an explicitly configured rate.

---

## 4. What restricts, and what must not

**Restricted while unpaid**
- creating or editing listings
- marketing / campaign spend
- payouts
- accepting new orders

**Preserved unconditionally**
- sign-in
- products, shop data, order history — *nothing is deleted or hidden*
- **the payment surface itself** — a merchant must always be able to pay their way out
- anything customer-facing that would strand an order a customer has already paid the
  merchant for

A restriction that traps a paid customer order punishes the wrong person.

---

## 5. Enforcement — the security rule

> **The frontend restriction is UX. `assertNotRestricted(uid)` is enforcement.**

⚠️ **Currently only the UX half exists.** `sellerRestrictions/{sellerUid}` is
`allow write: if false` and `getSellerRestriction` is authoritative, but its only consumer
is the overlay in `merchant-v2.html`. **A restricted seller can call merchant callables
directly today and every one of them succeeds.**

Required: a shared `assertNotRestricted(uid)` guard, called by every restricted merchant
callable, reading `sellerRestrictions`. The overlay stays as the explanation; the guard is
the enforcement.

---

## 6. Payment and unlock

> **STK initiation never unlocks a merchant. Only a verified IntaSend webhook settlement does.**

A payment request being *accepted* proves nothing — the payer may never enter a PIN.

### What must be built

1. **A `commission` purpose** in `functions/payment-purposes.js`. The registry currently
   holds `digital_download`, `event_ticket`, `service_booking`, `product_order`,
   `hub_registration` — there is **no** commission purpose.
   Priced **server-side from the outstanding ledger**; the client never names the amount.
2. **A webhook branch.** `webhookIntasend` dispatches only on `purpose === "subscription"`.
   It needs a `purpose === "commission"` branch calling `settleConfirmedPayment`.
3. `settleConfirmedPayment` already exists in `functions/commission-collection.js`, is
   deliberately **not callable from a browser**, and already clears the restriction only at
   zero outstanding. **It has zero callers today** — the unlock half of the loop does not
   exist.

### Idempotency — a hard invariant

```
same IntaSend payment  →  settle ONCE
repeated webhook       →  no second ledger settlement
                       →  no duplicate unlock
                       →  no duplicate audit event
```

Webhooks arrive more than once; that is normal, not exceptional. Settlement must be keyed
on the **payment reference**, so a redelivery converges rather than double-crediting.
Partial payments reduce `totalOutstanding` and leave the row open — a partial must never
mark a row paid, and must never lift a restriction.

---

## 6a. EVIDENCE SOURCE — RESOLVED 2026-08-26

> **SELECTED: Candidate B — marketplace order completion, buyer-attested and
> server-verified.**

### The trigger

```
buyer confirms delivery
   (completeDeliveryWithPin — PIN verified server-side against a keyed HMAC,
    or buyerConfirmDelivery — the buyer acting as themselves; both Admin SDK)
        ↓
orders/{id}.status = completed          ← NOT client-writable
        ↓
one commission receivable for that order
        ↓
sellerUid is unambiguous                ← Single-Shop Checkout Invariant
```

### Invariants

| | |
|---|---|
| **Trigger** | a SOKONI marketplace order reaching `completed` through the existing buyer-attested / server-verified completion path |
| **Attribution** | the order's seller, authoritative because of [[CHECKOUT_CONTRACT]] |
| **Idempotency** | deterministic order id — **exactly one receivable per completed marketplace order** |
| **Evidence** | buyer confirmation + server verification + Admin-SDK-written completion state |
| **Rail independence** | merchant-owned Daraja collection **need not report the customer payment to SOKONI** |
| **Scope** | SOKONI marketplace orders only |

### ⚠️ What `completed` does and does not prove

> **Completion establishes that the commission receivable became due. It does NOT
> independently establish that the customer payment succeeded.**

`completed` is evidence of **fulfilment and receipt**, attested by the buyer. It is the
selected evidence that a marketplace sale occurred — not a payment confirmation. Under
merchant-owned collection SOKONI does not observe the customer's payment at all, and must
not describe an order status as though it did.

This distinction is why §6b exists.

### Why the other candidates were rejected

- **A — merchant-reported sales.** The evidence would come from the party who owes the
  money, and the incentive is **inverted from fraud**: a merchant does not forge sales,
  they omit them. That is a **completeness** failure, which no signature or authentication
  fixes. SOKONI could only ever say "this is what was admitted", never "this is what is
  owed".
- **C — Daraja reconciliation.** Requires the merchant's own API credentials or statement
  exports — their continuing cooperation to prove their own debt, plus an operational
  dependency on credentials SOKONI should not hold. Same completeness problem as A. Viable
  later as an **audit cross-check**, never as the trigger.
- **D — Safaricom C2B register-URL.** The mechanism exists and is deployed
  (`mpesaC2BValidation` / `mpesaC2BConfirmation`), but `functions/mpesa-c2b.js` records the
  blocker: *"Buy Goods (Till) has no account field at all, so reference-based
  reconciliation is only possible on a Paybill."* A Till payment carries no
  `BillRefNumber`, so a confirmation cannot say **which sale** it settles, and matching on
  amount + MSISDN + timestamp collides. Safaricom also does not sign C2B callbacks. Remains
  usable for **Paybill** merchants as a reconciliation input; it cannot be the trigger.

### The precedent this follows

`firestore.rules` already refuses to let an actor attest to a fact that pays them —
`delivered` and `completed` are not client-writable, because *"a client write of that status
was the rider authorising their own payout"*. Completion was moved behind server
verification for exactly that reason. Commission reuses that property rather than inventing
a new trust model.

---

## 6b. DISPUTE — completion without payment · **SPECIFIED 2026-08-26**

Because completion proves fulfilment and **not** payment, a merchant may legitimately face
a receivable for an order whose customer never paid them.

> **A dispute mechanism is REQUIRED. Without it, this model silently transfers the
> customer's non-payment onto the merchant.**

### D0. The governing invariant

> **A good-faith commission dispute must never mature into an automatic merchant
> restriction while it remains unresolved.**

Everything below exists to make that mechanically true, not merely intended. Three of the
clauses — D4.2, D4.3, D8 — exist because the current code would violate it by default.

### D1. This is NOT the existing dispute system

`disputes/dp_<orderId>` already exists and is **buyer → seller**, opened only by the buyer
(`createDispute` verifies `order.buyerId === uid`), 30-day window, statuses
`open` / `seller_responded` / `closed`.

A commission dispute is **merchant → SOKONI**, about the *same order id*. Reusing that
document id would collide with a live buyer dispute on the same order.

| | Buyer dispute | Commission dispute |
|---|---|---|
| Collection | `disputes` | `commissionDisputes` |
| Doc id | `dp_<orderId>` | `<ledgerRowId>` |
| Raised by | buyer | seller, or admin on their behalf |
| Against | the seller | SOKONI's receivable |
| Subject | the goods | the commission |

Deterministic id = the `commissionLedger` row id: one dispute per receivable, idempotent
under retry, mirroring the settlement-claim pattern in §6 *Idempotency*. The two systems
may reference the same order and **must not share state**.

### D2. Who may open one

* The **seller named on the receivable** — `commissionLedger.sellerUid`, verified
  server-side against the ledger row. Never client-asserted.
* **An admin, on the merchant's behalf** — support arrives by phone and WhatsApp; a
  merchant who cannot use the UI must not lose the right. Recorded with the acting uid and
  the fact that it was raised on behalf.
* **One open dispute per receivable**, guaranteed by the deterministic id.

**Window:** from receivable creation until it is `PAID` or `WAIVED`. A row that is
**already `OVERDUE`, already penalised, and already restricted remains disputable** —
restriction is not a bar to disputing. A mechanism that closes at the moment of
restriction fails exactly when it is needed.

### D3. Grounds — a closed set

| Reason | Meaning |
|---|---|
| `customer_never_paid` | The principal case. Order completed; money never arrived. |
| `order_not_fulfilled` | Completion attested but the goods did not change hands. |
| `wrong_amount` | Commission miscalculated, or the order value is wrong. |
| `duplicate` | The same sale billed twice. |
| `not_marketplace_sale` | A row exists for a walk-in or direct sale (see *Out of scope*). |

A written statement is required — minimum length, sanitised. An unrecognised reason is
**rejected**, fail-closed, matching `createDispute`'s `VALID_REASONS`.

### D4. What happens immediately — three effects, all required

**1 — State.** `collectionStatus: DISPUTED`, a new member of `CS`.

The sweep already queries `collectionStatus in [DUE, REMINDED, OVERDUE]`, so a `DISPUTED`
row leaves the state machine with **no query change**. The state must still be added to the
enum explicitly; relying on an unlisted value to fall out of an `in` filter is an accident,
not a design.

**2 — The clock pauses by arithmetic, not by exclusion.**

`dueAt` is an **absolute** timestamp and `hoursLeft` is derived from it —
`(dueMs - now) / 3600000`. Dropping a row out of the sweep freezes nothing; real time keeps
moving.

```
on open:     disputePausedAt := serverTimestamp()
on resume:   dueAt := dueAt + (resolvedAt − disputePausedAt)
```

> Without this, a row disputed at 47h and resolved a week later is **instantly `OVERDUE`**
> on the very next sweep. That is silent maturation, forbidden by D0.

**3 — An existing restriction must be actively lifted.** ⚠️ **This is a gap in the code
today, not a new requirement.**

The sweep only ever writes `restricted: true`. The **only** path that writes
`restricted: false` is `settleConfirmedPayment` — that is, *paying*. Removing a row from
the sweep therefore does **not** lift a restriction that has already been applied. It
persists indefinitely, and the merchant's sole route out is to pay the sum they are
disputing.

Opening a dispute must therefore recompute the seller's outstanding balance across their
**non-disputed** `OVERDUE` rows and:

* **nothing else overdue** → clear the restriction — `restricted: false`, `clearedAt`,
  `reason: 'dispute_opened'`;
* **other undisputed rows still overdue** → the restriction stands, but `outstandingKES`
  is recomputed to **exclude** the disputed row. A merchant must not be held against a sum
  that is under dispute.

**Penalty.** A penalty already assessed on the row is **held, not collected**, pending the
outcome. No penalty is assessed while a row is `DISPUTED`.

### D5. Who resolves

SOKONI operations, holding an `admin` / `superAdmin` claim — the same authority that
resolves buyer disputes.

* **Not the buyer.** They are an interested party to the underlying order.
* **Not the seller.** Self-resolution is self-attestation of a payout-affecting fact, which
  §5's rule already forbids.
* **Not a scheduled job.** See D8.

### D6. What evidence is weighed

* **The buyer's completion attestation** — which path (`completeDeliveryWithPin` vs
  `buyerConfirmDelivery`), the acting uid, and the server timestamp. Already on the order.
* **The merchant's statement** and any attachment they provide.

> ⚠️ **The limit, stated plainly.** Under merchant-owned collection SOKONI holds **no
> record of the customer's payment**. There is no internal ledger to consult. Resolution is
> **evidentiary and operational — never automatic.**

Where the merchant collects by **Paybill**, C2B confirmations may be admitted as
corroboration — `BillRefNumber` carries a reference. On a **Till** they cannot: a Till
confirmation carries no `BillRefNumber` and so cannot say which sale it settles
(see §6c, candidate D).

**There is no default outcome.** Inability to substantiate does not silently favour either
party; it escalates (D8).

### D7. Outcomes — a closed set

| Outcome | Receivable | Clock | Restriction | Penalty |
|---|---|---|---|---|
| `upheld` — merchant is right | `WAIVED`, `totalOutstanding: 0` | stops permanently | recomputed; lifted if nothing else is overdue | cleared |
| `rejected` — receivable stands | returns to its prior state | resumes, `dueAt` extended by the paused duration | re-evaluated at the next sweep | held penalty stands |
| `adjusted` | `totalOwed` reduced to the corrected amount, reason recorded | resumes, extended | recomputed on the new amount | recomputed |
| `withdrawn` — by the merchant | returns to its prior state | resumes, extended | re-evaluated | held penalty stands |

`WAIVED` is the **existing** state — reused, not reinvented.

> **An adjustment may only reduce.** A dispute that could *increase* a receivable would
> make disputing dangerous, and merchants would stop raising them — destroying the
> mechanism's purpose while leaving it nominally in place.

### D8. No silent expiry

* **No scheduled job may transition a dispute.** Only an authenticated resolver may.
* The sweep must never see a `DISPUTED` row — guaranteed by the query filter — and must
  never write to one.
* A dispute open beyond a defined age raises an **operations alert**. It never
  auto-resolves, in either direction.

### D9. Audit

Every transition appends to a timeline: acting uid, actor role, outcome, reason, server
timestamp — mirroring `disputes.timeline`. **A waiver must be attributable to a named
human.** Money forgiven without an attributable decision is indistinguishable from money
lost.

### D10. What must be built

- [ ] `CS.DISPUTED` added to the state enum
- [ ] `commissionDisputes` collection + rules — seller reads **own only**; **no client
      write**, Cloud Functions only, matching §5
- [ ] `openCommissionDispute` — verifies the seller against the ledger row, deterministic
      id, transactional
- [ ] `resolveCommissionDispute` — admin claim, closed outcome enum, applies D7 atomically
- [ ] **a shared restriction-recompute helper** — the lift path that today exists only
      inside `settleConfirmedPayment` (D4.3)
- [ ] `dueAt` extension arithmetic on resume (D4.2)
- [ ] merchant UI surface, and notification on open and on resolve
- [ ] tests: pause arithmetic · restriction lift on open · no auto-expiry · seller cannot
      resolve their own · adjustment cannot increase · disputing while restricted is allowed

### Out of scope

Merchant **walk-in / direct Till sales** are not marketplace sales and are **outside the
commission system entirely**. SOKONI neither observes nor bills them. Only orders that
exist in `orders` and reach `completed` create a receivable.

---

## 6c. Superseded — the question as it stood

> Resolved above on 2026-08-26. Retained because the constraint it records is still true.

Under the merchant-owned Daraja model, SOKONI does **not** receive the customer payment
through its own collection rail. The customer pays the merchant's Till directly.

Therefore the existing commission writers **cannot** establish a receivable for that sale.
Every one of them requires SOKONI to have processed the payment:

| Writer | Fires on |
|---|---|
| `index.js:4848` `onSellerPaymentCreated` | `sellerPayments`, written only by `_finalizeMarketplacePayment` and the Daraja callback |
| `index.js:7035`, `index.js:8130` | inside `webhookIntasend` |

If SOKONI never observes the sale, `sellerPayments` is never written, `webhookIntasend`
never fires, and **no commission row is ever created**.

Live evidence: all 11 existing `commissionLedger` rows are `source: intasend_webhook`,
`status: auto_collected`. Every real commission to date came from the rail being moved away
from.

**A commission trigger was required before the lifecycle could be considered complete.**
**Selected 2026-08-26: Candidate B — see §6a.** The candidate list is retained below as the
record of what was weighed and why.

Candidates as they stood:

- **A.** Merchant-reported completed sales
- **B.** Marketplace order completion as the commission trigger
- **C.** Reconciliation from the merchant's Daraja transaction data
- **D.** Another Safaricom-authorized marketplace / reconciliation mechanism

*(Historic, at the time of the decision:)* **No candidate is assumed by this contract.**
They are materially different products with
different trust models, and code must not choose the business model by default.

> **No commission receivable may be fabricated from an unverified client claim.**

### Dependency on the Checkout Contract

```
Single-Shop Checkout Invariant  →  unambiguous sellerUid  →  commission attribution
```

Whatever trigger is chosen inherits this. Before the invariant was locked, a multi-seller
order would have attributed commission to whichever seller `orderSellers[0]` happened to
be — a silent mis-attribution of money owed. [[CHECKOUT_CONTRACT]] is therefore a
**prerequisite** for any sale-reporting mechanism selected here, not a parallel concern.

### Two writers, two vocabularies

`onSellerPaymentCreated` writes `status:'pending'` + `billingModel`; the IntaSend path
writes `status:'auto_collected'` with no `billingModel`. **Only the first enters the
48-hour lifecycle** — consistent with the migration cutoff, but the contract must state
which writer owns the lifecycle once a trigger is chosen. Note also that
`generateMonthlyInvoices` and the admin views read `status`, while the lifecycle reads
`collectionStatus`: two status fields on one collection, survivable but deliberate.

---

## 7. Language

Do **not** call the overdue state a fine or penalty unless the commercial terms establish
one. The product language is:

> commission overdue → grace period → restricted account → access restored after payment

Any fee must be explicitly contractually defined and opt-in. The implementation is already
fail-closed on this; the **naming** (`commission_penalty`, `penaltyKES`, `penaltyRuleId`)
still says otherwise and should be revised, because names become product language.

---

## 8. FinOS

FinOS is the internal authority that **records and reconciles what merchants owe SOKONI**.
It is not a place customer sale money passes through.

Sequencing: settle this contract **before** resolving `finos.html`. The likely end state is
`financial-os.html` / registered FinOS owning commission receivables, rules and audit, with
`finos.html` retired — rather than registering another duplicate console to satisfy a gate.

---

## 9. Acceptance

Nothing here ships until each is proven:

1. Grace config absent ⇒ no restriction (fail-closed), with a negative control.
2. `assertNotRestricted` blocks a restricted seller **at the callable**, not just in the UI.
3. Restricted seller can still sign in, see their data, and reach the payment surface.
4. STK initiation alone does **not** unlock.
5. Verified webhook settlement clears the restriction automatically.
6. **Repeated webhook settles once** — no second settlement, unlock, or audit event.
7. Partial payment leaves the row open and the restriction in place.
8. Historical rows (no `billingModel`) are never restricted or given a deadline.
9. Immutable sale figures are unchanged by every lifecycle transition.

---

## 10. Current state

| Piece | Status |
|---|---|
| `commissionLedger` 5% / min KES 10 / 48h `dueAt` | built, undeployed |
| `DUE → REMINDED → OVERDUE` sweep | built, undeployed |
| Fail-closed penalty config | built, undeployed |
| `sellerRestrictions` (CF-write-only) | built, undeployed |
| `getSellerRestriction` + overlay | built, undeployed |
| **Grace state** | **not built** |
| **`assertNotRestricted` guard** | **not built** |
| **`commission` payment purpose** | **not built** |
| **Webhook → `settleConfirmedPayment`** | **not built** |
| Evidence source (§6a) | **resolved** — Candidate B, buyer-attested completion |
| Dispute semantics (§6b) | **specified**, not built |
| **Completion-triggered receivable** | **not built — gated on §6b landing** |
| **Restriction-lift path outside payment** (§6b D4.3) | **absent — live gap** |

> ⚠️ **§6b D4.3 records a gap in code that exists today, independent of any new work.**
> The sweep only ever writes `restricted: true`; the only path that writes
> `restricted: false` is `settleConfirmedPayment`. A restriction therefore cannot be lifted
> by any means other than paying. This must be fixed as part of the dispute work — a
> dispute that pauses the clock but leaves the merchant restricted would violate §6b D0.
| Firestore rules for both collections | frozen artifact `firestore.rules.trackb-v1` (`d0cc13f`) |

Online-order print bridge: built, mounted on `pos.html`, **paused** behind
`BRIDGE_ENABLED = false` pending this contract.
