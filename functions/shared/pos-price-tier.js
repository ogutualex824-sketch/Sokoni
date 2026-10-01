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
/* Owner wording (2026-10-01): the in-store tier is the SHELF price. The stored field stays `shopPrice` and the tier
   key stays 'shop' (no data migration; the uploader and the server agree on them) — only what people read changes. */
const LABEL = Object.freeze({ online: 'ONLINE PRICE', shop: 'SHELF PRICE', wholesale: 'WHOLESALE PRICE' });
const WORD = Object.freeze({ online: 'online', shop: 'shelf', wholesale: 'wholesale' });

/* The same ceiling the product writer enforces (sokoni-aa's uploader, 7a9f276). Property and vehicles use it. */
const MAX_PRICE = 1000000000;
/* New tiers must be real numbers: a string such as "90" is NOT an authoritative price (owner's brief). */
const _pos = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= MAX_PRICE ? v : null);

/** The prices a product actually offers. ONLINE keeps the historical `salePrice || price || 0` meaning.
 *  The owner's ordering is RE-CHECKED here: the uploader validates it in the browser and the rules do not, so a
 *  product written directly could carry, e.g., a shop price above online. A tier that breaks the ordering is
 *  treated as NOT CONFIGURED (refused), never priced: wholesale < online; shop ≤ online; wholesale ≤ shop. */
function tierPrices(prod) {
  const p = prod || {};
  const onlineRaw = Number(p.salePrice || p.price || 0);
  const online = Number.isFinite(onlineRaw) && onlineRaw >= 0 ? onlineRaw : 0;
  let shop = _pos(p.shopPrice);
  let wholesale = _pos(p.wholesalePrice);
  if (shop !== null && !(shop <= online)) shop = null;
  if (wholesale !== null && !(wholesale < online)) wholesale = null;
  if (wholesale !== null && shop !== null && !(wholesale <= shop)) { shop = null; wholesale = null; }
  return { online, shop, wholesale };
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

module.exports = { TIERS, LABEL, WORD, MAX_PRICE, tierPrices, resolveTierPrice, productBelongsTo };
