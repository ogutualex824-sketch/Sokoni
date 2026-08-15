/* ================================================================
   SELLER WIRING  v1.0
   Bridges seller product management ↔ Firestore public products
   collection so ALL buyers can discover products from ALL sellers.
   Auto-loaded on every page via security.js injection.
   ─────────────────────────────────────────────────────────────────
   WHAT IT DOES
   • Patches addProduct()      → writes new product to products/{id}
   • Patches saveEditProduct() → updates product in products/{id}
   • Patches deleteProduct()   → archives products/{id} (tombstone, never a hard delete)
   • Patches loadProducts()    → merges all sellers' Firestore products
   ─────────────────────────────────────────────────────────────────
   WHAT IT DELIBERATELY DOES **NOT** DO
   • It does NOT touch inventory. The saveAndRedirect patch that decremented
     products/{id}.stock from the browser is removed — see _decrementStock below.
     Inventory has exactly ONE writer: the server transaction in
     functions/index.js::_finalizeMarketplacePayment.
   • On login: syncs any local sellerProducts to Firestore
================================================================ */

(function () {
  'use strict';

  const FS_URL = 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
  let _db  = null;
  let _uid = null;

  function _getDb() {
    if (_db) return _db;
    if (window.firebaseDB) { _db = window.firebaseDB; return _db; }
    return null;
  }

  /* ── Safe truncate for Firestore size limit ─────────────────── */
  function _trimPayload(product) {
    const p = {
      id:          String(product.id || ''),
      name:        String(product.name || ''),
      price:       Number(product.price) || 0,
      costPrice:   Number(product.costPrice) || 0,
      deliveryCost:Number(product.deliveryCost) || 0,
      stock:       product.stock !== undefined ? Number(product.stock) : 9999,
      sold:        Number(product.sold) || 0,
      outOfStock:  Boolean(product.outOfStock),
      isService:   Boolean(product.isService),
      isDigital:   Boolean(product.isDigital),
      category:    String(product.category || 'other'),
      location:    String(product.location || 'nairobi'),
      description: String(product.description || '').slice(0, 1000),
      kebsCert:    String(product.kebsCert || ''),
      sellerName:  String(product.sellerName || ''),
      sellerEmail: String(product.sellerEmail || ''),
      sellerUid:   String(_uid || product.sellerUid || ''),
      views:       Number(product.views) || 0,
      uploadedAt:  product.uploadedAt || Date.now(),
      image:       String(product.image || '').slice(0, 200000),
    };

    /* Include images array only if it fits in 900 KB */
    const base = JSON.stringify(p).length;
    if (product.images && Array.isArray(product.images)) {
      const imgStr = JSON.stringify(product.images);
      if (base + imgStr.length < 900 * 1024) p.images = product.images;
    }
    return p;
  }

  /* ── Write one product to Firestore public products collection ── */
  async function _writeProduct(product) {
    const db = _getDb();
    if (!db || !product || !product.id) return;
    try {
      const { doc, setDoc, getDoc, serverTimestamp } = await import(FS_URL);
      const ref = doc(db, 'products', String(product.id));
      const payload = _trimPayload(product);
      payload._syncedAt = serverTimestamp();
      /* Firestore is AUTHORITATIVE for money / inventory / ownership. A stale local
         cache must NOT overwrite those on an EXISTING product — this sync was
         reverting server-set values (observed: price 100 -> cached 2000; sellerUid).
         For an existing doc, sync only descriptive fields; write everything on first
         create. Legitimate price/stock/owner edits go through the server edit path. */
      try {
        const _snap = await getDoc(ref);
        if (_snap.exists()) {
          delete payload.price; delete payload.costPrice; delete payload.deliveryCost;
          delete payload.stock; delete payload.outOfStock; delete payload.sold;
          delete payload.sellerUid;
        }
      } catch(_) {}
      await setDoc(ref, payload, { merge: true });
      /* Drop the warm search cache for products, or the seller searches for the
         item they just listed and is served the pre-write scan (up to 10 min
         in-session / 30 min from localStorage) — which reads as "search is
         broken" when the write actually succeeded. */
      try { window.SokoniFirestoreSearch?.invalidateScanCache?.('products'); } catch(_) {}
    } catch(e) {
      console.warn('[SellerWiring] write failed:', e.message);
    }
  }

  /* ── Retire one product (canonical SOFT delete) ─────────────────
     Was a hard deleteDoc, which raced the soft-archive in seller.js deleteProduct() and
     DESTROYED the archived record (and its sales/order history) that the lifecycle contract
     preserves. The canonical semantics are archive (status:'archived', isVisible:false) so
     history survives and the item can be relisted. seller.js now owns that write + the
     SokoniSync propagation; this wrapper must NOT hard-delete. Kept as a safety net that
     archives (idempotent) only if some caller reaches here without seller.js having run. */
  async function _deleteProduct(productId) {
    const db = _getDb();
    if (!db || !productId) return;
    try {
      const { doc, updateDoc, serverTimestamp } = await import(FS_URL);
      await updateDoc(doc(db, 'products', String(productId)), { status: 'archived', isVisible: false, archivedAt: serverTimestamp(), updatedAt: serverTimestamp() });
    } catch(e) {
      console.warn('[SellerWiring] retire failed:', e.message);
    }
  }

  /* ── _decrementStock IS REMOVED — the client is not an inventory writer ──────
     It did, from the browser, on every checkout:

         updateDoc(doc(db, 'products', item.id), {
           stock: increment(-1),          // per LINE ITEM, ignoring item.qty
           sold:  increment(1),
         }).catch(() => {});              // fire-and-forget

     Three demonstrated defects, all on the money path:

       1. QUANTITY-BLIND. `increment(-1)` per line regardless of qty. An order for 3
          units decremented 1 on the client and 3 on the server — stock -4, sold +4.
       2. FIRES BEFORE PAYMENT. It ran from the saveAndRedirect wrapper at cart-save
          time, so an abandoned or failed checkout permanently consumed stock with no
          order behind it.
       3. DUPLICATE AUTHORITY. _finalizeMarketplacePayment already deducts the true
          quantity inside ONE transaction, floored at zero, with inventoryVersion,
          inventoryApplied idempotency and oversoldAlerts. This second writer had none
          of that: no transaction, no version, no idempotency, and errors swallowed.

     Reachability was measured in a real browser on checkout.html, not assumed:
     seller-wiring loaded=true, scriptTag=true, saveAndRedirect.__sw=true — the wrapper
     was installed and would have invoked this on every order. Whether each write LANDED
     depended only on the App Check token, which is valid for a real user.

     The saveAndRedirect wrapper existed solely to call this, so it is removed too rather
     than left as an empty patch waiting to be refilled.

     INVENTORY HAS EXACTLY ONE WRITER: the server transaction in
     functions/index.js::_finalizeMarketplacePayment. Quantity reaches it through
     createCheckoutSession, which already re-reads every price and clamps every quantity
     server-side. Pinned by scripts/test-inventory-single-writer.js. */

  /* ── Pull all products from Firestore → merge into display ─── */
  /* NOTE: realtime.js now sets up onSnapshot for index/category.
     This function is kept as a one-shot fallback for pages not
     covered by realtime.js (e.g. search.html, direct links). */
  async function _pullProducts() {
    const db = _getDb();
    if (!db) return null;
    try {
      const { collection, getDocs } = await import(FS_URL);
      const snap = await getDocs(collection(db, 'products'));
      const prods = snap.docs
        .map(d => { const v = { ...d.data() }; delete v._syncedAt; return v; })
        .filter(p => p && p.name && Number(p.price) > 0);
      try { localStorage.setItem('sokoniProducts', JSON.stringify(prods)); } catch(e) {}
      return prods;
    } catch(e) {
      console.warn('[SellerWiring] pull failed:', e.message);
      return null;
    }
  }

  /* ── Sync all local sellerProducts to Firestore on login ─────── */
  function _syncLocalProducts() {
    if (!_uid || !_getDb()) return;
    try {
      const prods = JSON.parse(localStorage.getItem('sellerProducts') || '[]');
      prods.forEach(p => _writeProduct(p));
    } catch(e) {}
  }

  /* ═══════════════════════════════════════════════════════════════
     PATCH: seller.js  addProduct / saveEditProduct / deleteProduct
  ═══════════════════════════════════════════════════════════════ */

  function _patchSeller() {
    /* addProduct */
    if (window.addProduct && !window.addProduct.__sw) {
      const orig = window.addProduct;
      window.addProduct = async function(...a) {
        await orig.apply(this, a);
        try {
          const prods = JSON.parse(localStorage.getItem('sellerProducts') || '[]');
          const p = prods[prods.length - 1];
          if (p) _writeProduct(p);
        } catch(e) {}
      };
      window.addProduct.__sw = true;
    }

    /* saveEditProduct */
    if (window.saveEditProduct && !window.saveEditProduct.__sw) {
      const orig = window.saveEditProduct;
      window.saveEditProduct = function(...a) {
        orig.apply(this, a);
        setTimeout(() => {
          try {
            const idx = typeof window._editIndex === 'number' ? window._editIndex : -1;
            const prods = JSON.parse(localStorage.getItem('sellerProducts') || '[]');
            const p = idx >= 0 && prods[idx] ? prods[idx] : prods[prods.length - 1];
            if (p) _writeProduct(p);
          } catch(e) {}
        }, 300);
      };
      window.saveEditProduct.__sw = true;
    }

    /* deleteProduct */
    if (window.deleteProduct && !window.deleteProduct.__sw) {
      const orig = window.deleteProduct;
      window.deleteProduct = function(index, ...a) {
        let prodId;
        try {
          const prods = JSON.parse(localStorage.getItem('sellerProducts') || '[]');
          if (prods[index]) prodId = String(prods[index].id);
        } catch(e) {}
        const result = orig.apply(this, [index, ...a]);
        if (prodId) _deleteProduct(prodId);
        return result;
      };
      window.deleteProduct.__sw = true;
    }
  }

  /* ═══════════════════════════════════════════════════════════════
     PATCH: checkout.html  saveAndRedirect → decrement Firestore stock
  ═══════════════════════════════════════════════════════════════ */

  /* _patchCheckout IS REMOVED, not emptied.

     Its wrapper existed for exactly one purpose: to snapshot the cart before
     saveAndRedirect cleared it and hand that snapshot to _decrementStock. With the
     client no longer an inventory writer there is nothing for it to do, and leaving an
     empty patch behind would be an invitation to refill it.

     saveAndRedirect is therefore left UNWRAPPED. Nothing else depended on the wrapper:
     it returned the original result unchanged and its only side effect was the stock
     write. Quantity reaches the server through createCheckoutSession, which re-reads
     every price and clamps every quantity server-side. */
  function _patchCheckout() { /* intentionally does nothing — see above */ }

  /* ═══════════════════════════════════════════════════════════════
     PATCH: script.js  loadProducts → merge Firestore products
  ═══════════════════════════════════════════════════════════════ */

  function _patchLoadProducts() {
    if (window.loadProducts && !window.loadProducts.__sw) {
      const orig = window.loadProducts;
      window.loadProducts = function(...a) {
        orig.apply(this, a);                /* show local products first */
        if (!navigator.onLine) return;
        _pullProducts().then(fsProds => {
          if (!fsProds || !fsProds.length) return;

          let myProds = [];
          try { myProds = JSON.parse(localStorage.getItem('sellerProducts') || '[]'); } catch(e) {}
          const myIds = new Set(myProds.map(p => String(p.id)));

          /* Merge: own products keep full images; others come from Firestore */
          const all = [
            ...myProds,
            ...fsProds.filter(p => !myIds.has(String(p.id)))
          ];

          /* Sort: boosted first, then newest */
          let ads = [];
          try { ads = JSON.parse(localStorage.getItem('sokoniAds') || '[]'); } catch(e) {}
          const boosted = new Set(ads.filter(a => a.endsAt > Date.now()).map(a => a.productId));
          all.sort((a, b) => {
            const ab = boosted.has(String(a.id)) ? 1 : 0;
            const bb = boosted.has(String(b.id)) ? 1 : 0;
            if (ab !== bb) return bb - ab;
            return (b.uploadedAt || 0) - (a.uploadedAt || 0);
          });

          if (typeof window.displayProducts === 'function') {
            window.displayProducts(all.slice(0, 20));
          }
        }).catch(() => {});
      };
      window.loadProducts.__sw = true;
    }
  }

  /* ── Also patch category.html displayProducts wrapper ───────── */
  function _patchCategoryPage() {
    if (!location.pathname.match(/category/i)) return;
    if (window._swCategoryPatched) return;
    window._swCategoryPatched = true;

    _pullProducts().then(fsProds => {
      if (!fsProds || !fsProds.length) return;
      let myProds = [];
      try { myProds = JSON.parse(localStorage.getItem('sellerProducts') || '[]'); } catch(e) {}
      const myIds = new Set(myProds.map(p => String(p.id)));
      const all   = [...myProds, ...fsProds.filter(p => !myIds.has(String(p.id)))];

      /* Inject into the page's products global if it exists */
      if (Array.isArray(window.products)) {
        const existing = new Set(window.products.map(p => String(p.id)));
        all.forEach(p => { if (!existing.has(String(p.id))) window.products.push(p); });
        if (typeof window.displayProducts === 'function') {
          window.displayProducts(window.products.slice(0, 20));
        }
      }
    }).catch(() => {});
  }

  /* ═══════════════════════════════════════════════════════════════
     AUTH WIRING
  ═══════════════════════════════════════════════════════════════ */

  /* Hook into firebase.js auth state observer */
  const _prevOnSokoniAuth = window.onSokoniAuth;
  window.onSokoniAuth = function(uid) {
    _uid = uid || null;
    _db  = window.firebaseDB || null;
    if (typeof _prevOnSokoniAuth === 'function') _prevOnSokoniAuth(uid);
  };

  document.addEventListener('sokoniAuthReady', function(e) {
    const uid = e && e.detail && e.detail.uid;
    if (uid) {
      _uid = uid;
      _db  = window.firebaseDB || null;
      _syncLocalProducts();
    }
  });

  /* If firebase.js fires SokoniSync init, piggyback on it */
  const _prevSyncInit = window.SokoniSync && window.SokoniSync.init;
  if (window.SokoniSync) {
    const origInit = window.SokoniSync.init;
    window.SokoniSync.init = function(db, uid) {
      _db  = db;
      _uid = uid;
      origInit && origInit.call(window.SokoniSync, db, uid);
      _syncLocalProducts();
    };
  }
  window.addEventListener('sokoniSyncLoaded', function() {
    if (window.SokoniSync && !window.SokoniSync.init.__sw) {
      const origInit = window.SokoniSync.init;
      window.SokoniSync.init = function(db, uid) {
        _db  = db;
        _uid = uid;
        origInit && origInit.call(window.SokoniSync, db, uid);
        _syncLocalProducts();
      };
      window.SokoniSync.init.__sw = true;
    }
  });

  /* ═══════════════════════════════════════════════════════════════
     INIT
  ═══════════════════════════════════════════════════════════════ */

  function _init() {
    /* Pick up DB + UID immediately if already available */
    _db  = window.firebaseDB || null;
    const user = JSON.parse(localStorage.getItem('sokoniUser') || 'null');
    if (user && user.uid) _uid = user.uid;

    /* Apply patches */
    _patchSeller();
    _patchCheckout();
    _patchLoadProducts();
    _patchCategoryPage();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _init);
  } else {
    _init();
  }

  /* Second pass — catch scripts that load late */
  setTimeout(function() {
    _patchSeller();
    _patchCheckout();
    _patchLoadProducts();
  }, 1500);

  /* ── Public API ── */
  window.SellerWiring = {
    writeProduct  : _writeProduct,
    deleteProduct : _deleteProduct,
    pullProducts  : _pullProducts,
    syncLocal     : _syncLocalProducts,
  };

}());
