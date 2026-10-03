'use strict';
/**
 * SMS RECIPIENT RESOLUTION — owned by the notification engine, never by the caller (owner 2026-10-03, Notifications E2E).
 *
 * Production evidence (2026-10-03): smsQueue had 0 documents ever; 58/58 notifyLog rows had no SMS outcome at all —
 * callers never passed a phone, and the engine trusted the caller instead of resolving the recipient itself.
 *
 * Precedence:
 *   1. verified PROFILE phone   users/{uid}.phoneNumber — written only from Firebase Auth / a confirmed SMS code, so
 *                               verified by provenance; an explicit phoneVerified === false demotes it.
 *   2. verified LOGIN phone     Firebase Auth phoneNumber (proved by OTP at sign-in).
 *   3. no usable number         → an explicit reason; never a silent skip.
 * A phone supplied by the event caller is NEVER used.
 *
 * Normalised to E.164 and validated as a Kenyan mobile (+2547XXXXXXXX / +2541XXXXXXXX). Other countries are
 * 'unsupported_destination' (the SMS route is Kenyan); malformed numbers are 'invalid_phone'.
 * READ-ONLY. Pure except for the two reads it is given.
 */

const REASONS = Object.freeze(['no_phone', 'invalid_phone', 'unverified_phone', 'sms_disabled', 'unsupported_destination', 'provider_error', 'rate_limited']);

/** → { ok:true, e164 } | { ok:false, reason:'invalid_phone'|'unsupported_destination' } */
function normalizeKenyan(raw) {
  if (typeof raw !== 'string') return { ok: false, reason: 'invalid_phone' };
  const s = raw.replace(/[\s\-().]/g, '');
  if (!s) return { ok: false, reason: 'invalid_phone' };
  let d;
  if (/^\+\d{7,15}$/.test(s)) d = s.slice(1);
  else if (/^00\d{7,15}$/.test(s)) d = s.slice(2);
  else if (/^0[17]\d{8}$/.test(s)) d = '254' + s.slice(1);
  else if (/^254[17]\d{8}$/.test(s)) d = s;
  else if (/^[17]\d{8}$/.test(s)) d = '254' + s;
  else return { ok: false, reason: 'invalid_phone' };
  if (!d.startsWith('254')) return { ok: false, reason: 'unsupported_destination' };
  if (!/^254[17]\d{8}$/.test(d)) return { ok: false, reason: 'invalid_phone' };
  return { ok: true, e164: '+' + d };
}

/**
 * @param {{ readUser:(uid)=>Promise<object|null>, readAuthPhone:(uid)=>Promise<string|null> }} io
 * @returns {Promise<{ ok:true, phone:string, source:'profile'|'login' } | { ok:false, reason:string }>}
 */
async function resolveSmsRecipient(uid, io) {
  if (!uid || typeof uid !== 'string') return { ok: false, reason: 'no_phone' };
  let user = null, authPhone = null;
  try { user = await io.readUser(uid); } catch (_) { user = null; }
  const profile = user && typeof user.phoneNumber === 'string' && user.phoneNumber.trim() ? user.phoneNumber.trim() : null;
  const profileUnverified = !!(user && user.phoneVerified === false);
  let firstBad = null;
  if (profile && !profileUnverified) {
    const n = normalizeKenyan(profile);
    if (n.ok) return { ok: true, phone: n.e164, source: 'profile' };
    firstBad = n.reason;
  }
  try { authPhone = await io.readAuthPhone(uid); } catch (_) { authPhone = null; }
  if (typeof authPhone === 'string' && authPhone.trim()) {
    const n = normalizeKenyan(authPhone.trim());
    if (n.ok) return { ok: true, phone: n.e164, source: 'login' };
    firstBad = firstBad || n.reason;
  }
  if (firstBad) return { ok: false, reason: firstBad };
  if (profile && profileUnverified) return { ok: false, reason: 'unverified_phone' };
  return { ok: false, reason: 'no_phone' };
}

module.exports = { resolveSmsRecipient, normalizeKenyan, REASONS };
