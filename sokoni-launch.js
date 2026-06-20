/* ================================================================
   SOKONI LAUNCH TRACKER  v1.0
   Operational monitoring: metrics, failures, conversions.
   Firestore: launch_metrics, launch_failures, support_tickets
================================================================ */
(function (global) {
  'use strict';

  var LS_QUEUE = '_sokoniLaunchQueue';

  function _uid() {
    try { var u=JSON.parse(localStorage.getItem('sokoniUser')||'{}'); return u.uid||u.id||'anon'; } catch { return 'anon'; }
  }

  function _meta(extra) {
    return Object.assign({ uid:_uid(), ts:Date.now(), page:location.pathname }, extra||{});
  }

  function _save(col, data) {
    var entry = Object.assign({ _col:col }, data);
    if (window.SokoniDB && SokoniDB.saveApplication) {
      try { SokoniDB.saveApplication(Object.assign({}, entry, {category:col})); return; } catch {}
    }
    try {
      var q = JSON.parse(localStorage.getItem(LS_QUEUE)||'[]');
      q.push(entry); if (q.length>500) q.splice(0,q.length-500);
      localStorage.setItem(LS_QUEUE, JSON.stringify(q));
    } catch {}
  }

  function _flush() {
    if (!window.SokoniDB || !SokoniDB.saveApplication) return;
    try {
      var q = JSON.parse(localStorage.getItem(LS_QUEUE)||'[]');
      if (!q.length) return;
      q.forEach(function(e){ try { SokoniDB.saveApplication(Object.assign({},e,{category:e._col||'launch_metrics'})); } catch {} });
      localStorage.removeItem(LS_QUEUE);
    } catch {}
  }

  /* ── Local counter store ── */
  var METRICS_KEY = '_sokoniLaunchMetrics';
  function _getMetrics() { try { return JSON.parse(localStorage.getItem(METRICS_KEY)||'{}'); } catch { return {}; } }
  function _bumpMetric(type) {
    var m = _getMetrics(); m[type] = (m[type]||0)+1;
    m['last_'+type] = Date.now();
    try { localStorage.setItem(METRICS_KEY, JSON.stringify(m)); } catch {}
    return m[type];
  }

  var SokoniLaunch = {

    /* ── METRIC TRACKING ── */
    trackMetric: function(type, data) {
      var count = _bumpMetric(type);
      _save('launch_metrics', _meta(Object.assign({ type:type, count:count }, data||{})));
    },

    /* Convenience wrappers */
    newUser     : function(d){ SokoniLaunch.trackMetric('new_user', d); },
    newSeller   : function(d){ SokoniLaunch.trackMetric('new_seller', d); },
    newDriver   : function(d){ SokoniLaunch.trackMetric('new_driver', d); },
    newProvider : function(d){ SokoniLaunch.trackMetric('new_provider', d); },
    orderPlaced : function(d){ SokoniLaunch.trackMetric('order', d); },
    orderPaid   : function(d){ SokoniLaunch.trackMetric('order_paid', d); },
    rideBooked  : function(d){ SokoniLaunch.trackMetric('ride', d); },
    rideComplete: function(d){ SokoniLaunch.trackMetric('ride_complete', d); },
    deliveryDone: function(d){ SokoniLaunch.trackMetric('delivery_complete', d); },
    revenueEarned: function(amount, d){ SokoniLaunch.trackMetric('revenue', Object.assign({amount:amount}, d||{})); },
    commissionEarned: function(amount, d){ SokoniLaunch.trackMetric('commission', Object.assign({amount:amount}, d||{})); },

    /* ── FAILURE LOGGING ── */
    logFailedPayment: function(data) {
      _save('launch_failures', _meta(Object.assign({ type:'payment', severity:'high' }, data||{})));
    },
    logFailedOrder: function(data) {
      _save('launch_failures', _meta(Object.assign({ type:'order', severity:'medium' }, data||{})));
    },
    logFailedDelivery: function(data) {
      _save('launch_failures', _meta(Object.assign({ type:'delivery', severity:'medium' }, data||{})));
    },
    logFailedRide: function(data) {
      _save('launch_failures', _meta(Object.assign({ type:'ride', severity:'medium' }, data||{})));
    },

    /* ── SUPPORT TICKETS ── */
    submitTicket: function(data) {
      var id = 'TKT' + Date.now().toString(36).toUpperCase();
      var ticket = _meta(Object.assign({ id:id, status:'open', priority:'medium' }, data||{}));
      _save('support_tickets', ticket);
      try { localStorage.setItem('_sokoniLastTicket', JSON.stringify({ id:id, ts:Date.now() })); } catch {}
      return id;
    },

    /* ── LOCAL METRICS READ ── */
    getLocalMetrics: function() { return _getMetrics(); },

    /* Conversion rate: orders ÷ signups */
    getConversionRate: function() {
      var m = _getMetrics();
      var users = m.new_user || 0;
      var orders = m.order || 0;
      return users ? ((orders/users)*100).toFixed(1)+'%' : '—';
    },

    flushQueue: _flush,
  };

  window.addEventListener('load', function() { setTimeout(_flush, 4000); });
  global.SokoniLaunch = SokoniLaunch;

})(window);
