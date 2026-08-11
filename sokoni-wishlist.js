/* ══════════════════════════════════════════════════════════════════════════════
   SOKONI — Wishlist service  (the ONE wishlist authority for buyer UI)
   ------------------------------------------------------------------------------
   Canonical record:  wishlistItems/{uid}_{productId}
   Reached through:   commerceDispatch({op:'wishlistAdd'|'wishlistRemove'|'wishlistGet'})

   No new collection, no new resolver. The server model already existed and was
   already correct — deterministic document ids make add and remove idempotent by
   construction, and `where('uid','==',auth.uid)` scopes every read to the caller.
   There is deliberately NO firestore rule for wishlistItems: it is a CF-only
   collection, so a client cannot reach it except through the authenticated,
   App-Check-enforced dispatch above. That is the boundary, not an oversight.

   WHAT WAS WRONG
   The buyer UI never used any of it. Four models were live at once:

     localStorage['wishlist']         product.js, category.js, cart.js, market-actions.js
     localStorage['sokoniWishlist']   inspiq.js — a different key entirely
     wishlistItems/{uid}_{productId}  the canonical server model — unused by the UI
     wishlists/{uid}/items/{itemId}   KASS "save_to_wishlist" (index.js) — separate feature

   Because the UI read localStorage, wishlist state was per-DEVICE, not per-USER: a
   clean sokoniSignOut() wiped it, but a force-quit, a session restored as a different
   account, or any path that skipped the sign-out handler left one shopper looking at
   another's saved items. Same shape as the Shop Details defect.

   OWNERSHIP
   uid comes from Firebase Auth and nothing else — never localStorage.sokoniUser (a
   cached profile blob is not an identity), never a URL parameter, never a shop or
   seller id.

   LOCALSTORAGE
   Kept ONLY as a paint cache so hearts do not flicker on load. It is stamped with the
   owning uid and is discarded whenever that uid does not match the live session, so it
   can never resurrect another account's wishlist. It never decides whether something is
   wishlisted; Firestore does.
   ══════════════════════════════════════════════════════════════════════════════ */
