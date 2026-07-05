---
title: "Vol 16 — APIs & Integrations"
tags: [apis, integrations, external-services, firebase, cloud-functions, intasend, algolia, typesense, etims, sendgrid, anthropic]
volume: 16
---

# Vol 16 — APIs & Integrations

> **Series:** SOKONI Enterprise Documentation · [[vol-01-vision-architecture|Architecture]] · [[vol-04-payments|Payments]] · [[vol-05-accounting|Accounting]]

SOKONI's integration layer connects the platform to M-Pesa, KRA eTIMS, search engines, email, AI, and a growing ecosystem of external services — all through Firebase Cloud Functions acting as a secure middleware tier. This volume documents every external integration surface.

---

## 1. Cloud Functions API Architecture

All backend logic is served by Firebase Cloud Functions Gen2 (`us-central1`). There are approximately **636 Cloud Functions** across ~158 files.

### 1.1 Function Types

| Type | SDK Import | Auth | App Check |
|---|---|---|---|
| `onCall` | `firebase-functions/v2/https` | Firebase ID token (auto-verified) | `enforceAppCheck: true` on all sensitive CFs |
| `onRequest` | `firebase-functions/v2/https` | Manual verification required | Optional |
| `onSchedule` | `firebase-functions/v2/scheduler` | N/A (service account) | N/A |
| `onDocumentWritten` | `firebase-functions/v2/firestore` | N/A (internal trigger) | N/A |

### 1.2 Standard CF Options Object

```javascript
const CF_OPTIONS = {
  region: 'us-central1',
  enforceAppCheck: true,
  secrets: ['SECRET_NAME_1', 'SECRET_NAME_2'],
  memory: '256MiB',
  timeoutSeconds: 60,
};
```

The `enforceAppCheck: true` flag rejects any request that does not carry a valid Firebase App Check token — preventing unauthorized API access from outside the app.

**Exception:** `deviceHeartbeat` deliberately omits `enforceAppCheck` to achieve sub-200ms latency. It still enforces Firebase Auth token verification.

### 1.3 Base URLs

```
Cloud Functions:  https://us-central1-sokoni-aeb26.cloudfunctions.net/
Firebase Hosting: https://sokoni-aeb26.web.app/ (custom: mysokoni.co.ke)
```

### 1.4 HTTP Rewrites (firebase.json)

| Source Path | Cloud Function | Region |
|---|---|---|
| `/api/chat` | `sokoniChat` | us-central1 |
| `/api/facebook/data-deletion` | `facebookDataDeletion` | us-central1 |
| `/shop/**` | → `/minishop.html` (hosting) | — |
| `/@**` | → `/minishop.html` (hosting) | — |
| `/card/**` | → `/minishop-status.html` | — |
| `/pay/**` | → `/pay.html` | — |

### 1.5 Client-Side Invocation Pattern

```javascript
// Initialize Firebase (sokoni-config.js handles this)
const functions = firebase.functions();

// Call a Cloud Function
const result = await functions.httpsCallable('functionName')({ param: value });

// App Check is attached automatically by sokoni-appcheck.js
// Auth token is attached automatically by Firebase SDK
```

### 1.6 Error Response Format

All `onCall` functions return `HttpsError` with standard codes:

| Code | HTTP Equivalent | Meaning |
|---|---|---|
| `unauthenticated` | 401 | Sign-in required |
| `permission-denied` | 403 | Insufficient role |
| `not-found` | 404 | Resource missing |
| `already-exists` | 409 | Duplicate resource |
| `resource-exhausted` | 429 | Rate limit exceeded |
| `invalid-argument` | 400 | Bad input |
| `internal` | 500 | Unexpected server error |

Internal error details are never exposed to clients — only a safe message string.

---

## 2. Firebase SDK Integration

### 2.1 Initialization

`sokoni-config.js` initialises the Firebase app with the full config object:

```javascript
const firebaseConfig = {
  apiKey: "...",
  authDomain: "sokoni-aeb26.firebaseapp.com",
  projectId: "sokoni-aeb26",
  storageBucket: "sokoni-aeb26.appspot.com",
  messagingSenderId: "...",
  appId: "...",
  measurementId: "..."
};
firebase.initializeApp(firebaseConfig);
```

### 2.2 App Check

`sokoni-appcheck.js` initializes Firebase App Check with ReCaptcha v3:

