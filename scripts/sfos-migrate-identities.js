/**
 * sfos-migrate-identities.js
 *
 * Batch creates sfosIdentity documents for all existing SOKONI users.
 * Safe to run multiple times — skips users who already have an identity.
 *
 * Usage:
 *   node scripts/sfos-migrate-identities.js
 *   node scripts/sfos-migrate-identities.js --dry-run
 *   node scripts/sfos-migrate-identities.js --limit=100
 *
 * Prerequisites:
 *   - GOOGLE_APPLICATION_CREDENTIALS env var set to service account JSON
 *   - OR run via: firebase functions:shell
 */

'use strict';

const admin = require('firebase-admin');
const crypto = require('crypto');

// Parse CLI args
const args = Object.fromEntries(
  process.argv.slice(2)
    .filter(a => a.startsWith('--'))
    .map(a => {
      const [k, v] = a.slice(2).split('=');
      return [k, v === undefined ? true : (isNaN(v) ? v : Number(v))];
    })
);

const DRY_RUN = !!args['dry-run'];
const LIMIT   = args.limit || Infinity;
const BATCH_SIZE = 50;

if (!admin.apps.length) {
  admin.initializeApp();
}
const db = admin.firestore();
const auth = admin.auth();

/* ─── Helpers ─── */

function generateWalletId() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const bytes = crypto.randomBytes(8);
  return 'SOK-' + Array.from(bytes).map(b => chars[b % chars.length]).join('');
}

async function isWalletIdUnique(id) {
  const snap = await db.collection('sfosIdentity').where('walletId', '==', id).limit(1).get();
  return snap.empty;
}

async function getUniqueWalletId() {
  for (let i = 0; i < 10; i++) {
    const id = generateWalletId();
    if (await isWalletIdUnique(id)) return id;
  }
  throw new Error('Could not generate unique walletId after 10 attempts');
}

function tierFromPoints(pts) {
  if (pts >= 50000) return 'diamond';
  if (pts >= 15000) return 'platinum';
  if (pts >= 5000)  return 'gold';
  if (pts >= 1000)  return 'silver';
  return 'bronze';
}

/* ─── Main Migration ─── */

async function migrateUser(uid, userData) {
  const identityRef = db.doc(`sfosIdentity/${uid}`);
  const snap = await identityRef.get();

  if (snap.exists) {
    return { uid, status: 'skipped', reason: 'already_exists' };
  }

  /* Load existing wallet for balance */
  const walletSnap = await db.doc(`wallets/${uid}`).get();
  const wallet = walletSnap.exists ? walletSnap.data() : {};

  const walletId = await getUniqueWalletId();

  const identity = {
    uid,
    walletId,
    username:     userData.username   || userData.email?.split('@')[0] || uid.slice(0, 8),
    displayName:  userData.displayName || userData.name || 'SOKONI User',
    phone:        userData.phone       || userData.phoneNumber || '',
    email:        userData.email       || '',
    // KYC
    kycStatus:   userData.kycStatus  || 'none',
    kycTier:     userData.kycTier    || 1,
    // Tier & rewards
    tier:          wallet.tier || 'bronze',
    rewardPoints:  wallet.rewardPoints || 0,
    lifetimePoints: 0,
    cashbackBalance: wallet.cashbackBalance || 0,
    // Scores
    financialScore: 0, // will be computed by sfosFinancialHealth CF
    riskScore: 10,     // start low (safe default)
    // Status
    status: 'active',
    // Security
    pinHash: wallet.pinHash || '',
    // Limits (defaults for Kenya)
    dailyLimit:   wallet.dailyLimit   || 150000,
    monthlyLimit: wallet.monthlyLimit || 1500000,
    dailySpent:   wallet.dailySpent   || 0,
    monthlySpent: wallet.monthlySpent || 0,
    // Meta
    createdAt:          admin.firestore.FieldValue.serverTimestamp(),
    updatedAt:          admin.firestore.FieldValue.serverTimestamp(),
    lastTransactionAt:  wallet.lastTopUp || null,
    migratedAt:         admin.firestore.FieldValue.serverTimestamp(),
    migrationVersion:   'sfos-v1',
  };

  /* Also seed sfosRewards doc */
  const rewardsRef = db.doc(`sfosRewards/${uid}`);
  const rewardsSnap = await rewardsRef.get();

  if (DRY_RUN) {
    return { uid, status: 'would_create', walletId, identity: '(dry run — not written)' };
  }

  const batch = db.batch();
  batch.set(identityRef, identity);

  if (!rewardsSnap.exists) {
    batch.set(rewardsRef, {
      uid,
      points:        wallet.rewardPoints || 0,
      lifetimePoints: 0,
      cashback:      wallet.cashbackBalance || 0,
      tier:          tierFromPoints(wallet.rewardPoints || 0),
      tierProgressPct: 0,
      nextTierPoints: 1000,
      streakDays:    0,
      achievements:  [],
      createdAt:     admin.firestore.FieldValue.serverTimestamp(),
    });
  }

  await batch.commit();
  return { uid, status: 'created', walletId };
}

async function main() {
  console.log(`\n🏦 SFOS Identity Migration`);
  console.log(`   Mode: ${DRY_RUN ? 'DRY RUN (no writes)' : 'LIVE'}`);
  console.log(`   Limit: ${LIMIT === Infinity ? 'all users' : LIMIT}`);
  console.log(`   Batch: ${BATCH_SIZE}\n`);

  /* List all Firebase Auth users */
  let pageToken;
  let total = 0, created = 0, skipped = 0, failed = 0;

  do {
    const page = await auth.listUsers(BATCH_SIZE, pageToken);
    pageToken = page.pageToken;

    for (const user of page.users) {
      if (total >= LIMIT) break;
      total++;

      try {
        /* Try to get matching Firestore user profile */
        const userSnap = await db.doc(`users/${user.uid}`).get();
        const userData = userSnap.exists
          ? userSnap.data()
          : {
              email: user.email,
              displayName: user.displayName,
              phone: user.phoneNumber,
            };

        const result = await migrateUser(user.uid, userData);
        if (result.status === 'created' || result.status === 'would_create') {
          created++;
          console.log(`  ✓ ${user.uid.slice(0, 8)}… → ${result.walletId}`);
        } else {
          skipped++;
        }
      } catch (err) {
        failed++;
        console.error(`  ✗ ${user.uid}: ${err.message}`);
      }
    }
  } while (pageToken && total < LIMIT);

  console.log(`\n📊 Migration Summary`);
  console.log(`   Total processed : ${total}`);
  console.log(`   Created         : ${created}`);
  console.log(`   Skipped         : ${skipped}`);
  console.log(`   Failed          : ${failed}`);
  if (DRY_RUN) console.log(`\n⚠️  DRY RUN — no documents were written.`);
  else console.log(`\n✅ Migration complete. Run scripts/sfos-reconcile.js to verify.`);
}

main().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
