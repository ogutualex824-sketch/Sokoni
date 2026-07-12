# SOKONI v1.0.0 — Release Status (Recalculated from Evidence)

**Date:** 2026-07-12 · **HEAD:** `bc139c6` · **Project:** `sokoni-aeb26`

> Recalculated from **all** remaining evidence. The release was **not** auto-upgraded because one blocker closed.
> Withdrawn blockers are **removed**, not retained. No new blockers were invented. **Evidence overrides prior assumptions.**

---

# 🔴 VERDICT: **NO-GO**

**One Critical blocker remains: the money path has never been executed.**

Everything else is either PASS or a non-blocking gap. The Critical item is **not a known defect** — it is an **unverified critical path**, and for a platform whose core function is moving money, that distinction does not make it safe.

---

## ✅ PASS — verified by evidence

| Area | Status | Evidence |
|---|---|---|
| **Deployment Integrity** | ✅ **PASS** | Runtime-exported **1,410** == deployed **1,410** · orphans **0** · undeployed **0** · CI gate `deployment-integrity.js --ci` → **exit 0**. Canonical inventory = runtime enumeration; regex retired. |
| **Authentication** | ✅ **PASS** | Browser E2E against the live project: email/password (create → sign-in → delete), password reset, email verification, Google OAuth handoff, phone OTP reCAPTCHA. **Zero HTTP 403s.** App Check init precedes Auth; production attests via reCAPTCHA v3 with **no** debug token. |
| **Legal Compliance** | ✅ **PASS** | **29/29** integration tests. Universal `SokoniLegalGate` in every onboarding flow. Server-side enforcement (dark-launched per role). Immutable, append-only audit. Version-upgrade detection. |
| **Architecture invariants** | ✅ PASS | 0 duplicate exports · 0 dispatched-op double-exports · 13 domain dispatchers. |
| **Brand / CompanyIdentity** | ✅ PASS | Consistent across 865 files. |
| **Live health** | ✅ PASS | `/`, `pos.html`, `checkout.html`, `wallet.html` → **HTTP 200**. |

---

## 🔴 CRITICAL BLOCKER (1)

### CB-M1 — The money path has never been verified end-to-end

Two independent, evidenced facts compound into one Critical risk:

**1. No payment has ever been verified E2E.** No M-PESA / IntaSend transaction (STK push → callback → settlement → ledger) has been executed and confirmed against production or sandbox. For a marketplace, payments are the product.

**2. Live wallet/refund/payout handlers were renamed and deployed — and never exercised.**
Commit `8fe29e2` renamed dispatcher handler keys that serve **real money operations**, and both the functions and the clients are **live**:

| Renamed handler | Money operation | Caller |
|---|---|---|
| `posGetWalletBalance` | customer wallet balance | `pos-crm-pro.html` |
| `posGetWalletTransactions` | wallet history | `pos-crm-pro.html` |
| **`posRefundToWallet`** | **issues refunds** | `pos-crm-pro.html` |
| **`aosGetPendingPayouts`** | **seller payouts** | `sokoni-aos.js` |
| `aosResolveDispute` | dispute resolution | `sokoni-aos.js` |

Callers were exhaustively traced and functions + hosting were deployed together, so the change is *believed* correct — **but belief is not evidence.** A missed caller surfaces as a broken refund or payout, i.e. **real financial harm**, and **no device test has ever been run**.

**Severity rationale:** unverified + irreversible-consequence + money = **Critical**. This is not a new blocker; it has appeared in every prior report (H1/B2/B4). It is now weighted correctly rather than deferred.

#### Minimum actions to clear CB-M1
1. **Run the money-path smoke test** — `docs/SMOKE_TEST_DISPATCH_RENAMES.md`, Section A (A1–A4) on an authenticated device: wallet balance + transactions, a **KES 1** test refund, admin pending payouts, resolve a **test** dispute. *(~20 min. Rollback is a single `git revert 8fe29e2` + redeploy of 3 dispatchers.)*
2. **Execute one payment E2E** — IntaSend/M-PESA sandbox first, then one **small-value live** transaction: STK push → webhook → order state → commission/settlement → ledger entry → receipt.

