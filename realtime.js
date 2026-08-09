/* ================================================================
   REALTIME WIRING  v1.0
   Upgrades all Firestore one-time fetches to live onSnapshot
   listeners so UI updates instantly with zero lag.
   Auto-loaded on every page via security.js injection.
   ─────────────────────────────────────────────────────────────────
   • Products grid → live (sellers add/edit/delete visible instantly)
   • Hub providers → live (registration shows up without refresh)
   • Hub listings  → live (status changes update on the card)
   • Order status  → live on track.html
   • Provider bookings → live badge/feed for service providers
   • Page hidden   → listeners paused to save battery
   • Page visible  → listeners auto-restart
================================================================ */

(function () {
  'use strict';

  const FS_URL = 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

  let _db    = null;
  let _uid   = null;
  let _ready = false;
  const _unsubs = [];

  function _getDb() {
    if (_db) return _db;
    if (window.firebaseDB) { _db = window.firebaseDB; }
    return _db;
  }

  /* ── Page-type detection (run once) ──────────────────────────── */
  const _path = location.pathname.toLowerCase().replace(/\\/g, '/');
  const _isIndex    = /^\/?$|index\.html/.test(_path) || _path.endsWith('/');
  const _isCategory = _path.includes('category');
  const _isSeller   = _path.includes('seller');
  const _isTrack    = _path.includes('track');

  const HUB_MAP = {
    'car-hub':'car','bnb':'bnb','landlord':'bnb','food-hub':'food',
    'fitness-hub':'fitness','healthcare-hub':'healthcare','legal-hub':'legal',
    'entertainment-hub':'entertainment','sports-hub':'sports',
    'mechanic':'mechanics','cleaning':'cleaning','construction':'construction',
    'home-services':'home','services':'services',
  };
  function _detectHub() {
    const seg = _path.replace(/^\//, '').replace(/\.html$/, '');
    for (const [k, v] of Object.entries(HUB_MAP)) { if (seg.includes(k)) return v; }
    return null;
  }
  const _hub = _detectHub();

  /* ── Debounce helper ──────────────────────────────────────────── */
  function _debounce(fn, ms) {
    let t; return function(...a) { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  }

  /* ── Safe push unsub handle ──────────────────────────────────── */
  function _track(unsub) { if (typeof unsub === 'function') _unsubs.push(unsub); }

  /* ================================================================
     1. PRODUCTS — live catalogue on index + category pages
  ================================================================ */

  /* Merge Firestore products with seller's own local products, then
     call displayProducts() which already exists on index/category */
  /* A product is hidden from buyers only when it EXPLICITLY says so. Soft delete
     sets status to archived/deleted/hidden and isVisible to false; this is where
     that takes effect across Home, category pages and the offline cache. Absent
     status means visible — 119 of 129 live products carry no status field, so a
     "status === 'active' only" rule would wrongly hide them all. */
  const _HIDDEN_STATUS = { archived: 1, deleted: 1, hidden: 1, removed: 1 };
  function _isVisibleProduct(p) {
    if (!p) return false;
    if (p.isVisible === false) return false;
    if (p.status && _HIDDEN_STATUS[String(p.status).toLowerCase()]) return false;
    return true;
  }

  const _renderProducts = _debounce(function(fsProds) {
    const valid = (fsProds || []).filter(p => p && p.name && Number(p.price) > 0 && _isVisibleProduct(p));

    let mine = [];
    try { mine = JSON.parse(localStorage.getItem('sellerProducts') || '[]'); } catch(e) {}
    /* Apply the same visibility rule to the seller's own cached list, so an
       archive made on another device does not reappear here. */
    mine = mine.filter(_isVisibleProduct);
    const myIds = new Set(mine.map(p => String(p.id)));

    const all = [
      ...mine,
      ...valid.filter(p => !myIds.has(String(p.id))),
    ];

    /* Boosted products first, then newest */
    let ads = [];
    try { ads = JSON.parse(localStorage.getItem('sokoniAds') || '[]'); } catch(e) {}
    const boosted = new Set(ads.filter(a => a.endsAt > Date.now()).map(a => a.productId));
    all.sort((a, b) => {
      const da = boosted.has(String(a.id)) ? 1 : 0;
      const db2 = boosted.has(String(b.id)) ? 1 : 0;
      if (da !== db2) return db2 - da;
      return (b.uploadedAt || 0) - (a.uploadedAt || 0);
    });

    /* Cache for offline / product.html lookups — strip base64 image blobs first (they inflate the
       payload ~4KB→200KB each and blow the ~5MB localStorage origin cap; the renderer falls back to
       Storage URL / placeholder). Prevents the documented mobile-OOM / quota bomb. */
    try {
      const _slim = all.map(function(p){
        const q = Object.assign({}, p);
        if (typeof q.image === 'string' && q.image.slice(0,5) === 'data:') delete q.image;
        if (Array.isArray(q.images)) q.images = q.images.filter(function(u){ return typeof u === 'string' && u.slice(0,5) !== 'data:'; });
        return q;
      });
      localStorage.setItem('sokoniProducts', JSON.stringify(_slim));
    } catch(e) {}

    if (typeof window.displayProducts === 'function') {
      window.displayProducts(all.slice(0, 24));
    }

    /* Category page: merge into existing products global */
    if (_isCategory && Array.isArray(window.products)) {
      const existing = new Set(window.products.map(p => String(p.id)));
      all.forEach(p => { if (!existing.has(String(p.id))) window.products.push(p); });
      if (typeof window.displayProducts === 'function') {
        window.displayProducts(window.products.slice(0, 24));
      }
    }
  }, 250);

  async function _listenProducts() {
    const db = _getDb(); if (!db) return;
    try {
      const { collection, onSnapshot, query, where, orderBy, limit, documentId } = await import(FS_URL);
      /* BOUNDED (was an unbounded onSnapshot over the ENTIRE products collection — a duplicate of
         the OOM anti-pattern the canonical SokoniDB.listenProducts already fixed with newest-200).
         Cap at 200, newest first (product ids are Date.now-style, so documentId desc = newest). */
      let q = query(collection(db, 'products'), orderBy(documentId(), 'desc'), limit(200));
      if (_isCategory) {
        const cat = new URLSearchParams(location.search).get('cat')
                 || new URLSearchParams(location.search).get('category');
        /* Category page: equality filter + cap (no orderBy → no composite index needed). */
        if (cat) q = query(collection(db, 'products'), where('category', '==', cat), limit(200));
      }
      _track(onSnapshot(q,
        snap => _renderProducts(
          snap.docs.map(d => { const v = { ...d.data() }; delete v._syncedAt; return v; })
        ),
        e => console.warn('[RT] products:', e.message)
      ));
    } catch(e) { console.warn('[RT] listenProducts:', e.message); }
  }

  /* ================================================================
     2. LISTINGS — live hub listing cards (status, new entries)
  ================================================================ */

  async function _listenListings(hub) {
    const db = _getDb(); if (!db || !hub) return;
    try {
      const { collection, onSnapshot, query, where } = await import(FS_URL);
      _track(onSnapshot(
        query(collection(db, 'listings'), where('hub', '==', hub)),
        snap => {
          let all = {};
          try { all = JSON.parse(localStorage.getItem('hwListings') || '{}'); } catch(e) {}
          snap.forEach(d => { const v = d.data(); all[v.id || d.id] = v; });
          try { localStorage.setItem('hwListings', JSON.stringify(all)); } catch(e) {}

          /* Re-inject manage buttons if user owns any of these */
          if (window.HubWiring && typeof window.HubWiring.initHub === 'function') {
            window.HubWiring.initHub(hub);
          }

          /* Update status badges on cards already in DOM */
          snap.docChanges().forEach(change => {
            const d2 = change.doc.data();
            const id  = d2.id || change.doc.id;
            document.querySelectorAll(
              `[data-listing-id="${CSS.escape ? CSS.escape(id) : id}"] .hw-status-btn,`+
              `[data-id="${CSS.escape ? CSS.escape(id) : id}"] .hw-status-btn`
            ).forEach(btn => {
              btn.textContent = (d2.status || 'available');
              btn.dataset.status = d2.status || 'available';
            });
          });
        },
        e => console.warn('[RT] listings:', e.message)
      ));
    } catch(e) { console.warn('[RT] listenListings:', e.message); }
  }

  /* ================================================================
     3. PROVIDERS — live hub discovery (new registrations show live)
  ================================================================ */

  /* Map hub → localStorage key used by existing render functions */
  const HUB_LS_MAP = {
    car:'sokoniCars', bnb:'sokoniBnBs', food:'sokoniFoodProviders',
    fitness:'sokoniGyms', healthcare:'sokoniHcFacPending',
    legal:'sokoni_firm_registrations', mechanics:'sokoniMechanics',
    services:'sokoniServiceProviders', cleaning:'sokoniCleaners',
    construction:'sokoniConstructors', home:'sokoniHomeProviders',
    entertainment:'sokoniEntProviders', sports:'sokoniSportsProviders',
  };

  async function _listenProviders(hub) {
    const db = _getDb(); if (!db) return;
    try {
      const { collection, onSnapshot, query, where } = await import(FS_URL);
      /* /providers gates reads on status, so an unfiltered list query is denied
         outright — the hub pages showed no providers at all. */
      let q = query(collection(db, 'providers'), where('status', 'in', ['active', 'approved']));
      if (hub) q = query(collection(db, 'providers'), where('status', 'in', ['active', 'approved']), where('hub', '==', hub));
      _track(onSnapshot(q,
        snap => {
          const providers = snap.docs.map(d => { const v = { ...d.data() }; delete v._syncedAt; return v; });
          if (hub) {
            const lsKey = HUB_LS_MAP[hub];
            if (lsKey) {
              try { localStorage.setItem(lsKey, JSON.stringify(providers)); } catch(e) {}
            }
          }
          /* If provider-wiring exposed a render hook, call it */
          if (window.ProviderWiring && typeof window.ProviderWiring.renderProviders === 'function') {
            window.ProviderWiring.renderProviders(hub, providers);
          }
        },
        e => console.warn('[RT] providers:', e.message)
      ));
    } catch(e) { console.warn('[RT] listenProviders:', e.message); }
  }

  /* ================================================================
     4. PROVIDER BOOKINGS — live incoming booking badge
  ================================================================ */

  async function _listenMyBookings() {
    const db = _getDb(); if (!db || !_uid) return;
    try {
      const { collection, onSnapshot, query, where } = await import(FS_URL);
      _track(onSnapshot(
        query(collection(db, 'bookings'), where('providerId', '==', _uid)),
        snap => {
          const bk = snap.docs.map(d => ({ _fsId: d.id, ...d.data() }));
          /* Sort client-side — avoids composite index requirement */
          bk.sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));
          try { localStorage.setItem('sokoniProviderBookings', JSON.stringify(bk)); } catch(e) {}

          /* Update any booking count badge in the DOM */
          const pending = bk.filter(b => b.status === 'pending').length;
          document.querySelectorAll('.booking-count,[data-bookings-count]').forEach(el => {
            el.textContent = pending || '';
            el.style.display = pending ? '' : 'none';
          });

          /* Existing render function */
          if (typeof window.renderBookings === 'function') window.renderBookings(bk);

          /* Toast new bookings arriving live */
          snap.docChanges().forEach(change => {
            if (change.type === 'added') {
              const b = change.doc.data();
              if (b.status === 'pending') _toast('New booking from ' + (b.clientName || 'a client'));
            }
          });
        },
        e => console.warn('[RT] myBookings:', e.message)
      ));
    } catch(e) { console.warn('[RT] listenBookings:', e.message); }
  }

  /* ================================================================
     5. ORDER STATUS — live timeline on track.html
  ================================================================ */

  async function _listenOrder() {
    if (!_isTrack) return;
    const ps = new URLSearchParams(location.search);
    const orderId = ps.get('order') || ps.get('id') || ps.get('orderId');
    if (!orderId) return;
    const db = _getDb(); if (!db) return;
    try {
      const { doc, onSnapshot } = await import(FS_URL);
      _track(onSnapshot(
        doc(db, 'orders', orderId),
        snap => {
          if (!snap.exists()) return;
          const order = snap.data();
          if (typeof window.updateOrderStatus === 'function') {
            window.updateOrderStatus(order);
          } else {
            document.querySelectorAll('[data-order-status],.order-status,.track-status').forEach(el => {
              el.textContent = order.status || '';
            });
          }
        },
        e => console.warn('[RT] order:', e.message)
      ));
    } catch(e) { console.warn('[RT] listenOrder:', e.message); }
  }

  /* ================================================================
     6. DRIVER LOCATION — live map marker on track.html
  ================================================================ */

  async function _listenDriver() {
    if (!_isTrack) return;
    const ps = new URLSearchParams(location.search);
    const driverId = ps.get('driver') || ps.get('driverId');
    if (!driverId) return;
    const db = _getDb(); if (!db) return;
    try {
      const { doc, onSnapshot } = await import(FS_URL);
      const id = String(driverId).replace(/\W/g, '_');
      _track(onSnapshot(
        doc(db, 'driverLocations', id),
        snap => {
          if (!snap.exists()) return;
          const loc = snap.data();
          if (typeof window.updateDriverMarker === 'function') {
            window.updateDriverMarker(loc.lat, loc.lng);
          }
        },
        e => console.warn('[RT] driverLoc:', e.message)
      ));
    } catch(e) { console.warn('[RT] listenDriver:', e.message); }
  }

  /* ================================================================
     7. SELLER STATS — live stock / sold counts on seller.html
  ================================================================ */

  async function _listenMyProducts() {
    if (!_isSeller || !_uid) return;
    const db = _getDb(); if (!db) return;
    try {
      const { collection, onSnapshot, query, where } = await import(FS_URL);
      _track(onSnapshot(
        query(collection(db, 'products'), where('sellerUid', '==', _uid)),
        snap => {
          const prods = snap.docs.map(d => { const v = { ...d.data() }; delete v._syncedAt; return v; });
          /* Merge stock/sold back into sellerProducts for accuracy */
          try {
            const local = JSON.parse(localStorage.getItem('sellerProducts') || '[]');
            const fsMap = Object.fromEntries(prods.map(p => [String(p.id), p]));
            const merged = local.map(p => fsMap[String(p.id)]
              ? { ...p, stock: fsMap[String(p.id)].stock, sold: fsMap[String(p.id)].sold }
              : p
            );
            localStorage.setItem('sellerProducts', JSON.stringify(merged));
          } catch(e) {}

          /* Update live stats if seller page exposes a refresh function */
          if (typeof window.loadProducts === 'function') window.loadProducts();
        },
        e => console.warn('[RT] myProducts:', e.message)
      ));
    } catch(e) { console.warn('[RT] listenMyProducts:', e.message); }
  }

  /* ================================================================
     INLINE TOAST
  ================================================================ */

  function _toast(msg) {
    let t = document.getElementById('_rtToast');
    if (!t) {
      t = document.createElement('div');
      t.id = '_rtToast';
      t.style.cssText = [
        'position:fixed','bottom:80px','left:50%','transform:translateX(-50%)',
        'background:#1e293b','color:#fff','padding:10px 18px',
        'border-radius:24px','font-size:14px','z-index:9999',
        'box-shadow:0 4px 12px rgba(0,0,0,.3)','transition:opacity .3s',
        'pointer-events:none',
      ].join(';');
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.style.opacity = '1';
    clearTimeout(t._to);
    t._to = setTimeout(() => {
      t.style.opacity = '0';
      setTimeout(() => { if (t.parentNode) t.parentNode.removeChild(t); }, 320);
    }, 3000);
  }

  /* ================================================================
     START / STOP
  ================================================================ */

  function _stopAll() {
    _unsubs.splice(0).forEach(fn => { try { fn(); } catch(e) {} });
    _ready = false;
  }

  function _startAll() {
    if (_ready) return;
    if (!_getDb()) return;   /* Firebase not ready yet */
    _ready = true;

    if (_isIndex || _isCategory) _listenProducts();
    if (_hub) {
      _listenListings(_hub);
      _listenProviders(_hub);
    }
    if (_isTrack) { _listenOrder(); _listenDriver(); }
    if (_uid) { _listenMyBookings(); _listenMyProducts(); }
  }

  /* Pause listeners when tab is hidden, restart when visible */
  document.addEventListener('visibilitychange', function() {
    if (document.hidden) {
      _stopAll();
    } else {
      /* Small delay so Firebase connection recovers after sleep */
      setTimeout(_startAll, 500);
    }
  });

  window.addEventListener('beforeunload', _stopAll);

  /* ================================================================
     AUTH WIRING
  ================================================================ */

  /* Chain onto existing onSokoniAuth hook */
  const _prevOnAuth = window.onSokoniAuth;
  window.onSokoniAuth = function(uid) {
    _uid = uid || null;
    _db  = window.firebaseDB || null;
    if (typeof _prevOnAuth === 'function') _prevOnAuth(uid);
    _startAll();
  };

  document.addEventListener('sokoniAuthReady', function(e) {
    const uid = e && e.detail && e.detail.uid;
    if (uid) _uid = uid;
    _db = window.firebaseDB || _db;
    _startAll();
  });

  /* ================================================================
     INIT
  ================================================================ */

  function _init() {
    _db  = window.firebaseDB || null;
    const user = JSON.parse(localStorage.getItem('sokoniUser') || 'null');
    if (user && user.uid) _uid = user.uid;
    _startAll();
    /* Retry after Firebase SDK loads (firebase.js is async) */
    setTimeout(_startAll, 1500);
    setTimeout(_startAll, 4000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _init);
  } else {
    _init();
  }

  /* ── Public API ─────────────────────────────────────────────── */
  window.RealtimeWiring = { start: _startAll, stop: _stopAll };

}());
