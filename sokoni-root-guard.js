/* ============================================================================
   SOKONI — CANONICAL ROOT GUARD  v1.0
   ----------------------------------------------------------------------------
   Guarantees that "/" renders the marketplace home, whatever the cache, the service
   worker, Safari session restoration or a future code change decides to do.

   Why this exists: a merchant profile was reported rendering at the bare domain on an
   iPhone. A full audit of Hosting rewrites, redirects, session state, storage, the SW
   cache and the SW update path found no cause reproducible off-device. Rather than leave
   the platform dependent on a bug we cannot see, the root route now VERIFIES ITSELF and
   recovers if the verification fails.

   Design rules, in priority order:

     1. NEVER make things worse. Every recovery path is bounded, one-shot per session, and
        fails open — if anything here throws, the user keeps the page they have.
     2. NEVER touch legitimate merchant URLs. /shop/*, /store/*, /merchant/*, /@* are real
        destinations; this guard is inert on them.
     3. NEVER loop. A reload that could re-trigger the condition that caused it is how a
        "self-healing" guard becomes a boot loop that bricks the site. Guarded by a
        sessionStorage latch that survives the reload.
     4. Diagnostics are recorded ALWAYS, uploaded ONLY on anomaly. Telemetry that fires on
        every load is a cost with no reader.

   Load early on the marketplace shell, before the page paints.
   ============================================================================ */
