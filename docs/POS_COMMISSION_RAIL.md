# POS / Till Commission Rail — 5% per sale, collected at the 07:00 gate

**Date:** 2026-09-07 · **Status:** BUILT AND TESTED, NOT DEPLOYED
**Related:** [[Payments]] · [[SmartPOS]] · [[Orders]] · [[Marketplace]]

## 6a — the checkout authority is proven first and owns its sale identity (2026-09-28)

The debt DR-A creates is only as trustworthy as the checkout that decides a sale happened. `posCompleteCheckout` used to
claim the key, replay a cached result and resume an existing sale **before** proving the merchant. A SmartPOS mirror
record at the checkout's sale id was therefore adopted as a committed sale: completed, with no stock movement and **no
debt** (emulator-proven).

Now:
- the merchant proof runs first (moved, unchanged);
- idempotency is scoped to the merchant (`_idemIdFor`);
- resume adopts only a record carrying the checkout's own provenance;
- the mirror refuses the reserved `ps_` namespace.

See [[POS-6a-checkout-authority]].

## M0-4-DR-R — deterministic reconciliation, a BACKSTOP (2026-09-28)

Since M0-4-DR-A a sale and its `poscomm_<saleId>` debt commit together. `functions/pos-debt-reconciliation.js` exists
only for the residue: a **proven, completed, commission-bearing** sale that nevertheless has no debt. For ordinary sales
it should find nothing. Design and evidence: [[POS-M0-4-DR-R-reconciliation]].

- **`reconcilePosSaleDebts`** (onCall, SOKONI admin only; `store` = `posRetailSales` | `posSales`, page ≤ 100):
  - `mode: 'dry_run'` (the default) evaluates and reports. It writes **nothing**.
  - `mode: 'execute'` re-judges each sale **inside its transaction**. Only then does it create the debt and its ledger
    projection through the DR-A builder (create-only, `createdAtMs` = reconciliation time), with ONE outcome record
    in `posDebtReconciliation/poscomm_<saleId>`.
- **A candidate is proven from the sale's own record**, never from the absence of a debt:
  - the writer: the checkout's id re-derives from `merchantId` + `idempotencyKey`, or `recordPOSSale` has its M0-2 claim.
    SmartPOS mirror sales are out of scope;
  - `status: 'completed'`, with no void or refund;
  - `soldAtMs`, the recorded route and gross;
  - the rate era;
  - an unambiguous business.
- **Anything missing or ambiguous is `NEEDS_REVIEW`** with a reason code. Nothing is defaulted.
- **Rate era:** `RATE_ERA` pins the rate table's fingerprint and a deployment boundary, **null until the deploying
  commit fixes it**. Until then DR-R reconstructs nothing.
- **Never:** prices, category configuration, payment status, collection, wallets, the till gate, an existing debt
  altered.

## M0-3 — ONE settlement state machine for POS commission (2026-09-28)

**Owner ruling.** A debt (`posCommissionLiabilities`, M0-1) is settled by exactly one authority, whatever the
payment mechanism: IntaSend STK, IntaSend hosted checkout (card and **every method the account has enabled** — no
method is hard-coded), or cash. Failed, cancelled, expired or unverified payments leave the debt OUTSTANDING. The
till gate is untouched (still OFF).

`functions/pos-commission-settlement.js`:

| Record | Role |
|---|---|
| `posCommissionPayments/{payId}` | one ATTEMPT over a FROZEN set of debt ids and their exact `liabilityMinor` total. `payId = poscs_<sha(scope|key)>`, so the same key gives the same attempt. The charge is rounded UP to whole shillings for M-Pesa, and the difference is recorded as `roundingMinor` (0–99). |
| `posCommissionSettlementClaims/{debtId}` | created with `create()` only: a debt is held by at most ONE open attempt |
| the debt row | the ONLY place that says SETTLED (`settlementRef = payId`, `settledVia`) |

