#!/usr/bin/env node
/* READ-ONLY census of the AdminOS swallow-then-succeed sites.
 *
 * Classifies each by BACKEND AUTHORITY, because the failure semantics differ:
 *   - a target that does not exist   -> the control can NEVER succeed (worst class)
 *   - a dispatch op missing from the dispatcher's table -> same, via a different route
 *   - a target that exists           -> usually succeeds; the toast lies only on error
 *
 * No writes, no deploys, no production mutation.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const R = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const AOS = R('sokoni-aos.js');
const IDX = R('functions/index.js');
/* The dispatcher itself contains NO op names — it delegates to adminOs._h[op],
   and that table is populated by `exports._h.<name> = ...` in admin-os.js. Reading
   admin-os-dispatch.js for op names reported 12 false "gaps". */
const DISP_HANDLERS = new Set(
  (R('functions/admin-os.js').match(/_h\.([a-zA-Z0-9_]+)\s*=/g) || [])
    .map((m) => m.replace(/_h\./, '').replace(/\s*=/, ''))
);

/* ── the dispatch allowlist, from the shipped client ───────────────────────── */
const setSrc = AOS.match(/_ADMIN_OS_OPS = new Set\(\[([\s\S]*?)\]\)/);
const OPS = new Set(setSrc ? (setSrc[1].match(/'[a-zA-Z0-9_]+'/g) || []).map((s) => s.slice(1, -1)) : []);

/* ── the swallow-then-succeed sites ────────────────────────────────────────── */
const L = AOS.split('\n');
const sites = [];
L.forEach((l, i) => {
  if (!/\.catch\(\s*(?:e|err)?\s*=>\s*_toast/.test(l)) return;
  let j = i + 1, seen = 0, fab = false;
  while (j < L.length && seen < 2) {
    const t = L[j].trim(); j++;
    if (!t) continue;
    seen++;
    if (/_toast\([^)]*"success"/.test(t)) { fab = true; break; }
  }
  if (!fab) return;
  let m = l.match(/_call\(\s*["']([a-zA-Z0-9_]+)["']/);
  if (!m) {
    for (let k = i; k > i - 6 && k >= 0; k--) {
      const mm = L[k].match(/_call\(\s*["']([a-zA-Z0-9_]+)["']/);
      if (mm) { m = mm; break; }
    }
  }
  sites.push({ line: i + 1, fn: m ? m[1] : '(direct-db)' });
});

/* ── existence, by plain substring — no regex escaping to get wrong ────────── */
function exportedInIndex(name) {
  return IDX.indexOf('exports.' + name) > -1;
}
function inDispatcher(name) {
  return DISP_HANDLERS.has(name);
}
function definedAnywhere(name) {
  const dir = path.join(__dirname, '..', 'functions');
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.js'))
    .filter((f) => fs.readFileSync(path.join(dir, f), 'utf8').indexOf(name) > -1);
}

const byFn = {};
sites.forEach((s) => { (byFn[s.fn] = byFn[s.fn] || []).push(s.line); });

console.log('');
console.log('  ADMINOS — swallow-then-succeed census (READ-ONLY)');
console.log('');
console.log('  sites: ' + sites.length + '   distinct targets: ' + Object.keys(byFn).length);
console.log('');

/* CONTROL FIRST — a detector that cannot see a known-present name is worthless */
const CTRL = ['adminProcessPayout', 'adminOsDispatch', 'walletV2Send'];
const ctrlOk = CTRL.every(exportedInIndex);
console.log('  CONTROL  known-exported names visible to the detector: ' +
            CTRL.map((n) => n + '=' + exportedInIndex(n)).join('  '));
const NEG = exportedInIndex('__definitely_not_exported__');
console.log('  CONTROL  a nonexistent name is NOT reported present: ' + (NEG === false));
console.log('  CONTROL  dispatch table: ' + DISP_HANDLERS.size + ' handlers, adminGetOrders=' + DISP_HANDLERS.has('adminGetOrders') + ' __nope__=' + DISP_HANDLERS.has('__nope__'));
if (!ctrlOk || NEG !== false) {
  console.log('');
  console.log('  BLOCKED — the detector failed its own controls. Census below is void.');
  process.exit(1);
}
console.log('');

const rows = [];
Object.keys(byFn).sort().forEach((fn) => {
  const dispatch = OPS.has(fn);
  const exp = exportedInIndex(fn);
  const inDisp = dispatch ? inDispatcher(fn) : null;
  const files = definedAnywhere(fn);
  let verdict;
  if (!exp && files.length === 0) verdict = 'MISSING — no such function anywhere';
  else if (dispatch && !inDisp) verdict = 'DISPATCH GAP — op not in dispatcher';
  else if (dispatch) verdict = 'exists (dispatch)';
  else if (exp) verdict = 'exists (direct)';
  else verdict = 'defined but NOT exported';
  rows.push({ fn, rail: dispatch ? 'dispatch' : 'direct', verdict, lines: byFn[fn] });
});

console.log('  ' + 'TARGET'.padEnd(28) + 'RAIL'.padEnd(10) + 'VERDICT'.padEnd(34) + 'LINES');
rows.forEach((r) => {
  console.log('  ' + r.fn.padEnd(28) + r.rail.padEnd(10) + r.verdict.padEnd(34) + r.lines.join(','));
});

console.log('');
const bad = rows.filter((r) => /MISSING|GAP|NOT exported/.test(r.verdict));
console.log('  ── TIER 1 · the control can NEVER succeed, yet reports success ──');
if (!bad.length) console.log('    none');
bad.forEach((r) => console.log('    ' + r.fn + '  (' + r.verdict + ')  lines ' + r.lines.join(',')));
console.log('');
console.log('  ── TIER 2 · target exists; the toast lies only when the call errors ──');
console.log('    ' + rows.filter((r) => !/MISSING|GAP|NOT exported/.test(r.verdict)).length + ' targets');
console.log('');
console.log('  NOTE: existence in THIS lineage is not proof of what is DEPLOYED.');
console.log('  Functions provenance is unproven — a deployed build cannot be hashed.');
