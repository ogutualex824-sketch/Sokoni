/**
 * SOKONI Splash — Unified Global Splash System v2.0
 *
 * Single source of truth for every page's entrance animation.
 * Set window.SokoniSplash = true as a singleton guard so shared-header.js
 * and any other system skips creating a second overlay.
 *
 * Opt-out:  <html data-no-splash="true">
 * No iframes: bails if window.self !== window.top
 */
(function () {
  'use strict';

  /* ── Singleton guard ──────────────────────────────────────────────────── */
  if (window.SokoniSplash) return;
  if (window.self !== window.top) return;
  if (document.documentElement.dataset.noSplash === 'true') return;

  window.SokoniSplash = true;

  /* ── Page detection ───────────────────────────────────────────────────── */
  var _raw = location.pathname.split('/').pop() || '';
  var _pg  = (_raw.split('?')[0].split('#')[0] || 'index.html').toLowerCase();

  /* ── Per-page taglines ────────────────────────────────────────────────── */
  var _T = {
    /* Core */
    'index.html':               "Kenya's Digital Marketplace",
    'search.html':              'Find Anything, Instantly',
    'cart.html':                'Your Cart Awaits',
    'checkout.html':            'Secure Checkout',
    'profile.html':             'Your SOKONI Account',
    'wishlist.html':            'Things You Love',
    'invoice.html':             'Your Receipt',
    'offer.html':               'Exclusive Offer — Just for You',
    'flashsale.html':           'Flash Sale · Grab It Now',
    'success.html':             'Order Confirmed — Thank You!',
    /* Auth */
    'login.html':               'Welcome Back',
    'signup.html':              'Join SOKONI Today',
    'register.html':            'Create Your Account',
    'join.html':                'Join the Movement',
    /* Marketplace */
    'marketplace.html':         'Thousands of Sellers. One Home.',
    'category.html':            'Browse Every Category',
    'product.html':             'Premium Product Showcase',
    'auction.html':             'Bid Smart. Win Big.',
    'rental.html':              'Rent Anything, Anytime.',
    'digital-store.html':       'Download the Future.',
    'digital.html':             'Digital Products Hub.',
    /* Finance */
    'wallet.html':              'Your Digital Wallet',
    'loyalty.html':             'Earn. Redeem. Repeat.',
    'subscriptions.html':       'SOKONI Premium — Unlock Everything',
    'referral.html':            'Refer & Earn · Share & Win',
    'banking.html':             'Financial Freedom. Simplified.',
    'finos.html':               'Enterprise Finance OS.',
    'invoice.html':             'Invoice — Your Receipt',
    'expense-management.html':  'Expenses Under Control',
    'general-ledger.html':      'Books Always Balanced.',
    /* Seller & Merchant */
    'seller.html':              'Your Business Dashboard',
    'seller-success.html':      'Success Starts Here',
    'merchant-success.html':    'Built to Help You Grow',
    'minishop.html':            'Your Shop, Your Brand.',
    'business.html':            'Your Business, Amplified.',
    'businesses.html':          'Businesses Hub.',
    'digital-esoko.html':       'Digital Commerce Hub.',
    'digital-esoko-seller.html':'Digital Seller Dashboard.',
    /* Services */
    'services.html':            'Every Service, One Place.',
    'cleaning.html':            'Cleaning & Laundry Hub',
    'electrical.html':          'Electrical Services',
    'home-services.html':       'Home Services Near You',
    'construction.html':        'Build Something Lasting.',
    'fitness-hub.html':         'Fitness Hub · Move & Thrive',
    /* Transport */
    'driver.html':              'Delivering Joy, Every Day.',
    'rider-nav.html':           'Navigate. Deliver. Earn.',
    'car-rental.html':          'Drive on Demand.',
    'car-hub.html':             'Car Hub · Drive Kenya Forward',
    'delivery.html':            'Last-Mile, Every Time.',
    'track.html':               'Your Order, Every Step.',
    'dispatch.html':            'Logistics Intelligence.',
    'delivery-tracking.html':   'Your Order, Every Step.',
    /* Property */
    'property.html':            'Find Your Space.',
    'bnb.html':                 'Stay Anywhere in Kenya.',
    'bnb-hub.html':             'Stay Hub · Hotels & BnBs',
    'bnb-manage.html':          'Host Dashboard · Manage Your BnB',
    'landlord.html':            'Landlord Portal · Rent & Manage',
    /* Community & Social */
    'events.html':              'Life Is Better Live.',
    'event-hub.html':           "Discover What's Happening",
    'event-manager.html':       'Manage Your Events.',
    'messages.html':            'Your Conversations. Secured.',
    'community.html':           'Together, We Thrive.',
    'reviews.html':             'Your Voice Matters.',
    'notifications.html':       'Stay in the Loop.',
    /* People */
    'jobs.html':                'Find Your Next Opportunity.',
    'job-post.html':            'Post a Job. Find Talent.',
    'healthcare.html':          'Health, Closer to Home.',
    'education.html':           'Learn Without Limits.',
    'entertainment.html':       'Your Next Favourite Thing.',
    /* B2B */
    'b2b.html':                 'Enterprise Commerce Made Easy.',
    'b2b-chat.html':            'B2B Chat · Negotiate & Close Deals',
    'b2b-dashboard.html':       'B2B Dashboard · Your Wholesale Hub',
    'b2b-orders.html':          'B2B Orders · Wholesale Management',
    'b2b-rfq.html':             'B2B RFQ · Request for Quotation',
    'b2b-seller-dashboard.html':'B2B Seller · Manage Wholesale',
    'b2b-supplier.html':        'B2B Supplier Portal',
    /* SmartPOS */
    'pos.html':                 'Point of Sale. Powered by AI.',
    'pos-checkout.html':        'Fast Checkout. Every Time.',
    'pos-daily.html':           'Start Strong. Close Stronger.',
    'pos-observability.html':   'Real-Time Store Intelligence',
    'pos-marketplace.html':     'Your Store Meets the Marketplace',
    'kitchen-display.html':     'Kitchen Display System.',
    'customer-display.html':    'Customer Display.',
    /* Admin */
    'admin.html':               'Platform Admin.',
    'admin-os.html':            'Platform Command Centre.',
    'super-admin.html':         'Superadmin Dashboard.',
    'automation-center.html':   'Intelligence. Automated.',
    'security-center.html':     'Zero Trust. Total Control.',
    'beta-dashboard.html':      'Beta Command Centre.',
    'beta.html':                'Beta Programme.',
    /* Analytics */
    'analytics.html':           'Insights That Drive Growth',
    'business-analytics.html':  'Business Intelligence.',
    'customer-analytics.html':  'Customer Insights.',
    'growth-dashboard.html':    'Growth at a Glance.',
    'launch-metrics.html':      'Launch Metrics.',
    'business-health.html':     'Business Health Score.',
    /* Legal & Trust */
    'trust-and-safety.html':    'Safe. Fair. Trusted.',
    'help.html':                "We're Here to Help.",
    'terms.html':               'Terms of Service',
    'privacy.html':             'Privacy Policy',
    'data-deletion.html':       'Your Data, Your Rights.',
    'community-guidelines.html':'Community Standards',
    'cookie-policy.html':       'Cookie Policy',
    'legal.html':               'Legal Hub.',
    'legal-hub.html':           'Legal Hub · Lawyers & Contracts',
    'legal-centre.html':        'Legal Resource Centre.',
    'dispute.html':             "We've Got You Covered.",
    'dispute-portal.html':      'Dispute Resolution Portal.',
    'faq.html':                 'Frequently Asked Questions.',
    /* Company */
    'about.html':               "Kenya's Digital Backbone.",
    'careers.html':             'Build the Future With Us.',
    'contact.html':             "We'd Love to Hear From You.",
    'foundation.html':          'Impact Beyond Commerce.',
    'franchise.html':           'Grow With SOKONI.',
    'gip.html':                 'Geo Intelligence Platform.',
    'inspiq.html':              'Insights That Inspire.',
    /* Hubs */
    'food.html':                "Hungry? We've Got You.",
    'food-menu.html':           'Order Something Delicious.',
    'food-order.html':          'Your Order Is Coming.',
    'food-dashboard.html':      'Food Business Command Centre.',
    'food-rider.html':          'Rider Hub · Deliver & Earn.',
    'ent-organizer.html':       'Organize Events With Power.',
    'healthcare.html':          'Health, Closer to Home.',
    'hr-payroll.html':          'HR & Payroll. Simplified.',
    'jobs.html':                'Find Your Next Opportunity.',
    /* Payment & Operations */
    'payment-failed.html':      'Payment Support.',
    'commission-admin.html':    'Commission Engine.',
    'etims-admin.html':         'eTIMS Administration.',
    'etims-seller.html':        'eTIMS Seller Portal.',
    'finos-admin.html':         'FinOS Administration.',
    'fos-admin.html':           'FOS Administration.',
    'dispatch.html':            'Logistics Intelligence.',
    'business-os.html':         'Business Operating System.',
  };

  var _line = _T[_pg] || 'One Platform. Endless Possibilities.';

  /* ── Inline SVG basket icon (no "SOKONI" text) ────────────────────────── */
  var ICON =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 80" fill="none" aria-hidden="true" focusable="false">' +
    '<defs>' +
    '<linearGradient id="sk-spl-g" x1="0" y1="0" x2="0" y2="1">' +
    '<stop offset="0%" stop-color="#71ff00"/>' +
    '<stop offset="100%" stop-color="#237000"/>' +
    '</linearGradient>' +
    '<clipPath id="sk-spl-c">' +
    '<rect x="10" y="29" width="60" height="43" rx="7" fill="white"/>' +
    '</clipPath>' +
    '</defs>' +
    '<rect x="10" y="29" width="60" height="43" rx="7" fill="url(#sk-spl-g)"/>' +
    '<g clip-path="url(#sk-spl-c)" stroke="white" stroke-opacity=".2" stroke-width="1.2">' +
    '<line x1="30" y1="29" x2="30" y2="72"/>' +
    '<line x1="50" y1="29" x2="50" y2="72"/>' +
    '<line x1="10" y1="43" x2="70" y2="43"/>' +
    '<line x1="10" y1="57" x2="70" y2="57"/>' +
    '</g>' +
    '<rect x="10" y="29" width="60" height="15" fill="white" fill-opacity=".1" clip-path="url(#sk-spl-c)"/>' +
    '<path d="M22,30 C22,10 58,10 58,30" stroke="#184d00" stroke-width="5.5" stroke-linecap="round"/>' +
    '<circle cx="22" cy="30" r="3.5" fill="#fbbf24"/>' +
    '<circle cx="58" cy="30" r="3.5" fill="#fbbf24"/>' +
    '<path d="M14,67 Q40,78 66,67" stroke="#f97316" stroke-width="3" stroke-linecap="round"/>' +
    '</svg>';

  /* ── Inject CSS synchronously (ensures dark bg before body renders) ──── */
  var _s = document.createElement('style');
  _s.id = 'sk-spl-css';
  _s.textContent =
    /* Prevent white flash while body hasn't painted yet */
    'html,body{background:#050505}' +
    '#sk-spl{position:fixed;inset:0;z-index:2147483647;' +
    'background:radial-gradient(ellipse 90% 80% at 50% 44%,#0e1a06 0%,#0a0a0a 58%,#050505 100%);' +
    'display:flex;align-items:center;justify-content:center;' +
    'will-change:opacity,transform}' +
    '#sk-spl.spl-out{opacity:0!important;transform:scale(1.04)!important;' +
    'transition:opacity .55s cubic-bezier(.4,0,.2,1),transform .55s cubic-bezier(.4,0,.2,1)!important;' +
    'pointer-events:none}' +
    '.spl-inner{display:flex;flex-direction:column;align-items:center;gap:14px;text-align:center}' +
    /* Icon: spring-bounce entry + breathing glow pulse */
    '.spl-icon{width:clamp(64px,18vw,84px);height:clamp(64px,18vw,84px);display:block;' +
    'animation:splIn .72s cubic-bezier(.22,1.6,.36,1) both,' +
    'splGlow 3.2s ease-in-out .9s infinite}' +
    '.spl-icon svg{width:100%;height:100%;display:block}' +
    /* Wordmark typography */
    '.spl-word{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;' +
    'font-size:clamp(26px,7.5vw,38px);font-weight:900;letter-spacing:.03em;color:#fff;line-height:1;' +
    'animation:splIn .72s cubic-bezier(.22,1.6,.36,1) .06s both}' +
    '.spl-word em{font-style:normal;color:#71ff00}' +
    /* Per-page tagline */
    '.spl-line{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;' +
    'font-size:clamp(9px,2.4vw,11px);font-weight:700;letter-spacing:.16em;' +
    'text-transform:uppercase;color:rgba(255,255,255,.38);' +
    'animation:splFade .5s .22s cubic-bezier(.4,0,.2,1) both}' +
    /* Three-dot pulsing loader */
    '.spl-dots{display:flex;align-items:center;gap:7px;margin-top:6px;' +
    'animation:splFade .4s .32s cubic-bezier(.4,0,.2,1) both}' +
    '.spl-dots span{width:6px;height:6px;border-radius:50%;background:#71ff00;display:block;' +
    'animation:splDot 1.4s ease-in-out infinite}' +
    '.spl-dots span:nth-child(2){animation-delay:.2s}' +
    '.spl-dots span:nth-child(3){animation-delay:.4s}' +
    /* Keyframes */
    '@keyframes splIn{' +
    'from{opacity:0;transform:scale(.72) translateY(10px)}' +
    'to{opacity:1;transform:scale(1) translateY(0)}}' +
    '@keyframes splFade{' +
    'from{opacity:0;transform:translateY(8px)}' +
    'to{opacity:1;transform:translateY(0)}}' +
    '@keyframes splGlow{' +
    '0%,100%{filter:drop-shadow(0 0 8px rgba(113,255,0,.3)) drop-shadow(0 0 18px rgba(113,255,0,.12))}' +
    '50%{filter:drop-shadow(0 0 22px rgba(113,255,0,.56)) drop-shadow(0 0 42px rgba(113,255,0,.26))}}' +
    '@keyframes splDot{' +
    '0%,80%,100%{opacity:.22;transform:scale(.72)}' +
    '40%{opacity:1;transform:scale(1.05)}}';

  (document.head || document.documentElement).appendChild(_s);

  /* ── Build overlay ────────────────────────────────────────────────────── */
  var _el = document.createElement('div');
  _el.id = 'sk-spl';
  _el.setAttribute('aria-hidden', 'true');
  _el.innerHTML =
    '<div class="spl-inner">' +
    '<div class="spl-icon">' + ICON + '</div>' +
    '<div class="spl-word">SOKO<em>NI</em></div>' +
    '<div class="spl-line">' + _line + '</div>' +
    '<div class="spl-dots"><span></span><span></span><span></span></div>' +
    '</div>';

  /* ── Mount (body may not exist yet when run from <head>) ──────────────── */
  function _mount() {
    var t = document.body || document.documentElement;
    t.insertBefore(_el, t.firstChild);
  }
  if (document.body) { _mount(); }
  else { document.addEventListener('DOMContentLoaded', _mount, { once: true }); }

  /* ── Dismiss ──────────────────────────────────────────────────────────── */
  var _MIN   = 1900;
  var _start = Date.now();

  function _dismiss() {
    var remaining = Math.max(0, _MIN - (Date.now() - _start));
    setTimeout(function () {
      _el.classList.add('spl-out');
      setTimeout(function () {
        if (_el.parentNode) _el.parentNode.removeChild(_el);
        if (_s.parentNode)  _s.parentNode.removeChild(_s);
      }, 600);
    }, remaining);
  }

  /* Hard failsafe — dismiss after 4 s regardless of page load state */
  var _failsafe = setTimeout(function () { if (_el.parentNode) _dismiss(); }, 4000);

  if (document.readyState === 'complete') {
    clearTimeout(_failsafe);
    _dismiss();
  } else {
    window.addEventListener('load', function () {
      clearTimeout(_failsafe);
      _dismiss();
    }, { once: true });
  }
}());
