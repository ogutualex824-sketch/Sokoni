/**
 * nav-active.js — SOKONI Universal Nav Active State  v2.0
 * Automatically marks the correct bottom-nav item as active on every page.
 * Covers all 135 pages. Overrides any hardcoded active-bnav class in HTML.
 */
(function () {
  'use strict';

  /* Maps page filename → bottom-nav href to activate.
     Pages with no bottom-nav (admin tools, POS) default to 'profile.html'. */
  const NAV_MAP = {

    /* ── Home ─────────────────────────────────────────── */
    '':                       'index.html',
    'index.html':             'index.html',

    /* ── Shop / Marketplace ────────────────────────────── */
    'category.html':          'category.html',
    'product.html':           'category.html',
    'store.html':             'category.html',
    'wishlist.html':          'category.html',
    'cart.html':              'category.html',
    'checkout.html':          'category.html',
    'flashsale.html':         'category.html',
    'offer.html':             'category.html',
    'ministore.html':         'category.html',
    'unboxing.html':          'category.html',
    'seller-public.html':     'category.html',
    'search.html':            'category.html',
    'scan.html':              'category.html',
    'creative-studio.html':   'category.html',
    'business.html':          'category.html',
    'businesses.html':        'category.html',
    'b2b.html':               'category.html',
    'b2b-supplier.html':      'category.html',
    'b2b-rfq.html':           'category.html',
    'b2b-dashboard.html':     'category.html',
    'b2b-seller-dashboard.html':'category.html',
    'b2b-orders.html':        'category.html',
    'b2b-chat.html':          'category.html',

    /* ── Services ──────────────────────────────────────── */
    'services.html':           'services.html',
    'healthcare.html':         'services.html',
    'entertainment.html':      'services.html',
    'food.html':               'services.html',
    'food-menu.html':          'services.html',
    'cart.html':               'services.html',
    'food-order.html':         'services.html',
    'food-dashboard.html':     'services.html',
    'food-rider.html':         'services.html',
    'driver.html':             'services.html',
    'car-hub.html':            'services.html',
    'car-rental.html':         'services.html',
    'sports-hub.html':         'services.html',
    'sports-tournament.html':  'services.html',
    'sports-venue.html':       'services.html',
    'fitness-hub.html':        'services.html',
    'bnb.html':                'services.html',
    'bnb-hub.html':            'services.html',
    'bnb-manage.html':         'services.html',
    'property.html':           'services.html',
    'property-hub.html':       'services.html',
    'property-listing.html':   'services.html',
    'property-agent.html':     'services.html',
    'property-dashboard.html': 'services.html',
    'property-agent-dashboard.html':'services.html',
    'landlord.html':           'services.html',
    'legal-hub.html':          'services.html',
    'legal.html':              'services.html',
    'delivery.html':           'services.html',
    'delivery-tracking.html':  'services.html',
    'provider.html':           'services.html',
    'providers.html':          'services.html',
    'home-services.html':      'services.html',
    'cleaning.html':           'services.html',
    'electrical.html':         'services.html',
    'plumbing.html':           'services.html',
    'mechanics.html':          'services.html',
    'phone-repair.html':       'services.html',
    'construction.html':       'services.html',
    'digital.html':            'services.html',
    'tech-hub.html':           'services.html',
    'marketing.html':          'services.html',
    'marketing-hub.html':      'services.html',
    'banking.html':            'services.html',
    'jobs.html':               'services.html',
    'education.html':          'services.html',
    'ent-organizer.html':      'services.html',
    'life-events.html':        'services.html',
    'opportunity.html':        'services.html',

    /* ── Community ─────────────────────────────────────── */
    'community.html':          'community.html',
    'wap.html':                'community.html',

    /* ── Profile / Account ─────────────────────────────── */
    'profile.html':            'profile.html',
    'login.html':              'profile.html',
    'signup.html':             'profile.html',
    'register.html':           'profile.html',
    'onboarding.html':         'profile.html',
    'onboarding-seller.html':  'profile.html',
    'onboarding-driver.html':  'profile.html',
    'onboarding-professional.html':'profile.html',
    'track.html':              'profile.html',
    'messages.html':           'profile.html',
    'notifications.html':      'profile.html',
    'reviews.html':            'profile.html',
    'referral.html':           'profile.html',
    'loyalty.html':            'profile.html',
    'subscriptions.html':      'profile.html',
    'ai-subscriptions.html':   'profile.html',
    'dispute.html':            'profile.html',
    'invoice.html':            'profile.html',
    'success.html':            'profile.html',
    'driver-success.html':     'profile.html',
    'seller-success.html':     'profile.html',
    'join.html':               'profile.html',
    'support.html':            'profile.html',
    'help.html':               'profile.html',
    'trust.html':              'profile.html',
    'verification.html':       'profile.html',
    'wallet.html':             'profile.html',
    'payments.html':           'profile.html',
    'revenue.html':            'profile.html',
    'seller-revenue.html':     'profile.html',
    'requests.html':           'profile.html',

    /* ── Seller / Vendor Tools ─────────────────────────── */
    'seller.html':                  'profile.html',
    'seller-analytics.html':        'profile.html',
    'business-analytics.html':      'profile.html',
    'customer-analytics.html':      'profile.html',
    'growth-dashboard.html':        'profile.html',
    'inventory.html':               'profile.html',
    'inv-dashboard.html':           'profile.html',
    'inv-products.html':            'profile.html',
    'inv-product.html':             'profile.html',

    /* ── SmartPOS ──────────────────────────────────────── */
    'pos.html':                'profile.html',
    'pos-kiosk.html':          'profile.html',

    /* ── Admin / Super Admin / Platform Tools ──────────── */
    'admin.html':              'profile.html',
    'superadmin.html':         'profile.html',
    'admin-subscriptions.html':'profile.html',
    'subscription-os.html':    'profile.html',
    'gip.html':                'profile.html',
    'monitor.html':            'profile.html',
    'moderation.html':         'profile.html',
    'email-center.html':       'profile.html',
    'verification-admin.html': 'profile.html',
    'launch-metrics.html':     'profile.html',
    'beta.html':               'profile.html',
    'beta-dashboard.html':     'profile.html',
    'business-os.html':        'profile.html',

    /* ── Misc / Informational ──────────────────────────── */
    'inspiq.html':             'category.html',
    'ride-book.html':          'services.html',
    'test-accounts.html':      'profile.html',
  };

  function applyActiveNav() {
    const page   = (location.pathname.split('/').pop() || '').replace(/\?.*$/, '') || 'index.html';
    const target = NAV_MAP[page] || NAV_MAP[page + '.html'];  /* cleanUrls: prod serves extension-free, so also try the .html key */
    if (!target) return;

    const items = document.querySelectorAll('.bottom-nav .bnav-item, .bottom-nav a');
    if (!items.length) return;

    items.forEach(function (a) {
      a.classList.remove('active-bnav');
      let href = (a.getAttribute('href') || '').replace(/\?.*$/, '');
      /* The canonical homepage is "/", but NAV_MAP keys it as "index.html". Without
         this the Home tab stops highlighting the moment its href is canonicalised —
         a silent regression, since nothing errors: the tab simply never lights up. */
      if (href === '/' || href === '') href = 'index.html';
      if (href === target || href.endsWith('/' + target)) {
        a.classList.add('active-bnav');
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', applyActiveNav);
  } else {
    applyActiveNav();
  }

})();
