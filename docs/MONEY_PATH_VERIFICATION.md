# CB-M1 — Money Path Verification

**Date:** 2026-07-12 · **Status:** 🔴 **NO-GO — NOT CLEARED**

---

## ⚠️ Declaration: the live test has NOT been executed

**I cannot execute this verification.** It requires a live authenticated merchant session, a physical handset to receive an M-PESA STK push and enter a PIN, admin credentials to approve a payout, and real money movement. I have none of these.

**No transaction was performed. No evidence of a live payment exists. Nothing below claims otherwise.**

Fabricating a financial verification would be indistinguishable from a real one in a report and is the single most dangerous thing I could do. **CB-M1 therefore remains NO-GO and is not lowered.**

What follows is (A) what I *could* prove without moving money — a code-level audit of the financial safety invariants, which found and fixed a **real Critical defect** — and (B) the runbook you execute to actually clear CB-M1.

---

# PART A — Code-level audit of financial invariants (performed)

## 🔴 DEFECT FOUND AND FIXED — P0-2: IntaSend webhook wrote duplicate ledger entries

**Location:** `functions/index.js` → `intasendWebhook`

**The defect (before):**
```js
const snap = await payRef.get();
if (existing.status === "COMPLETE") return;   // read-check…
await payRef.update({ status: fsStatus });     // …write  ← NOT a transaction
await db.collection("commissionLedger").add({ … });  // ← AUTO-ID append
```
A non-transactional read-check-write followed by an **auto-ID append**. **IntaSend retries webhooks on timeout/5xx.** Two concurrent retries could **both** pass the "already COMPLETE?" check and **both** append → **duplicate commission ledger entries for a single payment**, corrupting ledger consistency and any settlement/payout derived from it.

**This is the exact bug already fixed on the M-PESA rail** (P0-1, whose own comment reads: *"previously a non-transactional read-check-write + `.add()` (auto-ID), which allowed double seller credits on retries"*). **The fix was never applied to the IntaSend rail.**

**The fix (`44bb12d`, deployed):** mirrors the proven P0-1 pattern —
1. **Atomically CLAIM** the `pending → COMPLETE` transition inside `runTransaction` — only one concurrent retry proceeds.
2. Write the ledger with a **deterministic doc id** (`commissionLedger/{apiRef}`) via `.set({merge:true})` instead of `.add()` — **idempotent by construction**; a replay overwrites rather than duplicates.

**Verified:** parses · **0** auto-ID ledger writes remain · architecture guard PASS · deployment integrity PASS (1410 == 1410) · deployed (targeted).

> This defect would have **silently corrupted the ledger during your live test** — and possibly *because* of it, since a slow first webhook is exactly what triggers a provider retry.

---

## Invariants verified in code

| Requirement | Status | Evidence |
|---|---|---|
| **No duplicate charges** (M-PESA) | ✅ **SOUND** | `darajaSTKCallback` transactionally **claims** `pending→completed/failed`; only the winner credits. Credit written to `sellerPayments/{checkoutId}` — **deterministic id, idempotent by construction**. |
| **Replay / spoofing guard** (M-PESA) | ✅ SOUND | Paid amount cross-checked against requested amount; mismatch → `status: failed` + `auditLogs` entry. |
| **Webhook authenticity** (IntaSend) | ✅ SOUND | **HMAC-SHA256** signature verified against `INTASEND_PRIVATE_KEY` before any processing. |
| **No duplicate charges** (IntaSend) | ✅ **FIXED** (`44bb12d`) | Was vulnerable (above). Now transactional claim + deterministic ledger id. |
| **No duplicate refunds** | ✅ SOUND | Refunds keyed by `generateIdempotencyKey(['refund', orderId, amount])`; commission/VAT reversals likewise keyed. |
| **No duplicate payouts** | ✅ SOUND | `finos.js:442` — payouts with `settlementMethod === 'split'` or `splitSettled === true` are **skipped** (`status: 'skipped_split'`). Exactly one settlement path; split-settled orders can never enter the B2C payout queue. |
| **Idempotency (payments)** | ✅ SOUND | `payment-orchestrator.js` resolves an `idempotencyKey` and looks up existing payments by it before creating. |
| **Duplicate in-flight guard (POS)** | ✅ SOUND | `pos-terminal-live.js:406` rejects a new transaction while one is pending/processing for the same order. |
| **Ledger atomicity** | ✅ SOUND | `finos.js` uses `runTransaction` in **9** places for ledger/balance mutations. |
| **Server-side validation** | ✅ SOUND | Amounts, ownership and state transitions validated server-side; client-supplied amounts never trusted for settlement. |

