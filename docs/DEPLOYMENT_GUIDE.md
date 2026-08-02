# SOKONI Deployment Guide

**Platform:** SOKONI  
**Legal Entity:** Bravilex International Co. Limited  
**Environment:** Production (sokoni-aeb26)  
**Classification:** Internal — Engineering

---

## Overview

SOKONI deploys to Firebase Hosting (static assets + HTML) and Google Cloud Functions (Node.js 22, 2nd Gen) via the Firebase CLI. The project ID is `sokoni-aeb26`.

---

## Prerequisites

### Required Tools

```bash
node --version    # 22.x
firebase --version # 13.x or later
gcloud --version
```

### Authentication

```bash
firebase login          # interactive browser login
gcloud auth login        # for Secret Manager and VPC operations
firebase use sokoni-aeb26 # confirm correct project
```

### Pre-Deploy Verification Scripts

The project runs two pre-deploy hooks automatically:
1. `scripts/verify-commission-single-source.js` — ensures commission rates exist only in `functions/commission-config.js`
2. `scripts/verify-company-identity.js` — drift guard between server and client company identity files

These run automatically on every `firebase deploy`. A failure blocks the deploy and must be fixed before proceeding.

---

## Reading a predeploy failure on Windows — **ENOENT usually is not ENOENT**

> On Windows, a non-zero exit from a Firebase predeploy hook may be surfaced by the underlying
> process launcher as an `ENOENT` message. **Always inspect the gate artifact**
> (`docs/release-gates/<commit>.json`) **and the script's actual exit code** before treating the
> failure as a missing executable.

### Why it happens

The CLI spawns each hook through `cross-spawn` as a single string with `shell:false`. On a non-zero
exit, `cross-spawn` runs `verifyENOENT`, tries to resolve a literal file named
`node scripts/<gate>.js`, fails, and **synthesises a "command not found" error over a real gate
refusal**:

```
Error: spawn node scripts\gate-inventory.js ENOENT
```

The script is present and it ran. Hooks that exit 0 never trip this, which is why a chain can look
like "seven hooks work, the eighth is misconfigured" when in truth **all eight execute and the
eighth legitimately fails**.

### How to diagnose it correctly

```bash
# 1. Real exit code. Do NOT pipe — $? would be the exit code of the pipe's LAST command.
node scripts/gate-inventory.js >/dev/null 2>&1; echo $?

# 2. The verdict the gate actually recorded
node -e "console.log(require('./docs/release-gates/<commit>.json').status)"
```

A `BLOCKED` verdict means a suite could not run (typically the Firestore emulator, which needs
**JDK 21**) — not that a suite failed. Per the Release Validation Standard these are never conflated.

### What not to do

**Never remove the hook, comment it out, or pass `--force`.** The deployment pipeline is part of
production. An `ENOENT` here is the gate doing its job behind a bad error message; bypassing it
ships exactly the unverified code the gate exists to stop.

Verified 2026-08-02: the gate ran 149s to completion, wrote its artifact, reported `BLOCKED`, and
exited 1 — while the CLI reported `ENOENT`.


## Deployment Commands

### Full Deploy (all services)

```bash
firebase deploy --only hosting,functions
```

> Only run this when no background deploy is already in progress. Wait for exit-code notification before retrying.

### Targeted Deploys (preferred for production changes)

```bash
# Hosting only (HTML, CSS, JS, service worker)
firebase deploy --only hosting

# Specific function(s) only
firebase deploy --only functions:notifySend
firebase deploy --only functions:scheduledDailyOpsReport,functions:scheduledWeeklySecurityReport

# Functions + hosting together
firebase deploy --only hosting,functions:notifySend

# Firestore rules only
firebase deploy --only firestore:rules

# Storage rules only
firebase deploy --only storage:rules
```

### After Africa's Talking Sender ID Approval

```bash
# Step 1: Update functions/.env
# Change: AT_SENDER_ID=
# To:     AT_SENDER_ID=SOKONI

# Step 2: Targeted deploy (SMS functions only)
firebase deploy --only functions:notifySend,functions:sokoniAtDispatch
```

---

## Service Worker Cache Version

Every deploy that changes cached assets **must** bump the cache version in `service-worker.js`:

```javascript
const CACHE_VERSION = "sokoni-YYYYMMDD-description-vNN";
```

Format: `sokoni-{date}-{short-description}-v{sequential-number}`

Current version: `sokoni-20260713-notify-channels-v68`

---

## Environment Variables

Production environment variables live in `functions/.env`. Secrets (API keys, tokens) live in Google Secret Manager, not in `.env`.

`.env` contains non-secret configuration:
- `AT_ENV=production`
- `AT_SENDER_ID=` (empty until AT approves SOKONI sender ID)
- `NODE_ENV=production`
- Redis URL reference, feature flags

Secrets are declared in `functions/index.js` via `defineSecret()` and accessed at runtime via `secretName.value()`.

### Setting a Secret

```bash
firebase functions:secrets:set SECRET_NAME
# Prompts for value securely
```

### Verifying Secrets Are Set

```bash
firebase functions:secrets:list
# Shows all secrets with version status
```

---

## Deploy Pre-Flight Checklist

Before any production deploy:

1. **Check for running deploys** — never deploy if a background deploy is in progress
2. **Review git diff** — confirm only intended files changed
3. **Check service worker version** — bump if any cached asset changed
4. **Verify `.env` values** — no placeholders introduced
5. **Run pre-deploy scripts manually** (optional, they run automatically):
   ```bash
   node scripts/verify-commission-single-source.js
   node scripts/verify-company-identity.js
   ```

---

## Rollback Procedure

### Hosting Rollback (instant)

Firebase Hosting keeps the last 25 release versions. Rollback via console or CLI:

```bash
# List recent releases
firebase hosting:releases:list

# Roll back to previous release
firebase hosting:channel:deploy live --version <VERSION_ID>
```

Or via Firebase Console:
`Firebase Console → Hosting → Release history → Click version → Rollback`

### Cloud Functions Rollback

Cloud Functions (2nd Gen / Cloud Run) rollback via Google Cloud Console:
`Cloud Console → Cloud Run → sokoni-aeb26 → Revisions → Route traffic to previous revision`

For critical rollback, redeploy the previous git commit:
```bash
git stash          # save any uncommitted changes
git log --oneline  # identify the target commit
git checkout <COMMIT_HASH> -- functions/
firebase deploy --only functions:<FUNCTION_NAME>
git checkout HEAD -- functions/  # restore
```

### Firestore Rules Rollback

```bash
git checkout <PREVIOUS_COMMIT> -- firestore.rules
firebase deploy --only firestore:rules
git checkout HEAD -- firestore.rules
```

---

## Pending Quota-Blocked Deploys

The following Cloud Functions are pending GCP Cloud Run CPU quota approval before they can be deployed:

- `financial-os.js` (23 functions)
- `platform-core.js`
- `sub-engine.js`
- `messages.js`

See `DEPLOY_QUEUE.md` for the exact deploy command. Do not attempt these until GCP confirms quota increase.

---

## CI/CD Notes

The project does not yet have automated CI/CD. All deployments are manual via Firebase CLI. Recommended future state: GitHub Actions workflow that:
1. Runs pre-deploy scripts
2. Deploys on merge to `main`
3. Sends notification to `devops@mysokoni.co.ke` on completion

---

*Document: SOKONI Deployment Guide v1.0 — 2026-07-13*
