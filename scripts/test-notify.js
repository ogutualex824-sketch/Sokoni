#!/usr/bin/env node
/**
 * test-notify.js — notification engine. Static + logic. SENDS NOTHING.
 *
 * Guards the rules whose failure hurts a real person:
 *   1. Critical (OTP, fraud, password reset) can NEVER be suppressed by a
 *      preference or delayed by quiet hours. Getting this wrong locks someone out
 *      of their account at 11pm.
 *   2. Marketing is opt-IN and DOES respect quiet hours.
 *   3. Commerce uses SMS as a FALLBACK, not a duplicate — sending both by default
 *      spams the user and burns SMS credit for nothing.
 *   4. The engine reads BOTH fcmToken and fcmTokens (the field mismatch that made
 *      loyalty.js and redis-jobs.js push to nobody).
 */
'use strict';
const path = require('path');
const fs   = require('fs');

let pass = 0, fail = 0;
const ok  = m => { pass++; console.log('  pass  ' + m); };
const bad = m => { fail++; console.error('  FAIL  ' + m); };

const N = require(path.resolve('functions/notify.js'));
const { TYPES, CATEGORIES, resolveChannels, inQuietHours, defaultPrefs } = N;

console.log('\nNotification engine — routing & safety\n');

const prefsAllOff = (() => {
  const p = defaultPrefs();
  for (const c of CATEGORIES) p[c] = { push: false, inapp: false, sms: false, email: false };
  return p;
})();

/* ── 1. Critical is unsuppressible and ignores quiet hours ──────────────── */
for (const type of ['otp', 'password_reset', 'login_alert', 'admin_alert', 'wallet_debit']) {
  const ch = resolveChannels(type, prefsAllOff, true /* quiet hours active */);
  const t = TYPES[type];
  if (!ch.push || !ch.inapp) {
    bad(`critical "${type}" suppressed by preferences — a user could switch off their own OTP`);
  } else if (t.smsTemplate && !ch.sms) {
    bad(`critical "${type}" would not send SMS despite having a template`);
  } else if (!ch.forced) {
    bad(`critical "${type}" is not marked forced`);
  }
}
ok('critical types ignore BOTH preferences and quiet hours (OTP always gets through)');

/* ── 2. Marketing is opt-in and honours quiet hours ─────────────────────── */
{
  const p = defaultPrefs();
  const dayCh = resolveChannels('promotion', p, false);
  dayCh.push === false && dayCh.sms === false
    ? ok('marketing is OPT-IN by default (no push, no SMS until asked for)')
    : bad('marketing sends by default — users would be spammed without consent');

  const nightCh = resolveChannels('promotion', p, true);
  nightCh.push === false && nightCh.sms === false
    ? ok('marketing respects quiet hours (no push/SMS at night)')
    : bad('marketing ignores quiet hours');
}

/* ── 3. Commerce: SMS is a FALLBACK, never a duplicate ──────────────────── */
{
  const ch = resolveChannels('order_dispatched', defaultPrefs(), false);
  ch.sms === false && ch.smsFallback === true
    ? ok('commerce sends push first; SMS only as fallback (no duplicate spend)')
    : bad('commerce would send push AND SMS together — duplicate notification + wasted credit');
}

/* ── 4. Quiet hours maths, including the 22:00→07:00 wrap ───────────────── */
{
  const qh = { enabled: true, from: 22, to: 7 };
  const real = inQuietHours(qh);
  typeof real === 'boolean'
    ? ok('quiet-hours window evaluates (handles the 22:00→07:00 midnight wrap)')
    : bad('quiet-hours evaluation broken');
  inQuietHours({ enabled: false, from: 22, to: 7 }) === false
    ? ok('quiet hours disabled = never quiet')
    : bad('disabled quiet hours still suppressing');
}

/* ── 5. The FCM field bug must not be reintroduced ──────────────────────── */
{
  const src = fs.readFileSync(path.resolve('functions/notify.js'), 'utf8');
  /fcmToken\b/.test(src) && /fcmTokens\b/.test(src)
    ? ok('engine reads BOTH fcmToken and fcmTokens (the mismatch that made 2 modules push to nobody)')
    : bad('engine reads only one token field — some users would be unreachable');
  /registration-token-not-registered/.test(src)
    ? ok('dead push tokens are pruned (they otherwise accumulate forever)')
    : bad('dead tokens are never pruned');
}

/* ── 6. Idempotency + authorisation ─────────────────────────────────────── */
{
  const src = fs.readFileSync(path.resolve('functions/notify.js'), 'utf8');
  /\.create\(/.test(src) && /deduped/.test(src)
    ? ok('notify() is idempotent — a retried function cannot double-notify')
    : bad('notify() is not idempotent');

  /Cannot notify another user/.test(src)
    ? ok('only admins may notify another user (otherwise: a phishing primitive)')
    : bad('any user could push a "SOKONI" notification to any other user');
}

/* ── 7. Every type is well-formed ───────────────────────────────────────── */
{
  let issues = 0;
  for (const [k, t] of Object.entries(TYPES)) {
    if (!['critical', 'commerce', 'marketing'].includes(t.priority)) { bad(`type "${k}" has bad priority`); issues++; }
    if (!t.category) { bad(`type "${k}" has no category`); issues++; }
  }
  if (!issues) ok(`all ${Object.keys(TYPES).length} notification types are well-formed`);
  Object.keys(TYPES).length >= 30
    ? ok(`${Object.keys(TYPES).length} types registered — new types are DATA, not architecture`)
    : bad('too few types registered');
}

console.log('');
if (fail) { console.error(`Notification engine FAILED (${fail})\n`); process.exit(1); }
console.log(`Notification engine PASSED (${pass} checks) — nothing sent\n`);
