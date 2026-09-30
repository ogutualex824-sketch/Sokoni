/* ============================================================
   SOKONI Seller Quality Engine  v1.0

   Exports:
     getListingQualityReport    onCall (seller) — per-product quality scores
     getSellerPerformanceSummary onCall (seller) — fast/slow movers + pricing
     getMarketplaceSellerHealth  onCall (admin)  — cross-seller quality overview

   Quality score dimensions (0-100):
     images (0-30), description (0-25), title (0-15),
     pricing (0-15), engagement bonus (0-15)
============================================================ */
"use strict";

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
if (!admin.apps.length) admin.initializeApp();
const db = admin.firestore();

const CF_OPTS = { region: "us-central1", memory: "256MiB", timeoutSeconds: 60 };

/* ── helpers ───────────────────────────────────────────────── */
function _isAdmin(auth) {
  return auth?.token?.admin === true || auth?.token?.role === "admin" || auth?.token?.role === "superAdmin";
}

function _scoreProduct(p, stats, categoryAvgPrice) {
  const issues   = [];
  const tips     = [];
  let   score    = 0;

  /* Images: 0-30 pts */
  const imgCount = Array.isArray(p.images) ? p.images.length
    : p.image ? 1 : 0;
  if (imgCount === 0) {
    issues.push("No product photo");
    tips.push("Add at least 3 clear photos — products with photos sell 4× faster");
  } else if (imgCount === 1) {
    score += 10;
    tips.push("Add 2 more photos (angles, detail, lifestyle) to reach full image score");
  } else if (imgCount === 2) {
    score += 20;
    tips.push("One more photo would reach maximum image score");
  } else {
    score += 30;
  }

  /* Description: 0-25 pts */
  const desc = (p.description || p.desc || "").trim();
  if (!desc) {
    issues.push("Missing description");
    tips.push("Write a description — include material, size, colour, condition, and uses");
  } else if (desc.length < 40) {
    score += 8;
    issues.push("Description too short");
    tips.push(`Description is only ${desc.length} chars — aim for 150+ for full score`);
  } else if (desc.length < 100) {
    score += 16;
    tips.push("Expand your description to 150+ characters to reach full score");
  } else {
    score += 25;
  }

  /* Title: 0-15 pts */
  const title = (p.name || p.title || "").trim();
  if (!title) {
    issues.push("Missing product name");
  } else if (title.length < 10) {
    score += 5;
    tips.push("Make your title more descriptive (brand + product type + key feature)");
  } else if (title.length < 25) {
    score += 10;
    tips.push("A longer, keyword-rich title improves search visibility");
  } else {
    score += 15;
  }

  /* Price: 0-15 pts */
  const price = parseFloat(p.price) || 0;
  if (!price) {
    issues.push("Missing price");
  } else if (categoryAvgPrice && price > categoryAvgPrice * 2) {
    score += 5;
    tips.push(`Your price (KES ${price.toLocaleString()}) is >2× the category average — review competitiveness`);
  } else if (categoryAvgPrice && price < categoryAvgPrice * 0.5) {
    score += 10;
    tips.push(`Price is well below category average (KES ${Math.round(categoryAvgPrice).toLocaleString()}) — check if this is intentional`);
  } else {
    score += 15;
  }

  /* Engagement bonus: 0-15 pts (based on real stats) */
  if (stats) {
    const views = stats.viewsTotal || 0;
    const sales = stats.salesTotal || 0;
    if (views > 100 || sales > 5) score += 15;
    else if (views > 20 || sales > 0) score += 8;
    else if (views > 5) score += 3;
  }

  /* Category assigned */
  if (!p.category) issues.push("No category assigned");

  const grade = score >= 85 ? "A" : score >= 70 ? "B" : score >= 50 ? "C" : score >= 30 ? "D" : "F";

  return { score, grade, issues, tips };
}

