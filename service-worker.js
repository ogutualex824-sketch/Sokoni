/* ============================================================
   SOKONI SERVICE WORKER  v12.11
   Strategy:
     APP SHELL      â†' Cache First  (index.html as app shell)
     STATIC ASSETS  â†' Cache First  (CSS, JS â€" fast load)
     HTML PAGES     â†' Network First with Cache Fallback
     CDN RESOURCES  â†' Stale While Revalidate
     IMAGES         â†' Cache First (capped at 300 entries)
     Firebase/API   â†' Network Only (never cached)
   Offline fallback â†' /offline.html
   PWA: fullscreen, fast, installable
============================================================ */

/* Both of these bumps are load-bearing, not routine — each ships a precached
   module whose OLD copy is now actively wrong:

   v87 — session identity re-keyed to uid (RC1 Priority 2). session-manager.js is
   precached. The new Firestore rule requires request.resource.data.uid ==
   request.auth.uid on create, but the old cached module writes userEmail with no
   uid, so a stale client would have every session create denied.

   v88 — consent-layer removal (glass-overlay P0). security.js is precached. The
   old copy removes the blurred backdrop with a single setTimeout, which WebKit
   drops in a backgrounded tab, leaving a blur that renders at opacity 0. */
/* v101 — bumped so already-installed workers replace themselves. Without a bump
   the SKIP_CACHE_PATTERNS fix below never reaches users whose browser already
   holds v100, and Google sign-in would stay broken for exactly the people
   already affected. */
/* v103 — bumped to force clients off cached wallet JS. Static assets (incl.
   sokoni-wallet-v2.js) are Cache-First, so the send-money fix, payout load-race
   + double-tap guards, emoji/close-button/logo UI, and the More page never
   reached already-installed clients — hard-refresh can't beat Cache-First. This
   bump invalidates the old cache so every client re-fetches current assets. */
const CACHE_VERSION = "sokoni-20260804111406-v246";

/* ══════════════════════════════════════════════════════════════════════════════
   APP SHELL — the ONLY assets fetched during install.

   WHY (production incident, 2026-07-18). install used to precache 543 URLs
   (306 PRECACHE_PAGES + 237 PRECACHE_STATIC), every one a separate network fetch
   before the worker could activate. Measured on an iPhone 13 profile against
   production: the registration sat at {installing:true, active:null} and never
   activated across three consecutive visits. On Kenyan mobile it may never finish.

   Worse, each entry used `.add(u).catch(() => {})` inside Promise.allSettled, so
   EVERY failure was swallowed. install "succeeded" with an incomplete cache, and
   activate then deleted the previous WORKING cache — leaving clients with neither.
   That is why past deploys needed users to clear browser data by hand.

   The shell is now the minimum needed to render the marketplace home. Everything
   else — all other pages, images, media — caches lazily on first visit via the
   normal fetch handlers. Nothing below is optional: if any one of these fails,
   install REJECTS, the new worker never activates, and the previous worker keeps
   serving its intact cache. A failed update must be a no-op, never a downgrade.

   Keep this list SHORT. Every addition slows activation on the slowest network a
   real user is on, and makes a failed update more likely.
   ══════════════════════════════════════════════════════════════════════════════ */
const APP_SHELL = [
  "/",              /* marketplace home — the canonical root */
  "/offline",       /* honest offline fallback */
  "/style.css",
  "/mobile.css",
  "/script.js",
  "/manifest.json",
  "/favicon.ico",
  "/assets/icons/icon-192.png",
];
const STATIC_CACHE  = `${CACHE_VERSION}-static`;
const PAGES_CACHE   = `${CACHE_VERSION}-pages`;
const IMAGES_CACHE  = `${CACHE_VERSION}-images`;

/* NOTE: Firebase cleanUrls:true redirects all .html URLs to clean URLs.
   PRECACHE_PAGES must use the canonical (no .html) form so cache.add() succeeds.

   ⚠ RETIRED 2026-07-18 — NO LONGER FETCHED AT INSTALL. These two lists (543 URLs
   between them) are what made installation unreliable: the worker could not activate
   until all 543 had been fetched. They are kept only as a record of which routes are
   worth having offline; the fetch handlers cache these lazily on first visit, which
   achieves the same result without blocking activation.

   DO NOT wire these back into install(). If a route genuinely must survive a cold
   offline start, add it to APP_SHELL — and accept that every entry there slows
   activation on the slowest network a real user is on. */
