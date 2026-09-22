#!/usr/bin/env node
/* ============================================================================
   SOKONI — merchant-identity registration provenance
   ============================================================================
   docs/PROVENANCE_GAP_MERCHANT_IDENTITY.md blocks any Functions deployment
   while two LIVE callables — employeeSaleAuthorize and adminLinkMerchantAccounts
   — are defined in this worktree but registered by nobody. Firebase deletes
   what a deploy does not contain, so an unfiltered deploy from such a tree
   removes two live production callables.

   THE RULE THIS GATE ENCODES
   --------------------------
   The document is explicit that the repair is NOT an edit:

     "Do not add exports.employeeSaleAuthorize / exports.adminLinkMerchantAccounts
      to this branch's index.js to make the detector green. That is fixing the
      gauge."

     "...take the registration through a merge from the owning lineage — not a
      hand-written exports.X = line composed here."

   So the invariant is not "registration must be present". It is:

     registration present  ==>  it was INHERITED from the owning lineage,
                                i.e. f194c02 is an ancestor of HEAD.

   A tree that registers the callables WITHOUT carrying f194c02 has had the
   line hand-written into it, which is precisely the prohibited repair. This
   gate fails on that, and on nothing else about registration.

   It therefore passes in BOTH trees, for different reasons, and fails the one
   state nobody wants.
   ========================================================================= */
'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const REGISTERING_COMMIT = 'f194c02';
const CALLABLES = ['employeeSaleAuthorize', 'adminLinkMerchantAccounts'];

let pass = 0;
const failures = [];
function ok(name, cond, detail) {
  if (cond) { pass++; return true; }
  failures.push(name + (detail ? '  — ' + detail : ''));
  return false;
}
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

function strip(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const git = (cmd) => {
  try { return execSync('git -C "' + ROOT + '" ' + cmd, { encoding: 'utf8' }).trim(); }
  catch (e) { return null; }
};

/* ── 1. The module and its callables exist ──────────────────────────────── */
const mod = strip(read('functions/merchant-identity.js'));
CALLABLES.forEach((n) => {
  ok('functions/merchant-identity.js defines ' + n,
    new RegExp('exports\\.' + n + '\\s*=').test(mod));
});
ok('CONTROL: the module source is readable', mod.indexOf('onCall') !== -1);

/* The module is NOT dead code, which is why deleting it is also forbidden. */
{
  const consumer = strip(read('functions/pos-zero-friction.js'));
  ok('the module SHIPS regardless: pos-zero-friction requires it',
    /require\(['"]\.\/merchant-identity['"]\)/.test(consumer),
    'if this breaks, the module is no longer reachable and the finding changes');
}

/* ── 2. Registration state of THIS tree ─────────────────────────────────── */
const index = strip(read('functions/index.js'));
const registered = CALLABLES.filter((n) =>
  new RegExp('exports\\.' + n + '\\s*=').test(index));

ok('CONTROL: index.js is readable and registers things',
  /exports\.\w+\s*=/.test(index));

/* Never one of the two. A half-registration deploys one live callable and
   deletes the other, which is worse than either whole state. */
ok('the two callables are registered together or not at all',
  registered.length === 0 || registered.length === 2,
  'registered: ' + registered.join(',') || 'none');

/* ── 3. THE RULE: registration must be INHERITED, never hand-written ────── */
const isAncestor = git('merge-base --is-ancestor ' + REGISTERING_COMMIT + ' HEAD') !== null;
const headRef = git('rev-parse --abbrev-ref HEAD') || '(detached)';

if (registered.length === 2) {
  ok('registration is present AND inherited from the owning lineage (' +
     REGISTERING_COMMIT + ' is an ancestor)',
    isAncestor,
    'HAND-WRITTEN REGISTRATION on ' + headRef + ' — this is the prohibited repair');

  /* It must bind the ROOT module. A basename collision with
     functions/shared/merchant-identity.js is what hid the gap in the first
     place, and binding the wrong one would register undefined. */
  ok('…and binds the ROOT module, not the shared/ twin of the same basename',
    /require\(['"]\.\/merchant-identity['"]\)/.test(index));
  CALLABLES.forEach((n) => {
    ok('…' + n + ' is bound from that module',
      new RegExp('exports\\.' + n + '\\s*=\\s*merchantIdentity\\.' + n).test(index));
  });
  console.log('  STATE: this tree CARRIES the registration (lineage-inherited).');
} else {
  /* The feature-branch state. Deployment stays blocked, and that is correct —
     but the gate must not be satisfiable by editing this file. */
  ok('registration is absent, and this tree does NOT carry the owning commit',
    !isAncestor,
    'the tree carries ' + REGISTERING_COMMIT + ' yet registers nothing — a LOST edit, ' +
    'which is a different and worse finding than lineage drift');
  ok('…so an UNFILTERED functions deploy from here stays BLOCKED', true);
  console.log('  STATE: this tree does NOT carry the registration. Deployment blocked.');
}

/* ── 4. The finding is documented, and the prohibition is recorded ──────── */
{
  const doc = read('docs/PROVENANCE_GAP_MERCHANT_IDENTITY.md');
  CALLABLES.forEach((n) => ok('the gap document names ' + n, doc.indexOf(n) !== -1));
  ok('…and records that a hand-written export is NOT the repair',
    /fixing the gauge/.test(doc));
  ok('…and records that the module must NOT be deleted as unused',
    /Do not delete/.test(doc));
  ok('…and names the registering commit',
    doc.indexOf(REGISTERING_COMMIT) !== -1);
}

/* ── 5. Positive control on the ancestry probe ──────────────────────────── */
{
  /* If merge-base always returned the same answer, section 3 would be
     meaningless. Prove the probe discriminates: HEAD is always its own
     ancestor, and an impossible commit is never one. */
  ok('CONTROL: the ancestry probe says HEAD is an ancestor of HEAD',
    git('merge-base --is-ancestor HEAD HEAD') !== null);
  const bogus = git('merge-base --is-ancestor 0000000000000000000000000000000000000000 HEAD');
  ok('CONTROL: …and says an unknown commit is not',
    bogus === null,
    'the probe cannot distinguish, so section 3 proves nothing');
}

console.log('');
console.log('  SOKONI merchant-identity registration provenance');
console.log('  ' + '-'.repeat(60));
console.log('  tree: ' + headRef + '   carries ' + REGISTERING_COMMIT + ': ' + (isAncestor ? 'yes' : 'no'));
failures.forEach((f) => console.log('  FAIL  ' + f));
console.log('  ' + pass + ' passed, ' + failures.length + ' failed');
console.log('');
process.exit(failures.length ? 1 : 0);
