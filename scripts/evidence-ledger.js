#!/usr/bin/env node
'use strict';
/* ══════════════════════════════════════════════════════════════════════════
   SOKONI — Engineering Evidence Ledger

   node scripts/evidence-ledger.js              full ledger
   node scripts/evidence-ledger.js --assumed    only what nobody has evidence for
   node scripts/evidence-ledger.js --gate       exit 1 if a launch-critical claim is unproven
   node scripts/evidence-ledger.js --json

   THE ONE RULE THAT MAKES THIS WORTH HAVING
   State is DERIVED from sources. It is never read from the file.

   A ledger where a claim declares its own status is a ledger of opinions with
   extra steps — the first time someone writes "state": "CERTIFIED" next to a
   claim nobody tested, the whole structure becomes decoration. Here the file
   holds only evidence; the state is computed, and a claim cannot promote
   itself.

   The five states are graded by what the evidence actually IS:

     ASSUMED    no source. A belief held by a person.
     OBSERVED   sources exist, but none was executed. Reading code is not
                verification — this session produced several confident wrong
                readings that a single execution disproved.
     VERIFIED   at least one executed source: a test run or a runtime
                measurement.
     CERTIFIED  two or more independent source TYPES agree, at least one
                executed.
     REJECTED   contradicting evidence outweighs support.
   ══════════════════════════════════════════════════════════════════════════ */

const fs = require('fs');

const ARGS = process.argv.slice(2);
const ONLY_ASSUMED = ARGS.includes('--assumed');
const GATE = ARGS.includes('--gate');
const JSON_OUT = ARGS.includes('--json');

let L;
try {
  L = JSON.parse(fs.readFileSync('evidence.json', 'utf8'));
} catch (e) {
  console.error('\n  evidence.json missing or unreadable: ' + e.message + '\n');
  process.exit(2);
}

const TYPES = L.sourceTypes || {};
const executed = (s) => !!(TYPES[s.type] && TYPES[s.type].executed);

/* ── the derivation ─────────────────────────────────────────────────────── */
function derive(claim) {
  const src = claim.sources || [];
  const con = claim.contradictions || [];

  /* Contradiction first. A claim with strong support AND a runtime
     contradiction is not "mostly true" — the contradiction is the finding.
     CLM-003 is exactly this: 32 passing tests, and no administrator exists. */
  const executedContra = con.filter(executed).length;
  if (executedContra > 0) return { state: 'REJECTED', why: executedContra + ' executed contradiction(s)' };
  if (con.length > 0 && src.length === 0) return { state: 'REJECTED', why: 'contradicted, unsupported' };

  if (src.length === 0) {
    return con.length
      ? { state: 'REJECTED', why: 'contradicted, unsupported' }
      : { state: 'ASSUMED', why: 'no source of any kind' };
  }

  const executedSrc = src.filter(executed);
  const distinctTypes = new Set(src.map((s) => s.type));

  if (executedSrc.length === 0) {
    return { state: 'OBSERVED', why: src.length + ' source(s), none executed' };
  }
  if (distinctTypes.size >= 2 && executedSrc.length >= 1) {
    /* Different source TYPE is not the same as independent OBSERVATION.
       CLM-001 was certified on "repository + test" where the test parses the
       very file the repository claim is about — two readings of one artifact,
       which cannot disagree. The first run of this ledger reported that as
       CERTIFIED and it was wrong.

       A claim may now declare `sharedArtifact: true` to say its sources look at
       the same thing. It is a manual honesty flag, not a detection: the ledger
       cannot know what a test actually exercises. Declaring it downgrades the
       claim, so the incentive runs the right way. */
    if (claim.sharedArtifact) {
      return { state: 'VERIFIED', why: distinctTypes.size + ' source types, but all read the same artifact' };
    }
    return { state: 'CERTIFIED', why: distinctTypes.size + ' independent source types agree' };
  }
  return { state: 'VERIFIED', why: executedSrc.length + ' executed source(s), single type' };
}

