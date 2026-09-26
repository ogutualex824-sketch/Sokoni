# Refund after webhook credit — investigation

**Date:** 2026-09-26 · **Mode:** read-only. No code, rules or data were changed, and nothing was deployed.
**Verdict:** **PROVEN FROM DEPLOYED CODE, NOT PRESENT IN DATA.** Once the IntaSend webhook has credited a
seller, no deployed refund path ever reverses that credit. Two admin paths pay the buyer while the seller keeps
it. Production has never refunded a real order, so no money has been lost this way yet.
**Related:** [[MARKETPLACE_DOUBLE_CREDIT_MEASUREMENT]] · [[Payments]] · [[Orders]]

This is a **separate money invariant** from the double credit, which is fixed. It is recorded here and **not
repaired**: the repair needs its own authorization. Business-wallet work is not involved and stays on HOLD.

---

## Method

- **Code:** the exact source archive of each of the **11 deployed refund functions**, downloaded by generation.
  They come from **four different lineages**, so every citation is to the file in that function's own archive.
- **Data:** all **218** root collections enumerated (not a curated list), then every `payments`, `orders`,
  `walletTransactions`, `settlementReversals` and `wallets/*/transactions` document scanned for refund-, reversal-
  and chargeback-shaped fields and values.
- **Rules:** served ruleset `6c67a34d-bb07-4fd5-8934-32d6b547a276`.

## The four questions

### 1. Can a webhook-credited order be refunded? — **PROVEN: yes, by three paths**

| path | who | money to buyer |
|---|---|---|
| `initiateRefund` | the buyer (owner of the order) or an admin | **none**: it files `refunds/RFD…` `status:'pending'`, `amount:null` |
| `refundToWallet` | admin | **yes**: `wallets/{target}.balance += amount` (any amount, no cap against the order) |
| `fosSubmitRefund` → `fosApproveRefund` | admin (a non-admin buyer is refused: a webhook `payments` doc has no `buyerUid`) | **yes**: IntaSend chargeback against `api_ref`. Whether IntaSend accepts that reference is NOT DETERMINABLE |

These cannot act on a webhook-paid marketplace order: `processRefund` (`packageRequests` only), `refundPayment`
(the webhook's `COMPLETE` status has no allowed transition, so it throws), `autoOnRefundRequest` (disarmed: it
queues for review, moves no money, and clients cannot create `refundRequests`, because the served rules have no
block and no catch-all), `fosAutoRefund` (needs `finosTransactions`, which nothing writes), `sasosAdminRefund`,
`sfosEscrowRefund` and `adminSubProcessRefund` (other domains).

### 2. What records the refund? — **PROVEN**

`refunds/RFD…` (initiateRefund) · `walletTransactions/{uid}_{orderId}_refund` (refundToWallet) ·
`fosRefundQueue/ref_{payRef}` (FOS). **No function reads another function's record.**

### 3. Is the seller's credit reversed? — **PROVEN: no path reverses it**

The webhook credit lives in `wallets/{seller}.availableBalance`, `withdrawableBalance` and `lifetimeEarnings`
(cents). It is marked on `payments/{apiRef}.walletCreditCents`, and `sweepEarningsToWallet` then moves it to
the withdrawable `balance`. **No deployed refund function reads `walletCreditedAt`, `walletCreditCents` or
`walletCreditedTo`, or reverses `commissionLedger/{apiRef}`.**

- **initiateRefund** (`order-settlement.js:270→182-183`, case-sensitive in its lineage): the lowercase
  `"settled"` does not match, so the order is **overwritten to `REFUNDED`** with no wallet write at all. That
  **erases the only order-level trace** that the seller was credited.
- **refundToWallet:** credits the buyer and never touches the seller.
- **fosSubmitRefund:** the seller debit is guarded by `if (tx.sellerUid)` (`financial-os.js:597`). A webhook
  `payments` doc has no `sellerUid`, so **the debit is skipped** (PROVEN). The queued record's `sellerUid` falls
  back to `payments.uid`, **the buyer**, which `fosApproveRefund` would then target. The subsequent
  `fosTransactions/{payRef}` update hits a document that does not exist (INFERRED to fail the transaction after
  the chargeback has already fired).
- Even the one designed reversal, `reverseSettledOrder`, debits `balance` from `settlements/{orderId}`, which
  webhook orders never have. So it would reverse **0**.

### 4. Can the same refund be processed more than once? — **PROVEN: yes**

- `initiateRefund`: random ids, so each call files another `refunds` record (and re-bumps the analytics counter).
- `refundToWallet`: the deterministic id is bypassed by a different `orderId` label or `targetUid`.
- FOS: submit leaves the record `approved`, and approve lets `approved` through. That allows **two chargebacks**
  (INFERRED; depends on IntaSend).
- **Across functions:** nothing stops a chargeback **and** a wallet credit for the same order.

## What production holds

| | result |
|---|---|
| refunds of real orders or payments | **NOT PRESENT**: 27 payments and 10 orders, 0 refund-shaped fields |
| refund collections | only `settlementReversals` exists among 218 root collections; `refunds`, `refundRequests`, `fosRefundQueue` have **never held a document** |
| seller reversals | **0**: all 9 `wallets/*/transactions` rows are `sale` credits (8 KASS, 1 the deprecated KASS uid) |
| `settlementReversals` (1) + one `walletTransactions` reversal row | **QA fixtures** (`_qa_refund_…`), written to production by a test run, like the `SELLER_A` wallets |

## Also found (not refund-after-credit, recorded so it is not lost)

