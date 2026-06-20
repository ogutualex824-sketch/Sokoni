# WEBHOOK.md

# SOKONI Webhook Integration Guide

Version: 2.0
Date: 2026-06-20

Related: [[ARCHITECTURE]] [[docs/API]] [[docs/SECURITY]]

---

# Overview

SOKONI operates a hardened webhook platform that receives real-time payment notifications from external providers. All webhook endpoints share a common processing pipeline:

1. **Immediate ACK** — respond 200 before processing (prevents provider retries)
2. **Signature verification** — HMAC-SHA256 with timing-safe comparison
3. **Replay protection** — 5-minute timestamp window
4. **Idempotency** — duplicate events are silently skipped
5. **Structured handler** — parse → process → audit
6. **Dead-letter queue** — failed events are stored for admin replay

---

# Endpoint Reference

## IntaSend

```
POST https://us-central1-sokoni-aeb26.cloudfunctions.net/webhookIntasend
```

**Configure in:** IntaSend Dashboard → Settings → Webhooks

**Signature header:** `X-IntaSend-Signature`

**Algorithm:** HMAC-SHA256 of the raw JSON body using your IntaSend private key.

**Sample payload (COMPLETE):**
```json
{
  "invoice": {
    "invoice_id": "INV-123456",
    "recipient_phone": "+254712345678",
    "state": "COMPLETE",
    "value": "1500.00",
    "currency": "KES"
  },
  "id": "EVT-001",
  "state": "COMPLETE"
}
```

**Sample payload (FAILED):**
```json
{
  "invoice": {
    "invoice_id": "INV-123457",
    "state": "FAILED"
  },
  "state": "FAILED"
}
```

**Processing:** Only `state: "COMPLETE"` triggers a write to `webhookPayments`. All events are logged to `webhookLogs`.

---

## M-Pesa (Daraja)

```
POST https://us-central1-sokoni-aeb26.cloudfunctions.net/webhookMpesa
```

**Configure in:** Safaricom Daraja Console → STK Push → Callback URL

**No signature** — Daraja does not send signatures. The endpoint relies on Firestore security rules and the function's URL secrecy.

**Sample payload (success):**
```json
{
  "Body": {
    "stkCallback": {
      "MerchantRequestID": "29115-34620561-1",
      "CheckoutRequestID": "ws_CO_191220191020363925",
      "ResultCode": 0,
      "ResultDesc": "The service request is processed successfully.",
      "CallbackMetadata": {
        "Item": [
          { "Name": "Amount",              "Value": 1500 },
          { "Name": "MpesaReceiptNumber",  "Value": "NLJ7RT61SV" },
          { "Name": "TransactionDate",     "Value": 20191219102115 },
          { "Name": "PhoneNumber",         "Value": 254712345678 }
        ]
      }
    }
  }
}
```

**Sample payload (failure):**
```json
{
  "Body": {
    "stkCallback": {
      "ResultCode": 1032,
      "ResultDesc": "Request cancelled by user.",
      "CheckoutRequestID": "ws_CO_191220191020363926"
    }
  }
}
```

**Processing:** `ResultCode === 0` triggers a write to `webhookPayments`. Failed payments are logged but do not write to `webhookPayments`.

---

## Stripe

```
POST https://us-central1-sokoni-aeb26.cloudfunctions.net/webhookStripe
```

**Configure in:** Stripe Dashboard → Developers → Webhooks → Add endpoint

**Signature header:** `Stripe-Signature`

**Supported events:** `payment_intent.succeeded`

**Sample payload:**
```json
{
  "id": "evt_1OyXx2J3KA...",
  "type": "payment_intent.succeeded",
  "data": {
    "object": {
      "id": "pi_3OyXx2J3KA...",
      "amount_received": 150000,
      "currency": "usd"
    }
  }
}
```

---

## SmartPOS

```
POST https://us-central1-sokoni-aeb26.cloudfunctions.net/webhookSmartpos
```

**Allowed origins:** `https://mysokoni.co.ke` only.

**Sample payload:**
```json
{
  "transaction_id": "POS-20260620-001",
  "amount": 2500,
  "currency": "KES",
  "payment_method": "mpesa",
  "items": [
    { "name": "Chapati x3", "price": 90 }
  ],
  "cashier": "uid_abc123",
  "shop_id": "shop_xyz789"
}
```

**Processing:** Writes directly to `posTransactions` collection.

---

# Security Model

## Signature Verification

