# SFOS Deployment Checklist — SOKONI Financial OS v1.1

**Version:** 1.1  
**Date:** 2026-07-14  
**Status:** Production  
**Author:** SOKONI Engineering  
**Applies to:** `sfos-engine.js` · `sfos-wallet.html` · `sfos-core.js` · Firestore rules/indexes  

> **Change-freeze rule:** All SFOS changes require sign-off from two engineers.  
> Do not proceed if any prior step is un-checked.

---

## Table of Contents

1. [Pre-Deployment Checks](#1-pre-deployment-checks)
2. [Deployment Sequence](#2-deployment-sequence)
3. [Post-Deployment Validation](#3-post-deployment-validation)
4. [Rollback Trigger Conditions](#4-rollback-trigger-conditions)
5. [Rollback Steps](#5-rollback-steps)
6. [Sign-Off Record](#6-sign-off-record)

---

## 1. Pre-Deployment Checks

Complete every item below before touching production infrastructure. Mark with date and initials.

### 1.1 Secrets & Configuration

- [ ] `ANTHROPIC_API_KEY` present in Secret Manager (`sokoni-prod/ANTHROPIC_API_KEY`)
- [ ] `WALLET_QR_SECRET` present in Secret Manager (`sokoni-prod/WALLET_QR_SECRET`)
- [ ] `SENDGRID_API_KEY` present in Secret Manager (`sokoni-prod/SENDGRID_API_KEY`) and is a live key (not placeholder)
- [ ] `LOYALTY_HMAC_SECRET` present in Secret Manager (`sokoni-prod/LOYALTY_HMAC_SECRET`)
- [ ] `INTASEND_API_KEY` and `INTASEND_PRIVATE_KEY` present in Secret Manager
- [ ] `REDIS_URL` present in Secret Manager if Redis integration is enabled
- [ ] Confirm no plaintext secrets in `functions/sfos-engine.js`, `sfos-core.js`, or `.env` files
  - Command: `grep -rn "sk-ant\|AKIA\|password\|secret" functions/sfos-engine.js`
  - Expected: zero matches

### 1.2 Firestore Rules

- [ ] Run `firebase deploy --only firestore:rules --dry-run` — no errors
- [ ] Confirm the following rules are active in `firestore.rules`:
  - `sfosLedger`: read for owner (`debitUid` or `creditUid`); **all writes DENIED** (CF-only via Admin SDK)
  - `sfosIdentity`: read for owner; **all writes DENIED**
  - `sfosEscrow`: read for buyer or seller; **all writes DENIED**
  - `sfosRisk`: **read and write DENIED** for all clients
  - `sfosGroups`: read for members; **all writes DENIED**
  - `sfosRewards`: read for owner; **all writes DENIED**
  - `sfosIdempotency`: **read and write DENIED** for all clients
  - `sfosAuditLog`: **read and write DENIED** for all clients
- [ ] Run `firebase deploy --only firestore:rules`
- [ ] Verify rules are live: Firebase Console → Firestore → Rules

### 1.3 Firestore Indexes

- [ ] Run `firebase deploy --only firestore:indexes --dry-run` — no errors
- [ ] Confirm these composite indexes exist in `firestore.indexes.json`:
  - `sfosLedger`: `(accountId ASC, direction ASC, ledgerType ASC, createdAt DESC)`
  - `sfosLedger`: `(txId ASC, direction ASC)`
  - `sfosLedger`: `(accountId ASC, type ASC, createdAt DESC)`
  - `sfosTransactions`: `(fromId ASC, createdAt DESC)`
  - `sfosTransactions`: `(toId ASC, createdAt DESC)`
  - `sfosIdentity`: `(status ASC, kycTier ASC)`
  - `sfosIdempotency`: `(status ASC, createdAt ASC)`
  - `sfosAuditLog`: `(uid ASC, severity ASC, createdAt DESC)`
- [ ] Run `firebase deploy --only firestore:indexes`
- [ ] **Wait for all indexes to finish building**: Firebase Console → Firestore → Indexes. No index should show status `BUILDING`. This can take 10–30 minutes for large collections.
  - Do NOT proceed to function deployment until all indexes are `READY`
- [ ] Note: per Index Management Rule — never drop existing indexes; only add.

### 1.4 Dry-Run Migration Checks

- [ ] Run identity migration dry-run:
  ```bash
  GOOGLE_APPLICATION_CREDENTIALS=/path/to/sa.json \
    node scripts/sfos-migrate-identities.js --dry-run --limit=50
  ```
  Expected: `DRY RUN — no documents were written.` with 0 failures

- [ ] Run integrity check (pre-migration baseline):
  ```bash
  GOOGLE_APPLICATION_CREDENTIALS=/path/to/sa.json \
    node scripts/sfos-integrity-check.js --limit=50
  ```
  Expected: exit code 0 (HEALTHY) or exit code 1 (WARNING — acceptable if known pre-existing issues)
  **Block on exit code 2 (CRITICAL)**: do not deploy until resolved.

### 1.5 Code Review Gate

- [ ] `sfos-engine.js` reviewed by two engineers — no `TODO`, `FIXME`, or `console.log(secret...)` left
- [ ] All CF exports in `sfos-engine.js` have App Check enforcement (`context.app` assertion)
- [ ] All CF exports assert `context.auth` before touching data
- [ ] `sfos-core.js` does not contain any hardcoded UID, balance, or API key
- [ ] `sfos-wallet.html` passes HTML validation — no raw `<script>` injection vectors

---

## 2. Deployment Sequence

Execute steps **in order**. Do not parallelise. One step at a time.

> **Deploy Once Rule:** Never re-deploy while a deploy is already running. Wait for Firebase CLI to exit before issuing another deploy command.

### Step 1 — Deploy Cloud Functions

```bash
firebase deploy --only functions:sfos-engine \
  --project sokoni-prod
```

Expected output: `Deploy complete!` with no function deploy failures.

If any function fails to deploy:
- Read the error: `firebase functions:log --only sfos-engine --project sokoni-prod`
- Fix the error. Do not proceed until all CFs deploy successfully.

The following 18 exports from `sfos-engine.js` must all be present after deploy:
- `sfosIdentityGet`, `sfosWalletGet`, `sfosTransact`
- `sfosEscrowCreate`, `sfosEscrowRelease`
- `sfosGroupCreate`, `sfosGroupGet`
- `sfosMerchantDashboard`, `sfosMerchantSettle`
- `sfosRewardsGet`, `sfosRewardsRedeem`
- `sfosFinancialHealth`, `sfosNetWorth`
- `sfosAnalyticsDetailed`, `sfosAiForecast`
- `sfosRiskCheck`
- `sfosReconcile` (scheduled)
- `sfosHealthCheck`

### Step 2 — Smoke Tests

Run each command and confirm the expected output:

```bash
# 2a. Health check — must return status: 'HEALTHY'
firebase functions:call sfosHealthCheck \
  --project sokoni-prod \
  --data '{}'
# Expected: {"status":"HEALTHY","version":"1.1","checks":{"firestore":"OK",...}}

# 2b. Identity get (use a known test UID)
firebase functions:call sfosIdentityGet \
  --project sokoni-prod \
  --data '{"uid":"TEST_UID_HERE"}'
# Expected: no error, identity object returned

# 2c. Wallet get
firebase functions:call sfosWalletGet \
  --project sokoni-prod \
  --data '{"uid":"TEST_UID_HERE"}'
# Expected: {"balance":..., "currency":"KES", "limits":{...}}

# 2d. Risk check
firebase functions:call sfosRiskCheck \
  --project sokoni-prod \
  --data '{"uid":"TEST_UID_HERE","amount":100,"recipient":"TEST_UID_2"}'
# Expected: {"level":"LOW", "reasons":[]}

# 2e. Financial health score
firebase functions:call sfosFinancialHealth \
  --project sokoni-prod \
  --data '{"uid":"TEST_UID_HERE"}'
# Expected: {"score":..., "grade":"..."} — no 500 error
```

All five smoke tests must pass before proceeding.

### Step 3 — Run Identity Migration

```bash
GOOGLE_APPLICATION_CREDENTIALS=/path/to/sa.json \
  node scripts/sfos-migrate-identities.js \
  --limit=200
```

Watch for:
- Any `Failed` lines in output → investigate immediately before running `--full`
- After first batch succeeds, run full migration:

```bash
GOOGLE_APPLICATION_CREDENTIALS=/path/to/sa.json \
  node scripts/sfos-migrate-identities.js
```

Expected: `Migration complete. Run scripts/sfos-reconcile.js to verify.` with 0 failures.

### Step 4 — Balance Reconciliation

```bash
GOOGLE_APPLICATION_CREDENTIALS=/path/to/sa.json \
  node scripts/sfos-reconcile.js --limit=200
```

Expected: `All sampled wallets reconcile correctly.` and exit code 0.

If mismatches are found:
- Do not proceed to full integrity check
- Investigate each mismatch UID individually
- Resolve via `sfosTransactReverse` admin CF before continuing

### Step 5 — Full Integrity Check

```bash
GOOGLE_APPLICATION_CREDENTIALS=/path/to/sa.json \
  node scripts/sfos-integrity-check.js --full
```

This may take 15–30 minutes for large user bases.

Expected: `OVERALL STATUS : HEALTHY` and exit code 0.

Block on:
- Exit code 2 (CRITICAL): do not open traffic
- Exit code 1 (WARNING): investigate all warnings; determine if safe to proceed

---

## 3. Post-Deployment Validation

After all 5 deployment steps complete, run these manual validation checks.

### 3.1 Cloud Function Health

- [ ] `sfosHealthCheck` returns `{"status":"HEALTHY"}` via Firebase Console → Functions → Test Function
- [ ] `sfosLedgerIntegrityCheck` returns `{"reconciled":true}` for at least 5 test UIDs:
  - TEST_UID_1, TEST_UID_2, TEST_UID_3, TEST_UID_4, TEST_UID_5 (replace with real test accounts)
- [ ] Zero cold-start timeouts in first 15 minutes: Firebase Console → Functions → sfos-engine → Logs

### 3.2 UI Validation

- [ ] Open `sfos-wallet.html` in production browser (not localhost)
  - No red errors in browser DevTools console
  - Balance loads within 3 seconds
  - All 5 nav tabs render (Wallet, Savings, Escrow, Groups, Rewards)
  - Spend Analytics chart loads without canvas errors
- [ ] Open on mobile (Android Chrome) — no horizontal scroll, FAB visible above nav

### 3.3 Payment Flow Tests

These tests use real money. Use a dedicated test account loaded with KES 100.

- [ ] **STK Push test**: top up KES 10 via M-Pesa STK push
  - M-Pesa prompt appears on test phone within 30 seconds
  - Balance updates within 60 seconds of approval
  - sfosLedger entry created: `{ type: "topup", direction: "CREDIT", amount: 10 }`
  - `wallets/{testUid}.balance` increases by 10

- [ ] **P2P Send test**: send KES 5 from test account 1 to test account 2
  - Transaction completes within 5 seconds
  - Sender balance decreases by 5 (+ any fee)
  - Recipient balance increases by 5
  - Two sfosLedger entries created (DEBIT on sender, CREDIT on recipient)
  - Notification received by recipient (if notifications enabled)

- [ ] **Savings vault test**: deposit KES 5 to a savings vault
  - Main balance decreases by 5
  - Vault balance increases by 5
  - sfosLedger entry created: `{ type: "savings-deposit" }`

### 3.4 Scheduled Functions

- [ ] Confirm `sfosReconcile` is listed in Firebase Console → Functions with a schedule trigger
- [ ] Confirm schedule is set to `every 24 hours` (or per `SFOS_ARCHITECTURE.md §6.1`)

---

## 4. Rollback Trigger Conditions

Initiate rollback **immediately** if any of the following are observed within the first 2 hours post-deployment:

| Trigger | Threshold | Severity |
|---------|-----------|----------|
| `sfosHealthCheck` returns `status: 'DEGRADED'` | Any occurrence | P0 |
| sfosLedger orphan entries detected | Any occurrence | P0 |
| Balance drift (wallet.balance vs ledger sum) | > KES 0.01 for any user | P0 |
| `sfosTransact` error rate | > 5% over 5-minute window | P0 |
| Critical audit log entries in `sfosAuditLog` | > 3 in first hour | P1 |
| `sfosRiskCheck` returning 500 errors | Any occurrence | P1 |
| STK push webhooks not completing within 2 minutes | > 2 occurrences | P1 |
| `sfosReconcile` CF fails on first scheduled run | Any failure | P1 |
| SFOS Cloud Functions cold-start timeout | > 10% of calls | P1 |

---

## 5. Rollback Steps

Rollback target time: **< 5 minutes** from decision to complete.

### Phase A — Immediate Traffic Block (< 1 minute)

1. Freeze all SFOS CFs by disabling the service account:
   ```bash
   gcloud projects remove-iam-policy-binding sokoni-prod \
     --member="serviceAccount:sfos-functions@sokoni-prod.iam.gserviceaccount.com" \
     --role="roles/datastore.user"
   ```
   This causes all SFOS CF calls to fail auth immediately without data mutation risk.

2. Alert team via ops channel: `"SFOS ROLLBACK INITIATED — [reason] — [initiator]"`

### Phase B — Revert Functions (< 2 minutes from Phase A)

3. Identify the previous working function version in Firebase Console → Functions → [fn-name] → Revisions
4. Roll back to previous revision:
   ```bash
   # Option A: redeploy previous git tag
   git checkout tags/sfos-v1.0.0-rc1
   firebase deploy --only functions:sfos-engine --project sokoni-prod

   # Option B: if previous tag is unavailable, delete SFOS functions
   # (wallet-engine.js v2 CFs remain fully functional as fallback)
   firebase functions:delete sfosTransact sfosIdentityGet sfosWalletGet \
     sfosEscrowCreate sfosEscrowRelease sfosRiskCheck \
     sfosFinancialHealth sfosAiForecast sfosAnalyticsDetailed \
     sfosRewardsGet sfosRewardsRedeem sfosMerchantSettle sfosMerchantDashboard \
     sfosGroupCreate sfosGroupGet sfosNetWorth sfosReconcile sfosHealthCheck \
     --project sokoni-prod --force
   ```

5. Restore service account IAM binding after rollback completes:
   ```bash
   gcloud projects add-iam-policy-binding sokoni-prod \
     --member="serviceAccount:sfos-functions@sokoni-prod.iam.gserviceaccount.com" \
     --role="roles/datastore.user"
   ```

### Phase C — Data Integrity Restore (< 5 minutes from Phase A)

6. Identify all SFOS writes since the faulty deploy timestamp:
   ```bash
   GOOGLE_APPLICATION_CREDENTIALS=/path/to/sa.json \
     node scripts/sfos-integrity-check.js --full
   ```
7. For each balance mismatch found: apply compensating entry via `sfosTransactReverse` (admin CF). Do not manually edit `sfosLedger` — it is append-only.
8. Run reconciliation to confirm data integrity is restored:
   ```bash
   GOOGLE_APPLICATION_CREDENTIALS=/path/to/sa.json \
     node scripts/sfos-reconcile.js
   ```
9. Expected: exit code 0. If not, continue manual remediation per `SFOS_INCIDENT_RUNBOOKS.md`.

### Phase D — Post-Rollback Verification (< 10 minutes from Phase A)

10. Confirm `walletV2Send`, `walletV2TopUp`, `walletV2Dashboard` (v2 CFs) are responding normally:
    ```bash
    firebase functions:call walletV2Dashboard --project sokoni-prod --data '{}'
    ```
11. Confirm `sfos-wallet.html` either shows a maintenance message or routes to `wallet.html` (v2 UI)
12. Document rollback in `docs/CHANGELOG.md` with timestamp, reason, and affected CFs

---

## 6. Sign-Off Record

| Step | Completed By | Date/Time (EAT) | Notes |
|------|-------------|-----------------|-------|
| 1.1 Secrets verified | | | |
| 1.2 Firestore rules deployed | | | |
| 1.3 Firestore indexes ready | | | |
| 1.4 Dry-run passed | | | |
| 1.5 Code review gate | | | |
| 2 — Deploy CFs | | | |
| 3 — Identity migration | | | |
| 4 — Reconciliation | | | |
| 5 — Full integrity check | | | |
| 3.1 CF health validated | | | |
| 3.2 UI validated | | | |
| 3.3 Payment tests passed | | | |
| **GO / NO-GO decision** | | | |

---

*See also:*  
- [[SFOS_ARCHITECTURE]] — full system design  
- [[SFOS_INCIDENT_RUNBOOKS]] — incident response procedures  
- [[SFOS_OPS_HANDBOOK]] — day-to-day operations  
- `scripts/sfos-reconcile.js` — balance reconciliation script  
- `scripts/sfos-integrity-check.js` — ledger integrity audit  
- `scripts/sfos-migrate-identities.js` — identity migration script  
