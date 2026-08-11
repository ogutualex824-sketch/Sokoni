#!/usr/bin/env node
/* Build the DEPLOYED firestore ruleset from the documented source.
 *
 *   node scripts/build-firestore-rules.js          # write firestore.rules.build
 *   node scripts/build-firestore-rules.js --check  # report sizes, write nothing
 *
 * WHY THIS EXISTS
 * `firestore.rules` reached 260,215 UTF-8 bytes — 99.3% of the 256 KiB ceiling. At that
 * size the Rules API accepts `POST /rulesets` but REFUSES to release it:
 *
 *     PATCH /releases/cloud.firestore/sokoni-ops  -> 200   (older, smaller ruleset)
 *     PATCH /releases/cloud.firestore             -> 400 INVALID_ARGUMENT
 *     POST  /releases                             -> 409 ALREADY_EXISTS  (CLI fallback)
 *
 * The 409 everyone sees is only the fallback; the real failure is the 400. The last ruleset
 * that released successfully was 255,359 bytes (97.4%). So a rules change could compile,
 * upload, and still never reach production — silently, because the CLI reports the 409.
 *
 * The comments in firestore.rules are NOT noise. They are why the `viewers`-array hole in
 * deliveryLocations was diagnosable at all, and CLAUDE.md requires them. So the source keeps
 * every one of them and the DEPLOYED artifact drops them: ~21% of the file is comment text.
 *
 * SAFETY
 * A regex like /\/\*[\s\S]*?\*\//g would corrupt any '//' or '/*' inside a string literal —
 * in a security-rules file that could silently rewrite an authorization expression. This walks
 * the source character by character and tracks string state, so text inside quotes is never
 * touched. Verified by running the rules test suites against the built output.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'firestore.rules');
const OUT = path.join(ROOT, 'firestore.rules.build');
const LIMIT = 256 * 1024;          /* hard API ceiling */
const WARN_AT = 0.90;              /* shout well before the cliff */

/** Strip comments without ever touching text inside a string literal. */
function strip(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  let quote = null;                /* "'" or '"' when inside a string */

  while (i < n) {
    const c = src[i];
    const d = src[i + 1];

    if (quote) {
      out += c;
      if (c === '\\') { if (i + 1 < n) out += src[i + 1]; i += 2; continue; }
      if (c === quote) quote = null;
      i++;
      continue;
    }

    if (c === '"' || c === "'") { quote = c; out += c; i++; continue; }

    if (c === '/' && d === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end === -1 ? n : end + 2;
      continue;
    }
    if (c === '/' && d === '/') {
      const end = src.indexOf('\n', i);
      i = end === -1 ? n : end;     /* keep the newline itself */
      continue;
    }

    out += c;
    i++;
  }
  return out;
}

/** Collapse the whitespace a stripped file leaves behind. Indentation is not semantic here. */
function tidy(src) {
  return src
    .split(/\r?\n/)
    .map((l) => l.replace(/[ \t]+$/, ''))   /* trailing space */
    .map((l) => l.replace(/^[ \t]+/, (m) => ' '.repeat(Math.min(m.replace(/\t/g, '  ').length, 2))))
    .filter((l) => l.trim() !== '')          /* blank lines */
    .join('\n') + '\n';
}

const src = fs.readFileSync(SRC, 'utf8');
const built = tidy(strip(src));

const srcBytes = Buffer.byteLength(src, 'utf8');
const outBytes = Buffer.byteLength(built, 'utf8');
const pct = (b) => ((100 * b) / LIMIT).toFixed(1) + '%';

/* Braces must balance exactly — the cheapest possible proof the stripper did not eat
   structure. A real semantic check is the emulator suites run against this output. */
const countOutside = (s, ch) => {
  let q = null, k = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === '\\') { i++; continue; } if (c === q) q = null; continue; }
    if (c === '"' || c === "'") { q = c; continue; }
    if (c === ch) k++;
  }
  return k;
};
const open = countOutside(built, '{');
const close = countOutside(built, '}');

console.log('firestore rules build');
console.log('  source :', srcBytes.toLocaleString(), 'bytes  (' + pct(srcBytes) + ' of 256 KiB)');
console.log('  built  :', outBytes.toLocaleString(), 'bytes  (' + pct(outBytes) + ' of 256 KiB)');
console.log('  saved  :', (srcBytes - outBytes).toLocaleString(), 'bytes  (' +
            (((srcBytes - outBytes) / srcBytes) * 100).toFixed(1) + '%)');
console.log('  braces :', open, 'open /', close, 'close', open === close ? 'OK' : '*** MISMATCH ***');

if (open !== close) {
  console.error('\nABORT: brace mismatch — the stripper altered structure. Nothing written.');
  process.exit(1);
}
if (outBytes > LIMIT) {
  console.error('\nABORT: built ruleset still exceeds the 256 KiB ceiling.');
  process.exit(1);
}
if (outBytes > LIMIT * WARN_AT) {
  console.error('\nWARNING: built ruleset is above ' + (WARN_AT * 100) + '% of the ceiling.');
  console.error('Stripping comments no longer buys enough room — split the ruleset.');
  process.exit(1);
}

if (process.argv.includes('--check')) {
  console.log('\n  --check: nothing written.');
  process.exit(0);
}

fs.writeFileSync(OUT, built);
console.log('\n  wrote', path.relative(ROOT, OUT));
