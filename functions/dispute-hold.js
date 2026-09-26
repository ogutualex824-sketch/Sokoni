'use strict';
/**
 * SOKONI — DISPUTE SETTLEMENT HOLD
 * functions/dispute-hold.js
 *
 * ── THE DEFECT ──────────────────────────────────────────────────────────────────────────
 * The auto-confirm sweep skipped orders carrying `disputeOpen` or `hasDispute` — fields NOTHING
 * ever wrote — and settleOrder checked no dispute at all. So opening a dispute paused nothing:
 * a disputed order was still auto-completed and its seller still settled.
 *
 * ── THE RULE ────────────────────────────────────────────────────────────────────────────
 *     OPEN DISPUTE  →  NO AUTO-CONFIRM  →  NO SELLER SETTLEMENT
 *
 * THE AUTHORITY IS THE DISPUTE RECORD, not a flag on the order. `disputes/dp_{orderId}` is written
 * only by the server (served rules: client create = false; a buyer may update `evidence` only), and
 * it is read INSIDE the settlement and auto-confirm transactions, so a dispute opened concurrently
 * either lands first and is honoured, or lands after a settlement that genuinely preceded it.
 * The order's `disputeHold` field is a MIRROR for display — nothing decides money from it, so a
 * forged or stale mirror can neither create nor lift a hold.
 *
 * A hold is ACTIVE when the dispute belongs to this order and either
 *     its status is open / investigating / seller_responded, or
 *     settlementHold === 'HELD'     (a resolved dispute whose release has not been granted)
 *
 * RELEASE IS EXPLICIT AND FAIL-CLOSED. A buyer withdrawing the dispute releases it. An admin
 * resolution is free text — the system cannot tell "the seller was right" from "the buyer was
 * refunded" — so resolving or closing keeps the hold unless the admin passes
 * `releaseSettlement: true`. A held completed order is then settled by `resumeSettlement`,
 * because nothing else re-enters settleOrder after its one trigger has fired.
 *
 * LIMIT, stated so it is not mistaken for coverage: a webhook-collected order credits its seller
 * AT PAYMENT (settlementStatus "settled"). There is no later settlement to pause; its funds are
 * governed by the refund authority, not by this hold.
 */

const OPEN_STATUSES = Object.freeze(['open', 'investigating', 'seller_responded']);
const HOLD = Object.freeze({ HELD: 'HELD', RELEASED: 'RELEASED' });
const SETTLEMENT_NOTE = 'dispute_open';

function disputeIdFor(orderId) { return 'dp_' + String(orderId); }
function disputeRef(db, orderId) { return db.collection('disputes').doc(disputeIdFor(orderId)); }

/** Is settlement of `orderId` held by this dispute document? Pure. */
function holdActive(dispute, orderId) {
  if (!dispute) return false;
  if (dispute.orderId !== undefined && String(dispute.orderId) !== String(orderId)) return false;
  if (dispute.settlementHold === HOLD.HELD) return true;
  if (dispute.settlementHold === HOLD.RELEASED) return false;
  return OPEN_STATUSES.includes(dispute.status);          /* legacy disputes: open == held */
}

/** The display mirror written onto the order alongside every hold change. */
function orderMirror(FieldValue, active, disputeId) {
  return { disputeHold: { active: !!active, disputeId: disputeId || null, updatedAt: FieldValue.serverTimestamp() } };
}

/**
 * After a hold is released: a completed order that settlement parked on this dispute is settled
 * now. Anything else carries on through its normal lifecycle (the status trigger / sweep).
 * settleOrder re-checks the hold inside its own transaction, so a re-opened dispute still wins.
 */
async function resumeSettlement(db, adminSdk, orderId) {
  const snap = await db.collection('orders').doc(String(orderId)).get();
  if (!snap.exists) return { outcome: 'no-order' };
  const o = snap.data() || {};
  if (o.status !== 'completed' || o.settlementNote !== SETTLEMENT_NOTE) return { outcome: 'not-parked-on-dispute' };
  return require('./order-settlement').settleOrder(db, adminSdk, String(orderId));
}

module.exports = { OPEN_STATUSES, HOLD, SETTLEMENT_NOTE, disputeIdFor, disputeRef, holdActive, orderMirror, resumeSettlement };
