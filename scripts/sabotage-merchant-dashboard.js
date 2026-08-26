/* Sabotage runner for the living dashboard.
   The headline requirement: ANY ATTEMPT TO FABRICATE A METRIC MUST FAIL THE SUITE.
   Every edit asserts it matched exactly once; every verdict is the EXIT CODE. */
'use strict';
const fs = require('fs');
const { execFileSync } = require('child_process');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const SUITE = 'scripts/test-merchant-dashboard.js';

const CASES = [
  /* ── FABRICATION: the rule that outranks everything ─────────────────────── */
  ['unknown renders as 0 instead of a dash', 'sokoni-merchant-dashboard.js',
   "  var UNKNOWN = '—';", "  var UNKNOWN = '0';"],

  ['money turns an unknown into KES 0', 'sokoni-merchant-dashboard.js',
   "    if (n === null || n === undefined || !isFinite(Number(n))) return UNKNOWN;",
   "    if (n === null || n === undefined || !isFinite(Number(n))) return 'KES 0';"],

  ['the hero invents a takings figure', 'sokoni-merchant-dashboard.js',
   "    out.takings = unknown('Till sales are not readable yet');",
   "    out.takings = known(48240);"],

  ['a trend percentage is invented', 'sokoni-merchant-dashboard.js',
   "    out.trend   = unknown('Needs yesterday’s takings');",
   "    out.trend   = known(18.6);"],

  ['a partial count stops being labelled', 'sokoni-merchant-dashboard.js',
   "      out.orders = partial(t.length, 'Online orders only · till sales not included');",
   "      out.orders = known(t.length);"],

  ['absent stock counts as low (the Number(null) trap)', 'sokoni-merchant-dashboard.js',
   "        if (!p || p.stock === undefined || p.stock === null) return false;",
   "        if (!p) return false;"],

  ['an unparseable timestamp counts as today', 'sokoni-merchant-dashboard.js',
   "        return ms !== null && ms >= today.getTime();",
   "        return ms === null || ms >= today.getTime();"],

  /* ── HONESTY OF PRESENTATION ────────────────────────────────────────────── */
  ['the unknown hero wears the confident skin', 'sokoni-merchant-dashboard.js',
   "'<section class=\"sd-hero' + (heroKnown ? '' : ' sd-hero-unknown') + '\">'",
   "'<section class=\"sd-hero\">'"],

  ['unknowns animate like facts', 'sokoni-merchant-dashboard.js',
   "      if (el.getAttribute('data-count') === '' || !isFinite(target)) return;",
   "      if (false) return;"],

  ['reduced-motion is ignored', 'sokoni-merchant-dashboard.js',
   "      if (reduce) return;", "      if (false) return;"],

  /* ── NAVIGATION ─────────────────────────────────────────────────────────── */
  ['a tile navigates by literal URL', 'sokoni-merchant-dashboard.js',
   "      if (typeof ctx.go === 'function') ctx.go(id);",
   "      location.href = '/' + id;"],

  /* ── THE NARRATIVE INVENTS ──────────────────────────────────────────────── */
  ['the narrative speaks without a source', 'sokoni-merchant-dashboard.js',
   "    if (f.bestSeller) {", "    if (true) { f.bestSeller = f.bestSeller || { name: 'Nike Air Max', sold: 9 };"],

  /* ── SHELL WIRING ───────────────────────────────────────────────────────── */
  ['the shell stops mounting the module', 'merchant-v2.html',
   "    if (root_hasDashboardModule()) return mountDashboardModule(p);",
   "    if (false) return mountDashboardModule(p);"],
];

let caught = 0, missed = 0;
for (const [label, file, find, repl] of CASES) {
  const p = path.join(ROOT, file);
  const orig = fs.readFileSync(p, 'utf8');
  const n = orig.split(find).length - 1;
  if (n !== 1) {
    console.log('  BROKEN PROBE  ' + label + '  (matched ' + n + 'x in ' + file + ')');
    missed++; continue;
  }
  fs.writeFileSync(p, orig.replace(find, repl));
  let code = 0, out = '';
  try { out = execFileSync(process.execPath, [SUITE], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (e) { code = e.status === undefined ? 1 : e.status; out = (e.stdout || '') + (e.stderr || ''); }
  fs.writeFileSync(p, orig);

  const fails = (out.match(/^ {2}FAIL/gm) || []).length;
  console.log('  ' + (code ? 'CAUGHT ' : 'MISSED ') + label.padEnd(50)
    + 'exit=' + code + ' fails=' + fails + (/^ {2}aborted/m.test(out) ? ' (aborted)' : ''));
  if (code) caught++; else missed++;
}

console.log('\n  ' + caught + ' caught, ' + missed + ' missed / not proven');
process.exit(missed ? 1 : 0);
