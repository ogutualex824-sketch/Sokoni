# Architecture Activation Registry

**Purpose:** SOKONI is not missing major subsystems. It has major subsystems that are
**disconnected**. This registry classifies every one, so engineering effort goes to
*activation* rather than construction.

**Date:** 2026-07-19 · **Evidence:** VERIFIED (repository/deployment/operational) unless marked.

> **Documentation invariant.** Every architecture document in `docs/` must state its
> Implementation Status — **Live / Dormant / Partial / Unsafe / Retired** — and its
> production caller count. `docs/SETTLEMENT_FINAL_DIRECTION.md` currently describes
> `executeSettlement` as the canonical production stack while it has **zero callers**.
> Aspirational architecture must never be documented as deployed architecture.

---

## The four states

| State | Meaning | Action |
|---|---|---|
| **Live** | Correctly integrated and reachable | Keep |
| **Dormant** | Exists, deployed or deployable, **zero callers** | Promote |
| **Partial** | Works, but missing writers or readers | Complete |
| **Unsafe** | Reachable, but violates an authority boundary | Repair |

---

## Registry

| Subsystem | Exists | Integrated | Secure | State | Evidence | Action / Gate |
|---|---|---|---|---|---|---|
| **Commission engine** | Yes | Yes | Yes | **Live** | `commission-config.js:43-81`, single source + deploy-time drift guard | Keep. Do not touch |
| **Provider payouts** | Yes | Yes | Yes | **Live** | `provider-ops.js:138-149` — server-derived, deterministic id, idempotent | **Reference implementation.** Model Gate 5 on it |
| **intasendWebhook** | Yes | Yes | Yes | **Live** | HMAC + transactional claim + `commissionLedger/{apiRef}` | Keep. Not yet reachable — see Gate 9 |
| **Escrow** | Yes | Partial | Yes | **Partial** | `escrows` hardened to CF-only 2026-07-19 | Wire to order lifecycle — Gate 2/5 |
| **Settlement engine** | Yes | **No** | Unknown | **Dormant** | `executeSettlement` (`settlement-executor.js:140`) **0 callers**; `computeSettlement` preview-only | Promote — Gate 7, after Gate 6A |
| **Trust score** | Yes | Partial | Yes | **Partial** | `profile-engine.js:45-67` — **7 of 10 factors have no writer**, score capped ≈25/100 | **Writers before tiers** — Gate 6 |
| **Risk / fraud** | Yes | Partial | **No** | **UNSAFE** | `sasos-fraud.js:297-342` — any authed user raises **anyone's** `riskScore` by 20/call; no rate limit, no dedup, no self-bind | **Repair — Gate 1A.5.** Risk is an entitlement input; if forgeable, everything above it is manipulable |
| **Feature flags** | Partial | **No** | Yes | **Dormant** | Field pre-secured in `noSelfGrant()` 2026-07-19; no resolution engine | Activate — Gate 4 |
| **Device trust** | Yes | **No** | Unknown | **Dormant** | `device*` — **8 exported, 0 deployed** | Deploy or retire — Gate 1A.5 |
| **Beta / access** | Partial | **No** | Yes | **Dormant** | UI exists (4 files); **0 beta CFs deployed**; `betaStatus` absent from repo; field pre-secured | Complete — Beta programme |
| **Capability engine** | Yes | Partial | Yes | **Partial** | `sokoni-permissions.js:299 hasRole()` resolves `registeredAs`; guards `seller.html` | **Promote, don't rebuild** — Gate 4 |
| **Wallet v2** | Yes | **No** | Unknown | **Dormant** | `walletV2*` — **18 exported, 0 deployed**; `sokoni-wallet-v2.js` calls them | Deploy or retire |
| **SFOS** | Yes | **No** | Unknown | **Dormant** | `sfos*` — **24 exported, 0 deployed** | Deploy or retire |
| **Org / workforce / profile** | Yes | **No** | Unknown | **Dormant** | `org*` 32, `wf*` 18, `profile*` 10 — **all 0 deployed**; `profile.html` is live and calls them | Deploy or retire |
| **Order authority** | **No** | — | — | **Absent** | `checkout.html:2368` writes orders client-side; `rules:245` permits `status:'paid'`; `finos-router.js:113` accepts it as proof of payment | **Build — Gate 2. Highest severity open path** |
| **Distance authority** | **No** | — | — | **Absent** | No CF writes `distanceKm`; only producer is `delivery-hub.js:168-192` (client-side) | Build — Gate 3 |
| **Canonical Financial Event** | **No** | — | — | **Absent** | Four ledger collections exist, never cross-reconciled | **Promote `finos-utils.createLedgerEntry`. Never a fifth** — Gate 5 |
| **Reconciliation** | Yes | Yes | — | **UNSAFE** | `reconcileLedger` (`finos.js:859-890`) sums −x and +x per entry and asserts zero — **tautological, cannot fail** | Repair — Gate 7 |

