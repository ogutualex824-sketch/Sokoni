# SOKONI Deployment Architecture

**Status:** Production  
**Last Updated:** 2026-06-25  
**Version:** SRE v1.0

---

## Overview

SOKONI uses a zero-downtime, multi-stage deployment system modelled on Amazon, Shopify, Stripe, Google, and Microsoft practices.

```
Developer Push
      │
      ▼
GitHub Actions CI
├── Lint + Type Check
├── Unit Tests
├── Pre-Deploy Safety Gate     ← blocks if payments in-flight
│
├── Deploy Cloud Functions     ← always latest code
│
├── Canary Stage 1 — 1%       ← Cloudflare traffic split
├── Canary Stage 2 — 5%       ← auto-rollback on error spike
├── Canary Stage 3 — 10%
├── Canary Stage 4 — 25%
├── Canary Stage 5 — 50%
│
└── Production — 100%
          │
          ▼
    Firebase Hosting (CDN)
    Cloud Functions Gen2 (us-central1)
    Firestore (multi-region)
    Typesense (managed cloud)
    Algolia (managed cloud)
```

---

## Components

### 1. Pre-Deploy Safety Gate
**File:** [scripts/deploy/gate.js](../../scripts/deploy/gate.js)

Blocks deployment if any of the following are true:
- `payments` collection has documents in `pending` or `processing` state
- POS sessions are open (`posActiveSessions`)
- Webhook queue depth > 50 (`webhookQueue`)
- Email queue is saturated (`emailQueue` > 200)
- Active financial reconciliations in progress

Timeout: 10 minutes. Polling interval: 15 seconds.

### 2. Canary Releases
**File:** [.github/workflows/canary-deploy.yml](../../.github/workflows/canary-deploy.yml)  
**Controller:** [scripts/deploy/canary-controller.js](../../scripts/deploy/canary-controller.js)

| Stage | Traffic | Min Observe | Error Threshold |
|-------|---------|-------------|-----------------|
| 1     | 1%      | 2 min       | < 2%            |
| 2     | 5%      | 4 min       | < 2%            |
| 3     | 10%     | 6 min       | < 1.5%          |
| 4     | 25%     | 8 min       | < 1%            |
| 5     | 50%     | 10 min      | < 1%            |
| 6     | 100%    | —           | —               |

Auto-rollback triggers on 3 consecutive health check failures at any stage.

### 3. Feature Flags
**Client:** [sokoni-flags.js](../../sokoni-flags.js)  
**Server:** [functions/feature-flags.js](../../functions/feature-flags.js)  
**Backend:** Firebase Remote Config

Safe defaults — all new features are `false` until explicitly enabled.  
Special flags:
- `maintenance_mode` — blocks all traffic immediately
- `read_only_mode` — disables write operations platform-wide

### 4. Firestore Migrations
**Runner:** [scripts/migrations/runner.js](../../scripts/migrations/runner.js)

Pattern: **Expand → Migrate → Contract**
1. Add new fields (backward-compatible)
2. Run backfill — batch 400 docs at a time
3. Update application code to read new fields
4. Remove old fields after cutover

State tracked in `_migrations` Firestore collection.

### 5. Search Index Migrations
**Typesense:** [scripts/migrations/typesense-migrate.js](../../scripts/migrations/typesense-migrate.js)  
**Algolia:** [scripts/migrations/algolia-migrate.js](../../scripts/migrations/algolia-migrate.js)

Both use Blue-Green migration:
1. Create new versioned index/collection
2. Sync data (Typesense: via alias; Algolia: atomic `move`)
3. Swap alias/pointer to new index
4. Delete old index after 5-minute grace period

### 6. Rollback
**File:** [scripts/deploy/rollback.js](../../scripts/deploy/rollback.js)  
**Workflow:** [.github/workflows/canary-deploy.yml](../../.github/workflows/canary-deploy.yml) → `auto-rollback` job

Full-stack rollback covers:
- Firebase Hosting (previous release via `firebase hosting:clone`)
- Cloud Functions (git tag checkout + redeploy)
- Firestore Security Rules
- Cloudflare traffic reset to 100% primary

### 7. Health Monitoring
**Endpoint:** `https://us-central1-sokoni-aeb26.cloudfunctions.net/systemHealthCheck`  
**Dashboard:** GCP Cloud Monitoring  
**Alert Policies:** [monitoring/alerts.yaml](../../monitoring/alerts.yaml)

Alerts:
- CF error rate > 2% — CRITICAL
- CF P95 latency > 3s — WARNING
- Payment failure rate > 5% — CRITICAL
- Memory > 85% — WARNING
- Auth failures spike — WARNING
- Health endpoint down — CRITICAL

### 8. Backups
**Workflow:** [.github/workflows/backup.yml](../../.github/workflows/backup.yml)

Schedule: 04:00 EAT (01:00 UTC) nightly

| Resource     | Destination                                 | Retention |
|--------------|---------------------------------------------|-----------|
| Firestore    | `gs://sokoni-aeb26-backups/firestore/`      | 30 days   |
| Cloud Storage| `gs://sokoni-aeb26-backups/storage/`        | 7 days    |
| Typesense    | `gs://sokoni-aeb26-backups/search/typesense/`| 14 days  |
| Secret names | `gs://sokoni-aeb26-backups/secrets/`        | 90 days   |

### 9. Service Worker Strategy
**File:** [service-worker.js](../../service-worker.js)

The SW no longer calls `skipWaiting()` unconditionally on install.

1. Install completes silently (new assets cached)
2. Broadcasts `SW_UPDATE_READY` to all open tabs
3. Page shows "Update available — tap to reload" banner (non-intrusive)
4. User confirms or waits until checkout is complete
5. Page sends `SW_SKIP_WAITING` → SW activates immediately

This prevents mid-checkout cache invalidation that could corrupt payment state.

---

## GitHub Secrets Required

| Secret Name             | Purpose                              |
|-------------------------|--------------------------------------|
| `FIREBASE_TOKEN`        | Firebase CLI deployment              |
| `GCP_SA_KEY`            | GCP service account JSON             |
| `CLOUDFLARE_API_TOKEN`  | Cloudflare traffic split (optional)  |
| `CLOUDFLARE_ZONE_ID`    | Cloudflare zone                      |
| `SLACK_WEBHOOK_URL`     | Deploy/rollback notifications        |
| `TYPESENSE_ADMIN_KEY`   | Typesense backups                    |

---

## Related Documents
- [[RUNBOOKS]] — Day-to-day operational procedures
- [[DISASTER_RECOVERY]] — Full disaster recovery guide
- [[INCIDENT_RESPONSE]] — Incident playbooks
