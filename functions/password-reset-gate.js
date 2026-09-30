/* ============================================================================
   SOKONI — password reset with a 25-minute, single-use, server-hashed link
   ----------------------------------------------------------------------------
   Owner requirement (2026-10-01): a password-reset link must stop working 25 minutes after it
   is issued. Firebase's own reset action codes last a fixed hour and their lifetime is not
   configurable, so the lifetime is enforced HERE, by SOKONI:

     authRequestPasswordReset({ email })
       · App Check + durable, fail-CLOSED rate limits (per email, per client, global)
       · the SAME response whether or not an account exists (no enumeration)
       · 32 random bytes → base64url token; ONLY its SHA-256 is stored
         passwordResetTokens/{sha256}  { uid, issuedAt, expiresAt = issuedAt + 25 min, usedAt }
         passwordResetState/{uid}      { latestHash }   ← issuing a new link revokes older ones
       · the link is emailed (category "security": never click-tracked, body never logged)

     authCompletePasswordReset({ token, newPassword })
       · one transaction: token exists, unused, unexpired, and still the user's latest → used
       · then updateUser(password) + revokeRefreshTokens (other sessions are signed out)
       · owner is notified; a securityEvents row is written; no plaintext email or token logged
       · every failure answers the same "invalid or expired" message (no oracle)

   Neither collection has a client rule: Firestore default-deny keeps both server-only.
   Residual (owner/config): Firebase's native sendOobCode can still mail a 1-hour link to the
   mailbox owner if called directly; closing it needs reCAPTCHA ENFORCE or a custom action
   handler that refuses mode=resetPassword. See docs/PASSWORD_RESET_25_MINUTES.md.
   ============================================================================ */
'use strict';

const crypto = require('crypto');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const logger = require('firebase-functions/logger');
const admin = require('firebase-admin');
const EmailService = require('./email-service');

if (!admin.apps.length) admin.initializeApp();

const TTL_MS = 25 * 60 * 1000;                 /* the owner's number — one constant, one place */
const TOKEN_BYTES = 32;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;       /* 32 bytes base64url, unpadded */
const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;
const SITE = 'https://mysokoni.co.ke';
const GENERIC_OK = 'If an account exists for that email, we have sent a reset link. It works once and expires in 25 minutes.';
const GENERIC_BAD = 'This reset link is invalid or has expired. Request a new one.';

/* Route-specific limits: [max, windowSeconds]. Rate state lives in Firestore so every instance
   shares it; any error in the limiter REFUSES the request (fail closed). */
const LIMITS = {
  requestEmail:  [3, 15 * 60],
  requestClient: [10, 15 * 60],
  requestGlobal: [300, 60 * 60],
  completeClient: [10, 15 * 60],
};

let _clock = () => Date.now();
const db = () => admin.firestore();
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

/* Client key: the RIGHT-MOST X-Forwarded-For entry is the address Google's front end saw;
   entries to its left are client-supplied and trivially spoofed. Falls back to req.ip. */
function _clientKey(rawRequest) {
  const h = rawRequest && rawRequest.headers ? rawRequest.headers['x-forwarded-for'] : '';
  const parts = String(h || '').split(',').map((s) => s.trim()).filter(Boolean);
  const ip = parts.length ? parts[parts.length - 1] : ((rawRequest && rawRequest.ip) || 'unknown');
  return sha256('ip|' + ip).slice(0, 32);      /* stored pseudonymised, never raw */
}

async function _limit(bucket, key) {
  const [max, windowSec] = LIMITS[bucket];
  const now = _clock();
  const ref = db().collection('passwordResetRate').doc(bucket + '_' + key);
  let res;
  try {
    res = await db().runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const d = snap.exists ? snap.data() : null;
      const start = d && typeof d.windowStartMs === 'number' && now - d.windowStartMs < windowSec * 1000 ? d.windowStartMs : now;
      const count = start === (d && d.windowStartMs) ? Number(d.count || 0) : 0;
      if (count >= max) return { ok: false, retryAfter: Math.ceil((start + windowSec * 1000 - now) / 1000) };
      tx.set(ref, { windowStartMs: start, count: count + 1, expiresAt: admin.firestore.Timestamp.fromMillis(start + windowSec * 1000 + 86400000) });
      return { ok: true };
    });
  } catch (e) {
    logger.error('[pwreset] limiter unavailable — refusing (fail closed)', { bucket, error: e.message });
    throw new HttpsError('unavailable', 'Password reset is temporarily unavailable. Please try again in a few minutes.', { code: 'RATE_LIMIT_UNAVAILABLE' });
  }
  if (!res.ok) {
    logger.warn('[pwreset] rate limited', { bucket, rateLimited: true });
    throw new HttpsError('resource-exhausted', 'Too many password reset attempts. Please wait and try again.', { code: 'RATE_LIMITED', retryAfterSeconds: Math.max(1, res.retryAfter) });
  }
}

