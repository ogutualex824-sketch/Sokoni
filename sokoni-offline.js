/* ================================================================
   sokoni-offline.js — Connectivity Detection v2.1

   The banner is driven by an ACTIVE PROBE, never by navigator.onLine.

   v2.1 — fixes "false offline banner on every page load":
   • Boot-time grace period added to ALL event handlers (pageshow,
     visibilitychange, offline). For the first 11 s after the script
     loads we skip any banner — this covers the full first-probe
     cycle in sokoni-ui.js (3 s delay + 4 s timeout + 4 s buffer),
     which is the authoritative offline detector. Firing our own probe
     during that window produced duplicate false banners before the
     primary system had finished its first check.
   • Initial probe delayed to 11 s (was 3.5 s) — fires as a
     belt-and-suspenders backup AFTER the primary system (sokoni-ui.js
     #sk-offline-bar) has confirmed connectivity at least once.
   • _show() still short-circuits when #sk-offline-bar exists, so even
     if this module fires early, the banner cannot appear alongside the
     primary bar.

   v2.0 policy (unchanged):
   • Only a FAILED probe may SHOW the banner.
   • A SUCCESSFUL probe always HIDES it.
   • navigator.onLine is only a hint; it never directly shows the banner.
================================================================ */
(function () {
  'use strict';

  var _banner        = null;
  var _shown         = false;
  var _debounceTimer = null;
  var _bootTime      = Date.now();
  var _GRACE_MS      = 11000; /* covers sokoni-ui.js's first probe cycle */

  /* ── Banner element ────────────────────────────────────── */
  function _ensureBanner() {
    if (_banner) return _banner;
    _banner = document.getElementById('sk-offline-banner');
    if (_banner) return _banner;

    _banner = document.createElement('div');
    _banner.id = 'sk-offline-banner';
    _banner.setAttribute('role', 'alert');
    _banner.setAttribute('aria-live', 'polite');
    _banner.textContent = '📡 No internet connection — some features may not work.';

    /* Inline critical styles so the banner works before any stylesheet loads */
    Object.assign(_banner.style, {
      position:        'fixed',
      top:             '64px',   /* sits just below the 64px top nav */
      left:            '0',
      right:           '0',
      zIndex:          '100003',
      padding:         '10px 16px',
      background:      'rgba(220,38,38,0.96)',
      color:           '#fff',
      fontSize:        '13px',
      fontWeight:      '700',
      textAlign:       'center',
      fontFamily:      '\'Segoe UI\', system-ui, sans-serif',
      backdropFilter:  'blur(12px)',
      borderBottom:    '1px solid rgba(220,38,38,0.4)',
      transform:       'translateY(-100%)',
      transition:      'transform 0.25s cubic-bezier(0.34,1.1,0.64,1)',
      willChange:      'transform',
    });

    document.body.appendChild(_banner);
    return _banner;
  }

  function _show() {
    /* Defer to sokoni-ui.js's richer #sk-offline-bar where it is present
       (index, etims, hub-dashboard) — avoids two stacked offline banners. */
    if (document.getElementById('sk-offline-bar')) return;
    if (_shown) return;
    _shown = true;
    var b = _ensureBanner();
    /* Force reflow so the CSS transition plays from translateY(-100%) → 0 */
    requestAnimationFrame(function () {
      b.style.transform = 'translateY(0)';
    });
  }

  function _hide() {
    if (!_shown) return;
    _shown = false;
    if (_banner) _banner.style.transform = 'translateY(-100%)';
  }

  /* ── Active connectivity probe — THE SOURCE OF TRUTH ───────────── */
  function _probe() {
    var ctrl;
    try { ctrl = new AbortController(); } catch (_) { ctrl = null; }
    var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, 4000);

    return fetch('https://www.gstatic.com/generate_204', {
      mode:   'no-cors',
      cache:  'no-store',
      signal: ctrl ? ctrl.signal : undefined,
    })
      .then(function () { clearTimeout(timer); return true; })
      .catch(function () {
        clearTimeout(timer);
        /* gstatic unreachable. If the browser still reports a network,
           assume the probe was blocked (firewall, extension, DNS) rather
           than declaring the user offline. */
        return navigator.onLine === true;
      });
  }

  function _sync() {
    return _probe().then(function (online) {
      if (online) _hide(); else _show();
      return online;
    });
  }

  function _check() { return _sync(); }

  /* ── Network event listeners ────────────────────────────── */
  window.addEventListener('offline', function () {
    /* Skip during grace period — sokoni-ui.js handles this window */
    if (Date.now() - _bootTime < _GRACE_MS) return;
    clearTimeout(_debounceTimer);
    _debounceTimer = setTimeout(_sync, 1000);
  });

  window.addEventListener('online', function () {
    clearTimeout(_debounceTimer);
    _hide();
    /* Only re-probe after grace to avoid racing with primary system */
    if (Date.now() - _bootTime >= _GRACE_MS) _sync();
  });

  /* Re-check on bfcache restore or focus — skip during initial boot
     to avoid a false-offline race before the network is established. */
  window.addEventListener('pageshow', function () {
    if (Date.now() - _bootTime < _GRACE_MS) return;
    _sync();
  });

  document.addEventListener('visibilitychange', function () {
    if (document.hidden) return;
    if (Date.now() - _bootTime < _GRACE_MS) return;
    _sync();
  });

  /* Backup probe: fires after the primary system (sokoni-ui.js) has
     had time to complete its own first probe and grace period. This
     module only takes over when #sk-offline-bar is absent (pages that
     don't load sokoni-ui.js). */
  setTimeout(_sync, 11000);

  window.SokoniOffline = { check: _check, sync: _sync, probe: _probe, hide: _hide };
}());
