/* ═══════════════════════════════════════════════════════════════════════
   SOKONI × KRA eTIMS Integration  v1.0
   Kenya Revenue Authority Electronic Tax Invoice Management System

   Architecture
   ─────────────────────────────────────────────────────────────────────
   • Each seller gets an independent eTIMS profile + encrypted credentials
   • SOKONI has its own KRA registration (platform fees / commissions)
   • Invoice numbers are atomic-sequential per seller — no gaps, no dupes
   • Failed submissions queue with exponential-backoff retry (5 attempts)
   • Bulk/periodic invoicing aggregates orders into a consolidated invoice
   • All invoices are immutable once accepted by KRA
   • HTML receipts stored in Firebase Storage; emailed to buyers on accept

   KRA eTIMS v3 API
   ─────────────────────────────────────────────────────────────────────
   Sandbox:    https://etims-api-sandbox.kra.go.ke/etims-api
   Production: https://etims-api.kra.go.ke/etims-api

   Required secrets (set via firebase functions:secrets:set <NAME>):
     ETIMS_MASTER_KEY       — 64-char hex (openssl rand -hex 32)
     ETIMS_PLATFORM_PIN     — SOKONI's KRA PIN (e.g. P051234567T)
     ETIMS_PLATFORM_SECRET  — SOKONI's eTIMS taxpayer secret
═══════════════════════════════════════════════════════════════════════ */
"use strict";

const { onCall, onRequest, HttpsError } = require("firebase-functions/v2/https");
const { onDocumentWritten }             = require("firebase-functions/v2/firestore");
const { onSchedule }                    = require("firebase-functions/v2/scheduler");
const { defineSecret }                  = require("firebase-functions/params");
const admin   = require("firebase-admin");
const crypto  = require("crypto");
const https   = require("https");
const emailSvc = require("./email-service");

const db = admin.firestore();

/* ── Secrets ─────────────────────────────────────────────────────────── */
const ETIMS_MASTER_KEY      = defineSecret("ETIMS_MASTER_KEY");
const ETIMS_PLATFORM_PIN    = defineSecret("ETIMS_PLATFORM_PIN");
const ETIMS_PLATFORM_SECRET = defineSecret("ETIMS_PLATFORM_SECRET");
const EMAIL_SECRETS         = emailSvc.EMAIL_SECRETS;

const _ALL_SECRETS = [ETIMS_MASTER_KEY, ETIMS_PLATFORM_PIN, ETIMS_PLATFORM_SECRET, ...EMAIL_SECRETS];

/* ── Runtime config ──────────────────────────────────────────────────── */
// Default to sandbox — safe fallback; production requires explicit opt-in via functions/.env
const ETIMS_PROD  = process.env.ETIMS_ENV === "production";
const ETIMS_BASE  = ETIMS_PROD
  ? "https://etims-api.kra.go.ke/etims-api"
  : "https://etims-api-sandbox.kra.go.ke/etims-api";

const VAT_RATE     = 0.16;
const MAX_RETRIES  = 5;
const QUEUE_LIMIT  = 100;
const RETRY_MIN    = [2, 10, 30, 120, 720]; // minutes per attempt
const KRA_PIN_RE   = /^[A-Z]\d{9}[A-Z]$/;

/* ══════════════════════════════════════════════════════════════════════
   KRA eTIMS API CLIENT
   Auth: HMAC-SHA256(tin + bhfId + timestamp, taxpayerSecret)
══════════════════════════════════════════════════════════════════════ */
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
      const url     = new URL(ETIMS_BASE + path);
      const opts    = {
        hostname: url.hostname, port: 443, path: url.pathname,
        method: "POST",
        headers: {
          "Content-Type":   "application/json",
          "Content-Length": Buffer.byteLength(payload),
          "tin":   this.tin,
          "bhfId": this.bhfId,
          "cmcKey": this._token(),
        },
        timeout: 20000,
      };
      const req = https.request(opts, res => {
        let data = "";
        res.on("data", c => (data += c));
        res.on("end", () => {
          try   { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
          catch { resolve({ status: res.statusCode, body: data }); }
        });
      });
      req.on("timeout", () => { req.destroy(); reject(new Error("eTIMS timeout")); });
      req.on("error", reject);
      req.write(payload);
      req.end();
    });
  }

  validatePin()           { return this._post("/selectInitOrgInfo",     { tin: this.tin, bhfId: this.bhfId }); }
  initOrg(mrcNo = "")    { return this._post("/selectInitInfo",         { tin: this.tin, bhfId: this.bhfId, sdcId: this.deviceSerial, mrcNo, dvcSrlNo: this.deviceSerial }); }
  submitInvoice(payload)  { return this._post("/saveTrnsSalesSdcInfo",   payload); }
  verifyInvoice(invcNo)   { return this._post("/selectTrnsSdcInfo",      { tin: this.tin, bhfId: this.bhfId, invcNo }); }
  getCodeList()           { return this._post("/selectCodeList",         { tin: this.tin, bhfId: this.bhfId, lastReqDt: "20240101000000" }); }
}

/* ══════════════════════════════════════════════════════════════════════
   CREDENTIAL ENCRYPTION  — AES-256-GCM, per-record IV, master key
══════════════════════════════════════════════════════════════════════ */
function _masterKey() {
  const raw = ETIMS_MASTER_KEY.value();
  if (!raw || raw.length < 64) throw new Error("ETIMS_MASTER_KEY must be 64 hex chars. Run: openssl rand -hex 32 | firebase functions:secrets:set ETIMS_MASTER_KEY");
  return Buffer.from(raw.slice(0, 64), "hex");
}

function encryptCred(plaintext) {
  const iv  = crypto.randomBytes(12);
  const cip = crypto.createCipheriv("aes-256-gcm", _masterKey(), iv);
  const enc = Buffer.concat([cip.update(plaintext, "utf8"), cip.final()]);
  const tag = cip.getAuthTag();
  return `${iv.toString("hex")}:${tag.toString("hex")}:${enc.toString("hex")}`;
}

function decryptCred(ciphertext) {
  const [ivH, tagH, encH] = ciphertext.split(":");
  if (!ivH || !tagH || !encH) throw new Error("Malformed encrypted credential");
  const dec = crypto.createDecipheriv("aes-256-gcm", _masterKey(), Buffer.from(ivH, "hex"));
  dec.setAuthTag(Buffer.from(tagH, "hex"));
  return dec.update(Buffer.from(encH, "hex"), undefined, "utf8") + dec.final("utf8");
}

/* ══════════════════════════════════════════════════════════════════════
   ATOMIC INVOICE SEQUENCE  — Firestore transaction, no gaps/dupes
══════════════════════════════════════════════════════════════════════ */
async function nextSeq(sellerUid) {
  const ref = db.collection("etimsSequences").doc(sellerUid);
  return db.runTransaction(async t => {
    const snap  = await t.get(ref);
    const next  = (snap.exists ? snap.data().sequence : 0) + 1;
    t.set(ref, { sequence: next, updatedAt: new Date().toISOString() }, { merge: true });
    return next;
  });
}

/* ══════════════════════════════════════════════════════════════════════
   TAX CALCULATION
   Cat A = VAT 16% (tax-inclusive price)
   Cat B = Zero-rated
   Cat C = Exempt
══════════════════════════════════════════════════════════════════════ */
function calcLine(item, vatStatus) {
  const qty    = item.quantity || 1;
  const prc    = item.unitPrice || 0;
  const dcRt   = item.discountRate || 0;
  const sply   = _r2(qty * prc);
  const dcAmt  = _r2(sply * dcRt / 100);
  const net    = _r2(sply - dcAmt);

  let vatCatCd, taxblAmt, taxAmt;
  if (vatStatus === "registered") {
    vatCatCd = "A";
    taxblAmt = _r2(net / (1 + VAT_RATE));
    taxAmt   = _r2(net - taxblAmt);
  } else if (vatStatus === "zero_rated") {
    vatCatCd = "B"; taxblAmt = net; taxAmt = 0;
  } else {
    vatCatCd = "C"; taxblAmt = 0;  taxAmt = 0;
  }

  return {
    itemSeq:  item.seq  || 1,
    itemClsCd: item.itemClassCode || "57111500",
    itemNm:   _trunc(item.name || "Item", 100),
    pkgUnitCd: "NT", pkg: qty, qtyUnitCd: "U", qty,
    prc, splyAmt: sply, dcRt, dcAmt: _r2(dcAmt),
    vatCatCd, taxblAmt, taxAmt, totAmt: net,
  };
}

