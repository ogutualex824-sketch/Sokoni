# SOKONI — Residual Financial Findings Register

**Date:** 2026-07-12 · **Source:** `scripts/audit-financial-safety.js`
**Current matrix:** V1 = **0** · V2 = **11** · V3 = **5** · protected = **57** · annotated `@financial-safe` = **1**

> **None of these is classified Critical.** Escalation requires runtime behaviour + architecture to justify it, not pattern-matching. Each entry below is assessed individually on **event source** and **retry model**, because that is what decides whether duplication can actually happen.

---

## The decisive distinction

| Event source | Retry model | Duplicate execution |
|---|---|---|
| **Firestore trigger** | **AT-LEAST-ONCE** (platform-guaranteed) | **WILL happen.** No user action needed. |
| **Scheduled job** | **Retries on failure** (platform) | **WILL happen** on a failed/partial run. |
| **Webhook** | **Provider retries** on timeout/5xx | **WILL happen.** A slow first call *causes* it. |
| **`onCall`** | **No automatic retry.** Firebase callables do not auto-retry. | Requires a **client-initiated** repeat (double-click, app retry, user re-submit). |

**Every Critical defect found so far (P0-1…P0-6) was on an at-least-once source** — trigger, webhook, or scheduled job. **All 16 residual findings are `onCall`.** That is the entire reason they are not Critical: duplication requires a human or client to re-fire the call, not the platform.

It does **not** make them safe. A double-clicked "Approve & Pay" is a real event.

---

# V2 — non-idempotent money increment (11)

### R1 · `procurement.js:675` — supplier invoice payment ⚠️ **HIGHEST RESIDUAL**
| | |
|---|---|
| **Surface** | Supplier / procurement balance |
| **Event source** | `approveAndPayInvoice` (`onCall`) |
| **Retry model** | Client-initiated only (no auto-retry) |
| **Financial impact** | **REAL KES.** `currentBalance: increment(-inv.total)` — a duplicate call **double-debits the supplier balance**. |
| **Likelihood** | **Medium.** "Approve & Pay" is precisely the button a user double-clicks, and a slow response invites it. |
| **Evidence** | Increment on a real money balance with no transaction and no idempotency marker. |
| **Recommended action** | **Fix next.** Guard with a deterministic marker: `procurementPayments/{invoiceId}` created inside a transaction; skip if it exists. Also disable the button on submit (defence in depth, not a substitute). |

### R2 · `dispatch.js:345` — driver earnings on proof-of-delivery
| | |
|---|---|
| **Surface** | Driver earnings |
| **Event source** | `captureProofOfDelivery` (`onCall`) |
| **Retry model** | Client-initiated |
| **Financial impact** | **REAL KES.** `totalEarnings: increment(delivery.driverNet)` — duplicate call over-credits driver earnings. |
| **Likelihood** | **Low-Medium.** Delivery apps commonly retry on flaky mobile networks. |
| **Evidence** | Batch write, no idempotency marker on the delivery. |
| **Recommended action** | Guard on `delivery.status !== 'delivered'` **inside a transaction** (claim the transition), so a repeat call is a no-op. Same shape as the P0-5 fix. |

### R3 · `navigation.js:576` — driver earnings on trip completion
| | |
|---|---|
| **Surface** | Driver earnings |
| **Event source** | `navCompleteTrip` (`onCall`) |
| **Retry model** | Client-initiated |
| **Financial impact** | **REAL KES.** `totalEarnings: increment(earnings)`. |
| **Likelihood** | **Low-Medium** (same mobile-retry exposure). |
| **Evidence** | Batch update; no claim of the trip's `completed` transition. |
| **Recommended action** | Transactionally claim `trip.status: in_progress → completed`; only the winner credits. |

### R4–R8 · AI credit balances (money-equivalent, not KES)
`ai-subscriptions.js:98` (`activateAIPlan`) · `ai-subscriptions.js:199`, `:261` (`topupAICredits`) · `sasos-core.js:624` (`sasosSubscribe`) · `subscription-os.js:319` (`processSubscriptionChange`) · `sasos-usage.js:269` (`sasosAllocateCredits`, admin)

| | |
|---|---|
| **Surface** | AI credit balance (a **paid** product) |
| **Event source** | All `onCall` |
| **Retry model** | Client-initiated |
| **Financial impact** | **Revenue leakage** — a duplicate call grants free credits. Not customer harm; company loses. |
| **Likelihood** | **Low-Medium** (a duplicate top-up click grants double credits). |
| **Evidence** | `balance: increment(credits)` with no idempotency marker. |
| **Recommended action** | Key on the **payment reference** (`aiCredits/{uid}` guarded by `aiPaymentRefs/{paymentRef}` created atomically). `subscription-os.js` already has an `aiPaymentRefs` collection — **use it consistently.** |

