#!/usr/bin/env node
/* THE ACCEPTANCE GATE FOR A CONSOLIDATION CANDIDATE — checked independently.
 *
 * build-rules-candidate.js asserts its own postconditions, which is worth something but is
 * the weaker kind of evidence: a script that both performs a transformation and certifies
 * it can share a wrong assumption with itself. This re-derives every structural condition
 * from the two FILES, with no knowledge of how the candidate was produced, and reads the
 * production release from the API rather than trusting any earlier output.
 *
 * It does NOT re-run the differential equivalence (that is verify-rules-equivalence.js, and
 * takes ~40 minutes); it takes that verdict as an input the operator supplies.
 *
 *   node scripts/verify-candidate-gate.js <served> <candidate>
 */
'use strict';
const fs = require('fs');
const { spawnSync } = require('child_process');
const NL = String.fromCharCode(10);

const SERVED = process.argv[2] || 'firestore.rules.served-59af870d';
const CAND = process.argv[3] || 'firestore.rules.candidate-a';
const PROJECT = 'sokoni-aeb26';
const PY = 'C:/Users/USER1/AppData/Local/Google/Cloud SDK/google-cloud-sdk/platform/bundledpython/python.exe';

/* the release state recorded before any of this slice's work began */
const EXPECT_RULESET = '59af870d-72eb-4791-a3b6-2f4de7eb8ff7';
const EXPECT_UPDATED = '2026-08-28T14:49:34.255213Z';

const EXCLUDED = ['posTransactions', 'inventory', 'adminLog', 'shopEmployees',
                  'merchantStories', 'storyAllocations', 'posSales', 'posRetailSales',
                  'posStaff', 'posApprovals'];

const a = fs.readFileSync(SERVED, 'utf8');
const b = fs.readFileSync(CAND, 'utf8');

let pass = 0, fail = 0;
const ck = (label, cond, note) => {
  if (cond) { pass++; console.log('  PASS  ' + label); }
  else { fail++; console.log('  FAIL  ' + label + (note ? NL + '          ' + note : '')); }
};

console.log('');
console.log('  served    ' + SERVED + '   ' + a.length + ' ch');
console.log('  candidate ' + CAND + '   ' + b.length + ' ch');
console.log('');

/* ── 4 · the shopEmployees anchor, byte-identical ─────────────────────────── */
function blockOf (src, needle) {
  const i = src.indexOf(needle);
  if (i < 0) return null;
  /* walk to the block's closing brace, ignoring braces inside {var} path segments */
  let depth = 0, started = false;
  for (let k = i; k < src.length; k++) {
    const ch = src[k];
    if (ch === '{') {
      /* a path variable looks like {word} with no newline before its close */
      const close = src.indexOf('}', k);
      const inner = close > -1 ? src.slice(k + 1, close) : '';
      if (/^[A-Za-z0-9_=*]+$/.test(inner) && inner.length && src.slice(k, close).indexOf(NL) === -1 && !started) {
        k = close; continue;
      }
      depth++; started = true;
    } else if (ch === '}') {
      depth--;
      if (started && depth === 0) return src.slice(i, k + 1);
    }
  }
  return null;
}

const anchorA = blockOf(a, 'match /shopEmployees/');
const anchorB = blockOf(b, 'match /shopEmployees/');
ck('shopEmployees block extracted from both', !!anchorA && !!anchorB);
ck('shopEmployees block BYTE-IDENTICAL', !!anchorA && anchorA === anchorB,
   anchorA && anchorB ? 'served ' + anchorA.length + ' ch vs candidate ' + anchorB.length + ' ch' : 'not extracted');
ck('shopOwnerId update-immutability clause present in candidate',
   /request\.resource\.data\.shopOwnerId\s*==\s*resource\.data\.shopOwnerId/.test(b));
ck('shopOwnerId clause count unchanged',
   (a.match(/shopOwnerId/g) || []).length === (b.match(/shopOwnerId/g) || []).length,
   'served ' + (a.match(/shopOwnerId/g) || []).length + ' -> candidate ' + (b.match(/shopOwnerId/g) || []).length);

/* ── 5 · granting-rule count unchanged ────────────────────────────────────── */
/* COUNT CODE, NOT PROSE. Counting on raw text also counts `allow` written inside
   comments — the served file has three, including a line reading
   "// the `allow write: if false` guard in the Digital Products Hub section". That made
   this check report 1,319 where the code contains 1,316. It happened to be harmless while
   both sides carried identical comments, but Group B deliberately KEEPS comments whose
   clause has been removed, so comment-resident `allow` text can shift — and a contaminated
   count could then fail spuriously, or worse, cancel out a real change. */
