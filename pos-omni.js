/**
 * SOKONI SmartPOS — Omnichannel Sync Engine v1.0
 *
 * Bidirectional sync between SmartPOS and the Sokoni Marketplace:
 *   • pushStock(productId)  — updates Firestore products/{marketplaceId}.stock after each sale
 *   • startSync(bizPin)     — subscribes to new marketplace orders for this seller
 *   • pullOrders(bizPin)    — one-shot fetch of pending marketplace orders
 *   • stopSync()            — unsubscribes all listeners
 *   • getStatus()           — returns current sync state
 *
 * Products become "marketplace-linked" when their local PosDB record carries a
 * `marketplaceId` field containing the corresponding Firestore products/{id}.
 * When a sale deducts stock, pushStock() propagates the new level to the marketplace
 * so buyers see accurate availability in real time.
 *
 * Security model:
 *   All writes go under the authenticated seller's Firebase UID.
 *   Products: seller may update own product via Firestore rules (uid == auth.uid).
 *   Orders:   seller reads own pending orders (sellerId == auth.uid).
 */
(function () {
  'use strict';

  /* ── Firestore SDK (lazy-loaded, shared module cache) ────────── */
  let _fs = null;
  async function _ensureFS() {
    if (_fs) return _fs;
    try {
      _fs = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js');
      return _fs;
    } catch (_) { return null; }
  }

  function _db() {
    return window._firestoreDb || window.sokoniDb || null;
  }

  function _authUid() {
    try {
      if (window.firebase?.auth?.()?.currentUser?.uid) return window.firebase.auth().currentUser.uid;
      if (window._firebaseAuth?.currentUser?.uid)      return window._firebaseAuth.currentUser.uid;
      return localStorage.getItem('pos_seller_uid') || null;
    } catch (_) { return null; }
  }

  /* ── State ───────────────────────────────────────────────────── */
  const _state = {
    running:      false,
    bizPin:       null,
    ordersSub:    null,   // Firestore unsubscribe function
    productsSub:  null,   // Firestore unsubscribe function
    lastPush:     0,
    pushCount:    0,
    pullCount:    0,
    errors:       0,
  };

  /* ── Stock Push ──────────────────────────────────────────────── */
  /**
   * Called by pos.js after every sale for items that carry a marketplaceId.
   * Reads current stock from PosDB → writes to Firestore products/{marketplaceId}.
   */
  async function pushStock(posProductId) {
    if (!posProductId) return;

    const db = _db();
    if (!db) return;
    if (!navigator.onLine) {
      _queuePush(posProductId);
      return;
    }

    const fs = await _ensureFS();
    if (!fs) return;

    try {
      const product = await PosDB.products.getById(posProductId);
      if (!product?.marketplaceId) return; // not linked to marketplace

      const uid = _authUid();
      const ref = fs.doc(db, 'products', product.marketplaceId);

      /* Seller-authenticated write — Firestore rules: uid == auth.uid */
      await fs.updateDoc(ref, {
        stock:      product.stock ?? 0,
        updatedAt:  fs.serverTimestamp(),
        posLastSync: new Date().toISOString(),
      });

      _state.lastPush = Date.now();
      _state.pushCount++;
      _emit('stock:pushed', { posProductId, marketplaceId: product.marketplaceId, stock: product.stock });
      if (window.PosHealth) PosHealth.recordMetric('omni_stock_push', 1);

    } catch (err) {
      _state.errors++;
      console.error('[PosOmni] pushStock failed:', err);
      if (window.PosHealth) PosHealth.recordError('omni_push_fail', err.message, { posProductId });
      _queuePush(posProductId); // retry via offline queue
    }
  }

  /* ── Offline push queue (survives connectivity loss) ─────────── */
  const _pendingPushIds = new Set();

  function _queuePush(posProductId) {
    _pendingPushIds.add(posProductId);
  }

  async function _flushPendingPushes() {
    if (!_pendingPushIds.size || !navigator.onLine) return;
    const ids = Array.from(_pendingPushIds);
    _pendingPushIds.clear();
    for (const id of ids) {
      await pushStock(id).catch(() => _pendingPushIds.add(id));
    }
  }

  /* ── Marketplace Orders Subscription ────────────────────────── */
  /**
   * Subscribes to new marketplace orders for this seller.
   * New orders trigger a toast + PosNotify push + local IDB record.
   */
  async function _subscribeOrders(sellerId) {
    const db = _db();
    if (!db || !sellerId) return;

    const fs = await _ensureFS();
    if (!fs) return;

    try {
      const q = fs.query(
        fs.collection(db, 'orders'),
        fs.where('sellerId', '==', sellerId),
        fs.where('status',   '==', 'pending'),
        fs.orderBy('createdAt', 'desc'),
        fs.limit(50)
      );

      _state.ordersSub = fs.onSnapshot(q, snap => {
        snap.docChanges().forEach(change => {
          if (change.type !== 'added') return;
          const order = { id: change.doc.id, ...change.doc.data() };
          _handleNewOrder(order);
        });
      }, err => {
        _state.errors++;
        console.error('[PosOmni] Orders subscription error:', err);
      });

    } catch (err) {
      _state.errors++;
      console.error('[PosOmni] _subscribeOrders failed:', err);
    }
  }

  function _handleNewOrder(order) {
    const total = order.total || order.amount || 0;
    const items = Array.isArray(order.items) ? order.items.length : 0;

    /* Toast notification */
    if (window.SPos?.toast) {
      SPos.toast(`New marketplace order: KES ${total.toFixed(2)} (${items} item${items !== 1 ? 's' : ''})`, 'info');
    }

    /* Push notification */
    if (window.PosNotify) {
      PosNotify.send('marketplace_order', {
        total,
        orderId: order.id,
        buyer:   order.buyerName || 'Customer',
      }).catch(() => {});
    }

    /* Audit trail */
    if (window.PosAudit) {
      PosAudit.log('marketplace_order', { orderId: order.id, total, items });
    }

    _state.pullCount++;
    _emit('order:received', { order });
  }

  /* ── Marketplace Product Updates Subscription ────────────────── */
  /**
   * Listens for price or name changes made via the marketplace UI so
   * the local POS catalogue stays in sync without a manual refresh.
   */
  async function _subscribeProducts(sellerId) {
    const db = _db();
    if (!db || !sellerId) return;

    const fs = await _ensureFS();
    if (!fs) return;

    try {
      const q = fs.query(
        fs.collection(db, 'products'),
        fs.where('sellerId', '==', sellerId),
        fs.where('active',   '==', true),
        fs.orderBy('updatedAt', 'desc'),
        fs.limit(500)
      );

      /* Snapshots are processed one at a time. Firestore may deliver a second
         snapshot while the first is still applying; without this chain the two
         would interleave read-modify-write cycles and lose updates. */
      let _queue = Promise.resolve();

      _state.productsSub = fs.onSnapshot(q, snap => {
        const changes = snap.docChanges().filter(c => c.type !== 'removed');
        if (!changes.length) return;
        _queue = _queue.then(() => _applySnapshot(changes))
                       .catch(err => console.error('[PosOmni] snapshot apply failed:', err));
      }, err => {
        console.error('[PosOmni] Products subscription error:', err);
      });

    } catch (err) {
      console.error('[PosOmni] _subscribeProducts failed:', err);
    }
  }

  /**
   * Apply one Firestore snapshot's worth of marketplace changes.
   *
   * Each change previously called _applyMarketplaceProductUpdate, which ran its
   * own PosDB.products.getAll() — a full IndexedDB store read — and then an
   * O(P) linear find. Because the changes were iterated with
   * `forEach(async …)`, which ignores the returned promise, every one of those
   * full-store arrays could be resident at the same time. An initial snapshot
   * carries up to 500 changes (fs.limit(500)).
   *
   * Measured transient heap for that pattern: ~42 MB at 200 local products,
   * ~109 MB at 500, ~219 MB at 1000 — against an Android WebView renderer
   * budget that is often 128–256 MB. That is a plausible cause of renderer
   * termination during POS startup, which surfaces as the app disappearing and
   * the phone returning to its lock screen.
   *
   * One read, one index, sequential application: O(M × P) becomes O(P + M),
   * and peak residency becomes a single array rather than M of them.
   * Business behaviour is unchanged — the same products are matched by the
   * same key and the same fields are synced.
   */
  async function _applySnapshot(changes) {
    if (!window.PosDB) return;

    /* ONE store read per snapshot. */
    const all = await PosDB.products.getAll();

    /* O(1) lookups. Later duplicates do not overwrite earlier ones, matching
       the previous find(), which returned the first match. */
    const byMarketplaceId = new Map();
    for (const p of all) {
      if (p && p.marketplaceId && !byMarketplaceId.has(p.marketplaceId)) {
        byMarketplaceId.set(p.marketplaceId, p);
      }
    }

    /* Sequential: bounded promises, bounded IndexedDB transactions, and no
       concurrent read-modify-write on the same record. */
    for (const change of changes) {
      const mktProduct = { id: change.doc.id, ...change.doc.data() };
      await _applyMarketplaceProductUpdate(mktProduct, byMarketplaceId);
    }
  }

  async function _applyMarketplaceProductUpdate(mktProduct, index) {
    if (!window.PosDB) return;
    try {
      /* Find the local product by marketplaceId. `index` is supplied by
         _applySnapshot; the getAll() fallback keeps this callable on its own. */
      let local;
      if (index) {
        local = index.get(mktProduct.id);
      } else {
        const all = await PosDB.products.getAll();
        local = all.find(p => p.marketplaceId === mktProduct.id);
      }
      if (!local) return;

      /* Only sync non-stock fields from marketplace → POS (stock flows the other way) */
      let changed = false;
      if (mktProduct.name  && mktProduct.name  !== local.name)  { local.name  = mktProduct.name;  changed = true; }
      if (mktProduct.price && mktProduct.price  !== local.price) { local.price = mktProduct.price; changed = true; }
      if (mktProduct.images?.[0] && mktProduct.images[0] !== local.image) {
        local.image = mktProduct.images[0];
        changed = true;
      }

      if (changed) {
        local.updatedAt = Date.now();
        await PosDB.products.save(local);
        _emit('product:updated', { id: local.id, name: local.name });
      }
    } catch (err) {
      console.error('[PosOmni] _applyMarketplaceProductUpdate failed:', err);
    }
  }

  /* ── One-shot Orders Pull ────────────────────────────────────── */
  async function pullOrders(bizPin) {
    const sellerId = _authUid();
    if (!sellerId || !navigator.onLine) return { skipped: true };

    const db = _db();
    const fs = await _ensureFS();
    if (!db || !fs) return { skipped: true };

    try {
      const q = fs.query(
        fs.collection(db, 'orders'),
        fs.where('sellerId', '==', sellerId),
        fs.where('status',   '==', 'pending'),
        fs.orderBy('createdAt', 'desc'),
        fs.limit(20)
      );
      const snap = await fs.getDocs(q);
      const orders = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      return { pulled: orders.length, orders };
    } catch (err) {
      console.error('[PosOmni] pullOrders failed:', err);
      return { error: err.message };
    }
  }

  /* ── Main Entry Points ───────────────────────────────────────── */
  function startSync(bizPin) {
    if (_state.running) return;
    _state.running = true;
    _state.bizPin  = bizPin;

    const sellerId = _authUid();
    if (!sellerId) {
      /* Defer until Firebase Auth is ready */
      const onAuth = e => {
        if (e.detail?.uid) {
          _subscribeOrders(e.detail.uid);
          _subscribeProducts(e.detail.uid);
        }
      };
      window.addEventListener('pos:auth:ready', onAuth, { once: true });
      console.info('[PosOmni] Waiting for auth before starting sync');
      return;
    }

    _subscribeOrders(sellerId);
    _subscribeProducts(sellerId);
    console.info('[PosOmni] v1.0 ready — marketplace sync active for', bizPin);
  }

  function stopSync() {
    if (_state.ordersSub)   { _state.ordersSub();   _state.ordersSub   = null; }
    if (_state.productsSub) { _state.productsSub(); _state.productsSub = null; }
    _state.running = false;
    console.info('[PosOmni] Sync stopped');
  }

  function getStatus() {
    return {
      running:       _state.running,
      bizPin:        _state.bizPin,
      pushCount:     _state.pushCount,
      pullCount:     _state.pullCount,
      errors:        _state.errors,
      lastPush:      _state.lastPush,
      pendingPushes: _pendingPushIds.size,
    };
  }

  /* ── Event Emission ──────────────────────────────────────────── */
  function _emit(event, detail = {}) {
    window.dispatchEvent(new CustomEvent('pos:omni:' + event, { detail }));
  }

  /* ── Connectivity recovery: flush pending stock pushes ───────── */
  window.addEventListener('online', () => {
    setTimeout(_flushPendingPushes, 2000);
  });

  /* ── Public API ──────────────────────────────────────────────── */
  window.PosOmni = {
    startSync,
    stopSync,
    pushStock,
    pullOrders,
    getStatus,
  };

  console.info('[PosOmni] v1.0 loaded');
})();
