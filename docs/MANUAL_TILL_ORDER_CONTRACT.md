# Manual-Till Order Lifecycle Contract

**Status:** DRAFT — nothing implemented. §4 must be decided before any code.
**Date:** 2026-08-27
**Related:** [[COMMISSION_ENFORCEMENT_CONTRACT]] · [[CHECKOUT_CONTRACT]] · [[MULTISHOP_CHECKOUT_AUDIT]] · [[POS_MANUAL_TILL_PAYMENT]]

---

## 0. The invariant this contract exists to protect

> **A payment reference is evidence supplied by the customer.**
> **Merchant POS confirmation is merchant attestation.**
> **Neither independently establishes SOKONI-observed payment.**
> **Completion establishes when the commission receivable becomes due; it does not prove
> that money moved.**

Two lifecycles run in parallel and must never be collapsed into one:

```
PAYMENT EVIDENCE          customer reference → merchant attestation → (never: SOKONI-observed)
COMMISSION                order → fulfilment → buyer-attested completion → receivable
```

## 1. ⚠️ STATE COLLISION — `awaiting_confirmation` is ALREADY TAKEN

`index.js:2260` defines `awaiting_confirmation`, and it means **"the seller must accept this
order for fulfilment."** It sits **after** payment:

```
paid  →  awaiting_confirmation  →  confirmed  →  rider_assigned  →  …  →  completed
 ↑
 └── the `paid` notification already says: "Seller will confirm shortly"
```

That is **fulfilment acceptance**, not payment attestation. Manual Till needs a state
**before** `paid`, because payment is not yet attested at all.

> **Do NOT reuse `awaiting_confirmation`.** One merchant action would then mean two different
> things — "I received your money" and "I accept your order" — and no downstream reader could
> tell which had occurred. This is the same failure as `disputes/dp_<orderId>` colliding with
> a commission dispute, and as three schemas sharing one `invoices` collection.

**Proposed distinct state:** `awaiting_payment_attestation`, strictly before `paid`.
Final naming is open; the separation is not.

## 2. Customer submits checkout

* The shop's active destination resolves to **`manual_till`** via
  `resolveActiveDestination()` — the tri-state already exists ([[MULTISHOP_CHECKOUT_AUDIT]] §N1).
  **`checkoutPaymentMode` must be a projection of that function, never a second source of
  truth** about a shop's payment capability.
* The customer sees the exact total and the shop's Till/payment instructions.
* The customer pays externally and enters the M-PESA reference.

> **The customer-supplied reference does not prove payment.** It is weaker evidence than the
> POS case, where a cashier at least saw the M-PESA SMS. The record must never present it
> otherwise.

## 3. Order enters `awaiting_payment_attestation`

| Field | Value |
|---|---|
| `paymentMethod` | `mpesa_till_manual` |
| `paymentVerified` | **`false`** |
| `paymentAttestedBy` | *(unset until §4)* |
| `paymentReference` | customer-supplied |
| `referenceSource` | **`customer`** — distinct from the POS `operator` |

* **No commission receivable** is created. Commission arises at completion (§6), never here.
* **No claim** that SOKONI observed the money.
* The reference is claimed for uniqueness through the **existing**
  `mpesaReferenceClaims` mechanism — deterministic, transactional, conflict-flags-never-voids.

> `referenceSource` distinguishes customer-entered from cashier-entered. Both are attestations;
> they are not equally strong, and a system that cannot tell them apart cannot weigh a dispute.

## 3b. FROZEN DECISIONS — ratified 2026-08-27

These are settled. They are not re-openable during implementation, and an implementation that
contradicts one is wrong by definition rather than by preference.

