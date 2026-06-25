"use strict";
/* ═══════════════════════════════════════════════════════════════════
   functions/business-metrics.js
   Executive KPI and order trend data for the business dashboard.

   Exports:
     getBusinessMetrics — admin callable — GMV, orders, buyers, sellers, AOV
     getOrderTrends     — admin callable — daily order counts for last N days
     getSecuritySummary — admin callable — 24h security event counts
═══════════════════════════════════════════════════════════════════ */

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { getFirestore, Timestamp } = require("firebase-admin/firestore");

function requireAdmin(request) {
  if (!request.auth?.token?.isAdmin && !request.auth?.token?.isSuperAdmin) {
    throw new HttpsError("permission-denied", "Admin access required");
  }
}

function periodToMs(period) {
  switch (period) {
    case "daily":     return 86400000;
    case "weekly":    return 7  * 86400000;
    case "monthly":   return 30 * 86400000;
    case "quarterly": return 90 * 86400000;
    case "yearly":    return 365 * 86400000;
    default:          return 30 * 86400000;
  }
}

/* ── getBusinessMetrics ──────────────────────────────────────────── */
exports.getBusinessMetrics = onCall(
  { maxInstances: 10, timeoutSeconds: 30 },
  async (request) => {
    requireAdmin(request);

    const { period = "monthly" } = request.data || {};
    const db       = getFirestore();
    const since    = new Date(Date.now() - periodToMs(period));
    const sinceTs  = Timestamp.fromDate(since);

    /* Three parallel queries — one per terminal status to avoid
       Firestore "in" + range filter limitation */
    const [paidSnap, deliveredSnap, completedSnap, totalOrdersSnap] = await Promise.allSettled([
      db.collection("orders")
        .where("status", "==", "paid")
        .where("createdAt", ">=", sinceTs)
        .select("amount", "buyerUid", "sellerUid", "category")
        .limit(500).get(),
      db.collection("orders")
        .where("status", "==", "delivered")
        .where("createdAt", ">=", sinceTs)
        .select("amount", "buyerUid", "sellerUid", "category")
        .limit(500).get(),
      db.collection("orders")
        .where("status", "==", "completed")
        .where("createdAt", ">=", sinceTs)
        .select("amount", "buyerUid", "sellerUid", "category")
        .limit(500).get(),
      db.collection("orders")
        .where("createdAt", ">=", sinceTs)
        .count().get(),
    ]);

    const docs = [
      ...(paidSnap.status      === "fulfilled" ? paidSnap.value.docs      : []),
      ...(deliveredSnap.status === "fulfilled" ? deliveredSnap.value.docs  : []),
      ...(completedSnap.status === "fulfilled" ? completedSnap.value.docs  : []),
    ];

    let gmv = 0;
    const buyers     = new Set();
    const sellers    = new Set();
    const categories = {};

    docs.forEach(d => {
      const v = d.data();
      gmv += (v.amount || 0);
      if (v.buyerUid)  buyers.add(v.buyerUid);
      if (v.sellerUid) sellers.add(v.sellerUid);
      if (v.category)  categories[v.category] = (categories[v.category] || 0) + 1;
    });

    const orderCount = docs.length;
    const topCategories = Object.entries(categories)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([name, count]) => ({ name, count }));

    const totalOrders = totalOrdersSnap.status === "fulfilled"
      ? totalOrdersSnap.value.data().count
      : orderCount;

    return {
      period,
      since:             since.toISOString(),
      gmv:               Math.round(gmv * 100) / 100,
      orderCount,
      totalOrders,
      activeBuyers:      buyers.size,
      activeSellers:     sellers.size,
      averageOrderValue: orderCount > 0 ? Math.round((gmv / orderCount) * 100) / 100 : 0,
      topCategories,
      currency:          "KES",
      generatedAt:       new Date().toISOString(),
    };
  }
);

/* ── getOrderTrends ──────────────────────────────────────────────── */
exports.getOrderTrends = onCall(
  { maxInstances: 5, timeoutSeconds: 30 },
  async (request) => {
    requireAdmin(request);

    const { days = 30 } = request.data || {};
    const safeDays = Math.min(Math.max(Number(days) || 30, 7), 90);
    const db       = getFirestore();
    const since    = new Date(Date.now() - safeDays * 86400000);
    const sinceTs  = Timestamp.fromDate(since);

    const snap = await db.collection("orders")
      .where("createdAt", ">=", sinceTs)
      .select("createdAt", "amount", "status")
      .limit(2000)
      .get();

    const byDay = {};
    snap.docs.forEach(d => {
      const v    = d.data();
      const date = v.createdAt?.toDate();
      if (!date) return;
      const key  = date.toISOString().split("T")[0];
      if (!byDay[key]) byDay[key] = { orders: 0, gmv: 0, failed: 0 };
      byDay[key].orders++;
      if (["paid", "delivered", "completed"].includes(v.status)) {
        byDay[key].gmv += (v.amount || 0);
      }
      if (v.status === "payment_failed") byDay[key].failed++;
    });

    const trends = [];
    for (let i = safeDays - 1; i >= 0; i--) {
      const d   = new Date(Date.now() - i * 86400000);
      const key = d.toISOString().split("T")[0];
      trends.push({ date: key, ...(byDay[key] || { orders: 0, gmv: 0, failed: 0 }) });
    }

    return { days: safeDays, trends, generatedAt: new Date().toISOString() };
  }
);

/* ── getSecuritySummary ──────────────────────────────────────────── */
exports.getSecuritySummary = onCall(
  { maxInstances: 5 },
  async (request) => {
    requireAdmin(request);

    const db      = getFirestore();
    const since24 = Timestamp.fromMillis(Date.now() - 86400000);
    const since7d = Timestamp.fromMillis(Date.now() - 7 * 86400000);

    const [
      csp24Snap,
      failedPay24Snap,
      openBugsSnap,
      csp7dSnap,
    ] = await Promise.allSettled([
      db.collection("cspViolations")
        .where("timestamp", ">=", since24).count().get(),
      db.collection("orders")
        .where("status", "==", "payment_failed")
        .where("createdAt", ">=", since24).count().get(),
      db.collection("feedback")
        .where("type", "==", "bug")
        .where("status", "==", "new").count().get(),
      db.collection("cspViolations")
        .where("timestamp", ">=", since7d).count().get(),
    ]);

    const safe = s => s.status === "fulfilled" ? s.value.data().count : null;

    return {
      cspViolations24h:   safe(csp24Snap),
      cspViolations7d:    safe(csp7dSnap),
      failedPayments24h:  safe(failedPay24Snap),
      openBugReports:     safe(openBugsSnap),
      period:             "24h",
      generatedAt:        new Date().toISOString(),
    };
  }
);
