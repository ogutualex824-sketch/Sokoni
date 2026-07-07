# SOKONI Operations Runbook

> Last updated: 2026-06-25  
> Firebase project: `sokoni-aeb26`  
> Hosting site: `sokoni-aeb26`  
> Domain: `mysokoni.co.ke`

---

## Phase 1 — DNS & Domain

### Required DNS Records (via registrar/NameSilo/GoDaddy/etc.)

```
# Firebase Hosting — root domain
A      @       151.101.1.195
A      @       151.101.65.195

# Firebase Hosting — www redirect
CNAME  www     sokoni-aeb26.web.app

# Firebase Hosting — verification TXT (get from Firebase Console)
TXT    @       hosting-site=sokoni-aeb26
```

> Get the exact `A` record IPs from: Firebase Console → Hosting → Custom domains → mysokoni.co.ke

### SSL Verification

Firebase provisions SSL automatically after DNS propagates (usually <1 hour, up to 24 h).

```bash
# Verify SSL and redirect are active
curl -I https://mysokoni.co.ke
curl -I http://mysokoni.co.ke   # should 301 → https
curl -I https://www.mysokoni.co.ke  # should 301 → https://mysokoni.co.ke
```

### Firebase.json Redirect Rules

`firebase.json` already includes:
- `"cleanUrls": true`
- `"trailingSlash": false`
- HSTS max-age=31536000

---

## Phase 2 — Email Infrastructure

**Status:** Code complete (`functions/email-service.js`). Needs credentials.

### Required Secrets (set once, then functions use them automatically)

```bash
# Primary transport — SendGrid
firebase functions:secrets:set SENDGRID_API_KEY
# Enter your key from https://app.sendgrid.com/settings/api_keys

# Fallback SMTP (e.g. Zoho or Gmail relay)
firebase functions:secrets:set MAIL_HOST
firebase functions:secrets:set MAIL_USER
firebase functions:secrets:set MAIL_PASS
```

### Verify Secret Access

```bash
firebase functions:secrets:access SENDGRID_API_KEY
```

### SendGrid Domain Authentication

1. Go to Settings → Sender Authentication → Domain Authentication
2. Add `mysokoni.co.ke`
3. Add the CNAME records to your DNS (usually 3 records for DKIM + tracking)
4. Verify in SendGrid

### DMARC / SPF Records

```
TXT  _dmarc.mysokoni.co.ke  "v=DMARC1; p=quarantine; rua=mailto:dmarc@mysokoni.co.ke; sp=reject; adkim=s; aspf=s"
TXT  mysokoni.co.ke         "v=spf1 include:sendgrid.net include:_spf.google.com ~all"
```

### Test Email Send

```bash
# After secrets are set and functions deployed:
curl -X POST https://us-central1-sokoni-aeb26.cloudfunctions.net/sendOrderConfirmation \
  -H "Content-Type: application/json" \
  -d '{"orderId":"TEST001","buyerEmail":"ogutualex824@gmail.com"}'
```

---

## Phase 3 — Push Notifications (FCM)

**Status: LIVE.** VAPID key is set, FCM SW is configured.

```
VAPID key: BMl0A7E14MzZgiRao7a8lhl0iRRV37jSwp26IvQGle38v3vAhZgNFNgqDObX8i_vD0Xrfw4wG-5ngbBMto7qEBg
```

### Verify VAPID Key Matches Firebase Console

1. Firebase Console → Project Settings → Cloud Messaging
2. Compare the **Web Push certificates** key with the VAPID key in `sw-register.js`
3. They must match exactly

### Test FCM Notification

```bash
# Get a device FCM token from the browser console:
#   sokoniRequestPushPermission().then(token => console.log(token))
# Then test via Firebase Console:
#   Messaging → Send test message → Paste FCM token
```

### FCM Click Actions

Defined in `firebase-messaging-sw.js` → `notificationclick` handler.  
`data.url` must be a relative URL path (`/orders`, `/inbox`, etc.).

---

## Phase 4 — Observability & Monitoring

**Status:** Alert policies defined in `monitoring/alerts.json`. NOT yet applied to GCP.

### Step 1 — Create Notification Channel

```bash
gcloud auth login
gcloud config set project sokoni-aeb26

gcloud alpha monitoring channels create \
  --display-name="SOKONI Ops" \
  --type=email \
  --channel-labels="email_address=devops@mysokoni.co.ke"

# Copy the channel ID from the output, e.g.:
#   projects/sokoni-aeb26/notificationChannels/1234567890
```

### Step 2 — Update alerts.json

