# Enterprise Settlement Architecture Report

**Platform:** SOKONI · **Merchant of Record:** Bravilex International Co. Ltd
**Date:** 2026-07-11 · **Status:** Foundation shipped; convergence phased (see §9)

> This report documents the canonical settlement model, a complete dependency map of every payment and payout flow discovered in a full repository audit, what was implemented in this change, and an honest verification + remediation plan. It deliberately does **not** claim that all live payment flows were rewritten in one pass — doing so on production money movement would be reckless. The safe, non-breaking foundation is live; the risky convergence is sequenced and flagged.

---

## 1. Official settlement account (canonical, secure)

| Field | Value |
|-------|-------|
| Account name | **Bravilex International Co. Ltd** (exact bank string — intentionally distinct from `CompanyIdentity.legalName` "… Co. Limited") |
| Account number | `••••0001` — stored **only** in Secret Manager (`SETTLEMENT_ACCOUNT_NUMBER`); never hardcoded, never client-side, never returned by a public API |
| Role | `PRIMARY_COLLECTION` — Merchant-of-Record inbound account |

**Module:** [`functions/settlement-account.js`](../functions/settlement-account.js) — the single source of truth.
- `getSettlementAccount()` → full number (backend payout/reconciliation only; caller must bind the secret + enforce admin).
- `getSettlementAccountMasked()` → `••••0001` for dashboards/records/logs.
- `assertConfigured()` → guards real transfers when the secret is missing.

Audit confirmed the number `0686420001` appears in **zero** source files (client or server) — it lives exclusively in Secret Manager.

---

## 2. Canonical settlement flow

```
Buyer
  │  pays via any gateway
  ▼
Payment Gateway  (IntaSend · M-Pesa Daraja · Card · Wallet · SmartPOS · QR · Bank)
  │
  ▼
[ Bravilex Collection Account 0686420001 ]  ← 100% of every payment lands here first (MoR)
  │  ledger: EXTERNAL_GATEWAY → PLATFORM_CLEARING
  ▼
Settlement Engine  (functions/settlement-engine.js → computeSettlement)
  ├─ platform commission        (finos-utils.calculateCommission)
  ├─ payment/gateway fee         (PLATFORM_EXPENSES ← EXTERNAL_GATEWAY)
  ├─ VAT on commission           (PLATFORM_REVENUE → PLATFORM_TAX)
  ├─ discounts / promos          (PLATFORM_PROMOS split)
  ├─ referral / affiliate        (surfaced)
  ├─ rider / delivery allocation (rider 88% of delivery fee)
  ├─ service-provider allocation (category commission)
  └─ ⇒ Net Payable (seller)
        │  ledger: PLATFORM_CLEARING → seller:{id}
        ▼
Wallet credit (escrow/hold per settlement rules) → Automatic payout
        │  WHT (5%) withheld at cash-out
        ▼
Seller / Merchant / Service Provider / Rider
```

**Engine:** [`functions/settlement-engine.js`](../functions/settlement-engine.js) — `computeSettlement(db, input)` returns the full breakdown + a **balanced** `ledgerPlan` (ΣDR = ΣCR, verified by `assertBalanced()`), stamped with the masked collection account. It **reuses** the existing `finos-utils` math verbatim, so adopting it changes **no** payout amount.

---

## 3. Dependency map — payment entry points (audit result)

36 payment/payout entry points across two unreconciled stacks. Full inventory:

### 3a. Payment initiation
| Function | File:line | Gateway | Idempotency | Fund destination |
|----------|-----------|---------|-------------|------------------|
| `createPayment` / `initiatePayment` | payment-orchestrator.js:141 / :215 | IntaSend STK, Card, Wallet | `sha256(uid\|orderId)` dedupe | IntaSend collection |
| `createPaymentSession` | payment-state-machine.js:193 | mpesa/card/wallet/cash/bank | deterministic `sessionId` hash | — (FSM) |
| `initiateSTKPush` | index.js:4745 | IntaSend | existing-checkout guard <10min | IntaSend collection |
| **`darajaSTKPush`** | **index.js:2721** | **Safaricom Daraja** | 3-min pending guard | ⚠ **seller's own Paybill/Till (bypasses Bravilex)** |
| `sendTestSTKPush` | index.js:3128 | Daraja | rate-limit | seller till |
| `fosInitiatePayment` | financial-os.js:69 | IntaSend adapter | `fosPaymentIdempotency` txn | IntaSend collection |
| `initiateWalletTopUp` | wallet.js:101 | IntaSend | api_ref marker | SOKONI wallet float |
| `topUpWallet` / `generatePOSPaymentQR` / `initiatePOSQRPayment` | pos-crm-pro.js:125 / pos-qr.js:87 / :231 | Wallet / QR | deterministic doc id | seller |
| `installmentRecordPayment` | installments.js:258 | external ref | per-installment guard | records external |

