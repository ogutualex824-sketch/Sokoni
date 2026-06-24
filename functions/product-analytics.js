/* ============================================================
   SOKONI Product Analytics Engine  v1.0

   Exports:
     recordProductView          onCall   — deduped, session-fingerprint filtered
     onProductPriceChanged      trigger  — tracks every price mutation
     onOrderPaidUpdateStats     trigger  — increments sold counts on payment
     aggregateProductStats      schedule — 6h daily/weekly/monthly roll-up + reset
     aggregateSellerPerformance schedule — daily seller metric aggregation
     computeProductTrending     schedule — 6h trending score engine
     getProductTrustData        onCall   — combined trust payload for frontend
     getAdminProductAnalytics   onCall   — admin dashboard data (admin only)
     cleanupProductViewDedup    schedule — daily dedup collection prune

   Collections (all new):
     productStats/{productId}
     productPriceHistory/{historyId}
     productViewDedup/{dedupKey}
     sellerPerformance/{sellerId}
============================================================ */
"use strict";

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { onDocumentUpdated }  = require("firebase-functions/v2/firestore");
const { onSchedule }         = require("firebase-functions/v2/scheduler");
const admin = require("firebase-admin");

const db  = () => admin.firestore();
const FV  = admin.firestore.FieldValue;
const TS  = admin.firestore.Timestamp;

/* ── helpers ── */
function _today() { return new Date().toISOString().slice(0, 10); }
function _msAgo(days) { return Date.now() - days * 864e5; }

function _defaultStats(productId, sellerId) {
  return {
    productId,
    sellerId:              sellerId || null,
    viewsTotal:            0,
    viewsToday:            0,
    viewsWeek:             0,
    viewsMonth:            0,
    viewsLastAt:           null,
    viewsByCity:           {},
    salesTotal:            0,
    salesThisMonth:        0,
    salesLastPurchasedAt:  null,
    priceCurrent:          0,
    pricePrevious:         null,
    priceLowest30d:        null,
    priceHighest30d:       null,
    priceLastChangedAt:    null,
    trendingScore:         0,
    trendingLabel:         null,
    trendingUpdatedAt:     null,
    updatedAt:             FV.serverTimestamp(),
    createdAt:             FV.serverTimestamp(),
  };
}

/* ════════════════════════════════════════════════════════════════
   recordProductView
   Called by frontend on product page load. Deduplicates by
   (productId + sessionFingerprint + date) with a 30-minute
   cooldown to prevent refresh inflation.
════════════════════════════════════════════════════════════════ */
exports.recordProductView = onCall(
  { maxInstances: 200, region: "us-central1" },
  async (request) => {
    const { productId, sellerId, city, sessionFp } = request.data || {};

    if (!productId || typeof productId !== "string" || productId.length > 128) {
      throw new HttpsError("invalid-argument", "productId required");
    }

    const uid     = request.auth?.uid || null;
    const rawFp   = sessionFp || uid || "anon";
    const safeFp  = rawFp.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
    const today   = _today();
    const dedupKey = `${productId.slice(0, 40)}_${safeFp}_${today}`;

    /* Check dedup — one count per session per product per day, 30-min cooldown */
    const dedupRef  = db().collection("productViewDedup").doc(dedupKey);
    const dedupSnap = await dedupRef.get();
    if (dedupSnap.exists()) {
      const lastMs = dedupSnap.data().lastAt?.toMillis() || 0;
      if (Date.now() - lastMs < 30 * 60 * 1000) return { counted: false };
    }

    const now      = FV.serverTimestamp();
    const statsRef = db().collection("productStats").doc(productId);
    const statsSnap = await statsRef.get();

    /* Atomic stats update */
    if (!statsSnap.exists()) {
      const defaults = _defaultStats(productId, sellerId);
      defaults.viewsTotal = 1; defaults.viewsToday = 1;
      defaults.viewsWeek  = 1; defaults.viewsMonth = 1;
      defaults.viewsLastAt = now;
      if (city) defaults.viewsByCity[city.slice(0, 40)] = 1;
      await statsRef.set(defaults);
    } else {
      const upd = {
        viewsTotal:   FV.increment(1),
        viewsToday:   FV.increment(1),
        viewsWeek:    FV.increment(1),
        viewsMonth:   FV.increment(1),
        viewsLastAt:  now,
        updatedAt:    now,
      };
      if (city && typeof city === "string") {
        const safeCity = city.replace(/[^a-zA-Z0-9 ]/g, "").trim().slice(0, 40);
        if (safeCity) upd[`viewsByCity.${safeCity.replace(/\s+/g, "_")}`] = FV.increment(1);
      }
      await statsRef.update(upd);
    }

    /* Also bump the legacy viewCount on the products doc (best-effort) */
    db().collection("products").doc(productId)
      .update({ viewCount: FV.increment(1) })
      .catch(() => {});

    /* Record dedup */
    await dedupRef.set({
      productId, uid: uid || null, fp: safeFp,
      date: today, lastAt: now, city: city || null,
    });

    return { counted: true };
  }
);

