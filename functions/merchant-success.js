/* ============================================================
   SOKONI Merchant Success & Growth Engine  v1.0

   Exports (11 Cloud Functions):
     getMerchantHealthScore      onCall — 12-dimension business health score
     getAICoachInsights          onCall — AI-powered growth coaching (Anthropic)
     getMerchantCRM              onCall — customer segmentation & lifetime value
     getInventoryInsights        onCall — stock health, dead stock, fast/slow movers
     getMerchantFinancials       onCall — P&L, revenue trends, peak hours
     getMerchantBenchmarks       onCall — anonymised peer comparison
     getMerchantOpportunities    onCall — revenue opportunities from existing data
     createMerchantAutomation    onCall — save automation rules
     getMerchantAutomations      onCall — list automation rules
     getMerchantAcademy          onCall — 6-module growth curriculum + progress
     completeMerchantLesson      onCall — mark lesson as complete

   Index policy: 200/200 limit reached.
     ALL queries are single-field where() or doc-ID lookups ONLY.
     No new composite indexes. JS-side filtering where multi-field
     logic is needed.
============================================================ */
"use strict";

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { getFirestore, FieldValue, Timestamp } = require("firebase-admin/firestore");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");
if (!admin.apps.length) admin.initializeApp();

const ANTHROPIC_KEY = defineSecret("ANTHROPIC_API_KEY");

/* ── Base CF options ─────────────────────────────────────── */
const CF_OPTS    = { region: "us-central1", memory: "256MiB", timeoutSeconds: 60,  cors: true };
const CF_AI_OPTS = { region: "us-central1", memory: "512MiB", timeoutSeconds: 120, cors: true, secrets: [ANTHROPIC_KEY] };

/* ── Helpers ─────────────────────────────────────────────── */
function _requireAuth(ctx) {
  if (!ctx.auth) throw new HttpsError("unauthenticated", "Login required");
}

/** Sanitise a string: strip HTML, trim, cap length */
function _san(s, max = 300) {
  if (s === null || s === undefined) return "";
  return String(s).replace(/<[^>]*>/g, "").trim().slice(0, max);
}

/** Sanitise a shopId — alphanumeric + hyphen/underscore only */
function _sanId(id) {
  if (!id) throw new HttpsError("invalid-argument", "shopId is required");
  const clean = String(id).replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 128);
  if (!clean) throw new HttpsError("invalid-argument", "Invalid shopId");
  return clean;
}

/** Verify the calling uid owns the shop */
async function _requireOwnership(db, shopId, uid) {
  const shopSnap = await db.collection("shops").doc(shopId).get();
  if (!shopSnap.exists) throw new HttpsError("not-found", "Shop not found");
  const shop = shopSnap.data();
  if (shop.sellerUid !== uid && shop.uid !== uid && shop.ownerId !== uid) {
    throw new HttpsError("permission-denied", "You do not own this shop");
  }
  return shop;
}

/** Convert a Firestore doc timestamp or JS Date to epoch ms */
function _toMs(val) {
  if (!val) return 0;
  if (typeof val.toMillis === "function") return val.toMillis();
  if (val instanceof Date) return val.getTime();
  if (typeof val === "number") return val;
  if (val._seconds) return val._seconds * 1000;
  return new Date(val).getTime() || 0;
}

