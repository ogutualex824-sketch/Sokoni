"use strict";
/* ═══════════════════════════════════════════════════════════════════
   functions/scheduled-reports.js
   Automated daily ops report and weekly security digest.

   Exports:
     scheduledDailyOpsReport      — scheduled 06:00 EAT — save + email
     scheduledWeeklySecurityReport — scheduled Mon 07:00 EAT — save + email
     getDailyReport               — admin callable — fetch stored reports
     getWeeklyReports             — admin callable — last N weekly reports
═══════════════════════════════════════════════════════════════════ */

const { onSchedule }       = require("firebase-functions/v2/scheduler");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { getFirestore, Timestamp } = require("firebase-admin/firestore");
const { defineSecret }     = require("firebase-functions/params");

const SENDGRID_API_KEY = defineSecret("SENDGRID_API_KEY");
const OPS_EMAIL        = "devops@mysokoni.co.ke";

function requireAdmin(request) {
  if (!request.auth?.token?.isAdmin && !request.auth?.token?.isSuperAdmin) {
    throw new HttpsError("permission-denied", "Admin access required");
  }
}

function safe(settled) {
  return settled.status === "fulfilled" ? settled.value.data().count : null;
}

async function sendEmail(apiKey, to, subject, html) {
  const res = await fetch("https://api.sendgrid.com/v3/mail/send", {
    method:  "POST",
    headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body:    JSON.stringify({
      personalizations: [{ to: [{ email: to }] }],
      from:    { email: "noreply@mysokoni.co.ke", name: "SOKONI Ops" },
      subject,
      content: [{ type: "text/html", value: html }],
    }),
  });
  if (!res.ok) {
    const err = await res.text().catch(() => res.status);
    console.error("[sendEmail] SendGrid error:", err);
  }
}

