#!/usr/bin/env node
/* ══════════════════════════════════════════════════════════════════════════════
   SECONDARY FIREBASE APPS — the defect class 81ca4f2 fixed two instances of
   ------------------------------------------------------------------------------
   App Check is attached to the DEFAULT Firebase app (firebase.js). A SECONDARY app —
   initializeApp(cfg, 'some-name') — does NOT inherit it, so every Firestore read or
   write made through that app leaves with no App Check token. Under enforcement it
   comes back PERMISSION_DENIED and the page's catch renders a friendly lie: a shop
   that exists reports "Could not load business", a booking that was never written
   reports success.

   81ca4f2 fixed business.html ('bizPage') and businesses.html ('bizDir'). A repo-wide
   scan then found the same pattern in 28 further files, including WRITE paths for
   bookings and leads (cln-write, elc-write, plm-write, cr-write, ch-write, hs-write,
   th-write, mkt-write, dh-wd) — money paths where a silent write failure is worse than
   a visible read failure.

   search.html was converted earlier for the same reason and its comment already names the
   rest of the class as "tracked separately, not changed here" — and confirms App Check IS
   enforced on firestore.googleapis.com, so these are live defects, not latent ones.

   THIS SUITE IS A RATCHET, NOT A CLEANUP. The 28 known files are recorded in BASELINE
   below and do not fail: converting them is a shipping change across 28 public surfaces
   and is being scheduled deliberately, not smuggled in through a test. What fails is a
   NEW secondary app, or one appearing in a file not already on the list — so the class
   can only shrink. Remove a name from BASELINE as each file is converted; the suite
   fails if a BASELINE entry is stale, so the list cannot rot into fiction.

   Comments are stripped before scanning. business.html and businesses.html both still
   DESCRIBE the removed initializeApp(...) call in a comment explaining the fix, and a
   naive scan reports them as defective — the same trap 81ca4f2's own test called out:
   read the code, not the prose about the code.

     node scripts/test-secondary-firebase-apps.js
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

let pass = 0, fail = 0;
const failures = [];
const ck = (label, ok, detail) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + label + (detail ? '   [' + String(detail).slice(0, 100) + ']' : ''));
  if (ok) pass++; else { fail++; failures.push(label + (detail ? ' — ' + detail : '')); }
};

/* Strip block comments, line comments and string literals before matching. Without this
   the scan reports the two files that were already FIXED, because each keeps a comment
   naming the call it no longer makes. */
function stripNonCode(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  let mode = 'code';       /* code | line | block | sq | dq | tpl */
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (mode === 'code') {
      if (c === '/' && d === '*') { mode = 'block'; i += 2; out += ' '; continue; }
      if (c === '/' && d === '/') { mode = 'line';  i += 2; out += ' '; continue; }
      if (c === "'")  { mode = 'sq';  out += c; i++; continue; }
      if (c === '"')  { mode = 'dq';  out += c; i++; continue; }
      if (c === '`')  { mode = 'tpl'; out += c; i++; continue; }
      out += c; i++; continue;
    }
    if (mode === 'block') { if (c === '*' && d === '/') { mode = 'code'; i += 2; } else i++; continue; }
    if (mode === 'line')  { if (c === '\n') { mode = 'code'; out += '\n'; } i++; continue; }
    /* Inside a string: keep it (the app NAME is a string we need), but honour escapes. */
    if (c === '\\') { out += src.slice(i, i + 2); i += 2; continue; }
    if ((mode === 'sq' && c === "'") || (mode === 'dq' && c === '"') || (mode === 'tpl' && c === '`')) mode = 'code';
    out += c; i++;
  }
  return out;
}

/* Matches modular `initializeApp(cfg, 'name')` and compat `firebase.initializeApp(cfg, 'name')`.
   A bare initializeApp(cfg) is the DEFAULT app and is correct — only the named form is the
   defect, because only the named form creates an app App Check was never attached to. */
const SECONDARY = /(?:firebase\s*\.\s*)?initializeApp\s*\(\s*[^,()]+\s*,\s*['"]([^'"]+)['"]\s*\)/g;

