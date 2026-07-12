# SOKONI — FINANCIAL TRANSACTION STANDARD

**Version:** **1.1.0** · **Effective:** 2026-07-12 · **Status:** MANDATORY. **No exceptions.**
**Enforced by (both are permanent CI gates):**
- `scripts/audit-financial-safety.js --ci` — static compliance
- `scripts/test-financial-idempotency.js` — behavioural proof (25 tests)

**Any new payment-related code MUST pass both.**

## Scope — this standard governs ALL of:
**Wallets · Payments · Refunds · Settlements · Subscriptions · Commissions · Payouts · Driver earnings · Merchant balances · Ledger operations**
…across every payment rail, webhook, Firestore trigger, scheduled job and task queue.

## Version history
| Version | Date | Change |
|---|---|---|
| **1.1.0** | 2026-07-12 | Added: scheduled jobs named as an at-least-once source (P0-6). Added F5 (written-but-never-read guard) and F4 (batch ≠ idempotent). Added the `@financial-safe:` annotation — an explicit, *justified*, **visible** suppression for guards the static tool cannot infer. |
| **1.0.0** | 2026-07-12 | Initial: 8 invariants, F1–F3, patterns A–D, incident ledger (P0-1…P0-5). |

## Compliance today
`V1 = 0 · V2 = 11 · V3 = 5 · protected = 57 · annotated = 1` — **zero Critical**. All 16 residual findings are `onCall` (no automatic retry) and are individually assessed in **`RESIDUAL_FINANCIAL_FINDINGS.md`**. They are **not** bulk-refactored.

---

# THE EIGHT INVARIANTS

Every money-touching code path MUST be:

| # | Invariant | Means |
|---|---|---|
| 1 | **Idempotent** | Running it twice produces the same result as running it once |
| 2 | **Transaction-safe** | Read-check-write happens atomically |
| 3 | **Retry-safe** | A provider/client retry cannot double-charge |
| 4 | **Replay-safe** | An old/duplicate event is rejected |
| 5 | **Duplicate-safe** | Exactly one ledger row, exactly one financial movement |
| 6 | **Audit logged** | Every movement leaves an immutable record |
| 7 | **Deterministic identifiers** | Ledger doc ids derive from the payment, never auto-generated |
| 8 | **Atomic state transition** | `pending → final` is claimed by exactly one caller |

---

# TWO TRUTHS THAT DRIVE EVERYTHING

### 1. Retries are guaranteed, not hypothetical
- **Payment providers retry** webhooks on timeout/5xx. A slow first call *causes* a retry.
- **Firestore triggers are AT-LEAST-ONCE.** Google documents that a trigger may fire more than once for a single event. **You do not get to assume once.**

### 2. `FieldValue.increment()` is NOT idempotent
This is the single most dangerous misconception in the codebase. `increment()` is *atomic* — it is **not** *idempotent*. Running it twice adds twice.

> **A deterministic doc id does NOT protect an `increment()`.** P0-3 had both a deterministic-able id *and* an increment; only the transaction-guarded existence check fixed it.

---

# 🚫 FORBIDDEN PATTERNS

### F1 — auto-ID `.add()` into a money collection
```js
await db.collection("commissionLedger").add({ ... });   // ❌ retry → SECOND row
```
**Why:** a retry appends a duplicate ledger row. The ledger no longer reflects reality.
**Caused:** P0-2, P0-3.

### F2 — `increment()` outside a transaction/idempotency guard
```js
await ref.set({ balance: FieldValue.increment(amount) }, { merge: true });  // ❌
```
**Why:** not idempotent. A retry or trigger redelivery double-credits.
**Caused:** P0-3 (sellers billed twice), P0-5 (drivers paid twice).

### F3 — racy idempotency claim
```js
const snap = await idemRef.get();      // read
if (snap.exists) return;               // check
await idemRef.set({ ... });            // write   ← RACE WINDOW
```
**Why:** two concurrent deliveries both read "not exists" and both proceed.
**Caused:** P0-4.

### F4 — `db.batch()` used as if it were an idempotency guard
```js
const batch = db.batch();
batch.set(walletRef, { balance: increment(amt) });   // ❌ atomic, but NOT idempotent
await batch.commit();
```
**Why:** a batch is **atomic**, not **idempotent**. It guarantees all-or-nothing, *not* once-only.
**Caused:** P0-5.

### F5 — writing an idempotency marker but never reading it
P0-5 wrote `processed: true` on the queue doc and **never checked it**. A guard you don't read is not a guard.

---

# ✅ REQUIRED PATTERNS

