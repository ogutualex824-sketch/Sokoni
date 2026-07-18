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
const dirty = git('status --porcelain', '') !== '';

const payload = {
  commit,
  commitShort: commit.slice(0, 7),
  branch: git('rev-parse --abbrev-ref HEAD', 'unknown'),
  buildTime: new Date().toISOString(),
  serviceWorker: 'service-worker.js',
  cacheVersion: cacheVersion(),
  environment: 'production',
  /* Recorded honestly: a deploy from a dirty tree does not match any commit, and that is
     exactly the situation where a build identifier is most likely to mislead. */
  dirtyWorkingTree: dirty,
};

const out = path.join(ROOT, 'version.json');
fs.writeFileSync(out, JSON.stringify(payload, null, 2) + '\n');

console.log('\n  version.json written:\n');
Object.entries(payload).forEach(([k, v]) => console.log('    ' + k.padEnd(18) + v));
if (dirty) console.log('\n  WARNING: working tree is dirty — this build does not correspond to a clean commit.');
console.log('');
