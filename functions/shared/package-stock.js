/* ══════════════════════════════════════════════════════════════════════════════
   SOKONI — PACKAGE / BUNDLE STOCK. What selling a package takes off the shelf.
   functions/shared/package-stock.js   (byte-identical browser copy: /sokoni-package-stock.js, published by
   scripts/build-package-stock.js — never edit the copy)

   Universal catalogue U5 (2026-09-29, owner brief §7): packages and bundles are first-class listings whose COMPONENTS
   are real catalogue products of the SAME shop:

       Pizza Meal Deal  →  Pizza × 1 · Fries × 1 · Soda × 2

   Selling one package takes those components off the shelf — the canonical products/{id}.stock that the till, the
   storefront and inventory all read. There is NO second stock counter: a package document carries no stock of its
   own (trackInventory:false); its availability is DERIVED from its components.

   WHO DECIDES THE COMPONENTS: the package's own document, read by the SERVER (the pricers attach them to the line).
   The deduction loops only ever expand what a server pricer attached — and each loop still re-checks, inside its
   transaction, that every component belongs to the package's shop.

   PURE. No Firestore, no network.
   ══════════════════════════════════════════════════════════════════════════════ */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.SokoniPackageStock = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var COMPOSITE_TYPES = ['package', 'bundle'];
  var MAX_COMPONENTS = 20, MAX_QTY = 99;

  function isComposite(p) {
    return !!p && COMPOSITE_TYPES.indexOf(String(p.listingType || '')) !== -1 && Array.isArray(p.components) && p.components.length > 0;
  }

  /** Normalise a components list: [{ productId, qty }] — whole quantities 1..99, merged by product, at most 20. */
  function sanitizeComponents(raw) {
    var out = [], idx = {};
    (Array.isArray(raw) ? raw : []).forEach(function (c) {
      var id = String((c && (c.productId || c.id)) || '').trim();
      var q = Math.round(Number(c && (c.qty != null ? c.qty : c.quantity)));
      if (!id || id.indexOf('/') !== -1 || id.length > 128 || !(q >= 1)) return;
      if (idx[id] !== undefined) { out[idx[id]].qty = Math.min(MAX_QTY, out[idx[id]].qty + q); return; }
      idx[id] = out.length; out.push({ productId: id, qty: Math.min(MAX_QTY, q) });
    });
    return out.slice(0, MAX_COMPONENTS);
  }

  /** For a server pricer: the components to carry on an order line, from the package's OWN document. */
  function componentsForLine(prod) { return isComposite(prod) ? sanitizeComponents(prod.components) : null; }

  /**
   * The stock movements a set of (server-priced) lines stands for. A line with `components` becomes one entry per
   * component (component qty × line qty); every other line is itself. Entries for the same product are MERGED, so a
   * cart holding a Meal Deal and a loose Soda asks the shelf once for the sum.
   * @returns {Array<{ productId, qty, viaPackage: string|null, sellerUid: string|null }>}
   */
  function expandLines(lines) {
    var out = [], idx = {};
    (lines || []).forEach(function (l) {
      if (!l) return;
      var pid = String(l.productId || l.id || ''), qty = Math.floor(Number(l.qty) || 0);
      if (!pid || qty < 1) return;
      var comps = Array.isArray(l.components) ? sanitizeComponents(l.components) : null;
      var entries = comps && comps.length
        ? comps.map(function (c) { return { productId: c.productId, qty: c.qty * qty, viaPackage: pid, sellerUid: l.sellerUid || null }; })
        : [{ productId: pid, qty: qty, viaPackage: null, sellerUid: l.sellerUid || null }];
      entries.forEach(function (e) {
        var k = e.productId;
        if (idx[k] !== undefined) { out[idx[k]].qty += e.qty; if (e.viaPackage && !out[idx[k]].viaPackage) out[idx[k]].viaPackage = e.viaPackage; return; }
        idx[k] = out.length; out.push(e);
      });
    });
    return out;
  }

  /** A stock figure that is ABSENT means UNMETERED (owner invariant B9.17) — never zero. */
  function stockOf(p) { return (p && typeof p.stock === 'number') ? p.stock : null; }

  /**
   * How many of this package can be sold right now: the fewest complete sets the components allow. Unmetered
   * components do not limit it. null = unlimited (every component unmetered); 0 = a component is missing or out.
   */
  function availableUnits(pkg, productsById) {
    if (!isComposite(pkg)) return null;
    var min = null;
    for (var i = 0; i < pkg.components.length; i++) {
      var c = pkg.components[i], p = productsById && productsById[c.productId];
      if (!p || p.status === 'archived' || p.isVisible === false) return 0;
      var s = stockOf(p);
      if (s === null) continue;
      var n = Math.floor(s / Math.max(1, Number(c.qty) || 1));
      min = (min === null) ? n : Math.min(min, n);
    }
    return min === null ? null : Math.max(0, min);
  }

  return { COMPOSITE_TYPES: COMPOSITE_TYPES, MAX_COMPONENTS: MAX_COMPONENTS, isComposite: isComposite, sanitizeComponents: sanitizeComponents,
    componentsForLine: componentsForLine, expandLines: expandLines, availableUnits: availableUnits, stockOf: stockOf };
}));
