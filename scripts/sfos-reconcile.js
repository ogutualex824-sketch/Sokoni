/**
 * sfos-reconcile.js
 *
 * Verifies that SFOS ledger balances match wallet balances.
 * Identifies any users whose sfosLedger sum diverges from wallets/{uid}.balance.
 * Reports discrepancies without auto-correcting (human review required for corrections).
 *
 * Usage:
 *   node scripts/sfos-reconcile.js
 *   node scripts/sfos-reconcile.js --limit=50
 *   node scripts/sfos-reconcile.js --uid=abc123  (single user)
 *
 * Output:
 *   - Prints a reconciliation report to stdout
 *   - Exits with code 0 if all balances match, 1 if discrepancies found
 */

'use strict';

const admin = require('firebase-admin');

const args = Object.fromEntries(
  process.argv.slice(2)
    .filter(a => a.startsWith('--'))
    .map(a => {
      const [k, v] = a.slice(2).split('=');
      return [k, v === undefined ? true : v];
    })
);

const LIMIT    = args.limit ? Number(args.limit) : 100;
const ONLY_UID = args.uid || null;

if (!admin.apps.length) admin.initializeApp();
const db = admin.firestore();

async function reconcileUser(uid) {
  /* Get canonical balance from wallets/{uid} */
  const walletSnap = await db.doc(`wallets/${uid}`).get();
  if (!walletSnap.exists) return { uid, status: 'no_wallet' };

  const walletBalance = walletSnap.data().balance || 0;

  /* Sum SFOS ledger CREDIT - DEBIT for this user */
  const credits = await db.collection('sfosLedger')
    .where('accountId', '==', uid)
    .where('direction', '==', 'CREDIT')
    .where('ledgerType', '==', 'WALLET')
    .get();

  const debits = await db.collection('sfosLedger')
    .where('accountId', '==', uid)
    .where('direction', '==', 'DEBIT')
    .where('ledgerType', '==', 'WALLET')
    .get();

  const totalCredits = credits.docs.reduce((s, d) => s + (d.data().amount || 0), 0);
  const totalDebits  = debits.docs.reduce((s, d)  => s + (d.data().amount || 0), 0);
  const ledgerBalance = Math.round((totalCredits - totalDebits) * 100) / 100;

  const diff = Math.abs(Math.round((walletBalance - ledgerBalance) * 100) / 100);

  if (credits.size === 0 && debits.size === 0) {
    /* No SFOS ledger entries yet — this is expected before SFOS goes live */
    return { uid, status: 'no_sfos_ledger', walletBalance };
  }

  if (diff > 0.01) {
    return {
      uid, status: 'MISMATCH',
      walletBalance, ledgerBalance,
      diff,
      ledgerEntries: credits.size + debits.size
    };
  }

  return { uid, status: 'OK', walletBalance, ledgerBalance };
}

async function main() {
  console.log('\n🔍 SFOS Reconciliation Check');
  console.log(`   Limit: ${ONLY_UID ? 'single user ' + ONLY_UID : LIMIT}\n`);

  const mismatches = [];
  const noLedger   = [];
  let ok = 0, total = 0;

  if (ONLY_UID) {
    const result = await reconcileUser(ONLY_UID);
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.status === 'MISMATCH' ? 1 : 0);
  }

  /* Sample from wallets collection */
  const walletsSnap = await db.collection('wallets').limit(LIMIT).get();

  for (const doc of walletsSnap.docs) {
    total++;
    try {
      const result = await reconcileUser(doc.id);
      if (result.status === 'MISMATCH') {
        mismatches.push(result);
        console.log(`  ✗ MISMATCH ${doc.id.slice(0, 8)}… wallet=${result.walletBalance} ledger=${result.ledgerBalance} diff=${result.diff}`);
      } else if (result.status === 'no_sfos_ledger') {
        noLedger.push(result.uid);
      } else if (result.status === 'OK') {
        ok++;
      }
    } catch (err) {
      console.error(`  ERROR ${doc.id}: ${err.message}`);
    }
  }

  console.log('\n📊 Reconciliation Report');
  console.log(`   Total wallets checked : ${total}`);
  console.log(`   Matching (OK)         : ${ok}`);
  console.log(`   No SFOS ledger yet    : ${noLedger.length} (expected before SFOS launch)`);
  console.log(`   MISMATCHES            : ${mismatches.length}`);

  if (mismatches.length > 0) {
    console.log('\n⚠️  MISMATCHES FOUND — manual investigation required:');
    mismatches.forEach(m => {
      console.log(`   ${m.uid} | wallet=${m.walletBalance} | ledger=${m.ledgerBalance} | diff=${m.diff}`);
    });
    console.log('\nTo fix: create compensating sfosLedger entries via sfosTransactReverse (admin CF).');
    process.exit(1);
  } else {
    console.log('\n✅ All sampled wallets reconcile correctly.');
    process.exit(0);
  }
}

main().catch(err => {
  console.error('Reconciliation failed:', err);
  process.exit(1);
});
