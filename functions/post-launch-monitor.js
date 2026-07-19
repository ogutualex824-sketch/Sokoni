"use strict";
/* ═══════════════════════════════════════════════════════════════════════════
   functions/post-launch-monitor.js
   SOKONI Post-Launch Monitoring Suite v1.0

   Executive-grade observability layer designed for the critical post-launch
   window. Tracks orders, revenue, registrations, payment health, and errors
   in real time; detects statistical anomalies; generates daily executive
   summaries automatically every morning at 07:00 EAT.

   Exports:
     getPostLaunchDashboard       — admin onCall — period dashboard snapshot
     detectAnomalies              — admin onCall — current vs 7-day baseline
     generateExecutiveSummary     — admin onCall — full daily summary for date
     getExecutiveSummaries        — admin onCall — last N summaries
     scheduledHourlyMonitor       — onSchedule every 1 hour
     scheduledDailyExecutiveSummary — onSchedule 07:00 EAT (yesterday's summary)

   Collections written:
     hourlyMetrics/{YYYY-MM-DD-HH}
     executiveSummaries/{YYYY-MM-DD}
     platformAlerts (add docs)

   Collections read:
     orders, users, errorLog, payments, userSessions,
     posBISnapshots (top products/sellers — optional, graceful fallback),
     systemHealthHistory (uptime — optional, graceful fallback)
═══════════════════════════════════════════════════════════════════════════ */

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { onSchedule }         = require("firebase-functions/v2/scheduler");
const admin                  = require("firebase-admin");

/* ─── Shared Firestore accessor ──────────────────────────────────────────── */
const db = () => admin.firestore();
const serverTimestamp = () => admin.firestore.FieldValue.serverTimestamp();

/* ─── Constants ──────────────────────────────────────────────────────────── */
const REGION          = "us-central1";
const ANOMALY_THRESHOLD_PCT = 30;   // flag when deviation exceeds ±30 %
const REVENUE_FETCH_LIMIT   = 5000; // max docs fetched for revenue sum

/* ═══════════════════════════════════════════════════════════════════════════
   HELPERS
═══════════════════════════════════════════════════════════════════════════ */

/**
 * _requireAdmin — throws HttpsError if caller is not an admin.
 * @param {object} auth  request.auth from an onCall handler
 */
function _requireAdmin(auth) {
  if (!auth) {
    throw new HttpsError("unauthenticated", "Authentication required.");
  }
  const t = auth.token || {};
  const isAdmin =
    t.admin === true ||
    t.isAdmin === true ||
    t.isSuperAdmin === true ||
    t.role === "admin" ||
    t.role === "super_admin";
  if (!isAdmin) {
    throw new HttpsError("permission-denied", "Admin access required.");
  }
}

/**
 * _getPeriodBounds — returns Firestore Timestamp bounds for the named period.
 * @param {'hour'|'day'|'week'|'month'} period
 * @returns {{ start: admin.firestore.Timestamp, end: admin.firestore.Timestamp }}
 */
function _getPeriodBounds(period) {
  const now = Date.now();
  const MS = {
    hour:  60 * 60 * 1000,
    day:   24 * 60 * 60 * 1000,
    week:  7  * 24 * 60 * 60 * 1000,
    month: 30 * 24 * 60 * 60 * 1000,
  };
  const durationMs = MS[period] || MS.day;
  return {
    start: admin.firestore.Timestamp.fromMillis(now - durationMs),
    end:   admin.firestore.Timestamp.fromMillis(now),
  };
}

/**
 * _sumRevenue — sums the `total` field across a QuerySnapshot's docs.
 * Skips docs where total is missing or not a number.
 * @param {admin.firestore.QuerySnapshot} snap
 * @returns {number}
 */
function _sumRevenue(snap) {
  return snap.docs.reduce((acc, doc) => {
    const val = doc.data().total;
    return acc + (typeof val === "number" ? val : 0);
  }, 0);
}

/**
 * _formatKES — formats a number as a KES string with thousands separators.
 * Example: 1234567.5 → "KES 1,234,567.50"
 * @param {number} n
 * @returns {string}
 */
