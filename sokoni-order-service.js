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

  /* Coerce any timestamp shape to epoch millis. CRITICAL: a Firestore Timestamp read in the
     Seller iframe (real Timestamp with .toMillis()) is postMessage'd to the shell, where
     structured-clone strips the prototype — it arrives as a PLAIN {seconds, nanoseconds}
     object with no .toMillis(). Older code left that as an object, so `ts >= from` was
     `NaN` and EVERY marketplace order was silently dropped by the range filter (the 9→0 bug).
     Handles: number | numeric-string | ISO-string | Firestore Timestamp | plain
     {seconds,nanoseconds} | {_seconds,_nanoseconds} | Date. Returns null when unparseable so
     callers can apply their own fallback rather than inherit a wrong date. */
  function _toMs (v) {
    if (v == null) return null;
    if (typeof v === 'number') return isFinite(v) ? v : null;
    if (typeof v === 'object') {
      if (typeof v.toMillis === 'function') { try { return v.toMillis(); } catch (_) { return null; } }
      if (typeof v.getTime === 'function') { var g = v.getTime(); return isNaN(g) ? null : g; }
      var s = (v.seconds != null) ? v.seconds : v._seconds;          /* plain-cloned Timestamp */
      var n = (v.nanoseconds != null) ? v.nanoseconds : v._nanoseconds;
      if (s != null) return Number(s) * 1000 + Math.floor(Number(n || 0) / 1e6);
      return null;
    }
    if (typeof v === 'string') {
      if (/^\d+$/.test(v)) return Number(v);                          /* millis as string */
      var p = Date.parse(v); return isNaN(p) ? null : p;              /* ISO / date string */
    }
    return null;
  }

  function _fromPos (t) {
    var ts = _toMs(t.completedAt) || _toMs(t.timestamp) || _toMs(t.createdAt) || Date.now();
    var status = t.voided ? 'cancelled' : (t.refunded ? 'refunded' : 'completed');
    return {
      id:          'POS-' + (t.receiptNo || String(t.saleId || t.id || '').slice(-6)),
      /* Prefer saleId so a local IndexedDB txn dedups against its authoritative
         posRetailSales twin (same sale, two stores → one row). */
      canonicalId: String(t.saleId || t.id || t.receiptNo || ts),
      source:      'pos',
      branchId:    t.branchId || null,          /* branch isolation key (null = legacy, pre-migration) */
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

  /* Authoritative POS sale from the BACKEND (posRetailSales, written by posCompleteCheckout).
     This is the cross-device source of truth — the IndexedDB record is only a local cache. */
  function _fromRetailSale (s) {
    var ts = _toMs(s.createdAt);
    if (ts == null) ts = _toMs(s.saleDateMs) || _toMs(s.completedAt) || Date.now();
    var status = (s.status === 'refunded' || s.refunded) ? 'refunded' : ((s.status === 'voided' || s.status === 'cancelled') ? 'cancelled' : 'completed');
    return {
      id:          'POS-' + String(s.id || '').slice(-6),
      canonicalId: String(s.id || ts),               /* saleId — dedups against the local twin */
      source:      'pos',
      branchId:    s.branchId || null,
      channel:     'in_store',
      customer:    (s.customer && s.customer.name) || 'Walk-in Customer',
      phone:       (s.customer && s.customer.phone) || '',
      cashier:     s.cashierName || s.cashierId || '',
      items:       (s.items || []).map(function (i) { return { name: i.name || i.productName || 'Item', qty: i.qty || i.quantity || 1, price: (i.unitPrice != null ? i.unitPrice : (i.price || 0)) }; }),
      itemCount:   (s.items || []).length,
      subtotal:    _num(s.subtotal),
      discount:    _num(s.discountTotal),
      tax:         _num(s.taxTotal),
      deliveryFee: 0,
      total:       _num(s.grandTotal != null ? s.grandTotal : s.total),
      paymentMethod: (s.payments && s.payments[0] && (s.payments[0].method || s.payments[0].type)) || 'cash',
      paymentStatus: 'paid',
      status:      status,
      ts:          ts,
      events:      _timelinePos(s, status, ts),
      raw:         s,
    };
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
    /* _toMs handles the plain {seconds,nanoseconds} shape that a Firestore Timestamp becomes
       after postMessage (structured-clone drops .toMillis). Left un-coerced, ts stayed an
       object and `ts >= from` dropped the order — the 9→0 marketplace-sync bug. */
    var ts = _toMs(o.ts) || _toMs(o.createdAt) || _toMs(o.timestamp) || _toMs(o.createdAtMs) || _toMs(o.paidAt) || Date.now();
    var status = _mapOnlineStatus(o.status);
    return {
      id:          o.orderNo || o.orderId || o.id || ('SKN-' + String(o.id || '').slice(-6)),
      canonicalId: String(o.id || o.orderId || o.orderNo || ts),
      source:      'marketplace',
      branchId:    o.branchId || null,          /* branch isolation key (null = legacy, pre-migration) */
      channel:     _onlineChannel(o),
      customer:    o.customerName || o.buyerName || o.customer || 'Customer',
      phone:       o.customerPhone || o.phone || o.buyerPhone || '',
      rider:       o.riderName || o.rider || '',
      items:       (o.items || []).map(function (i) { return { name: i.name || i.productName || 'Item', qty: i.qty || i.quantity || 1, price: (i.price != null ? i.price : (i.unitPrice || 0)) }; }),
      itemCount:   (o.items || []).length,
      subtotal:    _num(o.subtotal != null ? o.subtotal : (o.orderTotal != null ? o.orderTotal - _num(o.deliveryFee) : (o.total || o.amount))),
      discount:    _num(o.discount),
      tax:         _num(o.tax),
      deliveryFee: _num(o.deliveryFee),
      /* Canonical marketplace total is orderTotal (falls back to total/amount). */
      total:       _num(o.orderTotal != null ? o.orderTotal : (o.total != null ? o.total : o.amount)),
      paymentMethod: (o.paymentMethod || 'mpesa'),
      /* Marketplace: a NOT_PAID status means unpaid; _apPaidCounted marks a settled/paid order. */
      paymentStatus: (o._apPaidCounted === true || o.paid ||
                      !/^(pending_payment|pending|awaiting_payment|cancelled|refunded|failed|expired)$/i.test(String(o.status || '')))
                     ? 'paid' : 'pending',
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
  /* Authoritative backend POS sales (posRetailSales where merchantId == seller). The shell
     wires this from the Seller module's authenticated query — the SAME pattern as the online
     provider, no second model. Makes POS sales visible to analytics on any device. */
  var _posProvider = null;
  function setPosProvider (fn) { _posProvider = (typeof fn === 'function') ? fn : null; }
  function hasPosProvider () { return !!_posProvider; }

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

    /* Authoritative backend POS sales (posRetailSales) — cross-device source of truth. */
    if (_posProvider) {
      try {
        var sales = await _posProvider();
        (sales || []).forEach(function (s) { try { out.push(_fromRetailSale(s)); } catch (_) {} });
      } catch (e) { /* provider failed — local POS + online this pass */ }
    }

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

    /* Branch isolation (v474): when an active branch is scoped, keep only that branch's
       records. Untagged legacy records (branchId null) are STILL shown until the backfill
       tags them, so no historical data is lost mid-migration — never silently dropped. */
    var rows = dedup;
    if (opts.branchId) rows = rows.filter(function (o) { return o.branchId == null || o.branchId === opts.branchId; });

    /* Range + tab + search */
    var from = _rangeFrom(opts.range || 'today');
    rows = rows.filter(function (o) { return o.ts >= from; });
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

  /* ── Forensic pipeline trace ── Runs the SAME ingestion as getAll but records every
     boundary count and, for each DROPPED record, why. Never hides a rejection: a source
     that "found 9" but delivers 0 to Analytics must show the 9 rejection reasons, not a
     bare 9→0. Used by the merchant Sync Diagnostics panel. Read-only. */
  async function diagnose (opts) {
    opts = opts || {};
    var rep = {
      range: opts.range || 'all', activeBranch: opts.branchId || null,
      pos:         { fetched: 0, accepted: 0, rejected: [] },   /* local IndexedDB POS */
      posBackend:  { fetched: 0, accepted: 0, rejected: [] },   /* posRetailSales */
      marketplace: { fetched: 0, accepted: 0, rejected: [] },
      boundaries:  { normalized: 0, deduped: 0, branchKept: 0, rangeKept: 0, tabKept: 0, unified: 0 },
    };
    var tagged = [];   /* {u: unifiedRow, bucket: rep-key, raw} */
    function norm (raw, bucket, mapper) {
      rep[bucket].fetched++;
      var u; try { u = mapper(raw); } catch (e) {
        rep[bucket].rejected.push({ id: raw && (raw.id || raw.orderId) || '?', reason: 'normalization-error: ' + (e && e.message || e) });
        return;
      }
      tagged.push({ u: u, bucket: bucket, raw: raw });
    }
    /* Local POS (only the completed/settled ones getAll would take). */
    try {
      var db = await _openPos();
      (await _getAll(db, 'transactions')).forEach(function (t) {
        if (t.status === 'completed' || t.refunded || t.voided || t.completedAt) norm(t, 'pos', _fromPos);
        else { rep.pos.fetched++; rep.pos.rejected.push({ id: t.id || t.saleId || '?', status: t.status, reason: 'not-settled (in-progress cart)' }); }
      });
    } catch (e) { /* no POS db on this device */ }
    if (_posProvider) { try { (await _posProvider() || []).forEach(function (s) { norm(s, 'posBackend', _fromRetailSale); }); } catch (e) {} }
    if (_onlineProvider) { try { (await _onlineProvider() || []).forEach(function (o) { norm(o, 'marketplace', _fromOnline); }); } catch (e) {} }
    rep.boundaries.normalized = tagged.length;

    /* Dedup (source+canonicalId). */
    var seen = {}, deduped = [];
    tagged.forEach(function (row) {
      var k = row.u.source + ':' + row.u.canonicalId;
      if (seen[k]) { rep[row.bucket].rejected.push({ id: row.u.id, reason: 'duplicate of ' + k }); return; }
      seen[k] = 1; deduped.push(row);
    });
    rep.boundaries.deduped = deduped.length;

    /* Branch isolation — null (legacy) is ALWAYS kept; only a DIFFERENT branch is dropped. */
    var afterBranch = deduped.filter(function (row) {
      if (!opts.branchId) return true;
      if (row.u.branchId == null || row.u.branchId === opts.branchId) return true;
      rep[row.bucket].rejected.push({ id: row.u.id, branchId: row.u.branchId, status: row.u.status,
        reason: 'branch-mismatch (order branch ' + row.u.branchId + ' ≠ active ' + opts.branchId + ') — needsReview, not deleted' });
      return false;
    });
    rep.boundaries.branchKept = afterBranch.length;

    /* Range. */
    var from = _rangeFrom(opts.range || 'all');
    var afterRange = afterBranch.filter(function (row) {
      if (row.u.ts >= from) return true;
      rep[row.bucket].rejected.push({ id: row.u.id, ts: row.u.ts, reason: (row.u.ts == null || isNaN(row.u.ts)) ? 'unparseable-timestamp (would be dropped by range filter)' : 'outside-range' });
      return false;
    });
    rep.boundaries.rangeKept = afterRange.length;

    /* Tab. */
    var afterTab = afterRange.filter(function (row) { return !(opts.tab && opts.tab !== 'all') || _matchTab(row.u, opts.tab); });
    rep.boundaries.tabKept = afterTab.length;
    rep.boundaries.unified = afterTab.length;

    /* Per-source accepted = survived to unified. */
    afterTab.forEach(function (row) { rep[row.bucket].accepted++; });
    rep.summary = summarize(afterTab.map(function (r) { return r.u; }));
    return rep;
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
    diagnose: diagnose,     /* forensic boundary trace: per-source found→accepted + reasons */
    summarize: summarize,
    setOnlineProvider: setOnlineProvider,
    hasOnlineProvider: function () { return !!_onlineProvider; },
    setPosProvider: setPosProvider,
    hasPosProvider: hasPosProvider,
    EVENT_LABELS: {
      ORDER_CREATED: 'Order placed', PAYMENT_AUTHORIZED: 'Payment received', ORDER_ACCEPTED: 'Accepted',
      ORDER_PREPARING: 'Preparing', ORDER_READY: 'Ready', RIDER_ASSIGNED: 'Rider assigned',
      PICKED_UP: 'Picked up', DELIVERED: 'Delivered', COMPLETED: 'Completed',
      REFUND_REQUESTED: 'Refund requested', REFUNDED: 'Refunded', CANCELLED: 'Cancelled', RETURNED: 'Returned',
    },
  };
})(typeof window !== 'undefined' ? window : this);
