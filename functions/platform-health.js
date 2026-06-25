"use strict";

/**
 * platform-health.js
 *
 * SOKONI v2.0 — Platform Health Scoring Engine
 *
 * Computes five composite scores from real Firestore data:
 *   1. Marketplace Health  (30% of overall)
 *   2. Seller Success      (25% of overall)
 *   3. Buyer Satisfaction  (25% of overall)
 *   4. Operational Health  (15% of overall)
 *   5. Cost Efficiency     (5%  of overall)
 *
 * Scores are 0–100. Each score includes dimension breakdowns so
 * dashboards can show exactly what is dragging a score down.
 *
 * All queries use single-field auto-indexes only — no new composite
 * indexes required.
 */

const { onCall } = require("firebase-functions/v2/https");
const { getFirestore, Timestamp } = require("firebase-admin/firestore");

/* ── helpers ───────────────────────────────────────────────────── */
function clamp(v)              { return Math.min(100, Math.max(0, Math.round(v))); }
function grade(score) {
  if (score >= 85) return "A";
  if (score >= 70) return "B";
  if (score >= 55) return "C";
  if (score >= 40) return "D";
  return "F";
}
function requireAdmin(req) {
  if (!req.auth?.token?.admin) throw new Error("PERMISSION_DENIED");
}
function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

/* dimension builder helpers */
function dim(name, value, contribution, max, missing = false) {
  return { name, value, contribution, max, missing };
}

/* ════════════════════════════════════════════════════════════════
   1. MARKETPLACE HEALTH SCORE (0-100)
   Sources: ops_reports, products, sellerPerformance
════════════════════════════════════════════════════════════════ */
async function _marketplaceHealth(db) {
  const today = todayKey();
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

  /* Latest payment success rate */
  let paymentRate = null;
  for (const day of [today, yesterday]) {
    const snap = await db.collection("ops_reports").doc(day).get();
    if (snap.exists && snap.data().paymentSuccessRate != null) {
      paymentRate = snap.data().paymentSuccessRate;
      break;
    }
  }

  /* Products with images */
  const prodSnap = await db.collection("products")
    .where("status", "==", "active").limit(500).get();
  const totalProducts = prodSnap.size;
  const withImages = prodSnap.docs.filter(d => {
    const imgs = d.data().images || d.data().imageUrls || [];
    return Array.isArray(imgs) ? imgs.length > 0 : !!imgs;
  }).length;

  /* Seller performance docs */
  const perfSnap = await db.collection("sellerPerformance").limit(300).get();
  const totalSellers = perfSnap.size;
  const sellersWithOrders = perfSnap.docs.filter(d => (d.data().totalOrders || 0) > 0).length;
  const avgFulfillment = totalSellers > 0
    ? perfSnap.docs.reduce((s, d) => s + (d.data().fulfillmentRate || 0), 0) / totalSellers
    : null;

  let score = 0;
  const dimensions = [];

  /* Payment success (30 pts) */
  if (paymentRate != null) {
    const c = clamp(paymentRate / 100 * 30);
    score += c;
    dimensions.push(dim("Payment Success Rate", paymentRate + "%", c, 30));
  } else {
    dimensions.push(dim("Payment Success Rate", "Awaiting first order", 0, 30, true));
  }

  /* Listing completeness (25 pts) */
  if (totalProducts > 0) {
    const ratio = withImages / totalProducts;
    const c = clamp(ratio * 25);
    score += c;
    dimensions.push(dim("Listing Completeness (images)", Math.round(ratio * 100) + "%", c, 25));
  } else {
    dimensions.push(dim("Listing Completeness (images)", "No active products yet", 0, 25, true));
  }

  /* Active seller ratio (20 pts) */
  if (totalSellers > 0) {
    const ratio = sellersWithOrders / totalSellers;
    const c = clamp(ratio * 20);
    score += c;
    dimensions.push(dim("Active Seller Ratio", sellersWithOrders + " / " + totalSellers, c, 20));
  } else {
    dimensions.push(dim("Active Seller Ratio", "No seller data yet", 0, 20, true));
  }

  /* Order fulfillment (25 pts) */
  if (avgFulfillment != null) {
    const c = clamp(avgFulfillment / 100 * 25);
    score += c;
    dimensions.push(dim("Avg Fulfillment Rate", Math.round(avgFulfillment) + "%", c, 25));
  } else {
    dimensions.push(dim("Avg Fulfillment Rate", "No order data yet", 0, 25, true));
  }

  const s = clamp(score);
  return { score: s, grade: grade(s), dimensions, dataComplete: !dimensions.some(d => d.missing) };
}

