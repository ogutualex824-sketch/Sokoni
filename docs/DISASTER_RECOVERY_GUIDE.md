# SOKONI Disaster Recovery Guide

**Platform:** SOKONI  
**Legal Entity:** Bravilex International Co. Limited  
**Classification:** Internal — Confidential  
**Version:** 1.0 — 2026-07-13

---

## Recovery Time Objectives

| Scenario | RTO Target | RPO Target | Strategy |
|---|---|---|---|
| Hosting outage | < 5 min | 0 (static) | Firebase Hosting release rollback |
| Single CF crash | < 1 min | 0 | Cloud Run auto-restart |
| Bad CF deploy | < 10 min | 0 | Targeted function redeploy from previous commit |
| Firestore rules bug | < 5 min | 0 | `firebase deploy --only firestore:rules` from previous rules |
| Database data corruption | < 4 hours | < 1 hour | PITR restore |
| Payment processing down | < 30 min | 0 | IntaSend status page + webhook retry |
| Full project outage | < 2 hours | < 1 hour | Full redeploy from git |
| Compromised credentials | < 15 min | 0 | Rotate in provider dashboard + Secret Manager |

---

## Backups

### Firestore — Point In Time Recovery (PITR)

PITR is enabled on `sokoni-aeb26` Firestore database. This allows restoration of the database to any point within the last **7 days**.

**To initiate a PITR restore:**
```bash
# List available recovery windows
gcloud firestore operations list --project=sokoni-aeb26

# Export data to Cloud Storage before restoring (safety copy)
gcloud firestore export gs://sokoni-aeb26.appspot.com/backups/$(date +%Y%m%d_%H%M%S) \
  --project=sokoni-aeb26

# Restore to a specific timestamp
gcloud firestore import gs://sokoni-aeb26.appspot.com/backups/<BACKUP_ID> \
  --project=sokoni-aeb26
```

> PITR restores the entire database. For collection-level recovery, use a manual export + import of the specific collection.

### Cloud Storage Backups

Firebase Cloud Storage does not have automatic PITR. Enable versioning for critical buckets:

```bash
gsutil versioning set on gs://sokoni-aeb26.appspot.com
```

### Source Code

All source code is in git. The main branch contains the production-deployed version. No additional backup required beyond standard git practices.

### Secrets Backup

Secrets in Google Secret Manager have version history. Previous versions can be accessed:

```bash
firebase functions:secrets:access SECRET_NAME --version=<VERSION_NUMBER>
```

---

## Incident Runbooks

### Runbook 1: Hosting is Down (Firebase Hosting outage)

**Symptoms:** mysokoni.co.ke returns 502/503/404, Firebase status page shows Hosting incident.

**Steps:**
1. Check Firebase status: https://status.firebase.google.com
2. If Firebase global outage: wait for Firebase recovery (no action possible)
3. If specific version issue: roll back to previous release
   ```bash
   firebase hosting:releases:list
   # Find last known-good release ID
   firebase hosting:channel:deploy live --version <RELEASE_ID>
   ```
4. If DNS issue: check Cloudflare → check NS records for mysokoni.co.ke
5. Notify `devops@mysokoni.co.ke`

---

### Runbook 2: Payment Processing Failure

**Symptoms:** Checkout fails, STK push not received, webhooks not processed.

**Steps:**
1. Check IntaSend status: https://status.intasend.com
2. Check CF logs for `intasendWebhook`:
   ```bash
   firebase functions:log --only intasendWebhook
   ```
3. If webhook CF is crashing: check Secret Manager for `INTASEND_PRIVATE_KEY`
   ```bash
   firebase functions:secrets:access INTASEND_PRIVATE_KEY
   ```
4. If STK push failing: check M-Pesa/Safaricom status
5. If rate limit hit: check redis-monitor.html for rate limiter state
6. Pending payments: IntaSend dashboard → Transactions → Retry any failed
7. Contact IntaSend support: `support@intasend.com`
8. Escalate to Alex immediately

---

### Runbook 3: Database Corruption or Accidental Deletion

**Symptoms:** Missing documents, corrupted data, user complaints about lost orders.

**Steps:**
1. **Do not write to the affected collection** until recovery is complete
2. Identify the approximate time of corruption from Cloud Logging
3. Export current state as safety copy:
   ```bash
   gcloud firestore export gs://sokoni-aeb26.appspot.com/backups/pre-recovery-$(date +%Y%m%d_%H%M%S)
   ```
4. Restore from PITR (timestamp before corruption)
5. Verify restored data
6. Redeploy Firestore rules if they were involved
7. Document incident and root cause

---

### Runbook 4: Compromised Secret / API Key

**Symptoms:** Unexpected API calls, billing spike, security alert from provider.

**Steps:**
1. **Immediately revoke the compromised key** in the provider's dashboard (IntaSend/SendGrid/AT/GCP)
2. Generate a new key in the provider's dashboard
3. Update in Secret Manager:
   ```bash
   firebase functions:secrets:set COMPROMISED_SECRET_NAME
   ```
