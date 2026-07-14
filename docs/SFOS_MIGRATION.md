# SFOS Migration Guide — Wallet v1 → v2 → SFOS

**Version:** 1.0  
**Date:** 2026-07-14  
**Status:** Planning  
**Owner:** SOKONI Engineering  

---

## Overview

This guide describes the zero-downtime migration path from the current state (wallet.js v1 + wallet-engine.js v2) to the full SOKONI Financial Operating System (SFOS). It is intentionally conservative: every phase is additive, rollback procedures are documented, and no existing user data is modified destructively.

**Core rule:** At every phase, a user who has not opted into SFOS must have an identical experience to today.

---

## Phase 0 — Current State (Pre-Migration)

### What Is Live Today

| Component | File | Status |
|-----------|------|--------|
| Legacy wallet CFs | `functions/wallet.js` | LIVE — do not touch |
| Wallet 2.0 CFs | `functions/wallet-engine.js` | LIVE — do not touch |
| Wallet 2.0 client SDK | `sokoni-wallet-v2.js` | LIVE |
| Wallet 2.0 UI | `wallet.html` | LIVE — primary wallet page |
| SFOS CFs | `functions/sfos-engine.js` | NOT YET DEPLOYED |
| SFOS client SDK | `sfos-core.js` | NOT YET DEPLOYED |
| SFOS UI | `sfos-wallet.html` | NOT YET DEPLOYED |

### What Works in Phase 0

- M-Pesa top-up via IntaSend STK push.
- P2P send by phone number.
- Savings vaults (create, deposit, withdraw).
- QR code generation and payment.
- PIN setup and wallet freeze.
- Daily/monthly spend limits.
- AI spending insights (Claude Haiku).
- Transaction history with search and filter.

### What Phase 0 Lacks (SFOS Adds)

- Financial identity (tier, KYC level, financial passport).
- Immutable double-entry ledger.
- Escrow with milestones.
- Group/chama wallets.
- Merchant financial dashboard.
- Financial health score.
- Net worth calculation.
- AI spending forecast.
- Real-time risk engine.
- Loyalty rewards redemption.

### Known Limitations Being Addressed

1. No immutable audit trail — any admin could theoretically mutate balances.
2. Analytics are computed at query time (slow at scale).
3. No financial identity means no KYC tier-gating of features.
4. Escrow in `escrowV2` collection lacks milestone support.

---

## Phase 1 — SFOS Foundation

**Target:** sfos-engine.js deployed alongside existing CFs, zero user-facing changes.

### 1.1 Pre-Flight Checks

Before starting Phase 1:
- [ ] Verify Firestore index count < 190 (leave buffer for 8+ new SFOS indexes).
- [ ] Confirm `ANTHROPIC_API_KEY` secret is set in Secret Manager.
- [ ] Confirm `WALLET_QR_SECRET` secret is set.
- [ ] Run full regression on wallet.html (all 18 v2 CFs still passing).
- [ ] Ensure Cloud Run CPU quota is not exhausted.

### 1.2 Deploy sfos-engine.js

Add SFOS exports to `functions/index.js`:

```javascript
// functions/index.js — add these lines
const sfos = require('./sfos-engine');

exports.sfosIdentityGet      = sfos.sfosIdentityGet;
exports.sfosWalletGet        = sfos.sfosWalletGet;
exports.sfosTransact         = sfos.sfosTransact;
exports.sfosEscrowCreate     = sfos.sfosEscrowCreate;
exports.sfosEscrowRelease    = sfos.sfosEscrowRelease;
exports.sfosGroupCreate      = sfos.sfosGroupCreate;
exports.sfosGroupGet         = sfos.sfosGroupGet;
exports.sfosMerchantDashboard = sfos.sfosMerchantDashboard;
exports.sfosMerchantSettle   = sfos.sfosMerchantSettle;
exports.sfosRewardsGet       = sfos.sfosRewardsGet;
exports.sfosRewardsRedeem    = sfos.sfosRewardsRedeem;
exports.sfosFinancialHealth  = sfos.sfosFinancialHealth;
exports.sfosNetWorth         = sfos.sfosNetWorth;
exports.sfosAnalyticsDetailed = sfos.sfosAnalyticsDetailed;
exports.sfosAiForecast       = sfos.sfosAiForecast;
exports.sfosRiskCheck        = sfos.sfosRiskCheck;
```

Deploy:
```bash
firebase deploy --only functions --project sokoni-prod
```