/* ════════════════════════════════════════════════════════════
   getListingQualityReport
   Returns quality scores for all products owned by the caller.
════════════════════════════════════════════════════════════ */
exports.getListingQualityReport = onCall(CF_OPTS, async (req) => {
  if (!req.auth) throw new HttpsError("unauthenticated", "Sign in required");
  const uid = req.auth.uid;

  /* Fetch products + stats in parallel */
  const [productsSnap, statsSnap] = await Promise.all([
    db.collection("products").where("sellerId", "==", uid).limit(200).get(),
    db.collection("productStats").where("sellerId", "==", uid).limit(200).get(),
  ]);

  if (productsSnap.empty) return { products: [], summary: null };

  /* Build stats lookup */
  const statsMap = {};
  statsSnap.docs.forEach(d => { statsMap[d.id] = d.data(); });

  /* Compute category averages from this seller's own listings */
  const catPrices = {};
  productsSnap.docs.forEach(d => {
    const p = d.data();
    const cat = p.category || "other";
    const price = parseFloat(p.price) || 0;
    if (price > 0) {
      if (!catPrices[cat]) catPrices[cat] = { sum: 0, count: 0 };
      catPrices[cat].sum += price;
      catPrices[cat].count += 1;
    }
  });
  const catAvg = {};
  Object.keys(catPrices).forEach(c => {
    catAvg[c] = catPrices[c].sum / catPrices[c].count;
  });

  /* Score each product */
  const products = productsSnap.docs.map(d => {
    const p     = d.data();
    const stats = statsMap[d.id] || null;
    const avg   = catAvg[p.category] || null;
    const qual  = _scoreProduct(p, stats, avg);
    return {
      id:    d.id,
      name:  p.name || p.title || "Untitled",
      price: p.price || 0,
      category: p.category || null,
      image: Array.isArray(p.images) ? p.images[0] : (p.image || null),
      active: p.active !== false,
      ...qual,
      stats: stats ? {
        views: stats.viewsTotal || 0,
        sales: stats.salesTotal || 0,
        trendingLabel: stats.trendingLabel || null,
      } : null,
    };
  });

  /* Sort: worst first so seller knows what to fix */
  products.sort((a, b) => a.score - b.score);

  const scores  = products.map(p => p.score);
  const avgScore = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : 0;
  const gradeA  = products.filter(p => p.grade === "A").length;
  const gradeF  = products.filter(p => p.grade === "F" || p.grade === "D").length;

  return {
    products,
    summary: {
      totalListings: products.length,
      avgQualityScore: avgScore,
      gradeA,
      gradeF,
      listingsNeedingAttention: products.filter(p => p.score < 50).length,
    },
  };
});

/* ════════════════════════════════════════════════════════════
   getSellerPerformanceSummary
   Fast/slow movers, pricing vs category median, recent trends.
════════════════════════════════════════════════════════════ */
exports.getSellerPerformanceSummary = onCall(CF_OPTS, async (req) => {
  if (!req.auth) throw new HttpsError("unauthenticated", "Sign in required");
  const uid = req.auth.uid;
  const days = Math.min(parseInt(req.data?.days) || 30, 90);
  const cutoff = new Date(Date.now() - days * 864e5);

  const [productsSnap, statsSnap, ordersSnap] = await Promise.all([
    db.collection("products").where("sellerId", "==", uid).limit(200).get(),
    db.collection("productStats").where("sellerId", "==", uid).limit(200).get(),
    db.collection("orders")
      .where("sellerId", "==", uid)
      .where("status", "in", ["paid", "delivered", "completed"])
      .where("createdAt", ">=", cutoff)
      .limit(500)
      .get(),
  ]);

  const statsMap = {};
  statsSnap.docs.forEach(d => { statsMap[d.id] = d.data(); });

  /* Revenue by product */
  const productRevenue = {};
  const productOrderCount = {};
  ordersSnap.docs.forEach(d => {
    const o = d.data();
    const items = o.items || (o.productId ? [{ productId: o.productId, price: o.amount, qty: 1 }] : []);
    items.forEach(item => {
      const pid = item.productId;
      if (!pid) return;
      productRevenue[pid]    = (productRevenue[pid] || 0) + (parseFloat(item.price) * (item.qty || 1));
      productOrderCount[pid] = (productOrderCount[pid] || 0) + (item.qty || 1);
    });
  });

  /* Build enriched product list */
  const allProducts = productsSnap.docs.map(d => {
    const p     = d.data();
    const stats = statsMap[d.id] || {};
    const rev   = productRevenue[d.id] || 0;
    const units = productOrderCount[d.id] || 0;
    return {
      id: d.id,
      name: p.name || p.title || "Untitled",
      price: parseFloat(p.price) || 0,
      category: p.category || "other",
      views: stats.viewsTotal || 0,
      viewsMonth: stats.viewsMonth || 0,
      salesTotal: stats.salesTotal || 0,
      salesThisMonth: stats.salesThisMonth || 0,
      trendingLabel: stats.trendingLabel || null,
      revenueInPeriod: Math.round(rev),
      unitsSoldInPeriod: units,
    };
  });

  /* Fast movers: top 5 by revenue in period */
  const fastMovers = [...allProducts]
    .filter(p => p.revenueInPeriod > 0)
    .sort((a, b) => b.revenueInPeriod - a.revenueInPeriod)
    .slice(0, 5);

  /* Slow movers: listed >14 days, has views but 0 sales */
  const slowMovers = [...allProducts]
    .filter(p => p.views > 10 && p.salesTotal === 0)
    .sort((a, b) => b.views - a.views)
    .slice(0, 5);

  /* Zero-view listings: no visibility at all */
  const zeroView = allProducts.filter(p => p.views === 0).slice(0, 10);

  /* Category pricing: compute seller's avg vs what we see across all */
  const catGroups = {};
  allProducts.forEach(p => {
    if (!catGroups[p.category]) catGroups[p.category] = [];
    catGroups[p.category].push(p.price);
  });
  const categoryInsights = Object.entries(catGroups).map(([cat, prices]) => {
    const avg = prices.reduce((a, b) => a + b, 0) / prices.length;
    return { category: cat, listingCount: prices.length, avgPrice: Math.round(avg) };
  }).sort((a, b) => b.listingCount - a.listingCount);

  /* Revenue totals */
  const totalRevenue  = allProducts.reduce((s, p) => s + p.revenueInPeriod, 0);
  const totalUnitsSold = allProducts.reduce((s, p) => s + p.unitsSoldInPeriod, 0);

  return {
    periodDays: days,
    totalListings: allProducts.length,
    totalRevenue,
    totalUnitsSold,
    fastMovers,
    slowMovers,
    zeroViewListings: zeroView,
    categoryInsights,
    pricingTip: fastMovers.length > 0
      ? `Your top performer earns KES ${fastMovers[0].revenueInPeriod.toLocaleString()} — consider boosting its visibility`
      : "Start promoting your listings to build sales history",
  };
});

