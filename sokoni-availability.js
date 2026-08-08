/* ════════════════════════════════════════════════════════════════════════
   SOKONI AvailabilityService — the merchant shop/product availability authority
   (client read + derive; canonical writes added in Layer 2).

   ONE canonical model, no competing collection:
     shops/{sellerUid}   → acceptingOrders, online, delivery, pickup
                           (ABSENT = true — existing shops stay open on migration)
     products/{id}       → status, isVisible, stock, minStockLevel

   Derived product state (pure, no I/O — unit-testable):
     status=active + isVisible + stock>0   → 'available'
     stock <= 0                            → 'out'
     stock <= minStockLevel                → 'low'
     isVisible=false / status=archived     → 'unavailable'

   Changes propagate via [[sokoni-sync]] (SokoniSync). Shop availability and product
   availability are SEPARATE states: turning the shop off never mutates products.
   ════════════════════════════════════════════════════════════════════════ */
(function (root) {
  'use strict';

  var SHOP_DEFAULTS = { acceptingOrders: true, online: true, delivery: true, pickup: true };

  /* Normalise a raw shop doc into the canonical shop-state, applying safe defaults
     (absent field = true) so an un-migrated shop reads as fully open. */
  function normalizeShop (raw) {
    raw = raw || {};
    return {
      acceptingOrders: raw.acceptingOrders !== false,
      online:          raw.online          !== false,
      delivery:        raw.delivery        !== false,
      pickup:          raw.pickup          !== false
    };
  }

  /* Pure derivation — the single definition of a product's availability state. */
  function deriveProduct (p) {
    p = p || {};
    var visible = p.isVisible !== false;                 /* absent = visible */
    if (!visible || p.status === 'archived') return 'unavailable';
    var stock = Number(p.stock || 0);
    if (stock <= 0) return 'out';                        /* out-of-stock before low */
    var min = (p.minStockLevel != null) ? Number(p.minStockLevel) : null;
    if (min != null && stock <= min) return 'low';
    if ((p.status || 'active') === 'active') return 'available';
    return 'unavailable';                                /* pending / draft etc. */
  }

  /* Tally derived states across a product list. */
  function counts (products) {
    var c = { available: 0, low: 0, out: 0, unavailable: 0, total: 0 };
    (products || []).forEach(function (p) {
      var s = deriveProduct(p);
      c[s] = (c[s] || 0) + 1; c.total++;
    });
    return c;
  }

  function _uid () {
    try { return (root.firebaseAuth && root.firebaseAuth.currentUser && root.firebaseAuth.currentUser.uid) || null; } catch (_) { return null; }
  }
  async function _fs () { return await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js'); }

  /* Read the canonical shop-state for a seller (defaults applied). */
  async function readShop (uid) {
    uid = uid || _uid();
    if (!uid || !root.firebaseDB) return normalizeShop(null);   /* headless / logged-out → open defaults */
    try {
      var m = await _fs();
      var snap = await m.getDoc(m.doc(root.firebaseDB, 'shops', uid));
      return normalizeShop(snap.exists() ? snap.data() : null);
    } catch (_) { return normalizeShop(null); }
  }

  /* Read this seller's products (canonical) with derived availability attached. */
  async function readProducts (uid) {
    uid = uid || _uid();
    if (!uid || !root.firebaseDB) return [];
    try {
      var m = await _fs();
      var q = m.query(m.collection(root.firebaseDB, 'products'), m.where('sellerUid', '==', uid), m.limit(500));
      var snap = await m.getDocs(q);
      return snap.docs.map(function (d) {
        var p = Object.assign({ id: d.id }, d.data());
        p._state = deriveProduct(p);
        return p;
      });
    } catch (_) { return []; }
  }

  root.AvailabilityService = {
    SHOP_DEFAULTS: SHOP_DEFAULTS,
    normalizeShop: normalizeShop,
    deriveProduct: deriveProduct,
    counts: counts,
    readShop: readShop,
    readProducts: readProducts
    /* Layer 2 will add: setShop(uid, patch) and setProductAvailability(id, patch),
       each writing the canonical doc and emitting SokoniSync.{shopChanged,productChanged}. */
  };
})(typeof window !== 'undefined' ? window : this);
