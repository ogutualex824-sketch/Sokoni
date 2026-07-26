/* ============================================================
   SOKONI — Merchant Success & Growth Engine  v2.0
   17 Cloud Functions | Firebase Gen2 | Node 22 | us-central1

   Exports:
     getMerchantDashboard             onCall — full merchant overview
     getMerchantHealthScore           onCall — 8-factor health score (cached 1h)
     getMerchantAICoach               onCall — AI growth coaching (Haiku)
     getMerchantOpportunities         onCall — revenue opportunity detection
     getMerchantCRM                   onCall — customer segmentation + notes
     updateCustomerNote               onCall — save CRM note for a customer
     getMerchantInventoryIntelligence onCall — velocity + dead stock + reorder
     getMerchantFinancials            onCall — P&L, peaks, retention metrics
     getMerchantBenchmark             onCall — anonymised peer comparison
     getMerchantAutomations           onCall — list automation rules
     saveMerchantAutomation           onCall — create / update rule
     toggleMerchantAutomation         onCall — activate / deactivate rule
     createMerchantCampaign           onCall — AI-assisted campaign creation
     getMerchantCampaigns             onCall — list campaigns
     getMerchantAcademy               onCall — curriculum + XP progress
     updateAcademyProgress            onCall — mark lesson complete + award XP
     generateMerchantContent          onCall — AI content generation

   Index policy: NO composite indexes.
     All Firestore queries are single-field where() or doc-ID lookups.
     Multi-field filtering is performed in-memory after the query.
============================================================ */
"use strict";

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret }       = require("firebase-functions/params");
const admin                  = require("firebase-admin");
/* MiniShop config is still split across two stores during the convergence
   period. Reading minishopConfig/{id} directly means a merchant whose branding
   only ever landed in the legacy store scores zero for fields they actually
   filled in — and this file attaches a GRADE to that score. */
const { resolve: resolveConfig } = require("./minishop-config-schema");

if (!admin.apps.length) admin.initializeApp();

const ANTHROPIC_KEY = defineSecret("ANTHROPIC_API_KEY");

const _h = {}; // handler registry
const db            = admin.firestore();

/* ── CF option sets ──────────────────────────────────────── */
const CF_OPTS = {
  region:          "us-central1",
  memory:          "256MiB",
  timeoutSeconds:  60,
  cors:            true,
  enforceAppCheck: true,
};
const CF_AI_OPTS = {
  region:          "us-central1",
  memory:          "512MiB",
  timeoutSeconds:  120,
  cors:            true,
  enforceAppCheck: true,
  secrets:         [ANTHROPIC_KEY],
};

/* ═══════════════════════════════════════════════════════════
   HELPERS
═══════════════════════════════════════════════════════════ */

/** Convert any Firestore / Date / number timestamp to epoch ms */
function _toMs(val) {
  if (!val) return 0;
  if (typeof val.toMillis === "function") return val.toMillis();
  if (val instanceof Date) return val.getTime();
  if (typeof val === "number") return val;
  if (val._seconds) return val._seconds * 1000;
  return new Date(val).getTime() || 0;
}

/** YYYY-MM-DD string from epoch ms */
function _dateStr(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Today's date string */
function _todayStr() {
  return _dateStr(Date.now());
}

/** Strip HTML, trim, cap length */
function _san(s, max = 300) {
  if (s == null) return "";
  return String(s).replace(/<[^>]*>/g, "").trim().slice(0, max);
}

/** Validate and sanitise a shopId */
function _sanId(id) {
  if (!id) throw new HttpsError("invalid-argument", "shopId is required");
  const clean = String(id).replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 128);
  if (!clean) throw new HttpsError("invalid-argument", "Invalid shopId format");
  return clean;
}

/** Throw if request has no auth token */
function _requireAuth(req) {
  if (!req.auth) throw new HttpsError("unauthenticated", "Authentication required");
}

/**
 * Verify the calling uid owns / manages the shop.
 * Checks: shops/{shopId} document, then sellerProfiles (single-field query, filtered in-memory).
 * Returns the shop data object on success.
 */
async function _assertSellerAccess(shopId, uid) {
  const shopSnap = await db.collection("shops").doc(shopId).get();
  if (shopSnap.exists) {
    const shop = shopSnap.data();
    if (shop.sellerUid === uid || shop.ownerId === uid || shop.adminUid === uid) {
      return shop;
    }
  }
  // Fallback: single-field query on uid, filter shopId in memory
  const profileSnap = await db.collection("sellerProfiles")
    .where("uid", "==", uid)
    .limit(10)
    .get();
  const hasProfile = profileSnap.docs.some(d => d.data().shopId === shopId);
  if (!hasProfile) {
    throw new HttpsError("permission-denied", "You do not have access to this shop");
  }
  return shopSnap.exists ? shopSnap.data() : {};
}

/**
 * Call Claude Haiku with a 20-second AbortController timeout.
 * Uses Node 22 native fetch — no SDK dependency.
 */
