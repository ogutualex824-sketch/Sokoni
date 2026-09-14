'use strict';
/* ════════════════════════════════════════════════════════════════════════════════════════════
   WHICH POS SALE IS THIS INTASEND CALLBACK TALKING ABOUT?

   One question, and deliberately only one. This module decides whether an IntaSend callback
   can be ASSOCIATED with a POS QR sale, and what metadata that association records. It does
   NOT decide whether the sale is paid, and it structurally cannot: `status` is on a forbidden
   list that `associationFor` enforces against its own output before returning.

   ── WHY THIS EXISTS ───────────────────────────────────────────────────────────────────────
   Both IntaSend webhooks key on `api_ref` and look up `payments/{apiRef}`. A POS QR sale's
   record lives in `posPayments/{apiRef}`, which neither handler knows about, so the callback
   is acknowledged and DROPPED. Nothing is created and nothing is corrupted — it fails closed —
   but the POS and the customer's `pay.html` learn nothing, and both sit waiting.

   This is a LATENCY AND UX improvement, not an integrity repair. P1
   (`completePOSQRPayment` → `shared/intasend-verify.js`) obtains authoritative association by
   querying IntaSend directly on `api_ref`; it does not need to be told. Association only lets
   the screens find out sooner.

   ── THE LINE THIS MODULE MUST NEVER CROSS ─────────────────────────────────────────────────
   A webhook that could set `paid` would reintroduce exactly the trust hole P1 closed, by a
   different door. The callback says WHICH sale; the server already owns WHAT IT COSTS and WHO
   IT BELONGS TO, both written at QR creation from validated items and `auth.uid`. Nothing here
   reads an amount or a seller from the callback body, so a hostile or malformed callback can
   name a transaction — and that is the whole of its power.

   ── WHY IT IS PURE ────────────────────────────────────────────────────────────────────────
   No Firestore, no admin SDK, no network, no clock. The caller reads the document, calls this,
   and writes what comes back. That makes every decision here testable without a database, and
   makes it impossible for this file to perform a write it was not asked to describe.

   The one `require` is a sibling pure module, for the rail discriminator. Duplicating that
   logic would create a SECOND definition of "which rail wrote this document", and the two
   would drift. There is one.
   ════════════════════════════════════════════════════════════════════════════════════════════ */

const _ownership = require('./pos-payment-ownership');

/**
 * A QR transactionId is `crypto.randomBytes(16).toString('hex')` — 32 lowercase hex characters,
 * with NO prefix (pos-qr.js `_txnId`). Unlike `wtop_…` and `pout_…` there is nothing to match a
 * prefix against, so this shape test is the pre-filter.
 *
 * It is a SAFETY property, not an optimisation: it makes it structurally impossible for a
 * wallet top-up or a B2C payout reference to enter the POS association path, even if the
 * dispatch order in the webhook were ever changed.
 */
const QR_REF = /^[0-9a-f]{32}$/;

/** The gateway's terminal success state. Recorded, never acted upon. */
const GATEWAY_COMPLETE = 'COMPLETE';

/** The field the caller must apply as an increment; named here so the four live in one place. */
const COUNT_FIELD = 'gatewayCallbackCount';

/**
 * The ONLY fields an association may write. Anything outside this set is a defect, and
 * `associationFor` refuses its own output rather than trusting itself to have got it right.
 */
const ALLOWED_FIELDS = Object.freeze([
  'gatewayInvoiceId',
  'gatewayState',
  'gatewayNotifiedAt',
  COUNT_FIELD,
]);

/**
 * Fields that would turn association into settlement. Listed explicitly so the prohibition is
 * executable rather than a comment somebody has to remember to honour.
 */
const FORBIDDEN_FIELDS = Object.freeze([
  'status', 'paidAt', 'orderId', 'receiptId', 'paymentMethod',
  'total', 'subtotal', 'paidAmount', 'gatewayAmount', 'sellerId', 'sellerUid',
  'mpesaRef', 'intasendRef',
]);

/** Is this `api_ref` even shaped like a POS QR transactionId? */
function isQrRef(apiRef) {
  return typeof apiRef === 'string' && QR_REF.test(apiRef);
}

const refuse = (reason, message) => ({ associate: false, reason, message });

/**
 * May this callback be associated with this POS sale, and what should be recorded?
 *
 * @param {object} pay  the `posPayments/{apiRef}` document, as read by the caller. Never the
 *                      callback body.
 * @param {object} cb   { state, gatewayInvoiceId, receivedAt } — the only three things taken
 *                      from the callback, and none of them is money, a seller or an order.
 * @returns {{associate:true, rail:string, fields:object, monotonicHold:boolean}
 *          |{associate:false, reason:string, message:string}}
 *
 * NEVER throws. NEVER writes. NEVER returns a forbidden field.
 */
function associationFor(pay, cb) {
  const c = cb || {};

  if (!pay || typeof pay !== 'object') {
    return refuse('no_document', 'No POS sale exists for that reference.');
  }

  /* Same discriminator the ownership authority uses — `transactionId` for the QR rail,
     `checkoutId` for the retired Daraja rail. One implementation, so they cannot diverge. */
  const rail = _ownership.classifyRail(pay);
  if (rail === 'daraja') {
    return refuse('legacy_daraja_document',
      'That reference belongs to a retired Daraja payment; IntaSend cannot be associated with it.');
  }
  if (rail !== 'qr') {
    /* Neither rail, or carrying BOTH discriminators. A document nobody's writer produces is
       not a document to guess about. */
    return refuse('unknown_shape', 'That payment record cannot be identified.');
  }

  const state = String(c.state || '').trim().toUpperCase();
  if (!state) {
    return refuse('no_state', 'The callback carried no state to record.');
  }

  /* ── MONOTONIC ──────────────────────────────────────────────────────────────────────────
     IntaSend retries on timeout and 5xx, and delivery is NOT ordered: a FAILED can arrive
     after a COMPLETE. Association may record that a gateway transaction exists; it must never
     walk a sale's recorded gateway state backwards out of a success. */
  const prior = String(pay.gatewayState || '').trim().toUpperCase();
  const monotonicHold = prior === GATEWAY_COMPLETE && state !== GATEWAY_COMPLETE;

  const invoiceId = (typeof c.gatewayInvoiceId === 'string' && c.gatewayInvoiceId.length)
    ? c.gatewayInvoiceId
    : null;

  const fields = {
    gatewayInvoiceId:  invoiceId,
    gatewayState:      monotonicHold ? prior : state,
    gatewayNotifiedAt: c.receivedAt != null ? c.receivedAt : null,
  };

  /* Refuse our own output rather than trust it. If a future edit adds a field here, this
     throws the whole association away instead of quietly writing it. */
  for (const k of Object.keys(fields)) {
    if (FORBIDDEN_FIELDS.indexOf(k) > -1 || ALLOWED_FIELDS.indexOf(k) < 0) {
      return refuse('forbidden_field', 'Association attempted to write a field it may not write: ' + k);
    }
  }

  return { associate: true, rail, fields, monotonicHold };
}

module.exports = {
  associationFor,
  isQrRef,
  COUNT_FIELD,
  ALLOWED_FIELDS,
  FORBIDDEN_FIELDS,
  GATEWAY_COMPLETE,
};