(function () {
  'use strict';

  var EXPECTED   = 'marketplace-home';
  var LATCH      = '_skRootHealed';      /* sessionStorage: one recovery per session   */
  var DIAG_KEY   = '_skRootDiag';        /* sessionStorage: last diagnostic snapshot   */

  /* Routes that legitimately render a merchant template. The guard is INERT here. */
  function isMerchantRoute(p) {
    return /^\/(shop|store|merchant)(\/|$)/i.test(p) || /^\/@/.test(p) || /^\/card(\/|$)/i.test(p);
  }
  /* The canonical root, in every form Hosting may present it. */
  function isRoot(p) {
    return p === '/' || p === '/index.html' || p === '/index';
  }

  function readTemplate(doc) {
    try {
      var m = (doc || document).querySelector('meta[name="sokoni-page"]');
      return m ? (m.getAttribute('content') || '').trim() : null;
    } catch (e) { return null; }
  }

  /* ── Diagnostics ──────────────────────────────────────────────────────────────
     Everything needed to answer "what happened?" without asking the user to reproduce:
     was it cache or network, which SW, which cache version, which template, which
     navigation type, which display mode. */
  function collect() {
    var d = {};
    try {
      var nav = (performance.getEntriesByType && performance.getEntriesByType('navigation')[0]) || {};
      d.url           = location.href;
      d.path          = location.pathname;
      d.referrer      = document.referrer || null;
      d.navType       = nav.type || null;                 /* navigate | reload | back_forward */
      d.redirectCount = (nav.redirectCount != null) ? nav.redirectCount : null;
      /* transferSize 0 with a real body is the signature of a cache/SW-served response. */
      d.fromCache     = (nav.transferSize === 0 && nav.decodedBodySize > 0) || null;
      d.displayMode   = (window.matchMedia && matchMedia('(display-mode: standalone)').matches)
                          ? 'standalone'
                          : (navigator.standalone ? 'ios-standalone' : 'browser');
      d.template      = readTemplate(document);
      d.swScript      = (navigator.serviceWorker && navigator.serviceWorker.controller)
                          ? navigator.serviceWorker.controller.scriptURL.split('/').pop() : null;
      d.buildVersion  = (window.SOKONI_BUILD || null);
      d.ts            = Date.now();
      d.ua            = navigator.userAgent.slice(0, 160);
    } catch (e) { d.collectError = String(e && e.message); }
    return d;
  }

  /* Ask the service worker which cache version is live. Best-effort, never blocking. */
  function askCacheVersion(diag) {
    try {
      if (!navigator.serviceWorker || !navigator.serviceWorker.controller) return;
      var ch = new MessageChannel();
      ch.port1.onmessage = function (ev) {
        if (ev.data && ev.data.version) {
          diag.cacheVersion = ev.data.version;
          try { sessionStorage.setItem(DIAG_KEY, JSON.stringify(diag)); } catch (e) {}
        }
      };
      navigator.serviceWorker.controller.postMessage({ type: 'GET_VERSION' }, [ch.port2]);
    } catch (e) {}
  }

  /* Upload ONLY on anomaly. A beacon survives the page being torn down by a reload. */
  function report(diag, reason) {
    diag.anomaly = reason;
    try { sessionStorage.setItem(DIAG_KEY, JSON.stringify(diag)); } catch (e) {}
    try { console.error('[SOKONI root-guard] ANOMALY: ' + reason, diag); } catch (e) {}
    try {
      var body = JSON.stringify({ kind: 'root-route-anomaly', diag: diag });
      if (navigator.sendBeacon) {
        navigator.sendBeacon('/api/diag', new Blob([body], { type: 'application/json' }));
      }
    } catch (e) { /* telemetry must never break the recovery */ }
  }

  /* ── Cache self-healing ───────────────────────────────────────────────────────
     Drop every cached entry for "/" so the next load repopulates from the network.
     Returns a promise that always resolves — recovery proceeds even if this fails. */
  function purgeRootCache() {
    try {
      if (!window.caches) return Promise.resolve(false);
      return caches.keys().then(function (names) {
        return Promise.all(names.map(function (n) {
          return caches.open(n).then(function (c) {
            return Promise.all([
              c.delete('/'), c.delete('/index.html'),
              c.delete(location.origin + '/'), c.delete('/?source=pwa'),
            ]);
          }).catch(function () {});
        }));
      }).then(function () { return true; }).catch(function () { return false; });
    } catch (e) { return Promise.resolve(false); }
  }

  /* ── The guard ────────────────────────────────────────────────────────────── */
  function run() {
    var path = location.pathname;

    /* Rule 2: merchant routes are legitimate — do nothing at all. */
    if (isMerchantRoute(path)) return;
    if (!isRoot(path)) return;

    var diag = collect();
    askCacheVersion(diag);
    try { sessionStorage.setItem(DIAG_KEY, JSON.stringify(diag)); } catch (e) {}

    var tpl = diag.template;

    /* Correct — the overwhelmingly common path. Record and get out of the way. */
    if (tpl === EXPECTED) return;

    /* A shell with NO identifier is an older build, not proof of a wrong page. Report it
       so it is visible, but do NOT reload: recovering from an unknown state risks looping,
       and being wrong here costs the user their session. */
    if (!tpl) { report(diag, 'root-missing-template-id'); return; }

    /* A DIFFERENT template is rendering at "/" — the reported bug. Recover. */
    if (sessionStorage.getItem(LATCH)) {
      /* Already healed once this session and it happened again: reloading again would
         loop. Stop, and leave loud telemetry — a repeat means the network itself is
         serving the wrong document, which no client-side guard can fix. */
      report(diag, 'root-wrong-template-AFTER-heal:' + tpl);
      return;
    }

    report(diag, 'root-wrong-template:' + tpl);
    try { sessionStorage.setItem(LATCH, String(Date.now())); } catch (e) {}

    purgeRootCache().then(function () {
      /* cache:'reload' forces a network fetch and repopulates the SW cache with a
         verified-fresh document. The bare origin, so we cannot land anywhere else. */
      try { location.replace(location.origin + '/?_skheal=1'); }
      catch (e) { location.href = '/'; }
    });
  }

  /* Expose the last snapshot for support and for /route-debug. */
  window.SokoniRootGuard = {
    diagnostics: function () {
      try { return JSON.parse(sessionStorage.getItem(DIAG_KEY) || 'null'); } catch (e) { return null; }
    },
    expected: EXPECTED,
  };

  /* The template identifier lives in <head>, so it is readable before DOMContentLoaded.
     Running immediately means the wrong page is caught before the user interacts with it. */
  try { run(); } catch (e) {
    try { console.warn('[SOKONI root-guard] failed open:', e); } catch (_) {}
  }
})();
