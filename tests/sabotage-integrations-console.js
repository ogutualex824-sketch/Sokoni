/* Pre-flight sabotage: plant a real defect, confirm the suite CATCHES it,
   restore. A suite that stays green under sabotage is inert and certifies
   nothing. Runs strictly sequentially and always restores, so a mutation is
   never left behind for the next run to adopt. */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SUITE = path.join(ROOT, 'tests/certify-integrations-console.js');

const MUTATIONS = [
  /* `_count()` feeds the TAB PILLS and nothing else — see its four call sites in
     _tabs(). The stat tiles do not go through it; each carries its own inline
     ternary, which is what A1 covers and what S2 mutates.

     So A1 CANNOT detect this mutation, and the old expectation `/A1|Registered/`
     was pointing at a case that does not own this code path. The run was still
     reported as caught, but only as "something failed" — the weaker signal the
     `~` marker exists to flag. A5 is the case that actually owns the pills, and
     it fires with exactly the right message: `pill is em dash when unreadable —
     got "0"`.

     Pinned to A5 deliberately rather than widened to /A1|A5/. A loose pattern
     would let an unrelated A1 failure stand in for this guard and report a
     green catch while the pill coverage had silently gone. */
  { name: 'S1 unknown rendered as 0 instead of em dash',
    file: 'sokoni-integrations.js',
    from: "function _count(ok, n) { return ok ? String(n) : EM; }",
    to:   "function _count(ok, n) { return ok ? String(n) : '0'; }",
    expect: /A5 .*pill is em dash when unreadable/ },

  { name: 'S2 stat tiles fabricate 0 when the source is unreadable',
    file: 'sokoni-integrations.js',
    from: "      cell('ok', 'Healthy', t ? String(t.healthy) : EM,",
    to:   "      cell('ok', 'Healthy', t ? String(t.healthy) : '0',",
    expect: /A1 Healthy|A2 Healthy/ },

  { name: 'S3 the webhook signing secret is rendered',
    file: 'sokoni-integrations.js',
    from: "'<td class=\"sic-mono\">' + _esc(w.sellerId || EM) + '</td>' +",
    to:   "'<td class=\"sic-mono\">' + _esc(w.sellerId || EM) + _esc(w.secret || '') + '</td>' +",
    expect: /B1/ },

  { name: 'S4 escaping removed from rendered field values',
    file: 'sokoni-integrations.js',
    from: "  function _esc(v) {\n    return String(v == null ? '' : v).replace(/[&<>\"']/g, function (c) {",
    to:   "  function _esc(v) {\n    return String(v == null ? '' : v).replace(/[\\u0000]/g, function (c) {",
    expect: /C1/ },

  { name: 'S5 a Daraja rail reappears in the catalogue',
    file: 'sokoni-integration-catalogue.js',
    from: "  /* ── Indexes ──",
    to:   "  INTEGRATIONS.push({ id:'daraja-stk', name:'Daraja STK', vendor:'Safaricom', category:'payments', icon:'x', status:'live', direction:'outbound', summary:'s', health:{source:null,note:'n'} });\n\n  /* ── Indexes ──",
    expect: /D1/ },

  { name: 'S6 a service with no heartbeat is reported as healthy',
    file: 'sokoni-integrations.js',
    from: "    if (!h)               return { key: 'unknown', label: 'No heartbeat', hb: 0, h: {} };",
    to:   "    if (!h)               return { key: 'healthy', label: 'Healthy', hb: 0, h: {} };",
    expect: /A3/ },

  { name: 'S7 the Super Admin sidebar entry is removed',
    file: 'super-admin.html',
    from: '<button class="nav-item" data-section="integrations"',
    to:   '<button class="nav-item" data-section="integrations-REMOVED"',
    expect: /E2/ },

  { name: 'S8 the console gains a write path',
    file: 'sokoni-integrations.js',
    from: "  function load() {",
    to:   "  function _danger(){ return _db().collection('x').doc('y').set({a:1}); }\n  function load() {",
    expect: /E4/ },
];

function runSuite() {
  try {
    execFileSync(process.execPath, [SUITE], { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' });
    return { code: 0, out: '' };
  } catch (e) {
    return { code: e.status === undefined ? -1 : e.status, out: (e.stdout || '') + (e.stderr || '') };
  }
}

let inert = 0, caught = 0;
console.log('\nPRE-FLIGHT SABOTAGE \u2014 each mutation must be CAUGHT\n' + '='.repeat(60));

for (const m of MUTATIONS) {
  const p = path.join(ROOT, m.file);
  const original = fs.readFileSync(p, 'utf8');
  if (original.indexOf(m.from) === -1) {
    console.log('  ? ' + m.name + '  \u2014 ANCHOR NOT FOUND (mutation could not be planted)');
    inert++;
    continue;
  }
  fs.writeFileSync(p, original.replace(m.from, m.to), 'utf8');
  let r;
  try { r = runSuite(); } finally { fs.writeFileSync(p, original, 'utf8'); }

  if (r.code === 0) {
    console.log('  \u2717 ' + m.name + '  \u2014 SUITE STAYED GREEN (assertion is INERT)');
    inert++;
  } else if (m.expect.test(r.out)) {
    console.log('  \u2713 ' + m.name + '  \u2014 caught by the expected case');
    caught++;
  } else {
    console.log('  ~ ' + m.name + '  \u2014 suite failed, but NOT on the expected case');
    console.log('      ' + (r.out.split('\u2717')[1] || '').trim().slice(0, 120));
    caught++;
  }
}

console.log('='.repeat(60));
console.log('  caught: ' + caught + '   inert: ' + inert);

/* Restoration proof: the suite must be green again after every mutation is
   reverted. Otherwise a mutation was stranded. */
const after = runSuite();
console.log('  post-restore suite: ' + (after.code === 0 ? 'GREEN (nothing stranded)' : 'RED \u2014 A MUTATION WAS STRANDED'));
process.exit(inert === 0 && after.code === 0 ? 0 : 1);