```javascript
const appCheck = firebase.appCheck();
appCheck.activate(
  new firebase.appCheck.ReCaptchaV3Provider(RECAPTCHA_SITE_KEY),
  true // auto-refresh
);
```

Once active, every `httpsCallable` invocation automatically includes the App Check token in the `X-Firebase-AppCheck` header. Cloud Functions with `enforceAppCheck: true` reject calls missing this token.

See [[vol-02-identity-security]] for the full App Check enforcement architecture.

### 2.3 Auth Token Flow

```mermaid
sequenceDiagram
  participant Client
  participant Firebase Auth
  participant Cloud Function

  Client->>Firebase Auth: signIn (Google/Phone/Email)
  Firebase Auth-->>Client: ID Token (JWT)
  Client->>Cloud Function: httpsCallable({ data }) + ID Token header
  Cloud Function->>Firebase Auth: verifyIdToken()
  Firebase Auth-->>Cloud Function: DecodedToken { uid, role, ... }
  Cloud Function-->>Client: result or HttpsError
```

---

## 3. IntaSend — M-Pesa Payment Integration

IntaSend is SOKONI's payment gateway for Kenya M-Pesa STK Push and B2C disbursements.

See [[vol-04-payments]] for the full payment FSM and lifecycle documentation.

### 3.1 Credentials

| Item | Location |
|---|---|
| Publishable key | `sokoni-config.js` (client-safe) |
| Private key | Secret Manager: `INTASEND_PRIVATE_KEY` |
| SDK CDN | `https://cdn.intasend.com` |

### 3.2 STK Push Flow (Customer Payment)

```mermaid
sequenceDiagram
  participant Customer
  participant checkout.html
  participant Cloud Function
  participant IntaSend
  participant Safaricom

  Customer->>checkout.html: "Pay with M-Pesa"
  checkout.html->>Cloud Function: initiatePayment({ amount, phone })
  Cloud Function->>IntaSend: POST /api/v1/payment/mpesa-stk-push/
  IntaSend->>Safaricom: STK Push request
  Safaricom-->>Customer: PIN prompt on phone
  Customer->>Safaricom: Enters PIN
  Safaricom-->>IntaSend: Confirmation
  IntaSend->>Cloud Function: Webhook callback
  Cloud Function->>Firestore: Update payment FSM → COMPLETED
  Cloud Function-->>Customer: Success notification
```

### 3.3 B2C Disbursement Flow (Driver / Seller Payout)

```javascript
// IntaSend B2C API call (inside Cloud Function)
const res = await fetch('https://api.intasend.com/api/v1/send-money/mpesa/', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${privateKey}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    currency: 'KES',
    transactions: [{ name, account, amount }],
  }),
});
```

### 3.4 Relevant Firestore Collections

| Collection | Purpose |
|---|---|
| `payments/{paymentId}` | Full payment record with FSM state |
| `walletTransactions/{txId}` | Double-entry ledger line items |
| `disbursements/{id}` | Outbound payout records |

### 3.5 Security Controls

- Amount and ownership validated server-side before initiating STK push
- HMAC-SHA256 audit seal on COMPLETED→ARCHIVED FSM transition (`PAYMENT_HMAC_SECRET`)
- Dual IP + UID rate limiting on payment CFs
- Idempotency keys prevent duplicate charges
- No client-side payment confirmation trusted — server verifies webhook before updating state

---

## 4. KRA eTIMS Integration

SOKONI integrates with the Kenya Revenue Authority's Electronic Tax Invoice Management System (eTIMS) for real-time tax invoice submission.

**File:** `functions/etims.js` (~28 Cloud Functions)

### 4.1 API Endpoints

| Environment | Base URL |
|---|---|
| Sandbox | `https://etims-api-sandbox.kra.go.ke/etims-api` |
| Production | `https://etims-api.kra.go.ke/etims-api` |

Controlled by `ETIMS_ENV` in `functions/.env` — defaults to `sandbox` if not set (safe fallback).

### 4.2 Required Secrets

| Secret | Purpose |
|---|---|
| `ETIMS_MASTER_KEY` | 64-char hex master key for AES-256-GCM credential encryption |
| `ETIMS_PLATFORM_PIN` | SOKONI's KRA PIN (format: `P051234567T`) |
| `ETIMS_PLATFORM_SECRET` | SOKONI's eTIMS taxpayer secret |

