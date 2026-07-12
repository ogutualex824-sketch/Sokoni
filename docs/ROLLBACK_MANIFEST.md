# SOKONI Rollback Manifest — v1.0.0

**Purpose:** Step-by-step rollback procedures for each layer of the SOKONI platform.  
**Last Updated:** 2026-07-12  
**Emergency Contact:** ogutualex824@gmail.com

---

## Decision Framework

| Condition | Action |
|---|---|
| Single CF failing | Rollback that CF only (see Section 2) |
| Multiple CFs failing | Rollback all functions (see Section 3) |
| Frontend broken | Rollback hosting (see Section 4) |
| Data corruption | Activate Firestore PITR (see Section 5) |
| Security breach | Full rollback + secret rotation (see Section 6) |
| Payment system down | Activate fallback + alert team (see Section 7) |

---

## Section 1 — Git Tag Reference

```bash
# View the v1.0.0 tag
git show v1.0.0

# Create tag (if not yet tagged)
git tag -a v1.0.0 -m "SOKONI v1.0.0 Production Release 2026-07-12"
git push origin v1.0.0

# Checkout v1.0.0 (read-only inspection)
git checkout v1.0.0

# Return to main
git checkout main
```

---

## Section 2 — Single Cloud Function Rollback

```bash
# List recent deployments for a specific function
gcloud functions list --project=sokoni-aeb26 --region=europe-west1 | grep <function-name>

# Roll back to the previous version via Firebase console:
# Firebase Console → Functions → Find function → "..." menu → "Rollback"

# Or redeploy the specific function from a known-good commit:
git checkout v1.0.0 -- functions/<file>.js
firebase deploy --only functions:<functionName>
```

---

## Section 3 — Full Functions Rollback

```bash
# 1. Check out the v1.0.0 tag
git checkout v1.0.0

# 2. Redeploy all functions from v1.0.0
firebase deploy --only functions

# 3. Return main branch to HEAD
git checkout main
```

> **Note:** CF rollback does NOT affect Firestore data. Existing documents remain.

---

## Section 4 — Hosting Rollback

### Option A — Firebase Console
1. Firebase Console → Hosting → Release history
2. Find the last known-good release
3. Click "Rollback to this release"

### Option B — CLI
```bash
# List hosting releases
firebase hosting:releases:list

# Roll back hosting to a previous release ID
firebase hosting:rollback --release <releaseId>
```

### Service Worker Cache Bust (Required After Hosting Rollback)
```bash
# Edit service-worker.js — change CACHE_VERSION to force clients to refresh
# Example: bump suffix v40 → v41
# Then redeploy
firebase deploy --only hosting
```

---

## Section 5 — Firestore Point-in-Time Recovery (PITR)

PITR is enabled on both databases. It allows restoring Firestore data to any point within the last 7 days.

```bash
# Restore the (default) database to a specific timestamp
gcloud firestore databases restore \
  --source-database="(default)" \
  --destination-database="sokoni-restore-$(date +%Y%m%d)" \
  --snapshot-time="2026-07-12T00:00:00Z" \
  --project=sokoni-aeb26

# Restore sokoni-ops database
gcloud firestore databases restore \
  --source-database="sokoni-ops" \
  --destination-database="sokoni-ops-restore-$(date +%Y%m%d)" \
  --snapshot-time="2026-07-12T00:00:00Z" \
  --project=sokoni-aeb26
```

> Restoration creates a new database. Alias your CF `databaseId` config to point to the restored DB after verifying the data.

---

## Section 6 — Security Breach Response

### Immediate steps (within 5 minutes)
1. **Disable Firebase Auth** — Firebase Console → Authentication → Disable provider(s) under attack
2. **Block the IP** — Cloudflare Dashboard → Security → WAF → Add IP block rule
3. **Revoke compromised credentials** — rotate in Secret Manager:

```bash
# Rotate a compromised secret
echo "NEW_SECRET_VALUE" | gcloud secrets versions add <SECRET_NAME> \
  --data-file=- --project=sokoni-aeb26

# Disable all old versions
gcloud secrets versions list <SECRET_NAME> --project=sokoni-aeb26
gcloud secrets versions disable <VERSION_ID> --secret=<SECRET_NAME> --project=sokoni-aeb26
```

4. **Revoke Firebase tokens** — Firebase Console → Authentication → User → Revoke sessions
5. **Enable maintenance mode** — Set `platformMaintenance: true` flag in Firestore `platform/config`
6. **Notify users** — Use `sendBroadcastEmail` CF or Admin OS → Communications panel

---

## Section 7 — Payment System Failure

### STK Push (M-Pesa) Down
1. Check IntaSend status page
2. Check `payments` Firestore collection for stuck `pending` status docs
3. Retry stuck payments via Admin OS → FinOS → Retry Payment
4. If IntaSend is fully down — notify users via broadcast email; suspend payment-dependent features

### Wallet Failures
1. Check `wallets` collection for inconsistencies
2. Restore from PITR if data corruption detected
3. Manually adjust balances via Admin OS → FinOS → Manual Ledger Adjustment (audited)

### Settlement Stuck
1. Check `settlements` Firestore collection
2. Check `autoSettlement` Cloud Scheduler job status
3. Trigger manual settlement via Admin OS → FinOS → Trigger Settlement

---

## Section 8 — Email System Failure

```bash
# Test SendGrid key
bash scripts/verify-email.sh

# Replace key if compromised
bash scripts/setup-sendgrid.sh

# Force email queue reprocessing
firebase functions:call processEmailQueue --data '{}'
```

---

## Section 9 — Rollback Verification Checklist

After any rollback, verify:

- [ ] Homepage loads at https://mysokoni.co.ke
- [ ] Login (Email, Google, Phone OTP) works
- [ ] Product search returns results
- [ ] STK push test with KES 1 completes
- [ ] Admin OS accessible at /admin.html with admin credentials
- [ ] SmartPOS checkout completes a test sale
- [ ] Delivery tracking updates in real time
- [ ] No JS console errors on homepage, product page, checkout

---

## Section 10 — Post-Incident Report Template

After any rollback or incident:

```
Date: 
Duration: 
Severity: P0 / P1 / P2 / P3
Systems affected: 
Root cause: 
Timeline:
  HH:MM — Incident detected
  HH:MM — Investigation started
  HH:MM — Rollback initiated
  HH:MM — Service restored
Action items:
  1. 
  2. 
Lessons learned:
```

File at: `docs/ops-reports/incident-YYYY-MM-DD.md`
