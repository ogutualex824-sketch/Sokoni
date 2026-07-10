"use strict";
/* ═══════════════════════════════════════════════════════════════════
   SOKONI  Hub eTIMS & Logistics Documents  v1.0
   functions/hub-etims.js

   Hub type routing
   ────────────────
   logistics   → operational docs only — no KRA tax invoices
   selling     → KRA tax invoices under hub's own KRA PIN + op docs
   marketplace → seller issues eTIMS; hub issues op docs only
   hybrid      → selling + logistics combined

   Invoice authority (stored on orders.invoiceAuthority)
   ──────────────────────────────────────────────────────
   "seller"   → functions/etims.js  etimsOnOrderCompleted handles it
   "hub"      → this module         hubOnOrderCompleted  handles it
   "platform" → functions/etims.js  etimsPlatformInvoice handles it

   Operational document types (never submitted to KRA)
   ────────────────────────────────────────────────────
   pickup_receipt       seller → hub hand-off
   warehouse_receipt    hub receives into warehouse
   dispatch_note        hub → delivery agent/buyer
   return_confirmation  returned goods received by hub
   transfer_note        hub → hub inter-transfer
═══════════════════════════════════════════════════════════════════ */

const { onCall, HttpsError, onRequest } = require("firebase-functions/v2/https");
const { onDocumentWritten }             = require("firebase-functions/v2/firestore");
const { defineSecret }                  = require("firebase-functions/params");
const admin    = require("firebase-admin");
const crypto   = require("crypto");
const https    = require("https");
const emailSvc = require("./email-service");

if (!admin.apps.length) admin.initializeApp();

const ETIMS_MASTER_KEY = defineSecret("ETIMS_MASTER_KEY");
const EMAIL_SECRETS    = emailSvc.EMAIL_SECRETS;
const ETIMS_ENV        = process.env.ETIMS_ENV || "sandbox";
const ETIMS_HOST       = ETIMS_ENV === "production"
  ? "etims-api.kra.go.ke"
  : "etims-api-sandbox.kra.go.ke";

const db      = admin.firestore();
function _bucket() { return admin.storage().bucket(); }

/* ── Document-type registry ────────────────────────────────────────── */
const DOC_TYPES = {
  pickup_receipt:      { label: "Pickup Receipt",      prefix: "PKP", seqField: "pickupSeq"    },
  warehouse_receipt:   { label: "Warehouse Receipt",   prefix: "WHS", seqField: "warehouseSeq" },
  dispatch_note:       { label: "Dispatch Note",       prefix: "DSP", seqField: "dispatchSeq"  },
  return_confirmation: { label: "Return Confirmation", prefix: "RTN", seqField: "returnSeq"    },
  transfer_note:       { label: "Transfer Note",       prefix: "TRF", seqField: "transferSeq"  },
};

/* ── KRA eTIMS client (for selling hubs) ───────────────────────────── */
class EtimsClient {
  constructor({ tin, bhfId = "00", deviceSerial, taxpayerSecret }) {
    this.tin            = tin;
    this.bhfId          = bhfId;
    this.deviceSerial   = deviceSerial;
    this.taxpayerSecret = taxpayerSecret;
  }
  _token() {
    const ts  = Date.now().toString();
    const raw = `${this.tin}${this.bhfId}${ts}`;
    const sig = crypto.createHmac("sha256", this.taxpayerSecret)
      .update(raw).digest("hex").toUpperCase();
    return `${ts}:${sig}`;
  }
  _post(path, body) {
    return new Promise((resolve, reject) => {
      const payload = JSON.stringify(body);
      const opts = {
        hostname: ETIMS_HOST, port: 443, path: `/etims-api${path}`,
        method: "POST",
        headers: {
          "Content-Type":   "application/json",
          "Content-Length": Buffer.byteLength(payload),
          "cmcKey":  this._token(),
          "tin":     this.tin,
          "bhfId":   this.bhfId,
          "dvcSrlNo":this.deviceSerial,
        },
        timeout: 20_000,
      };
      const req = https.request(opts, res => {
        let raw = "";
        res.on("data", d => (raw += d));
        res.on("end",  () => {
          try { resolve(JSON.parse(raw)); }
          catch { resolve({ resultCd: "PARSE_ERR", resultMsg: raw }); }
        });
      });
      req.on("error",   reject);
      req.on("timeout", () => { req.destroy(); reject(new Error("KRA API timeout")); });
      req.write(payload);
      req.end();
    });
  }
  validatePin()          { return this._post("/selectInitOrgInfo",  { tin: this.tin, bhfId: this.bhfId }); }
  submitInvoice(payload) { return this._post("/saveTrnsSalesSdcInfo", payload); }
  verifyInvoice(invcNo)  { return this._post("/selectTrnsSdcInfo",  { tin: this.tin, bhfId: this.bhfId, invcNo }); }
}

/* ── Credential encryption ─────────────────────────────────────────── */
function _masterKey() {
  const k = ETIMS_MASTER_KEY.value();
  if (!k || k.length < 64) throw new Error("ETIMS_MASTER_KEY missing or too short");
  return Buffer.from(k.slice(0, 64), "hex");
}
function encryptCred(plaintext) {
  const iv  = crypto.randomBytes(12);
  const cip = crypto.createCipheriv("aes-256-gcm", _masterKey(), iv);
  const enc = Buffer.concat([cip.update(plaintext, "utf8"), cip.final()]);
  const tag = cip.getAuthTag();
  return `${iv.toString("hex")}:${tag.toString("hex")}:${enc.toString("hex")}`;
}
function decryptCred(cipher) {
  const [ivHex, tagHex, encHex] = cipher.split(":");
  const iv  = Buffer.from(ivHex,  "hex");
  const tag = Buffer.from(tagHex, "hex");
  const enc = Buffer.from(encHex, "hex");
  const dec = crypto.createDecipheriv("aes-256-gcm", _masterKey(), iv);
  dec.setAuthTag(tag);
  return Buffer.concat([dec.update(enc), dec.final()]).toString("utf8");
}

/* ── Atomic sequences ──────────────────────────────────────────────── */
async function nextSeq(hubId, seqField) {
  const ref = db.collection("hubSequences").doc(hubId);
  return db.runTransaction(async t => {
    const snap = await t.get(ref);
    const next = ((snap.exists ? snap.data()[seqField] : 0) || 0) + 1;
    t.set(ref, { [seqField]: next, updatedAt: new Date().toISOString() }, { merge: true });
    return next;
  });
}
function fmtDocNumber(hubId, prefix, seq) {
  const y   = new Date().getFullYear();
  const hub = hubId.replace(/[^A-Za-z0-9]/g, "").toUpperCase().slice(0, 6);
  return `${prefix}-${hub}-${y}-${String(seq).padStart(6, "0")}`;
}

