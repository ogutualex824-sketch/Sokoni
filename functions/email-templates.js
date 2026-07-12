/* ============================================================
   SOKONI Email Template Library  v3.0 — Enterprise Redesign
   Premium transactional design: white canvas · charcoal text
   SOKONI #71ff00 green accent · clean cards · mobile-first
   Cross-client: Outlook 2016-2021 · Gmail · Apple Mail · Yahoo
============================================================ */
"use strict";

const { FROM } = require("./email-service");
const { COMPANY } = require("./company-identity");

const BASE_URL    = "https://mysokoni.co.ke";
const SUPPORT_URL = `${BASE_URL}/support.html`;
const PRIVACY_URL = `${BASE_URL}/trust.html`;
const TERMS_URL   = `${BASE_URL}/trust.html#terms`;
const HELP_URL    = `${BASE_URL}/help.html`;
const TRUST_URL   = `${BASE_URL}/trust.html#trust-center`;
const UNSUB_URL   = `${BASE_URL}/profile.html#email-preferences`;
const YEAR        = new Date().getFullYear();

/* ── XSS-safe escape ─────────────────────────────────────── */
function esc(s) {
  return String(s || "")
    .replace(/&/g,"&amp;").replace(/</g,"&lt;")
    .replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

/* ── Format KES amounts ─────────────────────────────────── */
function fmt(n) { return "KES " + Number(n || 0).toLocaleString("en-KE"); }

/* ═══════════════════════════════════════════════════════════
   OFFICIAL BRAND LOGO (email)

   Must be an absolute, publicly-fetchable https URL: mail clients render the
   message outside our origin, and Gmail fetches through its image proxy
   (googleusercontent) — so relative paths, authenticated URLs and redirect
   chains all fail.

   PNG, not SVG: Gmail and Outlook do not render SVG in email, so an SVG here
   would silently show nothing. PNG is the only reliable format.

   Filename has no spaces on purpose. The source wordmark is "Sokoni Logo.png";
   a space must be %20-encoded in a URL and is mishandled by some clients and
   proxies, so it is published under a clean name.

   Verified: HTTP 200 · image/png · no auth · 0 redirects.
   Source 480x320 (3:2), displayed at 160x107 → 3x, sharp on Retina.
═══════════════════════════════════════════════════════════ */
const LOGO_URL = "https://mysokoni.co.ke/assets/sokoni-email-logo.png";

/* ═══════════════════════════════════════════════════════════
   BASE LAYOUT — v3.0
   600 px card · white canvas · top green accent stripe
   Dark mode: Apple Mail / iOS Mail via prefers-color-scheme
   Outlook: VML button, inline styles, no box-shadow
═══════════════════════════════════════════════════════════ */
function base({ title, preheader, body, cta, ctaUrl, ctaColor = "#71ff00" }) {
  const hidden = preheader
    ? `<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;">${esc(preheader)}&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;</div>`
    : "";

  /* Button text: dark on bright/yellow tones, white on dark tones */
  const brightCta = /^#(71ff00|ffb400|ffd700|adff2f)/i.test(ctaColor);
  const ctaText   = brightCta ? "#050505" : "#ffffff";

  const ctaBlock = cta && ctaUrl ? `
<table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation">
  <tr><td align="center" style="padding:8px 0 36px;">
    <!--[if mso]>
    <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" href="${esc(ctaUrl)}"
      style="height:52px;v-text-anchor:middle;width:240px;" arcsize="12%"
      strokecolor="${ctaColor}" fillcolor="${ctaColor}">
      <w:anchorlock/>
      <center style="color:${ctaText};font-family:Arial,sans-serif;font-size:15px;font-weight:900;letter-spacing:0.03em;">${esc(cta)}</center>
    </v:roundrect>
    <![endif]-->
    <!--[if !mso]><!-->
    <a href="${esc(ctaUrl)}" target="_blank"
      style="background:${ctaColor};border-radius:12px;color:${ctaText};display:inline-block;
             font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:900;
             letter-spacing:0.03em;line-height:52px;min-width:220px;padding:0 36px;
             text-align:center;text-decoration:none;-webkit-text-size-adjust:none;mso-hide:all;"
      >${esc(cta)}</a>
    <!--<![endif]-->
  </td></tr>
</table>` : "";

  const postalLine = `${COMPANY.postalAddress}, ${COMPANY.town}, ${COMPANY.country}`;
  const legalName  = COMPANY.legalName || "Bravilex International Co. Limited";

  return `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office" lang="en">
<head>
<meta http-equiv="Content-Type" content="text/html; charset=utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<!--[if mso]><xml><o:OfficeDocumentSettings><o:AllowPNG/><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml><![endif]-->
<title>${esc(title)}</title>
<style type="text/css">
/* ── Reset ── */
body,table,td,a{-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;}
table,td{mso-table-lspace:0pt;mso-table-rspace:0pt;}
img{-ms-interpolation-mode:bicubic;border:0;height:auto;line-height:100%;outline:none;text-decoration:none;}
body{margin:0;padding:0;background-color:#F3F4F6;word-break:break-word;}
a[x-apple-data-detectors]{color:inherit!important;text-decoration:none!important;font-size:inherit!important;font-family:inherit!important;font-weight:inherit!important;line-height:inherit!important;}
#MessageViewBody,#MessageWebViewDiv{width:100%!important;}
/* ── Dark mode (Apple Mail · iOS Mail · Outlook Mac 2019+) ── */
@media (prefers-color-scheme:dark){
  .eml-bg  {background-color:#0F172A!important;}
  .eml-card{background-color:#1E293B!important;border-color:#334155!important;}
  .eml-hdr {background-color:#1E293B!important;border-color:#334155!important;}
  .eml-body{background-color:#1E293B!important;}
  .eml-foot{background-color:#0F172A!important;border-color:#1E293B!important;}
  .eml-title{color:#F1F5F9!important;}
  .eml-tag  {color:#64748B!important;}
  .eml-p    {color:#CBD5E1!important;}
  .eml-h1   {color:#F1F5F9!important;}
  .eml-muted{color:#64748B!important;}
  .eml-info {background-color:#0F172A!important;border-color:#334155!important;}
  .eml-lbl  {color:#64748B!important;}
  .eml-val  {color:#F1F5F9!important;}
  .eml-div  {background-color:#334155!important;}
  .eml-fl   {color:#94A3B8!important;}
  .eml-fl a {color:#94A3B8!important;}
}
/* ── Mobile ── */
@media screen and (max-width:600px){
  .eml-outer{width:100%!important;max-width:100%!important;border-radius:0!important;}
  .eml-hpad {padding:28px 20px 24px!important;}
  .eml-bpad {padding:24px 20px 8px!important;}
  .eml-fpad {padding:20px 20px 28px!important;}
  /* Logo scales down on narrow screens. Width AND height are both set so the
     3:2 aspect ratio is preserved — never stretched or squashed. */
  .eml-logo {width:132px!important;height:88px!important;max-width:132px!important;}
}
</style>
</head>
<body class="eml-bg" style="margin:0;padding:0;background-color:#F3F4F6;">
${hidden}
<table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation" bgcolor="#F3F4F6">
<tr><td align="center" style="padding:40px 16px 52px;">

<!-- ░ CARD 600px ░ -->
<table class="eml-card eml-outer" width="600" cellpadding="0" cellspacing="0" border="0"
  role="presentation"
  style="max-width:600px;background:#ffffff;border:1px solid #E2E8F0;border-radius:20px;">

  <!-- ▸ TOP ACCENT STRIPE -->
  <tr><td style="height:4px;background:#71ff00;border-radius:20px 20px 0 0;font-size:0;line-height:0;">&nbsp;</td></tr>

  <!-- ▸ HEADER -->
  <tr><td class="eml-hdr eml-hpad" bgcolor="#ffffff"
    style="padding:36px 40px 28px;text-align:center;border-bottom:1px solid #F1F5F9;">
    <!-- Official SOKONI logo (see LOGO_URL above for the email-client constraints) -->
    <img class="eml-logo" src="${LOGO_URL}" alt="SOKONI" width="160" height="107"
      style="display:block;margin:0 auto 14px;width:160px;height:107px;max-width:160px;
      border:0;outline:none;text-decoration:none;-ms-interpolation-mode:bicubic;">
    <!-- Brand name as typography -->
    <p class="eml-title" style="margin:0 0 4px;font-family:Arial,Helvetica,sans-serif;
      font-size:22px;font-weight:900;letter-spacing:0.09em;color:#1F2937;text-align:center;
      mso-line-height-rule:exactly;line-height:28px;">SOKONI</p>
    <!-- Tagline -->
    <p class="eml-tag" style="margin:0;font-family:Arial,Helvetica,sans-serif;
      font-size:10px;font-weight:600;letter-spacing:0.18em;text-transform:uppercase;
      color:#9CA3AF;text-align:center;">Kenya&rsquo;s Super Platform</p>
  </td></tr>

  <!-- ▸ BODY -->
  <tr><td class="eml-body eml-bpad" bgcolor="#ffffff"
    style="padding:32px 40px 8px;font-family:Arial,Helvetica,sans-serif;">
    ${body}
    ${ctaBlock}
  </td></tr>

  <!-- ▸ FOOTER -->
  <tr><td class="eml-foot eml-fpad" bgcolor="#F8FAFC"
    style="border-radius:0 0 20px 20px;padding:24px 40px 32px;border-top:1px solid #E5E7EB;">
    <p class="eml-fl" style="margin:0 0 10px;text-align:center;
      font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:2;color:#9CA3AF;">
      <a href="${PRIVACY_URL}"  style="color:#9CA3AF;text-decoration:none;">Privacy</a>&nbsp;&middot;&nbsp;
      <a href="${TERMS_URL}"    style="color:#9CA3AF;text-decoration:none;">Terms</a>&nbsp;&middot;&nbsp;
      <a href="${HELP_URL}"     style="color:#9CA3AF;text-decoration:none;">Help Center</a>&nbsp;&middot;&nbsp;
      <a href="${TRUST_URL}"    style="color:#9CA3AF;text-decoration:none;">Trust Center</a>&nbsp;&middot;&nbsp;
      <a href="${SUPPORT_URL}"  style="color:#9CA3AF;text-decoration:none;">Contact Support</a>&nbsp;&middot;&nbsp;
      <a href="${UNSUB_URL}"    style="color:#9CA3AF;text-decoration:none;">Unsubscribe</a>
    </p>
    <p class="eml-fl" style="margin:0 0 4px;text-align:center;
      font-family:Arial,Helvetica,sans-serif;font-size:11px;color:#CBD5E1;">
      Powered by ${esc(legalName)}
    </p>
    <p class="eml-fl" style="margin:0 0 4px;text-align:center;
      font-family:Arial,Helvetica,sans-serif;font-size:11px;color:#D1D5DB;">
      ${esc(postalLine)}&nbsp;&middot;&nbsp;<a href="mailto:${esc(COMPANY.supportEmail)}"
        style="color:#D1D5DB;text-decoration:none;">${esc(COMPANY.supportEmail)}</a>
    </p>
    <p class="eml-fl" style="margin:0;text-align:center;
      font-family:Arial,Helvetica,sans-serif;font-size:11px;color:#E2E8F0;">
      &copy; ${YEAR} SOKONI. All rights reserved.
    </p>
  </td></tr>

</table>
<!-- ░ END CARD ░ -->

</td></tr></table>
</body></html>`;
}

/* ── Plain-text fallback ────────────────────────────────────
   Auto-generated from the HTML. No changes to templates needed.
──────────────────────────────────────────────────────────── */
function toPlainText(html) {
  const body = html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<!--\[if[^\]]*\]>[\s\S]*?<!\[endif\]-->/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(?:p|div|h[1-6]|li|ul|ol|blockquote|tr)>/gi, "\n")
    .replace(/<td[^>]*>/gi, "  ")
    .replace(/<strong[^>]*>([\s\S]*?)<\/strong>/gi, "*$1*")
    .replace(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_, url, txt) => {
      const clean = txt.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
      if (clean && clean.toLowerCase() !== url.toLowerCase()) return `${clean} ( ${url} )`;
      return clean || url;
    })
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'")
    .replace(/&nbsp;/g, " ").replace(/&copy;/g, "©").replace(/&middot;/g, "·")
    .replace(/&mdash;/g, "—").replace(/&ndash;/g, "–").replace(/&zwnj;/g, "")
    .replace(/&rsquo;/g, "'").replace(/&#x?[0-9a-f]+;/gi, " ").replace(/&[a-z]+;/gi, " ")
    .replace(/[ \t]+/g, " ").replace(/\n[ \t]+/g, "\n").replace(/\n{3,}/g, "\n\n")
    .trim();

  return `${body}

──────────────────────────────────────────────
SOKONI — mysokoni.co.ke
Support: ${COMPANY.supportEmail}
${COMPANY.postalAddress}, ${COMPANY.town}, ${COMPANY.country}

Privacy Policy : ${PRIVACY_URL}
Terms of Service: ${TERMS_URL}
Help Center    : ${HELP_URL}
Unsubscribe    : ${UNSUB_URL}

© ${YEAR} SOKONI. Powered by ${COMPANY.legalName}. All rights reserved.`;
}

