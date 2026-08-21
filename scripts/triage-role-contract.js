/* TRIAGE HELPER — pull the role-shaped LINES out of the flagged pages.
   ==========================================================================
   Run:  node scripts/triage-role-contract.js mirror
         node scripts/triage-role-contract.js unguarded
         node scripts/triage-role-contract.js driver

   READ-ONLY. Reads docs/role-contract-matrix.json (base faa149e) and prints the
   evidence a human has to judge, so the triage reads 53 EXPRESSIONS rather than 53
   whole files.

   It classifies nothing. The whole point of Phase 2 is that "reads a mirror" and
   "decides authorization from a mirror" are different claims, and only a person
   looking at the branch can tell them apart. This tool just finds the branch.
   ==========================================================================*/
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MODE = (process.argv[2] || 'mirror').toLowerCase();
const matrix = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs', 'role-contract-matrix.json'), 'utf8'));

const strip = (s) => s
  .replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '))
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  .replace(/^[ \t]*\/\/.*$/gm, (m) => ' '.repeat(m.length));

/* The same expressions the census matched, so the evidence and the verdict agree. */
const MIRROR_RE = [
  /\b(?:u|user|data|d|profile|snap|userData)\s*\.\s*role\s*(?:===?|!==?|\?|\|\||&&)/,
  /\b(?:u|user|data|d|profile|snap|userData)\s*\.\s*roles\s*\.\s*(?:includes|indexOf)\s*\(/,
  /getItem\s*\(\s*["'`](?:userRole|role|sokoniRole)["'`]\s*\)/,
  /registeredAs\s*(?:\.\s*\w+\s*(?:===?|&&|\|\||\?)|\[)/,
  /\bdetail\s*\.\s*role\s*(?:===?|!==?|\?|\|\||&&)/,
  /\btoken\s*\.\s*role\s*(?:===?|!==?)/,
  /\b(?:isSeller|isProvider|isDriver|isRider)\s*(?:===?\s*true|&&|\?)/,
];

/* A CAPABILITY is an operation, not a label. This is the R6 question: does the page
   do something that needs authority, or merely say something? */
const CAPABILITY_RE = [
  { name: 'firestore write', re: /\b(?:setDoc|updateDoc|addDoc|deleteDoc|writeBatch|runTransaction)\s*\(/ },
  { name: 'compat write',    re: /\.(?:set|update|add|delete)\s*\(\s*\{/ },
  { name: 'callable',        re: /httpsCallable\s*\(/ },
  { name: 'storage write',   re: /uploadBytes|putString|\.put\s*\(/ },
];

const ROLE_WORD = /["'`](?:buyer|seller|rider|driver|provider|admin|superAdmin|moderator)["'`]/;

function evidence(route, res) {
  const p = path.join(ROOT, route);
  let raw = ''; try { raw = fs.readFileSync(p, 'utf8'); } catch (_) { return null; }
  const lines = strip(raw).split(/\r?\n/);
  const hits = [];
  lines.forEach((l, i) => {
    if (res.some((re) => re.test(l))) hits.push({ n: i + 1, text: l.trim().slice(0, 132) });
  });
  const caps = [];
  for (const c of CAPABILITY_RE) {
    const n = lines.filter((l) => c.re.test(l)).length;
    if (n) caps.push(c.name + ' x' + n);
  }
  /* Does a role word appear NEAR a capability? That is the shape worth reading. */
  let colocated = 0;
  lines.forEach((l, i) => {
    if (!CAPABILITY_RE.some((c) => c.re.test(l))) return;
    const win = lines.slice(Math.max(0, i - 6), i + 3).join(' ');
    if (ROLE_WORD.test(win)) colocated++;
  });
  return { hits, caps, colocated, bytes: raw.length };
}

let rows;
if (MODE === 'mirror') {
  rows = matrix.rows.filter((r) => r.verdict === 'MIRROR-AUTHORITY' || r.verdict === 'DUPLICATE-AUTH');
} else if (MODE === 'unguarded') {
  rows = matrix.rows.filter((r) => r.verdict === 'UNGUARDED');
} else if (MODE === 'driver') {
  rows = matrix.rows.filter((r) => r.legacyDriverVocab);
} else {
  console.error('modes: mirror | unguarded | driver'); process.exit(2);
}

console.log('\n  TRIAGE EVIDENCE — ' + MODE.toUpperCase() + '  (' + rows.length + ' rows, base faa149e)\n');
for (const r of rows) {
  const e = evidence(r.route, MODE === 'unguarded' ? [ROLE_WORD] : MIRROR_RE);
  if (!e) { console.log('  ' + r.route + '   (unreadable)'); continue; }
  console.log('  ── ' + r.route + '   [' + r.verdict + ']  ' + Math.round(e.bytes / 1024) + 'KB');
  if (e.caps.length) console.log('     capabilities: ' + e.caps.join(', ')
    + (e.colocated ? '   role-word NEAR a capability x' + e.colocated : '   (no role word near any capability)'));
  else console.log('     capabilities: none — this page performs no write or callable');
  for (const h of e.hits.slice(0, MODE === 'unguarded' ? 3 : 8)) {
    console.log('     ' + String(h.n).padStart(5) + '  ' + h.text);
  }
  if (e.hits.length > (MODE === 'unguarded' ? 3 : 8)) {
    console.log('     … ' + (e.hits.length - (MODE === 'unguarded' ? 3 : 8)) + ' more');
  }
  console.log('');
}
console.log('  Evidence only. Nothing here is a verdict — see docs/role-contract-triage.md.\n');
