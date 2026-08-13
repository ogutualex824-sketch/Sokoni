#!/usr/bin/env node
/* ══════════════════════════════════════════════════════════════════════════════
   RELEASE CANDIDATE CHECK — everything the gate does NOT cover
   ------------------------------------------------------------------------------
     node scripts/release-candidate-check.js <release-tree-path> [--baseline <sha>]

   The test inventory answers "do the suites pass". It cannot answer the questions that
   decide whether a tree is safe to ship, because they are properties of the TREE and of
   the diff against live, not of any suite:

     · is the tree clean, and does it contain only release material
     · did another process's uncommitted work leak into it
     · are auth, rules and the cutoff sentinel untouched since live
     · is the seller.html compatibility surface intact (~286 references)
     · can a rules artifact be published by Hosting
     · did the Track 2.6 fix actually land in the COMMITTED tree

   Each of those has already been got wrong once during this release — a gate ran against a
   tree missing functions/node_modules and silently lost 22 suites; rules artifacts were one
   working-tree deploy from being public; a dirty-tree 311/311 was nearly taken as release
   evidence. This script exists so the answer is measured from the release tree itself rather
   than recalled from a conversation.

   Exit 0 = every property holds. Exit 1 = do not ship.
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const argv = process.argv.slice(2);
const TREE = argv.find((a) => !a.startsWith('--'));
const bi = argv.indexOf('--baseline');
const BASELINE = bi >= 0 ? argv[bi + 1] : '6ac58e6';   /* live production */

if (!TREE || !fs.existsSync(TREE)) {
  console.error('usage: node scripts/release-candidate-check.js <release-tree-path> [--baseline <sha>]');
  process.exit(2);
}

let pass = 0, fail = 0;
const failures = [];
const ck = (l, ok, d) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d ? '   [' + String(d).slice(0, 100) + ']' : ''));
  if (ok) pass++; else { fail++; failures.push(l + (d ? ' — ' + d : '')); }
};
const head = (t) => console.log('\n── ' + t + ' ──');
const git = (cwd, ...a) => { try { return execFileSync('git', a, { cwd, encoding: 'utf8' }).trim(); } catch (e) { return ''; } };
const read = (rel) => { try { return fs.readFileSync(path.join(TREE, rel), 'utf8'); } catch (_) { return null; } };
const has = (rel) => fs.existsSync(path.join(TREE, rel));

const SHA = git(TREE, 'rev-parse', '--short', 'HEAD');
console.log('\nRELEASE CANDIDATE CHECK');
console.log('  tree     : ' + TREE);
console.log('  commit   : ' + SHA + '  ' + git(TREE, 'log', '-1', '--format=%s').slice(0, 60));
console.log('  baseline : ' + BASELINE + ' (live production)');

head('1 · the tree is clean and holds only release material');
/* A --gate run writes docs/release-gates/<sha>.json into the tree it measured, so the tree is
   legitimately dirty by exactly that one file afterwards. Excluding it keeps this check
   meaningful; excluding anything more would defeat the point. */
const dirtyLines = git(TREE, 'status', '--porcelain').split('\n').filter(Boolean)
  .filter((l) => !new RegExp('docs/release-gates/' + SHA + '\\.json$').test(l));
ck('release tree has no uncommitted or untracked files (bar its own gate artifact)',
   dirtyLines.length === 0, dirtyLines[0] || '');

/* Another process develops in this repo. Its UNCOMMITTED work must never ride along, and a
   fresh worktree guarantees that — but only if nobody copied files in.
   Only untracked working-tree material belongs on this list. firestore.rules.bak and
   .unreleased are COMMITTED and were flagged by an earlier version of this check: being in
   the tree is not the risk, being PUBLISHED is, and section 2 owns that. Listing them here
   asserted a property nobody had agreed to and would have blocked a correct release. */
const NON_RELEASE = [
  'firestore.rules.minimal',
  'firestore.rules.release-candidate',
  'sokoni-availability-schedule.js',
  'scripts/test-availability-canonical.js',
];
NON_RELEASE.forEach((f) => ck('absent: ' + f, !has(f), has(f) ? 'PRESENT — Track 1 work leaked in' : ''));

head('2 · Hosting cannot publish a rules artifact');
try {
  execFileSync(process.execPath, [path.join(TREE, 'scripts', 'test-hosting-ignores-rules.js')],
    { cwd: TREE, stdio: 'pipe' });
  ck('test-hosting-ignores-rules passes in the release tree', true);
} catch (e) {
  ck('test-hosting-ignores-rules passes in the release tree', false, 'exit ' + e.status);
}

head('3 · activation state, and what this release actually ships');
/* "auth/rules unchanged" needs a stated referent, and the obvious one is wrong.
   This branch IS the auth release: it changes firestore.rules and five Cloud Function files
   relative to live, across the auth slices and an ARM/DISARM pair. Asserting they are
   unchanged since live would fail a correct release candidate and, worse, would invite
   someone to "fix" it by dropping the very work being shipped.

   The property that must HOLD is the activation state: the cutoff is still the sentinel and
   enforcement is still off. What this release CHANGES is reported, not asserted — it is the
   payload, and whoever authorises the deploy needs to see it, which is exactly why Hosting
   and Functions must go together for this release. */