### 3b. Webhooks / callbacks (gateway → us)
| Endpoint | File:line | Gateway | Auth | Computes commission? |
|----------|-----------|---------|------|----------------------|
| `verifyIntasendPayment` | index.js:2106 | IntaSend | server re-query | No (escrow on order) |
| **`darajaSTKCallback`** | **index.js:2870** | Daraja | IP allowlist | ⚠ **No — 100% to seller till** |
| `intasendWebhook` | index.js:4835 | IntaSend | HMAC-SHA256 | Yes (finos-utils + 10% fallback) |
| `webhookPaymentCallback` | finos.js:1017 | IntaSend | HMAC-SHA256 | Yes (commission + VAT) |
| `fosSecureWebhook` | financial-os.js:207 | IntaSend adapter | HMAC via adapter | Yes |
| `webhookIntasend` / `webhookMpesa` | index.js:5488 / :5528 | IntaSend / Daraja | HMAC / IP allowlist | No (log only) |
| `webhookSmartpos` | index.js:5632 | SmartPOS | ⚠ **no signature** | No |
| `webhookStripe` | index.js:5580 | Stripe | disabled → 501 | — |
| `posTerminalEventWebhook` | pos-terminal-live.js:806 | Card terminals | per-vendor HMAC | No |

---

## 4. Dependency map — payout / settlement flows

| Path | File:line | Trigger | Moves real money? |
|------|-----------|---------|-------------------|
| **`processPendingPayouts`** | finos.js:405 | schedule every 30 min | ✅ **Yes — IntaSend M-Pesa B2C (the only live disbursement)** |
| `requestPayout` | finos.js:334 | onCall | queues `payouts` |
| `finosProcessSettlements` | finos-router.js:689 | schedule hourly | escrow → wallet credit |
| `fosAutoSettlement` | finos-automation.js:79 | schedule every 6 h | escrow → wallet credit |
| `finosReleaseEscrow` / `fosAdminSettleEscrow` | finos-router.js:425 / finos-admin.js:303 | onCall | escrow → wallet credit |
| `finosRequestBankPayout` | finos-router.js:852 | onCall | `pending_review` (manual) |
| `commission.js processSettlement` | commission.js:504 | onCall | wallet credit + `settlements/{orderId}` |
| `requestSellerPayout` / `adminProcessPayout` | wallet.js:397 / :514 | onCall | ⚠ bookkeeping only, no disbursement |
| `_svcSchedulePayout` → `payoutQueue` | wap.js:914 | workflow | ⚠ **no consumer (dead queue)** |
| `processSettlementQueue` | index.js:6313 | schedule hourly | ⚠ **stub / no-op** |

**Queues:** `payouts` (primary), `escrows` (settlement backlog), `payoutRequests`+`payoutVelocity` (legacy), `payoutQueue` (dead), `settlementQueue` (stub), `pendingRefunds`, `unmatchedPayments` (dead-letter), `etimsQueue`, `hubInvoiceQueue`, `sasosDunning` (retry).

---

## 5. Accounting flows (double-entry)

Three ledger systems exist; the Settlement Engine posts through the **balanced** primitives:

| System | Collection | Balance enforced | Use for |
|--------|-----------|------------------|---------|
| FinOS ledger | `ledger` | net-zero verified nightly (`reconcileLedger`, finos.js:839) | platform clearing/revenue/tax entries |
| POS seller GL | `posJournalEntries` | ✅ per-entry ΣDR=ΣCR (`pos-accounting.js:232`) | seller P&L / balance sheet |
| SASOS billing | `sasosBillingLedger` | event log | subscription audit |

**Account namespace** (`finos-utils.ACCOUNTS`): `PLATFORM_REVENUE`, `PLATFORM_CLEARING`, `PLATFORM_EXPENSES`, `PLATFORM_TAX`, `PLATFORM_PROMOS`, `PLATFORM_HOLDS`, `EXTERNAL_GATEWAY/MPESA/BANK`, `seller:{id}`, `rider:{id}`, `buyer:{id}`, `hub:{id}`, `advertiser:{id}`.

The engine's `ledgerPlan` uses exactly these, in 1-debit/1-credit pairs, so every posting is balanced and passes `reconcileLedger`. It also **activates two previously-dormant accounts**: `PLATFORM_EXPENSES` (gateway fee) and `PLATFORM_PROMOS` (platform-funded discounts).

**Invoice generators:** `etims.js` (KRA seller/platform), `hub-etims.js` (hub), `sasos-billing.js` (subscription). **Receipt generators:** `etims.buildReceiptHtml`, `hub-etims.buildHubInvoiceHtml`, POS. The engine routes documents through these — no new generators.

---

## 6. Audit trail

Every settlement result carries: `engineVersion`, `merchantOfRecord`, masked `collectionAccount`, `gross`, `commission{cents,rate}`, `gatewayFee`, `tax{vatCents,whtCents}`, `discount`, `delivery{riderNetCents,platformCents}`, `sellerNetCents`, `sellerAfterWhtCents`, `platformNetCents`, `netPayable`, and the full `ledgerPlan`. Ledger entries are immutable, idempotency-keyed (`finosIdempotency`, SHA-256), and never deleted — reversals post compensating entries (`reverseLedgerEntry`).

