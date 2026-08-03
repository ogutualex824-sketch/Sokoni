# SOKONI eTIMS — KRA Third-Party Integrator Certification Readiness Report

**Status:** v0.2 (Phase 1–2 engineering progress) · **Date:** 2026-08-03 · **Owner:** Platform Engineering / Compliance

> ## Progress update (v0.2) — engineering-controlled blockers closing
> Overall readiness **~40% → ~60%**. Closed (no KRA spec needed):
> - **B3 divergent tax engines → CLOSED.** One canonical `etims-tax-engine.js`; seller + hub both delegate. Gate 22/22 incl. 5,544 equivalence cases.
> - **B4 hub queue no processor → CLOSED.** `hubProcessQueue` (backoff, max-retry→dead-letter, idempotent, metrics/alerts).
> - **B6 no immutable audit → CLOSED (engineering).** Tamper-evident hash-chained `etimsAuditLog`; seller + hub lifecycle wired; 6/6 tamper tests; rules append-only.
> - **B7 admin reads wrong collection → CLOSED.** KASS AI/admin now read canonical `etimsInvoices`.
> - **B5 zero tests/gates → SUBSTANTIALLY CLOSED.** `etims-release-gate.js` (tax 22 + audit 6 + idempotency 11 + live no-dup-invoice / audit-completeness). GREEN.
>
> Still engineering-controlled (in progress): B1 lifecycle-op *structures* (credit/debit/cancel/amend — Phase 2), secret-name fix (E6 provisioning is activation).
> Still BLOCKED on KRA (unchanged): **B2** real `cmcKey` auth, **A4** item code-list, **F2** live buyer-PIN, VAT-policy confirmation, sandbox certification. See §7.

**Assessment basis:** full evidence audit of `functions/etims.js`, `functions/hub-etims.js`, root `etims.js`, `functions/index.js`, `firestore.rules`, `firestore.indexes.json`, test scripts. Every claim below is code-cited in the audit log.

> **Governing rule:** extend, do not rebuild. SOKONI already has an eTIMS v1.0 (28 Cloud Functions). This program converges and hardens it toward certification — it does not replace it.

---

## 1. Overall readiness

| Dimension | Readiness | Note |
|---|---|---|
| Core invoicing engineering | ~70% | 28 CFs, auto-invoicing, atomic numbering, AES-256-GCM creds, idempotency guards all present |
| KRA protocol correctness | ~20% | Home-grown HMAC ≠ KRA OSCU `cmcKey`; endpoints/codes unverified against KRA spec |
| Invoice lifecycle completeness | ~25% | Credit/debit notes, cancellation, amendment ALL missing |
| Single source of truth | ~30% | THREE divergent tax engines + THREE data namespaces |
| Reliability | ~55% | Seller retry queue solid; **hub retry queue has no processor** |
| Security & audit | ~50% | Encryption + CF-only writes good; **no immutable audit log** |
| Automated tests | **0%** | Zero eTIMS tests, zero release gates |
| Documentation | ~15% | No architecture/API/DR/ops docs for eTIMS (this report is the first) |
| **OVERALL CERTIFICATION READINESS** | **~40%** | Strong foundation, hard blockers, one external dependency |

**Go/No-Go: 🔴 NO-GO for submission.** Eight hard blockers (§4) and one external dependency (§7) must close first.

---

## 2. What is genuinely present (do not rebuild)

- 28 exported CFs (15 seller in `etims.js`, 13 hub in `hub-etims.js`), all re-exported in `index.js` and deploy-wired.
- Event-driven auto-invoicing on `orders/{orderId}` completion, with seller/hub authority routing (mutually exclusive).
- Atomic, gap-free invoice numbering (`nextSeq` in a transaction).
- AES-256-GCM credential encryption (`iv:tag:ciphertext`), master key in Secret Manager, creds locked `read/write:false`.
- Idempotency guards on all four invoice creators (`idempotencyKey`).
- Seller-side exponential-backoff retry (`etimsQueue`, every 5 min) + daily reconciliation.
- Correct Firestore indexes for server collections; CF-only writes with owner/admin read rules.

## 3. Data & module reality

- **Three code paths, three namespaces:** server-seller (`etimsInvoices`…), server-hub (`hubInvoices`…), browser client (`etims_submissions`/`etims_config`). **Admin console + KASS AI read `etims_submissions`, which the deployed server CFs never write** → admin visibility is disconnected from server truth.
- **Missing collections:** `creditNotes`, `debitNotes`, `taxSettings`, `merchantTaxProfiles` (folded into `etimsProfiles`), `branchProfiles`, discrete `transmissionLogs`, `complianceAudit`.

---

## 4. Hard blockers (must close before submission)

