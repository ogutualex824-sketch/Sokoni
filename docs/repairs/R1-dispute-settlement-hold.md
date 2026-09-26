# Repair 1 — an open dispute pauses auto-confirm and seller settlement

**Branch:** `repair-1/dispute-settlement-pause` (from main line `9067a9e`) · **NOT landed, NOT deployed**
**Programme:** Refund + Seller Accountability, repair 1 of 5 · **Related:** [[REFUND_AFTER_WEBHOOK_CREDIT_INVESTIGATION]] · [[Orders]] · [[Payments]]

## The defect

- **Settlement ignored disputes.** The auto-confirm sweep skipped orders flagged `disputeOpen` or `hasDispute`,
  but **nothing ever wrote either flag**. `settleOrder` checked no dispute at all, so a disputed order was
  auto-completed and its seller settled.
- **Found on the way: disputes could not be opened.** `createDispute` wrote `orderSnapshot.deliveryStatus`
  directly from the order, and Firestore rejects `undefined`. **9 of 10 production orders have no
  `deliveryStatus`**, so opening a dispute on them threw. Production has never held a dispute (0 docs).
- Both defects exist identically on `slice/realtime-control-plane`.

## The rule

    OPEN DISPUTE  →  NO AUTO-CONFIRM  →  NO SELLER SETTLEMENT

**The authority is the dispute record** `disputes/dp_{orderId}`, not the order. It is written only by the server:
the served rules deny client creates, and a buyer may update `evidence` only. It is read **inside** the
`settleOrder` and auto-confirm transactions. `orders.disputeHold` is a display **mirror**, and nothing decides
money from it.

| event | hold | effect |
|---|---|---|
| `createDispute` | `settlementHold: HELD`, same transaction as the dispute | settlement parks the order `HELD / dispute_open`; the sweep skips it |
| buyer `cancelDispute` | `RELEASED` | a parked completed order is settled now (`resumeSettlement`) |
| admin `resolved`/`closed` **without** `releaseSettlement: true` | stays `HELD` | **fail-closed**: the resolution is free text, so "seller was right" and "buyer refunded" read the same |
| admin `resolved`/`closed` **with** `releaseSettlement: true` | `RELEASED` | settles a parked order |
| admin `open` / `investigating` | `HELD` | re-applies the hold |

`resumeSettlement` exists because nothing re-enters `settleOrder` after its one trigger (`completed`) has fired.

## Evidence — `scripts/test-dispute-settlement-hold.js`

The real callables are driven via `.run()`, alongside the real `settleOrder` and sweep. **Part B** loads the
**served** ruleset `6c67a34d` and the repo build into `@firebase/rules-unit-testing`. It includes a positive
control (evidence updates are allowed) and an allow-all **counterproof**, which must allow the forgeries.

| target | result |
|---|---|
| repaired | **39 / 0**: hold marked; settlement and auto-confirm refuse; undisputed controls settle and confirm; withdrawal and admin release resume exactly once; admin resolve without release stays held; forged mirrors decide nothing; **12 dispute-vs-settlement races, 0 unintended settlements**; 7 forgeries denied on both rulesets and allowed by the counterproof |
| **old code**, production-shaped orders | **28 / 11 FAIL**: a dispute cannot be opened (crash) |
| **old code** with `deliveryStatus` supplied | **27 / 12 FAIL**: disputed order **settled**, disputed delivery **auto-completed**, and **12 of 12 races settled the seller after the dispute existed** |

**Regressions:** none.
- `test-settled-case-guard` 66/0, `test-refund-authority` 55/0, `test-refund-escrow-binding` 13/0.
- `test-merchant-disputes` 60/0 after its H1 check was moved from matching a source literal to comparing
  against the **loaded** server list.
- `test-settled-guard-gate` 13/0. The sweep now re-checks `isAlreadySettled` in-transaction, so one mutant
  became structural-only; a new mutant that reverts both guards keeps behavioural coverage.
- Identical failing sets vs `9067a9e` for `test-post-pin-money-chain` (7), `test-merchant-ecosystem-convergence`
  (1) and `certify-res1b` (1).
- The predeploy chain passes.

## Not covered — stated so it is not assumed

- **Real buyers still cannot open disputes.** `createDispute` recognises the buyer only as
  `buyerId`/`userId`/`customerId`, and **all 10 production orders carry `buyerUid`/`uid`**. The pause is
  unreachable in production until **Repair 2** (canonical identity fields) lands.
- **Webhook-paid orders credit the seller at payment**, so there is no later settlement to pause. Their funds
  are governed by the refund authority (H2), not by this hold.
- Moderators can still change a dispute's status and hold directly through the rules. That is staff authority
  and is not changed here.
- `adminResolveDispute` gained `releaseSettlement`. The AdminOS UI does not send it yet, so an admin
  resolution currently keeps the hold until that UI is updated. This is fail-closed by design.
