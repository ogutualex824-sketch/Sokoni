# POS restock on approval (2026-10-03)

Status: **built and unit-certified. NOT deployed.**
- Branch `fix/pos-restock-on-approval-on-d4a167c`, built on the gated POS checkout line (`d4a167c`).
- Till half: `hosting/pos-till-convergence-on-863f0f6`.

Related: [[POS_TILL_CONVERGENCE_2026-10-03]] · [[Orders]] · [[SmartPOS]]

## Owner decisions (2026-10-03, relayed by sokoni-5b)

1. **Stock adjustments:** the owner, managers and an explicit `inventory` staff role adjust stock through the server, with reason, before/after, actor and a ledger row. Cashiers may not. Sales, refunds and voids move stock only through their own server flows. The browser never writes stock.
   - *sokoni-5b owns the `merchantAdjustStock` widening.*
2. **Refund/void restock:** the server restores the exact quantities **only on approval**, exactly once (idempotent), recorded in the stock ledger, never on the request. A void must not recreate a consumed entitlement.
   - *This document.*

## What was wrong on the gated line (census)

| # | Defect | Effect |
|---|---|---|
| 1 | `posProcessRefund` checked `status === 'refunded'` **outside** its transaction; the refund id came from the caller's key | Two refunds sent with different keys could both pass and return the stock **twice** |
| 2 | No stock-ledger row for a refund restock | No reason, before/after or actor recorded |
| 3 | `stock: increment(qty)` on a product with **no** stock field | Invented a count for an unmetered product (product persistence invariant: absent stock = unmetered) |
| 4 | No server void on this line (`posVoidSale` existed only on the unpushed `slice/realtime-control-plane`) | The till voided **in the browser** and wrote stock itself |
| 5 | Till `_processRefund` / `_processVoid` used a local PIN and wrote stock from the browser | Violated decision 1 |
| 6 | Till approval requests were bound to the **local** transaction id | Could never match the server sale an approval is checked against |

## The design

**One restock writer:** `functions/pos-stock-restore.js`. Both rails call `writeRestore` inside their own transaction, after every read.

- **Metered line:** `stock = before + qty` (read in-transaction), plus `inventoryVersion +1`, `updatedAt`, and the sold/revenue reversal, all in **one** update.
  - It also does `create()` of `stockMovements/{operationId}_{productId}` with `{kind: refund_restock|void_restock, before, after, delta, actorUid, reason, saleId, shopId}`.
  - `create()` means a replay can never write a second row.
- **Unmetered line** (no numeric stock, or `trackInventory: false`): nothing is written. It is reported as `{restored:false, reason:'unmetered'}` and stored on the refund as `stockNotRestored`.
- **Scope:** it touches `products` and `stockMovements` only. It never touches gift cards, loyalty, wallets or tickets.

**Refund** (`posProcessRefund`):
- **Authority unchanged:** a manager or owner (claim + canonical capability). A manager or owner carrying out the refund *is* the approval. Cashiers are refused and use *Request manager approval*.
- **One refund per sale:** the sale is now re-read **inside** the transaction. A refunded or voided sale is refused there.
- **Replays:** a replay of the same refund is an idempotent no-op.

**Void** (`posVoidSale`, new on this line; shape ported from certified B9.34):
- **Who can run it:** the caller must belong to the shop with `sell` (`resolveActor`), **and** present an approved, unexpired, unspent `void` approval bound to this sale.
- **Atomic:** the approval is consumed **inside** the same transaction (`_approvals.consume(…, txn)`, a new optional transaction mode with the same checks). A failed commit leaves the approval approved and the stock untouched.
- **Operation id:** the approval id is the operation id. The same approval replays idempotently; a different approval on a voided sale is refused.
- **No money:** the void moves zero money and no entitlement.

**Till** (`pos.js`, `sokoni-pos-approval-request.js`):
- **Refund:** calls `posProcessRefund` on `serverSaleId`.
- **Void:** calls `posVoidSale` with the approval this session raised (`PosApprovalRequest.approvalIdFor`). With no approval, the till refuses before calling.
- **Local copy:** the device mirrors **only** the lines the server restored (`localOnly: true`).
- **Offline:** offline means no refund and no void.
- **Approval binding:** approval requests now bind the server sale id.

