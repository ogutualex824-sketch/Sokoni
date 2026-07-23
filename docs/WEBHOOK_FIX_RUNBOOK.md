# Webhook Fix Runbook — Phases 1–3
## Subscription Activation Recovery

**Date:** 2026-07-23
**Commit:** `9d67dda`
**Status:** ENGINEERING COMPLETE — awaiting secret provisioning, deploy, and replay

---

## Why this matters

Every IntaSend payment since launch has been rejected with HTTP 401. `payments/COMPLETE = 0`
across the entire collection. No subscription has ever activated via the authoritative webhook
path. The cause is confirmed from production request data (see
`docs/PAYMENT_WEBHOOK_INVALID_SIGNATURE.md`): the code required an `x-intasend-signature`
header; IntaSend never sends one. IntaSend authenticates with a `challenge` value in the
request body. The fix is deployed code. This runbook makes it operational.

---

## Phase 1 — Provision the secret and deploy

### Step 1: Find your IntaSend webhook challenge

Go to: **IntaSend Dashboard → Webhooks → Webhook settings**

You will see a "Webhook challenge" or "Security secret" field. Copy that value exactly.
If no challenge is configured, set one now — use a random 16-char string.

> The challenge value must match exactly (case-sensitive) between the dashboard
> and Secret Manager.

### Step 2: Store the challenge in Secret Manager

```bash
# Create the secret
gcloud secrets create INTASEND_WEBHOOK_CHALLENGE \
  --replication-policy=automatic \
  --project=sokoni-app

# Store the value (replace YOUR_CHALLENGE_VALUE — no trailing newline)
printf 'YOUR_CHALLENGE_VALUE' | \
  gcloud secrets versions add INTASEND_WEBHOOK_CHALLENGE \
  --data-file=- \
  --project=sokoni-app

# Verify it was stored correctly
gcloud secrets versions access latest \
  --secret=INTASEND_WEBHOOK_CHALLENGE \
  --project=sokoni-app
```

### Step 3: Grant the Cloud Function access

```bash
# Grant the default App Engine service account (used by Gen2 CFs) access
gcloud secrets add-iam-policy-binding INTASEND_WEBHOOK_CHALLENGE \
  --member="serviceAccount:sokoni-app@appspot.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor" \
  --project=sokoni-app
```

### Step 4: Deploy only the webhook function

```bash
firebase deploy --only functions:intasendWebhook
```

Wait for the deployment to complete. Do not deploy other functions simultaneously.

### Step 5: Smoke-test with a challenge-correct ping

```bash
# This should return 200 OK (body = OK)
curl -s -o /dev/null -w "%{http_code}" \
  -X POST https://us-central1-sokoni-app.cloudfunctions.net/intasendWebhook \
  -H "Content-Type: application/json" \
  -d '{"challenge":"YOUR_CHALLENGE_VALUE","invoice":{"invoice_id":"test","state":"PENDING","api_ref":"SMOKE-TEST-1"}}'

# This should return 401 Unauthorized
curl -s -o /dev/null -w "%{http_code}" \
  -X POST https://us-central1-sokoni-app.cloudfunctions.net/intasendWebhook \
  -H "Content-Type: application/json" \
  -d '{"challenge":"wrong","invoice":{"invoice_id":"test","state":"PENDING","api_ref":"SMOKE-TEST-2"}}'
```

Expected: `200` for correct challenge, `401` for wrong challenge. If both return 200, the
secret was not stored correctly. If both return 401, the secret value doesn't match.

---

## Phase 2 — Replay KBQE4OW

**Reference transaction:**
- IntaSend tracking reference: `KBQE4OW`
- Amount: KES 499
- Date: 2026-07-20 21:12 EAT
- Payments doc: `payments/SKNTJKAS8` (currently PENDING)
- PaymentIntent doc: `paymentIntents/SKN3550FD490`
- Merchant UID: `xrH21J5GFbW8PluCZ2ny5nIuf602`

### Option A: Replay via IntaSend dashboard (preferred)

1. Go to **IntaSend Dashboard → Webhooks → Delivery history**
2. Find the delivery for `KBQE4OW` (sent 2026-07-20 18:12 UTC)
3. Click **Retry** or **Resend**
4. Watch the webhook logs in Cloud Logging

### Option B: Manual replay via curl (if dashboard replay is not available)

Reproduce the exact webhook body structure IntaSend sent (confirmed from `diag.bodySample`):

```bash
curl -X POST https://us-central1-sokoni-app.cloudfunctions.net/intasendWebhook \
  -H "Content-Type: application/json" \
  -d '{
    "challenge": "YOUR_CHALLENGE_VALUE",
    "invoice": {
      "invoice_id": "KBQE4OW",
      "state": "COMPLETE",
      "api_ref": "SKNTJKAS8",
      "net_amount": 499,
      "amount": 499,
      "currency": "KES",
      "provider": "M-PESA"
    }
  }'
```

