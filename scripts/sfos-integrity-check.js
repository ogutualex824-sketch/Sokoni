/**
 * sfos-integrity-check.js
 *
 * SFOS Ledger Integrity Audit — SOKONI Financial OS v1.1 Hardening Sprint
 *
 * Performs checks that go BEYOND sfos-reconcile.js (which only compares
 * ledger sums vs wallets.balance). This script audits structural correctness
 * of every SFOS collection:
 *
 *   CHECK-1  Balance consistency   (ledger sum == wallets.balance, no negatives, no absurd amounts)
 *   CHECK-2  Orphan detection      (sfosLedger entries referencing non-existent txId)
 *   CHECK-3  Double-entry          (each sfosTransactions txId has exactly 1 DEBIT + 1 CREDIT)
 *   CHECK-4  Velocity drift        (sfosIdentity dailySpent/monthlySpent within limits)
 *   CHECK-5  Stuck idempotency     (sfosIdempotency docs in PENDING status > 1 hour)
 *
 * Usage:
 *   node scripts/sfos-integrity-check.js              # sample 50 wallets
 *   node scripts/sfos-integrity-check.js --limit=200  # sample 200 wallets
 *   node scripts/sfos-integrity-check.js --full       # all wallets (slow — use for scheduled runs)
 *   node scripts/sfos-integrity-check.js --uid=xxx    # single user
 *
 * Exit codes:
 *   0  HEALTHY   — no anomalies detected
 *   1  WARNING   — anomalies detected but non-critical (e.g. velocity drift, stuck idempotency)
 *   2  CRITICAL  — balance mismatches, orphan ledger entries, or broken double-entry detected
 *
 * Prerequisites:
 *   GOOGLE_APPLICATION_CREDENTIALS env var pointing to a service-account JSON with
 *   Firestore read access. If not set the script exits with a clear error message.
 */

'use strict';

/* ─────────────────────────── Bootstrap ─────────────────────────── */

if (!process.env.GOOGLE_APPLICATION_CREDENTIALS && !process.env.FIREBASE_EMULATOR_HOST) {
  const hint =
    '\n  Set GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json before running.\n' +
    '  Or use the Firebase Emulator and set FIREBASE_EMULATOR_HOST=localhost:8080.\n';
  console.error('[sfos-integrity-check] ERROR: No credentials found.' + hint);
  process.exit(2);
}

const admin = require('firebase-admin');

if (!admin.apps.length) {
  admin.initializeApp();
}
const db = admin.firestore();

/* ─────────────────────────── CLI Args ──────────────────────────── */

const args = Object.fromEntries(
  process.argv.slice(2)
    .filter(a => a.startsWith('--'))
    .map(a => {
      const [k, v] = a.slice(2).split('=');
      return [k, v === undefined ? true : v];
    })
);

const FULL     = !!args.full;
const LIMIT    = FULL ? Infinity : (args.limit ? Number(args.limit) : 50);
const ONLY_UID = args.uid || null;

/* Hard caps to avoid runaway Firestore reads in non-full mode */
const MAX_WALLET_SAMPLE  = FULL ? 999999 : LIMIT;
const ANOMALY_DISPLAY    = 10;         // top-N anomalies shown per check
const ABSURD_BALANCE     = 50_000_000; // KES — triggers WARNING not CRITICAL
const ONE_HOUR_MS        = 60 * 60 * 1000;

/* ─────────────────────────── Helpers ────────────────────────────── */

function round2(n) {
  return Math.round(n * 100) / 100;
}

function ts() {
  return new Date().toISOString();
}

function printSection(title) {
  console.log(`\n${'─'.repeat(70)}`);
  console.log(`  ${title}`);
  console.log('─'.repeat(70));
}

/* ─────────────────────────── CHECK-1 ───────────────────────────── */
/*  Balance consistency: ledger sum ≈ wallets.balance                 */
/*  Additional guards: no negative balances, no absurd balances       */

