/* ════════════════════════════════════════════════════════════════════════
   SOKONI POS Inventory Sync — canonical `products` → POS screen (PosDB).

   THE INVENTORY BUG this fixes: the POS inventory screen renders from IndexedDB
   (PosDB `sokoni_smartpos`), which was seeded from canonical `products` ONLY ONCE
   at POS boot. There was no live path from a seller's dashboard edit (canonical
   Firestore) to the screen, so new/edited products never reflected until a full
   POS reload — and reconcile measured only the Firestore mirrors, so it looked
   healthy while the screen was stale.

   This module is the PURE, testable decision core. It never touches IndexedDB or
   the network — pos.js fetches /api/catalogue and applies these decisions via
   PosDB.products.upsertCanonical(). Kept pure so the correctness-critical stock
   rule is unit-tested (scripts/test-inventory-sync.js).

   Offline-safe last-write-wins:
     • canonical carries `updatedAt` (dashboard/server edits bump it).
     • PosDB stamps a local `updatedAt` on every local save/adjustStock.
     • we persist the last-seen canonical time as `canonicalUpdatedAt` on the
       local record, so we can tell whether canonical OR the local cache moved.
   A dashboard edit (canonical newer) reflects on the screen; an unsynced offline
   POS sale (local newer than the last canonical sync) is PRESERVED — never
   clobbered by a stale canonical stock. Canonical stays authoritative for money
   and self-heals the cache once the local change syncs.
   ════════════════════════════════════════════════════════════════════════ */
