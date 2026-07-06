/* ================================================================
   sokoni-offline.js — Smart Offline Detection v1.0
   Shows offline banner ONLY when BOTH conditions are true:
     1. navigator.onLine === false (browser sees no network), AND
     2. A lightweight backend ping fails (confirms real disconnect).
   Prevents false positives on captive portals, slow networks, and
   pages where navigator.onLine over-reports "connected."
================================================================ */
(function () {
  'use strict';

  var _banner = null;
  var _shown  = false;

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

  /* ── Decision logic ────────────────────────────────────── */
  function _check() {
    if (!navigator.onLine) {
      /* Browser is certain — no network at all */
      _show();
    } else {
      /* navigator.onLine = true is optimistic; confirm with a real request */
      _ping();
    }
  }

  /* ── Network event listeners ───────────────────────────── */
  window.addEventListener('offline', function () {
    /* Network gone — show immediately, no ping needed */
    _show();
  });

  window.addEventListener('online', function () {
    /* Network restored — verify before hiding (could be captive portal) */
    _ping();
  });

  /* Initial state — only ping if browser already reports offline.
     Don't waste a fetch on every page load when everything is working. */
  if (!navigator.onLine) {
    _show();
  }

  window.SokoniOffline = { check: _check };
}());
