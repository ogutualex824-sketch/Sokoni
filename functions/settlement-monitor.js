'use strict';
/* ============================================================================
   SOKONI — Settlement Convergence Monitor  functions/settlement-monitor.js
   Phase C observability (docs/BOOKING_CONVERGENCE.md).

   Phase C made booking completion terminate in an exactly-once wallet
   settlement. This module measures that the three counts stay convergent, so a
   divergence becomes an operational ALERT instead of an archaeological dig.

   All metrics are single-field-equality `.count()` aggregations (auto-indexed,
   cheap, no composite index to manage). The invariants are written to survive
   LEGACY data — pre-Phase-C completions left `pending` payouts, and zero/sub-
   shilling settlements legitimately have no wallet transaction — so neither of
   those trips an alert.

   Base counts:
     A completedBookings            providerBookings.status == 'completed'
     B settledPayouts               providerPayouts.status  == 'settled'
     C legacyPendingPayouts         providerPayouts.status  == 'pending'   (pre-C; declines to 0)
     D paidPayouts                  providerPayouts.status  == 'paid'      (legacy mechanism-1)
     E bookingWalletTransactions    walletTransactions.type == 'booking_earning'

   Hard invariants (either != 0 → anomaly → alert):
     completedWithoutPayout = A - (B + C + D)   every completion has exactly one payout row
     walletTxExceedsSettled = max(0, E - B)     never more credits than settlements (no dup/orphan)
   Informational (expected non-negative, not alerts):
     settledUncredited      = max(0, B - E)     settled rows with zero/sub-shilling net (no txn)
     legacyPendingPayouts   = C                 backlog awaiting the approved reconciliation
   ========================================================================== */

/**
 * Compute the settlement-convergence snapshot. Pure read (5 count aggregations).
 * @param {FirebaseFirestore.Firestore} db
 * @returns {Promise<object>} snapshot with base counts, derived indicators, and `healthy`/`anomalies`
 */
async function computeSettlementConvergence(db) {
  const [completed, settled, pending, paid, walletTx] = await Promise.all([
    db.collection('providerBookings').where('status', '==', 'completed').count().get(),
    db.collection('providerPayouts').where('status', '==', 'settled').count().get(),
    db.collection('providerPayouts').where('status', '==', 'pending').count().get(),
    db.collection('providerPayouts').where('status', '==', 'paid').count().get(),
    db.collection('walletTransactions').where('type', '==', 'booking_earning').count().get(),
  ]);

  const A = completed.data().count;
  const B = settled.data().count;
  const C = pending.data().count;
  const D = paid.data().count;
  const E = walletTx.data().count;

  const completedWithoutPayout = A - (B + C + D);
  const walletTxExceedsSettled = Math.max(0, E - B);
  const settledUncredited      = Math.max(0, B - E);

  const anomalies = [];
  if (completedWithoutPayout !== 0) {
    anomalies.push(`completedWithoutPayout=${completedWithoutPayout} (a completed booking is missing its payout row)`);
  }
  if (walletTxExceedsSettled > 0) {
    anomalies.push(`walletTxExceedsSettled=${walletTxExceedsSettled} (more booking_earning txns than settled payouts — possible duplicate/orphan credit)`);
  }

  return {
    // base counts
    completedBookings:          A,
    settledPayouts:             B,
    legacyPendingPayouts:       C,
    paidPayouts:                D,
    bookingWalletTransactions:  E,
    // derived
    completedWithoutPayout,     // hard invariant: 0
    walletTxExceedsSettled,     // hard invariant: 0
    settledUncredited,          // informational
    // verdict
    healthy: anomalies.length === 0,
    anomalies,
  };
}

module.exports = { computeSettlementConvergence };
