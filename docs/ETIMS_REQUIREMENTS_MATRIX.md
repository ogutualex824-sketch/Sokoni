# SOKONI eTIMS — Requirements Traceability Matrix

**Status:** SCAFFOLD (v0.1) · **Date:** 2026-08-03

> ⚠️ **INTEGRITY NOTICE — READ FIRST.**
> This matrix was built **without** KRA's official eTIMS Third-Party Integrator specification,
> which is not in SOKONI's possession as of this date. **No normative "SHALL/MUST" clauses have
> been invented.** Every row is one of:
> - **CODE-EVIDENCED** — an obligation SOKONI's own code already targets (cited file:line). Factual.
> - **PUBLIC-DERIVED** — a widely-documented eTIMS/VSCU capability area, marked as derived.
> - **PENDING-SPEC** — the KRA normative reference is unknown and MUST be filled from the official
>   document before this row counts as a real requirement.
>
> The "KRA Normative Ref" column is intentionally empty (`— PENDING SPEC —`) until the official
> specification is obtained. Do **not** treat any row here as a confirmed KRA requirement.
> When the spec arrives, this scaffold is filled line-by-line and the readiness report regenerated.

Legend — SOKONI status: ✅ DONE · 🟡 PARTIAL · 🔴 MISSING · 🔒 NEEDS-KRA (certs/sandbox/activation).

---

## A. Invoice generation & numbering

| ID | Obligation area | Source | SOKONI status | Evidence | Needs KRA? |
|----|-----------------|--------|---------------|----------|-----------|
| A1 | Generate tax invoice on sale | CODE-EVIDENCED | ✅ DONE | `etims.js:generateForOrder`; auto-trigger `etims.js:755` | no |
| A2 | Atomic, gap-free invoice numbering | CODE-EVIDENCED | ✅ DONE | `etims.js` nextSeq (txn); `hub-etims.js` invoiceSeq | no |
| A3 | Idempotent / no duplicate invoices | CODE-EVIDENCED | ✅ DONE | `idempotencyKey` guards on all 4 creators | no |
| A4 | Item classification code per line | CODE-EVIDENCED | 🟡 PARTIAL | hardcoded default `57111500`; `selectCodeList` coded, never called | 🔒 needs KRA code list |
| A5 | KRA `cmcKey` device init & per-invoice signing | PUBLIC-DERIVED | 🔴 MISSING | current auth = home-grown HMAC (`etims.js:73`) | 🔒 needs spec + device init |

## B. Invoice lifecycle operations

| ID | Obligation area | Source | SOKONI status | Evidence | Needs KRA? |
|----|-----------------|--------|---------------|----------|-----------|
| B1 | Credit note | PUBLIC-DERIVED | 🔴 MISSING | no CF | field semantics PENDING-SPEC |
| B2 | Debit note | PUBLIC-DERIVED | 🔴 MISSING | no CF | field semantics PENDING-SPEC |
| B3 | Invoice cancellation | PUBLIC-DERIVED | 🔴 MISSING | payload has null `cnclDt` only | PENDING-SPEC |
| B4 | Invoice amendment | PUBLIC-DERIVED | 🔴 MISSING | `orgInvcNo:0` hardcoded | PENDING-SPEC |
| B5 | Reversal after KRA REVERSED | PUBLIC-DERIVED | 🔴 MISSING | — | PENDING-SPEC |

## C. Tax computation

| ID | Obligation area | Source | SOKONI status | Evidence | Needs KRA? |
|----|-----------------|--------|---------------|----------|-----------|
| C1 | Single deterministic VAT engine | CODE-EVIDENCED | ✅ DONE | `etims-tax-engine.js`; gate 22/22 (5,544 equivalence cases) | no |
| C2 | Standard / zero-rated / exempt categories | CODE-EVIDENCED | 🟡 PARTIAL | A/B/C implemented; D/E buckets reserved | rate/codes PENDING-SPEC |
| C3 | VAT-inclusive vs exclusive per flow | CODE-EVIDENCED | 🟡 PARTIAL | isolated engine config point | 🔒 policy PENDING-SPEC |
| C4 | Discounts, rounding rules | CODE-EVIDENCED | ✅ DONE | engine `computeLine`; round-half-up 2dp | rounding policy PENDING-SPEC |
| C5 | Returns / credit-note tax consistency | CODE-EVIDENCED | ✅ DONE | `computeCreditNote` (negation of sale) | no |

## D. Reliability & transmission

