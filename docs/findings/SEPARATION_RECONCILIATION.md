# Reconciliation of the proposed POS / marketplace separation

**Read-only. No code, config, rules, IAM or deploy changes. Documentation only.**
2026-08-28 · rests on `694a9a9` `158d42a` `29e2deb` `efae6ea` `9658154` `1f07f3e` `aab0e8e`

Each item traced to its **live writer · collection · reader · rail**, with the amendment surface.

---

## The recurring result, now at six

Six pieces of correct machinery exist and are **not on the path the money takes**:

| | machinery | state |
|---|---|---|
| 1 | FinOS category table | 0% for its whole life (`db` arg omitted) |
| 2 | hub/category rates | 10% fallback for their whole life |
| 3 | `RATES.marketplace` 3% | callers emit `product` → `default` 5% |
| 4 | 48h obligation lifecycle | `PER_SALE_48H` → **0 live rows** |
| 5 | `creditWalletTxn` order linkage | correct, but the live `earning_settlement` rows come from `wallet.js` instead |
| 6 | **`reverseLedgerEntry`** | correct reversal-by-reference — **no caller anywhere** |

**Item 6 is new and it is the most consequential.** `finos-utils.js:122` already implements exactly
the returns rule: it reads the original entry, reuses `orig.amountCents` (**never recomputes**),
swaps `debitAccount`/`creditAccount`, carries `orderId`/`sellerId`/`riderId`/`buyerId` forward,
refuses a double reversal, keys idempotency off the original id, and stamps `reversalRef` +
`reversedAt` on the original. It is exported at `:830` and **called by nothing**.

**The returns capability is built. It is simply unreachable.** That is a far smaller job than
building it.

---

## Item-by-item trace

### 1. POS = seller/shop sales, Daraja rail, independent 5% — **needs a correction**

| | |
|---|---|
| writer | `posCompleteCheckout` → `createLedgerEntry` |
| collection | **`ledger`** (not `commissionLedger`) |
| live rate | **3%** (`metadata.commissionPct: 3`, 10500c on 350000c) |
| rail | `metadata.collectionRoute: **CASH_IN_DRAWER**` |

**The live POS commission was charged on a CASH sale.** `collectionRoute` is a configured dimension —
`payment-config.js` defines `ROUTE_DIRECT` / `ROUTE_CENTRAL`, `mpesa-c2b.js` writes `CENTRAL_MOR` —
and `CASH_IN_DRAWER` is a third value.

**So "POS = Daraja rail" conflates two different things.** The commission is triggered by a
*completed sale*, whatever the tender: cash, card or M-PESA. Daraja is one collection route among
several. If POS commission were scoped to the Daraja rail, **cash sales would stop accruing
commission** — a revenue change nobody intends.

**Restate as:** POS commission accrues on every completed POS sale regardless of tender; Daraja is
the *collection* rail for M-PESA POS payments and for commission settlement.

### 2. Marketplace = IntaSend — **confirmed**

`webhookIntasend` (`index.js` ~`:6792` / ~`:7910`, duplicated) → `commissionLedger`, 11/11 live rows,
all 5% via the `default` arm.

### 3. Seller and rider economics separately recorded and reversible — **partly**

`finos.js:188` credits the seller (`type:'order_earning'`, `orderId`), `:190` the rider
(`type:'delivery_earning'`, `orderId`). `finos-router.js` has **12** `createLedgerEntry` sites
covering platform / rider / seller. Separately recorded: **yes**. Reversible: **machinery yes,
reachable no** (item 6).

### 4. Delivery chargeable unless `shops.freeDelivery === true` — **must be built**

* `shops.freeDelivery` has **no pricing consumer**; only `seller.html:2744/3067/3131` write and
  display it. Live value on the one shop is `""`.
* `loyalty-enterprise.js:44-48` grants `freeDelivery: true` to **diamond/platinum** tiers.
* `deliveryConfig` / `deliveryPricing` / `shippingConfig` are **empty**.

