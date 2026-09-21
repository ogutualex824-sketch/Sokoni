/* ══════════════════════════════════════════════════════════════════════════════
   PRE-FLIGHT SABOTAGE — integration governance

   The census now refuses to pass unless every integration resolves to a named
   owner and a named authority. That guarantee is worth exactly as much as its
   ability to fail, so each mutation below removes one part of it.

   The last case is not a defect: it is a CONTROL. A change that preserves valid
   inheritance must leave the gate GREEN. Without it, a gate that rejected
   everything would score five out of five and certify nothing.

   Run serially. Never alongside another sabotage suite — a concurrent run
   strands mutations, which is how four defects reached the working tree on
   2026-09-21. Check with scripts/check-stranded-mutations.js afterwards.
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT  = path.resolve(__dirname, '..');
const FILE  = path.join(ROOT, 'sokoni-integration-governance.js');
const GATE  = path.join(ROOT, 'scripts/integration-relationship-census.js');

const MUTATIONS = [
  { name: 'G1 an owner is removed',
    from: "    'Typesense':                                 { owner: CTO, authority: CEO },",
    to:   "    'Typesense':                                 { owner: UNASSIGNED, authority: CEO },",
    expect: /typesense: no OWNER/ },

  { name: 'G2 an authority is removed',
    from: "    'Algolia':                                   { owner: CTO, authority: CEO },",
    to:   "    'Algolia':                                   { owner: CTO, authority: UNASSIGNED },",
    expect: /algolia: no AUTHORITY/ },

  /* The inheritance itself: break the key and every entry behind it loses its
     decision at once. This is the vector that proves 47 entries really do
     depend on 22 rows rather than carrying their own copies. */
  { name: 'G3 the inherited mapping is broken (counterparty key renamed)',
    from: "    'IntaSend':                                  { owner: CFO, authority: CEO },",
    to:   "    'IntaSend Ltd':                              { owner: CFO, authority: CEO },",
    expect: /intasend-collections: no OWNER|counterparty "IntaSend" has no governance row/ },

  { name: 'G4 a counterparty row is removed entirely',
    from: "    'HostPinnacle':                              { owner: COO, authority: CEO },\n",
    to:   "",
    expect: /counterparty "HostPinnacle" has no governance row/ },

  /* `NONE — RAIL CLOSED` must not become a way to leave an OPERATING rail
     unowned, and must never stand in for an authority. */
  { name: 'G5 an operating rail is marked NONE — RAIL CLOSED',
    from: "    'Meta':                                      { owner: CTO, authority: CEO },",
    to:   "    'Meta':                                      { owner: RAIL_CLOSED, authority: CEO },",
    expect: /facebook-login: owner is .* but its lifecycle is "live"/ },

  { name: 'G6 a closed rail loses its authority to the closed sentinel',
    from: "      note: 'Rail is quarantined and no acquirer has signed. Owner is deliberately ' +",
    to:   "      authority: RAIL_CLOSED,\n      note: 'Rail is quarantined and no acquirer has signed. Owner is deliberately ' +",
    expect: /pos-card-terminal: authority is/ },

  { name: 'G7 an override is added with no stated reason',
    from: "  var OVERRIDES = {\n",
    to:   "  var OVERRIDES = {\n    'typesense': { owner: CTO, authority: CEO },\n",
    expect: /override "typesense" states no reason/ },
];

/* ── THE CONTROL ──────────────────────────────────────────────────────────
   A change that PRESERVES valid inheritance must not fail the gate. Renaming
   a role's variable value is a real edit to this file and leaves every entry
   still resolving to a named owner and authority. If this reddens, the gate is
   rejecting on something other than what it claims to check. */
const CONTROL = {
  name: 'C1 CONTROL — a valid governance edit keeps the gate GREEN',
  from: "  var CTO = 'CTO — Donna Obongo';",
  to:   "  var CTO = 'CTO — D. Obongo';",
};

function runGate () {
  try {
    const out = execFileSync(process.execPath, [GATE], { encoding: 'utf8' });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status === undefined ? 1 : e.status,
             out: (e.stdout || '') + (e.stderr || '') };
  }
}

const original = fs.readFileSync(FILE, 'utf8');
let caught = 0, inert = 0, degraded = 0;

console.log('='.repeat(64));
console.log('PRE-FLIGHT SABOTAGE — integration governance');
console.log('='.repeat(64));

for (const m of MUTATIONS) {
  if (original.indexOf(m.from) === -1) {
    console.log('  ! ' + m.name + '  — VECTOR FAILED: anchor not present');
    inert++;
    continue;
  }
  fs.writeFileSync(FILE, original.replace(m.from, m.to));
  let r;
  try { r = runGate(); } finally { fs.writeFileSync(FILE, original); }

  if (r.code === 0) {
    console.log('  ✗ ' + m.name + '  — INERT: the gate stayed green');
    inert++;
  } else if (m.expect.test(r.out)) {
    console.log('  ✓ ' + m.name + '  — caught by the expected finding');
    caught++;
  } else {
    console.log('  ~ ' + m.name + '  — gate failed, but NOT on the expected finding');
    console.log('      ' + (r.out.split('✗')[1] || '').trim().slice(0, 120));
    degraded++;
  }
}

/* The control runs last, on a restored file. */
if (original.indexOf(CONTROL.from) === -1) {
  console.log('  ! ' + CONTROL.name + '  — VECTOR FAILED: anchor not present');
  inert++;
} else {
  fs.writeFileSync(FILE, original.replace(CONTROL.from, CONTROL.to));
  let r;
  try { r = runGate(); } finally { fs.writeFileSync(FILE, original); }
  if (r.code === 0) {
    console.log('  ✓ ' + CONTROL.name);
    caught++;
  } else {
    console.log('  ✗ ' + CONTROL.name + '  — THE GATE REJECTED A VALID EDIT');
    console.log('      ' + (r.out.split('✗')[1] || '').trim().slice(0, 160));
    inert++;
  }
}

fs.writeFileSync(FILE, original);
const restored = fs.readFileSync(FILE, 'utf8') === original;
console.log('='.repeat(64));
console.log('  caught: ' + caught + '   inert: ' + inert + '   degraded: ' + degraded);
console.log('  restored byte-identical: ' + (restored ? 'YES' : 'NO'));
const after = runGate();
console.log('  post-restore gate: ' + (after.code === 0
  ? 'GREEN (nothing stranded)' : 'RED — A MUTATION WAS STRANDED'));
process.exit(inert === 0 && degraded === 0 && after.code === 0 && restored ? 0 : 1);