function _esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

function _resetEmail(link) {
  const html = `<!doctype html><html><body style="font-family:Arial,sans-serif;background:#f6f7f6;padding:24px;color:#111">
<div style="max-width:520px;margin:auto;background:#fff;border-radius:12px;padding:24px">
<h2 style="margin:0 0 12px">Reset your SOKONI password</h2>
<p>We received a request to reset the password for your SOKONI account.</p>
<p><a href="${_esc(link)}" style="display:inline-block;background:#1a8a00;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:bold">Choose a new password</a></p>
<p><strong>This link works once and expires 25 minutes after it was sent.</strong> If it has expired, request a new one from the sign-in page.</p>
<p>If you did not ask for this, you can ignore this email — your password will not change.</p>
<p style="color:#555;font-size:12px">SOKONI · Bravilex International Co. Limited · Nairobi, Kenya</p>
</div></body></html>`;
  const text = `Reset your SOKONI password\n\nOpen this link to choose a new password (it works once and expires 25 minutes after it was sent):\n${link}\n\nIf you did not ask for this, ignore this email — your password will not change.\n\nSOKONI · Bravilex International Co. Limited`;
  return { html, text };
}

function _changedEmail() {
  const html = `<!doctype html><html><body style="font-family:Arial,sans-serif;background:#f6f7f6;padding:24px;color:#111">
<div style="max-width:520px;margin:auto;background:#fff;border-radius:12px;padding:24px">
<h2 style="margin:0 0 12px">Your SOKONI password was changed</h2>
<p>The password for your SOKONI account was just changed using a reset link, and your other sessions were signed out.</p>
<p>If this was not you, contact SOKONI support immediately at <a href="${SITE}/support.html">${SITE}/support.html</a>.</p>
<p style="color:#555;font-size:12px">SOKONI · Bravilex International Co. Limited · Nairobi, Kenya</p>
</div></body></html>`;
  return { html, text: 'Your SOKONI password was changed using a reset link, and your other sessions were signed out. If this was not you, contact SOKONI support immediately: ' + SITE + '/support.html' };
}

async function requestReset(data, rawRequest, deps = {}) {
  const auth = deps.auth || admin.auth();
  const send = deps.send || EmailService.send;
  const email = String((data && data.email) || '').trim().toLowerCase();
  if (!email || email.length > 254 || !EMAIL_RE.test(email)) {
    throw new HttpsError('invalid-argument', 'Enter a valid email address.', { code: 'VALIDATION_FAILED' });
  }
  const emailKey = sha256('email|' + email).slice(0, 32);
  await _limit('requestGlobal', 'all');
  await _limit('requestClient', _clientKey(rawRequest));
  await _limit('requestEmail', emailKey);

  /* The token is generated and hashed on every request, whether or not the account exists,
     so both paths do the same work before answering. */
  const token = crypto.randomBytes(TOKEN_BYTES).toString('base64url');
  const hash = sha256(token);

  let user = null;
  try { user = await auth.getUserByEmail(email); }
  catch (e) { if (e && e.code !== 'auth/user-not-found') logger.error('[pwreset] lookup failed', { error: e.message }); }

  if (!user || user.disabled) {
    logger.info('[pwreset] request — no eligible account (uniform response)', { emailKey });
    return { ok: true, message: GENERIC_OK };
  }

  const now = _clock();
  const batch = db().batch();
  batch.set(db().collection('passwordResetTokens').doc(hash), {
    uid: user.uid,
    issuedAt: admin.firestore.Timestamp.fromMillis(now),
    expiresAt: admin.firestore.Timestamp.fromMillis(now + TTL_MS),
    ttlAt: admin.firestore.Timestamp.fromMillis(now + TTL_MS + 86400000),
    usedAt: null,
  });
  batch.set(db().collection('passwordResetState').doc(user.uid), {
    latestHash: hash, issuedAt: admin.firestore.Timestamp.fromMillis(now),
  });
  await batch.commit();

  const link = `${SITE}/reset-password?t=${token}`;
  const { html, text } = _resetEmail(link);
  try {
    await send({ to: email, subject: 'Reset your SOKONI password', html, text, category: 'security', uid: user.uid, template: 'password-reset-25m' });
  } catch (e) {
    logger.error('[pwreset] reset email failed', { uid: user.uid, error: e.message });
  }
  await db().collection('securityEvents').add({
    type: 'password_reset_requested', uid: user.uid, createdAt: admin.firestore.FieldValue.serverTimestamp(),
  }).catch(() => {});
  return { ok: true, message: GENERIC_OK };
}

