/* ============================================================================
   SOKONI — install / build reporter (client side of the install counter)
   sokoni-install-report.js   ·   injected by sw-register.js (_mods)

   Tells the server — through the App-Check-enforced callable appInstallReport
   (functions/app-release-metrics.js) — two things, and nothing else:
     · install  when the browser fires `appinstalled`
     · checkin  at most once per Nairobi day: the build this page's service
                worker runs (its CACHE_VERSION, asked via GET_VERSION) and
                whether the app is running standalone
   Payload: { installId, event, cacheVersion, standalone, platform } — platform
   is an enum derived here; the user-agent string itself is never sent. No uid,
   no account, no location.

   CONSENT — fail closed. The consent authority is window.SokoniConsent
   (security.js). This subscribes with onChange, which reports the current
   state immediately and every later change, so a withdrawal stops the reporter
   at once. A page without SokoniConsent never reports. The flag is re-checked
   immediately before every send, so a deny between scheduling and sending wins.
   Known limits (privacy programme, not this file): the decision is stored
   client-side only, and the banner is a single accept/reject with no separate
   analytics category yet.

   The installId and the "last check-in day" live in localStorage as a
   per-device convenience — never a source of truth. The server's day key is
   what bounds writes. Clearing site data mints a new installId (a new device
   to the counter); that is a documented limit, not something to paper over.

   Never blocks page load, never throws, and does nothing when the callable is
   absent, the device is offline, or no service worker controls the page.
   ========================================================================= */