const decommentFor = (s) => {
  let b2 = false;
  return s.split(NL).map((l) => {
    let t = l;
    if (b2) { const e = t.indexOf('*/'); if (e < 0) return ''; b2 = false; t = t.slice(e + 2); }
    t = t.replace(/\/\*[\s\S]*?\*\//g, '');
    const o = t.indexOf('/*'); if (o > -1) { b2 = true; t = t.slice(0, o); }
    return t.replace(/\/\/.*$/, '');
  }).join(NL);
};
const codeA = decommentFor(a), codeB = decommentFor(b);
const RE_ALLOW = /allow[ \ta-z,]+:\s*if\s+/g;
const RE_FALSE = /allow[ \ta-z,]+:\s*if\s+false\s*;/g;
const allowA = (codeA.match(RE_ALLOW) || []).length, allowB = (codeB.match(RE_ALLOW) || []).length;
const falseA = (codeA.match(RE_FALSE) || []).length, falseB = (codeB.match(RE_FALSE) || []).length;
ck('granting rules unchanged  (' + (allowA - falseA) + ')',
   (allowA - falseA) === (allowB - falseB),
   'served ' + (allowA - falseA) + ' -> candidate ' + (allowB - falseB));
console.log('        constant-false rules removed: ' + (falseA - falseB) +
            '   (served ' + falseA + ' -> candidate ' + falseB + ')');

/* ── 6 · excluded scopes untouched ────────────────────────────────────────── */
let exOk = true;
const exDetail = [];
EXCLUDED.forEach((name) => {
  const ca = (a.match(new RegExp(name, 'g')) || []).length;
  const cb = (b.match(new RegExp(name, 'g')) || []).length;
  if (ca !== cb) { exOk = false; exDetail.push(name + ': ' + ca + ' -> ' + cb); }
});
ck('all ' + EXCLUDED.length + ' excluded surfaces have identical occurrence counts',
   exOk, exDetail.join('; '));

/* ── structural sanity: only whole blocks were removed ────────────────────── */
const RE_MATCHDECL = /match\s+\/[^{\s]*(?:\{[^}]*\}[^{\s]*)*\s*\{/g;
const mA = (a.match(RE_MATCHDECL) || []).length, mB = (b.match(RE_MATCHDECL) || []).length;
console.log('        match blocks: served ' + mA + ' -> candidate ' + mB + '   (-' + (mA - mB) + ')');
/* NOTHING WAS ADDED OR REWRITTEN — stated so it survives Group B.
   Group A only deleted whole blocks, so "candidate lines are a subset of served lines"
   held. Group B EXCISES a clause from 26 one-line blocks and keeps comments on their own
   lines, so a plain subset test fails for correct output. The property that actually
   matters is about CODE: every candidate code line is either a served code line, or a
   served code line with constant-false clauses removed. Anything else means something was
   introduced or reworded, which is the failure mode this check exists for. */
const codeLines = (s) => decommentFor(s).split(NL).map((l) => l.replace(/\s+/g, ' ').trim()).filter((l) => l);
ck('every candidate code line derives from a served code line (nothing added or rewritten)', (() => {
  const A = codeLines(a), B = codeLines(b);
  const allowed = new Set();
  A.forEach((l) => {
    allowed.add(l);
    const stripped = l.replace(/allow[ \ta-z,]+:\s*if\s+false\s*;/g, '').replace(/\s+/g, ' ').trim();
    if (stripped) allowed.add(stripped);
  });
  const orphans = B.filter((l) => !allowed.has(l));
  if (orphans.length) {
    console.log('        ' + orphans.length + ' orphan line(s), first: ' + orphans[0].slice(0, 96));
    return false;
  }
  return true;
})());
ck('candidate introduces no granting clause absent from served', (() => {
  const g = (s) => new Set((decommentFor(s).match(/allow[ \ta-z,]+:\s*if\s+(?!false\s*;)[^;]*;/g) || [])
    .map((x) => x.replace(/\s+/g, ' ').trim()));
  const A = g(a), B = g(b);
  const added = Array.from(B).filter((x) => !A.has(x));
  if (added.length) { console.log('        added: ' + added[0].slice(0, 96)); return false; }
  return true;
})());

/* ── 8 · production release unchanged ─────────────────────────────────────── */
const tk = spawnSync('gcloud', ['auth', 'print-access-token'],
  { encoding: 'utf8', shell: true, env: Object.assign({}, process.env, { CLOUDSDK_PYTHON: PY }) });
const TOKEN = String(tk.stdout || '').trim();
if (!TOKEN) { ck('production release readable', false, 'no access token'); }
else {
  const r = spawnSync('curl', ['-s',
    '-H', 'Authorization: Bearer ' + TOKEN,
    '-H', 'x-goog-user-project: ' + PROJECT,
    'https://firebaserules.googleapis.com/v1/projects/' + PROJECT + '/releases/cloud.firestore'],
    { encoding: 'utf8' });
  let j = null;
  try { j = JSON.parse(String(r.stdout || '')); } catch (_) {}
  const id = j && String(j.rulesetName || '').split('/').pop();
  ck('production cloud.firestore ruleset unchanged', id === EXPECT_RULESET,
     'expected ' + EXPECT_RULESET + ' got ' + id);
  ck('production cloud.firestore updateTime unchanged', j && j.updateTime === EXPECT_UPDATED,
     'expected ' + EXPECT_UPDATED + ' got ' + (j && j.updateTime));
}

console.log('');
console.log('  ' + pass + ' passed, ' + fail + ' failed');
console.log('');
console.log('  NOT covered here — supply separately:');
console.log('    - 20,940-case served <-> candidate equivalence  (verify-rules-equivalence.js)');
console.log('    - served <-> served control at the same scale');
console.log('    - sabotage control detecting divergence');
console.log('    - candidate release succeeds  (measure-rules-compiled-delta.js)');
console.log('');
process.exit(fail > 0 ? 1 : 0);