function calcTotals(lines) {
  const t = { taxblAmtA:0, taxblAmtB:0, taxblAmtC:0, taxblAmtD:0, taxblAmtE:0,
              taxAmtA:0,   taxAmtB:0,   taxAmtC:0,   taxAmtD:0,   taxAmtE:0 };
  for (const l of lines) {
    if (l.vatCatCd === "A") { t.taxblAmtA += l.taxblAmt; t.taxAmtA += l.taxAmt; }
    if (l.vatCatCd === "B") { t.taxblAmtB += l.taxblAmt; }
    if (l.vatCatCd === "C") { t.taxblAmtC += l.taxblAmt; }
  }
  const totTaxblAmt = _r2(t.taxblAmtA + t.taxblAmtB + t.taxblAmtC);
  const totTaxAmt   = _r2(t.taxAmtA);
  const totAmt      = _r2(lines.reduce((s, l) => s + l.totAmt, 0));
  return { ...Object.fromEntries(Object.entries(t).map(([k,v]) => [k, _r2(v)])),
           totTaxblAmt, totTaxAmt, totAmt };
}

function _r2(n)       { return Math.round((n || 0) * 100) / 100; }
function _kraTs(d)    { return d.toISOString().replace(/[-:.TZ]/g,"").slice(0,14); }
function _kraDate(d)  { return d.toISOString().slice(0,10).replace(/-/g,""); }
function _trunc(s,n)  { return String(s||"").slice(0,n); }

/* ══════════════════════════════════════════════════════════════════════
   KRA PAYLOAD BUILDER
══════════════════════════════════════════════════════════════════════ */
function buildKraPayload({ profile, invcNo, pmtMethod, lineItems, buyer, remark }) {
  const now    = new Date();
  const lines  = lineItems.map((item, i) => calcLine({ ...item, seq: i+1 }, profile.vatStatus));
  const totals = calcTotals(lines);

  const pmtTyCd = pmtMethod === "cash" ? "03"   // Cash
                : pmtMethod === "card" ? "04"   // Card
                : "01";                         // M-Pesa / mobile

  return {
    tpin: profile.kraPin, bhfId: profile.branchId || "00",
    invcNo, orgInvcNo: 0,
    rcptTyCd: "S", pmtTyCd, salesSttsCd: "02",
    cfmDt: _kraTs(now), salesDt: _kraDate(now),
    stockRlsDt: null, cnclReqDt: null, cnclDt: null,
    rfdDt: null, rfdRsnCd: null,
    totItemCnt: lines.length,
    ...totals,
    taxRtA: 16, taxRtB: 0, taxRtC: 0, taxRtD: 0, taxRtE: 0,
    prchrAcptcYn: buyer?.kraPin ? "Y" : "N",
    remark: remark ? _trunc(remark, 400) : null,
    regrId: "sokoni-system", regrNm: "SOKONI System",
    modrId: "sokoni-system", modrNm: "SOKONI System",
    receipt: {
      custTin:    buyer?.kraPin || null,
      custMblNo:  buyer?.phone  || null,
      rptNo:      invcNo,
      rcptPbctDt: _kraTs(now),
      trdeNm:     _trunc(profile.businessName, 60),
      adrs:       _trunc(profile.address || "Kenya", 200),
      topMsg:     "Thank you for your business",
      btmMsg:     "Powered by SOKONI | mysokoni.co.ke",
      prchrAcptcYn: buyer?.kraPin ? "Y" : "N",
    },
    itemList: lines,
  };
}

