'use strict';

/**
 * SOKONI CREATOR SETTLEMENT AUTHORITY
 * ────────────────────────────────────────────────────────────────────────────
 * Given a content purchase and the provider's confirmation that it was paid, decide what
 * the creator is owed and under what reference. It decides; it does not persist, and it
 * does not move money — the caller takes this plan to `creator-earning-destination`.
 *
 * Pure, like every other authority on this branch, because the interesting failures are
 * arithmetic and identity ones and those must be testable without a database.
 *
 * ── IT DOES NOT PRICE ────────────────────────────────────────────────────────
 * The commission is computed by the ONE Commission Engine and arrives here as a number of
 * cents. This module checks it is a possible number and refuses when it is not; it never
 * derives a rate, applies a floor, or invents a fee. A second place that knows the
 * commission rate is a second commission rate.
 *
 * ── WHAT IT REFUSES ──────────────────────────────────────────────────────────
 * Every refusal below is a way money reaches the wrong trader, the wrong title, or the
 * right one twice:
 *
 *   CROSS_TITLE      the purchase and the listing are different works
 *   CROSS_CREATOR    the purchase names a creator the listing does not
 *   ALREADY_SETTLED  this purchase has been paid out once already
 *   NOT_CONFIRMED    nobody has proven the buyer paid
 *   AMOUNT_MISMATCH  the provider collected something other than the price
 *   SELF_PURCHASE    the creator is the buyer
 *   BAD_COMMISSION   the split does not add up
 *
 * The reference is derived from the purchase id alone, so a replay through any entry point
 * addresses the wallet entry that already exists. Two entry points deriving it differently
 * is how one purchase pays twice.
 */

const REASON = Object.freeze({
  NO_PURCHASE:     'NO_PURCHASE',
  NO_LISTING:      'NO_LISTING',
  NO_CONFIRMATION: 'NO_CONFIRMATION',
  NO_CREATOR:      'NO_CREATOR',
  CROSS_TITLE:     'CROSS_TITLE',
  CROSS_CREATOR:   'CROSS_CREATOR',
  ALREADY_SETTLED: 'ALREADY_SETTLED',
  NOT_CONFIRMED:   'NOT_CONFIRMED',
  AMOUNT_MISMATCH: 'AMOUNT_MISMATCH',
  SELF_PURCHASE:   'SELF_PURCHASE',
  BAD_AMOUNT:      'BAD_AMOUNT',
  BAD_COMMISSION:  'BAD_COMMISSION',
});

/* The provider states that mean money actually arrived. Anything else — PENDING,
   PROCESSING, FAILED, or a state this platform has never seen — is not payment. Listing
   the successes rather than the failures is deliberate: an unknown state must read as
   "not paid", and a blocklist would read a new one as paid. */
const CONFIRMED_STATES = Object.freeze(['COMPLETE', 'COMPLETED', 'PAID', 'SUCCESS', 'SUCCESSFUL']);

/** A purchase that has reached any of these has already had its money sent somewhere. */
const SETTLED_STATES = Object.freeze(['completed', 'settled', 'refunded', 'reversed']);

function refuse(reason, detail) {
  return { ok: false, reason, detail: detail == null ? null : detail };
}

function isConfirmed(state) {
  return CONFIRMED_STATES.indexOf(String(state || '').toUpperCase()) !== -1;
}

/** Deterministic and derived from the purchase alone — the whole idempotency rests on it. */
function settlementRef(purchaseId) {
  return 'ppv_' + String(purchaseId || '').trim();
}

function intOrNull(v) {
  const n = Number(v);
  return Number.isInteger(n) ? n : null;
}

/**
 * THE PLAN, or the reason there isn't one.
 *
 * @param {object} o.purchase     the entertainmentPurchases document
 * @param {object} o.listing      the entertainmentListings document it claims to be for
 * @param {object} o.confirmation the provider's record: { state, amountMinor, providerRef }
 */