**Transitions** (each is one transaction, with every read before any write):
- **`openAttempt`** freezes the unclaimed OUTSTANDING debts of one business, or of the owner's unresolved debts, and
  creates the attempt plus one claim per debt. Debts already held elsewhere are "already in progress".
- **`completeAttempt`** runs only on proven money. Each frozen debt that is still OUTSTANDING and not held by
  another attempt becomes SETTLED, once. Anything else goes to `PAID_RECONCILE` and is never settled twice. A late
  proven COMPLETE after a FAILED is still honoured.
- **`failAttempt`**: the attempt becomes FAILED, only its own claims are released, and the debts stay OUTSTANDING.

**Callables:**
- **`posCommissionPayNow`** (STK needs `phone`; checkout returns the IntaSend URL the payer opens):
  - **Who:** the business owner, or a member holding `finance` (`workforce-identity._assertBusinessPermission`);
    unresolved debts can be paid only by the proven shop owner.
  - **Card data:** fields that look like card data are refused. The payer types card details only on IntaSend's
    page.
- **`posCommissionPayNowConfirm`** asks IntaSend. It settles **only** when the provider evidence shows `COMPLETE`,
  `api_ref = payId`, currency `KES` and amount equal to the frozen charge. A field that is missing counts as
  **not proven**: the attempt goes to `NEEDS_REVIEW` and nothing settles.
- **`posCommissionCashRecord`** (owner or `finance`) records cash handed over; it settles NOTHING.
  **`posCommissionCashConfirm`** requires a SOKONI platform admin who is not the requester, plus a receipt number;
  that is what settles. **`posCommissionCashCancel`** releases the debts.

