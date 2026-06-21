/* ============================================================
   SOKONI SERVICE WORKER  v12.10
   Strategy:
     APP SHELL      â†’ Cache First  (index.html as app shell)
     STATIC ASSETS  â†’ Cache First  (CSS, JS â€” fast load)
     HTML PAGES     â†’ Network First with Cache Fallback
     CDN RESOURCES  â†’ Stale While Revalidate
     IMAGES         â†’ Cache First (capped at 300 entries)
     Firebase/API   â†’ Network Only (never cached)
   Offline fallback â†’ /offline.html
   PWA: fullscreen, fast, installable
============================================================ */

const CACHE_VERSION = "sokoni-v253";
const STATIC_CACHE  = `${CACHE_VERSION}-static`;
const PAGES_CACHE   = `${CACHE_VERSION}-pages`;
const IMAGES_CACHE  = `${CACHE_VERSION}-images`;

const PRECACHE_PAGES = [
  "/", "/index.html", "/offline.html",
  "/login.html", "/signup.html", "/category.html", "/services.html",
  "/product.html", "/cart.html", "/profile.html",
  "/notifications.html", "/unboxing.html", "/reviews.html",
  "/seller.html", "/checkout.html", "/messages.html",
  "/wishlist.html", "/wallet.html", "/track.html",
  "/flashsale.html", "/driver.html", "/food.html",
  "/food-menu.html", "/food-cart.html", "/food-order.html", "/food-dashboard.html", "/food-rider.html",
  "/healthcare.html", "/entertainment.html", "/car-hub.html",
  "/car-rental.html", "/pos.html",
  "/delivery.html", "/delivery-tracking.html",
  "/bnb.html", "/landlord.html", "/property.html",
  "/community.html", "/digital.html", "/b2b.html",
  "/b2b-supplier.html", "/b2b-rfq.html", "/b2b-dashboard.html",
  "/b2b-seller-dashboard.html", "/b2b-orders.html", "/b2b-chat.html",
  "/banking.html", "/sports-hub.html", "/fitness-hub.html",
  "/tech-hub.html", "/legal-hub.html", "/legal.html",
  "/inspiq.html", "/opportunity.html", "/ministore.html",
  "/subscriptions.html", "/loyalty.html", "/referral.html",
  "/invoice.html", "/dispute.html", "/requests.html",
  "/store.html", "/providers.html", "/provider.html",
  "/business-os.html", "/admin.html",
  "/ent-organizer.html",
  "/home-services.html", "/cleaning.html", "/construction.html",
  "/electrical.html", "/mechanics.html", "/phone-repair.html", "/plumbing.html",
  "/life-events.html", "/marketing.html", "/foundation.html",
  "/offer.html", "/success.html", "/trust.html",
  "/register.html", "/seller-public.html", "/bnb-manage.html",
  "/payments.html", "/revenue.html", "/seller-revenue.html",
  "/property-hub.html", "/property-listing.html", "/property-agent.html",
  "/property-dashboard.html", "/property-agent-dashboard.html",
  "/bnb-hub.html",
  "/marketing-hub.html",
  "/sports-tournament.html", "/sports-venue.html",
  "/businesses.html", "/business.html",
  "/search.html", "/verification.html", "/verification-admin.html",
  "/growth-dashboard.html",
  "/seller-analytics.html", "/business-analytics.html", "/customer-analytics.html",
  "/monitor.html", "/email-center.html",
  "/onboarding.html", "/onboarding-seller.html", "/onboarding-driver.html", "/onboarding-professional.html",
  "/help.html", "/moderation.html",
  "/beta.html", "/beta-dashboard.html",
  "/seller-success.html", "/driver-success.html", "/join.html", "/support.html", "/launch-metrics.html",
  "/ride-book.html",
  "/jobs.html", "/education.html", "/superadmin.html", "/scan.html",
  "/inventory.html",
  "/inv-dashboard.html",
  "/inv-products.html",
  "/inv-product.html",
  "/creative-studio.html",
  "/ai-subscriptions.html",
  "/admin-subscriptions.html",
  "/subscription-os.html",
];

