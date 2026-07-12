# CB-M1 — Money Path Verification Runbook

**Status:** 🔴 **NO-GO — NOT CLEARED.** Severity is **not** lowered.

---

## ⚠️ The live test has NOT been executed

It requires a live merchant session, a physical handset to accept an M-PESA STK PIN, admin credentials, and real money movement. **No transaction has been performed. No live financial evidence exists.**

**The only acceptable evidence is a real payment, refund, payout, dispute, subscription and settlement — with captured logs and audit evidence.** Code review, static analysis and reasoning are **not** substitutes and will never clear CB-M1.

---

## What HAS been done (code-level only)

A static audit of every payment rail found **three Critical duplicate-ledger defects** — all fixed and deployed. **None were caught by tests; all three would have corrupted the ledger silently.**

| ID | Defect | Impact |
|---|---|---|
| **P0-2** | `intasendWebhook`: non-transactional read-check-write + auto-ID ledger append | Duplicate commission entries on provider retry |
| **P0-3** | `onSellerPaymentCreated`: auto-ID append **+ non-idempotent `FieldValue.increment()`** on an **at-least-once** trigger | **Seller billed commission TWICE for one payment** |
| **P0-4** | Shared webhook wrapper: racy `get()`→`check`→`set()` idempotency claim | One payment event processed twice (4 rails) |

Full analysis: **`PAYMENT_WEBHOOK_STANDARD.md`**. Platform-wide verified: **0** auto-ID money writes, **0** racy idempotency claims.

> ⚠️ P0-2 and P0-3 would most likely have fired **during your live test** — a slow first webhook is exactly what triggers a provider retry.

---

# THE RUNBOOK

**Rules:** smallest safe values (**KES 1**). Test accounts only. Capture evidence at **every** step.
**Any failure → STOP. Record. Fix. Retest that flow from the start. Release stays NO-GO.**

## Evidence to capture (EVERY transaction, no exceptions)

| Field | Value |
|---|---|
| Timestamp (UTC) | |
| Transaction / Order ID | |
| User ID (redact tail: `uid_abc…`) | |
| Amount (KES) | |
| Status | |
| Cloud Function invoked | |
| Firestore doc(s) written (`collection/docId`) | |
| **Ledger entry count** (must be **exactly 1**) | |
| Wallet movement (before → after) | |
| Settlement movement | |
| Notification sent? | |
| Log excerpt / screenshot | |

---

## S1 — MERCHANT FLOW (payment)

**Prerequisites:** merchant test account + POS access; buyer test account; handset with the M-PESA test line; IntaSend/Daraja credentials live; admin console access.

**Steps:** Merchant login → create order (KES 1) → customer pays → confirmation → receipt → wallet update → settlement record → dashboard.

**Expected result**
- `orders/{id}` → `paid`
- `payments/{apiRef}` **or** `posPayments/{checkoutId}` → `COMPLETE`
- **`commissionLedger/{apiRef}` exists EXACTLY ONCE — and its doc id IS the apiRef, not an auto-id** ← *directly verifies P0-2*
- `sellerPayments/{checkoutId}` exactly once
- **`commissionLedger/{paymentId}` exactly once** and `sellerBilling/{seller}/monthly/{period}.totalCommissionKES` increased **exactly once** ← *directly verifies P0-3*
- Wallet credited by **net = gross − commission**
- Receipt generated and delivered

**Evidence:** the table above + a screenshot of the ledger doc **id** + the billing doc before/after.

**Rollback:** refund the KES 1 via S2; if state is stuck, an admin can reverse the order. No code rollback needed unless a defect is found.

**Failure handling:** capture the CF logs for the failing step, the Firestore doc state, and the exact error. Do **not** retry blindly — a retry may mask a duplicate-ledger bug (that is the whole point of the test).

**Success criteria:** every expected item present, **ledger entry count == 1**, wallet math balances.

**Known risks:** commission is computed by `finos-utils.calculateCommission` with a **10% fallback** if it throws — verify the applied rate is the *configured* one, not the fallback.

---

## S2 — REFUND FLOW

**Prerequisites:** a completed S1 payment.

**Steps:** refund request → approval → wallet credit → balance update → ledger entry → customer notification.

**Expected result:** exactly **one** refund record; commission **and** VAT reversed; balance nets to zero after a full refund; customer notified.

**Evidence:** refund doc id, reversal ledger entries, wallet before/after, notification proof.

**Rollback:** n/a (the refund *is* the reversal).

**Failure handling:** if the balance does not net to zero, **stop** — that is a ledger-consistency failure. Record and fix before any further testing.

**Success criteria:** wallet returns to its pre-S1 balance; **no duplicate** refund or reversal entries.

**Known risks:** refunds are keyed by `generateIdempotencyKey(['refund', orderId, amount])`. A **partial** refund of the same amount twice would collide on that key — confirm this is intended before allowing repeat partial refunds.

---

## S3 — PAYOUT FLOW

**Prerequisites:** a seller with a positive pending balance (from S1).

**Steps:** pending payout → admin review → approval → settlement → ledger update → merchant confirmation.

**Expected result:** payout appears **once**; settlement recorded; ledger updated; merchant notified. A **split-settled** order is **skipped** (`status: 'skipped_split'`) and never double-paid.

**Evidence:** payout doc, settlement doc, ledger delta, `skipped_split` proof for a split order.

**Rollback:** if funds have left, this is **not** reversible — hence KES 1.

**Failure handling:** on double payout, **halt all payout processing immediately** and reconcile.

