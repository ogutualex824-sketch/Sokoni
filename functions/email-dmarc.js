/**
 * SOKONI DMARC Report Processor
 *
 * Parses DMARC aggregate reports (XML) and stores results in Firestore.
 * Also provides a SendGrid Inbound Parse webhook for automated report ingestion.
 *
 * Cloud Functions exported:
 *   processDmarcReport   — onCall: admin uploads XML text manually
 *   dmarcReportWebhook   — HTTP: SendGrid Inbound Parse posts email here
 *   getDmarcSummary      — onCall: returns aggregate stats for Email Center
 *
 * Firestore collections:
 *   dmarcReports/{reportId}        — parsed aggregate report
 *   dmarcReports/{reportId}/records/{ip} — individual record rows
 *   dmarcAlerts/{alertId}          — policy failure alerts
 */

"use strict";

const _ac = require('./admin-claim');
const { onCall, onRequest, HttpsError }   = require("firebase-functions/v2/https");
const { onDocumentCreated }               = require("firebase-functions/v2/firestore");
const admin                               = require("firebase-admin");
const { EMAIL_SECRETS, FROM }             = require("./email-service");
const emailSvc                            = require("./email-service");

const db = admin.firestore;

/* ─── XML parser ─────────────────────────────────────────────────────
   DMARC aggregate reports use a fixed XML schema (RFC 7489 Appendix C).
   We parse with regex to avoid adding xml2js dependency.
─────────────────────────────────────────────────────────────────────── */

function xmlText(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return m ? m[1].trim() : null;
}

function xmlAll(xml, tag) {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "gi");
  const out = [];
  let m;
  while ((m = re.exec(xml)) !== null) out.push(m[1].trim());
  return out;
}

function parseDmarcXml(xml) {
  /* Validate it looks like a DMARC report */
  if (!xml.includes("<feedback>") && !xml.includes("<feedback ")) {
    throw new Error("Not a valid DMARC aggregate report XML — <feedback> element missing");
  }

  const meta = xmlText(xml, "report_metadata") || "";
  const policy = xmlText(xml, "policy_published") || "";

  const report = {
    /* Metadata */
    orgName:    xmlText(meta, "org_name")  || "Unknown",
    orgEmail:   xmlText(meta, "email")     || "",
    reportId:   xmlText(meta, "report_id") || `${Date.now()}`,
    beginDate:  null,
    endDate:    null,
    /* Policy */
    domain:     xmlText(policy, "domain")  || "",
    policyP:    xmlText(policy, "p")       || "none",
    policyAdkim: xmlText(policy, "adkim")  || "r",
    policyAspf: xmlText(policy, "aspf")    || "r",
    policyPct:  parseInt(xmlText(policy, "pct") || "100", 10),
    /* Totals */
    totalMessages:  0,
    dkimPassCount:  0,
    spfPassCount:   0,
    dmarcPassCount: 0,
    failCount:      0,
    records: [],
  };

  /* Date range */
  const dateRange = xmlText(xml, "date_range") || "";
  const begin = parseInt(xmlText(dateRange, "begin") || "0", 10);
  const end   = parseInt(xmlText(dateRange, "end")   || "0", 10);
  if (begin) report.beginDate = new Date(begin * 1000).toISOString();
  if (end)   report.endDate   = new Date(end   * 1000).toISOString();

  /* Individual records */
  const recordBlocks = xmlAll(xml, "record");
  for (const block of recordBlocks) {
    const row        = xmlText(block, "row")         || "";
    const ids        = xmlText(block, "identifiers") || "";
    const authResult = xmlText(block, "auth_results") || "";

    const count      = parseInt(xmlText(row, "count") || "1", 10);
    const evaluated  = xmlText(row, "policy_evaluated") || "";

    const dkimResult = xmlText(evaluated, "dkim") || "fail";
    const spfResult  = xmlText(evaluated, "spf")  || "fail";
    const disposition = xmlText(evaluated, "disposition") || "none";

    const dmarcPass  = dkimResult === "pass" || spfResult === "pass";

    /* Auth results — may have multiple DKIM entries */
    const dkimDetails = xmlAll(authResult, "dkim").map(d => ({
      domain:   xmlText(d, "domain")   || "",
      result:   xmlText(d, "result")   || "fail",
      selector: xmlText(d, "selector") || "",
    }));
    const spfDetails = xmlAll(authResult, "spf").map(s => ({
      domain: xmlText(s, "domain") || "",
      result: xmlText(s, "result") || "fail",
      scope:  xmlText(s, "scope")  || "mfrom",
    }));

    const rec = {
      sourceIp:    xmlText(row, "source_ip") || "",
      count,
      disposition,
      dkimResult,
      spfResult,
      dmarcPass,
      headerFrom:  xmlText(ids, "header_from") || "",
      dkimDetails,
      spfDetails,
    };

    report.records.push(rec);
    report.totalMessages  += count;
    if (dkimResult === "pass") report.dkimPassCount  += count;
    if (spfResult  === "pass") report.spfPassCount   += count;
    if (dmarcPass)             report.dmarcPassCount += count;
    else                       report.failCount      += count;
  }

  report.dkimPassRate  = report.totalMessages
    ? Math.round((report.dkimPassCount / report.totalMessages) * 100) : 0;
  report.spfPassRate   = report.totalMessages
    ? Math.round((report.spfPassCount  / report.totalMessages) * 100) : 0;
  report.dmarcPassRate = report.totalMessages
    ? Math.round((report.dmarcPassCount / report.totalMessages) * 100) : 0;

  return report;
}

