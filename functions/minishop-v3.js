/* ================================================================
   SOKONI MiniShop Engine v3.0
   Firebase Cloud Functions — Gen 2, Node 22

   12 Cloud Functions:
     1.  miniShopOGMeta             onRequest  — dynamic OG metadata + shell page
     2.  miniShopCreatePromotion    onCall     — seller creates flash sale / coupon
     3.  miniShopGetPromotions      onCall     — get active promotions (public)
     4.  miniShopUpdatePromotion    onCall     — pause / activate / delete a promo
     5.  miniShopToggleWishlist     onCall     — buyer adds / removes wishlist item
     6.  miniShopGetWishlist        onCall     — buyer retrieves their wishlist
     7.  miniShopShareProduct       onCall     — generate product share card URLs
     8.  miniShopAIMarketing        onCall     — extended AI marketing assistant
     9.  miniShopSendAnnouncement   onCall     — seller broadcasts to followers
     10. miniShopGetAnnouncements   onCall     — customer reads shop announcements
     11. miniShopGetSimilar         onCall     — recommend similar businesses
     12. miniShopScheduledDigest    onSchedule — weekly seller analytics email (Mon 07:00 EAT)

   New Collections (no composite indexes — single-field or doc-ID only):
     minishopPromotions/{promoId}
     minishopPromoCodes/{shopId_CODE}           ← uniqueness lock for promo codes
     minishopWishlist/{uid}/items/{productId}   ← buyer wishlist subcollection
     minishopAnnouncements/{shopId}/posts/{id}  ← shop announcements subcollection
     aiMktRL/{uid_YYYYMMDD}                     ← AI marketing rate-limit scratch docs

   Existing collections referenced:
     shopHandles/{handle}
     minishopConfig/{shopId}
     minishopAnalytics/{shopId}
     shops/{shopId}

   Secrets:
     ANTHROPIC_API_KEY  — Claude Haiku inference (miniShopAIMarketing)
     SENDGRID_API_KEY   — digest email (miniShopScheduledDigest)
================================================================ */

'use strict';

const { onCall, onRequest, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule }                    = require('firebase-functions/v2/scheduler');
const { defineSecret }                  = require('firebase-functions/params');
const { getFirestore, FieldValue, Timestamp } = require('firebase-admin/firestore');
const logger                            = require('firebase-functions/logger');

/* ── Secrets ──────────────────────────────────────────────────────────────── */
const ANTHROPIC_API_KEY = defineSecret('ANTHROPIC_API_KEY');
const SENDGRID_API_KEY  = defineSecret('SENDGRID_API_KEY');

/* ── Constants ────────────────────────────────────────────────────────────── */
const REGION   = 'us-central1';
const BASE_URL = 'https://mysokoni.co.ke';
const SHOP_URL = `${BASE_URL}/shop/`;

const RESERVED_HANDLES = new Set([
  'admin', 'sokoni', 'shop', 'api', 'www', 'app',
  'help', 'support', 'terms', 'privacy',
]);

const BOT_UA_SUBSTRINGS = [
  'facebookexternalhit', 'whatsapp', 'twitterbot', 'linkedinbot',
  'telegrambot', 'googlebot', 'slackbot', 'bingbot', 'applebot',
  'discordbot', 'pinterest',
];

const PROMO_TYPES    = new Set(['flash_sale', 'bundle', 'coupon', 'seasonal']);
const PROMO_ACTIONS  = new Set(['pause', 'activate', 'delete']);
const AI_MKT_TYPES   = new Set(['best_times', 'seasonal', 'trending_angle', 'campaign_plan']);
const ANNOUNCE_TYPES = new Set(['general', 'sale', 'new_arrival', 'event', 'closure']);

/** Rotating tips for the weekly digest email */
const WEEKLY_TIPS = [
  'Pin your best-selling product to the top of your MiniShop to catch first-time visitors instantly.',
  'Post on WhatsApp Status between 7–9am and 6–8pm EAT for the highest reach among Kenyan buyers.',
  'Shops with a professional cover photo receive up to 40% more profile views — update yours this week.',
  'Responding to customer messages within 1 hour signals reliability. SOKONI surfaces responsive sellers higher in search.',
  'Add your M-Pesa Paybill or Till number to your business card section to reduce checkout friction.',
  'A 24–48 hour flash sale with a clear end time creates urgency and drives impulse purchases.',
  'Follow up with buyers after delivery — a 5-star review significantly boosts your shop visibility.',
  'Use the Services tab to list installation, customisation, or delivery. Services often convert better than products alone.',
  'Share your MiniShop link in local WhatsApp groups (with admin permission) for free targeted traffic.',
  'Product photos with clean backgrounds and natural lighting get 3× more clicks than blurry images.',
  'Seasonal promotions tied to Kenyan events (Madaraka Day, Eid, Christmas) outperform generic year-round offers.',
  'Add your location and delivery areas to attract nearby buyers who prefer local sellers.',
  'Send a "New Arrivals" announcement whenever you stock new items to re-engage your followers.',
];

/* ── Internal helpers ─────────────────────────────────────────────────────── */

/** Shorthand for the Firestore client */
const _db = () => getFirestore();

/**
 * Require Firebase Auth on an onCall request.
 * Returns the uid on success; throws HttpsError('unauthenticated') on failure.
 */
function _requireAuth(context) {
  if (!context.auth?.uid) {
    throw new HttpsError('unauthenticated', 'Login required.');
  }
  return context.auth.uid;
}

/**
 * Strip HTML tags, trim, and truncate a string to `max` characters.
 * Returns '' for non-string inputs.
 */
function _san(s, max = 500) {
  if (typeof s !== 'string') return '';
  return s.replace(/<[^>]*>/g, '').trim().slice(0, max);
}

/**
 * Escape HTML special characters for safe embedding in HTML templates.
 * Must be applied to every piece of user-supplied data placed in HTML.
 */
