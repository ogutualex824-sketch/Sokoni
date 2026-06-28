/**
 * SOKONI Enterprise Health Monitoring
 * Firebase Cloud Functions Gen2 — Production Ready
 *
 * Exports:
 *   getSystemHealth            — Full parallel health probe across 10 subsystems
 *   getInfrastructureStatus    — Infrastructure-level status (Firestore, Redis, hosting, etc.)
 *   getMarketplaceHealth       — Marketplace activity metrics (orders, sellers, disputes)
 *   getPOSSystemStatus         — POS sessions, terminals, stale sessions
 *   getPaymentSystemHealth     — Payment volume, failures, fail-rate
 *   getAISystemHealth          — AI key presence, recent errors
 *   getSecuritySystemHealth    — Rate-limit violations, high-severity alerts, blocked IPs
 *   getHealthHistory           — Historical snapshots from systemHealthHistory collection
 *   recordSystemHealthSnapshot — Scheduled every 15 min; persists snapshot to Firestore
 */

"use strict";

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const admin = require("firebase-admin");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const REGION = "us-central1";
const APP_CHECK = true;

// Failure-rate threshold (%) above which payments are considered degraded/down
const PAYMENT_FAIL_RATE_DEGRADED = 10;
const PAYMENT_FAIL_RATE_DOWN = 20;