/** Return midnight UTC date string YYYY-MM-DD from epoch ms */
function _dateStr(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Grade from numeric score 0-100 */
function _grade(score) {
  if (score >= 90) return "A+";
  if (score >= 80) return "A";
  if (score >= 70) return "B";
  if (score >= 60) return "C";
  if (score >= 50) return "D";
  return "F";
}

/* ═══════════════════════════════════════════════════════════
   1. getMerchantHealthScore
   12-dimension scoring; results cached 1 hour.
═══════════════════════════════════════════════════════════ */
exports.getMerchantHealthScore = onCall(CF_OPTS, async (req) => {
  _requireAuth(req);
  const uid      = req.auth.uid;
  const shopId   = _sanId(req.data?.shopId);
  const force    = Boolean(req.data?.forceRefresh);
  const db       = getFirestore();

  /* ownership check */
  const shop = await _requireOwnership(db, shopId, uid);

  /* cache check */
  if (!force) {
    const cacheSnap = await db.collection("merchantHealthScores").doc(shopId).get();
    if (cacheSnap.exists) {
      const cached = cacheSnap.data();
      const age    = Date.now() - _toMs(cached.cachedAt);
      if (age < 3600 * 1000) return cached;
    }
  }

  /* ── Fetch raw data ──────────────────────────────────────── */
  const [productsSnap, ordersSnap, subsSnap, configSnap] = await Promise.all([
    db.collection("products").where("shopId", "==", shopId).limit(200).get(),
    db.collection("orders").where("shopId",  "==", shopId).limit(200).get(),
    db.collection("subscriptions").where("uid", "==", uid).limit(1).get(),
    db.collection("minishopConfig").doc(shopId).get(),
  ]);

  const products  = productsSnap.docs.map(d => d.data());
  const orders    = ordersSnap.docs.map(d => d.data());
  const config    = configSnap.exists ? configSnap.data() : {};

  /* ── Dimension 1 — Profile Completeness (20 pts) ──────── */
  let profileScore = 0;
  if (config.logoUrl  || shop.logoUrl)            profileScore += 3;
  if (config.coverUrl || shop.coverUrl)            profileScore += 3;
  const desc = _san(config.description || shop.description || "", 10000);
  if (desc.length > 50)                            profileScore += 4;
  if (config.businessHours || shop.businessHours)  profileScore += 3;
  if (config.phone || shop.phone || shop.contactPhone) profileScore += 3;
  const socials = config.socialLinks || shop.socialLinks || {};
  if (Object.keys(socials).some(k => socials[k]))  profileScore += 2;
  if (config.deliveryAreas || shop.deliveryAreas)  profileScore += 2;

  /* ── Dimension 2 — Product Quality (20 pts) ─────────────── */
  let productScore = 0;
  if (products.length >= 5) productScore += 5;

  const withImage = products.filter(p =>
    (Array.isArray(p.images) && p.images.length > 0) || p.image
  ).length;
  const withDesc  = products.filter(p => (_san(p.description || "", 10000).length > 30)).length;

  if (products.length > 0) {
    if (withImage / products.length >= 0.7) productScore += 5;
    if (withDesc  / products.length >= 0.7) productScore += 5;
  }
  const validPriced = products.filter(p => parseFloat(p.price) > 0).length;
  if (products.length > 0 && validPriced / products.length >= 0.9) productScore += 5;

  /* ── Dimension 3 — Customer Rating (15 pts) ─────────────── */
  let ratingScore = 0;
  const rating    = parseFloat(shop.rating || shop.averageRating || 0);
  if      (rating >= 4.5) ratingScore = 15;
  else if (rating >= 4.0) ratingScore = 12;
  else if (rating >= 3.5) ratingScore = 8;
  else if (rating >= 3.0) ratingScore = 4;

  /* ── Dimension 4 — Response Time (10 pts) ───────────────── */
  let responseScore = 3; /* default */
  const rt = _san(shop.responseTime || config.responseTime || "");
  if      (rt.includes("1 hour")  || rt.includes("1hr"))  responseScore = 10;
  else if (rt.includes("4 hour")  || rt.includes("4hr"))  responseScore = 8;
  else if (rt.includes("24 hour") || rt.includes("24hr")) responseScore = 5;

  /* ── Dimensions 5 & 6 — Order Completion & Cancellation ─── */
  const now30     = Date.now() - 30 * 864e5;
  const now60     = Date.now() - 60 * 864e5;

  const completed   = orders.filter(o => ["completed", "delivered", "paid"].includes(o.status));
  const cancelled   = orders.filter(o => o.status === "cancelled");
  const total       = orders.length;

  const completionRate   = total > 0 ? completed.length / total : 1;
  const cancellationRate = total > 0 ? cancelled.length / total : 0;

  let orderCompletion   = 4;
  if      (completionRate >= 0.95) orderCompletion = 15;
  else if (completionRate >= 0.90) orderCompletion = 12;
  else if (completionRate >= 0.80) orderCompletion = 8;

  let cancellationScore = 1;
  if      (cancellationRate <= 0.02) cancellationScore = 5;
  else if (cancellationRate <= 0.05) cancellationScore = 3;

  /* ── Dimension 7 — Sales Growth (5 pts) ─────────────────── */
  const recentOrders = orders.filter(o => _toMs(o.createdAt) > now30);
  const prevOrders   = orders.filter(o => {
    const t = _toMs(o.createdAt);
    return t > now60 && t <= now30;
  });
  let salesGrowthScore = 1;
  if (prevOrders.length === 0 && recentOrders.length > 0) {
    salesGrowthScore = 5; /* new shop with sales */
  } else if (prevOrders.length > 0) {
    const ratio = recentOrders.length / prevOrders.length;
    if      (ratio >= 1.1) salesGrowthScore = 5;
    else if (ratio >= 0.9) salesGrowthScore = 3;
  }

  /* ── Dimension 8 — Subscription Status (5 pts) ──────────── */
  let subScore = 0;
  if (!subsSnap.empty) {
    const sub = subsSnap.docs[0].data();
    if (sub.status === "active" || sub.status === "trialing") subScore = 5;
  }

  /* ── Dimension 9 — Inventory Health (5 pts) ─────────────── */
  const inStock    = products.filter(p => (parseInt(p.quantity) || 0) > 0).length;
  const invRatio   = products.length > 0 ? inStock / products.length : 1;
  let inventoryScore = 1;
  if      (invRatio >= 0.8) inventoryScore = 5;
  else if (invRatio >= 0.6) inventoryScore = 3;

  /* ── Total ───────────────────────────────────────────────── */
  const totalScore = Math.min(100, Math.round(
    profileScore + productScore + ratingScore + responseScore +
    orderCompletion + cancellationScore + salesGrowthScore +
    subScore + inventoryScore
  ));

  /* ── Dimensions manifest ─────────────────────────────────── */
  const dimensions = [
    { name: "Profile Completeness", score: profileScore,    max: 20, status: profileScore    >= 15 ? "good" : profileScore    >= 10 ? "fair" : "poor" },
    { name: "Product Quality",      score: productScore,    max: 20, status: productScore    >= 15 ? "good" : productScore    >= 10 ? "fair" : "poor" },
    { name: "Customer Rating",      score: ratingScore,     max: 15, status: ratingScore     >= 12 ? "good" : ratingScore     >= 8  ? "fair" : "poor" },
    { name: "Response Time",        score: responseScore,   max: 10, status: responseScore   >= 8  ? "good" : responseScore   >= 5  ? "fair" : "poor" },
    { name: "Order Completion",     score: orderCompletion, max: 15, status: orderCompletion >= 12 ? "good" : orderCompletion >= 8  ? "fair" : "poor" },
    { name: "Cancellation Rate",    score: cancellationScore,max: 5, status: cancellationScore >= 5 ? "good" : cancellationScore >= 3 ? "fair" : "poor" },
    { name: "Sales Growth",         score: salesGrowthScore, max: 5, status: salesGrowthScore >= 5 ? "good" : salesGrowthScore >= 3 ? "fair" : "poor" },
    { name: "Subscription Status",  score: subScore,        max: 5,  status: subScore        >= 5  ? "good" : "poor" },
    { name: "Inventory Health",     score: inventoryScore,  max: 5,  status: inventoryScore  >= 5  ? "good" : inventoryScore  >= 3  ? "fair" : "poor" },
  ];

  /* ── Recommendations ─────────────────────────────────────── */
  const recommendations = [];
  if (profileScore    < 15) recommendations.push("Add your business logo and cover photo to increase buyer trust");
  if (profileScore    < 10) recommendations.push("Complete your business profile: add hours, contact number and social links");
  if (productScore    < 15) recommendations.push("Add descriptions and images to at least 70% of your products");
  if (productScore    < 10) recommendations.push("List at least 5 products to unlock full product quality score");
  if (ratingScore     < 12) recommendations.push("Respond to customer reviews promptly to improve your rating");
  if (responseScore   < 8)  recommendations.push("Set a faster response time in your shop settings to attract more customers");
  if (orderCompletion < 12) recommendations.push("Work to fulfil more orders — cancellations hurt your search ranking");
  if (salesGrowthScore < 3) recommendations.push("Try a flash sale or WhatsApp promotion to boost this month's sales");
  if (subScore        < 5)  recommendations.push("Upgrade your subscription to unlock premium placement and features");
  if (inventoryScore  < 3)  recommendations.push("Keep your inventory updated — out-of-stock products miss sales opportunities");

  const result = {
    shopId,
    score:           totalScore,
    grade:           _grade(totalScore),
    dimensions,
    recommendations: recommendations.slice(0, 5),
    stats: {
      totalProducts:  products.length,
      totalOrders:    total,
      completionRate: Math.round(completionRate  * 100),
      cancellationPct: Math.round(cancellationRate * 100),
      rating,
      recentOrders30d: recentOrders.length,
    },
    cachedAt: Timestamp.now(),
  };

  /* write to cache */
  try {
    await db.collection("merchantHealthScores").doc(shopId).set(result, { merge: false });
  } catch (_) { /* non-blocking */ }

  return result;
});

/* ═══════════════════════════════════════════════════════════
   2. getAICoachInsights
   Anthropic claude-haiku-4-5 coaching insights — 5 per call,
   rate-limited to 5 calls per uid per day.
═══════════════════════════════════════════════════════════ */
exports.getAICoachInsights = onCall(CF_AI_OPTS, async (req) => {
  _requireAuth(req);
  const uid    = req.auth.uid;
  const shopId = _sanId(req.data?.shopId);
  const db     = getFirestore();

  const shop = await _requireOwnership(db, shopId, uid);

  /* rate limit — 5 per day per uid */
  const today  = _dateStr(Date.now());
  const rlKey  = `${uid}_${today}`;
  const rlRef  = db.collection("aiCoachRL").doc(rlKey);

  await db.runTransaction(async (tx) => {
    const rlSnap = await tx.get(rlRef);
    const count  = rlSnap.exists ? (rlSnap.data().count || 0) : 0;
    if (count >= 5) {
      throw new HttpsError("resource-exhausted", "AI coach limit: 5 requests per day. Try again tomorrow.");
    }
    tx.set(rlRef, { count: count + 1, uid, updatedAt: Timestamp.now() }, { merge: true });
  });

  /* gather context */
  const [productsSnap, ordersSnap, healthSnap] = await Promise.all([
    db.collection("products").where("shopId", "==", shopId).limit(100).get(),
    db.collection("orders").where("shopId",   "==", shopId).limit(200).get(),
    db.collection("merchantHealthScores").doc(shopId).get(),
  ]);

  const products       = productsSnap.docs.map(d => d.data());
  const orders         = ordersSnap.docs.map(d => d.data());
  const now30          = Date.now() - 30 * 864e5;
  const recentOrders   = orders.filter(o => _toMs(o.createdAt) > now30);
  const healthData     = healthSnap.exists ? healthSnap.data() : null;
  const healthScore    = healthData?.score ?? "unknown";
  const recommendations = (healthData?.recommendations || []).join("; ") || "None identified";

  /* top 5 products by name */
  const topProducts = products.slice(0, 5).map(p =>
    `${_san(p.name || p.title || "Untitled", 60)} (KES ${parseFloat(p.price || 0).toLocaleString()})`
  ).join(", ");

  const prompt = `You are a business growth coach for SOKONI, Kenya's leading digital marketplace.

Business: ${_san(shop.name || shop.shopName || "Unknown Shop", 100)}
Category: ${_san(shop.category || "General", 60)}
Location: ${_san(shop.location || shop.town || "Kenya", 80)}
Health Score: ${healthScore}/100
Rating: ${parseFloat(shop.rating || 0).toFixed(1)}/5 (${parseInt(shop.reviewCount || 0)} reviews)
Products Listed: ${products.length}
Orders in last 30 days: ${recentOrders.length}
Top Products: ${topProducts || "None listed yet"}
Key Issues: ${recommendations}

Provide 5 specific, actionable business growth recommendations for this Kenyan merchant.
Focus on: increasing sales, improving customer satisfaction, and growing their customer base.
Consider local Kenyan market context (M-Pesa payments, WhatsApp marketing, local delivery networks, mobile-first customers).

Respond ONLY with valid JSON in this exact format — no markdown fences, no extra text:
{"insights":[{"title":"...","description":"...","priority":"high|medium|low","category":"sales|marketing|operations|products|customers"}]}`;

  let insights;
  try {
    const Anthropic = require("@anthropic-ai/sdk");
    const client    = new Anthropic({ apiKey: ANTHROPIC_KEY.value() });
    const msg = await client.messages.create({
      model:      "claude-haiku-4-5-20251001",
      max_tokens: 800,
      messages:   [{ role: "user", content: prompt }],
    });
    const raw  = (msg.content?.[0]?.text || "").trim();
    const parsed = JSON.parse(raw);
    insights = Array.isArray(parsed.insights) ? parsed.insights : [];
  } catch (err) {
    console.error(JSON.stringify({ severity: "ERROR", message: "AI coach parse error", shopId, err: err.message }));
    /* graceful fallback */
    insights = [
      { title: "Complete your product listings",    description: "Add high-quality photos and detailed descriptions to every product to increase buyer confidence.", priority: "high",   category: "products"   },
      { title: "Respond faster to customers",       description: "Aim to reply within 1 hour. Buyers in Kenya often choose the first responsive seller.",            priority: "high",   category: "customers"  },
      { title: "Use WhatsApp for marketing",        description: "Share your SOKONI MiniShop link on WhatsApp groups and status — it's free and highly effective.",  priority: "medium", category: "marketing"  },
      { title: "Accept M-Pesa payments clearly",    description: "Make sure your till number or Paybill is visible. M-Pesa is the preferred payment method.",        priority: "medium", category: "operations" },
      { title: "Run a weekly flash sale",           description: "Discount 2–3 slow-moving items by 15–20% each week to generate orders and reviews.",              priority: "low",    category: "sales"      },
    ];
  }

  return { insights: insights.slice(0, 5), generatedAt: Date.now(), shopId };
});

/* ═══════════════════════════════════════════════════════════
   3. getMerchantCRM
   Customer segments derived from order history.
═══════════════════════════════════════════════════════════ */
exports.getMerchantCRM = onCall(CF_OPTS, async (req) => {
  _requireAuth(req);
  const uid     = req.auth.uid;
  const shopId  = _sanId(req.data?.shopId);
  const page    = Math.max(0, parseInt(req.data?.page || 0));
  const segment = _san(req.data?.segment || "all", 30);
  const db      = getFirestore();

  await _requireOwnership(db, shopId, uid);

  const ordersSnap = await db.collection("orders").where("shopId", "==", shopId).limit(500).get();
  const orders     = ordersSnap.docs.map(d => ({ id: d.id, ...d.data() }));

  const now        = Date.now();
  const now30      = now - 30 * 864e5;
  const now60      = now - 60 * 864e5;

  /* group by customer */
  const customerMap = {};
  for (const o of orders) {
    const cid = _san(o.customerId || o.buyerUid || o.userId || "", 128);
    if (!cid) continue;

    if (!customerMap[cid]) {
      customerMap[cid] = {
        customerId:   cid,
        name:         _san(o.buyerName || o.customerName || "Unknown", 100),
        phone:        null, /* never log PII in server logs */
        orderCount:   0,
        totalSpent:   0,
        lastOrderDate: 0,
        firstOrderDate: Infinity,
        products:     {},
      };
    }

    const c   = customerMap[cid];
    const amt = parseFloat(o.amount || o.total || 0);
    const ts  = _toMs(o.createdAt);

    c.orderCount++;
    c.totalSpent     += amt;
    if (ts > c.lastOrderDate)  c.lastOrderDate  = ts;
    if (ts < c.firstOrderDate) c.firstOrderDate = ts;

    /* track favourite products */
    const items = Array.isArray(o.items) ? o.items : (o.productId ? [{ name: o.productName || o.productId }] : []);
    for (const item of items) {
      const pname = _san(item.name || item.productId || "", 80);
      if (pname) c.products[pname] = (c.products[pname] || 0) + 1;
    }
  }

  /* build customer array with segments */
  let customers = Object.values(customerMap).map(c => {
    const lastOrder  = c.lastOrderDate;
    const firstOrder = c.firstOrderDate === Infinity ? now : c.firstOrderDate;
    const aov        = c.orderCount > 0 ? Math.round(c.totalSpent / c.orderCount) : 0;

    let seg;
    if      (c.orderCount >= 5)                                      seg = "loyal";
    else if (c.orderCount >= 2)                                      seg = "regular";
    else if (c.orderCount === 1 && firstOrder > now30)               seg = "new";
    else if (lastOrder > now60 && lastOrder <= now30)                 seg = "at_risk";
    else                                                              seg = "inactive";

    /* top 3 favourite products */
    const favouriteProducts = Object.entries(c.products)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([name]) => name);

    return {
      customerId:         c.customerId,
      name:               c.name,
      orderCount:         c.orderCount,
      totalSpent:         Math.round(c.totalSpent),
      lastOrderDate:      lastOrder,
      firstOrderDate:     firstOrder,
      averageOrderValue:  aov,
      favouriteProducts,
      segment:            seg,
    };
  });

  /* apply segment filter */
  if (segment !== "all") {
    customers = customers.filter(c => c.segment === segment);
  }

  customers.sort((a, b) => b.totalSpent - a.totalSpent);

  /* stats */
  const all    = Object.values(customerMap);
  const loyal    = all.filter(c => c.orderCount >= 5).length;
  const regular  = all.filter(c => c.orderCount >= 2 && c.orderCount < 5).length;
  const newC     = all.filter(c => c.orderCount === 1 && (c.firstOrderDate === Infinity ? now : c.firstOrderDate) > now30).length;
  const atRisk   = all.filter(c => c.lastOrderDate > now60 && c.lastOrderDate <= now30).length;
  const inactive = all.filter(c => c.lastOrderDate <= now60 && c.lastOrderDate > 0).length;
  const totalRev = all.reduce((s, c) => s + c.totalSpent, 0);
  const avgLTV   = all.length > 0 ? Math.round(totalRev / all.length) : 0;

  /* paginate */
  const PAGE_SIZE = 20;
  const start     = page * PAGE_SIZE;
  const paginated = customers.slice(start, start + PAGE_SIZE);

  return {
    customers: paginated,
    stats:     { total: customers.length, loyal, regular, new: newC, atRisk, inactive, totalRevenue: Math.round(totalRev), avgLifetimeValue: avgLTV },
    page,
    totalPages: Math.ceil(customers.length / PAGE_SIZE),
  };
});