> **Warning:** This writes a real COMPLETE record to production Firestore and activates a
> real subscription. Use only when the Phase 1 smoke test has passed and you are ready
> to activate the KASS VAPES merchant account (UID `xrH21J5GFbW8PluCZ2ny5nIuf602`).

### What to observe during replay

Watch the following in parallel:

**Cloud Logging** (`gcloud logging read 'resource.type="cloud_function" AND resource.labels.function_name="intasendWebhook"' --limit=20`):

| Step | Log line | Means |
|---|---|---|
| Auth pass | No "challenge mismatch" warning | Challenge verified correctly |
| Payment claimed | `intasendWebhook: Already processed` absent | Transaction claimed |
| Commission | No `commissionReviewQueue` entry | Rate calculated correctly |
| Subscription | `Subscription auto-activated { uid, plan, ref }` | Activation executed |

**Firestore** (Firebase console, immediately after replay):

| Collection / Document | Field | Expected value |
|---|---|---|
| `payments/SKNTJKAS8` | `status` | `COMPLETE` |
| `payments/SKNTJKAS8` | `intasendState` | `COMPLETE` |
| `subscriptions/{uid}` | `status` | `active` |
| `subscriptions/{uid}` | `plan` | the plan from the paymentIntent |
| `subscriptions/{uid}` | `source` | `intasend_webhook` |
| `subscriptionAuditLog` | new doc | `action: "ACTIVATED"` |
| `commissionLedger/SKNTJKAS8` | `status` | `auto_collected` |

---

## Phase 3 — If replay reaches payment COMPLETE but subscription stays Free

If you observe `payments/SKNTJKAS8.status = COMPLETE` but the merchant dashboard still
shows Free / Trial, the activation chain has a second bug. The investigation steps:

### 3a. Check the subscription document was written

```
Firestore → subscriptions → {uid: xrH21J5GFbW8PluCZ2ny5nIuf602}
```

If the document does not exist (or still has `plan: seller_free`), the webhook reached
the subscription block but did not write. Check Cloud Logging for:
```
[intasendWebhook] Subscription auto-activation failed
```

### 3b. If activation threw — check the paymentIntents document

The activation code reads:
```js
db.collection("paymentIntents").doc(apiRef).get()
```
where `apiRef = invoice?.api_ref`. From the webhook body above, `api_ref = "SKNTJKAS8"`.

Open Firestore → `paymentIntents/SKNTJKAS8`. If this document does not exist (or has
a different `api_ref` as its ID), the `intentSnap.exists` check will be false and the
subscription block is silently skipped with no log entry.

Cross-check: the payment intent was created with ID `SKN3550FD490`. If the `api_ref`
stored in that document is `SKNTJKAS8`, the lookup uses the wrong ID and will miss it.
The fix is to look up by `api_ref` field rather than document ID.

### 3c. Check the subscription document key

The entitlement reader in `getProviderPlan` reads `subscriptions/{uid}`.
The webhook activation writes `subscriptions/{intent.uid}`.
If the existing subscription doc is keyed differently (e.g. by SOK merchant ID), the
written doc will exist but the reader will miss it. This is the architectural keying
inconsistency flagged in Phase 4 — it would surface as a second bug here.

### 3d. Check the entitlement reader

After a successful subscription write, verify `getProviderPlan` returns the new plan:
```
Cloud Logging → function_name="getProviderPlan" → uid = xrH21J5GFbW8PluCZ2ny5nIuf602
```

---

## Deployment sequence summary

```
Step 1  gcloud secrets create INTASEND_WEBHOOK_CHALLENGE
Step 2  gcloud secrets versions add ... --data-file=-
Step 3  gcloud secrets add-iam-policy-binding ...
Step 4  firebase deploy --only functions:intasendWebhook
Step 5  Smoke test (correct challenge → 200, wrong → 401)
Step 6  Replay KBQE4OW from IntaSend dashboard
Step 7  Verify full chain in Firestore + Cloud Logging
```

---

## Security invariants maintained

| Invariant | Before | After |
|---|---|---|
| Fail-closed on auth failure | HTTP 401 | HTTP 401 |
| Constant-time comparison | `timingSafeEqual` on hex strings | `timingSafeEqual` on 32-byte HMAC digests |
| No secret in logs | Correct | Correct — only `challengeLen` (integer) logged |
| No bypass | Correct | Correct — auth failure returns immediately |

The change is a drop-in replacement. The verification mechanism changed; the security
posture (fail-closed, constant-time, no secret exposure) is identical.

---

## Related documents

- `docs/PAYMENT_WEBHOOK_INVALID_SIGNATURE.md` — root cause investigation
- `docs/ENGINEERING_STANDARD.md` — methodology used in this investigation
- `functions/index.js:5605` — `exports.intasendWebhook` (the changed function)
