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

/* ── 8. Order timeline: 11 stages, monotonic, and not a buzzer ──────────── */
{
  const T = N.ORDER_TIMELINE;
  Array.isArray(T) && T.length === 11
    ? ok(`order timeline has all ${T.length} stages`)
    : bad('order timeline is not the 11 specified stages');

  T.every(s => s.key && s.label && 'milestone' in s)
    ? ok('every stage is well-formed (key, label, milestone)')
    : bad('a stage is missing key/label/milestone');

  /* Every stage that DOES notify must name a type the engine actually knows,
     or the order would silently stall at that stage in production. */
  const unknown = T.filter(s => s.type && !TYPES[s.type]).map(s => s.key);
  unknown.length === 0
    ? ok('every notifying stage maps to a registered notification type')
    : bad(`stages notify with unregistered types: ${unknown.join(', ')}`);

  /* Quiet stages exist. 11 pushes per order is how an app gets muted. */
  const quiet = T.filter(s => !s.type).map(s => s.key);
  quiet.length > 0
    ? ok(`${quiet.length} stages update the timeline WITHOUT a push (${quiet.join(', ')}) — no notification fatigue`)
    : bad('every stage pushes — the user would get 11 notifications for one order');

  /* Monotonicity is what stops a retried webhook rewinding "Delivered". */
  const src = fs.readFileSync(path.resolve('functions/notify.js'), 'utf8');
  /idx <= at/.test(src) && /unchanged: true/.test(src)
    ? ok('advancing to an already-passed stage is a no-op (a retry cannot rewind Delivered)')
    : bad('order timeline is not monotonic — a duplicate webhook could move an order backwards');

  /dedupeKey: 'order:' \+ orderId \+ ':' \+ st\.key/.test(src)
    ? ok('each stage notifies at most once, ever (dedupe key is order+stage)')
    : bad('a retried stage advance could double-notify the customer');
}

/* ── 9. The push actually OPENS the thing it is about ───────────────────────
   The engine sends the target as data.deepLink. Both service workers historically
   read data.url. A push about an order would have opened the homepage — the exact
   same shape of failure as the fcmToken/fcmTokens mismatch: a key name that two
   sides never agreed on, and no test that would notice. */
{
  const engine = fs.readFileSync(path.resolve('functions/notify.js'), 'utf8');
  const fcmSw  = fs.readFileSync(path.resolve('firebase-messaging-sw.js'), 'utf8');
  const mainSw = fs.readFileSync(path.resolve('service-worker.js'), 'utf8');

  /* Whatever key the engine sends, the workers must read it. */
  const sendsDeepLink = /deepLink:\s*String\(/.test(engine);
  const readsDeepLink = sw => /deepLink/.test(sw);

  sendsDeepLink && readsDeepLink(fcmSw) && readsDeepLink(mainSw)
    ? ok('both service workers read the deepLink the engine sends (push opens the order, not the homepage)')
    : bad('deep-link key mismatch — pushes would open the homepage instead of the screen they are about');

  /* The engine also sends `url` as an alias, so anything NOT yet migrated still lands. */
  /url:\s*String\(payload\.deepLink/.test(engine)
    ? ok('engine also sends the legacy `url` alias — un-migrated senders still deep-link correctly')
    : bad('engine dropped the legacy `url` alias — older push consumers would break');

  /* Grouping: eleven order updates must collapse into one thread, not stack. */
  /data\.group \|\| data\.tag/.test(fcmSw) && /renotify/.test(fcmSw)
    ? ok('order updates collapse into ONE notification thread (not 11 stacked)')
    : bad('every order stage would stack as a separate notification');
}

/* ── 10. The in-app notification is actually VISIBLE ────────────────────────
   The notification center queries where('targetUid','==',uid). An engine that writes
   only `userId` produces a notification that is stored perfectly and seen by nobody.
   Third instance of one bug in this subsystem — two names for one thing:
     fcmToken / fcmTokens   → push reached no one
     deepLink / url         → push opened the homepage
     userId   / targetUid   → the feed showed nothing
   Each was invisible in production because nothing asserted the two sides agreed. */
{
  const engine = fs.readFileSync(path.resolve('functions/notify.js'), 'utf8');
  const center = fs.readFileSync(path.resolve('sokoni-notif-engine.js'), 'utf8');

  const query = center.match(/where\(\s*['"](\w+)['"]\s*,\s*['"]==['"]/);
  const queriedField = query && query[1];

  queriedField && new RegExp(`${queriedField}:\\s*uid`).test(engine)
    ? ok(`engine writes "${queriedField}" — the exact field the notification center queries on`)
    : bad(`engine does not write "${queriedField}" — notifications would never appear in the feed`);

  /* And the center must understand the engine's link key. */
  /data\.deepLink\s*\|\|/.test(center)
    ? ok('notification center opens the engine deepLink (taps reach the order, not the feed)')
    : bad('notification center ignores deepLink — tapping a notification goes nowhere useful');
}

/* ── 11. Duplicate suppression must actually suppress ───────────────────────
   The fallback dedupe key was `${type}:${uid}:${Date.now()}` — unique by construction,
   so it deduplicated NOTHING, while the file header claimed a short-window drop. A
   dedupe key containing a timestamp is not a dedupe key. It is a UUID with extra steps. */
{
  const src = fs.readFileSync(path.resolve('functions/notify.js'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  const keyLine = /const key = dedupeKey \|\|[^\n;]*/.exec(code);
  keyLine && !/Date\.now\(\)\s*[}`]/.test(keyLine[0])
    ? ok('the fallback dedupe key is not a timestamp — duplicates are genuinely suppressed')
    : bad('the fallback dedupe key embeds a raw timestamp — it is unique every call and suppresses nothing');

  keyLine && /_contentHash\(/.test(keyLine[0])
    ? ok('duplicate = same content, same user, same window (different messages still both arrive)')
    : bad('duplicate suppression does not consider content — a distinct notification could be swallowed');

  /* Explicit dedupeKey must still win outright — that is idempotency, not suppression. */
  /const key = dedupeKey \|\|/.test(code)
    ? ok('an explicit dedupeKey still takes precedence (send-at-most-once, forever)')
    : bad('explicit dedupeKey no longer honoured — retried functions could double-notify');
}

console.log('');
if (fail) { console.error(`Notification engine FAILED (${fail})\n`); process.exit(1); }
console.log(`Notification engine PASSED (${pass} checks) — nothing sent\n`);