const PRECACHE_STATIC = [
  "/style.css", "/mobile.css", "/script.js", "/sokoni-inv-shell.css", "/sokoni-inv-shell.js",
  "/manifest.json", "/assets/logosokoni.png", "/assets/Sokonilogo2.png",
  "/auth.css", "/checkout.css", "/premium.css",
  "/product.css", "/profile.css", "/seller.css",
  "/landlord.css", "/compact-grid.css", "/sokoni-premium-v2.css",
  "/auth.js", "/sokoni-db.js", "/sokoni-pay.js", "/sokoni-social.js", "/sokoni-referral.js",
  "/sokoni-desktop.css", "/sokoni-routing.js", "/sokoni-delivery.js", "/sokoni-invoice.js", "/sokoni-config.js", "/sokoni-mpesa.js", "/sokoni-revenue.js", "/sokoni-featured.js",
  "/category.js", "/profile.js", "/product.js", "/analytics.js",
  "/security.js", "/nav-active.js", "/splash.js", "/scroll-top.js",
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
  "/sokoni-qr.js", "/sokoni-barcode.js", "/sokoni-receipt.js", "/sokoni-event-bus.js", "/sokoni-observability.js", "/sokoni-service-mesh.js", "/sokoni-gateway.js",
  "/sokoni-payment-engine.js", "/sokoni-fraud-engine.js", "/sokoni-webhook-engine.js", "/sokoni-search-pro.js",
  "/firebase.js", "/seller.js", "/cart.js", "/checkout.js",
  "/inventory-manager.js", "/market-actions.js",
  "/seo.js", "/session-manager.js", "/scroll-memory.js",
  "/sw-register.js", "/pos-terminals.js",
  "/demo-seed.js", "/etims.js", "/inspiq.js",
  /* SmartPOS core modules */
  "/pos.html", "/pos.css", "/pos-bos.css", "/pos-mobile.css",
  "/pos.js", "/pos-db.js", "/pos-printer.js", "/pos-health.js", "/pos-idempotency.js", "/pos-sync.js", "/pos-resilience.js", "/pos-omni.js", "/pos-barcode.js",
  "/pos-ai.js", "/pos-analytics.js", "/pos-boss.js", "/pos-plugins.js",
  "/pos-voice.js", "/pos-ai-engine.js", "/pos-finance.js", "/pos-audit.js",
  "/pos-modules.js", "/pos-scanner.js", "/pos-mobile.js",
  /* Self-checkout kiosk */
  "/pos-kiosk.html",
  /* Inventory Management System V1+V2 */
  "/sokoni-inventory.js",
  "/sokoni-inventory-v2.js",
  /* Tracking & Location */
  "/sokoni-gps-manager.js", "/sokoni-map-manager.js", "/sokoni-route-manager.js",
  "/sokoni-tracking.js", "/sokoni-tracking-manager.js",
  /* GIP — Geo Intelligence Platform */
  "/sokoni-gip.js", "/sokoni-gip-dispatch.js", "/sokoni-gip-analytics.js",
  "/sokoni-gip-router.js", "/sokoni-gip-fleet.js", "/sokoni-gip-api.js",
  "/gip.html",
  /* AI Policy Engine + Enterprise Intelligence Platform */
  "/sokoni-ai-policy.js",
  "/sokoni-decision-engine.js", "/sokoni-data-quality.js",
  "/sokoni-feature-flags.js", "/sokoni-intelligence-log.js",
  "/sokoni-eip.js",
  /* Workflow Automation Platform */
  "/sokoni-wap.js", "/sokoni-wap-definitions.js",
  "/wap.html",
  /* Enterprise Control Center */
  "/sokoni-ecc.js", "/ecc.html",
  /* SASOS — Universal AI Subscription Operating System */
  "/sokoni-sasos.js", "/sasos-admin.html",
  /* Platform Registry + Event Bus + Operations Center */
  "/sokoni-platform.js", "/platform.html",
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

/* â”€â”€ INSTALL â”€â”€ */
self.addEventListener("install", event => {
  self.skipWaiting(); /* Activate immediately â€” do not block on precaching */
  event.waitUntil((async () => {
    const [sc, pc] = await Promise.all([
      caches.open(STATIC_CACHE),
      caches.open(PAGES_CACHE),
    ]);
    await Promise.allSettled(PRECACHE_STATIC.map(u => sc.add(u).catch(() => {})));
    await Promise.allSettled(PRECACHE_PAGES.map(u  => pc.add(u).catch(() => {})));
  })());
});

/* â”€â”€ ACTIVATE â”€â”€ */
self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    const valid = new Set([STATIC_CACHE, PAGES_CACHE, IMAGES_CACHE]);
    const keys  = await caches.keys();
    await Promise.all(keys.filter(k => !valid.has(k)).map(k => caches.delete(k)));
    await self.clients.claim();
    /* Welcome notification is handled by sw-register.js on appinstalled event,
       not here â€” this activate fires on every update, not just first install */
  })());
});

