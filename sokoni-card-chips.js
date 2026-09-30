/* sokoni-card-chips.js — ONE source for the trust chips a product card shows under its photo.
 *
 * The home grid (script.js) and the Shop/category grid (category.js) both render product
 * cards, on pages that do not share a script. The KEBS rule used to live only in script.js,
 * so category cards could not show it without a second copy of the category list — and two
 * copies drift. Both renderers now ask this module.
 *
 * Output is markup for the chip row; every value from the product is escaped (the KEBS
 * certificate number used to be interpolated raw into a title attribute).
 */
(function (root) {
  'use strict';

  /* Categories in which Kenyan law expects a KEBS mark. A product here with no certificate
     number is labelled "No KEBS" — a statement about what the seller did not provide, not
     an accusation. */
  var KEBS_REQUIRED_CATS = new Set(['food', 'agriculture', 'livestock', 'electronics', 'computers', 'cameras',
    'appliances', 'gaming', 'health', 'beauty', 'skincare', 'haircare', 'fragrances', 'toys', 'kids', 'tyres',
    'auto-parts']);

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function kebsBadge(product) {
    if (!product) return '';
    if (product.kebsCert) {
      return '<div class="kebs-badge kebs-certified" title="KEBS Certified: ' + esc(product.kebsCert) + '">🏅 KEBS</div>';
    }
    if (KEBS_REQUIRED_CATS.has(product.category)) {
      return '<div class="kebs-badge kebs-unverified" title="KEBS certification not provided">⚠️ No KEBS</div>';
    }
    return '';
  }

  /* "⚡ Only N left" — only for a real positive stock count of 5 or fewer. Unknown stock
     (absent) renders nothing: unmetered is not "low". */
  function lowStockChip(product) {
    if (!product || product.stock === undefined || product.stock === null || product.stock === '') return '';
    var n = Number(product.stock);
    if (!Number.isFinite(n) || n <= 0 || n > 5) return '';
    return '<span class="pcard-stock pcard-stock--low">⚡ Only ' + Math.floor(n) + ' left</span>';
  }

  /* ── PROMOTION CHIPS (owner 2026-09-30) ───────────────────────────────────────
     A card says "promoted" only when the SERVER says so: the product's OWN shop has an
     active, unexpired promotion (merchant-v2 Marketing → miniShopCreatePromotion) that
     lists this product. Read through the public miniShopGetPromotions (active + unexpired
     only), once per shop, cached 5 min per session.
     Trust boundary: the promotion writer does not (yet) check that listed productIds belong
     to the shop, so a promotion is only ever applied to cards of the SAME shop it was read
     for — another shop cannot badge your product.
     Unknown (no shopId, call failed) renders NOTHING — never a guessed badge.
     "⏳ Ends soon" = the promotion's own validUntil is within 24 hours.
     Cards opt in with data-pid + data-shop and a .pcard-chips row. */
  var PROMO_TTL_MS = 5 * 60 * 1000;
  var promoCache = new Map();          /* shopId → Promise<promotions[]|null> */
  var promoTimer = null;
  var PROMO_LABEL = { flash_sale: '⚡ Flash sale', bundle: '🎁 Bundle', coupon: '🏷️ Coupon', seasonal: '🎉 Promo' };

  function shopPromotions(shopId) {
    if (promoCache.has(shopId)) return promoCache.get(shopId);
    var key = 'skPromo:' + shopId;
    try {
      var c = JSON.parse(sessionStorage.getItem(key) || 'null');
      if (c && Date.now() - c.at < PROMO_TTL_MS && Array.isArray(c.promos)) {
        var hit = Promise.resolve(c.promos); promoCache.set(shopId, hit); return hit;
      }
    } catch (_) {}
    var call = typeof root.sokoniCallable === 'function' ? root.sokoniCallable('miniShopGetPromotions') : null;
    if (!call) return Promise.resolve(null);
    var p = call({ shopId: shopId }).then(function (r) {
      var list = (r && r.data && Array.isArray(r.data.promotions)) ? r.data.promotions : [];
      var promos = list.map(function (x) {
        return { type: String(x.type || ''), productIds: Array.isArray(x.productIds) ? x.productIds.map(String) : [], validUntil: x.validUntil || null };
      });
      try { sessionStorage.setItem(key, JSON.stringify({ at: Date.now(), promos: promos })); } catch (_) {}
      return promos;
    }).catch(function () { promoCache.delete(shopId); return null; });
    promoCache.set(shopId, p);
    return p;
  }

  function hydratePromoChips() {
    var cards = Array.prototype.filter.call(
      document.querySelectorAll('.product-card[data-pid][data-shop]:not([data-promo-done]), .st-product-card[data-pid][data-shop]:not([data-promo-done])'),
      function (c) { return !!c.dataset.shop; });
    var byShop = new Map();
    cards.forEach(function (c) {
      c.setAttribute('data-promo-done', '1');
      var s = c.dataset.shop; if (!byShop.has(s)) byShop.set(s, []); byShop.get(s).push(c);
    });
    byShop.forEach(function (list, shopId) {
      shopPromotions(shopId).then(function (promos) {
        if (!promos || !promos.length) return;
        list.forEach(function (card) {
          var hits = promos.filter(function (p) { return p.productIds.indexOf(card.dataset.pid) !== -1; });
          if (!hits.length) return;
          var row = card.querySelector('.pcard-chips'); if (!row || row.querySelector('.pcard-promo')) return;
          var best = hits.filter(function (h) { return h.type === 'flash_sale'; })[0] || hits[0];
          var until = best.validUntil ? new Date(best.validUntil).getTime() : NaN;
          var soon = Number.isFinite(until) && until > Date.now() && until - Date.now() <= 86400000;
          row.insertAdjacentHTML('afterbegin',
            '<span class="prod-badge pcard-promo pcard-promo--' + (best.type === 'flash_sale' ? 'flash' : 'promo') + '">' + (PROMO_LABEL[best.type] || '🎉 Promo') + '</span>' +
            (soon ? '<span class="prod-badge pcard-promo pcard-promo--soon">⏳ Ends soon</span>' : ''));
          row.hidden = false;
        });
      });
    });
  }

  function schedulePromoChips() {
    if (promoTimer) return;
    promoTimer = setTimeout(function () { promoTimer = null; hydratePromoChips(); }, 400);
  }

  root.SokoniCardChips = {
    KEBS_REQUIRED_CATS: KEBS_REQUIRED_CATS, kebsBadge: kebsBadge, lowStockChip: lowStockChip,
    schedulePromoChips: schedulePromoChips, hydratePromoChips: hydratePromoChips,
    _promoCache: promoCache,   /* exposed for the browser verification harness only */
  };
})(typeof window !== 'undefined' ? window : globalThis);