const rows = (L.claims || []).map((c) => {
  const d = derive(c);
  return { ...c, state: d.state, why: d.why };
});

/* ── freshness ──────────────────────────────────────────────────────────── */
const today = new Date('2026-07-20');
const ageDays = (c) => {
  const all = [...(c.sources || []), ...(c.contradictions || [])];
  if (!all.length) return null;
  const newest = all.map((s) => new Date(s.date)).sort((a, b) => b - a)[0];
  return Math.round((today - newest) / 86400000);
};

const counts = rows.reduce((a, r) => (a[r.state] = (a[r.state] || 0) + 1, a), {});
const unproven = rows.filter((r) => r.state === 'ASSUMED' || r.state === 'REJECTED');

if (JSON_OUT) {
  console.log(JSON.stringify({ counts, claims: rows.map((r) => ({ id: r.id, claim: r.claim, state: r.state, why: r.why })) }, null, 2));
  process.exit(GATE && unproven.length ? 1 : 0);
}

const ICON = { CERTIFIED: '✓✓', VERIFIED: '✓ ', OBSERVED: '~ ', ASSUMED: '? ', REJECTED: '✗ ' };
const ORDER = { REJECTED: 0, ASSUMED: 1, OBSERVED: 2, VERIFIED: 3, CERTIFIED: 4 };

console.log('\n' + '═'.repeat(84));
console.log('  SOKONI — ENGINEERING EVIDENCE LEDGER');
console.log('  State is derived from sources. No claim declares its own status.');
console.log('═'.repeat(84));

const shown = ONLY_ASSUMED ? rows.filter((r) => r.state === 'ASSUMED') : rows;
shown.sort((a, b) => ORDER[a.state] - ORDER[b.state]).forEach((r) => {
  const age = ageDays(r);
  console.log('\n  ' + (ICON[r.state] || '  ') + ' [' + r.state + '] ' + r.id +
    (age !== null ? '   evidence ' + age + 'd old' : ''));
  console.log('      ' + r.claim);
  console.log('      basis: ' + r.why);
  (r.sources || []).forEach((s) =>
    console.log('        + ' + s.type.padEnd(11) + s.ref.slice(0, 62)));
  (r.contradictions || []).forEach((s) =>
    console.log('        - ' + s.type.padEnd(11) + s.ref.slice(0, 62)));
  if (r.note) console.log('      note: ' + r.note);
});

console.log('\n' + '═'.repeat(84));
console.log('  ' + Object.keys(ORDER).sort((a, b) => ORDER[b] - ORDER[a])
  .map((k) => k + ' ' + (counts[k] || 0)).join('  ·  '));

console.log('\n  THE EXECUTIVE QUESTIONS');
const cert = rows.filter((r) => r.state === 'CERTIFIED');
const rej = rows.filter((r) => r.state === 'REJECTED');
const asm = rows.filter((r) => r.state === 'ASSUMED');
console.log('    What is proven?          ' + (cert.length ? cert.map((r) => r.id).join(', ') : 'nothing'));
console.log('    What is disproven?       ' + (rej.length ? rej.map((r) => r.id).join(', ') : 'nothing'));
console.log('    What has never been      ' + (asm.length ? asm.map((r) => r.id).join(', ') : 'nothing'));
console.log('      measured at all?');

if (rej.length) {
  console.log('\n  WHY THE PLATFORM IS NOT LAUNCH-READY — each has executed evidence AGAINST it:');
  rej.forEach((r) => console.log('    ' + r.id + '  ' + r.claim));
}
if (asm.length) {
  console.log('\n  UNMEASURED — no evidence for OR against. Not a pass:');
  asm.forEach((r) => console.log('    ' + r.id + '  ' + r.claim));
}

console.log('\n' + '═'.repeat(84));
console.log('  LEDGER GATE: ' + (unproven.length === 0 ? 'CLEAR' : 'BLOCKED — ' + unproven.length + ' unproven claim(s)'));
console.log('═'.repeat(84) + '\n');

process.exit(GATE && unproven.length ? 1 : 0);
