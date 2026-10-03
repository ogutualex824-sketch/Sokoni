'use strict';
/**
 * WITHDRAWAL GATE — the ONE switch every route that sends money OUT to a seller/provider honours (owner 2026-10-03).
 *
 * Withdrawals stay OFF while the payout-PIN work is open: the PIN is advisory and the external-draw check has open issues.
 * The disabled UI is not the control; the server is. Every money mover reads THIS gate:
 *   wallet.requestSellerPayout · wallet.processPayoutRetries · finos.processPendingPayouts ·
 *   automation-engine.autoScheduledPayouts · index.initiateSellerPayout
 * Reconciliation that only inspects or flags in-flight requests (wallet.reconcilePayouts) does not move money and is not gated.
 *
 * OPEN only when platformConfig/withdrawals { enabled: true } — written deliberately (super-admin rules; no endpoint toggles
 * it). Absent, false, any non-boolean value, or an unreadable flag → CLOSED (fail closed).
 */
async function withdrawalsOpen(db) {
  try {
    const s = await db.collection('platformConfig').doc('withdrawals').get();
    return !!(s && s.exists && (s.data() || {}).enabled === true);
  } catch (_) { return false; }
}

const CLOSED_MESSAGE = 'Withdrawals are not available yet. Your balance is safe and remains in your SOKONI wallet.';

module.exports = { withdrawalsOpen, CLOSED_MESSAGE };
