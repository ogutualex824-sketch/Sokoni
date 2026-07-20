"use strict";
const _ac = require('./admin-claim');
/* ═══════════════════════════════════════════════════════════════════
   functions/conversion-analytics.js
   Conversion funnel tracking and platform reliability metrics.

   Funnel uses daily-aggregate pattern: increments counters per day
   rather than storing individual events, keeping Firestore costs minimal.

   Exports:
     recordFunnelEvent    — public callable — addToCart / checkoutStarted
     getFunnelMetrics     — admin callable  — conversion rates
     recordHealthSnapshot — scheduled hourly — uptime history
     getReliabilityMetrics — admin callable  — uptime %, latency stats
═══════════════════════════════════════════════════════════════════ */

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { onSchedule }        = require("firebase-functions/v2/scheduler");
const { getFirestore, FieldValue, Timestamp } = require("firebase-admin/firestore");

const FUNNEL_STEPS = ["addToCart", "checkoutStarted", "paymentAttempted"];

function requireAdmin(request) {
  if (!_ac.isAdmin(request)) {
    throw new HttpsError("permission-denied", "Admin access required");
  }
}

/* ── recordFunnelEvent ───────────────────────────────────────────
   Increments today's daily counter. Called from cart.js / checkout.js.
   De-duplicates within a session are the caller's responsibility;
   the aggregate approach tolerates minor over-counting gracefully.
═══════════════════════════════════════════════════════════════════ */
exports.recordFunnelEvent = onCall(
  { maxInstances: 200 },
  async (request) => {
    const { step, category } = request.data || {};

    if (!FUNNEL_STEPS.includes(step)) {
      throw new HttpsError("invalid-argument",
        `step must be one of: ${FUNNEL_STEPS.join(", ")}`);
    }

    const db    = getFirestore();
    const today = new Date().toISOString().split("T")[0];
    const ref   = db.collection("funnelStats").doc(today);

    const update = {
      [`${step}Count`]: FieldValue.increment(1),
      updatedAt:        FieldValue.serverTimestamp(),
    };
    if (category && typeof category === "string") {
      update[`cat_${category.replace(/[^a-zA-Z0-9_]/g, "_")}_${step}`] =
        FieldValue.increment(1);
    }

    await ref.set(update, { merge: true });
    return { success: true };
  }
);

/* ── getFunnelMetrics ────────────────────────────────────────────── */
exports.getFunnelMetrics = onCall(
  { maxInstances: 5 },
  async (request) => {
    requireAdmin(request);

    const { days = 30 } = request.data || {};
    const safeDays = Math.min(Math.max(Number(days) || 30, 7), 90);
    const db       = getFirestore();
    const since    = Timestamp.fromMillis(Date.now() - safeDays * 86400000);

    const [funnelSnap, ordersSnap] = await Promise.all([
      db.collection("funnelStats")
        .where("updatedAt", ">=", since)
        .limit(safeDays + 5)
        .get(),
      db.collection("orders")
        .where("status", "in", ["paid", "delivered", "completed"])
        .where("createdAt", ">=", since)
        .count().get(),
    ]);

    let totalCartAdds  = 0;
    let totalCheckouts = 0;
    const dailyData    = [];

    funnelSnap.docs.forEach(d => {
      const v = d.data();
      totalCartAdds  += v.addToCartCount       || 0;
      totalCheckouts += v.checkoutStartedCount  || 0;
      dailyData.push({
        date:      d.id,
        cartAdds:  v.addToCartCount      || 0,
        checkouts: v.checkoutStartedCount || 0,
      });
    });

    dailyData.sort((a, b) => a.date.localeCompare(b.date));

    const totalPaid = ordersSnap.data().count;

    return {
      period:          `${safeDays}d`,
      funnel: [
        { step: "Add to Cart",      count: totalCartAdds,   pct: 100 },
        { step: "Checkout Started", count: totalCheckouts,
          pct: totalCartAdds > 0 ? Math.round((totalCheckouts / totalCartAdds) * 100) : null },
        { step: "Orders Paid",      count: totalPaid,
          pct: totalCheckouts > 0 ? Math.round((totalPaid / totalCheckouts) * 100) : null },
      ],
      rates: {
        cartToCheckoutPct: totalCartAdds  > 0 ? Math.round((totalCheckouts / totalCartAdds) * 100)  : null,
        checkoutToPaidPct: totalCheckouts > 0 ? Math.round((totalPaid / totalCheckouts)      * 100) : null,
      },
      daily:       dailyData,
      generatedAt: new Date().toISOString(),
    };
  }
);

