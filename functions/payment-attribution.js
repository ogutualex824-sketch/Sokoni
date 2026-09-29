'use strict';
/**
 * webhookIntasend financial attribution — the D1 fix (Q6).
 *
 * initiateSTKPush writes payments/{ref}.meta verbatim from the client's own
 * request argument. webhookIntasend used to read THAT for who gets paid
 * (sellerUid, providerId), which order gets finalised (orderId, items), and
 * — since Q5 — which Till a sale belongs to. This file is the ONE place that
 * decision is made now: prefer paymentIntents/{ref}.metadata (server-derived,
 * the whole reason payment-purposes.js exists) whenever an intent exists;
 * fall back to the client-supplied meta, UNCHANGED, when it does not — so a
 * caller not yet migrated onto createPaymentIntent (D2's remaining, separate
 * gap) keeps working exactly as it does today.
 *
 * mergeAttribution is pure (no Firestore) so it is directly certifiable —
 * see scripts/test-webhook-attribution.js — the same split
 * functions/sokoni-qr-authority.js (Q5) already established.
 *
 * Till-identity fields (sokoniTillId/shopId/branchId/merchantUid) are the one
 * hard floor here: they are NEVER read from legacyMeta, intent present or
 * not. There is no legacy Till flow whose behaviour needs preserving, so
 * unlike sellerUid/orderId (which DO have long-standing legacy traffic to
 * stay compatible with) these fields simply do not exist unless a verified
 * pos_till_sale intent produced them.
 *
 * `purpose` is carried from the intent's TOP LEVEL, not from metadata, and in
 * BOTH branches. createPaymentIntent's subscription branch writes no `metadata`
 * at all, so that payment takes the legacy_meta branch below — carrying purpose
 * only on the intent branch would miss precisely the case it exists to answer.
 * It is null whenever no intent was found, so a reader must treat "no purpose"
 * as "unknown", never as "not a subscription".
 *
 * This reports the purpose; it does NOT re-source `category`. The two are
 * different questions — "what IS this payment" vs "which commission RATE
 * applies" — and §2's rate-vocabulary finding still forbids the second.
 *
 * Deliberately OUT OF SCOPE (docs/WEBHOOK_ATTRIBUTION_AUTHORITY.md §2-3):
 * commission `category` (a real, evidenced regression risk — see the doc),
 * and the cosmetic/logistics fields (hub, sellerName, buyerName, address,
 * fulfillmentType, serviceDesc, providerName) that no pricer's metadata
 * carries today.
 */

function mergeAttribution({ intent, legacyMeta }) {
  legacyMeta = legacyMeta || {};

  if (intent && intent.metadata && typeof intent.metadata === 'object') {
    const m = intent.metadata;
    return {
      source:       'intent',
      purpose:      intent.purpose || null,
      sellerUid:    m.sellerUid || null,
      providerId:   m.providerId || null,
      orderId:      m.orderId || null,
      items:        Array.isArray(m.items) ? m.items : null,
      type:         m.type || null,
      sokoniTillId: m.sokoniTillId || null,
      shopId:       m.shopId || null,
      branchId:     m.branchId || null,
      merchantUid:  m.merchantUid || null,
      /* U7c2: the shop-offer discount the SERVER pricer applied (payment-purposes product_order). */
      offerDiscount: Number.isFinite(Number(m.offerDiscount)) ? Math.max(0, Number(m.offerDiscount)) : 0,
      offersApplied: Array.isArray(m.offersApplied) ? m.offersApplied : [],
      offerShopId:   m.offerShopId || null,
    };
  }

  /* No usable intent — behaviour byte-identical to pre-Q6 for every
     not-yet-migrated caller. Till fields are the one exception: they are
     ALWAYS null here, never sourced from legacyMeta (see header). */
  return {
    source:       'legacy_meta',
    /* From the intent when one exists but carries no metadata — the
       subscription case. Never from legacyMeta: a purpose the client named
       would be exactly the authority this field exists to replace. */
    purpose:      (intent && intent.purpose) || null,
    sellerUid:    legacyMeta.sellerUid || null,
    providerId:   legacyMeta.providerId || null,
    orderId:      legacyMeta.orderId || null,
    items:        Array.isArray(legacyMeta.items) ? legacyMeta.items : null,
    type:         legacyMeta.type || null,
    sokoniTillId: null,
    shopId:       null,
    branchId:     null,
    merchantUid:  null,
    /* U7c2: NEVER from legacyMeta — a discount the client wrote is not a discount. */
    offerDiscount: 0,
    offersApplied: [],
    offerShopId:   null,
  };
}

/**
 * resolveFinancialAttribution — I/O wrapper. Loads paymentIntents/{intentRef}
 * ONCE and delegates the decision to mergeAttribution. Fails OPEN to
 * legacyMeta on a read error (never blocks the webhook — the payment itself
 * is already captured and authoritative by the time this runs).
 */
async function resolveFinancialAttribution(db, { intentRef, legacyMeta }) {
  let intent = null;
  try {
    const snap = await db.collection('paymentIntents').doc(String(intentRef)).get();
    if (snap.exists) intent = snap.data();
  } catch (_) { /* fail open — merged below with intent:null, same as "not found" */ }

  return mergeAttribution({ intent, legacyMeta });
}

/**
 * decidePaidTransition — Q7. Given a payment intent's CURRENT state, the
 * webhook-confirmed amount, and whether this payment is a Till sale, decide
 * whether paymentIntents/{ref} should transition to 'paid'. Pure — no
 * Firestore — so it is directly certifiable
 * (scripts/test-pos-till-paid-transition.js), the same split every pure core
 * in this programme (Q5, Q6) already uses.
 *
 * Scoped to Till sales only by the CALLER (webhookIntasend passes
 * isTillSale = !!attribution.sokoniTillId) — every other purpose is
 * untouched by this slice; see docs/POS_QR_PAID_STATE_INTEGRATION.md §4 for
 * why that is a deliberate scoping decision, not an oversight.
 *
 * Returns one of:
 *   { action: 'noop' }            — already terminal (paid/expired/cancelled), or no intent
 *   { action: 'mark_paid' }       — safe to transition to 'paid'
 *   { action: 'flag_mismatch' }   — confirmed amount does not match the intent's own —
 *                                   intent stays exactly as it is (NOT paid); caller should
 *                                   log/flag for review, never trust the webhook's figure here
 */
const TERMINAL_INTENT_STATUSES = ['paid', 'expired', 'cancelled'];

function decidePaidTransition({ intent, confirmedAmount, isTillSale }) {
  if (!isTillSale) return { action: 'noop' };
  if (!intent) return { action: 'noop' };
  if (TERMINAL_INTENT_STATUSES.includes(String(intent.status))) return { action: 'noop' };

  const expected = Math.round(Number(intent.amount));
  const confirmed = Math.round(Number(confirmedAmount));
  if (!Number.isFinite(expected) || !Number.isFinite(confirmed) || expected !== confirmed) {
    return { action: 'flag_mismatch' };
  }
  return { action: 'mark_paid' };
}

module.exports = { mergeAttribution, resolveFinancialAttribution, decidePaidTransition, TERMINAL_INTENT_STATUSES };
