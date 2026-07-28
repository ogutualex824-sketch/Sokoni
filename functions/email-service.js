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

/* ── Canonical sender registry ─────────────────────────────
   Every address here is send-only and replies are routed to REPLY_TO
   below, so a sender does NOT need its own Workspace mailbox — the
   authenticated domain signs all of them. Only the reply destination
   has to be a real, monitored place.

   Three identities carry a role; the rest are routing labels:

     verify@   authentication only (Firebase Custom SMTP sender)
     support@  the single monitored destination — universal Reply-To
     accounts@ finance / billing / settlement correspondence

   This map previously held 45 identities, 22 of which were never
   referenced anywhere. Dormant entries are not free: they imply a
   mailbox exists behind each one, which is what made the messaging
   architecture ambiguous. Retired 2026-07-21 after confirming zero
   `FROM.<key>` references across functions/. Restore from git if a
   domain genuinely needs its own identity. */
const FROM = {
  /* Roles */
  default:      '"SOKONI" <noreply@mysokoni.co.ke>',
  verify:       '"SOKONI" <verify@mysokoni.co.ke>',      /* auth mail — Firebase SMTP sender */
  support:      '"SOKONI Support" <support@mysokoni.co.ke>',
  accounts:     '"SOKONI Accounts" <accounts@mysokoni.co.ke>',

  /* Commerce */
  orders:       '"SOKONI Orders" <orders@mysokoni.co.ke>',
  payments:     '"SOKONI Payments" <payments@mysokoni.co.ke>',
  billing:      '"SOKONI Billing" <billing@mysokoni.co.ke>',
  disputes:     '"SOKONI Disputes" <disputes@mysokoni.co.ke>',
  tickets:      '"SOKONI Tickets" <tickets@mysokoni.co.ke>',
  events:       '"SOKONI Events" <events@mysokoni.co.ke>',

  /* Merchants */
  seller:       '"SOKONI Sellers" <seller@mysokoni.co.ke>',
  vendors:      '"SOKONI Vendors" <vendors@mysokoni.co.ke>',

  /* Logistics */
  delivery:     '"SOKONI Delivery" <delivery@mysokoni.co.ke>',
  dispatch:     '"SOKONI Dispatch" <dispatch@mysokoni.co.ke>',
  drivers:      '"SOKONI Drivers" <drivers@mysokoni.co.ke>',
  tracking:     '"SOKONI Tracking" <tracking@mysokoni.co.ke>',

  /* Verticals */
  property:     '"SOKONI Property" <property@mysokoni.co.ke>',
  health:       '"SOKONI Health" <health@mysokoni.co.ke>',
  law:          '"SOKONI Legal" <law@mysokoni.co.ke>',

  /* Platform */
  security:     '"SOKONI Security" <security@mysokoni.co.ke>',
  tech:         '"SOKONI Tech" <tech@mysokoni.co.ke>',
  marketing:    '"SOKONI" <marketing@mysokoni.co.ke>',
  notifications:'"SOKONI" <notifications@mysokoni.co.ke>',
  marketplace:  '"SOKONI Marketplace" <notifications@mysokoni.co.ke>',
};

/* The one monitored destination. Both transports below default every
   outbound message's Reply-To to this, so no reply can land on an
   unattended address. Changing it changes reply routing platform-wide,
   which is the point: one place, not 45. */
const REPLY_TO = 'support@mysokoni.co.ke';

module.exports.FROM     = FROM;
module.exports.REPLY_TO = REPLY_TO;

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

/* ── CRLF sanitizer — prevents header injection in SMTP path ── */
function _sanitizeHeader(val) {
  return String(val || "").replace(/[\r\n]/g, " ").trim();
}

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

