/* ============================================================
   SOKONI SITE CONFIG  —  sokoni-config.js

   Keys marked REQUIRED must be set for the feature to work.
   Keys marked OPTIONAL fall back gracefully when not set.
   Run `firebase functions:secrets:set <KEY>` for server-side keys.
============================================================ */

/* ══════════════════════════════════════════════════════════════════
   CANONICAL FIREBASE CONFIG

   WHY THIS IS HERE (P0, 2026-07-18).
   Eleven POS/admin pages initialised Firebase with
   `initializeApp(window._sokoniConfig || {})` — but **nothing anywhere ever defined
   `_sokoniConfig`**. The `|| {}` fallback swallowed it, so every one of those pages ran
   `initializeApp({})` with no apiKey and died with `auth/invalid-api-key`. Firebase Auth,
   Firestore, Storage and every callable Cloud Function were dead on all eleven pages —
   silently, because the fallback turned a missing config into an obscure auth error instead
   of a loud failure at load.

   Those pages do NOT load firebase.js, and they import a DIFFERENT SDK version (11.0.1 vs
   firebase.js's 10.12.2), so they cannot safely share firebase.js's initialised app object.
   What they can safely share is the config itself — plain data, version-agnostic. This file
   is already loaded by all eleven as a blocking classic script before their module runs, so
   it is the correct home.

   VALUES MUST MATCH firebase.js:48-63 EXACTLY. firebase.js keeps its own literal because it
   is loaded on pages that do not include this file; scripts/verify-firebase-config.js fails
   the build if the two ever drift.
══════════════════════════════════════════════════════════════════ */
window.SOKONI_FIREBASE_CONFIG = {
  apiKey:            "AIzaSyDt_FRoTdE5OpfPhLB0DApIm7p-I45hzVE",
  authDomain:        "auth.mysokoni.co.ke",
  projectId:         "sokoni-aeb26",
  storageBucket:     "sokoni-aeb26.firebasestorage.app",
  messagingSenderId: "24799054989",
  appId:             "1:24799054989:web:e1cf6ca8c281bf1abf26c4",
  measurementId:     "G-QT32H65TJS"
};

