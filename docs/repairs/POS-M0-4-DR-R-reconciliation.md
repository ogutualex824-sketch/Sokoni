# M0-4-DR-R — Deterministic reconciliation of POS commission debts (a backstop)

**Status:** built on the POS lineage (base `91ac925`, M0-4-DR-A) 2026-09-28. **Not deployed.**
**Related:** [[FINANCIAL_CORE_ARCHITECTURE]] (M0-1 debt authority, M0-4-DR), [[POS-M0-4-DR-A-atomic-debt]],
[[POS_COMMISSION_RAIL]], [[POS-M0-4a-attempt-sweep]].

## The invariant it backs up

> A completed commission-bearing POS sale has exactly one `poscomm_<saleId>` debt.

M0-4-DR-A enforces this at the sale: the sale and its debt commit together. DR-R repairs only the **residue**, such as
historical records or exceptional states. It is **not a second debt-writing path**, and ordinary sales should never need it.

```
completed sale → poscomm_<saleId> → exists? ── yes → done (never altered)
                                     └─ no → every prerequisite PROVEN from the sale's own record?
                                               ├─ yes → the DR-A builder, create-only → RECONSTRUCTED
                                               └─ no  → NEEDS_REVIEW (reason code)
```

## What a candidate is (owner-approved 2026-09-28)

The definition comes from the sale record and the rail's own commission rules. It **never** depends on whether a debt happens to exist.

| Requirement | `posRetailSales` (`posCompleteCheckout`) | `posSales` (`recordPOSSale`) | Unproven → |
|---|---|---|---|
| Proven server sale | the id re-derives from its own `merchantId` + `idempotencyKey` through the checkout's `_saleIdFor` | exactly one `posRecordSaleClaims` record names it, for the same seller | `SALE_IDENTITY_UNPROVEN` |
| Not a SmartPOS mirror | `source !== 'pos-mirror'` | — | `OUT_OF_SCOPE` (the SmartPOS unit's) |
| Completed | `status: 'completed'` | same | `SALE_NOT_COMPLETED` |
| No void or refund | status is not voided/refunded, and no `posRefunds` record for the sale | same | `SALE_VOIDED_OR_REFUNDED` (M0-5 decides) |
| Sale time | `soldAtMs` (never `createdAt`) | the claim's `soldAtMs` | `SOLD_AT_MISSING` |
| Rail | the recorded `collectionRoute`, one the checkout's mapper names | `TILL_DIRECT` (that path's one rail) | `ROUTE_UNPROVEN` |
| Gross | `grandTotal` | the claim's `grossMinor`, equal to the sale's `total` | `GROSS_UNPROVEN` |
| Rate era | `soldAtMs` ≥ the era boundary, and the running rate table is the era's | same | `RATE_ERA_UNPROVEN` |
| Commission-bearing | `planSaleCommission` over only those facts gives `createsLiability` | same | `NOT_OWED` (custodial / zero; nothing written) |
| Business | the one resolver (`resolveDebtBusiness`) resolves it unambiguously | same | `BUSINESS_UNRESOLVED` |
| No partial or earlier billing | no `poscomm_` ledger row without its debt; no debt without its projection; no legacy `pos_commission_receivable` for the sale | same | `LEDGER_WITHOUT_DEBT` / `PROJECTION_MISSING` / `LEGACY_RECEIVABLE_PRESENT` |

**Nothing is defaulted.** DR-R never substitutes:
- `Date.now()` for a sale time;
- 0 for a gross;
- `TILL_DIRECT` for an unknown route;
- `createdAt` for `soldAtMs`;
- a business guessed from another field.

## The rate era

`planSaleCommission` prices with the rate table in the **running** code. Rebuilding an old sale with it would silently
reprice history, and production has charged 3% before this rail.

`RATE_ERA` is an immutable, versioned record:
- `rateTableSha256`: the fingerprint of `POS_PLAN_RATES`, the default plan and the KES 10 floor as of `2f4fc20` (flat 5%).
  It is checked against the running table, so any rate change invalidates the era. A new table means a new era, never
  an edit of this one.
- `fromSoldAtMs`: **the deployment boundary**, the first production moment this rail prices POS sales. It is **null**
  until the deployment commit fixes it (M0-6). While it is null, no sale is in the era and DR-R reconstructs nothing.

