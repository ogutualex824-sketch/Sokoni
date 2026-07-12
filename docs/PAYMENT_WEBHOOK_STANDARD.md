# SOKONI — Payment Webhook Standard & P0 Incident Record

**Date:** 2026-07-12 · **Status:** all rails compliant · **CB-M1 remains NO-GO** (these are code fixes; the money path still requires live human verification)

---

# THE STANDARD (mandatory for every payment rail)

```
   authenticate (HMAC/signature)
        ↓
   ATOMIC CLAIM  ── transaction OR create() ──┐
        ↓                                     │ loser bails here
   atomic state transition (pending → final)  │
        ↓                                     ▼
   DETERMINISTIC ledger identifier      (duplicate → no-op)
        ↓
   idempotent write (.set(), never .add())
        ↓
   safe retry  →  re-running changes nothing
```

## 🚫 BANNED PATTERN
```js
const snap = await ref.get();               // read
if (snap.exists) return;                    // check
await ref.set({...});                       // write     ← RACE WINDOW
await db.collection("ledger").add({...});   // AUTO-ID   ← DUPLICATE ON RETRY
```
**Never** `read → check → auto-ID `.add()`` outside a transaction. Providers retry on timeout/5xx; Firestore triggers are **at-least-once**. Both mean the handler *will* run twice.

## ✅ REQUIRED PATTERNS

**A. Transactional claim** (state transition owned by one caller)
```js
let claimed = false;
await db.runTransaction(async (txn) => {
  const s = await txn.get(payRef);
  if (!s.exists || s.data().status === "COMPLETE") return;  // already won by a retry
  txn.update(payRef, { status: "COMPLETE", ... });
  claimed = true;
});
if (!claimed) return;   // a concurrent retry already processed this
```

**B. Atomic set-if-not-exists** (idempotency key)
```js
try {
  await idemRef.create({ provider, eventId, status: "processing" });
} catch (e) {
  if (e.code === 6 /* ALREADY_EXISTS */) return;   // duplicate delivery
  throw e;
}
```

**C. Deterministic ledger id** — one entry per payment, *by construction*
```js
db.collection("commissionLedger").doc(apiRef).set({...}, { merge: true });  // ✅
db.collection("commissionLedger").add({...});                               // ❌
```

---

# INCIDENT RECORD

Three defects of the same class, found by static audit of the money path during CB-M1 preparation. **None were found by tests — all three would have corrupted the ledger silently.**

---

## P0-2 — `intasendWebhook` wrote duplicate commission ledger entries

### Root cause
A non-transactional **read → check → write**, followed by an **auto-ID** ledger append.
```js
const snap = await payRef.get();
if (existing.status === "COMPLETE") return;          // check
await payRef.update({ status: fsStatus });           // write (not atomic)
await db.collection("commissionLedger").add({...});  // AUTO-ID
```
The M-PESA rail had already been hardened against this exact bug (P0-1). **The fix was never applied to the IntaSend rail.**

### Concurrency timeline
```
t0   IntaSend delivers webhook W1.
t1   W1: payRef.get() → status = "PENDING"          ✓ passes the check
t2   W1 begins commission calculation (Firestore read — slow).
t3   IntaSend times out waiting for a 200, RETRIES  → delivers W2.
t4   W2: payRef.get() → status STILL "PENDING"      ✓ passes the check (W1 hasn't written yet)
t5   W1: update(status=COMPLETE) ; commissionLedger.add() → entry A
t6   W2: update(status=COMPLETE) ; commissionLedger.add() → entry B   ← DUPLICATE
```
The race window is exactly the gap between the check (t1/t4) and the write (t5/t6) — which is *widened* by the commission calculation, so a slow first call **increases** the chance of a retry landing inside the window.

### Failure scenario
A single KES 1,000 payment produces **two** `commissionLedger` entries. Commission is counted twice. Every downstream consumer (seller billing, settlement, payout, revenue reporting) reads the doubled figure.

### Impact
- **Ledger integrity destroyed** — the audit trail no longer reflects reality.
- Seller over-charged commission; settlement/payout computed on corrupted data.
- **Silent** — no error, no alert. Only a manual reconciliation would reveal it.

### Fix (`44bb12d`, deployed)
1. **Transactional claim** of `PENDING → COMPLETE` — only one retry proceeds.
2. **Deterministic ledger id** `commissionLedger/{apiRef}` via `.set({merge:true})`.

### Idempotency strategy
The ledger id **is** the payment reference. Writing twice targets the same document, so a replay **overwrites** rather than appends. Idempotent *by construction* — it does not depend on the claim succeeding.

### Transaction design
Claim inside `runTransaction` (short, contention-free: a single-doc read+update). The **commission calculation and ledger write stay outside** the transaction — they are slow/IO-heavy, and the deterministic id already makes them safe. Belt **and** braces: the transaction stops double-processing; the deterministic id stops double-writing.

### Regression protection
- Static check: **0** auto-ID writes to money collections anywhere in `functions/`.
- Negative test **B6** (duplicate-webhook replay) in `MONEY_PATH_VERIFICATION.md` asserts exactly one `commissionLedger` doc, and that its id **is the apiRef** (not an auto-id).

---

## P0-3 — `onSellerPaymentCreated` DOUBLE-BILLED SELLERS

### Root cause
A **Firestore trigger** with two non-idempotent operations. Cloud Functions triggers are **at-least-once** — Google explicitly documents that a trigger may fire more than once for a single event.
```js
await db.collection("commissionLedger").add({...});     // AUTO-ID → duplicate entry
await billingRef.set({
  totalCommissionKES: FieldValue.increment(totalOwed),  // NOT idempotent → double charge
  grossSalesKES:      FieldValue.increment(grossAmount),
  transactionCount:   FieldValue.increment(1),
}, { merge: true });
```

