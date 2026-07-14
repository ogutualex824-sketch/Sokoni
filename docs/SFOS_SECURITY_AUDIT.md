# SFOS Security Audit Report

**System:** SOKONI Financial Operating System (SFOS)
**Engine Version:** 1.0.0 (`sfos-engine.js`)
**Audit Date:** 2026-07-14
**Prepared by:** SOKONI Engineering — Security Review Gate
**Classification:** CONFIDENTIAL — For Internal Use and Regulatory Disclosure Only
**Reference Framework:** OWASP Top 10 2021, PCI-DSS v4.0, CBK Kenya Payment System Regulations

---

## 1. Executive Summary

SFOS is the canonical financial backbone of the SOKONI platform. It owns 13 Firestore collections, is deployed as Firebase Gen2 Cloud Functions on Node.js 22, and processes all money movements: wallet transfers, escrow, merchant settlement, rewards, and group wallets. The system is backed by Firebase Authentication with custom claims, Firebase App Check (ReCaptchaV3), a SHA-256 PIN-hash model, and HMAC-SHA256 QR payment signing.

### Security Posture — Domain Grades

| Domain | Grade | Notes |
|---|---|---|
| Authentication & Authorization | A- | Strong custom-claims model; MFA not yet enforced for high-value transactions |
| Firestore Security Rules | A | All 13 SFOS collections locked; lateral read vectors closed as of 2026-07-14 |
| Cloud Functions Security | B+ | Input sanitisation present; velocity counter has non-atomic gap (v1.1 fix) |
| Payment Security | B | Balance floor + freeze enforced; idempotency not yet persisted (v1.1 fix) |
| QR Payment Security | A- | HMAC-SHA256 + 15-min expiry; replay window is calendar-based not token-based |
| API Security | B | App Check enforced; no per-user CF rate limit beyond velocity counters |
| Cryptography | A | SHA-256 PIN hash; HMAC for QR; `crypto.randomBytes` for all IDs; no plaintext secrets |
| Data Protection | B+ | PII stored in `sfosIdentity`; no client-side exposure of raw PII in function responses |
| Audit & Logging | A- | `sfosAuditLog` immutable, admin-only; structured JSON logs; no secrets in log lines |
| Regulatory Readiness | B | CBK-compliant settlement flow; PCI-DSS readiness partially met; no SAQ yet |

**Overall Grade: B+** — The system is production-ready for Phase 0 Pilot with the known gaps documented in Section 12 tracked and assigned.

---

## 2. Authentication & Authorization

### 2.1 Firebase Authentication

All SFOS Cloud Functions require a signed Firebase ID token. The `_requireAuth(request)` helper throws `unauthenticated` (HTTP 401 equivalent) if `request.auth?.uid` is absent. There is no path through any SFOS handler that executes financial logic without a validated UID.

### 2.2 Custom Claims

The admin boundary is enforced through two custom claims:
- `admin: true` — grants admin-read across all SFOS collections and access to admin-only Cloud Functions.
- `superAdmin: true` — used by the platform constitution's `isSuperAdmin()` helper; treated identically to `admin` within SFOS.

The `_requireAdmin(request)` helper in `sfos-engine.js` checks both:
```javascript
if (!t?.admin && !t?.superAdmin) throw new HttpsError('permission-denied', ...)
```
Custom claims are set server-side only (via Admin SDK) and cannot be self-elevated by any client.

### 2.3 Firebase App Check

All Cloud Function exports use `enforceAppCheck: true` (via `BASE_OPTS`). This prevents unauthenticated API probing and bot-driven automated calls. ReCaptchaV3 is the attestation provider. App Check tokens are short-lived (1 hour) and are not sufficient alone to authorise financial operations — a valid Firebase Auth token is still required.

### 2.4 Known Gap — No MFA for High-Value Transactions

**Finding (P1):** SFOS does not currently require TOTP or a second factor for transactions above a threshold. The `_velocityCheck` function enforces daily/monthly KES limits but there is no step-up authentication prompt for transactions above, for example, KES 10,000 in a single operation.

**Recommended Control:** Add a `requiresMfa` field to `sfosIdentity` and check it in `sfosTransfer` / `sfosEscrowLock` before executing. The Security 6.0 sprint (TOTP/Passkeys) should wire into SFOS before GA.

