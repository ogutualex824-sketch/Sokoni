/* ═══════════════════════════════════════════════════════════════════════════
   SOKONI Admin API — the ONE authenticated data-access layer for the Admin
   Command Center.

   PLATFORM RULE: no admin page reads Firestore directly. Every module calls
   AdminAPI, which routes through the deployed `adminOsDispatch` callable →
   Cloud Function → Firestore. This eliminates the whole class of failure that
   made panes read empty: stale tokens, App Check timing, permission-denied on
   direct reads, and inconsistent auth. (See docs/ADMIN_OS_PHASE1_RECONCILIATION.)

        Admin UI → AdminAPI.<module>() → adminOsDispatch → Cloud Function → Firestore

   Provides: one lazily-initialised callable, admin-app readiness wait, per-op
   diagnostics (latency / rows / last-updated / status / source), and a uniform
   loading → success → error lifecycle with enterprise error states + retry.
   ═══════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  var VERSION = '1.0.0';
  var ACCENT = '#7CFF00';
  var _dispatchPromise = null;
  var _diag = {};        // op -> { latencyMs, rows, at, status, source, error }
  var _lastLoad = {};    // op -> opts (for retry)

  /* Lazily build a single adminOsDispatch caller. Waits for the AUTHENTICATED
     firebase app so the ID token (with the admin claim) is attached — the exact
     readiness the old direct reads skipped. */
  async function _dispatcher() {
    if (!_dispatchPromise) {
      _dispatchPromise = (async function () {
        var m = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js');
        var tries = 0;
        while (!window.firebaseApp && tries++ < 60) await new Promise(function (r) { setTimeout(r, 100); });
        if (!window.firebaseApp) throw new Error('Firebase app not ready (auth still resolving)');
        var fns = m.getFunctions(window.firebaseApp, 'us-central1');
        return function (op, data) {
          var payload = Object.assign({ op: op }, data || {});
          return m.httpsCallable(fns, 'adminOsDispatch')(payload);
        };
      })().catch(function (e) { _dispatchPromise = null; throw e; });
    }
    return _dispatchPromise;
  }

  /* Core call — every module read funnels through here. Records diagnostics. */
  async function call(op, data) {
    var t0 = Date.now();
    var run = await _dispatcher();
    try {
      var res = await run(op, data);
      var payload = res && res.data;
      var rows = payload && (payload.count != null ? payload.count
        : (Array.isArray(payload.items) ? payload.items.length : null));
      _diag[op] = { latencyMs: Date.now() - t0, rows: rows, at: Date.now(), status: 'healthy', source: (payload && payload.source) || op };
      return payload;
    } catch (e) {
      _diag[op] = { latencyMs: Date.now() - t0, rows: null, at: Date.now(), status: 'error', error: (e && e.message) || 'error' };
      throw e;
    }
  }

  /* Lifecycle helper: skeleton → call → render(payload) | enterprise error+retry.
     opts: { data, target(id|el), render(payload,target), onError(e), skeleton, skeletonRows } */
  async function load(op, opts) {
    opts = opts || {};
    _lastLoad[op] = opts;
    var target = opts.target && (typeof opts.target === 'string' ? document.getElementById(opts.target) : opts.target);
    if (target && opts.skeleton !== false) target.innerHTML = _skeleton(opts.skeletonRows || 6);
    try {
      var payload = await call(op, opts.data);
      if (opts.render) opts.render(payload, target);
      return payload;
    } catch (e) {
      if (target) target.innerHTML = _errorState(op, _humanError(e));
      if (opts.onError) opts.onError(e);
      return null;
    }
  }

  function _retry(op) { var o = _lastLoad[op]; if (o) load(op, o); }

  /* Raw Firebase errors → enterprise language (never surface "permission-denied"). */
  function _humanError(e) {
    var msg = (e && e.message) || '';
    var code = (e && e.code) || '';
    if (/permission-denied|unauthenticated/i.test(msg + code)) return 'Your admin session is still authenticating. Retry in a moment.';
    if (/unavailable|deadline|network/i.test(msg + code)) return 'Network hiccup reaching the server. Retry.';
    if (/app.?check/i.test(msg + code)) return 'Security check pending. Refresh the session and retry.';
    return 'Unable to load this data right now.';
  }

  function _skeleton(n) {
    var rows = '';
    for (var i = 0; i < n; i++) rows += '<div class="aapi-skel-row"></div>';
    return '<div class="aapi-skel">' + rows + '</div>';
  }
  function _errorState(op, msg) {
    return '<div class="aapi-error">' +
      '<div class="aapi-error-icon">⚠️</div>' +
      '<div class="aapi-error-msg">' + String(msg).replace(/</g, '&lt;') + '</div>' +
      '<button class="aapi-error-btn" onclick="AdminAPI._retry(\'' + op + '\')">Retry</button>' +
      '</div>';
  }

  /* Diagnostics chip HTML for a module footer: Source / Rows / Updated / API / Latency / Status. */
  function diagnosticsHtml(op) {
    var d = _diag[op]; if (!d) return '';
    var ago = Math.max(0, Math.round((Date.now() - d.at) / 1000));
    var dot = d.status === 'healthy' ? ACCENT : '#ff5c5c';
    return '<div class="aapi-diag">' +
      '<span>Source: <b>' + (d.source || op) + '</b></span>' +
      '<span>Rows: <b>' + (d.rows == null ? '—' : d.rows) + '</b></span>' +
      '<span>Updated: <b>' + ago + 's ago</b></span>' +
      '<span>API: <b>' + op + '</b></span>' +
      '<span>Latency: <b>' + d.latencyMs + ' ms</b></span>' +
      '<span>Status: <b style="color:' + dot + ';">' + (d.status === 'healthy' ? 'Healthy' : 'Error') + '</b></span>' +
      '</div>';
  }

  /* Inject the AdminAPI skeleton/error/diag CSS once. */
  function _injectCss() {
    if (document.getElementById('aapi-css')) return;
    var s = document.createElement('style'); s.id = 'aapi-css';
    s.textContent =
      '.aapi-skel{display:flex;flex-direction:column;gap:10px;padding:8px 0}' +
      '.aapi-skel-row{height:44px;border-radius:12px;background:linear-gradient(90deg,rgba(255,255,255,.04) 25%,rgba(255,255,255,.09) 37%,rgba(255,255,255,.04) 63%);background-size:400% 100%;animation:aapiShimmer 1.4s ease infinite}' +
      '@keyframes aapiShimmer{0%{background-position:100% 0}100%{background-position:-100% 0}}' +
      '.aapi-error{display:flex;flex-direction:column;align-items:center;gap:10px;padding:32px 16px;text-align:center;color:rgba(255,255,255,.6)}' +
      '.aapi-error-icon{font-size:26px}.aapi-error-msg{font-size:13px;max-width:320px}' +
      '.aapi-error-btn{margin-top:4px;padding:8px 18px;border-radius:10px;border:1px solid ' + ACCENT + '55;background:' + ACCENT + '18;color:' + ACCENT + ';font-weight:700;font-size:12px;cursor:pointer;font-family:inherit}' +
      '.aapi-error-btn:hover{background:' + ACCENT + '28}' +
      '.aapi-diag{display:flex;flex-wrap:wrap;gap:14px;padding:8px 12px;margin-top:10px;font-size:10px;color:rgba(255,255,255,.38);border-top:1px solid rgba(255,255,255,.06)}' +
      '.aapi-diag b{color:rgba(255,255,255,.62);font-weight:700}';
    document.head.appendChild(s);
  }
  if (document.readyState !== 'loading') _injectCss();
  else document.addEventListener('DOMContentLoaded', _injectCss);

  /* Named module methods — every sidebar module calls exactly one of these. */
  var api = {
    version: VERSION,
    call: call, load: load, _retry: _retry,
    diagnostics: function (op) { return op ? _diag[op] : _diag; },
    diagnosticsHtml: diagnosticsHtml,
    overview:       function (d) { return call('adminGetOverview', d); },
    users:          function (d) { return call('adminGetUsers', d); },
    providers:      function (d) { return call('adminGetProviders', d); },
    services:       function (d) { return call('adminGetServices', d); },
    products:       function (d) { return call('adminGetProducts', d); },
    orders:         function (d) { return call('adminGetOrders', d); },
    bookings:       function (d) { return call('adminGetBookings', d); },
    payments:       function (d) { return call('adminGetPayments', d); },
    finance:        function (d) { return call('adminGetFinance', d); },
    wallets:        function (d) { return call('adminGetWallets', d); },
    payoutRequests: function (d) { return call('adminGetPayoutRequests', d); },
    analytics:      function (d) { return call('adminGetAnalytics', d); },
    reports:        function (d) { return call('adminGetReports', d); },
    disputes:       function (d) { return call('adminGetDisputes', d); },
    reviews:        function (d) { return call('adminGetReviews', d); },
    notifications:  function (d) { return call('adminGetNotifications', d); },
    supportTickets: function (d) { return call('adminGetSupportTickets', d); }
  };
  window.AdminAPI = api;
})();
