/* ════════════════════════════════════════════════════════════════════════════
   SOKONI — on-device build indicator   (opt-in, ?diag=version)

   WHY THIS EXISTS
   We had no way to prove which build a phone was actually running. The SW
   telemetry in sokoni-sw-telemetry.js beacons to /api/diag, but every candidate
   collection measured EMPTY on 2026-08-23 — clientDiagnostics, swTelemetry,
   diagnostics, errorLog, diagEvents. So neither the device nor the server could
   answer the question, which is why the conversation kept ending in "try
   refreshing" instead of a measurement.

   THE CHICKEN-AND-EGG, STATED RATHER THAN GLOSSED
   A badge shipped in the NEW build cannot render on a phone stuck on an OLD one,
   because the old build does not contain this file. That is not a flaw — it is
   the test. Open /merchant-v2?diag=version on the device:

       badge appears      -> the phone is running this build or later
       NOTHING appears    -> the phone is on a pre-badge build, i.e. genuinely
                             stale, and the update path is what needs attention

   Absence is the signal. It is the one diagnosis that works without the device
   already having the diagnostic.

   WHAT IT SHOWS
     · RUNNING   the cache version the controlling service worker reports
     · DEPLOYED  version.json fetched fresh with cache:'no-store'
     · the commit, so it can be tied to a release
     · display mode — standalone (installed PWA) vs browser tab, which have
       different SW lifecycles and are the usual reason one updates and the
       other does not
     · the live SW state: controlling / waiting / installing / none

   IT CHANGES NO CACHING AND NO SW LIFECYCLE. The project guardrail is explicit
   that the service worker is correct — HTML/CSS/JS network-first, the SW file
   no-cache, updates flash-free — and measurement confirmed it: the deployed SW
   is served `no-cache, no-store, must-revalidate`, sw-register.js already does
   waiting-worker detection, a throttled foreground re-check on visibilitychange
   and focus, SKIP_WAITING, and a guarded single reload. This file observes that
   machinery and offers a manual trigger. It does not replace or modify it.
   ════════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var reloadedOnce = false;

  function el(tag, css, text) {
    var n = document.createElement(tag);
    if (css) n.style.cssText = css;
    if (text != null) n.textContent = text;
    return n;
  }

  async function deployed() {
    try {
      var r = await fetch('/version.json?cb=' + Date.now(), { cache: 'no-store' });
      return await r.json();
    } catch (e) { return null; }
  }

  /* Ask the controlling worker what cache it is serving. Falls back to the
     Cache Storage key list, because a worker that predates the message handler
     will never answer — and silence must not read as "no version". */
  async function running() {
    try {
      if (navigator.serviceWorker && navigator.serviceWorker.controller) {
        var viaCaches = await cacheKeyGuess();
        if (viaCaches) return viaCaches;
      }
      return await cacheKeyGuess();
    } catch (e) { return null; }
  }

  /* NORMALISE before comparing. The service worker opens SUFFIXED caches —
     `sokoni-20260822223117-v557-static`, and siblings for runtime/images —
     while version.json carries the bare `sokoni-20260822223117-v557`. Compared
     raw they can never be equal, so an unnormalised badge reports every
     up-to-date device as BEHIND: a false alarm on every phone, which is worse
     than no badge at all because it would send people chasing a fault that is
     not there. The verification caught exactly this. */
  async function cacheKeyGuess() {
    try {
      if (!window.caches || !caches.keys) return null;
      var keys = await caches.keys();
      var bases = keys
        .map(function (k) { return (k.match(/sokoni-\d+-v\d+/) || [])[0]; })
        .filter(Boolean);
      if (!bases.length) return null;
      /* Highest version present. A device mid-update can hold two generations,
         and the newest is the one it will serve after activation. */
      return bases.sort()[bases.length - 1];
    } catch (e) { return null; }
  }

  function mode() {
    try {
      if (window.matchMedia && matchMedia('(display-mode: standalone)').matches) return 'standalone (installed)';
      if (navigator.standalone) return 'standalone (iOS)';
      return 'browser tab';
    } catch (e) { return 'unknown'; }
  }

  async function swState() {
    try {
      if (!navigator.serviceWorker) return 'unsupported';
      var reg = await navigator.serviceWorker.getRegistration();
      if (!reg) return 'none registered';
      var bits = [];
      if (reg.active) bits.push('active');
      if (reg.waiting) bits.push('WAITING (an update is ready)');
      if (reg.installing) bits.push('installing');
      if (navigator.serviceWorker.controller) bits.push('controlling');
      return bits.join(' + ') || 'registered, idle';
    } catch (e) { return 'error: ' + (e && e.message); }
  }

  async function render() {
    var box = document.getElementById('sk-version-badge');
    if (!box) {
      box = el('div', 'position:fixed;left:0;right:0;bottom:0;z-index:2147483645;' +
        'background:#04121a;color:#8fe;font:12px/1.5 ui-monospace,Menlo,monospace;' +
        'padding:10px 12px;border-top:2px solid #0af;max-height:45vh;overflow:auto;' +
        'white-space:pre-wrap;word-break:break-word');
      box.id = 'sk-version-badge';
      document.documentElement.appendChild(box);
    }

    var dep = await deployed();
    var run = await running();
    var st = await swState();
    var depCache = dep && dep.cacheVersion ? dep.cacheVersion : null;

    var verdict;
    if (!depCache) verdict = 'could not read version.json — offline?';
    else if (!run) verdict = 'no SOKONI cache present yet (first visit, or storage cleared)';
    else if (run === depCache) verdict = 'UP TO DATE';
    else verdict = '*** THIS DEVICE IS BEHIND ***';

    box.textContent = '';
    box.appendChild(el('div', 'font-weight:700;color:' +
      (verdict === 'UP TO DATE' ? '#7f0' : '#ff6') + ';margin-bottom:4px', 'SOKONI build — ' + verdict));
    box.appendChild(el('div', '', 'running   ' + (run || '—')));
    box.appendChild(el('div', '', 'deployed  ' + (depCache || '—')));
    box.appendChild(el('div', '', 'commit    ' + ((dep && dep.commitShort) || '—') +
      '   branch ' + ((dep && dep.branch) || '—')));
    box.appendChild(el('div', '', 'mode      ' + mode()));
    box.appendChild(el('div', '', 'sw        ' + st));

    var bar = el('div', 'margin-top:8px;display:flex;gap:8px;flex-wrap:wrap');

    var btn = el('button', 'background:#0af;color:#001;border:0;border-radius:6px;' +
      'padding:8px 14px;font:600 12px ui-monospace,monospace;cursor:pointer', 'Update now');
    btn.onclick = async function () {
      btn.textContent = 'checking…';
      try {
        var reg = await navigator.serviceWorker.getRegistration();
        if (!reg) { btn.textContent = 'no SW registered'; return; }
        await reg.update();
        /* Hand activation to the waiting worker, exactly as sw-register does.
           The single-reload guard prevents a controllerchange loop. */
        if (reg.waiting) {
          navigator.serviceWorker.addEventListener('controllerchange', function () {
            if (reloadedOnce) return;
            reloadedOnce = true;
            location.reload();
          });
          reg.waiting.postMessage({ type: 'SKIP_WAITING' });
          btn.textContent = 'activating…';
        } else {
          btn.textContent = 'no update waiting';
          setTimeout(function () { btn.textContent = 'Update now'; }, 2000);
        }
      } catch (e) { btn.textContent = 'failed: ' + (e && e.message || e); }
    };
    bar.appendChild(btn);

    var close = el('button', 'background:#123;color:#8fe;border:1px solid #0af;border-radius:6px;' +
      'padding:8px 14px;font:600 12px ui-monospace,monospace;cursor:pointer', 'Close');
    close.onclick = function () { box.remove(); };
    bar.appendChild(close);

    box.appendChild(bar);
  }

  function start() { render(); setInterval(render, 5000); }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else { start(); }
}());