const PRECACHE_PAGES = [
  "/", "/?source=pwa", "/offline",
  "/login", "/signup", "/category", "/services",
  "/product", "/cart", "/profile",
  "/pay",
  "/notifications", "/unboxing", "/reviews",
  "/seller", "/checkout", "/messages",
  "/wishlist", "/wallet", "/track",
  "/flashsale", "/driver", "/food",
  "/food-menu", "/food-cart", "/food-order", "/food-dashboard", "/food-rider",
  "/healthcare", "/entertainment", "/car-hub",
  "/car-rental", "/pos", "/pos-checkout", "/pos-display",
  "/delivery", "/delivery-tracking",
  "/bnb", "/landlord", "/property",
  "/community", "/digital", "/b2b",
  "/b2b-supplier", "/b2b-rfq", "/b2b-dashboard",
  "/b2b-seller-dashboard", "/b2b-orders", "/b2b-chat",
  "/banking", "/sports-hub", "/fitness-hub",
  "/tech-hub", "/legal-hub", "/legal",
  "/inspiq", "/opportunity", "/ministore",
  "/subscriptions", "/loyalty", "/referral",
  "/invoice", "/dispute", "/requests",
  "/store", "/providers", "/provider",
  "/business-os", "/admin",
  "/ent-organizer",
  "/home-services", "/cleaning", "/construction",
  "/electrical", "/mechanics", "/phone-repair", "/plumbing",
  "/life-events", "/marketing",
  "/offer", "/success", "/trust",
  "/register", "/seller-public", "/bnb-manage",
  "/payments", "/revenue", "/seller-revenue",
  "/property-hub", "/property-listing", "/property-agent",
  "/property-dashboard", "/property-agent-dashboard",
  "/bnb-hub",
  "/marketing-hub",
  "/sports-tournament", "/sports-venue",
  "/businesses", "/business",
  "/search", "/verification", "/verification-admin",
  "/growth-dashboard",
  "/seller-analytics", "/business-analytics", "/customer-analytics",
  "/monitor", "/email-center",
  "/onboarding", "/provider-onboarding", "/provider-dashboard",
  "/onboarding-seller", "/onboarding-driver", "/onboarding-professional",
  "/help", "/moderation",
  "/beta", "/beta-dashboard",
  "/seller-success", "/driver-success", "/join", "/support", "/launch-metrics", "/launch-readiness", "/merchant-pipeline",
  "/ride-book",
  "/jobs", "/education", "/superadmin", "/scan",
  "/inventory",
  "/inv-dashboard",
  "/inv-products",
  "/inv-product",
  "/creative-studio",
  "/ai-subscriptions",
  "/admin-subscriptions",
  "/subscription-os",
  "/chat",
  "/admin-messages",
  "/commission-engine",
  "/subscription-billing",
  "/financial-os",
  "/trust-safety",
  "/admin-os",
  "/privacy",
  "/terms",
  "/data-deletion",
  /* SmartPOS extended pages (moved from PRECACHE_STATIC — cleanUrls:true requires no .html) */
  "/pos-workspace", "/pos-hardware-wizard",
  "/pos-accounting", "/pos-crm-pro", "/pos-staff-ops",
  "/pos-hq", "/pos-bi", "/pos-ai",
  "/pos-onboard", "/pos-daily", "/pos-observability", "/pos-marketplace",
  "/pos-kiosk", "/print-station", "/pos-printer-setup", "/manager-auth", "/commissioning",
  /* Platform admin portals */
  "/security-center",
  "/executive-dashboard", "/release-readiness", "/developer-portal", "/wholesale-portal",
  /* Hub pages */
  "/event-hub", "/event-manager",
  "/gip", "/wap", "/ecc", "/sasos-admin", "/platform",
  "/availability-manager",
  /* Navigation & Dispatch */
  "/rider-nav", "/fleet-monitor",
  /* Jobs, Disputes */
  "/dispute-portal", "/job-post",
  /* Infrastructure monitors */
  "/redis-monitor", "/async-jobs",
  /* Revenue & Earnings (2026-07-06) */
  "/seller-earnings", "/revenue-dashboard",
  /* Subscription portal (2026-07-06) */
  "/my-subscriptions",
  /* Financial OS admin console (2026-07-06) */
  "/fos-admin",
  /* Seller acquisition landing page (2026-07-07) */
  "/sell",
  /* ── Comprehensive page sweep (2026-07-07) ── */
  /* Public / informational */
  "/about", "/careers", "/contact", "/faq", "/feedback", "/press",
  "/cookie-policy", "/refund-policy", "/returns-policy", "/returns",
  "/community-guidelines", "/provider-terms", "/seller-terms", "/privacy",
  "/plans", "/launch",
  /* Commerce & Finance */
  "/commerce-os", "/procurement", "/general-ledger", "/hr-payroll",
  "/expense-management", "/franchise", "/warehouse-scanner",
  "/finos", "/finos-admin", "/payment-receipt", "/payment-security",
  /* Admin portals */
  "/admin-feedback", "/commission-admin", "/crm", "/hub-dashboard",
  "/minishop-admin", "/ops-center", "/ops-dashboard", "/qr-center",
  "/reliability-center", "/security-compliance", "/security-zero-trust-dashboard",
  "/sokoni-cert", "/uat-center", "/super-admin", "/partner-portal",
  /* SmartPOS extended */
  "/pos-certification", "/pos-customers", "/pos-inventory",
  "/pos-inventory-intelligence", "/pos-launch-report", "/pos-reports",
  "/pos-setup", "/pos-suppliers", "/kitchen-display",
  /* Seller tools */
  "/merchant-success", "/loyalty-merchant", "/seller-delivery",
  "/seller-wallet", "/dispatch", "/coupon-manager", "/feeds",
  /* KASS AI portals */
  "/kass-developer", "/kass-executive", "/kass-finance",
  "/kass-manager", "/kass-seller", "/kass-support",
  /* Customer-facing */
  "/customer-display", "/payment-receipt",
  /* Platform & Enterprise */
  "/automation-engine", "/enterprise-certification", "/enterprise-ops",
  "/platform-health", "/platform-hub", "/vision-2030",
  "/business-health", "/business-kpi",
  /* Listings & Digital marketplace */
  "/digital-esoko", "/digital-esoko-seller",
  "/minishop", "/minishop-status",
  /* Venue & Booking */
  "/venue-booking", "/venue-manager",
  /* Finance & inventory */
  "/inv-ai", "/tenant-portal",
  /* Messaging admin */
  "/messages-admin",
  /* ── SW Recovery Sprint v63 — 40 routes discovered in audit 2026-07-13 ── */
  "/404",
  "/analytics", "/observability",
  "/api-gateway", "/webhooks",
  "/auction", "/auction-manager",
  "/automation-center",
  "/digital-store", "/rental",
  "/email-preview",
  "/etims-admin", "/etims-seller",
  "/finance-budget", "/finance-expenses", "/finance-invoices",
  "/finance-reconcile", "/settlement-dashboard",
  "/fleet-manager", "/rider-dashboard", "/route-planner",
  "/legal-admin", "/legal-centre",
  "/logistics-reports",
  "/pos-cash-manager", "/pos-completeness",
  "/pos-kds", "/pos-live-floor", "/pos-till-manager",
  "/status", "/trust-and-safety",
  "/task-queue", "/warehouse",
  /* iOS / cross-platform print certification */
  "/pos-ios-print-test",
];

