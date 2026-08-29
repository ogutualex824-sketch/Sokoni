# SOKONI money model — approved specification

**Specification only. No implementation, no rate changes, nothing deployed.**
2026-08-28 · rests on `694a9a9` · `158d42a` · `29e2deb` · `efae6ea`

---

## 1. Locked decisions

| # | decision |
|---|---|
| 1 | **POS/shop sale** — 5% mandatory commission per completed sale |
| 2 | **Marketplace** — commission model separate from POS |
| 3 | **Marketplace payments** — IntaSend |
| 4 | **POS/shop payments** — Daraja |
| 5 | **Marketplace delivery** — charged by default; free only on explicit shop setting |
| 6 | **Pricing** — merchant may set marketplace and shop prices independently, economics shown transparently |
| 7 | **Daily commission settlement** — new implementation, not a migration from 48h |
| 8 | **Returns/refunds** — reverse the *recorded original* economics; never recalculate at today's rates |
| 9 | **Wallet** — every financial movement traceable to its originating transaction |
| 10 | **Unknown category** — fail closed; never a silent default |
| 11 | **Merchant V2 morning gate** — settlement status drives a defined restriction state; no unconditional account lock |

### Resolved: the six orphan ledger rows

**Preserve as audit evidence. Exclude from any production financial backfill** unless a row is
*independently* proven to represent a real customer transaction. **Do not delete them to make a gate
pass.** They are the evidence for the four-unreachable-authorities finding, and deleting them would
destroy the record of how the defect was found.

Implementation: mark them (e.g. `auditArtifact: true`, `excludedFromBackfill: true`) rather than
removing. The orphan gate must then assert *no NEW orphan is created*, not that none exists.

### Resolved: freeDelivery

```
shops.freeDelivery === true   ->  seller explicitly offers free delivery
anything else                 ->  CHARGEABLE per marketplace delivery policy
```

`""`, `null`, `undefined`, `0`, `"true"`, a missing field — all chargeable. Strict `=== true`, never
truthiness, never `!== false`. The single live shop currently holds `""`, which under this rule is
chargeable.

---

## 2. The canonical economic record

One immutable row per completed transaction. Written **once**, at completion, by the rail that
collected the money.

```
transactionId          stable, server-generated
orderId · checkoutId · paymentId · commissionId
walletTransactionId · payoutId                     (backfilled as those movements occur)
sellerUid · merchantId · riderId
transactionType        POS_SHOP_SALE | MARKETPLACE_ORDER | SUBSCRIPTION | DELIVERY
rail                   DARAJA | INTASEND
grossAmount            + currency
deliveryFee            + deliveryCharged (bool) + freeDeliveryReason (nullable)
sellerCommission       the amount actually charged
riderAmount
platformNet
recordedRate           { category, pct, fixedKES, minApplied, source, engineVersion }
idempotencyKey
status
reversals[]            each referencing THIS transactionId
```

**Invariant:** `sellerNet + sellerCommission + riderAmount + platformNet == grossAmount`, asserted at
write time, not in a report.

**Invariant:** `recordedRate` explains itself. A settlement must be reproducible years later without
consulting today's config.

### The rule that makes returns enforceable

```
refund ─► locate transactionId ─► reverse the RECORDED economics
                                   (sellerCommission, riderAmount, deliveryFee as recorded)

NOT:  refund ─► recompute commission at today's rate
```

Pass three proved why this is not currently possible: live `walletTransactions.earning_settlement`
rows carry **no** `orderId`, `checkoutId`, `ref`, `paymentId`, `sourceId` or `correlationId`. **The
linkage fix is a prerequisite for returns, not a companion to them.**

---

## 3. Two design tensions to settle before building

### 3.1 The canonical record must not become a second ledger

`commissionLedger` is the existing authoritative record, protected by
`scripts/verify-commission-single-source.js`, and `7d115bc` was deliberately built to **extend** it —
*"NO SECOND LEDGER"*. A new `transactionEconomics` collection alongside it recreates exactly the
duplication this subsystem has suffered from four times.

**Two coherent options — pick one explicitly:**

* **(a) Extend `commissionLedger`** with the economic fields and the six ids. Lowest risk, keeps the
  existing guard meaningful, no migration of historical rows.
* **(b) Make `transactionEconomics` the single authority** and reduce `commissionLedger` to a
  projection. Cleaner model, but requires migration and a rewrite of every reader
  (`admin-os.js:650` already compensates for a schema split — that compensation must go, not grow).

**Not acceptable:** both as independent writable sources of truth. That is the failure mode.

### 3.2 The KES 10 minimum interacts with POS 5%

`MIN_COMMISSION_KES = 10` is live. Effective rates it produces:

| POS sale | 5% | charged | effective |
|---|---|---|---|
| KES 97 (live example) | 4.85 | **10** | **10.3%** |
| KES 200 | 10 | 10 | 5% |
| KES 380 (live POS sale) | 19 | 19 | 5% |
| KES 50 | 2.50 | **10** | **20%** |

"5% mandatory commission" and "minimum KES 10" are **different rules below KES 200**. A shop selling
low-value items pays materially more than 5%. This is a commercial decision, not an engineering one —
but it must be decided, because the code cannot honour both silently.

---

## 4. The live-trace gate — the central principle

> **No commission architecture is considered deployed because its code and tests pass. A
> certification transaction must be observed traversing rail → commission → ledger →
> wallet/obligation in production.**

This exists because four consecutive authorities were coherent, tested-looking, and unreachable:
the FinOS table (0% for its life), the hub/category rates (10% fallback for their life),
`RATES.marketplace` 3% (callers emit `product`), and the 48h lifecycle (0 rows). **Every one would
have passed a source review.**

### Gate design

1. Execute a **real** transaction of each `transactionType` on its own rail.
2. Assert, by **reading live documents** — never by reading source:
   * the economic record exists, with all applicable ids populated;
   * `recordedRate.category` is an **explicitly supported** category, not `default`;
   * entitlements sum to gross;
   * the wallet movement exists **and links back** to `transactionId`;
   * the daily obligation includes it, and names the underlying sale.
3. **Negative control:** submit an unknown category and assert
   `COMMISSION_CATEGORY_UNRESOLVED` — no money moves, nothing is written.
4. **Reversal:** refund it, assert the reversal references the original record and restores every
   entitlement to zero-drift.
5. **Coverage assertion:** count live rows whose `recordedRate.source` is `default`. Target **0**.
   Non-zero means the authority is being bypassed again — the metric that would have caught all four
   historical failures.

Gate 5 is the one to build first. It is cheap, it runs continuously, and it detects the exact class
of defect this subsystem keeps producing.

---

## 5. Sequence

1. Settle §3.1 (extend vs replace) and §3.2 (min-vs-5%). **Both are decisions, not code.**
2. Build the linkage fix — wallet movements carry `transactionId` + idempotency key. Prerequisite
   for everything else.
3. Add explicit `transactionType` categories; `pos` stops aliasing `marketplace`; unknown fails closed.
4. Coverage metric (gate 5) live and reading 0 before any rate is changed.
5. Daily settlement, re-timing `7d115bc`'s `DUE/REMINDED/OVERDUE/RESTRICTED/CLEAR` and keeping its
   fail-closed penalty config and immutable-economics rule.
6. Returns/reversal by reference.
7. Merchant V2 morning gate on top of the settled obligation state.

## 6. Out of scope

The deployed tenant-authority release and the `shopEmployees` anchor rule; the frozen wallet backend.
Neither is touched by this work.