| # | Blocker | Severity | Owner-fixable without KRA spec? |
|---|---|---|---|
| B1 | **No credit notes / debit notes / cancellation / amendment** (KRA-mandatory lifecycle) | CRITICAL | Structure: YES · Wire semantics: needs KRA spec |
| B2 | **Auth = home-grown HMAC**, not KRA OSCU `cmcKey` provisioning | CRITICAL | NO — needs KRA integrator spec + sandbox device init |
| B3 | **Three divergent VAT engines** (Cat A inclusive vs exclusive add-on vs Cat B) → different totals for the same sale | CRITICAL | YES — converge to one pure engine |
| B4 | **Hub retry queue (`hubInvoiceQueue`) has no processor** → failed hub invoices permanently stuck | HIGH | YES |
| B5 | **Zero automated tests / release gates** for a tax-critical subsystem | HIGH | YES |
| B6 | **No immutable/append-only audit log**; invoices mutated in place despite "immutable" claim | HIGH | YES |
| B7 | **Admin/AI read wrong collection** (`etims_submissions` vs `etimsInvoices`) | MEDIUM | YES |
| B8 | **Item classification hardcoded**; `selectCodeList` sync coded but never called; no SmartPOS/Wallet wiring | MEDIUM | Partly — code list needs KRA data |

## 5. Security findings

- ✅ Credentials AES-256-GCM in Secret Manager; CF-only writes; owner/admin reads.
- 🔴 **No immutable audit trail** — every transmission mutates the invoice doc in place; certification expects an append-only ledger.
- 🟠 **Secret-name mismatch:** code needs `ETIMS_MASTER_KEY` / `ETIMS_PLATFORM_PIN` / `ETIMS_PLATFORM_SECRET`; `setup-secrets.sh` provisions `ETIMS_CLIENT_ID`/`ETIMS_CLIENT_SECRET` (never referenced). The three required secrets are unset ("3 pending").
- 🟠 Platform device serial hardcoded placeholder `SOKONI-VSCU-001`.
- 🟠 No live buyer-PIN validation against KRA (only seller/hub PIN regex).

## 6. Performance / reliability

- Seller path: 20s socket timeout, backoff `[2,10,30,120,720]`m, MAX_RETRIES 5, 5-min drain, daily reconcile — adequate.
- Hub path: **no drain** (B4). Dead-letter is de-facto silent.
- No load/stress evidence; no performance budget defined for eTIMS.

## 7. External dependency (blocks true readiness — not solvable by engineering alone)

To make the KRA wire protocol correct and certifiable, SOKONI must obtain from KRA:
1. Official **eTIMS OSCU/VSCU Third-Party Integrator specification** (exact endpoints, request/response schemas, `cmcKey` device-init & signing flow, error codes).
2. **Sandbox credentials + test taxpayer PINs + a test device** for end-to-end certification runs.
3. The **item classification code list** (UNSPSC/KRA class codes) for `selectCodeList` sync.

Until these are in hand, engineering can make the **architecture** certification-ready (convergence, lifecycle ops structure, tax engine, tests, gates, audit log, docs) but **cannot verify protocol conformance**. The mission's "no mock production logic" rule forbids fabricating KRA's contract.

---

## 8. Phased remediation plan

**Phase 1 — Convergence & correctness (no KRA spec needed) — IN PROGRESS**
- P1.1 Canonical **Tax Engine** — one pure, tested module; delete the 3 duplicates (B3). ← starting now
- P1.2 **Hub queue processor** — add the missing `onSchedule` drain (B4).
- P1.3 **Immutable audit log** — append-only `etimsAuditLog` on every transmission/state change (B6).
- P1.4 **Admin/AI → server truth** — point reads at `etimsInvoices` (B7).
- P1.5 **Tests + release gates** — tax determinism, no-duplicate-invoice-id, audit completeness, queue integrity (B5).

**Phase 2 — Lifecycle & data model (structure now, KRA semantics on spec)**
- Credit/debit notes, cancellation, amendment CFs + collections (B1). `complianceAudit`, `transmissionLogs`, `branchProfiles`, `taxSettings`, `merchantTaxProfiles`.

**Phase 3 — KRA protocol conformance (BLOCKED on §7)**
- Replace HMAC with real `cmcKey` device init/signing (B2); verify endpoints/schemas; wire `selectCodeList` classification (B8); sandbox certification runs.

**Phase 4 — Documentation & certification package**
- Architecture / data-flow / sequence / DB / security / DR / BCP / ops / dev / admin / merchant guides + API reference; test & compliance evidence; risk register.

---

## 9. Risk register (top)

| ID | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R1 | KRA rejects home-grown auth at certification | High | Critical | Phase 3; obtain KRA spec before any prod submission |
| R2 | Divergent tax math emits wrong VAT to KRA | High | Critical | P1.1 canonical engine + determinism gate (this week) |
| R3 | Hub invoices silently stuck, unremitted tax | High | High | P1.2 queue processor |
| R4 | No audit trail → cannot prove compliance in an audit | Medium | High | P1.3 immutable log |
| R5 | Secrets unset/misnamed → platform invoicing fails closed | High | Medium | Fix `setup-secrets.sh` names; provision 3 secrets |
| R6 | Admin acts on stale/disconnected data | Medium | Medium | P1.4 |

---

## 10. Go/No-Go

**Current: NO-GO.** Re-evaluate after Phase 1 (target: convergence + tests + audit + hub-queue closed → ~60%) and again when the KRA integrator spec + sandbox access (§7) are obtained (unblocks Phase 3 → path to GO). This report is regenerated at each phase gate.
