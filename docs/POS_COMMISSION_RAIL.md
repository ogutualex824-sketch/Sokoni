# POS / Till Commission Rail — 5% per sale, collected at the 07:00 gate

**Date:** 2026-09-07 · **Status:** BUILT AND TESTED, NOT DEPLOYED
**Related:** [[Payments]] · [[SmartPOS]] · [[Orders]] · [[Marketplace]]

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
