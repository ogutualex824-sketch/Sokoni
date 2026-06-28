# SOKONI Disaster Recovery Playbook

**Version:** 1.0  
**Last Updated:** 2026-06-28  
**Owner:** Alex Ogutu (ogutualex824@gmail.com)  
**Status:** Active — Review quarterly or after any P0/P1 incident  

---

## 1. Overview

This playbook defines the procedures for recovering the SOKONI platform from outages, data incidents, and security events. It covers all layers of the production stack.

### Recovery Objectives

| Metric | Target | Notes |
|--------|--------|-------|
| **RTO — Degraded Mode** | 4 hours | Core marketplace functional; some features may be unavailable |
| **RTO — Full Recovery** | 24 hours | All features restored to pre-incident state |
| **RPO** | 15 minutes | Firestore PITR provides point-in-time recovery to within 15 minutes |

### Platform Stack

| Layer | Service | Project / Account |
|-------|---------|-------------------|
| Backend Functions | Firebase Cloud Functions (Gen2) | sokoni-aeb26 |
| Database | Cloud Firestore | sokoni-aeb26 (default) |
| Hosting | Firebase Hosting | mysokoni.co.ke |
| CDN | Cloudflare | mysokoni.co.ke zone |
| Storage | Cloud Storage | sokoni-aeb26.appspot.com |
| Secrets | Google Secret Manager | sokoni-aeb26 (16 secrets) |
| Payments | IntaSend (M-Pesa STK) | app.intasend.com |
| Cache | Redis (Upstash / self-hosted) | REDIS_URL in functions/.env |

---

## 2. Incident Classification

| Severity | Name | Definition | RTO | Escalation |
|----------|------|-----------|-----|-----------|
| **P0** | Platform Down | Hosting unreachable or >50% of Cloud Functions failing; platform unusable | 4 hours | Immediate — all hands |
| **P1** | Payment System Down | STK push failing; IntaSend webhook not responding; payments blocked | 2 hours | Immediate — founder + payment support |
| **P2** | Hub Down | A specific hub (e.g., Food Hub, Events, Jobs) is non-functional | 8 hours | Notify affected vendors; log incident |
| **P3** | Degraded Performance | Latency >5s; partial feature failures; non-critical errors | 24 hours | Monitor; fix in next deploy window |

**Incident Commander:** Alex Ogutu for P0/P1. Designate a deputy for P2/P3 during business hours.

---

## 3. DR Contacts

| Role | Contact | Channel |
|------|---------|---------|
| **Primary On-Call** | Alex Ogutu | ogutualex824@gmail.com |
| **Firebase Support** | console.firebase.google.com/project/sokoni-aeb26/support | Firebase Console |
| **GCP Support** | console.cloud.google.com/support | GCP Console |
| **Cloudflare Support** | cloudflare.com/support / community.cloudflare.com | Dashboard |
| **IntaSend Support** | support@intasend.com / app.intasend.com | Email + Dashboard |
| **Domain Registrar** | Per registrar account for mysokoni.co.ke | Registrar portal |

**Emergency Escalation Order:**
1. Alex Ogutu (Incident Commander)
2. Firebase Support (for GCP/Firebase-layer outages)
3. IntaSend Support (for payment-layer outages)
4. Cloudflare Support (for CDN/DNS outages)

---

## 4. Backup Verification Checklist

Run this checklist every **Monday morning** before business hours. Log results in `securityAlerts` (type: `backup_verification`).

- [ ] **Firestore PITR enabled** — Cloud Console → Firestore → Backups → verify Point-in-Time Recovery shows "Enabled" with 7-day retention window
- [ ] **Cloud Storage lifecycle policy active** — Cloud Console → Cloud Storage → sokoni-aeb26.appspot.com → Lifecycle → confirm rules exist (delete objects older than 90 days)
- [ ] **Secret Manager — all 16 secrets present** — Cloud Console → Secret Manager → verify all 16 secrets have an active version (not destroyed/disabled). Expected secrets: `ANTHROPIC_API_KEY`, `SENDGRID_API_KEY`, `INTASEND_PRIVATE_KEY`, `SOKONI_HMAC_KEY`, `REDIS_URL`, and 11 additional platform secrets
- [ ] **`restoreFirestore` function returns 200** — invoke via Firebase Console → Functions → restoreFirestore → test with a dry-run payload; verify HTTP 200 response
- [ ] **`firebase deploy --only hosting` succeeds** — run from a clean branch to confirm hosting pipeline is not broken
- [ ] **Firebase Hosting has ≥2 previous releases** — Firebase Console → Hosting → Release history → confirm at least 2 prior releases are listed (rollback targets exist)
- [ ] **Redis connectivity** — verify `REDIS_URL` in `functions/.env` resolves; check `redis-monitor.html` for connection status
- [ ] **IntaSend webhook** — confirm `intasendWebhook` CF is active; verify last successful webhook event in Firestore `payments` collection is recent (< 24h if platform is active)

