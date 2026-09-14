# POS Retail-Sales Lifecycle Audit — trace before change

**Status:** READ-ONLY trace. No code changed. Establishes the actual authority and
invariants before any consumer is touched, per the release-work constraint.
**Method:** four independent read-only tracers (write path, rules/identity, Orders
consumers, revenue/analytics/inventory), cross-checked. Verified against current code;
supersedes the 8-day-old note that named `pos-zero-friction.js:326` the *sole* writer.

Related: [[project_posretailsales_field_divergence]] · [[reference_canonical_collections]] ·
[[project_analytics_engine]] · [[reference_pos_checkout_stock_authority]] ·
[[feedback_client_cannot_establish_financial_fact]].

---

## 1. The actual lifecycle — THREE persist paths, never converging

The "completed POS sale" is written by three different paths into **two disjoint
collections**, chosen by which front-end entry fired — not by any authority decision.

| Path | Entry point | Collection | Sale id | Owner field(s) | Money fields | Stock | Idempotent? | Aggregate |
|---|---|---|---|---|---|---|---|---|
| **TILL** | `posCompleteCheckout` `pos-zero-friction.js:326` | `posRetailSales/{saleId}` | server `uid()` | `merchantId` + `cashierId` | `grandTotal`/`taxTotal` | server, `runTransaction` | **yes** (`posIdempotency` atomic `create`) | `posDailySummary`, `posCheckoutMetrics`, `posReceipts` |
| **MIRROR** | client → `posTransactions` → trigger `mirrorPosTransactionToRetail` `pos-retail-mirror.js:46` | `posRetailSales/{txnId}` | client id passthrough | `merchantId` + `sellerId` | `grandTotal`/`taxTotal` | **client-only** (mirror writes no stock) | **yes** (det. id + exists check) | none |
| **DISPATCH** | `recordPOSSale` via `smartPosDispatch` `pos-retail-engine.js:221` | **`posSales`** (auto-id) | Firestore **auto-id** | `sellerId` + `cashierUid` | `total`/`taxAmount`/`profit` | server, **separate** `runTransaction` | **NO** | none |

Refunds/voids mutate status in place (`posProcessRefund` `pos-zero-friction.js:618`;
`voidPOSSale` `pos-retail-engine.js:426`) and write `posRefunds`.

Additional stores in the same concept-space: `posTransactions` (client-writable source),
`sellers/{sellerId}/posSales` subcollection (eTIMS status only, no creating writer — legacy),
`posReceipts` **and** `receipts` (two receipt collections), `orders` (marketplace only —
POS sales never land here; `sellerUid`, not `sellerId`).

## 2. The consumer partition — no view sees all sales

| Consumer | Reads | Owner field | Sees TILL? | Sees MIRROR? | Sees DISPATCH? |
|---|---|---|---|---|---|
| Client **Orders view** (`seller.html`→postMessage→`merchant.html` OrderService) | `posRetailSales` | `merchantId==uid` | ✅ | ✅ | ❌ |
| `getPOSAnalytics` / `getLivePOSMetrics` `pos-retail-engine.js:757,859` | `posSales` | `sellerId`, filter `createdAt` | ❌ | ❌ | ✅ |
| `pos-bi` `_fetchSales`/turnover/`biDailySnapshot` | `posSales` | `sellerId`, filter **`saleDate`** | ❌ | ❌ | ❌ (writer never writes `saleDate`) |
| `pos-intelligence.js:502,341` | both `posRetailSales`(merchantId) + `posSales`(sellerId) | mixed | ✅ | ✅ | ✅ |
| **Revenue / commission** (`commission-collection.js`, `commission.js`, `financial-os.js`) | — | — | ❌ | ❌ | ❌ |
| **Backend reconciliation** `analytics-reconcile.js` | `settlements`,`deliveryFees`,`orders` | — | ❌ | ❌ | ❌ |

- **Orders and backend analytics are disjoint:** Orders reads `posRetailSales`; analytics reads `posSales`. A sale is visible to one or the other by entry path, **never both**.
- **`pos-bi` sees nothing:** it filters `posSales` on `saleDate`, a field `recordPOSSale` never writes — so its snapshot silently excludes every DISPATCH sale. Two analytics surfaces over the same collection count different sets.
- **POS revenue is zero everywhere it matters:** no path turns a POS sale into `commissionLedger`/`settlements`, and the money-parity proof ignores POS entirely.