/* ═══════════════════════════════════════════════════════════
   4. getInventoryInsights
   Stock health, dead stock, fast/slow movers.
═══════════════════════════════════════════════════════════ */
exports.getInventoryInsights = onCall(CF_OPTS, async (req) => {
  _requireAuth(req);
  const uid    = req.auth.uid;
  const shopId = _sanId(req.data?.shopId);
  const db     = getFirestore();

  await _requireOwnership(db, shopId, uid);

  const productsSnap = await db.collection("products").where("shopId", "==", shopId).limit(200).get();
  const products     = productsSnap.docs.map(d => ({ id: d.id, ...d.data() }));

  const now90  = Date.now() - 90 * 864e5;
  const alerts = [];

  const enriched = products.map(p => {
    const qty        = parseInt(p.quantity || p.stock || 0);
    const salesCount = parseInt(p.salesCount || p.sold || 0);
    const viewCount  = parseInt(p.viewCount  || p.views || 0);
    const lastSoldMs = _toMs(p.lastSoldAt || p.lastOrderAt);

    let status;
    if (qty === 0) {
      status = "out_of_stock";
    } else if (qty > 0 && qty <= 5) {
      status = "low_stock";
    } else if (qty > 100) {
      status = "overstock";
    } else if (salesCount > 20 || p.isBestseller === true) {
      status = "fast_seller";
    } else if (qty > 10 && salesCount < 2) {
      status = "slow_mover";
    } else if (qty > 0 && (lastSoldMs < now90 || viewCount < 5)) {
      status = "dead_stock";
    } else {
      status = "healthy";
    }

    /* days of stock estimate */
    const dailySalesRate = salesCount > 0 ? salesCount / 90 : 0;
    const daysOfStock    = dailySalesRate > 0 ? Math.round(qty / dailySalesRate) : (qty > 0 ? 999 : 0);

    /* generate alert */
    const name = _san(p.name || p.title || "Untitled", 80);
    if (status === "out_of_stock") {
      alerts.push({ productId: p.id, name, issue: "Out of stock", recommendation: "Restock immediately — buyers cannot order this item", urgency: "high" });
    } else if (status === "low_stock") {
      alerts.push({ productId: p.id, name, issue: `Low stock (${qty} left)`, recommendation: "Reorder soon to avoid stockouts", urgency: qty <= 2 ? "high" : "medium" });
    } else if (status === "dead_stock") {
      alerts.push({ productId: p.id, name, issue: "Dead stock — no recent sales or views", recommendation: "Consider a discount, bundle deal, or move to clearance to recover margin", urgency: "medium" });
    } else if (status === "overstock") {
      alerts.push({ productId: p.id, name, issue: `Overstock (${qty} units)`, recommendation: "Run a promotion or offer bulk-buy discounts to clear excess inventory", urgency: "low" });
    } else if (status === "slow_mover") {
      alerts.push({ productId: p.id, name, issue: "Slow mover — high stock, low sales", recommendation: "Improve listing photos/description, or lower price to stimulate demand", urgency: "low" });
    }

    return {
      id:          p.id,
      name,
      quantity:    qty,
      price:       parseFloat(p.price || 0),
      salesCount,
      viewCount,
      status,
      daysOfStock: daysOfStock > 998 ? null : daysOfStock,
      image:       Array.isArray(p.images) ? p.images[0] : (p.image || null),
    };
  });

  const summary = {
    total:       enriched.length,
    outOfStock:  enriched.filter(p => p.status === "out_of_stock").length,
    lowStock:    enriched.filter(p => p.status === "low_stock").length,
    deadStock:   enriched.filter(p => p.status === "dead_stock").length,
    overstock:   enriched.filter(p => p.status === "overstock").length,
    fastSellers: enriched.filter(p => p.status === "fast_seller").length,
    slowMovers:  enriched.filter(p => p.status === "slow_mover").length,
    healthy:     enriched.filter(p => p.status === "healthy").length,
  };

  /* sort: highest urgency first */
  const urgencyOrder = { high: 0, medium: 1, low: 2 };
  alerts.sort((a, b) => (urgencyOrder[a.urgency] || 2) - (urgencyOrder[b.urgency] || 2));

  return { summary, alerts: alerts.slice(0, 50), products: enriched };
});