(function (root) {
  'use strict';

  /* Coerce any timestamp shape to epoch millis. /api/catalogue serializes a
     Firestore Timestamp to {_seconds,_nanoseconds} (or {seconds,nanoseconds});
     product ids are also Date.now() strings, a useful fallback. null when
     unparseable so the caller never invents a wrong ordering. */
  function _toMs (v) {
    if (v == null) return null;
    if (typeof v === 'number') return isFinite(v) ? v : null;
    if (typeof v === 'object') {
      if (typeof v.toMillis === 'function') { try { return v.toMillis(); } catch (_) { return null; } }
      if (typeof v.getTime === 'function') { var g = v.getTime(); return isNaN(g) ? null : g; }
      var s = (v.seconds != null) ? v.seconds : v._seconds;
      var n = (v.nanoseconds != null) ? v.nanoseconds : v._nanoseconds;
      if (s != null) return Number(s) * 1000 + Math.floor(Number(n || 0) / 1e6);
      return null;
    }
    if (typeof v === 'string') {
      if (/^\d+$/.test(v)) return Number(v);
      var p = Date.parse(v); return isNaN(p) ? null : p;
    }
    return null;
  }

  function _num (n) { return Number(n || 0); }

  /* The canonical fields the POS inventory screen displays. A field absent from
     canonical must not blank a local value we already show — hence the || fallbacks. */
  function _canonicalSnapshot (c, local) {
    local = local || {};
    var stock = (c.stock != null) ? Number(c.stock) : (local.stock != null ? local.stock : null);
    return {
      name:     c.name || c.title || local.name || 'Product',
      price:    _num(c.price != null ? c.price : (c.sellingPrice != null ? c.sellingPrice : local.price)),
      cost:     _num(c.cost != null ? c.cost : (c.costPrice != null ? c.costPrice : local.cost)),
      stock:    stock,
      track:    stock != null,
      category: c.category || local.category || 'general',
      barcode:  c.barcode || local.barcode || '',
      sku:      c.sku || local.sku || '',
      image:    c.image || (Array.isArray(c.images) ? c.images[0] : '') || local.image || '',
      unit:     c.unit || local.unit || 'pc',
      /* availability fields the old seed dropped entirely — the screen/low-stock use them */
      status:        (c.status != null) ? c.status : local.status,
      isVisible:     (c.isVisible != null) ? c.isVisible : local.isVisible,
      minStockLevel: (c.minStockLevel != null) ? Number(c.minStockLevel) : local.minStockLevel,
      source:   'canonical',
    };
  }

  /* Decide what to do with ONE canonical product against its local twin.
     Returns { action:'insert'|'update'|'skip', record, stockSource }.
     record is the FULL PosDB row to upsert (timestamps controlled here so the
     caller's put must NOT re-bump them). */
  function reconcileProduct (canonical, local) {
    var id = String(canonical.id || canonical._id || canonical.productId || '');
    if (!id) return { action: 'skip', record: null, reason: 'no-id' };
    var cUpd = _toMs(canonical.updatedAt) || _toMs(canonical.id) || 0;   /* id is a Date.now() ts */

    if (!local) {
      var snap = _canonicalSnapshot(canonical, null);
      snap.id = id;
      snap.canonicalUpdatedAt = cUpd;
      snap.updatedAt = cUpd || 0;                 /* clean: not dirty relative to canonical */
      return { action: 'insert', record: snap, stockSource: 'canonical' };
    }

    var prevCanon = _num(local.canonicalUpdatedAt);
    var localTs   = _num(local.updatedAt);
    var localDirty = localTs > prevCanon;          /* a local edit/sale since last canonical sync */
    var canonicalChanged = cUpd > prevCanon;       /* dashboard/server changed canonical */

    if (!canonicalChanged) return { action: 'skip', record: null, reason: 'canonical-unchanged' };

    var merged = _canonicalSnapshot(canonical, local);
    merged.id = id;
    /* Stock is correctness-critical: keep the local value when the cache moved since
       the last sync (offline POS sale not yet reflected in canonical). Otherwise take
       the authoritative canonical stock (a dashboard/marketplace change). */
    var stockSource;
    if (localDirty) { merged.stock = (local.stock != null ? local.stock : merged.stock); stockSource = 'local-preserved'; }
    else            { stockSource = 'canonical'; }
    merged.track = merged.stock != null;
    merged.canonicalUpdatedAt = cUpd;
    /* Preserve the dirty local timestamp until it syncs; otherwise mark clean at canonical time. */
    merged.updatedAt = localDirty ? localTs : cUpd;
    return { action: 'update', record: merged, stockSource: stockSource };
  }

  /* Reconcile a whole /api/catalogue list against the current PosDB rows.
     Returns { writes:[record...], stats, orphans:[id...] }. Orphans = local
     canonical-sourced rows no longer in canonical (deleted upstream) — SURFACED,
     never auto-deleted (a fetch hiccup must not wipe the screen). */
  function mergeCatalogue (canonicalList, localList) {
    var byId = {};
    (localList || []).forEach(function (l) { if (l && l.id != null) byId[String(l.id)] = l; });
    var writes = [], seen = {};
    var stats = { canonical: (canonicalList || []).length, local: (localList || []).length,
                  inserted: 0, updated: 0, skipped: 0, stockFromCanonical: 0, stockKeptLocal: 0 };
    (canonicalList || []).forEach(function (c) {
      var id = String(c.id || c._id || c.productId || '');
      if (!id) return; seen[id] = 1;
      var r = reconcileProduct(c, byId[id] || null);
      if (r.action === 'insert') { stats.inserted++; writes.push(r.record); }
      else if (r.action === 'update') { stats.updated++; writes.push(r.record); }
      else { stats.skipped++; }
      if (r.stockSource === 'canonical' && r.action !== 'skip') stats.stockFromCanonical++;
      if (r.stockSource === 'local-preserved') stats.stockKeptLocal++;
    });
    var orphans = [];
    (localList || []).forEach(function (l) {
      if (l && l.source === 'canonical' && !seen[String(l.id)]) orphans.push(String(l.id));
    });
    stats.orphans = orphans.length;
    return { writes: writes, stats: stats, orphans: orphans };
  }

  var api = { _toMs: _toMs, reconcileProduct: reconcileProduct, mergeCatalogue: mergeCatalogue };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.PosInvSync = api;
})(typeof window !== 'undefined' ? window : this);