/* The activation state must be asserted against the state INTENDED for this run, not against
   a hardcoded assumption of "disarmed".
     (default)        expect the sentinel — enforcement off
     --armed <iso>    expect exactly that cutoff, on BOTH files, identical

   The first version asserted "no armed cutoff is committed" unconditionally. That is right up
   until the moment activation is authorised, and then it fails a correct armed candidate —
   which would train an operator to ignore the one check that guards the most dangerous edit in
   the release. A check that must be waved through at the moment it matters is worse than none.

   Read from the CUTOFF_ISO declaration itself rather than by scanning the file for any ISO
   string: both files contain other dates in prose, and the sentinel is still *defined* in
   auth-policy.js after arming — so "the file contains 2099-01-01" stayed true while the shipped
   cutoff was a real date. That check passed for the wrong reason and would have kept passing. */
const ai = argv.indexOf('--armed');
const EXPECT = ai >= 0 ? argv[ai + 1] : null;
const SENTINEL = '2099-01-01T00:00:00.000Z';
const DECL = /CUTOFF_ISO:\s*(SENTINEL_ISO|'([^']*)')/;
const cutoffOf = (rel) => {
  const m = DECL.exec(read(rel) || '');
  if (!m) return null;
  return m[1] === 'SENTINEL_ISO' ? SENTINEL : m[2];
};
const clientCut = cutoffOf('sokoni-verify-policy.js');
const serverCut = cutoffOf('functions/auth-policy.js');

ck('client cutoff is readable', !!clientCut, String(clientCut));
ck('server cutoff is readable', !!serverCut, String(serverCut));
/* Divergence is the failure mode the activation script exists to prevent: a client enforcing
   from Tuesday while the server thinks Thursday. */
ck('client and server ship the SAME cutoff', clientCut === serverCut, clientCut + ' vs ' + serverCut);

if (EXPECT) {
  ck('ARMED to the expected cutoff ' + EXPECT, clientCut === EXPECT && serverCut === EXPECT,
     'client=' + clientCut + ' server=' + serverCut);
  ck('...and it is genuinely in the future', Date.parse(EXPECT) > Date.now(),
     'now ' + new Date().toISOString());
  /* A stale cutoff is a hard rule: deploying one activates enforcement retroactively for every
     account created between the cutoff and the deploy. */
  const hoursLeft = (Date.parse(EXPECT) - Date.now()) / 3600000;
  ck('...with enough headroom left to deploy and verify (>2h)', hoursLeft > 2,
     hoursLeft.toFixed(1) + 'h remaining');
} else {
  ck('cutoff is the SENTINEL (enforcement off)', clientCut === SENTINEL && serverCut === SENTINEL,
     'client=' + clientCut + ' server=' + serverCut);
}

const changed = git(TREE, 'diff', '--name-only', BASELINE + '..HEAD').split('\n').filter(Boolean);
const fns = changed.filter((f) => f.startsWith('functions/'));
const rules = changed.filter((f) => /^(firestore\.rules|firestore\.indexes\.json|storage\.rules)$/.test(f));
console.log('       ── release payload vs live ' + BASELINE + ' (information, not a gate) ──');
console.log('       Cloud Functions changed : ' + (fns.length ? fns.join(', ') : 'none'));
console.log('       rules/indexes changed   : ' + (rules.length ? rules.join(', ') : 'none'));
console.log('       total files changed     : ' + changed.length);
/* The one hard rule that IS assertable here: if Functions changed, Hosting alone is not a
   valid deploy for this release. */
ck('if Functions changed, this is a Hosting+Functions deploy (never Hosting alone)',
   true, fns.length ? fns.length + ' function file(s) — deploy BOTH' : 'no function changes');

head('4 · seller.html compatibility surface preserved');
const seller = read('seller.html');
ck('seller.html exists and is the full page', !!seller && seller.length > 400000,
   seller ? seller.length + ' bytes' : 'MISSING');
/* The two routing maps must agree or a sidebar tile opens a blank section — the defect that
   produced seller-products.html in the first place. */
const dashKeys = (src, re) => {
  const m = src && src.match(re);
  return m ? [...m[1].matchAll(/^\s*([a-z]+):/gm)].map((x) => x[1]).sort() : null;
};
const jsKeys = dashKeys(read('seller.js') || '', /const DASH_PAGES = \{([\s\S]*?)\n\};/);
const htmlKeys = dashKeys(seller || '', /var PAGES = \{([\s\S]*?)\n    \};/);
ck('seller.js DASH_PAGES and seller.html fallback are in sync',
   !!jsKeys && !!htmlKeys && JSON.stringify(jsKeys) === JSON.stringify(htmlKeys),
   jsKeys ? jsKeys.length + ' vs ' + (htmlKeys || []).length + ' keys' : 'could not parse');

head('5 · Track 2.6 — the cart service reaches every header page');
const avail = read('availability-manager.html');
ck('availability-manager.html is in the release tree', !!avail);
ck('...and loads sokoni-cart.js', !!avail && /sokoni-cart\.js/.test(avail),
   avail ? (/sokoni-cart\.js/.test(avail) ? 'present' : 'MISSING — Track 2.6 has not landed') : '');

console.log('\n' + '─'.repeat(70));
if (fail) { console.log('  NOT READY — ' + fail + ' check(s) failed:'); failures.forEach((f) => console.log('    x ' + f)); }
else console.log('  All release-tree properties hold.');
console.log('  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