Edit `monitoring/alerts.json`:
```json
"NOTIFICATION_CHANNEL_ID": "projects/sokoni-aeb26/notificationChannels/YOUR_ACTUAL_ID"
```

### Step 3 — Apply Alert Policies

```bash
node monitoring/apply-alerts.js
```

### Existing Alert Policies (7 total in alerts.json)

| Policy | Threshold |
|--------|-----------|
| CF Error Rate | > 5% over 5 min |
| CF P95 Latency | > 10s |
| Firestore Read Rate | > 100K/min |
| Payment Failure Rate | > 10% |
| Hosting 5xx Rate | > 2% |
| Auth Failure Rate | > 100/min |
| Memory Usage | > 85% |

### GCP Dashboards

- Cloud Functions: https://console.cloud.google.com/functions?project=sokoni-aeb26
- Firestore: https://console.cloud.google.com/firestore?project=sokoni-aeb26
- Hosting: https://console.cloud.google.com/firebase/project/sokoni-aeb26/hosting
- Error Reporting: https://console.cloud.google.com/errors?project=sokoni-aeb26

---

## Phase 5 — CSP Hardening

**Status:** `unsafe-inline` present in both `script-src` and `style-src`. HIGH severity.

### Current CSP (firebase.json)

```
script-src 'self' 'unsafe-inline' [CDN domains]
style-src  'self' 'unsafe-inline' [CDN domains]
```

### Migration Roadmap (3 phases)

**Phase 5A — Audit (1 week)**

```bash
# Find all inline event handlers that bypass CSP
grep -rn "onclick=\|onload=\|onerror=\|onsubmit=" --include="*.html" . | grep -v node_modules
grep -rn "<script>" --include="*.html" . | grep -v node_modules | wc -l
grep -rn "style=\"" --include="*.html" . | grep -v node_modules | wc -l
```

**Phase 5B — Extract inline scripts (2–4 weeks)**

Move `<script>` blocks at the bottom of each `.html` into the page's `.js` file.  
Inline event handlers (`onclick="..."`) → `addEventListener` in JS.

**Phase 5C — Remove unsafe-inline from script-src**

Once inline scripts are gone, replace `'unsafe-inline'` with a `'nonce-{random}'` strategy:
- Firebase Hosting serves static files, so nonces require a Cloud Function reverse proxy or
  use `'strict-dynamic'` with a service-worker-based approach

> **Interim mitigation already in place:** `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`,
> `HSTS`, `Permissions-Policy` are all set and provide significant protection even with `unsafe-inline`.

---

## Phase 6 — Search Operations

### Algolia

```
App ID:     FF2WSTR4YC
Search Key: issued at runtime by getAlgoliaSearchKey CF — NOT stored statically
Admin Key:  stored in Firebase Secret Manager as ALGOLIA_ADMIN_KEY
```
> **Key rotation:** If you rotate the Admin Key in the Algolia dashboard, run:
> `firebase functions:secrets:set ALGOLIA_ADMIN_KEY` then redeploy algolia functions.

```bash
# Set Algolia admin key (needed for index/sync Cloud Functions)
firebase functions:secrets:set ALGOLIA_ADMIN_KEY
# Enter from https://www.algolia.com/api-keys

# Trigger initial backfill indexing:
curl -X POST https://us-central1-sokoni-aeb26.cloudfunctions.net/searchBackfillAll \
  -H "Authorization: Bearer $(firebase auth:token)"
```

### Typesense

```
Host: 4kn6y5bfcxv8o702p-1.a2.typesense.net:443:https
Search Key: "" (issued per-session by getTypesenseSearchKey CF)
```

```bash
# Verify Typesense health
curl "https://4kn6y5bfcxv8o702p-1.a2.typesense.net/health"

# Set the Typesense admin key (for server-side indexing):
firebase functions:secrets:set TYPESENSE_SEARCH_KEY
```

### Search Health Dashboard

Once CFs are deployed, check the unified dashboard:
```bash
curl https://us-central1-sokoni-aeb26.cloudfunctions.net/searchGetUnifiedDashboard \
  -H "Authorization: Bearer $(firebase auth:token)"
```

---

## Phase 7 — Payment Operations

### IntaSend

```
Environment: INTASEND_ENV=production → payment.intasend.com
Environment: INTASEND_ENV=sandbox   → sandbox.intasend.com
```

```bash
# Set live private key (get from IntaSend dashboard)
firebase functions:secrets:set INTASEND_PRIVATE_KEY
# Format: ISPrivKey_live_XXXXXXXXXXXX

# Verify it's set:
firebase functions:secrets:access INTASEND_PRIVATE_KEY | head -c 20
```

