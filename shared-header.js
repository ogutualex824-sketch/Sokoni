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
      '.sk-sp-logo{width:min(78vw,340px);height:auto;max-width:none!important;',
        'display:block;background:none;border:0;',
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
        '<img class="sk-sp-logo" src="assets/Sokoni Logo.png" alt="SOKONI">' +
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
    else { window.addEventListener('load', _dismiss, { once: true }); }
  }());

  /* ── PHASE 1: Infrastructure injection — runs on EVERY page ──────────
     All pages get tokens/UI/layout/notif regardless of nav exclusion.
     This gives every page: design tokens, toast system, layout manager,
     notification engine, and notification center bell/panel.         */

  function _injectAsset(tag, attrs, id) {
    if (document.getElementById(id)) return;
    const el = document.createElement(tag);
    el.id = id;
    Object.assign(el, attrs);
    (document.head || document.documentElement).appendChild(el);
  }

  /* Design tokens (CSS) — load first; tokens referenced by all CSS */
  _injectAsset('link', { rel: 'stylesheet', href: 'sokoni-tokens.css' }, 'sk-tokens-link');
  /* Premium component library — .sk-card, .sk-btn-*, .sk-badge, .sk-stat, etc. */
  _injectAsset('link', { rel: 'stylesheet', href: 'sokoni-components.css' }, 'sk-components-link');
  /* Quality design system — --so-* tokens, focus-visible ring, WCAG touch targets, skip links */
  _injectAsset('link', { rel: 'stylesheet', href: 'sokoni-quality.css' }, 'sk-quality-link');
  /* UI library — shared toast / modal / spinner / skeleton */
  _injectAsset('script', { src: 'sokoni-ui.js', defer: true }, 'sk-ui-script');
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
  /* Notification engine — real-time engine, preferences, grouping */
  _injectAsset('script', { src: 'sokoni-notif-engine.js', defer: true }, 'sk-notif-engine-script');
  /* Notification center — bell UI, slide-in panel, inline actions */
  _injectAsset('script', { src: 'sokoni-notif-center.js', defer: true }, 'sk-notif-center-script');
  /* Zero Trust client SDK — device fingerprint, risk cache, step-up auth guard */
  _injectAsset('script', { src: 'sokoni-zero-trust.js', defer: true }, 'sk-zero-trust-script');
  /* Phase 3 — Performance SDK: lazy loading, WebP, prefetch, optimistic UI */
  _injectAsset('script', { src: 'sokoni-performance.js', defer: true }, 'sk-performance-script');
  /* Phase 3 — Resilience SDK: circuit breakers, retry, offline queue */
  _injectAsset('script', { src: 'sokoni-resilience.js', defer: true }, 'sk-resilience-script');
  /* Phase 3 — Observability SDK: error tracking, Core Web Vitals, user journey */
  _injectAsset('script', { src: 'sokoni-observability.js', defer: true }, 'sk-observability-script');
  /* Command palette — Ctrl+K / Cmd+K global launcher */
  _injectAsset('script', { src: 'sokoni-command-palette.js', defer: true }, 'sk-command-palette-script');

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
      const d = document.createElement('script'); d.id = 'sk-mock-data'; d.src = 'sokoni-mock-data.js';
      d.onload = function () {
        const m = document.createElement('script'); m.id = 'sk-mock-engine'; m.src = 'sokoni-dev-mock.js';
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
    polishLink.href = 'sokoni-polish.css';
    (document.head || document.documentElement).appendChild(polishLink);
  }

  /* Global mobile responsive fixes (once) */
  if (!document.getElementById('sk-mobile-fixes-link')) {
    const mfLink = document.createElement('link');
    mfLink.rel = 'stylesheet';
    mfLink.id = 'sk-mobile-fixes-link';
    mfLink.href = 'sokoni-mobile-fixes.css';
    (document.head || document.documentElement).appendChild(mfLink);
  }

  /* Responsive v2 — premium UI/UX overhaul (once) */
  if (!document.getElementById('sk-responsive-link')) {
    const respLink = document.createElement('link');
    respLink.rel = 'stylesheet';
    respLink.id = 'sk-responsive-link';
    respLink.href = 'sokoni-responsive.css';
    (document.head || document.documentElement).appendChild(respLink);
  }

  /* Premium design system — dark theme, compact layout, glass cards (once) */
  if (!document.getElementById('sk-premium-link')) {
    const premLink = document.createElement('link');
    premLink.rel = 'stylesheet';
    premLink.id = 'sk-premium-link';
    premLink.href = 'premium.css';
    (document.head || document.documentElement).appendChild(premLink);
  }

  /* sokoni-premium-v2.css — phase 2 premium overrides (once) */
  if (!document.getElementById('sk-premium-v2-link')) {
    const pv2Link = document.createElement('link');
    pv2Link.rel = 'stylesheet';
    pv2Link.id = 'sk-premium-v2-link';
    pv2Link.href = 'sokoni-premium-v2.css';
    (document.head || document.documentElement).appendChild(pv2Link);
  }

  /* Universal drawer system — CSS + JS (once) */
  if (!document.getElementById('sk-drawers-link')) {
    const drawLink = document.createElement('link');
    drawLink.rel = 'stylesheet';
    drawLink.id = 'sk-drawers-link';
    drawLink.href = 'sokoni-drawers.css';
    (document.head || document.documentElement).appendChild(drawLink);
  }
  if (!document.getElementById('sk-drawer-script')) {
    const drawScript = document.createElement('script');
    drawScript.id = 'sk-drawer-script';
    drawScript.src = 'sokoni-drawer.js';
    drawScript.defer = true;
    (document.head || document.documentElement).appendChild(drawScript);
  }

  /* Promotion renderer — pages opt in with <div data-promo="home_hero"></div>.
     One injection point, so no page needs editing to receive promotions. */
  if (!document.getElementById('sk-promo-script')) {
    const promoJs = document.createElement('script');
    promoJs.id = 'sk-promo-script';
    promoJs.src = 'sokoni-promotions.js';
    promoJs.defer = true;
    (document.head || document.documentElement).appendChild(promoJs);
  }

  /* Smart offline detection — shows banner only when truly offline */
  if (!document.getElementById('sk-offline-script')) {
    const offlineJs = document.createElement('script');
    offlineJs.id = 'sk-offline-script';
    offlineJs.src = 'sokoni-offline.js';
    offlineJs.defer = true;
    (document.head || document.documentElement).appendChild(offlineJs);
  }

  /* Floating button manager — repositions FABs above bottom nav */
  if (!document.getElementById('sk-float-script')) {
    const floatJs = document.createElement('script');
    floatJs.id = 'sk-float-script';
    floatJs.src = 'sokoni-float.js';
    floatJs.defer = true;
    (document.head || document.documentElement).appendChild(floatJs);
  }

  /* Role-based navigation engine — CSS + JS (once, runs on all pages) */
  if (!document.getElementById('sk-nav-engine-link')) {
    const navCss = document.createElement('link');
    navCss.rel = 'stylesheet';
    navCss.id = 'sk-nav-engine-link';
    navCss.href = 'sokoni-nav-engine.css';
    (document.head || document.documentElement).appendChild(navCss);
  }
  if (!document.getElementById('sk-nav-engine-script')) {
    const navJs = document.createElement('script');
    navJs.id = 'sk-nav-engine-script';
    navJs.src = 'sokoni-nav-engine.js';
    navJs.defer = true;
    (document.head || document.documentElement).appendChild(navJs);
  }

  /* Universal Form Engine — mobile scrollability, keyboard avoidance, safe areas */
  if (!document.getElementById('sk-form-engine-link')) {
    const feLink = document.createElement('link');
    feLink.rel = 'stylesheet';
    feLink.id = 'sk-form-engine-link';
    feLink.href = 'sokoni-form-engine.css';
    (document.head || document.documentElement).appendChild(feLink);
  }
  if (!document.getElementById('sk-form-engine-script')) {
    const feJs = document.createElement('script');
    feJs.id = 'sk-form-engine-script';
    feJs.src = 'sokoni-form-engine.js';
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
      lnk.href = 'sokoni-platform-override.css';
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
  if (EXCLUDED.includes(page)) return;
  if (document.documentElement.dataset.noHeader === 'true') return;
  /* NOTE: pages that bake #sk-top-nav as static HTML (e.g. index.html) still need
     the CSS injection and event wiring below — _inject() handles that gracefully
     by checking whether the nav already exists before calling _buildNav(). */

  /* ── Pages where search bar is hidden — computed BEFORE CSS injection ── */
  const NO_SEARCH = [
    'checkout.html', 'cart.html', 'track.html', 'messages.html',
    'dispute.html', 'invoice.html', 'notifications.html',
    'profile.html', 'reviews.html', 'referral.html',
    'subscriptions.html', 'loyalty.html',
  ];
  const showSearch = !NO_SEARCH.includes(page);

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
      will-change: transform;
      transform: translateZ(0);
      -webkit-transform: translateZ(0);
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
    body > .sk-sub-nav {
      position: sticky !important;
      top: 58px !important;
      z-index: 100 !important;
      box-shadow: 0 2px 10px rgba(0,0,0,0.28), 0 1px 0 rgba(113,255,0,0.05) !important;
    }
    /* ── Hub logos inside sub-navs: suppressed — branding lives in sk-top-nav ── */
    body > .sk-sub-nav [class*="-nav-logo"],
    body > .sk-sub-nav .hc-nav-logo,
    body > .sk-sub-nav .sv-nav-logo,
    body > .sk-sub-nav .ch-nav-logo,
    body > .sk-sub-nav .th-nav-logo,
    body > .sk-sub-nav .en-nav-logo {
      display: none !important;
    }
    /* ── Hub nav inner rows: horizontal scroll, no wrap, 44px touch targets ── */
    body > .sk-sub-nav [class*="-nav-right"],
    body > .sk-sub-nav [class*="-nav-tabs"] {
      overflow-x: auto !important;
      -webkit-overflow-scrolling: touch !important;
      overscroll-behavior-x: contain !important;
      scrollbar-width: none !important;
      -ms-overflow-style: none !important;
    }
    body > .sk-sub-nav [class*="-nav-right"]::-webkit-scrollbar,
    body > .sk-sub-nav [class*="-nav-tabs"]::-webkit-scrollbar { display: none !important; }
    /* ── Hub nav link items: no squeeze, no wrap, proper touch targets ── */
    body > .sk-sub-nav [class*="-nav-link"],
    body > .sk-sub-nav [class*="-nav-tab"],
    body > .sk-sub-nav [class*="-nav-btn"] {
      flex-shrink: 0 !important;
      white-space: nowrap !important;
      min-height: 40px !important;
    }

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
      background: rgba(255,255,255,0.07); border: 1px solid rgba(255,255,255,0.12);
      border-radius: 28px; color: rgba(255,255,255,0.92); font-size: 14px;
      font-family: 'Segoe UI', system-ui, sans-serif; outline: none;
      transition: border-color .2s, background .2s, box-shadow .2s;
    }
    #sk-nav-search:focus {
      border-color: rgba(113,255,0,0.45);
      background: rgba(255,255,255,0.1);
      box-shadow: 0 0 0 3px rgba(113,255,0,0.08), 0 4px 20px rgba(0,0,0,0.3);
    }
    #sk-nav-search::placeholder { color: rgba(255,255,255,0.32); font-size: 14px; }
    #sk-nav-search-icon {
      position: absolute; left: 14px; top: 50%; transform: translateY(-50%);
      font-size: 15px; pointer-events: none; opacity: .45;
    }

    /* ── Autocomplete dropdown ── */
    #sk-nav-search-dropdown {
      position: absolute; top: calc(100% + 6px); left: 0; right: 0;
      background: rgba(14,14,14,0.98);
      border: 1px solid rgba(255,255,255,0.1);
      border-radius: 16px; overflow: hidden;
      box-shadow: 0 12px 40px rgba(0,0,0,0.6);
      z-index: 700; display: none;
      backdrop-filter: blur(20px);
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
    }
    #sk-nav-avatar:hover { background: rgba(113,255,0,0.18); border-color: rgba(113,255,0,0.4); }

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
        height: auto; min-height: 48px; flex-wrap: wrap; padding: 7px 12px 6px; gap: 4px;
        align-items: center;
      }
      #sk-nav-logo { order: 0; flex-shrink: 0; }
      #sk-nav-logo img { height: 26px; }
      #sk-nav-actions { order: 1; margin-left: auto; gap: 0; }
      /* Search second row — full width */
      #sk-nav-search-wrap {
        order: 2; flex: 1 1 100%; max-width: 100%; margin: 0; margin-top: 2px;
      }
      #sk-nav-search { padding: 8px 14px 8px 36px; font-size: 16px; }
      /* Mobile: hide Messages + Theme */
      #sk-msg-btn { display: none !important; }
      #sk-theme-btn { display: none !important; }
      /* Activity visible on mobile */
      #sk-activity-btn { display: flex !important; }
      /* Cart pill: compact */
      #sk-nav-cart { padding: 6px 10px; font-size: 11px; }
      /* Avatar */
      #sk-nav-avatar { width: 28px; height: 28px; font-size: 12px; }
      /* Icon buttons */
      .sk-nav-icon-btn { width: 34px; height: 34px; font-size: 16px; }
      /* Body padding: row1 ~48px + row2 search ~40px + gaps ~6px = ~94px */
      body { padding-top: max(52px, calc(52px + env(safe-area-inset-top, 0px))) !important; }
      body.sk-has-search { padding-top: max(106px, calc(106px + env(safe-area-inset-top, 0px))) !important; }
    }
    /* ── Very small phones (320–380px) ── */
    @media (max-width: 380px) {
      #sk-top-nav { padding: 6px 10px 5px; }
      .sk-nav-icon-btn { width: 30px; height: 30px; font-size: 15px; }
      #sk-nav-cart { padding: 5px 8px; font-size: 10px; }
      #sk-nav-logo img { height: 24px; }
      #sk-nav-avatar { width: 26px; height: 26px; font-size: 11px; }
      body { padding-top: max(48px, calc(48px + env(safe-area-inset-top, 0px))) !important; }
      body.sk-has-search { padding-top: max(100px, calc(100px + env(safe-area-inset-top, 0px))) !important; }
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
    let user = null, cartCount = 0, hasNotif = false;
    try { user = JSON.parse(localStorage.getItem('sokoniUser') || 'null'); } catch (e) {}
    try {
      const cart = JSON.parse(localStorage.getItem('cart') || '[]');
      cartCount = cart.reduce((s, i) => s + (i.qty || 1), 0);
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
        '<img src="assets/Sokoni Logo.png" alt="SOKONI">' +
      '</a>' +

      /* Search */
      (showSearch
        ? '<div id="sk-nav-search-wrap" role="search">' +
            '<span id="sk-nav-search-icon" aria-hidden="true">🔍</span>' +
            '<input id="sk-nav-search" type="search" placeholder="Search products, services…" ' +
              'autocomplete="off" aria-label="Search SOKONI" ' +
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

        /* Cart */
        '<a href="cart.html" id="sk-nav-cart" aria-label="Shopping cart">' +
          '<span aria-hidden="true">🛒</span> <span id="sk-nav-cart-pip" style="display:' + (cartCount > 0 ? 'flex' : 'none') + ';" aria-label="' + (cartCount || 0) + ' items">' + (cartCount || 0) + '</span>' +
        '</a>' +

        /* Avatar / Profile */
        '<a href="' + profileHref + '" id="sk-nav-avatar" aria-label="Profile">' + initial + '</a>' +

        /* Theme toggle */
        '<button type="button" class="sk-nav-icon-btn" id="sk-theme-btn" ' +
          'aria-label="Toggle theme" title="Toggle theme" ' +
          'onclick="if(window.SokoniTheme){SokoniTheme.toggle();}">' +
          '<span id="sk-theme-icon" aria-hidden="true">' + themeIcon + '</span>' +
        '</button>' +

        /* Menu (hamburger) */
        '<button type="button" class="sk-nav-icon-btn" id="sk-menu-btn" aria-label="Menu" aria-expanded="false" ' +
          'onclick="var _sd=window.SokoniDrawer;_sd?_sd.open(\'sk-menu-drawer\'):void 0;this.setAttribute(\'aria-expanded\',\'true\');">' +
          '<span aria-hidden="true" style="font-size:13px;font-weight:900;letter-spacing:0px;display:flex;flex-direction:column;gap:3px;">' +
            '<span style="display:block;width:18px;height:2px;background:currentColor;border-radius:2px;"></span>' +
            '<span style="display:block;width:14px;height:2px;background:currentColor;border-radius:2px;"></span>' +
            '<span style="display:block;width:18px;height:2px;background:currentColor;border-radius:2px;"></span>' +
          '</span>' +
        '</button>' +

      '</div>';

    return nav;
  }

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
      { icon:'🛵', label:'Deliveries',     href:'delivery.html' },
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
          '<img src="assets/sokoni-logo-dark.png" alt="" style="height:32px;width:auto">' +
          '<span style="font-size:19px;font-weight:900;letter-spacing:.04em;color:#fff;line-height:1">SOKO<em style="font-style:normal;color:#71ff00">NI</em></span>' +
        '</div>' +
        '<button class="sk-drawer-close" type="button" aria-label="Close menu">✕</button>' +
      '</div>' +
      /* Scrollable drawer body */
      '<div class="sk-drawer-body">' +
        '<div id="sk-menu-grid">' +
          LINKS.map(function(l) {
            return '<a href="' + l.href + '" class="sk-menu-item">' +
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

  /* ── Update live state without rebuilding ── */
  function _refresh() {
    const { user, cartCount } = _readState();

    const pip = document.getElementById('sk-nav-cart-pip');
    if (pip) {
      pip.textContent = cartCount;
      pip.style.display = cartCount > 0 ? 'flex' : 'none';
    }

    const avatar = document.getElementById('sk-nav-avatar');
    if (avatar && user) {
      const initial = (user.name || user.email || '').charAt(0).toUpperCase() || '👤';
      avatar.textContent = initial;
      avatar.href = 'profile.html';
    }
  }

  /* ══════════════════════════════════════════════════════════
     LIVE SEARCH AUTOCOMPLETE
  ══════════════════════════════════════════════════════════ */
  function _wireSearch() {
    const input = document.getElementById('sk-nav-search');
    const dropdown = document.getElementById('sk-nav-search-dropdown');
    if (!input || !dropdown) return;

    let _acTimer = null;
    let _focusIdx = -1;

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
      /* Try SokoniSearchPro first, then SokoniSearch, then nothing */
      if (window.SokoniSearchPro && window.SokoniSearchPro.autocomplete) {
        window.SokoniSearchPro.autocomplete(q, { limit: 6 })
          .then(function(r) { _render(r, q); })
          .catch(function() { _fallback(q); });
        return;
      }
      if (window.SokoniSearch) {
        const r = window.SokoniSearch.getSuggestions
          ? window.SokoniSearch.getSuggestions(q, 6)
          : [];
        _render(r.map(function(s) {
          return typeof s === 'string'
            ? { name: s, type: 'product' }
            : s;
        }), q);
        return;
      }
      _fallback(q);
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

    input.addEventListener('focus', function() {
      if (this.value.trim().length === 0) _renderFocusState();
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
        authDomain: 'sokoni-aeb26.firebaseapp.com',
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

    /* Listen for cart/auth changes from other tabs */
    window.addEventListener('storage', function (e) {
      if (e.key === 'cart' || e.key === 'sokoniUser') _refresh();
    });

    /* Let pages call window.skNavRefresh() when they update the cart inline */
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

})();