const PRECACHE_STATIC = [
  "/style.css", "/mobile.css", "/script.js", "/sokoni-inv-shell.css", "/sokoni-inv-shell.js", "/sokoni-quality.css", "/sokoni-form-nav.js", "/leaflet.min.js", "/leaflet.min.css",
  "/manifest.json", "/assets/sokoni logoo.jpeg", "/assets/logosokoni.png",
  /* Notification artwork. The push handler runs when the tab is closed and often when the
     device is on a poor connection — if the icon isn't already cached, the notification
     renders with the browser's generic bell instead of the SOKONI logo. */
  "/assets/icons/icon-192.png", "/assets/icons/icon-96.png", "/favicon.ico",
  "/auth.css", "/checkout.css", "/premium.css",
  "/product.css", "/profile.css", "/seller.css",
  "/landlord.css", "/compact-grid.css", "/sokoni-premium-v2.css",
  "/sokoni-hscroll.css", "/sokoni-home-v3.css",
  "/auth.js", "/sokoni-db.js", "/sokoni-pay.js", "/sokoni-social.js", "/sokoni-referral.js",
  "/sokoni-desktop.css", "/sokoni-routing.js", "/sokoni-delivery.js", "/sokoni-delivery-pricing.js", "/sokoni-dispatch.js", "/sokoni-logistics.js", "/sokoni-invoice.js", "/sokoni-config.js", "/sokoni-mpesa.js", "/sokoni-revenue.js", "/sokoni-featured.js",
  "/category.js", "/profile.js", "/product.js", "/analytics.js",
  "/security.js", "/sokoni-company.js", "/nav-active.js", "/splash.js", "/scroll-top.js",
  "/auth-guard.js", "/shared-header.js", "/entertainment-hub.js", "/delivery-hub.js",
  "/sokoni-carhub-pro.js", "/sokoni-banking-pro.js", "/sokoni-food.js", "/sokoni-security.js", "/sokoni-audit.js", "/sokoni-b2b.js",
  "/sokoni-property.js", "/sokoni-bnb.js", "/sokoni-sports.js", "/sokoni-marketing.js", "/sokoni-inbox.js",
  "/sokoni-ui-extras.js", "/sokoni-ui-manager.js", "/sokoni-sync.js",
  "/hub-wiring.js", "/sokoni-guards.js", "/kass-widget.js", "/sokoni-loyalty.js", "/hub-register.js", "/sokoni-spotlight.js",
  "/sokoni-scale.js", "/sokoni-queue.js", "/sokoni-pos-resilience.js",
  "/sokoni-cache.js", "/sokoni-search.js", "/sokoni-monitor.js",
  "/sokoni-permissions.js", "/access-control.js", "/monitor.js", "/sokoni-trust.js", "/sokoni-offers.js", "/sokoni-verifications.js",
  "/sokoni-beta.js", "/beta-widget.js", "/sokoni-launch.js",
  "/sokoni-alerts.js", "/sokoni-upload.js", "/sokoni-share.js", "/sokoni-recommendations.js", "/sokoni-init.js",
  /* AI Creative Studio + AI Subscriptions + Subscription OS */
  "/sokoni-geo.js",
  "/sokoni-media.js", "/sokoni-creative.js", "/sokoni-ai-subscriptions.js",
  "/sokoni-entitlement.js", "/sokoni-subscription-brain.js",
  /* Enterprise v2.0 modules */
  "/sokoni-qr.js", "/sokoni-barcode.js", "/sokoni-receipt-engine.js", "/sokoni-event-bus.js", "/sokoni-observability.js", "/sokoni-service-mesh.js", "/sokoni-gateway.js",
  "/sokoni-payment-engine.js", "/sokoni-fraud-engine.js", "/sokoni-webhook-engine.js", "/sokoni-search-pro.js",
  "/firebase.js", "/seller.js", "/cart.js", "/checkout.js",
  "/inventory-manager.js", "/market-actions.js",
  "/seo.js", "/session-manager.js", "/scroll-memory.js",
  "/sw-register.js", "/pos-terminals.js",
  "/etims.js", "/inspiq.js",
  /* SmartPOS core modules */
  "/pos.css", "/pos-bos.css", "/pos-mobile.css",
  "/sokoni-profile-switcher.js", "/sokoni-provider.js",
  "/pos.js", "/pos-db.js", "/pos-printer.js", "/sokoni-print-engine.js", "/sokoni-universal-printer.js", "/sokoni-bluetooth-printer.js", "/sokoni-printer-manager.js", "/sokoni-pos-ios-print.js", "/sokoni-pos-print-service.js", "/pos-health.js", "/pos-idempotency.js", "/pos-sync.js", "/sokoni-pos-resilience.js", "/pos-omni.js", "/pos-barcode.js",
  "/pos-ai.js", "/pos-analytics.js", "/pos-boss.js", "/pos-plugins.js",
  "/pos-voice.js", "/pos-ai-engine.js", "/pos-finance.js", "/pos-audit.js",
  "/pos-modules.js", "/pos-scanner.js", "/pos-mobile.js",
  "/pos-manager-auth.js",
  "/pos-device-manager.js",
  /* SmartPOS 2.0 — Multi-device session + Terminal Driver */
  "/pos-session-manager.js", "/pos-terminal-driver.js",
  /* SmartPOS 2.1 — Receipt Engine, Workspace, Analytics Widget */
  "/pos-receipt-engine.js", "/pos-analytics-live.js",
  /* SmartPOS 3.0 — Enterprise BOS Pages & Hardware Layer */
  "/pos-hardware-wizard.js",
  /* SmartPOS 4.0 — Polish, Scale & Market Readiness */
  "/pos-loyalty-engine.js",
  /* Inventory Management System V1+V2 */
  "/sokoni-inventory.js",
  "/sokoni-inventory-v2.js",
  /* Tracking & Location */
  "/sokoni-gps-manager.js", "/sokoni-map-manager.js", "/sokoni-route-manager.js",
  "/sokoni-tracking.js", "/sokoni-tracking-manager.js",
  /* GIP — Geo Intelligence Platform */
  "/sokoni-gip.js", "/sokoni-gip-dispatch.js", "/sokoni-gip-analytics.js",
  "/sokoni-gip-router.js", "/sokoni-gip-fleet.js", "/sokoni-gip-api.js",
  /* AI Policy Engine + Enterprise Intelligence Platform */
  "/sokoni-ai-policy.js",
  "/sokoni-decision-engine.js", "/sokoni-data-quality.js",
  "/sokoni-feature-flags.js", "/sokoni-intelligence-log.js",
  "/sokoni-eip.js",
  /* Workflow Automation Platform */
  "/sokoni-wap.js", "/sokoni-wap-definitions.js",
  /* Enterprise Control Center */
  "/sokoni-ecc.js",
  /* SASOS — Universal AI Subscription Operating System */
  "/sokoni-sasos.js",
  /* Platform Registry + Event Bus + Operations Center */
  "/sokoni-platform.js",
  /* Commerce — Orders, Notifications, Subscriptions, Vouchers */
  "/sokoni-orders.js", "/sokoni-notifications.js",
  "/sokoni-subscriptions.js", "/sokoni-vouchers.js", "/sokoni-intasend.js",
  /* Vertical — Health, Construction */
  "/sokoni-health.js", "/sokoni-construct.js",
  /* Search Engine — federated, Typesense, Firestore fallback, recommendations */
  "/sokoni-search-engine.js", "/sokoni-typesense-engine.js",
  "/sokoni-firestore-search.js", "/sokoni-search-recommendations.js",
  /* Infrastructure */
  "/sokoni-env.js", "/sokoni-logger.js",
  /* Auth & Access */
  "/adult-gate.js", "/age-gate.js", "/contact-guard.js",
  "/provider-wiring.js", "/seller-wiring.js",
  /* Utilities */
  "/realtime.js", "/wishlist.js", "/provider-status.js",
  "/sports-hub.js", "/management-init.js",
  /* ── Architecture Layer v1.0 ── */
  "/sokoni-tokens.css", "/sokoni-ui.js", "/sokoni-layout.js", "/sokoni-bootstrap.js",
  "/sokoni-mobile-fixes.css", "/sokoni-responsive.css",
  /* ── Enterprise Notification Center v1.0 ── */
  "/sokoni-notif-engine.js", "/sokoni-notif-center.js",
  /* ── Business Communication System v1.0 ── */
  "/sokoni-chat-engine.js",
  /* ── Subscription & Billing Engine v1.0 ── */
  "/sokoni-subscription.js",
  /* ── Universal Availability & Scheduling Engine v1.0 ── */
  "/sokoni-availability.js",
  /* ── Reviews & Ratings ── */
  "/sokoni-reviews.js",
  /* ── Navigation & Dispatch v1.0 ── */
  "/sokoni-navigation.js", "/sokoni-appcheck.js",
  /* ── Loyalty v2 + Wallet v2 + Jobs Hub ── */
  "/sokoni-wallet.js", "/sokoni-jobs.js",
  /* ── Merchant success ── (sokoni-delivery-pricing.js already in line 120) */
  "/sokoni-merchant-success.js",
  "/sokoni-payment-trust.js",
  /* ── Mobile Drawer UX + Role-Based Navigation Engine ── */
  "/sokoni-drawers.css", "/sokoni-drawer.js",
  "/sokoni-nav-engine.css", "/sokoni-nav-engine.js",
  "/sokoni-form-engine.css", "/sokoni-form-engine.js",
  /* ── Redis Infrastructure Layer v1.0 ── */
  "/sokoni-redis.js",
  /* ── Async Jobs Engine v1.0 ── */
  "/sokoni-async-jobs.js",
];