/* ═══════════════════════════════════════════════════════════
   5. getMerchantFinancials
   Revenue, order metrics, peak hours, retention.
═══════════════════════════════════════════════════════════ */
exports.getMerchantFinancials = onCall(CF_OPTS, async (req) => {
  _requireAuth(req);
  const uid    = req.auth.uid;
  const shopId = _sanId(req.data?.shopId);
  const db     = getFirestore();

  await _requireOwnership(db, shopId, uid);

  const periodMap = { "7d": 7, "30d": 30, "90d": 90, "365d": 365 };
  const period    = periodMap[req.data?.period] ? req.data.period : "30d";
  const days      = periodMap[period];
  const cutoff    = Date.now() - days * 864e5;

  const ordersSnap = await db.collection("orders").where("shopId", "==", shopId).limit(1000).get();
  const allOrders  = ordersSnap.docs.map(d => d.data());
  const orders     = allOrders.filter(o => _toMs(o.createdAt) >= cutoff);

  const refunded  = orders.filter(o => o.status === "refunded");
  const cancelled = orders.filter(o => o.status === "cancelled");
  const valid     = orders.filter(o => !["refunded", "cancelled"].includes(o.status));

  const revenue    = valid.reduce((s, o) => s + parseFloat(o.amount || o.total || 0), 0);
  const refundAmt  = refunded.reduce((s, o) => s + parseFloat(o.amount || o.total || 0), 0);
  const netRevenue = revenue - refundAmt;

  /* top products by revenue */
  const productRev = {};
  for (const o of valid) {
    const items = Array.isArray(o.items) ? o.items
      : (o.productId ? [{ productId: o.productId, name: o.productName || o.productId, price: o.amount, qty: 1 }] : []);
    for (const item of items) {
      const pid  = _san(item.productId || item.name || "unknown", 100);
      const pamt = parseFloat(item.price || 0) * (parseInt(item.qty || item.quantity || 1));
      if (!productRev[pid]) productRev[pid] = { name: _san(item.name || pid, 80), revenue: 0, units: 0 };
      productRev[pid].revenue += pamt;
      productRev[pid].units   += parseInt(item.qty || item.quantity || 1);
    }
  }
  const topProducts = Object.entries(productRev)
    .map(([id, v]) => ({ id, ...v, revenue: Math.round(v.revenue) }))
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 5);

  /* daily revenue */
  const dailyRevenue = {};
  for (const o of valid) {
    const d   = _dateStr(_toMs(o.createdAt));
    const amt = parseFloat(o.amount || o.total || 0);
    dailyRevenue[d] = (dailyRevenue[d] || 0) + amt;
  }

  /* peak hours */
  const peakHours = {};
  for (const o of orders) {
    const hr = new Date(_toMs(o.createdAt)).getUTCHours();
    peakHours[hr] = (peakHours[hr] || 0) + 1;
  }

  /* customer retention */
  const customerCounts = {};
  for (const o of allOrders) {
    const cid = _san(o.customerId || o.buyerUid || "", 128);
    if (cid) customerCounts[cid] = (customerCounts[cid] || 0) + 1;
  }
  const uniqueAllTime  = Object.keys(customerCounts).length;
  const repeatCustomers = Object.values(customerCounts).filter(c => c > 1).length;
  const retentionRate  = uniqueAllTime > 0 ? Math.round((repeatCustomers / uniqueAllTime) * 100) : 0;
  const totalRevAllTime = allOrders.reduce((s, o) => s + parseFloat(o.amount || o.total || 0), 0);
  const clv = uniqueAllTime > 0 ? Math.round(totalRevAllTime / uniqueAllTime) : 0;

  return {
    period,
    orderCount:          orders.length,
    revenue:             Math.round(revenue),
    refundAmount:        Math.round(refundAmt),
    netRevenue:          Math.round(netRevenue),
    averageOrderValue:   orders.length > 0 ? Math.round(revenue / orders.length) : 0,
    refundCount:         refunded.length,
    cancellationCount:   cancelled.length,
    topProducts,
    dailyRevenue,
    peakHours,
    customerRetentionRate: retentionRate,
    customerLifetimeValue: clv,
    uniqueCustomers:     uniqueAllTime,
  };
});

