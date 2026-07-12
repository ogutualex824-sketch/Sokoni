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

const CACHE_VERSION = "sokoni-20260712-prod-readiness-v39";
const STATIC_CACHE  = `${CACHE_VERSION}-static`;
const PAGES_CACHE   = `${CACHE_VERSION}-pages`;
const IMAGES_CACHE  = `${CACHE_VERSION}-images`;

/* NOTE: Firebase cleanUrls:true redirects all .html URLs to clean URLs.
   PRECACHE_PAGES must use the canonical (no .html) form so cache.add() succeeds. */
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
  "/life-events", "/marketing", "/foundation",
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
];

const PRECACHE_STATIC = [
  "/style.css", "/mobile.css", "/script.js", "/sokoni-inv-shell.css", "/sokoni-inv-shell.js", "/sokoni-quality.css",
  "/manifest.json", "/assets/Sokoni Logo.png", "/assets/Sokoni%20Logo.png",
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
  "/pos.js", "/pos-db.js", "/pos-printer.js", "/sokoni-print-engine.js", "/sokoni-universal-printer.js", "/sokoni-bluetooth-printer.js", "/sokoni-printer-manager.js", "/sokoni-pos-print-service.js", "/pos-health.js", "/pos-idempotency.js", "/pos-sync.js", "/sokoni-pos-resilience.js", "/pos-omni.js", "/pos-barcode.js",
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
  /* Search Engine — federated, Typesense, recommendations */
  "/sokoni-search-engine.js", "/sokoni-typesense-engine.js", "/sokoni-search-recommendations.js",
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
  "googleapis.com/identitytoolkit",
  "securetoken.googleapis.com",
  "maps.googleapis.com",
  "maps.gstatic.com",
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
  /* Precache silently — do NOT skipWaiting() here.
     Active checkouts, chats and POS sessions must not be interrupted.
     The page receives SW_UPDATE_READY and decides when it is safe to upgrade. */
  event.waitUntil((async () => {
    try {
      const [sc, pc] = await Promise.all([
        caches.open(STATIC_CACHE),
        caches.open(PAGES_CACHE),
      ]);
      await Promise.allSettled(PRECACHE_STATIC.map(u => sc.add(u).catch(() => {})));
      await Promise.allSettled(PRECACHE_PAGES.map(u  => pc.add(u).catch(() => {})));
      /* Notify controlled clients that an update is waiting */
      const clients = await self.clients.matchAll({ type: "window" });
      clients.forEach(c => c.postMessage({ type: "SW_UPDATE_READY", version: CACHE_VERSION }));
    } catch (err) {
      /* Install failure is non-fatal -- log and continue so the SW activates */
      console.error("[SW] Install failed:", err);
    }
  })());
});