/* ── Click tracking ────────────────────────────────────────────────────────────
 *
 * P0, 2026-07-19: click tracking broke every activation link in production.
 *
 * The chain, each step verified:
 *   1. generatePasswordResetLink() -> https://…firebaseapp.com/__/auth/action?oobCode=…
 *   2. SendGrid click tracking rewrites it to  http://url5214.mysokoni.co.ke/ls/click?…
 *      (link branding id 5512127, DNS-valid, CNAME -> sendgrid.net)
 *   3. Firebase Hosting serves  Strict-Transport-Security: …; includeSubDomains
 *      for mysokoni.co.ke, so any browser that has ever loaded the site force-upgrades
 *      that http link to https.
 *   4. SendGrid holds no certificate for url5214.mysokoni.co.ke — it serves *.sendgrid.net.
 *      openssl: "verify error:num=62: hostname mismatch".
 *   5. Safari blocks the navigation. The user cannot activate their account.
 *
 * Two independent reasons this stays off, not one:
 *
 *   a) The certificate. Until SendGrid provisions SSL for the branded link domain (or the
 *      link brand is moved to a hostname NOT under the HSTS includeSubDomains umbrella),
 *      EVERY click-tracked link in EVERY SOKONI email fails for any recipient whose browser
 *      has cached our HSTS policy — which is every merchant we have onboarded. This is not
 *      specific to password links; those are simply where it was caught.
 *
 *   b) Confidentiality. SendGrid rewrites to plaintext http. A Firebase oobCode is a
 *      single-use credential that sets an account password. Routing it through an http
 *      redirector exposes it to any network observer for recipients WITHOUT HSTS. Auth mail
 *      must never be click-tracked even after the certificate is fixed.
 *
 * Re-enabling: set CLICK_TRACKING_ENABLED = true ONLY after confirming with
 *   openssl s_client -servername <brand> -connect <brand>:443 -verify_hostname <brand>
 * that the branded domain serves a certificate valid for its own name. Auth mail
 * (_carriesAuthCredential) stays off regardless — that is deliberate and must not be relaxed.
 */
const CLICK_TRACKING_ENABLED = false;

/* Categories that carry credentials or account-control links. */
const NO_TRACK_CATEGORIES = new Set(["security", "account", "system", "support"]);

/* Firebase auth action links and our own password/verify routes. Matched against the
   rendered HTML so a credential link is caught no matter which caller sent it. */
const AUTH_LINK_RE = /(__\/auth\/action|mode=(resetPassword|verifyEmail|signIn|recoverEmail)|oobCode=|\/reset-password|\/set-password|\/verify-email)/i;

function _carriesAuthCredential(payload) {
  if (NO_TRACK_CATEGORIES.has(String(payload.category || "").toLowerCase())) return true;
  return AUTH_LINK_RE.test(String(payload.html || "")) || AUTH_LINK_RE.test(String(payload.text || ""));
}

/* Explicit per-send override wins over the global default, but never over auth detection. */
function _clickTrackingFor(payload) {
  if (_carriesAuthCredential(payload)) return false;
  if (typeof payload.clickTracking === "boolean") return payload.clickTracking;
  return CLICK_TRACKING_ENABLED;
}

/* ── Send via SendGrid ─────────────────────────────────────── */
async function _sendViaSendGrid(payload) {
  /* Same BOM/CRLF hazard as MAIL_PASS — SENDGRID_API_KEY is clean today, but a future
     re-paste from a Windows shell would silently 401 every send. Cheap to defend. */
  const sgKey = _cleanSecret(SENDGRID_KEY.value());
  if (!sgKey) throw new Error("SENDGRID_API_KEY not set");
  const sgMail = require("@sendgrid/mail");
  sgMail.setApiKey(sgKey);
  const msg = {
    to:          payload.to,
    from:        payload.from || FROM.default,
    replyTo:     payload.replyTo || REPLY_TO,
    subject:     payload.subject,
    html:        payload.html,
    /* THE BUG THAT BROKE EVERY TRANSACTIONAL EMAIL.
       `payload.text || ""` sent an EMPTY text/plain part whenever a caller supplied only
       html — which is every template on the platform. SendGrid rejects that outright:

         400  "The content value must be a string at least one character in length."
              field: content.1.value

       Verified against the live API with the production key: html + text:"" -> 400,
       html alone -> 202 Accepted.

       Every send then fell through to the SMTP fallback, whose own credential is broken
       (see MAIL_PASS), so the visible symptom was a misleading
       "535 Authentication failed … grant is invalid, expired, or revoked" — which pointed
       at credentials when the real fault was a malformed payload.

       Omit the field entirely rather than send an empty one. A plain-text alternative is
       still used whenever a caller actually provides one. */
    ...(payload.text ? { text: payload.text } : {}),
    headers:     _buildHeaders(payload),
    /* Per-message trackingSettings override the account-level setting (which is currently
       Click Tracking = enabled). Sending this block explicitly is what actually suppresses
       the rewrite — omitting it would inherit the account default and reintroduce the bug.
       Open tracking is a 1x1 pixel on the same branded host: it fails silently to load
       rather than blocking a navigation, so it is left on and does not gate activation. */
    trackingSettings: {
      clickTracking:  { enable: _clickTrackingFor(payload), enableText: false },
      openTracking:   { enable: true },
    },
    categories:  payload.category ? [payload.category] : [],
    customArgs:  { emailId: payload.emailId || "", uid: payload.uid || "" },
  };

  /* Attachments — required for Purchase Orders, which must arrive as a real PDF a
     supplier can file, print and sign. Expected shape (SendGrid's own):
       [{ content: <base64>, filename, type, disposition: 'attachment' }]
     Omitted entirely when there are none, so no existing email changes shape. */
  if (Array.isArray(payload.attachments) && payload.attachments.length) {
    msg.attachments = payload.attachments;
  }

  const [response] = await sgMail.send(msg);
  return { provider: "sendgrid", statusCode: response.statusCode, messageId: response.headers["x-message-id"] || "" };
}