/* ═══════════════════════════════════════════════════════════
   6. getMerchantBenchmarks
   Anonymised peer comparison using cached health scores.
═══════════════════════════════════════════════════════════ */
exports.getMerchantBenchmarks = onCall(CF_OPTS, async (req) => {
  _requireAuth(req);
  const uid    = req.auth.uid;
  const shopId = _sanId(req.data?.shopId);
  const db     = getFirestore();

  /* ownership check */
  const shop = await _requireOwnership(db, shopId, uid);

  /* caller's own health score */
  const [myScoreSnap, allScoresSnap] = await Promise.all([
    db.collection("merchantHealthScores").doc(shopId).get(),
    db.collection("merchantHealthScores").limit(1000).get(),
  ]);

  const myData     = myScoreSnap.exists ? myScoreSnap.data() : null;
  const myScore    = myData?.score ?? 0;
  const myCategory = _san(shop.category || "General", 80);

  /* extract peer scores in same category */
  const allScores  = allScoresSnap.docs.map(d => d.data());
  const peers      = allScores.filter(s => {
    /* we stored shopId in the doc but not category — use a broad comparison */
    return s.shopId !== shopId; /* exclude self; category filter done below */
  });

  /* try to narrow by category if most peers have category stored */
  const withCategory = peers.filter(s => s.category);
  const categoryPeers = withCategory.length > 0
    ? withCategory.filter(s => _san(s.category || "", 80).toLowerCase() === myCategory.toLowerCase())
    : peers;

  const peerScores = (categoryPeers.length >= 3 ? categoryPeers : peers).map(s => s.score || 0);

  const avgScore = peerScores.length > 0
    ? Math.round(peerScores.reduce((a, b) => a + b, 0) / peerScores.length)
    : 0;

  const sorted        = [...peerScores].sort((a, b) => a - b);
  const medianScore   = sorted.length > 0 ? sorted[Math.floor(sorted.length / 2)] : 0;
  const topQuartile   = sorted.length > 0 ? sorted[Math.floor(sorted.length * 0.75)] : 0;

  /* percentile rank */
  const below = peerScores.filter(s => s < myScore).length;
  const percentile = peerScores.length > 0 ? Math.round((below / peerScores.length) * 100) : 50;

  /* gaps */
  const gaps = [];
  if (myScore < avgScore) {
    gaps.push({ metric: "Health Score", merchantValue: myScore, benchmarkValue: avgScore, gap: avgScore - myScore, recommendation: `Your score is ${avgScore - myScore} points below the category average. Focus on the lowest-scoring dimensions.` });
  }
  const myRating   = parseFloat(shop.rating || 0);
  const avgRating  = 4.2; /* platform default if not available */
  if (myRating > 0 && myRating < avgRating) {
    gaps.push({ metric: "Rating", merchantValue: myRating, benchmarkValue: avgRating, gap: +(avgRating - myRating).toFixed(1), recommendation: "Deliver excellent service and follow up with buyers to improve your rating" });
  }

  return {
    merchant:  { shopId, score: myScore, rating: myRating, category: myCategory },
    benchmark: { avgScore, medianScore, topQuartileScore: topQuartile, peerCount: peerScores.length },
    percentile,
    gaps,
  };
});

