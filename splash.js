/**
 * SOKONI Splash Screen — page-aware premium entrance
 * Every page shows the same core brand tagline ("Kenya's Global Marketplace")
 * but with a unique colour theme, emoji badge, and hub subtitle per page.
 */
(function () {
  /* ── Page detection ── */
  var _raw  = window.location.pathname.split('/').pop() || 'index.html';
  var _page = _raw.split('?')[0].split('#')[0] || 'index.html';

  /* ── Per-page identity ──
     [emoji, hubLine, accentColor, glowRgba, bgDark, bgDeep]                  */
  var CFG = {
    /* ── CORE MARKETPLACE ── */
    'index.html':         ['🛒', 'Kenya\'s Global Marketplace',                      '#71ff00', 'rgba(113,255,0,0.22)',   '#030503', '#010101'],
    'category.html':      ['🛍️', 'Browse Every Category',                           '#06b6d4', 'rgba(6,182,212,0.15)',   '#001a22', '#020c12'],
    'product.html':       ['✨', 'Premium Product Showcase',                          '#fbbf24', 'rgba(251,191,36,0.15)',  '#1f1400', '#0d0900'],
    'cart.html':          ['🛒', 'Your Shopping Cart',                               '#10b981', 'rgba(16,185,129,0.15)',  '#001e14', '#030f09'],
    'checkout.html':      ['💳', 'Secure Checkout · M-PESA & Cards',                 '#a8ff58', 'rgba(113,255,0,0.15)',  '#0e0628', '#060312'],
    'success.html':       ['🎉', 'Order Confirmed · Thank You!',                     '#4ade80', 'rgba(74,222,128,0.15)',  '#002610', '#030e06'],
    'invoice.html':       ['🧾', 'Invoice · Your Receipt',                           '#60a5fa', 'rgba(96,165,250,0.15)',  '#001226', '#020910'],
    'offer.html':         ['🏷️', 'Exclusive Offer · Just for You',                  '#f43f5e', 'rgba(244,63,94,0.15)',   '#28000c', '#100005'],
    'flashsale.html':     ['⚡', 'Flash Sale · Grab It Before It\'s Gone',           '#ef4444', 'rgba(239,68,68,0.16)',   '#2a0000', '#0f0101'],

    /* ── ACCOUNT & AUTH ── */
    'login.html':         ['🔑', 'Sign In · Welcome Back',                           '#f472b6', 'rgba(244,114,182,0.15)', '#26001a', '#100009'],
    'signup.html':        ['🚀', 'Join Free · Start Buying & Selling',               '#34d399', 'rgba(52,211,153,0.15)',  '#001c12', '#030e08'],
    'register.html':      ['✍️', 'Create Your Account',                              '#c8ff80', 'rgba(167,139,250,0.15)', '#0c0426', '#050212'],
    'profile.html':       ['👤', 'My Profile · Orders & Rewards',                    '#38bdf8', 'rgba(56,189,248,0.15)',  '#001626', '#020c12'],
    'wishlist.html':      ['❤️', 'Wishlist · Things You Love',                       '#ec4899', 'rgba(236,72,153,0.16)',  '#26001a', '#0d0009'],

    /* ── SELLER & STORE ── */
    'seller.html':        ['🏪', 'Seller Dashboard · Manage & Grow',                 '#f59e0b', 'rgba(245,158,11,0.16)',  '#1f1000', '#0a0600'],
    'seller-public.html': ['🌟', 'Seller Storefront · Browse & Buy',                 '#facc15', 'rgba(250,204,21,0.15)',  '#1a1400', '#090800'],
    'store.html':         ['🛍️', 'Seller Store · Browse Products',                  '#fb923c', 'rgba(251,146,60,0.15)',  '#221000', '#0d0600'],
    'ministore.html':     ['🏪', 'MiniStore · Your SOKONI Shop',                     '#818cf8', 'rgba(129,140,248,0.15)', '#06062a', '#040412'],
    'subscriptions.html': ['👑', 'SOKONI Premium · Unlock Everything',               '#d97706', 'rgba(217,119,6,0.16)',   '#1f1200', '#0c0700'],
    'referral.html':      ['🎯', 'Refer & Earn · Share & Win',                       '#86efac', 'rgba(134,239,172,0.15)', '#002018', '#030e0a'],
    'loyalty.html':       ['🎁', 'Rewards · Points & Perks',                         '#fb7185', 'rgba(251,113,133,0.15)', '#260010', '#100007'],
    'reviews.html':       ['⭐', 'Reviews · Honest Buyer Feedback',                  '#fcd34d', 'rgba(252,211,77,0.16)',  '#1a1400', '#0d0900'],
    'unboxing.html':      ['📦', 'Unboxing · Show It Off',                           '#fdba74', 'rgba(253,186,116,0.15)', '#211000', '#0c0600'],

    /* ── SERVICES & HUBS ── */
    'services.html':      ['🛠️', 'Services Hub · Skilled Pros Near You',            '#00c8a0', 'rgba(0,200,160,0.15)',   '#001e18', '#030f0c'],
    'cleaning.html':      ['🧹', 'Cleaning & Laundry Hub',                           '#22d3ee', 'rgba(34,211,238,0.15)',  '#001820', '#02090e'],
    'electrical.html':    ['⚡', 'Electrical Services · Wiring & Power',             '#fef08a', 'rgba(254,240,138,0.15)', '#1c1600', '#0a0a00'],
    'phone-repair.html':  ['📱', 'Phone Repair · Fix It Fast',                       '#0284c7', 'rgba(2,132,199,0.16)',   '#001a28', '#020b14'],
    'plumbing.html':      ['🔧', 'Plumbing Services · Pipes & Water',                '#0891b2', 'rgba(8,145,178,0.15)',   '#001624', '#020b10'],
    'mechanics.html':     ['🔩', 'Auto Hub · Mechanics & Garages',                   '#94a3b8', 'rgba(148,163,184,0.15)', '#0a0c14', '#050608'],
    'marketing.html':     ['📣', 'Marketing Hub · Grow Your Business',               '#f97316', 'rgba(249,115,22,0.16)',  '#1f0e00', '#0a0500'],
    'requests.html':      ['📋', 'Requests · Post & Get Seller Quotes',              '#71ff00', 'rgba(113,255,0,0.16)',  '#0e0424', '#050210'],
    'provider.html':      ['🛠️', 'Provider Hub · Manage Jobs & Earn',               '#9333ea', 'rgba(147,51,234,0.15)',  '#120430', '#060214'],

    /* ── TRANSPORT ── */
    'driver.html':        ['🛵', 'Driver Hub · Drive & Earn 88%',                    '#0e7490', 'rgba(14,116,144,0.16)',  '#001820', '#020b10'],
    'car-hub.html':       ['🚗', 'Car Hub · Drive Kenya Forward',                    '#3b82f6', 'rgba(59,130,246,0.16)',  '#001030', '#030810'],
    'car-rental.html':    ['🚙', 'Car Rental · Self-Drive & Chauffeur',              '#0ea5e9', 'rgba(14,165,233,0.15)',  '#001a28', '#020c14'],
    'delivery.html':      ['🚚', 'Delivery Hub · Fast & Tracked',                    '#22c55e', 'rgba(34,197,94,0.15)',   '#002216', '#030e08'],
    'track.html':         ['📍', 'Order Tracking · Live Updates',                    '#ea7316', 'rgba(234,115,22,0.16)',  '#221000', '#0e0600'],

    /* ── PROPERTY & STAY ── */
    'bnb.html':           ['🏨', 'Stay Hub · Hotels, BnB & Lodges',                 '#ff6b35', 'rgba(255,107,53,0.16)',  '#280d00', '#0d0500'],
    'bnb-manage.html':    ['🏢', 'Host Dashboard · Manage Your BnB',                 '#c084fc', 'rgba(192,132,252,0.15)', '#120430', '#07021a'],
    'property.html':      ['🏠', 'Property Hub · Houses & Land',                    '#059669', 'rgba(5,150,105,0.15)',   '#001c14', '#030e08'],
    'landlord.html':      ['🏘️', 'Landlord Portal · Rent & Manage',                '#16a34a', 'rgba(22,163,74,0.16)',   '#002012', '#030e07'],

    /* ── FINANCIAL & LEGAL ── */
    'banking.html':       ['🏦', 'Banking Hub · Loans, SACCOs & Finance',           '#eab308', 'rgba(234,179,8,0.16)',   '#1c1200', '#0d0800'],
    'b2b.html':           ['🤝', 'B2B Hub · Wholesale & Bulk',                       '#14b8a6', 'rgba(20,184,166,0.15)',  '#001c1a', '#030e0c'],
    'legal-hub.html':     ['⚖️', 'Legal Hub · Lawyers & Contracts',                 '#e2b96f', 'rgba(226,185,111,0.16)', '#1c1200', '#090700'],
    'legal.html':         ['📜', 'Terms · Privacy · Seller Policy',                  '#d4a574', 'rgba(212,165,116,0.15)', '#1a1000', '#080600'],
    'dispute.html':       ['🛡️', 'Help & Support · Report an Issue',                '#dc2626', 'rgba(220,38,38,0.16)',   '#2c0000', '#110101'],

    /* ── LIFESTYLE & ENTERTAINMENT ── */
    'food.html':          ['🍔', 'Food & Delivery Hub',                              '#ea580c', 'rgba(234,88,12,0.16)',   '#281000', '#0e0600'],
    'entertainment.html': ['🎬', 'Entertainment Hub · DJs, MCs & More',              '#db2777', 'rgba(219,39,119,0.16)',  '#260016', '#0d0008'],
    'sports-hub.html':    ['⚽', 'Sports Hub · Book Turfs & Leagues',                '#15803d', 'rgba(21,128,61,0.16)',   '#002210', '#030e07'],
    'healthcare.html':    ['🏥', 'Healthcare Hub · Doctors & Clinics',               '#00c878', 'rgba(0,200,120,0.15)',   '#001c14', '#030e08'],
    'construction.html':  ['🏗️', 'Construction Hub · Build Kenya',                  '#b45309', 'rgba(180,83,9,0.16)',    '#241000', '#0e0600'],
    'digital.html':       ['💻', 'Digital Products · eBooks & Courses',              '#a855f7', 'rgba(168,85,247,0.16)',  '#120630', '#060314'],
    'community.html':     ['👥', 'Community · Connect & Grow',                       '#a21caf', 'rgba(162,28,175,0.16)',  '#200430', '#0e0218'],
    'messages.html':      ['💬', 'Messages · Chat Buyers & Sellers',                 '#0369a1', 'rgba(3,105,161,0.16)',   '#001424', '#020a10'],

    /* ── SPORTS HUB ── */
    'sports-hub.html':       ['⚽', 'Sports Hub · Book Turfs & Leagues',             '#15803d', 'rgba(21,128,61,0.16)',   '#002210', '#030e07'],
    'sports-tournament.html':['🏆', 'Tournaments · Compete & Win',                   '#16a34a', 'rgba(22,163,74,0.16)',   '#002010', '#030e07'],
    'sports-venue.html':     ['🏟️', 'Sports Venues · Book Your Turf',               '#15803d', 'rgba(21,128,61,0.16)',   '#002210', '#030e07'],

    /* ── B2B HUB ── */
    'b2b-chat.html':            ['💬', 'B2B Chat · Negotiate & Close Deals',         '#14b8a6', 'rgba(20,184,166,0.15)',  '#001c1a', '#030e0c'],
    'b2b-dashboard.html':       ['📊', 'B2B Dashboard · Your Wholesale Hub',         '#0891b2', 'rgba(8,145,178,0.15)',   '#001624', '#020b10'],
    'b2b-orders.html':          ['📦', 'B2B Orders · Wholesale Management',          '#0e7490', 'rgba(14,116,144,0.16)',  '#001820', '#020b10'],
    'b2b-rfq.html':             ['📋', 'B2B RFQ · Request for Quotation',            '#0284c7', 'rgba(2,132,199,0.16)',   '#001a28', '#020b14'],
    'b2b-seller-dashboard.html':['🤝', 'B2B Seller · Manage Wholesale',             '#14b8a6', 'rgba(20,184,166,0.15)',  '#001c1a', '#030e0c'],
    'b2b-supplier.html':        ['🏭', 'B2B Supplier Portal',                        '#0891b2', 'rgba(8,145,178,0.15)',   '#001624', '#020b10'],

    /* ── PROPERTY HUB ── */
    'property-hub.html':             ['🏠', 'Property Hub · Buy, Rent & Invest',    '#059669', 'rgba(5,150,105,0.15)',   '#001c14', '#030e08'],
    'property-listing.html':         ['🏡', 'Property Listing · Find Your Home',    '#16a34a', 'rgba(22,163,74,0.16)',   '#002012', '#030e07'],
    'property-dashboard.html':       ['🏘️', 'Property Dashboard · My Listings',    '#059669', 'rgba(5,150,105,0.15)',   '#001c14', '#030e08'],
    'property-agent.html':           ['🔑', 'Property Agents · Find Your Agent',    '#16a34a', 'rgba(22,163,74,0.16)',   '#002012', '#030e07'],
    'property-agent-dashboard.html': ['🏠', 'Agent Dashboard · Manage Listings',   '#059669', 'rgba(5,150,105,0.15)',   '#001c14', '#030e08'],

    /* ── FOOD HUB ── */
    'food-menu.html':      ['🍽️', 'Food Menu · Browse & Order',                     '#ea580c', 'rgba(234,88,12,0.16)',   '#281000', '#0e0600'],
    'cart.html':           ['🛒', 'Cart · Review Your Order',                        '#71ff00', 'rgba(113,255,0,0.12)',   '#0a1200', '#050800'],
    'food-order.html':     ['🍔', 'Food Order · Track Your Meal',                    '#ea580c', 'rgba(234,88,12,0.16)',   '#281000', '#0e0600'],
    'food-dashboard.html': ['📊', 'Food Dashboard · Manage Orders',                  '#f59e0b', 'rgba(245,158,11,0.16)',  '#1f1000', '#0a0600'],
    'food-rider.html':     ['🛵', 'Food Rider · Deliver & Earn',                     '#22c55e', 'rgba(34,197,94,0.15)',   '#002216', '#030e08'],

    /* ── BNB HUB ── */
    'bnb-hub.html':        ['🏨', 'BnB Hub · Discover Stays in Kenya',               '#ff6b35', 'rgba(255,107,53,0.16)',  '#280d00', '#0d0500'],

    /* ── ANALYTICS & DASHBOARDS ── */
    'seller-analytics.html':  ['📊', 'Seller Analytics · Sales & Growth',            '#10b981', 'rgba(16,185,129,0.15)',  '#001e14', '#030f09'],
    'seller-revenue.html':    ['💰', 'Seller Revenue · Earnings & Payouts',          '#f59e0b', 'rgba(245,158,11,0.16)',  '#1f1000', '#0a0600'],
    'revenue.html':           ['💰', 'Revenue · Earnings & Payouts',                 '#f59e0b', 'rgba(245,158,11,0.16)',  '#1f1000', '#0a0600'],
    'business-analytics.html':['📈', 'Business Analytics · Track & Grow',            '#818cf8', 'rgba(129,140,248,0.15)', '#06062a', '#040412'],
    'customer-analytics.html':['👥', 'Customer Analytics · Know Your Buyers',        '#c084fc', 'rgba(192,132,252,0.15)', '#120430', '#07021a'],
    'growth-dashboard.html':  ['🚀', 'Growth Dashboard · Scale Your Business',       '#a8ff58', 'rgba(113,255,0,0.15)',  '#0e0628', '#060312'],

    /* ── OTHER PAGES ── */
    'search.html':        ['🔍', 'Search · Find Anything on SOKONI',                 '#38bdf8', 'rgba(56,189,248,0.15)',  '#001626', '#020c12'],
    'messages.html':      ['💬', 'Messages · Chat Buyers & Sellers',                 '#0369a1', 'rgba(3,105,161,0.16)',   '#001424', '#020a10'],
    'payments.html':      ['💳', 'Payments · Transactions & History',                '#a8ff58', 'rgba(113,255,0,0.15)',  '#0e0628', '#060312'],
    'pos.html':           ['🧾', 'POS · Point of Sale System',                       '#10b981', 'rgba(16,185,129,0.15)',  '#001e14', '#030f09'],
    'marketing-hub.html': ['📣', 'Marketing Hub · Run Campaigns',                    '#f97316', 'rgba(249,115,22,0.16)',  '#1f0e00', '#0a0500'],
    'register.html':      ['✍️', 'Create Your Account',                              '#c8ff80', 'rgba(167,139,250,0.15)', '#0c0426', '#050212'],

    /* ── MANAGEMENT & ADMIN ── */
    'admin.html':              ['⚙️', 'Admin · Control Panel',                       '#64748b', 'rgba(100,116,139,0.16)', '#0a0c16', '#050608'],
    'verification-admin.html': ['✅', 'Verification Admin · Review Sellers',         '#64748b', 'rgba(100,116,139,0.16)', '#0a0c16', '#050608'],
    'inspiq.html':             ['📌', 'InspIQ · Your Personalised Feed',             '#e879f9', 'rgba(232,121,249,0.15)', '#260032', '#100018'],
      };

  var c       = CFG[_page] || CFG['index.html'];
  var emoji   = c[0], hub   = c[1];
  var color   = c[2], glow  = c[3];
  var bg1     = c[4], bg2   = c[5];

  /* Snappy entrance — short enough to feel fast, long enough to feel premium */
  var MIN = (_page === 'index.html') ? 1000 : 600;

  /* ── 1. Inject per-page colour overrides then the splash HTML ── */
  if (!document.getElementById('splashScreen')) {
    document.write(
      '<style id="splashPageStyle">' +
        /* ── Base layout — self-contained so pages without style.css still work ── */
        '.splash-screen{position:fixed;top:0;left:0;width:100%;height:100vh;' +
          'display:flex;flex-direction:column;justify-content:center;align-items:center;' +
          'z-index:999999;overflow:hidden;}' +
        '#splashCanvas{position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:0;}' +
        '.splash-content{position:relative;z-index:2;display:flex;flex-direction:column;' +
          'align-items:center;justify-content:center;text-align:center;color:white;' +
          'width:100%;max-width:340px;padding:0 16px;}' +
        '.splash-logo{width:220px;max-width:68vw;height:auto;display:block;' +
          'margin:0 auto 16px;animation:splashLogoIn 0.6s cubic-bezier(0.34,1.56,0.64,1) both,' +
          'splashLogoPulse 2.4s ease-in-out 0.7s infinite;}' +
        '@keyframes splashLogoIn{from{opacity:0;transform:scale(0.8) translateY(14px);}to{opacity:1;transform:scale(1) translateY(0);}}' +
        '@keyframes splashLogoPulse{0%,100%{filter:drop-shadow(0 0 10px ' + glow + ');}50%{filter:drop-shadow(0 0 22px ' + glow + ');}}' +
        '.loader-ring{width:52px;height:52px;border-radius:50%;border:3px solid rgba(255,255,255,0.08);' +
          'border-top-color:' + color + ';box-shadow:0 0 22px ' + glow + ';' +
          'animation:splashSpin 0.85s linear infinite;margin:0 auto 12px;}' +
        '@keyframes splashSpin{to{transform:rotate(360deg);}}' +
        '.splash-tagline{font-size:11px;font-weight:800;letter-spacing:2.5px;' +
          'color:rgba(255,255,255,0.75);text-transform:uppercase;' +
          'animation:splashFadeUp 0.6s ease 0.4s both;}' +
        '@keyframes splashFadeUp{from{opacity:0;transform:translateY(8px);}to{opacity:1;transform:translateY(0);}}' +
        /* ── Per-page accent overrides ── */
        '#splashScreen{' +
          'background:radial-gradient(ellipse at 50% 42%,' + bg1 + ' 0%,' + bg2 + ' 72%) !important;}' +
        '#splashBadge{' +
          'display:inline-flex;align-items:center;justify-content:center;' +
          'width:58px;height:58px;border-radius:16px;font-size:28px;' +
          'background:' + glow + ';border:1px solid ' + color + '44;' +
          'margin:0 auto 14px;' +
          'animation:splashBadgePulse 2s ease-in-out infinite,splashLogoIn 0.5s cubic-bezier(0.34,1.56,0.64,1) 0.2s both;}' +
        '@keyframes splashBadgePulse{' +
          '0%,100%{transform:scale(1);box-shadow:0 0 0 0 ' + color + '33;}' +
          '50%{transform:scale(1.08);box-shadow:0 0 0 10px ' + color + '00;}}' +
        '#splashHub{' +
          'color:' + color + ';font-size:11px;font-weight:800;letter-spacing:1.5px;' +
          'text-transform:uppercase;margin-top:6px;' +
          'animation:splashFadeUp 0.6s ease 0.5s both;}' +
        '#splashBar{position:absolute;bottom:28px;left:50%;transform:translateX(-50%);' +
          'width:130px;height:2px;background:rgba(255,255,255,0.07);border-radius:2px;overflow:hidden;z-index:3;}' +
        '#splashBarFill{height:100%;width:0;background:linear-gradient(90deg,' + color + '99,' + color + ');border-radius:2px;' +
          'transition:width ' + MIN + 'ms linear;}' +
      '</style>'
    );
    document.write(
      '<div id="splashScreen" class="splash-screen">' +
        '<canvas id="splashCanvas"></canvas>' +
        '<div class="splash-content" style="position:relative;z-index:2;">' +
          '<img src="assets/Sokonilogo2.png" class="splash-logo" alt="SOKONI">' +
          '<div id="splashBadge">' + emoji + '</div>' +
          '<div class="loader-ring"></div>' +
          '<div class="splash-tagline">KENYA\'S GLOBAL MARKETPLACE</div>' +
          '<div id="splashHub">' + hub + '</div>' +
        '</div>' +
        '<div id="splashBar"><div id="splashBarFill"></div></div>' +
      '</div>'
    );
  }

  /* ── 2. Parse accent colour → RGB for particles ── */
  function hexRgb(h) {
    var r = /^#([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(h);
    return r ? [parseInt(r[1],16), parseInt(r[2],16), parseInt(r[3],16)] : [113,255,0];
  }
  var rgb = hexRgb(color);

  /* ── 3. initSplash — after DOMContentLoaded ── */
  function initSplash() {
    var splash = document.getElementById('splashScreen');
    if (!splash) return;

    splash.style.display    = 'flex';
    splash.style.opacity    = '1';
    splash.style.transition = 'none';

    /* Start progress bar */
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        var fill = document.getElementById('splashBarFill');
        if (fill) fill.style.width = '100%';
      });
    });

    /* Hide timers set FIRST — canvas errors below can never stop these */
    var _done = false;
    function hideSplash() {
      if (_done) return;
      _done = true;
      splash.style.pointerEvents = 'none';
      document.body.style.overflow = '';
      splash.style.transition = 'opacity 0.5s cubic-bezier(0.4,0,0.2,1)';
      splash.style.opacity    = '0';
      setTimeout(function () {
        splash.style.display = 'none';
        if (window._splashAnimId) cancelAnimationFrame(window._splashAnimId);
      }, 550);
    }
    setTimeout(hideSplash, MIN);       /* primary — 600 ms            */
    setTimeout(hideSplash, 3000);      /* hard failsafe — 3 s         */

    /* Particle canvas — in try/catch so any error never aborts initSplash */
    try {
      var canvas = document.getElementById('splashCanvas');
      if (canvas && canvas.getContext) {
        var ctx = canvas.getContext('2d');
        if (ctx) {
          canvas.width  = window.innerWidth;
          canvas.height = window.innerHeight;
          var pts = [];
          for (var i = 0; i < 90; i++) {
            pts.push({
              x:      Math.random() * canvas.width,
              y:      Math.random() * canvas.height,
              r:      Math.random() * 2.8 + 0.6,
              dx:     (Math.random() - 0.5) * 1.4,
              dy:     (Math.random() - 0.5) * 1.4,
              a:      Math.random() * 0.6 + 0.2,
              accent: Math.random() > 0.4
            });
          }
          var animId;
          function draw() {
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            pts.forEach(function (p) {
              ctx.beginPath();
              ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
              ctx.fillStyle = p.accent
                ? 'rgba(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ',' + p.a + ')'
                : 'rgba(255,255,255,' + (p.a * 0.25) + ')';
              ctx.fill();
              p.x += p.dx; p.y += p.dy;
              if (p.x < 0 || p.x > canvas.width)  p.dx *= -1;
              if (p.y < 0 || p.y > canvas.height)  p.dy *= -1;
            });
            animId = requestAnimationFrame(draw);
            window._splashAnimId = animId;
          }
          draw();
        }
      }
    } catch (e) {}
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initSplash);
  } else {
    initSplash();
  }
})();