function _escHtml(s) {
  if (typeof s !== 'string') return '';
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Safely encode an object for embedding inside a JSON-LD <script> block.
 * Prevents </script> injection while keeping valid JSON.
 */
function _escJsonLd(obj) {
  return JSON.stringify(obj)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
}

/** Return today's date as YYYYMMDD string (UTC). */
function _today() {
  return new Date().toISOString().slice(0, 10).replace(/-/g, '');
}

/** Set permissive CORS headers for onRequest responses. */
function _setCors(res) {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
}

/**
 * Verify the caller owns a given shopId via shops/{shopId}.sellerUid === uid.
 * Supports both `sellerUid` and `ownerId` field names used across the platform.
 * Returns the shop data on success; throws HttpsError on failure.
 */
async function _assertShopOwner(shopId, uid) {
  if (typeof shopId !== 'string' || !shopId.trim()) {
    throw new HttpsError('invalid-argument', 'shopId is required.');
  }
  const snap = await _db().collection('shops').doc(shopId).get();
  if (!snap.exists) {
    throw new HttpsError('not-found', 'Shop not found.');
  }
  const data = snap.data();
  if (data.sellerUid !== uid && data.ownerId !== uid) {
    throw new HttpsError('permission-denied', 'You do not own this shop.');
  }
  return data;
}

/** Detect social/search crawler bots by User-Agent string. */
function _isBot(userAgent) {
  if (typeof userAgent !== 'string' || !userAgent) return false;
  const ua = userAgent.toLowerCase();
  return BOT_UA_SUBSTRINGS.some(b => ua.includes(b));
}

/**
 * Parse a minishop handle from the request URL path.
 * Supports /shop/<handle>, /@<handle>, or ?handle=<handle>.
 */
function _parseHandle(req) {
  const path = (req.path || '/').replace(/\/{2,}/g, '/');
  let m = path.match(/^\/shop\/([a-z0-9_-]{1,30})(?:\/|$)/i);
  if (m) return m[1].toLowerCase();
  m = path.match(/^\/@([a-z0-9_-]{1,30})(?:\/|$)/i);
  if (m) return m[1].toLowerCase();
  const q = (req.query.handle || '').trim().toLowerCase();
  return q || null;
}

/**
 * Convert a Firestore Timestamp or date-like value to ISO 8601 string.
 * Returns null for falsy or unparseable input.
 */
function _tsToISO(ts) {
  if (!ts) return null;
  if (typeof ts.toDate === 'function') return ts.toDate().toISOString();
  if (typeof ts._seconds === 'number') return new Date(ts._seconds * 1000).toISOString();
  if (typeof ts.seconds === 'number')  return new Date(ts.seconds * 1000).toISOString();
  return null;
}

/* ── HTML builder helpers (used only by miniShopOGMeta) ─────────────────── */

function _build404Html(handle) {
  const safe = _escHtml(handle);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Shop Not Found — SOKONI</title>
  <meta name="robots" content="noindex, nofollow">
  <style>
    body{background:#050505;color:#e8e8e8;font-family:Arial,sans-serif;
         display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
    .wrap{text-align:center;max-width:480px;padding:24px}
    h1{color:#71ff00}
    a{color:#71ff00}
  </style>
</head>
<body>
  <div class="wrap">
    <div style="font-size:64px">&#x1F3EA;</div>
    <h1>Shop Not Found</h1>
    <p>The MiniShop <strong>@${safe}</strong> doesn&apos;t exist on SOKONI yet.</p>
    <p><a href="${_escHtml(BASE_URL)}">Discover SOKONI &#x2192;</a></p>
  </div>
</body>
</html>`;
}

function _buildBotHtml({ shopName, description, coverUrl, shopUrl, schemaStr, handle }) {
  const eName   = _escHtml(shopName);
  const eDesc   = _escHtml(description);
  const eCover  = _escHtml(coverUrl);
  const eUrl    = _escHtml(shopUrl);
  const eHandle = _escHtml(handle);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${eName} — SOKONI</title>
  <meta name="description" content="${eDesc}">
  <meta name="robots" content="index, follow">
  <link rel="canonical" href="${eUrl}">
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="SOKONI">
  <meta property="og:title" content="${eName} — SOKONI">
  <meta property="og:description" content="${eDesc}">
  <meta property="og:image" content="${eCover}">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta property="og:url" content="${eUrl}">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:site" content="@mysokoni">
  <meta name="twitter:title" content="${eName} — SOKONI">
  <meta name="twitter:description" content="${eDesc}">
  <meta name="twitter:image" content="${eCover}">
  <meta http-equiv="refresh" content="0; url=${eUrl}">
  <script type="application/ld+json">${schemaStr}</script>
</head>
<body>
  <p>Redirecting to <a href="${eUrl}">@${eHandle} on SOKONI</a>&#8230;</p>
</body>
</html>`;
}

function _buildShellHtml({ shopName, description, coverUrl, shopUrl, schemaStr, handle }) {
  const eName   = _escHtml(shopName);
  const eDesc   = _escHtml(description);
  const eCover  = _escHtml(coverUrl);
  const eUrl    = _escHtml(shopUrl);
  /* jsHandle is restricted to [a-z0-9_-] — safe as an unquoted JS string value */
  const jsHandle = handle.replace(/[^a-z0-9_-]/g, '');
  return `<!doctype html>
<html lang="en" data-no-header="true">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${eName} — SOKONI</title>
  <meta name="description" content="${eDesc}">
  <meta name="robots" content="index, follow">
  <link rel="canonical" href="${eUrl}">
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="SOKONI">
  <meta property="og:title" content="${eName} — SOKONI">
  <meta property="og:description" content="${eDesc}">
  <meta property="og:image" content="${eCover}">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta property="og:url" content="${eUrl}">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:site" content="@mysokoni">
  <meta name="twitter:title" content="${eName} — SOKONI">
  <meta name="twitter:description" content="${eDesc}">
  <meta name="twitter:image" content="${eCover}">
  <link rel="icon" type="image/png" href="/assets/sokoni logoo.jpeg">
  <link rel="apple-touch-icon" href="/assets/sokoni logoo.jpeg">
  <meta name="theme-color" content="#00bcd4">
  <script type="application/ld+json">${schemaStr}</script>
  <link rel="stylesheet" href="/minishop.css">
</head>
<body class="ms-body">

<!-- Campaign banner (hidden until JS data loads) -->
<div id="ms-campaign-banner" class="ms-campaign-banner" hidden></div>

<!-- Announcement bar -->
<div id="ms-announcement" class="ms-announcement" hidden></div>

<!-- Skeleton loader (visible immediately while JS initialises) -->
<div id="ms-skeleton" class="ms-skeleton">
  <div class="ms-sk-cover"></div>
  <div class="ms-sk-header"></div>
  <div class="ms-sk-grid">
    <div class="ms-sk-card"></div>
    <div class="ms-sk-card"></div>
    <div class="ms-sk-card"></div>
    <div class="ms-sk-card"></div>
  </div>
</div>

<!-- Main app shell (hidden until JS populates and reveals it) -->
<div id="ms-app" class="ms-app" hidden>

  <!-- HERO -->
  <div class="ms-hero">
    <div class="ms-cover" id="msCover">
      <div class="ms-cover-gradient"></div>
      <div class="ms-hero-actions">
        <button class="ms-share-trigger" onclick="SokoniMiniShop.toggleSharePanel()" aria-label="Share">&#x21a1; Share</button>
        <button class="ms-follow-btn ms-follow-hero" id="msFollowBtn" onclick="SokoniMiniShop.toggleFollow()">+ Follow</button>
      </div>
    </div>
    <img class="ms-avatar" id="msLogo" src="" alt="" loading="lazy">
  </div>

  <!-- SHOP IDENTITY CARD -->
  <div class="ms-identity-card">
    <div class="ms-identity-top">
      <div class="ms-name-row">
        <h1 id="msShopName" class="ms-shop-name">${eName}</h1>
        <span class="ms-verified-badge" id="msVerified" hidden>&#x2713; Verified</span>
      </div>
      <p id="msTagline" class="ms-tagline"></p>
      <div class="ms-stats-bar" id="msStatsBar">
        <span id="msRating" class="ms-stat-rating"></span>
        <span class="ms-stat-div">&#xB7;</span>
        <span id="msCategory" class="ms-stat-cat"></span>
        <span class="ms-stat-div">&#xB7;</span>
        <span id="msLocation" class="ms-stat-loc"></span>
        <span class="ms-stat-div">&#xB7;</span>
        <span id="msStatus" class="ms-stat-status"></span>
      </div>
      <div class="ms-trust-bar" id="msTrustBar"></div>
    </div>
    <div class="ms-smart-cta" id="msSmartCta"></div>
  </div>

  <!-- SHARE PANEL -->
  <div class="ms-share-panel" id="msSharePanel" hidden>
    <div class="ms-share-panel-inner">
      <div class="ms-share-header">
        <span>Share This Shop</span>
        <button onclick="SokoniMiniShop.toggleSharePanel()">&#x2715;</button>
      </div>
      <div class="ms-share-grid" id="msShareGrid"></div>
      <div class="ms-share-url-row">
        <input type="text" id="msShareUrl" readonly>
        <button onclick="SokoniMiniShop.copyLink()">Copy</button>
      </div>
    </div>
  </div>

  <!-- TABS -->
  <div class="ms-tabs" id="msTabs">
    <button class="ms-tab active" data-tab="store">Store</button>
    <button class="ms-tab" data-tab="services">Services</button>
    <button class="ms-tab" data-tab="reviews">Reviews</button>
    <button class="ms-tab" data-tab="about">About</button>
  </div>

  <!-- STORE TAB -->
  <div id="msStore" class="ms-tab-content active">
    <div class="ms-section" id="msBestSellersSection" hidden>
      <div class="ms-section-header">
        <span>&#x1F525; Best Sellers</span>
        <a href="#" class="ms-see-all" id="msBestSellersAll" hidden>See all &#x2192;</a>
      </div>
      <div class="ms-product-grid" id="msBestSellers"></div>
    </div>
    <div class="ms-section" id="msNewArrivalsSection" hidden>
      <div class="ms-section-header">
        <span>&#x2728; New Arrivals</span>
        <a href="#" class="ms-see-all" id="msNewArrivalsAll" hidden>See all &#x2192;</a>
      </div>
      <div class="ms-product-grid" id="msNewArrivals"></div>
    </div>
    <div class="ms-section" id="msTodaysDealsSection" hidden>
      <div class="ms-section-header">
        <span>&#x26A1; Today&apos;s Deals</span>
      </div>
      <div class="ms-product-grid ms-deals-grid" id="msTodaysDeals"></div>
    </div>
    <div class="ms-section" id="msAllProductsSection">
      <div class="ms-section-header">
        <span id="msAllProductsTitle">&#x1F6CD; All Products</span>
        <a href="#" class="ms-see-all" id="msAllProductsAll" hidden>See all &#x2192;</a>
      </div>
      <div class="ms-product-grid" id="msProductGrid"></div>
    </div>
  </div>

  <!-- SERVICES TAB -->
  <div id="msServices" class="ms-tab-content" hidden>
    <div class="ms-section">
      <div class="ms-services-list" id="msServicesList"></div>
    </div>
  </div>

  <!-- REVIEWS TAB -->
  <div id="msReviews" class="ms-tab-content" hidden>
    <div class="ms-review-summary" id="msReviewSummary"></div>
    <div class="ms-review-list" id="msReviewList"></div>
  </div>

  <!-- ABOUT TAB -->
  <div id="msAbout" class="ms-tab-content" hidden></div>

  <!-- BUSINESS CARD -->
  <div id="msBusinessCard" class="ms-business-card-section" hidden></div>

</div>

<!-- NOT FOUND STATE -->
<div id="ms-not-found" class="ms-not-found" hidden>
  <div class="ms-nf-wrap">
    <div class="ms-nf-icon">&#x1F3EA;</div>
    <h2>Shop Not Found</h2>
    <p>This MiniShop doesn&apos;t exist yet on SOKONI.</p>
    <a href="/" class="ms-btn-primary">Discover SOKONI</a>
  </div>
</div>

<!-- QR MODAL -->
<div class="ms-modal-overlay" id="msQrModal" hidden onclick="if(event.target===this)this.hidden=true">
  <div class="ms-modal-box">
    <div class="ms-modal-header">
      <h3>Scan to Visit</h3>
      <button class="ms-modal-close" onclick="document.getElementById('msQrModal').hidden=true">&#x2715;</button>
    </div>
    <div id="msQrCode" class="ms-qr-display"></div>
    <p id="msQrUrl" class="ms-qr-url"></p>
    <div class="ms-modal-actions">
      <button onclick="SokoniMiniShop.downloadQR()" class="ms-btn-outline">&#x2B07; Download</button>
      <button onclick="SokoniMiniShop.printPoster()" class="ms-btn-outline">&#x1F5A8; Print Poster</button>
    </div>
  </div>
</div>

<!-- WHATSAPP STATUS MODE OVERLAY -->
<div id="ms-status-mode" class="ms-status-mode" hidden>
  <div class="ms-status-product" id="msStatusProduct"></div>
  <div class="ms-status-actions" id="msStatusActions"></div>
  <div class="ms-status-footer">
    <span>Shop on <strong>SOKONI</strong></span>
  </div>
</div>

<!-- Toast container -->
<div id="msToasts" class="ms-toast-container" aria-live="polite"></div>

<!-- Pre-inject handle before MiniShop engine loads -->
<script>window.MS_HANDLE = '${jsHandle}';</script>

<!-- Firebase SDK (populated by Firebase Hosting at runtime) -->
<script src="/__/firebase/init.js"></script>

<!-- MiniShop engine -->
<script src="/sokoni-minishop.js"></script>
<script>
  document.addEventListener('DOMContentLoaded', function () {
    if (typeof SokoniMiniShop !== 'undefined') {
      SokoniMiniShop.initPublic();
    }
  });
</script>
</body>
</html>`;
}

/* ════════════════════════════════════════════════════════════════
   1.  miniShopOGMeta  (onRequest GET/HEAD)
       Dynamic Open Graph metadata + full shell page for social
       crawlers and real browsers.
       Path: /shop/<handle>  or  /@<handle>
       Cache: public, max-age=60 (1 min CDN)
════════════════════════════════════════════════════════════════ */
exports.miniShopOGMeta = onRequest(
  { region: REGION, cors: false },
  async (req, res) => {
    _setCors(res);
    if (req.method === 'OPTIONS') { res.status(204).send(''); return; }

    /* ── Parse and validate handle ── */
    const rawHandle = _parseHandle(req);
    const errHtml = (code, msg) =>
      res.status(code).set('Content-Type', 'text/html; charset=utf-8').send(
        `<!doctype html><html><head><title>Error — SOKONI</title></head>`
        + `<body><h1>${code}</h1><p>${_escHtml(msg)}</p></body></html>`
      );

    if (!rawHandle) { errHtml(400, 'No shop handle in URL.'); return; }

    if (
      rawHandle.length < 3 ||
      rawHandle.length > 30 ||
      !/^[a-z0-9_-]+$/.test(rawHandle)
    ) { errHtml(400, 'Invalid shop handle format.'); return; }

    if (RESERVED_HANDLES.has(rawHandle)) {
      errHtml(400, 'Reserved handle.'); return;
    }

    const handle = rawHandle;

    try {
      const db = _db();

      /* ── Resolve handle → shopId ── */
      const handleSnap = await db.collection('shopHandles').doc(handle).get();
      if (!handleSnap.exists) {
        res.status(404).set('Content-Type', 'text/html; charset=utf-8').send(_build404Html(handle));
        return;
      }
      const { shopId } = handleSnap.data();

      /* ── Fetch shop + config in parallel ── */
      const [shopSnap, configSnap] = await Promise.all([
        db.collection('shops').doc(shopId).get(),
        db.collection('minishopConfig').doc(shopId).get(),
      ]);

      if (!shopSnap.exists) {
        res.status(404).set('Content-Type', 'text/html; charset=utf-8').send(_build404Html(handle));
        return;
      }

      const shop   = shopSnap.data();
      const config = configSnap.exists ? configSnap.data() : {};

      /* ── Build safe OG values ── */
      const shopName   = _san(shop.name || 'SOKONI Shop', 80);
      const shopDesc   = _san(
        shop.description || config.description
          || `Shop ${shopName} on SOKONI — Kenya’s #1 marketplace.`,
        200
      );
      const coverUrl   = _san(
        config.coverUrl || shop.coverUrl || `${BASE_URL}/assets/Sokoni%20Logo.png`,
        500
      );
      const shopUrl    = `${SHOP_URL}${handle}`;
      const rating     = typeof shop.rating === 'number' ? shop.rating : null;
      const telephone  = _san(config.contactPhone || shop.phone || '', 30);
      const category   = _san(shop.category || '', 60);

      /* ── Build Schema.org JSON-LD ── */
      const schemaOrg = {
        '@context': 'https://schema.org',
        '@type': 'LocalBusiness',
        name: shopName,
        image: coverUrl,
        url: shopUrl,
        description: shopDesc,
        ...(telephone && { telephone }),
        ...(category  && { additionalType: category }),
        ...(rating !== null && {
          aggregateRating: {
            '@type': 'AggregateRating',
            ratingValue: rating,
            bestRating: 5,
            worstRating: 1,
          },
        }),
      };
      const schemaStr = _escJsonLd(schemaOrg);

      /* ── Response headers ── */
      res.set('Cache-Control', 'public, max-age=60, s-maxage=60');
      res.set('X-Robots-Tag', 'index, follow');
      res.set('Content-Type', 'text/html; charset=utf-8');

      const ua = req.headers['user-agent'] || '';

      if (_isBot(ua)) {
        /* Bots: return minimal OG HTML with meta refresh */
        res.status(200).send(
          _buildBotHtml({ shopName, description: shopDesc, coverUrl, shopUrl, schemaStr, handle })
        );
      } else {
        /* Real users: return full shell page */
        res.status(200).send(
          _buildShellHtml({ shopName, description: shopDesc, coverUrl, shopUrl, schemaStr, handle,
            rating, telephone, category })
        );
      }

    } catch (err) {
      logger.error('miniShopOGMeta error', { handle, code: err.code });
      res.status(500).set('Content-Type', 'text/html; charset=utf-8').send(
        '<!doctype html><html><head><title>Error — SOKONI</title></head>'
        + '<body><h1>500</h1><p>Something went wrong. Please try again.</p></body></html>'
      );
    }
  }
);

/* ════════════════════════════════════════════════════════════════
   2.  miniShopCreatePromotion  (onCall)
       Seller creates a flash sale, bundle, coupon, or seasonal promo.
════════════════════════════════════════════════════════════════ */
exports.miniShopCreatePromotion = onCall(
  { region: REGION, cors: true, enforceAppCheck: true },
  async (request) => {
    const uid = _requireAuth(request);
    const {
      shopId, type: rawType, title: rawTitle, description: rawDesc,
      discountType: rawDT, discountValue: rawDV, minOrder: rawMin,
      maxUses: rawMax, validUntil: rawVU, productIds: rawPids, code: rawCode,
    } = request.data || {};

    /* ── Ownership ── */
    await _assertShopOwner(shopId, uid);

    /* ── type ── */
    const safeType = _san(rawType, 20);
    if (!PROMO_TYPES.has(safeType)) {
      throw new HttpsError('invalid-argument', 'type must be one of: flash_sale, bundle, coupon, seasonal.');
    }

    /* ── title ── */
    const safeTitle = _san(rawTitle, 80);
    if (safeTitle.length < 2) {
      throw new HttpsError('invalid-argument', 'title must be at least 2 characters.');
    }

    /* ── description ── */
    const safeDesc = _san(rawDesc, 500);

    /* ── discountType + discountValue ── */
    if (rawDT !== 'percent' && rawDT !== 'fixed') {
      throw new HttpsError('invalid-argument', "discountType must be 'percent' or 'fixed'.");
    }
    const safeDiscountType = rawDT;
    const dv = Number(rawDV);
    if (!isFinite(dv) || dv <= 0) {
      throw new HttpsError('invalid-argument', 'discountValue must be a positive number.');
    }
    if (safeDiscountType === 'percent' && (dv < 1 || dv > 99)) {
      throw new HttpsError('invalid-argument', 'Percentage discount must be between 1 and 99.');
    }
    const safeDiscountValue = dv;

    /* ── minOrder ── */
    const safeMinOrder = rawMin !== undefined ? Math.max(0, Number(rawMin) || 0) : 0;

    /* ── maxUses ── */
    const safeMaxUses = rawMax !== undefined
      ? (Number.isInteger(rawMax) && rawMax > 0 ? rawMax : null)
      : null;

    /* ── validUntil ── */
    if (!rawVU || typeof rawVU !== 'string') {
      throw new HttpsError('invalid-argument', 'validUntil is required (ISO date string).');
    }
    const vuDate = new Date(rawVU);
    if (isNaN(vuDate.getTime())) {
      throw new HttpsError('invalid-argument', 'validUntil must be a valid ISO date string.');
    }
    const nowMs = Date.now();
    if (vuDate.getTime() <= nowMs) {
      throw new HttpsError('invalid-argument', 'validUntil must be a future date.');
    }
    if (vuDate.getTime() > nowMs + 90 * 24 * 60 * 60 * 1000) {
      throw new HttpsError('invalid-argument', 'validUntil must be within 90 days from now.');
    }
    const validUntilTs = Timestamp.fromDate(vuDate);

    /* ── productIds ── */
    const safePids = Array.isArray(rawPids)
      ? rawPids.slice(0, 20).map(p => _san(String(p), 80)).filter(Boolean)
      : [];

    /* ── promo code ── */
    let safeCode = null;
    if (rawCode) {
      const candidate = _san(String(rawCode).toUpperCase(), 20);
      if (candidate.length < 3) {
        throw new HttpsError('invalid-argument', 'code must be at least 3 characters.');
      }
      if (!/^[A-Z0-9]+$/.test(candidate)) {
        throw new HttpsError('invalid-argument', 'code must contain only uppercase letters (A-Z) and digits (0-9).');
      }
      /* Uniqueness check — doc-ID get, no composite index */
      const codeDocRef = _db().collection('minishopPromoCodes').doc(`${shopId}_${candidate}`);
      const codeSnap   = await codeDocRef.get();
      if (codeSnap.exists) {
        throw new HttpsError('already-exists', 'This promo code is already in use for this shop.');
      }
      safeCode = candidate;
    }

    /* ── Write ── */
    const db      = _db();
    const promoRef = db.collection('minishopPromotions').doc();
    const promoId  = promoRef.id;
    const batch    = db.batch();

    batch.set(promoRef, {
      shopId,
      type:          safeType,
      title:         safeTitle,
      description:   safeDesc,
      discountType:  safeDiscountType,
      discountValue: safeDiscountValue,
      minOrder:      safeMinOrder,
      maxUses:       safeMaxUses,
      usesCount:     0,
      validUntil:    validUntilTs,
      productIds:    safePids,
      code:          safeCode,
      status:        'active',
      createdBy:     uid,
      createdAt:     FieldValue.serverTimestamp(),
    });

    if (safeCode) {
      batch.set(
        db.collection('minishopPromoCodes').doc(`${shopId}_${safeCode}`),
        { promoId, shopId, code: safeCode, createdAt: FieldValue.serverTimestamp() }
      );
    }

    await batch.commit();
    logger.info('miniShopCreatePromotion', { shopId, promoId, type: safeType });

    return { promoId, type: safeType, title: safeTitle, code: safeCode };
  }
);

/* ════════════════════════════════════════════════════════════════
   3.  miniShopGetPromotions  (onCall — public, no auth required)
       Returns active, non-expired promotions for a shop.
       Filters and sorts in JS to avoid composite indexes.
════════════════════════════════════════════════════════════════ */
exports.miniShopGetPromotions = onCall(
  { region: REGION, cors: true, enforceAppCheck: true },
  async (request) => {
    const { shopId } = request.data || {};
    if (typeof shopId !== 'string' || !shopId.trim()) {
      throw new HttpsError('invalid-argument', 'shopId is required.');
    }

    const db  = _db();
    const now = Date.now();

    /* Single-field query on shopId; status + validUntil filtered in JS */
    const snap = await db
      .collection('minishopPromotions')
      .where('shopId', '==', shopId)
      .limit(60)   /* generous limit to account for JS filtering */
      .get();

    const promotions = snap.docs
      .filter(d => {
        const p = d.data();
        return (
          p.status === 'active' &&
          p.validUntil &&
          (_tsToISO(p.validUntil) ? new Date(_tsToISO(p.validUntil)).getTime() >= now : false)
        );
      })
      .sort((a, b) => {
        const ta = a.data().createdAt ? new Date(_tsToISO(a.data().createdAt) || 0).getTime() : 0;
        const tb = b.data().createdAt ? new Date(_tsToISO(b.data().createdAt) || 0).getTime() : 0;
        return tb - ta;
      })
      .slice(0, 20)
      .map(d => {
        const p = d.data();
        return {
          promoId:       d.id,
          type:          p.type,
          title:         p.title,
          description:   p.description || '',
          discountType:  p.discountType,
          discountValue: p.discountValue,
          minOrder:      p.minOrder || 0,
          maxUses:       p.maxUses || null,
          usesCount:     p.usesCount || 0,
          validUntil:    _tsToISO(p.validUntil),
          productIds:    p.productIds || [],
          code:          p.code || null,
        };
      });

    return { promotions };
  }
);

/* ════════════════════════════════════════════════════════════════
   4.  miniShopUpdatePromotion  (onCall)
       Seller pauses, activates, or hard-deletes a promotion.
════════════════════════════════════════════════════════════════ */
exports.miniShopUpdatePromotion = onCall(
  { region: REGION, cors: true, enforceAppCheck: true },
  async (request) => {
    const uid = _requireAuth(request);
    const { promoId, action: rawAction } = request.data || {};

    if (typeof promoId !== 'string' || !promoId.trim()) {
      throw new HttpsError('invalid-argument', 'promoId is required.');
    }
    const action = _san(rawAction, 10);
    if (!PROMO_ACTIONS.has(action)) {
      throw new HttpsError('invalid-argument', "action must be 'pause', 'activate', or 'delete'.");
    }

    const db      = _db();
    const promoRef = db.collection('minishopPromotions').doc(promoId);
    const promoSnap = await promoRef.get();

    if (!promoSnap.exists) {
      throw new HttpsError('not-found', 'Promotion not found.');
    }
    const promoData = promoSnap.data();

    /* Verify shop ownership */
    await _assertShopOwner(promoData.shopId, uid);

    const batch = db.batch();

    if (action === 'delete') {
      batch.delete(promoRef);
      /* Clean up the code reservation doc if one exists */
      if (promoData.code) {
        batch.delete(
          db.collection('minishopPromoCodes').doc(`${promoData.shopId}_${promoData.code}`)
        );
      }
    } else {
      batch.update(promoRef, {
        status:    action === 'pause' ? 'paused' : 'active',
        updatedAt: FieldValue.serverTimestamp(),
      });
    }

    await batch.commit();
    logger.info('miniShopUpdatePromotion', { promoId, action });

    return { success: true };
  }
);

/* ════════════════════════════════════════════════════════════════
   5.  miniShopToggleWishlist  (onCall)
       Authenticated buyer adds or removes a product from their wishlist.
       Collection: minishopWishlist/{uid}/items/{productId}
════════════════════════════════════════════════════════════════ */
exports.miniShopToggleWishlist = onCall(
  { region: REGION, cors: true, enforceAppCheck: true },
  async (request) => {
    const uid = _requireAuth(request);
    const {
      productId: rawPid, shopId: rawShop,
      productName: rawName, productPrice: rawPrice, productImage: rawImg,
    } = request.data || {};

    const productId = _san(String(rawPid || ''), 80);
    const shopId    = _san(String(rawShop || ''), 80);
    if (!productId) throw new HttpsError('invalid-argument', 'productId is required.');
    if (!shopId)    throw new HttpsError('invalid-argument', 'shopId is required.');

    const db      = _db();
    const itemRef  = db.collection('minishopWishlist').doc(uid).collection('items').doc(productId);
    const itemSnap = await itemRef.get();

    if (itemSnap.exists) {
      await itemRef.delete();
      return { added: false };
    }

    const productName  = _san(String(rawName  || ''), 150);
    const productPrice = typeof rawPrice === 'number' && rawPrice >= 0 ? rawPrice : null;
    const productImage = _san(String(rawImg   || ''), 500);

    await itemRef.set({
      productId,
      shopId,
      productName,
      productPrice,
      productImage,
      addedAt: FieldValue.serverTimestamp(),
    });

    return { added: true };
  }
);

/* ════════════════════════════════════════════════════════════════
   6.  miniShopGetWishlist  (onCall)
       Returns the authenticated buyer's full wishlist.
════════════════════════════════════════════════════════════════ */
exports.miniShopGetWishlist = onCall(
  { region: REGION, cors: true, enforceAppCheck: true },
  async (request) => {
    const uid = _requireAuth(request);
    const db  = _db();

    const snap = await db
      .collection('minishopWishlist')
      .doc(uid)
      .collection('items')
      .limit(50)
      .get();

    const items = snap.docs.map(d => {
      const p = d.data();
      return {
        productId:    d.id,
        shopId:       p.shopId       || null,
        productName:  p.productName  || '',
        productPrice: p.productPrice ?? null,
        productImage: p.productImage || null,
        addedAt:      _tsToISO(p.addedAt),
      };
    });

    return { items };
  }
);

/* ════════════════════════════════════════════════════════════════
   7.  miniShopShareProduct  (onCall — auth optional)
       Generates platform-specific share card for a single product.
════════════════════════════════════════════════════════════════ */
exports.miniShopShareProduct = onCall(
  { region: REGION, cors: true, enforceAppCheck: true },
  async (request) => {
    /* Auth is optional — public share tool */
    const {
      shopId: rawShopId, productId: rawPid,
      productName: rawName, productPrice: rawPrice,
      productImage: rawImg, productUrl: rawPUrl,
    } = request.data || {};

    const shopId     = _san(String(rawShopId || ''), 80);
    const productId  = _san(String(rawPid    || ''), 80);
    const productName = _san(String(rawName   || ''), 150);
    const productImage = _san(String(rawImg   || ''), 500);

    if (!shopId)    throw new HttpsError('invalid-argument', 'shopId is required.');
    if (!productId) throw new HttpsError('invalid-argument', 'productId is required.');

    const price = typeof rawPrice === 'number' && rawPrice >= 0
      ? rawPrice.toLocaleString('en-KE')
      : null;

    /* Resolve handle: check minishopConfig first, then shop doc */
    const db = _db();
    const [shopSnap, configSnap] = await Promise.all([
      db.collection('shops').doc(shopId).get(),
      db.collection('minishopConfig').doc(shopId).get(),
    ]);

    const config = configSnap.exists ? configSnap.data() : {};
    const shopDoc = shopSnap.exists  ? shopSnap.data()   : {};
    const handle  = config.handle || shopDoc.minishopHandle || null;

    /* Build canonical product URL */
    let productUrl;
    if (rawPUrl && typeof rawPUrl === 'string') {
      productUrl = _san(rawPUrl, 500);
    } else if (handle) {
      productUrl = `${SHOP_URL}${encodeURIComponent(handle)}?p=${encodeURIComponent(productId)}`;
    } else {
      productUrl = `${BASE_URL}/shop?shopId=${encodeURIComponent(shopId)}&p=${encodeURIComponent(productId)}`;
    }

    /* Share text */
    const priceClause = price ? ` at KES ${price}` : '';
    const shareText   = `Check out ${productName}${priceClause} — available now on SOKONI! 🛙 ${productUrl}`;

    const encodedText = encodeURIComponent(shareText);
    const encodedUrl  = encodeURIComponent(productUrl);
    const ogImageUrl  = productImage || (handle ? `${BASE_URL}/og/shop/${handle}.png` : `${BASE_URL}/assets/Sokoni%20Logo.png`);

    return {
      shareText,
      productUrl,
      ogImageUrl,
      shareUrls: {
        whatsapp:  `https://wa.me/?text=${encodedText}`,
        telegram:  `https://t.me/share/url?url=${encodedUrl}&text=${encodeURIComponent(shareText)}`,
        facebook:  `https://www.facebook.com/sharer/sharer.php?u=${encodedUrl}`,
        twitter:   `https://twitter.com/intent/tweet?text=${encodedText}`,
        linkedin:  `https://www.linkedin.com/sharing/share-offsite/?url=${encodedUrl}`,
      },
    };
  }
);

/* ════════════════════════════════════════════════════════════════
   8.  miniShopAIMarketing  (onCall)
       Extended AI marketing assistant — posting times, seasonal
       campaigns, viral angles, and 7-day content calendars.
       Rate limit: 5 calls per UID per day.
       Model: claude-haiku-4-5-20251001
════════════════════════════════════════════════════════════════ */
exports.miniShopAIMarketing = onCall(
  { region: REGION, cors: true, enforceAppCheck: true, secrets: [ANTHROPIC_API_KEY] },
  async (request) => {
    const uid = _requireAuth(request);
    const { type: rawType, shopId, context: rawCtx } = request.data || {};

    const aiType = _san(String(rawType || ''), 30);
    if (!AI_MKT_TYPES.has(aiType)) {
      throw new HttpsError(
        'invalid-argument',
        'type must be one of: best_times, seasonal, trending_angle, campaign_plan.'
      );
    }

    /* ── Daily rate limit: 5 calls per UID ── */
    const today  = _today();
    const rlKey  = `${uid}_${today}`;
    const db     = _db();
    const rlRef  = db.collection('aiMktRL').doc(rlKey);

    let rateLimited = false;
    await db.runTransaction(async tx => {
      const rlDoc = await tx.get(rlRef);
      const count = rlDoc.exists ? (rlDoc.data().count || 0) : 0;
      if (count >= 5) { rateLimited = true; return; }
      tx.set(rlRef, { uid, date: today, count: count + 1, updatedAt: FieldValue.serverTimestamp() });
    });

    if (rateLimited) {
      throw new HttpsError(
        'resource-exhausted',
        'AI marketing limit reached (5 per day). Try again tomorrow.'
      );
    }

    /* ── Sanitize context ── */
    const ctx = (rawCtx && typeof rawCtx === 'object' && !Array.isArray(rawCtx)) ? rawCtx : {};
    const businessName = _san(ctx.businessName || '', 80);
    const category     = _san(ctx.category     || '', 60);
    const location     = _san(ctx.location     || '', 80);
    const audience     = _san(ctx.audience     || '', 100);
    const goals        = _san(ctx.goals        || '', 200);
    const products     = Array.isArray(ctx.products)
      ? ctx.products.slice(0, 5).map(p => _san(String(p), 60)).filter(Boolean).join(', ')
      : _san(ctx.products || '', 200);

    const currentMonth = new Date().toLocaleString('en-KE', { month: 'long', timeZone: 'Africa/Nairobi' });

    /* ── Build system + user prompt per type ── */
    const SYSTEM_PROMPTS = {
      best_times: [
        'You are a social media expert for Kenyan businesses.',
        'Given the business type and context, recommend the best 3 posting times per day for',
        'WhatsApp Status, Instagram, and TikTok.',
        'Be specific (e.g., "7:30am — Nairobi morning commute peak").',
        'Return exactly 3 time slots per platform, formatted clearly.',
      ].join(' '),

      seasonal: [
        'You are a marketing strategist for Kenyan small businesses.',
        `The current month is ${currentMonth}.`,
        'Generate a seasonal marketing campaign idea. Include:',
        '1. Campaign name, 2. Theme tied to current Kenyan season or upcoming event,',
        '3. Offer idea (discount/bundle/freebie), 4. Key message (1 sentence),',
        '5. Recommended platforms. Be specific and practical for a Kenyan audience.',
      ].join(' '),

      trending_angle: [
        'You are a viral content strategist specialising in Kenyan social media.',
        'Identify the most viral-potential content angle for this business. Include:',
        '1. Hook (first 3 seconds/words), 2. Content format (e.g., "Behind-the-scenes video"),',
        '3. Caption style (e.g., "Conversational with a question"), 4. Hashtag strategy (5 hashtags).',
        'Focus on what resonates with Kenyan audiences on TikTok, Instagram Reels, and WhatsApp.',
      ].join(' '),

      campaign_plan: [
        'You are a content calendar expert for Kenyan businesses.',
        'Create a 7-day social media campaign plan.',
        'For each day provide: Day label, Platform, Content type, Caption template (2-3 sentences), Goal.',
        'Use practical Kenyan contexts. Format as a clear numbered list, one day per item.',
      ].join(' '),
    };

    const userLines = [
      businessName && `Business: ${businessName}`,
      category     && `Category: ${category}`,
      location     && `Location: ${location}`,
      products     && `Key products/services: ${products}`,
      audience     && `Target audience: ${audience}`,
      goals        && `Goals: ${goals}`,
    ].filter(Boolean);

    const userPrompt = userLines.length > 0
      ? userLines.join('\n')
      : 'A general Kenyan small business on SOKONI marketplace.';

    const maxTokens = aiType === 'campaign_plan' ? 1024 : 512;

    /* ── Call Claude Haiku with 15-second timeout ── */
    const controller = new AbortController();
    const timeoutId  = setTimeout(() => controller.abort(), 15000);

    try {
      const Anthropic = require('@anthropic-ai/sdk');
      const client    = new Anthropic.default({ apiKey: ANTHROPIC_API_KEY.value() });

      const response = await client.messages.create(
        {
          model:      'claude-haiku-4-5-20251001',
          max_tokens: maxTokens,
          system:     SYSTEM_PROMPTS[aiType],
          messages:   [{ role: 'user', content: userPrompt }],
        },
        { signal: controller.signal }
      );

      clearTimeout(timeoutId);
      const content = response.content?.[0]?.text?.trim() || '';

      if (!content) {
        throw new HttpsError('internal', 'AI returned an empty response. Please try again.');
      }

      return {
        content,
        type:        aiType,
        model:       'claude-haiku-4-5-20251001',
        generatedAt: new Date().toISOString(),
      };

    } catch (err) {
      clearTimeout(timeoutId);
      if (err.name === 'AbortError') {
        throw new HttpsError('deadline-exceeded', 'AI response timed out. Please try again.');
      }
      if (err instanceof HttpsError) throw err;
      logger.warn('miniShopAIMarketing: AI call failed', { type: aiType, status: err?.status });
      throw new HttpsError('internal', 'AI generation failed. Please try again.');
    }
  }
);

/* ════════════════════════════════════════════════════════════════
   9.  miniShopSendAnnouncement  (onCall)
       Seller broadcasts an announcement to all shop followers.
       Rate limit: 3 announcements per shop per 24 hours.
════════════════════════════════════════════════════════════════ */
exports.miniShopSendAnnouncement = onCall(
  { region: REGION, cors: true, enforceAppCheck: true },
  async (request) => {
    const uid = _requireAuth(request);
    const { shopId, title: rawTitle, message: rawMsg, type: rawType } = request.data || {};

    /* ── Validate input ── */
    await _assertShopOwner(shopId, uid);

    const safeTitle = _san(rawTitle, 80);
    if (safeTitle.length < 2) {
      throw new HttpsError('invalid-argument', 'title must be at least 2 characters (max 80).');
    }

    const safeMsg = _san(rawMsg, 500);
    if (safeMsg.length < 2) {
      throw new HttpsError('invalid-argument', 'message must be at least 2 characters (max 500).');
    }

    const safeType = _san(rawType, 20);
    if (!ANNOUNCE_TYPES.has(safeType)) {
      throw new HttpsError(
        'invalid-argument',
        'type must be one of: general, sale, new_arrival, event, closure.'
      );
    }

    /* ── Rate limit: max 3 announcements per shop per 24h ── */
    const db       = _db();
    const postsRef  = db.collection('minishopAnnouncements').doc(shopId).collection('posts');
    const cutoff    = Timestamp.fromMillis(Date.now() - 24 * 60 * 60 * 1000);

    const recentSnap = await postsRef
      .where('createdAt', '>=', cutoff)
      .get();

    if (recentSnap.size >= 3) {
      throw new HttpsError(
        'resource-exhausted',
        'Maximum 3 announcements per 24 hours. Please wait before sending another.'
      );
    }

    /* ── Write announcement ── */
    const postRef = postsRef.doc();
    await postRef.set({
      title:     safeTitle,
      message:   safeMsg,
      type:      safeType,
      shopId,
      createdBy: uid,
      createdAt: FieldValue.serverTimestamp(),
      readCount: 0,
    });

    logger.info('miniShopSendAnnouncement', { shopId, announcementId: postRef.id, type: safeType });
    return { announcementId: postRef.id, success: true };
  }
);

/* ════════════════════════════════════════════════════════════════
   10. miniShopGetAnnouncements  (onCall — public, no auth required)
       Customer reads recent announcements from a shop.
════════════════════════════════════════════════════════════════ */
exports.miniShopGetAnnouncements = onCall(
  { region: REGION, cors: true, enforceAppCheck: true },
  async (request) => {
    const { shopId, limit: rawLimit } = request.data || {};

    if (typeof shopId !== 'string' || !shopId.trim()) {
      throw new HttpsError('invalid-argument', 'shopId is required.');
    }
    const safeLimit = Math.min(Math.max(1, parseInt(rawLimit, 10) || 5), 10);

    const db   = _db();
    const snap = await db
      .collection('minishopAnnouncements')
      .doc(shopId)
      .collection('posts')
      .orderBy('createdAt', 'desc')
      .limit(safeLimit)
      .get();

    const announcements = snap.docs.map(d => {
      const p = d.data();
      return {
        id:        d.id,
        title:     p.title   || '',
        message:   p.message || '',
        type:      p.type    || 'general',
        createdAt: _tsToISO(p.createdAt),
      };
    });

    return { announcements };
  }
);

/* ════════════════════════════════════════════════════════════════
   11. miniShopGetSimilar  (onCall — public, no auth required)
       Recommends similar businesses to show at the bottom of a MiniShop.
       Queries by category (single-field), filters status + current
       shop in JS; randomises the result set.
════════════════════════════════════════════════════════════════ */
exports.miniShopGetSimilar = onCall(
  { region: REGION, cors: true, enforceAppCheck: true },
  async (request) => {
    const { shopId, category: rawCat, limit: rawLimit } = request.data || {};

    if (typeof shopId !== 'string' || !shopId.trim()) {
      throw new HttpsError('invalid-argument', 'shopId is required.');
    }
    const category  = _san(rawCat, 60);
    const safeLimit = Math.min(Math.max(1, parseInt(rawLimit, 10) || 3), 6);

    if (!category) {
      return { shops: [] };
    }

    const db   = _db();
    /* Single-field query on category — no composite index needed */
    const snap = await db
      .collection('shops')
      .where('category', '==', category)
      .limit(16)   /* fetch extra so filtering leaves enough candidates */
      .get();

    /* Filter: active + not the current shop */
    const candidates = snap.docs
      .filter(d => d.id !== shopId && d.data().status === 'active')
      .map(d => {
        const s = d.data();
        return {
          shopId:   d.id,
          name:     _san(s.name           || '', 80),
          handle:   _san(s.minishopHandle || s.handle || '', 30) || null,
          logoUrl:  _san(s.logoUrl        || '', 500)             || null,
          rating:   typeof s.rating === 'number' ? s.rating : null,
          category: s.category || category,
        };
      });

    /* Randomise and cap */
    const shuffled = candidates.sort(() => Math.random() - 0.5).slice(0, safeLimit);

    return { shops: shuffled };
  }
);

/* ════════════════════════════════════════════════════════════════
   12. miniShopScheduledDigest  (onSchedule — Monday 07:00 EAT)
       Emails each seller with a weekly analytics digest.
       Processes up to 100 shops per run; logs but never throws on
       individual shop failures.
════════════════════════════════════════════════════════════════ */
exports.miniShopScheduledDigest = onSchedule(
  {
    schedule:       '0 7 * * 1',   /* Monday 07:00 Africa/Nairobi */
    timeZone:       'Africa/Nairobi',
    region:         REGION,
    secrets:        [SENDGRID_API_KEY],
    maxInstances:   1,
    timeoutSeconds: 300,
  },
  async () => {
    const db     = _db();
    const apiKey = SENDGRID_API_KEY.value();
    if (!apiKey || apiKey.startsWith('SG.placeholder')) {
      logger.warn('SendGrid not configured — skipping digest email');
      return;
    }
    const sgMail = require('@sendgrid/mail');
    sgMail.setApiKey(apiKey);

    /* Rotating tip based on ISO week number */
    const weekNum = Math.floor(Date.now() / (7 * 24 * 60 * 60 * 1000));
    const tip     = WEEKLY_TIPS[weekNum % WEEKLY_TIPS.length];

    /* Fetch shops that have claimed a handle (single-field range query) */
    const configSnap = await db
      .collection('minishopConfig')
      .where('handle', '>', '')
      .limit(100)
      .get();

    if (configSnap.empty) {
      logger.info('miniShopScheduledDigest: no MiniShops with handles found');
      return;
    }

    const shopIds = configSnap.docs.map(d => d.id);
    const configById = Object.fromEntries(configSnap.docs.map(d => [d.id, d.data()]));

    let sent = 0, skipped = 0, failed = 0;

    /* Process in batches of 10 to avoid overwhelming Firestore */
    const BATCH = 10;
    for (let i = 0; i < shopIds.length; i += BATCH) {
      const batch = shopIds.slice(i, i + BATCH);

      await Promise.all(batch.map(async shopId => {
        try {
          const config = configById[shopId] || {};

          /* Fetch shop doc (email) and analytics in parallel */
          const [shopSnap, analyticsSnap] = await Promise.all([
            db.collection('shops').doc(shopId).get(),
            db.collection('minishopAnalytics').doc(shopId).get(),
          ]);

          if (!shopSnap.exists) { skipped++; return; }

          const shop    = shopSnap.data();
          const email   = _san(shop.email || shop.contactEmail || '', 200);
          if (!email || !email.includes('@')) { skipped++; return; }

          const analytics = analyticsSnap.exists ? analyticsSnap.data() : {};

          /* Compute last-7-days views from daily breakdown */
          const daily = analytics.daily || {};
          let last7Views = 0;
          for (let d = 0; d < 7; d++) {
            const dateKey = new Date(Date.now() - d * 86400000)
              .toISOString().slice(0, 10).replace(/-/g, '');
            last7Views += (daily[dateKey] || 0);
          }

          /* Find top traffic source */
          const sources = analytics.sources || {};
          let topSource = 'direct', maxCount = 0;
          for (const [src, cnt] of Object.entries(sources)) {
            if (typeof cnt === 'number' && cnt > maxCount) {
              maxCount = cnt; topSource = src;
            }
          }

          const followerCount  = config.followerCount  || 0;
          const shopName       = _san(shop.name        || 'Your Shop', 80);
          const handle         = config.handle         || '';
          const shopUrl        = handle ? `${SHOP_URL}${handle}` : BASE_URL;

          /* Build digest email HTML */
          const emailHtml = _buildDigestHtml({
            shopName, shopUrl, last7Views, topSource, followerCount, tip,
          });

          await sgMail.send({
            to:      email,
            from:    { email: 'noreply@mysokoni.co.ke', name: 'SOKONI MiniShop' },
            subject: `Your Weekly MiniShop Report — ${shopName}`,
            html:    emailHtml,
          });

          sent++;
          logger.info('miniShopScheduledDigest: sent', { shopId });

        } catch (shopErr) {
          failed++;
          /* Log the error type but never expose PII */
          logger.error('miniShopScheduledDigest: shop processing failed', {
            shopId,
            errorCode: shopErr?.code || shopErr?.response?.statusCode || 'unknown',
          });
        }
      }));
    }

    logger.info('miniShopScheduledDigest complete', { sent, skipped, failed, total: shopIds.length });
  }
);

/** Build the weekly digest email HTML — inline styles for email client compatibility */
function _buildDigestHtml({ shopName, shopUrl, last7Views, topSource, followerCount, tip }) {
  const eName        = _escHtml(shopName);
  const eUrl         = _escHtml(shopUrl);
  const eSource      = _escHtml(
    topSource.charAt(0).toUpperCase() + topSource.slice(1)
  );
  const eTip         = _escHtml(tip);
  const adminUrl     = _escHtml(`${BASE_URL}/minishop-admin.html`);
  const views7       = last7Views.toLocaleString('en-KE');
  const followersStr = followerCount.toLocaleString('en-KE');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Your Weekly MiniShop Report</title>
</head>
<body style="margin:0;padding:0;background:#050505;font-family:Arial,Helvetica,sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" role="presentation">
    <tr>
      <td align="center" style="padding:24px 16px">
        <table width="600" cellpadding="0" cellspacing="0" role="presentation"
               style="max-width:600px;width:100%;background:#0d0d0d;border-radius:12px;overflow:hidden">

          <!-- Header -->
          <tr>
            <td style="background:#71ff00;padding:20px 24px">
              <h1 style="margin:0;color:#050505;font-size:20px;font-weight:700">
                SOKONI MiniShop &mdash; Weekly Report
              </h1>
              <p style="margin:4px 0 0;color:#1a1a1a;font-size:13px">${eName}</p>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding:24px">
              <p style="color:#e8e8e8;font-size:15px;margin:0 0 16px">
                Here&rsquo;s how your MiniShop performed this week:
              </p>

              <!-- Stats row -->
              <table width="100%" cellpadding="0" cellspacing="0" role="presentation"
                     style="background:#141414;border-radius:8px;overflow:hidden;margin-bottom:24px">
                <tr>
                  <td style="padding:16px;text-align:center;border-right:1px solid #1a1a1a">
                    <div style="color:#71ff00;font-size:30px;font-weight:700">${views7}</div>
                    <div style="color:#888;font-size:12px;margin-top:4px">Views (7 days)</div>
                  </td>
                  <td style="padding:16px;text-align:center;border-right:1px solid #1a1a1a">
                    <div style="color:#00bcd4;font-size:30px;font-weight:700">${followersStr}</div>
                    <div style="color:#888;font-size:12px;margin-top:4px">Followers</div>
                  </td>
                  <td style="padding:16px;text-align:center">
                    <div style="color:#ff9800;font-size:18px;font-weight:700">${eSource}</div>
                    <div style="color:#888;font-size:12px;margin-top:4px">Top Traffic Source</div>
                  </td>
                </tr>
              </table>

              <!-- Tip -->
              <h3 style="color:#71ff00;font-size:15px;margin:0 0 8px">Tip of the Week</h3>
              <p style="color:#e8e8e8;font-size:14px;background:#141414;padding:16px;
                         border-radius:8px;border-left:3px solid #71ff00;margin:0 0 24px">
                ${eTip}
              </p>

              <!-- CTA -->
              <a href="${adminUrl}"
                 style="display:inline-block;background:#71ff00;color:#050505;padding:12px 28px;
                         border-radius:8px;text-decoration:none;font-weight:700;font-size:14px">
                View Full Analytics &rarr;
              </a>

              <p style="margin:24px 0 0">
                <a href="${eUrl}" style="color:#71ff00;font-size:13px">Visit your MiniShop</a>
              </p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding:16px 24px;border-top:1px solid #1a1a1a;text-align:center">
              <p style="color:#444;font-size:12px;margin:0">
                SOKONI &middot; <a href="${_escHtml(BASE_URL)}"
                  style="color:#555;text-decoration:none">mysokoni.co.ke</a>
                &middot; Kenya&rsquo;s #1 Marketplace
              </p>
              <p style="color:#333;font-size:11px;margin:4px 0 0">
                You&rsquo;re receiving this because you have a MiniShop on SOKONI.
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

/* ── Exports ─────────────────────────────────────────────────────────────── */
// All Cloud Function exports are declared inline above via exports.X = onCall/onRequest/onSchedule.
// This comment exists as a navigation anchor; no additional exports are required.
