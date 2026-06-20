/**
 * nav-active.js — SOKONI Universal Nav Active State
 * Automatically marks the correct bottom-nav item as active
 * on every page, based on the current URL. Overrides any
 * incorrect active-bnav classes set in HTML.
 */
(function () {
  'use strict';

  /* Which bottom-nav href to activate per page */
  const NAV_MAP = {
    /* ── Home ── */
    'index.html': 'index.html',
    '':           'index.html',

    /* ── Shop ── */
    'category.html':    'category.html',
    'product.html':     'category.html',
    'store.html':       'category.html',
    'wishlist.html':    'category.html',
    'cart.html':        'category.html',
    'checkout.html':    'category.html',
    'inspiq.html':      'category.html',
    'b2b.html':         'category.html',
    'offer.html':       'category.html',
    'ministore.html':   'category.html',
    'unboxing.html':    'category.html',
    'seller-public.html':'category.html',
    'flashsale.html':   'flashsale.html',

    /* ── Services ── */
    'services.html':      'services.html',
    'healthcare.html':    'services.html',
    'entertainment.html': 'services.html',
    'food.html':          'services.html',
    'driver.html':        'services.html',
    'car-hub.html':       'services.html',
    'car-rental.html':    'services.html',
    'sports-hub.html':    'services.html',
    'bnb.html':           'services.html',
    'bnb-manage.html':    'services.html',
    'property.html':      'services.html',
    'landlord.html':      'services.html',
    'legal-hub.html':     'services.html',
    'legal.html':         'services.html',
    'delivery.html':      'services.html',
    'provider.html':      'services.html',
    'cleaning.html':      'services.html',
    'electrical.html':    'services.html',
    'plumbing.html':      'services.html',
    'mechanics.html':     'services.html',
    'phone-repair.html':  'services.html',
    'construction.html':  'services.html',
    'digital.html':       'services.html',
    'marketing.html':     'services.html',
    'banking.html':       'services.html',

    /* ── Requests ── */
    'requests.html': 'requests.html',

    /* ── Community ── */
    'community.html': 'community.html',

    /* ── Hub pages with custom navs (self-referential) ── */
    'home-services.html':  'home-services.html',
    'fitness-hub.html':    'fitness-hub.html',
    'sports-hub.html':     'sports-hub.html',
    'opportunity.html':    'opportunity.html',
    'wallet.html':         'wallet.html',
    'business-os.html':    'business-os.html',
    'trust.html':          'trust.html',
    'life-events.html':    'life-events.html',
    'inspiq.html':         'inspiq.html',
    'providers.html':      'providers.html',
    'notifications.html':  'profile.html',
    'foundation.html':     'foundation.html',

    /* ── Profile / Account ── */
    'profile.html':       'profile.html',
    'track.html':         'profile.html',
    'messages.html':      'profile.html',
    'reviews.html':       'profile.html',
    'referral.html':      'profile.html',
    'loyalty.html':       'profile.html',
    'subscriptions.html': 'profile.html',
    'seller.html':        'profile.html',
    'dispute.html':       'profile.html',
    'invoice.html':       'profile.html',
    'signup.html':        'profile.html',
    'login.html':         'profile.html',
    'register.html':      'profile.html',
    'success.html':       'profile.html',
  };

  function applyActiveNav() {
    const page   = (location.pathname.split('/').pop() || '').replace(/\?.*$/, '') || 'index.html';
    const target = NAV_MAP[page];
    if (!target) return;

    const items = document.querySelectorAll('.bottom-nav .bnav-item, .bottom-nav a');
    if (!items.length) return;

    items.forEach(function (a) {
      a.classList.remove('active-bnav');
      const href = (a.getAttribute('href') || '').replace(/\?.*$/, '');
      if (href === target) a.classList.add('active-bnav');
    });
  }

  /* Run immediately if DOM ready, else wait */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', applyActiveNav);
  } else {
    applyActiveNav();
  }

})();
