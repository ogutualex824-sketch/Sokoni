# Webhook Fix Runbook — Phases 1–3
## Subscription Activation Recovery

**Date:** 2026-07-23
**Commits:** `9d67dda` (auth fix), `72c966e` (startup guard)
**Status:** ENGINEERING COMPLETE — awaiting secret provisioning, deploy, and replay

**GCP project:** `sokoni-aeb26`
**CF runtime service account:** `24799054989-compute@developer.gserviceaccount.com` (Default compute, used by Gen2 CFs)

---

## Why this matters

Every IntaSend payment since launch has been rejected with HTTP 401. `payments/COMPLETE = 0`
across the entire collection. No subscription has ever activated via the authoritative webhook
path. The cause is confirmed from production request data (see
`docs/PAYMENT_WEBHOOK_INVALID_SIGNATURE.md`): the code required an `x-intasend-signature`
header; IntaSend never sends one. IntaSend authenticates with a `challenge` value in the
request body. The fix is in committed code. This runbook makes it operational.

---

## Phase 1 — Provision the secret and deploy

### Step 1: Find your IntaSend webhook challenge

Go to: **IntaSend Dashboard → Webhooks → Webhook settings**

You will see a "Webhook challenge" or "Security secret" field. Copy that value exactly.
If no challenge is configured, set one now — use a random 16-char alphanumeric string.

> The challenge value must match exactly (case-sensitive) between the dashboard
> and Secret Manager. The production requests showed `challengeLen = 12`, so the
> configured value is 12 characters.

### Step 2: Store the challenge in Secret Manager

First check whether the secret already exists:

```bash
gcloud secrets describe INTASEND_WEBHOOK_CHALLENGE --project=sokoni-aeb26 2>&1
```

**If it does NOT exist** (error: "NOT_FOUND"):

```bash
# Create and populate in one step (echo -n avoids a trailing newline)
echo -n "YOUR_CHALLENGE_VALUE" | \
  gcloud secrets create INTASEND_WEBHOOK_CHALLENGE \
  --data-file=- \
  --replication-policy=automatic \
  --project=sokoni-aeb26
```

**If it already EXISTS**:

```bash
# Add a new version — do not re-run secrets create
echo -n "YOUR_CHALLENGE_VALUE" | \
  gcloud secrets versions add INTASEND_WEBHOOK_CHALLENGE \
  --data-file=- \
  --project=sokoni-aeb26
```

Then verify the stored value matches the dashboard exactly:

```bash
gcloud secrets versions access latest \
  --secret=INTASEND_WEBHOOK_CHALLENGE \
  --project=sokoni-aeb26
```

### Step 3: Grant the Gen2 Cloud Function runtime access

```bash
gcloud secrets add-iam-policy-binding INTASEND_WEBHOOK_CHALLENGE \
  --member="serviceAccount:24799054989-compute@developer.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor" \
  --project=sokoni-aeb26
```

Confirm the binding was added:

```bash
gcloud secrets get-iam-policy INTASEND_WEBHOOK_CHALLENGE \
  --project=sokoni-aeb26
```

Expected output includes:
```
- members:
  - serviceAccount:24799054989-compute@developer.gserviceaccount.com
  role: roles/secretmanager.secretAccessor
```

### Step 4: Deploy

```bash
firebase deploy --only functions:intasendWebhook
```

Wait for exit code 0. Do not deploy other functions concurrently.

### Step 5: Startup validation — confirm secret is reachable

Send a request with the correct challenge before the replay. This exercises the
secret-read path and confirms the IAM grant works. It also surfaces the startup guard
added to the function: if `INTASEND_WEBHOOK_CHALLENGE.value()` is empty, the function
returns 500 (not 401), which means the IAM grant or secret version is missing.

```bash
# Should return 200 OK
# (no payment in Firestore for SMOKE-TEST-1 so the function exits early with 200)
curl -s -w "\nHTTP %{http_code}\n" \
  -X POST https://us-central1-sokoni-aeb26.cloudfunctions.net/intasendWebhook \
  -H "Content-Type: application/json" \
  -d '{"challenge":"YOUR_CHALLENGE_VALUE","invoice":{"invoice_id":"SMOKE-TEST-1","state":"PENDING","api_ref":"SMOKE-TEST-1"}}'

# Should return 401 Unauthorized
curl -s -w "\nHTTP %{http_code}\n" \
  -X POST https://us-central1-sokoni-aeb26.cloudfunctions.net/intasendWebhook \
  -H "Content-Type: application/json" \
  -d '{"challenge":"wrongvalue","invoice":{"invoice_id":"SMOKE-TEST-2","state":"PENDING","api_ref":"SMOKE-TEST-2"}}'
```

| Result (correct + wrong) | Diagnosis |
|---|---|
| **200 + 401** | Auth working correctly — proceed to replay |
| **500 + 500** | Secret not readable — IAM grant missing (Step 3) or secret version absent (Step 2) |
| **401 + 401** | Challenge value mismatch — re-read dashboard value, re-run Step 2 with corrected value |
| **200 + 200** | Should not happen — investigation needed |