/* ═══════════════════════════════════════════════════════════
   7. getMerchantOpportunities
   Revenue opportunities from existing data patterns.
═══════════════════════════════════════════════════════════ */
exports.getMerchantOpportunities = onCall(CF_OPTS, async (req) => {
  _requireAuth(req);
  const uid    = req.auth.uid;
  const shopId = _sanId(req.data?.shopId);
  const db     = getFirestore();

  await _requireOwnership(db, shopId, uid);

  const [productsSnap, ordersSnap] = await Promise.all([
    db.collection("products").where("shopId", "==", shopId).limit(200).get(),
    db.collection("orders").where("shopId",   "==", shopId).limit(300).get(),
  ]);

  const products = productsSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  const orders   = ordersSnap.docs.map(d => d.data());

  const now    = Date.now();
  const now7   = now - 7  * 864e5;
  const now30  = now - 30 * 864e5;
  const now45  = now - 45 * 864e5;

  const opportunities = [];

  /* 1. Critical low-stock on selling products */
  const criticalStock = products.filter(p => {
    const qty   = parseInt(p.quantity || p.stock || 0);
    const sales = parseInt(p.salesCount || 0);
    return qty > 0 && qty <= 3 && sales > 0;
  });
  if (criticalStock.length > 0) {
    const names = criticalStock.slice(0, 3).map(p => _san(p.name || p.title || "product", 50)).join(", ");
    const potentialRevenue = criticalStock.reduce((s, p) => s + parseFloat(p.price || 0) * parseInt(p.quantity || 0), 0);
    opportunities.push({
      type:             "low_stock",
      title:            `${criticalStock.length} top-selling product${criticalStock.length > 1 ? "s" : ""} nearly sold out`,
      description:      `${names} — reorder now to avoid lost sales and disappointed customers.`,
      action:           "restock",
      urgency:          "high",
      potentialRevenue: Math.round(potentialRevenue),
    });
  }

  /* 2. Returning customers this week */
  const recentCustomers = {};
  const prevCustomers   = {};
  for (const o of orders) {
    const cid = _san(o.customerId || o.buyerUid || "", 128);
    const ts  = _toMs(o.createdAt);
    if (!cid) continue;
    if (ts > now7)          recentCustomers[cid] = true;
    else if (ts > now30)    prevCustomers[cid]   = true;
  }
  const returning = Object.keys(recentCustomers).filter(c => prevCustomers[c]).length;
  if (returning > 0) {
    opportunities.push({
      type:        "returning_customers",
      title:       `${returning} customers returned this week`,
      description: "These loyal buyers are ready to purchase again. Send them a personalised thank-you via WhatsApp or offer a loyalty discount.",
      action:      "engage_loyalty",
      urgency:     "medium",
    });
  }

  /* 3. Inactive customers — win-back */
  const customerLastOrder = {};
  for (const o of orders) {
    const cid = _san(o.customerId || o.buyerUid || "", 128);
    const ts  = _toMs(o.createdAt);
    if (cid && ts > (customerLastOrder[cid] || 0)) customerLastOrder[cid] = ts;
  }
  const inactiveCount = Object.values(customerLastOrder).filter(t => t > 0 && t < now45).length;
  if (inactiveCount > 0) {
    opportunities.push({
      type:        "inactive_customers",
      title:       `${inactiveCount} customer${inactiveCount > 1 ? "s" : ""} haven't ordered in 45+ days`,
      description: "A win-back message with a 10–15% discount can re-activate lapsed buyers at low cost.",
      action:      "send_winback",
      urgency:     "medium",
    });
  }

  /* 4. Products with no discount but slow movement */
  const slowUndiscounted = products.filter(p => {
    const qty        = parseInt(p.quantity || 0);
    const sales      = parseInt(p.salesCount || 0);
    const hasDiscount = parseFloat(p.discountPrice || p.salePrice || 0) > 0 || p.onSale === true;
    return qty > 5 && sales < 2 && !hasDiscount;
  });
  if (slowUndiscounted.length > 0) {
    const sample = slowUndiscounted.slice(0, 2).map(p => _san(p.name || p.title || "product", 50)).join(", ");
    opportunities.push({
      type:        "pricing_opportunity",
      title:       `${slowUndiscounted.length} products with no discount and low sales`,
      description: `${sample} — consider a flash sale (10–20% off) to generate first orders and reviews.`,
      action:      "create_promotion",
      urgency:     "low",
    });
  }

  /* 5. Upsell — out of stock products that had demand */
  const outOfStockWithSales = products.filter(p =>
    parseInt(p.quantity || 0) === 0 && parseInt(p.salesCount || 0) > 0
  );
  if (outOfStockWithSales.length > 0) {
    const revRecovery = outOfStockWithSales.reduce((s, p) => s + parseFloat(p.price || 0), 0);
    opportunities.push({
      type:             "restock_demand",
      title:            `${outOfStockWithSales.length} previously popular item${outOfStockWithSales.length > 1 ? "s" : ""} out of stock`,
      description:      "These products had real buyer demand. Restocking them could recover lost revenue immediately.",
      action:           "restock",
      urgency:          "high",
      potentialRevenue: Math.round(revRecovery),
    });
  }

  /* sort by urgency */
  const urgencyOrder = { high: 0, medium: 1, low: 2 };
  opportunities.sort((a, b) => (urgencyOrder[a.urgency] || 2) - (urgencyOrder[b.urgency] || 2));

  return { opportunities, generatedAt: Date.now(), shopId };
});