### 1.3 Deploy Firestore Rules Update

The updated `firestore.rules` adds rules for:
- `sfosLedger` — read by debit/credit owner; write DENIED (CF-only via Admin SDK).
- `sfosIdentity` — read by owner; write DENIED.
- `sfosEscrow` — read by buyer or seller; write DENIED.
- `sfosRisk` — all access DENIED (Admin SDK only).
- `sfosGroups` — read by members array; write DENIED.
- `sfosRewards` — read by owner; write DENIED.

### 1.4 Deploy Firestore Indexes

Add 8 new SFOS composite indexes to `firestore.indexes.json`:
```bash
firebase deploy --only firestore:indexes --project sokoni-prod
```

Wait for all indexes to show status `READY` (10-30 minutes).

### 1.5 Batch Identity Migration

Run the identity migration script to pre-create `sfosIdentity` docs for all existing users:

```bash
node scripts/sfos-migrate-identities.js --project sokoni-prod --dry-run
# Review output — should show ~N users
node scripts/sfos-migrate-identities.js --project sokoni-prod
```

This script reads all existing `wallets/{uid}` documents and creates a corresponding `sfosIdentity/{uid}` document if one does not exist.

**Important:** `sfosIdentityGet` also creates the identity on first call (upsert), so this batch is optional for new users — it just ensures all existing users have pre-populated identities.

### 1.6 Phase 1 Verification

Run the reconciliation check to confirm wallet balances are consistent:

```bash
node scripts/sfos-reconcile.js --project sokoni-prod --sample 1000
```

Expected output: `✓ 1000/1000 wallets reconciled. Max drift: KES 0.00`

Run SFOS smoke tests:
```bash
node scripts/sfos-test.js --project sokoni-prod --suite smoke
```

Expected: all 10 smoke tests pass.

### 1.7 Phase 1 Rollback

If Phase 1 causes issues:

1. Remove the SFOS exports from `functions/index.js`.
2. Deploy functions: `firebase deploy --only functions`
3. The new SFOS CF containers are deleted but this is safe — no user-visible functionality has changed.
4. `sfosIdentity` documents created by the migration script are harmless and can remain.
5. `sfosLedger` is empty at this point (no transactions routed through SFOS yet).

---

## Phase 2 — UI Migration

**Target:** `sfos-wallet.html` deployed at `/sfos-wallet.html`. Gradual rollout to users. `wallet.html` remains primary.

### 2.1 Deploy sfos-wallet.html and sfos-core.js

```bash
firebase deploy --only hosting --project sokoni-prod
```

Verify:
- `https://mysokoni.co.ke/sfos-wallet.html` — loads without error.
- `https://mysokoni.co.ke/sfos-core.js` — returns 200.
- `sfosReady` event fires within 3 seconds on a 4G connection.

### 2.2 Gradual Rollout (10% → 50% → 100%)

**Week 1: 10% of users**

Add SFOS link to `wallet.html` for the pilot group:

```javascript
// In wallet.html, after identity load, show SFOS link for pilot users
if (user.uid.charCodeAt(0) % 10 === 0) { // ~10% by UID
  document.getElementById('sfos-pilot-link').hidden = false;
}
```

The pilot link renders:
```html
<a href="/sfos-wallet.html" class="sfos-pilot-cta">
  Try the new SFOS Dashboard →
</a>
```

**Week 2: 50% of users** — change `% 10 === 0` to `% 2 === 0`.

**Week 3: 100% of users** — show to all.

### 2.3 Feedback Collection

During Phase 2 rollout, collect:
- Time to first meaningful paint (Performance API).
- Error rate on each CF call (Cloud Monitoring).
- User drop-off rate from SFOS back to wallet.html.
- User-reported issues via in-app feedback button.

### 2.4 Phase 2 Rollback

If `sfos-wallet.html` has critical issues:
1. Remove or redirect the pilot link from `wallet.html`.
2. Users return to `wallet.html` naturally — no state is lost.
3. `sfos-core.js` and `sfos-wallet.html` can remain deployed (they are stateless client files).
4. If a specific CF is causing issues, disable it in `functions/index.js` and redeploy.

---

## Phase 3 — Full Integration

**Target:** All new transactions routed through `sfosTransact`. SFOS becomes the canonical financial engine.

### 3.1 Order Engine Integration

Update `functions/order-engine.js` checkout payment flow:

**Before:**
```javascript
// Direct wallet debit (no ledger entry)
await db.runTransaction(async t => {
  const wallet = t.get(walletRef);
  t.update(walletRef, { balance: FieldValue.increment(-amount) });
});
```

**After:**
```javascript
// Route through sfosTransact
const sfosTransact = require('./sfos-engine').sfosTransact;
await sfosTransact._internal({
  type: 'order-payment',
  debitUid: buyerUid,
  creditUid: sellerUid,
  amount,
  metadata: { orderId, productId, sellerId }
});
```

### 3.2 Commission Engine Integration

Update `functions/commission-engine.js` to use `sfosTransact` for commission deduction:
- Type: `commission`
- debitUid: seller UID
- creditUid: `"PLATFORM"` (Bravilex float account)
- metadata: `{ orderId, commissionRate, commissionAmount }`

### 3.3 SmartPOS Integration

Update `functions/pos-checkout.js` to record all POS payments in the SFOS ledger:
- Type: `order-payment`
- metadata: `{ posSessionId, tillId, storeId }`

### 3.4 Settlement Engine Integration

Update `functions/settlement-engine.js` to use `sfosMerchantSettle` for all settlement payouts. The settlement engine becomes a scheduler that calls `sfosMerchantSettle` in batches.

### 3.5 Phase 3 Verification

After Phase 3 is live for 24 hours:
1. Run `sfosReconcile` against all users.
2. Verify ledger entries exist for all transactions in that period.
3. Cross-check order totals against ledger credit totals.
4. Verify no duplicate ledger entries (idempotency working).

### 3.6 Phase 3 Rollback

If Phase 3 causes issues:
1. Revert the specific engine file that was updated (e.g. `order-engine.js`).
2. SFOS ledger entries from the bad period are labelled `metadata.rollbackPeriod: true`.
3. Write compensating entries for any incorrect credits.
4. **Do not delete ledger entries** — write reversals instead.

---

## Phase 4 — Full Cutover (Future)

**Target:** `wallet.html` redirects to `sfos-wallet.html`. `sfos-wallet.html` becomes the canonical wallet URL.

This phase is out of scope for RC1 and will be planned separately after Phase 3 is stable for 30+ days.

---

## Data Migration Scripts

### `scripts/sfos-migrate-identities.js`

Creates `sfosIdentity/{uid}` documents for all users who have a `wallets/{uid}` document but no `sfosIdentity/{uid}`.

```javascript
/**
 * sfos-migrate-identities.js
 * 
 * Usage:
 *   node scripts/sfos-migrate-identities.js --project sokoni-prod [--dry-run]
 * 
 * What it does:
 *   1. Reads all wallets/{uid} documents in batches of 500.
 *   2. For each uid, checks if sfosIdentity/{uid} exists.
 *   3. If not, creates sfosIdentity/{uid} using data from Firebase Auth + wallet doc.
 *   4. Marks wallets/{uid}.sfos = true on success.
 *
 * Safe to re-run: uses merge writes — idempotent.
 * Estimated time: ~2 minutes per 10,000 users.
 */

const admin = require('firebase-admin');
const { getAuth } = require('firebase-admin/auth');

async function migrateIdentities({ projectId, dryRun }) {
  admin.initializeApp({ projectId });
  const db   = admin.firestore();
  const auth = getAuth();

  let processed = 0;
  let created   = 0;
  let skipped   = 0;

  const walletsRef = db.collection('wallets');
  let lastDoc = null;
  const BATCH_SIZE = 500;

  do {
    let query = walletsRef.orderBy('__name__').limit(BATCH_SIZE);
    if (lastDoc) query = query.startAfter(lastDoc);

    const snap = await query.get();
    if (snap.empty) break;

    const batch = db.batch();
    let batchCount = 0;

    for (const doc of snap.docs) {
      const uid = doc.id;

      // Skip if identity already exists
      const identityRef = db.doc(`sfosIdentity/${uid}`);
      const existing = await identityRef.get();
      if (existing.exists && existing.data()?.sfos) {
        skipped++;
        continue;
      }

      // Get Auth user
      let authUser;
      try {
        authUser = await auth.getUser(uid);
      } catch {
        console.warn(`  [WARN] No Auth user for uid ${uid} — skipping`);
        continue;
      }

      const identity = {
        uid,
        displayName: authUser.displayName || authUser.email?.split('@')[0] || 'User',
        phone: authUser.phoneNumber || '',
        email: authUser.email || '',
        avatarInitial: (authUser.displayName?.[0] || authUser.email?.[0] || 'U').toUpperCase(),
        tier: 'Bronze',
        kyc: {
          level: 'Basic',
          idVerified: false,
          selfieVerified: false,
          businessVerified: false,
        },
        rewardPoints: 0,
        lifetimeSpend: 0,
        migratedAt: admin.firestore.FieldValue.serverTimestamp(),
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      };

      if (!dryRun) {
        batch.set(identityRef, identity, { merge: true });
        batch.update(doc.ref, { sfos: true, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
        batchCount++;
      } else {
        console.log(`  [DRY-RUN] Would create sfosIdentity/${uid}`);
      }
      created++;
    }

    if (!dryRun && batchCount > 0) {
      await batch.commit();
    }

    processed += snap.docs.length;
    lastDoc = snap.docs[snap.docs.length - 1];
    console.log(`  Processed: ${processed} | Created: ${created} | Skipped: ${skipped}`);

  } while (true);

  console.log(`\nMigration complete. Total: ${processed} | Created: ${created} | Skipped: ${skipped}`);
}

const args = process.argv.slice(2);
const projectId = args[args.indexOf('--project') + 1];
const dryRun    = args.includes('--dry-run');

if (!projectId) {
  console.error('Usage: node sfos-migrate-identities.js --project <projectId> [--dry-run]');
  process.exit(1);
}

migrateIdentities({ projectId, dryRun }).catch(e => {
  console.error('Migration failed:', e);
  process.exit(1);
});
```

