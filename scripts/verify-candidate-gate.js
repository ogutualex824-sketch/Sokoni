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
const RE_ALLOW = /allow\s+[a-z, ]+\s*:\s*if\s+/g;
const RE_FALSE = /allow\s+[a-z, ]+\s*:\s*if\s+false\s*;/g;
const allowA = (a.match(RE_ALLOW) || []).length, allowB = (b.match(RE_ALLOW) || []).length;
const falseA = (a.match(RE_FALSE) || []).length, falseB = (b.match(RE_FALSE) || []).length;
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
ck('candidate is a strict SUBSET of served lines (nothing added or rewritten)', (() => {
  const sa = a.split(NL), sb = b.split(NL);
  let i = 0;
  for (const line of sb) {
    while (i < sa.length && sa[i] !== line) i++;
    if (i >= sa.length) return false;
    i++;
  }
  return true;
})(), 'a line in the candidate does not appear in served in order');

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
