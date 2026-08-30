#!/usr/bin/env node
/**
 * Fetch the DEPLOYED Storage ruleset into ./storage.rules.deployed
 *
 *   node scripts/fetch-deployed-storage-rules.js
 *
 * WHY THIS EXISTS
 * ---------------
 * test-merchant-products-2c-media asserts that the module's accepted MIME types, its size
 * cap and its owner-path pinning match the rule PRODUCTION is actually enforcing. It
 * refuses to read the committed storage.rules for that, and it is right to: a committed
 * snapshot verifies what someone intended to deploy, not what is live. When the artifact is
 * absent the suite reports BLOCKED and exits non-zero, because "a check that did not run is
 * not a check that passed".
 *
 * The output is gitignored (.gitignore:147) on purpose. Committing it would recreate the
 * stale-snapshot problem the suite exists to avoid. Fetch it; never commit it.
 *
 * On 2026-08-30 the deployed ruleset was byte-identical to the committed storage.rules.
 * That is a reason to keep fetching, not to stop: identical today is not identical always,
 * and the only way to know is to look.
 *
 * TWO NON-OBVIOUS REQUIREMENTS, both of which fail confusingly:
 *
 *   1. gcloud on this machine dies with "Python was not found" — the Microsoft Store python
 *      alias shadows the interpreter. The SDK ships its own; CLOUDSDK_PYTHON is set below.
 *   2. firebaserules.googleapis.com rejects user credentials with 403 SERVICE_DISABLED
 *      unless a quota project is named. That is the `x-goog-user-project` header, NOT a
 *      permissions problem, and the error message does not say so.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const https = require('https');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'storage.rules.deployed');
const BUNDLED_PYTHON =
  'C:/Users/USER1/AppData/Local/Google/Cloud SDK/google-cloud-sdk/platform/bundledpython/python.exe';

function project () {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, '.firebaserc'), 'utf8')).projects.default; }
  catch (_) { return null; }
}

function token () {
  const env = Object.assign({}, process.env);
  if (!env.CLOUDSDK_PYTHON && fs.existsSync(BUNDLED_PYTHON)) env.CLOUDSDK_PYTHON = BUNDLED_PYTHON;
  const r = cp.spawnSync('gcloud', ['auth', 'print-access-token'], { encoding: 'utf8', env, shell: true });
  const t = (r.stdout || '').trim();
  if (!t) {
    console.error('  no access token. Run: gcloud auth login');
    if (/Python was not found/.test((r.stdout || '') + (r.stderr || ''))) {
      console.error('  (gcloud found the Store python shim — set CLOUDSDK_PYTHON to the SDK\'s bundled interpreter)');
    }
    process.exit(2);
  }
  return t;
}

function get (url, tok, proj) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { Authorization: 'Bearer ' + tok, 'x-goog-user-project': proj } }, (res) => {
      let s = '';
      res.on('data', (d) => { s += d; });
      res.on('end', () => {
        let j;
        try { j = JSON.parse(s); } catch (e) { return reject(new Error('unparseable response: ' + s.slice(0, 200))); }
        if (j.error) return reject(new Error(j.error.code + ' ' + j.error.message.split('\n')[0]));
        resolve(j);
      });
    }).on('error', reject);
  });
}

(async () => {
  const proj = project();
  if (!proj) { console.error('  cannot read .firebaserc'); process.exit(2); }
  const tok = token();
  const API = 'https://firebaserules.googleapis.com/v1/projects/' + proj;

  const rel = await get(API + '/releases', tok, proj);
  /* The storage release is keyed by bucket, e.g.
     projects/<p>/releases/firebase.storage/<bucket>.firebasestorage.app */
  const storage = (rel.releases || []).find((r) => /firebase\.storage/i.test(r.name));
  if (!storage) { console.error('  no firebase.storage release found for ' + proj); process.exit(1); }

  const rs = await get('https://firebaserules.googleapis.com/v1/' + storage.rulesetName, tok, proj);
  const files = (rs.source && rs.source.files) || [];
  if (!files.length) { console.error('  ruleset returned no source files'); process.exit(1); }

  fs.writeFileSync(OUT, files[0].content);
  console.log('  wrote storage.rules.deployed  (' + files[0].content.length + ' bytes)');
  console.log('  ruleset : ' + storage.rulesetName.split('/').pop());
  console.log('  release : ' + storage.name);

  /* Say whether the committed copy is currently telling the truth. Not an assertion - the
     suite owns that - but the answer is the whole reason this file is fetched separately. */
  try {
    const committed = fs.readFileSync(path.join(ROOT, 'storage.rules'), 'utf8');
    console.log('  committed storage.rules is ' +
      (committed === files[0].content ? 'IDENTICAL to production'
                                      : 'DIFFERENT from production — the committed copy is stale'));
  } catch (_) {}
})().catch((e) => { console.error('  ' + e.message); process.exit(1); });