### Concurrency timeline
```
t0   sellerPayments/{id} created.
t1   Trigger fires (delivery #1) → ledger entry A ; billing += commission
t2   Delivery #1's ack is lost / times out (infra hiccup).
t3   Firestore REDELIVERS the same event (at-least-once guarantee).
t4   Trigger fires (delivery #2) → ledger entry B ; billing += commission AGAIN
```
No concurrency is even required — sequential redelivery is enough. This is **more likely** than the P0-2 race.

### Failure scenario
One payment → **two** ledger entries **and** the seller's `totalCommissionKES` incremented twice.

### Impact
**The seller is charged commission twice for a single sale.** This is direct financial harm to the merchant, silently, with a corrupted ledger to match. Of the three, this is the most damaging.

### Fix (`943e8ea`, deployed)
Deterministic id `commissionLedger/{paymentId}` + existence check + ledger write + **both increments** inside **one** `runTransaction`:
```js
const applied = await db.runTransaction(async (txn) => {
  const existing = await txn.get(ledgerRef);
  if (existing.exists) return false;      // redelivery — already accounted for
  txn.set(ledgerRef,  {...});
  txn.set(billingRef, { ...increments }, { merge: true });
  return true;
});
if (!applied) return;
```

### Idempotency strategy
The ledger document is the **idempotency marker**. Its existence proves the payment was already accounted for, so the increments are skipped. Ledger and billing move **together or not at all**.

### Transaction design
The increments **must** be inside the transaction — a deterministic id alone does not protect `FieldValue.increment()`, which would still double-count. Guarding the increment behind the ledger-existence check, atomically, is the only correct fix.

### Regression protection
Negative test: **replay the same `sellerPayments` doc creation** → assert exactly one ledger entry **and** that `totalCommissionKES` did not change on the second delivery.

---

## P0-4 — shared webhook wrapper had a RACY idempotency claim

### Root cause
```js
const idemSnap = await idemRef.get();     // read
if (idemSnap.exists) return;              // check
await idemRef.set({ status: "processing" });  // write ← RACE WINDOW
await onSuccess(payload, eventId);            // processes the payment
```
Affects **`webhookIntasend`, `webhookMpesa`, `webhookStripe`, `webhookSmartpos`** (all share this wrapper). Notably, `financial-os.js` **already used the correct `create()` pattern** — so the platform had two conflicting implementations, and the wrong one served four rails.

### Concurrency timeline
```
t0   Provider delivers event E (or a load balancer fans out a retry).
t1   D1: idemRef.get() → not exists   ✓
t2   D2: idemRef.get() → not exists   ✓   (D1 hasn't written yet)
t3   D1: set(processing) ; onSuccess(E)
t4   D2: set(processing) ; onSuccess(E)   ← the payment event is processed TWICE
```

### Failure scenario / impact
One payment event handled twice by `onSuccess` — duplicate `webhookPayments` / `posTransactions` records, and duplicate downstream effects for anything consuming them.

### Fix (`943e8ea`, deployed)
Atomic **set-if-not-exists**:
```js
try { await idemRef.create({ provider, eventId, status: "processing" }); }
catch (e) { if (e.code === 6 /* ALREADY_EXISTS */) return; throw e; }
```
Exactly one caller wins; the loser bails. **A real infra error is re-thrown**, so the provider retries rather than silently dropping a payment.

### Regression protection
Static check: **0** `get()`-then-`set()` idempotency claims remain. All claims use `create()`.

---

# COMPLIANCE MATRIX (post-fix, verified)

| Rail | Auth | Atomic claim | Deterministic ledger id | Auto-ID `.add()` | Status |
|---|---|---|---|---|---|
| `darajaSTKCallback` (M-PESA) | ✔ amount cross-check | ✔ `runTransaction` | ✔ `sellerPayments/{checkoutId}` | 0 | ✅ (P0-1) |
| `intasendWebhook` | ✔ HMAC-SHA256 | ✔ `runTransaction` | ✔ `commissionLedger/{apiRef}` | 0 | ✅ **P0-2 fixed** |
| `onSellerPaymentCreated` (trigger) | n/a | ✔ `runTransaction` | ✔ `commissionLedger/{paymentId}` | 0 | ✅ **P0-3 fixed** |
| `webhookIntasend` / `Mpesa` / `Stripe` / `Smartpos` | ✔ sig + 5-min replay window | ✔ `create()` | n/a (staging only) | 0 | ✅ **P0-4 fixed** |
| `fosSecureWebhook` | ✔ | ✔ `create()` | ✔ `fosTransactions/{txId}` | 0 | ✅ already compliant |
| `webhookPaymentCallback` (finos) | ✔ | ✔ `runTransaction` | ✔ | 0 | ✅ already compliant |

**Platform-wide, verified by static scan:**
- auto-ID writes to money collections: **0**
- racy `get()`-then-`set()` idempotency claims: **0**
- atomic `create()` idempotency claims: **2**

---

## ⚠️ These fixes do NOT clear CB-M1

They remove three ways the ledger could silently corrupt itself. They do **not** demonstrate that money moves correctly. **Only a real payment, refund, payout, dispute, subscription and settlement — with captured logs and audit evidence — can clear CB-M1.** See `MONEY_PATH_VERIFICATION.md`.

Related: [[MONEY_PATH_VERIFICATION]] · [[RELEASE_v1.0.0_STATUS]]
