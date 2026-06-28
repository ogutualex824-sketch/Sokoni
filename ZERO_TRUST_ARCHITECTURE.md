# SOKONI Zero Trust Architecture

**Classification:** Internal Technical Reference — Restricted  
**Version:** 1.0  
**Date:** 2026-06-28  
**Owner:** SOKONI Platform Security  
**Status:** Production Active

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Zero Trust Principles Applied](#2-zero-trust-principles-applied)
3. [Identity Plane](#3-identity-plane)
4. [Policy Engine (ABAC)](#4-policy-engine-abac)
5. [Network Security](#5-network-security)
6. [Data Protection](#6-data-protection)
7. [Authorization Matrix](#7-authorization-matrix)
8. [Fraud Detection Engine](#8-fraud-detection-engine)
9. [Audit & Compliance](#9-audit--compliance)
10. [Incident Response Playbook](#10-incident-response-playbook)
11. [Security Scorecard Methodology](#11-security-scorecard-methodology)
12. [Architecture Diagram](#12-architecture-diagram)
13. [Deployment Security Requirements](#13-deployment-security-requirements)
14. [Known Limitations & Roadmap](#14-known-limitations--roadmap)

---

## 1. Executive Summary

### What Zero Trust Means for SOKONI

Zero Trust is a security model grounded in the principle of **never trust, always verify**. It rejects the legacy assumption that anything inside a network perimeter can be trusted by default. Instead, every request — regardless of origin, network location, or prior authentication — must be explicitly verified before access is granted to any resource.

For SOKONI, this is not an optional architectural enhancement. It is a foundational security requirement.

### Contrast With Traditional Perimeter Security

Traditional perimeter security operates on a castle-and-moat model: once a user or system is inside the network boundary, they are implicitly trusted to access internal resources. This model has two critical weaknesses that make it unacceptable for modern cloud-native platforms:

1. **The perimeter is dissolving.** SOKONI runs entirely on Firebase and Google Cloud. There is no corporate network. Users access the platform from mobile devices across Kenya and beyond. Employees and vendors access admin portals from laptops on consumer broadband. A perimeter does not exist in any meaningful sense.

2. **Lateral movement is catastrophic.** If a single compromised credential can traverse the internal "trusted" network freely, the blast radius of any breach is unlimited. In a multi-tenant marketplace with financial data, this risk is existential.

Zero Trust eliminates both problems by treating every request as potentially hostile until proven otherwise, regardless of where it originates.

### SOKONI's Threat Model

SOKONI operates as a B2B2C super-platform with a uniquely complex threat surface:

| Threat Vector | Description |
|---|---|
| **Multi-tenant marketplace** | Thousands of independent sellers, each with their own staff, share a single Firestore namespace. A misconfigured rule or a privilege escalation bug exposes competitor data. |
| **SmartPOS deployment** | Physical point-of-sale terminals operated by cashiers under potentially hostile conditions — staff theft, social engineering, unauthorized override attempts. |
| **Financial platform** | Real-money transactions via M-Pesa and IntaSend. Wallet balances, escrow accounts, commission ledgers, and payment state must be tamper-proof. |
| **Multi-role access** | Eight distinct roles (guest, buyer, cashier, supervisor, manager, owner, admin, super_admin) with overlapping and nested permissions across 25+ collections. |
| **AI-powered features** | Cloud Functions calling Anthropic Claude with live API keys. Any CF misconfiguration can expose keys, incur unbounded cost, or leak user data to the model. |
| **Driver and logistics network** | Real-time GPS data, delivery assignments, and route information. Location data is privacy-sensitive and operationally critical. |

### Why Zero Trust Is Mandatory

SOKONI processes payments, stores PII, operates a financial ledger, and serves multiple business entities from a single platform. A breach is not just a technical failure — it is a legal, regulatory, and reputational catastrophe. The combination of financial data, health information (Healthcare Hub), employment records (Jobs Hub), and transaction history makes SOKONI a high-value target.

Zero Trust is not a product. It is an architecture. Every system, service, and API endpoint in SOKONI is designed to enforce identity verification, least-privilege access, continuous monitoring, and cryptographic trust at every layer.

---

## 2. Zero Trust Principles Applied

This section maps each of the seven Zero Trust tenets from **NIST SP 800-207** to SOKONI's concrete implementation decisions.

---

### Tenet 1: All Data Sources and Computing Services Are Treated as Resources

**NIST Definition:** Every device, server, data store, and service is a resource to be protected, regardless of whether it sits inside or outside a traditional network boundary.

**SOKONI Implementation:**

SOKONI operates zero on-premises infrastructure. Every resource — Firestore databases, Cloud Functions, Cloud Storage buckets, Firebase Hosting, and the Redis layer — is a managed cloud resource. This architecture eliminates the false comfort of an internal network but requires that every resource be independently secured.

In practice:
- Firestore Security Rules enforce per-collection, per-operation access control at the database layer itself. The database is not a trusted internal resource — it enforces its own access policy regardless of which service calls it.
- Cloud Storage buckets have no public access. Every read and write requires an authenticated identity with validated claims.
- Cloud Functions are the only authorized path for server-side operations. Clients never write directly to sensitive collections (payments, ledger, audit logs). The CF layer is itself a protected resource with App Check enforcement.
- Redis is treated as a sensitive cache layer with TTL-bounded data. No sensitive user PII is stored in Redis without expiry.

---

### Tenet 2: All Communication Is Secured Regardless of Network Location

**NIST Definition:** Network location (LAN, WAN, VPN) does not confer trust. All communication channels must be encrypted and authenticated.

**SOKONI Implementation:**

- All Firebase SDK communication uses TLS 1.2 or higher, enforced by Google's infrastructure. There is no HTTP fallback path.
- Firebase Hosting enforces HTTPS with HTTP Strict Transport Security (HSTS). Browsers are instructed to never connect over plain HTTP for up to one year.
- Cloud Function endpoints are HTTPS-only. No unencrypted HTTP triggers exist.
- Webhook payloads from SmartPOS integrations are validated with HMAC-SHA256 signatures before processing. A valid HTTPS connection is necessary but not sufficient — the payload must also prove it originated from a trusted sender.
- Firebase App Check tokens are required for all CF invocations. A valid network call without a valid App Check attestation is rejected at the function entry point.
- Internal service-to-service calls (CF to CF) use Firebase Admin SDK with service account credentials, never raw HTTP with no authentication.

---

### Tenet 3: Access to Individual Resources Is Granted Per-Session

**NIST Definition:** Access is not persistent. Each session or request must independently establish authorization. Trust is not inherited from prior sessions.

**SOKONI Implementation:**

Firebase ID tokens have a default lifetime of **one hour**. When a token expires, the client must obtain a fresh one. This is not a cached authorization — it is a re-evaluation of the user's current state against current security signals.

Beyond token lifetime, SOKONI implements session risk scoring that can invalidate sessions mid-lifetime:
- If a device trust score drops below 0.3 during a session (e.g., due to detected anomaly), the session is flagged for step-up re-authentication.
- A user who travels impossibly fast between two geographic locations (detected by haversine calculation against stored location) triggers session suspension, even if the token has not yet expired.
- High-value POS operations (void, refund, discount above threshold, shift close) require manager PIN authorization per operation — not just per session. Access to these operations is re-evaluated at each invocation.
- Step-up authentication challenges expire after **10 minutes**. If the challenge is not completed, access to the protected resource is denied even if the base session remains valid.

---

### Tenet 4: Access Is Determined by Dynamic Policy

**NIST Definition:** Policy is not static ACL entries. It incorporates behavioral signals, environmental context, and real-time risk assessment.

**SOKONI Implementation:**

The SOKONI Policy Engine evaluates **10 attributes** per request (see Section 4 for full detail). These attributes are runtime values, not static configurations. The policy outcome for any given request depends on the current state of all 10 dimensions simultaneously:

- A user who is MFA-enrolled and on a trusted device during business hours in Nairobi may access payment exports.
- The same user on an unrecognized device from an unusual country immediately after a failed authentication attempt is denied the same operation and required to step up.
- A cashier during an active shift at a registered branch can process sales. The same cashier before shift start, after shift close, or from outside the registered branch context is denied POS operations.
- Transaction value is a dynamic policy input. A payment below KES 10,000 from a trusted device requires normal authentication. The same account initiating a KES 100,000+ payment requires step-up authentication regardless of prior session state.

Dynamic policy means the answer to "can this user do this?" is never cached. It is recomputed fresh for every sensitive operation.

---

### Tenet 5: Monitor and Measure Integrity of All Owned and Associated Assets

**NIST Definition:** Continuously assess the security posture of all devices and services. Security is not a one-time gate — it is an ongoing measurement.

**SOKONI Implementation:**

- **Device Trust Registry:** Every device that authenticates against SOKONI receives a trust score (0.0–1.0) stored in `securityDevices/{uid}`. This score decays on suspicious events and recovers over time with consistent clean behaviour. Devices are fingerprinted using SHA-256 hashing of browser/OS signals.
- **Automated health sweeps:** Cloud Scheduler runs hourly sweeps to evaluate session risk, check for anomalous patterns, and escalate open security alerts.
- **Security scorecard:** The platform maintains a 15-dimension security score (see Section 11) that is continuously recalculated as security events occur.
- **Integrity monitoring for Cloud Functions:** Function deployment is gated to authenticated CI/CD principals. No manual function pushes are permitted from developer machines in production.
- **App Check attestation** provides a continuous proof-of-integrity signal from client applications. A client that fails attestation (e.g., a jailbroken device, a cloned APK) cannot call any Firebase backend.

---

### Tenet 6: All Resource Authentication and Authorization Are Dynamic and Strictly Enforced

**NIST Definition:** Before a resource is accessed, identity must be authenticated and authorization must be evaluated. This enforcement is not advisory — it is a hard gate.

**SOKONI Implementation:**

SOKONI enforces authentication and authorization at three independent layers:

1. **Client layer:** Firebase SDK enforces that the user is authenticated before allowing Firestore reads/writes. Unauthenticated requests are rejected before any network call is made.
2. **Database layer:** Firestore Security Rules enforce role-based access on every document read and write. These rules cannot be bypassed from the client — they execute server-side on Google's infrastructure.
3. **Function layer:** Cloud Functions validate Firebase ID tokens, check custom claims, verify App Check tokens, and evaluate the full ABAC policy before executing any business logic.

A request must pass all three layers. Passing two out of three is not sufficient. There is no path through the system that bypasses any layer.

---

### Tenet 7: Collect as Much Information as Possible About Current State

**NIST Definition:** Log everything. Security decisions are only as good as the data feeding them. Comprehensive telemetry enables detection of threats that no static rule can anticipate.

**SOKONI Implementation:**

- **Immutable audit log:** Every security-significant event is written to `securityAuditLog` by Cloud Functions. These writes are append-only with tamper-evident SHA-256 chaining.
- **10 event types, 5 severities:** Authentication, authorization, payment, data access, admin action, system, fraud, compliance, session, and rate-limit events are categorized and stored.
- **Distributed request tracing:** All CF requests carry a correlation ID that threads through audit log entries, enabling full request reconstruction.
- **Fraud signal accumulation:** Risk signals from all sources (device, location, velocity, session) are aggregated into a per-user risk score that can be queried in real time by the policy engine.
- **Security Operations Center dashboard:** The `security-operations.html` dashboard provides real-time visibility into open incidents, active alerts, session anomalies, and fraud events.
- **Retention:** Audit logs are retained indefinitely via Firestore PITR. Security events have a 90-day active retention period.

---

## 3. Identity Plane

The identity plane is the foundation of SOKONI's Zero Trust architecture. Every access decision begins with identity establishment. An unverified identity is an unauthenticated request — it is denied regardless of any other factor.

---

### 3.1 Firebase Authentication as Identity Provider

Firebase Authentication is SOKONI's primary identity provider, selected for its deep integration with Firestore Security Rules, Cloud Functions, and App Check.

**Supported authentication methods:**
- Google OAuth 2.0
- Facebook OAuth 2.0
- Phone number (SMS OTP via Firebase)
- Email/password

**Identity lifecycle:**
- User creation triggers a Cloud Function that initializes the user document, assigns the default role (`buyer`), and generates a referral code.
- Role elevation (e.g., to `cashier`, `manager`, `owner`) is performed exclusively by Cloud Functions after business verification — never by client-side writes.
- Roles are stored as Firebase custom claims on the ID token. This ensures every ID token carries the user's current role, and the role cannot be forged without access to Firebase Admin SDK.
- Account deletion triggers a cascade that revokes sessions, purges device records, anonymizes audit log entries (while preserving events for compliance), and closes any open sessions.

---

### 3.2 TOTP Multi-Factor Authentication

SOKONI implements Time-based One-Time Password (TOTP) MFA conforming to **RFC 6238** for high-privilege users and optional enrolment for all users.

**Technical specification:**

| Parameter | Value |
|---|---|
| Algorithm | HMAC-SHA1 |
| Time step | 30 seconds |
| Window tolerance | ±1 step (90-second effective window) |
| OTP length | 6 digits |
| Backup codes | 8 codes, single-use, stored as bcrypt hashes |
| Secret storage | Base64-encoded in `securityMFA/{uid}` — never stored as plaintext |
| Enrolment flow | QR code generation → client scans with authenticator app → verify challenge before activating |

**Mandatory MFA scenarios:**
- Any account with role `supervisor`, `manager`, `owner`, `admin`, or `super_admin`
- Any account initiating a transaction above KES 100,000
- Any account accessing financial export functions
- Any admin action in the Security Operations Center

**Backup code policy:**
- Backup codes are displayed exactly once at enrolment
- Each code is single-use (marked consumed after use)
- After consuming 4+ backup codes, the user is forced to re-enrol TOTP
- Backup codes cannot be used for financial operations — only for account recovery

---

### 3.3 WebAuthn Passkeys

SOKONI supports WebAuthn passkeys as a phishing-resistant, hardware-bound second factor and alternative primary authentication method.

**Technical specification:**

| Parameter | Value |
|---|---|
| Relying Party ID (RP ID) | `mysokoni.co.ke` |
| Challenge generation | 32-byte cryptographically random value per ceremony |
| Challenge lifetime | 5 minutes |
| Signature counter | Enforced — replay prevention |
| Authenticator attachment | Platform (device biometric) preferred; cross-platform (hardware key) supported |
| User verification | Required (`userVerification: "required"`) |
| Attestation | `none` for consumer flow; `direct` available for enterprise SmartPOS devices |

**Registration ceremony:**
1. Client calls CF `beginPasskeyRegistration` → CF returns challenge + RP info
2. Client calls `navigator.credentials.create()` with challenge
3. Authenticator signs the challenge with the device private key (private key never leaves the secure enclave)
4. Client sends public key + attestation to CF `completePasskeyRegistration`
5. CF verifies attestation, stores public key in `securityDevices/{uid}/passkeys`

**Authentication ceremony:**
1. Client calls CF `beginPasskeyAuth` → CF returns challenge
2. Client calls `navigator.credentials.get()` with stored credential IDs
3. Authenticator signs challenge; counter is incremented
4. Client sends assertion to CF `completePasskeyAuth`
5. CF verifies signature against stored public key, checks counter is strictly greater than stored counter (replay prevention), updates counter

**Counter replay prevention:** If an incoming assertion presents a counter value less than or equal to the stored counter, the authentication is rejected and an alert is raised — this indicates either a cloned authenticator or a replay attack.

---

### 3.4 Device Trust Registry

Every client device that authenticates against SOKONI is registered in the Device Trust Registry (`securityDevices/{uid}` collection).

**Device fingerprint construction:**

The device fingerprint is constructed from a combination of browser and OS signals:
- User-Agent string
- Screen resolution and colour depth
- Timezone and locale
- Available fonts subset (canvas fingerprint)
- WebGL renderer string
- Audio context characteristics
- Installed plugins (where available)

These signals are concatenated and hashed with **SHA-256** before storage. The raw signals are never persisted. The hash is stored as the device identifier.

**Trust score model:**

| Score Range | Meaning | Policy Effect |
|---|---|---|
| 0.8 – 1.0 | Fully trusted | Normal access; reduced friction |
| 0.5 – 0.79 | Partially trusted | Standard access; step-up for sensitive ops |
| 0.3 – 0.49 | Low trust | Restricted access; step-up required for most ops |
| 0.0 – 0.29 | Untrusted | Deny or require full re-authentication |

**Trust score adjustments:**

| Event | Score Effect |
|---|---|
| Successful MFA verification | +0.1 (max 1.0) |
| Successful passkey authentication | +0.15 (max 1.0) |
| Failed authentication attempt | −0.1 |
| Impossible travel detected | −0.4 |
| Suspicious behaviour pattern | −0.2 |
| 30-day inactivity | −0.05 per week |
| Admin-confirmed legitimate use | +0.2 |

**New device behaviour:** An unrecognized device fingerprint starts with a trust score of 0.5 (partially trusted). The user receives an email notification of the new device login. Financial operations are blocked for 24 hours on a new device unless the user explicitly approves it via an email confirmation link.

---

### 3.5 Session Risk Scoring

Every active session is continuously scored across six dimensions. The session risk score determines whether the session continues normally, is challenged, or is terminated.

**Six scoring factors:**

| Factor | Weight | Low Risk Signal | High Risk Signal |
|---|---|---|---|
| Device Trust Score | 25% | Score ≥ 0.8 | Score < 0.3 |
| Location Consistency | 25% | Same city as prior session | >500 km displacement in <2 hours |
| Session Age | 15% | < 30 minutes | > 4 hours without re-authentication |
| MFA Status | 15% | MFA verified this session | MFA not enrolled or not verified |
| Recent Failures | 10% | 0 failures in last hour | 3+ failures in last 15 minutes |
| Role Sensitivity | 10% | Role: buyer, cashier | Role: admin, super_admin |

**Session risk thresholds:**

| Combined Risk Score | Action |
|---|---|
| 0–30 | Allow: no friction |
| 31–60 | Allow with audit: log all actions |
| 61–80 | Require step-up authentication |
| 81–100 | Suspend session: require full re-authentication |

---

### 3.6 Step-Up Authentication

Step-up authentication is a mid-session identity challenge triggered when a user attempts an operation that exceeds their current session trust level.

**Trigger conditions:**
- Attempting to void a POS transaction
- Initiating a refund
- Accessing financial export (P&L, ledger, commission report)
- Transaction value exceeds KES 100,000
- Session risk score crosses the 61–80 threshold
- IP country changes during an active session
- Device trust score drops below 0.5 during a session

**Step-up challenge flow:**

1. CF intercepts the protected operation request
2. CF generates a step-up challenge token: `HMAC-SHA256(secret, uid + operationId + timestamp)`
3. Challenge is stored in `securitySessions/{uid}/stepUpChallenges` with a 10-minute TTL
4. Client is returned a `STEP_UP_REQUIRED` response with the challenge type
5. User completes the challenge via their enrolled method: `TOTP | SMS | Passkey`
6. CF verifies the challenge response and the HMAC token
7. On success, a step-up proof token is issued (valid for the specific operation only)
8. Original operation is retried with the step-up proof attached

**Challenge expiry:** If the challenge is not completed within 10 minutes, it is invalidated. The user must restart the protected operation, which generates a fresh challenge. There is no grace period extension.

---

## 4. Policy Engine (ABAC)

SOKONI's Policy Engine implements Attribute-Based Access Control (ABAC), evaluating a composite set of attributes from multiple sources before granting access to any protected resource. Unlike simple Role-Based Access Control (RBAC), ABAC allows the policy to incorporate real-time context, making it dynamic and context-aware.

### 4.1 Attribute Evaluation Table

The following 10 attributes are evaluated on every request to a protected Cloud Function or sensitive Firestore operation:

| # | Attribute | Source | Data Type | How Used in Policy |
|---|---|---|---|---|
| 1 | **Role** | Firebase custom claims (`claims.role`) | Integer (0–5) | Determines base permission level; role 0 = guest, 5 = super_admin |
| 2 | **Device Trust Score** | `securityDevices/{uid}` (Firestore lookup) | Float (0.0–1.0) | Values below 0.3 trigger denial; 0.3–0.5 triggers step-up |
| 3 | **Session Age** | ID token `iat` (issued-at) claim | Seconds since epoch | Sessions older than 4 hours require re-authentication for sensitive ops |
| 4 | **MFA Enrolled** | `securityMFA/{uid}.enrolled` (Firestore lookup) | Boolean | Hard gate for all financial operations; deny if false |
| 5 | **Risk Score** | `securityRisk/{uid}.currentScore` (Firestore lookup) | Integer (0–100) | Score >80 blocks all operations; 60–80 triggers step-up |
| 6 | **Branch ID** | `sellers/{uid}.branchId` (custom claim or Firestore) | String (UUID) | Data isolation: queries are filtered to the user's registered branch |
| 7 | **Shift Active** | `posShifts` collection (Firestore lookup by uid + date) | Boolean | POS operations denied if no active shift exists for the user |
| 8 | **Transaction Value** | Request payload `amount` field | Integer (KES paise) | Values ≥ KES 100,000 require step-up regardless of other attributes |
| 9 | **IP Country** | GeoIP resolution of request IP (CF environment) | ISO 3166-1 alpha-2 | Non-KE country flags for review; blocks for high-risk jurisdictions |
| 10 | **Correlation ID** | `X-Correlation-ID` request header | UUID v4 | Wired to distributed tracing; missing ID logs a warning |

### 4.2 Policy Decision Outcomes

| Outcome | Condition | Effect |
|---|---|---|
| **Allow** | All attributes within acceptable bounds, risk score < 40 | Request proceeds normally; standard audit entry written |
| **Allow with Audit** | Attributes acceptable but risk score 40–60 or unusual location | Request proceeds; enhanced audit entry with full attribute snapshot written |
| **Require Step-Up** | Risk score 61–80, device trust 0.3–0.5, sensitive operation, or transaction ≥ KES 100k | Request held; step-up challenge issued; retry required with step-up proof |
| **Deny** | Risk score >80, device trust < 0.3, MFA gate failed, shift not active for POS ops, role insufficient | Request rejected with `403 FORBIDDEN`; security event logged; user notified |

### 4.3 Policy Evaluation Order

Attributes are evaluated in a short-circuit sequence. The policy engine fails fast on hard blockers:

```
1. App Check token valid?         → NO  → Deny (unauthenticated app)
2. Firebase ID token valid?       → NO  → Deny (unauthenticated user)
3. Token not revoked?             → NO  → Deny (revoked session)
4. Risk score <= 80?              → NO  → Deny (high-risk session)
5. Device trust >= 0.3?           → NO  → Deny (untrusted device)
6. Role sufficient for operation? → NO  → Deny (insufficient privilege)
7. MFA enrolled (if financial)?   → NO  → Deny (missing MFA gate)
8. Shift active (if POS)?         → NO  → Deny (no active shift)
9. Risk score <= 60?              → NO  → Require Step-Up
10. Device trust >= 0.5?          → NO  → Require Step-Up
11. Transaction < KES 100k?       → NO  → Require Step-Up
12. All checks passed             → Allow (with or without enhanced audit)
```

---

## 5. Network Security

### 5.1 Firebase App Check

Firebase App Check is enforced across all three Firebase backend services. It provides cryptographic proof that requests originate from legitimate, unmodified instances of the SOKONI application.

**Enforcement scope:**

| Service | Enforcement Level | Token Validator |
|---|---|---|
| Cloud Functions | Hard enforcement — all functions | ReCaptcha v3 (web), DeviceCheck (iOS), Play Integrity (Android) |
| Firestore | Hard enforcement — all collections | Same attestation providers |
| Cloud Storage | Hard enforcement — all buckets | Same attestation providers |

**What App Check prevents:**
- API scraping by non-app HTTP clients
- Requests from modified or repackaged APKs (Play Integrity detects this)
- Jailbroken/rooted device requests (DeviceCheck flags these)
- Automated scripts calling Firebase REST APIs without valid attestation
- Competitors reverse-engineering the API surface and calling it directly

**App Check bypass is not possible** for production Firebase projects. A caller without a valid attestation token receives a `403 PERMISSION_DENIED` before any Firebase Security Rule or Cloud Function code executes.

---

### 5.2 Cloud Function Security

All SOKONI Cloud Functions are deployed with the following security baseline:

| Control | Value |
|---|---|
| Region | `us-central1` (single region for latency consistency) |
| Protocol | HTTPS only — no HTTP triggers |
| Authentication | Firebase Auth token required (Admin SDK `verifyIdToken`) |
| App Check | Required (functions SDK `enforceAppCheck: true`) |
| Memory | Allocated per function need — no over-provisioning |
| Timeout | Minimum necessary — no unbounded execution |
| Concurrency | Tuned per function — high-concurrency for read ops, lower for write ops |
| Secrets | Injected via Secret Manager at deploy time — never hardcoded |
| Egress | Default VPC — no public outbound unless explicitly required |

**Webhook security (SmartPOS integrations):**

Webhook payloads from external integrators (hardware vendors, payment providers) are validated before processing:

1. The webhook request must include an `X-Sokoni-Signature` header
2. The CF computes `HMAC-SHA256(webhookSecret, rawRequestBody)` where `webhookSecret` is fetched from Secret Manager
3. The computed signature is compared to the header value using a timing-safe comparison function
4. Requests with missing, malformed, or mismatched signatures are rejected with `401 UNAUTHORIZED` and logged

**Request correlation:**

Every CF invocation generates or propagates a UUID v4 correlation ID. This ID is:
- Included in all Firestore writes made during the request
- Written to the audit log alongside the request outcome
- Returned in the response header `X-Correlation-ID` for client-side debugging
- Used to correlate distributed log entries across multiple CFs in a workflow

---

### 5.3 Firebase Hosting Headers

All responses from SOKONI's Firebase Hosting deployment include the following security headers:

| Header | Value | Purpose |
|---|---|---|
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains; preload` | Forces HTTPS for 1 year; prevents SSL stripping |
| `X-Frame-Options` | `DENY` | Prevents clickjacking via iframe embedding |
| `X-Content-Type-Options` | `nosniff` | Prevents MIME-type confusion attacks |
| `X-XSS-Protection` | `1; mode=block` | Legacy XSS filter for older browsers |
| `Referrer-Policy` | `strict-origin-when-cross-origin` | Limits referrer header leakage |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=(self)` | Restricts browser API access |
| `Content-Security-Policy` | `default-src 'self'; script-src 'self' 'unsafe-inline' apis.google.com; connect-src 'self' *.googleapis.com *.firebaseio.com` | Limits resource origins; mitigates XSS |

---

## 6. Data Protection

### 6.1 At-Rest Encryption

All data stored in SOKONI's Firebase infrastructure is encrypted at rest using **AES-256** with Google-managed encryption keys. This applies to:

- Firestore documents (all collections)
- Cloud Storage objects (all buckets)
- Cloud Function environment variables
- Firebase Auth user records

Google-managed encryption keys (GMEK) provide encryption without operational overhead. For collections containing the most sensitive financial data (`payments`, `ledger`, `escrow`), the architecture is designed to accommodate Customer-Managed Encryption Keys (CMEK) as a future upgrade when compliance requirements mandate it.

---

### 6.2 In-Transit Encryption

All communication between SOKONI clients and Firebase infrastructure is encrypted in transit:

- **TLS 1.2 minimum**, TLS 1.3 where supported — enforced by Firebase/Google infrastructure
- No HTTP fallback — all Hosting, Functions, and SDK endpoints reject plain HTTP
- Certificate management is handled by Google — no risk of certificate expiry or misconfiguration
- The `firebase-admin` SDK used in Cloud Functions communicates with Firebase over TLS on Google's internal network backbone

---

### 6.3 Sensitive Field Handling

SOKONI enforces strict rules about how sensitive values are stored in Firestore:

| Data Type | Storage Approach |
|---|---|
| API keys (external services) | Stored as `SHA-256(key)` hash for lookup verification; actual key only in Secret Manager |
| TOTP secrets | Base64-encoded in `securityMFA/{uid}.totpSecret` — not plaintext, not encrypted separately (Firebase at-rest encryption applies) |
| Passkey credentials | Public key only stored in Firestore; private key never leaves the authenticator secure enclave |
| Device fingerprints | `SHA-256(fingerprint_signals)` hash stored — raw signals never persisted |
| M-Pesa private key | Stored exclusively in Firebase Secret Manager; injected into CF at runtime |
| ANTHROPIC_API_KEY | Stored in Firebase Secret Manager; available only to designated AI Cloud Functions |
| User passwords | Never stored — Firebase Auth handles credential storage with bcrypt |
| Payment card data | Never stored — SOKONI does not handle raw card data; all card processing is delegated to IntaSend PCI-compliant vault |
| Backup codes | Stored as `bcrypt(code)` hashes — plaintext is shown to user exactly once and never retained |

---

### 6.4 Data Minimization

SOKONI collects only the data necessary for the stated purpose:

- **User profiles:** Name, email, phone number, and role. No unnecessary demographic data collected at registration.
- **Location data:** GPS coordinates are used for delivery routing and fraud detection. They are not stored indefinitely — delivery coordinates are purged after order completion + 30 days.
- **Device fingerprints:** Stored as SHA-256 hashes. The reconstruction inputs (browser signals) are never persisted. A fingerprint cannot be reversed to reveal the original device characteristics.
- **POS transaction data:** Stored at the item-line level for eTIMS compliance. Customer PII is linked by reference (UID) rather than duplicated across collections.
- **AI interaction logs:** Prompts and responses for KASS AI Concierge are stored for quality improvement. Logs are purged after 90 days. No PII is injected into AI prompts — user context is passed as anonymized structured fields.

---

### 6.5 Backup and Recovery

| Mechanism | Configuration | Recovery Capability |
|---|---|---|
| Firestore PITR (Point-in-Time Recovery) | Enabled on production database | Restore to any second within the last 7 days |
| Firestore exports | Scheduled daily export to Cloud Storage | Long-term archival; manual restore |
| Cloud Storage versioning | Enabled on all buckets | Recover overwritten or deleted objects |
| Firebase Auth backup | Firebase-managed | User records persist independently of Firestore |

---

## 7. Authorization Matrix

The following matrix defines the permitted operations for each role across all major SOKONI collections. Operations are abbreviated as: **R** = Read, **W** = Write (create/update), **D** = Delete, **—** = No access.

| Collection | guest | buyer | cashier | supervisor | manager | owner | admin | super_admin |
|---|---|---|---|---|---|---|---|---|
| `users` (own doc) | — | R/W | R/W | R/W | R/W | R/W | R/W | R/W/D |
| `users` (others) | — | — | — | — | — | — | R/W | R/W/D |
| `products` | R | R | R | R | R/W | R/W | R/W | R/W/D |
| `categories` | R | R | R | R | R | R/W | R/W | R/W/D |
| `sellers` (own) | — | — | R | R | R/W | R/W | R/W | R/W/D |
| `sellers` (others) | — | — | — | — | — | — | R/W | R/W/D |
| `orders` (own) | — | R | R/W | R/W | R/W | R/W | R/W | R/W/D |
| `orders` (all seller) | — | — | R | R/W | R/W | R/W | R/W | R/W/D |
| `payments` | — | R (own) | — | R (branch) | R (branch) | R (store) | R/W | R/W/D |
| `wallets` (own) | — | R | — | R | R | R/W | R/W | R/W/D |
| `ledger` | — | — | — | — | R | R | R/W | R/W/D |
| `posShifts` | — | — | R/W (own) | R/W (branch) | R/W/D (branch) | R/W/D | R/W | R/W/D |
| `posAuditLog` | — | — | R (own) | R (branch) | R (branch) | R | R/W | R/W/D |
| `reviews` | R | R/W (own) | R | R | R/W (respond) | R/W (respond) | R/W/D | R/W/D |
| `notifications` (own) | — | R/W | R/W | R/W | R/W | R/W | R/W | R/W/D |
| `deliveries` | — | R (own) | — | — | R (store orders) | R (store orders) | R/W | R/W/D |
| `drivers` | — | — | — | — | — | — | R/W | R/W/D |
| `subscriptions` (own) | — | R | R | R | R/W | R/W | R/W | R/W/D |
| `loyaltyPoints` (own) | — | R | R | R | R | R | R/W | R/W/D |
| `aiCredits` (own) | — | R | R | R | R | R/W | R/W | R/W/D |
| `mediaAssets` (own) | — | R/W | — | R/W | R/W | R/W | R/W | R/W/D |
| `invoices` (own) | — | R | R | R | R/W | R/W | R/W | R/W/D |
| `securityMFA` (own) | — | R/W | R/W | R/W | R/W | R/W | R | R/W/D |
| `securityDevices` (own) | — | R/W | R/W | R/W | R/W | R/W | R | R/W/D |
| `securityRisk` | — | — | — | — | — | — | R | R/W/D |
| `securityAuditLog` | — | — | — | — | — | R (own store) | R | R |
| `securityAlerts` | — | — | — | — | — | R (own store) | R/W | R/W/D |
| `securityIncidents` | — | — | — | — | — | R (own) | R/W | R/W/D |

**Notes on the matrix:**
- `cashier` and `supervisor` roles are scoped to a registered `branchId`. Cross-branch access is denied at the Security Rules level.
- `owner` role is scoped to their registered `storeId`. Access to other stores is denied.
- `securityAuditLog` has no write permission for any role below `admin`. Write access is reserved exclusively for Cloud Functions using the Admin SDK.
- `super_admin` delete permissions are logged with double-entry audit trail and require MFA step-up confirmation.
- Guest access is limited to public catalogue reads (products, categories, reviews). No write operations are permitted for unauthenticated users.

---

## 8. Fraud Detection Engine

SOKONI's Fraud Detection Engine operates as a real-time, signal-accumulating risk assessment system. It does not rely on static rules alone — it combines multiple behavioral and contextual signals into a composite risk score that drives automated response.

### 8.1 Architecture Overview

```
Trigger Events                    Signal Processors               Actions
─────────────                     ─────────────────               ───────
Payment initiated  ───────────→   Velocity checker      ──→       Allow
Login from new IP  ───────────→   Impossible travel     ──→       Audit log
POS void attempt   ───────────→   Device trust eval     ──→       Step-up
High-value txn     ───────────→   Duplicate detector    ──→       Block
Scheduled sweep    ───────────→   Risk accumulator      ──→       Alert + Incident
```

### 8.2 Real-Time Fraud Signals

| Signal | Detection Method | Risk Points Added |
|---|---|---|
| **Velocity: excessive transactions** | Count transactions per UID in rolling 1-hour window | +20 if > 10 transactions/hour |
| **Velocity: excessive payment failures** | Count failed payment attempts per UID/device | +25 if > 3 failures in 5 minutes |
| **Impossible travel** | Haversine distance check between last known location and current location vs. elapsed time | +40 if >500 km in <2 hours |
| **Duplicate transaction** | Hash of (uid + amount + recipient + timestamp window) checked against recent transactions | +30 if match found within 5-minute window |
| **New device + high value** | First 24 hours on new device with transaction >KES 10,000 | +20 points |
| **IP country mismatch** | Current IP GeoIP country differs from account registration country and prior sessions | +15 points |
| **Unusual session time** | Transaction attempted at 02:00–04:00 local time for account with no prior activity in that window | +10 points |
| **Excessive data reads** | More than 500 Firestore reads by a single UID in 1 minute | +25 points |

### 8.3 Geolocation: Haversine Implementation

SOKONI does not use an external geolocation library for distance calculations in the fraud engine. The haversine formula is implemented inline to eliminate external dependencies and reduce latency:

```javascript
function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 +
            Math.cos(lat1 * Math.PI/180) * Math.cos(lat2 * Math.PI/180) *
            Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}
```

This function is used to compute the great-circle distance in kilometres between two geographic coordinates. In the impossible travel detection context:

- `lat1, lon1`: coordinates from the user's previous session (stored at session start in `securityRisk/{uid}.lastLocation`)
- `lat2, lon2`: coordinates from the current request (extracted from IP GeoIP or device GPS)
- The elapsed time between the two sessions is computed from Firestore timestamps
- If `haversineKm(lat1, lon1, lat2, lon2) / elapsedHours > 900` (km/h, faster than commercial aviation at sustained cruise), an impossible travel flag is raised

---

### 8.4 Risk Score Accumulation and Thresholds

The fraud engine accumulates risk points from all triggered signals into a composite score (0–100):

| Score Range | Classification | Automated Action |
|---|---|---|
| 0–39 | Low risk | Allow request; standard audit entry |
| 40–59 | Moderate risk | Allow with enhanced audit; flag for human review |
| 60–79 | High risk | Require step-up authentication before proceeding |
| 80–100 | Critical | Block request immediately; suspend session; create security incident |

Risk scores decay over time. A score of 80 at 09:00 will decay to approximately 60 by 15:00 if no new signals are generated, allowing for eventual recovery without manual intervention.

---

### 8.5 Automated Hourly Sweep

A Cloud Scheduler job triggers the `fraudSweep` Cloud Function every hour. This function:

1. Queries `securityRisk` for all users with `currentScore > 40`
2. Re-evaluates recent activity patterns against fraud signal definitions
3. Recalculates risk scores incorporating signal decay
4. Escalates unresolved alerts older than 4 hours to `securityIncidents`
5. Closes resolved alerts where risk score has fallen below 30 and no new events have occurred
6. Generates a summary event in `securityAuditLog` with sweep statistics

---

### 8.6 Alert Lifecycle

Security alerts flow through a defined lifecycle:

```
OPEN ──────────────────────────────────→ RESOLVED
  │                                          ↑
  │ (after 4 hours unresolved)              │ (risk cleared, human confirms)
  ↓                                         │
ESCALATED ──→ (assigned to admin) ──→ CONTAINED ──→ RESOLVED
```

| State | Definition | Who Can Advance |
|---|---|---|
| `open` | Alert generated; awaiting review | System (automated) |
| `escalated` | Unresolved after 4 hours; assigned to security admin | System (automated) |
| `contained` | Root cause identified; immediate threat neutralized | Security admin (manual) |
| `resolved` | Full remediation complete; post-incident report filed | Security admin (manual) |

---

## 9. Audit & Compliance

### 9.1 Immutable Audit Log

The `securityAuditLog` collection is SOKONI's tamper-evident record of all security-significant events.

**Immutability enforcement:**
- **Firestore Security Rules deny all client writes** to `securityAuditLog`. No SDK, regardless of user role, can write to this collection.
- All writes are performed exclusively by Cloud Functions using the Firebase Admin SDK with a service account that has the minimum required IAM roles.
- Each audit log entry includes a **SHA-256 hash chain**: `hash(previousEntryHash + currentEntryData)`. Any modification to a past entry breaks the chain and is detectable.
- Documents in `securityAuditLog` have no update or delete rules — only create is permitted (by CFs only). Historic records cannot be altered.

**Standard audit log document schema:**

```json
{
  "timestamp": "Firestore ServerTimestamp",
  "correlationId": "uuid-v4",
  "eventType": "authentication | authorization | payment | dataAccess | adminAction | system | fraud | compliance | session | rateLimitEvent",
  "severity": "debug | info | warning | error | critical",
  "uid": "string (Firebase UID)",
  "role": "string",
  "action": "string (e.g., 'login.success', 'payment.initiated')",
  "resource": "string (e.g., 'payments/abc123')",
  "outcome": "allow | deny | stepUp | audit",
  "ipAddress": "string (hashed for PII reasons)",
  "deviceFingerprint": "string (SHA-256 hash)",
  "riskScore": "number",
  "attributeSnapshot": { /* all 10 ABAC attributes at time of decision */ },
  "chainHash": "string (SHA-256)"
}
```

---

### 9.2 Event Types and Severities

**10 Event Types:**

| Event Type | Examples |
|---|---|
| `authentication` | Login success/failure, MFA verification, passkey ceremony, session creation/revocation |
| `authorization` | Access grant, access deny, step-up challenge issued/completed |
| `payment` | Payment initiated, payment completed, payment failed, refund issued, void |
| `dataAccess` | Financial export accessed, bulk read detected, PII field accessed |
| `adminAction` | Role changed, user suspended, data deleted, secret rotated |
| `system` | CF deployed, security rules updated, index created, scheduled sweep completed |
| `fraud` | Impossible travel detected, velocity threshold exceeded, duplicate transaction blocked |
| `compliance` | Audit log queried by external party, data subject access request processed |
| `session` | Session created, session expired, session forcibly terminated, step-up completed |
| `rateLimitEvent` | Rate limit threshold reached, IP blocked, endpoint throttled |

**5 Severity Levels:**

| Severity | Description | Examples |
|---|---|---|
| `debug` | Detailed trace information; not written to production audit log | Internal timing data |
| `info` | Normal operations; informational | Successful login, payment completed |
| `warning` | Unexpected but non-critical events | Failed MFA attempt, new device login |
| `error` | Operation failed; requires investigation | Payment processing error, CF exception |
| `critical` | Security incident; requires immediate response | Impossible travel, brute force, fraud block |

---

### 9.3 Compliance Mappings

#### PCI-DSS

SOKONI does not store, process, or transmit raw cardholder data (card numbers, CVVs, magnetic stripe). Card processing is fully delegated to IntaSend's PCI-compliant vault. SOKONI's PCI-DSS obligations are limited to the merchant scope:

| PCI-DSS Requirement | SOKONI Control |
|---|---|
| Req 3: Protect stored cardholder data | Not applicable — no card data stored in SOKONI systems |
| Req 4: Encrypt transmission of cardholder data | TLS 1.2+ enforced on all traffic |
| Req 6: Develop and maintain secure systems | Firestore Security Rules, input validation, XSS protection in all CF outputs |
| Req 7: Restrict access by business need | ABAC policy engine; authorization matrix (Section 7) |
| Req 8: Identify and authenticate access | Firebase Auth, MFA enforcement, session management |
| Req 10: Track and monitor all access | Immutable `securityAuditLog`; Cloud Function invocation logs |

#### GDPR / Kenya Data Protection Act (DPA 2019)

SOKONI operates primarily under the Kenya Data Protection Act 2019, with GDPR principles applied as a best-practice baseline:

| Principle | SOKONI Control |
|---|---|
| Data minimization | Only necessary fields collected; device fingerprints hashed; location data time-limited |
| Purpose limitation | AI logs purged after 90 days; delivery coordinates purged after 30 days |
| Access control | ABAC + authorization matrix ensures data is accessed only by authorized roles |
| Breach notification | Incident response playbook (Section 10) includes notification pathway |
| Right to erasure | User deletion CF cascades anonymization across relevant collections |
| Data subject access | `dataAccess` audit event type; admin can export user data on request |

#### ISO 27001 Control Mapping

| Annex A Control Area | SOKONI Implementation |
|---|---|
| A.9: Access Control | ABAC policy engine, authorization matrix, Firebase Security Rules |
| A.10: Cryptography | AES-256 at rest, TLS 1.2+ in transit, HMAC-SHA256 for webhooks and step-up tokens |
| A.12: Operations Security | Cloud Function deployment gating, Secret Manager, audit logging |
| A.13: Communications Security | App Check, HTTPS enforcement, HSTS, webhook signature validation |
| A.14: System Acquisition | Security review required before CF deployment; input validation standards |
| A.16: Incident Management | Incident response playbook (Section 10), alert lifecycle, SOC dashboard |
| A.17: Business Continuity | Firestore PITR, daily exports, multi-region Firebase Auth |
| A.18: Compliance | Audit log immutability, DPA 2019 controls, PCI-DSS merchant scope |

---

### 9.4 Data Retention

| Data Category | Retention Period | Mechanism |
|---|---|---|
| Audit log entries (`securityAuditLog`) | Indefinite | Firestore PITR + no delete rules |
| Security events (`securityAlerts`, `securityIncidents`) | 90 days active; archived indefinitely | Cloud Scheduler archival job |
| Session records | 30 days after session end | TTL-based cleanup CF |
| Device trust records | Until device deregistered or account deleted | Manual or account deletion CF |
| AI interaction logs | 90 days | Scheduled purge CF |
| Delivery GPS coordinates | 30 days after order completion | Scheduled purge CF |
| Payment records | 7 years (statutory requirement) | No deletion rules on `payments` collection |
| Firestore PITR window | 7 days (point-in-time restore) | Google-managed |

---

## 10. Incident Response Playbook

This playbook defines the standard response procedure for five categories of security incidents. Each playbook specifies the detection signals, immediate containment actions, investigation steps, and restoration pathway.

---

### Incident Type 1: Account Takeover

**Definition:** A malicious actor has gained unauthorized access to a SOKONI user or seller account.

**Detection Signals:**
- Impossible travel alert (haversine distance > 500 km / elapsed hours > threshold)
- Device fingerprint change within same session
- MFA bypass attempt detected
- User reports unauthorized access
- Abnormal transaction pattern from established account

**Response Procedure:**

| Step | Action | Owner | Timeframe |
|---|---|---|---|
| 1. Detect | Fraud engine raises `critical` alert in `securityAlerts` | Automated | Immediate |
| 2. Suspend | CF `suspendUser` sets `users/{uid}.suspended = true`; all active tokens invalidated | Automated | < 1 minute |
| 3. Revoke sessions | Firebase Admin `revokeRefreshTokens(uid)` called; all sessions terminated | Automated | < 1 minute |
| 4. Block device | Suspicious device fingerprint added to `securityDevices/{uid}.blockedFingerprints` | Automated | < 2 minutes |
| 5. Notify user | Transactional email sent to verified email address; SMS to verified phone number | Automated | < 2 minutes |
| 6. Create incident | `securityIncidents` document created; alert escalated to admin | Automated | < 2 minutes |
| 7. Investigate | Admin reviews audit log for session, device, payment, and access events | Security admin | < 1 hour |
| 8. Contain | Reverse any unauthorized transactions; contact affected counterparties | Security admin | < 4 hours |
| 9. Restore | Account owner verifies identity via enhanced KYC flow; account reinstated | Security admin | < 24 hours |
| 10. Post-incident | Incident report filed; root cause documented; controls reviewed | Security admin | < 72 hours |

---

### Incident Type 2: Payment Fraud

**Definition:** Fraudulent, unauthorized, or manipulated payment transactions have been detected.

**Detection Signals:**
- Velocity alert: >10 transactions per hour from single UID/device
- Duplicate transaction hash detected within 5-minute window
- Payment amount manipulation detected (client-side amount differs from server-validated amount)
- Chargeback notification received from IntaSend
- Seller reports anomalous payouts

**Response Procedure:**

| Step | Action | Owner | Timeframe |
|---|---|---|---|
| 1. Detect | Velocity checker or duplicate detector raises alert | Automated | Immediate |
| 2. Disable | Payment method flagged as suspended in `payments/{uid}.paymentMethods` | Automated | < 1 minute |
| 3. Block transactions | CF `blockPaymentProcessing(uid)` disables all new payment initiation | Automated | < 1 minute |
| 4. Create incident | Severity `critical` incident created; Finance team notified | Automated | < 2 minutes |
| 5. Investigate payments | Admin queries `payments` collection for affected transactions; correlates with `ledger` | Finance + Security | < 2 hours |
| 6. Hold payouts | Any pending seller payouts held pending investigation | Finance | < 2 hours |
| 7. Contact IntaSend | Initiate chargeback or dispute process where applicable | Finance | < 4 hours |
| 8. Refund if warranted | Legitimate victims refunded via `processRefund` CF | Finance admin | < 24 hours |
| 9. Restore | Payment capabilities restored after root cause confirmed and patched | Security admin | < 48 hours |
| 10. Post-incident | Transaction forensics report filed; fraud rule updated if new pattern identified | Security | < 72 hours |

---

### Incident Type 3: Insider Threat

**Definition:** A SOKONI employee, seller staff member, or privileged user is abusing their access.

**Detection Signals:**
- Privileged role accessing data outside their authorized scope (branch, store, role level)
- Admin accessing `securityAuditLog` in bulk (potential evidence tampering attempt)
- Unusual volume of data exports by a single privileged account
- Manager override codes used at unusual frequency or outside shift hours
- Whistleblower report from another staff member

**Response Procedure:**

| Step | Action | Owner | Timeframe |
|---|---|---|---|
| 1. Detect | Access pattern anomaly alert; bulk read detector triggers | Automated / Human report | Variable |
| 2. Preserve evidence | Audit log snapshot exported to Cloud Storage before any account changes | Security admin | < 30 minutes |
| 3. Lock store/scope | If seller staff: `sellers/{storeId}.locked = true` prevents all store operations | Security admin | < 1 hour |
| 4. Revoke sessions | Target user's refresh tokens revoked; sessions terminated | Security admin | < 1 hour |
| 5. Downgrade role | Custom claims updated to remove elevated role; change logged | Security admin | < 1 hour |
| 6. Freeze account | User account suspended pending investigation | Security admin | < 1 hour |
| 7. Investigate | Full audit log review for affected user, affected collections, time period | Security + Legal | < 24 hours |
| 8. Report to management | Business owner / legal counsel notified with evidence package | Security | < 24 hours |
| 9. Coordinate | If criminal activity suspected: preserve digital forensics; engage law enforcement | Legal | Variable |
| 10. Post-incident | Access control review; principle of least privilege audit | Security | < 2 weeks |

---

### Incident Type 4: Data Breach Attempt

**Definition:** An external attacker or security researcher has identified or attempted to exploit a vulnerability that could expose SOKONI user data.

**Detection Signals:**
- Abnormal Firestore read volume from single IP or UID (>500 reads/minute)
- Security researcher disclosure via responsible disclosure pathway
- Penetration test finding from scheduled audit
- Firestore Security Rules violation log spike
- Cloud Function error rate spike consistent with fuzzing or enumeration

**Response Procedure:**

| Step | Action | Owner | Timeframe |
|---|---|---|---|
| 1. Detect | Read anomaly alert or external report received | Automated / External | Variable |
| 2. Rate limit | IP immediately rate-limited at Firebase App Check level; CF rate limiting activated | Automated / Admin | < 15 minutes |
| 3. Alert security team | `critical` incident created; security admin paged | Automated | < 15 minutes |
| 4. Assess scope | Determine which collections were accessed, how many records, what data was exposed | Security admin | < 2 hours |
| 5. Patch vulnerability | If rule misconfiguration: update Firestore Security Rules and redeploy immediately | Engineering | < 4 hours |
| 6. Pen test | If researcher-reported: reproduce finding in staging; validate fix | Security + Engineering | < 8 hours |
| 7. Notify affected users | If PII was exposed: notification within 72 hours per DPA 2019 requirements | Legal + Security | < 72 hours |
| 8. Regulator notification | If breach meets reporting threshold: notify Office of Data Protection Commissioner | Legal | < 72 hours |
| 9. Researcher acknowledgment | If responsible disclosure: acknowledge, thank researcher, consider bug bounty | Security | < 1 week |
| 10. Post-incident | Security rules audit; pen test of adjacent attack surface | Security | < 2 weeks |

---

### Incident Type 5: DDoS / Rate Limit Bypass

**Definition:** The platform is under sustained high-volume attack that degrades availability, or an attacker has found a way to bypass SOKONI's rate limiting controls.

**Detection Signals:**
- Cloud Function invocation count exceeds normal baseline by >10x
- `rateLimitEvent` entries in audit log spike for single IP range or user agent
- Firebase Hosting response latency increases significantly
- SmartPOS terminals report connectivity failures (downstream effect)
- Unusual geographic concentration of traffic from unexpected regions

**Response Procedure:**

| Step | Action | Owner | Timeframe |
|---|---|---|---|
| 1. Detect | Rate limit event spike detected; monitoring alert fires | Automated | Immediate |
| 2. Firebase rate limiting | Firebase App Check and Cloud Armor (if configured) throttle identified sources | Automated | < 5 minutes |
| 3. Incident created | `critical` incident created; DevOps and Security alerted | Automated | < 5 minutes |
| 4. Identify attack vector | Analyze CF invocation logs to identify targeted endpoints and source patterns | DevOps | < 30 minutes |
| 5. IP block | Identified abusive IP ranges blocked at Cloud Armor or App Check level | DevOps | < 1 hour |
| 6. Scale review | Assess whether CF quotas need temporary increase to maintain availability | DevOps | < 1 hour |
| 7. Harden endpoint | If specific endpoint targeted: add additional rate limiting, require stronger App Check attestation | Engineering | < 4 hours |
| 8. Monitor recovery | Confirm normal traffic patterns restored; remove temporary blocks after 24 hours if appropriate | DevOps | < 24 hours |
| 9. Post-incident | Review CF concurrency limits; evaluate Cloud Armor WAF rules; assess Cloudflare integration | DevOps + Security | < 1 week |

---

## 11. Security Scorecard Methodology

SOKONI maintains a continuous **Security Scorecard** that quantifies the platform's overall security posture across 15 dimensions. The score is recalculated after every significant security event and on each hourly automated sweep. A perfect score of 100 indicates all controls are active, properly configured, and passing with no open incidents.

| # | Dimension | Weight | Perfect Score Criteria |
|---|---|---|---|
| 1 | **Authentication Strength** | 10 pts | >90% of high-privilege accounts (manager and above) have MFA enrolled and verified in the last 30 days |
| 2 | **Session Security** | 8 pts | No sessions older than 4 hours for privileged roles; average session risk score below 30 |
| 3 | **Device Trust Coverage** | 7 pts | >80% of active sessions are on devices with trust score ≥ 0.7 |
| 4 | **Firestore Rules Coverage** | 10 pts | All collections have explicit Security Rules; no collection relies on `allow read, write: if true`; rules last reviewed within 30 days |
| 5 | **App Check Enforcement** | 8 pts | App Check hard-enforced on all CFs, Firestore, and Storage; no debug tokens active in production |
| 6 | **Secret Management** | 8 pts | All secrets in Firebase Secret Manager; no plaintext secrets in codebase, Firestore, or `.env` files; secrets rotated within policy period |
| 7 | **Audit Log Integrity** | 7 pts | SHA-256 chain unbroken across all audit log entries; no gaps in chain hashes; log volume consistent with activity |
| 8 | **Open Incident Count** | 8 pts | Zero open `critical` incidents; zero incidents in `escalated` state older than 8 hours |
| 9 | **Fraud Signal Health** | 7 pts | No users with risk score >80 who are not already suspended; fraud sweep completed successfully in last 2 hours |
| 10 | **Rate Limit Configuration** | 6 pts | All public-facing CFs have rate limiting enabled; no rate limit bypass events in last 24 hours |
| 11 | **Data Minimization Compliance** | 6 pts | No PII found in collections that should not contain it; AI log purge job last ran within 24 hours; delivery coordinate purge current |
| 12 | **Encryption Compliance** | 7 pts | No plaintext sensitive fields found in Firestore spot-check; PITR active; all buckets have no public access |
| 13 | **Dependency Vulnerability Status** | 6 pts | No critical CVEs in deployed Cloud Function dependencies; `npm audit` clean or with only dev-dependency issues |
| 14 | **Security Headers Coverage** | 4 pts | All Hosting responses include HSTS, X-Frame-Options, X-Content-Type-Options, and CSP headers; no missing headers in spot-check |
| 15 | **Incident Response Readiness** | 8 pts | Incident response playbook reviewed within 90 days; all admin accounts have valid contact information; escalation paths tested within 30 days |

**Score interpretation:**

| Score | Status | Required Action |
|---|---|---|
| 90–100 | Excellent | Maintain current posture; scheduled review only |
| 75–89 | Good | Review flagged dimensions; remediate within 2 weeks |
| 60–74 | Fair | Immediate remediation plan required; escalate to CTO |
| 40–59 | Poor | Emergency security review; consider feature freeze pending remediation |
| 0–39 | Critical | Immediate incident response; executive notification required |

---

## 12. Architecture Diagram

The following diagram illustrates the complete Zero Trust request flow from a user device through all security layers to a protected resource.

```
╔══════════════════════════════════════════════════════════════════════════════╗
║                        SOKONI ZERO TRUST ARCHITECTURE                       ║
╚══════════════════════════════════════════════════════════════════════════════╝

  ┌─────────────────────────────────────────────────────────────────────────┐
  │                         USER DEVICES                                    │
  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌────────────┐ │
  │  │  Web Browser │  │  Android App │  │    iOS App   │  │  SmartPOS  │ │
  │  │  (ReCaptcha) │  │(Play Intgty) │  │(DeviceCheck) │  │ Terminal   │ │
  └──┴──────┬───────┴──┴──────┬───────┴──┴──────┬───────┴──┴─────┬──────┘─┘
             │                 │                  │                │
             └─────────────────┴──────────────────┴────────────────┘
                                        │
                                   HTTPS / TLS 1.2+
                                        │
  ┌─────────────────────────────────────▼───────────────────────────────────┐
  │                    LAYER 1: FIREBASE APP CHECK                          │
  │                                                                         │
  │   ┌───────────────────────────────────────────────────────────────┐    │
  │   │  Attestation Token Validation                                  │    │
  │   │  • ReCaptcha v3 (web) • Play Integrity (Android)              │    │
  │   │  • DeviceCheck (iOS)  • Debug tokens BLOCKED in production    │    │
  │   └───────────────────────────────────────────────────────────────┘    │
  │                                                                         │
  │   ❌ No valid attestation → 403 FORBIDDEN (request ends here)          │
  └─────────────────────────────────────┬───────────────────────────────────┘
                                        │  ✓ App Check passed
  ┌─────────────────────────────────────▼───────────────────────────────────┐
  │                  LAYER 2: FIREBASE AUTHENTICATION + MFA                 │
  │                                                                         │
  │   ┌─────────────────┐  ┌────────────────┐  ┌────────────────────────┐  │
  │   │  ID Token       │  │  MFA Check     │  │  Session Risk Score    │  │
  │   │  Verification   │  │  TOTP / SMS /  │  │  Device Trust          │  │
  │   │  (Admin SDK)    │  │  Passkey       │  │  Location Consistency  │  │
  │   └────────┬────────┘  └───────┬────────┘  └────────────┬───────────┘  │
  │            │                   │                          │              │
  │            └───────────────────┴──────────────────────────┘             │
  │                                        │                                │
  │   ❌ Invalid/expired token → 401 UNAUTHORIZED                          │
  │   ❌ MFA gate failed (financial ops) → 403 FORBIDDEN                   │
  │   ❌ Session risk > 80 → SUSPENDED                                     │
  └─────────────────────────────────────┬───────────────────────────────────┘
                                        │  ✓ Identity verified
  ┌─────────────────────────────────────▼───────────────────────────────────┐
  │                   LAYER 3: ZERO TRUST POLICY ENGINE (ABAC)             │
  │                                                                         │
  │   Attributes evaluated per request:                                     │
  │   ┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌──────────────┐ │
  │   │ Role (0–5)   │ │Device Trust  │ │Session Age   │ │MFA Enrolled  │ │
  │   └──────────────┘ └──────────────┘ └──────────────┘ └──────────────┘ │
  │   ┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌──────────────┐ │
  │   │ Risk Score   │ │ Branch ID    │ │ Shift Active │ │ Txn Value    │ │
  │   └──────────────┘ └──────────────┘ └──────────────┘ └──────────────┘ │
  │   ┌──────────────┐ ┌──────────────┐                                    │
  │   │ IP Country   │ │Correlation ID│                                    │
  │   └──────────────┘ └──────────────┘                                    │
  │                                                                         │
  │   Decision: ALLOW │ ALLOW+AUDIT │ REQUIRE STEP-UP │ DENY               │
  └──────────┬──────────────────────────────┬──────────────────────────────┘
             │ ALLOW / ALLOW+AUDIT           │ REQUIRE STEP-UP
  ┌──────────▼──────────────────┐  ┌────────▼────────────────────────────┐
  │   LAYER 4: CLOUD FUNCTIONS  │  │    STEP-UP AUTHENTICATION           │
  │   (Business Logic)          │  │    HMAC-SHA256 challenge             │
  │                             │  │    10-minute expiry                 │
  │  • Input validation         │  │    TOTP | SMS | Passkey             │
  │  • Payment idempotency      │  └────────────────────────────────────┘
  │  • Rate limiting            │
  │  • Webhook HMAC validation  │
  │  • Correlation ID threading │
  └──────────┬──────────────────┘
             │
  ┌──────────▼──────────────────────────────────────────────────────────────┐
  │              LAYER 5: FIRESTORE (Security Rules Enforced)               │
  │                                                                         │
  │  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐ ┌─────────────────┐  │
  │  │  payments   │ │   orders    │ │   sellers   │ │  securityAudit  │  │
  │  │  (CF-write) │ │  (CF-write) │ │  (role gate)│  │  Log (CF-only)  │  │
  │  └─────────────┘ └─────────────┘ └─────────────┘ └─────────────────┘  │
  │                                                                         │
  │  AES-256 at-rest encryption │ PITR enabled │ No public collections     │
  └──────────┬──────────────────────────────────────────────────────────────┘
             │  (write to audit log on every significant operation)
  ┌──────────▼──────────────────────────────────────────────────────────────┐
  │                 LAYER 6: SECURITY OPERATIONS CENTER                     │
  │                                                                         │
  │  ┌─────────────────────────────────────────────────────────────────┐   │
  │  │  securityAuditLog (immutable, SHA-256 chain)                    │   │
  │  │  securityAlerts   (open → escalated → contained → resolved)    │   │
  │  │  securityIncidents (full incident lifecycle)                    │   │
  │  │  securityRisk      (per-user rolling risk score)                │   │
  │  └─────────────────────────────────────────────────────────────────┘   │
  │                                                                         │
  │  ┌─────────────────────────┐   ┌────────────────────────────────────┐  │
  │  │  Fraud Detection Engine │   │  Hourly Automated Sweep            │  │
  │  │  • Haversine travel     │   │  (Cloud Scheduler → fraudSweep CF) │  │
  │  │  • Velocity check       │   └────────────────────────────────────┘  │
  │  │  • Duplicate detect     │                                            │
  │  │  • Risk accumulator     │   ┌────────────────────────────────────┐  │
  │  └─────────────────────────┘   │  Security Scorecard (15 dimensions)│  │
  │                                └────────────────────────────────────┘  │
  └─────────────────────────────────────────────────────────────────────────┘
```

---

## 13. Deployment Security Requirements

All production deployments of SOKONI must satisfy the following security requirements. These are not aspirational guidelines — they are hard gates. A deployment that violates any of these requirements is considered insecure and must not serve production traffic.

---

### 13.1 Secret Management

**Requirement:** All secrets must be stored in Firebase Secret Manager. No exceptions.

| Prohibited Storage Location | Why It Is Prohibited |
|---|---|
| Source code (hardcoded) | Secrets committed to git are permanently exposed, even after removal |
| `.env` files committed to git | Same exposure risk; `.env` files must be in `.gitignore` |
| Firestore documents | Client-accessible; Security Rules cannot protect secrets from CF reads |
| Cloud Function environment variables (plaintext) | Visible in GCP Console to anyone with project access |
| Client-side code (JavaScript bundles) | Trivially extractable by any user who opens DevTools |

**Correct pattern:** All secrets are stored in Firebase Secret Manager and accessed at runtime via `defineSecret()` in Cloud Function definitions. The secret value is injected into the CF execution environment and is never written to logs or passed in response payloads.

**Required secrets in Secret Manager:**

| Secret Name | Purpose |
|---|---|
| `INTASEND_SECRET_KEY` | IntaSend payment gateway authentication |
| `ANTHROPIC_API_KEY` | Claude AI API access for KASS and AI features |
| `SENDGRID_API_KEY` | Transactional email delivery |
| `WEBHOOK_SIGNING_SECRET` | HMAC-SHA256 verification for incoming webhooks |
| `ETIMS_AES_KEY` | AES-256-GCM encryption for eTIMS credential storage |
| `TOTP_ENCRYPTION_KEY` | Encryption key for TOTP secret backup |
| `REDIS_URL` | Redis connection string (contains credentials) |

---

### 13.2 Service Account Permissions

The Firebase Admin SDK service account used by Cloud Functions must have only the permissions required for its specific operations. The principle of least privilege applies.

**Required IAM roles:**

| IAM Role | Purpose |
|---|---|
| `roles/datastore.user` | Read and write Firestore documents |
| `roles/firebase.admin` | Manage Firebase Auth users and custom claims |
| `roles/secretmanager.secretAccessor` | Read secrets at runtime |
| `roles/storage.objectAdmin` | Read and write Cloud Storage objects |
| `roles/cloudscheduler.jobRunner` | Invoke scheduled Cloud Functions |

**Explicitly not granted:**

- `roles/owner` — No service account should have owner permissions
- `roles/editor` — Overly broad; use specific roles only
- `roles/iam.admin` — Service accounts must not be able to manage their own permissions
- `roles/cloudfunctions.admin` — CF deployment is a human + CI/CD action, not a runtime action

---

### 13.3 Firebase App Check Configuration

| Platform | Provider | Debug Tokens in Production |
|---|---|---|
| Web (mysokoni.co.ke) | reCAPTCHA v3 | NEVER — debug tokens must be deleted before production deploy |
| Android (SOKONI app) | Play Integrity | NEVER |
| iOS (SOKONI app) | DeviceCheck | NEVER |

App Check enforcement mode must be set to **enforce** (not **monitor**) for all three services: Cloud Functions, Firestore, and Cloud Storage.

Debug tokens are permitted only in development and staging Firebase projects. If a debug token is found active in the production Firebase project, it must be immediately revoked and an audit log entry created.

---

### 13.4 ANTHROPIC_API_KEY Scoping

The `ANTHROPIC_API_KEY` is scoped exclusively to the Cloud Functions that require AI capabilities:

- `sokoniChat` (KASS AI Concierge)
- `generateProductDescription` (AI product listing)
- `aiCoach` (Merchant Success AI Coach)
- `generateInsight` (Analytics AI insights)

The key is NOT available to:
- Client-side JavaScript
- Any other Cloud Function not in the list above
- Firebase Hosting rewrites
- Any external service

Anthropic API usage is monitored via Cloud Function logs. Unexpected usage spikes trigger a security alert.

---

### 13.5 Cloud Storage Access Policy

| Bucket | Public Access | Authenticated Access | Notes |
|---|---|---|---|
| Product images | Public read (specific paths only) | Authenticated write | Read allowed for product display; write requires seller role |
| User profile photos | Public read (specific paths only) | Authenticated write | Same pattern as product images |
| AI generated media | Private | Authenticated read/write | No public access |
| Audit log exports | Private | Admin-only | No public access; IAM-controlled |
| eTIMS documents | Private | CF-only write; admin read | Sensitive compliance documents |
| Firestore exports | Private | Admin + GCP Console | Backup storage; no client access |

No SOKONI Cloud Storage bucket has `allUsers` or `allAuthenticatedUsers` bucket-level IAM bindings. Public read for specific paths is implemented at the object level, not the bucket level.

---

### 13.6 Firestore PITR

Point-in-Time Recovery must be enabled on the production Firestore database before any user data is written. PITR provides a 7-day rolling window for restore to any second.

**Verification command:**
```bash
gcloud firestore databases describe --database="(default)" \
  --format="value(pointInTimeRecoveryEnablement)"
```

Expected output: `POINT_IN_TIME_RECOVERY_ENABLED`

PITR status is checked as part of the hourly automated sweep and included in the Security Scorecard (Dimension 12: Encryption Compliance).

---

## 14. Known Limitations & Roadmap

This section documents security controls that are either partially implemented, have known gaps, or are planned for a future sprint. Transparency about current limitations is a prerequisite for improving them.

---

| # | Limitation | Current State | Planned Improvement | Target |
|---|---|---|---|---|
| 1 | **Customer-Managed Encryption Keys (CMEK)** | Firestore uses Google-managed encryption keys (GMEK). Adequate for current compliance requirements, but does not give SOKONI cryptographic control over key rotation and revocation. | Migrate sensitive collections (`payments`, `ledger`, `securityAuditLog`) to CMEK using Cloud KMS. This enables key revocation to instantly render data inaccessible and satisfies higher-tier compliance requirements. | Q1 2027 |
| 2 | **Cloud Armor WAF** | Firebase Hosting and Cloud Functions are not currently behind Cloud Armor. DDoS mitigation relies on Firebase's built-in rate limiting and App Check. | Deploy Cloud Armor in front of Cloud Functions endpoints to provide IP reputation filtering, geo-blocking for high-risk jurisdictions, and OWASP top-10 rule enforcement. | Q3 2026 |
| 3 | **Penetration Testing Cadence** | No formally scheduled third-party penetration tests. Security reviews are performed internally as part of each sprint. | Engage a Kenyan or international security firm for an annual black-box penetration test of the full platform. Establish a responsible disclosure programme with a coordinated vulnerability disclosure (CVD) policy. | Q4 2026 |
| 4 | **Hardware Security Module (HSM) for Signing** | Webhook HMAC secrets and step-up challenge tokens are signed using software-based HMAC-SHA256 with keys stored in Secret Manager. Secret Manager provides strong protection but is not an HSM. | Integrate Cloud HSM (via Cloud KMS) for cryptographic signing operations on the most sensitive workflows: payment webhook validation, step-up token issuance, and audit log chain hashing. | Q2 2027 |
| 5 | **Biometric Authentication for SmartPOS** | The Manager Authorization Engine supports biometric as an authorization method type in the schema, but the SmartPOS hardware integration for device-bound biometric is not yet implemented end-to-end. | Complete biometric integration with supported SmartPOS hardware (fingerprint reader module). Bind biometric to the device's secure enclave via WebAuthn `authenticatorAttachment: "platform"`. | Q3 2026 |
| 6 | **AI Prompt Injection Defense** | KASS AI Concierge and other AI features pass structured context to Claude. Input sanitization is applied, but no formal prompt injection red-teaming has been conducted. | Establish a prompt injection test suite covering common injection payloads. Implement a prompt guardrail layer that validates AI outputs before returning them to the client. Test against the OWASP LLM Top 10. | Q4 2026 |
| 7 | **Audit Log External SIEM Integration** | The `securityAuditLog` is queryable via the Security Operations Center dashboard but is not streamed to an external SIEM (Security Information and Event Management) platform. This limits correlation with external threat intelligence. | Stream `securityAuditLog` events to an external SIEM (Google Chronicle or Elastic SIEM) via Firestore triggers + Pub/Sub. This enables cross-platform threat correlation, anomaly detection with external threat feeds, and centralised alerting. | Q1 2027 |
| 8 | **Redis Security** | The Redis layer uses a connection URL stored in Secret Manager (`REDIS_URL`). Redis is not deployed with TLS enabled on the connection, relying on network-level isolation. All Redis data has TTL bounds, but no field-level encryption is applied to cached values. | Enable Redis TLS (TLS 1.2+) on the connection string. Evaluate field-level encryption for any cached values that contain user identifiers or session tokens. Consider Redis AUTH password rotation on a 90-day schedule. | Q3 2026 |
| 9 | **Supply Chain Security** | Node.js dependencies in Cloud Functions are managed with `npm`. There is no automated software composition analysis (SCA) tool actively scanning for CVE-affected packages in CI/CD. | Integrate `npm audit` into the CI/CD pipeline as a blocking gate. Evaluate Dependabot or Snyk for automated pull requests on dependency updates with security fixes. Sign Cloud Function deployment artifacts. | Q3 2026 |
| 10 | **Session Binding to Network** | Firebase ID tokens are bearer tokens. A stolen token can be used from any network location until it expires (max 1 hour). While device trust and session risk scoring mitigate this, there is no cryptographic binding of the token to the originating network or device. | Implement token binding using a device-side challenge that must be presented alongside the ID token for sensitive operations. This ensures a stolen token is not usable without the originating device. WebAuthn assertions are the preferred mechanism. | Q2 2027 |

---

*This document is a living security reference. It must be updated whenever a security control is changed, a new threat is identified, or a roadmap item is completed or reprioritized. The version number must be incremented and a changelog entry created for every substantive change.*

*Last updated: 2026-06-28 by SOKONI Platform Security*
