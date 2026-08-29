#!/usr/bin/env node
/* ══════════════════════════════════════════════════════════════════════════════
   GENERATE functions/build-info.js  —  the Functions deployment provenance stamp
   ══════════════════════════════════════════════════════════════════════════════
   Hosting has version.json. Functions had NOTHING: nothing published anywhere
   stated which functions code was live, so `guard-no-rollback` could not exist
   on that side — there was no `<live>` to compare against. This is the missing
   half.

   WHY A FILE IN functions/ AND NOT A CLOUD RUN LABEL
   Every Gen2 function's deployed source is an immutable GCS archive
   (gs://gcf-v2-sources-<projnum>-<region>/<fn>/function-source.zip#<generation>),
   and that archive is a VERBATIM COPY of the functions/ directory. A file placed
   here is therefore carried into the deployed artifact and cannot drift from it.
   Cloud Run labels are all Google/Firebase-managed and firebase-tools rewrites
   the label set on every deploy, so a custom label would be silently stripped —
   and a silently-missing stamp becomes a hard REFUSE for every later release.

   WHAT IT DOES *NOT* MEAN
   The stamp says "this function was deployed from this revision". It does NOT
   say all 1,708 functions are on that revision — each function carries its own
   archive, so a partial deploy stays truthful rather than pretending one commit
   describes the whole backend.

   FAIL-CLOSED: if git cannot be resolved, or HEAD is not a 40-hex sha, this
   REFUSES rather than emitting a stamp that would later be believed.
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'functions', 'build-info.js');
const SCHEMA_VERSION = 1;

function git (args) {
  try {
    return cp.execSync('git ' + args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch (e) {
    return '';
  }
}

function refuse (why, detail) {
  console.error('');
  console.error('  x [functions-build-info] REFUSING — cannot establish the candidate commit.');
  console.error('      ' + why);
  if (detail) console.error('      ' + detail);
  console.error('');
  console.error('      A functions deploy without provenance produces an artifact whose');
  console.error('      lineage can never be checked afterwards. Emitting a placeholder here');
  console.error('      would be worse than failing: the rollback guard would later read it');
  console.error('      and believe it.');
  console.error('');
  process.exit(1);
}

const commit = git('rev-parse HEAD');
if (!/^[0-9a-f]{40}$/i.test(commit)) {
  refuse('`git rev-parse HEAD` did not return a 40-hex sha.',
    'returned: ' + (commit ? JSON.stringify(commit) : '(nothing — not a git worktree, or git unavailable)'));
}

/* A dirty tree must be VISIBLE in the stamp, never silently claimed clean. The
   deploy is still allowed — hosting does the same — but the record says so. */
const status = git('status --porcelain');
const dirtyPaths = status ? status.split('\n').filter(Boolean).map((l) => l.slice(3).trim()) : [];

const info = {
  schemaVersion: SCHEMA_VERSION,
  commit: commit,
  commitShort: commit.slice(0, 7),
  branch: git('rev-parse --abbrev-ref HEAD') || 'detached',
  buildTime: new Date().toISOString(),
  dirtyWorkingTree: dirtyPaths.length > 0,
  dirtyPaths: dirtyPaths.slice(0, 50),
};

/* Emitted as a JSON literal so the readback can parse it without eval()ing code
   pulled out of a deployed archive. Provenance only — never secrets. */
const body = [
  '/* GENERATED FILE — DO NOT EDIT. Written by scripts/generate-functions-build-info.js',
  '   at functions predeploy, from the candidate\'s actual git HEAD.',
  '',
  '   Carried into every function\'s deployed source archive, which is a verbatim',
  '   copy of this directory. Read back by scripts/deploy/functions-provenance.js',
  '   to establish what revision a deployed function is actually running.',
  '',
  '   Provenance only. Never put secrets here — this ships to GCS. */',
  'module.exports = ' + JSON.stringify(info, null, 2) + ';',
  '',
].join('\n');

fs.writeFileSync(OUT, body);

/* POSTCONDITION: never trust the write — read it back and prove it parses to
   the same commit we just resolved. */
delete require.cache[require.resolve(OUT)];
let readBack;
try {
  readBack = require(OUT);
} catch (e) {
  refuse('the stamp was written but does not load: ' + e.message);
}
if (readBack.commit !== commit) {
  refuse('the stamp round-tripped to a DIFFERENT commit.',
    'wrote ' + commit.slice(0, 7) + ', read back ' + String(readBack.commit).slice(0, 7));
}
if (readBack.schemaVersion !== SCHEMA_VERSION) {
  refuse('the stamp round-tripped with the wrong schemaVersion.');
}

console.log('  [functions-build-info] ' + info.commitShort + ' (' + info.branch + ')' +
  (info.dirtyWorkingTree ? '  DIRTY: ' + dirtyPaths.length + ' path(s)' : '  clean') +
  '  -> functions/build-info.js');
