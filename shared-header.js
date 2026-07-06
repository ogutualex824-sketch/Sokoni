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
  /* UI library — shared toast / modal / spinner / skeleton */
  _injectAsset('script', { src: 'sokoni-ui.js', defer: true }, 'sk-ui-script');
  /* Layout manager — resolves floating element overlaps, sets CSS vars */
  _injectAsset('script', { src: 'sokoni-layout.js', defer: true }, 'sk-layout-script');
  /* Notification engine — real-time engine, preferences, grouping */
  _injectAsset('script', { src: 'sokoni-notif-engine.js', defer: true }, 'sk-notif-engine-script');
  /* Notification center — bell UI, slide-in panel, inline actions */
  _injectAsset('script', { src: 'sokoni-notif-center.js', defer: true }, 'sk-notif-center-script');

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
    } else {
      window.addEventListener('load', function () {
        setTimeout(function () { if (!window.firebaseDB) _loadMock(); }, 2500);
      }, { once: true });
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

  /* ── PHASE 2: Nav injection — excluded pages stop here ──────────── */
  const EXCLUDED = [
    'pos.html', 'seller.html', 'login.html', 'signup.html',
    'register.html', 'success.html', 'offline.html',
    /* Profile has its own fully-featured .upn navigation bar */
    'profile.html',
    /* Enterprise full-screen dashboards — have their own specialized nav */
    'ecc.html', 'wap.html', 'gip.html', 'platform.html',
    'sasos-admin.html', 'pos-kiosk.html', 'superadmin.html',
    'monitor.html', 'moderation.html', 'verification-admin.html',
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

    /* ── Shared top header ── */
    #sk-top-nav {
      position: fixed; top: 0; left: 0; right: 0; z-index: 100001;
      height: 64px;
      display: flex; align-items: center; gap: 10px; padding: 0 18px;
      background: rgba(10,10,10,0.97);
      backdrop-filter: blur(28px); -webkit-backdrop-filter: blur(28px);
      border-bottom: 1px solid rgba(255,255,255,0.07);
      box-shadow: 0 2px 24px rgba(0,0,0,0.5);
      will-change: transform;
      transform: translateZ(0);
      -webkit-transform: translateZ(0);
    }
    /* ── Hide page-specific navs — preserve .sk-sub-nav tab bars ── */
    body > nav:not(#sk-top-nav):not(.bottom-nav):not(.sk-sub-nav),
    body > [role="navigation"]:not(#sk-top-nav):not(.bottom-nav):not(.sk-sub-nav),
    body > header { display: none !important; }

    /* ── Sub-nav tab bars: stick below the 64px shared header ── */
    body > .sk-sub-nav {
      position: sticky !important;
      top: 64px !important;
      z-index: 100 !important;
    }

    /* ── Hide home-page orphaned floating elements (hamburger + bell) ──
       These are <div> elements so the nav rule above doesn't catch them.
       style.css already pre-hides them, but this JS-injected rule provides
       the same guarantee on pages where style.css loads after this script. */
    .menu-toggle,
    #sokoni-bell-btn { display: none !important; }

    /* ── Ensure content is never hidden under the fixed header ── */
    body { padding-top: max(64px, calc(64px + env(safe-area-inset-top, 0px))) !important; }

    /* ── Logo ── */
    #sk-nav-logo {
      display: flex; align-items: center; flex-shrink: 0; text-decoration: none;
    }
    #sk-nav-logo img {
      height: 52px; width: auto; object-fit: contain; display: block;
      filter: drop-shadow(0 0 14px rgba(113,255,0,0.32));
      transition: filter .25s;
    }
    #sk-nav-logo:hover img {
      filter: drop-shadow(0 0 16px rgba(113,255,0,0.42));
    }
    #sk-nav-logo-text {
      font-size: 20px; font-weight: 900; color: #71ff00; letter-spacing: .03em;
      font-family: 'Segoe UI', system-ui, sans-serif;
      text-shadow: 0 0 12px rgba(113,255,0,0.35);
    }

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
    #sk-nav-search::placeholder { color: rgba(255,255,255,0.32); font-size: 13px; }
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
    #sk-nav-actions { display: flex; align-items: center; gap: 3px; flex-shrink: 0; margin-left: auto; }
    .sk-nav-icon-btn {
      display: flex; align-items: center; justify-content: center;
      width: 40px; height: 40px; border-radius: 50%;
      background: transparent; border: none; cursor: pointer;
      font-size: 18px; text-decoration: none; color: inherit; position: relative;
      transition: background .15s;
    }
    .sk-nav-icon-btn:hover { background: rgba(255,255,255,0.08); }

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
      display: flex; align-items: center; gap: 5px;
      padding: 8px 14px; border-radius: 22px;
      background: rgba(113,255,0,0.1); border: 1px solid rgba(113,255,0,0.2);
      color: #71ff00; font-size: 12px; font-weight: 800;
      text-decoration: none; transition: background .15s; flex-shrink: 0;
    }
    #sk-nav-cart:hover { background: rgba(113,255,0,0.2); }
    #sk-nav-cart-pip {
      background: #71ff00; color: #000; border-radius: 20px;
      min-width: 16px; height: 16px; font-size: 9px; font-weight: 900;
      display: flex; align-items: center; justify-content: center; padding: 0 3px;
      display: none;
    }

    /* ── Avatar ── */
    #sk-nav-avatar {
      width: 34px; height: 34px; border-radius: 50%;
      background: rgba(113,255,0,0.12); border: 1px solid rgba(113,255,0,0.28);
      display: flex; align-items: center; justify-content: center;
      font-size: 14px; font-weight: 900; color: #71ff00;
      text-decoration: none; flex-shrink: 0; transition: background .15s;
    }
    #sk-nav-avatar:hover { background: rgba(113,255,0,0.22); }

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
    body.light-mode #sk-top-nav {
      background: rgba(255,255,255,0.97);
      border-bottom-color: rgba(0,0,0,0.08);
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

    /* ── Mobile: two-row layout — logo + compact actions top, search below ── */
    @media (max-width: 768px) {
      /* Hide cart text label on tablet, keep pill icon */
      #sk-nav-cart-label { display: none; }
    }
    @media (max-width: 600px) {
      #sk-top-nav {
        height: auto; min-height: 52px; flex-wrap: wrap; padding: 8px 12px 8px; gap: 6px;
        align-items: center;
      }
      #sk-nav-logo { order: 0; flex-shrink: 0; }
      #sk-nav-logo img { height: 46px; }
      #sk-nav-actions { order: 1; margin-left: auto; gap: 1px; }
      /* Search drops to full-width second row */
      #sk-nav-search-wrap {
        order: 2; flex: 1 1 100%; max-width: 100%; margin: 0;
      }
      #sk-nav-search { padding: 9px 14px 9px 36px; font-size: 13px; }
      /* On mobile: show Notifications, Activity, Cart, Avatar, Menu
         Hide: Messages (use bottom-nav/messages page), Theme (use menu overlay chips) */
      #sk-nav-actions a[aria-label="Messages"],
      #sk-msg-btn { display: none !important; }
      #sk-theme-btn { display: none !important; }
      /* Activity visible on mobile per spec */
      #sk-activity-btn { display: flex !important; }
      /* Cart pill compact on mobile */
      #sk-nav-cart { padding: 7px 10px; font-size: 11px; }
      /* Avatar slightly smaller */
      #sk-nav-avatar { width: 30px; height: 30px; font-size: 12px; }
      /* Notification + menu icons */
      .sk-nav-icon-btn { width: 36px; height: 36px; font-size: 17px; }
      /* Two-row mobile nav (logo+icons row + search row) measures ~114px.
         Use 120px to give a safe 6px clearance on all mobile devices. */
      body { padding-top: max(60px, calc(60px + env(safe-area-inset-top, 0px))) !important; }
      body.sk-has-search { padding-top: max(120px, calc(120px + env(safe-area-inset-top, 0px))) !important; }
    }
    /* ── Very small phones ── */
    @media (max-width: 380px) {
      #sk-top-nav { padding: 7px 10px 6px; }
      .sk-nav-icon-btn { width: 32px; height: 32px; font-size: 15px; }
      #sk-nav-cart { padding: 6px 8px; font-size: 10px; }
      #sk-nav-logo img { height: 40px; }
      #sk-nav-avatar { width: 28px; height: 28px; font-size: 11px; }
      body { padding-top: max(55px, calc(55px + env(safe-area-inset-top, 0px))) !important; }
      body.sk-has-search { padding-top: max(110px, calc(110px + env(safe-area-inset-top, 0px))) !important; }
    }
  `;

  /* Inject CSS into <head> immediately (before DOM ready) */
  const styleEl = document.createElement('style');
  styleEl.id = 'sk-header-styles';
  styleEl.textContent = CSS;
  (document.head || document.documentElement).appendChild(styleEl);

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
      /* Logo */
      '<a href="index.html" id="sk-nav-logo" aria-label="SOKONI Home">' +
        '<img src="assets/Sokonilogo2.png" alt="SOKONI" ' +
          'onerror="this.style.display=\'none\';document.getElementById(\'sk-nav-logo-text\').style.display=\'block\'">' +
        '<span id="sk-nav-logo-text" style="display:none;">SOKONI</span>' +
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
      { icon:'🏠', label:'Home',          href:'index.html' },
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
        '<img src="assets/Sokonilogo2.png" alt="SOKONI" ' +
          'style="height:32px;width:auto;object-fit:contain;margin-left:4px;" ' +
          'onerror="this.style.display=\'none\'">' +
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

  function _wireRealtime(uid) {
    if (!uid) return;

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
          onSnapshot(
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
        } catch (e) {}
      }

      /* Unread messages — conversations where user is a participant,
         last message was sent by someone else, and unread > 0 */
      try {
        onSnapshot(
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
      } catch (e) {}

    }).catch(function() { /* Firebase unavailable — skip live counts */ });
  }

  /* Wait for auth to be ready before starting Firestore listeners */
  function _waitForAuth() {
    /* Prefer the sokoniAuthReady event fired by firebase.js */
    document.addEventListener('sokoniAuthReady', function(e) {
      const uid = e.detail && e.detail.uid;
      if (uid) _wireRealtime(uid);
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

})();