/* Known, accepted-for-now instances. file → sorted app names. */
const BASELINE = {
  'admin.html':                ['adm-flags'],
  'b2b.html':                  ['b2b-fee'],
  'business-os.html':          ['bos-load', 'bos-sync'],
  'car-hub.html':              ['ch-rt', 'ch-write'],
  'car-rental.html':           ['cr-write'],
  'cleaning.html':             ['cln-write'],
  'commerce-os.html':          ['commerce-os'],
  'developer-portal.html':     ['developer-portal'],
  'digital.html':              ['dh-wd'],
  'electrical.html':           ['elc-write'],
  'email-center.html':         ['email-center'],
  'event-hub.html':            ['event-hub'],
  'event-manager.html':        ['event-manager'],
  'executive-dashboard.html':  ['executive-dashboard'],
  'home-services.html':        ['hs-read', 'hs-write'],
  'legal-hub.html':            ['lh-lead'],
  'marketing.html':            ['mkt-write'],
  'plumbing.html':             ['plm-write'],
  'release-readiness.html':    ['release-readiness'],
  'revenue.html':              ['revenue-dash'],
  'security-center.html':      ['security-center'],
  'sokoni-b2b.js':             ['b2b-fs'],
  'sokoni-featured.js':        ['sokoni-featured'],
  'sokoni-recommendations.js': ['sk-recs'],
  'tech-hub.html':             ['th-read', 'th-write'],
  'verification-admin.html':   ['sokoni-va'],
  'verification.html':         ['sokoni-verify'],
  'wholesale-portal.html':     ['wholesale-portal'],
};

/* Fixed by 81ca4f2 and asserted to STAY fixed — the whole point of the exercise. */
const MUST_BE_CLEAN = ['business.html', 'businesses.html', 'search.html'];

console.log('\nSECONDARY FIREBASE APPS — App Check rides on the default app only\n');

const files = fs.readdirSync(ROOT)
  .filter((f) => /\.(html|js)$/.test(f))
  .filter((f) => !/^service-worker|^firebase-messaging-sw/.test(f))
  .sort();

const found = {};
for (const f of files) {
  let src;
  try { src = fs.readFileSync(path.join(ROOT, f), 'utf8'); } catch (_) { continue; }
  const code = stripNonCode(src);
  const names = new Set();
  let m;
  SECONDARY.lastIndex = 0;
  while ((m = SECONDARY.exec(code))) names.add(m[1]);
  if (names.size) found[f] = [...names].sort();
}

console.log('── the pages already converted must stay on the canonical app ──');
for (const f of MUST_BE_CLEAN) {
  ck(f + ' creates no secondary Firebase app', !found[f], found[f] ? found[f].join(', ') : '');
  const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
  ck(f + ' imports db from firebase.js', /import\s*\{[^}]*\bdb\b[^}]*\}\s*from\s*['"]\.\/firebase\.js['"]/.test(src));
}

console.log('\n── no NEW secondary app may appear (ratchet) ──');
const newFiles = Object.keys(found).filter((f) => !BASELINE[f] && !MUST_BE_CLEAN.includes(f));
ck('no file outside the baseline creates a secondary app', newFiles.length === 0,
   newFiles.length ? newFiles.map((f) => f + ':' + found[f].join('/')).join('  ') : 'none');

const grew = [];
for (const f of Object.keys(BASELINE)) {
  const now = found[f] || [];
  const extra = now.filter((n) => !BASELINE[f].includes(n));
  if (extra.length) grew.push(f + ' +' + extra.join('/'));
}
ck('no baselined file gained an additional secondary app', grew.length === 0, grew.join('  ') || 'none');

console.log('\n── the baseline must describe reality, not history ──');
const stale = [];
for (const f of Object.keys(BASELINE)) {
  const now = found[f] || [];
  const gone = BASELINE[f].filter((n) => !now.includes(n));
  if (gone.length) stale.push(f + ' no longer has ' + gone.join('/') + ' — remove it from BASELINE');
}
/* A converted file leaving its name in BASELINE would quietly re-permit the pattern there
   forever. Fixing a file must therefore also shrink the list. */
ck('no BASELINE entry is stale', stale.length === 0, stale.join('  |  ') || 'none');

const total = Object.keys(BASELINE).reduce((n, f) => n + BASELINE[f].length, 0);
console.log('\n' + '─'.repeat(70));
console.log('  OUTSTANDING: ' + Object.keys(BASELINE).length + ' files, ' + total + ' secondary apps still to convert.');
console.log('  Each one reads/writes Firestore with NO App Check token. The write paths');
console.log('  (cln-write, elc-write, plm-write, cr-write, ch-write, hs-write, th-write,');
console.log('  mkt-write, dh-wd) fail SILENTLY — a booking that was never stored still');
console.log('  reports success to the customer.');
if (fail) { console.log('\nFAILURES'); failures.forEach((f) => console.log('  x ' + f)); }
console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
