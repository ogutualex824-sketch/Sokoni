/* ============================================================
   SOKONI Ops Tools  v1.0

   Exports:
     cspReportCollect     — public  — collects CSP violation reports
     testPushNotification — onCall (admin) — sends a test FCM notification
     testEmailDelivery    — onCall (admin) — sends a test email
     getPaymentAuditTrail — onCall (admin) — last 100 payment events
     getOpsStatus         — onCall (admin) — ops dashboard snapshot
============================================================ */
"use strict";

const { onRequest, onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");

if (!admin.apps.length) admin.initializeApp();

const SENDGRID_KEY = defineSecret("SENDGRID_API_KEY");
const MAIL_HOST    = defineSecret("MAIL_HOST");
const MAIL_USER    = defineSecret("MAIL_USER");
const MAIL_PASS    = defineSecret("MAIL_PASS");

/* ── Admin gate ── */
function requireAdmin(request) {
  if (!request.auth) throw new HttpsError("unauthenticated", "Login required");
  const c = request.auth.token || {};
  if (!c.admin && !c.superAdmin) throw new HttpsError("permission-denied", "Admin access required");
}

/* ════════════════════════════════════════════════════════════════
   cspReportCollect
   Receives CSP violation reports from browsers (report-uri directive).
   Stores violations in Firestore for security analysis.
   Public endpoint — browsers POST without authentication.
════════════════════════════════════════════════════════════════ */
exports.cspReportCollect = onRequest(
  { invoker: "public", maxInstances: 20, timeoutSeconds: 10 },
  async (req, res) => {
    res.set("Cache-Control", "no-store");

    if (req.method !== "POST") {
      res.status(405).send("Method Not Allowed");
      return;
    }

    /* Browsers send as application/csp-report (JSON) or application/reports+json */
    let report = null;
    try {
      const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
      /* CSP Level 2 format */
      report = body["csp-report"] || body;
      /* CSP Level 3 Reporting API format */
      if (Array.isArray(body)) report = body[0]?.body || body[0];
    } catch (_) {
      res.status(400).send("Bad Request");
      return;
    }

    if (!report) {
      res.status(204).send();
      return;
    }

    /* Extract key violation fields */
    const doc = {
      blockedUri:       report["blocked-uri"]        || report.blockedURL        || null,
      violatedDirective:report["violated-directive"]  || report.effectiveDirective || null,
      documentUri:      report["document-uri"]        || report.documentURL       || null,
      originalPolicy:   null, /* omit — too large */
      sourceFile:       report["source-file"]         || null,
      lineNumber:       report["line-number"]         || null,
      colNumber:        report["column-number"]       || null,
      userAgent:        req.headers["user-agent"]     || null,
      ip:               req.ip                        || null,
      timestamp:        admin.firestore.FieldValue.serverTimestamp(),
    };

    /* Skip self-referential reports and noise */
    const blocked = doc.blockedUri || "";
    if (blocked === "about" || blocked === "data" || blocked === "blob") {
      res.status(204).send();
      return;
    }

    await admin.firestore().collection("cspViolations").add(doc).catch(() => {});
    res.status(204).send();
  }
);

/* ════════════════════════════════════════════════════════════════
   testPushNotification
   Admin-only: sends a test FCM notification to a specific FCM token.
   Use this to verify end-to-end push delivery.
════════════════════════════════════════════════════════════════ */
exports.testPushNotification = onCall(
  { maxInstances: 5 },
  async (request) => {
    requireAdmin(request);

    const { fcmToken, targetUid } = request.data || {};
    let token = fcmToken;

    /* Resolve token from UID if not provided directly */
    if (!token && targetUid) {
      const snap = await admin.firestore().collection("fcmTokens").doc(targetUid).get();
      if (!snap.exists()) throw new HttpsError("not-found", "No FCM token found for this user");
      token = snap.data().token;
    }

    if (!token) throw new HttpsError("invalid-argument", "fcmToken or targetUid required");

    const message = {
      token,
      notification: {
        title: "🟢 SOKONI Push Test",
        body:  "Push notifications are working correctly.",
      },
      data: {
        url:       "/index.html",
        testAt:    new Date().toISOString(),
        testBy:    request.auth.uid,
      },
      webpush: {
        notification: {
          icon:  "/assets/sokoni logoo.jpeg",
          badge: "/assets/badge-96.png",
          vibrate: [200, 100, 200],
        },
      },
    };

    const result = await admin.messaging().send(message);
    console.log(`[testPushNotification] Sent by ${request.auth.uid} → ${result}`);
    return { success: true, messageId: result };
  }
);

/* ════════════════════════════════════════════════════════════════
   testEmailDelivery
   Admin-only: sends a real test email to a target address.

   Renders through the PRODUCTION template (email-templates.base) — the same
   header, logo and dark-mode CSS every real SOKONI email uses.

   This matters. The previous version emitted a bare inline <div> with no
   template and no logo, so it could only prove that SendGrid was reachable.
   It could not have caught the logo-rendering defect, because it never
   rendered the logo. A delivery test that does not exercise the production
   template is not a test of production email.

   Pass `template` to send any of the 53 real templates instead (rendered with
   representative sample data), so branding can be verified across email
   classes — not just this one.
════════════════════════════════════════════════════════════════ */
exports.testEmailDelivery = onCall(
  {
    maxInstances: 5,
    secrets: [SENDGRID_KEY, MAIL_HOST, MAIL_USER, MAIL_PASS],
  },
  async (request) => {
    requireAdmin(request);

    const { to, template } = request.data || {};
    if (!to || !to.includes("@")) throw new HttpsError("invalid-argument", "valid 'to' email required");

    const emailSvc = require("./email-service");
    const tpl      = require("./email-templates");
    const sentAt   = new Date().toLocaleString("en-KE", { timeZone: "Africa/Nairobi" });

    let payload;

    if (template) {
      /* Render a real production template with representative sample data. */
      if (!tpl.TEMPLATES[template]) {
        throw new HttpsError(
          "invalid-argument",
          `Unknown template "${template}". Available: ${Object.keys(tpl.TEMPLATES).join(", ")}`
        );
      }
      const sample = {
        name: "SOKONI Test", firstName: "Test", email: to,
        orderId: "TEST-0000", orderNumber: "TEST-0000",
        amount: 1, total: 1, currency: "KES",
        items: [{ name: "Test item", qty: 1, price: 1 }],
        url: "https://mysokoni.co.ke", link: "https://mysokoni.co.ke",
        code: "000000", reason: "Delivery test", status: "test",
        date: sentAt, businessName: "SOKONI Test Merchant",
      };
      const r = tpl.getTemplate(template, sample);
      payload = {
        to, from: r.from, category: r.category,
        subject: `[TEST] ${r.subject}`,
        html: r.html, text: r.text,
      };
    } else {
      /* Default: a branded delivery test rendered through the production base()
         template — so it carries the real header and the real logo. */
      const html = tpl.base({
        title:     "Email Delivery Confirmed",
        preheader: "SOKONI production email delivery + branding test",
        body: `
          <p style="margin:0 0 16px;">This test email was sent from the <strong>SOKONI production platform</strong>.</p>
          <p style="margin:0 0 20px;">It is rendered with the <strong>real production template</strong>, so the header and
          logo above are exactly what every SOKONI email shows.</p>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:0 0 20px;">
            <tr><td style="padding:8px 10px;border:1px solid #2a2f37;font-weight:700;">Sent at</td><td style="padding:8px 10px;border:1px solid #2a2f37;">${sentAt} (EAT)</td></tr>
            <tr><td style="padding:8px 10px;border:1px solid #2a2f37;font-weight:700;">Requested by</td><td style="padding:8px 10px;border:1px solid #2a2f37;">${request.auth.uid}</td></tr>
            <tr><td style="padding:8px 10px;border:1px solid #2a2f37;font-weight:700;">Project</td><td style="padding:8px 10px;border:1px solid #2a2f37;">sokoni-aeb26</td></tr>
            <tr><td style="padding:8px 10px;border:1px solid #2a2f37;font-weight:700;">Environment</td><td style="padding:8px 10px;border:1px solid #2a2f37;">Production</td></tr>
          </table>
          <p style="margin:0 0 8px;font-weight:700;">Logo check — the mark above must be:</p>
          <p style="margin:0 0 20px;">Crisp (not blurry) &middot; fully opaque (not faded or washed out) &middot; complete
          (no missing strokes) &middot; correctly proportioned. Check this in <strong>both light and dark mode</strong>.</p>
          <p style="margin:0;font-size:12px;opacity:.7;">If you did not request this test, contact security@mysokoni.co.ke</p>
        `,
      });
      payload = {
        to,
        from:     emailSvc.FROM.tech,
        subject:  "SOKONI — Email Delivery & Branding Test",
        category: "system",
        html,
        text:     tpl.toPlainText(html),
      };
    }

    const result = await emailSvc.send(payload);

    console.log(`[testEmailDelivery] to=${to} template=${template || "base"} by=${request.auth.uid}`, result);
    return {
      success:   true,
      provider:  result.provider,
      messageId: result.messageId || null,
      template:  template || "base",
      sentAt,
    };
  }
);

/* ════════════════════════════════════════════════════════════════
   getPaymentAuditTrail
   Admin-only: last 100 payment-related events across orders,
   deliveryFees, and sellerStats collections.
════════════════════════════════════════════════════════════════ */
exports.getPaymentAuditTrail = onCall(
  { maxInstances: 5 },
  async (request) => {
    requireAdmin(request);

    const { limit = 50, status, sellerId, since } = request.data || {};
    const db = admin.firestore();

    let q = db.collection("orders").orderBy("createdAt", "desc");
    if (status)   q = q.where("status", "==", status);
    if (sellerId) q = q.where("sellerUid", "==", sellerId);
    if (since)    q = q.where("createdAt", ">=", admin.firestore.Timestamp.fromMillis(since));
    q = q.limit(Math.min(Number(limit) || 50, 200));

    const [ordersSnap, feesSnap] = await Promise.all([
      q.get(),
      db.collection("deliveryFees")
        .orderBy("createdAt", "desc")
        .limit(50)
        .get(),
    ]);

    const orders = ordersSnap.docs.map(d => {
      const data = d.data();
      return {
        id:           d.id,
        type:         "order",
        status:       data.status,
        amount:       data.orderTotal || data.total,
        currency:     "KES",
        buyerUid:     data.buyerUid || data.uid || null,
        sellerUid:    data.sellerUid || data.sellerId,
        paymentRef:   data.paymentRef || null,
        paymentMethod:data.paymentMethod || null,
        createdAt:    data.createdAt?.toMillis?.() || null,
        statusHistory:data.statusHistory || [],
      };
    });

    const fees = feesSnap.docs.map(d => {
      const data = d.data();
      return {
        id:           d.id,
        type:         "delivery_fee",
        orderId:      data.orderId,
        sellerUid:    data.sellerUid,
        riderUid:     data.riderUid,
        platformFee:  data.platformFeeKES,
        riderFee:     data.riderFeeKES,
        total:        data.totalFeeKES,
        status:       data.status,
        createdAt:    data.createdAt?.toMillis?.() || null,
      };
    });

    /* Aggregate summary */
    const paidOrders  = orders.filter(o => ["paid","delivered","completed"].includes(o.status));
    const totalVolume = paidOrders.reduce((s, o) => s + (Number(o.amount) || 0), 0);

    return {
      orders,
      deliveryFees: fees,
      summary: {
        totalOrders:     orders.length,
        paidOrders:      paidOrders.length,
        totalVolumeKES:  totalVolume,
        generatedAt:     Date.now(),
      },
    };
  }
);

/* ════════════════════════════════════════════════════════════════
   getOpsStatus
   Admin-only: comprehensive operational snapshot for the
   admin ops dashboard. Combines health, queue depths,
   recent errors, and platform metrics.
════════════════════════════════════════════════════════════════ */
exports.getOpsStatus = onCall(
  { maxInstances: 5 },
  async (request) => {
    requireAdmin(request);

    const db = admin.firestore();

    /* Run all queries in parallel */
    const [
      emailQueueSnap,
      emailFailedSnap,
      cspViolationsSnap,
      recentOrdersSnap,
      backupsSnap,
    ] = await Promise.allSettled([
      db.collection("emailQueue").where("status","==","pending").count().get(),
      db.collection("emailLogs").where("status","==","failed")
        .where("sentAt",">=", admin.firestore.Timestamp.fromMillis(Date.now() - 24*3600*1000))
        .count().get(),
      db.collection("cspViolations")
        .where("timestamp",">=", admin.firestore.Timestamp.fromMillis(Date.now() - 24*3600*1000))
        .count().get(),
      db.collection("orders")
        .where("createdAt",">=", admin.firestore.Timestamp.fromMillis(Date.now() - 24*3600*1000))
        .count().get(),
      db.collection("ops_backups").orderBy("timestamp","desc").limit(1).get(),
    ]);

    const safeCount = (settled) =>
      settled.status === "fulfilled" ? settled.value.data().count : -1;

    const lastBackupDoc = backupsSnap.status === "fulfilled" && !backupsSnap.value.empty
      ? backupsSnap.value.docs[0].data()
      : null;

    return {
      queues: {
        emailPending: safeCount(emailQueueSnap),
        emailFailed24h: safeCount(emailFailedSnap),
      },
      security: {
        cspViolations24h: safeCount(cspViolationsSnap),
      },
      commerce: {
        orders24h: safeCount(recentOrdersSnap),
      },
      backups: {
        lastBackupAt:   lastBackupDoc?.timestamp?.toMillis?.() || null,
        lastBackupDest: lastBackupDoc?.destination || null,
        lastBackupStatus: lastBackupDoc?.status || null,
      },
      generatedAt: Date.now(),
    };
  }
);