---

## 3. Firestore Security Rules

### 3.1 Scope

The SFOS Firestore security rules govern 13 collections. All write paths are `allow write: if false` — the Admin SDK used by Cloud Functions bypasses client-facing rules entirely. This is the correct pattern: it prevents any client from writing financial state directly.

### 3.2 Collections and Their Read Controls

| Collection | Read Access | Write |
|---|---|---|
| `sfosIdentity/{uid}` | Owner or admin | CF only |
| `sfosLedger/{entryId}` | Owner (`accountId == uid`) or admin | CF only |
| `sfosTransactions/{txId}` | `fromId == uid` OR `toId == uid` or admin | CF only |
| `sfosEscrow/{escrowId}` | `buyerUid == uid` OR `sellerUid == uid` or admin | CF only |
| `sfosGroups/{groupId}` | Group members (`members.hasAny([uid])`) or admin | CF only |
| `sfosGroups/{groupId}/wallets/{walletUid}` | `walletUid == uid` (path-scoped) or admin | CF only |
| `sfosMerchant/{merchantId}` | `merchantId == uid` or admin | CF only |
| `sfosMerchant/{merchantId}/settlements/{settlementId}` | `merchantId == uid` or admin | CF only |
| `sfosRewards/{uid}` | Owner or admin | CF only |
| `sfosAuditLog/{logId}` | Admin only | CF only |
| `sfosRiskEvents/{riskId}` | Admin only | CF only |
| `sfosFinancialHealth/{uid}` | Owner or admin | CF only |
| `sfosIdempotency/{keyId}` | `uid == uid` or admin | CF only |

### 3.3 Remediations Applied — 2026-07-14

**Finding 1 (Closed): `sfosTransactions` lateral-read via `initiatorUid`**
The previous rule allowed read if `resource.data.initiatorUid == request.auth.uid`. In SFOS flows where an agent or admin CF writes a transaction on behalf of a user, `initiatorUid` could be set to the agent's UID rather than either party to the financial exchange. This created a path where an agent could enumerate all transactions they had ever initiated, including those between other parties. The field has been removed from the read rule. Only `fromId` and `toId` (the direct financial participants) are permitted.

**Finding 2 (Closed): Operator-precedence ambiguity**
Four rules used the pattern `isAuthed() && X == uid || isAdmin()`. In Firebase Rules expression evaluation, `&&` binds more tightly than `||`, so this reads as `(isAuthed() && X == uid) || isAdmin()`. Since `isAdmin()` itself contains `request.auth != null`, there is no unauthenticated bypass, but the intent is ambiguous. All four rules have been rewritten with explicit parentheses: `(isAuthed() && X == uid) || isAdmin()`.

**Finding 3 (Closed): `sfosIdempotency` collection had no rule**
The collection was deployed in the v1.1 engine hardening sprint but had no matching Firestore rule. Without an explicit rule the collection defaults to closed (no access), which means clients cannot check retry status. The rule has been added, restricting read to the document's `uid` owner.

### 3.4 Remaining Rule Observations

- `sfosGroups/{groupId}` reads `resource.data.members.hasAny(...)`. If the `members` array grows beyond Firestore's 1 MB document limit or becomes very large, the `hasAny` call is still within the document field — no index is required for this rule evaluation. Safe.
- `sfosAuditLog` and `sfosRiskEvents` are admin-only reads — correct. No user should be able to query their own audit trail directly (they see transaction history via `sfosTransactions`).

---

## 4. Cloud Functions Security

### 4.1 Input Sanitisation

All string inputs pass through `_san(s, max)` before being persisted to Firestore:
```javascript
function _san(s, max = 500) {
  if (s == null) return '';
  return String(s).replace(/<[^>]*>/g, '').trim().slice(0, max);
}
```
This strips HTML tags (mitigating stored-XSS if data is rendered in an admin UI), trims whitespace, and enforces a length ceiling. Numeric fields are validated via `_assertPositiveAmount` which rejects non-finite numbers and rounds to 2 decimal places.

### 4.2 Error Handling