/* ════════════════════════════════════════════════════════════════
   2. SELLER SUCCESS SCORE (0-100)
   Sources: sellerPerformance
════════════════════════════════════════════════════════════════ */
async function _sellerSuccess(db) {
  const perfSnap = await db.collection("sellerPerformance").limit(300).get();
  const total = perfSnap.size;

  let score = 0;
  const dimensions = [];

  if (total === 0) {
    return {
      score: 0, grade: "F",
      dimensions: [dim("Seller Data", "No seller data yet — sellers must place orders first", 0, 100, true)],
      dataComplete: false,
    };
  }

  const docs = perfSnap.docs.map(d => d.data());
  const withSales     = docs.filter(d => (d.successfulOrders || 0) > 0).length;
  const avgFulfill    = docs.reduce((s, d) => s + (d.fulfillmentRate || 0), 0) / total;
  const avgCancel     = docs.reduce((s, d) => s + (d.cancellationRate || 0), 0) / total;
  const avgDispatch   = docs.filter(d => d.avgDispatchHours != null);
  const medDispatch   = avgDispatch.length > 0
    ? avgDispatch.reduce((s, d) => s + d.avgDispatchHours, 0) / avgDispatch.length
    : null;

  /* Sellers with at least 1 completed sale (40 pts) */
  const r1 = withSales / total;
  const c1 = clamp(r1 * 40);
  score += c1;
  dimensions.push(dim("Sellers with Sales", withSales + " / " + total, c1, 40));

  /* Avg fulfillment rate (35 pts) */
  const c2 = clamp(avgFulfill / 100 * 35);
  score += c2;
  dimensions.push(dim("Avg Fulfillment Rate", Math.round(avgFulfill) + "%", c2, 35));

  /* Cancellation penalty — inverse (15 pts) */
  const c3 = clamp((1 - avgCancel / 100) * 15);
  score += c3;
  dimensions.push(dim("Low Cancellation Rate", Math.round(avgCancel) + "% avg cancel", c3, 15));

  /* Dispatch speed (10 pts) — < 24h = full, < 48h = half, else 0 */
  if (medDispatch != null) {
    const c4 = medDispatch <= 24 ? 10 : medDispatch <= 48 ? 5 : 0;
    score += c4;
    dimensions.push(dim("Dispatch Speed", medDispatch.toFixed(1) + "h avg", c4, 10));
  } else {
    dimensions.push(dim("Dispatch Speed", "No dispatch data yet", 0, 10, true));
  }

  const s = clamp(score);
  return { score: s, grade: grade(s), dimensions, dataComplete: !dimensions.some(d => d.missing) };
}