/* ── scheduledDailyOpsReport ─────────────────────────────────────
   06:00 EAT (03:00 UTC). Queries 24h metrics, compares to yesterday,
   saves to ops_reports/{date}, emails devops@mysokoni.co.ke.
═══════════════════════════════════════════════════════════════════ */
exports.scheduledDailyOpsReport = onSchedule(
  {
    schedule:   "0 3 * * *",
    timeZone:   "Africa/Nairobi",
    secrets:    [SENDGRID_API_KEY],
    maxInstances: 1,
    timeoutSeconds: 120,
  },
  async () => {
    const db      = getFirestore();
    const now     = new Date();
    const today   = now.toISOString().split("T")[0];
    const since24 = Timestamp.fromMillis(Date.now() - 86400000);

    const [
      ordersAllSnap,
      ordersPaidSnap,
      ordersFailedSnap,
      emailFailSnap,
      cspSnap,
      openFeedbackSnap,
    ] = await Promise.allSettled([
      db.collection("orders")
        .where("createdAt", ">=", since24).count().get(),
      db.collection("orders")
        .where("status", "==", "paid")
        .where("createdAt", ">=", since24).count().get(),
      db.collection("orders")
        .where("status", "==", "payment_failed")
        .where("createdAt", ">=", since24).count().get(),
      db.collection("emailLogs")
        .where("status", "==", "failed")
        .where("sentAt", ">=", since24).count().get(),
      db.collection("cspViolations")
        .where("timestamp", ">=", since24).count().get(),
      db.collection("feedback")
        .where("status", "==", "new").count().get(),
    ]);

    const orders24h         = safe(ordersAllSnap);
    const paidOrders24h     = safe(ordersPaidSnap);
    const failedPayments24h = safe(ordersFailedSnap);
    const emailFailed24h    = safe(emailFailSnap);
    const cspViolations24h  = safe(cspSnap);
    const openFeedback      = safe(openFeedbackSnap);
    const paymentSuccessRate = (orders24h > 0 && paidOrders24h != null)
      ? Math.round((paidOrders24h / orders24h) * 100) : null;

    const metrics = {
      date: today, type: "daily",
      orders24h, paidOrders24h, failedPayments24h,
      emailFailed24h, cspViolations24h, openFeedback,
      paymentSuccessRate,
      generatedAt: now.toISOString(),
    };

    await db.collection("ops_reports").doc(today).set(metrics);

    /* Day-over-day delta */
    const yesterday = new Date(Date.now() - 86400000).toISOString().split("T")[0];
    let prev = null;
    try {
      const ySnap = await db.collection("ops_reports").doc(yesterday).get();
      if (ySnap.exists) prev = ySnap.data();
    } catch (_) {}

    function d(key) {
      if (!prev || metrics[key] == null || prev[key] == null) return "";
      const diff = metrics[key] - prev[key];
      const color = diff === 0 ? "#6b7280"
        : (key === "paidOrders24h" || key === "paymentSuccessRate") === (diff > 0)
          ? "#059669" : "#dc2626";
      return `<span style="color:${color};font-size:.8rem;margin-left:8px">${diff > 0 ? "+" : ""}${diff}${key === "paymentSuccessRate" ? "%" : ""}</span>`;
    }

    const rows = [
      ["Total Orders",         orders24h,          d("orders24h")],
      ["Paid Orders",          paidOrders24h,       d("paidOrders24h")],
      ["Failed Payments",      failedPayments24h,   d("failedPayments24h")],
      ["Payment Success Rate", paymentSuccessRate != null ? paymentSuccessRate + "%" : "—", d("paymentSuccessRate")],
      ["Email Failures",       emailFailed24h,      d("emailFailed24h")],
      ["CSP Violations",       cspViolations24h,    d("cspViolations24h")],
      ["Open Feedback",        openFeedback,        d("openFeedback")],
    ];

    const tableHtml = rows.map(([label, val, delta]) =>
      `<tr>
        <td style="padding:10px 14px;border-bottom:1px solid #f3f4f6;font-size:.875rem">${label}</td>
        <td style="padding:10px 14px;border-bottom:1px solid #f3f4f6;font-weight:700">${val ?? "—"}${delta}</td>
       </tr>`
    ).join("");

    const alerts = [];
    if (failedPayments24h > 5)   alerts.push("⚠️ Elevated payment failures — check getPaymentAuditTrail");
    if (cspViolations24h  > 50)  alerts.push("⚠️ CSP violation spike — check cspViolations collection");
    if (emailFailed24h    > 10)  alerts.push("⚠️ High email failure rate — check SendGrid dashboard");
    if (paymentSuccessRate != null && paymentSuccessRate < 80)
      alerts.push("🚨 Payment success rate below 80%");

    const alertHtml = alerts.length
      ? `<div style="background:#fef3c7;padding:12px 16px;margin:16px;border-radius:8px;font-size:.8rem">${alerts.join("<br>")}</div>`
      : `<div style="background:#d1fae5;padding:10px 16px;margin:16px;border-radius:8px;font-size:.8rem;color:#065f46">✅ No alerts — all metrics within normal range</div>`;

    const html = `
<div style="font-family:system-ui,sans-serif;max-width:580px;margin:0 auto">
  <div style="background:#5b21b6;color:#fff;padding:24px;border-radius:12px 12px 0 0">
    <h1 style="margin:0;font-size:1.125rem;font-weight:700">SOKONI Daily Ops Report</h1>
    <p style="margin:6px 0 0;opacity:.8;font-size:.875rem">${today}</p>
  </div>
  <div style="background:#fff;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 12px 12px">
    ${alertHtml}
    <table style="width:100%;border-collapse:collapse">
      <thead><tr style="background:#f9fafb">
        <th style="padding:8px 14px;text-align:left;font-size:.7rem;color:#6b7280;text-transform:uppercase">Metric</th>
        <th style="padding:8px 14px;text-align:left;font-size:.7rem;color:#6b7280;text-transform:uppercase">24h Value</th>
      </tr></thead>
      <tbody>${tableHtml}</tbody>
    </table>
    <div style="padding:16px;border-top:1px solid #f3f4f6;font-size:.8rem">
      <a href="https://mysokoni.co.ke/ops-dashboard" style="color:#5b21b6;text-decoration:none">View live dashboard →</a>
      &nbsp;·&nbsp;
      <a href="https://mysokoni.co.ke/business-kpi" style="color:#5b21b6;text-decoration:none">Business KPIs →</a>
    </div>
  </div>
</div>`;

    const sgKey = process.env.SENDGRID_API_KEY;
    if (sgKey) {
      await sendEmail(sgKey, OPS_EMAIL, `[SOKONI Ops] Daily Report — ${today}`, html);
    } else {
      console.warn("[DailyOps] SENDGRID_API_KEY not set — report saved but not emailed");
    }

    console.log(`[DailyOps] Report complete for ${today}. Orders: ${orders24h}, PaidRate: ${paymentSuccessRate}%`);
  }
);

