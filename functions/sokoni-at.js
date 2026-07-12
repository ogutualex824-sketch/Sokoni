'use strict';
/**
 * SOKONI Africa's Talking (AT) SMS Module  v1.0  (2026-07-07)
 * functions/sokoni-at.js
 *
 * Single source of truth for all AT SMS configuration and sending.
 * Supports sandbox (development) and production (live) environments
 * via the AT_ENV non-secret param in functions/.env.
 *
 * Usage in a Cloud Function file:
 *   const sokoniAt = require('./sokoni-at');
 *
 *   // Include in CF options secrets array:
 *   { secrets: [...sokoniAt.secrets, ...otherSecrets], ... }
 *
 *   // Send SMS in handler:
 *   await sokoniAt.atSendSMS(phone, message);
 *   await sokoniAt.atSendSMS([phone1, phone2], message, 'SOKONI');
 *
 *   // Build full SDK client (for USSD, Voice, etc.):
 *   const at = sokoniAt.atBuildClient();
 *   await at.SMS.send({ to: [phone], message: body });
 *
 * Environment switching (functions/.env):
 *   AT_ENV=sandbox      → uses username 'sandbox' (AT sandbox API — default)
 *   AT_ENV=production   → reads AFRICASTALKING_USERNAME secret (live AT API)
 *
 * Required secrets in Firebase Secret Manager:
 *   AFRICASTALKING_API_KEY   — your AT API key (same for sandbox and production)
 *   AFRICASTALKING_USERNAME  — your registered AT username (production only;
 *                              ignored in sandbox mode)
 *
 * Migration checklist (sandbox → production):
 *   1. Set AT_ENV=production in functions/.env
 *   2. firebase functions:secrets:set AFRICASTALKING_USERNAME
 *      (value: your real AT registered username, NOT 'sandbox')
 *   3. firebase deploy --only functions
 */

const { defineSecret, defineString } = require('firebase-functions/params');
const logger = require('firebase-functions/logger');

/* ── Secrets ─────────────────────────────────────────────────────────────────
   Set these in Firebase Secret Manager — never in code or .env:
     firebase functions:secrets:set AFRICASTALKING_API_KEY
     firebase functions:secrets:set AFRICASTALKING_USERNAME
   ─────────────────────────────────────────────────────────────────────────── */
const AFRICASTALKING_API_KEY  = defineSecret('AFRICASTALKING_API_KEY');
const AFRICASTALKING_USERNAME = defineSecret('AFRICASTALKING_USERNAME');

/* ── Environment param ───────────────────────────────────────────────────────
   Stored in functions/.env (non-sensitive — safe to commit).
   Default is 'sandbox' so a misconfigured deploy can never go live accidentally.
   ─────────────────────────────────────────────────────────────────────────── */
const AT_ENV = defineString('AT_ENV', { default: 'sandbox' });

/* ── Sender ID (branded "SOKONI") ────────────────────────────────────────────
   Africa's Talking sender IDs need operator approval, which is pending. So the
   sender is CONFIGURABLE, not hardcoded:

     AT_SENDER_ID unset  → send with no sender ID (AT uses the shared shortcode).
     AT_SENDER_ID=SOKONI → send branded, the moment approval lands.

   Switching is a .env change and a redeploy of the SMS functions — no code edit,
   no logic change. That was the requirement: "automatically switch to SOKONI once
   approved, without requiring code changes."
   ─────────────────────────────────────────────────────────────────────────── */
const AT_SENDER_ID = defineString('AT_SENDER_ID', { default: '' });

/* ── API base URL — MUST follow AT_ENV ───────────────────────────────────────
   This was the bug that broke ALL SMS on the platform: the module resolved SANDBOX
   credentials (AT_ENV=sandbox) but posted them to the PRODUCTION endpoint, which
   returns 401. Sandbox and production are different hosts and the credential for one
   is rejected by the other. Every SMS — OTP, delivery, rider, merchant — was failing
   with 401, and the failure was only logged, never surfaced.
   ─────────────────────────────────────────────────────────────────────────── */
function _env() {
  return String(AT_ENV.value() || 'sandbox').toLowerCase();
}