| ID | Obligation area | Source | SOKONI status | Evidence | Needs KRA? |
|----|-----------------|--------|---------------|----------|-----------|
| D1 | Offline queue for failed transmissions | CODE-EVIDENCED | ✅ DONE | seller `etimsQueue`; hub `hubInvoiceQueue` | no |
| D2 | Scheduled retry drain (both flows) | CODE-EVIDENCED | ✅ DONE | `etimsProcessQueue`; `hubProcessQueue` (new, B4) | no |
| D3 | Exponential backoff + max-retry | CODE-EVIDENCED | ✅ DONE | `[2,10,30,120,720]`m, max 5 | no |
| D4 | Dead-letter handling | CODE-EVIDENCED | ✅ DONE | seller `failed`; hub `dead_letter` + alert | no |
| D5 | Idempotent queue processing | CODE-EVIDENCED | ✅ DONE | transactional claim + accepted-guard | no |
| D6 | Daily reconciliation of stuck invoices | CODE-EVIDENCED | ✅ DONE | `etimsReconcileDaily` | no |

## E. Audit & security

| ID | Obligation area | Source | SOKONI status | Evidence | Needs KRA? |
|----|-----------------|--------|---------------|----------|-----------|
| E1 | Immutable, append-only audit trail | PUBLIC-DERIVED | 🔴 MISSING (Priority 2 in progress) | invoices mutated in place today | no |
| E2 | Encrypted credential storage | CODE-EVIDENCED | ✅ DONE | AES-256-GCM, Secret Manager master key | no |
| E3 | CF-only writes; owner/admin reads | CODE-EVIDENCED | ✅ DONE | `firestore.rules` eTIMS blocks | no |
| E4 | Role-based permissions / least privilege | CODE-EVIDENCED | ✅ DONE | AppCheck + auth + admin/hub-access guards | no |
| E5 | No secrets in client code | CODE-EVIDENCED | 🟡 PARTIAL | server ok; root client `etims.js` has none but is unwired legacy | no (remove legacy path) |
| E6 | Secrets provisioned (3 required) | CODE-EVIDENCED | 🔴 MISSING | names mismatch in `setup-secrets.sh`; unset | 🔒 activation |

## F. Buyer / taxpayer validation

| ID | Obligation area | Source | SOKONI status | Evidence | Needs KRA? |
|----|-----------------|--------|---------------|----------|-----------|
| F1 | Seller/hub PIN format validation | CODE-EVIDENCED | ✅ DONE | `KRA_PIN_RE` | no |
| F2 | Live buyer PIN validation vs KRA | PUBLIC-DERIVED | 🔴 MISSING | buyer PIN passed through only | 🔒 needs sandbox |
| F3 | Branch (`bhfId`) support | CODE-EVIDENCED | 🟡 PARTIAL | stored+sent; no multi-branch mgmt | no |

## G. Integration & data integrity

| ID | Obligation area | Source | SOKONI status | Evidence | Needs KRA? |
|----|-----------------|--------|---------------|----------|-----------|
| G1 | Auto-invoice on business events | CODE-EVIDENCED | ✅ DONE | order-completion triggers | no |
| G2 | Admin/AI/analytics read canonical data | CODE-EVIDENCED | 🔴 MISSING (Priority 3) | reads disconnected `etims_submissions` | no |
| G3 | SmartPOS / Wallet invoice wiring | CODE-EVIDENCED | 🔴 MISSING | no POS/wallet caller | no |

---

## Items that will remain blocked until KRA involvement (🔒)

These CANNOT be closed by engineering alone — they need KRA-issued certificates, sandbox credentials, activation, or certification review:

1. **A5 / E-auth** — real `cmcKey` device initialization + per-invoice signing (needs official spec + sandbox device init).
2. **A4** — item classification code list (needs KRA `selectCodeList` data in sandbox).
3. **F2** — live buyer-PIN validation (needs sandbox endpoint).
4. **B1–B5 field semantics** — credit/debit/cancel/amend/reversal *wire fields* (structure buildable now; exact KRA fields PENDING-SPEC).
5. **C2/C3/C4** — confirmation of VAT rate, category codes, inclusive/exclusive policy, and rounding rules against the spec.
6. **E6** — provisioning + activation of production secrets and a real device serial.
7. **End-to-end certification runs** against KRA sandbox.

Everything else in this matrix is engineering-controlled and is being driven to DONE in Phases 1–2 + the documentation package.

---

## How to complete this matrix

When the official KRA eTIMS Third-Party Integrator specification is obtained:
1. Extract every SHALL / MUST / SHALL NOT / REQUIRED clause and mandatory field, one row each, with its section number in **KRA Normative Ref**.
2. Re-map each to SOKONI (DONE / PARTIAL / MISSING) with code evidence.
3. Implement all non-sandbox-gated gaps; attach test evidence.
4. Regenerate `ETIMS_CERTIFICATION_READINESS.md` with the true percentage.

Until then, this scaffold is the honest maximum: a real view of SOKONI's implemented capabilities and the precisely-scoped set of items awaiting KRA.