### R9–R11 · Aggregate statistics (NOT balances)
`loyalty-enterprise.js:474` (`totalSpendKES`) · `pos-zero-friction.js:223` (`totalRevenue`) · and related counters.

| | |
|---|---|
| **Surface** | Reporting aggregates |
| **Event source** | `onCall` |
| **Financial impact** | **LOW — no money moves.** These are read-only reporting totals; over-counting skews a dashboard, it does not create or destroy value. |
| **Likelihood** | Low-Medium |
| **Evidence** | Increment on a stat field, not a balance. |
| **Recommended action** | **Do not fix urgently.** Correct opportunistically when the enclosing operation is next touched. Flagged only because the field name pattern-matches money. |

---

# V3 — racy `get()` → `exists` → `set()` idempotency claims (5)

### R12 · `pos-zero-friction.js:79` — POS checkout ⚠️ **verify at runtime**
| | |
|---|---|
| **Surface** | POS sale / checkout |
| **Event source** | `posCompleteCheckout` (`onCall`) |
| **Retry model** | Client-initiated |
| **Financial impact** | **Potentially real** — a lost race could produce **two sales** for one checkout (duplicate revenue, double inventory decrement). |
| **Likelihood** | **Low.** Requires two genuinely concurrent calls for one checkout. The claim does track `processing`/`complete` states, which narrows (but does not close) the window. |
| **Evidence** | `idemRef.get()` → `if (exists) …` → `idemRef.set({status:'processing'})` — non-atomic. |
| **Recommended action** | Replace with atomic `create()` (pattern A). **Cheap, safe, no behaviour change.** Highest-value V3 fix. |

### R13 · `ai-subscriptions.js:191` — credit top-up claim
Same racy pattern guarding an AI-credit top-up. **Impact:** revenue leakage on a lost race. **Action:** atomic `create()`.

### R14 · `subscription-os.js:298` — subscription change claim
Racy claim around `processSubscriptionChange`. **Impact:** possible double activation / double credit grant. **Action:** atomic `create()` — the file already has an `aiPaymentRefs` idempotency collection; use it.

### R15 · `pos-retail.js:48` — marketplace sync
`posSyncIdempotency/{saleId}` — deterministic id, racy claim. **Impact:** a duplicate *sync*, not a duplicate *payment*. Downstream writes are keyed by `saleId`. **Action:** atomic `create()`; low urgency.

### R16 · `wap.js:879` — workflow refund — ✅ **BENIGN (verified)**
| | |
|---|---|
| **Evidence** | Racy `get()`→`set()`, **but** the refund doc id is **deterministic** (`refunds/{orderId}_refund`) and the function **moves no money** — it writes a `status: "processing"` record only. Two racers write the **same** document with identical data. |
| **Financial impact** | **NONE.** No duplicate refund record, no wallet movement. |
| **Recommended action** | **No fix required for correctness.** Tidy to `create()` opportunistically. |

> R16 is why this register exists. A blanket "5 racy claims = 5 risks" would have been **wrong**. Only per-finding verification reveals that one of them cannot cause a duplicate financial movement at all.

---

# Prioritised action list (evidence-ordered)

| Priority | Finding | Why |
|---|---|---|
| **1** | **R1** `procurement.js:675` | Real KES, double-debit, double-click-plausible |
| **2** | **R12** `pos-zero-friction.js:79` | Duplicate sale possible; `create()` fix is trivial |
| **3** | **R2, R3** driver earnings | Real KES; fix via transactional status claim |
| **4** | **R4–R8** AI credits | Revenue leakage; standardise on `aiPaymentRefs` |
| **5** | **R13–R15** racy claims | Mechanical `create()` swap |
| **—** | **R9–R11** stats · **R16** | No money moves. Opportunistic only. |

**Not scheduled as a bulk refactor.** Each is fixed individually, with evidence, when touched — per the standing directive.

---

## Escalation criteria

A residual finding is **escalated to Critical** only if **any** of these becomes true:

1. Its event source becomes **at-least-once** (moved to a trigger, webhook, scheduler, or task queue).
2. A **client is observed** retrying it automatically (SDK retry, queue, offline replay).
3. **Runtime evidence** of an actual duplicate financial movement appears (reconciliation mismatch, duplicate ledger row, support ticket).

**Until then they remain tracked, not Critical.** Evidence governs — not pattern-matching.

Related: [[FINANCIAL_TRANSACTION_STANDARD]] · [[RELEASE_v1.0.0_STATUS]] · [[MONEY_PATH_VERIFICATION]]
