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
      sellerUid:    m.sellerUid || null,
      providerId:   m.providerId || null,
      orderId:      m.orderId || null,
      items:        Array.isArray(m.items) ? m.items : null,
      type:         m.type || null,
      sokoniTillId: m.sokoniTillId || null,
      shopId:       m.shopId || null,
      branchId:     m.branchId || null,
      merchantUid:  m.merchantUid || null,
    };
  }

  /* No usable intent — behaviour byte-identical to pre-Q6 for every
     not-yet-migrated caller. Till fields are the one exception: they are
     ALWAYS null here, never sourced from legacyMeta (see header). */
  return {
    source:       'legacy_meta',
    sellerUid:    legacyMeta.sellerUid || null,
    providerId:   legacyMeta.providerId || null,
    orderId:      legacyMeta.orderId || null,
    items:        Array.isArray(legacyMeta.items) ? legacyMeta.items : null,
    type:         legacyMeta.type || null,
    sokoniTillId: null,
    shopId:       null,
    branchId:     null,
    merchantUid:  null,
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

module.exports = { mergeAttribution, resolveFinancialAttribution };
