# SOKONI Production Operations Manual

**Platform:** SOKONI  
**Legal Entity:** Bravilex International Co. Limited  
**Environment:** Production (sokoni-aeb26)  
**Classification:** Internal — Confidential  
**Version:** 1.0 — 2026-07-13

---

## Platform Overview

SOKONI is a full-stack digital marketplace and super-platform serving Kenya, operated by Bravilex International Co. Limited. The production environment runs on:

- **Firebase Hosting** — static assets, HTML pages (`mysokoni.co.ke`)
- **Google Cloud Functions (Gen2)** — 606+ backend functions, Node.js 22
- **Cloud Firestore** — primary database
- **Google Cloud Storage** — media, documents, receipts
- **Firebase Authentication** — user identity
- **Google Secret Manager** — production secrets
- **SendGrid** — transactional email
- **Africa's Talking** — SMS (Kenya: Safaricom, Airtel, Telkom)
- **IntaSend** — payment processing (M-Pesa, cards)
- **Google Memorystore (Redis)** — rate limiting, caching
- **Algolia / Typesense** — search

---

## Production URLs

| Service | URL |
|---|---|
| Main platform | https://mysokoni.co.ke |
| Firebase Hosting (backup) | https://sokoni-aeb26.web.app |
| Firebase Console | https://console.firebase.google.com/project/sokoni-aeb26 |
| GCP Console | https://console.cloud.google.com/home/dashboard?project=sokoni-aeb26 |
| Admin OS | https://mysokoni.co.ke/admin-os.html |
| Operations Center | https://mysokoni.co.ke/ops-center.html |
| SmartPOS | https://mysokoni.co.ke/pos.html |
| Status page | https://mysokoni.co.ke/status.html |

---

## Daily Operations Checklist

### Every Morning (after 06:00 EAT)

1. **Read the daily ops report** — delivered to devops@mysokoni.co.ke at 06:00 EAT
   - Review CF error rates (flag anything > 5%)
   - Review payment success rate (flag anything < 95%)
   - Review new user registrations
   - Check backup age (must be < 26h)

2. **Check Cloud Monitoring** — GCP Console → Monitoring → Alerting
   - Clear resolved alerts
   - Investigate any new critical alerts

3. **Review Admin OS** — admin-os.html → Dashboard
   - User reports/flags
   - Pending seller verifications
   - Pending refund requests

### Every Monday

1. **Read the weekly security digest** — delivered to security@mysokoni.co.ke at 07:00 EAT
   - Review auth anomalies
   - Review payment fraud blocks
   - Review rate limit patterns

2. **Update ROADMAP.md** — mark completed items, update timeline

---

## Key Platform Services

### Authentication

All user authentication flows through Firebase Auth:
- Email + Password, Google OAuth, Facebook OAuth, Phone OTP
- Session tokens auto-expire after 1 hour (refreshed automatically)
- Admin claims set server-side only — never client-writable

**Admin actions require:**
- Firebase ID token with `admin: true` custom claim
- App Check token (enforcement must be ON)

### Notifications

All notifications go through the unified `notify()` engine in `functions/notify.js`.  
**Never call push/SMS/email directly.** Always use `notify()`.

```javascript
// Via Cloud Function call:
await firebase.functions().httpsCallable('notifySend')({
  uid:    'user_uid_here',
  type:   'order_placed',
  title:  'Your order has been placed',
  body:   'Order #12345 is confirmed.',
  phone:  '+254700000000',  // for SMS fallback
  email:  'user@email.com', // for email channel
  deepLink: '/orders/12345',
});
```

### Payments

Payment flow: Customer → IntaSend STK push → Webhook → Settlement Engine → Seller net payment

- **Never trust client-side payment confirmation** — always verify via webhook
- **Settlement** runs automatically every 6 hours via `scheduledAutoSettlement`
- **Refunds** must be processed via Admin OS or `refundPayment` CF — never manually

### Email

All outgoing email uses `functions/email-service.js` via SendGrid:

```javascript
const emailSvc = require('./email-service');
await emailSvc.queue({
  to:       'customer@email.com',
  from:     emailSvc.FROM.notifications,
  subject:  'Your order is confirmed',
  html:     emailTpl.getTemplate('order_placed', data).html,
  uid:      'user_uid',
  category: 'orders',
  emailId:  `order-placed-${orderId}`,  // deduplication key
});
```

