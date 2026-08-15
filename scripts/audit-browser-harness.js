#!/usr/bin/env node
/* Browser-suite harness audit — structural, not wording-based
 *
 *   node scripts/audit-browser-harness.js
 *
 * WHY THIS EXISTS
 * A browser suite can print every assertion PASS and still hand the gate a
 * non-result: if teardown runs before the tally and close() hangs, the suite is
 * killed with its verdict unwritten, and the gate records TIMEOUT/FAIL — verdicts
 * that remove it from the blocking set. The coverage disappears without anything
 * turning red in a way that names the cause.
 *
 * A PREVIOUS VERSION OF THIS CHECK GAVE A FALSE ALL-CLEAR.
 * It located each suite's tally with /console.log(...'passed'...)/ and compared
 * positions. test-pos-cart-defer-browser reports "pos cart defer (browser): 12/12"
 * — the substring 'passed' never appears — so the search returned -1, the file was
 * silently skipped, and the audit reported 0 hazards while a real one was live. It
 * then blocked a Gate C run by exiting at 7.8s with no tally at all.
 *
 * So this audit obeys two rules:
 *   1. NO CRITERION MAY DEPEND ON PROSE. Not the tally wording, not the watchdog's
 *      message. Only structure: call sites, containment, and ordering.
 *   2. A FILE IT CANNOT CLASSIFY IS REPORTED AS `undetermined`, NEVER as clean.
 *      A checker that cannot tell must say so; silence is what produced the false
 *      all-clear above.
 *
 * Exit 0 = no hazards and nothing undetermined. Exit 1 = either.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const SCRIPTS = path.join(ROOT, 'scripts');

let BUDGETS = {};
try { BUDGETS = require('./gate-classify.js').SUITE_BUDGET_MS || {}; } catch (_) {}
const BROWSER_BUDGET_MS = 150000;   /* test-inventory.js BROWSER_TIMEOUT_MS */

/* ── 1 · Which suites drive a browser ────────────────────────────────────────
   The runner's own classifier decides who lands in the serialised browser batch,
   so it is the authority. A BROADER probe runs alongside it purely to surface
   disagreement — a suite that drives a browser but is not classified as one would
   run at full concurrency, and that is worth knowing even though it is not what
   this audit is for. */
