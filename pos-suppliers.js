/* ================================================================
   SOKONI POS Supplier Management Engine v2.0
   Supplier database, purchase orders, GRNs, invoices, balances
================================================================ */
/* global firebase, PosInventory */
window.PosSuppliers = (() => {
  'use strict';

  const DB_NAME = 'sokoni_pos_suppliers_v2';
  const DB_VER  = 1;
  const S = {
    SUPPLIERS: 'suppliers',
    POS:       'purchase_orders',
    GRNS:      'grns',
    INVOICES:  'supplier_invoices',
    PAYMENTS:  'supplier_payments',
  };

  let _db      = null;
  let _listeners = {};
  let _online  = navigator.onLine;
  let _branchId = 'default';

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
        mk(S.SUPPLIERS, { keyPath: 'id' }, [['name','name',{unique:false}]]);
        mk(S.POS,       { keyPath: 'id' }, [['supplierId','supplierId',{unique:false}], ['status','status',{unique:false}]]);
        mk(S.GRNS,      { keyPath: 'id' }, [['supplierId','supplierId',{unique:false}], ['poId','poId',{unique:false}]]);
        mk(S.INVOICES,  { keyPath: 'id' }, [['supplierId','supplierId',{unique:false}], ['status','status',{unique:false}]]);
        mk(S.PAYMENTS,  { keyPath: 'id' }, [['supplierId','supplierId',{unique:false}]]);
      };
      req.onsuccess = e => { _db = e.target.result; res(_db); };
      req.onerror   = e => rej(e.target.error);
    });
  }

  async function _put(store, rec) { const db = await _openDB(); return new Promise((res, rej) => { const tx = db.transaction(store,'readwrite'); const req = tx.objectStore(store).put(rec); req.onsuccess=()=>res(req.result); req.onerror=e=>rej(e.target.error); }); }
  async function _get(store, id)  { const db = await _openDB(); return new Promise((res, rej) => { const tx = db.transaction(store,'readonly'); const req = tx.objectStore(store).get(id); req.onsuccess=()=>res(req.result||null); req.onerror=e=>rej(e.target.error); }); }
  async function _all(store, idx, val) { const db = await _openDB(); return new Promise((res, rej) => { const tx = db.transaction(store,'readonly'); const st = tx.objectStore(store); const req = idx ? st.index(idx).getAll(val) : st.getAll(); req.onsuccess=()=>res(req.result||[]); req.onerror=e=>rej(e.target.error); }); }
  async function _del(store, id)  { const db = await _openDB(); return new Promise((res, rej) => { const tx = db.transaction(store,'readwrite'); const req = tx.objectStore(store).delete(id); req.onsuccess=()=>res(); req.onerror=e=>rej(e.target.error); }); }

  function _sync(col, id, data) { if (!_online || !window.firebase?.firestore) return; firebase.firestore().collection(col).doc(id).set(data, { merge: true }).catch(() => {}); }

  /* ── PO number generator ── */
  let _poSeq = 0;
  function _poNo() { return 'PO-' + new Date().getFullYear() + '-' + String(++_poSeq).padStart(5, '0'); }
  function _grnNo()  { return 'GRN-' + Date.now().toString().slice(-8); }
  function _invNo()  { return 'INV-' + Date.now().toString().slice(-8); }

  /* ══════════════════════════════════════════
     SUPPLIERS
  ══════════════════════════════════════════ */
  async function addSupplier(data) {
    const s = {
      id:               data.id || uid(),
      name:             data.name || '',
      contactName:      data.contactName || '',
      phone:            data.phone || '',
      email:            data.email || '',
      address:          data.address || '',
      kraPin:           data.kraPin || '',
      bankAccount:      data.bankAccount || '',
      bankName:         data.bankName || '',
      paymentTerms:     data.paymentTerms || 'net30', /* immediate|net7|net14|net30|net60 */
      currency:         data.currency || 'KES',
      leadDays:         Number(data.leadDays) || 7,
      minOrderValue:    Number(data.minOrderValue) || 0,
      notes:            data.notes || '',
      tags:             data.tags || [],
      status:           'active',
      totalOrders:      0,
      totalSpent:       0,
      outstandingBalance: 0,
      avgLeadDays:      0,
      onTimeRate:       100,
      createdAt:        Date.now(),
      updatedAt:        Date.now(),
    };
    await _put(S.SUPPLIERS, s);
    _sync('posSuppliers', s.id, s);
    emit('supplier:added', s);
    return s;
  }

  async function updateSupplier(id, partial) {
    const s = await _get(S.SUPPLIERS, id);
    if (!s) throw new Error('Supplier not found');
    const u = Object.assign({}, s, partial, { updatedAt: Date.now() });
    await _put(S.SUPPLIERS, u);
    _sync('posSuppliers', id, u);
    emit('supplier:updated', u);
    return u;
  }

  async function getSupplier(id)        { return _get(S.SUPPLIERS, id); }
  async function getAllSuppliers()       { return _all(S.SUPPLIERS); }
  async function searchSuppliers(query) {
    const all = await _all(S.SUPPLIERS);
    const q   = query.toLowerCase();
    return all.filter(s => s.name.toLowerCase().includes(q) || s.phone.includes(q) || s.email.toLowerCase().includes(q));
  }

  /* ══════════════════════════════════════════
     PURCHASE ORDERS
  ══════════════════════════════════════════ */
  async function createPurchaseOrder(data) {
    const items = (data.items || []).map(i => ({
      productId:    i.productId,
      productName:  i.productName || '',
      sku:          i.sku || '',
      qty:          Number(i.qty) || 1,
      unitCost:     Number(i.unitCost) || 0,
      lineTotal:    Number(i.qty) * Number(i.unitCost),
      receivedQty:  0,
      batchNo:      i.batchNo || '',
      expiryDate:   i.expiryDate || '',
    }));
    const totalCost = items.reduce((s, i) => s + i.lineTotal, 0);
    const po = {
      id:           data.id || uid(),
      poNo:         data.poNo || _poNo(),
      supplierId:   data.supplierId,
      supplierName: data.supplierName || '',
      branchId:     data.branchId || _branchId,
      items,
      totalCost,
      currency:     data.currency || 'KES',
      status:       'draft',   /* draft|sent|partial|received|cancelled */
      expectedDate: data.expectedDate || null,
      notes:        data.notes || '',
      createdBy:    data.createdBy || '',
      createdAt:    Date.now(),
      updatedAt:    Date.now(),
      sentAt:       null,
      receivedAt:   null,
    };
    await _put(S.POS, po);
    _sync('posPurchaseOrders', po.id, po);
    emit('po:created', po);
    return po;
  }

  async function sendPurchaseOrder(poId, method = 'email') {
    const po = await _get(S.POS, poId);
    if (!po) throw new Error('PO not found');
    po.status = 'sent';
    po.sentAt = Date.now();
    po.updatedAt = Date.now();
    await _put(S.POS, po);
    _sync('posPurchaseOrders', poId, po);
    /* Notify via Cloud Function */
    if (_online && window.firebase?.functions) {
      firebase.functions().httpsCallable('sendPurchaseOrder')({ poId, method }).catch(() => {});
    }
    emit('po:sent', { poId, method });
    return po;
  }

  async function getPurchaseOrder(id)              { return _get(S.POS, id); }
  async function getPurchaseOrdersBySupplier(sid)  { return _all(S.POS, 'supplierId', sid); }
  async function getAllPurchaseOrders()             { return _all(S.POS); }

  async function cancelPurchaseOrder(poId, reason) {
    const po = await _get(S.POS, poId);
    if (!po) throw new Error('PO not found');
    if (['received','cancelled'].includes(po.status)) throw new Error('Cannot cancel: ' + po.status);
    po.status    = 'cancelled';
    po.updatedAt = Date.now();
    po.cancelReason = reason;
    await _put(S.POS, po);
    _sync('posPurchaseOrders', poId, po);
    emit('po:cancelled', { poId });
    return po;
  }

  /* ══════════════════════════════════════════
     GOODS RECEIVED NOTES (GRNs)
  ══════════════════════════════════════════ */
  async function createGRN(data) {
    const items = (data.items || []).map(i => ({
      productId:    i.productId,
      productName:  i.productName || '',
      orderedQty:   Number(i.orderedQty) || 0,
      receivedQty:  Number(i.receivedQty) || 0,
      rejectedQty:  Number(i.rejectedQty) || 0,
      unitCost:     Number(i.unitCost) || 0,
      lineTotal:    Number(i.receivedQty) * Number(i.unitCost),
      batchNo:      i.batchNo || '',
      expiryDate:   i.expiryDate || '',
      serialNos:    i.serialNos || [],
      condition:    i.condition || 'good',
    }));
    const totalCost = items.reduce((s, i) => s + i.lineTotal, 0);
    const grn = {
      id:           data.id || uid(),
      grnNo:        _grnNo(),
      poId:         data.poId || null,
      supplierId:   data.supplierId,
      supplierName: data.supplierName || '',
      branchId:     data.branchId || _branchId,
      items,
      totalCost,
      invoiceRef:   data.invoiceRef || '',
      deliveryNote: data.deliveryNote || '',
      notes:        data.notes || '',
      receivedBy:   data.receivedBy || '',
      receivedAt:   Date.now(),
      createdAt:    Date.now(),
    };

    await _put(S.GRNS, grn);
    _sync('posGRN', grn.id, grn);

    /* Update PO status */
    if (grn.poId) {
      const po = await _get(S.POS, grn.poId);
      if (po) {
        /* Update received quantities on PO items */
        for (const gItem of grn.items) {
          const pItem = po.items.find(i => i.productId === gItem.productId);
          if (pItem) { pItem.receivedQty = (pItem.receivedQty || 0) + gItem.receivedQty; }
        }
        const allReceived = po.items.every(i => i.receivedQty >= i.qty);
        const anyReceived = po.items.some(i => (i.receivedQty || 0) > 0);
        po.status    = allReceived ? 'received' : anyReceived ? 'partial' : po.status;
        po.receivedAt = allReceived ? Date.now() : null;
        po.updatedAt  = Date.now();
        await _put(S.POS, po);
        _sync('posPurchaseOrders', po.id, po);
      }
    }

    /* Receive goods into inventory */
    if (window.PosInventory) {
      await PosInventory.receiveGoods(items, grn.branchId, grn.id, grn.receivedBy);
    }

    /* Create supplier invoice */
    await createInvoice({
      supplierId:   grn.supplierId,
      supplierName: grn.supplierName,
      grnId:        grn.id,
      poId:         grn.poId,
      amount:       totalCost,
      invoiceRef:   grn.invoiceRef,
    });

    /* Update supplier stats */
    const supplier = await _get(S.SUPPLIERS, grn.supplierId);
    if (supplier) {
      supplier.totalOrders      = (supplier.totalOrders || 0) + 1;
      supplier.totalSpent       = (supplier.totalSpent || 0) + totalCost;
      supplier.outstandingBalance = (supplier.outstandingBalance || 0) + totalCost;
      supplier.updatedAt        = Date.now();
      await _put(S.SUPPLIERS, supplier);
      _sync('posSuppliers', supplier.id, supplier);
    }

    emit('grn:created', grn);
    return grn;
  }

  async function getGRN(id)                  { return _get(S.GRNS, id); }
  async function getGRNsBySupplier(supplierId){ return _all(S.GRNS, 'supplierId', supplierId); }
  async function getAllGRNs()                 { return _all(S.GRNS); }

  /* ══════════════════════════════════════════
     SUPPLIER INVOICES & PAYMENTS
  ══════════════════════════════════════════ */
  async function createInvoice(data) {
    const inv = {
      id:           data.id || uid(),
      invoiceNo:    _invNo(),
      supplierId:   data.supplierId,
      supplierName: data.supplierName || '',
      grnId:        data.grnId || null,
      poId:         data.poId || null,
      amount:       Number(data.amount) || 0,
      paidAmount:   0,
      balance:      Number(data.amount) || 0,
      invoiceRef:   data.invoiceRef || '',
      dueDate:      data.dueDate || null,
      status:       'unpaid',  /* unpaid|partial|paid */
      notes:        data.notes || '',
      createdAt:    Date.now(),
      updatedAt:    Date.now(),
    };
    await _put(S.INVOICES, inv);
    _sync('posSupplierInvoices', inv.id, inv);
    emit('invoice:created', inv);
    return inv;
  }

  async function recordSupplierPayment(supplierId, amount, method, reference, invoiceIds, performedBy) {
    const pmt = {
      id:          uid(),
      supplierId,
      amount:      Number(amount) || 0,
      method:      method || 'bank',
      reference:   reference || '',
      invoiceIds:  invoiceIds || [],
      performedBy: performedBy || '',
      timestamp:   Date.now(),
    };
    await _put(S.PAYMENTS, pmt);
    _sync('posSupplierPayments', pmt.id, pmt);

    /* Update invoices */
    let remaining = pmt.amount;
    for (const invId of invoiceIds) {
      if (remaining <= 0) break;
      const inv = await _get(S.INVOICES, invId);
      if (!inv) continue;
      const pay = Math.min(inv.balance, remaining);
      inv.paidAmount += pay;
      inv.balance    -= pay;
      inv.status     = inv.balance === 0 ? 'paid' : 'partial';
      inv.updatedAt  = Date.now();
      await _put(S.INVOICES, inv);
      _sync('posSupplierInvoices', inv.id, inv);
      remaining -= pay;
    }

    /* Update supplier outstanding balance */
    const supplier = await _get(S.SUPPLIERS, supplierId);
    if (supplier) {
      supplier.outstandingBalance = Math.max(0, (supplier.outstandingBalance || 0) - pmt.amount);
      supplier.updatedAt = Date.now();
      await _put(S.SUPPLIERS, supplier);
      _sync('posSuppliers', supplier.id, supplier);
    }

    emit('payment:recorded', pmt);
    return pmt;
  }

  async function getInvoicesBySupplier(supplierId)  { return _all(S.INVOICES, 'supplierId', supplierId); }
  async function getUnpaidInvoices(supplierId)       {
    const all = await getInvoicesBySupplier(supplierId);
    return all.filter(i => i.status !== 'paid');
  }
  async function getAllInvoices()                    { return _all(S.INVOICES); }

  /* ══════════════════════════════════════════
     SUPPLIER PERFORMANCE
  ══════════════════════════════════════════ */
  async function getSupplierPerformance(supplierId) {
    const s    = await _get(S.SUPPLIERS, supplierId);
    if (!s) throw new Error('Supplier not found');
    const grns = await getGRNsBySupplier(supplierId);
    const pos  = await getPurchaseOrdersBySupplier(supplierId);
    const invs = await getInvoicesBySupplier(supplierId);

    /* Lead time analysis */
    const leadTimes = pos
      .filter(p => p.sentAt && p.receivedAt)
      .map(p => Math.ceil((p.receivedAt - p.sentAt) / 86400000));
    const avgLead   = leadTimes.length ? leadTimes.reduce((a, b) => a + b, 0) / leadTimes.length : 0;

    /* On-time rate: POs received within expected date */
    const onTime = pos.filter(p => p.receivedAt && p.expectedDate && p.receivedAt <= new Date(p.expectedDate).getTime());
    const onTimeRate = pos.filter(p => p.receivedAt && p.expectedDate).length
      ? (onTime.length / pos.filter(p => p.receivedAt && p.expectedDate).length) * 100
      : 100;

    /* Rejection rate */
    const totalOrdered  = grns.reduce((s, g) => s + g.items.reduce((a, i) => a + i.orderedQty, 0), 0);
    const totalRejected = grns.reduce((s, g) => s + g.items.reduce((a, i) => a + (i.rejectedQty || 0), 0), 0);
    const rejectRate    = totalOrdered ? (totalRejected / totalOrdered) * 100 : 0;

    /* Outstanding balance */
    const outstanding = invs.filter(i => i.status !== 'paid').reduce((s, i) => s + i.balance, 0);

    return {
      supplier:       s,
      totalOrders:    pos.length,
      totalSpent:     s.totalSpent,
      outstanding,
      avgLeadDays:    Math.round(avgLead),
      onTimeRate:     Math.round(onTimeRate),
      rejectRate:     Math.round(rejectRate * 10) / 10,
      lastOrderDate:  pos.length ? Math.max(...pos.map(p => p.createdAt)) : null,
    };
  }

  /* ══════════════════════════════════════════
     AUTO-REORDER (integrates with PosInventory)
  ══════════════════════════════════════════ */
  async function createAutoReorderPOs(branchId = _branchId, createdBy = '') {
    if (!window.PosInventory) return [];
    const suggestions = await PosInventory.getReorderSuggestions(branchId);
    const bySupplier  = {};
    for (const s of suggestions) {
      const sid = s.product.supplierId;
      if (!sid) continue;
      bySupplier[sid] = bySupplier[sid] || [];
      bySupplier[sid].push({ productId: s.product.id, productName: s.product.name, sku: s.product.sku, qty: s.reorderQty, unitCost: s.product.cost });
    }
    const createdPOs = [];
    for (const [supplierId, items] of Object.entries(bySupplier)) {
      const supplier = await _get(S.SUPPLIERS, supplierId);
      const po = await createPurchaseOrder({ supplierId, supplierName: supplier?.name || '', branchId, items, createdBy });
      createdPOs.push(po);
    }
    return createdPOs;
  }

  /* ══════════════════════════════════════════
     INIT
  ══════════════════════════════════════════ */
  async function init(branchId = 'default') {
    _branchId = branchId;
    await _openDB();
    window.addEventListener('online',  () => { _online = true; });
    window.addEventListener('offline', () => { _online = false; });
    emit('ready', {});
  }

  return {
    init, on, off,
    /* Suppliers */
    addSupplier, updateSupplier, getSupplier, getAllSuppliers, searchSuppliers,
    /* Purchase Orders */
    createPurchaseOrder, sendPurchaseOrder, getPurchaseOrder,
    getPurchaseOrdersBySupplier, getAllPurchaseOrders, cancelPurchaseOrder,
    /* GRNs */
    createGRN, getGRN, getGRNsBySupplier, getAllGRNs,
    /* Invoices & Payments */
    createInvoice, recordSupplierPayment, getInvoicesBySupplier,
    getUnpaidInvoices, getAllInvoices,
    /* Performance */
    getSupplierPerformance,
    /* Auto-reorder */
    createAutoReorderPOs,
  };
})();
