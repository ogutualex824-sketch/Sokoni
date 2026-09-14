#!/usr/bin/env node
/* WHAT SHIPS THAT THE COMMISSION GUARD NEVER SEES.
 *
 * READ-ONLY. Changes nothing, fixes nothing. It measures a gap before anything is built to
 * close it.
 *
 * `scripts/verify-commission-single-source.js` enumerates via `git ls-files` — TRACKED files
 * only. But deployment does not care about the index:
 *
 *   hosting    firebase.json public: "."  — the repo root, minus an ignore list
 *   functions  source "functions"        — the whole directory, and there is NO .gcloudignore
 *
 * So an UNTRACKED file inside the deploy footprint ships to production while being invisible
 * to the gate. This repository routinely carries 180+ dirty files, many of them untracked,
 * which is exactly the condition under which that gap matters.
 *
 * This reports the gap AND runs the guard's own detector over it, so the question "is
 * anything actually hiding there right now" is answered with evidence rather than assumed
 * either way.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const NL = String.fromCharCode(10);

const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'firebase.json'), 'utf8'));
let hosting = cfg.hosting; if (Array.isArray(hosting)) hosting = hosting[0];
const IGNORE = (hosting && hosting.ignore) || [];
const FUNCTIONS_SRC = (cfg.functions &&
  (Array.isArray(cfg.functions) ? cfg.functions[0].source : cfg.functions.source)) || 'functions';

/* Minimal glob -> RegExp, adequate for the patterns firebase.json actually uses. */
function globToRe (g) {
  let s = g.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  s = s.replace(/\*\*\//g, '(?:.*/)?').replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*');
  s = s.replace(/\?/g, '[^/]');
  return new RegExp('^' + s + '$');
}
const IGNORE_RE = IGNORE.map(globToRe);
const hostingIgnores = (rel) => IGNORE_RE.some((re) => re.test(rel));

const git = (args) => {
  try { return execSync('git ' + args, { cwd: ROOT, encoding: 'utf8' }).split(NL).filter(Boolean); }
  catch (_) { return []; }
};

const tracked = new Set(git('ls-files'));
const untracked = git('ls-files --others --exclude-standard');

const isCode = (f) => /\.(js|html)$/.test(f);
const inFunctions = (f) => f === FUNCTIONS_SRC || f.indexOf(FUNCTIONS_SRC + '/') === 0;
const inNodeModules = (f) => /(^|\/)node_modules\//.test(f);

/* A file SHIPS if it is deployed by functions (whole dir, no .gcloudignore) or published by
   hosting (root, minus the ignore list). */
function shipsHow (f) {
  if (inNodeModules(f)) return null;
  if (inFunctions(f)) return 'functions';
  if (!hostingIgnores(f)) return 'hosting';
  return null;
}

const shippedUntracked = untracked.filter((f) => isCode(f) && shipsHow(f));

console.log('');
console.log('  DEPLOY FOOTPRINT vs GUARD SCOPE');
console.log('');
console.log('  hosting public        : ' + (hosting && hosting.public));
console.log('  hosting ignore rules  : ' + IGNORE.length);
console.log('  functions source      : ' + FUNCTIONS_SRC + '   (.gcloudignore: ' +
  (fs.existsSync(path.join(ROOT, '.gcloudignore')) ||
   fs.existsSync(path.join(ROOT, FUNCTIONS_SRC, '.gcloudignore')) ? 'present' : 'ABSENT — the whole directory ships') + ')');
console.log('');
console.log('  tracked files (guard scope)     : ' + tracked.size);
console.log('  untracked .js/.html             : ' + untracked.filter(isCode).length);
console.log('  ...of those, INSIDE the deploy  : ' + shippedUntracked.length +
            '   <- ships, never scanned');

if (shippedUntracked.length) {
  const byHow = {};
  shippedUntracked.forEach((f) => { const h = shipsHow(f); (byHow[h] = byHow[h] || []).push(f); });
  Object.keys(byHow).forEach((h) => {
    console.log('');
    console.log('    via ' + h + ' (' + byHow[h].length + '):');
    byHow[h].slice(0, 25).forEach((f) => console.log('      ' + f));
    if (byHow[h].length > 25) console.log('      ... and ' + (byHow[h].length - 25) + ' more');
  });
}

/* ── run the guard's own detector over the gap ─────────────────────────────── */
const RATE = '0\\.(?:0[1-9]|[12]\\d)\\b';
const BARE_RATE = new RegExp(
  '\\b_?(?:platform_?fee(?:_?rate)?|commission_?(?:rate|pct)?|take_?rate|service_?fee)\\s*=\\s*' + RATE, 'i');
const BARE_MULT = new RegExp('\\*\\s*' + RATE + '[^\\n]{0,40}(?:commission|platform\\s*fee)', 'i');
const COMMISSION_MULT = new RegExp('(?:commission|platformFee)[^\\n]{0,40}\\*\\s*' + RATE, 'i');
const DEAD_TABLES = /HUB_COMMISSION_DEFAULTS|DEFAULT_COMMISSION_RATES/;

const hits = [];
shippedUntracked.forEach((f) => {
  let src;
  try { src = fs.readFileSync(path.join(ROOT, f), 'utf8'); } catch (_) { return; }
  src.split(NL).forEach((l, i) => {
    if (/resolveRate|SokoniCommission|calculateCommission|COMMISSION_CONFIG/.test(l)) return;
    if (/\bvat|\bwht|\bdst|\btax/i.test(l)) return;
    if (BARE_RATE.test(l) || BARE_MULT.test(l) || COMMISSION_MULT.test(l) || DEAD_TABLES.test(l)) {
      hits.push(f + ':' + (i + 1) + '  ' + l.trim().slice(0, 70));
    }
  });
});

console.log('');
console.log('  ' + '='.repeat(66));
if (hits.length) {
  console.log('  ' + hits.length + ' COMMISSION-RATE PATTERN(S) IN SHIPPING, UNSCANNED FILES:');
  hits.slice(0, 20).forEach((h) => console.log('    ' + h));
  if (hits.length > 20) console.log('    ... and ' + (hits.length - 20) + ' more');
} else {
  console.log('  No commission-rate pattern found in the unscanned shipping files.');
  console.log('  The gap is real but currently UNEXPLOITED. That is a fact about today,');
  console.log('  not a property of the gate — the next untracked file could carry one.');
}
console.log('  ' + '='.repeat(66));
console.log('');
