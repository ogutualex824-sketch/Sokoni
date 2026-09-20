/* ============================================================================
   RELEASE GATE — Adjudicate DIVERGENT-BOTH files between two lineages
   scripts/release/divergence-adjudicate.js
   ============================================================================
   For a file present on both refs with DIFFERENT content, answers the only
   question that can be settled mechanically:

       since this file last AGREED, which side moved?

   WHY NOT "WHICH IS NEWER"
   ------------------------
   A later commit date does not mean a later meaning. Two lineages edited in
   parallel both have recent dates; a cherry-pick carries an old date onto new
   content; a rebase rewrites dates wholesale. And "it is on the production
   branch" says where a blob lives, not whether it is the intended one.

   So this gate never ranks by timestamp. It finds the most recent blob the file
   held on BOTH lineages — the file's own fork point — and reports which side
   has since departed from it. That is a fact about content, provable from the
   object graph, and it is reported per side rather than collapsed into a winner.

   CLASSES
     LIVE-AHEAD        candidate still holds the shared blob; live moved on
                       -> the candidate is missing live's later work
     CANDIDATE-AHEAD   live still holds the shared blob; the candidate moved on
                       -> this deploy would carry the candidate's later work
     BOTH-MOVED        both departed from the shared blob
                       -> a true three-way merge; NOBODY may pick by date
     NO-SHARED-BLOB    the file never held the same content on both lineages
                       -> UNPROVEN by this method; needs a human content review

   WHAT IT DELIBERATELY DOES NOT DECIDE
   -------------------------------------
   Nothing here classifies BEHAVIOUR. "LIVE-AHEAD" does not mean live is correct,
   and it never means "safe to overwrite". Two files can differ only in a comment
   and be behaviourally identical; two files can differ by one operator and
   invert a money rule. Behaviour needs a read of the diff by someone who can
   judge intent. This gate narrows that reading list and orders it by size.

   READ-ONLY.

   RUN
     node scripts/release/divergence-adjudicate.js <liveRef> <candRef> [filter]
   ========================================================================== */
'use strict';

const { execFileSync } = require('child_process');
const path = require('path');

const LIVE = process.argv[2] || 'd592d8f';
const CAND = process.argv[3] || 'HEAD';
const FILTER = process.argv[4] ? new RegExp(process.argv[4], 'i') : null;

const REPO = path.resolve(__dirname, '..', '..');
function git(args) {
  try {
    return execFileSync('git', args, { cwd: REPO, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 });
  } catch (e) { return ''; }
}

function treeMap(ref) {
  const m = new Map();
  git(['ls-tree', '-r', ref]).split('\n').forEach((l) => {
    const x = /^\d+ blob ([0-9a-f]+)\t(.+)$/.exec(l.trim());
    if (x) m.set(x[2], x[1]);
  });
  return m;
}

const liveTree = treeMap(LIVE);
const candTree = treeMap(CAND);

const isServed = (p) => /^[^/]+\.(js|css|html)$/i.test(p);

const divergent = [...liveTree.keys()].filter((p) =>
  isServed(p) && candTree.has(p) && liveTree.get(p) !== candTree.get(p) &&
  (!FILTER || FILTER.test(p)));

/* Every blob this path has held along one ref's history, newest first. */
function blobHistory(ref, file) {
  const out = [];
  const log = git(['log', '--format=%H', '--follow', '--', file].slice(0, 3)
    .concat(['--', file]).filter(Boolean));
  const commits = git(['log', ref, '--format=%H', '--', file]).split('\n').filter(Boolean);
  for (const c of commits) {
    const line = git(['ls-tree', c, '--', file]).trim();
    const m = /^\d+ blob ([0-9a-f]+)\t/.exec(line);
    if (m) out.push({ commit: c, blob: m[1] });
  }
  return out;
}

console.log('\n' + '='.repeat(76));
console.log('  DIVERGENCE ADJUDICATION    live=' + LIVE + '  candidate=' + CAND +
            (FILTER ? '  filter=/' + FILTER.source + '/i' : ''));
console.log('='.repeat(76));
console.log('  divergent served files: ' + divergent.length + '\n');

const rows = [];
for (const file of divergent.sort()) {
  const lh = blobHistory(LIVE, file);
  const ch = blobHistory(CAND, file);
  const liveBlob = liveTree.get(file), candBlob = candTree.get(file);

  const candBlobs = new Set(ch.map((x) => x.blob));
  /* The most recent blob on LIVE's history that the candidate has also held. */
  const shared = lh.find((x) => candBlobs.has(x.blob));

  let cls, detail;
  if (!shared) {
    cls = 'NO-SHARED-BLOB';
    detail = 'never identical on the two lineages';
  } else if (shared.blob === candBlob && shared.blob !== liveBlob) {
    const since = lh.findIndex((x) => x.blob === shared.blob);
    cls = 'LIVE-AHEAD';
    detail = 'candidate holds the shared blob; live moved on in ' + since + ' commit(s)';
  } else if (shared.blob === liveBlob && shared.blob !== candBlob) {
    const since = ch.findIndex((x) => x.blob === shared.blob);
    cls = 'CANDIDATE-AHEAD';
    detail = 'live holds the shared blob; candidate moved on in ' + since + ' commit(s)';
  } else {
    const ls = lh.findIndex((x) => x.blob === shared.blob);
    const cs = ch.findIndex((x) => x.blob === shared.blob);
    cls = 'BOTH-MOVED';
    detail = 'both departed the shared blob (live +' + ls + ', candidate +' + cs + ')';
  }

  /* Diff magnitude, candidate -> live. Size is a reading-order hint, never a
     verdict: a one-line change can invert a money rule. */
  const stat = git(['diff', '--numstat', candBlob, liveBlob]).trim().split('\t');
  const add = stat[0] || '?', del = stat[1] || '?';

  rows.push({ file, cls, detail, add, del });
}

const ORDER = ['BOTH-MOVED', 'LIVE-AHEAD', 'CANDIDATE-AHEAD', 'NO-SHARED-BLOB'];
const counts = {};
rows.forEach((r) => { counts[r.cls] = (counts[r.cls] || 0) + 1; });
ORDER.forEach((c) => { if (counts[c]) console.log('  ' + c.padEnd(18) + counts[c]); });

ORDER.forEach((cls) => {
  const set = rows.filter((r) => r.cls === cls);
  if (!set.length) return;
  console.log('\n  ' + cls);
  if (cls === 'BOTH-MOVED')      console.log('    three-way. Picking either side by date DISCARDS the other’s work.');
  if (cls === 'LIVE-AHEAD')      console.log('    the candidate is missing work live already carries.');
  if (cls === 'CANDIDATE-AHEAD') console.log('    this deploy would carry the candidate’s later work.');
  if (cls === 'NO-SHARED-BLOB')  console.log('    UNPROVEN by content history — needs a human diff read.');
  set.sort((a, b) => (Number(b.add) + Number(b.del)) - (Number(a.add) + Number(a.del)))
     .forEach((r) => {
       console.log('   • ' + r.file.padEnd(34) + ' +' + r.add + '/-' + r.del);
       console.log('       ' + r.detail);
     });
});

console.log('\n' + '='.repeat(76));
console.log('  Behaviour is NOT classified here. A class says which side moved,');
console.log('  never which side is correct, and never that overwriting is safe.');
console.log('='.repeat(76) + '\n');