/* ═══════════════════════════════════════════════════════════
   DESIGN SYSTEM — Sub-components
   All styled for light canvas (#ffffff). Dark-mode overrides
   applied via .eml-* CSS classes in <style>.
═══════════════════════════════════════════════════════════ */

/* Personalised greeting */
function greeting(name) {
  return `<p class="eml-p" style="margin:0 0 20px;font-family:Arial,Helvetica,sans-serif;font-size:16px;font-weight:700;color:#1F2937;line-height:1.5;">Hi${name ? `, ${esc(name)}` : " there"},</p>`;
}

/* Body paragraph */
function p(html) {
  return `<p class="eml-p" style="margin:0 0 20px;font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#4B5563;line-height:1.65;">${html}</p>`;
}

/* Muted footnote / disclaimer */
function note(html) {
  return `<p class="eml-muted" style="margin:0 0 16px;font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#9CA3AF;line-height:1.6;">${html}</p>`;
}

/* Horizontal rule */
function divider() {
  return `<div class="eml-div" style="height:1px;background:#E5E7EB;margin:24px 0;"></div>`;
}

/* Info card — contains infoRow() rows */
function card(content) {
  return `<div class="eml-info" style="background:#F8FAFC;border:1px solid #E2E8F0;border-radius:14px;padding:4px 20px;margin:0 0 24px;">${content}</div>`;
}

/* Label / value row inside card() */
function infoRow(label, value, highlight) {
  const vc = highlight ? "#16a34a" : "#1F2937";
  return `<table width="100%" cellpadding="0" cellspacing="0" border="0">
    <tr>
      <td class="eml-lbl" style="padding:11px 0;font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#9CA3AF;border-bottom:1px solid #F1F5F9;">${esc(label)}</td>
      <td class="eml-val" style="padding:11px 0;font-family:Arial,Helvetica,sans-serif;font-size:13px;font-weight:700;color:${vc};text-align:right;border-bottom:1px solid #F1F5F9;">${esc(value)}</td>
    </tr>
  </table>`;
}

/* Pill badge */
function badge(text, color = "#16a34a") {
  return `<span style="display:inline-block;background:${color}18;border:1px solid ${color}40;border-radius:20px;padding:3px 12px;font-family:Arial,Helvetica,sans-serif;font-size:11px;font-weight:700;color:${color};">${esc(text)}</span>`;
}