/* ══════════════════════════════════════════════════════════════════════
   HTML RECEIPT GENERATOR
   Self-contained, print-ready A4 page. Buyer clicks "Print → Save as PDF".
══════════════════════════════════════════════════════════════════════ */
function buildReceiptHtml({ invoice, profile, buyer }) {
  const _e = s => String(s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
  const _f = n => Number(n||0).toLocaleString("en-KE",{minimumFractionDigits:2,maximumFractionDigits:2});

  const rows = (invoice.lineItems||[]).map(li=>`
    <tr>
      <td>${_e(li.itemNm)}</td>
      <td class="c">${li.qty}</td>
      <td class="r">KES ${_f(li.prc)}</td>
      <td class="c">${li.dcRt||0}%</td>
      <td class="c">${li.vatCatCd}</td>
      <td class="r">KES ${_f(li.taxblAmt)}</td>
      <td class="r">KES ${_f(li.taxAmt)}</td>
      <td class="r"><b>KES ${_f(li.totAmt)}</b></td>
    </tr>`).join("");

  const t = invoice.totals || {};
  const accepted = invoice.status === "accepted";
  const isoDate  = invoice.createdAt ? new Date(invoice.createdAt).toLocaleDateString("en-KE",{day:"2-digit",month:"short",year:"numeric"}) : "";

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<title>KRA Invoice ${_e(invoice.invoiceNumber)}</title>
<style>
@page{size:A4;margin:16mm}
*{box-sizing:border-box}
body{font-family:Arial,Helvetica,sans-serif;font-size:11px;color:#111;margin:0}
.printbar{background:#003366;color:#fff;padding:7px 16px;text-align:center;font-size:12px;display:flex;justify-content:space-between;align-items:center}
.printbar a{color:#71ff00;font-weight:700;text-decoration:none;border:1px solid #71ff00;padding:3px 10px;border-radius:4px}
.hdr{display:flex;justify-content:space-between;align-items:flex-start;margin:0 0 16px}
.brand h1{font-size:24px;color:#003366;margin:0 0 3px}
.brand p{margin:2px 0;color:#444;font-size:10px}
.kra-badge{background:#003366;color:#fff;border-radius:8px;padding:10px 16px;text-align:center;min-width:180px}
.kra-badge .lbl{font-size:9px;text-transform:uppercase;letter-spacing:1px;opacity:.7}
.kra-badge .num{font-size:18px;font-weight:800;margin:4px 0}
.kra-badge .dt{font-size:10px;opacity:.7}
.ok{display:inline-block;background:#71ff00;color:#003;font-size:9px;font-weight:700;border-radius:3px;padding:1px 7px;margin-top:4px}
.parties{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:14px}
.party{background:#f6f8fa;border-radius:6px;padding:9px 12px;border-left:3px solid #003366}
.party strong{display:block;font-size:11px;color:#003366;margin-bottom:4px;text-transform:uppercase;letter-spacing:.3px}
.stitle{font-size:9px;text-transform:uppercase;color:#888;font-weight:700;letter-spacing:.5px;margin:12px 0 5px}
table{width:100%;border-collapse:collapse;margin-bottom:12px}
th{background:#003366;color:#fff;padding:6px 7px;text-align:left;font-size:9px;text-transform:uppercase}
td{padding:5px 7px;border-bottom:1px solid #eee;font-size:10px}
tr:last-child td{border-bottom:none}
.c{text-align:center}
.r{text-align:right}
.totals{float:right;width:270px}
.totals table td{border:none;padding:3px 5px}
.tot-row td{border-top:2px solid #003366!important;font-size:13px;font-weight:700;padding-top:6px!important}
.qr-sec{clear:both;margin-top:18px;border-top:2px dashed #ccc;padding-top:14px;display:flex;gap:20px;align-items:flex-start}
.qr-sec img{width:100px;height:100px;border:1px solid #ddd;flex-shrink:0}
.qr-placeholder{width:100px;height:100px;border:1px solid #ddd;display:flex;align-items:center;justify-content:center;font-size:9px;color:#aaa;flex-shrink:0}
.foot{margin-top:14px;border-top:1px solid #eee;padding-top:8px;font-size:9px;color:#888;line-height:1.5}
.vat-badge{display:inline-block;background:#e8f5e9;color:#1b5e20;border:1px solid #a5d6a7;border-radius:3px;padding:1px 6px;font-size:9px;font-weight:700}
@media print{.printbar{display:none!important}.hdr{margin-top:0}}
</style></head><body>

<div class="printbar no-print">
  <span>KRA eTIMS Fiscal Invoice — ${_e(invoice.invoiceNumber)}</span>
  <a href="#" onclick="window.print();return false">🖨 Print / Save as PDF</a>
</div>

<div class="hdr">
  <div class="brand">
    <h1>SOKONI</h1>
    <p><b>${_e(profile.businessName)}</b></p>
    <p>KRA PIN: <b>${_e(profile.kraPin)}</b> &nbsp;|&nbsp; Branch: ${_e(profile.branchId||"00")}</p>
    ${profile.address?`<p>${_e(profile.address)}</p>`:""}
    ${profile.vatStatus==="registered"?`<span class="vat-badge">VAT Registered</span>`:""}
  </div>
  <div class="kra-badge">
    <div class="lbl">KRA eTIMS Invoice</div>
    <div class="num">${_e(invoice.invoiceNumber)}</div>
    <div class="dt">${isoDate}</div>
    ${accepted?`<div class="ok">✓ KRA ACCEPTED</div>`:`<div style="font-size:9px;opacity:.7;margin-top:3px">Pending KRA</div>`}
  </div>
</div>

<div class="parties">
  <div class="party">
    <strong>Seller / Supplier</strong>
    ${_e(profile.businessName)}<br>
    KRA PIN: ${_e(profile.kraPin)}<br>
    ${profile.email?_e(profile.email)+"<br>":""}
    ${profile.phone?_e(profile.phone):""}
  </div>
  <div class="party">
    <strong>Buyer / Customer</strong>
    ${_e(buyer?.name||"Walk-in Customer")}<br>
    ${buyer?.kraPin?"KRA PIN: "+_e(buyer.kraPin)+"<br>":""}
    ${buyer?.phone?_e(buyer.phone)+"<br>":""}
    ${buyer?.email?_e(buyer.email):""}
  </div>
</div>

${invoice.orderId?`<p style="font-size:10px;color:#666;margin:0 0 10px">Order reference: <b>${_e(invoice.orderId)}</b>${invoice.periodStart?` &nbsp;|&nbsp; Period: ${invoice.periodStart.slice(0,10)} → ${invoice.periodEnd.slice(0,10)}`:""}</p>`:""}

<div class="stitle">Invoice Items</div>
<table>
  <thead><tr>
    <th>Description</th><th class="c">Qty</th><th class="r">Unit Price</th>
    <th class="c">Disc</th><th class="c">VAT Cat</th>
    <th class="r">Taxable</th><th class="r">VAT</th><th class="r">Total</th>
  </tr></thead>
  <tbody>${rows}</tbody>
</table>

<div class="totals">
  <div class="stitle">Tax Summary</div>
  <table>
    ${t.taxblAmtA?`<tr><td>Taxable (Cat A)</td><td class="r">KES ${_f(t.taxblAmtA)}</td></tr>`:""}
    ${t.taxAmtA?`<tr><td>VAT 16% (Cat A)</td><td class="r">KES ${_f(t.taxAmtA)}</td></tr>`:""}
    ${t.taxblAmtB?`<tr><td>Zero-Rated (Cat B)</td><td class="r">KES ${_f(t.taxblAmtB)}</td></tr>`:""}
    ${t.taxblAmtC?`<tr><td>Exempt (Cat C)</td><td class="r">KES ${_f(t.taxblAmtC)}</td></tr>`:""}
    <tr class="tot-row"><td>TOTAL (KES)</td><td class="r">${_f(t.totAmt)}</td></tr>
  </table>
</div>
<div style="clear:both"></div>

<div class="qr-sec">
  ${invoice.qrCode
    ? `<img src="${_e(invoice.qrCode)}" alt="KRA QR Code">`
    : `<div class="qr-placeholder">QR pending KRA</div>`}
  <div>
    <b style="font-size:12px">KRA Verification</b><br>
    <span style="font-size:10px">Receipt #: <b>${_e(invoice.receiptNumber||"Pending")}</b></span><br>
    <span style="font-size:10px">Control Unit #: <b>${_e(invoice.controlUnitNumber||"Pending")}</b></span><br>
    ${invoice.verificationUrl
      ? `<a href="${_e(invoice.verificationUrl)}" style="font-size:9px;color:#003366">Verify at KRA Portal →</a>`
      : ""}
  </div>
</div>

<div class="foot">
  This is an official KRA eTIMS fiscal receipt valid as a VAT invoice under the Tax Procedures Act, 2015.
  The KRA Control Unit Number and digital signature confirm authenticity. For queries: support@mysokoni.co.ke
  &nbsp;|&nbsp; <b>mysokoni.co.ke</b>
</div>

</body></html>`;
}

/* ══════════════════════════════════════════════════════════════════════
   SAVE RECEIPT HTML → Firebase Storage (returns public URL)
══════════════════════════════════════════════════════════════════════ */
async function saveReceiptHtml(invoiceId, data) {
  try {
    const html   = buildReceiptHtml(data);
    const bucket = admin.storage().bucket();
    const file   = bucket.file(`etims-receipts/${invoiceId}.html`);
    await file.save(html, {
      contentType: "text/html; charset=utf-8",
      metadata:    { cacheControl: "private, max-age=7200" },
    });
    await file.makePublic();
    return `https://storage.googleapis.com/${bucket.name}/etims-receipts/${invoiceId}.html`;
  } catch (e) {
    console.warn("[eTIMS] Storage save failed:", e.message);
    return null;
  }
}

/* ══════════════════════════════════════════════════════════════════════
   QUEUE HELPERS
══════════════════════════════════════════════════════════════════════ */
async function enqueue({ invoiceId, sellerUid, priority = 3 }) {
  const ref = db.collection("etimsQueue").doc();
  await ref.set({
    queueId: ref.id, invoiceId, sellerUid, priority,
    status: "pending", retryCount: 0, maxRetries: MAX_RETRIES,
    nextRetryAt: new Date().toISOString(),
    createdAt: new Date().toISOString(), processedAt: null, error: null,
  });
  return ref.id;
}

function retryAt(n) {
  const mins = RETRY_MIN[Math.min(n, RETRY_MIN.length - 1)];
  return new Date(Date.now() + mins * 60_000).toISOString();
}

/* ══════════════════════════════════════════════════════════════════════
   LOAD SELLER eTIMS CLIENT (decrypts credentials)
══════════════════════════════════════════════════════════════════════ */
async function sellerClient(sellerUid) {
  const [credSnap, profSnap] = await Promise.all([
    db.collection("etimsCredentials").doc(sellerUid).get(),
    db.collection("etimsProfiles").doc(sellerUid).get(),
  ]);
  if (!credSnap.exists) throw new Error("No eTIMS credentials for seller");
  if (!profSnap.exists) throw new Error("No eTIMS profile for seller");

  const profile = profSnap.data();
  const cred    = credSnap.data();
  return {
    client: new EtimsClient({
      tin:            profile.kraPin,
      bhfId:          profile.branchId,
      deviceSerial:   decryptCred(cred.deviceSerialEnc),
      taxpayerSecret: decryptCred(cred.taxpayerSecretEnc),
    }),
    profile,
  };
}

/* ══════════════════════════════════════════════════════════════════════
   SUBMIT TO KRA — throws on rejection
══════════════════════════════════════════════════════════════════════ */
async function submitToKra(client, kraPayload) {
  const res = await client.submitInvoice(kraPayload);
  if (res.status !== 200 || res.body?.resultCd !== "000") {
    throw new Error(res.body?.resultMsg || `KRA HTTP ${res.status}`);
  }
  const d = res.body?.data || {};
  return {
    receiptNumber:     d.rcptNo     || null,
    controlUnitNumber: d.intrlData  || null,
    qrCode:            d.qrCodeUrl  || d.rcptSgn || null,
    verificationUrl:   d.vsdcRcptUrl|| null,
    receiptSignature:  d.rcptSgn    || null,
    kraResponse:       res.body,
    status:            "accepted",
    acceptedAt:        new Date().toISOString(),
    submittedAt:       new Date().toISOString(),
  };
}

/* ══════════════════════════════════════════════════════════════════════
   CONVERT ORDER → LINE ITEMS
══════════════════════════════════════════════════════════════════════ */
function orderToLines(order) {
  const items = order?.items || order?.products || [];
  if (items.length) {
    return items.map(it => ({
      name:          it.name || it.productName || "Item",
      quantity:      it.quantity || it.qty || 1,
      unitPrice:     it.price || it.unitPrice || 0,
      discountRate:  it.discountRate || 0,
      itemClassCode: it.itemClassCode || "57111500",
    }));
  }
  return [{ name: order?.description || "Order", quantity: 1, unitPrice: order?.totalAmount || order?.amount || 0, discountRate: 0 }];
}

/* ══════════════════════════════════════════════════════════════════════
   EMAIL RECEIPT TO BUYER
══════════════════════════════════════════════════════════════════════ */
async function emailBuyer({ invoice, profile, buyer }) {
  if (!buyer?.email) return;
  try {
    const _f = n => Number(n||0).toLocaleString("en-KE",{minimumFractionDigits:2,maximumFractionDigits:2});
    const t  = invoice.totals || {};
    await emailSvc.send({
      to:      buyer.email,
      from:    emailSvc.FROM.orders,
      subject: `KRA Receipt #${invoice.invoiceNumber} — ${profile.businessName}`,
      html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px">
        <h2 style="color:#003366">Your KRA eTIMS Receipt</h2>
        <p>Dear <b>${buyer.name||"Customer"}</b>,</p>
        <p>Your purchase from <b>${profile.businessName}</b> has been invoiced and submitted to KRA.</p>
        <table style="width:100%;border-collapse:collapse;margin:16px 0">
          <tr style="background:#f6f8fa"><td style="padding:8px;border:1px solid #e0e0e0"><b>Invoice #</b></td><td style="padding:8px;border:1px solid #e0e0e0">${invoice.invoiceNumber}</td></tr>
          <tr><td style="padding:8px;border:1px solid #e0e0e0"><b>Date</b></td><td style="padding:8px;border:1px solid #e0e0e0">${new Date(invoice.createdAt).toLocaleDateString("en-KE")}</td></tr>
          ${t.taxAmtA?`<tr style="background:#f6f8fa"><td style="padding:8px;border:1px solid #e0e0e0"><b>VAT (16%)</b></td><td style="padding:8px;border:1px solid #e0e0e0">KES ${_f(t.taxAmtA)}</td></tr>`:""}
          <tr style="font-size:14px;font-weight:700"><td style="padding:8px;border:1px solid #e0e0e0">Total</td><td style="padding:8px;border:1px solid #e0e0e0;color:#003366">KES ${_f(t.totAmt)}</td></tr>
          ${invoice.receiptNumber?`<tr style="background:#f6f8fa"><td style="padding:8px;border:1px solid #e0e0e0"><b>KRA Receipt #</b></td><td style="padding:8px;border:1px solid #e0e0e0">${invoice.receiptNumber}</td></tr>`:""}
        </table>
        ${invoice.pdfUrl?`<p><a href="${invoice.pdfUrl}" style="background:#003366;color:#fff;padding:10px 22px;border-radius:6px;text-decoration:none;font-weight:700">📄 View / Download Invoice</a></p>`:""}
        ${invoice.verificationUrl?`<p style="font-size:11px;color:#666">Verify at KRA: <a href="${invoice.verificationUrl}">${invoice.verificationUrl}</a></p>`:""}
        <p style="font-size:11px;color:#999;margin-top:20px">Powered by SOKONI | mysokoni.co.ke</p>
      </div>`,
    });
    await db.collection("etimsInvoices").doc(invoice.invoiceId).update({ emailSentAt: new Date().toISOString() });
  } catch (e) {
    console.warn("[eTIMS] Email failed:", e.message);
  }
}

/* ══════════════════════════════════════════════════════════════════════
   NOTIFY SELLER OF SUBMISSION FAILURE
══════════════════════════════════════════════════════════════════════ */
async function notifySeller(sellerUid, invoiceId, errMsg) {
  try {
    const snap  = await db.collection("shops").doc(sellerUid).get();
    const email = snap.data()?.email;
    if (email) {
      await emailSvc.send({
        to: email, from: emailSvc.FROM.seller,
        subject: "Action Required: eTIMS Invoice Submission Failed",
        html: `<p>Invoice <b>${invoiceId}</b> failed to submit to KRA:<br><em>${errMsg}</em></p>
               <p>SOKONI will retry automatically. You can also resubmit manually from your seller dashboard → eTIMS.</p>`,
      });
    }
    await db.collection("etimsAlerts").add({
      sellerUid, invoiceId, error: errMsg,
      type: "submission_failure", status: "open",
      createdAt: new Date().toISOString(),
    });
  } catch (e) { /* non-fatal */ }
}

/* ── Stat counter helper ──────────────────────────────────────────── */
async function bumpStats(sellerUid, field) {
  await db.collection("etimsProfiles").doc(sellerUid).update({
    [field]: admin.firestore.FieldValue.increment(1),
    updatedAt: new Date().toISOString(),
  }).catch(() => {});
}

/* ══════════════════════════════════════════════════════════════════════
   CORE: GENERATE + SUBMIT INVOICE FOR AN ORDER
══════════════════════════════════════════════════════════════════════ */
async function generateForOrder({ sellerUid, orderId, order, buyer, isPlatform = false }) {
  const idempotencyKey = isPlatform
    ? `platform-order-${orderId}`
    : `${sellerUid}-order-${orderId}`;

  /* Idempotency guard */
  const dup = await db.collection("etimsInvoices").where("idempotencyKey","==",idempotencyKey).limit(1).get();
  if (!dup.empty) return { invoiceId: dup.docs[0].id, duplicate: true };

  const profSnap = await db.collection("etimsProfiles").doc(sellerUid).get();
  if (!profSnap.exists || profSnap.data().status !== "active")
    return { skipped: true, reason: "eTIMS not active" };

  const profile = profSnap.data();
  const invcNo  = await nextSeq(sellerUid);
  const invNo   = `${profile.invoicePrefix||"INV"}-${String(invcNo).padStart(6,"0")}`;

  const lineItems = orderToLines(order);
  const kraLines  = lineItems.map((it,i) => calcLine({...it,seq:i+1}, profile.vatStatus));
  const totals    = calcTotals(kraLines);

  const invRef  = db.collection("etimsInvoices").doc();
  const now     = new Date().toISOString();
  const invDoc  = {
    invoiceId: invRef.id, idempotencyKey,
    sellerUid, orderId, bulkJobId: null, orderIds: null,
    buyerUid: buyer?.uid || order?.buyerUid || null,
    invoiceNumber: invNo, internalSequence: invcNo,
    isPlatformInvoice: isPlatform,
    seller:  { kraPin: profile.kraPin, name: profile.businessName, branchId: profile.branchId||"00" },
    buyer:   buyer || { name: "Walk-in Customer" },
    lineItems: kraLines, totals, currency: "KES",
    receiptNumber: null, controlUnitNumber: null, qrCode: null,
    verificationUrl: null, receiptSignature: null, kraResponse: null,
    invoiceType: "sale", status: "draft",
    retryCount: 0, errorMessage: null, pdfUrl: null, emailSentAt: null,
    createdAt: now, updatedAt: now, submittedAt: null, acceptedAt: null,
  };
  await invRef.set(invDoc);

  /* Attempt immediate KRA submission */
  try {
    const { client } = await sellerClient(sellerUid);
    const kraPayload  = buildKraPayload({
      profile, invcNo, lineItems,
      pmtMethod: order?.paymentMethod, buyer,
      remark: orderId ? `Order ${orderId}` : null,
    });
    const kraResult = await submitToKra(client, kraPayload);

    await invRef.update({ ...kraResult, updatedAt: new Date().toISOString() });
    bumpStats(sellerUid, "totalInvoices");

    const merged  = { ...invDoc, ...kraResult };
    const pdfUrl  = await saveReceiptHtml(invRef.id, { invoice: merged, profile, buyer: invDoc.buyer });
    if (pdfUrl) await invRef.update({ pdfUrl });
    emailBuyer({ invoice: { ...merged, pdfUrl, invoiceId: invRef.id }, profile, buyer: invDoc.buyer });

    return { invoiceId: invRef.id, invoiceNumber: invNo, status: "accepted" };

  } catch (err) {
    await invRef.update({ status: "pending_submission", errorMessage: err.message, updatedAt: new Date().toISOString() });
    await enqueue({ invoiceId: invRef.id, sellerUid, priority: 2 });
    notifySeller(sellerUid, invRef.id, err.message);
    bumpStats(sellerUid, "pendingInvoices");
    return { invoiceId: invRef.id, invoiceNumber: invNo, status: "queued", error: err.message };
  }
}

/* ════════════════════════════════════════════════════════════════════
   EXPORTED CLOUD FUNCTIONS
════════════════════════════════════════════════════════════════════ */

/* 1 ─ Register seller eTIMS profile */
const etimsRegisterSeller = onCall({ secrets: _ALL_SECRETS, enforceAppCheck: true }, async req => {
  if (!req.auth) throw new HttpsError("unauthenticated","Sign in required");
  const uid = req.auth.uid;
  const { kraPin, businessName, branchId, deviceSerial, taxpayerSecret,
          vatStatus, taxCategory, invoicePrefix, address, phone } = req.data;

  if (!kraPin || !KRA_PIN_RE.test((kraPin||"").toUpperCase().trim()))
    throw new HttpsError("invalid-argument","KRA PIN must match P051234567T format");
  if (!businessName?.trim()) throw new HttpsError("invalid-argument","Business name required");
  if (!deviceSerial?.trim()) throw new HttpsError("invalid-argument","eTIMS device serial required");
  if (!taxpayerSecret?.trim()) throw new HttpsError("invalid-argument","Taxpayer secret required");

  const existing = await db.collection("etimsProfiles").doc(uid).get();
  if (existing.exists && existing.data().status === "active")
    throw new HttpsError("already-exists","Active eTIMS profile already exists");

  /* KRA PIN validation (live check in production) */
  if (ETIMS_PROD) {
    const c   = new EtimsClient({ tin: kraPin.toUpperCase().trim(), bhfId: branchId||"00", deviceSerial, taxpayerSecret });
    const res = await c.validatePin().catch(e => { throw new HttpsError("unavailable","KRA check failed: "+e.message); });
    if (res.body?.resultCd !== "000")
      throw new HttpsError("invalid-argument","KRA rejected PIN: " + (res.body?.resultMsg||"unknown"));
  }

  const pin = kraPin.toUpperCase().trim();
  const now = new Date().toISOString();

  await Promise.all([
    db.collection("etimsProfiles").doc(uid).set({
      sellerUid: uid, kraPin: pin,
      businessName: businessName.trim(),
      vatStatus:    vatStatus    || "registered",
      branchId:     branchId    || "00",
      taxCategory:  taxCategory || "A",
      invoicePrefix: (invoicePrefix||"INV").toUpperCase().trim().slice(0,6),
      address: address||"", phone: phone||"",
      status: "active", kraVerified: true,
      totalInvoices: 0, pendingInvoices: 0, failedInvoices: 0,
      lastSubmissionAt: null, createdAt: now, updatedAt: now, enabledAt: now,
    }),
    db.collection("etimsCredentials").doc(uid).set({
      sellerUid: uid,
      deviceSerialEnc:    encryptCred(deviceSerial),
      taxpayerSecretEnc:  encryptCred(taxpayerSecret),
      updatedAt: now,
    }),
    db.collection("etimsSequences").doc(uid).get().then(s =>
      s.exists ? null : db.collection("etimsSequences").doc(uid).set({ sequence: 0, updatedAt: now })
    ),
  ]);

  return { success: true, status: "active" };
});

/* 2 ─ Get own eTIMS profile */
const etimsGetProfile = onCall({ enforceAppCheck: true }, async req => {
  if (!req.auth) throw new HttpsError("unauthenticated","Sign in required");
  const snap = await db.collection("etimsProfiles").doc(req.auth.uid).get();
  if (!snap.exists) return { profile: null };
  return { profile: snap.data() };
});

/* 3 ─ Update eTIMS profile (non-credential fields) */
const etimsUpdateProfile = onCall({ secrets: [ETIMS_MASTER_KEY], enforceAppCheck: true }, async req => {
  if (!req.auth) throw new HttpsError("unauthenticated","Sign in required");
  const uid  = req.auth.uid;
  const snap = await db.collection("etimsProfiles").doc(uid).get();
  if (!snap.exists) throw new HttpsError("not-found","Register eTIMS first");

  const allow  = ["businessName","vatStatus","taxCategory","invoicePrefix","address","phone"];
  const update = { updatedAt: new Date().toISOString() };
  for (const k of allow) if (req.data[k] !== undefined) update[k] = req.data[k];
  if (update.invoicePrefix) update.invoicePrefix = update.invoicePrefix.toUpperCase().trim().slice(0,6);

  await db.collection("etimsProfiles").doc(uid).update(update);
  return { success: true };
});

/* 4 ─ Validate KRA PIN format (deep validation happens at register) */
const etimsValidatePin = onCall({ enforceAppCheck: true }, req => {
  const pin = (req.data?.kraPin||"").toUpperCase().trim();
  const valid = KRA_PIN_RE.test(pin);
  return { valid, message: valid ? "Format valid" : "Expected format: P051234567T (letter + 9 digits + letter)" };
});

/* 5 ─ Manually generate invoice for a specific order */
const etimsGenerateInvoice = onCall({ secrets: _ALL_SECRETS, enforceAppCheck: true }, async req => {
  if (!req.auth) throw new HttpsError("unauthenticated","Sign in required");
  const { orderId } = req.data;
  if (!orderId) throw new HttpsError("invalid-argument","orderId required");

  const sellerUid = req.auth.uid;
  const orderSnap = await db.collection("orders").doc(orderId).get();
  if (!orderSnap.exists) throw new HttpsError("not-found","Order not found");
  const order = orderSnap.data();
  if (order.sellerUid !== sellerUid) throw new HttpsError("permission-denied","Not your order");

  let buyer = null;
  if (order.buyerUid) {
    const bs = await db.collection("users").doc(order.buyerUid).get();
    if (bs.exists) { const d=bs.data(); buyer={ uid:order.buyerUid, name:d.displayName||d.name, email:d.email, phone:d.phone, kraPin:req.data.buyerKraPin||null }; }
  }

  return generateForOrder({ sellerUid, orderId, order, buyer });
});

/* 6 ─ Firestore trigger: auto-invoice when order reaches completed/delivered */
const etimsOnOrderCompleted = onDocumentWritten(
  { document:"orders/{orderId}", secrets: _ALL_SECRETS },
  async event => {
    const before = event.data.before?.data();
    const after  = event.data.after?.data();
    if (!after) return;
    const done = ["completed","delivered","order_delivered"];
    if (!done.includes(after.status)) return;
    if (before && done.includes(before.status)) return;

    // Hub routing: if this order belongs to a selling/hybrid hub, defer to
    // hubOnOrderCompleted in hub-etims.js which has exclusive invoice authority.
    const hubId = after.hubId || after.invoiceAuthority === "hub" ? after.hubId : null;
    if (hubId) {
      const hubSnap = await db.collection("hubs").doc(hubId).get().catch(() => null);
      if (hubSnap?.exists && hubSnap.data().taxConfig?.invoiceAuthority === "hub") {
        console.log(`[etimsOnOrderCompleted] deferred to hub ${hubId} for order ${event.params.orderId}`);
        return;
      }
    }

    const { sellerUid, buyerUid } = after;
    if (!sellerUid) return;

    const profSnap = await db.collection("etimsProfiles").doc(sellerUid).get();
    if (!profSnap.exists || profSnap.data().status !== "active") return;

    let buyer = null;
    if (buyerUid) {
      const bs = await db.collection("users").doc(buyerUid).get();
      if (bs.exists) { const d=bs.data(); buyer={ uid:buyerUid, name:d.displayName||d.name, email:d.email, phone:d.phone, kraPin:null }; }
    }

    await generateForOrder({ sellerUid, orderId: event.params.orderId, order: after, buyer })
      .catch(e => console.error("[eTIMS] Auto-invoice trigger failed:", e.message));
  }
);

/* 7 ─ Resubmit failed invoice */
const etimsResubmitInvoice = onCall({ secrets: _ALL_SECRETS, enforceAppCheck: true }, async req => {
  if (!req.auth) throw new HttpsError("unauthenticated","Sign in required");
  const { invoiceId } = req.data;
  if (!invoiceId) throw new HttpsError("invalid-argument","invoiceId required");

  const snap = await db.collection("etimsInvoices").doc(invoiceId).get();
  if (!snap.exists) throw new HttpsError("not-found","Invoice not found");
  const inv = snap.data();

  const isAdmin = req.auth.token?.isAdmin === true;
  if (inv.sellerUid !== req.auth.uid && !isAdmin)
    throw new HttpsError("permission-denied","Not your invoice");
  if (inv.status === "accepted") return { success: true, message: "Already accepted" };

  await db.collection("etimsInvoices").doc(invoiceId).update({ status:"pending_submission", updatedAt:new Date().toISOString() });
  await enqueue({ invoiceId, sellerUid: inv.sellerUid, priority: 1 });
  return { success: true, message: "Queued for resubmission" };
});

/* 8 ─ Scheduled: Process queue every 5 minutes */
const etimsProcessQueue = onSchedule(
  { schedule:"*/5 * * * *", timeZone:"Africa/Nairobi", timeoutSeconds:540, secrets: _ALL_SECRETS },
  async () => {
    const now  = new Date().toISOString();
    const snap = await db.collection("etimsQueue")
      .where("status","==","pending")
      .where("nextRetryAt","<=",now)
      .orderBy("priority","asc").orderBy("nextRetryAt","asc")
      .limit(QUEUE_LIMIT).get();

    if (snap.empty) return;

    for (const doc of snap.docs) {
      const q = doc.data();
      await doc.ref.update({ status:"processing", processedAt: now });

      const invSnap = await db.collection("etimsInvoices").doc(q.invoiceId).get();
      if (!invSnap.exists) { await doc.ref.update({ status:"completed", error:"Invoice gone" }); continue; }
      const inv = invSnap.data();
      if (inv.status === "accepted") { await doc.ref.update({ status:"completed" }); continue; }

      try {
        const { client, profile } = await sellerClient(q.sellerUid);
        const orderSnap = inv.orderId ? await db.collection("orders").doc(inv.orderId).get() : null;
        const kraPayload = buildKraPayload({
          profile, invcNo: inv.internalSequence,
          lineItems: inv.lineItems,
          pmtMethod: orderSnap?.data()?.paymentMethod,
          buyer: inv.buyer,
          remark: inv.orderId ? `Order ${inv.orderId}` : null,
        });

        const kraResult = await submitToKra(client, kraPayload);
        await db.collection("etimsInvoices").doc(q.invoiceId).update({
          ...kraResult, retryCount: (inv.retryCount||0)+1, updatedAt: new Date().toISOString(),
        });
        await doc.ref.update({ status:"completed" });
        bumpStats(q.sellerUid, "totalInvoices");

        const merged  = { ...inv, ...kraResult, invoiceId: q.invoiceId };
        const pdfUrl  = await saveReceiptHtml(q.invoiceId, { invoice: merged, profile, buyer: inv.buyer });
        if (pdfUrl) await db.collection("etimsInvoices").doc(q.invoiceId).update({ pdfUrl });
        emailBuyer({ invoice: { ...merged, pdfUrl }, profile, buyer: inv.buyer });

      } catch (err) {
        const retries = (q.retryCount||0) + 1;
        if (retries >= MAX_RETRIES) {
          await doc.ref.update({ status:"failed", retryCount: retries, error: err.message });
          await db.collection("etimsInvoices").doc(q.invoiceId).update({ status:"failed", retryCount: retries, errorMessage: err.message, updatedAt: new Date().toISOString() });
          notifySeller(q.sellerUid, q.invoiceId, `Max retries reached: ${err.message}`);
          bumpStats(q.sellerUid, "failedInvoices");
        } else {
          await doc.ref.update({ status:"pending", retryCount: retries, nextRetryAt: retryAt(retries), error: err.message });
        }
      }
    }
  }
);

/* 9 ─ Bulk / periodic invoice generation */
const etimsBulkGenerate = onCall({ secrets: _ALL_SECRETS, timeoutSeconds:300, enforceAppCheck: true }, async req => {
  if (!req.auth) throw new HttpsError("unauthenticated","Sign in required");
  const sellerUid = req.auth.uid;
  const { periodStart, periodEnd, billingPeriod } = req.data;
  if (!periodStart || !periodEnd) throw new HttpsError("invalid-argument","periodStart + periodEnd required (ISO)");

  const profSnap = await db.collection("etimsProfiles").doc(sellerUid).get();
  if (!profSnap.exists || profSnap.data().status !== "active")
    throw new HttpsError("failed-precondition","eTIMS not active");
  const profile = profSnap.data();

  const idempotencyKey = `${sellerUid}-bulk-${periodStart}-${periodEnd}`;
  const dup = await db.collection("etimsInvoices").where("idempotencyKey","==",idempotencyKey).limit(1).get();
  if (!dup.empty) return { success:true, message:"Already generated", invoiceId: dup.docs[0].id };

  const ordersSnap = await db.collection("orders")
    .where("sellerUid","==",sellerUid)
    .where("status","in",["completed","delivered"])
    .where("completedAt",">=",periodStart)
    .where("completedAt","<=",periodEnd)
    .get();

  if (ordersSnap.empty) return { success:true, message:"No completed orders in period", count:0 };

  const orders   = ordersSnap.docs.map(d => d.data());
  const orderIds = ordersSnap.docs.map(d => d.id);

  const allItems = orders.flatMap(o => orderToLines(o));
  const invcNo   = await nextSeq(sellerUid);
  const invNo    = `${profile.invoicePrefix||"INV"}-BULK-${String(invcNo).padStart(5,"0")}`;
  const kraLines = allItems.map((it,i) => calcLine({...it,seq:i+1}, profile.vatStatus));
  const totals   = calcTotals(kraLines);
  const now      = new Date().toISOString();

  const jobRef = db.collection("etimsBulkJobs").doc();
  await jobRef.set({ jobId:jobRef.id, sellerUid, periodStart, periodEnd, billingPeriod, orderIds, orderCount:orders.length, totals, status:"generating", createdAt:now });

  const invRef = db.collection("etimsInvoices").doc();
  const invDoc = {
    invoiceId: invRef.id, idempotencyKey,
    sellerUid, orderId: null, bulkJobId: jobRef.id, orderIds,
    buyerUid: null, invoiceNumber: invNo, internalSequence: invcNo,
    isPlatformInvoice: false, periodStart, periodEnd, billingPeriod: billingPeriod||null,
    seller:  { kraPin:profile.kraPin, name:profile.businessName, branchId:profile.branchId||"00" },
    buyer:   { name:"Various Customers" },
    lineItems: kraLines, totals, currency:"KES",
    receiptNumber:null, controlUnitNumber:null, qrCode:null,
    verificationUrl:null, receiptSignature:null, kraResponse:null,
    invoiceType:"sale", status:"draft",
    retryCount:0, errorMessage:null, pdfUrl:null, emailSentAt:null,
    createdAt:now, updatedAt:now, submittedAt:null, acceptedAt:null,
  };
  await invRef.set(invDoc);

  try {
    const { client } = await sellerClient(sellerUid);
    const kraPayload  = buildKraPayload({ profile, invcNo, lineItems: allItems, buyer: null, remark: `Bulk ${billingPeriod||"period"} ${periodStart.slice(0,10)} to ${periodEnd.slice(0,10)}` });
    const kraResult   = await submitToKra(client, kraPayload);
    await invRef.update({ ...kraResult, updatedAt: new Date().toISOString() });
    await jobRef.update({ status:"completed", invoiceId: invRef.id });
    return { success:true, invoiceId:invRef.id, invoiceNumber:invNo, orderCount:orders.length, totals, status:"accepted" };
  } catch (err) {
    await invRef.update({ status:"pending_submission", errorMessage:err.message, updatedAt:new Date().toISOString() });
    await enqueue({ invoiceId:invRef.id, sellerUid, priority:2 });
    await jobRef.update({ status:"queued", error:err.message });
    return { success:true, invoiceId:invRef.id, invoiceNumber:invNo, status:"queued", orderCount:orders.length };
  }
});

/* 10 ─ SOKONI platform invoice (commissions, subscriptions, etc.) */
const etimsPlatformInvoice = onCall({ secrets: _ALL_SECRETS, enforceAppCheck: true }, async req => {
  if (!req.auth?.token?.isAdmin) throw new HttpsError("permission-denied","Admins only");
  const { sellerUid, feeType, amount, reference, description } = req.data;

  const FEE_LABELS = {
    commission:"Platform Commission Fee", subscription:"Subscription Fee",
    advertising:"Advertising Fee", delivery:"Delivery Service Fee",
    verification:"Verification Fee", premium:"Premium Service Fee",
  };
  if (!FEE_LABELS[feeType]) throw new HttpsError("invalid-argument","Invalid feeType");
  if (!amount || amount <= 0) throw new HttpsError("invalid-argument","Amount must be positive");

  const platPin    = ETIMS_PLATFORM_PIN.value();
  const platSecret = ETIMS_PLATFORM_SECRET.value();
  if (!platPin || !platSecret) throw new HttpsError("failed-precondition","Platform eTIMS credentials not set. Set ETIMS_PLATFORM_PIN and ETIMS_PLATFORM_SECRET secrets.");

  const idempotencyKey = `platform-${feeType}-${reference||Date.now()}`;
  const dup = await db.collection("etimsInvoices").where("idempotencyKey","==",idempotencyKey).limit(1).get();
  if (!dup.empty) return { invoiceId:dup.docs[0].id, duplicate:true };

  const invcNo = await nextSeq("_platform_sokoni");
  const invNo  = `SOKONI-${String(invcNo).padStart(6,"0")}`;
  const now    = new Date().toISOString();

  const platProfile = { kraPin:platPin, businessName:"SOKONI Ltd", branchId:"00", vatStatus:"registered", address:"Nairobi, Kenya", invoicePrefix:"SOKONI" };
  const lineItems   = [{ name: FEE_LABELS[feeType]+(description?`: ${description}`:""), quantity:1, unitPrice:amount, discountRate:0 }];
  const kraLines    = lineItems.map((it,i) => calcLine({...it,seq:i+1},"registered"));
  const totals      = calcTotals(kraLines);

  let buyer = null;
  if (sellerUid) {
    const ss = await db.collection("shops").doc(sellerUid).get();
    if (ss.exists) {
      const sd = ss.data();
      const ep = await db.collection("etimsProfiles").doc(sellerUid).get();
      buyer = { name:sd.shopName||sd.name, email:sd.email, phone:sd.phone, kraPin: ep.exists?ep.data().kraPin:null };
    }
  }

  const invRef = db.collection("etimsInvoices").doc();
  const invDoc = {
    invoiceId:invRef.id, idempotencyKey,
    sellerUid:"_platform", orderId:reference||null, bulkJobId:null, orderIds:null,
    buyerUid:null, billToSellerUid:sellerUid||null,
    invoiceNumber:invNo, internalSequence:invcNo,
    isPlatformInvoice:true, platformFeeType:feeType,
    seller:{kraPin:platPin,name:"SOKONI Ltd",branchId:"00"},
    buyer: buyer||{name:"Platform Client"},
    lineItems:kraLines, totals, currency:"KES",
    receiptNumber:null,controlUnitNumber:null,qrCode:null,
    verificationUrl:null,receiptSignature:null,kraResponse:null,
    invoiceType:"sale",status:"draft",
    retryCount:0,errorMessage:null,pdfUrl:null,emailSentAt:null,
    createdAt:now,updatedAt:now,submittedAt:null,acceptedAt:null,
  };
  await invRef.set(invDoc);

  try {
    const platClient = new EtimsClient({ tin:platPin, bhfId:"00", deviceSerial:"SOKONI-VSCU-001", taxpayerSecret:platSecret });
    const kraPayload = buildKraPayload({ profile:platProfile, invcNo, lineItems, buyer, remark:`${feeType} — ${reference||""}` });
    const kraResult  = await submitToKra(platClient, kraPayload);
    await invRef.update({ ...kraResult, updatedAt:new Date().toISOString() });
    if (buyer?.email) emailBuyer({ invoice:{...invDoc,...kraResult,invoiceId:invRef.id}, profile:platProfile, buyer });
    return { success:true, invoiceId:invRef.id, invoiceNumber:invNo, status:"accepted" };
  } catch (err) {
    await invRef.update({ status:"pending_submission", errorMessage:err.message });
    await enqueue({ invoiceId:invRef.id, sellerUid:"_platform", priority:2 });
    return { success:true, invoiceId:invRef.id, invoiceNumber:invNo, status:"queued" };
  }
});

/* 11 ─ Get buyer receipts */
const etimsGetBuyerReceipts = onCall({ enforceAppCheck: true }, async req => {
  if (!req.auth) throw new HttpsError("unauthenticated","Sign in required");
  const uid = req.auth.uid;
  const lim = Math.min(req.data?.limit||20, 50);

  /* Fetch buyer's recent orders → get invoices for those orders */
  const ordersSnap = await db.collection("orders")
    .where("buyerUid","==",uid)
    .orderBy("createdAt","desc").limit(100).get();

  const orderIds = ordersSnap.docs.map(d => d.id);
  if (!orderIds.length) return { invoices:[], total:0 };

  /* Query in batches of 30 (Firestore 'in' limit) */
  const batches = [];
  for (let i = 0; i < Math.min(orderIds.length, 90); i += 30) {
    batches.push(
      db.collection("etimsInvoices")
        .where("orderId","in",orderIds.slice(i, i+30))
        .orderBy("createdAt","desc").get()
    );
  }
  const snaps   = await Promise.all(batches);
  const invs    = snaps.flatMap(s => s.docs.map(d => d.data()))
    .sort((a,b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, lim);

  return {
    invoices: invs.map(inv => ({
      invoiceId:      inv.invoiceId,
      invoiceNumber:  inv.invoiceNumber,
      orderId:        inv.orderId,
      status:         inv.status,
      totalAmount:    inv.totals?.totAmt,
      vatAmount:      inv.totals?.taxAmtA,
      receiptNumber:  inv.receiptNumber,
      controlUnitNumber: inv.controlUnitNumber,
      qrCode:         inv.qrCode,
      verificationUrl:inv.verificationUrl,
      pdfUrl:         inv.pdfUrl,
      createdAt:      inv.createdAt,
      seller:         { name: inv.seller?.name },
    })),
    total: invs.length,
  };
});

/* 12 ─ Download receipt HTML (authenticated onRequest) */
const etimsDownloadReceipt = onRequest({ secrets: _ALL_SECRETS }, async (req, res) => {
  const invoiceId = req.query.id || "";
  if (!invoiceId) return res.status(400).send("Missing ?id=");

  const auth = req.headers.authorization || "";
  if (!auth.startsWith("Bearer ")) return res.status(401).send("Unauthorized");

  try {
    const decoded   = await admin.auth().verifyIdToken(auth.slice(7));
    const invSnap   = await db.collection("etimsInvoices").doc(invoiceId).get();
    if (!invSnap.exists) return res.status(404).send("Invoice not found");

    const inv = invSnap.data();
    const uid = decoded.uid;

    /* Auth: seller | buyer (via order) | admin */
    const isSeller = inv.sellerUid === uid;
    const isAdmin  = decoded.isAdmin === true;
    let isBuyer    = inv.buyerUid === uid;
    if (!isBuyer && inv.orderId) {
      const os = await db.collection("orders").doc(inv.orderId).get();
      isBuyer  = os.exists && os.data().buyerUid === uid;
    }
    if (!isSeller && !isBuyer && !isAdmin) return res.status(403).send("Forbidden");

    const profSnap = await db.collection("etimsProfiles").doc(inv.sellerUid).get();
    const profile  = profSnap.exists ? profSnap.data()
      : { businessName:"SOKONI Ltd", kraPin:"", branchId:"00", vatStatus:"registered", address:"Nairobi, Kenya" };

    const html = buildReceiptHtml({ invoice: inv, profile, buyer: inv.buyer });
    res.setHeader("Content-Type","text/html; charset=utf-8");
    res.setHeader("Content-Disposition",`inline; filename="invoice-${inv.invoiceNumber}.html"`);
    res.setHeader("X-Frame-Options","SAMEORIGIN");
    res.send(html);
  } catch (e) {
    res.status(401).send("Invalid token: " + e.message);
  }
});

/* 13 ─ Seller eTIMS stats */
const etimsGetSellerStats = onCall({ enforceAppCheck: true }, async req => {
  if (!req.auth) throw new HttpsError("unauthenticated","Sign in required");
  const uid = req.auth.uid;

  const [profSnap, accSnap, failSnap, pendSnap] = await Promise.all([
    db.collection("etimsProfiles").doc(uid).get(),
    db.collection("etimsInvoices").where("sellerUid","==",uid).where("status","==","accepted").orderBy("createdAt","desc").limit(30).get(),
    db.collection("etimsInvoices").where("sellerUid","==",uid).where("status","==","failed").orderBy("createdAt","desc").limit(20).get(),
    db.collection("etimsInvoices").where("sellerUid","==",uid).where("status","==","pending_submission").limit(20).get(),
  ]);

  if (!profSnap.exists) return { profile:null, stats:null };
  const profile = profSnap.data();
  const accepted = accSnap.docs.map(d => d.data());
  const failed   = failSnap.docs.map(d => d.data());
  const pending  = pendSnap.docs.map(d => d.data());

  return {
    profile: { ...profile },
    stats: {
      totalRevenue:    _r2(accepted.reduce((s,i)=>s+(i.totals?.totAmt||0),0)),
      vatCollected:    _r2(accepted.reduce((s,i)=>s+(i.totals?.taxAmtA||0),0)),
      acceptedCount:   accepted.length,
      failedCount:     failed.length,
      pendingCount:    pending.length,
    },
    recentInvoices: accepted.slice(0,15).map(i=>({
      invoiceId:i.invoiceId, invoiceNumber:i.invoiceNumber, orderId:i.orderId,
      total:i.totals?.totAmt, vat:i.totals?.taxAmtA, status:i.status,
      receiptNumber:i.receiptNumber, pdfUrl:i.pdfUrl, createdAt:i.createdAt,
    })),
    failedInvoices: failed.slice(0,10).map(i=>({
      invoiceId:i.invoiceId, invoiceNumber:i.invoiceNumber,
      error:i.errorMessage, orderId:i.orderId, createdAt:i.createdAt,
    })),
  };
});

/* 14 ─ Admin eTIMS stats */
const etimsGetAdminStats = onCall({ enforceAppCheck: true }, async req => {
  if (!req.auth?.token?.isAdmin) throw new HttpsError("permission-denied","Admins only");

  const [acceptedSnap, failedSnap, queueSnap, profilesSnap, platSnap] = await Promise.all([
    db.collection("etimsInvoices").where("status","==","accepted").limit(1000).get(),
    db.collection("etimsInvoices").where("status","==","failed").orderBy("createdAt","desc").limit(100).get(),
    db.collection("etimsQueue").where("status","==","pending").limit(100).get(),
    db.collection("etimsProfiles").where("status","==","active").limit(1000).get(),
    db.collection("etimsInvoices").where("isPlatformInvoice","==",true).where("status","==","accepted").limit(500).get(),
  ]);

  const totalVat     = _r2(acceptedSnap.docs.reduce((s,d)=>s+(d.data().totals?.taxAmtA||0),0));
  const totalRev     = _r2(acceptedSnap.docs.reduce((s,d)=>s+(d.data().totals?.totAmt||0),0));
  const platRev      = _r2(platSnap.docs.reduce((s,d)=>s+(d.data().totals?.totAmt||0),0));

  return {
    overview: {
      totalInvoices:   acceptedSnap.size,
      failedInvoices:  failedSnap.size,
      queueSize:       queueSnap.size,
      activeSellers:   profilesSnap.size,
      totalRevenue:    totalRev,
      totalVat,
      platformRevenue: platRev,
    },
    recentFailures: failedSnap.docs.slice(0,20).map(d=>({
      invoiceId:  d.data().invoiceId,
      sellerUid:  d.data().sellerUid,
      invoiceNumber: d.data().invoiceNumber,
      error:      d.data().errorMessage,
      createdAt:  d.data().createdAt,
    })),
    queueItems: queueSnap.docs.slice(0,20).map(d=>({
      queueId:    d.data().queueId,
      invoiceId:  d.data().invoiceId,
      sellerUid:  d.data().sellerUid,
      retryCount: d.data().retryCount,
      nextRetryAt:d.data().nextRetryAt,
    })),
    activeSellers: profilesSnap.docs.slice(0,50).map(d=>({
      sellerUid:    d.data().sellerUid,
      businessName: d.data().businessName,
      kraPin:       d.data().kraPin,
      totalInvoices:d.data().totalInvoices,
      failedInvoices:d.data().failedInvoices,
      lastSubmission:d.data().lastSubmissionAt,
    })),
  };
});

/* 15 ─ Daily reconciliation: re-queue stuck invoices */
const etimsReconcileDaily = onSchedule(
  { schedule:"0 3 * * *", timeZone:"Africa/Nairobi", timeoutSeconds:540, secrets: _ALL_SECRETS },
  async () => {
    const cutoff = new Date(Date.now() - 30 * 60_000).toISOString();
    const stuckSnap = await db.collection("etimsInvoices")
      .where("status","==","pending_submission")
      .where("updatedAt","<=",cutoff).limit(200).get();

    let requeued = 0;
    for (const doc of stuckSnap.docs) {
      const inv  = doc.data();
      const qSnap = await db.collection("etimsQueue")
        .where("invoiceId","==",inv.invoiceId).where("status","==","pending").limit(1).get();
      if (qSnap.empty) { await enqueue({ invoiceId:inv.invoiceId, sellerUid:inv.sellerUid, priority:3 }); requeued++; }
    }

    await db.collection("etimsReconciliations").add({
      date: new Date().toISOString().slice(0,10),
      stuckFound: stuckSnap.size, requeued,
      runAt: new Date().toISOString(),
    });

    console.log(`[eTIMS reconcile] stuck=${stuckSnap.size} requeued=${requeued}`);
  }
);

/* ══════════════════════════════════════════════════════════════════════
   EXPORTS
══════════════════════════════════════════════════════════════════════ */
module.exports = {
  etimsRegisterSeller,
  etimsGetProfile,
  etimsUpdateProfile,
  etimsValidatePin,
  etimsGenerateInvoice,
  etimsOnOrderCompleted,
  etimsResubmitInvoice,
  etimsProcessQueue,
  etimsBulkGenerate,
  etimsPlatformInvoice,
  etimsGetBuyerReceipts,
  etimsDownloadReceipt,
  etimsGetSellerStats,
  etimsGetAdminStats,
  etimsReconcileDaily,
};
