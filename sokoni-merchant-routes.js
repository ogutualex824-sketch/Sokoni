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

    /* OFFERS & PROMOTIONS — the commercial layer over listings. Declared here because the
       sidebar is a PROJECTION OF THIS CONTRACT: a module registered without a route would
       mount but be unreachable, which is the "button with no destination" this file exists
       to prevent, inverted. The rules live in sokoni-promotion-model.js; this route only
       opens the surface that edits them. */
    { id:'offers', name:'Offers', icon:'🎁', tier:'primary',
      kind:'native',
      role:['seller','merchant'], ctx:[CTX.SELLER_UID, CTX.SHOP_ID],
      mobile:true, desktop:true, activeKey:'offers',
      note:'Bundles, buy-X-get-Y, happy hours, spend-and-save. Composes and previews through ' +
           'SokoniPromotionModel; no offer store is wired yet, and the surface says so rather ' +
           'than appearing to save into nothing.' },

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

    { id:'pos', name:'POS', icon:'🧮', tier:'primary', lineage:'till',
      kind:'pos', tab:'pos', entry:'pos-checkout.html?shell=merchant',
      role:['seller','merchant','cashier'], ctx:[CTX.SELLER_UID, CTX.SHOP_ID, CTX.BRANCH_ID],
      mobile:true, desktop:true, activeKey:'pos',
      note:'THE POS ENTRY POINT. `entry` moves what this route MOUNTS to pos-checkout.html — the ' +
           'till — while `tab` keeps naming the pos.html tab this route is the equivalent of, so ' +
           'the existing gate still cross-checks it against the real tab set. /pos is NOT ' +
           'replaced: it keeps its own route (`smartpos`) and its own panel, unchanged.\n' +
           'WHY THE TILL AND NOT THE APP: pos-checkout.html is the surface that calls ' +
           'posCompleteCheckout — the ONE till authority — and it is what a merchant pressing ' +
           '"POS" is asking for. pos.html is the wider in-shop application around it.\n' +
           'IN-SHELL, NOT AN EXIT. Expressing this as kind:\'exit\' to /pos-checkout was ' +
           'considered and refused: an exit destroys the shell, and the shell is where the ' +
           'printer GATT connection and the resolved merchant identity live (see the `devices` ' +
           'route). "Identity survives the transition" is a property of staying in the shell.\n' +
           'THE SETUP GATE IS UNCHANGED — the shell still shows pos-hardware-wizard.html first ' +
           'when posSetupComplete is unset, whatever `entry` names.\n' +
           'ONE in-shop surface. Cashier and Inventory used to be separate top-level routes that ' +
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

    { id:'orders', name:'Orders', icon:'🧾', tier:'primary', lineage:'till',
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

    { id:'till', name:'Till & QR', icon:'🏧', tier:'primary',
      kind:'native',
      role:['seller','merchant'], ctx:[CTX.SELLER_UID, CTX.SHOP_ID, CTX.BRANCH_ID],
      mobile:true, desktop:true, activeKey:'till',
      note:'Native surface (sokoni-merchant-till.js) on the Till/QR programme\'s own callables ' +
           '(getMySokoniTill / getSokoniTillActivity / mintDynamicSokoniQR / setSokoniTillStatus, ' +
           'functions/sokoni-till.js) — resolves the Till from the AUTHENTICATED shop/branch ' +
           'only, never a client-supplied Till id. Till issuance itself is server-side, automatic ' +
           'on merchant approval (docs/TILL_APPROVAL_AUTOMATION.md) — this surface reads and ' +
           'displays it, and mints dynamic (POS-sale) QRs; it does not itself create a Till.' },

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
      links:['shop','availability','pos-setup','devices','print-station','pos-hardware',
             'products','pos-import','inventory','supply','payments','till','pos-till-mgr',
             'pos-cash','deliveries','fulfilment','riders','kra-tax','receipts','staff',
             'manager-auth','pos-staff-ops','verification','plan'],
      note:'Native hub — the merchant\'s central configuration surface, grouped by DOMAIN ' +
           '(Business / Commerce / POS & Hardware / Delivery / Payments & Commission / ' +
           'Compliance / Staff). Every card ROUTES to the surface that already owns that ' +
           'setting; Settings itself owns no store and writes nothing.\n' +
           'COMMISSION is presented here and is DISPLAY-ONLY, read from the generated ' +
           'sokoni-commission-rates.js snapshot (SokoniCommission) whose single source is ' +
           'functions/commission-config.js and whose agreement with it is enforced by ' +
           'scripts/verify-commission-single-source.js on every deploy. Settings must never ' +
           'compute a rate: the platform already had NINE commission tables that disagreed.\n' +
           'Replaces the old target (POS settings tab), which was device config masquerading ' +
           'as merchant settings.' },

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


    /* SUPPLY — the merchant-to-merchant procurement workspace. Registered at tier:'more'
       deliberately: PRIMARY_ORDER is the founder's canonical sidebar and adding a 19th
       primary is a product decision, not an integration detail. `more` still projects into
       the desktop rail, the mobile More drawer and the command palette, so nothing is lost;
       promoting it later is a one-line change here and nowhere else.

       ctx declares SELLER_UID only, and that is not an oversight. Supply is keyed on a
       BUSINESS (businesses/{merchantId}), which the shell resolves separately through
       resolveMerchantContext — a different identifier space from activeShopId. Declaring
       SHOP_ID would gate this surface on a value it never uses and would imply the two are
       interchangeable, which is exactly the confusion Slice H exists to prevent. */
    { id:'supply', name:'Supply', icon:'📦', tier:'more',
      kind:'native',
      role:['seller','merchant'], ctx:[CTX.SELLER_UID],
      mobile:true, desktop:true, activeKey:'supply',
      note:'Buying, receiving, warehousing and supplying between businesses - separate from ' +
           'customer Sales. Reads only: every figure comes from the merchant-scoped ' +
           'procurement engine, and approve/send/receive/pay keep their own authority gates.' },
    { id:'pos-setup', name:'POS Setup', icon:'🖨️', tier:'more',
      kind:'page', src:'pos-printer-setup.html?shell=merchant',
      role:['seller','merchant','cashier'], ctx:[CTX.SELLER_UID],
      mobile:true, desktop:true, activeKey:'pos-setup' },

    /* ══ THE POS ECOSYSTEM ═══════════════════════════════════════════════════════
       Merchant V2 is the CONTROL SURFACE for the SmartPOS estate, not its owner. Every
       row below opens a module that already exists and already owns its own data; none
       of them re-implements anything, and none of them introduces a schema.

       ADMISSION IS EVIDENCE-BASED, not "the file exists". Each candidate was traced to
       the authority behind it (docs/MERCHANT_V2_ECOSYSTEM_MAP.md §3). A page whose data
       comes from a per-device IndexedDB store is NOT admitted, because putting it beside
       the canonical route for the same concept gives the merchant two answers that
       disagree and no way to tell which is real. The excluded set is declared in
       EXCLUDED below WITH ITS REASON — recorded, not silently dropped, and asserted by
       scripts/test-merchant-ecosystem.js so an exclusion cannot rot into an oversight.

       Every one is kind:'page' — an in-shell panel. Identity therefore survives the
       transition by construction: the shell stays mounted, and sokoni-inshell.js gives
       the module the shell's resolved merchant scope. Nothing here is an exit. */

    /* ── POS & Checkout ─────────────────────────────────────────────────────── */
    { id:'smartpos', name:'SmartPOS (full app)', icon:'🖥️', tier:'more',
      kind:'pos', tab:'pos',
      role:['seller','merchant','cashier'], ctx:[CTX.SELLER_UID, CTX.SHOP_ID, CTX.BRANCH_ID],
      mobile:true, desktop:true, activeKey:'smartpos',
      note:'/pos IS PRESERVED. The `pos` route now enters at the till (pos-checkout.html); ' +
           'this row keeps the unified SmartPOS application — its whole tab set, scanner, ' +
           'inventory, audit log — reachable as its own destination, unchanged. It declares ' +
           'no `entry`, so the shell mounts pos.html exactly as it always did. Removing /pos ' +
           'because the POS button moved was explicitly refused.' },

    { id:'pos-import', name:'Product Upload', icon:'📤', tier:'more',
      kind:'page', src:'pos-inventory.html?shell=merchant',
      role:['seller','merchant'], ctx:[CTX.SELLER_UID, CTX.SHOP_ID],
      mobile:true, desktop:true, activeKey:'pos-import',
      note:'The BULK UPLOADER — inventoryImportPreview / inventoryImportAiMap / ' +
           'inventoryImportCommit. Not a third inventory surface: `inventory` is stock ' +
           'CORRECTIONS (merchantAdjustStock) and `products` is the catalogue; this is the ' +
           'import pipeline that feeds them, and the brief requires it stay reachable.' },

    { id:'pos-stock-iq', name:'Stock Intelligence', icon:'🧠', tier:'more',
      kind:'page', src:'pos-inventory-intelligence.html?shell=merchant',
      role:['seller','merchant'], ctx:[CTX.SELLER_UID, CTX.SHOP_ID],
      mobile:true, desktop:true, activeKey:'pos-stock-iq',
      note:'getPOSInventoryIntelligence. Read-only analysis over stock the canonical ' +
           'surfaces own; it writes nothing.' },

    { id:'pos-shop', name:'Click & Collect', icon:'🛍️', tier:'more',
      kind:'page', src:'pos-marketplace.html?shell=merchant',
      role:['seller','merchant'], ctx:[CTX.SELLER_UID, CTX.SHOP_ID],
      mobile:true, desktop:true, activeKey:'pos-shop',
      note:'Marketplace <-> POS bridge, on sellers/{sellerId}/clickAndCollect and the ' +
           'pos-marketplace-sync CFs.' },

    /* ── Money, till and cash ────────────────────────────────────────────────── */
    { id:'pos-till-mgr', name:'Till Manager', icon:'💵', tier:'more',
      kind:'page', src:'pos-till-manager.html?shell=merchant',
      role:['seller','merchant','cashier'], ctx:[CTX.SELLER_UID, CTX.SHOP_ID, CTX.BRANCH_ID],
      mobile:true, desktop:true, activeKey:'pos-till-mgr',
      note:'Register/drawer sessions through smartPosDispatch (posMultiTill). DISTINCT from ' +
           'the `till` route, which is the SOKONI Till & QR programme (a payment ' +
           'destination). Same word, two different things — kept apart deliberately.' },

    { id:'pos-cash', name:'Cash Manager', icon:'🏦', tier:'more',
      kind:'page', src:'pos-cash-manager.html?shell=merchant',
      role:['seller','merchant'], ctx:[CTX.SELLER_UID, CTX.SHOP_ID],
      mobile:true, desktop:true, activeKey:'pos-cash',
      note:'Float, drops, pickups and shift reconciliation on cmRecordCashEvent via ' +
           'smartPosDispatch. The shift id it reconciles against is the one the till sends.' },

    { id:'pos-books', name:'Accounting', icon:'📒', tier:'more', lineage:'dispatch',
      kind:'page', src:'pos-accounting.html?shell=merchant',
      role:['seller','merchant'], ctx:[CTX.SELLER_UID, CTX.SHOP_ID],
      mobile:true, desktop:true, activeKey:'pos-books',
      note:'smartPosDispatch -> pos-accounting handlers. Presentation over the ledger; it ' +
           'is not a second money authority and computes no commission.' },

    /* ── Floor operations ───────────────────────────────────────────────────── */
    { id:'pos-floor', name:'Live Floor', icon:'📡', tier:'more',
      kind:'page', src:'pos-live-floor.html?shell=merchant',
      role:['seller','merchant'], ctx:[CTX.SELLER_UID, CTX.SHOP_ID],
      mobile:true, desktop:true, activeKey:'pos-floor',
      note:'Live posTillState / posTillEvents. Read-only board.' },

    { id:'pos-kds', name:'Kitchen Display', icon:'🍳', tier:'more',
      kind:'page', src:'pos-kds.html?shell=merchant',
      role:['seller','merchant'], ctx:[CTX.SELLER_UID, CTX.SHOP_ID],
      mobile:true, desktop:true, activeKey:'pos-kds',
      note:'kdsOrders. kitchen-display.html is the SECOND SCREEN for this — a customer/' +
           'kitchen-facing display meant for its own device, so it is deliberately NOT a ' +
           'sidebar row: embedding a wall screen in the merchant panel is not what it is for.' },

    { id:'pos-display', name:'Customer Display', icon:'📺', tier:'more',
      kind:'page', src:'pos-display.html?shell=merchant',
      role:['seller','merchant'], ctx:[CTX.SELLER_UID, CTX.SHOP_ID],
      mobile:true, desktop:true, activeKey:'pos-display',
      note:'posCustomerDisplays — pairs the second screen a customer reads at the counter.' },

    { id:'pos-daily', name:'Daily Run', icon:'📆', tier:'more',
      kind:'page', src:'pos-daily.html?shell=merchant',
      role:['seller','merchant'], ctx:[CTX.SELLER_UID, CTX.SHOP_ID],
      mobile:true, desktop:true, activeKey:'pos-daily',
      note:'Open/close-of-day over posAnalytics + canonical products.' },

    /* ── Hardware ───────────────────────────────────────────────────────────── */
    { id:'print-station', name:'Print Station', icon:'🧾', tier:'more',
      kind:'page', src:'print-station.html?shell=merchant',
      role:['seller','merchant','cashier'], ctx:[CTX.SELLER_UID],
      mobile:true, desktop:true, activeKey:'print-station',
      note:'Paper width and station config. DEVICE-LOCAL BY NATURE and therefore not a ' +
           'duplicate authority: which printer is plugged into THIS counter is a fact about ' +
           'this device, not about the business. That is the one case where localStorage is ' +
           'the right store, and it is why this page is admitted while pos-suppliers is not.' },

    { id:'pos-hardware', name:'Hardware Wizard', icon:'🔌', tier:'more',
      kind:'page', src:'pos-hardware-wizard.html?shell=merchant',
      role:['seller','merchant','cashier'], ctx:[CTX.SELLER_UID],
      mobile:true, desktop:true, activeKey:'pos-hardware',
      note:'The same wizard the POS setup gate shows on a first run. Registered so it is ' +
           'reachable ON PURPOSE afterwards, rather than only by being ambushed by it.' },

    { id:'manager-auth', name:'Manager Approval', icon:'🔐', tier:'more',
      kind:'page', src:'manager-auth.html?shell=merchant',
      role:['seller','merchant'], ctx:[CTX.SELLER_UID, CTX.SHOP_ID],
      mobile:true, desktop:true, activeKey:'manager-auth',
      note:'managerAuthRequests — the elevation a cashier raises and an owner answers. ' +
           'Requested here, granted by the server; this surface mints no permission.' },

    /* ── Intelligence ───────────────────────────────────────────────────────── */
    { id:'pos-bi', name:'Business Intelligence', icon:'📊', tier:'more', lineage:'dispatch',
      kind:'page', src:'pos-bi.html?shell=merchant',
      role:['seller','merchant'], ctx:[CTX.SELLER_UID, CTX.SHOP_ID],
      mobile:true, desktop:true, activeKey:'pos-bi',
      note:'Ten named CFs (getExecutiveDashboard, getRevenueDrilldown, getRevenueTrend, ...), ' +
           'all exported. KNOWN AND CARRIED, not introduced here: getCustomerGrowthMetrics is ' +
           'gated on a `sellerId` claim nothing mints, so that one tile is expected to come ' +
           'back empty. Registering the route does not change that; it is recorded so the ' +
           'next reader does not chase it as a new regression.' },

    { id:'pos-ai', name:'POS Assistant', icon:'🤖', tier:'more', lineage:'dispatch',
      kind:'page', src:'pos-ai.html?shell=merchant',
      role:['seller','merchant'], ctx:[CTX.SELLER_UID, CTX.SHOP_ID],
      mobile:true, desktop:true, activeKey:'pos-ai',
      note:'askPOSAssistant / getAIQueryHistory / clearAIQueryHistory, all exported.' },

    { id:'pos-hq', name:'Multi-branch HQ', icon:'🏢', tier:'more', lineage:'dispatch',
      kind:'page', src:'pos-hq.html?shell=merchant',
      role:['seller','merchant'], ctx:[CTX.SELLER_UID, CTX.SHOP_ID],
      mobile:true, desktop:true, activeKey:'pos-hq',
      note:'smartPosDispatch -> pos-hq handlers. Branch roll-up for a merchant running more ' +
           'than one shop.' },

    { id:'pos-crm', name:'Loyalty & Gift Cards', icon:'🎟️', tier:'more', lineage:'dispatch',
      kind:'page', src:'pos-crm-pro.html?shell=merchant',
      role:['seller','merchant'], ctx:[CTX.SELLER_UID],
      mobile:true, desktop:true, activeKey:'pos-crm',
      note:'Wallet, gift cards, store credit and tiers via smartPosDispatch (pos-crm-pro). ' +
           'ctx is SELLER_UID alone and deliberately so: _resolveSellerId falls back to ' +
           'auth.uid, so these records are ACCOUNT-scoped, not shop-scoped. NOT a duplicate ' +
           'of `customers` — that route owns crmCustomerProfiles (who the customer is); this ' +
           'owns the POS value instruments held against them.' },

    { id:'pos-staff-ops', name:'Shifts & Rosters', icon:'🗓️', tier:'more',
      kind:'page', src:'pos-staff-ops.html?shell=merchant',
      role:['seller','merchant'], ctx:[CTX.SELLER_UID, CTX.SHOP_ID],
      mobile:true, desktop:true, activeKey:'pos-staff-ops',
      note:'smartPosDispatch -> pos-staff-ops, which carries the CONVERGED tenant resolver ' +
           '(ownerUid -> canonical merchantId, membership verified through the capability ' +
           'engine). Rostering and shifts only — `staff` remains the sole authority over who ' +
           'is employed, on the shopEmployees contract. Two surfaces, one workforce authority.' },

  ];

  /* ══ CLASSIFIED OUT — declared, with the reason ═══════════════════════════════
     The brief asks for these to be CLASSIFIED before placement rather than exposed
     because they exist. Recording the verdict here is what makes it reviewable: a
     future reader can disagree with a reason, but cannot mistake an exclusion for an
     oversight. scripts/test-merchant-ecosystem.js asserts none of these is a route.

     class:
       device-local  its data lives in this browser's IndexedDB/localStorage, and a
                     CANONICAL route already owns the same concept. Exposing both gives
                     the merchant two answers that disagree.
       diagnostic    a bring-up, certification or telemetry surface. Real and useful;
                     not a thing a merchant operates their business through.
       preview       a second front end over a path that already has one.
       blocked       a genuine capability whose authority question is open. See `reason`.
       untracked     the file is not committed in this worktree, so a route to it would
                     resolve here and 404 in a clean checkout. Admit when it lands. */
  var EXCLUDED = [
    { route:'/pos-suppliers', class:'device-local', canonical:'supply',
      reason:'pos-suppliers.js stores suppliers, POs, GRNs and invoices in IndexedDB ' +
             '(sokoni_pos_suppliers_v2) and calls ZERO server authorities. `supply` already ' +
             'owns this concept on twelve server ops (listSuppliers, listPurchaseOrders, ' +
             'listGRNs, listSupplierInvoices, listWarehouseStock, findSuppliers, ...). Two ' +
             'supplier ledgers, one of them per-device, is the competing-database outcome.' },
    { route:'/pos-customers', class:'device-local', canonical:'customers',
      reason:'pos-customers.js stores customers and the loyalty ledger in IndexedDB ' +
             '(sokoni_pos_customers_v2), zero callables. `customers` owns this on ' +
             'crmCustomerProfiles, which firestore.rules scope to merchantId == auth.uid.' },
    { route:'/pos-reports', class:'device-local', canonical:'reports',
      reason:'pos-reports.js says so in its own header: "Works fully offline from IndexedDB ' +
             '— no Firestore reads required". It would show a merchant a REVENUE figure ' +
             'computed from one device\'s cache. `reports` runs AnalyticsEngine.compute(), ' +
             'the same engine as Analytics and Revenue, so the three cannot disagree.' },
    { route:'/pos-workspace', class:'device-local', canonical:'dashboard',
      reason:'_posSession / _posPrinters in localStorage only. A second "workspace" ' +
             'competing with the merchant workspace itself.' },
    { route:'/pos-onboard', class:'diagnostic', canonical:null,
      reason:'Business onboarding. pos.html deliberately STOPPED routing anyone into ' +
             'registration — an approved merchant on a new device was being pushed back ' +
             'through shop creation. A sidebar row offering it to an already-approved ' +
             'merchant reintroduces exactly that.' },
    { route:'/pos-v2', class:'preview', canonical:'pos',
      reason:'A second till front end that hands its cart to /pos-checkout ' +
             '(pos-v2.html:737) — the same money path, entered twice.' },
    { route:'/checkout-2-preview', class:'preview', canonical:null,
      reason:'A preview of the buyer checkout, and the buyer checkout is not a merchant ' +
             'surface at all — putting it in the merchant sidebar would hand a merchant the ' +
             'customer\'s screen. Its canonical counterpart (/checkout) is deliberately not a ' +
             'merchant route either.' },
    { route:'/pos-printer-hardware-test', class:'diagnostic', canonical:'pos-hardware',
      reason:'A printer bring-up harness: it drives the hardware directly to prove a device ' +
             'works, outside the receipt contract. Useful to an engineer at a counter, not a ' +
             'thing a merchant runs their shop through; pos-hardware is the merchant path.' },
    { route:'/pos-ios-print-test', class:'diagnostic', canonical:'pos-hardware',
      reason:'iOS print harness, and it opens /pos-checkout.html with target=_blank — a new ' +
             'tab is forbidden inside the shell.' },
    { route:'/pos-certification', class:'diagnostic', canonical:null,
      reason:'Certification evidence, not an operating surface.' },
    { route:'/pos-completeness', class:'diagnostic', canonical:null,
      reason:'The completion matrix — it reports how much of SmartPOS is built. That is a ' +
             'fact about the PLATFORM\'s progress, not about this merchant\'s business, and a ' +
             'merchant reading it would learn nothing they can act on.' },
    { route:'/pos-launch-report', class:'diagnostic', canonical:null,
      reason:'A release artefact recording what shipped in a launch. Platform history, not ' +
             'an operating surface; it changes only when SOKONI deploys, never when the ' +
             'merchant trades.' },
    { route:'/pos-observability', class:'diagnostic', canonical:null,
      reason:'Operational telemetry for whoever runs the platform — error rates, latencies, ' +
             'sync health. Its audience is SOKONI engineering; surfacing it to a merchant ' +
             'presents platform incidents as if they were their own shop\'s numbers.' },
    { route:'/kitchen-display', class:'diagnostic', canonical:'pos-kds',
      reason:'The SECOND SCREEN for the KDS, meant for its own device. `pos-kds` is the ' +
             'operator surface; a wall display does not belong in a merchant panel.' },
    /* ADMINOS. The brief asks that AdminOS "remain reachable where appropriate", and the
       appropriate place is not here. AdminOS is the PLATFORM operator's console; a merchant
       sidebar row pointing at it would be a privilege defect of exactly the kind this
       contract already refuses for revenue.html / revenue-dashboard.html (Super Admin pages
       on getAdminRevenueByHub / listCommissionRules). Nothing is taken away: an operator
       who also holds admin reaches AdminOS through the admin entry point, which is where
       the admin guard lives. Recorded here so the absence is a decision.

       AND, NAMED DELIBERATELY: the canonical AdminOS surface is admin-os.html.
       admin.html is NOT it and must never be wired from a merchant surface — writing the
       wrong one down is how a superseded console comes back. This row exists as much to
       fix the name as to record the exclusion. */
    { route:'/admin-os', class:'diagnostic', canonical:null,
      reason:'AdminOS (admin-os.html — NOT admin.html, which is superseded) is the platform ' +
             'operator console, not a merchant surface. A merchant row pointing at it would ' +
             'be the same privilege defect the contract already refuses for the Super Admin ' +
             'revenue pages. Reachable through the admin entry point, where the guard is.' },
    { route:'/catalogue', class:'untracked', canonical:null,
      reason:'catalogue.html is not committed in this worktree — another workstream\'s ' +
             'in-flight work. A row here would pass fs.existsSync locally and 404 in a ' +
             'clean checkout. One line to admit once it lands.' },
    { route:'/business-apply', class:'untracked', canonical:null,
      reason:'business-apply.html is not committed in this worktree. Same as above.' },
    { route:'void', class:'blocked', canonical:null,
      reason:'voidPOSSale is live and hardened (manager/supervisor/owner claim AND proven ' +
             'tenancy, one transaction for status + stock restore), reachable through ' +
             'smartPosDispatch. It is NOT surfaced because it voids from `posSales` while ' +
             'Merchant V2 Orders reads `posRetailSales`, and docs/POS_SALES_LIFECYCLE_AUDIT.md ' +
             '§2 measures those as DISJOINT: a sale is visible to one or the other by entry ' +
             'path, never both. A Void button here would list sales Orders cannot show and ' +
             'refuse every sale it can. That audit\'s §5 names the authority decision — which ' +
             'record IS the completed sale — as the thing that gates any fix, and it has not ' +
             'been taken. Refunds are unaffected and stay on their own path (a cashier ' +
             'REQUESTS, the owner APPROVES); refundRequests is never wired to a UI because ' +
             'writing it IS the refund.' },
  ];

  /* THE canonical sidebar order. Declared explicitly rather than inferred from position in
     ROUTES, so reordering the sidebar is a one-line, reviewable change and cannot be altered
     by accident when a route definition moves. Every id here must be tier:'primary', and every
     tier:'primary' route must appear here — validate() enforces both directions. */
  var PRIMARY_ORDER = [
    /* `offers` sits beside `products` because it is the commercial layer OVER listings —
       a merchant thinks "what I sell" and "what deal I run on it" in the same breath.
       PRIMARY_ORDER is an explicit list, not a tier filter, so a route declared with
       tier:'primary' and omitted here mounts but never appears — present and unreachable. */
    'dashboard', 'plan', 'sell', 'products', 'offers', 'inventory', 'pos', 'orders', 'analytics', 'revenue',
    'payments', 'till', 'deliveries', 'returns', 'receipts', 'staff', 'messages', 'disputes', 'settings'
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
      ids:['reports','availability','shop','fulfilment','riders','verification','supply'] },
    { key:'growth',     label:'Growth',
      ids:['marketing','flash-sale','stories','customers'] },
    /* KRA Tax groups with Operations rather than Main: it is back-office compliance
       configured once alongside Devices and POS Setup, not a surface a merchant reads
       daily the way they read Reports. */
    { key:'operations', label:'Operations',
      ids:['kra-tax','devices','pos-setup'] },

    /* ── THE ECOSYSTEM GROUPS ────────────────────────────────────────────────────
       The same total partition the groups above get. These five are additionally
       projected as the "Merchant Ecosystem" section in Settings — ONE list rendered
       twice, never two lists. `ecosystem: true` is what marks them, so the section is
       a filter over MORE_GROUPS rather than a second array in the HTML. */
    { key:'eco-pos',   label:'POS & Checkout',       ecosystem:true,
      ids:['smartpos','pos-import','pos-stock-iq','pos-shop'] },
    { key:'eco-money', label:'Money, Till & Cash',   ecosystem:true,
      ids:['pos-till-mgr','pos-cash','pos-books'] },
    { key:'eco-ops',   label:'Floor Operations',     ecosystem:true,
      ids:['pos-floor','pos-kds','pos-display','pos-daily'] },
    { key:'eco-hw',    label:'Hardware & Approvals', ecosystem:true,
      ids:['print-station','pos-hardware','manager-auth'] },
    { key:'eco-intel', label:'Intelligence',         ecosystem:true,
      ids:['pos-bi','pos-ai','pos-hq','pos-crm','pos-staff-ops'] }
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
  /* The two POS sale lineages. 'both' is reserved for a surface proven to read each —
     today only functions/pos-intelligence.js does, and it is not a route. */
  var LINEAGES = ['till','dispatch','both','none'];
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
        /* `entry` re-points what a pos route MOUNTS without weakening anything: it is held
           to the same shape as a page route's src, so it can never become an external URL
           or a legacy dashboard, and scripts/test-merchant-routes.js proves the file is
           real exactly as it does for src. Only a pos route may carry one — on any other
           kind it would be a second, unread target sitting beside the real one. */
        if (r.entry && FORBIDDEN_SRC.test(r.entry))
          errs.push(at + ': entry "' + r.entry + '" is external or a legacy dashboard target');
      }
      if (r.entry && r.kind !== 'pos')
        errs.push(at + ': only a pos route may declare an entry — on kind "' + r.kind + '" it is never read');

      /* ── WHICH SALES LINEAGE DOES THIS SURFACE READ? ────────────────────────────
         SOKONI has TWO complete POS sale lineages that never cross (measured: no writer
         touches both collections):

           till      posCompleteCheckout -> posRetailSales, reversed by posProcessRefund
           dispatch  recordPOSSale       -> posSales,       reversed by voidPOSSale

         A merchant selling through pos-checkout writes the TILL lineage. Five routed
         intelligence surfaces (pos-bi, pos-ai, pos-books, pos-hq, pos-crm) read
         `posSales` ONLY — so for that merchant they have no data to show. That is not a
         broken route; it is a route pointed at the other half of a split estate, and it
         stays declared here until the owner settles which record IS the completed sale
         (docs/MERCHANT_V2_POS_ECOSYSTEM_MAP_2026-09-22.md, blocker B-1).

         Declaring it is what stops the gap being invisible: a surface that reads sales
         and says nothing about which lineage is a surface nobody can reason about. */
      if (r.lineage && LINEAGES.indexOf(r.lineage) < 0)
        errs.push(at + ': invalid lineage "' + r.lineage + '" — must be one of ' + LINEAGES.join('/'));
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

    /* ── THE EXCLUSION LIST IS PART OF THE CONTRACT ──────────────────────────────
       A classified-out destination must stay classified out. If someone later adds a
       route for one, the exclusion has been overruled WITHOUT its reason being
       revisited — which is how a per-device supplier ledger ends up beside the
       canonical one. Checked in both directions: the exclusion must not name a live
       route, and it must not name a canonical counterpart that does not exist. */
    var EX_CLASSES = ['device-local','diagnostic','preview','blocked','untracked'];
    var exSeen = {};
    EXCLUDED.forEach(function (x) {
      var xat = 'exclusion "' + x.route + '"';
      if (!x.route)                          errs.push('an exclusion has no route');
      if (exSeen[x.route])                   errs.push(xat + ': duplicate');
      exSeen[x.route] = true;
      if (EX_CLASSES.indexOf(x.class) < 0)   errs.push(xat + ': invalid class "' + x.class + '"');
      if (!x.reason || x.reason.length < 40) errs.push(xat + ': needs a stated reason, not a label');
      if (x.canonical && !byId[x.canonical]) errs.push(xat + ': canonical "' + x.canonical + '" is not a route');
      /* '/pos-suppliers' excluded while a route mounted pos-suppliers.html would be the
         contradiction. Compare on the extensionless basename, the same way the visual
         gate does, so '?shell=merchant' and '.html' cannot hide it. */
      var base = String(x.route).replace(/^\//, '');
      if (!base) return;
      ROUTES.forEach(function (r) {
        var t = r.src || r.entry; if (!t) return;
        if (String(t).split(/[?#]/)[0].replace(/\.html$/, '') === base)
          errs.push(xat + ': route "' + r.id + '" mounts it anyway — the exclusion was overruled without its reason being answered');
      });
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
    /* The ecosystem section = the MORE_GROUPS marked `ecosystem`, in declaration order.
       A PROJECTION, not a second list: a route joins the ecosystem by being placed in an
       ecosystem group, and it is in exactly one group because validate() enforces a total
       partition. So the sidebar and the ecosystem section cannot drift, and a destination
       cannot appear in one and vanish from the other. */
    ecosystem: function () {
      return MORE_GROUPS.filter(function (g) { return g.ecosystem === true; })
        .map(function (g) {
          return { key:g.key, label:g.label,
                   routes:g.ids.map(function (id) { return byId[id]; }).filter(Boolean) };
        });
    },
    /* Destinations deliberately kept OUT of merchant navigation, each with its reason.
       Exposed so the Settings surface can say plainly that a thing was classified rather
       than forgotten, and so the gate can assert the classification still holds. */
    EXCLUDED: EXCLUDED,
    excluded: function (cls) {
      return EXCLUDED.filter(function (x) { return !cls || x.class === cls; })
        .map(function (x) { return { route:x.route, class:x.class, canonical:x.canonical, reason:x.reason }; });
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