| # | Decision | Rationale |
|---|---|---|
| F1 | **Do NOT reuse `awaiting_confirmation`.** | It already means seller acceptance AFTER payment. One merchant action must not mean both "I received your money" and "I accept your order". |
| F2 | **Keep `referenceSource` — `customer` or `operator`.** | Evidence metadata. A customer reading a code off their own phone is weaker evidence than a cashier who saw the SMS arrive. A dispute cannot be weighed without the distinction. |
| F3 | **A timeout may NOT decide merchant silence.** | Auto-confirm lets a merchant obtain a confirmed sale by doing nothing. Auto-cancel strands a customer who genuinely paid. §4.3 stays a human/business decision. |
| F4 | **No second commission path.** | Once the order reaches `completed`, [[COMMISSION_ENFORCEMENT_CONTRACT]] §6a handles the 5% receivable exactly as for any other order. |
| F5 | **The platform-collected STK path is not weakened.** | Manual Till is an ADDITIONAL payment-attestation route, never a replacement for the working rail. |

### The consequence that must reach the code

The implementation must **never** encode:

```
manual Till payment  =  paid
```

It must encode:

```
manual Till payment  =  the customer has supplied a payment reference
                        REQUIRING merchant attestation
```

> **Only merchant POS confirmation advances the payment state.** That single distinction is
> what lets SOKONI offer walking-ecommerce checkout without ever claiming to have observed
> money it cannot observe.

## 4. 🔴 MERCHANT SILENCE — REQUIRED DECISIONS, ALL OPEN

**No implementation may proceed until these are answered.** Each has money or customer trust
attached, and none is an engineering choice.

| # | Question | Why it cannot be defaulted |
|---|---|---|
| 4.1 | **How long** may an order sit awaiting attestation? | The customer has already paid the merchant. An unbounded wait is an unbounded liability. |
| 4.2 | **Is stock reserved** during that window? | Reserve → a false reference can deny stock to real buyers. Don't reserve → a paying customer can lose the item they paid for. |
| 4.3 | What happens when the merchant **never confirms**? | Auto-cancel abandons a customer who paid. Auto-confirm manufactures an attestation nobody made. Neither is acceptable by default. |
| 4.4 | Who refunds, and **from what**, if the order is cancelled? | SOKONI never held the money. Only the merchant can refund it. |
| 4.5 | Can the **customer dispute** before attestation? | Today the only dispute path (`disputes/dp_<orderId>`) requires an order the buyer can point at. |
| 4.6 | Does repeated non-attestation affect the merchant's **capability state**? | `ACTIVE` is demotable ([[MERCHANT_OWNED_PAYMENTS]] decision 5). Silence may be the signal. |

> **4.3 is the hardest and must not be resolved by a timeout alone.** A timeout that
> auto-confirms would let a merchant obtain a confirmed sale by doing nothing. A timeout that
> auto-cancels would strand a customer who genuinely paid. The honest answer probably involves
> a human, and the contract should say so rather than pretend a scheduler can decide it.

### 4b. 4.2 + 4.3 are ONE decision, and must be answered together

Posed separately they invite contradictory answers — a stock rule that assumes a timeout, and
a silence rule that assumes stock behaviour. Reframed as a single question (ratified
2026-08-27):

> **What protection does SOKONI give the customer and the merchant during the period between
> customer reference submission and merchant POS attestation?**

Answering that one question necessarily settles all of these:

1. Whether stock is reserved
2. For how long
3. Whether another customer can buy the same stock meanwhile
4. What the customer sees while waiting
5. What the merchant is required to do
6. What happens when the merchant does not respond
7. Who handles a genuine payment with no merchant confirmation
8. Whether the order can be cancelled while awaiting attestation
9. Whether repeated non-response affects the merchant's manual-Till capability

**This is a commercial/product decision, not an engineering one.** The engineering side must
not invent it — every option below is implementable, so "what is easiest to build" is not an
input.

The window is unusual and that is why it needs deciding rather than defaulting: **the customer
has already parted with money SOKONI never saw, to a merchant SOKONI cannot audit.** Neither
party is protected by the platform holding funds, because the platform holds none.

### 4c. TRUST MODEL — ratified 2026-08-27, answers much of 4.4 and 4.5

> **SOKONI is neither the custodian of the money nor the court of first instance for an
> ordinary buyer-seller payment dispute.**