/* â”€â”€ FETCH â”€â”€ */
self.addEventListener("fetch", event => {
  const { request } = event;
  const url = new URL(request.url);

  if (request.method !== "GET") return;
  if (SKIP_CACHE_PATTERNS.some(p => request.url.includes(p))) return;
  /* Skip service worker for file:// â€” direct file opens should never hit offline.html */
  if (url.protocol === "file:") return;
  if (!["https:", "http:"].includes(url.protocol)) return;

  /* CDN â†’ Stale While Revalidate */
  if (CDN_ORIGINS.some(o => url.hostname.includes(o))) {
    event.respondWith(staleWhileRevalidate(request));
    return;
  }

  const ext = url.pathname.split(".").pop().toLowerCase();

  /* Map tiles → Cache-first with 7-day TTL for offline-first navigation.
     Tile domains: OpenStreetMap, CartoDB, ESRI ArcGIS, OpenTopoMap.
     Stale tiles served offline; fresh tiles replace cache in the background. */
  const MAP_TILE_HOSTS = [
    ‘tile.openstreetmap.org’,
    ‘basemaps.cartocdn.com’,
    ‘server.arcgisonline.com’,
    ‘opentopomap.org’,
  ];
  if (MAP_TILE_HOSTS.some(h => url.hostname.includes(h))) {
    const TILE_CACHE = ‘sokoni-tiles-v1’;
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
        return new Response(‘’, { status: 503, statusText: ‘Tile unavailable offline’ });
      }
    })());
    return;
  }

  /* Images â†’ Cache First */
  if (["png","jpg","jpeg","gif","svg","webp","ico"].includes(ext)) {
    event.respondWith(cacheFirstImage(request));
    return;
  }

  /* Frequently-updated UI scripts â†’ Network First so changes are instant */
  const ALWAYS_FRESH = ["scroll-top.js","contact-guard.js","script.js","style.css","mobile.css","premium.css","seller.css","adult-gate.js",
    "sokoni-desktop.css","security.js","sokoni-permissions.js","sokoni-pay.js","sokoni-db.js","sokoni-config.js"];
  if (ALWAYS_FRESH.some(f => url.pathname.endsWith(f))) {
    event.respondWith(networkFirst(request, STATIC_CACHE));
    return;
  }

  /* Other CSS / JS â†’ Cache First */
  if (["css","js","woff","woff2","ttf","eot"].includes(ext)) {
    event.respondWith(cacheFirst(request, STATIC_CACHE));
    return;
  }

  /* HTML â†’ Network First with Offline Fallback */
  if (request.headers.get("accept")?.includes("text/html") || ext === "html" || url.pathname === "/") {
    event.respondWith(networkFirstPage(request));
    return;
  }

  /* Everything else â†’ Network First */
  event.respondWith(networkFirst(request, STATIC_CACHE));
});