### A — Atomic idempotency lock (`create()`), for webhooks/entry points
```js
const ikey    = generateIdempotencyKey(['payment', orderId]);
const idemRef = db.collection('finosIdempotency').doc(ikey);
try {
  await idemRef.create({ key: ikey, status: 'pending', createdAt: now() });
} catch (e) {
  if (e.code === 6 /* ALREADY_EXISTS */) {
    const snap = await idemRef.get();
    if (snap.exists && snap.data().status === 'completed') return snap.data().result;  // cached
    throw new HttpsError('aborted', 'Duplicate — already being processed.');
  }
  throw e;   // a REAL infra error → re-throw so the provider retries
}
```
**Reference implementation:** `finos-router.js:146` — *"lock FIRST before any financial work."*

### B — Transactional claim of a state transition
```js
let claimed = false;
await db.runTransaction(async (txn) => {
  const s = await txn.get(payRef);
  if (!s.exists || s.data().status === 'COMPLETE') return;   // a retry already won
  txn.update(payRef, { status: 'COMPLETE' });
  claimed = true;
});
if (!claimed) return;
```
**Reference:** `darajaSTKCallback`, `intasendWebhook`.

### C — Deterministic ledger id + guarded increment (the trigger pattern)
```js
const ledgerRef = db.collection('commissionLedger').doc(paymentId);   // deterministic
const applied = await db.runTransaction(async (txn) => {
  const existing = await txn.get(ledgerRef);
  if (existing.exists) return false;            // redelivery → already accounted for
  txn.set(ledgerRef,  { ...entry });
  txn.set(billingRef, { total: FieldValue.increment(amt) }, { merge: true }); // safe: runs once
  return true;
});
if (!applied) return;
```
**Reference:** `onSellerPaymentCreated` (P0-3 fix), `processDriverEarning` (P0-5 fix).
**The ledger document IS the idempotency marker.** Its existence proves the money already moved.

### D — Wallet primitives take a transaction handle
```js
creditWalletTxn(txn, db, entityId, 'seller', amountCents, { orderId });   // ✅
```
Never credit a wallet outside a transaction. **Reference:** `finos-utils.js`.

---

# RULES BY SURFACE

| Surface | Rule |
|---|---|
| **Webhook** | Verify signature → **atomic `create()` lock** (A) → transactional claim (B) → deterministic ledger id (C). Reject events older than the replay window (5 min). |
| **Firestore trigger** | **Assume at-least-once.** MUST use pattern C. A batch is not enough (F4). |
| **Ledger** | Doc id derives from the payment (`{apiRef}`, `{paymentId}`, `{queueDocId}`). **Never `.add()`.** Immutable: `allow write: if false` — Cloud Functions only (SEC-F1). |
| **Settlement** | Exactly one path per order. Split-settled orders MUST be skipped by the payout queue (`skipped_split`). |
| **Refund** | Deterministic key `['refund', orderId, amount]`. Reverse commission **and** VAT. Full refund must net the wallet to its pre-payment balance. |
| **Payout** | Guard against double payout. Funds leaving is **irreversible** — the guard is the only protection. |
| **Subscription** | Exactly one active record per account. Activation must be idempotent (a payment retry must not double-activate or double-charge). |
| **Wallet** | Mutations only inside a transaction, only via Cloud Functions. Client rules must be `write: if false` / admin-only. Wallet create must force `balance == 0`. |
| **Retry behaviour** | Re-running an operation changes nothing. Re-throw genuine infra errors so the provider retries; never swallow them (a swallowed error = a silently dropped payment). |
| **Replay protection** | Signature + timestamp window. An old signed event must be rejected before any write. |

---

# ENFORCEMENT

```bash
node scripts/audit-financial-safety.js        # report + compliance matrix
node scripts/audit-financial-safety.js --ci   # exit 1 on any violation
```

Detects:
- **V1** auto-ID `.add()` into a money collection (F1)
- **V2** `increment()` on a money field with no transaction handle / no atomic lock (F2, F4)
- **V3** racy `get()`→`exists`→`set()` idempotency claim (F3)

**Wire `--ci` into the pipeline. A new payment path that violates the standard must not merge.**

---

# INCIDENT LEDGER (why this document exists)

| ID | Defect | Impact | Fixed |
|---|---|---|---|
| **P0-1** | M-PESA callback: read-check-write + auto-ID | Double seller credit | ✅ |
| **P0-2** | IntaSend webhook: same pattern, never patched | Duplicate commission ledger rows | ✅ `44bb12d` |
| **P0-3** | `onSellerPaymentCreated` trigger: auto-ID + `increment()` | **Sellers billed commission TWICE** | ✅ `943e8ea` |
| **P0-4** | Shared webhook wrapper: racy idempotency claim | One payment event processed twice (4 rails) | ✅ `943e8ea` |
| **P0-5** | `processDriverEarning` trigger: batch + `increment()` + auto-ID | **Drivers PAID TWICE** | ✅ `b026f90` |

**Every one of these was found by static audit. None was caught by a test. All five would have corrupted money silently.**

That is why this standard is mandatory — and why static verification alone is still **not sufficient** to release. See `MONEY_PATH_VERIFICATION.md` (**CB-M1 remains NO-GO**).
