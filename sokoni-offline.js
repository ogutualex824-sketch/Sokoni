/* ================================================================
   sokoni-offline.js — Smart Offline Detection v1.1
   Shows offline banner ONLY when BOTH conditions are true:
     1. navigator.onLine === false (browser sees no network), AND
     2. A lightweight backend ping fails (confirms real disconnect).

   v1.1 changes:
   • Removed the proactive "captive portal" ping at page load —
     it caused false-positive banners when Firebase init was slow.
   • Added 1 s debounce on the `offline` event to survive brief
     Android/iOS network transitions that recover instantly.
   • Re-ping on `online` still required before hiding (unchanged).
================================================================ */
(function () {
  'use strict';

  var _banner       = null;
  var _shown        = false;
  var _debounceTimer = null;

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

  /* ── Backend ping ──────────────────────────────────────── */
  function _ping() {
    var ctrl;
    try { ctrl = new AbortController(); } catch (_) { ctrl = null; }

    /* Abort after 5 s to avoid hanging */
    var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, 5000);

    fetch('/__/firebase/init.json', {
      method:  'GET',
      cache:   'no-store',
      signal:  ctrl ? ctrl.signal : undefined,
    })
      .then(function (r) {
        clearTimeout(timer);
        if (r.ok) _hide(); else _show();
      })
      .catch(function () {
        clearTimeout(timer);
        _show();
      });
  }

  /* ── Decision logic ────────────────────────────────────────────────────
     `navigator.onLine` is authoritative for "is there a network?" and is the
     ONLY gate for hiding the banner. Recovery must never depend on a backend
     ping succeeding — a failed/blocked ping (SW interception, CDN cache, a 404
     on a reserved URL) used to leave the banner stuck visible after the network
     had already returned. If onLine is true, hide immediately.               */
  function _sync() {
    if (navigator.onLine) _hide();
    else _show();
  }

  /* Kept for API compatibility (window.SokoniOffline.check). navigator.onLine
     drives visibility; the ping only escalates to "show" if the browser thinks
     it is online but the backend is unreachable (captive portal) — it can never
     block a hide. */
  function _check() {
    if (!navigator.onLine) { _show(); return; }
    _hide();
    _ping();
  }

  /* ── Network event listeners ───────────────────────────── */
  window.addEventListener('offline', function () {
    /* Debounce 1 s — Android/iOS briefly fire `offline` during Wi-Fi handoffs
       that resolve on their own. Only show if still offline after 1 s. */
    clearTimeout(_debounceTimer);
    _debounceTimer = setTimeout(function () {
      if (!navigator.onLine) _show();
    }, 1000);
  });

  window.addEventListener('online', function () {
    /* Network restored — trust the browser and hide instantly. Do NOT wait on a
       ping; that dependency was the cause of the "banner stuck while online" bug. */
    clearTimeout(_debounceTimer);
    _hide();
  });

  /* Re-sync when the tab regains focus or is restored from bfcache/app-switch.
     Mobile devices that sleep offline and wake online often miss the `online`
     event, which previously left the banner stranded. */
  window.addEventListener('pageshow', _sync);
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) _sync();
  });

  /* Initial state: show only if the browser reports offline. */
  if (!navigator.onLine) { _show(); }

  window.SokoniOffline = { check: _check, sync: _sync };
}());