/* ════════════════════════════════════════════════════════════════
   3. BUYER SATISFACTION SCORE (0-100)
   Sources: feedback (page_rating, bug), sellerPerformance (fulfillment)
════════════════════════════════════════════════════════════════ */
async function _buyerSatisfaction(db) {
  /* Page ratings */
  const ratingSnap = await db.collection("feedback")
    .where("type", "==", "page_rating").limit(500).get();
  const ratings = ratingSnap.docs
    .map(d => d.data().rating)
    .filter(r => typeof r === "number" && r >= 1 && r <= 5);
  const avgRating = ratings.length > 0
    ? ratings.reduce((s, r) => s + r, 0) / ratings.length
    : null;

  /* Open bug count (type=bug, status new/in_review) — filter in memory */
  const bugSnap = await db.collection("feedback")
    .where("type", "==", "bug").limit(200).get();
  const openBugs = bugSnap.docs.filter(d =>
    ["new", "in_review"].includes(d.data().status || "new")
  );
  const criticalBugs = openBugs.filter(d => d.data().priority === "critical").length;
  const highBugs     = openBugs.filter(d => d.data().priority === "high").length;

  /* Fulfillment as proxy for order experience */
  const perfSnap = await db.collection("sellerPerformance").limit(300).get();
  const avgFulfill = perfSnap.size > 0
    ? perfSnap.docs.reduce((s, d) => s + (d.data().fulfillmentRate || 0), 0) / perfSnap.size
    : null;

  let score = 0;
  const dimensions = [];

  /* Avg rating (40 pts — 5 stars = full) */
  if (avgRating != null) {
    const c = clamp((avgRating / 5) * 40);
    score += c;
    dimensions.push(dim("Avg Page Rating", avgRating.toFixed(2) + " / 5 (" + ratings.length + " ratings)", c, 40));
  } else {
    dimensions.push(dim("Avg Page Rating", "No ratings submitted yet", 0, 40, true));
  }

  /* Open critical/high bugs (30 pts) */
  const bugPenalty = criticalBugs * 15 + highBugs * 5;
  const c2 = clamp(30 - bugPenalty);
  score += c2;
  dimensions.push(dim("Open Critical/High Bugs", criticalBugs + " critical, " + highBugs + " high", c2, 30));

  /* Order fulfillment experience (30 pts) */
  if (avgFulfill != null) {
    const c = clamp(avgFulfill / 100 * 30);
    score += c;
    dimensions.push(dim("Order Fulfillment Experience", Math.round(avgFulfill) + "%", c, 30));
  } else {
    dimensions.push(dim("Order Fulfillment Experience", "Awaiting order data", 0, 30, true));
  }

  const s = clamp(score);
  return { score: s, grade: grade(s), dimensions, dataComplete: !dimensions.some(d => d.missing) };
}

/* ════════════════════════════════════════════════════════════════
   4. OPERATIONAL HEALTH SCORE (0-100)
   Sources: healthSnapshots (7 days), ops_reports
════════════════════════════════════════════════════════════════ */
async function _operationalHealth(db) {
  const since = Timestamp.fromMillis(Date.now() - 7 * 86400000);

  const healthSnap = await db.collection("healthSnapshots")
    .where("timestamp", ">=", since).limit(250).get();
  const snaps = healthSnap.docs.map(d => d.data());
  const totalSnaps = snaps.length;

  /* Uptime % — "ok" or "degraded" counts as up */
  const upSnaps = snaps.filter(d => d.status === "ok" || d.status === "degraded").length;
  const uptimePct = totalSnaps > 0 ? (upSnaps / totalSnaps) * 100 : null;

  /* Payment success from last 7 available ops_reports */
  const opsSnap = await db.collection("ops_reports")
    .orderBy("__name__", "desc").limit(7).get();
  const payRates = opsSnap.docs
    .map(d => d.data().paymentSuccessRate)
    .filter(r => typeof r === "number");
  const avgPayRate = payRates.length > 0
    ? payRates.reduce((s, r) => s + r, 0) / payRates.length
    : null;

  /* Service check failures in last 7 days */
  const failedChecks = snaps.filter(d => d.status === "unreachable").length;

  let score = 0;
  const dimensions = [];

  /* Uptime (40 pts) */
  if (uptimePct != null) {
    const c = clamp(uptimePct / 100 * 40);
    score += c;
    dimensions.push(dim("7-Day Uptime", uptimePct.toFixed(2) + "%", c, 40));
  } else {
    dimensions.push(dim("7-Day Uptime", "recordHealthSnapshot not yet running", 0, 40, true));
  }

  /* Payment success (30 pts) */
  if (avgPayRate != null) {
    const c = clamp(avgPayRate / 100 * 30);
    score += c;
    dimensions.push(dim("7-Day Payment Success Rate", avgPayRate.toFixed(1) + "%", c, 30));
  } else {
    dimensions.push(dim("7-Day Payment Success Rate", "Awaiting ops_reports data", 0, 30, true));
  }

  /* Service reachability (20 pts) — deduct per unreachable snapshot */
  const reachPenalty = Math.min(20, failedChecks * 4);
  const c3 = clamp(20 - reachPenalty);
  score += c3;
  dimensions.push(dim("Service Reachability", failedChecks + " unreachable snapshots (7d)", c3, 20));

  /* Email/search system (10 pts heuristic — deduct if queue depth high) */
  const deepQueue = snaps.filter(d => (d.emailQueueDepth || 0) > 50).length;
  const c4 = deepQueue > 0 ? 5 : 10;
  score += c4;
  dimensions.push(dim("Email / Search System", deepQueue + " high-queue snapshots", c4, 10));

  const s = clamp(score);
  return { score: s, grade: grade(s), dimensions, dataComplete: !dimensions.some(d => d.missing) };
}

