# SOKONI Manual Infrastructure Checklist

**Status:** Required before Phase 0 soft launch  
**Last updated:** 2026-06-27

---

## 1. Firebase Secret Manager — Secrets to Provision

Run each command in your terminal (Firebase project: `sokoni-app`):

```bash
# SendGrid API key (email delivery)
echo -n "YOUR_SENDGRID_API_KEY" | \
  firebase functions:secrets:set SENDGRID_API_KEY

# Gmail App Password (fallback SMTP)
echo -n "YOUR_GMAIL_APP_PASSWORD" | \
  firebase functions:secrets:set GMAIL_APP_PASSWORD

# KRA eTIMS TIN / PIN (Kenya Revenue Authority)
echo -n "YOUR_KRA_TIN" | \
  firebase functions:secrets:set ETIMS_PLATFORM_PIN

# KRA eTIMS taxpayer secret
echo -n "YOUR_KRA_ETIMS_SECRET" | \
  firebase functions:secrets:set ETIMS_PLATFORM_SECRET

# IntaSend live secret key
echo -n "YOUR_INTASEND_SECRET_KEY" | \
  firebase functions:secrets:set INTASEND_SECRET_KEY

# IntaSend live publishable key (also update sokoni-config.js)
echo -n "YOUR_INTASEND_PUBLIC_KEY" | \
  firebase functions:secrets:set INTASEND_PUBLIC_KEY

# Subscription OS signing secret (HMAC for webhook verification)
echo -n "$(openssl rand -hex 32)" | \
  firebase functions:secrets:set SUB_OS_SIGNING_SECRET

# WhatsApp Cloud API token (if using Meta WhatsApp)
echo -n "YOUR_WHATSAPP_TOKEN" | \
  firebase functions:secrets:set WHATSAPP_CLOUD_TOKEN
```

After setting each secret, **grant access** to deployed functions:
```bash
firebase functions:secrets:access SENDGRID_API_KEY --project sokoni-app
```

---

## 2. Firebase Authentication — Enable OAuth Providers

Go to **Firebase Console → Authentication → Sign-in method**:

| Provider | Action | Config needed |
|---|---|---|
| **Apple** | Enable | Team ID, Key ID, Private key (.p8) from developer.apple.com |
| **Microsoft** | Enable | Azure App Registration Client ID + Secret from portal.azure.com |
| **GitHub** | Enable | OAuth App Client ID + Secret from github.com/settings/developers |
| **Facebook** | Enable | App ID + App Secret from developers.facebook.com |
| **Google** | Already enabled | — |
| **Phone OTP** | Already enabled | — |

**Apple Sign-In callback URL** to whitelist in Apple Developer:  
`https://sokoni-app.firebaseapp.com/__/auth/handler`

---

## 3. Firebase App Check — Required for Payment CFs

`createCheckoutSession` and `darajaSTKPush` now have `enforceAppCheck: true`.

**Steps:**
1. Firebase Console → App Check
2. Register your web app with **reCAPTCHA v3** provider
3. Get the reCAPTCHA v3 **site key** → add to `sokoni-config.js`:
   ```js
   reCaptchaSiteKey: "6LcXXXXXXXXXXXXXXXXXXXXXXXXXXXX"
   ```
4. Initialize App Check in `firebase.js` before any callable is invoked:
   ```js
   import { initializeAppCheck, ReCaptchaV3Provider } from "firebase/app-check";
   initializeAppCheck(app, {
     provider: new ReCaptchaV3Provider(sokoniConfig.reCaptchaSiteKey),
     isTokenAutoRefreshEnabled: true,
   });
   ```
5. In App Check console, set enforcement to **Enforced** for Functions.

---

## 4. IntaSend — Switch to Live Keys

1. Log in to **app.intasend.com**
2. Go to API Keys → copy **Live Publishable Key** and **Live Secret Key**
3. Update `sokoni-config.js`:
   ```js
   intasendPublishableKey: "ISPubKey_live_XXXXXXXX",
   ```
4. Set the secret in Firebase (see section 1 above).
5. In IntaSend dashboard → Webhooks → add:  
   `https://us-central1-sokoni-app.cloudfunctions.net/intasendWebhook`

---

## 5. DNS — mysokoni.co.ke

Point your domain to Firebase Hosting:

1. Firebase Console → Hosting → Add custom domain → `mysokoni.co.ke`
2. Firebase will give you two `A` records and a `TXT` record for verification.
3. In your registrar (e.g. Kenya Online Zone, Truehost, Safaricom):
   - Delete existing A records for `@`
   - Add Firebase's two `A` records for `@`
   - Add `CNAME` record: `www → mysokoni.co.ke`
   - Add the `TXT` record for domain verification
4. Wait 24-48 hours for SSL provisioning.
5. Verify with: `curl -I https://mysokoni.co.ke`

---

## 6. EmailJS — Transactional Email Templates

If using EmailJS for client-side emails (contact forms etc.):
1. Log in to emailjs.com
2. Service ID → copy into `sokoni-config.js` as `emailJsServiceId`
3. Template IDs → add to respective HTML pages calling `emailjs.send()`

---

## 7. Firebase Cloud Messaging (Push Notifications)

1. Firebase Console → Project Settings → Cloud Messaging → Web Push Certificates
2. Generate VAPID key pair → copy public key
3. Update `sokoni-config.js`:
   ```js
   vapidKey: "BBxxxxxxxxxxxxxx..."
   ```
4. In `firebase-messaging-sw.js`, the key is already read from config — just ensure the SW is served at `/firebase-messaging-sw.js`.

---

## 8. Firestore PITR & Backups

Confirm these are active (should already be from RC1 hardening):
```bash
# Check PITR is on
gcloud firestore databases describe --database="(default)" --project=sokoni-app \
  | grep pointInTimeRecoveryEnablement

# Set up scheduled export (run once)
gcloud firestore export gs://sokoni-app-backups/$(date +%Y-%m-%d) \
  --project=sokoni-app
```

Schedule daily exports via Cloud Scheduler:
- Job name: `daily-firestore-backup`
- Schedule: `0 2 * * *` (2 AM Nairobi = 11 PM UTC)
- Target: Cloud Functions HTTP trigger or `gcloud` via Cloud Run

---

## 9. Deploy New Cloud Functions (Batch)

The following new CFs were added in this sprint — deploy in batches of ≤7:

**Batch A — Reviews & Ratings:**
```bash
firebase deploy --only functions:submitReview,functions:getReviews,functions:flagReview,functions:markReviewHelpful,functions:adminModerateReview
```

**Batch B — Referral + Availability maintenance:**
```bash
firebase deploy --only functions:processReferralOnOrderComplete,functions:scheduledAvailabilityMaintenance
```

**Batch C — Already-deployed functions with updated App Check:**
```bash
firebase deploy --only functions:createCheckoutSession,functions:darajaSTKPush
```

---

## 10. Post-Launch Verification

- [ ] Confirm sign-in works for Google, Phone OTP, and one additional provider
- [ ] Place a test order end-to-end (M-Pesa STK → confirm payment → order confirmed)
- [ ] Confirm referral code visible on `profile.html`
- [ ] Test loyalty points toggle on checkout with ≥20 points in `sokoniLoyalty` localStorage
- [ ] Check `mysokoni.co.ke` resolves over HTTPS with valid cert
- [ ] Check admin panel `admin.html` loads for super admin only
- [ ] Verify App Check enforcement: calling checkout CF from browser console without token should return 403

---

*This document is the single source of truth for manual infra tasks. Tick each box as completed.*