/* ════════════════════════════════════════════════════════════
   getMarketplaceSellerHealth
   Admin-only: quality distribution across all sellers.
════════════════════════════════════════════════════════════ */
exports.getMarketplaceSellerHealth = onCall(CF_OPTS, async (req) => {
  if (!_isAdmin(req.auth)) throw new HttpsError("permission-denied", "Admin only");

  const [productsSnap, sellersSnap] = await Promise.all([
    db.collection("products").limit(2000).get(),
    db.collection("sellerPerformance").limit(500).get(),
  ]);

  const sellerMap = {};
  sellersSnap.docs.forEach(d => { sellerMap[d.id] = d.data(); });

  /* Group products by seller */
  const bySellerProduct = {};
  productsSnap.docs.forEach(d => {
    const p = d.data();
    const sid = p.sellerId || "unknown";
    if (!bySellerProduct[sid]) bySellerProduct[sid] = [];
    bySellerProduct[sid].push({ id: d.id, ...p });
  });

  /* Score each seller's catalogue */
  const sellerScores = Object.entries(bySellerProduct).map(([sid, prods]) => {
    const scored = prods.map(p => _scoreProduct(p, null, null));
    const avg = Math.round(scored.reduce((s, q) => s + q.score, 0) / scored.length);
    const issues = scored.flatMap(q => q.issues);
    const issueFreq = {};
    issues.forEach(i => { issueFreq[i] = (issueFreq[i] || 0) + 1; });
    return {
      sellerId: sid,
      listingCount: prods.length,
      avgQualityScore: avg,
      topIssue: Object.entries(issueFreq).sort((a, b) => b[1] - a[1])[0]?.[0] || null,
    };
  });

  sellerScores.sort((a, b) => a.avgQualityScore - b.avgQualityScore);

  const dist = { A: 0, B: 0, C: 0, D: 0, F: 0 };
  sellerScores.forEach(s => {
    const g = s.avgQualityScore >= 85 ? "A" : s.avgQualityScore >= 70 ? "B"
      : s.avgQualityScore >= 50 ? "C" : s.avgQualityScore >= 30 ? "D" : "F";
    dist[g]++;
  });

  const overallAvg = sellerScores.length
    ? Math.round(sellerScores.reduce((s, x) => s + x.avgQualityScore, 0) / sellerScores.length)
    : 0;

  return {
    totalSellers: sellerScores.length,
    totalListings: productsSnap.size,
    overallAvgQualityScore: overallAvg,
    gradeDistribution: dist,
    worstSellers: sellerScores.slice(0, 10),
    topSellers: [...sellerScores].sort((a, b) => b.avgQualityScore - a.avgQualityScore).slice(0, 10),
  };
});
