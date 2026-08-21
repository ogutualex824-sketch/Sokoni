/* ================================================================
   SOKONI Shared Header  —  shared-header.js
   Phase 1 (ALL pages): inject design tokens + component library
   Phase 2 (non-excluded pages): inject fixed top nav
   Pages excluded from nav: pos, seller, login, signup, register,
     success, offline, admin, and any page with data-no-header="true"
     (enterprise dashboards that have their own full-screen nav)
================================================================ */
(function () {
  'use strict';

  /* ── PREMIUM DARK THEME — enforce immediately, before first paint ─────
     Sets data-theme="dark" on <html> so every @media(prefers-color-scheme:dark)
     block activates, and dark-mode form controls / scrollbars kick in.
     Also stamps the raw background on documentElement so no white flash
     occurs even on pages that override body { background } in their CSS. */
  (function _forceDark() {
    const h = document.documentElement;
    if (!h.getAttribute('data-theme')) h.setAttribute('data-theme', 'dark');
    h.style.backgroundColor = 'var(--bg,#050505)';
    h.style.color = 'var(--txt,#e8e8e8)';
  }());

  /* ── SERVICE-WORKER SELF-UPDATE (every shared-header page) ────────────
     195 pages load this header but never included sw-register.js, so they
     never checked for a new worker and never auto-reloaded when one took
     control — they rendered whatever the active (possibly stale) worker
     held. That is the "page loads old version / must clear browsing data"
     class of bug (earnings/plans were two of them). Inject sw-register.js
     here, once, so EVERY page carrying the shared header self-updates.
     Pages that already include it directly are skipped by the src check,
     and sw-register.js itself is idempotent, so double-loading is safe. */
  (function _ensureSwRegister() {
    try {
      if (!('serviceWorker' in navigator)) return;
      if (window.__sokoniSwRegisterInjected) return;
      if (document.querySelector('script[src*="sw-register"]')) return;
      window.__sokoniSwRegisterInjected = true;
      var s = document.createElement('script');
      s.src = '/sw-register.js';
      s.defer = true;
      (document.head || document.documentElement).appendChild(s);
    } catch (e) { /* SW wiring must never break header rendering */ }
  }());

  /* ── SPLASH SCREEN — unique per page, runs on every page load ────────
     Injects a full-screen branded splash overlay immediately, before any
     content paints, then fades out once the page is ready (min 1.8 s).
     Opt out on a page with: <html data-no-splash="true">
     Each page gets a unique tagline derived from its filename.        */
  (function _splash() {
    if (document.documentElement.dataset.noSplash === 'true') return;
    if (window.self !== window.top) return; // no splash inside iframes
    if (window.SokoniSplash) return; // splash.js (v2) already rendered; skip duplicate overlay

    const _pg = (location.pathname.split('/').pop().split('?')[0] || 'index.html').toLowerCase();

    /* ── Per-page taglines — unique identity for every section ── */
    const _T = {
      /* Core */
      'index.html':                   { line: "Kenya's Digital Marketplace",   bar: '#71ff00' },
      'search.html':                  { line: 'Find Anything, Instantly',       bar: '#71ff00' },
      'cart.html':                    { line: 'Your Cart Awaits',               bar: '#71ff00' },
      'checkout.html':                { line: 'Almost There — Secure Checkout', bar: '#00bcd4' },
      'profile.html':                 { line: 'Your SOKONI Account',            bar: '#71ff00' },
      /* Marketplace */
      'marketplace.html':             { line: 'Thousands of Sellers. One Home.',bar: '#71ff00' },
      'auction.html':                 { line: 'Bid Smart. Win Big.',            bar: '#ffb300' },
      'auction-manager.html':         { line: 'Manage Your Auctions',           bar: '#ffb300' },
      'rental.html':                  { line: 'Rent Anything, Anytime.',        bar: '#00bcd4' },
      'digital-store.html':           { line: 'Download the Future.',           bar: '#71ff00' },
      /* Finance */
      'finance-budget.html':          { line: 'Every Shilling, Accounted For', bar: '#71ff00' },
      'finance-expenses.html':        { line: 'Expenses Under Control',         bar: '#ffb300' },
      'finance-invoices.html':        { line: 'Invoice. Send. Get Paid.',       bar: '#71ff00' },
      'finance-reconcile.html':       { line: 'Books Always Balanced.',         bar: '#00bcd4' },
      /* Logistics */
      'fleet-manager.html':           { line: 'Your Fleet. Always Moving.',     bar: '#71ff00' },
      'route-planner.html':           { line: 'Smarter Routes. Faster Delivery.',bar:'#00bcd4'},
      'warehouse.html':               { line: 'Stock In. Orders Out.',          bar: '#71ff00' },
      'logistics-reports.html':       { line: 'Logistics Performance. Visualised.',bar:'#71ff00'},
      'delivery-zones.html':          { line: 'Coverage That Reaches Further',  bar: '#00bcd4' },
      /* Analytics & Observability */
      'analytics.html':               { line: 'Insights That Drive Growth',     bar: '#71ff00' },
      'observability.html':           { line: 'Platform Health at a Glance.',   bar: '#00bcd4' },
      'webhooks.html':                { line: 'Connect. Integrate. Automate.',  bar: '#71ff00' },
      'task-queue.html':              { line: 'Background Jobs, Under Control.', bar: '#00bcd4' },
      'api-gateway.html':             { line: 'Traffic. Metrics. Control.',      bar: '#71ff00' },
      /* SmartPOS */
      'pos.html':                     { line: 'Point of Sale. Powered by AI.',  bar: '#71ff00' },
      'pos-checkout.html':            { line: 'Fast Checkout. Every Time.',     bar: '#71ff00' },
      'pos-daily.html':               { line: 'Start Strong. Close Stronger.',  bar: '#ffb300' },
      'pos-observability.html':       { line: 'Real-Time Store Intelligence',   bar: '#00bcd4' },
      'pos-marketplace.html':         { line: 'Your Store Meets the Marketplace',bar:'#71ff00'},
      /* Merchant & Seller */
      'merchant-success.html':        { line: 'Built to Help You Grow',         bar: '#71ff00' },
      'seller.html':                  { line: 'Your Business Dashboard',        bar: '#71ff00' },
      'seller-success.html':          { line: 'Success Starts Here',            bar: '#71ff00' },
      'minishop.html':                { line: 'Your Shop, Your Brand.',         bar: '#71ff00' },
      /* Community & Social */
      'events.html':                  { line: 'Life Is Better Live.',           bar: '#ffb300' },
      'event-hub.html':               { line: 'Discover What\'s Happening',     bar: '#ffb300' },
      'messages.html':                { line: 'Your Conversations. Secured.',   bar: '#00bcd4' },
      /* People */
      'jobs.html':                    { line: 'Find Your Next Opportunity.',    bar: '#71ff00' },
      'healthcare.html':              { line: 'Health, Closer to Home.',        bar: '#00bcd4' },
      'education.html':               { line: 'Learn Without Limits.',          bar: '#71ff00' },
      'entertainment.html':           { line: 'Your Next Favourite Thing.',     bar: '#ffb300' },
      /* Loyalty & Wallet */
      'loyalty.html':                 { line: 'Earn. Redeem. Repeat.',          bar: '#ffb300' },
      'wallet.html':                  { line: 'Your Digital Wallet.',           bar: '#71ff00' },
      /* Property & Assets */
      'property.html':                { line: 'Find Your Space.',               bar: '#71ff00' },
      'bnb.html':                     { line: 'Stay Anywhere in Kenya.',        bar: '#ffb300' },
      'car-rental.html':              { line: 'Drive on Demand.',               bar: '#71ff00' },
      /* Hubs */
      'food.html':                    { line: 'Hungry? We\'ve Got You.',        bar: '#ffb300' },
      'services.html':                { line: 'Every Service, One Place.',      bar: '#71ff00' },
      'banking.html':                 { line: 'Financial Freedom. Simplified.', bar: '#00bcd4' },
      'construction.html':            { line: 'Build Something Lasting.',       bar: '#71ff00' },
      /* Customer */
      'track.html':                   { line: 'Your Order, Every Step.',        bar: '#00bcd4' },
      'dispute.html':                 { line: 'We\'ve Got You Covered.',        bar: '#ffb300' },
      'reviews.html':                 { line: 'Your Voice Matters.',            bar: '#71ff00' },
      /* Admin */
      'admin-os.html':                { line: 'Platform Command Centre.',       bar: '#71ff00' },
      'super-admin.html':             { line: 'Superadmin Dashboard.',          bar: '#71ff00' },
      'automation-center.html':       { line: 'Intelligence. Automated.',       bar: '#00bcd4' },
      'security-center.html':         { line: 'Zero Trust. Total Control.',     bar: '#f44336' },
      /* Driver */
      'driver.html':                  { line: 'Delivering Joy, Every Day.',     bar: '#71ff00' },
      'rider-nav.html':               { line: 'Navigate. Deliver. Earn.',       bar: '#71ff00' },
      /* Onboarding */
      'login.html':                   { line: 'Welcome Back.',                  bar: '#71ff00' },
      'signup.html':                  { line: 'Join SOKONI Today.',             bar: '#71ff00' },
      /* Trust & Legal */
      'trust-and-safety.html':        { line: 'Safe. Fair. Trusted.',           bar: '#00bcd4' },
      'help.html':                    { line: 'We\'re Here to Help.',           bar: '#71ff00' },
    };

    const cfg = _T[_pg] || { line: 'One Platform. Endless Possibilities.', bar: '#71ff00' };

    /* ── Inject blocking CSS before body renders ── */
    const style = document.createElement('style');
    style.id = 'sk-splash-css';
    style.textContent = [
      '#sk-splash{position:fixed;inset:0;z-index:2147483647;',
        'background:radial-gradient(ellipse 90% 80% at 50% 46%,#131a08 0%,#0d0d0d 55%,#0a0a0a 100%);',
        'display:flex;align-items:center;justify-content:center;',
        'transition:opacity .55s cubic-bezier(.4,0,.2,1);will-change:opacity}',
      '#sk-splash.out{opacity:0;pointer-events:none}',
      '.sk-sp-inner{text-align:center;display:flex;flex-direction:column;align-items:center;gap:20px}',
      /* THE LOGO, ON ITS OWN. No frame, no card, no background.
         sokoni-wordmark.svg is a pure SVG (vector) — it never fades or blurs
         at any resolution. viewBox 0 0 170 56 → preserving that aspect ratio
         (170:56 ≈ 3:1) gives the right premium-wordmark proportions. */
      '.sk-sp-logo{width:min(88vw,460px);height:auto;max-width:none!important;',
        'display:block;background:none;border:0;mix-blend-mode:screen;',
        'animation:skSplashUp .68s cubic-bezier(.22,1.4,.36,1) both,',
          'skLogoBreathe 3.8s ease-in-out .9s infinite,',
          'skLogoGlow 2.8s ease-in-out .9s infinite}',
      '@keyframes skLogoBreathe{0%,100%{transform:scale(1)}50%{transform:scale(1.022)}}',
      '@keyframes skLogoGlow{',
        '0%,100%{filter:drop-shadow(0 0 10px rgba(113,255,0,.28)) drop-shadow(0 0 22px rgba(113,255,0,.18))}',
        '50%{filter:drop-shadow(0 0 26px rgba(113,255,0,.42)) drop-shadow(0 0 46px rgba(113,255,0,.26))}}',
      '.sk-sp-line{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;',
        'font-size:clamp(10px,2.5vw,13px);font-weight:900;letter-spacing:.18em;text-transform:uppercase;',
        'background:linear-gradient(90deg,rgba(255,255,255,.5),#71ff00,rgba(255,255,255,.5));',
        'background-clip:text;-webkit-background-clip:text;-webkit-text-fill-color:transparent;',
        'animation:skSplashUp .7s .2s cubic-bezier(.22,1,.36,1) both}',
      '.sk-sp-bar{width:min(150px,38vw);height:2.5px;background:rgba(255,255,255,.06);',
        'border-radius:2px;overflow:hidden;animation:skSplashUp .6s .1s cubic-bezier(.22,1,.36,1) both}',
      '.sk-sp-fill{height:100%;border-radius:2px;width:0%;',
        'animation:skFill 1.8s .12s cubic-bezier(.4,0,.2,1) forwards}',
      '@keyframes skSplashUp{from{opacity:0;transform:translateY(16px)}to{opacity:1;transform:translateY(0)}}',
      '@keyframes skFill{to{width:100%}}',
    ].join('');
    (document.head || document.documentElement).appendChild(style);

    /* ── Build the overlay ── */
    const el = document.createElement('div');
    el.id = 'sk-splash';
    el.setAttribute('aria-hidden', 'true');
    el.innerHTML =
      '<div class="sk-sp-inner">' +
        /* Vector wordmark — bag icon + SOKONI text, always 100% crisp at any DPI. */
        '<img class="sk-sp-logo" src="assets/sokoni logoo.jpeg" alt="SOKONI">' +
        '<div class="sk-sp-line">' + cfg.line + '</div>' +
        '<div class="sk-sp-bar"><div class="sk-sp-fill" style="background:' + cfg.bar + '"></div></div>' +
      '</div>';

    /* Insert as first child of body, or body-substitute if body not yet parsed */
    function _mount() {
      const target = document.body || document.documentElement;
      target.insertBefore(el, target.firstChild);
    }
    if (document.body) { _mount(); }
    else { document.addEventListener('DOMContentLoaded', _mount, { once: true }); }

    /* ── Dismiss: wait for page load + minimum display time ── */
    const _MIN = 1900;
    const _start = Date.now();
    function _dismiss() {
      const wait = Math.max(0, _MIN - (Date.now() - _start));
      setTimeout(function () {
        el.classList.add('out');
        setTimeout(function () { el.remove(); style.remove(); }, 600);
      }, wait);
    }
    if (document.readyState === 'complete') { _dismiss(); }
    else {
      /* Hard failsafe: if window.load stalls (slow CDN resource, iOS Safari edge case),
         the splash must never block the app indefinitely. Guard ensures _dismiss runs
         at most once regardless of which path fires first. */
      var _ssDone = false;
      function _guardDismiss() { if (_ssDone) return; _ssDone = true; _dismiss(); }
      window.addEventListener('load', _guardDismiss, { once: true });
      setTimeout(_guardDismiss, 4000);
    }
  }());

  /* ── PHASE 1: Infrastructure injection — runs on EVERY page ──────────
     All pages get tokens/UI/layout/notif regardless of nav exclusion.
     This gives every page: design tokens, toast system, layout manager,
     notification engine, and notification center bell/panel.         */

  /* Absolutize a relative asset path so it resolves to the SITE ROOT, not the current URL.
     On path-prefixed pages (/shop/**, /@**, /profile/**) a relative "sokoni-x.css" resolves to
     "/shop/sokoni-x.css" → 404 → the whole design system fails to load and the page looks blank. */
  function _skAbs(p) {
    return (typeof p === 'string' && !/^(https?:|\/|data:|blob:)/.test(p)) ? '/' + p : p;
  }

  function _injectAsset(tag, attrs, id) {
    if (document.getElementById(id)) return;
    const el = document.createElement(tag);
    el.id = id;
    const a = Object.assign({}, attrs);
    if (a.href) a.href = _skAbs(a.href);
    if (a.src)  a.src  = _skAbs(a.src);
    Object.assign(el, a);
    (document.head || document.documentElement).appendChild(el);
  }

  /* Design tokens (CSS) — load first; tokens referenced by all CSS */
  _injectAsset('link', { rel: 'stylesheet', href: 'sokoni-tokens.css' }, 'sk-tokens-link');
  /* Canonical toast containment — makes every toast on the page viewport-safe
     (width clamp + safe-area + bottom-nav clearance) WITHOUT rewriting the ~81
     page-local toast implementations. Must load after the tokens it reads
     (--sk-safe-*, --sk-bottom-nav-h, --sk-z-toast). See sokoni-toast.css. */
  _injectAsset('link', { rel: 'stylesheet', href: 'sokoni-toast.css' }, 'sk-toast-link');
  /* Premium component library — .sk-card, .sk-btn-*, .sk-badge, .sk-stat, etc. */
  _injectAsset('link', { rel: 'stylesheet', href: 'sokoni-components.css' }, 'sk-components-link');
  /* Quality design system — --so-* tokens, focus-visible ring, WCAG touch targets, skip links */
  _injectAsset('link', { rel: 'stylesheet', href: 'sokoni-quality.css' }, 'sk-quality-link');
  /* Design System v1.0 — gap-filling components: search, tags, tabs, tooltip, dropdown,
     pagination, chart wrapper, typography scale, switch, quick actions, progress (.sk-*),
     animation utilities, form feedback, page headers, extended card parts. Loads after
     sokoni-components.css so .sk-* tokens are already defined. */
  _injectAsset('link', { rel: 'stylesheet', href: 'sokoni-ds.css' }, 'sk-ds-link');
  /* UI library — shared toast / modal / spinner / skeleton */
  _injectAsset('script', { src: 'sokoni-ui.js', defer: true }, 'sk-ui-script');
  /* Design System JS — window.SK unified API; delegates to SokoniUI for existing features,
     adds SK.form.*, SK.search.init(), SK.tabs.init(), SK.dropdown.init(), SK.loading.btn*,
     SK.alert(), SK.badge(). Loaded after sokoni-ui.js so SokoniUI is available. */
  _injectAsset('script', { src: 'sokoni-ds.js', defer: true }, 'sk-ds-script');
  /* Sticky Quick Actions — ONE component, adopted by every hub's existing action row.
     It has to be JS, not a CSS class: 116 pages scroll an inner container, where sticky
     resolves against that container rather than the viewport, so the correct top offset
     differs per page and only the DOM knows which. */
  _injectAsset('script', { src: 'sokoni-quick-actions.js', defer: true }, 'sk-qa-script');
  /* Delight layer (sokoni-delight.js) — BUILT BUT NOT SHIPPED.
     The module exists in the repo and is ready, but it has NOT been authorised for
     production. Injecting it here would ship it on all 302 pages with the next hosting
     deploy, so the inject stays commented out until it is signed off.
     To enable: uncomment the line below. Nothing else is required.

     _injectAsset('script', { src: 'sokoni-delight.js', defer: true }, 'sk-delight-script');
  */
  /* NO footer component is injected here.
     The premium footer is PAGE MARKUP (<footer class="footer">) styled by style.css —
     including .footer::before, which layers the dark gradient over
     assets/sokoni footer.png. That is the production footer and it is not generated.
     sokoni-footer.js (the card-based rewrite) was a regression and has been removed;
     it also deleted any <footer class="footer"> it found at runtime, so leaving it
     loaded here would silently wipe the restored footer. Rolled back to 911a042. */
  /* Layout manager — resolves floating element overlaps, sets CSS vars */
  _injectAsset('script', { src: 'sokoni-layout.js', defer: true }, 'sk-layout-script');
  /* Zero Trust, Performance and Observability stay EAGER: their init hooks below run
     one-shot on `load` and expect the global to already exist, so deferring the script
     past `load` would silently skip initialisation. */
  /* Zero Trust client SDK — device fingerprint, risk cache, step-up auth guard */
  _injectAsset('script', { src: 'sokoni-zero-trust.js', defer: true }, 'sk-zero-trust-script');
  /* Phase 3 — Performance SDK: lazy loading, WebP, prefetch, optimistic UI (also
     optimises first-paint images, so it earns its eager slot). */
  _injectAsset('script', { src: 'sokoni-performance.js', defer: true }, 'sk-performance-script');
  /* Phase 3 — Observability SDK: error tracking, Core Web Vitals, user journey */
  _injectAsset('script', { src: 'sokoni-observability.js', defer: true }, 'sk-observability-script');

  /* P2A — NOT needed for first paint: notifications (bell UI + engine), the shared
     full-screen sheet, validation mode (off unless ?validate=1), resilience, and the
     Ctrl+K command palette. Loaded eagerly these cost ~160 KB of startup parse/execute
     on EVERY page. Inject them after `load`, on main-thread idle, in order (sheet before
     notif-center, which adopts it). async=false keeps execution ordered while allowing
     parallel download. Each self-initialises when it lands, so the bell/palette simply
     appear a beat later instead of blocking the product grid. */
  (function _sokoniIdleModules() {
    var LAZY = [
      ['sokoni-sheet.js',           'sk-sheet-script'],
      ['sokoni-notif-engine.js',    'sk-notif-engine-script'],
      ['sokoni-notif-center.js',    'sk-notif-center-script'],
      ['sokoni-resilience.js',      'sk-resilience-script'],
      ['sokoni-validate.js',        'sk-validate-script'],
      ['sokoni-command-palette.js', 'sk-command-palette-script'],
    ];
    function flush() {
      LAZY.forEach(function (m) {
        if (document.getElementById(m[1])) return;
        var s = document.createElement('script');
        s.src = _skAbs(m[0]); s.async = false; s.id = m[1];   /* ordered exec, parallel download */
        document.head.appendChild(s);
      });
    }
    function start() { (window.requestIdleCallback || function (f) { setTimeout(f, 200); })(flush, { timeout: 3000 }); }
    if (document.readyState === 'complete') start();
    else window.addEventListener('load', start, { once: true });
  }());

  /* Initialize Observability after page load */
  (function () {
    window.addEventListener('load', function () {
      if (window.SokoniObservability) {
        window.SokoniObservability.init({
          projectId:   'sokoni-aeb26',
          appVersion:  (window.SOKONI_VERSION || '1.0.0'),
          environment: 'production',
        });
      }
    }, { once: true });
  }());

  /* Initialize Zero Trust after Firebase auth is available */
  (function () {
    function _initZT() {
      if (window.SokoniZeroTrust) { window.SokoniZeroTrust.init(); return; }
      setTimeout(_initZT, 400);
    }
    window.addEventListener('load', function () { setTimeout(_initZT, 600); }, { once: true });
  }());

  /* ── Offline development mock layer — lazy-loads ONLY when Firebase is
     unavailable. Zero cost in production when Firebase is connected.
     Force-activate at any time with URL param: ?offline=1             */
  (function () {
    const _forceOffline = location.search.includes('offline=1') || localStorage.getItem('sokoni_force_offline') === '1';
    function _loadMock() {
      if (document.getElementById('sk-mock-data')) return;
      const d = document.createElement('script'); d.id = 'sk-mock-data'; d.src = _skAbs('sokoni-mock-data.js');
      d.onload = function () {
        const m = document.createElement('script'); m.id = 'sk-mock-engine'; m.src = _skAbs('sokoni-dev-mock.js');
        document.head.appendChild(m);
      };
      document.head.appendChild(d);
    }
    if (_forceOffline) {
      window.__sokoniForceOffline = true;
      if (document.readyState === 'loading') { document.addEventListener('DOMContentLoaded', _loadMock); } else { _loadMock(); }
    } else if (_isDevHost()) {
      /* Only auto-load the mock on a DEV host.
         sokoni-mock-data.js and sokoni-dev-mock.js are in firebase.json's `ignore`
         list — they are deliberately NEVER deployed. So this fallback could never
         work in production; all it did there was fire a guaranteed 404 on every page
         that had not set window.firebaseDB within 2.5s (legal-centre was one).
         An offline mock that is not deployed cannot rescue an offline user. */
      window.addEventListener('load', function () {
        setTimeout(function () { if (!window.firebaseDB) _loadMock(); }, 2500);
      }, { once: true });
    }

    function _isDevHost() {
      var h = location.hostname;
      return h === 'localhost' || h === '127.0.0.1' || h === '' || /^192\.168\./.test(h);
    }
  }());

  /* Global polish stylesheet (once) */
  if (!document.getElementById('sk-polish-link')) {
    const polishLink = document.createElement('link');
    polishLink.rel = 'stylesheet';
    polishLink.id = 'sk-polish-link';
    polishLink.href = _skAbs('sokoni-polish.css');
    (document.head || document.documentElement).appendChild(polishLink);
  }

  /* Global mobile responsive fixes (once) */
  if (!document.getElementById('sk-mobile-fixes-link')) {
    const mfLink = document.createElement('link');
    mfLink.rel = 'stylesheet';
    mfLink.id = 'sk-mobile-fixes-link';
    mfLink.href = _skAbs('sokoni-mobile-fixes.css');
    (document.head || document.documentElement).appendChild(mfLink);
  }

  /* Responsive v2 — premium UI/UX overhaul (once) */
  if (!document.getElementById('sk-responsive-link')) {
    const respLink = document.createElement('link');
    respLink.rel = 'stylesheet';
    respLink.id = 'sk-responsive-link';
    respLink.href = _skAbs('sokoni-responsive.css');
    (document.head || document.documentElement).appendChild(respLink);
  }

  /* Premium design system — dark theme, compact layout, glass cards (once) */
  if (!document.getElementById('sk-premium-link')) {
    const premLink = document.createElement('link');
    premLink.rel = 'stylesheet';
    premLink.id = 'sk-premium-link';
    premLink.href = _skAbs('premium.css');
    (document.head || document.documentElement).appendChild(premLink);
  }

  /* sokoni-premium-v2.css — phase 2 premium overrides (once) */
  if (!document.getElementById('sk-premium-v2-link')) {
    const pv2Link = document.createElement('link');
    pv2Link.rel = 'stylesheet';
    pv2Link.id = 'sk-premium-v2-link';
    pv2Link.href = _skAbs('sokoni-premium-v2.css');
    (document.head || document.documentElement).appendChild(pv2Link);
  }

  /* Menu button opener — resilient to SokoniDrawer not being ready at tap time.
     Dynamic scripts ignore `defer` and load async, creating a window where
     window.SokoniDrawer is undefined. This queues the open and flushes it on load. */
  window._skOpenMenu = function(btn) {
    if (window.SokoniDrawer) {
      window.SokoniDrawer.open('sk-menu-drawer');
      if (btn) btn.setAttribute('aria-expanded', 'true');
    } else {
      // Store the button reference so onload can set aria-expanded
      window._skMenuPending = btn || document.getElementById('sk-menu-btn');
    }
  };

  /* Universal drawer system — CSS + JS (once) */
  if (!document.getElementById('sk-drawers-link')) {
    const drawLink = document.createElement('link');
    drawLink.rel = 'stylesheet';
    drawLink.id = 'sk-drawers-link';
    drawLink.href = _skAbs('sokoni-drawers.css');
    (document.head || document.documentElement).appendChild(drawLink);
  }
  if (!document.getElementById('sk-drawer-script')) {
    const drawScript = document.createElement('script');
    drawScript.id = 'sk-drawer-script';
    drawScript.src = _skAbs('sokoni-drawer.js');
    drawScript.onload = function() {
      if (window._skMenuPending && window.SokoniDrawer) {
        const _pendBtn = window._skMenuPending;
        window._skMenuPending = null;
        window.SokoniDrawer.open('sk-menu-drawer');
        if (_pendBtn && _pendBtn.setAttribute) _pendBtn.setAttribute('aria-expanded', 'true');
      }
    };
    (document.head || document.documentElement).appendChild(drawScript);
  }

  /* Promotion renderer — pages opt in with <div data-promo="home_hero"></div>.
     One injection point, so no page needs editing to receive promotions. */
  if (!document.getElementById('sk-promo-script')) {
    const promoJs = document.createElement('script');
    promoJs.id = 'sk-promo-script';
    promoJs.src = _skAbs('sokoni-promotions.js');
    promoJs.defer = true;
    (document.head || document.documentElement).appendChild(promoJs);
  }

  /* Smart offline detection — shows banner only when truly offline */
  if (!document.getElementById('sk-offline-script')) {
    const offlineJs = document.createElement('script');
    offlineJs.id = 'sk-offline-script';
    offlineJs.src = _skAbs('sokoni-offline.js');
    offlineJs.defer = true;
    (document.head || document.documentElement).appendChild(offlineJs);
  }

  /* Floating button manager — repositions FABs above bottom nav */
  if (!document.getElementById('sk-float-script')) {
    const floatJs = document.createElement('script');
    floatJs.id = 'sk-float-script';
    floatJs.src = _skAbs('sokoni-float.js');
    floatJs.defer = true;
    (document.head || document.documentElement).appendChild(floatJs);
  }

  /* Role-based navigation engine — CSS + JS (once, runs on all pages) */
  if (!document.getElementById('sk-nav-engine-link')) {
    const navCss = document.createElement('link');
    navCss.rel = 'stylesheet';
    navCss.id = 'sk-nav-engine-link';
    navCss.href = _skAbs('sokoni-nav-engine.css');
    (document.head || document.documentElement).appendChild(navCss);
  }
  if (!document.getElementById('sk-nav-engine-script')) {
    const navJs = document.createElement('script');
    navJs.id = 'sk-nav-engine-script';
    navJs.src = _skAbs('sokoni-nav-engine.js');
    navJs.defer = true;
    (document.head || document.documentElement).appendChild(navJs);
  }

  /* Universal Form Engine — mobile scrollability, keyboard avoidance, safe areas */
  if (!document.getElementById('sk-form-engine-link')) {
    const feLink = document.createElement('link');
    feLink.rel = 'stylesheet';
    feLink.id = 'sk-form-engine-link';
    feLink.href = _skAbs('sokoni-form-engine.css');
    (document.head || document.documentElement).appendChild(feLink);
  }
  if (!document.getElementById('sk-form-engine-script')) {
    const feJs = document.createElement('script');
    feJs.id = 'sk-form-engine-script';
    feJs.src = _skAbs('sokoni-form-engine.js');
    feJs.defer = true;
    (document.head || document.documentElement).appendChild(feJs);
  }

  /* ── Platform override — injected after DOMContentLoaded so it sits at the
     END of the cascade and wins over every page-level <style> block.
     This normalises token aliases and enforces premium dark theme globally. ── */
  (function _injectPlatformOverride() {
    function _doInject() {
      if (document.getElementById('sk-platform-override')) return;
      const lnk = document.createElement('link');
      lnk.rel  = 'stylesheet';
      lnk.id   = 'sk-platform-override';
      lnk.href = _skAbs('sokoni-platform-override.css');
      document.head.appendChild(lnk);
    }
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', _doInject, { once: true });
    } else {
      _doInject();
    }
  }());

  /* ── PHASE 2: Nav injection — excluded pages stop here ──────────── */
  const EXCLUDED = [
    'pos.html', 'seller.html', 'login.html', 'signup.html',
    'register.html', 'success.html', 'offline.html',
    /* cleanUrls:true strips .html — also match extension-free variants */
    'pos', 'seller', 'login', 'signup', 'register', 'success', 'offline',
    /* Profile has its own fully-featured .upn navigation bar */
    'profile.html', 'profile',
    /* Enterprise full-screen dashboards — have their own specialized nav */
    'ecc.html', 'wap.html', 'gip.html', 'platform.html',
    'sasos-admin.html', 'pos-kiosk.html', 'superadmin.html',
    'monitor.html', 'moderation.html', 'verification-admin.html',
    'ecc', 'wap', 'gip', 'platform', 'sasos-admin', 'pos-kiosk',
    'superadmin', 'monitor', 'moderation', 'verification-admin',
  ];
  const page = location.pathname.split('/').pop().split('?')[0] || 'index.html';
  /* The merchant shell announces itself with ?shell=merchant. Kept as one function so
     there is a single definition of "am I embedded", rather than the string appearing
     at each place that needs to know. */
  function _inMerchantShell() {
    try {
      return new URLSearchParams(location.search).get('shell') === 'merchant';
    } catch (e) { return false; }
  }
  /* firebase.json sets cleanUrls:true, so production serves /messages — never
     /messages.html (that 301-redirects). The page key is therefore ALWAYS extension-free,
     while the lists below are written with .html. Strip it from both sides before
     comparing. EXCLUDED survived this only because somebody hand-wrote both spellings of
     all 17 entries; NO_SEARCH did not, so all 12 of its pages silently never matched in
     production and kept the header's search bar. Normalise once, here, rather than asking
     every future list to remember the two spellings. */
  const pageKey = page.replace(/\.html$/, '');
  const _match = (list) => list.some((e) => e.replace(/\.html$/, '') === pageKey);
  if (_match(EXCLUDED)) return;
  if (document.documentElement.dataset.noHeader === 'true') return;
  /* Inside the merchant shell, /merchant owns the header and the bottom nav; an
     embedded destination contributes CONTENT ONLY.

     This used to be per-page opt-in — every embedded page had to remember
     data-no-header="true". plans.html and pos.html did; sell.html and business.html
     did not, so opening either from /merchant mounted a SECOND complete application
     inside the merchant shell: two fixed headers and two bottom navs (customer
     Home/Shop/Services/Orders/Profile on top of merchant Home/Orders/Sell/More).

     The shell already announces itself with ?shell=merchant (sokoni-merchant-routes.js).
     Reading that here makes suppression a property of BEING EMBEDDED rather than of a
     page remembering an attribute, so destinations added later cannot regress into the
     same double-shell. Standalone /sell.html and /business.html are unaffected — no
     shell parameter, customer shell mounts exactly as before. */
  if (_inMerchantShell()) return;
  /* NOTE: pages that bake #sk-top-nav as static HTML (e.g. index.html) still need
     the CSS injection and event wiring below — _inject() handles that gracefully
     by checking whether the nav already exists before calling _buildNav(). */

  /* ── Pages where search bar is hidden — computed BEFORE CSS injection ── */
  const NO_SEARCH = [
    'checkout.html', 'cart.html', 'track.html', 'messages.html',
    'dispute.html', 'invoice.html', 'notifications.html',
    'profile.html', 'reviews.html', 'referral.html',
    'subscriptions.html', 'loyalty.html',
    /* Admin/console pages must NOT get the MARKETPLACE product search — typing an
       email returned products (Johnnie Walker, MacBook…). Admin searches its own
       entities within its panes. Both forms because cleanUrls serves prod extensionless
       (the '.html' entries above silently never match in prod — see the note above). */
    'admin.html', 'admin', 'super-admin.html', 'super-admin',
  ];
  const showSearch = !_match(NO_SEARCH);

  /* ── CSS (injected into <head> immediately to prevent flash) ── */
  const CSS = `
    /* ── Skip navigation link (keyboard / screen-reader users) ── */
    #sk-skip-nav {
      position: absolute; top: -100%; left: 0; z-index: var(--sk-z-emergency, 999);
      background: #71ff00; color: #000; padding: 10px 20px;
      font-weight: 800; font-size: 14px; text-decoration: none;
      border-radius: 0 0 8px 0; transition: top .15s;
    }
    #sk-skip-nav:focus { top: 0; }

    /* ── Shared top header — floats transparently over the hero, darkens on scroll ── */
    #sk-top-nav {
      position: fixed; top: 0; left: 0; right: 0; z-index: 100001;
      height: 58px;
      display: flex; align-items: center; gap: 8px; padding: 0 20px;
      background: transparent;
      backdrop-filter: none; -webkit-backdrop-filter: none;
      border-bottom: none;
      box-shadow: none;
      /* No will-change/translateZ promotion here — deliberately. This header
         never animates transform (it only transitions background/backdrop/
         shadow on scroll), so 'will-change: transform' bought nothing and had a
         real cost: it promotes the fixed header to a GPU compositing layer, and
         iOS Safari CLIPS an absolutely-positioned descendant that extends past
         that layer's box to the layer's backing store. That is why the search
         autocomplete showed only its first row — rows 2-6 hang below the 58px
         header and were clipped away. The header still forms its own stacking
         context (position: fixed + z-index), so it keeps painting above the
         hero; it simply no longer traps and clips the dropdown. */
      transition: background .3s ease, backdrop-filter .3s ease,
                  box-shadow .3s ease, border-color .3s ease;
    }
    /* Gradient veil — ensures logo + icons read on any hero image */
    #sk-top-nav::before {
      content: '';
      position: absolute; inset: 0;
      background: linear-gradient(to bottom, rgba(0,0,0,0.48) 0%, transparent 100%);
      pointer-events: none; z-index: -1;
    }
    /* Darkens once the user scrolls past the hero */
    #sk-top-nav.sk-scrolled {
      background: rgba(5,5,5,0.92);
      backdrop-filter: blur(28px) saturate(1.3); -webkit-backdrop-filter: blur(28px) saturate(1.3);
      border-bottom: 1px solid rgba(255,255,255,0.06);
      box-shadow: 0 1px 0 rgba(113,255,0,0.05), 0 4px 32px rgba(0,0,0,0.5);
    }
    #sk-top-nav.sk-scrolled::before { display: none; }
    /* ── Hide page-specific navs — preserve .sk-sub-nav tab bars ── */
    body > nav:not(#sk-top-nav):not(.bottom-nav):not(.sk-sub-nav),
    body > [role="navigation"]:not(#sk-top-nav):not(.bottom-nav):not(.sk-sub-nav),
    body > header { display: none !important; }

    /* ── Sub-nav tab bars: stick below the 58px shared header ── */
    /* ── Sticky hub sub-navs (Services "List My Service", Healthcare, Property, …) ──
       This used to be a hardcoded top of 58px. That is the header's height on a WIDE
       screen. On a phone the header wraps its search box onto a second row and is ~110px
       tall — so every hub sub-nav on the platform stuck 50px TOO HIGH, tucked underneath
       the header, and the header's search input swallowed every tap aimed at the primary
       CTA sitting in it.

       The bar was sticky. It was even visible. It simply could not be pressed — which is
       indistinguishable, to a user, from a button that scrolls away and does nothing.

       The offset is now MEASURED from the header itself (--sk-header-h, published below
       and re-measured on resize/rotate), so it cannot drift from reality again. A layout
       constant that describes the layout on only one class of device is not a constant. */
    .sk-sub-nav {
      position: sticky !important;
      top: var(--sk-header-h, 58px) !important;
      z-index: 100 !important;
      box-shadow: 0 2px 10px rgba(0,0,0,0.28), 0 1px 0 rgba(113,255,0,0.05) !important;
    }
    /* ── Hub logos inside sub-navs: suppressed — branding lives in sk-top-nav ── */
    .sk-sub-nav [class*="-nav-logo"],
    body > .sk-sub-nav .hc-nav-logo,
    body > .sk-sub-nav .sv-nav-logo,
    body > .sk-sub-nav .ch-nav-logo,
    body > .sk-sub-nav .th-nav-logo,
    body > .sk-sub-nav .en-nav-logo {
      display: none !important;
    }
    /* ── Hub nav inner rows: horizontal scroll, no wrap, 44px touch targets ── */
    .sk-sub-nav [class*="-nav-right"],
    .sk-sub-nav [class*="-nav-tabs"] {
      overflow-x: auto !important;
      -webkit-overflow-scrolling: touch !important;
      overscroll-behavior-x: contain !important;
      scrollbar-width: none !important;
      -ms-overflow-style: none !important;
    }
    .sk-sub-nav [class*="-nav-right"]::-webkit-scrollbar,
    .sk-sub-nav [class*="-nav-tabs"]::-webkit-scrollbar { display: none !important; }
    /* ── Hub nav link items: no squeeze, no wrap, proper touch targets ──
       This said "proper touch targets" and then set 40px. 44px is the iOS floor — below
       it, a control is reliably mis-tapped, and this rule is !important so it was the
       thing PREVENTING the very touch targets its comment promised. The primary CTA in
       every hub sub-nav ("List My Service", "Register Facility", "List Property") sits
       in here. */
    /* Scoped to the nav ITEMS, deliberately — not to every anchor in the bar. A blanket
       descendant selector also matches the LOGO anchor, and forcing that to 44px
       inline-flex reflows the whole row and pushes the CTA off the right edge of a phone.
       It made the button bigger and unreachable, which is a strictly worse bug than the
       one it was fixing. Measured that, then narrowed it. */
    /* NO display declaration here, deliberately.

       [class*="-nav-link"] is a SUBSTRING match, so it also matches the CONTAINER
       .sv-nav-links — the desktop-only centre links, which are display:none on a phone.
       Adding display:inline-flex !important overrode that and forced them visible on
       mobile, blowing the bar from 390px to 729px and shoving the primary CTA clean off
       the right edge of the screen. The button was 44px, sticky, and unreachable.

       It is not needed anyway: these items are flex children of .sv-nav-right, so
       min-height applies to them without touching display. Set the size; leave the layout
       alone. */
    .sk-sub-nav [class*="-nav-link"],
    .sk-sub-nav [class*="-nav-tab"],
    .sk-sub-nav [class*="-nav-btn"],
    .sk-sub-nav [class*="-nav-sell"] {
      flex-shrink: 0 !important;
      white-space: nowrap !important;
      min-height: 44px !important;
    }

    /* NOT overflow-x:auto here. I tried it, measured it, and it was worse: on a flex
       container, allowing horizontal overflow stops the children shrinking, so the row
       grew from 390px to 729px and pushed the primary CTA clean OFF the right edge of the
       phone. The bar became scrollable and the button became unreachable — a strictly
       worse bug than the clipping it was meant to prevent.

       The row already fits: the centre links are desktop-only, so on a phone the bar holds
       just the logo and the right-hand actions. Leave the flex shrinking alone. */

    /* ── Hide home-page orphaned floating elements (hamburger + bell) ──
       These are <div> elements so the nav rule above doesn't catch them.
       style.css already pre-hides them, but this JS-injected rule provides
       the same guarantee on pages where style.css loads after this script. */
    .menu-toggle,
    #sokoni-bell-btn { display: none !important; }

    /* ── Ensure content is never hidden under the fixed header ── */
    body { padding-top: max(58px, calc(58px + env(safe-area-inset-top, 0px))) !important; }

    /* ── Logo — no card, no box, just the mark ── */
    #sk-nav-logo {
      display: flex; align-items: center; flex-shrink: 0; text-decoration: none;
      margin-right: 2px;
    }
    #sk-nav-logo img {
      height: 28px; width: auto; object-fit: contain; display: block;
      filter: brightness(1.04) drop-shadow(0 0 6px rgba(113,255,0,0.12));
      transition: filter .22s ease, transform .2s ease;
    }
    #sk-nav-logo:hover img {
      filter: brightness(1.1) drop-shadow(0 0 14px rgba(113,255,0,0.38));
      transform: scale(1.04);
    }
    /* Suppress text fallback — logo image is the brand */
    #sk-nav-logo-text { display: none !important; }

    /* ── Search ── */
    #sk-nav-search-wrap {
      flex: 1; min-width: 0; max-width: 520px; margin: 0 10px; position: relative;
    }
    #sk-nav-search {
      width: 100%; padding: 10px 16px 10px 40px;
      /* box-sizing: without it, width:100% + 56px horizontal padding makes the
         input's border-box 56px WIDER than #sk-nav-search-wrap on any page that
         lacks a global box-sizing reset, so its right edge (and the tail of the
         placeholder) overruns and is clipped. border-box folds the padding into
         the 100%, so the field is exactly as wide as its wrapper. */
      box-sizing: border-box;
      /* appearance: none removes the iOS Safari native searchfield styling.
         type=search on iOS renders its own constrained text box (and a cancel
         decoration) that clips the placeholder and collides with autofill — the
         reported symptom. Resetting appearance makes it a plain text field that
         fills the width. Pseudo-element resets below drop the native buttons. */
      -webkit-appearance: none; appearance: none;
      background: rgba(255,255,255,0.07); border: 1px solid rgba(255,255,255,0.12);
      border-radius: 28px; color: rgba(255,255,255,0.92); font-size: 14px;
      font-family: 'Segoe UI', system-ui, sans-serif; outline: none;
      transition: border-color .2s, background .2s, box-shadow .2s;
    }
    #sk-nav-search::-webkit-search-decoration,
    #sk-nav-search::-webkit-search-cancel-button,
    #sk-nav-search::-webkit-search-results-button,
    #sk-nav-search::-webkit-search-results-decoration { -webkit-appearance: none; display: none; }
    #sk-nav-search:focus {
      border-color: rgba(113,255,0,0.45);
      background: rgba(255,255,255,0.1);
      box-shadow: 0 0 0 3px rgba(113,255,0,0.08), 0 4px 20px rgba(0,0,0,0.3);
    }
    #sk-nav-search::placeholder {
      color: rgba(255,255,255,0.32); font-size: 14px;
      /* Show the full placeholder instead of Safari's default clip-to-fit. */
      text-overflow: ellipsis; overflow: hidden;
    }
    #sk-nav-search-icon {
      position: absolute; left: 14px; top: 50%; transform: translateY(-50%);
      font-size: 15px; pointer-events: none; opacity: .45;
    }

    /* ── Autocomplete dropdown ── */
    #sk-nav-search-dropdown {
      position: absolute; top: calc(100% + 6px); left: 0; right: 0;
      /* Opaque fill and NO backdrop-filter — deliberately. The header is a
         promoted compositing layer (will-change: transform), and the hero card
         has its own backdrop-filter. On iOS Safari a backdrop-filter element
         inside a promoted layer can be composited BEHIND another page element
         that also uses backdrop-filter — which is exactly the "search dropdown
         hides behind the hero" report. A solid panel samples nothing across that
         layer boundary, so it reads above the hero on every engine; the blur was
         invisible anyway behind a near-opaque fill. */
      background: #0e0e0e;
      border: 1px solid rgba(255,255,255,0.1);
      border-radius: 16px;
      /* Cap the height and scroll INSIDE the panel. Without this the list has
         no max-height, so on a phone with the keyboard open the lower rows sit
         behind the keyboard with no way to reach them — "only the top shows,
         the rest is cut". min(62vh,460px) is the safe default; the visualViewport
         handler in _wireSearch tightens it to the real space above the keyboard
         when one is open, so nothing is ever unreachable on any device. */
      max-height: min(62vh, 460px);
      overflow-y: auto; overflow-x: hidden;
      -webkit-overflow-scrolling: touch; overscroll-behavior: contain;
      box-shadow: 0 12px 40px rgba(0,0,0,0.6);
      z-index: 100002; display: none;
    }
    /* Slim scrollbar so the scroll affordance does not look broken on desktop. */
    #sk-nav-search-dropdown::-webkit-scrollbar { width: 8px; }
    #sk-nav-search-dropdown::-webkit-scrollbar-thumb {
      background: rgba(255,255,255,0.16); border-radius: 8px;
    }
    #sk-nav-search-dropdown.open { display: block; }
    .sk-ac-item {
      display: flex; align-items: center; gap: 10px;
      padding: 10px 16px; cursor: pointer;
      transition: background .12s;
      text-decoration: none; color: rgba(255,255,255,0.82);
      font-size: 13px; font-family: 'Segoe UI', system-ui, sans-serif;
    }
    .sk-ac-item:hover, .sk-ac-item.focused { background: rgba(255,255,255,0.06); }
    .sk-ac-item-icon { font-size: 16px; flex-shrink: 0; width: 22px; text-align: center; }
    .sk-ac-item-text { flex: 1; min-width: 0; }
    .sk-ac-item-name { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .sk-ac-item-meta { font-size: 10px; color: rgba(255,255,255,0.3); margin-top: 1px; }
    .sk-ac-item-price { font-size: 11px; font-weight: 800; color: #71ff00; flex-shrink: 0; }
    .sk-ac-footer {
      padding: 8px 16px; border-top: 1px solid rgba(255,255,255,0.05);
      font-size: 11px; color: rgba(255,255,255,0.3); text-align: center;
    }
    .sk-ac-footer a { color: #71ff00; text-decoration: none; font-weight: 700; }
    .sk-ac-section-hd {
      font-size: 10px; font-weight: 800; color: rgba(255,255,255,0.25);
      text-transform: uppercase; letter-spacing: .1em;
      padding: 9px 14px 3px; pointer-events: none;
    }

    /* ── Action buttons ── */
    #sk-nav-actions { display: flex; align-items: center; gap: 2px; flex-shrink: 0; margin-left: auto; }
    .sk-nav-icon-btn {
      display: flex; align-items: center; justify-content: center;
      width: 38px; height: 38px; border-radius: 50%;
      background: transparent; border: none; cursor: pointer;
      font-size: 17px; text-decoration: none; color: inherit; position: relative;
      transition: background .15s;
    }
    .sk-nav-icon-btn:hover { background: rgba(255,255,255,0.08); }
    .sk-nav-icon-btn:active { background: rgba(255,255,255,0.18); }

    /* ── Touch targets ──────────────────────────────────────────────────────
       The header is deliberately slim: icons render 34px (30px on small
       phones) and the cart pill / avatar measured 34px tall. That is below the
       44x44 CSS-px minimum in WCAG 2.5.8 and the Apple HIG, so these were
       genuinely hard to tap.

       Enlarging the boxes would fatten the bar and undo the 64->58px premium
       header. Instead, extend the HIT AREA with an invisible centred pseudo-
       element. The visual design is unchanged; only the tappable region grows. */
    .sk-nav-icon-btn, #sk-nav-cart, #sk-nav-avatar, #sk-nav-logo { position: relative; }
    .sk-nav-icon-btn::after,
    #sk-nav-cart::after,
    #sk-nav-avatar::after,
    #sk-nav-logo::after {
      content: '';
      position: absolute;
      left: 50%; top: 50%;
      transform: translate(-50%, -50%);
      width: 100%; height: 100%;
      min-width: 44px; min-height: 44px;
    }

    /* ── Transparent-nav state: gradient veil handles readability — no per-icon dark circles ── */
    #sk-top-nav:not(.sk-scrolled) .sk-nav-icon-btn {
      background: transparent;
      text-shadow: 0 1px 6px rgba(0,0,0,0.75), 0 0 2px rgba(0,0,0,0.6);
    }
    #sk-top-nav:not(.sk-scrolled) .sk-nav-icon-btn:hover {
      background: rgba(255,255,255,0.1);
      text-shadow: none;
    }
    /* Search bar: more opaque when floating over hero */
    #sk-top-nav:not(.sk-scrolled) #sk-nav-search {
      background: rgba(0,0,0,0.38);
      border-color: rgba(255,255,255,0.2);
    }
    #sk-top-nav:not(.sk-scrolled) #sk-nav-search::placeholder {
      color: rgba(255,255,255,0.45);
    }
    /* Cart pill and avatar on transparent nav */
    #sk-top-nav:not(.sk-scrolled) #sk-nav-cart {
      background: rgba(0,0,0,0.28);
      border-color: rgba(113,255,0,0.3);
    }
    #sk-top-nav:not(.sk-scrolled) #sk-nav-avatar {
      background: rgba(0,0,0,0.3);
      border-color: rgba(113,255,0,0.4);
    }

    /* ── Theme toggle specific ── */
    #sk-theme-btn { font-size: 16px; }
    #sk-theme-btn:hover { background: rgba(113,255,0,0.1); }

    /* ── Activity button ── */
    #sk-activity-btn { font-size: 17px; }

    /* ── Hamburger menu button ── */
    #sk-menu-btn { font-size: 20px; letter-spacing: -1px; }
    #sk-menu-btn:hover { background: rgba(255,255,255,0.08); }

    /* ── Unread count badges ── */
    .sk-badge {
      position: absolute; top: 4px; right: 4px;
      min-width: 16px; height: 16px; border-radius: 10px;
      font-size: 9px; font-weight: 900; line-height: 16px;
      padding: 0 4px; text-align: center;
      border: 2px solid #0a0a0a;
      display: none; pointer-events: none;
    }
    .sk-badge.visible { display: flex; align-items: center; justify-content: center; }
    #sk-notif-badge { background: #ff4d6d; color: #fff; }
    #sk-msg-badge   { background: #71ff00; color: #000; }
    #sk-activity-badge { background: #fbbf24; color: #000; }

    /* Keep old dot for pages that still read it */
    .sk-notif-dot {
      position: absolute; top: 6px; right: 6px;
      width: 8px; height: 8px; border-radius: 50%;
      background: #ff4d6d; border: 2px solid #0a0a0a;
      display: none;
    }
    .sk-notif-dot.visible { display: block; }

    /* ── Cart pill ── */
    #sk-nav-cart {
      display: flex; align-items: center; gap: 4px;
      padding: 7px 12px; border-radius: 20px;
      background: rgba(113,255,0,0.08); border: 1px solid rgba(113,255,0,0.18);
      color: #71ff00; font-size: 12px; font-weight: 700;
      text-decoration: none; transition: background .15s, border-color .15s; flex-shrink: 0;
    }
    #sk-nav-cart:hover { background: rgba(113,255,0,0.16); border-color: rgba(113,255,0,0.32); }
    #sk-nav-cart-pip {
      background: #71ff00; color: #000; border-radius: 20px;
      min-width: 15px; height: 15px; font-size: 9px; font-weight: 900;
      align-items: center; justify-content: center; padding: 0 3px;
      display: none;
    }

    /* ── Avatar ── */
    #sk-nav-avatar {
      width: 32px; height: 32px; border-radius: 50%;
      background: rgba(113,255,0,0.1); border: 1px solid rgba(113,255,0,0.24);
      display: flex; align-items: center; justify-content: center;
      font-size: 13px; font-weight: 900; color: #71ff00;
      text-decoration: none; flex-shrink: 0; transition: background .15s, border-color .15s;
      cursor: pointer;
    }
    #sk-nav-avatar:hover,
    #sk-nav-avatar[aria-expanded="true"] { background: rgba(113,255,0,0.18); border-color: rgba(113,255,0,0.4); }

    /* ── Account dropdown ── */
    .sk-acct-wrap { position: relative; flex-shrink: 0; }
    #sk-acct-popup {
      position: absolute; top: calc(100% + 10px); right: 0;
      min-width: 220px; background: #141414;
      border: 1px solid rgba(113,255,0,0.15); border-radius: 14px;
      box-shadow: 0 16px 40px rgba(0,0,0,.6);
      z-index: 99999; overflow: hidden;
      animation: skAcctIn .18s cubic-bezier(.19,1.32,.34,1);
    }
    @keyframes skAcctIn {
      from { opacity: 0; transform: translateY(-8px) scale(.97); }
      to   { opacity: 1; transform: none; }
    }
    .sk-acct-head {
      padding: 14px 16px 10px;
      border-bottom: 1px solid rgba(255,255,255,.07);
    }
    .sk-acct-name { font-size: 13.5px; font-weight: 700; color: #fff; }
    .sk-acct-email { font-size: 11.5px; color: rgba(255,255,255,.45); margin-top: 2px;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .sk-acct-links { padding: 6px 0; }
    .sk-acct-link {
      display: flex; align-items: center; gap: 10px;
      padding: 10px 16px; font-size: 13px; font-weight: 600;
      color: rgba(255,255,255,.8); text-decoration: none;
      transition: background .12s, color .12s; cursor: pointer;
      border: none; background: none; width: 100%; text-align: left;
    }
    .sk-acct-link:hover { background: rgba(113,255,0,.07); color: #71ff00; }
    .sk-acct-link i { width: 16px; text-align: center; font-size: 13px; color: rgba(255,255,255,.35); }
    .sk-acct-link:hover i { color: rgba(113,255,0,.7); }
    .sk-acct-separator { height: 1px; background: rgba(255,255,255,.06); margin: 4px 0; }
    .sk-acct-link-danger { color: rgba(255,77,77,.8) !important; }
    .sk-acct-link-danger:hover { background: rgba(255,77,77,.07) !important; color: #ff4d4d !important; }
    .sk-acct-link-danger i { color: rgba(255,77,77,.4) !important; }
    .sk-acct-role-strip { padding: 6px 16px 8px; }
    .sk-acct-role-label { font-size: 10px; font-weight: 700; letter-spacing: .08em;
      text-transform: uppercase; color: rgba(255,255,255,.25); margin-bottom: 6px; }
    .sk-acct-role-pills { display: flex; flex-wrap: wrap; gap: 5px; }
    .sk-acct-role-pill {
      padding: 4px 10px; border-radius: 20px; font-size: 11.5px; font-weight: 700;
      background: rgba(255,255,255,.06); border: 1px solid rgba(255,255,255,.1);
      color: rgba(255,255,255,.6); cursor: pointer; transition: all .12s;
    }
    .sk-acct-role-pill.active { background: rgba(113,255,0,.1); border-color: rgba(113,255,0,.28); color: #71ff00; }
    .sk-acct-role-pill:hover { background: rgba(113,255,0,.07); color: #71ff00; }

    /* ── Workspace switcher entries ── */
    .sk-acct-ws-section { padding: 4px 0 6px; }
    .sk-acct-ws-label {
      font-size: 10px; font-weight: 700; letter-spacing: .09em;
      text-transform: uppercase; color: rgba(255,255,255,.22);
      padding: 4px 16px 6px;
    }
    .sk-acct-ws-item {
      display: flex; align-items: center; gap: 10px;
      padding: 9px 16px; cursor: pointer; transition: background .12s;
      border: none; background: none; width: 100%; text-align: left;
    }
    .sk-acct-ws-item:hover { background: rgba(255,255,255,.04); }
    .sk-acct-ws-item.ws-active { background: rgba(113,255,0,.06); }
    .sk-acct-ws-icon {
      width: 30px; height: 30px; border-radius: 8px;
      background: rgba(113,255,0,.08); border: 1px solid rgba(113,255,0,.12);
      display: flex; align-items: center; justify-content: center;
      font-size: 14px; flex-shrink: 0;
    }
    .sk-acct-ws-info { flex: 1; min-width: 0; }
    .sk-acct-ws-name {
      font-size: 13px; font-weight: 700; color: rgba(255,255,255,.9);
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .sk-acct-ws-role { font-size: 11px; color: rgba(255,255,255,.4); margin-top: 1px; }
    .sk-acct-ws-dot {
      width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0;
      background: rgba(255,255,255,.2);
    }
    .sk-acct-ws-dot.active { background: #71ff00; }
    .sk-acct-personal-item {
      display: flex; align-items: center; gap: 10px;
      padding: 10px 16px; cursor: pointer; transition: background .12s;
      border: none; background: none; width: 100%; text-align: left;
    }
    .sk-acct-personal-item:hover { background: rgba(255,255,255,.04); }
    .sk-acct-personal-item.ws-active { background: rgba(113,255,0,.06); }
    .sk-acct-personal-icon {
      width: 30px; height: 30px; border-radius: 50%;
      background: rgba(113,255,0,.1); border: 1px solid rgba(113,255,0,.2);
      display: flex; align-items: center; justify-content: center;
      font-size: 13px; font-weight: 900; color: #71ff00; flex-shrink: 0;
    }

    /* ── Workspace context bar ── */
    #sk-ws-bar {
      width: 100%; overflow: hidden;
      background: rgba(113,255,0,0.05);
      border-bottom: 1px solid rgba(113,255,0,0.12);
      transition: max-height .25s ease, opacity .2s ease;
      max-height: 0; opacity: 0; pointer-events: none;
    }
    #sk-ws-bar.visible { max-height: 46px; opacity: 1; pointer-events: auto; }
    #sk-ws-bar-inner {
      max-width: 1200px; margin: 0 auto;
      display: flex; align-items: center; gap: 10px;
      padding: 7px 16px;
    }
    #sk-ws-bar-logo {
      width: 26px; height: 26px; border-radius: 6px; flex-shrink: 0; overflow: hidden;
      background: rgba(255,255,255,.06); display: flex; align-items: center;
      justify-content: center; font-size: 14px;
    }
    #sk-ws-bar-logo img { width: 100%; height: 100%; object-fit: cover; }
    #sk-ws-bar-biz {
      font-size: 12.5px; font-weight: 800; color: rgba(255,255,255,.9);
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 160px;
    }
    #sk-ws-bar-divider { color: rgba(255,255,255,.15); font-size: 11px; }
    #sk-ws-bar-role {
      font-size: 11.5px; font-weight: 600; color: rgba(255,255,255,.45);
      white-space: nowrap;
    }
    #sk-ws-bar-branch {
      font-size: 11px; color: rgba(255,255,255,.3);
      margin-left: auto; white-space: nowrap; flex-shrink: 0;
    }
    .sk-ws-bar-dot {
      width: 6px; height: 6px; border-radius: 50%;
      background: #71ff00; flex-shrink: 0; box-shadow: 0 0 5px #71ff0080;
    }

    /* ── Site menu drawer — layout handled by sokoni-drawers.css ── */
    /* #sk-menu-drawer is a .sk-drawer; header/close/backdrop/swipe/ESC
       are all managed by SokoniDrawer. Content styles below. */
    #sk-menu-grid {
      display: grid; grid-template-columns: 1fr 1fr;
      gap: 10px; padding: 20px;
    }
    .sk-menu-item {
      display: flex; align-items: center; gap: 12px;
      padding: 14px 16px; border-radius: 14px;
      background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.07);
      text-decoration: none; color: rgba(255,255,255,0.85);
      font-size: 13px; font-weight: 700; transition: all .15s;
      cursor: pointer;
    }
    .sk-menu-item:hover { background: rgba(113,255,0,0.07); border-color: rgba(113,255,0,0.2); color: #71ff00; }
    .sk-menu-item-icon { font-size: 22px; flex-shrink: 0; }
    #sk-menu-theme-row {
      display: flex; align-items: center; justify-content: space-between;
      padding: 14px 20px; margin: 0 0 8px;
      border-top: 1px solid rgba(255,255,255,0.06);
    }
    #sk-menu-theme-row span { font-size: 13px; font-weight: 700; color: rgba(255,255,255,0.6); }
    .sk-theme-chips { display: flex; gap: 8px; }
    .sk-theme-chip {
      padding: 7px 14px; border-radius: 20px; font-size: 12px; font-weight: 800;
      border: 1px solid rgba(255,255,255,0.12); background: rgba(255,255,255,0.05);
      color: rgba(255,255,255,0.55); cursor: pointer; transition: all .15s;
    }
    .sk-theme-chip.active { background: rgba(113,255,0,0.12); border-color: rgba(113,255,0,0.35); color: #71ff00; }

    /* ── Light-mode header overrides ── */
    body.light-mode #sk-top-nav::before {
      background: linear-gradient(to bottom, rgba(255,255,255,0.55) 0%, transparent 100%);
    }
    body.light-mode #sk-top-nav.sk-scrolled {
      background: rgba(255,255,255,0.97);
      border-bottom: 1px solid rgba(0,0,0,0.08);
      box-shadow: 0 2px 16px rgba(0,0,0,0.08);
    }
    body.light-mode #sk-nav-search {
      background: rgba(0,0,0,0.05); border-color: rgba(0,0,0,0.12);
      color: #111;
    }
    body.light-mode #sk-nav-search::placeholder { color: rgba(0,0,0,0.4); }
    body.light-mode .sk-nav-icon-btn { color: #333; }
    body.light-mode .sk-nav-icon-btn:hover { background: rgba(0,0,0,0.07); }
    body.light-mode #sk-nav-cart {
      background: rgba(0,120,0,0.08); border-color: rgba(0,120,0,0.2); color: #1a8800;
    }
    body.light-mode #sk-nav-avatar {
      background: rgba(0,120,0,0.1); border-color: rgba(0,120,0,0.25); color: #1a8800;
    }
    body.light-mode .sk-badge { border-color: #fff; }
    /* Menu drawer light-mode: drawer chrome handled by sokoni-drawers.css */
    body.light-mode .sk-menu-item { background: rgba(0,0,0,0.03); border-color: rgba(0,0,0,0.07); color: #333; }
    body.light-mode .sk-menu-item:hover { background: rgba(0,120,0,0.07); color: #1a8800; border-color: rgba(0,120,0,0.2); }
    body.light-mode #sk-menu-theme-row { border-top-color: rgba(0,0,0,0.06); }
    body.light-mode #sk-menu-theme-row span { color: rgba(0,0,0,0.5); }
    body.light-mode .sk-theme-chip { border-color: rgba(0,0,0,0.12); background: rgba(0,0,0,0.04); color: rgba(0,0,0,0.5); }
    body.light-mode .sk-theme-chip.active { background: rgba(0,120,0,0.1); border-color: rgba(0,120,0,0.3); color: #1a8800; }

    /* ── Tablet: hide cart text label, tighter spacing ── */
    @media (max-width: 768px) {
      #sk-nav-cart-label { display: none; }
      #sk-top-nav { gap: 6px; padding: 0 16px; }
    }
    /* ── Mobile: logo+actions row, search second row ── */
    @media (max-width: 600px) {
      #sk-top-nav {
        /* ~21% shorter + iPhone safe-area: content clears the notch (padding-top folds in
           env(safe-area-inset-top)); header is no longer over-tall on phones. */
        height: auto; min-height: 40px; flex-wrap: wrap;
        padding: calc(4px + env(safe-area-inset-top, 0px)) 12px 5px; gap: 3px;
        align-items: center;
      }
      #sk-nav-logo { order: 0; flex-shrink: 0; }
      #sk-nav-logo img { height: 24px; }
      #sk-nav-actions { order: 1; margin-left: auto; gap: 3px; }   /* equal spacing between action icons */
      /* Search second row — full width, tighter */
      #sk-nav-search-wrap {
        order: 2; flex: 1 1 100%; max-width: 100%; margin: 0; margin-top: 3px;
      }
      /* !important: an inline/JS style (design-system search enhancer) otherwise wins and
         keeps the input tall. Force the compact height so the header can actually shrink. */
      #sk-nav-search { padding: 6px 14px 6px 34px !important; font-size: 16px; min-height: 0 !important; }
      /* Mobile: hide Messages + Theme */
      #sk-msg-btn { display: none !important; }
      #sk-theme-btn { display: none !important; }
      /* Activity visible on mobile */
      #sk-activity-btn { display: flex !important; }
      /* Cart pill: compact */
      #sk-nav-cart { padding: 5px 9px; font-size: 11px; }
      /* Avatar */
      #sk-nav-avatar { width: 30px; height: 30px; font-size: 12px; }
      /* Icon buttons — 32px keeps a comfortable 44px-ish tap area with padding while trimming the row */
      .sk-nav-icon-btn { width: 32px !important; height: 32px !important; font-size: 16px; }
      /* Reserve exactly the MEASURED header height (--sk-header-h, published from the real
         header bottom incl. safe-area) so content can never hide under it nor leave a gap.
         The calc() fallback covers only the brief pre-measurement window. */
      body { padding-top: var(--sk-header-h, calc(44px + env(safe-area-inset-top, 0px))) !important; }
      body.sk-has-search { padding-top: var(--sk-header-h, calc(80px + env(safe-area-inset-top, 0px))) !important; }
    }
    /* ── Very small phones (320–380px) ── */
    @media (max-width: 380px) {
      #sk-top-nav { padding: 6px 10px 5px; }
      .sk-nav-icon-btn { width: 30px; height: 30px; font-size: 15px; }
      #sk-nav-cart { padding: 5px 8px; font-size: 10px; }
      #sk-nav-logo img { height: 24px; }
      #sk-nav-avatar { width: 26px; height: 26px; font-size: 11px; }
      body { padding-top: var(--sk-header-h, calc(42px + env(safe-area-inset-top, 0px))) !important; }
      body.sk-has-search { padding-top: var(--sk-header-h, calc(76px + env(safe-area-inset-top, 0px))) !important; }
    }

    /* ── Global responsive table overflow (applies to all pages) ── */
    table { display:block; overflow-x:auto; max-width:100%; -webkit-overflow-scrolling:touch; }
  `;

  /* Inject CSS into <head> immediately (before DOM ready) */
  const styleEl = document.createElement('style');
  styleEl.id = 'sk-header-styles';
  styleEl.textContent = CSS;
  (document.head || document.documentElement).appendChild(styleEl);

  /* ── Favicon injection — canonical SOKONI favicon on every page ── */
  (function _injectFavicon() {
    var head = document.head || document.documentElement;
    /* Remove any existing icon links so we don't stack duplicates */
    head.querySelectorAll('link[rel*="icon"]').forEach(function(l) { l.remove(); });
    var favicons = [
      { rel: 'icon',             type: 'image/x-icon',  href: 'assets/icons/favicon.ico' },
      { rel: 'icon',             type: 'image/png',     href: 'assets/icons/favicon-32x32.png', sizes: '32x32' },
      { rel: 'icon',             type: 'image/png',     href: 'assets/icons/favicon-16x16.png', sizes: '16x16' },
      { rel: 'apple-touch-icon', type: 'image/png',     href: 'assets/icons/icon-180.png',      sizes: '180x180' },
    ];
    favicons.forEach(function(f) {
      var l = document.createElement('link');
      Object.keys(f).forEach(function(k) { l.setAttribute(k, f[k]); });
      head.appendChild(l);
    });
  }());

  /* Apply sk-has-search immediately after CSS injection — prevents body padding
     from flickering from 60px→120px when _inject() runs later on DOMContentLoaded. */
  if (showSearch && document.body) document.body.classList.add('sk-has-search');

  /* ── Read user + cart from localStorage ── */
  function _readState() {
    let user = null, cartCount = null, hasNotif = false;
    try { user = JSON.parse(localStorage.getItem('sokoniUser') || 'null'); } catch (e) {}
    /* Canonical (Track 2.6). This header renders on 311 pages and was the LAST direct
       cart reader — it could not migrate until the service loaded on all of them, which
       is what this slice did first.

       Its formula, Σ(qty||1), is the one every other badge converged ON, so units() is a
       like-for-like swap and this number does not move.

       cartCount starts as NULL, not 0. "No service" and "empty cart" must stay
       distinguishable: a shopper with items in the cart must never see the pip quietly
       report nothing-in-particular. Null hides the pip; a real 0 hides it too, and any
       positive count shows it — exactly as before. */
    try {
      const C = window.SokoniCart;
      if (C) cartCount = C.units();
    } catch (e) {}
    try { hasNotif = !!localStorage.getItem('sokoniHasNotif'); } catch (e) {}
    return { user, cartCount, hasNotif };
  }

  /* ── Build the nav element ── */
  function _buildNav() {
    const { user, cartCount, hasNotif } = _readState();
    const initial = user
      ? (user.name || user.email || '').charAt(0).toUpperCase() || '👤'
      : '👤';
    const profileHref = user ? 'profile.html' : 'login.html';

    /* Inject skip-nav link before the nav */
    if (!document.getElementById('sk-skip-nav')) {
      const skip = document.createElement('a');
      skip.id = 'sk-skip-nav';
      skip.href = '#sk-main-content';
      skip.textContent = 'Skip to main content';
      document.body.insertBefore(skip, document.body.firstChild);
    }

    const nav = document.createElement('nav');
    nav.id = 'sk-top-nav';
    nav.setAttribute('aria-label', 'SOKONI top navigation');
    nav.setAttribute('role', 'navigation');

    const themeMode = (function(){ try { return localStorage.getItem('sokoni-theme')||'dark'; } catch(_){ return 'dark'; } })();
    const themeIcon = themeMode === 'light' ? '☀️' : themeMode === 'auto' ? '⚙️' : '🌙';

    nav.innerHTML =
      /* Logo — SVG wordmark (bag + SOKONI text), vector, always crisp on dark bg */
      '<a href="/" id="sk-nav-logo" aria-label="SOKONI Home">' +
        '<img src="assets/sokoni logoo.jpeg" alt="SOKONI">' +
      '</a>' +

      /* Search */
      (showSearch
        ? '<div id="sk-nav-search-wrap" role="search">' +
            '<span id="sk-nav-search-icon" aria-hidden="true">🔍</span>' +
            '<input id="sk-nav-search" type="search" placeholder="Search products, services…" ' +
              'autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" ' +
              /* Chrome ignores autocomplete="off" once it has a saved email for the site and
                 pops its autofill dropdown over the search box. A field that is readonly at
                 page-load is excluded from autofill; we drop readonly on first focus/pointer
                 so typing still works normally. */
              'readonly onfocus="this.removeAttribute(\'readonly\')" onpointerdown="this.removeAttribute(\'readonly\')" ' +
              'enterkeyhint="search" aria-label="Search SOKONI" ' +
              'onkeydown="if(event.key===\'Enter\'&&this.value.trim()){' +
                'document.getElementById(\'sk-nav-search-dropdown\').classList.remove(\'open\');' +
                'location.href=\'search.html?q=\'+encodeURIComponent(this.value.trim())}">' +
            '<div id="sk-nav-search-dropdown" role="listbox" aria-label="Search suggestions"></div>' +
          '</div>'
        : '') +

      /* Actions */
      '<div id="sk-nav-actions">' +

        /* Command palette trigger */
        '<button type="button" class="sk-nav-icon-btn sk-cp-trigger" aria-label="Command palette (Ctrl+K)" title="Search & navigate (Ctrl+K)" onclick="window.SokoniCP&&window.SokoniCP.open()" id="sk-cp-btn">' +
          '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="vertical-align:middle"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>' +
          '<span style="font-size:9px;color:#444;margin-left:4px;font-family:monospace;display:none" class="sk-cp-shortcut">⌘K</span>' +
        '</button>' +

        /* Notifications */
        '<button type="button" class="sk-nav-icon-btn" aria-label="Notifications" aria-expanded="false" aria-haspopup="dialog" id="sk-notif-btn">' +
          '<span id="sk-notif-bell-icon" aria-hidden="true">🔔</span>' +
          '<span class="sk-badge" id="sk-notif-badge" role="status" aria-label="Unread notifications"></span>' +
        '</button>' +

        /* Activity center */
        '<a href="notifications.html?tab=activity" class="sk-nav-icon-btn" id="sk-activity-btn" aria-label="Activity" title="Activity feed">' +
          '<span aria-hidden="true">⚡</span>' +
          '<span class="sk-badge" id="sk-activity-badge" role="status" aria-label="New activity"></span>' +
        '</a>' +

        /* Messages */
        '<a href="messages.html" class="sk-nav-icon-btn" aria-label="Messages" id="sk-msg-btn">' +
          '<span aria-hidden="true">💬</span>' +
          '<span class="sk-badge" id="sk-msg-badge" role="status" aria-label="Unread messages"></span>' +
        '</a>' +

        /* Cart — except ON the cart page, where this slot carries Wishlist instead.
           A Cart button that navigates to the page you are already on is dead weight;
           Wishlist is the action a shopper actually wants from there, and it reuses the
           existing wishlist.html rather than introducing a second implementation.

           The element keeps id="sk-nav-cart" deliberately: every rule that styles this
           slot is keyed to that id (#sk-nav-cart at 963/970/1168, the scrolled state at
           919, and the 1213/1228 breakpoints), so reusing it preserves the styling,
           spacing and responsive behaviour exactly instead of duplicating six CSS rules.
           The pip is omitted — a cart count is redundant beside the cart itself, and
           _refresh() null-checks it before writing.

           Matched against both forms because cleanUrls serves this page as /cart in
           production while it is cart.html locally. */
        (/^cart(\.html)?$/.test(page)
          ? '<a href="wishlist.html" id="sk-nav-cart" aria-label="Wishlist" title="Wishlist">' +
              '<span aria-hidden="true">❤️</span>' +
            '</a>'
          : '<a href="cart.html" id="sk-nav-cart" aria-label="Shopping cart">' +
              /* `cartCount || 0` would render an unreadable cart as "0 items" in the aria
                 label — a screen reader would announce an empty cart the page cannot verify.
                 Blank text and a neutral label when the count is unknown. */
              '<span aria-hidden="true">🛒</span> <span id="sk-nav-cart-pip" style="display:' + (cartCount > 0 ? 'flex' : 'none') + ';" aria-label="' + (cartCount == null ? 'Cart' : cartCount + ' items') + '">' + (cartCount == null ? '' : cartCount) + '</span>' +
            '</a>') +

        /* Avatar / Profile — opens account dropdown */
        '<div class="sk-acct-wrap" id="sk-acct-wrap">' +
          '<button type="button" id="sk-nav-avatar" aria-label="Account menu" aria-expanded="false" ' +
            'onclick="window._skToggleAcct(event)">' + initial + '</button>' +
        '</div>' +

        /* Theme toggle */
        '<button type="button" class="sk-nav-icon-btn" id="sk-theme-btn" ' +
          'aria-label="Toggle theme" title="Toggle theme" ' +
          'onclick="if(window.SokoniTheme){SokoniTheme.toggle();}">' +
          '<span id="sk-theme-icon" aria-hidden="true">' + themeIcon + '</span>' +
        '</button>' +

        /* Menu (hamburger) */
        '<button type="button" class="sk-nav-icon-btn" id="sk-menu-btn" aria-label="Menu" aria-expanded="false" ' +
          'onclick="_skOpenMenu(this);">' +
          '<span aria-hidden="true" style="font-size:13px;font-weight:900;letter-spacing:0px;display:flex;flex-direction:column;gap:3px;">' +
            '<span style="display:block;width:18px;height:2px;background:currentColor;border-radius:2px;"></span>' +
            '<span style="display:block;width:14px;height:2px;background:currentColor;border-radius:2px;"></span>' +
            '<span style="display:block;width:18px;height:2px;background:currentColor;border-radius:2px;"></span>' +
          '</span>' +
        '</button>' +

      '</div>';

    return nav;
  }

  /* ── Delivery entry, resolved per role ─────────────────────────────────────
     The same canonical delivery is viewed by seller, rider and buyer, but each
     role gets its OWN context and controls — the rider UI is never reused as the
     seller UI. This menu is shared by every page, so a single hard-coded
     delivery.html sent sellers into the send-a-parcel hub, whose header offers
     "Be a Rider" and which sokoni-permissions.js classes as a driver page.

     seller/merchant → seller-delivery.html   (manage MY shop's deliveries)
     driver/rider    → driver.html            (the rider app — unchanged)
     everyone else   → delivery.html          (send a parcel / track)

     Role comes from the same cached `sokoniUser` the rest of this file reads.
     Unknown or signed-out falls through to the consumer hub, which is the safe
     default: it never exposes a control the visitor is not entitled to. */
  function _deliveryLink() {
    var roles = [], active = '';
    try {
      var u = JSON.parse(localStorage.getItem('sokoniUser') || 'null') || {};
      roles  = Array.isArray(u.roles) ? u.roles : (u.role ? [u.role] : []);
      /* _skSwitchRole writes BOTH u.role and roles[0], so either identifies the
         role the user is currently acting as. */
      active = String(u.role || roles[0] || '').toLowerCase();
    } catch (e) {}
    roles = roles.map(function (r) { return String(r || '').toLowerCase(); });

    var SELLER = { key:'delivery', icon:'🛵', label:'Delivery Hub',  href:'seller-delivery.html' };
    var RIDER  = { key:'delivery', icon:'🛵', label:'My Rider',      href:'driver.html' };
    var BUYER  = { key:'delivery', icon:'🛵', label:'Send a Parcel', href:'delivery.html' };

    /* ACTIVE role decides. A seller who is also a registered rider is acting as a
       seller right now and must get the seller surface — resolving by list order
       instead would hand them the rider app, which is the exact mix-up this
       function exists to prevent. */
    if (active === 'seller' || active === 'merchant') return SELLER;
    if (active === 'driver' || active === 'rider')    return RIDER;
    if (active === 'buyer')                           return BUYER;

    /* No usable active role — fall back to what the account actually holds. */
    if (roles.indexOf('seller') > -1 || roles.indexOf('merchant') > -1) return SELLER;
    if (roles.indexOf('driver') > -1 || roles.indexOf('rider')    > -1) return RIDER;
    return BUYER;
  }

  /* The drawer is built once per page load, but _skSwitchRole does NOT reload —
     it only fires sokoniRoleChanged. Without this the menu would keep pointing at
     the previous role's delivery surface, which is exactly the mix-up this entry
     exists to prevent. Re-resolve in place on every role change. */
  /* ── HOME resolves to the acting role's surface ───────────────────────────
     The logo shipped as a single static `/` for every role, so an administrator mid-task
     was returned to the marketplace. It now asks the authority that owns each role class
     and NEITHER file learns about the other's roles:

         administrative   SokoniPermissions.adminHomeFor()   superAdmin > admin
         workspace        SokoniRoleAuthority.hubFor(role)   buyer/seller/rider/…

     Order matters: administrative first, because an operator holding both an admin claim
     and a workspace role is acting as an administrator when they reach for Home.

     This resolves a DESTINATION, never authority. adminHomeFor() routes through hasRole(),
     which refuses an elevated role asserted only by cache, and hubFor() returns null unless
     the authority approves the role — so a forged local role yields null and we keep '/'.
     The destination page runs its own guard regardless. The markup default stays '/', which
     is correct with no JavaScript and for a signed-out visitor.

     The href is set on the anchor; window.location is NOT wrapped. Overriding
     Location.prototype.href broke Auth signup once and must not be reintroduced. */
  function _skResolveHomeHref() {
    try {
      var P = window.SokoniPermissions;
      if (P && typeof P.adminHomeFor === 'function') {
        var admin = P.adminHomeFor();
        if (admin) return admin;
      }
    } catch (_) { /* an authority that cannot answer must not break the header */ }
    try {
      var RA = window.SokoniRoleAuthority;
      if (RA && typeof RA.hubFor === 'function' && typeof RA.getActiveRole === 'function') {
        var hub = RA.hubFor(RA.getActiveRole());
        /* buyer is the baseline every account holds, and its hub IS the home page — so
           hubFor('buyer') answers 'index.html' for every signed-out visitor. Rewriting the
           logo to 'index.html' would change the highest-traffic link on the site from the
           canonical '/' for no gain, and this site serves cleanUrls. Baseline keeps '/'. */
        if (hub === 'index.html') return '/';
        if (hub) return hub;
      }
    } catch (_) { /* same */ }
    return '/';
  }

  function _skApplyHomeHref() {
    var a = document.getElementById('sk-nav-logo');
    if (!a) return;
    var href = _skResolveHomeHref();
    if (a.getAttribute('href') !== href) a.setAttribute('href', href);
  }
  window._skApplyHomeHref = _skApplyHomeHref;

  /* Re-resolve whenever either authority reports a change. */
  document.addEventListener('sokoniRoleAuthorityReady', _skApplyHomeHref);
  document.addEventListener('sokoniActiveRoleChanged', _skApplyHomeHref);
  document.addEventListener('sokoniRoleChanged', _skApplyHomeHref);

  document.addEventListener('sokoniRoleChanged', function () {
    var a = document.querySelector('#sk-menu-grid [data-sk-key="delivery"]');
    if (!a) return;
    var l = _deliveryLink();
    a.setAttribute('href', l.href);
    var spans = a.querySelectorAll('span');
    if (spans[0]) spans[0].textContent = l.icon;
    if (spans[1]) spans[1].textContent = l.label;
  });

  /* ── Build the site menu as a SokoniDrawer (enterprise side drawer) ── */
  function _buildMenuDrawer() {
    if (document.getElementById('sk-menu-drawer')) return;
    const LINKS = [
      /* "/" — canonical, and the same target as the logo above (id="sk-nav-logo"). */
      { icon:'🏠', label:'Home',          href:'/' },
      { icon:'🛍️', label:'Marketplace',   href:'category.html?cat=all' },
      { icon:'🛠️', label:'Services',       href:'services.html' },
      { icon:'🍔', label:'Food',           href:'food.html' },
      { icon:'🏠', label:'Property',       href:'property-hub.html' },
      { icon:'🚗', label:'Cars',           href:'car-hub.html' },
      { icon:'🏥', label:'Healthcare',     href:'healthcare.html' },
      { icon:'⚖️', label:'Legal',          href:'legal-hub.html' },
      { icon:'📱', label:'Tech Hub',       href:'tech-hub.html' },
      { icon:'💼', label:'Jobs',           href:'jobs.html' },
      { icon:'🎤', label:'Events',         href:'entertainment.html' },
      _deliveryLink(),
      { icon:'🧾', label:'SmartPOS',       href:'pos.html' },
      { icon:'💬', label:'Messages',       href:'messages.html' },
      { icon:'🔔', label:'Notifications',  href:'notifications.html' },
      { icon:'❤️', label:'Wishlist',       href:'wishlist.html' },
      { icon:'🛒', label:'Cart',           href:'cart.html' },
      { icon:'👤', label:'Profile',        href:'profile.html' },
    ];

    const drawer = document.createElement('div');
    drawer.id = 'sk-menu-drawer';
    drawer.className = 'sk-drawer';
    drawer.setAttribute('aria-hidden', 'true');
    drawer.setAttribute('role', 'dialog');
    drawer.setAttribute('aria-modal', 'true');
    drawer.setAttribute('aria-label', 'Site menu');

    drawer.innerHTML =
      /* Drawer header — logo + close button */
      '<div class="sk-drawer-header">' +
        '<div style="display:flex;align-items:center;gap:9px;margin-left:4px">' +
          '<img src="assets/sokoni logoo.jpeg" alt="SOKONI" style="height:40px;width:auto;object-fit:contain;mix-blend-mode:screen">' +
          '<span style="font-size:19px;font-weight:900;letter-spacing:.04em;color:#fff;line-height:1">SOKO<em style="font-style:normal;color:#71ff00">NI</em></span>' +
        '</div>' +
        '<button class="sk-drawer-close" type="button" aria-label="Close menu">✕</button>' +
      '</div>' +
      /* Scrollable drawer body */
      '<div class="sk-drawer-body">' +
        '<div id="sk-menu-grid">' +
          LINKS.map(function(l) {
            return '<a href="' + l.href + '" class="sk-menu-item"' +
                (l.key ? ' data-sk-key="' + l.key + '"' : '') + '>' +
              '<span class="sk-menu-item-icon">' + l.icon + '</span>' +
              '<span>' + l.label + '</span>' +
            '</a>';
          }).join('') +
        '</div>' +
        '<div id="sk-menu-theme-row">' +
          '<span>Theme</span>' +
          '<div class="sk-theme-chips">' +
            '<button class="sk-theme-chip" data-theme="dark" type="button">🌙 Dark</button>' +
            '<button class="sk-theme-chip" data-theme="light" type="button">☀️ Light</button>' +
            '<button class="sk-theme-chip" data-theme="auto" type="button">⚙️ Auto</button>' +
          '</div>' +
        '</div>' +
      '</div>';

    document.body.appendChild(drawer);

    /* Theme chips — wire events without inline onclick to avoid XSS risk */
    drawer.querySelectorAll('.sk-theme-chip').forEach(function(chip) {
      chip.addEventListener('click', function() {
        var t = chip.dataset.theme;
        if (window.SokoniTheme) window.SokoniTheme.setTheme(t);
        drawer.querySelectorAll('.sk-theme-chip').forEach(function(c) {
          c.classList.toggle('active', c.dataset.theme === t);
        });
      });
    });

    /* Mark active theme chip */
    var savedTheme = (function() { try { return localStorage.getItem('sokoni-theme') || 'dark'; } catch (_) { return 'dark'; } })();
    drawer.querySelectorAll('.sk-theme-chip').forEach(function(c) {
      c.classList.toggle('active', c.dataset.theme === savedTheme);
    });

    /* Reset aria-expanded on menu btn when drawer is closed via backdrop/ESC */
    var _menuObserver = new MutationObserver(function(muts) {
      muts.forEach(function(m) {
        if (m.attributeName === 'aria-hidden') {
          var btn = document.getElementById('sk-menu-btn');
          if (btn) btn.setAttribute('aria-expanded', drawer.getAttribute('aria-hidden') === 'false' ? 'true' : 'false');
        }
      });
    });
    _menuObserver.observe(drawer, { attributes: true, attributeFilter: ['aria-hidden'] });
  }

  /* ── Workspace context bar ──────────────────────────────────────── */
  function _ensureWsBar() {
    if (document.getElementById('sk-ws-bar')) return;
    var nav = document.getElementById('sk-top-nav');
    if (!nav) return;
    var bar = document.createElement('div');
    bar.id = 'sk-ws-bar';
    bar.setAttribute('aria-label', 'Active workspace');
    bar.innerHTML =
      '<div id="sk-ws-bar-inner">' +
        '<div class="sk-ws-bar-dot"></div>' +
        '<div id="sk-ws-bar-logo"></div>' +
        '<div id="sk-ws-bar-biz"></div>' +
        '<span id="sk-ws-bar-divider">·</span>' +
        '<div id="sk-ws-bar-role"></div>' +
        '<div id="sk-ws-bar-branch"></div>' +
      '</div>';
    nav.after(bar);
  }

  function _updateWsBar(ws) {
    _ensureWsBar();
    var bar = document.getElementById('sk-ws-bar');
    if (!bar) return;

    if (!ws) {
      bar.classList.remove('visible');
      bar.style.removeProperty('background');
      bar.style.removeProperty('border-bottom-color');
      return;
    }

    var bizEl    = document.getElementById('sk-ws-bar-biz');
    var roleEl   = document.getElementById('sk-ws-bar-role');
    var branchEl = document.getElementById('sk-ws-bar-branch');
    var logoEl   = document.getElementById('sk-ws-bar-logo');

    if (bizEl)  bizEl.textContent  = ws.businessName || 'Business';
    if (roleEl) roleEl.textContent = ws.roleTitle || _wsRoleLabel(ws.role);
    if (branchEl) branchEl.textContent = ws.activeBranchName ? '📍 ' + ws.activeBranchName : '';

    if (logoEl) {
      if (ws.businessLogo) {
        logoEl.innerHTML = '<img src="' + _hesc(ws.businessLogo) + '" alt="">';
      } else {
        var bizEmoji = { marketplace:'🛍️', food:'🍽️', services:'🔧', healthcare:'🏥',
          events:'🎪', property:'🏠', vehicle:'🚗', hotel:'🏨' }[ws.businessType] || '🏢';
        logoEl.textContent = bizEmoji;
      }
    }

    if (ws.brandColor) {
      bar.style.background = ws.brandColor + '0d';
      bar.style.borderBottomColor = ws.brandColor + '2a';
    } else {
      bar.style.removeProperty('background');
      bar.style.removeProperty('border-bottom-color');
    }

    bar.classList.add('visible');
  }

  function _wsRoleLabel(r) {
    var M = { owner:'Owner', manager:'Manager', supervisor:'Supervisor', cashier:'Cashier',
      inventory_officer:'Inventory Officer', accountant:'Accountant', driver:'Driver',
      receptionist:'Receptionist', waiter:'Waiter', security:'Security', cleaner:'Cleaner' };
    return M[r] || (r ? r.charAt(0).toUpperCase() + r.slice(1).replace(/_/g,' ') : 'Staff');
  }

  /* ── Update live state without rebuilding ── */
  function _refresh() {
    const { user, cartCount } = _readState();

    const pip = document.getElementById('sk-nav-cart-pip');
    if (pip) {
      /* Null means the cart could not be read. Writing it straight into textContent put
         the literal string "null" in the pip — invisible only because display happens to
         be none. Hidden and empty, not hidden and wrong. */
      pip.textContent = (cartCount == null) ? '' : cartCount;
      pip.style.display = cartCount > 0 ? 'flex' : 'none';
    }

    const avatar = document.getElementById('sk-nav-avatar');
    if (avatar && user) {
      const initial = (user.name || user.email || '').charAt(0).toUpperCase() || '👤';
      avatar.textContent = initial;
    } else if (avatar && !user) {
      avatar.textContent = '👤';
      /* Not signed in — navigate directly to login on click */
      avatar.onclick = function () { location.href = 'login.html'; };
    }

    /* Render initial workspace bar state from localStorage */
    try {
      var wsId = localStorage.getItem('sokoniActiveWorkspace');
      if (wsId) {
        var wsList = JSON.parse(localStorage.getItem('sokoniWorkspaces') || '[]');
        var activeWs = wsList.find(function (w) { return w.businessId === wsId; }) || null;
        _updateWsBar(activeWs);
      }
    } catch (_) {}
  }

  /* ── Account dropdown ──────────────────────────────────────────── */
  function _buildAcctPopup(user) {
    const existing = document.getElementById('sk-acct-popup');
    if (existing) { existing.remove(); return; }

    /* ── Read workspace memberships from localStorage ── */
    var workspaces = [];
    try { workspaces = JSON.parse(localStorage.getItem('sokoniWorkspaces') || '[]'); } catch (_) {}
    var activeWsId = localStorage.getItem('sokoniActiveWorkspace') || null;

    /* ── Personal roles (non-workspace) ── */
    const roles   = Array.isArray(user.roles) ? user.roles : (user.role ? [user.role] : ['buyer']);
    /* The ACTING role, from the authority. This was roles[0] — the localStorage mirror —
       so the pill highlight and the "Personal Account" sub-label could contradict the
       "acting as" line directly above them, which already preferred the authority. One
       resolver now feeds all three, so they cannot disagree. */
    const active  = _skActingRole(roles[0] || 'buyer');
    const roleMap = { buyer:'Buyer', seller:'Seller', provider:'Provider', driver:'Driver',
                      rider:'Rider', admin:'Admin', superAdmin:'Super Admin', employer:'Employer' };
    const rName   = r => roleMap[r] || (r.charAt(0).toUpperCase() + r.slice(1));
    const wsRoleName = r => {
      const M = { owner:'Owner', manager:'Manager', supervisor:'Supervisor', cashier:'Cashier',
        inventory_officer:'Inventory Officer', accountant:'Accountant', driver:'Driver',
        receptionist:'Receptionist', waiter:'Waiter', security:'Security', cleaner:'Cleaner' };
      return M[r] || (r ? r.charAt(0).toUpperCase() + r.slice(1).replace(/_/g,' ') : 'Staff');
    };

    const bizEmoji = type => ({ marketplace:'🛍️', food:'🍽️', services:'🔧', healthcare:'🏥',
      events:'🎪', property:'🏠', vehicle:'🚗', hotel:'🏨' }[type] || '🏢');

    /* ── Workspace switcher HTML ── */
    const isPersonalActive = !activeWsId;

    const personalEntry =
      '<button class="sk-acct-personal-item ' + (isPersonalActive ? 'ws-active' : '') + '" ' +
        'onclick="window._skSwitchWorkspace(\'personal\')">' +
        '<div class="sk-acct-personal-icon">' + (user.name || user.email || '?').charAt(0).toUpperCase() + '</div>' +
        '<div class="sk-acct-ws-info">' +
          '<div class="sk-acct-ws-name">Personal Account</div>' +
          '<div class="sk-acct-ws-role">' + rName(active) + '</div>' +
        '</div>' +
        '<div class="sk-acct-ws-dot ' + (isPersonalActive ? 'active' : '') + '"></div>' +
      '</button>';

    const wsEntries = workspaces.map(function (ws) {
      const isActive = ws.businessId === activeWsId;
      const clockedLabel = ws.clockedIn ? ' · Clocked In' : '';
      return '<button class="sk-acct-ws-item ' + (isActive ? 'ws-active' : '') + '" ' +
        'onclick="window._skSwitchWorkspace(\'' + _hesc(ws.businessId) + '\')">' +
        '<div class="sk-acct-ws-icon">' + bizEmoji(ws.businessType) + '</div>' +
        '<div class="sk-acct-ws-info">' +
          '<div class="sk-acct-ws-name">' + _hesc(ws.businessName || 'Business') + '</div>' +
          '<div class="sk-acct-ws-role">' + wsRoleName(ws.role) + (ws.roleTitle && ws.roleTitle !== wsRoleName(ws.role) ? ' · ' + _hesc(ws.roleTitle) : '') + clockedLabel + '</div>' +
        '</div>' +
        '<div class="sk-acct-ws-dot ' + (isActive ? 'active' : '') + '"></div>' +
      '</button>';
    }).join('');

    const switcherSection =
      '<div class="sk-acct-ws-section">' +
        '<div class="sk-acct-ws-label">Workspaces</div>' +
        personalEntry +
        wsEntries +
      '</div>' +
      '<div class="sk-acct-separator"></div>';

    /* ── Role pills (personal roles, only if > 1 AND in personal mode) ── */
    const rolePills = (isPersonalActive && roles.length > 1)
      ? '<div class="sk-acct-role-strip">' +
          '<div class="sk-acct-role-label">Switch Role</div>' +
          '<div class="sk-acct-role-pills">' +
            roles.map(r =>
              '<button class="sk-acct-role-pill ' + (r === active ? 'active' : '') + '" ' +
                'onclick="window._skSwitchRole(\'' + r + '\')">' + rName(r) + '</button>'
            ).join('') +
          '</div>' +
        '</div>' +
        '<div class="sk-acct-separator"></div>'
      : '';

    const popup = document.createElement('div');
    popup.id = 'sk-acct-popup';
    popup.setAttribute('role', 'menu');
    popup.innerHTML =
      '<div class="sk-acct-head">' +
        '<div class="sk-acct-name">' + _hesc(user.name || user.displayName || 'User') + '</div>' +
        '<div class="sk-acct-email">' + _hesc(user.email || '') + '</div>' +
        _skActiveRoleLine(active) +
        _skDeliveryLine() +
      '</div>' +
      switcherSection +
      rolePills +
      '<div class="sk-acct-links">' +
        '<a class="sk-acct-link" href="profile.html" onclick="window._skCloseAcct()"><i class="fas fa-user"></i> My Profile</a>' +
        '<a class="sk-acct-link" href="account-centre.html" onclick="window._skCloseAcct()"><i class="fas fa-gear"></i> Settings</a>' +
        '<a class="sk-acct-link" href="account-centre.html#employment" onclick="window._skCloseAcct()"><i class="fas fa-briefcase"></i> My Workspaces</a>' +
        '<a class="sk-acct-link" href="wallet.html" onclick="window._skCloseAcct()"><i class="fas fa-wallet"></i> Wallet</a>' +
        /* Wishlist moves here from the drawer's removed role-switcher slot. */
        '<a class="sk-acct-link" href="wishlist.html" onclick="window._skCloseAcct()"><i class="fas fa-heart"></i> Wishlist</a>' +
        '<div class="sk-acct-separator"></div>' +
        '<button class="sk-acct-link sk-acct-link-danger" onclick="window._skSignOutFromAcct()"><i class="fas fa-arrow-right-from-bracket"></i> Sign Out</button>' +
      '</div>';

    const wrap = document.getElementById('sk-acct-wrap');
    if (wrap) wrap.appendChild(popup);

    const avatar = document.getElementById('sk-nav-avatar');
    if (avatar) avatar.setAttribute('aria-expanded', 'true');

    /* Close on outside click */
    setTimeout(function () {
      document.addEventListener('click', _skOutsideClose, { once: true });
    }, 0);
  }

  function _hesc(s) {
    return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  /* The role the account is ACTING as, shown under the email so the menu answers
     "who am I right now" before it offers to change it. Prefers the authority over
     the local mirror: if the two ever disagree, the authority is the true answer
     and showing the mirror would explain the wrong state confidently. */
  /* THE acting-role resolver for the header. Authority first; the caller's mirror value
     only while the authority is genuinely uninitialised or unverified — "unverified" means
     UNKNOWN, and answering from the mirror is a first-paint stopgap, never a decision. */
  function _skActingRole(fallback) {
    try {
      var RA = window.SokoniRoleAuthority;
      if (RA && RA.isVerified && RA.isVerified() && RA.getActiveRole) {
        var r = RA.getActiveRole();
        if (r) return r;
      }
    } catch (_) {}
    return fallback || '';
  }

  function _skActiveRoleLine(active) {
    var role = _skActingRole(active);
    if (!role) return '';
    var label = String(role).charAt(0).toUpperCase() + String(role).slice(1);
    return '<div class="sk-acct-role-now">' + _hesc(label) + '</div>';
  }

  /* Default delivery address, e.g. "📍 Home: Lang'ata".

     Renders ONLY from a confirmed saved address. There is no such store yet — the
     buyer-addresses capability is still to be built — so today this returns an empty
     string on every path and the menu simply omits the line.

     It is deliberately NOT filled from device GPS, a reverse-geocode guess, or the
     last delivery on an order. A menu that announces "Home: Lang'ata" because the
     browser happened to report a coordinate is inventing a saved address the buyer
     never confirmed, and they would reasonably trust it at checkout. An absent line
     is honest; a guessed one is a defect. When sokoni-buyer-addresses.js lands, it
     becomes the single source read here. */
  function _skDeliveryLine() {
    try {
      var A = window.SokoniBuyerAddresses;
      if (!A || typeof A.getDefaultConfirmed !== 'function') return '';
      var a = A.getDefaultConfirmed();
      if (!a || a.confirmed !== true) return '';
      var where = a.area || a.city || '';
      if (!where) return '';
      var label = a.label ? (String(a.label).charAt(0).toUpperCase() + String(a.label).slice(1)) : 'Delivery';
      return '<div class="sk-acct-delivery">📍 ' + _hesc(label) + ': ' + _hesc(where) + '</div>';
    } catch (_) { return ''; }
  }

  window._skToggleAcct = function (e) {
    e.stopPropagation();
    var { user } = _readState();
    if (!user) { location.href = 'login.html'; return; }
    _buildAcctPopup(user);
  };

  window._skCloseAcct = function () {
    const p = document.getElementById('sk-acct-popup');
    if (p) p.remove();
    const avatar = document.getElementById('sk-nav-avatar');
    if (avatar) avatar.setAttribute('aria-expanded', 'false');
  };

  function _skOutsideClose(e) {
    const wrap = document.getElementById('sk-acct-wrap');
    if (wrap && wrap.contains(e.target)) return;
    window._skCloseAcct();
  }

  /* Switching role goes through SokoniRoleAuthority FIRST, and only mirrors locally
     once the authority has agreed.

     Before this, the switch wrote localStorage and fired sokoniRoleChanged and that
     was all. RA never learned, so the two systems disagreed in both directions:
     the header believed you were a buyer while RA still approved `seller`, so
     profile.html — which asks RA — kept rendering the Business Hub after you had
     switched away. Nothing anywhere listened to RA's own sokoniActiveRoleChanged
     either, so a change made through the authority updated no UI at all. Even the
     mirrors disagreed: RA writes sokoniUser.activeRole, this wrote sokoniUser.role.

     RA.setActiveRole refuses a role the account does not hold, persists
     users/{uid}.activeRole so the choice survives reload and browser reopen, and
     declines to switch locally when the server rejects the write. Deferring to it
     is what makes a switch an actual change of role rather than a repaint.

     If RA is absent (a page that does not load it), the legacy local path still
     runs — otherwise role switching would break outright on those pages. That is a
     deliberate fallback, not an oversight: it is strictly the old behaviour, and it
     is the reason this cannot yet be called finished everywhere. */
  window._skSwitchRole = async function (role) {
    var RA = window.SokoniRoleAuthority;
    if (RA && typeof RA.setActiveRole === 'function') {
      var res = null;
      try { res = await RA.setActiveRole(role); } catch (_) { res = null; }
      if (!res || res.ok !== true) {
        var why = (res && res.reason) || 'unavailable';
        /* Say why, and do NOT switch. A silent no-op reads as a broken button, and
           switching anyway would claim a role the authority just declined. */
        var msg = why === 'not-approved' ? 'That role is not available on this account.'
                : why === 'not-verified' ? 'Could not verify your roles. Check your connection and try again.'
                : why === 'signed-out'   ? 'Sign in to switch role.'
                : 'Could not switch role right now. Please try again.';
        try {
          if (window.showNotif) window.showNotif(msg, 'error');
          else if (window.SokoniToast && window.SokoniToast.show) window.SokoniToast.show(msg, 'error');
          else console.warn('[role-switch] ' + why + ': ' + msg);
        } catch (_) {}
        return;
      }
    }
    _skMirrorRoleLocally(role);
    window._skCloseAcct();
    try {
      var u2 = JSON.parse(localStorage.getItem('sokoniUser') || 'null');
      if (u2) _buildAcctPopup(u2);
    } catch (_) {}

    /* Route to the role's workspace. A switch that changes no UI and goes nowhere reads as
       a broken button, which is what Home showed.

       hubFor() returns null unless the authority approves the role, so this cannot become a
       way INTO a workspace — the switch above already had to succeed, and the destination
       page runs its own guardWorkspace regardless. Staying put when the destination is the
       current page avoids a pointless reload (Buyer selected from Home). */
    try {
      var RA2 = window.SokoniRoleAuthority;
      var hub = (RA2 && typeof RA2.hubFor === 'function') ? RA2.hubFor(role) : null;
      if (hub) {
        var here = (location.pathname.split('/').pop() || 'index.html');
        if (here.indexOf('.') < 0) here += '.html';      /* cleanUrls serves /merchant */
        if (here.toLowerCase() !== hub.toLowerCase()) location.href = hub;
      }
    } catch (_) {}
  };

  /* The local mirror of an already-authorised decision. Kept separate so the
     authority path above and the bridge below cannot drift apart. */
  function _skMirrorRoleLocally(role) {
    try {
      var u = JSON.parse(localStorage.getItem('sokoniUser') || '{}');
      var roles = Array.isArray(u.roles) ? [...u.roles] : [role];
      var idx = roles.indexOf(role);
      if (idx > 0) { roles.splice(idx, 1); roles.unshift(role); }
      /* Write BOTH fields: RA mirrors activeRole, the existing UI reads role. */
      u.roles = roles; u.role = role; u.activeRole = role;
      localStorage.setItem('sokoniUser', JSON.stringify(u));
    } catch (_) {}
    if (window.SokoniSessionState) window.SokoniSessionState.setRole(role);
    document.dispatchEvent(new CustomEvent('sokoniRoleChanged', { detail: { role: role } }));
  }

  /* Bridge: a role change made through the authority must reach the UI.

     RA demotes to baseline on its own when a role is revoked or a token turns out
     not to carry it. Without this the header would keep showing the revoked role
     until the next full page load. _skBridging stops the two events echoing. */
  var _skBridging = false;
  document.addEventListener('sokoniActiveRoleChanged', function (e) {
    if (_skBridging) return;
    var role = e && e.detail && e.detail.role;
    if (!role) return;
    var current = '';
    try { current = String((JSON.parse(localStorage.getItem('sokoniUser') || '{}').role) || '').toLowerCase(); } catch (_) {}
    if (current === String(role).toLowerCase()) return;
    _skBridging = true;
    try { _skMirrorRoleLocally(role); } finally { _skBridging = false; }
    try {
      var u = JSON.parse(localStorage.getItem('sokoniUser') || 'null');
      if (u && document.getElementById('sk-acct-popup')) _buildAcctPopup(u);
    } catch (_) {}
  });

  /* Mirror of firebase.js's _SOKONI_LS_KEEP. firebase.js is CANONICAL; this copy exists
     only because the fallback below runs on pages where firebase.js is not loaded, so it
     cannot be read from there. If one changes, change both — a key kept here but wiped
     there (or the reverse) is a data-leak-shaped bug between two accounts on one device. */
  var _SK_LS_KEEP = /theme|darkmode|consent|cookie|appcheck|debug|install|onboard|dismiss|locale|printer|hardware|sokoniadmin(pin|pattern|pw)hash/i;

  /* Best-effort teardown for pages without firebase.js.

     The old else-branch navigated to login and cleared NOTHING. 181 pages load
     shared-header.js without firebase.js, so on all of them Sign Out was a redirect:
     the Firebase session survived in IndexedDB and every mirror survived in
     localStorage. Going back, or opening any other page, restored the previous
     session — and sokoniUser still carried the old role, so the header rebuilt itself
     as the signed-in user. "Signed out" was a page you were looking at, not a state.

     This clears what it can reach and always lands on login. It is deliberately
     idempotent: with no current user it still wipes and still navigates, so a second
     press, or a press after the session already died, reaches the signed-out state
     instead of leaving an authenticated-looking menu. */
  function _skLocalSignOutFallback() {
    try {
      var a = window.firebaseAuth || (window.firebase && window.firebase.auth && window.firebase.auth());
      if (a && typeof a.signOut === 'function') { try { a.signOut(); } catch (_) {} }
    } catch (_) {}
    [localStorage, sessionStorage].forEach(function (store) {
      try {
        Object.keys(store).forEach(function (k) {
          if (!_SK_LS_KEEP.test(k)) { try { store.removeItem(k); } catch (_) {} }
        });
      } catch (_) {}
    });
  }

  window._skSignOutFromAcct = function () {
    window._skCloseAcct();
    /* sokoniSignOut clears the session but does NOT navigate — without this redirect
       the page stayed put and Sign Out looked broken ("not working"). Always land on
       login (even if the network sign-out throws, local state is cleared). */
    if (window.sokoniSignOut) {
      window.sokoniSignOut().finally(function () { location.replace('login.html'); });
    } else {
      _skLocalSignOutFallback();
      /* replace(), not href: href leaves the authenticated page in history, so Back
         re-renders it. The session is gone, but a merchant surface painted from a
         bfcache snapshot still looks signed in. */
      location.replace('login.html');
    }
  };

  window._skSwitchWorkspace = function (businessId) {
    window._skCloseAcct();
    var targetId = (!businessId || businessId === 'personal') ? null : businessId;

    if (window.SokoniWorkspace) {
      window.SokoniWorkspace.switchTo(targetId);
    } else {
      /* Fallback: set localStorage directly if SDK not yet loaded */
      try {
        if (!targetId) localStorage.removeItem('sokoniActiveWorkspace');
        else           localStorage.setItem('sokoniActiveWorkspace', targetId);
      } catch (_) {}
      /* Fire the event manually so _updateWsBar picks it up */
      try {
        var wsList = JSON.parse(localStorage.getItem('sokoniWorkspaces') || '[]');
        var ws = targetId ? (wsList.find(function (w) { return w.businessId === targetId; }) || null) : null;
        document.dispatchEvent(new CustomEvent('sokoniWorkspaceChanged', { bubbles: true, detail: ws }));
      } catch (_) {}
    }
    /* No reload — the event listener below handles all UI updates */
  };

  /* ── Listen to workspace changes for instant header updates ── */
  document.addEventListener('sokoniWorkspaceChanged', function (e) {
    var ws = e.detail || null;

    /* Update the context bar */
    _updateWsBar(ws);

    /* Rebuild the account popup if it's currently open */
    var popup = document.getElementById('sk-acct-popup');
    if (popup) {
      try {
        var u = JSON.parse(localStorage.getItem('sokoniUser') || 'null');
        if (u) {
          popup.remove();
          _buildAcctPopup(u);
        }
      } catch (_) {}
    }
  });

  /* ══════════════════════════════════════════════════════════
     LIVE SEARCH AUTOCOMPLETE
  ══════════════════════════════════════════════════════════ */
  function _wireSearch() {
    const input = document.getElementById('sk-nav-search');
    const dropdown = document.getElementById('sk-nav-search-dropdown');
    if (!input || !dropdown) return;
    if (input.dataset.skWired) return;   /* idempotent — never double-wire (no duplicate listeners on re-mount) */
    input.dataset.skWired = '1';

    let _acTimer = null;
    let _focusIdx = -1;
    let _warmStarted = false;

    function _items() {
      return Array.from(dropdown.querySelectorAll('.sk-ac-item'));
    }

    function _setFocus(idx) {
      const items = _items();
      items.forEach((el, i) => el.classList.toggle('focused', i === idx));
      _focusIdx = idx;
    }

    function _close() {
      dropdown.classList.remove('open');
      _focusIdx = -1;
    }

    /* Size the panel to the space actually visible above the keyboard. On a
       phone the software keyboard shrinks window.visualViewport but NOT the CSS
       viewport, so a vh-based cap alone still lets rows hide behind the keyboard.
       Reading visualViewport.height gives the real visible height, so the list
       is bounded to it and scrolls for the rest — reachable on every device.
       Falls back to the CSS max-height (min(62vh,460px)) when unsupported. */
    function _fitDropdown() {
      try {
        if (!dropdown.classList.contains('open')) return;
        var vv = window.visualViewport;
        if (!vv) return; /* CSS max-height already applies */
        var top = dropdown.getBoundingClientRect().top;
        var avail = vv.height - top - 12;               /* 12px breathing room */
        if (avail < 140) avail = 140;                   /* never collapse to nothing */
        dropdown.style.maxHeight = Math.round(avail) + 'px';
      } catch (e) {}
    }
    /* Re-fit whenever the panel opens (any of the render paths toggles .open) or
       the visible viewport changes (keyboard show/hide, rotate). One observer
       covers every current and future open-site, so no render path can forget. */
    try {
      new MutationObserver(_fitDropdown).observe(dropdown,
        { attributes: true, attributeFilter: ['class'] });
      if (window.visualViewport) {
        window.visualViewport.addEventListener('resize', _fitDropdown);
        window.visualViewport.addEventListener('scroll', _fitDropdown);
      }
    } catch (e) {}

    function _fmt(n) {
      if (!n) return '';
      return 'KES ' + Number(n).toLocaleString();
    }

    function _esc(s) {
      return String(s || '').replace(/[&<>"']/g, c =>
        ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
    }

    function _hubIcon(hub) {
      const map = { shopping:'🛒', services:'🛠️', food:'🍔', property:'🏠',
        car:'🚗', healthcare:'🏥', legal:'⚖️', entertainment:'🎵',
        tech:'📱', events:'🎤', jobs:'💼', drivers:'🛵' };
      return map[(hub||'').toLowerCase()] || '📦';
    }

    function _safeHref(raw, fallback) {
      /* Block javascript: and data: URIs — only allow relative paths and https */
      if (!raw) return fallback;
      const lower = raw.trim().toLowerCase();
      if (lower.startsWith('javascript:') || lower.startsWith('data:') || lower.startsWith('vbscript:')) {
        return fallback;
      }
      return raw;
    }

    function _render(results, query) {
      if (!results.length) {
        dropdown.innerHTML =
          '<div class="sk-ac-footer">No results for "<strong>' + _esc(query) + '</strong>" — ' +
          '<a href="search.html?q=' + encodeURIComponent(query) + '">See all results</a></div>';
        dropdown.classList.add('open');
        return;
      }

      const rows = results.slice(0, 6).map(function(r) {
        const rawHref = r.href ||
          (r.type === 'product' ? 'product.html?id=' + encodeURIComponent(r.id || '') :
           r.type === 'service' ? 'services.html?s=' + encodeURIComponent(r.id || '') :
           'search.html?q=' + encodeURIComponent(r.name || query));
        const href = _safeHref(rawHref, 'search.html?q=' + encodeURIComponent(r.name || query));
        return '<a class="sk-ac-item" href="' + _esc(href) + '" role="option">' +
          '<span class="sk-ac-item-icon">' + _hubIcon(r.hub || r.category) + '</span>' +
          '<span class="sk-ac-item-text">' +
            '<div class="sk-ac-item-name">' + _esc(r.name || r.title || '') + '</div>' +
            (r.category || r.hub
              ? '<div class="sk-ac-item-meta">' + _esc(r.category || r.hub) + '</div>' : '') +
          '</span>' +
          (r.price ? '<span class="sk-ac-item-price">' + _fmt(r.price) + '</span>' : '') +
        '</a>';
      }).join('');

      dropdown.innerHTML = rows +
        '<div class="sk-ac-footer"><a href="search.html?q=' + encodeURIComponent(query) +
        '">See all results for "' + _esc(query) + '" →</a></div>';
      dropdown.classList.add('open');
      _focusIdx = -1;
    }

    function _query(q) {
      /* Cached suggestions first — they render in the same frame the user
         typed in. Anything that needs the network can only arrive after the
         next keystroke, by which point it is answering a stale prefix. */
      var api = window.SokoniFirestoreSearch;
      if (api && api.suggest) {
        var instant = api.suggest(q, 6);
        if (instant && instant.length) {
          _render(instant.map(function(r) {
            var num = r.price ? Number(String(r.price).replace(/[^0-9.]/g, '')) : null;
            return {
              id: r.id, name: r.title, href: r.link,
              category: r.subtitle, hub: r.tab,
              price: (num && !isNaN(num)) ? num : null,
            };
          }), q);
          return;
        }
      }

      /* Try SokoniSearchPro first, then SokoniSearch, then Firestore */
      if (window.SokoniSearchPro && window.SokoniSearchPro.autocomplete) {
        window.SokoniSearchPro.autocomplete(q, { limit: 6 })
          .then(function(r) { if (r && r.length) _render(r, q); else _firestoreSuggest(q); })
          .catch(function() { _firestoreSuggest(q); });
        return;
      }
      if (window.SokoniSearch) {
        const r = window.SokoniSearch.getSuggestions
          ? window.SokoniSearch.getSuggestions(q, 6)
          : [];
        if (r && r.length) {
          _render(r.map(function(s) {
            return typeof s === 'string'
              ? { name: s, type: 'product' }
              : s;
          }), q);
          return;
        }
      }
      _firestoreSuggest(q);
    }

    /* Last resort before the bare "search for X" shortcut: read Firestore
       directly. An empty autocomplete usually means the Algolia index is stale
       or its key is unavailable, not that the catalogue is empty — and a buyer
       typing a product name deserves the product, not a dead dropdown. */
    function _firestoreSuggest(q) {
      if (!window.firebaseDB) { _fallback(q); return; }
      /* The module is an ES module; load it on demand so every page carrying
         the shared header gets the fallback without another blocking script. */
      const ready = window.SokoniFirestoreSearch
        ? Promise.resolve(window.SokoniFirestoreSearch)
        : import('/sokoni-firestore-search.js').then(function() { return window.SokoniFirestoreSearch; });

      ready
        .then(function(api) {
          if (!api) throw new Error('firestore search unavailable');
          return api.search(q, { limit: 6 });
        })
        .then(function(rows) {
          if (!rows || !rows.length) { _fallback(q); return; }
          _render(rows.map(function(r) {
            /* _render formats the price itself, so hand it a number. */
            const num = r.price ? Number(String(r.price).replace(/[^0-9.]/g, '')) : null;
            return {
              id: r.id, name: r.title, href: r.link,
              category: r.subtitle, hub: r.tab,
              price: (num && !isNaN(num)) ? num : null,
            };
          }), q);
        })
        .catch(function() { _fallback(q); });
    }

    function _fallback(q) {
      /* No search engine loaded — show "search for X" shortcut */
      dropdown.innerHTML =
        '<a class="sk-ac-item" href="search.html?q=' + encodeURIComponent(q) + '">' +
          '<span class="sk-ac-item-icon">🔍</span>' +
          '<span class="sk-ac-item-text"><div class="sk-ac-item-name">Search for "' + _esc(q) + '"</div></span>' +
        '</a>';
      dropdown.classList.add('open');
    }

    function _renderFocusState() {
      const _RS_KEY = 'sokoniRecentSearches';
      let recent = [];
      try { recent = JSON.parse(localStorage.getItem(_RS_KEY)) || []; } catch(e) {}
      const trending = [
        { icon: '📱', label: 'Samsung A55' },
        { icon: '🏠', label: '2BR Nairobi rent' },
        { icon: '🚗', label: 'Toyota Axio' },
        { icon: '👗', label: 'Second-hand clothes' },
        { icon: '🍔', label: 'Food delivery' },
        { icon: '💼', label: 'Remote jobs Kenya' },
      ];
      let html = '';
      if (recent.length) {
        html += '<div class="sk-ac-section-hd">🕐 Recent</div>';
        html += recent.slice(0, 3).map(function(s) {
          return '<a class="sk-ac-item" href="search.html?q=' + encodeURIComponent(s) + '" role="option">' +
            '<span class="sk-ac-item-icon">🕐</span>' +
            '<span class="sk-ac-item-text"><div class="sk-ac-item-name">' + _esc(s) + '</div></span>' +
          '</a>';
        }).join('');
      }
      html += '<div class="sk-ac-section-hd">🔥 Trending</div>';
      html += trending.slice(0, recent.length ? 3 : 5).map(function(t) {
        return '<a class="sk-ac-item" href="search.html?q=' + encodeURIComponent(t.label) + '" role="option">' +
          '<span class="sk-ac-item-icon">' + t.icon + '</span>' +
          '<span class="sk-ac-item-text"><div class="sk-ac-item-name">' + _esc(t.label) + '</div></span>' +
        '</a>';
      }).join('');
      html += '<div class="sk-ac-footer"><a href="search.html">Browse all categories →</a></div>';
      dropdown.innerHTML = html;
      dropdown.classList.add('open');
      _focusIdx = -1;
    }

    input.addEventListener('input', function() {
      clearTimeout(_acTimer);
      const q = this.value.trim();
      if (q.length < 2) {
        if (q.length === 0) _renderFocusState();
        else _close();
        return;
      }
      _acTimer = setTimeout(function() { _query(q); }, 220);
    });

    /* Open the recent/trending panel ONLY on an explicit user click — NOT on bare
       focus. Programmatic focus (or focus restored after a pane re-render) must
       never pop the dropdown open; that was the "search opens by itself" bug. */
    input.addEventListener('click', function() {
      if (this.value.trim().length === 0) _renderFocusState();
    });

    input.addEventListener('focus', function() {
      /* Warm the catalogue on first focus — the user has signalled intent to
         search, so the data is loading while they type the first character.
         (Deliberately does NOT open the dropdown — see the click handler above.) */
      if (!_warmStarted && window.firebaseDB) {
        _warmStarted = true;
        import('/sokoni-firestore-search.js')
          .then(function() {
            var api = window.SokoniFirestoreSearch;
            if (api && api.warm) api.warm();
          })
          .catch(function() {});
      }
    });

    input.addEventListener('keydown', function(e) {
      if (!dropdown.classList.contains('open')) return;
      const items = _items();
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        _setFocus(Math.min(_focusIdx + 1, items.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        _setFocus(Math.max(_focusIdx - 1, 0));
      } else if (e.key === 'Enter' && _focusIdx >= 0 && items[_focusIdx]) {
        e.preventDefault();
        items[_focusIdx].click();
      } else if (e.key === 'Escape') {
        _close();
      }
    });

    /* Close when clicking outside */
    document.addEventListener('click', function(e) {
      if (!document.getElementById('sk-nav-search-wrap')?.contains(e.target)) _close();
    });
  }

  /* ══════════════════════════════════════════════════════════
     REAL-TIME NOTIFICATION + MESSAGE COUNTS (Firestore)
  ══════════════════════════════════════════════════════════ */
  function _setBadge(id, count) {
    const el = document.getElementById(id);
    if (!el) return;
    if (count > 0) {
      el.textContent = count > 99 ? '99+' : String(count);
      el.classList.add('visible');
    } else {
      el.classList.remove('visible');
    }
  }

  /* Exposed globally so other modules (sokoni-notifications.js etc.) can push counts */
  window.skNavSetUnread = function(type, count) {
    if (type === 'notifications') _setBadge('sk-notif-badge', count);
    if (type === 'messages')      _setBadge('sk-msg-badge', count);
  };

  var _realtimeUnsubs = [];

  function _wireRealtime(uid) {
    if (!uid) return;
    /* Clean up any previous listeners before attaching new ones */
    _realtimeUnsubs.forEach(function(fn) { try { fn(); } catch (_) {} });
    _realtimeUnsubs = [];

    Promise.all([
      import('https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js'),
      import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js'),
    ]).then(function(mods) {
      const { initializeApp, getApps } = mods[0];
      const { getFirestore, collection, query, where, onSnapshot } = mods[1];

      const FB_CFG = {
        apiKey: 'AIzaSyDt_FRoTdE5OpfPhLB0DApIm7p-I45hzVE',
        authDomain: 'auth.mysokoni.co.ke',
        projectId: 'sokoni-aeb26',
        storageBucket: 'sokoni-aeb26.firebasestorage.app',
        messagingSenderId: '24799054989',
        appId:"1:24799054989:web:e1cf6ca8c281bf1abf26c4",measurementId:"G-QT32H65TJS",
      };
      const app = getApps().length ? getApps()[0] : initializeApp(FB_CFG);
      const db  = getFirestore(app);

      /* Unread notifications — delegate to SokoniNotifEngine when available.
         Engine handles Firestore listener, cross-tab sync, badge updates itself.
         This fallback fires only if engine hasn't loaded yet. */
      if (!window.SokoniNotifEngine) {
        try {
          const unsubNotif = onSnapshot(
            query(collection(db, 'notifications'),
              where('targetUid', '==', uid),
              where('read', '==', false)),
            function(snap) {
              _setBadge('sk-notif-badge', snap.size);
              if (snap.size > 0) localStorage.setItem('sokoniHasNotif', '1');
              else localStorage.removeItem('sokoniHasNotif');
            },
            function() {}
          );
          _realtimeUnsubs.push(unsubNotif);
        } catch (e) {}
      }

      /* Unread messages — conversations where user is a participant,
         last message was sent by someone else, and unread > 0 */
      try {
        const unsubMsgs = onSnapshot(
          query(collection(db, 'conversations'),
            where('participants', 'array-contains', uid),
            where('unread', '>', 0)),
          function(snap) {
            /* Only count convos where the last sender is NOT the current user */
            var count = 0;
            snap.forEach(function(d) {
              if (d.data().lastSenderId !== uid) count++;
            });
            _setBadge('sk-msg-badge', count);
          },
          function() {}
        );
        _realtimeUnsubs.push(unsubMsgs);
      } catch (e) {}

    }).catch(function() { /* Firebase unavailable — skip live counts */ });
  }

  /* ── Multi-role switcher ── */
  /*
   * Renders a compact "Switch role" dropdown in the header nav actions area
   * when the signed-in user has more than one role. Clicking a role redirects
   * the user to that role's primary workspace.
   */
  var ROLE_ROUTES = {
    buyer:    'profile.html',
    seller:   'seller.html',
    provider: 'provider.html',
    driver:   'rider-nav.html',
    admin:    'admin-os.html',
    moderator:'admin-os.html',
  };
  var ROLE_ICONS = {
    buyer:'🛍️', seller:'🏪', provider:'🛠️', driver:'🚗', admin:'🛡️', moderator:'⚖️',
  };

  function _injectRoleSwitcher(roles, currentRole) {
    if (!roles || roles.length < 2) return; /* Only show when user has multiple roles */
    if (document.getElementById('sk-role-switcher')) return; /* Already injected */

    var actionsEl = document.getElementById('sk-nav-actions');
    if (!actionsEl) return;

    var wrapper = document.createElement('div');
    wrapper.id = 'sk-role-switcher';
    wrapper.style.cssText = 'position:relative;display:flex;align-items:center;';

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'sk-nav-icon-btn';
    btn.title = 'Switch workspace';
    btn.setAttribute('aria-label', 'Switch workspace');
    btn.setAttribute('aria-haspopup', 'true');
    btn.setAttribute('aria-expanded', 'false');
    btn.innerHTML = '<span style="font-size:11px;font-weight:700;letter-spacing:.3px;">' +
      (ROLE_ICONS[currentRole] || '👤') + '</span>';

    var menu = document.createElement('div');
    menu.id = 'sk-role-menu';
    menu.setAttribute('role', 'menu');
    menu.style.cssText = [
      'display:none;position:absolute;top:calc(100% + 6px);right:0;',
      'background:#0d0d0d;border:1px solid #1a1a1a;border-radius:10px;',
      'min-width:160px;z-index:9999;overflow:hidden;',
      'box-shadow:0 8px 24px rgba(0,0,0,.6);',
    ].join('');

    var header = document.createElement('div');
    header.style.cssText = 'padding:8px 12px 6px;font-size:10px;font-weight:600;color:#888;text-transform:uppercase;letter-spacing:.8px;border-bottom:1px solid #1a1a1a;';
    header.textContent = 'Your Workspaces';
    menu.appendChild(header);

    roles.forEach(function(role) {
      var item = document.createElement('a');
      item.href = ROLE_ROUTES[role] || 'profile.html';
      item.setAttribute('role', 'menuitem');
      item.style.cssText = [
        'display:flex;align-items:center;gap:10px;padding:10px 14px;',
        'color:#e8e8e8;text-decoration:none;font-size:13px;transition:background .15s;',
        role === currentRole ? 'background:rgba(113,255,0,.08);color:#71ff00;font-weight:600;' : '',
      ].join('');
      item.innerHTML = '<span>' + (ROLE_ICONS[role] || '👤') + '</span>' +
        '<span>' + role.charAt(0).toUpperCase() + role.slice(1) + '</span>' +
        (role === currentRole ? '<span style="margin-left:auto;font-size:10px;opacity:.6;">current</span>' : '');
      item.addEventListener('mouseenter', function() { this.style.background = 'rgba(255,255,255,.06)'; });
      item.addEventListener('mouseleave', function() {
        this.style.background = role === currentRole ? 'rgba(113,255,0,.08)' : '';
      });
      menu.appendChild(item);
    });

    var isOpen = false;
    btn.addEventListener('click', function(e) {
      e.stopPropagation();
      isOpen = !isOpen;
      menu.style.display = isOpen ? 'block' : 'none';
      btn.setAttribute('aria-expanded', String(isOpen));
    });
    document.addEventListener('click', function() {
      if (isOpen) { isOpen = false; menu.style.display = 'none'; btn.setAttribute('aria-expanded','false'); }
    });
    document.addEventListener('keydown', function(e) {
      if (e.key === 'Escape' && isOpen) { isOpen = false; menu.style.display = 'none'; btn.setAttribute('aria-expanded','false'); }
    });

    wrapper.appendChild(btn);
    wrapper.appendChild(menu);

    /* Insert before avatar button */
    var avatar = document.getElementById('sk-nav-avatar');
    if (avatar) actionsEl.insertBefore(wrapper, avatar);
    else actionsEl.insertBefore(wrapper, actionsEl.firstChild);
  }

  /* Wait for auth to be ready before starting Firestore listeners */
  function _waitForAuth() {
    /* Prefer the sokoniAuthReady event fired by firebase.js */
    document.addEventListener('sokoniAuthReady', function(e) {
      const uid = e.detail && e.detail.uid;
      if (uid) _wireRealtime(uid);

      /* Role switcher: read roles from event detail or from cached user */
      var roles = (e.detail && e.detail.roles) || [];
      var currentRole = (e.detail && e.detail.role) || '';
      if (!roles.length) {
        try {
          var u = JSON.parse(localStorage.getItem('sokoniUser') || 'null');
          if (u) {
            roles = u.roles || (u.role ? [u.role] : []);
            currentRole = currentRole || u.role || (roles[0] || '');
          }
        } catch (_) {}
      }
      _injectRoleSwitcher(roles, currentRole);
    }, { once: true });

    /* Fallback: poll localStorage for cached user (covers pages without firebase.js) */
    let _pollTries = 0;
    const _poll = setInterval(function() {
      _pollTries++;
      try {
        const u = JSON.parse(localStorage.getItem('sokoniUser') || 'null');
        if (u && u.uid) { clearInterval(_poll); _wireRealtime(u.uid); return; }
      } catch (e) {}
      if (_pollTries >= 20) clearInterval(_poll); /* give up after 10s */
    }, 500);
  }

  /* ── Inject on DOM ready ── */
  function _inject() {
    /* If the page already has a static #sk-top-nav (e.g. index.html bakes it
       in for zero-flash render), skip DOM insertion but still wire all events. */
    const _navExists = !!document.getElementById('sk-top-nav');
    if (!_navExists) {
      const nav = _buildNav();
      document.body.insertBefore(nav, document.body.firstChild);
    }
    /* Resolve Home for the acting role now that the anchor exists. The authorities may not
       have verified yet — they re-fire sokoniRoleAuthorityReady / sokoniActiveRoleChanged and
       this runs again. Until then the markup default '/' stands, which is the safe answer. */
    try { if (window._skApplyHomeHref) window._skApplyHomeHref(); } catch (_) {}

    /* sk-has-search already applied before first paint — only need idempotent add here */
    if (showSearch) document.body.classList.add('sk-has-search');
    if (_navExists) _refresh(); /* sync avatar/cart from localStorage */

    /* Build site menu drawer (SokoniDrawer-based) */
    _buildMenuDrawer();

    /* Init theme system — SokoniTheme may not be loaded yet; defer if needed */
    (function _initTheme() {
      if (window.SokoniTheme) {
        window.SokoniTheme.init();
      } else {
        setTimeout(_initTheme, 200);
      }
    })();

    /* Tag the main content area for the skip-nav link */
    const mainEl = document.querySelector('main') ||
                   document.querySelector('[role="main"]') ||
                   document.querySelector('.main-content') ||
                   document.querySelector('.container');
    if (mainEl && !mainEl.id) mainEl.id = 'sk-main-content';
    else if (!document.getElementById('sk-main-content')) {
      const body = document.body;
      for (const child of body.children) {
        if (child.id !== 'sk-top-nav' && child.id !== 'sk-skip-nav' &&
            child.tagName !== 'SCRIPT' && child.tagName !== 'STYLE') {
          if (!child.id) child.id = 'sk-main-content';
          break;
        }
      }
    }

    /* Wire search autocomplete */
    if (showSearch) _wireSearch();

    /* Wire notification center bell — deferred until scripts load */
    function _attachNotifCenter() {
      if (window.SokoniNotifCenter) {
        window.SokoniNotifCenter.attachBell(document.getElementById('sk-notif-btn'));
      } else {
        setTimeout(_attachNotifCenter, 300);
      }
    }
    setTimeout(_attachNotifCenter, 200);

    /* Wire real-time counts (fallback when notif engine not yet loaded) */
    _waitForAuth();

    /* ── Transparent-to-dark scroll behaviour ───────────────────────────
       The nav starts transparent so the hero shows through it.
       Once the user scrolls > 60px the nav darkens to remain readable. */
    (function _wireScroll() {
      var nav = document.getElementById('sk-top-nav');
      if (!nav) return;
      var _ticking = false;
      function _update() {
        nav.classList.toggle('sk-scrolled', window.scrollY > 60);
        _ticking = false;
      }
      window.addEventListener('scroll', function() {
        if (!_ticking) { requestAnimationFrame(_update); _ticking = true; }
      }, { passive: true });
      _update(); /* run once immediately */
    }());

    /* Cross-tab. The storage event fires in every OTHER tab but never in the
       one that performed the write, so this alone could never update the
       badge for the person who actually clicked Add to Cart. */
    window.addEventListener('storage', function (e) {
      if (e.key === 'cart' || e.key === 'sokoniUser') _refresh();
    });

    /* Same-tab. This is the authoritative signal: every cart mutation
       dispatches sokoni:cart-changed after persisting, and the header listens
       rather than each page remembering to call a refresh function. That
       inversion is the fix — the previous design required every future
       add-to-cart path to know about the header, and predictably they did
       not: skNavRefresh existed but was called from exactly one page. */
    window.addEventListener('sokoni:cart-changed', function () { _refresh(); });

    /* Retained for the one existing caller (business.html) and for pages that
       mutate the cart without going through a persist helper. Prefer
       dispatching sokoni:cart-changed. */
    window.skNavRefresh = _refresh;

    /* ── Register with Layout Manager so it knows the header height ── */
    function _registerWithLayout() {
      if (window.SokoniLayout) {
        window.SokoniLayout.register('header', document.getElementById('sk-top-nav'));
        /* Also auto-register bottom nav if present on this page */
        const bnav = document.getElementById('bottomNav') ||
                     document.querySelector('.bottom-nav, nav.bottom-nav');
        if (bnav) window.SokoniLayout.register('bottom-nav', bnav);
        /* Trigger a layout update so CSS vars are set correctly */
        window.SokoniLayout.measure();
      }
    }
    /* Layout Manager may not be loaded yet (it's deferred) — retry */
    if (window.SokoniLayout) {
      _registerWithLayout();
    } else {
      setTimeout(function() {
        _registerWithLayout();
        /* Second attempt in case layout.js was slow */
        setTimeout(_registerWithLayout, 500);
      }, 100);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _inject);
  } else {
    _inject();
  }

  /* ── NO GLOBAL FOOTER INJECTION ──────────────────────────────────────────────
     There was a SECOND injector here as well as the _injectAsset one above. Both
     are removed. The premium footer is page markup (<footer class="footer">)
     styled by style.css — .footer::before layers the dark gradient over
     assets/sokoni footer.png. It is not generated, and nothing should generate it.
     Rolled back to 911a042. */

  /* ── PUBLISH THE REAL HEADER HEIGHT ──────────────────────────────────────────
     --sk-header-h was a CSS constant (58px / 64px depending on which stylesheet won).
     The header is not a constant height: on a phone it wraps its search box onto a
     second row and stands ~110px tall. So every consumer of that variable — the sticky
     hub sub-navs, the Quick Actions bar, anything anchored below the header — was 50px
     out on mobile, sitting UNDER the header where its taps were swallowed by the search
     input. Visible, sticky, and unpressable.

     Measure it instead. A layout constant that is only true on a desktop is not a
     constant; it is a bug with a default value.

     Re-measured on resize and orientationchange, because the header's height genuinely
     changes when the search box wraps — and a value captured once at load is exactly how
     it drifted out of true in the first place. */
  (function () {
    var _raf = 0;

    function publishHeaderHeight() {
      var nav = document.getElementById('sk-top-nav');
      if (!nav) return;
      var r = nav.getBoundingClientRect();
      /* bottom, not height: the header may be inset from the top (safe-area, banners),
         and what a sticky element below it needs to clear is where the header ENDS. */
      var h = Math.round(r.bottom);
      if (!(h > 0) || h > 400) return;              /* nonsense guard */
      document.documentElement.style.setProperty('--sk-header-h', h + 'px');
    }

    function schedule() {
      if (_raf) cancelAnimationFrame(_raf);
      _raf = requestAnimationFrame(publishHeaderHeight);
    }

    /* The header is injected asynchronously, so measure once it exists rather than
       guessing when. ResizeObserver also catches the search box wrapping — which is the
       exact moment the height changes and the old constant went wrong. */
    function attach() {
      var nav = document.getElementById('sk-top-nav');
      if (!nav) { setTimeout(attach, 120); return; }
      publishHeaderHeight();
      if (window.ResizeObserver) new ResizeObserver(schedule).observe(nav);
      window.addEventListener('resize', schedule, { passive: true });
      window.addEventListener('orientationchange', schedule, { passive: true });
    }

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', attach, { once: true });
    } else {
      attach();
    }
  }());

})();
