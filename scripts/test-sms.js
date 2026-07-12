#!/usr/bin/env node
/**
 * test-sms.js — SMS platform static analysis. SENDS NOTHING.
 *
 * Guards the failures that cost real money or lock users out:
 *   1. No hardcoded sender ID anywhere. "SOKONI" is PENDING approval — a literal
 *      would be rejected by Africa's Talking today, and would silently bypass the
 *      one config value that is supposed to switch branding on.
 *   2. OTP and security alerts can NEVER be suppressed by a user preference.
 *      Getting this backwards locks people out of their own accounts.
 *   3. Every template renders, is SMS-sized, and is SOKONI-branded.
 *   4. Exactly one Africa's Talking client exists.
 */
'use strict';
const path = require('path');
const fs   = require('fs');

let pass = 0, fail = 0;
const ok  = m => { pass++; console.log('  pass  ' + m); };
const bad = m => { fail++; console.error('  FAIL  ' + m); };

const { TEMPLATES, OPTIONAL_PREFS, render } = require(path.resolve('functions/sms-service.js'));

console.log('\nSMS platform — static analysis (no SMS sent)\n');

/* ── 1. No hardcoded sender ID ───────────────────────────────────────────── */
const fnDir = path.resolve('functions');
const jsFiles = fs.readdirSync(fnDir).filter(f => f.endsWith('.js'));
const offenders = [];
for (const f of jsFiles) {
  const src = fs.readFileSync(path.join(fnDir, f), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  /* from: 'SOKONI' / from:"SOKONI" — a literal sender, bypassing AT_SENDER_ID */
  if (/\bfrom\s*:\s*['"]SOKONI['"]/.test(src)) offenders.push(f);
}
offenders.length
  ? bad(`hardcoded sender ID in: ${offenders.join(', ')} — SOKONI is PENDING approval; AT would reject it`)
  : ok('no hardcoded sender ID — sender resolves only from AT_SENDER_ID');

/* ── 2. Only ONE Africa's Talking client ─────────────────────────────────── */
/* Strip comments before scanning — navigation.js's comment EXPLAINS the old
   api.africastalking.com bug, and matching that sentence flagged the very file that
   was fixed. A source-grep test must read code, not prose. */
const clients = jsFiles.filter(f => {
  if (f === 'sokoni-at.js') return false;
  const src = fs.readFileSync(path.join(fnDir, f), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  return /api\.africastalking\.com|api\.sandbox\.africastalking\.com/.test(src);
});
clients.length
  ? bad(`duplicate AT client(s) hitting the API directly: ${clients.join(', ')}`)
  : ok('exactly one Africa\'s Talking client (sokoni-at.js) — provider swap stays a one-file change');

/* ── 3. OTP / security are NOT suppressible ──────────────────────────────── */
['otp', 'security'].forEach(p => {
  OPTIONAL_PREFS.has(p)
    ? bad(`"${p}" is user-suppressible — a user could switch off the SMS that logs them in`)
    : ok(`"${p}" cannot be switched off by a user`);
});

for (const [key, t] of Object.entries(TEMPLATES)) {
  if (['otp', 'phone_verification', 'password_reset', 'login_alert'].includes(key) && t.category !== 'transactional') {
    bad(`template "${key}" is not transactional — it could be suppressed by a preference`);
  }
}
ok('all auth/security templates are transactional (never suppressible)');

/* ── 4. Marketing is opt-IN, not opt-out ─────────────────────────────────── */
TEMPLATES.promotion && TEMPLATES.promotion.category === 'optional'
  ? ok('promotional SMS is optional (opt-in) — not transactional')
  : bad('promotional SMS is not marked optional — it could be sent to users who never consented');

/^[\s\S]*Reply STOP/.test(TEMPLATES.promotion.body({ message: 'x' }))
  ? ok('promotional template carries an opt-out line (legal requirement)')
  : bad('promotional template has no opt-out line');

/* ── 5. Every template renders, is branded, and fits ─────────────────────── */
const sample = {
  code: '123456', minutes: 5, name: 'Alex', amount: 'KES 1,200', ref: 'ABC123',
  orderId: 'ORD-99', total: 'KES 1,200', rider: 'John', phone: '+254700000000',
  plan: 'Merchant Pro', until: '30 Aug', days: 3, balance: 'KES 500',
  merchantId: 'SOK-000123', subject: 'Test', detail: 'Detail', message: 'Offer',
  device: 'Chrome', when: 'now', reason: 'declined', code2: 'x',
};
let bodyIssues = 0;
for (const key of Object.keys(TEMPLATES)) {
  let body;
  try { body = render(key, sample).body; }
  catch (e) { bad(`template "${key}" threw on render: ${e.message}`); bodyIssues++; continue; }

  if (!body || !body.trim()) { bad(`template "${key}" rendered empty`); bodyIssues++; }
  if (!/SOKONI/.test(body))  { bad(`template "${key}" is not SOKONI-branded`); bodyIssues++; }
  if (body.length > 480)     { bad(`template "${key}" is ${body.length} chars — >3 SMS segments, needlessly expensive`); bodyIssues++; }
  if (/undefined|\[object/.test(body)) { bad(`template "${key}" leaks "undefined" — a placeholder is unguarded`); bodyIssues++; }
}
if (!bodyIssues) ok(`all ${Object.keys(TEMPLATES).length} templates render, are branded, and fit within 3 segments`);

/* ── 6. Queue is idempotent by construction ──────────────────────────────── */
const svc = fs.readFileSync(path.resolve('functions/sms-service.js'), 'utf8');
/\.doc\(key\)/.test(svc) && /\.create\(/.test(svc)
  ? ok('queue doc id IS the dedupeKey and uses create() — a duplicate enqueue cannot send twice')
  : bad('queue is not idempotent by construction — duplicate sends are possible');

/\bsmsDeadLetter\b/.test(svc)
  ? ok('dead-letter queue exists (failed messages are kept, not discarded)')
  : bad('no dead-letter queue — permanently failed SMS would vanish');

/* ── 7. Webhook is not an open door ──────────────────────────────────────── */
/SMS_WEBHOOK_TOKEN/.test(svc) && /403/.test(svc)
  ? ok('delivery webhook requires a token (AT does not sign callbacks — the URL is the only secret)')
  : bad('delivery webhook is unauthenticated — a public endpoint that writes to Firestore');

console.log('');
if (fail) { console.error(`SMS static analysis FAILED (${fail})\n`); process.exit(1); }
console.log(`SMS static analysis PASSED (${pass} checks) — no SMS sent\n`);
