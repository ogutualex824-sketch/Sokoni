# POS payment · wallet · commission — the ledger contract

**Date:** 2026-09-02
**Status:** CONTRACT / SPECIFICATION. No code written, no money path changed.
**Grounded in:** `docs/POS_PAYMENT_RAIL_AUDIT.md`, `docs/WITHDRAWAL_ENGINE_CHANGE_PLAN.md`

---

## 0 · The principle

> **The payment method determines how money moves. It must never determine how the
> accounting works.**

One sale ledger, one commission engine, one wallet ledger, one withdrawal quote. Cash,
M-PESA STK, SOKONI Wallet and IntaSend are *rails into the same ledger*, not four financial
subsystems.

## 1 · The wallet ambiguity that must be resolved first

There are **two different wallets** in this platform, and the POS code uses the one that has
never been used.

| | `wallets/{uid}` | `posWallets/{posCustomerId}` |
|---|---|---|
| keyed by | SOKONI user uid | a `posCustomers` document id |
| production rows | **74** | **0** |
| balance field | `balance` (6/6 sampled) | — (no documents) |
| who debits it | the owner, via `spendFromWallet` | **the cashier**, inside `posCompleteCheckout` |
| buyer authorization | — | **none** |

`posCompleteCheckout` already implements a `method: 'wallet'` payment. It debits
`posWallets/{customer.id}` inside the same transaction as the sale, idempotently
(`posWalletTransactions/{idempotencyKey}_wallet`), with a balance assertion before any write.
**Mechanically this is already the atomic model required.**

But `posWallets` is **merchant-issued store credit**, not the buyer's SOKONI wallet — and the
cashier debits it **unilaterally, with no buyer authorization**. That is defensible for store
credit the merchant issued. It would be a **serious security defect** if the same code path
were pointed at `wallets/{uid}`.

> **D-W1 (blocking).** Does "SOKONI Wallet" as a POS payment method mean
> **(a)** merchant store credit (`posWallets`, cashier-debited, no buyer auth), or
> **(b)** the buyer's real SOKONI wallet (`wallets/{uid}`, requiring buyer authorization)?
>
> They are different products with different authorization models. The stated requirement —
> *"the seller should never receive or enter the buyer's wallet PIN"* — only arises under (b).

**All three POS wallet collections are empty in production**, so neither choice has legacy to
preserve. This is a free design decision, taken once, now.

## 2 · Custody determines the accounting, and only two cases exist

```
CUSTODIAL      buyer pays → SOKONI receives/controls funds
               → commission deducted → merchant credited NET
               (M-PESA STK, IntaSend, SOKONI Wallet under option (b))

NON-CUSTODIAL  buyer pays merchant directly → SOKONI never holds funds
               → sale recorded gross → commission recorded as a LIABILITY
               (cash; merchant store credit under option (a); DIRECT_TO_SELLER till)
```

Every payment method resolves to exactly one of these. **The commission engine reads
custody, never the payment method name.** Adding a fifth rail must not add a third case.

### Worked, KES 1,000 at 5%

| | custodial | non-custodial |
|---|---|---|
| sale recorded | 1,000 | 1,000 |
| commission | 50 | 50 |
| merchant wallet | **+950** | **+0** |
| commission owed | 0 | **50** |

## 3 · Commission ordering — non-negotiable

**The merchant is credited net. There is no instant at which the wallet holds the gross.**

One Firestore transaction writes:
- the `commissionLedger` row, and
- the `walletTransactions` credit of `gross − commission`, and
- the wallet `balance` increment

together, keyed by an idempotency key derived from the sale id. **Never two writes**, never
credit-then-claw-back. A failed commission write must fail the credit.

For non-custodial sales the same transaction writes the `commissionLedger` row and **no
wallet credit** — the liability is the only financial effect.

## 4 · Commission settlement from wallet

```
Commission due  KES 2,450
       │
   [Pay from Wallet]
       │
   one transaction:
     wallet balance      −2,450
     walletTransactions  debit, type=commission_settlement
     commissionLedger    rows marked settled, settlementId recorded
     commission due       0
```

Requirements: idempotent on a client-supplied key; **rejects if balance < due** (no partial
settlement unless explicitly designed); never settles more than is owed; the settled rows
must name the settlement, so a reconciliation can walk it in both directions.

`commissionLedger` already exists with **11 production rows**, and
`commission-collection.js` / `commission-invoice.js` already exist — this extends them
rather than introducing a parallel ledger.

## 5 · Withdrawal — quote before commitment

The engine specified in `WITHDRAWAL_ENGINE_CHANGE_PLAN.md`, unchanged. Recorded here only
for its interface to this contract:

- balance authority: **`wallets.balance`**, shillings (confirmed: present on 6/6 sampled of
  74; `available`/`availableBalance` appear in code but in **no** production document)
- **fee charged on top**: `totalDebit = requested + fees`; the merchant receives the
  requested amount
- insufficient balance **rejects**, never silently reduces; a separate "maximum withdrawable"
  calculation is offered instead
- `FEE_INDETERMINATE` is a hard failure and must never default to zero
- destination decides **how** to send, never **how much** it costs

**Withdrawal must never touch commission.** Commission is settled in §4; withdrawal charges
transfer fees only. A withdrawal that deducted commission would double-charge a merchant
whose sale already netted it.

## 6 · The internal money representation