/* ════════════════════════════════════════════════════════════════
   5. COST EFFICIENCY SCORE (0-100)
   Sources: known architecture constants + index budget
   Note: Cloud Billing API not available; heuristic scoring is honest.
════════════════════════════════════════════════════════════════ */
async function _costEfficiency() {
  const dimensions = [];
  let score = 0;

  /* Index budget — 192/200 = 96% used (pressure at >95%) */
  const indexCount = 192;
  const indexMax   = 200;
  const indexRatio = indexCount / indexMax;
  const c1 = indexRatio < 0.85 ? 30 : indexRatio < 0.95 ? 20 : 10;
  score += c1;
  dimensions.push(dim("Firestore Index Budget", indexCount + " / " + indexMax, c1, 30));

  /* Scheduled CF count — < 5 = great, < 10 = ok, ≥ 10 = cost pressure */
  const scheduledCount = 8; // known constant from deployed functions
  const c2 = scheduledCount < 5 ? 25 : scheduledCount < 10 ? 20 : 15;
  score += c2;
  dimensions.push(dim("Scheduled Cloud Functions", scheduledCount + " scheduled jobs", c2, 25));

  /* Heavy CFs (512 MiB) — each adds cost at scale */
  const heavyCFs = 4; // getMarketplaceQualityReport, getSearchInsights, + 2 more
  const c3 = heavyCFs <= 3 ? 25 : heavyCFs <= 6 ? 20 : 15;
  score += c3;
  dimensions.push(dim("Heavy CFs (≥512 MiB)", heavyCFs + " CFs with elevated memory", c3, 25));

  /* Multi-region risk — all CFs in us-central1, no multi-region cost blowout */
  score += 20;
  dimensions.push(dim("Region Concentration", "All CFs in us-central1 (efficient)", 20, 20));

  const s = clamp(score);
  return { score: s, grade: grade(s), dimensions, dataComplete: true };
}

/* ════════════════════════════════════════════════════════════════
   getPlatformHealthScores
   Returns all 5 scores, an overall weighted score, and computed-at.
════════════════════════════════════════════════════════════════ */
exports.getPlatformHealthScores = onCall(
  { maxInstances: 5, timeoutSeconds: 120, memory: "512MiB" },
  async (request) => {
    requireAdmin(request);
    const db = getFirestore();

    const [marketplace, seller, buyer, operational, cost] = await Promise.all([
      _marketplaceHealth(db),
      _sellerSuccess(db),
      _buyerSatisfaction(db),
      _operationalHealth(db),
      _costEfficiency(),
    ]);

    /* Weighted overall score */
    const overall = clamp(
      marketplace.score  * 0.30 +
      seller.score       * 0.25 +
      buyer.score        * 0.25 +
      operational.score  * 0.15 +
      cost.score         * 0.05
    );

    /* Surface actionable alerts */
    const alerts = [];
    if (marketplace.score < 60) alerts.push({ severity: "high",   area: "Marketplace",   message: "Marketplace health is below 60 — review listing quality and seller activation" });
    if (seller.score      < 60) alerts.push({ severity: "high",   area: "Sellers",       message: "Seller success score is low — run getSellerPerformanceSummary and contact underperforming sellers" });
    if (buyer.score       < 60) alerts.push({ severity: "high",   area: "Buyers",        message: "Buyer satisfaction is low — check open bugs in /admin-feedback immediately" });
    if (operational.score < 75) alerts.push({ severity: "medium", area: "Operations",    message: "Operational health needs attention — review reliability-center.html" });
    if (cost.score        < 60) alerts.push({ severity: "medium", area: "Cost",          message: "Cost efficiency pressure — see docs/COST_GOVERNANCE.md" });
    if (operational.score >= 90 && overall >= 80)
      alerts.push({ severity: "info", area: "Platform", message: "Platform is operating well — focus on evidence-gated growth initiatives" });

    return {
      overall:     { score: overall, grade: grade(overall) },
      marketplace,
      seller,
      buyer,
      operational,
      cost,
      alerts,
      computedAt:  new Date().toISOString(),
      indexBudget: { used: 192, max: 200 },
    };
  }
);