- **initiateRefund escrow path, authorization:** it checks that the caller owns the **escrow**, then applies
  `handleOrderRefund` to whatever `orderId` was passed, never binding the two. A buyer holding any escrow could
  mark **another seller's** order `REFUNDED`, which blocks that order's settlement. It is **latent** because
  production holds **zero escrows**.
- `sfosEscrowRefund` re-reads nothing inside its transaction, so it is repeatable (other domain).

## Classification summary

| | |
|---|---|
| **OBSERVED** | 0 refunds of real orders; 9 seller credits, 0 reversals; 2 QA reversal fixtures in production; no `refundRequests` client write path |
| **PROVEN (code)** | no deployed path reverses a webhook seller credit; `refundToWallet` and FOS pay the buyer without a seller debit; `initiateRefund` overwrites `settled` → `REFUNDED`; no cross-function idempotency |
| **UNPROVEN / INFERRED** | FOS transaction failure on the missing `fosTransactions` doc; IntaSend accepting `api_ref` chargebacks and a second chargeback |
| **NOT PRESENT IN CURRENT DATA** | any refund, any chargeback, any seller-credit loss |

## What a repair would have to decide (not done)

It must anchor on the **payment** (`payments/{apiRef}.walletCreditCents` / `walletCreditedTo`), not on the order
or a caller-supplied label. It must reverse the **net that was credited**, in the field family it was credited
to, with explicit recovery debt. It needs one refund authority with cross-path idempotency, so that a chargeback
and a wallet credit cannot both be issued for one order. And it must preserve the `settled` evidence rather than
overwrite it. That is an owner-authorized repair against the current production money path, not the business wallet.

---

## Track F repair — branch `track-f/refund-authority` (NOT landed, NOT deployed)

**`functions/refund-authority.js`** is the one decision point. Wired into `refundToWallet` (wallet rail),
`fosSubmitRefund` / `fosApproveRefund` (chargeback rail), and `order-settlement` refund routing (evidence).

| requirement | how |
|---|---|
| one authority | `refundAuthority/{paymentRef}` is claimed with `create()` inside a transaction. The first rail wins; every later attempt from either rail is refused **before** money moves or IntaSend is called |
| idempotency | the claim is the idempotency key. Wallet rail = claim + buyer credit + seller reversal + evidence in **one** transaction. Chargeback completion is replay-safe (`COMPLETED` → no-op) |
| anchored, never guessed | needs all three payment markers **and** the credit's own ledger row (FinOS `sale` row, or booking `…_booking` row) agreeing on amount and seller. That row picks the field family to reverse |
| seller reversal | the net comes back from the FinOS cents fields first, then from swept `balance`, cent-exact (sub-shilling change returned). The already-withdrawn remainder goes to `refundRecoveryDebt` (existing policy); balance never goes negative. A mirror debit row goes in the same ledger |
| evidence | `settlementStatus` and the credit markers are never overwritten; the refund is new fields (`refundStatus`, `refundRail`, `refundAuthorityId`, `refundedAt`, `sellerCreditReversedCents`). `initiateRefund` no longer overwrites any settled spelling |
| payer only | the wallet rail pays `payments.uid`. A different `targetUid` or a partial amount is refused (previously it credited the calling admin by default) |
| failed chargeback | kept as `CHARGEBACK_FAILED`, never auto-reopened (the gateway outcome may be unknown) |
| chargeback OK, completion failed | the provider id is recorded; `fosApproveRefund` completes it **without** a second chargeback |

**Unchanged by design:**
- A `refundToWallet` reference that matches nothing SOKONI collected keeps the legacy admin credit.
- FOS-native `fosTransactions` refunds keep the legacy path; that collection has never held a document in
  production.
- The exact-uppercase `SETTLED` → `reverseSettledOrder` path.
- The business wallet and `commissionLedger`.

**Commission treatment on refunds is not yet defined and is excluded from this repair.** On a full refund the
seller's net credit (e.g. KES 87) is recovered, and the platform's commission (e.g. KES 10) is **not** reversed.
This is an open accounting-policy question, recorded here so its absence is not mistaken for an omission. A
future commission-reversal change needs its own authority and ledger tests. Owner adjudication, 2026-09-26:
Track F PASS; partial refunds stay refused; missing or conflicting evidence stays refused; failed chargebacks
stay blocked for human review.

**Evidence** (`scripts/test-refund-authority.js`, real Firestore emulator, real wired callables, IntaSend stub
counting every chargeback):

| target | result |
|---|---|
| Track F branch | **55 / 0** |
| **counterproof:** the same suite on pre-repair `b66880b` | **17 / 38 FAIL**. It reproduces the admin-credited-instead-of-payer refund, the unreversed seller credit, a chargeback after a wallet refund, a **second chargeback** via `fosApproveRefund`, a failed chargeback left re-approvable, and `settled` → `REFUNDED` erasure. The unrelated-behaviour checks pass on both, as they should |

**Regressions: none.**
- `test-settlement-proof-gate` 37/0 and `test-canonical-collections` 2/2 on both trees.
- `test-post-pin-money-chain` 32/7 and `test-merchant-ecosystem-convergence` 144/1 fail **identical assertion
  sets** before and after (pre-existing).
- The full predeploy chain passes, including `guard-settled-case` and `test-settled-guard-gate` 12/0/1-skip.

**Deployment note (not requested):** the four refund functions run from **four different lineages** in
production. `refundToWallet`'s `wallet.js` is byte-identical to main; `initiateRefund` and the FOS pair are not.
Any deploy needs per-lineage trees, as with the double-credit fix.

**Production observation (separate from the tests):** 0 refunds of real orders, so nothing to remediate in data.
