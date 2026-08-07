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

  /* Ordered from bottom → up: chat docks just above the nav, scroll-to-top above chat,
     WhatsApp above that — so none overlaps and each has its own slot. */
  var _FABS = [
    /* [ elementId, extraOffsetFromNav ] */
    ['kassBtn',            0   ],  /* chat — lowest, just above the bottom nav */
    ['sokoniScrollTop',    56  ],  /* scroll-to-top — one slot above chat */
    ['sokoni-wa-support',  112 ],  /* WhatsApp — above scroll-top */
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

  /* ── Auto-hide on scroll-down, reappear on scroll-up ──────────────
     Frees the lower-right corner (Buy / Checkout / quantity) while the user reads
     down the page; the FABs slide back in the moment they scroll up. rAF-throttled,
     passive — no scroll jank. Uses transform (independent of the `bottom` docking). */
  var _lastY = 0, _hidden = false, _raf = 0;
  function _setHidden(h) {
    if (h === _hidden) return;
    _hidden = h;
    var apply = function (el) {
      if (!el) return;
      el.style.transition = 'transform .25s ease, opacity .25s ease';
      el.style.transform  = h ? 'translateY(160%)' : 'translateY(0)';
      el.style.opacity    = h ? '0' : '1';
      el.style.pointerEvents = h ? 'none' : 'auto';
    };
    _FABS.forEach(function (entry) { apply(document.getElementById(entry[0])); });
    document.querySelectorAll('.sk-fab[data-skf], .floating-btn[data-skf]').forEach(apply);
  }
  function _onScroll() {
    var y = window.scrollY || document.documentElement.scrollTop || 0;
    if (y > _lastY + 6 && y > 140)      _setHidden(true);    /* scrolling down, past the fold */
    else if (y < _lastY - 6)            _setHidden(false);   /* scrolling up */
    _lastY = y;
  }
  window.addEventListener('scroll', function () {
    if (_raf) return;
    _raf = requestAnimationFrame(function () { _raf = 0; _onScroll(); });
  }, { passive: true });

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
