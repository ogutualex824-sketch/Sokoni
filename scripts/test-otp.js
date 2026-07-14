#!/usr/bin/env node
/**
 * test-otp.js — verification-code field gate.
 *
 * SOKONI shipped three separate six-box OTP grids (.otp-digit, .otp-b, .otpb) with three
 * copies of the focus-jumping logic. The grid could not accept an SMS AutoFill by
 * construction: iOS fills ONE field with the whole code, and maxlength="1" then discarded
 * five of the six digits. Two of the three pages did not even carry
 * autocomplete="one-time-code", so the suggestion never appeared at all.
 *
 * This gate holds the fix in place:
 *
 *   1. No page reintroduces a multi-box grid (a run of maxlength="1" inputs).
 *   2. Every OTP page loads the shared component and mounts it — nobody re-rolls their own.
 *   3. The component keeps the four attributes one-tap autofill actually depends on.
 *   4. The focus-jumping / paste-scattering logic stays deleted.
 *   5. The backend contract is untouched: verification still goes through confirm().
 *
 * Run: node scripts/test-otp.js
 */
'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OTP_PAGES = ['login.html', 'onboarding.html', 'provider-onboarding.html'];

let failures = 0;
const fail = (m) => { failures++; console.log('  \x1b[31m✘\x1b[0m ' + m); };
const pass = (m) => console.log('  \x1b[32m✔\x1b[0m ' + m);

console.log('\nSOKONI — verification code field gate\n');

/* ── 1. The six-box grid must never come back ─────────────────────────────────────── */
console.log('1. No multi-box OTP grid anywhere');

