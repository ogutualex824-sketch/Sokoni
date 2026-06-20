# API.md

# SOKONI Cloud Functions API Reference

Version: 2.0
Date: 2026-06-20

Related: [[ARCHITECTURE]] [[docs/WEBHOOK]] [[docs/SECURITY]]

---

# Overview

All SOKONI backend operations are implemented as Firebase Cloud Functions v2 deployed to `us-central1`.

Base URL: `https://us-central1-sokoni-aeb26.cloudfunctions.net/`

## Authentication

All `onCall` functions require a valid Firebase ID token.

Admin-only functions additionally require the custom claim `admin: true` on the token.

The `sokoni-gateway.js` module automatically attaches the ID token to all requests.

## Calling from the client

```js
import { getFunctions, httpsCallable } from "firebase/functions";
const functions = getFunctions();
const fn = httpsCallable(functions, "functionName");
const result = await fn({ param1: "value" });
```

Or via the gateway:
```js
const result = await SokoniGateway.callFunction("functionName", { param1: "value" });
```

---

# Webhook Endpoints (HTTP)

See [[docs/WEBHOOK]] for full details.

| Endpoint | Method | Auth | Description |
|---|---|---|---|
| `/webhookIntasend` | POST | Signature | IntaSend payment notifications |
| `/webhookMpesa` | POST | None (URL secrecy) | M-Pesa Daraja callbacks |
| `/webhookStripe` | POST | Signature | Stripe payment events |
| `/webhookSmartpos` | POST | Origin-limited | SmartPOS transaction events |
| `/webhookHealth` | GET | None | DLQ depth and retry queue status |
| `/platformHealth` | GET | None | Firestore + Auth health check |

---

# Payment Engine

## releaseEscrow

Release held funds from an escrow to the seller after order completion.

**Auth:** Buyer, seller, or admin  
**Caller must be:** The buyer, the seller of the escrow, or an admin

**Request:**
```js
{
  escrowRef: "ESC-1719000000-ABCD",   // required
  note: "Delivery confirmed"           // optional
}
```

**Response:**
```js
{
  ref: "REL-1719000000-EFGH",
  status: "released",
  gross: 5000,
  sellerNet: 4250,      // after commission (10%) and WHT (5% if > KES 24,000)
  commission: 500,
  wht: 250,
  currency: "KES"
}
```

**Side effects:**
- Updates `escrows/{escrowRef}` status to `"released"`
- Writes 2–3 ledger entries to `paymentLedger`
- Writes audit entry to `auditLogs`
- Queues seller payment in `settlementQueue`
- Sends FCM push notification to seller

**Errors:**
| Code | Reason |
|---|---|
| `unauthenticated` | Not signed in |
| `not-found` | Escrow document does not exist |
| `failed-precondition` | Escrow is not in `active` status |
| `permission-denied` | Not the buyer, seller, or admin |

---

## initiateRefund

Initiate a refund to the buyer. Works against an escrow or a direct order.

**Auth:** Buyer or admin

**Request:**
```js
{
  orderId: "ORD-001",               // at least one of orderId or escrowRef required
  escrowRef: "ESC-1719000000-ABCD",
  amount: 1500,                     // optional — defaults to full escrow amount
  reason: "Item not as described"   // optional
}
```

**Response:**
```js
{
  ref: "RFD-1719000000-WXYZ",
  status: "pending",
  orderId: "ORD-001",
  reason: "Item not as described"
}
```

**Side effects:**
- Creates `refunds/{ref}` document
- If escrowRef provided: updates escrow to `"refunded"`, writes ledger entry
- Writes audit entry to `auditLogs`
- Sends FCM push notification to buyer

---

## getSettlementReport

Generate a settlement report for a seller or all sellers within a date range.

**Auth:** Admin only

**Request:**
```js
{
  sellerId: "uid_abc123",       // optional — omit for all sellers
  periodStart: "2026-06-01",   // ISO date string — required
  periodEnd:   "2026-06-30"    // ISO date string — required
}
```

**Response:**
```js
{
  period: { start: "2026-06-01", end: "2026-06-30" },
  sellerId: "uid_abc123",
  grossRevenue: 150000,
  commission: 15000,
  wht: 7500,
  sellerNet: 127500,
  orderCount: 32,
  vatLiability: 2400,       // VAT on commission (16%)
  dstLiability: 2250,       // DST on gross (1.5%)
  rows: [ ... ],             // individual escrow records
  generatedAt: "2026-06-20T12:00:00.000Z"
}
```

