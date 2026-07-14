# SFOS Operations Handbook — SOKONI Financial OS v1.1

**Version:** 1.1  
**Date:** 2026-07-14  
**Status:** Production  
**Author:** SOKONI Engineering  
**Audience:** On-call Engineers, Platform Operations, Finance Team  

> This handbook covers day-to-day operations of the SOKONI Financial Operating
> System (SFOS). For incident response, see [[SFOS_INCIDENT_RUNBOOKS]].
> For deployment, see [[SFOS_DEPLOYMENT_CHECKLIST]].

---

## Table of Contents

1. [Daily Operations](#1-daily-operations)
2. [Weekly Operations](#2-weekly-operations)
3. [Monthly Operations](#3-monthly-operations)
4. [Key Firestore Collections](#4-key-firestore-collections)
5. [Key Cloud Functions](#5-key-cloud-functions)
6. [Escalation Matrix](#6-escalation-matrix)
7. [Financial Reporting](#7-financial-reporting)
8. [Secrets Management](#8-secrets-management)

---

## 1. Daily Operations

Run the following checks every morning before 09:00 EAT. Log results in the `#ops-daily` Slack channel.

### 1.1 Ledger Integrity Check (Required — < 5 minutes)

Sample 100 wallets to detect overnight anomalies before users begin transacting:

```bash
GOOGLE_APPLICATION_CREDENTIALS=/path/to/sa.json \
  node scripts/sfos-integrity-check.js --limit=100
```

Expected: exit code 0 (`HEALTHY`).

Actions by exit code:

| Code | Status | Action |
|------|--------|--------|
| `0` | HEALTHY | Log result, continue |
| `1` | WARNING | Investigate all warnings before 10:00 EAT; P2 if unresolved |
| `2` | CRITICAL | Declare incident immediately; invoke INC-001 or INC-002 runbook |

### 1.2 Audit Log Review (Required — < 10 minutes)

Pull all `CRITICAL` and `HIGH` severity entries from the last 24 hours:

```js
// Run via Firebase Admin SDK, Functions Shell, or a local admin script
const yesterday = new Date(Date.now() - 86_400_000);
const snap = await db.collection('sfosAuditLog')
  .where('severity', 'in', ['CRITICAL', 'HIGH'])
  .where('createdAt', '>=', yesterday)
  .orderBy('createdAt', 'desc')
  .limit(100)
  .get();

snap.docs.forEach(d => {
  const { uid, event, severity, detail, createdAt } = d.data();
  console.log(`[${severity}] ${event} | uid=${uid} | ${detail} | ${createdAt?.toDate?.()}`);
});
```

Triage each entry:
- `NEGATIVE_BALANCE` → invoke INC-001
- `VELOCITY_EXCEEDED` → invoke INC-003
- `FROZEN_BY_RISK` → review the `sfosRisk/{uid}` document; unfreeze if false-positive
- `FAILED_IDEMPOTENCY` → note the key; investigate if count > 5 for the same operation
- `TOPUP_ORPHAN` → invoke INC-004

### 1.3 SFOS Health Check (Required — < 2 minutes)

```bash
firebase functions:call sfosHealthCheck \
  --project sokoni-prod \
  --data '{}'
```

Expected response:
```json
{
  "status": "HEALTHY",
  "version": "1.1",
  "checks": {
    "firestore": "OK",
    "auth": "OK",
    "idempotency": "OK"
  }
}
```

If `status: "DEGRADED"`: invoke INC-005.  
If the call returns HTTP 500: invoke INC-005 immediately.

### 1.4 Top-10 Merchant Review (Recommended — < 15 minutes)

Review the highest-revenue merchants to catch settlement delays or anomalous commissions:

```js
// Pull top 10 merchants by pendingSettlement descending
const merchantSnap = await db.collection('sfosMerchant')
  .orderBy('pendingSettlement', 'desc')
  .limit(10)
  .get();

merchantSnap.docs.forEach(d => {
  const { merchantId, displayName, pendingSettlement, lastSettledAt, status } = d.data();
  console.log(`${displayName} | pending=KES ${pendingSettlement} | last settled=${lastSettledAt?.toDate?.()} | status=${status}`);
});
```

Flag if:
- `pendingSettlement` > KES 500,000 for a single merchant (may indicate a stuck settlement job)
- `lastSettledAt` is more than 7 days ago for an active merchant
- `status` is not `active`

For a merchant with overdue settlement, trigger manually:
```bash
firebase functions:call sfosMerchantSettle \
  --project sokoni-prod \
  --data '{"merchantId":"<id>","adminOverride":true}'
```

### 1.5 Stuck Idempotency Summary

The daily integrity check includes CHECK-5 (stuck idempotency). If it reports > 0 stuck entries:

```js
// List stuck PENDING entries older than 1 hour
const cutoff = new Date(Date.now() - 3_600_000);
const stuckSnap = await db.collection('sfosIdempotency')
  .where('status', '==', 'PENDING')
  .where('createdAt', '<', cutoff)
  .limit(50)
  .get();

stuckSnap.docs.forEach(d => {
  const data = d.data();
  console.log(`${d.id} | op=${data.operation} | uid=${data.uid} | age=${Math.round((Date.now() - data.createdAt.toMillis()) / 60000)}min`);
});
```

Resolution: set status to `FAILED` on each stuck entry (so it doesn't block future retries), then determine if the underlying user operation needs to be re-submitted:
```js
// For each stuck doc id:
await db.doc(`sfosIdempotency/${stuckDocId}`).update({
  status: 'FAILED',
  failedAt: admin.firestore.FieldValue.serverTimestamp(),
  failReason: 'ops-cleanup: stuck PENDING > 1 hour',
});
```

---

## 2. Weekly Operations

Run every Monday before 10:00 EAT. Estimated total time: 45–90 minutes.

### 2.1 Full Ledger Reconciliation (Monday — ~20 min for large user bases)

```bash
GOOGLE_APPLICATION_CREDENTIALS=/path/to/sa.json \
  node scripts/sfos-integrity-check.js --full
```

This checks all wallets, all transaction double-entry, and all velocity counters. On large user bases this may take 15–25 minutes. Schedule as a background task:

```bash
GOOGLE_APPLICATION_CREDENTIALS=/path/to/sa.json \
  node scripts/sfos-integrity-check.js --full \
  > /tmp/sfos-integrity-$(date +%Y%m%d).log 2>&1 &

# Tail the log
tail -f /tmp/sfos-integrity-$(date +%Y%m%d).log
```

Archive the log output in `docs/ops-logs/YYYY-MM-DD-integrity.log`.  
If any CRITICAL anomalies are found, block the weekly settlement cycle (Step 2.2) until resolved.

### 2.2 Settlement Cycle

Trigger settlement for all merchants with pending amounts above the minimum threshold:

```js
// Fetch all merchants eligible for settlement
const eligibleSnap = await db.collection('sfosMerchant')
  .where('status', '==', 'active')
  .where('pendingSettlement', '>=', 1000) // KES 1,000 minimum
  .get();

console.log(`Settling for ${eligibleSnap.size} merchants`);

// Trigger settlement for each (rate-limit to avoid concurrent transaction contention)
for (const doc of eligibleSnap.docs) {
  await firebase.functions().httpsCallable('sfosMerchantSettle')({
    merchantId: doc.id,
    scheduledSettlement: true,
  });
  // Brief pause to avoid Firestore write contention
  await new Promise(r => setTimeout(r, 200));
}
```

After settlement cycle: verify all `sfosMerchant.pendingSettlement` fields are < 1000 (or zero for settled merchants).

### 2.3 Velocity Limit Bypass Review

Pull `sfosAuditLog` entries for `VELOCITY_EXCEEDED` from the past 7 days:

```js
const weekAgo = new Date(Date.now() - 7 * 86_400_000);
const velocityEvents = await db.collection('sfosAuditLog')
  .where('event', '==', 'VELOCITY_EXCEEDED')
  .where('createdAt', '>=', weekAgo)
  .orderBy('createdAt', 'desc')
  .get();

// Group by UID to find repeat offenders
const byUid = {};
velocityEvents.docs.forEach(d => {
  const { uid } = d.data();
  byUid[uid] = (byUid[uid] || 0) + 1;
});
Object.entries(byUid)
  .sort(([,a],[,b]) => b - a)
  .slice(0, 10)
  .forEach(([uid, count]) => console.log(`${uid}: ${count} velocity events this week`));
```

Any user with > 3 velocity events in a week should be reviewed:
- Review their `sfosRisk/{uid}.riskScore` — if < 50 despite repeated velocity events, the risk engine is under-weighting velocity patterns
- Consider temporarily lowering their daily limit: `sfosIdentity/{uid}.dailyLimit`
- Escalate to Senior Engineer if pattern suggests coordinated fraud

### 2.4 Financial Summary Export for CFO

```bash
firebase functions:call sfosAnalyticsDetailed \
  --project sokoni-prod \
  --data '{"period":"month","adminUid":"<ops-admin-uid>"}'
```

The response includes:
- Total platform transaction volume (KES)
- Total commission earned
- Total active wallets
- Top 10 merchants by volume
- P2P vs order-payment vs topup breakdown

Copy the JSON output and paste into the weekly CFO report template in `docs/financial-reports/`.

---

## 3. Monthly Operations

Run on the first business day of each month. These operations touch financial data — require sign-off from two engineers.

### 3.1 Full Ledger Audit

Unlike the weekly integrity check (which samples sfosTransactions), the monthly audit cross-references every sfosLedger entry against its parent sfosTransactions document:

```bash
# Full mode checks all users and all transaction history
GOOGLE_APPLICATION_CREDENTIALS=/path/to/sa.json \
  node scripts/sfos-integrity-check.js --full \
  > docs/ops-logs/$(date +%Y-%m)-monthly-audit.log 2>&1
```

Additionally, run the reconcile script to cross-check ledger sums against wallet balances:

```bash
GOOGLE_APPLICATION_CREDENTIALS=/path/to/sa.json \
  node scripts/sfos-reconcile.js \
  >> docs/ops-logs/$(date +%Y-%m)-monthly-audit.log 2>&1
```

Both scripts must exit with code 0 before the month is considered clean. Archive the log.

### 3.2 KYC Tier Review

Pull users who are approaching a KYC tier threshold or have pending KYC documents:

```js
const kycPendingSnap = await db.collection('sfosIdentity')
  .where('kycStatus', '==', 'pending_review')
  .orderBy('createdAt', 'asc')
  .get();

console.log(`KYC pending review: ${kycPendingSnap.size} users`);
kycPendingSnap.docs.forEach(d => {
  const { uid, displayName, kycTier, createdAt } = d.data();
  const daysPending = Math.round((Date.now() - createdAt.toMillis()) / 86_400_000);
  console.log(`${uid} | ${displayName} | tier=${kycTier} | pending ${daysPending} days`);
});
```

CBK requirements for e-money: KYC Tier 1 users (Basic) must complete Tier 2 (Verified) to exceed KES 150,000 cumulative monthly volume. Flag any Tier 1 users approaching this threshold.

### 3.3 Reward Tier Audit

Verify reward tier assignments are consistent with actual point balances:

```js
const rewardsSnap = await db.collection('sfosRewards')
  .orderBy('totalPoints', 'desc')
  .limit(500)
  .get();

const TIER_THRESHOLDS = { platinum: 15000, gold: 5000, silver: 1000, bronze: 0 };
let mismatchCount = 0;

rewardsSnap.docs.forEach(d => {
  const { uid, totalPoints, tier } = d.data();
  const expectedTier = Object.entries(TIER_THRESHOLDS)
    .find(([, threshold]) => totalPoints >= threshold)[0];
  if (tier !== expectedTier) {
    mismatchCount++;
    console.log(`MISMATCH: ${uid} has ${totalPoints} pts, tier=${tier}, should be ${expectedTier}`);
  }
});

console.log(`Tier mismatches: ${mismatchCount}`);
```

For each mismatch: update `sfosRewards/{uid}.tier` and `sfosIdentity/{uid}.tier` to the correct value. Tier updates are cosmetic — they do not affect financial balances.

### 3.4 Velocity Limit Review

Review whether the default limits remain appropriate under CBK guidance:

```js
// Current defaults (defined in sfos-engine.js)
const DEFAULT_DAILY_LIMIT   = 150_000; // KES
const DEFAULT_MONTHLY_LIMIT = 1_500_000; // KES
```

If CBK issues new e-money guidance adjusting velocity limits:
1. Update `DEFAULT_DAILY_LIMIT` and `DEFAULT_MONTHLY_LIMIT` constants in `functions/sfos-engine.js`
2. Re-deploy: `firebase deploy --only functions:sfos-engine`
3. Users who have custom limits (set individually in `sfosIdentity`) are unaffected — their per-user limits take precedence
4. Add a CHANGELOG entry and update `SFOS_ARCHITECTURE.md §7.4`

### 3.5 Monthly Reconciliation Report

Produce the official monthly financial reconciliation document:

1. Export all `sfosLedger` entries for the calendar month:
   ```js
   const startOfMonth = new Date(year, month - 1, 1); // e.g. new Date(2026, 6, 1)
   const endOfMonth   = new Date(year, month, 1);
   
   const ledgerSnap = await db.collection('sfosLedger')
     .where('createdAt', '>=', startOfMonth)
     .where('createdAt', '<', endOfMonth)
     .orderBy('createdAt')
     .get();
   
   // Export as CSV (see §7 Financial Reporting for CSV format)
   ```

2. Reconcile totals:
   - Sum of all CREDIT entries = sum of all DEBIT entries (double-entry balance)
   - Platform commission collected (all `sfosLedger` entries of type `commission` with `creditUid = "PLATFORM"`)
   - Total settlements paid out (type `settlement`)
   - Net platform position

3. Archive report to `docs/financial-reports/YYYY-MM-reconciliation.md`

---

## 4. Key Firestore Collections

| Collection | Purpose | Owner | Client Read | Client Write |
|------------|---------|-------|-------------|--------------|
| `wallets/{uid}` | Canonical wallet balance, limits, freeze state | Wallet Engine | Owner (own doc) | DENY — CF only |
| `wallets/{uid}/savings/{vaultId}` | Savings vault balances and settings | Wallet Engine | Owner | DENY — CF only |
| `sfosIdentity/{uid}` | SFOS user identity, KYC tier, velocity counters | SFOS Engine | Owner | DENY — CF only |
| `sfosLedger/{entryId}` | Immutable double-entry ledger | SFOS Engine | Owner (own accountId entries) | DENY — CF only; no updates or deletes |
| `sfosTransactions/{txId}` | Transaction records (parent of ledger pairs) | SFOS Engine | Owner | DENY — CF only |
| `sfosEscrow/{escrowId}` | Escrow holds with milestone tracking | SFOS Engine | Buyer or Seller | DENY — CF only |
| `sfosGroups/{groupId}` | Chama/group wallet state | SFOS Engine | Members only | DENY — CF only |
| `sfosMerchant/{merchantId}` | Merchant financial KPIs, pending settlement | SFOS Engine | Merchant owner | DENY — CF only |
| `sfosRewards/{uid}` | Loyalty points, tier, cashback balance | SFOS Engine | Owner | DENY — CF only |
| `sfosRisk/{uid}` | Risk scores, fraud flags, velocity window | SFOS Engine | DENY — CF only | DENY — CF only (Admin SDK) |
| `sfosAuditLog/{logId}` | Immutable financial audit trail | SFOS Engine | DENY — CF only | DENY — CF only |
| `sfosIdempotency/{key}` | Idempotency deduplication store | SFOS Engine | DENY | DENY — CF only |
| `sfosAnalytics/{uid}` | Per-user spending analytics aggregations | SFOS Engine | Owner | DENY — CF only |
| `walletAuditLog/{logId}` | Legacy v1/v2 wallet audit trail | Wallet Engine | DENY | DENY — CF only |
| `walletTransactions/{id}` | M-Pesa top-up and withdrawal records | Wallet Engine | Owner | DENY — CF only |
| `moneyRequests/{id}` | P2P payment requests | Wallet Engine | Sender or receiver | DENY — CF only |

---

## 5. Key Cloud Functions

All functions are in `functions/sfos-engine.js` unless noted. All are `onCall` (HTTPS Callable) unless specified.

| Function | Purpose | Caller | SLA Target | Timeout | Memory |
|----------|---------|--------|-----------|---------|--------|
| `sfosIdentityGet` | Load or create SFOS identity for a user | Client (authenticated) | P95 < 300ms | 10s | 256MB |
| `sfosWalletGet` | Full wallet state: balance, limits, escrow total, savings total | Client (authenticated) | P95 < 300ms | 10s | 256MB |
| `sfosTransact` | Universal transaction engine — all balance mutations route here | Internal / other CFs | P95 < 500ms | 30s | 512MB |
| `sfosEscrowCreate` | Lock buyer funds in escrow for a deal | Client (buyer) | P95 < 800ms | 30s | 512MB |
| `sfosEscrowRelease` | Release escrow funds to seller (buyer or admin) | Client (buyer) / Admin | P95 < 800ms | 30s | 512MB |
| `sfosGroupCreate` | Create a chama/group wallet | Client (authenticated) | P95 < 500ms | 15s | 256MB |
| `sfosGroupGet` | Load group wallet state including member list | Client (member) | P95 < 400ms | 10s | 256MB |
| `sfosMerchantDashboard` | Merchant financial KPIs: revenue, commissions, pending settlement | Client (merchant) | P95 < 800ms | 20s | 256MB |
| `sfosMerchantSettle` | Trigger settlement payout to merchant wallet | Admin / Scheduled | P95 < 2s | 30s | 512MB |
| `sfosRewardsGet` | Load loyalty rewards, tier, points history | Client (authenticated) | P95 < 400ms | 10s | 256MB |
| `sfosRewardsRedeem` | Convert loyalty points to wallet credit | Client (authenticated) | P95 < 800ms | 30s | 512MB |
| `sfosFinancialHealth` | Compute financial health score 0–100 from ledger history | Client (authenticated) | P95 < 800ms | 20s | 256MB |
| `sfosNetWorth` | Net worth breakdown: balance + savings + escrow | Client (authenticated) | P95 < 500ms | 15s | 256MB |
| `sfosAnalyticsDetailed` | Spending analytics by period (week/month/year) | Client / Admin | P95 < 1s | 20s | 512MB |
| `sfosAiForecast` | Claude Haiku AI spending forecast with recommendations | Client (authenticated) | P95 < 3s | 30s | 512MB |
| `sfosRiskCheck` | Real-time risk assessment before high-value sends | Internal (`sfosTransact`) | P95 < 200ms | 10s | 256MB |
| `sfosTransactReverse` | Admin-only compensating transaction for errors | Admin only | P95 < 1s | 30s | 512MB |
| `sfosAdminCredit` | Admin-only manual credit (e.g. INC-004 top-up orphan) | Admin only | P95 < 1s | 30s | 512MB |
| `sfosHealthCheck` | SFOS system health status (Firestore, secrets, CF connectivity) | Ops / Monitoring | P95 < 500ms | 10s | 256MB |
| `sfosReconcile` | Daily ledger reconciliation job | Cloud Scheduler (00:30 UTC) | Completes < 9 min | 540s | 1GB |
| `sfosLedgerIntegrityCheck` | Per-user integrity check callable from ops tooling | Admin only | P95 < 2s | 30s | 256MB |
| `walletV2Send` | P2P wallet send (v2, unchanged) | Client | P95 < 500ms | 30s | 512MB |
| `walletV2TopUp` / `initiateWalletTopUp` | M-Pesa STK push initiation (v2) | Client | P95 < 2s | 30s | 512MB |
| `confirmWalletTopUp` | M-Pesa webhook handler — credits wallet after STK success | IntaSend webhook | P95 < 1s | 30s | 512MB |

---

## 6. Escalation Matrix

| Priority | Scenario | First Responder | Escalation To | Response SLA | Bridge |
|----------|----------|----------------|--------------|--------------|--------|
| **P0** | Negative balance, mass CF failure, velocity bypass confirmed | On-call Engineer | CTO + Engineering Lead (immediate call) | < 15 minutes | `#ops-p0` Slack + WhatsApp call |
| **P0** | Duplicate transactions affecting > 5 users | On-call Engineer | CTO + Engineering Lead | < 15 minutes | `#ops-p0` Slack + WhatsApp call |
| **P1** | Single-user STK orphan (money taken, wallet not credited) | On-call Engineer | Senior Engineer if not resolved in 30 min | < 1 hour | `#ops-p1` Slack |
| **P1** | sfosRiskCheck returning 500s | On-call Engineer | Senior Engineer | < 1 hour | `#ops-p1` Slack |
| **P1** | Firestore latency P95 > 5s | On-call Engineer | Senior Engineer | < 1 hour | `#ops-p1` Slack |
| **P1** | Settlement cycle failing for > 3 merchants | On-call Engineer | Senior Engineer | < 2 hours | `#ops-p1` Slack |
| **P2** | Single-user balance discrepancy (no fraud signal) | On-call Engineer | — | < 4 hours | Firestore ticket |
| **P2** | KYC tier mismatch for a single user | On-call Engineer | — | < 4 hours | Firestore ticket |
| **P2** | Stuck idempotency entries > 10 | On-call Engineer | — | Next morning | Firestore ticket |
| **P3** | Performance degradation < 2x normal latency | On-call Engineer | — | Next business day | GitHub issue |
| **P3** | UI cosmetic issue in `sfos-wallet.html` | Any Engineer | — | Next business day | GitHub issue |

**On-call rotation:** Minimum 2 engineers must be on call at all times during EAT business hours (08:00–22:00). Off-hours P0/P1 alerts page both on-call engineers simultaneously.

**Contact directory** (kept in secure Vault — do not commit to git):  
Reference: `docs/ops-contacts.secret.md` (gitignored)

---

## 7. Financial Reporting

### 7.1 Transaction CSV Export (Date Range)

Export all `sfosLedger` entries for a given date range as CSV:

```js
// Run as an admin Node.js script (requires GOOGLE_APPLICATION_CREDENTIALS)
'use strict';
const admin = require('firebase-admin');
if (!admin.apps.length) admin.initializeApp();
const db = admin.firestore();

async function exportLedgerCSV(startDate, endDate, outputPath) {
  const fs = require('fs');
  const stream = fs.createWriteStream(outputPath);
  stream.write('entryId,type,debitUid,creditUid,amount,currency,description,createdAt\n');

  let query = db.collection('sfosLedger')
    .where('createdAt', '>=', new Date(startDate))
    .where('createdAt', '<', new Date(endDate))
    .orderBy('createdAt')
    .limit(1000);

  let lastDoc = null;
  let totalRows = 0;

  do {
    const snap = lastDoc ? await query.startAfter(lastDoc).get() : await query.get();
    snap.docs.forEach(doc => {
      const d = doc.data();
      stream.write([
        doc.id,
        d.type, d.debitUid, d.creditUid, d.amount, d.currency || 'KES',
        `"${(d.description || '').replace(/"/g, '""')}"`,
        d.createdAt?.toDate?.()?.toISOString() || '',
      ].join(',') + '\n');
      totalRows++;
    });
    lastDoc = snap.docs[snap.docs.length - 1];
    if (snap.size < 1000) break;
  } while (lastDoc);

  stream.end();
  console.log(`Exported ${totalRows} rows to ${outputPath}`);
}

// Example: export July 2026
exportLedgerCSV('2026-07-01', '2026-08-01', './docs/financial-reports/sfos-ledger-2026-07.csv');
```

> Note: For very large exports (> 100,000 entries), run this during off-peak hours (00:00–06:00 EAT) to avoid impacting production Firestore read quota.

### 7.2 Merchant Settlement Report

Generate a settlement report showing each merchant's payouts for a period:

```js
const startDate = new Date('2026-07-01');
const endDate   = new Date('2026-08-01');

// Pull all settlement ledger entries for the period
const settlementsSnap = await db.collection('sfosLedger')
  .where('type', '==', 'settlement')
  .where('createdAt', '>=', startDate)
  .where('createdAt', '<', endDate)
  .orderBy('createdAt')
  .get();

// Group by merchant (creditUid)
const byMerchant = {};
settlementsSnap.docs.forEach(doc => {
  const { creditUid, amount } = doc.data();
  byMerchant[creditUid] = (byMerchant[creditUid] || 0) + amount;
});

// Enrich with merchant names from sfosMerchant
console.log('Merchant | UID | Total Settled (KES)');
for (const [uid, total] of Object.entries(byMerchant)) {
  const merchantSnap = await db.doc(`sfosMerchant/${uid}`).get();
  const name = merchantSnap.exists ? merchantSnap.data().displayName : '(unknown)';
  console.log(`${name} | ${uid} | ${total.toLocaleString()}`);
}
```

### 7.3 Rewards Distribution Audit

Verify that rewards credited match the business rules (e.g. 1% cashback on marketplace orders):

```js
const rewardCreditsSnap = await db.collection('sfosLedger')
  .where('type', '==', 'reward-credit')
  .where('createdAt', '>=', startDate)
  .where('createdAt', '<', endDate)
  .get();

let totalRewardedKES = 0;
rewardCreditsSnap.docs.forEach(doc => {
  totalRewardedKES += doc.data().amount || 0;
});

console.log(`Total rewards credited: KES ${totalRewardedKES.toLocaleString()}`);
console.log(`Reward entries: ${rewardCreditsSnap.size}`);

// Spot-check: average reward per transaction
console.log(`Average reward: KES ${(totalRewardedKES / rewardCreditsSnap.size).toFixed(2)}`);
```

Cross-check against `sfosRewards/{uid}.lifetimePoints` totals to confirm point ledger matches KES credit ledger.

### 7.4 Tax Report — VAT on Marketplace Commissions

VAT (16% in Kenya) applies to SOKONI's marketplace commission income. Extract commission entries:

```js
const commissionsSnap = await db.collection('sfosLedger')
  .where('type', '==', 'commission')
  .where('creditUid', '==', 'PLATFORM')
  .where('createdAt', '>=', startDate)
  .where('createdAt', '<', endDate)
  .orderBy('createdAt')
  .get();

const totalCommission = commissionsSnap.docs.reduce((s, d) => s + (d.data().amount || 0), 0);
const vatRate = 0.16;

// Under Kenyan tax law: commission already includes VAT (VAT-inclusive pricing)
const vatPayable = totalCommission * (vatRate / (1 + vatRate)); // VAT-exclusive from inclusive
const netCommission = totalCommission - vatPayable;

console.log('\n=== VAT Calculation ===');
console.log(`Total commission collected : KES ${totalCommission.toLocaleString()}`);
console.log(`VAT payable (16%)          : KES ${vatPayable.toFixed(2)}`);
console.log(`Net commission (ex-VAT)    : KES ${netCommission.toFixed(2)}`);
console.log(`Commission entries         : ${commissionsSnap.size}`);
```

> **Important:** This is a basis for tax computation, not a final tax return. Submit to the certified accountant for KRA filing. Legal 5% commission rate is defined in `commission-config.js`.

---

## 8. Secrets Management

### 8.1 Required Secrets Inventory

All secrets are stored in **GCP Secret Manager** under the project `sokoni-prod`. Never store secrets in environment variables, `.env` files, or source code.

| Secret Name | Purpose | Rotation Schedule | Owner |
|-------------|---------|-------------------|-------|
| `ANTHROPIC_API_KEY` | Claude Haiku AI for `sfosAiForecast` | 90 days | Engineering |
| `WALLET_QR_SECRET` | HMAC signing key for QR wallet codes | 90 days | Engineering |
| `LOYALTY_HMAC_SECRET` | HMAC signing for offline loyalty QR codes | 90 days | Engineering |
| `INTASEND_API_KEY` | IntaSend live API key for M-Pesa STK push | 90 days | Engineering |
| `INTASEND_PRIVATE_KEY` | IntaSend RSA private key for webhook signature verification | 180 days | Engineering |
| `SENDGRID_API_KEY` | Transactional email for notifications and receipts | 90 days | Engineering |
| `REDIS_URL` | Redis connection string (VPC-internal URL) | On infrastructure change | DevOps |
| `ETIMS_AES_KEY` | AES-256-GCM key for eTIMS credential encryption | 365 days | Legal/Finance |
| `FIREBASE_SERVICE_ACCOUNT` | Admin SDK service account JSON (for scripts only) | 365 days | DevOps |

### 8.2 Routine Rotation Procedure (Every 90 Days)

1. **Generate new secret value** from the respective provider (Anthropic console, IntaSend dashboard, SendGrid, etc.)
2. **Add new version** to Secret Manager (do not delete the old version yet):
   ```bash
   echo -n "new-secret-value" | \
     gcloud secrets versions add ANTHROPIC_API_KEY \
     --data-file=- \
     --project=sokoni-prod
   ```
3. **Update CF to use the new version**: in `functions/sfos-engine.js`, the CF runtime accesses secrets via `secretEnvironmentVariables` in `firebase.json`. The `latest` reference automatically picks up the new version on the next deploy.
4. **Re-deploy affected functions:**
   ```bash
   firebase deploy --only functions:sfos-engine --project sokoni-prod
   ```
5. **Verify** that the CF works with the new secret (run smoke tests from `SFOS_DEPLOYMENT_CHECKLIST.md §2 Step 2`).
6. **Disable old secret version** only after confirming the new version works:
   ```bash
   gcloud secrets versions disable <old-version-number> \
     --secret=ANTHROPIC_API_KEY \
     --project=sokoni-prod
   ```
7. Log the rotation in the secret rotation ledger (`docs/ops-logs/secret-rotations.log` — gitignored).

### 8.3 Emergency Rotation Procedure

Use when a secret is suspected to be compromised (e.g. accidental commit, leaked logs):

**Target time: < 15 minutes from detection to new secret live.**

1. **Generate new secret immediately** — do not wait to confirm the leak.
2. **Revoke the compromised secret** at the provider (Anthropic console, IntaSend dashboard, etc.) before adding the new one. This stops any abuse immediately.
3. Add the new secret to Secret Manager (Step 2 in routine procedure).
4. **Emergency re-deploy** — use the fastest deploy path:
   ```bash
   # Deploy only the affected functions to minimise deploy time
   firebase deploy --only functions:sfosAiForecast --project sokoni-prod  # if ANTHROPIC_API_KEY
   firebase deploy --only functions:confirmWalletTopUp --project sokoni-prod  # if INTASEND keys
   ```
5. Monitor CF logs for 5 minutes to confirm the new secret works.
6. File a security incident report in `docs/security/incidents/YYYY-MM-DD-secret-rotation.md` including: what was leaked, how, when discovered, impact window, and remediation steps.
7. If the leaked secret was used maliciously (e.g. API charges on Anthropic, unauthorized M-Pesa calls): escalate to CTO and legal immediately.

### 8.4 Secret Access Audit

Monthly: verify only the SFOS service account has access to SFOS secrets:
```bash
gcloud secrets get-iam-policy ANTHROPIC_API_KEY --project=sokoni-prod
gcloud secrets get-iam-policy INTASEND_API_KEY --project=sokoni-prod
```

Expected: only `serviceAccount:sfos-functions@sokoni-prod.iam.gserviceaccount.com` has `secretmanager.secretAccessor` role. Remove any other principals that appear.

---

*See also:*  
- [[SFOS_ARCHITECTURE]] — full system design and data model  
- [[SFOS_DEPLOYMENT_CHECKLIST]] — deployment, smoke tests, and rollback  
- [[SFOS_INCIDENT_RUNBOOKS]] — INC-001 through INC-006 incident response  
- `scripts/sfos-integrity-check.js` — CHECK-1 through CHECK-5 ledger audit  
- `scripts/sfos-reconcile.js` — balance reconciliation  
- `scripts/sfos-migrate-identities.js` — one-time identity migration  
