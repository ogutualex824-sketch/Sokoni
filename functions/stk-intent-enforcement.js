'use strict';
/**
 * SOKONI — which STK callers MUST carry a server-priced payment intent.
 * ============================================================================================
 * `initiateSTKPush` has a legacy branch: when no `paymentIntents/{ref}` exists it logs
 * STK_NO_AUTHORITY and charges the CLIENT-SUPPLIED amount. That branch is deliberate and must
 * stay — flipping it closed for every caller at once would fail POS and every booking page
 * simultaneously, trading an integrity incident for an availability one. Enforcement therefore
 * follows migration: a caller is enforced once its client mints an intent.
 *
 * This module is that list, plus the normalisation around it, extracted so the decision can be
 * tested exhaustively as a pure function instead of by provoking a 1,500-line callable.
 *
 * ── WHY HEALTHCARE IS ENFORCED FROM DAY ONE ────────────────────────────────────────────────
 * The migration rule is "deploy the client first, then add its category here; adding the
 * category before the client ships breaks that flow's payments." Healthcare has no shipped
 * client to break — the subscription purchase path is new, and it mints
 * `healthcare_subscription` intents by construction. So it is enforced immediately, which is
 * the one moment it can be done with zero migration risk.
 *
 * Activation was already protected: `hcActivateSubscriptionOnPayment` requires
 * `paymentIntents/{ref}.purpose === 'healthcare_subscription'`, so an intent-less payment
 * could never produce a subscription. What it COULD produce is a charge that delivers nothing,
 * and that is the gap this closes.
 *
 * ── THE NORMALISATION IS NOT COSMETIC ──────────────────────────────────────────────────────
 * The original comparison was `String(meta.category || '').toLowerCase()` — lowercased but
 * never trimmed. `" healthcare_subscription "` therefore compared unequal to
 * `"healthcare_subscription"` and fell through to the legacy branch: a bypass costing one
 * space character. Whitespace is stripped here, and a non-string category (array, object,
 * number) is coerced predictably rather than producing an accidental match or an accidental
 * miss.
 *
 * ── WHY `purpose` IS CHECKED TOO ───────────────────────────────────────────────────────────
 * `meta.category` is the field the older callers set; `purpose` is the vocabulary
 * createPaymentIntent speaks. A migrated caller may reasonably send either, and a payment that
 * announces itself as an enforced purpose must not escape enforcement because it used the
 * newer word. Both are checked; either one matching enforces.
 *
 * This widens what is REFUSED, never what is allowed, so it cannot break a caller that was
 * previously accepted unless that caller was already declaring an enforced category.
 */

/* Callers whose clients mint an intent, and which are therefore refused without one.
 *
 * ADDING TO THIS LIST IS A DEPLOY-ORDER DECISION, NOT A PREFERENCE: point the client at
 * createPaymentIntent and deploy it FIRST, then add the key here. Adding a key whose client
 * still sends a bare amount refuses that flow's payments outright. */
const ENFORCED = Object.freeze([
  /* subscriptions.html -> createPaymentIntent, deployed 2026-07-20 */
  'subscription',
  /* Healthcare subscriptions (clinic | hospital | enterprise). No legacy client exists, and
     the purchase path mints a server-priced intent by construction — ADR-015. */
  'healthcare_subscription',
]);

/** Normalise a declared category/purpose for comparison. Non-strings become '' rather than
 *  "[object Object]" or "1,2": a value that is not a category should not accidentally match
 *  one, and should not accidentally dodge one either. */
function normalise(v) {
  if (typeof v !== 'string') return '';
  return v.trim().toLowerCase();
}

/**
 * Must this payment carry a server-priced intent?
 *
 * @param {object} meta  the STK request's `meta` object (client-supplied — that is the point)
 * @returns {{enforced: boolean, matched: string|null}}
 */
function isEnforcedPaymentCategory(meta) {
  const m = (meta && typeof meta === 'object') ? meta : {};
  const candidates = [normalise(m.category), normalise(m.purpose)].filter(Boolean);
  for (const c of candidates) {
    if (ENFORCED.includes(c)) return { enforced: true, matched: c };
  }
  /* Unit 4a (owner repair #1): keyed on the EFFECT, not a label. */
  if (wouldFinalizeMarketplaceOrder(m)) return { enforced: true, matched: 'marketplace_order' };
  return { enforced: false, matched: null };
}

/**
 * Would this meta, once paid, finalise a marketplace order (order → paid, stock decremented)?
 *
 * Unit 4a refuses such an STK when no intent exists, because its seller, items and amount would all
 * be browser-supplied. It is keyed on the EFFECT rather than on `category`:
 *   - a label is chosen by the browser, so `category:'default'` + `orderId` would dodge a label rule;
 *   - SokoniPay's gateway labels a deposit `product.category || 'product'` (product.js contact-seller
 *     fallback) with NO orderId. That finalises no order, and refusing it would break a live flow.
 * Census 2026-09-30 (hosting b108ae3): checkout.html is the only STK caller that sends orderId, and
 * sokoni-intasend.js forwards orderId only when the caller supplies it.
 *
 * SAME SEMANTICS as webhookIntasend's settlement predicate (functions/payment-attribution.js
 * wouldFinalizeMarketplaceOrder on the webhook lineage): lowercase, NOT trimmed, String() coercion.
 * Kept identical deliberately: what the STK refuses must be exactly what settlement would finalise.
 * The two lineages cannot share a file today, so the certification asserts the equivalence.
 *
 * DEPLOY ORDER: only after the checkout that mints product_order intents is live (Unit 3). The
 * checkout before it sends orderId WITHOUT an intent, so enforcing earlier refuses every marketplace
 * M-Pesa payment.
 */
function wouldFinalizeMarketplaceOrder(meta) {
  const m = (meta && typeof meta === 'object') ? meta : {};
  const cat = String(m.category || '').toLowerCase();
  return !!m.orderId
    && m.type !== 'booking'
    && !['subscription', 'wallet_topup', 'topup'].includes(cat);
}

module.exports = { ENFORCED, normalise, isEnforcedPaymentCategory, wouldFinalizeMarketplaceOrder };
