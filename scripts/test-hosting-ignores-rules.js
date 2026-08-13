#!/usr/bin/env node
/* ══════════════════════════════════════════════════════════════════════════════
   SECURITY RULES MUST NEVER BE PUBLIC HOSTING CONTENT
   ------------------------------------------------------------------------------
   firebase.json hosting is `"public": "."` — the repository root IS the site. Anything
   not matched by an `ignore` pattern is published.

   The ignore list named three files EXACTLY:

       "firestore.rules", "firestore.indexes.json", "storage.rules"

   but the working tree holds NINE further rules artifacts and two further index files:

       firestore.rules.bak                 265 KB
       firestore.rules.build               164 KB
       firestore.rules.live                256 KB
       firestore.rules.minimal             256 KB
       firestore.rules.release-candidate   262 KB
       firestore.rules.sokoni-ops          (the real sokoni-ops ruleset)
       firestore.rules.unreleased          261 KB
       firestore.indexes.json.full
       firestore.indexes.sokoni-ops.json

   None of those matched, so a deploy would publish roughly 1.9 MB of production
   authorization logic at a guessable URL. Firestore rules are not a secret in the
   cryptographic sense — they are enforced server-side — but publishing them hands an
   attacker the complete data model and every authorization condition, which is a map of
   exactly where to push. It is also a stated hard rule for this release: rules artifacts
   must never become public Hosting content.

   This mattered because deploys are made from the WORKING TREE, not from HEAD. Most of
   these files are untracked, so a clean release worktree never had them and live currently
   404s all of them — the exposure was one working-tree deploy away, not already live.

   The patterns are now globbed (`firestore.rules*`), and this suite fails if any rules or
   index artifact present in the tree is not covered.

     node scripts/test-hosting-ignores-rules.js
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const ck = (l, ok, d) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d ? '   [' + String(d).slice(0, 110) + ']' : ''));
  ok ? pass++ : fail++;
};

const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'firebase.json'), 'utf8'));
const hosting = Array.isArray(cfg.hosting) ? cfg.hosting[0] : cfg.hosting;
const ignore = hosting.ignore || [];

/* firebase-tools matches ignore entries as globs. Only the subset of glob syntax the list
   actually uses is implemented — `*` (not crossing `/`) and `**` (crossing it) — because a
   half-right matcher that silently over-matches would report safety that is not there. */
function globToRe(p) {
  let out = '';
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '*') {
      if (p[i + 1] === '*') { out += '.*'; i++; }
      else out += '[^/]*';
    } else if ('.+^${}()|[]\\?'.includes(c)) {
      out += '\\' + c;
    } else out += c;
  }
  return new RegExp('^' + out + '$');
}
const ignored = (f) => ignore.some((p) => p === f || globToRe(p).test(f));

console.log('\nHOSTING IGNORE — rules and index artifacts must not be publishable\n');

ck('hosting publishes the repository root (so ignore is the only guard)',
   hosting.public === '.', String(hosting.public));

/* Every rules/index artifact that EXISTS right now, whether tracked or not — untracked is
   exactly how these arrive, and the deploy reads the working tree. */
const present = fs.readdirSync(ROOT)
  .filter((f) => /^(firestore\.rules|storage\.rules|firestore\.indexes)/.test(f))
  .sort();

ck('rules/index artifacts were found to check', present.length > 0, present.length + ' file(s)');

const leaked = present.filter((f) => !ignored(f));
present.forEach((f) => ck('ignored: ' + f, ignored(f), ignored(f) ? '' : 'WOULD BE PUBLISHED'));
ck('no rules or index artifact is publishable', leaked.length === 0, leaked.join(', ') || 'none');

/* The globs must stay globs. Someone "tidying" them back to exact names reopens the hole
   without touching a single rules file, which is why this is asserted separately. */
['firestore.rules*', 'firestore.indexes*', 'storage.rules*'].forEach((p) => {
  ck('ignore list still carries the glob "' + p + '"', ignore.includes(p));
});

/* A future artifact must be covered too — the list is only useful if it generalises. */
['firestore.rules.something-new', 'firestore.indexes.new.json', 'storage.rules.v2'].forEach((f) => {
  ck('a NEW artifact would also be ignored: ' + f, ignored(f));
});

/* Control: the guard must not be so broad that it hides the real site. If these were
   ignored, the deploy would ship nothing that matters and every assertion above would pass
   for entirely the wrong reason. */
['index.html', 'merchant.html', 'seller.js', 'firebase.js', 'sokoni-cart.js'].forEach((f) => {
  ck('control — still published: ' + f, !ignored(f));
});

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