**Provider transport:**
- **STK:** `shared/stk-gateway` (SOKONI's IntaSend account).
- **Checkout:** `shared/intasend-checkout`, ported verbatim from c34455d, public-key flow, no `method`.
- **Status:** `shared/intasend-status`, the Bearer `POST /payment/status/` that the wallet sweep uses live. It
  reads state, amount, currency, api_ref and method, each `null` when absent.
- **Never used:** `initiateSTKPush` / `payments/{ref}`. The live webhook would take commission on the payment and
  credit the payer. The `poscs_` prefix matches no webhook route, so the webhook is not touched.

**Retired:** `applySettlement` and `settleFromBusinessWallet` now throw `SETTLEMENT_RETIRED`, and
`posSettleCommission` is no longer exported. They settled by day, read outside a transaction, had no OUTSTANDING
precondition and wrote an overwriting receipt: on the old tree, two payments settled one debt.

**Before any deploy (NOT done):**
- A controlled **KES 10 live payment** on M-Pesa, plus card if the account enables it. It must prove what the
  status response states for amount, currency, api_ref and method.
- Provision an **`INTASEND_PUBLISHABLE_KEY`**. Production has none today, so checkout refuses with
  "not configured".
- Choose the review path for `NEEDS_REVIEW` / `PAID_RECONCILE` (an AdminOS tool).
- The pending-attempt **sweep** belongs to M0-4.
- **Refunds and chargebacks** of a settling payment have no un-settle path yet (M0-5).

**Evidence:**
- `scripts/test-m03-commission-payment.js`: an emulator run with a scripted in-process IntaSend double, **31/0**
  new vs **3/28** old.
- `scripts/test-pos-commission-rail.js` is now 46/0. Its day-based settlement parts (D, E, G) were replaced by
  three checks that the old paths refuse and write nothing.

## M0-2 — recordPOSSale records ONE sale per request (2026-09-28)

**The gap M0-1 left open.** `recordPOSSale` took no idempotency key, so a retried request recorded a second
sale, and since M0-1 a second debt with it. That was one debt per sale, but not one sale per request.

**The contract now.**
- **The key is required.** `recordPOSSale({ idempotencyKey, items, payment, … })`, where the key is 8–128
  characters from `[A-Za-z0-9_.:-]`. A missing or malformed key is refused `invalid-argument` before anything
  is read or written. This applies both to the direct callable and to `smartPosDispatch({ op: 'recordPOSSale' })`,
  the route production actually exposes.
- **The server owns the claim.** It lives at `posRecordSaleClaims/{sha256(sellerId|key)}`: scoped to the
  tenant-bound seller, separate from checkout's `posIdempotency`, and server-only (no client rule matches it).
- **One transaction** creates the claim, moves the stock, and creates the sale and receipt. A retry can never
  find stock taken for an unwritten sale, and a refused attempt (e.g. insufficient stock) leaves no claim, so
  the same key succeeds once the problem is fixed.
- **The claim carries a fingerprint** of what makes it the same sale: seller, branch, session, lines
  (product · name · sku · qty · price · cost · discount · tax), payment (method · ref · amount), customer and
  discount. Display-only fields (`cashierName`) are excluded.

| Request | Result |
|---|---|
| Same key, same sale | The original result, `replayed: true`. Nothing written; no loyalty, event or receipt re-runs. The M0-1 debt is re-ensured, which repairs a crash between the sale commit and the debt write. |
| Same key, different sale | Refused `failed-precondition`; nothing written |
| Concurrent identical requests | Converge on one sale, one stock move, one debt |

**Evidence:**
- `scripts/test-m02-recordpossale-idempotency.js` (emulator; real `recordPOSSale`, direct and via
  `smartPosDispatch`): **13/0** new vs **3/10** old. On the old tree, 6 concurrent identical requests made
  6 sales, took 12 units of stock and created 6 debts.
- Mutants: 8, all caught. S-3b exists because the first run let `claim-check-not-atomic` survive: S-3's
  requests all read the same product row, so the emulator's product lock serialised them whatever the claim
  did. S-3b uses a custom line, where only the claim serialises.

**Known limits (recorded, not solved):**
- **The emulator locks; production aborts and retries.** Real contention is still unproven here.
- **`pos-onboard.html`'s demo call** sends no key and no `payment`. It was already refused ("payment required")
  and swallowed; it is still refused.

## M0-1 — ONE authoritative POS commission debt per sale (2026-09-27)

**Owner ruling (decision A):** `posCommissionLiabilities/poscomm_<saleId>` is the ONE collectible POS
commission obligation. The `ledger` entry is an accounting **projection** of it, not a second debt.
Future Pay Now and the 07:00 collector will read and settle only this row.

**Before M0-1, every checkout sale produced TWO independent records of one debt:**
- **the liability**, keyed by the bare saleId and written by get-then-set;
- **a `pos_commission_receivable` ledger entry** that checkout posted on its own:
  - before the sale was written;
  - with a random id;
  - keyed on the browser's idempotency key;
  - through a check-then-write that concurrent retries could duplicate;
  - from a separately run commission engine.

`recordPOSSale` wrote only the liability. Neither record carried the business.

```
sale ─ proven merchant ─ resolve SOK-* business ─┬─ exactly one  → businessId
                                                 └─ none / several / non-SOK / unreadable → businessUnresolved (never blocks)
     └─ ONE transaction (all reads first):
          posCommissionLiabilities/poscomm_<saleId>   create()  OUTSTANDING · 5%, KES 10 minimum · rate frozen
          ledger/poscomm_<saleId>                     create()  projection: same id, same amount, liabilityId
```

- **Identity:** `debtIdFor(saleId) = 'poscomm_' + saleId`. Both sale rails (`posCompleteCheckout`,
  `recordPOSSale`) go through `pos-commission-rail.recordSaleLiability`.
- **Created exactly once:**
  - **fast path:** when the debt and its projection both exist, nothing is written and no business
    lookup is made;
  - **otherwise:** one transaction reads both, then `create()`s whatever is missing. A concurrent loser
    retries and sees the winner's rows;
  - **crash between the two:** a debt without a projection gets its projection **from the debt's own
    figures**, never recomputed.
- **Business:** resolved via `tenant-identity.resolveMerchantIdForOwner`, the one resolver, which now
  accepts the caller's db handle. A SOK-* sale merchant (a membership sale) is its own business.
  - Unresolved cases record the debt anyway, with `businessUnresolved: true` and the reason in
    `businessResolution`, to be reconciled later.
- **Unchanged:**
  - 5% and the KES 10 minimum;
  - the gate is still OFF (P0);
  - no Pay Now, no collector, no deploy;
  - the historical production ledger row is not migrated.
- **Checkout's own ledger posting is removed.** `financial.commission` stays on the sale as information
  only; the two engines were shown to agree to the cent from KES 20 to KES 12,345.67.

**Evidence:**
- `scripts/test-m01-commission-debt.js` (emulator; real `posCompleteCheckout`, `recordPOSSale` and rail):
  **20/0** new vs **5/15** old.
- `scripts/test-pos-commission-rail.js`: **80/0**, after two fixture changes:
  - A4 is the new id rule;
  - F1 now requires exactly the debt plus its projection.

  Its in-memory store gained a `create()` that fails when the document exists, as Firestore's does.
- `scripts/test-p0-till-gate-off.js`: debt lookups now use the new id.

**Finding (not changed here):** `recordPOSSale` takes no idempotency key. Calling it again creates a new
sale, which owes its own single debt. One debt per sale holds; one sale per request does not.

## CURRENT STATE — P0 till safety (2026-09-27): the gate is wired, and switched OFF

**The history.** Commit ee37437 (deployed 2026-09-22 as `posCompleteCheckout` revision `00024-zit`)
wired the gate into the sale path. It proves the merchant first, then calls the gate on both
doors: `posCompleteCheckout`, and `recordPOSSale` (reachable via `smartPosDispatch`). That
supersedes the "NOT DONE" section below. Every owed sale writes a `posCommissionLiabilities`
row.

**The risk that remained.** Nothing deployed could PAY a liability: no settle callable, no
collector, no Pay Now. With the gate enforced, a merchant's first cash sale would lock their
till at 07:00 the next day with no way to unlock it. An unreadable ledger also refused every
sale.

**The owner's ruling.** The strict 07:00 gate is the target, but only together with a way to
pay. Until then:

- **One switch.** `pos-commission-rail.GATE_ENFORCED = false`. Both rails call
  `enforceSaleGate` and nothing else. While the switch is off, it returns without reading the
  ledger and never refuses. An outage can no longer stop a sale either.
- **Debt still accrues exactly as before:** same row, same 5%, same settlement day. Nothing is
  deleted or settled, and no rate or collection rule changes.
- **The gate itself is unchanged.** `evaluateMerchantGate` and `assertGateOpen` still close at
  07:00; `test-pos-gate-enforcement` PART E proves it.
- **Switching it back on** is one constant, changed in the same certified unit that ships the
  settlement path:
  - Pay Now with any IntaSend method (card, M-Pesa, …);
  - one collector at 07:00 EAT;
  - separate business and personal wallets;
  - an in-app reminder the evening before and early morning;
  - one SMS at 06:00.

| Evidence | Result |
|---|---|
| `scripts/test-p0-till-gate-off.js` (new; emulator; real `posCompleteCheckout` and `recordPOSSale`) | **9/0** new vs **3/6** old. The old tree refuses overdue debt ("Unpaid POS commission … Settle 50.00") and an injected ledger outage (`unavailable`). The new tree completes the sale and still records the liability (5% = 5000 minor on KES 1,000). |
| `scripts/test-pos-gate-enforcement.js` (rewritten, owner ruling) | **42/0**. Both doors call the one switch and never `assertGateOpen` directly. The gate still closes. The switch is off, reads nothing, and delegates to `assertGateOpen` when on. |
| `scripts/test-pos-gate-behavioural.js` (rewritten, owner ruling) | **28/0** new vs **22/6** old. Overdue debt and an outage are not commission refusals, and the ledger is not read. |
| Mutants (7) | All caught: switch-on, checkout-bypasses-switch, recordpossale-bypasses-switch, switch-off-still-reads, switch-on-weakened (by the structural E8 only), and a liability dropped on each rail. |

## The commercial rule

* POS and Till are **5% per sale, every plan**. The marketplace plan ladder (15/10/5/0) does
  **not** apply here — see `MARKETPLACE_SELLER_CATEGORIES` in `functions/commission-config.js`.
* Commission is **payable at any time**. A merchant may clear today's accrual at 14:00; they do
  not have to wait to be gated.
* Unpaid commission is **collected each morning at the 07:00 Africa/Nairobi gate**, before a new
  sales day starts.
* An **early reminder** goes out at **06:00 EAT — one hour before the gate**.

## What existed, and what was missing

Four certified pure modules were already in the tree and **nothing called any of them**:

```
money-authority                  the arithmetic
pos-sale-commission              a sale -> a commission record + liability
commission-settlement-authority  a day's liabilities -> is the gate closed?
good-morning-gate                how to say it to the merchant
```

Each was internally coherent and none was on the path the money takes — the same pattern that
produced six unreachable commission authorities here before. A pure function that summarises an
**array** cannot gate anything, because nobody was writing the array.

`functions/pos-commission-rail.js` is the missing persistence. It writes the records, reads them
back, and turns the gate from a predicate over an argument into a predicate over the ledger.

## The chain

```
POS/Till sale
   |  planSaleCommission()         5% + KES 10 floor, rate frozen at the sale
recordSaleLiability()              posCommissionLiabilities/{saleId}   <- id IS the sale id
   |
evaluateMerchantGate()             reads the ledger -> evaluateGate() -> closed / open
   |
assertGateOpen()                   throws POS_GATE_CLOSED before a new sales day
   |
settleFromBusinessWallet()         debit FIRST, then mark settled
   |
posCommissionSettlements/{ref}     the receipt, written in the same batch as the rows
```

## The four properties, each sabotage-verified

| Property | Why |
|---|---|
| **Unreadable is not zero** | A failed liability read throws. Returning "owes nothing" turns a Firestore incident into a day of free trading, and looks like resilience while it does it. |
| **One sale, one liability** | The document id *is* the sale id, so a retried trigger or double-submitted checkout converges instead of billing twice. |
| **Custodial sales are not billed again** | Their commission already came out of money SOKONI held. Charging them at 07:00 too would look like diligence. |
| **An intent is not a collection** | Settlement requires an authoritative reference and is idempotent on it, so a replayed webhook cannot clear a second day for one payment. |

### The order property, and how it was nearly missed

`settleFromBusinessWallet` **debits first, then marks the rows settled**. The other order clears
the liability and *then* tries to take the money, so a failure between the two hands the merchant
a free day. This order fails the other way — money taken, rows not cleared — and that state is
**recoverable**: both steps are idempotent on the same derived reference, so calling again
finishes the job.

**Swapping the two statements passed the entire suite** at first. Every other test threw in the
*plan* step, before either side effect ran, so the order never mattered. `G19-G21` is the case
that separates them: the plan succeeds and the **debit** fails. Without it the safety property was
asserted in a comment and nowhere else.

## The business wallet — separate from personal, structurally

`assertBusinessWallet()` refused to settle from anything but a BUSINESS wallet, and was guarding a
concept that **did not exist**: production had `wallets/{uid}` and one stray `merchantWallets`
reference; nothing carried `kind: 'BUSINESS'`. So settlement could not be wired without inventing
a mapping onto the personal wallet — the exact thing the guard forbids.

`functions/business-wallet.js` builds it, with three separations:

| | Personal | Business |
|---|---|---|
| collection | `wallets/{uid}` | `businessWallets/{shopId}` |
| key space | account | **shop** (one owner may run several) |
| unit | `balance` — **shillings** | `balanceMinor` — **cents**, named in the field |

Every movement is ledgered (`businessWalletEntries/{ref}`), idempotent on its reference, and
written in the **same transaction** as the balance. Never negative: an overdraw is refused with
the exact shortfall, never clamped — a clamped debit silently forgives part of a debt and leaves
the ledger disagreeing with the balance.

Provisioned automatically on approval, beside the Till, in `projectSeller`'s entitlement block.
It never re-owns an existing wallet: a shop transfer or a merge must not move a float to a
different person as a side effect of provisioning.

## The early reminder — and the off-by-one it hid

`posCommissionReminder` runs at **06:00 EAT**. The settlement day rolls at **07:00, not
midnight**, so at 06:00 on the 6th `settlementDayFor(now)` is still `2026-09-05` — and *that*
day's gate closes at 07:00 on the 6th, **one hour later**. That is exactly the cohort to warn.

The first version skipped `settlementDay >= today` on the reasoning that "today is not due yet".
That reminded only merchants who were **already** overdue — for whom the message is too late —
and stayed silent for everyone about to be gated within the hour, which is the entire purpose.
Caught by running the selection against a fixture rather than reading it. `PART H` holds it.

The reminder is a **separate notification type** from the closure (`pos_commission_due` vs
`pos_commission_gate`) so a merchant can mute the courtesy without muting the reason their till
stopped.

**The scheduler never decides.** It notifies. A scheduler outage means nobody is *warned*; it can
never mean nobody is *gated*, because the gate is recomputed from the clock on every operation.

## Deployable surface

| Function | Kind | Purpose |
|---|---|---|
| `posGateStatus` | onCall | what do I owe, and may I trade? |
| `posSettleCommission` | onCall | pay it — at any time, not only when gated |
| `posCommissionReminder` | schedule `0 6 * * *` Africa/Nairobi | the early reminder |

All three re-exported **by name** in `functions/index.js`. A scheduled function not exported under
its exact name is simply never deployed, and its absence looks identical to a job that ran and
found nothing to do.

`merchantUid` is always the **caller**, never a request field. `shopId` is resolved server-side
from `users.activeShopId` — a client-supplied shopId would choose which wallet gets debited.

## Security rules

`posCommissionLiabilities`, `posCommissionSettlements`, `businessWallets` and
`businessWalletEntries` are **client-unwritable without exception**; reads are owner-scoped. A
merchant who could write these could clear their own debt, credit their own wallet, or forge the
receipt that proves a payment arrived. The Cloud Functions use the Admin SDK and bypass rules, so
denying every client write costs nothing.

Compiled: 165,810 bytes, 63.3% of the 256 KiB ceiling, braces balanced.

## NOT DONE — server-side enforcement at the sale

`assertGateOpen()` exists, is tested, and **is not yet called by the POS sale path.**

`posCompleteCheckout` takes `merchantId` **straight from the client** with only a presence check.
Gating on that would be worse than not gating: a merchant could pass another shop's id to dodge
their own gate, or to gate an innocent party — a bypass wearing the appearance of enforcement.
Recording liabilities against it would let a merchant book their commission onto someone else's
shop.

There **is** a canonical server-side resolver (`resolveMerchantIdForOwner` in `tenant-identity`),
but the cashier may be an employee rather than the owner, so it does not resolve for every
legitimate caller. This is the open item already recorded in
[[project_commission_collection_architecture]]: *"recordPOSSale via smartPosDispatch({op}) creates
a sale WITHOUT the gate, and posCompleteCheckout gates on an unproven client merchantId. Both need
the Store Identity Gate first."*

**Until POS identity is proven server-side, the gate is available to the terminal
(`posGateStatus` at day-start) but is not an authority.** Closing that needs
[[project_store_identity_gate]], which is blocked on an owner decision.

## Tests

| Suite | Result |
|---|---|
| `scripts/test-pos-commission-rail.js` (new) | **80/0** — 6 sabotages, one of which found a real hole |
| `scripts/test-business-wallet.js` (new) | **43/0** — 5 sabotages, all caught |

Deploy needs: hosting from a tree at or ahead of live, a Functions deploy for the three new
callables, and a rules deploy. Nothing here is deployed.
