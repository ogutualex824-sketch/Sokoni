#!/usr/bin/env node
/* Map deployed-but-unexported functions back to their source module and emit the
   index.js re-export block, so `firebase deploy` UPDATES them instead of DELETING them. */
'use strict';
const fs = require('fs');
const path = require('path');
const orphanFile = process.argv[2];
if (!orphanFile) { console.error('usage: recover-orphans.js <orphan-list>'); process.exit(1); }

const orphans = fs.readFileSync(orphanFile, 'utf8').split('\n').map(s => s.trim()).filter(Boolean);
const dir = path.join(__dirname, '..', 'functions');
const files = fs.readdirSync(dir).filter(f => f.endsWith('.js'));
const src = {};
for (const f of files) src[f] = fs.readFileSync(path.join(dir, f), 'utf8');

/* Pre-split each module into trimmed lines, then match `exports.<name> =` at the
   start of a line. Plain string matching — regex escaping is a footgun here. */
const linesOf = {};
for (const f of files) linesOf[f] = src[f].split('\n').map((l) => l.trim());

const byMod = {};
const noSource = [];
for (const fn of orphans) {
  const a = 'exports.' + fn + ' ';
  const b = 'exports.' + fn + '=';
  const hit = files.find((f) => linesOf[f].some((l) => l.startsWith(a) || l.startsWith(b)));
  if (hit) (byMod[hit.replace(/\.js$/, '')] ||= []).push(fn);
  else noSource.push(fn);
}

const alias = (m) => '_rc' + m.split(/[-_]/).map(s => s[0].toUpperCase() + s.slice(1)).join('');
let out = '\n/* ══════════════════════════════════════════════════════════════════════\n' +
  '   RC1 REPRODUCIBILITY FIX — recovered orphaned Cloud Functions.\n' +
  '   These were DEPLOYED and live but NOT exported here, so a full\n' +
  '   `firebase deploy --only functions` would have DELETED them — including\n' +
  '   every transactional email trigger. Re-exported so source == deployed\n' +
  '   state and deploys UPDATE them instead of destroying them.\n' +
  '   ══════════════════════════════════════════════════════════════════════ */\n';
let total = 0;
for (const mod of Object.keys(byMod).sort()) {
  out += `const ${alias(mod)} = require('./${mod}');\n`;
  for (const fn of byMod[mod].sort()) { out += `exports.${fn} = ${alias(mod)}.${fn};\n`; total++; }
  out += '\n';
}
fs.writeFileSync(path.join(__dirname, '..', '.recover-block.js'), out);
console.log('recoverable:', total, 'across', Object.keys(byMod).length, 'modules');
for (const m of Object.keys(byMod).sort()) console.log('  ' + m + ': ' + byMod[m].length);
console.log('NO SOURCE (unrecoverable):', noSource.length);
