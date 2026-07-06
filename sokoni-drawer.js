/* =============================================================
   SOKONI Universal Drawer Manager v2.0
   API:
     SokoniDrawer.open(id, title?, opts?)
     SokoniDrawer.close(id)
     SokoniDrawer.closeAll()
   Handles:
     - Body scroll lock (iOS-safe position:fixed strategy)
     - Shared backdrop with click-to-close
     - ESC key to close topmost drawer
     - Swipe-right gesture to dismiss (touch)
     - Focus trap + focus restore
     - FAB clearance when a drawer is open
   ============================================================= */
(function (root) {
  'use strict';

  var _stack       = [];    /* open drawer IDs, LIFO */
  var _savedScroll = 0;     /* window.scrollY saved before lock */
  var _focusBefore = null;  /* element focused before any drawer opened */
  var _backdrop    = null;  /* shared backdrop element (lazy-created) */

  /* Swipe tracking */
  var _tx0 = 0, _ty0 = 0;

  /* ── Shared backdrop ────────────────────────────────────── */
  function _bd() {
    if (!_backdrop) {
      _backdrop = document.getElementById('sk-drawer-backdrop');
      if (!_backdrop) {
        _backdrop = document.createElement('div');
        _backdrop.id = 'sk-drawer-backdrop';
        document.body.appendChild(_backdrop);
      }
      _backdrop.addEventListener('click', closeAll);
    }
    return _backdrop;
  }

  /* ── Body scroll lock ───────────────────────────────────── */
  function _lockScroll() {
    if (document.body.classList.contains('sk-body-locked')) return;
    _savedScroll = window.scrollY;
    document.body.style.top = '-' + _savedScroll + 'px';
    document.body.classList.add('sk-body-locked');
  }

  function _unlockScroll() {
    if (!document.body.classList.contains('sk-body-locked')) return;
    document.body.classList.remove('sk-body-locked');
    document.body.style.top = '';
    window.scrollTo(0, _savedScroll);
  }

  /* ── Swipe-right to close ───────────────────────────────── */
  function _onTouchStart(e) {
    _tx0 = e.touches[0].clientX;
    _ty0 = e.touches[0].clientY;
  }

  function _onTouchEnd(e) {
    var dx = e.changedTouches[0].clientX - _tx0;
    var dy = e.changedTouches[0].clientY - _ty0;
    /* Accept as swipe-right: ≥ 80px horizontal, mostly horizontal */
    if (dx >= 80 && Math.abs(dy) < 60) {
      close(e.currentTarget.id);
    }
  }

  /* ── Focus trap ─────────────────────────────────────────── */
  var FOCUSABLE_SEL = [
    'a[href]', 'button:not([disabled])', 'input:not([disabled])',
    'select:not([disabled])', 'textarea:not([disabled])',
    '[tabindex]:not([tabindex="-1"])'
  ].join(',');

  function _trapFocus(drawer) {
    function handler(e) {
      if (e.key !== 'Tab') return;
      var els = Array.from(drawer.querySelectorAll(FOCUSABLE_SEL)).filter(function (el) {
        return !el.closest('[aria-hidden="true"]') && el.offsetParent !== null;
      });
      if (els.length < 2) return;
      var first = els[0], last = els[els.length - 1];
      if (e.shiftKey) {
        if (document.activeElement === first) { e.preventDefault(); last.focus(); }
      } else {
        if (document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    }
    drawer._skTrap = handler;
    drawer.addEventListener('keydown', handler);
  }

  function _removeTrap(drawer) {
    if (drawer._skTrap) {
      drawer.removeEventListener('keydown', drawer._skTrap);
      delete drawer._skTrap;
    }
  }

  /* ── Open ───────────────────────────────────────────────── */
  function open(id, title, opts) {
    var drawer = typeof id === 'string' ? document.getElementById(id) : id;
    if (!drawer) return;
    opts = opts || {};

    /* Update title if given */
    if (title) {
      var titleEl = drawer.querySelector('.sk-drawer-title');
      if (titleEl) titleEl.textContent = title;
    }

    /* Wire header buttons (idempotent) */
    drawer.querySelectorAll('.sk-drawer-back').forEach(function (btn) {
      btn.onclick = function () { close(drawer.id); };
    });
    drawer.querySelectorAll('.sk-drawer-close').forEach(function (btn) {
      btn.onclick = closeAll;
    });

    /* Save pre-open focus only for first drawer */
    if (!_stack.length) {
      _focusBefore = document.activeElement;
      _lockScroll();
    }

    /* Backdrop */
    _bd().classList.add('is-active');
    document.body.classList.add('sk-drawer-active');

    /* Track */
    if (_stack.indexOf(drawer.id) === -1) _stack.push(drawer.id);

    /* Swipe */
    drawer.addEventListener('touchstart', _onTouchStart, { passive: true });
    drawer.addEventListener('touchend',   _onTouchEnd,   { passive: true });

    /* Open */
    drawer.classList.add('is-open');
    drawer.setAttribute('aria-hidden', 'false');
    _trapFocus(drawer);

    /* Focus first interactive element after animation starts */
    requestAnimationFrame(function () {
      var first = drawer.querySelector('.sk-drawer-back, .sk-drawer-close, [tabindex]');
      if (first) first.focus();
    });
  }

  /* ── Close one ──────────────────────────────────────────── */
  function close(id) {
    var drawer = typeof id === 'string' ? document.getElementById(id) : id;
    if (!drawer) return;

    drawer.classList.remove('is-open');
    drawer.setAttribute('aria-hidden', 'true');
    drawer.removeEventListener('touchstart', _onTouchStart);
    drawer.removeEventListener('touchend',   _onTouchEnd);
    _removeTrap(drawer);

    var idx = _stack.indexOf(drawer.id);
    if (idx !== -1) _stack.splice(idx, 1);

    if (_stack.length === 0) _teardown();
  }

  /* ── Close all ──────────────────────────────────────────── */
  function closeAll() {
    _stack.slice().forEach(function (id) {
      var d = document.getElementById(id);
      if (!d) return;
      d.classList.remove('is-open');
      d.setAttribute('aria-hidden', 'true');
      d.removeEventListener('touchstart', _onTouchStart);
      d.removeEventListener('touchend',   _onTouchEnd);
      _removeTrap(d);
    });
    _stack = [];
    _teardown();
  }

  function _teardown() {
    _bd().classList.remove('is-active');
    document.body.classList.remove('sk-drawer-active');
    _unlockScroll();
    if (_focusBefore && typeof _focusBefore.focus === 'function') {
      setTimeout(function () {
        try { _focusBefore.focus(); } catch (_) {}
        _focusBefore = null;
      }, 50);
    }
  }

  /* ── Global ESC key ─────────────────────────────────────── */
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    /* Close topmost SK drawer */
    if (_stack.length > 0) {
      close(_stack[_stack.length - 1]);
      return;
    }
    /* Also close seller More drawer if open */
    var moreDrawer = document.getElementById('sdmMoreDrawer');
    if (moreDrawer && moreDrawer.style.display !== 'none') {
      var morePanel = document.getElementById('sdmMorePanel');
      moreDrawer.style.display = 'none';
      if (morePanel) morePanel.style.transform = 'translateY(100%)';
    }
    /* Also close seller Live Panel if open */
    if (typeof closeLivePanel === 'function') {
      var lp = document.getElementById('sellerLivePanel');
      if (lp && lp.classList.contains('slp-active')) closeLivePanel();
    }
  });

  root.SokoniDrawer = { open: open, close: close, closeAll: closeAll };
}(window));
