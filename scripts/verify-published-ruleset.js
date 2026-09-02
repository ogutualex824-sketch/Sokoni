#!/usr/bin/env node
/* POST-DEPLOY VERIFICATION — is production serving exactly the certified artifact?
 *
 * READ THE RESPONSE AS BYTES, DECODE ONCE.
 * The first attempt at this check reported the live ruleset as DIVERGED, with a single
 * differing line — a comment containing box-drawing characters. That was not the artifact.
 * It was the reader: `process.stdin.on('data', d => s += d)` calls toString() on EACH
 * Buffer chunk independently, so a multi-byte character straddling a chunk boundary decodes
 * into replacement characters. The file was fine; the probe corrupted it on the way in.
 *
 * That is the second time in this slice a probe was wrong before the artifact was, and it
 * is the most dangerous kind: it would have justified rolling back a correct deployment,
 * or — with the error in the other direction — waved through a real divergence.
 *
 *   node scripts/verify-published-ruleset.js <expected-file> [rulesetId]
 */
'use strict';
const fs = require('fs');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const PROJECT = 'sokoni-aeb26';
const API = 'https://firebaserules.googleapis.com/v1/projects/' + PROJECT;
const PY = 'C:/Users/USER1/AppData/Local/Google/Cloud SDK/google-cloud-sdk/platform/bundledpython/python.exe';
const EXPECTED_FILE = process.argv[2] || 'firestore.rules.candidate-b';

const tk = spawnSync('gcloud', ['auth', 'print-access-token'],
  { encoding: 'utf8', shell: true, env: Object.assign({}, process.env, { CLOUDSDK_PYTHON: PY }) });
const TOKEN = String(tk.stdout || '').trim();
if (!TOKEN) { console.log('  no access token'); process.exit(1); }

/* buffer:true — decode the whole body once, never per chunk */
function get (path) {
  const r = spawnSync('curl', ['-s',
    '-H', 'Authorization: Bearer ' + TOKEN,
    '-H', 'x-goog-user-project: ' + PROJECT,
    API + path], { encoding: 'buffer', maxBuffer: 1024 * 1024 * 128 });
  return JSON.parse(Buffer.from(r.stdout).toString('utf8'));
}

let pass = 0, fail = 0;
const ck = (l, c, n) => {
  if (c) { pass++; console.log('  PASS  ' + l); }
  else { fail++; console.log('  FAIL  ' + l + (n ? '   [' + n + ']' : '')); }
};

const rel = get('/releases/cloud.firestore');
const liveId = String(rel.rulesetName || '').split('/').pop();
console.log('');
console.log('  cloud.firestore -> ' + liveId);
console.log('  updateTime         ' + rel.updateTime);
console.log('');

const rs = get('/rulesets/' + liveId);
const live = rs.source.files[0].content;
const expected = fs.readFileSync(EXPECTED_FILE, 'utf8');
const sha = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

console.log('  live file name  ' + rs.source.files[0].name);
console.log('  live sha256     ' + sha(live));
console.log('  expected sha256 ' + sha(expected));
console.log('');

ck('live ruleset is BYTE-IDENTICAL to the certified artifact', live === expected,
   'live ' + live.length + ' ch vs expected ' + expected.length + ' ch');

if (live !== expected) {
  const NL = String.fromCharCode(10);
  const L = live.split(NL), E = expected.split(NL);
  let n = 0;
  for (let i = 0; i < Math.max(L.length, E.length); i++) {
    if (L[i] !== E[i]) {
      n++;
      if (n <= 3) {
        console.log('      line ' + (i + 1));
        console.log('        expected: ' + JSON.stringify(String(E[i] === undefined ? '' : E[i]).slice(0, 80)));
        console.log('        live    : ' + JSON.stringify(String(L[i] === undefined ? '' : L[i]).slice(0, 80)));
      }
    }
  }
  console.log('      differing lines: ' + n);
}

ck('shopEmployees shopOwnerId immutability clause live',
   /request\.resource\.data\.shopOwnerId\s*==\s*resource\.data\.shopOwnerId/.test(live));

const decomment = (s) => {
  const NL = String.fromCharCode(10);
  let b = false;
  return s.split(NL).map((l) => {
    let t = l;
    if (b) { const e = t.indexOf('*/'); if (e < 0) return ''; b = false; t = t.slice(e + 2); }
    t = t.replace(/\/\*[\s\S]*?\*\//g, '');
    const o = t.indexOf('/*'); if (o > -1) { b = true; t = t.slice(0, o); }
    return t.replace(/\/\/.*$/, '');
  }).join(NL);
};
const dc = decomment(live);
const grants = (dc.match(/allow[ \ta-z,]+:\s*if\s+/g) || []).length -
               (dc.match(/allow[ \ta-z,]+:\s*if\s+false\s*;/g) || []).length;
ck('granting clauses live = 1316', grants === 1316, 'got ' + grants);

const ex = get('/releases/cloud.firestore:getExecutable?executableVersion=FIREBASE_RULES_EXECUTABLE_V1');
const bytes = ex.executable ? Buffer.from(ex.executable, 'base64').length : -1;
console.log('');
console.log('  compiled ' + bytes + ' B   free ' + (256000 - bytes));
ck('compiled size is the certified 243,121', bytes === 243121, 'got ' + bytes);

const list = get('/releases?pageSize=100');
const names = (list.releases || []).map((r) => r.name.split('/').pop());
ck('only the three expected releases exist', names.length === 3 &&
   names.indexOf('cloud.firestore') > -1 &&
   names.indexOf('sokoni-ops') > -1 &&
   names.indexOf('sokoni-aeb26.firebasestorage.app') > -1, names.join(', '));
ck('previous ruleset retained for rollback',
   !!get('/rulesets/59af870d-72eb-4791-a3b6-2f4de7eb8ff7').name);

console.log('');
console.log('  ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail > 0 ? 1 : 0);
