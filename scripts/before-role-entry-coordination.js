/* Coordinated role navigation — BEFORE-PROOF. Measures. CHANGES NOTHING.

   Run:  node scripts/before-role-entry-coordination.js

   THE TARGET BEHAVIOUR
       tap a role  ->  does this UID actually hold it?
                         YES -> set activeRole through the authority, then navigate
                         NO  -> explicit access-denied; never "navigate and hope"

   Changing activeRole must never create authority, and navigation must never be the
   security boundary — the destination re-checks regardless.

   WHAT THIS FILE ASSERTS
   That every role-switch affordance consults an authority BEFORE switching, and has an
   explicit denial path. Two of the three do. The third does not, and does not even load
   an authority module to ask.
*/
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

let pass = 0, fail = 0, unproven = 0;
const ck = (l, ok, d) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d ? '   [' + String(d).slice(0, 86) + ']' : ''));
  ok ? pass++ : fail++;
};
const un = (l, d) => { console.log('  UNPROVEN  ' + l + (d ? '   [' + d + ']' : '')); unproven++; };

console.log('\nCOORDINATED ROLE NAVIGATION — BEFORE-PROOF');
console.log('='.repeat(78));

/* ── 1. switcher parity ── */
console.log('\n1 — every switcher must ask an authority before switching');

const SWITCHERS = [
  { name: 'shared-header._skSwitchRole', file: 'shared-header.js',
    body: (s) => s.slice(s.indexOf('window._skSwitchRole = async function'),
                         s.indexOf('function _skMirrorRoleLocally')) },
  { name: 'profile.switchRole', file: 'profile.html',
    body: (s) => { const i = s.indexOf('function switchRole('); return s.slice(i, i + 1800); } },
  { name: 'account-centre.acSwitchRole', file: 'account-centre.html',
    body: (s) => { const i = s.indexOf('window.acSwitchRole = function'); return s.slice(i, i + 1400); } },
];

for (const sw of SWITCHERS) {
  const body = sw.body(read(sw.file));
  /* "Asks the authority" is satisfied EITHER by calling setActiveRole directly OR by
     delegating to _skSwitchRole, which does. Delegation is the intended end state — three
     rival implementations was the defect — so a predicate that only accepted a direct call
     would mark the correct fix as a failure. It still fails a switcher that asks nobody. */
  const asks = /setActiveRole\s*\(/.test(body) || /_skSwitchRole\s*\(/.test(body);
  const denies = /not-approved|rejected-by-server|Cannot switch|Could not switch|needs approval|not available on this account|showAccessDenied/.test(body);
  ck(sw.name.padEnd(32) + 'asks the authority (directly or by delegation)', asks,
     asks ? '' : 'neither setActiveRole nor _skSwitchRole');
  ck(sw.name.padEnd(32) + 'has an explicit denial path', denies, denies ? '' : 'no refusal branch');
}

/* The delegation must be REAL: no local role assertion may survive alongside it. */
const acFull = read('account-centre.html');
const acFn = acFull.slice(acFull.indexOf('window.acSwitchRole = function'),
                          acFull.indexOf('window.acSwitchRole = function') + 1400);
ck('acSwitchRole no longer reorders roles locally', !/roles\.unshift\(/.test(acFn));
ck('acSwitchRole no longer writes sokoniUser to localStorage',
   !/localStorage\.setItem\('sokoniUser'/.test(acFn));
ck('acSwitchRole refuses rather than mirroring when the switcher is absent',
   /showAccessDenied|Cannot switch roles/.test(acFn) && !/_skMirrorRoleLocally/.test(acFn));

/* ── 2. can the offending page even ask? ── */
console.log('\n2 — the authority modules a page loads');
for (const f of ['account-centre.html', 'profile.html']) {
  const s = read(f);
  const ra = s.indexOf('sokoni-role-authority') > -1;
  const perms = s.indexOf('sokoni-permissions') > -1;
  console.log('        ' + f.padEnd(24) + 'role-authority=' + ra + '  permissions=' + perms);
}
ck('account-centre.html loads an authority module it can consult',
   read('account-centre.html').indexOf('sokoni-role-authority') > -1,
   'loads no sokoni-role-authority.js — delegation would fall back to a local mirror');
/* Compare the actual TAGS. The first textual mention of "shared-header.js" in this file is
   inside a comment 400 bytes earlier, so an indexOf on the bare filename compares against
   prose — the same mistake the Location.prototype predicate made. */
const acSrc = read('account-centre.html');
const raTag = acSrc.indexOf('<script src="sokoni-role-authority.js"');
const shTag = acSrc.indexOf('<script src="shared-header.js"');
ck('   └─ and its TAG precedes the shared-header TAG, so _skSwitchRole can ask',
   raTag > -1 && shTag > -1 && raTag < shTag, 'ra@' + raTag + ' sh@' + shTag);

/* ── 3. the client-writable chain, in source ── */
console.log('\n3 — what an unauthorised switch writes, and who reads it');
/* The chain had two halves: a WRITER with no authority, and a READER that trusts client
   state. This slice closes the writer only — the reader is a different control and gets
   its own before-proof, so these assertions record that split rather than blur it. */
const ac = read('account-centre.html');
const acBody = ac.slice(ac.indexOf('window.acSwitchRole = function'), ac.indexOf('window.acSwitchRole = function') + 1400);
const writesLocal = /localStorage\.setItem\('sokoniUser'/.test(acBody) && /_u\.role\s*=\s*role/.test(acBody);
ck('WRITER half closed — no unauthorised switch writes sokoniUser', !writesLocal);

const sa = read('seller-analytics.html');
const reader = (sa.match(/function _isSellerDoc\(d\)\{([\s\S]*?)\n  \}/) || [])[1] || '';
const readsSame = /d\.roles/.test(reader) && /d\.role/.test(reader) && /admin/.test(reader);
ck('READER half still trusts client state (separate item, NOT fixed here)', readsSame,
   readsSame ? 'by design: tracked as its own before-proof' : 'reader changed unexpectedly');

/* The fallback triggers — both reachable without a server. */
const fallbackTriggers = /if\(!window\.firebaseDB\)\{\s*_lsFallback\(\)/.test(sa) &&
                         /catch\(function\(\)\{[\s\S]{0,120}_lsFallback\(\)/.test(sa);
ck('_lsFallback fires on missing firebaseDB AND on network failure', fallbackTriggers);
ck('the page entry gate is itself client-writable (localStorage.loggedIn)',
   /localStorage\.getItem\('loggedIn'\)\s*!==\s*'true'/.test(sa));

/* ── 4. reproduction attempt, recorded honestly ── */
console.log('\n4 — behavioural reproduction');
un('client-writable localStorage grants the seller-analytics surface',
   'attempted: seeded loggedIn+sokoniUser{role:admin} was DENIED (landed /index.html)');
console.log('        A seeded admin and a seeded buyer were BOTH denied, so an earlier guard');
console.log('        refuses first in this configuration. Which guard was NOT identified.');
console.log('        The source weakness stands; its reachability does not.');

/* ── 5. the denial surface already exists ── */
console.log('\n5 — an explicit access-denied state exists and is unused by the offender');
ck('SokoniPermissions exposes showAccessDenied()', /showAccessDenied,/.test(read('sokoni-permissions.js')));
ck('acSwitchRole now uses that surface instead of asserting a role', /showAccessDenied/.test(acBody));

console.log('\n  ' + pass + ' passed, ' + fail + ' failed, ' + unproven + ' unproven\n');
console.log('  Measurement only. No switcher was changed.\n');
process.exit(fail ? 1 : 0);
