# Enterprise Settlement Migration — Phase 2

**Platform:** SOKONI · **MoR:** Bravilex International Co. Ltd
**Date:** 2026-07-11 · **Status:** Infrastructure shipped (inert by default); **no production routing switched**

> Phase 2 delivers the *machinery* for a staged migration — feature flags, centralized payment config, and a validation gate — plus the six required plans below. Everything ships **inert**: with no config changes, `resolveRoute()` returns `legacy` for every method, so live money movement is unchanged until an admin explicitly enables a path that has passed validation.

---

## Deliverable 1 — Payment flow inventory & classification

From the Phase-1 audit (`ENTERPRISE_SETTLEMENT_ARCHITECTURE.md`), every fund-collecting path classified by **where customer money lands first**:

| Payment method | Entry point | Lands first at | Class |
|----------------|-------------|----------------|-------|
| IntaSend STK (marketplace) | `initiateSTKPush`/`intasendWebhook` (index.js), `fosSecureWebhook` | **SOKONI/IntaSend collection** → split to wallets | ✅ Already MoR-aligned |
| IntaSend (order escrow) | `verifyIntasendPayment` (index.js:2106) | SOKONI collection, held in order escrow | ✅ MoR-aligned |
| **M-Pesa Daraja STK** | **`darajaSTKPush`/`darajaSTKCallback` (index.js:2721/2870)** | ⚠️ **Seller's own Paybill/Till** | 🔴 **Direct-to-seller (violates MoR)** |
| Card | IntaSend checkout URL / terminals | SOKONI collection | ✅ MoR-aligned |
| Wallet | `finos.recordPayment` / wallet top-up | SOKONI wallet float | ✅ MoR-aligned |
| SmartPOS | `webhookSmartpos`, `pos-qr`, terminals | Seller (POS) / SOKONI | 🟠 Mixed |
| QR | `pos-qr.js` | Seller | 🟠 Mixed |
| Subscriptions | `sasos-billing`, `finos.billingSubscriptions` | SOKONI collection | ✅ MoR-aligned |
| Bank transfer | manual / `finosRequestBankPayout` (outbound) | — | n/a (payout) |

**Verdict:** the marketplace/IntaSend/card/wallet/subscription paths already terminate at SOKONI first. The **Daraja direct-to-seller** path (and mixed SmartPOS/QR) are the true MoR gaps.

---

## Deliverable 2 — Migration sequence (lowest-risk first)

| Wave | Methods | Rationale | Gate |
|------|---------|-----------|------|
| **0 — Shadow** | intasend, card, wallet, subscription | Already MoR-aligned; run engine in `shadow` mode to prove parity against live traffic with zero money-movement change | `settlementValidatePath` green + shadow parity report |
| **1 — Activate aligned** | intasend, card, subscription | Flip `shadow → mor` at 1% → 10% → 50% → 100% per method | Reconciliation net-zero for the cohort |
| **2 — SmartPOS / QR** | smartpos, qr | Mixed today; standardize onto engine | Per-terminal validation |
| **3 — Daraja (highest risk)** | mpesa_daraja | Reroute collection from seller till → Bravilex short code; requires gateway + compliance work | Full validation + compliance sign-off + per-seller canary |

Each method advances independently; no wave starts before the prior method's cohort reconciles clean.

---

## Deliverable 3 — Feature-flag plan

**Module:** `functions/settlement-routing.js` · **Config doc:** `settlementConfig/routing` · **Admin CFs:** `settlementGetRoutingConfig`, `settlementSetRoutingConfig`.

Per method: `mode ∈ {legacy, shadow, mor}`, `rolloutPct 0–100` (deterministic per-seller bucket via SHA-256 — stable, no flapping), `allowlist[]` (canary sellers). Plus a **global `killSwitch`**.

```
resolveRoute(db, method, {sellerId}) → { mode, useMoR, shadow, reason, version }
```
- Defaults (no doc): every method `legacy`, 0%, empty → **no behaviour change**.
- `shadow`: compute via canonical engine for the cohort, **do not** move money (parity testing on live traffic).
- `mor`: route through Bravilex collection for allowlisted sellers or the rollout %.
- Fail-safe: any error → `legacy`. Never throws (never blocks a payment).

Entry points adopt it as: `const route = await resolveRoute(db, 'intasend', {sellerId}); if (route.useMoR) {…engine…} else {…existing…}`.

---

## Deliverable 4 — Rollback plan

