/* ============================================================================
   SOKONI Admin Shell — sokoni-admin-shell.js
   ============================================================================
   Renders the admin workspace chrome from sokoni-admin-nav.js: header, section
   sidebar, breadcrumbs, active state, and sibling links. Presentation only —
   membership and hierarchy live in the registry.

   Load order on an admin page:
     <script src="/sokoni-admin-guard.js"></script>   <- authorization
     <script src="/sokoni-admin-nav.js"></script>     <- registry (data)
     <script src="/sokoni-admin-shell.js"></script>   <- chrome (this file)

   RESPONSIVE CONTRACT
   -------------------
   SOKONI is flat HTML with no framework shell, so every page is its own
   document and nothing enforces layout consistency globally. This file is that
   enforcement for admin surfaces. It is certified at 1440 / 1280 / 1024 / 768 /
   430 / 390 / 360 px:

     >= 1024   fixed 244px sidebar, content offset by it
     768-1023  sidebar collapses to an off-canvas drawer behind a hamburger
     < 768     drawer + compact header; labels wrap rather than truncate

   Rules held at every width:
     - the page never scrolls horizontally; wide content scrolls INSIDE its own
       container (.sk-adm-scroll)
     - the logo keeps its intrinsic aspect ratio (height fixed, width auto,
       object-fit contain) — never width+height 100%, which cropped the
       workspace-bar logo before shared-header.js:1107 was fixed
     - interactive targets are >= 44px in the smallest dimension
     - the sticky header never covers content: it sets --sk-adm-header-h and the
       body is padded by exactly that MEASURED value, not a guess
     - breadcrumbs wrap; they never widen the header
     - long titles wrap instead of forcing overflow
   ========================================================================== */
