/* SOKONI UI Extras — Floating WhatsApp Support + Notification Bell */
(function () {
  'use strict';

  /* ── FLOATING WHATSAPP SUPPORT BUTTON ── */
  function injectWhatsAppBtn() {
    if (document.getElementById('sokoni-wa-support')) return;

    var style = document.createElement('style');
    style.textContent = '#sokoni-wa-support{position:fixed;bottom:var(--sk-fab-bottom,80px);right:var(--sk-fab-right,18px);width:54px;height:54px;background:#25D366;border-radius:50%;display:flex;align-items:center;justify-content:center;box-shadow:0 4px 18px rgba(37,211,102,0.45);z-index:var(--sk-z-chat-btn,510);text-decoration:none;animation:waPulse 2.8s ease-in-out infinite;transition:transform .2s,bottom .25s;}'
      + '#sokoni-wa-support:hover{transform:scale(1.1);}'
      + '@keyframes waPulse{0%,100%{box-shadow:0 4px 18px rgba(37,211,102,0.45)}50%{box-shadow:0 4px 32px rgba(37,211,102,0.75),0 0 0 10px rgba(37,211,102,0.08)}}'
      + '.sokoni-wa-tooltip{position:absolute;right:62px;top:50%;transform:translateY(-50%);background:#1a1a1a;color:#fff;font-size:11px;font-weight:700;white-space:nowrap;padding:6px 10px;border-radius:8px;pointer-events:none;opacity:0;transition:opacity .2s;border:1px solid rgba(255,255,255,.1);}'
      + '#sokoni-wa-support:hover .sokoni-wa-tooltip{opacity:1;}';
    document.head.appendChild(style);

    var btn = document.createElement('a');
    btn.id = 'sokoni-wa-support';
    btn.href = 'https://wa.me/254705726803?text=' + encodeURIComponent('Hi SOKONI Support, I need help with...');
    btn.target = '_blank';
    btn.rel = 'noopener noreferrer';
    btn.setAttribute('aria-label', 'Contact SOKONI Support on WhatsApp');
    btn.innerHTML = '<span class="sokoni-wa-tooltip">Support</span>'
      + '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="white" width="28" height="28">'
      + '<path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347z"/>'
      + '<path d="M12 0C5.373 0 0 5.373 0 12c0 2.114.554 4.1 1.527 5.832L0 24l6.348-1.497A11.96 11.96 0 0012 24c6.627 0 12-5.373 12-12S18.627 0 12 0zm0 22c-1.844 0-3.577-.494-5.071-1.36l-.363-.217-3.768.888.943-3.667-.237-.376A9.955 9.955 0 012 12C2 6.477 6.477 2 12 2s10 4.477 10 10-4.477 10-10 10z"/>'
      + '</svg>';
    document.body.appendChild(btn);
  }

  /* ── NOTIFICATION BELL ── */
  function timeAgo(ts) {
    if (!ts) return '';
    var diff = (Date.now() - new Date(ts).getTime()) / 1000;
    if (diff < 60) return 'Just now';
    if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
    if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
    return Math.floor(diff / 86400) + 'd ago';
  }

  function getNotifItems() {
    var items = [];
    var keys = [
      { key: 'sokoniOrders',           icon: '🛍️', label: 'Order placed',       field: function(o){ return o.items && o.items[0] ? o.items[0].name : 'Product order'; } },
      { key: 'sokoniBookings',          icon: '📋', label: 'Booking confirmed',  field: function(b){ return b.service || b.type || 'Service booking'; } },
      { key: 'sokoniDeliveryRequests',  icon: '🚚', label: 'Delivery scheduled', field: function(d){ return d.from ? d.from + ' → ' + (d.to || '') : 'Delivery request'; } },
      { key: 'sokoniCarBookings',       icon: '🚗', label: 'Car rental booked',  field: function(c){ return (c.make || '') + ' ' + (c.model || 'Car') + ' rental'; } },
      { key: 'sokoniInvoices',          icon: '🧾', label: 'Invoice generated',  field: function(v){ return v.type ? v.type.charAt(0).toUpperCase() + v.type.slice(1) + ' invoice — KES ' + (v.total || 0).toLocaleString() : 'Invoice'; } }
    ];
    keys.forEach(function (k) {
      var arr = [];
      try { arr = JSON.parse(localStorage.getItem(k.key) || '[]'); } catch (e) {}
      if (!Array.isArray(arr)) return;
      arr.slice(0, 2).forEach(function (item) {
        items.push({
          icon: k.icon,
          title: k.label,
          body: k.field(item),
          time: item.createdAt || item.date || item.timestamp || item.savedAt
        });
      });
    });
    items.sort(function (a, b) {
      return (new Date(b.time || 0).getTime()) - (new Date(a.time || 0).getTime());
    });
    return items.slice(0, 7);
  }

  function getUnreadCount() {
    var count = 0;
    var keys = ['sokoniOrders', 'sokoniBookings', 'sokoniDeliveryRequests', 'sokoniCarBookings'];
    var DAY = 86400000;
    keys.forEach(function (key) {
      var arr = [];
      try { arr = JSON.parse(localStorage.getItem(key) || '[]'); } catch (e) {}
      if (!Array.isArray(arr)) return;
      arr.forEach(function (item) {
        var ts = item.createdAt || item.date || item.timestamp;
        if (ts && (Date.now() - new Date(ts).getTime()) < DAY) count++;
      });
    });
    return Math.min(count, 99);
  }

  function injectNotificationBell() {
    if (document.getElementById('sokoni-bell-btn')) return;

    var style = document.createElement('style');
    style.textContent =
      '#sokoni-bell-btn{position:fixed;top:20px;right:62px;width:44px;height:44px;background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.1);border-radius:50%;display:flex;align-items:center;justify-content:center;cursor:pointer;z-index:9950;transition:background .2s;-webkit-tap-highlight-color:transparent;overflow:visible;}'
      + '#sokoni-bell-btn:hover{background:rgba(255,255,255,.13);}'
      + '#sokoni-bell-icon{font-size:20px;line-height:1;pointer-events:none;}'
      + '#sokoni-bell-badge{position:absolute;top:-9px;right:-9px;background:#ef4444;color:#fff;font-size:12px;font-weight:900;border-radius:12px;min-width:22px;height:22px;display:flex;align-items:center;justify-content:center;padding:0 5px;font-family:inherit;box-shadow:0 2px 8px rgba(239,68,68,0.7);border:2.5px solid #0c0c0c;z-index:9951;pointer-events:none;}'
      + '#sokoni-notif-drawer{position:fixed;top:68px;right:10px;width:min(340px,calc(100vw - 20px));background:#1c1c1c;border:1px solid rgba(255,255,255,.1);border-radius:16px;z-index:9960;box-shadow:0 12px 48px rgba(0,0,0,.6);overflow:hidden;display:none;}'
      + '@media(min-width:768px){#sokoni-bell-btn{display:none!important;}#sokoni-notif-drawer{top:68px!important;right:12px!important;}}'
      + '#sokoni-notif-drawer.open{display:block;animation:drawerIn .2s ease;}'
      + '@keyframes drawerIn{from{opacity:0;transform:translateY(-8px)}to{opacity:1;transform:translateY(0)}}'
      + '.nd-head{padding:13px 16px;border-bottom:1px solid rgba(255,255,255,.07);display:flex;align-items:center;justify-content:space-between;}'
      + '.nd-head h4{margin:0;font-size:14px;font-weight:800;color:#fff;}'
      + '.nd-close{font-size:11px;color:rgba(255,255,255,.35);cursor:pointer;background:none;border:none;font-family:inherit;padding:0;}'
      + '.nd-close:hover{color:rgba(255,255,255,.7);}'
      + '.nd-item{display:flex;align-items:flex-start;gap:11px;padding:11px 16px;border-bottom:1px solid rgba(255,255,255,.05);transition:background .15s;}'
      + '.nd-item:hover{background:rgba(255,255,255,.04);}'
      + '.nd-item:last-of-type{border-bottom:none;}'
      + '.nd-icon{width:34px;height:34px;border-radius:9px;background:rgba(255,255,255,.06);display:flex;align-items:center;justify-content:center;font-size:15px;flex-shrink:0;}'
      + '.nd-body{flex:1;min-width:0;}'
      + '.nd-title{font-size:12px;font-weight:700;color:#fff;margin:0 0 2px;}'
      + '.nd-text{font-size:11px;color:rgba(255,255,255,.45);margin:0 0 3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}'
      + '.nd-time{font-size:10px;color:rgba(255,255,255,.28);}'
      + '.nd-empty{padding:28px 16px;text-align:center;color:rgba(255,255,255,.3);font-size:13px;}'
      + '.nd-footer{padding:9px 16px;border-top:1px solid rgba(255,255,255,.07);text-align:center;}'
      + '.nd-footer a{font-size:12px;color:#71ff00;text-decoration:none;font-weight:700;}';
    document.head.appendChild(style);

    var count = getUnreadCount();

    var btn = document.createElement('button');
    btn.id = 'sokoni-bell-btn';
    btn.setAttribute('aria-label', 'Notifications');
    btn.innerHTML = '<span id="sokoni-bell-icon">🔔</span>'
      + (count > 0 ? '<span id="sokoni-bell-badge">' + (count > 9 ? '9+' : count) + '</span>' : '');

    var drawer = document.createElement('div');
    drawer.id = 'sokoni-notif-drawer';

    function buildDrawer() {
      var items = getNotifItems();
      var rows = items.length
        ? items.map(function (it) {
          return '<div class="nd-item"><div class="nd-icon">' + it.icon + '</div>'
            + '<div class="nd-body"><p class="nd-title">' + it.title + '</p>'
            + '<p class="nd-text">' + it.body + '</p>'
            + '<span class="nd-time">' + timeAgo(it.time) + '</span></div></div>';
        }).join('')
        : '<div class="nd-empty">No activity yet — start shopping!</div>';

      drawer.innerHTML = '<div class="nd-head"><h4>🔔 Activity</h4>'
        + '<button class="nd-close" onclick="document.getElementById(\'sokoni-notif-drawer\').classList.remove(\'open\')">Close ✕</button></div>'
        + rows
        + '<div class="nd-footer"><a href="notifications.html">View all notifications →</a></div>';
    }

    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      buildDrawer();
      drawer.classList.toggle('open');
    });

    document.addEventListener('click', function () {
      drawer.classList.remove('open');
    });

    document.body.appendChild(btn);
    document.body.appendChild(drawer);
  }

  /* ── DESKTOP NAVBAR BELL BADGE + ACTIVITY DRAWER WIRE-UP ── */
  function injectDesktopBellBadge() {
    if (window.innerWidth < 768) return;
    var nBell = document.getElementById('nBellBtn');
    if (!nBell) return;

    /* Inject count badge onto navbar bell */
    var count = getUnreadCount();
    if (count > 0 && !document.getElementById('n-bell-count-badge')) {
      var badge = document.createElement('span');
      badge.id = 'n-bell-count-badge';
      badge.textContent = count > 9 ? '9+' : count;
      badge.style.cssText = 'position:absolute;top:-8px;right:-8px;background:#ef4444;color:#fff;font-size:12px;font-weight:900;border-radius:10px;min-width:22px;height:22px;display:flex;align-items:center;justify-content:center;padding:0 5px;font-family:inherit;pointer-events:none;z-index:10;box-shadow:0 2px 8px rgba(239,68,68,0.7);border:2.5px solid #0a0a0a;';
      nBell.style.position = 'relative';
      nBell.appendChild(badge);
    }

    /* Wire activity drawer to navbar bell on desktop */
    var drawer = document.getElementById('sokoni-notif-drawer');
    if (!drawer) return;
    nBell.addEventListener('click', function(e) {
      e.stopPropagation();
      buildActivityDrawer(drawer);
      drawer.classList.toggle('open');
    });
    document.addEventListener('click', function() {
      drawer.classList.remove('open');
    });
  }

  function buildActivityDrawer(drawer) {
    var items = getNotifItems();
    var rows = items.length
      ? items.map(function(it) {
          return '<div class="nd-item"><div class="nd-icon">' + it.icon + '</div>'
            + '<div class="nd-body"><p class="nd-title">' + it.title + '</p>'
            + '<p class="nd-text">' + it.body + '</p>'
            + '<span class="nd-time">' + timeAgo(it.time) + '</span></div></div>';
        }).join('')
      : '<div class="nd-empty">No activity yet — start shopping!</div>';
    drawer.innerHTML = '<div class="nd-head"><h4>🔔 Activity</h4>'
      + '<button class="nd-close" onclick="document.getElementById(\'sokoni-notif-drawer\').classList.remove(\'open\')">Close ✕</button></div>'
      + rows
      + '<div class="nd-footer"><a href="notifications.html">View all notifications →</a></div>';
  }

  /* ── GLOBAL MOBILE MENU ── */
  var MENU_HTML = [
    /* ── Auth row — shown when logged out, replaced when logged in ── */
    '<div class="mmenu-auth" id="mmenuAuthRow">',
      '<a href="login.html" id="mmenuLoginLink" class="mmenu-btn-login">🔑 Login</a>',
      '<a href="signup.html" id="mmenuSignupLink" class="mmenu-btn-signup">✨ Create Account</a>',
    '</div>',
    /* ── logged-in greeting (hidden by default, shown by JS) ── */
    '<div class="mmenu-user-row" id="mmenuUserRow" style="display:none">',
      '<div class="mmenu-avatar" id="mmenuAvatar">👤</div>',
      '<div class="mmenu-user-info">',
        '<span class="mmenu-user-name" id="mmenuUserName">My Account</span>',
        '<a href="profile.html" class="mmenu-user-link">View profile →</a>',
      '</div>',
    '</div>',

    '<a href="index.html">🏠 Home</a>',

    '<div class="mmenu-section">Shop</div>',
    '<a href="category.html?cat=all">🛍️ All Categories</a>',
    '<a href="flashsale.html">⚡ Flash Sale</a>',
    '<a href="offer.html">🏪 Sell / List Product</a>',

    '<div class="mmenu-section">Services &amp; Delivery</div>',
    '<a href="services.html">🛠️ All Services</a>',
    '<a href="food.html">🍔 Food &amp; Drinks</a>',
    '<a href="delivery.html">🚛 Delivery</a>',
    '<a href="driver.html">🚗 Driver Portal</a>',

    '<div class="mmenu-section">Hubs</div>',
    '<a href="healthcare.html">🏥 Healthcare</a>',
    '<a href="construction.html">🏗️ Construction</a>',
    '<a href="banking.html">🏦 Banking &amp; Finance</a>',
    '<a href="entertainment.html">🎬 Entertainment</a>',
    '<a href="sports-hub.html">⚽ Sports Hub</a>',
    '<a href="car-hub.html">🚗 Car Hub</a>',
    '<a href="property.html">🏘️ Property</a>',
    '<a href="bnb.html">🏨 BnB &amp; Stays</a>',
    '<a href="legal-hub.html">⚖️ Legal Hub</a>',
    '<a href="b2b.html">🤝 B2B</a>',
    '<a href="tech-hub.html">📱 Tech Hub</a>',
    '<a href="tech-hub.html">💻 Digital Services</a>',
    '<a href="life-events.html">✨ Life Events</a>',
    '<a href="trust.html">🛂 Trust Passport</a>',
    '<a href="opportunity.html">💼 Earn with Sokoni</a>',
    '<a href="fitness-hub.html">💪 Fitness Hub</a>',
    '<a href="home-services.html">🏠 Home Services</a>',
    '<a href="community.html">💬 Community</a>',

    '<div class="mmenu-section">My Account</div>',
    '<a href="profile.html">👤 My Profile</a>',
    '<a href="notifications.html">🔔 Notifications</a>',
    '<a href="loyalty.html">⭐ Loyalty Points</a>',
    '<a href="referral.html">🎁 Refer &amp; Earn</a>',
    '<a href="seller.html">🏪 Seller Dashboard</a>',
    '<a href="cart.html">🛒 My Cart</a>',
    '<a href="wishlist.html">❤️ Wishlist</a>',
    '<a href="messages.html">💬 Messages</a>',
    '<a href="track.html">📦 Track Order</a>',
    '<a href="wallet.html">💳 SOKONI Wallet</a>',
    '<a href="subscriptions.html">♾️ Subscriptions</a>',
    '<a href="business-os.html">💼 Business OS</a>'
  ].join('');

  function closeMobileMenu() {
    var m = document.getElementById('mobileMenu');
    var o = document.getElementById('menuOverlay');
    if (!m) return;
    m.classList.remove('active-menu');
    if (o) o.classList.remove('active');
    document.body.style.overflow = '';
  }

  function updateMenuAuth() {
    try {
      var u = JSON.parse(localStorage.getItem('sokoniUser') || 'null');
      var loggedIn = u && (u.name || u.email || u.phone);
      var authRow  = document.getElementById('mmenuAuthRow');
      var userRow  = document.getElementById('mmenuUserRow');
      var nameEl   = document.getElementById('mmenuUserName');
      var avatarEl = document.getElementById('mmenuAvatar');
      if (authRow)  authRow.style.display  = loggedIn ? 'none' : 'grid';
      if (userRow)  userRow.style.display  = loggedIn ? 'flex' : 'none';
      if (loggedIn && nameEl) {
        nameEl.textContent = u.name || u.email || 'My Account';
        if (avatarEl) avatarEl.textContent = (u.name || u.email || 'U')[0].toUpperCase();
      }
    } catch(e) {}
  }

  function openMobileMenu() {
    var m = document.getElementById('mobileMenu');
    var o = document.getElementById('menuOverlay');
    if (!m) return;
    updateMenuAuth();
    /* Highlight current page link */
    var path = window.location.pathname.split('/').pop() || 'index.html';
    m.querySelectorAll('a').forEach(function(a) {
      var href = a.getAttribute('href') || '';
      a.style.background = href === path ? 'rgba(113,255,0,0.07)' : '';
      a.style.color      = href === path ? '#71ff00' : '';
    });
    m.classList.add('active-menu');
    if (o) o.classList.add('active');
    document.body.style.overflow = 'hidden';
  }

  function toggleMobileMenuGlobal() {
    var m = document.getElementById('mobileMenu');
    if (!m) return;
    if (m.classList.contains('active-menu')) closeMobileMenu();
    else openMobileMenu();
  }
  window.toggleMobileMenu = toggleMobileMenuGlobal;

  function injectMobileMenu() {
    /* Skip if index.html already has its own menu */
    if (document.getElementById('mobileMenu')) return;

    /* Overlay */
    var overlay = document.createElement('div');
    overlay.className = 'menu-overlay';
    overlay.id = 'menuOverlay';
    overlay.addEventListener('click', closeMobileMenu);
    document.body.appendChild(overlay);

    /* Drawer */
    var menu = document.createElement('div');
    menu.className = 'mobile-menu';
    menu.id = 'mobileMenu';
    menu.innerHTML = '<button class="mmenu-close" aria-label="Close menu">✕</button>' + MENU_HTML;
    menu.querySelector('.mmenu-close').addEventListener('click', closeMobileMenu);
    document.body.appendChild(menu);

    /* Hamburger toggle button — only on mobile */
    if (!document.querySelector('.menu-toggle')) {
      var btn = document.createElement('div');
      btn.className = 'menu-toggle';
      btn.setAttribute('role', 'button');
      btn.setAttribute('aria-label', 'Open menu');
      btn.innerHTML = '☰';
      btn.addEventListener('click', toggleMobileMenuGlobal);
      document.body.appendChild(btn);
    }

    /* ESC to close */
    document.addEventListener('keydown', function(e) {
      if (e.key === 'Escape') closeMobileMenu();
    });

  }

  /* ── GLOBAL SEARCH BUTTON (mobile-only, fixed top-left area) ── */
  function injectSearchBtn() {
    if (document.getElementById('sokoni-search-btn')) return;
    /* Skip on search.html itself */
    if (window.location.pathname.endsWith('search.html')) return;

    var style = document.createElement('style');
    style.textContent =
      '#sokoni-search-btn{position:fixed;top:20px;right:162px;width:44px;height:44px;background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.1);border-radius:50%;display:flex;align-items:center;justify-content:center;text-decoration:none;font-size:19px;z-index:9950;-webkit-tap-highlight-color:transparent;transition:background .2s;}'
    + '#sokoni-search-btn:hover{background:rgba(255,255,255,.13);}'
    + '@media(min-width:768px){#sokoni-search-btn{display:none!important;}}';
    document.head.appendChild(style);

    var btn = document.createElement('a');
    btn.id   = 'sokoni-search-btn';
    btn.href = 'search.html';
    btn.setAttribute('aria-label', 'Search');
    btn.textContent = '🔍';
    document.body.appendChild(btn);
  }

  /* ── INBOX BUTTON (mobile-only, fixed) ── */
  function injectInboxBtn() {
    if (document.getElementById('sokoni-inbox-btn')) return;
    if (window.location.pathname.endsWith('messages.html')) return;

    var style = document.createElement('style');
    style.textContent =
      '#sokoni-inbox-btn{position:fixed;top:20px;right:112px;width:44px;height:44px;background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.1);border-radius:50%;display:flex;align-items:center;justify-content:center;text-decoration:none;font-size:19px;z-index:9950;-webkit-tap-highlight-color:transparent;transition:background .2s;position:fixed;overflow:visible;}'
    + '#sokoni-inbox-btn:hover{background:rgba(255,255,255,.13);}'
    + '#sokoni-inbox-badge{position:absolute;top:-9px;right:-9px;background:#3b82f6;color:#fff;font-size:11px;font-weight:900;border-radius:12px;min-width:20px;height:20px;display:flex;align-items:center;justify-content:center;padding:0 4px;border:2.5px solid #0c0c0c;pointer-events:none;z-index:9951;}'
    + '@media(min-width:768px){#sokoni-inbox-btn{display:none!important;}}';
    document.head.appendChild(style);

    /* Count unread convos from localStorage cache */
    var unread = 0;
    try {
      var convos = JSON.parse(localStorage.getItem('sokoniConvosCache') || '[]');
      var uid = (JSON.parse(localStorage.getItem('sokoniUser') || '{}')).uid || '';
      if (uid) convos.forEach(function(c){ if ((c.unread||{})[uid] > 0) unread++; });
    } catch(e) {}

    var btn = document.createElement('a');
    btn.id   = 'sokoni-inbox-btn';
    btn.href = 'messages.html';
    btn.setAttribute('aria-label', 'Messages');
    btn.style.cssText = 'position:fixed;top:20px;right:112px;width:44px;height:44px;background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.1);border-radius:50%;display:flex;align-items:center;justify-content:center;text-decoration:none;font-size:19px;z-index:9950;transition:background .2s;overflow:visible;';
    btn.innerHTML = '💬' + (unread > 0 ? '<span id="sokoni-inbox-badge">' + Math.min(unread, 9) + '</span>' : '');
    document.body.appendChild(btn);
  }

  /* ── WALLET BALANCE IN MENU USER ROW ── */
  function injectWalletBalance() {
    var userRow = document.getElementById('mmenuUserRow');
    if (!userRow || document.getElementById('mmenuWalletBal')) return;
    var bal = 0;
    try {
      var w = JSON.parse(localStorage.getItem('sokoniWallet') || '{}');
      bal = parseFloat(w.balance) || 0;
    } catch(e) {}
    var chip = document.createElement('a');
    chip.id = 'mmenuWalletBal';
    chip.href = 'wallet.html';
    chip.style.cssText = 'display:inline-flex;align-items:center;gap:5px;margin-top:6px;padding:5px 12px;background:rgba(113,255,0,0.08);border:1px solid rgba(113,255,0,0.2);border-radius:20px;font-size:12px;font-weight:800;color:#71ff00;text-decoration:none;';
    chip.textContent = '💳 KES ' + bal.toLocaleString('en-KE');
    userRow.appendChild(chip);
  }

  /* ── INIT ── */
  function init() {
    injectNotificationBell();
    injectDesktopBellBadge();
    injectSearchBtn();
    injectInboxBtn();
    injectMobileMenu();
    /* Wallet balance injected after menu renders */
    setTimeout(injectWalletBalance, 100);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();

/* ── Universal confirm dialog (replaces window.confirm across all pages) ── */
window._skConfirm = function(msg, onOk, onCancel) {
  var id = '_skConfirmBox';
  var old = document.getElementById(id);
  if (old) old.remove();
  var box = document.createElement('div');
  box.id = id;
  box.style.cssText = 'position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.6);backdrop-filter:blur(2px);';
  box.innerHTML = '<div style="background:#141414;border:1px solid rgba(255,255,255,.12);border-radius:14px;padding:24px 22px;max-width:88vw;width:340px;font-family:inherit;">'
    + '<p style="margin:0 0 20px;color:rgba(255,255,255,.88);font-size:14px;line-height:1.5;">' + msg + '</p>'
    + '<div style="display:flex;gap:10px;justify-content:flex-end;">'
    + '<button id="_skCancelBtn" style="padding:9px 18px;border-radius:9px;border:1px solid rgba(255,255,255,.15);background:transparent;color:rgba(255,255,255,.6);font-size:13px;cursor:pointer;font-family:inherit;">Cancel</button>'
    + '<button id="_skOkBtn" style="padding:9px 18px;border-radius:9px;border:none;background:#ef4444;color:#fff;font-size:13px;cursor:pointer;font-weight:700;font-family:inherit;">Confirm</button>'
    + '</div></div>';
  document.body.appendChild(box);
  function close() { box.remove(); }
  box.querySelector('#_skOkBtn').onclick = function() { close(); if(onOk) onOk(); };
  box.querySelector('#_skCancelBtn').onclick = function() { close(); if(onCancel) onCancel(); };
  box.onclick = function(e) { if(e.target===box){ close(); if(onCancel) onCancel(); } };
};

/* ── Universal toast (replaces window.alert across all pages) ── */
window._skToast = (function(){
  var _el;
  function _get(){
    if(_el&&document.body.contains(_el)) return _el;
    _el = document.createElement('div');
    _el.style.cssText = 'position:fixed;bottom:80px;left:50%;transform:translateX(-50%);'
      +'background:rgba(10,10,10,.93);border:1px solid rgba(113,255,0,.28);'
      +'color:#c8ffb0;padding:10px 20px;border-radius:10px;font-size:13px;'
      +'font-family:inherit;z-index:99998;max-width:88vw;text-align:center;'
      +'transition:opacity .3s;pointer-events:none;line-height:1.45;';
    document.body.appendChild(_el);
    return _el;
  }
  return function(msg){
    if(!document.body){ window.alert(msg); return; }
    var t=_get();
    t.textContent = typeof msg==='string' ? msg : String(msg);
    t.style.opacity='1';
    clearTimeout(t._sk);
    t._sk = setTimeout(function(){ t.style.opacity='0'; }, 3500);
  };
}());
