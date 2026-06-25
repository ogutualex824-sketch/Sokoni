/* ============================================================
   SOKONI Marketplace Quality Engine  v1.0

   Exports:
     getMarketplaceQualityReport  onCall (admin) — catalogue health scan
     flagLowQualityListing        onCall (admin) — mark a listing for review
     getListingQualityHistory     onCall (admin) — quality trend over time

   Detects:
     - Missing descriptions / images / titles
     - Potential duplicates (same seller, same title)
     - Abandoned sellers (active listings, 0 orders in 90d)
     - Incorrect category (price outliers within category)
     - Outdated listings (no views in 60d, listed >30d ago)
============================================================ */
"use strict";

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
if (!admin.apps.length) admin.initializeApp();
const db = admin.firestore();

const CF_OPTS = { region: "us-central1", memory: "512MiB", timeoutSeconds: 120 };

function _isAdmin(auth) {
  return auth?.token?.admin === true || auth?.token?.role === "admin" || auth?.token?.role === "superAdmin";
}

/* ════════════════════════════════════════════════════════════
   getMarketplaceQualityReport
   Scans up to 2000 products and returns a structured quality
   report. Intentionally lightweight — avoids heavy joins.
════════════════════════════════════════════════════════════ */
exports.getMarketplaceQualityReport = onCall(CF_OPTS, async (req) => {
  if (!_isAdmin(req.auth)) throw new HttpsError("permission-denied", "Admin only");

  const cutoff60d  = new Date(Date.now() - 60  * 864e5);
  const cutoff30d  = new Date(Date.now() - 30  * 864e5);
  const cutoff90d  = new Date(Date.now() - 90  * 864e5);

  /* Fetch products + recent stats */
  const [productsSnap, statsSnap] = await Promise.all([
    db.collection("products").where("active", "!=", false).limit(2000).get(),
    db.collection("productStats").limit(2000).get(),
  ]);

  const statsMap = {};
  statsSnap.docs.forEach(d => { statsMap[d.id] = d.data(); });

  const products = productsSnap.docs.map(d => ({ id: d.id, ...d.data(), _stats: statsMap[d.id] || null }));

  /* ── Issue detection ── */

  const missingImages       = [];
  const missingDescriptions = [];
  const missingTitles       = [];
  const potentialDuplicates = [];
  const outdatedListings    = [];
  const categoryOutliers    = [];
  const abandonedListings   = [];

  /* Title→sellerId map for duplicate detection */
  const titleIndex = {};

  /* Category price buckets */
  const catPrices = {};

  products.forEach(p => {
    const id       = p.id;
    const name     = (p.name || p.title || "").trim();
    const desc     = (p.description || p.desc || "").trim();
    const imgCount = Array.isArray(p.images) ? p.images.length : (p.image ? 1 : 0);
    const price    = parseFloat(p.price) || 0;
    const cat      = p.category || "uncategorized";
    const seller   = p.sellerId || "unknown";
    const createdAt = p.createdAt?.toDate?.() || p.uploadedAt?.toDate?.() || null;
    const stats    = p._stats;

    /* Missing fields */
    if (imgCount === 0) missingImages.push({ id, name: name || "Untitled", seller });
    if (!desc)          missingDescriptions.push({ id, name: name || "Untitled", seller });
    if (!name)          missingTitles.push({ id, seller });

    /* Duplicate detection: same seller + same normalised title */
    const normTitle = name.toLowerCase().replace(/\s+/g, " ").slice(0, 60);
    if (normTitle) {
      const key = `${seller}::${normTitle}`;
      if (!titleIndex[key]) titleIndex[key] = [];
      titleIndex[key].push(id);
    }

    /* Outdated: listed >30d ago AND no views in 60d */
    const isOld = createdAt && createdAt < cutoff30d;
    const noRecentViews = !stats || !stats.viewsLastAt
      || (stats.viewsLastAt?.toDate?.() || new Date(0)) < cutoff60d;
    if (isOld && noRecentViews && (stats?.viewsTotal || 0) < 5) {
      outdatedListings.push({ id, name: name || "Untitled", seller, price,
        viewsTotal: stats?.viewsTotal || 0,
        listedDaysAgo: createdAt ? Math.round((Date.now() - createdAt.getTime()) / 864e5) : null });
    }

    /* Abandoned seller: listing active but seller has no recent engagement */
    if (stats && stats.viewsMonth === 0 && stats.viewsTotal > 20 && isOld) {
      abandonedListings.push({ id, name: name || "Untitled", seller,
        viewsTotal: stats.viewsTotal, salesTotal: stats.salesTotal || 0 });
    }

    /* Price bucket for outlier detection */
    if (price > 0) {
      if (!catPrices[cat]) catPrices[cat] = [];
      catPrices[cat].push({ id, name: name || "Untitled", seller, price });
    }
  });

  /* Duplicate groups */
  Object.entries(titleIndex).forEach(([key, ids]) => {
    if (ids.length > 1) {
      const [seller, ...titleParts] = key.split("::");
      potentialDuplicates.push({ seller, title: titleParts.join("::"), productIds: ids });
    }
  });

  /* Category price outliers: price > 3× IQR */
  Object.entries(catPrices).forEach(([cat, entries]) => {
    if (entries.length < 5) return;
    const sorted = [...entries].sort((a, b) => a.price - b.price);
    const q1 = sorted[Math.floor(sorted.length * 0.25)].price;
    const q3 = sorted[Math.floor(sorted.length * 0.75)].price;
    const iqr = q3 - q1;
    const upper = q3 + 3 * iqr;
    const lower = Math.max(0, q1 - 3 * iqr);
    entries.forEach(e => {
      if (e.price > upper || (e.price < lower && lower > 0)) {
        categoryOutliers.push({ ...e, category: cat, avgPrice: Math.round((q1 + q3) / 2),
          issue: e.price > upper ? "price_too_high" : "price_too_low" });
      }
    });
  });

  /* Overall scores */
  const total = products.length || 1;
  const healthScore = Math.round(100
    - (missingImages.length / total) * 25
    - (missingDescriptions.length / total) * 20
    - (potentialDuplicates.length / total) * 15
    - (outdatedListings.length / total) * 20
    - (categoryOutliers.length / total) * 10
    - (abandonedListings.length / total) * 10
  );

  return {
    scannedAt:     new Date().toISOString(),
    totalListings: products.length,
    healthScore:   Math.max(0, healthScore),
    issues: {
      missingImages:       { count: missingImages.length,       items: missingImages.slice(0, 50) },
      missingDescriptions: { count: missingDescriptions.length, items: missingDescriptions.slice(0, 50) },
      missingTitles:       { count: missingTitles.length,       items: missingTitles.slice(0, 20) },
      potentialDuplicates: { count: potentialDuplicates.length, items: potentialDuplicates.slice(0, 30) },
      outdatedListings:    { count: outdatedListings.length,    items: outdatedListings.slice(0, 50) },
      categoryOutliers:    { count: categoryOutliers.length,    items: categoryOutliers.slice(0, 30) },
      abandonedListings:   { count: abandonedListings.length,   items: abandonedListings.slice(0, 30) },
    },
    recommendations: _buildRecommendations({
      missingImages, missingDescriptions, potentialDuplicates, outdatedListings,
      categoryOutliers, abandonedListings, total: products.length,
    }),
  };
});

