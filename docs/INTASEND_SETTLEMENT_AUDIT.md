# IntaSend Settlement Architecture Review

**Platform:** SOKONI · **MoR:** Bravilex International Co. Ltd
**Date:** 2026-07-11 · **Method:** verified against the codebase (not assumptions)

> **Verification boundary.** This audit states what the **code** does (verifiable) separately from what the **IntaSend account** supports (NOT verifiable from code — requires the IntaSend dashboard / IntaSend support). Nothing about native split is assumed to be enabled.

---

## 1. Verified integration facts (from code)

- Account is **LIVE**: `sokoni-config.js` → `intasendKey: "ISPubKey_live_…"`, `intasendLive: true`. Secret `INTASEND_PRIVATE_KEY` in Secret Manager.
- IntaSend API endpoints actually called:
  | Endpoint | Purpose | Where |
  |----------|---------|-------|
  | `/api/v1/payment/mpesa-stk-push/` | STK push (collection) | index.js:4792, payment-adapters.js, +STK sites |
  | `.collection().charge()` / `.status()` (intasend-node SDK) | STK collection / query | wallet.js, payment-orchestrator.js |
  | `/api/v1/payment/collection/` , `/api/v1/payment/status/` | verify payment | index.js:2187, payment-adapters.js |
  | `https://payment.intasend.com/pay/checkout/?ref=` | hosted card checkout | payment-orchestrator.js:293 |
  | `/api/v1/send-money/mpesa/` , `/api/v1/payment/mpesa-b2c/initiate/` | B2C payout | payment-adapters.js:147, finos-utils.js:505, finos.js |
  | `/api/v1/payment/chargeback/` | refund | payment-adapters.js:165 |
  | `/api/v1/payment/split-collection/` | **split (added Phase 3, UNVERIFIED, disabled)** | payment-adapters.js:220 |
- **No IntaSend Wallets / sub-account / marketplace-split API is used** anywhere in production code. The only "wallet/split" references are (a) SOKONI's *internal* ledger wallet and (b) the Phase-3 split scaffold (disabled). → **Every IntaSend collection lands in the single main account; the integration is 100% collect-then-payout.**

---

## 2. Per-payment-type flow — who receives the gross

| Payment type | IntaSend mechanism (verified) | Gross received by | Split-capable today? |
|--------------|-------------------------------|-------------------|----------------------|
| **Checkout (hosted)** | `payment.intasend.com/pay/checkout` (card) | **SOKONI/Bravilex main IntaSend account** | ❌ collect-then-payout |
| **STK Push** | `mpesa-stk-push` / `.collection().charge()` | **Main account** | ❌ collect-then-payout |
| **Card** | hosted checkout URL | **Main account** | ❌ collect-then-payout |
| **Bank** | no IntaSend bank-collection endpoint in code (bank = manual / payout side only) | n/a (inbound not via IntaSend) | n/a |
| **Wallet (top-up)** | IntaSend STK → wallet float | **Main account** (float) | ❌ (internal ledger) |
| **Subscription** | IntaSend STK | **Main account** (platform revenue) | ❌ (platform-only, split N/A) |
| **SmartPOS** | terminal webhooks (`posTerminalEventWebhook`) / QR | terminal-dependent | ❌ |
| **QR** | `pos-qr` → M-Pesa | seller record (per Phase-1 audit) | ❌ |
| **Payment Links** | **not implemented** — no IntaSend payment-link API used (closest is the hosted checkout URL) | n/a | n/a |

> Note: the **Daraja STK** path (`darajaSTKPush`, index.js:2721) is **not IntaSend** — it pushes M-Pesa straight to the seller's own till (the P0 MoR gap from Phase 1). It is out of scope for IntaSend but remains the one path where the customer does *not* pay SOKONI first.

**Conclusion:** for every **IntaSend** path, the gross is collected into the single SOKONI/Bravilex main account first — already aligned with "customers always pay SOKONI." Distribution to sellers happens afterward via B2C payout (collect-then-payout).

---

## 3. Current payment flow diagram

```
Customer
  │  STK push / hosted card checkout (IntaSend)
  ▼
IntaSend main account  ── ALL gross collected here (SOKONI/Bravilex)
  │  webhook: intasendWebhook (HMAC-SHA256) / webhookPaymentCallback / fosSecureWebhook
  ▼
Settlement Engine (computeSettlement) → commission, seller net
  │  ledger: EXTERNAL_GATEWAY → PLATFORM_CLEARING → seller wallet
  ▼
Payout queue (payouts) → processPendingPayouts (30 min)
  │  IntaSend B2C: /send-money/mpesa/ or /mpesa-b2c/initiate/
  ▼
Seller M-Pesa   (WHT withheld at payout)
```
No native split anywhere — one collection account, then B2C disbursement.

---

## 4. Supported IntaSend capabilities — verified vs must-verify

