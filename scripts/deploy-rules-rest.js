#!/usr/bin/env node
/* ============================================================================
   Deploy Firestore rules through the Rules REST API — (default) ONLY.
   ============================================================================
   NOT `firebase deploy --only firestore:rules`. On firebase-tools 15.26 that
   filter is discarded and the deploy falls through to EVERY database declared
   in firebase.json — which here would overwrite sokoni-ops (3 blocks) with the
   default database's 729-block ruleset.

   So the mutation addresses the release explicitly:

       projects/sokoni-aeb26/releases/cloud.firestore

   and nothing else. sokoni-ops is never named, so it cannot be touched.

   Two steps, both explicit:
     1. CREATE a ruleset from firestore.rules.build  -> returns a ruleset id
     2. UPDATE the release to point at that id

   Step 2 is the only mutation a client can observe; step 1 just uploads.
   ========================================================================= */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PROJECT = 'sokoni-aeb26';
const RELEASE = 'projects/' + PROJECT + '/releases/cloud.firestore';
const SP = process.env.SOKONI_EVIDENCE_DIR ||
  'C:/Users/USER1/AppData/Local/Temp/claude/c--Users-USER1-OneDrive-Desktop-SOKONI/51f05820-e88d-48b4-8b14-ba44300630f9/scratchpad';

const token = execSync('gcloud auth print-access-token', { encoding: 'utf8' }).trim();
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

function api(method, url, bodyObj) {
  const tmp = path.join(SP, '_req.json');
  if (bodyObj) fs.writeFileSync(tmp, JSON.stringify(bodyObj));
  const cmd = 'curl -s -X ' + method +
    ' -H "Authorization: Bearer ' + token + '"' +
    ' -H "x-goog-user-project: ' + PROJECT + '"' +
    ' -H "Content-Type: application/json"' +
    (bodyObj ? ' --data-binary "@' + tmp + '"' : '') +
    ' "' + url + '"';
  const out = execSync(cmd, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (bodyObj) { try { fs.unlinkSync(tmp); } catch (e) {} }
  return JSON.parse(out);
}

const artifact = fs.readFileSync(path.join(ROOT, 'firestore.rules.build'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(SP, 'deployment-manifest.json'), 'utf8'));

/* The artifact must be the one the manifest certified. */
if (sha(artifact) !== manifest.rules.artifact_sha256) {
  console.error('REFUSING: artifact sha does not match the manifest');
  console.error('  manifest ' + manifest.rules.artifact_sha256.slice(0, 24));
  console.error('  on disk  ' + sha(artifact).slice(0, 24));
  process.exit(1);
}
console.log('  artifact matches manifest   ' + sha(artifact).slice(0, 24));

/* Record what is active BEFORE, so the change is attributable. */
const before = api('GET', 'https://firebaserules.googleapis.com/v1/' + RELEASE);
console.log('  active BEFORE               ' + before.rulesetName.split('/').pop());

/* 1 — create the ruleset. */
const created = api('POST',
  'https://firebaserules.googleapis.com/v1/projects/' + PROJECT + '/rulesets',
  { source: { files: [{ name: 'firestore.rules', content: artifact }] } });
if (!created.name) { console.error('RULESET CREATE FAILED'); console.error(JSON.stringify(created).slice(0, 600)); process.exit(1); }
const rulesetId = created.name.split('/').pop();
console.log('  ruleset CREATED             ' + rulesetId);

/* 2 — point the release at it. THIS is the mutation. */
const updated = api('PATCH', 'https://firebaserules.googleapis.com/v1/' + RELEASE,
  { release: { name: RELEASE, rulesetName: created.name } });
if (!updated.rulesetName) { console.error('RELEASE UPDATE FAILED'); console.error(JSON.stringify(updated).slice(0, 600)); process.exit(1); }
console.log('  release UPDATED             ' + updated.rulesetName.split('/').pop());
console.log('  target                      ' + RELEASE);

fs.writeFileSync(path.join(SP, 'deploy-rules-result.json'), JSON.stringify({
  at: new Date().toISOString(), release: RELEASE,
  previous_ruleset: before.rulesetName.split('/').pop(),
  new_ruleset: rulesetId, artifact_sha256: sha(artifact),
  release_head: manifest.release_head,
}, null, 2));
console.log('\n  RULES DEPLOYED to (default) only. sokoni-ops was never addressed.');