async function _callClaude(prompt, maxTokens) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key":         ANTHROPIC_KEY.value(),
        "anthropic-version": "2023-06-01",
        "content-type":      "application/json",
      },
      body: JSON.stringify({
        model:     "claude-haiku-4-5-20251001",
        max_tokens: maxTokens || 800,
        messages:  [{ role: "user", content: prompt }],
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const err = await res.text().catch(() => "");
      throw new Error(`Anthropic ${res.status}: ${err.slice(0, 200)}`);
    }
    const data = await res.json();
    return data.content[0].text;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Calculate an 8-factor health score (0–100).
 * Returns { score, grade, factors[] }
 * Each factor: { name, score, maxScore, status, tip }
 */
function _calcHealthScore(shop, config, products, orders) {
  const now   = Date.now();
  const now30 = now - 30 * 864e5;
  const now60 = now - 60 * 864e5;
  const factors = [];

  /* 1. Profile Completeness — 15 pts */
  let ps = 0;
  if (_san(shop.name || shop.shopName || config.name || "", 5)) ps += 3;
  if (_san(shop.description || config.description || "", 500).length > 10) ps += 3;
  if (shop.logoUrl  || shop.logo     || config.logoUrl)  ps += 2;
  if (shop.coverUrl || shop.cover    || config.coverUrl) ps += 2;
  /* `config.contactPhone` is the canonical name; `config.phone` is the legacy
     one. Only the legacy name was checked here, so a merchant whose number
     lives solely in their MiniShop config — the normal case once saved through
     the CF — lost these 2 points and was graded down for a complete profile. */
  if (shop.phone || shop.contactPhone || config.contactPhone || config.phone) ps += 2;
  if (shop.category || config.category)                  ps += 1;
  const soc = shop.socialLinks || config.socialLinks || {};
  if (soc.whatsapp || soc.wa)                            ps += 1;
  if ((shop.paymentMethods || config.paymentMethods || []).length > 0) ps += 1;
  factors.push({
    name: "Profile Completeness", score: ps, maxScore: 15,
    status: ps >= 12 ? "good" : ps >= 8 ? "fair" : "poor",
    tip: ps < 15
      ? "Add logo, cover photo, phone, WhatsApp link, and accepted payment methods to build buyer trust."
      : null,
  });

  /* 2. Product Quality — 15 pts */
  let qs = 0;
  const pc = products.length;
  if (pc >= 5) qs += 2;
  const withImg   = products.filter(p => (Array.isArray(p.images) && p.images.length > 0) || p.image || p.imageUrl).length;
  const withDesc  = products.filter(p => _san(p.description || "", 2000).length > 30).length;
  const withPrice = products.filter(p => parseFloat(p.price || 0) > 0).length;
  if (pc > 0) {
    if (withImg   / pc >= 0.7) qs += 5; else if (withImg  / pc >= 0.4) qs += 2;
    if (withDesc  / pc >= 0.7) qs += 5; else if (withDesc / pc >= 0.4) qs += 2;
    if (withPrice / pc >= 0.9) qs += 3; else if (withPrice / pc >= 0.6) qs += 1;
  }
  factors.push({
    name: "Product Quality", score: qs, maxScore: 15,
    status: qs >= 12 ? "good" : qs >= 8 ? "fair" : "poor",
    tip: qs < 15
      ? `Ensure ≥70% of products have images and descriptions longer than 30 characters (currently ${pc} products).`
      : null,
  });

  /* 3. Customer Rating — 15 pts */
  let rs = 0;
  const rating      = parseFloat(shop.rating || shop.averageRating || 0);
  const reviewCount = parseInt(shop.reviewCount || shop.totalReviews || 0);
  if      (rating >= 4.5) rs = 15;
  else if (rating >= 4.0) rs = 12;
  else if (rating >= 3.5) rs = 8;
  else if (rating >= 3.0) rs = 4;
  if (reviewCount < 5 && rs > 8) rs = 8; // cap until enough reviews
  factors.push({
    name: "Customer Rating", score: rs, maxScore: 15,
    status: rs >= 12 ? "good" : rs >= 8 ? "fair" : "poor",
    tip: rs < 15
      ? `Rating: ${rating.toFixed(1)}/5 (${reviewCount} reviews). Encourage buyers to leave reviews and respond promptly.`
      : null,
  });

  /* 4. Order Performance — 15 pts */
  let os = 0;
  const completedOrders = orders.filter(o => ["completed", "delivered", "paid"].includes(o.status)).length;
  const totalOrders     = orders.length;
  const completionRate  = totalOrders > 0 ? completedOrders / totalOrders : 1;
  if      (completionRate >= 1.00) os = 15;
  else if (completionRate >= 0.90) os = 12;
  else if (completionRate >= 0.75) os = 8;
  else if (completionRate >= 0.60) os = 4;
  factors.push({
    name: "Order Performance", score: os, maxScore: 15,
    status: os >= 12 ? "good" : os >= 8 ? "fair" : "poor",
    tip: os < 15
      ? `Completion rate: ${Math.round(completionRate * 100)}%. Fulfil orders promptly and communicate delays to reduce failures.`
      : null,
  });

  /* 5. Response Time — 10 pts */
  let rt_s = 0;
  const rt = _san(config.responseTime || shop.responseTime || "", 50);
  if      (rt === "< 1 hour"  || rt.includes("1 hour"))  rt_s = 10;
  else if (rt === "< 3 hours" || rt.includes("3 hour"))  rt_s = 7;
  else if (rt === "< 24 hours"|| rt.includes("24 hour")) rt_s = 4;
  factors.push({
    name: "Response Time", score: rt_s, maxScore: 10,
    status: rt_s >= 8 ? "good" : rt_s >= 4 ? "fair" : "poor",
    tip: rt_s < 10
      ? 'Set response time to "< 1 hour" in shop settings — fast replies win more sales.'
      : null,
  });

  /* 6. Sales Growth — 10 pts */
  let gs = 2;
  const rev30 = orders
    .filter(o => _toMs(o.createdAt) >= now30)
    .reduce((s, o) => s + parseFloat(o.totalAmount || o.amount || o.total || 0), 0);
  const revPrior = orders
    .filter(o => { const t = _toMs(o.createdAt); return t >= now60 && t < now30; })
    .reduce((s, o) => s + parseFloat(o.totalAmount || o.amount || o.total || 0), 0);
  if (revPrior === 0 && rev30 > 0) {
    gs = 10;
  } else if (revPrior > 0) {
    const g = (rev30 - revPrior) / revPrior;
    if      (g >= 0.5) gs = 10;
    else if (g >= 0.2) gs = 8;
    else if (g >= 0)   gs = 5;
  }
  factors.push({
    name: "Sales Growth", score: gs, maxScore: 10,
    status: gs >= 8 ? "good" : gs >= 5 ? "fair" : "poor",
    tip: gs < 8
      ? "Run a WhatsApp promotion or flash sale to grow this month's revenue vs last month."
      : null,
  });

  /* 7. Inventory Health — 10 pts */
  let is = 7; // neutral when stockCount field not used
  const withStock = products.filter(p => p.stockCount !== undefined || p.quantity !== undefined || p.stock !== undefined);
  if (withStock.length > 0) {
    const inStock    = withStock.filter(p => parseInt(p.stockCount ?? p.quantity ?? p.stock ?? 0) > 0).length;
    const stockRatio = inStock / withStock.length;
    if      (stockRatio >= 1.0) is = 10;
    else if (stockRatio >= 0.8) is = 8;
    else if (stockRatio >= 0.6) is = 5;
    else                        is = 2;
  }
  factors.push({
    name: "Inventory Health", score: is, maxScore: 10,
    status: is >= 8 ? "good" : is >= 5 ? "fair" : "poor",
    tip: is < 8
      ? "Keep stock counts updated — out-of-stock products miss sales and hurt your search ranking."
      : null,
  });

  /* 8. Cancellation Rate — 10 pts */
  let cs = 0;
  const cancelledOrders = orders.filter(o => o.status === "cancelled").length;
  const cancelRate      = totalOrders > 0 ? cancelledOrders / totalOrders : 0;
  if      (cancelRate <= 0.02) cs = 10;
  else if (cancelRate <= 0.05) cs = 8;
  else if (cancelRate <= 0.10) cs = 5;
  else if (cancelRate <= 0.20) cs = 2;
  factors.push({
    name: "Cancellation Rate", score: cs, maxScore: 10,
    status: cs >= 8 ? "good" : cs >= 5 ? "fair" : "poor",
    tip: cs < 8
      ? `Cancellation rate: ${Math.round(cancelRate * 100)}%. Communicate availability and fulfilment timelines clearly.`
      : null,
  });

  /* Total + grade */
  const score = Math.min(100, factors.reduce((s, f) => s + f.score, 0));
  let grade;
  if      (score >= 90) grade = "A+";
  else if (score >= 80) grade = "A";
  else if (score >= 70) grade = "B";
  else if (score >= 60) grade = "C";
  else                  grade = "D";

  return { score, grade, factors };
}

/* ═══════════════════════════════════════════════════════════
   STATIC CONTENT — Academy modules
═══════════════════════════════════════════════════════════ */
const ACADEMY_MODULES = [
  { id: "setup", title: "Setting Up Your Store", icon: "🏪", lessons: [
    { id: "s1", title: "Writing a Great Shop Description",  duration: "5 min" },
    { id: "s2", title: "Choosing the Right Category",       duration: "3 min" },
    { id: "s3", title: "Setting Your Business Hours",       duration: "3 min" },
    { id: "s4", title: "Adding Contact Information",        duration: "4 min" },
    { id: "s5", title: "Setting Up Payment Methods",        duration: "5 min" },
  ]},
  { id: "products", title: "Product Excellence", icon: "📦", lessons: [
    { id: "p1", title: "Writing Product Descriptions That Sell", duration: "8 min" },
    { id: "p2", title: "Product Photography on a Budget",        duration: "10 min" },
    { id: "p3", title: "Pricing Strategy for Kenya",             duration: "7 min" },
    { id: "p4", title: "Managing Inventory Effectively",         duration: "6 min" },
  ]},
  { id: "customers", title: "Customer Service Excellence", icon: "⭐", lessons: [
    { id: "c1", title: "Responding Quickly to Inquiries",    duration: "5 min" },
    { id: "c2", title: "Handling Complaints Professionally", duration: "8 min" },
    { id: "c3", title: "Building Customer Loyalty",          duration: "7 min" },
    { id: "c4", title: "Getting More 5-Star Reviews",        duration: "6 min" },
  ]},
  { id: "marketing", title: "Marketing Your Business", icon: "📢", lessons: [
    { id: "m1", title: "WhatsApp Marketing That Works",           duration: "9 min" },
    { id: "m2", title: "Instagram for Business",                  duration: "8 min" },
    { id: "m3", title: "Creating Promotions That Drive Sales",    duration: "7 min" },
    { id: "m4", title: "Understanding Your Analytics",            duration: "6 min" },
    { id: "m5", title: "Building Your Brand Story",               duration: "8 min" },
  ]},
  { id: "growth", title: "Growth Strategies", icon: "🚀", lessons: [
    { id: "g1", title: "Expanding Your Product Range",       duration: "8 min" },
    { id: "g2", title: "Cross-Selling and Upselling",        duration: "7 min" },
    { id: "g3", title: "Seasonal Sales Planning",            duration: "9 min" },
    { id: "g4", title: "Building a Repeat Customer Base",    duration: "10 min" },
  ]},
];

const ALL_LESSON_IDS = new Set(ACADEMY_MODULES.flatMap(m => m.lessons.map(l => l.id)));

/** Map moduleId → Set of its lessonIds */
const MODULE_LESSON_MAP = Object.fromEntries(
  ACADEMY_MODULES.map(m => [m.id, new Set(m.lessons.map(l => l.id))])
);

/* ── Automation valid types ──────────────────────────────── */
const VALID_AUTOMATION_TYPES = new Set([
  "low_stock_alert", "review_request", "win_back", "birthday_offer",
  "flash_sale", "reorder_reminder", "follow_up", "loyalty_reward",
  "appointment_reminder", "booking_confirmation",
]);

/* ── Campaign valid types ────────────────────────────────── */
const VALID_CAMPAIGN_TYPES = new Set([
  "whatsapp_blast", "email_campaign", "push_notification",
  "coupon", "flash_sale", "win_back",
]);

/* ── Content valid types ─────────────────────────────────── */
const VALID_CONTENT_TYPES = new Set([
  "product_description", "shop_bio", "whatsapp_status",
  "campaign_message", "response_template", "flash_sale_text",
]);

/* ═══════════════════════════════════════════════════════════
   1. getMerchantDashboard
═══════════════════════════════════════════════════════════ */
const getMerchantDashboard = onCall(CF_OPTS, _h.getMerchantDashboard = async (req) => {
  _requireAuth(req);
  const uid    = req.auth.uid;
  const shopId = _sanId(req.data?.shopId);

  const shop = await _assertSellerAccess(shopId, uid);

  const [configSnap, productsSnap, ordersSnap, reviewsSnap] = await Promise.all([
    db.collection("minishopConfig").doc(shopId).get(),
    db.collection("products").where("shopId", "==", shopId).limit(20).get(),
    db.collection("orders").where("shopId", "==", shopId).limit(50).get(),
    db.collection("shopReviews").where("shopId", "==", shopId).limit(10).get(),
  ]);

  /* `shop` comes from _assertSellerAccess above, so the legacy blob is already
     in hand — resolve() merges canonical over it and normalises both. */
  const config   = resolveConfig(
    configSnap.exists ? configSnap.data() : {},
    shop.minishopConfig,
    shop
  );
  const products = productsSnap.docs.map(d => d.data());
  const orders   = ordersSnap.docs.map(d => d.data());
  const reviews  = reviewsSnap.docs.map(d => d.data());

  const health = _calcHealthScore(shop, config, products, orders);

  // Quick stats
  const completedOrders = orders.filter(o => ["completed", "delivered", "paid"].includes(o.status));
  const totalRevenue    = completedOrders.reduce((s, o) => s + parseFloat(o.totalAmount || o.amount || o.total || 0), 0);
  const avgRating       = reviews.length > 0
    ? reviews.reduce((s, r) => s + parseFloat(r.rating || 0), 0) / reviews.length
    : parseFloat(shop.rating || 0);

  const quickStats = {
    totalOrders:   orders.length,
    totalRevenue:  Math.round(totalRevenue),
    avgOrderValue: completedOrders.length > 0 ? Math.round(totalRevenue / completedOrders.length) : 0,
    reviewCount:   parseInt(shop.reviewCount || reviews.length || 0),
    avgRating:     parseFloat(avgRating.toFixed(1)),
    followerCount: parseInt(shop.followerCount || shop.followers || 0),
    productCount:  parseInt(shop.productCount || products.length || 0),
  };

  // Alerts derived from factors scoring below 50% of max
  const recentAlerts = health.factors
    .filter(f => f.score < f.maxScore * 0.5)
    .slice(0, 5)
    .map(f => ({
      type:     f.name.toLowerCase().replace(/\s+/g, "_"),
      severity: f.score < f.maxScore * 0.25 ? "critical" : "warning",
      message:  f.tip || `${f.name} needs attention (${f.score}/${f.maxScore})`,
      action:   `Improve ${f.name}`,
    }));

  return { health, quickStats, recentAlerts };
});

/* ═══════════════════════════════════════════════════════════
   2. getMerchantHealthScore
═══════════════════════════════════════════════════════════ */
const getMerchantHealthScore = onCall(CF_OPTS, _h.getMerchantHealthScore = async (req) => {
  _requireAuth(req);
  const uid    = req.auth.uid;
  const shopId = _sanId(req.data?.shopId);

  // 1-hour cache check
  const cacheSnap = await db.collection("merchantHealth").doc(shopId).get();
  if (cacheSnap.exists) {
    const cached = cacheSnap.data();
    if (Date.now() - _toMs(cached.lastUpdated) < 3_600_000) {
      return { ...cached, trend: cached.trend || "stable" };
    }
  }

  const shop = await _assertSellerAccess(shopId, uid);

  const [configSnap, productsSnap, ordersSnap] = await Promise.all([
    db.collection("minishopConfig").doc(shopId).get(),
    db.collection("products").where("shopId", "==", shopId).limit(20).get(),
    db.collection("orders").where("shopId", "==", shopId).limit(50).get(),
  ]);

  /* `shop` comes from _assertSellerAccess above, so the legacy blob is already
     in hand — resolve() merges canonical over it and normalises both. */
  const config   = resolveConfig(
    configSnap.exists ? configSnap.data() : {},
    shop.minishopConfig,
    shop
  );
  const products = productsSnap.docs.map(d => d.data());
  const orders   = ordersSnap.docs.map(d => d.data());

  const { score, grade, factors } = _calcHealthScore(shop, config, products, orders);

  let trend = "stable";
  if (cacheSnap.exists) {
    const prev = cacheSnap.data().score || 0;
    if      (score > prev + 3) trend = "improving";
    else if (score < prev - 3) trend = "declining";
  }

  const result = {
    shopId,
    score,
    grade,
    factors,
    trend,
    lastUpdated: admin.firestore.Timestamp.now(),
  };

  // Write cache (non-blocking)
  db.collection("merchantHealth").doc(shopId).set(result, { merge: false }).catch(() => {});

  return result;
});

/* ═══════════════════════════════════════════════════════════
   3. getMerchantAICoach
═══════════════════════════════════════════════════════════ */
const getMerchantAICoach = onCall(CF_AI_OPTS, _h.getMerchantAICoach = async (req) => {
  _requireAuth(req);
  const uid      = req.auth.uid;
  const shopId   = _sanId(req.data?.shopId);
  const question = req.data?.question ? _san(req.data.question, 500) : null;

  const shop = await _assertSellerAccess(shopId, uid);

  // Rate-limit: 10 AI coach calls per shopId per day
  const rlKey = `${shopId}_${_todayStr()}`;
  await db.runTransaction(async tx => {
    const rlRef  = db.collection("aiCoachRL").doc(rlKey);
    const rlSnap = await tx.get(rlRef);
    const count  = rlSnap.exists ? (rlSnap.data().count || 0) : 0;
    if (count >= 10) throw new HttpsError("resource-exhausted", "AI coach limit: 10 calls per day per shop. Try again tomorrow.");
    tx.set(rlRef, { count: count + 1, shopId, updatedAt: admin.firestore.Timestamp.now() }, { merge: true });
  });

  const [ordersSnap, healthSnap] = await Promise.all([
    db.collection("orders").where("shopId", "==", shopId).limit(20).get(),
    db.collection("merchantHealth").doc(shopId).get(),
  ]);

  const orders    = ordersSnap.docs.map(d => d.data());
  const health    = healthSnap.exists ? healthSnap.data() : null;
  const revenue   = orders.reduce((s, o) => s + parseFloat(o.totalAmount || o.amount || o.total || 0), 0);
  const lowAreas  = health?.factors
    ? health.factors.filter(f => f.score < f.maxScore * 0.5).map(f => f.name).join(", ")
    : "Not yet assessed";

  const prompt = `You are a business coach for a Kenyan merchant on SOKONI marketplace.

Shop: ${_san(shop.name || shop.shopName || "Unknown", 80)}, Category: ${_san(shop.category || "General", 60)}
Health Score: ${health?.score ?? "N/A"}/100 (Grade ${health?.grade ?? "N/A"})
Recent Orders: ${orders.length} orders, Revenue: KES ${Math.round(revenue).toLocaleString()}
Average Rating: ${parseFloat(shop.rating || 0).toFixed(1)} (${parseInt(shop.reviewCount || 0)} reviews)
Low scoring areas: ${lowAreas}

${question ? `The merchant asks: ${question}` : "Provide 5 specific, actionable business growth recommendations."}

Keep advice practical, Kenya-specific, and focused on immediate wins.
Each recommendation: one sentence action + expected outcome.
Format: numbered list. Be specific, not generic.`;

  const recommendations = await _callClaude(prompt, 800);

  return { recommendations, question: question || null, timestamp: Date.now() };
});

/* ═══════════════════════════════════════════════════════════
   4. getMerchantOpportunities
═══════════════════════════════════════════════════════════ */
const getMerchantOpportunities = onCall(CF_OPTS, _h.getMerchantOpportunities = async (req) => {
  _requireAuth(req);
  const uid    = req.auth.uid;
  const shopId = _sanId(req.data?.shopId);

  await _assertSellerAccess(shopId, uid);

  const [productsSnap, ordersSnap] = await Promise.all([
    db.collection("products").where("shopId", "==", shopId).limit(100).get(),
    db.collection("orders").where("shopId",   "==", shopId).limit(200).get(),
  ]);

  const products = productsSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  const orders   = ordersSnap.docs.map(d => d.data());
  const now  = Date.now();
  const now7  = now -  7 * 864e5;
  const now30 = now - 30 * 864e5;
  const now60 = now - 60 * 864e5;

  // Build per-product order frequency map
  const pMap = {};
  for (const o of orders) {
    const ts    = _toMs(o.createdAt);
    const items = Array.isArray(o.items) ? o.items : (o.productId ? [{ productId: o.productId }] : []);
    for (const item of items) {
      const pid = item.productId || item.id;
      if (!pid) continue;
      if (!pMap[pid]) pMap[pid] = { total: 0, last7: 0, last30: 0 };
      pMap[pid].total++;
      if (ts >= now7)  pMap[pid].last7++;
      if (ts >= now30) pMap[pid].last30++;
    }
  }

  // Customer maps
  const custLast  = {};
  const custCount = {};
  for (const o of orders) {
    const cid = o.buyerId || o.buyerUid || o.customerId;
    if (!cid) continue;
    const ts = _toMs(o.createdAt);
    if (ts > (custLast[cid] || 0)) custLast[cid] = ts;
    custCount[cid] = (custCount[cid] || 0) + 1;
  }

  const lowStock = products
    .filter(p => {
      const sc = parseInt(p.stockCount ?? p.quantity ?? p.stock ?? -1);
      return sc > 0 && sc <= 5;
    })
    .map(p => ({
      productId:   p.id,
      name:        _san(p.name || p.title || "Product", 80),
      stockCount:  parseInt(p.stockCount ?? p.quantity ?? p.stock ?? 0),
      estDaysLeft: null,
    }));

  const outOfStock = products
    .filter(p => parseInt(p.stockCount ?? p.quantity ?? p.stock ?? 1) === 0)
    .map(p => ({ productId: p.id, name: _san(p.name || p.title || "Product", 80) }));

  const slowMovers = products
    .filter(p => { const pm = pMap[p.id]; return !pm || pm.last30 === 0; })
    .map(p => ({ productId: p.id, name: _san(p.name || p.title || "Product", 80) }));

  const topSellers = Object.entries(pMap)
    .sort((a, b) => b[1].total - a[1].total)
    .slice(0, 5)
    .map(([pid, stats]) => {
      const prod = products.find(p => p.id === pid);
      return { productId: pid, name: _san(prod?.name || prod?.title || pid, 80), orders: stats.total };
    });

  const returningCustomersCount = Object.values(custCount).filter(c => c >= 2).length;
  const inactiveCustomersCount  = Object.values(custLast).filter(t => t > 0 && t < now60).length;

  const missedSalesCount = products.filter(p => {
    const sc = parseInt(p.stockCount ?? p.quantity ?? p.stock ?? -1);
    if (sc !== 0) return false;
    const pm = pMap[p.id];
    return pm && pm.last7 > 0;
  }).length;

  return {
    lowStock,
    outOfStock,
    slowMovers,
    topSellers,
    returningCustomersCount,
    inactiveCustomersCount,
    missedSalesCount,
  };
});

/* ═══════════════════════════════════════════════════════════
   5. getMerchantCRM
═══════════════════════════════════════════════════════════ */
const getMerchantCRM = onCall(CF_OPTS, _h.getMerchantCRM = async (req) => {
  _requireAuth(req);
  const uid     = req.auth.uid;
  const shopId  = _sanId(req.data?.shopId);
  const limit   = Math.min(50, Math.max(5, parseInt(req.data?.limit || 20)));
  const segment = _san(req.data?.segment || "", 30);

  await _assertSellerAccess(shopId, uid);

  const ordersSnap = await db.collection("orders").where("shopId", "==", shopId).limit(500).get();
  const orders     = ordersSnap.docs.map(d => d.data());
  const now  = Date.now();
  const now30 = now - 30 * 864e5;
  const now45 = now - 45 * 864e5;
  const now90 = now - 90 * 864e5;

  // Aggregate per customer
  const cMap = {};
  for (const o of orders) {
    const cid = o.buyerId || o.buyerUid || o.customerId;
    if (!cid) continue;
    if (!cMap[cid]) {
      cMap[cid] = {
        customerId:     cid,
        name:           _san(o.buyerName || o.customerName || "Customer", 80),
        phone:          o.buyerPhone || null,
        totalOrders:    0,
        totalSpent:     0,
        lastOrderDate:  0,
        firstOrderDate: Infinity,
        pFreq:          {},
      };
    }
    const c   = cMap[cid];
    const amt = parseFloat(o.totalAmount || o.amount || o.total || 0);
    const ts  = _toMs(o.createdAt);
    c.totalOrders++;
    c.totalSpent += amt;
    if (ts > c.lastOrderDate)  c.lastOrderDate  = ts;
    if (ts < c.firstOrderDate) c.firstOrderDate = ts;
    const items = Array.isArray(o.items) ? o.items : (o.productId ? [{ productId: o.productId, name: o.productName || o.productId }] : []);
    for (const item of items) {
      const pid = item.productId || item.name || "";
      if (pid) c.pFreq[pid] = (c.pFreq[pid] || 0) + 1;
    }
  }

  const allCustomers = Object.values(cMap).map(c => {
    const last  = c.lastOrderDate;
    const first = c.firstOrderDate === Infinity ? now : c.firstOrderDate;
    const aov   = c.totalOrders > 0 ? Math.round(c.totalSpent / c.totalOrders) : 0;
    const favProd = Object.entries(c.pFreq).sort((a, b) => b[1] - a[1])[0]?.[0] || null;

    let seg;
    if      (c.totalOrders >= 5 && last >= now30) seg = "champion";
    else if (c.totalOrders >= 3)                  seg = "loyal";
    else if (last < now90)                        seg = "lost";
    else if (last < now45)                        seg = "at_risk";
    else                                          seg = "new";

    return {
      customerId:    c.customerId,
      name:          c.name,
      phone:         c.phone,
      totalOrders:   c.totalOrders,
      totalSpent:    Math.round(c.totalSpent),
      lastOrderDate: last,
      firstOrderDate: first,
      avgOrderValue: aov,
      favoriteProduct: favProd,
      segment:       seg,
      note:          null,
    };
  });

  const segments = {
    champion: allCustomers.filter(c => c.segment === "champion").length,
    loyal:    allCustomers.filter(c => c.segment === "loyal").length,
    at_risk:  allCustomers.filter(c => c.segment === "at_risk").length,
    new:      allCustomers.filter(c => c.segment === "new").length,
    lost:     allCustomers.filter(c => c.segment === "lost").length,
  };

  let filtered = segment ? allCustomers.filter(c => c.segment === segment) : allCustomers;
  filtered.sort((a, b) => b.totalSpent - a.totalSpent);
  const page = filtered.slice(0, limit);

  // Fetch CRM notes for this page (doc-ID lookups)
  const noteSnaps = await Promise.all(
    page.map(c =>
      db.collection("crmNotes").doc(shopId).collection("customers").doc(c.customerId).get()
    )
  );
  noteSnaps.forEach((snap, i) => {
    if (snap.exists) page[i].note = snap.data().note || null;
  });

  return { customers: page, totalCustomers: filtered.length, segments };
});

/* ═══════════════════════════════════════════════════════════
   6. updateCustomerNote
═══════════════════════════════════════════════════════════ */
const updateCustomerNote = onCall(CF_OPTS, _h.updateCustomerNote = async (req) => {
  _requireAuth(req);
  const uid        = req.auth.uid;
  const shopId     = _sanId(req.data?.shopId);
  const customerId = _san(req.data?.customerId || "", 128);
  const note       = _san(req.data?.note || "", 1000);

  if (!customerId) throw new HttpsError("invalid-argument", "customerId is required");

  await _assertSellerAccess(shopId, uid);

  await db.collection("crmNotes").doc(shopId).collection("customers").doc(customerId).set({
    note,
    updatedAt: admin.firestore.Timestamp.now(),
    updatedBy: uid,
  }, { merge: true });

  return { success: true };
});

/* ═══════════════════════════════════════════════════════════
   7. getMerchantInventoryIntelligence
═══════════════════════════════════════════════════════════ */
const getMerchantInventoryIntelligence = onCall(CF_OPTS, _h.getMerchantInventoryIntelligence = async (req) => {
  _requireAuth(req);
  const uid    = req.auth.uid;
  const shopId = _sanId(req.data?.shopId);

  await _assertSellerAccess(shopId, uid);

  const [productsSnap, ordersSnap] = await Promise.all([
    db.collection("products").where("shopId", "==", shopId).limit(200).get(),
    db.collection("orders").where("shopId",   "==", shopId).limit(100).get(),
  ]);

  const products = productsSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  const orders   = ordersSnap.docs.map(d => d.data());
  const now  = Date.now();
  const now7  = now -  7 * 864e5;
  const now30 = now - 30 * 864e5;
  const now90 = now - 90 * 864e5;

  // Build per-product sales velocity
  const vel = {};
  for (const o of orders) {
    const ts    = _toMs(o.createdAt);
    const items = Array.isArray(o.items) ? o.items : (o.productId ? [{ productId: o.productId }] : []);
    for (const item of items) {
      const pid = item.productId || item.id;
      if (!pid) continue;
      if (!vel[pid]) vel[pid] = { last7: 0, last30: 0, last90: 0 };
      if (ts >= now7)  vel[pid].last7++;
      if (ts >= now30) vel[pid].last30++;
      if (ts >= now90) vel[pid].last90++;
    }
  }

  const fastMoving  = [];
  const slowMoving  = [];
  const deadStock   = [];
  const lowStock    = [];
  const outOfStock  = [];
  const overstocked = [];
  let healthyCount  = 0;

  for (const p of products) {
    const v      = vel[p.id] || { last7: 0, last30: 0, last90: 0 };
    const stock  = parseInt(p.stockCount ?? p.quantity ?? p.stock ?? -1);
    const name   = _san(p.name || p.title || "Product", 80);
    const price  = parseFloat(p.price || 0);

    if (stock === 0) {
      outOfStock.push({ productId: p.id, name, price, monthlyVelocity: v.last30, recommendation: "Restock immediately — buyers cannot place orders." });
      continue;
    }
    if (stock !== -1 && stock <= 5 && v.last30 > 0) {
      const estDaysLeft = Math.round(stock / (v.last30 / 30));
      lowStock.push({ productId: p.id, name, price, stockCount: stock, monthlyVelocity: v.last30, estDaysLeft, recommendation: "Reorder before you run out." });
    }
    if (v.last7 > 3) {
      fastMoving.push({ productId: p.id, name, price, stockCount: stock === -1 ? null : stock, weeklyVelocity: v.last7, recommendation: "Best seller — keep well stocked and consider a slight price increase." });
    } else if (v.last90 === 0) {
      deadStock.push({ productId: p.id, name, price, stockCount: stock === -1 ? null : stock, recommendation: "No sales in 90 days — discount, bundle, or remove the listing." });
    } else if (v.last30 < 1) {
      slowMoving.push({ productId: p.id, name, price, stockCount: stock === -1 ? null : stock, monthlyVelocity: v.last30, recommendation: "Improve photos and description, or run a flash sale to stimulate demand." });
    } else if (stock !== -1 && stock > 50 && v.last30 < 1) {
      overstocked.push({ productId: p.id, name, price, stockCount: stock, monthlyVelocity: v.last30, recommendation: "Overstock risk — offer bulk-buy deals or a clearance discount." });
    } else {
      healthyCount++;
    }
  }

  const actionNeeded = fastMoving.length + slowMoving.length + deadStock.length +
    lowStock.length + outOfStock.length + overstocked.length;

  return {
    fastMoving,
    slowMoving,
    deadStock,
    lowStock,
    outOfStock,
    overstocked,
    summary: { totalProducts: products.length, healthyCount, actionNeeded },
  };
});

/* ═══════════════════════════════════════════════════════════
   8. getMerchantFinancials
═══════════════════════════════════════════════════════════ */
const getMerchantFinancials = onCall(CF_OPTS, _h.getMerchantFinancials = async (req) => {
  _requireAuth(req);
  const uid    = req.auth.uid;
  const shopId = _sanId(req.data?.shopId);
  const days   = Math.min(90, Math.max(7, parseInt(req.data?.days || 30)));

  await _assertSellerAccess(shopId, uid);

  const cutoff = Date.now() - days * 864e5;

  const [ordersSnap, commissionsSnap] = await Promise.all([
    db.collection("orders").where("shopId", "==", shopId).limit(500).get(),
    db.collection("commissions").where("sellerId", "==", shopId).limit(50).get(),
  ]);

  const allOrders      = ordersSnap.docs.map(d => d.data());
  const periodOrders   = allOrders.filter(o => _toMs(o.createdAt) >= cutoff);
  const completedOrders = periodOrders.filter(o => ["completed", "delivered", "paid"].includes(o.status));

  const totalRevenue  = completedOrders.reduce((s, o) => s + parseFloat(o.totalAmount || o.amount || o.total || 0), 0);
  const platformFees  = completedOrders.reduce((s, o) => s + parseFloat(o.commissionAmount || o.platformFee || 0), 0);
  const commTotal     = commissionsSnap.docs.reduce((s, d) => s + parseFloat(d.data().amount || 0), 0);
  const netRevenue    = totalRevenue - (platformFees || commTotal);

  // Daily revenue — fill all days in the period
  const dailyMap = {};
  for (const o of completedOrders) {
    const d = _dateStr(_toMs(o.createdAt));
    if (!dailyMap[d]) dailyMap[d] = { revenue: 0, orders: 0 };
    dailyMap[d].revenue += parseFloat(o.totalAmount || o.amount || o.total || 0);
    dailyMap[d].orders++;
  }
  const dailyRevenue = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = _dateStr(Date.now() - i * 864e5);
    dailyRevenue.push({ date: d, revenue: Math.round(dailyMap[d]?.revenue || 0), orders: dailyMap[d]?.orders || 0 });
  }

  // Top 10 products by revenue
  const prodRev = {};
  for (const o of completedOrders) {
    const items = Array.isArray(o.items)
      ? o.items
      : (o.productId ? [{ productId: o.productId, name: o.productName || o.productId, price: o.totalAmount || o.amount || 0, quantity: 1 }] : []);
    for (const item of items) {
      const pid = item.productId || item.name || "unknown";
      const amt = parseFloat(item.price || 0) * parseInt(item.quantity || item.qty || 1);
      if (!prodRev[pid]) prodRev[pid] = { name: _san(item.name || pid, 80), revenue: 0, units: 0 };
      prodRev[pid].revenue += amt;
      prodRev[pid].units   += parseInt(item.quantity || item.qty || 1);
    }
  }
  const topProducts = Object.entries(prodRev)
    .map(([id, v]) => ({ id, name: v.name, revenue: Math.round(v.revenue), units: v.units }))
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 10);

  // Peak hours
  const hourCounts = Array(24).fill(0);
  for (const o of periodOrders) hourCounts[new Date(_toMs(o.createdAt)).getUTCHours()]++;
  const peakHours = hourCounts
    .map((count, hour) => ({ hour, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  // Peak days
  const dayNames  = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const dayCounts = Array(7).fill(0);
  for (const o of periodOrders) dayCounts[new Date(_toMs(o.createdAt)).getUTCDay()]++;
  const peakDays = dayCounts
    .map((count, day) => ({ day: dayNames[day], count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 3);

  // Repeat purchase rate + CLV (all-time)
  const custAll = {};
  for (const o of allOrders) {
    const cid = o.buyerId || o.buyerUid || o.customerId;
    if (cid) custAll[cid] = (custAll[cid] || 0) + 1;
  }
  const uniqueCustomers      = Object.keys(custAll).length;
  const repeatCustomers      = Object.values(custAll).filter(c => c > 1).length;
  const repeatPurchaseRate   = uniqueCustomers > 0 ? Math.round((repeatCustomers / uniqueCustomers) * 100) : 0;
  const allTimeRevenue       = allOrders.reduce((s, o) => s + parseFloat(o.totalAmount || o.amount || o.total || 0), 0);
  const customerLifetimeValue = uniqueCustomers > 0 ? Math.round(allTimeRevenue / uniqueCustomers) : 0;

  return {
    period:               `${days}d`,
    totalRevenue:         Math.round(totalRevenue),
    totalOrders:          periodOrders.length,
    avgOrderValue:        completedOrders.length > 0 ? Math.round(totalRevenue / completedOrders.length) : 0,
    dailyRevenue,
    topProducts,
    peakHours,
    peakDays,
    repeatPurchaseRate,
    customerLifetimeValue,
    platformFees:         Math.round(platformFees || commTotal),
    netRevenue:           Math.round(netRevenue),
    uniqueCustomers,
  };
});

/* ═══════════════════════════════════════════════════════════
   9. getMerchantBenchmark
═══════════════════════════════════════════════════════════ */
const getMerchantBenchmark = onCall(CF_OPTS, _h.getMerchantBenchmark = async (req) => {
  _requireAuth(req);
  const uid    = req.auth.uid;
  const shopId = _sanId(req.data?.shopId);

  const shop       = await _assertSellerAccess(shopId, uid);
  const myCategory = _san(shop.category || "General", 80);

  const [myOrdersSnap, peersSnap] = await Promise.all([
    db.collection("orders").where("shopId",   "==", shopId).limit(200).get(),
    db.collection("shops").where("category",  "==", myCategory).limit(20).get(),
  ]);

  const myOrders    = myOrdersSnap.docs.map(d => d.data());
  const myCompleted = myOrders.filter(o => ["completed", "delivered", "paid"].includes(o.status)).length;
  const myCompletionRate = myOrders.length > 0
    ? Math.round((myCompleted / myOrders.length) * 100)
    : 100;
  const myRating = parseFloat(shop.rating || shop.averageRating || 0);

  const myMetrics = {
    rating:          myRating,
    productCount:    parseInt(shop.productCount || 0),
    completionRate:  myCompletionRate,
    avgResponseTime: _san(shop.responseTime || "", 50) || "Not set",
  };

  // Aggregate peers — never expose individual shop IDs
  const peers       = peersSnap.docs.filter(d => d.id !== shopId).map(d => d.data());
  const peerRatings = peers.map(p => parseFloat(p.rating || p.averageRating || 0)).filter(r => r > 0);
  const peerProdCounts = peers.map(p => parseInt(p.productCount || 0));

  const avgRating    = peerRatings.length > 0
    ? peerRatings.reduce((s, r) => s + r, 0) / peerRatings.length
    : 4.2;
  const avgProductCount = peerProdCounts.length > 0
    ? Math.round(peerProdCounts.reduce((s, c) => s + c, 0) / peerProdCounts.length)
    : 10;

  const below      = peerRatings.filter(r => r < myRating).length;
  const percentile = peerRatings.length > 0 ? Math.round((below / peerRatings.length) * 100) : 50;

  const message = percentile >= 75
    ? "You are in the top 25% of shops in your category. Keep it up!"
    : percentile >= 50
      ? "You are above average. Small improvements can push you to the top quartile."
      : "There is room to improve. Focus on your health score factors to move up.";

  return {
    myMetrics,
    benchmarks: {
      avgRating:         parseFloat(avgRating.toFixed(1)),
      avgProductCount,
      avgCompletionRate: 85, // platform-wide default
      topQuartileRevenue: null,
    },
    rank: { percentile, message },
  };
});

/* ═══════════════════════════════════════════════════════════
   10. getMerchantAutomations
═══════════════════════════════════════════════════════════ */
const getMerchantAutomations = onCall(CF_OPTS, _h.getMerchantAutomations = async (req) => {
  _requireAuth(req);
  const uid    = req.auth.uid;
  const shopId = _sanId(req.data?.shopId);

  await _assertSellerAccess(shopId, uid);

  const snap = await db.collection("merchantAutomations")
    .where("shopId", "==", shopId)
    .limit(20)
    .get();

  const automations = snap.docs.map(d => ({
    id:       d.id,
    name:     d.data().name || d.data().type,
    type:     d.data().type,
    trigger:  d.data().trigger  || {},
    action:   d.data().action   || {},
    active:   d.data().active  !== false,
    lastRun:  d.data().lastRun  || null,
    runCount: d.data().runCount || 0,
  }));

  return { automations };
});

/* ═══════════════════════════════════════════════════════════
   11. saveMerchantAutomation
═══════════════════════════════════════════════════════════ */
const saveMerchantAutomation = onCall(CF_OPTS, _h.saveMerchantAutomation = async (req) => {
  _requireAuth(req);
  const uid    = req.auth.uid;
  const shopId = _sanId(req.data?.shopId);
  const ruleId = req.data?.ruleId ? _san(req.data.ruleId, 128) : null;
  const name   = _san(req.data?.name || "", 200);
  const type   = _san(req.data?.type || "", 60);
  const active = req.data?.active !== false;

  if (!name)                            throw new HttpsError("invalid-argument", "Automation name is required");
  if (!VALID_AUTOMATION_TYPES.has(type)) throw new HttpsError("invalid-argument", `Invalid type. Allowed: ${[...VALID_AUTOMATION_TYPES].join(", ")}`);

  await _assertSellerAccess(shopId, uid);

  const trigger = (typeof req.data?.trigger === "object" && !Array.isArray(req.data.trigger)) ? req.data.trigger : {};
  const action  = (typeof req.data?.action  === "object" && !Array.isArray(req.data.action))  ? req.data.action  : {};

  const ts  = admin.firestore.Timestamp.now();
  const ref = ruleId
    ? db.collection("merchantAutomations").doc(ruleId)
    : db.collection("merchantAutomations").doc();

  const data = { shopId, name, type, trigger, action, active, updatedAt: ts, updatedBy: uid };
  if (!ruleId) { data.createdAt = ts; data.createdBy = uid; data.runCount = 0; }

  await ref.set(data, { merge: !!ruleId });

  return { id: ref.id, success: true };
});

/* ═══════════════════════════════════════════════════════════
   12. toggleMerchantAutomation
═══════════════════════════════════════════════════════════ */
const toggleMerchantAutomation = onCall(CF_OPTS, _h.toggleMerchantAutomation = async (req) => {
  _requireAuth(req);
  const uid    = req.auth.uid;
  const shopId = _sanId(req.data?.shopId);
  const ruleId = _san(req.data?.ruleId || "", 128);
  const active = Boolean(req.data?.active);

  if (!ruleId) throw new HttpsError("invalid-argument", "ruleId is required");

  await _assertSellerAccess(shopId, uid);

  const ruleRef  = db.collection("merchantAutomations").doc(ruleId);
  const ruleSnap = await ruleRef.get();
  if (!ruleSnap.exists)                    throw new HttpsError("not-found", "Automation rule not found");
  if (ruleSnap.data().shopId !== shopId)   throw new HttpsError("permission-denied", "Rule does not belong to this shop");

  await ruleRef.update({ active, updatedAt: admin.firestore.Timestamp.now() });

  return { success: true, active };
});

/* ═══════════════════════════════════════════════════════════
   13. createMerchantCampaign
═══════════════════════════════════════════════════════════ */
const createMerchantCampaign = onCall(CF_AI_OPTS, _h.createMerchantCampaign = async (req) => {
  _requireAuth(req);
  const uid             = req.auth.uid;
  const shopId          = _sanId(req.data?.shopId);
  const type            = _san(req.data?.type || "", 60);
  const name            = _san(req.data?.name || "", 200);
  const targetSegment   = _san(req.data?.targetSegment || "all", 50);
  const discountPercent = Math.min(80, Math.max(0, parseInt(req.data?.discountPercent || 0)));
  let   message         = _san(req.data?.message || "", 1600);

  if (!VALID_CAMPAIGN_TYPES.has(type)) throw new HttpsError("invalid-argument", `Invalid campaign type. Allowed: ${[...VALID_CAMPAIGN_TYPES].join(", ")}`);
  if (!name)                           throw new HttpsError("invalid-argument", "Campaign name is required");

  const shop = await _assertSellerAccess(shopId, uid);

  // Generate message with Haiku if not provided
  if (!message) {
    const prompt = `Write a ${type.replace(/_/g, " ")} marketing message for a ${_san(shop.category || "retail", 60)} business called "${_san(shop.name || shop.shopName || "our shop", 80)}" in Kenya. Keep it under 160 characters. Be warm, specific, and action-oriented. Include a call to action.`;
    try {
      message = (await _callClaude(prompt, 200)).trim().slice(0, 1600);
    } catch (_e) {
      message = `Special offer from ${_san(shop.name || "our shop", 50)}! Shop now at sokoni.co.ke`;
    }
  }

  const campaignRef = db.collection("merchantCampaigns").doc();
  await campaignRef.set({
    shopId,
    type,
    name,
    targetSegment,
    message,
    discountPercent,
    status:    "draft",
    createdAt: admin.firestore.Timestamp.now(),
    createdBy: uid,
    stats:     { sent: 0, opens: 0, clicks: 0, orders: 0, revenue: 0 },
  });

  return { campaignId: campaignRef.id, message, success: true };
});

/* ═══════════════════════════════════════════════════════════
   14. getMerchantCampaigns
═══════════════════════════════════════════════════════════ */
const getMerchantCampaigns = onCall(CF_OPTS, _h.getMerchantCampaigns = async (req) => {
  _requireAuth(req);
  const uid    = req.auth.uid;
  const shopId = _sanId(req.data?.shopId);

  await _assertSellerAccess(shopId, uid);

  const snap = await db.collection("merchantCampaigns")
    .where("shopId", "==", shopId)
    .limit(20)
    .get();

  return { campaigns: snap.docs.map(d => ({ id: d.id, ...d.data() })) };
});

/* ═══════════════════════════════════════════════════════════
   15. getMerchantAcademy
═══════════════════════════════════════════════════════════ */
const getMerchantAcademy = onCall(CF_OPTS, _h.getMerchantAcademy = async (req) => {
  _requireAuth(req);
  const uid = req.auth.uid;

  // Progress keyed by uid (single doc-ID lookup)
  const progressSnap = await db.collection("academyProgress").doc(uid).get();
  const pData        = progressSnap.exists ? progressSnap.data() : { completedLessons: [], totalXP: 0 };
  const completedSet = new Set(Array.isArray(pData.completedLessons) ? pData.completedLessons : []);
  const totalXP      = parseInt(pData.totalXP || 0);

  const totalLessons = ACADEMY_MODULES.reduce((s, m) => s + m.lessons.length, 0);
  const completedCount = [...completedSet].filter(id => ALL_LESSON_IDS.has(id)).length;

  const modules = ACADEMY_MODULES.map(mod => {
    const doneInMod = mod.lessons.filter(l => completedSet.has(l.id)).length;
    return {
      ...mod,
      completedCount: doneInMod,
      progress:       Math.round((doneInMod / mod.lessons.length) * 100),
      completed:      doneInMod === mod.lessons.length,
      lessons:        mod.lessons.map(l => ({ ...l, completed: completedSet.has(l.id) })),
    };
  });

  let level;
  if      (completedCount >= totalLessons)           level = "Expert";
  else if (completedCount >= totalLessons * 0.6)     level = "Advanced";
  else if (completedCount >= totalLessons * 0.3)     level = "Intermediate";
  else                                               level = "Beginner";

  let nextLesson = null;
  outer: for (const mod of ACADEMY_MODULES) {
    for (const l of mod.lessons) {
      if (!completedSet.has(l.id)) {
        nextLesson = { moduleId: mod.id, moduleTitle: mod.title, ...l };
        break outer;
      }
    }
  }

  return { modules, totalLessons, completedLessons: completedCount, totalXP, level, nextLesson };
});

/* ═══════════════════════════════════════════════════════════
   16. updateAcademyProgress
═══════════════════════════════════════════════════════════ */
const updateAcademyProgress = onCall(CF_OPTS, _h.updateAcademyProgress = async (req) => {
  _requireAuth(req);
  const uid      = req.auth.uid;
  const lessonId = _san(req.data?.lessonId || "", 20);
  const moduleId = _san(req.data?.moduleId || "", 20);

  if (!ALL_LESSON_IDS.has(lessonId)) throw new HttpsError("invalid-argument", "Invalid lessonId");

  const ref = db.collection("academyProgress").doc(uid);

  return db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    const data = snap.exists ? snap.data() : { completedLessons: [], totalXP: 0 };
    const completedArr = Array.isArray(data.completedLessons) ? data.completedLessons : [];
    const completedSet = new Set(completedArr);

    const isNew     = !completedSet.has(lessonId);
    let xpEarned    = 0;
    let newBadge    = null;

    if (isNew) {
      completedSet.add(lessonId);
      xpEarned += 10;

      // Module completion bonus
      if (moduleId && MODULE_LESSON_MAP[moduleId]) {
        const modDone = [...MODULE_LESSON_MAP[moduleId]].every(id => completedSet.has(id));
        if (modDone) { xpEarned += 50; newBadge = `${moduleId}_complete`; }
      }

      // All-modules completion bonus
      if ([...ALL_LESSON_IDS].every(id => completedSet.has(id))) {
        xpEarned += 200;
        newBadge  = "all_modules_complete";
      }
    }

    const totalXP = parseInt(data.totalXP || 0) + xpEarned;

    tx.set(ref, {
      uid,
      completedLessons: admin.firestore.FieldValue.arrayUnion(lessonId),
      totalXP,
      updatedAt: admin.firestore.Timestamp.now(),
    }, { merge: true });

    return { success: true, xpEarned, totalXP, newBadge };
  });
});

/* ═══════════════════════════════════════════════════════════
   17. generateMerchantContent
═══════════════════════════════════════════════════════════ */
const generateMerchantContent = onCall(CF_AI_OPTS, _h.generateMerchantContent = async (req) => {
  _requireAuth(req);
  const uid         = req.auth.uid;
  const shopId      = _sanId(req.data?.shopId);
  const contentType = _san(req.data?.contentType || "", 50);
  const context     = _san(req.data?.context || "", 1000);

  if (!VALID_CONTENT_TYPES.has(contentType)) {
    throw new HttpsError("invalid-argument", `Invalid contentType. Allowed: ${[...VALID_CONTENT_TYPES].join(", ")}`);
  }

  const shop = await _assertSellerAccess(shopId, uid);

  // Rate-limit: 20 AI content calls per uid per day
  const rlKey = `${uid}_${_todayStr()}`;
  await db.runTransaction(async tx => {
    const rlRef  = db.collection("aiContentRL").doc(rlKey);
    const rlSnap = await tx.get(rlRef);
    const count  = rlSnap.exists ? (rlSnap.data().count || 0) : 0;
    if (count >= 20) throw new HttpsError("resource-exhausted", "Content generation limit: 20 per day. Try again tomorrow.");
    tx.set(rlRef, { count: count + 1, uid, updatedAt: admin.firestore.Timestamp.now() }, { merge: true });
  });

  const shopName = _san(shop.name || shop.shopName || "our shop", 80);
  const category = _san(shop.category || "retail", 60);

  const prompts = {
    product_description: `Write a compelling product description for a ${category} business in Kenya called "${shopName}". Product details: ${context || "a quality item"}. Under 200 words. Focus on benefits, local context, and end with a call to action.`,
    shop_bio:            `Write a professional shop bio for "${shopName}", a ${category} business in Kenya. Context: ${context || "a trusted local business"}. Under 150 words. Warm, professional, trust-building.`,
    whatsapp_status:     `Write 3 WhatsApp status update options for "${shopName}" (${category}) in Kenya. Context: ${context || "general promotion"}. Each under 100 characters. Engaging and action-oriented.`,
    campaign_message:    `Write a marketing campaign message for "${shopName}" (${category}) in Kenya. Campaign: ${context || "general promotion"}. Under 160 characters. Warm, specific, clear call to action.`,
    response_template:   `Write a professional customer service response template for "${shopName}" (${category}) in Kenya. Situation: ${context || "general inquiry"}. Under 100 words. Friendly, include [Customer Name] placeholder.`,
    flash_sale_text:     `Write an exciting flash sale announcement for "${shopName}" (${category}) in Kenya. Sale details: ${context || "up to 30% off selected items, today only"}. Under 150 characters. Urgency and excitement.`,
  };

  const content = await _callClaude(prompts[contentType], 400);

  return { content, contentType };
});

/* ═══════════════════════════════════════════════════════════
   EXPORTS
═══════════════════════════════════════════════════════════ */
module.exports = {
  _h,
  getMerchantDashboard,
  getMerchantHealthScore,
  getMerchantAICoach,
  getMerchantOpportunities,
  getMerchantCRM,
  updateCustomerNote,
  getMerchantInventoryIntelligence,
  getMerchantFinancials,
  getMerchantBenchmark,
  getMerchantAutomations,
  saveMerchantAutomation,
  toggleMerchantAutomation,
  createMerchantCampaign,
  getMerchantCampaigns,
  getMerchantAcademy,
  updateAcademyProgress,
  generateMerchantContent,
};