/* â”€â”€ STRATEGIES â”€â”€ */

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
  try {
    const res = await fetch(request);
    if (res.ok) {
      const cache = await caches.open(PAGES_CACHE);
      cache.put(request, res.clone());
    }
    return res;
  } catch {
    const cache  = await caches.open(PAGES_CACHE);
    const cached = await cache.match(request);
    if (cached) return cached;
    const offline = await caches.match("/offline.html");
    return offline || new Response(
      `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Offline</title></head>
       <body style="background:#0a0a0a;color:white;font-family:sans-serif;text-align:center;padding:80px 24px;">
         <h1 style="color:#71ff00;font-size:48px;margin-bottom:16px;">ðŸ“¶</h1>
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

/* â”€â”€ PUSH NOTIFICATIONS â”€â”€ */
self.addEventListener("push", event => {
  if (!event.data) return;
  let data = { title: "SOKONI", body: "You have a new notification!", icon: "/assets/logosokoni.png" };
  try { data = { ...data, ...event.data.json() }; } catch {}
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: data.icon || "/assets/logosokoni.png",
      badge: "/assets/logosokoni.png",
      vibrate: [200, 100, 200],
      data: { url: data.url || "/" },
      actions: [
        { action: "open",    title: "Open" },
        { action: "dismiss", title: "Dismiss" },
      ],
    })
  );
});

/* notificationclick handler consolidated below â€” see NOTIFICATION ACTION HANDLER */

/* â”€â”€ MESSAGE HANDLER â”€â”€ */
self.addEventListener("message", event => {
  if (event.data?.type === "SKIP_WAITING") self.skipWaiting();
  if (event.data?.type === "CACHE_URLS") {
    const urls = event.data.urls || [];
    caches.open(PAGES_CACHE).then(c => c.addAll(urls.map(u => new Request(u))));
  }
});

/* â”€â”€ BACKGROUND SYNC â”€â”€ */
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

/* â”€â”€ PERIODIC SYNC (Chrome Android) â”€â”€ */
self.addEventListener("periodicsync", event => {
  if (event.tag === "sokoni-daily") {
    event.waitUntil(_checkScheduledNotifications());
  }
});

/* â”€â”€ SMART SCHEDULED NOTIFICATIONS â”€â”€ */
async function _checkScheduledNotifications() {
  try {
    const notifications = [
      {
        id:    "daily-deals",
        title: "âš¡ Daily Deals on SOKONI",
        body:  "New products & flash sales added today â€” check what's new!",
        url:   "/flashsale.html",
        icon:  "/assets/logosokoni.png",
      },
      {
        id:    "sell-reminder",
        title: "ðŸª Got something to sell?",
        body:  "List it on SOKONI for FREE and reach thousands of Kenyan buyers today.",
        url:   "/seller.html",
        icon:  "/assets/logosokoni.png",
      },
      {
        id:    "cart-reminder",
        title: "ðŸ›’ Items waiting in your cart!",
        body:  "Complete your purchase before items sell out.",
        url:   "/cart.html",
        icon:  "/assets/logosokoni.png",
      },
    ];

    /* Pick a random notification to send */
    const n = notifications[Math.floor(Math.random() * notifications.length)];

    await self.registration.showNotification(n.title, {
      body:    n.body,
      icon:    n.icon,
      badge:   "/assets/logosokoni.png",
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

/* â”€â”€ NOTIFICATION ACTION HANDLER â”€â”€ */
self.addEventListener("notificationclick", event => {
  /* Handle action buttons on scheduled/push notifications */
  const action = event.action;
  const url    = event.notification.data?.url || "/";

  event.notification.close();

  if (action === "dismiss" || action === "later") return;

  /* Map action strings to specific pages */
  const actionUrls = {
    shop:    "/category.html?cat=all",
    sell:    "/seller.html",
    track:   "/track.html",
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
