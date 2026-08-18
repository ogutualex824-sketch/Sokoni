#!/usr/bin/env node
/**
 * generate-version.js — writes /version.json, the build identifier for this deploy.
 *
 * WHY. Until now nothing on the wire said WHICH build a client was running. Every
 * "the site looks wrong" report became a debate about deployment vs cache vs DNS that
 * could not be settled, because no client could report its build. version.json plus the
 * cacheVersion in the service worker makes that answerable in one request.
 *
 * Run before every deploy:
 *   node scripts/generate-version.js
 *
 * The values are read from git and service-worker.js — never hand-edited, so the file
 * cannot drift from what actually shipped.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const ROOT = path.join(__dirname, '..');

function git(args, fallback) {
  try { return cp.execSync('git ' + args, { cwd: ROOT, encoding: 'utf8' }).trim(); }
  catch (e) { return fallback; }
}

/* Read CACHE_VERSION straight out of the worker so the two can never disagree. */
function cacheVersion() {
  try {
    const sw = fs.readFileSync(path.join(ROOT, 'service-worker.js'), 'utf8');
    const m = sw.match(/CACHE_VERSION\s*=\s*["']([^"']+)["']/);
    return m ? m[1] : 'unknown';
  } catch (e) { return 'unknown'; }
}

const commit = git('rev-parse HEAD', 'unknown');

/* ── Dirtiness, computed so the answer can actually be `false` ───────────────
   A blanket `git status --porcelain` CANNOT report clean here, because this
   script runs as predeploy step 4 and step 3 (bump-sw-version.js) has already
   rewritten service-worker.js in the tree. version.json — this file's own
   output — is modified from the previous deploy for the same reason.

   So the flag was structurally always true, and release-gate.js FAILS on it
   unconditionally: a gate that can never pass. That is worse than no gate,
   because a permanently-red check is one people learn to ignore.

   The fix is not to stop reporting it. It is to report the thing that was
   always meant: are there edits here that the DEPLOY PIPELINE did not make?

   Two artifacts are excluded, and only on proof rather than on trust:
     · version.json      this script's own output
     · service-worker.js excluded ONLY IF its sole difference from HEAD is the
                         CACHE_VERSION line the bump wrote. Any other edit to it
                         is a human change and still counts as dirty.
   Everything else counts. Edit merchant.html and deploy, and this still says
   true — which is the case the flag exists for. */
const GENERATED = ['version.json'];

function swIsOnlyVersionBump () {
  const head = git('show HEAD:service-worker.js', null);
  if (head == null) return false;
  let now;
  try { now = fs.readFileSync(path.join(ROOT, 'service-worker.js'), 'utf8'); }
  catch (_) { return false; }
  const strip = (s) => s.split('\n').filter(l => !/CACHE_VERSION\s*=/.test(l)).join('\n').trim();
  return strip(head) === strip(now);
}

/* Parse porcelain by SHAPE, not by a fixed offset. `git()` trims its output, so the
   leading space of an unstaged " M path" is already gone and a slice(3) silently ate
   the first character of every such path — which then matched no exclusion and made
   every deploy look dirty for the wrong reason. Handles staged/unstaged/untracked and
   the "R old -> new" rename form. */
const porcelain = git('status --porcelain', '');
const changed = porcelain.split('\n')
  .map(l => {
    const m = /^\s*\S{1,2}\s+(.+)$/.exec(l);
    if (!m) return '';
    const p = m[1].trim();
    const arrow = p.indexOf(' -> ');
    return arrow > -1 ? p.slice(arrow + 4).trim() : p;
  })
  .map(p => p.replace(/^"(.*)"$/, '$1'))
  .filter(Boolean);

const excluded = changed.filter(p =>
  GENERATED.includes(p) || (p === 'service-worker.js' && swIsOnlyVersionBump()));
const dirtyPaths = changed.filter(p => !excluded.includes(p));
const dirty = dirtyPaths.length > 0;

const payload = {
  commit,
  commitShort: commit.slice(0, 7),
  branch: git('rev-parse --abbrev-ref HEAD', 'unknown'),
  buildTime: new Date().toISOString(),
  serviceWorker: 'service-worker.js',
  cacheVersion: cacheVersion(),
  environment: 'production',
  /* Recorded honestly: a deploy from a dirty tree does not match any commit, and that is
     exactly the situation where a build identifier is most likely to mislead.
     "Dirty" now means edits the deploy pipeline did not make — see above. */
  dirtyWorkingTree: dirty,
  /* Auditable rather than implicit: what was excluded, and (bounded) what made it
     dirty. A reader can check the exclusion was legitimate instead of taking it. */
  pipelineArtifacts: excluded,
  dirtyPaths: dirtyPaths.slice(0, 20),
};

const out = path.join(ROOT, 'version.json');
fs.writeFileSync(out, JSON.stringify(payload, null, 2) + '\n');

console.log('\n  version.json written:\n');
Object.entries(payload).forEach(([k, v]) => console.log('    ' + k.padEnd(18) + v));
if (dirty) {
  console.log('\n  WARNING: working tree carries edits the deploy pipeline did not make —');
  console.log('  this build corresponds to NO commit. Paths:');
  dirtyPaths.slice(0, 20).forEach(p => console.log('    ' + p));
  if (dirtyPaths.length > 20) console.log('    … and ' + (dirtyPaths.length - 20) + ' more');
} else if (excluded.length) {
  console.log('  clean — excluding pipeline-generated: ' + excluded.join(', '));
}
console.log('');