const CDN_ORIGINS = [
  "cdnjs.cloudflare.com", "unpkg.com", "cdn.jsdelivr.net",
  "fonts.googleapis.com", "fonts.gstatic.com",
];

const SKIP_CACHE_PATTERNS = [
  "firebase", "firestore",
  /* Both spellings on purpose. "googleapis.com/identitytoolkit" is the LEGACY
     endpoint (https://www.googleapis.com/identitytoolkit/v3/...). Firebase Auth
     v9+ calls https://identitytoolkit.googleapis.com/v1/... — the host form,
     which the legacy pattern does NOT match, so auth API calls were silently
     still passing through the worker. They happened to survive it, which is why
     email/password kept working, but nothing guaranteed that. */
  "googleapis.com/identitytoolkit",
  "identitytoolkit.googleapis.com",
  "securetoken.googleapis.com",
  "maps.googleapis.com",
  "maps.gstatic.com",
  /* Connectivity probe (sokoni-ui.js / sokoni-offline.js). MUST bypass the service
     worker entirely. It previously fell through to networkFirst(), which caches the
     response and replays it from cache when the network fails — so the probe always
     resolved and a genuine outage could never be detected. The probe is only a valid
     connectivity signal if it always hits the real network. */
  "generate_204",
  "/__/",           /* Firebase reserved namespace — auth handler + iframe; must always hit network */
  /* Firebase Auth's OAuth helper (gapi). THIS BROKE GOOGLE SIGN-IN ON EVERY
     DEVICE. signInWithPopup/Redirect load https://apis.google.com/js/api.js to
     create the auth relay. It matched no skip pattern and is not a CDN origin,
     so it fell through to the caching path; the cross-origin response comes back
     opaque and the script fails to execute. Firebase's loader reports that as
     `n.onerror` → the catch-all `auth/internal-error`, so the user completed the
     whole Google round-trip and was then bounced back to login.

     Proven by controlled experiment against production:
       service worker registered -> apis.google.com/js/api.js ONERROR
       service worker blocked    -> LOADED (gapi = object)
     Same page, same network, only the SW differing. It also explains why
     clearing browsing data appeared to help — that unregisters the worker — and
     why email/password sign-in kept working: identitytoolkit was already
     skipped just above, so only the OAuth providers were affected. */
  "apis.google.com",
];


/* -- Global uncaught error handler: prevents silent SW death -- */
self.onerror = (msg, src, line, col, err) => {
  console.error("[SW] Uncaught error:", msg, { src, line, col, err });
};
self.addEventListener("unhandledrejection", event => {
  console.error("[SW] Unhandled promise rejection:", event.reason);
});
/* â"€â"€ INSTALL â"€â"€ */
self.addEventListener("install", event => {
  /* Fetch ONLY the app shell, and treat it as all-or-nothing.
     If any shell asset fails, this promise rejects: the browser discards the new
     worker, activate never runs, and the currently-installed worker keeps serving
     its complete cache. A broken update leaves the user exactly where they were.

     skipWaiting is called only AFTER the shell is fully cached, so a half-built
     cache can never take control. Session state (auth, cart, POS) lives in
     Firebase + localStorage, never in the SW, so forced activation stays safe. */
  event.waitUntil((async () => {
    const sc = await caches.open(STATIC_CACHE);
    const pc = await caches.open(PAGES_CACHE);

    /* Pages go in PAGES_CACHE so navigation lookups find them; assets in STATIC_CACHE. */
    const isPage = (u) => u === "/" || !/\.[a-z0-9]+$/i.test(u);

    const results = await Promise.allSettled(
      APP_SHELL.map(async (u) => {
        const res = await fetch(new Request(u, { cache: "reload" }));
        /* A 404/500 still resolves the fetch — check explicitly or we would cache
           an error page as the app shell. */
        if (!res.ok) throw new Error(u + " -> HTTP " + res.status);
        await (isPage(u) ? pc : sc).put(u, res.clone());
        return u;
      })
    );

    const failed = results
      .map((r, i) => (r.status === "rejected" ? APP_SHELL[i] + " (" + r.reason.message + ")" : null))
      .filter(Boolean);

    if (failed.length) {
      /* Abort the update. Do NOT skipWaiting, do NOT let activate run.
         Tell any open client which asset failed BEFORE throwing — once this worker
         goes redundant it can no longer report, and a silent failed install is exactly
         the blind spot this whole exercise exists to remove. */
      console.error("[SW] Shell incomplete — aborting update:", failed);
      try {
        const cs = await self.clients.matchAll({ type: "window" });
        cs.forEach(c => c.postMessage({
          type: "SW_SHELL_FAILED",
          asset: failed[0],
          count: failed.length,
          version: CACHE_VERSION,
        }));
      } catch (e) { /* reporting must never mask the real failure */ }
      throw new Error("App shell incomplete: " + failed.join("; "));
    }

    const clients = await self.clients.matchAll({ type: "window" });
    clients.forEach(c => c.postMessage({ type: "SW_UPDATE_READY", version: CACHE_VERSION }));

    await self.skipWaiting();
  })());
});

/* Client sends SKIP_WAITING (or SW_SKIP_WAITING for back-compat) when safe */
self.addEventListener("message", event => {
  if (event.data?.type === "SKIP_WAITING" || event.data?.type === "SW_SKIP_WAITING") self.skipWaiting();

  /* Observability: sokoni-root-guard.js asks which cache version is live, so an anomaly
     report can name the exact build that produced it without the user reproducing it. */
  if (event.data?.type === "GET_VERSION" && event.ports && event.ports[0]) {
    event.ports[0].postMessage({ version: CACHE_VERSION });
  }
});

