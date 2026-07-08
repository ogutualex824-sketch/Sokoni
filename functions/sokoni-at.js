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

  const params = new URLSearchParams({
    username,
    to:      recipients,
    message: String(message).slice(0, 918),
    ...(from ? { from } : {}),
  });

  try {
    const res = await fetch('https://api.africastalking.com/version1/messaging', {
      method:  'POST',
      headers: {
        apiKey,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept:          'application/json',
      },
      body:   params.toString(),
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      console.warn(`[AT SMS] HTTP ${res.status} from AT API`);
      return;
    }

    const json = await res.json();
    if (json?.SMSMessageData?.Recipients) {
      const recs      = json.SMSMessageData.Recipients;
      const delivered = recs.filter(r => r.status === 'Success').length;
      console.log(`[AT SMS] ${_logTag(recipients)} ${delivered}/${recs.length} delivered (env=${username === 'sandbox' ? 'sandbox' : 'production'})`);
    } else {
      console.log(`[AT SMS] ${_logTag(recipients)}`, json?.SMSMessageData?.Message || JSON.stringify(json));
    }
  } catch (e) {
    console.warn('[AT SMS] Send error:', e.message);
  }
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
  AFRICASTALKING_USERNAME,
  secrets: [AFRICASTALKING_API_KEY, AFRICASTALKING_USERNAME],
  AT_ENV,
  resolveAtCredentials,
  atSendSMS,
  atBuildClient,
};