function _passwordProblem(pw) {
  if (typeof pw !== 'string') return 'Enter a new password.';
  if (pw.length < 8) return 'Use at least 8 characters.';
  if (pw.length > 128) return 'Use at most 128 characters.';
  if (!/[A-Za-z]/.test(pw) || !/[0-9]/.test(pw)) return 'Use at least one letter and one number.';
  return null;
}

async function completeReset(data, rawRequest, deps = {}) {
  const auth = deps.auth || admin.auth();
  const send = deps.send || EmailService.send;
  const token = String((data && data.token) || '');
  const pw = data ? data.newPassword : undefined;       /* never trimmed or "sanitised" */
  await _limit('completeClient', _clientKey(rawRequest));
  if (!TOKEN_RE.test(token)) { logger.warn('[pwreset] complete refused', { reason: 'malformed' }); throw new HttpsError('failed-precondition', GENERIC_BAD, { code: 'RESET_LINK_INVALID' }); }
  const problem = _passwordProblem(pw);
  if (problem) throw new HttpsError('invalid-argument', problem, { code: 'VALIDATION_FAILED' });

  const hash = sha256(token);
  const tRef = db().collection('passwordResetTokens').doc(hash);
  const now = _clock();
  let uid = null, reason = null;
  await db().runTransaction(async (tx) => {
    const t = await tx.get(tRef);
    if (!t.exists) { reason = 'unknown'; return; }
    const d = t.data();
    const sRef = db().collection('passwordResetState').doc(d.uid);
    const s = await tx.get(sRef);
    if (d.usedAt) { reason = 'used'; return; }
    if (!d.expiresAt || now >= d.expiresAt.toMillis()) { reason = 'expired'; return; }
    if (!s.exists || s.data().latestHash !== hash) { reason = 'revoked'; return; }
    tx.update(tRef, { usedAt: admin.firestore.Timestamp.fromMillis(now) });
    tx.set(sRef, { latestHash: null, usedAt: admin.firestore.Timestamp.fromMillis(now) }, { merge: true });
    uid = d.uid;
  });
  if (!uid) {
    logger.warn('[pwreset] complete refused', { reason, tokenKey: hash.slice(0, 12) });
    throw new HttpsError('failed-precondition', GENERIC_BAD, { code: 'RESET_LINK_INVALID' });
  }

  try {
    await auth.updateUser(uid, { password: pw });
  } catch (e) {
    /* The link is not spent by a failure SOKONI caused: reopen it for another attempt. */
    await tRef.update({ usedAt: null }).catch(() => {});
    await db().collection('passwordResetState').doc(uid).set({ latestHash: hash }, { merge: true }).catch(() => {});
    const weak = e && /password/i.test(String(e.code || e.message));
    logger.error('[pwreset] updateUser failed', { uid, code: e && e.code });
    throw new HttpsError(weak ? 'invalid-argument' : 'internal', weak ? 'Choose a stronger password.' : 'Could not change the password. Please try again.', { code: weak ? 'VALIDATION_FAILED' : 'INTERNAL_ERROR' });
  }
  await auth.revokeRefreshTokens(uid).catch((e) => logger.error('[pwreset] revokeRefreshTokens failed', { uid, error: e.message }));

  try {
    const u = await auth.getUser(uid);
    if (u && u.email) { const m = _changedEmail(); await send({ to: u.email, subject: 'Your SOKONI password was changed', html: m.html, text: m.text, category: 'security', uid, template: 'password-changed' }); }
  } catch (e) { logger.error('[pwreset] change notice failed', { uid, error: e.message }); }
  await db().collection('securityEvents').add({
    type: 'password_reset_completed', uid, sessionsRevoked: true, createdAt: admin.firestore.FieldValue.serverTimestamp(),
  }).catch(() => {});
  logger.info('[pwreset] password changed via 25-minute link', { uid });
  return { ok: true };
}

const OPTS = { region: 'us-central1', enforceAppCheck: true, secrets: EmailService.EMAIL_SECRETS, maxInstances: 10, memory: '256MiB', timeoutSeconds: 30 };

exports.authRequestPasswordReset = onCall(OPTS, (req) => requestReset(req.data, req.rawRequest));
exports.authCompletePasswordReset = onCall(OPTS, (req) => completeReset(req.data, req.rawRequest));

exports._internal = {
  requestReset, completeReset, TTL_MS, LIMITS, TOKEN_RE, GENERIC_OK, GENERIC_BAD, _clientKey,
  _setClock: (fn) => { _clock = fn || (() => Date.now()); },
};
