#!/usr/bin/env node
/* WHERE THE RULES BUDGET ACTUALLY GOES — a read-only structural map.
 *
 * WHY THIS IS NOT A CHARACTER COUNT
 * The ceiling is 256,000 bytes of COMPILED executable. `firestore.rules` is 255,822 source
 * characters. Those are different units, and comparing them is how a "178 bytes free"
 * figure got written into ADR-014. The measured compiled size of the SERVED ruleset
 * 59af870d is 255,551 B — 449 B free.
 *
 * Worse, the two do not move together. The recorded trackb-v1 datapoint added 282 source
 * characters and cost 445 compiled bytes — ~1.58x. So a consolidation planned in source
 * characters can overshoot the compiled budget by more than half again, which is the
 * failure mode that produced a 400 INVALID_ARGUMENT at RELEASE (after the ruleset had
 * already been created, because there is no predeploy guard on ruleset size).
 *
 * WHAT THIS TOOL CAN AND CANNOT TELL YOU
 * It measures SOURCE structure only: how much is comment, how much is indentation, how
 * many match blocks and functions exist, and which of them are textually duplicated. That
 * is enough to RANK consolidation candidates and to size the opportunity in the only
 * currency this file can be edited in.
 *
 * It CANNOT tell you what any of that is worth in compiled bytes. Whether stripping
 * comments and indentation frees a single compiled byte is UNPROVEN — the signature
 * (compiled 255,551 > source 255,822 is close, but compiled is ~1.67x the code-only size)
 * is consistent with a bytecode form in which comments have already vanished, in which
 * case tens of thousands of comment characters are worth exactly zero. Do not plan against
 * these numbers as if they were budget. They are a map, not a measurement of the ceiling.
 *
 *   node scripts/audit-rules-budget.js [file]
 */
'use strict';
const fs = require('fs');

const FILE = process.argv[2] || 'firestore.rules';
const src = fs.readFileSync(FILE, 'utf8');
const NL = String.fromCharCode(10);
const lines = src.split(NL);

/* ── gross composition ─────────────────────────────────────────────────────── */
let comment = 0, indent = 0, blank = 0, code = 0;
let inBlock = false;
for (const raw of lines) {
  const lead = raw.length - raw.replace(/^\s+/, '').length;
  indent += lead;
  const t = raw.trim();
  if (!t) { blank += 1; continue; }
  if (inBlock) { comment += t.length; if (t.indexOf('*/') > -1) inBlock = false; continue; }
  if (t.indexOf('/*') === 0) { comment += t.length; if (t.indexOf('*/') < 0) inBlock = true; continue; }
  if (t.indexOf('//') === 0) { comment += t.length; continue; }
  const ix = t.indexOf('//');
  if (ix > 0) { code += ix; comment += t.length - ix; continue; }
  code += t.length;
}

const pct = (n) => (n * 100 / src.length).toFixed(1) + '%';
console.log('');
console.log('  ' + FILE);
console.log('  ' + '-'.repeat(64));
console.log('  source characters   ' + String(src.length).padStart(9));
console.log('  utf-8 bytes         ' + String(Buffer.byteLength(src)).padStart(9) +
            '   (' + (Buffer.byteLength(src) - src.length) + ' from multi-byte glyphs)');
console.log('  lines               ' + String(lines.length).padStart(9));
console.log('');
console.log('  code (non-comment)  ' + String(code).padStart(9) + '   ' + pct(code));
console.log('  comments            ' + String(comment).padStart(9) + '   ' + pct(comment));
console.log('  indentation         ' + String(indent).padStart(9) + '   ' + pct(indent));
console.log('  blank lines         ' + String(blank).padStart(9) + '   lines');

/* ── code-only view: what the compiler plausibly sees ──────────────────────── */
const codeOnly = src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split(NL).map((l) => l.replace(/\/\/.*$/, '').trim())
  .filter((l) => l).join(NL);
console.log('');
console.log('  code-only size      ' + String(codeOnly.length).padStart(9) +
            '   (comments + indentation + blanks removed)');
console.log('  removable in SOURCE ' + String(src.length - codeOnly.length).padStart(9) +
            '   <- worth UNKNOWN compiled bytes. Not budget.');

/* ── structure ─────────────────────────────────────────────────────────────── */
const fnDefs = [];
const reFn = /function\s+([A-Za-z0-9_]+)\s*\(([^)]*)\)/g;
let m;
while ((m = reFn.exec(codeOnly))) fnDefs.push(m[1]);
const fnCount = {};
fnDefs.forEach((n) => { fnCount[n] = (fnCount[n] || 0) + 1; });
const dupFns = Object.keys(fnCount).filter((n) => fnCount[n] > 1);

const matches = [];
const reMatch = /match\s+(\/[^\s{]+)/g;
while ((m = reMatch.exec(codeOnly))) matches.push(m[1]);
const mCount = {};
matches.forEach((p) => { mCount[p] = (mCount[p] || 0) + 1; });
const dupMatches = Object.keys(mCount).filter((p) => mCount[p] > 1);

console.log('');
console.log('  function definitions ' + String(fnDefs.length).padStart(8) +
            '   distinct ' + Object.keys(fnCount).length);
console.log('  match blocks         ' + String(matches.length).padStart(8) +
            '   distinct paths ' + Object.keys(mCount).length);

if (dupFns.length) {
  console.log('');
  console.log('  DEFINED MORE THAN ONCE — helpers (each redefinition is compiled weight):');
  dupFns.sort((a, b) => fnCount[b] - fnCount[a])
    .forEach((n) => console.log('    x' + fnCount[n] + '  function ' + n + '()'));
}
if (dupMatches.length) {
  console.log('');
  console.log('  DECLARED MORE THAN ONCE — match paths (a second block for one path is');
  console.log('  the structural duplication most likely to be worth real compiled bytes):');
  dupMatches.sort((a, b) => mCount[b] - mCount[a]).slice(0, 25)
    .forEach((p) => console.log('    x' + mCount[p] + '  match ' + p));
  if (dupMatches.length > 25) console.log('    ... and ' + (dupMatches.length - 25) + ' more');
}

/* ── identical rule LINES: the cheapest structural signal available ────────── */
const ruleLines = {};
codeOnly.split(NL).forEach((l) => {
  if (!/^allow\s/.test(l)) return;
  ruleLines[l] = (ruleLines[l] || 0) + 1;
});
const repeated = Object.keys(ruleLines).filter((l) => ruleLines[l] > 2)
  .sort((a, b) => ruleLines[b] * b.length - ruleLines[a] * a.length);
if (repeated.length) {
  console.log('');
  console.log('  REPEATED allow LINES (>2x) — ranked by total characters spent:');
  repeated.slice(0, 12).forEach((l) => {
    console.log('    x' + String(ruleLines[l]).padStart(3) + '  ' +
      String(ruleLines[l] * l.length).padStart(6) + ' ch  ' + l.slice(0, 78));
  });
}

console.log('');
console.log('  ' + '-'.repeat(64));
console.log('  THESE ARE SOURCE CHARACTERS. The ceiling is COMPILED BYTES.');
console.log('  Nothing here establishes how much compiled budget any of it frees.');
console.log('  Measure a candidate by compiling it, never by subtracting characters.');
console.log('');