1. **Instant global rollback:** `settlementSetRoutingConfig({ killSwitch: true })` → every method resolves `legacy` on the next payment. No deploy needed.
2. **Per-method rollback:** set that method's `mode: 'legacy'` (or `rolloutPct: 0`).
3. **Canary rollback:** remove sellers from `allowlist`.
4. **Data safety:** settlement records, ledger entries, and config changes are append-only (idempotency-keyed, `settlementConfigAudit` log) — rollback never deletes; reversals post compensating entries (`reverseLedgerEntry`).
5. **Validation of rollback itself:** the harness's `rollback` check asserts `killSwitch` forces `mor → legacy` (currently **PASS**).

---

## Deliverable 5 — Risk assessment

| Risk | Severity | Mitigation |
|------|----------|------------|
| Double-payout during cutover | 🔴 High | Idempotency keys (`finosIdempotency`), per-order settlement docs, shadow parity before activation |
| Daraja reroute changes who holds funds (compliance/CBK) | 🔴 High | Wave 3 last; per-seller canary; compliance sign-off gate |
| Ledger imbalance from single-sided writers | 🟠 Med | Engine posts only balanced pairs; nightly `reconcileLedger`; harness reconciliation check |
| Wallet-schema divergence (4 shapes) | 🟠 Med | Wave 0 shadow surfaces mismatches before money moves |
| Gateway fee / WHT not yet booked | 🟡 Low | Engine surfaces them; book during Wave 1 with ledger lines |
| Client shows stale/dummy Paybill | 🟡 Low | **Fixed** — centralized + dummy `123456`/fake bank removed (Priority 2) |
| Config fat-finger | 🟡 Low | Validation on set (mode/pct/shortcode), audit log, killSwitch |

---

## Deliverable 6 — Readiness report

**Priority 2 (centralize payment config) — DONE:**
- `functions/payment-config.js` — canonical backend source; `getCheckoutPaymentConfig` (checkout-only fields), `adminGet/SetPaymentConfig`. Settlement account number stays Secret-Manager-only.
- Client: 8 hardcoded literals across `legal-hub`, `services`, `subscriptions`, `provider`, `seller-revenue` now reference the config (`data-sk-pay` / `window.SOKONI_PAY`) with the literal only as fallback. **Dummy `123456` Paybill and fabricated Equity Bank account removed** (bug fix). Loader: `sokoni-pay-config.js` (fallback-safe; activates on SDK-enabled surfaces).

**Validation harness — `functions/settlement-validation.js` / `settlementValidatePath`:**

| Check | Status (today, synthetic) |
|-------|---------------------------|
| Accounting balance (ΣDR=ΣCR) | ✅ PASS |
| Payout calculation (net, WHT, rider) | ✅ PASS |
| Idempotency (deterministic keys) | ✅ PASS |
| Rollback (killSwitch → legacy) | ✅ PASS |
| Reconciliation (ledger net-zero) | ⏳ MANUAL — run on seeded emulator |
| Retry behaviour | ⏳ MANUAL — emulator: `processPendingPayouts` under seeded retries |
| Webhook replay | ⏳ MANUAL — emulator: double-POST signed body, assert no-op |

**Verdict per method:** `ready_pending_manual` — all *automatable* checks pass; the three emulator checks must be run and acknowledged before any method flips to `mor`.

**Gate rule:** no method advances to `mor` in production until `settlementValidatePath({method})` returns no `fail` AND the manual emulator checks are green for that method.

---

## Priority 3 — Unified engine adoption (ongoing)

`computeSettlement` (settlement-engine.js) is the single place commissions/fees/taxes/referrals/delivery/net are computed. Adoption order follows the migration waves; each entry point wraps its existing logic behind `resolveRoute`, computing via the engine in `shadow`/`mor`. Targets: marketplace, services, bookings, SmartPOS, wallet, subscriptions, future providers.

## Priority 4 — Customer experience
Unchanged & compliant: all confirmations remain "SOKONI Payment Confirmed / SOKONI Wallet / SOKONI Checkout / SOKONI Subscription Active"; customers never see settlement account details (masked `••••0001`, backend-only). Enforced by the brand guard (`BRAND_FORBIDDEN`).

---

## What is intentionally NOT done
Production routing is **not** switched. No live payment path was changed. Daraja reroute (Wave 3) is planned, not executed. Manual emulator validations are pending. This is by design — per the staged-migration mandate.

Related: [[ENTERPRISE_SETTLEMENT_ARCHITECTURE]] · [[project_settlement_engine]] · [[BRAND_POLICY]]