**Conclusion of Part A:** the financial safety model is well-built — a transactional-claim + deterministic-id pattern is used consistently. **One rail (IntaSend) had been missed; it is now fixed.** No other duplicate-credit vector was found by inspection.

**This does NOT clear CB-M1.** Code inspection cannot prove that money actually moves correctly end-to-end.

---

# PART B — Runbook to clear CB-M1 (execute this)

**Rules:** smallest safe values (**KES 1**). Test accounts only. Capture evidence at **every** step. **Any failure → stop, record, fix, retest.**

## Evidence template (record for EVERY transaction)

| Field | Value |
|---|---|
| Timestamp (UTC) | |
| Transaction / Order ID | |
| User ID (redact tail) | `uid_abc…` |
| Amount (KES) | |
| Status | |
| Cloud Function invoked | |
| Firestore doc(s) written | `collection/docId` |
| Wallet movement (before → after) | |
| Settlement / ledger movement | |
| Notification sent? | |
| Log excerpt / screenshot | |

---

## B1 — MERCHANT FLOW (payment)
1. **Merchant login** → session established.
2. **Create order** (KES 1) → record `orders/{id}`, status.
3. **Customer payment** → STK push to handset; enter PIN.
4. **Payment confirmation** → webhook fires.
   - ✅ `payments/{apiRef}` or `posPayments/{checkoutId}` → `COMPLETE`
   - ✅ **`commissionLedger/{apiRef}` exists EXACTLY ONCE** ← *the P0-2 fix; verify the doc id is the apiRef, not an auto-id*
   - ✅ `sellerPayments/{checkoutId}` exists exactly once
5. **Receipt generation** → receipt doc + delivery (email/SMS).
6. **Wallet update** → balance increases by the **net** (gross − commission).
7. **Settlement record** → settlement entry with the correct `settlementMethod`.
8. **Merchant dashboard** → reflects the order, earnings and balance.

## B2 — REFUND FLOW
Refund request → approval → **wallet credit** → balance update → **ledger entry (reversal)** → customer notification.
✅ Assert: exactly **one** refund record; commission/VAT **reversed**; balance nets to zero after a full refund.

## B3 — PAYOUT FLOW
Pending payout → admin review → approval → settlement → ledger update → merchant confirmation.
✅ Assert: payout appears **once**; a split-settled order is **skipped** (`skipped_split`), never double-paid.

## B4 — DISPUTE FLOW
Open dispute → admin resolution → wallet adjustment (if any) → **audit trail** → notifications.

## B5 — SUBSCRIPTION FLOW
Purchase → payment → activation → **feature unlock** → renewal status.
✅ Assert: exactly **one** subscription record. ⚠️ **Known risk (H2):** subscription **writes** still diverge across 5 stores — check the account does not end up with conflicting records (`getSubscriptionDivergence`).

---

## B6 — ROLLBACK / NEGATIVE TESTS (do not skip — this is where money is lost)
| Test | Expected |
|---|---|
| **Failed payment** (decline PIN) | Order stays unpaid; **no** ledger/wallet movement |
| **Cancelled payment** (ignore STK) | Times out cleanly; no partial state |
| **Duplicate webhook** — *replay the same webhook twice* | **Exactly one** `commissionLedger` entry, **one** credit ← **directly tests the P0-2 fix** |
| **Concurrent webhook retries** | Only one wins (transactional claim); no double credit |
| **Failed payout** | Marked failed; funds not deducted twice; retry is idempotent |
| **Duplicate refund attempt** | Second attempt is a no-op (idempotency key) |

## B7 — SECURITY ASSERTIONS
- [ ] No duplicate charges · [ ] No duplicate refunds · [ ] No duplicate payouts
- [ ] Server-side validation (client cannot alter settled amount)
- [ ] **Ledger consistency:** Σ(gross) = Σ(net) + Σ(commission) across the run
- [ ] **Wallet consistency:** wallet balance == Σ(credits) − Σ(debits)

---

## Exit criteria

**CB-M1 is cleared ONLY when:**
- [ ] B1–B5 each complete end-to-end with captured evidence
- [ ] B6 negative tests all behave correctly (**especially the duplicate-webhook replay**)
- [ ] B7 assertions hold
- [ ] Also run: `docs/SMOKE_TEST_DISPATCH_RENAMES.md` §A — the renamed live handlers (`posRefundToWallet`, `aosGetPendingPayouts`, …) have **never** been exercised

**If any step fails:** keep NO-GO · document the exact failure · apply the minimum fix · **retest from the start of that flow.**

Related: [[RELEASE_v1.0.0_STATUS]] · [[SMOKE_TEST_DISPATCH_RENAMES]] · [[SUBSCRIPTION_CONSOLIDATION]]
