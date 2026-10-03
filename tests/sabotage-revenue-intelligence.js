/* Pre-flight sabotage for the Revenue Intelligence certification.

   The mutations are the money defects that actually matter on this surface:
   matching a status production never writes, dropping the case fold, counting
   non-completed payments as money, turning an unknown amount into zero, hiding
   a partial read, losing the dormancy disclosure, and mislabelling rail volume
   as revenue.

   Always restores in a `finally`, so a mutation is never stranded.

   RUN
     node tests/sabotage-revenue-intelligence.js
*/
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT  = path.resolve(__dirname, '..');
const SUITE = path.join(ROOT, 'tests/certify-revenue-intelligence.js');
const MOD   = 'sokoni-revenue-intelligence.js';

const MUTATIONS = [
  { name: 'S1 the case fold is dropped (the classic zero-revenue bug)',
    file: MOD,
    from: "return String(doc && doc.status || '').toUpperCase() === 'COMPLETE';",
    to:   "return String(doc && doc.status || '') === 'COMPLETE';",
    expect: /A1/ },

  { name: 'S2 completion matches a spelling production never writes',
    file: MOD,
    from: "=== 'COMPLETE';",
    to:   "=== 'SUCCEEDED';",
    expect: /A1|A2|A3/ },

  { name: 'S3 a status production never writes is accepted as money',
    file: MOD,
    from: "  function _isComplete(doc) {",
    to:   "  function _isComplete(doc) {\n    if (String(doc && doc.status || '').toLowerCase() === 'succeeded') return true;",
    expect: /A2/ },

  { name: 'S4 every payment counts toward volume, not only completed ones',
    file: MOD,
    from: "      if (!_isComplete(r)) return;\n      out.complete++;",
    to:   "      out.complete++;",
    expect: /A3/ },

  { name: 'S5 an unreadable amount is coerced to zero',
    file: MOD,
    from: "    var n = Number(a);\n    return isFinite(n) ? n : null;",
    to:   "    var n = Number(a);\n    return isFinite(n) ? n : 0;",
    expect: /B1|B4/ },

  { name: 'S6 an empty range reports KES 0 instead of unknown',
    file: MOD,
    from: "    if (sawAmount) {",
    to:   "    out.volume = 0; out.fees = 0; out.net = 0;\n    if (sawAmount) {",
    expect: /B1|B2/ },

  { name: 'S7 a measured zero is hidden as unknown',
    file: MOD,
    from: "  function _kes(v) {\n    if (v == null) return EM;",
    to:   "  function _kes(v) {\n    if (v == null || v === 0) return EM;",
    /* Caught by B6, the RENDER-level check. B3 only covers the aggregate, and
       this defect lives in the formatter that runs after it. */
    expect: /B6/ },

  { name: 'S8 a negative fee is allowed through',
    file: MOD,
    from: "    return Math.max(0, amt - net);",
    to:   "    return amt - net;",
    expect: /B5/ },

  { name: 'S9 the dormancy disclosure is removed',
    file: MOD,
    /* Structure-preserving on purpose: only the WORDS change. An earlier
       attempt rewrote the expression and broke parsing, which made the harness
       crash — and a crash scored as "caught" while proving nothing about the
       assertion. The runner now rejects crashes outright, and this mutation
       leaves the code valid so the detection is real. */
    from: "'The most recent payment anywhere in the collection is '",
    to:   "'Latest activity was on '",
    expect: /D2/ },

  { name: 'S10 a partial (capped) read is presented as a total',
    file: MOD,
    from: "        (_pay.capped",
    to:   "        (false",
    expect: /B7/ },

  { name: 'S11 rail volume is relabelled as Total Revenue',
    file: MOD,
    from: "card('Rail volume'",
    to:   "card('Total Revenue'",
    expect: /C1/ },

  { name: 'S12 a fabricated AI insight is rendered',
    file: MOD,
    from: "  function _overview(cur, prev) {",
    to:   "  function _overview(cur, prev) {\n    var _i = '<p>Revenue increased 10.7% driven by new enterprise clients</p>';",
    skip: true,   /* inserted but unused -> an INERT mutation; see note below */
    expect: /E2/ },

  { name: 'S12b a fabricated AI insight is actually rendered',
    file: MOD,
    from: "    return _kpis(cur, prev) +",
    to:   "    return '<p>Revenue increased 10.7% driven by new enterprise clients</p>' + _kpis(cur, prev) +",
    expect: /E2/ },

  { name: 'S13 an unbuildable panel is invented without a source',
    file: MOD,
    from: "      ['Revenue by geography', 'No payment or order document carries a country or region field. ' +",
    to:   "      ['Revenue by geography', 'Top region: Nairobi 48.2%. ' +",
    expect: /E1/ },

  { name: 'S14 the module gains a write path',
    file: MOD,
    from: "  function load() {",
    to:   "  function _bad(){ return _db().collection('x').doc('y').set({a:1}); }\n  function load() {",
    expect: /F1/ },

  { name: 'S15 the Super Admin sidebar entry is removed',
    file: 'super-admin.html',
    from: '<button class="nav-item" data-section="revenue"',
    to:   '<button class="nav-item" data-section="revenue-REMOVED"',
    expect: /F3/ },
];

function runSuite() {
  try {
    execFileSync(process.execPath, [SUITE], { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' });
    return { code: 0, out: '' };
  } catch (e) {
    return { code: e.status === undefined ? -1 : e.status, out: (e.stdout || '') + (e.stderr || '') };
  }
}

let inert = 0, caught = 0, skipped = 0;
console.log('\nPRE-FLIGHT SABOTAGE — REVENUE INTELLIGENCE\n' + '='.repeat(64));

for (const m of MUTATIONS) {
  if (m.skip) {
    /* Kept in the file as a documented NON-mutation: it declares an unused
       variable, so it changes no behaviour. It is listed rather than deleted so
       nobody re-adds it later believing it proves something. */
    console.log('  - ' + m.name + '  — skipped (inserts dead code; proves nothing)');
    skipped++;
    continue;
  }
  const p = path.join(ROOT, m.file);
  const original = fs.readFileSync(p, 'utf8');
  if (original.indexOf(m.from) === -1) {
    console.log('  ? ' + m.name + '  — ANCHOR NOT FOUND');
    inert++;
    continue;
  }
  fs.writeFileSync(p, original.replace(m.from, m.to), 'utf8');
  let r;
  try { r = runSuite(); } finally { fs.writeFileSync(p, original, 'utf8'); }

  if (r.code === 0) {
    console.log('  ✗ ' + m.name + '  — SUITE STAYED GREEN (assertion is INERT)');
    inert++;
  } else if (/HARNESS CRASHED/.test(r.out)) {
    /* A non-zero exit from a CRASH is not a detection. The mutation broke the
       module rather than being caught by an assertion, so this proves nothing
       about coverage and must not be scored as a catch. */
    console.log('  ✗ ' + m.name + '  — CRASHED the harness (not a detection)');
    inert++;
  } else if (m.expect.test(r.out)) {
    console.log('  ✓ ' + m.name + '  — caught by the expected case');
    caught++;
  } else {
    console.log('  ~ ' + m.name + '  — failed, but NOT on the expected case');
    caught++;
  }
}

console.log('='.repeat(64));
console.log('  caught: ' + caught + '   inert: ' + inert + '   skipped: ' + skipped);
const after = runSuite();
console.log('  post-restore suite: ' +
  (after.code === 0 ? 'GREEN (nothing stranded)' : 'RED — A MUTATION WAS STRANDED'));
process.exit(inert === 0 && after.code === 0 ? 0 : 1);
