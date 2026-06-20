# SOKONI Incident Response Runbook

**Version:** 1.0 — RC1
**Last Updated:** 2026-06-20
**Owner:** Platform Engineering

---

## Severity Levels

| Level | Name | Definition | Response Time | Escalation |
|-------|------|------------|---------------|------------|
| SEV-1 | Critical | Platform down, payments broken, data loss | 15 min | Founder + all engineers |
| SEV-2 | High | Major feature broken for all users | 30 min | Lead engineer |
| SEV-3 | Medium | Feature broken for subset of users | 2 hours | On-call engineer |
| SEV-4 | Low | Minor bug, cosmetic, single user | Next business day | Ticket queue |

---

## SEV-1 Triggers (Immediate Action)

- mysokoni.co.ke returns 5xx or is unreachable
- IntaSend STK push not triggering / payments silently failing
- Firestore write errors in production (orders not saving)
- User data breach or unauthorized access detected
- Firebase Authentication down (no one can log in)
- Production Cloud Functions all failing
- Service worker serving stale/broken build to all users

---

## On-Call Contacts

| Role | Contact |
|------|---------|
| Founder / CTO | ogutualex824@gmail.com |
| Firebase Support | console.firebase.google.com → Support |
| IntaSend Support | support@intasend.com |
| Cloudflare Status | cloudflarestatus.com |

---

## Incident Response Steps

### 1. Detect

Sources:
- monitor.html Platform Monitor dashboard
- Firebase Console → Functions → Logs
- Firebase Console → Firestore → Usage
- GitHub Actions CI status
- User reports via support.html

### 2. Assess Severity

Answer:
- Are payments affected? → likely SEV-1
- Is login broken? → SEV-1
- Is the home page down? → SEV-1
- Is it a single page / feature? → SEV-2 or SEV-3

### 3. Communicate

Within 5 minutes of SEV-1:
- Post in team channel: `[SEV-1 INCIDENT] <what's broken> — investigating`
- Do NOT speculate about cause until confirmed

### 4. Diagnose

```bash
# Check Firebase Hosting release
npx firebase-tools hosting:releases:list --project sokoni-aeb26 --limit 5

# Check Cloud Functions logs
npx firebase-tools functions:log --project sokoni-aeb26 --limit 50

# Check recent deployments
git log --oneline -10

# Check service worker version
curl -s https://mysokoni.co.ke/service-worker.js | grep "CACHE_VERSION"
```

### 5. Mitigate

**Option A — Roll back hosting (fastest)**
```bash
# List releases, get version ID of last known-good
npx firebase-tools hosting:releases:list --project sokoni-aeb26 --limit 5

# Roll back via GitHub Actions workflow_dispatch → target: rollback
# OR directly:
npx firebase-tools hosting:rollback --project sokoni-aeb26
```

**Option B — Redeploy from last good commit**
```bash
git log --oneline -5
git checkout <good-commit-sha>
npx firebase-tools deploy --only hosting --project sokoni-aeb26
```

**Option C — Disable a broken Cloud Function**
```bash
# Delete and redeploy a specific function
npx firebase-tools functions:delete <functionName> --project sokoni-aeb26 --force
```

**Option D — Emergency Firestore rule lock (stops all writes)**
Only for data breach. Add to firestore.rules:
```
match /{document=**} {
  allow read, write: if false;
}
```
Then deploy immediately:
```bash
npx firebase-tools deploy --only firestore:rules --project sokoni-aeb26
```

### 6. Verify Fix

- Run smoke test against production:
  ```bash
  SMOKE_BASE_URL=https://mysokoni.co.ke node test-smoke.js
  ```
- Manually verify: home page, login, checkout, POS

### 7. Post-Incident Report

Within 24 hours, document in `docs/incidents/YYYY-MM-DD-title.md`:

```markdown
## Incident: <title>
**Date:** YYYY-MM-DD  
**Duration:** X hours  
**Severity:** SEV-X  
**Impact:** <who was affected, how many users>

### Timeline
- HH:MM — First alert
- HH:MM — Root cause identified
- HH:MM — Fix deployed
- HH:MM — Verified resolved

### Root Cause
<one paragraph — what went wrong and why>

### Resolution
<what was done to fix it>

### Prevention
<what changes will prevent recurrence>
```

---

## Payment Incident Playbook

### Symptom: STK Push not triggering

1. Check IntaSend dashboard → API logs
2. Check Cloud Function `intasendWebhook` logs in Firebase Console
3. Verify `INTASEND_PUBLIC_KEY` in `sokoni-config.js` is the live key (`ISPubKey_live_`)
4. Test with IntaSend sandbox to isolate platform vs IntaSend issue
5. If IntaSend is down: notify users, halt checkout — do NOT allow offline approvals

### Symptom: Orders marked paid without IntaSend confirmation

This must never happen. If it does:
1. **SEV-1 immediately**
2. Lock Firestore writes with emergency rule
3. Audit `orders` collection for `status: "paid"` without matching `intasendRef`
4. Reverse fraudulent orders manually
5. Root-cause the bypass path and patch it

---

## Service Worker Incident Playbook

### Symptom: Users seeing old/broken build after deploy

```bash
# Bump CACHE_VERSION in service-worker.js
# This forces all browsers to install the new SW
grep "CACHE_VERSION" service-worker.js

# Deploy
npx firebase-tools deploy --only hosting --project sokoni-aeb26
```

Users will get the update on their next page load (within ~24h). For immediate fix, they can clear site data.

---

## Firestore Incident Playbook

### Symptom: Reads/writes rejected unexpectedly

1. Check `firestore.rules` — was a recent deploy overly restrictive?
2. Check Firebase Console → Firestore → Rules → Playground
3. Roll back rules:
   ```bash
   git log --oneline -- firestore.rules
   git show <previous-sha>:firestore.rules > firestore.rules.backup
   # Edit firestore.rules to restore previous version
   npx firebase-tools deploy --only firestore:rules --project sokoni-aeb26
   ```

### Symptom: Cloud Function write failing

1. Confirm the function is using Admin SDK (bypasses rules)
2. Check service account permissions in GCP Console
3. Check function logs for specific error code

---

## Monitoring Shortcuts

| Check | URL |
|-------|-----|
| Platform Monitor | https://mysokoni.co.ke/monitor.html |
| Firebase Console | console.firebase.google.com/project/sokoni-aeb26 |
| Functions Logs | console.firebase.google.com/project/sokoni-aeb26/functions/logs |
| Firestore Usage | console.firebase.google.com/project/sokoni-aeb26/firestore/usage |
| Hosting Releases | console.firebase.google.com/project/sokoni-aeb26/hosting |
| IntaSend Dashboard | app.intasend.com |
| GitHub Actions | github.com → your repo → Actions |
