/**
 * SOKONI UI COMPONENT LIBRARY v1.0
 * ─────────────────────────────────────────────────────────────────────────────
 * Single shared implementation for every common UI primitive on the platform.
 *
 * Replaces:
 *   showNotif()        (cart.js, category.js, wishlist.js, inspiq.js)
 *   showNotification() (script.js, seller.js)
 *   Various spinner / loading screen / modal / toast implementations
 *
 * Exposed on: window.SokoniUI
 * Dependencies: sokoni-tokens.css (for CSS custom properties)
 * Safe to load: before DOM ready (queues operations internally)
 * ─────────────────────────────────────────────────────────────────────────────
 */
(function(global) {
  'use strict';

  /* Suppress noisy debug logs in production without hiding real errors */
  if (typeof window !== 'undefined' &&
      window.location.hostname !== 'localhost' &&
      window.location.hostname !== '127.0.0.1') {
    window.console.log = function() {};
    window.console.debug = function() {};
  }

  /* ─────────────────────────────────────────────────────────────────────────
     INTERNAL HELPERS
  ───────────────────────────────────────────────────────────────────────── */

  function _esc(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /* Strip scripts and inline event handlers from trusted HTML strings.
     Used by openModal to prevent accidental XSS if user data reaches opts.content. */
  function _sanitizeModalHtml(html) {
    if (typeof html !== 'string') return '';
    var t = document.createElement('template');
    t.innerHTML = html;
    t.content.querySelectorAll('script,iframe,object,embed,link').forEach(function(el) { el.remove(); });
    t.content.querySelectorAll('*').forEach(function(el) {
      var removeAttrs = [];
      for (var i = 0; i < el.attributes.length; i++) {
        var a = el.attributes[i];
        if (/^on/i.test(a.name)) removeAttrs.push(a.name);
        if (a.name === 'href' && /^javascript:/i.test(a.value)) removeAttrs.push(a.name);
        if (a.name === 'src'  && /^javascript:/i.test(a.value)) removeAttrs.push(a.name);
      }
      removeAttrs.forEach(function(n) { el.removeAttribute(n); });
    });
    return t.innerHTML;
  }

  function _id(prefix) {
    return prefix + '-' + Math.random().toString(36).slice(2, 9);
  }

  /* Run fn after DOM is ready */
  function _ready(fn) {
    if (document.readyState !== 'loading') { fn(); }
    else { document.addEventListener('DOMContentLoaded', fn, { once: true }); }
  }

  /* Inject styles once */
  function _injectStyles(id, css) {
    if (document.getElementById(id)) return;
    var s = document.createElement('style');
    s.id = id;
    s.textContent = css;
    document.head.appendChild(s);
  }

  /* ─────────────────────────────────────────────────────────────────────────
     TOAST / NOTIFICATION SYSTEM
     Replaces: showNotif(), showNotification() across all files
  ───────────────────────────────────────────────────────────────────────── */

  var _TOAST_CSS = [
    '#sk-toast-root{',
      'position:fixed;',
      'top:max(16px,var(--sk-safe-top,0px));',
      'right:max(16px,var(--sk-safe-right,0px));',
      'z-index:var(--sk-z-toast,800);',
      'display:flex;',
      'flex-direction:column;',
      'gap:8px;',
      'pointer-events:none;',
      'max-width:min(340px,calc(100vw - 32px));',
    '}',
    '.sk-toast{',
      'display:flex;',
      'align-items:flex-start;',
      'gap:10px;',
      'padding:13px 16px;',
      'border-radius:var(--sk-radius-lg,14px);',
      'font-size:13px;',
      'font-weight:700;',
      'line-height:1.4;',
      'color:#fff;',
      'pointer-events:all;',
      'cursor:pointer;',
      'box-shadow:0 4px 24px rgba(0,0,0,0.6);',
      'animation:sk-slide-up var(--sk-duration-enter,300ms) var(--sk-ease-decelerate,ease) both;',
      'transition:opacity var(--sk-duration-exit,200ms) ease, transform var(--sk-duration-exit,200ms) ease;',
    '}',
    '.sk-toast.sk-toast--out{opacity:0;transform:translateX(16px);}',
    '.sk-toast--success{background:linear-gradient(135deg,#1a3a10,#0f2a08);border:1px solid rgba(113,255,0,0.3);}',
    '.sk-toast--error  {background:linear-gradient(135deg,#3a1010,#2a0808);border:1px solid rgba(255,68,68,0.3);}',
    '.sk-toast--warning{background:linear-gradient(135deg,#3a2a00,#2a1e00);border:1px solid rgba(255,149,0,0.3);}',
    '.sk-toast--info   {background:linear-gradient(135deg,#0a1e3a,#08182a);border:1px solid rgba(59,130,246,0.3);}',
    '.sk-toast--neutral{background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.12);}',
    '.sk-toast-icon{font-size:16px;flex-shrink:0;line-height:1.4;}',
    '.sk-toast-body{flex:1;min-width:0;}',
    '.sk-toast-title{display:block;font-weight:900;margin-bottom:2px;}',
    '.sk-toast-msg{display:block;font-weight:600;opacity:0.85;}',
    '@media(max-width:480px){',
      '#sk-toast-root{',
        'top:auto;',
        'bottom:max(calc(var(--sk-bottom-nav-h,0px) + 12px),var(--sk-safe-bottom,0px));',
        'right:12px;left:12px;max-width:none;',
      '}',
      '.sk-toast{font-size:12px;}',
    '}'
  ].join('');

  var _TOAST_ICONS = {
    success: '✅',
    error:   '❌',
    warning: '⚠️',
    info:    'ℹ️',
    neutral: '💬'
  };

  var _toastRoot = null;
  var _toastQueue = [];

  function _ensureToastRoot() {
    if (_toastRoot && document.contains(_toastRoot)) return _toastRoot;
    _injectStyles('sk-toast-styles', _TOAST_CSS);
    _toastRoot = document.getElementById('sk-toast-root');
    if (!_toastRoot) {
      _toastRoot = document.createElement('div');
      _toastRoot.id = 'sk-toast-root';
      document.body.appendChild(_toastRoot);
    }
    return _toastRoot;
  }

  /**
   * Show a toast notification.
   * @param {string} message
   * @param {'success'|'error'|'warning'|'info'|'neutral'} [type='success']
   * @param {object} [opts]
   * @param {string}  [opts.title]      - Bold heading above message
   * @param {number}  [opts.duration]   - Auto-dismiss ms (0 = sticky)
   * @param {string}  [opts.icon]       - Override emoji icon
   */
  function toast(message, type, opts) {
    type = type || 'success';
    opts = opts || {};
    var duration = opts.duration !== undefined ? opts.duration : (type === 'error' ? 5000 : 3500);

    _ready(function() {
      var root = _ensureToastRoot();
      var icon = opts.icon || _TOAST_ICONS[type] || _TOAST_ICONS.neutral;
      var id = _id('sk-t');

      var el = document.createElement('div');
      el.id = id;
      el.className = 'sk-toast sk-toast--' + type;
      el.setAttribute('role', 'alert');
      el.setAttribute('aria-live', 'assertive');
      el.innerHTML =
        '<span class="sk-toast-icon">' + icon + '</span>' +
        '<span class="sk-toast-body">' +
          (opts.title ? '<span class="sk-toast-title">' + _esc(opts.title) + '</span>' : '') +
          '<span class="sk-toast-msg">' + _esc(message) + '</span>' +
        '</span>';

      el.addEventListener('click', function() { _dismissToast(el); });

      root.appendChild(el);

      /* Limit to 4 visible toasts */
      var all = root.querySelectorAll('.sk-toast');
      if (all.length > 4) _dismissToast(all[0]);

      if (duration > 0) {
        setTimeout(function() { _dismissToast(el); }, duration);
      }
    });
  }

  function _dismissToast(el) {
    if (!el || !el.parentNode) return;
    el.classList.add('sk-toast--out');
    setTimeout(function() { if (el.parentNode) el.parentNode.removeChild(el); }, 220);
  }

  /* ─────────────────────────────────────────────────────────────────────────
     MODAL SYSTEM
     Centralized modal management.  At most one modal stack active at a time.
  ───────────────────────────────────────────────────────────────────────── */

  var _MODAL_CSS = [
    '.sk-modal-backdrop{',
      'position:fixed;inset:0;',
      'background:rgba(5,15,5,0.85);',
      'z-index:var(--sk-z-modal-overlay,690);',
      'display:flex;align-items:center;justify-content:center;',
      'padding:16px;',
      'animation:sk-fade-in var(--sk-duration-enter,300ms) ease both;',
    '}',
    '.sk-modal-backdrop.sk-modal--out{animation:sk-fade-out var(--sk-duration-exit,200ms) ease both;}',
    '.sk-modal{',
      'position:relative;',
      'background:var(--sk-bg-raised,#0f200f);',
      'border:1px solid var(--sk-border,rgba(255,255,255,0.08));',
      'border-radius:var(--sk-radius-modal,24px);',
      'padding:28px;',
      'width:100%;',
      'max-width:480px;',
      'max-height:calc(var(--sk-viewport-h,100dvh) - 32px);',
      'overflow-y:auto;',
      '-webkit-overflow-scrolling:touch;',
      'z-index:var(--sk-z-modal,700);',
      'animation:sk-scale-in var(--sk-duration-enter,300ms) var(--sk-ease-spring) both;',
      'box-shadow:0 24px 64px rgba(0,0,0,0.7);',
    '}',
    '.sk-modal--bottom{',
      'position:fixed;',
      'bottom:0;left:0;right:0;',
      'border-radius:var(--sk-radius-modal,24px) var(--sk-radius-modal,24px) 0 0;',
      'max-width:none;',
      'max-height:85vh;',
      'padding-bottom:calc(24px + var(--sk-safe-bottom,0px));',
    '}',
    '.sk-modal-close{',
      'position:absolute;',
      'top:16px;right:16px;',
      'width:32px;height:32px;',
      'border:none;',
      'background:rgba(255,255,255,0.06);',
      'border-radius:50%;',
      'color:rgba(255,255,255,0.6);',
      'font-size:16px;',
      'cursor:pointer;',
      'display:flex;align-items:center;justify-content:center;',
      'transition:background 150ms ease;',
    '}',
    '.sk-modal-close:hover{background:rgba(255,255,255,0.12);}',
    '.sk-modal-title{font-size:20px;font-weight:900;color:#fff;margin:0 0 8px;}',
    '.sk-modal-body{color:rgba(255,255,255,0.7);font-size:14px;line-height:1.6;}',
    '.sk-modal-footer{display:flex;gap:10px;margin-top:24px;}'
  ].join('');

  var _modalStack = [];

  /**
   * Open a modal dialog.
   * @param {object} opts
   * @param {string|HTMLElement} opts.content  - HTML string or element
   * @param {string} [opts.title]
   * @param {boolean} [opts.closeable=true]
   * @param {boolean} [opts.bottom=false]      - Bottom sheet style
   * @param {string}  [opts.id]                - Stable ID for dedup
   * @param {function}[opts.onClose]
   * @returns {function} close function
   */
  function openModal(opts) {
    opts = opts || {};
    if (opts.id && document.getElementById(opts.id)) return function(){};

    _injectStyles('sk-modal-styles', _MODAL_CSS);

    var backdrop = document.createElement('div');
    backdrop.className = 'sk-modal-backdrop';
    if (opts.id) backdrop.id = opts.id;

    var box = document.createElement('div');
    box.className = 'sk-modal' + (opts.bottom ? ' sk-modal--bottom' : '');

    if (opts.closeable !== false) {
      var closeBtn = document.createElement('button');
      closeBtn.className = 'sk-modal-close';
      closeBtn.setAttribute('aria-label', 'Close');
      closeBtn.innerHTML = '✕';
      closeBtn.addEventListener('click', close);
      box.appendChild(closeBtn);
    }

    if (opts.title) {
      var h = document.createElement('h2');
      h.className = 'sk-modal-title';
      h.textContent = opts.title;
      box.appendChild(h);
    }

    if (opts.content) {
      if (opts.content instanceof HTMLElement) {
        box.appendChild(opts.content);
      } else {
        var body = document.createElement('div');
        body.className = 'sk-modal-body';
        body.innerHTML = opts.rawHtml ? opts.content : _sanitizeModalHtml(opts.content);
        box.appendChild(body);
      }
    }

    backdrop.appendChild(box);

    if (opts.closeable !== false) {
      backdrop.addEventListener('click', function(e) {
        if (e.target === backdrop) close();
      });
    }

    document.addEventListener('keydown', _onEsc);
    document.body.style.overflow = 'hidden';
    document.body.appendChild(backdrop);
    _modalStack.push({ backdrop: backdrop, close: close, onClose: opts.onClose });

    function close() {
      backdrop.classList.add('sk-modal--out');
      document.removeEventListener('keydown', _onEsc);
      setTimeout(function() {
        if (backdrop.parentNode) backdrop.parentNode.removeChild(backdrop);
        _modalStack = _modalStack.filter(function(m) { return m.backdrop !== backdrop; });
        if (!_modalStack.length) document.body.style.overflow = '';
      }, 210);
      if (typeof opts.onClose === 'function') opts.onClose();
    }

    return close;
  }

  function _onEsc(e) {
    if (e.key === 'Escape' && _modalStack.length) {
      _modalStack[_modalStack.length - 1].close();
    }
  }

  /** Close the topmost open modal */
  function closeModal() {
    if (_modalStack.length) _modalStack[_modalStack.length - 1].close();
  }

  /**
   * Open a confirmation dialog.
   * @param {object} opts
   * @param {string} opts.title
   * @param {string} opts.message
   * @param {string} [opts.confirmText='Confirm']
   * @param {string} [opts.cancelText='Cancel']
   * @param {'danger'|'success'|'neutral'} [opts.variant='danger']
   * @returns {Promise<boolean>}
   */
  function confirm(opts) {
    return new Promise(function(resolve) {
      var variant = opts.variant || 'danger';
      var btnColor = variant === 'danger'   ? 'linear-gradient(135deg,#c01,#900)' :
                     variant === 'success'  ? 'linear-gradient(135deg,#71ff00,#4fc800)' :
                     'rgba(255,255,255,0.1)';
      var btnTextColor = variant === 'success' ? '#050f05' : '#fff';
      var content = [
        '<p class="sk-modal-body" style="margin:0 0 24px">' + _esc(opts.message || '') + '</p>',
        '<div class="sk-modal-footer" style="justify-content:flex-end">',
          '<button id="sk-confirm-cancel" style="flex:1;padding:13px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.12);border-radius:12px;color:rgba(255,255,255,0.75);font-weight:800;font-size:14px;cursor:pointer;">' + _esc(opts.cancelText || 'Cancel') + '</button>',
          '<button id="sk-confirm-ok"     style="flex:1;padding:13px;background:' + btnColor + ';border:none;border-radius:12px;color:' + btnTextColor + ';font-weight:900;font-size:14px;cursor:pointer;">' + _esc(opts.confirmText || 'Confirm') + '</button>',
        '</div>'
      ].join('');
      var close = openModal({ title: opts.title, content: content, closeable: true, onClose: function() { resolve(false); } });
      _ready(function() {
        var ok  = document.getElementById('sk-confirm-ok');
        var can = document.getElementById('sk-confirm-cancel');
        if (ok)  ok.addEventListener('click',  function() { close(); resolve(true);  });
        if (can) can.addEventListener('click', function() { close(); resolve(false); });
      });
    });
  }

  /* ─────────────────────────────────────────────────────────────────────────
     LOADING OVERLAY SYSTEM
     Standardised spinner + loading screen. Replaces all page-specific loaders.
  ───────────────────────────────────────────────────────────────────────── */

  var _SPINNER_CSS = [
    '.sk-spinner{',
      'display:inline-block;',
      'width:22px;height:22px;',
      'border:2.5px solid rgba(113,255,0,0.2);',
      'border-top-color:#71ff00;',
      'border-radius:50%;',
      'animation:sk-spin 0.7s linear infinite;',
      'flex-shrink:0;',
    '}',
    '.sk-spinner--sm{width:16px;height:16px;border-width:2px;}',
    '.sk-spinner--lg{width:32px;height:32px;border-width:3px;}',
    '.sk-spinner--xl{width:48px;height:48px;border-width:4px;}',
    '#sk-page-loader{',
      'position:fixed;inset:0;',
      'background:var(--sk-bg-base,#050f05);',
      'z-index:var(--sk-z-splash,900);',
      'display:flex;flex-direction:column;',
      'align-items:center;justify-content:center;',
      'gap:16px;',
      'transition:opacity var(--sk-duration-slow,400ms) ease;',
    '}',
    '#sk-page-loader.sk-loader--out{opacity:0;pointer-events:none;}',
    '#sk-page-loader-label{color:rgba(255,255,255,0.5);font-size:13px;font-weight:600;}'
  ].join('');

  var _pageLoader = null;
  var _loaderRef = 0;

  /** Show a small inline spinner element */
  function spinner(size) {
    _injectStyles('sk-spinner-styles', _SPINNER_CSS);
    var el = document.createElement('span');
    el.className = 'sk-spinner' + (size ? ' sk-spinner--' + size : '');
    el.setAttribute('role', 'status');
    el.setAttribute('aria-label', 'Loading');
    return el;
  }

  /** Show full-page loader */
  function showPageLoader(label) {
    _injectStyles('sk-spinner-styles', _SPINNER_CSS);
    _loaderRef++;
    _ready(function() {
      if (!_pageLoader) {
        _pageLoader = document.createElement('div');
        _pageLoader.id = 'sk-page-loader';
        _pageLoader.innerHTML =
          '<div class="sk-spinner sk-spinner--xl"></div>' +
          '<span id="sk-page-loader-label">' + _esc(label || 'Loading…') + '</span>';
        document.body.appendChild(_pageLoader);
      }
      _pageLoader.style.opacity = '';
      _pageLoader.classList.remove('sk-loader--out');
      var lbl = document.getElementById('sk-page-loader-label');
      if (lbl && label) lbl.textContent = label;
    });
  }

  /** Hide full-page loader */
  function hidePageLoader() {
    _loaderRef = Math.max(0, _loaderRef - 1);
    if (_loaderRef > 0) return;
    _ready(function() {
      if (!_pageLoader) {
        _pageLoader = document.getElementById('sk-page-loader');
      }
      if (_pageLoader) {
        _pageLoader.classList.add('sk-loader--out');
        setTimeout(function() {
          if (_pageLoader && _pageLoader.parentNode) {
            _pageLoader.parentNode.removeChild(_pageLoader);
            _pageLoader = null;
          }
        }, 420);
      }
    });
  }

  /* ─────────────────────────────────────────────────────────────────────────
     SKELETON LOADERS
  ───────────────────────────────────────────────────────────────────────── */

  /**
   * Build a skeleton loader element.
   * @param {'card'|'list'|'text'|'circle'} [shape='card']
   * @param {object} [opts]  - width, height, radius
   */
  function skeletonEl(shape, opts) {
    opts = opts || {};
    var el = document.createElement('div');
    el.className = 'sk-skeleton';
    if (shape === 'circle') {
      var sz = opts.size || '48px';
      el.style.cssText = 'width:' + sz + ';height:' + sz + ';border-radius:50%;';
    } else if (shape === 'text') {
      el.style.cssText = 'width:' + (opts.width || '100%') + ';height:' + (opts.height || '14px') + ';';
    } else if (shape === 'card') {
      el.style.cssText = 'width:100%;height:' + (opts.height || '180px') + ';border-radius:16px;';
    } else {
      el.style.cssText = 'width:100%;height:' + (opts.height || '64px') + ';';
    }
    return el;
  }

  /**
   * Insert skeleton placeholders into a container, remove when done.
   * @param {HTMLElement} container
   * @param {number} [count=3]
   * @param {'card'|'list'} [layout='list']
   * @returns {function} remove function
   */
  function showSkeletons(container, count, layout) {
    if (!container) return function(){};
    count = count || 3;
    layout = layout || 'list';
    var frags = [];
    for (var i = 0; i < count; i++) {
      var el = skeletonEl(layout === 'card' ? 'card' : 'list');
      el.style.marginBottom = '10px';
      container.appendChild(el);
      frags.push(el);
    }
    return function() { frags.forEach(function(f) { if (f.parentNode) f.parentNode.removeChild(f); }); };
  }

  /* ─────────────────────────────────────────────────────────────────────────
     EMPTY / ERROR / OFFLINE STATES
  ───────────────────────────────────────────────────────────────────────── */

  var _STATE_CSS = [
    '.sk-state{',
      'display:flex;flex-direction:column;',
      'align-items:center;justify-content:center;',
      'text-align:center;',
      'padding:48px 24px;',
      'min-height:200px;',
    '}',
    '.sk-state-icon{font-size:52px;margin-bottom:16px;line-height:1;}',
    '.sk-state-title{font-size:18px;font-weight:900;color:#fff;margin-bottom:8px;}',
    '.sk-state-msg{font-size:14px;color:rgba(255,255,255,0.5);line-height:1.5;margin-bottom:24px;max-width:300px;}',
    '.sk-state-btn{',
      'padding:13px 28px;',
      'background:linear-gradient(135deg,#71ff00,#4fc800);',
      'color:#050f05;',
      'font-weight:900;',
      'font-size:14px;',
      'border:none;',
      'border-radius:14px;',
      'cursor:pointer;',
      'transition:opacity 150ms ease;',
    '}',
    '.sk-state-btn:hover{opacity:0.9;}',
    '.sk-state-btn--ghost{',
      'background:rgba(255,255,255,0.06);',
      'border:1px solid rgba(255,255,255,0.12);',
      'color:rgba(255,255,255,0.75);',
    '}'
  ].join('');

  /**
   * Render an empty / error / offline state into a container.
   * @param {HTMLElement} container
   * @param {object} opts
   * @param {string} opts.icon
   * @param {string} opts.title
   * @param {string} opts.message
   * @param {string} [opts.buttonText]
   * @param {function} [opts.onAction]
   * @param {'ghost'|'primary'} [opts.buttonVariant='primary']
   */
  function renderState(container, opts) {
    if (!container) return;
    _injectStyles('sk-state-styles', _STATE_CSS);
    opts = opts || {};
    container.innerHTML = '';
    var wrap = document.createElement('div');
    wrap.className = 'sk-state';
    var html = '';
    if (opts.icon)    html += '<div class="sk-state-icon">' + _esc(opts.icon) + '</div>';
    if (opts.title)   html += '<div class="sk-state-title">' + _esc(opts.title) + '</div>';
    if (opts.message) html += '<p class="sk-state-msg">' + _esc(opts.message) + '</p>';
    if (opts.buttonText) {
      html += '<button class="sk-state-btn' + (opts.buttonVariant === 'ghost' ? ' sk-state-btn--ghost' : '') + '">' + _esc(opts.buttonText) + '</button>';
    }
    wrap.innerHTML = html;
    if (opts.onAction && opts.buttonText) {
      var btn = wrap.querySelector('.sk-state-btn');
      if (btn) btn.addEventListener('click', opts.onAction);
    }
    container.appendChild(wrap);
  }

  function renderEmpty(container, message) {
    renderState(container, { icon: '📭', title: 'Nothing here yet', message: message || 'Check back soon.' });
  }

  function renderError(container, message, onRetry) {
    renderState(container, {
      icon: '⚠️',
      title: 'Something went wrong',
      message: message || 'An error occurred. Please try again.',
      buttonText: onRetry ? 'Try Again' : null,
      onAction: onRetry
    });
  }

  function renderOffline(container, onRetry) {
    renderState(container, {
      icon: '📡',
      title: 'You\'re offline',
      message: 'Check your connection and try again.',
      buttonText: 'Retry',
      onAction: onRetry || function() { location.reload(); }
    });
  }

  /* ─────────────────────────────────────────────────────────────────────────
     OFFLINE INDICATOR
     Shows/hides a top banner when network connectivity changes.
  ───────────────────────────────────────────────────────────────────────── */

  var _OFFLINE_CSS = [
    '#sk-offline-bar{',
      'position:fixed;',
      /* Sit directly below the fixed nav; --sk-header-h is written by
         sokoni-layout.js once the nav is measured. Falls back to 64px. */
      'top:var(--sk-header-h,64px);left:0;right:0;',
      'display:flex;align-items:center;justify-content:center;gap:10px;',
      'background:linear-gradient(180deg,rgba(26,10,0,0.98),rgba(18,7,0,0.96));',
      '-webkit-backdrop-filter:blur(14px);backdrop-filter:blur(14px);',
      'border-bottom:1px solid rgba(255,149,0,0.22);',
      'box-shadow:0 8px 28px rgba(0,0,0,0.5);',
      'color:#ffb454;',
      'font-size:13px;',
      'font-weight:700;',
      'letter-spacing:0.01em;',
      'text-align:center;',
      'padding:10px 46px 10px 16px;',
      'z-index:999;',
      'transform:translateY(-100%);',
      'transition:transform 0.42s cubic-bezier(0.22,1,0.36,1),opacity 0.3s ease,visibility 0.3s;',
      'will-change:transform,opacity;',
      /* HIDING WITH transform ALONE WAS NEVER ENOUGH.
         The bar is positioned at top:var(--sk-header-h,64px) and hidden with
         translateY(-100%), which lifts it only by its OWN height (55px). Sitting
         64px down, that leaves it at top:9px — still on screen, still readable.
         Measured live with the "hidden" transform applied and no visible class:
         top 9px (WebKit), 55px (Chromium). It was never actually hidden.
         opacity + visibility do not depend on the offset, so the bar is genuinely
         gone unless it is deliberately shown. */
      'opacity:0;visibility:hidden;pointer-events:none;',
    '}',
    '#sk-offline-bar.sk-offline--visible{',
      'transform:translateY(0);opacity:1;visibility:visible;pointer-events:auto;',
    '}',
    '#sk-offline-bar .sk-off-dot{',
      'width:8px;height:8px;border-radius:50%;background:#ff9500;flex-shrink:0;',
      'box-shadow:0 0 0 0 rgba(255,149,0,0.5);animation:skOffPulse 1.6s ease-out infinite;',
    '}',
    '@keyframes skOffPulse{',
      '0%{box-shadow:0 0 0 0 rgba(255,149,0,0.5);}',
      '70%{box-shadow:0 0 0 7px rgba(255,149,0,0);}',
      '100%{box-shadow:0 0 0 0 rgba(255,149,0,0);}',
    '}',
    '#sk-offline-bar .sk-off-x{',
      'position:absolute;right:8px;top:50%;transform:translateY(-50%);',
      'background:none;border:none;color:inherit;font-size:18px;line-height:1;',
      'cursor:pointer;padding:5px 9px;border-radius:9px;opacity:.6;flex-shrink:0;',
      'transition:opacity .15s ease,background .15s ease;',
    '}',
    '#sk-offline-bar .sk-off-x:hover{opacity:1;background:rgba(255,149,0,0.14);}',
    '@media (prefers-reduced-motion: reduce){',
      '#sk-offline-bar{transition:none;}',
      '#sk-offline-bar .sk-off-dot{animation:none;}',
    '}'
  ].join('');

  function _initOfflineBar() {
    if (document.getElementById('sk-offline-bar')) return; /* already initialised — avoid duplicate bars/probe loops */
    _injectStyles('sk-offline-styles', _OFFLINE_CSS);
    var bar = document.createElement('div');
    bar.id = 'sk-offline-bar';
    bar.setAttribute('role', 'status');
    bar.setAttribute('aria-live', 'polite');
    bar.innerHTML =
      '<span class="sk-off-dot" aria-hidden="true"></span>'
      + '<span>📡 No internet connection — some features may not work</span>'
      + '<button type="button" class="sk-off-x" aria-label="Dismiss">×</button>';
    document.body.insertBefore(bar, document.body.firstChild);

    /* ── State ─────────────────────────────────────────── */
    var _failures   = 0;          /* consecutive probe failures  */
    var _showing    = false;      /* is bar currently visible?   */
    var _probing    = false;      /* probe fetch in-flight?       */
    var _probeTimer = null;       /* handle for next scheduled probe */
    var _dismissed  = false;      /* user tapped ×; stay hidden until reconnect */
    var _bootTime   = Date.now(); /* used to suppress false positives during SW install */
    var _GRACE_MS   = 10000;     /* Must cover: first probe delay (3 s) + probe timeout
                                    (4 s) + buffer (3 s) = 10 s total. Without this the
                                    probe times out at ~7 s, after the old 4 s grace, and
                                    the banner fires falsely on PWA cold-start / slow nets. */

    /* ── Probe ─────────────────────────────────────────────────────────────
       Active connectivity check — the SOURCE OF TRUTH. We deliberately do NOT
       trust `navigator.onLine === false` on its own: some Android/iOS webviews
       and installed PWAs report offline while the network is actually up, which
       used to leave this banner stuck on-screen with working internet. The probe
       always runs so recovery is guaranteed.
       Signal: no-cors GET https://www.gstatic.com/generate_204 (SW never caches it,
       so it fails iff the network is truly down). If gstatic itself is unreachable
       (e.g. a corporate firewall), fall back to navigator.onLine rather than an
       own-origin request the service worker would serve from cache offline. */
    function _doProbe() {
      var c1 = new AbortController();
      var t1 = setTimeout(function() { c1.abort(); }, 4000);
      return fetch('https://www.gstatic.com/generate_204', {
        mode: 'no-cors', cache: 'no-store', signal: c1.signal,
      }).then(function(r) {
        clearTimeout(t1);
        /* Defense-in-depth: a real no-cors network response always has
           r.type === 'opaque'. A SW-synthesised fallback response has
           r.type === 'default' (status 503). Checking the type means a
           synthetic response cannot be mistaken for genuine connectivity
           even if the SKIP_CACHE_PATTERNS bypass is ever removed.
           Note: opaque responses always have r.ok === false (status 0),
           so we cannot use r.ok alone here. */
        return r.type === 'opaque' || r.ok;
      }).catch(function() {
        clearTimeout(t1);
        /* gstatic unreachable. We deliberately do NOT fall back to an own-origin
           request (e.g. /manifest.json): the service worker serves those from
           cache even when offline, which would falsely report "online" and leave
           the banner stuck. Instead trust navigator.onLine here — false means
           genuinely offline; true means gstatic is likely firewall-blocked but the
           network is up. */
        return (typeof navigator !== 'undefined' && navigator.onLine === true);
      });
    }

    function _scheduleProbe(delayMs) {
      clearTimeout(_probeTimer);
      _probeTimer = setTimeout(_probe, delayMs);
    }

    function _probe() {
      if (_probing) return;
      _probing = true;
      _doProbe()
        .then(function(online) {
          _probing = false;
          if (online) {
            _failures = 0;
            _dismissed = false;       /* reconnected → allow a future offline to show again */
            _setBar(false);           /* slide up behind the header */
            _scheduleProbe(30000);    /* relaxed poll while connected */
          } else {
            _failures += 1;
            /* If the browser also reports offline, one failed probe is enough
               (fast, high-confidence). Otherwise require two to avoid flicker. */
            var browserOffline = (typeof navigator !== 'undefined' && navigator.onLine === false);
            if ((browserOffline && _failures >= 1) || _failures >= 2) _setBar(true);
            _scheduleProbe(8000);     /* faster poll while disconnected */
          }
        })
        .catch(function() { _probing = false; _scheduleProbe(12000); });
    }

    function _setBar(visible) {
      if (visible && _dismissed) return;                         /* user dismissed — stay hidden */
      /* Suppress banner during grace period — avoids SW-install false positives on mobile */
      if (visible && (Date.now() - _bootTime) < _GRACE_MS) return;
      if (_showing === visible) return;
      _showing = visible;
      bar.classList.toggle('sk-offline--visible', visible);
      /* Sync the SW status dot (managed by sw-register.js) */
      var dot = document.getElementById('sokoniOnlineDot');
      if (dot) {
        dot.style.background = visible ? '#ff4444' : '#71ff00';
        dot.title = visible ? 'Offline — some features unavailable' : 'Online';
      }
      /* Remove any duplicate banner left by older sw-register.js code */
      var legacy = document.getElementById('sokoniOfflineBanner');
      if (legacy) legacy.remove();
      /* When going online: cross-clear the secondary banner managed by
         sokoni-offline.js (#sk-offline-banner). That module defers to
         #sk-offline-bar when we exist, but may have shown its banner
         during the brief window before this element was created. */
      if (!visible) {
        var altBanner = document.getElementById('sk-offline-banner');
        if (altBanner) altBanner.style.transform = 'translateY(-100%)';
        if (window.SokoniOffline && typeof window.SokoniOffline.hide === 'function') {
          window.SokoniOffline.hide();
        }
      }
    }

    /* ── Dismiss (×) — actually works now ──────────────────────────────────
       The old inline handler just removed the class, so the probe loop re-added
       it seconds later ("× does nothing"). Setting a flag keeps it hidden until
       the network genuinely drops and recovers again. */
    var _xBtn = bar.querySelector('.sk-off-x');
    if (_xBtn) _xBtn.addEventListener('click', function () {
      _dismissed = true;
      _setBar(false);
    });

    /* Reconnect → hide INSTANTLY. Don't wait on the async probe; the browser
       just told us the network is back, so slide the bar up immediately, then
       verify in the background. */
    global.addEventListener('online',  function() {
      _failures = 0; _dismissed = false; _setBar(false); _probe();
    });
    global.addEventListener('offline', function() { setTimeout(_probe, 1200); });

    /* Recover after the tab/app regains focus — mobile devices that sleep offline
       and wake online frequently never fire the `online` event. */
    global.addEventListener('pageshow', _probe);
    document.addEventListener('visibilitychange', function() {
      if (document.hidden) return;
      if (typeof navigator !== 'undefined' && navigator.onLine) _setBar(false);
      _probe();
    });

    /* First probe shortly after boot. 3 s gives the SW time to claim the page
       (install + activate typically complete in < 2 s) while avoiding the
       8 s false-offline window the previous value caused on mobile. */
    setTimeout(_probe, 3000);
  }

  /* ─────────────────────────────────────────────────────────────────────────
     BUTTON FACTORY
     Produce consistently styled buttons without inline styles.
  ───────────────────────────────────────────────────────────────────────── */

  var _BTN_CSS = [
    '.sk-btn{',
      'display:inline-flex;align-items:center;justify-content:center;gap:8px;',
      'height:var(--sk-btn-h,48px);',
      'padding:0 24px;',
      'border:none;',
      'border-radius:var(--sk-btn-radius,14px);',
      'font-size:var(--sk-btn-font,15px);',
      'font-weight:var(--sk-btn-font-weight,700);',
      'cursor:pointer;',
      'white-space:nowrap;',
      'transition:opacity var(--sk-duration-fast,150ms) ease, transform var(--sk-duration-fast,150ms) ease;',
      'user-select:none;',
      '-webkit-tap-highlight-color:transparent;',
    '}',
    '.sk-btn:active{transform:scale(0.97);}',
    '.sk-btn:disabled{opacity:0.4;cursor:not-allowed;pointer-events:none;}',
    '.sk-btn--primary{background:linear-gradient(135deg,#71ff00,#4fc800);color:#050f05;}',
    '.sk-btn--primary:hover{opacity:0.9;}',
    '.sk-btn--danger {background:linear-gradient(135deg,#c01,#900);color:#fff;}',
    '.sk-btn--ghost  {background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.12);color:rgba(255,255,255,0.75);}',
    '.sk-btn--ghost:hover{background:rgba(255,255,255,0.10);}',
    '.sk-btn--outline{background:transparent;border:1.5px solid rgba(113,255,0,0.4);color:#71ff00;}',
    '.sk-btn--outline:hover{background:rgba(113,255,0,0.08);}',
    '.sk-btn--sm{height:var(--sk-btn-h-sm,36px);padding:0 16px;font-size:13px;}',
    '.sk-btn--lg{height:var(--sk-btn-h-lg,56px);padding:0 32px;font-size:16px;}',
    '.sk-btn--full{width:100%;}'
  ].join('');

  /**
   * Create a styled button element.
   * @param {object} opts
   * @param {string} opts.text
   * @param {'primary'|'danger'|'ghost'|'outline'} [opts.variant='primary']
   * @param {'sm'|'md'|'lg'} [opts.size]
   * @param {boolean} [opts.full]
   * @param {string}  [opts.icon]
   * @param {function} [opts.onClick]
   * @param {boolean}  [opts.disabled]
   */
  function btn(opts) {
    _injectStyles('sk-btn-styles', _BTN_CSS);
    opts = opts || {};
    var el = document.createElement('button');
    var cls = 'sk-btn sk-btn--' + (opts.variant || 'primary');
    if (opts.size && opts.size !== 'md') cls += ' sk-btn--' + opts.size;
    if (opts.full) cls += ' sk-btn--full';
    el.className = cls;
    if (opts.icon) el.innerHTML = '<span>' + opts.icon + '</span>';
    el.appendChild(document.createTextNode(opts.text || ''));
    if (opts.disabled) el.disabled = true;
    if (typeof opts.onClick === 'function') el.addEventListener('click', opts.onClick);
    return el;
  }

  /* ─────────────────────────────────────────────────────────────────────────
     BACKWARD COMPATIBILITY ADAPTERS
     Existing code calling showNotif() or showNotification() continues to work.
     Gradual migration path: pages that import sokoni-ui.js get the shared
     implementation automatically; their own local definitions are shadowed.
  ───────────────────────────────────────────────────────────────────────── */

  function _compat() {
    /* showNotif(msg, type) — used by cart.js, category.js, wishlist.js, inspiq.js */
    if (!global.showNotif) {
      global.showNotif = function(msg, type) { toast(msg, type === 'error' ? 'error' : 'success'); };
    }
    /* showNotification(msg, type) — used by script.js, seller.js */
    if (!global.showNotification) {
      global.showNotification = function(msg, type) { toast(msg, type === 'error' ? 'error' : type === 'warning' ? 'warning' : 'success'); };
    }
  }

  /* ─────────────────────────────────────────────────────────────────────────
     PUBLIC API
  ───────────────────────────────────────────────────────────────────────── */

  var SokoniUI = {
    /* Core primitives */
    toast:          toast,
    openModal:      openModal,
    closeModal:     closeModal,
    confirm:        confirm,

    /* Loading states */
    spinner:        spinner,
    showPageLoader: showPageLoader,
    hidePageLoader: hidePageLoader,
    showSkeletons:  showSkeletons,
    skeletonEl:     skeletonEl,

    /* Empty / error / offline states */
    renderState:    renderState,
    renderEmpty:    renderEmpty,
    renderError:    renderError,
    renderOffline:  renderOffline,

    /* Components */
    btn:            btn,

    /* Utilities */
    esc:            _esc,
    id:             _id,

    /* Init (called by sokoni-bootstrap.js) */
    init: function() {
      _ready(function() {
        _injectStyles('sk-toast-styles', _TOAST_CSS);
        _injectStyles('sk-spinner-styles', _SPINNER_CSS);
        _initOfflineBar();
        _compat();
      });
    }
  };

  /* Expose */
  global.SokoniUI = SokoniUI;

  /* Auto-init if bootstrap not present */
  if (!global.SokoniBootstrap) {
    SokoniUI.init();
  }

})(window);

/* ══════════════════════════════════════════════════════════
   SOKONI THEME — Dark / Light / Auto
   Persists to localStorage('sokoni-theme').
   Applies .light-mode / .dark-mode on document.body.
   style.css already has full .light-mode override rules.
══════════════════════════════════════════════════════════ */
(function(global) {
  'use strict';

  var KEY   = 'sokoni-theme';
  var MODES = ['dark', 'light', 'auto'];

  function _icon(mode) {
    if (mode === 'light') return '☀️';
    if (mode === 'auto')  return '⚙️';
    return '🌙';
  }

  function _label(mode) {
    if (mode === 'dark')  return 'Switch to light mode';
    if (mode === 'light') return 'Switch to auto (system) mode';
    return 'Switch to dark mode';
  }

  function _resolved(mode) {
    if (mode !== 'auto') return mode;
    try { return global.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'; }
    catch (_) { return 'dark'; }
  }

  function _apply(mode) {
    var r = _resolved(mode);
    document.body.classList.toggle('light-mode', r === 'light');
    document.body.classList.toggle('dark-mode',  r === 'dark');
    document.documentElement.setAttribute('data-theme', r);
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = r === 'light' ? '#f0f0f0' : '#080808';
    var iconEl = document.getElementById('sk-theme-icon');
    if (iconEl) iconEl.textContent = _icon(mode);
    var btn = document.getElementById('sk-theme-btn');
    if (btn) btn.setAttribute('title', _label(mode));
  }

  function init() {
    var saved = localStorage.getItem(KEY) || 'dark';
    _apply(saved);
    try {
      global.matchMedia('(prefers-color-scheme: light)').addEventListener('change', function() {
        if (localStorage.getItem(KEY) === 'auto') _apply('auto');
      });
    } catch (_) {}
  }

  function setTheme(mode) {
    if (MODES.indexOf(mode) === -1) return;
    localStorage.setItem(KEY, mode);
    _apply(mode);
  }

  function toggle() {
    var cur  = localStorage.getItem(KEY) || 'dark';
    var next = MODES[(MODES.indexOf(cur) + 1) % MODES.length];
    setTheme(next);
    return next;
  }

  function getTheme() { return localStorage.getItem(KEY) || 'dark'; }

  var SokoniTheme = { init: init, setTheme: setTheme, toggle: toggle, getTheme: getTheme };
  global.SokoniTheme = SokoniTheme;

  /* Apply immediately (before DOMContentLoaded) to avoid flash of wrong theme */
  var _t = localStorage.getItem(KEY) || 'dark';
  var _r = (_t === 'auto' && global.matchMedia)
    ? (global.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')
    : _t;
  if (document.body) {
    document.body.classList.toggle('light-mode', _r === 'light');
    document.body.classList.toggle('dark-mode',  _r === 'dark');
  } else {
    document.addEventListener('DOMContentLoaded', function() {
      document.body.classList.toggle('light-mode', _r === 'light');
      document.body.classList.toggle('dark-mode',  _r === 'dark');
    });
  }

  /* Full init (media query listener + icon sync) — works on all pages including EXCLUDED ones */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function() { SokoniTheme.init(); }, { once: true });
  } else {
    /* Already loaded (deferred script) — call init after a microtask so DOM icon elements exist */
    setTimeout(function() { SokoniTheme.init(); }, 0);
  }

})(window);