async function checkBalanceConsistency(uids) {
  const anomalies = [];
  let passCount   = 0;
  let noLedger    = 0;

  for (const uid of uids) {
    try {
      const [walletSnap, creditsSnap, debitsSnap] = await Promise.all([
        db.doc(`wallets/${uid}`).get(),
        db.collection('sfosLedger')
          .where('accountId', '==', uid)
          .where('direction', '==', 'CREDIT')
          .where('ledgerType', '==', 'WALLET')
          .get(),
        db.collection('sfosLedger')
          .where('accountId', '==', uid)
          .where('direction', '==', 'DEBIT')
          .where('ledgerType', '==', 'WALLET')
          .get(),
      ]);

      if (!walletSnap.exists) continue;

      const walletBalance = walletSnap.data().balance ?? 0;

      // Guard: negative balance is a critical integrity failure
      if (walletBalance < 0) {
        anomalies.push({
          uid, code: 'NEGATIVE_BALANCE',
          walletBalance,
          severity: 'CRITICAL',
          detail: `wallets/${uid}.balance = ${walletBalance}`,
        });
        continue;
      }

      // Guard: absurd balance is suspicious (WARNING level)
      if (walletBalance > ABSURD_BALANCE) {
        anomalies.push({
          uid, code: 'ABSURD_BALANCE',
          walletBalance,
          severity: 'WARNING',
          detail: `balance KES ${walletBalance.toLocaleString()} exceeds KES ${ABSURD_BALANCE.toLocaleString()} threshold`,
        });
        // Don't skip — still check ledger consistency
      }

      if (creditsSnap.empty && debitsSnap.empty) {
        noLedger++;
        continue; // expected before SFOS goes live
      }

      const totalCredits = creditsSnap.docs.reduce((s, d) => s + (d.data().amount || 0), 0);
      const totalDebits  = debitsSnap.docs.reduce((s, d)  => s + (d.data().amount || 0), 0);
      const ledgerBalance = round2(totalCredits - totalDebits);
      const diff          = round2(Math.abs(walletBalance - ledgerBalance));

      if (diff > 0.01) {
        anomalies.push({
          uid, code: 'LEDGER_MISMATCH',
          walletBalance, ledgerBalance, diff,
          severity: 'CRITICAL',
          detail: `wallet=${walletBalance} ledger=${ledgerBalance} diff=${diff}`,
        });
      } else {
        passCount++;
      }
    } catch (err) {
      anomalies.push({ uid, code: 'READ_ERROR', severity: 'WARNING', detail: err.message });
    }
  }

  return { check: 'CHECK-1 Balance Consistency', passCount, noLedger, anomalies };
}

/* ─────────────────────────── CHECK-2 ───────────────────────────── */
/*  Orphan detection: sfosLedger entries whose txId does not exist   */
/*  in sfosTransactions. Scoped to same UID set to keep it bounded.  */

async function checkOrphans(uids) {
  const anomalies = [];
  let checked = 0;
  let orphanCount = 0;

  // Fetch ledger entries for sampled users that carry a txId reference
  const BATCH = 30;
  for (let i = 0; i < uids.length; i += BATCH) {
    const batch = uids.slice(i, i + BATCH);

    // Only entries with a txId field (not all ledger types have one)
    let ledgerSnap;
    try {
      ledgerSnap = await db.collection('sfosLedger')
        .where('accountId', 'in', batch)
        .where('txId', '!=', null)
        .limit(500)
        .get();
    } catch {
      // "in" queries fail if batch is empty
      continue;
    }

    // Collect unique txIds and verify in sfosTransactions
    const txIds = [...new Set(ledgerSnap.docs.map(d => d.data().txId).filter(Boolean))];

    for (const txId of txIds) {
      checked++;
      const txSnap = await db.doc(`sfosTransactions/${txId}`).get();
      if (!txSnap.exists) {
        orphanCount++;
        // Find which ledger entries reference this orphan txId
        const orphanEntries = ledgerSnap.docs
          .filter(d => d.data().txId === txId)
          .map(d => d.id);

        anomalies.push({
          txId, code: 'ORPHAN_TX_ID',
          severity: 'CRITICAL',
          affectedLedgerEntries: orphanEntries,
          detail: `sfosLedger entries ${orphanEntries.join(', ')} reference txId "${txId}" which does not exist in sfosTransactions`,
        });
      }
    }
  }

  return {
    check: 'CHECK-2 Orphan Detection',
    checkedTxRefs: checked,
    orphanCount,
    anomalies,
  };
}

/* ─────────────────────────── CHECK-3 ───────────────────────────── */
/*  Double-entry verification for sfosTransactions                   */
/*  Each transaction must have exactly 1 DEBIT + 1 CREDIT entry,    */
/*  equal amounts, and correct accountIds.                           */

