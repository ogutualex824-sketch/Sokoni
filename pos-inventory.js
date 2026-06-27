/* ================================================================
   SOKONI POS Inventory Engine v2.0
   Real-time, offline-first, multi-branch inventory management
   IndexedDB (offline) → Firestore (cloud) dual-layer architecture
================================================================ */
/* global firebase, PosSync */
window.PosInventory = (() => {
  'use strict';

  /* ── IndexedDB config ── */
  const DB_NAME = 'sokoni_pos_v2';
  const DB_VER  = 3;
  const S = {
    PRODUCTS:   'products',
    INVENTORY:  'inventory',   /* {id: branchId__productId} */
    BATCHES:    'batches',
    SERIALS:    'serials',
    MOVEMENTS:  'movements',
    CATEGORIES: 'categories',
    COUPONS:    'coupons',
    GIFT_CARDS: 'gift_cards',
  };

  /* ── State ── */
  let _db         = null;
  let _branchId   = 'default';
  let _listeners  = {};
  let _unsubs     = [];
  let _initialized = false;

  /* ── UUID ── */
  const uid = () => {
    try { return crypto.randomUUID(); }
    catch (_) { return Date.now().toString(36) + Math.random().toString(36).slice(2); }
  };

  /* ── Event emitter ── */
  function on(e, fn)  { (_listeners[e] = _listeners[e] || []).push(fn); }
  function off(e, fn) { if (_listeners[e]) _listeners[e] = _listeners[e].filter(f => f !== fn); }
  function emit(e, d) { (_listeners[e] || []).forEach(fn => { try { fn(d); } catch (_) {} }); }

  /* ══════════════════════════════════════════
     IndexedDB
  ══════════════════════════════════════════ */
  async function _openDB() {
    if (_db) return _db;
    return new Promise((res, rej) => {
      const req = indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded = e => {
        const db = e.target.result;
        const mk = (name, opts, idxs) => {
          if (db.objectStoreNames.contains(name)) return;
          const st = db.createObjectStore(name, opts);
          (idxs || []).forEach(([n, k, o]) => st.createIndex(n, k, o));
        };
        mk(S.PRODUCTS,   { keyPath: 'id' }, [
          ['barcode','barcode',{unique:false}], ['sku','sku',{unique:false}],
          ['category','category',{unique:false}], ['status','status',{unique:false}],
        ]);
        mk(S.INVENTORY,  { keyPath: 'id' }, [
          ['productId','productId',{unique:false}], ['branchId','branchId',{unique:false}],
          ['qty','qty',{unique:false}],
        ]);
        mk(S.BATCHES,    { keyPath: 'id' }, [
          ['productId','productId',{unique:false}], ['branchId','branchId',{unique:false}],
          ['expiryDate','expiryDate',{unique:false}],
        ]);
        mk(S.SERIALS,    { keyPath: 'id' }, [
          ['serialNo','serialNo',{unique:false}], ['productId','productId',{unique:false}],
          ['status','status',{unique:false}],
        ]);
        mk(S.MOVEMENTS,  { keyPath: 'id' }, [
          ['productId','productId',{unique:false}], ['branchId','branchId',{unique:false}],
          ['type','type',{unique:false}], ['timestamp','timestamp',{unique:false}],
        ]);
        mk(S.CATEGORIES, { keyPath: 'id' });
        mk(S.COUPONS,    { keyPath: 'id' }, [['code','code',{unique:true}]]);
        mk(S.GIFT_CARDS, { keyPath: 'id' }, [['code','code',{unique:true}]]);
      };
      req.onsuccess = e => { _db = e.target.result; res(_db); };
      req.onerror   = e => rej(e.target.error);
    });
  }

  async function _all(store, indexName, value) {
    const db = await _openDB();
    return new Promise((res, rej) => {
      const tx  = db.transaction(store, 'readonly');
      const st  = tx.objectStore(store);
      const req = indexName
        ? st.index(indexName).getAll(value)
        : st.getAll();
      req.onsuccess = () => res(req.result || []);
      req.onerror   = e => rej(e.target.error);
    });
  }

  async function _get(store, id) {
    const db = await _openDB();
    return new Promise((res, rej) => {
      const tx = db.transaction(store, 'readonly');
      const req = tx.objectStore(store).get(id);
      req.onsuccess = () => res(req.result || null);
      req.onerror   = e => rej(e.target.error);
    });
  }

  async function _put(store, record) {
    const db = await _openDB();
    return new Promise((res, rej) => {
      const tx  = db.transaction(store, 'readwrite');
      const req = tx.objectStore(store).put(record);
      req.onsuccess = () => res(req.result);
      req.onerror   = e => rej(e.target.error);
    });
  }

  async function _delete(store, id) {
    const db = await _openDB();
    return new Promise((res, rej) => {
      const tx  = db.transaction(store, 'readwrite');
      const req = tx.objectStore(store).delete(id);
      req.onsuccess = () => res();
      req.onerror   = e => rej(e.target.error);
    });
  }

  async function _indexGet(store, indexName, value) {
    const db = await _openDB();
    return new Promise((res, rej) => {
      const tx  = db.transaction(store, 'readonly');
      const req = tx.objectStore(store).index(indexName).get(value);
      req.onsuccess = () => res(req.result || null);
      req.onerror   = e => rej(e.target.error);
    });
  }

  /* ══════════════════════════════════════════
     PRODUCTS
  ══════════════════════════════════════════ */
  async function addProduct(data) {
    const product = {
      id:            data.id || uid(),
      name:          data.name || '',
      sku:           data.sku || '',
      barcode:       data.barcode || '',
      altBarcodes:   data.altBarcodes || [],
      category:      data.category || 'General',
      brand:         data.brand || '',
      description:   data.description || '',
      price:         Number(data.price) || 0,
      cost:          Number(data.cost) || 0,
      taxRate:       Number(data.taxRate ?? 16),
      taxCode:       data.taxCode || 'VAT',
      unit:          data.unit || 'PCS',
      minStockLevel: Number(data.minStockLevel) || 5,
      reorderLevel:  Number(data.reorderLevel) || 10,
      reorderQty:    Number(data.reorderQty) || 20,
      hasExpiry:     !!data.hasExpiry,
      hasBatch:      !!data.hasBatch,
      hasSerial:     !!data.hasSerial,
      supplierId:    data.supplierId || null,
      supplierSku:   data.supplierSku || '',
      imageUrl:      data.imageUrl || '',
      images:        data.images || [],
      weight:        Number(data.weight) || 0,
      dimensions:    data.dimensions || {},
      tags:          data.tags || [],
      status:        data.status || 'active',
      createdAt:     data.createdAt || Date.now(),
      updatedAt:     Date.now(),
      createdBy:     data.createdBy || '',
    };
    await _put(S.PRODUCTS, product);
    _queueSync('products', product.id, product);
    emit('product:added', product);
    return product;
  }

  async function updateProduct(id, partial) {
    const existing = await _get(S.PRODUCTS, id);
    if (!existing) throw new Error('Product not found: ' + id);
    const updated = Object.assign({}, existing, partial, { updatedAt: Date.now() });
    await _put(S.PRODUCTS, updated);
    _queueSync('products', id, updated);
    emit('product:updated', updated);
    return updated;
  }

  async function deleteProduct(id) {
    await _delete(S.PRODUCTS, id);
    _queueSync('products', id, null);
    emit('product:deleted', { id });
  }

  async function getProduct(id) { return _get(S.PRODUCTS, id); }

  async function getProductByBarcode(barcode) {
    /* Check primary barcode */
    let p = await _indexGet(S.PRODUCTS, 'barcode', barcode);
    if (p) return p;
    /* Check alt barcodes */
    const all = await _all(S.PRODUCTS);
    return all.find(pr => (pr.altBarcodes || []).includes(barcode)) || null;
  }

  async function getProductBySKU(sku) { return _indexGet(S.PRODUCTS, 'sku', sku); }

  async function searchProducts(query, opts = {}) {
    const all = await _all(S.PRODUCTS);
    const q   = String(query || '').toLowerCase();
    let results = q
      ? all.filter(p =>
          p.name.toLowerCase().includes(q) ||
          (p.sku || '').toLowerCase().includes(q) ||
          (p.barcode || '').includes(q) ||
          (p.brand || '').toLowerCase().includes(q) ||
          (p.category || '').toLowerCase().includes(q)
        )
      : all;
    if (opts.status)   results = results.filter(p => p.status === opts.status);
    if (opts.category) results = results.filter(p => p.category === opts.category);
    if (opts.supplierId) results = results.filter(p => p.supplierId === opts.supplierId);
    return results.slice(0, opts.limit || 500);
  }

  async function getAllProducts() { return _all(S.PRODUCTS); }

  /* ══════════════════════════════════════════
     INVENTORY (stock levels)
  ══════════════════════════════════════════ */
  function _invId(productId, branchId) { return `${branchId}__${productId}`; }

  async function getStock(productId, branchId = _branchId) {
    const inv = await _get(S.INVENTORY, _invId(productId, branchId));
    return inv || { id: _invId(productId, branchId), productId, branchId, qty: 0, reservedQty: 0, warehouseQty: 0 };
  }

  async function getStockForBranch(branchId = _branchId) {
    return _all(S.INVENTORY, 'branchId', branchId);
  }

  async function _setStock(productId, branchId, qty, reserved = null, warehouse = null) {
    const id  = _invId(productId, branchId);
    const cur = await _get(S.INVENTORY, id) || { id, productId, branchId, qty: 0, reservedQty: 0, warehouseQty: 0 };
    const updated = {
      ...cur,
      qty:          Math.max(0, qty),
      reservedQty:  reserved !== null ? Math.max(0, reserved) : cur.reservedQty,
      warehouseQty: warehouse !== null ? Math.max(0, warehouse) : cur.warehouseQty,
      updatedAt:    Date.now(),
    };
    await _put(S.INVENTORY, updated);
    _queueSync(`inventory/${branchId}`, productId, updated);
    return updated;
  }

  async function adjustStock(productId, branchId = _branchId, delta, reason, ref = '', performedBy = '') {
    const inv = await getStock(productId, branchId);
    const newQty = inv.qty + delta;
    if (newQty < 0 && delta < 0) throw new Error('Insufficient stock. Available: ' + inv.qty);
    await _setStock(productId, branchId, newQty);
    await _recordMovement({
      productId, branchId,
      type: delta >= 0 ? 'adjustment_in' : 'adjustment_out',
      qty: Math.abs(delta),
      reason, reference: ref, performedBy,
    });
    emit('stock:changed', { productId, branchId, qty: newQty, delta, reason });
    /* Low stock alert */
    const product = await getProduct(productId);
    if (product && newQty <= product.minStockLevel) {
      emit('stock:low', { product, qty: newQty, branchId });
    }
    return newQty;
  }

  async function transferStock(productId, fromBranch, toBranch, qty, performedBy = '') {
    if (qty <= 0) throw new Error('Transfer quantity must be positive');
    const fromInv = await getStock(productId, fromBranch);
    if (fromInv.qty < qty) throw new Error(`Insufficient stock in ${fromBranch}. Available: ${fromInv.qty}`);
    await _setStock(productId, fromBranch, fromInv.qty - qty);
    const toInv = await getStock(productId, toBranch);
    await _setStock(productId, toBranch, toInv.qty + qty);
    const ref = uid();
    await _recordMovement({ productId, branchId: fromBranch, type: 'transfer_out', qty, reference: ref, performedBy });
    await _recordMovement({ productId, branchId: toBranch,   type: 'transfer_in',  qty, reference: ref, performedBy });
    emit('stock:transferred', { productId, fromBranch, toBranch, qty });
  }

  async function writeDamaged(productId, branchId = _branchId, qty, reason, performedBy = '') {
    return adjustStock(productId, branchId, -qty, reason || 'Damaged goods', uid(), performedBy);
  }

  /* Called on every sale — decrements stock, consumes batches FEFO */
  async function deductSaleItems(items, branchId = _branchId, saleId = '', cashierId = '') {
    for (const item of items) {
      const { productId, qty } = item;
      const product = await getProduct(productId);
      if (!product) continue;

      if (product.hasBatch) {
        await _consumeBatchFEFO(productId, branchId, qty, saleId);
      } else if (product.hasSerial) {
        if (item.serialNo) await _consumeSerial(productId, item.serialNo, saleId);
      } else {
        const inv = await getStock(productId, branchId);
        await _setStock(productId, branchId, inv.qty - qty);
      }
      await _recordMovement({
        productId, branchId, type: 'sale', qty,
        reference: saleId, performedBy: cashierId,
      });
      emit('stock:changed', { productId, branchId, delta: -qty, reason: 'sale', saleId });
    }
  }

  /* Called when goods are received (GRN) */
  async function receiveGoods(items, branchId = _branchId, grnId = '', performedBy = '') {
    for (const item of items) {
      const { productId, qty, cost, batchNo, expiryDate, serialNos } = item;
      const inv = await getStock(productId, branchId);
      await _setStock(productId, branchId, inv.qty + qty);

      if (batchNo || expiryDate) {
        await addBatch({ productId, branchId, batchNo: batchNo || grnId, expiryDate, receivedQty: qty, remainingQty: qty, cost, grnId });
      }
      if (serialNos && serialNos.length) {
        for (const sn of serialNos) {
          await addSerial({ productId, branchId, serialNo: sn, grnId, cost });
        }
      }
      await _recordMovement({
        productId, branchId, type: 'purchase', qty,
        reference: grnId, performedBy, cost,
      });
    }
    emit('goods:received', { grnId, branchId, itemCount: items.length });
  }

  /* Called when items are returned to supplier */
  async function returnToSupplier(productId, branchId = _branchId, qty, supplierId, reason, performedBy = '') {
    const inv = await getStock(productId, branchId);
    if (inv.qty < qty) throw new Error('Insufficient stock for supplier return');
    await _setStock(productId, branchId, inv.qty - qty);
    const ref = uid();
    await _recordMovement({ productId, branchId, type: 'return_supplier', qty, reference: ref, reason, performedBy });
    emit('stock:returned_to_supplier', { productId, branchId, qty, supplierId });
    return ref;
  }

  /* Called on customer return — restores stock */
  async function processReturn(productId, branchId = _branchId, qty, saleId, performedBy = '') {
    const inv = await getStock(productId, branchId);
    await _setStock(productId, branchId, inv.qty + qty);
    await _recordMovement({ productId, branchId, type: 'return_customer', qty, reference: saleId, performedBy });
    emit('stock:returned', { productId, branchId, qty, saleId });
  }

  /* ══════════════════════════════════════════
     BATCH TRACKING (FEFO — First Expiry First Out)
  ══════════════════════════════════════════ */
  async function addBatch(data) {
    const batch = {
      id:           data.id || uid(),
      productId:    data.productId,
      branchId:     data.branchId || _branchId,
      batchNo:      data.batchNo || '',
      expiryDate:   data.expiryDate || null,
      receivedQty:  Number(data.receivedQty) || 0,
      remainingQty: Number(data.remainingQty) || 0,
      cost:         Number(data.cost) || 0,
      grnId:        data.grnId || '',
      receivedAt:   Date.now(),
      status:       'active',
    };
    await _put(S.BATCHES, batch);
    emit('batch:added', batch);
    return batch;
  }

  async function getBatches(productId, branchId = _branchId) {
    const all = await _all(S.BATCHES, 'productId', productId);
    return all
      .filter(b => b.branchId === branchId && b.remainingQty > 0 && b.status !== 'depleted')
      .sort((a, b) => (a.expiryDate || '9999') < (b.expiryDate || '9999') ? -1 : 1);
  }

  async function _consumeBatchFEFO(productId, branchId, qty, saleId) {
    let remaining = qty;
    const batches = await getBatches(productId, branchId);
    for (const batch of batches) {
      if (remaining <= 0) break;
      const take = Math.min(batch.remainingQty, remaining);
      batch.remainingQty -= take;
      batch.status = batch.remainingQty === 0 ? 'depleted' : 'active';
      await _put(S.BATCHES, batch);
      remaining -= take;
    }
    /* Deduct from overall inventory */
    const inv = await getStock(productId, branchId);
    await _setStock(productId, branchId, inv.qty - qty);
  }

  async function getExpiringItems(branchId = _branchId, withinDays = 30) {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() + withinDays);
    const cutStr = cutoff.toISOString().slice(0, 10);
    const all    = await _all(S.BATCHES, 'branchId', branchId);
    return all.filter(b => b.expiryDate && b.expiryDate <= cutStr && b.remainingQty > 0);
  }

  /* ══════════════════════════════════════════
     SERIAL NUMBER TRACKING
  ══════════════════════════════════════════ */
  async function addSerial(data) {
    const serial = {
      id:        data.id || uid(),
      productId: data.productId,
      branchId:  data.branchId || _branchId,
      serialNo:  data.serialNo,
      batchId:   data.batchId || null,
      grnId:     data.grnId || '',
      cost:      Number(data.cost) || 0,
      status:    'in_stock',
      receivedAt:Date.now(),
      saleId:    null,
      soldAt:    null,
    };
    await _put(S.SERIALS, serial);
    return serial;
  }

  async function getSerialByNo(serialNo) { return _indexGet(S.SERIALS, 'serialNo', serialNo); }

  async function _consumeSerial(productId, serialNo, saleId) {
    const serial = await getSerialByNo(serialNo);
    if (!serial || serial.status !== 'in_stock') throw new Error('Serial not available: ' + serialNo);
    serial.status = 'sold';
    serial.saleId = saleId;
    serial.soldAt = Date.now();
    await _put(S.SERIALS, serial);
    const inv = await getStock(productId, serial.branchId);
    await _setStock(productId, serial.branchId, inv.qty - 1);
  }

  async function getSerials(productId, branchId = _branchId, status = 'in_stock') {
    const all = await _all(S.SERIALS, 'productId', productId);
    return all.filter(s => s.branchId === branchId && (!status || s.status === status));
  }

  /* ══════════════════════════════════════════
     STOCK MOVEMENTS (audit trail)
  ══════════════════════════════════════════ */
  async function _recordMovement(data) {
    const mv = {
      id:          uid(),
      productId:   data.productId,
      branchId:    data.branchId || _branchId,
      type:        data.type,
      qty:         Number(data.qty) || 0,
      reference:   data.reference || '',
      reason:      data.reason || '',
      batchNo:     data.batchNo || '',
      serialNo:    data.serialNo || '',
      cost:        Number(data.cost) || 0,
      performedBy: data.performedBy || '',
      timestamp:   Date.now(),
    };
    await _put(S.MOVEMENTS, mv);
    return mv;
  }

  async function getMovements(productId, branchId = _branchId, limit = 50) {
    const all = await _all(S.MOVEMENTS, 'productId', productId);
    return all
      .filter(m => !branchId || m.branchId === branchId)
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, limit);
  }

  /* ══════════════════════════════════════════
     LOW STOCK & REORDER
  ══════════════════════════════════════════ */
  async function getLowStockItems(branchId = _branchId) {
    const invItems = await getStockForBranch(branchId);
    const results  = [];
    for (const inv of invItems) {
      const product = await getProduct(inv.productId);
      if (!product || product.status !== 'active') continue;
      if (inv.qty <= product.minStockLevel) {
        results.push({ product, qty: inv.qty, minLevel: product.minStockLevel, reorderQty: product.reorderQty });
      }
    }
    return results.sort((a, b) => a.qty - b.qty);
  }

  async function getReorderSuggestions(branchId = _branchId) {
    const lowStock = await getLowStockItems(branchId);
    return lowStock
      .filter(item => item.product.supplierId)
      .map(item => ({
        product:    item.product,
        currentQty: item.qty,
        reorderQty: item.product.reorderQty,
        supplierId: item.product.supplierId,
        estimatedCost: item.product.cost * item.product.reorderQty,
      }));
  }

  /* ══════════════════════════════════════════
     CATEGORIES
  ══════════════════════════════════════════ */
  async function getCategories() { return _all(S.CATEGORIES); }

  async function addCategory(data) {
    const cat = { id: data.id || uid(), name: data.name, color: data.color || '#7c3aed', icon: data.icon || '📦' };
    await _put(S.CATEGORIES, cat);
    _queueSync('categories', cat.id, cat);
    return cat;
  }

  /* ══════════════════════════════════════════
     COUPONS
  ══════════════════════════════════════════ */
  async function getCoupon(code) {
    const c = await _indexGet(S.COUPONS, 'code', code.toUpperCase());
    if (!c) return null;
    if (c.expiresAt && c.expiresAt < Date.now()) return null; /* expired */
    if (c.usageLimit && c.usedCount >= c.usageLimit) return null; /* exhausted */
    return c;
  }

  async function applyCoupon(code, subtotal) {
    const c = await getCoupon(code);
    if (!c) throw new Error('Invalid or expired coupon: ' + code);
    const discount = c.type === 'percent'
      ? (subtotal * c.value / 100)
      : Math.min(c.value, subtotal);
    return { coupon: c, discount: Math.round(discount * 100) / 100 };
  }

  async function redeemCoupon(code) {
    const c = await getCoupon(code);
    if (c) {
      c.usedCount = (c.usedCount || 0) + 1;
      await _put(S.COUPONS, c);
      _queueSync('coupons', c.id, c);
    }
  }

  async function addCoupon(data) {
    const c = {
      id:         data.id || uid(),
      code:       String(data.code || '').toUpperCase(),
      type:       data.type || 'percent',   /* 'percent'|'fixed' */
      value:      Number(data.value) || 0,
      minOrder:   Number(data.minOrder) || 0,
      usageLimit: data.usageLimit || null,
      usedCount:  0,
      expiresAt:  data.expiresAt || null,
      createdAt:  Date.now(),
    };
    await _put(S.COUPONS, c);
    _queueSync('coupons', c.id, c);
    return c;
  }

  /* ══════════════════════════════════════════
     GIFT CARDS
  ══════════════════════════════════════════ */
  async function getGiftCard(code) { return _indexGet(S.GIFT_CARDS, 'code', code); }

  async function redeemGiftCard(code, amount) {
    const gc = await getGiftCard(code);
    if (!gc) throw new Error('Gift card not found');
    if (gc.balance < amount) throw new Error(`Gift card balance (${gc.balance}) insufficient`);
    gc.balance  -= amount;
    gc.status    = gc.balance === 0 ? 'depleted' : 'active';
    gc.updatedAt = Date.now();
    await _put(S.GIFT_CARDS, gc);
    _queueSync('giftCards', gc.id, gc);
    return gc;
  }

  async function addGiftCard(data) {
    const gc = {
      id:         data.id || uid(),
      code:       data.code || uid().slice(0, 12).toUpperCase(),
      balance:    Number(data.balance) || 0,
      originalBalance: Number(data.balance) || 0,
      issuedTo:   data.issuedTo || null,
      expiresAt:  data.expiresAt || null,
      status:     'active',
      createdAt:  Date.now(),
    };
    await _put(S.GIFT_CARDS, gc);
    _queueSync('giftCards', gc.id, gc);
    return gc;
  }

  /* ══════════════════════════════════════════
     SYNC QUEUE — delegate to PosSync if available
  ══════════════════════════════════════════ */
  function _queueSync(collection, docId, data) {
    if (window.PosSync) {
      PosSync.queue(collection, docId, data);
    }
  }

  /* ══════════════════════════════════════════
     FIRESTORE REAL-TIME SYNC (online mode)
  ══════════════════════════════════════════ */
  async function startFirestoreSync(branchId = _branchId) {
    stopFirestoreSync();
    const db = window.firebase?.firestore?.();
    if (!db) return;

    /* Listen to product changes */
    const unsub1 = db.collection('posProducts')
      .where('status', '!=', 'deleted')
      .onSnapshot(snap => {
        snap.docChanges().forEach(change => {
          const data = { id: change.doc.id, ...change.doc.data() };
          if (change.type === 'removed') { _delete(S.PRODUCTS, data.id).catch(() => {}); }
          else { _put(S.PRODUCTS, data).catch(() => {}); }
        });
      }, () => {});

    /* Listen to inventory for this branch */
    const unsub2 = db.collection('posInventory')
      .where('branchId', '==', branchId)
      .onSnapshot(snap => {
        snap.docChanges().forEach(change => {
          const data = { id: change.doc.id, ...change.doc.data() };
          if (change.type !== 'removed') _put(S.INVENTORY, data).catch(() => {});
        });
      }, () => {});

    _unsubs = [unsub1, unsub2];
  }

  function stopFirestoreSync() {
    _unsubs.forEach(u => { try { u(); } catch (_) {} });
    _unsubs = [];
  }

  /* ══════════════════════════════════════════
     INIT
  ══════════════════════════════════════════ */
  async function init(branchId = 'default') {
    _branchId = branchId;
    await _openDB();
    startFirestoreSync(branchId).catch(() => {});
    _initialized = true;
    emit('ready', { branchId });
  }

  function setBranch(id) { _branchId = id; }
  function getBranch()   { return _branchId; }

  /* ══════════════════════════════════════════
     BARCODE GENERATION
  ══════════════════════════════════════════ */
  function generateBarcode(prefix = '200', seq = null) {
    const n = seq !== null ? String(seq).padStart(9, '0') : String(Date.now()).slice(-9);
    const code12 = prefix.slice(0, 3) + n;
    /* EAN-13 checksum */
    let sum = 0;
    for (let i = 0; i < 12; i++) sum += parseInt(code12[i]) * (i % 2 === 0 ? 1 : 3);
    const check = (10 - (sum % 10)) % 10;
    return code12 + check;
  }

  function generateSKU(category = 'GEN', seq = null) {
    const n = seq !== null ? String(seq).padStart(5, '0') : String(Date.now() % 100000).padStart(5, '0');
    return (category.slice(0, 3).toUpperCase()) + '-' + n;
  }

  return {
    /* Init */
    init, setBranch, getBranch, on, off,
    /* Products */
    addProduct, updateProduct, deleteProduct, getProduct,
    getProductByBarcode, getProductBySKU, searchProducts, getAllProducts,
    /* Stock */
    getStock, getStockForBranch, adjustStock, transferStock,
    writeDamaged, deductSaleItems, receiveGoods, returnToSupplier, processReturn,
    /* Batches */
    addBatch, getBatches, getExpiringItems,
    /* Serials */
    addSerial, getSerialByNo, getSerials,
    /* Movements */
    getMovements,
    /* Alerts */
    getLowStockItems, getReorderSuggestions,
    /* Categories */
    getCategories, addCategory,
    /* Coupons */
    getCoupon, applyCoupon, redeemCoupon, addCoupon,
    /* Gift cards */
    getGiftCard, redeemGiftCard, addGiftCard,
    /* Barcode generation */
    generateBarcode, generateSKU,
    /* Sync */
    startFirestoreSync, stopFirestoreSync,
  };
})();
