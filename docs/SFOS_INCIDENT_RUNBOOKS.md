# SFOS Incident Runbooks — SOKONI Financial OS v1.1

**Version:** 1.1  
**Date:** 2026-07-14  
**Status:** Production  
**Author:** SOKONI Engineering  
**Classification:** Internal — Engineering & Operations  

> These runbooks are activated when an SFOS incident is declared. Every engineer
> on the on-call rotation must be familiar with all six procedures before their
> first shift.

---

## Table of Contents

| ID | Name | Severity |
|----|------|----------|
| [INC-001](#inc-001-negative-wallet-balance) | Negative Wallet Balance | P0 — CRITICAL |
| [INC-002](#inc-002-duplicate-transactions) | Duplicate Transactions | P0 — CRITICAL |
| [INC-003](#inc-003-velocity-limit-bypass) | Velocity Limit Bypass | P0 — CRITICAL |
| [INC-004](#inc-004-m-pesa-stk-push-orphan) | M-Pesa STK Push Orphan | P1 — HIGH |
| [INC-005](#inc-005-sfos-cf-mass-failure) | SFOS CF Mass Failure | P0 — CRITICAL |
| [INC-006](#inc-006-firestore-performance-degradation) | Firestore Performance Degradation | P1 — HIGH |

---

## INC-001: Negative Wallet Balance

**Severity:** P0 — CRITICAL  
**Blast radius:** Individual user's financial data is corrupt. If systemic, platform financial integrity is compromised.  
**SLA:** Detection → Remediation < 30 minutes.  

### Detection

Primary signal: `sfos-integrity-check.js` output contains:

```
[X] CHECK-1 Balance Consistency — FAIL [CRITICAL]
      1. [CRITICAL] NEGATIVE_BALANCE — wallets/<uid>.balance = -250
```

Secondary signals:
- `sfosAuditLog` entry with `severity: "CRITICAL"` and `code: "NEGATIVE_BALANCE"`
- `sfosReconcile` scheduled CF sends alert email to `ops-alerts@mysokoni.co.ke`
- User reports incorrect balance in-app

Confirmation query (Firestore Console or Admin SDK):
```js
// Confirm negative balance exists
const snap = await db.collection('wallets')
  .where('balance', '<', 0).limit(20).get();
snap.docs.forEach(d => console.log(d.id, d.data().balance));
```

### Immediate Response (< 5 minutes)

1. **Freeze affected wallet(s)** — prevent further debit operations:
   ```js
   // Run via Firebase Admin SDK / Functions Shell
   await db.doc(`sfosIdentity/${uid}`).update({
     status: 'frozen',
     frozenAt: admin.firestore.FieldValue.serverTimestamp(),
     frozenReason: 'INC-001: negative balance detected — ops freeze',
     frozenBy: 'ops-engineer-uid',
   });
   // Also freeze wallets doc (checked by walletV2* CFs)
   await db.doc(`wallets/${uid}`).update({ frozen: true });
   ```

2. **Write audit log entry:**
   ```js
   await db.collection('sfosAuditLog').add({
     uid,
     event: 'WALLET_FROZEN_INC001',
     severity: 'CRITICAL',
     initiatedBy: 'ops',
     createdAt: admin.firestore.FieldValue.serverTimestamp(),
     detail: `INC-001 freeze: balance was ${negativeBalance}`,
   });
   ```

3. **Notify the escalation chain** (see Communication Template below).

### Investigation

4. Pull all sfosLedger entries for the affected user to find the causative write:
   ```js
   const entries = await db.collection('sfosLedger')
     .where('accountId', '==', uid)
     .orderBy('createdAt', 'desc')
     .limit(50)
     .get();
   entries.docs.forEach(d => console.log(d.data()));
   ```

5. Find the transaction that crossed zero. Look for a DEBIT entry whose `balanceAfterDebit` is negative. The `txId` on that entry is the root cause transaction.

6. Check `walletAuditLog` for that UID around the same timestamp — concurrent freeze or admin override may explain it.

7. Check `sfosIdempotency` — if the same idempotency key was processed twice (race condition), the double debit would cause a negative balance.

8. Run single-user integrity check to quantify the damage:
   ```bash
   GOOGLE_APPLICATION_CREDENTIALS=/path/to/sa.json \
     node scripts/sfos-integrity-check.js --uid=<affected-uid>
   ```

### Remediation

9. Calculate the exact credit needed:
   ```
   compensatingAmount = Math.abs(wallets/{uid}.balance)
   ```

10. Apply a compensating CREDIT via `sfosTransactReverse` (admin-only CF):
    ```js
    // Call sfosTransactReverse with admin token
    const result = await firebase.functions().httpsCallable('sfosTransactReverse')({
      targetUid: uid,
      amount: compensatingAmount,
      direction: 'CREDIT',
      reason: 'INC-001: compensating entry for negative balance',
      adminNote: 'Approved by [engineer-name] at [time]',
    });
    ```
    The compensating entry sets `wallets/{uid}.balance = 0` as the floor. Do NOT credit
    beyond zero unless evidence shows a genuine missed credit (i.e. a failed top-up).

11. Unfreeze the wallet after confirming balance is ≥ 0:
    ```js
    await db.doc(`sfosIdentity/${uid}`).update({ status: 'active' });
    await db.doc(`wallets/${uid}`).update({ frozen: false });
    ```

12. Re-run integrity check for the user:
    ```bash
    node scripts/sfos-integrity-check.js --uid=<uid>
    ```
    Expected: exit 0 (HEALTHY).

### Prevention

- **Balance floor in `sfosTransact`**: inside `runTransaction`, assert `newBalance >= 0` before committing. This is the primary guard and must never be relaxed.
- **Pre-commit balance read**: the transaction must re-read `wallets/{uid}.balance` inside the transaction (not rely on cached value passed from the caller).
- **Idempotency enforcement**: `sfosIdempotency` deduplication window must be active for all DEBIT operations (see INC-002 for idempotency details).
- **Daily sfos-integrity-check.js** run (see Ops Handbook — Daily Operations).

### Communication Template

```
[P0 INCIDENT — INC-001 NEGATIVE BALANCE]
Time detected : <ISO timestamp EAT>
Affected UID  : <uid-prefix...> (full UID shared in secure channel)
Balance found : KES <amount>
Status        : Wallet FROZEN — user cannot transact
ETA to fix    : <estimate>
Assignee      : <engineer>
Bridge        : <Slack/call link>
```

---

## INC-002: Duplicate Transactions

**Severity:** P0 — CRITICAL  
**Blast radius:** Specific user double-charged. If idempotency is broken system-wide, all in-flight transactions are at risk.  
**SLA:** Detection → Remediation < 45 minutes.  

### Detection

Primary signals:
- User reports being charged twice for one action
- `sfos-integrity-check.js` CHECK-3 flags `WRONG_ENTRY_COUNT` with `entryCount: 4` for a single `txId`
- Two `sfosTransactions` documents exist with the same `{fromId, toId, amount}` within the same minute

Identification query:
```js
// Find potential duplicates: same sender + amount within a 60-second window
const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000); // last 24h
const txSnap = await db.collection('sfosTransactions')
  .where('fromId', '==', uid)
  .where('createdAt', '>=', cutoff)
  .orderBy('createdAt', 'desc')
  .get();

// Group by {toId, amount, minute-bucket}
const buckets = {};
txSnap.docs.forEach(doc => {
  const d = doc.data();
  const minute = Math.floor(d.createdAt.toMillis() / 60000);
  const key = `${d.toId}:${d.amount}:${minute}`;
  buckets[key] = buckets[key] || [];
  buckets[key].push(doc.id);
});

// Any bucket with >1 entry is a duplicate candidate
Object.entries(buckets)
  .filter(([,ids]) => ids.length > 1)
  .forEach(([key, ids]) => console.log('DUPLICATE CANDIDATE:', key, ids));
```

### Immediate Response (< 5 minutes)

1. Freeze the affected sender wallet (prevents further duplicate sends while investigating):
   ```js
   await db.doc(`wallets/${senderUid}`).update({ frozen: true });
   await db.doc(`sfosIdentity/${senderUid}`).update({
     status: 'frozen',
     frozenReason: 'INC-002: duplicate transaction under investigation',
   });
   ```
2. Note both `txId` values. Identify which is the original (earlier `createdAt`) and which is the duplicate (later `createdAt`).

### Investigation

3. Inspect the idempotency record for the original request:
   ```js
   // The idempotency key format is: {uid}:{cfName}:{amount}:{epoch/5s-bucket}
   const idemSnap = await db.collection('sfosIdempotency')
     .where('txId', '==', originalTxId)
     .limit(5)
     .get();
   idemSnap.docs.forEach(d => console.log(d.id, d.data()));
   ```
   If there is NO idempotency record for the duplicate txId, the duplicate bypassed the idempotency guard entirely — this is a code-level bug.

4. Check CF logs for the duplicate call timestamp:
   ```bash
   firebase functions:log --only sfosTransact \
     --project sokoni-prod \
     --start-time <duplicate-createdAt minus 30s>
   ```
   Look for two invocations with the same `idempotencyKey` that both returned success.

5. Verify ledger entries for both transactions:
   ```js
   // Both txIds — compare entry sets
   for (const txId of [originalTxId, duplicateTxId]) {
     const entries = await db.collection('sfosLedger')
       .where('txId', '==', txId).get();
     console.log(txId, entries.docs.map(d => d.data()));
   }
   ```

### Remediation

6. Reverse the duplicate transaction using `sfosTransactReverse`:
   ```js
   await firebase.functions().httpsCallable('sfosTransactReverse')({
     txId: duplicateTxId,
     reason: 'INC-002: duplicate charge — reversed by ops',
     adminNote: `Original txId: ${originalTxId}`,
   });
   ```
   This creates two compensating entries (one CREDIT to sender, one DEBIT to recipient) and marks `sfosTransactions/${duplicateTxId}.status = 'reversed'`.

7. Verify both wallets are back to correct state:
   ```bash
   node scripts/sfos-integrity-check.js --uid=<senderUid>
   node scripts/sfos-integrity-check.js --uid=<recipientUid>
   ```

8. Unfreeze sender wallet and notify user:
   ```js
   await db.doc(`wallets/${senderUid}`).update({ frozen: false });
   await db.doc(`sfosIdentity/${senderUid}`).update({ status: 'active' });
   ```

9. If the recipient spent the duplicate funds before the reversal: the recipient wallet will go negative. Apply INC-001 procedure to that user.

### Prevention

- Idempotency key must be generated client-side using a UUID tied to the user's action (button tap), not the timestamp. A 5-second bucket is too coarse for high-frequency senders.
- The `sfosIdempotency` record must be written inside the same `runTransaction` as the balance change (atomic lock), not before it.
- Enforce a `COMPLETED` status on idempotency records — never allow a second invocation if the record exists and status is not `PENDING`.
- Rate-limit `sfosTransact` to 10 calls per user per minute at the CF entry point.

### Communication Template

```
[P0 INCIDENT — INC-002 DUPLICATE TRANSACTION]
Time detected  : <ISO timestamp EAT>
Affected user  : <uid-prefix...>
Duplicate txId : <id>
Original txId  : <id>
Amount         : KES <amount>
Status         : Investigating — wallet frozen pending reversal
ETA to resolve : <estimate>
Assignee       : <engineer>
```

---

## INC-003: Velocity Limit Bypass

**Severity:** P0 — CRITICAL  
**Blast radius:** Regulatory exposure (CBK velocity limits violated), fraud risk, potential AML flag. May affect multiple users if the bypass is systemic.  
**SLA:** Detection → Account freeze < 15 minutes. Full remediation < 4 hours.  

### Detection

Primary signals:
- `sfos-integrity-check.js` CHECK-4 flags `DAILY_LIMIT_EXCEEDED` or `MONTHLY_LIMIT_EXCEEDED`
- `sfosAuditLog` entry with `event: 'VELOCITY_EXCEEDED'`
- Unusual spike in high-value transactions in `sfosTransactions` for a single UID
- External fraud detection alert from IntaSend or M-Pesa

Confirmation — check actual spend vs limit:
```js
const identity = (await db.doc(`sfosIdentity/${uid}`).get()).data();
const { dailySpent, dailyLimit, monthlySpent, monthlyLimit } = identity;
console.log({ dailySpent, dailyLimit, overshootDaily: dailySpent - dailyLimit });
console.log({ monthlySpent, monthlyLimit, overshootMonthly: monthlySpent - monthlyLimit });
```

Cross-check with ledger to confirm the spend figure is real (not counter drift):
```js
const today = new Date();
today.setUTCHours(0, 0, 0, 0);
const debitsToday = await db.collection('sfosLedger')
  .where('accountId', '==', uid)
  .where('direction', '==', 'DEBIT')
  .where('createdAt', '>=', today)
  .get();
const actualDailyDebit = debitsToday.docs.reduce((s, d) => s + d.data().amount, 0);
console.log('Actual daily debit from ledger:', actualDailyDebit);
```

### Immediate Response (< 5 minutes)

1. **Freeze account immediately:**
   ```js
   await db.doc(`sfosIdentity/${uid}`).update({
     status: 'frozen',
     frozenAt: admin.firestore.FieldValue.serverTimestamp(),
     frozenReason: 'INC-003: velocity limit bypass detected',
     frozenBy: 'sfos-risk-engine',
   });
   await db.doc(`wallets/${uid}`).update({ frozen: true });
   ```

2. **Block M-Pesa withdrawals** — if the user is attempting to extract funds:
   Set a flag in `sfosRisk/{uid}`:
   ```js
   await db.doc(`sfosRisk/${uid}`).set({
     frozenByRisk: true,
     riskScore: 100,
     flaggedPatterns: admin.firestore.FieldValue.arrayUnion('VELOCITY_BYPASS'),
     lastChecked: admin.firestore.FieldValue.serverTimestamp(),
   }, { merge: true });
   ```

3. Alert the CTO and Senior Engineer immediately (P0 escalation — see Ops Handbook).

### Investigation

4. Pull the complete audit trail for this user for the last 24 hours:
   ```js
   const yesterday = new Date(Date.now() - 86_400_000);
   const auditSnap = await db.collection('sfosAuditLog')
     .where('uid', '==', uid)
     .where('createdAt', '>=', yesterday)
     .orderBy('createdAt', 'desc')
     .get();
   auditSnap.docs.forEach(d => console.log(d.data()));
   ```

5. Identify which specific transactions exceeded the limit. Compare `createdAt` timestamps against the velocity counter reset time (`sfosIdentity.dailyResetAt` or `wallets.dailyResetAt`).

6. Determine root cause:
   - **Concurrent transaction race**: two sfosTransact calls both read the old dailySpent value before either write committed. Fix: velocity check must be inside `runTransaction`.
   - **Daily reset bug**: `dailySpent` was not reset at midnight UTC, allowing cumulative spend to bleed across days. Fix: verify `walletV2ResetDailySpend` scheduled CF ran.
   - **Deliberate fraud**: user split payments across multiple small sends in rapid succession to stay under per-transaction limit while exceeding daily limit. Fix: cumulative velocity window.

### Remediation

7. Calculate the excess amount (spend beyond daily limit):
   ```
   excessAmount = actualDailyDebit - dailyLimit
   ```

8. Reverse transactions beyond the limit, newest first, until cumulative reversal >= excessAmount:
   ```js
   // For each excess transaction (newest → oldest):
   await firebase.functions().httpsCallable('sfosTransactReverse')({
     txId: excessTransactionId,
     reason: 'INC-003: velocity limit exceeded — regulatory reversal',
   });
   ```
   Note: if funds have already been withdrawn to M-Pesa, reversal restores the wallet but does not recover M-Pesa funds. Escalate to the M-Pesa dispute team via IntaSend portal.

9. Correct the velocity counters:
   ```js
   await db.doc(`sfosIdentity/${uid}`).update({
     dailySpent:   Math.min(actualDailyDebit - excessAmount, dailyLimit),
     monthlySpent: /* recalculate from ledger */,
   });
   ```

10. Unfreeze account only after confirming:
    - Balance is correct
    - Velocity counters are within limits
    - Risk review completed by Senior Engineer

11. If deliberate fraud is confirmed: do not unfreeze. Escalate to legal.

### Prevention

- Velocity check must execute inside `runTransaction` — not before it. The pattern `read dailySpent, check, then runTransaction` has a race window.
- Implement a Cloud Scheduler job that verifies velocity counter accuracy against ledger sums daily.
- Add an alerting rule: if any single user's `sfosLedger` DEBIT sum for the current day exceeds 80% of their daily limit, send a proactive notification.
- Consider progressive velocity limits: Bronze-tier users have lower limits until they achieve Silver KYC.

### Communication Template

```
[P0 INCIDENT — INC-003 VELOCITY LIMIT BYPASS]
Time detected    : <ISO timestamp EAT>
Affected UID     : <uid-prefix...>
Daily overshoot  : KES <amount>
Monthly overshoot: KES <amount>
Account status   : FROZEN
Regulatory risk  : CBK velocity limit exceeded — tracking
Assignee         : <engineer>
Legal notified   : YES / NO
```

---

## INC-004: M-Pesa STK Push Orphan

**Severity:** P1 — HIGH  
**Blast radius:** Individual user. Money deducted from M-Pesa but SOKONI wallet not credited. High user trust impact.  
**SLA:** Detection → Wallet credited < 2 hours (regulatory best-practice for e-money).  

### Detection

Primary signals:
- User contacts support: "I paid via M-Pesa but my SOKONI balance didn't increase"
- `sfosIdempotency` record for `walletTopUp` shows status `PENDING` older than 5 minutes
- M-Pesa webhook (via IntaSend) delivered but `confirmWalletTopUp` CF threw a 500 error
- `walletTransactions` contains an `initiateWalletTopUp` entry with no corresponding `confirmWalletTopUp` entry

Identification steps:

1. Get the user's M-Pesa phone number from `sfosIdentity/{uid}.phone`
2. Log into IntaSend dashboard → Payments → search by phone or amount → find the payment
3. Note the IntaSend `payment_id` / `checkout_id`
4. Search for the corresponding webhook delivery attempt:
   - IntaSend Dashboard → Webhooks → filter by `checkout_id`
   - Check if the webhook was delivered and what response code SOKONI's CF returned

5. Search Firestore for the incomplete top-up record:
   ```js
   const topupSnap = await db.collection('walletTransactions')
     .where('uid', '==', uid)
     .where('type', '==', 'topup')
     .where('status', '==', 'pending')
     .orderBy('createdAt', 'desc')
     .limit(10)
     .get();
   topupSnap.docs.forEach(d => console.log(d.id, d.data()));
   ```

6. Verify the amount from IntaSend matches the pending Firestore record.

### Immediate Response (< 10 minutes)

1. Confirm the payment succeeded on IntaSend:
   - Status must be `COMPLETE` or `PAID` in IntaSend dashboard
   - Never credit a wallet for a payment that is not confirmed paid by M-Pesa / IntaSend
   - If status is `PENDING` or `FAILED` on IntaSend: the user was NOT charged — close the incident

2. Confirm the wallet was NOT already credited (check for double-credit risk):
   ```js
   const currentBalance = (await db.doc(`wallets/${uid}`).get()).data().balance;
   console.log('Current balance:', currentBalance);
   // Also check recent credits
   const recentCredits = await db.collection('sfosLedger')
     .where('accountId', '==', uid)
     .where('direction', '==', 'CREDIT')
     .where('type', '==', 'topup')
     .orderBy('createdAt', 'desc')
     .limit(5)
     .get();
   recentCredits.docs.forEach(d => console.log(d.data()));
   ```
   If a credit for this exact amount exists within the last 30 minutes: the wallet was already credited. Close incident, notify user.

### Remediation

3. Credit the wallet manually via a DEPOSIT transaction using an admin-only CF:
   ```js
   await firebase.functions().httpsCallable('sfosAdminCredit')({
     targetUid: uid,
     amount: confirmedAmountFromIntaSend,
     type: 'topup',
     reason: 'INC-004: STK push orphan — manual credit',
     reference: intaSendCheckoutId,
     adminNote: 'Verified in IntaSend dashboard — payment COMPLETE',
     idempotencyKey: `INC004:${uid}:${intaSendCheckoutId}`,
   });
   ```
   The idempotency key prevents double-credit if this CF is called more than once.

4. Update the pending `walletTransactions` record:
   ```js
   await db.doc(`walletTransactions/${pendingDocId}`).update({
     status: 'completed',
     completedAt: admin.firestore.FieldValue.serverTimestamp(),
     completedBy: 'ops-manual-INC004',
     intaSendRef: intaSendCheckoutId,
   });
   ```

5. Verify the balance is now correct:
   ```bash
   node scripts/sfos-integrity-check.js --uid=<uid>
   ```

6. Notify the user that their wallet has been credited.

### Root Cause Investigation (after user is made whole)

7. Replay the failed webhook to understand why `confirmWalletTopUp` failed:
   - IntaSend allows webhook replay from the dashboard
   - Before replaying: add idempotency protection so the credit is not applied a second time (the idempotency key in Step 3 achieves this)

8. Check CF logs at the time of the original failure:
   ```bash
   firebase functions:log --only confirmWalletTopUp \
     --project sokoni-prod \
     --start-time <webhook-delivery-time>
   ```

9. Common root causes:
   - CF cold start timeout (webhook HTTP timeout is 30s; CF may not have started in time)
   - Firestore write contention (the wallet was locked in another transaction)
   - IntaSend signature verification failed due to key rotation
   - Network timeout between CF and Firestore

### Prevention

- Implement a **webhook retry queue**: if `confirmWalletTopUp` returns non-200, IntaSend retries. Ensure the CF is idempotent so retries are safe.
- Add a **reconciliation cron** that scans `walletTransactions` for `status: 'pending'` records older than 5 minutes and auto-triggers the credit if IntaSend confirms payment.
- Set CF minimum instances to 1 for `confirmWalletTopUp` to avoid cold-start delays on webhook delivery.
- Alert on any `walletTransactions` pending > 5 minutes: Cloud Scheduler + alerting CF.

### Communication Template

```
[P1 INCIDENT — INC-004 STK PUSH ORPHAN]
Time detected     : <ISO timestamp EAT>
Affected user     : <uid-prefix...>
Amount            : KES <amount>
IntaSend ref      : <checkout_id>
M-Pesa status     : COMPLETE (confirmed in dashboard)
Wallet credited   : NO (pending manual credit)
ETA to credit     : <estimate>
Assignee          : <engineer>
User notified     : YES / NO / PENDING
```

---

## INC-005: SFOS CF Mass Failure

**Severity:** P0 — CRITICAL  
**Blast radius:** All SFOS functionality unavailable. However, legacy Wallet v1 and Wallet v2 CFs (`wallet.js`, `wallet-engine.js`) remain functional and can serve as fallback.  
**SLA:** Detection → Partial restore (v2 fallback) < 10 minutes. Full SFOS restore < 30 minutes (or rollback).  

### Detection

Primary signals:
- `sfosHealthCheck` returns `{"status":"DEGRADED"}` or HTTP 500
- Firebase Console → Functions → sfos-engine → Error rate > 5% over 5-minute window
- Multiple users reporting wallet actions failing simultaneously
- Cloud Monitoring alert: SFOS CF error rate threshold breached

Confirmation:
```bash
# Quick health probe
firebase functions:call sfosHealthCheck --project sokoni-prod --data '{}'
# Expected if degraded: {"status":"DEGRADED","errors":["firestore:timeout",...]}

# Check error rate in last 10 minutes
gcloud logging read \
  'resource.type=cloud_function AND resource.labels.function_name=sfos-engine AND severity>=ERROR' \
  --freshness=10m --project=sokoni-prod --limit=50
```

### Immediate Response (< 5 minutes)

1. **Confirm scope** — is it all SFOS CFs or a subset?
   ```bash
   # Test each CF independently
   for cf in sfosWalletGet sfosIdentityGet sfosRiskCheck sfosHealthCheck; do
     firebase functions:call $cf --project sokoni-prod --data '{}' 2>&1 | head -3
   done
   ```

2. **Activate v2 CF fallback** — the UI can be switched to `wallet.html` (Wallet 2.0) which uses `wallet-engine.js` CFs that are fully independent of SFOS:
   - Update Firebase Hosting redirect: `sfos-wallet.html` → `wallet.html` (temporary)
   - Or serve a maintenance page with ETA and support contact

3. **Protect data integrity** — SFOS CFs in partial failure state must NOT be allowed to write partial transactions. If some CFs work but `sfosTransact` does not, disable all write operations:
   ```bash
   # Revoke write IAM for sfos-functions service account temporarily
   gcloud projects remove-iam-policy-binding sokoni-prod \
     --member="serviceAccount:sfos-functions@sokoni-prod.iam.gserviceaccount.com" \
     --role="roles/datastore.user"
   ```
   This causes all SFOS CF writes to fail cleanly without partial state.

4. Alert team: broadcast to ops channel within 3 minutes of declaration.

### Investigation

5. Check Firebase Function deployment status — was there a recent deploy?
   ```bash
   gcloud functions list --project sokoni-prod --filter="name~sfos"
   ```
   Look for `DEPLOY_IN_PROGRESS` or recent `ACTIVE` timestamp matching the incident start time.

6. Check for Firestore quota exhaustion:
   - GCP Console → Firestore → Quotas → reads/writes/deletes per day/minute
   - If quota is at 100%: operations are being throttled

7. Check GCP status page (`status.cloud.google.com`) for regional Firebase/Firestore incidents.

8. Check for a configuration error introduced in the last deploy:
   ```bash
   gcloud functions describe sfosTransact --project sokoni-prod --region=us-central1
   ```
   Look at `environmentVariables` and `secretEnvironmentVariables` — a missing secret causes startup failure.

9. Check Cloud Run resource limits (SFOS CFs run on Cloud Run gen2):
   ```bash
   gcloud run services list --project sokoni-prod --filter="metadata.name~sfos"
   ```

### Rollback Procedure

10. If the failure is deploy-related (most common cause):
    ```bash
    # Roll back to last stable SFOS version
    git checkout tags/sfos-v1.0.0-rc1 -- functions/sfos-engine.js
    firebase deploy --only functions:sfos-engine --project sokoni-prod
    ```

11. If rollback fails or the previous version is also broken: delete SFOS functions and route all traffic to v2 CFs:
    ```bash
    firebase functions:delete \
      sfosTransact sfosIdentityGet sfosWalletGet sfosHealthCheck \
      sfosEscrowCreate sfosEscrowRelease sfosRiskCheck \
      sfosFinancialHealth sfosAiForecast sfosAnalyticsDetailed \
      sfosRewardsGet sfosRewardsRedeem sfosMerchantSettle sfosMerchantDashboard \
      sfosGroupCreate sfosGroupGet sfosNetWorth sfosReconcile \
      --project sokoni-prod --force
    ```
    Wallet v2 CFs (`walletV2Send`, `walletV2Dashboard`, etc.) continue serving users without interruption.

12. Restore write IAM after a known-good CF version is deployed and smoke-tested:
    ```bash
    gcloud projects add-iam-policy-binding sokoni-prod \
      --member="serviceAccount:sfos-functions@sokoni-prod.iam.gserviceaccount.com" \
      --role="roles/datastore.user"
    ```

### Post-Incident

13. Run integrity check to confirm no partial writes occurred during the failure window:
    ```bash
    GOOGLE_APPLICATION_CREDENTIALS=/path/to/sa.json \
      node scripts/sfos-integrity-check.js --full
    ```
14. Review all `sfosIdempotency` records with status `PENDING` created during the failure window — these represent in-flight transactions that never completed (see CHECK-5 in integrity check).

### Communication Template

```
[P0 INCIDENT — INC-005 SFOS CF MASS FAILURE]
Time declared   : <ISO timestamp EAT>
Scope           : All SFOS CFs / Subset: <list>
Fallback active : YES — wallet.html (Wallet v2) serving users
Error rate      : <percentage>
Root cause      : Under investigation / <confirmed cause>
ETA to restore  : <estimate>
Assignee        : <engineer>
CTO notified    : YES
Status update   : Every 10 minutes until resolved
```

---

## INC-006: Firestore Performance Degradation

**Severity:** P1 — HIGH  
**Blast radius:** All SFOS operations are slow. Transactions time out causing failed sends, failed top-ups, and poor UX. No financial data is corrupted if all operations fail before committing.  
**SLA:** Detection → Mitigation in place < 30 minutes. Full resolution < 4 hours.  

### Detection

Primary signals:
- `sfosTransact` P95 latency > 5 seconds (threshold: normal P95 is 500ms)
- Users report slow balance loads, spinning indefinitely
- Firebase Console → Functions → sfos-engine → Execution time histogram shifts right
- Cloud Monitoring alert: Firestore read/write latency P95 > 2s

Quantify the problem:
```bash
# Pull recent execution times for sfosTransact
gcloud logging read \
  'resource.type=cloud_function AND resource.labels.function_name=sfosTransact' \
  --format='value(textPayload,timestamp)' \
  --freshness=30m --project=sokoni-prod | grep "execution time"
```

### Investigation

1. **Check for index builds in progress:**
   - Firebase Console → Firestore → Indexes
   - Any index in `BUILDING` state causes collection-wide write latency increases because Firestore back-fills documents during the build
   - Note: per Index Management Rule, indexes are never dropped — only added. A recent `firebase deploy --only firestore:indexes` may have triggered a build

2. **Check Firestore concurrent connections:**
   - GCP Console → Cloud Firestore → Monitoring → Active connections
   - If connections are near the quota limit (default: 1 million), new connections queue
   - Correlate with a traffic spike (e.g. a marketing campaign going live)

3. **Check SFOS CF concurrency:**
   - If too many `sfosTransact` instances run concurrently, all may be contending on the same wallet documents (e.g. PLATFORM account, high-traffic merchant wallet)
   - GCP Console → Cloud Run → sfos-engine service → Request count and instance count
   - If instance count is maxed (default: 1000 per region), requests are queuing

4. **Check Firestore hot-spot patterns:**
   - The `PLATFORM` wallet document (`wallets/PLATFORM`) is written by every commission, settlement, and reward-credit transaction — it is a hot document
   - The `sfosAnalytics` collection aggregation doc is written every transaction
   - Hot documents cause Firestore's 1-write-per-second-per-document throttle to activate

5. **Check for runaway queries without indexes:**
   - Firestore Console → Usage → Expensive reads
   - A `sfosLedger` collection scan without a composite index causes a full collection scan — extremely slow at scale

### Mitigation

6. **Immediate: reduce CF concurrency** to stop the hot-spot contention:
   ```bash
   gcloud run services update sfos-engine \
     --max-instances=50 \
     --project=sokoni-prod \
     --region=us-central1
   ```
   This limits concurrent SFOS operations and reduces Firestore contention. Accept degraded throughput over complete failure.

7. **If index build is the cause:** there is no way to accelerate index builds. Options:
   - Wait for the build to complete (check estimated time in Firebase Console)
   - Reduce write traffic during the build window by temporarily lowering CF concurrency (Step 6)
   - Route read-only calls (`sfosWalletGet`, `sfosIdentityGet`) to cached responses if available

8. **If PLATFORM wallet hot-spot is the cause:**
   - Consider sharding: split platform fees across 10 PLATFORM shard documents (`PLATFORM-0` through `PLATFORM-9`), selecting the shard by `hash(uid) % 10`
   - This is a code change — schedule for the next maintenance window, not during the incident

9. **If quota exhaustion is the cause:**
   - GCP Console → Firestore → Quota → Request a quota increase (takes 1–2 business days)
   - Immediate mitigation: enable Firestore client-side caching in `sfos-core.js` to reduce read operations

### Restore

10. After mitigation is in place, monitor latency for 10 minutes:
    - Firebase Console → Functions → sfos-engine → Execution time
    - P95 should return below 1 second within 10–15 minutes of mitigation

11. Restore CF max instances after the issue is resolved:
    ```bash
    gcloud run services update sfos-engine \
      --max-instances=1000 \
      --project=sokoni-prod \
      --region=us-central1
    ```

12. Run integrity check to confirm no transaction timeouts left partial state:
    ```bash
    node scripts/sfos-integrity-check.js --limit=200
    ```
    Pay particular attention to CHECK-5 (stuck idempotency entries) — timeouts during `sfosTransact` will leave `PENDING` idempotency records.

### Prevention

- Set up Cloud Monitoring latency alerts on `sfosTransact` and `sfosWalletGet`:
  - Alert threshold: P95 > 2s sustained for 5 minutes
  - Notification: Slack `#ops-alerts` + PagerDuty
- Never deploy new Firestore indexes during peak hours (09:00–21:00 EAT)
- Implement read-through cache for `sfosIdentityGet` and `sfosWalletGet` using Redis (see Redis Infrastructure Layer v1.0)
- Document the PLATFORM wallet hot-spot in the architecture doc and track the shard implementation in ROADMAP

### Communication Template

```
[P1 INCIDENT — INC-006 FIRESTORE DEGRADATION]
Time detected   : <ISO timestamp EAT>
Symptom         : sfosTransact P95 latency = <current>ms (normal: ~500ms)
Root cause      : Under investigation / <index build / hot-spot / quota>
Mitigation      : CF concurrency reduced to 50 instances
User impact     : Slow transactions — no data loss
ETA to normal   : <estimate>
Assignee        : <engineer>
Status updates  : Every 15 minutes
```

---

## Appendix A — Severity Reference

| Severity | Label | Response SLA | Who is Paged |
|----------|-------|-------------|--------------|
| P0 | CRITICAL | < 15 min response | CTO + Engineering Lead |
| P1 | HIGH | < 1 hour response | Senior Engineer |
| P2 | MEDIUM | < 4 hours response | On-call Engineer |
| P3 | LOW | Next business day | Ticket assigned |

## Appendix B — Useful Admin Firestore Paths

| Path | Purpose |
|------|---------|
| `wallets/{uid}` | Canonical wallet balance and limits |
| `sfosIdentity/{uid}` | SFOS identity, velocity counters, KYC tier |
| `sfosLedger/{entryId}` | Immutable double-entry ledger |
| `sfosTransactions/{txId}` | Transaction records (parent of ledger entries) |
| `sfosRisk/{uid}` | Risk score and fraud flags |
| `sfosAuditLog/{logId}` | Immutable audit trail |
| `sfosIdempotency/{key}` | Idempotency deduplication store |
| `walletAuditLog/{logId}` | Legacy v1/v2 audit trail |
| `walletTransactions/{id}` | M-Pesa top-up / withdrawal records |

## Appendix C — Quick Remediation Reference

| Situation | Tool |
|-----------|------|
| Negative balance | `sfosTransactReverse` (admin CF) |
| Duplicate charge | `sfosTransactReverse` on duplicate txId |
| Velocity overshoot | Reverse excess txs + correct `dailySpent` in sfosIdentity |
| Orphan STK push | `sfosAdminCredit` with IntaSend checkout ID as reference |
| Mass CF failure | Roll back via `git checkout tags/<stable-tag>` + redeploy |
| Stuck idempotency | Set status to `FAILED` on stuck docs; re-submit the user action |

---

*See also:*  
- [[SFOS_ARCHITECTURE]] — system design, data model, security rules  
- [[SFOS_DEPLOYMENT_CHECKLIST]] — deployment and rollback procedures  
- [[SFOS_OPS_HANDBOOK]] — day-to-day operations and escalation matrix  
- `scripts/sfos-integrity-check.js` — ledger integrity audit (CHECK-1 through CHECK-5)  
- `scripts/sfos-reconcile.js` — balance reconciliation  