### 4.3 Per-Seller Credential Architecture

Each seller gets an independent eTIMS profile. Their KRA credentials (PIN + secret) are encrypted with AES-256-GCM using a seller-specific IV derived from `ETIMS_MASTER_KEY` before storage in Firestore.

```mermaid
sequenceDiagram
  participant Seller
  participant onboardEtims CF
  participant KRA eTIMS API
  participant Firestore

  Seller->>onboardEtims CF: { kraPin, kraSecret }
  onboardEtims CF->>onboardEtims CF: AES-256-GCM encrypt credentials
  onboardEtims CF->>Firestore: Save etimsProfiles/{sellerId}
  onboardEtims CF->>KRA eTIMS API: Register device
  KRA eTIMS API-->>onboardEtims CF: deviceSerial, certKey
  onboardEtims CF->>Firestore: Save certKey (encrypted)
```

### 4.4 Invoice Submission Flow

```mermaid
sequenceDiagram
  participant Order Complete Event
  participant submitEtimsInvoice CF
  participant KRA eTIMS API
  participant Firestore

  Order Complete Event->>submitEtimsInvoice CF: { orderId, sellerId }
  submitEtimsInvoice CF->>Firestore: Fetch order + seller eTIMS profile
  submitEtimsInvoice CF->>submitEtimsInvoice CF: Decrypt credentials, build invoice
  submitEtimsInvoice CF->>Firestore: atomic increment invoiceCounter (no gaps)
  submitEtimsInvoice CF->>KRA eTIMS API: POST /tims-app/invoice/send
  alt Accepted
    KRA eTIMS API-->>submitEtimsInvoice CF: invoiceNumber, qrCode
    submitEtimsInvoice CF->>Firestore: Save etimsInvoices/{id} (immutable)
    submitEtimsInvoice CF->>Customer: Email receipt with KRA QR
  else Failed
    submitEtimsInvoice CF->>Firestore: Queue in etimsQueue with attempt=1
  end
```

### 4.5 Retry Queue

Failed eTIMS submissions are retried with exponential backoff:

| Attempt | Retry Delay |
|---|---|
| 1 | 2 minutes |
| 2 | 10 minutes |
| 3 | 30 minutes |
| 4 | 120 minutes (2 hours) |
| 5 | 720 minutes (12 hours) |

After 5 failures, the invoice is flagged for manual review in `etimsAlerts` (sokoni-ops database).

### 4.6 Relevant Firestore Collections

| Collection | Purpose |
|---|---|
| `etimsProfiles/{sellerId}` | KRA registration + encrypted credentials |
| `etimsInvoices/{invoiceId}` | Immutable submitted invoices |
| `etimsQueue/{id}` | Retry queue for failed submissions |
| `etimsAlerts/{id}` | Failed invoices requiring manual review (sokoni-ops) |

---

## 5. SendGrid Email Integration

**Files:** `functions/email-service.js`, `functions/email-templates.js`, `functions/email-triggers.js`

- 53 email templates covering all platform events
- 26 email-related Cloud Functions
- 40 `@mysokoni.co.ke` addresses configured

### 5.1 Secret

| Secret | Purpose |
|---|---|
| `SENDGRID_API_KEY` | SendGrid API authentication |

### 5.2 Email Security

Email addresses are sanitized before sending to prevent parser exploits:

```javascript
// email-service.js
const sanitized = to.trim().toLowerCase();
if (!/^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$/.test(sanitized)) {
  throw new Error(`Rejected non-simple email address: ${sanitized.slice(0,60)}`);
}
```

### 5.3 Key Email Events

| Trigger | Template |
|---|---|
| Order placed | Order confirmation to buyer |
| Payment completed | Receipt with eTIMS QR |
| Driver assigned | Delivery notification |
| Low stock alert | Merchant inventory warning |
| Payroll run | Pay slip to employee |
| Account created | Welcome email |
| Password reset | OTP / reset link |

### 5.4 Collections

| Collection | Purpose |
|---|---|
| `emailLogs/{id}` | Sent email audit log (sokoni-ops) |
| `emailQueue/{id}` | Async send queue |

---

## 6. Firebase Cloud Messaging (Push Notifications)

**File:** `functions/sokoni-notif-engine.js` (notification center)