All providers that support webhook signatures use HMAC-SHA256 verification:

```
expected = "sha256=" + HMAC_SHA256(rawBody, secretKey)
actual   = request.headers["X-IntaSend-Signature"]  // or provider equivalent
```

Comparison uses `crypto.timingSafeEqual()` to prevent timing attacks.

If signature verification fails:
- Respond 200 (to prevent retries and information leakage)
- Log `invalid_signature` to `webhookLogs`
- Do NOT process the event

## Replay Protection

All webhooks enforce a 5-minute timestamp window:

```
if (abs(now/1000 - webhookTimestamp) > 300) { return; }
```

Providers that include a timestamp in headers or body are checked. Events older than 5 minutes are silently dropped and logged.

## Idempotency

Every incoming webhook is assigned an event ID (from the provider or generated). Before processing:

1. Check `webhookIdempotency/{provider}::{eventId}` in Firestore
2. If exists → skip (duplicate)
3. If not → write with `status: "processing"`, then process

After processing, update to `status: "processed"`.
After failure, update to `status: "failed"` and write to `webhookDLQ`.

Idempotency records are automatically cleaned up after 7 days by the `cleanupIdempotencyStore` scheduled function.

---

# Dead-Letter Queue (DLQ)

If a webhook handler throws an error, the event is written to `webhookDLQ`:

```js
{
  provider: "intasend",
  eventId: "INV-123456",
  body: { ... },           // original request body
  error: "timeout",
  attempts: 1,
  ts: Timestamp
}
```

## Replaying DLQ Events

Admin-only. Call the `replayWebhookDLQ` Cloud Function:

```js
const fn = httpsCallable(functions, "replayWebhookDLQ");
const result = await fn({ dlqId: "dlq_doc_id_here" });
// { success: true, dlqId, provider, eventId }
```

This moves the entry to `webhookRetryQueue` with `attempts + 1`.

## Monitoring DLQ Depth

```
GET https://us-central1-sokoni-aeb26.cloudfunctions.net/webhookHealth
```

Response:
```json
{
  "status": "healthy",
  "dlqDepth": 0,
  "retryQueue": 0,
  "ts": "2026-06-20T12:00:00.000Z"
}
```

`status: "degraded"` when `dlqDepth > 100`.

---

# Rate Limiting

Each provider has an independent sliding-window rate limit enforced by the client-side `sokoni-webhook-engine.js`:

| Provider | Limit |
|---|---|
| IntaSend | 100 req/min |
| M-Pesa | 60 req/min |
| Stripe | 200 req/min |
| SmartPOS | 500 req/min |

Requests exceeding the limit are rejected and logged. The Cloud Function endpoints themselves are protected by Firebase's built-in concurrency controls.

---

# Audit Log

Every webhook, regardless of outcome, is written to `webhookLogs`:

```js
{
  provider: "mpesa",
  eventId: "ws_CO_191220191020363925",
  status: "processed",     // or: invalid_signature, failed, duplicate
  payload: { ... },
  ts: Timestamp
}
```

Failed events additionally appear in `webhookDLQ`.

---

# Testing Webhooks

## IntaSend Test

Use IntaSend's sandbox environment (`https://sandbox.intasend.com`). Change `intasendLive: false` in `sokoni-config.js` during testing.

## M-Pesa Test

Use the existing `sendTestSTKPush` Cloud Function:

```js
const fn = httpsCallable(functions, "sendTestSTKPush");
await fn({ phone: "254712345678", amount: 1 });
```

## Manual Test (curl)

```bash
curl -X POST \
  https://us-central1-sokoni-aeb26.cloudfunctions.net/webhookSmartpos \
  -H "Content-Type: application/json" \
  -d '{"transaction_id":"TEST-001","amount":100,"currency":"KES"}'
```

SmartPOS does not require signature verification, making it safe for quick integration tests.

---

# Provider Configuration Checklist

| Provider | Configure | URL to set |
|---|---|---|
| IntaSend | Dashboard → Webhooks | `.../webhookIntasend` |
| M-Pesa Daraja | Console → STK Push → Callback | `.../webhookMpesa` |
| Stripe | Dashboard → Developers → Webhooks | `.../webhookStripe` |
| SmartPOS | Device settings | `.../webhookSmartpos` |

---

# Related Documents

* [[ARCHITECTURE]] — Full system architecture
* [[docs/API]] — Cloud Functions API reference
* [[docs/SECURITY]] — Security implementation details