/* Strict email format check — defends against nodemailer addressparser DoS
 * and unintended-domain routing bugs (CVE-2024-* series). Only simple
 * user@domain.tld addresses accepted; RFC-2822 "Group:" syntax is rejected. */
function _assertSafeEmail(addr) {
  if (typeof addr !== "string") throw new Error("Invalid recipient address type");
  const sanitized = addr.replace(/[\r\n]/g, "");
  if (!/^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$/.test(sanitized)) {
    throw new Error(`Rejected non-simple email address to prevent parser exploit: ${sanitized.slice(0,60)}`);
  }
}

/* ── Send via SMTP (nodemailer) ────────────────────────────── */
/* Secrets written from a Windows shell or an editor pick up a UTF-8 BOM (EF BB BF) and a
   trailing CRLF. MAIL_PASS was stored as 74 bytes: BOM + a perfectly valid 69-char SendGrid
   key + CRLF. SMTP then authenticates with "﻿SG.xxx\r\n" and is rejected 535
   "Authentication failed: The provided authorization grant is invalid, expired, or revoked"
   — wording that sends you hunting for an expired OAuth grant when the credential is
   actually fine and merely has three invisible bytes glued to it.

   Trim at the point of use so a malformed secret cannot silently break auth again. */
function _cleanSecret(v) {
  return typeof v === "string" ? v.replace(/^﻿/, "").trim() : v;
}