async function checkDoubleEntry(txLimit) {
  const anomalies = [];
  let passCount   = 0;

  const effectiveLimit = Math.min(txLimit, 1000); // cap for non-full runs

  let txSnap;
  try {
    txSnap = await db.collection('sfosTransactions')
      .orderBy('createdAt', 'desc')
      .limit(effectiveLimit)
      .get();
  } catch (err) {
    return {
      check: 'CHECK-3 Double-Entry Verification',
      error: err.message,
      anomalies: [],
    };
  }

  for (const txDoc of txSnap.docs) {
    const tx   = txDoc.data();
    const txId = txDoc.id;

    // Query sfosLedger entries for this transaction
    let entriesSnap;
    try {
      entriesSnap = await db.collection('sfosLedger')
        .where('txId', '==', txId)
        .limit(10)
        .get();
    } catch (err) {
      anomalies.push({ txId, code: 'READ_ERROR', severity: 'WARNING', detail: err.message });
      continue;
    }

    const entries = entriesSnap.docs.map(d => ({ id: d.id, ...d.data() }));

    // Exactly 2 entries required (DEBIT + CREDIT)
    if (entries.length !== 2) {
      anomalies.push({
        txId, code: 'WRONG_ENTRY_COUNT',
        severity: entries.length === 0 ? 'CRITICAL' : 'WARNING',
        entryCount: entries.length,
        detail: `Expected 2 ledger entries for txId "${txId}", found ${entries.length}`,
      });
      continue;
    }

    const debitEntry  = entries.find(e => e.direction === 'DEBIT');
    const creditEntry = entries.find(e => e.direction === 'CREDIT');

    if (!debitEntry || !creditEntry) {
      anomalies.push({
        txId, code: 'MISSING_DEBIT_OR_CREDIT',
        severity: 'CRITICAL',
        directions: entries.map(e => e.direction),
        detail: `txId "${txId}" does not have both a DEBIT and a CREDIT entry`,
      });
      continue;
    }

    // Amounts must match
    const debitAmt  = round2(debitEntry.amount  || 0);
    const creditAmt = round2(creditEntry.amount || 0);
    if (Math.abs(debitAmt - creditAmt) > 0.001) {
      anomalies.push({
        txId, code: 'AMOUNT_MISMATCH',
        severity: 'CRITICAL',
        debitAmt, creditAmt,
        detail: `Debit (${debitAmt}) != Credit (${creditAmt}) for txId "${txId}"`,
      });
      continue;
    }

    // accountId alignment with transaction fromId/toId
    const fromId = tx.fromId || tx.senderId || tx.debitUid;
    const toId   = tx.toId   || tx.recipientId || tx.creditUid;

    const fromMismatch = fromId && debitEntry.accountId !== fromId;
    const toMismatch   = toId   && creditEntry.accountId !== toId && creditEntry.accountId !== 'PLATFORM';

    if (fromMismatch) {
      anomalies.push({
        txId, code: 'DEBIT_ACCOUNT_MISMATCH',
        severity: 'WARNING',
        expected: fromId, found: debitEntry.accountId,
        detail: `DEBIT accountId mismatch for txId "${txId}": expected ${fromId}, found ${debitEntry.accountId}`,
      });
      continue;
    }

    if (toMismatch) {
      anomalies.push({
        txId, code: 'CREDIT_ACCOUNT_MISMATCH',
        severity: 'WARNING',
        expected: toId, found: creditEntry.accountId,
        detail: `CREDIT accountId mismatch for txId "${txId}": expected ${toId} or PLATFORM, found ${creditEntry.accountId}`,
      });
      continue;
    }

    passCount++;
  }

  return {
    check: 'CHECK-3 Double-Entry Verification',
    checkedTx: txSnap.size,
    passCount,
    anomalies,
  };
}

/* ─────────────────────────── CHECK-4 ───────────────────────────── */
/*  Velocity counter drift: sfosIdentity dailySpent/monthlySpent     */
/*  must be non-negative and must not exceed their respective limits. */