The era is never a caller input.

## Modes

- **`dry_run`** (the default): evaluate and report `RECONSTRUCTABLE` / `NEEDS_REVIEW` / …. It writes **nothing**: no
  debt and no outcome record.
- **`execute`**: for each sale judged `RECONSTRUCTABLE` or `NEEDS_REVIEW`, one transaction does the following.
  1. It re-reads the sale, its claim, refunds, debt, ledger rows, the outcome record and the business evidence. The
     business is re-checked by running the **same resolver** through a transaction-backed reader.
  2. It **judges again**. A sale that changed since the evaluation is judged on what it is now.
  3. Only then does it write:
     - for a reconstructable sale: the debt and its ledger projection through the DR-A builder (`buildDebt` +
       `applySaleDebtInTxn`, create-only), with `createdAtMs` set to the reconciliation time;
     - for every such sale: **one** outcome record, `posDebtReconciliation/poscomm_<saleId>`, marked `RECONSTRUCTED` or
       `NEEDS_REVIEW`. It carries the reason, the verdict at evaluation, `changedSinceEvaluation` and the era id.
  4. An outcome is written once. A re-run is a no-op (`OUTCOME_ALREADY_RECORDED`). Resolving a `NEEDS_REVIEW` is M0-5's job.

**Entry point:** `reconcilePosSaleDebts`, an onCall callable.
- SOKONI admin only (`admin` or `superAdmin` claim).
- `store` must be `posRetailSales` or `posSales`.
- A page is at most 100 sales, with an `after` cursor.
- There is no schedule; it is a backstop.
- `posDebtReconciliation` has no client rule, so it is Admin SDK only (default deny).

**Never touched:** prices, category configuration, payment status, collection, wallets, the till gate, a second builder or
schema, or an existing debt.

## Production (read-only census 2026-09-28)

| Store | Documents | Result under DR-R |
|---|---|---|
| `posRetailSales` | 5, all `completed`, auto ids (pre-0b), no `soldAtMs`; 4 without a route; 1 (`XmovY1eW…`) `CASH_IN_DRAWER` plus a legacy 3% receivable | **5 → NEEDS_REVIEW, 0 reconstructed** |
| `posSales` / claims / debts | 0 / 0 / 0 | — |

This is the fail-closed result the owner approved. The legacy 3% ledger row is **not** evidence that a modern `poscomm_*`
debt should also exist, because creating one would double-bill. `mkHDKSm1oeIC1E4uXGXa` is also the held void-chain sale.

## Evidence

- **`scripts/test-m04dr-r-reconcile.js`** runs on the Firestore emulator.
  - It uses the real `posCompleteCheckout`, `recordPOSSale` and reconciler. A residual is a real sale with its debt removed.
  - Each case targets one sale through the real page cursor.
  - **35/0 new** vs **0/35 old** (`91ac925`: no reconciler).
  - What the checks cover:
    - dry-run writes nothing across both stores;
    - a rebuilt debt equals, field for field, the one DR-A built, except `createdAtMs`;
    - an existing debt is never altered;
    - a re-run and a concurrent run add nothing;
    - every unproven prerequisite, and the production shape, go to review;
    - the shipped era, a changed table and a pre-boundary sale reconstruct nothing;
    - the callable ignores an era sent by its caller;
    - a sale voided between evaluation and transaction is reviewed, not rebuilt;
    - an injected write failure leaves nothing;
    - admin only, with validated input;
    - no wallet is written, and the gate is still OFF.
- **Mutants:** 25/25 caught, one per safeguard; 24 turn their own check red, and `claim-absent-accepted` is caught by the mutated build crashing (CHANGELOG 172).

## Boundaries

- **Not here** (each is its own repair):
  - `sale.commission` (the `finos-utils` figure on the sale) vs the rail debt;
  - `recordPOSSale`'s replay fallbacks `soldAtMs || Date.now()` and `grossMinor || 0`;
  - SmartPOS / POS QR / C2B / Till QR convergence;
  - M0-5 review resolution;
  - FC-1 and M0-4b.
- **Before any deploy:** the deploying commit sets `RATE_ERA.fromSoldAtMs` (M0-6). **Not deployed.**