| SOKONI does | SOKONI does NOT |
|---|---|
| Approve/verify merchants and decide who qualifies as a trusted seller | Guarantee a merchant Till payment because the merchant is trusted |
| Tell the buyer plainly which payment mode they are using | Hold the customer money at any point on this rail |
| Record the order and platform-side evidence | Arbitrate every buyer-seller payment disagreement |
| Apply marketplace rules and the commission lifecycle | Act as escrow |
| Provide a mechanism to report/escalate where appropriate | Refund from funds it never received |

**Consequences for the open questions:**

* **4.4 — refund source.** SOKONI never held the money, so **only the merchant can refund it**.
  Any SOKONI-side "refund" on this rail is a record and an escalation, never a disbursement.
* **4.5 — dispute timing.** An ordinary payment disagreement on this rail is **buyer ↔ seller**.
  SOKONI supplies evidence — reference, attestation, timestamps, `referenceSource` — and a
  reporting path, not a verdict.

> **Trusted does not mean guaranteed.** Merchant verification is a statement about who SOKONI
> has approved to sell, not a warranty that a specific Till payment arrived. Conflating those
> would make SOKONI liable for money it cannot observe, on a rail it deliberately does not
> custody.

This narrows 4.4 and 4.5 considerably. **It does not answer 4.2/4.3** — what protection the
waiting window offers is still open, and is still the gate.

## 5. Merchant attests through POS

* The merchant checks their Till records/SMS and confirms.
* Order moves `awaiting_payment_attestation → paid`, with
  `paymentAttestedBy: 'merchant'` and the attesting uid recorded.
* From `paid` the order rejoins the **existing** lifecycle unchanged:
  `paid → awaiting_confirmation → confirmed → rider_assigned → … → completed`.

> This is where the two confirmations meet and must stay distinct. **Payment attestation
> (§5) and fulfilment acceptance (`awaiting_confirmation`) are separate merchant actions**,
> even if the UI eventually presents them together.

**A false attestation is possible and must be treated as a known risk**, not designed away:
a merchant can claim money they did not receive. Detection is reconciliation against their
own Till, which SOKONI cannot see. §4.6 is the lever.

## 6. Completion and commission — NO new machinery

```
buyer confirms delivery  (completeDeliveryWithPin | buyerConfirmDelivery — both Admin SDK)
        ↓
orders/{id}.status = completed          ← NOT client-writable
        ↓
ONE commission receivable, 5% / min KES 10, via commission-config.js
```

**Manual Till requires no commission engine, no calculator, and no special handling.** Because
[[COMMISSION_ENFORCEMENT_CONTRACT]] §6a attaches commission to **completion** rather than to
payment, an order created by this path earns commission exactly like any other the moment it
completes.

> This is why §6a matters here. Had commission attached at payment, a merchant-attested
> payment would create a receivable from an unverified claim — precisely what §6a was written
> to prevent.

**G4 is therefore smaller than it appeared** ([[MULTISHOP_CHECKOUT_AUDIT]] §C): the gap is not
"wire commission into manual Till", it is "make manual Till produce an order." Commission then
follows for free.

## 7. What this contract does NOT change

Cart guard · STK path · POS Till flow · `commissionSettlements` · FinOS ledger ·
`productionAuthorized` (false) · the sandbox lane · the merchant-owned delivery gate
([[MERCHANT_OWNED_PAYMENTS]] §8b).

## 9. MULTI-EMPLOYEE ORDER CLAIM — requirement, recorded 2026-08-27

A supermarket runs many tills. Ten cashiers may be logged in on ten machines under ten
accounts, and an incoming online order is visible to all of them. **Exactly one may take it.**

```
                    online order (STK or manual)
                              ↓
                  broadcast to eligible POS terminals
                    ↓        ↓        ↓         ↓
                 POS #1   POS #2   POS #3 …  POS #10
                    ↓        ↓        ↓         ↓
                    └────────┴────┬───┴─────────┘
                       atomic server-side claim
                                  ↓
                    ┌─────────────┴─────────────┐
                 CLAIMED by A            REFUSED for B–J
                                  "Already handled by another cashier"
```

