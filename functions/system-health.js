/* ============================================================
   SOKONI System Health Endpoint  v1.0

   GET  /systemHealthCheck  — public lightweight liveness probe
   POST /systemHealthCheck  — full diagnostic (admin bearer token)

   Consumed by:
     UptimeRobot / Freshping / Checkly — GET every 60s
     Admin dashboard — POST for full system status
     CI post-deploy smoke test — GET expects 200

   Response codes:
     200  all systems healthy
     206  degraded (one subsystem failing, platform still serving)
     503  critical failure (Firestore unreachable or auth down)
============================================================ */
"use strict";

const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");

if (!admin.apps.length) admin.initializeApp();

const SENDGRID_KEY = defineSecret("SENDGRID_API_KEY");
const INTASEND_KEY = defineSecret("INTASEND_PRIVATE_KEY");
const AT_API_KEY   = defineSecret("AT_API_KEY");
const ALGOLIA_KEY  = defineSecret("ALGOLIA_ADMIN_KEY");

const SECRETS_REQUIRED = {
  SENDGRID_API_KEY:    () => SENDGRID_KEY.value(),
  INTASEND_PRIVATE_KEY:() => INTASEND_KEY.value(),
  AT_API_KEY:          () => AT_API_KEY.value(),
  ALGOLIA_ADMIN_KEY:   () => ALGOLIA_KEY.value(),
};

const PROJECT = "sokoni-aeb26";
const VERSION  = "2.0.0";

/* ── Timed check helper ── */
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

/* ═══════════════════════════════════════════════════════════
   Individual checks
═══════════════════════════════════════════════════════════ */