/* ── _runInlineHealthCheck ───────────────────────────────────────
   CF-02 fix: runs the three core health probes in-process instead of
   making an outbound HTTP call to systemHealthCheck (which would bill
   two CF invocations per hourly schedule tick).
   Returns { status, httpCode, checks } — same shape as the HTTP
   response so the healthSnapshots schema is unchanged.
═══════════════════════════════════════════════════════════════════ */
async function _runInlineHealthCheck(db) {
  async function _timed(fn) {
    const t = Date.now();
    try {
      const detail = await Promise.race([
        fn(),
        new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 4000)),
      ]);
      return { status: "ok", latencyMs: Date.now() - t, detail: detail || null };
    } catch (e) {
      return { status: "error", latencyMs: Date.now() - t, error: e.message };
    }
  }

  const [firestoreResult, emailQueueResult, algoliaResult] = await Promise.all([
    _timed(async () => {
      const probe  = db.collection("_healthcheck").doc("probe");
      const marker = Date.now();
      await probe.set({ ts: marker, checkedAt: FieldValue.serverTimestamp() }, { merge: true });
      const snap = await probe.get();
      if (!snap.exists || snap.data().ts !== marker) throw new Error("round-trip mismatch");
      return { write: "ok", read: "ok" };
    }),
    _timed(async () => {
      const snap  = await db.collection("emailQueue")
        .where("status", "==", "pending").count().get();
      const depth = snap.data().count;
      if (depth > 500) throw new Error(`queue depth critical: ${depth}`);
      return { depth, threshold: 500, status: depth > 100 ? "warn" : "ok" };
    }),
    _timed(async () => {
      const appId = process.env.ALGOLIA_APP_ID || "FF2WSTR4YC";
      const r = await fetch(`https://${appId}-dsn.algolia.net/1/isalive`);
      if (!r.ok && r.status !== 401) throw new Error(`Algolia HTTP ${r.status}`);
      return { reachable: true, status: r.status };
    }),
  ]);

  const checks = { firestore: firestoreResult, emailQueue: emailQueueResult, algolia: algoliaResult };

  const errorKeys = Object.entries(checks)
    .filter(([, v]) => v.status === "error").map(([k]) => k);
  const warnKeys  = Object.entries(checks)
    .filter(([, v]) => v.status === "warn").map(([k])  => k);

  const isCritical    = errorKeys.includes("firestore");
  const overallStatus = isCritical          ? "unhealthy"
    : errorKeys.length > 0                  ? "degraded"
    : warnKeys.length  > 0                  ? "degraded"
    :                                          "healthy";
  const httpCode = isCritical ? 503 : overallStatus === "degraded" ? 206 : 200;

  return { status: overallStatus, httpCode, checks };
}