window.SOKONI_CONFIG = {

  /* ── 1. IntaSend M-Pesa (REQUIRED for live payments) ───────
     a) Sign up at https://intasend.com
     b) Dashboard → API Keys → copy PUBLIC key
     c) Paste below
     d) Server key: firebase functions:secrets:set INTASEND_PRIVATE_KEY
        (paste your ISPrivKey_live_XXXXXXX when prompted)        */
  intasendKey:  "ISPubKey_live_72b29717-0018-4bab-b9e0-eb105980e478",
  intasendLive: true,        // false = sandbox mode for testing

  /* ── 2. PayPal (OPTIONAL — enables PayPal redirect on checkout) ─
     Your PayPal.me username — e.g. "sokonimarket"
     checkout.html will open: https://www.paypal.me/sokonimarket/AMOUNT   */
  paypalEmail: "",           // ← your PayPal.me username (not email)

  /* ── 4. Algolia search (OPTIONAL — enables typo tolerance + instant search) ─
     a) Sign up at https://algolia.com (free tier: 10k records, 10k ops/month)
     b) Application ID is public — kept here.
     c) Admin key: firebase functions:secrets:set ALGOLIA_ADMIN_KEY  (NEVER paste here)
     d) Search key: stored in Secret Manager as ALGOLIA_SEARCH_KEY.
        The client fetches a short-lived secured key at runtime via the
        getAlgoliaSearchKey Cloud Function — no static key is kept in this file.
     e) Set env var: add ALGOLIA_APP_ID=FF2WSTR4YC to functions/.env             */
  algoliaAppId:    "FF2WSTR4YC",
  algoliaSearchKey: "",   // loaded at runtime via getAlgoliaSearchKey CF

  /* Primary index */
  algoliaIndex:    "sokoni_products",

  /* Production indexes (must match your Algolia dashboard exactly) */
  algoliaIndexes: {
    products:    "sokoni_products",
    stores:      "sokoni_shops",
    services:    "sokoni_services",
    events:      "sokoni_events",
    properties:  "sokoni_properties",
    vehicles:    "sokoni_vehicles",
    jobs:        "sokoni_jobs",
    global:      "global_search",
  },

  /* Sort replicas */
  algoliaReplicas: {
    products_price_asc:  "sokoni_products_price_asc",
    products_price_desc: "sokoni_products_price_desc",
    products_newest:     "sokoni_products_newest",
    products_rating:     "sokoni_products_rating",
    products_popular:    "sokoni_products_popular",
    services_price_asc:  "sokoni_services_price_asc",
    events_soonest:      "sokoni_events_soonest",
    properties_price_asc: "sokoni_properties_price_asc",
    vehicles_price_asc:  "sokoni_vehicles_price_asc",
    vehicles_year_desc:  "sokoni_vehicles_year_desc",
    jobs_newest:         "sokoni_jobs_newest",
    jobs_deadline:       "sokoni_jobs_deadline",
  },

  /* Secured key endpoint (CF generates short-lived scoped keys) */
  algoliaSecuredKeyEndpoint: "getAlgoliaSearchKey",

  /* ── 5. Typesense search (OPTIONAL — alternative / secondary engine) ──
     Sign up:  https://cloud.typesense.org  (free tier available)
     OR self-host:  docker run -p 8108:8108 typesense/typesense:27.1

     a) Create a cluster and copy the host (e.g. xyz.a1.typesense.net)
     b) Generate an API key pair:
          Admin key  → firebase functions:secrets:set TYPESENSE_ADMIN_KEY
          Search key → firebase functions:secrets:set TYPESENSE_SEARCH_KEY
     c) Set node list in functions/.env.sokoni-aeb26:
          TYPESENSE_NODES=xyz.a1.typesense.net:443:https
          (Multi-node HA: node1:443:https,node2:443:https,node3:443:https)
     d) Paste the search-only key below (getTypesenseSearchKey CF issues
        short-lived scoped keys — this is the fallback for dev only).
     e) For multi-node, use typesenseNodes array (overrides host/port).
     f) Run: firebase deploy --only functions
          then call typesenseCreateCollections (admin CF)
          then call typesenseBackfill for each collection.

     When both Algolia and Typesense are configured:
       - sokoni-search-engine.js  uses Algolia as primary
       - sokoni-typesense-engine.js uses Typesense as secondary / fallback */

  /* Single-node (Typesense Cloud) */
  typesenseHost:     "4kn6y5bfcxv8o702p-1.a2.typesense.net",
  typesensePort:     443,
  typesenseProtocol: "https",
  typesenseSearchKey:"",       // ← Search-Only API key (NOT Admin key)

  /* Multi-node HA cluster (overrides host/port above when set) */
  typesenseNodes: [],          // ← e.g. ["n1.example.com:443:https","n2.example.com:443:https"]

  /* Secured key Cloud Function endpoint */
  typesenseSecuredKeyEndpoint: "getTypesenseSearchKey",

  /* All 25 Typesense collection names (v2) */
  typesenseCollections: {
    /* Core commerce */
    products:      "sokoni_products",
    shops:         "sokoni_shops",
    services:      "sokoni_services",
    events:        "sokoni_events",
    properties:    "sokoni_properties",
    vehicles:      "sokoni_vehicles",
    jobs:          "sokoni_jobs",
    /* Hospitality & Lifestyle */
    hotels:        "sokoni_hotels",
    restaurants:   "sokoni_restaurants",
    sports:        "sokoni_sports",
    /* Professional & Knowledge */
    healthcare:    "sokoni_healthcare",
    education:     "sokoni_education",
    professionals: "sokoni_professionals",
    /* Community & Content */
    reviews:       "sokoni_reviews",
    users:         "sokoni_users",
    /* Catalogue */
    categories:    "sokoni_categories",
    brands:        "sokoni_brands",
    collections:   "sokoni_collections",
    coupons:       "sokoni_coupons",
    /* Content & Discovery */
    support:       "sokoni_support",
    faq:           "sokoni_faq",
    blog:          "sokoni_blog",
    announcements: "sokoni_announcements",
    tourism:       "sokoni_tourism",
    entertainment: "sokoni_entertainment",
  },

  /* Typesense monitoring (v2) */
  typesenseDashboardEndpoint: "typesenseGetDashboard",
  typesenseHealthEndpoint:    "typesenseMonitorHealth",

  /* SLA targets (used by admin UI) */
  typesenseSLA: {
    latencyP99Ms:  150,
    queueMaxDepth: 10000,
    dlqMaxDepth:   50,
  },

};

/* ── Config validation (runs once on load) ── */
(function _checkConfig() {
  var c = window.SOKONI_CONFIG || {};
  var missing = [];
  if (!c.intasendKey) missing.push('IntaSend Public Key');
  if (!missing.length) return;

  /* Expose for admin panel */
  window._SOKONI_CONFIG_MISSING = missing;

  /* Warn in console only (no UI intrusion on user-facing pages) */
  console.warn('[SOKONI Config] Keys not set — some features will be limited.\nMissing: ' + missing.join(', ') + '\nEdit sokoni-config.js to add them.');

  /* Show banner on admin, seller, and invoice pages */
  var _path = window.location.pathname;
  if (_path.indexOf('admin') !== -1 || _path.indexOf('seller') !== -1 || _path.indexOf('invoice') !== -1) {
    document.addEventListener('DOMContentLoaded', function () {
      var existing = document.getElementById('_sokoniConfigBanner');
      if (existing) return;
      var bar = document.createElement('div');
      bar.id = '_sokoniConfigBanner';
      bar.style.cssText = 'position:fixed;bottom:0;left:0;right:0;z-index:9999;background:#1a1000;border-top:2px solid #ffb400;padding:10px 16px;display:flex;align-items:center;gap:12px;font-size:12px;color:rgba(255,255,255,0.7);font-family:inherit;';
      bar.innerHTML = '<span style="font-size:18px;">⚠️</span>'
        + '<div style="flex:1;"><strong style="color:#ffb400;">Config incomplete:</strong> '
        + missing.map(function(k){ return '<code style="background:rgba(255,255,255,0.08);padding:1px 5px;border-radius:4px;">'+k+'</code>'; }).join(' and ')
        + ' not set in <code style="background:rgba(255,255,255,0.08);padding:1px 5px;border-radius:4px;">sokoni-config.js</code>.'
        + '</div>'
        + '<button onclick="this.parentNode.remove()" style="background:none;border:none;color:rgba(255,255,255,0.3);font-size:18px;cursor:pointer;line-height:1;padding:0 4px;">✕</button>';
      document.body.appendChild(bar);
    });
  }
}());
