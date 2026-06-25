"use strict";
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

const HEALTH_URL   = "https://us-central1-sokoni-aeb26.cloudfunctions.net/systemHealthCheck";
const FUNNEL_STEPS = ["addToCart", "checkoutStarted", "paymentAttempted"];

function requireAdmin(request) {
  if (!request.auth?.token?.isAdmin && !request.auth?.token?.isSuperAdmin) {
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

/* ── recordHealthSnapshot ────────────────────────────────────────
   Runs every hour. Fetches systemHealthCheck, stores result.
   Prunes snapshots older than 30 days to control storage cost.
═══════════════════════════════════════════════════════════════════ */
exports.recordHealthSnapshot = onSchedule(
  { schedule: "0 * * * *", maxInstances: 1, timeoutSeconds: 30 },
  async () => {
    const db = getFirestore();
    const ts = new Date();

    let snapshotData;
    try {
      const res  = await fetch(HEALTH_URL, {
        signal: AbortSignal.timeout(12000),
        cache:  "no-store",
      });
      const data = await res.json();

      snapshotData = {
        timestamp:        Timestamp.fromDate(ts),
        status:           data.status || "unknown",
        httpCode:         res.status,
        firestoreLatency: data.checks?.firestore?.latencyMs || null,
        algoliaLatency:   data.checks?.algolia?.latencyMs   || null,
        emailQueueDepth:  data.checks?.emailQueue?.detail?.depth ?? null,
        checks: Object.fromEntries(
          Object.entries(data.checks || {}).map(([k, v]) => [k, v.status])
        ),
      };
    } catch (e) {
      console.error("[HealthSnapshot] Fetch failed:", e.message);
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
