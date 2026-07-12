#!/usr/bin/env node
/**
 * SOKONI — Email Template Test Sender
 * Renders a template via email-templates.js and delivers it via SendGrid.
 * Reads SENDGRID_API_KEY from GCP Secret Manager (requires gcloud auth).
 *
 * Usage:
 *   node scripts/send-test-email.js [template] [recipient]
 *   node scripts/send-test-email.js welcome ogutualex824@gmail.com
 */
"use strict";

const { execSync } = require("child_process");
const https        = require("https");

/* ── Args ─────────────────────────────────────────────────── */
const TEMPLATE  = process.argv[2] || "welcome";
const RECIPIENT = process.argv[3] || "ogutualex824@gmail.com";
const PROJECT   = "sokoni-aeb26";

/* ── Fetch secret (Firebase CLI, falls back to env var) ─── */
function getSecret(name) {
  if (process.env[name]) return process.env[name].trim();
  try {
    return execSync(
      `firebase functions:secrets:access ${name}`,
      { encoding: "utf8", stdio: ["pipe","pipe","pipe"] }
    ).trim();
  } catch (e) {
    console.error(`[secrets] Could not fetch ${name}:`, e.stderr || e.message);
    process.exit(1);
  }
}

/* ── Minimal email-templates shim (no firebase-admin needed) ─ */
/* We need to satisfy the require() calls in email-templates.js  */
const path = require("path");

/* Stub company-identity.js */
const companyStub = {
  COMPANY: {
    legalName:    "Bravilex International Co. Limited",
    operatedBy:   "Operated by Bravilex International Co. Limited",
    supportEmail: "support@mysokoni.co.ke",
    postalAddress:"P.O. Box 114–50411",
    town:         "Nairobi",
    country:      "Kenya",
  }
};

/* Stub email-service.js — just the FROM addresses */
const FROM = {
  default:  '"SOKONI" <noreply@mysokoni.co.ke>',
  orders:   '"SOKONI Orders" <orders@mysokoni.co.ke>',
  payments: '"SOKONI Payments" <payments@mysokoni.co.ke>',
  billing:  '"SOKONI Billing" <billing@mysokoni.co.ke>',
  vendors:  '"SOKONI Vendors" <vendors@mysokoni.co.ke>',
  seller:   '"SOKONI Sellers" <seller@mysokoni.co.ke>',
  security: '"SOKONI Security" <security@mysokoni.co.ke>',
  delivery: '"SOKONI Delivery" <delivery@mysokoni.co.ke>',
  tracking: '"SOKONI Tracking" <tracking@mysokoni.co.ke>',
  dispatch: '"SOKONI Dispatch" <dispatch@mysokoni.co.ke>',
  drivers:  '"SOKONI Drivers" <drivers@mysokoni.co.ke>',
  tickets:  '"SOKONI Tickets" <tickets@mysokoni.co.ke>',
  events:   '"SOKONI Events" <events@mysokoni.co.ke>',
  property: '"SOKONI Property" <property@mysokoni.co.ke>',
  health:   '"SOKONI Health" <health@mysokoni.co.ke>',
  law:      '"SOKONI Legal" <law@mysokoni.co.ke>',
  marketing:'"SOKONI" <marketing@mysokoni.co.ke>',
  disputes: '"SOKONI Disputes" <disputes@mysokoni.co.ke>',
  tech:     '"SOKONI Tech" <tech@mysokoni.co.ke>',
  admin:    '"SOKONI Admin" <admin@mysokoni.co.ke>',
};
const emailServiceStub = { FROM, EMAIL_SECRETS: [] };

/* Inject stubs into the module cache before loading email-templates.js */
require.cache[require.resolve(path.join(__dirname, "../functions/company-identity.js"))] = {
  id: require.resolve(path.join(__dirname, "../functions/company-identity.js")),
  filename: require.resolve(path.join(__dirname, "../functions/company-identity.js")),
  loaded: true,
  exports: companyStub,
};
require.cache[require.resolve(path.join(__dirname, "../functions/email-service.js"))] = {
  id: require.resolve(path.join(__dirname, "../functions/email-service.js")),
  filename: require.resolve(path.join(__dirname, "../functions/email-service.js")),
  loaded: true,
  exports: emailServiceStub,
};

const { getTemplate } = require(path.join(__dirname, "../functions/email-templates.js"));

