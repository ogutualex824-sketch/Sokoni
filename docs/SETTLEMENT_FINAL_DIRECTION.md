# Settlement — Final Direction (approved)

**Date:** 2026-07-11 · **Status:** Production default locked; split disabled pending IntaSend verification

## Verified production architecture (the supported path)

```
Customer → IntaSend → SOKONI / Bravilex Collection Account → Settlement Engine → Seller Payout
```

Collect-then-payout is the **production default** and uses the canonical stack: Settlement Engine (`computeSettlement`), canonical accounting + ledger (`finos-utils` ACCOUNTS, balanced), audit trail (settlement records + `settlementConfigAudit`), and payout engine (`finos.processPendingPayouts` → IntaSend B2C).

## Split settlement — remains DISABLED until verified

`splitEnabled = false` for every gateway (`settlementConfig/providers`). Split will be enabled **only** after all of:
1. IntaSend confirms the merchant account supports native marketplace split.
2. Exact API endpoint + account config verified.
3. Sandbox validation succeeds.
4. End-to-end reconciliation succeeds.

Enabling is a **config-only** action — `settlementSetProvider({provider:'intasend', splitEnabled:true})` — with **no code rewrite**. The engine then auto-selects: native split where available+enabled, collect-then-payout otherwise (`resolveSettlementMethod`).

## Duplicate-payout protection (mandatory — never remove)

- Settlement stamps **`settlementMethod`** (`split` | `collect_then_payout`) on every record.
- **`finos.processPendingPayouts` skips any payout with `settlementMethod==='split'`** (or `splitSettled===true`) → marks it `skipped_split`, never issuing B2C. *(finos.js — "MANDATORY duplicate-payout protection … DO NOT REMOVE".)*
- Split-settled orders are paid directly by the gateway and never create a payout doc; the skip guard is defense-in-depth.
- Idempotency keys (`finosIdempotency`) enforced; the executor selects **exactly one** settlement path per transaction and auto-falls-back (split failure → collect-then-payout, recorded).

## Admin dashboard indicators (admin-only)

`settlement-dashboard.html` → Recent Settlements now shows, per settlement: **Settlement Method** (Native Split / Collect→Payout badge), **Payment Provider**, **Settlement Status**, **Payout Status** (`direct` for split, `via_queue`/`completed` otherwise), **Settlement Reference**, **Provider Reference**. Served by `settlementGetDashboard`. Never exposed to customers.

## Customer experience — unchanged

SOKONI Checkout / Payment Confirmed / Subscription Active / Wallet / Order Confirmed. Customers never see the settlement method or account details (brand guard enforces; account masked `••••0001`, backend-only).

## Provider-agnostic

The Settlement Engine is the engine; **IntaSend is one implementation** behind the provider abstraction (`payment-adapters.js` capabilities + `settlement-providers.js` config). Future providers are added through the abstraction with **no business-logic change**.

Related: [[INTASEND_SETTLEMENT_AUDIT]] · [[SETTLEMENT_SPLIT_PHASE3]] · [[SETTLEMENT_MIGRATION_PHASE2]]
