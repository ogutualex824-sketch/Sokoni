'use strict';
/* ============================================================================
   SOKONI — Settlement Convergence Report (on-demand, READ-ONLY)
   docs/BOOKING_CONVERGENCE.md — Phase C observability.

   Prints the same convergence snapshot the scheduled monitor writes
   (systemHealth/settlementConvergence), for a manual/CI/cron check. Reads only.
   Exits 0 when healthy, 2 when an anomaly is detected — so it can gate a cron
   alert without any dashboard.

   Prod (ADC):   node scripts/settlement-convergence-report.js
   Emulator:     FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 GCLOUD_PROJECT=demo-sokoni \
                   node scripts/settlement-convergence-report.js
   ========================================================================== */
const path = require('path');
const admin = require(path.join(__dirname, '..', 'functions', 'node_modules', 'firebase-admin'));
if (!admin.apps.length) admin.initializeApp();
const { computeSettlementConvergence } = require(path.join(__dirname, '..', 'functions', 'settlement-monitor'));

(async () => {
  const s = await computeSettlementConvergence(admin.firestore());
  console.log('\n=== SETTLEMENT CONVERGENCE ===\n');
  console.log(`  completed bookings          : ${s.completedBookings}`);
  console.log(`  settled payouts             : ${s.settledPayouts}`);
  console.log(`  booking wallet transactions : ${s.bookingWalletTransactions}`);
  console.log(`  legacy pending payouts      : ${s.legacyPendingPayouts}   (should decline toward 0)`);
  console.log(`  paid payouts (legacy)       : ${s.paidPayouts}`);
  console.log('  --- derived ---');
  console.log(`  completedWithoutPayout      : ${s.completedWithoutPayout}   (invariant: 0)`);
  console.log(`  walletTxExceedsSettled      : ${s.walletTxExceedsSettled}   (invariant: 0)`);
  console.log(`  settledUncredited           : ${s.settledUncredited}   (zero/sub-shilling — informational)`);
  console.log(`\n  STATUS: ${s.healthy ? 'HEALTHY ✅' : 'ANOMALY ⚠️  ' + s.anomalies.join(' | ')}\n`);
  process.exit(s.healthy ? 0 : 2);
})().catch((e) => { console.error('report error:', e && e.stack || e); process.exit(1); });
