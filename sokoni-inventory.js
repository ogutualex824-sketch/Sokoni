/**
 * SOKONI INVENTORY ENGINE v1.0
 * Enterprise-grade | Offline-first | AI-powered | Multi-tenant
 *
 * Cache layers:
 *   L1 — in-memory Map        (hot path, <30 s TTL)
 *   L2 — IndexedDB            (offline / warm cache)
 *   L3 — Firestore            (source of truth)
 *
 * All stock mutations are routed through Cloud Functions for atomicity.
 * Offline writes are queued in IDB and replayed automatically on reconnect.
 */

const SokoniInventory = (() => {
  'use strict';

  /* ═══════════════════════════════════════════════════════════════════
     CONSTANTS
  ═══════════════════════════════════════════════════════════════════ */
  const IDB_NAME  = 'sokoni_inv_v1';
  const IDB_VER   = 1;
  const SYNC_MS   = 45_000;
  const ALERT_MS  = 60_000;
  const PAGE_SIZE = 50;
  const CF_REGION = 'us-central1';
  const CF_PROJECT= 'sokoni-aeb26';

  const MOVEMENT_TYPES = Object.freeze({
    PURCHASE:       'purchase',
    SALE:           'sale',
    RETURN_IN:      'return_in',
    RETURN_OUT:     'return_out',
    TRANSFER_IN:    'transfer_in',
    TRANSFER_OUT:   'transfer_out',
    ADJUSTMENT:     'adjustment',
    DAMAGE:         'damage',
    EXPIRY:         'expiry',
    LOSS:           'loss',
    THEFT:          'theft',
    DONATION:       'donation',
    SAMPLE:         'sample',
    PRODUCTION_IN:  'production_in',
    PRODUCTION_OUT: 'production_out',
    OPENING_STOCK:  'opening_stock',
    COUNT_ADJUST:   'count_adjust',
    WRITE_OFF:      'write_off',
  });

  const STOCK_STATUS = Object.freeze({
    IN_STOCK:    'in_stock',
    LOW_STOCK:   'low_stock',
    OUT_OF_STOCK:'out_of_stock',
    OVERSTOCKED: 'overstocked',
    NEAR_EXPIRY: 'near_expiry',
  });

  const PO_STATUS = Object.freeze({
    DRAFT:     'draft',
    SENT:      'sent',
    PARTIAL:   'partial',
    RECEIVED:  'received',
    CANCELLED: 'cancelled',
  });

  /* ═══════════════════════════════════════════════════════════════════
     STATE
  ═══════════════════════════════════════════════════════════════════ */
  let _idb        = null;
  let _fs         = null;
  let _auth       = null;
  let _uid        = null;
  let _tenantId   = 'default';
  let _online     = navigator.onLine;
  let _syncTimer  = null;
  let _alertTimer = null;
  let _cache      = new Map();
  let _listeners  = {};
  let _ready      = false;

  /* ═══════════════════════════════════════════════════════════════════
     EVENT EMITTER
  ═══════════════════════════════════════════════════════════════════ */
  function on(event, cb) {
    if (!_listeners[event]) _listeners[event] = [];
    _listeners[event].push(cb);
    return () => { _listeners[event] = (_listeners[event] || []).filter(f => f !== cb); };
  }

  function emit(event, data) {
    (_listeners[event]  || []).forEach(cb => { try { cb(data);        } catch (_) {} });
    (_listeners['*']    || []).forEach(cb => { try { cb(event, data); } catch (_) {} });
  }

  /* ═══════════════════════════════════════════════════════════════════
     INDEXEDDB — OFFLINE STORE
  ═══════════════════════════════════════════════════════════════════ */
  function openIDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(IDB_NAME, IDB_VER);

      req.onupgradeneeded = ({ target: { result: db } }) => {
        function store(name, keyPath, indexes = []) {
          if (db.objectStoreNames.contains(name)) return;
          const os = db.createObjectStore(name, { keyPath });
          indexes.forEach(({ idx, field, unique = false }) =>
            os.createIndex(idx, field, { unique })
          );
        }
        store('products',        'id', [
          { idx: 'sku',       field: 'sku',       unique: true  },
          { idx: 'barcode',   field: 'barcode',   unique: false },
          { idx: 'category',  field: 'category',  unique: false },
          { idx: 'active',    field: 'active',    unique: false },
        ]);
        store('stockLevels',     'id', [
          { idx: 'productId',   field: 'productId',   unique: false },
          { idx: 'warehouseId', field: 'warehouseId', unique: false },
        ]);
        store('movements',       'id', [
          { idx: 'productId',   field: 'productId',   unique: false },
          { idx: 'type',        field: 'type',        unique: false },
          { idx: 'timestamp',   field: 'timestamp',   unique: false },
        ]);
        store('purchaseOrders',  'id', [
          { idx: 'status',      field: 'status',      unique: false },
          { idx: 'supplierId',  field: 'supplierId',  unique: false },
        ]);
        store('suppliers',       'id', []);
        store('warehouses',      'id', []);
        store('audits',          'id', []);
        store('alerts',          'id', []);
        store('syncQueue',       'qid', [
          { idx: 'createdAt',   field: 'createdAt',   unique: false },
        ]);
      };

      req.onsuccess = ({ target: { result } }) => { _idb = result; resolve(_idb); };
      req.onerror   = ({ target: { error } })  => reject(error);
    });
  }

  function idbGet(store, key) {
    return new Promise((res, rej) => {
      const req = _idb.transaction(store, 'readonly').objectStore(store).get(key);
      req.onsuccess = () => res(req.result || null);
      req.onerror   = () => rej(req.error);
    });
  }

  function idbGetAll(store, indexName, range) {
    return new Promise((res, rej) => {
      const os  = _idb.transaction(store, 'readonly').objectStore(store);
      const src = indexName ? os.index(indexName) : os;
      const req = range ? src.getAll(range) : src.getAll();
      req.onsuccess = () => res(req.result || []);
      req.onerror   = () => rej(req.error);
    });
  }

  function idbPut(store, record) {
    return new Promise((res, rej) => {
      const req = _idb.transaction(store, 'readwrite').objectStore(store).put(record);
      req.onsuccess = () => res(req.result);
      req.onerror   = () => rej(req.error);
    });
  }

  function idbDelete(store, key) {
    return new Promise((res, rej) => {
      const req = _idb.transaction(store, 'readwrite').objectStore(store).delete(key);
      req.onsuccess = () => res(true);
      req.onerror   = () => rej(req.error);
    });
  }

  function idbClear(store) {
    return new Promise((res, rej) => {
      const req = _idb.transaction(store, 'readwrite').objectStore(store).clear();
      req.onsuccess = () => res(true);
      req.onerror   = () => rej(req.error);
    });
  }

  /* ═══════════════════════════════════════════════════════════════════
     INIT
  ═══════════════════════════════════════════════════════════════════ */
  async function init({ firestore, auth, tenantId } = {}) {
    /* window.db / window.auth are NOT set anywhere in the codebase, so _fs was always null and
       every read fell back to the empty local cache — the real reason inventory showed nothing.
       Fall back to the compat firebase shim (backed by the modular SDK in firebase.js). */
    _fs = firestore || window.db
       || (typeof firebase !== 'undefined' && firebase.firestore ? firebase.firestore() : null)
       || (window.firebase && window.firebase.firestore ? window.firebase.firestore() : null)
       || null;
    _auth = auth || window.auth
       || (typeof firebase !== 'undefined' && firebase.auth ? firebase.auth() : null)
       || (window.firebase && window.firebase.auth ? window.firebase.auth() : null)
       || null;
    _tenantId = tenantId  || window.SOKONI_TENANT_ID || 'default';

    await openIDB();

    if (_auth && typeof _auth.onAuthStateChanged === 'function') {
      _auth.onAuthStateChanged(u => { _uid = u ? u.uid : null; });
    }

    window.addEventListener('online',  () => { _online = true;  _syncQueue(); emit('online',  {}); });
    window.addEventListener('offline', () => { _online = false;               emit('offline', {}); });

    _syncTimer  = setInterval(_syncQueue, SYNC_MS);
    _alertTimer = setInterval(_runAlerts, ALERT_MS);

    if (_online) await _syncQueue();
    await _runAlerts();

    _ready = true;
    emit('ready', { tenantId: _tenantId });
    return SokoniInventory;
  }

  /* ═══════════════════════════════════════════════════════════════════
     HELPERS
  ═══════════════════════════════════════════════════════════════════ */
  function col(path) {
    if (!_fs) throw new Error('Firestore not initialised — call SokoniInventory.init() first');
    return _fs.collection(`tenants/${_tenantId}/${path}`);
  }

  /* ── CANONICAL CONVERGENCE (Stage 1) ────────────────────────────────────
     The ONE product engine lives in the top-level `products` collection (same
     docs the Shop, Catalogue, MiniShop, Profile and POS read). Inventory used to
     read/write a separate empty `tenants/{uid}/inventory_products` store, so the
     merchant's real catalogue never appeared here. These helpers repoint every
     read/write at `products` and map field names in both directions:
       price ↔ sellingPrice · costPrice ↔ buyingPrice · stock ↔ stockLevel/stockQty */
  function productsCol() {
    if (!_fs) throw new Error('Firestore not initialised — call SokoniInventory.init() first');
    return _fs.collection('products');
  }
  function _sellerUid() {
    try { if (_auth && _auth.currentUser && _auth.currentUser.uid) return _auth.currentUser.uid; } catch (_) {}
    try { if (window.firebaseAuth && window.firebaseAuth.currentUser) return window.firebaseAuth.currentUser.uid; } catch (_) {}
    try { if (typeof firebase !== 'undefined' && firebase.auth && firebase.auth().currentUser) return firebase.auth().currentUser.uid; } catch (_) {}
    if (_uid) return _uid;
    try { const u = JSON.parse(localStorage.getItem('sokoniUser') || 'null'); if (u && u.uid) return u.uid; } catch (_) {}
    return null;
  }

  /* products doc → inventory shape (for reads / the inventory UI). */
  function _toInv(id, p) {
    p = p || {};
    const st = String(p.status || '').toLowerCase();
    const active = p.status
      ? (st !== 'inactive' && st !== 'deleted' && st !== 'hidden' && st !== 'archived' && st !== 'draft')
      : (p.active !== false);
    const img = p.imageUrl || p.image || (Array.isArray(p.images) && p.images[0]) || '';
    return {
      id,
      name:         p.name || p.title || '',
      sellingPrice: Number(p.price != null ? p.price : (p.sellingPrice || 0)) || 0,
      buyingPrice:  Number(p.costPrice != null ? p.costPrice : (p.buyingPrice != null ? p.buyingPrice : (p.cost || 0))) || 0,
      stockLevel:   Number(p.stock != null ? p.stock : (p.stockLevel != null ? p.stockLevel : (p.stockQty != null ? p.stockQty : (p.quantity || 0)))) || 0,
      category:     p.category || '',
      sku:          p.sku || '',
      barcode:      p.barcode || '',
      unit:         p.unit || 'pcs',
      brand:        p.brand || '',
      taxRate:      Number(p.taxRate != null ? p.taxRate : (p.vatRate || 0)) || 0,
      reorderPoint: Number(p.reorderPoint != null ? p.reorderPoint : (p.minStock != null ? p.minStock : 10)) || 10,
      imageUrl:     img,
      images:       Array.isArray(p.images) ? p.images : (p.image ? [p.image] : []),
      description:  p.description || '',
      active,
      status:       p.status || 'active',
      sellerUid:    p.sellerUid || p.uid || '',
      shopId:       p.shopId || '',
      /* keep canonical fields too so any consumer reading them still works */
      price: p.price, stock: p.stock, costPrice: p.costPrice,
      createdAt: p.createdAt, updatedAt: p.updatedAt,
      tenantId: _tenantId,
    };
  }

  /* inventory shape → products doc (for writes). Rule-safe: sellerUid==uid, valid price,
     no base64 images, no admin fields. */
  function _toCanonical(product) {
    const uid = _sellerUid();
    const _isData = (v) => typeof v === 'string' && v.slice(0, 5) === 'data:';
    const out = {
      name:        product.name,
      price:       Number(product.sellingPrice != null ? product.sellingPrice : (product.price || 0)) || 0,
      costPrice:   Number(product.buyingPrice != null ? product.buyingPrice : (product.costPrice || 0)) || 0,
      stock:       Number(product.stockLevel != null ? product.stockLevel : (product.stock || 0)) || 0,
      category:    product.category || '',
      sku:         product.sku || '',
      barcode:     product.barcode || '',
      unit:        product.unit || 'pcs',
      brand:       product.brand || '',
      taxRate:     Number(product.taxRate || 0) || 0,
      reorderPoint:Number(product.reorderPoint || 10) || 10,
      description: product.description || '',
      sellerUid:   uid,
      uid,
      shopId:      product.shopId || uid,   /* ensure shopId present (pre-empts Stage 3) */
      status:      product.active === false ? 'inactive' : 'active',
      updatedAt:   nowISO(),
      updatedBy:   currentUid(),
    };
    const imgs = (Array.isArray(product.images) ? product.images : (product.imageUrl ? [product.imageUrl] : []))
      .filter((u) => u && !_isData(u));
    if (imgs.length) { out.images = imgs; out.image = imgs[0]; }
    return out;
  }

  function nowISO()    { return new Date().toISOString(); }
  function currentUid(){ return _uid || 'anonymous'; }

  function uid6() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  function getDeviceId() {
    let id = localStorage.getItem('_sokoni_device');
    if (!id) { id = `dev_${uid6()}`; localStorage.setItem('_sokoni_device', id); }
    return id;
  }

  function cacheGet(key)          { return _cache.get(key) || null; }
  function cacheSet(key, val, ttl = 30_000) {
    _cache.set(key, val);
    setTimeout(() => _cache.delete(key), ttl);
  }

  /* ═══════════════════════════════════════════════════════════════════
     PRODUCTS
  ═══════════════════════════════════════════════════════════════════ */
  async function getProducts({ category, search, active = true, page = 0 } = {}) {
    const cKey = `products:${category}:${search}:${active}:${page}`;
    const hit  = cacheGet(cKey);
    if (hit) return hit;

    let results = [];
    const seller = _sellerUid();

    /* PRIMARY read: the App-Check-independent public catalogue endpoint (same canonical
       `products` data, filtered by owner). Reliable even when the client compat firestore /
       App Check is flaky — which is exactly what left inventory blank. */
    if (_online && seller && typeof fetch === 'function') {
      try {
        const r = await fetch('/api/catalogue?limit=500&sellerUid=' + encodeURIComponent(seller), { cache: 'no-store' });
        const j = r.ok ? await r.json() : null;
        if (j && j.ok && Array.isArray(j.products)) {
          results = j.products.map(p => _toInv(p.id, p));
          await Promise.all(results.map(p => idbPut('products', p)));
        }
      } catch (_) {}
    }
    /* FALLBACK: direct Firestore (compat) if the endpoint returned nothing. */
    if (!results.length && _online && _fs && seller) {
      try {
        const snap = await productsCol().where('sellerUid', '==', seller).limit(500).get();
        results = snap.docs.map(d => _toInv(d.id, d.data()));
        await Promise.all(results.map(p => idbPut('products', p)));
      } catch (_) {}
    }
    if (!results.length) results = await idbGetAll('products');

    if (active === true || active === false) results = results.filter(p => p.active === active);
    if (category) results = results.filter(p => (p.category || '') === category);
    if (search) {
      const q = search.toLowerCase();
      results = results.filter(p =>
        (p.name   || '').toLowerCase().includes(q) ||
        (p.sku    || '').toLowerCase().includes(q) ||
        (p.barcode|| '').includes(q)
      );
    }
    results.sort((a, b) => (a.name || '').localeCompare(b.name || ''));

    cacheSet(cKey, results);
    return results;
  }

  async function getProduct(id) {
    const hit = cacheGet(`product:${id}`);
    if (hit) return hit;

    let p = null;
    if (_online && _fs) {
      try {
        const doc = await productsCol().doc(id).get();
        p = doc.exists ? _toInv(doc.id, doc.data()) : null;
        if (p) { await idbPut('products', p); }
      } catch (_) { p = await idbGet('products', id); }
    } else {
      p = await idbGet('products', id);
    }

    if (p) cacheSet(`product:${id}`, p);
    return p;
  }

  async function getProductByBarcode(barcode) {
    if (_online && _fs) {
      try {
        const seller = _sellerUid();
        const snap = await productsCol().where('barcode', '==', barcode).limit(5).get();
        const match = snap.docs.map(d => _toInv(d.id, d.data()))
          .find(pp => !seller || pp.sellerUid === seller);
        if (match) { await idbPut('products', match); return match; }
      } catch (_) {}
    }
    const local = await idbGetAll('products', 'barcode', IDBKeyRange.only(barcode));
    return local[0] || null;
  }

  async function saveProduct(product) {
    if (!product.name) throw new Error('Product name is required');

    const now  = nowISO();
    const isNew= !product.id;
    if (isNew) {
      product.id        = `prod_${uid6()}`;
      product.createdAt = now;
      product.createdBy = currentUid();
    }
    if (!product.sku)  product.sku  = generateSKU(product);
    product.updatedAt = now;
    product.updatedBy = currentUid();
    product.tenantId  = _tenantId;
    product.active    = product.active !== false;

    /* Canonical convergence (Stage 1): the ONE product engine is `products` — no secondary
       collections. Cache the inventory view; write the canonical doc. */
    const canonical = _toCanonical(product);
    await idbPut('products', _toInv(product.id, canonical));
    _cache.delete(`product:${product.id}`);

    if (_online && _fs) {
      await productsCol().doc(product.id).set(canonical, { merge: true });
    } else {
      await _enqueue({ op: 'save_product', data: { id: product.id, canonical } });
    }

    emit('product_saved', { product, isNew });
    return product;
  }

  /* alias: add a new product (saveProduct detects new vs existing by absence of id) */
  async function addProduct(data) {
    const copy = { ...data };
    delete copy.id; // ensure fresh id is generated
    return saveProduct(copy);
  }

  /* alias: update existing product by id, merging with existing data */
  async function updateProduct(id, updates) {
    let existing = {};
    try { existing = (await getProduct(id)) || {}; } catch (_) {}
    return saveProduct({ ...existing, ...updates, id });
  }

  /* categories — load from Firestore inventory_categories, fallback to static list */
  const _DEFAULT_CATEGORIES = [
    'Food & Beverages', 'Electronics', 'Clothing & Apparel', 'Health & Beauty',
    'Home & Kitchen', 'Agriculture', 'Automotive', 'Office Supplies',
    'Books & Stationery', 'Sports & Outdoors', 'Toys & Games',
    'Building & Construction', 'Pharmaceuticals', 'Cosmetics', 'General',
  ];

  async function getCategories() {
    if (_online && _fs) {
      try {
        const snap = await col('inventory_categories').orderBy('name').get();
        const cats = snap.docs.map(d => d.data().name || d.id).filter(Boolean);
        if (cats.length) return cats;
      } catch (_) {}
    }
    // derive from IDB-cached products
    try {
      const products = await idbGetAll('products');
      const fromProducts = [...new Set(products.map(p => p.category).filter(Boolean))].sort();
      if (fromProducts.length) return fromProducts;
    } catch (_) {}
    return _DEFAULT_CATEGORIES;
  }

  async function deleteProduct(id) {
    await idbDelete('products', id);
    _cache.delete(`product:${id}`);
    if (_online && _fs) {
      /* Soft-delete on the canonical product: status inactive hides it from catalogue + inventory. */
      await productsCol().doc(id).update({ status: 'inactive', active: false, deletedAt: nowISO(), updatedAt: nowISO() });
    } else {
      await _enqueue({ op: 'delete_product', data: { id } });
    }
    emit('product_deleted', { id });
  }

  async function importProducts(rows) {
    const results = { created: 0, updated: 0, errors: [] };
    for (const row of rows) {
      try {
        await saveProduct({
          name:     row.name || row.Name,
          sku:      row.sku  || row.SKU,
          barcode:  row.barcode || row.Barcode || '',
          category: row.category || row.Category || 'General',
          costPrice:    parseFloat(row.costPrice    || row['Cost Price']    || 0),
          sellingPrice: parseFloat(row.sellingPrice || row['Selling Price'] || 0),
          quantity:     parseInt(row.quantity       || 0),
          unit:     row.unit || 'each',
          active:   true,
        });
        results.created++;
      } catch (e) {
        results.errors.push({ row, error: e.message });
      }
    }
    return results;
  }

  /* ═══════════════════════════════════════════════════════════════════
     STOCK LEVELS
  ═══════════════════════════════════════════════════════════════════ */
  function _slId(productId, warehouseId, variantId) {
    return `${productId}:${variantId || 'base'}:${warehouseId}`;
  }

  function _emptyLevel(id, productId, warehouseId, variantId) {
    return { id, productId, variantId: variantId || null, warehouseId,
      available: 0, reserved: 0, allocated: 0, incoming: 0,
      damaged: 0, expired: 0, onHand: 0,
      reorderPoint: 0, minStock: 0, maxStock: 0,
      updatedAt: nowISO() };
  }

  async function getStockLevel(productId, warehouseId = 'main', variantId = null) {
    const id  = _slId(productId, warehouseId, variantId);
    const hit = cacheGet(`sl:${id}`);
    if (hit) return hit;

    let level = null;
    if (_online && _fs) {
      try {
        const doc = await col('inventory_levels').doc(id).get();
        level = doc.exists ? { id: doc.id, ...doc.data() } : _emptyLevel(id, productId, warehouseId, variantId);
        await idbPut('stockLevels', level);
      } catch (_) {
        level = (await idbGet('stockLevels', id)) || _emptyLevel(id, productId, warehouseId, variantId);
      }
    } else {
      level = (await idbGet('stockLevels', id)) || _emptyLevel(id, productId, warehouseId, variantId);
    }

    cacheSet(`sl:${id}`, level, 15_000);
    return level;
  }

  async function getStockLevels(productId) {
    if (_online && _fs) {
      try {
        const snap = await col('inventory_levels').where('productId', '==', productId).get();
        const levels = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        await Promise.all(levels.map(l => idbPut('stockLevels', l)));
        return levels;
      } catch (_) {}
    }
    return idbGetAll('stockLevels', 'productId', IDBKeyRange.only(productId));
  }

  async function getAllStockLevels({ warehouseId, lowOnly = false } = {}) {
    if (_online && _fs) {
      try {
        let q = col('inventory_levels');
        if (warehouseId) q = q.where('warehouseId', '==', warehouseId);
        if (lowOnly)     q = q.where('available', '<=', 10).orderBy('available', 'asc');
        q = q.limit(200);
        const snap = await q.get();
        const levels = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        await Promise.all(levels.map(l => idbPut('stockLevels', l)));
        return levels;
      } catch (_) {}
    }
    return idbGetAll('stockLevels', warehouseId ? 'warehouseId' : null,
      warehouseId ? IDBKeyRange.only(warehouseId) : undefined);
  }

  async function getLowStockItems(threshold = null) {
    const levels = await getAllStockLevels({ lowOnly: !threshold });
    return levels.filter(l => {
      const limit = threshold != null ? threshold : (l.reorderPoint || 5);
      return l.available <= limit;
    });
  }

  /* ═══════════════════════════════════════════════════════════════════
     STOCK MOVEMENTS
  ═══════════════════════════════════════════════════════════════════ */
  async function recordMovement(params) {
    if (!params.productId) throw new Error('productId required');
    if (params.quantity === undefined || params.quantity === null) throw new Error('quantity required');

    const movement = {
      id:           `mv_${uid6()}`,
      type:         params.type        || MOVEMENT_TYPES.ADJUSTMENT,
      productId:    params.productId,
      variantId:    params.variantId   || null,
      warehouseId:  params.warehouseId || 'main',
      locationId:   params.locationId  || null,
      quantity:     Number(params.quantity),
      unitCost:     Number(params.unitCost  || 0),
      totalCost:    Number(params.quantity) * Number(params.unitCost || 0),
      batchNumber:  params.batchNumber || null,
      expiryDate:   params.expiryDate  || null,
      serialNos:    params.serialNos   || [],
      referenceId:  params.referenceId || null,
      referenceType:params.referenceType || null,
      reason:       params.reason      || null,
      notes:        params.notes       || null,
      userId:       currentUid(),
      deviceId:     getDeviceId(),
      timestamp:    nowISO(),
      synced:       false,
      tenantId:     _tenantId,
    };

    await idbPut('movements', movement);
    emit('movement_recorded', { movement });

    if (_online) {
      try {
        await _callCF('inventoryAdjustStock', movement);
        movement.synced = true;
        await idbPut('movements', movement);
      } catch (_) {
        await _enqueue({ op: 'movement', data: movement });
      }
    } else {
      await _enqueue({ op: 'movement', data: movement });
    }

    _cache.delete(`sl:${_slId(movement.productId, movement.warehouseId, movement.variantId)}`);
    return movement;
  }

  async function getMovements({ productId, type, warehouseId, limit = 50, startAfter } = {}) {
    if (_online && _fs) {
      try {
        let q = col('inventory_movements').orderBy('timestamp', 'desc');
        if (productId)   q = q.where('productId',   '==', productId);
        if (type)        q = q.where('type',         '==', type);
        if (warehouseId) q = q.where('warehouseId',  '==', warehouseId);
        q = q.limit(limit);
        const snap = await q.get();
        const mvs  = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        await Promise.all(mvs.map(m => idbPut('movements', m)));
        return mvs;
      } catch (_) {}
    }
    return idbGetAll('movements', productId ? 'productId' : null,
      productId ? IDBKeyRange.only(productId) : undefined);
  }

  /* ═══════════════════════════════════════════════════════════════════
     STOCK OPERATIONS  (delegate heavy lifting to Cloud Functions)
  ═══════════════════════════════════════════════════════════════════ */
  async function adjustStock({ productId, variantId, warehouseId, quantity, reason, type, notes, unitCost }) {
    return recordMovement({
      productId, variantId, warehouseId, quantity, reason, notes, unitCost,
      type: type || MOVEMENT_TYPES.ADJUSTMENT,
    });
  }

  async function reserveStock({ productId, variantId, warehouseId, quantity, referenceId }) {
    if (!_online) throw new Error('Reserve requires internet connection');
    return _callCF('inventoryReserveStock', {
      productId, variantId, warehouseId: warehouseId || 'main',
      quantity, referenceId, userId: currentUid(), tenantId: _tenantId,
    });
  }

  async function releaseReservation({ productId, variantId, warehouseId, referenceId }) {
    if (!_online) throw new Error('Release requires internet connection');
    return _callCF('inventoryReleaseReservation', {
      productId, variantId, warehouseId: warehouseId || 'main',
      referenceId, userId: currentUid(), tenantId: _tenantId,
    });
  }

  async function transferStock({ productId, variantId, fromWarehouse, toWarehouse, quantity, notes }) {
    if (!_online) throw new Error('Transfer requires internet connection');
    return _callCF('inventoryTransferStock', {
      productId, variantId, fromWarehouse, toWarehouse,
      quantity, notes, userId: currentUid(), tenantId: _tenantId,
    });
  }

  /* ═══════════════════════════════════════════════════════════════════
     PURCHASE ORDERS
  ═══════════════════════════════════════════════════════════════════ */
  async function createPO(po) {
    if (!po.supplierId) throw new Error('Supplier required');
    if (!po.items?.length) throw new Error('PO must have at least one item');

    po.id        = `po_${uid6()}`;
    po.status    = PO_STATUS.DRAFT;
    po.number    = await _generatePONumber();
    po.createdAt = nowISO();
    po.createdBy = currentUid();
    po.tenantId  = _tenantId;
    po.totalCost = po.items.reduce((s, i) => s + (i.qty * i.unitCost), 0);

    await idbPut('purchaseOrders', po);

    if (_online && _fs) {
      await col('inventory_purchaseOrders').doc(po.id).set(po);
    } else {
      await _enqueue({ op: 'create_po', data: po });
    }

    emit('po_created', { po });
    return po;
  }

  async function updatePO(id, updates) {
    const po = await idbGet('purchaseOrders', id) || {};
    Object.assign(po, updates, { id, updatedAt: nowISO(), updatedBy: currentUid() });
    await idbPut('purchaseOrders', po);
    if (_online && _fs) {
      await col('inventory_purchaseOrders').doc(id).update(updates);
    }
    emit('po_updated', { po });
    return po;
  }

  async function getPurchaseOrders({ status, supplierId, limit = 50 } = {}) {
    if (_online && _fs) {
      try {
        let q = col('inventory_purchaseOrders').orderBy('createdAt', 'desc');
        if (status)     q = q.where('status',     '==', status);
        if (supplierId) q = q.where('supplierId', '==', supplierId);
        q = q.limit(limit);
        const snap = await q.get();
        const pos  = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        await Promise.all(pos.map(p => idbPut('purchaseOrders', p)));
        return pos;
      } catch (_) {}
    }
    return idbGetAll('purchaseOrders');
  }

  async function receivePO({ poId, items, notes, warehouseId }) {
    if (!_online) throw new Error('PO receiving requires internet connection');
    const result = await _callCF('inventoryReceivePO', {
      poId, items, notes, warehouseId: warehouseId || 'main',
      userId: currentUid(), tenantId: _tenantId,
    });
    emit('po_received', { poId });
    return result;
  }

  /* ═══════════════════════════════════════════════════════════════════
     SUPPLIERS
  ═══════════════════════════════════════════════════════════════════ */
  async function getSuppliers({ active = true } = {}) {
    const hit = cacheGet('suppliers');
    if (hit) return hit;

    let suppliers = [];
    if (_online && _fs) {
      try {
        const snap = await col('inventory_suppliers')
          .where('active', '==', active).orderBy('name').get();
        suppliers = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        await Promise.all(suppliers.map(s => idbPut('suppliers', s)));
      } catch (_) { suppliers = await idbGetAll('suppliers'); }
    } else {
      suppliers = await idbGetAll('suppliers');
    }

    cacheSet('suppliers', suppliers, 120_000);
    return suppliers;
  }

  async function saveSupplier(supplier) {
    if (!supplier.name) throw new Error('Supplier name required');
    const isNew = !supplier.id;
    if (isNew) { supplier.id = `sup_${uid6()}`; supplier.createdAt = nowISO(); supplier.createdBy = currentUid(); }
    supplier.updatedAt = nowISO();
    supplier.tenantId  = _tenantId;
    supplier.active    = supplier.active !== false;

    await idbPut('suppliers', supplier);
    _cache.delete('suppliers');

    if (_online && _fs) {
      await col('inventory_suppliers').doc(supplier.id).set(supplier, { merge: true });
    } else {
      await _enqueue({ op: 'save_supplier', data: supplier });
    }

    emit('supplier_saved', { supplier });
    return supplier;
  }

  /* ═══════════════════════════════════════════════════════════════════
     WAREHOUSES
  ═══════════════════════════════════════════════════════════════════ */
  async function getWarehouses() {
    const hit = cacheGet('warehouses');
    if (hit) return hit;

    let warehouses = [];
    if (_online && _fs) {
      try {
        const snap = await col('inventory_warehouses')
          .where('active', '==', true).orderBy('name').get();
        warehouses = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        await Promise.all(warehouses.map(w => idbPut('warehouses', w)));
      } catch (_) { warehouses = await idbGetAll('warehouses'); }
    } else {
      warehouses = await idbGetAll('warehouses');
    }

    if (!warehouses.length) {
      warehouses = [{ id: 'main', name: 'Main Warehouse', active: true }];
    }

    cacheSet('warehouses', warehouses, 300_000);
    return warehouses;
  }

  async function saveWarehouse(warehouse) {
    if (!warehouse.name) throw new Error('Warehouse name required');
    if (!warehouse.id) { warehouse.id = `wh_${uid6()}`; warehouse.createdAt = nowISO(); }
    warehouse.active   = warehouse.active !== false;
    warehouse.tenantId = _tenantId;
    warehouse.updatedAt= nowISO();

    await idbPut('warehouses', warehouse);
    _cache.delete('warehouses');

    if (_online && _fs) {
      await col('inventory_warehouses').doc(warehouse.id).set(warehouse, { merge: true });
    }
    emit('warehouse_saved', { warehouse });
    return warehouse;
  }

  /* ═══════════════════════════════════════════════════════════════════
     STOCK AUDIT / STOCK COUNT
  ═══════════════════════════════════════════════════════════════════ */
  async function startStockCount({ warehouseId = 'main', name, notes } = {}) {
    const audit = {
      id:          `audit_${uid6()}`,
      warehouseId,
      name:        name  || `Stock Count ${new Date().toLocaleDateString('en-KE')}`,
      notes:       notes || '',
      status:      'in_progress',
      startedAt:   nowISO(),
      startedBy:   currentUid(),
      items:       [],
      tenantId:    _tenantId,
    };

    await idbPut('audits', audit);

    if (_online && _fs) {
      await col('inventory_audits').doc(audit.id).set(audit);
    }

    emit('audit_started', { audit });
    return audit;
  }

  async function addAuditItem(auditId, item) {
    const audit = await idbGet('audits', auditId);
    if (!audit) throw new Error('Audit session not found');
    const idx = audit.items.findIndex(i => i.productId === item.productId);
    if (idx >= 0) audit.items[idx] = { ...audit.items[idx], ...item };
    else          audit.items.push({ ...item, countedAt: nowISO() });
    audit.updatedAt = nowISO();
    await idbPut('audits', audit);
    if (_online && _fs) {
      await col('inventory_audits').doc(auditId).update({ items: audit.items, updatedAt: audit.updatedAt });
    }
    return audit;
  }

  async function submitStockCount({ auditId, notes }) {
    if (!_online) throw new Error('Submitting stock count requires internet connection');
    return _callCF('inventoryProcessStockCount', {
      auditId, notes, userId: currentUid(), tenantId: _tenantId,
    });
  }

  /* ═══════════════════════════════════════════════════════════════════
     ANALYTICS
  ═══════════════════════════════════════════════════════════════════ */
  async function getAnalytics({ period = '30d' } = {}) {
    const hit = cacheGet(`analytics:${period}`);
    if (hit) return hit;

    const defaults = {
      totalProducts: 0, totalSKUs: 0, inventoryValue: 0,
      lowStockCount: 0, outOfStockCount: 0, movementsToday: 0,
      topMovers: [], slowMovers: [], categoryBreakdown: [],
      warehouseBreakdown: [], period,
    };

    if (_online && _fs) {
      try {
        const doc = await col('inventory_analytics').doc(period).get();
        const data = doc.exists ? { ...defaults, ...doc.data() } : defaults;
        cacheSet(`analytics:${period}`, data, 300_000);
        return data;
      } catch (_) {}
    }

    return defaults;
  }

  async function getInventoryValuation() {
    if (_online && _fs) {
      try {
        const doc = await col('inventory_analytics').doc('valuation').get();
        return doc.exists ? doc.data() : null;
      } catch (_) {}
    }
    return null;
  }

  /* ═══════════════════════════════════════════════════════════════════
     AI FEATURES
  ═══════════════════════════════════════════════════════════════════ */
  async function aiQuery(question) {
    if (!_online) throw new Error('AI query requires internet connection');
    return _callCF('inventoryAiQuery', {
      question, userId: currentUid(), tenantId: _tenantId,
    });
  }

  async function aiForecast({ productId, warehouseId = 'main', days = 30 }) {
    if (!_online) throw new Error('AI forecast requires internet connection');
    return _callCF('inventoryAiForecast', {
      productId, warehouseId, days, userId: currentUid(), tenantId: _tenantId,
    });
  }

  async function aiReorderSuggestions() {
    if (!_online) throw new Error('AI reorder requires internet connection');
    return _callCF('inventoryAiReorderSuggestions', {
      userId: currentUid(), tenantId: _tenantId,
    });
  }

  async function aiIdentifyProduct(imageBase64OrUrl) {
    if (!_online) throw new Error('AI identification requires internet connection');
    return _callCF('inventoryAiIdentifyProduct', {
      image: imageBase64OrUrl, userId: currentUid(), tenantId: _tenantId,
    });
  }

  /* ═══════════════════════════════════════════════════════════════════
     ALERTS
  ═══════════════════════════════════════════════════════════════════ */
  async function _runAlerts() {
    const alerts = [];
    try {
      const low = await getLowStockItems();
      for (const sl of low) {
        const severity = sl.available <= 0 ? 'critical' : 'warning';
        const type     = sl.available <= 0 ? 'out_of_stock' : 'low_stock';
        alerts.push({
          id:        `${type}_${sl.productId}_${sl.warehouseId}`,
          type, severity,
          productId: sl.productId,
          warehouseId: sl.warehouseId,
          available: sl.available,
          message:   sl.available <= 0
            ? `Out of stock in ${sl.warehouseId}`
            : `Low stock: ${sl.available} units remaining`,
          createdAt: nowISO(),
        });
      }
      await idbClear('alerts');
      await Promise.all(alerts.map(a => idbPut('alerts', a)));
      emit('alerts_updated', { alerts, count: alerts.length });
    } catch (_) {}
    return alerts;
  }

  async function getAlerts() {
    return idbGetAll('alerts');
  }

  async function refreshAlerts() {
    return _runAlerts();
  }

  /* ═══════════════════════════════════════════════════════════════════
     BARCODE & SKU UTILITIES
  ═══════════════════════════════════════════════════════════════════ */
  function detectBarcodeType(barcode) {
    if (!barcode) return 'unknown';
    const b = String(barcode).trim();
    if (/^\d{13}$/.test(b))  return 'EAN-13';
    if (/^\d{8}$/.test(b))   return 'EAN-8';
    if (/^\d{12}$/.test(b))  return 'UPC-A';
    if (/^\d{14}$/.test(b))  return 'GTIN-14';
    if (/^(978|979)\d{10}$/.test(b)) return 'ISBN-13';
    if (/^\d{10}$/.test(b))  return 'ISBN-10';
    if (/^[A-Z0-9\-\.\ \/\+\%\*]{1,80}$/.test(b)) return 'Code-128/39';
    return 'custom';
  }

  function generateSKU(product) {
    const cat = ((product.category || 'GEN').replace(/\s+/g, '').substring(0, 3)).toUpperCase();
    const rnd = Math.random().toString(36).substring(2, 7).toUpperCase();
    return `${cat}-${rnd}`;
  }

  function generateBarcode(prefix = '600') {
    const body = prefix + String(Date.now()).slice(-9);
    const digits = body.substring(0, 12).split('').map(Number);
    let sum = 0;
    digits.forEach((d, i) => { sum += i % 2 === 0 ? d : d * 3; });
    const check = (10 - (sum % 10)) % 10;
    return digits.join('') + check;
  }

  async function _generatePONumber() {
    const d   = new Date();
    const ymd = `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`;
    const seq = String(Math.floor(Math.random() * 9000) + 1000);
    return `PO-${ymd}-${seq}`;
  }

  /* ═══════════════════════════════════════════════════════════════════
     OFFLINE SYNC QUEUE
  ═══════════════════════════════════════════════════════════════════ */
  async function _enqueue(op) {
    const item = { ...op, qid: `q_${uid6()}`, createdAt: nowISO() };
    await idbPut('syncQueue', item);
  }

  async function _syncQueue() {
    if (!_online || !_fs) return;
    const pending = await idbGetAll('syncQueue');
    let synced = 0;
    for (const op of pending) {
      try {
        await _processQueuedOp(op);
        await idbDelete('syncQueue', op.qid);
        synced++;
        emit('sync_item', { op });
      } catch (e) {
        emit('sync_error', { op, error: e.message });
      }
    }
    if (synced) emit('sync_complete', { synced });
  }

  async function _processQueuedOp(op) {
    switch (op.op) {
      case 'save_product':
        return productsCol().doc(op.data.id).set(op.data.canonical || op.data, { merge: true });
      case 'delete_product':
        return productsCol().doc(op.data.id).update({ status: 'inactive', active: false, deletedAt: nowISO(), updatedAt: nowISO() });
      case 'movement':
        return _callCF('inventoryAdjustStock', op.data);
      case 'create_po':
        return col('inventory_purchaseOrders').doc(op.data.id).set(op.data);
      case 'save_supplier':
        return col('inventory_suppliers').doc(op.data.id).set(op.data, { merge: true });
      default:
        throw new Error(`Unknown queued op: ${op.op}`);
    }
  }

  async function getSyncQueueSize() {
    const q = await idbGetAll('syncQueue');
    return q.length;
  }

  /* ═══════════════════════════════════════════════════════════════════
     CLOUD FUNCTION CALLER
  ═══════════════════════════════════════════════════════════════════ */
  async function _callCF(name, data) {
    if (window.firebase && firebase.functions) {
      const fn = firebase.functions().httpsCallable(name);
      const result = await fn(data);
      return result.data;
    }
    const token = _auth && _uid ? await _auth.currentUser?.getIdToken() : null;
    const res = await fetch(
      `https://${CF_REGION}-${CF_PROJECT}.cloudfunctions.net/${name}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ data }),
      }
    );
    if (!res.ok) {
      const txt = await res.text().catch(() => res.status);
      throw new Error(`CF ${name} failed (${res.status}): ${txt}`);
    }
    const json = await res.json();
    return json.result || json;
  }

  /* ═══════════════════════════════════════════════════════════════════
     SEARCH (client-side fuzzy)
  ═══════════════════════════════════════════════════════════════════ */
  async function searchProducts(query, { limit = 20 } = {}) {
    if (!query) return [];
    const all = await idbGetAll('products');
    const q   = query.toLowerCase();
    const scored = all
      .map(p => {
        let score = 0;
        const name    = (p.name     || '').toLowerCase();
        const sku     = (p.sku      || '').toLowerCase();
        const barcode = (p.barcode  || '').toLowerCase();
        const brand   = (p.brand    || '').toLowerCase();
        if (name.startsWith(q))    score += 100;
        if (name.includes(q))      score +=  50;
        if (sku.includes(q))       score +=  40;
        if (barcode.includes(q))   score +=  60;
        if (brand.includes(q))     score +=  20;
        return { ...p, _score: score };
      })
      .filter(p => p._score > 0)
      .sort((a, b) => b._score - a._score)
      .slice(0, limit);
    return scored;
  }

  /* ═══════════════════════════════════════════════════════════════════
     SERIAL NUMBER TRACKING
  ═══════════════════════════════════════════════════════════════════ */
  async function trackSerial({ productId, serialNo, action, referenceId, notes }) {
    const record = {
      id:          `sn_${uid6()}`,
      productId, serialNo, action,
      referenceId: referenceId || null,
      notes:       notes       || null,
      userId:      currentUid(),
      timestamp:   nowISO(),
      tenantId:    _tenantId,
    };
    if (_online && _fs) {
      await col('inventory_serials').doc(record.id).set(record);
      await col('inventory_serialIndex').doc(serialNo).set({
        productId, lastAction: action, lastRef: referenceId,
        updatedAt: nowISO(),
      }, { merge: true });
    }
    emit('serial_tracked', { record });
    return record;
  }

  async function getSerialHistory(serialNo) {
    if (!_online || !_fs) return [];
    const snap = await col('inventory_serials')
      .where('serialNo', '==', serialNo)
      .orderBy('timestamp', 'desc').get();
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  }

  /* ═══════════════════════════════════════════════════════════════════
     BATCH / EXPIRY TRACKING
  ═══════════════════════════════════════════════════════════════════ */
  async function getNearExpiryBatches(daysAhead = 30) {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() + daysAhead);
    const cutoffISO = cutoff.toISOString().split('T')[0];

    if (_online && _fs) {
      try {
        const snap = await col('inventory_batches')
          .where('expiryDate', '<=', cutoffISO)
          .where('available', '>', 0)
          .orderBy('expiryDate', 'asc').limit(100).get();
        return snap.docs.map(d => ({ id: d.id, ...d.data() }));
      } catch (_) {}
    }
    return [];
  }

  /* ═══════════════════════════════════════════════════════════════════
     INTEGRATION HELPERS (POS, Orders, Delivery)
  ═══════════════════════════════════════════════════════════════════ */
  async function deductForSale({ items, orderId, warehouseId = 'main' }) {
    const movements = [];
    for (const item of items) {
      const mv = await recordMovement({
        productId:    item.productId,
        variantId:    item.variantId || null,
        warehouseId,
        quantity:     -Math.abs(item.quantity),
        type:         MOVEMENT_TYPES.SALE,
        referenceId:  orderId,
        referenceType:'order',
        unitCost:     item.unitCost || 0,
      });
      movements.push(mv);
    }
    return movements;
  }

  async function addFromPurchase({ items, poId, warehouseId = 'main' }) {
    const movements = [];
    for (const item of items) {
      const mv = await recordMovement({
        productId:    item.productId,
        variantId:    item.variantId || null,
        warehouseId,
        quantity:     Math.abs(item.quantity),
        type:         MOVEMENT_TYPES.PURCHASE,
        referenceId:  poId,
        referenceType:'purchase_order',
        unitCost:     item.unitCost || 0,
        batchNumber:  item.batchNumber || null,
        expiryDate:   item.expiryDate  || null,
      });
      movements.push(mv);
    }
    return movements;
  }

  /* ═══════════════════════════════════════════════════════════════════
     PUBLIC API
  ═══════════════════════════════════════════════════════════════════ */
  return Object.freeze({
    // Lifecycle
    init, on, emit,

    // Products
    getProducts, getProduct, getProductByBarcode,
    saveProduct, addProduct, updateProduct, deleteProduct, importProducts, searchProducts,
    getCategories,

    // Stock Levels
    getStockLevel, getStockLevels, getAllStockLevels, getLowStockItems,

    // Movements
    recordMovement, getMovements,

    // Stock Operations
    adjustStock, reserveStock, releaseReservation, transferStock,

    // Purchase Orders
    createPO, updatePO, getPurchaseOrders, receivePO,

    // Suppliers
    getSuppliers, saveSupplier,

    // Warehouses
    getWarehouses, saveWarehouse,

    // Stock Audit
    startStockCount, addAuditItem, submitStockCount,

    // Analytics
    getAnalytics, getInventoryValuation,

    // AI
    aiQuery, aiForecast, aiReorderSuggestions, aiIdentifyProduct,

    // Alerts
    getAlerts, refreshAlerts,

    // Serial & Batch
    trackSerial, getSerialHistory, getNearExpiryBatches,

    // Integration
    deductForSale, addFromPurchase,

    // Utilities
    detectBarcodeType, generateSKU, generateBarcode, getSyncQueueSize,

    // Constants
    MOVEMENT_TYPES, STOCK_STATUS, PO_STATUS,
  });
})();