**When both pass, no Critical blocker remains.**

---

## 🟠 HIGH (do not release to real money without these)

| ID | Blocker | Evidence |
|---|---|---|
| **H1** | **`firestore.rules` never security-reviewed.** Rules govern all client data access on a platform holding PII and payment records. No defect is known — the *review* has simply never happened. | Rules committed but unreviewed; no security review artifact exists. |
| **H2** | **Subscription write split-brain.** Reads/enforcement are unified via `subscription-core`, but **writes still diverge across 5 stores** (`subscriptions` is keyed two incompatible ways by sub-engine vs subscription-os). One account can hold conflicting subscription records → wrong tier/commission. | Audited; `getSubscriptionDivergence` diagnostic shipped. Write-unification is a flagged migration, **not run**. |

---

## 🟡 MEDIUM

| ID | Item | Evidence |
|---|---|---|
| M1 | **PWA** offline / install / background-sync unverified. | Never executed. |
| M2 | **Monitoring / alerting / backup-restore drill** not executed. | Never executed. |
| M3 | **Billing efficiency audit incomplete** — 286 schedulers, 153 Firestore triggers, 200 composite indexes never reviewed for duplication/polling waste. | Counts measured; review not performed. |

## 🟢 LOW

| ID | Item |
|---|---|
| L1 | **Accessibility audit** never run. *(Deliberately left unscored — not guessed.)* |

---

## 🟡 CAPACITY WATCH — not a blocker

**1,410 CF exports vs a 1,350 soft budget** (Cloud Run ceiling ~1,500; headroom ~90).
Classified as an **architectural warning**, not a deployment failure. Deployment safety is governed solely by `deployment-integrity.js`, which **passes**. Tracked in `docs/CAPACITY_WATCH.md`.

*(Note: the retired regex inventory read 1,264 and hid this. The same error that invented 147 phantom orphans was also concealing a real capacity signal.)*

---

## Withdrawn blockers (removed, not retained)

| Withdrawn | Why |
|---|---|
| ~~CB1 — "154 unmanaged Cloud Functions"~~ | **Retracted.** Measurement error: a static regex could not see dynamically-generated exports (147 phantom orphans). True delta was 7; Path A applied; **orphans now 0**. |
| ~~"147 orphaned Firestore triggers"~~ | **Never existed.** `algoliaSync_*`/`searchSync_*`/`ts_*` are and always were exported by source. |
| ~~C1 dirty tree · C2 provider onboarding · C3 404 dead-ends · C4 legal integration · P0 POS ReferenceError~~ | All **fixed, deployed, verified**. |
| ~~Cloud Run quota as a release blocker~~ | Downgraded to **Capacity Watch** per policy. |

---

## Scorecard

| Dimension | Score |
|---|---:|
| Deployment Integrity | **100** |
| Authentication | **95** |
| Legal Compliance | **95** |
| Scalability | **88** |
| Security | **82** *(rules unreviewed — H1)* |
| Performance | **80** |
| Reliability | **78** |
| Billing Efficiency | **65** *(M3 unaudited)* |
| **Payments** | **—** **UNVERIFIED** *(CB-M1 — not scored; scoring it would be fabrication)* |
| **Accessibility** | **—** **UNVERIFIED** *(L1 — not scored)* |
| **Overall Production Readiness** | **78** |

---

## Path to GO

1. **Clear CB-M1** → money-path smoke test **+** one payment E2E. *(~1–2 hours with a device.)*
2. **Clear H1** → security-review `firestore.rules` before taking real money.
3. Then: **GO**, with H2/M1–M3/L1 tracked as post-release work.

**Until CB-M1 is cleared, SOKONI v1.0.0 is NO-GO.** Everything else is ready.

Related: [[deployment-integrity-report]] · [[deployment-safety-checklist]] · [[CAPACITY_WATCH]] · [[SMOKE_TEST_DISPATCH_RENAMES]] · [[SUBSCRIPTION_CONSOLIDATION]] · [[LEGAL_ACCEPTANCE_FRAMEWORK]]