---

## 7. What was implemented in this change (non-breaking)

| Artifact | Purpose |
|----------|---------|
| `functions/settlement-account.js` | Canonical secure MoR account (Secret Manager) |
| Secret `SETTLEMENT_ACCOUNT_NUMBER` = `0686420001` | Account number, backend-only |
| `functions/settlement-engine.js` | `computeSettlement` canonical waterfall + balanced `ledgerPlan` + masked stamping; CFs `settlementGetContext`, `settlementPreview`, `settlementGetDashboard` (admin-gated) |
| `settlement-dashboard.html` | Premium admin dashboard: revenue, queues, MoR account (masked), live calculator |
| index.js registration | 3 new CFs wired |

All additive. No existing payment/payout function was modified, so **no live money behaviour changed**.

---

## 8. Verification results

| Check | Result |
|-------|--------|
| `node --check` all new/changed files | ✅ pass |
| Engine waterfall math (unit test, mocked db) | ✅ gross 100000 → commission 10000 (10%), VAT 1600, seller net 90000, WHT→85500, rider 17600, platform net 9400 |
| Ledger plan balances (ΣDR = ΣCR) | ✅ `assertBalanced` true (6 postings) |
| Faithful to existing `finos.js` math (no payout drift) | ✅ identical formulas via `finos-utils` |
| Account number in source (client or server) | ✅ **zero** hits — Secret Manager only |
| Account exposed to client / public API | ✅ never — masked (`••••0001`) everywhere client-facing |

**Not yet run (require a live/emulator financial environment and are unsafe to fake):** full integration, concurrency, webhook-replay, failure-recovery, and end-to-end reconciliation tests across the 6 stacks. These are scoped in §9 and must run against the Firestore emulator with seeded data before any convergence step ships.

---

## 9. Findings & phased convergence roadmap

The audit found the platform does **not** yet have one settlement authority — it has 6 parallel stacks, 4 wallet schemas, 3 commission formulas, 3 overlapping auto-settlement schedulers, and 3 fund-flow models. Converging them safely is a sequenced program:

**🔴 P0 — Merchant-of-Record violation.** `darajaSTKPush`/`darajaSTKCallback` (index.js:2721/2870) push customer money **directly into each seller's own Paybill/Till** — funds never reach Bravilex. This directly breaks the "100% to Bravilex first" rule. **Action:** route Daraja collections into the Bravilex short code (MoR), then settle via the engine. High-risk, live money — do behind a per-seller flag with reconciliation before cutover.

**🔴 P0 — Client-side hardcoded account.** Paybill **`522522`** is embedded in `legal-hub.html`, `provider.html`, `subscriptions.html`, `services.html`, `seller-revenue.html` (+ dummy `123456`). **Action:** remove these client literals; drive collection instructions from backend settlement config.

**🟠 P1 — Dedup the engines.** `finos.js` vs `finos-router.js` post near-identical entries; `fosAutoSettlement` (6h) and `finosProcessSettlements` (hourly) both release the same `escrows` from **different** rules docs (`finosConfig/settlementRules` vs `finosSettlementRules`). **Action:** one scheduled settlement pass, one rules doc, engine-driven.

**🟠 P1 — Kill dead/stub queues.** `payoutQueue` (no consumer) and `processSettlementQueue` (no-op stub) create the illusion of settlement. **Action:** feed them into `computeSettlement` + `processPendingPayouts`, or remove.

**🟡 P2 — Unify wallet schemas.** Four incompatible `wallets/{uid}` shapes (`availableBalance/withdrawableBalance` vs `availableCents/lifetimeCents` vs `balance/pendingPayout` vs escrow `netCents`) are a reconciliation hazard and the reason `commission.js processSettlement` can leave funds non-withdrawable. **Action:** migrate to one schema; add the missing **Auto-Withdraw** setting.

**🟡 P2 — Book the missing lines.** Gateway/processing fee (never computed — `PLATFORM_EXPENSES` dormant), WHT (computed, never deducted at settlement), promo funding split (validated, never posted — `PLATFORM_PROMOS` dormant), referral (platform-funded, invisible to ledger), affiliate (does not exist). The engine already **surfaces** all of these; wire real values from each caller and post the extra ledger lines.

Each phase ships behind a flag, with emulator integration + concurrency + webhook-replay tests green and `reconcileLedger` net-zero, before the next.

---

## 10. Security posture

- Account number: Secret Manager only; backend reads require the bound secret + admin; client/dashboard get masked `••••0001`.
- New CFs enforce `admin`/`superAdmin` + App Check; none returns the full number.
- No new deployment automation, cron, or CI was added for account handling.

Related: [[COMPANY_IDENTITY_DEPENDENCY_MAP]] · [[project_finos_v2]] · [[project_finos_automation]] · [[project_commerce_os_v1]]
