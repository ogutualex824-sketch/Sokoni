# ADR — `inventoryReceivePO`: rewrite, not converge

**Status:** ✅ **ACCEPTED** (2026-09-03) — decision recorded. **Implementation NOT authorized.**
Recording this decision does not authorize code changes, migration, or deployment — each remains
a separate, explicitly gated step.
**Raised by:** `docs/INVENTORYRECEIVEPO_TRACE.md`, per the read-only architecture-decision slice
requested before further release-stack work.

---

## The decision

> **`inventory_purchaseOrders` represents real capability `procPurchaseOrders` does not have.
> Option A (rewrite) is accepted. Option B (converge) is rejected as the default.**

`inventoryReceivePO` keeps its target collection. Its three defects (disconnected PO lookup,
non-idempotent movement ID, blind increment) get fixed by adopting the exact pattern
`functions/receipt-bridge.js` already proves correct — not by deleting the collection and routing
everything through `procPurchaseOrders` instead.

---

## The question, answered with evidence

**Does `inventory_purchaseOrders` represent anything `procPurchaseOrders` does not?** Compared
directly, function by function, not assumed:

| capability | `procPurchaseOrders` (`procurement.js`) | `inventory_purchaseOrders` (`inventory-engine.js` / `inventory-workflows.js` / `sokoni-inventory.js`) |
|---|---|---|
| Supplier validation (belongs to merchant, active) | ✅ (`createPurchaseOrder`, lines 332-341) | not found |
| VAT calculation | ✅ (`subtotal`/`vatAmount`/`total`, server-computed) | not found |
| Deterministic PO ID (dedupes a client retry) | ✅ `_deterministicId(seed, 'po')` from `merchantId|supplierId|Date.now()` | ❌ random (`` `po_${uid6()}` `` client-side, or Firestore auto-ID server-side) |
| Sequential human-readable PO number | ✅ transactional counter (`procCounters`), collision-safe across concurrent creates | client-side `_generatePONumber()` — not verified transactional |
| Approval workflow (`approvedBy`/`approvedAt`) | ✅ | not found |
| Supplier invoicing + payment (`createSupplierInvoice`, `approveAndPayInvoice`) | ✅ | ❌ |
| **Warehouse-level scoping** | ❌ — zero references to `warehouseId` anywhere in `procurement.js` | ✅ every write is `warehouseId`-scoped (`inventoryReceivePO` line 448/461/469) |
| **Offline-first client creation** | ❌ — `createPurchaseOrder` is a plain `onCall`, requires connectivity | ✅ `sokoni-inventory.js:createPO` writes IndexedDB first unconditionally, syncs to Firestore only `if (_online)`, else queues (`_enqueue`) for later |
| **Automated, rule-triggered reorder creation** | ❌ — `procurement.js`'s `reorderQty`/`suggestedReorderQty` references are read-only forecast output (`getProcurementForecast`), not a creation trigger | ✅ `inventory-workflows.js`'s `_executeAction('create_po', ...)`, driven by tenant-configured condition/action rules (e.g. "stock below threshold → create PO") |
| Idempotent, transactional receipt-to-inventory application | ✅ (via `receipt-bridge.js`, wired into `receiveGoods`) | ❌ — exactly `inventoryReceivePO`'s bug |

**Answer: yes, decisively.** `inventory_purchaseOrders` is warehouse-aware, offline-resilient, and
automation-capable in ways `procPurchaseOrders` structurally is not (no warehouse concept exists
there at all). `procPurchaseOrders` is financially rigorous and approval-gated in ways
`inventory_purchaseOrders` is not. **These are not one system duplicated — they are two systems
built for different operating conditions**, and only one specific piece of one of them
(`inventoryReceivePO`'s receipt-application logic) is actually broken.

---

## What this means for the two options

### A. Rewrite — **accepted**
`inventoryReceivePO` adopts `receipt-bridge.js`'s proven idempotency pattern (per-line idempotency
via reading the movement document inside the transaction; all reads before any write, per ADR-013)
against its own collection (`inventory_purchaseOrders`, warehouse-scoped). This fixes the three
confirmed defects without discarding warehouse-scoping, offline creation, or automated reorder —
none of which `procPurchaseOrders` could absorb without itself being extended to support them,
which is a materially larger undertaking than fixing one handler's idempotency.

### B. Converge — **rejected as the default**
Retiring `inventory_purchaseOrders` onto `procPurchaseOrders` would require `procPurchaseOrders`
to first gain warehouse scoping, offline-first client semantics, and a rule-triggered creation
path — none of which exist there today. Attempting this convergence now would be building three
new capabilities into the "canonical" engine under cover of a cleanup, which is a scope the
`inventoryReceivePO` trace was never asked to authorize. **Not ruled out forever** — if a future
decision deliberately extends `procPurchaseOrders` to cover warehouse/offline/automation, this
ADR's premise changes and should be revisited. Not the case today.

---

## What this ADR forbids

- **No implementation yet.** This records a direction; it does not authorize touching
  `functions/inventory-engine.js`, `functions/receipt-bridge.js`, or any release branch.
- **No deleting `inventory_purchaseOrders`, `inventoryReceivePO`, or their client/server writers**
  on the strength of this decision. The opposite direction is what's accepted.
- **No silently extending `procPurchaseOrders` with warehouse/offline/automation** as a side effect
  of some other change — that would be re-opening Option B without saying so.
- **No treating zero production traffic as evidence either option is safe to skip evaluating.**
  Both `inventoryReceivePO` and the canonical `receiveGoods` show zero real invocations in the
  30-day window (per the trace) — traffic level was explicitly not the deciding factor here;
  capability comparison was.

## Related

`docs/INVENTORYRECEIVEPO_TRACE.md` (the evidence this decision rests on) ·
`docs/adr/ADR-018c-purchase-order-batch-disposition.md` (the sibling `posPurchaseOrders`/
`procPurchaseOrders` disposition from 18c — a third, separate PO model, not addressed here) ·
`docs/R1_RELEASE_STACK_MATRIX.md` (`receipt-bridge.js` certification, 53/0)

**If reused later:** re-verify this comparison against the actual `procurement.js`/
`inventory-engine.js` source at the time — this ADR pins its evidence to the state read on
2026-09-03; if either module gains new capability since, the table above needs a refresh before
being relied on again.