/* ═══════════════════════════════════════════════════════════
   8. createMerchantAutomation
   Save an automation rule for a shop.
═══════════════════════════════════════════════════════════ */
const VALID_AUTOMATION_TYPES = new Set([
  "low_stock_alert", "review_request", "win_back",
  "birthday_offer",  "reorder_reminder", "flash_sale", "appointment_reminder",
]);

exports.createMerchantAutomation = onCall(CF_OPTS, async (req) => {
  _requireAuth(req);
  const uid    = req.auth.uid;
  const shopId = _sanId(req.data?.shopId);
  const type   = _san(req.data?.type || "", 60);
  const db     = getFirestore();

  if (!VALID_AUTOMATION_TYPES.has(type)) {
    throw new HttpsError("invalid-argument", `Invalid automation type. Allowed: ${[...VALID_AUTOMATION_TYPES].join(", ")}`);
  }

  await _requireOwnership(db, shopId, uid);

  const rawConfig = req.data?.config || {};
  if (typeof rawConfig !== "object" || Array.isArray(rawConfig)) {
    throw new HttpsError("invalid-argument", "config must be an object");
  }

  /* validate per type */
  const config = { active: Boolean(rawConfig.active !== false) };

  if (type === "low_stock_alert") {
    config.threshold = Math.max(1, Math.min(100, parseInt(rawConfig.threshold || 5)));
  } else if (type === "review_request") {
    config.delayHours = Math.max(1, Math.min(168, parseInt(rawConfig.delayHours || 24)));
    config.message    = _san(rawConfig.message || "Thank you for your order! Please leave a review.", 500);
  } else if (type === "win_back") {
    config.daysInactive = Math.max(7, Math.min(180, parseInt(rawConfig.daysInactive || 45)));
    config.discount     = Math.max(0, Math.min(50, parseInt(rawConfig.discount || 10)));
    config.message      = _san(rawConfig.message || "We miss you! Here's a special discount just for you.", 500);
  } else if (type === "birthday_offer") {
    config.discount = Math.max(0, Math.min(50, parseInt(rawConfig.discount || 15)));
    config.message  = _san(rawConfig.message || "Happy Birthday! Enjoy a special gift from us.", 500);
  } else if (type === "reorder_reminder") {
    config.delayHours = Math.max(24, Math.min(8760, parseInt(rawConfig.delayHours || 720)));
    config.message    = _san(rawConfig.message || "Time to restock? Your favourite items are waiting.", 500);
  } else if (type === "flash_sale") {
    config.discount    = Math.max(1, Math.min(80, parseInt(rawConfig.discount || 20)));
    config.durationHrs = Math.max(1, Math.min(72, parseInt(rawConfig.durationHrs || 24)));
    config.message     = _san(rawConfig.message || "Flash Sale! Limited time offer.", 500);
  } else if (type === "appointment_reminder") {
    config.delayHours = Math.max(1, Math.min(72, parseInt(rawConfig.delayHours || 24)));
    config.message    = _san(rawConfig.message || "Reminder: your appointment is coming up soon.", 500);
  }

  const automationId = `${shopId}_${type}`;
  const automation   = {
    automationId,
    shopId,
    uid,
    type,
    config,
    createdAt:  Timestamp.now(),
    updatedAt:  Timestamp.now(),
  };

  await db.collection("merchantAutomations").doc(automationId).set(automation, { merge: false });

  return { success: true, automationId, automation };
});

/* ═══════════════════════════════════════════════════════════
   9. getMerchantAutomations
   List all automation rules for a shop.
═══════════════════════════════════════════════════════════ */
exports.getMerchantAutomations = onCall(CF_OPTS, async (req) => {
  _requireAuth(req);
  const uid    = req.auth.uid;
  const shopId = _sanId(req.data?.shopId);
  const db     = getFirestore();

  await _requireOwnership(db, shopId, uid);

  const snap = await db.collection("merchantAutomations")
    .where("shopId", "==", shopId)
    .limit(20)
    .get();

  const automations = snap.docs.map(d => d.data());
  return { automations, shopId };
});

