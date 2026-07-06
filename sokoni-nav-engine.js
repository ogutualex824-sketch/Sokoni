/* ================================================================
   SOKONI Navigation Engine v1.1
   Context-aware role-based navigation for every page.

   New in v1.1:
   • seller.html + pos.html removed from full-skip — sub-nav + back
     button injected without overriding their own bottom nav
   • _WS_MAP expanded: all POS pages, specialty seller pages (~60 entries)
   • Seller bottom nav: Dashboard | Products | Orders | Analytics | More
   • Seller sub-nav (20 items) shown on ALL seller workspace pages
   • Navigation history in sessionStorage for smart back button
   • "Hub" shortcut chip in top nav on non-root seller pages
   • Multi-role switcher section inside the More drawer
================================================================ */
(function () {
  'use strict';

  var _page = (location.pathname.split('/').pop().split('?')[0] || 'index.html').toLowerCase();

  /* Pages that are fully self-managed — zero injection */
  var _SKIP = [
    'index.html',
    'education.html',
    'jobs.html',
    'login.html', 'signup.html',
    'register.html', 'success.html', 'offline.html', 'admin.html',
    'profile.html', 'ecc.html', 'wap.html', 'gip.html', 'platform.html',
    'sasos-admin.html', 'pos-kiosk.html', 'pos-display.html', 'superadmin.html',
    'monitor.html', 'moderation.html', 'verification-admin.html'
  ];

  /* Pages that manage their own bottom nav — get sub-nav + back btn only */
  var _KEEP_OWN_BOTTOM = ['seller.html', 'pos.html'];

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
      if (r.indexOf('provider')   > -1)                                         out.push('provider');
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
  var _TABS = {
    buyer: [
      { i:'🏠',  l:'Home',       h:'index.html' },
      { i:'🛍️', l:'Categories', h:'category.html?cat=all' },
      { i:'🛠️', l:'Services',   h:'services.html' },
      { i:'📦',  l:'Orders',     h:'profile.html#orders' },
      { i:'👤',  l:'Profile',    h:'profile.html' }
    ],
    seller: [
      { i:'📊',  l:'Dashboard',  h:'seller.html' },
      { i:'📦',  l:'Products',   h:'seller.html#products' },
      { i:'🛒',  l:'Orders',     h:'seller.html#orders' },
      { i:'📈',  l:'Analytics',  h:'seller-analytics.html' },
      { i:'⋯',   l:'More',       h:'#', a:'sk-seller-more' }
    ],
    rider: [
      { i:'📊',  l:'Dashboard',  h:'driver.html' },
      { i:'🗺️', l:'Jobs',       h:'jobs.html' },
      { i:'🚚',  l:'Deliveries', h:'track.html' },
      { i:'💰',  l:'Earnings',   h:'profile.html#earnings' },
      { i:'👤',  l:'Account',    h:'profile.html' }
    ],
    driver: [
      { i:'📊',  l:'Dashboard',  h:'driver.html' },
      { i:'🚗',  l:'Trips',      h:'driver.html#trips' },
      { i:'🗺️', l:'Navigation', h:'rider-nav.html' },
      { i:'💰',  l:'Earnings',   h:'driver.html#earnings' },
      { i:'👤',  l:'Account',    h:'profile.html' }
    ],
    provider: [
      { i:'📊',  l:'Dashboard',  h:'seller.html' },
      { i:'📅',  l:'Bookings',   h:'venue-booking.html' },
      { i:'👥',  l:'Customers',  h:'seller.html#customers' },
      { i:'💰',  l:'Earnings',   h:'seller.html#earnings' },
      { i:'👤',  l:'Profile',    h:'profile.html' }
    ],
    admin: [
      { i:'📊',  l:'Dashboard',  h:'admin-os.html' },
      { i:'🏪',  l:'Marketplace',h:'admin-os.html#marketplace' },
      { i:'👥',  l:'Users',      h:'admin-os.html#users' },
      { i:'📈',  l:'Reports',    h:'reliability-center.html' },
      { i:'⚙️', l:'Settings',   h:'admin-os.html#settings' }
    ],
    superAdmin: [
      { i:'📊',  l:'Dashboard',  h:'super-admin.html' },
      { i:'🏗️', l:'Platform',   h:'platform.html' },
      { i:'💵',  l:'Finance',    h:'finos.html' },
      { i:'🔒',  l:'Security',   h:'trust-safety.html' },
      { i:'🤖',  l:'AI',         h:'ai-subscriptions.html' },
      { i:'⚙️', l:'Settings',   h:'super-admin.html#settings' }
    ]
  };

  /* ── Seller sub-nav (20 items) ───────────────────────────── */
  var _SUBNAV = [
    { i:'📊',  l:'Dashboard',    h:'seller.html' },
    { i:'📦',  l:'Products',     h:'seller.html#products' },
    { i:'🏪',  l:'MiniShop',     h:'minishop-admin.html' },
    { i:'📋',  l:'Inventory',    h:'inventory.html' },
    { i:'🛒',  l:'Orders',       h:'seller.html#orders' },
    { i:'📈',  l:'Analytics',    h:'seller-analytics.html' },
    { i:'📣',  l:'Marketing',    h:'seller.html#marketing' },
    { i:'⚡',  l:'Flash Sales',  h:'flash-sales.html' },
    { i:'🖥️', l:'POS',          h:'pos.html' },
    { i:'💳',  l:'Payments',     h:'seller.html#payments' },
    { i:'💰',  l:'Revenue',      h:'seller-revenue.html' },
    { i:'👥',  l:'Customers',    h:'seller.html#customers' },
    { i:'💬',  l:'Messages',     h:'messages.html' },
    { i:'⚖️', l:'Disputes',     h:'seller.html#disputes' },
    { i:'⬛',  l:'QR',           h:'qr-center.html' },
    { i:'🧾',  l:'eTIMS',        h:'etims-seller.html' },
    { i:'🎁',  l:'Loyalty',      h:'loyalty-merchant.html' },
    { i:'🗓️', l:'Availability', h:'availability-manager.html' },
    { i:'🔴',  l:'Live',         h:'seller.html#live' },
    { i:'⚙️', l:'Settings',     h:'seller.html#settings' }
  ];

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
  function _isActive(href) {
    if (!href || href === '#') return false;
    return href.split('#')[0].split('?')[0].toLowerCase() === _page;
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
    var topNav = document.getElementById('sk-top-nav');
    var h      = topNav ? topNav.getBoundingClientRect().height : 64;
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
    var overlay = document.getElementById('sk-menu-overlay');
    if (!overlay || document.getElementById('sk-menu-role-badge')) return;
    var badge = document.createElement('div');
    badge.id  = 'sk-menu-role-badge';
    badge.setAttribute('aria-label', 'Workspace: ' + ws);
    badge.style.cssText =
      'display:inline-flex;align-items:center;gap:6px;padding:5px 14px;margin:16px 0 4px 16px;' +
      'border-radius:999px;font-size:11px;font-weight:800;letter-spacing:0.5px;' +
      'background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);' +
      'color:rgba(255,255,255,0.6);';
    badge.textContent = _LABEL[ws] || ws;
    overlay.insertBefore(badge, overlay.firstChild);
  }

  /* ═══════════════════════════════════════════════════════════
     "MORE" DRAWER — full tool grid + role switcher
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

    var items = '';
    _SUBNAV.forEach(function (t) {
      var active = _isActive(t.h) ? ' sk-more-item--active' : '';
      items +=
        '<a href="' + t.h + '" class="sk-more-item' + active + '">' +
          '<span class="sk-more-icon" aria-hidden="true">' + t.i + '</span>' +
          '<span>' + t.l + '</span>' +
        '</a>';
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

    drawer.innerHTML = header + '<div class="sk-drawer-body">' + items + '</div>' + roleSwitcher;
    document.body.appendChild(drawer);
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
  }

  /* ── Re-run on login / logout ───────────────────────────── */
  window.addEventListener('storage', function (e) {
    if (e.key !== 'sokoniUser') return;
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
