/* ════════════════════════════════════════════════════════════════════════
   SOKONI OrderService (R1.1 Phase 3) — the single source of truth for orders.

   Normalises every order source into ONE UnifiedOrderView with a canonical id,
   an immutable event timeline, and retained source metadata for auditing:

     POS transactions (IndexedDB sokoni_smartpos) ─┐
     Marketplace / delivery / pickup orders ───────┼─► OrderService ─► UnifiedOrderView[]
     (provided by the shell via setOnlineProvider)  ┘         │
                                                              ▼
             Orders module · Dashboard · Reports · Finance · Analytics

   Runs in the Merchant Shell (top-level), so every module reads the SAME numbers.
   No duplicates: records are de-duped by (source + canonical id). Loaded by
   merchant.html; exposes window.SokoniOrderService.
   ════════════════════════════════════════════════════════════════════════ */
(function (root) {
  'use strict';

  var POS_DB = 'sokoni_smartpos', POS_VER = 4;

  /* ── POS source (IndexedDB, read directly — the POS app need not be open) ── */
  function _openPos () {
    return new Promise(function (res, rej) {
      try {
        var r = indexedDB.open(POS_DB, POS_VER);
        r.onsuccess = function () { res(r.result); };
        r.onerror   = function () { rej(r.error || new Error('idb error')); };
        r.onblocked = function () { rej(new Error('idb blocked')); };
      } catch (e) { rej(e); }
    });
  }
  function _getAll (db, store) {
    return new Promise(function (res) {
      try {
        if (!db.objectStoreNames.contains(store)) return res([]);
        var rq = db.transaction(store, 'readonly').objectStore(store).getAll();
        rq.onsuccess = function () { res(rq.result || []); };
        rq.onerror   = function () { res([]); };
      } catch (e) { res([]); }
    });
  }

  /* ── Normalisers ── */
  function _num (n) { return Number(n || 0); }

  function _fromPos (t) {
    var ts = t.completedAt || t.timestamp || Date.now();
    var status = t.voided ? 'cancelled' : (t.refunded ? 'refunded' : 'completed');
    return {
      id:          'POS-' + (t.receiptNo || String(t.id || '').slice(-6)),
      canonicalId: String(t.id || t.receiptNo || ts),
      source:      'pos',
      channel:     'in_store',
      customer:    t.customerName || 'Walk-in Customer',
      phone:       t.customerPhone || '',
      cashier:     t.cashierName || '',
      items:       (t.items || []).map(function (i) { return { name: i.name || i.productName || 'Item', qty: i.qty || 1, price: (i.unitPrice != null ? i.unitPrice : (i.price || 0)) }; }),
      itemCount:   (t.items || []).length,
      subtotal:    _num(t.subtotal != null ? t.subtotal : t.total),
      discount:    _num(t.discountAmount != null ? t.discountAmount : t.discount),
      tax:         _num(t.taxAmount != null ? t.taxAmount : t.tax),
      deliveryFee: 0,
      total:       _num(t.total),
      paymentMethod: (t.paymentMethod || 'cash'),
      paymentStatus: 'paid',
      status:      status,
      ts:          ts,
      events:      _timelinePos(t, status, ts),
      raw:         t,
    };
  }
  function _timelinePos (t, status, ts) {
    var ev = [
      { type: 'ORDER_CREATED',      at: t.timestamp || ts },
      { type: 'PAYMENT_AUTHORIZED', at: ts },
      { type: 'COMPLETED',          at: ts },
    ];
    if (status === 'refunded')  ev.push({ type: 'REFUNDED',  at: t.refundedAt || ts });
    if (status === 'cancelled') ev.push({ type: 'CANCELLED', at: t.voidedAt || ts });
    return ev;
  }

  function _mapOnlineStatus (s) {
    s = String(s || '').toLowerCase();
    if (/deliver|complete|fulfil/.test(s)) return 'completed';
    if (/cancel/.test(s))                  return 'cancelled';
    if (/refund/.test(s))                  return 'refunded';
    if (/return/.test(s))                  return 'returned';
    return 'pending';
  }
  function _onlineChannel (o) {
    var d = String(o.deliveryType || o.fulfilment || o.type || '').toLowerCase();
    if (/pickup/.test(d)) return 'pickup';
    if (/deliver/.test(d) || o.delivery || o.riderId) return 'delivery';
    return 'online';
  }
  function _fromOnline (o) {
    var ts = o.ts || o.createdAt || o.timestamp || (o.createdAtMs) || Date.now();
    if (ts && ts.toMillis) ts = ts.toMillis();               /* Firestore Timestamp */
    if (typeof ts === 'string') { var p = Date.parse(ts); if (!isNaN(p)) ts = p; }
    var status = _mapOnlineStatus(o.status);
    return {
      id:          o.orderNo || o.orderId || o.id || ('SKN-' + String(o.id || '').slice(-6)),
      canonicalId: String(o.id || o.orderId || o.orderNo || ts),
      source:      'marketplace',
      channel:     _onlineChannel(o),
      customer:    o.customerName || o.buyerName || o.customer || 'Customer',
      phone:       o.customerPhone || o.phone || o.buyerPhone || '',
      rider:       o.riderName || o.rider || '',
      items:       (o.items || []).map(function (i) { return { name: i.name || i.productName || 'Item', qty: i.qty || i.quantity || 1, price: (i.price != null ? i.price : (i.unitPrice || 0)) }; }),
      itemCount:   (o.items || []).length,
      subtotal:    _num(o.subtotal != null ? o.subtotal : (o.total || o.amount)),
      discount:    _num(o.discount),
      tax:         _num(o.tax),
      deliveryFee: _num(o.deliveryFee),
      total:       _num(o.total != null ? o.total : o.amount),
      paymentMethod: (o.paymentMethod || 'mpesa'),
      paymentStatus: (o.paid || String(o.paymentStatus || '').toLowerCase() === 'paid' || /paid|complete/.test(String(o.status || '').toLowerCase())) ? 'paid' : (o.paymentStatus || 'pending'),
      status:      status,
      ts:          ts,
      events:      (o.events && o.events.length) ? o.events : _timelineOnline(o, status, ts),
      raw:         o,
    };
  }
  function _timelineOnline (o, status, ts) {
    var ev = [{ type: 'ORDER_CREATED', at: o.createdAt || ts }];
    if (o.paidAt || status !== 'pending') ev.push({ type: 'PAYMENT_AUTHORIZED', at: o.paidAt || ts });
    var s = String(o.status || '').toLowerCase();
    if (/accept|confirm/.test(s)) ev.push({ type: 'ORDER_ACCEPTED', at: ts });
    if (/prepar/.test(s))         ev.push({ type: 'ORDER_PREPARING', at: ts });
    if (/ready/.test(s))          ev.push({ type: 'ORDER_READY', at: ts });
    if (o.riderId || o.riderName) ev.push({ type: 'RIDER_ASSIGNED', at: ts });
    if (/pick/.test(s))           ev.push({ type: 'PICKED_UP', at: ts });
    if (status === 'completed')   ev.push({ type: 'DELIVERED', at: o.deliveredAt || ts });
    if (status === 'refunded')    ev.push({ type: 'REFUNDED', at: ts });
    if (status === 'cancelled')   ev.push({ type: 'CANCELLED', at: ts });
    if (status === 'returned')    ev.push({ type: 'RETURNED', at: ts });
    return ev;
  }

  /* ── Online provider — the shell wires this to fetch marketplace/delivery orders
     (e.g. by asking the Seller module, which holds the authenticated query). Returns
     a Promise of raw order objects. Null until wired → POS-only, no fabricated data. */
  var _onlineProvider = null;
  function setOnlineProvider (fn) { _onlineProvider = (typeof fn === 'function') ? fn : null; }

  /* ── Filters ── */
  function _rangeFrom (range) {
    var now = new Date();
    if (range === 'all') return 0;
    if (range === 'week')  { var d = new Date(now); d.setDate(d.getDate() - 6);  return d.setHours(0, 0, 0, 0); }
    if (range === 'month') { var e = new Date(now); e.setDate(e.getDate() - 29); return e.setHours(0, 0, 0, 0); }
    return new Date(now).setHours(0, 0, 0, 0);               /* today */
  }
  function _matchTab (o, tab) {
    switch (tab) {
      case 'all':       return true;
      case 'online':    return o.source === 'marketplace';
      case 'instore':   return o.channel === 'in_store';
      case 'delivery':  return o.channel === 'delivery';
      case 'pickup':    return o.channel === 'pickup';
      case 'pending':   return o.status === 'pending';
      case 'completed': return o.status === 'completed';
      case 'refunded':  return o.status === 'refunded' || o.status === 'returned';
      case 'cancelled': return o.status === 'cancelled';
      default:          return true;
    }
  }

  /* ── Public API ── */
  async function getAll (opts) {
    opts = opts || {};
    var out = [];

    /* POS */
    try {
      var db = await _openPos();
      var txns = await _getAll(db, 'transactions');
      txns.forEach(function (t) {
        if (t.status === 'completed' || t.refunded || t.voided || t.completedAt) out.push(_fromPos(t));
      });
    } catch (e) { /* POS DB unavailable — online-only */ }

    /* Marketplace / delivery / pickup */
    if (_onlineProvider) {
      try {
        var online = await _onlineProvider();
        (online || []).forEach(function (o) { try { out.push(_fromOnline(o)); } catch (_) {} });
      } catch (e) { /* provider failed — POS-only this pass */ }
    }

    /* De-dupe by (source + canonical id) — same record from two reads never doubles. */
    var seen = {}, dedup = [];
    out.forEach(function (o) { var k = o.source + ':' + o.canonicalId; if (!seen[k]) { seen[k] = 1; dedup.push(o); } });

    /* Range + tab + search */
    var from = _rangeFrom(opts.range || 'today');
    var rows = dedup.filter(function (o) { return o.ts >= from; });
    if (opts.tab && opts.tab !== 'all') rows = rows.filter(function (o) { return _matchTab(o, opts.tab); });
    if (opts.search) {
      var q = String(opts.search).toLowerCase();
      rows = rows.filter(function (o) {
        return (o.id + ' ' + o.customer + ' ' + o.phone + ' ' + (o.rider || '') + ' ' +
          (o.items || []).map(function (i) { return i.name; }).join(' ')).toLowerCase().indexOf(q) >= 0;
      });
    }
    rows.sort(function (a, b) { return b.ts - a.ts; });
    return rows;
  }

  /* Summary aggregates over a set of unified orders — one place, so Dashboard/Reports/Finance
     all derive the SAME figures from the SAME source (Phase 4 builds on this). */
  function summarize (orders) {
    var s = { count: orders.length, revenue: 0, online: 0, instore: 0, delivery: 0, pickup: 0,
              pending: 0, completed: 0, refunded: 0, cancelled: 0, tax: 0, discount: 0, deliveryFees: 0 };
    orders.forEach(function (o) {
      if (o.status !== 'cancelled') s.revenue += o.total;
      if (o.source === 'marketplace') s.online++; else s.instore++;
      if (o.channel === 'delivery') s.delivery++;
      if (o.channel === 'pickup') s.pickup++;
      if (o.status === 'pending') s.pending++;
      if (o.status === 'completed') s.completed++;
      if (o.status === 'refunded' || o.status === 'returned') s.refunded++;
      if (o.status === 'cancelled') s.cancelled++;
      s.tax += o.tax; s.discount += o.discount; s.deliveryFees += o.deliveryFee;
    });
    return s;
  }

  root.SokoniOrderService = {
    query: getAll,          /* public name is query() — reads all sources into UnifiedOrderView */
    summarize: summarize,
    setOnlineProvider: setOnlineProvider,
    hasOnlineProvider: function () { return !!_onlineProvider; },
    EVENT_LABELS: {
      ORDER_CREATED: 'Order placed', PAYMENT_AUTHORIZED: 'Payment received', ORDER_ACCEPTED: 'Accepted',
      ORDER_PREPARING: 'Preparing', ORDER_READY: 'Ready', RIDER_ASSIGNED: 'Rider assigned',
      PICKED_UP: 'Picked up', DELIVERED: 'Delivered', COMPLETED: 'Completed',
      REFUND_REQUESTED: 'Refund requested', REFUNDED: 'Refunded', CANCELLED: 'Cancelled', RETURNED: 'Returned',
    },
  };
})(typeof window !== 'undefined' ? window : this);