---

## initiateSellerPayout

Trigger an M-Pesa B2C payout to a seller via IntaSend.

**Auth:** Admin only

**Request:**
```js
{
  sellerId: "uid_abc123",   // required
  amount: 127500,           // KES amount — required
  phone: "254712345678",   // M-Pesa number — required
  method: "mpesa",          // optional — default "mpesa"
  reference: "PAY-001"      // optional — auto-generated if omitted
}
```

**Response:**
```js
{
  ref: "PAY-1719000000-ABCD",
  status: "submitted",        // or "pending_network"
  amount: 127500,
  method: "mpesa"
}
```

**Side effects:**
- Creates `settlements/{ref}` document
- Writes ledger entry: `platform:payable:{sellerId}` → `seller:{sellerId}:bank`
- Calls IntaSend B2C disbursement API
- Writes audit entry to `auditLogs`

---

## getLedgerBalance

Query the net balance of any double-entry ledger account.

**Auth:** Admin only

**Request:**
```js
{
  account: "platform:revenue",   // required — see account naming convention
  currency: "KES"                // optional — default "KES"
}
```

**Response:**
```js
{
  account: "platform:revenue",
  currency: "KES",
  balance: 45000,
  debitCount: 12,
  creditCount: 89
}
```

**Account naming:**

| Account | Meaning |
|---|---|
| `buyer:{uid}` | Buyer wallet |
| `seller:{uid}` | Seller receivable |
| `seller:{uid}:bank` | Seller bank payout account |
| `escrow:holding` | All funds currently in escrow |
| `platform:revenue` | Platform commission earned |
| `platform:tax_liability` | VAT + WHT collected |
| `platform:payable:{uid}` | Amount owed to a seller (pre-payout) |

---

# Fraud & Security

## evaluateFraudRisk

Evaluate the fraud risk of a payment attempt server-side.

**Auth:** Any signed-in user

**Request:**
```js
{
  event: "payment",           // optional — default "payment"
  amount: 50000,              // optional — triggers large-amount signal if > 500,000
  phone: "254712345678"       // optional
}
```

**Response:**
```js
{
  decision: "allow",          // "allow" | "review" | "block"
  score: 15,                  // 0-100
  signals: [],                // active risk signals
  blocked: false,
  requiresReview: false
}
```

**Signals:**
| Signal | Score | Trigger |
|---|---|---|
| `blocked_uid` | +100 | UID is in fraudBlocklist |
| `velocity_high` | +40 | 3+ payments in 5 minutes |
| `velocity_medium` | +20 | 8+ payments in 1 hour |
| `amount_large` | +15 | Amount > KES 500,000 |

**Decision thresholds:**
| Score | Decision |
|---|---|
| 0–30 | allow |
| 31–60 | review (proceed but flag) |
| 61–100 | block (reject payment) |

---

## fraudBlock

Add an entity to the fraud blocklist.

**Auth:** Admin only

**Request:**
```js
{
  type: "uid",                        // "uid" | "phone" | "email" | "ip"
  value: "uid_malicious_user",
  reason: "Multiple chargeback fraud"  // optional
}
```

**Response:**
```js
{
  success: true,
  type: "uid",
  value: "uid_malicious_user"
}
```

---

# Webhook Administration

## replayWebhookDLQ

Replay a failed webhook from the dead-letter queue.

**Auth:** Admin only

**Request:**
```js
{
  dlqId: "dlq_document_id"  // Firestore document ID in webhookDLQ collection
}
```

**Response:**
```js
{
  success: true,
  dlqId: "dlq_document_id",
  provider: "intasend",
  eventId: "INV-123456"
}
```

---

# Observability

## getPlatformMetrics

Return aggregated metrics for the admin dashboard.

**Auth:** Admin only

**Request:**
```js
{
  period: "today"   // "today" | "week" | "month" | "year"
}
```

**Response:**
```js
{
  period: "today",
  orders: {
    total: 47,
    byStatus: { "completed": 38, "pending": 7, "cancelled": 2 },
    gmv: 235000
  },
  payments: {
    total: 42
  },
  newUsers: 12,
  webhooks: {
    total: 89,
    byProvider: { "mpesa": 71, "intasend": 18 }
  },
  fraud: {
    flagged: 3,
    blocked: 1
  },
  generatedAt: "2026-06-20T12:00:00.000Z"
}
```

