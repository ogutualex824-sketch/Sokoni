/* ══════════════════════════════════════════════════════════════════════════════
   PRE-FLIGHT SABOTAGE — GCP access-management surface

   This is the console's only write surface, and its guards are the difference
   between "grant access from the page" and "grant access by misclicking". Each
   mutation removes one. A green suite afterwards means that guard was theatre.
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT  = path.resolve(__dirname, '..');
const FILE  = path.join(ROOT, 'sokoni-gcp-admin.js');
const SUITE = path.join(ROOT, 'tests/certify-gcp-admin-console.js');

const MUTATIONS = [
  { name: 'A1 the typed confirmation is bypassed at commit',
    from: "      if (_confirm.typed !== _confirm.member) {",
    to:   "      if (false) {",
    expect: /a mismatched confirmation sends nothing/ },

  { name: 'A2 the action fires immediately, with no confirmation at all',
    from: "    _confirm = { kind: kind, verb: verb, member: member, role: role, typed: '', extra: extra || null };",
    to:   "    _confirm = { kind: kind, verb: verb, member: member, role: role, typed: member, extra: extra || null };",
    expect: /the confirm button is disabled until the member is typed|a mismatched confirmation sends nothing/ },

  { name: 'A3 a staged confirmation survives a change of member',
    from: "    _dirty: function () { if (_confirm) { _confirm = null; _render(); } },",
    to:   "    _dirty: function () { },",
    expect: /the staged confirmation was discarded/ },

  { name: 'A4 the form is shown to a non-superAdmin',
    from: "    if (!_isSuperAdmin()) {",
    to:   "    if (false) {",
    expect: /no member field is offered|no grant button is offered/ },

  { name: 'A5 the panel stops saying the server is the real control',
    from: "        'server would refuse the call regardless, which is where the actual control lives.</p>' +",
    to:   "        'panel is hidden.</p>' +",
    expect: /it says the server would refuse regardless/ },

  { name: 'A6 SOKONI and Google Cloud access are conflated',
    from: "        ? '<p class=\"sic-note\">This changes access to <strong>SOKONI</strong>. It does not change ' +\n          'Google Cloud access.</p>'",
    to:   "        ? '<p class=\"sic-note\">This changes access everywhere.</p>'",
    expect: /a platform confirmation says Google Cloud is unchanged/ },

  { name: 'A7 a server refusal is swallowed and reported as success',
    from: "         _finish(false, (e && e.message) || 'The call failed.', '');",
    to:   "         _finish(true, 'Done.', '');",
    expect: /the refusal is rendered|a refusal is not rendered as Done/ },

  { name: 'A8 the stated limits are dropped from the panel',
    from: "      '<p class=\"sic-note\"><strong>What this will refuse.</strong> Owner, Editor and every ' +",
    to:   "      '<p class=\"sic-note\"><strong>Ready.</strong> Every ' +",
    expect: /the panel states owner and editor are never grantable/ },

  { name: 'A9 the platform role stops using the canonical path',
    from: "        p = _call('setUserRole', { uid: c.member, role: c.role })",
    to:   "        p = _call('superAdminGrantGcpRole', { uid: c.member, role: c.role })",
    expect: /it reaches exactly three callables|the platform role goes through the EXISTING canonical path/ },
];

const original = fs.readFileSync(FILE, 'utf8');
let caught = 0, inert = 0, degraded = 0;

console.log('='.repeat(64));
console.log('PRE-FLIGHT SABOTAGE — GCP access management');
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
