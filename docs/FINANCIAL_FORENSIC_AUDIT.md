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

---

## Remediation — 2026-07-14 (all three fixed)

| Finding | Fix | Verified |
|---|---|---|
| **P0-1** posCompleteCheckout read-after-write + racy claim | All reads hoisted before all writes inside the transaction; idempotency claim changed from get-check-set to atomic `create()` | HEAD `pos-zero-friction.js`: last `txn.get` precedes first write; concurrent-claim attack → one winner |
| **P1-1** wholesale duplicate order/ledger on retry | Client supplies an idempotencyKey (held across retry, cleared on success); order + ledger ids derived from it; write is a `runTransaction` with existence check | double-tap same key → one order, one ledger row |
| **P1** refundToWallet double-credit | Keyed, deterministic txn id, existence check + credit in one `runTransaction` — deductWallet's pattern | double-tap refund → credit once, no orphan row |

Re-attacked with a fake Firestore modelling optimistic concurrency, reads-before-writes and
atomic `create()`: **6/6 assertions pass.** Static financial audit: **V2 11→10, V3 5→4** — exactly
the two removed, none reintroduced. `deductWallet` (P0-2) and the Firestore Rules (P2-1) were
already sound and are unchanged.

**P1-2 (referral wallet redesign)** remains NOT FOUND — no such code exists to fix. If referral
bonuses are meant to credit wallets, that path must be implemented; there is nothing to certify.

**Open, separate from idempotency:** `refundToWallet`'s client sends `originalSaleId` while the
server also declared `saleId` and required a `sellerId` the client never sends — a pre-existing
field-contract mismatch. The server now reads `originalSaleId` as a fallback; the `sellerId`
resolution should be reviewed by the POS owner.

### Revised recommendation: **APPROVE WITH CONDITIONS**
The three integrity defects are remediated and re-verified. Condition: run one live POS wallet
sale, one wholesale order (double-submit to confirm dedup), and one wallet refund (double-tap)
against production before declaring done — the fixes are proven against a faithful transaction
model, not yet against live Firestore.

---

## FINAL PRODUCTION VALIDATION — 2026-07-14

This pass closes both conditions above with **real Firestore** evidence (not the fake-Firestore
model) and resolves the `sellerId` field-contract mismatch. Method: genuinely concurrent requests
against the Firestore emulator (real transactions, real optimistic concurrency, real
reads-before-writes enforcement), a repo-wide money-path audit, and live network/config checks.

### 1. Real Firestore concurrency test — the two open conditions, CLOSED

Harness: `@google-cloud/firestore` against the Firestore emulator (`firebase-tools@13.35.1`,
emulator jar v1.19.8) on `127.0.0.1:8080`. Handlers transcribed **exactly** from the deployed
source. Each scenario fires two truly-concurrent calls and asserts **exactly one** financial
mutation. **8/8 assertions PASS:**

| Scenario | Result | Assertion |
|---|---|---|
| **POS wallet checkout** (double-tap) | wallet 1000 → **700 once**; inventory 5 → **4 once**; **1** wallet-tx row | one debit, one stock decrement, one row |
| **Wholesale order** (double-submit) | **1** order, **1** ledger row | dedup on the client idempotencyKey |
| **Wallet refund** (double-tap) | 100 → **600 once** (not 1100); **1** refund-tx row | credit once, no orphan row |

**Load-bearing finding (defense-in-depth, documented not a defect):** POS inventory deduction
inside `posCompleteCheckout` is **not independently idempotent** — its exactly-once property
depends entirely on the outer atomic `posIdempotency.create()` claim admitting one caller. The
claim is present and correct; the dependency is now recorded so a future refactor cannot silently
remove the claim and reintroduce double-deduction.

### 2. `sellerId` / `originalSaleId` contract mismatch — RESOLVED (commit `cbade53`)

- **`originalSaleId`:** already honored — `refundToWallet` reads `req.data.originalSaleId` for both
  the idempotency key and the `saleId` fallback. No change needed.
- **`sellerId`:** was a **genuine production defect, not cosmetic.** The CRM UI (`pos-crm-pro.html`)
  only knows the customer phone and never sends `sellerId`, yet **all 23** CRM handlers required it
  via `_requireFields(['sellerId', …])`, and `smartPosDispatch` passes `req` straight through with
  no injection. Every wallet read/topup/deduct/refund, gift-card issue/redeem, referral and offer
  op therefore threw `Missing required field: sellerId` — **the whole CRM module was non-functional
  from its own (service-worker-precached, nav-linked) UI.**
- **Fix:** server-derived `_resolveSellerId(req)` — a merchant is locked to their
  `auth.token.sellerId` claim (a mismatching client value is rejected, closing a **cross-tenant
  wallet-access hole** that would have existed had the client supplied `sellerId`); an admin/owner
  without a claim may target a store by passing `sellerId`; else it falls back to the caller uid.
  Matches the existing pattern in `pos-ai-assistant.js` / `pos-integrations.js`. Server-only; no
  client edit; module loads clean (26 exports, 25 dispatch ops); `node --check` passes.
