# Phase 4 — inventory subtypes for returnable units

**Date:** 2026-08-02 · **Status:** design. **Not implemented.**
**Finding: most of this already exists. The delta is two balance buckets and five movement types.**

Related: [[ADR-010]] · [[Merchant Templates]] · [[Canonical Data Model]]

---

## What the inventory engine already is

`functions/inventory-engine.js` is **already an append-only movement ledger with balance buckets** —
which is precisely the architecture the brief asks for.

```
tenants/{tenantId}/inventory_levels/{levelId}     balances
tenants/{tenantId}/inventory_movements/{mvId}     append-only movements
tenants/{tenantId}/inventory_audit/{id}           audit log
```

Every adjustment runs inside `db.runTransaction`, appends a movement, and never overwrites history.

### Balance buckets that already exist

`available` · `reserved` · `allocated` · `incoming` · `damaged` · `expired` · `onHand`

### It already transfers between buckets

`inventoryReserve` moves quantity `available → reserved`; release moves it back with
`increment(-qty)`. **The bucket-transfer primitive the bottle workflow needs is already written and
already transactional.**

### Movement types that already exist

`sale` · `purchase` · `transfer` · `damage` · `expiry` · `theft` · `loss` · `write_off` ·
`count_adjust`

---

## The requested model, mapped against reality

| requested subtype | status |
|---|---|
| `filled` | **exists** — `available` is the sellable balance |
| `damaged` | **exists** |
| `reserved` | **exists** |
| `in_transit` | **exists** — `incoming` / `allocated` |
| `empty` | **missing** |
| `on_loan` | **missing** |
| `exchanged` | correctly *not* a balance — a movement type, as the brief states |

| requested movement | status |
|---|---|
| `sale` · `damage` · `adjustment` · `transfer` | **exist** |
| `reserve` · `release` | **exist** as operations |
| `refill` · `exchange` · `return` · `dispatch` · `receive` | **missing** |

**So Phase 4 is: two buckets, five movement types, and one generalised transfer.** Not a new
subsystem — which is the outcome the merchant template was written to produce.

## The delta

**1. Two balance buckets** on `inventory_levels`: `empty`, `onLoan`. Additive; absent means zero, so
existing levels need no backfill.

**2. Five movement types** added to the vocabulary: `refill`, `exchange`, `return`, `dispatch`,
`receive`.

**3. One generalised transfer.** `inventoryReserve` already moves between two named buckets. Generalise
it to `inventoryTransferSubtype(from, to, qty)` in the same transaction, appending a movement that
records `subtypeBefore` and `subtypeAfter` — the two fields the brief asks for and the movement record
does not yet carry.

`onHand` must exclude `empty` and `onLoan`: an empty bottle is not sellable stock, and a bottle in a
customer's kitchen is not on hand at all. **Getting this wrong would overstate sellable stock**, which
is the failure mode the whole shared-inventory design exists to prevent.

## Workflows, expressed in the existing primitives

| workflow | movement | effect |
|---|---|---|
| **Refill** (empty returned) | `exchange` | `empty +1`, `available −1`, `onLoan −1` |
| **New bottle** | `sale` | `available −1`, `onLoan +1`, deposit line item on the receipt |
| **Return only** | `return` | `empty +1`, `onLoan −1`, deposit refunded **through the refund pipeline** |
| **Damage** | `damage` | `damaged +1`, source bucket −1, reason required |
| **Refill empties → filled** | `refill` | `empty −n`, `available +n` |

**The deposit is money and never touches inventory.** It is a receipt line item and is returned via
`autoOnRefundRequest` — ADR-010. Inventory moves objects; the financial pipeline moves money.

## What must not happen

- **No `bottles` collection.** The moment bottle stock lives anywhere but `inventory_levels`, POS and
  marketplace can disagree — the exact split this programme has spent days removing.
- **No module keeping its own count.** POS, checkout, dispatch and reporting all read the same levels.
- **No overwrite.** Every change appends a movement, as the engine already does.

## Verification, before it is called done

The engine's collections are **empty in production**, so correctness cannot be measured against data —
it must be proven by test:

1. A refill leaves `available + empty + onLoan` conserved.
2. `onHand` never counts `empty` or `onLoan`.
3. Two concurrent tills selling the last bottle: one succeeds, one fails the negative-stock guard.
4. A movement exists for every balance change — no silent adjustments.
5. `damage` requires a reason.

Items 3 and 5 matter most: 3 is the oversell guarantee, and 5 is what makes a shrinking bottle count
explicable.