/* Client sends SKIP_WAITING (or SW_SKIP_WAITING for back-compat) when safe */
self.addEventListener("message", event => {
  if (event.data?.type === "SKIP_WAITING" || event.data?.type === "SW_SKIP_WAITING") self.skipWaiting();
});
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
        fetch(request).then(res => { if (res && res.ok) cache.put(request, res); }).catch(() => {});
        return cached;
      }
      try {
        const res = await fetch(request);
        if (res && res.ok) cache.put(request, res.clone());
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

  /* Frequently-updated UI scripts â†' Network First so changes are instant */
  const ALWAYS_FRESH = ["scroll-top.js","contact-guard.js","script.js","style.css","mobile.css","premium.css","seller.css","adult-gate.js",
    "sokoni-desktop.css","security.js","sokoni-permissions.js","sokoni-pay.js","sokoni-db.js","sokoni-config.js",
    "sokoni-payment-engine.js","sokoni-payment-trust.js","sokoni-fraud-engine.js","sokoni-webhook-engine.js"];
  if (ALWAYS_FRESH.some(f => url.pathname.endsWith(f))) {
    event.respondWith(networkFirst(request, STATIC_CACHE));
    return;
  }

  /* Other CSS / JS â†' Cache First */
  if (["css","js","woff","woff2","ttf","eot"].includes(ext)) {
    event.respondWith(cacheFirst(request, STATIC_CACHE));
    return;
  }

  /* HTML â†' Network First with Offline Fallback */
  /* .html suffix: issue a SW-level 301 to the clean URL.
     Firebase cleanUrls:true redirects .html to canonical, but when the SW
     follows that redirect internally Chrome receives a navigation response
     whose final URL differs from the request URL and raises ERR_FAILED.
     Returning an explicit redirect lets the browser resolve it natively;
     the SW then handles the clean URL on the second navigation pass. */
  if (ext === "html" && url.pathname !== "/index.html") {
    const clean = new URL(request.url);
    clean.pathname = clean.pathname.replace(/\.html$/, "");
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
    if (res.ok) cache.put(request, res.clone());
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
      cache.put(request, res.clone());
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
  try {
    /* Use redirect:'follow' so Firebase cleanUrls 301s are resolved inside the SW.
       The browser never receives an opaqueredirect for navigation requests, which
       prevents the SW from contributing to ERR_TOO_MANY_REDIRECTS chains.
       When fetch() itself hits a redirect loop it throws TypeError — caught below. */
    const res = await fetch(new Request(request, { redirect: "follow" }));
    if (res.ok) {
      /* Guard: never cache a redirected response whose final URL differs from
         the request URL by only a query string pointing back at itself —
         that is the Firebase cleanUrls index.html+querystring loop signature. */
      if (res.redirected) {
        const reqUrl  = new URL(request.url);
        const resUrl  = new URL(res.url);
        const isSelf  = resUrl.pathname === reqUrl.pathname && resUrl.hostname === reqUrl.hostname;
        if (!isSelf) cache.put(request, res.clone());
      } else {
        cache.put(request, res.clone());
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
    if (cached) return cached;

    /* Delete the bad cache entry so the next successful load replaces it */
    await cache.delete(request);

    const root = await cache.match("/") || await cache.match("/?source=pwa");
    if (root) return root;

    const offline = await caches.match("/offline") || await caches.match("/offline.html");
    return offline || new Response(
      `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Offline — SOKONI</title></head>
       <body style="background:#0a0a0a;color:white;font-family:sans-serif;text-align:center;padding:80px 24px;">
         <div style="font-size:48px;margin-bottom:16px;">&#x1F4F6;</div>
         <h2>You're Offline</h2>
         <p style="color:rgba(255,255,255,0.5);margin:12px 0 24px;">Check your connection and try again.</p>
         <a href="/" style="padding:12px 24px;background:#71ff00;color:black;border-radius:12px;font-weight:800;text-decoration:none;">Go Home</a>
       </body></html>`,
      { headers: { "Content-Type": "text/html" }, status: 503 }
    );
  }
}

async function staleWhileRevalidate(request) {
  const cache  = await caches.open(STATIC_CACHE);
  const cached = await cache.match(request);
  const fetchProm = fetch(request).then(res => {
    if (res.ok) cache.put(request, res.clone());
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
      cache.put(request, res.clone());
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
  let data = { title: "SOKONI", body: "You have a new notification!", icon: "/assets/Sokoni Logo.png" };
  try { data = { ...data, ...event.data.json() }; } catch {}
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: data.icon || "/assets/Sokoni Logo.png",
      badge: "/assets/Sokoni Logo.png",
      vibrate: [200, 100, 200],
      data: { url: data.url || "/" },
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
        title: "âš¡ Daily Deals on SOKONI",
        body:  "New products & flash sales added today - check what's new!",
        url:   "/flashsale",
        icon:  "/assets/Sokoni Logo.png",
      },
      {
        id:    "sell-reminder",
        title: "ðŸª Got something to sell?",
        body:  "List it on SOKONI for FREE and reach thousands of Kenyan buyers today.",
        url:   "/seller",
        icon:  "/assets/Sokoni Logo.png",
      },
      {
        id:    "cart-reminder",
        title: "ðŸ›' Items waiting in your cart!",
        body:  "Complete your purchase before items sell out.",
        url:   "/cart",
        icon:  "/assets/Sokoni Logo.png",
      },
    ];

    /* Pick a random notification to send */
    const n = notifications[Math.floor(Math.random() * notifications.length)];

    await self.registration.showNotification(n.title, {
      body:    n.body,
      icon:    n.icon,
      badge:   "/assets/Sokoni Logo.png",
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
  const url    = event.notification.data?.url || "/";

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
