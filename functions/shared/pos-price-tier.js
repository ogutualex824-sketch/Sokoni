'use strict';
/**
 * POS price tiers + product ownership — the ONE server rule (owner, 2026-10-01).
 *
 * A product carries up to three independent sale prices, set by the seller at upload:
 *   ONLINE    = `price` (as before: `salePrice || price` — unchanged, so every existing sale prices identically)
 *   SHOP      = `shopPrice`       (optional)
 *   WHOLESALE = `wholesalePrice`  (optional)
 * A tier the seller did not set is NOT AVAILABLE — never 0, never "free", never a silent fallback to another tier.
 * The cashier chooses a CONFIGURED tier per line; the SERVER resolves the price from the product record. A client
 * unitPrice, subtotal or tier label is never the money authority.
 *
 * Ownership: a till may only sell products of the shop it has been proven to act for. Live checkout read the
 * product by id and never checked whose it was — a merchant could sell (and decrement) another shop's product.
 */
const TIERS = Object.freeze(['online', 'shop', 'wholesale']);
const LABEL = Object.freeze({ online: 'ONLINE PRICE', shop: 'SHOP PRICE', wholesale: 'WHOLESALE PRICE' });

const _pos = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : null; };

/** The prices a product actually offers. ONLINE keeps the historical `salePrice || price || 0` meaning. */
function tierPrices(prod) {
  const p = prod || {};
  const online = Number(p.salePrice || p.price || 0);
  return {
    online: Number.isFinite(online) && online >= 0 ? online : 0,
    shop: _pos(p.shopPrice),
    wholesale: _pos(p.wholesalePrice),
  };
}

/** @returns {{ok:true, tier:string, price:number} | {ok:false, reason:'unsupported_tier'|'tier_not_configured', tier?:string}} */
function resolveTierPrice(prod, requestedTier) {
  const tier = (requestedTier === undefined || requestedTier === null || requestedTier === '') ? 'online' : String(requestedTier);
  if (!TIERS.includes(tier)) return { ok: false, reason: 'unsupported_tier', tier };
  const price = tierPrices(prod)[tier];
  if (price === null || price === undefined) return { ok: false, reason: 'tier_not_configured', tier };
  return { ok: true, tier, price };
}

/** Does this product belong to one of the shop identities the caller was PROVEN to act for? */
function productBelongsTo(prod, provenIds) {
  const ids = new Set((provenIds || []).filter(Boolean).map(String));
  if (!ids.size || !prod) return false;
  if (prod.shopId) return ids.has(String(prod.shopId));
  return !!prod.sellerUid && ids.has(String(prod.sellerUid));   /* legacy products: shop id == owner uid */
}

module.exports = { TIERS, LABEL, tierPrices, resolveTierPrice, productBelongsTo };