---

## 5. Playbook P0 — Complete Platform Down

**Trigger:** Firebase Hosting returns 5xx; >50% of Cloud Functions report errors; users cannot reach mysokoni.co.ke.

### Detection

- Firebase Alerting → Cloud Monitoring alerts fire to ogutualex824@gmail.com
- `securityAlerts` Firestore collection receives `platform_health` alert
- External uptime monitor (if configured) triggers

### Response Steps

1. **Confirm outage scope** — Check Firebase Status page at status.firebase.google.com. Distinguish between a Firebase-wide incident (affects all GCP projects) vs. a SOKONI-specific issue.

2. **Enable maintenance page on Cloudflare** — Log in to Cloudflare dashboard → mysokoni.co.ke → Workers & Pages (or Page Rules) → activate maintenance redirect to `/maintenance.html`. This prevents users from hitting a broken site and sets expectations.

3. **Alert the team** — Send WhatsApp broadcast to vendor contacts: *"SOKONI is currently undergoing emergency maintenance. We will restore service within [X] hours. Orders placed before [time] are safe."*

4. **Attempt Hosting rollback** — Firebase Console → Hosting → Release history → click the last known-good release → "Roll back to this release". Confirm the new live URL resolves correctly. If Hosting rollback resolves the issue, skip to Step 8.

5. **Diagnose Cloud Functions** — If Hosting is up but API calls are failing:
   - GCP Console → Cloud Run → filter by `sokoni-aeb26` → check for quota errors, cold-start failures, or OOM kills
   - Check Cloud Run concurrency limits (default 80 per instance for Gen2)
   - Check for recent deployments that may have introduced a bad build: `gcloud functions list --project=sokoni-aeb26 --filter="state!=ACTIVE"`

6. **Activate read-only mode if Firestore is unavailable** — If Firestore is returning errors:
   - Update `platform/config` → `maintenanceMode: true` (if Firestore is partially accessible)
   - `sokoni-redis.js` cache will serve stale reads for product listings and catalogue data
   - Disable write operations by temporarily deploying a stub version of write-heavy functions

7. **Check security alert history** — Query `securityAlerts` Firestore collection for any `platform_anomaly` or `ddos_detected` events in the last 2 hours. If a DDoS is active, enable Cloudflare "Under Attack" mode (Security → DDoS → enable).

8. **Full redeploy when root cause resolved:**
   ```powershell
   # From SOKONI repo root
   firebase deploy --only hosting,functions
   ```
   After deploy, verify:
   - `curl https://mysokoni.co.ke -I` returns HTTP 200
   - `curl https://us-central1-sokoni-aeb26.cloudfunctions.net/healthCheck` returns `{"status":"ok"}`

9. **Create security incident record** — Invoke `createIncident` CF with payload:
   ```json
   {
     "type": "platform_down",
     "severity": "P0",
     "startTime": "<ISO timestamp>",
     "resolvedTime": "<ISO timestamp>",
     "rootCause": "<description>",
     "affectedSystems": ["hosting", "functions"],
     "resolvedBy": "Alex Ogutu"
   }
   ```

10. **Post-incident review within 24 hours** — Document in `docs/incidents/YYYY-MM-DD-P0-description.md`:
    - Timeline of events
    - Root cause analysis (5 Whys)
    - What worked in the playbook
    - What failed or was unclear
    - Action items to prevent recurrence

---

## 6. Playbook P1 — Payment System Down

**Trigger:** M-Pesa STK push not initiating; IntaSend webhook not delivering; checkout fails for all users.

### Detection

