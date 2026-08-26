#!/usr/bin/env node
/* Read-only capacity analysis of a firestore.rules file.
   Reports WHERE the bytes go, against the repo's own ceiling assertion
   (scripts/test-printjobs-rules.js: rules.length <= 256000).

   It changes nothing. Usage:
       node scripts/analyze-rules-capacity.js [path-to-firestore.rules]

   Escaping regexes through a shell heredoc mangled them twice today, so this lives in a
   file where the patterns are written once and read literally. */
'use strict';
const fs = require('fs');

const CEILING = 256000;
const file = process.argv[2] || 'firestore.rules';
const s = fs.readFileSync(file, 'utf8');
const total = s.length;

const sum = (re) => {
  let n = 0, c = 0, m;
  const r = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
  while ((m = r.exec(s)) !== null) { n += m[0].length; c++; if (m[0].length === 0) r.lastIndex++; }
  return { bytes: n, count: c };
};

const blockComments = sum(/\/\*[\s\S]*?\*\//g);
const lineComments  = sum(/\/\/[^\n]*/g);
const blankLines    = sum(/^[ \t]*\r?\n/gm);
const indentation   = sum(/^[ \t]+/gm);

console.log('\n  ' + file);
console.log('  ' + '─'.repeat(64));
console.log('  total                 ' + String(total).padStart(8) +
            '   ceiling ' + CEILING + (total > CEILING
              ? '  → OVER by ' + (total - CEILING)
              : '  → ' + (CEILING - total) + ' free'));
console.log('  ' + '─'.repeat(64));
const row = (label, r) => console.log('  ' + label.padEnd(22) + String(r.bytes).padStart(8) +
  '   ' + (100 * r.bytes / total).toFixed(1).padStart(5) + '%   ' + r.count + ' occurrences');
row('block comments', blockComments);
row('line comments', lineComments);
row('leading indentation', indentation);
row('blank lines', blankLines);

const strippable = blockComments.bytes + lineComments.bytes;
console.log('  ' + '─'.repeat(64));
console.log('  comments alone        ' + String(strippable).padStart(8) +
            '   removing them would leave ' + (total - strippable) +
            ' (' + (CEILING - (total - strippable)) + ' free)');

/* Duplication: identical non-trivial lines are the mechanical reduction the brief asks about. */
const lines = s.split('\n').map((l) => l.trim()).filter((l) => l.length > 12 && !l.startsWith('//') && !l.startsWith('/*') && !l.startsWith('*'));
const freq = new Map();
lines.forEach((l) => freq.set(l, (freq.get(l) || 0) + 1));
const dupes = [...freq.entries()].filter(([, n]) => n > 1)
  .map(([l, n]) => ({ l, n, waste: l.length * (n - 1) }))
  .sort((a, b) => b.waste - a.waste);
const totalWaste = dupes.reduce((a, d) => a + d.waste, 0);

console.log('\n  repeated source lines (>12 chars, code only)');
console.log('  ' + '─'.repeat(64));
console.log('  distinct repeated     ' + String(dupes.length).padStart(8));
console.log('  redundant bytes       ' + String(totalWaste).padStart(8) +
            '   if each appeared once');
console.log('\n  top repeats:');
dupes.slice(0, 12).forEach((d) => {
  console.log('    x' + String(d.n).padStart(3) + '  ' + String(d.waste).padStart(6) + 'b  ' +
              d.l.slice(0, 62));
});

console.log('\n  NOTE: none of the above is a recommendation to delete anything. Comments in a');
console.log('  DEPLOYED rules file are real bytes, but they are also the only explanation of');
console.log('  why each boundary exists. Any reduction must be proven by the rules suites,');
console.log('  and by sabotaging each authorization boundary to confirm the tests still bite.\n');
