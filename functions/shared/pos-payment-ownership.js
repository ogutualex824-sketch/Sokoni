'use strict';
/* ════════════════════════════════════════════════════════════════════════════════════════════
   MAY THIS RECORDED PAYMENT SETTLE THIS SALE, FOR THIS SHOP?

   One question, asked of a `posPayments` document that already exists. This module decides
   NOTHING about money: it creates no state, marks nothing paid, and writes nothing at all. It
   answers whether a payment the server has already recorded may be attached to a sale being
   confirmed at a till — and refuses when it cannot tell.

   ── WHY IT IS A MODULE ────────────────────────────────────────────────────────────────────
   The consumer that needs it — the confirm path in `pos-zero-friction.js` — currently exists
   only as ANOTHER AGENT'S UNCOMMITTED WORK. Its 287-line block is a pure insertion with no
   corresponding line in HEAD, so there is no patch that can carry a fix to it without also
   carrying their unfinished code. Putting the decision here makes it committable, certifiable
   and reviewable on its own, and leaves the wiring as a one-line change whoever owns that file
   can make when their work lands.

   ── THE TWO DEFECTS THIS EXISTS TO CLOSE ──────────────────────────────────────────────────
   1. OWNERSHIP COULD VANISH. The consumer guards its shop check with `if (pay.sellerUid && …)`.
      A QR document carries `sellerId`, not `sellerUid`, so the condition is false and THE WHOLE
      CHECK IS SKIPPED — any shop could confirm against another shop's payment. A check that
      silently does nothing when its field is missing is worse than no check, because it reads
      as one. Here an owner that cannot be established is a REFUSAL.

   2. THE SUCCESS STATE WAS THE WRONG RAIL'S. The consumer requires `completed`, which only
      `darajaSTKCallback` ever wrote. Daraja is retired outbound (D1), so no new document can
      ever reach that status and the check would refuse every till payment forever. The QR rail
      spells the same state `paid`, and reaches it only through `completePOSQRPayment`, which
      verifies with IntaSend server-side (P1).

   ── AND ONE THING THAT IS DELIBERATELY STRICTER ───────────────────────────────────────────
   A LEGACY DARAJA DOCUMENT IS NOT A PAYMENT FOR A NEW SALE, even one reading `completed`.
   Those 13 records are historical sandbox traffic; treating one as settlement for a sale being
   rung up today would let an old reference be pasted in to close a new sale. My first draft of
   this fix accepted `{completed, paid}` as interchangeable — that was wrong, and this refuses
   the legacy rail outright.
   ════════════════════════════════════════════════════════════════════════════════════════════ */

/** The QR rail's terminal success state. Daraja's `completed` is NOT a synonym here. */
const QR_PAID = 'paid';

/** Every state the QR rail may write. Anything else is not a QR document. */
const QR_STATUSES = Object.freeze(['pending', 'paid', 'expired', 'cancelled', 'refunded']);

/**
 * Which rail wrote this document?
 *
 * Discriminated by the field each writer sets and the other never does — `transactionId` for the
 * IntaSend QR rail, `checkoutId` for the retired Daraja rail. Not by status, which overlaps on
 * `pending`, and not by presence of money fields, which both carry.
 */
function classifyRail(pay) {
  if (!pay || typeof pay !== 'object') return 'unknown';
  const hasQr = typeof pay.transactionId === 'string' && pay.transactionId.length > 0;
  const hasDaraja = typeof pay.checkoutId === 'string' && pay.checkoutId.length > 0;
  if (hasQr && !hasDaraja) return 'qr';
  if (hasDaraja && !hasQr) return 'daraja';
  /* Both, or neither. A document carrying both discriminators is not something either writer
     produces, so it is not something to guess about. */
  return 'unknown';
}

/** The shop a QR document belongs to. Daraja used `sellerUid`; the QR rail uses `sellerId`. */
function ownerOf(pay) {
  if (!pay || typeof pay !== 'object') return null;
  const o = pay.sellerId || pay.sellerUid || null;
  return (typeof o === 'string' && o.length > 0) ? o : null;
}

const refuse = (reason, message) => ({ ok: false, reason, message });

/**
 * May this payment settle this sale?
 *
 * @param {object} pay          the posPayments document, as read by the caller
 * @param {object} actor        { merchantId, cashierId } — identities the caller already resolved
 * @returns {{ok:true, rail:string, owner:string, amount:number|null}
 *          |{ok:false, reason:string, message:string}}
 *
 * NEVER throws: the caller owns its own error shape. NEVER writes.
 */
function assertConfirmable(pay, actor) {
  const a = actor || {};
  if (!pay || typeof pay !== 'object') {
    return refuse('no_document', 'No payment was found for this sale. Nothing has been charged.');
  }

  const rail = classifyRail(pay);

  if (rail === 'daraja') {
    /* Historical only. Daraja is retired outbound, so a document on that rail cannot be a
       payment for a sale being confirmed now — whatever status it carries. */
    return refuse('legacy_daraja_document',
      'That reference belongs to a retired M-PESA Daraja payment and cannot settle this sale.');
  }
  if (rail !== 'qr') {
    return refuse('unknown_shape',
      'That payment record cannot be identified, so it cannot be confirmed.');
  }

  /* ── Ownership BEFORE status: an unauthorised caller should learn nothing about the state of
     a payment belonging to someone else. */
  const owner = ownerOf(pay);
  if (!owner) {
    return refuse('no_owner',
      'That payment record does not identify which shop it belongs to, so it cannot be confirmed.');
  }
  if (owner !== a.merchantId && owner !== a.cashierId) {
    return refuse('wrong_shop', 'That payment belongs to a different shop.');
  }

  const status = String(pay.status || '');
  if (status !== QR_PAID) {
    return refuse('not_paid',
      'The customer has not completed this payment yet (' + (status || 'pending') + '). '
      + 'Wait for their confirmation, or try the payment again.');
  }

  /* The figure the GATEWAY reported, where P1 recorded one. `total` is the sale as priced by the
     server at QR creation; neither is ever taken from a caller. Returned for the caller's own
     sufficiency check — this module does not decide whether it is enough, because only the
     caller knows what the sale is claiming. */
  const amount = Number(
    pay.gatewayAmount != null ? pay.gatewayAmount
      : (pay.paidAmount != null ? pay.paidAmount : pay.total)
  );

  return { ok: true, rail, owner, amount: Number.isFinite(amount) ? amount : null };
}

module.exports = { assertConfirmable, classifyRail, ownerOf, QR_PAID, QR_STATUSES };
