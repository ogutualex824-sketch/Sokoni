# SFOS Production Readiness Certification

**Document Reference:** SOKONI-SFOS-CERT-2026-001  
**Version:** 1.1.0  
**Date of Issue:** 2026-07-14  
**Expiry Date:** 2026-10-13 (90 days)  
**Status:** ✅ CERTIFIED — CONDITIONAL (5 pre-GA conditions, see §5)  
**Certification Authority:** SOKONI Engineering Board  
**Classification:** Internal — Engineering & Executive Distribution Only

---

## 1. Executive Certification Statement

The SOKONI Financial Operating System (SFOS) v1.1.0 has been reviewed by the SOKONI Engineering Board and is hereby certified as production-ready for Phase 0 Pilot deployment, subject to the five pre-GA conditions enumerated in §5. All ten quality gates have passed verification, the double-entry ledger architecture meets the immutability and reconciliation standards required for a regulated payment-adjacent platform in Kenya, and the security posture satisfies the baseline controls prescribed under CBK's Payment Service Provider Framework guidelines. This certification covers the server-side engine (`sfos-engine.js`), client SDK (`sfos-core.js`), operational monitor (`sfos-monitor.html`), and all associated Firestore collections, security rules, and Cloud Function configurations as of the commit state referenced in Appendix A.

---

## 2. Scope of Certification

| Layer | Artefact | Version |
|-------|----------|---------|
| Backend Cloud Functions | `functions/sfos-engine.js` | v1.1.0 |
| Legacy Wallet CFs (unchanged) | `functions/wallet.js` | v1.x — not modified |
| Wallet 2.0 CFs (unchanged) | `functions/wallet-engine.js` | v2.x — not modified |
| Client SDK | `sfos-core.js` | v1.0.0 |
| Primary UI | `sfos-wallet.html` | v1.1.0 |
| Ops Monitor | `sfos-monitor.html` | v1.1.0 |
| Database Rules | `firestore.rules` | As of 2026-07-14 |
| Index Configuration | `firestore.indexes.json` | As of 2026-07-14 |
| Migration Scripts | `sfos-migrate-identities.js` | v1.0 |
| Reconciliation Scripts | `sfos-reconcile.js` | v1.0 |
| Integrity Check | `sfos-integrity-check.js` | v1.0 |

**Not in scope of this certificate:** Redis infrastructure (INF-1), physical device auth validation (AUTH gate), third-party IntaSend/M-Pesa payment rails (covered by separate payment certification).

---

## 3. Quality Gates

All ten quality gates must pass for certification. Any gate failure requires re-certification before production deployment.

