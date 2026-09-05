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
  let _merchantId = null;   /* canonical merchant/business id — required for cloud sync */

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

  /* ── Cloud sync ──────────────────────────────────────────────────────────────
     These collections are server-authoritative: the served ruleset grants the browser
     READ only (posSuppliers, posPurchaseOrders) and has no match block at all for
     posGRN / posSupplierInvoices / posSupplierPayments, which is a closed-world deny.
     A direct browser write is therefore ALWAYS denied. The previous implementation did
     exactly that and swallowed the rejection with .catch(() => {}), so the UI reported
     success while nothing ever reached the cloud.

     Writes now route through the smartPosDispatch op `posSupplierSync`, which resolves
     the merchant authority server-side and writes with Admin SDK authority. Local-first
     behaviour is unchanged — IndexedDB is still written first and remains the source the
     UI reads — but a sync failure is now RECORDED and EMITTED instead of discarded.
  ─────────────────────────────────────────────────────────────────────────────── */

  /* entity keys accepted by the posSupplierSync op, keyed by local store */
  const SYNC_ENTITY = {
    posSuppliers:         'supplier',
    /* posPurchaseOrders intentionally absent — POs go to the canonical engine. */
    posGRN:               'grn',
    posSupplierInvoices:  'supplierInvoice',
    posSupplierPayments:  'supplierPayment',
  };

  /* Pending/failed mirrors, observable via getSyncState() and the 'sync:*' events. */
  const _syncState = { pending: 0, failed: [], lastError: null, lastOkAt: null };

  function getSyncState() {
    return {
      pending:   _syncState.pending,
      failed:    _syncState.failed.slice(),
      lastError: _syncState.lastError,
      lastOkAt:  _syncState.lastOkAt,
      online:    _online,
    };
  }

  /* Re-attempt every failed mirror. Returns {attempted, ok, failed}. */
  async function retryFailedSyncs() {
    const queue = _syncState.failed.splice(0, _syncState.failed.length);
    let ok = 0, failed = 0;
    for (const item of queue) {
      const r = await _sync(item.col, item.id, item.data);
      if (r && r.ok) ok++; else failed++;
    }
    return { attempted: queue.length, ok: ok, failed: failed };
  }

  /**
   * Mirror one record to its authoritative collection.
   * Never throws — the caller's local write already succeeded — but ALWAYS reports.
   * @returns {Promise<{ok:boolean, skipped?:string, error?:string}>}
   */
  async function _sync(col, id, data) {
    const entity = SYNC_ENTITY[col];
    if (!entity) {
      const msg = 'No sync entity mapped for collection ' + col;
      _syncState.lastError = msg;
      emit('sync:error', { collection: col, id: id, error: msg });
      return { ok: false, error: msg };
    }
    if (!_merchantId) {
      const msg = 'Not initialised with a merchantId — cloud sync unavailable';
      _syncState.lastError = msg;
      _syncState.failed.push({ col: col, id: id, data: data, error: msg });
      emit('sync:error', { collection: col, id: id, error: msg });
      return { ok: false, error: msg };
    }
    if (!_online || !window.firebase?.functions) {
      const msg = _online ? 'Firebase Functions unavailable' : 'Offline';
      _syncState.failed.push({ col: col, id: id, data: data, error: msg });
      emit('sync:deferred', { collection: col, id: id, reason: msg });
      return { ok: false, skipped: msg };
    }

    _syncState.pending++;
    emit('sync:start', { collection: col, id: id });
    try {
      const call = firebase.functions().httpsCallable('smartPosDispatch');
      const res  = await call({ op: 'posSupplierSync', merchantId: _merchantId, entity: entity, id: id, data: data });
      if (!res || !res.data || res.data.ok !== true) {
        throw new Error((res && res.data && res.data.error) || 'Sync rejected by server');
      }
      _syncState.lastOkAt = Date.now();
      emit('sync:ok', { collection: col, id: id });
      return { ok: true };
    } catch (e) {
      const msg = (e && (e.message || e.code)) || 'Unknown sync error';
      _syncState.lastError = msg;
      _syncState.failed.push({ col: col, id: id, data: data, error: msg });
      emit('sync:error', { collection: col, id: id, error: msg });
      return { ok: false, error: msg };
    } finally {
      _syncState.pending--;
    }
  }

  /* PO numbering is SERVER-generated (procCounters, transactional). The client generator
     removed here reset _poSeq to 0 on every page load, so two devices — or one device
     twice — reliably minted the same PO-YYYY-00001. A PO number appears on a supplier's
     invoice and delivery note; it cannot come from a counter that restarts. */
  /* _grnNo() removed (Slice D): GRN numbering is server-issued, like PO numbering. */
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
      /* No poNo. A local draft has no canonical number until the server issues one. */
      poNo:         null,
      procPoId:     null,   /* set on submission — the canonical procPurchaseOrders id */
      supplierId:   data.supplierId,
      supplierName: data.supplierName || '',
      branchId:     data.branchId || _branchId,
      items,
      totalCost,
      currency:     data.currency || 'KES',
      /* local_draft is NOT a lifecycle state — it means "composed here, never submitted".
         Cloud truth lives in procPurchaseOrders; this record is a draft/offline queue entry
         and can never itself become sent/received/invoiced/paid. */
      status:       'local_draft',
      expectedDate: data.expectedDate || null,
      notes:        data.notes || '',
      createdBy:    data.createdBy || '',
      createdAt:    Date.now(),
      updatedAt:    Date.now(),
      sentAt:       null,
      receivedAt:   null,
    };
    await _put(S.POS, po);
    /* No pos* cloud mirror for purchase orders. The canonical engine owns PO truth;
       submitPurchaseOrder() below is the only path to the cloud. */
    emit('po:created', po);
    return po;
  }

  /**
   * Submit a local draft to the CANONICAL procurement engine.
   *
   * This is the only path from a local draft to cloud truth. The server owns PO identity:
   * it issues the procPurchaseOrders id and the human-readable PO number from a
   * transactional counter, and returns both. The local record is then reconciled — it
   * keeps its local id for UI continuity but gains procPoId/poNo and moves to 'submitted'.
   *
   * The draft NEVER becomes sent, received, invoiced or paid here. Those are lifecycle
   * states of the canonical PO and are only ever reflected back from an authoritative
   * server response.
   *
   * merchantId is passed as a REQUEST, not as authority — the backend resolves the
   * authorized merchant from businesses/{id} and ignores a caller who names one they are
   * not authorized for.
   *
   * @returns {Promise<object>} the reconciled local record
   * @throws  {Error} when the server did not accept the draft; the local draft is kept.
   */
  async function submitPurchaseOrder(poId) {
    const po = await _get(S.POS, poId);
    if (!po) throw new Error('Purchase order not found');
    if (po.procPoId) return po;                       /* already submitted — idempotent */
    if (po.status !== 'local_draft') {
      throw new Error('Only a local draft can be submitted (status: ' + po.status + ')');
    }

    const failLocally = async (message, code) => {
      po.lastSubmitError     = message;
      po.lastSubmitErrorCode = code || null;
      po.lastSubmitAttemptAt = Date.now();
      po.updatedAt           = Date.now();
      await _put(S.POS, po);
      emit('po:submit-failed', { poId: poId, error: message, code: code || null });
      const err = new Error(message); err.code = code || null; throw err;
    };

    if (!_merchantId) return failLocally('Not initialised with a merchantId — cannot submit.', 'no-merchant');
    if (!_online)     return failLocally('Cannot submit while offline — the draft is saved and queued.', 'offline');
    if (!window.firebase?.functions) return failLocally('Cannot submit — the procurement service is unavailable.', 'unavailable');

    let res;
    try {
      res = await firebase.functions().httpsCallable('createPurchaseOrder')({
        merchantId: _merchantId,
        supplierId: po.supplierId,
        items: (po.items || []).map(function (i) {
          return { productId: i.productId, name: i.productName, quantity: i.qty, unitPrice: i.unitCost };
        }),
        notes: po.notes || '',
        expectedDelivery: po.expectedDate || undefined,
      });
    } catch (e) {
      return failLocally(
        'Could not submit purchase order: ' + ((e && (e.message || e.code)) || 'the server rejected it'),
        (e && e.code) || 'submit-failed'
      );
    }

    const data = res && res.data;
    if (!data || !data.poId) {
      return failLocally('The server did not return a canonical purchase order id.', 'unconfirmed');
    }

    /* Reconcile: canonical identity in, local draft state out. */
    po.procPoId  = data.poId;
    po.poNo      = data.poNumber || data.poId;
    po.status    = 'submitted';
    po.submittedAt = Date.now();
    po.updatedAt = Date.now();
    delete po.lastSubmitError;
    delete po.lastSubmitErrorCode;
    await _put(S.POS, po);
    emit('po:submitted', { poId: poId, procPoId: po.procPoId, poNo: po.poNo });
    return po;
  }

  /** Drafts composed locally and never submitted. Slice G reconciles these explicitly. */
  async function getUnsubmittedDrafts() {
    const all = await _all(S.POS);
    return all.filter(function (p) { return !p.procPoId; });
  }

  /**
   * Send a purchase order to its supplier.
   *
   * A PO is only 'sent' when the AUTHORITATIVE backend says it was sent. The previous
   * implementation stamped status='sent' and sentAt locally, fired the callable
   * un-awaited, swallowed every rejection with .catch(() => {}), and emitted 'po:sent'
   * unconditionally — so a merchant saw "sent" whether or not anything left the building.
   *
   * KNOWN NAMESPACE GAP (traced 2026-09-05): the canonical callable reads
   * `procPurchaseOrders`, while this module's PO ids live in `posPurchaseOrders`, and the
   * backend additionally requires status 'approved' — a state this module's lifecycle
   * (draft|sent|partial|received|cancelled) does not have. So today this call is EXPECTED
   * to fail with not-found. That failure is now surfaced instead of hidden. Converging this
   * module onto the proc* engine is a separate, deliberately-scoped slice; the canonical
   * endpoint is correct and must not be altered to accept pos* ids.
   *
   * The channel is NOT the caller's decision — the server resolves permitted channels from
   * authoritative supplier contact data. `method` is accepted for signature compatibility
   * and deliberately not sent.
   *
   * @throws {Error} when the authoritative send did not succeed. The local PO is left in
   *   its prior status so the action can be retried without stamping a false sentAt.
   */
  async function sendPurchaseOrder(poId, method = 'email') {
    const po = await _get(S.POS, poId);
    if (!po) throw new Error('PO not found');

    const failLocally = async (message, code) => {
      /* Record the attempt WITHOUT advancing status — local-first is preserved for the
         record itself, but 'sent' is a claim only the server may license. */
      po.lastSendError     = message;
      po.lastSendErrorCode = code || null;
      po.lastSendAttemptAt = Date.now();
      po.updatedAt         = Date.now();
      await _put(S.POS, po);
      emit('po:send-failed', { poId: poId, error: message, code: code || null });
      const err = new Error(message);
      err.code = code || null;
      throw err;
    };

    if (!_online) return failLocally('Cannot send while offline — the purchase order is saved and can be sent later.', 'offline');
    if (!window.firebase?.functions) return failLocally('Cannot send — the send service is unavailable.', 'unavailable');

    let res;
    try {
      res = await firebase.functions().httpsCallable('sendPurchaseOrder')({ poId: poId });
    } catch (e) {
      return failLocally(
        'Could not send purchase order: ' + ((e && (e.message || e.code)) || 'the server rejected the request'),
        (e && e.code) || 'send-failed'
      );
    }

    /* Only an explicit authoritative 'sent' counts. A missing or differently-shaped
       result is NOT success — the old code never checked the result at all. */
    const data = res && res.data;
    if (!data || data.status !== 'sent') {
      return failLocally('The server did not confirm the purchase order was sent.', 'unconfirmed');
    }

    po.status     = 'sent';
    po.sentAt     = Date.now();
    po.updatedAt  = Date.now();
    /* The server's real per-channel outcome, so "sent" stays checkable locally too. */
    po.delivery   = data.delivery || null;
    po.poNumber   = data.poNumber || po.poNumber;
    delete po.lastSendError;
    delete po.lastSendErrorCode;
    await _put(S.POS, po);
    emit('po:sent', { poId: poId, delivery: po.delivery });
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
    emit('po:cancelled', { poId });
    return po;
  }

  /* ══════════════════════════════════════════
     GOODS RECEIVED NOTES (GRNs)
  ══════════════════════════════════════════ */
  /**
   * Record receipt of goods against a purchase order.
   *
   * CONVERGED (Slice D). This used to be a five-part CLIENT transaction: write a local GRN,
   * mirror it to posGRN, mutate the local PO's received quantities and status, call
   * PosInventory.receiveGoods to change stock, create a supplier invoice, and adjust the
   * supplier's outstanding balance — all locally, none of it authoritative, and all of it
   * claimed as done before any server had agreed.
   *
   * Two of those were outright broken. PosInventory.receiveGoods destructures
   * { qty, cost } while GRN items carry { receivedQty, unitCost }, so `inv.qty + qty`
   * evaluated to NaN and stock was set to NaN. And the supplier balance was a money figure
   * maintained entirely on one device.
   *
   * Receipt is now a single authoritative server event. procurement.receiveGoods writes the
   * GRN, updates the PO status, increments posProducts stock and records a stockMovement —
   * in ONE Firestore batch. That makes receipt the canonical inventory event rather than
   * one of two parallel mutations that could disagree.
   *
   * The local record is written for offline continuity but is never authoritative and can
   * never claim 'received' before the server confirms.
   *
   * @returns {Promise<object>} the local GRN record, reconciled with the server result
   * @throws  {Error} when the authoritative receipt did not succeed
   */
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
      grnNo:        null,          /* server-issued; no client GRN numbering */
      procGrnId:    null,          /* canonical procGRN id, set on confirmation */
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
      status:       'local_draft', /* never 'received' until the server says so */
      receivedAt:   null,
      createdAt:    Date.now(),
    };
    await _put(S.GRNS, grn);

    const failLocally = async (message, code) => {
      grn.lastReceiveError     = message;
      grn.lastReceiveAttemptAt = Date.now();
      await _put(S.GRNS, grn);
      emit('grn:failed', { grnId: grn.id, error: message, code: code || null });
      const err = new Error(message); err.code = code || null; throw err;
    };

    /* Receipt is a canonical PO event — it cannot be recorded without one. */
    const po = grn.poId ? await _get(S.POS, grn.poId) : null;
    if (!po)            return failLocally('Receipt requires a purchase order.', 'no-po');
    if (!po.procPoId)   return failLocally('Submit the purchase order before receiving against it.', 'not-submitted');
    if (!_online)       return failLocally('Cannot record receipt while offline — the note is saved.', 'offline');
    if (!window.firebase?.functions) return failLocally('Cannot record receipt — the service is unavailable.', 'unavailable');

    let res;
    try {
      res = await firebase.functions().httpsCallable('receiveGoods')({
        poId:     po.procPoId,          /* the CANONICAL id, never the local one */
        branchId: grn.branchId,
        receivedBy: grn.receivedBy || '',
        items: items.map(function (i) {
          return { productId: i.productId, receivedQty: i.receivedQty, condition: i.condition };
        }),
      });
    } catch (e) {
      return failLocally('Could not record receipt: ' + ((e && (e.message || e.code)) || 'the server rejected it'),
                         (e && e.code) || 'receive-failed');
    }

    const out = res && res.data;
    if (!out || !out.grnId) {
      return failLocally('The server did not confirm receipt.', 'unconfirmed');
    }

    /* Reconcile ONLY from the authoritative result. Inventory, the PO status and the
       stock movement were all written server-side inside one batch; the client does not
       repeat any of them. */
    grn.procGrnId    = out.grnId;
    grn.grnNo        = out.grnId;
    grn.status       = 'received';
    grn.receivedAt   = Date.now();
    grn.discrepancies = out.discrepancies || [];
    delete grn.lastReceiveError;
    await _put(S.GRNS, grn);

    if (out.poStatus) { po.status = out.poStatus; po.updatedAt = Date.now(); await _put(S.POS, po); }

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
  /**
   * Auto-reorder: turn low-stock suggestions into CANONICAL purchase-order drafts.
   *
   * The heuristic is unchanged - PosInventory.getReorderSuggestions decides what needs
   * reordering and in what quantity, grouped by supplier. Slice F changes only where the
   * resulting orders live.
   *
   * THE INVARIANT: auto-reorder may RECOMMEND. It can never autonomously turn a
   * recommendation into an approved or sent purchase order. Each draft is submitted to the
   * canonical engine, which creates it with status 'draft'; from there it needs
   * approvePurchaseOrder (manager-gated and merchant-scoped, Slice C) and then an explicit
   * send. Nothing here approves, sends, or pays - a machine noticing that stock is low is
   * not a decision to spend money.
   *
   * Offline, the draft stays local_draft and is queued; getUnsubmittedDrafts() surfaces it
   * and Slice G reconciles it. A queued draft is never reported as an order that exists.
   *
   * @returns {Promise<Array>} the draft records, each carrying its own submission state.
   *   The array also carries `.summary` = { created, submitted, queued, failed } so a
   *   caller can report what actually happened instead of assuming every draft became an
   *   order.
   */
  async function createAutoReorderPOs(branchId = _branchId, createdBy = '') {
    if (!window.PosInventory) return Object.assign([], { summary: { created: 0, submitted: 0, queued: 0, failed: 0 } });

    /* --- heuristic, unchanged --- */
    const suggestions = await PosInventory.getReorderSuggestions(branchId);
    const bySupplier  = {};
    for (const s of suggestions) {
      const sid = s.product.supplierId;
      if (!sid) continue;
      bySupplier[sid] = bySupplier[sid] || [];
      bySupplier[sid].push({ productId: s.product.id, productName: s.product.name, sku: s.product.sku, qty: s.reorderQty, unitCost: s.product.cost });
    }

    const results = [];
    let submitted = 0, queued = 0, failed = 0;

    for (const [supplierId, items] of Object.entries(bySupplier)) {
      const supplier = await _get(S.SUPPLIERS, supplierId);
      /* Local draft first - identical to a hand-composed one, and the only thing that
         survives if the device is offline. */
      const po = await createPurchaseOrder({ supplierId, supplierName: supplier?.name || '', branchId, items, createdBy });
      po.autoReorder = true;
      await _put(S.POS, po);

      if (!_online || !_merchantId || !window.firebase?.functions) {
        /* Queued, not created-in-the-cloud. Said plainly so a caller cannot mistake it. */
        queued++;
        results.push(po);
        continue;
      }

      try {
        const confirmed = await submitPurchaseOrder(po.id);
        submitted++;
        results.push(confirmed);
      } catch (e) {
        /* A failed submission leaves a local draft with its error recorded by
           submitPurchaseOrder. It is NOT an order, and is not counted as one. */
        failed++;
        results.push(await _get(S.POS, po.id));
      }
    }

    emit('reorder:completed', { created: results.length, submitted, queued, failed });
    return Object.assign(results, {
      summary: { created: results.length, submitted, queued, failed },
    });
  }

  /* ══════════════════════════════════════════
     INIT
  ══════════════════════════════════════════ */
  async function init(branchId = 'default', merchantId = null) {
    _branchId = branchId;
    _merchantId = merchantId || null;
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
    createPurchaseOrder, submitPurchaseOrder, getUnsubmittedDrafts,
    sendPurchaseOrder, getPurchaseOrder,
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
    /* Cloud sync observability — a failed mirror is reported, never swallowed */
    getSyncState, retryFailedSyncs,
  };
})();
