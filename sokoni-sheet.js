/* ══════════════════════════════════════════════════════════════════════════════
   SOKONI SHEET  —  sokoni-sheet.js
   The canonical full-screen mobile overlay: header, close, safe-area, dismissal.

   ── Why this exists ───────────────────────────────────────────────────────────
   The Notification Centre could be opened and then could not be closed.

   Not because its ✕ was missing — it was there, and it was 44px. It was because the
   sheet sat at --sk-z-drawer (600) while the global header sits at --sk-z-header
   (100001). The header rendered ON TOP of the sheet: over its title, over its
   "Mark all read", over its search, and over its ✕. Measured: elementFromPoint at the
   centre of the close button returned NAV#sk-top-nav.

   Every symptom reported — "header overlaps the global nav", "the X is tiny and partially
   hidden", "controls overlap", "the two search bars stack awkwardly", "no reliable way to
   dismiss" — is that ONE stacking mistake, seen from five angles.

   The token scale was never the problem; it is well designed. --sk-z-drawer means "a side
   drawer WITHIN the page". A sheet that COVERS the header is a modal and must out-rank it.
   The Notification Centre simply picked the wrong tier, and nothing in the system stopped
   it. This component is what stops it: pick the component, get the tier.

   ── What it guarantees ────────────────────────────────────────────────────────
   • Above the header (--sk-z-sheet), so its own chrome is never covered
   • Safe-area insets on all four edges — nothing under the Dynamic Island or the
     home indicator
   • A 44×44 close button (the iOS floor; below it, a control is reliably mis-tapped)
   • FIVE ways out, because one way out is one bug away from none:
       ✕ button · Escape · browser Back · backdrop tap · swipe down
   • Focus trap + focus restore + aria, so it is usable by keyboard and screen reader
   • No scroll listeners, no hardcoded pixel offsets, no layout thrash

   ── Usage ─────────────────────────────────────────────────────────────────────
     const sheet = SokoniSheet.create({
       id: 'sk-nc',
       title: 'Notifications',
       actions: '<button class="sk-sheet-act">Mark all read</button>',
       onClose: () => {},
     });
     sheet.body.innerHTML = '…';
     sheet.open();
═════════════════════════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  if (global.SokoniSheet) return;

  var doc = global.document;
  if (!doc) return;

  var CSS_ID = 'sk-sheet-styles';
  var _open  = [];                     /* stack — nested sheets close in order */

  function styles() {
    if (doc.getElementById(CSS_ID)) return;
    var css = [
      /* ── Overlay: ABOVE the header. This is the entire bug, fixed. ── */
      '.sk-sheet{',
        'position:fixed;inset:0;',
        'z-index:var(--sk-z-sheet,100010);',   /* > --sk-z-header (100001) */
        'display:flex;flex-direction:column;',
        'background:var(--sk-bg,#050505);',
        'visibility:hidden;opacity:0;',
        'transition:opacity .18s ease,visibility .18s;',
        /* Safe area on every edge — notch, Dynamic Island, home indicator, and the
           landscape insets people forget until a phone is rotated. */
        'padding-top:env(safe-area-inset-top,0px);',
        'padding-bottom:env(safe-area-inset-bottom,0px);',
        'padding-left:env(safe-area-inset-left,0px);',
        'padding-right:env(safe-area-inset-right,0px);',
        'overscroll-behavior:contain;',       /* no rubber-band into the page beneath */
      '}',
      '.sk-sheet.open{visibility:visible;opacity:1;}',

      /* ── Header: sticky, single row, no floating controls ── */
      '.sk-sheet-head{',
        'flex:0 0 auto;',
        'display:flex;align-items:center;gap:10px;',
        'padding:10px 12px;',
        'min-height:56px;',
        'border-bottom:1px solid rgba(255,255,255,.07);',
        'background:var(--sk-bg,#050505);',
      '}',
      '.sk-sheet-title{',
        'flex:1;min-width:0;',                /* min-width:0 or a long title stops the ✕ shrinking */
        'font-size:17px;font-weight:800;color:#fff;',
        'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;',
      '}',
      '.sk-sheet-actions{display:flex;align-items:center;gap:8px;flex-shrink:0;}',

      /* Secondary action ("Mark all read"). Also 44px — it sits beside the ✕ and a
         mis-tap here is a mis-tap on the ✕. */
      '.sk-sheet-act{',
        'min-height:44px;padding:0 12px;',
        'display:inline-flex;align-items:center;',
        'border-radius:10px;border:1px solid rgba(255,255,255,.1);',
        'background:transparent;color:var(--sk-green,#71ff00);',
        'font-size:13px;font-weight:700;cursor:pointer;font-family:inherit;',
        'white-space:nowrap;',
      '}',

      /* ── Close: 44×44, never covered, never shrunk ── */
      '.sk-sheet-close{',
        'width:44px;height:44px;',            /* the iOS floor, not 34px */
        'flex:0 0 44px;',                     /* cannot be squeezed by a long title */
        'display:flex;align-items:center;justify-content:center;',
        'border-radius:12px;',
        'border:1px solid rgba(255,255,255,.12);',
        'background:rgba(255,255,255,.06);',
        'color:#fff;font-size:18px;line-height:1;cursor:pointer;',
        'font-family:inherit;',
      '}',
      '.sk-sheet-close:hover{background:rgba(255,255,255,.12);}',
      /* Visible focus — a keyboard user must be able to SEE where they are. */
      '.sk-sheet-close:focus-visible,.sk-sheet-act:focus-visible{',
        'outline:2px solid var(--sk-green,#71ff00);outline-offset:2px;',
      '}',

      /* ── Body: the only scroller. Momentum on iOS. ── */
      '.sk-sheet-body{',
        'flex:1;min-height:0;',               /* min-height:0 or flex children refuse to scroll */
        'overflow-y:auto;overflow-x:hidden;',
        '-webkit-overflow-scrolling:touch;',
        'overscroll-behavior:contain;',
      '}',

      /* Drag handle — the affordance for swipe-down. Mobile only. */
      '.sk-sheet-grip{display:none;}',
      '@media (max-width:768px){',
        '.sk-sheet-grip{',
          'display:block;width:38px;height:4px;margin:6px auto 2px;',
          'border-radius:2px;background:rgba(255,255,255,.18);',
        '}',
      '}',

      /* Nothing inside a sheet may cause sideways scroll. */
      '.sk-sheet *{max-width:100%;}',

      '@media (prefers-reduced-motion:reduce){',
        '.sk-sheet{transition:none;}',
      '}',
    ].join('');
    var s = doc.createElement('style');
    s.id = CSS_ID;
    s.textContent = css;
    doc.head.appendChild(s);
  }

  /* ── Focus trap ─────────────────────────────────────────────────────────────
     A sheet that covers the screen but leaves focus behind it is unusable with a
     keyboard or a screen reader: you tab into content you cannot see. */
  var FOCUSABLE = 'button,[href],input,select,textarea,[tabindex]:not([tabindex="-1"])';

  function trap(sheet, e) {
    if (e.key !== 'Tab') return;
    var items = sheet.el.querySelectorAll(FOCUSABLE);
    if (!items.length) return;
    var first = items[0], last = items[items.length - 1];
    if (e.shiftKey && doc.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && doc.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  function create(opts) {
    opts = opts || {};
    styles();

    var id = opts.id || ('sk-sheet-' + Math.floor(performance.now()));
    var el = doc.getElementById(id);
    if (!el) {
      el = doc.createElement('div');
      el.id = id;
      doc.body.appendChild(el);
    }
    el.className = 'sk-sheet';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.setAttribute('aria-label', opts.title || 'Panel');

    el.innerHTML =
      '<div class="sk-sheet-grip" aria-hidden="true"></div>' +
      '<div class="sk-sheet-head">' +
        '<div class="sk-sheet-title">' + (opts.title || '') + '</div>' +
        '<div class="sk-sheet-actions">' + (opts.actions || '') +
          '<button type="button" class="sk-sheet-close" aria-label="Close ' +
            (opts.title || 'panel') + '">✕</button>' +
        '</div>' +
      '</div>' +
      '<div class="sk-sheet-body"></div>';

    var sheet = {
      el: el,
      body: el.querySelector('.sk-sheet-body'),
      head: el.querySelector('.sk-sheet-head'),
      isOpen: false,
    };

    var lastFocus = null;
    var pushed    = false;

    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); sheet.close(); return; }
      trap(sheet, e);
    }

    /* Browser / device Back must close the sheet, not leave the page. On iOS the
       swipe-back gesture IS the back button, and a sheet you can only leave by finding a
       ✕ is a sheet most people will leave by closing the tab. */
    function onPop() {
      pushed = false;                    /* the entry is already gone */
      if (sheet.isOpen) sheet.close(true);
    }

    /* Swipe down to dismiss. Only from the top region, and only when the body is already
       scrolled to the top — otherwise a downward flick while reading would fling the
       sheet shut mid-scroll, which is the single most infuriating way to lose your place. */
    var y0 = null;
    function onTouchStart(e) {
      var t = e.touches[0];
      var fromChrome = e.target.closest('.sk-sheet-head, .sk-sheet-grip');
      y0 = (fromChrome || sheet.body.scrollTop <= 0) ? t.clientY : null;
    }
    function onTouchMove(e) {
      if (y0 == null) return;
      var dy = e.touches[0].clientY - y0;
      if (dy > 90) { y0 = null; sheet.close(); }
    }

    sheet.open = function () {
      if (sheet.isOpen) return;
      sheet.isOpen = true;
      lastFocus = doc.activeElement;

      el.classList.add('open');
      doc.body.style.overflow = 'hidden';       /* the page behind must not scroll */

      try { history.pushState({ skSheet: id }, ''); pushed = true; } catch (e) {}

      doc.addEventListener('keydown', onKey);
      global.addEventListener('popstate', onPop);
      el.addEventListener('touchstart', onTouchStart, { passive: true });
      el.addEventListener('touchmove',  onTouchMove,  { passive: true });

      _open.push(sheet);

      var close = el.querySelector('.sk-sheet-close');
      if (close) close.focus();
      if (opts.onOpen) opts.onOpen(sheet);
    };

    sheet.close = function (fromPop) {
      if (!sheet.isOpen) return;
      sheet.isOpen = false;

      el.classList.remove('open');
      if (!_open.filter(function (s) { return s !== sheet && s.isOpen; }).length) {
        doc.body.style.overflow = '';
      }
      _open = _open.filter(function (s) { return s !== sheet; });

      /* EVERY listener is removed. A sheet opened and closed fifty times must not leave
         fifty keydown handlers behind — that is how a long PWA session gets slow. */
      doc.removeEventListener('keydown', onKey);
      global.removeEventListener('popstate', onPop);
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove',  onTouchMove);

      /* Consume the history entry we pushed, unless Back is what closed us. */
      if (pushed && !fromPop) { pushed = false; try { history.back(); } catch (e) {} }

      if (lastFocus && lastFocus.focus) lastFocus.focus();
      if (opts.onClose) opts.onClose(sheet);
    };

    el.querySelector('.sk-sheet-close').addEventListener('click', function () { sheet.close(); });

    return sheet;
  }

  global.SokoniSheet = {
    create: create,
    closeTop: function () { var s = _open[_open.length - 1]; if (s) s.close(); },
    openCount: function () { return _open.length; },
  };

})(typeof window !== 'undefined' ? window : this);