| Capability | Status |
|------------|--------|
| M-Pesa STK collection | ✅ verified in use |
| Hosted card checkout | ✅ verified in use |
| M-Pesa B2C payout | ✅ verified in use |
| Chargeback/refund | ✅ verified in use |
| Webhook HMAC verification | ✅ verified (`verifyWebhookSignature`, SHA-256) |
| **Native split / Wallets (sub-accounts)** | ⚠️ **NOT used in code, and NOT verifiable from code.** Must confirm on the IntaSend dashboard whether **Wallets** is enabled for this account and whether split-collection is available on the live plan. |
| Payment Links API | ❌ not implemented |

**How to verify native split (do this before designing to it):**
1. IntaSend Dashboard → **Wallets** — is the feature present/enabled?
2. Confirm the exact split/wallet API (endpoint + payload) with IntaSend support for your account tier.
3. Confirm B2C/settlement limits and per-transaction fees for split vs B2C.

---

## 5. Recommended settlement architecture

The Phase-1→3 engine already implements **both** models behind a per-gateway config flag, so no architecture change is needed — only a decision driven by the dashboard verification:

- **If IntaSend Wallets/split IS available on the account:** enable it via `settlementSetProvider({ provider:'intasend', splitEnabled:true })` and wire `IntaSendAdapter.initiateSplitPayment` to the **real** Wallets/split endpoint (currently a scaffold using `/payment/split-collection/` — replace with the confirmed endpoint). The executor then routes platform share → Bravilex, seller net → seller wallet/account at collection time.
- **If it is NOT available:** keep `splitEnabled:false` (the default). The existing **collect-then-payout** engine (already live) continues to collect 100% to Bravilex and pay sellers their net. This fully satisfies the business objective without native split.

Either way the outcome is identical to the customer and to accounting: customer pays SOKONI, SOKONI computes commission, seller gets net, Bravilex keeps its share. Split only changes *when/how* the money divides, not *who* gets what.

---

## 6. Required account / dashboard configuration changes

**For collect-then-payout (current, no native split) — nothing required.** It works today.

**Only if enabling native split:**
- Enable **Wallets** on the IntaSend account; create a sub-wallet per seller (or per settlement) or use IntaSend's split-payment feature.
- Capture each seller's **registered payout destination** (M-Pesa number / wallet id) — the executor requires it (`sellerPayoutAccount`); without it, it auto-falls back.
- Confirm B2C/settlement limits, KYC on sub-wallets, and fee structure.
- Add/confirm the webhook secret for split/wallet settlement events.

---

## 7. Required webhook / payout changes

- **Collect-then-payout (current):** no change. Webhooks (`intasendWebhook`, `webhookPaymentCallback`, `fosSecureWebhook`) already HMAC-verified + idempotent (`financialProcessed` flag / `finosIdempotency`).
- **If native split:** add handling for IntaSend split/wallet settlement webhook events (per-destination confirmation), and reconcile the split ledger types (`split_seller_direct`, `split_commission_direct`). Payout queue is **bypassed** for split-settled orders (funds already distributed) — the executor records `settlementMethod:'split'` so `processPendingPayouts` must skip those (guard on `settlementMethod`).

---

## 8. Migration plan — zero duplicate-payout / mis-settlement risk

1. **Verify** IntaSend Wallets/split availability (dashboard + support). If unavailable → stop; collect-then-payout stays. No further action.
2. **Sandbox** the confirmed split endpoint; wire `initiateSplitPayment` to it; validate with `settlementValidatePath`.
3. **Shadow mode** (`settlement-routing.js`, mode `shadow`): compute split for a cohort against live traffic, **move no money**, compare to actual collect-then-payout. Prove parity.
4. **Canary**: `settlementSetProvider({intasend, splitEnabled:true})` + routing allowlist of 1–2 sellers at rollout 1%.
5. **Duplicate-payout guards (structural):**
   - The executor chooses **exactly one** method per settlement and records `settlementMethod` — split and payout are mutually exclusive.
   - `processPendingPayouts` must **skip** orders stamped `settlementMethod:'split'` (bypass guard) so a split-settled order is never also B2C-paid.
   - Idempotency keys (`finosIdempotency`) + deterministic settlement doc IDs prevent re-settlement on webhook replay.
   - Split-call failure **auto-falls back** to collect-then-payout and records that — never both.
6. **Reconcile**: split ledger nets to zero; no order has both a split record and a payout. Widen 1% → 10% → 50% → 100% only while reconciliation is clean.
7. **Rollback**: `settlementSetProvider({intasend, splitEnabled:false})` or global `killSwitch` → instant return to collect-then-payout. Append-only records; no deletion.

**No production routing is changed by this audit.** Split stays disabled until steps 1–5 pass.

Related: [[SETTLEMENT_SPLIT_PHASE3]] · [[SETTLEMENT_MIGRATION_PHASE2]] · [[ENTERPRISE_SETTLEMENT_ARCHITECTURE]]
