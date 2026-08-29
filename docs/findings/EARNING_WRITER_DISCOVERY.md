# B2 discovery — the upstream earning writer

**Read-only. No code modified, nothing deployed, no rates changed.**
2026-08-28 · answers the B2 prerequisite from `1f07f3e`

---

## ⚠ TWO FINDINGS THAT BEAR ON LOCKED DECISIONS — read first

### 1. POS and marketplace commission are EXACTLY INVERTED, live. PROVEN LIVE

```
POS till sale  XmovY1eWnrbQydz4Nqzd   grandTotal KES 3500
  ledger/3fuiYd9iWCecg3CgHct5
    type            pos_commission_receivable
    amountCents     10500          = KES 105
    basisCents      350000
    metadata.commissionPct  3      -> 3.00%  (arithmetic confirms)
    createdBy       posCompleteCheckout
    collectionRoute CASH_IN_DRAWER

Marketplace (IntaSend)  ->  commissionLedger  ->  5%  (the default arm)
```

**POS charges 3%. Marketplace charges 5%.** The intended model is POS 5%, marketplace on its own
schedule where the configured category rate is 3%. The two live rates are the exact inverse of the
intent — POS is priced at the `marketplace` category via `ALIASES.pos = 'marketplace'`, and
marketplace falls through to `default`.

### 2. `commissionLedger` is NOT the only writable money authority — `ledger` exists and is better

Decision 1 ("`commissionLedger` remains the single writable financial commission authority") was
locked before this evidence. **POS commission does not go to `commissionLedger` at all.** It goes to
a separate `ledger` collection, and that record is markedly better suited to the specification:

```
ledger/{id}
  type pos_commission_receivable · category pos · status settled · settledAt
  debitAccount  seller:D5Ql2…      creditAccount platform:revenue    <- double entry
  amountCents · currency
  orderId · sellerId · buyerId · riderId
  idempotencyKey  poscomm_pos_D5Ql2…_mt6g6umn3g0n66ex_puiomw
  reversalRef     null                                              <- reversal designed in
  createdBy       posCompleteCheckout                               <- provenance
  metadata        { collectionRoute, commissionPct }                <- rate provenance
```

It already carries almost everything §2 of the specification asked us to build: double entry,
idempotency key, reversal reference, order/seller/rider/buyer ids, and rate provenance.

**Decision 1 should be revisited with this on the table.** The live system has *two* commission
records — `commissionLedger` (marketplace, weaker schema) and `ledger` (POS, stronger schema) — plus
`walletTransactions`. Choosing `commissionLedger` as the survivor means migrating the better record
into the weaker one. **1 live row** in `ledger` makes this the cheapest it will ever be to decide.

---

## The answer to B2 — three independent credit paths

| # | writer | linkage | units | wallet doc shape |
|---|---|---|---|---|
| 1 | `finos-utils.creditWalletTxn` (`:203`) | **carries `orderId`** + `type` | `amountCents` | `entityId` / `entityType` |
| 2 | `commission.js:576` direct increment | writes the `ledger` double entry | `sellerNetCents` | `sellerId` |
| 3 | `wallet.js:1753` `sweepEarningsToWallet` | **none** | shillings (`amount`) | `uid` |

**Call chain for #1** — the one that already does the right thing:

```
finos.js:188        U.creditWalletTxn(txn, db, sellerId, 'seller', comm.sellerNetCents,
                      { description:`Order ${orderId}`, orderId, type:'order_earning' })
finos.js:190        …rider… { orderId, type:'delivery_earning' }
finos-router.js:257/262/315/318/321/452/574/715   platform / rider / seller credits
```

It writes `{ type, amountCents, direction:'credit', description, orderId, createdAt }` and increments
`availableBalance`, `withdrawableBalance`, `lifetimeEarnings` — all in **cents**.

**Idempotency:** `creditWalletTxn` uses `_walletTxRef(db, entityId)` — an auto-id ref inside a
transaction. It is **transactional but not idempotent by key**: a redelivery writes a second credit.
`ledger` (path #2) *does* carry an `idempotencyKey`. **This is the gap to close, and it is not in
`wallet.js`.**

### Which writer shaped the live wallet — PROVEN LIVE

```
wallets/D5Ql2EYr95bt79IpcGTmOMTK0P83
  entityId / entityType present   -> finos-utils.creditWalletTxn HAS run
  uid, balance, v2, tier, pinHash -> wallet.js HAS run
  sellerId absent                 -> commission.js:576 has NOT run against this wallet
```

### A live unit collision in that same document

```
lifetimeEarnings     153003     cents  -> KES 1,530.03
balance                1530     shillings
availableBalance          3     cents  -> KES 0.03
withdrawableBalance       3     cents  -> KES 0.03
```

`balance` and `lifetimeEarnings` are the same money in different units; `availableBalance` disagrees
with `balance` by roughly three orders of magnitude. `finos-utils.js:188` documents this exact hazard
— *"Until 2026-07-19 creditWalletTxn also incremented `balance` by amountCents… This module owns the
`*Cents` fields only. Do not reintroduce a `balance` write here without first converting units and
migrating live docs."*

**The wallet is internally inconsistent today.** Any obligation or reversal computed from it must
state which field it trusts.

---

## The smallest frozen-wallet change required

**Possibly none.** The linkage the specification needs belongs at the **earning credit**, which lives
in `finos-utils.creditWalletTxn` — **not** in `wallet.js`. The frozen file only needs to change if the
sweep must reference the set it moved.

* **Required, outside the freeze:** add `transactionId` / `commissionId` and a deterministic
  **idempotency key** to `creditWalletTxn` (`functions/finos-utils.js:203-220`). It already carries
  `orderId`.
* **Optional, inside the freeze:** `wallet.js:1753` records the batch of earnings the sweep moved
  (id list or `settlementBatchId`), so the aggregate reconciles to its parts. Narrow, additive, one
  `txn.set`.

**This narrows B1 considerably.** The frozen-wallet exception is needed only for the batch reference,
not for the linkage itself — and it may be deferrable until reversals are built.

---

## Corrections to earlier passes

* Pass two said *"POS is absent from `commissionLedger`"* — true, but incomplete: **POS commission is
  recorded, in `ledger`.** POS commission is not missing; it is in a different, better record.
* Pass three's *"wallet movements carry no linkage"* holds for `earning_settlement` (`wallet.js`) but
  **not** for `creditWalletTxn`, which carries `orderId`. The gap is idempotency-by-key and the
  transaction id, not linkage per se.

## Recommended next decisions

1. **Revisit Decision 1** — `commissionLedger` vs `ledger` as the surviving authority, with the live
   evidence that `ledger` is the stronger schema and holds POS money.
2. Confirm the inversion is unintended and decide the corrected rates.
3. Decide which wallet field is authoritative, and whether the unit collision is repaired before or
   after the money-model work.