(function () {
  'use strict';

  var NAV = window.SokoniAdminNav;
  if (!NAV) { console.error('[AdminShell] sokoni-admin-nav.js must load first'); return; }

  var entry = NAV.current();
  if (!entry) return;      /* not a registered admin surface — render nothing */

  /* ── PAGE-LEVEL OPT-OUT: the page owns its own chrome ────────────────────
     A page that ships a complete workspace of its own must be able to say so.
     admin-os.html has its own sidebar (#aosSidebar, with its own drawer toggle)
     and its own header (.aos-header, with search and notifications), so this
     shell was rendering a SECOND sidebar and a SECOND global header on top of
     it — three global navigation trees on one page, measured at 220x900,
     244x900 and 1196x65.

     The opt-out lives HERE, at the point of ownership, and returns before any
     CSS is injected or any element is created. It is deliberately not a CSS
     override: this shell already defeats page-level `header{display:none}` and
     `nav{display:none}` rules with display:...!important (see the notes in
     injectCSS), so a fourth layer of CSS could not win and would only add
     another thing to reason about. Nothing renders because nothing is asked to.

     Scope: opt-in per page, so every other registered admin surface keeps this
     shell and the fixes it carries. Only a page declaring
     data-admin-shell="own" is skipped.

     Note the <html> stamp `data-sokoni-workspace="admin"` is NOT lost by
     skipping: sokoni-admin-nav.js sets it synchronously and independently
     (sokoni-admin-nav.js:267), and that is the copy security.js:655 and
     shared-header.js:2402 read to suppress the consumer header and nav. This
     shell only mirrored it onto <body>, which nothing reads. */
  if (document.documentElement.getAttribute('data-admin-shell') === 'own') return;

  var LOGO = '/assets/logosokoni.png';
  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };

  /* ── styles ─────────────────────────────────────────────────────────────── */
  function injectCSS() {
    if (document.getElementById('sk-adm-css')) return;
    var st = document.createElement('style');
    st.id = 'sk-adm-css';
    st.textContent = [
      ':root{--sk-adm-bg:#0b0d0b;--sk-adm-panel:#111;--sk-adm-line:rgba(255,255,255,.09);',
      '--sk-adm-txt:#fff;--sk-adm-dim:rgba(255,255,255,.55);--sk-adm-accent:#71ff00;--sk-adm-side:244px;}',

      /* Never let the page itself scroll sideways. */
      'html,body{max-width:100%;overflow-x:hidden;}',

      /* header */
      /* display:flex!important — several admin pages carry data-no-header="true"
         and ship a `header{display:none!important}` rule to suppress the shared
         consumer header. That rule also swallowed THIS header (a <header>
         element), so ops-dashboard, admin-feedback, beta-dashboard and
         reliability-center rendered the sidebar and burger but no header bar at
         any width. An id selector loses to an !important element rule, so this
         one must be !important too. */
      '#sk-adm-header{position:fixed;top:0;left:0;right:0;z-index:900;display:flex!important;align-items:center;',
      'gap:12px;padding:10px 16px;background:rgba(11,13,11,.96);backdrop-filter:blur(12px);',
      'border-bottom:1px solid var(--sk-adm-line);font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;}',
      '#sk-adm-burger{display:none;width:44px;height:44px;flex:0 0 44px;align-items:center;justify-content:center;',
      'background:transparent;border:1px solid var(--sk-adm-line);border-radius:10px;color:var(--sk-adm-txt);',
      'font-size:18px;cursor:pointer;line-height:1;}',
      /* min-width:44px makes the HIT AREA meet the 44px tap-target floor without
         touching the image. Below 430px the wordmark is hidden, so this anchor
         collapsed to the logo's own width — measured at 22x44 on beta-control,
         a real accessibility defect in the SHARED shell that every admin page
         would have inherited. Enlarging the logo itself would have fixed the
         number and distorted the brand mark; the target grows, the image does
         not. justify-content centres the mark inside the larger area. */
      '#sk-adm-logo{display:flex;align-items:center;justify-content:center;gap:9px;',
      'text-decoration:none;flex:0 0 auto;min-height:44px;min-width:44px;}',
      /* Aspect ratio preserved: fixed height, auto width, contain. Untouched by
         the hit-area change above. */
      '#sk-adm-logo img{height:26px;width:auto;max-width:120px;object-fit:contain;display:block;}',
      '#sk-adm-wordmark{font-size:12px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;',
      'color:var(--sk-adm-dim);white-space:nowrap;}',
      '#sk-adm-title{flex:1 1 auto;min-width:0;font-size:14px;font-weight:800;color:var(--sk-adm-txt);',
      'overflow-wrap:anywhere;}',   /* long titles WRAP, never overflow */
      /* min-width:44px for the same reason: at <=360px the label is hidden and
         only the arrow remains, which measured 34x44. The pill grows, the
         glyph does not. */
      '#sk-adm-home{flex:0 0 auto;min-height:44px;min-width:44px;display:inline-flex;align-items:center;',
      'justify-content:center;padding:0 14px;',
      'border-radius:10px;background:rgba(113,255,0,.11);border:1px solid rgba(113,255,0,.28);',
      'color:var(--sk-adm-accent);font-size:12px;font-weight:800;text-decoration:none;white-space:nowrap;}',

      /* breadcrumbs — wrap, never widen the header */
      '#sk-adm-crumbs{position:fixed;left:0;right:0;z-index:880;display:flex!important;flex-wrap:wrap;gap:4px 8px;',
      'align-items:center;padding:7px 16px;background:rgba(11,13,11,.92);border-bottom:1px solid var(--sk-adm-line);',
      'font-family:system-ui,sans-serif;font-size:11.5px;color:var(--sk-adm-dim);}',
      '#sk-adm-crumbs a{color:var(--sk-adm-dim);text-decoration:none;}',
      '#sk-adm-crumbs a:hover{color:var(--sk-adm-txt);}',
      '#sk-adm-crumbs .sk-adm-sep{opacity:.4;}',
      '#sk-adm-crumbs [aria-current]{color:var(--sk-adm-accent);font-weight:800;}',

      /* sidebar */
      /* display:block!important for the same reason as the header: pages with
         data-no-header="true" ship nav{display:none!important} to suppress the
         shared consumer nav, which also swallowed this sidebar and the
         breadcrumb bar — both are <nav> elements. */
      '#sk-adm-side{position:fixed;top:0;bottom:0;left:0;width:var(--sk-adm-side);z-index:890;display:block!important;',
      'overflow-y:auto;overscroll-behavior:contain;background:var(--sk-adm-panel);',
      'border-right:1px solid var(--sk-adm-line);font-family:system-ui,sans-serif;',
      '-webkit-overflow-scrolling:touch;}',
      '.sk-adm-sec{padding:12px 14px 4px;font-size:10px;font-weight:900;letter-spacing:.1em;',
      'text-transform:uppercase;color:rgba(255,255,255,.32);}',
      '.sk-adm-grp{padding:8px 14px 3px;font-size:9.5px;font-weight:800;letter-spacing:.08em;',
      'text-transform:uppercase;color:rgba(255,255,255,.22);}',
      '.sk-adm-link{display:flex;align-items:center;min-height:44px;padding:0 14px;color:var(--sk-adm-dim);',
      'text-decoration:none;font-size:13px;border-left:3px solid transparent;overflow-wrap:anywhere;}',
      '.sk-adm-link:hover{color:var(--sk-adm-txt);background:rgba(255,255,255,.04);}',
      '.sk-adm-link[aria-current="page"]{color:var(--sk-adm-accent);background:rgba(113,255,0,.09);',
      'border-left-color:var(--sk-adm-accent);font-weight:800;}',
      '.sk-adm-legacy{opacity:.5;font-style:italic;}',

      '#sk-adm-scrim{position:fixed;inset:0;z-index:885;background:rgba(0,0,0,.55);display:none;}',

      /* wide content escape hatch — scrolls inside itself, not the page */
      '.sk-adm-scroll{overflow-x:auto;-webkit-overflow-scrolling:touch;max-width:100%;}',

      /* >= 1024: persistent sidebar */
      '@media (min-width:1024px){',
      ' body{padding-left:var(--sk-adm-side);}',
      ' #sk-adm-header,#sk-adm-crumbs{left:var(--sk-adm-side);}',
      ' #sk-adm-side{transform:none;}',
      '}',

      /* < 1024: off-canvas drawer */
      '@media (max-width:1023px){',
      ' #sk-adm-burger{display:inline-flex;}',
      ' #sk-adm-side{transform:translateX(-100%);transition:transform .22s ease;width:min(84vw,300px);}',
      ' body.sk-adm-open #sk-adm-side{transform:translateX(0);}',
      ' body.sk-adm-open #sk-adm-scrim{display:block;}',
      ' body{padding-left:0;}',
      '}',

      /* <= 430: compact header, wordmark yields first */
      '@media (max-width:430px){',
      ' #sk-adm-header{padding:8px 10px;gap:8px;}',
      ' #sk-adm-wordmark{display:none;}',
      ' #sk-adm-logo img{height:22px;}',
      ' #sk-adm-title{font-size:13px;}',
      ' #sk-adm-home{padding:0 11px;font-size:11px;}',
      ' #sk-adm-crumbs{padding:6px 10px;font-size:11px;}',
      '}',
      /* <= 360: drop the home pill label to an arrow so nothing clips */
      '@media (max-width:360px){ #sk-adm-home .sk-adm-home-txt{display:none;} }',
    ].join('');
    document.head.appendChild(st);
  }

  /* ── markup ─────────────────────────────────────────────────────────────── */
  function sidebarHTML() {
    var out = [];
    NAV.sections.slice().sort(function (a, b) { return a.order - b.order; }).forEach(function (sec) {
      var pages = NAV.pagesIn(sec.id, { includeDuplicates: true });
      if (!pages.length) return;
      out.push('<div class="sk-adm-sec">' + esc(sec.label) + '</div>');
      var lastGroup = null;
      pages.forEach(function (p) {
        if (p.group && p.group !== lastGroup) {
          out.push('<div class="sk-adm-grp">' + esc(p.group) + '</div>');
          lastGroup = p.group;
        } else if (!p.group) { lastGroup = null; }
        var cur = p.page === entry.page;
        out.push('<a class="sk-adm-link' + (p.duplicateOf ? ' sk-adm-legacy' : '') + '" href="' + esc(p.page) + '"' +
                 (cur ? ' aria-current="page"' : '') + '>' + esc(p.label) + '</a>');
      });
    });
    return out.join('');
  }

  function crumbsHTML() {
    var t = NAV.trail();
    if (t.length <= 1) return '';
    return t.map(function (p, i) {
      var last = i === t.length - 1;
      var node = last
        ? '<span aria-current="page">' + esc(p.label) + '</span>'
        : '<a href="' + esc(p.page) + '">' + esc(p.label) + '</a>';
      return (i ? '<span class="sk-adm-sep">/</span>' : '') + node;
    }).join('');
  }

  function render() {
    injectCSS();
    /* Mirror the workspace marker onto <body>. sokoni-admin-nav.js already
       stamped <html> synchronously (that is the copy security.js reads, because
       it must be answerable before <body> exists); this is the body-level marker
       for CSS and for any consumer that scopes off body. */
    document.body.setAttribute('data-sokoni-workspace', 'admin');
    if (document.getElementById('sk-adm-header')) return;

    var sec = NAV.section(entry.section);

    var side = document.createElement('nav');
    side.id = 'sk-adm-side';
    side.setAttribute('aria-label', 'Admin sections');
    side.innerHTML = sidebarHTML();

    var scrim = document.createElement('div');
    scrim.id = 'sk-adm-scrim';

    var hdr = document.createElement('header');
    hdr.id = 'sk-adm-header';
    hdr.innerHTML =
      '<button id="sk-adm-burger" type="button" aria-label="Open admin menu" aria-expanded="false" aria-controls="sk-adm-side">&#9776;</button>' +
      '<a id="sk-adm-logo" href="' + esc(NAV.home) + '">' +
        '<img src="' + LOGO + '" alt="SOKONI">' +
        '<span id="sk-adm-wordmark">Admin</span>' +
      '</a>' +
      '<div id="sk-adm-title">' + esc(entry.label) +
        (sec ? ' <span style="font-weight:600;color:rgba(255,255,255,.4)">&middot; ' + esc(sec.label) + '</span>' : '') +
      '</div>' +
      (entry.page === NAV.home ? '' :
        '<a id="sk-adm-home" href="' + esc(NAV.home) + '">&#8592;<span class="sk-adm-home-txt">&nbsp;Console</span></a>');

    var crumbs = null;
    var ch = crumbsHTML();
    if (ch) {
      crumbs = document.createElement('nav');
      crumbs.id = 'sk-adm-crumbs';
      crumbs.setAttribute('aria-label', 'Breadcrumb');
      crumbs.innerHTML = ch;
    }

    document.body.appendChild(side);
    document.body.appendChild(scrim);
    document.body.insertBefore(hdr, document.body.firstChild);
    if (crumbs) document.body.insertBefore(crumbs, hdr.nextSibling);

    /* Force display INLINE with !important.
       Admin pages carrying data-no-header="true" ship rules that suppress the
       shared consumer chrome by ELEMENT type — header{display:none!important}
       and nav{display:none!important}. The shell's header, sidebar and
       breadcrumb bar are <header> and <nav>, so they were swallowed too: the
       sidebar reported width:244px and 60 children while getBoundingClientRect()
       returned all zeros.

       An !important rule in the page stylesheet was still beating the shell's
       !important id rule (later in the cascade, or higher specificity). An
       inline declaration marked important outranks every stylesheet rule, so
       set it on the elements rather than keep escalating selector wars. */
    hdr.style.setProperty('display', 'flex', 'important');
    side.style.setProperty('display', 'block', 'important');
    if (crumbs) crumbs.style.setProperty('display', 'flex', 'important');

    /* Offset the body by the MEASURED chrome height, never a guessed constant —
       a hardcoded value is how sticky headers end up covering content when a
       title wraps to two lines. Re-measured on resize and on font load. */
    function offset() {
      var h = hdr.offsetHeight;
      if (crumbs) { crumbs.style.top = h + 'px'; h += crumbs.offsetHeight; }
      document.documentElement.style.setProperty('--sk-adm-header-h', h + 'px');
      /* setProperty with 'important': shared-header.js declares
         body{padding-top:var(--sk-header-h)!important}, and a stylesheet
         !important beats a plain inline style — the admin chrome was covering
         7px of content (chrome 65 vs pad 58). */
      document.body.style.setProperty('padding-top', h + 'px', 'important');
      side.style.paddingTop = h + 'px';
    }
    offset();
    window.addEventListener('resize', offset);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(offset).catch(function () {});

    /* Re-measure whenever the chrome itself changes height. A one-shot measure
       is not enough: on reliability-center the breadcrumb trail reflowed to
       THREE lines after the initial measurement, leaving the body padded to 95px
       against 124px of chrome — the header sat on 29px of content. Resize and
       font-load hooks both missed it because neither fired. */
    if (window.ResizeObserver) {
      try {
        var ro = new ResizeObserver(function () { offset(); });
        ro.observe(hdr);
        if (crumbs) ro.observe(crumbs);
      } catch (e) { /* observation is an optimisation, never a hard dependency */ }
    }

    /* drawer */
    function setOpen(open) {
      document.body.classList.toggle('sk-adm-open', open);
      document.getElementById('sk-adm-burger').setAttribute('aria-expanded', String(open));
    }
    document.getElementById('sk-adm-burger').addEventListener('click', function () {
      setOpen(!document.body.classList.contains('sk-adm-open'));
    });
    scrim.addEventListener('click', function () { setOpen(false); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') setOpen(false); });
    /* Returning to a wide viewport must not leave the drawer state stuck on. */
    window.addEventListener('resize', function () {
      if (window.innerWidth >= 1024) setOpen(false);
    });

    /* ── remove customer navigation from the admin workspace ────────────────
       Audit finding C3: admin consoles inherit the CUSTOMER bottom nav
       (Home / Shop / Services / Orders / Profile) and mobile menu. Unlike the
       consumer header, this markup is STATIC in the page, so it cannot be
       prevented from mounting — shared-header.js is already suppressed here and
       these still render.

       They are REMOVED rather than hidden. display:none would leave focusable,
       screen-reader-visible links that navigate an administrator out to the
       marketplace — the "no customer/merchant navigation masquerading as admin
       navigation" rule, and the same reasoning that made consent a
       prevent-the-mount fix rather than a CSS hide.

       Selectors are deliberately narrow and unambiguous. Widening them risks
       removing a page's own admin controls, so anything less than certain is
       left alone and reported instead. */
    try {
      var CUSTOMER_NAV = ['nav.bottom-nav', 'nav.bnav', '#mobileMenu'];
      CUSTOMER_NAV.forEach(function (sel) {
        Array.prototype.forEach.call(document.querySelectorAll(sel), function (el) {
          /* Never remove anything the admin shell itself owns. */
          if (el.id && el.id.indexOf('sk-adm-') === 0) return;
          if (el.closest && el.closest('#sk-adm-side, #sk-adm-header, #sk-adm-crumbs')) return;
          el.remove();
        });
      });
    } catch (e) { console.warn('[AdminShell] customer-nav cleanup skipped:', e.message); }

    /* Keep the active item in view in a long sidebar. */
    var cur = side.querySelector('[aria-current="page"]');
    if (cur && cur.scrollIntoView) { try { cur.scrollIntoView({ block: 'center' }); } catch (e) {} }
  }

  function boot() {
    /* Never paint admin chrome over a page the guard has not cleared. */
    if (window.SokoniAdminGuard && window.SokoniAdminGuard.verified) {
      window.SokoniAdminGuard.verified.then(render).catch(function () {});
    } else {
      render();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else { boot(); }

  window.SokoniAdminShell = { render: render, entry: entry, version: '1.0.0' };
})();
