/* ================================================================
   sokoni-float.js — Floating Button Manager v1.0
   Repositions FABs (scroll-to-top, KASS chat, WhatsApp) above the
   bottom navigation bar so they never cover content, forms, or
   interactive elements.

   Auto-runs on: DOMContentLoaded, resize, orientationchange.
   Also re-runs after SokoniDrawer closes (nav reappears).
================================================================ */
(function () {
  'use strict';

  /* Ordered from bottom → up: each entry stacks 12px above the previous */
  var _FABS = [
    /* [ elementId, extraOffsetFromNav ] */
    ['sokoniScrollTop',    0  ],  /* sits 12px above nav */
    ['kassBtn',            0  ],  /* same layer — positioned by its own right offset */
    ['sokoni-wa-support',  56 ],  /* one slot higher than scroll-top */
  ];

  var _BNAV_SEL = ['#bottomNav', '.bottom-nav', 'nav[data-workspace]'];

  function _bnavHeight() {
    for (var i = 0; i < _BNAV_SEL.length; i++) {
      var el = document.querySelector(_BNAV_SEL[i]);
      if (el && el.offsetHeight > 0) return el.offsetHeight;
    }
    return 0;
  }

  function _reposition() {
    var navH = _bnavHeight();
    /* No bottom nav on this page — leave FABs at their authored positions */
    if (navH === 0) return;

    var gap  = 12; /* px gap between nav top edge and lowest FAB */
    var safe = 'env(safe-area-inset-bottom, 0px)';

    _FABS.forEach(function (entry) {
      var el = document.getElementById(entry[0]);
      if (!el) return;
      el.style.bottom = 'calc(' + (navH + gap + entry[1]) + 'px + ' + safe + ')';
    });

    /* Generic FABs with shared class — only reposition once per element */
    document.querySelectorAll('.sk-fab:not([data-skf]), .floating-btn:not([data-skf])').forEach(function (fab) {
      fab.setAttribute('data-skf', '1');
      fab.style.bottom = 'calc(' + (navH + gap) + 'px + ' + safe + ')';
    });
  }

  /* ── Bootstrap ─────────────────────────────────────────── */
  function _init() {
    _reposition();
    /* Deferred bottom navs (injected by sokoni-nav-engine.js) */
    setTimeout(_reposition, 400);
    setTimeout(_reposition, 1200);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _init);
  } else {
    _init();
  }

  window.addEventListener('resize', _reposition);
  window.addEventListener('orientationchange', function () {
    setTimeout(_reposition, 200);
  });

  /* After a SokoniDrawer closes (nav reappears from under FAB hide rule) */
  document.addEventListener('click', function (e) {
    if (e.target && (
      e.target.classList.contains('sk-drawer-close') ||
      e.target.classList.contains('sk-drawer-back') ||
      e.target.id === 'sk-drawer-backdrop'
    )) {
      setTimeout(_reposition, 360); /* after 0.3s close animation */
    }
  });

  window.SokoniFloat = { reposition: _reposition };
}());