(function () {
  'use strict';
  try {
    if (window.__sokoniInstallReport) return;
    window.__sokoniInstallReport = true;
    /* The top-level document reports; a page framed inside a shell does not,
       so one device is never counted twice by one visit. */
    if (window.top !== window.self) return;
  } catch (_) { return; }

  var ID_KEY = 'sokoniInstallId';
  var DAY_KEY = 'sokoniInstallCheckinDay';
  var CALLABLE = 'appInstallReport';
  var FN_SDK = 'https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js';
  var CACHE_RE = /^sokoni-\d{14}-v\d+$/;

  var _enabled = false;          /* set ONLY by SokoniConsent.onChange */
  var _sending = false;

  function lsGet(k) { try { return localStorage.getItem(k); } catch (_) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (_) { /* private mode: fine */ } }

  function nairobiDay() { return new Date(Date.now() + 3 * 3600000).toISOString().slice(0, 10); }

  function uuidV4() {
    try { if (window.crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID(); } catch (_) {}
    try {
      var b = new Uint8Array(16);
      crypto.getRandomValues(b);
      b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
      var hx = Array.prototype.map.call(b, function (x) { return (x + 0x100).toString(16).slice(1); }).join('');
      return hx.slice(0, 8) + '-' + hx.slice(8, 12) + '-' + hx.slice(12, 16) + '-' + hx.slice(16, 20) + '-' + hx.slice(20);
    } catch (_) { return null; }   /* no CSPRNG: do not report rather than send a guessable id */
  }

  function installId() {
    var id = lsGet(ID_KEY);
    if (id && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)) return id;
    id = uuidV4();
    if (id) lsSet(ID_KEY, id);
    return id;
  }

  function standalone() {
    try { return !!((window.matchMedia && matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true); }
    catch (_) { return false; }
  }

  /* An enum, not the user-agent string. */
  function platform() {
    try {
      var p = String((navigator.userAgentData && navigator.userAgentData.platform) || '').toLowerCase();
      var ua = String(navigator.userAgent || '');
      if (/android/i.test(p) || /Android/.test(ua)) return 'android';
      if (/iP(hone|ad|od)/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'ios';
      if (/chrome ?os|cros/i.test(p) || /CrOS/.test(ua)) return 'chromeos';
      if (/win/i.test(p) || /Windows/.test(ua)) return 'windows';
      if (/mac/i.test(p) || /Macintosh/.test(ua)) return 'macos';
      if (/linux/i.test(p) || /Linux/.test(ua)) return 'linux';
    } catch (_) {}
    return 'other';
  }

  /* The build this page's controlling worker runs — asked, not guessed. */
  function swVersion() {
    return new Promise(function (resolve) {
      try {
        var c = navigator.serviceWorker && navigator.serviceWorker.controller;
        if (!c || typeof MessageChannel === 'undefined') return resolve(null);
        var ch = new MessageChannel(), done = false;
        var t = setTimeout(function () { if (!done) { done = true; resolve(null); } }, 3000);
        ch.port1.onmessage = function (e) {
          if (done) return; done = true; clearTimeout(t);
          var v = e && e.data && e.data.version;
          resolve(typeof v === 'string' && CACHE_RE.test(v) ? v : null);
        };
        c.postMessage({ type: 'GET_VERSION' }, [ch.port2]);
      } catch (_) { resolve(null); }
    });
  }

  /* The canonical Firebase app with App Check: firebase.js's modular app
     (window.firebaseApp — the same path sokoni-async.js and
     sokoni-crash-sentinel.js use for logClientDiagnostic), else the compat
     default app (App Check activated by sokoni-appcheck.js). Neither -> null. */
  function transport() {
    try {
      if (window.firebaseApp) {
        return function (data) {
          return import(FN_SDK).then(function (m) {
            return m.httpsCallable(m.getFunctions(window.firebaseApp, 'us-central1'), CALLABLE)(data);
          });
        };
      }
      var fb = window.firebase;
      if (fb && fb.apps && fb.apps.length && typeof fb.functions === 'function') {
        return function (data) { return fb.functions().httpsCallable(CALLABLE)(data); };
      }
    } catch (_) {}
    return null;
  }

  function send(event) {
    if (!_enabled || (event === 'checkin' && _sending)) return Promise.resolve(false);
    if (navigator.onLine === false) return Promise.resolve(false);
    var call = transport();
    if (!call) return Promise.resolve(false);
    var id = installId();
    if (!id) return Promise.resolve(false);
    if (event === 'checkin') _sending = true;
    return swVersion().then(function (cv) {
      if (!cv) return false;                 /* no controller / no answer: nothing true to report */
      if (!_enabled) return false;           /* consent withdrawn while we waited: the deny wins */
      if (event === 'checkin') lsSet(DAY_KEY, nairobiDay());   /* one attempt per day, success or not */
      return Promise.resolve(call({ installId: id, event: event, cacheVersion: cv, standalone: standalone(), platform: platform() }))
        .then(function () { return true; }, function () { return false; });
    }).catch(function () { return false; })
      .then(function (r) { if (event === 'checkin') _sending = false; return r; });
  }

  function _maybeReport() {
    if (!_enabled) return;
    if (lsGet(DAY_KEY) === nairobiDay()) return;
    var go = function () { if (_enabled) send('checkin'); };
    if (typeof window.requestIdleCallback === 'function') requestIdleCallback(go, { timeout: 8000 });
    else setTimeout(go, 2000);
  }

  function start() {
    /* FAIL CLOSED: no consent authority on this page -> never report. */
    var C = window.SokoniConsent;
    if (!C || typeof C.onChange !== 'function') return;
    C.onChange(function (g) { _enabled = !!g; if (g) _maybeReport(); });
    window.addEventListener('appinstalled', function () {
      /* A worker may not control the page yet at the moment of install; ask shortly after. */
      setTimeout(function () { if (_enabled) send('install'); }, 1500);
    });
    /* The modular app may finish initialising after this runs; one late retry. */
    if (!transport()) {
      var late = function () { setTimeout(_maybeReport, 4000); };
      if (document.readyState === 'complete') late();
      else window.addEventListener('load', late, { once: true });
    }
  }

  try { start(); } catch (_) { /* never break the page */ }

  /* test seam (inert in production) */
  window.__sokoniInstallReportInternals = { platform: platform, nairobiDay: nairobiDay, installId: installId, isEnabled: function () { return _enabled; } };
})();
