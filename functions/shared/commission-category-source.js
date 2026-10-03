'use strict';
/**
 * WHICH COMMISSION CATEGORY a confirmed payment is priced under — resolved from SERVER records only (owner rule: each
 * transaction resolves its rule from the booked item server-side, never from client input).
 *
 * Before: webhookIntasend priced commission with `payments/{ref}.meta.category`, and initiateSTKPush copies `meta`
 * verbatim from request.data — so a modified client could name `jobs` / `construction_service` (0%) or fall to the 5%
 * default instead of marketplace 15% (2f lead, 5b confirmed on 73c5e5e, 2026-10-03).
 *
 * Sources, in order:
 *   1. product_order intent → 'marketplace' (one flat rate; never the client's label and never the seller-writable
 *      products/{id}.category).
 *   2. any other intent whose server pricer stamped metadata.category → that.
 *   3. otherwise → unresolved. The caller HOLDS the seller credit for review; it never falls back to the client label
 *      and never to an implicit default.
 * READ-ONLY.
 */
const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

async function resolveCommissionCategory(db, { intentRef }) {
  const id = String(intentRef || '');
  if (!ID_RE.test(id)) return { ok: false, reason: 'no_intent' };
  let intent;
  try { const s = await db.collection('paymentIntents').doc(id).get(); intent = s.exists ? (s.data() || {}) : null; }
  catch (_) { return { ok: false, reason: 'intent_unreadable' }; }
  if (!intent) return { ok: false, reason: 'no_intent' };
  const m = intent.metadata || {};

  /* A PRODUCT ORDER IS PRICED UNDER THE MARKETPLACE RATE — ONE FLAT RATE FOR EVERY SELLER AND PRODUCT (owner 2026-09-19).
     Its category is NOT taken from the product: products/{id}.category is SELLER-writable on the served rules (only
     sellerUid is locked), so reading it would move the choice of a 0% lane from the buyer's client to the seller. The
     purpose alone decides. (Live checkout sent 'product', which matched no row and fell to the 5% default; 'marketplace'
     is 5% on this tree — the price does not change, only who can choose it.) */
  if (intent.purpose === 'product_order') return { ok: true, category: 'marketplace', source: 'purpose' };
  const stamped = typeof m.category === 'string' ? m.category.trim().toLowerCase() : '';
  if (stamped) return { ok: true, category: stamped, source: 'intent_metadata' };
  return { ok: false, reason: 'category_unresolved', purpose: intent.purpose || null };
}

module.exports = { resolveCommissionCategory };