- `intasendWebhook` CF logs show repeated 4xx/5xx from IntaSend
- `payments` Firestore collection shows transactions stuck in `pending` status for >10 minutes
- Cloudflare monitoring shows spike in checkout page errors

### Response Steps

1. **Check IntaSend dashboard** — Log in to app.intasend.com → Dashboard → API Status. Verify:
   - API keys are active and not expired
   - Webhook URL (`https://us-central1-sokoni-aeb26.cloudfunctions.net/intasendWebhook`) is registered
   - Recent webhook delivery log shows failures with error codes

2. **Disable payment processing** — Update Firestore document `platform/config`:
   ```json
   {
     "paymentsEnabled": false,
     "paymentsDisabledReason": "Emergency maintenance — payments temporarily suspended",
     "paymentsDisabledAt": "<ISO timestamp>"
   }
   ```
   This flag is checked by `initiateSTKPush` CF — it will return a user-friendly error instead of attempting failed STK pushes.

3. **Display payment maintenance banner** — The frontend reads `platform/config.paymentsEnabled`. When `false`, the checkout page should display a maintenance banner. Verify this is visible by checking checkout.html in a browser.

4. **Identify stuck transactions** — Query Firestore:
   ```
   Collection: payments
   Filter: status == "pending" AND createdAt < (now - 15min)
   ```
   For each stuck transaction: set `status: "failed"`, `failReason: "payment_system_outage"`, and trigger a refund notification email via the email CF.

5. **Contact IntaSend Support** — Email support@intasend.com with:
   - Account details
   - Error messages from CF logs
   - Time range of failures
   - Number of affected transactions

6. **Re-enable when STK push resumes** — Test with a manual STK push from IntaSend dashboard. Once confirmed working:
   ```json
   // Update platform/config
   { "paymentsEnabled": true }
   ```

7. **Reconcile transactions** — After re-enabling, run the `reconcilePayments` CF to match any payments that completed during the outage window but were not recorded in Firestore.

8. **Create P1 incident record** — Invoke `createIncident` CF with `type: "payment_system_down"`.

---

## 7. Playbook — Data Breach Response

**Trigger:** Unauthorized access detected to Firestore; secret key exposure confirmed; anomalous bulk data export detected.

This procedure is aligned with **GDPR Article 33** (72-hour notification requirement) and the **Kenya Data Protection Act 2019**.

### Response Steps

1. **Immediately revoke affected user sessions** — Invoke `revokeUserSessions` CF with the list of affected `userId` values. This invalidates Firebase Auth tokens for compromised accounts, forcing re-authentication.

2. **Suspend affected accounts** — Invoke `secSuspendUser` CF for each confirmed-compromised account. Set `suspended: true` and `suspendReason: "security_incident"` in the user document.

3. **Create P0 security incident** — Invoke `createIncident` CF:
   ```json
   {
     "type": "data_breach",
     "severity": "P0",
     "detectedAt": "<ISO timestamp>",
     "detectedBy": "<method: alert/manual/external report>",
     "initialAssessment": "<brief description>"
   }
   ```

4. **Identify scope of breach** — Enumerate:
   - Which Firestore collections were accessed (check Cloud Audit Logs in GCP Console → Logging → Log Explorer, filter for `protoPayload.serviceName="firestore.googleapis.com"` and `protoPayload.methodName="RunQuery"`)
   - Which user IDs are affected
   - What categories of personal data are involved (names, phone numbers, payment history, addresses)
   - Whether any secrets or API keys were exposed

5. **GDPR / Kenya DPA assessment** — Under GDPR Article 33 and Kenya Data Protection Act 2019:
   - If the breach is **likely to result in a risk to the rights and freedoms of natural persons**, notify the **Office of the Data Protection Commissioner (Kenya)** within **72 hours** of becoming aware
   - Contact: ODPC Kenya — www.odpc.go.ke
   - Prepare notification including: nature of breach, categories of data, approximate number of individuals affected, likely consequences, measures taken

6. **Notify affected users within 72 hours** — Send breach notification email to all confirmed-affected users via the email CF (`sendBulkEmail`). Include:
   - What happened (in plain language)
   - What data was accessed
   - What SOKONI is doing to fix it
   - What users should do (change passwords, monitor accounts)
   - A direct support contact