const htmls = fs.readdirSync(ROOT).filter((f) => f.endsWith('.html'));
let grids = 0;
for (const f of htmls) {
  const s = fs.readFileSync(path.join(ROOT, f), 'utf8');
  /* A single maxlength="1" input is a legitimate thing (a PIN box, a quantity). THREE OR
     MORE in one file is the grid pattern, and that is what we are banning. */
  const n = (s.match(/maxlength=["']1["']/gi) || []).length;
  if (n >= 3) { fail(f + ' has ' + n + ' single-character inputs — the multi-box grid is back'); grids++; }
}
if (!grids) pass(htmls.length + ' pages — no multi-box grid');

/* Dead styles for the old grid must not linger either. Comments are stripped first — a
   note EXPLAINING that .otp-digit was removed is not a live rule, and a gate that cannot
   tell prose from code just teaches people to stop writing comments. */
const DEAD_CSS = ['.otp-digit', '.otp-b{', '.otpb{', '.otp-boxes', '.otprow'];
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '');
let deadHits = 0;
for (const f of htmls.concat(['auth.css', 'style.css'])) {
  const p = path.join(ROOT, f);
  if (!fs.existsSync(p)) continue;
  const s = stripComments(fs.readFileSync(p, 'utf8'));
  for (const d of DEAD_CSS) {
    if (s.includes(d)) { fail(f + ' still carries dead grid CSS: ' + d); deadHits++; }
  }
}
if (!deadHits) pass('no dead six-box CSS left behind');

/* ── 2. One shared component, mounted by every OTP page ───────────────────────────── */
console.log('\n2. Every OTP page uses the ONE shared component');

const COMPONENT = 'sokoni-otp.js';
if (!fs.existsSync(path.join(ROOT, COMPONENT))) {
  fail(COMPONENT + ' is missing — the shared component IS the fix');
} else {
  pass(COMPONENT + ' exists');
}

for (const page of OTP_PAGES) {
  const p = path.join(ROOT, page);
  if (!fs.existsSync(p)) { fail(page + ' is missing'); continue; }
  const s = fs.readFileSync(p, 'utf8');

  const loads  = /<script[^>]+src=["'][^"']*sokoni-otp\.js["']/.test(s);
  const mounts = /SokoniOtp\.mount\s*\(/.test(s) ||
                 /auth\.js/.test(s);                    /* login mounts via auth.js */
  const host   = /<div id=["']otp(Mount|B)["']><\/div>/.test(s);

  if (loads && mounts && host) pass(page + ' — loads the component and mounts one field');
  else fail(page + ' — loads:' + loads + ' mounts:' + mounts + ' mountPoint:' + host);
}

/* login.html mounts through auth.js, so auth.js must do it. */
const authJs = fs.readFileSync(path.join(ROOT, 'auth.js'), 'utf8');
if (/SokoniOtp\.mount\s*\(/.test(authJs)) pass('auth.js mounts the shared component');
else fail('auth.js no longer mounts the shared component');

/* ── 3. The attributes one-tap autofill actually depends on ───────────────────────── */
console.log('\n3. The component keeps the autofill contract');

const comp = fs.readFileSync(path.join(ROOT, COMPONENT), 'utf8');
const CONTRACT = [
  [/autocomplete\s*=\s*['"]one-time-code['"]/,    'autocomplete="one-time-code" (iOS AutoFill + Android suggestion)'],
  [/inputMode\s*=\s*['"]numeric['"]/,             'inputmode="numeric" (numeric keypad)'],
  [/\.type\s*=\s*['"]text['"]/,                   'type="text" (type=number would break maxlength + autofill)'],
  [/replace\(\/\\D\+?\/g?\w*,\s*['"]{2}\)/,       'strips every non-digit (spaces, dashes, pasted prose)'],
  [/maxLength\s*=\s*len/,                         'maxlength bound to the code length'],
];
for (const [re, label] of CONTRACT) {
  if (re.test(comp)) pass(label);
  else fail('MISSING from ' + COMPONENT + ': ' + label);
}

/* Auto-submit must fire once and only once — autofill can raise input AND change. */
if (/fired\s*&&\s*v\s*===\s*lastFired/.test(comp)) pass('auto-submit is de-duplicated (input + change cannot double-fire)');
else fail('auto-submit double-fire guard is gone — autofill will verify twice');

/* A rejected code must re-arm auto-submit, or the corrected code never auto-verifies. */
if (/error:\s*function[\s\S]{0,220}fired\s*=\s*false/.test(comp)) pass('error() re-arms auto-submit for the corrected code');
else fail('error() no longer re-arms auto-submit — a corrected code would only verify via the button');

/* ── 4. The old per-box logic stays deleted ───────────────────────────────────────── */
console.log('\n4. Focus-jumping / box-sync logic stays deleted');

const BANNED = [
  [/getElementById\(['"]otp['"]\s*\+\s*\(?\s*i/,  'focus-jumping between numbered boxes'],
  [/querySelectorAll\(['"]\.otp-?b['"]\)/,        'querying the old box grid'],
  [/\[0,1,2,3,4,5\]\.map/,                        'reassembling the code from six boxes'],
];
let banned = 0;
for (const f of ['auth.js'].concat(OTP_PAGES)) {
  const s = fs.readFileSync(path.join(ROOT, f), 'utf8');
  for (const [re, label] of BANNED) {
    if (re.test(s)) { fail(f + ': ' + label + ' is back'); banned++; }
  }
}
if (!banned) pass('no focus-jumping, no box synchronisation, no six-box reassembly');

/* ── 5. Backend untouched ─────────────────────────────────────────────────────────── */
console.log('\n5. Backend verification contract unchanged (UX-only sprint)');

let confirms = 0;
for (const f of ['auth.js'].concat(OTP_PAGES)) {
  const s = fs.readFileSync(path.join(ROOT, f), 'utf8');
  if (/\.confirm\s*\(\s*code\s*\)/.test(s)) confirms++;
}
if (confirms === 3) pass('all three pages still verify via the same Firebase confirm(code) call');
else fail('expected 3 confirm(code) call sites, found ' + confirms + ' — the backend path changed');

/* The component must never talk to a server itself. */
if (/fetch\(|httpsCallable|XMLHttpRequest/.test(comp)) {
  fail(COMPONENT + ' makes network calls — it is a UI component, verification belongs to the caller');
} else pass(COMPONENT + ' makes no network calls — verification stays with the caller');

console.log('');
if (failures) {
  console.log('\x1b[31mFAIL\x1b[0m — ' + failures + ' problem(s)\n');
  process.exit(1);
}
console.log('\x1b[32mPASS\x1b[0m — one field, one component, backend untouched\n');