### Webhook Endpoints

| Endpoint | Purpose |
|----------|---------|
| `verifyIntasendPayment` (POST) | Client-side payment verification after IntaSend callback |
| `darajaSTKPush` (callable) | Initiate M-Pesa STK Push from POS or checkout |
| `darajaSTKCallback` (POST) | Receive Safaricom STK Push callback |

### Daraja (M-Pesa Direct API) Secrets

```bash
firebase functions:secrets:set DARAJA_CONSUMER_KEY
firebase functions:secrets:set DARAJA_CONSUMER_SECRET
firebase functions:secrets:set DARAJA_PASSKEY
firebase functions:secrets:set DARAJA_SHORTCODE
firebase functions:secrets:set DARAJA_TILL_NUMBER   # if using till number
```

### Verify Payment Audit Trail

Payments write to Firestore collection `orders` with:
- `status`: pending → paid
- `statusHistory[]`: immutable log of each transition
- `verifiedAt`, `verifiedBy: "intasend-webhook"` or `"daraja-callback"`

Monitor via: https://console.cloud.google.com/firestore/data/orders?project=sokoni-aeb26

---

## Phase 8 — Backups & Recovery

**Status:** `scheduledFirestoreBackup` Cloud Function added. Runs daily at 02:00 EAT.

### One-time Setup (run in Cloud Shell)

```bash
# 1. Create backup bucket (STANDARD → NEARLINE after 30d → COLDLINE after 90d → delete after 365d)
gsutil mb -p sokoni-aeb26 -l europe-west1 gs://sokoni-aeb26-backups
gsutil lifecycle set monitoring/backup-lifecycle.json gs://sokoni-aeb26-backups

# 2. Grant the default App Engine service account export+storage permissions
SA="sokoni-aeb26@appspot.gserviceaccount.com"
gcloud projects add-iam-policy-binding sokoni-aeb26 \
  --member="serviceAccount:$SA" \
  --role="roles/datastore.importExportAdmin"
gsutil iam ch serviceAccount:$SA:roles/storage.objectAdmin gs://sokoni-aeb26-backups

# 3. Enable the Firestore Admin API
gcloud services enable firestore.googleapis.com --project sokoni-aeb26
```

### Monitor Backup Runs

```bash
# Check the ops_backups Firestore collection
# Or check GCS directly:
gsutil ls gs://sokoni-aeb26-backups/firestore/
```

### Recovery Procedure

```bash
# List available exports
gsutil ls gs://sokoni-aeb26-backups/firestore/

# Restore a specific date (WARNING: this overwrites all data)
gcloud firestore import gs://sokoni-aeb26-backups/firestore/2026-06-25 \
  --project sokoni-aeb26
```

### Cloud Storage Backup

Cloud Storage files (user uploads, product images) are automatically replicated by Firebase in multi-region mode.  
For explicit versioning on the `sokoni-aeb26.appspot.com` bucket:

```bash
gsutil versioning set on gs://sokoni-aeb26.appspot.com
```

### Secrets Recovery

If Firebase Secret Manager is lost:
1. Re-set all secrets via `firebase functions:secrets:set`
2. Required: `INTASEND_PRIVATE_KEY`, `ANTHROPIC_API_KEY`, `AT_API_KEY`, `AT_USERNAME`, `ALGOLIA_ADMIN_KEY`, `SENDGRID_API_KEY`, `MAIL_HOST`, `MAIL_USER`, `MAIL_PASS`, `TYPESENSE_SEARCH_KEY`, `DARAJA_CONSUMER_KEY`, `DARAJA_CONSUMER_SECRET`, `DARAJA_PASSKEY`, `DARAJA_SHORTCODE`, `SUB_OS_SIGNING_SECRET`

---

## Phase 9 — Release Pipeline

**Status:** CI/CD pipeline is in place via GitHub Actions.

### Pipelines

| File | Trigger | What it does |
|------|---------|-------------|
| `.github/workflows/ci.yml` | Push to main/develop/staging | ESLint, secret scan, dependency audit, Firebase rules syntax check |
| `.github/workflows/deploy.yml` | Push to main | Deploy staging channel; production via manual `workflow_dispatch` |

### Required GitHub Secrets

Set these in: GitHub repo → Settings → Secrets and variables → Actions

```
FIREBASE_TOKEN   — get via: firebase login:ci
```

### Deploy Commands (manual)