---

## What this changes

**Dormant ≫ Absent.** Of the subsystems above, **7 are dormant** (exist, zero callers) and only
**4 are genuinely absent**. Activation is cheaper and lower-risk than construction — but a
dormant subsystem that is *deployed* is also attack surface, so "deploy or retire" is a real
decision, not a deferral.

**Two are UNSAFE and neither is gated behind a payment.** The risk engine is exploitable today.
`reconcileLedger` provides no evidence today. Both should precede Gate 2 work if capacity allows.

---

## Sequence

| Phase | Work |
|---|---|
| **1 — Authority** | Gate 2 (Order), 3 (Distance), 4 (Pricing) |
| **1.5 — Repair** | Risk engine (Gate 1A.5), `reconcileLedger`, device-trust deploy-or-retire |
| **2 — Activation** | Trust writers, feature-flag engine, Beta completion, capability promotion |
| **3 — Legal (Gate 6A)** | **Merchant-of-Record confirmation, ledger semantics, counsel sign-off.** External lead time — start now |
| **4 — Settlement** | Wire settlement engine, replay tests, shadow mode |
| **5 — Launch (Gate 9)** | Release checklist, then repoint the webhook |

---

## Ledger semantics — required before Gate 7

Every entry must state **what the balance represents**, not merely its amount:
customer payment received · platform revenue · **supplier payable** · settlement paid.

`project_settlement_engine.md` designates **Bravilex International Co. Limited (0686420001)
as canonical Merchant of Record**. That must be *enforced in the ledger*, not asserted in a
document — funds moving to Bravilex, then to the merchant as a supplier payment. A flow that
reads "customer pays → platform holds → merchant withdraws" resembles holding funds **on
behalf of** merchants, which is a different regulatory posture in Kenya (CBK payment-service /
e-money rules) than Merchant of Record.

**This cannot be corrected by migration once real transactions exist.** Gate 6A is therefore a
hard prerequisite for Gate 7, and it is not an engineering decision.

---

## Gate 9 release checklist

Production activation is a controlled release event, not a configuration change. The IntaSend
production webhook is the **launch key** — the single irreversible action in the programme.

- [ ] Gates 0, 1, 1A, 1A.5, 2, 3, 4, 5 complete
- [ ] Gate 6A legal sign-off (MoR + ledger semantics)
- [ ] All regression suites pass, each proven falsifiable
- [ ] Deployment verified · Runtime verified
- [ ] Rollback plan verified · Monitoring active · Alerting active · Backup verified
- [ ] Production webhook repoint explicitly approved

Until every box is ticked, `/webhookIntasend` stays as-is.

---

## Related

[[FINANCIAL_TRUST_ENGINE]] · [[PRODUCTION_READINESS]] · [[RIDER_EARNINGS_AUTHORITY]] · [[RECEIPT_ENGINE]]