/* ════════════════════════════════════════════════════════════════
   onProductPriceChanged
   Fires whenever a products/{productId} document is updated.
   If the price field changes, records the event in
   productPriceHistory and refreshes the 30-day min/max in productStats.
════════════════════════════════════════════════════════════════ */
exports.onProductPriceChanged = onDocumentUpdated(
  { document: "products/{productId}", maxInstances: 50 },
  async (event) => {
    const before = event.data.before.data();
    const after  = event.data.after.data();
    if (!before || !after) return;

    const oldPrice = Number(before.price || 0);
    const newPrice = Number(after.price  || 0);
    if (oldPrice === newPrice || newPrice <= 0) return;

    const productId = event.params.productId;
    const sellerId  = after.sellerUid || after.sellerId || null;
    const now       = FV.serverTimestamp();
    const nowMs     = Date.now();

    /* Write price history entry */
    await db().collection("productPriceHistory").add({
      productId,
      sellerId,
      oldPrice,
      newPrice,
      change:    parseFloat((newPrice - oldPrice).toFixed(2)),
      changePct: oldPrice > 0
        ? Math.round(((newPrice - oldPrice) / oldPrice) * 100)
        : 0,
      changedAt: now,
      reason:    (typeof after.priceChangeReason === "string")
        ? after.priceChangeReason.slice(0, 120) : null,
    });

    /* Compute 30-day low/high from recent history */
    const since = TS.fromMillis(_msAgo(30));
    const histSnap = await db().collection("productPriceHistory")
      .where("productId", "==", productId)
      .where("changedAt", ">=", since)
      .orderBy("changedAt", "desc")
      .limit(60)
      .get();

    const allPrices = [newPrice, oldPrice];
    histSnap.forEach(d => {
      allPrices.push(Number(d.data().newPrice || 0));
      allPrices.push(Number(d.data().oldPrice || 0));
    });
    const valid = allPrices.filter(p => p > 0);

    const statsRef  = db().collection("productStats").doc(productId);
    const statsSnap = await statsRef.get();

    const priceUpdate = {
      priceCurrent:       newPrice,
      pricePrevious:      oldPrice,
      priceLowest30d:     Math.min(...valid),
      priceHighest30d:    Math.max(...valid),
      priceLastChangedAt: now,
      updatedAt:          now,
    };

    if (statsSnap.exists()) {
      await statsRef.update(priceUpdate);
    } else {
      await statsRef.set({ ..._defaultStats(productId, sellerId), ...priceUpdate });
    }
  }
);

/* ════════════════════════════════════════════════════════════════
   onOrderPaidUpdateStats
   Increments product sold counts when an order reaches a
   paid/delivered/completed status. Only counts once per order.
════════════════════════════════════════════════════════════════ */
exports.onOrderPaidUpdateStats = onDocumentUpdated(
  { document: "orders/{orderId}", maxInstances: 50 },
  async (event) => {
    const before = event.data.before.data();
    const after  = event.data.after.data();
    if (!before || !after) return;
    if (before.status === after.status) return;

    const PAID_STATUSES = ["paid", "delivered", "completed"];
    const toStatus   = after.status;
    const fromStatus = before.status;

    /* Only fire when transitioning INTO a paid state (not already there) */
    if (!PAID_STATUSES.includes(toStatus)) return;
    if (PAID_STATUSES.includes(fromStatus)) return;

    const items     = after.items || [];
    const sellerId  = after.sellerUid || after.sellerId || null;
    const now       = FV.serverTimestamp();

    const statsWrites = items
      .filter(item => item && item.productId)
      .map(item => {
        const qty      = Number(item.qty || item.quantity || 1);
        const statsRef = db().collection("productStats").doc(String(item.productId));
        return statsRef.set({
          salesTotal:           FV.increment(qty),
          salesThisMonth:       FV.increment(qty),
          salesLastPurchasedAt: now,
          sellerId:             item.sellerId || sellerId || null,
          updatedAt:            now,
        }, { merge: true });
      });

    /* Also update seller performance counters */
    const perfWrite = sellerId
      ? db().collection("sellerPerformance").doc(sellerId).set({
          sellerId,
          successfulOrders: FV.increment(1),
          totalOrders:      FV.increment(1),
          updatedAt: now,
        }, { merge: true })
      : Promise.resolve();

    await Promise.allSettled([...statsWrites, perfWrite]);
  }
);

