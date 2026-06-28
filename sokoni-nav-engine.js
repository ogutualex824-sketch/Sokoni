/* ================================================================
   SOKONI Navigation Engine v1.0
   Role-based dynamic navigation — auto-wires to every page via
   shared-header.js Phase 1 injection.

   Features:
   • Role detection from localStorage.sokoniUser.roles
   • Page → workspace mapping (buyer/seller/admin/superAdmin/driver/rider/provider)
   • Dynamic .bottom-nav replacement with role-appropriate tabs
   • Seller persistent sub-nav (17 items, horizontal scroll)
   • Smart back button + workspace chip in top nav
   • "Seller More" full-screen drawer for extended items
   • Role badge in hamburger menu overlay
   • Reacts to login/logout via storage events
================================================================ */
(function () {
  'use strict';

  /* ── Current page ─────────────────────────────────────────── */
  var _page = (location.pathname.split('/').pop().split('?')[0] || 'index.html').toLowerCase();

  /* ── Pages that manage their own nav entirely — skip all injection ── */
  var _SKIP = [
    'pos.html', 'seller.html', 'login.html', 'signup.html',
    'register.html', 'success.html', 'offline.html', 'admin.html',
    'profile.html', 'ecc.html', 'wap.html', 'gip.html', 'platform.html',
    'sasos-admin.html', 'pos-kiosk.html', 'superadmin.html',
    'monitor.html', 'moderation.html', 'verification-admin.html'
  ];
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

  /* ── Page → workspace mapping ────────────────────────────── */
  var _WS_MAP = {
    /* Seller workspace pages */
    'minishop.html':            'seller',
    'minishop-admin.html':      'seller',
    'minishop-status.html':     'seller',
    'qr-center.html':           'seller',
    'creative-studio.html':     'seller',
    'seller-analytics.html':    'seller',
    'seller-revenue.html':      'seller',
    'seller-delivery.html':     'seller',
    'seller-success.html':      'seller',
    'seller-terms.html':        'seller',
    'merchant-success.html':    'seller',
    'merchant-pipeline.html':   'seller',
    'inventory.html':           'seller',
    'revenue.html':             'seller',
    'subscription-billing.html':'seller',
    'commission-engine.html':   'seller',
    'pos-printer-setup.html':   'seller',
    'pos-inventory.html':       'seller',
    'pos-customers.html':       'seller',
    'pos-suppliers.html':       'seller',
    'pos-reports.html':         'seller',
    'flash-sales.html':         'seller',
    /* Admin workspace pages */
    'admin-os.html':            'admin',
    'admin-messages.html':      'admin',
    'trust-safety.html':        'admin',
    'reliability-center.html':  'admin',
    'platform-health.html':     'admin',
    'launch-readiness.html':    'admin',
    'moderation.html':          'admin',
    'business-kpi.html':        'admin',
    'ops-dashboard.html':       'admin',
    /* Super Admin workspace pages */
    'super-admin.html':         'superAdmin',
    'finos.html':               'superAdmin',
    'financial-os.html':        'superAdmin',
    'subscription-os.html':     'superAdmin',
    'enterprise-search.html':   'superAdmin',
    'ai-subscriptions.html':    'superAdmin',
    'admin-subscriptions.html': 'superAdmin',
    'education.html':           'superAdmin',
    /* Rider workspace */
    'rider-nav.html':           'rider',
    /* Driver workspace */
    'driver.html':              'driver',
    'fleet-monitor.html':       'driver',
    /* Provider workspace */
    'venue-booking.html':       'provider',
    'venue-manager.html':       'provider'
  };

  function _workspace() {
    var r = _role();
    var mapped = _WS_MAP[_page];
    if (!mapped) return r;                       /* default: match role */
    /* Guard: only elevate if user actually has that role */
    if (mapped === 'superAdmin') return (r === 'superAdmin') ? 'superAdmin' : (r === 'admin' ? 'admin' : 'buyer');
    if (mapped === 'admin')      return (r === 'admin' || r === 'superAdmin') ? 'admin' : 'buyer';
    if (mapped === 'seller')     return (r === 'seller' || r === 'admin' || r === 'superAdmin') ? 'seller' : 'buyer';
    return mapped;
  }

  /* ── Nav tab configs ─────────────────────────────────────── */
  var _TABS = {
    buyer: [
      { i:'🏠',  l:'Home',        h:'index.html' },
      { i:'🛍️', l:'Categories',  h:'category.html?cat=all' },
      { i:'🛒',  l:'Cart',        h:'cart.html' },
      { i:'📦',  l:'Orders',      h:'orders.html' },
      { i:'👤',  l:'Profile',     h:'profile.html' }
    ],
    seller: [
      { i:'📊',  l:'Dashboard',   h:'seller.html' },
      { i:'📦',  l:'Products',    h:'seller.html#products' },
      { i:'🛒',  l:'Orders',      h:'seller.html#orders' },
      { i:'💰',  l:'Revenue',     h:'seller-revenue.html' },
      { i:'⋯',   l:'More',        h:'#', a:'sk-seller-more' }
    ],
    rider: [
      { i:'📊',  l:'Dashboard',   h:'driver.html' },
      { i:'🗺️', l:'Jobs',        h:'jobs.html' },
      { i:'🚚',  l:'Deliveries',  h:'track.html' },
      { i:'💰',  l:'Earnings',    h:'profile.html#earnings' },
      { i:'👤',  l:'Account',     h:'profile.html' }
    ],
    driver: [
      { i:'📊',  l:'Dashboard',   h:'driver.html' },
      { i:'🚗',  l:'Trips',       h:'driver.html#trips' },
      { i:'🗺️', l:'Navigation',  h:'rider-nav.html' },
      { i:'💰',  l:'Earnings',    h:'driver.html#earnings' },
      { i:'👤',  l:'Account',     h:'profile.html' }
    ],
    provider: [
      { i:'📊',  l:'Dashboard',   h:'seller.html' },
      { i:'📅',  l:'Bookings',    h:'venue-booking.html' },
      { i:'👥',  l:'Customers',   h:'seller.html#customers' },
      { i:'💰',  l:'Earnings',    h:'seller.html#earnings' },
      { i:'👤',  l:'Profile',     h:'profile.html' }
    ],
    admin: [
      { i:'📊',  l:'Dashboard',   h:'admin-os.html' },
      { i:'🏪',  l:'Marketplace', h:'admin-os.html#marketplace' },
      { i:'👥',  l:'Users',       h:'admin-os.html#users' },
      { i:'📈',  l:'Reports',     h:'reliability-center.html' },
      { i:'⚙️', l:'Settings',    h:'admin-os.html#settings' }
    ],
    superAdmin: [
      { i:'📊',  l:'Dashboard',   h:'super-admin.html' },
      { i:'🏗️', l:'Platform',    h:'platform.html' },
      { i:'💵',  l:'Finance',     h:'finos.html' },
      { i:'🔒',  l:'Security',    h:'trust-safety.html' },
      { i:'🤖',  l:'AI',          h:'ai-subscriptions.html' },
      { i:'⚙️', l:'Settings',    h:'super-admin.html#settings' }
    ]
  };

  /* ── Seller sub-nav items (17) ──────────────────────────── */
  var _SUBNAV = [
    { i:'📊',  l:'Dashboard',    h:'seller.html' },
    { i:'🏪',  l:'MiniShop',     h:'minishop-admin.html' },
    { i:'📦',  l:'Products',     h:'seller.html#products' },
    { i:'🛒',  l:'Orders',       h:'seller.html#orders' },
    { i:'📈',  l:'Analytics',    h:'seller-analytics.html' },
    { i:'💰',  l:'Revenue',      h:'seller-revenue.html' },
    { i:'📣',  l:'Marketing',    h:'seller.html#marketing' },
    { i:'⚡',  l:'Flash Sales',  h:'flash-sales.html' },
    { i:'💳',  l:'Payments',     h:'seller.html#payments' },
    { i:'🖥️', l:'POS',          h:'pos.html' },
    { i:'⬛',  l:'QR',           h:'qr-center.html' },
    { i:'💬',  l:'Messages',     h:'messages.html' },
    { i:'⚖️', l:'Disputes',     h:'seller.html#disputes' },
    { i:'🗓️', l:'Availability', h:'seller.html#availability' },
    { i:'🔴',  l:'Live',         h:'seller.html#live' },
    { i:'📊',  l:'Insights',     h:'merchant-success.html' },
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

  /* ── Workspace label + colour ────────────────────────────── */
  var _LABEL = {
    buyer: '🛍️ Buyer', seller: '🏪 Seller Hub', admin: '⚙️ Admin',
    superAdmin: '👑 Super Admin', driver: '🚗 Driver',
    rider: '🛵 Rider',  provider: '🛠️ Provider'
  };

  /* ── Active detection ───────────────────────────────────── */
  function _isActive(href) {
    if (!href || href === '#') return false;
    return href.split('#')[0].split('?')[0].toLowerCase() === _page;
  }

  /* ═══════════════════════════════════════════════════════════
     BOTTOM NAV REPLACEMENT
  ═══════════════════════════════════════════════════════════ */
  function _buildBottomNav(ws) {
    var nav = document.querySelector('.bottom-nav');
    if (!nav) {
      /* Pages like minishop-admin, qr-center have no bottom-nav — inject one */
      nav = document.createElement('nav');
      nav.className = 'bottom-nav sk-nav-injected';
      nav.setAttribute('role', 'navigation');
      document.body.appendChild(nav);
    }

    var items = _TABS[ws] || _TABS.buyer;
    var html = '';
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
    nav.setAttribute('aria-label', _LABEL[ws] + ' navigation');

    /* Wire "More" button for seller */
    var more = nav.querySelector('[data-action="sk-seller-more"]');
    if (more) {
      more.addEventListener('click', function (e) {
        e.preventDefault();
        _openMoreDrawer();
      });
    }
  }

  /* ═══════════════════════════════════════════════════════════
     SELLER SUB-NAV (horizontal scroll, below top nav)
  ═══════════════════════════════════════════════════════════ */
  function _buildSellerSubnav() {
    if (document.getElementById('sk-seller-subnav')) {
      _setSnavTop(); return;
    }
    var el = document.createElement('nav');
    el.id = 'sk-seller-subnav';
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

    /* Scroll active item into center */
    requestAnimationFrame(function () {
      var active = el.querySelector('.active');
      if (active) active.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
    });

    _setSnavTop();
    window.addEventListener('resize', _setSnavTop, { passive: true });
  }

  /* Measure actual top nav height and write to CSS var */
  function _setSnavTop() {
    var topNav = document.getElementById('sk-top-nav');
    var h = topNav ? topNav.getBoundingClientRect().height : 64;
    document.documentElement.style.setProperty('--sk-snav-top', Math.ceil(h) + 'px');
  }

  /* ═══════════════════════════════════════════════════════════
     SMART BACK BUTTON + WORKSPACE CHIP (top nav)
  ═══════════════════════════════════════════════════════════ */
  function _buildBackBtn(ws) {
    var topNav = document.getElementById('sk-top-nav');
    if (!topNav) return;

    /* Back button */
    if (!document.getElementById('sk-nav-back-btn')) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.id = 'sk-nav-back-btn';
      btn.setAttribute('aria-label', 'Go back');
      btn.innerHTML = '&#8592;';
      btn.addEventListener('click', function () {
        /* Prefer browser history; fall back to workspace root */
        if (history.length > 1) {
          history.back();
        } else {
          location.href = _BACK[ws] || 'index.html';
        }
      });
      topNav.insertBefore(btn, topNav.firstChild);
    }

    /* Workspace chip (label after back button) */
    if (!document.getElementById('sk-nav-role-chip')) {
      var chip = document.createElement('span');
      chip.id = 'sk-nav-role-chip';
      chip.textContent = (_LABEL[ws] || ws).replace(/^[^\s]+\s/, ''); /* strip emoji */
      chip.setAttribute('aria-label', 'Current workspace: ' + ws);
      topNav.insertBefore(chip, document.getElementById('sk-nav-back-btn').nextSibling);
    }
  }

  /* ═══════════════════════════════════════════════════════════
     ROLE BADGE in hamburger menu overlay
  ═══════════════════════════════════════════════════════════ */
  function _buildMenuBadge(ws) {
    var overlay = document.getElementById('sk-menu-overlay');
    if (!overlay || document.getElementById('sk-menu-role-badge')) return;
    var badge = document.createElement('div');
    badge.id = 'sk-menu-role-badge';
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
     "SELLER MORE" DRAWER (full seller nav in a grid)
  ═══════════════════════════════════════════════════════════ */
  function _buildMoreDrawer() {
    if (document.getElementById('sk-seller-more-drawer')) return;

    var drawer = document.createElement('div');
    drawer.id = 'sk-seller-more-drawer';
    drawer.className = 'sk-drawer';
    drawer.setAttribute('role', 'dialog');
    drawer.setAttribute('aria-modal', 'true');
    drawer.setAttribute('aria-label', 'Seller navigation');
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
      var active = _isActive(t.h) ? ';border-color:rgba(113,255,0,0.3);color:#71ff00;' : '';
      items +=
        '<a href="' + t.h + '" class="sk-more-item" style="' + active + '">' +
          '<span class="sk-more-icon" aria-hidden="true">' + t.i + '</span>' +
          '<span>' + t.l + '</span>' +
        '</a>';
    });

    drawer.innerHTML = header + '<div class="sk-drawer-body">' + items + '</div>';
    document.body.appendChild(drawer);
  }

  function _openMoreDrawer() {
    _buildMoreDrawer();
    if (window.SokoniDrawer) {
      SokoniDrawer.open('sk-seller-more-drawer', 'Seller Hub');
    } else {
      /* Fallback: wait for SokoniDrawer to initialise */
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

    /* Body workspace class (for CSS targeting) */
    ['buyer','seller','admin','superAdmin','driver','rider','provider'].forEach(function (c) {
      document.body.classList.remove('sk-workspace-' + c);
    });
    document.body.classList.add('sk-workspace-' + ws);

    /* Bottom nav */
    _buildBottomNav(ws);

    /* Seller sub-nav on seller workspace pages */
    if (ws === 'seller' && _page !== 'seller.html') _buildSellerSubnav();

    /* Back button + role chip on non-buyer workspaces */
    if (ws !== 'buyer') _buildBackBtn(ws);

    /* Role badge in menu overlay */
    _buildMenuBadge(ws);
  }

  /* ── Re-run on login/logout ─────────────────────────────── */
  window.addEventListener('storage', function (e) {
    if (e.key === 'sokoniUser') {
      /* Remove stale injections before re-running */
      var old = document.getElementById('sk-seller-subnav');
      if (old) old.remove();
      var btn = document.getElementById('sk-nav-back-btn');
      if (btn) btn.remove();
      var chip = document.getElementById('sk-nav-role-chip');
      if (chip) chip.remove();
      var badge = document.getElementById('sk-menu-role-badge');
      if (badge) badge.remove();
      _init();
    }
  });

  /* ── Boot ───────────────────────────────────────────────── */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _init);
  } else {
    _init();
  }

  /* Expose for external use (e.g. seller.html on workspace switch) */
  window.SokoniNavEngine = { refresh: _init, workspace: _workspace, role: _role };

}());