/* ── Hero status card (✓ Order Confirmed, ✓ Payment Received …) ── */
function statusCard(icon, title, subtitle, scheme) {
  const s = {
    success: { bg:"#DCFCE7", border:"#BBF7D0", iconBg:"#22C55E", tc:"#166534", sc:"#15803D" },
    warning: { bg:"#FFFBEB", border:"#FDE68A", iconBg:"#F59E0B", tc:"#92400E", sc:"#B45309" },
    error:   { bg:"#FEF2F2", border:"#FECACA", iconBg:"#EF4444", tc:"#991B1B", sc:"#DC2626" },
    info:    { bg:"#EFF6FF", border:"#BFDBFE", iconBg:"#3B82F6", tc:"#1E40AF", sc:"#2563EB" },
    brand:   { bg:"#F0FFF4", border:"rgba(113,255,0,0.35)", iconBg:"#71ff00", tc:"#1F2937", sc:"#4B5563" },
  }[scheme || "success"] || { bg:"#DCFCE7", border:"#BBF7D0", iconBg:"#22C55E", tc:"#166534", sc:"#15803D" };

  return `
<table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation" style="margin:0 0 28px;">
  <tr><td style="background:${s.bg};border:1px solid ${s.border};border-radius:16px;padding:28px 24px;text-align:center;">
    <div style="width:52px;height:52px;background:${s.iconBg};border-radius:50%;
                line-height:52px;text-align:center;margin:0 auto 14px;
                font-family:Arial,Helvetica,sans-serif;font-size:24px;">${icon}</div>
    <p style="margin:0 0 6px;font-family:Arial,Helvetica,sans-serif;font-size:20px;font-weight:900;color:${s.tc};line-height:1.2;">${esc(title)}</p>
    ${subtitle ? `<p style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:14px;color:${s.sc};line-height:1.5;">${esc(subtitle)}</p>` : ""}
  </td></tr>
</table>`;
}

/* ── Large metric card (payments, earnings) ── */
function metricCard(amount, label) {
  return `
<table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation" style="margin:0 0 24px;">
  <tr><td class="eml-info" style="background:#F8FAFC;border:1px solid #E2E8F0;border-radius:16px;padding:28px 24px;text-align:center;">
    <p style="margin:0 0 6px;font-family:Arial,Helvetica,sans-serif;font-size:34px;font-weight:900;color:#1F2937;letter-spacing:-0.5px;">${esc(amount)}</p>
    <p class="eml-lbl" style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:12px;font-weight:600;color:#9CA3AF;text-transform:uppercase;letter-spacing:0.12em;">${esc(label)}</p>
  </td></tr>
</table>`;
}

/* ── OTP / verification code block ── */
function codeBlock(code, label) {
  return `
<table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation" style="margin:0 0 24px;">
  <tr><td style="background:#F0FFF4;border:2px solid #BBF7D0;border-radius:16px;padding:24px;text-align:center;">
    <p style="margin:0 0 10px;font-family:Arial,Helvetica,sans-serif;font-size:11px;font-weight:700;letter-spacing:0.15em;text-transform:uppercase;color:#6B7280;">${esc(label || "Verification Code")}</p>
    <p style="margin:0;font-family:'Courier New',Courier,monospace;font-size:36px;font-weight:900;letter-spacing:0.3em;color:#1F2937;">${esc(code)}</p>
  </td></tr>
</table>`;
}

/* ── Alert banner (warning / error / info) ── */
function alertBanner(text, type) {
  const c = {
    warning: { bg:"#FFFBEB", border:"#FDE68A", text:"#92400E" },
    error:   { bg:"#FEF2F2", border:"#FECACA", text:"#991B1B" },
    info:    { bg:"#EFF6FF", border:"#BFDBFE", text:"#1E40AF" },
  }[type || "warning"] || { bg:"#FFFBEB", border:"#FDE68A", text:"#92400E" };
  return `<div style="background:${c.bg};border:1px solid ${c.border};border-radius:10px;padding:14px 18px;margin:0 0 20px;">
  <p style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:14px;font-weight:700;color:${c.text};">${text}</p>
</div>`;
}

/* ── Delivery / order tracking steps ── */
function trackingSteps(steps, current) {
  return `<table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 24px;">
    ${steps.map((s, i) => {
      const done   = i < current;
      const active = i === current;
      const dotBg  = active ? "#71ff00" : done ? "#22C55E" : "#E5E7EB";
      const dotBdr = active ? "#71ff00" : done ? "#22C55E" : "#D1D5DB";
      const dotTxt = active ? "#050505" : done ? "#ffffff" : "#9CA3AF";
      const lineBg = done ? "#22C55E" : "#E5E7EB";
      const txtClr = active ? "#1F2937" : done ? "#4B5563" : "#9CA3AF";
      const weight = active ? "900" : done ? "600" : "400";
      return `<tr><td style="padding:3px 0;">
        <table cellpadding="0" cellspacing="0" border="0"><tr>
          <td width="32" style="text-align:center;vertical-align:top;padding-top:2px;">
            <div style="width:20px;height:20px;border-radius:50%;background:${dotBg};border:2px solid ${dotBdr};
                        margin:0 auto;line-height:16px;text-align:center;
                        font-family:Arial,Helvetica,sans-serif;font-size:10px;font-weight:700;color:${dotTxt};">
              ${done && !active ? "✓" : ""}</div>
            ${i < steps.length-1 ? `<div style="width:2px;height:18px;background:${lineBg};margin:2px auto 0;"></div>` : ""}
          </td>
          <td style="padding-left:10px;font-family:Arial,Helvetica,sans-serif;font-size:13px;
                     color:${txtClr};font-weight:${weight};vertical-align:top;padding-top:2px;">${esc(s)}</td>
        </tr></table>
      </td></tr>`;
    }).join("")}
  </table>`;
}

/* ═══════════════════════════════════════════════════════════
   TEMPLATE REGISTRY
   53 templates · all inheriting the v3.0 premium base
═══════════════════════════════════════════════════════════ */
const TEMPLATES = {

  /* ─── ACCOUNT ──────────────────────────────────────────── */

  "welcome": {
    subject:  d => `Welcome to SOKONI${d.name ? `, ${d.name}` : ""}`,
    from:     FROM.default,
    category: "account",
    html: d => base({
      title: "Welcome to SOKONI",
      preheader: "Your account is ready. Start exploring Kenya's premier digital marketplace.",
      cta: "Explore SOKONI", ctaUrl: `${BASE_URL}/index.html`,
      body: `
        ${statusCard("🎉", "Welcome to SOKONI", "Your account is ready.", "brand")}
        ${greeting(d.name)}
        ${p("You can now shop, sell, book services, find property, hire professionals, order food, and much more — all in one place.")}
        ${card(`
          <p style="margin:0 0 4px;padding-top:12px;font-family:Arial,Helvetica,sans-serif;font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#9CA3AF;">Get started</p>
          ${infoRow("Browse the Marketplace", "index.html")}
          ${infoRow("Complete Your Profile", "profile.html")}
          ${infoRow("Set Up Your Store", "seller.html")}
        `)}
      `,
    }),
  },

  "email-verify": {
    subject:  d => `Verify your SOKONI email address`,
    from:     FROM.security,
    category: "account",
    html: d => base({
      title: "Verify your email",
      preheader: `Your verification code is ${d.code}`,
      cta: "Verify My Email", ctaUrl: d.verifyUrl || BASE_URL,
      body: `
        ${greeting(d.name)}
        ${p("Please verify your email address to activate your SOKONI account.")}
        ${codeBlock(d.code || "", "Verification Code")}
        ${note("This code expires in 10 minutes. Never share it with anyone.")}
      `,
    }),
  },

  "login-alert": {
    subject:  d => `New login to your SOKONI account`,
    from:     FROM.security,
    category: "security",
    html: d => base({
      title: "New login detected",
      preheader: `New sign-in from ${d.device || "an unknown device"}`,
      cta: "Secure My Account", ctaUrl: `${BASE_URL}/profile.html`,
      body: `
        ${greeting(d.name)}
        ${p("We detected a new sign-in to your SOKONI account.")}
        ${card(`
          ${infoRow("Date & Time", esc(d.time || "Just now"))}
          ${infoRow("Device", esc(d.device || "Unknown"))}
          ${infoRow("Location", esc(d.location || "Kenya"))}
          ${infoRow("IP Address", esc(d.ip || "Unknown"))}
        `)}
        ${note(`If this was not you, please change your password immediately and <a href="${SUPPORT_URL}" style="color:#16a34a;">contact support</a>.`)}
      `,
    }),
  },

  "password-reset": {
    subject:  d => `Reset your SOKONI password`,
    from:     FROM.security,
    category: "security",
    html: d => base({
      title: "Password reset",
      preheader: "Click the button to create a new password",
      cta: "Reset My Password", ctaUrl: d.resetUrl || BASE_URL,
      body: `
        ${greeting(d.name)}
        ${p("We received a request to reset your SOKONI password. This link expires in <strong>1 hour</strong>.")}
        ${note("If you did not request a password reset, you can safely ignore this email.")}
      `,
    }),
  },

  "2fa-code": {
    subject:  d => `Your SOKONI login code: ${d.code}`,
    from:     FROM.security,
    category: "security",
    html: d => base({
      title: "Your login code",
      preheader: `Your 2FA code is ${d.code}`,
      body: `
        ${greeting(d.name)}
        ${p("Use this code to complete your sign-in:")}
        ${codeBlock(d.code || "", "Login Code")}
        ${note("Expires in <strong>5 minutes</strong>. Never share this code with anyone.")}
      `,
    }),
  },

  "suspicious-login": {
    subject:  d => `Suspicious login attempt on your SOKONI account`,
    from:     FROM.security,
    category: "security",
    html: d => base({
      title: "Suspicious login blocked", ctaColor: "#EF4444",
      preheader: "We blocked a suspicious login attempt — action required",
      cta: "Review My Account", ctaUrl: `${BASE_URL}/profile.html`,
      body: `
        ${statusCard("⚠", "Suspicious Activity Blocked", "We stopped an unusual login attempt.", "error")}
        ${greeting(d.name)}
        ${p("We detected an unusual login attempt on your account and have blocked it for your safety.")}
        ${card(`
          ${infoRow("Date & Time", esc(d.time || "Just now"))}
          ${infoRow("Location", esc(d.location || "Unknown"))}
          ${infoRow("Device", esc(d.device || "Unknown"))}
          ${infoRow("Status", "Blocked")}
        `)}
        ${note("Please change your password immediately if you did not attempt this login.")}
      `,
    }),
  },

  /* ─── SELLERS ──────────────────────────────────────────── */

  "seller-approved": {
    subject:  d => `Your SOKONI seller account is approved`,
    from:     FROM.vendors,
    category: "account",
    html: d => base({
      title: "Seller account approved",
      preheader: "Congratulations — your seller account is now live.",
      cta: "Go to My Store", ctaUrl: `${BASE_URL}/seller.html`,
      body: `
        ${statusCard("✓", "Seller Account Approved", "You can now list products and start selling.", "success")}
        ${greeting(d.name)}
        ${card(`
          ${infoRow("Store Name", esc(d.storeName || ""))}
          ${infoRow("Account Type", esc(d.accountType || "Seller"))}
          ${infoRow("Commission Rate", esc(d.commission || "Standard"))}
        `)}
      `,
    }),
  },

  "seller-rejected": {
    subject:  d => `Your SOKONI seller application — update required`,
    from:     FROM.vendors,
    category: "account",
    html: d => base({
      title: "Seller application update",
      preheader: "Your seller application needs attention before approval.",
      cta: "Reapply Now", ctaUrl: `${BASE_URL}/register.html`,
      body: `
        ${greeting(d.name)}
        ${p("We reviewed your seller application and were unable to approve it at this time.")}
        ${d.reason ? card(`
          <p style="margin:0 0 4px;padding-top:12px;font-family:Arial,Helvetica,sans-serif;font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#9CA3AF;">Reason</p>
          ${infoRow("", esc(d.reason))}
        `) : ""}
        ${note(`Please address the issues above and reapply. <a href="${SUPPORT_URL}" style="color:#16a34a;">Contact support</a> if you need help.`)}
      `,
    }),
  },

  "product-approved": {
    subject:  d => `Your product "${d.productName}" is now live`,
    from:     FROM.seller,
    category: "account",
    html: d => base({
      title: "Product approved",
      preheader: `${d.productName} is now visible to buyers on SOKONI`,
      cta: "View My Product", ctaUrl: `${BASE_URL}/product.html?id=${esc(d.productId)}`,
      body: `
        ${statusCard("✓", "Product Live", `${d.productName} is now visible to buyers.`, "success")}
        ${card(`
          ${infoRow("Product", esc(d.productName))}
          ${infoRow("Category", esc(d.category || ""))}
          ${infoRow("Price", fmt(d.price))}
        `)}
      `,
    }),
  },

  "product-rejected": {
    subject:  d => `Your product "${d.productName}" needs changes`,
    from:     FROM.seller,
    category: "account",
    html: d => base({
      title: "Product listing update required",
      preheader: "Your product needs changes before it can go live",
      cta: "Edit My Product", ctaUrl: `${BASE_URL}/seller.html`,
      body: `
        ${greeting(d.name)}
        ${p(`Your product <strong>${esc(d.productName)}</strong> requires changes before it can be published.`)}
        ${d.reason ? card(`
          <p style="margin:0 0 4px;padding-top:12px;font-family:Arial,Helvetica,sans-serif;font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#9CA3AF;">Required changes</p>
          ${infoRow("", esc(d.reason))}
        `) : ""}
      `,
    }),
  },

  /* ─── ORDERS ───────────────────────────────────────────── */

  "order-confirmation": {
    subject:  d => `Order confirmed — #${d.orderId}`,
    from:     FROM.orders,
    category: "order",
    html: d => base({
      title: "Order Confirmed",
      preheader: `Your order #${d.orderId} is confirmed and being prepared.`,
      cta: "Track My Order", ctaUrl: `${BASE_URL}/track.html?id=${esc(d.orderId)}`,
      body: `
        ${statusCard("✓", "Order Confirmed", "Your order is being prepared.", "success")}
        ${greeting(d.name)}
        ${card(`
          ${infoRow("Order ID", `#${esc(d.orderId)}`)}
          ${d.items ? infoRow("Items", esc(d.items)) : ""}
          ${infoRow("Total", fmt(d.total), true)}
          ${infoRow("Payment", esc(d.paymentMethod || ""))}
          ${d.deliveryAddress ? infoRow("Deliver to", esc(d.deliveryAddress)) : ""}
          ${d.estimatedDelivery ? infoRow("Estimated Delivery", esc(d.estimatedDelivery)) : ""}
        `)}
      `,
    }),
  },

  "order-shipped": {
    subject:  d => `Your order #${d.orderId} is on its way`,
    from:     FROM.orders,
    category: "order",
    html: d => base({
      title: "Order Shipped",
      preheader: "Your order has been picked up and is on the way",
      cta: "Track My Order", ctaUrl: `${BASE_URL}/track.html?id=${esc(d.orderId)}`,
      body: `
        ${statusCard("🚚", "Order Shipped", "Your order is on its way to you.", "info")}
        ${greeting(d.name)}
        ${card(`
          ${infoRow("Order ID", `#${esc(d.orderId)}`)}
          ${d.driverName  ? infoRow("Driver", esc(d.driverName)) : ""}
          ${d.eta         ? infoRow("Estimated Arrival", esc(d.eta), true) : ""}
          ${d.trackingCode ? infoRow("Tracking Code", esc(d.trackingCode)) : ""}
        `)}
        ${trackingSteps(["Order Placed","Confirmed","Picked Up","On the Way","Delivered"], 2)}
      `,
    }),
  },

  "order-delivered": {
    subject:  d => `Your order #${d.orderId} has been delivered`,
    from:     FROM.orders,
    category: "order",
    html: d => base({
      title: "Order Delivered",
      preheader: "Your order has arrived. How was your experience?",
      cta: "Leave a Review", ctaUrl: `${BASE_URL}/reviews.html?order=${esc(d.orderId)}`,
      body: `
        ${statusCard("✓", "Order Delivered", "Your order has arrived successfully.", "success")}
        ${greeting(d.name)}
        ${card(`
          ${infoRow("Order ID", `#${esc(d.orderId)}`)}
          ${infoRow("Delivered", esc(d.deliveredAt || "Today"), true)}
          ${d.driverName ? infoRow("Delivered by", esc(d.driverName)) : ""}
        `)}
        ${note(`Not satisfied? <a href="${SUPPORT_URL}" style="color:#16a34a;">Contact support</a> or open a <a href="${BASE_URL}/dispute.html?order=${esc(d.orderId)}" style="color:#16a34a;">dispute</a>.`)}
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
        ${p(`Your order <strong>#${esc(d.orderId)}</strong> has been cancelled.`)}
        ${d.reason ? card(`
          <p style="margin:0 0 4px;padding-top:12px;font-family:Arial,Helvetica,sans-serif;font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#9CA3AF;">Reason</p>
          ${infoRow("", esc(d.reason))}
        `) : ""}
        ${note("If you paid, a refund will be processed within 3–5 business days.")}
      `,
    }),
  },

  "refund-issued": {
    subject:  d => `Refund of ${fmt(d.amount)} is on its way`,
    from:     FROM.payments,
    category: "payment",
    html: d => base({
      title: "Refund Issued",
      preheader: `Your refund of ${fmt(d.amount)} has been approved`,
      body: `
        ${statusCard("↩", "Refund Issued", `${fmt(d.amount)} is being processed.`, "info")}
        ${greeting(d.name)}
        ${card(`
          ${infoRow("Order ID", `#${esc(d.orderId)}`)}
          ${infoRow("Refund Amount", fmt(d.amount), true)}
          ${infoRow("Method", esc(d.method || "Original payment method"))}
          ${infoRow("Processing Time", "3–5 business days")}
        `)}
      `,
    }),
  },

  /* ─── PAYMENTS ─────────────────────────────────────────── */

  "payment-success": {
    subject:  d => `Payment confirmed — ${fmt(d.amount)}`,
    from:     FROM.payments,
    category: "payment",
    html: d => base({
      title: "Payment Confirmed",
      preheader: `Payment of ${fmt(d.amount)} received`,
      cta: "View Receipt", ctaUrl: `${BASE_URL}/invoice.html?ref=${esc(d.ref)}`,
      body: `
        ${metricCard(fmt(d.amount), "Amount Paid")}
        ${greeting(d.name)}
        ${card(`
          ${infoRow("Reference", esc(d.ref || ""))}
          ${infoRow("Method", esc(d.method || "M-Pesa"))}
          ${infoRow("Date", esc(d.date || ""))}
        `)}
      `,
    }),
  },

  "payment-failed": {
    subject:  d => `Payment failed — action required`,
    from:     FROM.payments,
    category: "payment",
    html: d => base({
      title: "Payment Failed", ctaColor: "#F59E0B",
      preheader: "Your payment could not be processed",
      cta: "Try Again", ctaUrl: `${BASE_URL}/checkout.html`,
      body: `
        ${alertBanner(`We were unable to process your payment of <strong>${fmt(d.amount)}</strong>.`, "warning")}
        ${greeting(d.name)}
        ${d.reason ? card(`
          <p style="margin:0 0 4px;padding-top:12px;font-family:Arial,Helvetica,sans-serif;font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#9CA3AF;">Reason</p>
          ${infoRow("", esc(d.reason))}
        `) : ""}
        ${note(`Please check your M-Pesa balance and try again. Need help? <a href="${SUPPORT_URL}" style="color:#16a34a;">Contact support</a>.`)}
      `,
    }),
  },

  "seller-payout": {
    subject:  d => `Payout of ${fmt(d.amount)} sent to ${d.phone}`,
    from:     FROM.payments,
    category: "payment",
    html: d => base({
      title: "Payout Sent",
      preheader: `${fmt(d.amount)} has been sent to your M-Pesa`,
      body: `
        ${metricCard(fmt(d.amount), "Payout Sent")}
        ${greeting(d.name)}
        ${card(`
          ${infoRow("Sent To", esc(d.phone || ""))}
          ${infoRow("M-Pesa Ref", esc(d.mpesaRef || "Processing"))}
          ${infoRow("Date", esc(d.date || ""))}
        `)}
        ${note(`View your earnings history in the <a href="${BASE_URL}/seller-revenue.html" style="color:#16a34a;">Seller Dashboard</a>.`)}
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
        ${statusCard("✓", "Subscription Renewed", `Your ${d.plan} plan is active.`, "success")}
        ${greeting(d.name)}
        ${card(`
          ${infoRow("Plan", esc(d.plan || ""))}
          ${infoRow("Amount", fmt(d.amount), true)}
          ${infoRow("Next Renewal", esc(d.nextDate || ""))}
        `)}
      `,
    }),
  },

  "subscription-expiring": {
    subject:  d => `Your ${d.plan} subscription expires in ${d.days} days`,
    from:     FROM.billing,
    category: "payment",
    html: d => base({
      title: "Subscription Expiring Soon", ctaColor: "#F59E0B",
      preheader: `Renew your ${d.plan} plan before it expires`,
      cta: "Renew Now", ctaUrl: `${BASE_URL}/subscriptions.html`,
      body: `
        ${alertBanner(`Your <strong>${esc(d.plan)}</strong> subscription expires on <strong>${esc(d.expiryDate || "")}</strong>. Renew to keep your features active.`, "warning")}
        ${greeting(d.name)}
      `,
    }),
  },

  /* ─── DISPUTES ─────────────────────────────────────────── */

  "dispute-opened": {
    subject:  d => `Dispute opened — Order #${d.orderId}`,
    from:     FROM.disputes,
    category: "order",
    html: d => base({
      title: "Dispute Opened",
      preheader: "A dispute has been opened. Our team will review it within 24–48 hours.",
      cta: "View Dispute", ctaUrl: `${BASE_URL}/dispute.html?id=${esc(d.disputeId)}`,
      body: `
        ${greeting(d.name)}
        ${p(`A dispute has been opened for order <strong>#${esc(d.orderId)}</strong>. Our team will review it within <strong>24–48 hours</strong>.`)}
        ${card(`
          ${infoRow("Dispute ID", `#${esc(d.disputeId || "")}`)}
          ${infoRow("Order", `#${esc(d.orderId || "")}`)}
          ${infoRow("Reason", esc(d.reason || ""))}
          ${infoRow("Status", "Under Review")}
        `)}
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
        ${statusCard("✓", "Dispute Resolved", "", "success")}
        ${greeting(d.name)}
        ${p(`Your dispute for order <strong>#${esc(d.orderId)}</strong> has been resolved.`)}
        ${card(`
          ${infoRow("Resolution", esc(d.resolution || ""), true)}
          ${d.refundAmount ? infoRow("Refund", fmt(d.refundAmount)) : ""}
        `)}
      `,
    }),
  },

  /* ─── DELIVERY ─────────────────────────────────────────── */

  "delivery-dispatched": {
    subject:  d => `Your order #${d.orderId} has been dispatched`,
    from:     FROM.delivery,
    category: "delivery",
    html: d => base({
      title: "Order Dispatched",
      preheader: "Your order has left the warehouse",
      cta: "Track My Delivery", ctaUrl: `${BASE_URL}/delivery-tracking.html?id=${esc(d.deliveryId)}`,
      body: `
        ${statusCard("📦", "Order Dispatched", "Your order is being prepared for delivery.", "info")}
        ${greeting(d.name)}
        ${card(`
          ${infoRow("Order", `#${esc(d.orderId || "")}`)}
          ${infoRow("Delivery ID", esc(d.deliveryId || ""))}
          ${d.eta ? infoRow("Estimated Delivery", esc(d.eta), true) : ""}
        `)}
        ${trackingSteps(["Order Placed","Confirmed","Dispatched","Driver Assigned","On the Way","Delivered"], 2)}
      `,
    }),
  },

  "driver-assigned": {
    subject:  d => `Driver assigned — Order #${d.orderId}`,
    from:     FROM.delivery,
    category: "delivery",
    html: d => base({
      title: "Driver Assigned",
      preheader: `${d.driverName} will deliver your order`,
      cta: "Track Live", ctaUrl: `${BASE_URL}/delivery-tracking.html?id=${esc(d.deliveryId)}`,
      body: `
        ${greeting(d.name)}
        ${p("A driver has been assigned to deliver your order.")}
        ${card(`
          ${infoRow("Driver", esc(d.driverName || ""), true)}
          ${d.driverPhone ? infoRow("Phone", esc(d.driverPhone)) : ""}
          ${infoRow("Vehicle", esc(d.vehicle || "Motorcycle"))}
          ${d.plate ? infoRow("Plate", esc(d.plate)) : ""}
          ${d.eta   ? infoRow("ETA", esc(d.eta), true) : ""}
        `)}
      `,
    }),
  },

  "driver-on-way": {
    subject:  d => `${d.driverName} is on the way`,
    from:     FROM.tracking,
    category: "delivery",
    html: d => base({
      title: "Driver On The Way",
      preheader: `Your driver is heading to you — ETA ${d.eta}`,
      cta: "Track Live", ctaUrl: `${BASE_URL}/delivery-tracking.html?id=${esc(d.deliveryId)}`,
      body: `
        ${statusCard("🛵", "Driver On The Way", `ETA: ${d.eta || "Shortly"}`, "brand")}
        ${greeting(d.name)}
        ${card(`
          ${infoRow("Estimated Arrival", esc(d.eta || ""), true)}
          ${infoRow("Driver", esc(d.driverName || ""))}
          ${d.driverPhone ? infoRow("Driver Phone", esc(d.driverPhone)) : ""}
          ${infoRow("Delivering To", esc(d.address || "Your location"))}
        `)}
        ${trackingSteps(["Dispatched","Driver Assigned","On the Way","Nearby","Delivered"], 2)}
      `,
    }),
  },

  "eta-update": {
    subject:  d => `Delivery update — Order #${d.orderId}`,
    from:     FROM.tracking,
    category: "delivery",
    html: d => base({
      title: "Delivery Update",
      preheader: `Updated delivery time for your order`,
      cta: "Track My Delivery", ctaUrl: `${BASE_URL}/delivery-tracking.html?id=${esc(d.deliveryId)}`,
      body: `
        ${greeting(d.name)}
        ${p(`We have an updated delivery estimate for order <strong>#${esc(d.orderId)}</strong>.`)}
        ${card(`
          ${infoRow("New ETA", esc(d.eta || ""), true)}
          ${d.reason ? infoRow("Note", esc(d.reason)) : ""}
        `)}
      `,
    }),
  },

  "delivery-delayed": {
    subject:  d => `Delivery delay — Order #${d.orderId}`,
    from:     FROM.delivery,
    category: "delivery",
    html: d => base({
      title: "Delivery Delayed", ctaColor: "#F59E0B",
      preheader: "Your delivery is running slightly late",
      cta: "Track My Delivery", ctaUrl: `${BASE_URL}/delivery-tracking.html?id=${esc(d.deliveryId)}`,
      body: `
        ${alertBanner(`Your delivery for order <strong>#${esc(d.orderId)}</strong> is running late. We apologise for the inconvenience.`, "warning")}
        ${greeting(d.name)}
        ${card(`
          ${infoRow("New Estimated Arrival", esc(d.newEta || ""), true)}
          ${d.reason ? infoRow("Reason", esc(d.reason)) : ""}
        `)}
        ${note(`Questions? <a href="${SUPPORT_URL}" style="color:#16a34a;">Contact support</a>.`)}
      `,
    }),
  },

  "delivery-failed": {
    subject:  d => `Delivery attempt failed — Order #${d.orderId}`,
    from:     FROM.delivery,
    category: "delivery",
    html: d => base({
      title: "Delivery Attempt Failed", ctaColor: "#EF4444",
      preheader: "We were unable to complete your delivery",
      cta: "Reschedule Delivery", ctaUrl: SUPPORT_URL,
      body: `
        ${alertBanner(`We were unable to complete the delivery for order <strong>#${esc(d.orderId)}</strong>.`, "error")}
        ${greeting(d.name)}
        ${card(`
          ${infoRow("Reason", esc(d.reason || "Customer not available"))}
          ${infoRow("Attempted", esc(d.attemptedAt || ""))}
        `)}
        ${note("Please contact us to reschedule your delivery or arrange a pickup.")}
      `,
    }),
  },

  "driver-nearby": {
    subject:  d => `Your driver is nearby`,
    from:     FROM.tracking,
    category: "delivery",
    html: d => base({
      title: "Driver Nearby",
      preheader: "Your delivery is almost here — please be ready!",
      cta: "View Live Location", ctaUrl: `${BASE_URL}/delivery-tracking.html?id=${esc(d.deliveryId)}`,
      body: `
        ${statusCard("📍", "Driver Nearby", `${d.driverName} is ${d.distance || "a few minutes"} away.`, "brand")}
        ${greeting(d.name)}
        ${note("Please be ready to receive your delivery.")}
      `,
    }),
  },

  "live-tracking-link": {
    subject:  d => `Track your delivery live — Order #${d.orderId}`,
    from:     FROM.tracking,
    category: "delivery",
    html: d => base({
      title: "Live Tracking",
      preheader: "Follow your delivery in real-time",
      cta: "Track Live", ctaUrl: `${BASE_URL}/delivery-tracking.html?id=${esc(d.deliveryId)}`,
      body: `
        ${greeting(d.name)}
        ${p("You can now follow your delivery in real-time on SOKONI.")}
        ${card(`
          ${infoRow("Order", `#${esc(d.orderId || "")}`)}
          ${infoRow("Driver", esc(d.driverName || ""))}
          ${d.eta ? infoRow("ETA", esc(d.eta), true) : ""}
        `)}
      `,
    }),
  },

  /* ─── DISPATCH (operators & admin) ────────────────────── */

  "driver-new-job": {
    subject:  d => `New delivery job — Order #${d.orderId}`,
    from:     FROM.dispatch,
    category: "dispatch",
    html: d => base({
      title: "New Job Available",
      preheader: `New delivery job in ${d.pickup}`,
      cta: "Accept Job", ctaUrl: `${BASE_URL}/driver.html`,
      body: `
        ${statusCard("🚀", "New Job Available", `Pickup: ${d.pickup || ""}`, "brand")}
        ${greeting(d.driverName)}
        ${card(`
          ${infoRow("Order", `#${esc(d.orderId || "")}`)}
          ${infoRow("Pickup", esc(d.pickup || ""))}
          ${infoRow("Dropoff", esc(d.dropoff || ""))}
          ${infoRow("Distance", esc(d.distance || "TBD"))}
          ${infoRow("Earnings", fmt(d.earnings), true)}
        `)}
        ${note("Open your driver app to accept this job.")}
      `,
    }),
  },

  "dispatch-unassigned-alert": {
    subject:  d => `Unassigned delivery — Order #${d.orderId}`,
    from:     FROM.dispatch,
    category: "dispatch",
    html: d => base({
      title: "Unassigned Delivery Alert", ctaColor: "#F59E0B",
      preheader: `Order #${d.orderId} has no driver — action required`,
      cta: "Assign Driver", ctaUrl: `${BASE_URL}/admin.html`,
      body: `
        ${alertBanner(`Order <strong>#${esc(d.orderId)}</strong> has been waiting for a driver for over <strong>${esc(d.waitTime || "30 minutes")}</strong>.`, "warning")}
        ${card(`
          ${infoRow("Order ID", `#${esc(d.orderId || "")}`)}
          ${infoRow("Customer", esc(d.customerName || ""))}
          ${infoRow("Pickup", esc(d.pickup || ""))}
          ${infoRow("Dropoff", esc(d.dropoff || ""))}
          ${infoRow("Waiting Since", esc(d.waitingSince || ""))}
        `)}
      `,
    }),
  },

  "dispatch-overdue": {
    subject:  d => `Overdue delivery — Order #${d.orderId} needs escalation`,
    from:     FROM.dispatch,
    category: "dispatch",
    html: d => base({
      title: "Overdue Delivery — Escalation Required", ctaColor: "#EF4444",
      preheader: `Delivery for order #${d.orderId} is overdue by ${d.overdueBy}`,
      cta: "Escalate Now", ctaUrl: `${BASE_URL}/admin.html`,
      body: `
        ${alertBanner(`Delivery for order <strong>#${esc(d.orderId)}</strong> is overdue by <strong>${esc(d.overdueBy || "")}</strong>.`, "error")}
        ${card(`
          ${infoRow("Order", `#${esc(d.orderId || "")}`)}
          ${infoRow("Driver", esc(d.driverName || "Not Assigned"))}
          ${infoRow("Customer", esc(d.customerName || ""))}
          ${infoRow("Original ETA", esc(d.originalEta || ""))}
        `)}
      `,
    }),
  },

  /* ─── DRIVERS ──────────────────────────────────────────── */

  "driver-welcome": {
    subject:  d => `Welcome to SOKONI Drivers`,
    from:     FROM.drivers,
    category: "account",
    html: d => base({
      title: "Driver Application Received",
      preheader: "Your driver application is under review",
      cta: "View Driver Dashboard", ctaUrl: `${BASE_URL}/driver.html`,
      body: `
        ${statusCard("🚴", "Application Received", "We'll notify you once it's approved.", "info")}
        ${greeting(d.name)}
        ${card(`
          <p style="margin:0 0 4px;padding-top:12px;font-family:Arial,Helvetica,sans-serif;font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#9CA3AF;">Next steps</p>
          ${infoRow("1", "Complete your profile and upload documents")}
          ${infoRow("2", "Wait for verification (24–48 hours)")}
          ${infoRow("3", "Start earning once approved")}
        `)}
      `,
    }),
  },

  "driver-approved": {
    subject:  d => `Your SOKONI driver account is approved`,
    from:     FROM.drivers,
    category: "account",
    html: d => base({
      title: "Driver Account Approved",
      preheader: "You are now verified to drive with SOKONI",
      cta: "Start Earning", ctaUrl: `${BASE_URL}/driver.html`,
      body: `
        ${statusCard("✓", "Driver Account Approved", "Go online and start accepting jobs.", "success")}
        ${greeting(d.name)}
        ${card(`
          ${d.driverId ? infoRow("Driver ID", esc(d.driverId)) : ""}
          ${infoRow("Vehicle", esc(d.vehicle || ""))}
          ${infoRow("Zone", esc(d.zone || "All Nairobi"))}
          ${infoRow("Status", "Active")}
        `)}
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
        ${p("We are unable to approve your driver application at this time.")}
        ${d.reason ? card(`
          <p style="margin:0 0 4px;padding-top:12px;font-family:Arial,Helvetica,sans-serif;font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#9CA3AF;">Reason</p>
          ${infoRow("", esc(d.reason))}
        `) : ""}
        ${note("Please update your documents and reapply.")}
      `,
    }),
  },

  "driver-doc-expiry": {
    subject:  d => `Your ${d.docName} expires in ${d.days} days`,
    from:     FROM.drivers,
    category: "account",
    html: d => base({
      title: "Document Expiry Reminder", ctaColor: "#F59E0B",
      preheader: `${d.docName} expires in ${d.days} days — update it now`,
      cta: "Update Documents", ctaUrl: `${BASE_URL}/driver.html#documents`,
      body: `
        ${alertBanner(`Your <strong>${esc(d.docName)}</strong> expires on <strong>${esc(d.expiryDate || "")}</strong>. Please update it to keep your account active.`, "warning")}
        ${greeting(d.name)}
        ${card(`
          ${infoRow("Document", esc(d.docName || ""))}
          ${infoRow("Expiry Date", esc(d.expiryDate || ""))}
          ${infoRow("Days Remaining", esc(String(d.days || 0)))}
        `)}
      `,
    }),
  },

  "driver-earnings": {
    subject:  d => `Your earnings — ${fmt(d.amount)}`,
    from:     FROM.drivers,
    category: "payment",
    html: d => base({
      title: "Earnings Summary",
      preheader: `${fmt(d.amount)} earned this ${d.period || "week"}`,
      cta: "View Earnings", ctaUrl: `${BASE_URL}/driver.html#earnings`,
      body: `
        ${metricCard(fmt(d.amount), `Earned this ${d.period || "week"}`)}
        ${greeting(d.name)}
        ${card(`
          ${infoRow("Deliveries", esc(String(d.deliveries || 0)))}
          ${infoRow("Average Per Trip", fmt(d.avgPerTrip || 0))}
          ${infoRow("Payout Date", esc(d.payoutDate || "Next Friday"))}
        `)}
      `,
    }),
  },

  "driver-performance": {
    subject:  d => `Driver performance update`,
    from:     FROM.drivers,
    category: "account",
    html: d => base({
      title: "Performance Update", ctaColor: d.positive ? "#71ff00" : "#F59E0B",
      preheader: d.positive ? "Great performance this period — keep it up!" : "Action needed to maintain your driver status",
      cta: "View Dashboard", ctaUrl: `${BASE_URL}/driver.html`,
      body: `
        ${greeting(d.name)}
        ${p(esc(d.message || "Here is your performance update."))}
        ${card(`
          ${infoRow("Rating", esc(String(d.rating || 0) + " / 5.0"), !!d.positive)}
          ${infoRow("Completion Rate", esc(String(d.completionRate || 0) + "%"))}
          ${infoRow("On-Time Rate", esc(String(d.onTimeRate || 0) + "%"))}
        `)}
      `,
    }),
  },

  /* ─── EVENTS & TICKETS ─────────────────────────────────── */

  "ticket-purchase": {
    subject:  d => `Your ticket for ${d.eventName}`,
    from:     FROM.tickets,
    category: "order",
    html: d => base({
      title: "Ticket Confirmed",
      preheader: `Your ticket for ${d.eventName} is confirmed — see you there!`,
      cta: "View My Ticket", ctaUrl: `${BASE_URL}/entertainment.html?ticket=${esc(d.ticketId)}`,
      body: `
        ${statusCard("🎟", "Ticket Confirmed", d.eventName, "success")}
        ${greeting(d.name)}
        ${card(`
          ${infoRow("Event", esc(d.eventName || ""), true)}
          ${infoRow("Date", esc(d.eventDate || ""))}
          ${infoRow("Venue", esc(d.venue || ""))}
          ${infoRow("Ticket Type", esc(d.ticketType || ""))}
          ${infoRow("Ticket ID", esc(d.ticketId || ""))}
          ${infoRow("Amount Paid", fmt(d.amount))}
        `)}
        ${d.qrCode ? `
          ${divider()}
          <p style="margin:0 0 8px;font-family:Arial,Helvetica,sans-serif;font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#9CA3AF;text-align:center;">Your Entry QR Code</p>
          <div style="text-align:center;padding:10px 0;">
            <img src="${esc(d.qrCode)}" alt="Entry QR Code" width="180" height="180"
              style="border-radius:12px;background:#ffffff;padding:12px;border:1px solid #E2E8F0;">
          </div>` : ""}
      `,
    }),
  },

  "event-reminder": {
    subject:  d => `Reminder: ${d.eventName} is ${d.daysUntil === 1 ? "tomorrow" : `in ${d.daysUntil} days`}`,
    from:     FROM.events,
    category: "marketing",
    html: d => base({
      title: "Event Reminder",
      preheader: `Don't forget — ${d.eventName} is coming up!`,
      cta: "View Event Details", ctaUrl: `${BASE_URL}/entertainment.html?event=${esc(d.eventId)}`,
      body: `
        ${greeting(d.name)}
        ${p(`Just a reminder that <strong>${esc(d.eventName)}</strong> is coming up soon.`)}
        ${card(`
          ${infoRow("Event", esc(d.eventName || ""), true)}
          ${infoRow("Date", esc(d.eventDate || ""))}
          ${infoRow("Venue", esc(d.venue || ""))}
          ${infoRow("Your Ticket", esc(d.ticketType || ""))}
        `)}
      `,
    }),
  },

  /* ─── PROPERTY ─────────────────────────────────────────── */

  "property-enquiry": {
    subject:  d => `New enquiry for ${d.propertyTitle}`,
    from:     FROM.property,
    category: "order",
    html: d => base({
      title: "New Property Enquiry",
      preheader: `Someone enquired about ${d.propertyTitle}`,
      cta: "View Enquiry", ctaUrl: `${BASE_URL}/landlord.html`,
      body: `
        ${greeting(d.name)}
        ${p(`You have a new enquiry for <strong>${esc(d.propertyTitle)}</strong>.`)}
        ${card(`
          ${infoRow("From", esc(d.enquirerName || ""))}
          ${infoRow("Phone", esc(d.enquirerPhone || ""))}
          ${d.message ? infoRow("Message", esc(d.message)) : ""}
        `)}
      `,
    }),
  },

  "booking-confirmation": {
    subject:  d => `Booking confirmed — ${d.bookingTitle}`,
    from:     FROM.property,
    category: "order",
    html: d => base({
      title: "Booking Confirmed",
      preheader: "Your booking is confirmed",
      cta: "View Booking", ctaUrl: `${BASE_URL}/profile.html#bookings`,
      body: `
        ${statusCard("✓", "Booking Confirmed", d.bookingTitle, "success")}
        ${greeting(d.name)}
        ${card(`
          ${d.checkIn  ? infoRow("Check In", esc(d.checkIn))  : ""}
          ${d.checkOut ? infoRow("Check Out", esc(d.checkOut)) : ""}
          ${infoRow("Booking Ref", esc(d.ref || ""))}
          ${infoRow("Total", fmt(d.total), true)}
        `)}
      `,
    }),
  },

  /* ─── HEALTHCARE ───────────────────────────────────────── */

  "appointment-confirmation": {
    subject:  d => `Appointment confirmed with ${d.providerName}`,
    from:     FROM.health,
    category: "order",
    html: d => base({
      title: "Appointment Confirmed",
      preheader: `Your appointment with ${d.providerName} is confirmed`,
      cta: "View Appointment", ctaUrl: `${BASE_URL}/healthcare.html`,
      body: `
        ${statusCard("✓", "Appointment Confirmed", d.providerName, "success")}
        ${greeting(d.name)}
        ${card(`
          ${infoRow("Provider", esc(d.providerName || ""), true)}
          ${infoRow("Date", esc(d.date || ""))}
          ${infoRow("Time", esc(d.time || ""))}
          ${d.location ? infoRow("Location", esc(d.location)) : ""}
          ${d.type     ? infoRow("Type", esc(d.type)) : ""}
        `)}
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
        ${p(`You have an appointment <strong>${esc(d.when)}</strong>.`)}
        ${card(`
          ${infoRow("Provider", esc(d.providerName || ""))}
          ${infoRow("Date", esc(d.date || ""), true)}
          ${infoRow("Time", esc(d.time || ""))}
          ${d.location ? infoRow("Location", esc(d.location)) : ""}
        `)}
      `,
    }),
  },

  /* ─── LEGAL ────────────────────────────────────────────── */

  "legal-consultation": {
    subject:  d => `Legal consultation confirmed — ${d.lawyerName}`,
    from:     FROM.law,
    category: "order",
    html: d => base({
      title: "Legal Consultation Confirmed",
      preheader: `Consultation with ${d.lawyerName} confirmed`,
      cta: "View Details", ctaUrl: `${BASE_URL}/legal-hub.html`,
      body: `
        ${statusCard("⚖", "Consultation Confirmed", d.lawyerName, "info")}
        ${greeting(d.name)}
        ${card(`
          ${infoRow("Lawyer", esc(d.lawyerName || ""), true)}
          ${infoRow("Specialty", esc(d.specialty || ""))}
          ${infoRow("Date", esc(d.date || ""))}
          ${infoRow("Time", esc(d.time || ""))}
          ${infoRow("Fee", fmt(d.fee))}
        `)}
      `,
    }),
  },

  /* ─── MARKETING ────────────────────────────────────────── */

  "price-drop": {
    subject:  d => `Price drop: ${d.productName} — now ${fmt(d.newPrice)}`,
    from:     FROM.marketing,
    category: "marketing",
    html: d => base({
      title: "Price Drop",
      preheader: `${d.productName} just dropped in price!`,
      cta: "Shop Now", ctaUrl: `${BASE_URL}/product.html?id=${esc(d.productId)}`,
      body: `
        ${greeting(d.name)}
        ${p("Good news — a product you saved just dropped in price.")}
        ${card(`
          ${infoRow("Product", esc(d.productName || ""), true)}
          ${infoRow("Was", fmt(d.oldPrice))}
          ${infoRow("Now", fmt(d.newPrice), true)}
          ${infoRow("You Save", fmt((d.oldPrice || 0) - (d.newPrice || 0)))}
        `)}
      `,
    }),
  },

  "back-in-stock": {
    subject:  d => `${d.productName} is back in stock`,
    from:     FROM.marketing,
    category: "marketing",
    html: d => base({
      title: "Back in Stock",
      preheader: `${d.productName} is available again`,
      cta: "Buy Now", ctaUrl: `${BASE_URL}/product.html?id=${esc(d.productId)}`,
      body: `
        ${statusCard("✓", "Back in Stock", d.productName, "success")}
        ${greeting(d.name)}
        ${p(`<strong>${esc(d.productName)}</strong> that you saved to your wishlist is back. Quantities are limited.`)}
      `,
    }),
  },

  "review-request": {
    subject:  d => `How was your experience?`,
    from:     FROM.orders,
    category: "marketing",
    html: d => base({
      title: "How was your experience?",
      preheader: "Share your feedback and help other shoppers",
      cta: "Leave a Review", ctaUrl: `${BASE_URL}/reviews.html?order=${esc(d.orderId)}`,
      body: `
        ${greeting(d.name)}
        ${p("We hope you loved your purchase. Your review helps other shoppers and rewards great sellers.")}
        ${card(`
          ${infoRow("Product", esc(d.productName || ""))}
          ${infoRow("Order", `#${esc(d.orderId || "")}`)}
        `)}
      `,
    }),
  },

  "referral-reward": {
    subject:  d => `You earned a referral bonus — ${fmt(d.amount)}`,
    from:     FROM.marketing,
    category: "marketing",
    html: d => base({
      title: "Referral Bonus",
      preheader: `${fmt(d.amount)} added to your SOKONI wallet`,
      cta: "View My Wallet", ctaUrl: `${BASE_URL}/wallet.html`,
      body: `
        ${metricCard(fmt(d.amount), "Referral Bonus")}
        ${greeting(d.name)}
        ${p(`<strong>${esc(d.referredName)}</strong> joined SOKONI using your referral link.`)}
        ${card(`
          ${infoRow("Bonus Amount", fmt(d.amount), true)}
          ${infoRow("Referred", esc(d.referredName || ""))}
          ${infoRow("Added To", "SOKONI Wallet")}
        `)}
      `,
    }),
  },

  /* ─── ADMIN & SECURITY (internal emails) ───────────────── */

  "security-alert": {
    subject:  d => `SOKONI Security Alert — ${d.alertType}`,
    from:     FROM.security,
    category: "security",
    html: d => base({
      title: `Security Alert: ${d.alertType}`, ctaColor: "#EF4444",
      preheader: `Security event detected: ${d.alertType}`,
      cta: "Review Alert", ctaUrl: `${BASE_URL}/admin.html`,
      body: `
        ${alertBanner(esc(d.alertType), "error")}
        ${card(`
          ${infoRow("Time", esc(d.time || "Just now"))}
          ${infoRow("Details", esc(d.details || ""))}
          ${d.ip  ? infoRow("IP Address", esc(d.ip)) : ""}
          ${d.uid ? infoRow("User", esc(d.uid)) : ""}
        `)}
      `,
    }),
  },

  "fraud-alert": {
    subject:  d => `Fraud Alert — ${d.fraudType}`,
    from:     FROM.security,
    category: "security",
    html: d => base({
      title: `Fraud Alert: ${d.fraudType}`, ctaColor: "#EF4444",
      preheader: `Fraud detection triggered: ${d.fraudType}`,
      cta: "Review in Admin", ctaUrl: `${BASE_URL}/admin.html`,
      body: `
        ${alertBanner(`Fraud Detection: ${esc(d.fraudType)}`, "error")}
        ${card(`
          ${infoRow("Risk Score", esc(String(d.riskScore || 0) + "/100"))}
          ${infoRow("User", esc(d.uid || "Unknown"))}
          ${infoRow("Amount", fmt(d.amount))}
          ${infoRow("Status", esc(d.status || "Flagged"))}
        `)}
      `,
    }),
  },

  "maintenance-notice": {
    subject:  d => `SOKONI Scheduled Maintenance — ${d.date}`,
    from:     FROM.tech,
    category: "system",
    html: d => base({
      title: "Scheduled Maintenance",
      preheader: `SOKONI will be briefly unavailable on ${d.date}`,
      body: `
        ${greeting(d.name || "SOKONI User")}
        ${p(`We will be performing scheduled maintenance on <strong>${esc(d.date)}</strong> at <strong>${esc(d.time)}</strong>. The platform will be unavailable for approximately <strong>${esc(d.duration)}</strong>.`)}
        ${note("We apologise for any inconvenience. Thank you for using SOKONI.")}
      `,
    }),
  },

};

/* ═══════════════════════════════════════════════════════════
   RENDER  getTemplate(name, data) → { subject, html, text, from, category }
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