/* ── ROOT TEMPLATE INTEGRITY ──────────────────────────────────────────────────
   Before the SW hands back a CACHED "/", it verifies the document actually is the
   marketplace shell. index.html declares:

       <meta name="sokoni-page" content="marketplace-home">

   If a cached root ever holds a merchant template — however it got there — serving it
   would render a store page at the bare domain, which is the reported bug. The cached
   entry is deleted and the caller falls through to the network instead.

   Reading the body costs a clone + a text decode, so it runs ONLY for the root key, not
   for every cached page. */
const ROOT_TEMPLATE = "marketplace-home";

async function rootCacheIsValid(response) {
  try {
    if (!response) return false;
    /* The identifier is in the first 2 KB of <head>; no need to decode a 200 KB document. */
    const head = (await response.clone().text()).slice(0, 4096);
    const m = head.match(/<meta\s+name=["']sokoni-page["']\s+content=["']([^"']+)["']/i);
    /* P0 2026-07-19 — this used to `return true` when the tag was absent, on the
       reasoning that an older build without the marker should be trusted rather than
       thrashed. That default is what let the homepage render a Store Profile.

       Absence of the tag was treated as evidence of validity. It is not. ANY cached
       document lacking the marker could occupy the root slot and be served for "/"
       forever — URL unchanged, store content rendered. ministore.html carried no tag,
       which is precisely how a store page could masquerade as the homepage.

       The root key now requires POSITIVE identification. An unidentified document is
       not the homepage, so it is evicted and refetched. The cost of being wrong here
       is one network request; the cost of the old default was a wrong homepage that
       survived every reload. Fail CLOSED for the root, specifically. */
    if (!m) return false;
    return m[1].trim() === ROOT_TEMPLATE;
  } catch (e) {
    /* A decode error is not evidence either way, but the root is the one URL where
       serving the wrong document is unrecoverable for the user. Refetch instead. */
    return false;
  }
}

/* ══════════════════════════════════════════════════════════════════════════════
   WRITE-SIDE ROOT INTEGRITY

   rootCacheIsValid() protects the READ. This protects the WRITE, which is where the
   poisoning actually originated.

   The write path that could do it (2026-07-19): in the page handler, a redirected
   response was cached under the ORIGINAL request key whenever the final path differed
   from the requested path —

       if (!isSelf) cache.put(request, res.clone());

   Navigations return early via Response.redirect(), so they were safe. A NON-navigate
   fetch of "/" that redirected elsewhere — a prefetch, a warm-up, any fetch() from
   page JS — stored the redirect target's document under the "/" key. That is a store
   page becoming the homepage, written by the cache layer itself.

   Rather than patch that one branch, every HTML write now goes through here. The rule
   is narrow and total: a document may only be written under the root key if it
   positively identifies as the root template. Anything else is dropped, silently and
   safely — a missing cache entry costs one network fetch, a poisoned root costs the
   homepage.
   ══════════════════════════════════════════════════════════════════════════════ */
function isRootKey(request) {
  try {
    const p = new URL(typeof request === "string" ? request : request.url, self.location.origin).pathname;
    return p === "/" || p === "/index.html" || p === "/index";
  } catch (e) { return false; }
}

/* The ONLY sanctioned way to put a document into a page cache. */
async function safeCachePut(cache, request, response) {
  try {
    if (!response || !response.ok) return false;
    if (isRootKey(request)) {
      /* Reject a redirected response whose final path is not the root: whatever it is,
         it is not the homepage, and it must never occupy the homepage's key. */
      if (response.redirected) {
        try {
          const finalPath = new URL(response.url).pathname;
          if (!(finalPath === "/" || finalPath === "/index.html" || finalPath === "/index")) return false;
        } catch (e) { return false; }
      }
      if (!(await rootCacheIsValid(response.clone()))) return false;
    }
    await cache.put(request, response);
    return true;
  } catch (e) { return false; }
}

/* Drop every cached spelling of the root so the next fetch repopulates from network. */
async function purgeRootFromCaches() {
  try {
    const names = await caches.keys();
    await Promise.all(names.map(async (n) => {
      const c = await caches.open(n);
      await Promise.all([
        c.delete("/"), c.delete("/index.html"), c.delete("/?source=pwa"),
      ].map((p) => p.catch(() => {})));
    }));
  } catch (e) { /* best effort */ }
}
const TILE_CACHE = "sokoni-tiles-v1";   /* shared constant — tiles survive SW version bumps */

self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    /* Keep current version caches + the persistent tile cache (map tiles are expensive to re-fetch) */
    const valid = new Set([STATIC_CACHE, PAGES_CACHE, IMAGES_CACHE, TILE_CACHE]);
    const keys  = await caches.keys();
    await Promise.all(keys.filter(k => !valid.has(k)).map(k => caches.delete(k)));
    await self.clients.claim();
    /* Welcome notification is handled by sw-register.js on appinstalled event,
       not here â€" this activate fires on every update, not just first install */
  })());
});

