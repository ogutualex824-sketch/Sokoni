/**
 * SOKONI Smoke Test Suite v2.0
 * Tests every critical page for JS errors, 404s, and missing assets.
 * Runs in CI against localhost or a provided BASE_URL.
 *
 * Usage:
 *   node test-smoke.js                              # localhost:3000
 *   SMOKE_BASE_URL=https://sokoni-aeb26--staging.web.app node test-smoke.js
 */
"use strict";
const { chromium } = require("playwright");

const BASE_URL = process.env.SMOKE_BASE_URL || "http://localhost:3000";
const TIMEOUT  = 12000;

/* ── Pages to test ──────────────────────────────────────────────────
   Every public-facing + authenticated page in the platform.
   Pages marked critical:true fail the build on error.
─────────────────────────────────────────────────────────────────── */
const PAGES = [
  /* Core */
  { path: "/",                    label: "Home",                critical: true  },
  { path: "/index.html",          label: "Home (direct)",       critical: true  },
  { path: "/login.html",          label: "Login",               critical: true  },
  { path: "/register.html",       label: "Register",            critical: true  },
  { path: "/offline.html",        label: "Offline fallback",    critical: true  },

  /* Marketplace */
  { path: "/category.html",       label: "Category",            critical: true  },
  { path: "/product.html",        label: "Product detail",      critical: true  },
  { path: "/search.html",         label: "Search",              critical: true  },
  { path: "/cart.html",           label: "Cart",                critical: true  },
  { path: "/checkout.html",       label: "Checkout",            critical: true  },
  { path: "/wishlist.html",       label: "Wishlist",            critical: false },
  { path: "/offer.html",          label: "Offers",              critical: false },
  { path: "/flashsale.html",      label: "Flash Sale",          critical: false },

  /* Services */
  { path: "/services.html",       label: "Services",            critical: true  },
  { path: "/providers.html",      label: "Providers",           critical: true  },
  { path: "/provider.html",       label: "Provider profile",    critical: true  },
  { path: "/home-services.html",  label: "Home Services",       critical: false },
  { path: "/healthcare.html",     label: "Healthcare",          critical: false },
  { path: "/legal.html",          label: "Legal",               critical: false },
  { path: "/legal-hub.html",      label: "Legal Hub",           critical: false },

  /* Ride & Delivery */
  { path: "/ride-book.html",      label: "Ride booking",        critical: true  },
  { path: "/driver.html",         label: "Driver dashboard",    critical: true  },
  { path: "/delivery.html",       label: "Delivery",            critical: true  },
  { path: "/delivery-tracking.html", label: "Delivery tracking", critical: true },
  { path: "/track.html",          label: "Order tracking",      critical: true  },

  /* Seller */
  { path: "/seller.html",         label: "Seller dashboard",    critical: true  },
  { path: "/onboarding-seller.html", label: "Seller onboarding", critical: true },
  { path: "/seller-public.html",  label: "Seller public page",  critical: false },
  { path: "/seller-analytics.html","label": "Seller analytics", critical: false },
  { path: "/inventory-manager.js","label": "Inventory (js)",    critical: false },
  { path: "/store.html",          label: "Store",               critical: false },
  { path: "/ministore.html",      label: "Ministore",           critical: false },

  /* Entertainment */
  { path: "/entertainment.html",  label: "Entertainment",       critical: true  },
  { path: "/ent-organizer.html",  label: "Event organizer",     critical: false },
  { path: "/sports-hub.html",     label: "Sports hub",          critical: false },
  { path: "/sports-tournament.html","label": "Tournament",      critical: false },

  /* Car Hub */
  { path: "/car-hub.html",        label: "Car Hub",             critical: true  },
  { path: "/car-rental.html",     label: "Car Rental",          critical: false },

  /* Property */
  { path: "/property.html",       label: "Property",            critical: false },
  { path: "/property-hub.html",   label: "Property Hub",        critical: false },

  /* Food */
  { path: "/food.html",           label: "Food Hub",            critical: false },
  { path: "/food-menu.html",      label: "Food Menu",           critical: false },

  /* Community */
  { path: "/community.html",      label: "Community",           critical: false },
  { path: "/b2b.html",            label: "B2B Hub",             critical: false },

  /* User account */
  { path: "/profile.html",        label: "Profile",             critical: true  },
  { path: "/wallet.html",         label: "Wallet",              critical: true  },
  { path: "/payments.html",       label: "Payments",            critical: false },
  { path: "/loyalty.html",        label: "Loyalty",             critical: false },
  { path: "/messages.html",       label: "Messages",            critical: false },
  { path: "/notifications.html",  label: "Notifications",       critical: false },
  { path: "/dispute.html",        label: "Dispute",             critical: false },

  /* SmartPOS */
  { path: "/pos.html",            label: "SmartPOS",            critical: true  },
  { path: "/pos-kiosk.html",      label: "POS Kiosk",           critical: false },

  /* Admin */
  { path: "/admin.html",          label: "Admin panel",         critical: true  },
  { path: "/monitor.html",        label: "Monitor",             critical: false },
  { path: "/moderation.html",     label: "Moderation",          critical: false },
  { path: "/verification-admin.html","label":"Verification admin",critical: false },

  /* Business */
  { path: "/business.html",       label: "Business",            critical: false },
  { path: "/business-os.html",    label: "Business OS",         critical: false },
  { path: "/bnb.html",            label: "BnB Hub",             critical: false },
  { path: "/banking.html",        label: "Banking",             critical: false },
  { path: "/tech-hub.html",       label: "Tech Hub",            critical: false },

  /* Support */
  { path: "/help.html",           label: "Help",                critical: false },
  { path: "/support.html",        label: "Support",             critical: false },
  { path: "/trust.html",          label: "Trust & Safety",      critical: false },
  { path: "/referral.html",       label: "Referral",            critical: false },
];

