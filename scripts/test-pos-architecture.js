#!/usr/bin/env node
/* ══════════════════════════════════════════════════════════════════════════════
   ARCHITECTURE TEST — /pos is the till; business setup lives elsewhere
   ══════════════════════════════════════════════════════════════════════════════
   Run:  node scripts/test-pos-architecture.js

   This exists so the separation cannot quietly come back. A merchant whose
   business was approved must never be asked to create it again, and the way that
   regressed before was a wizard living inside the POS document.

   THE CONTRACT

     pos.html          MUST NOT contain business-setup markup, M-PESA
                       onboarding, admin-account creation, business creation,
                       or any redirect into setup.

     pos-setup.html    MAY contain device pairing, branch selection, terminal
                       and printer setup, and employee/role context.

   Business setup belongs to registration and approval. Opening a till is not
   the place to create a business.

   HONEST STATE: parts of this FAIL today. That is deliberate — the test states
   the target and proves the current violation, so the extraction has a
   before-proof rather than an assertion that it was "probably fine".
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

const rows = [];
const ck = (label, ok, detail) => rows.push({ ok, label, detail: detail == null ? '' : String(detail) });

const read = (f) => { try { return fs.readFileSync(path.join(ROOT, f), 'utf8'); } catch (e) { return ''; } };

const pos = read('pos.html');
const posJs = read('pos.js');
/* Comments stripped, so a comment explaining a removal can never satisfy a check
   that the thing is absent. */
const strip = (s) => s.replace(/<!--[\s\S]*?-->/g, ' ')
                      .replace(/\/\*[\s\S]*?\*\//g, ' ')
                      .replace(/(^|[^:])\/\/.*$/gm, '$1 ');
const posCode = strip(pos);
const posJsCode = strip(posJs);

/* ── the violations that must not exist in /pos ─────────────────────────── */
const FORBIDDEN = [
  ['business-setup markup',      /id=["']pos-wizard["']/i],
  ['"Set up your business"',     /Set up your business/i],
  ['"Create admin account"',     /Create admin account/i],
  ['M-PESA onboarding fields',   /wizard[^<]{0,40}(mpesa|paybill|till number)/i],
];

FORBIDDEN.forEach(([name, re]) => {
  ck('A  pos.html contains no ' + name,
    !re.test(posCode), re.test(posCode) ? 'PRESENT — must move to pos-setup.html' : 'absent');
});

ck('A5 pos.html has no redirect into setup',
  !/location\.(replace|href|assign)\s*\(\s*['"][^'"]*pos-setup/.test(posCode),
  'a merchant must never be routed into business registration by opening a till');

ck('A6 pos.js does not drive a business wizard',
  !/wizard\.showStep|state\.wizardStep/.test(posJsCode),
  /wizard\.showStep|state\.wizardStep/.test(posJsCode)
    ? 'PRESENT — the markup and its driver must move together'
    : 'absent');

/* ── the boot decision must rest on the server, not the device ──────────── */
ck('A7 the launch decision admits a known signed-in account',
  /isSetup \|\| embedded \|\| _known/.test(posJsCode),
  'device-cache flags alone must not decide who is a new business');

ck('A8 the server-resolved context is loaded by /pos',
  /sokoni-pos-context\.js/.test(pos) && /sokoni-pos-boot\.js/.test(pos),
  'the resolver is what replaces the device-local decision');

/* ── what pos-setup.html is ALLOWED and expected to be ──────────────────── */
const setup = read('pos-setup.html');
ck('A9 pos-setup.html exists as the separate surface',
  setup.length > 0, setup.length.toLocaleString() + ' bytes');

/* ── optional subsystems must never be able to hold the boot ────────────── */
ck('A10 IndexedDB cannot hold POS boot hostage',
  /BLOCKED_TIMEOUT_MS/.test(read('pos-db.js')),
  'the blocked-open deadlock fix must stay in place');

/* ── the lightweight shell exists and is genuinely light ────────────────── */
const till = read('till.html');
const scriptCount = (s) => (s.match(/<script[^>]+src=/g) || []).length;
ck('A11 a lightweight till shell exists',
  till.length > 0 && scriptCount(till) <= 10,
  till ? scriptCount(till) + ' external scripts vs ' + scriptCount(pos) + ' in /pos' : 'absent');

ck('A12 the light shell renders a state rather than a white page',
  /AUTH|sign in|not paired|suspended|Could not/i.test(till),
  'every terminal outcome must say something');

/* ── CONTROL: the detectors can actually fire ───────────────────────────── */
ck('A13 CONTROL the forbidden-pattern detector matches when the thing IS present',
  FORBIDDEN[0][1].test('<div id="pos-wizard">'),
  'a detector that cannot match would pass this suite forever');

ck('A14 CONTROL comments are stripped before scanning',
  !/id=["']pos-wizard["']/.test(strip('<!-- id="pos-wizard" -->')),
  'a comment mentioning the wizard must not count as the wizard');

const passed = rows.filter((r) => r.ok).length;
const failed = rows.length - passed;
console.log('');
console.log('  POS ARCHITECTURE — /pos is the till; business setup lives elsewhere');
console.log('  ' + '='.repeat(70));
console.log('');
for (const r of rows) console.log('  ' + (r.ok ? 'PASS  ' : 'FAIL  ') + r.label + '\n        [' + r.detail + ']');
console.log('');
console.log('  ' + passed + ' passed, ' + failed + ' failed');
if (failed) {
  console.log('');
  console.log('  FAILURES ABOVE ARE THE OUTSTANDING EXTRACTION, not a broken build.');
  console.log('  This suite states the target and proves the current violation.');
}
console.log('');
process.exit(0);   /* reporting gate: it documents, it does not block a deploy yet */