SOKONI's notification system supports 5 priority levels and 20 categories with per-user DND (Do Not Disturb) preferences.

### 6.1 Priority Levels

| Level | Use Case |
|---|---|
| CRITICAL | Payment failures, security alerts |
| HIGH | Order updates, delivery status |
| NORMAL | Promotions, loyalty points |
| LOW | Weekly digests, tips |
| SILENT | Background data sync |

### 6.2 Collections

| Collection | Purpose |
|---|---|
| `notificationQueue/{id}` | Pending FCM sends (sokoni-ops) |
| `userNotifications/{uid}/items/{id}` | Per-user notification inbox |
| `notificationPreferences/{uid}` | DND settings, category opt-outs |

---

## 7. Algolia Search Integration

Algolia powers SOKONI's full-text product search with Swahili NLP support.

**Files:** `functions/algolia-sync.js`, `algolia-queue.js`, `algolia-transform.js`, `algolia-settings.js`, `algolia-monitor.js`, `algolia-analytics.js`, `algolia-personalization.js`, `algolia-reconcile.js`, `algolia-recommend.js`, `algolia-secured-keys.js`, `algolia-query-suggestions.js`

### 7.1 Secrets

| Secret | Purpose |
|---|---|
| `ALGOLIA_APP_ID` | Algolia application identifier |
| `ALGOLIA_ADMIN_KEY` | Full-access admin key (server-side only) |

### 7.2 Secured Keys (Client-Side)

Algolia secured keys are generated server-side with per-user restrictions:

```javascript
// algolia-secured-keys.js
const securedKey = algoliaClient.generateSecuredApiKey(
  searchOnlyApiKey,
  { filters: `merchantId:${merchantId}`, validUntil: expiry }
);
```

Clients receive a scoped, time-limited key — never the admin key.

### 7.3 Sync Architecture

```
Firestore document write
  → algoliaQueue/{id} (via Firestore trigger)
    → processAlgoliaQueue CF (batched)
      → algolia-transform.js (buildGlobalRecord)
        → Algolia Index update
```

Circuit breakers prevent runaway writes when Algolia rate-limits.

### 7.4 Collections

| Collection | Purpose |
|---|---|
| `algoliaQueue/{id}` | Pending index operations (sokoni-ops) |

---

## 8. Typesense Search Integration

Typesense provides a self-hosted search alternative and powers specific collection search scenarios.

**Files:** `functions/typesense-sync.js`, `typesense-queue.js`, `typesense-client.js`, `typesense-monitor.js`, `typesense-analytics.js`, `typesense-reconcile.js`, `typesense-admin.js`, `typesense-backup.js`, `typesense-secured-keys.js`

### 8.1 Secrets

| Secret | Purpose |
|---|---|
| `TYPESENSE_API_KEY` | Typesense admin API key |
| `TYPESENSE_HOST` | Typesense server hostname |

### 8.2 Collections

| Collection | Purpose |
|---|---|
| `typesenseQueue/{id}` | Pending sync operations (sokoni-ops) |

---

## 9. Google Maps / OSRM Navigation

**File:** `sokoni-navigation.js`

SOKONI uses a dual-mapping strategy: Google Maps for display, OSRM for routing.

### 9.1 External APIs Used

| Service | URL | Purpose |
|---|---|---|
| OSRM | `https://router.project-osrm.org` | Turn-by-turn routing |
| Nominatim | `https://nominatim.openstreetmap.org` | Geocoding / reverse geocoding |
| Google Maps JS SDK | `https://maps.googleapis.com` | Map display |
| Google Maps Tiles | `https://maps.gstatic.com` | Map tiles |

### 9.2 GPS Spoofing Guard

`sokoni-delivery-pricing.js` validates GPS coordinates for spoofing:

```javascript
// Reject implausible speed (> 200 km/h between updates)
const speed = distance / timeElapsedHours;
if (speed > 200) { flagSpoofingAttempt(driverId); }
```

All GPS data is validated server-side before affecting earnings or delivery status.

---

## 10. Redis Caching Layer

**Files:** `functions/redis-layer.js` (30 CFs), `sokoni-redis.js` (client SDK)

Redis is an **optional** caching layer — the platform degrades gracefully if Redis is unavailable.

### 10.1 Configuration

Set in `functions/.env`:

```
REDIS_URL=redis://username:password@host:6379
```

