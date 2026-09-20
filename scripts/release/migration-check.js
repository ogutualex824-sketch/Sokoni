/* ============================================================================
   RELEASE GATE — surface-migration check for LIVE-AHEAD files
   scripts/release/migration-check.js
   ============================================================================
   Asks the question a per-file gate structurally cannot:

       live's copy of this file has content the candidate's copy lacks.
       Does that capability exist SOMEWHERE ELSE on the candidate?

   WHY THIS EXISTS
   ---------------
   `pos-printer-setup.html` classified LIVE-AHEAD, which reads as "the candidate
   is missing live's later work". It was not. The candidate had deliberately
   CONSOLIDATED payment-destination configuration out of that page and into
   `pos-setup.html`, under a stricter authority rule. Restoring live's file would
   have re-split an architecture the candidate intentionally unified.

   No per-file comparison can see that, because the evidence lives in a
   DIFFERENT file. A capability that moved looks identical to a capability that
   was lost.

   METHOD
   ------
   Take the distinctive identifiers live added that the candidate's copy of the
   SAME file lacks — element ids, function names, class names, script sources.
   Then look for each across the candidate's ENTIRE tree.

     found elsewhere on the candidate  -> MIGRATED (capability present, new home)
     found nowhere on the candidate    -> ABSENT   (a real gap, read the diff)

   WHAT IT CANNOT SETTLE
   ---------------------
   A matching identifier proves the NAME exists on the candidate, not that it
   behaves the same. MIGRATED means "stop treating this as a missing capability
   and go read the new home" — it is a routing verdict, never an equivalence
   proof. Identifiers are also matched as whole words; a renamed identifier will
   read as ABSENT, so ABSENT is a prompt to look, not a conclusion.

   READ-ONLY.

   RUN
     node scripts/release/migration-check.js <file> [liveRef] [candRef]
   ========================================================================== */
'use strict';

const { execFileSync } = require('child_process');
const path = require('path');

const FILE = process.argv[2];
const LIVE = process.argv[3] || 'd592d8f';
const CAND = process.argv[4] || 'HEAD';
if (!FILE) { console.error('usage: migration-check.js <file> [liveRef] [candRef]'); process.exit(2); }

const REPO = path.resolve(__dirname, '..', '..');
const git = (a) => { try { return execFileSync('git', a, { cwd: REPO, encoding: 'utf8', maxBuffer: 128e6 }); } catch (e) { return ''; } };

function hist(ref) {
  const o = [];
  git(['log', ref, '--format=%H', '--', FILE]).split('\n').filter(Boolean).forEach((c) => {
    const m = /^\d+ blob ([0-9a-f]+)\t/.exec(git(['ls-tree', c, '--', FILE]).trim());
    if (m) o.push(m[1]);
  });
  return o;
}

const candBlobs = new Set(hist(CAND));
const fork = hist(LIVE).find((b) => candBlobs.has(b));
if (!fork) { console.error('no shared blob for ' + FILE); process.exit(1); }

const liveBlob = git(['rev-parse', `${LIVE}:${FILE}`]).trim();
const candBody = git(['cat-file', '-p', git(['rev-parse', `${CAND}:${FILE}`]).trim()]);

/* Live's post-fork additions. */
const added = git(['diff', fork, liveBlob]).split('\n')
  .filter((l) => l.startsWith('+') && !l.startsWith('+++'))
  .map((l) => l.slice(1));

/* Distinctive identifiers only. Generic words produce noise and would make
   every file look migrated; these patterns are anchored to declaration syntax. */
const PATTERNS = [
  /\bid=["']([a-zA-Z][\w-]{3,})["']/g,          /* element ids           */
  /\bfunction\s+([a-zA-Z_$][\w$]{3,})/g,        /* function declarations */
  /\bsrc=["']([\w.-]+\.js)["']/g,               /* script sources        */
  /\b(?:const|let|var)\s+([a-zA-Z_$][\w$]{4,})\s*=/g,
  /\bclass=["']([a-z]{2,}-[\w-]{3,})["']/g,     /* namespaced classes    */
];

const ids = new Set();
for (const line of added) {
  for (const re of PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(line)) !== null) ids.add(m[1]);
  }
}

/* Only identifiers the candidate's OWN copy of this file lacks are interesting. */
const novel = [...ids].filter((id) => candBody.indexOf(id) === -1);

/* Candidate tree, text files only, excluding the file itself and prose. */
const candFiles = git(['ls-tree', '-r', CAND, '--name-only']).split('\n')
  .filter((p) => /\.(html|js|css|mjs)$/i.test(p) && p !== FILE &&
                 !/^docs\//i.test(p) && !/^scripts\//i.test(p));

const bodies = new Map();
for (const f of candFiles) bodies.set(f, git(['show', `${CAND}:${f}`]));

const migrated = [], absent = [];
for (const id of novel.sort()) {
  const homes = [];
  for (const [f, body] of bodies) {
    if (new RegExp('\\b' + id.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&') + '\\b').test(body)) homes.push(f);
  }
  (homes.length ? migrated : absent).push({ id, homes });
}

console.log('\n' + '='.repeat(74));
console.log('  SURFACE-MIGRATION CHECK   ' + FILE);
console.log('='.repeat(74));
console.log('  live-added identifiers absent from the candidate’s copy : ' + novel.length);
console.log('  found ELSEWHERE on the candidate (migrated)             : ' + migrated.length);
console.log('  found nowhere on the candidate (absent)                 : ' + absent.length);

if (migrated.length) {
  console.log('\n  MIGRATED — capability has another home on the candidate');
  const byHome = new Map();
  migrated.forEach((m) => m.homes.forEach((h) => {
    if (!byHome.has(h)) byHome.set(h, []);
    byHome.get(h).push(m.id);
  }));
  [...byHome.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 6)
    .forEach(([h, list]) => console.log('   • ' + h + '  ← ' + list.slice(0, 5).join(', ') +
      (list.length > 5 ? ' (+' + (list.length - 5) + ')' : '')));
}
if (absent.length) {
  console.log('\n  ABSENT — no candidate file carries these names');
  console.log('   ' + absent.slice(0, 14).map((a) => a.id).join(', ') +
    (absent.length > 14 ? ' (+' + (absent.length - 14) + ')' : ''));
}

const verdict = novel.length === 0 ? 'NO NOVEL IDENTIFIERS — live added no new named surface'
  : migrated.length === 0 ? 'LIKELY REAL GAP — nothing migrated'
  : absent.length === 0 ? 'SURFACE-MIGRATION — every novel identifier lives elsewhere'
  : 'MIXED — part migrated, part absent; read both';
console.log('\n  ' + verdict);
console.log('  A name match is a routing verdict, never proof of equivalent behaviour.');
console.log('='.repeat(74) + '\n');
