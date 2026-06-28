# SOKONI Developer Platform

*Version 1.0 — 2026-06-28*

---

## Table of Contents

1. [Platform Overview](#1-platform-overview)
2. [Authentication](#2-authentication)
3. [Cloud Functions](#3-cloud-functions)
4. [API Key System](#4-api-key-system)
   - 4.1 [Overview](#41-overview)
   - 4.2 [Cloud Functions](#42-cloud-functions)
   - 4.3 [Permissions](#43-permissions)
   - 4.4 [Code Example](#44-code-example)
5. [Event Bus](#5-event-bus)
   - 5.1 [Overview](#51-overview)
   - 5.2 [Cloud Functions](#52-cloud-functions)
   - 5.3 [Event Types and Payloads](#53-event-types-and-payloads)
6. [Webhook System](#6-webhook-system)
   - 6.1 [Overview](#61-overview)
   - 6.2 [Cloud Functions](#62-cloud-functions)
   - 6.3 [Signature Verification](#63-signature-verification)
   - 6.4 [Payload Shape](#64-payload-shape)
7. [SDK Reference](#7-sdk-reference)
   - 7.1 [sokoni-platform.js](#71-sokoni-platformjs)
   - 7.2 [sokoni-search-pro.js](#72-sokoni-search-projs)
   - 7.3 [sokoni-chat-engine.js](#73-sokoni-chat-enginejs)
   - 7.4 [sokoni-delivery-pricing.js](#74-sokoni-delivery-pricingjs)
   - 7.5 [sokoni-payment-trust.js](#75-sokoni-payment-trustjs)
   - 7.6 [sokoni-universal-printer.js](#76-sokoni-universal-printerjs)
   - 7.7 [sokoni-nav-engine.js](#77-sokoni-nav-enginejs)
   - 7.8 [sokoni-appcheck.js](#78-sokoni-appcheckjs)
   - 7.9 [sokoni-wap.js](#79-sokoni-wapjs)
   - 7.10 [redis-service.js](#710-redis-servicejs)
8. [Rate Limits](#8-rate-limits)
9. [Error Codes](#9-error-codes)
10. [Security](#10-security)
    - 10.1 [Firebase App Check](#101-firebase-app-check)
    - 10.2 [Attribute-Based Access Control (ABAC)](#102-attribute-based-access-control-abac)
    - 10.3 [Step-Up Authentication](#103-step-up-authentication)
    - 10.4 [Input Validation](#104-input-validation)
11. [Getting Started Checklist](#11-getting-started-checklist)

---

## 1. Platform Overview

SOKONI is an enterprise-grade Kenyan super-platform that connects people, businesses, services, and communities through a single unified digital ecosystem. It spans over 15 vertical domains and is designed from the ground up for reliability, security, and scalability at national scale.

### What SOKONI Is

SOKONI is not a single product — it is a platform of platforms. It provides:

- **Multi-vendor Marketplace** — Products from thousands of vetted sellers
- **Food Hub** — Restaurant listings, menus, and online orders
- **Events Hub** — Event discovery, ticketing, and venue booking
- **Property Marketplace** — Residential and commercial listings
- **Vehicle Marketplace** — Cars, motorcycles, and fleet sales
- **Jobs** — Employer and job-seeker matching
- **Healthcare** — Provider listings, appointments, and consultations
- **Legal Services** — Legal service marketplace
- **Education** — Courses, tutors, and institutions
- **Entertainment** — Digital content and experiences
- **SmartPOS** — Enterprise point-of-sale for retail merchants
- **Logistics** — Driver management, dispatch, and delivery tracking
- **Payments** — M-Pesa (via IntaSend), wallet, escrow, and settlement
- **AI Assistant (KASS)** — Intelligent concierge powered by Claude Haiku

See also: [[Architecture]], [[SmartPOS]], [[Payments]], [[Authentication]]

### Architecture

SOKONI runs entirely on Google Cloud and Firebase infrastructure:

| Layer | Technology | Notes |
|---|---|---|
| Authentication | Firebase Auth with custom claims | Role 0–5, developer flag, shopId, tier |
| Database | Cloud Firestore (multi-collection) | 200+ composite indexes; PITR enabled |
| Backend | Google Cloud Functions Gen2 | ~640+ functions across 35+ modules |
| File Storage | Firebase Cloud Storage | Products, receipts, documents, media |
| Hosting | Firebase Hosting | Static assets + Function rewrites |
| Caching | Redis (sokoni-redis.js SDK) | Optional; enabled via `REDIS_URL` env var |
| Security | Firebase App Check | Enforced on Functions, Firestore, and Storage |
| Search | Algolia + Firestore fallback | `sokoni-search-pro.js` v3.0 with Swahili NLP |
| AI | Anthropic Claude Haiku | KASS concierge and AI coaching |
| Payments | IntaSend + M-Pesa STK Push | Private key in Secret Manager |

### Cloud Functions Scale

SOKONI operates approximately **640+ Cloud Functions** organized into 35+ logical modules including:

- Authentication and access control
- Marketplace (products, orders, reviews)
- Food, Events, Property, Vehicles, Jobs hubs
- Healthcare and Legal services
- SmartPOS (8 sub-modules, 139 functions)
- Logistics and dispatch
- Financial OS (escrow, settlement, ledger)
- Commission and subscription engines
- eTIMS tax compliance
- Notification center
- AI and workflow automation
- Security and fraud detection
- Platform event bus and webhooks
- Developer API key management

### Redis Caching Layer

Redis is an optional caching layer configured via the `REDIS_URL` environment variable in `functions/.env`. When `REDIS_URL` is not set, all functions fall back to direct Firestore reads. When Redis is present, frequently accessed data (product listings, session state, rate-limit counters) is cached with defined TTLs. The `sokoni-redis.js` SDK manages all cache interactions and ensures fallback-safe behavior.

### App Check Enforcement

Firebase App Check is enforced across all three Firebase services:

- **Cloud Functions** — All callable functions reject requests without a valid App Check token
- **Firestore** — Direct client reads/writes require App Check
- **Cloud Storage** — File access requires App Check

App Check is bootstrapped via `sokoni-appcheck.js` which must be loaded before any Firebase SDK call.

---

## 2. Authentication

SOKONI uses Firebase Authentication as its identity layer, extended with custom claims that encode role, shop identity, subscription tier, and verification status. All sensitive operations are gated server-side on these claims — never trust client-side state.

See also: [[Authentication]], [[Security]]

### Custom Claims Reference

| Claim | Type | Values | Description |
|---|---|---|---|
| `role` | integer | 0–5 | Authorization level (see roles below) |
| `developer` | boolean | `true` | Grants developer portal and API key access |
| `shopId` | string | e.g. `shop_abc123` | The seller's registered shop ID |
| `verified` | boolean | `true` | KYC verification completed |
| `tier` | string | `bronze`, `silver`, `gold`, `platinum` | Active subscription tier |

### Role Levels

| Role Level | Name | Description |
|---|---|---|
| 0 | Guest | Unauthenticated or freshly registered — read-only public access |
| 1 | Buyer | Authenticated customer — can browse, order, review |
| 2 | Seller | Merchant — can manage shop, products, and orders |
| 3 | Manager | Shop manager or developer — developer portal access |
| 4 | Admin | Platform administrator — platform-wide operations |
| 5 | Super Admin | Full system access — no restrictions |

### Developer Portal Access

Access to the developer portal (`/developer-portal.html`) and the API Key system requires either:

- `role >= 3` (Manager, Admin, or Super Admin), **or**
- `developer: true` custom claim (can be granted to role-1 or role-2 users by an admin)

### Obtaining a Token

```js
// Sign in with Firebase Auth (Google, Email, Phone, Facebook)
const userCredential = await firebase.auth().signInWithEmailAndPassword(email, password);
const user = userCredential.user;

// Get the Firebase ID token (JWT) — sent automatically by callable functions
const idToken = await user.getIdToken();

// Force-refresh the token to pick up newly-set custom claims
const idTokenRefreshed = await user.getIdToken(/* forceRefresh */ true);

// Decode the token payload to inspect custom claims (client-side only — never trust for security)
const decodedPayload = JSON.parse(atob(idToken.split('.')[1]));
console.log(decodedPayload.role);       // e.g. 2
console.log(decodedPayload.shopId);     // e.g. "shop_abc123"
console.log(decodedPayload.verified);   // e.g. true
console.log(decodedPayload.tier);       // e.g. "gold"
console.log(decodedPayload.developer);  // e.g. true
```

> **Security note:** Decoding the JWT client-side is for display purposes only. All authorization decisions happen server-side in Cloud Functions using the Firebase Admin SDK to verify and decode the token.

### How Custom Claims Are Set

Custom claims are **always set server-side** via the Firebase Admin SDK inside Cloud Functions. They are never writable from client code. The following CF operations set claims:

- `approveSellerKYC` — sets `verified: true`, upgrades `role` to 2, sets `shopId`
- `grantDeveloperAccess` — sets `developer: true` (role >= 4 required)
- `updateSubscriptionTier` — sets `tier` to the new plan name
- `promoteToManager` — sets `role` to 3 (admin only)
- `promoteToAdmin` — sets `role` to 4 (superadmin only)

### Multi-Factor Authentication

Sensitive operations trigger a TOTP-based step-up authentication flow. MFA is mandatory for:

- Role >= 3 sign-in (Manager, Admin, Super Admin)
- Payment initiation above KES 50,000
- API key creation and revocation
- Admin-level Cloud Function calls

TOTP enrollment is handled via `enrollMFA` and `verifyMFAEnrollment` Cloud Functions. See [Section 10.3](#103-step-up-authentication) for the step-up flow.

### Passkeys (WebAuthn)

SOKONI supports passkey-based authentication via two Cloud Functions:

- `registerPasskey` — initiates WebAuthn credential registration; returns a challenge to the client
- `assertPasskey` — validates a WebAuthn assertion; returns a Firebase custom token on success

Passkeys are stored in Firestore under `users/{uid}/passkeys/{credentialId}` with the public key and AAGUID. The client handles the WebAuthn navigator API calls; the server validates the assertion and credential counter.

### Session Tokens

Firebase ID tokens expire after **1 hour** and are automatically refreshed by the Firebase SDK. There is no long-lived session cookie. For server-to-server integrations, use the API Key system (Section 4) rather than Firebase tokens.

---

## 3. Cloud Functions

All SOKONI backend logic is implemented as Google Cloud Functions Gen2, exposed as Firebase callable functions. This section describes how to invoke them, handle errors, and understand platform-wide behavior.

See also: [[Cloud Functions]]

### Invocation

All callable Cloud Functions use the Firebase callable protocol, which wraps an authenticated HTTP POST. The Firebase SDK automatically attaches the user's ID token and App Check token:

```js
// Initialize Firebase (ensure sokoni-config.js is loaded first)
const functions = firebase.functions();

// Call any Cloud Function by name
const fn = functions.httpsCallable('functionName');
const result = await fn({ param1: 'value', param2: 42 });
console.log(result.data);
```

For functions that may take longer than the default timeout, configure a custom timeout:

```js
const longRunningFn = firebase.functions().httpsCallable('generateReport', {
  timeout: 300000 // 5 minutes in milliseconds
});
const result = await longRunningFn({ reportType: 'monthly', month: '2026-06' });
```

### Authentication Flow

Every callable Cloud Function on SOKONI performs the following server-side checks in order:

1. **App Check** — Verify the App Check token is valid and not expired
2. **ID Token** — Verify the Firebase ID token via `admin.auth().verifyIdToken()`
3. **Role Check** — Assert `role >= N` or specific claim (e.g., `developer: true`)
4. **Resource Ownership** — Assert `shopId` matches the requested resource where applicable
5. **Input Validation** — Validate all parameters against a Joi schema
6. **Business Logic** — Execute the operation
7. **Audit Log** — Write to the platform audit trail for sensitive operations

### Cold Starts

Cloud Functions Gen2 have approximately **200ms cold start latency** when no instance is warm. SOKONI mitigates this on critical paths using `minInstances` configuration:

| Function Group | Min Instances | Reason |
|---|---|---|
| `sokoniChat` (KASS) | 2 | Real-time user-facing AI |
| `createOrder` | 2 | Payment-critical path |
| `processPayment` | 2 | Payment-critical path |
| `stkPushInitiate` | 1 | M-Pesa latency sensitive |
| `validateAPIKey` | 1 | Server-to-server path |
| All others | 0 | Cost optimization |

### Regions

| Region | Functions |
|---|---|
| `us-central1` | Default region for all functions |
| `europe-west1` | GDPR-adjacent data processing functions |

### Timeouts

| Function Category | Timeout |
|---|---|
| Standard read operations | 60 seconds |
| Order and payment processing | 120 seconds |
| Report generation | 540 seconds |
| AI (KASS, coach) | 120 seconds |
| Bulk data operations | 540 seconds |

### Error Handling

All Cloud Functions throw `HttpsError` with structured codes. See [Section 9](#9-error-codes) for the full error code reference.

```js
try {
  const fn = firebase.functions().httpsCallable('functionName');
  const result = await fn({ param1: 'value', param2: 42 });
  console.log(result.data);
} catch (err) {
  // err.code is prefixed with 'functions/' e.g. 'functions/permission-denied'
  // err.message is a human-readable description
  // err.details may contain additional structured context
  console.error(`CF Error [${err.code}]: ${err.message}`, err.details);
}
```

---

## 4. API Key System

### 4.1 Overview

The API Key system enables server-to-server integrations and third-party developer access to SOKONI data without using Firebase user sessions. API keys are scoped to specific permissions and optionally to a specific shop.

**Key properties:**

- API keys are for **machine-to-machine** integrations only — not for client apps
- Each key carries a set of **permission scopes** (see Section 4.3)
- Keys are **hashed with SHA-256** before storage — the raw key is shown only once at creation time
- Keys are stored in Firestore under `apiKeys/{keyId}`
- All key operations require `role >= 3` OR `developer: true`
- Keys can be scoped to a `shopId` to restrict access to a single merchant's data
- Revoked keys are rejected immediately with no grace period

**Firestore document schema (`apiKeys/{keyId}`):**

| Field | Type | Description |
|---|---|---|
| `id` | string | Unique key ID (e.g. `key_abc123`) |
| `name` | string | Human-readable label |
| `maskedKey` | string | Last 4 chars visible (e.g. `••••••••••••abcd`) |
| `keyHash` | string | SHA-256 hash of raw key — used for validation |
| `permissions` | string[] | Array of granted permission scopes |
| `shopId` | string \| null | Restricts key to a specific shop (optional) |
| `createdAt` | Timestamp | Creation timestamp |
| `lastUsedAt` | Timestamp \| null | Last successful use timestamp |
| `status` | string | `active` or `revoked` |
| `createdBy` | string | Firebase UID of creating user |

### 4.2 Cloud Functions

| Function | Description | Auth Required | Params | Returns |
|---|---|---|---|---|
| `createAPIKey` | Create a new API key | `role>=3` or `developer:true` | `{name: string, permissions: string[], shopId?: string}` | `{keyId, rawKey, name, permissions, createdAt}` |
| `listAPIKeys` | List all keys owned by the calling user | `role>=3` or `developer:true` | `{}` | `{keys: APIKey[]}` |
| `revokeAPIKey` | Permanently revoke a key | `role>=3` or `developer:true` + owns key | `{keyId: string}` | `{success: boolean}` |
| `validateAPIKey` | Validate a key and return its permissions | None (uses key itself) | `{apiKey: string}` | `{valid: boolean, permissions: string[], shopId?: string}` |

**Notes:**

- `createAPIKey` returns the `rawKey` exactly once. It cannot be retrieved again. Store it securely immediately.
- `validateAPIKey` is intended for your own server to verify an incoming key before processing a request. It is not callable from client browsers in production.
- `listAPIKeys` returns masked keys only — the raw key is never returned after creation.
- Admin users (role >= 4) can list and revoke keys for any user. Role-3/developer users can only manage their own keys.

### 4.3 Permissions

The following permission scopes are valid when creating an API key:

| Permission | Description | Notes |
|---|---|---|
| `marketplace:read` | Read products, categories, and store listings | Safe for public integrations |
| `marketplace:write` | Create and update products | Requires `shopId` scoping recommended |
| `orders:read` | Read order records | Scoped to `shopId` when set |
| `orders:write` | Create orders and update order status | Use with caution |
| `payments:read` | Read payment records and transaction history | Sensitive — scope to shopId |
| `payments:write` | Initiate payment requests | Highly restricted; requires step-up review |
| `pos:read` | Read POS sessions and sales data | Scoped to `shopId` |
| `pos:write` | Create POS sessions and record sales | Scoped to `shopId` |
| `logistics:read` | Read delivery and dispatch records | |
| `logistics:write` | Create dispatch requests | |
| `analytics:read` | Read analytics reports and metrics | Scoped to `shopId` when set |
| `webhooks:manage` | Register and manage webhook endpoints | |
| `admin:read` | Read platform-wide admin data | Only grantable to `role >= 4` keys |

> **Security:** Never grant `payments:write` or `admin:read` to an API key unless absolutely required. Apply the principle of least privilege — request only the permissions your integration needs.

### 4.4 Code Example

```js
// ---- Create an API key (from developer portal or server) ----
const createKey = firebase.functions().httpsCallable('createAPIKey');
const result = await createKey({
  name: 'Inventory Sync Integration',
  permissions: ['marketplace:read', 'orders:read', 'pos:read'],
  shopId: 'shop_abc123' // optional — restricts key to this shop
});

const { keyId, rawKey } = result.data;
console.log('Key ID:', keyId);
console.log('Raw Key (save this now):', rawKey); // Shown only once!

// ---- List existing API keys ----
const listKeys = firebase.functions().httpsCallable('listAPIKeys');
const listResult = await listKeys({});
console.log('My keys:', listResult.data.keys);
// Each key: { id, name, maskedKey, permissions, shopId, status, createdAt, lastUsedAt }

// ---- Revoke an API key ----
const revokeKey = firebase.functions().httpsCallable('revokeAPIKey');
await revokeKey({ keyId: 'key_abc123' });
console.log('Key revoked');

// ---- Validate a key (server-side only) ----
// This is called by your own server, not by end users
const validateKey = firebase.functions().httpsCallable('validateAPIKey');
const validation = await validateKey({ apiKey: rawKeyFromRequest });
if (validation.data.valid) {
  const { permissions, shopId } = validation.data;
  // Proceed with authorized operation
}
```

---

## 5. Event Bus

### 5.1 Overview

SOKONI uses an internal event bus to decouple platform modules and enable real-time reactivity. The event bus is implemented using Firestore as the event store and Cloud Function triggers as consumers. Developers can publish custom events, query the event log, and replay events for debugging.

**Design principles:**

- Events are immutable once written — they represent facts that occurred
- All events are stored permanently in `platformEvents/{eventId}`
- Each event carries a `type`, a `payload`, metadata (`shopId`, `uid`, timestamps), and a `version`
- Consumers can be Cloud Function Firestore triggers or external systems via webhooks (Section 6)
- The event bus guarantees at-least-once delivery — consumers must be idempotent

**Firestore event document schema (`platformEvents/{eventId}`):**

| Field | Type | Description |
|---|---|---|
| `id` | string | Unique event ID (e.g. `evt_xyz789`) |
| `type` | string | Event type (e.g. `order.created`) |
| `payload` | object | Event-specific data (see Section 5.3) |
| `shopId` | string \| null | Shop context, if applicable |
| `uid` | string | UID of the actor who triggered the event |
| `version` | string | Payload schema version (e.g. `1.0`) |
| `createdAt` | Timestamp | When the event was published |
| `processedAt` | Timestamp \| null | When all consumers finished processing |
| `source` | string | Module that published the event (e.g. `orders`, `pos`) |

### 5.2 Cloud Functions

| Function | Description | Auth Required | Params | Returns |
|---|---|---|---|---|
| `publishEvent` | Publish a custom platform event | `role >= 3` | `{type: string, payload: object, shopId?: string}` | `{eventId: string}` |
| `queryEvents` | Query recent events by type or time window | `role >= 3` | `{type?: string, since?: Timestamp, limit?: number}` | `{events: Event[]}` |
| `replayEvent` | Re-trigger all consumers for a specific event | `role >= 4` | `{eventId: string}` | `{success: boolean}` |

**Notes:**

- `publishEvent` is for internal or integration use. Most SOKONI events are published automatically by the platform modules (e.g., when an order is created, `order.created` fires automatically).
- `queryEvents` defaults to the last 100 events if no `since` or `limit` is specified.
- `replayEvent` is an admin-only operation used to recover from consumer failures. It re-triggers all registered consumers and webhook deliveries for the given event.

### 5.3 Event Types and Payloads

The following events are emitted by the SOKONI platform:

| Event Type | Description | Payload Fields |
|---|---|---|
| `order.created` | New order placed | `orderId`, `buyerId`, `sellerId`, `shopId`, `total`, `currency`, `items[]`, `createdAt` |
| `order.completed` | Order fulfilled and closed | `orderId`, `completedAt`, `rating?` |
| `order.cancelled` | Order cancelled before fulfillment | `orderId`, `reason`, `cancelledBy`, `cancelledAt` |
| `payment.success` | Payment confirmed by payment provider | `paymentId`, `orderId`, `amount`, `currency`, `method`, `paidAt` |
| `payment.failed` | Payment attempt failed | `paymentId`, `orderId`, `amount`, `reason`, `failedAt` |
| `payment.refunded` | Refund issued to buyer | `paymentId`, `orderId`, `refundId`, `amount`, `refundedAt` |
| `seller.approved` | Seller KYC verified and approved | `sellerId`, `shopId`, `approvedAt`, `approvedBy` |
| `seller.suspended` | Seller account suspended | `sellerId`, `shopId`, `reason`, `suspendedAt`, `suspendedBy` |
| `job.created` | New job listing published | `jobId`, `employerId`, `title`, `category`, `salary`, `location` |
| `job.applied` | Candidate submitted application | `jobId`, `applicantId`, `appliedAt` |
| `delivery.dispatched` | Delivery assigned to a rider | `deliveryId`, `orderId`, `riderId`, `estimatedETA` |
| `delivery.completed` | Delivery confirmed by recipient | `deliveryId`, `orderId`, `completedAt`, `signature?`, `rating?` |
| `pos.session.opened` | POS terminal session started | `sessionId`, `posId`, `operatorId`, `shopId`, `openedAt` |
| `pos.sale.completed` | POS sale finalized | `sessionId`, `saleId`, `total`, `method`, `itemCount` |
| `subscription.upgraded` | Merchant upgraded their subscription plan | `uid`, `shopId`, `fromPlan`, `toPlan`, `effectiveAt` |
| `subscription.expired` | Subscription lapsed without renewal | `uid`, `shopId`, `plan`, `expiredAt` |

**Payload notes:**

- All `amount` and `total` values are in **Kenya Shillings (KES)** as integers (smallest unit, e.g., 10000 = KES 100.00)
- `currency` is always `"KES"` for domestic transactions
- `items[]` in `order.created` contains `{productId, name, qty, unitPrice, subtotal}`
- `method` in `payment.success` is one of: `mpesa`, `card`, `wallet`, `cash`
- `signature?` in `delivery.completed` is a base64-encoded image if collected

---

## 6. Webhook System

### 6.1 Overview

Webhooks enable your external servers to receive real-time notifications when SOKONI platform events occur. When a subscribed event fires, SOKONI sends an HTTP POST request to your registered endpoint containing a signed JSON payload.

**How it works:**

1. Register your endpoint URL and the event types you want to receive via `registerWebhook`
2. SOKONI fires the event internally and stores it in `platformEvents`
3. The webhook dispatcher reads your subscription and sends an HTTP POST to your URL
4. Your server verifies the `X-Sokoni-Signature` header and processes the payload
5. Your server must return HTTP 2xx within 10 seconds to acknowledge delivery

**Reliability:**

- **Retry policy:** 3 attempts with exponential backoff (5 seconds, 30 seconds, 5 minutes)
- **Timeout:** Each delivery attempt has a 10-second timeout
- **Dead letter:** After 3 failed attempts, the event is marked `failed` in `webhookDeliveries/{deliveryId}`
- **Ordering:** Webhooks are delivered best-effort; do not rely on ordering between different event types
- **Idempotency:** Use the `eventId` field to deduplicate events on your server

Webhook registration data is stored in `webhooks/{webhookId}` in Firestore.

### 6.2 Cloud Functions

| Function | Description | Auth Required | Params | Returns |
|---|---|---|---|---|
| `registerWebhook` | Register a new webhook endpoint | `role >= 3` | `{url: string, events: string[], secret: string, name: string}` | `{webhookId, status: 'active'}` |
| `deleteWebhook` | Permanently remove a webhook registration | `role >= 3` + owns webhook | `{webhookId: string}` | `{success: boolean}` |
| `testWebhook` | Send a test ping payload to a webhook | `role >= 3` + owns webhook | `{webhookId: string}` | `{delivered: boolean, statusCode: number, latencyMs: number}` |
| `listWebhooks` | List all webhooks registered by the calling user | `role >= 3` | `{}` | `{webhooks: Webhook[]}` |

**Notes:**

- The `secret` you provide at registration is used to compute HMAC-SHA256 signatures. Store it securely — it cannot be retrieved after registration.
- `url` must be an HTTPS endpoint. HTTP endpoints are rejected.
- `events` is an array of event type strings (e.g., `["order.created", "payment.success"]`). Use `["*"]` to subscribe to all events (admin only).
- `testWebhook` sends a synthetic payload with `eventType: "webhook.test"` to verify connectivity before going live.

### 6.3 Signature Verification

Every webhook delivery includes an `X-Sokoni-Signature` header. Verify this header to confirm the request genuinely came from SOKONI and has not been tampered with.

```js
// Node.js — Express middleware example
const crypto = require('crypto');

/**
 * Verify the HMAC-SHA256 signature on an incoming SOKONI webhook.
 * @param {object} payload - The parsed JSON body of the request
 * @param {string} signature - Value of the X-Sokoni-Signature header
 * @param {string} secret - Your webhook secret set at registration
 * @returns {boolean} true if the signature is valid
 */
function verifyWebhookSignature(payload, signature, secret) {
  const expected = crypto
    .createHmac('sha256', secret)
    .update(JSON.stringify(payload))
    .digest('hex');

  const expectedHeader = `sha256=${expected}`;

  // Use timingSafeEqual to prevent timing attacks
  return crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(expectedHeader)
  );
}

// Express route handler
app.post('/webhooks/sokoni', express.json(), (req, res) => {
  const signature = req.headers['x-sokoni-signature'];

  if (!verifyWebhookSignature(req.body, signature, process.env.SOKONI_WEBHOOK_SECRET)) {
    return res.status(401).json({ error: 'Invalid signature' });
  }

  const { eventType, eventId, payload } = req.body;

  // Deduplicate using eventId
  if (await isAlreadyProcessed(eventId)) {
    return res.status(200).json({ ok: true, duplicate: true });
  }

  // Process the event
  await handleEvent(eventType, payload);

  res.status(200).json({ ok: true });
});
```

> **Important:** Always use `crypto.timingSafeEqual` when comparing signatures. A standard string comparison (`===`) is vulnerable to timing attacks that can allow an attacker to forge valid signatures.

### 6.4 Payload Shape

Every webhook delivery carries the following envelope structure:

```json
{
  "webhookId": "wh_abc123",
  "eventType": "order.created",
  "eventId": "evt_xyz789",
  "timestamp": "2026-06-28T10:00:00Z",
  "deliveryAttempt": 1,
  "payload": {
    "orderId": "ord_000111",
    "buyerId": "uid_buyer_abc",
    "sellerId": "uid_seller_xyz",
    "shopId": "shop_abc123",
    "total": 150000,
    "currency": "KES",
    "items": [
      {
        "productId": "prod_001",
        "name": "Maasai Blanket",
        "qty": 2,
        "unitPrice": 75000,
        "subtotal": 150000
      }
    ],
    "createdAt": "2026-06-28T09:59:58Z"
  }
}
```

**Envelope fields:**

| Field | Type | Description |
|---|---|---|
| `webhookId` | string | ID of the webhook registration that triggered this delivery |
| `eventType` | string | The event type (see Section 5.3) |
| `eventId` | string | Unique ID for this event — use for deduplication |
| `timestamp` | string | ISO 8601 timestamp of when SOKONI dispatched this delivery |
| `deliveryAttempt` | integer | 1 for first attempt; 2 or 3 for retries |
| `payload` | object | Event-specific data (see Section 5.3 for field definitions) |

---

## 7. SDK Reference

SOKONI ships a suite of client-side and server-side JavaScript SDKs. Each SDK is a standalone module that can be loaded via `<script>` tag or imported as a module.

| SDK File | Purpose | Key Exports |
|---|---|---|
| `sokoni-platform.js` | Platform bootstrap SDK | `SokoniPlatform.init()`, `SokoniPlatform.getCapabilities()`, `SokoniPlatform.emit()`, `SokoniPlatform.on()` |
| `sokoni-search-pro.js` | Enterprise search (Algolia + Firestore fallback) | `SokoniSearch.query()`, `SokoniSearch.suggest()`, `SokoniSearch.facets()`, `SokoniSearch.nlpQuery()` |
| `sokoni-chat-engine.js` | Business messaging SDK | `SokoniChat.init()`, `SokoniChat.sendMessage()`, `SokoniChat.loadThread()`, `SokoniChat.markRead()` |
| `sokoni-delivery-pricing.js` | Delivery cost calculator | `DeliveryPricing.estimate()`, `DeliveryPricing.getZones()`, `DeliveryPricing.track()` |
| `sokoni-payment-trust.js` | Payment security layer | `SokoniTrust.validate()`, `SokoniTrust.flag()`, `SokoniTrust.getScore()` |
| `sokoni-universal-printer.js` | Receipt and label printer | `SokoniPrinter.print()`, `SokoniPrinter.detect()`, `SokoniPrinter.queue()` |
| `sokoni-nav-engine.js` | Role-based navigation | `NavEngine.init()`, `NavEngine.setRole()`, `NavEngine.switchWorkspace()` |
| `sokoni-appcheck.js` | Firebase App Check bootstrap | `initAppCheck()` (auto-called on load) |
| `sokoni-wap.js` | Workflow automation | `WAP.trigger()`, `WAP.register()`, `WAP.getStatus()` |
| `redis-service.js` | Redis caching SDK (Cloud Functions internal) | `RedisService.get()`, `RedisService.set()`, `RedisService.invalidate()`, `RedisService.pipeline()` |

---

### 7.1 sokoni-platform.js

**File path:** `/sokoni-platform.js`

**Description:** The platform bootstrap SDK. Must be loaded first among all SOKONI SDKs. It initializes Firebase, registers platform capabilities, sets up the global event bus, and provides the capability registry that other SDKs query to confirm feature availability.

**Key exports:**

- `SokoniPlatform.init(config)` — Initialize the platform with a Firebase config object
- `SokoniPlatform.getCapabilities()` — Returns the list of active platform capabilities
- `SokoniPlatform.emit(eventName, detail)` — Emit a custom DOM-level platform event
- `SokoniPlatform.on(eventName, handler)` — Subscribe to a platform event
- `SokoniPlatform.getUser()` — Returns the current Firebase user with decoded custom claims
- `SokoniPlatform.isReady()` — Returns a Promise that resolves when Auth and Firestore are ready

**Usage example:**

```js
// Load sokoni-config.js first, then sokoni-platform.js
// sokoni-config.js sets window.SOKONI_CONFIG

await SokoniPlatform.init(window.SOKONI_CONFIG);

// Check platform readiness before using any other SDK
await SokoniPlatform.isReady();

// Get current user with claims
const user = SokoniPlatform.getUser();
console.log('Role:', user.claims.role);
console.log('Shop:', user.claims.shopId);

// Subscribe to platform-level events
SokoniPlatform.on('auth:roleChanged', (detail) => {
  console.log('Role changed to:', detail.newRole);
});

// Emit a custom event to other modules
SokoniPlatform.emit('cart:updated', { itemCount: 3, total: 45000 });

// Query active capabilities
const caps = SokoniPlatform.getCapabilities();
console.log(caps); // e.g. ['marketplace', 'pos', 'search', 'payments', ...]
```

---

### 7.2 sokoni-search-pro.js

**File path:** `/sokoni-search-pro.js`

**Description:** Enterprise search SDK (v3.0) with Algolia as the primary engine and Firestore as the fallback. Supports full-text search, faceted filtering, autocomplete suggestions, and Swahili NLP query normalization. Circuit breakers automatically fail over to Firestore if Algolia is unreachable.

**Key exports:**

- `SokoniSearch.query(q, options)` — Execute a full-text search with optional filters and pagination
- `SokoniSearch.suggest(q)` — Return autocomplete suggestions for a partial query
- `SokoniSearch.facets(q, facetFields)` — Return facet counts for a query
- `SokoniSearch.nlpQuery(q)` — Normalize a Swahili or mixed-language query before searching
- `SokoniSearch.setIndex(indexName)` — Switch the active Algolia index (e.g., products, events, jobs)
- `SokoniSearch.clearCache()` — Clear the local query result cache

**Usage example:**

```js
// Basic product search
const results = await SokoniSearch.query('nyumba nairobi', {
  index: 'properties',
  filters: { category: 'apartment', priceMax: 500000 },
  page: 0,
  hitsPerPage: 20
});
console.log(results.hits);       // Array of matching products
console.log(results.totalHits);  // Total result count
console.log(results.facets);     // Facet distribution

// Autocomplete suggestions
const suggestions = await SokoniSearch.suggest('nik');
console.log(suggestions); // ['Nike Air Max', 'Nike Running Shoes', ...]

// Swahili NLP normalization
const normalized = await SokoniSearch.nlpQuery('natafuta kazi nairobi CBD');
// normalized => { intent: 'job_search', location: 'Nairobi CBD', query: 'kazi' }
const jobResults = await SokoniSearch.query(normalized.query, {
  index: 'jobs',
  filters: { location: normalized.location }
});
```

---

### 7.3 sokoni-chat-engine.js

**File path:** `/sokoni-chat-engine.js`

**Description:** Business messaging SDK powering the transaction-gated chat system between buyers and sellers. Messages are stored in Firestore and delivered in real-time via Firestore listeners. Chat threads are gated — a buyer can only initiate a chat with a seller if they have a completed or active order with that seller's shop.

**Key exports:**

- `SokoniChat.init(uid)` — Initialize the chat engine for the given user
- `SokoniChat.sendMessage(threadId, text, attachments?)` — Send a message to a thread
- `SokoniChat.loadThread(threadId)` — Load message history for a thread
- `SokoniChat.markRead(threadId)` — Mark all messages in a thread as read for the current user
- `SokoniChat.onMessage(threadId, callback)` — Subscribe to real-time new messages in a thread
- `SokoniChat.listThreads()` — List all chat threads for the current user
- `SokoniChat.createThread(shopId, orderId)` — Open a new chat thread (gated by order existence)

**Usage example:**

```js
// Initialize for current user
await SokoniChat.init(firebase.auth().currentUser.uid);

// List all existing threads
const { threads } = await SokoniChat.listThreads();
threads.forEach(t => console.log(t.shopName, t.lastMessage, t.unreadCount));

// Open a thread (order-gated)
const { threadId } = await SokoniChat.createThread('shop_abc123', 'ord_000111');

// Load message history
const { messages } = await SokoniChat.loadThread(threadId);

// Subscribe to new messages in real-time
const unsubscribe = SokoniChat.onMessage(threadId, (message) => {
  console.log(`${message.senderName}: ${message.text}`);
  appendMessageToUI(message);
});

// Send a message
await SokoniChat.sendMessage(threadId, 'When will my order be ready?');

// Mark thread as read
await SokoniChat.markRead(threadId);

// Clean up listener
unsubscribe();
```

---

### 7.4 sokoni-delivery-pricing.js

**File path:** `/sokoni-delivery-pricing.js`

**Description:** Delivery cost estimation and zone management SDK. Calculates delivery fees based on distance zones, vehicle type, weight, and time of day. Also provides real-time delivery tracking with smooth GPS interpolation and GPS spoofing detection.

**Key exports:**

- `DeliveryPricing.estimate(params)` — Estimate delivery cost given origin, destination, and cargo details
- `DeliveryPricing.getZones()` — Retrieve defined delivery zones and base prices
- `DeliveryPricing.track(deliveryId)` — Subscribe to real-time GPS location updates for an active delivery
- `DeliveryPricing.getETA(deliveryId)` — Get the current estimated time of arrival
- `DeliveryPricing.untrack(deliveryId)` — Unsubscribe from tracking updates

**Usage example:**

```js
// Estimate delivery cost
const estimate = await DeliveryPricing.estimate({
  originLat: -1.2921,
  originLng: 36.8219,
  destLat: -1.3000,
  destLng: 36.8500,
  weightKg: 2.5,
  vehicleType: 'motorcycle', // 'motorcycle', 'car', 'van', 'truck'
  scheduledAt: null          // null = ASAP
});
console.log('Estimated fee:', estimate.fee);         // e.g. 25000 (KES 250.00)
console.log('Distance km:', estimate.distanceKm);
console.log('Zone:', estimate.zone);                 // e.g. 'nairobi_cbd_to_westlands'
console.log('ETA minutes:', estimate.etaMinutes);

// Get all zones and base prices
const zones = await DeliveryPricing.getZones();
zones.forEach(z => console.log(z.name, z.basePrice, z.maxDistanceKm));

// Track an active delivery
const unsubscribe = DeliveryPricing.track('del_abc123', (update) => {
  console.log('Rider location:', update.lat, update.lng);
  console.log('Stage:', update.stage); // e.g. 'picked_up', 'en_route', 'nearby'
  console.log('ETA:', update.etaMinutes);
  updateMapMarker(update.lat, update.lng);
});

// Stop tracking
unsubscribe();
```

---

### 7.5 sokoni-payment-trust.js

**File path:** `/sokoni-payment-trust.js`

**Description:** Payment security and fraud prevention SDK. Validates payments before processing, assigns trust scores to transactions, and flags suspicious activity for review. The `SokoniTrust` API is wired into `checkout.html` and all payment Cloud Functions.

**Key exports:**

- `SokoniTrust.validate(paymentParams)` — Validate payment parameters before initiating (amount, ownership, currency, idempotency)
- `SokoniTrust.flag(paymentId, reason)` — Flag a payment for manual review
- `SokoniTrust.getScore(uid)` — Get the trust score for a user (0–100)
- `SokoniTrust.checkDuplicate(idempotencyKey)` — Check if an identical payment was recently submitted
- `SokoniTrust.getHistory(uid, limit?)` — Get recent payment history for risk context

**Usage example:**

```js
// Validate before initiating payment
const validation = await SokoniTrust.validate({
  uid: currentUser.uid,
  amount: 150000,        // KES 1,500.00 in smallest unit
  currency: 'KES',
  orderId: 'ord_000111',
  method: 'mpesa',
  idempotencyKey: 'checkout_session_xyz_ord_000111'
});

if (!validation.approved) {
  console.error('Payment blocked:', validation.reason);
  // e.g. 'duplicate_request', 'amount_mismatch', 'suspicious_activity'
  return;
}

// Get trust score for the current user
const { score, level } = await SokoniTrust.getScore(currentUser.uid);
console.log('Trust score:', score);   // 0–100
console.log('Trust level:', level);   // 'new', 'low', 'medium', 'high', 'trusted'

// Flag a suspicious payment for admin review
await SokoniTrust.flag('pay_abc123', 'Unusual amount pattern detected by integration');
```

---

### 7.6 sokoni-universal-printer.js

**File path:** `/sokoni-universal-printer.js`

**Description:** Universal receipt and label printer SDK (v3.0). Supports five connection transports — Bluetooth, USB, Serial, Network (LAN), and Browser Print — and can generate over 20 document types including receipts, invoices, dispatch notes, loyalty cards, and eTIMS-compliant tax receipts.

**Key exports:**

- `SokoniPrinter.detect()` — Auto-detect available printers across all transports
- `SokoniPrinter.print(docType, data, printerConfig?)` — Print a document
- `SokoniPrinter.queue(jobs[])` — Queue multiple print jobs for sequential printing
- `SokoniPrinter.getTransports()` — List available transport methods on the current device
- `SokoniPrinter.previewHTML(docType, data)` — Generate an HTML preview of a document

**Supported transports:**

| Transport | Availability | Notes |
|---|---|---|
| Bluetooth | Android / iOS | Requires Web Bluetooth API |
| USB | Desktop Chrome | Requires WebUSB API |
| Serial | Desktop Chrome | Requires Web Serial API |
| Network (LAN) | Any | Requires printer IP on same network |
| Browser Print | Any | Uses window.print() — universal fallback |

**Usage example:**

```js
// Auto-detect available printers
const printers = await SokoniPrinter.detect();
console.log('Found printers:', printers);
// [{ id: 'bt_epson_123', name: 'Epson TM-T20', transport: 'bluetooth', status: 'ready' }]

// Print a receipt
await SokoniPrinter.print('receipt', {
  orderId: 'ord_000111',
  shopName: 'Wanjiru Fashions',
  items: [{ name: 'Kitenge Dress', qty: 1, unitPrice: 120000, subtotal: 120000 }],
  total: 120000,
  paymentMethod: 'M-Pesa',
  mpesaRef: 'QHX123ABC',
  cashierName: 'Jane Kamau',
  timestamp: new Date()
}, {
  printerId: 'bt_epson_123',
  copies: 1
});

// Queue multiple jobs
await SokoniPrinter.queue([
  { docType: 'receipt', data: receiptData },
  { docType: 'dispatch_note', data: dispatchData },
  { docType: 'customer_copy', data: receiptData }
]);

// HTML preview before printing
const html = SokoniPrinter.previewHTML('receipt', receiptData);
document.getElementById('preview-frame').srcdoc = html;
```

---

### 7.7 sokoni-nav-engine.js

**File path:** `/sokoni-nav-engine.js`

**Description:** Role-based navigation engine that auto-generates and injects the bottom navigation bar and workspace switcher. It manages 7 defined workspaces (buyer, seller, driver, admin, super-admin, healthcare, legal) and handles deep-linking via URL hashes. Navigation items and workspaces are derived from the user's custom claims.

**Key exports:**

- `NavEngine.init(user)` — Initialize the nav engine with the Firebase user and custom claims
- `NavEngine.setRole(role)` — Programmatically switch the displayed role (admin use only)
- `NavEngine.switchWorkspace(workspaceName)` — Switch to a named workspace
- `NavEngine.getActiveWorkspace()` — Returns the currently active workspace name
- `NavEngine.onWorkspaceChange(callback)` — Subscribe to workspace changes
- `NavEngine.injectBottomNav(containerSelector)` — Manually inject the bottom nav into a container

**Workspaces:**

| Workspace | Min Role | Description |
|---|---|---|
| `buyer` | 1 | Shopping, orders, tracking |
| `seller` | 2 | Products, orders, analytics |
| `driver` | 2 (driver claim) | Dispatch, navigation, earnings |
| `manager` | 3 | Staff, reports, settings |
| `admin` | 4 | Platform operations |
| `super-admin` | 5 | Full system access |
| `healthcare` | 2 (provider claim) | Appointments, patients |

**Usage example:**

```js
// Initialize after auth state is known
firebase.auth().onAuthStateChanged(async (user) => {
  if (user) {
    await NavEngine.init(user);
    // Bottom nav auto-injected into document.body
  }
});

// Switch workspace programmatically
NavEngine.switchWorkspace('seller');

// Listen to workspace changes
NavEngine.onWorkspaceChange((newWorkspace) => {
  console.log('Now in workspace:', newWorkspace);
  loadWorkspaceContent(newWorkspace);
});

// Deep-link support — navigate to a hash route
window.location.hash = '#seller/products';
// NavEngine intercepts and loads the correct workspace and section
```

---

### 7.8 sokoni-appcheck.js

**File path:** `/sokoni-appcheck.js`

**Description:** Firebase App Check bootstrap module. Must be loaded before any Firebase SDK operation. It initializes App Check with reCAPTCHA v3 (web), registers the provider, and attaches the token to all outgoing Firebase requests. Debug tokens can be activated for local development via an environment flag.

**Key exports:**

- `initAppCheck()` — Bootstrap App Check; called automatically on script load
- `getAppCheckToken()` — Returns the current App Check token (for debugging)

**Usage example:**

```html
<!-- Load order matters: config first, appcheck second, then other SDKs -->
<script src="/sokoni-config.js"></script>
<script src="/sokoni-appcheck.js"></script>
<script src="/sokoni-platform.js"></script>
```

```js
// sokoni-appcheck.js auto-calls initAppCheck() on load.
// No manual call is required in normal usage.

// For local development, set the debug flag before loading:
// window.SOKONI_APPCHECK_DEBUG = true;
// Then copy the debug token from the Firebase console.

// Verify App Check is active (for diagnostics only)
const token = await getAppCheckToken();
console.log('App Check token present:', !!token);
```

> **Note:** If App Check is not initialized before your first Firestore or Cloud Function call, the request will be rejected with `permission-denied`. Always ensure `sokoni-appcheck.js` loads before any Firebase operation.

---

### 7.9 sokoni-wap.js

**File path:** `/sokoni-wap.js`

**Description:** Workflow Automation Platform (WAP) SDK. Enables creating, triggering, and monitoring automated business workflows such as order fulfillment sequences, inventory reorder triggers, seller onboarding pipelines, and scheduled marketing campaigns. WAP uses a declarative workflow definition with 20 built-in step handlers.

**Key exports:**

- `WAP.trigger(workflowId, context)` — Trigger a registered workflow with an input context
- `WAP.register(definition)` — Register a new workflow definition
- `WAP.getStatus(runId)` — Get the current status of a workflow run
- `WAP.listRuns(workflowId, limit?)` — List recent runs for a workflow
- `WAP.cancel(runId)` — Cancel an in-progress workflow run
- `WAP.getDefinitions()` — List all registered workflow definitions for the current shop

**Built-in workflows:**

| Workflow ID | Trigger | Description |
|---|---|---|
| `order_fulfillment` | `order.created` | Notify seller, update inventory, dispatch rider |
| `seller_onboarding` | `seller.approved` | Welcome email, tutorial, first listing prompt |
| `payment_recovery` | `payment.failed` | Retry payment, notify buyer, hold order |
| `inventory_reorder` | `stock.low` | Alert seller, optionally auto-reorder from supplier |
| `loyalty_award` | `order.completed` | Calculate and credit loyalty points |
| `review_request` | `delivery.completed` | Send review request email/SMS after 2 hours |
| `subscription_renewal` | `subscription.due` | Send renewal reminder, attempt auto-charge |

**Usage example:**

```js
// Initialize WAP (requires SokoniPlatform to be initialized first)
await WAP.init({ shopId: 'shop_abc123' });

// Trigger a workflow
const { runId } = await WAP.trigger('order_fulfillment', {
  orderId: 'ord_000111',
  sellerId: 'uid_seller_xyz',
  buyerId: 'uid_buyer_abc'
});
console.log('Workflow started, run ID:', runId);

// Poll for status
const status = await WAP.getStatus(runId);
console.log(status.state);   // 'running', 'completed', 'failed', 'cancelled'
console.log(status.steps);   // Array of step results

// Register a custom workflow
await WAP.register({
  id: 'custom_upsell',
  name: 'Post-Purchase Upsell',
  trigger: 'order.completed',
  steps: [
    { handler: 'wait', params: { hours: 1 } },
    { handler: 'send_notification', params: { template: 'upsell_v1' } },
    { handler: 'log_event', params: { name: 'upsell_sent' } }
  ]
});
```

---

### 7.10 redis-service.js

**File path:** `/functions/redis-service.js` (Cloud Functions internal — not a client SDK)

**Description:** Internal Redis caching SDK used by Cloud Functions. Wraps `ioredis` with SOKONI-specific TTL constants, namespace prefixing, pipeline batching, and automatic fallback to Firestore when Redis is unavailable. Only runs server-side inside Cloud Functions.

**Key exports:**

- `RedisService.get(key)` — Get a cached value by key; returns `null` on miss or Redis unavailability
- `RedisService.set(key, value, ttlSeconds)` — Set a value with TTL; no-ops if Redis unavailable
- `RedisService.invalidate(key)` — Delete a specific cache key
- `RedisService.invalidatePattern(pattern)` — Delete all keys matching a glob pattern
- `RedisService.pipeline(ops[])` — Execute multiple get/set operations in a single Redis round-trip
- `RedisService.isAvailable()` — Returns boolean indicating Redis connectivity status

**TTL constants (defined in `redis-service.js`):**

| Constant | Seconds | Used For |
|---|---|---|
| `TTL.SESSION` | 3600 | User session data |
| `TTL.PRODUCT_LIST` | 300 | Product listing pages |
| `TTL.PRODUCT_DETAIL` | 600 | Individual product pages |
| `TTL.RATE_LIMIT` | 60 | Rate limit counters |
| `TTL.ANALYTICS` | 1800 | Analytics aggregates |
| `TTL.SEARCH_RESULT` | 120 | Search result caches |

**Usage example (inside a Cloud Function):**

```js
const { RedisService } = require('./redis-service');

exports.getProductList = onCall(async (request) => {
  const { shopId, page } = request.data;
  const cacheKey = `products:${shopId}:page:${page}`;

  // Try cache first
  const cached = await RedisService.get(cacheKey);
  if (cached) {
    return { products: cached, source: 'cache' };
  }

  // Cache miss — query Firestore
  const snapshot = await admin.firestore()
    .collection('products')
    .where('shopId', '==', shopId)
    .where('status', '==', 'active')
    .limit(20)
    .offset(page * 20)
    .get();

  const products = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));

  // Populate cache for next request
  await RedisService.set(cacheKey, products, RedisService.TTL.PRODUCT_LIST);

  return { products, source: 'firestore' };
});
```

---

## 8. Rate Limits

SOKONI enforces rate limits at multiple layers to protect platform stability and prevent abuse. Limits are enforced server-side in Cloud Functions using Redis counters (with Firestore fallback).

| Role | Role Level | CF Calls / min | API Key Calls / min | Auth Endpoint | Notes |
|---|---|---|---|---|---|
| Guest | 0 | 10 | N/A | Public endpoints only | Unauthenticated; IP-based limiting |
| Buyer | 1 | 30 | N/A | Firebase Auth | Standard registered user |
| Seller | 2 | 60 | 20 | Firebase Auth | Shop operations; API keys available |
| Manager | 3 | 120 | 60 | Firebase Auth + MFA | Developer portal access |
| Admin | 4 | 300 | 200 | Firebase Auth + MFA | Platform-wide operations |
| Super Admin | 5 | Unlimited | Unlimited | Firebase Auth + MFA + step-up | Full access; audit-logged |
| API Key (`marketplace:read`) | N/A | N/A | 100 / min | API Key (HMAC) | Read-only integration |
| API Key (`marketplace:write`) | N/A | N/A | 30 / min | API Key (HMAC) | Write integration |
| API Key (`pos:write`) | N/A | N/A | 30 / min | API Key (HMAC) | POS sales recording |
| API Key (`admin:read`) | N/A | N/A | 50 / min | API Key (HMAC) | Admin read access |

### Payment Endpoint Rate Limits

Payment endpoints enforce a **dual rate limit** independent of the table above:

- **Per UID:** Maximum 5 payment initiation requests per minute per user
- **Per IP:** Maximum 10 payment initiation requests per minute per IP address
- Both limits must pass — whichever is hit first results in a `resource-exhausted` error

This dual limit prevents both account-level abuse (e.g., a compromised account making many payments) and network-level abuse (e.g., a single device cycling through UIDs).

### Rate Limit Behavior

When a rate limit is exceeded:

1. The Cloud Function returns `HttpsError` with code `resource-exhausted`
2. The response includes a `Retry-After` value in `error.details.retryAfterSeconds`
3. The event is logged to the security audit trail
4. Repeated violations trigger an alert to the platform operations team

**Recommended backoff strategy:**

```js
async function callWithBackoff(fnName, params, maxRetries = 3) {
  const fn = firebase.functions().httpsCallable(fnName);
  let attempt = 0;
  let delay = 1000; // Start with 1 second

  while (attempt < maxRetries) {
    try {
      return await fn(params);
    } catch (err) {
      if (err.code === 'functions/resource-exhausted') {
        const retryAfter = err.details?.retryAfterSeconds ?? (delay / 1000);
        await new Promise(r => setTimeout(r, retryAfter * 1000));
        delay *= 2; // Exponential backoff
        attempt++;
      } else {
        throw err; // Non-retryable error
      }
    }
  }
  throw new Error(`Max retries (${maxRetries}) exceeded for ${fnName}`);
}
```

---

## 9. Error Codes

All SOKONI Cloud Functions use Firebase `HttpsError` with the following standardized error codes. The error object always contains `code`, `message`, and optionally `details` with structured context.

| Code | HTTP Status | Description | How to Handle |
|---|---|---|---|
| `unauthenticated` | 401 | No valid Firebase ID token provided | Sign in the user and retry the request |
| `permission-denied` | 403 | Insufficient role, missing claim, or resource ownership mismatch | Upgrade account, request access from admin, or check resource ownership |
| `not-found` | 404 | Requested resource does not exist in Firestore | Verify the ID is correct; the resource may have been deleted |
| `already-exists` | 409 | Attempt to create a duplicate resource | Use the existing resource; check for idempotency key conflicts |
| `resource-exhausted` | 429 | Rate limit exceeded | Implement exponential backoff; check `error.details.retryAfterSeconds` |
| `invalid-argument` | 400 | Required parameter is missing or has an invalid format | Fix request parameters per the CF documentation and retry |
| `failed-precondition` | 400 | Business logic precondition not met | Check the business state (e.g., order already completed, payment already processed) |
| `deadline-exceeded` | 504 | Cloud Function execution timed out | Retry the request; for reports, consider async generation patterns |
| `internal` | 500 | Unexpected server-side error | Log `error.details.requestId` and report to dev@mysokoni.co.ke |
| `unavailable` | 503 | Service temporarily unavailable | Retry with exponential backoff; check platform status |
| `out-of-range` | 400 | Value is valid in type but outside permitted business range | Check value constraints in the CF documentation |
| `aborted` | 409 | Concurrent modification conflict (Firestore transaction conflict) | Retry the operation — conflicts resolve on retry in most cases |

### Error Handling Code Pattern

```js
async function safeCFCall(functionName, params) {
  try {
    const fn = firebase.functions().httpsCallable(functionName);
    const result = await fn(params);
    return result.data;
  } catch (err) {
    // err.code is in the form 'functions/error-code'
    switch (err.code) {
      case 'functions/unauthenticated':
        // Token expired or not present — redirect to sign-in
        await firebase.auth().signOut();
        window.location.href = '/login.html';
        break;

      case 'functions/permission-denied':
        // User lacks the required role or claim
        showToast('You do not have permission to perform this action.');
        break;

      case 'functions/resource-exhausted':
        // Rate limited — back off and retry
        const retryAfter = err.details?.retryAfterSeconds ?? 5;
        showToast(`Too many requests. Retrying in ${retryAfter} seconds...`);
        await new Promise(r => setTimeout(r, retryAfter * 1000));
        return safeCFCall(functionName, params); // Single retry

      case 'functions/not-found':
        showToast('The requested item no longer exists.');
        break;

      case 'functions/already-exists':
        showToast('This item already exists. Refreshing...');
        await refreshCurrentView();
        break;

      case 'functions/invalid-argument':
        // Validation error — err.message contains field-level details
        showToast(`Invalid input: ${err.message}`);
        console.error('Validation details:', err.details);
        break;

      case 'functions/failed-precondition':
        showToast(`Cannot complete this action: ${err.message}`);
        break;

      case 'functions/aborted':
        // Firestore transaction conflict — retry is safe
        console.warn('Transaction conflict, retrying...');
        return safeCFCall(functionName, params);

      case 'functions/internal':
        // Log the request ID for support
        console.error(`Internal error [${err.details?.requestId}]:`, err.message);
        showToast('An unexpected error occurred. Please try again or contact support.');
        break;

      case 'functions/unavailable':
      case 'functions/deadline-exceeded':
        showToast('Service is temporarily unavailable. Please try again shortly.');
        break;

      default:
        console.error(`Unhandled CF error [${err.code}]:`, err.message);
        showToast('Something went wrong. Please try again.');
    }

    // Re-throw for callers that need to handle the error themselves
    throw err;
  }
}
```

---

## 10. Security

SOKONI is built to financial-grade security standards. Every layer — from client-side input to Firestore rules to Cloud Function authorization — applies defense in depth. This section describes the key security mechanisms that apply to all developers integrating with the platform.

See also: [[Security]], [[Authentication]]

### 10.1 Firebase App Check

Firebase App Check is enforced on all three Firebase services. Requests without a valid App Check token are rejected before any authorization or business logic runs.

| Platform | Provider | Notes |
|---|---|---|
| Web (browser) | reCAPTCHA v3 | Site key configured in `sokoni-config.js` |
| Android | Play Integrity | Fallback to SafetyNet for older devices |
| iOS | App Attest | Fallback to DeviceCheck for older devices |
| Local development | Firebase Debug Token | Token obtained from Firebase console; set `window.SOKONI_APPCHECK_DEBUG = true` |

**Debug tokens for local development:**

1. Open the Firebase console → App Check → Your app → Overflow menu → Manage debug tokens
2. Create a debug token and copy it
3. Before loading `sokoni-appcheck.js`, set:
   ```js
   window.SOKONI_APPCHECK_DEBUG_TOKEN = 'your-debug-token-here';
   window.SOKONI_APPCHECK_DEBUG = true;
   ```
4. Debug tokens work only in debug/emulator builds. They must never be embedded in production code.

### 10.2 Attribute-Based Access Control (ABAC)

Every Cloud Function performs multi-attribute authorization before executing business logic. The ABAC check validates:

1. **Identity:** `uid` must be present and the Firebase ID token must be cryptographically valid
2. **Role:** `role >= N` where N is the minimum role for the operation
3. **Ownership:** For shop-scoped operations, `token.shopId === resource.shopId`
4. **Claim:** Custom claims like `verified: true`, `developer: true`, or `tier` are checked where relevant
5. **Step-up:** For sensitive operations, a valid step-up token must be present in `request.data.stepUpToken`

No resource can be read, written, or deleted without satisfying all applicable ABAC conditions. Admin users (role >= 4) can access resources they do not own; super admins (role 5) bypass ownership checks for operational purposes.

**Firestore Security Rules** mirror the same ABAC logic for any direct client-side Firestore access, ensuring defense in depth even if a Cloud Function is bypassed.

### 10.3 Step-Up Authentication

Sensitive operations require a step-up authentication event within the last 15 minutes. Step-up is implemented as a two-step challenge-response flow.

**Operations requiring step-up:**

- Initiating payments above KES 50,000
- Creating, revoking, or listing API keys
- Admin-level Cloud Function calls (role >= 4)
- Passkey registration and management
- Changing account email or phone number
- Downloading financial reports

**Step-up flow:**

```js
// Step 1: Initiate the step-up challenge
const initStepUp = firebase.functions().httpsCallable('initiateStepUp');
const { challengeId, method } = (await initStepUp({ reason: 'api_key_creation' })).data;
// method is 'totp' or 'passkey' based on what the user has enrolled

// Step 2a: TOTP verification
const verifyTOTP = firebase.functions().httpsCallable('verifyStepUp');
const { stepUpToken } = (await verifyTOTP({
  challengeId,
  code: userEnteredTOTPCode // 6-digit code from authenticator app
})).data;

// Step 2b: Passkey verification (alternative to TOTP)
const assertion = await navigator.credentials.get({ publicKey: challengeOptions });
const { stepUpToken } = (await verifyTOTP({
  challengeId,
  assertion: JSON.stringify(assertion)
})).data;

// Step 3: Pass stepUpToken in the sensitive CF call
const createKey = firebase.functions().httpsCallable('createAPIKey');
const result = await createKey({
  name: 'My Integration',
  permissions: ['orders:read'],
  stepUpToken  // Required for this operation
});
```

The `stepUpToken` is a signed JWT valid for 15 minutes, stored server-side in `users/{uid}/stepUpSessions/{sessionId}`. Attempting a sensitive operation with an expired or missing step-up token returns `permission-denied` with `details.requiresStepUp: true`.

### 10.4 Input Validation

All inputs to Cloud Functions are validated server-side before any Firestore read or write occurs:

- **Schema validation:** All CF inputs are validated against Joi schemas. Invalid or unexpected fields are stripped before processing.
- **Type coercion:** Numeric fields are coerced and range-checked (e.g., `amount > 0 && amount <= 10000000`).
- **Sanitization:** String fields that flow into Firestore queries are sanitized to prevent injection patterns.
- **Output escaping:** All client-side rendering of user-generated content uses `escHtml()` before DOM insertion. No `innerHTML` with user content; no `eval()` anywhere in the platform.
- **Content Security Policy:** Firebase Hosting serves CSP headers that block inline scripts, disallow `eval()`, and restrict external resource origins.
- **XSS protection:** 9 historical XSS vectors have been patched and regression tests exist for each.

Developers building integrations must apply the same standards: validate all inputs from SOKONI webhooks, escape all data before rendering in HTML, and never trust any field in a webhook payload as safe for direct DOM insertion.

---

## 11. Getting Started Checklist

Follow this checklist in order when integrating with the SOKONI Developer Platform:

- [ ] Request developer access — contact dev@mysokoni.co.ke or ask a platform admin to set `developer: true` on your Firebase UID, or ensure your account has `role >= 3`
- [ ] Sign in to the developer portal at `/developer-portal.html` and confirm access
- [ ] Review the platform architecture in [[Architecture]] to understand module boundaries
- [ ] Do **not** copy `sokoni-config.js` — reference the hosted file via `<script src="https://yourdomain/sokoni-config.js"></script>` to always receive the latest config
- [ ] Initialize Firebase in your project using the config object exported by `sokoni-config.js`
- [ ] Load `sokoni-appcheck.js` before any Firebase SDK call to enable App Check enforcement
- [ ] For local development, obtain a debug App Check token from the Firebase console and configure `window.SOKONI_APPCHECK_DEBUG = true` before loading `sokoni-appcheck.js`
- [ ] Obtain a Firebase ID token via `firebase.auth().currentUser.getIdToken()` and confirm your role and claims are correct
- [ ] Test your first Cloud Function call using the pattern in Section 3
- [ ] If building a server-to-server integration, create an API key via `createAPIKey` with only the minimum required permissions
- [ ] If you need real-time event notifications, register a webhook endpoint via `registerWebhook` and implement HMAC-SHA256 signature verification (Section 6.3)
- [ ] Review the Rate Limits table (Section 8) and implement exponential backoff in your integration before going to production
- [ ] Review the Error Codes table (Section 9) and implement the full error handling pattern in your code
- [ ] Read Section 10 (Security) and ensure App Check is enforced in your integration, and that you are verifying webhook signatures
- [ ] Test step-up authentication flows if your integration touches payment initiation or API key management
- [ ] Run your integration against the Firebase Emulator Suite before hitting production
- [ ] Join the developer community or contact the engineering team at dev@mysokoni.co.ke

---

*Last updated: 2026-06-28 | SOKONI Enterprise Platform v2.0*

*Internal wiki: [[Architecture]] | [[Authentication]] | [[Payments]] | [[SmartPOS]] | [[Logistics]] | [[Security]] | [[Cloud Functions]]*
