/* AFTER-PROOF — no fabricated metrics in business-analytics.html.
   ==========================================================================
   Run:  node scripts/after-analytics-metrics.js

   Pairs with docs/BUSINESS-ANALYTICS-METRICS-PROOF.md (before-proof, cd5adc6),
   which traced every surface and found seven figures typed into the file and shown
   as measurements.

   THE NEGATIVE CONTROL MATTERS MOST HERE.
   Every assertion below is "this literal is ABSENT". A scanner pointed at the wrong
   file, or one whose patterns stopped matching, reports absence just as cheerfully
   as a fixed page does. So the run first proves it is looking at the right file and
   that its patterns still FIRE — against the pre-fix source from git — and refuses
   to score anything if that fails.
   ==========================================================================*/
'use strict';
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

let pass = 0, fail = 0;
const ck = (label, ok, detail) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + label + (detail ? '   [' + detail + ']' : ''));
  ok ? pass++ : fail++;
};

const ROOT = path.join(__dirname, '..');
const FILE = 'business-analytics.html';
const now = fs.readFileSync(path.join(ROOT, FILE), 'utf8');

/* Comments are not code. The fix DESCRIBES the removed literals in its comments —
   counting those would report the defect as still present. */
const strip = (s) => s
  .replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '))
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  .replace(/^[ \t]*\/\/.*$/gm, (m) => ' '.repeat(m.length));

const code = strip(now);

/* The seven fabricated figures, by the literal that produced each. */
const FABRICATED = [
  { name: 'health component series', re: /\{\s*id\s*:\s*\d\s*,\s*val\s*:\s*\d+\s*\}/ },
  { name: 'revenue actuals series',  re: /\b148000\b|\b162000\b|\b205000\b/ },
  { name: 'revenue targets series',  re: /\b150000\b|\b165000\b|\b190000\b/ },
  { name: 'new customers = 47',      re: /\bnewCust\s*=\s*47\b/ },
  { name: 'marketing spend = 18800', re: /\bspend\s*=\s*18800\b/ },
  { name: 'CAC derived from those',  re: /Math\.round\(\s*spend\s*\/\s*newCust\s*\)/ },
  /* The literal is `'34<span …>%</span>'`, so the digits are preceded by a QUOTE,
     not by '>'. The first version looked for `>34<` and never fired — which the
     negative control caught before a single "absent" row was scored. */
  { name: "repeat rate '34%'",       re: /repeatRate[^;]*['"]34</ },
  { name: "CAC trend 'down 12%'",    re: /cacTrend[^;]*↓\s*12%/ },
];

console.log('\n  business-analytics — fabricated metrics after-proof\n');

/* ── NEGATIVE CONTROL: the patterns must FIRE on the pre-fix source ── */
console.log('  ── negative control (pre-fix source from git)');
let pre = '';
try { pre = execSync('git show cd5adc6:' + FILE, { cwd: ROOT, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }); }
catch (e) { pre = ''; }
const preCode = strip(pre);
const fired = FABRICATED.filter((f) => f.re.test(preCode));
ck('the pre-fix source was readable', pre.length > 1000, pre.length + ' chars from cd5adc6');
ck('every pattern FIRES on the pre-fix source (they are not dead regexes)',
  fired.length === FABRICATED.length,
  fired.length + ' of ' + FABRICATED.length + ' fired'
    + (fired.length < FABRICATED.length
      ? ' — MISSING: ' + FABRICATED.filter((f) => !fired.includes(f)).map((f) => f.name).join(', ')
      : ''));
if (fired.length !== FABRICATED.length || pre.length < 1000) {
  console.log('\n  RUN VOID — the detector cannot be shown to work, so "absent" proves nothing.\n');
  process.exit(1);
}

/* ── the assertions ── */
console.log('\n  ── the seven fabricated figures are gone from CODE');
for (const f of FABRICATED) {
  ck(f.name.padEnd(30) + ' absent', !f.re.test(code), '');
}

console.log('\n  ── the honest states that were already correct still are');
for (const [label, re] of [
  ['Top products unavailable', /Product ranking not available yet/],
  ['Staff table unavailable',  /Staff performance not available yet/],
  ['B2B split unavailable',    /Customer split not available yet/],
]) ck(label, re.test(now), '');

console.log('\n  ── the new honest states');
for (const [label, re] of [
  ['Business health unavailable',    /Business health not available yet/],
  ['Revenue trend unavailable',      /Revenue trend not available yet/],
  ['Acquisition metrics unavailable',/Acquisition metrics not available yet/],
]) ck(label, re.test(now), '');

console.log('\n  ── the real source is untouched');
ck('subscription still reads planSubscriptions/{uid}',
  /planSubscriptions/.test(code) && /renderSubStatus/.test(code), '');

console.log('\n  ── nothing was invented to fill the gap');
/* The fix must not have added a query, callable or endpoint. Compare counts
   against the pre-fix file: they may go DOWN, never up. */
const countIn = (s, re) => (s.match(re) || []).length;
const READS = /getDocs\s*\(|onSnapshot\s*\(|httpsCallable\s*\(|fetch\s*\(|\/api\//g;
const before = countIn(preCode, READS), after = countIn(code, READS);
ck('no new data source added', after <= before, 'reads before=' + before + ' after=' + after);
ck('no zeros substituted for the removed figures',
  !/textContent\s*=\s*['"]0['"]/.test(code)
  && !/newCust\s*=\s*0\b/.test(code) && !/spend\s*=\s*0\b/.test(code), '');

console.log('\n  ' + pass + ' passed, ' + fail + ' failed');
console.log('  Static. It proves the literals are gone and the honest states are present;');
console.log('  it does not prove how the page LOOKS. A browser pass covers that.\n');
process.exit(fail ? 1 : 0);
