/* SOKONI — OwnerCache  v1.0
 *
 * The single fix for the cross-account localStorage leak (audited 2026-07-27):
 * owner-specific data (a seller's products, orders, drafts) used to live under ONE
 * global key (`sellerProducts`), so a previous account's cache became the next
 * account's default input — another seller's listings rendered on a foreign
 * account. Filtering on read was the immediate mitigation; THIS is the end state.
 *
 * Owner data now lives under a uid-namespaced key: `${kind}:${uid}`
 *   products → sellerProducts:{uid}   orders → sellerOrders:{uid}   drafts → sellerDrafts:{uid}
 * so one user's cache can never be read as another user's data. Every page consumes
 * this API instead of touching localStorage directly, and the identity guard becomes
 * a safety net rather than the primary defence.
 *
 * SAFE MIGRATION. During the sweep some pages still read the old global key. To make
 * that impossible to leak:
 *   - get(): reads the namespace; if empty, folds the legacy global in FILTERED to
 *     this uid's own items (foreign items dropped), seeds the namespace, and returns
 *     owner-only data. Never returns another account's items.
 *   - set(): writes the namespace AND clears the legacy global. A not-yet-migrated
 *     reader then sees EMPTY (safe) rather than foreign data — never a leak.
 * Once every site is migrated the legacy global is fully retired.
 *
 * Include on every page that reads/writes owner data:
 *   <script src="sokoni-owner-cache.js"></script>
 */
(function () {
  'use strict';

  /* kind → legacy global key it replaces (used only for one-way migration). */
  var LEGACY = { products: 'sellerProducts', orders: 'sellerOrders', drafts: 'sellerDrafts' };

  function _key(kind, uid) { return kind + ':' + String(uid || ''); }
  function _read(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (_) { return null; } }
  function _write(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) {} }
  function _del(k) { try { if (k) localStorage.removeItem(k); } catch (_) {} }

  /* An item belongs to `uid` iff its own stamped owner matches. Upload stamps both
     `sellerUid` and `uid`; an unstamped item is treated as NOT owned and dropped
     rather than risk leaking it. */
  function _ownedBy(item, uid) {
    return String((item && (item.sellerUid || item.uid)) || '') === String(uid);
  }

  var OwnerCache = {
    /* Owner-scoped read. Always returns ONLY this uid's own items. */
    get: function (kind, uid) {
      if (!uid) return [];
      var ns = _read(_key(kind, uid));
      if (Array.isArray(ns)) return ns;
      /* Namespace empty — fold in the legacy global, filtered to this owner. */
      var legacy = _read(LEGACY[kind] || '');
      if (Array.isArray(legacy)) {
        var owned = legacy.filter(function (p) { return _ownedBy(p, uid); });
        if (owned.length) { _write(_key(kind, uid), owned); return owned; }
      }
      return [];
    },
    /* Owner-scoped write. Also clears the legacy global so no stale/foreign copy
       survives for a not-yet-migrated reader. */
    set: function (kind, uid, val) {
      if (!uid) return;
      _write(_key(kind, uid), Array.isArray(val) ? val : (val || []));
      _del(LEGACY[kind]);
    },
    clear: function (kind, uid) { _del(_key(kind, uid)); },
    clearAll: function (uid) { Object.keys(LEGACY).forEach(function (k) { OwnerCache.clear(k, uid); }); },

    /* Convenience wrappers for the common kinds. */
    getProducts: function (uid) { return OwnerCache.get('products', uid); },
    setProducts: function (uid, v) { return OwnerCache.set('products', uid, v); },
    getOrders:   function (uid) { return OwnerCache.get('orders', uid); },
    setOrders:   function (uid, v) { return OwnerCache.set('orders', uid, v); },
  };

  window.OwnerCache = OwnerCache;
})();
