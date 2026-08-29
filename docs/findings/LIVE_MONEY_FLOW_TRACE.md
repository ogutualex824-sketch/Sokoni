# Third pass — live money-flow trace

**Read-only. Nothing repaired, no rates chosen. No code, rules, IAM, indexes, payment config,
wallets, production data or deployment config modified. Nothing deployed. No code committed.**
2026-08-28 · builds on `694a9a9` and `158d42a` · evidence read from live Firestore

Labels: **PROVEN LIVE** · **PROVEN IN CODE** · **INFERRED** · **UNPROVEN**.

Method: real reference ids followed across collections with Firestore `runQuery`. The probe
carries a **control** — a `checkoutId` known to exist in `sellerPayments` — and the trace aborts
if that control fails to match, because a query that finds nothing and a broken query look
identical. **Control result: MATCHED, mechanism works.** Every "no match" below is therefore
meaningful.

---

## FINDING 1 — the commission ledger is disconnected from everything. PROVEN LIVE

Six ledger entries followed by `checkoutId` across `orders`, `sellerPayments`, `payments`,
`checkouts`, `walletTransactions`, `providerPayouts`, `payoutRequests`, `wallets`,
`posRetailSales`, on the fields `checkoutId`, `ref`, `paymentRef`:

```
SKN0178R32  YEXBE4X  97/10/87  ->  NOTHING
SKN084IE2Z  Y586Z75  97/10/87  ->  NOTHING
SKN0KNUCBS  Y625BQ3  97/10/87  ->  NOTHING
SKN0SWYXPD  YM4RMBP  97/10/87  ->  NOTHING
SKN0V9YUTN  YM4NQ6R  97/10/87  ->  NOTHING
SKN139MVBH  YRM5X6G  97/10/87  ->  NOTHING
```

**No order, payment, checkout, wallet transaction or payout references any of these checkouts.**
Commission was recorded as `auto_collected` against transactions that have no counterpart record
anywhere else in the database.

### Caveat, stated rather than buried

All six carry **identical** amounts (97 / 10 / 87) with different checkout ids, and the one
`sellerPayments` document sampled in pass two carried `isTest: true`. **INFERRED:** this ledger is
substantially or wholly test traffic. That does **not** weaken findings about *mechanism* — the
category fallthrough, the missing linkage, the schema split are all real — but it does mean this
is **not** evidence about the volume or economics of real customer commerce. Do not quote the
5%-across-the-board result as a statement about production revenue.

## FINDING 2 — the seller IS credited, but the credit cannot be reconciled. PROVEN LIVE

```
walletTransactions
  type=earning_settlement  amount=87  status=completed   linkage fields: NONE   (x4)
  type=booking_earning     amount=80  status=completed   linkage fields: sourceId
```

`amount 87` matches the ledger's `providerNet`, so the credit path works. But the
`earning_settlement` rows carry **no `orderId`, `checkoutId`, `ref`, `paymentId`, `sourceId` or
`correlationId`**. A different transaction type (`booking_earning`) *does* carry `sourceId`.

**Consequence:** a seller's wallet balance cannot be traced back to the orders that produced it.
This is exactly the "wallet balance that cannot be reconciled back to an order" the brief asked
about — **and it is the precondition for correct returns**. A refund cannot reverse a credit it
cannot identify.

## FINDING 3 — no refund has ever been recorded. PROVEN LIVE

```
refunds                 EMPTY
posRefunds              EMPTY
commissionReviewQueue   EMPTY
oversoldAlerts          2 docs (carry orderId)
```

Refund and commission-reversal paths are **UNEXERCISED**, not proven broken. Given Finding 2,
**INFERRED:** a marketplace refund could not currently reverse the seller credit by reference, only
by recomputation — which is the failure mode the brief explicitly wants avoided.

`commissionReviewQueue` being empty also means the webhook's fail-safe (flag for manual review when
commission calculation throws) has never fired: the calculation has always "succeeded" — by
returning the default.

## FINDING 4 — no withdrawal has ever completed. PROVEN LIVE

```
payoutRequests
  pout_AiJp5yzT…  amount=100   fee=0     net=100   status=failed     mode=review  intasendRef=null
  pout_D5Ql2EYr…  amount=1000  fee=0     net=1000  status=failed     mode=review  intasendRef=null
  pout_xrH21J5G…  amount=100   fee=null  net=null  status=rejected   mode=null    intasendRef=null
```

All failed or rejected, no `intasendRef` on any. The seller withdrawal path is **UNPROVEN
end-to-end**; the rider withdrawal path was not observed at all.

## FINDING 5 — wallet documents are structurally inconsistent. PROVEN LIVE

Three sampled `wallets` documents return `entityType`, `availableBalance`, `withdrawableBalance`,
`pendingBalance`, `lifetimeEarnings` all **null**, while the seller wallet queried by uid in the
same run *does* carry them. Wallet shape is not uniform across the collection.

---

## The money map as it actually exists

