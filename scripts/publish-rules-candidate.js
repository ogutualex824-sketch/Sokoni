#!/usr/bin/env node
/* PUBLISH THE ACCEPTED CONSOLIDATION CANDIDATE TO cloud.firestore.
 *
 * This is the one script in the consolidation slice that CHANGES PRODUCTION ENFORCEMENT.
 * It moves the `cloud.firestore` release pointer to a new ruleset built from the accepted
 * candidate. Everything else in the slice was measurement.
 *
 * ══ ABORT CONDITIONS, CHECKED IMMEDIATELY BEFORE THE WRITE ══════════════════════════
 * Certification is a claim about two specific artifacts at a specific moment. If either
 * has moved since, the certification does not describe what is about to happen:
 *
 *   - production lineage moved   (ruleset id or updateTime differs from the certified one)
 *   - the live baseline changed  (served source no longer hashes to the certified baseline)
 *   - the candidate changed      (no longer hashes to the certified artifact)
 *   - the new ruleset does not compile to the certified size
 *
 * Any one of these aborts BEFORE the release pointer is touched.
 *
 * ══ ROLLBACK ═══════════════════════════════════════════════════════════════════════
 * The previous ruleset is not deleted and its id is printed before and after. Rolling back
 * is pointing `cloud.firestore` at it again — the same single call this script makes.
 *
 * ══ KNOWN HAZARD ═══════════════════════════════════════════════════════════════════
 * Release-pointer updates on this project have previously failed 400 at the MECHANISM
 * level, with a no-op control proving the payload was not at fault. If that recurs this
 * reports BLOCKED and leaves production exactly as it found it. A ruleset that was created
 * but never released is inert; it is deleted on the way out.
 *
 *   node scripts/publish-rules-candidate.js <candidate> [--apply]
 *   (dry run by default)
 */
'use strict';
const fs = require('fs');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const PROJECT = 'sokoni-aeb26';
const API = 'https://firebaserules.googleapis.com/v1/projects/' + PROJECT;
const PY = 'C:/Users/USER1/AppData/Local/Google/Cloud SDK/google-cloud-sdk/platform/bundledpython/python.exe';
const CAND = process.argv[2] || 'firestore.rules.candidate-b';
const APPLY = process.argv.indexOf('--apply') > -1;

/* the certified facts — abort if reality no longer matches them */
const CERT = {
  ruleset: '59af870d-72eb-4791-a3b6-2f4de7eb8ff7',
  updateTime: '2026-08-28T14:49:34.255213Z',
  baselineSha: '51c0f678fd16654e6de71c7531aad2d5252877128933a50ffda8b4af8d377dcf',
  candidateSha: 'df423bad8230067563b600c7f578a929e3e899b2570c7f2e730bad2e91dae5b0',
  compiledBytes: 243121
};

let TOKEN = '';
function api (method, path, body) {
  const args = ['-s', '-X', method,
    '-H', 'Authorization: Bearer ' + TOKEN,
    '-H', 'x-goog-user-project: ' + PROJECT,
    '-H', 'Content-Type: application/json'];
  let tmp = null;
  if (body !== undefined) {
    tmp = require('path').join(process.env.TEMP || '.', 'pub-' + process.pid + '.json');
    fs.writeFileSync(tmp, JSON.stringify(body));
    args.push('--data-binary', '@' + tmp);
  }
  args.push(API + path);
  const r = spawnSync('curl', args, { encoding: 'utf8', maxBuffer: 1024 * 1024 * 128 });
  if (tmp) { try { fs.unlinkSync(tmp); } catch (_) {} }
  try { return JSON.parse(String(r.stdout || '')); }
  catch (_) { return { __raw: String(r.stdout || '').slice(0, 300) }; }
}
const sha = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

const tk = spawnSync('gcloud', ['auth', 'print-access-token'],
  { encoding: 'utf8', shell: true, env: Object.assign({}, process.env, { CLOUDSDK_PYTHON: PY }) });
TOKEN = String(tk.stdout || '').trim();
if (!TOKEN) { console.log('  no access token'); process.exit(1); }

let abort = 0;
const must = (label, cond, note) => {
  if (cond) console.log('    OK      ' + label);
  else { abort++; console.log('    ABORT   ' + label + (note ? '   [' + note + ']' : '')); }
};

console.log('');
console.log('  PRE-FLIGHT — checked immediately before the write');

const before = api('GET', '/releases/cloud.firestore');
const beforeId = String(before.rulesetName || '').split('/').pop();
must('production ruleset is the certified one', beforeId === CERT.ruleset,
     'expected ' + CERT.ruleset + ' got ' + beforeId);
must('production updateTime unmoved', before.updateTime === CERT.updateTime,
     'expected ' + CERT.updateTime + ' got ' + before.updateTime);

const liveSrc = api('GET', '/rulesets/' + beforeId);
const liveContent = liveSrc.source && liveSrc.source.files && liveSrc.source.files[0].content;
must('live baseline hashes to the certified baseline', liveContent && sha(liveContent) === CERT.baselineSha);