If `REDIS_URL` is not set, all Redis operations are no-ops and Firestore serves as the primary data store.

### 10.2 What Is Cached

| Key Pattern | TTL | Content |
|---|---|---|
| `product:{id}` | 5 min | Product details |
| `merchant:{id}:config` | 5 min | Merchant config bundle |
| `search:{query}` | 2 min | Search results |
| `rates:forex` | 1 hour | Currency exchange rates |

### 10.3 Monitoring

`redis-monitor.html` provides real-time Redis health metrics including hit rate, memory usage, and key counts.

---

## 11. Anthropic Claude AI Integration

**Secret:** `ANTHROPIC_API_KEY`

Claude Haiku is used across multiple SOKONI features for conversational AI and intelligent analysis.

### 11.1 Integration Points

| Feature | File | Model | Purpose |
|---|---|---|---|
| KASS AI Concierge | `sokoniChat` CF (inline) | Claude Haiku | Customer chat, product search, order help |
| Merchant Success Coach | `functions/merchant-success.js` | Claude Haiku | Business advice, growth recommendations |
| Loyalty Insights | `functions/loyalty-v2.js` | Claude Haiku | Personalized loyalty recommendations |
| POS AI Assistant | `functions/pos-ai-assistant.js` | Claude Haiku | Sales forecasting, reorder alerts |
| Inventory Intelligence | `functions/inventory-ai.js` | Claude Haiku | Demand prediction, supplier analysis |
| AI Strategy Engine | `functions/sasos-brain.js` | Claude Haiku | Business health scoring |

### 11.2 KASS Concierge Architecture

```mermaid
sequenceDiagram
  participant User
  participant sokoniChat CF
  participant Claude Haiku
  participant Firestore Tools

  User->>sokoniChat CF: { message, sessionId }
  sokoniChat CF->>Firestore Tools: searchProducts(), getOrderStatus(), etc.
  Firestore Tools-->>sokoniChat CF: Grounded context
  sokoniChat CF->>Claude Haiku: System prompt + context + user message
  Claude Haiku-->>sokoniChat CF: Response + tool calls (if needed)
  sokoniChat CF-->>User: Rich card or text response
```

KASS uses 6 Firestore tools for grounding:
1. `searchProducts` — query marketplace
2. `getOrderStatus` — check order state
3. `getWalletBalance` — check user wallet
4. `findNearbyMerchants` — geo query
5. `getBusinessHours` — merchant hours
6. `submitSupportTicket` — escalate to human

After 3 consecutive failures, connectivity threshold triggers a graceful degradation response.

---

## 12. Webhook System

**File:** `functions/inventory-webhooks.js`

SOKONI supports outbound webhooks for inventory events, enabling third-party integrations.

### 12.1 Events Emitted

| Event | Trigger |
|---|---|
| `stock.low` | Stock falls below safety buffer |
| `stock.out` | Product reaches zero quantity |
| `grn.received` | Goods Receipt Note processed |
| `order.fulfilled` | Order picked and dispatched |

### 12.2 Security

```javascript
// URL validated before dispatch
try {
  const url = new URL(webhookUrl);
  if (!['https:'].includes(url.protocol)) throw new Error();
} catch { throw new Error('WEBHOOK: invalid url'); }

// Payload signed with SOKONI_HMAC_KEY
const sig = crypto.createHmac('sha256', hmacKey).update(payload).digest('hex');
headers['X-Sokoni-Signature'] = `sha256=${sig}`;
```

HTTPS-only. Payload signed — recipients should verify `X-Sokoni-Signature`.

---

## 13. Rate Limiting

All sensitive Cloud Functions apply rate limiting to prevent abuse.

### 13.1 Dual-Key Rate Limiting (Payment CFs)

```javascript
// Rate limit keyed on BOTH IP and UID
const ipKey   = `rateLimit:pay:ip:${clientIp}`;
const uidKey  = `rateLimit:pay:uid:${uid}`;
// Either key exceeding the limit blocks the request
```

### 13.2 Brute-Force Protection (Auth CFs)

- 5 attempts per 5-minute window
- Counter written to Firestore **before** credential lookup (prevents timing attacks)
- Counter stored at `rateLimits/{key}` with TTL via scheduled cleanup