/* â"€â"€ FETCH â"€â"€ */
self.addEventListener("fetch", event => {
  const { request } = event;
  const url = new URL(request.url);

  if (request.method !== "GET") return;
  if (SKIP_CACHE_PATTERNS.some(p => request.url.includes(p))) return;
  /* Skip service worker for file:// â€" direct file opens should never hit offline.html */
  if (url.protocol === "file:") return;
  if (!["https:", "http:"].includes(url.protocol)) return;

  /* CDN â†' Stale While Revalidate */
  if (CDN_ORIGINS.some(o => url.hostname.includes(o))) {
    event.respondWith(staleWhileRevalidate(request));
    return;
  }

  const ext = url.pathname.split(".").pop().toLowerCase();

  /* Map tiles → Cache-first with 7-day TTL for offline-first navigation.
     Tile domains: OpenStreetMap, CartoDB, ESRI ArcGIS, OpenTopoMap.
     Stale tiles served offline; fresh tiles replace cache in the background. */
  const MAP_TILE_HOSTS = [
    'tile.openstreetmap.org',
    'basemaps.cartocdn.com',
    'server.arcgisonline.com',
    'opentopomap.org',
  ];
  if (MAP_TILE_HOSTS.some(h => url.hostname.includes(h))) {
    event.respondWith((async () => {
      const cache  = await caches.open(TILE_CACHE);
      const cached = await cache.match(request);
      if (cached) {
        /* Background-refresh stale tiles (stale-while-revalidate) */
        fetch(request).then(res => { if (res && res.ok) safeCachePut(cache, request, res); }).catch(() => {});
        return cached;
      }
      try {
        const res = await fetch(request);
        if (res && res.ok) await safeCachePut(cache, request, res.clone());
        return res;
      } catch (e) {
        return new Response('', { status: 503, statusText: 'Tile unavailable offline' });
      }
    })());
    return;
  }

  /* Images â†' Cache First */
  if (["png","jpg","jpeg","gif","svg","webp","ico"].includes(ext)) {
    event.respondWith(cacheFirstImage(request));
    return;
  }

  /* Frequently-updated UI scripts â†' Network First so changes are instant.
     Connectivity-critical scripts MUST be here. They were previously served
     cache-first (the generic .js rule below), so a fix to the offline detector
     could not reach a user whose service worker still held the old copy — the
     false-offline banner survived the fix being deployed. Anything that decides
     online/offline state must always come from the network when reachable. */
  const ALWAYS_FRESH = ["scroll-top.js","contact-guard.js","script.js","style.css","mobile.css","premium.css","seller.css","adult-gate.js",
    "sokoni-desktop.css","security.js","sokoni-permissions.js","sokoni-pay.js","sokoni-db.js","sokoni-config.js",
    "sokoni-payment-engine.js","sokoni-payment-trust.js","sokoni-fraud-engine.js","sokoni-webhook-engine.js",
    "sokoni-offline.js","sokoni-ui.js","shared-header.js","sw-register.js",
    /* The menu drawer's CSS and JS MUST stay network-first alongside shared-header.js,
       because the header builds the drawer markup and the two are versioned together.
       shared-header.js was ALWAYS_FRESH but sokoni-drawers.css / sokoni-drawer.js were
       only precached + stale-while-revalidate, so a returning user got the NEW header
       markup with the OLD drawer stylesheet. After sokoni-drawers.css changed by ~600
       lines that mismatch rendered the menu as a black, empty panel ("menu brings a
       black blank"). Keeping all three fresh together guarantees the drawer a page
       opens is styled by the stylesheet that matches its markup. */
    "sokoni-drawers.css","sokoni-drawer.js",
    /* Auth-critical scripts: a stale version of any of these can silently
       break sign-in, getRedirectResult, or session persistence. Always
       fetch from network when reachable so fixes deploy immediately. */
    "firebase.js","auth.js","session-manager.js",
    /* seller.js owns showDashPage — the router behind every Seller Dashboard button.
       CSS/JS is otherwise stale-while-revalidate, which serves the CACHED copy on the
       next visit and only picks up a fix on the visit AFTER. For a router that is
       exactly one route-table entry away from a dead POS button, that means a seller
       would tap POS, get the old broken build, and still see nothing happen — on a
       version we had already fixed and shipped. Routing fixes must land on the first
       load, not the second. */
    "seller.js",
    /* POS startup path. pos-omni.js and pos-modules.js are both precached in
       the app shell, so they were stale-while-revalidate like seller.js — and
       the consequence here is worse than a dead button. These two carry the
       startup memory fixes (54b3e63, f0a435d) for a terminal that crashes
       during startup. Stale-while-revalidate hands that terminal the OLD copy
       on its next launch and only the fixed copy on the launch after; a device
       that dies before the page settles may never reach that second launch, so
       the fix could not arrive by the very failure it repairs.
       Anything on the POS startup path must land on the first load. */
    "pos-omni.js", "pos-modules.js",
    /* Printer stack. Same argument as the POS startup path: these drive
       physical hardware a merchant is standing in front of, and a stale copy
       presents as "the printer is broken" rather than "the page is old" — so
       nobody thinks to reload, let alone clear site data. The P58E adapter in
       particular was dead on production because of a duplicate global; a
       merchant holding a stale sokoni-bluetooth-printer.js would still see the
       broken build after the fix shipped. Hardware paths must land on the first
       load. */
    "sokoni-universal-printer.js", "sokoni-bluetooth-printer.js",
    "sokoni-printer-manager.js", "sokoni-pos-print-service.js"];
  if (ALWAYS_FRESH.some(f => url.pathname.endsWith(f))) {
    event.respondWith(networkFirst(request, STATIC_CACHE));
    return;
  }

  /* Fonts — Cache First (fonts rarely change; offline-safe) */
  if (["woff","woff2","ttf","eot"].includes(ext)) {
    event.respondWith(cacheFirst(request, STATIC_CACHE));
    return;
  }

  /* CSS / JS — Network First so EVERY reload gets the latest deploy when online,
     with the cached copy as an offline fallback. Was Stale-While-Revalidate, which
     served the OLD file on reload and only fetched the new one for the NEXT load —
     that is why updates appeared to require clearing browsing data. Network-First
     removes the stale-first-reload entirely; offline still works from cache. */
  if (["css","js"].includes(ext)) {
    event.respondWith(networkFirst(request, STATIC_CACHE));
    return;
  }

  /* HTML â†' Network First with Offline Fallback */
  /* .html suffix: issue a SW-level 301 to the clean URL.
     Firebase cleanUrls:true redirects .html to canonical, but when the SW
     follows that redirect internally Chrome receives a navigation response
     whose final URL differs from the request URL and raises ERR_FAILED.
     Returning an explicit redirect lets the browser resolve it natively;
     the SW then handles the clean URL on the second navigation pass.

     ── THE HOME BUTTON BUG (ERR_FAILED) ────────────────────────────────────
     This guard used to read `ext === "html" && url.pathname !== "/index.html"`.

     index.html is the Home button's target — 118 links across the app point at it.
     It was the ONE path excluded from the protection above, so every Home tap fell
     through to networkFirstPage(), which fetches with redirect:"follow". Firebase
     301s /index.html → /, fetch follows it, and the SW hands the browser a response
     with redirected:true for a NAVIGATION request. Navigation requests have redirect
     mode "manual"; the spec forbids a service worker returning a redirected response
     to one, and Chrome rejects it as ERR_FAILED. Home, and only Home, was broken.

     The exclusion existed because the naive strip is WRONG for this one path:
       "/index.html".replace(/\.html$/, "")  →  "/index"   ✗  not the homepage
     Rather than map it correctly, index.html was carved out of the fix — which
     handed it straight to the code path the fix was written to avoid.

     The canonical homepage is "/". Map it there explicitly, in ONE hop. */
  if (ext === "html") {
    const clean = new URL(request.url);
    clean.pathname = clean.pathname === "/index.html"
      ? "/"                                             /* the canonical homepage */
      : clean.pathname.replace(/\.html$/, "");
    /* Query string and hash are preserved — only the pathname is rewritten, so
       /index.html?source=pwa#deals still lands on /?source=pwa#deals. */
    event.respondWith(Promise.resolve(Response.redirect(clean.toString(), 301)));
    return;
  }

  if (request.headers.get("accept")?.includes("text/html") || url.pathname === "/") {
    event.respondWith(networkFirstPage(request));
    return;
  }

  /* Everything else â†' Network First */
  event.respondWith(networkFirst(request, STATIC_CACHE));
});

