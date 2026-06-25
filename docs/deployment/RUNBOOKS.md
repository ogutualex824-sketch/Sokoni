# SOKONI Operational Runbooks

**Last Updated:** 2026-06-25  
**Owner:** Engineering / SRE

---

## RB-001: Standard Production Deploy

**When:** Merging a feature to `main`  
**Duration:** ~45 min (canary stages)

```bash
# Trigger via GitHub Actions:
# Actions → "Canary Deploy — Progressive Rollout" → Run workflow
# Defaults: start_stage=1, skip_gate=false, rollback_on_failure=true

# Or manually trigger:
gh workflow run canary-deploy.yml
```

**Monitor:**
- GitHub Actions run page for stage-by-stage status
- GCP Cloud Monitoring → SOKONI dashboard
- `https://mysokoni.co.ke` — spot check after each stage

---

## RB-002: Emergency Hotfix Deploy (Skip Canary)

**When:** Critical production bug (payment blocked, auth broken, data loss)

```bash
# 1. Fix the code, commit, push to main

# 2. Trigger with gate skip (only if you verified no payments in-flight):
gh workflow run canary-deploy.yml \
  -f start_stage=6 \
  -f skip_gate=true \
  -f rollback_on_failure=true

# 3. Monitor for 5 minutes after deploy
# 4. Write incident report (see INCIDENT_RESPONSE.md)
```

---

## RB-003: Manual Rollback

**When:** Automated rollback failed, or you need to rollback manually

```bash
# Find the last good release tag
git tag --list "release-*" | sort | tail -5

# Option A — full-stack rollback script
FIREBASE_TOKEN=<token> node scripts/deploy/rollback.js

# Option B — Firebase hosting only (fastest)
firebase hosting:releases:list --project sokoni-aeb26
firebase hosting:clone sokoni-aeb26:<release-id> sokoni-aeb26:live

# Option C — Cloud Functions only
git checkout <last-good-tag>
firebase deploy --only functions --project sokoni-aeb26
```

---

## RB-004: Enable Maintenance Mode

**When:** Planned maintenance window, critical bug affecting all users

```bash
# Via Firebase Remote Config (takes effect in < 1 minute):
node -e "
const admin = require('firebase-admin');
admin.initializeApp();
admin.remoteConfig().getTemplate().then(t => {
  t.parameters.maintenance_mode = { defaultValue: { value: 'true' } };
  return admin.remoteConfig().publishTemplate(t);
}).then(() => console.log('Maintenance mode ON'));
"

# Check it is active:
curl https://us-central1-sokoni-aeb26.cloudfunctions.net/systemHealthCheck
# Should return: {"maintenance": true}

# Disable:
# Change maintenance_mode back to 'false' in Firebase Remote Config console
```

---

## RB-005: Firestore Data Migration

**When:** Schema change requires backfilling existing documents

```bash
# List all migrations and their status
node scripts/migrations/runner.js list

# Dry run a migration (read-only report)
node scripts/migrations/runner.js run <migration-name> --dry-run

# Execute migration
node scripts/migrations/runner.js run <migration-name>

# Verify migration (counts docs with new schema)
node scripts/migrations/runner.js verify <migration-name>

# Rollback a migration (reverts field changes)
node scripts/migrations/runner.js rollback <migration-name>
```

**Migration files live in:** `scripts/migrations/`  
**State stored in:** Firestore `_migrations` collection

---

## RB-006: Typesense Index Migration

**When:** Adding new fields, changing tokenization, or reindexing

```bash
# Migrate one collection
TYPESENSE_ADMIN_KEY=<key> node scripts/migrations/typesense-migrate.js \
  --collection=sokoni_products

# Migrate all collections
TYPESENSE_ADMIN_KEY=<key> node scripts/migrations/typesense-migrate.js --all

# Rollback (restore aliases to originals)
TYPESENSE_ADMIN_KEY=<key> node scripts/migrations/typesense-migrate.js \
  --rollback --collection=sokoni_products
```

---

## RB-007: Algolia Index Migration

**When:** Schema change, facet change, or replica adjustment

```bash
# Blue-green migrate one index
ALGOLIA_APP_ID=FF2WSTR4YC \
ALGOLIA_ADMIN_KEY=<key> \
node scripts/migrations/algolia-migrate.js --index=products_index

# All indexes
node scripts/migrations/algolia-migrate.js --all
```

---

## RB-008: Nightly Backup — Manual Trigger

```bash
# All resources
gh workflow run backup.yml -f target=all

# Firestore only
gh workflow run backup.yml -f target=firestore

# Verify backup exists in GCS
gsutil ls gs://sokoni-aeb26-backups/firestore/ | tail -3
```

---

## RB-009: Restore Firestore from Backup

```bash
# 1. Find the backup timestamp
gsutil ls gs://sokoni-aeb26-backups/firestore/

# 2. Import into a recovery project first (never overwrite live directly)
gcloud firestore import gs://sokoni-aeb26-backups/firestore/<TIMESTAMP> \
  --project=sokoni-recovery \
  --async

# 3. Validate data in recovery project
# 4. If confirmed, import into production:
gcloud firestore import gs://sokoni-aeb26-backups/firestore/<TIMESTAMP> \
  --project=sokoni-aeb26
```

---

## RB-010: Investigate High Error Rate

```bash
# 1. Check GCP Cloud Monitoring
#    Dashboards → SOKONI → Error Rate panel

# 2. Check recent Cloud Function logs
gcloud functions logs read --project=sokoni-aeb26 --limit=100 --gen2

# 3. Check health endpoint
curl -s https://us-central1-sokoni-aeb26.cloudfunctions.net/systemHealthCheck | jq .

# 4. If payment-related, check IntaSend dashboard + Firestore payments collection
# 5. Decide: hotfix deploy or rollback
#    Error rate > 5%: rollback immediately (see RB-003)
#    Error rate 2-5%: investigate for 10 min, hotfix if cause found

# 6. Open incident (see INCIDENT_RESPONSE.md)
```

---

## RB-011: Rotate API Keys / Secrets

```bash
# List all secrets
gcloud secrets list --project=sokoni-aeb26

# Add new version of a secret (bash)
printf 'new-secret-value' | firebase functions:secrets:set SECRET_NAME

# Deploy functions to pick up new secret version
firebase deploy --only functions --project=sokoni-aeb26

# Verify secret is live (will show version number, not value)
firebase functions:secrets:access SECRET_NAME --project=sokoni-aeb26
```

---

## RB-012: Feature Flag Toggle

```bash
# Via Firebase Remote Config in console:
# https://console.firebase.google.com → Remote Config → your project

# Key flags:
#   maintenance_mode     true/false  — block all traffic
#   read_only_mode       true/false  — disable writes
#   new_checkout_flow    true/false  — A/B test new checkout
#   ai_search_enabled    true/false  — Typesense AI features
#   advanced_analytics   true/false  — detailed tracking

# Changes propagate in < 1 minute to all clients
# Server-side functions pick up on next invocation (1-min cache)
```
