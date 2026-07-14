# Financial Integrity — Independent Forensic Audit

**Date:** 2026-07-14 · **Auditor stance:** adversarial (tried to break each fix, did not assume correctness)
**Method:** attack simulations + Firebase's authoritative `firebaserules:test` API + the shipped Firestore SDK's own transaction semantics. Not a code read.

> ## RECOMMENDATION: **DO NOT MERGE** (for the POS/wholesale set) — **2 confirmed defects, 1 of them P0.**
> The Firestore Rules hardening (P2-1) and the idempotent `deductWallet` (P0-2) **PASS** and are production-ready.
> The other three areas are **not safe to ship** as written.

---

## Production readiness score: **41 / 100**

Weighted by money at risk. Two of the five reviewed fixes are sound; one is non-functional; one is
a real duplication defect; one (P1-2 referral) could not be located at all.

---

## Findings

### 🔴 P0 — `posCompleteCheckout` wallet payment ALWAYS THROWS (fix is non-functional)
`functions/pos-zero-friction.js:148-200`

The wallet debit and the inventory deduction share one `runTransaction`. Inside it, the wallet block
**writes** and *then* the inventory loop **reads**:

```
L160  txn.set(walletDocRef, { balance: increment(-walletAmt) })   // WRITE
L164  txn.set(walletTxRef,  { ... })                              // WRITE
L180  const snap = await txn.get(ref)                             // READ — after a write
```

**Root cause.** Firestore requires *all reads before all writes* in a transaction. The installed SDK
enforces it: `@google-cloud/firestore/build/src/transaction.js:96` throws
`"Firestore transactions require all reads to be executed before all writes."` the moment `get()` is
called with a non-empty write batch.

**Proven.** Replaying the exact call order (set, set, get) against those semantics throws every time.

**Impact.** *Every* wallet-paid POS sale fails with an `internal` error. The idempotency key is then
marked `failed` (`:290`), so the customer cannot even retry cleanly. Cash/card sales are unaffected.
This is not a race — it is a 100% failure of the feature the fix was meant to deliver.

**Remediation.** Do ALL reads first, then ALL writes:
```js
const productSnaps = await Promise.all(refs.map(r => txn.get(r)));   // reads
const [wTxSnap, wSnap] = await Promise.all([txn.get(walletTxRef), txn.get(walletDocRef)]);
// ...validate...
txn.set(walletDocRef, ...); txn.set(walletTxRef, ...); productSnaps.forEach(...txn.update...)   // writes
```

---

### 🔴 P1 — `createWholesaleOrder` is not idempotent; a retry writes a SECOND order + ledger row
`functions/b2b-wholesale.js:332-366`

```
L107  const rand = Math.random().toString(36).slice(2, 8);   // _genId
L332  const orderId  = _genId('wo');   // random
L333  const ledgerId = _genId('wl');   // random
L354  const batch = db.batch();
L355  batch.set(wholesaleOrders.doc(orderId), order);
L356  batch.set(wholesaleLedger.doc(ledgerId), { amount: total, ... });
L366  await batch.commit();
```

Three violations of `FINANCIAL_TRANSACTION_STANDARD.md` at once:
- **F1** — money-doc ids are random (`Math.random()`), so a retry cannot land on the same document.
- **F4** — a `db.batch()` is atomic, **not** idempotent. It guarantees all-or-nothing, not once-only.
- **No idempotency key.** The callable accepts none (`req.data` = `{ items }` only) and performs no dedup.

**Impact.** A double-tap, a browser refresh mid-request, or a Cloud Function retry creates a **duplicate
wholesale order and a duplicate outstanding-ledger entry**. The buyer is billed twice; the ledger
overstates receivables. No client action can prevent it because nothing is keyed.

**Remediation.** Require an `idempotencyKey` from the client; derive `orderId` from it
(`wholesaleOrders/{idempotencyKey}`); write order + ledger inside a `runTransaction` that returns
early if the order doc already exists (Pattern C). Ledger id must be deterministic
(`{orderId}` or `{orderId}:order`).

---

### 🟠 P1 (adjacent, found while auditing) — `refundToWallet` double-credits on a double-tap
`functions/pos-crm-pro.js:215-240`

Unlike its sibling `deductWallet`, the refund path:
- credits the wallet with a **bare `_INC()` outside any transaction** (F2), and
- writes its transaction record with **`posWalletTransactions.doc()` — an auto-id** (F1).