---

# AI Agent

## KASS (Admin AI)

Claude claude-sonnet-4-6 powered admin assistant with 16 tools.

**Auth:** Admin only

**Request:**
```js
{
  message: "Show me today's revenue breakdown",
  history: []   // optional conversation history
}
```

**Response:**
```js
{
  response: "Today's revenue is...",
  toolsUsed: ["getRevenueReport"]
}
```

Available tools: getRevenueReport, getOrderStats, getUserStats, getSecurityEvents, grantAdminClaim, revokeAdminClaim, updateSellerSubscription, getCommissionLedger, markCommissionPaid, sendFcm, sendSms, and more.

---

## sokoniChat

Customer-facing AI chat assistant.

**Auth:** Any signed-in user

**Request:**
```js
{
  message: "Where is my order?",
  context: { orderId: "ORD-001" }   // optional
}
```

---

# Existing Payment Functions

## darajaSTKPush

Initiate an M-Pesa STK Push via Safaricom Daraja API.

**Auth:** Any signed-in user

**Request:**
```js
{
  phone: "254712345678",
  amount: 1500,
  accountRef: "ORD-001",
  description: "Order payment"
}
```

---

## verifyIntasendPayment

Verify a completed IntaSend payment server-side.

**Auth:** Any signed-in user

**Request:**
```js
{
  invoiceId: "INV-123456"
}
```

---

## verifyPaymentStatus

Check the status of a Daraja STK push.

**Auth:** Any signed-in user

**Request:**
```js
{
  checkoutRequestId: "ws_CO_191220191020363925"
}
```

---

# Notification Functions

## sendSms

Send an SMS via Africa's Talking.

**Auth:** Any signed-in user (rate-limited internally)

**Request:**
```js
{
  phone: "+254712345678",
  message: "Your order has been confirmed."
}
```

---

## sendFcm

Send a Firebase Cloud Messaging push notification.

**Auth:** Admin or internal

**Request:**
```js
{
  token: "fcm_device_token",
  title: "Order Ready",
  body: "Your order is ready for pickup",
  link: "track.html"
}
```

---

# Admin Management

## bootstrapAdminClaim

Set the first admin account. Can only be called by `admin@mysokoni.co.ke`.

**Request:**
```js
{ email: "admin@mysokoni.co.ke" }
```

---

## grantAdminClaim

Grant admin role to a user.

**Auth:** Existing admin only

**Request:**
```js
{ uid: "user_uid" }
```

---

## revokeAdminClaim

Revoke admin role from a user.

**Auth:** Existing admin only

**Request:**
```js
{ uid: "user_uid" }
```

---

## updateSellerSubscription

Update a seller's subscription plan.

**Auth:** Admin only

**Request:**
```js
{
  sellerId: "uid_seller",
  plan: "pro",           // "free" | "pro" | "business" | "enterprise"
  months: 1
}
```

**Plans:**
| Plan | Monthly Price |
|---|---|
| free | KES 0 |
| pro | KES 999 |
| business | KES 2,999 |
| enterprise | Custom |

---

# Error Codes Reference

All `onCall` functions throw `HttpsError` with these codes:

| Code | Meaning |
|---|---|
| `unauthenticated` | No Firebase auth token or token invalid |
| `permission-denied` | Authenticated but lacks required role (e.g. admin) |
| `invalid-argument` | Required field missing or invalid value |
| `not-found` | Requested document does not exist |
| `failed-precondition` | Operation not valid in current state |
| `already-exists` | Resource already exists (idempotency) |
| `resource-exhausted` | Rate limit exceeded |
| `internal` | Unexpected server error |

---

# Rate Limits

Applied by `sokoni-gateway.js` on the client side:

| Operation type | Rate | Burst |
|---|---|---|
| payment | 2/second | 5 |
| order | 5/second | 10 |
| search | 10/second | 20 |
| auth | 3/second | 5 |
| upload | 1/2 seconds | 3 |
| default | 20/second | 40 |

Cloud Functions additionally enforce Firebase's built-in concurrency limits per region.

---

# Related Documents

* [[ARCHITECTURE]] — Full system architecture
* [[docs/WEBHOOK]] — Webhook integration guide
* [[docs/SECURITY]] — Security rules and threat model
* [[CHANGELOG]] — Full release history