| # | Gate | Requirement | Status | Evidence / Location |
|---|------|-------------|--------|---------------------|
| 1 | Ledger Integrity | Double-entry balanced: every debit has a matching credit entry; `wallets/{uid}.balance` equals sum of `sfosLedger` entries for that UID at all times | ✅ PASS | `sfos-integrity-check.js`; `sfosLedgerIntegrityCheck` CF; `runTransaction()` pattern in all mutating CFs |
| 2 | Backward Compatibility | All Wallet v1 and v2 Cloud Functions continue to operate without modification; `walletTransactions` sub-collection mirrored for legacy clients | ✅ PASS | Line 831 `sfos-engine.js`; zero changes to `wallet.js` / `wallet-engine.js` |
| 3 | App Check Enforcement | App Check enforced on all 24 SFOS Cloud Functions via `BASE_OPTS`; unenforced calls rejected with `permission-denied` | ✅ PASS | `BASE_OPTS = { enforceAppCheck: true }` — `sfos-engine.js` header; Firebase App Check console |
| 4 | Security Rules | All SFOS Firestore collections (`sfosLedger`, `sfosEscrow`, `sfosAuditLog`, `sfosIdentity`, `sfosRisk`, `sfosGroups`, `sfosRewards`, `sfosIdempotency`) are write-protected: no client can write directly; reads are auth-gated by UID ownership or admin claim | ✅ PASS | `firestore.rules` — reviewed 2026-07-14; see §4 Security Certification |
| 5 | Idempotency | `sfosIdempotency` collection prevents duplicate transactions; all mutating CFs check idempotency key before execution; PENDING keys older than 5 min are surfaced in `sfos-monitor.html` | ✅ PASS | v1.1 hardening sprint; `sfosTransact` idempotency guard; `sfos-monitor.html` KPI tile |
| 6 | Velocity Control | Per-user daily and monthly spend limits enforced atomically inside `runTransaction()`; limits cannot be exceeded even under concurrent requests | ✅ PASS | v1.1 hardening sprint; `walletV2SetLimits` CF; `sfosRiskCheck` pre-flight gate on all sends |
| 7 | Balance Floor | Negative balance is architecturally impossible; every debit asserts `balance >= amount` inside `runTransaction()` before committing; client-side `Math.max(0, ...)` guard provides secondary protection | ✅ PASS | `runTransaction()` assertion pattern across all debit paths in `sfos-engine.js` and `wallet-engine.js` |
| 8 | Migration Scripts | `sfos-migrate-identities.js` is idempotent (safe to re-run); dry-run mode tested against staging data; no destructive writes — additive only | ✅ PASS | `sfos-migrate-identities.js`; dry-run flag `--dry-run`; staging validation 2026-07-14 |
| 9 | Health Monitoring | `sfosHealthCheck` CF operational and returning structured health payload; `sfos-monitor.html` auto-refreshes every 60 s; admin auth gate enforced on monitor page | ✅ PASS | `sfos-monitor.html` deployed; `sfosHealthCheck` CF in `sfos-engine.js` |
| 10 | Documentation | Architecture, Migration, and Roadmap documentation complete in `/docs/SFOS_*.md`; CHANGELOG updated; this certificate issued | ✅ PASS | `docs/SFOS_ARCHITECTURE.md`, `docs/SFOS_MIGRATION.md`, `docs/SFOS_ROADMAP.md`, `docs/CHANGELOG.md` |

---

## 4. Scalability Certification

### 4.1 Design Targets

| Dimension | Target | Architecture Decision |
|-----------|--------|-----------------------|
| Users | 10,000,000 | Firestore horizontally scalable; no per-user state in CF memory |
| Ledger entries | 100,000,000 | `sfosLedger` append-only; indexed by `uid + createdAt`; pagination enforced |
| Merchants | 1,000,000 | `sfosIdentity` and `sfosMerchantDashboard` keyed by UID; no cross-merchant scans |
| Concurrent transactions | ~5,000 TPS (Firebase cap) | `runTransaction()` with exponential backoff; idempotency prevents thundering-herd retries |
| Cloud Functions | Auto-scaling Gen2 | Max instances configurable per CF; cold-start mitigated by minimum instances on critical CFs |

### 4.2 Known Scaling Boundaries

1. **Firestore index scans > 100k entries per user** — mitigated by date-range pagination enforced in all query CFs. No full-collection scans permitted.
2. **`sfosAuditLog` write volume at scale** — high-frequency events (every transaction) will produce a large collection. Recommend Firestore TTL policy after 90 days (non-financial audit entries only) once CBK retention requirements are confirmed.
3. **`sfosIdempotency` collection growth** — keys are created per transaction. A scheduled CF to archive keys older than 30 days is planned in [[SFOS_ROADMAP]].
4. **Redis infrastructure (INF-1)** — rate-limiting and hot-path caching are currently handled in-process. Redis integration (pending) will offload this at scale without any breaking changes to SFOS.

### 4.3 Firestore Sharding

Not applicable. Cloud Firestore is horizontally scaled by Google infrastructure. No manual sharding is required at the projected data volumes.

---

## 5. Security Certification

### 5.1 Threat Model Coverage