function settlementFor(o) {
  const i = o || {};
  const purchase = i.purchase;
  const listing = i.listing;
  const confirmation = i.confirmation;

  if (!purchase || !purchase.purchaseId) return refuse(REASON.NO_PURCHASE);
  if (!listing || !listing.listingId) return refuse(REASON.NO_LISTING);
  if (!confirmation) return refuse(REASON.NO_CONFIRMATION);

  /* ── The purchase must be about the work it says it is ── */
  if (String(purchase.listingId || '') !== String(listing.listingId)) {
    return refuse(REASON.CROSS_TITLE, String(purchase.listingId || '') + ' != ' + String(listing.listingId));
  }

  /* ── And the creator must be the one who owns that work ──
     The purchase record carries a denormalised `creatorUid`. It is a copy, written at
     purchase time, and a copy is exactly the thing that can be wrong. The LISTING is the
     authority on who made the work, so a disagreement is refused rather than resolved in
     favour of either — silently preferring the listing would pay the right person for the
     wrong reason and hide a corrupted purchase record. */
  const listingCreator = String(listing.creatorUid || '').trim();
  if (!listingCreator) return refuse(REASON.NO_CREATOR);
  const purchaseCreator = String(purchase.creatorUid || '').trim();
  if (purchaseCreator && purchaseCreator !== listingCreator) {
    return refuse(REASON.CROSS_CREATOR, purchaseCreator + ' != ' + listingCreator);
  }

  /* ── Paid once, paid once ── */
  if (purchase.settledAt || purchase.settlementRef ||
      SETTLED_STATES.indexOf(String(purchase.status || '').toLowerCase()) !== -1) {
    return refuse(REASON.ALREADY_SETTLED, String(purchase.status || 'settled'));
  }

  /* ── A creator cannot sell to themselves ──
     Not a moral rule: it is a round trip that turns a card charge into business-wallet
     credit less commission, and it is the cheapest laundering path a content platform
     offers. Their own work is theirs to watch without buying it. */
  if (String(purchase.buyerUid || '').trim() &&
      String(purchase.buyerUid).trim() === listingCreator) {
    return refuse(REASON.SELF_PURCHASE, listingCreator);
  }

  /* ── Somebody must have proven the money arrived ── */
  if (!isConfirmed(confirmation.state)) {
    return refuse(REASON.NOT_CONFIRMED, String(confirmation.state || 'none'));
  }

  /* ── The arithmetic, in cents, with no floats allowed near a balance ── */
  const grossMinor = intOrNull(purchase.grossMinor);
  if (grossMinor == null || grossMinor <= 0) return refuse(REASON.BAD_AMOUNT, String(purchase.grossMinor));

  const paidMinor = intOrNull(confirmation.amountMinor);
  if (paidMinor == null) return refuse(REASON.BAD_AMOUNT, String(confirmation.amountMinor));

  /* The provider is the authority on what was collected, and the listing on what was
     asked. They must agree exactly. A tolerance here would be a place for a few cents to
     live per transaction, which at volume is a number somebody has to explain. */
  if (paidMinor !== grossMinor) {
    return refuse(REASON.AMOUNT_MISMATCH, paidMinor + ' != ' + grossMinor);
  }

  const commissionMinor = intOrNull(purchase.platformFeeMinor);
  if (commissionMinor == null || commissionMinor < 0 || commissionMinor >= grossMinor) {
    return refuse(REASON.BAD_COMMISSION, String(purchase.platformFeeMinor));
  }

  const creatorMinor = grossMinor - commissionMinor;

  return {
    ok: true,
    plan: {
      creatorUid: listingCreator,
      listingId: String(listing.listingId),
      purchaseId: String(purchase.purchaseId),
      buyerUid: purchase.buyerUid ? String(purchase.buyerUid) : null,
      grossMinor,
      commissionMinor,
      amountMinor: creatorMinor,
      currency: listing.currency === 'USD' ? 'USD' : 'KES',
      ref: settlementRef(purchase.purchaseId),
      providerRef: confirmation.providerRef ? String(confirmation.providerRef) : null,
      provenance: 'content_revenue',
    },
  };
}

module.exports = {
  REASON,
  CONFIRMED_STATES,
  SETTLED_STATES,
  isConfirmed,
  settlementRef,
  settlementFor,
};