/* ── scheduledWeeklySecurityReport ──────────────────────────────
   Monday 07:00 EAT (04:00 UTC). 7-day security digest.
═══════════════════════════════════════════════════════════════════ */
exports.scheduledWeeklySecurityReport = onSchedule(
  {
    schedule:   "0 4 * * 1",
    timeZone:   "Africa/Nairobi",
    secrets:    [SENDGRID_API_KEY],
    maxInstances: 1,
  },
  async () => {
    const db      = getFirestore();
    const since7d = Timestamp.fromMillis(Date.now() - 7 * 86400000);
    const weekEnd   = new Date().toISOString().split("T")[0];
    const weekStart = new Date(Date.now() - 7 * 86400000).toISOString().split("T")[0];

    const [cspSnap, failPaySnap, bugSnap, allPaySnap, paidPaySnap] = await Promise.allSettled([
      db.collection("cspViolations")
        .where("timestamp", ">=", since7d).count().get(),
      db.collection("orders")
        .where("status", "==", "payment_failed")
        .where("createdAt", ">=", since7d).count().get(),
      db.collection("feedback")
        .where("type", "==", "bug")
        .where("status", "==", "new").count().get(),
      db.collection("orders")
        .where("createdAt", ">=", since7d).count().get(),
      db.collection("orders")
        .where("status", "==", "paid")
        .where("createdAt", ">=", since7d).count().get(),
    ]);

    const csp7d        = safe(cspSnap);
    const failPay7d    = safe(failPaySnap);
    const openBugs     = safe(bugSnap);
    const allOrders7d  = safe(allPaySnap);
    const paidOrders7d = safe(paidPaySnap);
    const successRate7d = (allOrders7d > 0 && paidOrders7d != null)
      ? Math.round((paidOrders7d / allOrders7d) * 100) : null;

    const report = {
      weekStart, weekEnd, type: "weekly_security",
      cspViolations7d:    csp7d,
      failedPayments7d:   failPay7d,
      openBugReports:     openBugs,
      paymentSuccessRate7d: successRate7d,
      generatedAt:        new Date().toISOString(),
    };

    await db.collection("ops_reports").add(report);

    const scoreColor = successRate7d >= 95 ? "#059669" : successRate7d >= 80 ? "#d97706" : "#dc2626";
    const verdict = (failPay7d <= 5 && csp7d <= 20 && openBugs <= 10)
      ? "✅ Security posture: NORMAL"
      : "⚠️ Security posture: REVIEW REQUIRED";

    const html = `
<div style="font-family:system-ui,sans-serif;max-width:580px;margin:0 auto">
  <div style="background:#1e1b4b;color:#fff;padding:24px;border-radius:12px 12px 0 0">
    <h1 style="margin:0;font-size:1.125rem;font-weight:700">SOKONI Weekly Security Report</h1>
    <p style="margin:6px 0 0;opacity:.8;font-size:.875rem">${weekStart} → ${weekEnd}</p>
  </div>
  <div style="background:#fff;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 12px 12px;padding:20px">
    <p style="font-weight:700;margin-bottom:16px">${verdict}</p>
    <table style="width:100%;border-collapse:collapse">
      <tr><td style="padding:10px 0;border-bottom:1px solid #f3f4f6">CSP Violations (7d)</td>
          <td style="padding:10px 0;border-bottom:1px solid #f3f4f6;font-weight:700;text-align:right;color:${csp7d > 50 ? "#dc2626" : "#374151"}">${csp7d ?? "—"}</td></tr>
      <tr><td style="padding:10px 0;border-bottom:1px solid #f3f4f6">Failed Payments (7d)</td>
          <td style="padding:10px 0;border-bottom:1px solid #f3f4f6;font-weight:700;text-align:right;color:${failPay7d > 5 ? "#dc2626" : "#374151"}">${failPay7d ?? "—"}</td></tr>
      <tr><td style="padding:10px 0;border-bottom:1px solid #f3f4f6">Open Bug Reports</td>
          <td style="padding:10px 0;border-bottom:1px solid #f3f4f6;font-weight:700;text-align:right;color:${openBugs > 10 ? "#dc2626" : "#374151"}">${openBugs ?? "—"}</td></tr>
      <tr><td style="padding:10px 0">Payment Success Rate (7d)</td>
          <td style="padding:10px 0;font-weight:700;text-align:right;color:${scoreColor}">${successRate7d != null ? successRate7d + "%" : "—"}</td></tr>
    </table>
    <div style="margin-top:16px;padding-top:16px;border-top:1px solid #f3f4f6;font-size:.8rem">
      <a href="https://mysokoni.co.ke/ops-dashboard" style="color:#5b21b6;text-decoration:none">Ops dashboard →</a>
      &nbsp;·&nbsp;
      <a href="https://mysokoni.co.ke/admin-feedback" style="color:#5b21b6;text-decoration:none">Feedback triage →</a>
    </div>
  </div>
</div>`;

    const sgKey = process.env.SENDGRID_API_KEY;
    if (sgKey) {
      await sendEmail(sgKey, OPS_EMAIL,
        `[SOKONI Security] Weekly Report — ${weekStart} to ${weekEnd}`, html);
    }

    console.log(`[WeeklySecurity] Report sent ${weekStart}→${weekEnd}. CSP:${csp7d} FailPay:${failPay7d} Bugs:${openBugs}`);
  }
);

/* ── getDailyReport ──────────────────────────────────────────────── */
exports.getDailyReport = onCall(
  { maxInstances: 5 },
  async (request) => {
    requireAdmin(request);

    const { date, days = 30 } = request.data || {};
    const db = getFirestore();

    if (date) {
      const snap = await db.collection("ops_reports").doc(date).get();
      return snap.exists ? snap.data() : null;
    }

    /* Return last N daily reports ordered by date desc */
    const safeDays = Math.min(Math.max(Number(days) || 30, 1), 90);
    const snap = await db.collection("ops_reports")
      .where("type", "==", "daily")
      .orderBy("date", "desc")
      .limit(safeDays)
      .get();

    return snap.docs.map(d => d.data());
  }
);

/* ── getWeeklyReports ────────────────────────────────────────────── */
exports.getWeeklyReports = onCall(
  { maxInstances: 5 },
  async (request) => {
    requireAdmin(request);

    const { limit: lim = 12 } = request.data || {};
    const db = getFirestore();

    const snap = await db.collection("ops_reports")
      .where("type", "==", "weekly_security")
      .orderBy("generatedAt", "desc")
      .limit(Math.min(Number(lim) || 12, 52))
      .get();

    return snap.docs.map(d => d.data());
  }
);
