'use strict';
/**
 * SOKONI — initiateRefund: the escrow must belong to the order it is used to refund.
 * functions/refund-escrow-binding.js
 *
 * ── THE DEFECT (docs/REFUND_AFTER_WEBHOOK_CREDIT_INVESTIGATION.md, "Also found") ─────────────
 * initiateRefund's escrow path proved ONE relationship — the caller owns the escrow — and then
 * applied the refund to whatever `orderId` the caller also passed. Nothing tied the two together.
 * Anyone holding ANY escrow could therefore name ANOTHER seller's order: the order was marked
 * REFUNDED (blocking its settlement) and a refunds record was filed against it.
 *
 * ── THE RULE ────────────────────────────────────────────────────────────────────────────────
 * When a request names both an escrow and an order, TWO relationships must hold before anything is
 * written:
 *     caller owns the escrow          (buyer on the escrow, or an admin)
 *     AND the escrow belongs to the requested order
 * The second applies to admins too: an admin naming a mismatched pair is a data error, not a
 * privilege. An admin who means to act on an order alone uses the orderId-only path.
 *
 * WHICH FIELD NAMES THE ORDER. Escrows are written by finos-router with `transactionId` (the order
 * id it was created for); releaseEscrow reads `orderId`. Both are accepted. If both are present
 * they must agree — two different answers is a refusal, not a choice. If neither is present the
 * relationship cannot be established, and the request is refused.
 *
 * Pure: the caller loads the escrow and passes it in. Returns a refusal description or null; it
 * never writes and never throws.
 */

const REASON = Object.freeze({
  NOT_ESCROW_OWNER:       'caller-does-not-own-escrow',
  ESCROW_NAMES_NO_ORDER:  'escrow-names-no-order',
  ESCROW_ORDER_CONFLICT:  'escrow-names-two-different-orders',
  ESCROW_ORDER_MISMATCH:  'escrow-belongs-to-a-different-order',
});

function escrowOrderRef(escrow) {
  const e = escrow || {};
  const a = e.orderId != null && String(e.orderId) !== '' ? String(e.orderId) : null;
  const b = e.transactionId != null && String(e.transactionId) !== '' ? String(e.transactionId) : null;
  if (a && b && a !== b) return { conflict: true, orderId: a, transactionId: b };
  return { ref: a || b || null };
}

/**
 * @returns {null | { code, reason, message }}   null = both relationships established
 */
function checkEscrowRefundAuthority({ escrow, orderId, callerUid, isAdmin }) {
  if (!isAdmin && (!callerUid || String(callerUid) !== String((escrow || {}).buyerId || ''))) {
    return { code: 'permission-denied', reason: REASON.NOT_ESCROW_OWNER,
      message: 'Only the buyer or admin can request a refund.' };
  }
  if (orderId === undefined || orderId === null || orderId === '') return null;   /* no order is touched */
  const r = escrowOrderRef(escrow);
  if (r.conflict) {
    return { code: 'failed-precondition', reason: REASON.ESCROW_ORDER_CONFLICT,
      message: 'This escrow names two different orders; it cannot authorise a refund until repaired.' };
  }
  if (!r.ref) {
    return { code: 'failed-precondition', reason: REASON.ESCROW_NAMES_NO_ORDER,
      message: 'This escrow does not record which order it belongs to; it cannot authorise an order refund.' };
  }
  if (r.ref !== String(orderId)) {
    return { code: 'permission-denied', reason: REASON.ESCROW_ORDER_MISMATCH,
      message: 'This escrow does not belong to the requested order.' };
  }
  return null;
}

module.exports = { REASON, escrowOrderRef, checkEscrowRefundAuthority };