The 500/401/200 distinction is deliberate: 500 = deployment configuration problem;
401 = authentication failure (wrong value); 200 = authentication passed.

Check Cloud Logging for startup details:
```bash
gcloud logging read \
  'resource.type="cloud_run_revision" AND resource.labels.service_name="intasendWebhook"' \
  --project=sokoni-aeb26 --limit=20 --format=json
```

Confirm no `INTASEND_WEBHOOK_CHALLENGE secret is empty` error entry.

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
4. Watch Cloud Logging immediately

### Option B: Manual replay via curl (if dashboard replay is not available)

```bash
curl -s -w "\nHTTP %{http_code}\n" \
  -X POST https://us-central1-sokoni-aeb26.cloudfunctions.net/intasendWebhook \
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

> **This writes a real COMPLETE record to production Firestore and activates a real
> subscription.** Use only after the smoke test passes and you are ready to activate
> the KASS VAPES merchant account (UID `xrH21J5GFbW8PluCZ2ny5nIuf602`).

### What to observe during replay

**Cloud Logging** (watch in real time):

```bash
gcloud logging read \
  'resource.type="cloud_run_revision" AND resource.labels.service_name="intasendWebhook"' \
  --project=sokoni-aeb26 --limit=30 --format=json
```

| Step | What to see | Means |
|---|---|---|
| Auth pass | No `challenge mismatch` warning | Challenge verified correctly |
| Payment claimed | No `Already processed (raced)` | Transaction claimed this invocation |
| Subscription | `Subscription auto-activated { uid, plan, ref }` | Activation block executed |
| Subscription miss | `[intasendWebhook] Subscription auto-activation failed` | Activation threw — see Phase 3 |

**Firestore** (Firebase console, immediately after replay):

| Path | Field | Expected |
|---|---|---|
| `payments/SKNTJKAS8` | `status` | `COMPLETE` |
| `payments/SKNTJKAS8` | `intasendState` | `COMPLETE` |
| `subscriptions/xrH21J5GFbW8PluCZ2ny5nIuf602` | `status` | `active` |
| `subscriptions/xrH21J5GFbW8PluCZ2ny5nIuf602` | `plan` | planId from the paymentIntent |
| `subscriptions/xrH21J5GFbW8PluCZ2ny5nIuf602` | `source` | `intasend_webhook` |
| `subscriptionAuditLog` | new doc | `action: "ACTIVATED"`, `source: "intasend_webhook"` |
| `commissionLedger/SKNTJKAS8` | `status` | `auto_collected` |

---

## Phase 3 — If replay reaches COMPLETE but subscription stays Free

This means the payment path is fixed but the activation path has a second bug.

### 3a. Check the subscription document was written

Open Firestore → `subscriptions` → look for document `xrH21J5GFbW8PluCZ2ny5nIuf602`.

- If it doesn't exist or still has `plan: seller_free`: activation ran but didn't write — check Cloud Logging for `Subscription auto-activation failed`
- If the existing subscription doc is `subscriptions/SOK-GL58F7` (keyed by SOK merchant ID, not UID): the webhook wrote to `subscriptions/{uid}` but the entitlement reader reads a different document — this is the Phase 4 keying issue surfacing as a live bug

### 3b. Check the paymentIntents document lookup

The activation code does:
```js
db.collection("paymentIntents").doc(apiRef).get()
// where apiRef = invoice?.api_ref = "SKNTJKAS8"
```

Open Firestore → `paymentIntents/SKNTJKAS8`. If this doc doesn't exist, the intent lookup silently returns `intentSnap.exists = false` and the subscription block is skipped with no log.

Cross-check: the known intent doc is `paymentIntents/SKN3550FD490`. If that document's `api_ref` field contains `SKNTJKAS8`, then the intent was indexed by `SKN3550FD490` but the webhook looks it up by `SKNTJKAS8` — key mismatch. The fix would be to look up by `api_ref` field query rather than document ID.

### 3c. Check the entitlement reader

Even if `subscriptions/xrH21J5GFbW8PluCZ2ny5nIuf602` was written correctly, the
pricing page and dashboard may still show Free if `getProviderPlan` reads a different
document. Check Cloud Logging for calls to `getProviderPlan` after the replay and see
which document path it reads.

---

## Deployment sequence summary

### Phase 1–3 (completed 2026-07-23)
```
┌─────────────────────────────────────────────────────────────┐
│  1. Confirmed root cause from production logs (challenge)   │
│  2. Provisioned INTASEND_WEBHOOK_CHALLENGE in Secret Mgr    │
│  3. Deployed intasendWebhook with challenge auth            │
│  4. Smoke test: correct → 200; wrong → 401 ✓               │
│  5. Added intentRef field to initiateSTKPush                │
│  6. Backfilled payments/SKNTJKAS8 intentRef field           │
└─────────────────────────────────────────────────────────────┘
```

### Phase 4 — Path B migration (2026-07-23, commit 8c59a09)
```
┌─────────────────────────────────────────────────────────────┐
│  Confirmed: IntaSend routes to webhookIntasend, not         │
│  intasendWebhook (Cloud Logging: 157.245.201.212 → 200)     │
│  IntaSend API /api/v1/webhooks/ requires session auth —     │
│  URL cannot be changed programmatically with API key.       │
│                                                             │
│  Path B: migrated challenge auth + subscription activation  │
│  into webhookIntasend (the function IntaSend actually calls)│
│                                                             │
│  1. Deploy webhookIntasend (firebase deploy)                │
│  2. Smoke test webhookIntasend: correct → 200; wrong → 401  │
│  3. Replay KBQE4OW or make new payment via IntaSend Retry   │
│  4. Verify: payments/<ref> status=COMPLETE                  │
│  5. Verify: subscriptions/<uid> status=active               │
│  6. Verify: merchant dashboard shows Starter entitlements   │
│  7. After stable observation period: decommission           │
│     intasendWebhook (stub or undeploy)                      │
└─────────────────────────────────────────────────────────────┘
```

---

## Phase 5 — Post-verification reconciliation

**Gates — do not start until all three are true:**
- `webhookIntasend` smoke test returns HTTP 200 for correct challenge
- A real IntaSend webhook successfully activates a subscription (end-to-end log evidence)
- Merchant dashboard shows Starter entitlement active

### Identifying the canonical payment

Open Firestore `payments`. Both KBQE4OW (`SKNTJKAS8`) and the second payment exist.
The canonical payment is the one whose `subscriptions/{uid}` document was written by
`webhookIntasend` with `source: "webhookIntasend"` and `status: "active"`.

### Duplicate payment record

The payment **did complete** — the refund is a subsequent financial event.
Do not overwrite `status`. Separate payment outcome from reconciliation outcome:

```js
// payments/<duplicateRef>  — Firestore update (merge)
{
  // status: "COMPLETE" preserved — payment did succeed
  reconciliationStatus: "REFUNDED",
  refundReason:         "Duplicate payment during webhook migration",
  canonicalPaymentRef:  "<canonicalRef>",
  refundedAt:           serverTimestamp(),
  refundedBy:           "admin_reconciliation"
}
```

### Duplicate subscription record

Do not delete or overwrite. Mark as reconciled:

```js
// subscriptions/<duplicateSubscriptionId>  — Firestore update (merge)
{
  status:            "duplicate",
  duplicateOf:       "<canonicalSubscriptionId>",
  duplicateReason:   "Webhook migration duplicate — paid during broken HMAC auth window",
  reconciledAt:      serverTimestamp(),
  reconciledBy:      "admin_reconciliation"
}
```

### Issue the refund

Use IntaSend dashboard or `POST /api/v1/send-money/mpesa/` to reverse the duplicate
payment amount to the merchant's phone. Record the IntaSend refund reference.

### Ledger entry

```js
// paymentLedger  — Firestore add
{
  type:               "refund",
  originalRef:        "<duplicateRef>",
  canonicalRef:       "<canonicalRef>",
  refundRef:          "<intasendRefundRef>",
  amount:             499,
  currency:           "KES",
  reason:             "Webhook migration duplicate",
  issuedAt:           serverTimestamp()
}
```

### Audit log entry

Single immutable `adminActions` document — never update after creation:

```js
{
  action:                    "WEBHOOK_MIGRATION_RECONCILIATION",
  actor:                     "admin",
  canonicalPaymentRef:       "<ref>",
  duplicatePaymentRef:       "<ref>",
  canonicalSubscriptionId:   "<id>",
  duplicateSubscriptionId:   "<id>",
  refundIssued:              true,
  refundRef:                 "<intasendRefundRef>",
  refundAmount:              499,
  timestamp:                 serverTimestamp(),
  notes:                     "Duplicate incurred during Phase 0 webhook migration (2026-07-23)"
}
```

### Final state check

```
subscriptions/<uid>  →  status: "active", plan: "starter"  (exactly one document)
payments/<canonical> →  status: "COMPLETE"
payments/<duplicate> →  status: "COMPLETE", reconciliationStatus: "REFUNDED"
```

---

## Security invariants maintained

| Invariant | Before | After |
|---|---|---|
| Fail-closed on auth failure | HTTP 401 | HTTP 401 |
| Empty secret detected | No guard | HTTP 500 (config error, not auth bypass) |
| Constant-time comparison | `timingSafeEqual` on hex strings | `timingSafeEqual` on 32-byte HMAC digests |
| No secret in logs | Correct | Correct — only `challengeLen` (integer) logged |
| No bypass | Correct | Correct — auth failure returns immediately |

---

## Related documents

- `docs/PAYMENT_WEBHOOK_INVALID_SIGNATURE.md` — root cause investigation (confirmed evidence)
- `docs/ENGINEERING_STANDARD.md` — investigation methodology
- `functions/index.js:6493` — `exports.webhookIntasend` (canonical, Path B migration)
- `functions/index.js:5613` — `exports.intasendWebhook` (secondary — pending decommission)