**Success criteria:** exactly one payout; ledger balances; the duplicate-payout guard (`finos.js:442`) demonstrably skips split-settled orders.

**Known risks:** **H2 — subscription/settlement write split-brain** (writes still diverge across 5 stores). Confirm the payout used the correct commission rate.

---

## S4 — DISPUTE FLOW

**Prerequisites:** a completed order; admin access.

**Steps:** open dispute → admin resolution → wallet adjustment (if any) → audit trail → notifications.

**Expected result:** dispute state machine advances; any wallet adjustment appears **once**; an immutable audit entry exists; both parties notified.

**Evidence:** dispute doc, audit-log entry, wallet delta, notifications.

**Rollback:** re-open / re-resolve the test dispute.

**Failure handling:** a missing audit entry is a **compliance failure** — record it.

**Success criteria:** exactly one wallet adjustment; audit trail complete.

**Known risks:** `aosResolveDispute` was **renamed** (`8fe29e2`) and has **never** been exercised — this flow tests it for the first time.

---

## S5 — SUBSCRIPTION FLOW

**Prerequisites:** a merchant/provider test account without an active subscription.

**Steps:** purchase → payment → activation → feature unlock → renewal status.

**Expected result:** exactly **one** subscription record; plan active; gated features unlock; renewal date set.

**Evidence:** subscription doc(s), payment doc, feature-gate check, renewal date.

**Rollback:** cancel the test subscription.

**Failure handling:** if **multiple** subscription records appear across stores, that is **H2 manifesting** — record and stop.

**Success criteria:** one active subscription; enforcement reflects the correct tier and commission rate.

**Known risks:** 🔴 **H2 — subscription WRITES still diverge across 5 stores.** Run `getSubscriptionDivergence` for the test account afterwards and assert **`diverges: false`**.

---

# NEGATIVE TESTS (mandatory — this is where money is actually lost)

**Every test below must assert: NO DUPLICATE LEDGER ENTRIES.**

| # | Test | How | Expected |
|---|---|---|---|
| **N1** | **Duplicate webhook** | Re-POST the identical webhook payload | Second call is a no-op. **Exactly one** `commissionLedger` doc. ← *verifies P0-2* |
| **N2** | **Network timeout** | Delay/drop the webhook ACK so the provider retries | One credit only; ledger count unchanged |
| **N3** | **Retry** | Force the provider's retry path | Idempotent; no second ledger entry |
| **N4** | **Duplicate callback** | Fire `darajaSTKCallback` twice for one `CheckoutRequestID` | Second is skipped ("Already processed (raced)"); one `sellerPayments/{checkoutId}` |
| **N5** | **Replay attack** | Re-send an **old** signed webhook (>5 min) | Rejected by the replay window; **no** ledger write |
| **N6** | **Tampered amount** | Alter the paid amount vs requested | `status: failed` + `auditLogs` entry; **no** credit |
| **N7** | **Cancelled payment** | Ignore the STK prompt | Order unpaid; **zero** ledger/wallet movement |
| **N8** | **Failed settlement** | Force a settlement failure | Marked failed; funds **not** deducted twice; retry idempotent |
| **N9** | **Duplicate refund attempt** | Issue the same refund twice | Second is a no-op (idempotency key); **one** reversal |
| **N10** | **Double payout attempt** | Approve the same payout twice | Second rejected/skipped; **one** payout |
| **N11** | **Trigger redelivery** | Re-create the same `sellerPayments` doc / force redelivery | **One** ledger entry AND `totalCommissionKES` **unchanged** on the 2nd delivery ← *verifies P0-3, the seller-double-billing bug* |
| **N12** | **Concurrent webhook fan-out** | Send 2 identical webhooks simultaneously | Exactly one wins (`create()` ALREADY_EXISTS on the loser) ← *verifies P0-4* |

**Ledger assertion for every test:**
```
count(commissionLedger where paymentId == <id>) == 1
```

---

# SECURITY ASSERTIONS

- [ ] No duplicate charges · [ ] No duplicate refunds · [ ] No duplicate payouts
- [ ] Server-side validation — a client **cannot** alter the settled amount
- [ ] **Ledger consistency:** Σ(gross) = Σ(net) + Σ(commission) across the whole run
- [ ] **Wallet consistency:** balance == Σ(credits) − Σ(debits)
- [ ] Financial collections remain **client-unwritable** (`SEC-F1`: `commissionLedger`/`sellerPayments` → `write: if false`)

---

# EXIT CRITERIA — CB-M1 clears ONLY when ALL hold

- [ ] **S1–S5** complete end-to-end with captured evidence
- [ ] **N1–N12** all behave correctly (**especially N1, N11, N12** — they verify P0-2/3/4)
- [ ] All security assertions hold
- [ ] `SMOKE_TEST_DISPATCH_RENAMES.md` §A passes — the renamed live handlers (`posRefundToWallet`, `aosGetPendingPayouts`, `aosResolveDispute`) have **never** been exercised
- [ ] Every ledger assertion returns **exactly 1**

**If ANY step fails:** keep **NO-GO** · document the exact failure · apply the **minimum** fix · **retest that flow from the start**.

**Do not lower CB-M1's severity. Do not substitute reasoning for evidence.**

Related: [[PAYMENT_WEBHOOK_STANDARD]] · [[RELEASE_v1.0.0_STATUS]] · [[SMOKE_TEST_DISPATCH_RENAMES]] · [[SECURITY_RULES_REVIEW]]