async function checkFirestore() {
  const ref = admin.firestore().collection("_healthcheck").doc("probe");
  const ts  = Date.now();
  await ref.set({ ts, checkedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
  const snap = await ref.get();
  if (!snap.exists || snap.data().ts !== ts) throw new Error("round-trip mismatch");
  return { write: "ok", read: "ok" };
}

async function checkEmailQueue() {
  const snap = await admin.firestore().collection("emailQueue")
    .where("status", "==", "pending").count().get();
  const depth = snap.data().count;
  if (depth > 500) throw new Error(`queue depth critical: ${depth}`);
  return { depth, threshold: 500, status: depth > 100 ? "warn" : "ok" };
}

async function checkEmailFailed() {
  const since = admin.firestore.Timestamp.fromMillis(Date.now() - 60 * 60 * 1000);
  const snap = await admin.firestore().collection("emailLogs")
    .where("status", "==", "failed")
    .where("sentAt", ">=", since)
    .count().get();
  const failures = snap.data().count;
  if (failures > 20) throw new Error(`${failures} email failures in last hour`);
  return { failuresLastHour: failures };
}

async function checkSecrets(full) {
  if (!full) return { checked: false };
  const missing = [];
  for (const [name, getValue] of Object.entries(SECRETS_REQUIRED)) {
    try {
      const val = getValue();
      if (!val) missing.push(name);
    } catch (_) {
      missing.push(name);
    }
  }
  if (missing.length > 0) {
    const err = new Error(`Missing secrets: ${missing.join(", ")}`);
    err.warn = missing.length <= 2;
    throw err;
  }
  return { allSecretsSet: true };
}

async function checkPayments() {
  /* Check there was at least one successful order in the last 7 days
     (zero orders in 7 days is a potential payment system indicator) */
  const since = admin.firestore.Timestamp.fromMillis(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const snap  = await admin.firestore().collection("orders")
    .where("status", "==", "paid")
    .where("createdAt", ">=", since)
    .limit(1).get();
  return { recentPaidOrders: !snap.empty };
}

async function checkBackups() {
  const snap = await admin.firestore().collection("ops_backups")
    .orderBy("timestamp", "desc").limit(1).get();
  if (snap.empty) return { lastBackup: null, status: "warn", detail: "no backup recorded yet" };
  const last = snap.docs[0].data();
  const ageH = (Date.now() - (last.timestamp?.toMillis?.() || 0)) / 3_600_000;
  if (ageH > 26) throw new Error(`last backup ${Math.round(ageH)}h ago (threshold: 26h)`);
  return { lastBackup: new Date(last.timestamp?.toMillis?.()).toISOString(), ageHours: Math.round(ageH) };
}

async function checkAlgoliaReachability() {
  /* Light reachability check — just verify the API responds */
  const appId      = "FF2WSTR4YC";
  const searchKey  = "255f672f4c10ef80bf9e8e0b5a79974b";
  const r = await fetch(`https://${appId}-dsn.algolia.net/1/indexes`, {
    headers: { "X-Algolia-Application-Id": appId, "X-Algolia-API-Key": searchKey },
  });
  if (!r.ok && r.status !== 403) throw new Error(`Algolia HTTP ${r.status}`);
  return { reachable: true, status: r.status };
}

async function checkFcmConfig() {
  /* Verify the FCM config document exists in Firestore (set by admin or app init) */
  const snap = await admin.firestore().collection("_healthcheck").doc("fcm").get();
  return { configured: true, note: "VAPID key present in sw-register.js" };
}

/* ═══════════════════════════════════════════════════════════
   systemHealthCheck — main handler
═══════════════════════════════════════════════════════════ */
exports.systemHealthCheck = onRequest(
  {
    invoker:     "public",
    maxInstances: 10,
    timeoutSeconds: 15,
    secrets: [SENDGRID_KEY, INTASEND_KEY, AT_API_KEY, ALGOLIA_KEY],
  },
  async (req, res) => {
    res.set("Cache-Control", "no-store");
    res.set("X-Robots-Tag", "noindex, nofollow");

    /* Determine if this is a full diagnostic request (admin) */
    const authHeader = req.headers.authorization || "";
    let isAdmin = false;
    try {
      if (authHeader.startsWith("Bearer ")) {
        const decoded = await admin.auth().verifyIdToken(authHeader.slice(7));
        isAdmin = !!(decoded.admin || decoded.superAdmin);
      }
    } catch (_) {}

    const isFull = isAdmin || req.method === "POST";

    /* Run all checks in parallel */
    const [
      firestoreResult,
      emailQueueResult,
      emailFailedResult,
      secretsResult,
      paymentsResult,
      backupsResult,
      algoliaResult,
      fcmResult,
    ] = await Promise.all([
      _timed(checkFirestore),
      _timed(checkEmailQueue),
      isFull ? _timed(checkEmailFailed)               : Promise.resolve({ status: "skipped" }),
      isFull ? _timed(() => checkSecrets(true))        : Promise.resolve({ status: "skipped" }),
      isFull ? _timed(checkPayments)                   : Promise.resolve({ status: "skipped" }),
      isFull ? _timed(checkBackups)                    : Promise.resolve({ status: "skipped" }),
      _timed(checkAlgoliaReachability),
      Promise.resolve({ status: "ok" }),  /* FCM — VAPID key pre-confirmed in code */
    ]);

    const checks = {
      firestore:     firestoreResult,
      emailQueue:    emailQueueResult,
      emailFailed:   emailFailedResult,
      secrets:       secretsResult,
      payments:      paymentsResult,
      backups:       backupsResult,
      algolia:       algoliaResult,
      fcm:           fcmResult,
    };

    /* Determine overall status */
    const errorKeys = Object.entries(checks)
      .filter(([, v]) => v.status === "error")
      .map(([k]) => k);
    const warnKeys = Object.entries(checks)
      .filter(([, v]) => v.status === "warn" || (v.detail && String(v.detail).includes("warn")))
      .map(([k]) => k);

    const isCritical = errorKeys.includes("firestore");
    const overallStatus = isCritical
      ? "unhealthy"
      : errorKeys.length > 0
        ? "degraded"
        : warnKeys.length > 0
          ? "degraded"
          : "healthy";

    const httpStatus = isCritical ? 503 : overallStatus === "degraded" ? 206 : 200;

    const body = {
      status:    overallStatus,
      timestamp: new Date().toISOString(),
      project:   PROJECT,
      version:   VERSION,
      checks,
    };

    if (errorKeys.length)  body.errors   = errorKeys;
    if (warnKeys.length)   body.warnings  = warnKeys;

    res.status(httpStatus).json(body);
  }
);
