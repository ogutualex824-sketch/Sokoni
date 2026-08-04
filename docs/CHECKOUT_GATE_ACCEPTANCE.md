# Checkout Production Gate — Go/No-Go Acceptance Record

**Purpose:** the canonical baseline for the authoritative-checkout + payment path. Complete this the moment the production gate closes (one real end-to-end order). Every future release that touches checkout, delivery pricing, dispatch, settlement, or payments is measured against THIS record.

**Status:** ☐ NOT YET COMPLETED — fill in when the production reference transaction passes. RC is NOT exited; `v1.0.0` NOT tagged.

### Gate execution log
- **2026-08-04 — Step 1 DONE:** `darajaSTKPush` deployed to production (`us-central1`, Gen2 callable) from commit `fdb4a8f` — "Successful update operation". Authoritative delivery-pricing path now live; behaviourally inert until a merchant has a `deliveryConfig`. Exact Cloud Run revision not captured from this environment (gcloud unauthed) — **record it from the console** for the fast-rollback row. Rollback available now: tag `gate-authoritative-delivery` + revert `e02ac98` + redeploy.
- **Step 2 — PENDING:** apply Kass Shop `deliveryConfig` (needs the real seller UID).
- **Step 3 — PENDING (human-only):** one real order (M-Pesa PIN + rider accept/pickup/deliver) → verify the table below → sign.
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

## RC exit criteria (all must be true to lift the freeze)
☐ `darajaSTKPush` deployed · ☐ Kass Shop `deliveryConfig` applied · ☐ one complete live customer order · ☐ acceptance checklist fully passed (table above) · ☐ this record signed · ☐ Release Baseline established (below).

## Exception process (critical issue found during the live run)
1. **Record** the issue here (Lessons section). 2. **Decide: Go / Rollback / Fix & Restart RC.** 3. If a code change is required, **increment the RC** (RC1 → RC2). 4. **Re-run** the required validation (`qa-dispatch-settlement-e2e` + any harness for the touched area) and **repeat** this acceptance process. This preserves the signed-baseline integrity while allowing a response to real production findings.

## Verification method
- **Financial exactly-once** was proven pre-gate empirically (14/14, `qa-dispatch-settlement-e2e` against the real `settleOrder`). This record confirms the SAME properties hold on the live reference transaction, not just the emulator.
- **No-Go** if any row fails → follow the rollback procedure in `docs/PRODUCTION_CHECKOUT_VALIDATION.md §4b` (revision rebind / git-revert `e02ac98` / restore config), then re-run.

## Lessons / Regression Notes
_Capture anything observed during the live production run — this makes the record a living operational reference, not just an approval. Note it even if the gate passed._

- **Latency:** STK prompt arrival: `____` · webhook→paid: `____` · settle→wallet: `____`
- **Delivery timing:** dispatch→accept: `____` · pickup→complete: `____`
- **Payment timing / retries:** `____`
- **Operator observations:** `____`
- **UI friction (customer / rider / merchant):** `____`
- **Anything worth remembering for future releases:** `____`

## Release Baseline (record on Go — this is the certified lineage anchor)
On a signed **Go**, this becomes the platform **Release Baseline**. Capture:

| Baseline field | Value |
|---|---|
| Release Candidate version (SW `cacheVersion`) | `__________` |
| Production function revision(s) — `darajaSTKPush` (+ others changed) | `__________` |
| Service Worker version | `__________` |
| Acceptance date/time (UTC + EAT) | `__________` |
| Reference transaction (Order ID) | `__________` |
| Acceptance document version (this file's commit SHA) | `__________` |

**Change-record rule:** every future payment/checkout change MUST reference this baseline in its change record — creating a clear lineage from the certified release to each subsequent update — and MUST re-run `qa-dispatch-settlement-e2e` + re-verify the acceptance rows before deploy.

## Post-record
Then the roadmap proceeds — Merchant Growth (first-successful-sale as the primary activation milestone) → Multi-wallet → eTIMS (when the KRA spec lands).
