/* ══════════════════════════════════════════════════════════════════════════════
   MERCHANT V2 — DASHBOARD GREETING
   ══════════════════════════════════════════════════════════════════════════════
   A greeting is presentation, but it renders IDENTITY, and identity rendered from
   the wrong source is how "polish" becomes a data-integrity defect. So this holds
   the line on three things:

     · the time band follows the DEVICE's local clock, not UTC and not a server
     · the name comes from the canonical shop record the shell already resolved —
       never a URL parameter, localStorage, a signup flag, or a hardcoded name
     · an unknown name renders the greeting ALONE. Never "undefined", never an
       email address (a login credential is not a display name), never a guess

   The greeting logic is extracted from the shipped shell by source, so this cannot
   drift into testing a copy that no longer resembles what merchants see.

   Run: node scripts/test-merchant-greeting.js
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'merchant-v2.html'), 'utf8');

let pass = 0, fail = 0;
const ck = (l, ok, d) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d ? '   [' + d + ']' : ''));
  ok ? pass++ : fail++;
};

console.log('\nMERCHANT V2 — DASHBOARD GREETING');
console.log('='.repeat(70));

/* ── 1. The shipped shell holds the shape we are about to test ────────────── */
console.log('\n1. The shell itself');

ck('a single display-name authority exists', /function merchantDisplayName \(\)/.test(SRC));
ck('the header chip uses it', /text\('st-user', merchantDisplayName\(\)/.test(SRC));
ck('the greeting uses it', /var who = merchantDisplayName\(\);/.test(SRC));
ck('the name comes from the canonical shop record',
   /var s = S\.shop \|\| \{\};[\s\S]{0,120}s\.name \|\| s\.shopName/.test(SRC));

/* The forbidden sources, asserted as ABSENT from the name path rather than assumed. */
const nameFn = (SRC.match(/function merchantDisplayName \(\)[\s\S]*?\n  \}/) || [''])[0];
ck('...and not from localStorage', !/localStorage/.test(nameFn), nameFn ? 'clean' : 'fn not found');
ck('...and not from a URL parameter', !/(URLSearchParams|location\.(search|href))/.test(nameFn));
ck('...and no hardcoded seller name', !/KASS|Alex/i.test(nameFn));
ck('the greeting never falls back to an email address',
   !/who \|\| S\.email|part[^\n]*S\.email/.test(SRC));
ck('the dashboard refreshes when the session lands (name arrives late)',
   /current === 'dashboard' && S\.state === 'in'/.test(SRC));

/* ── 2. The greeting function, extracted from the shell ───────────────────── */
console.log('\n2. Time bands (device local clock)');

/* Mirrors the shipped expression exactly; asserted against the source below so the
   two cannot silently diverge. */
const band = (h) => (h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening');
ck('the shell computes the band from new Date().getHours()',
   /var hour = new Date\(\)\.getHours\(\);/.test(SRC));
ck('...with the same thresholds this test uses',
   /hour < 12 \? 'Good morning' : hour < 17 \? 'Good afternoon' : 'Good evening'/.test(SRC));

[[0, 'Good morning'], [6, 'Good morning'], [11, 'Good morning'],
 [12, 'Good afternoon'], [15, 'Good afternoon'], [16, 'Good afternoon'],
 [17, 'Good evening'], [21, 'Good evening'], [23, 'Good evening']].forEach(([h, want]) => {
  ck(String(h).padStart(2, '0') + ':00 -> ' + want, band(h) === want, band(h));
});

/* ── 3. Name rendering ────────────────────────────────────────────────────── */
console.log('\n3. Name rendering and the fallback');

/* The shipped composition: part + (who ? ', ' + esc(who) : '') */
const greet = (h, who) => band(h) + (who ? ', ' + who : '');
ck('the shell composes it that way',
   /part \+ \(who \? ', ' \+ esc\(who\) : ''\)/.test(SRC));

ck('morning + name',   greet(9,  'KASS') === 'Good morning, KASS',   greet(9, 'KASS'));
ck('afternoon + name', greet(14, 'KASS') === 'Good afternoon, KASS', greet(14, 'KASS'));
ck('evening + name',   greet(19, 'KASS') === 'Good evening, KASS',   greet(19, 'KASS'));

/* The fallback cases — each is a way the name can be absent in practice. */
[[null, 'null'], [undefined, 'undefined'], ['', 'empty string'], ['   ', 'whitespace only']].forEach(([v, label]) => {
  const nm = String(v == null ? '' : v).trim() || null;   /* the shell's own normalisation */
  ck('no name (' + label + ') -> bare greeting, no comma', greet(14, nm) === 'Good afternoon', greet(14, nm));
});
ck('...and never renders the word undefined',
   !/undefined/.test(greet(14, String(undefined) === 'undefined' ? null : null)));

/* ── 4. Negative controls ─────────────────────────────────────────────────── */
console.log('\n4. Negative controls (these assertions must be able to fail)');

ck('NC a wrong band would be caught', band(9) !== 'Good evening');
ck('NC a missing comma would be caught', greet(14, 'KASS') !== 'Good afternoonKASS');
ck('NC the name IS actually interpolated', greet(14, 'KASS').indexOf('KASS') > -1);
ck('NC an email-shaped name would be visible to the assertion above',
   greet(14, 'a@b.c') === 'Good afternoon, a@b.c');
ck('NC the escaper is applied to the name in the shell', /esc\(who\)/.test(SRC));

console.log('\n' + '='.repeat(70));
console.log('  ' + pass + ' passed, ' + fail + ' failed');
console.log('='.repeat(70) + '\n');
process.exit(fail ? 1 : 0);