/* â"€â"€ STRATEGIES â"€â"€ */

async function cacheFirst(request, cacheName) {
  const cache  = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;
  try {
    const res = await fetch(request);
    if (res.ok) await safeCachePut(cache, request, res.clone());
    return res;
  } catch {
    return new Response("Offline", { status: 503 });
  }
}

async function networkFirst(request, cacheName) {
  try {
    const res = await fetch(request);
    if (res.ok) {
      const cache = await caches.open(cacheName);
      await safeCachePut(cache, request, res.clone());
    }
    return res;
  } catch {
    const cache  = await caches.open(cacheName);
    const cached = await cache.match(request);
    return cached || new Response("Offline", { status: 503 });
  }
}

async function networkFirstPage(request) {
  const cache = await caches.open(PAGES_CACHE);
  const url   = new URL(request.url);   // needed by the failure path below
  try {
    /* Use redirect:'follow' so Firebase cleanUrls 301s are resolved inside the SW.
       The browser never receives an opaqueredirect for navigation requests, which
       prevents the SW from contributing to ERR_TOO_MANY_REDIRECTS chains.
       When fetch() itself hits a redirect loop it throws TypeError — caught below. */
    const res = await fetch(new Request(request, { redirect: "follow" }));

    /* ── NEVER hand a redirected response to a NAVIGATION request ──────────────
       Navigation requests have redirect mode "manual". The spec forbids a service
       worker fulfilling one with a response whose `redirected` flag is set, and
       Chrome rejects it as ERR_FAILED — a blank "This site can't be reached" page.

       This is what broke the Home button: /index.html 301s to /, fetch followed it,
       and the SW returned the followed response to a navigation. The .html guard in
       the fetch handler now redirects before we ever get here, but that only covers
       paths ending in .html. ANY other hosting redirect — a trailing slash, a rewrite,
       a future redirect rule — would reproduce the identical failure.

       So: re-issue it as a real redirect and let the BROWSER follow it natively. The
       browser then re-navigates, the SW sees the final URL, and the address bar is
       correct. One class of bug, closed at the seam rather than per-path. */
    if (res.redirected && request.mode === "navigate") {
      return Response.redirect(res.url, 301);
    }

    if (res.ok) {
      /* Guard: never cache a redirected response whose final URL differs from
         the request URL by only a query string pointing back at itself —
         that is the Firebase cleanUrls index.html+querystring loop signature. */
      if (res.redirected) {
        const reqUrl  = new URL(request.url);
        const resUrl  = new URL(res.url);
        const isSelf  = resUrl.pathname === reqUrl.pathname && resUrl.hostname === reqUrl.hostname;
        if (!isSelf) await safeCachePut(cache, request, res.clone());
      } else {
        await safeCachePut(cache, request, res.clone());
      }
    }
    return res;
  } catch (err) {
    /* fetch threw — most likely a redirect loop (TypeError: too many redirects)
       or a network failure. Recovery priority:
         1. Exact URL cached from a prior successful request
         2. Root "/" cached page (safe fallback for any page in the same SPA)
         3. Offline shell  */
    const cached = await cache.match(request);
    /* ROOT INTEGRITY: never serve a cached "/" that is not the marketplace shell.
       A merchant template cached under the root key would render a store page at the
       bare domain — the reported bug. Verify before serving; purge and fall through if
       it fails. Only the root pays the decode cost. */
    if (cached && (url.pathname === "/" || url.pathname === "/index.html")) {
      if (!(await rootCacheIsValid(cached))) {
        await purgeRootFromCaches();
        try {
          const fresh = await fetch("/", { cache: "reload" });
          if (fresh && fresh.ok) { await safeCachePut(cache, "/", fresh.clone()); return fresh; }
        } catch (e) { /* offline — fall through to the offline shell below */ }
        return (await caches.match("/offline")) ||
               (await caches.match("/offline.html")) ||
               new Response("Offline", { status: 503 });
      }
    }
    if (cached) return cached;

    /* Delete the bad cache entry so the next successful load replaces it */
    await cache.delete(request);

    /* ── NEVER SUBSTITUTE THE HOMEPAGE FOR A DIFFERENT PAGE ────────────────────
       This used to be:

         const root = await cache.match("/") || await cache.match("/?source=pwa");
         if (root) return root;

       …described as a "safe fallback for any page in the same SPA". SOKONI is NOT
       an SPA — it is multi-page. So when the fetch for /marketing-hub threw (a
       transient network blip, a cold PWA launch, a redirect hiccup), the SW handed
       the browser the CACHED HOMEPAGE while the address bar still read
       /marketing-hub. The user tapped Marketing Hub and landed on the homepage.

       That is the "Marketing Hub redirects to homepage" bug — and it was never
       specific to Marketing. It could silently swap ANY page for the homepage.

       Serving content the user did not ask for is worse than admitting failure. The
       homepage is only ever served when the homepage is what was requested. */
    const isHome = url.pathname === "/" || url.pathname === "/index.html";
    if (isHome) {
      const root = await cache.match("/") || await cache.match("/?source=pwa");
      if (root) return root;
    }

    const offline = await caches.match("/offline") || await caches.match("/offline.html");
    if (offline) return offline;

    /* Honest error state for the requested route — never substitutes another page.
       Three explicit choices: Retry (same page), Go Back, Go Home. */
    const target = url.pathname + url.search;
    const label  = target.replace(/^\//, "").replace(/\.html$/, "").replace(/[-_]/g, " ").toUpperCase() || "THIS PAGE";
    return new Response(
      `<!DOCTYPE html><html lang="en"><head>
         <meta charset="UTF-8">
         <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
         <title>Couldn't Load — SOKONI</title>
         <style>
           *{box-sizing:border-box;margin:0;padding:0}
           body{background:#050505;color:#fff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
                min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}
           .box{text-align:center;max-width:360px;width:100%}
           .icon{font-size:52px;margin-bottom:18px;line-height:1}
           .route{font-size:11px;font-weight:700;letter-spacing:0.12em;color:#71ff00;margin-bottom:10px;
                  background:rgba(113,255,0,0.08);border:1px solid rgba(113,255,0,0.18);
                  border-radius:6px;padding:4px 10px;display:inline-block}
           h2{font-size:20px;font-weight:900;margin:0 0 10px}
           p{font-size:13px;color:rgba(255,255,255,0.45);line-height:1.65;margin:0 0 28px}
           .btns{display:flex;flex-direction:column;gap:10px}
           .btn-p{display:block;padding:14px 24px;background:#71ff00;color:#050505;
                  font-weight:900;font-size:14px;border:none;border-radius:14px;
                  cursor:pointer;text-decoration:none;font-family:inherit}
           .btn-s{display:block;padding:14px 24px;
                  background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.12);
                  color:rgba(255,255,255,0.75);font-weight:700;font-size:14px;
                  border-radius:14px;cursor:pointer;text-decoration:none;font-family:inherit}
           .sig{margin-top:24px;font-size:11px;color:rgba(255,255,255,0.18);letter-spacing:0.05em}
         </style>
       </head>
       <body>
         <div class="box">
           <div class="icon">&#x26A0;&#xFE0F;</div>
           <div class="route">/${label}</div>
           <h2>Page Unavailable</h2>
           <p>You may be offline, or this page failed to load.<br>Your session has been preserved.</p>
           <div class="btns">
             <a href="${target}" class="btn-p">&#x1F504; Retry</a>
             <button onclick="history.length>1?history.back():location.assign('/')" class="btn-s">&#x2190; Go Back</button>
             <a href="/" class="btn-s">&#x1F3E0; Go Home</a>
           </div>
           <div class="sig">SOKONI — Kenya's Marketplace</div>
         </div>
       </body></html>`,
      { headers: { "Content-Type": "text/html" }, status: 503 }
    );
  }
}

async function staleWhileRevalidate(request) {
  const cache  = await caches.open(STATIC_CACHE);
  const cached = await cache.match(request);
  const fetchProm = fetch(request).then(async res => {
    if (res.ok) await safeCachePut(cache, request, res.clone());
    return res;
  }).catch(() => null);
  return cached || (await fetchProm) || new Response("Offline", { status: 503 });
}

async function cacheFirstImage(request) {
  const cache  = await caches.open(IMAGES_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  try {
    const res = await fetch(request);
    if (res.ok) {
      const keys = await cache.keys();
      if (keys.length >= 300) cache.delete(keys[0]);
      await safeCachePut(cache, request, res.clone());
    }
    return res;
  } catch {
    /* 1Ã—1 transparent PNG placeholder */
    const b64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    const bin = atob(b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new Response(arr.buffer, { headers: { "Content-Type": "image/png" } });
  }
}

/* â"€â"€ PUSH NOTIFICATIONS â"€â"€ */
self.addEventListener("push", event => {
  if (!event.data) return;
  let data = { title: "SOKONI", body: "You have a new notification!", icon: '/assets/logosokoni.png' };
  try { data = { ...data, ...event.data.json() }; } catch {}

  /* The notification engine nests its payload under `data` and names the target
     `deepLink`. Reading only a top-level `url` sent every engine push to the
     homepage — the notification would be about an order and open nothing. */
  const d    = data.data || data;
  const url  = d.deepLink || d.url || data.url || "/";
  const tag  = d.group || data.tag;
  const img  = d.image || data.image;

  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: data.icon || '/assets/icons/icon-192.png',
      badge: '/assets/logosokoni.png',
      ...(img ? { image: img } : {}),
      ...(tag ? { tag, renotify: true } : {}),   /* one thread per order, not eleven */
      vibrate: [200, 100, 200],
      data: { ...d, url },
      actions: [
        { action: "open",    title: "Open" },
        { action: "dismiss", title: "Dismiss" },
      ],
    })
  );
});