7. **Rotate all secrets in Secret Manager** — For each of the 16 secrets in `sokoni-aeb26` Secret Manager:
   - Generate new value
   - Upload as a new secret version
   - Set new version as "latest"
   - Disable or destroy the old version
   - Redeploy all Cloud Functions that use the rotated secret

8. **Run comprehensive security scan** — Invoke `runSecurityScan` CF and document the full output. Review:
   - Firebase Security Rules for any gaps that enabled the breach
   - Recent `securityAlerts` events for breach indicators
   - Cloud Audit Logs for the 48h preceding the breach

9. **Legal review within 24 hours** — Engage legal counsel to assess:
   - Notification obligations under Kenya DPA 2019
   - GDPR obligations if EU residents are affected
   - Contractual notifications to payment providers (IntaSend terms)
   - Potential liability

10. **Full post-mortem within 7 days** — Document in `docs/incidents/YYYY-MM-DD-data-breach-postmortem.md`:
    - Root cause analysis
    - Attack vector
    - Data accessed and exfiltrated (if any)
    - Remediation steps taken
    - Security controls being added to prevent recurrence
    - Regulatory notifications sent and responses received

---

## 8. Rollback Procedures

### Hosting Rollback (fastest — < 2 minutes)

1. Firebase Console → Hosting → Release history
2. Identify the last known-good release (check timestamp and deployer)
3. Click the three-dot menu → **"Roll back to this release"**
4. Verify: `curl https://mysokoni.co.ke -I` → HTTP 200

### Function Rollback

Cloud Functions Gen2 does not support one-click rollback in the console. Rollback by redeploying the previous source:

```powershell
# Revert to a specific commit in git
git checkout <previous-safe-commit> -- functions/index.js functions/<affected-file>.js

# Redeploy only affected functions
firebase deploy --only functions:functionName1,functions:functionName2
```

For a full functions rollback:
```powershell
git checkout <previous-safe-commit>
firebase deploy --only functions
git checkout main  # Return to main branch
```

### Firestore PITR Restore

**Warning:** PITR restore replaces the entire database. Use only for catastrophic data loss or corruption.

```bash
# List available PITR backups
gcloud firestore databases describe --project=sokoni-aeb26

# Restore to a point in time (replace YYYY-MM-DDTHH:MM:SSZ with target time)
gcloud firestore databases restore \
  --project=sokoni-aeb26 \
  --source-database="(default)" \
  --destination-database="(default)-restore-$(date +%Y%m%d)" \
  --snapshot-time="YYYY-MM-DDTHH:MM:SSZ"
```

For export/import restore:
```bash
gcloud firestore import gs://sokoni-aeb26.appspot.com/backups/YYYY-MM-DD \
  --project=sokoni-aeb26
```

**After a PITR restore:**
- Verify document counts match pre-incident expectations
- Check `platform/config` document is intact
- Re-run any background jobs that process data created after the PITR snapshot time

### Config / Secret Rollback

```bash
# List versions of a secret
gcloud secrets versions list ANTHROPIC_API_KEY --project=sokoni-aeb26

# Set a previous version as the active latest
gcloud secrets versions enable <version-number> --secret=ANTHROPIC_API_KEY --project=sokoni-aeb26

# Disable the compromised version
gcloud secrets versions disable <bad-version-number> --secret=ANTHROPIC_API_KEY --project=sokoni-aeb26
```

After rolling back any secret, redeploy the Cloud Functions that reference it.

---

## 9. Health Check Commands

Run these commands to verify platform health after any restore or rollback operation.

```powershell
# Verify hosting is live and returns HTTP 200
curl https://mysokoni.co.ke -I

# Verify primary API health check endpoint
curl https://us-central1-sokoni-aeb26.cloudfunctions.net/healthCheck

# Count total active Cloud Functions
gcloud functions list --project=sokoni-aeb26 --filter="state=ACTIVE" --format="value(name)" | Measure-Object -Line

# Check recent Cloud Run errors (last 20)
gcloud logging read "resource.type=cloud_run_revision AND severity=ERROR" --project=sokoni-aeb26 --limit=20

# Verify Firestore access (replace TOKEN with output of gcloud auth print-access-token)
$TOKEN = gcloud auth print-access-token
curl -H "Authorization: Bearer $TOKEN" `
  "https://firestore.googleapis.com/v1/projects/sokoni-aeb26/databases/(default)/documents/platform/config"

