# SOKONI Disaster Recovery Guide

**RPO (Recovery Point Objective):** 24 hours (nightly Firestore exports)  
**RTO (Recovery Time Objective):** 2 hours (full-stack restore)  
**Last Updated:** 2026-06-25

---

## Disaster Scenarios

### Scenario A — Hosting Outage (Firebase CDN down)

**Indicators:** 503 from mysokoni.co.ke, Firebase Status Page shows incident  
**Impact:** All users cannot access platform

**Response:**
1. Check [Firebase Status Page](https://status.firebase.google.com)
2. If Firebase-wide outage: no immediate action possible — wait for Firebase recovery
3. If configuration issue (bad deploy):
   ```bash
   node scripts/deploy/rollback.js   # rolls back hosting + functions
   ```
4. Post status update to users via social media

**Recovery Time:** 15-30 minutes for bad deploy; Firebase-wide outage: up to 4 hours

---

### Scenario B — Cloud Functions Down

**Indicators:** All API calls failing, `systemHealthCheck` returning 500  
**Impact:** Payments blocked, search down, notifications stopped

**Response:**
1. Check Cloud Run logs in GCP Console
2. If deploy caused the outage:
   ```bash
   FIREBASE_TOKEN=<token> node scripts/deploy/rollback.js
   ```
3. If billing issue: check GCP Billing console
4. If quota exhausted: request quota increase in GCP Console  
   (Operations → Quotas → Cloud Run)

**Recovery Time:** 10-20 minutes

---

### Scenario C — Firestore Data Corruption

**Indicators:** Users reporting missing data, Cloud Functions crashing with unexpected data shapes  
**Impact:** Data integrity compromised

**Response:**
1. **IMMEDIATELY** enable read-only mode to stop further writes:
   - Firebase Remote Config → `read_only_mode = true`
2. Identify affected collections and approximate timeframe
3. Find the last clean backup:
   ```bash
   gsutil ls gs://sokoni-aeb26-backups/firestore/ | tail -10
   ```
4. Restore to a recovery project first:
   ```bash
   gcloud firestore import gs://sokoni-aeb26-backups/firestore/<TIMESTAMP> \
     --project=sokoni-recovery
   ```
5. Validate data in recovery project
6. Import to production:
   ```bash
   gcloud firestore import gs://sokoni-aeb26-backups/firestore/<TIMESTAMP> \
     --project=sokoni-aeb26
   ```
7. Disable read-only mode after validation

**Data Loss:** Up to 24 hours (last backup)  
**Recovery Time:** 2 hours

---

### Scenario D — Payment System Failure

**Indicators:** IntaSend webhooks failing, payments stuck in `pending`  
**Impact:** Revenue blocked, user payments not completing

**Response:**
1. Check IntaSend Dashboard for API health
2. Check Cloudflare for webhook URL accessibility
3. Check `intasendWebhook` function logs in GCP
4. If IntaSend API is down: payments queue up — they will retry on recovery
5. If webhook is misconfigured:
   ```bash
   # Redeploy webhook function only
   firebase deploy --only functions:intasendWebhook --project=sokoni-aeb26
   ```
6. Manually reconcile stuck payments after recovery:
   ```bash
   # Query payments stuck for > 30 minutes
   # Use Firebase Console → Firestore → payments collection
   # Filter: status == "pending", createdAt < now-30min
   ```

**Recovery Time:** 30 minutes

---

### Scenario E — Search Service Outage

**Indicators:** Search returning empty results or 500 errors  
**Impact:** Users cannot find products/services (browse still works)

**Typesense down:**
1. The platform falls back to Firestore queries automatically (sokoni-search-pro.js circuit breaker)
2. If Typesense cluster is unhealthy, contact [Typesense support](https://typesense.org)
3. Re-index from Firestore once Typesense recovers:
   ```bash
   TYPESENSE_ADMIN_KEY=<key> node functions/scripts/typesense-direct.js
   ```

**Algolia down:**
1. Platform falls back to Typesense search
2. Check Algolia Status Page

**Recovery Time:** 30 minutes (re-index); near-zero downtime with fallback

---

### Scenario F — Complete Platform Rebuild

**Indicators:** GCP project deleted, catastrophic failure, or migration to new infrastructure  
**Duration:** 4-8 hours

**Checklist:**
1. Create new Firebase project
2. Update `sokoni-config.js` with new project credentials
3. Deploy Firestore security rules: `firebase deploy --only firestore:rules`
4. Deploy Firestore indexes: `firebase deploy --only firestore:indexes`
5. Deploy Cloud Functions: `firebase deploy --only functions`
6. Deploy hosting: `firebase deploy --only hosting`
7. Restore Firestore from latest backup
8. Re-import Typesense collections: `node functions/scripts/typesense-direct.js`
9. Re-index Algolia
10. Update DNS to point to new Firebase project
11. Update Cloudflare settings
12. Restore Firebase Secrets:
    - `INTASEND_PUBLISHABLE_KEY`
    - `INTASEND_SECRET_KEY`
    - `SENDGRID_API_KEY`
    - `MAIL_HOST`, `MAIL_USER`, `MAIL_PASS`
    - `TYPESENSE_ADMIN_KEY`
    - `ALGOLIA_ADMIN_KEY`
    - `ALGOLIA_APP_ID`
13. Verify all payment flows end-to-end
14. Run smoke test suite

---

## Recovery Contacts

| Service       | Support URL / Contact          | SLA   |
|---------------|-------------------------------|-------|
| Firebase/GCP  | console.firebase.google.com    | 99.95%|
| IntaSend      | intasend.com                   | —     |
| Typesense     | typesense.org                  | 99.9% |
| Algolia       | algolia.com                    | 99.99%|
| Cloudflare    | cloudflare.com                 | 99.99%|
| SendGrid      | sendgrid.com                   | 99.95%|

---

## Related Documents
- [[ARCHITECTURE]] — System architecture overview
- [[RUNBOOKS]] — Day-to-day operational procedures
- [[INCIDENT_RESPONSE]] — Incident playbooks