/* ════════════════════════════════════════════════════════════════
   getTopBusinessPriorities
   Ranks v2.0 feature candidates using real Firestore evidence +
   static scoring matrix. Returns top 5 with justification.
════════════════════════════════════════════════════════════════ */
exports.getTopBusinessPriorities = onCall(
  { maxInstances: 5, timeoutSeconds: 60, memory: "256MiB" },
  async (request) => {
    requireAdmin(request);
    const db = getFirestore();

    /* Gather evidence signals in parallel */
    const [sellerPerf, funnelSnap, jobSearchSnap, featureReqSnap] = await Promise.all([
      db.collection("sellerPerformance").limit(200).get(),
      db.collection("funnelStats").orderBy("__name__", "desc").limit(30).get(),
      db.collection("searchQueryLog")
        .where("noResult", "==", false).limit(200).get(),
      db.collection("feedback")
        .where("type", "==", "feature").limit(100).get(),
    ]);

    /* Evidence: active sellers */
    const activeSellerCount = sellerPerf.docs.filter(d => (d.data().successfulOrders || 0) > 0).length;

    /* Evidence: funnel conversion rate */
    let cartToPaidRate = null;
    const funnelDocs = funnelSnap.docs.map(d => d.data());
    if (funnelDocs.length > 0) {
      const totalCart = funnelDocs.reduce((s, d) => s + (d.addToCart || 0), 0);
      const totalPaid = funnelDocs.reduce((s, d) => s + (d.orderPaid || 0), 0);
      cartToPaidRate = totalCart > 0 ? (totalPaid / totalCart) * 100 : null;
    }

    /* Evidence: job-related search terms */
    const jobTerms = ["job", "kazi", "work", "employment", "vacancy", "nafasi", "hiring"];
    const jobSearchCount = jobSearchSnap.docs.filter(d => {
      const q = (d.data().query || "").toLowerCase();
      return jobTerms.some(t => q.includes(t));
    }).length;

    /* Evidence: feature requests mentioning specific topics */
    const featureTexts = featureReqSnap.docs.map(d => (d.data().message || "").toLowerCase());
    const countMentions = (terms) => featureTexts.filter(t => terms.some(w => t.includes(w))).length;
    const loyaltyMentions  = countMentions(["loyalty", "points", "rewards", "cashback"]);
    const walletMentions   = countMentions(["wallet", "payout", "withdraw", "balance"]);
    const jobsMentions     = countMentions(["job", "jobs", "employment", "kazi"]);
    const cartMentions     = countMentions(["abandoned", "remind", "cart", "forgot"]);

    /* Scoring matrix: each criterion max 5 pts → max 25 total */
    function scoreCandidate(base, evidenceBoost) {
      return Math.min(25, base + evidenceBoost);
    }

    const candidates = [
      {
        id:            "loyalty_rewards",
        name:          "Loyalty & Rewards",
        description:   "Points on purchase, tier badges, redeem on checkout",
        revenueImpact: 5,
        userDemand:    3 + Math.min(2, loyaltyMentions),
        effortInverse: 3,
        strategic:     5,
        costInverse:   4,
        evidenceGate:  "Repeat buyer rate < 25% (run 30 days first)",
        evidenceReady: false,
      },
      {
        id:            "wallet_payouts",
        name:          "Wallet & Seller Payouts",
        description:   "Seller balance, automated weekly payout, buyer refund wallet",
        revenueImpact: 5,
        userDemand:    3 + Math.min(2, walletMentions),
        effortInverse: 2,
        strategic:     5,
        costInverse:   3,
        evidenceGate:  activeSellerCount >= 50
          ? "READY — " + activeSellerCount + " active sellers"
          : "Need ≥50 active sellers (currently " + activeSellerCount + ")",
        evidenceReady: activeSellerCount >= 50,
      },
      {
        id:            "cart_abandonment",
        name:          "Cart Abandonment Recovery",
        description:   "24-hour email trigger for abandoned carts",
        revenueImpact: 4,
        userDemand:    3 + Math.min(2, cartMentions),
        effortInverse: 4,
        strategic:     4,
        costInverse:   4,
        evidenceGate:  cartToPaidRate != null
          ? (cartToPaidRate < 35 ? "READY — cart→paid rate is " + cartToPaidRate.toFixed(1) + "%" : "Cart rate " + cartToPaidRate.toFixed(1) + "% — healthy (wait for Phase B)")
          : "Need 30 days of funnel data",
        evidenceReady: cartToPaidRate != null && cartToPaidRate < 35,
      },
      {
        id:            "jobs_marketplace",
        name:          "Jobs Marketplace",
        description:   "Employer dashboard, CV upload, application tracking on jobs.html",
        revenueImpact: 3,
        userDemand:    2 + Math.min(2, jobsMentions) + (jobSearchCount > 10 ? 1 : 0),
        effortInverse: 3,
        strategic:     4,
        costInverse:   4,
        evidenceGate:  jobSearchCount > 20
          ? "READY — " + jobSearchCount + " job-related searches logged"
          : "Need >20 job searches/week (" + jobSearchCount + " so far)",
        evidenceReady: jobSearchCount > 20,
      },
      {
        id:            "qr_ecosystem",
        name:          "QR Code Ecosystem",
        description:   "QR for products, seller stores, receipts, and loyalty",
        revenueImpact: 3,
        userDemand:    2,
        effortInverse: 3,
        strategic:     3,
        costInverse:   4,
        evidenceGate:  "No demand signal yet — defer to Phase C",
        evidenceReady: false,
      },
      {
        id:            "education_hub",
        name:          "Education Hub",
        description:   "Course listings, tutor marketplace, learning platform",
        revenueImpact: 2,
        userDemand:    2,
        effortInverse: 3,
        strategic:     3,
        costInverse:   4,
        evidenceGate:  "No demand signal yet — Jobs must prove service-marketplace pattern first",
        evidenceReady: false,
      },
      {
        id:            "insurance_marketplace",
        name:          "Insurance Marketplace",
        description:   "Health, vehicle, property insurance comparison and purchase",
        revenueImpact: 3,
        userDemand:    2,
        effortInverse: 2,
        strategic:     3,
        costInverse:   2,
        evidenceGate:  "Requires insurance partnerships — operational dependency not resolved",
        evidenceReady: false,
      },
      {
        id:            "government_services",
        name:          "Government Services",
        description:   "eCitizen integration, e-government service access",
        revenueImpact: 2,
        userDemand:    2,
        effortInverse: 2,
        strategic:     3,
        costInverse:   3,
        evidenceGate:  "Requires government API agreements — institutional dependency",
        evidenceReady: false,
      },
    ];

    /* Compute total and sort */
    const ranked = candidates.map(c => ({
      ...c,
      totalScore: c.revenueImpact + c.userDemand + c.effortInverse + c.strategic + c.costInverse,
    })).sort((a, b) => {
      /* Evidence-ready candidates float to top, then by score */
      if (a.evidenceReady && !b.evidenceReady) return -1;
      if (!a.evidenceReady && b.evidenceReady) return 1;
      return b.totalScore - a.totalScore;
    });

    return {
      topPriorities:    ranked.slice(0, 5),
      allCandidates:    ranked,
      recommendation:   ranked.find(c => c.evidenceReady)?.name || ranked[0]?.name,
      evidenceSignals: {
        activeSellerCount,
        cartToPaidRate,
        jobSearchCount,
        loyaltyMentions,
        walletMentions,
      },
      computedAt: new Date().toISOString(),
    };
  }
);