```bash
# Hosting only (fast, safe)
firebase deploy --only hosting --site sokoni-aeb26

# Functions (specific, always prefer over --only functions)
firebase deploy --only functions:verifyIntasendPayment,functions:darajaSTKPush

# Firestore rules + indexes
firebase deploy --only firestore

# NEVER run this without --only:
# firebase deploy
```

### Rollback Procedure

```bash
# List previous hosting releases
firebase hosting:releases:list --site sokoni-aeb26

# Roll back to a specific version
firebase hosting:clone sokoni-aeb26:RELEASE_ID sokoni-aeb26:live
```

### Pre-Deploy Checklist

- [ ] `npm run lint` passes (or `npx eslint@8 *.js sokoni-*.js`)
- [ ] No hardcoded secrets (`grep -r "ISPrivKey_live_" --include="*.js"`)
- [ ] SW cache version bumped (`sokoni-vXXX`)
- [ ] CHANGELOG updated
- [ ] Firestore rules tested against security rules playground

---

## Phase 10 — Feature Roadmap Prioritization

Ranked by: **Business Impact × User Demand ÷ Engineering Complexity**

| Priority | Feature | Impact | Complexity | Dependencies |
|----------|---------|--------|-----------|-------------|
| 1 | **Wallet / Balance** | Critical (cashback, refunds, loyalty) | Medium | Payments live, IntaSend settlement |
| 2 | **Jobs Hub** | High (massive Kenyan demand) | Medium | Hub registration system |
| 3 | **Loyalty & Rewards** | High (retention, repeat orders) | Low-Medium | Wallet (stores points balance) |
| 4 | **QR Code System** | High (POS, product lookup, events) | Low | SmartPOS, product page |
| 5 | **Super Admin Portal** | Critical (ops safety) | Medium | RBAC (already built) |
| 6 | **Barcode System** | Medium (inventory, SmartPOS) | Low | SmartPOS, QR system |
| 7 | **Education Hub** | Medium | High | Content management, streaming |
| 8 | **Insurance** | High (long-term) | High | Partner API integrations |
| 9 | **Government Services** | Strategic (eCitizen-like) | Very High | Legal/regulatory, Gov APIs |

### Wallet is Priority 1 Because:

- Commission deductions already computed — they need a destination
- Refunds currently have no programmatic path back to buyers
- Loyalty points need a balance store
- Delivery drivers need payout wallets
- Unlock all the above in one sprint

### Recommended Sprints (Next 90 Days)

**Sprint A (July 2026):** Wallet + Loyalty (unified `userWallet` Firestore collection, credit/debit engine, cashback on orders)  
**Sprint B (August 2026):** Jobs Hub (listings, applications, recruiter portal, AI job matching)  
**Sprint C (September 2026):** QR + Barcode + Super Admin Portal (operational safety before scale)

---

## Secret Summary Table

| Secret Name | Status | Where to Get |
|------------|--------|-------------|
| `INTASEND_PRIVATE_KEY` | Defined in Firebase | IntaSend dashboard |
| `ANTHROPIC_API_KEY` | Defined in Firebase | console.anthropic.com |
| `AT_API_KEY` | Defined in Firebase | Africa's Talking dashboard |
| `AT_USERNAME` | Defined in Firebase | Africa's Talking dashboard |
| `ALGOLIA_ADMIN_KEY` | Defined in Firebase | algolia.com/api-keys |
| `SENDGRID_API_KEY` | **NOT SET** | sendgrid.com/settings/api_keys |
| `MAIL_HOST` | `smtp.sendgrid.net` | SendGrid SMTP relay |
| `MAIL_USER` | `apikey` | SendGrid SMTP relay username |
| `MAIL_PASS` | Set (= SENDGRID_API_KEY) | SendGrid SMTP relay password |
| `TYPESENSE_SEARCH_KEY` | **NOT SET** | Typesense dashboard |
| `SUB_OS_SIGNING_SECRET` | NOT SET | `openssl rand -hex 32` |
| `DARAJA_CONSUMER_KEY` | NOT SET | Safaricom Daraja portal |
| `DARAJA_CONSUMER_SECRET` | NOT SET | Safaricom Daraja portal |
| `DARAJA_PASSKEY` | NOT SET | Safaricom Daraja portal |
| `DARAJA_SHORTCODE` | NOT SET | Safaricom Business Till |
| `NOTIFICATION_CHANNEL_ID` | NOT SET | `gcloud alpha monitoring channels create` |
| `FIREBASE_TOKEN` (GitHub) | NOT SET | `firebase login:ci` |

---

*This runbook is maintained by the SOKONI engineering team. Update it whenever infrastructure changes.*
