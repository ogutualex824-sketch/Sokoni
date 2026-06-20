/* ============================================================
   SOKONI Enterprise Email Service  v1.0
   Primary transport:  SendGrid (SENDGRID_API_KEY)
   Fallback transport: SMTP / nodemailer (MAIL_HOST + MAIL_USER + MAIL_PASS)
   Features: Queue · Retry · Deduplication · Per-user preferences · Full logging
   All 40 @mysokoni.co.ke accounts available as senders.
============================================================ */
"use strict";

const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");

/* ── Secrets ──────────────────────────────────────────────── */
const SENDGRID_KEY = defineSecret("SENDGRID_API_KEY");
const MAIL_HOST    = defineSecret("MAIL_HOST");
const MAIL_USER    = defineSecret("MAIL_USER");
const MAIL_PASS    = defineSecret("MAIL_PASS");

/* Export so trigger functions can declare them */
const EMAIL_SECRETS = [SENDGRID_KEY, MAIL_HOST, MAIL_USER, MAIL_PASS];
module.exports.EMAIL_SECRETS = EMAIL_SECRETS;

/* ── Sender identities ───────────────────────────────────── */
const FROM = {
  default:      '"SOKONI" <noreply@mysokoni.co.ke>',
  orders:       '"SOKONI Orders" <orders@mysokoni.co.ke>',
  payments:     '"SOKONI Payments" <payments@mysokoni.co.ke>',
  billing:      '"SOKONI Billing" <billing@mysokoni.co.ke>',
  accounts:     '"SOKONI Accounts" <accounts@mysokoni.co.ke>',
  support:      '"SOKONI Support" <support@mysokoni.co.ke>',
  events:       '"SOKONI Events" <events@mysokoni.co.ke>',
  tickets:      '"SOKONI Tickets" <tickets@mysokoni.co.ke>',
  property:     '"SOKONI Property" <property@mysokoni.co.ke>',
  bnb:          '"SOKONI BnB" <bnb@mysokoni.co.ke>',
  motors:       '"SOKONI Motors" <motors@mysokoni.co.ke>',
  vendors:      '"SOKONI Vendors" <vendors@mysokoni.co.ke>',
  seller:       '"SOKONI Sellers" <seller@mysokoni.co.ke>',
  merchant:     '"SOKONI Merchant" <merchant@mysokoni.co.ke>',
  returns:      '"SOKONI Returns" <returns@mysokoni.co.ke>',
  disputes:     '"SOKONI Disputes" <disputes@mysokoni.co.ke>',
  logistics:    '"SOKONI Logistics" <logistics@mysokoni.co.ke>',
  delivery:     '"SOKONI Delivery" <delivery@mysokoni.co.ke>',
  dispatch:     '"SOKONI Dispatch" <dispatch@mysokoni.co.ke>',
  drivers:      '"SOKONI Drivers" <drivers@mysokoni.co.ke>',
  tracking:     '"SOKONI Tracking" <tracking@mysokoni.co.ke>',
  jobs:         '"SOKONI Jobs" <jobs@mysokoni.co.ke>',
  health:       '"SOKONI Health" <health@mysokoni.co.ke>',
  law:          '"SOKONI Legal" <law@mysokoni.co.ke>',
  travel:       '"SOKONI Travel" <travel@mysokoni.co.ke>',
  marketing:    '"SOKONI" <marketing@mysokoni.co.ke>',
  media:        '"SOKONI Media" <media@mysokoni.co.ke>',
  press:        '"SOKONI PR" <press@mysokoni.co.ke>',
  partnerships: '"SOKONI Partnerships" <partnerships@mysokoni.co.ke>',
  advertising:  '"SOKONI Ads" <advertising@mysokoni.co.ke>',
  careers:      '"SOKONI Careers" <careers@mysokoni.co.ke>',
  tech:         '"SOKONI Tech" <tech@mysokoni.co.ke>',
  developers:   '"SOKONI Dev" <developers@mysokoni.co.ke>',
  security:     '"SOKONI Security" <security@mysokoni.co.ke>',
  abuse:        '"SOKONI Abuse" <abuse@mysokoni.co.ke>',
  api:          '"SOKONI API" <api@mysokoni.co.ke>',
  devops:       '"SOKONI DevOps" <devops@mysokoni.co.ke>',
  legal:        '"SOKONI Legal" <legal@mysokoni.co.ke>',
  info:         '"SOKONI" <info@mysokoni.co.ke>',
  admin:        '"SOKONI Admin" <admin@mysokoni.co.ke>',
};
module.exports.FROM = FROM;