## Not changed (owner decisions / separate slices)

- **Partial refunds:** still one refund per sale. Shift and till-takings reports read `status === 'refunded'` as the whole sale. A `partially_refunded` status would silently change those totals, so it needs its own decision and slice.
- **Approval replay on refund:** a refund retried *with an approvalId* re-presents a spent approval and is refused ("already used"). Nothing is double-restored; the manager re-approves if needed.
- **`mkHDKSm1oeIC1E4uXGXa`:** not touched. The void field certification stays owner-blocked.
- **Till loyalty-point reversal:** remains a local-cache adjustment on the device. Server loyalty is its own authority.

## Tests

- **New suite:** `scripts/test-pos-restock-on-approval.js` **16/0**. It runs the real `posProcessRefund`, `posVoidSale`, `_consumeApproval` and `resolveActor` on an in-memory Firestore with optimistic (retrying) transactions. It covers R1–R8 and V1–V7, including two concurrent refunds with different keys (exactly one restores).
  - **Mutants, each caught:**
    - drop the in-transaction refunded check → R3;
    - drop the unmetered guard → R4/V1/V2;
    - consume the void approval outside the transaction → V7.
- **Amended for the owner decision** (fixture ≠ contract):
  - refund-approval-gate 50/0 (fake transaction gains `create()`; A4 reads the absolute stock);
  - cashier-approval-request 47/0 (consumers = the execution rails only; "zero" was already stale on the base);
  - merchant-ecosystem 146/0 (refund restores through the shared restore).
- **Unchanged:** approval-primitive 31/0.
- **Till:** `test-pos-till-converged.js` **18/0** (T9a–T9e; the base fails T9a–T9d). Adapters 13/0, registry 34/0, till-payment 30/0, manual-till 57/0, sales-control-centre 61/0.
- **Not run:** `test-refund-authority-convergence` errors identically on the base (harness `TypeError`). The emulator and browser gates are blocked because host RAM is below the 512 MB floor.

## Deployment

- **Scope:** functions `posProcessRefund`, `posVoidSale` (new), and `createApprovalRequest`/the approval module (shared file).
- **Order:** deploy only with or after the gated checkout line (`d4a167c`). The till hosting change must ship **with or after** these functions; otherwise the till calls a function that does not exist yet, and its refund/void would refuse safely ("Nothing was changed").
- **Rules:** sokoni-5b writes the stock phase-2 rules hunk (browser stock writes refused) on f3's combined rules line once this is routed.

## Addendum — B2B lead invoice as a second gate reason (owner 2026-10-03)

- **Owner rule:** an issued B2B lead invoice unpaid for more than 2 days closes the supplier's till. It is a **second reason inside the one gate**, never a second lock. 2f owns the producer (`b2b-leads.leadInvoiceGate`, commercial-fn `539795c`) and this consumer.
- **The change:** `pos-commission-rail.evaluateMerchantGate` now returns `leadInvoice` with state `overdue | clear | unreadable | not_assembled`, for its own UI card, plus `closedBy`. `assertGateOpen` throws `POS_GATE_LEAD_INVOICE` when that reason closes the till.
- **Enforcement:** `LEAD_INVOICE_GATE_ENFORCED = false`, so it is display only until a certified lead-invoice Pay Now exists (the P0 principle). Once switched on in that unit, an unreadable lead state closes the gate (fail closed).
- **No new switch:** the sale rails still go through `enforceSaleGate` only.
- **Assembly:** on this line `b2b-leads.js` is absent until assembly, so the reason reports `not_assembled`. f3's assembly check (`check-b2b-functions-assembly.js`) fails closed if the module is missing from the release tree.
- **Tests:** `scripts/test-pos-lead-invoice-gate-reason.js` 8/0. Commission-rail 46/0, gate-behavioural 56/0 and gate-enforcement 42/0 are unchanged. The emulator suites are blocked (RAM).
- **Not built yet:** the UI card itself (merchant settle screen), which comes with the Pay Now hosting.