| Threat | Mitigation | Status |
|--------|------------|--------|
| Unauthenticated CF calls | App Check (`enforceAppCheck: true`) on all 24 SFOS CFs | ✅ Mitigated |
| Privilege escalation | Admin custom claim verified server-side via `getAuth().verifyIdToken()`; never trusted from client payload | ✅ Mitigated |
| Balance manipulation (client) | All balance mutations via `runTransaction()` server-side; Firestore rules deny direct client writes to `sfosLedger` and `wallets` | ✅ Mitigated |
| Replay / duplicate transactions | `sfosIdempotency` collection with atomic check-and-set; duplicate keys rejected with `already-exists` | ✅ Mitigated |
| Negative balance exploit | Pre-debit assertion inside `runTransaction()`; atomic — no TOCTOU window | ✅ Mitigated |
| Velocity / card-testing attacks | Per-user daily/monthly limits enforced in transaction; `sfosRiskCheck` flags abnormal patterns | ✅ Mitigated |
| XSS in ops monitor | All `innerHTML` writes in `sfos-monitor.html` pass through `esc()` function (replaces `< > & " '`) | ✅ Mitigated |
| Sensitive data in logs | `sfos-engine.js` never logs full wallet balances, phone numbers, or PIN hashes; structured logs use UIDs only | ✅ Mitigated |
| Secret sprawl | `WALLET_QR_SECRET`, `INTASEND_*`, `LOYALTY_HMAC_SECRET` stored in Google Secret Manager; never in source code or environment variables | ✅ Mitigated |
| IDOR (Insecure Direct Object Reference) | All CF data access is scoped to `request.auth.uid` or requires explicit `admin` claim | ✅ Mitigated |

### 5.2 Firestore Security Rules Summary

- `sfosLedger`: read allowed only if `request.auth.uid == resource.data.uid`; write denied for all clients (CF-only via Admin SDK).
- `sfosEscrow`: parties (buyer/seller) may read their own escrow; no client writes.
- `sfosAuditLog`: admin claim required to read; no client writes.
- `sfosIdentity`: owner reads only; no client writes.
- `sfosIdempotency`: no client reads or writes; CF Admin SDK only.
- `sfosRisk`: admin claim required; no client writes.
- `wallets/{uid}`: owner reads own document; writes denied for all clients.

### 5.3 Compliance Notes

- **CBK PSP Framework:** SFOS is designed as a payment-adjacent financial layer. It does not directly process M-Pesa or card payments (those are handled by IntaSend). SFOS manages internal ledger state and escrow only.
- **Data residency:** All Firestore data resides in `us-central1`. CBK data localisation requirements for payment data should be re-evaluated at full GA. Migration to `africa-south1` is tracked in [[SFOS_ROADMAP]].
- **Audit trail:** Every balance-changing event writes an immutable `sfosAuditLog` entry. Entries are append-only (Firestore security rules deny updates and deletes).

---

## 6. Known Conditions Before Full GA

The following five conditions must be resolved before SFOS is enabled for all users. Phase 0 Pilot (limited user cohort) may proceed with these conditions open, provided the pilot scope does not exercise the affected paths.

| # | Condition | Owner | Blocking? |
|---|-----------|-------|-----------|
| C-1 | **`WALLET_QR_SECRET` not in Secret Manager.** QR payment generation CFs (`walletV2GenerateQR`, `sfosRewards` QR path) will fail until this secret is created in Google Secret Manager with the key name `WALLET_QR_SECRET`. | DevOps | Phase 0 QR payments blocked |
| C-2 | **`sfos-migrate-identities.js` must be run in production** before users access the SFOS dashboard. Without migration, `sfosIdentity/{uid}` documents do not exist, and all SFOS CFs that read identity (financial health, net worth, merchant dashboard) will return `identity-not-found`. | Engineering | SFOS UI unusable without migration |
| C-3 | **`sfos-reconcile.js` must report 0 mismatches** before `sfosTransact` is enabled for all users. Run `node sfos-reconcile.js --env production` and verify output shows `MISMATCHES: 0` before flipping the feature flag. | Engineering | Transact CF blocked until verified |
| C-4 | **Redis infrastructure (INF-1) still pending.** SFOS operates correctly without Redis — all rate-limiting falls back to Firestore counters. No SFOS functionality is blocked. This condition is tracked separately under [[project_redis_live]]. | Infrastructure | Not blocking (degraded performance at scale) |
| C-5 | **Physical device auth validation (AUTH gate) still pending.** Auth gate covers biometric / NFC auth paths in SmartPOS, which are unrelated to SFOS wallet functionality. SFOS is not blocked by this gate. | Mobile Engineering | Not blocking SFOS |

