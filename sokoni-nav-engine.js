/* ================================================================
   SOKONI Navigation Engine v2.0
   Enterprise role-based navigation — mobile + desktop.

   v2.0 additions:
   • Desktop sidebar for seller / admin / superAdmin workspaces
     — 220px full panel on ≥1024px, 56px icon-rail on 769–1023px
   • _SIDEBAR_CONFIGS: categorised items for all 3 workspaces
   • _buildDesktopSidebar / _destroySidebar
   • Resize handler: sidebar rebuilds on 769px breakpoint crossing
   • Fixed _buildMenuBadge: deferred injection after first drawer open
   • Storage listener: calls _destroySidebar() before re-init
================================================================ */
(function () {
  'use strict';

  /* Normalize: strip .html so this works with both /login and /login.html (Firebase cleanUrls) */
  var _page = (location.pathname.split('/').pop().split('?')[0] || 'index').toLowerCase().replace(/\.html$/, '');

  /* Pages that are fully self-managed — zero injection */
  var _SKIP = [
    'index',
    'education',
    'jobs',
    'login', 'signup',
    'register', 'success', 'offline', 'admin',
    'profile', 'ecc', 'wap', 'gip', 'platform',
    'sasos-admin', 'pos-kiosk', 'pos-display', 'superadmin',
    'monitor', 'moderation', 'verification-admin'
  ];

  /* Pages that manage their own bottom nav — get sub-nav + back btn only.
     'provider' and 'services' are CUSTOMER-FACING: browsing services, and the
     "What are you offering?" listing form. Once an account gains the seller role this
     engine swapped their nav for the seller tabs (Dashboard / Products / Orders /
     Earnings / More), so a merchant creating a service listing was handed their own
     back-office nav mid-task with no way back to Home or Services. The pages keep their
     own customer nav regardless of workspace. */
  var _KEEP_OWN_BOTTOM = ['seller', 'pos', 'provider', 'services'];

  if (_SKIP.indexOf(_page) > -1) return;
  if (document.documentElement.dataset.noHeader === 'true') return;

  /* ── Role detection ──────────────────────────────────────── */
  function _role() {
    try {
      var u = JSON.parse(localStorage.getItem('sokoniUser') || 'null');
      if (!u) return 'buyer';
      var r = Array.isArray(u.roles) ? u.roles : [];
      if (r.indexOf('superAdmin') > -1) return 'superAdmin';
      if (r.indexOf('admin')      > -1) return 'admin';
      if (u.isAdmin)                    return 'admin';
      if (r.indexOf('driver')     > -1) return 'driver';
      if (u.isDriver)                   return 'driver';
      if (r.indexOf('rider')      > -1) return 'rider';
      if (r.indexOf('provider')   > -1) return 'provider';
      /* Mirror the seller fallbacks below: a service provider onboarded with
         isProvider/registeredAs.provider but no explicit roles array (as the
         onboarding scripts wrote them) was falling through to 'buyer' and could
         not reach their provider workspace after logging in. */
      if (u.isProvider)                 return 'provider';
      if (u.registeredAs && u.registeredAs.provider) return 'provider';
      if (r.indexOf('seller')     > -1) return 'seller';
      if (u.isSeller)                   return 'seller';
      if (u.registeredAs && u.registeredAs.seller) return 'seller';
    } catch (_) {}
    return 'buyer';
  }

  /* All roles this user holds — drives multi-role switcher */
  function _allRoles() {
    try {
      var u = JSON.parse(localStorage.getItem('sokoniUser') || 'null');
      if (!u) return [];
      var r   = Array.isArray(u.roles) ? u.roles : [];
      var out = [];
      if (r.indexOf('superAdmin') > -1)                                         out.push('superAdmin');
      if (r.indexOf('admin')      > -1 || u.isAdmin)                            out.push('admin');
      if (r.indexOf('driver')     > -1 || u.isDriver)                           out.push('driver');
      if (r.indexOf('rider')      > -1)                                         out.push('rider');
      if (r.indexOf('provider')   > -1 || u.isProvider ||
          (u.registeredAs && u.registeredAs.provider))                          out.push('provider');
      if (r.indexOf('seller')     > -1 || u.isSeller ||
          (u.registeredAs && u.registeredAs.seller))                            out.push('seller');
      out.push('buyer');
      return out.length > 1 ? out : [];
    } catch (_) { return []; }
  }

  /* ── Page → workspace mapping ────────────────────────────── */
  var _WS_MAP = {
    /* ─ Seller core ─ */
    'seller.html':               'seller',
    'minishop.html':             'seller',
    'minishop-admin.html':       'seller',
    'minishop-status.html':      'seller',
    'qr-center.html':            'seller',
    'creative-studio.html':      'seller',
    'seller-analytics.html':     'seller',
    'seller-revenue.html':       'seller',
    'seller-earnings.html':      'seller',
    'seller-delivery.html':      'seller',
    'seller-success.html':       'seller',
    'seller-terms.html':         'seller',
    'merchant-success.html':     'seller',
    'merchant-pipeline.html':    'seller',
    'inventory.html':            'seller',
    'revenue.html':              'seller',
    'subscription-billing.html': 'seller',
    'commission-engine.html':    'seller',
    'flash-sales.html':          'seller',
    'flashsale.html':            'seller',
    'availability-manager.html': 'seller',
    'onboarding-seller.html':    'seller',
    'digital-esoko.html':        'seller',
    'digital-esoko-seller.html': 'seller',
    'etims-seller.html':         'seller',
    'loyalty-merchant.html':     'seller',
    'b2b-seller-dashboard.html': 'seller',
    'messages.html':             'seller',
    /* ─ POS family ─ */
    'pos.html':                  'seller',
    'pos-workspace.html':        'seller',
    'pos-accounting.html':       'seller',
    'pos-ai.html':               'seller',
    'pos-bi.html':               'seller',
    'pos-checkout.html':         'seller',
    'pos-crm-pro.html':          'seller',
    'pos-daily.html':            'seller',
    'pos-hardware-wizard.html':  'seller',
    'pos-hq.html':               'seller',
    'pos-marketplace.html':      'seller',
    'pos-observability.html':    'seller',
    'pos-onboard.html':          'seller',
    'pos-printer-setup.html':    'seller',
    'pos-setup.html':            'seller',
    'pos-staff-ops.html':        'seller',
    'pos-inventory.html':        'seller',
    'pos-customers.html':        'seller',
    'pos-suppliers.html':        'seller',
    'pos-reports.html':          'seller',
    /* ─ Specialty seller pages ─ */
    'property-listing.html':          'seller',
    'property-agent.html':            'seller',
    'property-agent-dashboard.html':  'seller',
    'property-dashboard.html':        'seller',
    'car-rental.html':                'seller',
    'event-manager.html':             'seller',
    'hub-dashboard.html':             'seller',
    /* ─ Admin workspace ─ */
    'admin-os.html':            'admin',
    'admin-messages.html':      'admin',
    'trust-safety.html':        'admin',
    'reliability-center.html':  'admin',
    'platform-health.html':     'admin',
    'launch-readiness.html':    'admin',
    'business-kpi.html':        'admin',
    'ops-dashboard.html':       'admin',
    'business-analytics.html':  'admin',
    /* ─ Super Admin workspace ─ */
    'super-admin.html':         'superAdmin',
    'finos.html':               'superAdmin',
    'financial-os.html':        'superAdmin',
    'subscription-os.html':     'superAdmin',
    'enterprise-search.html':   'superAdmin',
    'ai-subscriptions.html':    'superAdmin',
    'admin-subscriptions.html': 'superAdmin',
    /* ─ Rider workspace ─ */
    'rider-nav.html':           'rider',
    /* ─ Driver workspace ─ */
    'driver.html':              'driver',
    'fleet-monitor.html':       'driver',
    'dispatch.html':            'driver',
    /* ─ Provider workspace ─ */
    'venue-booking.html':       'provider',
    'venue-manager.html':       'provider'
  };

  function _workspace() {
    var r      = _role();
    var mapped = _WS_MAP[_page];
    if (!mapped) return r;
    if (mapped === 'superAdmin') return (r === 'superAdmin') ? 'superAdmin' : (r === 'admin' ? 'admin' : 'buyer');
    if (mapped === 'admin')      return (r === 'admin' || r === 'superAdmin') ? 'admin' : 'buyer';
    if (mapped === 'seller')     return (r === 'seller' || r === 'admin' || r === 'superAdmin') ? 'seller' : 'buyer';
    return mapped;
  }

  /* ── Nav tab configs ─────────────────────────────────────── */
  /* ONE bottom nav for every role and every page.
     This engine overwrites .bottom-nav at runtime, so this array — not the static
     markup — is what actually renders. The static markup in the pages is aligned
     to match it exactly, keeping first paint identical to the hydrated state.

     "/" is the canonical homepage, the same target the header logo uses. It was
     "index.html", which Firebase 301s to "/", costing a round-trip on every Home
     tap and (until the service worker was fixed) producing ERR_FAILED outright.

     Role-specific destinations (seller Dashboard/Products/Earnings, rider Jobs
     and Deliveries, admin Users/Reports/Settings) are NOT lost — they remain in
     the role-aware More drawer and desktop sidebar built from _SUBNAV below. The
     bottom bar is deliberately the same five customer tabs everywhere so the app
     never changes shape underneath the user when their role context shifts. */
  var _CANONICAL_TABS = [
    { i:'🏠',  l:'Home',     h:'/' },
    { i:'🛍️', l:'Shop',     h:'category.html?cat=all' },
    { i:'🛠️', l:'Services', h:'services.html' },
    { i:'📦',  l:'Orders',   h:'my-orders.html' },
    { i:'👤',  l:'Profile',  h:'profile.html' }
  ];

  var _TABS = {
    buyer:      _CANONICAL_TABS,
    seller:     _CANONICAL_TABS,
    rider:      _CANONICAL_TABS,
    driver:     _CANONICAL_TABS,
    provider:   _CANONICAL_TABS,
    admin:      _CANONICAL_TABS,
    superAdmin: _CANONICAL_TABS
  };

  /* ── Seller sub-nav items (with category metadata for More drawer grouping) ── */
  var _SUBNAV = [
    { i:'📊',  l:'Dashboard',    h:'seller.html',              cat:'core'  },
    { i:'📦',  l:'Products',     h:'seller.html#products',     cat:'core'  },
    { i:'🛒',  l:'Orders',       h:'seller.html#orders',       cat:'core'  },
    { i:'📋',  l:'Inventory',    h:'inventory.html',           cat:'core'  },
    { i:'📈',  l:'Analytics',    h:'seller-analytics.html',    cat:'grow'  },
    { i:'📣',  l:'Marketing',    h:'seller.html#marketing',    cat:'grow'  },
    { i:'⚡',  l:'Flash Sales',  h:'seller.html#flash',        cat:'grow'  },
    { i:'🎁',  l:'Loyalty',      h:'loyalty-merchant.html',    cat:'grow'  },
    { i:'🏪',  l:'MiniShop',     h:'minishop-admin.html',      cat:'grow'  },
    { i:'💳',  l:'Payments',     h:'seller.html#payments',     cat:'money' },
    { i:'💰',  l:'Revenue',      h:'seller-revenue.html',      cat:'money' },
    { i:'💵',  l:'Earnings',     h:'seller-earnings.html',     cat:'money' },
    { i:'🧾',  l:'eTIMS',        h:'etims-seller.html',        cat:'money' },
    { i:'🖥️', l:'POS',          h:'pos.html',                 cat:'tools' },
    { i:'💬',  l:'Messages',     h:'messages.html',            cat:'tools' },
    { i:'⚖️', l:'Disputes',     h:'seller.html#disputes',     cat:'tools' },
    { i:'⬛',  l:'QR Payments',  h:'qr-center.html',           cat:'tools' },
    { i:'🗓️', l:'Availability', h:'availability-manager.html', cat:'tools' },
    { i:'🔴',  l:'Live Dashboard',h:'seller.html#live',        cat:'tools' },
    { i:'👥',  l:'Customers',    h:'seller.html#customers',    cat:'tools' },
    { i:'⚙️', l:'Settings',     h:'account-centre.html',      cat:'tools' }
  ];

  var _SUBNAV_CATS = [
    { key:'core',  l:'Core',   i:'🎯' },
    { key:'grow',  l:'Grow',   i:'🚀' },
    { key:'money', l:'Money',  i:'💵' },
    { key:'tools', l:'Tools',  i:'🔧' }
  ];

  /* ── Desktop sidebar nav configurations ─────────────────── */
  var _SIDEBAR_CONFIGS = {
    seller: {
      icon:  '🏪',
      label: 'Seller Hub',
      cats:  _SUBNAV_CATS,
      items: _SUBNAV
    },
    admin: {
      icon:  '⚙️',
      label: 'Admin',
      cats: [
        { key:'core',      l:'Core',      i:'🎯' },
        { key:'analytics', l:'Analytics', i:'📈' },
        { key:'security',  l:'Security',  i:'🔒' },
        { key:'settings',  l:'Settings',  i:'⚙️' }
      ],
      items: [
        { i:'📊', l:'Overview',       h:'admin-os.html',             cat:'core'      },
        { i:'🏪', l:'Marketplace',    h:'admin-os.html#marketplace', cat:'core'      },
        { i:'👥', l:'Users',          h:'admin-os.html#users',       cat:'core'      },
        { i:'📦', l:'Orders',         h:'admin-os.html#orders',      cat:'core'      },
        { i:'🚨', l:'Alerts',         h:'admin-os.html#alerts',      cat:'core'      },
        { i:'📈', l:'Analytics',      h:'business-analytics.html',   cat:'analytics' },
        { i:'💹', l:'Reports',        h:'reliability-center.html',   cat:'analytics' },
        { i:'🏥', l:'Health',         h:'platform-health.html',      cat:'analytics' },
        { i:'🔒', l:'Trust & Safety', h:'trust-safety.html',         cat:'security'  },
        { i:'🛡️',l:'Security',       h:'admin-os.html#security',    cat:'security'  },
        { i:'⚙️',l:'Settings',       h:'admin-os.html#settings',    cat:'settings'  }
      ]
    },
    superAdmin: {
      icon:  '👑',
      label: 'Super Admin',
      cats: [
        { key:'core',     l:'Core',    i:'🎯' },
        { key:'finance',  l:'Finance', i:'💵' },
        { key:'security', l:'Security',i:'🔒' },
        { key:'ai',       l:'AI',      i:'🤖' }
      ],
      items: [
        { i:'📊', l:'Dashboard',  h:'super-admin.html',           cat:'core'     },
        { i:'🏗️',l:'Platform',   h:'platform.html',              cat:'core'     },
        { i:'👥', l:'Users',      h:'super-admin.html#users',     cat:'core'     },
        { i:'💵', l:'Finance',    h:'finos.html',                 cat:'finance'  },
        { i:'🏦', l:'FinOS',      h:'financial-os.html',          cat:'finance'  },
        { i:'💳', l:'Billing',    h:'subscription-os.html',       cat:'finance'  },
        { i:'🔒', l:'Security',   h:'trust-safety.html',          cat:'security' },
        { i:'🛡️',l:'Zero Trust', h:'super-admin.html#security',  cat:'security' },
        { i:'🤖', l:'AI',         h:'ai-subscriptions.html',      cat:'ai'       },
        { i:'🔍', l:'Search',     h:'search.html',                cat:'ai'       }
      ]
    }
  };

  /* ── Back destination per workspace ─────────────────────── */
  var _BACK = {
    seller:     'seller.html',
    admin:      'admin-os.html',
    superAdmin: 'super-admin.html',
    driver:     'driver.html',
    rider:      'driver.html',
    provider:   'seller.html',
    buyer:      'index.html'
  };

  var _LABEL = {
    buyer:      '🛍️ Buyer',
    seller:     '🏪 Seller Hub',
    admin:      '⚙️ Admin',
    superAdmin: '👑 Super Admin',
    driver:     '🚗 Driver',
    rider:      '🛵 Rider',
    provider:   '🛠️ Provider'
  };

  var _ROLE_META = {
    buyer:      { i:'🛍️', l:'Buyer',       h:'index.html' },
    seller:     { i:'🏪',  l:'Seller',      h:'seller.html' },
    driver:     { i:'🚗',  l:'Driver',      h:'driver.html' },
    rider:      { i:'🛵',  l:'Rider',       h:'driver.html' },
    provider:   { i:'🛠️', l:'Provider',    h:'seller.html' },
    admin:      { i:'⚙️', l:'Admin',       h:'admin-os.html' },
    superAdmin: { i:'👑',  l:'Super Admin', h:'super-admin.html' }
  };

  /* ── Navigation history (sessionStorage) ────────────────── */
  function _pushHistory() {
    try {
      var hist = JSON.parse(sessionStorage.getItem('sk_nav_hist') || '[]');
      if (hist.length && hist[hist.length - 1].page === _page) return;
      hist.push({ page: _page, ws: _workspace() });
      if (hist.length > 12) hist = hist.slice(-12);
      sessionStorage.setItem('sk_nav_hist', JSON.stringify(hist));
    } catch (_) {}
  }

  function _popHistory() {
    try {
      var hist = JSON.parse(sessionStorage.getItem('sk_nav_hist') || '[]');
      if (hist.length && hist[hist.length - 1].page === _page) hist.pop();
      var prev = hist.length ? hist[hist.length - 1] : null;
      sessionStorage.setItem('sk_nav_hist', JSON.stringify(hist));
      return prev ? prev.page : null;
    } catch (_) { return null; }
  }

  /* ── Active tab detection ────────────────────────────────── */
  /* Normalise both sides: strip .html so Firebase cleanUrls (/page vs page.html)
     doesn't prevent active-state matching in production. */
  /* The homepage has THREE spellings in the wild: "/", "index.html" and "index".
     _page resolves "/" to "index" (see the fallback at the top of this file), so an
     href of "/" would compare "/" against "index" and never match — the Home tab
     would silently stop highlighting. Normalise every spelling to one token so the
     canonical "/" and any legacy "index.html" link are treated as the same page. */
  function _home(s) {
    return (s === '/' || s === '' || s === 'index') ? 'index' : s;
  }
  function _isActive(href) {
    if (!href || href === '#') return false;
    var a = _home(href.split('#')[0].split('?')[0].toLowerCase().replace(/\.html$/, ''));
    var b = _home(_page.replace(/\.html$/, ''));
    return a === b;
  }

  /* ═══════════════════════════════════════════════════════════
     BOTTOM NAV
  ═══════════════════════════════════════════════════════════ */
  function _buildBottomNav(ws) {
    if (_KEEP_OWN_BOTTOM.indexOf(_page) > -1) return;

    var nav = document.querySelector('.bottom-nav');
    if (!nav) {
      nav = document.createElement('nav');
      nav.className = 'bottom-nav sk-nav-injected';
      nav.setAttribute('role', 'navigation');
      document.body.appendChild(nav);
    }

    var items = _TABS[ws] || _TABS.buyer;
    var html  = '';
    items.forEach(function (t) {
      var active = _isActive(t.h) ? ' active-bnav' : '';
      var action = t.a ? ' data-action="' + t.a + '"' : '';
      html +=
        '<a href="' + (t.a ? '#' : t.h) + '" class="bnav-item' + active + '"' + action + ' role="link">' +
          '<span class="bnav-emoji" aria-hidden="true">' + t.i + '</span>' +
          '<span>' + t.l + '</span>' +
        '</a>';
    });
    nav.innerHTML = html;
    nav.setAttribute('data-workspace', ws);
    nav.setAttribute('aria-label', (_LABEL[ws] || ws) + ' navigation');

    var more = nav.querySelector('[data-action="sk-seller-more"]');
    if (more) {
      more.addEventListener('click', function (e) {
        e.preventDefault();
        _openMoreDrawer();
      });
    }
  }

  /* ═══════════════════════════════════════════════════════════
     SELLER SUB-NAV (persistent horizontal scroll strip)
  ═══════════════════════════════════════════════════════════ */
  function _buildSellerSubnav() {
    if (document.getElementById('sk-seller-subnav')) { _setSnavTop(); return; }

    var el = document.createElement('nav');
    el.id  = 'sk-seller-subnav';
    el.setAttribute('aria-label', 'Seller workspace navigation');

    var html = '';
    _SUBNAV.forEach(function (t) {
      var active = _isActive(t.h) ? ' active' : '';
      html +=
        '<a href="' + t.h + '" class="sk-snav-item' + active + '">' +
          '<span class="sk-snav-icon" aria-hidden="true">' + t.i + '</span>' +
          '<span class="sk-snav-label">' + t.l + '</span>' +
        '</a>';
    });
    el.innerHTML = html;
    document.body.insertBefore(el, document.body.firstChild);

    requestAnimationFrame(function () {
      var active = el.querySelector('.active');
      if (active) active.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
    });

    _setSnavTop();
    window.addEventListener('resize', _setSnavTop, { passive: true });
  }

  function _setSnavTop() {
    var topNav = document.getElementById('sk-top-nav') ||
                 document.querySelector('.seller-navbar, .pos-navbar, [class*="navbar"]');
    var h = topNav ? topNav.getBoundingClientRect().height : 64;
    document.documentElement.style.setProperty('--sk-snav-top', Math.ceil(h) + 'px');
  }

  /* ═══════════════════════════════════════════════════════════
     SMART BACK + WORKSPACE CHIP + DASHBOARD SHORTCUT
  ═══════════════════════════════════════════════════════════ */
  function _buildBackBtn(ws) {
    var topNav = document.getElementById('sk-top-nav');
    if (!topNav) return;

    if (!document.getElementById('sk-nav-back-btn')) {
      var btn  = document.createElement('button');
      btn.type = 'button';
      btn.id   = 'sk-nav-back-btn';
      btn.setAttribute('aria-label', 'Go back');
      btn.innerHTML = '&#8592;';
      btn.addEventListener('click', function () {
        var prev = _popHistory();
        if (prev && prev !== _page) {
          location.href = prev;
        } else if (history.length > 1) {
          history.back();
        } else {
          location.href = _BACK[ws] || 'index.html';
        }
      });
      topNav.insertBefore(btn, topNav.firstChild);
    }

    if (!document.getElementById('sk-nav-role-chip')) {
      var chip         = document.createElement('span');
      chip.id          = 'sk-nav-role-chip';
      chip.textContent = (_LABEL[ws] || ws).replace(/^[^\s]+\s/, '');
      chip.setAttribute('aria-label', 'Current workspace: ' + ws);
      topNav.insertBefore(chip, document.getElementById('sk-nav-back-btn').nextSibling);
    }

    /* "🏪 Hub" shortcut — seller non-dashboard pages only */
    if (ws === 'seller' && _page !== 'seller.html' && !document.getElementById('sk-nav-dash-btn')) {
      var dash    = document.createElement('a');
      dash.id     = 'sk-nav-dash-btn';
      dash.href   = 'seller.html';
      dash.setAttribute('aria-label', 'Seller Dashboard');
      dash.innerHTML = '<span aria-hidden="true">🏪</span> Hub';
      var chipEl  = document.getElementById('sk-nav-role-chip');
      topNav.insertBefore(dash, chipEl ? chipEl.nextSibling : null);
    }
  }

  /* ═══════════════════════════════════════════════════════════
     ROLE BADGE in hamburger overlay
  ═══════════════════════════════════════════════════════════ */
  function _buildMenuBadge(ws) {
    /* The menu drawer (#sk-menu-drawer) is built lazily on first hamburger click.
       Defer injection until that first click so the element actually exists. */
    var btn = document.getElementById('sk-menu-btn');
    if (!btn) return;
    var _done = false;
    btn.addEventListener('click', function () {
      if (_done) return;
      _done = true;
      /* Give the drawer 150 ms to render before we inject the badge */
      setTimeout(function () {
        var drawer = document.getElementById('sk-menu-drawer');
        if (!drawer || document.getElementById('sk-menu-role-badge')) return;
        var badge = document.createElement('div');
        badge.id  = 'sk-menu-role-badge';
        badge.setAttribute('aria-label', 'Workspace: ' + ws);
        badge.textContent = _LABEL[ws] || ws;
        drawer.insertBefore(badge, drawer.firstChild);
      }, 150);
    });
  }

  /* ═══════════════════════════════════════════════════════════
     "MORE" DRAWER — store identity + categorised tool grid + role switcher
  ═══════════════════════════════════════════════════════════ */
  function _buildMoreDrawer() {
    if (document.getElementById('sk-seller-more-drawer')) return;

    var drawer = document.createElement('div');
    drawer.id        = 'sk-seller-more-drawer';
    drawer.className = 'sk-drawer';
    drawer.setAttribute('role',        'dialog');
    drawer.setAttribute('aria-modal',  'true');
    drawer.setAttribute('aria-label',  'Seller navigation');
    drawer.setAttribute('aria-hidden', 'true');

    var header =
      '<div class="sk-drawer-header">' +
        '<button class="sk-drawer-back" aria-label="Back" ' +
          'onclick="if(window.SokoniDrawer)SokoniDrawer.close(\'sk-seller-more-drawer\')">&#8592;</button>' +
        '<span class="sk-drawer-title">Seller Hub</span>' +
        '<button class="sk-drawer-close" aria-label="Close" ' +
          'onclick="if(window.SokoniDrawer)SokoniDrawer.close(\'sk-seller-more-drawer\')">&#10005;</button>' +
      '</div>';

    /* Store identity card (reads from localStorage) */
    var storeCard = '';
    try {
      var u = JSON.parse(localStorage.getItem('sokoniUser') || 'null');
      if (u) {
        var initial   = (u.storeName || u.name || 'S').charAt(0).toUpperCase();
        var storeName = u.storeName || u.businessName || 'My Store';
        var sellerName = u.name || '';
        storeCard =
          '<div class="sk-more-store-card">' +
            '<div class="sk-more-store-avatar" aria-hidden="true">' + initial + '</div>' +
            '<div class="sk-more-store-info">' +
              '<div class="sk-more-store-name">' + _esc(storeName) + '</div>' +
              (sellerName ? '<div class="sk-more-store-sub">' + _esc(sellerName) + ' · Seller</div>' : '<div class="sk-more-store-sub">SOKONI Seller</div>') +
            '</div>' +
            '<a href="seller.html" class="sk-more-dash-link" aria-label="Open dashboard">Dashboard &#8594;</a>' +
          '</div>';
      }
    } catch (_) {}

    /* Group items by category */
    var grouped = {};
    _SUBNAV.forEach(function (t) {
      var c = t.cat || 'tools';
      if (!grouped[c]) grouped[c] = [];
      grouped[c].push(t);
    });

    var body = '';
    _SUBNAV_CATS.forEach(function (cat) {
      var catItems = grouped[cat.key] || [];
      if (!catItems.length) return;
      body += '<div class="sk-more-cat">' +
        '<h3 class="sk-more-cat-label"><span aria-hidden="true">' + cat.i + '</span> ' + cat.l + '</h3>' +
        '<div class="sk-more-cat-grid">';
      catItems.forEach(function (t) {
        var active = _isActive(t.h) ? ' sk-more-item--active' : '';
        body +=
          '<a href="' + t.h + '" class="sk-more-item' + active + '">' +
            '<span class="sk-more-icon" aria-hidden="true">' + t.i + '</span>' +
            '<span>' + t.l + '</span>' +
          '</a>';
      });
      body += '</div></div>';
    });

    /* Role switcher — only for multi-role users */
    var roleSwitcher = '';
    var roles = _allRoles();
    if (roles.length > 1) {
      var ws = _workspace();
      roleSwitcher = '<div class="sk-role-switcher"><p class="sk-role-switcher-label">Switch Workspace</p><div class="sk-role-pills">';
      roles.forEach(function (r) {
        var meta    = _ROLE_META[r] || { i:'👤', l:r, h:'index.html' };
        var current = (r === ws) ? ' sk-role-pill--active' : '';
        roleSwitcher +=
          '<a href="' + meta.h + '" class="sk-role-pill' + current + '">' +
            '<span aria-hidden="true">' + meta.i + '</span> ' + meta.l +
          '</a>';
      });
      roleSwitcher += '</div></div>';
    }

    drawer.innerHTML = header + storeCard + '<div class="sk-drawer-body">' + body + '</div>' + roleSwitcher;
    document.body.appendChild(drawer);
  }

  /* Simple HTML escaper used in store card */
  function _esc(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  /* ═══════════════════════════════════════════════════════════
     DESKTOP SIDEBAR — seller / admin / superAdmin workspaces
     Fixed 220px panel replacing horizontal sub-nav on ≥1024px,
     collapsed to 56px icon-rail on 769px–1023px.
  ═══════════════════════════════════════════════════════════ */
  function _buildDesktopSidebar(ws) {
    var cfg = _SIDEBAR_CONFIGS[ws];
    if (!cfg) return;                                    /* buyer/driver/rider have no sidebar */
    if (window.innerWidth < 769) return;                 /* mobile: use bottom nav instead */
    if (_KEEP_OWN_BOTTOM.indexOf(_page) > -1) return;   /* seller.html/pos.html own their layout */
    if (document.getElementById('sk-ws-sidebar')) return;

    var sidebar = document.createElement('aside');
    sidebar.id        = 'sk-ws-sidebar';
    sidebar.className = 'sk-ws-sidebar sk-ws-sidebar--' + ws;
    sidebar.setAttribute('aria-label', cfg.label + ' navigation');

    /* Workspace label from localStorage */
    var wsName = cfg.label;
    try {
      var u = JSON.parse(localStorage.getItem('sokoniUser') || 'null');
      if (u) {
        if (ws === 'seller')     wsName = u.storeName || u.businessName || cfg.label;
        else                     wsName = u.name || cfg.label;
      }
    } catch (_) {}

    var header =
      '<div class="sk-sidebar-header">' +
        '<div class="sk-sidebar-ws">' +
          '<span class="sk-sidebar-ws-icon" aria-hidden="true">' + cfg.icon + '</span>' +
          '<div class="sk-sidebar-ws-info">' +
            '<div class="sk-sidebar-ws-name">' + _esc(wsName) + '</div>' +
            '<div class="sk-sidebar-ws-role">' + cfg.label + '</div>' +
          '</div>' +
        '</div>' +
      '</div>';

    /* Group items by category */
    var grouped = {};
    cfg.items.forEach(function (t) {
      var c = t.cat || 'core';
      if (!grouped[c]) grouped[c] = [];
      grouped[c].push(t);
    });

    var navHtml = '<nav class="sk-sidebar-nav" aria-label="' + cfg.label + '">';
    cfg.cats.forEach(function (cat) {
      var catItems = grouped[cat.key] || [];
      if (!catItems.length) return;
      navHtml += '<div class="sk-sidebar-group"><span class="sk-sidebar-group-label">' + cat.l + '</span>';
      catItems.forEach(function (t) {
        var active = _isActive(t.h) ? ' sk-sidebar-item--active' : '';
        navHtml +=
          '<a href="' + t.h + '" class="sk-sidebar-item' + active + '">' +
            '<span class="sk-sidebar-item-icon" aria-hidden="true">' + t.i + '</span>' +
            '<span class="sk-sidebar-item-label">' + t.l + '</span>' +
          '</a>';
      });
      navHtml += '</div>';
    });
    navHtml += '</nav>';

    /* Footer: user avatar + name + role + profile link + role switcher */
    var footer = '';
    try {
      var u2 = JSON.parse(localStorage.getItem('sokoniUser') || 'null');
      if (u2) {
        var initial  = (u2.name || 'U').charAt(0).toUpperCase();
        var userName = _esc(u2.name || 'User');
        footer = '<div class="sk-sidebar-footer">' +
          '<div class="sk-sidebar-user">' +
            '<div class="sk-sidebar-user-av">' + initial + '</div>' +
            '<div class="sk-sidebar-user-info">' +
              '<span class="sk-sidebar-user-name">' + userName + '</span>' +
              '<span class="sk-sidebar-user-role">' + cfg.label + '</span>' +
            '</div>' +
            '<a href="profile.html" class="sk-sidebar-profile-link" title="Edit profile" aria-label="Edit profile">&#8594;</a>' +
          '</div>';
        var roles = _allRoles();
        if (roles.length > 1) {
          footer += '<div class="sk-sidebar-role-pills">';
          roles.forEach(function (r) {
            var meta    = _ROLE_META[r] || { i:'👤', l:r, h:'index.html' };
            var current = (r === ws) ? ' sk-sidebar-role-pill--active' : '';
            footer +=
              '<a href="' + meta.h + '" class="sk-sidebar-role-pill' + current + '">' +
                '<span aria-hidden="true">' + meta.i + '</span> ' + meta.l +
              '</a>';
          });
          footer += '</div>';
        }
        footer += '</div>';
      }
    } catch (_) {}

    sidebar.innerHTML = header + navHtml + footer;
    document.body.appendChild(sidebar);
    document.body.classList.add('sk-has-sidebar');
  }

  function _destroySidebar() {
    var s = document.getElementById('sk-ws-sidebar');
    if (s) s.remove();
    document.body.classList.remove('sk-has-sidebar');
  }

  function _openMoreDrawer() {
    _buildMoreDrawer();
    if (window.SokoniDrawer) {
      SokoniDrawer.open('sk-seller-more-drawer', 'Seller Hub');
    } else {
      var tries = 0;
      var t = setInterval(function () {
        if (window.SokoniDrawer) { clearInterval(t); SokoniDrawer.open('sk-seller-more-drawer', 'Seller Hub'); }
        if (++tries > 20) clearInterval(t);
      }, 100);
    }
  }

  /* ═══════════════════════════════════════════════════════════
     MAIN INIT
  ═══════════════════════════════════════════════════════════ */
  function _init() {
    var ws = _workspace();

    _pushHistory();

    ['buyer','seller','admin','superAdmin','driver','rider','provider'].forEach(function (c) {
      document.body.classList.remove('sk-workspace-' + c);
    });
    document.body.classList.add('sk-workspace-' + ws);

    _buildBottomNav(ws);

    if (ws === 'seller') _buildSellerSubnav();

    if (ws !== 'buyer') _buildBackBtn(ws);

    _buildMenuBadge(ws);

    _buildDesktopSidebar(ws);
  }

  /* Rebuild sidebar when viewport crosses the 769px breakpoint */
  var _sidebarPrevWide = window.innerWidth >= 769;
  window.addEventListener('resize', function () {
    var nowWide = window.innerWidth >= 769;
    if (nowWide === _sidebarPrevWide) return;
    _sidebarPrevWide = nowWide;
    if (nowWide) {
      _buildDesktopSidebar(_workspace());
    } else {
      _destroySidebar();
    }
  }, { passive: true });

  /* ── Re-run on login / logout ───────────────────────────── */
  window.addEventListener('storage', function (e) {
    if (e.key !== 'sokoniUser') return;
    _destroySidebar();
    ['sk-seller-subnav','sk-nav-back-btn','sk-nav-role-chip',
     'sk-menu-role-badge','sk-nav-dash-btn','sk-seller-more-drawer'].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.remove();
    });
    _init();
  });

  /* ── Boot ───────────────────────────────────────────────── */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _init);
  } else {
    _init();
  }

  window.SokoniNavEngine = { refresh: _init, workspace: _workspace, role: _role };
}());
