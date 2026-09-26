# Repair 5 — the delivery record decides what a rider is owed

**Branch:** `repair-5/rider-entitlement-authority` (from main line `28b70e5`) · **NOT landed, NOT deployed**
**Programme:** Refund + Seller Accountability, repair 5 of 5 · **Related:** [[R4-returns-server-authority]] · [[RES-1 delivery quote binding]]

```
delivery record  ->  authoritative rider entitlement  ->  credit / refund / H2 execution
```

## The defect: five independent rider-pay rules

The owner named two of these (`finos.js:59`, `finos-router.js:183`). The census found five, and four
of them are **live**. Revisions were read on 2026-09-26, read-only.

| where | rule | paid to | live revision |
|---|---|---|---|
| `index.js` `onOrderStatusChange` | `order.deliveryFee − 12%` hub commission | the rider the **order** names | `onorderstatuschange-00064-rat` |
| `navigation.js` `processDriverEarning` | the queue entry's `amount` | the queue entry's `riderId` | `processdriverearning-00008-xux` |
| `finos.js` `recordPayment` | `deliveryFeeCents × 0.88` (a caller-stated fee) | the **caller's** `riderId` | `recordpayment-00013-lur` |
| `finos-router.js` `finosRecordTransaction` | `deliveryFeeCents × 0.88` | the **caller's** `riderId` | `finosrecordtransaction-00012-xuk` |
| `settlement-engine.js` `computeSettlement` | `DEFAULT_RIDER_PCT 0.88` or a caller `riderPct` | the caller's `riderId` | (admin preview only) |
| `pos-marketplace-sync.js` (merchant "ready") | writes `driverNet = fee × 0.8` onto the delivery record | — | — |

None of these reads the one figure that was designed to be the rider's pay: the `riderEarning` of the delivery
quote the server issued, which is fixed before the rider accepts the job (RES-1).

**No production rider has ever been paid by any of them.** A read-only census on 2026-09-26 found:
- 13 delivery records, of which 0 carry a pinned quote and 0 are delivered.
- 0 `delivery_earning` wallet transactions.
- 0 rider lines in `ledger`.
- 0 `driverEarningQueue` entries.

Correcting a measurement of my own: my first ledger count queried `ledgerEntries`, which is the wrong collection. The finos ledger is `ledger`: 1 document, a POS commission line.

## What makes a delivery record authoritative

The delivery record alone is **not** enough. The served rules let any signed-in user create a
`packageRequests` document (`allow create: if claimsOwner()`), with any fields: a self-consistent quote, an `orderId`,
a rider. Production holds 5 such browser records (`DEL-…`, all carrying `uid`) beside the 8 server records
(`DEL<ref>`, none carrying `uid`), and one order's `deliveryRef` points at a browser record. `assertSettleable` checks only
a quote's own arithmetic and the policy, so a forged quote that adds up passes it.

`functions/rider-entitlement.js` therefore admits an entitlement only when **every link is server-authored**:

1. **The record is server-authored.** It has no `uid`. `claimsOwner()` forces a client-created record to carry
   one, and no server writer sets it. A record squatted on the server's own id then pays *nobody*, never the squatter.
2. **It names this order.**
3. **Its pinned quote is settleable.** This is `assertSettleable` plus the renegotiation guard: the same contract
   `dispatch.js` already applies.
4. **The pin is the quote the server issued.** `deliveryQuotes/{quoteId}` has no client rule. It must be
   `consumed` by **this** order (RES-1 single-use binding), and its rider, charge, commission and version must
   equal the pin's.
5. **The rider is the one the server assigned** (`assignedDriverId`, set only by the accept path). Any other rider
   field on the record or the order must agree.

Anything else refuses with a stated reason (`no_pinned_quote`, `delivery_record_client_authored`,
`quote_not_bound_to_this_order`, `pinned_quote_diverges_from_issued_quote`, `rider_mismatch`, …). A refusal pays
nobody and is recorded. **An unknown entitlement is `null`, never `0`.**

**The entitlement is independent of the buyer.** The authority reads no refund, dispute, return, escrow, order
`deliveryFee` or `driverNet`; a static check enforces this. A seller-caused failure can refund the buyer 100% while
the rider stays owed what they earned. *Whether* that is paid on refund is H2's decision; *what* it is is decided
here.

## Every path now delegates

| path | now |
|---|---|
| `onOrderStatusChange` | `rider-entitlement.creditDeliveryEarning`. `deliveryFees` records the quote's figures, or `blocked` with a reason |
| `processDriverEarning` | the same writer. The queued `amount` is ignored; a queue entry names an order, nothing more. The queue `processed` flag is claimed in the same transaction |
| `recordPayment` / `finosRecordTransaction` | rider and amount come from the entitlement. A caller's `riderId` is a claim that is cross-checked; a stated fee must equal the quoted charge or nothing is recorded; SOKONI's delivery cut is the quote's commission |
| `computeSettlement` | takes `riderEntitlement` as an input. `DEFAULT_RIDER_PCT` and `riderPct` are gone; a delivery fee without an entitlement is refused |
| merchant "ready" delivery writer | carries the pinned quote (`deliveryPricingForOrder`), like the webhook writer; no `fee × 0.8` |

**`wallets/{uid}.balance` is whole shillings.** The rider credit floors the entitlement, exactly as the seller credit
does (`order-settlement.js`), and records `entitlementMinor` and `unpaidRemainderMinor` beside it, so the
sub-shilling remainder is visible, not lost.

## Evidence — `scripts/test-rider-entitlement-authority.js`