/* ════════════════════════════════════════════════════════════════
   aggregateProductStats
   Runs every 6 hours. Resets viewsToday at midnight,
   viewsWeek on Sunday midnight, viewsMonth on 1st of month.
════════════════════════════════════════════════════════════════ */
exports.aggregateProductStats = onSchedule(
  {
    schedule:  "0 */6 * * *",
    timeZone:  "Africa/Nairobi",
    timeoutSeconds: 300,
    memory:    "512MiB",
  },
  async (_event) => {
    const now   = new Date();
    const isNewDay   = now.getHours() < 6;   // first run after midnight
    const isNewWeek  = isNewDay && now.getDay()  === 1; // Monday
    const isNewMonth = isNewDay && now.getDate() === 1;

    if (!isNewDay) {
      console.log("[aggregateProductStats] Not a reset window — skipping resets");
      return;
    }

    /* Reset viewsToday for all products with a non-zero value */
    const snap = await db().collection("productStats")
      .where("viewsToday", ">", 0)
      .limit(500)
      .get();

    const batch = db().batch();
    snap.forEach(doc => {
      const upd = { viewsToday: 0, updatedAt: FV.serverTimestamp() };
      if (isNewWeek)  upd.viewsWeek  = 0;
      if (isNewMonth) upd.viewsMonth = 0;
      if (isNewMonth) upd.salesThisMonth = 0;
      batch.update(doc.ref, upd);
    });
    await batch.commit();
    console.log(`[aggregateProductStats] Reset ${snap.size} docs — day:${isNewDay} week:${isNewWeek} month:${isNewMonth}`);
  }
);

/* ════════════════════════════════════════════════════════════════
   computeProductTrending
   Every 6 hours. Reads productStats and writes a trendingScore
   (0–100) and a human-readable label based on real signals.
   Score = views24h(0.45) + sales24h(0.40) + recency(0.15)
════════════════════════════════════════════════════════════════ */
exports.computeProductTrending = onSchedule(
  {
    schedule:  "30 */6 * * *",
    timeZone:  "Africa/Nairobi",
    timeoutSeconds: 300,
    memory:    "512MiB",
  },
  async (_event) => {
    /* Fetch top 200 products by today's views */
    const snap = await db().collection("productStats")
      .orderBy("viewsToday", "desc")
      .limit(200)
      .get();

    if (snap.empty) return;

    /* Normalise to compute relative scores */
    const rows = snap.docs.map(d => ({ ref: d.ref, ...d.data() }));
    const maxViews = Math.max(...rows.map(r => r.viewsToday || 0), 1);
    const maxSales = Math.max(...rows.map(r => r.salesThisMonth || 0), 1);

    const batch = db().batch();
    const now   = FV.serverTimestamp();
    const cutoff24h = _msAgo(1);

    for (const row of rows) {
      const viewScore  = ((row.viewsToday || 0) / maxViews) * 45;
      const salesScore = ((row.salesThisMonth || 0) / maxSales) * 40;
      const recency    = (row.viewsLastAt?.toMillis?.() || 0) > cutoff24h ? 15 : 0;
      const score      = Math.round(viewScore + salesScore + recency);

      let label = null;
      if (score >= 75) label = "Trending this week";
      else if (score >= 50) label = "Popular today";
      else if (score >= 30) label = "Gaining interest";

      /* Find top city */
      const cityMap = row.viewsByCity || {};
      const topCity = Object.entries(cityMap).sort((a, b) => b[1] - a[1])[0]?.[0];
      if (score >= 50 && topCity) {
        label = `Popular in ${topCity.replace(/_/g, " ")}`;
      }

      batch.update(row.ref, {
        trendingScore:    score,
        trendingLabel:    label,
        trendingUpdatedAt: now,
        updatedAt:        now,
      });
    }
    await batch.commit();
    console.log(`[computeProductTrending] Scored ${rows.length} products`);
  }
);