/* ─── Save to Firestore ─────────────────────────────────────────────── */
async function saveReport(report) {
  const firestore = admin.firestore();
  const docId = `${report.orgName.replace(/[^a-z0-9]/gi, "_")}_${report.reportId}`.toLowerCase();
  const ref = firestore.collection("dmarcReports").doc(docId);

  const { records, ...meta } = report;

  await firestore.runTransaction(async tx => {
    tx.set(ref, {
      ...meta,
      recordCount: records.length,
      savedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    for (const rec of records) {
      const recId = rec.sourceIp.replace(/\./g, "_");
      tx.set(ref.collection("records").doc(recId), {
        ...rec,
        savedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }
  });

  /* Fire alert if DMARC pass rate drops below 95% */
  if (report.dmarcPassRate < 95 && report.totalMessages >= 5) {
    await firestore.collection("dmarcAlerts").add({
      reportId:      docId,
      orgName:       report.orgName,
      dmarcPassRate: report.dmarcPassRate,
      failCount:     report.failCount,
      totalMessages: report.totalMessages,
      domain:        report.domain,
      beginDate:     report.beginDate,
      severity:      report.dmarcPassRate < 80 ? "critical" : "warning",
      resolved:      false,
      createdAt:     admin.firestore.FieldValue.serverTimestamp(),
    });
  }

  return { docId, records: records.length };
}

/* ─── onCall: Admin uploads XML manually ────────────────────────────── */
exports.processDmarcReport = onCall(
  { secrets: EMAIL_SECRETS, enforceAppCheck: true },
  async (req) => {
    const { uid, token } = req.auth || {};
    if (!uid || !_ac.isAdmin(token)) {
      throw new HttpsError("permission-denied", "Admin only");
    }

    const { xml, base64 } = req.data || {};
    let xmlStr = xml;

    if (!xmlStr && base64) {
      xmlStr = Buffer.from(base64, "base64").toString("utf8");
    }

    if (!xmlStr || typeof xmlStr !== "string") {
      throw new HttpsError("invalid-argument", "xml or base64 field required");
    }

    let report;
    try {
      report = parseDmarcXml(xmlStr);
    } catch (e) {
      throw new HttpsError("invalid-argument", e.message);
    }

    const saved = await saveReport(report);

    /* Email security team if failures detected */
    if (report.failCount > 0) {
      try {
        await emailSvc.send({
          to:       "security@mysokoni.co.ke",
          from:     FROM.security,
          subject:  `DMARC Alert: ${report.failCount} failures from ${report.orgName}`,
          html: `<p>DMARC aggregate report from <strong>${report.orgName}</strong> for ${report.domain}.</p>
                 <ul>
                   <li>Total messages: ${report.totalMessages}</li>
                   <li>DMARC pass rate: ${report.dmarcPassRate}%</li>
                   <li>Failed: ${report.failCount}</li>
                   <li>Period: ${report.beginDate} – ${report.endDate}</li>
                 </ul>
                 <p>Review in <a href="https://mysokoni.co.ke/email-center.html">Email Center → DMARC Reports</a></p>`,
          category: "system",
          template: "dmarc-alert",
          emailId:  `dmarc-alert-${saved.docId}`,
        });
      } catch (e) {
        console.warn("[DMARC] Alert email failed:", e.message);
      }
    }

    return {
      success:       true,
      docId:         saved.docId,
      reportId:      report.reportId,
      orgName:       report.orgName,
      totalMessages: report.totalMessages,
      dmarcPassRate: report.dmarcPassRate,
      failCount:     report.failCount,
      records:       saved.records,
    };
  }
);

/* ─── HTTP: SendGrid Inbound Parse webhook ──────────────────────────── */
/*
   Setup:
   1. Add MX record for reports.mysokoni.co.ke → mx.sendgrid.net (priority 10)
   2. In SendGrid → Settings → Inbound Parse → add host "reports.mysokoni.co.ke"
      URL: https://us-central1-sokoni-aeb26.cloudfunctions.net/dmarcReportWebhook
   3. Forward dmarc@mysokoni.co.ke to dmarc@reports.mysokoni.co.ke in HostPinnacle
*/
exports.dmarcReportWebhook = onRequest(
  { cors: false, invoker: "public" },
  async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).send("Method Not Allowed");
      return;
    }

    try {
      /* SendGrid Inbound Parse sends multipart form data */
      const text       = req.body?.text || req.body?.html || "";
      const rawEmail   = req.body?.email || "";
      const from       = req.body?.from  || "";
      const subject    = req.body?.subject || "";
      const attachments = parseInt(req.body?.attachments || "0", 10);

      console.log(`[DMARC Webhook] From: ${from}, Subject: ${subject}, Attachments: ${attachments}`);

      /* SendGrid sends attachments as attachment1, attachment2, ... */
      let xmlStr = null;
      for (let i = 1; i <= attachments; i++) {
        const att  = req.body[`attachment${i}`];
        const info = req.body[`attachment-info`] ? JSON.parse(req.body[`attachment-info`]) : {};
        const attInfo = info[`attachment${i}`] || {};
        const ct = attInfo["content-type"] || "";

        if (!att) continue;

        /* DMARC reports arrive as application/zip or application/gzip */
        if (ct.includes("zip") || ct.includes("gzip") || ct.includes("xml")) {
          if (ct.includes("xml")) {
            xmlStr = att.toString("utf8");
          } else {
            /* ZIP/GZIP — Node built-in zlib */
            const zlib = require("zlib");
            try {
              if (ct.includes("gzip")) {
                xmlStr = zlib.gunzipSync(Buffer.from(att, "binary")).toString("utf8");
              } else {
                /* ZIP — use zlib inflateRaw on the deflated stream inside zip */
                const buf = Buffer.from(att, "binary");
                /* Find the local file header (PK\x03\x04) and extract deflated data */
                const zipSig = Buffer.from([0x50, 0x4B, 0x03, 0x04]);
                const pkIdx  = buf.indexOf(zipSig);
                if (pkIdx !== -1) {
                  const fnLen  = buf.readUInt16LE(pkIdx + 26);
                  const extraLen = buf.readUInt16LE(pkIdx + 28);
                  const dataStart = pkIdx + 30 + fnLen + extraLen;
                  const compMethod = buf.readUInt16LE(pkIdx + 8);
                  const compSize   = buf.readUInt32LE(pkIdx + 18);
                  const compressed = buf.slice(dataStart, dataStart + compSize);
                  xmlStr = compMethod === 0
                    ? compressed.toString("utf8")
                    : zlib.inflateRawSync(compressed).toString("utf8");
                }
              }
            } catch (zlibErr) {
              console.warn("[DMARC Webhook] Failed to decompress attachment:", zlibErr.message);
            }
          }
          if (xmlStr) break;
        }
      }

      if (!xmlStr) {
        console.warn("[DMARC Webhook] No XML content found in email from:", from);
        res.status(200).send("OK — no XML attachment found");
        return;
      }

      let report;
      try {
        report = parseDmarcXml(xmlStr);
      } catch (parseErr) {
        console.warn("[DMARC Webhook] XML parse failed:", parseErr.message);
        res.status(200).send("OK — XML parse error: " + parseErr.message);
        return;
      }

      await saveReport(report);

      console.log(`[DMARC Webhook] Saved report from ${report.orgName}: ` +
                  `${report.dmarcPassRate}% pass rate, ${report.totalMessages} messages`);
      res.status(200).send("OK");

    } catch (e) {
      console.error("[DMARC Webhook] Error:", e.message, e.stack);
      /* Always return 200 to SendGrid to avoid retry storms */
      res.status(200).send("OK — internal error: " + e.message);
    }
  }
);

/* ─── onCall: Get DMARC summary for Email Center ────────────────────── */
exports.getDmarcSummary = onCall(
  { enforceAppCheck: true },
  async (req) => {
    const { uid, token } = req.auth || {};
    if (!uid || !_ac.isAdmin(token)) {
      throw new HttpsError("permission-denied", "Admin only");
    }

    const firestore = admin.firestore();

    /* Last 30 reports */
    const snap = await firestore.collection("dmarcReports")
      .orderBy("savedAt", "desc")
      .limit(30)
      .get();

    const reports = snap.docs.map(d => {
      const data = d.data();
      return {
        id:            d.id,
        orgName:       data.orgName,
        domain:        data.domain,
        totalMessages: data.totalMessages,
        dmarcPassRate: data.dmarcPassRate,
        dkimPassRate:  data.dkimPassRate,
        spfPassRate:   data.spfPassRate,
        failCount:     data.failCount,
        beginDate:     data.beginDate,
        endDate:       data.endDate,
        policyP:       data.policyP,
        savedAt:       data.savedAt?.toDate?.()?.toISOString?.() || null,
      };
    });

    /* Open alerts */
    const alertSnap = await firestore.collection("dmarcAlerts")
      .where("resolved", "==", false)
      .orderBy("createdAt", "desc")
      .limit(10)
      .get();

    const alerts = alertSnap.docs.map(d => ({ id: d.id, ...d.data() }));

    /* Aggregate totals */
    const totals = reports.reduce((acc, r) => {
      acc.messages += r.totalMessages || 0;
      acc.failures += r.failCount     || 0;
      return acc;
    }, { messages: 0, failures: 0 });

    totals.overallPassRate = totals.messages
      ? Math.round(((totals.messages - totals.failures) / totals.messages) * 100)
      : 100;

    return { reports, alerts, totals };
  }
);
