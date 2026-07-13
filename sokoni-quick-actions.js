/* ══════════════════════════════════════════════════════════════════════════════
   SOKONI STICKY QUICK ACTIONS  —  sokoni-quick-actions.js

   Turns a hub's row of quick-action buttons into a toolbar that stays put while the
   page scrolls underneath it.

   ── Why this is a component and not a CSS class ───────────────────────────────
   The obvious fix is `position: sticky; top: var(--sk-header-h)` and a class on each
   hub. That is wrong on this codebase, and quietly so:

   116 pages scroll an INNER container (`#main { overflow-y: auto }`), not the body.
   `position: sticky` resolves against the nearest scrolling ancestor — so inside
   `#main`, `top: 64px` pushes the bar 64px DOWN from the top of a container that
   already begins below the header. The bar sticks, but in the wrong place, leaving a
   64px gap. On the pages that DO scroll the body, `top: 0` would slide the bar under
   the fixed header instead.

   The correct offset is therefore not a constant. It depends on which element actually
   scrolls, and only the DOM knows that. Hence a component.

   The other trap: `position: sticky` is silently cancelled by an ancestor with
   `overflow: hidden` — no error, no warning, the element simply never sticks. Several
   hub layouts do exactly that. We detect it and fall back rather than shipping a
   feature that appears to work on the author's page and nowhere else.

   ── How it attaches ───────────────────────────────────────────────────────────
   Progressive enhancement. It ADOPTS the quick-action rows that already exist rather
   than requiring 15 hubs to be rewritten — the markup is already fragmented across
   .quick-grid, .quick-btn, .quick-item, .quick-nav-item and several bespoke rows, and
   rewriting all of them during a freeze is a much larger risk than reading them.

   Opt in explicitly with  data-sticky-actions  on any container.

   API:  SokoniQuickActions.attach(el)   — make a container sticky
         SokoniQuickActions.refresh()    — re-scan (after dynamic render)
         SokoniQuickActions.badge(id, n) — set an unread badge on an action
═════════════════════════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  if (global.SokoniQuickActions) return;              /* singleton */

  var doc = global.document;
  if (!doc) return;

  /* Containers we adopt automatically. Explicit opt-in wins; these are the existing
     conventions found in the hubs today. */
  var SELECTORS = [
    '[data-sticky-actions]',
    '.quick-grid',
    '.quick-actions',
    '.hub-actions',
    '.qa-bar',
  ];

  var CSS_ID = 'sk-qa-styles';

  /* ── Styles ────────────────────────────────────────────────────────────────
     Composited properties only (transform / opacity / box-shadow). Sticky is CSS,
     not a scroll listener: a scroll handler that repositions an element runs on the
     main thread and produces exactly the jitter this is supposed to remove. */
  function styles() {
    if (doc.getElementById(CSS_ID)) return;
    var css =
      '.sk-qa{position:sticky;z-index:60;' +
        'background:var(--bg,#050505);' +
        /* The bar must not sit flush against content it is covering. */
        'padding:10px 12px;margin-left:-12px;margin-right:-12px;' +
        'border-bottom:1px solid rgba(255,255,255,.07);' +
        /* A shadow ONLY once it is actually stuck — see the sentinel below. Showing it
           permanently makes an unstuck bar look like it is floating for no reason. */
        'transition:box-shadow .18s ease,background .18s ease}' +

      '.sk-qa.sk-qa-stuck{box-shadow:0 6px 20px rgba(0,0,0,.45);' +
        'background:color-mix(in srgb, var(--bg,#050505) 92%, transparent);' +
        '-webkit-backdrop-filter:blur(12px);backdrop-filter:blur(12px)}' +

      /* Horizontal scroll when the actions overrun the screen — with momentum on iOS,
         no visible scrollbar, and snap so a half-cut button never comes to rest. */
      '.sk-qa-scroll{display:flex;gap:8px;overflow-x:auto;overflow-y:hidden;' +
        '-webkit-overflow-scrolling:touch;scrollbar-width:none;' +
        'scroll-snap-type:x proximity;' +
        /* Bleed to the screen edges so the row does not look inset, but keep the first
           and last buttons clear of the edge. */
        'padding:2px 12px 2px 0;margin:0}' +
      '.sk-qa-scroll::-webkit-scrollbar{display:none}' +

      /* The buttons themselves. min-height 44px is the iOS touch-target floor — below
         that, a control is reliably mis-tapped. */
      '.sk-qa-scroll > *{flex:0 0 auto;scroll-snap-align:start;' +
        'min-height:44px;display:inline-flex;align-items:center;justify-content:center;' +
        'gap:7px;white-space:nowrap;' +
        'transition:transform .12s ease,background .15s ease,border-color .15s ease}' +

      /* Press feedback. Scale only — no width/height, which would trigger layout. */
      '.sk-qa-scroll > *:active{transform:scale(.94)}' +

      /* Active action. */
      '.sk-qa-scroll > .sk-qa-on{background:rgba(113,255,0,.13)!important;' +
        'border-color:rgba(113,255,0,.45)!important;color:#71ff00!important}' +

      /* Unread badge. */
      '.sk-qa-badge{position:relative}' +
      '.sk-qa-badge::after{content:attr(data-badge);position:absolute;top:-3px;right:-3px;' +
        'min-width:16px;height:16px;padding:0 4px;border-radius:9px;' +
        'background:#ff3b30;color:#fff;font-size:10px;font-weight:800;line-height:16px;' +
        'text-align:center;box-shadow:0 0 0 2px var(--bg,#050505)}' +

      /* A grid layout cannot scroll horizontally — the row must become a flex row on
         phones or the buttons wrap and the bar grows several rows tall, which is the
         opposite of a compact toolbar. */
      '@media(max-width:768px){' +
        '.sk-qa .quick-grid,.sk-qa.quick-grid{display:flex!important;' +
          'grid-template-columns:none!important}' +
      '}' +

      /* Reduced motion: no press animation, no blur. The bar still sticks — the
         behaviour is the feature; the movement is decoration. */
      '@media(prefers-reduced-motion:reduce){' +
        '.sk-qa,.sk-qa-scroll > *{transition:none!important}' +
        '.sk-qa-scroll > *:active{transform:none!important}' +
      '}';

    var s = doc.createElement('style');
    s.id = CSS_ID;
    s.textContent = css;
    doc.head.appendChild(s);
  }

  /* ── Which element actually scrolls? ──────────────────────────────────────── */
  function scrollParent(el) {
    var p = el.parentElement;
    while (p && p !== doc.body && p !== doc.documentElement) {
      var st = getComputedStyle(p);
      if (/(auto|scroll|overlay)/.test(st.overflowY)) return p;
      p = p.parentElement;
    }
    return null;                         /* the document scrolls */
  }

  /* `overflow: hidden` on an ancestor silently cancels sticky — no error, nothing in the
     console, the element simply never sticks. Worth detecting.

     BUT only ancestors BELOW the scrolling one matter. Sticky resolves against the
     NEAREST scrolling ancestor; anything above it is irrelevant.

     This distinction is not academic. The standard layout here is:

         body { overflow: hidden }        ← above the scroller. Harmless.
           #main { overflow-y: auto }     ← THE scroller. Sticky works inside it.
             .quick-grid                  ← us

     A blocker check that walks all the way to <html> finds body's overflow:hidden and
     disables the bar on all 116 pages that use this layout — i.e. precisely the pages
     the component exists for. My first version did exactly that, and the test caught it.
     Stop at the scroll parent. */
  function stickyBlocker(el, sp) {
    var stop = sp || doc.documentElement;
    var p = el.parentElement;
    while (p && p !== stop && p !== doc.documentElement) {
      var st = getComputedStyle(p);
      if (st.overflowY === 'hidden' || st.overflow === 'hidden') return p;
      /* transform / filter / perspective create a containing block, which also breaks
         sticky positioning relative to the viewport. */
      if (st.transform !== 'none' || st.filter !== 'none' || st.perspective !== 'none') return p;
      p = p.parentElement;
    }
    return null;
  }

  var HEADER_FALLBACK = 64;
  function headerH() {
    var v = getComputedStyle(doc.documentElement).getPropertyValue('--sk-header-h');
    var n = parseInt(v, 10);
    return isFinite(n) && n > 0 ? n : HEADER_FALLBACK;
  }

  /* ── Attach ───────────────────────────────────────────────────────────────── */
  function attach(el) {
    if (!el || el.__skQa) return;
    el.__skQa = true;
    styles();

    var sp      = scrollParent(el);
    var blocker = stickyBlocker(el, sp);
    if (blocker) {
      /* Do not pretend. Leave the row exactly as it was — a non-sticky bar that works
         beats a sticky bar that is 64px off, or invisible. */
      if (global.console && console.warn) {
        console.warn('[QuickActions] sticky blocked by an ancestor (' +
          blocker.tagName.toLowerCase() + (blocker.id ? '#' + blocker.id : '') +
          ') with overflow:hidden or a transform. Row left static.');
      }
      el.__skQa = 'blocked';
      return;
    }

    /* THE POINT OF THIS COMPONENT.
       Inside an inner scroll container, the container's own top edge already sits
       below the global header — so the bar sticks at 0 within it. Only when the
       DOCUMENT scrolls does the fixed header overlap the bar, and only then must we
       offset by the header's height. Getting this backwards leaves either a 64px gap
       or a bar hidden under the header. */
    var top = sp ? 0 : headerH();
    el.classList.add('sk-qa');
    el.style.top = top + 'px';

    /* Make the row a horizontal scroller. Existing children keep their own classes and
       their own onclick handlers — nothing is re-created, so nothing can lose a
       listener. */
    if (!el.classList.contains('sk-qa-scroll')) el.classList.add('sk-qa-scroll');

    /* Stuck-state shadow, via a sentinel. An IntersectionObserver costs nothing at
       scroll time; a scroll listener runs on the main thread on every frame and is
       precisely how you introduce the jitter this feature exists to remove. */
    var sentinel = doc.createElement('div');
    sentinel.setAttribute('aria-hidden', 'true');
    sentinel.style.cssText = 'height:1px;margin:0;padding:0;';
    el.parentNode.insertBefore(sentinel, el);

    if (global.IntersectionObserver) {
      var io = new IntersectionObserver(function (entries) {
        el.classList.toggle('sk-qa-stuck', !entries[0].isIntersecting);
      }, { root: sp || null, threshold: [0], rootMargin: (-top) + 'px 0px 0px 0px' });
      io.observe(sentinel);
    }

    /* Active state: reflect whichever action the user last pressed. Delegated, so
       buttons added later still work. */
    el.addEventListener('click', function (e) {
      var btn = e.target.closest('.sk-qa-scroll > *');
      if (!btn || !el.contains(btn)) return;
      Array.prototype.forEach.call(el.children, function (c) { c.classList.remove('sk-qa-on'); });
      btn.classList.add('sk-qa-on');
      /* Keep the pressed action in view when the row is scrolled horizontally. */
      if (btn.scrollIntoView) btn.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
    }, { passive: true });

    /* A sticky bar that covers the first item of the content beneath it is a worse bug
       than the one we set out to fix. Reserve its height on the following sibling. */
    var next = el.nextElementSibling;
    if (next && !next.__skQaPadded) {
      next.__skQaPadded = true;
      /* scroll-margin, not padding: it does not change the layout, it only stops
         anchor jumps and scrollIntoView landing underneath the bar. */
      next.style.scrollMarginTop = (el.offsetHeight + top + 8) + 'px';
    }
  }

  function refresh() {
    SELECTORS.forEach(function (sel) {
      Array.prototype.forEach.call(doc.querySelectorAll(sel), attach);
    });
  }

  function badge(target, n) {
    var el = typeof target === 'string' ? doc.getElementById(target) : target;
    if (!el) return;
    if (n && Number(n) > 0) {
      el.classList.add('sk-qa-badge');
      el.setAttribute('data-badge', Number(n) > 99 ? '99+' : String(n));
    } else {
      el.classList.remove('sk-qa-badge');
      el.removeAttribute('data-badge');
    }
  }

  global.SokoniQuickActions = { attach: attach, refresh: refresh, badge: badge };

  if (doc.readyState === 'loading') {
    doc.addEventListener('DOMContentLoaded', refresh, { once: true });
  } else {
    refresh();
  }

})(typeof window !== 'undefined' ? window : this);