/* ── recordHealthSnapshot ────────────────────────────────────────
   Runs every hour. Runs inline health probes, stores result.
   Prunes snapshots older than 30 days to control storage cost.
═══════════════════════════════════════════════════════════════════ */
exports.recordHealthSnapshot = onSchedule(
  { schedule: "0 * * * *", maxInstances: 1, timeoutSeconds: 30 },
  async () => {
    const db = getFirestore();
    const ts = new Date();

    let snapshotData;
    try {
      const { status, httpCode, checks } = await _runInlineHealthCheck(db);

      snapshotData = {
        timestamp:        Timestamp.fromDate(ts),
        status,
        httpCode,
        firestoreLatency: checks.firestore?.latencyMs        || null,
        algoliaLatency:   checks.algolia?.latencyMs          || null,
        emailQueueDepth:  checks.emailQueue?.detail?.depth   ?? null,
        checks: Object.fromEntries(
          Object.entries(checks).map(([k, v]) => [k, v.status])
        ),
      };
    } catch (e) {
      console.error("[HealthSnapshot] Health check failed:", e.message);
      snapshotData = {
        timestamp: Timestamp.fromDate(ts),
        status:    "unreachable",
        httpCode:  null,
        error:     String(e.message).substring(0, 200),
      };
    }

    await db.collection("healthSnapshots").add(snapshotData);

    /* Prune snapshots older than 30 days (batched, max 50 per run) */
    const cutoff   = Timestamp.fromMillis(Date.now() - 30 * 86400000);
    const oldSnaps = await db.collection("healthSnapshots")
      .where("timestamp", "<", cutoff).limit(50).get();

    if (!oldSnaps.empty) {
      const batch = db.batch();
      oldSnaps.docs.forEach(d => batch.delete(d.ref));
      await batch.commit();
      console.log(`[HealthSnapshot] Pruned ${oldSnaps.size} old snapshots`);
    }

    console.log(`[HealthSnapshot] ${ts.toISOString()} → status: ${snapshotData.status}`);
  }
);

/* ── getReliabilityMetrics ───────────────────────────────────────── */
exports.getReliabilityMetrics = onCall(
  { maxInstances: 5 },
  async (request) => {
    requireAdmin(request);

    const { hours = 168 } = request.data || {};
    const safeHours = Math.min(Math.max(Number(hours) || 168, 24), 720);
    const db        = getFirestore();
    const since     = Timestamp.fromMillis(Date.now() - safeHours * 3600000);

    const snap = await db.collection("healthSnapshots")
      .where("timestamp", ">=", since)
      .orderBy("timestamp", "desc")
      .limit(750)
      .get();

    const snaps = snap.docs.map(d => d.data());
    const total = snaps.length;

    if (total === 0) {
      return {
        hours: safeHours, totalSnapshots: 0,
        uptime: null, message: "No health snapshots yet — recordHealthSnapshot runs hourly",
      };
    }

    const healthy  = snaps.filter(s => s.status === "healthy").length;
    const degraded = snaps.filter(s => s.status === "degraded").length;
    const down     = snaps.filter(s => s.status === "unreachable").length;

    const fsLatencies = snaps.filter(s => s.firestoreLatency != null).map(s => s.firestoreLatency);
    const algLatencies = snaps.filter(s => s.algoliaLatency  != null).map(s => s.algoliaLatency);

    function stats(arr) {
      if (!arr.length) return { avg: null, max: null, p95: null };
      const sorted = [...arr].sort((a, b) => a - b);
      return {
        avg: Math.round(arr.reduce((a, b) => a + b, 0) / arr.length),
        max: sorted[sorted.length - 1],
        p95: sorted[Math.floor(sorted.length * 0.95)],
      };
    }

    return {
      hours:          safeHours,
      totalSnapshots: total,
      uptime:         +(healthy  / total * 100).toFixed(2),
      degradedPct:    +(degraded / total * 100).toFixed(2),
      downPct:        +(down     / total * 100).toFixed(2),
      firestore:      stats(fsLatencies),
      algolia:        stats(algLatencies),
      /* Last 48 for status timeline */
      recent: snaps.slice(0, 48).map(s => ({
        ts:          s.timestamp?.toMillis?.() || null,
        status:      s.status,
        fsLatency:   s.firestoreLatency,
        algLatency:  s.algoliaLatency,
        emailQDepth: s.emailQueueDepth,
      })),
      generatedAt: new Date().toISOString(),
    };
  }
);
