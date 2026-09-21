/* Pre-flight sabotage for the GCP evidence reader.
   Each mutation plants the exact defect the reader exists to prevent.
   A mutation that does not apply is a VECTOR defect, not a pass. */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT  = path.resolve(__dirname, '..');
const FILE  = path.join(ROOT, 'functions/gcp-evidence.js');
const SUITE = path.join(ROOT, 'scripts/test-gcp-evidence.js');

const MUTATIONS = [
  { name: 'G1 an unreadable read reports 0 instead of no value',
    from: "return { value: null, state: 'unreadable', source: source || null,",
    to:   "return { value: 0, state: 'unreadable', source: source || null,",
    expect: /it has NO value at all|it is NOT zero/ },

  { name: 'G2 a measured empty collapses into a plain observation',
    from: "state: empty && value !== null ? 'empty' : (value === null ? 'not-attempted' : 'observed'),",
    to:   "state: value === null ? 'not-attempted' : 'observed',",
    expect: /empty collection list is EMPTY|reconciled database reports zero drift as EMPTY/ },

  { name: 'G3 missing declarations default drift to zero',
    from: "      db.indexesDeclared = notAttempted('The caller supplied no repository declaration count.');",
    to:   "      db.indexesDeclared = observation(0, 'defaulted');",
    expect: /the declaration itself is also not-attempted/ },

  { name: 'G4 a failed index read silently becomes an empty index set',
    from: "    out.indexesDeployed = unreadable('firestore.indexes.list', e.message);",
    to:   "    out.indexesDeployed = observation(0, 'firestore.indexes.list');",
    expect: /a refused index read is unreadable/ },

  { name: 'G5 the quota falls back to a hardcoded limit',
    from: "    envelope.quota = unreadable('serviceusage.quota', e.message);",
    to:   "    envelope.quota = observation(200, 'serviceusage.quota');",
    expect: /an unreadable quota is unreadable/ },
];

const original = fs.readFileSync(FILE, 'utf8');
let caught = 0, inert = 0, degraded = 0;

console.log('='.repeat(60));
console.log('PRE-FLIGHT SABOTAGE — GCP evidence reader');
console.log('='.repeat(60));

for (const m of MUTATIONS) {
  if (original.indexOf(m.from) === -1) {
    console.log('  ! ' + m.name + '  — VECTOR FAILED: anchor not present');
    inert++;
    continue;
  }
  fs.writeFileSync(FILE, original.replace(m.from, m.to));
  let out = '';
  let failed = false;
  try {
    out = execFileSync(process.execPath, [SUITE], { encoding: 'utf8' });
  } catch (e) {
    failed = true;
    out = (e.stdout || '') + (e.stderr || '');
  }
  fs.writeFileSync(FILE, original);

  if (!failed) { console.log('  ✗ ' + m.name + '  — INERT: the suite still passed'); inert++; continue; }
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
console.log('='.repeat(60));
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
