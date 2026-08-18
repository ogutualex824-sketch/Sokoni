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

    { id:'sell', name:'Sell', icon:'💳', tier:'primary',
      kind:'native',
      role:['seller','merchant','cashier'], ctx:[CTX.SELLER_UID, CTX.SHOP_ID],
      mobile:true, desktop:true, activeKey:'sell',
      note:'The phone-first till (sokoni-merchant-sell.js). Native, NOT the POS iframe: POS is a ' +
           'desktop-scale in-shop application whose checkout assumes a counter, a drawer and a ' +
           'wide viewport. This is the surface for a merchant standing up with a phone. ' +
           'It reads canonical `products` scoped by shopId through SokoniMerchantData and ' +
           'submits sales to posCompleteCheckout — the SAME server authority POS uses, so the two ' +
           'cannot produce different stock or different revenue. It writes nothing itself: an ' +
           'abandoned cart reserves nothing and decrements nothing, and success is only ever ' +
           'rendered from a server result. POS is preserved unchanged as its own destination.' },

    { id:'pos', name:'POS', icon:'🧮', tier:'primary',
      kind:'pos', tab:'pos',
      role:['seller','merchant','cashier'], ctx:[CTX.SELLER_UID, CTX.SHOP_ID, CTX.BRANCH_ID],
      mobile:true, desktop:true, activeKey:'pos',
      note:'ONE in-shop surface. Cashier and Inventory used to be separate top-level routes that ' +
           'both opened this same application at different tabs — two sidebar rows, one app, and ' +
           'a shell that had to deep-switch into it. POS now owns the whole in-shop operation ' +
           '(Checkout, Inventory, Audit Log) through the POS app\'s own tabs. It opens on ' +
           'CHECKOUT, because that is what a merchant standing at the till needs first; Inventory ' +
           'is a tab inside, not a second application. The POS tab bar is deliberately NOT ' +
           'suppressed here — it is now the navigation for this surface. #cashier and #inventory ' +
           'alias here so existing links keep working. Products stays separate: catalogue ' +
           'management is a different job from in-shop stock operations.' },

    { id:'inventory', name:'Inventory', icon:'📦', tier:'primary',
      kind:'native',
      role:['seller','merchant'], ctx:[CTX.SELLER_UID, CTX.SHOP_ID],
      mobile:true, desktop:true, activeKey:'inventory',
      note:'Stock on hand + CORRECTIONS, via merchantAdjustStock — the first and only server ' +
           'authority over a correction to canonical `products.stock`. It was an ALIAS to the POS ' +
           'inventory tab until 2D-1C; that tab reaches the canonical field through ' +
           'sokoni-db.updateProductStock(), which also increments `sold`, so counting three ' +
           'damaged units off the shelf silently recorded three SALES. This route exists because ' +
           'a correction is not a sale: it moves stock, writes a stockMovements record with a ' +
           'mandatory reason, and leaves `sold`, revenue and every sales aggregate untouched. ' +
           'Selling remains Sell/POS -> posCompleteCheckout.' },

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

    { id:'deliveries', name:'Delivery Hub', icon:'🛵', tier:'primary',
      kind:'page', src:'seller-delivery.html?shell=merchant',
      role:['seller','merchant'], ctx:[CTX.SELLER_UID, CTX.SHOP_ID],
      mobile:true, desktop:true, activeKey:'deliveries',
      note:'Was dispatch.html — the ADMIN dispatch console (data-require-role="admin"). It ' +
           'queries every packageRequests document platform-wide with no seller filter, and ' +
           'firestore.rules only permits a non-admin to read deliveries their own uid is party ' +
           'to. So the query was rejected outright and the seller got an EMPTY board: the ' +
           '"blanking" that 1d81f11 tried to fix by loosening the page gate was Firestore ' +
           'refusing an admin query, not a role bug. It also offered rider suspension. ' +
           'seller-delivery.html scopes every read to sellerUid == the signed-in seller.' },

    { id:'receipts', name:'Receipts', icon:'🧾', tier:'primary',
      kind:'seller', sec:'receipts',
      role:['seller','merchant'], ctx:[CTX.SELLER_UID, CTX.SHOP_ID],
      mobile:true, desktop:true, activeKey:'receipts' },

    { id:'returns', name:'Returns', icon:'↩️', tier:'primary',
      kind:'page', src:'returns.html?shell=merchant',
      role:['seller','merchant'], ctx:[CTX.SELLER_UID, CTX.SHOP_ID],
      mobile:true, desktop:true, activeKey:'returns',
      note:'Bounded 12s load with terminal error+Retry — always reaches READY/EMPTY/ERROR (1d81f11).' },

    { id:'staff', name:'Staff', icon:'👥', tier:'primary',
      kind:'native',
      role:['seller','merchant'], ctx:[CTX.SELLER_UID, CTX.SHOP_ID],
      mobile:true, desktop:true, activeKey:'staff',
      note:'Native team surface (sokoni-merchant-team.js) on the canonical shopEmployees contract: ' +
           'listShopEmployees / listShopInvites / inviteShopEmployee / revokeShopInvite / ' +
           'removeShopEmployee, all owner-scoped and corroborated against shops/{shopId}. ' +
           'Was kind:seller (seller.html#team), whose remove path called deleteDoc on ' +
           'shopEmployees/{id} AND users/{id} straight from the browser, and which mirrored the ' +
           'roster into localStorage.sokoniEmployees so a revoked cashier kept appearing as staff ' +
           'on that device. Neither behaviour is reachable from the merchant workspace any more.' },

    { id:'messages', name:'Messages', icon:'💬', tier:'primary',
      kind:'native',
      role:['seller','merchant'], ctx:[CTX.SELLER_UID],
      mobile:true, desktop:true, activeKey:'messages',
      note:'Native surface (sokoni-merchant-messages-ui.js) through the deployed messagesDispatch ' +
           'router — the individual handlers are not re-exported, the router is, and it routes into ' +
           'the same messages._h ops. Every mutation is an op; the only Firestore access is a READ ' +
           'of conversations/{id}/messages, which firestore.rules gates on participation and whose ' +
           'client creates are blocked outright (allow create: if false), so sendMessage stays the ' +
           'sole writer. PARTICIPANT-scoped, not shop-scoped, and labelled so. Was kind:seller ' +
           '(seller.html#messages), whose inbox lived in localStorage.sokoniMessages — a thread read ' +
           'on one device stayed unread on another.' },

    { id:'marketing', name:'Marketing', icon:'📣', tier:'more',
      kind:'native',
      role:['seller','merchant'], ctx:[CTX.SELLER_UID, CTX.SHOP_ID],
      mobile:true, desktop:true, activeKey:'marketing',
      note:'Native surface (sokoni-merchant-marketing.js) built ONLY on the authorities the ' +
           'Marketing census classified SAFE: createMinishopCampaign / getMinishopCampaigns / ' +
           'pauseMinishopCampaign / deleteMinishopCampaign (all four now shop-scoped) plus the ' +
           'minishop promotions path. Ads are ACCOUNT-scoped and labelled as such, because ' +
           'sokoAds carries no shopId in the writer or either reader. Orders and ROI are NOT ' +
           'displayed: those counters come from trackCampaignClick, an endpoint needing no ' +
           'sign-in, so they are not business results. The eleven marketing-engine callables ' +
           'stay out — un-re-exported, and their role gate admits any string claim.' },

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
    /* The way back to the marketplace. Before this, /merchant contained ZERO links to any
       external destination — measured — so a merchant could reach the shop only by editing
       the URL. That is the dead-end Navigation Contract rule 2 forbids.
       Targets '/' rather than 'index.html' because cleanUrls:true 301-redirects the latter.
       tier:'hidden' keeps it out of the sidebar list while remaining a real, validated route
       that the bottom nav can point at. */
    { id:'home', name:'Home', icon:'🏠', tier:'hidden',
      kind:'exit', href:'/',
      role:['seller','merchant'], ctx:[],
      mobile:true, desktop:true, activeKey:'home',
      note:'Leaves the shell entirely (full-page navigation to the marketplace home). NEVER ' +
           'express this as kind:page — iframing index.html would boot the customer application ' +
           'inside the merchant shell, the double-shell defect e0dbdca fixed.' },

    { id:'minishop', name:'My MiniShop', icon:'🏪', tier:'hidden',
      kind:'page', src:'minishop-admin.html?shell=merchant', dynamic:true,
      role:['seller','merchant'], ctx:[CTX.SELLER_UID, CTX.SHOP_ID],
      mobile:true, desktop:true, activeKey:'minishop',
      note:'src resolves at click time from the canonical claimed-shop record (window.__miniShopUrl): ' +
           'claimed -> /shop/<handle>, unclaimed -> claim flow. Also reachable from the header button.' },

    { id:'flash-sale', name:'Flash Sale', icon:'⚡', tier:'more',
      kind:'seller', sec:'flash',
      role:['seller','merchant'], ctx:[CTX.SELLER_UID, CTX.SHOP_ID],
      mobile:true, desktop:true, activeKey:'flash-sale' },

    { id:'kra-tax', name:'KRA Tax', icon:'🧾', tier:'more',
      kind:'native',
      role:['seller','merchant'], ctx:[CTX.SELLER_UID],
      mobile:true, desktop:true, activeKey:'kra-tax',
      note:'Native tax surface (sokoni-merchant-tax-ui.js) on the eight authorities the ' +
           'Receipts/Tax census classified SAFE: etimsGetProfile, etimsRegisterSeller, ' +
           'etimsUpdateProfile, etimsValidatePin, etimsGetSellerStats, etimsGenerateInvoice, ' +
           'etimsBulkGenerate, etimsResubmitInvoice. ctx is SELLER_UID ALONE and deliberately not ' +
           'SHOP_ID: tax identity is etimsProfiles/{auth.uid} — the uid IS the document id, so no ' +
           'merchant identifier is sent by any call and there is no shop dimension to scope. One ' +
           'KRA PIN and one invoice sequence per ACCOUNT, which the surface states in its header ' +
           'rather than letting a two-shop merchant find out by surprise. Was kind:\'seller\' ' +
           'sec:\'tax\' — an iframe of seller.html#tax. eTIMS certification is separate ' +
           '(BLOCKED on KRA spec).' },

    { id:'stories', name:'Stories', icon:'📸', tier:'more',
      kind:'seller', sec:'stories',
      role:['seller','merchant'], ctx:[CTX.SELLER_UID, CTX.SHOP_ID],
      mobile:true, desktop:true, activeKey:'stories' },

    { id:'disputes', name:'Disputes', icon:'⚖️', tier:'primary',
      kind:'native',
      role:['seller','merchant'], ctx:[CTX.SELLER_UID, CTX.SHOP_ID],
      mobile:true, desktop:true, activeKey:'disputes',
      note:'Native surface (sokoni-merchant-disputes-ui.js) on the party-scoped dispute ' +
           'authorities: getSellerDisputes / getDisputeDetail / sellerRespondToDispute / ' +
           'addDisputeEvidence. A merchant CANNOT open a dispute (createDispute refuses a ' +
           'non-buyer), cancel one (cancelDispute is the buyer withdrawing) or resolve one ' +
           '(adminResolveDispute is admin-gated) — the screen explains each instead of ' +
           'offering a control the server refuses. ACCOUNT-scoped and labelled so: a dispute ' +
           'carries orderId/buyerId/sellerId and NO shopId, so filtering by the active shop ' +
           'would invent a boundary the server never applied.' },

    { id:'customers', name:'Customers', icon:'🧑‍🤝‍🧑', tier:'more',
      kind:'native',
      role:['seller','merchant'], ctx:[CTX.SELLER_UID, CTX.SHOP_ID],
      mobile:true, desktop:true, activeKey:'customers',
      note:'Native surface. List + search read crmCustomerProfiles through firestore.rules, which ' +
           'scope on resource.data.merchantId == auth.uid and refuse client writes outright — so a ' +
           'merchant cannot receive another merchant\'s rows however the query is written. Profile ' +
           'and summary use getCustomerProfile / getCRMDashboard. DELIBERATELY NOT BOUND: ' +
           'posLookupCustomer (searches posCustomers platform-wide with no merchant filter — a ' +
           'cross-tenant PII disclosure), posGetCustomerInsights (client-supplied merchantId, ' +
           'unverified) and getCustomerGrowthMetrics (gated on a sellerId claim nothing mints). ' +
           'The two callables assert ownership via merchants/{merchantId}, a POS-only record a ' +
           'marketplace merchant does not have; the screen states that plainly and does NOT create ' +
           'one — resurrecting the POS identity model to satisfy a legacy CRM callable would undo ' +
           'the shops/{shopId} identity work.' },

    { id:'reports', name:'Reports', icon:'📊', tier:'more',
      kind:'native',
      role:['seller','merchant'], ctx:[CTX.SELLER_UID, CTX.SHOP_ID],
      mobile:true, desktop:true, activeKey:'reports' },

    { id:'availability', name:'Availability', icon:'🟢', tier:'more',
      kind:'native',
      role:['seller','merchant'], ctx:[CTX.SELLER_UID, CTX.SHOP_ID],
      mobile:true, desktop:true, activeKey:'availability' },

    { id:'shop', name:'Shop Details', icon:'🏬', tier:'more',
      kind:'native',
      role:['seller','merchant'], ctx:[CTX.SELLER_UID, CTX.SHOP_ID],
      mobile:true, desktop:true, activeKey:'shop',
      note:'Native storefront surface (sokoni-merchant-store-ui.js) on the six authorities the ' +
           'Store census classified SAFE: getMyMinishop, saveMinishopConfig, claimMinishopHandle, ' +
           'getMinishopAnalytics, generateMinishopShareCard. The shopId is LEARNED from ' +
           'getMyMinishop, which resolves shops where sellerUid == uid — never taken from ' +
           'SokoniShell.activeShopId, the URL, or anything a browser can edit, and never defaulted ' +
           'to the uid. The follower count has ONE source, getMinishopAnalytics, whose value ' +
           'derives from the shopFollowers relationship made CF-only in Store Stage 1B.' },

    { id:'fulfilment', name:'Fulfilment', icon:'🚚', tier:'more',
      kind:'page', src:'seller-fulfilment.html?shell=merchant',
      role:['seller','merchant'], ctx:[CTX.SELLER_UID, CTX.SHOP_ID],
      mobile:true, desktop:true, activeKey:'fulfilment' },

    { id:'riders', name:'Riders', icon:'🏍️', tier:'more',
      kind:'page', src:'seller-delivery.html?shell=merchant#riders',
      role:['seller','merchant'], ctx:[CTX.SELLER_UID, CTX.SHOP_ID],
      mobile:true, desktop:true, activeKey:'riders',
      note:'Was driver.html — the RIDER-FACING app. A seller tapping "Riders" in their own ' +
           'dashboard was handed a personal rider account: the wrong context entirely, and the ' +
           'previous note here already flagged it as REVIEW. Now a deep link into the seller\'s ' +
           'Delivery Hub rider roster. Three contexts stay distinct: driver.html = MY rider ' +
           'account, this = the seller\'s delivery operation, track.html = a buyer\'s own order.' },

    { id:'verification', name:'Verification', icon:'✅', tier:'more',
      kind:'page', src:'verification.html?shell=merchant',
      role:['seller','merchant'], ctx:[CTX.SELLER_UID],
      mobile:true, desktop:true, activeKey:'verification' },

    { id:'devices', name:'Devices', icon:'🖨️', tier:'more',
      kind:'native',
      role:['seller','merchant','cashier'], ctx:[CTX.SELLER_UID],
      mobile:true, desktop:true, activeKey:'devices',
      note:'Printer/device state lives in the SHELL context so the GATT connection survives navigation.' },

    { id:'pos-setup', name:'POS Setup', icon:'🖨️', tier:'more',
      kind:'page', src:'pos-printer-setup.html?shell=merchant',
      role:['seller','merchant','cashier'], ctx:[CTX.SELLER_UID],
      mobile:true, desktop:true, activeKey:'pos-setup' },


  ];

  /* THE canonical sidebar order. Declared explicitly rather than inferred from position in
     ROUTES, so reordering the sidebar is a one-line, reviewable change and cannot be altered
     by accident when a route definition moves. Every id here must be tier:'primary', and every
     tier:'primary' route must appear here — validate() enforces both directions. */
  var PRIMARY_ORDER = [
    'dashboard', 'plan', 'sell', 'products', 'inventory', 'pos', 'orders', 'analytics', 'revenue',
    'payments', 'deliveries', 'returns', 'receipts', 'staff', 'messages', 'disputes', 'settings'
  ];

  /* ── Sidebar grouping for the `more` tier ──────────────────────────────────────
     The primary tier is one flat ordered list (PRIMARY_ORDER). Everything below it
     rendered under a single "More" divider: 13 unrelated destinations in declaration
     order — Marketing next to Riders next to POS Setup. That is a list, not navigation.

     Declared explicitly, like PRIMARY_ORDER, so regrouping is a one-line reviewable
     change. validate() enforces a TOTAL PARTITION in both directions: every tier:'more'
     route appears in exactly one group, and no group names a route that is not
     tier:'more'. A destination therefore cannot be silently dropped from the sidebar by
     a regroup, which is the same guarantee PRIMARY_ORDER already gives the tier above.

     This is grouping only. No destination is added, removed, renamed or re-targeted —
     the sidebar renders exactly the same 13 routes it did before, under headings. */
  var MORE_GROUPS = [
    { key:'main',       label:'Main',
      ids:['reports','availability','shop','fulfilment','riders','verification'] },
    { key:'growth',     label:'Growth',
      ids:['marketing','flash-sale','stories','customers'] },
    /* KRA Tax groups with Operations rather than Main: it is back-office compliance
       configured once alongside Devices and POS Setup, not a surface a merchant reads
       daily the way they read Reports. */
    { key:'operations', label:'Operations',
      ids:['kra-tax','devices','pos-setup'] }
  ];

  /* ── ROUTE ACTION CHIPS ─────────────────────────────────────────────────────────
     THE SHELL DECLARES. THE SURFACE OWNER RENDERS.

     Every contextual chip bar in /merchant is declared here, and nowhere else, so that
     "what controls does this destination offer" is a reviewable property of the registry
     rather than a fact you can only discover by reading four renderers.

     What this is NOT: a shell-owned chip bar. Orders, Analytics, Revenue, Reports,
     Payments and Availability already render their own filter bars, and those bars own
     real state (_ordState, _anRange, _payTab). Rendering a second row from the shell
     would put two filter bars on Orders — the same "two of everything" defect that
     test-merchant-shell-boundary.js exists to prevent, just one layer down. So the
     registry ADOPTS the existing bars: it names their handler, and the gate proves the
     handler is really there. Nothing is re-plumbed and no proven surface is touched.

     `owner` is the surface that renders the bar, and therefore the file the gate greps:
       native → merchant.html's own renderer      seller → seller.html / seller.js
       pos    → pos.html
     `status`:
       live    → rendered today. MUST name a handler, and the gate asserts that handler
                 is defined in the owner's file. A live bar whose handler has been renamed
                 or deleted fails the gate rather than becoming a dead control.
       planned → declared, deliberately NOT rendered, and MUST NOT name a handler. This is
                 how a capability we have agreed to build stays visible without shipping a
                 button that does nothing. A planned bar renders no chips at all — the
                 registry never causes a control to appear before its capability exists.

     The whole point of the `status` split is that a chip cannot be decorative. Either it
     is bound to a handler the gate can find, or it is not on screen. ── */
  var ACTION_OWNERS = ['native','seller','pos'];
  var ACTION_STATUS = ['live','planned'];

  var ACTIONS = {
    /* Adopted — these bars exist and are rendered by merchant.html today. */
    orders: { owner:'native', bars:[
      { key:'tab', status:'live', handler:'__ordTab', chips:[
        { id:'all',       label:'All'       }, { id:'pickup',    label:'Pickup'    },
        { id:'pending',   label:'Pending'   }, { id:'completed', label:'Completed' },
        { id:'refunded',  label:'Refunded'  }, { id:'cancelled', label:'Cancelled' } ] },
      { key:'range', status:'live', handler:'__ordRange', chips:[
        { id:'today', label:'Today' }, { id:'week', label:'This Week' },
        { id:'month', label:'This Month' }, { id:'all', label:'All Time' } ] }
    ] },

    /* Analytics, Revenue and Reports are three views of ONE renderer (renderAnalytics),
       so they share one handler that takes the view as its first argument. Declared per
       route anyway — a merchant reading Revenue is on the Revenue destination, and the
       registry should say what Revenue offers without the reader having to know that
       three ids collapse into one function. */
    analytics: { owner:'native', bars:[ { key:'range', status:'live', handler:'__anRange', view:'analytics', chips:[
      { id:'today', label:'Today' }, { id:'week', label:'This Week' },
      { id:'month', label:'This Month' }, { id:'all', label:'All Time' } ] } ] },
    revenue:   { owner:'native', bars:[ { key:'range', status:'live', handler:'__anRange', view:'revenue', chips:[
      { id:'today', label:'Today' }, { id:'week', label:'This Week' },
      { id:'month', label:'This Month' }, { id:'all', label:'All Time' } ] } ] },
    reports:   { owner:'native', bars:[ { key:'range', status:'live', handler:'__anRange', view:'reports', chips:[
      { id:'today', label:'Today' }, { id:'week', label:'This Week' },
      { id:'month', label:'This Month' }, { id:'all', label:'All Time' } ] } ] },

    payments: { owner:'native', bars:[ { key:'tab', status:'live', handler:'__payTab', chips:[
      { id:'payouts', label:'Payouts' }, { id:'methods', label:'Methods' } ] } ] },

    availability: { owner:'native', bars:[ { key:'shop', status:'live', handler:'__avToggleShop', chips:[
      { id:'shop', label:'Shop open' } ] } ] },

    /* ── Declared, not yet rendered ────────────────────────────────────────────────
       Products and POS are owned by seller.html and pos.html respectively. Their chips
       are agreed but unbuilt; they stay `planned` so the completion matrix can track
       them and the gate can report them, without a single dead button reaching a shop.

       Dashboard's Export is the honest case that proves the rule: there is no export
       capability anywhere in merchant.html today, so Export is declared and NOT drawn.
       Rendering it as a live chip would be exactly the "hard-coded fake button" this
       registry exists to make impossible. */
    products: { owner:'seller', bars:[
      { key:'actions', status:'planned', chips:[
        { id:'add',   label:'Add Product' }, { id:'stock', label:'Stock' },
        { id:'flash', label:'Flash Sale'  }, { id:'scan',  label:'Scan'  } ] } ] },

    pos: { owner:'pos', bars:[
      { key:'actions', status:'planned', chips:[
        { id:'scan',     label:'Scan'     }, { id:'cart',     label:'Cart'     },
        { id:'customer', label:'Customer' }, { id:'discount', label:'Discount' },
        { id:'pay',      label:'Pay'      } ] } ] },

    dashboard: { owner:'native', bars:[
      { key:'export', status:'planned', chips:[ { id:'export', label:'Export' } ] } ] }
  };

  /* Legacy route ids -> canonical ids. Phase 2 renamed several destinations; a merchant
     with a bookmark, an open tab, or a deep link on the old id must land on the right
     module rather than hit the unknown-route failure. Aliases resolve BEFORE the
     unknown-id check, so they are back-compat — not a silent fallback to Dashboard. */
  var ALIASES = {
    cashier:     'pos',       /* merged: Cashier was this same app at its checkout tab */
    /* `inventory` used to alias to POS, because Inventory was a TAB inside that app. It is a
       REAL native route again as of 2D-1C — not a reinstated duplicate, but the move of stock
       corrections onto their own server authority (merchantAdjustStock). The POS tab writes the
       canonical field through a path that also increments `sold`; the native route does not. So
       `#inventory` must resolve to the route that cannot record a correction as a sale.
       resolve() checks byId before ALIASES, so the entry is simply gone rather than shadowed. */
    /* Audit Log and POS Settings are POS TABS, not sidebar destinations. They were removed as
       rows once POS became the single in-shop surface — two sidebar entries that opened the same
       app at a different tab is exactly what the merge existed to end. Kept as aliases so any
       existing link or bookmark still lands somewhere real instead of failing loudly. */
    audit:         'pos',
    'pos-settings':'pos',
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
  /* Home is the MARKETPLACE (kind:'exit'), not the merchant dashboard.
     The dashboard is still a first-class route — it remains in the sidebar, the drawer, the
     ⌘K palette, and it is the destination the shell's Back resolves to — but the 🏠 label in
     a bottom bar means "the shop", and the merchant had no way back to it at all. Making the
     dashboard the thing called Home was what hid that: the button looked like an exit and
     behaved like a no-op for anyone already on it. */
  /* The Sell tab points at the NATIVE till, not the POS iframe. The label always said
     "Sell"; what it opened was a desktop-scale in-shop application inside a phone-sized
     panel. POS is unchanged and still reachable as its own sidebar destination — this
     retargets one button, it does not remove a surface. */
  var BOTTOM_NAV = [
    { id:'home',      icon:'🏠', label:'Home'   },
    { id:'orders',    icon:'🧾', label:'Orders' },
    { id:'sell',      icon:'💳', label:'Sell'   },
    { id:'__more',    icon:'☰',  label:'More'   }
  ];

  /* ── Known-good target vocabularies. Kept here so a typo is caught by the gate
        rather than by a merchant discovering a blank screen in a shop. ── */
  var SELLER_SECTIONS = ['overview','products','analytics','orders','customers','receipts',
    'messages','marketing','stories','tax','history','store','team','disputes','flash','pos'];
  var POS_TABS = ['pos','inventory','orders','customers','reports','finance','settings',
    'audit','bos','repair','more'];
  /* 'exit' is the only kind that LEAVES the shell. Every other kind mounts a destination
     inside /merchant; an exit performs a real full-page navigation and the shell is gone
     afterwards. It exists so the marketplace can be a bottom-nav destination without the
     registry lying about it: the alternative was a bottom-nav entry whose click handler
     quietly did something no route in this file described.
     An exit must NEVER be expressed as kind:'page' — that would iframe the destination and
     boot the entire customer application inside the merchant shell, which is the
     double-shell defect e0dbdca fixed. */
  var KINDS = ['native','pos','seller','page','exit'];
  /* 'hidden' = a real, routable destination that is NOT a sidebar row. My MiniShop lives here:
     it is reached from the header button, and having it in BOTH the header and the sidebar gave
     the seller two controls that looked like they might do different things. Still resolvable,
     still deep-linkable, simply not duplicated in navigation. */
  var TIERS = ['primary','more','hidden'];

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
      if (r.kind === 'exit') {
        if (!r.href)                             errs.push(at + ': exit route has no href');
        /* Root-relative only. An absolute URL would let a bottom-nav tap navigate the
           merchant off SOKONI entirely, and firebase.json sets cleanUrls:true, so a
           ".html" target 301-redirects on the way out. */
        else if (!/^\/[^/]*$/.test(r.href))      errs.push(at + ': href "' + r.href + '" must be a root-relative path with no host');
        else if (/\.html$/.test(r.href))         errs.push(at + ': href "' + r.href + '" ends in .html — cleanUrls:true 301-redirects it');
        if (r.src || r.sec || r.tab)             errs.push(at + ': exit route must not declare src/sec/tab — it does not mount anything');
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

    /* MORE_GROUPS must be a TOTAL PARTITION of the `more` tier — same both-directions
       guarantee PRIMARY_ORDER gets above, so a regroup cannot orphan a destination. */
    var grouped = {};
    MORE_GROUPS.forEach(function (g) {
      if (!g.key)   errs.push('a more-group has no key');
      if (!g.label) errs.push('more-group "' + g.key + '" has no label');
      (g.ids || []).forEach(function (id) {
        if (!byId[id]) errs.push('more-group "' + g.key + '" lists unknown route "' + id + '"');
        else if (byId[id].tier !== 'more')
          errs.push('more-group "' + g.key + '" lists "' + id + '" but its tier is "' + byId[id].tier + '"');
        if (grouped[id])
          errs.push('route "' + id + '" is in more-groups "' + grouped[id] + '" AND "' + g.key + '"');
        grouped[id] = g.key;
      });
    });
    ROUTES.forEach(function (r) {
      if (r.tier === 'more' && !grouped[r.id])
        errs.push('route "' + r.id + '" is tier:more but in no MORE_GROUPS group — it would have no sidebar position');
    });

    /* ── ACTION CHIPS ────────────────────────────────────────────────────────────
       The invariant: a chip is bound to a real handler, or it is not rendered. Both
       halves are enforced here. Whether a `live` handler actually exists in the owner's
       file is a cross-file fact this dependency-free module cannot see — that half is
       proven by scripts/test-merchant-actions.js, which greps the owning surface. */
    Object.keys(ACTIONS).forEach(function (id) {
      var a = ACTIONS[id], at = 'actions "' + id + '"';
      if (!byId[id])                            errs.push(at + ': not a registered route');
      else if (byId[id].kind === 'exit')        errs.push(at + ': an exit route mounts nothing and cannot own chips');
      if (ACTION_OWNERS.indexOf(a.owner) < 0)   errs.push(at + ': invalid owner "' + a.owner + '"');
      /* The declared owner must match how the route is actually mounted, or the gate would
         grep the wrong file and "prove" a handler that the merchant never reaches. */
      if (byId[id] && a.owner === 'native' && byId[id].kind !== 'native')
        errs.push(at + ': owner "native" but route kind is "' + byId[id].kind + '"');
      if (byId[id] && a.owner === 'seller' && byId[id].kind !== 'seller')
        errs.push(at + ': owner "seller" but route kind is "' + byId[id].kind + '"');
      if (byId[id] && a.owner === 'pos' && byId[id].kind !== 'pos')
        errs.push(at + ': owner "pos" but route kind is "' + byId[id].kind + '"');

      if (!Array.isArray(a.bars) || !a.bars.length) { errs.push(at + ': declares no bars'); return; }

      var barKeys = {}, handlers = {};
      a.bars.forEach(function (b) {
        var bat = at + ' bar "' + b.key + '"';
        if (!b.key)                             errs.push(at + ': a bar has no key');
        if (barKeys[b.key])                     errs.push(bat + ': duplicate bar key');
        barKeys[b.key] = true;
        if (ACTION_STATUS.indexOf(b.status) < 0) errs.push(bat + ': invalid status "' + b.status + '"');

        /* The two halves of the no-fake-button rule. */
        if (b.status === 'live' && !b.handler)  errs.push(bat + ': live bar must name a handler — an unbound chip is a decorative control');
        if (b.status === 'planned' && b.handler) errs.push(bat + ': planned bar must not name a handler — it is not rendered, so a handler here is a lie about what ships');

        /* Two bars on one route sharing a handler means one of them silently drives the
           other's state — the Orders tab bar and range bar are separate for a reason. */
        if (b.handler) {
          if (handlers[b.handler])              errs.push(bat + ': handler "' + b.handler + '" is already used by bar "' + handlers[b.handler] + '"');
          handlers[b.handler] = b.key;
          if (!/^__[A-Za-z][A-Za-z0-9]*$/.test(b.handler))
            errs.push(bat + ': handler "' + b.handler + '" must be a __-prefixed global, matching the shell\'s existing chip handlers');
        }

        if (!Array.isArray(b.chips) || !b.chips.length) { errs.push(bat + ': declares no chips'); return; }
        var chipIds = {};
        b.chips.forEach(function (c) {
          if (!c.id)                            errs.push(bat + ': a chip has no id');
          if (!c.label)                         errs.push(bat + ' chip "' + c.id + '": has no label');
          if (chipIds[c.id])                    errs.push(bat + ' chip "' + c.id + '": duplicate id');
          chipIds[c.id] = true;
        });
      });
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
    MORE_GROUPS: MORE_GROUPS,
    /* The grouped projection of the `more` tier. Returns [{key,label,routes[]}] in
       sidebar order. Because validate() enforces a total partition, the concatenation
       of every group's routes is exactly more() — the sidebar cannot show fewer. */
    moreGroups: function () {
      return MORE_GROUPS.map(function (g) {
        return {
          key: g.key, label: g.label,
          routes: g.ids.map(function (id) { return byId[id]; }).filter(Boolean)
        };
      });
    },
    ACTIONS: ACTIONS,
    ACTION_OWNERS: ACTION_OWNERS,
    /* Chips a destination offers. `status` filters to what is actually on screen:
       actions(id,'live') is what a merchant can touch right now, actions(id) is
       everything declared including the planned gaps. Returns [] for a route with no
       chips, so a caller never has to null-check before rendering. */
    actions: function (id, status) {
      var a = ACTIONS[this.resolve(id) || id];
      if (!a) return [];
      return a.bars
        .filter(function (b) { return !status || b.status === status; })
        .map(function (b) {
          return { key:b.key, owner:a.owner, status:b.status, handler:b.handler || null,
                   view:b.view || null, chips:b.chips.slice() };
        });
    },
    /* Every declared-but-unrendered bar, for the completion matrix and the gate report.
       This is the list that must shrink to empty before Merchant OS is "chip complete". */
    plannedActions: function () {
      var out = [];
      Object.keys(ACTIONS).forEach(function (id) {
        ACTIONS[id].bars.forEach(function (b) {
          if (b.status === 'planned')
            out.push({ route:id, bar:b.key, owner:ACTIONS[id].owner,
                       chips:b.chips.map(function (c) { return c.id; }) });
        });
      });
      return out;
    },
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