Precedence must be explicit, and the reason recorded as `SHOP_OFFER` / `CUSTOMER_ENTITLEMENT` /
`NONE` so a future auditor can tell why a fee was zero.

### 5. Earning credits carry immutable linkage + deterministic idempotency — **half present**

`finos-utils.creditWalletTxn:203` writes `orderId` and `type`, in **cents**, to a wallet keyed
`entityId`/`entityType`. But the transaction row uses `_walletTxRef(db, entityId)` — an **auto-id**.
It is transactional, **not idempotent by key**: a redelivery writes a second credit.

**Amendment:** add `transactionId` + a deterministic id/idempotency key. **Outside the freeze.**

### 6. Sweeps must not receive fabricated transaction ids — **agreed, no change needed yet**

`wallet.js:1753` `sweepEarningsToWallet` moves a lump sum, in **shillings**, keyed `uid`. It should
reference the *batch* it moved. **Frozen file; additive; deferrable.**

### 7. Returns reverse recorded economics — **built, unreachable** (see above)

### 8. Unknown category fails closed — **single site**

`finos-utils.js` resolves an unknown category to `RATES.default`; the KES 10 floor is applied at
**`finos-utils.js:563`** — one line, so the POS "exactly 5%, no minimum" rule is one conditional.

### 9. Merchant vs buyer authentication separation — **already deployed and certified**

This is the tenant-authority release now live: `merchant-authority.js` (`businesses/{id}.ownerId`,
claim bypass on unforgeable claims only), the five cashier callables on the dual authority, and the
`shopEmployees` anchor immutability rule in served ruleset `59af870d`. Buyer identity is plain
Firebase auth; merchant authority is a separate, server-verified relationship.

**No change required. Do not modify it for the money work.**

### 10. Morning gate must verify actual payment — **designed in `7d115bc`, not deployed**

Settlement looks up by `paymentRef`, returns `no_payment_ref` when absent and `already_settled` on
redelivery — its own comment records the earlier bug where *"a redelivery of the SAME payment settled
a second time"*. The state machine requires **paid + verified → CLEAR**, and it writes a claim doc
(`status: 'applied'`) rather than trusting an STK response.

**STK success must never clear an obligation.** That principle is already encoded; it needs to be
carried into the daily mechanism.

---

## A suspicion I checked and dropped

`finosIdempotency` holds **21** documents against **1** `ledger` row, and `createLedgerEntry` writes
both in one transaction — which looked like 20 missing money records. It is not: `finosIdempotency`
is a **shared** claim store also used by `email-triggers.js:168`, `financial-os.js:243` and
`finos-router.js:149`. No anomaly. Recorded because the alarming reading was the first one.

---

## Amendment surface

**Change:** `functions/commission-config.js` (own `pos` category; drop the `marketplace` alias; map
`product`/`hair-beauty`/`subscription` or reject) · `functions/finos-utils.js` (fail closed;
conditional minimum at `:563`; `transactionId` + deterministic key in `creditWalletTxn`) ·
`functions/index.js` (de-duplicate the two webhook blocks) · a caller for `reverseLedgerEntry` ·
delivery pricing path + precedence · daily obligation (from `7d115bc`, re-timed) · Merchant V2 gate.

**Do not change:** `merchant-authority.js`, the POS authority guards, served ruleset `59af870d` ·
`wallet.js` until the batch-reference change is authorised · `commissionLedger` (no migration yet) ·
the six orphan rows (preserved evidence).

## Decisions still open

1. `ledger` vs `commissionLedger` as the surviving authority — the live evidence favours `ledger`.
2. Confirm the POS/marketplace rate inversion is unintended.
3. Delivery precedence: shop offer vs loyalty entitlement.
4. Which wallet field is authoritative, given `balance` (shillings) vs `*Cents` disagree live.
5. Whether POS commission is scoped to completed sales (all tenders) — per item 1's correction.