async function _sendViaSmtp(payload) {
  const host = _cleanSecret(MAIL_HOST.value());
  const user = _cleanSecret(MAIL_USER.value());
  const pass = _cleanSecret(MAIL_PASS.value());
  if (!host || !user || !pass) throw new Error("MAIL_HOST / MAIL_USER / MAIL_PASS not set");
  _assertSafeEmail(payload.to);
  const nodemailer = require("nodemailer");
  const transporter = nodemailer.createTransport({
    host, port: 587, secure: false,
    auth: { user, pass },
    pool: true, maxConnections: 5,
    tls: { rejectUnauthorized: true },
  });
  const customHeaders = _buildHeaders(payload);
  /* Sanitize header-injectable fields before passing to nodemailer SMTP */
  const info = await transporter.sendMail({
    from:    _sanitizeHeader(payload.from || FROM.default),
    to:      _sanitizeHeader(payload.to),
    replyTo: _sanitizeHeader(payload.replyTo || REPLY_TO),
    subject: _sanitizeHeader(payload.subject),
    html:    payload.html,
    text:    payload.text || "",
    headers: customHeaders,
    /* Attachment parity with the SendGrid transport. If the fallback could not carry the
       PDF, a SendGrid outage would silently downgrade a Purchase Order to a plain email —
       the supplier would receive a message referring to an attachment that is not there. */
    attachments: (Array.isArray(payload.attachments) && payload.attachments.length)
      ? payload.attachments.map(a => ({
          filename:    a.filename,
          content:     a.content,          /* base64 */
          encoding:    "base64",
          contentType: a.type || "application/pdf",
        }))
      : undefined,
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

/* ── Provider error extraction ─────────────────────────────
   SendGrid throws a ResponseError carrying the ONLY useful diagnosis: response.body.errors
   is an array of {message, field, help}. Previously the caller logged e.message alone, which
   for a 400 is the literal string "Bad Request" — no field, no reason. Every rejection was
   therefore unexplainable after the fact. Nothing here is summarised or truncated below 2KB;
   the raw body is preserved as sent by the provider. */
function _describeProviderError(err) {
  const out = {
    message: (err && err.message) || String(err),
    code:    (err && (err.code || err.statusCode)) || null,
    status:  (err && err.response && err.response.statusCode) || (err && err.code) || null,
    body:    null,
    headers: null,
    errors:  null,
    requestId: null,
  };
  try {
    const r = err && err.response;
    if (r) {
      if (r.body !== undefined) {
        out.body = typeof r.body === "string" ? r.body.slice(0, 2000)
                                              : JSON.stringify(r.body).slice(0, 2000);
        const parsed = typeof r.body === "string" ? JSON.parse(r.body) : r.body;
        if (parsed && Array.isArray(parsed.errors)) {
          /* The actionable part: which field SendGrid rejected and why. */
          out.errors = parsed.errors.map(e => ({
            message: String(e.message || "").slice(0, 300),
            field:   e.field ? String(e.field).slice(0, 120) : null,
            help:    e.help ? String(e.help).slice(0, 200) : null,
          }));
        }
      }
      if (r.headers) {
        const h = r.headers;
        out.requestId = h["x-message-id"] || h["x-request-id"] || null;
        out.headers = JSON.stringify({
          "x-message-id": h["x-message-id"] || null,
          "x-request-id": h["x-request-id"] || null,
          "retry-after":  h["retry-after"] || null,
challenge:      h["www-authenticate"] || null,
        }).slice(0, 500);
      }
    }
  } catch (_) { /* never let diagnosis throw */ }
  return out;
}

/* Retry classification. A 400/401/403 will fail identically on every retry — retrying
   wastes quota and delays the operator noticing. Only transient conditions retry. */
const _RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const _RETRYABLE_CODE = new Set([
  "ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "EAI_AGAIN", "ENOTFOUND", "EBADNAME", "ESOCKET", "ECONNECTION",
]);
function _isRetryable(desc) {
  if (!desc) return false;
  const s = Number(desc.status);
  if (Number.isFinite(s) && s >= 400) return _RETRYABLE_STATUS.has(s);
  if (desc.code && _RETRYABLE_CODE.has(String(desc.code))) return true;
  /* Unclassified (no status, no known code) — treat as transient once rather than
     discarding a message that may simply have hit a blip. */
  return !desc.status;
}

/* ── Log email result to Firestore ──────────────────────────
   Both attempts are recorded SEPARATELY. Previously `error` held only the SMTP failure, so
   a SendGrid 400 followed by an SMTP auth failure was logged as an SMTP problem — the real
   cause was overwritten and lost. sendgridError and smtpError are now distinct fields and
   neither can mask the other. Existing fields keep their names and meanings so current
   dashboards and queries continue to work unchanged. */
async function _log(payload, result, error, attempts) {
  const a = attempts || {};
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

    /* ── Per-attempt detail (new) ── */
    sendgridAttempted: !!a.sendgrid,
    sendgridStatus:    a.sendgrid ? (a.sendgrid.ok ? "accepted" : "rejected") : null,
    sendgridHttp:      a.sendgrid && a.sendgrid.err ? a.sendgrid.err.status : (a.sendgrid && a.sendgrid.statusCode) || null,
    sendgridMessageId: (a.sendgrid && a.sendgrid.messageId) || null,
    sendgridError:     a.sendgrid && a.sendgrid.err ? a.sendgrid.err.message : null,
    sendgridBody:      a.sendgrid && a.sendgrid.err ? a.sendgrid.err.body : null,
    sendgridErrors:    a.sendgrid && a.sendgrid.err ? a.sendgrid.err.errors : null,
    sendgridHeaders:   a.sendgrid && a.sendgrid.err ? a.sendgrid.err.headers : null,
    sendgridRequestId: a.sendgrid && a.sendgrid.err ? a.sendgrid.err.requestId : null,

    smtpAttempted:     !!a.smtp,
    smtpStatus:        a.smtp ? (a.smtp.ok ? "accepted" : "rejected") : null,
    smtpError:         a.smtp && a.smtp.err ? a.smtp.err.message : null,
    smtpCode:          a.smtp && a.smtp.err ? a.smtp.err.code : null,
    smtpResponse:      a.smtp && a.smtp.err ? a.smtp.err.body : null,

    /* Lifecycle + retry decision, so the queue processor and any human read the same verdict. */
    outcome:     error ? (a.retryable ? "retry_scheduled" : "permanent_failure") : "delivered",
    retryable:   error ? !!a.retryable : null,
    queuedAt:    payload.queuedAt || null,
    pickedUpAt:  a.pickedUpAt || null,
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
  const attempts = { pickedUpAt: new Date().toISOString() };

  /* SendGrid first, SMTP strictly as fallback. Both outcomes are captured independently
     so neither attempt can overwrite the other's diagnosis. */
  try {
    result = await _sendViaSendGrid(payload);
    attempts.sendgrid = { ok: true, statusCode: result.statusCode, messageId: result.messageId };
  } catch (e1) {
    const d = _describeProviderError(e1);
    attempts.sendgrid = { ok: false, err: d };
    /* Log the BODY, not just "Bad Request" — the body is the only part that says why. */
    console.error("[Email] SendGrid rejected", JSON.stringify({
      to: payload.to, subject: String(payload.subject || "").slice(0, 80),
      template: payload.template || null,
      status: d.status, message: d.message, errors: d.errors, requestId: d.requestId,
      body: d.body,
    }));

    try {
      result = await _sendViaSmtp(payload);
      attempts.smtp = { ok: true, messageId: result.messageId };
    } catch (e2) {
      const d2 = _describeProviderError(e2);
      attempts.smtp = { ok: false, err: d2 };
      /* Surface the ORIGINAL SendGrid failure as the thrown error. The SMTP failure is a
         second symptom; reporting it as the cause is what hid this problem for weeks. */
      error = e1;
      error.smtpFallbackError = e2.message;
      console.error("[Email] Both transports failed", JSON.stringify({
        sendgrid: { status: d.status, message: d.message, errors: d.errors },
        smtp:     { code: d2.code, message: d2.message },
      }));
    }
  }

  /* Retry eligibility is decided by the PRIMARY provider's verdict: a 400 from SendGrid is
     permanent no matter how many times SMTP is also down. */
  attempts.retryable = error ? _isRetryable(attempts.sendgrid && attempts.sendgrid.err) : false;

  await _log(payload, result, error, attempts);
  if (error) {
    error.retryable = attempts.retryable;
    throw error;
  }
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
      /* send() marks the error non-retryable when the PRIMARY provider returned a verdict
         that cannot change (400/401/403). Re-sending those burns quota, delays the queue
         behind messages that will never succeed, and buries the real failure under retry
         noise. Only transient conditions (429/5xx, timeouts, DNS) are retried.
         `retryable === undefined` means the classifier did not run — retry, so this change
         can never make a previously-retried message permanent by accident. */
      const nonRetryable = e && e.retryable === false;
      const failed = nonRetryable || retryCount >= (item.maxRetries || 3);
      await docRef.ref.update({
        status:      failed ? "failed" : "pending",
        retryCount,
        lastError:   e.message,
        /* Preserve the primary provider's reason on the queue document too, so the queue
           can be triaged without cross-referencing emailLogs. */
        lastErrorDetail: (e && e.smtpFallbackError)
          ? String(e.message) + " | smtp fallback: " + String(e.smtpFallbackError).slice(0, 200)
          : null,
        permanentFailure: !!nonRetryable,
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
  /* Marketing/newsletter default to FALSE (opt-in, KDPA/ODPC): a user who has never set a
     preference must NOT receive marketing email. Transactional categories (orders/payments/
     security/account) stay true — they are service messages, not marketing consent. */
  const defaults = { orders: true, payments: true, security: true, marketing: false, account: true, newsletter: false };
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
