#!/usr/bin/env node
/* ══════════════════════════════════════════════════════════════════════════════
   STRANDED-MUTATION SCANNER — scripts/check-stranded-mutations.js

   A sabotage suite edits real source files in place and restores them. If a run
   is killed, or two runs overlap, a planted defect can be left behind — and the
   next suite adopts it as though it were the code.

   That is not theoretical. On 2026-09-21 two sabotage processes were started
   concurrently; one restored the file while the other held a mutation, and
   `S41` was left stranded in `sokoni-integrations.js`: the observed-state chip
   rendered with an EMPTY title, so the derivation reasoning was silently gone
   from the working tree. The certification had already passed before it
   happened, so nothing flagged it.

   This scanner reads every mutation manifest and asserts, for each vector, that
   the ORIGINAL text is present in the target file. An absent original means the
   file is not in its pristine state — either a mutation is stranded, or the
   source drifted and the vector has silently gone inert.

   Run it before trusting any sabotage result, and before committing.

     node scripts/check-stranded-mutations.js
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';

const fs   = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

/* Every suite that mutates source in place. */
const MANIFESTS = [
  'tests/sabotage-integrations-console.js',
  'tests/sabotage-gcp-evidence.js',
  'tests/sabotage-gcp-iam-grant.js',
  'tests/sabotage-gcp-admin-console.js',
];

let problems = 0, checked = 0, suites = 0;

/** Pull the MUTATIONS array out of a manifest without executing the suite.
    Slicing to the matching bracket and evaluating the literal keeps this
    independent of whether the suite exports anything. */
function mutationsOf (src) {
  const start = src.indexOf('const MUTATIONS = [');
  if (start === -1) return null;
  const open = src.indexOf('[', start);
  /* Find the TERMINATOR, do not count brackets. A mutation's `from` text is
     real source and routinely contains a bracket — `S22` carries `}]` inside a
     string — so counting raw characters closes the array early and the manifest
     fails to parse. The array ends with `];` alone on a line; that is
     unambiguous and cannot occur inside one of these one-line string fields. */
  const term = src.indexOf('\n];', open);
  const end = term === -1 ? -1 : term + 1;
  if (end === -1) return null;
  /* eslint-disable no-new-func */
  try { return new Function('return ' + src.slice(open, end + 1))(); }
  catch (e) { return null; }
}

console.log('══════════════════════════════════════════════════════════════════');
console.log('  STRANDED-MUTATION SCAN');
console.log('══════════════════════════════════════════════════════════════════');

for (const man of MANIFESTS) {
  const manPath = path.join(ROOT, man);
  if (!fs.existsSync(manPath)) { console.log('  SKIP  ' + man + ' (absent)'); continue; }

  const src = fs.readFileSync(manPath, 'utf8');
  const muts = mutationsOf(src);
  if (!muts) {
    console.log('  FAIL  ' + man + ' — could not read its MUTATIONS manifest');
    problems++;
    continue;
  }
  suites++;

  /* A manifest may target one fixed file (the GCP suites) or name a file per
     mutation (the console suite). Resolve both shapes. */
  const fixed = /const\s+FILE\s*=\s*path\.join\(ROOT,\s*'([^']+)'\)/.exec(src);

  for (const m of muts) {
    const rel = m.file || (fixed && fixed[1]);
    if (!rel) { console.log('  FAIL  ' + m.name + ' — no target file'); problems++; continue; }
    const target = path.join(ROOT, rel);
    if (!fs.existsSync(target)) {
      console.log('  FAIL  ' + m.name + ' — target missing: ' + rel);
      problems++;
      continue;
    }
    const body = fs.readFileSync(target, 'utf8');
    checked++;

    if (body.indexOf(m.from) === -1) {
      /* The original is gone. Is the MUTATION sitting there instead? */
      const planted = m.to && m.to.length > 0 && body.indexOf(m.to) !== -1;
      console.log('  ✗ ' + (planted ? 'STRANDED MUTATION' : 'ORIGINAL TEXT ABSENT') +
                  ' — ' + m.name);
      console.log('      file: ' + rel);
      console.log('      ' + (planted
        ? 'the mutated text IS present: restore it before trusting any result'
        : 'the source drifted; this vector is silently INERT until its anchor is updated'));
      problems++;
    }
  }
}

console.log('──────────────────────────────────────────────────────────────────');
console.log('  suites: ' + suites + '   vectors checked: ' + checked +
            '   problems: ' + problems);
if (problems === 0) {
  console.log('  CLEAN — every mutation anchor is present; no defect is stranded.');
} else {
  console.log('  NOT CLEAN — do not trust a sabotage result until this is zero.');
}
console.log('══════════════════════════════════════════════════════════════════');
process.exit(problems === 0 ? 0 : 1);