// Thresholds for subsystem probe status
const THRESHOLDS = {
  rateLimitViolations: 50,
  securityAlerts: 10,
  disputes: 20,
  refunds: 30,
  aiErrors: 20,
  staleSessions: 10,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Throws HttpsError(permission-denied) if the caller is not an admin.
 * @param {import("firebase-functions/v2/https").CallableRequest["auth"]} auth
 */
function _requireAdmin(auth) {
  if (!auth) {
    throw new HttpsError("unauthenticated", "Authentication required.");
  }
  if (!auth.token?.admin && !auth.token?.superAdmin) {
    throw new HttpsError(
      "permission-denied",
      "Admin privileges required for this operation."
    );
  }
}

/**
 * Writes a sentinel document to _health/probe and measures round-trip latency.
 * @returns {Promise<{subsystem: string, status: string, latencyMs: number}>}
 */
async function _probeFirestore() {
  const db = admin.firestore();
  const ref = db.collection("_health").doc("probe");
  const start = Date.now();
  try {
    await ref.set(
      {
        probedAt: admin.firestore.FieldValue.serverTimestamp(),
        probeSource: "enterprise-health",
      },
      { merge: true }
    );
    const latencyMs = Date.now() - start;
    return {
      subsystem: "firestore",
      status: latencyMs < 2000 ? "healthy" : "degraded",
      latencyMs,
    };
  } catch (err) {
    return {
      subsystem: "firestore",
      status: "down",
      latencyMs: Date.now() - start,
      error: err.message,
    };
  }
}

/**
 * Checks whether REDIS_URL is configured in the environment.
 * @returns {{subsystem: string, status: string, note: string}}
 */
function _probeRedis() {
  const redisUrl = process.env.REDIS_URL;
  if (redisUrl && redisUrl.trim().length > 0) {
    return {
      subsystem: "redis",
      status: "healthy",
      note: "REDIS_URL is configured.",
    };
  }
  return {
    subsystem: "redis",
    status: "degraded",
    note: "REDIS_URL is not configured — Redis features will fall back to Firestore.",
  };
}

/**
 * Derives an aggregate status and numeric score from an array of subsystem probes.
 * Rules:
 *  - If firestore or payments is "down"  → overall "down"
 *  - If any subsystem is "down"          → overall "down"
 *  - If any subsystem is "degraded"      → overall "degraded"
 *  - Otherwise                           → "healthy"
 * Score = (healthyCount / total) * 100, rounded.
 *
 * @param {Array<{subsystem: string, status: string}>} probes
 * @returns {{status: string, score: number, healthyCount: number}}
 */
function _rollUp(probes) {
  const criticalSubsystems = new Set(["firestore", "payments"]);
  let status = "healthy";
  let healthyCount = 0;

  for (const probe of probes) {
    if (probe.status === "healthy") {
      healthyCount++;
    } else if (probe.status === "down") {
      // Critical subsystem down → overall down immediately
      if (criticalSubsystems.has(probe.subsystem)) {
        status = "down";
      } else if (status !== "down") {
        status = "down";
      }
    } else if (probe.status === "degraded") {
      if (status === "healthy") {
        status = "degraded";
      }
    }
  }

  const score = probes.length > 0
    ? Math.round((healthyCount / probes.length) * 100)
    : 0;

  return { status, score, healthyCount };
}

/**
 * Returns 'healthy' if count < threshold, else 'degraded'.
 * @param {number} count
 * @param {number} threshold
 * @returns {string}
 */
function _calcStatus(count, threshold) {
  return count < threshold ? "healthy" : "degraded";
}

/**
 * Returns a Firestore Timestamp for N hours ago.
 * @param {number} hours
 * @returns {admin.firestore.Timestamp}
 */
function _hoursAgo(hours) {
  return admin.firestore.Timestamp.fromMillis(
    Date.now() - hours * 60 * 60 * 1000
  );
}

/**
 * Safely retrieves a Firestore .count() aggregate.
 * @param {import("@google-cloud/firestore").Query} query
 * @returns {Promise<number>}
 */
async function _countQuery(query) {
  try {
    const snap = await query.count().get();
    return snap.data().count ?? 0;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Individual subsystem probes used by getSystemHealth / recordSystemHealthSnapshot
// ---------------------------------------------------------------------------

async function _probePayments() {
  const db = admin.firestore();
  const since = _hoursAgo(1);
  try {
    const total = await _countQuery(
      db.collection("payments").where("createdAt", ">=", since)
    );
    const failed = await _countQuery(
      db
        .collection("payments")
        .where("createdAt", ">=", since)
        .where("status", "==", "failed")
    );
    const failRate = total > 0 ? (failed / total) * 100 : 0;
    let status = "healthy";
    if (failRate >= PAYMENT_FAIL_RATE_DOWN) {
      status = "down";
    } else if (failRate >= PAYMENT_FAIL_RATE_DEGRADED) {
      status = "degraded";
    }
    return { subsystem: "payments", status, total, failed, failRate: Math.round(failRate * 10) / 10 };
  } catch (err) {
    return { subsystem: "payments", status: "degraded", error: err.message };
  }
}

async function _probeAI() {
  const db = admin.firestore();
  const keyPresent = !!(process.env.ANTHROPIC_API_KEY || "").trim();
  const since = _hoursAgo(1);
  try {
    const errors = await _countQuery(
      db
        .collection("aiTaskLog")
        .where("createdAt", ">=", since)
        .where("status", "==", "error")
    );
    const status = !keyPresent
      ? "degraded"
      : _calcStatus(errors, THRESHOLDS.aiErrors);
    return { subsystem: "ai", status, keyPresent, recentErrors: errors };
  } catch (err) {
    return { subsystem: "ai", status: "degraded", keyPresent, error: err.message };
  }
}

async function _probeEmail() {
  // Email health: check whether SENDGRID_API_KEY env var is real (not placeholder)
  const key = (process.env.SENDGRID_API_KEY || "").trim();
  const configured = key.length > 0 && !key.startsWith("YOUR_");
  return {
    subsystem: "email",
    status: configured ? "healthy" : "degraded",
    note: configured
      ? "SendGrid API key is configured."
      : "SENDGRID_API_KEY is missing or is a placeholder.",
  };
}

async function _probeSmartPOS() {
  const db = admin.firestore();
  const since = _hoursAgo(1);
  try {
    const active = await _countQuery(
      db.collection("posSessions").where("status", "==", "active")
    );
    const stale = await _countQuery(
      db
        .collection("posSessions")
        .where("status", "==", "active")
        .where("lastActivityAt", "<", since)
    );
    const status = _calcStatus(stale, THRESHOLDS.staleSessions);
    return { subsystem: "smartpos", status, activeSessions: active, staleSessions: stale };
  } catch (err) {
    return { subsystem: "smartpos", status: "degraded", error: err.message };
  }
}

async function _probeMarketplace() {
  const db = admin.firestore();
  const since = _hoursAgo(1);
  try {
    const orders = await _countQuery(
      db.collection("orders").where("createdAt", ">=", since)
    );
    const disputes = await _countQuery(
      db
        .collection("disputes")
        .where("createdAt", ">=", since)
        .where("status", "in", ["open", "escalated"])
    );
    const status = _calcStatus(disputes, THRESHOLDS.disputes);
    return { subsystem: "marketplace", status, recentOrders: orders, openDisputes: disputes };
  } catch (err) {
    return { subsystem: "marketplace", status: "degraded", error: err.message };
  }
}

async function _probeNotifications() {
  const db = admin.firestore();
  const since = _hoursAgo(1);
  try {
    const failed = await _countQuery(
      db
        .collection("notifications")
        .where("createdAt", ">=", since)
        .where("status", "==", "failed")
    );
    const status = _calcStatus(failed, 50);
    return { subsystem: "notifications", status, failedLast1hr: failed };
  } catch (err) {
    return { subsystem: "notifications", status: "degraded", error: err.message };
  }
}

async function _probeAsyncJobs() {
  const db = admin.firestore();
  const since = _hoursAgo(1);
  try {
    const failed = await _countQuery(
      db
        .collection("asyncJobs")
        .where("updatedAt", ">=", since)
        .where("status", "==", "failed")
    );
    const status = _calcStatus(failed, 20);
    return { subsystem: "async_jobs", status, failedLast1hr: failed };
  } catch (err) {
    return { subsystem: "async_jobs", status: "degraded", error: err.message };
  }
}

async function _probeSecurity() {
  const db = admin.firestore();
  const since1hr = _hoursAgo(1);
  const since24hr = _hoursAgo(24);
  try {
    const violations = await _countQuery(
      db
        .collection("rateLimitViolations")
        .where("createdAt", ">=", since1hr)
    );
    const alerts = await _countQuery(
      db
        .collection("securityAlerts")
        .where("createdAt", ">=", since1hr)
        .where("severity", "==", "high")
    );
    const blockedIPs = await _countQuery(
      db
        .collection("blockedIPs")
        .where("blockedAt", ">=", since24hr)
    );
    const status =
      _calcStatus(violations, THRESHOLDS.rateLimitViolations) === "degraded" ||
      _calcStatus(alerts, THRESHOLDS.securityAlerts) === "degraded"
        ? "degraded"
        : "healthy";
    return {
      subsystem: "security",
      status,
      rateLimitViolationsLast1hr: violations,
      highSeverityAlertsLast1hr: alerts,
      blockedIPsLast24hr: blockedIPs,
    };
  } catch (err) {
    return { subsystem: "security", status: "degraded", error: err.message };
  }
}

/**
 * Runs all 10 subsystem probes in parallel.
 * @returns {Promise<Array>}
 */
async function _runAllProbes() {
  const [
    firestoreProbe,
    redisProbe,
    paymentsProbe,
    aiProbe,
    emailProbe,
    smartposProbe,
    marketplaceProbe,
    notificationsProbe,
    asyncJobsProbe,
    securityProbe,
  ] = await Promise.all([
    _probeFirestore(),
    Promise.resolve(_probeRedis()),
    _probePayments(),
    _probeAI(),
    _probeEmail(),
    _probeSmartPOS(),
    _probeMarketplace(),
    _probeNotifications(),
    _probeAsyncJobs(),
    _probeSecurity(),
  ]);

  return [
    firestoreProbe,
    redisProbe,
    paymentsProbe,
    aiProbe,
    emailProbe,
    smartposProbe,
    marketplaceProbe,
    notificationsProbe,
    asyncJobsProbe,
    securityProbe,
  ];
}

// ---------------------------------------------------------------------------
// Exported Cloud Functions
// ---------------------------------------------------------------------------

/**
 * 1. getSystemHealth
 * Full parallel health probe across 10 subsystems.
 * Returns { status, score, subsystems, probeTimeMs, checkedAt }
 */
exports.getSystemHealth = onCall(
  { region: REGION, enforceAppCheck: APP_CHECK },
  async (request) => {
    _requireAdmin(request.auth);

    const probeStart = Date.now();
    const subsystems = await _runAllProbes();
    const probeTimeMs = Date.now() - probeStart;

    const { status, score, healthyCount } = _rollUp(subsystems);

    return {
      status,
      score,
      healthyCount,
      totalSubsystems: subsystems.length,
      subsystems,
      probeTimeMs,
      checkedAt: Date.now(),
    };
  }
);

/**
 * 2. getInfrastructureStatus
 * Returns Firestore latency probe, Redis URL check, and status of
 * hosting / functions / storage / scheduler / appCheck services.
 */
exports.getInfrastructureStatus = onCall(
  { region: REGION, enforceAppCheck: APP_CHECK },
  async (request) => {
    _requireAdmin(request.auth);

    const [firestoreProbe] = await Promise.all([_probeFirestore()]);
    const redisProbe = _probeRedis();

    // These are configuration/env-based checks — no live API calls.
    const hostingStatus = "healthy"; // Firebase Hosting is always managed by Firebase infra
    const functionsStatus = "healthy"; // If this function is running, Functions is up
    const storageStatus = process.env.FIREBASE_STORAGE_EMULATOR_HOST
      ? "emulated"
      : "healthy";
    const schedulerStatus = "healthy"; // Scheduler is a Firebase-managed service
    const appCheckStatus = APP_CHECK ? "enforced" : "disabled";

    return {
      firestore: firestoreProbe,
      redis: redisProbe,
      services: {
        hosting: hostingStatus,
        functions: functionsStatus,
        storage: storageStatus,
        scheduler: schedulerStatus,
        appCheck: appCheckStatus,
      },
      checkedAt: Date.now(),
    };
  }
);

/**
 * 3. getMarketplaceHealth
 * Counts orders last 1 hour, active sellers, open disputes, and refunds.
 */
exports.getMarketplaceHealth = onCall(
  { region: REGION, enforceAppCheck: APP_CHECK },
  async (request) => {
    _requireAdmin(request.auth);

    const db = admin.firestore();
    const since1hr = _hoursAgo(1);

    const [ordersLast1hr, activeSellers, openDisputes, recentRefunds] =
      await Promise.all([
        _countQuery(
          db.collection("orders").where("createdAt", ">=", since1hr)
        ),
        _countQuery(
          db.collection("sellers").where("status", "==", "active")
        ),
        _countQuery(
          db
            .collection("disputes")
            .where("status", "in", ["open", "escalated"])
        ),
        _countQuery(
          db
            .collection("refunds")
            .where("createdAt", ">=", since1hr)
        ),
      ]);

    const disputeStatus = _calcStatus(openDisputes, THRESHOLDS.disputes);
    const refundStatus = _calcStatus(recentRefunds, THRESHOLDS.refunds);

    const overallStatus =
      disputeStatus === "degraded" || refundStatus === "degraded"
        ? "degraded"
        : "healthy";

    return {
      status: overallStatus,
      ordersLast1hr,
      activeSellers,
      openDisputes,
      recentRefunds,
      checkedAt: Date.now(),
    };
  }
);

/**
 * 4. getPOSSystemStatus
 * Counts active posSessions, registered posTerminals, stale sessions (inactive >1hr).
 */
exports.getPOSSystemStatus = onCall(
  { region: REGION, enforceAppCheck: APP_CHECK },
  async (request) => {
    _requireAdmin(request.auth);

    const db = admin.firestore();
    const since1hr = _hoursAgo(1);

    const [activeSessions, registeredTerminals, staleSessions] =
      await Promise.all([
        _countQuery(
          db.collection("posSessions").where("status", "==", "active")
        ),
        _countQuery(
          db.collection("posTerminals").where("status", "==", "registered")
        ),
        _countQuery(
          db
            .collection("posSessions")
            .where("status", "==", "active")
            .where("lastActivityAt", "<", since1hr)
        ),
      ]);

    const staleStatus = _calcStatus(staleSessions, THRESHOLDS.staleSessions);

    return {
      status: staleStatus,
      activeSessions,
      registeredTerminals,
      staleSessions,
      checkedAt: Date.now(),
    };
  }
);

/**
 * 5. getPaymentSystemHealth
 * Counts payments last 1hr, failed payments; calculates fail rate %.
 * Status: healthy if failRate < 10%, degraded if 10-20%, down if >=20%.
 */
exports.getPaymentSystemHealth = onCall(
  { region: REGION, enforceAppCheck: APP_CHECK },
  async (request) => {
    _requireAdmin(request.auth);

    const db = admin.firestore();
    const since1hr = _hoursAgo(1);

    const [totalLast1hr, failedLast1hr] = await Promise.all([
      _countQuery(
        db.collection("payments").where("createdAt", ">=", since1hr)
      ),
      _countQuery(
        db
          .collection("payments")
          .where("createdAt", ">=", since1hr)
          .where("status", "==", "failed")
      ),
    ]);

    const failRate =
      totalLast1hr > 0
        ? Math.round((failedLast1hr / totalLast1hr) * 1000) / 10
        : 0;

    let status = "healthy";
    if (failRate >= PAYMENT_FAIL_RATE_DOWN) {
      status = "down";
    } else if (failRate >= PAYMENT_FAIL_RATE_DEGRADED) {
      status = "degraded";
    }

    return {
      status,
      totalLast1hr,
      failedLast1hr,
      failRatePercent: failRate,
      checkedAt: Date.now(),
    };
  }
);

/**
 * 6. getAISystemHealth
 * Checks ANTHROPIC_API_KEY presence; counts aiTaskLog errors last 1hr.
 */
exports.getAISystemHealth = onCall(
  { region: REGION, enforceAppCheck: APP_CHECK },
  async (request) => {
    _requireAdmin(request.auth);

    const keyPresent = !!(process.env.ANTHROPIC_API_KEY || "").trim();
    const db = admin.firestore();
    const since1hr = _hoursAgo(1);

    const recentErrors = await _countQuery(
      db
        .collection("aiTaskLog")
        .where("createdAt", ">=", since1hr)
        .where("status", "==", "error")
    );

    let status = "healthy";
    if (!keyPresent) {
      status = "degraded";
    } else if (recentErrors >= THRESHOLDS.aiErrors) {
      status = "degraded";
    }

    return {
      status,
      keyPresent,
      recentErrors,
      checkedAt: Date.now(),
    };
  }
);

/**
 * 7. getSecuritySystemHealth
 * Counts rateLimitViolations last 1hr, securityAlerts (severity=high) last 1hr,
 * blockedIPs last 24hr.
 */
exports.getSecuritySystemHealth = onCall(
  { region: REGION, enforceAppCheck: APP_CHECK },
  async (request) => {
    _requireAdmin(request.auth);

    const db = admin.firestore();
    const since1hr = _hoursAgo(1);
    const since24hr = _hoursAgo(24);

    const [rateLimitViolations, highSeverityAlerts, blockedIPs] =
      await Promise.all([
        _countQuery(
          db
            .collection("rateLimitViolations")
            .where("createdAt", ">=", since1hr)
        ),
        _countQuery(
          db
            .collection("securityAlerts")
            .where("createdAt", ">=", since1hr)
            .where("severity", "==", "high")
        ),
        _countQuery(
          db
            .collection("blockedIPs")
            .where("blockedAt", ">=", since24hr)
        ),
      ]);

    const violationsStatus = _calcStatus(
      rateLimitViolations,
      THRESHOLDS.rateLimitViolations
    );
    const alertsStatus = _calcStatus(
      highSeverityAlerts,
      THRESHOLDS.securityAlerts
    );

    const status =
      violationsStatus === "degraded" || alertsStatus === "degraded"
        ? "degraded"
        : "healthy";

    return {
      status,
      rateLimitViolationsLast1hr: rateLimitViolations,
      highSeverityAlertsLast1hr: highSeverityAlerts,
      blockedIPsLast24hr: blockedIPs,
      checkedAt: Date.now(),
    };
  }
);

/**
 * 8. getHealthHistory
 * Queries systemHealthHistory ordered by recordedAt desc.
 * data.hours defaults to 24, max 168 (7 days).
 * Returns array of { status, score, healthyCount, recordedAt (millis) }.
 */
exports.getHealthHistory = onCall(
  { region: REGION, enforceAppCheck: APP_CHECK },
  async (request) => {
    _requireAdmin(request.auth);

    const hoursRaw = parseInt(request.data?.hours ?? 24, 10);
    const hours = Math.min(Math.max(hoursRaw, 1), 168);

    const db = admin.firestore();
    const since = _hoursAgo(hours);

    let snap;
    try {
      snap = await db
        .collection("systemHealthHistory")
        .where("recordedAt", ">=", since)
        .orderBy("recordedAt", "desc")
        .limit(200)
        .get();
    } catch (err) {
      throw new HttpsError("internal", `Failed to query health history: ${err.message}`);
    }

    const history = snap.docs.map((doc) => {
      const d = doc.data();
      return {
        status: d.status ?? "unknown",
        score: d.score ?? 0,
        healthyCount: d.healthyCount ?? 0,
        recordedAt: d.recordedAt?.toMillis?.() ?? null,
      };
    });

    return { hours, count: history.length, history };
  }
);

/**
 * 9. recordSystemHealthSnapshot
 * Scheduled every 15 minutes.
 * Runs all probes, writes to:
 *   - systemHealthHistory (append)
 *   - platformMetrics/health (overwrite)
 */
exports.recordSystemHealthSnapshot = onSchedule(
  {
    schedule: "every 15 minutes",
    region: REGION,
    timeoutSeconds: 120,
    memory: "256MiB",
  },
  async (_event) => {
    const probeStart = Date.now();
    let subsystems;
    try {
      subsystems = await _runAllProbes();
    } catch (err) {
      console.error("[enterprise-health] Probe run failed:", err);
      return;
    }

    const probeTimeMs = Date.now() - probeStart;
    const { status, score, healthyCount } = _rollUp(subsystems);

    const db = admin.firestore();
    const now = admin.firestore.FieldValue.serverTimestamp();

    const snapshotData = {
      status,
      score,
      healthyCount,
      totalSubsystems: subsystems.length,
      subsystems,
      probeTimeMs,
      recordedAt: now,
    };

    try {
      const batch = db.batch();

      // Append to history collection
      const historyRef = db.collection("systemHealthHistory").doc();
      batch.set(historyRef, snapshotData);

      // Overwrite current health in platformMetrics
      const metricsRef = db.collection("platformMetrics").doc("health");
      batch.set(metricsRef, {
        ...snapshotData,
        updatedAt: now,
      });

      await batch.commit();

      console.info(
        `[enterprise-health] Snapshot recorded — status=${status} score=${score} probeTimeMs=${probeTimeMs}`
      );
    } catch (err) {
      console.error("[enterprise-health] Failed to write snapshot:", err);
    }
  }
);
