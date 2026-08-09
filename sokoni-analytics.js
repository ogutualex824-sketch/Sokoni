/* ============================================================================
   sokoni-analytics.js — Canonical Analytics client (single source of truth)  v1.0.0

   Every dashboard (Admin, Seller, Finance, POS, Rider, Buyer, KASS) subscribes
   HERE instead of scanning thousands of orders and computing its own numbers.
   It reads the aggregate documents the Cloud Function `analytics-aggregator`
   maintains, so all dashboards show IDENTICAL figures within seconds of an event.

   Usage:
     const stop = SokoniAnalytics.subscribeGlobal(a => {
       cardRevenue.textContent = a.fmt.platformFee;   // canonical commission, never a local %
       cardGMV.textContent     = a.fmt.gmv;
       cardOrders.textContent  = a.paidOrders;
     });
     const stop2 = SokoniAnalytics.subscribeShop(shopId, a => { ... });
     // call stop()/stop2() to unsubscribe

   Real-time via onSnapshot, with a get-poll fallback when onSnapshot is blocked
   (iOS Safari App Check) — the same watchdog pattern as the rest of the platform.
============================================================================ */
(function (w) {
  'use strict';
  var VERSION = '1.0.0';

  function _db() {
    return (w.firebaseDB) || (w.firebase && w.firebase.firestore && w.firebase.firestore()) || null;
  }
  function fmtKES(sh) { return 'KES ' + Number(sh || 0).toLocaleString('en-KE'); }

  /* Shape a raw aggregate doc into presentation metrics so EVERY dashboard renders the same
     figures. platformFee == the canonical commission the settlement engine actually charged. */
  function shape(a) {
    a = a || {};
    var gmv        = Number(a.gmvSettledShillings || a.gmvShillings || 0);
    var revenue    = Number(a.platformRevenueShillings || 0);   // platform fee / commission (canonical)
    var sellerEarn = Number(a.sellerEarningsShillings || 0);
    var riderEarn  = Number(a.riderEarningsShillings || 0);
    var paid       = Number(a.paidOrders || 0);
    var settled    = Number(a.settledOrders || 0);
    return {
      paidOrders:               paid,
      settledOrders:            settled,
      deliveries:               Number(a.deliveries || 0),
      gmvShillings:             Number(a.gmvShillings || 0),
      gmvSettledShillings:      Number(a.gmvSettledShillings || 0),
      platformRevenueShillings: revenue,
      sellerEarningsShillings:  sellerEarn,
      riderEarningsShillings:   riderEarn,
      avgOrderValueShillings:   paid ? Math.round(Number(a.gmvShillings || 0) / paid) : 0,
      updatedAt:                a.updatedAt || null,
      fmt: {
        gmv:           fmtKES(gmv),
        platformFee:   fmtKES(revenue),
        sellerEarnings: fmtKES(sellerEarn),
        riderEarnings: fmtKES(riderEarn),
      },
      raw: a,
    };
  }

  function _subscribe(path, cb) {
    var db = _db();
    if (!db || typeof cb !== 'function') { console.warn('[SokoniAnalytics] not ready / bad callback'); return function () {}; }
    var ref = db.doc(path);
    var pollTimer = null, unsub = null, gotSnapshot = false, stopped = false;
    function emit(snap) { if (!stopped) cb(shape(snap && snap.exists ? snap.data() : {})); }
    function startPoll() {
      if (pollTimer || stopped) return;
      var tick = function () { ref.get().then(emit).catch(function () {}); };
      tick();
      pollTimer = setInterval(tick, 15000);
    }
    try {
      unsub = ref.onSnapshot(
        function (s) { gotSnapshot = true; emit(s); },
        function (err) { console.warn('[SokoniAnalytics] onSnapshot blocked → poll:', err && err.message); startPoll(); }
      );
    } catch (e) { startPoll(); }
    /* iOS App Check can stall onSnapshot silently — if nothing arrived in 8s, poll. */
    setTimeout(function () { if (!gotSnapshot) startPoll(); }, 8000);
    return function stop() {
      stopped = true;
      if (unsub) { try { unsub(); } catch (e) {} }
      if (pollTimer) clearInterval(pollTimer);
    };
  }

  /* ══════════════════════════════════════════════════════════════════════════
     EVENT INGESTION & LIVE CLIENT STATE (added — extends this module, does not
     replace the Firestore-aggregate subscribers above).

     Fixes the real synchronization gap: analytics must update when a TRANSACTION
     occurs, not when a screen happens to open. Canonical events (from POS/Seller/
     Marketplace via SokoniSync) are ingested here, deduped by (sellerUid+eventId)
     so a retry/reconnect/snapshot can never double-count, and drive a single shared
     client analytics state (via SokoniAnalyticsEngine.compute) that every merchant
     screen subscribes to. No screen queries its own version.
  ══════════════════════════════════════════════════════════════════════════ */
  var _state = null;                 /* last computed analytics snapshot (shared) */
  var _subs = [];                    /* subscribers to the shared state */
  var _seen = Object.create(null);   /* idempotency: 'sellerUid:eventId' → 1 */
  var _seenOrder = [];               /* bounded eviction queue */
  var _lastEvents = [];              /* recent events for the diagnostics trace */
  var _computeTimer = null;
  var _diag = { received: 0, processed: 0, failed: 0, duplicates: 0, queued: 0,
                lastEvent: null, lastEventTime: null, sources: {} };

  var _SYNC_TO_TYPE = {
    ProductChanged: 'PRODUCT_UPDATED', StockChanged: 'STOCK_DEDUCTED',
    AvailabilityChanged: 'AVAILABILITY_CHANGED', ShopChanged: 'SHOP_CHANGED',
    OrderChanged: 'ORDER_CREATED', PaymentChanged: 'PAYMENT_COMPLETED',
    RefundChanged: 'ORDER_REFUNDED', CustomerChanged: 'CUSTOMER_CHANGED'
  };
  function _uid () { try { return (w.firebaseAuth && w.firebaseAuth.currentUser && w.firebaseAuth.currentUser.uid) || null; } catch (_) { return null; } }
  function _now () { return Date.now(); }

  /* Normalise any inbound payload into the canonical analytics event contract. */
  function _normalize (typeOrName, p) {
    p = p || {};
    return {
      eventId:    p.eventId || null,
      type:       p.type || _SYNC_TO_TYPE[typeOrName] || typeOrName || 'EVENT',
      entityId:   p.entityId || p.id || p.orderId || p.productId || null,
      entityType: p.entityType || null,
      sellerUid:  p.sellerUid || _uid(),
      timestamp:  p.timestamp || p.ts || _now(),
      source:     p.source || String(typeOrName || '').replace('Changed', '') || 'client',
      channel:    p.channel || null,
      amount:     (p.amount != null) ? p.amount : ((p.total != null) ? p.total : null),
      currency:   p.currency || 'KES',
      items:      p.items || null,
      metadata:   p.metadata || null
    };
  }

  function _notify () { _subs.forEach(function (fn) { try { fn(_state, _diag); } catch (_) {} }); }
  function _recompute () {
    var E = w.SokoniAnalyticsEngine;
    if (!E || !E.compute) return;
    Promise.resolve(E.compute({ range: 'today' })).then(function (a) {
      _state = a; _diag.queued = 0; _notify();
    }).catch(function () { _diag.failed++; });
  }
  function _scheduleRecompute () {
    _diag.queued++;
    clearTimeout(_computeTimer);
    _computeTimer = setTimeout(_recompute, 400);   /* debounce event bursts into one recompute */
  }

  /* Ingest ONE canonical event. Idempotent on (sellerUid+eventId). Returns
     {duplicate:boolean}. Never throws. */
  function record (event) {
    try {
      event = _normalize(event && event.type, event);
      _diag.received++;
      var eid = event.eventId || (event.type + ':' + (event.entityId || '') + ':' + event.timestamp);
      var key = (event.sellerUid || 'unknown') + ':' + eid;
      if (_seen[key]) { _diag.duplicates++; return { duplicate: true }; }
      _seen[key] = 1; _seenOrder.push(key);
      if (_seenOrder.length > 5000) { delete _seen[_seenOrder.shift()]; }
      _diag.processed++;
      _diag.lastEvent = event.type;
      _diag.lastEventTime = event.timestamp;
      _diag.sources[event.source || 'client'] = 'ok';
      _lastEvents.unshift(event); if (_lastEvents.length > 25) _lastEvents.pop();
      _scheduleRecompute();
      return { duplicate: false };
    } catch (_) { _diag.failed++; return { duplicate: false, error: true }; }
  }

  /* Subscribe to the shared analytics state. fn(analytics, diagnostics). Fires
     immediately with the current snapshot if one exists. Returns unsubscribe. */
  function subscribe (fn) {
    if (typeof fn !== 'function') return function () {};
    _subs.push(fn);
    if (_state) { try { fn(_state, _diag); } catch (_) {} }
    return function () { _subs = _subs.filter(function (f) { return f !== fn; }); };
  }
  function getSnapshot () { return { analytics: _state, diagnostics: _diag, events: _lastEvents.slice(0, 25) }; }
  function diagnostics () { return _diag; }
  /* Force a recompute of the shared state now; returns the compute promise. */
  function computeNow (opts) {
    var E = w.SokoniAnalyticsEngine;
    if (!E || !E.compute) return Promise.resolve(null);
    return Promise.resolve(E.compute(opts || { range: 'today' })).then(function (a) { _state = a; _notify(); return a; });
  }

  /* Bridge: EVERY SokoniSync domain event becomes an ingested analytics event, so a
     transaction anywhere same-origin (POS/Seller iframes included) reaches analytics. */
  function _wireSync () {
    if (!w.SokoniSync || !w.SokoniSync.onAny) return false;
    w.SokoniSync.onAny(function (name, payload) { record(_normalize(name, payload)); });
    return true;
  }
  if (!_wireSync()) { try { w.addEventListener('sokoniSyncLoaded', _wireSync, { once: true }); } catch (_) {} }

  w.SokoniAnalytics = {
    VERSION: VERSION,
    /* Platform-wide aggregate (admin/finance dashboards; requires admin claims to read). */
    subscribeGlobal: function (cb) { return _subscribe('analytics/global', cb); },
    /* Per-shop aggregate (seller dashboard / POS; the shop owner reads their own). */
    subscribeShop: function (shopId, cb) { return _subscribe('shops/' + shopId + '/analytics/summary', cb); },
    shape: shape,
    fmtKES: fmtKES,
    /* ── Event-driven live client state (new) ── */
    record: record,
    track: function (type, data) { return record(_normalize(type, data || {})); },  /* was called but missing → now real */
    subscribe: subscribe,
    getSnapshot: getSnapshot,
    diagnostics: diagnostics,
    compute: computeNow
  };
})(window);