4. Redeploy affected functions:
   ```bash
   firebase deploy --only functions
   ```
5. Review Cloud Logging for the past 24h for unauthorized usage
6. If financial credentials (IntaSend): notify IntaSend compliance team
7. Document in security incident log
8. Notify `security@mysokoni.co.ke`

---

### Runbook 5: Cloud Functions Over Quota

**Symptoms:** 429 errors on CF invocations, quota exhaustion alerts in GCP Monitoring.

**Steps:**
1. Identify which CF is hitting quota: GCP Console → Cloud Functions → Quotas
2. Short-term: increase quota limit in GCP Console → IAM → Quotas → `cloudfunctions.googleapis.com`
3. If Cloud Run CPU quota (for Gen2 functions): submit quota increase request
4. Review rate limiter configuration for the affected CF
5. Check for stuck infinite loops or runaway scheduled jobs

---

### Runbook 6: Service Worker Cache Loop (Cloudflare + SW Bug)

**Symptoms:** `ERR_TOO_MANY_REDIRECTS`, users cannot load the site, bug reproduces after cache clear.

**Root cause:** Cloudflare caches the service worker file for 7 days, preventing the SW from updating. (Previously encountered — see `project_cloudflare_sw_cache.md`.)

**Steps:**
1. Add/update Cloudflare Page Rule for `/service-worker.js`:
   - Cache Level: Bypass
   - Or add header: `CDN-Cache-Control: no-store`
2. Bump `CACHE_VERSION` in `service-worker.js`:
   ```javascript
   const CACHE_VERSION = "sokoni-YYYYMMDD-sw-fix-vNN";
   ```
3. Deploy: `firebase deploy --only hosting`
4. Purge Cloudflare cache for `mysokoni.co.ke/service-worker.js`

---

### Runbook 7: Redis Down / Unreachable

**Symptoms:** Rate limiting logs show Firestore fallback, Redis timeout errors in CF logs.

**Steps:**
1. Check Redis instance: GCP Console → Memorystore → SOKONI Redis instance → Status
2. If Redis is down but Firestore fallback is active: **do not block deployments** — Firestore fallback covers critical rate limits
3. Check VPC connector: GCP Console → VPC network → Serverless VPC access → Connector status
4. If VPC connector failed: recreate it
5. Update `REDIS_URL` in Secret Manager if IP changed
6. Redeploy functions that use Redis

---

## Deployment Rollback — Step by Step

### Scenario: Bad production deploy, need to revert

```bash
# 1. Identify the last good commit
git log --oneline -10

# 2. Check out the previous version of changed files
git checkout <LAST_GOOD_COMMIT> -- functions/
# or for specific function:
git checkout <LAST_GOOD_COMMIT> -- functions/notify.js

# 3. Deploy the reverted files
firebase deploy --only functions:<FUNCTION_NAME>

# 4. Restore current HEAD
git checkout HEAD -- functions/

# 5. Verify CF is running correctly
firebase functions:log --only <FUNCTION_NAME>
```

### Scenario: Revert hosting deploy

```bash
# Via Firebase CLI
firebase hosting:releases:list
firebase hosting:channel:deploy live --version <VERSION_ID>
```

### Scenario: Revert Firestore security rules

```bash
git checkout <LAST_GOOD_COMMIT> -- firestore.rules
firebase deploy --only firestore:rules
git checkout HEAD -- firestore.rules
```

---

## Communication During Incidents

| Stakeholder | Channel | When |
|---|---|---|
| Engineering (Alex) | ogutualex824@gmail.com + phone | Immediately |
| Platform Admin (Isaac) | isaac@mysokoni.co.ke | Within 5 min |
| Payment team | payments@mysokoni.co.ke | Payment incidents |
| Users (major outage) | `status.html` page update | > 15 min outage |
| IntaSend | support@intasend.com | Payment system issues |
| GCP Support | console.cloud.google.com/support | P0/P1 GCP issues |

---

## Health Monitoring

### Scheduled Health Checks

- `scheduledDailyOpsReport` — 06:00 EAT daily — delivered to devops@mysokoni.co.ke
- `recordHealthSnapshot` (Cloud Scheduler) — hourly platform metrics snapshot
- `scheduledWeeklySecurityReport` — Mon 07:00 EAT — security digest

### Manual Health Verification

```bash
# Check all running Cloud Functions
firebase functions:list

# Check recent CF errors
firebase functions:log --level=ERROR

# Check Firestore read/write metrics
# → Firebase Console → Firestore → Usage
```

### Status Page

`https://mysokoni.co.ke/status.html` — public-facing platform status page.  
Update manually during incidents or via `statusWrite` Cloud Function.

---

*Document: SOKONI Disaster Recovery Guide v1.0 — 2026-07-13*