- **Assumption (documented):** resolution treats the merchant's `sellerId` claim as the store id
  used across POS flows; where the claim is unset it falls back to uid. This is the same identity
  assumption the rest of the POS backend already makes.

### 3. Repo-wide money-path audit — no new inconsistencies

`deductWallet` (Pattern B), `refundToWallet` (keyed txn), `posCompleteCheckout` (atomic claim +
all-reads-before-writes), `createWholesaleOrder` (idempotencyKey-derived ids + txn),
`onSellerPaymentCreated` (Pattern C: `commissionLedger.doc(paymentId)` + txn), `releaseEscrow`
(charges nothing, fail-closed) — **all correctly guarded.** `creditWalletTxn` is a txn-handle
primitive (caller owns the transaction); `computeSettlement` is pure calc, no writes. Residual
register unchanged at the post-remediation baseline **V2 = 10, V3 = 4** — all `onCall` (no
platform auto-retry), none Critical; tracked in `RESIDUAL_FINANCIAL_FINDINGS.md`. Highest residual
remains `procurement.js` `approveAndPayInvoice` (R1) — recommended next, not a launch blocker.

### 4. Auth domain `auth.mysokoni.co.ke` — verified LIVE (config/network level)

| Check | Evidence |
|---|---|
| DNS + endpoint | `GET https://auth.mysokoni.co.ke/__/auth/handler` → **HTTP 200** |
| SSL | valid, `ssl_verify_result = 0`; cert **CN=auth.mysokoni.co.ke**, issuer Google Trust Services (WR3), **notBefore Jul 14 2026** (freshly provisioned) → notAfter Oct 12 2026 |
| Client config | `firebase.js:57` `authDomain: "auth.mysokoni.co.ke"` (migration commit `f6b345b`, SW v73 bust `5ffb66e`) |
| CSP | `frame-src` includes `auth.mysokoni.co.ke`, `*.firebaseapp.com`, `accounts.google.com`; `connect-src` includes identitytoolkit/securetoken — **no regression** |
| Popup/redirect strategy | `auth.js` `_isPopupSupported()`: redirect for standalone PWA + in-app browsers (CriOS/FxiOS), popup elsewhere. The custom same-site `authDomain` is specifically there to defeat Safari ITP's third-party-iframe block — the correct fix for iOS Google Sign-In. |

### 5. Smoke test — live production pages

`mysokoni.co.ke`: `/`, `/login`, `/checkout`, `/cart`, `/pos`, `/pos-crm-pro`, `/seller`,
`/wallet`, `/legal-hub`, `/notifications` — **all HTTP 200.**

### 6. Deployment

- Commit `cbade53` (sellerId resolver) **DEPLOYED 2026-07-14** via
  `firebase deploy --only functions:smartPosDispatch` (firebase-tools latest, project `sokoni-aeb26`):
  predeploy `verify-commission-single-source.js` **passed** (no commission table reintroduced),
  source packaged 1.92 MB, `smartPosDispatch(us-central1)` **"Successful update operation"**,
  "Deploy complete!" (exit 0). The CRM wallet/gift-card/loyalty flows are now reachable in production.
- All prior remediation commits are in HEAD: `d2f1948` (P0-1/P0-2), `9536ddc` (wholesale + refund),
  `46b7773` (legal-hub races), `f6b345b` (authDomain migration).

### VERDICT: **APPROVED FOR PRODUCTION — financial integrity** (one gate un-executable here)

Every financial claim is now proven against **real Firestore**, the `sellerId` defect is fixed and
the cross-tenant hole closed, and the auth domain is live with valid SSL and a clean CSP. The
money paths move exactly once under concurrency.

**One gate cannot be executed from this environment and is NOT claimed as passed:** interactive
Google Sign-In completing on a **physical iPhone / Android / installed PWA**. It is verified at the
DNS, SSL, `authDomain`, CSP, and popup/redirect-logic level, but a real-device tap-through was not
performed (no hardware). This is the only item standing between "APPROVED — financial integrity"
and an unconditional "APPROVED FOR PRODUCTION," and it must be completed by a human on real devices
before public launch.

### Non-blocking technical debt (tracked separately, not launch blockers)

- **V2=10 / V3=4 residual** `onCall` money increments — `RESIDUAL_FINANCIAL_FINDINGS.md`; fix R1
  (`approveAndPayInvoice`) next.
- **`subscription-os.js:298/319`** — racy claim on AI-subscription activation (guarded by
  `aiPaymentRefs`, `onCall`, low concurrency); harden with Pattern C.
- **POS inventory idempotency** depends on the outer atomic claim (§1) — add an independent
  in-transaction guard as defense-in-depth in a future refactor.
- **Legal Hub L-1…L-6** (`LEGAL_HUB_V1_CERTIFICATION.md`) — content/operator + minor items; none
  financial.
- **P1-2 referral wallet credit** — no such code exists; if intended, implement (nothing to certify).