**Impact.** A manager tapping "Refund" twice, or a retried call, **credits the customer wallet twice**.
There is no deterministic key and no guard. `deductWallet` got this right (`{sellerId}_{phone}_{saleId}_deduct`
+ in-transaction existence check); the refund path did not inherit that discipline.

**Remediation.** Mirror `deductWallet`: deterministic txn id (e.g. `{...}_{saleId}_refund`), existence
check + credit inside one `runTransaction`.

---

### ⚪ P1-2 — Referral wallet transaction redesign: NOT FOUND
No commit, and no code, implements a referral→wallet credit redesign. `grep` for referral wallet
crediting returns only email templates and marketing copy. Either the fix was never written, or it
lives under a name the brief did not give. **Cannot certify what does not exist.** If it was expected,
it is missing; if referral bonuses do flow to wallets, that path was not located and must be pointed out.

---

### ✅ P0-2 — `deductWallet` is idempotent and concurrency-safe (PASS)
`functions/pos-crm-pro.js:173-209`

Deterministic txn id `{sellerId}_{normPhone}_{saleId}_deduct`; existence check + balance guard + debit
all **inside** one `runTransaction`. Attacked with:
- double-tap (same saleId twice) → **one** deduction (1000→700, not 400)
- two concurrent distinct sales on one wallet → both apply, no lost update (1000→500)
- a competitor commit injected *after* this txn's reads → txn retries, competitor's deduction survives (700→600)
- over-spend → rejected, balance untouched, never negative

All pass. This is the correct pattern, and it is what the other two paths should copy.

### ✅ P2-1 — Firestore Rules hardening (PASS)
Verified with Firebase's authoritative `firebaserules:test` engine, as an authenticated attacker:

| Attempt | Result |
|---|---|
| create own `wallets/{uid}` with `availableBalance: 1,000,000` (the forge) | **DENIED** |
| create own wallet `balance:0` | **DENIED** |
| update own wallet balance | **DENIED** |
| write `posWallets` / `posWalletTransactions` | **DENIED** |
| write `ledger` / `wholesaleLedger` / `commissionLedger` | **DENIED** |
| read another user's wallet | **DENIED** |

Client code cannot write any financial record directly. Note: three `match /wallets/` blocks exist
(rules union), which is confusing and should be consolidated, but the effective posture is correct —
no client write path exists. **Cosmetic cleanup recommended, not a security issue.**

---

## Invariant scorecard

| Invariant | Verdict |
|---|---|
| Wallet balances never inconsistent | **deductWallet: yes · refundToWallet: NO (double credit)** |
| A transaction can never deduct twice | **deductWallet: yes · posCompleteCheckout: N/A (never completes)** |
| Referral bonuses cannot be credited twice | **UNVERIFIABLE — path not found** |
| Wholesale transactions idempotent | **NO — duplicate order + ledger on retry** |
| Ledger entries immutable / no client writes | **YES — rules verified** |
| No orphaned wallet transactions | **refundToWallet: auto-id can orphan on retry** |
| Firestore Rules cannot be bypassed | **YES — 7/7 attacks denied** |

---

## Repository-wide risk sweep

- `Math.random()` in a financial id: **`b2b-wholesale.js:109`** (used for order/ledger — a defect, above).
  `financial-os.js:98` uses it for an initiation `payRef` that IS later idempotency-guarded at the
  webhook — lower risk, but should move to a deterministic ref.
- Auto-id `.doc()` on a money txn: **`pos-crm-pro.js` refundToWallet** (above).
- Non-transactional `increment()` on a balance: **`pos-crm-pro.js` refundToWallet** (above);
  plus the static-audit residual V2/V3 baseline (16 `onCall` findings in `ai-subscriptions`,
  `sasos-*`, `subscription-os`, `pos-retail`, `pos-zero-friction`, etc.) documented in
  `RESIDUAL_FINANCIAL_FINDINGS.md` — pre-existing, not introduced by these fixes.

---

## Regression note
The commission-engine migration (separate, already certified) is untouched by these areas and its
gates remain green. These findings are confined to the POS wallet / wholesale / refund paths.

---

## Bottom line
- **P0-2, P2-1:** approve.
- **P0-1 (POS wallet checkout):** DO NOT MERGE — non-functional, 100% failure.
- **P1-1 (wholesale):** DO NOT MERGE — double-charge on retry.
- **refundToWallet:** fix alongside — double-credit on retry.
- **P1-2 (referral):** locate or implement; cannot certify absence.

Fix the two write-order/idempotency defects using Pattern C (which `deductWallet` already demonstrates),
re-run these attack scripts, and this set moves to APPROVE.
