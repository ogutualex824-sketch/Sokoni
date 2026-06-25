# SOKONI Incident Response Playbooks

**Last Updated:** 2026-06-25  
**On-Call:** Alex Ogutu (ogutualex824@gmail.com)

---

## Severity Levels

| Severity | Definition | Response Time | Example |
|----------|-----------|---------------|---------|
| SEV-1    | Platform down or payments blocked | 15 min | Firebase down, all checkouts failing |
| SEV-2    | Major feature broken for > 10% users | 30 min | Search 500s, auth failures |
| SEV-3    | Minor feature broken, workaround exists | 2 hours | Email notifications delayed |
| SEV-4    | Performance degradation, no functional impact | Next business day | P95 latency slightly high |

---

## Incident Lifecycle

```
Detection → Triage → Mitigation → Resolution → Postmortem
```

### 1. Detection
Sources:
- GCP Cloud Monitoring alert (email or Slack via SLACK_WEBHOOK_URL)
- User report via support channels
- Health check failure in canary deploy pipeline
- Manual observation

### 2. Triage (first 5 minutes)

```bash
# Quick platform health check
curl -s https://us-central1-sokoni-aeb26.cloudfunctions.net/systemHealthCheck | jq .

# Recent error rate (last 10 min of Cloud Function logs)
gcloud functions logs read --project=sokoni-aeb26 --limit=50 --gen2 \
  | grep -E "ERROR|WARN"

# Check active payments (anything stuck?)
# Firestore Console → payments → filter: status == pending, createdAt < now-15min
```

**Assign severity and declare the incident.**

### 3. Mitigation

**Fastest mitigations (< 2 minutes):**
```bash
# 1. Enable maintenance mode (hides broken pages from users)
# Firebase Remote Config → maintenance_mode = true

# 2. Roll back last deploy
node scripts/deploy/rollback.js

# 3. Disable a specific feature flag
# Firebase Remote Config → <feature_flag> = false
```

**Deploy a hotfix:**
```bash
gh workflow run canary-deploy.yml -f start_stage=6 -f skip_gate=true
```

### 4. Resolution

- Confirm health check returns 200
- Verify user-reported flows work end-to-end
- Confirm error rate back to baseline (< 0.5%)
- Disable maintenance mode if enabled
- Send status update to affected users

### 5. Postmortem

Write a postmortem within 48 hours for all SEV-1 and SEV-2 incidents.

Template:

```markdown
## Incident Postmortem — [DATE] [TITLE]

**Duration:** [start] → [end] ([X] minutes)
**Severity:** SEV-X
**Impact:** [how many users affected, what was broken]

### Timeline
- HH:MM — [event]
- HH:MM — [action taken]
- HH:MM — [resolution]

### Root Cause
[What caused the incident]

### Contributing Factors
[What made it worse or harder to detect]

### What Went Well
[What worked in the response]

### Action Items
- [ ] [fix] — Owner — [due date]
- [ ] [monitoring improvement] — Owner — [due date]
- [ ] [runbook update] — Owner — [due date]
```

---

## Common Incidents — Quick Reference

### INC-001: High Error Rate After Deploy

1. Check if error started exactly at deploy time (GCP logs → timestamp)
2. If yes: immediate rollback — `node scripts/deploy/rollback.js`
3. Investigate root cause in rolled-back codebase
4. Fix, test locally, re-deploy via canary

### INC-002: Payment Stuck in Pending

1. Check IntaSend dashboard for webhook delivery logs
2. Check `intasendWebhook` function logs in GCP
3. If webhook failed: trigger manual reconciliation
   ```javascript
   // Call via Firebase Admin SDK:
   await admin.firestore().collection('payments').doc(paymentId)
     .update({ status: 'reconciliation_pending', reconcileAt: new Date() });
   ```
4. Never manually mark payment as `success` without verifying with IntaSend API

### INC-003: Firebase Auth Outage

1. All login/register calls will fail
2. Users already logged in will remain logged in (ID token valid for 1 hour)
3. Check Firebase Auth status page
4. Nothing to do on our side — Firebase-level incident
5. Post status update to users

### INC-004: Typesense Search Down

1. sokoni-search-pro.js circuit breaker will activate → falls back to Firestore
2. Log warning in GCP
3. Once Typesense recovers, circuit breaker resets automatically after 60 seconds
4. No manual intervention required for < 5 min outages

### INC-005: DDoS / Traffic Spike

1. Cloudflare absorbs most DDoS at edge
2. If Cloud Functions are rate-limiting due to traffic:
   - Check `sokoni-scale.js` rate limiter is active
   - Enable `read_only_mode` to reduce write pressure
3. Scale up Firebase Functions quotas if needed (GCP Console → Quotas)
4. Enable Cloudflare Bot Fight Mode (Security → Bots)

### INC-006: Data Breach / Security Incident

**CRITICAL — Follow exactly:**
1. Enable maintenance mode immediately (`maintenance_mode = true`)
2. Revoke compromised credentials:
   ```bash
   # Rotate all affected secrets
   printf 'new-value' | firebase functions:secrets:set SECRET_NAME
   ```
3. Invalidate all user sessions (requires revoking Firebase tokens):
   ```javascript
   await admin.auth().revokeRefreshTokens(uid); // for specific user
   ```
4. Preserve all logs (do NOT delete anything)
5. Notify affected users within 72 hours (GDPR / Kenya Data Protection Act)
6. File incident report

---

## Communication Templates

### Status Page Update
```
[INVESTIGATING] We are investigating reports of [issue]. Our team is actively working on this.

[IDENTIFIED] We have identified the root cause: [brief description]. Mitigation is in progress.

[MONITORING] The issue has been resolved. We are monitoring to confirm stability.

[RESOLVED] This incident has been resolved. The root cause was [brief description].
Total impact duration: [X] minutes.
```

### User-Facing Email (use email-center.html for bulk send)
```
Subject: Service Update — [DATE]

We experienced a service disruption from [time] to [time] EAT.

What was affected: [brief description]
What you may need to do: [action required, if any]

We apologize for any inconvenience. Our team has implemented [fix] to prevent recurrence.
```
