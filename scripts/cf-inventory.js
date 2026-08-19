/* ══════════════════════════════════════════════════════════════════════════════
   CF INVENTORY — what the 1692 exports actually ARE
   ══════════════════════════════════════════════════════════════════════════════
   The architecture gate says "consolidate before deploying" and nothing more.
   Consolidation cannot start from a number; it needs the population. This
   enumerates the real export set the same way the gate does (runtime, never
   regex — index.js generates ~147 exports from trigger factories) and groups it
   so the programme can be planned against evidence.

   READ ONLY. Writes one report to docs/, deploys nothing, deletes nothing.

     node scripts/cf-inventory.js                 # report
     node scripts/cf-inventory.js --json          # machine-readable
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const INDEX = path.join(ROOT, 'functions/index.js');

process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'sokoni-aeb26';
process.env.FIREBASE_CONFIG = process.env.FIREBASE_CONFIG ||
  JSON.stringify({ projectId: 'sokoni-aeb26' });

let mod;
try {
  mod = require(INDEX);
} catch (e) {
  console.error('\n  Could not load functions/index.js: ' + e.message);
  console.error('  Run from a tree with functions/node_modules installed.\n');
  process.exit(1);
}

const names = Object.keys(mod);

/* Which module each export came from, by reading the literal assignments in
   index.js. Factory-generated exports have no literal line — they are grouped
   by their own name prefix instead, which is how they are generated. */
const src = fs.readFileSync(INDEX, 'utf8');
const originOf = {};
const reAssign = /^exports\.([A-Za-z0-9_]+)\s*=\s*([A-Za-z0-9_$]+)\s*\./gm;
let m;
while ((m = reAssign.exec(src))) originOf[m[1]] = m[2];

/* requires: local alias -> module file */
const reReq = /(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=\s*require\(['"]\.\/([^'"]+)['"]\)/g;
const aliasFile = {};
while ((m = reReq.exec(src))) aliasFile[m[1]] = m[2].replace(/\.js$/, '');

const FACTORY = [
  { prefix: 'algoliaSync', label: '(factory) algoliaSync' },
  { prefix: 'searchSync',  label: '(factory) searchSync' },
  { prefix: 'ts_',         label: '(factory) ts_ triggers' },
];

const groups = {};
for (const n of names) {
  let g = null;
  const fac = FACTORY.find((f) => n.indexOf(f.prefix) === 0);
  if (fac) g = fac.label;
  else if (originOf[n]) g = aliasFile[originOf[n]] || originOf[n];
  else g = '(unattributed)';
  (groups[g] = groups[g] || []).push(n);
}

const rows = Object.entries(groups).sort((a, b) => b[1].length - a[1].length);

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ total: names.length, groups }, null, 2));
  process.exit(0);
}

console.log('\nCF INVENTORY');
console.log('='.repeat(76));
console.log('  total exports (runtime enumeration) : ' + names.length);
console.log('  distinct source groups              : ' + rows.length);
console.log('');
console.log('  ' + 'GROUP'.padEnd(42) + 'EXPORTS   CUMULATIVE');
console.log('  ' + '-'.repeat(66));
let cum = 0;
for (const [g, list] of rows) {
  cum += list.length;
  console.log('  ' + g.padEnd(42) + String(list.length).padStart(5) + '    ' + String(cum).padStart(6));
}

const BUDGET = 1480;
console.log('');
console.log('  budget ' + BUDGET + ' — must remove ' + Math.max(0, names.length - BUDGET) + ' exports');

/* How far the top groups alone would take the programme. */
let need = names.length - BUDGET, taken = 0, k = 0;
for (const [, list] of rows) { if (taken >= need) break; taken += list.length; k++; }
console.log('  the ' + k + ' largest groups together hold ' + taken + ' exports');
console.log('='.repeat(76) + '\n');
