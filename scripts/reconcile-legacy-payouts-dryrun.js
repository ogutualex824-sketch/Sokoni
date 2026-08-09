'use strict';
/* ============================================================================
   SOKONI — Legacy Provider-Payout Reconciliation  (DRY-RUN ONLY, ZERO WRITES)
   docs/BOOKING_CONVERGENCE.md — Phase C follow-up.

   Phase C settles provider earnings to the withdrawable wallet at booking
   completion and marks the providerPayouts row `settled`. Bookings COMPLETED
   BEFORE Phase C deployed left their payout rows `pending` and were never
   credited to a wallet — historical data, not a runtime bug.

   This script REPORTS those stranded payouts so a human can review before any
   migration runs. It performs NO writes. Execution of the actual backfill is a
   SEPARATE, explicitly-approved step (and must reuse the same exactly-once
   settlement transaction, keyed on the deterministic wallet-txn id below).

   Run against production (uses Application Default Credentials):
     node scripts/reconcile-legacy-payouts-dryrun.js
   Run against the emulator:
     FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 GCLOUD_PROJECT=demo-sokoni \
       node scripts/reconcile-legacy-payouts-dryrun.js
   Optional: --json emits machine-readable rows for a spreadsheet/export.
   ========================================================================== */

const path = require('path');
const admin = require(path.join(__dirname, '..', 'functions', 'node_modules', 'firebase-admin'));
if (!admin.apps.length) admin.initializeApp();       // ADC in prod; env host for emulator
const db = admin.firestore();
const asJson = process.argv.includes('--json');

/* A settled earning lives at this deterministic id — its existence means the
   wallet ALREADY holds this booking's money, so the row must NOT be re-credited. */
const settleTxId = (providerId, bookingId) => `${providerId}_${bookingId}_bookingsettle`;

(async () => {
  const snap = await db.collection('providerPayouts').where('status', '==', 'pending').limit(5000).get();

  const rows = [];
  let totalNetCents = 0, totalProposedShillings = 0;
  let alreadySettled = 0, missingBooking = 0, notCompleted = 0, creditable = 0;

  for (const doc of snap.docs) {
    const p = doc.data();
    const bookingId = p.bookingId || p.sourceId || doc.id;
    const provider  = p.providerId || null;
    const netCents  = Math.max(0, Math.round(Number(p.net) || 0));
    const proposedShillings = Math.floor(netCents / 100);

    // Does the wallet already hold a matching settlement? (idempotency guard for execution)
    const txSnap = provider
      ? await db.collection('walletTransactions').doc(settleTxId(provider, bookingId)).get()
      : { exists: false };
    const hasSettlement = txSnap.exists;

    // Booking completion evidence
    let completedAt = null, bookingStatus = null, bookingExists = false;
    const bSnap = await db.collection('providerBookings').doc(bookingId).get();
    if (bSnap.exists) {
      bookingExists = true;
      const b = bSnap.data();
      bookingStatus = b.status || null;
      completedAt = b.completedAt && b.completedAt.toDate ? b.completedAt.toDate().toISOString() : null;
    }

    // Classify — only a completed booking with no existing settlement is creditable.
    let disposition, proposedCreditShillings, proposedPayoutUpdate;
    if (hasSettlement) {
      disposition = 'already-settled'; alreadySettled++;
      proposedCreditShillings = 0; proposedPayoutUpdate = 'mark settled (credit already exists) — no wallet write';
    } else if (!bookingExists) {
      disposition = 'ANOMALY: booking missing'; missingBooking++;
      proposedCreditShillings = 0; proposedPayoutUpdate = 'REVIEW — do not auto-credit';
    } else if (bookingStatus !== 'completed') {
      disposition = `ANOMALY: booking status=${bookingStatus}`; notCompleted++;
      proposedCreditShillings = 0; proposedPayoutUpdate = 'REVIEW — do not auto-credit';
    } else {
      disposition = 'creditable'; creditable++;
      proposedCreditShillings = proposedShillings; totalProposedShillings += proposedShillings;
      proposedPayoutUpdate = 'status: pending -> settled  + credit wallet.balance + write walletTransactions';
    }

    totalNetCents += netCents;
    rows.push({
      bookingId, provider, completedAt, payoutStatus: p.status, netCents,
      hasSettlement, disposition, proposedCreditShillings, proposedPayoutUpdate,
    });
  }

  if (asJson) { console.log(JSON.stringify({ generatedFrom: 'providerPayouts.status==pending', count: rows.length, rows }, null, 2)); }
  else {
    console.log('\n=== LEGACY PROVIDER-PAYOUT RECONCILIATION — DRY RUN (no writes) ===\n');
    if (!rows.length) console.log('No `pending` providerPayouts found — nothing to reconcile.');
    else {
      const pad = (s, n) => String(s == null ? '' : s).slice(0, n).padEnd(n);
      console.log(pad('bookingId', 26), pad('provider', 14), pad('completedAt', 22), pad('net¢', 8), pad('settled?', 9), pad('disposition', 26), 'proposedCredit(KSh)');
      console.log('-'.repeat(130));
      for (const r of rows) {
        console.log(pad(r.bookingId, 26), pad(r.provider, 14), pad(r.completedAt || '—', 22),
          pad(r.netCents, 8), pad(r.hasSettlement ? 'yes' : 'no', 9), pad(r.disposition, 26), r.proposedCreditShillings);
      }
    }
    console.log('\n--- SUMMARY ---');
    console.log(`  pending payout rows:          ${rows.length}`);
    console.log(`  creditable (safe to backfill):${creditable}`);
    console.log(`  already settled (skip):       ${alreadySettled}`);
    console.log(`  ANOMALY booking missing:      ${missingBooking}`);
    console.log(`  ANOMALY not completed:        ${notCompleted}`);
    console.log(`  total net across rows:        ${(totalNetCents / 100).toFixed(2)} KSh`);
    console.log(`  proposed wallet credit total: ${totalProposedShillings} KSh (creditable rows only, floored)`);
    console.log('\nDRY RUN — no documents were written. Backfill execution requires explicit approval.\n');
  }
  process.exit(0);
})().catch((e) => { console.error('dry-run error:', e && e.stack || e); process.exit(1); });
