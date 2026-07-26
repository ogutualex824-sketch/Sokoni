/* ══════════════════════════════════════════════════════════════════════════
   SOKONI — Crash Sentinel  (Android "Aw, Snap!" / reload-loop diagnostics)

   ADD AS THE FIRST <script> IN <head>, before every other script:
       <script src="sokoni-crash-sentinel.js"></script>

   WHY THIS EXISTS
   Reported 2026-07-26: on Android (Chrome browser), most accounts fail to open —
   the tab shows Chrome's "Aw, Snap!" page (whose button reads *Reload*, hence the
   user's "reload snap"). "Aw, Snap!" is a RENDERER CRASH, on budget Android almost
   always out-of-memory. You cannot report a crash from the tab that died — the
   renderer is gone and the console with it. So this leaves a breadcrumb in
   localStorage (synchronous, survives the process dying) on every heartbeat, marks
   it clean only on an orderly exit, and on the NEXT load detects that the previous
   run ended abnormally and records WHY — heap size at death, device memory, the
   last script that finished loading, any JS error, App Check state, and whether the
   page is in a rapid reload loop.

   IT MEASURES, IT DOES NOT ASSUME. A high heap near the last breadcrumb points at
   OOM; a recorded lastError points at a JS crash; reloadLoop points at a redirect/
   auth loop; appCheck:'rejected' ties the crash to the intermittent 403 that blocks
   Firebase Auth. The data decides, not this file.

   TWO SINKS, NEITHER CAN FAIL SILENTLY
     1. localStorage ring buffer — 100% reliable, readable off the real phone at
        /android-doctor (no backend, no auth, no App Check needed).
     2. Best-effort beacon to logClientDiagnostic (surface 'auth-android-crash', the
        deployed anonymous auth-surface path — so NO functions deploy). Fires only
        when Firebase modular is present and only for a detected abnormal exit.

   AFTER A CRASH, on the phone: open /android-doctor  — or in a console: sokoniCrashReport()
   ══════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var LIVE    = 'sk_sentinel_live';      /* current run, overwritten each heartbeat */
  var CRASHES = 'sk_sentinel_crashes';   /* ring buffer of detected abnormal exits   */
  var LOADS   = 'sk_sentinel_loads';     /* per-path load timestamps (loop detection) */
  var MAX_CRASHES = 12;
  var HEARTBEAT_MS = 2000;
  var LOOP_WINDOW_MS = 60000;
  var LOOP_THRESHOLD = 4;                /* >=4 loads of same path within the window  */
  var SENTINEL_VERSION = 'sentinel-1.0';

  var t0 = Date.now();
  var path = location.pathname;

  function readJSON(k, fallback) {
    try { var raw = localStorage.getItem(k); return raw ? JSON.parse(raw) : fallback; }
    catch (_) { return fallback; }
  }
  function writeJSON(k, v) {
    try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (_) { return false; }
  }

  /* ── device fingerprint (captured once) ─────────────────────────────────── */
  function device() {
    var c = navigator.connection || {};
    return {
      ua: (navigator.userAgent || '').slice(0, 240),
      deviceMemoryGB: (typeof navigator.deviceMemory === 'number') ? navigator.deviceMemory : null,
      cores: navigator.hardwareConcurrency || null,
      net: c.effectiveType || null,
      saveData: !!c.saveData,
      dpr: window.devicePixelRatio || 1,
      screen: (screen.width || 0) + 'x' + (screen.height || 0),
      viewport: (innerWidth || 0) + 'x' + (innerHeight || 0),
      lang: navigator.language || null,
      online: navigator.onLine
    };
  }
  var DEV = device();

  /* ── live snapshot of what the renderer is doing right now ───────────────── */
  function heapMB() {
    var m = (window.performance && performance.memory) || null;
    if (!m) return null;
    return {
      usedMB:  Math.round(m.usedJSHeapSize  / 1048576),
      totalMB: Math.round(m.totalJSHeapSize / 1048576),
      limitMB: Math.round(m.jsHeapSizeLimit / 1048576)
    };
  }
  function lastScript() {
    try {
      var e = performance.getEntriesByType('resource');
      var last = null;
      for (var i = 0; i < e.length; i++) {
        if (e[i].initiatorType === 'script' && (!last || e[i].responseEnd > last.responseEnd)) last = e[i];
      }
      if (!last) return null;
      return { name: (last.name || '').split('/').pop().split('?')[0].slice(0, 60), atMs: Math.round(last.responseEnd) };
    } catch (_) { return null; }
  }
  function domNodes() { try { return document.getElementsByTagName('*').length; } catch (_) { return null; } }

  var lastError = null;
  window.addEventListener('error', function (e) {
    lastError = { kind: 'error', msg: (e && e.message ? String(e.message) : 'error').slice(0, 200),
                  src: (e && e.filename ? String(e.filename).split('/').pop() : null), at: Date.now() - t0 };
    beat();  /* persist immediately — the very next tick may be the crash */
  }, true);
  window.addEventListener('unhandledrejection', function (e) {
    var r = e && e.reason;
    lastError = { kind: 'promise', msg: String((r && (r.message || r)) || 'rejection').slice(0, 200), at: Date.now() - t0 };
    beat();
  });

  /* ── the breadcrumb, rewritten every heartbeat ───────────────────────────── */
  function snapshot() {
    return {
      v: SENTINEL_VERSION,
      path: path,
      url: (location.href || '').slice(0, 240),
      startedAt: t0,
      ageMs: Date.now() - t0,
      clean: false,
      dev: DEV,
      heap: heapMB(),
      dom: domNodes(),
      lastScript: lastScript(),
      appCheck: window.__sokoniAppCheckState || null,   /* set by firebase.js: pending|exchanged|rejected|disabled */
      lastError: lastError,
      visibility: document.visibilityState,
      reloadCount: reloadCount
    };
  }
  function beat() { writeJSON(LIVE, snapshot()); }

  /* ── reload-loop detection ───────────────────────────────────────────────── */
  var loads = readJSON(LOADS, {});
  if (!loads || typeof loads !== 'object') loads = {};
  var arr = Array.isArray(loads[path]) ? loads[path] : [];
  arr.push(t0);
  while (arr.length > 8) arr.shift();
  loads[path] = arr;
  writeJSON(LOADS, loads);
  var recent = arr.filter(function (ts) { return t0 - ts < LOOP_WINDOW_MS; });
  var reloadCount = recent.length;
  var reloadLoop = reloadCount >= LOOP_THRESHOLD;

  /* ── detect an abnormal PREVIOUS exit BEFORE we overwrite it ──────────────── */
  var prior = readJSON(LIVE, null);
  var abnormal = prior && prior.clean !== true && typeof prior.startedAt === 'number' && prior.startedAt !== t0;

  if (abnormal) {
    /* Classify from evidence only — never assert a cause we didn't measure. */
    var signals = [];
    var h = prior.heap;
    if (h && h.limitMB && h.usedMB && h.usedMB >= h.limitMB * 0.85) signals.push('heap-near-limit');
    if (h && h.limitMB && h.limitMB <= 600) signals.push('low-heap-ceiling');
    if (prior.dev && prior.dev.deviceMemoryGB != null && prior.dev.deviceMemoryGB <= 2) signals.push('low-device-memory');
    if (prior.lastError) signals.push('js-' + prior.lastError.kind);
    if (prior.appCheck === 'rejected') signals.push('appcheck-rejected');
    if (reloadLoop) signals.push('reload-loop');
    if (prior.ageMs != null && prior.ageMs < 4000) signals.push('died-during-load');

    var report = {
      reason: 'abnormal_exit',
      detectedAt: new Date().toISOString(),
      signals: signals,
      prior: prior,
      reloadCountNow: reloadCount
    };
    var crashes = readJSON(CRASHES, []);
    if (!Array.isArray(crashes)) crashes = [];
    crashes.push(report);
    while (crashes.length > MAX_CRASHES) crashes.shift();
    writeJSON(CRASHES, crashes);

    /* Best-effort fleet beacon — deferred so it never competes with the fresh
       load it is reporting from, and guarded so a beacon failure is invisible. */
    setTimeout(function () { try { beacon(report); } catch (_) {} }, 3000);
  }

  /* start THIS run's breadcrumb immediately (captures a crash during early load) */
  beat();

  /* heartbeat + event-driven persistence */
  var hb = setInterval(beat, HEARTBEAT_MS);
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') markClean(); else beat();
  });

  /* An orderly exit (navigation, tab close, bfcache freeze) fires one of these.
     An OOM renderer crash fires NONE of them — so the breadcrumb stays unclean and
     is caught on the next load. That asymmetry is the whole mechanism. */
  function markClean() {
    clearInterval(hb);
    var s = snapshot(); s.clean = true; writeJSON(LIVE, s);
  }
  window.addEventListener('pagehide', markClean);
  window.addEventListener('beforeunload', markClean);

  /* ── best-effort beacon → logClientDiagnostic (anonymous auth-surface path) ── */
  function beacon(report) {
    if (!window.firebaseApp) return;   /* no modular app on this page — localStorage still has it */
    var p = report.prior || {};
    import('https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js')
      .then(function (m) {
        var fn = m.httpsCallable(m.getFunctions(window.firebaseApp, 'us-central1'), 'logClientDiagnostic');
        return fn({
          severity: 'critical',
          code: 'android-crash',
          message: 'abnormal exit [' + report.signals.join(',') + ']',
          surface: 'auth-android-crash',        /* accepted anonymously by the CF */
          appVersion: SENTINEL_VERSION,
          userAgent: (p.dev && p.dev.ua) || navigator.userAgent,
          viewport: (p.dev && p.dev.viewport) || (innerWidth + 'x' + innerHeight),
          online: navigator.onLine,
          url: p.url || location.pathname,
          context: {
            signals: report.signals,
            heap: p.heap, deviceMemoryGB: p.dev && p.dev.deviceMemoryGB, cores: p.dev && p.dev.cores,
            net: p.dev && p.dev.net, dom: p.dom, lastScript: p.lastScript, ageMs: p.ageMs,
            appCheck: p.appCheck, lastError: p.lastError, reloadCount: report.reloadCountNow, path: p.path
          }
        });
      }).catch(function () {});
  }

  /* ── console helper for on-device inspection ─────────────────────────────── */
  window.sokoniCrashReport = function () {
    var crashes = readJSON(CRASHES, []);
    if (!crashes.length) { console.log('%c[SOKONI Sentinel] No abnormal exits recorded on this device. 👍', 'color:#71ff00;font-weight:bold'); return crashes; }
    console.log('%c[SOKONI Sentinel] ' + crashes.length + ' abnormal exit(s) recorded:', 'color:#ff5252;font-weight:bold');
    crashes.forEach(function (c, i) {
      console.log('#' + (i + 1), c.detectedAt, '→', c.signals.join(', ') || '(no signals)',
        '\n  heap:', JSON.stringify(c.prior && c.prior.heap),
        '\n  device:', (c.prior && c.prior.dev && c.prior.dev.deviceMemoryGB) + 'GB /', (c.prior && c.prior.dev && c.prior.dev.cores) + ' cores /', (c.prior && c.prior.dev && c.prior.dev.net),
        '\n  lastScript:', JSON.stringify(c.prior && c.prior.lastScript),
        '\n  appCheck:', c.prior && c.prior.appCheck, ' lastError:', JSON.stringify(c.prior && c.prior.lastError),
        '\n  ua:', c.prior && c.prior.dev && c.prior.dev.ua);
    });
    return crashes;
  };
  window.__sokoniSentinelClear = function () { try { localStorage.removeItem(CRASHES); localStorage.removeItem(LOADS); } catch (_) {} return 'cleared'; };
})();