### `scripts/sfos-reconcile.js`

Verifies that the SFOS ledger balance equals the wallet balance for each user.

```javascript
/**
 * sfos-reconcile.js
 * 
 * Usage:
 *   node scripts/sfos-reconcile.js --project sokoni-prod [--sample 1000]
 * 
 * What it does:
 *   For each user (or a random sample), sums all sfosLedger credits and debits,
 *   compares against wallets/{uid}.balance, and reports discrepancies.
 *
 * Output:
 *   - Summary: total checked, passed, failed.
 *   - For failures: uid, wallet balance, ledger balance, drift.
 *   - Writes results to sfosReconcileLog/{runId}.
 *
 * Run daily via scheduled CF (sfosReconcile).
 * Run manually before and after any major migration.
 */

const admin = require('firebase-admin');

async function reconcile({ projectId, sample }) {
  admin.initializeApp({ projectId });
  const db = admin.firestore();

  let checked  = 0;
  let passed   = 0;
  const failed = [];

  // Get wallets (optionally a sample)
  let walletsRef = db.collection('wallets').orderBy('__name__');
  if (sample) walletsRef = walletsRef.limit(sample);
  const walletSnap = await walletsRef.get();

  for (const walletDoc of walletSnap.docs) {
    const uid          = walletDoc.id;
    const walletBal    = walletDoc.data().balance || 0;

    // Skip wallets not yet on SFOS (no ledger entries expected)
    if (!walletDoc.data().sfos) { checked++; passed++; continue; }

    // Sum ledger credits
    const creditsSnap = await db.collection('sfosLedger')
      .where('creditUid', '==', uid)
      .get();
    const totalCredits = creditsSnap.docs.reduce((s, d) => s + (d.data().amount || 0), 0);

    // Sum ledger debits
    const debitsSnap = await db.collection('sfosLedger')
      .where('debitUid', '==', uid)
      .get();
    const totalDebits = debitsSnap.docs.reduce((s, d) => s + (d.data().amount || 0), 0);

    const ledgerBalance = parseFloat((totalCredits - totalDebits).toFixed(2));
    const drift         = parseFloat(Math.abs(walletBal - ledgerBalance).toFixed(2));

    if (drift > 0.01) {
      failed.push({ uid, walletBal, ledgerBalance, drift });
    } else {
      passed++;
    }
    checked++;
  }

  // Write reconciliation log
  await db.collection('sfosReconcileLog').add({
    runAt:   admin.firestore.FieldValue.serverTimestamp(),
    checked,
    passed,
    failed:  failed.length,
    details: failed.slice(0, 100), // cap stored failures
    sample:  sample || 'all',
  });

  console.log(`\nReconciliation complete:`);
  console.log(`  Checked: ${checked} | Passed: ${passed} | Failed: ${failed.length}`);
  if (failed.length) {
    console.error('\nFailed accounts:');
    failed.forEach(f => console.error(
      `  uid=${f.uid}  wallet=${f.walletBal}  ledger=${f.ledgerBalance}  drift=${f.drift}`
    ));
    process.exit(1);
  }
}

const args = process.argv.slice(2);
const projectId = args[args.indexOf('--project') + 1];
const sampleIdx = args.indexOf('--sample');
const sample    = sampleIdx > -1 ? parseInt(args[sampleIdx + 1]) : null;

if (!projectId) {
  console.error('Usage: node sfos-reconcile.js --project <projectId> [--sample N]');
  process.exit(1);
}

reconcile({ projectId, sample }).catch(e => {
  console.error('Reconciliation failed:', e);
  process.exit(1);
});
```