# Check Firestore PITR status
gcloud firestore databases describe --project=sokoni-aeb26 --format="json(pointInTimeRecoveryEnablement)"

# Verify Redis connectivity (run from functions/ with REDIS_URL set)
node -e "const Redis = require('ioredis'); const r = new Redis(process.env.REDIS_URL); r.ping().then(v => { console.log('Redis:', v); r.quit(); })"

# Verify IntaSend webhook is reachable
curl -X POST https://us-central1-sokoni-aeb26.cloudfunctions.net/intasendWebhook \
  -H "Content-Type: application/json" \
  -d '{"challenge":"ping"}'
```

---

## 10. DR Test Schedule

Regular DR testing ensures this playbook remains accurate and the team stays practiced.

| Test | Frequency | Duration | Responsible | Last Tested |
|------|-----------|----------|-------------|-------------|
| **Hosting rollback simulation** | Monthly | ~5 minutes | Alex Ogutu | Log here |
| **Backup verification checklist** | Weekly (Monday) | ~15 minutes | Alex Ogutu | Log here |
| **Payment outage P1 simulation** | Quarterly | ~30 minutes | Alex Ogutu | Log here |
| **Full PITR restore to staging** | Bi-annually | ~2 hours | Alex Ogutu + Firebase | Log here |
| **Data breach tabletop exercise** | Annually | ~2 hours | Full team | Log here |

### Monthly Hosting Rollback Test Procedure

1. Deploy a canary release with a minor visible change: `npm run canary`
2. Verify the canary URL shows the change
3. Roll back using Firebase Console → Hosting → Release history
4. Verify rollback is live within 2 minutes
5. Log result in `docs/dr-tests/YYYY-MM-hosting-rollback.md`

### Quarterly P1 Payment Simulation

1. Set `platform/config.paymentsEnabled: false` in a staging Firestore instance
2. Attempt a checkout — verify maintenance banner appears
3. Simulate a stuck payment (create a `pending` payment document manually)
4. Walk through Steps 4–6 of Playbook P1 using staging data
5. Re-enable payments and verify checkout works
6. Log result

### Bi-Annual PITR Restore Test

1. Create a dedicated staging Firebase project (or use emulators)
2. Export a snapshot of selected Firestore collections from production (non-PII only, or use synthetic data)
3. Restore the export into the staging project using `gcloud firestore import`
4. Verify document structure, counts, and query results
5. Document any schema drift between the backup snapshot and current production schema
6. Update this playbook if the restore procedure has changed

---

## Appendix A — Key Firebase Console URLs

| Resource | URL |
|----------|-----|
| Firebase Console — sokoni-aeb26 | console.firebase.google.com/project/sokoni-aeb26 |
| Hosting — Release History | console.firebase.google.com/project/sokoni-aeb26/hosting/sites |
| Cloud Functions | console.firebase.google.com/project/sokoni-aeb26/functions |
| Firestore | console.firebase.google.com/project/sokoni-aeb26/firestore |
| Secret Manager | console.cloud.google.com/security/secret-manager?project=sokoni-aeb26 |
| Cloud Logging | console.cloud.google.com/logs?project=sokoni-aeb26 |
| Firebase Status | status.firebase.google.com |
| GCP Status | status.cloud.google.com |

---

## Appendix B — Required Secret Manager Secrets (16)

The following secrets must be present and active in Secret Manager at all times:

1. `ANTHROPIC_API_KEY`
2. `SENDGRID_API_KEY`
3. `INTASEND_PRIVATE_KEY`
4. `SOKONI_HMAC_KEY`
5. `REDIS_URL`
6. `FIREBASE_ADMIN_SERVICE_ACCOUNT` (if using manual init)
7. `ALGOLIA_ADMIN_KEY`
8. `ALGOLIA_SEARCH_KEY`
9. `MPESA_CONSUMER_KEY`
10. `MPESA_CONSUMER_SECRET`
11. `MPESA_PASSKEY`
12. `ETIMS_CLIENT_ID`
13. `ETIMS_CLIENT_SECRET`
14. `SMTP_PASSWORD`
15. `CLOUDFLARE_API_TOKEN`
16. `WEBHOOK_SECRET`

Verify weekly using the Backup Verification Checklist in Section 4.

---

*See [[Security]] [[Operations]] [[Phase 0 Operations]] [[Incident Response]]*
