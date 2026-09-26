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

  let sessionUsed = null;
  if (!pinned) {
    const sid = orderSessionId || sessionId || null;
    if (sid) {
      const snap = await store.collection(SESSIONS).doc(String(sid)).get();
      if (snap.exists) {
        const d = snap.data() || {};
        if (d.deliveryQuote) { pinned = d.deliveryQuote; source = 'session'; sessionUsed = String(sid); }
      }
    }
  }

  if (!pinned) {
    throw new dqa.QuoteRefused('no_pinned_quote',
      'neither the order nor its checkout session carries a delivery quote');
  }
  return { pinned, source, sessionId: sessionUsed };
}

/**
 * BIND A SESSION-CARRIED QUOTE TO ITS ORDER — RES-1 option 1.
 *
 * The webhook-first rail (`_finalizeMarketplacePayment`) writes the order without reading the
 * checkout session and without binding the quote. The carry above then finds the pin on the
 * SESSION, and used to hand it to the delivery record UNBOUND: `deliveryQuotes/{id}` stayed
 * `issued` with no `orderId`. Repair 5 correctly refuses to pay on an unbound quote (single use is
 * what stops one quote backing many orders), so on this rail no rider could ever be paid.
 *
 * This performs the binding the verify rail performs, in ONE transaction, before the pin is
 * written where a rider is paid from it:
 *   - the session names THIS quote, and its pin is THIS quote;
 *   - the session's buyer, the quote's buyer and the order's buyer are the same uid;
 *   - a session already consumed by another order is refused;
 *   - an order already carrying a different quote is refused — a bound quote is never replaced;
 *   - the quote itself is bound through the ONE single-use binder (`bindQuoteToOrderTx`): a quote
 *     consumed by another order is refused, and re-binding to the same order is a no-op.
 * It then records the pin on the order and marks the session consumed by the order, exactly the
 * state the verify rail leaves. It reads no amount and decides no price.
 *
 * @throws {dqa.QuoteRefused} with a stated reason; nothing is written on refusal.
 */
async function bindSessionQuoteToOrder(store, { orderId, sessionId, quoteId }) {
  const endpoint = require('./delivery-quote-endpoint');
  const DI = require('./dispute-identity');
  const refuse = (reason, detail) => { throw new dqa.QuoteRefused(reason, detail || null); };
  const orderRef = store.collection(ORDERS).doc(String(orderId));
  const sessionRef = store.collection(SESSIONS).doc(String(sessionId));
  const quoteRef = store.collection(endpoint.QUOTES).doc(String(quoteId));

  return store.runTransaction(async (tx) => {
    const [oSnap, sSnap, qSnap] = [await tx.get(orderRef), await tx.get(sessionRef), await tx.get(quoteRef)];
    if (!oSnap.exists) refuse('order_not_found', String(orderId));
    if (!sSnap.exists) refuse('session_not_found', String(sessionId));
    if (!qSnap.exists) refuse('quote_record_missing', String(quoteId));
    const order = oSnap.data() || {}, session = sSnap.data() || {}, quote = qSnap.data() || {};

    if (session.deliveryQuoteId !== quoteId || !session.deliveryQuote || session.deliveryQuote.quoteId !== quoteId) {
      refuse('session_quote_mismatch', String(sessionId));
    }
    const buyer = DI.orderBuyerUid(order);
    if (!buyer || session.uid !== buyer || quote.buyerUid !== buyer) refuse('buyer_mismatch', String(orderId));
    if (session.status === 'consumed' && session.orderId && String(session.orderId) !== String(orderId)) {
      refuse('session_bound_to_another_order', String(session.orderId));
    }
    if (order.deliveryQuoteId && order.deliveryQuoteId !== quoteId) {
      refuse('order_bound_to_another_quote', String(order.deliveryQuoteId));
    }
    const replay = quote.status === 'consumed' && String(quote.orderId || '') === String(orderId)
      && order.deliveryQuoteId === quoteId;

    /* ── all reads above, all writes below ── */
    try {
      endpoint.bindQuoteToOrderTx(tx, store, quoteId, orderId, buyer, qSnap);
    } catch (e) {
      const m = String((e && e.message) || '');
      refuse(/already_bound/.test(m) ? 'quote_bound_to_another_order'
        : /not_yours/.test(m) ? 'buyer_mismatch' : 'quote_not_bindable', m);
    }
    if (!order.deliveryQuoteId) {
      tx.update(orderRef, { deliveryQuoteId: quoteId, deliveryQuote: session.deliveryQuote, sessionId: String(sessionId) });
    }
    if (session.status !== 'consumed') {
      tx.update(sessionRef, { status: 'consumed', orderId: String(orderId) });
    }
    return { bound: true, replay };
  });
}

/**
 * The `_deliveryPricing` fragment the dispatch record is built from: the carried pin, revalidated,
 * or a stated refusal. Never throws — the delivery must still be created so the order is not lost.
 */
async function deliveryPricingForOrder(store, { orderId, sessionId } = {}) {
  try {
    const { pinned, source, sessionId: sessionUsed } = await findCarriedPin(store, { orderId, sessionId });

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

    /* A pin found on the SESSION was never bound to this order (webhook-first rail). Bind it now,
       transactionally, or refuse — an unbound pin is never written where a rider is paid from it. */
    let quoteBoundBy = source === 'order' ? 'order' : null;
    if (source === 'session') {
      await bindSessionQuoteToOrder(store, { orderId, sessionId: sessionUsed, quoteId: pinned.quoteId });
      quoteBoundBy = 'carry_session';
    }

    return {
      quoteBoundBy,
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

module.exports = { findCarriedPin, bindSessionQuoteToOrder, deliveryPricingForOrder, kesMajor, ORDERS, SESSIONS };