### SmartPOS

SmartPOS merchants have their own Merchant ID (`SOK-XXXXXX`) assigned during onboarding.  
POS transactions use `smartPosDispatch` as the entry point.  
**Note:** SmartPOS Daraja-integrated payments (where sellers use their own M-Pesa shortcode) currently bypass the settlement engine — this is a known P0 architectural issue flagged for the v1.1 engineering sprint.

---

## Production Scaling Indicators

Monitor these thresholds — approaching the limit requires action:

| Resource | Current | Limit | Action at 80% |
|---|---|---|---|
| Firestore indexes | ~190 | 200 | Use sokoni-ops secondary DB |
| Cloud Functions | 606+ | GCP quota | Request quota increase |
| Cloud Run CPU quota | At limit | Per region quota | Submit quota increase |
| Firestore daily reads | Monitor | Billing threshold | Add caching layer |
| Storage bucket | Growing | $20/GB pricing | Lifecycle policies |

---

## CF Quota Management

23 Cloud Functions are currently pending deployment due to Cloud Run CPU quota:
- `financial-os.js` module
- `platform-core.js` module
- `sub-engine.js` module
- `messages.js` module

See `DEPLOY_QUEUE.md` for the exact deploy commands. Do not attempt until GCP confirms quota increase. Submit quota increase request at: GCP Console → IAM & Admin → Quotas → Filter "Cloud Run CPU"

---

## Secrets Rotation Schedule

| Secret | Recommended rotation | Notes |
|---|---|---|
| SENDGRID_API_KEY | Annually or on compromise | SendGrid dashboard → API Keys |
| INTASEND_PRIVATE_KEY | Annually or on compromise | IntaSend dashboard → API Settings |
| INTASEND_API_KEY | Annually or on compromise | IntaSend dashboard → API Settings |
| AFRICASTALKING_API_KEY | Annually or on compromise | AT dashboard → Settings |
| LOYALTY_HMAC_SECRET | Annually (invalidates existing QR codes) | Generate new 64-char hex |
| PAYMENT_HMAC_SECRET | Annually | Generate new 64-char hex |
| QR_SIGNING_SECRET | Annually (invalidates existing QR codes) | Generate new 64-char hex |
| SOKONI_HMAC_KEY | Annually | Generate new 64-char hex |

Rotation procedure: See `docs/SECURITY_GUIDE.md → Emergency Secret Rotation`

---

## Commission Engine

Commission rates are the single source of truth in `functions/commission-config.js`.  
The pre-deploy verification script (`scripts/verify-commission-single-source.js`) blocks any deploy that introduces a duplicate commission table.

| Hub | Rate |
|---|---|
| Marketplace | 3% |
| Food delivery | 5% |
| Property | 2% |
| Vehicles | KES 2,000 flat |
| Healthcare / Legal | 5% |
| Events | 5% |
| Digital products | 10% |
| Subscriptions | 100% |
| Default fallback | 5% |

---

## Africa's Talking — Sender ID Activation

When AT approves the SOKONI alphanumeric sender ID:

1. Open `functions/.env`
2. Change: `AT_SENDER_ID=` → `AT_SENDER_ID=SOKONI`
3. Deploy: `firebase deploy --only functions:notifySend,functions:sokoniAtDispatch`
4. Verify: send a test SMS via the admin notification panel

**No code changes required.**

---

## Known Limitations (v1.0)

1. **SmartPOS Daraja bypass** — sellers using their own M-Pesa shortcode receive full payment without commission deduction. Scheduled for v1.1.
2. **Redis VPC connector** — not configured; rate limiting falls back to Firestore for non-security actions
3. **AT Sender ID** — using shared shortcode until AT approves SOKONI branded sender
4. **Quota-blocked CFs** — 23 functions pending GCP quota increase
5. **External status page** — status.html is Firebase-hosted; inaccessible during Firebase outage
6. **ODPC registration** — ✅ registered as Data Processor (Reg. No. 630-8669-F056, valid 28 Jul 2026 – 28 Jul 2028)

---

*Document: SOKONI Production Operations Manual v1.0 — 2026-07-13*
