# Receipt architecture — financial record vs fulfilment record

**Date:** 2026-08-02 · **Status:** design. **Nothing implemented.**
**Principle:** *A receipt is a financial record. A delivery note is an operational record. They evolve
under different rules.*

Related: [[ADR-010 Financial Append-Only, Operational Event-Driven]] · [[ADR-005 Commit-Point Persistence Gating]] · [[Canonical Data Model]]

---

## What already exists — and it is most of this

The `orders` rule at `firestore.rules:561` already enforces the financial half, through per-role
`hasOnly()` allowlists:

| actor | may change |
|---|---|
| buyer | `status`(→`cancelled`), `cancelReason`, `updatedAt`, `review` |
| seller | `status`, `sellerNote`, `readyAt`, `trackingNo`, `updatedAt` |
| driver | `status`, `driverNote`, `updatedAt`, `pickedUpAt`, `deliveredAt`, `etaMin` |

**No financial field appears in any allowlist.** `total`, `items`, `taxes`, `discounts` and the payment
reference are already immutable to buyers, sellers and drivers. The architecture below is largely a
matter of closing three gaps rather than building a new model.

`orders/{orderId}/events/{eventId}` **already exists as a subcollection.** The event log this design
needs is not new infrastructure.

## The three gaps

### Gap 1 — a merchant cannot correct a house number

**No delivery field is in any allowlist.** Not `estate`, not `houseNumber`, not `landmark`, not
`deliveryNotes`. So today a water merchant **cannot** correct a delivery address after payment except
by acting as an admin.

This is the opposite of the assumed problem. The concern was that delivery details were *too* editable;
in fact **the core operational need of the water business is currently impossible.** That is the real
finding here, and it is what State 2 exists to fix.

### Gap 2 — `isAdmin()` is unrestricted

`allow update: if isAdmin() || (…allowlists…)`. An administrator may change **any** field, including
`total`, `items` and `taxes`, with no audit requirement. The financial record is immutable to everyone
*except* the one actor most able to cause a reconciliation problem.

### Gap 3 — no dispatch lock

Nothing freezes operational fields once an order is dispatched. `status` transitions are validated by
`validOrderStatus()`, but a driver may still rewrite `driverNote` after delivery, and a seller may
rewrite `trackingNo`.

---

## State 1 — Financial record: immutable after payment

**Locked permanently once payment succeeds:** receipt number · invoice number · order id · payment
reference · customer id · merchant id · items · quantities · unit prices · discounts · taxes ·
subtotal · total · payment method · payment timestamp.

**Never edited. Corrections create new records** — refund, credit note, adjustment, reversal — each of
which already has a pipeline (`fosSubmitRefund`, `processRefund`, `autoOnRefundRequest`, the FinOS
ledger).

**Change required:** narrow `isAdmin()` on `orders` so that even an admin cannot alter a financial
field after `paidAt` exists. An admin who needs to change money issues a financial document; they do
not edit history. This is the same rule already applied to a **paid** landlord ledger entry (ADR-006),
where the landlord cannot edit and only an admin may delete — and it should be tightened here for the
same reason.

### Naming — resolve before implementing

Three fields are in use across the codebase for one concept:

| field | occurrences |
|---|---|
| `receiptNo` | 63 |
| `receiptNumber` | 45 |
| `invoiceNumber` | 53 |

`invoiceNumber` is a genuinely different document (an invoice is not a receipt). **`receiptNo` and
`receiptNumber` are the same thing under two names** and belong in the canonical model work — see
ADR-009. Freezing a field whose name is ambiguous would freeze the ambiguity.

## State 2 — Fulfilment record: mutable until dispatch

**Editable:** customer phone correction · estate · house number · apartment · landmark · delivery
notes · delivery instructions · driver assignment · preferred delivery window.

**Where it lives.** A `fulfilment` map on the order, not a parallel collection. A second document
would need reconciling with the order, and this platform has spent two days removing exactly that
shape. One order, one fulfilment map, one financial section.

**Every edit appends to `orders/{orderId}/events`** — the subcollection that already exists — with:

```
{ type: 'fulfilment_edit', field, previousValue, newValue,
  reason, editorUid, at: serverTimestamp() }
```

`reason` is **required**, not optional. An audit trail of *what* changed without *why* answers the
easy question and not the useful one.

**Change required:** add the fulfilment fields to the seller's `hasOnly()` allowlist, gated on the
order not being dispatched, and require the event write. Rules cannot enforce "and also write an
event", so the write belongs in a callable — `orderUpdateFulfilment` — with the rule narrowed so the
client cannot write these fields directly.

## State 3 — Dispatch lock

Once `status` reaches `dispatched`, **fulfilment becomes immutable too**.

Later operational change happens through dedicated events, never by editing history:

`failed_delivery` · `return` · `redelivery` · `cancellation` · `exchange`

Each appends to `orders/{orderId}/events`. The original delivery record stands as what was attempted;
a redelivery is a new attempt, not a rewrite of the first.

## Water supplier extension — bottle lifecycle

Returnable-unit movements are **fulfilment events**, never receipt edits:

`bottle_exchanged` · `empty_returned` · `deposit_collected` · `deposit_refunded` · `bottle_damaged`

A deposit is money and therefore belongs to State 1 — it appears on the receipt as a line item and is
refunded through the refund pipeline, **not** by editing the original sale. The *movement* of the
physical bottle is a State 2 event and adjusts inventory `subtype` (Phase 4).

This keeps the invariant that made the landlord ledger correct: **the thing that moves money is
append-only; the thing that moves objects is an event stream.**

## Implementation order, when approved

1. **Resolve `receiptNo` vs `receiptNumber`** — do not freeze an ambiguous name.
2. **Add the fulfilment map + `orderUpdateFulfilment` callable** with the required event write.
   *Closes Gap 1 — the water merchant's actual blocker.*
3. **Narrow `isAdmin()`** on financial fields once `paidAt` exists. *Closes Gap 2.*
4. **Dispatch lock** in the callable and the rule. *Closes Gap 3.*
5. **Bottle events** on top of Phase 4's inventory subtypes.

Steps 2 and 3 are independently valuable and independently verifiable. Step 3 changes what
administrators can do and should not be bundled with anything else.

## Risks

- **Narrowing `isAdmin()` could block a legitimate correction** that currently has no other route.
  Ship the refund/credit-note path first, verify it, then narrow.
- **A required `reason` adds friction** at the counter. That is the intended trade: an unexplained
  address change on a paid order is the thing being prevented.
- **Nothing here is retroactive.** Existing orders have no `fulfilment` map; readers must treat its
  absence as "not yet migrated", not as empty.