### 9.1 The invariant

> **Exactly one employee/device may claim an order, and the winner is decided by an
> authoritative server-side atomic transaction — never by client timing or UI state.**

**Not** "first screen to receive the notification wins." Network latency would then decide,
and the cashier with the fastest connection would beat the one standing at the counter. The
rule is **first successful server claim wins**.

Must hold for 2, 5, 10+ terminals and for repeated double-taps, and for **10 concurrent
orders**, not one at a time.

### 9.2 ⚠️ The existing transition is NOT concurrency-safe

`orderAdvance` (`notify.js:727`, exported `index.js:12818`) owns the stage transition today
and:

* **`notify.js` contains no `runTransaction` anywhere** — verified.
* It does `.get()` then writes. A classic read-then-write race.

So two cashiers advancing the same order simultaneously can **both succeed** today. This is
not a hypothetical risk introduced by the new requirement; it is a current property of the
deployed path, and it is what the claim must fix.

A related authorization defect on `orderAdvance` is already on record (2D-2 authority census,
`orderAdvance` IDOR). **The claim work must not be treated as closing that** — they are
different defects and need separate proof.

### 9.3 States must NOT be overloaded

Employee assignment is a distinct axis from payment and from fulfilment acceptance:

```
order received  →  order viewed  →  order CLAIMED by employee  →  existing fulfilment lifecycle
```

**Do not overload:**

| State | Already means |
|---|---|
| `paid` | payment established |
| `awaiting_confirmation` | seller accepts the order for fulfilment |
| `awaiting_payment_attestation` | manual payment awaiting merchant attestation (F1) |

Claiming is *"I, this employee, am handling this"* — none of the above. Reusing one would
repeat the F1 collision, where a single merchant action would have meant two different things.

### 9.4 What the loser must NOT cause

A refused claim must produce **no** duplicate of anything:

- [ ] no second order
- [ ] no payment or payment record
- [ ] no inventory movement
- [ ] no fulfilment or rider assignment
- [ ] no commission event
- [ ] no notification to the customer

A clean refusal — *"Already handled by another employee"* — is the entire visible effect.

### 9.5 Audit

The claim must record **which authorised employee** took it: acting uid, device, timestamp.
`shopEmployees` (36 refs) and `posStaff` (20) already carry employee identity, and `pos.js`
tracks `currentCashier` (26). **Reuse them; do not invent a parallel employee model.**

> ⚠️ `shopEmployees` is recorded as **SELF-MINTABLE** in the project history. An employee
> identity used for attribution must be one the merchant actually granted — attribution built
> on a self-mintable record attributes to whoever claimed the identity.

### 9.6 Payment method is orthogonal

This applies identically to STK orders and manual Till/PayBill orders.

> **Payment method determines how payment is established. It must not determine whether a
> supermarket can have ten employees processing its incoming orders.**

### 9.7 Testing bar

Static assertions are insufficient here. The claim must be **race-tested with genuinely
concurrent callers** — N simultaneous claims against one order, asserting exactly one success
and N−1 clean refusals, repeated across multiple orders in flight.

A test that calls the claim twice in sequence proves nothing about a race.

### 9.8 Status

**REQUIREMENT RECORDED — not implemented.** No claim mechanism for orders exists today
(`assignedTo` appears only on admin tickets and CRM leads). Employee identity exists;
the atomic claim does not.


## 8. Open before implementation

- [ ] **§4.1–4.6** — all six, the blocking set
- [ ] Final state name (`awaiting_payment_attestation` proposed; must not be `awaiting_confirmation`)
- [ ] Whether `referenceSource: customer` warrants different dispute handling than `operator`
- [ ] Whether an unattested order is visible in merchant analytics, and as what

**Nothing is implemented. §4 is the gate.**
