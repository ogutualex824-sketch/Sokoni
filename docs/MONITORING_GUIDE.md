# SOKONI Monitoring Guide

**Platform:** SOKONI  
**Legal Entity:** Bravilex International Co. Limited  
**Classification:** Internal — Engineering  
**Version:** 1.0 — 2026-07-13

---

## Overview

SOKONI has a multi-layer monitoring stack:
1. **Application-level** — scheduled health checks every 5–15 minutes, written to Firestore
2. **GCP Cloud Monitoring** — 18 alert policies (must be provisioned via setup script)
3. **Operational dashboards** — admin HTML pages with live metrics
4. **Automated reports** — daily ops (06:00 EAT), weekly security (Mon 07:00 EAT)

---

## Health Check Endpoints

### Primary: `systemHealthCheck`

```
GET https://us-central1-sokoni-aeb26.cloudfunctions.net/systemHealthCheck
```

**Response codes:**
- `200` — all systems healthy
- `206` — degraded (one or more subsystem slow/degraded)
- `503` — critical failure (Firestore unreachable, recent backup missing)

**Lightweight checks (GET, no auth):**
- Firestore write/read round-trip
- Email queue depth
- Algolia reachability

**Full diagnostics (POST with Bearer token):**
```bash
curl -X POST https://us-central1-sokoni-aeb26.cloudfunctions.net/systemHealthCheck \
  -H "Authorization: Bearer <ADMIN_TOKEN>"
```
Adds: email failure rate, secrets presence, recent paid orders, backup age.

**Setup:** Register this URL with an external uptime monitor (UptimeRobot, Freshping, Checkly) polling every 60 seconds. Set `minInstances: 1` in `firebase.json` for this function to eliminate cold-start false positives.

---

### Secondary: `obsHealthProbe`

```
GET https://us-central1-sokoni-aeb26.cloudfunctions.net/obsHealthProbe
```

Used by the observability engine. Also register with GCP Cloud Monitoring uptime checks.

---

## GCP Cloud Monitoring

### Alert Policies

18 alert policies are defined in `monitoring/alerts.json`. They must be provisioned via:

```bash
# Step 1: Create a notification channel in GCP Cloud Monitoring console
# GCP Console → Monitoring → Alerting → Notification Channels → Add → Email
# Note the channel ID (format: projects/sokoni-aeb26/notificationChannels/XXXXXXXXXXXX)

# Step 2: Update monitoring/alerts.json
# Replace "REPLACE_WITH_ACTUAL_CHANNEL_ID" with your channel ID

# Step 3: Apply all 18 policies
node scripts/setup-monitoring.js
```

### Alert Policy Catalog

| Policy | Threshold | Channel |
|---|---|---|
| CF error rate | > 5% over 5 min | devops@ |
| CF P95 latency | > 10s over 5 min | devops@ |
| Firestore P99 read latency | > 2s over 5 min | devops@ |
| Webhook DLQ depth | > 10 | devops@ |
| Fraud block rate | > 10 per hour | security@ |
| HTTP 5xx error rate | > 1% | devops@ |
| Hardcoded secret in build | Any | security@ |
| Email queue depth | > 200 | devops@ |
| Payment verification failure | > 10% | payments@ + security@ |
| Backup not run in 26h | Any gap | admin@ |
| CSP violations spike | > 50/hr | security@ |
| Search health degraded | Status != healthy | devops@ |
| System health check degraded | 206 or 503 | admin@ + devops@ |
| Payment idempotency replay spike | > 20/hr | security@ |
| Rate limit abuse | Configurable | security@ |
| SLO breach — order success | < 99% | admin@ |
| SLO breach — checkout error | Threshold | admin@ |
| KASS prompt injection | Any | security@ |

---

## Scheduled Health Functions

These run automatically — no configuration needed after deployment.

