/* ══════════════════════════════════════════════════════════════════════════════
   SOKONI — SERVICE WORKER LIFECYCLE TELEMETRY

   WHY THIS EXISTS (2026-07-18). The service worker could sit at
   {installing:true, active:null} indefinitely and nothing anywhere recorded it.
   Every "the site looks wrong" report became an unresolvable argument between
   deployment, cache and DNS, because no client could say which build it was running
   or whether its worker had ever activated.

   This reports the SW lifecycle to the /api/diag receiver. It is diagnostics only:
   it never changes registration behaviour, never blocks a page, and never throws
   into the app. sw-register.js remains the only thing that registers or updates.

   PRIVACY. No user identity, no URL query strings, no page content. Only lifecycle
   facts about the worker and the build. The receiver hashes the IP and applies a
   30-day TTL.
   ══════════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  if (!('serviceWorker' in navigator)) return;

  var ENDPOINT = '/api/diag';
  var t0 = Date.now();
  var installStart = null;
  var activateStart = null;
  var build = null;

  /* ── Build identity. Fetched once, best-effort; telemetry works without it. ── */
  function loadBuild() {
    try {
      return fetch('/version.json', { cache: 'no-store' })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (j) { build = j; return j; })
        .catch(function () { return null; });
    } catch (e) { return Promise.resolve(null); }
  }

  function connection() {
    var c = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    if (!c) return { networkType: null, downlink: null, rtt: null, saveData: null };
    return {
      networkType: c.effectiveType || c.type || null,
      downlink: typeof c.downlink === 'number' ? c.downlink : null,
      rtt: typeof c.rtt === 'number' ? c.rtt : null,
      saveData: !!c.saveData,
    };
  }

  function displayMode() {
    try {
      if (window.matchMedia && matchMedia('(display-mode: standalone)').matches) return 'standalone';
      if (navigator.standalone) return 'ios-standalone';
    } catch (e) {}
    return 'browser';
  }

  /* Was THIS navigation answered by the SW or the network? transferSize 0 with a real
     body is the signature of a cache/SW-served response. */
  function servedFrom() {
    try {
      var nav = (performance.getEntriesByType && performance.getEntriesByType('navigation')[0]) || null;
      if (!nav) return null;
      return (nav.transferSize === 0 && nav.decodedBodySize > 0) ? 'cache' : 'network';
    } catch (e) { return null; }
  }

  function send(event, extra) {
    var body = {
      kind: 'sw-lifecycle',
      diag: Object.assign({
        anomaly: event,                     /* receiver requires this field */
        event: event,
        path: location.pathname,
        swVersion: null,
        cacheVersion: null,
        buildCommit: build ? build.commitShort : null,
        buildTime: build ? build.buildTime : null,
        expectedCacheVersion: build ? build.cacheVersion : null,
        onlineStatus: navigator.onLine ? 'online' : 'offline',
        displayMode: displayMode(),
        servedFrom: servedFrom(),
        sinceLoadMs: Date.now() - t0,
        ua: navigator.userAgent.slice(0, 160),
        ts: Date.now(),
      }, connection(), extra || {}),
    };
    try {
      var blob = new Blob([JSON.stringify(body)], { type: 'application/json' });
      if (navigator.sendBeacon) navigator.sendBeacon(ENDPOINT, blob);
      else fetch(ENDPOINT, { method: 'POST', body: JSON.stringify(body), keepalive: true }).catch(function () {});
    } catch (e) { /* telemetry must never break the page */ }
  }

  /* Ask the active worker which cache version it is running. */
  function askVersion(cb) {
    try {
      var c = navigator.serviceWorker.controller;
      if (!c) return cb(null);
      var ch = new MessageChannel();
      var done = false;
      var t = setTimeout(function () { if (!done) { done = true; cb(null); } }, 3000);
      ch.port1.onmessage = function (e) {
        if (done) return;
        done = true; clearTimeout(t);
        cb((e.data && e.data.version) || null);
      };
      c.postMessage({ type: 'GET_VERSION' }, [ch.port2]);
    } catch (e) { cb(null); }
  }

  /* ── Lifecycle observation ────────────────────────────────────────────────── */
  function watch(reg) {
    if (!reg) return;

    if (reg.installing) { installStart = Date.now(); send('sw_install_started'); }

    reg.addEventListener('updatefound', function () {
      var nw = reg.installing;
      if (!nw) return;
      installStart = Date.now();
      send('sw_update_available');
      send('sw_install_started');

      nw.addEventListener('statechange', function () {
        var dur = installStart ? Date.now() - installStart : null;

        if (nw.state === 'installed') {
          send('sw_install_completed', { installationDuration: dur });
          activateStart = Date.now();
          send('sw_activate_started');
        } else if (nw.state === 'activated') {
          send('sw_activate_completed', {
            activationDuration: activateStart ? Date.now() - activateStart : null,
          });
        } else if (nw.state === 'redundant') {
          /* redundant BEFORE activation == the install failed. With the app-shell
             worker this is the expected outcome of an incomplete shell, and it is
             precisely the event that was previously invisible. */
          send('sw_install_failed', {
            installationDuration: dur,
            note: 'worker became redundant before activating',
          });
        }
      });
    });

    /* A new worker took control — the update actually reached this client. */
    navigator.serviceWorker.addEventListener('controllerchange', function () {
      askVersion(function (v) {
        send('sw_update_applied', {
          cacheVersion: v,
          cacheVersionMatchesBuild: (build && v) ? (v === build.cacheVersion) : null,
        });
      });
    });
  }

  /* Messages the worker itself emits (install completion, shell failures). */
  navigator.serviceWorker.addEventListener('message', function (e) {
    var d = e.data || {};
    if (d.type === 'SW_UPDATE_READY') send('sw_install_completed', { cacheVersion: d.version || null });
    if (d.type === 'SW_SHELL_FAILED') {
      send('shell_asset_failed', { shellAsset: d.asset || null, shellAssetStatus: d.status || null });
    }
  });

  /* ── Boot ─────────────────────────────────────────────────────────────────── */
  loadBuild().then(function () {
    navigator.serviceWorker.getRegistration().then(function (reg) {
      watch(reg);

      /* Steady-state snapshot: is this client on the build we think we shipped?
         This is the single most useful record when someone reports a stale page. */
      setTimeout(function () {
        askVersion(function (v) {
          var ctrl = navigator.serviceWorker.controller;
          var mismatch = build && v && v !== build.cacheVersion;
          /* Report only when something is worth looking at — a healthy, current client
             is not worth a write. Anomalies only, per the receiver's contract. */
          if (!ctrl) send('sw_no_controller', { cacheVersion: v });
          else if (mismatch) send('sw_version_mismatch', { cacheVersion: v });
        });
      }, 8000);
    }).catch(function () {});
  });
})();
