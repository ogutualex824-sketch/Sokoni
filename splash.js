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
    '.spl-inner{display:flex;flex-direction:column;align-items:center;gap:26px;text-align:center;' +
    'position:relative;padding:0 24px}' +

    /* ── THE LOGO ─────────────────────────────────────────────────────────────
       sokoni-wordmark.svg is a pure vector asset (viewBox 0 0 170 56):
       bag icon + "SOKONI" text as SVG elements. Because it is SVG, the letterforms
       are always 100% opaque — no alpha-channel fading, no colour-inversion
       artefacts from PNG processing. Sizing by WIDTH preserves the 170:56 aspect
       at every screen size without any max-width override surprises. */
    '.spl-logo{width:min(78vw,320px);height:auto;max-width:none!important;display:block;' +
    'background:none;border:0;position:relative;z-index:2;' +
    'animation:splIn .9s cubic-bezier(.19,1.32,.34,1) both}' +

    /* The mark carries its own soft green light — a lift, not a neon sign.
       overflow:hidden is REQUIRED: the sheen below starts at translateX(-130%), so
       without clipping it parks outside the wrapper as a visible grey slab beside the
       logo. (It did exactly that — caught in the first render.) */
    '.spl-mark{position:relative;display:flex;align-items:center;justify-content:center;' +
    'overflow:hidden;padding:7% 5%;border-radius:20px;' +
    'animation:splLift 4.6s ease-in-out 1s infinite}' +

    /* A single, slow light sweep across the mark. One pass every 4.4s: enough to feel
       alive, not so much that it performs. This is the whole "entertainment" budget. */
    '.spl-mark::after{content:"";position:absolute;inset:0;z-index:3;' +
    'pointer-events:none;' +
    'background:linear-gradient(105deg,transparent 40%,rgba(255,255,255,.10) 48%,' +
    'rgba(190,255,140,.13) 52%,transparent 60%);' +
    'transform:translateX(-120%);' +
    'animation:splSheen 4.4s cubic-bezier(.5,0,.3,1) 1.5s infinite}' +

    /* Soft halo behind the mark — sits BEHIND (z-index 1), so it lifts the logo off
       the background instead of washing over it. */
    '.spl-mark::before{content:"";position:absolute;width:74%;height:74%;z-index:1;' +
    'border-radius:50%;pointer-events:none;' +
    'background:radial-gradient(circle,rgba(113,255,0,.20),rgba(113,255,0,.05) 45%,transparent 70%);' +
    'filter:blur(26px);animation:splHalo 4.6s ease-in-out 1s infinite}' +

    /* Per-page tagline */
    '.spl-line{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;' +
    'font-size:clamp(10px,2.6vw,12px);font-weight:700;letter-spacing:.2em;' +
    'text-transform:uppercase;color:rgba(255,255,255,.42);' +
    'animation:splFade .6s .5s cubic-bezier(.4,0,.2,1) both}' +

    /* A single hairline that fills once — calmer and more "premium fintech" than
       three bouncing dots, and it reads as progress rather than decoration. */
    '.spl-dots{position:relative;width:clamp(88px,26vw,132px);height:2px;border-radius:2px;' +
    'background:rgba(255,255,255,.08);overflow:hidden;margin-top:2px;' +
    'animation:splFade .5s .62s cubic-bezier(.4,0,.2,1) both}' +
    '.spl-dots span{position:absolute;inset:0;display:block;border-radius:2px;' +
    'background:linear-gradient(90deg,rgba(113,255,0,0),#71ff00 55%,#a6ff5c);' +
    'transform:translateX(-100%);' +
    'animation:splBar 1.5s cubic-bezier(.65,0,.35,1) .7s infinite}' +
    '.spl-dots span:nth-child(2),.spl-dots span:nth-child(3){display:none}' +

    /* Keyframes */
    '@keyframes splIn{' +
    'from{opacity:0;transform:scale(.86) translateY(14px);filter:blur(6px)}' +
    'to{opacity:1;transform:scale(1) translateY(0);filter:blur(0)}}' +
    '@keyframes splFade{' +
    'from{opacity:0;transform:translateY(8px)}' +
    'to{opacity:1;transform:translateY(0)}}' +
    /* Breathe: a 1.5% scale. Any more and it looks like it is throbbing. */
    '@keyframes splLift{0%,100%{transform:scale(1)}50%{transform:scale(1.015)}}' +
    '@keyframes splHalo{0%,100%{opacity:.55}50%{opacity:1}}' +
    '@keyframes splSheen{' +
    '0%{transform:translateX(-120%)}' +
    '58%,100%{transform:translateX(120%)}}' +
    '@keyframes splBar{' +
    '0%{transform:translateX(-100%)}' +
    '55%{transform:translateX(0)}' +
    '100%{transform:translateX(100%)}}' +

    /* Respect the OS setting: no sheen, no breathing, no sweep. */
    '@media(prefers-reduced-motion:reduce){' +
    '.spl-logo,.spl-mark,.spl-mark::before,.spl-mark::after,' +
    '.spl-line,.spl-dots,.spl-dots span{animation:none!important;transform:none!important}' +
    '.spl-logo{opacity:1}}';

  (document.head || document.documentElement).appendChild(_s);

  /* ── Build overlay ────────────────────────────────────────────────────── */
  var _el = document.createElement('div');
  _el.id = 'sk-spl';
  _el.setAttribute('aria-hidden', 'true');
  /* SVG wordmark: bag icon + SOKONI text, pure vector — never fades at any
     display density. No PNG opacity issues. */
  _el.innerHTML =
    '<div class="spl-inner">' +
    '<div class="spl-mark">' +
      '<img class="spl-logo" src="assets/sokoni-wordmark.svg" alt="SOKONI">' +
    '</div>' +
    '<div class="spl-line">' + _line + '</div>' +
    '<div class="spl-dots"><span></span></div>' +
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
