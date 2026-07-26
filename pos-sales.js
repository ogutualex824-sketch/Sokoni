/* ================================================================
   SOKONI POS Sales Engine v2.0
   Sale recording, parked sales, returns/exchanges, marketplace sync
   Offline-first: IndexedDB → Firestore, never lose a sale
================================================================ */
/* global firebase, PosInventory, PosCustomers */
window.PosSales = (() => {
  'use strict';

  const DB_NAME = 'sokoni_pos_sales_v2';
  const DB_VER  = 1;
  const S = {
    SALES:   'sales',
    PARKED:  'parked_sales',
    SHIFTS:  'shifts',
    EXPENSES:'expenses',
  };

  let _db        = null;
  let _branchId  = 'default';
  let _shiftId   = null;
  let _cashierId = '';
  let _listeners = {};
  let _mktUnsub  = null;
  let _online    = navigator.onLine;

  const uid = () => { try { return crypto.randomUUID(); } catch (_) { return Date.now().toString(36)+Math.random().toString(36).slice(2); } };
  function on(e, fn)  { (_listeners[e] = _listeners[e] || []).push(fn); }
  function off(e, fn) { if (_listeners[e]) _listeners[e] = _listeners[e].filter(f => f !== fn); }
  function emit(e, d) { (_listeners[e] || []).forEach(fn => { try { fn(d); } catch (_) {} }); }

  /* ── IndexedDB ── */
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
        mk(S.SALES, { keyPath: 'id' }, [
          ['branchId','branchId',{unique:false}], ['timestamp','timestamp',{unique:false}],
          ['status','status',{unique:false}],     ['cashierId','cashierId',{unique:false}],
          ['customerId','customerId',{unique:false}], ['shiftId','shiftId',{unique:false}],
        ]);
        mk(S.PARKED,   { keyPath: 'id' });
        mk(S.SHIFTS,   { keyPath: 'id' }, [['branchId','branchId',{unique:false}], ['status','status',{unique:false}]]);
        mk(S.EXPENSES, { keyPath: 'id' }, [['branchId','branchId',{unique:false}], ['shiftId','shiftId',{unique:false}]]);
      };
      req.onsuccess = e => { _db = e.target.result; res(_db); };
      req.onerror   = e => rej(e.target.error);
    });
  }

  async function _put(store, rec) {
    const db = await _openDB();
    return new Promise((res, rej) => {
      const tx  = db.transaction(store, 'readwrite');
      const req = tx.objectStore(store).put(rec);
      req.onsuccess = () => res(req.result);
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

  async function _all(store, indexName, value) {
    const db = await _openDB();
    return new Promise((res, rej) => {
      const tx  = db.transaction(store, 'readonly');
      const st  = tx.objectStore(store);
      const req = indexName ? st.index(indexName).getAll(value) : st.getAll();
      req.onsuccess = () => res(req.result || []);
      req.onerror   = e => rej(e.target.error);
    });
  }

  async function _del(store, id) {
    const db = await _openDB();
    return new Promise((res, rej) => {
      const tx  = db.transaction(store, 'readwrite');
      const req = tx.objectStore(store).delete(id);
      req.onsuccess = () => res();
      req.onerror   = e => rej(e.target.error);
    });
  }

  /* ── Receipt number generator ── */
  function _receiptNo() {
    const d = new Date();
    const date = d.getFullYear().toString().slice(-2) +
      String(d.getMonth() + 1).padStart(2, '0') +
      String(d.getDate()).padStart(2, '0');
    return 'R' + date + '-' + String(Math.floor(Math.random() * 9000) + 1000);
  }

  /* ══════════════════════════════════════════
     SALES
  ══════════════════════════════════════════ */
  async function recordSale(data) {
    const sale = {
      id:              data.id || uid(),
      branchId:        data.branchId || _branchId,
      cashierId:       data.cashierId || _cashierId,
      shiftId:         data.shiftId || _shiftId,
      type:            data.type || 'sale',   /* sale|refund|exchange */
      items:           (data.items || []).map(i => ({
        productId:   i.productId,
        name:        i.name,
        sku:         i.sku || '',
        qty:         Number(i.qty) || 1,
        price:       Number(i.price) || 0,
        cost:        Number(i.cost) || 0,
        discount:    Number(i.discount) || 0,
        taxRate:     Number(i.taxRate) || 0,
        taxAmount:   Number(i.taxAmount) || 0,
        lineTotal:   Number(i.lineTotal) || 0,
        batchNo:     i.batchNo || '',
        serialNo:    i.serialNo || '',
        expiryDate:  i.expiryDate || '',
      })),
      subtotal:        Number(data.subtotal) || 0,
      discountAmount:  Number(data.discountAmount) || 0,
      couponCode:      data.couponCode || null,
      couponDiscount:  Number(data.couponDiscount) || 0,
      taxAmount:       Number(data.taxAmount) || 0,
      total:           Number(data.total) || 0,
      payments:        (data.payments || []).map(p => ({
        method:    p.method,
        amount:    Number(p.amount) || 0,
        reference: p.reference || '',
      })),
      customerId:      data.customerId || null,
      customerName:    data.customerName || '',
      loyaltyEarned:   Number(data.loyaltyEarned) || 0,
      loyaltyRedeemed: Number(data.loyaltyRedeemed) || 0,
      giftCardCode:    data.giftCardCode || null,
      giftCardAmount:  Number(data.giftCardAmount) || 0,
      receiptNo:       data.receiptNo || _receiptNo(),
      notes:           data.notes || '',
      status:          'completed',
      timestamp:       Date.now(),
      etimsInvoiceNo:  data.etimsInvoiceNo || null,
      etimsCode:       data.etimsCode || null,
      etimsQR:         data.etimsQR || null,
      syncedAt:        null,
    };

    /* 1. Persist locally — this never fails even offline */
    await _put(S.SALES, sale);

    /* 2. Deduct inventory */
    if (window.PosInventory && sale.type === 'sale') {
      PosInventory.deductSaleItems(sale.items, sale.branchId, sale.id, sale.cashierId).catch(() => {});
    }

    /* 3. Update customer loyalty + wallet */
    if (window.PosCustomers && sale.customerId) {
      PosCustomers.recordPurchase(sale.customerId, sale.id, sale.total, sale.loyaltyEarned, sale.loyaltyRedeemed).catch(() => {});
    }

    /* 4. Queue Firestore sync */
    _queueFirestore('posTransactions', sale.id, sale);

    /* 5. Marketplace sync (async, never blocks checkout) */
    if (_online) _syncToMarketplace(sale).catch(() => {});

    /* 6. Update shift totals */
    _updateShiftTotals(sale).catch(() => {});

    emit('sale:recorded', sale);
    return sale;
  }

  async function getSale(id) { return _get(S.SALES, id); }

  async function getSales(branchId = _branchId, opts = {}) {
    const all = await _all(S.SALES, 'branchId', branchId);
    let res   = all;
    if (opts.from)       res = res.filter(s => s.timestamp >= opts.from);
    if (opts.until)      res = res.filter(s => s.timestamp <= opts.until);
    if (opts.cashierId)  res = res.filter(s => s.cashierId === opts.cashierId);
    if (opts.customerId) res = res.filter(s => s.customerId === opts.customerId);
    if (opts.shiftId)    res = res.filter(s => s.shiftId === opts.shiftId);
    if (opts.type)       res = res.filter(s => s.type === opts.type);
    if (opts.status)     res = res.filter(s => s.status !== 'voided' || opts.includeVoided);
    return res.sort((a, b) => b.timestamp - a.timestamp).slice(0, opts.limit || 5000);
  }

  async function getSalesInRange(branchId, from, until) {
    return getSales(branchId, { from, until, includeVoided: true });
  }

  async function getDailySales(branchId = _branchId, date = new Date()) {
    const d = new Date(date); d.setHours(0, 0, 0, 0);
    return getSalesInRange(branchId, d.getTime(), d.getTime() + 86400000);
  }

  async function voidSale(saleId, reason, performedBy) {
    const sale = await _get(S.SALES, saleId);
    if (!sale) throw new Error('Sale not found');
    if (sale.status === 'voided') throw new Error('Already voided');
    sale.status     = 'voided';
    sale.voidedAt   = Date.now();
    sale.voidedBy   = performedBy;
    sale.voidReason = reason;
    await _put(S.SALES, sale);
    _queueFirestore('posTransactions', saleId, sale);
    emit('sale:voided', { saleId, reason });
    return sale;
  }

  /* ── Refund / Exchange ── */
  async function recordRefund(originalSaleId, items, payments, reason, cashierId) {
    const orig = await _get(S.SALES, originalSaleId);
    const total = items.reduce((s, i) => s + i.lineTotal, 0);
    const refundSale = await recordSale({
      type:        'refund',
      items:       items.map(i => ({ ...i, qty: -Math.abs(i.qty) })),
      subtotal:    -total,
      total:       -total,
      payments,
      cashierId,
      notes:       reason,
      customerId:  orig?.customerId,
    });
    /* Restore inventory */
    if (window.PosInventory) {
      for (const item of items) {
        PosInventory.processReturn(item.productId, _branchId, item.qty, originalSaleId, cashierId).catch(() => {});
      }
    }
    return refundSale;
  }

  /* ══════════════════════════════════════════
     PARK & RESUME
  ══════════════════════════════════════════ */
  async function parkSale(cart, note = '', name = '') {
    const p = { id: uid(), cart, note, name: name || ('Hold #' + (await _all(S.PARKED)).length + 1), parkedAt: Date.now(), branchId: _branchId };
    await _put(S.PARKED, p);
    emit('sale:parked', p);
    return p.id;
  }

  async function getParkedSales()       { return _all(S.PARKED); }
  async function resumeSale(id)         { const p = await _get(S.PARKED, id); if (!p) throw new Error('Not found'); await _del(S.PARKED, id); emit('sale:resumed', p); return p; }
  async function deleteParkedSale(id)   { await _del(S.PARKED, id); emit('sale:park_deleted', { id }); }

  /* ══════════════════════════════════════════
     SHIFTS
  ══════════════════════════════════════════ */
  async function openShift(cashierId, openingCash = 0) {
    const existing = (await _all(S.SHIFTS, 'status', 'open')).find(s => s.branchId === _branchId && s.cashierId === cashierId);
    if (existing) return existing;

    const shift = {
      id:           uid(),
      branchId:     _branchId,
      cashierId,
      startTime:    Date.now(),
      endTime:      null,
      openingCash:  Number(openingCash) || 0,
      closingCash:  null,
      totalSales:   0,
      totalRefunds: 0,
      totalTransactions: 0,
      paymentBreakdown: { cash: 0, mpesa: 0, card: 0, credit: 0, giftCard: 0, loyaltyPoints: 0 },
      expensesTotal: 0,
      status:       'open',
    };
    await _put(S.SHIFTS, shift);
    _shiftId   = shift.id;
    _cashierId = cashierId;
    _queueFirestore('posShifts', shift.id, shift);
    emit('shift:opened', shift);
    return shift;
  }

  async function closeShift(cashierId, closingCash) {
    const shift = await _get(S.SHIFTS, _shiftId);
    if (!shift) throw new Error('No open shift');
    shift.endTime     = Date.now();
    shift.closingCash = Number(closingCash) || 0;
    shift.status      = 'closed';
    shift.cashVariance= shift.closingCash - (shift.openingCash + shift.paymentBreakdown.cash - shift.expensesTotal);
    await _put(S.SHIFTS, shift);
    _queueFirestore('posShifts', shift.id, shift);
    _shiftId = null;
    emit('shift:closed', shift);
    return shift;
  }

  async function _updateShiftTotals(sale) {
    if (!_shiftId) return;
    const shift = await _get(S.SHIFTS, _shiftId);
    if (!shift) return;
    if (sale.type === 'sale') {
      shift.totalSales += sale.total;
      shift.totalTransactions++;
    } else if (sale.type === 'refund') {
      shift.totalRefunds += Math.abs(sale.total);
    }
    for (const pay of sale.payments) {
      const k = pay.method.toLowerCase().replace('-', '').replace(' ', '');
      shift.paymentBreakdown[k] = (shift.paymentBreakdown[k] || 0) + pay.amount;
    }
    await _put(S.SHIFTS, shift);
    _queueFirestore('posShifts', shift.id, shift);
  }

  async function getShift(id)          { return _get(S.SHIFTS, id); }
  async function getCurrentShift()     { return _shiftId ? _get(S.SHIFTS, _shiftId) : null; }
  async function getShifts(branchId = _branchId) { return _all(S.SHIFTS, 'branchId', branchId); }

  /* ══════════════════════════════════════════
     EXPENSES
  ══════════════════════════════════════════ */
  async function recordExpense(data) {
    const exp = {
      id:          uid(),
      branchId:    _branchId,
      shiftId:     _shiftId,
      category:    data.category || 'Other',
      description: data.description || '',
      amount:      Number(data.amount) || 0,
      paymentMethod: data.paymentMethod || 'cash',
      receiptUrl:  data.receiptUrl || '',
      recordedBy:  data.recordedBy || _cashierId,
      timestamp:   Date.now(),
    };
    await _put(S.EXPENSES, exp);
    /* Update shift expense total */
    if (_shiftId) {
      const shift = await _get(S.SHIFTS, _shiftId);
      if (shift) { shift.expensesTotal = (shift.expensesTotal || 0) + exp.amount; await _put(S.SHIFTS, shift); }
    }
    _queueFirestore('posExpenses', exp.id, exp);
    emit('expense:recorded', exp);
    return exp;
  }

  async function getExpenses(branchId = _branchId, shiftId) {
    const all = await _all(S.EXPENSES, 'branchId', branchId);
    return shiftId ? all.filter(e => e.shiftId === shiftId) : all;
  }

  /* ══════════════════════════════════════════
     MARKETPLACE INTEGRATION
  ══════════════════════════════════════════ */
  async function _syncToMarketplace(sale) {
    try {
      if (!window.firebase?.functions) return;
      const fn = firebase.functions().httpsCallable('posSyncToMarketplace');
      await fn({ saleId: sale.id, branchId: sale.branchId, items: sale.items });
      sale.syncedAt = Date.now();
      await _put(S.SALES, sale);
    } catch (_) {}
  }

  async function startMarketplaceListener(branchId = _branchId) {
    const fsDb = window.firebase?.firestore?.();
    if (!fsDb || _mktUnsub) return;
    _mktUnsub = fsDb.collection('orders')
      .where('branchId', '==', branchId)
      .where('posProcessed', '==', false)
      .where('status', 'in', ['confirmed', 'processing'])
      .onSnapshot(async snap => {
        for (const change of snap.docChanges()) {
          if (change.type !== 'added') continue;
          const order = { id: change.doc.id, ...change.doc.data() };
          await _processMarketplaceOrder(order);
        }
      }, () => {});
  }

  async function _processMarketplaceOrder(order) {
    if (!window.PosInventory) return;
    const items = (order.items || []).map(i => ({ productId: i.productId, qty: i.qty || i.quantity || 1 }));
    await PosInventory.deductSaleItems(items, order.branchId || _branchId, order.id, 'marketplace');
    const fsDb = window.firebase?.firestore?.();
    /* Server clock, not the till's device clock — this is the authoritative time
       inventory was deducted and the order marked POS-processed. Matches the CF
       (functions/pos-retail.js) which stamps posProcessedAt with serverTimestamp. */
    if (fsDb) await fsDb.collection('orders').doc(order.id).update({ posProcessed: true, posProcessedAt: firebase.firestore.FieldValue.serverTimestamp() });
    emit('marketplace:order_synced', { orderId: order.id });
  }

  function stopMarketplaceListener() { if (_mktUnsub) { try { _mktUnsub(); } catch (_) {} _mktUnsub = null; } }

  /* ── Firestore queue ── */
  function _queueFirestore(collection, docId, data) {
    if (window.PosSync) { try { PosSync.enqueue?.({ collection, docId, data }); } catch (_) {} }
    if (_online && window.firebase?.firestore) {
      const fsDb = firebase.firestore();
      fsDb.collection(collection).doc(docId).set(data, { merge: true }).catch(() => {});
    }
  }

  /* ══════════════════════════════════════════
     ONLINE / OFFLINE
  ══════════════════════════════════════════ */
  window.addEventListener('online',  () => { _online = true;  emit('online', {}); startMarketplaceListener(_branchId).catch(() => {}); });
  window.addEventListener('offline', () => { _online = false; emit('offline', {}); });

  /* ══════════════════════════════════════════
     INIT
  ══════════════════════════════════════════ */
  async function init(branchId = 'default', cashierId = '') {
    _branchId  = branchId;
    _cashierId = cashierId;
    await _openDB();
    if (_online) startMarketplaceListener(branchId).catch(() => {});
    emit('ready', { branchId, online: _online });
  }

  function isOnline() { return _online; }
  function setBranch(id) { _branchId = id; }
  function setCashier(id) { _cashierId = id; }
  function getShiftId() { return _shiftId; }

  return {
    init, isOnline, setBranch, setCashier, getShiftId, on, off,
    /* Sales */
    recordSale, getSale, getSales, getSalesInRange, getDailySales, voidSale, recordRefund,
    /* Park/resume */
    parkSale, getParkedSales, resumeSale, deleteParkedSale,
    /* Shifts */
    openShift, closeShift, getShift, getCurrentShift, getShifts,
    /* Expenses */
    recordExpense, getExpenses,
    /* Marketplace */
    startMarketplaceListener, stopMarketplaceListener,
  };
})();
