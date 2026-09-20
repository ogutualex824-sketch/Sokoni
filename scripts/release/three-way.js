/* ============================================================================
   RELEASE — three-way view of one divergent file
   scripts/release/three-way.js
   ============================================================================
   Prints the file's proven fork blob and BOTH departures from it:

       fork -> live        what live did after the split
       fork -> candidate   what the candidate did after the split

   A two-way `live vs candidate` diff cannot be adjudicated: it shows the two
   sides disagreeing without showing who introduced which line, so every hunk
   looks like a conflict and the reader is pushed toward picking a winner. From
   the fork, most hunks resolve to "only one side touched this", which is
   additive and safe, and the genuine conflicts shrink to the few lines both
   sides changed.

   READ-ONLY.

   RUN
     node scripts/release/three-way.js <file> [liveRef] [candRef] [--stat|--live|--cand]
   ========================================================================== */
'use strict';

const { execFileSync } = require('child_process');
const path = require('path');

const FILE = process.argv[2];
const LIVE = process.argv[3] || 'd592d8f';
const CAND = process.argv[4] || 'HEAD';
const MODE = process.argv[5] || '--stat';

if (!FILE) { console.error('usage: three-way.js <file> [liveRef] [candRef] [--stat|--live|--cand]'); process.exit(2); }

const REPO = path.resolve(__dirname, '..', '..');
const git = (a) => { try { return execFileSync('git', a, { cwd: REPO, encoding: 'utf8', maxBuffer: 128e6 }); } catch (e) { return ''; } };

function history(ref) {
  const out = [];
  git(['log', ref, '--format=%H', '--', FILE]).split('\n').filter(Boolean).forEach((c) => {
    const m = /^\d+ blob ([0-9a-f]+)\t/.exec(git(['ls-tree', c, '--', FILE]).trim());
    if (m) out.push({ commit: c, blob: m[1] });
  });
  return out;
}

const lh = history(LIVE), ch = history(CAND);
const candBlobs = new Set(ch.map((x) => x.blob));
const fork = lh.find((x) => candBlobs.has(x.blob));

if (!fork) { console.error('NO SHARED BLOB for ' + FILE + ' — cannot build a three-way view.'); process.exit(1); }

const liveBlob = git(['rev-parse', `${LIVE}:${FILE}`]).trim();
const candBlob = git(['rev-parse', `${CAND}:${FILE}`]).trim();

console.log('\n' + '='.repeat(74));
console.log('  THREE-WAY  ' + FILE);
console.log('='.repeat(74));
console.log('  fork blob      ' + fork.blob.slice(0, 10) + '   (last commit holding it on live: ' + fork.commit.slice(0, 10) + ')');
console.log('  live blob      ' + liveBlob.slice(0, 10));
console.log('  candidate blob ' + candBlob.slice(0, 10));

const s1 = git(['diff', '--numstat', fork.blob, liveBlob]).trim().split('\t');
const s2 = git(['diff', '--numstat', fork.blob, candBlob]).trim().split('\t');
console.log('  fork -> live        +' + (s1[0] || 0) + ' / -' + (s1[1] || 0));
console.log('  fork -> candidate   +' + (s2[0] || 0) + ' / -' + (s2[1] || 0));
console.log('='.repeat(74));

if (MODE === '--live') { console.log('\n--- fork -> LIVE ---\n'); console.log(git(['diff', '-U2', fork.blob, liveBlob])); }
if (MODE === '--cand') { console.log('\n--- fork -> CANDIDATE ---\n'); console.log(git(['diff', '-U2', fork.blob, candBlob])); }