## 3. Target invariants (all currently VIOLATED — the audit's core output)

1. **One authoritative completed-sale record** per logical sale. — *Violated: 3 paths, 2 collections, entry-path-dependent.*
2. **Stable owner identity** on that record. — *Violated: `merchantId` vs `sellerId` vs `cashierId` vs `cashierUid`.*
3. **Stable money fields + one tax basis.** — *Violated: `grandTotal/taxTotal` vs `total/taxAmount` vs `totalAmount/totalCost`; tax hardcoded 16% (DISPATCH) vs computed (TILL); cost never persisted on `posSales` → `biDailySnapshot` profit = revenue.*
4. **Exactly-once sale + stock (idempotent).** — *Violated: DISPATCH auto-id, no key → retry writes a second sale AND a second stock decrement.*
5. **Server-authoritative stock.** — *Violated: MIRROR is client-authoritative; server never re-verifies. DISPATCH decrements stock in a transaction separate from the sale write (not atomic).*
6. **Every completed sale reaches every derived view exactly once.** — *Violated: consumer partition above.*
7. **Revenue/commission derived from the authoritative sale.** — *Violated: POS sales contribute nothing.*
8. **Reconciliation totals agree across surfaces.** — *Violated: no money reconciliation; `posDailySummary` (increments `grandTotal`) vs `posBISnapshots` (recompute over `total/totalAmount`) drift; `pos-bi` `saleDate` filter drops sales.*
9. **The served ruleset admits the authoritative read.** — *At risk: `firestore.rules.live` `posRetailSales` read lacks the `merchantId==uid` clause present in the working copy + `firestore.rules.build` → the Orders read may be **denied on production**. (Confirm against the actually-served ruleset, not the `.live` file.)*

## 4. Divergence inventory (concrete, cited)

- **D1 Collection split** — `posSales` (DISPATCH) vs `posRetailSales` (TILL/MIRROR) vs `posTransactions` (source). Same concept, three stores.
- **D2 Consumer partition** — §2; Orders and analytics disjoint.
- **D3 Owner-field spelling** — `merchantId`/`sellerId`/`cashierId`/`cashierUid`.
- **D4 Money-field spelling + basis** — §3.3; profit inflated in `biDailySnapshot` (cost→0).
- **D5 ID scheme** — server-uid / client-passthrough / auto-id (breaks the OrderService twin-collapse dedupe, which assumes `saleId == backendDocId`).
- **D6 Idempotency (hard financial defect)** — DISPATCH retry → duplicate sale + double stock decrement. *Independent of the divergence; real on its own.*
- **D7 Stock authority** — MIRROR client-authoritative; DISPATCH stock txn not atomic with sale.
- **D8 Revenue absence** — POS sales → 0 revenue/commission/settlement.
- **D9 Reconciliation gap** — `analytics-reconcile` ignores POS; no money parity anywhere.
- **D10 Aggregate drift** — `posDailySummary` vs `posBISnapshots` over different collections/fields.
- **D11 Receipt/subcollection split** — `posReceipts` vs `receipts`; eTIMS status written to `sellers/{sellerId}/posSales` (a different doc than the sale).
- **D12 Live-rules skew** — §3.9.

## 5. The authority question (the decision that gates any fix)

Before any consumer changes, one decision has to be made deliberately: **which record is the
authoritative completed sale, and which collection holds it.** The three candidates, with the
trade-off each carries:

- **`posRetailSales` (TILL/MIRROR home).** Already what the Orders view reads and carries
  `merchantId`; TILL path is server-authoritative + idempotent. Cost: backend analytics
  (`posSales`) and the MIRROR path's client-stock authority would have to move onto it; the
  live-rules skew (D12) must be closed first or the read stays denied on prod.
- **`posSales` (DISPATCH/analytics home).** Already what backend analytics/BI read and carries
  `sellerId`. Cost: it's the *non-idempotent* path (D6) and is invisible to the Orders view;
  making it canonical means fixing idempotency AND re-pointing Orders.
- **A new single settlement/transaction event** both views derive from. Cleanest long-term,
  highest coordination cost; must preserve idempotency and the server-stock invariant from day one.

No path is chosen here. This document is the trace; the authority decision, then the
derived-view convergence, is the next step — and it is release-adjacent (touches rules D12,
financial fields, and the frozen-ish POS money surfaces), so it wants the same deliberate,
candidate-then-authorize discipline as the security slices, not an in-place edit.