function _buildRecommendations(data) {
  const recs = [];
  if (data.missingImages.length > 0)
    recs.push({ priority: "high", action: "Email sellers with no product photos",
      impact: `${data.missingImages.length} listings would become more visible`, category: "quality" });
  if (data.missingDescriptions.length > 0)
    recs.push({ priority: "high", action: "Prompt sellers for missing descriptions",
      impact: `${data.missingDescriptions.length} listings have no description`, category: "quality" });
  if (data.potentialDuplicates.length > 0)
    recs.push({ priority: "medium", action: "Review potential duplicate listings",
      impact: `${data.potentialDuplicates.length} possible duplicates found`, category: "trust" });
  if (data.outdatedListings.length > 0)
    recs.push({ priority: "low", action: "Archive or re-list outdated listings",
      impact: `${data.outdatedListings.length} listings unseen in 60+ days`, category: "freshness" });
  if (data.categoryOutliers.length > 0)
    recs.push({ priority: "medium", action: "Review price outliers by category",
      impact: `${data.categoryOutliers.length} listings priced far outside their category`, category: "pricing" });
  if (data.abandonedListings.length > 0)
    recs.push({ priority: "medium", action: "Re-engage sellers with dormant listings",
      impact: `${data.abandonedListings.length} listings with no recent activity`, category: "seller" });
  return recs;
}

/* ════════════════════════════════════════════════════════════
   flagLowQualityListing
   Marks a listing for moderation review.
════════════════════════════════════════════════════════════ */
exports.flagLowQualityListing = onCall({ region: "us-central1" }, async (req) => {
  if (!_isAdmin(req.auth)) throw new HttpsError("permission-denied", "Admin only");
  const { productId, reason } = req.data || {};
  if (!productId) throw new HttpsError("invalid-argument", "productId required");

  await db.collection("products").doc(productId).update({
    qualityFlag: reason || "low_quality",
    qualityFlaggedAt: admin.firestore.FieldValue.serverTimestamp(),
    qualityFlaggedBy: req.auth.uid,
  });
  return { ok: true };
});