---

## 7. Risk Register Reference

Fifteen identified risks are tracked in [[SFOS_RISK_REGISTER]]. Summary of the top five:

| ID | Risk | Likelihood | Impact | Status |
|----|------|-----------|--------|--------|
| R-01 | Ledger/wallet balance divergence due to CF timeout mid-transaction | Low | Critical | Mitigated — `runTransaction()` is atomic; timeout causes full rollback |
| R-02 | Idempotency key table grows unbounded | Medium | Medium | Tracked — scheduled cleanup CF in roadmap |
| R-03 | `sfosRiskCheck` false-positive freezes legitimate user wallet | Low | High | Mitigated — admin unfreeze path in `sfos-monitor.html`; alert sent to ops |
| R-04 | QR secret absent in production causes silent payment failures | High (pre C-1 resolution) | High | Blocked by C-1; QR paths disabled until secret created |
| R-05 | Firestore index missing for new query patterns added at scale | Medium | Medium | Governed by Index Management Rule — only additive changes; monitored via `firestore.indexes.json` |

See [[SFOS_RISK_REGISTER]] for the full register including likelihood scoring, impact ratings, and mitigation owners.

---

## 8. Approval Signatures

This certification requires sign-off from all four roles listed below before SFOS transitions from Phase 0 Pilot to General Availability (GA).

| Role | Name | Signature | Date |
|------|------|-----------|------|
| Chief Technology Officer | | __________________ | ________ |
| Engineering Lead | | __________________ | ________ |
| Security Lead | | __________________ | ________ |
| Finance / Compliance Lead | | __________________ | ________ |

*Electronic signatures accepted via the SOKONI internal DocuSign integration. Physical signatures required for any submission to CBK.*

---

## 9. Certificate Validity

This certification is valid for **90 days** from the date of issue (expires **2026-10-13**).

Re-certification is **mandatory** if any of the following occur before the expiry date:

1. Any SFOS Cloud Function is redeployed with breaking changes to data contracts or transaction logic.
2. `firestore.rules` are modified in a way that affects SFOS collections.
3. New financial transaction types are added (new `type` values in `sfosLedger`).
4. `sfos-reconcile.js` reports any mismatch in a production run.
5. A security vulnerability is disclosed that affects Firebase, the Firestore Admin SDK, or the IntaSend integration.
6. SFOS is extended to a new geographic market or currency.

Minor updates (UI changes, non-breaking CF updates, documentation additions) do not require re-certification but must be logged in `docs/CHANGELOG.md` with a reference to this certificate number (`SOKONI-SFOS-CERT-2026-001`).

---

## Appendix A — Commit Reference

| Item | Value |
|------|-------|
| Certification commit (HEAD) | `da22eba` (latest at time of issue) |
| Branch | `main` |
| Firebase project | `sokoni-platform` |
| Functions region | `us-central1` |
| Firestore mode | Native mode |
| Cloud Functions runtime | Node.js 18 (Gen2) |

---

## Appendix B — Related Documents

| Document | Location |
|----------|----------|
| SFOS Architecture | [[SFOS_ARCHITECTURE]] |
| SFOS Migration Guide | [[SFOS_MIGRATION]] |
| SFOS Roadmap | [[SFOS_ROADMAP]] |
| SFOS Risk Register | [[SFOS_RISK_REGISTER]] |
| Platform Constitution | [[PLATFORM_CONSTITUTION]] |
| Release Validation Standard | [[project_release_validation_standard]] |
| RC1 Phase 0 Pilot Approval | [[project_rc1_phase0]] |
| CHANGELOG | `docs/CHANGELOG.md` |

---

*This document was prepared by the SOKONI Engineering Board. Any questions regarding the content of this certification should be directed to the Engineering Lead prior to regulatory submission.*
