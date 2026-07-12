/* ============================================================
   SOKONI Email Template Library  v2.0
   60+ responsive HTML templates — Outlook · Gmail · Apple Mail · Yahoo
   SOKONI brand: dark theme · #71ff00 green · #00d4ff cyan
   v2.1 — Logo: Sokoni Logo.png (wordmark, 180×120 display, 33 KB); alt="SOKONI";
           all 53 templates confirmed base() inheritance
============================================================ */
"use strict";

const { FROM } = require("./email-service");
const { COMPANY } = require("./company-identity");

/* SOKONI email wordmark — 360×320→240 px, pre-resampled for email.

   WHY A DEDICATED EMAIL ASSET (root cause of the faded/washed-out logo):
   The template renders the mark in a 180×120 box. Previously it served the 480×320
   master, forcing every client to downscale to 37.5%. Gmail and Outlook use a naive
   (non-premultiplied) box filter: each output pixel averages its neighbours INCLUDING
   fully-transparent ones, which carry RGB 0,0,0 at alpha 0. The mark is 93.7%
   transparent with thin anti-aliased strokes, so that filter bled colour and alpha
   out of every stroke — the logo rendered FADED, washed out, partly invisible.

   This asset is pre-resampled by scripts/build-email-logo.js in PREMULTIPLIED-ALPHA
   space (the mathematically correct way to filter transparency, and exactly what the
   client filter gets wrong). Mean luminance is preserved (120.3 → 120.8), proving no
   colour bleed. At 360×240 it is a clean 2× of the render box, so HiDPI clients draw
   it 1:1 and 1× clients do a lossless 2:1 halving. No client performs an aggressive
   fractional downscale any more.

   Served from Firebase Hosting over permanent HTTPS with CDN caching.
   Sits on the hard-coded #0d1117 header in BOTH light and dark mode, so it can never
   be a light mark on a light background. */
const LOGO_URL    = "https://mysokoni.co.ke/assets/sokoni-email-logo.png";
const BASE_URL    = "https://mysokoni.co.ke";
const SUPPORT_URL = `${BASE_URL}/support.html`;
const PRIVACY_URL = `${BASE_URL}/trust.html`;
const TERMS_URL   = `${BASE_URL}/trust.html#terms`;
const UNSUB_URL   = `${BASE_URL}/profile.html#email-preferences`;
const YEAR        = new Date().getFullYear();

/* ── XSS-safe escape ─────────────────────────────────────── */
function esc(s) {
  return String(s || "")
    .replace(/&/g,"&amp;").replace(/</g,"&lt;")
    .replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

/* ── Format KES amounts ────────────────────────────────────── */
function fmt(n) { return "KES " + Number(n || 0).toLocaleString("en-KE"); }

/* ── Enterprise base email layout ────────────────────────────
   600 px card · centered logosokoni.png · rich footer
   Tested: Gmail · Outlook 2016-2021 · Apple Mail · Yahoo · mobile
─────────────────────────────────────────────────────────────── */
function base({ title, preheader, body, cta, ctaUrl, ctaColor = "#71ff00" }) {
  const hidden = preheader
    ? `<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;">${esc(preheader)}&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;</div>`
    : "";

  /* Outlook VML button + standard CSS button (both rendered; Outlook uses VML only) */
  const ctaBg    = ctaColor;
  const ctaText  = "#050505";
  const ctaBlock = cta && ctaUrl ? `
<table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation">
  <tr><td align="center" style="padding:8px 0 28px;">
    <!--[if mso]>
    <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" href="${esc(ctaUrl)}"
      style="height:48px;v-text-anchor:middle;width:240px;" arcsize="23%"
      strokecolor="${ctaBg}" fillcolor="${ctaBg}">
      <w:anchorlock/>
      <center style="color:${ctaText};font-family:Arial,sans-serif;font-size:15px;font-weight:900;letter-spacing:0.03em;">${esc(cta)}</center>
    </v:roundrect>
    <![endif]-->
    <!--[if !mso]><!-->
    <a href="${esc(ctaUrl)}" target="_blank"
      style="background:${ctaBg};border-radius:12px;color:${ctaText};display:inline-block;
             font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:900;
             letter-spacing:0.03em;line-height:48px;min-width:200px;padding:0 32px;
             text-align:center;text-decoration:none;-webkit-text-size-adjust:none;mso-hide:all;"
      >${esc(cta)}</a>
    <!--<![endif]-->
  </td></tr>
</table>` : "";

  const postalAddr = `${COMPANY.postalAddress}, ${COMPANY.town}, ${COMPANY.country}`;

  return `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office" lang="en">
<head>
<meta http-equiv="Content-Type" content="text/html; charset=utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="dark light">
<meta name="supported-color-schemes" content="dark light">
<!--[if mso]><xml><o:OfficeDocumentSettings><o:AllowPNG/><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml><![endif]-->
<title>${esc(title)}</title>
<style type="text/css">
body,table,td,a{-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;}
table,td{mso-table-lspace:0pt;mso-table-rspace:0pt;}
img{-ms-interpolation-mode:bicubic;border:0;height:auto;line-height:100%;outline:none;text-decoration:none;}
body{margin:0;padding:0;background-color:#050505;word-break:break-word;}
a[x-apple-data-detectors]{color:inherit!important;text-decoration:none!important;font-size:inherit!important;font-family:inherit!important;font-weight:inherit!important;line-height:inherit!important;}
#MessageViewBody,#MessageWebViewDiv{width:100%!important;}
/* Dark-mode overrides (Apple Mail, iOS Mail, Outlook Mac 2019+) */
@media (prefers-color-scheme:dark){
  .eml-bg   {background-color:#050505!important;}
  .eml-card {background-color:#0d1117!important;}
  .eml-foot {background-color:#07090f!important;}
}
/* Mobile */
@media screen and (max-width:599px){
  .eml-outer{width:100%!important;max-width:100%!important;}
  .eml-hpad {padding:22px 20px 18px!important;}
  .eml-bpad {padding:24px 20px 12px!important;}
  .eml-fpad {padding:18px 20px 22px!important;}
  .eml-logo {width:140px!important;height:93px!important;}
  .hide-mob {display:none!important;max-height:0!important;overflow:hidden!important;}
}
</style>
</head>
<body class="eml-bg" style="margin:0;padding:0;background-color:#050505;">
${hidden}
<!-- ░ OUTER WRAPPER ░ -->
<table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation" bgcolor="#050505">
<tr><td align="center" style="padding:32px 12px 48px;">

<!-- ░ EMAIL CARD 600 px ░ -->
<table class="eml-outer" width="600" cellpadding="0" cellspacing="0" border="0" role="presentation" style="max-width:600px;">

  <!-- ▸ HEADER ──────────────────────── -->
  <tr><td class="eml-card eml-hpad" bgcolor="#0d1117"
    style="border-radius:20px 20px 0 0;padding:30px 40px 22px;
           border-left:1px solid rgba(113,255,0,0.14);
           border-top:1px solid rgba(113,255,0,0.14);
           border-right:1px solid rgba(113,255,0,0.14);">
    <table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation">
      <tr><td align="center" style="padding-bottom:14px;">
        <!-- Logo: Sokoni Logo.png — official wordmark, 3:2 ratio -->
        <img src="${LOGO_URL}" width="180" height="120" class="eml-logo"
          alt="SOKONI" title="SOKONI"
          style="width:180px;height:120px;max-width:180px;display:block;margin:0 auto;border:0;outline:none;text-decoration:none;-ms-interpolation-mode:bicubic;image-rendering:auto;">
        <!-- Wordmark -->
        <p style="margin:12px 0 3px;font-family:Arial,Helvetica,sans-serif;font-size:24px;
                  font-weight:900;letter-spacing:0.1em;color:#ffffff;text-align:center;
                  mso-line-height-rule:exactly;line-height:28px;">SOKONI</p>
        <!-- Tagline -->
        <p style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:10px;
                  font-weight:700;letter-spacing:0.2em;text-transform:uppercase;
                  color:rgba(113,255,0,0.75);text-align:center;">Kenya's Super Platform</p>
      </td></tr>
      <!-- Gradient accent bar -->
      <tr><td>
        <div style="height:1px;background:linear-gradient(90deg,transparent,rgba(113,255,0,0.65) 35%,rgba(0,212,255,0.45) 65%,transparent);"></div>
      </td></tr>
    </table>
  </td></tr>

  <!-- ▸ BODY ────────────────────────── -->
  <tr><td class="eml-card eml-bpad" bgcolor="#0d1117"
    style="padding:30px 40px 14px;
           border-left:1px solid rgba(113,255,0,0.14);
           border-right:1px solid rgba(113,255,0,0.14);
           font-family:Arial,Helvetica,sans-serif;">
    ${body}
    ${ctaBlock}
  </td></tr>

  <!-- ▸ FOOTER ──────────────────────── -->
  <tr><td class="eml-foot eml-fpad" bgcolor="#07090f"
    style="border-radius:0 0 20px 20px;padding:18px 40px 24px;
           border-left:1px solid rgba(113,255,0,0.08);
           border-bottom:1px solid rgba(113,255,0,0.08);
           border-right:1px solid rgba(113,255,0,0.08);">
    <!-- Hairline divider -->
    <div style="height:1px;background:rgba(255,255,255,0.06);margin-bottom:16px;"></div>
    <!-- Navigation links -->
    <p style="margin:0 0 7px;text-align:center;font-family:Arial,Helvetica,sans-serif;font-size:11px;">
      <a href="${BASE_URL}" style="color:rgba(255,255,255,0.38);text-decoration:none;">Website</a>&nbsp;&nbsp;&middot;&nbsp;&nbsp;
      <a href="${SUPPORT_URL}" style="color:rgba(255,255,255,0.38);text-decoration:none;">Help &amp; Support</a>&nbsp;&nbsp;&middot;&nbsp;&nbsp;
      <a href="${PRIVACY_URL}" style="color:rgba(255,255,255,0.38);text-decoration:none;">Privacy Policy</a>&nbsp;&nbsp;&middot;&nbsp;&nbsp;
      <a href="${TERMS_URL}" style="color:rgba(255,255,255,0.38);text-decoration:none;">Terms of Service</a>&nbsp;&nbsp;&middot;&nbsp;&nbsp;
      <a href="${UNSUB_URL}" style="color:rgba(255,255,255,0.38);text-decoration:none;">Unsubscribe</a>
    </p>
    <!-- Legal operator line -->
    <p style="margin:0 0 5px;text-align:center;font-family:Arial,Helvetica,sans-serif;
              font-size:10px;color:rgba(255,255,255,0.22);letter-spacing:0.03em;">
      SOKONI &mdash; ${esc(COMPANY.operatedBy)}
    </p>
    <!-- Postal address + support contacts -->
    <p style="margin:0 0 5px;text-align:center;font-family:Arial,Helvetica,sans-serif;
              font-size:10px;color:rgba(255,255,255,0.18);">
      ${esc(postalAddr)}&nbsp;&nbsp;&middot;&nbsp;&nbsp;
      <a href="mailto:${esc(COMPANY.supportEmail)}"
         style="color:rgba(255,255,255,0.25);text-decoration:none;">${esc(COMPANY.supportEmail)}</a>&nbsp;&nbsp;&middot;&nbsp;&nbsp;
      ${esc(COMPANY.supportPhone)}
    </p>
    <!-- Copyright -->
    <p style="margin:0;text-align:center;font-family:Arial,Helvetica,sans-serif;
              font-size:10px;color:rgba(255,255,255,0.13);">
      &copy; ${YEAR} SOKONI &middot; A product of ${esc(COMPANY.legalName)}. All rights reserved.
    </p>
  </td></tr>

</table>
<!-- ░ END CARD ░ -->

</td></tr></table>
<!-- ░ END OUTER ░ -->
</body></html>`;
}

/* ── Plain-text fallback generator ──────────────────────────
   Strips all HTML and reconstructs clean plain text.
   Called by getTemplate() — no template changes required.
─────────────────────────────────────────────────────────────── */
function toPlainText(html) {
  const postalAddr = `${COMPANY.postalAddress}, ${COMPANY.town}, ${COMPANY.country}`;
  const body = html
    /* Remove non-visible blocks */
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<!--\[if[^\]]*\]>[\s\S]*?<!\[endif\]-->/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    /* Block-level → newlines */
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(?:p|div|h[1-6]|li|ul|ol|blockquote|tr)>/gi, "\n")
    .replace(/<td[^>]*>/gi, "  ")
    /* Inline emphasis */
    .replace(/<strong[^>]*>([\s\S]*?)<\/strong>/gi, "*$1*")
    /* Links: TEXT (URL) */
    .replace(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_, url, txt) => {
      const clean = txt.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
      if (clean && clean.toLowerCase() !== url.toLowerCase()) return `${clean} ( ${url} )`;
      return clean || url;
    })
    /* Strip remaining tags */
    .replace(/<[^>]+>/g, "")
    /* HTML entities */
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'")
    .replace(/&nbsp;/g, " ").replace(/&copy;/g, "©").replace(/&middot;/g, "·")
    .replace(/&mdash;/g, "—").replace(/&ndash;/g, "–").replace(/&zwnj;/g, "")
    .replace(/&#x?[0-9a-f]+;/gi, " ").replace(/&[a-z]+;/gi, " ")
    /* Whitespace cleanup */
    .replace(/[ \t]+/g, " ").replace(/\n[ \t]+/g, "\n").replace(/\n{3,}/g, "\n\n")
    .trim();

  return `${body}

──────────────────────────────────────────────
SOKONI — mysokoni.co.ke
Support: ${COMPANY.supportEmail} · ${COMPANY.supportPhone}
${postalAddr}

Privacy Policy : ${PRIVACY_URL}
Terms of Service: ${TERMS_URL}
Unsubscribe     : ${UNSUB_URL}

© ${YEAR} SOKONI · A product of ${COMPANY.legalName}. All rights reserved.`;
}

