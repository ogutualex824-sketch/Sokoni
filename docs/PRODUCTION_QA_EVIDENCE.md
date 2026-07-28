# SOKONI — Delivery Pipeline: Operational Readiness Evidence

**Entity:** Bravilex International Co. Limited (Reg. CPR/2014/166272)
**Platform:** SOKONI (Firebase `sokoni-aeb26`, production `mysokoni.co.ke`)
**Scope:** Checkout → dispatch (both branches) → delivery → exactly-once seller settlement
**Status:** 2 of 3 evidence sources complete; production validation pending (business-owned)

> **Readiness model.** Operational readiness for this pipeline rests on **three complementary
> sources**. No single source is sufficient: static review proves design, emulator tests prove
> concurrency/idempotency logic, and production runs prove the live integrations (M-Pesa, real
> rider participation) that the emulator cannot exercise.

---

## Source 1 — Static implementation review ✅ COMPLETE

- **Right-to-erasure, consent records, data-rights intake, ODPC registration** remediated and
  re-verified — see [ODPC_COMPLIANCE_CERTIFICATION.md](ODPC_COMPLIANCE_CERTIFICATION.md) (Addendum A).
- **Settlement authority:** single canonical engine (`functions/order-settlement.js` →
  `settlement-engine.computeSettlement`), one withdrawable rail (`wallets/{uid}.balance`).
- **Dispatch authority:** first-claim-wins re-enters the one canonical assignment flow, not a
  second dispatch system (`sokoni-orders.js:447`, documented at the call site).

## Source 2 — Controlled engineering verification ✅ COMPLETE (14/14)

- **Harness:** `functions/qa-dispatch-settlement-e2e.js` (runner `scripts/qa/run-dispatch-e2e.sh`).
  Runs the REAL `settleOrder` + the exact `riderClaim` transaction against a live Firestore emulator.
- **Commit:** `c67f54d` · **Result:** 14/14 checks pass · **Re-run:** `bash scripts/qa/run-dispatch-e2e.sh`

| Scenario | Verified |
|---|---|
| Branch A — auto-assigned rider | order → completed → seller credited **once**; `settlementStatus=SETTLED` |
| Branch B — no rider → claim | 5 riders race → **exactly one wins**; losers cleanly rejected; credited **once** |
| Idempotency | 3 concurrent + 1 replay `settleOrder` → **single** wallet credit, no double-pay |

> Emulator scope boundary: does **not** exercise live M-Pesa settlement callbacks or real rider
> app participation. That is Source 3's job.

## Source 3 — Real production validation ⏳ PENDING (business-owned)

Two live runs on `mysokoni.co.ke` with real M-Pesa payment. Record evidence in the tables below.

### Branch A — auto-assigned rider (rider online in the buyer's zone)

| Field | Value |
|---|---|
| Date / operator | _(fill)_ |
| Order ID | _(fill)_ |
| Buyer / Seller UID | _(fill)_ |
| M-Pesa receipt no. | _(fill)_ |
| Rider auto-assigned (UID) | _(fill)_ |
| Reached `completed` | ☐ yes |
| `settlements/{orderId}` exists — **exactly one** | ☐ yes |
| `walletTransactions/{sellerUid}_{orderId}_ordersettle` — **exactly one** | ☐ yes |
| Seller `wallets/{uid}.balance` delta = net (total − delivery − commission) | _(amount)_ |
| Anomalies (`oversoldAlerts` / duplicate credit / none) | _(fill)_ |

### Branch B — no rider initially online → rider claims

| Field | Value |
|---|---|
| Date / operator | _(fill)_ |
| Order ID | _(fill)_ |
| Buyer / Seller UID | _(fill)_ |
| M-Pesa receipt no. | _(fill)_ |
| Order appeared in driver "Claimable Now" | ☐ yes |
| Claiming rider (UID) — **only one** got it | _(fill)_ |
| Reached `completed` | ☐ yes |
| `settlements/{orderId}` exists — **exactly one** | ☐ yes |
| `walletTransactions/{sellerUid}_{orderId}_ordersettle` — **exactly one** | ☐ yes |
| Seller `wallets/{uid}.balance` delta = net | _(amount)_ |
| Anomalies | _(fill)_ |

**Acceptance:** both runs reach `completed`, each with exactly one settlement doc and one wallet
transaction, and the seller balance delta equals the computed net. Any duplicate credit or a second
rider on one order is a **FAIL** — capture the order ID for tracing against the live functions.

---

## Compliance status (kept distinct — do not conflate)

- **ODPC registration:** Registered **Data Processor**, Reg. No. **630-8669-F056** (serial 24670),
  valid 28 Jul 2026 – 28 Jul 2028. External, authority-issued fact.
- **Platform technical-compliance assessment:** internal engineering self-assessment
  ([ODPC_COMPLIANCE_CERTIFICATION.md](ODPC_COMPLIANCE_CERTIFICATION.md)); all four must-fixes
  remediated. Registration does **not** by itself attest to ongoing technical compliance.

*Once Source 3 is complete, this document is the single archive tying all three sources together.*