```
IntaSend  ──►  webhookIntasend  ──►  commissionLedger        (category -> DEFAULT 5%)
                                          │
                                          ├── sokoniCut   10   ─► (no platform ledger observed)
                                          └── providerNet 87   ─► walletTransactions
                                                                    earning_settlement 87
                                                                    NO LINK BACK  ◄── breaks returns
                          ✗ no orders / payments / checkouts document for any of these
Daraja/STK ──►  sellerPayments (isTest)  ──►  index.js:4732 trigger  ──►  commissionLedger
                                                   (schema never observed live)
POS       ──►  posRetailSales   ──►  commission field present on SOME sales only
                                     ✗ never reaches commissionLedger
Withdrawal ──►  payoutRequests   ──►  all failed/rejected, no intasendRef
```

### Answers to the enumerated questions

| question | status |
|---|---|
| marketplace order → IntaSend → webhook → ledger | **PROVEN LIVE** (ledger written; upstream order record ABSENT) |
| order / payment record | **PROVEN LIVE: absent** for every traced checkout |
| commission calculation | **PROVEN IN CODE + LIVE**: `default` arm, 5% |
| seller entitlement / wallet credit | **PROVEN LIVE**: credited `providerNet`, unlinked |
| rider entitlement / wallet credit | **UNPROVEN** — none observed |
| delivery fee / free-delivery control | **UNPROVEN** — no delivery-bearing order traced |
| dispatch / delivered state | **UNPROVEN** |
| cancellation / return / refund | **PROVEN LIVE: never exercised** |
| commission reversal | **UNPROVEN** (no instance exists) |
| wallet reversal | **UNPROVEN**; **INFERRED unreliable** by Finding 2 |
| seller withdrawal | **PROVEN LIVE: never succeeded** |
| rider withdrawal | **UNPROVEN** |
| idempotency at money boundaries | **MIXED** — `commissionLedger` keyed on `apiRef` and written with `.set()` (idempotent, PROVEN IN CODE); the `sellerPayments` trigger uses a transaction + deterministic id (PROVEN IN CODE); `walletTransactions` linkage absent so replay-safety is **UNPROVEN** |

### Duplicated authorities, mismatches, silent defaults, crossings

* **Duplicated:** commission block twice in `index.js` (~6792 / ~7910, different `source` values);
  two schemas into `commissionLedger`; `platform-core.js` rate table; `0.88` in two modules.
* **Vocabulary mismatch:** `product`, `hair-beauty`, `subscription` vs `marketplace`, `services`,
  `subscriptions`. **`subscription` → 5% instead of 100%** is a material misclassification.
* **Silent defaults:** the `default` arm of `calculateCommission`; `config.commissionRate || 5` in
  `platform-core.js:231`.
* **POS ↔ marketplace crossing:** `ALIASES.pos = 'marketplace'` — one rate for both.
* **Daraja ↔ IntaSend crossing:** `financial-os.js` and `finos-router.js` sit on both rails.
* **Money duplication risk:** `walletTransactions` has no idempotency key or source link, so a
  replayed settlement cannot be detected by reference. **UNPROVEN** whether one has occurred.
* **Refund retaining commission:** structurally possible — reversal would have to recompute rather
  than reference. **UNPROVEN** in practice, because no refund exists.

---

## Proposed canonical financial architecture

```
                       ONE policy engine, explicit transaction types
  transactionType ─┬─ POS_SHOP_SALE        ─► pos policy
                   ├─ MARKETPLACE_ORDER    ─► marketplace policy
                   ├─ SUBSCRIPTION         ─► platform-revenue policy
                   └─ (explicitly enumerated; UNKNOWN is an ERROR, never a rate)

  every money movement writes ONE immutable entry carrying:
     transactionType · sourceRef · gross · rate applied · rate provenance
     seller entitlement · rider entitlement · platform entitlement · idempotency key

  reversals REFERENCE the original entry's recorded economics.
  They never recompute from whatever policy is active today.
```

Two properties this fixes, both proven above: an unknown category cannot silently price money, and
a wallet movement can always be traced to the transaction that caused it.

## Implementation gates required before any money-policy change

1. **Category coverage gate** — every category string any caller can emit resolves to an explicit
   rate; an unknown label raises `COMMISSION_CATEGORY_UNRESOLVED` and **fails closed**. Proven by
   sabotage: introduce an unknown label, the gate must fail.
2. **Linkage gate** — every `walletTransactions` write carries a source reference and an
   idempotency key; a wallet balance must reconcile to the sum of its linked entries.
3. **Orphan gate** — no `commissionLedger` entry without a corresponding order/payment document.
   Today six of six would fail this.
4. **Reversal parity** — a refund reverses seller credit *and* commission by reference to the
   original entry, and cannot return more than was captured.
5. **Split integrity** — platform + rider + seller entitlements sum to gross, before and after.
6. **Replay safety** — every money boundary proven idempotent by double-delivery, asserted on
   effects and timestamps, not on call counts.
7. Existing release-path gates: single-source guard green without new allow-list entries, live
   reconciliation before deploy.

## Not to be touched by this workstream

The deployed tenant-authority release (`merchant-authority.js`, the POS guards, the shopEmployees
anchor rule) and the wallet backend freeze. This financial redesign must not contaminate that
certified work.