function _formatKES(n) {
  if (typeof n !== "number" || isNaN(n)) return "KES 0.00";
  return "KES " + n.toLocaleString("en-KE", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/**
 * _safeCount — counts documents matching a query; returns null on error.
 */
async function _safeCount(query) {
  try {
    const snap = await query.count().get();
    return snap.data().count;
  } catch (_e) {
    return null;
  }
}

/**
 * _todayEAT — returns today's date string (YYYY-MM-DD) in Africa/Nairobi time.
 */
function _todayEAT() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Africa/Nairobi" });
}

/**
 * _yesterdayEAT — returns yesterday's date string (YYYY-MM-DD) in EAT.
 */
function _yesterdayEAT() {
  const d = new Date(Date.now() - 24 * 60 * 60 * 1000);
  return d.toLocaleDateString("en-CA", { timeZone: "Africa/Nairobi" });
}

/**
 * _dateBounds — returns { start, end } Firestore Timestamps for a YYYY-MM-DD date string
 * covering the full calendar day in UTC midnight-to-midnight.
 */
function _dateBounds(dateStr) {
  const start = new Date(`${dateStr}T00:00:00.000Z`);
  const end   = new Date(`${dateStr}T23:59:59.999Z`);
  return {
    start: admin.firestore.Timestamp.fromDate(start),
    end:   admin.firestore.Timestamp.fromDate(end),
  };
}

/**
 * _currentHourBounds — Timestamp bounds for the current clock hour (UTC).
 */
function _currentHourBounds() {
  const now = new Date();
  const start = new Date(now);
  start.setUTCMinutes(0, 0, 0);
  const end = new Date(now);
  end.setUTCMinutes(59, 59, 999);
  return {
    start: admin.firestore.Timestamp.fromDate(start),
    end:   admin.firestore.Timestamp.fromDate(end),
  };
}

/**
 * _hourLabel — returns a document-safe hour label e.g. "2026-06-28-14".
 */
function _hourLabel(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}-${pad(date.getUTCHours())}`;
}

/* ─── Core metric computation ─────────────────────────────────────────────
   _computeMetricsForBounds — shared across the dashboard, anomaly detector,
   hourly scheduler, and executive summary generator.
   Returns raw numbers; formatting is left to the caller.
────────────────────────────────────────────────────────────────────────── */
async function _computeMetricsForBounds(start, end) {
  const firestore = db();

  /* Parallel queries — counts first, then revenue fetch */
  const [
    ordersCountSnap,
    completedCountSnap,
    failedPaymentSnap,
    totalPaymentsSnap,
    newUsersSnap,
    errorsSnap,
    activeSessionsSnap,
  ] = await Promise.allSettled([
    /* All orders in period */
    firestore.collection("orders")
      .where("createdAt", ">=", start)
      .where("createdAt", "<=", end)
      .count().get(),

    /* Completed orders in period (revenue source) */
    firestore.collection("orders")
      .where("status", "==", "completed")
      .where("createdAt", ">=", start)
      .where("createdAt", "<=", end)
      .count().get(),

    /* Payment failures */
    firestore.collection("orders")
      .where("status", "==", "payment_failed")
      .where("createdAt", ">=", start)
      .where("createdAt", "<=", end)
      .count().get(),

    /* Total payment attempts (all orders) — reused for failure rate */
    firestore.collection("orders")
      .where("createdAt", ">=", start)
      .where("createdAt", "<=", end)
      .count().get(),

    /* New user registrations */
    firestore.collection("users")
      .where("createdAt", ">=", start)
      .where("createdAt", "<=", end)
      .count().get(),

    /* Top errors from errorLog */
    firestore.collection("errorLog")
      .where("timestamp", ">=", start)
      .where("timestamp", "<=", end)
      .orderBy("timestamp", "desc")
      .limit(100)
      .get(),

    /* Active sessions in the period. Was lastSeen, which session-manager.js has
       never written — the heartbeat field is lastActive, so this always read 0. */
    firestore.collection("userSessions")
      .where("lastActive", ">=", start)
      .where("lastActive", "<=", end)
      .count().get(),
  ]);

  /* Unwrap settled promises — null for failed queries */
  const safe = (settled) =>
    settled.status === "fulfilled" ? settled.value : null;

  const ordersCount        = safe(ordersCountSnap)?.data().count        ?? null;
  const completedCount     = safe(completedCountSnap)?.data().count      ?? null;
  const failedPaymentCount = safe(failedPaymentSnap)?.data().count       ?? null;
  const totalPayments      = safe(totalPaymentsSnap)?.data().count        ?? null;
  const newUsers           = safe(newUsersSnap)?.data().count             ?? null;
  const activeSessions     = safe(activeSessionsSnap)?.data().count       ?? null;
  const errorSnap          = safe(errorsSnap);

  /* Payment failure rate (0–100 %) */
  let paymentFailRate = null;
  if (totalPayments !== null && totalPayments > 0 && failedPaymentCount !== null) {
    paymentFailRate = Math.round((failedPaymentCount / totalPayments) * 10000) / 100;
  } else if (totalPayments === 0) {
    paymentFailRate = 0;
  }

  /* Revenue — fetch completed-order docs (max REVENUE_FETCH_LIMIT) */
  let revenue = null;
  try {
    const revSnap = await firestore.collection("orders")
      .where("status", "==", "completed")
      .where("createdAt", ">=", start)
      .where("createdAt", "<=", end)
      .select("total")
      .limit(REVENUE_FETCH_LIMIT)
      .get();
    revenue = _sumRevenue(revSnap);
  } catch (_e) {
    revenue = null;
  }

  /* Top errors — aggregate by message/type */
  const topErrors = [];
  if (errorSnap && !errorSnap.empty) {
    const errorMap = {};
    errorSnap.docs.forEach((d) => {
      const data = d.data();
      const key  = String(data.message || data.error || data.type || "unknown").slice(0, 120);
      if (!errorMap[key]) {
        errorMap[key] = {
          message:   key,
          count:     0,
          severity:  data.severity || data.level || "error",
          firstSeen: data.timestamp,
          lastSeen:  data.timestamp,
        };
      }
      errorMap[key].count++;
      if (data.timestamp > errorMap[key].lastSeen) {
        errorMap[key].lastSeen = data.timestamp;
      }
    });
    Object.values(errorMap)
      .sort((a, b) => b.count - a.count)
      .slice(0, 10)
      .forEach((e) => topErrors.push(e));
  }

  return {
    ordersCount,
    completedCount,
    revenue,
    newUsers,
    paymentFailRate,
    failedPaymentCount,
    totalPayments,
    topErrors,
    activeSessions,
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
   CF 1: getPostLaunchDashboard
   Admin onCall — aggregated period dashboard.
═══════════════════════════════════════════════════════════════════════════ */
exports.getPostLaunchDashboard = onCall(
  {
    enforceAppCheck: true,
    region:          REGION,
    maxInstances:    10,
    timeoutSeconds:  60,
  },
  async (request) => {
    _requireAdmin(request.auth);

    const VALID_PERIODS = ["hour", "day", "week", "month"];
    const period = VALID_PERIODS.includes(request.data?.period)
      ? request.data.period
      : "day";

    const { start, end } = _getPeriodBounds(period);

    const metrics = await _computeMetricsForBounds(start, end);

    return {
      period,
      orders:          metrics.ordersCount,
      revenue:         metrics.revenue,
      revenueFormatted: _formatKES(metrics.revenue ?? 0),
      newUsers:        metrics.newUsers,
      paymentFailRate: metrics.paymentFailRate,
      topErrors:       metrics.topErrors,
      activeSessions:  metrics.activeSessions,
      generatedAt:     new Date().toISOString(),
    };
  }
);

/* ═══════════════════════════════════════════════════════════════════════════
   CF 2: detectAnomalies
   Admin onCall — current hour vs 7-day hourly average, flags >30 % deviation.
═══════════════════════════════════════════════════════════════════════════ */
exports.detectAnomalies = onCall(
  {
    enforceAppCheck: true,
    region:          REGION,
    maxInstances:    10,
    timeoutSeconds:  120,
  },
  async (request) => {
    _requireAdmin(request.auth);

    const firestore = db();

    /* Current hour bounds */
    const { start: hourStart, end: hourEnd } = _currentHourBounds();

    /* 7-day window for baseline — same hour-of-day across last 7 days */
    const currentHour    = new Date().getUTCHours();
    const sevenDaysAgoMs = Date.now() - 7 * 24 * 60 * 60 * 1000;

    /* Fetch last 7 hourly metric docs that match the same hour label suffix */
    /* Strategy: read last 168 hourlyMetrics docs, filter by hour */
    let baseline = null;
    try {
      const since7d = admin.firestore.Timestamp.fromMillis(sevenDaysAgoMs);
      const historicalSnap = await firestore.collection("hourlyMetrics")
        .where("hourUTC", "==", currentHour)
        .where("recordedAt", ">=", since7d)
        .orderBy("recordedAt", "desc")
        .limit(7)
        .get();

      if (!historicalSnap.empty) {
        const docs   = historicalSnap.docs.map((d) => d.data());
        const avg    = (key) => {
          const vals = docs.map((d) => d[key]).filter((v) => typeof v === "number");
          return vals.length > 0 ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
        };
        baseline = {
          orders:          avg("orders"),
          revenue:         avg("revenue"),
          newUsers:        avg("newUsers"),
          paymentFailRate: avg("paymentFailRate"),
          errors:          avg("errorCount"),
          activeSessions:  avg("activeSessions"),
        };
      }
    } catch (_e) {
      /* Baseline unavailable — first day of operation, skip anomaly detection */
    }

    /* Current hour metrics */
    const current = await _computeMetricsForBounds(hourStart, hourEnd);
    const currentMap = {
      orders:          current.ordersCount,
      revenue:         current.revenue,
      newUsers:        current.newUsers,
      paymentFailRate: current.paymentFailRate,
      errors:          current.topErrors.reduce((s, e) => s + (e.count || 1), 0),
      activeSessions:  current.activeSessions,
    };

    /* Compute anomalies */
    const anomalies = [];

    if (baseline) {
      for (const [metric, currentVal] of Object.entries(currentMap)) {
        const baseVal = baseline[metric];
        if (baseVal === null || baseVal === undefined || currentVal === null) continue;
        if (baseVal === 0 && currentVal === 0) continue;

        let deviationPct;
        if (baseVal === 0) {
          /* Anything above zero when baseline is 0 is notable */
          deviationPct = currentVal > 0 ? 100 : 0;
        } else {
          deviationPct = Math.round(((currentVal - baseVal) / Math.abs(baseVal)) * 10000) / 100;
        }

        if (Math.abs(deviationPct) > ANOMALY_THRESHOLD_PCT) {
          /* paymentFailRate and errors increasing is bad; others decreasing is bad */
          const isNegativeMetric = metric === "paymentFailRate" || metric === "errors";
          const direction        = deviationPct > 0 ? "up" : "down";
          const isConcerning     = isNegativeMetric ? direction === "up" : direction === "down";

          anomalies.push({
            metric,
            current:      currentVal,
            baseline:     Math.round(baseVal * 100) / 100,
            deviationPct,
            direction,
            severity:     Math.abs(deviationPct) >= 75
              ? (isConcerning ? "critical" : "notable")
              : (isConcerning ? "warning"  : "info"),
          });
        }
      }
    }

    /* Sort by absolute deviation descending */
    anomalies.sort((a, b) => Math.abs(b.deviationPct) - Math.abs(a.deviationPct));

    return {
      anomalies,
      baselineAvailable: baseline !== null,
      currentHourUTC:    currentHour,
      checkedAt:         new Date().toISOString(),
    };
  }
);

/* ═══════════════════════════════════════════════════════════════════════════
   CF 3: generateExecutiveSummary
   Admin onCall — full executive summary for a given date (default: today).
   Stores result in executiveSummaries/{YYYY-MM-DD}.
═══════════════════════════════════════════════════════════════════════════ */
exports.generateExecutiveSummary = onCall(
  {
    enforceAppCheck: true,
    region:          REGION,
    maxInstances:    5,
    timeoutSeconds:  120,
  },
  async (request) => {
    _requireAdmin(request.auth);

    const firestore = db();

    /* Resolve target date */
    let targetDate = request.data?.date;
    if (typeof targetDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(targetDate)) {
      targetDate = _todayEAT();
    }

    const { start, end } = _dateBounds(targetDate);

    /* Core metrics */
    const metrics = await _computeMetricsForBounds(start, end);

    /* Top sellers — from posBISnapshots (optional) */
    let topSellers = [];
    try {
      const sellersSnap = await firestore.collection("posBISnapshots")
        .where("date", "==", targetDate)
        .orderBy("revenue", "desc")
        .limit(10)
        .get();
      topSellers = sellersSnap.docs.map((d) => {
        const v = d.data();
        return {
          sellerId:  v.sellerId || d.id,
          branchId:  v.branchId || null,
          revenue:   v.revenue  || 0,
          transactions: v.transactions || 0,
        };
      });
    } catch (_e) {
      /* posBISnapshots not yet populated — graceful fallback */
    }

    /* Top products by order count for the day */
    let topProducts = [];
    try {
      const productsSnap = await firestore.collection("orders")
        .where("createdAt", ">=", start)
        .where("createdAt", "<=", end)
        .select("productId", "productName", "total", "status")
        .limit(2000)
        .get();
      const productMap = {};
      productsSnap.docs.forEach((d) => {
        const v = d.data();
        if (!v.productId) return;
        if (!productMap[v.productId]) {
          productMap[v.productId] = {
            productId:   v.productId,
            productName: v.productName || v.productId,
            orderCount:  0,
            revenue:     0,
          };
        }
        productMap[v.productId].orderCount++;
        if (v.status === "completed" && typeof v.total === "number") {
          productMap[v.productId].revenue += v.total;
        }
      });
      topProducts = Object.values(productMap)
        .sort((a, b) => b.orderCount - a.orderCount)
        .slice(0, 10);
    } catch (_e) {
      /* Non-fatal — orders may not have productId in early launch */
    }

    /* Payment summary */
    const paymentSummary = {
      totalOrders:        metrics.ordersCount,
      completedOrders:    metrics.completedCount,
      failedOrders:       metrics.failedPaymentCount,
      failureRatePct:     metrics.paymentFailRate,
      totalRevenue:       metrics.revenue,
      totalRevenueFormatted: _formatKES(metrics.revenue ?? 0),
    };

    /* Error count */
    const errorCount = metrics.topErrors.reduce((s, e) => s + (e.count || 1), 0);

    /* Platform uptime — read latest systemHealthHistory entry for the day */
    let platformUptime = null;
    try {
      const healthSnap = await firestore.collection("systemHealthHistory")
        .where("recordedAt", ">=", start)
        .where("recordedAt", "<=", end)
        .orderBy("recordedAt", "asc")
        .limit(500)
        .get();
      if (!healthSnap.empty) {
        const healthDocs = healthSnap.docs.map((d) => d.data());
        const healthy    = healthDocs.filter((d) => d.status === "healthy" || d.status === "ok").length;
        platformUptime   = Math.round((healthy / healthDocs.length) * 10000) / 100;
      }
    } catch (_e) {
      /* systemHealthHistory not available */
    }

    /* Assemble the executive summary document */
    const summary = {
      date:            targetDate,
      generatedAt:     new Date().toISOString(),
      generatedBy:     request.auth?.uid || "system",
      /* Core KPIs */
      orders:          metrics.ordersCount,
      revenue:         metrics.revenue,
      revenueFormatted: _formatKES(metrics.revenue ?? 0),
      newUsers:        metrics.newUsers,
      activeSessions:  metrics.activeSessions,
      /* Payment health */
      paymentSummary,
      /* Engagement */
      topSellers,
      topProducts,
      /* Error & reliability */
      errorCount,
      topErrors:       metrics.topErrors,
      platformUptimePct: platformUptime,
      /* Metadata */
      periodStart:     start.toDate().toISOString(),
      periodEnd:       end.toDate().toISOString(),
    };

    /* Persist to Firestore */
    await firestore.collection("executiveSummaries").doc(targetDate).set({
      ...summary,
      updatedAt: serverTimestamp(),
    }, { merge: false });

    console.log(
      JSON.stringify({
        severity: "INFO",
        message:  "[PostLaunchMonitor] Executive summary generated",
        date:     targetDate,
        orders:   metrics.ordersCount,
        revenue:  metrics.revenue,
      })
    );

    return summary;
  }
);

/* ═══════════════════════════════════════════════════════════════════════════
   CF 4: getExecutiveSummaries
   Admin onCall — retrieve last N executive summaries ordered by date desc.
═══════════════════════════════════════════════════════════════════════════ */
exports.getExecutiveSummaries = onCall(
  {
    enforceAppCheck: true,
    region:          REGION,
    maxInstances:    10,
    timeoutSeconds:  30,
  },
  async (request) => {
    _requireAdmin(request.auth);

    const rawLimit = Number(request.data?.limit);
    const limit    = Number.isFinite(rawLimit) && rawLimit > 0
      ? Math.min(rawLimit, 90)
      : 30;

    const firestore = db();
    const snap = await firestore.collection("executiveSummaries")
      .orderBy("date", "desc")
      .limit(limit)
      .get();

    return {
      summaries:   snap.docs.map((d) => d.data()),
      count:       snap.size,
      retrievedAt: new Date().toISOString(),
    };
  }
);

/* ═══════════════════════════════════════════════════════════════════════════
   CF 5: scheduledHourlyMonitor
   Runs every hour on the hour. Writes to hourlyMetrics/{YYYY-MM-DD-HH}.
   Triggers anomaly detection and writes platformAlerts on anomalies found.
═══════════════════════════════════════════════════════════════════════════ */
exports.scheduledHourlyMonitor = onSchedule(
  {
    schedule:       "every 1 hours",
    timeZone:       "UTC",
    region:         REGION,
    maxInstances:   1,
    timeoutSeconds: 120,
    retryConfig:    { retryCount: 2 },
  },
  async () => {
    const firestore  = db();
    const now        = new Date();
    const label      = _hourLabel(now);
    const { start, end } = _currentHourBounds();

    /* Compute current hour metrics */
    const metrics = await _computeMetricsForBounds(start, end);
    const errorCount = metrics.topErrors.reduce((s, e) => s + (e.count || 1), 0);

    const hourDoc = {
      label,
      hourUTC:        now.getUTCHours(),
      dateUTC:        now.toISOString().split("T")[0],
      recordedAt:     serverTimestamp(),
      /* KPIs */
      orders:         metrics.ordersCount,
      revenue:        metrics.revenue,
      newUsers:       metrics.newUsers,
      paymentFailRate: metrics.paymentFailRate,
      failedPayments: metrics.failedPaymentCount,
      totalPayments:  metrics.totalPayments,
      errorCount,
      activeSessions: metrics.activeSessions,
      topErrors:      metrics.topErrors,
    };

    await firestore.collection("hourlyMetrics").doc(label).set(hourDoc);

    console.log(
      JSON.stringify({
        severity: "INFO",
        message:  "[PostLaunchMonitor] Hourly metrics recorded",
        label,
        orders:   metrics.ordersCount,
        revenue:  metrics.revenue,
        errors:   errorCount,
      })
    );

    /* ── Anomaly detection against 7-day hourly baseline ── */
    const currentHourNum = now.getUTCHours();
    const sevenDaysAgoMs = Date.now() - 7 * 24 * 60 * 60 * 1000;
    let baseline = null;

    try {
      const since7d = admin.firestore.Timestamp.fromMillis(sevenDaysAgoMs);
      const historicalSnap = await firestore.collection("hourlyMetrics")
        .where("hourUTC", "==", currentHourNum)
        .where("recordedAt", ">=", since7d)
        .orderBy("recordedAt", "desc")
        .limit(7)
        .get();

      if (!historicalSnap.empty) {
        const docs = historicalSnap.docs.map((d) => d.data());
        const avg  = (key) => {
          const vals = docs.map((d) => d[key]).filter((v) => typeof v === "number");
          return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
        };
        baseline = {
          orders:          avg("orders"),
          revenue:         avg("revenue"),
          newUsers:        avg("newUsers"),
          paymentFailRate: avg("paymentFailRate"),
          errors:          avg("errorCount"),
          activeSessions:  avg("activeSessions"),
        };
      }
    } catch (_e) {
      /* No baseline yet */
    }

    if (!baseline) {
      console.log("[PostLaunchMonitor] No 7-day baseline available — skipping anomaly check for", label);
      return;
    }

    const currentMap = {
      orders:          metrics.ordersCount,
      revenue:         metrics.revenue,
      newUsers:        metrics.newUsers,
      paymentFailRate: metrics.paymentFailRate,
      errors:          errorCount,
      activeSessions:  metrics.activeSessions,
    };

    const anomalies = [];
    for (const [metric, currentVal] of Object.entries(currentMap)) {
      const baseVal = baseline[metric];
      if (baseVal === null || baseVal === undefined || currentVal === null) continue;
      if (baseVal === 0 && currentVal === 0) continue;

      let deviationPct;
      if (baseVal === 0) {
        deviationPct = currentVal > 0 ? 100 : 0;
      } else {
        deviationPct = Math.round(((currentVal - baseVal) / Math.abs(baseVal)) * 10000) / 100;
      }

      if (Math.abs(deviationPct) > ANOMALY_THRESHOLD_PCT) {
        const isNegativeMetric = metric === "paymentFailRate" || metric === "errors";
        const direction        = deviationPct > 0 ? "up" : "down";
        const isConcerning     = isNegativeMetric ? direction === "up" : direction === "down";
        anomalies.push({
          metric,
          current:      currentVal,
          baseline:     Math.round(baseVal * 100) / 100,
          deviationPct,
          direction,
          severity:     Math.abs(deviationPct) >= 75
            ? (isConcerning ? "critical" : "notable")
            : (isConcerning ? "warning"  : "info"),
        });
      }
    }

    if (anomalies.length === 0) {
      console.log("[PostLaunchMonitor] No anomalies detected for", label);
      return;
    }

    /* Write a platformAlerts document per detected anomaly */
    const batch = firestore.batch();
    anomalies.forEach((anomaly) => {
      const alertRef = firestore.collection("platformAlerts").doc();
      batch.set(alertRef, {
        source:      "post-launch-monitor",
        hourLabel:   label,
        ...anomaly,
        acknowledged: false,
        createdAt:   serverTimestamp(),
      });
    });
    await batch.commit();

    console.log(
      JSON.stringify({
        severity: "WARNING",
        message:  "[PostLaunchMonitor] Anomalies detected and alerts written",
        label,
        anomalyCount: anomalies.length,
        anomalies:    anomalies.map((a) => `${a.metric} ${a.deviationPct > 0 ? "+" : ""}${a.deviationPct}%`),
      })
    );
  }
);

/* ═══════════════════════════════════════════════════════════════════════════
   CF 6: scheduledDailyExecutiveSummary
   Runs at 07:00 EAT every day. Generates yesterday's executive summary
   automatically and stores it in executiveSummaries/{YYYY-MM-DD}.
═══════════════════════════════════════════════════════════════════════════ */
exports.scheduledDailyExecutiveSummary = onSchedule(
  {
    schedule:       "every day 07:00",
    timeZone:       "Africa/Nairobi",
    region:         REGION,
    maxInstances:   1,
    timeoutSeconds: 180,
    retryConfig:    { retryCount: 2 },
  },
  async () => {
    const firestore  = db();
    const targetDate = _yesterdayEAT();
    const { start, end } = _dateBounds(targetDate);

    /* Core metrics */
    const metrics = await _computeMetricsForBounds(start, end);

    /* Top sellers — from posBISnapshots */
    let topSellers = [];
    try {
      const sellersSnap = await firestore.collection("posBISnapshots")
        .where("date", "==", targetDate)
        .orderBy("revenue", "desc")
        .limit(10)
        .get();
      topSellers = sellersSnap.docs.map((d) => {
        const v = d.data();
        return {
          sellerId:     v.sellerId || d.id,
          branchId:     v.branchId || null,
          revenue:      v.revenue  || 0,
          transactions: v.transactions || 0,
        };
      });
    } catch (_e) { /* optional */ }

    /* Top products */
    let topProducts = [];
    try {
      const productsSnap = await firestore.collection("orders")
        .where("createdAt", ">=", start)
        .where("createdAt", "<=", end)
        .select("productId", "productName", "total", "status")
        .limit(2000)
        .get();
      const productMap = {};
      productsSnap.docs.forEach((d) => {
        const v = d.data();
        if (!v.productId) return;
        if (!productMap[v.productId]) {
          productMap[v.productId] = {
            productId:   v.productId,
            productName: v.productName || v.productId,
            orderCount:  0,
            revenue:     0,
          };
        }
        productMap[v.productId].orderCount++;
        if (v.status === "completed" && typeof v.total === "number") {
          productMap[v.productId].revenue += v.total;
        }
      });
      topProducts = Object.values(productMap)
        .sort((a, b) => b.orderCount - a.orderCount)
        .slice(0, 10);
    } catch (_e) { /* optional */ }

    /* Platform uptime from systemHealthHistory */
    let platformUptime = null;
    try {
      const healthSnap = await firestore.collection("systemHealthHistory")
        .where("recordedAt", ">=", start)
        .where("recordedAt", "<=", end)
        .orderBy("recordedAt", "asc")
        .limit(500)
        .get();
      if (!healthSnap.empty) {
        const healthDocs  = healthSnap.docs.map((d) => d.data());
        const healthyCount = healthDocs.filter(
          (d) => d.status === "healthy" || d.status === "ok"
        ).length;
        platformUptime = Math.round((healthyCount / healthDocs.length) * 10000) / 100;
      }
    } catch (_e) { /* optional */ }

    const errorCount = metrics.topErrors.reduce((s, e) => s + (e.count || 1), 0);

    const summary = {
      date:            targetDate,
      generatedAt:     new Date().toISOString(),
      generatedBy:     "scheduled",
      /* Core KPIs */
      orders:          metrics.ordersCount,
      revenue:         metrics.revenue,
      revenueFormatted: _formatKES(metrics.revenue ?? 0),
      newUsers:        metrics.newUsers,
      activeSessions:  metrics.activeSessions,
      /* Payment */
      paymentSummary: {
        totalOrders:           metrics.ordersCount,
        completedOrders:       metrics.completedCount,
        failedOrders:          metrics.failedPaymentCount,
        failureRatePct:        metrics.paymentFailRate,
        totalRevenue:          metrics.revenue,
        totalRevenueFormatted: _formatKES(metrics.revenue ?? 0),
      },
      /* Engagement */
      topSellers,
      topProducts,
      /* Reliability */
      errorCount,
      topErrors:          metrics.topErrors,
      platformUptimePct:  platformUptime,
      /* Bounds */
      periodStart:  start.toDate().toISOString(),
      periodEnd:    end.toDate().toISOString(),
    };

    await firestore.collection("executiveSummaries").doc(targetDate).set({
      ...summary,
      updatedAt: serverTimestamp(),
    }, { merge: false });

    console.log(
      JSON.stringify({
        severity: "INFO",
        message:  "[PostLaunchMonitor] Scheduled daily executive summary written",
        date:     targetDate,
        orders:   metrics.ordersCount,
        revenue:  metrics.revenue,
        newUsers: metrics.newUsers,
        errors:   errorCount,
        uptime:   platformUptime,
      })
    );
  }
);