/* ═══════════════════════════════════════════════════════════
   10. getMerchantAcademy
   6-module growth curriculum + user progress.
   Static content only — no Firestore reads for curriculum.
═══════════════════════════════════════════════════════════ */
const ACADEMY_CURRICULUM = [
  {
    moduleId: "module_1",
    title:    "Getting Started",
    icon:     "🏪",
    description: "Set up your shop for success from day one.",
    lessons: [
      { lessonId: "m1_l1", title: "Setting up your SOKONI shop",   duration: "5 min",  description: "Complete your shop profile, add your logo, and set your trading hours." },
      { lessonId: "m1_l2", title: "Claiming your custom handle",   duration: "3 min",  description: "Secure your unique MiniShop URL (e.g. sokoni.co.ke/@yourshop)." },
      { lessonId: "m1_l3", title: "Adding your first 5 products",  duration: "10 min", description: "Step-by-step guide to listing products with photos, prices, and stock." },
      { lessonId: "m1_l4", title: "Completing your seller profile", duration: "5 min", description: "Add your business story, contact details, and delivery areas." },
    ],
  },
  {
    moduleId: "module_2",
    title:    "Product Listings",
    icon:     "📦",
    description: "Create listings that attract buyers and drive sales.",
    lessons: [
      { lessonId: "m2_l1", title: "Product photography tips for mobile", duration: "8 min",  description: "Take great product photos with any smartphone — lighting, angles, and backgrounds." },
      { lessonId: "m2_l2", title: "Writing descriptions that sell",      duration: "7 min",  description: "Use the AIDA formula to write compelling product descriptions buyers trust." },
      { lessonId: "m2_l3", title: "Pricing strategy for the Kenyan market", duration: "6 min", description: "How to price competitively, use anchoring, and plan markdowns." },
      { lessonId: "m2_l4", title: "Categories and tags",                duration: "4 min",  description: "Get found in search by choosing the right category and relevant keywords." },
    ],
  },
  {
    moduleId: "module_3",
    title:    "Customer Service",
    icon:     "🤝",
    description: "Build trust, earn loyalty, and turn buyers into fans.",
    lessons: [
      { lessonId: "m3_l1", title: "Setting and meeting response-time expectations", duration: "5 min",  description: "Why a fast reply wins the sale — and how to manage your inbox efficiently." },
      { lessonId: "m3_l2", title: "Handling complaints and returns",                duration: "8 min",  description: "Turn unhappy buyers into loyal customers with a professional complaints process." },
      { lessonId: "m3_l3", title: "Building buyer trust on SOKONI",                duration: "6 min",  description: "Verified badges, consistent branding, and transparent policies." },
      { lessonId: "m3_l4", title: "Getting and responding to reviews",              duration: "5 min",  description: "How to encourage honest reviews and reply professionally to all feedback." },
    ],
  },
  {
    moduleId: "module_4",
    title:    "Marketing & Promotions",
    icon:     "📣",
    description: "Reach more buyers without spending a fortune.",
    lessons: [
      { lessonId: "m4_l1", title: "WhatsApp marketing for Kenyan sellers", duration: "10 min", description: "Use WhatsApp Status, groups, and broadcast lists to promote for free." },
      { lessonId: "m4_l2", title: "Sharing your MiniShop link effectively", duration: "5 min", description: "Where and how to share your SOKONI shop link for maximum reach." },
      { lessonId: "m4_l3", title: "Creating coupons and discount codes",    duration: "6 min", description: "Set up time-limited promotions that create urgency and drive orders." },
      { lessonId: "m4_l4", title: "Running a successful flash sale",        duration: "7 min", description: "Plan, announce, execute, and follow up on a flash sale for maximum impact." },
    ],
  },
  {
    moduleId: "module_5",
    title:    "Inventory Management",
    icon:     "📊",
    description: "Never run out of stock — and never over-invest in slow movers.",
    lessons: [
      { lessonId: "m5_l1", title: "Tracking stock in SOKONI",            duration: "5 min",  description: "Use the inventory dashboard to monitor stock levels across all products." },
      { lessonId: "m5_l2", title: "Identifying fast and slow movers",    duration: "6 min",  description: "Use your sales data to spot winners and cut dead stock early." },
      { lessonId: "m5_l3", title: "Setting reorder points",              duration: "4 min",  description: "Calculate your minimum stock level and never miss a sale." },
      { lessonId: "m5_l4", title: "Clearing dead stock profitably",      duration: "7 min",  description: "Bundle deals, clearance sales, and trade-ins — strategies to recover margin." },
    ],
  },
  {
    moduleId: "module_6",
    title:    "Growing Your Business",
    icon:     "🚀",
    description: "Scale sustainably with data, loyalty, and referrals.",
    lessons: [
      { lessonId: "m6_l1", title: "Setting up a loyalty programme",      duration: "7 min",  description: "Reward repeat buyers with points, discounts, or early access to new stock." },
      { lessonId: "m6_l2", title: "Referral marketing on SOKONI",        duration: "5 min",  description: "How the SOKONI referral system works and how to maximise it." },
      { lessonId: "m6_l3", title: "Reading your analytics dashboard",    duration: "8 min",  description: "Understand your revenue trends, peak hours, and customer lifetime value." },
      { lessonId: "m6_l4", title: "Scaling from 1 shop to a brand",      duration: "10 min", description: "Multi-product strategy, supplier relationships, and building a team." },
    ],
  },
];

exports.getMerchantAcademy = onCall(CF_OPTS, async (req) => {
  _requireAuth(req);
  const uid    = req.auth.uid;
  const shopId = _sanId(req.data?.shopId);
  const db     = getFirestore();

  /* ownership check (light) */
  await _requireOwnership(db, shopId, uid);

  /* fetch progress from Firestore — single doc lookup */
  const progressSnap = await db.collection("merchantAcademyProgress").doc(shopId).get();
  const progressData  = progressSnap.exists ? progressSnap.data() : {};
  const completed     = Array.isArray(progressData.completedLessons) ? progressData.completedLessons : [];
  const completedSet  = new Set(completed);

  const totalLessons    = ACADEMY_CURRICULUM.reduce((s, m) => s + m.lessons.length, 0);
  const completedCount  = completed.filter(lid => {
    return ACADEMY_CURRICULUM.some(m => m.lessons.some(l => l.lessonId === lid));
  }).length;

  /* enrich curriculum with completion status */
  const modules = ACADEMY_CURRICULUM.map(mod => ({
    ...mod,
    completed:   mod.lessons.every(l => completedSet.has(l.lessonId)),
    completedCount: mod.lessons.filter(l => completedSet.has(l.lessonId)).length,
    lessons: mod.lessons.map(l => ({
      ...l,
      completed: completedSet.has(l.lessonId),
    })),
  }));

  return {
    modules,
    progress: {
      completed:        completedCount,
      total:            totalLessons,
      percentage:       Math.round((completedCount / totalLessons) * 100),
      completedLessons: completed,
      lastAccessedAt:   _toMs(progressData.lastAccessedAt) || null,
    },
    shopId,
  };
});

/* ═══════════════════════════════════════════════════════════
   11. completeMerchantLesson
   Mark a lesson as complete; idempotent.
═══════════════════════════════════════════════════════════ */

/** Set of valid lesson IDs derived from curriculum */
const ALL_LESSON_IDS = new Set(
  ACADEMY_CURRICULUM.flatMap(m => m.lessons.map(l => l.lessonId))
);

exports.completeMerchantLesson = onCall(CF_OPTS, async (req) => {
  _requireAuth(req);
  const uid      = req.auth.uid;
  const shopId   = _sanId(req.data?.shopId);
  const lessonId = _san(req.data?.lessonId || "", 60);
  const db       = getFirestore();

  if (!ALL_LESSON_IDS.has(lessonId)) {
    throw new HttpsError("invalid-argument", "Invalid lessonId");
  }

  await _requireOwnership(db, shopId, uid);

  const ref = db.collection("merchantAcademyProgress").doc(shopId);

  await ref.set({
    shopId,
    uid,
    completedLessons: FieldValue.arrayUnion(lessonId),
    lastAccessedAt:   Timestamp.now(),
  }, { merge: true });

  return { success: true, lessonId, shopId };
});