All CFs use `HttpsError` with structured error codes. No raw JavaScript `Error` objects propagate to clients. Internal `catch` blocks check `e instanceof HttpsError` before re-throwing, preventing internal implementation details from leaking in error messages.

### 4.3 Velocity Check Gap — Non-Atomic Counter

**Finding (P1 — v1.1 fix in progress):** `_velocityCheck` performs a Firestore get and then a separate `_updateVelocity` update. These two operations are not wrapped in a `runTransaction`. Under concurrent requests from the same user (race condition), two parallel transfers could each read the same `dailySpent` value and both pass the limit check before either write increments the counter.

**Recommended Fix:** Move the velocity read + check + increment into a single `runTransaction` block so the counter update is atomic. The v1.1 engine hardening sprint has this as a P1 item.

### 4.4 Secrets Handling

The only secret consumed by `sfos-engine.js` is `ANTHROPIC_API_KEY` (for Claude Haiku AI forecasting), accessed via `defineSecret()` from `firebase-functions/params`. This ensures the key is:
- Never embedded in function code or environment variables accessible via the Cloud Console
- Injected at runtime only into functions that declare `secrets: [ANTHROPIC_API_KEY]`
- Not logged anywhere in the audit trail or structured logs

No other secrets (payment keys, HMAC keys) are consumed directly by `sfos-engine.js`. Those are handled in the commission and payment engines.

### 4.5 Idempotency Gap — No Persisted Key Check

**Finding (P1 — v1.1 fix in progress):** Transfer and escrow lock functions do not yet check a persisted idempotency key before executing. A client retrying a failed (or timed-out) request can submit the same transfer twice. While `runTransaction` prevents double-spend at the balance level, a second successful invocation would create a second transaction record with a different `txId`.

**Recommended Fix:** On entry to `sfosTransfer`, derive an idempotency key from `uid + clientRef + amount + toId`, look up `sfosIdempotency/{key}`, and short-circuit with the original response if the key already exists. Write the key atomically as part of the `runTransaction`.

---

## 5. Payment Security

### 5.1 Balance Floor

All transfer functions check `walletData.balance >= amount` before executing. The check is inside a `runTransaction`, making the comparison and the debit atomic. A user with KES 1,000 cannot send KES 1,001 regardless of concurrent requests.

### 5.2 Freeze Mechanism

The `wallets/{uid}` document carries a `frozen` boolean. All fund-movement Cloud Functions should check `if (walletData.frozen) throw HttpsError('permission-denied', 'Account is frozen')` before proceeding. Confirm this guard is present in `sfosTransfer` and `sfosEscrowLock` during the v1.1 review.

### 5.3 Velocity Limits

`sfosIdentity` stores:
- `dailyLimit` (default KES 50,000)
- `monthlyLimit` (default KES 500,000)
- `dailySpent` / `monthlySpent` with `velocityDayReset` / `velocityMonthReset` timestamps

These are user-configurable within bounds (100–1,000,000 daily; 1,000–10,000,000 monthly). The `sfosIdentityUpdate` CF validates all limit changes and writes an audit log entry. Privileged limit overrides (e.g., merchant accounts with higher limits) should require admin claims — verify this gate in the admin tools.

### 5.4 Double-Entry Ledger

`_writeLedgerEntries` is called inside every `runTransaction` and always creates both a DEBIT and a CREDIT entry atomically. This makes retrospective reconciliation straightforward and makes fraud visible as an imbalance in the ledger.

---

## 6. QR Payment Security

### 6.1 Signing

QR payment codes are signed with HMAC-SHA256 using a server-side secret (`LOYALTY_HMAC_SECRET` from Secret Manager). The client receives a token that includes: `walletId`, `amount`, `expiresAt`, and the HMAC signature. Any tampering with the payload produces an invalid signature that the CF rejects.

### 6.2 Expiry

QR tokens include an `expiresAt` timestamp (15-minute window). The CF validation step checks `Date.now() > expiresAt` and rejects expired tokens with `deadline-exceeded`.

### 6.3 Replay Prevention — Known Gap (P2)

**Finding:** Expiry alone does not prevent replay within the 15-minute window. If an attacker intercepts a QR token (e.g., via a screenshot), they can present it again at a different terminal within the validity period.

