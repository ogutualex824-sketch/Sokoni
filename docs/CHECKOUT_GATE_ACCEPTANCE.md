# Checkout Production Gate — Go/No-Go Acceptance Record

**Purpose:** the canonical baseline for the authoritative-checkout + payment path. Complete this the moment the production gate closes (one real end-to-end order). Every future release that touches checkout, delivery pricing, dispatch, settlement, or payments is measured against THIS record.

**Status:** ☐ NOT YET COMPLETED — fill in when the production reference transaction passes.
**Related:** `docs/PRODUCTION_CHECKOUT_VALIDATION.md` (evidence + §5 human checklist), [[project_delivery_pricing_authority]], [[project_release_validation_standard]].

---

## Acceptance table

| Item | Evidence | Result |
|---|---|---|
| **darajaSTKPush revision** | Cloud Functions/Run revision ID: `__________` | ☐ |
| **Delivery config version** | Merchant UID: `__________` · config hash/values: `__________` | ☐ |
| **Reference transaction** | Order ID: `__________` | ☐ |
| **Payment (charged once)** | M-Pesa receipt: `__________` · gateway ref (IntaSend/Daraja): `__________` | ☐ |
| **Order created once** | single `orders/{orderId}` (no duplicate) | ☐ |
| **Delivery fee authoritative** | server-computed; `pricingSource=server_recomputed`; no `delivery_fee_unverified` for this merchant | ☐ |
| **Dispatch** | assigned rider UID: `__________` → accept → pickup → complete | ☐ |
| **Settlement (once)** | Settlement ID `settlements/{orderId}`: `__________` | ☐ |
| **Merchant net** | credited exactly the net (KES): `__________` | ☐ |
| **Commission (once)** | recorded once (KES/cents): `__________` | ☐ |
| **Wallet reconciliation** | seller `wallets/{uid}.balance` Δ == net; balanced `ledger/{orderId}_*` | ☐ Pass |
| **Reports** | Admin OS → Payments/Reports/Bookings reflect the txn | ☐ Pass |
| **Rollback tag** | `gate-authoritative-delivery` → `cb802d5` (revert commit `e02ac98`) | ☐ |
| **Date/time** | UTC: `__________` · EAT: `__________` | ☐ |
| **Approved by** | Owner: `__________` (signature/initials) | ☐ Go / ☐ No-Go |

---

## Verification method
- **Financial exactly-once** was proven pre-gate empirically (14/14, `qa-dispatch-settlement-e2e` against the real `settleOrder`). This record confirms the SAME properties hold on the live reference transaction, not just the emulator.
- **No-Go** if any row fails → follow the rollback procedure in `docs/PRODUCTION_CHECKOUT_VALIDATION.md §4b` (revision rebind / git-revert `e02ac98` / restore config), then re-run.

## Post-record
On **Go**, this file is the payment-path baseline: any later checkout/payment change re-runs the `qa-dispatch-settlement-e2e` harness AND re-verifies these rows before deploy. Then the roadmap proceeds — Merchant Growth (first-successful-sale as the primary activation milestone) → Multi-wallet → eTIMS (when the KRA spec lands).