```javascript
// Counter is written BEFORE the lookup — timing-attack safe
await db.collection('rateLimits').doc(key).set({
  count: FieldValue.increment(1),
  windowStart: FieldValue.serverTimestamp(),
}, { merge: true });

const counter = await db.collection('rateLimits').doc(key).get();
if (counter.data().count > MAX_ATTEMPTS) {
  throw new HttpsError('resource-exhausted', 'Too many attempts. Try again in 5 minutes.');
}
```

---

## 14. Content Security Policy (CSP)

All Firebase Hosting responses include a strict CSP enforced via `firebase.json` headers.

### 14.1 Allowed External Connections (`connect-src`)

| Domain | Purpose |
|---|---|
| `*.firebaseio.com` | Realtime Database / Firestore |
| `*.googleapis.com` | Firebase, Maps, OAuth |
| `payment.intasend.com` | IntaSend payment gateway |
| `etims-api.kra.go.ke` | KRA eTIMS production |
| `etims-sbx.kra.go.ke` | KRA eTIMS sandbox |
| `nominatim.openstreetmap.org` | Geocoding |
| `router.project-osrm.org` | Routing |
| `*.algolia.net`, `*.algolianet.com` | Algolia search |
| `*.typesense.net` | Typesense search |
| `us-central1-sokoni-aeb26.cloudfunctions.net` | Cloud Functions |

### 14.2 CSP Violation Reporting

Violations are reported to `cspReportCollect` Cloud Function and stored in Firestore for security review.

---

## 15. External API Integration Checklist

When adding a new external API integration to SOKONI:

- [ ] Store credentials in Secret Manager (never in code or env files for sensitive keys)
- [ ] List secret name in CF options `secrets: [...]` array
- [ ] Access secret lazily inside function handlers — never at module load time
- [ ] Add domain to CSP `connect-src` in `firebase.json`
- [ ] Add domain to `connect-src` in CSP Report-Only header (same value)
- [ ] Implement circuit breaker for rate-limited external APIs
- [ ] Validate all inbound webhook payloads with HMAC signature verification
- [ ] Add error handling that does not expose internal details to clients
- [ ] Write exponential-backoff retry logic for unreliable external endpoints
- [ ] Document the integration in this volume and update [[appendices]]

---

## 16. SOKONI JavaScript SDK Files (Client-Side)

| File | Purpose |
|---|---|
| `sokoni-config.js` | Firebase app initialization |
| `sokoni-appcheck.js` | App Check with ReCaptcha v3 |
| `sokoni-nav-engine.js` | Role-based navigation engine |
| `sokoni-drawers.css` / `sokoni-drawer.js` | Mobile slide-in drawers |
| `sokoni-navigation.js` | GPS routing via OSRM |
| `sokoni-delivery-pricing.js` | Client-side delivery estimates |
| `sokoni-redis.js` | Redis client SDK (optional) |
| `sokoni-universal-printer.js` | 5-transport receipt printer |
| `sokoni-payment-trust.js` | Payment trust & risk scoring |
| `sokoni-search-pro.js` | Enterprise search client v3.0 |
| `sokoni-notif-engine.js` | Notification subscription client |
| `sokoni-platform.js` | Platform registry bootstrap |
| `sokoni-tokens.css` | Design token CSS variables |
| `sokoni-responsive.css` | Responsive layout system |
| `sokoni-media.js` | Media upload & management |
| `sokoni-creative.js` | AI creative studio client |
| `sokoni-wap.js` | Workflow automation client |
| `sokoni-gip.js` | Geo intelligence platform client |
| `pos-receipt-engine.js` | POS receipt generation |
| `pos-manager-auth.js` | Manager authorization (PIN/QR/NFC) |
| `pos-analytics-live.js` | POS real-time analytics |

---

## 17. Related Volumes

| Topic | Volume |
|---|---|
| Platform architecture overview | [[vol-01-vision-architecture]] |
| Auth & security | [[vol-02-identity-security]] |
| POS & device management | [[vol-03-pos-enterprise]] |
| Payment FSM & lifecycle | [[vol-04-payments]] |
| Accounting & ledger | [[vol-05-accounting]] |
| Delivery & logistics | [[vol-09-delivery-logistics]] |
| AI & intelligence | [[vol-10-artificial-intelligence]] |
| Production deployment | [[vol-18-production-certification]] |
| Full reference tables | [[appendices]] |