/* ── Re-usable sub-components ─────────────────────────────── */
function greeting(name) {
  return `<p style="margin:0 0 18px;font-size:16px;color:rgba(255,255,255,0.85);line-height:1.5;">Hi <strong>${esc(name || "there")}</strong>,</p>`;
}
function divider() {
  return `<div style="height:1px;background:rgba(255,255,255,0.06);margin:20px 0;"></div>`;
}
function infoRow(label, value, highlight) {
  return `<tr>
    <td style="padding:7px 0;font-family:Arial,Helvetica,sans-serif;font-size:12px;color:rgba(255,255,255,0.4);">${esc(label)}</td>
    <td style="padding:7px 0;font-family:Arial,Helvetica,sans-serif;font-size:12px;font-weight:700;color:${highlight ? "#71ff00" : "rgba(255,255,255,0.85)"};text-align:right;">${esc(value)}</td>
  </tr>`;
}
function card(content) {
  return `<div style="background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.07);border-radius:12px;padding:16px 18px;margin:0 0 20px;">${content}</div>`;
}
function badge(text, color = "#71ff00") {
  return `<span style="display:inline-block;background:${color}20;border:1px solid ${color}40;border-radius:20px;padding:3px 10px;font-size:11px;font-weight:700;color:${color};">${esc(text)}</span>`;
}
function trackingSteps(steps, current) {
  return `<table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px;">
    ${steps.map((s, i) => {
      const done = i < current;
      const active = i === current;
      const color = done || active ? "#71ff00" : "rgba(255,255,255,0.15)";
      return `<tr><td style="padding:6px 0;">
        <table cellpadding="0" cellspacing="0" border="0"><tr>
          <td width="28" style="text-align:center;vertical-align:top;padding-top:2px;">
            <div style="width:20px;height:20px;border-radius:50%;background:${active ? "#71ff00" : done ? "rgba(113,255,0,0.3)" : "rgba(255,255,255,0.08)"};border:2px solid ${color};margin:0 auto;"></div>
            ${i < steps.length-1 ? `<div style="width:2px;height:20px;background:${done ? "rgba(113,255,0,0.3)" : "rgba(255,255,255,0.06)"};margin:2px auto 0;"></div>` : ""}
          </td>
          <td style="padding-left:10px;font-family:Arial,Helvetica,sans-serif;font-size:13px;color:${active ? "#71ff00" : done ? "rgba(255,255,255,0.7)" : "rgba(255,255,255,0.3)"};font-weight:${active ? "900" : "400"};">${esc(s)}</td>
        </tr></table>
      </td></tr>`;
    }).join("")}
  </table>`;
}