const RUNNER_CLASSIFIER = (src) =>
  /require\(['"]playwright|\b(webkit|chromium|firefox)\.launch\s*\(/.test(src);
const BROADER = (src) => /playwright|\.newPage\(|browser\.close\(/i.test(src);

/* test-inventory.js IS the runner, not a suite. It excludes itself from the gate
   population, and this audit must too — otherwise the harness is reported as its
   own hazard ("NO watchdog"), which is true of a runner and meaningless. */
const files = fs.readdirSync(SCRIPTS)
  .filter((f) => /^test-.*\.js$/.test(f) && f !== 'test-inventory.js');

/* Comments are BLANKED, not removed — every offset stays valid, so ordering
   comparisons remain meaningful, while prose that merely mentions browser.close()
   stops being counted as a call site. test-seller-deeplink:305 discusses
   "ctx.close()/browser.close()" in a comment and was reported as a hazard because
   of it. Whitespace substitution keeps line/column arithmetic intact. */
const blankComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  .replace(/(^|[^:])\/\/[^\n]*/g, (m, p) => p + m.slice(p.length).replace(/./g, ' '));

const read = (f) => blankComments(fs.readFileSync(path.join(SCRIPTS, f), 'utf8'));

/* ── 2 · Structural helpers ──────────────────────────────────────────────────
   Deliberately crude but EXPLICIT. Where a judgement cannot be made from
   structure alone the file is marked undetermined rather than assumed safe. */

/* Every close call site, with its index. */
function closeSites(src) {
  const out = [];
  /* ONLY browser.close(). ctx/context.close() is a normal per-viewport loop step and
     does not exhibit the hang the gate actually measured; counting it flagged twelve
     "hazards" that were routine cleanup. A false-positive flood is as useless as the
     earlier false all-clear, just in the opposite direction. */
  const re = /(?:await\s+)?browser\s*\.\s*close\s*\(\s*\)/g;
  let m; while ((m = re.exec(src))) out.push({ i: m.index, text: m[0], awaited: /^await/.test(m[0]) });
  return out;
}

/* Is this call site inside a bounded construct — Promise.race([...timeout...]) or
   an explicit timeout wrapper? Structural: find the nearest enclosing Promise.race
   and check the same bracket group carries a setTimeout. */
function isBounded(src, idx) {
  const head = src.lastIndexOf('Promise.race', idx);
  if (head < 0) return false;
  const open = src.indexOf('[', head);
  if (open < 0 || open > idx) return false;
  /* walk to the matching close bracket */
  let depth = 0, end = -1;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '[') depth++;
    else if (src[i] === ']') { depth--; if (!depth) { end = i; break; } }
  }
  if (end < 0 || idx > end) return false;
  return /setTimeout\s*\(/.test(src.slice(open, end));
}

/* Where does the suite REPORT? Structural: the last console.log before the final
   process.exit — no assumption about its wording. Returns -1 if it cannot tell. */
function reportIndex(src) {
  const exits = [];
  const re = /process\s*\.\s*exit\s*\(/g;
  let m; while ((m = re.exec(src))) exits.push(m.index);
  if (!exits.length) return -1;
  const lastExit = exits[exits.length - 1];
  const logs = [];
  const lre = /console\s*\.\s*log\s*\(/g;
  let l; while ((l = lre.exec(src))) if (l.index < lastExit) logs.push(l.index);
  return logs.length ? logs[logs.length - 1] : -1;
}

/* Watchdogs: a setTimeout whose body calls process.exit. Wording-independent. */
function watchdogs(src) {
  const out = [];
  const re = /setTimeout\s*\(\s*(?:async\s*)?\(?\s*\)?\s*=>\s*\{([\s\S]{0,400}?)\}\s*,\s*(\d+)\s*\)/g;
  let m; while ((m = re.exec(src))) if (/process\s*\.\s*exit\s*\(/.test(m[1])) out.push(Number(m[2]));
  return out;
}

/* ── 3 · Audit ───────────────────────────────────────────────────────────── */
const rows = [];
let hazards = 0, undetermined = 0;

files.forEach((f) => {
  const src = read(f);
  const isRunnerBrowser = RUNNER_CLASSIFIER(src);
  const isBroadBrowser = BROADER(src);
  if (!isRunnerBrowser && !isBroadBrowser) return;

  const name = f.replace(/\.js$/, '');
  const row = { name, classified: isRunnerBrowser, drives: isBroadBrowser, notes: [] };

  /* (a) unbounded close */
  const sites = closeSites(src);
  const unbounded = sites.filter((s) => !isBounded(src, s.i));
  row.closeSites = sites.length;
  row.unbounded = unbounded.length;

  /* (b) teardown before reporting */
  /* A suite has MANY exit paths — a SKIP branch reports and exits long before the
     final tally. Comparing every close against one global report point flagged
     test-returns-states:107, where the tally is printed on line 106 immediately
     above it: report-then-teardown, exactly right, on that path.

     So a close is judged against its OWN path: it is safe if a console.log
     immediately precedes it (that path already reported), and hazardous only if it
     sits before the global report with no report of its own. */
  const rpt = reportIndex(src);
  if (rpt < 0) { row.notes.push('cannot locate report point'); undetermined++; }
  else {
    const reportedOnItsPath = (i) => /console\s*\.\s*log\s*\([\s\S]{0,400}$/.test(src.slice(Math.max(0, i - 400), i));
    const early = unbounded.filter((s) => s.i < rpt && !reportedOnItsPath(s.i));
    row.teardownBeforeReport = early.length;
    if (early.length) { hazards++; row.notes.push(early.length + ' unbounded close BEFORE report'); }
  }

  /* (c) watchdog vs budget */
  const wds = watchdogs(src);
  const budget = BUDGETS[name] || BROWSER_BUDGET_MS;
  row.budget = budget;
  if (!wds.length) { row.notes.push('NO watchdog'); hazards++; }
  else {
    row.watchdog = Math.max(...wds);
    if (row.watchdog >= budget) { row.notes.push('watchdog ' + row.watchdog + ' >= budget ' + budget); hazards++; }
  }

  /* (d) classifier disagreement — not a hazard, but must not be invisible */
  if (isBroadBrowser && !isRunnerBrowser) row.notes.push('drives a browser but NOT in the serialised batch');

  rows.push(row);
});

console.log('\nBROWSER-SUITE HARNESS AUDIT');
console.log('='.repeat(78));
console.log('methodology (all structural — no criterion reads prose):');
console.log('  suites      runner classifier (playwright require / *.launch) + broader probe');
console.log('  unbounded   close() call sites not inside a Promise.race carrying a setTimeout');
console.log('  ordering    unbounded close positioned before the last console.log preceding');
console.log('              the final process.exit — the report point, found structurally');
console.log('  watchdog    setTimeout whose body calls process.exit, compared to the suite');
console.log('              budget from gate-classify.SUITE_BUDGET_MS (default 150000)');
console.log('  unknown     a suite whose report point cannot be located is UNDETERMINED,');
console.log('              never counted as clean');
console.log('='.repeat(78));

rows.forEach((r) => {
  const flag = r.notes.length ? '  ⚠ ' + r.notes.join('; ') : '  ok';
  console.log('  ' + r.name.padEnd(34) +
    'closes=' + String(r.closeSites).padEnd(3) +
    'unbounded=' + String(r.unbounded).padEnd(3) +
    'wd=' + String(r.watchdog || '—').padEnd(7) +
    'budget=' + String(r.budget).padEnd(7) + flag);
});

console.log('='.repeat(78));
console.log('  browser suites audited : ' + rows.length);
console.log('  hazards                : ' + hazards);
console.log('  undetermined           : ' + undetermined);
console.log('  verdict                : ' + (hazards === 0 && undetermined === 0 ? 'CLEAN' : 'NOT CLEAN'));
process.exit(hazards === 0 && undetermined === 0 ? 0 : 1);
