/* Pre-flight sabotage for the AdminOS Products certification.

   The mutations are the ways this surface could lie about inventory: collapsing
   an unmetered product into zero, hiding a real stockout, merging the two
   buckets in the tally, defaulting an unknown status to active, dropping the
   loaded-page disclaimer, and taking write authority.

   Restores in a `finally`, and a mutation that CRASHES the harness is scored as
   inert rather than caught — a non-zero exit from a crash proves nothing about
   an assertion.

   RUN  node scripts/sabotage-aos-products.js
*/
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT  = path.resolve(__dirname, '..');
const SUITE = path.join(ROOT, 'scripts/test-aos-products.js');
const MOD   = 'sokoni-aos-products.js';

const MUTATIONS = [
  { name: 'S1 an absent stock field collapses to zero',
    from: "      return { kind: 'unmetered', n: null };      /* never metered — not zero */",
    to:   "      return { kind: 'out', n: 0 };",
    expect: /A1|A5|B1/ },

  { name: 'S2 unmetered keeps its kind but reports 0 instead of null',
    from: "    if (raw === undefined || raw === null || raw === '') {\n      return { kind: 'unmetered', n: null };",
    to:   "    if (raw === undefined || raw === null || raw === '') {\n      return { kind: 'unmetered', n: 0 };",
    expect: /A1/ },

  { name: 'S3 a real measured zero is hidden as unmetered',
    from: "    if (n <= 0)      return { kind: 'out', n: 0 };   /* a real, canonical zero */",
    to:   "    if (n <= 0)      return { kind: 'unmetered', n: null };",
    expect: /A2|A5|B1/ },

  { name: 'S4 null stock is treated as a measured zero',
    from: "    if (raw === undefined || raw === null || raw === '') {",
    to:   "    if (raw === undefined || raw === '') {",
    expect: /A3|A5/ },

  { name: 'S5 the tally merges unmetered into out-of-stock',
    from: "      else if (st.kind === 'unmetered')  t.unmetered++;",
    to:   "      else if (st.kind === 'unmetered')  t.out++;",
    expect: /A5/ },

  { name: 'S6 an unknown status is defaulted to active',
    from: "    var s = String((p && p.status) || '').trim();\n    return s || '(none)';",
    to:   "    var s = String((p && p.status) || '').trim();\n    return s ? 'active' : 'active';",
    expect: /C1|C2/ },

  { name: 'S7 the loaded-page disclaimer is dropped',
    from: "'of these is a platform total.",
    to:   "'of these is the whole catalogue.",
    expect: /B3/ },

  { name: 'S8 escaping is removed from rendered fields',
    from: "  function _esc(v) {\n    return String(v == null ? '' : v).replace(/[&<>\"']/g, function (c) {",
    to:   "  function _esc(v) {\n    return String(v == null ? '' : v).replace(/[\\u0000]/g, function (c) {",
    expect: /D1/ },

  { name: 'S9 the workspace takes its own write authority',
    from: "  var _state = null;",
    to:   "  var _state = null;\n  function _bad(id){ return firebase.functions().httpsCallable('x')({id}); }",
    expect: /E2/ },

  { name: 'S10 mount pretends to render when it cannot',
    from: "      if (!host || !Array.isArray(products)) return false;",
    to:   "      if (!host || !Array.isArray(products)) return true;",
    expect: /E1/ },
];

function runSuite() {
  try {
    execFileSync(process.execPath, [SUITE], { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' });
    return { code: 0, out: '' };
  } catch (e) {
    return { code: e.status === undefined ? -1 : e.status, out: (e.stdout || '') + (e.stderr || '') };
  }
}

let inert = 0, caught = 0;
console.log('\nPRE-FLIGHT SABOTAGE — ADMINOS PRODUCTS\n' + '='.repeat(62));

for (const m of MUTATIONS) {
  const p = path.join(ROOT, MOD);
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
    console.log('  ✗ ' + m.name + '  — SUITE STAYED GREEN (INERT)');
    inert++;
  } else if (/THREW|HARNESS CRASHED/.test(r.out)) {
    console.log('  ✗ ' + m.name + '  — CRASHED (not a detection)');
    inert++;
  } else if (m.expect.test(r.out)) {
    console.log('  ✓ ' + m.name + '  — caught by the expected case');
    caught++;
  } else {
    console.log('  ~ ' + m.name + '  — failed, but NOT on the expected case');
    caught++;
  }
}

console.log('='.repeat(62));
console.log('  caught: ' + caught + '   inert: ' + inert);
const after = runSuite();
console.log('  post-restore suite: ' +
  (after.code === 0 ? 'GREEN (nothing stranded)' : 'RED — A MUTATION WAS STRANDED'));
process.exit(inert === 0 && after.code === 0 ? 0 : 1);
