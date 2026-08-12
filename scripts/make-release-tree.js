#!/usr/bin/env node
/* ══════════════════════════════════════════════════════════════════════════════
   RELEASE TREE — a clean checkout that can actually run the gate
   ------------------------------------------------------------------------------
     node scripts/make-release-tree.js [<commit-ish>] [--dir <path>]

   WHY THIS EXISTS

   An authoritative gate must run on committed content, not on a working tree that
   also holds another process's uncommitted work. So the gate runs in a detached
   worktree. But a fresh worktree has NO node_modules, and that is where this bites:

   The first release tree was provisioned with the ROOT node_modules only. The gate
   then reported a healthy-looking result — and had silently lost 22 suites. Every
   suite that resolves firebase-admin from functions/ hit MODULE_NOT_FOUND, which
   classify() reads as ENV. ENV is non-blocking, so the suites did not turn anything
   red; they simply stopped covering the build:

       ENV   21 -> 39          PASS  123 -> 114

   That is the same failure mode as a TIMEOUT: the dangerous verdicts are the ones
   that make nothing go red. A dependency failure is NOT an environment gap and must
   never be accepted as one — it means the suite never ran.

   So this script provisions BOTH module trees and then VERIFIES the result by
   requiring the two packages the gate actually depends on. It exits non-zero if
   either is unresolvable, because a release tree that cannot run the suites is
   worse than no release tree: it produces numbers that look like evidence.
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
const arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
const COMMITISH = argv.find((a) => !a.startsWith('--') && a !== arg('--dir')) || 'HEAD';

const git = (...a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8' }).trim();

const sha = git('rev-parse', '--short', COMMITISH);
const DIR = arg('--dir') || path.join('C:', 'temp', 'sokoni-rc-' + sha);

console.log('\n  RELEASE TREE');
console.log('  commit : ' + sha + '  (' + git('log', '-1', '--format=%s', sha).slice(0, 70) + ')');
console.log('  dir    : ' + DIR + '\n');

/* ── 1. the worktree ─────────────────────────────────────────────────────────
   Never reuse or force-remove an existing directory: other agents keep worktrees
   under the same root, and clobbering one destroys uncommitted work. */
if (fs.existsSync(DIR)) {
  console.log('  reusing existing tree (not touched)');
} else {
  git('worktree', 'add', '--detach', DIR, sha);
  console.log('  worktree created');
}

/* ── 2. dependencies ─────────────────────────────────────────────────────────
   Junctions rather than a copy: node_modules here is ~171 top-level packages plus
   playwright's browsers, and copying it per release tree is minutes and gigabytes.
   Both trees are required — see the note at the top of this file. */
const LINKS = [
  ['node_modules',            'root'],
  [path.join('functions', 'node_modules'), 'functions'],
];
for (const [rel, label] of LINKS) {
  const src = path.join(ROOT, rel);
  const dst = path.join(DIR, rel);
  if (!fs.existsSync(src)) { console.log('  ! source missing: ' + rel + ' — run npm install in ' + label); continue; }
  if (fs.existsSync(dst)) { console.log('  ' + rel + ' already present'); continue; }
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  /* 'junction' is the only link type Windows grants without elevation. */
  fs.symlinkSync(src, dst, process.platform === 'win32' ? 'junction' : 'dir');
  console.log('  linked ' + rel);
}

/* ── 3. VERIFY, do not assume ────────────────────────────────────────────────
   The whole reason this script exists is that a missing dependency looked like a
   passing gate. Resolve the two packages the suites actually need, from the two
   places they actually resolve them from. */
let bad = 0;
const probe = (pkg, fromRel) => {
  const from = path.join(DIR, fromRel);
  try {
    require.resolve(pkg, { paths: [from] });
    console.log('  OK   ' + pkg + '  resolvable from ' + (fromRel || '.'));
  } catch (e) {
    console.log('  FAIL ' + pkg + '  NOT resolvable from ' + (fromRel || '.') + ' — suites would report ENV');
    bad++;
  }
};
probe('playwright', '');
probe('firebase-admin', 'functions');

/* A dirty release tree is not a release tree. */
const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: DIR, encoding: 'utf8' }).trim();
if (dirty) { console.log('\n  FAIL tree is DIRTY:\n' + dirty.split('\n').map((l) => '       ' + l).join('\n')); bad++; }
else console.log('  OK   tree is clean');

console.log('\n  ' + (bad ? 'NOT READY — ' + bad + ' problem(s). Do NOT gate from this tree.'
                          : 'READY. Gate with:') );
if (!bad) {
  console.log('    cd ' + DIR);
  console.log('    CLOUDSDK_PYTHON=bundled firebase emulators:exec --only firestore,auth \\');
  console.log('      --project sokoni-rc-gate "node scripts/test-inventory.js --gate"');
}
console.log('');
process.exit(bad ? 1 : 0);