/* ═══════════════════════════════════════════════════════════
   TEMPLATE REGISTRY
   Each entry: { subject(d), from, category, preheader(d)?, html(d) }
═══════════════════════════════════════════════════════════ */
const TEMPLATES = {

  /* ── ACCOUNT ──────────────────────────────────────────────── */
  "welcome": {
    subject:  d => `Welcome to SOKONI, ${d.name || ""}! 🎉`,
    from:     FROM.default,
    category: "account",
    html: d => base({
      title: "Welcome to SOKONI",
      preheader: "Your account is ready. Start shopping, selling and exploring Kenya's super platform.",
      cta: "Explore SOKONI", ctaUrl: `${BASE_URL}/index.html`,
      body: `
        ${greeting(d.name)}
        <p style="margin:0 0 20px;font-size:14px;color:rgba(255,255,255,0.55);line-height:1.7;">
          Welcome to <strong style="color:#71ff00;">SOKONI</strong> — Kenya's super platform. You can now shop, sell, book services, find property, hire professionals and much more.
        </p>
        ${card(`
          <p style="margin:0 0 8px;font-size:10px;font-weight:700;letter-spacing:1px;color:rgba(255,255,255,0.3);">GET STARTED</p>
          <table width="100%" cellpadding="0" cellspacing="0" border="0">
            ${infoRow("Browse Marketplace", "index.html")}
            ${infoRow("Complete Your Profile", "profile.html")}
            ${infoRow("Set Up Your Store", "seller.html")}
          </table>
        `)}
      `,
    }),
  },

  "email-verify": {
    subject:  d => `Verify your SOKONI email`,
    from:     FROM.security,
    category: "account",
    html: d => base({
      title: "Email Verification",
      preheader: `Your verification code is ${d.code}`,
      cta: "Verify My Email", ctaUrl: d.verifyUrl || BASE_URL,
      body: `
        ${greeting(d.name)}
        <p style="margin:0 0 20px;font-size:14px;color:rgba(255,255,255,0.55);line-height:1.7;">Please verify your email address to activate your SOKONI account.</p>
        <div style="text-align:center;margin:24px 0;">
          <div style="display:inline-block;background:rgba(113,255,0,0.08);border:2px solid rgba(113,255,0,0.3);border-radius:16px;padding:18px 32px;">
            <p style="margin:0;font-size:11px;font-weight:700;letter-spacing:2px;color:rgba(255,255,255,0.35);text-transform:uppercase;">Verification Code</p>
            <p style="margin:8px 0 0;font-size:32px;font-weight:900;letter-spacing:8px;color:#71ff00;">${esc(d.code || "")}</p>
          </div>
        </div>
        <p style="margin:0;font-size:12px;color:rgba(255,255,255,0.3);text-align:center;">This code expires in 10 minutes. Do not share it with anyone.</p>
      `,
    }),
  },

  "login-alert": {
    subject:  d => `New login to your SOKONI account`,
    from:     FROM.security,
    category: "security",
    html: d => base({
      title: "Login Alert",
      preheader: `New sign-in detected from ${d.device || "unknown device"}`,
      cta: "Secure My Account", ctaUrl: `${BASE_URL}/profile.html`,
      body: `
        ${greeting(d.name)}
        <p style="margin:0 0 20px;font-size:14px;color:rgba(255,255,255,0.55);">We detected a new sign-in to your SOKONI account.</p>
        ${card(`
          <p style="margin:0 0 8px;font-size:10px;font-weight:700;letter-spacing:1px;color:rgba(255,255,255,0.3);">SIGN-IN DETAILS</p>
          <table width="100%" cellpadding="0" cellspacing="0" border="0">
            ${infoRow("Date & Time", esc(d.time || "Just now"))}
            ${infoRow("Device", esc(d.device || "Unknown"))}
            ${infoRow("Location", esc(d.location || "Kenya"))}
            ${infoRow("IP Address", esc(d.ip || "Unknown"))}
          </table>
        `)}
        <p style="margin:0;font-size:13px;color:rgba(255,255,255,0.45);">If this was not you, please change your password immediately and contact <a href="${SUPPORT_URL}" style="color:#71ff00;">support</a>.</p>
      `,
    }),
  },

  "password-reset": {
    subject:  d => `Reset your SOKONI password`,
    from:     FROM.security,
    category: "security",
    html: d => base({
      title: "Password Reset",
      preheader: "Click the button to reset your SOKONI password",
      cta: "Reset My Password", ctaUrl: d.resetUrl || BASE_URL,
      body: `
        ${greeting(d.name)}
        <p style="margin:0 0 20px;font-size:14px;color:rgba(255,255,255,0.55);line-height:1.7;">We received a request to reset your password. Click the button below to create a new password. This link expires in 1 hour.</p>
        <p style="margin:0;font-size:12px;color:rgba(255,255,255,0.3);">If you didn't request this, you can safely ignore this email.</p>
      `,
    }),
  },

  "2fa-code": {
    subject:  d => `Your SOKONI 2FA code: ${d.code}`,
    from:     FROM.security,
    category: "security",
    html: d => base({
      title: "Two-Factor Authentication",
      preheader: `Your 2FA code is ${d.code}`,
      body: `
        ${greeting(d.name)}
        <p style="margin:0 0 20px;font-size:14px;color:rgba(255,255,255,0.55);">Use this code to complete your sign-in:</p>
        <div style="text-align:center;margin:24px 0;">
          <div style="display:inline-block;background:rgba(0,212,255,0.08);border:2px solid rgba(0,212,255,0.3);border-radius:16px;padding:16px 40px;">
            <p style="margin:0;font-size:36px;font-weight:900;letter-spacing:10px;color:#00d4ff;">${esc(d.code || "")}</p>
          </div>
        </div>
        <p style="margin:0;font-size:12px;color:rgba(255,255,255,0.3);text-align:center;">Expires in 5 minutes. Never share this code.</p>
      `,
    }),
  },

  "suspicious-login": {
    subject:  d => `⚠️ Suspicious login attempt on your SOKONI account`,
    from:     FROM.security,
    category: "security",
    html: d => base({
      title: "Suspicious Login Detected", ctaColor: "#ff4d6d",
      preheader: "We blocked a suspicious login attempt on your account",
      cta: "Review My Account", ctaUrl: `${BASE_URL}/profile.html`,
      body: `
        ${greeting(d.name)}
        <div style="background:rgba(255,77,109,0.08);border:1px solid rgba(255,77,109,0.25);border-radius:12px;padding:14px 18px;margin:0 0 20px;">
          <p style="margin:0;font-size:14px;color:rgba(255,77,109,0.9);font-weight:700;">Suspicious Activity Detected</p>
        </div>
        <p style="margin:0 0 20px;font-size:14px;color:rgba(255,255,255,0.55);">We detected an unusual login attempt on your account and have blocked it for your safety.</p>
        ${card(`<table width="100%" cellpadding="0" cellspacing="0" border="0">
          ${infoRow("Time", esc(d.time || "Just now"))}
          ${infoRow("Location", esc(d.location || "Unknown"))}
          ${infoRow("Device", esc(d.device || "Unknown"))}
          ${infoRow("Status", "Blocked")}
        </table>`)}
        <p style="margin:0;font-size:13px;color:rgba(255,255,255,0.45);">Please change your password immediately if you did not attempt this login.</p>
      `,
    }),
  },

  /* ── SELLER / VENDOR ─────────────────────────────────────── */
  "seller-approved": {
    subject:  d => `Your SOKONI seller account is approved! 🎉`,
    from:     FROM.vendors,
    category: "account",
    html: d => base({
      title: "Seller Account Approved",
      preheader: "Congratulations! Your seller account is live.",
      cta: "Go to My Store", ctaUrl: `${BASE_URL}/seller.html`,
      body: `
        ${greeting(d.name)}
        <p style="margin:0 0 20px;font-size:14px;color:rgba(255,255,255,0.55);line-height:1.7;">Congratulations! Your seller account on SOKONI has been approved. You can now list products and start selling.</p>
        ${card(`<table width="100%" cellpadding="0" cellspacing="0" border="0">
          ${infoRow("Store Name", esc(d.storeName))}
          ${infoRow("Account Type", esc(d.accountType || "Seller"))}
          ${infoRow("Commission Rate", esc(d.commission || "Standard"))}
        </table>`)}
      `,
    }),
  },

  "seller-rejected": {
    subject:  d => `Your SOKONI seller application update`,
    from:     FROM.vendors,
    category: "account",
    html: d => base({
      title: "Seller Application Update",
      preheader: "We couldn't approve your seller application at this time.",
      cta: "Reapply Now", ctaUrl: `${BASE_URL}/register.html`,
      body: `
        ${greeting(d.name)}
        <p style="margin:0 0 20px;font-size:14px;color:rgba(255,255,255,0.55);line-height:1.7;">We've reviewed your seller application and unfortunately we couldn't approve it at this time.</p>
        ${d.reason ? card(`<p style="margin:0;font-size:10px;font-weight:700;letter-spacing:1px;color:rgba(255,255,255,0.3);margin-bottom:8px;">REASON</p><p style="margin:0;font-size:13px;color:rgba(255,255,255,0.65);">${esc(d.reason)}</p>`) : ""}
        <p style="margin:0;font-size:13px;color:rgba(255,255,255,0.45);">You may address these issues and reapply. Contact <a href="${SUPPORT_URL}" style="color:#71ff00;">support</a> if you need help.</p>
      `,
    }),
  },

  "product-approved": {
    subject:  d => `Product "${d.productName}" is now live`,
    from:     FROM.seller,
    category: "account",
    html: d => base({
      title: "Product Approved",
      preheader: `Your product is now live on SOKONI`,
      cta: "View My Product", ctaUrl: `${BASE_URL}/product.html?id=${esc(d.productId)}`,
      body: `
        ${greeting(d.name)}
        <p style="margin:0 0 20px;font-size:14px;color:rgba(255,255,255,0.55);">Your product has been reviewed and is now live on SOKONI.</p>
        ${card(`<table width="100%" cellpadding="0" cellspacing="0" border="0">
          ${infoRow("Product", esc(d.productName))}
          ${infoRow("Category", esc(d.category))}
          ${infoRow("Price", fmt(d.price))}
          ${infoRow("Status", "✅ Live")}
        </table>`)}
      `,
    }),
  },

  "product-rejected": {
    subject:  d => `Product "${d.productName}" needs attention`,
    from:     FROM.seller,
    category: "account",
    html: d => base({
      title: "Product Needs Attention",
      preheader: "Your product listing needs changes before it can go live",
      cta: "Edit My Product", ctaUrl: `${BASE_URL}/seller.html`,
      body: `
        ${greeting(d.name)}
        <p style="margin:0 0 20px;font-size:14px;color:rgba(255,255,255,0.55);">Your product <strong>${esc(d.productName)}</strong> needs some changes before it can be published.</p>
        ${d.reason ? card(`<p style="margin:0 0 8px;font-size:10px;font-weight:700;letter-spacing:1px;color:rgba(255,255,255,0.3);">REQUIRED CHANGES</p><p style="margin:0;font-size:13px;color:rgba(255,255,255,0.65);">${esc(d.reason)}</p>`) : ""}
      `,
    }),
  },

  /* ── ORDERS ──────────────────────────────────────────────── */
  "order-confirmation": {
    subject:  d => `Order Confirmed — #${d.orderId}`,
    from:     FROM.orders,
    category: "order",
    html: d => base({
      title: "Order Confirmed",
      preheader: `Your order #${d.orderId} has been confirmed`,
      cta: "Track My Order", ctaUrl: `${BASE_URL}/track.html?id=${esc(d.orderId)}`,
      body: `
        ${greeting(d.name)}
        <p style="margin:0 0 20px;font-size:14px;color:rgba(255,255,255,0.55);">Your order has been confirmed and is being prepared.</p>
        ${card(`
          <p style="margin:0 0 10px;font-size:10px;font-weight:700;letter-spacing:1px;color:rgba(255,255,255,0.3);">ORDER SUMMARY</p>
          <table width="100%" cellpadding="0" cellspacing="0" border="0">
            ${infoRow("Order ID", `#${esc(d.orderId)}`)}
            ${infoRow("Items", esc(d.items || "See order details"))}
            ${infoRow("Total", fmt(d.total), true)}
            ${infoRow("Payment", esc(d.paymentMethod))}
            ${d.deliveryAddress ? infoRow("Delivery To", esc(d.deliveryAddress)) : ""}
          </table>
        `)}
        ${d.estimatedDelivery ? `<p style="margin:0 0 0;font-size:12px;color:rgba(255,255,255,0.35);">Estimated delivery: <strong>${esc(d.estimatedDelivery)}</strong></p>` : ""}
      `,
    }),
  },

  "order-shipped": {
    subject:  d => `Your order #${d.orderId} is on its way! 🚚`,
    from:     FROM.orders,
    category: "order",
    html: d => base({
      title: "Order Shipped",
      preheader: "Your order is on its way",
      cta: "Track My Order", ctaUrl: `${BASE_URL}/track.html?id=${esc(d.orderId)}`,
      body: `
        ${greeting(d.name)}
        <p style="margin:0 0 20px;font-size:14px;color:rgba(255,255,255,0.55);">Great news! Your order has been picked up and is on its way to you.</p>
        ${card(`<table width="100%" cellpadding="0" cellspacing="0" border="0">
          ${infoRow("Order ID", `#${esc(d.orderId)}`)}
          ${d.driverName ? infoRow("Driver", esc(d.driverName)) : ""}
          ${d.eta ? infoRow("Estimated Arrival", esc(d.eta), true) : ""}
          ${d.trackingCode ? infoRow("Tracking Code", esc(d.trackingCode)) : ""}
        </table>`)}
        ${trackingSteps(["Order Placed","Order Confirmed","Picked Up","On the Way","Delivered"], 2)}
      `,
    }),
  },

  "order-delivered": {
    subject:  d => `Your order #${d.orderId} has been delivered ✅`,
    from:     FROM.orders,
    category: "order",
    html: d => base({
      title: "Order Delivered",
      preheader: "Your order has arrived. Please leave a review!",
      cta: "Leave a Review", ctaUrl: `${BASE_URL}/reviews.html?order=${esc(d.orderId)}`,
      body: `
        ${greeting(d.name)}
        <p style="margin:0 0 20px;font-size:14px;color:rgba(255,255,255,0.55);">Your order has been successfully delivered. We hope you love it!</p>
        ${card(`<table width="100%" cellpadding="0" cellspacing="0" border="0">
          ${infoRow("Order ID", `#${esc(d.orderId)}`)}
          ${infoRow("Delivered", esc(d.deliveredAt || "Just now"), true)}
          ${d.driverName ? infoRow("Delivered By", esc(d.driverName)) : ""}
        </table>`)}
        <p style="margin:0;font-size:13px;color:rgba(255,255,255,0.45);">Not satisfied? Contact <a href="${SUPPORT_URL}" style="color:#71ff00;">support</a> or open a <a href="${BASE_URL}/dispute.html?order=${esc(d.orderId)}" style="color:#71ff00;">dispute</a>.</p>
      `,
    }),
  },

  "order-cancelled": {
    subject:  d => `Order #${d.orderId} has been cancelled`,
    from:     FROM.orders,
    category: "order",
    html: d => base({
      title: "Order Cancelled",
      preheader: `Order #${d.orderId} was cancelled`,
      cta: "Shop Again", ctaUrl: BASE_URL,
      body: `
        ${greeting(d.name)}
        <p style="margin:0 0 20px;font-size:14px;color:rgba(255,255,255,0.55);">Your order <strong>#${esc(d.orderId)}</strong> has been cancelled.</p>
        ${d.reason ? card(`<p style="margin:0 0 8px;font-size:10px;font-weight:700;letter-spacing:1px;color:rgba(255,255,255,0.3);">REASON</p><p style="margin:0;font-size:13px;color:rgba(255,255,255,0.65);">${esc(d.reason)}</p>`) : ""}
        <p style="margin:0;font-size:13px;color:rgba(255,255,255,0.45);">If you paid, a refund will be processed within 3–5 business days.</p>
      `,
    }),
  },

  "refund-issued": {
    subject:  d => `Refund of ${fmt(d.amount)} is on its way`,
    from:     FROM.payments,
    category: "payment",
    html: d => base({
      title: "Refund Issued",
      preheader: `Your refund of ${fmt(d.amount)} has been processed`,
      body: `
        ${greeting(d.name)}
        <p style="margin:0 0 20px;font-size:14px;color:rgba(255,255,255,0.55);">Your refund has been approved and is being processed.</p>
        ${card(`<table width="100%" cellpadding="0" cellspacing="0" border="0">
          ${infoRow("Order ID", `#${esc(d.orderId)}`)}
          ${infoRow("Refund Amount", fmt(d.amount), true)}
          ${infoRow("Method", esc(d.method || "Original payment method"))}
          ${infoRow("Processing Time", "3–5 business days")}
        </table>`)}
      `,
    }),
  },

  /* ── PAYMENTS ─────────────────────────────────────────────── */
  "payment-success": {
    subject:  d => `Payment Confirmed — ${fmt(d.amount)}`,
    from:     FROM.payments,
    category: "payment",
    html: d => base({
      title: "Payment Successful",
      preheader: `Payment of ${fmt(d.amount)} received`,
      cta: "View Receipt", ctaUrl: `${BASE_URL}/invoice.html?ref=${esc(d.ref)}`,
      body: `
        ${greeting(d.name)}
        <p style="margin:0 0 20px;font-size:14px;color:rgba(255,255,255,0.55);">Your payment has been received and confirmed.</p>
        ${card(`<table width="100%" cellpadding="0" cellspacing="0" border="0">
          ${infoRow("Amount", fmt(d.amount), true)}
          ${infoRow("Reference", esc(d.ref))}
          ${infoRow("Method", esc(d.method || "M-Pesa"))}
          ${infoRow("Date", esc(d.date || new Date().toLocaleDateString("en-KE")))}
        </table>`)}
      `,
    }),
  },

  "payment-failed": {
    subject:  d => `Payment Failed — Action Required`,
    from:     FROM.payments,
    category: "payment",
    html: d => base({
      title: "Payment Failed", ctaColor: "#ff9800",
      preheader: "Your payment could not be processed",
      cta: "Try Again", ctaUrl: `${BASE_URL}/checkout.html`,
      body: `
        ${greeting(d.name)}
        <p style="margin:0 0 20px;font-size:14px;color:rgba(255,255,255,0.55);">We were unable to process your payment of <strong>${fmt(d.amount)}</strong>.</p>
        ${d.reason ? card(`<p style="margin:0 0 8px;font-size:10px;font-weight:700;letter-spacing:1px;color:rgba(255,255,255,0.3);">REASON</p><p style="margin:0;font-size:13px;color:rgba(255,255,255,0.65);">${esc(d.reason)}</p>`) : ""}
        <p style="margin:0;font-size:13px;color:rgba(255,255,255,0.45);">Please check your M-Pesa balance and try again. Need help? <a href="${SUPPORT_URL}" style="color:#71ff00;">Contact support</a>.</p>
      `,
    }),
  },

  "seller-payout": {
    subject:  d => `Seller Payout — ${fmt(d.amount)} sent to ${d.phone}`,
    from:     FROM.payments,
    category: "payment",
    html: d => base({
      title: "Payout Sent",
      preheader: `${fmt(d.amount)} has been sent to your M-Pesa`,
      body: `
        ${greeting(d.name)}
        <p style="margin:0 0 20px;font-size:14px;color:rgba(255,255,255,0.55);">Your seller payout has been processed.</p>
        ${card(`<table width="100%" cellpadding="0" cellspacing="0" border="0">
          ${infoRow("Payout Amount", fmt(d.amount), true)}
          ${infoRow("Sent To", esc(d.phone))}
          ${infoRow("M-Pesa Ref", esc(d.mpesaRef || "Processing"))}
          ${infoRow("Date", esc(d.date || new Date().toLocaleDateString("en-KE")))}
        </table>`)}
        <p style="margin:0;font-size:12px;color:rgba(255,255,255,0.35);">View your earnings history in the <a href="${BASE_URL}/seller-revenue.html" style="color:#71ff00;">Seller Dashboard</a>.</p>
      `,
    }),
  },

  "subscription-renewal": {
    subject:  d => `SOKONI ${d.plan} subscription renewed`,
    from:     FROM.billing,
    category: "payment",
    html: d => base({
      title: "Subscription Renewed",
      preheader: `Your ${d.plan} plan has been renewed`,
      cta: "Manage Subscription", ctaUrl: `${BASE_URL}/subscriptions.html`,
      body: `
        ${greeting(d.name)}
        <p style="margin:0 0 20px;font-size:14px;color:rgba(255,255,255,0.55);">Your SOKONI <strong>${esc(d.plan)}</strong> subscription has been successfully renewed.</p>
        ${card(`<table width="100%" cellpadding="0" cellspacing="0" border="0">
          ${infoRow("Plan", esc(d.plan))}
          ${infoRow("Amount", fmt(d.amount), true)}
          ${infoRow("Next Renewal", esc(d.nextDate))}
        </table>`)}
      `,
    }),
  },

  "subscription-expiring": {
    subject:  d => `Your SOKONI ${d.plan} subscription expires in ${d.days} days`,
    from:     FROM.billing,
    category: "payment",
    html: d => base({
      title: "Subscription Expiring Soon", ctaColor: "#ffb400",
      preheader: `Your ${d.plan} subscription expires soon`,
      cta: "Renew Now", ctaUrl: `${BASE_URL}/subscriptions.html`,
      body: `
        ${greeting(d.name)}
        <p style="margin:0 0 20px;font-size:14px;color:rgba(255,255,255,0.55);">Your <strong>${esc(d.plan)}</strong> subscription expires on <strong>${esc(d.expiryDate)}</strong>. Renew to keep your features active.</p>
      `,
    }),
  },

  /* ── DISPUTES ─────────────────────────────────────────────── */
  "dispute-opened": {
    subject:  d => `Dispute opened — Order #${d.orderId}`,
    from:     FROM.disputes,
    category: "order",
    html: d => base({
      title: "Dispute Opened",
      preheader: "A dispute has been opened. Our team will review it.",
      cta: "View Dispute", ctaUrl: `${BASE_URL}/dispute.html?id=${esc(d.disputeId)}`,
      body: `
        ${greeting(d.name)}
        <p style="margin:0 0 20px;font-size:14px;color:rgba(255,255,255,0.55);">A dispute has been opened for order <strong>#${esc(d.orderId)}</strong>. Our team will review it within 24–48 hours.</p>
        ${card(`<table width="100%" cellpadding="0" cellspacing="0" border="0">
          ${infoRow("Dispute ID", `#${esc(d.disputeId)}`)}
          ${infoRow("Order", `#${esc(d.orderId)}`)}
          ${infoRow("Reason", esc(d.reason))}
          ${infoRow("Status", "Under Review")}
        </table>`)}
      `,
    }),
  },

  "dispute-resolved": {
    subject:  d => `Dispute resolved — Order #${d.orderId}`,
    from:     FROM.disputes,
    category: "order",
    html: d => base({
      title: "Dispute Resolved",
      preheader: "Your dispute has been resolved",
      body: `
        ${greeting(d.name)}
        <p style="margin:0 0 20px;font-size:14px;color:rgba(255,255,255,0.55);">Your dispute for order <strong>#${esc(d.orderId)}</strong> has been resolved.</p>
        ${card(`<table width="100%" cellpadding="0" cellspacing="0" border="0">
          ${infoRow("Resolution", esc(d.resolution), true)}
          ${d.refundAmount ? infoRow("Refund", fmt(d.refundAmount)) : ""}
        </table>`)}
      `,
    }),
  },

  /* ── DELIVERY & LOGISTICS ─────────────────────────────────── */
  "delivery-dispatched": {
    subject:  d => `Your order #${d.orderId} has been dispatched`,
    from:     FROM.delivery,
    category: "delivery",
    html: d => base({
      title: "Order Dispatched",
      preheader: "Your order has left the warehouse",
      cta: "Track My Delivery", ctaUrl: `${BASE_URL}/delivery-tracking.html?id=${esc(d.deliveryId)}`,
      body: `
        ${greeting(d.name)}
        <p style="margin:0 0 20px;font-size:14px;color:rgba(255,255,255,0.55);">Your order has been dispatched from our warehouse and is being prepared for delivery.</p>
        ${card(`<table width="100%" cellpadding="0" cellspacing="0" border="0">
          ${infoRow("Order", `#${esc(d.orderId)}`)}
          ${infoRow("Delivery ID", esc(d.deliveryId))}
          ${d.eta ? infoRow("Estimated Delivery", esc(d.eta), true) : ""}
        </table>`)}
        ${trackingSteps(["Order Placed","Order Confirmed","Dispatched","Driver Assigned","On the Way","Delivered"], 2)}
      `,
    }),
  },

  "driver-assigned": {
    subject:  d => `Driver assigned for order #${d.orderId}`,
    from:     FROM.delivery,
    category: "delivery",
    html: d => base({
      title: "Driver Assigned",
      preheader: `${d.driverName} will deliver your order`,
      cta: "Track Live", ctaUrl: `${BASE_URL}/delivery-tracking.html?id=${esc(d.deliveryId)}`,
      body: `
        ${greeting(d.name)}
        <p style="margin:0 0 20px;font-size:14px;color:rgba(255,255,255,0.55);">A driver has been assigned to deliver your order.</p>
        ${card(`<table width="100%" cellpadding="0" cellspacing="0" border="0">
          ${infoRow("Driver", esc(d.driverName), true)}
          ${d.driverPhone ? infoRow("Phone", esc(d.driverPhone)) : ""}
          ${infoRow("Vehicle", esc(d.vehicle || "Motorcycle"))}
          ${infoRow("Plate", esc(d.plate || ""))}
          ${d.eta ? infoRow("ETA", esc(d.eta), true) : ""}
        </table>`)}
      `,
    }),
  },

  "driver-on-way": {
    subject:  d => `${d.driverName} is on the way! 🛵`,
    from:     FROM.tracking,
    category: "delivery",
    html: d => base({
      title: "Driver On The Way",
      preheader: `Your driver is heading to you — ETA ${d.eta}`,
      cta: "Track Live", ctaUrl: `${BASE_URL}/delivery-tracking.html?id=${esc(d.deliveryId)}`,
      body: `
        ${greeting(d.name)}
        <p style="margin:0 0 20px;font-size:14px;color:rgba(255,255,255,0.55);"><strong>${esc(d.driverName)}</strong> has picked up your order and is heading to you now!</p>
        ${card(`<table width="100%" cellpadding="0" cellspacing="0" border="0">
          ${infoRow("Estimated Arrival", esc(d.eta), true)}
          ${infoRow("Driver", esc(d.driverName))}
          ${d.driverPhone ? infoRow("Driver Phone", esc(d.driverPhone)) : ""}
          ${infoRow("Delivery To", esc(d.address || "Your location"))}
        </table>`)}
        ${trackingSteps(["Dispatched","Driver Assigned","On the Way","Nearby","Delivered"], 2)}
      `,
    }),
  },

  "eta-update": {
    subject:  d => `Delivery ETA Update — Order #${d.orderId}`,
    from:     FROM.tracking,
    category: "delivery",
    html: d => base({
      title: "ETA Update",
      preheader: `Updated delivery time for your order`,
      cta: "Track My Delivery", ctaUrl: `${BASE_URL}/delivery-tracking.html?id=${esc(d.deliveryId)}`,
      body: `
        ${greeting(d.name)}
        <p style="margin:0 0 20px;font-size:14px;color:rgba(255,255,255,0.55);">We have an updated delivery estimate for your order <strong>#${esc(d.orderId)}</strong>.</p>
        ${card(`<table width="100%" cellpadding="0" cellspacing="0" border="0">
          ${infoRow("New ETA", esc(d.eta), true)}
          ${d.reason ? infoRow("Reason", esc(d.reason)) : ""}
        </table>`)}
      `,
    }),
  },

  "delivery-delayed": {
    subject:  d => `Delivery delay — Order #${d.orderId}`,
    from:     FROM.delivery,
    category: "delivery",
    html: d => base({
      title: "Delivery Delayed", ctaColor: "#ffb400",
      preheader: "Your delivery is running slightly late",
      cta: "Track My Delivery", ctaUrl: `${BASE_URL}/delivery-tracking.html?id=${esc(d.deliveryId)}`,
      body: `
        ${greeting(d.name)}
        <p style="margin:0 0 20px;font-size:14px;color:rgba(255,255,255,0.55);">We're sorry — your delivery for order <strong>#${esc(d.orderId)}</strong> is running late.</p>
        ${card(`<table width="100%" cellpadding="0" cellspacing="0" border="0">
          ${infoRow("New Estimated Arrival", esc(d.newEta), true)}
          ${d.reason ? infoRow("Reason", esc(d.reason)) : ""}
        </table>`)}
        <p style="margin:0;font-size:13px;color:rgba(255,255,255,0.45);">We apologise for the inconvenience. Questions? <a href="${SUPPORT_URL}" style="color:#71ff00;">Contact support</a>.</p>
      `,
    }),
  },

  "delivery-failed": {
    subject:  d => `Delivery attempt failed — Order #${d.orderId}`,
    from:     FROM.delivery,
    category: "delivery",
    html: d => base({
      title: "Delivery Failed", ctaColor: "#ff4d6d",
      preheader: "We were unable to complete your delivery",
      cta: "Reschedule Delivery", ctaUrl: SUPPORT_URL,
      body: `
        ${greeting(d.name)}
        <p style="margin:0 0 20px;font-size:14px;color:rgba(255,255,255,0.55);">We were unable to complete the delivery for order <strong>#${esc(d.orderId)}</strong>.</p>
        ${card(`<table width="100%" cellpadding="0" cellspacing="0" border="0">
          ${infoRow("Reason", esc(d.reason || "Customer not available"))}
          ${infoRow("Attempted At", esc(d.attemptedAt || "See tracking"))}
        </table>`)}
        <p style="margin:0;font-size:13px;color:rgba(255,255,255,0.45);">Please contact us to reschedule your delivery or arrange a pickup.</p>
      `,
    }),
  },

  "driver-nearby": {
    subject:  d => `Your driver is nearby! 📍`,
    from:     FROM.tracking,
    category: "delivery",
    html: d => base({
      title: "Driver Nearby",
      preheader: "Your delivery is almost here — be ready!",
      cta: "View Live Location", ctaUrl: `${BASE_URL}/delivery-tracking.html?id=${esc(d.deliveryId)}`,
      body: `
        ${greeting(d.name)}
        <p style="margin:0 0 20px;font-size:14px;color:rgba(255,255,255,0.55);"><strong style="color:#71ff00;">${esc(d.driverName)}</strong> is just <strong>${esc(d.distance || "a few minutes")}</strong> away with your order!</p>
        <p style="margin:0;font-size:13px;color:rgba(255,255,255,0.45);">Please be ready to receive your delivery.</p>
      `,
    }),
  },

  "live-tracking-link": {
    subject:  d => `Track your delivery live — Order #${d.orderId}`,
    from:     FROM.tracking,
    category: "delivery",
    html: d => base({
      title: "Live Tracking Link",
      preheader: "Follow your delivery in real-time",
      cta: "Track Live", ctaUrl: `${BASE_URL}/delivery-tracking.html?id=${esc(d.deliveryId)}`,
      body: `
        ${greeting(d.name)}
        <p style="margin:0 0 20px;font-size:14px;color:rgba(255,255,255,0.55);">You can now follow your delivery in real-time on SOKONI.</p>
        ${card(`<table width="100%" cellpadding="0" cellspacing="0" border="0">
          ${infoRow("Order", `#${esc(d.orderId)}`)}
          ${infoRow("Driver", esc(d.driverName))}
          ${d.eta ? infoRow("ETA", esc(d.eta), true) : ""}
        </table>`)}
      `,
    }),
  },

  /* ── DISPATCH (to drivers / dispatch managers) ─────────────── */
  "driver-new-job": {
    subject:  d => `New delivery job available — Order #${d.orderId}`,
    from:     FROM.dispatch,
    category: "dispatch",
    html: d => base({
      title: "New Job Available",
      preheader: `New delivery job in ${d.pickup}`,
      cta: "Accept Job", ctaUrl: `${BASE_URL}/driver.html`,
      body: `
        <p style="margin:0 0 20px;font-size:16px;color:rgba(255,255,255,0.85);">Hi <strong>${esc(d.driverName)}</strong>,</p>
        <p style="margin:0 0 20px;font-size:14px;color:rgba(255,255,255,0.55);">A new delivery job is available for you.</p>
        ${card(`<table width="100%" cellpadding="0" cellspacing="0" border="0">
          ${infoRow("Order", `#${esc(d.orderId)}`)}
          ${infoRow("Pickup", esc(d.pickup))}
          ${infoRow("Dropoff", esc(d.dropoff))}
          ${infoRow("Distance", esc(d.distance || "TBD"))}
          ${infoRow("Earnings", fmt(d.earnings), true)}
        </table>`)}
        <p style="margin:0;font-size:12px;color:rgba(255,255,255,0.3);">Open your driver app to accept this job.</p>
      `,
    }),
  },

  "dispatch-unassigned-alert": {
    subject:  d => `⚠️ Unassigned delivery — Order #${d.orderId}`,
    from:     FROM.dispatch,
    category: "dispatch",
    html: d => base({
      title: "Unassigned Delivery Alert", ctaColor: "#ffb400",
      preheader: `Order #${d.orderId} has no driver assigned`,
      cta: "Assign Driver", ctaUrl: `${BASE_URL}/admin.html`,
      body: `
        <p style="margin:0 0 20px;font-size:14px;color:rgba(255,255,255,0.85);">Admin Alert — Action Required</p>
        <p style="margin:0 0 20px;font-size:14px;color:rgba(255,255,255,0.55);">An order has been waiting for a driver assignment for over <strong>${esc(d.waitTime || "30 minutes")}</strong>.</p>
        ${card(`<table width="100%" cellpadding="0" cellspacing="0" border="0">
          ${infoRow("Order ID", `#${esc(d.orderId)}`)}
          ${infoRow("Customer", esc(d.customerName))}
          ${infoRow("Pickup", esc(d.pickup))}
          ${infoRow("Dropoff", esc(d.dropoff))}
          ${infoRow("Waiting Since", esc(d.waitingSince))}
        </table>`)}
      `,
    }),
  },

  "dispatch-overdue": {
    subject:  d => `🚨 Overdue delivery — Order #${d.orderId} needs escalation`,
    from:     FROM.dispatch,
    category: "dispatch",
    html: d => base({
      title: "Overdue Delivery — Escalation Required", ctaColor: "#ff4d6d",
      preheader: `Delivery for order #${d.orderId} is overdue by ${d.overdueBy}`,
      cta: "Escalate Now", ctaUrl: `${BASE_URL}/admin.html`,
      body: `
        <p style="margin:0 0 20px;font-size:14px;color:rgba(255,255,255,0.85);">Admin Escalation Alert</p>
        <div style="background:rgba(255,77,109,0.08);border:1px solid rgba(255,77,109,0.25);border-radius:12px;padding:14px 18px;margin:0 0 20px;">
          <p style="margin:0;font-size:14px;color:rgba(255,77,109,0.9);font-weight:700;">Delivery overdue by ${esc(d.overdueBy)}</p>
        </div>
        ${card(`<table width="100%" cellpadding="0" cellspacing="0" border="0">
          ${infoRow("Order", `#${esc(d.orderId)}`)}
          ${d.driverName ? infoRow("Driver", esc(d.driverName)) : infoRow("Driver", "Not Assigned")}
          ${infoRow("Customer", esc(d.customerName))}
          ${infoRow("Original ETA", esc(d.originalEta))}
        </table>`)}
      `,
    }),
  },

  /* ── DRIVERS ──────────────────────────────────────────────── */
  "driver-welcome": {
    subject:  d => `Welcome to SOKONI Drivers! 🚴`,
    from:     FROM.drivers,
    category: "account",
    html: d => base({
      title: "Welcome, Driver!",
      preheader: "Your driver account is under review",
      cta: "View Driver Dashboard", ctaUrl: `${BASE_URL}/driver.html`,
      body: `
        ${greeting(d.name)}
        <p style="margin:0 0 20px;font-size:14px;color:rgba(255,255,255,0.55);line-height:1.7;">Thank you for signing up as a SOKONI driver. Your application is now under review. We'll notify you once it's approved.</p>
        ${card(`<p style="margin:0 0 8px;font-size:10px;font-weight:700;letter-spacing:1px;color:rgba(255,255,255,0.3);">NEXT STEPS</p>
          <p style="margin:0 0 5px;font-size:13px;color:rgba(255,255,255,0.65);">1. Complete your profile and upload required documents</p>
          <p style="margin:0 0 5px;font-size:13px;color:rgba(255,255,255,0.65);">2. Wait for verification (24–48 hours)</p>
          <p style="margin:0;font-size:13px;color:rgba(255,255,255,0.65);">3. Start earning once approved</p>`)}
      `,
    }),
  },

  "driver-approved": {
    subject:  d => `Your SOKONI driver account is approved! Start earning 💚`,
    from:     FROM.drivers,
    category: "account",
    html: d => base({
      title: "Driver Account Approved",
      preheader: "You're now verified to drive with SOKONI",
      cta: "Start Earning", ctaUrl: `${BASE_URL}/driver.html`,
      body: `
        ${greeting(d.name)}
        <p style="margin:0 0 20px;font-size:14px;color:rgba(255,255,255,0.55);line-height:1.7;">Congratulations! Your driver account has been verified. You can now go online and start accepting delivery jobs.</p>
        ${card(`<table width="100%" cellpadding="0" cellspacing="0" border="0">
          ${infoRow("Driver ID", esc(d.driverId || ""))}
          ${infoRow("Vehicle", esc(d.vehicle))}
          ${infoRow("Zone", esc(d.zone || "All Nairobi"))}
          ${infoRow("Status", "✅ Active")}
        </table>`)}
      `,
    }),
  },

  "driver-rejected": {
    subject:  d => `Driver application update — action required`,
    from:     FROM.drivers,
    category: "account",
    html: d => base({
      title: "Driver Application Update",
      preheader: "Your driver application needs attention",
      cta: "Update My Documents", ctaUrl: `${BASE_URL}/onboarding-driver.html`,
      body: `
        ${greeting(d.name)}
        <p style="margin:0 0 20px;font-size:14px;color:rgba(255,255,255,0.55);">We're unable to approve your driver application at this time.</p>
        ${d.reason ? card(`<p style="margin:0 0 8px;font-size:10px;font-weight:700;letter-spacing:1px;color:rgba(255,255,255,0.3);">REASON</p><p style="margin:0;font-size:13px;color:rgba(255,255,255,0.65);">${esc(d.reason)}</p>`) : ""}
        <p style="margin:0;font-size:13px;color:rgba(255,255,255,0.45);">Please update your documents and reapply.</p>
      `,
    }),
  },

  "driver-doc-expiry": {
    subject:  d => `⚠️ Your ${d.docName} expires in ${d.days} days`,
    from:     FROM.drivers,
    category: "account",
    html: d => base({
      title: "Document Expiry Reminder", ctaColor: "#ffb400",
      preheader: `${d.docName} expires in ${d.days} days — update it now`,
      cta: "Update Documents", ctaUrl: `${BASE_URL}/driver.html#documents`,
      body: `
        ${greeting(d.name)}
        <p style="margin:0 0 20px;font-size:14px;color:rgba(255,255,255,0.55);">Your <strong>${esc(d.docName)}</strong> will expire on <strong>${esc(d.expiryDate)}</strong>. Please update it to keep your account active.</p>
        ${card(`<table width="100%" cellpadding="0" cellspacing="0" border="0">
          ${infoRow("Document", esc(d.docName))}
          ${infoRow("Expiry Date", esc(d.expiryDate))}
          ${infoRow("Days Remaining", esc(String(d.days)))}
        </table>`)}
      `,
    }),
  },

  "driver-earnings": {
    subject:  d => `Your SOKONI earnings — ${fmt(d.amount)}`,
    from:     FROM.drivers,
    category: "payment",
    html: d => base({
      title: "Earnings Summary",
      preheader: `${fmt(d.amount)} earned this ${d.period || "week"}`,
      cta: "View Earnings", ctaUrl: `${BASE_URL}/driver.html#earnings`,
      body: `
        ${greeting(d.name)}
        <p style="margin:0 0 20px;font-size:14px;color:rgba(255,255,255,0.55);">Here's your earnings summary for <strong>${esc(d.period || "this week")}</strong>.</p>
        ${card(`<table width="100%" cellpadding="0" cellspacing="0" border="0">
          ${infoRow("Total Earned", fmt(d.amount), true)}
          ${infoRow("Deliveries", esc(String(d.deliveries || 0)))}
          ${infoRow("Average Per Trip", fmt(d.avgPerTrip))}
          ${infoRow("Payout Date", esc(d.payoutDate || "Next Friday"))}
        </table>`)}
      `,
    }),
  },

  "driver-performance": {
    subject:  d => `Driver Performance Alert`,
    from:     FROM.drivers,
    category: "account",
    html: d => base({
      title: "Performance Alert", ctaColor: d.positive ? "#71ff00" : "#ffb400",
      preheader: d.positive ? "Keep it up! Great performance this week." : "Action needed to maintain your driver status",
      cta: "View Dashboard", ctaUrl: `${BASE_URL}/driver.html`,
      body: `
        ${greeting(d.name)}
        <p style="margin:0 0 20px;font-size:14px;color:rgba(255,255,255,0.55);">${esc(d.message || "Here is your performance update.")}</p>
        ${card(`<table width="100%" cellpadding="0" cellspacing="0" border="0">
          ${infoRow("Rating", esc(String(d.rating || 0) + " / 5.0"), d.positive)}
          ${infoRow("Completion Rate", esc(String(d.completionRate || 0) + "%"))}
          ${infoRow("On-Time Rate", esc(String(d.onTimeRate || 0) + "%"))}
        </table>`)}
      `,
    }),
  },

  /* ── EVENTS & TICKETS ─────────────────────────────────────── */
  "ticket-purchase": {
    subject:  d => `Your ticket for ${d.eventName} 🎟️`,
    from:     FROM.tickets,
    category: "order",
    html: d => base({
      title: "Ticket Confirmed",
      preheader: `Your ticket for ${d.eventName} is confirmed`,
      cta: "View My Ticket", ctaUrl: `${BASE_URL}/entertainment.html?ticket=${esc(d.ticketId)}`,
      body: `
        ${greeting(d.name)}
        <p style="margin:0 0 20px;font-size:14px;color:rgba(255,255,255,0.55);">Your ticket purchase is confirmed. See you there!</p>
        ${card(`<table width="100%" cellpadding="0" cellspacing="0" border="0">
          ${infoRow("Event", esc(d.eventName), true)}
          ${infoRow("Date", esc(d.eventDate))}
          ${infoRow("Venue", esc(d.venue))}
          ${infoRow("Ticket Type", esc(d.ticketType))}
          ${infoRow("Ticket ID", esc(d.ticketId))}
          ${infoRow("Amount Paid", fmt(d.amount))}
        </table>`)}
        ${d.qrCode ? `${divider()}<p style="margin:0 0 8px;font-size:11px;font-weight:700;color:rgba(255,255,255,0.4);text-align:center;">YOUR ENTRY QR CODE</p>
        <div style="text-align:center;padding:10px 0;"><img src="${esc(d.qrCode)}" alt="QR Code" width="180" height="180" style="border-radius:12px;background:white;padding:12px;"></div>` : ""}
      `,
    }),
  },

  "event-reminder": {
    subject:  d => `Reminder: ${d.eventName} is ${d.daysUntil === 1 ? "tomorrow" : "in " + d.daysUntil + " days"}!`,
    from:     FROM.events,
    category: "marketing",
    html: d => base({
      title: "Event Reminder",
      preheader: `Don't forget — ${d.eventName} is coming up!`,
      cta: "View Event Details", ctaUrl: `${BASE_URL}/entertainment.html?event=${esc(d.eventId)}`,
      body: `
        ${greeting(d.name)}
        <p style="margin:0 0 20px;font-size:14px;color:rgba(255,255,255,0.55);">Just a reminder that <strong>${esc(d.eventName)}</strong> is coming up soon.</p>
        ${card(`<table width="100%" cellpadding="0" cellspacing="0" border="0">
          ${infoRow("Event", esc(d.eventName), true)}
          ${infoRow("Date", esc(d.eventDate))}
          ${infoRow("Venue", esc(d.venue))}
          ${infoRow("Your Ticket", esc(d.ticketType))}
        </table>`)}
      `,
    }),
  },

  /* ── PROPERTY ─────────────────────────────────────────────── */
  "property-enquiry": {
    subject:  d => `New enquiry for ${d.propertyTitle}`,
    from:     FROM.property,
    category: "order",
    html: d => base({
      title: "Property Enquiry",
      preheader: `Someone enquired about ${d.propertyTitle}`,
      cta: "View Enquiry", ctaUrl: `${BASE_URL}/landlord.html`,
      body: `
        ${greeting(d.name)}
        <p style="margin:0 0 20px;font-size:14px;color:rgba(255,255,255,0.55);">You have a new enquiry for <strong>${esc(d.propertyTitle)}</strong>.</p>
        ${card(`<table width="100%" cellpadding="0" cellspacing="0" border="0">
          ${infoRow("From", esc(d.enquirerName))}
          ${infoRow("Phone", esc(d.enquirerPhone))}
          ${d.message ? infoRow("Message", esc(d.message)) : ""}
        </table>`)}
      `,
    }),
  },

  "booking-confirmation": {
    subject:  d => `Booking confirmed — ${d.bookingTitle}`,
    from:     FROM.property,
    category: "order",
    html: d => base({
      title: "Booking Confirmed",
      preheader: `Your booking is confirmed`,
      cta: "View Booking", ctaUrl: `${BASE_URL}/profile.html#bookings`,
      body: `
        ${greeting(d.name)}
        <p style="margin:0 0 20px;font-size:14px;color:rgba(255,255,255,0.55);">Your booking has been confirmed.</p>
        ${card(`<table width="100%" cellpadding="0" cellspacing="0" border="0">
          ${infoRow("Booking", esc(d.bookingTitle), true)}
          ${d.checkIn  ? infoRow("Check In",  esc(d.checkIn))  : ""}
          ${d.checkOut ? infoRow("Check Out", esc(d.checkOut)) : ""}
          ${infoRow("Booking Ref", esc(d.ref))}
          ${infoRow("Total", fmt(d.total))}
        </table>`)}
      `,
    }),
  },

  /* ── HEALTHCARE ────────────────────────────────────────────── */
  "appointment-confirmation": {
    subject:  d => `Appointment confirmed with ${d.providerName}`,
    from:     FROM.health,
    category: "order",
    html: d => base({
      title: "Appointment Confirmed",
      preheader: `Your appointment with ${d.providerName} is confirmed`,
      cta: "View Appointment", ctaUrl: `${BASE_URL}/healthcare.html`,
      body: `
        ${greeting(d.name)}
        <p style="margin:0 0 20px;font-size:14px;color:rgba(255,255,255,0.55);">Your appointment has been confirmed.</p>
        ${card(`<table width="100%" cellpadding="0" cellspacing="0" border="0">
          ${infoRow("Provider", esc(d.providerName), true)}
          ${infoRow("Date", esc(d.date))}
          ${infoRow("Time", esc(d.time))}
          ${d.location ? infoRow("Location", esc(d.location)) : ""}
          ${d.type ? infoRow("Type", esc(d.type)) : ""}
        </table>`)}
      `,
    }),
  },

  "appointment-reminder": {
    subject:  d => `Reminder: Appointment with ${d.providerName} ${d.when}`,
    from:     FROM.health,
    category: "order",
    html: d => base({
      title: "Appointment Reminder",
      preheader: `Your appointment is ${d.when}`,
      cta: "View Details", ctaUrl: `${BASE_URL}/healthcare.html`,
      body: `
        ${greeting(d.name)}
        <p style="margin:0 0 20px;font-size:14px;color:rgba(255,255,255,0.55);">Reminder: You have an appointment <strong>${esc(d.when)}</strong>.</p>
        ${card(`<table width="100%" cellpadding="0" cellspacing="0" border="0">
          ${infoRow("Provider", esc(d.providerName))}
          ${infoRow("Date", esc(d.date), true)}
          ${infoRow("Time", esc(d.time))}
          ${d.location ? infoRow("Location", esc(d.location)) : ""}
        </table>`)}
      `,
    }),
  },

  /* ── LEGAL ─────────────────────────────────────────────────── */
  "legal-consultation": {
    subject:  d => `Legal consultation confirmed — ${d.lawyerName}`,
    from:     FROM.law,
    category: "order",
    html: d => base({
      title: "Legal Consultation Confirmed",
      preheader: `Consultation with ${d.lawyerName} confirmed`,
      cta: "View Details", ctaUrl: `${BASE_URL}/legal-hub.html`,
      body: `
        ${greeting(d.name)}
        <p style="margin:0 0 20px;font-size:14px;color:rgba(255,255,255,0.55);">Your legal consultation has been confirmed.</p>
        ${card(`<table width="100%" cellpadding="0" cellspacing="0" border="0">
          ${infoRow("Lawyer", esc(d.lawyerName), true)}
          ${infoRow("Specialty", esc(d.specialty))}
          ${infoRow("Date", esc(d.date))}
          ${infoRow("Time", esc(d.time))}
          ${infoRow("Fee", fmt(d.fee))}
        </table>`)}
      `,
    }),
  },

  /* ── MARKETING ─────────────────────────────────────────────── */
  "price-drop": {
    subject:  d => `Price drop on ${d.productName} — now ${fmt(d.newPrice)}!`,
    from:     FROM.marketing,
    category: "marketing",
    html: d => base({
      title: "Price Drop Alert",
      preheader: `${d.productName} just dropped in price!`,
      cta: "Shop Now", ctaUrl: `${BASE_URL}/product.html?id=${esc(d.productId)}`,
      body: `
        ${greeting(d.name)}
        <p style="margin:0 0 20px;font-size:14px;color:rgba(255,255,255,0.55);">Good news! A product on your wishlist just dropped in price.</p>
        ${card(`<table width="100%" cellpadding="0" cellspacing="0" border="0">
          ${infoRow("Product", esc(d.productName), true)}
          ${infoRow("Old Price", fmt(d.oldPrice))}
          ${infoRow("New Price", fmt(d.newPrice), true)}
          ${infoRow("You Save", fmt(d.oldPrice - d.newPrice))}
        </table>`)}
      `,
    }),
  },

  "back-in-stock": {
    subject:  d => `${d.productName} is back in stock!`,
    from:     FROM.marketing,
    category: "marketing",
    html: d => base({
      title: "Back in Stock",
      preheader: `${d.productName} is available again`,
      cta: "Buy Now", ctaUrl: `${BASE_URL}/product.html?id=${esc(d.productId)}`,
      body: `
        ${greeting(d.name)}
        <p style="margin:0 0 20px;font-size:14px;color:rgba(255,255,255,0.55);"><strong>${esc(d.productName)}</strong> that you saved to your wishlist is back in stock. Quantities are limited!</p>
      `,
    }),
  },

  "review-request": {
    subject:  d => `How was your experience? Leave a review`,
    from:     FROM.orders,
    category: "marketing",
    html: d => base({
      title: "How Was Your Experience?",
      preheader: "Share your feedback and help others",
      cta: "Leave a Review", ctaUrl: `${BASE_URL}/reviews.html?order=${esc(d.orderId)}`,
      body: `
        ${greeting(d.name)}
        <p style="margin:0 0 20px;font-size:14px;color:rgba(255,255,255,0.55);">We hope you loved your purchase! Your review helps other shoppers and rewards great sellers.</p>
        ${card(`<table width="100%" cellpadding="0" cellspacing="0" border="0">
          ${infoRow("Product", esc(d.productName))}
          ${infoRow("Order", `#${esc(d.orderId)}`)}
        </table>`)}
      `,
    }),
  },

  "referral-reward": {
    subject:  d => `You earned a referral bonus — ${fmt(d.amount)}!`,
    from:     FROM.marketing,
    category: "marketing",
    html: d => base({
      title: "Referral Bonus Earned",
      preheader: `${fmt(d.amount)} added to your SOKONI wallet`,
      cta: "View My Wallet", ctaUrl: `${BASE_URL}/wallet.html`,
      body: `
        ${greeting(d.name)}
        <p style="margin:0 0 20px;font-size:14px;color:rgba(255,255,255,0.55);">Congratulations! <strong>${esc(d.referredName)}</strong> joined SOKONI using your referral link and you've earned a bonus.</p>
        ${card(`<table width="100%" cellpadding="0" cellspacing="0" border="0">
          ${infoRow("Bonus Amount", fmt(d.amount), true)}
          ${infoRow("Referred By", esc(d.referredName))}
          ${infoRow("Added To", "SOKONI Wallet")}
        </table>`)}
      `,
    }),
  },

  /* ── ADMIN / SECURITY ─────────────────────────────────────── */
  "security-alert": {
    subject:  d => `🔐 SOKONI Security Alert — ${d.alertType}`,
    from:     FROM.security,
    category: "security",
    html: d => base({
      title: `Security Alert: ${d.alertType}`, ctaColor: "#ff4d6d",
      preheader: `Security event detected: ${d.alertType}`,
      cta: "Review Alert", ctaUrl: `${BASE_URL}/admin.html`,
      body: `
        <p style="margin:0 0 20px;font-size:16px;color:rgba(255,255,255,0.85);">Admin Security Alert</p>
        <div style="background:rgba(255,77,109,0.08);border:1px solid rgba(255,77,109,0.25);border-radius:12px;padding:14px 18px;margin:0 0 20px;">
          <p style="margin:0;font-size:14px;color:rgba(255,77,109,0.9);font-weight:700;">${esc(d.alertType)}</p>
        </div>
        ${card(`<table width="100%" cellpadding="0" cellspacing="0" border="0">
          ${infoRow("Time", esc(d.time || "Just now"))}
          ${infoRow("Details", esc(d.details))}
          ${d.ip ? infoRow("IP", esc(d.ip)) : ""}
          ${d.uid ? infoRow("User", esc(d.uid)) : ""}
        </table>`)}
      `,
    }),
  },

  "fraud-alert": {
    subject:  d => `🚨 Fraud Alert — ${d.fraudType}`,
    from:     FROM.security,
    category: "security",
    html: d => base({
      title: `Fraud Alert: ${d.fraudType}`, ctaColor: "#ff4d6d",
      preheader: `Fraud detection triggered: ${d.fraudType}`,
      cta: "Review in Admin", ctaUrl: `${BASE_URL}/admin.html`,
      body: `
        <p style="margin:0 0 20px;font-size:16px;color:rgba(255,255,255,0.85);">Fraud Detection Alert</p>
        ${card(`<table width="100%" cellpadding="0" cellspacing="0" border="0">
          ${infoRow("Fraud Type", esc(d.fraudType))}
          ${infoRow("Risk Score", esc(String(d.riskScore || 0) + "/100"))}
          ${infoRow("User", esc(d.uid || "Unknown"))}
          ${infoRow("Amount", fmt(d.amount))}
          ${infoRow("Status", esc(d.status || "Flagged"))}
        </table>`)}
      `,
    }),
  },

  "maintenance-notice": {
    subject:  d => `SOKONI Scheduled Maintenance — ${d.date}`,
    from:     FROM.tech,
    category: "system",
    html: d => base({
      title: "Scheduled Maintenance",
      preheader: `SOKONI will be down for maintenance on ${d.date}`,
      body: `
        ${greeting(d.name || "SOKONI User")}
        <p style="margin:0 0 20px;font-size:14px;color:rgba(255,255,255,0.55);line-height:1.7;">We will be performing scheduled maintenance on <strong>${esc(d.date)}</strong> at <strong>${esc(d.time)}</strong>. The platform will be unavailable for approximately <strong>${esc(d.duration)}</strong>.</p>
        <p style="margin:0;font-size:13px;color:rgba(255,255,255,0.45);">We apologise for any inconvenience. Thank you for using SOKONI.</p>
      `,
    }),
  },

};

/* ═══════════════════════════════════════════════════════════
   RENDER: getTemplate(name, data) → { subject, html, text, from, category }
   text — plain-text fallback auto-generated from the HTML
═══════════════════════════════════════════════════════════ */
function getTemplate(name, data) {
  const tmpl = TEMPLATES[name];
  if (!tmpl) throw new Error(`[EmailTemplates] Unknown template: "${name}"`);
  const subject = typeof tmpl.subject === "function" ? tmpl.subject(data) : tmpl.subject;
  const html    = tmpl.html(data);
  return {
    subject,
    html,
    text:     toPlainText(html),
    from:     tmpl.from || FROM.default,
    category: tmpl.category || "system",
  };
}

module.exports = { getTemplate, base, toPlainText, TEMPLATES };