function atBaseUrl() {
  const env = String(AT_ENV.value() || 'sandbox').toLowerCase();
  return env === 'production'
    ? 'https://api.africastalking.com/version1/messaging'
    : 'https://api.sandbox.africastalking.com/version1/messaging';
}

/**
 * Resolves AT credentials at CF runtime.
 *
 * Sandbox:    username is always 'sandbox' — AFRICASTALKING_USERNAME ignored.
 * Production: reads AFRICASTALKING_USERNAME from Secret Manager; throws if
 *             missing or if the value is still 'sandbox' (misconfiguration guard).
 *
 * @returns {{ apiKey: string, username: string }}
 * @throws {Error} with a clear message if credentials are not properly configured
 */
function resolveAtCredentials() {
  const apiKey = AFRICASTALKING_API_KEY.value();
  if (!apiKey) {
    throw new Error(
      'AFRICASTALKING_API_KEY secret is not set. ' +
      'Run: firebase functions:secrets:set AFRICASTALKING_API_KEY'
    );
  }

  const env = (AT_ENV.value() || 'sandbox').toLowerCase();

  if (env === 'sandbox') {
    return { apiKey, username: 'sandbox' };
  }

  if (env === 'production') {
    const username = AFRICASTALKING_USERNAME.value();
    if (!username) {
      throw new Error(
        'AFRICASTALKING_USERNAME secret is required when AT_ENV=production. ' +
        'Run: firebase functions:secrets:set AFRICASTALKING_USERNAME ' +
        '(value: your registered Africa\'s Talking username, not "sandbox")'
      );
    }
    if (username.toLowerCase() === 'sandbox') {
      throw new Error(
        'AFRICASTALKING_USERNAME is set to "sandbox" but AT_ENV=production. ' +
        'Update the secret to your real registered Africa\'s Talking username.'
      );
    }
    return { apiKey, username };
  }

  throw new Error(
    `Unknown AT_ENV value "${env}". Must be "sandbox" or "production". ` +
    'Check functions/.env.'
  );
}

/**
 * Sends an SMS via the Africa's Talking raw HTTP API.
 *
 * - Phone numbers are normalised to E.164 (+254…) for Kenyan numbers.
 * - Non-Kenyan numbers starting with + are passed through untouched.
 * - Send errors are logged as warnings but do not throw (SMS is non-critical).
 * - Credential errors DO throw so misconfigurations surface immediately.
 *
 * @param {string|string[]} to   - single phone string or array (max 100)
 * @param {string}          message - body text, max 918 chars (AT multi-part limit)
 * @param {string}          [from]  - sender ID (optional; may be ignored in sandbox)
 */