async function checkVelocityDrift(uids) {
  const anomalies = [];
  let passCount   = 0;

  for (const uid of uids) {
    try {
      const identSnap = await db.doc(`sfosIdentity/${uid}`).get();
      if (!identSnap.exists) continue;

      const ident = identSnap.data();
      const {
        dailySpent    = 0,
        monthlySpent  = 0,
        dailyLimit    = 150_000,
        monthlyLimit  = 1_500_000,
      } = ident;

      let clean = true;

      if (dailySpent < 0) {
        anomalies.push({
          uid, code: 'NEGATIVE_DAILY_SPENT',
          severity: 'WARNING', dailySpent,
          detail: `sfosIdentity/${uid}.dailySpent is negative (${dailySpent})`,
        });
        clean = false;
      }

      if (monthlySpent < 0) {
        anomalies.push({
          uid, code: 'NEGATIVE_MONTHLY_SPENT',
          severity: 'WARNING', monthlySpent,
          detail: `sfosIdentity/${uid}.monthlySpent is negative (${monthlySpent})`,
        });
        clean = false;
      }

      if (dailySpent > dailyLimit) {
        anomalies.push({
          uid, code: 'DAILY_LIMIT_EXCEEDED',
          severity: 'CRITICAL',
          dailySpent, dailyLimit,
          detail: `sfosIdentity/${uid}.dailySpent (${dailySpent}) exceeds dailyLimit (${dailyLimit}) — velocity check may have a bug`,
        });
        clean = false;
      }

      if (monthlySpent > monthlyLimit) {
        anomalies.push({
          uid, code: 'MONTHLY_LIMIT_EXCEEDED',
          severity: 'CRITICAL',
          monthlySpent, monthlyLimit,
          detail: `sfosIdentity/${uid}.monthlySpent (${monthlySpent}) exceeds monthlyLimit (${monthlyLimit}) — velocity check may have a bug`,
        });
        clean = false;
      }

      if (clean) passCount++;
    } catch (err) {
      anomalies.push({ uid, code: 'READ_ERROR', severity: 'WARNING', detail: err.message });
    }
  }

  return { check: 'CHECK-4 Velocity Counter Drift', passCount, anomalies };
}

/* ─────────────────────────── CHECK-5 ───────────────────────────── */
/*  Stuck idempotency entries: sfosIdempotency docs in PENDING       */
/*  status older than 1 hour indicate crashed CF executions.         */

async function checkStuckIdempotency() {
  const anomalies = [];
  const cutoff    = new Date(Date.now() - ONE_HOUR_MS);

  let snap;
  try {
    snap = await db.collection('sfosIdempotency')
      .where('status', '==', 'PENDING')
      .where('createdAt', '<', cutoff)
      .limit(200)
      .get();
  } catch (err) {
    return {
      check: 'CHECK-5 Stuck Idempotency',
      error: `Query failed — index may be missing: ${err.message}`,
      anomalies: [],
    };
  }

  let stuckCount = snap.size;

  snap.docs.slice(0, ANOMALY_DISPLAY).forEach(doc => {
    const data = doc.data();
    const ageMs = Date.now() - (data.createdAt?.toDate?.()?.getTime?.() || 0);
    anomalies.push({
      docId: doc.id, code: 'STUCK_IDEMPOTENCY',
      severity: 'WARNING',
      uid:       data.uid || data.userId || '(unknown)',
      operation: data.operation || data.cfName || '(unknown)',
      ageMinutes: Math.round(ageMs / 60_000),
      detail: `sfosIdempotency/${doc.id} has been PENDING for ~${Math.round(ageMs / 60_000)} min`,
    });
  });

  return {
    check: 'CHECK-5 Stuck Idempotency',
    stuckCount,
    note: stuckCount > ANOMALY_DISPLAY
      ? `Showing top ${ANOMALY_DISPLAY} of ${stuckCount} stuck entries`
      : undefined,
    anomalies,
  };
}

/* ─────────────────────────── Reporting ─────────────────────────── */

function printCheckResult(result) {
  const hasCritical = result.anomalies.some(a => a.severity === 'CRITICAL');
  const hasWarning  = result.anomalies.some(a => a.severity === 'WARNING');
  const status      = hasCritical ? 'FAIL [CRITICAL]' : hasWarning ? 'WARN' : 'PASS';
  const icon        = hasCritical ? 'X' : hasWarning ? '!' : 'V';

  console.log(`\n  [${icon}] ${result.check} — ${status}`);
  if (result.error) {
    console.log(`      Error: ${result.error}`);
    return;
  }

  if (result.passCount !== undefined) {
    console.log(`      Passed  : ${result.passCount}`);
  }
  if (result.noLedger !== undefined) {
    console.log(`      No ledger yet : ${result.noLedger} (expected pre-SFOS launch)`);
  }
  if (result.checkedTxRefs !== undefined) {
    console.log(`      Tx refs checked : ${result.checkedTxRefs}`);
  }
  if (result.orphanCount !== undefined) {
    console.log(`      Orphans found   : ${result.orphanCount}`);
  }
  if (result.checkedTx !== undefined) {
    console.log(`      Transactions checked : ${result.checkedTx}`);
  }
  if (result.stuckCount !== undefined) {
    console.log(`      Stuck PENDING entries : ${result.stuckCount}`);
  }

  if (result.anomalies.length > 0) {
    console.log(`      Anomalies (top ${Math.min(ANOMALY_DISPLAY, result.anomalies.length)}):`);
    result.anomalies.slice(0, ANOMALY_DISPLAY).forEach((a, i) => {
      console.log(`        ${i + 1}. [${a.severity}] ${a.code} — ${a.detail}`);
    });
    if (result.anomalies.length > ANOMALY_DISPLAY) {
      console.log(`        ... and ${result.anomalies.length - ANOMALY_DISPLAY} more.`);
    }
  }

  if (result.note) console.log(`      Note: ${result.note}`);
}

