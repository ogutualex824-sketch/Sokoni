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
 *   1. product_order intent → the category of its products, read from products/{productId}.category (the catalogue
 *      record the seller owns server-side; never the cart). One category for the whole order, else REFUSED
 *      ('mixed_categories') — the engine prices one category per call, and guessing which would be the same defect.
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

  if (intent.purpose === 'product_order') {
    const ids = [...new Set((Array.isArray(m.items) ? m.items : []).map((l) => String((l && l.productId) || '')).filter((x) => ID_RE.test(x)))];
    if (!ids.length) return { ok: false, reason: 'no_order_lines' };
    const cats = new Set();
    for (const pid of ids.slice(0, 50)) {
      let p;
      try { const s = await db.collection('products').doc(pid).get(); p = s.exists ? (s.data() || {}) : null; }
      catch (_) { return { ok: false, reason: 'product_unreadable' }; }
      const c = p && typeof p.category === 'string' ? p.category.trim().toLowerCase() : '';
      if (!c) return { ok: false, reason: 'product_category_missing', productId: pid };
      cats.add(c);
    }
    if (ids.length > 50) return { ok: false, reason: 'too_many_lines' };
    if (cats.size !== 1) return { ok: false, reason: 'mixed_categories', categories: [...cats] };
    return { ok: true, category: [...cats][0], source: 'products' };
  }
  const stamped = typeof m.category === 'string' ? m.category.trim().toLowerCase() : '';
  if (stamped) return { ok: true, category: stamped, source: 'intent_metadata' };
  return { ok: false, reason: 'category_unresolved', purpose: intent.purpose || null };
}

module.exports = { resolveCommissionCategory };