**Recommended Control:** Write the QR token hash to `sfosIdempotency/{tokenHash}` on first use. On subsequent presentation, the lookup finds the existing record and returns `already-exists`. This closes the intra-window replay vector. Linked to the idempotency work in v1.1.

---

## 7. API Security

### 7.1 App Check Enforcement

All SFOS Cloud Function exports use `{ enforceAppCheck: true }`. This means:
- Requests without a valid App Check token are rejected before the function handler runs.
- The token is tied to the ReCaptchaV3 site key and cannot be minted by an arbitrary client.

### 7.2 No Per-User CF Rate Limit (P2)

**Finding:** App Check prevents unauthenticated volume, but an authenticated user with a valid App Check token can invoke SFOS functions at high frequency. The only throttle for financial operations is the velocity counter — which has the non-atomic gap noted above.

**Recommended Control:** Implement a Redis-backed per-UID rate limit at the CF entry point (e.g., max 30 calls/minute per UID across all SFOS functions). The Redis Infrastructure Layer (project_redis_layer.md) provides the SDK for this. This is a P2 item for the GA gate.

### 7.3 CORS

`BASE_OPTS` sets `cors: true`. For a financial API, this is permissive. Given that SFOS is called from the SOKONI web app (a known origin), consider restricting CORS to `https://sokoni.co.ke` in production. This is a defence-in-depth measure — Firebase Auth token validation already prevents unauthorised use, but CORS restriction limits where the Firebase SDK can be initialised.

### 7.4 OWASP A05 — Security Misconfiguration

- Firebase project is in production mode (Firestore rules default-deny)
- App Check enforcement is on
- Secrets are in Secret Manager, not environment variables
- Cloud Functions are Gen2 with minimum instance = 0 (no persistent state in memory between cold starts)
- **Gap:** Ensure Firebase Hosting `__/firebase/*` introspection endpoints are not exposing project configuration in ways that enumerate SFOS collection names

---

## 8. Cryptography

### 8.1 PIN Hashing

User PINs are hashed with SHA-256 before storage in `sfosIdentity.pinHash`. The `_sha256` helper uses `crypto.createHash('sha256').update(String(input), 'utf8').digest('hex')`.

**Note:** SHA-256 without a salt is vulnerable to rainbow-table attacks if the PIN space is small (4–6 digits). For PINs specifically, a keyed HMAC (using a server-side secret) or bcrypt/argon2 would be stronger. As a P2 improvement: add a per-user or global PIN pepper stored in Secret Manager before GA.

### 8.2 ID Generation

All IDs (`_genId`, `_genWalletId`) use `crypto.randomBytes()` from the Node.js built-in `crypto` module — the CSPRNG. There is no use of `Math.random()` in any ID or token path. Wallet IDs have format `SOK-XXXXXXXX` (8 chars from a 36-char alphabet, seeded by `randomBytes(8)`). Collision probability is negligible but the engine includes a 5-attempt uniqueness check for `walletId` at identity creation time.

### 8.3 HMAC for QR

QR token signing uses HMAC-SHA256. The signing secret comes from Secret Manager. This is the correct approach — QR codes signed with a symmetric key that only the server knows.

### 8.4 Transport

All Firebase SDK calls use HTTPS. No SFOS function writes to HTTP endpoints. Cloud Run (the underlying Gen2 runtime) enforces TLS 1.2+ on all inbound connections.

---

## 9. Data Protection

### 9.1 PII in Firestore

`sfosIdentity/{uid}` stores: `displayName`, `phone`, `email`. These are collected from the Firebase Auth token at identity creation time — not from client-supplied request fields. The Firestore rule restricts read to the owner UID or admin. The `sfosIdentityGet` CF returns this data to the authenticated owner.

**Consideration:** For GDPR/Kenya Data Protection Act (DPA 2019) compliance, a data-deletion path should exist. Currently, `sfosIdentity` is not tombstoned on account deletion. Add a Cloud Function triggered by Firebase Auth `user.deleted` that anonymises PII fields (`displayName → null`, `phone → null`, `email → null`) while preserving the financial history with the UID as the sole identifier.

### 9.2 No PII in Logs

The `_log` helper serialises a structured JSON line. It receives `uid` (not PII) and `err.message`. No phone numbers, display names, or email addresses are in any log line.

