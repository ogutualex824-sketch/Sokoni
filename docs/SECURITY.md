# SECURITY.md

# SOKONI Security Architecture

Version: 2.0
Date: 2026-06-20

Related: [[ARCHITECTURE]] [[docs/API]] [[docs/WEBHOOK]]

---

## Overview

SOKONI implements a seven-layer defence-in-depth security model. Each layer independently prevents or detects attacks so that a bypass at one layer does not compromise the system.

```
Layer 1 — Network / CDN (Firebase Hosting headers, HSTS, CORS)
Layer 2 — Firebase Authentication (JWT custom claims, session TTL)
Layer 3 — Firestore Security Rules (field-level, role-based, uid-frozen)
Layer 4 — Cloud Functions (Admin SDK, server-side validation, secrets)
Layer 5 — Webhook Integrity (HMAC-SHA256, replay window, idempotency)
Layer 6 — Fraud Engine (velocity, blocklist, risk scoring)
Layer 7 — Observability (audit log, security events, alerting)
```

---

## Layer 1 — Network & Transport

### HTTP Security Headers (firebase.json)

| Header | Value |
|---|---|
| `Strict-Transport-Security` | `max-age=63072000; includeSubDomains; preload` |
| `X-Frame-Options` | `DENY` — prevents clickjacking |
| `X-Content-Type-Options` | `nosniff` — prevents MIME sniffing |
| `Referrer-Policy` | `strict-origin-when-cross-origin` |
| `Cross-Origin-Resource-Policy` | `same-origin` |
| `Cross-Origin-Opener-Policy` | `same-origin-allow-popups` |
| `Permissions-Policy` | Restricts camera, microphone, geolocation, interest-cohort |

### Content Security Policy

Current CSP includes `'unsafe-inline'` and `'unsafe-eval'` to support legacy inline scripts. **Scheduled for removal in the CSP hardening sprint** (30-day roadmap). Migration path: extract inline scripts to external `.js` files, adopt nonce-based CSP.

### CORS

- `sokoniChat` limited to `https://mysokoni.co.ke` and `https://sokoni-aeb26.web.app`
- `webhookSmartpos` limited to `https://mysokoni.co.ke` origin
- All other webhook endpoints: `cors: false`

---

## Layer 2 — Firebase Authentication

### Admin Identity

Admin status is determined **exclusively** by Firebase JWT custom claim:

```
request.auth.token.admin == true
```

This claim is set only by:
- `bootstrapAdminClaim` (one-time, founder email only)
- `grantAdminClaim` (existing admin only)
- `revokePlatformRole` / `grantPlatformRole`

The client-side `sokoni-security.js` explicitly does **not** copy any `isAdmin` field from localStorage to the session object. The comment at `sokoni-security.js:76` explains this design decision.

### Role Hierarchy

```
superAdmin > admin > moderator > seller/driver/provider > buyer > guest
```

All roles are verified server-side via Firestore rules helper functions:
- `isSuperAdmin()` — `request.auth.token.superAdmin == true`
- `isAdmin()` — `request.auth.token.admin == true`
- `isModerator()` — `request.auth.token.moderator == true`
- `isAuthed()` — `request.auth != null`
- `isOwner()` — `request.auth.uid == resource.data.uid`

### Session Management

- 24-hour TTL enforced client-side in `sokoni-security.js`
- Device ID bound to session (localStorage)
- Firebase Auth token rotation handled by Firebase SDK automatically

---

## Layer 3 — Firestore Security Rules (1922 lines)

### Core Helpers

| Helper | Purpose |
|---|---|
| `noAdminFields()` | Blocks client writes to `isAdmin`, `role`, `commissionRate`, `verified`, `banned`, `superAdmin`, `moderator` |
| `noPrivilegeEscalation()` | Prevents role promotion via client writes |
| `uidUnchanged()` | Freezes `uid` field on every update — prevents ownership takeover |
| `validPrice()` | Enforces `price >= 0` and numeric type on product prices |
| `validOrderStatus()` | Restricts order status transitions to defined set |

### Critical Collection Rules

**payments** — Payment status update is `allow update: if false`. Only Cloud Functions via Admin SDK can set status to COMPLETE or FAILED. Clients cannot self-approve payments.

**subscriptions** — `allow write: if false`. Subscription grants flow exclusively through `activateSubscription` Cloud Function after server-verified payment.

**wallets** — Top-up blocked client-side: `balance <= resource.data.balance` constraint. Clients can only decrease balance. Top-ups require M-Pesa webhook → Cloud Function confirmation path.

**escrows** — Create: buyer only, `buyerUid == request.auth.uid`. Update: limited to `status` and `updatedAt` fields by buyer or seller. Full write: admin SDK only.

**adminLog** — `allow update: if false` — append-only. Only `isSuperAdmin()` can delete entries.

**fraudBlocklist, webhookLogs, paymentLedger, settlements, clientMetrics, platformMetrics** — `allow write: if false` — exclusively written by Cloud Functions via Admin SDK.

---

## Layer 4 — Cloud Functions

### Secret Management

All sensitive keys are stored as Firebase Function Secrets via `defineSecret()`:

| Secret | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` | KASS + sokoniChat AI |
| `INTASEND_PRIVATE_KEY` | B2C seller payouts via IntaSend |
| `AT_API_KEY` | Africa's Talking SMS |
| `AT_USERNAME` | Africa's Talking account |

Secrets are **never** written to `firebase.json`, environment files, or source code. The CI pipeline scans for `ISPrivKey_live_`, `sk_live_`, `pk_live_` patterns and fails the build on detection.

### Admin-Only Functions

These Cloud Functions verify `request.auth.token.admin === true` before execution:

- `getSettlementReport`
- `initiateSellerPayout`
- `getLedgerBalance`
- `fraudBlock`
- `replayWebhookDLQ`
- `getPlatformMetrics`
- `grantAdminClaim` / `revokeAdminClaim`
- `grantPlatformRole` / `revokePlatformRole`
- `kassAdmin` (KASS AI agent)

### Input Sanitization

`sokoni-gateway.js` sanitizes all inputs before forwarding to Cloud Functions:
- HTML entity encoding (XSS prevention)
- SQL metacharacter stripping (injection prevention)
- Schema validation before dispatch
- Rate limiting by operation type (client-side, 2–20 req/s depending on type)

---

## Layer 5 — Webhook Security

### HMAC-SHA256 Signature Verification

IntaSend and Stripe webhooks verify the provider signature using timing-safe comparison:

```js
const expected = "sha256=" + HMAC_SHA256(rawBody, secretKey);
crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
```

If verification fails:
- Respond 200 (to prevent provider retries and timing information leakage)
- Log `invalid_signature` to `webhookLogs`
- Do not process the event

### M-Pesa IP Allowlisting

Daraja does not provide webhook signatures. The `webhookMpesa` Cloud Function enforces an IP allowlist of Safaricom's published Daraja IP ranges. Non-Safaricom callers receive 403 and are logged to `webhookLogs` with `status: "ip_blocked"`.

### Replay Protection

All webhooks enforce a 5-minute timestamp window. Events older than 5 minutes are silently dropped and logged.

### Idempotency

Every webhook is keyed by `{provider}::{eventId}` in `webhookIdempotency`. Duplicate events are detected and skipped before any processing occurs.

### Dead-Letter Queue (DLQ)

Failed webhook processing writes to `webhookDLQ`. Admin can replay via `replayWebhookDLQ` Cloud Function. DLQ depth is exposed at `/webhookHealth` endpoint.

---

## Layer 6 — Fraud Detection

### Real-Time Risk Scoring (0–100)

| Signal | Score | Trigger |
|---|---|---|
| `blocked_uid` | +100 | UID in `fraudBlocklist` |
| `velocity_high` | +40 | 3+ payments in 5 minutes |
| `velocity_medium` | +20 | 8+ payments in 1 hour |
| `amount_large` | +15 | Amount > KES 500,000 |

### Decision Thresholds

| Score | Decision |
|---|---|
| 0–30 | allow |
| 31–60 | review (proceed but flag for manual review) |
| 61–100 | block (reject payment, log to `fraudLog`) |

### Blocklist

`fraudBlock` Cloud Function (admin only) adds entities to `fraudBlocklist` by UID, phone, email, or IP. Blocked accounts are auto-suspended in the `users` collection.

### Client-Side Pre-Check

`sokoni-fraud-engine.js` performs a lightweight client-side check before calling the payment Cloud Function. The server always performs its own independent check — the client check is UX only and cannot be bypassed to reach the server.

---

## Layer 7 — Observability & Audit

### Audit Log

Every payment operation, admin action, and security event writes to `auditLogs`:

```js
{
  type:      "escrow_released",   // or: admin_grant, fraud_block, refund_initiated
  callerUid: "uid_abc123",
  targetUid: "uid_xyz789",        // where applicable
  ref:       "REL-1234-ABCD",
  amount:    5000,
  ts:        Timestamp
}
```

`auditLogs` is append-only (`allow update: if false`). Only `isSuperAdmin()` can delete entries.

### Security Events

High-severity events (fraud blocks, failed auth attempts, IP blocks) are written to `securityEvents`. The KASS admin AI can query this collection via the `getSecurityEvents` tool.

### CI Secret Scanning

`ci.yml` scans all JS and HTML files for patterns:
- `ISPrivKey_live_` (IntaSend private key)
- `sk_live_` (Stripe secret key)
- `pk_live_` (Stripe publishable key, if used server-side)

Detection fails the build immediately.

---

## OWASP Top 10 Mapping

| OWASP | Risk | SOKONI Mitigation |
|---|---|---|
| A01 — Broken Access Control | Privilege escalation | `noAdminFields()`, `uidUnchanged()`, admin claim via JWT only |
| A02 — Cryptographic Failures | Key exposure | `defineSecret()`, CI secret scan, HSTS preload |
| A03 — Injection | XSS, NoSQL injection | Gateway sanitization, Firestore typed queries, CSP |
| A04 — Insecure Design | Business logic abuse | Escrow model, server-only payment confirmation, fraud engine |
| A05 — Security Misconfiguration | Headers, CORS | Full security header suite, CORS restriction per endpoint |
| A06 — Vulnerable Components | Dependency exploits | `npm audit --audit-level=high` in CI (blocking) |
| A07 — Auth Failures | Session hijacking | Firebase Auth JWT, 24h TTL, device binding |
| A08 — Software Integrity | Supply chain | CI dependency audit, no arbitrary CDN script loading |
| A09 — Logging Failures | No audit trail | `auditLogs` (append-only), `webhookLogs`, `securityEvents` |
| A10 — SSRF | Server-side request forgery | No user-controlled URLs in Cloud Functions |

---

## Known Limitations & Scheduled Fixes

| Item | Status | Scheduled |
|---|---|---|
| CSP `unsafe-inline` / `unsafe-eval` | Open | 30-day sprint |
| DPA (Kenya Data Protection Act) consent management | Open | 30-day sprint |
| Multi-region deployment | Open | 60-day sprint |
| eTIMS live integration | Open | 90-day sprint |
| Cookie consent banner | Open | 30-day sprint |

---

## Related Documents

- [[ARCHITECTURE]] — Full system architecture
- [[docs/API]] — Cloud Functions API reference
- [[docs/WEBHOOK]] — Webhook integration guide
- [[CHANGELOG]] — Security change history