/* ── HTML helpers ──────────────────────────────────────────────────── */
function esc(s) {
  return String(s || "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
}
function fmtKES(n) {
  return "KES " + Number(n || 0).toLocaleString("en-KE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/* ── Operational document HTML ─────────────────────────────────────── */
function buildDocumentHtml({ docType, docNumber, hub, seller, buyer, order, items, notes, signedBy, meta, issuedAt }) {
  const info       = DOC_TYPES[docType] || { label: docType };
  const verifyUrl  = `https://mysokoni.co.ke/verify/doc/${encodeURIComponent(docNumber)}`;
  const issuedDate = new Date(issuedAt).toLocaleString("en-KE", { dateStyle: "medium", timeStyle: "short" });

  const itemRows = (items || []).map(i => `
    <tr>
      <td>${esc(i.name || i.description || "Item")}</td>
      <td class="r">${i.qty || i.quantity || 1}</td>
      <td>${esc(i.unit || "pcs")}</td>
      <td>${esc(i.sku || i.barcode || "—")}</td>
      <td>${esc(i.condition || "Good")}</td>
    </tr>`).join("");

  const metaRows = Object.entries(meta || {}).map(([k, v]) =>
    `<tr><td style="color:#888;font-size:9pt">${esc(k)}</td><td>${esc(String(v))}</td></tr>`).join("");

  const receiverLabel = {
    pickup_receipt:      "Received By (Hub Staff)",
    warehouse_receipt:   "Accepted By (Warehouse)",
    dispatch_note:       "Released By (Hub)",
    return_confirmation: "Received By (Hub Staff)",
    transfer_note:       "Released By (Origin Hub)",
  }[docType] || "Authorised By";

  const handoverLabel = {
    pickup_receipt:      "Handed Over By (Seller)",
    warehouse_receipt:   "Delivered By",
    dispatch_note:       "Received By (Buyer / Agent)",
    return_confirmation: "Returned By (Buyer)",
    transfer_note:       "Accepted By (Destination Hub)",
  }[docType] || "Witnessed By";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(info.label)} — ${esc(docNumber)}</title>
<style>
@page{size:A4;margin:18mm 20mm}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:Arial,Helvetica,sans-serif;font-size:11pt;color:#111;background:#fff;line-height:1.4}
.page{max-width:170mm;margin:0 auto;padding:10px 0}
.hdr{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2.5px solid #111;padding-bottom:10px;margin-bottom:16px}
.logo{font-size:22pt;font-weight:900;letter-spacing:-1px}.logo span{color:#4a0}
.doc-right{text-align:right}
.doc-right h1{font-size:14pt;text-transform:uppercase;letter-spacing:1px;color:#333}
.doc-right .num{font-size:10pt;color:#555;margin-top:3px}
.doc-right .date{font-size:9pt;color:#777;margin-top:2px}
.parties{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px}
.box{border:1px solid #ccc;border-radius:4px;padding:10px 12px}
.box h3{font-size:9pt;text-transform:uppercase;letter-spacing:.5px;color:#888;border-bottom:1px solid #eee;padding-bottom:3px;margin-bottom:7px}
.box p{font-size:10pt;line-height:1.6}
table{width:100%;border-collapse:collapse;margin-bottom:14px;font-size:10pt}
th{background:#f5f5f5;text-align:left;padding:6px 8px;font-size:9pt;text-transform:uppercase;letter-spacing:.3px;border:1px solid #ddd}
td{padding:6px 8px;border:1px solid #ddd;vertical-align:top}
.r{text-align:right}
.notes{border:1px solid #ddd;border-radius:4px;padding:10px 12px;margin-bottom:14px;font-size:10pt}
.notes h3{font-size:9pt;text-transform:uppercase;color:#888;margin-bottom:5px}
.sigs{display:grid;grid-template-columns:1fr 1fr;gap:30px;margin:18px 0 12px}
.sig{border-top:1px solid #555;padding-top:8px;font-size:9pt;color:#555}
.sig strong{display:block;font-size:10pt;color:#222;margin-bottom:5px}
.footer{border-top:1px solid #ccc;padding-top:7px;font-size:8pt;color:#777;text-align:center;line-height:1.6}
.notice{background:#fff8e1;border:1px solid #f9a825;border-radius:4px;padding:6px 10px;font-size:9pt;color:#555;margin-bottom:12px}
@media print{.no-print{display:none}}
</style>
</head>
<body>
<div class="page">
  <div class="hdr">
    <div class="logo">SOKONI<span>.</span></div>
    <div class="doc-right">
      <h1>${esc(info.label)}</h1>
      <div class="num">Ref: <strong>${esc(docNumber)}</strong></div>
      <div class="date">Issued: ${esc(issuedDate)}</div>
    </div>
  </div>

  <div class="notice">
    ⚠ This is a logistics/operational document only — it is <strong>NOT a KRA eTIMS tax invoice</strong>.
    A separate tax invoice will be issued by the appropriate registered entity.
  </div>

  <div class="parties">
    <div class="box">
      <h3>SOKONI Hub</h3>
      <p><strong>${esc(hub?.name || "SOKONI Hub")}</strong><br>
      ${hub?.region ? esc(hub.region) + "<br>" : ""}
      ${hub?.address ? esc(hub.address) + "<br>" : ""}
      Hub ID: <code>${esc(hub?.hubId || "—")}</code></p>
    </div>
    <div class="box">
      <h3>${docType === "dispatch_note" ? "Delivery Recipient" : docType === "return_confirmation" ? "Returned By" : "Supplier / Seller"}</h3>
      <p><strong>${esc(seller?.name || seller?.businessName || "—")}</strong><br>
      ${seller?.kraPin  ? "KRA PIN: " + esc(seller.kraPin) + "<br>" : ""}
      ${seller?.phone   ? esc(seller.phone) + "<br>" : ""}
      ${seller?.address ? esc(seller.address) : ""}</p>
    </div>
  </div>

  ${buyer ? `<div class="box" style="margin-bottom:14px">
    <h3>Buyer / Consignee</h3>
    <p><strong>${esc(buyer.name || buyer.displayName || "—")}</strong>
    ${buyer.phone ? " &nbsp;|&nbsp; " + esc(buyer.phone) : ""}
    ${buyer.address ? "<br>" + esc(buyer.address) : ""}</p>
  </div>` : ""}

  ${order ? `<p style="font-size:10pt;margin-bottom:12px">
    Order Ref: <strong>${esc(order.orderId || "—")}</strong>
    ${order.status ? ` &nbsp;|&nbsp; Status: <strong>${esc(order.status)}</strong>` : ""}
  </p>` : ""}

  <h3 style="font-size:9pt;text-transform:uppercase;letter-spacing:.4px;color:#666;margin-bottom:7px">Items / Goods</h3>
  <table>
    <thead><tr><th>Description</th><th class="r">Qty</th><th>Unit</th><th>SKU / Barcode</th><th>Condition</th></tr></thead>
    <tbody>${itemRows || "<tr><td colspan='5' style='color:#aaa;text-align:center;padding:14px'>No items specified</td></tr>"}</tbody>
  </table>

  ${metaRows ? `
  <h3 style="font-size:9pt;text-transform:uppercase;letter-spacing:.4px;color:#666;margin-bottom:7px">Additional Details</h3>
  <table><tbody>${metaRows}</tbody></table>` : ""}

  ${notes ? `<div class="notes"><h3>Notes / Remarks</h3><p>${esc(notes)}</p></div>` : ""}

  <div class="sigs">
    <div class="sig">
      <strong>${esc(receiverLabel)}</strong>
      ${signedBy ? esc(signedBy) + "<br>" : "Name: ___________________________<br>"}
      Signature: ___________________________<br>
      Date / Time: ________________________
    </div>
    <div class="sig">
      <strong>${esc(handoverLabel)}</strong>
      Name: ___________________________<br>
      Signature: ___________________________<br>
      Date / Time: ________________________
    </div>
  </div>

  <div class="footer">
    OPERATIONAL DOCUMENT — NOT A TAX INVOICE &nbsp;|&nbsp;
    Verify at: <strong>${esc(verifyUrl)}</strong> &nbsp;|&nbsp;
    SOKONI Platform &nbsp;|&nbsp; Ref: ${esc(docNumber)}
    <br>Operated by Bravilex International Company Limited
  </div>
</div>
</body>
</html>`;
}

/* ── Hub tax invoice HTML (for selling hubs) ───────────────────────── */
function buildHubInvoiceHtml({ invoice, hub, seller, buyer }) {
  const verifyUrl  = `https://mysokoni.co.ke/verify/inv/${encodeURIComponent(invoice.invoiceNumber)}`;
  const issuedDate = new Date(invoice.issuedAt || invoice.createdAt).toLocaleDateString("en-KE");

  const itemRows = (invoice.items || []).map(i => `
    <tr>
      <td>${esc(i.name || i.description)}</td>
      <td class="r">${i.qty || 1}</td>
      <td class="r">KES ${Number(i.unitPrice||0).toLocaleString("en-KE",{minimumFractionDigits:2})}</td>
      <td class="r">${esc(i.taxCategory || "A")}</td>
      <td class="r">KES ${Number(i.lineTotal||0).toLocaleString("en-KE",{minimumFractionDigits:2})}</td>
      <td class="r">KES ${Number(i.lineVat||0).toLocaleString("en-KE",{minimumFractionDigits:2})}</td>
    </tr>`).join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Tax Invoice ${esc(invoice.invoiceNumber)}</title>
<style>
@page{size:A4;margin:18mm 20mm}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:Arial,Helvetica,sans-serif;font-size:11pt;color:#111;background:#fff}
.page{max-width:170mm;margin:0 auto}
.hdr{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:3px solid #111;padding-bottom:10px;margin-bottom:14px}
.logo{font-size:22pt;font-weight:900;letter-spacing:-1px}.logo span{color:#4a0}
.doc-right{text-align:right}
.doc-right h1{font-size:14pt;text-transform:uppercase;letter-spacing:1px;color:#333}
.parties{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px}
.box{border:1px solid #ccc;border-radius:4px;padding:10px 12px}
.box h3{font-size:9pt;text-transform:uppercase;color:#888;border-bottom:1px solid #eee;padding-bottom:3px;margin-bottom:7px}
.box p{font-size:10pt;line-height:1.6}
table{width:100%;border-collapse:collapse;margin-bottom:14px;font-size:10pt}
th{background:#f5f5f5;text-align:left;padding:6px 8px;font-size:9pt;text-transform:uppercase;border:1px solid #ddd}
td{padding:6px 8px;border:1px solid #ddd}
.r{text-align:right}
.totals{width:55%;margin-left:auto}
.totals td{border:none;padding:4px 8px}
.grand td{font-weight:bold;font-size:12pt;border-top:2px solid #111}
.kra-box{text-align:center;border:2px solid #111;border-radius:5px;padding:10px;margin-bottom:14px;background:#fafafa}
.kra-box h2{font-size:11pt;text-transform:uppercase;letter-spacing:1px;color:#333}
.kra-box .rcpt{font-size:20pt;font-weight:bold;color:#000;margin:4px 0}
.footer{border-top:1px solid #ccc;padding-top:7px;font-size:8pt;color:#777;text-align:center;line-height:1.6}
@media print{button{display:none}}
</style>
</head>
<body>
<div class="page">
  <div class="hdr">
    <div class="logo">SOKONI<span>.</span></div>
    <div class="doc-right">
      <h1>KRA eTIMS Tax Invoice</h1>
      <p style="font-size:10pt;color:#555;margin-top:4px">Invoice #: <strong>${esc(invoice.invoiceNumber)}</strong></p>
      <p style="font-size:9pt;color:#777">Date: ${esc(issuedDate)}</p>
    </div>
  </div>

  ${invoice.kraReceiptNumber
    ? `<div class="kra-box">
        <h2>Kenya Revenue Authority — Verified Receipt</h2>
        <div class="rcpt">${esc(invoice.kraReceiptNumber)}</div>
        <div style="font-size:9pt;color:#555">Verify at etims.kra.go.ke</div>
      </div>`
    : `<div style="background:#fff3cd;border:1px solid #ffc107;border-radius:4px;padding:7px 12px;margin-bottom:14px;font-size:10pt;text-align:center">
        ⚠ Pending KRA submission — invoice not yet accepted by KRA.
      </div>`}

  <div class="parties">
    <div class="box">
      <h3>Issued By (Hub)</h3>
      <p><strong>${esc(hub?.name || "SOKONI Hub")}</strong><br>
      KRA PIN: <strong>${esc(hub?.taxConfig?.kraPin || "—")}</strong><br>
      Branch: ${esc(hub?.taxConfig?.branchId || "00")}<br>
      ${hub?.region  ? esc(hub.region)  + "<br>" : ""}
      ${hub?.address ? esc(hub.address)          : ""}</p>
    </div>
    <div class="box">
      <h3>Buyer</h3>
      <p><strong>${esc(buyer?.name || buyer?.displayName || "—")}</strong><br>
      ${buyer?.kraPin  ? "KRA PIN: " + esc(buyer.kraPin)  + "<br>" : ""}
      ${buyer?.phone   ? esc(buyer.phone)   + "<br>" : ""}
      ${buyer?.address ? esc(buyer.address)          : ""}</p>
    </div>
  </div>

  ${seller ? `<div class="box" style="margin-bottom:14px">
    <h3>Merchant / Supplier</h3>
    <p><strong>${esc(seller.businessName || seller.name || "—")}</strong>
    ${seller.kraPin ? " &nbsp;|&nbsp; KRA PIN: " + esc(seller.kraPin) : ""}</p>
  </div>` : ""}

  <table>
    <thead><tr><th>Item</th><th class="r">Qty</th><th class="r">Unit Price</th><th class="r">Tax</th><th class="r">Line Total</th><th class="r">VAT</th></tr></thead>
    <tbody>${itemRows}</tbody>
  </table>

  <table class="totals">
    <tr><td>Subtotal</td><td class="r">${fmtKES(invoice.subtotal)}</td></tr>
    <tr><td>VAT (${invoice.vatRate || 16}%)</td><td class="r">${fmtKES(invoice.vat)}</td></tr>
    <tr class="grand"><td>TOTAL</td><td class="r">${fmtKES(invoice.total)}</td></tr>
  </table>

  <div class="footer">
    KRA eTIMS Invoice &nbsp;|&nbsp; Hub PIN: ${esc(hub?.taxConfig?.kraPin || "—")}
    &nbsp;|&nbsp; Order: ${esc(invoice.orderId || "—")}
    &nbsp;|&nbsp; Verify: <strong>${esc(verifyUrl)}</strong>
    ${invoice.kraReceiptNumber ? " &nbsp;|&nbsp; KRA: " + esc(invoice.verificationUrl || "") : ""}
    <br>Operated by Bravilex International Company Limited
  </div>
</div>
</body>
</html>`;
}

/* ── Store HTML to Firebase Storage ────────────────────────────────── */
async function storeHtml(path, html) {
  const file = _bucket().file(path);
  await file.save(html, { contentType: "text/html; charset=utf-8", resumable: false });
  const [url] = await file.getSignedUrl({ action: "read", expires: "2099-01-01" });
  return url;
}

/* ── RBAC helpers ──────────────────────────────────────────────────── */
function requireAuth(req)  { if (!req.auth) throw new HttpsError("unauthenticated",  "Sign in required"); }
function requireAdmin(req) { if (!req.auth?.token?.isAdmin) throw new HttpsError("permission-denied", "Admin only"); }

async function getHub(hubId) {
  const snap = await db.doc(`hubs/${hubId}`).get();
  if (!snap.exists) throw new HttpsError("not-found", `Hub ${hubId} not found`);
  return snap.data();
}

async function isHubManager(uid, hubId) {
  const snap = await db.doc(`hubs/${hubId}`).get().catch(() => null);
  if (!snap?.exists) return false;
  const h = snap.data();
  return h.managerId === uid || (h.managerIds || []).includes(uid);
}

async function requireHubAccess(req, hubId) {
  requireAuth(req);
  if (!req.auth.token?.isAdmin && !(await isHubManager(req.auth.uid, hubId)))
    throw new HttpsError("permission-denied", "Hub manager or admin access required");
}

/* ─────────────────────────────────────────────────────────────────────
   Email helpers (fire-and-forget — never throw)
───────────────────────────────────────────────────────────────────── */
async function _emailBuyerHubInvoice({ invoice, hub, buyer }) {
  if (!buyer?.email) return;
  try {
    const _f = n => Number(n || 0).toLocaleString("en-KE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const t  = invoice;
    await emailSvc.send({
      to:      buyer.email,
      from:    emailSvc.FROM.orders,
      subject: `KRA Receipt #${invoice.invoiceNumber} — ${hub.name}`,
      html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px">
        <h2 style="color:#003366">Your KRA eTIMS Receipt</h2>
        <p>Dear <b>${buyer.name || "Customer"}</b>,</p>
        <p>Your purchase through <b>${hub.name}</b> has been invoiced and submitted to KRA.</p>
        <table style="width:100%;border-collapse:collapse;margin:16px 0">
          <tr style="background:#f6f8fa"><td style="padding:8px;border:1px solid #e0e0e0"><b>Invoice #</b></td><td style="padding:8px;border:1px solid #e0e0e0">${invoice.invoiceNumber}</td></tr>
          <tr><td style="padding:8px;border:1px solid #e0e0e0"><b>Date</b></td><td style="padding:8px;border:1px solid #e0e0e0">${new Date(invoice.createdAt).toLocaleDateString("en-KE")}</td></tr>
          <tr style="background:#f6f8fa"><td style="padding:8px;border:1px solid #e0e0e0"><b>Subtotal</b></td><td style="padding:8px;border:1px solid #e0e0e0">KES ${_f(t.subtotal)}</td></tr>
          <tr><td style="padding:8px;border:1px solid #e0e0e0"><b>VAT (${t.vatRate || 16}%)</b></td><td style="padding:8px;border:1px solid #e0e0e0">KES ${_f(t.vat)}</td></tr>
          <tr style="background:#f6f8fa"><td style="padding:8px;border:1px solid #e0e0e0"><b>Total</b></td><td style="padding:8px;border:1px solid #e0e0e0"><b>KES ${_f(t.total)}</b></td></tr>
        </table>
        ${invoice.verificationUrl ? `<p>Verify with KRA: <a href="${invoice.verificationUrl}">${invoice.verificationUrl}</a></p>` : ""}
        <p style="color:#666;font-size:12px">This is an official KRA eTIMS receipt. Keep for your records.</p>
      </div>`,
    });
  } catch (e) { console.warn("[hubEmail] buyer email failed:", e.message); }
}

async function _notifyHubManagerFailure(hubId, hub, invoiceId, errMsg) {
  try {
    const managerIds = hub.managerIds || [];
    const emails = [];
    if (hub.contactEmail) emails.push(hub.contactEmail);
    for (const uid of managerIds.slice(0, 2)) {
      const s = await db.doc(`users/${uid}`).get().catch(() => null);
      if (s?.exists && s.data().email) emails.push(s.data().email);
    }
    if (!emails.length) return;
    await emailSvc.send({
      to:      emails[0],
      from:    emailSvc.FROM.seller,
      subject: `Action Required: Hub eTIMS Invoice Submission Failed — ${hub.name}`,
      html: `<p>Invoice <b>${invoiceId}</b> for hub <b>${hub.name}</b> failed to submit to KRA:<br><em>${errMsg}</em></p>
             <p>SOKONI will retry automatically. You can also resubmit manually from the Hub Dashboard → Invoices tab.</p>`,
    });
  } catch (e) { console.warn("[hubEmail] manager notify failed:", e.message); }
}

/* ─────────────────────────────────────────────────────────────────────
   Internal: issue a hub tax invoice (shared by trigger + manual CF)
───────────────────────────────────────────────────────────────────── */
async function _issueHubInvoice({ hubId, hub, orderId, order, manualBuyerKraPin }) {
  const credSnap = await db.doc(`hubCredentials/${hubId}`).get();
  if (!credSnap.exists) throw new Error("Hub eTIMS credentials not found — run hubRegisterEtims first");

  const cred   = credSnap.data();
  const tin    = hub.taxConfig.kraPin;
  const bhfId  = hub.taxConfig.branchId || "00";
  const serial = decryptCred(cred.encryptedDeviceSerial);
  const secret = decryptCred(cred.encryptedTaxpayerSecret);

  const idKey         = `hub-${hubId}-order-${orderId}`;
  const seq           = await nextSeq(hubId, "invoiceSeq");
  const prefix        = hub.taxConfig.invoicePrefix || hubId.slice(0, 6).toUpperCase();
  const invoiceNumber = `${prefix}-INV-${new Date().getFullYear()}-${String(seq).padStart(6, "0")}`;

  const vatRate   = hub.taxConfig.vatStatus === "zero_rated" ? 0 : 16;
  const rawItems  = order.items || [];
  const subtotal  = rawItems.reduce((s, i) => s + ((i.price || 0) * (i.quantity || 1)), 0);
  const vat       = Math.round(subtotal * (vatRate / 100) * 100) / 100;
  const total     = subtotal + vat;
  const taxCat    = hub.taxConfig.taxCategory || "A";

  const items = rawItems.map(i => {
    const lineTotal = (i.price || 0) * (i.quantity || 1);
    const lineVat   = Math.round(lineTotal * (vatRate / 100) * 100) / 100;
    return {
      name:        i.name || i.title || "Item",
      qty:         i.quantity || 1,
      unitPrice:   i.price || 0,
      lineTotal,
      lineVat,
      taxCategory: taxCat,
      sku:         i.sku || i.productId || "",
    };
  });

  const buyerUid = order.userId || order.buyerId || null;
  let buyerData  = {};
  if (buyerUid) {
    const bs = await db.doc(`users/${buyerUid}`).get().catch(() => null);
    if (bs?.exists) buyerData = bs.data();
  }

  const now    = new Date().toISOString();
  const invRef = db.collection("hubInvoices").doc();

  const invDoc = {
    invoiceId:       invRef.id,
    hubId,
    orderId,
    sellerUid:       order.sellerId || null,
    buyerUid,
    idempotencyKey:  idKey,
    invoiceNumber,
    items,
    subtotal,
    vat,
    vatRate,
    total,
    taxCategory:     taxCat,
    status:          "pending_submission",
    etimsStatus:     "pending_submission",
    kraReceiptNumber: null,
    verificationUrl:  null,
    htmlUrl:          null,
    retryCount:       0,
    createdAt:        now,
    updatedAt:        now,
    issuedAt:         now,
    issuedBy:         "system",
  };
  await invRef.set(invDoc);

  // Attempt immediate KRA submission
  try {
    const client  = new EtimsClient({ tin, bhfId, deviceSerial: serial, taxpayerSecret: secret });
    const salesDt = now.slice(0, 10).replace(/-/g, "");
    const cfmDt   = now.replace("T", " ").slice(0, 19);

    const kraPayload = {
      tin, bhfId,
      invcNo:    invoiceNumber,
      trdInvcNo: orderId,
      orgInvcNo: null,
      cfmDt,
      pmtTyCd:   "01",
      rcptTyCd:  "S",
      pmtSttsCd: "02",
      salesDt,
      custTin:   manualBuyerKraPin || buyerData.kraPin || null,
      custNm:    buyerData.displayName || buyerData.name || null,
      vatCatCd:  taxCat,
      itemList:  items.map((i, idx) => ({
        itemSeq:   idx + 1,
        itemCd:    i.sku || `ITEM-${idx + 1}`,
        itemNm:    i.name,
        itemTyCd:  "1",
        orgnNatCd: "KE",
        pkgUnt:    "EA",
        qtyUnt:    i.qty,
        prc:       i.unitPrice,
        totAmt:    i.lineTotal,
        vatAmt:    i.lineVat,
        vatCatCd:  i.taxCategory,
        taxAmt:    i.lineVat,
        itemExprDt: null,
      })),
      totItemCnt:  items.length,
      taxblAmtA:   taxCat === "A" ? subtotal : 0,
      taxblAmtB:   taxCat === "B" ? subtotal : 0,
      taxblAmtC:   taxCat === "C" ? subtotal : 0,
      taxRtA:      taxCat === "A" ? vatRate  : 0,
      taxRtB:      0, taxRtC: 0,
      taxAmtA:     taxCat === "A" ? vat      : 0,
      totTaxblAmt: subtotal,
      totTaxAmt:   vat,
      totAmt:      total,
      remark:      `SOKONI HUB ${hubId} | ORDER ${orderId}`,
      regrId:      tin,
      regrNm:      hub.name,
      modrId:      tin,
      modrNm:      hub.name,
    };

    const kraResp = await client.submitInvoice(kraPayload);

    if (kraResp.resultCd === "000") {
      // Generate receipt HTML
      let sellerData = null;
      if (order.sellerId) {
        const ss = await db.doc(`sellers/${order.sellerId}`).get().catch(() => null);
        if (ss?.exists) sellerData = ss.data();
      }
      const html = buildHubInvoiceHtml({
        invoice: {
          ...invDoc,
          kraReceiptNumber: kraResp.data?.rcptNo    || null,
          verificationUrl:  kraResp.data?.qrCodeUrl || null,
        },
        hub:    { hubId, name: hub.name, taxConfig: hub.taxConfig, address: hub.address, region: hub.region },
        seller: sellerData,
        buyer:  { name: buyerData.displayName || buyerData.name, phone: buyerData.phone, kraPin: buyerData.kraPin },
      });

      const storagePath = `hub-invoices/${hubId}/${invRef.id}.html`;
      const htmlUrl     = await storeHtml(storagePath, html);

      await invRef.update({
        status:           "accepted",
        etimsStatus:      "accepted",
        kraReceiptNumber: kraResp.data?.rcptNo    || null,
        verificationUrl:  kraResp.data?.qrCodeUrl || null,
        htmlUrl,
        storagePath,
        acceptedAt:       now,
        updatedAt:        now,
      });

      console.log(`[hubInvoice] ACCEPTED ${invoiceNumber} hub=${hubId} order=${orderId}`);
      _emailBuyerHubInvoice({
        invoice: { ...invDoc, invoiceNumber, status: "accepted", verificationUrl: kraResp.data?.qrCodeUrl || null },
        hub,
        buyer: { email: buyerData.email, name: buyerData.displayName || buyerData.name },
      });
    } else {
      await _queueHubInvoice(hubId, invRef.id, kraResp.resultMsg, 0);
      await invRef.update({ lastKraError: kraResp.resultMsg, updatedAt: now });
      _notifyHubManagerFailure(hubId, hub, invRef.id, kraResp.resultMsg);
    }
  } catch (netErr) {
    await _queueHubInvoice(hubId, invRef.id, netErr.message, 0);
    await invRef.update({ lastKraError: netErr.message, updatedAt: now });
    console.error(`[hubInvoice] network error for ${invoiceNumber}:`, netErr.message);
    _notifyHubManagerFailure(hubId, hub, invRef.id, netErr.message);
  }

  return invRef.id;
}

async function _queueHubInvoice(hubId, invoiceId, errorMsg, retryCount) {
  const delays = [2, 10, 30, 120, 720]; // minutes
  const delay  = (delays[retryCount] || 720) * 60_000;
  await db.collection("hubInvoiceQueue").doc().set({
    hubId,
    invoiceId,
    status:     "pending",
    retryCount,
    nextRetryAt: new Date(Date.now() + delay).toISOString(),
    priority:   retryCount === 0 ? 1 : 2,
    kraError:   errorMsg,
    createdAt:  new Date().toISOString(),
  });
}

/* ══════════════════════════════════════════════════════════════════
   EXPORTED CLOUD FUNCTIONS
══════════════════════════════════════════════════════════════════ */

/* 1. hubCreate ─────────────────────────────────────────────────── */
exports.hubCreate = onCall({ secrets: [] }, async req => {
  requireAdmin(req);
  const { hubId, name, type, region, address, managerId, taxConfig, operationalDocs } = req.data;

  if (!hubId || !name || !type) throw new HttpsError("invalid-argument", "hubId, name, type required");
  const VALID = ["logistics", "selling", "marketplace", "hybrid"];
  if (!VALID.includes(type)) throw new HttpsError("invalid-argument", `type must be one of: ${VALID.join(", ")}`);

  const exists = await db.doc(`hubs/${hubId}`).get();
  if (exists.exists) throw new HttpsError("already-exists", `Hub ${hubId} already exists`);

  const isSelling = ["selling", "hybrid"].includes(type);

  await db.doc(`hubs/${hubId}`).set({
    hubId,
    name,
    type,
    region:    region   || "",
    address:   address  || "",
    managerId: managerId || null,
    managerIds:managerId ? [managerId] : [],
    taxConfig: {
      issueEtims:       isSelling,
      invoiceAuthority: isSelling ? "hub" : "seller",
      kraPin:           taxConfig?.kraPin           || null,
      branchId:         taxConfig?.branchId         || "00",
      vatStatus:        taxConfig?.vatStatus         || (isSelling ? "registered" : null),
      taxCategory:      taxConfig?.taxCategory       || (isSelling ? "A" : null),
      invoicePrefix:    taxConfig?.invoicePrefix      || hubId.replace(/[^A-Za-z0-9]/g,"").toUpperCase().slice(0,6),
    },
    operationalDocs: {
      pickup_receipt:      operationalDocs?.pickup_receipt      ?? true,
      warehouse_receipt:   operationalDocs?.warehouse_receipt   ?? true,
      dispatch_note:       operationalDocs?.dispatch_note       ?? true,
      return_confirmation: operationalDocs?.return_confirmation ?? true,
      transfer_note:       operationalDocs?.transfer_note       ?? false,
    },
    etimsActive: false,
    status:      "active",
    createdAt:   new Date().toISOString(),
    updatedAt:   new Date().toISOString(),
    createdBy:   req.auth.uid,
  });

  console.log(`[hubCreate] ${hubId} type=${type} by ${req.auth.uid}`);
  return { success: true, hubId };
});

/* 2. hubUpdate ─────────────────────────────────────────────────── */
exports.hubUpdate = onCall({ secrets: [] }, async req => {
  requireAuth(req);
  const { hubId, name, region, address, managerId, operationalDocs, status } = req.data;
  if (!hubId) throw new HttpsError("invalid-argument", "hubId required");
  await requireHubAccess(req, hubId);

  const u = { updatedAt: new Date().toISOString() };
  if (name)           u.name           = name;
  if (region)         u.region         = region;
  if (address)        u.address        = address;
  if (managerId)      u.managerId      = managerId;
  if (operationalDocs)u.operationalDocs= operationalDocs;
  if (status && req.auth.token?.isAdmin) u.status = status;

  await db.doc(`hubs/${hubId}`).update(u);
  return { success: true };
});

/* 3. hubGetProfile ─────────────────────────────────────────────── */
exports.hubGetProfile = onCall({ secrets: [] }, async req => {
  requireAuth(req);
  const { hubId } = req.data;
  if (!hubId) throw new HttpsError("invalid-argument", "hubId required");

  const snap = await db.doc(`hubs/${hubId}`).get();
  if (!snap.exists) throw new HttpsError("not-found", "Hub not found");

  const hub     = snap.data();
  const isAdmin = req.auth.token?.isAdmin;
  const isMgr   = await isHubManager(req.auth.uid, hubId);
  const safe    = { ...hub };

  if (!isAdmin && !isMgr) {
    // Guests only see public fields
    delete safe.taxConfig.kraPin;
    delete safe.managerIds;
    delete safe.createdBy;
  }
  return safe;
});

/* 4. hubUpdateTaxConfig ─────────────────────────────────────────── */
exports.hubUpdateTaxConfig = onCall({ secrets: [] }, async req => {
  requireAdmin(req);
  const { hubId, taxConfig } = req.data;
  if (!hubId || !taxConfig) throw new HttpsError("invalid-argument", "hubId and taxConfig required");

  const snap = await db.doc(`hubs/${hubId}`).get();
  if (!snap.exists) throw new HttpsError("not-found", "Hub not found");

  const existing = snap.data().taxConfig || {};
  await db.doc(`hubs/${hubId}`).update({
    taxConfig:  { ...existing, ...taxConfig },
    updatedAt:  new Date().toISOString(),
  });
  return { success: true };
});

/* 5. hubRegisterEtims ─────────────────────────────────────────── */
exports.hubRegisterEtims = onCall({ secrets: [ETIMS_MASTER_KEY] }, async req => {
  requireAdmin(req);
  const { hubId, deviceSerial, taxpayerSecret, kraPin, branchId } = req.data;
  if (!hubId || !deviceSerial || !taxpayerSecret || !kraPin)
    throw new HttpsError("invalid-argument", "hubId, deviceSerial, taxpayerSecret, kraPin required");

  const hub = await getHub(hubId);
  if (!["selling", "hybrid"].includes(hub.type))
    throw new HttpsError("failed-precondition", "Only selling or hybrid hubs can register eTIMS");

  if (!/^[A-Z]\d{9}[A-Z]$/i.test(kraPin.trim()))
    throw new HttpsError("invalid-argument", "Invalid KRA PIN format (must match e.g. P051234567T)");

  // Validate with KRA
  const client  = new EtimsClient({ tin: kraPin.trim().toUpperCase(), bhfId: branchId || "00", deviceSerial, taxpayerSecret });
  const kraResp = await client.validatePin().catch(e => ({ resultCd: "NET_ERR", resultMsg: e.message }));

  await db.doc(`hubCredentials/${hubId}`).set({
    encryptedDeviceSerial:   encryptCred(deviceSerial),
    encryptedTaxpayerSecret: encryptCred(taxpayerSecret),
    updatedAt: new Date().toISOString(),
    updatedBy: req.auth.uid,
  });

  await db.doc(`hubs/${hubId}`).update({
    "taxConfig.kraPin":   kraPin.trim().toUpperCase(),
    "taxConfig.branchId": branchId || "00",
    etimsActive:          true,
    etimsActivatedAt:     new Date().toISOString(),
    updatedAt:            new Date().toISOString(),
  });

  return {
    success: true,
    kraValidation: { code: kraResp.resultCd, message: kraResp.resultMsg, valid: kraResp.resultCd === "000" },
  };
});

/* 6. hubGenerateDocument ─────────────────────────────────────── */
exports.hubGenerateDocument = onCall({ secrets: [ETIMS_MASTER_KEY] }, async req => {
  requireAuth(req);
  const { hubId, docType, orderId, sellerId, buyerId, deliveryId, items, notes, signedBy, meta } = req.data;

  if (!hubId || !docType) throw new HttpsError("invalid-argument", "hubId and docType required");
  if (!DOC_TYPES[docType]) throw new HttpsError("invalid-argument", `Invalid docType. Valid: ${Object.keys(DOC_TYPES).join(", ")}`);

  await requireHubAccess(req, hubId);

  const hub = await getHub(hubId);
  if (!hub.operationalDocs?.[docType])
    throw new HttpsError("failed-precondition", `${docType} is not enabled for hub ${hubId}`);

  // Idempotency: only one issued document per orderId+docType
  if (orderId) {
    const dup = await db.collection("hubDocuments")
      .where("orderId", "==", orderId)
      .where("docType",  "==", docType)
      .where("status",   "==", "issued")
      .limit(1).get();
    if (!dup.empty) {
      const d = dup.docs[0].data();
      return { docId: d.docId, docNumber: d.docNumber, duplicate: true, htmlUrl: d.htmlUrl };
    }
  }

  const info      = DOC_TYPES[docType];
  const seq       = await nextSeq(hubId, info.seqField);
  const docNumber = fmtDocNumber(hubId, info.prefix, seq);
  const now       = new Date().toISOString();

  // Enrich with related records
  let sellerData = null, buyerData = null, orderData = null;
  await Promise.all([
    sellerId ? db.doc(`sellers/${sellerId}`).get().catch(()=>null).then(s => { if(s?.exists) sellerData = { uid: sellerId, ...s.data() }; }) : null,
    buyerId  ? db.doc(`users/${buyerId}`).get().catch(()=>null).then(b   => { if(b?.exists)  buyerData  = { uid: buyerId,  ...b.data() }; }) : null,
    orderId  ? db.doc(`orders/${orderId}`).get().catch(()=>null).then(o  => { if(o?.exists)  orderData  = { orderId, ...o.data() }; }) : null,
  ]);

  const html     = buildDocumentHtml({
    docType, docNumber, issuedAt: now,
    hub:    { hubId, ...hub },
    seller: sellerData,
    buyer:  buyerData,
    order:  orderData,
    items:  items || [],
    notes,
    signedBy: signedBy || req.auth.uid,
    meta,
  });

  const storagePath = `hub-documents/${hubId}/${docType}/${docNumber}.html`;
  const htmlUrl     = await storeHtml(storagePath, html);

  const docRef = db.collection("hubDocuments").doc();
  const docData = {
    docId:       docRef.id,
    hubId,
    docType,
    docNumber,
    orderId:     orderId    || null,
    sellerId:    sellerId   || null,
    buyerId:     buyerId    || null,
    deliveryId:  deliveryId || null,
    items:       items      || [],
    notes:       notes      || null,
    signedBy:    signedBy   || req.auth.uid,
    meta:        meta       || {},
    status:      "issued",
    htmlUrl,
    storagePath,
    issuedAt:    now,
    issuedBy:    req.auth.uid,
  };
  await docRef.set(docData);

  // Back-link on order
  if (orderId) {
    await db.doc(`orders/${orderId}`).update({ [`${docType}Id`]: docRef.id, [`${docType}Number`]: docNumber }).catch(() => {});
  }

  console.log(`[hubGenerateDocument] ${docType} ${docNumber} hub=${hubId}`);
  return { docId: docRef.id, docNumber, htmlUrl };
});

/* 7. hubGetDocuments ─────────────────────────────────────────── */
exports.hubGetDocuments = onCall({ secrets: [] }, async req => {
  requireAuth(req);
  const { hubId, docType, orderId, sellerId, buyerId, status, limit: lim = 30 } = req.data;
  const uid     = req.auth.uid;
  const isAdmin = req.auth.token?.isAdmin;

  let q = db.collection("hubDocuments");

  if (hubId) {
    if (!isAdmin && !(await isHubManager(uid, hubId)))
      throw new HttpsError("permission-denied", "Hub manager access required");
    q = q.where("hubId", "==", hubId);
  } else if (sellerId) {
    if (!isAdmin && uid !== sellerId) throw new HttpsError("permission-denied", "Access denied");
    q = q.where("sellerId", "==", sellerId);
  } else if (buyerId) {
    if (!isAdmin && uid !== buyerId) throw new HttpsError("permission-denied", "Access denied");
    q = q.where("buyerId", "==", buyerId);
  } else if (!isAdmin) {
    throw new HttpsError("invalid-argument", "Provide hubId, sellerId, or buyerId");
  }

  if (docType) q = q.where("docType", "==", docType);
  if (orderId) q = q.where("orderId", "==", orderId);
  if (status)  q = q.where("status",  "==", status);
  q = q.orderBy("issuedAt", "desc").limit(Math.min(lim, 100));

  const snap = await q.get();
  return { documents: snap.docs.map(d => d.data()) };
});

/* 8. hubOnOrderCompleted  (Firestore trigger) ─────────────────── */
exports.hubOnOrderCompleted = onDocumentWritten(
  { document: "orders/{orderId}", secrets: [ETIMS_MASTER_KEY, ...EMAIL_SECRETS] },
  async event => {
    const after  = event.data.after?.data();
    const before = event.data.before?.data();
    if (!after) return;

    const orderId = event.params.orderId;
    const hubId   = after.hubId;
    if (!hubId) return;

    const TERMINAL = ["completed", "delivered"];
    const justDone = TERMINAL.includes(after.status) && !TERMINAL.includes(before?.status || "");
    if (!justDone) return;

    const hubSnap = await db.doc(`hubs/${hubId}`).get();
    if (!hubSnap.exists) return;
    const hub = hubSnap.data();

    // Auto-generate dispatch note (all hub types that have it enabled)
    if (hub.operationalDocs?.dispatch_note) {
      try {
        const info      = DOC_TYPES.dispatch_note;
        const seq       = await nextSeq(hubId, info.seqField);
        const docNumber = fmtDocNumber(hubId, info.prefix, seq);
        const now       = new Date().toISOString();
        const items     = (after.items || []).map(i => ({
          name: i.name || i.title || "Item", qty: i.quantity || 1,
          unit: "pcs", sku: i.sku || "", condition: "Good",
        }));

        const html = buildDocumentHtml({
          docType: "dispatch_note", docNumber, issuedAt: now,
          hub: { hubId, ...hub },
          order: { orderId, status: after.status },
          items,
          meta: {
            "Delivery Address": after.deliveryAddress || after.shippingAddress || "",
            "Driver / Agent":   after.driverName      || "—",
            "Payment Method":   after.paymentMethod   || "—",
          },
        });

        const storagePath = `hub-documents/${hubId}/dispatch_note/${docNumber}.html`;
        const htmlUrl     = await storeHtml(storagePath, html);

        const docRef = db.collection("hubDocuments").doc();
        await docRef.set({
          docId: docRef.id, hubId, docType: "dispatch_note", docNumber,
          orderId,
          sellerId:   after.sellerId   || null,
          buyerId:    after.userId     || null,
          deliveryId: after.deliveryId || null,
          items, status: "issued", htmlUrl, storagePath,
          issuedAt: now, issuedBy: "system",
          meta: { trigger: "order_completed", orderStatus: after.status },
        });
        await db.doc(`orders/${orderId}`).update({ dispatch_noteId: docRef.id, dispatch_noteNumber: docNumber }).catch(() => {});
        console.log(`[hubOnOrderCompleted] dispatch_note ${docNumber} for order ${orderId}`);
      } catch (e) {
        console.error(`[hubOnOrderCompleted] dispatch_note failed for ${orderId}:`, e.message);
      }
    }

    // Hub tax invoice (selling / hybrid only)
    if (!hub.taxConfig?.issueEtims || !hub.etimsActive) return;
    if (hub.taxConfig?.invoiceAuthority !== "hub") return;

    const idKey = `hub-${hubId}-order-${orderId}`;
    const dup   = await db.collection("hubInvoices").where("idempotencyKey", "==", idKey).limit(1).get();
    if (!dup.empty) { console.log(`[hubOnOrderCompleted] idempotency hit order=${orderId}`); return; }

    try {
      await _issueHubInvoice({ hubId, hub, orderId, order: after });
    } catch (e) {
      console.error(`[hubOnOrderCompleted] invoice failed for ${orderId}:`, e.message);
    }
  }
);

/* 9. hubGenerateInvoice  (manual, hub manager or admin) ──────── */
exports.hubGenerateInvoice = onCall({ secrets: [ETIMS_MASTER_KEY, ...EMAIL_SECRETS] }, async req => {
  requireAuth(req);
  const { hubId, orderId, buyerKraPin } = req.data;
  if (!hubId || !orderId) throw new HttpsError("invalid-argument", "hubId and orderId required");
  await requireHubAccess(req, hubId);

  const hub = await getHub(hubId);
  if (!hub.taxConfig?.issueEtims || !hub.etimsActive)
    throw new HttpsError("failed-precondition", "Hub eTIMS not active — run hubRegisterEtims first");

  const idKey = `hub-${hubId}-order-${orderId}`;
  const dup   = await db.collection("hubInvoices").where("idempotencyKey", "==", idKey).limit(1).get();
  if (!dup.empty) {
    const d = dup.docs[0].data();
    return { invoiceId: d.invoiceId, invoiceNumber: d.invoiceNumber, duplicate: true, status: d.status };
  }

  const orderSnap = await db.doc(`orders/${orderId}`).get();
  if (!orderSnap.exists) throw new HttpsError("not-found", "Order not found");

  const invoiceId = await _issueHubInvoice({ hubId, hub, orderId, order: orderSnap.data(), manualBuyerKraPin: buyerKraPin });
  const invSnap   = await db.doc(`hubInvoices/${invoiceId}`).get();
  return { invoiceId, ...invSnap.data() };
});

/* 10. hubResubmitInvoice ──────────────────────────────────────── */
exports.hubResubmitInvoice = onCall({ secrets: [] }, async req => {
  requireAuth(req);
  const { invoiceId } = req.data;
  if (!invoiceId) throw new HttpsError("invalid-argument", "invoiceId required");

  const snap = await db.doc(`hubInvoices/${invoiceId}`).get();
  if (!snap.exists) throw new HttpsError("not-found", "Hub invoice not found");

  const inv = snap.data();
  await requireHubAccess(req, inv.hubId);

  await _queueHubInvoice(inv.hubId, invoiceId, "Manual resubmit", inv.retryCount || 0);
  return { success: true, message: "Invoice queued for resubmission" };
});

/* 11. hubGetAuditTrail ─────────────────────────────────────────── */
exports.hubGetAuditTrail = onCall({ secrets: [] }, async req => {
  requireAuth(req);
  const { orderId } = req.data;
  if (!orderId) throw new HttpsError("invalid-argument", "orderId required");

  const uid     = req.auth.uid;
  const isAdmin = req.auth.token?.isAdmin;

  const orderSnap = await db.doc(`orders/${orderId}`).get();
  if (!orderSnap.exists) throw new HttpsError("not-found", "Order not found");
  const order = orderSnap.data();

  const hubId    = order.hubId;
  const isOwner  = order.userId === uid || order.sellerId === uid;
  const isMgr    = hubId ? await isHubManager(uid, hubId) : false;
  if (!isAdmin && !isOwner && !isMgr)
    throw new HttpsError("permission-denied", "Not authorised to view this audit trail");

  const [hubDocsSnap, sellerInvSnap, hubInvSnap] = await Promise.all([
    db.collection("hubDocuments").where("orderId","==",orderId).orderBy("issuedAt","asc").get(),
    db.collection("etimsInvoices").where("orderId","==",orderId).limit(5).get(),
    db.collection("hubInvoices").where("orderId","==",orderId).limit(5).get(),
  ]);

  const hubDocs      = hubDocsSnap.docs.map(d => d.data());
  const sellerInvs   = sellerInvSnap.docs.map(d => ({ ...d.data(), authority: "seller" }));
  const hubInvs      = hubInvSnap.docs.map(d => ({ ...d.data(), authority: "hub" }));

  let delivery = null;
  if (order.deliveryId) {
    const ds = await db.doc(`deliveries/${order.deliveryId}`).get().catch(() => null);
    if (ds?.exists) delivery = ds.data();
  }

  const allTax        = [...sellerInvs, ...hubInvs].filter(i => ["accepted","pending_submission"].includes(i.status));
  const duplicateRisk = allTax.length > 1;

  // Chronological timeline
  const events = [];
  const push = (at, event, type, extra = {}) => { if (at) events.push({ at, event, type, ...extra }); };
  push(order.createdAt,   "Order placed",   "order");
  push(order.confirmedAt, "Order confirmed","order");
  push(order.paidAt,      "Payment received","order");
  hubDocs.forEach(d => push(d.issuedAt, DOC_TYPES[d.docType]?.label || d.docType, "document", { docId: d.docId, docNumber: d.docNumber, htmlUrl: d.htmlUrl }));
  allTax.forEach(i       => push(i.createdAt, `Tax Invoice ${i.invoiceNumber} (${i.authority})`, "invoice", { invoiceId: i.invoiceId, status: i.status, kraReceiptNumber: i.kraReceiptNumber }));
  push(delivery?.deliveredAt, "Delivered", "delivery");
  events.sort((a, b) => (a.at || "").localeCompare(b.at || ""));

  return {
    orderId,
    order:         { status: order.status, total: order.total, createdAt: order.createdAt, hubId: order.hubId || null, invoiceAuthority: order.invoiceAuthority || "seller" },
    hubDocs,
    sellerInvoices: sellerInvs,
    hubInvoices:    hubInvs,
    delivery,
    timeline:       events,
    audit: {
      totalTaxInvoices: allTax.length,
      duplicateRisk,
      healthy:  !duplicateRisk,
      warning:  duplicateRisk ? "DUPLICATE INVOICE RISK: multiple active tax invoices exist for this order" : null,
    },
  };
});

/* 12. hubGetStats ─────────────────────────────────────────────── */
exports.hubGetStats = onCall({ secrets: [] }, async req => {
  requireAuth(req);
  const { hubId } = req.data;
  if (!hubId) throw new HttpsError("invalid-argument", "hubId required");
  await requireHubAccess(req, hubId);

  const hub = await getHub(hubId);

  const [docsSnap, invSnap, seqSnap] = await Promise.all([
    db.collection("hubDocuments").where("hubId","==",hubId).get(),
    db.collection("hubInvoices").where("hubId","==",hubId).get(),
    db.doc(`hubSequences/${hubId}`).get(),
  ]);

  const docs  = docsSnap.docs.map(d => d.data());
  const invs  = invSnap.docs.map(d => d.data());
  const seq   = seqSnap.data() || {};

  const docCounts = Object.fromEntries(Object.keys(DOC_TYPES).map(t => [t, 0]));
  docs.forEach(d => { if (docCounts[d.docType] !== undefined) docCounts[d.docType]++; });

  const recentDocs = docs.sort((a, b) => (b.issuedAt||"").localeCompare(a.issuedAt||"")).slice(0, 15);
  const recentInvs = invs.sort((a, b) => (b.createdAt||"").localeCompare(a.createdAt||"")).slice(0, 15);

  return {
    hub: { hubId, name: hub.name, type: hub.type, status: hub.status, etimsActive: hub.etimsActive },
    sequences: seq,
    documents: { total: docs.length, byType: docCounts },
    invoices: {
      total:        invs.length,
      accepted:     invs.filter(i => i.status === "accepted").length,
      pending:      invs.filter(i => i.status === "pending_submission").length,
      failed:       invs.filter(i => i.status === "failed").length,
      totalRevenue: invs.filter(i => i.status === "accepted").reduce((s, i) => s + (i.total || 0), 0),
      totalVat:     invs.filter(i => i.status === "accepted").reduce((s, i) => s + (i.vat   || 0), 0),
    },
    recentDocs,
    recentInvoices: recentInvs,
  };
});

/* 13. hubAdminGetAllStats ─────────────────────────────────────── */
exports.hubAdminGetAllStats = onCall({ secrets: [] }, async req => {
  requireAdmin(req);

  const [hubsSnap, docsSnap, invSnap] = await Promise.all([
    db.collection("hubs").where("status","==","active").get(),
    db.collection("hubDocuments").get(),
    db.collection("hubInvoices").get(),
  ]);

  const hubs    = hubsSnap.docs.map(d => d.data());
  const allDocs = docsSnap.docs.map(d => d.data());
  const allInv  = invSnap.docs.map(d => d.data());

  const overview = {
    totalHubs:       hubs.length,
    sellingHubs:     hubs.filter(h => ["selling","hybrid"].includes(h.type)).length,
    logisticsHubs:   hubs.filter(h => h.type === "logistics").length,
    marketplaceHubs: hubs.filter(h => h.type === "marketplace").length,
    etimsActiveHubs: hubs.filter(h => h.etimsActive).length,
    totalDocuments:  allDocs.length,
    totalInvoices:   allInv.length,
    acceptedInvoices:allInv.filter(i => i.status === "accepted").length,
    failedInvoices:  allInv.filter(i => i.status === "failed").length,
    totalRevenue:    allInv.filter(i => i.status === "accepted").reduce((s,i) => s + (i.total||0), 0),
    totalVat:        allInv.filter(i => i.status === "accepted").reduce((s,i) => s + (i.vat||0), 0),
  };

  const hubSummaries = hubs.map(h => {
    const hd = allDocs.filter(d => d.hubId === h.hubId);
    const hi = allInv.filter(i  => i.hubId === h.hubId);
    return {
      hubId:       h.hubId,
      name:        h.name,
      type:        h.type,
      etimsActive: h.etimsActive,
      documents:   hd.length,
      invoices:    hi.filter(i => i.status === "accepted").length,
      failed:      hi.filter(i => i.status === "failed").length,
      revenue:     hi.filter(i => i.status === "accepted").reduce((s,i) => s + (i.total||0), 0),
    };
  });

  return { overview, hubs: hubSummaries };
});
