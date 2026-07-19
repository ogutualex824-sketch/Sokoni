/**
 * SOKONI LAYOUT MANAGER v1.0
 * ─────────────────────────────────────────────────────────────────────────────
 * Single authority for all positional and z-index decisions on the platform.
 *
 * Solves:
 *   - Floating buttons overlapping bottom nav / each other
 *   - Search / chat / notification icons at the same z-level
 *   - FABs hidden behind keyboard on mobile
 *   - Inconsistent safe-area handling (iPhone notch / home indicator)
 *   - 45 unique ad-hoc z-index values across 19 CSS files
 *   - 80+ fixed/sticky elements with no coordination
 *
 * How it works:
 *   1. Reads the page's registered elements (bottom-nav, FABs, chat widget, etc.)
 *   2. Computes stack offsets and writes them as CSS custom properties on :root
 *   3. All floating elements declare `bottom: var(--sk-fab-bottom)` — when the
 *      bottom nav height changes, everything repositions automatically.
 *   4. Enforces the z-index tier system from sokoni-tokens.css.
 *
 * Exposed on: window.SokoniLayout
 * Dependencies: sokoni-tokens.css
 * ─────────────────────────────────────────────────────────────────────────────
 */
(function(global) {
  'use strict';

  /* ─────────────────────────────────────────────────────────────────────────
     Z-INDEX TIER CONSTANTS  (mirrors sokoni-tokens.css --sk-z-*)
     Only these values may be used.  All other z-index values are forbidden.
  ───────────────────────────────────────────────────────────────────────── */
  var Z = {
    below:          -1,
    base:            0,
    raised:         10,
    dropdown:       50,
    sticky:        100,
    tabBar:        300,
    bottomNav:     400,
    fab:           500,
    chatBtn:       510,
    scrollTop:     520,
    drawer:        600,
    /* ── Above marketing-popup layer (~99997-99999) ── */
    header:     100001,   /* top app bar — must beat all marketing overlays */
    navMenu:    100002,   /* nav hamburger panel */
    /* ── UI chrome above the fixed header ── */
    modalOverlay: 200000,
    modal:        200001,
    toast:        200002,
    alert:        200003,
    splash:       300000,
    cookie:       300001,
    emergency:    999999
  };

  /* ─────────────────────────────────────────────────────────────────────────
     ELEMENT REGISTRY
     Pages register their floating elements here so Layout knows their heights.
  ───────────────────────────────────────────────────────────────────────── */
  var _registry = {
    header:     null,   /* top bar element */
    tabBar:     null,   /* horizontal tab strip below header */
    bottomNav:  null,   /* bottom navigation bar */
    fabs:       [],     /* floating action buttons (any number) */
    chatBtn:    null,   /* chat/support floating button */
    scrollTop:  null,   /* scroll-to-top button */
    drawers:    [],     /* side drawers */
    modals:     []      /* active modals */
  };

  /* Measured heights (px) */
  var _dims = {
    headerH:    0,
    tabBarH:    0,
    bottomNavH: 0,
    safeTop:    0,
    safeBottom: 0,
    safeLeft:   0,
    safeRight:  0,
    viewportH:  0,
    viewportW:  0,
    keyboardH:  0
  };

  /* ─────────────────────────────────────────────────────────────────────────
     REGISTRATION API
     Call from DOMContentLoaded or after element creation.
  ───────────────────────────────────────────────────────────────────────── */

  function register(role, el) {
    if (!el) return;
    switch (role) {
      case 'header':    _registry.header    = el; break;
      case 'tab-bar':   _registry.tabBar    = el; break;
      case 'bottom-nav':_registry.bottomNav = el; break;
      case 'fab':       if (_registry.fabs.indexOf(el) < 0) _registry.fabs.push(el); break;
      case 'chat-btn':  _registry.chatBtn   = el; break;
      case 'scroll-top':_registry.scrollTop = el; break;
      case 'drawer':    if (_registry.drawers.indexOf(el) < 0) _registry.drawers.push(el); break;
      default: break;
    }
    _applyZIndex(role, el);
    _scheduleUpdate();
  }

  function unregister(role, el) {
    switch (role) {
      case 'fab':    _registry.fabs    = _registry.fabs.filter(function(f) { return f !== el; }); break;
      case 'drawer': _registry.drawers = _registry.drawers.filter(function(d) { return d !== el; }); break;
      default: break;
    }
    _scheduleUpdate();
  }

  /* ─────────────────────────────────────────────────────────────────────────
     Z-INDEX ASSIGNMENT
     Guarantees every registered element sits in the correct tier.
  ───────────────────────────────────────────────────────────────────────── */

  function _applyZIndex(role, el) {
    var z;
    switch (role) {
      case 'header':    z = Z.header;    break;
      case 'tab-bar':   z = Z.tabBar;    break;
      case 'bottom-nav':z = Z.bottomNav; break;
      case 'fab':       z = Z.fab;       break;
      case 'chat-btn':  z = Z.chatBtn;   break;
      case 'scroll-top':z = Z.scrollTop; break;
      case 'drawer':    z = Z.drawer;    break;
      default:          return;
    }
    el.style.zIndex = String(z);
  }

  /* ─────────────────────────────────────────────────────────────────────────
     DIMENSION MEASUREMENT & CSS VARIABLE PROPAGATION
  ───────────────────────────────────────────────────────────────────────── */

  var _raf = null;

  function _scheduleUpdate() {
    if (_raf) cancelAnimationFrame(_raf);
    _raf = requestAnimationFrame(_measure);
  }

  function _measure() {
    _raf = null;

    /* Viewport */
    _dims.viewportH = global.innerHeight;
    _dims.viewportW = global.innerWidth;

    /* Safe areas — use computed style on :root to pick up env() */
    var rootStyle = getComputedStyle(document.documentElement);
    _dims.safeTop    = _parsePx(rootStyle.getPropertyValue('--sk-safe-top'))    || 0;
    _dims.safeBottom = _parsePx(rootStyle.getPropertyValue('--sk-safe-bottom')) || 0;
    _dims.safeLeft   = _parsePx(rootStyle.getPropertyValue('--sk-safe-left'))   || 0;
    _dims.safeRight  = _parsePx(rootStyle.getPropertyValue('--sk-safe-right'))  || 0;

    /* Element heights */
    _dims.headerH   = _elH(_registry.header);
    _dims.tabBarH   = _elH(_registry.tabBar);
    _dims.bottomNavH= _elH(_registry.bottomNav);

    /* Auto-detect by common class names if not registered */
    if (!_dims.bottomNavH) {
      var bn = document.querySelector('.bottom-nav, [id="bottomNav"], .sk-bottom-nav, nav.bottom-nav');
      if (bn && _isVisible(bn)) {
        _dims.bottomNavH = bn.offsetHeight;
        if (!_registry.bottomNav) {
          _registry.bottomNav = bn;
          _applyZIndex('bottom-nav', bn);
        }
      }
    }

    _propagate();
  }

  function _propagate() {
    var root = document.documentElement;
    var sp = 16;  /* --sk-space-4 */

    /* Viewport */
    root.style.setProperty('--sk-viewport-h', _dims.viewportH + 'px');
    root.style.setProperty('--sk-viewport-w', _dims.viewportW + 'px');

    /* Component heights */
    root.style.setProperty('--sk-header-h',     _dims.headerH    + 'px');
    root.style.setProperty('--sk-tab-bar-h',     _dims.tabBarH    + 'px');
    root.style.setProperty('--sk-bottom-nav-h',  _dims.bottomNavH + 'px');

    /* Floating element anchors */
    var fabBottom  = _dims.bottomNavH + _dims.safeBottom + sp;
    var chatBottom = fabBottom + 56 + 8;     /* FAB height + gap */
    var stBottom   = chatBottom + 44 + 8;    /* chat btn height + gap */

    root.style.setProperty('--sk-fab-bottom',    fabBottom  + 'px');
    root.style.setProperty('--sk-fab-right',     (Math.max(_dims.safeRight, 4) + sp) + 'px');
    root.style.setProperty('--sk-chat-bottom',   chatBottom + 'px');
    root.style.setProperty('--sk-scroll-bottom', stBottom   + 'px');

    /* Content padding (so page content isn't obscured by bottom nav) */
    root.style.setProperty('--sk-content-pad-bottom',
      (_dims.bottomNavH + _dims.safeBottom + 8) + 'px');
  }

  function _elH(el) {
    return (el && _isVisible(el)) ? el.offsetHeight : 0;
  }

  function _isVisible(el) {
    return !!(el.offsetParent || el.offsetHeight || el.offsetWidth);
  }

  function _parsePx(val) {
    return parseFloat(val) || 0;
  }

  /* ─────────────────────────────────────────────────────────────────────────
     AUTO-DETECT: Scan DOM for common floating element patterns once per page
  ───────────────────────────────────────────────────────────────────────── */

  function _autoDetect() {
    /* FABs — elements with common class names that have position:fixed */
    var fabSelectors = [
      '.fab', '.floating-btn', '.sk-fab',
      '[class*="-fab"]', '[class*="float-btn"]',
      '.scroll-top-btn', '.chat-widget', '.support-btn',
      '[class*="scroll-top"]', '[class*="chat-btn"]'
    ];
    fabSelectors.forEach(function(sel) {
      try {
        document.querySelectorAll(sel).forEach(function(el) {
          var pos = getComputedStyle(el).position;
          if (pos === 'fixed' || pos === 'sticky') {
            var cls = el.className || '';
            if (/chat|support|whatsapp|messenger|help/i.test(cls)) {
              register('chat-btn', el);
            } else if (/scroll.?top|back.?top|up.?btn/i.test(cls)) {
              register('scroll-top', el);
            } else {
              register('fab', el);
            }
          }
        });
      } catch(e) {}
    });

    /* Shared header injected by shared-header.js */
    var header = document.getElementById('sk-navbar') || document.querySelector('.sk-header, .hub-nav, .ch-nav, .prop-nav, [class*="-nav-bar"]');
    if (header) register('header', header);

    /* Bottom nav */
    var bnav = document.getElementById('bottomNav') || document.querySelector('.bottom-nav, nav.bottom-nav');
    if (bnav) register('bottom-nav', bnav);
  }

  /* ─────────────────────────────────────────────────────────────────────────
     KEYBOARD HANDLING
     On mobile, the virtual keyboard can push content up. Detect and adjust.
  ───────────────────────────────────────────────────────────────────────── */

  function _initKeyboardDetect() {
    if (!('visualViewport' in global)) return;
    var vvp = global.visualViewport;
    var _baseH = vvp.height;

    vvp.addEventListener('resize', function() {
      var diff = _baseH - vvp.height;
      _dims.keyboardH = diff > 100 ? diff : 0;
      document.documentElement.style.setProperty('--sk-keyboard-h', _dims.keyboardH + 'px');
    });
  }

  /* ─────────────────────────────────────────────────────────────────────────
     FAB STACK MANAGER
     Positions multiple FABs so they don't overlap each other.
  ───────────────────────────────────────────────────────────────────────── */

  function _stackFabs() {
    var base = _dims.bottomNavH + _dims.safeBottom + 16;
    var gap  = 8;

    _registry.fabs.forEach(function(fab) {
      if (!_isVisible(fab)) return;
      fab.style.bottom = base + 'px';
      base += (fab.offsetHeight || 56) + gap;
    });

    if (_registry.chatBtn && _isVisible(_registry.chatBtn)) {
      _registry.chatBtn.style.bottom = base + 'px';
      base += (_registry.chatBtn.offsetHeight || 56) + gap;
    }

    if (_registry.scrollTop && _isVisible(_registry.scrollTop)) {
      _registry.scrollTop.style.bottom = base + 'px';
    }
  }

  /* ─────────────────────────────────────────────────────────────────────────
     OVERLAP GUARD
     Periodically check for overlapping fixed elements and report/fix.
  ───────────────────────────────────────────────────────────────────────── */

  function _overlapCheck() {
    var fixed = Array.from(document.querySelectorAll('*')).filter(function(el) {
      return getComputedStyle(el).position === 'fixed' && el.offsetHeight > 0 && el.offsetWidth > 0;
    });

    var overlaps = [];
    for (var i = 0; i < fixed.length; i++) {
      for (var j = i + 1; j < fixed.length; j++) {
        var a = fixed[i].getBoundingClientRect();
        var b = fixed[j].getBoundingClientRect();
        if (a.right > b.left && a.left < b.right && a.bottom > b.top && a.top < b.bottom) {
          /* Skip if one is a child of the other */
          if (!fixed[i].contains(fixed[j]) && !fixed[j].contains(fixed[i])) {
            overlaps.push([fixed[i], fixed[j]]);
          }
        }
      }
    }

    if (overlaps.length && global.SokoniLayout._onOverlap) {
      global.SokoniLayout._onOverlap(overlaps);
    }

    return overlaps;
  }

  /* ─────────────────────────────────────────────────────────────────────────
     BODY SCROLL LOCK (for modals / drawers)
  ───────────────────────────────────────────────────────────────────────── */

  var _scrollLockCount = 0;
  var _scrollY = 0;

  /* This is the CANONICAL scroll lock for the platform — refcounted, so nested overlays
     cannot unlock each other, and iOS-safe (position:fixed + negative top, never
     body{overflow:hidden}, which on iOS Safari offsets fixed tap targets by scrollY and
     can make an overlay's own close button unreachable).

     Both halves used to assign body.style.cssText wholesale. That is destructive: it
     does not set five properties, it REPLACES every inline style on <body>, and unlock
     cleared the lot with cssText = ''. Any inline body style set by anything else — a
     theme, another overlay's lock, a page-level tweak — was silently destroyed by an
     unrelated overlay opening or closing. That made this implementation unsafe to adopt,
     which is part of why twelve other files rolled their own instead.

     Now it touches only the properties it owns, and removes only those on unlock. */
  var _LOCK_PROPS = ['position', 'top', 'left', 'right', 'overflow-y'];

  function lockScroll() {
    _scrollLockCount++;
    if (_scrollLockCount !== 1) return;
    _scrollY = global.scrollY || document.documentElement.scrollTop;
    var s = document.body.style;
    s.setProperty('position', 'fixed');
    s.setProperty('top', '-' + _scrollY + 'px');
    s.setProperty('left', '0');
    s.setProperty('right', '0');
    s.setProperty('overflow-y', 'scroll');
  }

  function unlockScroll() {
    _scrollLockCount = Math.max(0, _scrollLockCount - 1);
    if (_scrollLockCount !== 0) return;
    for (var i = 0; i < _LOCK_PROPS.length; i++) {
      document.body.style.removeProperty(_LOCK_PROPS[i]);
    }
    global.scrollTo(0, _scrollY);
  }

  /* A lock is page state, and a bfcache restore reinstates the DOM with the lock still
     applied but every overlay's JS state gone — the page comes back permanently frozen.
     Safari restores from bfcache on every back-navigation, so this is a routine path,
     not an edge case. Release on restore. */
  global.addEventListener('pageshow', function (e) {
    if (!e.persisted) return;
    if (_scrollLockCount === 0) return;
    _scrollLockCount = 0;
    for (var i = 0; i < _LOCK_PROPS.length; i++) {
      document.body.style.removeProperty(_LOCK_PROPS[i]);
    }
  });

  /* ─────────────────────────────────────────────────────────────────────────
     RESPONSIVE HELPERS
  ───────────────────────────────────────────────────────────────────────── */

  function isMobile()  { return _dims.viewportW < 768; }
  function isTablet()  { return _dims.viewportW >= 768 && _dims.viewportW < 1024; }
  function isDesktop() { return _dims.viewportW >= 1024; }

  var _listeners = [];

  function onBreakpointChange(fn) {
    _listeners.push({ fn: fn, last: _breakpoint() });
  }

  function _breakpoint() {
    var w = _dims.viewportW;
    return w < 480 ? 'xs' : w < 768 ? 'sm' : w < 1024 ? 'md' : w < 1280 ? 'lg' : 'xl';
  }

  function _checkBreakpointListeners() {
    var bp = _breakpoint();
    _listeners.forEach(function(l) {
      if (l.last !== bp) { l.last = bp; l.fn(bp); }
    });
  }

  /* ─────────────────────────────────────────────────────────────────────────
     INITIALIZATION
  ───────────────────────────────────────────────────────────────────────── */

  function init() {
    if (_initialized) return;
    _initialized = true;

    /* Initial measurement */
    _measure();

    /* Auto-detect floating elements after DOM is settled */
    setTimeout(_autoDetect, 100);
    setTimeout(_scheduleUpdate, 150);

    /* Resize observer — reacts to DOM changes */
    if ('ResizeObserver' in global) {
      var ro = new ResizeObserver(function() { _scheduleUpdate(); _checkBreakpointListeners(); });
      ro.observe(document.documentElement);
      if (document.body) ro.observe(document.body);
    }

    /* Fallback: listen to resize and orientation change */
    global.addEventListener('resize', function() { _scheduleUpdate(); _checkBreakpointListeners(); });
    global.addEventListener('orientationchange', _scheduleUpdate);

    /* Keyboard detection */
    _initKeyboardDetect();

    /* Re-stack FABs after measurements settle */
    setTimeout(_stackFabs, 200);

    /* Periodic overlap check in dev mode */
    if (global.location && /localhost|127\.0\.0\.1/.test(global.location.hostname)) {
      setTimeout(function() {
        var overlaps = _overlapCheck();
        if (overlaps.length) {
          console.warn('[SokoniLayout] ' + overlaps.length + ' overlapping fixed element(s) detected. Check z-index hierarchy.');
        }
      }, 1000);
    }
  }

  var _initialized = false;

  /* ─────────────────────────────────────────────────────────────────────────
     PUBLIC API
  ───────────────────────────────────────────────────────────────────────── */

  var SokoniLayout = {
    /* Z-index constants */
    Z: Z,

    /* Registration */
    register:   register,
    unregister: unregister,

    /* Measurements */
    dims:       _dims,
    measure:    _measure,
    stackFabs:  _stackFabs,
    overlapCheck: _overlapCheck,

    /* Scroll management */
    lockScroll:   lockScroll,
    unlockScroll: unlockScroll,

    /* Responsive */
    isMobile:  isMobile,
    isTablet:  isTablet,
    isDesktop: isDesktop,
    onBreakpointChange: onBreakpointChange,

    /* Init */
    init: init,

    /* Override overlap callback */
    _onOverlap: null
  };

  global.SokoniLayout = SokoniLayout;

  /* Auto-init after DOM */
  if (document.readyState !== 'loading') {
    setTimeout(init, 0);
  } else {
    document.addEventListener('DOMContentLoaded', function() { setTimeout(init, 0); }, { once: true });
  }

})(window);
