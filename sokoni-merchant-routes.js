/* ══════════════════════════════════════════════════════════════════════════════
   SOKONI — MERCHANT ROUTE CONTRACT  (Phase 2A)
   ══════════════════════════════════════════════════════════════════════════════
   The ONE canonical registry of every merchant destination. The sidebar, the
   mobile drawer, the bottom nav and the command palette are all PROJECTIONS of
   this file — none of them may hold its own list. Adding a destination means
   adding a row here; there is nowhere else to add one.

   HARD RULES (enforced by validate() below and by scripts/test-merchant-routes.js)
     · Every destination opens IN-SHELL inside /merchant. Nothing navigates the
       top-level document, nothing opens a new tab, nothing uses window.open.
     · No route may target a legacy dashboard as a fallback. An unknown id is a
       LOUD failure, never a silent redirect to Dashboard.
     · Every route declares its own required role + context, so a route can be
       refused before it mounts rather than blanking after it mounts.
     · A `seller` route's `sec` MUST exist in seller.js DASH_PAGES.
       A `pos` route's `tab` MUST exist in pos.html's tab set.
       A `page` route's `src` MUST be a real file in the repo.

   kind — how the destination mounts inside the shell:
     native  rendered by a shell JS function into a panel (instant, no reload)
     pos     the single persistent POS app panel; `tab` deep-switches its tab
     seller  the single persistent Seller app panel; `sec` deep-switches section
     page    its own persistent in-shell panel loaded from `src` (never reloaded)

   tier — where the destination surfaces in navigation:
     primary  always in the sidebar (and the desktop rail), in this order
     more     in the mobile "More" drawer + desktop rail below the fold.
              Never lost, never promoted into the bottom nav.

   Canonical collections referenced here follow docs/CANONICAL_COLLECTIONS.md.
   See also: docs/NAVIGATION_CONTRACT.md, docs/MERCHANT_ROUTE_MATRIX.md
   ══════════════════════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  /* Context keys a route may require. The shell resolves these from the canonical
     merchant identity (Firebase Auth uid + the active shop/branch from SokoniBranch)
     — NEVER from the URL or from localStorage alone, which is how a merchant ends up
     looking at another shop's data after a branch switch. */
  var CTX = {
    SELLER_UID: 'sellerUid',   /* Firebase Auth uid of the signed-in merchant */
    SHOP_ID:    'shopId',      /* active shop (SokoniBranch.activeShopId)      */
    BRANCH_ID:  'branchId',    /* active branch; null is legal for single-branch shops */
    ROLE:       'role'         /* resolved role from users/{uid}.roles         */
  };

  /* Every merchant destination. Order within `primary` IS the sidebar order. */
  var ROUTES = [
    /* ── PRIMARY: the founder's canonical merchant sidebar ─────────────────── */
    { id:'dashboard', name:'Dashboard', icon:'🏠', tier:'primary',
      kind:'native',
      role:['seller','merchant'], ctx:[CTX.SELLER_UID],
      mobile:true, desktop:true, activeKey:'dashboard',
      note:'Native KPI surface. Reads AnalyticsEngine.compute() — same source as Revenue/Analytics.' },

    { id:'products', name:'Products', icon:'🏷️', tier:'primary',
      kind:'seller', sec:'products',
      role:['seller','merchant'], ctx:[CTX.SELLER_UID, CTX.SHOP_ID],
      mobile:true, desktop:true, activeKey:'products',
      note:'Canonical products list + Add Product + bulk upload. Writes products/{id}.' },

    { id:'inventory', name:'Inventory', icon:'📦', tier:'primary',
      kind:'pos', tab:'inventory',
      role:['seller','merchant'], ctx:[CTX.SELLER_UID, CTX.SHOP_ID, CTX.BRANCH_ID],
      mobile:true, desktop:true, activeKey:'inventory',
      note:'Stock authority. Reads/writes canonical products.stock — see reference_pos_checkout_stock_authority.' },

    { id:'cashier', name:'Cashier', icon:'💳', tier:'primary',
      kind:'pos', tab:'pos', posChrome:'checkout',
      role:['seller','merchant','cashier'], ctx:[CTX.SELLER_UID, CTX.SHOP_ID, CTX.BRANCH_ID],
      mobile:true, desktop:true, activeKey:'cashier',
      note:'THE IN-SHOP CHECKOUT SURFACE — not the POS dashboard. Named "Cashier" because that ' +
           'is what the merchant does here: serve a customer at the till. posChrome:"checkout" ' +
           'tells the shell to suppress the POS app\'s own tab bar so this route is the checkout ' +
           'ALONE; the wider POS surfaces stay reachable as their own routes (Inventory, Audit ' +
           'Log, POS Settings). Its charge bar sits at the panel bottom — the shell MUST keep ' +
           'the bottom nav clear of it.' },

    { id:'orders', name:'Orders', icon:'🧾', tier:'primary',
      kind:'native',
      role:['seller','merchant'], ctx:[CTX.SELLER_UID, CTX.SHOP_ID],
      mobile:true, desktop:true, activeKey:'orders',
      note:'Unified OrderService view — POS + marketplace + delivery in one list.' },

    { id:'analytics', name:'Analytics', icon:'📈', tier:'primary',
      kind:'native',
      role:['seller','merchant'], ctx:[CTX.SELLER_UID, CTX.SHOP_ID],
      mobile:true, desktop:true, activeKey:'analytics',
      note:'AnalyticsEngine.compute(), all-time default so it reconciles with Orders.' },

    { id:'revenue', name:'Revenue', icon:'💰', tier:'primary',
      kind:'native', renderer:'finance',
      role:['seller','merchant'], ctx:[CTX.SELLER_UID, CTX.SHOP_ID],
      mobile:true, desktop:true, activeKey:'revenue',
      note:'Merchant revenue = the native Finance surface (AnalyticsEngine). NOT revenue.html / ' +
           'revenue-dashboard.html — both are Super Admin pages (getAdminRevenueByHub, listCommissionRules) ' +
           'and pointing a merchant button at them would be a privilege defect.' },

    { id:'payments', name:'Payments', icon:'💳', tier:'primary',
      kind:'native', tabs:['payouts','methods'], defaultTab:'payouts',
      role:['seller','merchant'], ctx:[CTX.SELLER_UID, CTX.SHOP_ID],
      mobile:true, desktop:true, activeKey:'payments',
      note:'Payouts tab: canonical payoutRequests + wallet balance (shillings) on the FROZEN wallet ' +
           'engine. Methods tab: accepted collection methods for this shop. Never computes balances ' +
           'client-side — unknown renders as — , never 0.' },

    { id:'deliveries', name:'Deliveries', icon:'🛵', tier:'primary',
      kind:'page', src:'dispatch.html',
      role:['seller','merchant'], ctx:[CTX.SELLER_UID, CTX.SHOP_ID],
      mobile:true, desktop:true, activeKey:'deliveries',
      note:'Dispatch board. Page-level data-require-role was blanking this for non-admins — fixed 1d81f11.' },

    { id:'receipts', name:'Receipts', icon:'🧾', tier:'primary',
      kind:'seller', sec:'receipts',
      role:['seller','merchant'], ctx:[CTX.SELLER_UID, CTX.SHOP_ID],
      mobile:true, desktop:true, activeKey:'receipts' },

    { id:'returns', name:'Returns', icon:'↩️', tier:'primary',
      kind:'page', src:'returns.html',
      role:['seller','merchant'], ctx:[CTX.SELLER_UID, CTX.SHOP_ID],
      mobile:true, desktop:true, activeKey:'returns',
      note:'Bounded 12s load with terminal error+Retry — always reaches READY/EMPTY/ERROR (1d81f11).' },

    { id:'staff', name:'Staff', icon:'👥', tier:'primary',
      kind:'seller', sec:'team',
      role:['seller','merchant'], ctx:[CTX.SELLER_UID, CTX.SHOP_ID],
      mobile:true, desktop:true, activeKey:'staff' },

    { id:'messages', name:'Messages', icon:'💬', tier:'primary',
      kind:'seller', sec:'messages',
      role:['seller','merchant'], ctx:[CTX.SELLER_UID],
      mobile:true, desktop:true, activeKey:'messages' },

    { id:'marketing', name:'Marketing', icon:'📣', tier:'more',
      kind:'seller', sec:'marketing',
      role:['seller','merchant'], ctx:[CTX.SELLER_UID, CTX.SHOP_ID],
      mobile:true, desktop:true, activeKey:'marketing' },

    { id:'plan', name:'Plan', icon:'💎', tier:'primary',
      kind:'page', src:'plans.html?shell=merchant',
      role:['seller','merchant'], ctx:[CTX.SELLER_UID, CTX.SHOP_ID],
      mobile:true, desktop:true, activeKey:'plan',
      note:'Subscription + billing. Canonical CFs: subGetStatus / subGetPlans / subActivate ' +
           '(all exported in functions/index.js). plans.html already declares data-no-header="true", ' +
           'which shared-header.js honours (shared-header.js:567) — so it creates no competing fixed ' +
           'header inside the shell. ?shell=merchant tells the page it is embedded, so an expired ' +
           'session surfaces honestly instead of rendering login.html inside the merchant panel.' },

    { id:'settings', name:'Settings', icon:'⚙️', tier:'primary',
      kind:'native',
      role:['seller','merchant'], ctx:[CTX.SELLER_UID, CTX.SHOP_ID],
      mobile:true, desktop:true, activeKey:'settings',
      links:['shop','pos-setup','devices','staff','kra-tax','plan'],
      note:'Native hub — one front door that routes to Shop / POS & Devices / Staff / Tax / Plan. ' +
           'Replaces the old target (POS settings tab), which was device config masquerading as merchant settings.' },

    /* ── MORE: preserved destinations, one tap deeper. Nothing here is lost. ── */
    { id:'minishop', name:'My MiniShop', icon:'🏪', tier:'more',
      kind:'page', src:'minishop-admin.html', dynamic:true,
      role:['seller','merchant'], ctx:[CTX.SELLER_UID, CTX.SHOP_ID],
      mobile:true, desktop:true, activeKey:'minishop',
      note:'src resolves at click time from the canonical claimed-shop record (window.__miniShopUrl): ' +
           'claimed -> /shop/<handle>, unclaimed -> claim flow. Also reachable from the header button.' },

    { id:'flash-sale', name:'Flash Sale', icon:'⚡', tier:'more',
      kind:'seller', sec:'flash',
      role:['seller','merchant'], ctx:[CTX.SELLER_UID, CTX.SHOP_ID],
      mobile:true, desktop:true, activeKey:'flash-sale' },

    { id:'kra-tax', name:'KRA Tax', icon:'🧾', tier:'more',
      kind:'seller', sec:'tax',
      role:['seller','merchant'], ctx:[CTX.SELLER_UID, CTX.SHOP_ID],
      mobile:true, desktop:true, activeKey:'kra-tax',
      note:'DASH_PAGES.tax existed but had NO merchant sidebar button before Phase 2 — the surface ' +
           'was built and unreachable. eTIMS certification is separate (BLOCKED on KRA spec).' },

    { id:'stories', name:'Stories', icon:'📸', tier:'more',
      kind:'seller', sec:'stories',
      role:['seller','merchant'], ctx:[CTX.SELLER_UID, CTX.SHOP_ID],
      mobile:true, desktop:true, activeKey:'stories' },

    { id:'disputes', name:'Disputes', icon:'⚖️', tier:'primary',
      kind:'seller', sec:'disputes',
      role:['seller','merchant'], ctx:[CTX.SELLER_UID, CTX.SHOP_ID],
      mobile:true, desktop:true, activeKey:'disputes' },

    { id:'customers', name:'Customers', icon:'🧑‍🤝‍🧑', tier:'more',
      kind:'seller', sec:'customers',
      role:['seller','merchant'], ctx:[CTX.SELLER_UID, CTX.SHOP_ID],
      mobile:true, desktop:true, activeKey:'customers' },

    { id:'reports', name:'Reports', icon:'📊', tier:'more',
      kind:'native',
      role:['seller','merchant'], ctx:[CTX.SELLER_UID, CTX.SHOP_ID],
      mobile:true, desktop:true, activeKey:'reports' },

    { id:'availability', name:'Availability', icon:'🟢', tier:'more',
      kind:'native',
      role:['seller','merchant'], ctx:[CTX.SELLER_UID, CTX.SHOP_ID],
      mobile:true, desktop:true, activeKey:'availability' },

    { id:'shop', name:'Shop Details', icon:'🏬', tier:'more',
      kind:'seller', sec:'store',
      role:['seller','merchant'], ctx:[CTX.SELLER_UID, CTX.SHOP_ID],
      mobile:true, desktop:true, activeKey:'shop' },

    { id:'fulfilment', name:'Fulfilment', icon:'🚚', tier:'more',
      kind:'page', src:'seller-fulfilment.html',
      role:['seller','merchant'], ctx:[CTX.SELLER_UID, CTX.SHOP_ID],
      mobile:true, desktop:true, activeKey:'fulfilment' },

    { id:'riders', name:'Riders', icon:'🏍️', tier:'more',
      kind:'page', src:'driver.html',
      role:['seller','merchant'], ctx:[CTX.SELLER_UID, CTX.SHOP_ID],
      mobile:true, desktop:true, activeKey:'riders',
      note:'REVIEW: driver.html is the rider-facing app. Kept to preserve the existing destination, ' +
           'but a merchant-facing rider roster is the correct long-term target.' },

    { id:'verification', name:'Verification', icon:'✅', tier:'more',
      kind:'page', src:'verification.html',
      role:['seller','merchant'], ctx:[CTX.SELLER_UID],
      mobile:true, desktop:true, activeKey:'verification' },

    { id:'devices', name:'Devices', icon:'🖨️', tier:'more',
      kind:'native',
      role:['seller','merchant','cashier'], ctx:[CTX.SELLER_UID],
      mobile:true, desktop:true, activeKey:'devices',
      note:'Printer/device state lives in the SHELL context so the GATT connection survives navigation.' },

    { id:'pos-setup', name:'POS Setup', icon:'🖨️', tier:'more',
      kind:'page', src:'pos-printer-setup.html',
      role:['seller','merchant','cashier'], ctx:[CTX.SELLER_UID],
      mobile:true, desktop:true, activeKey:'pos-setup' },

    { id:'pos-settings', name:'POS Settings', icon:'⚙️', tier:'more',
      kind:'pos', tab:'settings',
      role:['seller','merchant'], ctx:[CTX.SELLER_UID, CTX.SHOP_ID, CTX.BRANCH_ID],
      mobile:true, desktop:true, activeKey:'pos-settings',
      note:'Device/receipt/till config. Was wired to the top-level "Settings" button before Phase 2.' },

    { id:'audit', name:'Audit Log', icon:'🛡️', tier:'more',
      kind:'pos', tab:'audit',
      role:['seller','merchant'], ctx:[CTX.SELLER_UID, CTX.SHOP_ID],
      mobile:true, desktop:true, activeKey:'audit' }
  ];

  /* THE canonical sidebar order. Declared explicitly rather than inferred from position in
     ROUTES, so reordering the sidebar is a one-line, reviewable change and cannot be altered
     by accident when a route definition moves. Every id here must be tier:'primary', and every
     tier:'primary' route must appear here — validate() enforces both directions. */
  var PRIMARY_ORDER = [
    'dashboard', 'plan', 'products', 'inventory', 'cashier', 'orders', 'analytics', 'revenue',
    'payments', 'deliveries', 'returns', 'receipts', 'staff', 'messages', 'disputes', 'settings'
  ];

  /* Legacy route ids -> canonical ids. Phase 2 renamed several destinations; a merchant
     with a bookmark, an open tab, or a deep link on the old id must land on the right
     module rather than hit the unknown-route failure. Aliases resolve BEFORE the
     unknown-id check, so they are back-compat — not a silent fallback to Dashboard. */
  var ALIASES = {
    finance:     'revenue',      /* native Finance surface is now the Revenue destination */
    team:        'staff',
    promotions:  'flash-sale',
    store:       'shop',
    tax:         'kra-tax',
    'pos-printer-setup': 'pos-setup'
  };

  /* Mobile bottom navigation — exactly four, never more. Each MUST be a real route
     id above (or the '__more' drawer sentinel), so the bottom nav can never drift
     out of sync with the registry. */
  var BOTTOM_NAV = [
    { id:'dashboard', icon:'🏠', label:'Home'   },
    { id:'orders',    icon:'🧾', label:'Orders' },
    { id:'cashier',   icon:'💳', label:'Sell'   },
    { id:'__more',    icon:'☰',  label:'More'   }
  ];

  /* ── Known-good target vocabularies. Kept here so a typo is caught by the gate
        rather than by a merchant discovering a blank screen in a shop. ── */
  var SELLER_SECTIONS = ['overview','products','analytics','orders','customers','receipts',
    'messages','marketing','stories','tax','history','store','team','disputes','flash','pos'];
  var POS_TABS = ['pos','inventory','orders','customers','reports','finance','settings',
    'audit','bos','repair','more'];
  var KINDS = ['native','pos','seller','page'];
  var TIERS = ['primary','more'];

  /* Patterns that must NEVER appear in a route target — the Phase 2J rule set. */
  var FORBIDDEN_SRC = /^(https?:)?\/\/|^javascript:|dashboard\.html|seller-dashboard/i;

  var byId = {};
  ROUTES.forEach(function (r) { byId[r.id] = r; });

  /* ── Contract validation. Pure, dependency-free, runnable in Node or the browser.
        Returns an array of violation strings; empty array === contract holds. ── */
  function validate () {
    var errs = [], seen = {};
    ROUTES.forEach(function (r) {
      var at = 'route "' + r.id + '"';
      if (!r.id)                        errs.push('a route has no id');
      if (seen[r.id])                   errs.push(at + ': duplicate id');
      seen[r.id] = true;
      if (!r.name)                      errs.push(at + ': missing display name');
      if (!r.icon)                      errs.push(at + ': missing icon');
      if (KINDS.indexOf(r.kind) < 0)    errs.push(at + ': invalid kind "' + r.kind + '"');
      if (TIERS.indexOf(r.tier) < 0)    errs.push(at + ': invalid tier "' + r.tier + '"');
      if (!r.activeKey)                 errs.push(at + ': missing activeKey');
      if (r.activeKey !== r.id)         errs.push(at + ': activeKey must equal id (got "' + r.activeKey + '")');
      if (!Array.isArray(r.role) || !r.role.length) errs.push(at + ': missing required role');
      if (!Array.isArray(r.ctx))        errs.push(at + ': missing required context');
      if (r.mobile !== true)            errs.push(at + ': not declared mobile-safe');
      if (r.desktop !== true)           errs.push(at + ': not declared desktop-safe');

      if (r.kind === 'seller') {
        if (!r.sec)                              errs.push(at + ': seller route has no sec');
        else if (SELLER_SECTIONS.indexOf(r.sec) < 0)
          errs.push(at + ': sec "' + r.sec + '" is not a seller.js DASH_PAGES key — it would silently fall back to overview');
      }
      if (r.kind === 'pos') {
        if (!r.tab)                              errs.push(at + ': pos route has no tab');
        else if (POS_TABS.indexOf(r.tab) < 0)    errs.push(at + ': tab "' + r.tab + '" is not a pos.html tab');
      }
      if (r.kind === 'page') {
        if (!r.src)                              errs.push(at + ': page route has no src');
        else if (FORBIDDEN_SRC.test(r.src))      errs.push(at + ': src "' + r.src + '" is external or a legacy dashboard target');
      }
      if (r.kind === 'native' && (r.src || r.sec || r.tab))
        errs.push(at + ': native route must not declare src/sec/tab');
    });

    BOTTOM_NAV.forEach(function (b) {
      if (b.id === '__more') return;
      if (!byId[b.id]) errs.push('bottom nav "' + b.id + '" is not a registered route');
      else if (byId[b.id].mobile !== true) errs.push('bottom nav "' + b.id + '" is not mobile-safe');
    });

    (byId.settings && byId.settings.links || []).forEach(function (l) {
      if (!byId[l]) errs.push('settings hub links to unknown route "' + l + '"');
    });

    if (!ROUTES.some(function (r) { return r.tier === 'primary' && r.id === 'plan'; }))
      errs.push('Plan must be a primary sidebar destination');

    /* PRIMARY_ORDER and tier:'primary' must agree in BOTH directions, so a route can never be
       primary-but-invisible (missing from the order) or ordered-but-absent (a dead sidebar row). */
    PRIMARY_ORDER.forEach(function (id) {
      if (!byId[id]) errs.push('PRIMARY_ORDER lists unknown route "' + id + '"');
      else if (byId[id].tier !== 'primary') errs.push('PRIMARY_ORDER lists "' + id + '" but its tier is "' + byId[id].tier + '"');
    });
    ROUTES.forEach(function (r) {
      if (r.tier === 'primary' && PRIMARY_ORDER.indexOf(r.id) < 0)
        errs.push('route "' + r.id + '" is tier:primary but missing from PRIMARY_ORDER — it would have no sidebar position');
    });

    return errs;
  }

  var API = {
    ROUTES: ROUTES,
    BOTTOM_NAV: BOTTOM_NAV,
    CTX: CTX,
    SELLER_SECTIONS: SELLER_SECTIONS,
    POS_TABS: POS_TABS,
    ALIASES: ALIASES,
    /* Resolve a raw id (sidebar click, hash, command palette) to a canonical route id.
       Returns null for genuinely unknown ids so the caller can fail LOUDLY — never
       silently substitute Dashboard, which is how a broken button looked like it worked. */
    resolve: function (id) {
      if (!id) return null;
      if (byId[id]) return id;
      if (ALIASES[id] && byId[ALIASES[id]]) return ALIASES[id];
      return null;
    },
    get: function (id) { return byId[id] || byId[ALIASES[id]] || null; },
    PRIMARY_ORDER: PRIMARY_ORDER,
    primary: function () {
      return PRIMARY_ORDER.map(function (id) { return byId[id]; }).filter(Boolean);
    },
    more:    function () { return ROUTES.filter(function (r) { return r.tier === 'more'; }); },
    /* Context sufficiency — a route is refused BEFORE mount when its context is
       missing, so the merchant sees an honest reason instead of a blank panel. */
    missingContext: function (id, ctx) {
      var r = byId[id]; if (!r) return ['unknown route'];
      return r.ctx.filter(function (k) {
        return k !== CTX.BRANCH_ID && (ctx == null || ctx[k] == null || ctx[k] === '');
      });
    },
    validate: validate
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  global.SokoniMerchantRoutes = API;
})(typeof window !== 'undefined' ? window : globalThis);
