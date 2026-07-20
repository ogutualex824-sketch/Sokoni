/* ================================================================
   SOKONI — Analytics Engine  v1.0
   Dual-layer tracking:
     Layer 1 → Google Analytics 4 (real-time, global reporting)
     Layer 2 → Local localStorage (admin dashboard charts)

   SETUP:
   1. Go to analytics.google.com → Admin → Create Property
   2. Choose Web stream → copy Measurement ID (G-XXXXXXXXXX)
   3. In Admin Panel → Analytics → paste Measurement ID → Save
   That's it. GA4 fires from the next page load.
================================================================ */

(function () {
  "use strict";

  /* ── Config ── */
  /* ── Measurement ID hardcoded — also writable from Admin → Analytics ── */
  const SOKONI_GA_ID = "G-QT32H65TJS";
  /* Sync to localStorage so Admin Panel shows it pre-filled */
  if (!localStorage.getItem("sokoniGaId")) localStorage.setItem("sokoniGaId", SOKONI_GA_ID);
  const GA_ID = localStorage.getItem("sokoniGaId") || SOKONI_GA_ID;
  const TODAY   = new Date().toISOString().slice(0, 10);
  const NOW_HR  = String(new Date().getHours()).padStart(2, "0");
  const PAGE    = window.location.pathname.split("/").pop() || "index.html";
  const IS_MOB  = /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);

  /* ══════════════════════════════════════════════════════════
     1. GOOGLE ANALYTICS 4 — load and initialise
  ══════════════════════════════════════════════════════════ */

  if (GA_ID && !window._sokoniGaLoaded) {
    window._sokoniGaLoaded = true;

    /* Inject gtag.js script */
    const s   = document.createElement("script");
    s.src     = `https://www.googletagmanager.com/gtag/js?id=${GA_ID}`;
    s.async   = true;
    document.head.appendChild(s);

    window.dataLayer = window.dataLayer || [];
    window.gtag = function () { window.dataLayer.push(arguments); };
    window.gtag("js", new Date());
    window.gtag("config", GA_ID, {
      anonymize_ip:   true,
      send_page_view: true,
      cookie_flags:   "SameSite=None;Secure",

      /* ── Google Signals OFF ────────────────────────────────────────────────
         MEASURED COST. With signals enabled, GA additionally calls
         stats.g.doubleclick.net and google.<tld>/ads/ga-audiences. Neither is in
         our CSP connect-src/img-src, so the browser BLOCKS both and then POSTs a
         violation report to cspReportCollect — which awaits a Firestore write
         with no minInstances, so each report took ~6s. Two reports per page load
         were costing ~12s on the homepage. Analytics we do not use was the single
         largest item in the load profile.

         Turning them off removes the requests, the violations and the reports in
         one change, and it is the correct default for us regardless of speed:
         these calls share behavioural data with Google's advertising network,
         which is not something SOKONI needs and not something we should be doing
         quietly under the Kenyan Data Protection Act.

         Ordinary GA measurement is unaffected — only the ad-network signals are. */
      allow_google_signals: false,
      allow_ad_personalization_signals: false,
    });

  } else if (!GA_ID) {
    /* No-op gtag so calls don't throw errors */
    window.gtag = window.gtag || function () {};
  }

  /* ══════════════════════════════════════════════════════════
     2. LOCAL ANALYTICS STORE (localStorage-based)
  ══════════════════════════════════════════════════════════ */

  function _getStore() {
    try { return JSON.parse(localStorage.getItem("sokoniAnalytics")) || {}; }
    catch (e) { return {}; }
  }

  function _saveStore(d) {
    try { localStorage.setItem("sokoniAnalytics", JSON.stringify(d)); }
    catch (e) {}
  }

  function _inc(obj, key, val = 1) {
    obj[key] = (obj[key] || 0) + val;
  }

  function _push() {
    const store   = _getStore();
    const days    = store.days    = store.days    || {};
    const cats    = store.cats    = store.cats    || {};
    const pages   = store.pages   = store.pages   || {};
    const hourly  = store.hourly  = store.hourly  || {};
    const devices = store.devices = store.devices || { mobile: 0, desktop: 0 };
    const funnels = store.funnels = store.funnels || {};
    const searches= store.searches= store.searches|| {};

    /* Day stats */
    if (!days[TODAY]) days[TODAY] = { sessions: 0, pageViews: 0, signups: 0, sales: 0, revenue: 0, cartAdds: 0, productViews: 0 };

    /* Session counting — one per 30 min */
    const lastSession = Number(localStorage.getItem("_sokoniLastSession") || 0);
    if (Date.now() - lastSession > 30 * 60 * 1000) {
      _inc(days[TODAY], "sessions");
      localStorage.setItem("_sokoniLastSession", String(Date.now()));
      _inc(devices, IS_MOB ? "mobile" : "desktop");
    }

    /* Page view */
    _inc(days[TODAY], "pageViews");
    _inc(pages, PAGE);
    _inc(hourly, NOW_HR);

    /* Keep only 30 days */
    const dayKeys = Object.keys(days).sort();
    while (dayKeys.length > 30) { delete days[dayKeys.shift()]; }

    store.days    = days;
    store.cats    = cats;
    store.pages   = pages;
    store.hourly  = hourly;
    store.devices = devices;
    store.funnels = funnels;
    store.searches= searches;

    _saveStore(store);
    return store;
  }

  /* ══════════════════════════════════════════════════════════
     3. PUBLIC TRACKING FUNCTIONS
  ══════════════════════════════════════════════════════════ */

  /** Track product view */
  window.sokoniTrackProductView = function (product) {
    if (!product) return;
    /* GA4 */
    window.gtag("event", "view_item", {
      currency: "KES",
      value:    Number(product.price || 0),
      items:    [{ item_id: product.id, item_name: product.name, item_category: product.category, price: Number(product.price || 0) }],
    });
    /* Local */
    const store = _getStore();
    const days  = store.days = store.days || {};
    if (!days[TODAY]) days[TODAY] = {};
    _inc(days[TODAY], "productViews");
    const cats = store.cats = store.cats || {};
    if (product.category) _inc(cats, product.category);
    _saveStore(store);
  };

  /** Track add to cart */
  window.sokoniTrackAddToCart = function (product) {
    if (!product) return;
    window.gtag("event", "add_to_cart", {
      currency: "KES",
      value:    Number(product.price || 0),
      items:    [{ item_id: product.id, item_name: product.name, item_category: product.category, price: Number(product.price || 0) }],
    });
    const store = _getStore();
    const days  = store.days = store.days || {};
    if (!days[TODAY]) days[TODAY] = {};
    _inc(days[TODAY], "cartAdds");
    const funnels = store.funnels = store.funnels || {};
    _inc(funnels, "cart");
    _saveStore(store);
  };

  /** Track purchase / order placed */
  window.sokoniTrackPurchase = function (order) {
    if (!order) return;
    const total = Number(order.total || 0);
    window.gtag("event", "purchase", {
      transaction_id: order.id,
      currency:       "KES",
      value:          total,
      items:          (order.items || []).map(p => ({
        item_id:       p.id,
        item_name:     p.name,
        item_category: p.category,
        price:         Number(p.price || 0),
        quantity:      1,
      })),
    });
    const store = _getStore();
    const days  = store.days = store.days || {};
    if (!days[TODAY]) days[TODAY] = {};
    _inc(days[TODAY], "sales");
    days[TODAY].revenue = (days[TODAY].revenue || 0) + total;
    const funnels = store.funnels = store.funnels || {};
    _inc(funnels, "purchase");
    _saveStore(store);
  };

  /** Track signup */
  window.sokoniTrackSignup = function () {
    window.gtag("event", "sign_up", { method: "email" });
    const store = _getStore();
    const days  = store.days = store.days || {};
    if (!days[TODAY]) days[TODAY] = {};
    _inc(days[TODAY], "signups");
    const funnels = store.funnels = store.funnels || {};
    _inc(funnels, "signup");
    _saveStore(store);
  };

  /** Track login */
  window.sokoniTrackLogin = function () {
    window.gtag("event", "login", { method: "email" });
  };

  /** Track search */
  window.sokoniTrackSearch = function (query) {
    if (!query) return;
    window.gtag("event", "search", { search_term: query });
    const store   = _getStore();
    const searches= store.searches = store.searches || {};
    const q = query.toLowerCase().trim().substring(0, 40);
    if (q.length >= 2) _inc(searches, q);
    _saveStore(store);
  };

  /** Track product upload (seller) */
  window.sokoniTrackProductUpload = function (category) {
    window.gtag("event", "product_upload", { category: category || "unknown" });
    const store = _getStore();
    const funnels = store.funnels = store.funnels || {};
    _inc(funnels, "uploads");
    _saveStore(store);
  };

  /** Track share */
  window.sokoniTrackShare = function (method, name) {
    window.gtag("event", "share", { method, content_type: "product", item_id: name });
  };

  /* ══════════════════════════════════════════════════════════
     4. AUTO-TRACK ON LOAD
  ══════════════════════════════════════════════════════════ */
  _push(); /* Always record page view on script load */

  /* Also track search inputs automatically */
  window.addEventListener("load", () => {
    const searchInput = document.getElementById("searchInput");
    if (searchInput) {
      let _searchTimer;
      searchInput.addEventListener("input", () => {
        clearTimeout(_searchTimer);
        _searchTimer = setTimeout(() => {
          if (searchInput.value.trim().length >= 2) {
            window.sokoniTrackSearch(searchInput.value.trim());
          }
        }, 1500);
      });
    }
  });

  /* ══════════════════════════════════════════════════════════
     5. ENGAGEMENT TRACKING
  ══════════════════════════════════════════════════════════ */

  /* Scroll depth (25 / 50 / 75 / 100%) */
  (function () {
    const milestones = [25, 50, 75, 100];
    let reached = new Set();
    function checkScroll() {
      const scrolled = window.scrollY + window.innerHeight;
      const total    = document.documentElement.scrollHeight;
      const pct      = Math.round((scrolled / total) * 100);
      milestones.forEach(m => {
        if (pct >= m && !reached.has(m)) {
          reached.add(m);
          window.gtag("event", "scroll_depth", { page: PAGE, depth_pct: m });
          const store = _getStore();
          const eng = store.engagement = store.engagement || {};
          const sd  = eng.scrollDepth  = eng.scrollDepth  || {};
          sd[m] = (sd[m] || 0) + 1;
          _saveStore(store);
        }
      });
    }
    window.addEventListener("scroll", checkScroll, { passive: true });
  })();

  /* Time on page — record on unload */
  const _pageStart = Date.now();
  window.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "hidden") {
      const secs = Math.round((Date.now() - _pageStart) / 1000);
      window.gtag("event", "time_on_page", { page: PAGE, seconds: secs });
      const store = _getStore();
      const eng = store.engagement = store.engagement || {};
      const tp  = eng.timeOnPage   = eng.timeOnPage   || {};
      tp[PAGE]  = (tp[PAGE] || 0) + secs;
      _saveStore(store);
    }
  });

  /* Click heatmap (track clicked element types) */
  document.addEventListener("click", function (e) {
    const tag = (e.target.tagName || "").toLowerCase();
    const cls = (e.target.className || "").toString().split(" ")[0].substring(0, 30);
    const store = _getStore();
    const eng = store.engagement = store.engagement || {};
    const clicks = eng.clicks = eng.clicks || {};
    const key = tag + (cls ? "." + cls : "");
    clicks[key] = (clicks[key] || 0) + 1;
    _saveStore(store);
  }, { passive: true });

  /* Hub visit tracking */
  window.sokoniTrackHubVisit = function (hubName) {
    window.gtag("event", "hub_visit", { hub: hubName });
    const store = _getStore();
    const eng   = store.engagement = store.engagement || {};
    const hubs  = eng.hubVisits    = eng.hubVisits    || {};
    hubs[hubName] = (hubs[hubName] || 0) + 1;
    _saveStore(store);
  };
  /* Auto-detect hub from page name */
  const _hubMap = { "fitness-hub":"Fitness", "car-hub":"Car", "legal-hub":"Legal",
    "sports-hub":"Sports", "property-hub":"Property", "bnb-hub":"BnB",
    "tech-hub":"Tech", "healthcare":"Healthcare", "entertainment":"Entertainment" };
  const _hubKey = Object.keys(_hubMap).find(k => PAGE.startsWith(k));
  if (_hubKey) window.sokoniTrackHubVisit(_hubMap[_hubKey]);

  /* ══════════════════════════════════════════════════════════
     6. RETENTION TRACKING
  ══════════════════════════════════════════════════════════ */

  (function () {
    const store   = _getStore();
    const ret     = store.retention = store.retention || {};
    const visits  = ret.visitDates  = ret.visitDates  || [];

    /* Record today if not already recorded */
    if (!visits.includes(TODAY)) {
      visits.push(TODAY);
      /* Keep only last 90 days */
      while (visits.length > 90) visits.shift();
    }

    /* DAU / WAU / MAU */
    const now = new Date();
    const cutW = new Date(now - 7  * 86400000).toISOString().slice(0,10);
    const cutM = new Date(now - 30 * 86400000).toISOString().slice(0,10);
    ret.dau = visits.filter(d => d === TODAY).length > 0 ? 1 : 0;
    ret.wau = visits.filter(d => d >= cutW).length;
    ret.mau = visits.filter(d => d >= cutM).length;

    /* Return visitor detection */
    ret.isReturning = visits.length > 1;
    ret.totalDays   = visits.length;

    /* Churn risk: no visit in 14+ days */
    const lastVisit = visits[visits.length - 2] || visits[0];
    const daysSince = lastVisit ? Math.floor((now - new Date(lastVisit)) / 86400000) : 0;
    ret.daysSinceLastVisit = daysSince;
    ret.churnRisk = daysSince >= 14 ? "high" : daysSince >= 7 ? "medium" : "low";

    store.retention = ret;
    _saveStore(store);

    /* GA4 retention event */
    if (ret.isReturning) {
      window.gtag("event", "return_visit", { days_since_last: daysSince, total_days: ret.totalDays });
    }
  })();

  /* Track user actions for engagement score */
  window.sokoniTrackEngagement = function (action, value) {
    window.gtag("event", "engagement_action", { action, value: value || 1 });
    const store = _getStore();
    const eng   = store.engagement = store.engagement || {};
    const score = eng.score = eng.score || 0;
    const weights = { purchase:10, review:5, share:3, wishlist:2, search:1, pageview:0.5 };
    eng.score = score + (weights[action] || 1);
    const actions = eng.actions = eng.actions || [];
    actions.push({ action, ts: Date.now() });
    if (actions.length > 50) actions.shift();
    _saveStore(store);
  };

  /* ── Expose the store for admin dashboard ── */
  window.sokoniGetAnalytics = _getStore;
  window.sokoniGetEngagement = function () { return (_getStore().engagement || {}); };
  window.sokoniGetRetention  = function () { return (_getStore().retention  || {}); };

  /* Auto-inject beta widget for registered beta testers */
  if (localStorage.getItem('_sokoniBetaMode')) {
    var _bw = document.createElement('script');
    _bw.src = '/beta-widget.js';
    _bw.defer = true;
    document.head.appendChild(_bw);
  }

  /* Auto-inject launch tracker on all pages */
  if (!window.SokoniLaunch) {
    var _sl = document.createElement('script');
    _sl.src = '/sokoni-launch.js';
    document.head.appendChild(_sl);
  }

})();