/* ════════════════════════════════════════════════════════════════
   aggregateSellerPerformance
   Daily 03:30 EAT. Reads orders from the last 90 days for each
   seller and writes aggregated metrics to sellerPerformance.
════════════════════════════════════════════════════════════════ */
exports.aggregateSellerPerformance = onSchedule(
  {
    schedule:  "30 3 * * *",
    timeZone:  "Africa/Nairobi",
    timeoutSeconds: 540,
    memory:    "1GiB",
  },
  async (_event) => {
    const since = TS.fromMillis(_msAgo(90));

    const ordSnap = await db().collection("orders")
      .where("createdAt", ">=", since)
      .orderBy("createdAt", "desc")
      .limit(5000)
      .get();

    if (ordSnap.empty) return;

    /* Group by seller */
    const map = {};
    ordSnap.forEach(doc => {
      const d  = doc.data();
      const sid = d.sellerUid || d.sellerId;
      if (!sid) return;
      if (!map[sid]) map[sid] = { total: 0, completed: 0, cancelled: 0, dispatchHours: [] };
      map[sid].total++;
      const s = d.status || "";
      if (["paid", "delivered", "completed"].includes(s)) map[sid].completed++;
      if (["cancelled", "rejected"].includes(s))          map[sid].cancelled++;
      /* Dispatch time: time between order creation and dispatch */
      if (d.dispatchedAt && d.createdAt) {
        const hrs = (d.dispatchedAt.toMillis() - d.createdAt.toMillis()) / 36e5;
        if (hrs > 0 && hrs < 336) map[sid].dispatchHours.push(hrs); // cap at 2 weeks
      }
    });

    const batch = db().batch();
    const now   = FV.serverTimestamp();

    for (const [sellerId, m] of Object.entries(map)) {
      const fulfillmentRate  = m.total > 0 ? Math.round((m.completed / m.total) * 100) : 0;
      const cancellationRate = m.total > 0 ? Math.round((m.cancelled  / m.total) * 100) : 0;
      const avgDispatch      = m.dispatchHours.length
        ? parseFloat((m.dispatchHours.reduce((a, b) => a + b, 0) / m.dispatchHours.length).toFixed(1))
        : null;

      batch.set(db().collection("sellerPerformance").doc(sellerId), {
        sellerId,
        totalOrders:       m.total,
        successfulOrders:  m.completed,
        cancelledOrders:   m.cancelled,
        fulfillmentRate,
        cancellationRate,
        avgDispatchHours:  avgDispatch,
        updatedAt: now,
      }, { merge: true });
    }
    await batch.commit();
    console.log(`[aggregateSellerPerformance] Updated ${Object.keys(map).length} sellers`);
  }
);

/* ════════════════════════════════════════════════════════════════
   getProductTrustData
   Returns a single combined payload used by the product page trust
   module. Batches all reads into one round-trip.
════════════════════════════════════════════════════════════════ */
exports.getProductTrustData = onCall(
  { maxInstances: 200, region: "us-central1" },
  async (request) => {
    const { productId, sellerId } = request.data || {};
    if (!productId || typeof productId !== "string") {
      throw new HttpsError("invalid-argument", "productId required");
    }

    const [statsSnap, histSnap, perfSnap] = await Promise.all([
      /* 1 read */ db().collection("productStats").doc(productId).get(),
      /* up to 30 reads as 1 query */ db().collection("productPriceHistory")
        .where("productId", "==", productId)
        .orderBy("changedAt", "desc")
        .limit(30)
        .get(),
      /* 1 read */ sellerId
        ? db().collection("sellerPerformance").doc(sellerId).get()
        : Promise.resolve(null),
    ]);

    /* Build stats response */
    const stats = statsSnap.exists() ? statsSnap.data() : null;
    const safeStats = stats ? {
      viewsToday:           stats.viewsToday   || 0,
      viewsWeek:            stats.viewsWeek    || 0,
      viewsMonth:           stats.viewsMonth   || 0,
      salesTotal:           stats.salesTotal   || 0,
      salesThisMonth:       stats.salesThisMonth || 0,
      salesLastPurchasedAt: stats.salesLastPurchasedAt?.toMillis?.() || null,
      trendingScore:        stats.trendingScore || 0,
      trendingLabel:        stats.trendingLabel || null,
      priceCurrent:         stats.priceCurrent  || 0,
      pricePrevious:        stats.pricePrevious  || null,
      priceLowest30d:       stats.priceLowest30d  || null,
      priceHighest30d:      stats.priceHighest30d || null,
      priceLastChangedAt:   stats.priceLastChangedAt?.toMillis?.() || null,
    } : null;

    /* Build price history response */
    const priceHistory = [];
    histSnap.forEach(doc => {
      const d = doc.data();
      priceHistory.push({
        id:        doc.id,
        oldPrice:  d.oldPrice,
        newPrice:  d.newPrice,
        changePct: d.changePct,
        changedAt: d.changedAt?.toMillis?.() || 0,
        reason:    d.reason || null,
      });
    });

    /* Build seller performance response */
    const perf = perfSnap?.exists?.() ? perfSnap.data() : null;
    const safePerf = perf ? {
      totalOrders:       perf.totalOrders       || 0,
      fulfillmentRate:   perf.fulfillmentRate    || 0,
      cancellationRate:  perf.cancellationRate   || 0,
      avgDispatchHours:  perf.avgDispatchHours   || null,
      avgRating:         perf.avgRating          || null,
      totalRatings:      perf.totalRatings       || 0,
      returnRate:        perf.returnRate         || 0,
      avgResponseMinutes: perf.avgResponseMinutes || null,
    } : null;

    return { stats: safeStats, priceHistory, sellerPerf: safePerf };
  }
);