The suite runs the **real** handlers from `functions/index.js` (`.run`) against the Firestore emulator. Every quote in
it is issued by the real `requestDeliveryQuote` under the approved policy and bound by the real binder.

| target | result |
|---|---|
| repaired | **32 / 0** |
| old code (`28b70e5`) | **9 / 23 FAIL**. It pays 440 (fee − 12%) or 4,400 for a 10× fee, instead of the quoted 230. It pays an attacker named by a browser record, by an order, or by a queue entry. It pays 999,999 from a queue. It pays a quote bound to another order, a tampered pin, and a record with no quote. It credits 0.88 of a caller fee to a caller-named rider through both finos callables. It lets a caller set `riderPct`. |

The old tree **passes** only the harness controls and the properties it already had: exactly-once, one shared
queue/trigger key, and refund independence (it also paid the rider regardless of refund). Each of those assertions
judges only its own property, so a wrong amount cannot make it fail.

## Adjudication record (owner, 2026-09-26) — LAND approved, DEPLOY NOT approved

### HARD DEPLOYMENT GATE — "R5 landed" does NOT mean "R5 deployable"

**Do not deploy Repair 5 until RES-1 has carried and persisted the pinned quote onto production delivery
records** (or an equivalent migration has established that link). Production today has 13 delivery records and
none carries a pin, so Repair 5 deployed alone pays **no** rider: each delivery is recorded `blocked` with
`no_pinned_quote`.

Classification: that is **BLOCKED — missing authoritative input, fail-closed**. It is **not** a missed
vulnerability. **The next step after landing is RES-1, not deploying R5.**

### Provenance — the rule R5 depends on is observed, not contracted

R5 treats "written by the server" as "the record has no `uid`". The R5 suite proves only that a record **with** a
`uid` is refused. It does not prove the converse. Evidence gathered at adjudication (a scratch probe, not part of
the R5 suite; served ruleset `6c67a34d`, with an allow-all counterproof that allowed every case):

| browser create of `packageRequests` | served rules |
|---|---|
| without `uid` | **DENIED** |
| `uid: null` | **DENIED** |
| `uid` = another user | **DENIED** |
| `uid` = self | allowed |

On the server side, no server writer sets `uid`: the webhook and merchant "ready" writers create the record,
`delivery-complete` only merges a status, and every other writer updates. All 8 server records in production lack
`uid`.

This is an **emergent property of today's rules and writers, not a stated contract**:
- A rules change that loosens `claimsOwner` would let a browser create a record without `uid`, and a forged record
  would be accepted. That **fails open**.
- A server writer that starts setting `uid` would stop riders being paid. That fails closed.

**Follow-up (rules/provenance repair, separate):** give delivery records an explicit server-only provenance marker
(or a server-only collection), deny client creation of server-id records, and pin the marker with a rules test.
Update paths were not probed: `uidUnchanged()` appears to block removing `uid`, but that is not yet observed.

### Separate follow-ups — none are folded into R5

1. **FINOS transaction authority (P0, next financial repair after R5).** `recordPayment` and
   `finosRecordTransaction` are deployed and accept the seller, order, tip and payment figures from the caller.
   R5 repaired only who receives the rider entitlement and how much.
2. **Wallet units and rails.** The finos cents fields (`availableBalance`) and `balance` in shillings are two
   rider-credit rails.
3. **Delivery-ID squatting.** This is a Firestore rules repair; see the provenance section above.
4. **The public "88%" promise** against the approved 75–84% rider share. This is a policy/UI consistency repair; R5
   is not altered to accommodate it.

## Found, not changed

- **DEPLOY PRECONDITION.** Every production delivery record lacks a pinned quote. Deployed alone, Repair 5 credits
  **no** rider: each delivery is recorded `blocked: no_pinned_quote` until the RES-1 quote carry runs on the
  production webhook. This fails closed and visibly, and no rider has ever been credited, so nothing that works
  today breaks. But Repair 5 must ship with, or after, RES-1.
- **`recordPayment` / `finosRecordTransaction` still take the seller amount, the order amount and the tip from the
  caller.** `recordPayment` checks only that the caller is signed in, and neither verifies payment unless a
  `paymentRef` is given. Only the *rider* part is repaired here. Both have never run in production (0 `ledger` lines
  of theirs), but both are deployed. This is a P0 finding for the finos/H2 authority.
- **Two rider credit rails in two units.** The finos callables credit `wallets/{id}.availableBalance` (cents) under
  their own key. The delivery-earning writer credits `balance` (shillings) under `{rider}_{order}_delivery`. For one
  delivery both could pay. Unifying them is wallet-authority work.
- **Delivery-record squatting.** A browser can pre-create the server's deterministic `DEL<ref>` id. Repair 5 makes
  that pay nobody, but the webhook then skips creating its own record. The rules source should deny client
  creation of server-id records (rules workstream).
- **Browser rider figures and promises.** These are displays, not payments, and remain:
  - `driver.html` shows `fee × 0.88`.
  - `delivery-hub.js` uses `DRIVER_SHARE 0.88`.
  - `sokoni-delivery.js` uses `0.82` with a floor of 180.
  - `sokoni-logistics.js` and `seller-delivery.html` sum a browser `driverNet`.
  - Public copy promises "**88%** of every delivery fee" (`driver.html`, `opportunity.html`, `script.js`, `seo.js`,
    `services.html`), while the approved quote policy keeps SOKONI's share in a 16–25% band, so riders get 75–84%.
  - That promise is a policy discrepancy for the owner to adjudicate.
- `commission-config.js` `hub: 12%` (whose comment says "88% rider") no longer prices any rider payment.
