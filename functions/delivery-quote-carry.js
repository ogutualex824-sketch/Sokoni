'use strict';
/* ════════════════════════════════════════════════════════════════════════════════════════════
   DELIVERY QUOTE CARRY — the pin travels; it is never re-derived.

   RES-1. Gate C made the CHARGE authoritative: checkout resolves a stored quote and the buyer pays
   that figure. This module makes the RIDER'S side of the same delivery authoritative, by carrying
   the identical pin to the dispatch record.

   WHAT WAS HERE BEFORE.
   The `packageRequests` producer inside `webhookIntasend` called the quote authority AGAIN, at
   webhook time, for a delivery that had already been priced and paid for. Two defects in one:

     1. It priced a trip it could not describe. The webhook has no routing leg, so the authority
        correctly refused and EVERY marketplace delivery was created `pricingBlocked` — the rider's
        record carried no earning at all.
     2. Had it succeeded it would have been the WRONG number: a second derivation of the same job
        is a different figure, and the rider would have been paid out of a quote nobody agreed to.

   WHY THIS IS A MODULE AND NOT A BLOCK IN THE WEBHOOK.
   The decision is only reachable through a signature-verified IntaSend callback, which no test can
   honestly drive. Extracted, it is ordinary code that a suite can EXECUTE — which is the whole
   difference between certifying that a guard exists and certifying that it runs. The webhook's
   control flow is unchanged: it awaits this and spreads the result exactly as before.

   NO FALLBACK PRICE, EVER. Every refusal returns `pricingBlocked` with a reason. An unpriced
   delivery is visible and repairable; a silently invented one becomes a rider's pay.
   ════════════════════════════════════════════════════════════════════════════════════════════ */

const dqa = require('./delivery-quote-authority');

const ORDERS = 'orders';
const SESSIONS = 'checkoutSessions';

const kesMajor = (m) => (m < 0 ? '-' : '') + Math.trunc(Math.abs(m) / 100) + '.'
  + String(Math.abs(m) % 100).padStart(2, '0');

/**
 * Find the pin that checkout created for this order.
 *
 * Order first, then its checkout session. The order is written by TWO rails
 * (`verifyIntasendPayment` and `_finalizeMarketplacePayment`) and only the first reads the session,
 * so on a webhook-first race the order can exist without the pin. The session is the single
 * server-authored origin, so the fallback is to it — never to a price.
 *
 * @returns {Promise<{pinned: object, source: 'order'|'session'}>}
 * @throws {dqa.QuoteRefused} `no_pinned_quote` when neither carries one.
 */
async function findCarriedPin(store, { orderId, sessionId } = {}) {
  let pinned = null, source = null, orderSessionId = null;

  if (orderId) {
    const snap = await store.collection(ORDERS).doc(String(orderId)).get();
    const data = snap.exists ? (snap.data() || {}) : {};
    orderSessionId = data.sessionId || null;
    if (data.deliveryQuote) { pinned = data.deliveryQuote; source = 'order'; }
  }

  if (!pinned) {
    const sid = orderSessionId || sessionId || null;
    if (sid) {
      const snap = await store.collection(SESSIONS).doc(String(sid)).get();
      if (snap.exists) {
        const d = snap.data() || {};
        if (d.deliveryQuote) { pinned = d.deliveryQuote; source = 'session'; }
      }
    }
  }

  if (!pinned) {
    throw new dqa.QuoteRefused('no_pinned_quote',
      'neither the order nor its checkout session carries a delivery quote');
  }
  return { pinned, source };
}

/**
 * The `_deliveryPricing` fragment the dispatch record is built from: the carried pin, revalidated,
 * or a stated refusal. Never throws — the delivery must still be created so the order is not lost.
 */
async function deliveryPricingForOrder(store, { orderId, sessionId } = {}) {
  try {
    const { pinned, source } = await findCarriedPin(store, { orderId, sessionId });

    const policy = await dqa.loadPolicy(store);
    if (!policy) {
      throw new dqa.QuoteRefused('pricing_policy_required',
        'platformConfig/deliveryPricing is unset — SOKONI has not approved commercial values');
    }

    /* Revalidate before it is written where a rider will be paid from it: version, integer minor
       units, conservation, the commission band, and the renegotiation guard against the policy in
       force NOW. Identical contract to the one `dispatch.js` applies at settlement, applied here
       so a pin that could never settle is never written as though it could. */
    dqa.assertSettleable(pinned, null, { currentPolicy: policy });

    return {
      deliveryQuote: pinned,
      quotePinSource: source,
      quotedVehicleClass: pinned.vehicleClass || null,
      quoteId: pinned.quoteId,
      pricingVersion: pinned.pricingVersion,
      /* MAJOR-unit display strings for the legacy/human readers of this collection. The
         authoritative integers live inside `deliveryQuote`; settlement reads only those. Writing an
         authority figure into a field whose unit differs is how a 100x error ships. */
      riderFeeKES: kesMajor(pinned.riderEarning.minorUnits),
      platformCut: kesMajor(pinned.sokoniCommission.minorUnits),
    };
  } catch (e) {
    return {
      pricingBlocked: (e && e.reason) || 'quote_failed',
      pricingBlockedDetail: (e && e.detail) || null,
    };
  }
}

module.exports = { findCarriedPin, deliveryPricingForOrder, kesMajor, ORDERS, SESSIONS };
