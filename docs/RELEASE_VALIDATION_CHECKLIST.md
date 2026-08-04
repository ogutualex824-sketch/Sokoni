# SOKONI Release Validation Checklist — Commerce Critical Path

**Purpose:** a permanent, reusable regression baseline. Run this before every release that touches checkout, payment, dispatch, or settlement. One completed pass = production evidence that the core commerce path works end-to-end. It converts the v1.0.0 acceptance order into a repeatable process, not a one-off.

**Rule:** stop on the FIRST failing stage. Do not investigate downstream or unrelated areas — the first observable failure names the subsystem to fix (see triage map). Re-run from the top after the fix.

**Evidence discipline** ([[project_release_validation_standard]]): no row is "Pass" without a concrete artifact (document ID, reference, timestamp, or delta). "It looked fine" is not evidence.

---

## Validation table (fill per release)

| # | Step | Pass/Fail | Evidence (doc ID / ref / value) |
|---|------|-----------|--------------------------------|
| 1 | Product searchable / discoverable | ☐ | `products` query returns it; `searchableTerms` present |
| 2 | Cart | ☐ | correct item, qty, unit price; single seller |
| 3 | Checkout — server delivery pricing | ☐ | `pricingSource: server_recomputed`; no `delivery_fee_unverified` |
| 4 | STK Push sent | ☐ | STK request accepted; invoice/checkout ref |
| 5 | Payment confirmed | ☐ | M-Pesa receipt + gateway ref; webhook processed once |
| 6 | Order created (once) | ☐ | single `orders/{id}`; correct buyer UID + `sellerUid`; product snapshot |
| 7 | Seller accepted | ☐ | `status: confirmed`; acceptance timestamp |
| 8 | Rider accepted / assigned | ☐ | `assignedDriverUid`; assignment written exactly once |
| 9 | Delivered | ☐ | pickup → in_transit → delivered → complete (timestamps) |
| 10 | Settlement (once) | ☐ | single `settlements/{orderId}` (deterministic ID) |
| 11 | Commission (once) | ☐ | single `commissionLedger` entry |
| 12 | Wallet | ☐ | `wallets/{sellerId}.balance` Δ == net; balanced `ledger/{orderId}_*` |
| 13 | Reconciliation | ☐ | one payment / one order / one settlement / one commission; no duplicates, no orphans |
| 14 | Notifications (where expected) | ☐ | status-change notifications sent |

**Reference transaction:** Order ID `______` · Payment ref `______` · Date/time (UTC+EAT) `______`

---

## Stop-on-first-failure triage map

| First observable failure | Subsystem to investigate (only this) |
|---|---|
| Checkout can't place the order | checkout / cart validation (`darajaSTKPush` input guards) |
| STK never arrives | payment initiation (IntaSend/Daraja STK; `method:'M-PESA'`) |
| Payment succeeds but no order appears | payment confirmation / order creation (webhook → `orders`) |
| Seller never receives it | seller fulfilment pipeline (`orderAdvance` / `seller-fulfilment`) |
| Rider never gets dispatch | dispatch (`_autoAssignRider` on paid→confirmed; `rideDrivers.isOnline`) |
| Delivered but wallet/commission wrong | settlement pipeline (`order-settlement.js`; exactly-once IDs) |

---

## How to run
1. Buyer (a **non-seller** account) completes steps 1–5 on production.
2. Seller accepts (step 7); rider accepts/delivers (8–9).
3. Verifier pulls steps 6, 8, 10–13 **read-only** from Firestore and fills Evidence.
4. All Pass → sign `docs/CHECKOUT_GATE_ACCEPTANCE.md`, record the Release Baseline, tag the release.
5. Any Fail → fix only that subsystem, re-run from step 1.

Related: `docs/CHECKOUT_GATE_ACCEPTANCE.md` (the signed acceptance record) · `docs/PRODUCTION_CHECKOUT_VALIDATION.md` · [[project_release_validation_standard]] · [[project_rc1_harness]].