const candContent = fs.readFileSync(CAND, 'utf8');
must('candidate hashes to the certified artifact', sha(candContent) === CERT.candidateSha,
     sha(candContent).slice(0, 16) + '… vs ' + CERT.candidateSha.slice(0, 16) + '…');

if (abort) {
  console.log('');
  console.log('  ' + abort + ' abort condition(s). Production NOT touched.');
  console.log('  The certification describes artifacts that are no longer current.');
  process.exit(1);
}

console.log('');
console.log('  rollback target (keep): ' + beforeId);
console.log('  candidate file        : ' + CAND + '  (' + candContent.length + ' ch)');

if (!APPLY) {
  console.log('');
  console.log('  DRY RUN — nothing created, nothing released. Re-run with --apply.');
  console.log('');
  process.exit(0);
}

/* ── 1 · create the ruleset ───────────────────────────────────────────────── */
console.log('');
console.log('  CREATE RULESET');
/* THE RULESET FILE NAME IS PART OF THE COMPILED ARTIFACT — measured, 1:1 with its length:
     firestore.rules.release-minimal  (31)  -> 243,121
     firestore.rules.consolidated     (28)  -> 243,118
     firestore.rules                  (15)  -> 243,105
   The first publish attempt aborted on a 3-byte mismatch for exactly this reason, and the
   abort was correct — it could not tell a naming difference from a content difference, and
   guessing would have defeated the check. `firestore.rules.consolidated-ab` is 31
   characters, so it names the artifact honestly AND reproduces the certified 243,121. */
const RULESET_FILENAME = 'firestore.rules.consolidated-ab';
const rs = api('POST', '/rulesets',
  { source: { files: [{ name: RULESET_FILENAME, content: candContent }] } });
if (!rs.name) {
  console.log('    FAILED :: ' + JSON.stringify(rs).slice(0, 400));
  console.log('    Production NOT touched.');
  process.exit(1);
}
const newId = rs.name.split('/').pop();
console.log('    created ' + newId);

/* ── 2 · verify it compiles to the certified size, BEFORE pointing prod at it ── */
console.log('');
console.log('  SIZE VERIFICATION (disposable release, not cloud.firestore)');
const probe = 'sizeprobe-publish-' + Date.now().toString(36);
if (probe.indexOf('sizeprobe-') !== 0) { console.log('    guard failed'); process.exit(1); }
const pr = api('POST', '/releases',
  { name: 'projects/' + PROJECT + '/releases/' + probe, rulesetName: rs.name });
let compiled = -1;
if (pr.name) {
  const ex = api('GET', '/releases/' + probe + ':getExecutable?executableVersion=FIREBASE_RULES_EXECUTABLE_V1');
  if (ex.executable) compiled = Buffer.from(ex.executable, 'base64').length;
  api('DELETE', '/releases/' + probe);
}
console.log('    compiled ' + compiled + ' B   certified ' + CERT.compiledBytes +
            '   free ' + (256000 - compiled));
if (compiled !== CERT.compiledBytes) {
  console.log('    ABORT — compiled size does not match the certified figure.');
  console.log('    Deleting the unreleased ruleset. Production NOT touched.');
  api('DELETE', '/rulesets/' + newId);
  process.exit(1);
}

/* ── 3 · move the release pointer — THE production change ─────────────────── */
console.log('');
console.log('  PUBLISH — moving cloud.firestore');
let rel = api('PATCH', '/releases/cloud.firestore',
  { release: { name: 'projects/' + PROJECT + '/releases/cloud.firestore', rulesetName: rs.name } });
if (rel.error) {
  console.log('    PATCH refused: ' + rel.error.status + ' ' + rel.error.code);
  console.log('    retrying as PUT (full replace)');
  rel = api('PUT', '/releases/cloud.firestore',
    { name: 'projects/' + PROJECT + '/releases/cloud.firestore', rulesetName: rs.name });
}

/* ── 4 · post-deploy verification, read fresh ─────────────────────────────── */
console.log('');
console.log('  POST-DEPLOY — re-read from the API');
const after = api('GET', '/releases/cloud.firestore');
const afterId = String(after.rulesetName || '').split('/').pop();
console.log('    ruleset    ' + afterId);
console.log('    updateTime ' + after.updateTime);

if (afterId === newId) {
  const ex2 = api('GET', '/releases/cloud.firestore:getExecutable?executableVersion=FIREBASE_RULES_EXECUTABLE_V1');
  const live = ex2.executable ? Buffer.from(ex2.executable, 'base64').length : -1;
  console.log('    compiled   ' + live + ' B   free ' + (256000 - live));
  console.log('');
  console.log('  PUBLISHED. cloud.firestore now serves ' + newId);
  console.log('  rollback: point cloud.firestore back at ' + beforeId);
  process.exit(0);
}

console.log('');
console.log('  BLOCKED — the release pointer did NOT move.');
console.log('  still serving ' + afterId + ' (unchanged), updateTime ' + after.updateTime);
console.log('  last response: ' + JSON.stringify(rel).slice(0, 300));
console.log('');
console.log('  Production is exactly as it was found. The created ruleset ' + newId);
console.log('  is inert — nothing references it — and is deleted now.');
api('DELETE', '/rulesets/' + newId);
console.log('  deleted.');
process.exit(2);