/* notificationclick handler consolidated below â€" see NOTIFICATION ACTION HANDLER */

/* â"€â"€ MESSAGE HANDLER (CACHE_URLS) â"€â"€ */
/* SKIP_WAITING is already handled by the listener at line 274.
   This handler is consolidated to only handle CACHE_URLS. */
self.addEventListener("message", event => {
  if (event.data?.type === "CACHE_URLS") {
    const urls = event.data.urls || [];
    caches.open(PAGES_CACHE).then(c => c.addAll(urls.map(u => new Request(u))));
  }
});

/* â"€â"€ BACKGROUND SYNC â"€â"€ */
self.addEventListener("sync", event => {
  if (event.tag === "sokoni-sync") {
    event.waitUntil(
      self.clients.matchAll().then(clients =>
        clients.forEach(c => c.postMessage({ type: "SYNC_COMPLETE" }))
      )
    );
  }
  /* Smart notification on sync */
  if (event.tag === "sokoni-notify") {
    event.waitUntil(_checkScheduledNotifications());
  }
});

/* â"€â"€ PERIODIC SYNC (Chrome Android) â"€â"€ */
self.addEventListener("periodicsync", event => {
  if (event.tag === "sokoni-daily") {
    event.waitUntil(_checkScheduledNotifications());
  }
});

/* â"€â"€ SMART SCHEDULED NOTIFICATIONS â"€â"€ */
async function _checkScheduledNotifications() {
  try {
    const notifications = [
      {
        id:    "daily-deals",
        title: "⚡ Daily Deals on SOKONI",
        body:  "New products & flash sales added today - check what's new!",
        url:   "/flashsale",
        icon:  '/assets/logosokoni.png',
      },
      {
        id:    "sell-reminder",
        title: "🏪 Got something to sell?",
        body:  "List it on SOKONI for FREE and reach thousands of Kenyan buyers today.",
        url:   "/seller",
        icon:  '/assets/logosokoni.png',
      },
      {
        id:    "cart-reminder",
        title: "🛒 Items waiting in your cart!",
        body:  "Complete your purchase before items sell out.",
        url:   "/cart",
        icon:  '/assets/logosokoni.png',
      },
    ];

    /* Pick a random notification to send */
    const n = notifications[Math.floor(Math.random() * notifications.length)];

    await self.registration.showNotification(n.title, {
      body:    n.body,
      icon:    n.icon,
      badge:   '/assets/logosokoni.png',
      vibrate: [100, 50, 100],
      tag:     "sokoni-" + n.id,
      data:    { url: n.url },
      actions: [
        { action: "open",    title: "Open SOKONI" },
        { action: "dismiss", title: "Dismiss" },
      ],
    });
  } catch (e) {}
}

/* â"€â"€ NOTIFICATION ACTION HANDLER â"€â"€ */
self.addEventListener("notificationclick", event => {
  /* Handle action buttons on scheduled/push notifications */
  const action = event.action;
  const d      = event.notification.data || {};
  const url    = d.deepLink || d.url || "/";

  event.notification.close();

  if (action === "dismiss" || action === "later") return;

  /* Map action strings to specific pages */
  const actionUrls = {
    shop:    "/category?cat=all",
    sell:    "/seller",
    track:   "/track",
    open:    url,
  };
  const dest = actionUrls[action] || url;

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(clients => {
      for (const c of clients) {
        if (c.url.includes(self.location.origin) && "focus" in c) {
          c.navigate(dest);
          return c.focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(dest);
    })
  );
});

/* Keep the old notificationclick above, remove duplicate definition issue
   by having one clean handler above */