### 9.3 No Client-Side Secrets

`sfos-engine.js` is a server-side Cloud Function file. The `sokoni-wallet-v2.js` (client-side SDK) must not import or expose any signing keys. Verify that the HMAC signing secret is never referenced in any `*.js` file outside `functions/`.

---

## 10. OWASP Top 10 Mapping

| # | Category | SFOS Control | Status |
|---|---|---|---|
| A01 | Broken Access Control | Firestore rules all-deny-write; read scoped to owner/admin; `_requireAuth` and `_requireAdmin` in every CF | Mitigated |
| A02 | Cryptographic Failures | `crypto.randomBytes` for IDs; SHA-256 PIN hash; HMAC-SHA256 QR signing; HTTPS enforced; secrets in Secret Manager | Mitigated — PIN salting is P2 gap |
| A03 | Injection | `_san()` strips HTML tags; string inputs length-capped; Firestore SDK uses parameterised queries (no raw query strings) | Mitigated |
| A04 | Insecure Design | Double-entry ledger; balance floor in runTransaction; velocity limits; audit log; escrow before settlement | Mitigated — MFA for high-value is P1 gap |
| A05 | Security Misconfiguration | Firestore default-deny; App Check enforced; secrets in Secret Manager; no HTTP endpoints | Partially mitigated — CORS restriction is P2 gap |
| A06 | Vulnerable Components | Node.js 22 (LTS); Firebase Gen2; `firebase-admin` and `firebase-functions` from npm | Ongoing — dependency audit recommended quarterly |
| A07 | Identity & Auth Failures | Firebase Auth with custom claims; App Check attestation; admin claim server-set only | Mitigated — step-up MFA is P1 gap |
| A08 | Software & Data Integrity | Admin SDK writes bypass client rules; no client can write to any SFOS collection; `sfosAuditLog` is append-only | Mitigated |
| A09 | Security Logging & Monitoring | Structured JSON logs; `sfosAuditLog` immutable; `sfosRiskEvents` for fraud signals; `_riskScore` scoring | Mitigated — alerting pipeline (Cloud Monitoring) needs wiring |
| A10 | Server-Side Request Forgery | No SFOS CF makes outbound HTTP requests based on user-supplied URLs; Anthropic API call uses a hardcoded endpoint | Mitigated |

---

## 11. PCI-DSS Readiness

SFOS currently processes M-Pesa wallet top-ups and settlements via IntaSend (the payment service provider). It does not store card numbers, CVV, or cardholder data. PCI-DSS scope is therefore limited to SAQ-A (redirect-based card acceptance) if card payments are added in future.

| PCI-DSS Requirement | Status |
|---|---|
| Req 1 — Network controls (firewall) | Firebase / Google Cloud VPC; Firestore network rules | Partial |
| Req 2 — Default passwords / configs | No default credentials; all secrets in Secret Manager | Met |
| Req 3 — Protect stored cardholder data | No card data stored in SFOS | Not applicable (M-Pesa only) |
| Req 4 — Encrypt data in transit | All endpoints HTTPS/TLS 1.2+ | Met |
| Req 6 — Secure development lifecycle | Security review gate per CLAUDE.md; OWASP mapping per this report | Partial |
| Req 7 — Restrict access by business need | Admin-only audit logs; owner-scoped reads | Met |
| Req 8 — Identify and authenticate | Firebase Auth + custom claims; App Check | Met — MFA gap (P1) |
| Req 10 — Log and monitor | sfosAuditLog + Cloud Logging structured JSON | Partial — alerting pipeline needed |
| Req 12 — Security policy | CLAUDE.md security standards; this audit report | Met |

**Pending for full PCI-DSS readiness:** formal SAQ completion, quarterly vulnerability scans, penetration test evidence, and a written information security policy document.

---

## 12. Known Gaps and Remediation Roadmap