/* ── Sample data per template ────────────────────────────── */
const SAMPLE_DATA = {
  "welcome":            { name: "Alex" },
  "email-verify":       { name: "Alex", code: "847291", verifyUrl: "https://mysokoni.co.ke/profile.html" },
  "order-confirmation": { name: "Alex", orderId: "ORD-20260712-001", items: "2 × Nike Air Max, 1 × Kenya Flag", total: 8500, paymentMethod: "M-Pesa", deliveryAddress: "Westlands, Nairobi", estimatedDelivery: "Tomorrow, 12:00–16:00" },
  "payment-success":    { name: "Alex", amount: 8500, ref: "MPE20260712ABC", method: "M-Pesa", date: "2026-07-12 14:30" },
  "order-shipped":      { name: "Alex", orderId: "ORD-20260712-001", driverName: "James Mwangi", eta: "Today 15:30", trackingCode: "SK-TRACK-2026-001" },
  "order-delivered":    { name: "Alex", orderId: "ORD-20260712-001", deliveredAt: "Today at 15:28", driverName: "James Mwangi" },
  "seller-approved":    { name: "Alex", storeName: "Alex Tech Hub", accountType: "Seller", commission: "5%" },
  "driver-approved":    { name: "James", driverId: "DRV-0042", vehicle: "Bajaj Boxer", zone: "Nairobi CBD" },
  "ticket-purchase":    { name: "Alex", eventName: "Nairobi Jazz Festival 2026", eventDate: "Sat 25 Jul 2026, 18:00", venue: "KICC Grounds, Nairobi", ticketType: "VIP", ticketId: "TKT-20260712-VIP-001", amount: 2500 },
  "payment-failed":     { name: "Alex", amount: 8500, reason: "Insufficient M-Pesa balance" },
  "dispute-opened":     { name: "Alex", orderId: "ORD-20260712-001", disputeId: "DSP-001", reason: "Item not as described" },
  "security-alert":     { alertType: "Multiple Failed Login Attempts", time: "2026-07-12 14:45", details: "5 failed attempts from a new device", ip: "102.0.2.1", uid: "ogutualex824@gmail.com" },
};

/* ── Render ──────────────────────────────────────────────── */
let tmpl;
try {
  const data = SAMPLE_DATA[TEMPLATE] || { name: "Alex" };
  tmpl = getTemplate(TEMPLATE, data);
  console.log(`[render] Template "${TEMPLATE}" rendered — ${tmpl.html.length.toLocaleString()} bytes HTML`);
} catch (e) {
  console.error(`[render] Failed to render "${TEMPLATE}":`, e.message);
  process.exit(1);
}

/* ── Send via SendGrid API ───────────────────────────────── */
console.log(`[secrets] Fetching SENDGRID_API_KEY from Secret Manager…`);
const apiKey = getSecret("SENDGRID_API_KEY");
console.log(`[secrets] Key loaded (${apiKey.length} chars)`);

const payload = JSON.stringify({
  personalizations: [{ to: [{ email: RECIPIENT }] }],
  from:             { email: "hello@mysokoni.co.ke", name: "SOKONI" },
  reply_to:         { email: "support@mysokoni.co.ke", name: "SOKONI Support" },
  subject:          `[TEST] ${tmpl.subject}`,
  content: [
    { type: "text/plain", value: tmpl.text },
    { type: "text/html",  value: tmpl.html  },
  ],
});

const options = {
  hostname: "api.sendgrid.com",
  path:     "/v3/mail/send",
  method:   "POST",
  headers: {
    "Authorization": `Bearer ${apiKey}`,
    "Content-Type":  "application/json",
    "Content-Length": Buffer.byteLength(payload),
  },
};

console.log(`[send] Sending "${tmpl.subject}" → ${RECIPIENT}…`);

const req = https.request(options, res => {
  const status = res.statusCode;
  let body = "";
  res.on("data", c => body += c);
  res.on("end", () => {
    if (status === 202) {
      const msgId = res.headers["x-message-id"] || "(no message-id)";
      console.log(`[send] ✓ Delivered — HTTP 202  Message-ID: ${msgId}`);
      console.log(`[send] Template: ${TEMPLATE}  Recipient: ${RECIPIENT}`);
    } else {
      console.error(`[send] ✗ HTTP ${status}:`, body);
      process.exit(1);
    }
  });
});

req.on("error", e => { console.error("[send] Request error:", e.message); process.exit(1); });
req.write(payload);
req.end();
