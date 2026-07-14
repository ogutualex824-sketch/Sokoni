# SOKONI Security Guide

**Platform:** SOKONI  
**Legal Entity:** Bravilex International Co. Limited  
**Classification:** Internal — Confidential  
**Last Reviewed:** 2026-07-13  
**Overall Security Score:** 83/100

---

## Security Architecture

SOKONI implements a defence-in-depth security model:

```
Client (App Check + reCAPTCHA v3)
    ↓
Firebase Hosting (HTTPS only, CSP headers)
    ↓
Firebase App Check (token validation on all CF calls)
    ↓
Cloud Functions (rate limiting + input validation)
    ↓
Firestore Security Rules (auth + ownership + field-level)
    ↓
Admin SDK (bypasses rules — server-only, trusted code)
```

---

## Authentication

### Supported Methods
- Email + Password
- Google OAuth
- Phone (OTP via SMS)
- Facebook OAuth

### Session Security
- Firebase ID tokens (1-hour expiry, auto-refreshed)
- `Remember Me` uses Firebase persistence
- Cross-provider account linking supported
- Admin claims set server-side via Admin SDK only — never client-writable

### Admin Field Protection
The following fields are protected by `noAdminFields()` in Firestore rules and cannot be written by authenticated clients:
```
isAdmin, suspended, banned, adminApproved, featured, verified,
flagged, adminNote, role, approved, approvedAt, approvedBy,
commissionRate
```

---

## App Check

- **Provider:** reCAPTCHA v3 (`sokoni-appcheck.js`)
- **Enforcement:** Must be ENABLED (not audit mode) in Firebase Console for:
  - Cloud Functions
  - Firestore
  - Cloud Storage
- **Debug tokens:** Bootstrap via `localStorage` only; never committed to source
- **Auto-refresh:** Enabled

> Before go-live: confirm App Check enforcement is ON (not audit/monitoring mode) in the Firebase Console for all three services.

---

## Firestore Security Rules

### Key Principles
- All writes require `request.auth != null`
- Financial collections (`payments`, `wallets`, `commissionLedger`, `sellerPayments`) use `allow write: if false` — writable only via Admin SDK in Cloud Functions
- `sellerId` must equal `request.auth.uid` in all POS rules
- Privilege escalation blocked by `noPrivilegeEscalation()`

### Known Issues (Fix Before Go-Live)

**CRITICAL — F-1: Duplicate conversations write block**
- Location: `firestore.rules` lines 511–521 and 3058–3081
- Issue: Second block defeats the `allow create: if false` intent; clients can write messages directly
- Fix: Remove the duplicate block at 3058–3081 and merge its validations into the canonical block at 511

**HIGH — F-2: deliveryLocations GPS privacy**
- Location: `firestore.rules` line 1183–1193
- Issue: Any authenticated user can read real-time GPS of any rider
- Fix: Scope read to `isAdmin() || riderId == request.auth.uid` minimum; full fix requires `viewers` array

---

## Cloud Storage Rules

- Auth required on all uploads
- Content-type allowlist (images, documents only — no executables, HTML, SVG, JavaScript)
- File size limits per path (5 MB profiles → 150 MB videos)
- Default deny catch-all at `/{allPaths=**}`
- Public read only for product-images, profile-avatars, seller-assets (intentional for storefront display)

---

## Rate Limiting

Rate limiting is implemented in `functions/redis-rate-limiter.js` and applied to 29 Cloud Functions.

| Action | Limit | Window |
|---|---|---|
| `auth` | Configurable | Per IP |
| `otp` | Low (brute-force prevention) | Per phone number |
| `payment` / `checkout` | Low | Per UID |
| `admin` | Very low | Per UID |
| `review` / `listing` | Medium | Per UID |

**Fallback:** When Redis is unavailable, payment/auth/OTP rate limiting falls back to atomic Firestore transactions. High-volume non-security endpoints (search, notifications) currently lack the Firestore fallback — Redis VPC connector must be configured before full effectiveness.

---

## Secret Management

All production secrets live in Google Secret Manager. The pattern:

```javascript
const MY_SECRET = defineSecret('MY_SECRET_NAME');
// In function body:
const value = MY_SECRET.value();
```

**Never stored in:**
- `.env` files (only non-secret config)
- Source code
- Firebase Hosting files
- Client-side JavaScript

### Required Secrets (pre-go-live verification)
```
SENDGRID_API_KEY         INTASEND_PRIVATE_KEY
INTASEND_API_KEY         AFRICASTALKING_API_KEY
AFRICASTALKING_USERNAME  ETIMS_PLATFORM_PIN
LOYALTY_HMAC_SECRET      REDIS_URL
ANTHROPIC_API_KEY        PAYMENT_HMAC_SECRET
PAYROLL_ENCRYPTION_KEY
```

---

## Payment Security

- All payment amounts validated **server-side** — client values are never trusted
- Webhook signature verification on all IntaSend webhook calls
- M-Pesa webhook: always returns HTTP 200 (prevents retry probing)
- Idempotency: 24 findings addressed in Sprint 6 (deterministic doc IDs, runTransaction patterns, button-disable guards)
- Duplicate payment detection via payment state machine
- Settlement flows through canonical MoR account (Bravilex 0686420001)

---

## Zero Trust Client SDK

`sokoni-zero-trust.js` is injected on all pages via `shared-header.js`. It enforces:
- Checkout guard (blocks payment without device attestation)
- Continuous trust scoring
- Session anomaly detection

---

## XSS Prevention

All dynamic HTML rendering uses `escHtml()` for output escaping. No `innerHTML` with unescaped user content is permitted.

Input minimum: 16px font size on all inputs (prevents iOS auto-zoom and improves usability).

---

## Incident Response

### Security Alert Channels
- Primary: `ogutualex824@gmail.com` (Alex Ogutu)
- Platform: `security@mysokoni.co.ke`
- DevOps: `devops@mysokoni.co.ke`

### Security-Related Notifications
Critical security notifications (type: `security.*`) use `priority: 'critical'` in the notification engine — they bypass quiet hours and always deliver via push + SMS + in-app simultaneously.

### Weekly Security Digest
Automated Monday 07:00 EAT to `devops@mysokoni.co.ke` + `security@mysokoni.co.ke` via `scheduledWeeklySecurityReport`.

---

## Audit Logging

Admin actions are logged to Firestore `adminAuditLogs` collection:
- Action type
- Performing admin UID
- Target document
- Timestamp
- Before/after state (for sensitive changes)

Financial operations log to `paymentAuditLogs` and `settlementLogs`.

---

## Security Certification History

| Version | Score | Date |
|---|---|---|
| Enterprise Security Hardening v2.0 | 95/100 | 2026-06 |
| Security 5.0 Zero Trust | Deployed | 2026-07-07 |
| Security 6.0 Financial-Grade | Pending quota | — |
| Current audit | 83/100 | 2026-07-13 |

Score drop from v2 is due to two newly identified Firestore rule issues (F-1, F-2) and Redis VPC gap. Resolution restores to ≥93/100.

---

*Document: SOKONI Security Guide v1.0 — 2026-07-13*
