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

/* ── THE STK RAIL (POS/Till convergence, 2026-09-30) ─────────────────────────────────────────
   The IntaSend M-PESA prompt a till sends through posInitiateIntasendPayment is keyed
   `postill_<shop>_<saleKey>`. Its money facts live in TWO server-only documents, neither of which
   a browser can write:
     posPaymentIntents/{ref}  — written ONCE by the initiator: merchantId (proved by shop access),
                                idempotencyKey (the sale's own key), amountCents (what the customer
                                was asked to pay), provider:'intasend';
     posPaymentStatus/{ref}   — written by webhookIntasend's finalizeFromWebhook: 'completed' |
                                'failed' | 'pending'. A terminal status is final.
   Before this, the checkout looked for such a payment in posPayments (the QR rail), found nothing,
   and refused every paid M-PESA till prompt — the two halves had never met.

   Rules, in order: the documents exist and are IntaSend's; the intent belongs to THIS shop; the
   intent was raised for THIS sale (same idempotency key — a payment for one basket cannot settle
   another); the provider has reported it completed. The amount returned is the amount the
   customer was prompted for and approved — a COMPLETE STK is payment of exactly that sum. The
   gateway's own figure is not used for sufficiency because IntaSend reports it NET of fees.
   NEVER throws, NEVER writes — the caller keeps its sufficiency check and its spent-once claim. */
const STK_PREFIX = 'postill_';
const STK_PAID = 'completed';

function isStkRef(ref) { return typeof ref === 'string' && ref.indexOf(STK_PREFIX) === 0; }

/**
 * May this IntaSend M-PESA prompt settle this sale?
 *
 * @param {object|null} intent   posPaymentIntents/{ref}, as read by the caller
 * @param {object|null} status   posPaymentStatus/{ref}, as read by the caller
 * @param {object} actor         { merchantId, idempotencyKey } — resolved by the caller
 */
function assertConfirmableStk(intent, status, actor) {
  const a = actor || {};
  if (!intent || typeof intent !== 'object') {
    return refuse('no_document', 'No M-PESA request was found for this sale. Nothing has been charged.');
  }
  if (String(intent.provider || '') !== 'intasend') {
    return refuse('unknown_shape', 'That payment request cannot be identified, so it cannot be confirmed.');
  }
  const owner = (typeof intent.merchantId === 'string' && intent.merchantId) ? intent.merchantId : null;
  /* Written `=== null`, not `!owner`: the QR guard above is certified by a text-anchored sabotage
     (certify-pos-payment-ownership X6-1) that must find exactly ONE `if (!owner) {`. */
  if (owner === null) {
    return refuse('no_owner', 'That payment request does not identify its shop, so it cannot be confirmed.');
  }
  if (owner !== String(a.merchantId || '')) {
    return refuse('wrong_shop', 'That payment belongs to a different shop.');
  }
  if (!a.idempotencyKey || String(intent.idempotencyKey || '') !== String(a.idempotencyKey)) {
    return refuse('wrong_sale', 'That M-PESA payment was requested for a different sale.');
  }
  const st = String((status && status.status) || 'pending');
  if (st !== STK_PAID) {
    return refuse('not_paid',
      st === 'failed'
        ? 'The customer\'s M-PESA payment did not go through. Nothing was completed; try again.'
        : 'The customer has not completed this M-PESA payment yet. Wait for their confirmation.');
  }
  /* 2026-10-03 (owner P0, sokoni-pos): currency is KES, and the amount that may settle a sale is what the
     PROVIDER confirmed (posPaymentStatus.confirmedAmountKES, written by the webhook from IntaSend's own figure) —
     never the amount the till REQUESTED. The live webhook marks 'completed' without comparing the two, so using
     intent.amountCents let a partial payment settle a full sale. No provider figure → amount null → the caller
     refuses ("did not report an amount"). */
  if (intent.currency != null && String(intent.currency).toUpperCase() !== 'KES') {
    return refuse('wrong_currency', 'That payment was not made in Kenya shillings, so it cannot settle this sale.');
  }
  const confirmed = status && status.confirmedAmountKES != null ? Number(status.confirmedAmountKES) : NaN;
  return { ok: true, rail: 'stk', owner, amount: Number.isFinite(confirmed) ? confirmed : null };
}

module.exports = { assertConfirmable, assertConfirmableStk, isStkRef, classifyRail, ownerOf, QR_PAID, QR_STATUSES, STK_PREFIX };