/* ── Noise to suppress (known external failures) ───────────────── */
const IGNORE_PATTERNS = [
  "google.com/g/collect", "gtag", "favicon", "service-worker",
  "Cloud Firestore backend", "firebase-messaging", "analytics.google",
  "googletagmanager", "Could not reach Cloud Firestore backend",
  "Failed to load resource", "net::ERR_INTERNET_DISCONNECTED",
  "Failed to register a ServiceWorker",
];

function isNoise(msg) {
  return IGNORE_PATTERNS.some(p => msg.includes(p));
}

/* ── Main ───────────────────────────────────────────────────────── */
(async () => {
  const br  = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--no-proxy-server"],
  });
  const ctx = await br.newContext({
    viewport:          { width: 390, height: 844 },
    userAgent:         "Mozilla/5.0 (SOKONI-SmokeTest/2.0)",
    ignoreHTTPSErrors: true,
  });
  const pg  = await ctx.newPage();

  const results   = [];
  const notFound  = [];

  /* Track 404s globally */
  pg.on("response", r => {
    if (r.status() === 404) notFound.push(r.url());
  });

  for (const { path, label, critical } of PAGES) {
    const errs   = [];
    const onErr  = m => {
      if (m.type() !== "error") return;
      const t = m.text();
      if (!isNoise(t)) errs.push(t.substring(0, 180));
    };
    const onPageErr = e => {
      if (!isNoise(e.message)) errs.push("PAGE: " + e.message.substring(0, 160));
    };

    pg.on("console", onErr);
    pg.on("pageerror", onPageErr);

    let title = "—";
    try {
      const res = await pg.goto(BASE_URL + path, {
        waitUntil: "commit",
        timeout:   TIMEOUT,
      });
      await pg.waitForTimeout(1800);
      title = (await pg.title()).substring(0, 50);
      if (res && res.status() >= 400) {
        errs.push(`HTTP ${res.status()}`);
      }
    } catch (e) {
      errs.push("LOAD: " + e.message.substring(0, 100));
    }

    pg.off("console", onErr);
    pg.off("pageerror", onPageErr);

    results.push({ path, label, critical, ok: errs.length === 0, title, errs });
  }

  await br.close();

  /* ── Report ─────────────────────────────────────────────────── */
  console.log("\n═══════════════════════════════════════════════════");
  console.log(`  SOKONI SMOKE TEST — ${BASE_URL}`);
  console.log("═══════════════════════════════════════════════════\n");

  const criticalFails = [];
  const warningFails  = [];

  for (const r of results) {
    const icon = r.ok ? "✅" : (r.critical ? "❌" : "⚠️");
    console.log(`${icon} ${r.label.padEnd(28)} ${r.path}`);
    if (!r.ok) {
      r.errs.forEach(e => console.log(`     › ${e}`));
      if (r.critical) criticalFails.push(r);
      else            warningFails.push(r);
    }
  }

  if (notFound.length) {
    console.log("\n── 404s detected ──────────────────────────────────");
    notFound.slice(0, 20).forEach(u => console.log("  404:", u));
  }

  const passed = results.filter(r => r.ok).length;
  const total  = results.length;

  console.log("\n═══════════════════════════════════════════════════");
  console.log(`  ${passed}/${total} pages clean`);
  console.log(`  Critical failures : ${criticalFails.length}`);
  console.log(`  Warnings          : ${warningFails.length}`);
  console.log(`  404s detected     : ${notFound.length}`);
  console.log("═══════════════════════════════════════════════════\n");

  if (criticalFails.length > 0) {
    console.error("❌ SMOKE TEST FAILED — critical pages have errors");
    process.exit(1);
  }

  console.log("✅ All critical pages passed smoke test");
  process.exit(0);
})().catch(e => {
  console.error("FATAL:", e.message);
  process.exit(1);
});