/* ── Email category → preferences key mapping ─────────────── */
const PREF_MAP = {
  order:        "orders",
  payment:      "payments",
  security:     "security",
  marketing:    "marketing",
  newsletter:   "marketing",
  delivery:     "orders",
  dispatch:     "orders",
  tracking:     "orders",
  account:      "account",
  support:      "account",
  system:       "account",
};

/* ── Dedup window: 5 minutes ──────────────────────────────── */
const DEDUP_TTL_MS = 5 * 60 * 1000;

/* ── DB references (lazy) ─────────────────────────────────── */
let _db;
function db() {
  if (!_db) _db = admin.firestore();
  return _db;
}

/* ── Standard DMARC-aligned headers ───────────────────────── */
/*
 * DMARC alignment requirements (adkim=s, aspf=s):
 * - DKIM: d= tag must exactly match mysokoni.co.ke → handled by SendGrid domain auth
 * - SPF:  MAIL FROM must exactly match mysokoni.co.ke → Return-Path set to em.mysokoni.co.ke
 *         (subdomain fails strict SPF alignment, but DKIM alignment passes → DMARC passes)
 * Headers below ensure proper inbox placement and unsubscribe compliance.
 */
function _buildHeaders(payload) {
  const emailId = payload.emailId || `sokoni-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const domain  = "mysokoni.co.ke";
  return {
    "Message-ID":        `<${emailId}@${domain}>`,
    "X-Entity-Ref-ID":   emailId,
    /* List-Unsubscribe headers (RFC 2369) — required by Gmail/Yahoo bulk senders */
    "List-Unsubscribe":  `<mailto:unsubscribe@${domain}?subject=unsubscribe-${emailId}>`,
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    /* Feedback loop / abuse handling */
    "Feedback-ID":       `${payload.category || "system"}:${emailId}:SOKONI`,
    /* Precedence: bulk prevents auto-replies (OOO) from returning */
    "Precedence":        "bulk",
    /* X-Mailer for diagnostic tracing */
    "X-Mailer":          "SOKONI-EmailService/2.9",
  };
}

/* ── Send via SendGrid ─────────────────────────────────────── */
async function _sendViaSendGrid(payload) {
  const sgKey = SENDGRID_KEY.value();
  if (!sgKey) throw new Error("SENDGRID_API_KEY not set");
  const sgMail = require("@sendgrid/mail");
  sgMail.setApiKey(sgKey);
  const msg = {
    to:          payload.to,
    from:        payload.from || FROM.default,
    replyTo:     payload.replyTo,
    subject:     payload.subject,
    html:        payload.html,
    text:        payload.text || "",
    headers:     _buildHeaders(payload),
    trackingSettings: {
      clickTracking:  { enable: true, enableText: false },
      openTracking:   { enable: true },
    },
    categories:  payload.category ? [payload.category] : [],
    customArgs:  { emailId: payload.emailId || "", uid: payload.uid || "" },
  };
  const [response] = await sgMail.send(msg);
  return { provider: "sendgrid", statusCode: response.statusCode, messageId: response.headers["x-message-id"] || "" };
}

/* ── Send via SMTP (nodemailer) ────────────────────────────── */
async function _sendViaSmtp(payload) {
  const host = MAIL_HOST.value();
  const user = MAIL_USER.value();
  const pass = MAIL_PASS.value();
  if (!host || !user || !pass) throw new Error("MAIL_HOST / MAIL_USER / MAIL_PASS not set");
  const nodemailer = require("nodemailer");
  const transporter = nodemailer.createTransport({
    host, port: 587, secure: false,
    auth: { user, pass },
    pool: true, maxConnections: 5,
    tls: { rejectUnauthorized: true },
  });
  const customHeaders = _buildHeaders(payload);
  const info = await transporter.sendMail({
    from:    payload.from || FROM.default,
    to:      payload.to,
    replyTo: payload.replyTo,
    subject: payload.subject,
    html:    payload.html,
    text:    payload.text || "",
    headers: customHeaders,
  });
  return { provider: "smtp", statusCode: 250, messageId: info.messageId };
}

/* ── Deduplication check ───────────────────────────────────── */
async function _isDuplicate(emailId) {
  if (!emailId) return false;
  const ref = db().collection("emailLogs").where("emailId", "==", emailId).limit(1);
  const snap = await ref.get();
  if (snap.empty) return false;
  const doc = snap.docs[0].data();
  const age = Date.now() - (doc.sentAt?.toMillis?.() || 0);
  return age < DEDUP_TTL_MS;
}

/* ── Check user email preferences ─────────────────────────── */
async function _checkPreferences(uid, category) {
  if (!uid || !category) return true;
  try {
    const prefKey = PREF_MAP[category] || "account";
    const snap = await db().collection("emailPreferences").doc(uid).get();
    if (!snap.exists) return true;
    const prefs = snap.data();
    return prefs[prefKey] !== false;
  } catch (e) {
    return true;
  }
}

/* ── Log email result to Firestore ────────────────────────── */
async function _log(payload, result, error) {
  const record = {
    emailId:   payload.emailId || "",
    to:        payload.to,
    from:      payload.from || FROM.default,
    subject:   payload.subject,
    category:  payload.category || "system",
    uid:       payload.uid || "",
    template:  payload.template || "",
    status:    error ? "failed" : "sent",
    provider:  result?.provider || "unknown",
    messageId: result?.messageId || "",
    error:     error ? error.message : null,
    retries:   payload.retryCount || 0,
    sentAt:    admin.firestore.FieldValue.serverTimestamp(),
    openedAt:  null,
    clickedAt: null,
    bouncedAt: null,
  };
  await db().collection("emailLogs").add(record).catch(() => {});
}

/* ═══════════════════════════════════════════════════════════
   PUBLIC API
═══════════════════════════════════════════════════════════ */

/**
 * Send an email immediately.
 * payload: { to, from?, subject, html, text?, template?, category?, uid?, emailId?, replyTo? }
 */
async function send(payload) {
  if (!payload.to || !payload.subject || !payload.html) {
    throw new Error("EmailService.send: to, subject, and html are required");
  }

  /* Deduplication */
  if (payload.emailId && await _isDuplicate(payload.emailId)) {
    console.log(`[Email] Skipping duplicate: ${payload.emailId}`);
    return { skipped: true, reason: "duplicate" };
  }

  /* Preference check */
  if (payload.uid && payload.category) {
    const allowed = await _checkPreferences(payload.uid, payload.category);
    if (!allowed) {
      console.log(`[Email] User ${payload.uid} opted out of ${payload.category}`);
      return { skipped: true, reason: "opted_out" };
    }
  }

  let result = null;
  let error  = null;

  /* Try SendGrid first, SMTP as fallback */
  try {
    result = await _sendViaSendGrid(payload);
  } catch (e1) {
    console.warn("[Email] SendGrid failed:", e1.message, "— trying SMTP");
    try {
      result = await _sendViaSmtp(payload);
    } catch (e2) {
      error = e2;
      console.error("[Email] Both transports failed:", e2.message);
    }
  }

  await _log(payload, result, error);
  if (error) throw error;
  return result;
}

/**
 * Add email to the Firestore queue (processed every 2 min by processEmailQueue CF).
 * Use this for non-urgent emails or when calling from a Firestore trigger.
 */
async function queue(payload) {
  if (!payload.to || !payload.subject || !payload.html) {
    throw new Error("EmailService.queue: to, subject, and html are required");
  }
  const doc = {
    ...payload,
    status:      "pending",
    retryCount:  0,
    maxRetries:  3,
    nextAttempt: admin.firestore.FieldValue.serverTimestamp(),
    queuedAt:    admin.firestore.FieldValue.serverTimestamp(),
  };
  const ref = await db().collection("emailQueue").add(doc);
  return ref.id;
}

/**
 * Send or queue an email — the recommended entry point.
 * sendNow=true → immediate (use in onCall functions)
 * sendNow=false → queue (use in Firestore triggers to avoid long writes)
 */
async function sendOrQueue(payload, sendNow = false) {
  return sendNow ? send(payload) : queue(payload);
}

/**
 * Process the email queue. Called by the scheduled Cloud Function every 2 minutes.
 */
async function processQueue() {
  const now = admin.firestore.Timestamp.now();
  const snap = await db().collection("emailQueue")
    .where("status",      "==",  "pending")
    .where("nextAttempt", "<=",  now)
    .orderBy("nextAttempt", "asc")
    .limit(50)
    .get().catch(() => null);

  if (!snap || snap.empty) return 0;

  let sent = 0;
  const batch = db().batch();

  for (const docRef of snap.docs) {
    const item = docRef.data();
    /* Mark as processing to prevent duplicate sends */
    batch.update(docRef.ref, { status: "processing" });
  }
  await batch.commit().catch(() => {});

  for (const docRef of snap.docs) {
    const item = docRef.data();
    try {
      const result = await send({ ...item, retryCount: item.retryCount || 0 });
      await docRef.ref.update({
        status:    result.skipped ? "skipped" : "sent",
        sentAt:    admin.firestore.FieldValue.serverTimestamp(),
        messageId: result.messageId || "",
      }).catch(() => {});
      sent++;
    } catch (e) {
      const retryCount = (item.retryCount || 0) + 1;
      const failed = retryCount >= (item.maxRetries || 3);
      await docRef.ref.update({
        status:      failed ? "failed" : "pending",
        retryCount,
        lastError:   e.message,
        nextAttempt: admin.firestore.Timestamp.fromMillis(Date.now() + retryCount * 60_000),
      }).catch(() => {});
    }
  }

  return sent;
}

/**
 * Mark an email as opened (called from SendGrid event webhook).
 */
async function markOpened(messageId) {
  if (!messageId) return;
  const snap = await db().collection("emailLogs")
    .where("messageId", "==", messageId).limit(1).get().catch(() => null);
  if (snap && !snap.empty) {
    await snap.docs[0].ref.update({ openedAt: admin.firestore.FieldValue.serverTimestamp() }).catch(() => {});
  }
}

/**
 * Mark an email as clicked.
 */
async function markClicked(messageId) {
  if (!messageId) return;
  const snap = await db().collection("emailLogs")
    .where("messageId", "==", messageId).limit(1).get().catch(() => null);
  if (snap && !snap.empty) {
    await snap.docs[0].ref.update({ clickedAt: admin.firestore.FieldValue.serverTimestamp() }).catch(() => {});
  }
}

/**
 * Mark an email as bounced + unsubscribe.
 */
async function markBounced(email, messageId) {
  if (messageId) {
    const snap = await db().collection("emailLogs")
      .where("messageId", "==", messageId).limit(1).get().catch(() => null);
    if (snap && !snap.empty) {
      await snap.docs[0].ref.update({ bouncedAt: admin.firestore.FieldValue.serverTimestamp(), status: "bounced" }).catch(() => {});
    }
  }
  /* Block future sends to this address */
  if (email) {
    await db().collection("emailBounces").doc(email.toLowerCase()).set({
      email, bouncedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true }).catch(() => {});
  }
}

/**
 * Get user email preferences (or defaults).
 */
async function getPreferences(uid) {
  const defaults = { orders: true, payments: true, security: true, marketing: true, account: true, newsletter: false };
  if (!uid) return defaults;
  const snap = await db().collection("emailPreferences").doc(uid).get().catch(() => null);
  return snap && snap.exists ? { ...defaults, ...snap.data() } : defaults;
}

/**
 * Update user email preferences.
 */
async function updatePreferences(uid, prefs) {
  if (!uid || !prefs) return;
  await db().collection("emailPreferences").doc(uid).set({
    ...prefs,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });
}

module.exports = {
  send,
  queue,
  sendOrQueue,
  processQueue,
  markOpened,
  markClicked,
  markBounced,
  getPreferences,
  updatePreferences,
  EMAIL_SECRETS,
  FROM,
};