| Function | Schedule | What it checks | Where results go |
|---|---|---|---|
| `relScheduledHealthCheck` | Every 5 min | Firestore, Redis, IntaSend, Anthropic | `_sokoniAlertFired` collection |
| `obsCheckAlerts` | Every 5 min | All alert rules in `_sokoniAlerts` | Alert channels |
| `recordSystemHealthSnapshot` | Every 15 min | 10 subsystems | `systemHealthHistory` |
| `obsScheduledAggregation` | Every 1 hour | Metric rollup | `obsMetrics` |
| `scheduledHourlyMonitor` | Every 1 hour | Orders, revenue, payment anomalies | Admin alerts |
| `scheduledDailyOpsReport` | 06:00 EAT | 24h ops metrics | `ops_reports`, email to devops@ |
| `scheduledDailyExecutiveSummary` | 07:00 EAT | Executive KPIs | `executiveSummaries` |
| `scheduledWeeklySecurityReport` | Mon 07:00 EAT | Security digest | Email to devops@ + security@ |
| `scheduledFirestoreBackup` | 02:00 EAT | Firestore export | GCS bucket |

### Seeding Alert Rules

`obsCheckAlerts` evaluates rules from the `_sokoniAlerts` Firestore collection. If this collection is empty, no custom alerts fire. Seed initial rules via the Observability dashboard or `obsCreateAlert` CF:

```javascript
// Example: seed an alert for high payment failure rate
await firebase.functions().httpsCallable('obsCreateAlert')({
  name: 'High Payment Failure Rate',
  metric: 'payment_failure_rate',
  threshold: 0.1,
  operator: 'gt',
  severity: 'critical',
  channels: ['devops@mysokoni.co.ke', 'security@mysokoni.co.ke'],
});
```

---

## Operational Dashboards

All dashboards require admin authentication.

| Dashboard | URL | Purpose |
|---|---|---|
| **Admin OS** | /admin-os.html | Primary operations hub — 19 panels, KPIs, user mgmt |
| **Operations Center** | /ops-center.html | Workflow queue, escalations, ops calendar |
| **Reliability Center** | /reliability-center.html | Health timeline, dead letter queue, circuit breakers |
| **Observability** | /observability.html | Errors, performance, real-time metrics, audit log |
| **Redis Monitor** | /redis-monitor.html | Redis health, hit rates, memory |
| **Trust & Safety** | /trust-safety.html | Content moderation, trust signals |
| **Security Dashboard** | /security-zero-trust-dashboard.html | Zero Trust posture, threat signals |
| **Status Page** | /status.html | Public-facing platform status |

---

## Reading Automated Reports

### Daily Ops Report (devops@mysokoni.co.ke, 06:00 EAT)

Key sections to review:
- **Error rate** — Cloud Function errors in the last 24h
- **Payment health** — successful vs. failed payments, refunds
- **User registrations** — new users, verification rate
- **Order volume** — orders placed, fulfilled, cancelled
- **CF performance** — P50/P95/P99 latency by function

Flag anything with > 5% error rate or > 2x day-over-day change.

### Weekly Security Digest (security@mysokoni.co.ke, Mon 07:00 EAT)

Key sections:
- **Authentication events** — failed logins, suspicious IPs, new admin grants
- **Payment anomalies** — flagged transactions, fraud blocks
- **Rate limit hits** — sources hitting limits repeatedly
- **Secret Manager access** — any unexpected access patterns
- **Firestore rules denials** — top denied operations (may indicate attack vectors)

---

## Incident Detection Flow

```
Metric threshold exceeded
    ↓
GCP Cloud Monitoring alert fires
    ↓
Email to devops@mysokoni.co.ke + security@mysokoni.co.ke (if security alert)
    ↓
Alex or Isaac investigates
    ↓
If P0/P1: follow Disaster Recovery runbook
    ↓
Resolution + post-incident review
    ↓
Update alert threshold if false positive
```

---

## Monitoring Gaps — Pre-Go-Live Actions

| Action | Priority | Owner |
|---|---|---|
| Run `node scripts/setup-monitoring.js` after adding notification channel ID | CRITICAL | Alex |
| Register `systemHealthCheck` URL with external uptime monitor (UptimeRobot/Freshping) | CRITICAL | Alex |
| Set `minInstances: 1` for `systemHealthCheck` and `obsHealthProbe` in firebase.json | HIGH | Engineering |
| Seed initial `_sokoniAlerts` rules via obsCreateAlert CF | HIGH | Alex |
| Confirm GCS bucket IAM grants for `scheduledFirestoreBackup` | HIGH | Alex |
| Set up independent status page mirror (Cloudflare Pages or GitHub Pages) | MEDIUM | Alex |
| Designate backup on-call contact with Firebase Console access | MEDIUM | Alex |

---

*Document: SOKONI Monitoring Guide v1.0 — 2026-07-13*