(function (root) {
  'use strict';

  var CACHE_KEY = 'sokoniWishlistCache';   /* {ownerUid, ids:[], items:[], at} */
  var LEGACY_KEYS = ['wishlist', 'sokoniWishlist'];

  var _ids = null;        /* Set of productIds for the CURRENT uid, or null = unknown */
  var _items = [];
  var _loaded = false;
  var _inflight = null;

  function _uid() {
    try {
      return (root.firebaseAuth && root.firebaseAuth.currentUser && root.firebaseAuth.currentUser.uid) || null;
    } catch (e) { return null; }
  }

  function _emit() {
    try {
      root.dispatchEvent(new CustomEvent('sokoni:wishlist-changed', {
        detail: { count: _ids ? _ids.size : 0, ids: _ids ? Array.from(_ids) : [] },
      }));
    } catch (e) {}
  }

  /* ── cache (never authority) ───────────────────────────────────────────────── */
  function _readCache(uid) {
    if (!uid) return null;
    try {
      var raw = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
      if (!raw || raw.ownerUid !== uid) return null;   /* another account, or unstamped */
      return raw;
    } catch (e) { return null; }
  }
  function _writeCache(uid) {
    if (!uid) return;
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify({
        ownerUid: uid, ids: Array.from(_ids || []), items: _items, at: Date.now(),
      }));
    } catch (e) {}
  }
  function clearCache() {
    try { localStorage.removeItem(CACHE_KEY); } catch (e) {}
    LEGACY_KEYS.forEach(function (k) { try { localStorage.removeItem(k); } catch (e) {} });
    _ids = null; _items = []; _loaded = false;
    _emit();
  }

  function _dispatch(op, payload) {
    if (typeof root.sokoniCallable === 'function') {
      return root.sokoniCallable('commerceDispatch')(
        Object.assign({ op: op }, payload || {})).then(function (r) { return r && r.data; });
    }
    if (root.firebase && root.firebase.functions) {
      return root.firebase.functions().httpsCallable('commerceDispatch')(
        Object.assign({ op: op }, payload || {})).then(function (r) { return r && r.data; });
    }
    return Promise.reject(new Error('SOKONI is still loading'));
  }

  /* ── read ──────────────────────────────────────────────────────────────────── */
  function load(force) {
    var uid = _uid();
    if (!uid) { _ids = new Set(); _items = []; _loaded = true; return Promise.resolve([]); }
    if (_loaded && !force) return Promise.resolve(_items);
    if (_inflight) return _inflight;

    /* Paint from cache only when it is provably this account's. */
    var cached = _readCache(uid);
    if (cached && !_loaded) {
      _ids = new Set(cached.ids || []); _items = cached.items || []; _emit();
    }

    _inflight = _dispatch('wishlistGet').then(function (d) {
      var items = (d && d.items) || [];
      _items = items;
      _ids = new Set(items.map(function (i) { return i.productId; }));
      _loaded = true; _inflight = null;
      _writeCache(uid);
      _emit();
      return items;
    }).catch(function (e) {
      _inflight = null;
      /* Do NOT fabricate an empty wishlist on failure — an empty list is a claim, and
         a wrong one here makes every heart look un-saved and invites a duplicate add. */
      console.warn('[wishlist] load failed:', e && (e.code || e.message));
      throw e;
    });
    return _inflight;
  }

  function isWishlisted(productId) {
    if (!productId || !_ids) return false;
    return _ids.has(String(productId));
  }
  function list()  { return _items.slice(); }
  function count() { return _ids ? _ids.size : 0; }

  /* ── write ─────────────────────────────────────────────────────────────────── */
  function add(product) {
    var uid = _uid();
    var pid = product && (product.productId || product.id);
    if (!uid) return Promise.reject(new Error('Sign in to save items'));
    if (!pid) return Promise.reject(new Error('productId is required'));

    return _dispatch('wishlistAdd', {
      productId: String(pid),
      shopId: product.shopId || null,
      name:   product.name || '',
      price:  product.price != null ? product.price : null,
      image:  product.image || product.imageUrl || null,
    }).then(function () {
      /* Local state is updated only AFTER the canonical write resolves — never before,
         so a heart cannot show "saved" for something the server refused. */
      if (!_ids) _ids = new Set();
      if (!_ids.has(String(pid))) {
        _ids.add(String(pid));
        _items.unshift({ id: uid + '_' + pid, uid: uid, productId: String(pid),
          shopId: product.shopId || null, name: product.name || '',
          price: product.price != null ? product.price : null,
          image: product.image || product.imageUrl || null });
      }
      _writeCache(uid); _emit();
      return true;
    });
  }

  function remove(productId) {
    var uid = _uid();
    var pid = String(productId || '');
    if (!uid) return Promise.reject(new Error('Sign in to manage saved items'));
    if (!pid) return Promise.reject(new Error('productId is required'));

    return _dispatch('wishlistRemove', { productId: pid }).then(function () {
      if (_ids) _ids.delete(pid);
      _items = _items.filter(function (i) { return String(i.productId) !== pid; });
      _writeCache(uid); _emit();
      return true;
    });
  }

  function toggle(product) {
    var pid = String((product && (product.productId || product.id)) || '');
    return isWishlisted(pid) ? remove(pid).then(function () { return false; })
                             : add(product).then(function () { return true; });
  }

  /* ── session ───────────────────────────────────────────────────────────────── */
  var _seenUid, _first = true;
  function _watch() {
    var a = root.firebaseAuth;
    if (!a || typeof a.onAuthStateChanged !== 'function') { setTimeout(_watch, 300); return; }
    try {
      a.onAuthStateChanged(function (u) {
        var uid = (u && u.uid) || null;
        if (_first) { _first = false; _seenUid = uid; if (uid) load(true).catch(function(){}); return; }
        if (uid === _seenUid) return;
        _seenUid = uid;
        /* Account changed. Drop the previous account's state BEFORE any repaint, then
           reload from the server for whoever is signed in now. */
        clearCache();
        if (uid) load(true).catch(function () {});
      });
    } catch (e) {}
  }
  _watch();

  /* ── One-time authenticated legacy migration ────────────────────────────────
     wishlists/{uid}.items[]  →  wishlistItems/{uid}_{productId}

     The caller reads the legacy document and passes its items[] in. That split is
     deliberate: this service must not learn about Firestore, and — more importantly —
     the legacy page keeps a two-way localStorage⇄Firestore sync, so accepting a
     pre-read array from the CALLER would invite localStorage to become the migration
     source. The caller is required to pass the FIRESTORE document's items, read for
     auth.currentUser.uid only. Ownership here is the live Auth uid regardless of
     anything inside the payload.

     Idempotent by construction: every write goes through add(), whose deterministic
     {uid}_{productId} id makes a repeat a no-op rather than a duplicate. Completion is
     therefore DERIVED from canonical state, not from a stored "migrated" flag that
     could strand a partial run forever.

     Never deletes or rewrites the legacy document — this migrates authority, not
     history. Partial failure is safe and retryable: succeeded items stay canonical,
     failures are reported, and the next run skips what already exists. */
  function migrateLegacy(legacyItems) {
    var uid = _uid();
    if (!uid) return Promise.reject(new Error('Sign in required'));
    if (!Array.isArray(legacyItems)) {
      /* A failed legacy read must NOT arrive here as []. The caller reports that; if it
         reaches us as a non-array we refuse rather than concluding "nothing to migrate". */
      return Promise.reject(new Error('legacy items unavailable'));
    }

    /* Canonical state must be KNOWN before deciding what is missing. If load() rejects,
       migration does not start — treating an unknown wishlist as empty would re-add
       everything the user already has. */
    return load().then(function () {
      var migrated = [], skipped = [], failed = [], already = [];

      var chain = legacyItems.reduce(function (p, raw) {
        return p.then(function () {
          var pid = raw && (raw.productId || raw.id);
          pid = pid == null ? '' : String(pid).trim();
          if (!pid) { skipped.push({ reason: 'no-productId', item: raw }); return; }
          if (isWishlisted(pid)) { already.push(pid); return; }

          return add({
            productId: pid,
            shopId: raw.shopId || null,
            name:   raw.name || '',
            price:  raw.price != null ? raw.price : null,
            image:  raw.image || raw.imageUrl || null,
          }).then(function () { migrated.push(pid); })
            .catch(function (e) {
              /* Keep going: one bad item must not abandon the rest, and the legacy
                 document is untouched so this remains retryable next load. */
              failed.push({ productId: pid, code: (e && (e.code || e.message)) || 'error' });
            });
        });
      }, Promise.resolve());

      return chain.then(function () {
        return {
          migrated: migrated, alreadyCanonical: already,
          skipped: skipped, failed: failed,
          complete: failed.length === 0,
        };
      });
    });
  }

  root.SokoniWishlist = {
    load: load, list: list, count: count, isWishlisted: isWishlisted,
    add: add, remove: remove, toggle: toggle, clearCache: clearCache,
    migrateLegacy: migrateLegacy,
    CACHE_KEY: CACHE_KEY, LEGACY_KEYS: LEGACY_KEYS,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = root.SokoniWishlist;
})(typeof window !== 'undefined' ? window : globalThis);