To end the 100× class of defect observed live (`requestWithdrawal` takes `amountCents`,
`requestSellerPayout` takes `amount` in shillings, and `withdrawals` has **0 rows** while
that callable took **2 requests in 30 days**):

```
Money { currency: 'KES', minorUnits: <integer> }
```

Conversion happens **once, at the boundary**, and every internal calculation uses minorUnits.
No function takes a bare number called `amount`. The unit is stated on both sides of every
assignment.

This does not decide which existing callable is "right" — that is still open — it prevents
the ambiguity from entering the new engine.

## 7 · What already exists, and must not be rebuilt

| capability | status |
|---|---|
| POS sale, mixed tender, single-spend claim | **LIVE and certified** — `posCompleteCheckout` |
| rail-neutral payment confirmation | **LIVE** — reads `posPayments/{ref}`, never names a provider |
| POS wallet debit, atomic with the sale | **CODE EXISTS, 0 production rows** — `posWallets` |
| user wallet + transactions | **LIVE** — `wallets` (74), `walletTransactions` (46) |
| commission ledger | **LIVE** — `commissionLedger` (11 rows) |
| payout request + fee/netAmount schema | **LIVE** — `payoutRequests` (7 rows, fee always 0) |
| provider-agnostic adapter | **EXISTS** — `payment-adapters.js`, IntaSend only |
| withdrawal fee calculation | **DOES NOT EXIST** |
| Till / PayBill payout | **DOES NOT EXIST** |
| buyer-authorized wallet payment | **DOES NOT EXIST** |

## 8 · Open decisions

| # | decision | owner |
|---|---|---|
| **D-W1** | POS "wallet" = store credit or buyer's SOKONI wallet? | operator |
| D-W2 | If (b): what authorizes the buyer — in-app PIN confirmation, or STK-style? | operator |
| D1 | lift the wallet freeze, or build alongside | operator |
| D2 | POS commission: absolute plan rate or relative plan discount | operator |
| D3 | does Enterprise 0% override `MIN_COMMISSION_KES` | operator |
| D4 | which plan catalogue governs a POS merchant | operator |
| D5 | does IntaSend expose a determinable per-payout fee | **IntaSend** |
| D6 | does IntaSend support Till / PayBill payouts | **IntaSend** |

## 9 · Outstanding evidence

- **`requestWithdrawal`: 2 invocations, 0 rows written.** Plausibly the unit mismatch
  rejecting real merchant withdrawals below its `amountCents >= 10000` minimum. **Diagnose
  before classifying the surface** — this may be a live defect, not dead code.
- Response codes for those two invocations — not yet read.
- Whether any client outside this tree calls the zero-traffic surfaces.

**No surface is retired, nothing is crowned canonical, and no money path changes on this
contract alone.**

---

# D2–D4 status — 2026-09-02

## D2 — ANSWERED: absolute plan rates

The POS schedule is **absolute rates**, not relative discounts:

| plan | POS commission |
|---|---|
| Free | 15% |
| Basic | 10% |
| Pro | 5% |
| Enterprise | 0% |

This is a **different model from what `sub-billing.js` currently carries**, which is
`commission_discount_pct: 0 / 2 / 5 / 10` — a discount applied *relatively* to a base rate
(`commission-config.js:163`). Under today's live model an Enterprise seller pays
`5% × 0.9 = 4.5%`, not 0%. The two cannot share a field.

**Implemented and certified** in `planSaleAccounting()`:

```
CUSTODIAL      merchantCredit = gross − commission,  liability = 0
NON_CUSTODIAL  merchantCredit = 0,                   liability = commission
```

The caller passes **custody**, never a payment method name, so adding a rail cannot
introduce a third booking. Both invariants are asserted inside the function and verified
across 792 sale/rate/custody combinations. The 15/10/5/0 ladder is tested to net
850 / 900 / 950 / 1000 on a KES 1,000 sale.

**The function deliberately carries no rate table.** Rates are resolved by the caller from
the single commission source — `scripts/verify-commission-single-source.js` fails the deploy
if a second table appears anywhere, because the platform once had nine that disagreed.

## D3 — STILL OPEN: does Enterprise 0% override the KES 10 floor?

Not decidable from code, and it is not a rounding detail. With `minimumMinor: 1000` and
`rateFraction: 0`:

- `floorExempt: false` → commission **KES 10** on every sale. "0%" is not 0.
- `floorExempt: true` → commission **KES 0**.

Both are tested. `computeCommission()` **requires the caller to pass `floorExempt`
explicitly** rather than inferring it from a zero rate, so this decision cannot be made
accidentally by whoever writes the resolver.

## D4 — STILL OPEN: which plan catalogue governs a POS merchant?

`sub-billing.js` holds two shapes, and they are not interchangeable:

| catalogue | field | semantics |
|---|---|---|
| `seller_*` | `commission_discount_pct` (0/2/5/10) | a **relative discount** off a base rate |
| `services_*` | `commission_pct` (10/7/4) | an **absolute rate** |

The D2 answer is absolute, which matches the `services_*` shape — but a POS merchant is a
seller. Resolving this decides whether the POS rate is a new field on `seller_*` plans, or
whether POS merchants are governed by a different catalogue entirely.

**Until D4 lands, no plan→rate resolver can be written**, because there is no established
place to read the rate from. The booking arithmetic above is complete and independent of it.

## What remains before wiring

D3, D4, D5, D6, D-W2 — plus the undiagnosed `requestWithdrawal` failure. The monetary
foundation is certified; the commission *resolution* is not, and neither is any integration.