| ID | Finding | Priority | Owner | Target |
|---|---|---|---|---|
| SEC-001 | Velocity counter non-atomic (read → check → update not in runTransaction) | P1 | Engineering | v1.1 Engine Hardening |
| SEC-002 | No persisted idempotency key — duplicate transfers possible on retry | P1 | Engineering | v1.1 Engine Hardening |
| SEC-003 | No step-up MFA for high-value transactions (>KES 10,000) | P1 | Engineering | Security 6.0 Sprint |
| SEC-004 | QR token replay possible within 15-min window | P2 | Engineering | v1.1 (linked to SEC-002) |
| SEC-005 | No per-user CF rate limit (App Check only) | P2 | Engineering | Redis Layer GA gate |
| SEC-006 | CORS set to `true` (all origins) — restrict to production domain | P2 | Engineering | Pre-GA config pass |
| SEC-007 | PIN stored as SHA-256 without salt/pepper | P2 | Engineering | v1.2 Security Hardening |
| SEC-008 | No account-deletion PII anonymisation path | P2 | Legal / Engineering | DPA 2019 compliance sprint |
| SEC-009 | sfosAuditLog not wired to Cloud Monitoring alerting pipeline | P2 | DevOps | Ops Infrastructure sprint |
| SEC-010 | No formal SAQ or quarterly vulnerability scan schedule | P3 | CTO / Legal | Pre-card-processing |
| SEC-011 | `sfosIdentityGet` returns `phone` and `email` — confirm these are needed by the client | P3 | Engineering | v1.1 review |

---

## 13. Security Testing Evidence

The following tests should be run before the GA gate is signed off:

### 13.1 SAST (Static Analysis)
- Run `semgrep` with the Firebase and Node.js rulesets against `functions/sfos-engine.js`
- Check for: hardcoded strings that look like secrets, use of `Math.random()` in security-sensitive paths, unhandled promise rejections

### 13.2 Firestore Rules Emulator Tests
- Use the Firebase Emulator Suite to replay each rule scenario:
  - Non-owner attempting to read `sfosIdentity/{otherUid}` — expect DENY
  - User guessing a `sfosTransactions/{txId}` where they are neither fromId nor toId — expect DENY
  - User attempting to write to `sfosLedger` — expect DENY
  - Admin token reading `sfosAuditLog` — expect ALLOW
  - User reading their own `sfosIdempotency` record — expect ALLOW

### 13.3 CF Integration Tests
- Submit `sfosTransfer` without App Check token — expect `unauthenticated`
- Submit `sfosTransfer` with amount exceeding `dailyLimit` — expect `resource-exhausted`
- Submit duplicate `sfosTransfer` with same client reference within 60 seconds — expect idempotent response (post v1.1)
- Submit `sfosTransfer` from a frozen wallet — expect `permission-denied`

### 13.4 Penetration Test Scope (Pre-GA)
- Firestore rule bypass attempts (direct REST API calls with forged tokens)
- App Check token reuse / replay
- JWT custom claim self-elevation (confirm Admin SDK is the only claim-setter)
- Velocity limit bypass under concurrent load (K6 or Artillery)

---

## 14. Compliance Notes — CBK Kenya

The Central Bank of Kenya's **National Payment System Act (2011)** and **Payment System Regulations (2014)** impose the following obligations relevant to SFOS:

| Requirement | CBK Obligation | SFOS Status |
|---|---|---|
| Transaction records | Retain for 7 years | sfosLedger is append-only; no delete rules; add lifecycle policy to prevent accidental deletion |
| Settlement | Funds to reach recipient within T+1 | SFOS auto-settlement engine handles this; verify SLA in merchant settlement CF |
| Suspicious transaction reporting | Report to Financial Reporting Centre (FRC) within 3 days | `sfosRiskEvents` captures anomalies; manual FRC reporting process needed |
| KYC | Tiered KYC based on transaction volume | `kycStatus` field on `sfosIdentity`; KYC gate before `DIAMOND` tier needed |
| Consumer protection | Dispute resolution | `sfosEscrow` dispute fields present; formal dispute CF needed for Phase 1 |
| Cybersecurity | Annual third-party security audit | This report covers internal review; external pen test required for CBK submission |

---

*This report was prepared as part of the SOKONI RC1 Phase 0 Pilot security gate. It should be reviewed and updated after any material change to `sfos-engine.js`, `firestore.rules` (SFOS section), or any dependent payment engine.*

*Next scheduled review: before Phase 1 GA — estimated Q4 2026.*
