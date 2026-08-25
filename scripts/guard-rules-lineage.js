#!/usr/bin/env node
/* GUARD: a rules deploy from a stale lineage silently REGRESSES production security.
 *
 * `deploy:rules` and `deploy:all` publish firestore.rules from the WORKING TREE. Production
 * currently scopes the admin bypass on users/{userId} (served ruleset, measured 49/0 by
 * scripts/test-role-switch-rules.js). Feature lineages that predate the fix still carry:
 *
 *     allow update: if isAdmin() || (self && guards...)
 *
 * where isAdmin() is the FIRST disjunct and short-circuits every guard on ANY user doc
 * including their own — admin -> driver and admin -> superAdmin both ALLOW. Deploying that
 * re-opens privilege escalation, and nothing else in the pipeline would notice.
 *
 * Fixed by 80297d4 (before-proof 7b00d81, docs/ROLE_SWITCH_BEFORE.md).
 *
 * Two independent checks, because either alone can be defeated:
 *   1. CONTENT — the rule text actually about to be published carries the scoping. This is
 *      the real invariant: it holds even if someone hand-edits the file on a good lineage.
 *   2. LINEAGE — 80297d4 is an ancestor of HEAD. Catches a tree that was never updated.
 *
 * Scope: RULES deploys only. Hosting/preview deploys do not publish rules and must not
 * depend on this.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const FIX = '80297d4';
const ROOT = path.join(__dirname, '..');
const RULES = path.join(ROOT, 'firestore.rules');

const die = (lines) => {
  console.error('\n  RULES DEPLOY ABORTED — this tree would regress production security.\n');
  lines.forEach((l) => console.error('  ' + l));
  console.error('\n  Fix: rebase/cherry-pick ' + FIX + ' (contained in audit/employee-attribution),');
  console.error('  then re-run. Verify with:');
  console.error('    RULES_FILE=firestore.rules npx firebase emulators:exec --only firestore');
  console.error('      --project guard-check "node scripts/test-role-switch-rules.js"   # expect 49/0\n');
  process.exit(1);
};

if (!fs.existsSync(RULES)) die(['firestore.rules not found at ' + RULES]);
const src = fs.readFileSync(RULES, 'utf8');

/* ── 1. CONTENT ── the users/{userId} update clause, as it will be published. */
const block = (src.match(/match\s+\/users\/\{userId\}\s*\{[\s\S]*?\n\s*\}/) || [])[0];
if (!block) die(['could not locate the match /users/{userId} block in firestore.rules',
                 'Refusing to publish rules I cannot verify.']);

const upd = (block.match(/allow\s+update:[\s\S]*?;/) || [])[0] || '';
const scopesSelf   = /request\.auth\.uid\s*!=\s*userId/.test(upd);
const excludesRole = /affectedKeys\(\)\s*\.hasAny\(\s*\[\s*'activeRole'\s*\]\s*\)/.test(upd);

if (!scopesSelf || !excludesRole) {
  die([
    'users/{userId} `allow update` does NOT scope the isAdmin() bypass.',
    '',
    '  missing: ' + [!scopesSelf && 'request.auth.uid != userId (admin editing their OWN doc)',
                     !excludesRole && "activeRole exclusion (admin -> superAdmin)"]
                    .filter(Boolean).join('\n           missing: '),
    '',
    '  Publishing this allows an admin to set ANY user\'s role/permissions/kycStatus/',
    '  roles[]/registeredAs.admin, and to escalate THEMSELVES to superAdmin.',
  ]);
}

/* ── 2. LINEAGE ── belt and braces: the fix commit is genuinely in this history. */
let contained = null;
try {
  execFileSync('git', ['merge-base', '--is-ancestor', FIX, 'HEAD'], { cwd: ROOT, stdio: 'ignore' });
  contained = true;
} catch (e) {
  /* Distinguish "not an ancestor" from "commit absent" (shallow clone) — a missing object
     must NOT be read as a pass. */
  try {
    execFileSync('git', ['cat-file', '-e', FIX + '^{commit}'], { cwd: ROOT, stdio: 'ignore' });
    contained = false;
  } catch (_) { contained = 'absent'; }
}
/* ADVISORY, NOT FATAL — and the reason matters.
   A CHERRY-PICK creates a new sha, so 80297d4 is never an ancestor even after a
   perfectly correct back-port. Making this fatal would reject the sanctioned way of
   bringing the fix in, and the only way to ship would be to bypass the guard — which
   is strictly worse than not having one.

   The CONTENT check above is the real invariant: it reads the exact clause that will be
   published. Ancestry cannot catch anything content does not already catch, so when
   content passes and ancestry does not, the correct action is to say so and continue. */
if (contained === false) {
  console.warn('  guard-rules-lineage: note — ' + FIX + ' is not an ancestor (cherry-picked?).');
  console.warn('  Content check PASSED, which is the invariant that decides what ships.');
}
if (contained === 'absent') {
  console.warn('  guard-rules-lineage: WARNING — commit ' + FIX + ' not present in this repo');
  console.warn('  (shallow clone?). Content check PASSED, lineage check skipped.');
}

console.log('  guard-rules-lineage: OK — users/{userId} admin bypass is scoped' +
            (contained === true ? ' (' + FIX + ' contained)' : ''));
