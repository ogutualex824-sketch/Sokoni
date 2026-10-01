/* ============================================================================
   SOKONI — one-click unsubscribe from marketing email (RFC 8058) — 2026-10-01
   ----------------------------------------------------------------------------
   WHY (census 2026-10-01): the marketing footer linked to /profile.html#email-preferences, a
   section that does not exist; List-Unsubscribe was a mailto paired with a One-Click Post header
   (RFC 8058 requires an HTTPS URI); no unsubscribe endpoint existed.

   emailUnsubscribe  (onRequest, public — mail clients call it without signing in)
     GET  ?u=<uid>&t=<token>  → a confirmation page with one button (a GET must NOT unsubscribe:
                                link scanners and previews fetch URLs)
     POST ?u=<uid>&t=<token>  → unsubscribes (RFC 8058 one-click POST, or the button)
   The token is a per-user random value stored at emailPreferences/{uid}.unsubToken (created by
   email-service on the first marketing send); comparison is constant-time. Unsubscribing sets
   marketing + newsletter OFF in emailPreferences and promotions OFF on every channel in
   notifyPrefs. Service mail (orders, payments, security, account) is not affected.
   ============================================================================ */
'use strict';

const crypto = require('crypto');
const { onRequest } = require('firebase-functions/v2/https');
const logger = require('firebase-functions/logger');
const admin = require('firebase-admin');
if (!admin.apps.length) admin.initializeApp();
const db = () => admin.firestore();

const UID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{32,64}$/;
const SITE = 'https://mysokoni.co.ke';

function _page(status, title, body) {
  return { status, html: `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${title} — SOKONI</title>
<style>body{font-family:system-ui,Arial,sans-serif;background:#f6f7f6;color:#111;margin:0;padding:24px 16px}main{max-width:480px;margin:auto;background:#fff;border-radius:12px;padding:24px}h1{font-size:1.25rem;margin:0 0 12px}p{line-height:1.6}button{min-height:44px;padding:10px 18px;border:0;border-radius:8px;background:#1a8a00;color:#fff;font-weight:700;font-size:1rem;cursor:pointer}a{color:#1a6a00}</style></head>
<body><main><h1>${title}</h1>${body}<p style="color:#555;font-size:12px;margin-top:20px">SOKONI · Bravilex International Co. Limited · Nairobi, Kenya</p></main></body></html>` };
}
function _esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function _eq(a, b) { const A = Buffer.from(String(a)), B = Buffer.from(String(b)); return A.length === B.length && crypto.timingSafeEqual(A, B); }

async function _verify(uid, token) {
  if (!UID_RE.test(uid || '') || !TOKEN_RE.test(token || '')) return false;
  const snap = await db().collection('emailPreferences').doc(uid).get();
  const stored = snap.exists ? (snap.data() || {}).unsubToken : null;
  return !!stored && _eq(stored, token);
}

async function handle(req) {
  const q = req.query || {};
  const uid = String(q.u || ''), token = String(q.t || '');
  const ok = await _verify(uid, token).catch((e) => { logger.error('[unsub] verify failed', { error: e.message }); return null; });
  if (ok === null) return _page(503, 'Please try again', '<p>We could not process this right now. Please try again in a few minutes.</p>');
  if (!ok) {
    logger.warn('[unsub] invalid link');
    return _page(400, 'Link not valid', `<p>This unsubscribe link is not valid or has been replaced by a newer one.</p><p>You can manage your email choices after signing in: <a href="${SITE}/email-preferences">${SITE}/email-preferences</a>.</p>`);
  }
  if (req.method !== 'POST') {
    const action = `?u=${encodeURIComponent(uid)}&t=${encodeURIComponent(token)}`;
    return _page(200, 'Unsubscribe from SOKONI offers?', `<p>Press the button to stop marketing emails and promotional notifications from SOKONI. Order, payment and security messages will continue.</p><form method="post" action="${_esc(action)}"><button type="submit">Unsubscribe</button></form>`);
  }
  const now = admin.firestore.FieldValue.serverTimestamp();
  await db().collection('emailPreferences').doc(uid).set({ marketing: false, newsletter: false, unsubscribedAt: now, unsubscribeSource: 'one-click', updatedAt: now }, { merge: true });
  await db().collection('notifyPrefs').doc(uid).set({ promotions: { email: false, sms: false, push: false } }, { merge: true }).catch((e) => logger.error('[unsub] notifyPrefs write failed', { uid, error: e.message }));
  logger.info('[unsub] marketing unsubscribed', { uid });
  return _page(200, 'You are unsubscribed', `<p>You will no longer receive marketing emails or promotional notifications from SOKONI.</p><p>Order, payment and security messages continue. Changed your mind? <a href="${SITE}/email-preferences">Manage your email choices</a>.</p>`);
}

exports.emailUnsubscribe = onRequest({ region: 'us-central1', invoker: 'public', maxInstances: 5, memory: '256MiB', timeoutSeconds: 15 }, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.set('X-Robots-Tag', 'noindex');
  res.set('Referrer-Policy', 'no-referrer');
  res.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'");
  if (req.method !== 'GET' && req.method !== 'POST') { res.status(405).send('Method not allowed'); return; }
  const out = await handle(req);
  res.status(out.status).type('html').send(out.html);
});

exports._internal = { handle, _verify };