### `scripts/sfos-seed-rewards.js`

Creates `sfosRewards/{uid}` documents for all users with wallets, initialising them with zero points.

```javascript
/**
 * sfos-seed-rewards.js
 * 
 * Usage:
 *   node scripts/sfos-seed-rewards.js --project sokoni-prod [--dry-run]
 * 
 * What it does:
 *   Creates sfosRewards/{uid} with totalPoints: 0, tier: 'Bronze'
 *   for every user who has sfosIdentity/{uid} but no sfosRewards/{uid}.
 *
 * Safe to re-run: skips users who already have a rewards doc.
 */

const admin = require('firebase-admin');

async function seedRewards({ projectId, dryRun }) {
  admin.initializeApp({ projectId });
  const db = admin.firestore();

  let seeded  = 0;
  let skipped = 0;

  const identitySnap = await db.collection('sfosIdentity').get();

  for (const doc of identitySnap.docs) {
    const uid = doc.id;
    const rewardsRef = db.doc(`sfosRewards/${uid}`);
    const existing   = await rewardsRef.get();

    if (existing.exists) { skipped++; continue; }

    if (!dryRun) {
      await rewardsRef.set({
        uid,
        totalPoints:    0,
        lifetimePoints: 0,
        tier:           'Bronze',
        tierUpdatedAt:  admin.firestore.FieldValue.serverTimestamp(),
        createdAt:      admin.firestore.FieldValue.serverTimestamp(),
        updatedAt:      admin.firestore.FieldValue.serverTimestamp(),
      });
    } else {
      console.log(`  [DRY-RUN] Would seed sfosRewards/${uid}`);
    }
    seeded++;
  }

  console.log(`\nRewards seeding complete. Seeded: ${seeded} | Skipped: ${skipped}`);
}

const args = process.argv.slice(2);
const projectId = args[args.indexOf('--project') + 1];
const dryRun    = args.includes('--dry-run');

if (!projectId) {
  console.error('Usage: node sfos-seed-rewards.js --project <projectId> [--dry-run]');
  process.exit(1);
}

seedRewards({ projectId, dryRun }).catch(e => {
  console.error('Seeding failed:', e);
  process.exit(1);
});
```

---

## Rollback Summary

| Phase | Rollback Action | Data Impact | Time |
|-------|----------------|-------------|------|
| 1 — CFs | Remove SFOS exports from index.js, redeploy | None — sfosIdentity docs remain (harmless) | 5 min |
| 1 — Rules | Revert firestore.rules, redeploy | None — more permissive rules briefly | 2 min |
| 1 — Indexes | No rollback needed (additive) | None — indexes can stay | N/A |
| 2 — UI | Remove pilot link from wallet.html | None — sfos-wallet.html remains deployed but unlinked | 2 min |
| 3 — Order engine | Revert order-engine.js, redeploy | Write compensating ledger entries for bad period | 15 min |
| 3 — Settlement | Revert settlement-engine.js, redeploy | None — settlement entries in ledger are correct | 5 min |

---

## Communication Plan

### Internal Team

Before Phase 1: notify team of deployment window (Tuesday 10:00-12:00 EAT, low-traffic window).

After Phase 1: share smoke test results with engineering team.

After Phase 2 week 1: share pilot user metrics (error rate, session length, conversion).

### Users

No user-facing communication needed for Phase 1 (invisible infrastructure).

Phase 2: "Try the new SOKONI Financial Dashboard" in-app banner for pilot group.

Phase 4 (future): "Wallet has been upgraded to SFOS" announcement with guided onboarding.

---

*Related: [[SFOS_ARCHITECTURE]] | [[SFOS_ROADMAP]] | [[WALLET_V2_ARCHITECTURE]]*