/* ════════════════════════════════════════════════════════════════
   getAdminProductAnalytics
   Admin-only dashboard data: top viewed, fastest growing,
   highest conversion, recent price changes, regional demand.
════════════════════════════════════════════════════════════════ */
exports.getAdminProductAnalytics = onCall(
  { maxInstances: 10 },
  async (request) => {
    if (!request.auth) throw new HttpsError("unauthenticated", "Login required");
    const claims = request.auth.token || {};
    if (!claims.admin && !claims.superAdmin) {
      throw new HttpsError("permission-denied", "Admin access required");
    }

    const [topViewed, topSelling, priceChanges] = await Promise.all([
      db().collection("productStats").orderBy("viewsWeek", "desc").limit(20).get(),
      db().collection("productStats").orderBy("salesTotal", "desc").limit(20).get(),
      db().collection("productPriceHistory").orderBy("changedAt", "desc").limit(50).get(),
    ]);

    const toRow = snap => snap.docs.map(d => ({ id: d.id, ...d.data() }));

    /* Regional demand: sum viewsByCity across all products */
    const cityDemand = {};
    topViewed.docs.forEach(d => {
      const bc = d.data().viewsByCity || {};
      for (const [city, count] of Object.entries(bc)) {
        cityDemand[city] = (cityDemand[city] || 0) + count;
      }
    });

    const priceChangeRows = [];
    priceChanges.forEach(d => {
      const r = d.data();
      priceChangeRows.push({
        id:        d.id,
        productId: r.productId,
        oldPrice:  r.oldPrice,
        newPrice:  r.newPrice,
        changePct: r.changePct,
        changedAt: r.changedAt?.toMillis?.() || 0,
      });
    });

    return {
      topViewed:    toRow(topViewed),
      topSelling:   toRow(topSelling),
      priceChanges: priceChangeRows,
      regionalDemand: Object.entries(cityDemand)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 15)
        .map(([city, views]) => ({ city: city.replace(/_/g, " "), views })),
      generatedAt: Date.now(),
    };
  }
);

/* ════════════════════════════════════════════════════════════════
   cleanupProductViewDedup
   Daily 04:00 EAT. Deletes dedup documents older than 2 days.
════════════════════════════════════════════════════════════════ */
exports.cleanupProductViewDedup = onSchedule(
  {
    schedule:       "0 4 * * *",
    timeZone:       "Africa/Nairobi",
    timeoutSeconds: 300,
  },
  async (_event) => {
    const cutoff  = TS.fromMillis(_msAgo(2));
    const snap    = await db().collection("productViewDedup")
      .where("lastAt", "<", cutoff)
      .limit(500)
      .get();

    if (snap.empty) { console.log("[cleanupProductViewDedup] Nothing to delete"); return; }

    const batch = db().batch();
    snap.forEach(doc => batch.delete(doc.ref));
    await batch.commit();
    console.log(`[cleanupProductViewDedup] Deleted ${snap.size} dedup docs`);
  }
);