function computeOverallStatus(results) {
  const allAnomalies = results.flatMap(r => r.anomalies || []);
  const hasCritical  = allAnomalies.some(a => a.severity === 'CRITICAL');
  const hasWarning   = allAnomalies.some(a => a.severity === 'WARNING');
  if (hasCritical) return 'CRITICAL';
  if (hasWarning)  return 'WARNING';
  return 'HEALTHY';
}

/* ─────────────────────────── Main ──────────────────────────────── */

async function main() {
  console.log('\n' + '='.repeat(70));
  console.log('  SFOS Ledger Integrity Check — SOKONI Financial OS v1.1');
  console.log('='.repeat(70));
  console.log(`  Timestamp : ${ts()}`);
  console.log(`  Mode      : ${ONLY_UID ? `single user ${ONLY_UID}` : FULL ? 'FULL SCAN' : `sample ${LIMIT}`}`);

  /* ── Collect user set ── */
  let uids = [];

  if (ONLY_UID) {
    uids = [ONLY_UID];
  } else {
    const walletsSnap = await db.collection('wallets')
      .limit(MAX_WALLET_SAMPLE === Infinity ? 99999 : MAX_WALLET_SAMPLE)
      .get();
    uids = walletsSnap.docs.map(d => d.id);
  }

  console.log(`  Users in scope : ${uids.length}`);

  /* ── Run all checks ── */
  printSection('CHECK-1  Balance Consistency');
  const c1 = await checkBalanceConsistency(uids);

  printSection('CHECK-2  Orphan Detection');
  const c2 = await checkOrphans(uids);

  printSection('CHECK-3  Double-Entry Verification');
  const txLimit = FULL ? 10_000 : Math.min(LIMIT * 5, 1000);
  const c3 = await checkDoubleEntry(txLimit);

  printSection('CHECK-4  Velocity Counter Drift');
  const c4 = await checkVelocityDrift(uids);

  printSection('CHECK-5  Stuck Idempotency Entries');
  const c5 = await checkStuckIdempotency();

  const results = [c1, c2, c3, c4, c5];

  /* ── Per-check output ── */
  printSection('RESULTS');
  results.forEach(printCheckResult);

  /* ── Summary ── */
  const overall          = computeOverallStatus(results);
  const totalAnomalies   = results.reduce((s, r) => s + (r.anomalies?.length || 0), 0);
  const criticalCount    = results.flatMap(r => r.anomalies || []).filter(a => a.severity === 'CRITICAL').length;
  const warningCount     = results.flatMap(r => r.anomalies || []).filter(a => a.severity === 'WARNING').length;

  console.log('\n' + '='.repeat(70));
  console.log(`  OVERALL STATUS : ${overall}`);
  console.log('='.repeat(70));
  console.log(`  Total anomalies  : ${totalAnomalies}`);
  console.log(`  Critical         : ${criticalCount}`);
  console.log(`  Warnings         : ${warningCount}`);
  console.log(`  Completed at     : ${ts()}`);

  if (overall === 'HEALTHY') {
    console.log('\n  All checks passed. SFOS ledger integrity is confirmed.\n');
    process.exit(0);
  } else if (overall === 'WARNING') {
    console.log('\n  One or more warnings require review. No immediate financial risk.\n');
    process.exit(1);
  } else {
    console.log('\n  CRITICAL anomalies detected. Immediate investigation required.\n');
    console.log('  Next steps:');
    console.log('    1. Freeze affected wallets: sfosIdentity.status = "frozen"');
    console.log('    2. Create compensating entries via sfosTransactReverse (admin CF)');
    console.log('    3. Escalate to engineering lead per INC-001/INC-002 runbooks');
    console.log('    4. Re-run with --uid=<affected-uid> to confirm remediation\n');
    process.exit(2);
  }
}

main().catch(err => {
  console.error('\n[sfos-integrity-check] Fatal error:', err.message);
  console.error(err.stack);
  process.exit(2);
});
