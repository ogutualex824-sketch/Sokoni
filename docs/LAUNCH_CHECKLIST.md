# SOKONI Launch Checklist

Use this checklist before every public launch or major deployment.

---

## Pre-Launch: Technical Verification

### Infrastructure
- [ ] `systemHealthCheck` returns HTTP 200 with `status: healthy`
- [ ] All Firebase secrets set in Secret Manager:
  - `INTASEND_PRIVATE_KEY`
  - `SENDGRID_API_KEY`
  - `ALGOLIA_ADMIN_KEY`
  - `TYPESENSE_SEARCH_KEY`
  - `AFRICASTALKING_API_KEY`
  - `AT_API_KEY`
- [ ] DNS resolving: `mysokoni.co.ke` → HTTP 200, SSL valid
- [ ] HSTS active: `Strict-Transport-Security` header present
- [ ] CSP header includes `frame-ancestors 'self'` and `report-uri`
- [ ] Service worker at current version (check `/service-worker.js`)
- [ ] Pre-deploy check passing 12/12: `npm run check`

### Pages (HTTP 200)
- [ ] `/` — Homepage
- [ ] `/store` — Marketplace
- [ ] `/product` — Product page
- [ ] `/cart` — Cart
- [ ] `/checkout` — Checkout
- [ ] `/search` — Search
- [ ] `/seller` — Seller dashboard
- [ ] `/pos` — SmartPOS
- [ ] `/healthcare` — Healthcare hub
- [ ] `/car-hub` — Car hub
- [ ] `/admin` — Admin panel
- [ ] `/notifications` — Notifications
- [ ] `/driver` — Driver dashboard
- [ ] `/manifest.json` — version: 1.0.0
- [ ] `/service-worker.js` — CACHE_VERSION current

### Firestore
- [ ] Rules deployed: `firebase deploy --only firestore:rules`
- [ ] Indexes deployed: `firebase deploy --only firestore:indexes`
- [ ] Index count ≤ 200

### Cloud Functions
- [ ] All 569+ functions deployed and responding
- [ ] `initiateSTKPush` returns HTTP 400 on empty request (confirms live)
- [ ] `emailWebhook` reachable
- [ ] `cspReportCollect` reachable

---

## Pre-Launch: Business Verification

- [ ] At least 1 seller registered with an active store
- [ ] At least 3 products listed and approved
- [ ] Test purchase completed in production (small amount, real card/M-Pesa)
- [ ] Order confirmation email received
- [ ] SMS notification received (Africa's Talking)
- [ ] Seller received order notification
- [ ] Seller dashboard shows the order
- [ ] Admin dashboard shows the order

---

## Go-Live Sequence

```bash
# 1. Final code validation
npm run check

# 2. Deploy hosting
npx firebase-tools deploy --only hosting --project sokoni-aeb26

# 3. Deploy Firestore
npx firebase-tools deploy --only firestore --project sokoni-aeb26

# 4. Deploy any new functions
npx firebase-tools deploy --only functions:newFunctionName --project sokoni-aeb26

# 5. Verify health
curl https://us-central1-sokoni-aeb26.cloudfunctions.net/systemHealthCheck

# 6. Verify homepage
curl -s -o /dev/null -w "%{http_code}" https://mysokoni.co.ke
```

---

## Post-Launch Monitoring (First 24 Hours)

Every 30 minutes:
- [ ] Check `ops-dashboard.html` — orders/hour, email queue, CSP violations
- [ ] Monitor payment success rate in `business-kpi.html`
- [ ] Check `admin-feedback.html` for incoming bug reports

After 2 hours:
- [ ] Review Cloud Function error rates (Firebase Console → Functions → Logs)
- [ ] Confirm first orders are processing end-to-end
- [ ] Verify email delivery logs in Firebase Console

After 24 hours:
- [ ] Run full health check (admin POST to `systemHealthCheck`)
- [ ] Review `getSecuritySummary` for anomalies
- [ ] Document any incidents in CHANGELOG.md

---

## Rollback Procedure

```bash
# List recent hosting versions
npx firebase-tools hosting:channel:list --project sokoni-aeb26

# Rollback to previous version
npx firebase-tools hosting:rollout PREVIOUS_VERSION_ID --project sokoni-aeb26

# Redeploy previous function if needed
git checkout PREVIOUS_COMMIT -- functions/affected-file.js
npx firebase-tools deploy --only functions:functionName --project sokoni-aeb26
```

---

## Key Contacts

| Role | Action |
|------|--------|
| Payment issue | Check IntaSend dashboard + `getPaymentAuditTrail` CF |
| Email not delivering | Check SendGrid dashboard + `emailQueue` Firestore collection |
| Search broken | Check Algolia dashboard + `searchDLQSweep` CF |
| Auth issue | Firebase Console → Authentication |
| High error rate | Firebase Console → Functions → Logs → filter by error |

---

*Last updated: 2026-06-25*
