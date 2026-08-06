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

  w.SokoniAnalytics = {
    VERSION: VERSION,
    /* Platform-wide aggregate (admin/finance dashboards; requires admin claims to read). */
    subscribeGlobal: function (cb) { return _subscribe('analytics/global', cb); },
    /* Per-shop aggregate (seller dashboard / POS; the shop owner reads their own). */
    subscribeShop: function (shopId, cb) { return _subscribe('shops/' + shopId + '/analytics/summary', cb); },
    shape: shape,
    fmtKES: fmtKES,
  };
})(window);
