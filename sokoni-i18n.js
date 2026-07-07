// sokoni-i18n.js — Lightweight i18n framework for SOKONI
// Usage: add <script src="sokoni-i18n.js"></script> to any page
// Then call SokoniI18n.init() after DOMContentLoaded
// Add data-i18n="key" attributes to translatable elements
// Add data-i18n-placeholder="key" for input placeholders
// Add data-i18n-title="key" for title attributes
// Use SokoniI18n.t('key', { name: 'Alex' }) for JS-side translations with interpolation
//
// Supported languages: en (English), sw (Swahili — Kenya dialect)
// Language preference persisted in localStorage key: sokoni_lang
// No Firebase, no external dependencies — pure JS, zero runtime weight

(function (window) {
  'use strict';

  // ── Constants ──────────────────────────────────────────────────────
  var STORAGE_KEY  = 'sokoni_lang';
  var DEFAULT_LANG = 'en';
  var SUPPORTED    = ['en', 'sw'];

  // ── Translation dictionary ─────────────────────────────────────────
  var TRANSLATIONS = {

    en: {
      // ── Navigation ──────────────────────────────────────────────
      'nav.home':    'Home',
      'nav.shop':    'Shop',
      'nav.cart':    'Cart',
      'nav.orders':  'Orders',
      'nav.profile': 'Profile',
      'nav.logout':  'Logout',
      'nav.search':  'Search',

      // ── Common actions ───────────────────────────────────────────
      'common.loading': 'Loading…',
      'common.error':   'An error occurred',
      'common.save':    'Save',
      'common.cancel':  'Cancel',
      'common.confirm': 'Confirm',
      'common.delete':  'Delete',
      'common.edit':    'Edit',
      'common.back':    'Back',
      'common.next':    'Next',
      'common.submit':  'Submit',
      'common.close':   'Close',

      // ── Product ──────────────────────────────────────────────────
      'product.addToCart':   'Add to Cart',
      'product.buyNow':      'Buy Now',
      'product.outOfStock':  'Out of Stock',
      'product.price':       'Price',
      'product.quantity':    'Quantity',
      'product.description': 'Description',
      'product.reviews':     'Reviews',

      // ── Cart ─────────────────────────────────────────────────────
      'cart.empty':    'Your cart is empty',
      'cart.checkout': 'Checkout',
      'cart.total':    'Total',
      'cart.remove':   'Remove',

      // ── Orders ───────────────────────────────────────────────────
      'order.placed':    'Order Placed',
      'order.confirmed': 'Confirmed',
      'order.shipped':   'Shipped',
      'order.delivered': 'Delivered',
      'order.cancelled': 'Cancelled',
      'order.tracking':  'Track Order',

      // ── Auth ─────────────────────────────────────────────────────
      'auth.login':           'Log In',
      'auth.logout':          'Log Out',
      'auth.register':        'Register',
      'auth.email':           'Email',
      'auth.password':        'Password',
      'auth.forgotPassword':  'Forgot Password?',
      'auth.createAccount':   'Create Account',

      // ── Payments ─────────────────────────────────────────────────
      'payment.mpesa':      'M-Pesa',
      'payment.card':       'Card',
      'payment.pay':        'Pay',
      'payment.processing': 'Processing…',
      'payment.success':    'Payment Successful',
      'payment.failed':     'Payment Failed',
      'payment.amount':     'Amount',

      // ── Seller ───────────────────────────────────────────────────
      'seller.dashboard':  'Dashboard',
      'seller.products':   'Products',
      'seller.orders':     'Orders',
      'seller.earnings':   'Earnings',
      'seller.addProduct': 'Add Product',
    },

    sw: {
      // ── Navigation ──────────────────────────────────────────────
      // Nyumbani = home/homestead; Duka = shop/store; Kikapu = basket/cart
      // Maagizo = orders/instructions; Wasifu = profile; Toka = exit/logout
      // Tafuta = search/look for
      'nav.home':    'Nyumbani',
      'nav.shop':    'Duka',
      'nav.cart':    'Kikapu',
      'nav.orders':  'Maagizo',
      'nav.profile': 'Wasifu',
      'nav.logout':  'Toka',
      'nav.search':  'Tafuta',

      // ── Common actions ───────────────────────────────────────────
      // Inapakia = it is loading; Hitilafu imetokea = an error has occurred
      // Hifadhi = save/store; Ghairi = cancel/revoke; Thibitisha = confirm/verify
      // Futa = delete/erase; Hariri = edit; Rudi = go back
      // Inayofuata = the next one; Wasilisha = submit/deliver; Funga = close/shut
      'common.loading': 'Inapakia…',
      'common.error':   'Hitilafu imetokea',
      'common.save':    'Hifadhi',
      'common.cancel':  'Ghairi',
      'common.confirm': 'Thibitisha',
      'common.delete':  'Futa',
      'common.edit':    'Hariri',
      'common.back':    'Rudi',
      'common.next':    'Inayofuata',
      'common.submit':  'Wasilisha',
      'common.close':   'Funga',

      // ── Product ──────────────────────────────────────────────────
      // Ongeza kwenye Kikapu = add to cart; Nunua Sasa = buy now
      // Haipatikani = not available; Bei = price; Kiasi = quantity/amount
      // Maelezo = description/details; Maoni = opinions/reviews
      'product.addToCart':   'Ongeza kwenye Kikapu',
      'product.buyNow':      'Nunua Sasa',
      'product.outOfStock':  'Haipatikani',
      'product.price':       'Bei',
      'product.quantity':    'Kiasi',
      'product.description': 'Maelezo',
      'product.reviews':     'Maoni',

      // ── Cart ─────────────────────────────────────────────────────
      // Kikapu chako kiko tupu = your cart is empty
      // Maliza Ununuzi = complete purchase/checkout; Jumla = total/sum
      // Ondoa = remove/take out
      'cart.empty':    'Kikapu chako kiko tupu',
      'cart.checkout': 'Maliza Ununuzi',
      'cart.total':    'Jumla',
      'cart.remove':   'Ondoa',

      // ── Orders ───────────────────────────────────────────────────
      // Agizo Limetumwa = order has been sent; Imethibitishwa = has been confirmed
      // Imepelekwa = has been dispatched/shipped; Imefikia = has arrived/delivered
      // Imeghairiwa = has been cancelled; Fuatilia Agizo = track the order
      'order.placed':    'Agizo Limetumwa',
      'order.confirmed': 'Imethibitishwa',
      'order.shipped':   'Imepelekwa',
      'order.delivered': 'Imefikia',
      'order.cancelled': 'Imeghairiwa',
      'order.tracking':  'Fuatilia Agizo',

      // ── Auth ─────────────────────────────────────────────────────
      // Ingia = enter/log in; Toka = exit/log out; Jisajili = register yourself
      // Barua Pepe = email (lit. electronic letter); Nywila = password (lit. key-word)
      // Umesahau Nywila? = have you forgotten your password?
      // Fungua Akaunti = open an account
      'auth.login':          'Ingia',
      'auth.logout':         'Toka',
      'auth.register':       'Jisajili',
      'auth.email':          'Barua Pepe',
      'auth.password':       'Nywila',
      'auth.forgotPassword': 'Umesahau Nywila?',
      'auth.createAccount':  'Fungua Akaunti',

      // ── Payments ─────────────────────────────────────────────────
      // Kadi = card; Lipa = pay; Inashughulikia = it is processing
      // Malipo Yamefanikiwa = payment succeeded; Malipo Yameshindwa = payment failed
      // Kiasi = amount
      'payment.mpesa':      'M-Pesa',
      'payment.card':       'Kadi',
      'payment.pay':        'Lipa',
      'payment.processing': 'Inashughulikia…',
      'payment.success':    'Malipo Yamefanikiwa',
      'payment.failed':     'Malipo Yameshindwa',
      'payment.amount':     'Kiasi',

      // ── Seller ───────────────────────────────────────────────────
      // Dashibodi = dashboard (loanword); Bidhaa = goods/products
      // Maagizo = orders; Mapato = income/earnings
      // Ongeza Bidhaa = add product/goods
      'seller.dashboard':  'Dashibodi',
      'seller.products':   'Bidhaa',
      'seller.orders':     'Maagizo',
      'seller.earnings':   'Mapato',
      'seller.addProduct': 'Ongeza Bidhaa',
    },
  };

  // ── State ──────────────────────────────────────────────────────────
  var _lang = DEFAULT_LANG;

  // ── getLang ────────────────────────────────────────────────────────
  function getLang() {
    return _lang;
  }

  // ── t(key, params) — translate key with optional interpolation ─────
  // Falls back to English if the key is missing in the active language.
  // Interpolation: "Hello {{name}}" + { name: 'Alex' } → "Hello Alex"
  function t(key, params) {
    var dict     = TRANSLATIONS[_lang] || {};
    var fallback = TRANSLATIONS[DEFAULT_LANG] || {};
    var str = (dict[key] !== undefined) ? dict[key]
            : (fallback[key] !== undefined) ? fallback[key]
            : key; // last resort: return the key itself

    if (params && typeof params === 'object') {
      str = str.replace(/\{\{(\w+)\}\}/g, function (_, k) {
        return (params[k] !== undefined) ? String(params[k]) : '{{' + k + '}}';
      });
    }
    return str;
  }

  // ── translatePage — apply translations to all data-i18n elements ───
  function translatePage() {
    // textContent replacement
    var els = document.querySelectorAll('[data-i18n]');
    for (var i = 0; i < els.length; i++) {
      els[i].textContent = t(els[i].getAttribute('data-i18n'));
    }
    // placeholder attribute
    var phEls = document.querySelectorAll('[data-i18n-placeholder]');
    for (var j = 0; j < phEls.length; j++) {
      phEls[j].placeholder = t(phEls[j].getAttribute('data-i18n-placeholder'));
    }
    // title attribute
    var ttEls = document.querySelectorAll('[data-i18n-title]');
    for (var k = 0; k < ttEls.length; k++) {
      ttEls[k].title = t(ttEls[k].getAttribute('data-i18n-title'));
    }
  }

  // ── setLang — change language, persist, re-translate ──────────────
  function setLang(lang) {
    if (SUPPORTED.indexOf(lang) === -1) {
      if (typeof console !== 'undefined') {
        console.warn('[SokoniI18n] Unsupported language code:', lang,
          '| Supported:', SUPPORTED.join(', '));
      }
      return;
    }
    _lang = lang;
    try { localStorage.setItem(STORAGE_KEY, lang); } catch (_) {}
    document.documentElement.setAttribute('lang', lang);
    translatePage();
    // Notify any listeners that the language has changed
    try {
      window.dispatchEvent(new CustomEvent('sokoni:langchange', {
        bubbles: false,
        detail: { lang: lang },
      }));
    } catch (_) {}
  }

  // ── init — auto-detect and apply language ─────────────────────────
  // Priority: localStorage → browser language → default (en)
  function init() {
    var detected = DEFAULT_LANG;
    try {
      var stored = localStorage.getItem(STORAGE_KEY);
      if (stored && SUPPORTED.indexOf(stored) !== -1) {
        detected = stored;
      } else {
        // Browser language fallback: take first two chars (e.g. 'sw-KE' → 'sw')
        var browserLang = ((navigator.language || navigator.userLanguage || '').slice(0, 2) || '').toLowerCase();
        if (browserLang && SUPPORTED.indexOf(browserLang) !== -1) {
          detected = browserLang;
        }
      }
    } catch (_) {}

    _lang = detected;
    document.documentElement.setAttribute('lang', detected);
    translatePage();
  }

  // ── renderSwitcher — inject 🇬🇧 EN | 🇰🇪 SW toggle into a container ─
  function renderSwitcher(containerId) {
    var container = (typeof containerId === 'string')
      ? document.getElementById(containerId)
      : containerId;

    if (!container) {
      if (typeof console !== 'undefined') {
        console.warn('[SokoniI18n] renderSwitcher: container not found:', containerId);
      }
      return;
    }

    var LANG_OPTIONS = [
      { code: 'en', label: '🇬🇧 EN' },  // 🇬🇧
      { code: 'sw', label: '🇰🇪 SW' },  // 🇰🇪
    ];

    var wrapper = document.createElement('div');
    wrapper.className = 'sokoni-lang-switcher';
    wrapper.setAttribute('role', 'group');
    wrapper.setAttribute('aria-label', 'Language selector');
    wrapper.style.cssText = [
      'display:inline-flex',
      'align-items:center',
      'gap:4px',
      'font-size:13px',
      'font-weight:600',
      'line-height:1',
    ].join(';');

    var buttons = [];

    function refreshActive() {
      for (var b = 0; b < buttons.length; b++) {
        var isActive = buttons[b].dataset.lang === _lang;
        buttons[b].style.opacity       = isActive ? '1' : '0.4';
        buttons[b].style.fontWeight    = isActive ? '700' : '500';
        buttons[b].style.borderColor   = isActive ? 'currentColor' : 'transparent';
      }
    }

    LANG_OPTIONS.forEach(function (opt, idx) {
      if (idx > 0) {
        var sep = document.createElement('span');
        sep.textContent = '|';
        sep.setAttribute('aria-hidden', 'true');
        sep.style.cssText = 'opacity:.25;padding:0 2px;user-select:none;';
        wrapper.appendChild(sep);
      }

      var btn = document.createElement('button');
      btn.className        = 'sokoni-lang-btn';
      btn.dataset.lang     = opt.code;
      btn.textContent      = opt.label;
      btn.type             = 'button';
      btn.setAttribute('aria-label', opt.code === 'en' ? 'Switch to English' : 'Badilisha kwa Kiswahili');
      btn.style.cssText = [
        'border:1px solid transparent',
        'border-radius:6px',
        'padding:4px 9px',
        'cursor:pointer',
        'background:none',
        'font-family:inherit',
        'font-size:inherit',
        'transition:opacity .15s,border-color .15s',
        'white-space:nowrap',
      ].join(';');

      btn.addEventListener('click', function () {
        setLang(opt.code);
        refreshActive();
      });

      wrapper.appendChild(btn);
      buttons.push(btn);
    });

    container.appendChild(wrapper);
    refreshActive();

    // Keep in sync if language changes via setLang() elsewhere on the page
    window.addEventListener('sokoni:langchange', refreshActive);
  }

  // ── Public API ────────────────────────────────────────────────────
  window.SokoniI18n = {
    /** Auto-detect language and translate the page. Call after DOMContentLoaded. */
    init: init,
    /** Change the active language ('en' or 'sw'), persist, and re-translate the page. */
    setLang: setLang,
    /** Return the currently active language code. */
    getLang: getLang,
    /** Translate a key, with optional {{placeholder}} interpolation. */
    t: t,
    /** Inject a language toggle widget into the element with the given id or element reference. */
    renderSwitcher: renderSwitcher,
  };

})(window);
