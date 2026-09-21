/* ══════════════════════════════════════════════════════════════════════════════
   PRE-FLIGHT SABOTAGE — GCP IAM grant

   This module is almost entirely refusals, and a refusal that never fires is
   indistinguishable from no refusal at all. Each mutation below removes one
   guard. If the suite stays green, that guard was decorative.

   A mutation whose anchor is not present is a VECTOR defect, not a pass.
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT  = path.resolve(__dirname, '..');
const FILE  = path.join(ROOT, 'functions/gcp-iam-grant.js');
const SUITE = path.join(ROOT, 'scripts/test-gcp-iam-grant.js');

const MUTATIONS = [
  { name: 'I1 the forbidden-role check is removed (escalation becomes possible)',
    from: "  if (FORBIDDEN_ROLES.indexOf(role) !== -1) {\n    throw refuse('forbidden-role',",
    to:   "  if (false) {\n    throw refuse('forbidden-role',",
    expect: /refused: roles\/owner/ },

  { name: 'I2 the allowlist stops denying by default',
    from: "  if (GRANTABLE_ROLES.indexOf(role) === -1) {",
    to:   "  if (false) {",
    expect: /an unknown role is refused, not passed through/ },

  { name: 'I3 self-grant becomes possible',
    from: "  if (actorEmail && member.toLowerCase() === ('user:' + String(actorEmail).toLowerCase())) {",
    to:   "  if (false) {",
    expect: /a self-grant is refused/ },

  { name: 'I4 the etag requirement is dropped (a write can clobber)',
    from: "  if (!policy || !policy.etag) {\n    throw refuse('no-etag',\n      'The IAM policy came back without an etag, so a write could overwrite a concurrent ' +",
    to:   "  if (false) {\n    throw refuse('no-etag',\n      'The IAM policy came back without an etag, so a write could overwrite a concurrent ' +",
    expect: /an etag-less policy is refused/ },

  { name: 'I5 auditConfigs are dropped from the written policy',
    from: "      auditConfigs: policy.auditConfigs || [],\n    },\n  };",
    to:   "    },\n  };",
    expect: /auditConfigs are carried through untouched/ },

  { name: 'I6 member validation is removed (allUsers becomes writable)',
    from: "  if (typeof member !== 'string' || !MEMBER_RE.test(member)) {",
    to:   "  if (false) {",
    expect: /refused member/ },

  { name: 'I7 idempotence is lost (a duplicate member is appended)',
    from: "  if (existing && existing.members.indexOf(member) !== -1) {",
    to:   "  if (false) {",
    expect: /an already-granted role reports no change/ },

  { name: 'I8 a dry run actually writes',
    from: "  if (opts.dryRun) {",
    to:   "  if (false) {",
    expect: /a dry run writes NOTHING|a dry run reports no change/ },

  { name: 'I9 revoking an admin role is permitted (lockout becomes possible)',
    from: "  if (FORBIDDEN_ROLES.indexOf(role) !== -1) {\n    throw refuse('forbidden-role',\n      'Removing ' + role",
    to:   "  if (false) {\n    throw refuse('forbidden-role',\n      'Removing ' + role",
    expect: /revoking owner is refused/ },

  { name: 'I10 an emptied binding is left behind',
    from: "  }).filter((b) => (b.members || []).length > 0);",
    to:   "  });",
    expect: /no empty binding is left behind/ },
];

const original = fs.readFileSync(FILE, 'utf8');
let caught = 0, inert = 0, degraded = 0;

console.log('='.repeat(64));
console.log('PRE-FLIGHT SABOTAGE — GCP IAM grant');
console.log('='.repeat(64));

for (const m of MUTATIONS) {
  if (original.indexOf(m.from) === -1) {
    console.log('  ! ' + m.name + '  — VECTOR FAILED: anchor not present');
    inert++;
    continue;
  }
  fs.writeFileSync(FILE, original.replace(m.from, m.to));
  let out = '', failed = false;
  try { out = execFileSync(process.execPath, [SUITE], { encoding: 'utf8' }); }
  catch (e) { failed = true; out = (e.stdout || '') + (e.stderr || ''); }
  fs.writeFileSync(FILE, original);

  if (!failed) { console.log('  ✗ ' + m.name + '  — INERT: the suite stayed green'); inert++; continue; }
  const lines = out.split('\n').filter((l) => /^\s+FAIL\s/.test(l));
  if (lines.some((l) => m.expect.test(l))) {
    console.log('  ✓ ' + m.name + '  — caught by the expected case');
    caught++;
  } else {
    console.log('  ~ ' + m.name + '  — suite failed, but NOT on the expected case');
    lines.slice(0, 2).forEach((l) => console.log('      ' + l.trim()));
    degraded++;
  }
}

fs.writeFileSync(FILE, original);
const restored = fs.readFileSync(FILE, 'utf8') === original;
console.log('='.repeat(64));
console.log('  caught: ' + caught + '   inert: ' + inert + '   degraded: ' + degraded);
console.log('  restored byte-identical: ' + (restored ? 'YES' : 'NO'));
try {
  execFileSync(process.execPath, [SUITE], { encoding: 'utf8' });
  console.log('  post-restore suite: GREEN (nothing stranded)');
} catch (e) {
  console.log('  post-restore suite: RED — SOMETHING IS STRANDED');
  process.exit(1);
}
process.exit(inert || degraded ? 1 : 0);
