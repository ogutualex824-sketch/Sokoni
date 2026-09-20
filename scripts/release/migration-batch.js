/* ============================================================================
   RELEASE — batch surface-migration triage
   scripts/release/migration-batch.js
   ============================================================================
   Same question as migration-check.js, asked about many files at once:

       for each LIVE-AHEAD file, does the content the candidate's copy lacks
       exist SOMEWHERE ELSE on the candidate?

   The single-file tool re-reads the candidate's entire tree per invocation,
   which is ~30s each and unusable for a batch. This loads that corpus ONCE and
   reuses it, so ten files cost roughly what one did.

   Verdicts and caveats are identical to migration-check.js: a name match is a
   ROUTING verdict — "go read the new home" — never proof of equivalent
   behaviour, and a renamed identifier reads as ABSENT.

   CANONICAL SURFACE
   -----------------
   `merchant-v2.html` is the canonical merchant surface; `merchant.html` is
   legacy. When an identifier lands in both, the v2 hit is the meaningful one
   and is reported first, so a migration is not mistaken for a hit on a
   deprecated page.

   READ-ONLY.

   RUN
     node scripts/release/migration-batch.js <liveRef> <candRef> <file> [file...]
   ========================================================================== */
'use strict';

const { execFileSync } = require('child_process');
const path = require('path');

const LIVE = process.argv[2];
const CAND = process.argv[3];
const FILES = process.argv.slice(4);
if (!LIVE || !CAND || !FILES.length) {
  console.error('usage: migration-batch.js <liveRef> <candRef> <file> [file...]');
  process.exit(2);
}

const REPO = path.resolve(__dirname, '..', '..');
const git = (a) => { try { return execFileSync('git', a, { cwd: REPO, encoding: 'utf8', maxBuffer: 128e6 }); } catch (e) { return ''; } };

/* ── candidate corpus, once ──────────────────────────────────────────── */
process.stderr.write('loading candidate corpus once...\n');
const candFiles = git(['ls-tree', '-r', CAND, '--name-only']).split('\n')
  .filter((p) => /\.(html|js|css|mjs)$/i.test(p) && !/^docs\//i.test(p) && !/^scripts\//i.test(p));
const corpus = new Map();
for (const f of candFiles) corpus.set(f, git(['show', `${CAND}:${f}`]));

const CANONICAL = /^merchant-v2\.html$/i;
const LEGACY    = /^merchant\.html$/i;

const PATTERNS = [
  /\bid=["']([a-zA-Z][\w-]{3,})["']/g,
  /\bfunction\s+([a-zA-Z_$][\w$]{3,})/g,
  /\bsrc=["']([\w.-]+\.js)["']/g,
  /\b(?:const|let|var)\s+([a-zA-Z_$][\w$]{4,})\s*=/g,
  /\bclass=["']([a-z]{2,}-[\w-]{3,})["']/g,
];

function blobHistory(ref, file) {
  const o = [];
  git(['log', ref, '--format=%H', '--', file]).split('\n').filter(Boolean).forEach((c) => {
    const m = /^\d+ blob ([0-9a-f]+)\t/.exec(git(['ls-tree', c, '--', file]).trim());
    if (m) o.push(m[1]);
  });
  return o;
}

const results = [];
for (const FILE of FILES) {
  const candBlobs = new Set(blobHistory(CAND, FILE));
  const fork = blobHistory(LIVE, FILE).find((b) => candBlobs.has(b));
  if (!fork) { results.push({ FILE, verdict: 'NO-SHARED-BLOB', novel: 0, mig: 0, abs: 0, homes: [] }); continue; }

  const liveBlob = git(['rev-parse', `${LIVE}:${FILE}`]).trim();
  const ownCopy  = corpus.get(FILE) || git(['show', `${CAND}:${FILE}`]);

  const added = git(['diff', fork, liveBlob]).split('\n')
    .filter((l) => l.startsWith('+') && !l.startsWith('+++')).map((l) => l.slice(1));

  const ids = new Set();
  for (const line of added) {
    for (const re of PATTERNS) { re.lastIndex = 0; let m; while ((m = re.exec(line)) !== null) ids.add(m[1]); }
  }
  const novel = [...ids].filter((id) => ownCopy.indexOf(id) === -1);

  const homeCount = new Map();
  let migrated = 0;
  for (const id of novel) {
    const re = new RegExp('\\b' + id.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&') + '\\b');
    let found = false;
    for (const [f, body] of corpus) {
      if (f === FILE) continue;
      if (re.test(body)) { found = true; homeCount.set(f, (homeCount.get(f) || 0) + 1); }
    }
    if (found) migrated++;
  }
  const abs = novel.length - migrated;

  const homes = [...homeCount.entries()].sort((a, b) => {
    if (CANONICAL.test(a[0]) !== CANONICAL.test(b[0])) return CANONICAL.test(a[0]) ? -1 : 1;
    if (LEGACY.test(a[0]) !== LEGACY.test(b[0])) return LEGACY.test(a[0]) ? 1 : -1;
    return b[1] - a[1];
  }).slice(0, 3);

  const verdict = novel.length === 0 ? 'NO-NEW-SURFACE'
    : migrated === 0 ? 'LIKELY-REAL-GAP'
    : abs === 0 ? 'SURFACE-MIGRATION'
    : 'MIXED';

  results.push({ FILE, verdict, novel: novel.length, mig: migrated, abs, homes });
}

console.log('\n' + '='.repeat(82));
console.log('  SURFACE-MIGRATION TRIAGE   live=' + LIVE + '  candidate=' + CAND);
console.log('='.repeat(82));
console.log('  ' + 'file'.padEnd(26) + 'verdict'.padEnd(19) + 'novel  migr  abs   top candidate home');
console.log('  ' + '-'.repeat(78));
for (const r of results) {
  console.log('  ' + r.FILE.padEnd(26) + r.verdict.padEnd(19) +
    String(r.novel).padEnd(7) + String(r.mig).padEnd(6) + String(r.abs).padEnd(6) +
    (r.homes[0] ? r.homes[0][0] : '—'));
}
console.log('\n  NO-NEW-SURFACE   live added no new named surface — likely refactor/comments');
console.log('  SURFACE-MIGRATION every novel name lives elsewhere on the candidate');
console.log('  MIXED            part migrated, part absent — read both');
console.log('  LIKELY-REAL-GAP  nothing migrated — read the diff');
console.log('='.repeat(82) + '\n');
