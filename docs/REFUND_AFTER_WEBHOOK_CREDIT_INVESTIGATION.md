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
