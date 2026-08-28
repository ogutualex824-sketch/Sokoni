/* Compare the SERVED ruleset against the artifact we would deploy.
 *
 * A rules deploy REPLACES what production enforces. The repo source carries no commit
 * provenance against production, so the question is not "is my change present" but
 * "does my artifact DROP or WEAKEN anything production enforces today".
 *
 * Whole-file statement sets, not block spans: an earlier block-span version silently
 * produced empty bodies and reported "0 differing" for a file whose shopEmployees rule is
 * KNOWN to differ. Its control caught it and aborted. This version keeps that control.
 */
'use strict';
const fs = require('fs');

const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
const stmts = (text) => {
  const s = strip(text);
  const out = (s.match(/allow[\s\S]*?;/g) || []).map((x) => x.replace(/\s+/g, ' ').trim());
  return out;
};
const bag = (arr) => arr.reduce((m, x) => (m[x] = (m[x] || 0) + 1, m), {});

const SERVED = process.argv[2] || '_served.rules';
if (!fs.existsSync(SERVED)) {
  console.error([
    '  Fetch the SERVED ruleset first (firebaserules.googleapis.com releases ->',
    '  rulesetName -> source.files) and pass its path. Refusing to compare against',
    '  a file that is not the served ruleset — a stale copy already produced one',
    '  false conclusion in this workstream.',
  ].join('\n'));
  process.exit(2);
}
const servedTxt = fs.readFileSync(SERVED, 'utf8');
const artTxt = fs.readFileSync('firestore.rules.build', 'utf8');

const S = stmts(servedTxt), A = stmts(artTxt);
console.log('  served allow statements   : ' + S.length);
console.log('  artifact allow statements : ' + A.length);

const ab = bag(A);
const droppedList = [];
for (const x of S) { if (ab[x]) ab[x]--; else droppedList.push(x); }
const sb = bag(S);
const addedList = [];
for (const x of A) { if (sb[x]) sb[x]--; else addedList.push(x); }

console.log('\n  IN SERVED BUT NOT IN ARTIFACT (dropped or changed): ' + droppedList.length);
droppedList.slice(0, 25).forEach((x) => console.log('     - ' + x.slice(0, 150)));
console.log('\n  IN ARTIFACT BUT NOT IN SERVED (added or changed): ' + addedList.length);
addedList.slice(0, 25).forEach((x) => console.log('     + ' + x.slice(0, 150)));

/* CONTROL: this release rewrites the shopEmployees update rule, so the SERVED form of it
   must show up as "not in artifact". If it does not, the comparison is not working. */
const servedUpdate = droppedList.some((x) =>
  /allow update/.test(x) && /resource\.data\.shopOwnerId == request\.auth\.uid/.test(x)
  && !/request\.resource\.data\.shopOwnerId == resource\.data\.shopOwnerId/.test(x));
const artifactUpdate = addedList.some((x) =>
  /allow update/.test(x) && /request\.resource\.data\.shopOwnerId == resource\.data\.shopOwnerId/.test(x));
console.log('\n  CONTROL served shopEmployees update appears as dropped   : ' + (servedUpdate ? 'yes' : 'NO'));
console.log('  CONTROL artifact shopEmployees update appears as added   : ' + (artifactUpdate ? 'yes' : 'NO'));
if (!servedUpdate || !artifactUpdate) {
  console.error('\n  ABORT: the comparison cannot see a difference it is KNOWN to contain.');
  process.exit(2);
}
console.log('\n  Every other dropped statement above must be an INTENDED change of this release.');
process.exit(0);