async function atSendSMS(to, message, from) {
  if (!to || !message) return;

  const { apiKey, username } = resolveAtCredentials(); // throws on misconfiguration

  const recipients = Array.isArray(to)
    ? to.slice(0, 100).map(_normalisePhone).join(',')
    : _normalisePhone(String(to));

  /* Explicit `from` wins; otherwise fall back to the configured sender ID. Once the
     branded sender is approved, set AT_SENDER_ID=SOKONI and every message becomes
     branded — no call site changes. */
  const sender = from || String(AT_SENDER_ID.value() || '').trim();

  const params = new URLSearchParams({
    username,
    to:      recipients,
    message: String(message).slice(0, 918),
    ...(sender ? { from: sender } : {}),
  });

  try {
    const res = await fetch(atBaseUrl(), {
      method:  'POST',
      headers: {
        apiKey,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept:          'application/json',
      },
      body:   params.toString(),
      signal: AbortSignal.timeout(15_000),
    });

    /* ── Failures are ERRORS, not warnings ───────────────────────────────────
       This used to console.warn and return. That is exactly why a total SMS
       outage (every send 401-ing) went unnoticed: a warning is not an alert, and
       the caller was told nothing. A silently swallowed SMS failure means a user
       never gets their OTP and nobody finds out.

       401/403 = credentials. 429 = rate limit. 5xx = provider down.
       All are logged at ERROR (so they reach Cloud Monitoring) and RETURNED to the
       caller, which can then decide (e.g. fall back to email). */
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const fatal = res.status === 401 || res.status === 403;   /* config — retrying cannot help */

      logger.error('[AT SMS] send failed', {
        status: res.status,
        fatal,
        env: _env(),
        /* Never log the key, the message body, or the full number. */
        recipients: _logTag(recipients),
        provider: body.slice(0, 200),
      });

      return { ok: false, status: res.status, retryable: !fatal, error: body.slice(0, 200) };
    }

    const json = await res.json();
    const recs = json?.SMSMessageData?.Recipients || [];

    /* Per-recipient provider response: messageId, status, cost. This is the delivery
       and cost record — without it there is no way to answer "did it arrive?" or
       "what did it cost?", both of which the business needs. */
    const results = recs.map(r => ({
      messageId: r.messageId || null,
      status: r.status,            /* Success | UserInBlacklist | InvalidPhoneNumber | … */
      statusCode: r.statusCode,
      cost: r.cost || null,        /* e.g. "KES 0.8000" */
      number: _logTag(r.number),
    }));

    const delivered = results.filter(r => r.status === 'Success').length;

    /* A 200 from AT does NOT mean the SMS was accepted for every recipient — a bad
       number comes back inside a 200. Treat a zero-success 200 as a failure. */
    if (recs.length && delivered === 0) {
      logger.error('[AT SMS] accepted by API but 0 recipients succeeded', {
        env: _env(), results,
      });
      return { ok: false, status: 200, retryable: false, results };
    }

    logger.info('[AT SMS] sent', {
      env: _env(),
      delivered,
      total: recs.length,
      sender: sender || '(default shortcode)',
      results,                       /* messageId + cost per recipient */
    });

    return { ok: true, delivered, total: recs.length, results };
  } catch (e) {
    /* Network/timeout — transient by nature, so the caller may retry. */
    logger.error('[AT SMS] transport error', { error: e.message, env: _env() });
    return { ok: false, retryable: true, error: e.message };
  }
}

/* Retry wrapper with exponential backoff, for transient failures only.
   401/403 are NEVER retried — a wrong credential does not become right on the third
   attempt, and hammering the provider with bad auth is how an account gets blocked. */
async function atSendSMSWithRetry(to, message, from, attempts = 3) {
  let last = null;
  for (let i = 0; i < attempts; i++) {
    last = await atSendSMS(to, message, from);
    if (last && last.ok) return last;
    if (!last || !last.retryable) return last;      /* fatal — stop immediately */
    if (i < attempts - 1) {
      const backoff = 500 * Math.pow(2, i);          /* 500ms, 1s, 2s */
      await new Promise(r => setTimeout(r, backoff));
    }
  }
  logger.error('[AT SMS] exhausted retries', { attempts, last });
  return last;
}

/**
 * Builds a full Africa's Talking SDK client instance.
 * Use when you need richer API access (USSD, Voice, Payments, advanced SMS opts).
 *
 * @returns {import('africastalking').AfricasTalkingInstance}
 */
function atBuildClient() {
  const { apiKey, username } = resolveAtCredentials();
  // eslint-disable-next-line global-require
  const AtKit = require('africastalking');
  return AtKit({ apiKey, username });
}

/* ── Internal helpers ───────────────────────────────────────────────────────── */

function _normalisePhone(phone) {
  const s = String(phone).replace(/\s+/g, '').replace(/[^+\d]/g, '');
  if (s.startsWith('+')) return s;               // already E.164
  if (s.startsWith('07') || s.startsWith('01'))  return '+254' + s.slice(1);
  if (s.startsWith('254'))                        return '+' + s;
  return s;
}

function _logTag(recipients) {
  const first = String(recipients).split(',')[0];
  return first.length > 6
    ? first.slice(0, 4) + '****' + first.slice(-2)
    : '****';
}

/* ── Exports ─────────────────────────────────────────────────────────────────
   `secrets` is a convenience spread for CF options:
     { secrets: [...sokoniAt.secrets, SENDGRID_API_KEY], ... }
   ─────────────────────────────────────────────────────────────────────────── */
module.exports = {
  AFRICASTALKING_API_KEY,
  AT_SENDER_ID,
  atBaseUrl,
  AFRICASTALKING_USERNAME,
  secrets: [AFRICASTALKING_API_KEY, AFRICASTALKING_USERNAME],
  AT_ENV,
  resolveAtCredentials,
  atSendSMS,
  atSendSMSWithRetry,
  atBuildClient,
};
