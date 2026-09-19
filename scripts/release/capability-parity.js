/* ============================================================================
   RELEASE GATE — Capability / content parity between two lineages
   scripts/release/capability-parity.js
   ============================================================================
   Answers, for every SERVED asset that differs between two refs:

     is it present on each side · who references it on each side ·
     is the content identical · what does that combination mean

   WHY THIS IS A SEPARATE GATE FROM ARTIFACT COMPLETENESS
   -------------------------------------------------------
   Artifact completeness asks "does every reference resolve inside this commit".
   It can only see references that EXIST. When two lineages diverge, the deeper
   risk is capability the candidate never knew about: live serves a file, no
   candidate page mentions it, so nothing dangles and nothing fails — and
   deploying the candidate silently REMOVES a capability from production.

   That is invisible to a reference check by construction, so it needs its own
   gate and its own evidence.

   CLASSIFICATION IS FROM EVIDENCE, NEVER FROM THE FILENAME
   ---------------------------------------------------------
   A file called `sokoni-sale-submit.js` is not "money-critical" because of its
   name. It is whatever its consumers make it. Every row below is decided by
   presence + consumer references + content hash, and anything the evidence does
   not settle is reported as UNPROVEN rather than guessed.

   CLASSES
     IDENTICAL              present both sides, same blob
     DIVERGENT-BOTH         present both sides, different blob
     LIVE-ONLY-REQUIRED     live only, and a CANDIDATE page references it
                            -> deploying the candidate 404s that reference
     LIVE-ONLY-WIRED        live only, referenced on live, not on candidate
                            -> deploying REMOVES a capability live serves today
     LIVE-ONLY-UNREFERENCED live only, referenced by nothing on either side
                            -> dead on live too; removal is probably harmless
     CAND-ONLY-WIRED        candidate only, referenced on candidate
                            -> new capability this deploy would ADD
     CAND-ONLY-UNREFERENCED candidate only, referenced by nothing
     UNPROVEN               evidence did not settle it

   A CONSUMER is a served file (html/js/css outside docs/ and scripts/) that would
   actually fetch the asset. A MENTION is prose that merely names it. See the
   isDocLike note below — the two must not be collapsed.

   READ-ONLY. Inspects git objects and mutates nothing.

   RUN
     node scripts/release/capability-parity.js <liveRef> <candidateRef> [filter]
     node scripts/release/capability-parity.js d592d8f HEAD "pos|till"
   ========================================================================== */
'use strict';

const { execFileSync } = require('child_process');
const path = require('path');

const LIVE = process.argv[2] || 'd592d8f';
const CAND = process.argv[3] || 'HEAD';
const FILTER = process.argv[4] ? new RegExp(process.argv[4], 'i') : null;

const REPO = path.resolve(__dirname, '..', '..');
function git(args, opts) {
  return execFileSync('git', args, Object.assign({
    cwd: REPO, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024,
  }, opts || {}));
}

/* path -> blob sha, for one ref. */
function treeMap(ref) {
  const out = new Map();
  git(['ls-tree', '-r', ref]).split('\n').forEach((line) => {
    const m = /^\d+ blob ([0-9a-f]+)\t(.+)$/.exec(line.trim());
    if (m) out.set(m[2], m[1]);
  });
  return out;
}

const liveTree = treeMap(LIVE);
const candTree = treeMap(CAND);

/* Only SERVED assets. Hosting publishes the repo root; tests, docs and
   functions are not fetched by a browser, so they cannot be a served-capability
   regression and would drown the signal. */
const isServed = (p) => /^[^/]+\.(js|css|html)$/i.test(p) && !/^(firebase|firestore)\./i.test(p);

const universe = new Set([...liveTree.keys(), ...candTree.keys()].filter(isServed));

/* ── Consumer index ──────────────────────────────────────────────────
   Built once per side: basename -> referencing files. Reading every tracked
   text blob twice is the expensive part, so it happens once and is reused. */
/* A CONSUMER is a file the browser executes that would actually fetch the
   asset. A MENTION is prose — a changelog, an ADR, a test that only names the
   file. Collapsing the two makes every documented filename look load-bearing:
   `sokoni-role-authority.js` appeared "required by the candidate" purely
   because three candidate .md files discuss it. Prose is not a fetch. */
const isDocLike = (p) => /^docs\//i.test(p) || /\.(md|json)$/i.test(p) ||
                         /^scripts\//i.test(p) || /CHANGELOG|ROADMAP|README/i.test(p);

function consumerIndex(ref, tree) {
  const consumers = new Map();   /* served files that would fetch it */
  const mentions  = new Map();   /* prose / tests that merely name it */
  const textFiles = [...tree.keys()].filter((p) => /\.(html|js|css|json|md|mjs)$/i.test(p));
  const names = [...universe];

  for (const f of textFiles) {
    let body;
    try { body = git(['show', `${ref}:${f}`]); } catch (e) { continue; }
    const docLike = isDocLike(f);
    for (const asset of names) {
      const base = asset.split('/').pop();
      if (f === asset) continue;                    /* a file is not its own consumer */
      if (body.indexOf(base) === -1) continue;
      const bucket = docLike ? mentions : consumers;
      if (!bucket.has(asset)) bucket.set(asset, []);
      bucket.get(asset).push(f);
    }
  }
  return { consumers, mentions };
}

process.stderr.write('indexing consumers (two full tree reads)...\n');
const liveIdx = consumerIndex(LIVE, liveTree);
const candIdx = consumerIndex(CAND, candTree);

/* ── Classify ────────────────────────────────────────────────────────── */
const rows = [];
for (const asset of [...universe].sort()) {
  if (FILTER && !FILTER.test(asset)) continue;

  const onLive = liveTree.has(asset);
  const onCand = candTree.has(asset);
  const lc = liveIdx.consumers.get(asset) || [];
  const cc = candIdx.consumers.get(asset) || [];
  const lm = liveIdx.mentions.get(asset) || [];
  const cm = candIdx.mentions.get(asset) || [];

  let cls;
  if (onLive && onCand) {
    cls = liveTree.get(asset) === candTree.get(asset) ? 'IDENTICAL' : 'DIVERGENT-BOTH';
  } else if (onLive && !onCand) {
    if (cc.length)      cls = 'LIVE-ONLY-REQUIRED';
    else if (lc.length) cls = 'LIVE-ONLY-WIRED';
    else                cls = 'LIVE-ONLY-UNREFERENCED';
  } else if (!onLive && onCand) {
    cls = cc.length ? 'CAND-ONLY-WIRED' : 'CAND-ONLY-UNREFERENCED';
  } else {
    cls = 'UNPROVEN';
  }
  rows.push({ asset, cls, live: lc, cand: cc, liveM: lm, candM: cm });
}

/* ── Report ──────────────────────────────────────────────────────────── */
const ORDER = ['LIVE-ONLY-REQUIRED', 'LIVE-ONLY-WIRED', 'DIVERGENT-BOTH',
               'CAND-ONLY-WIRED', 'LIVE-ONLY-UNREFERENCED',
               'CAND-ONLY-UNREFERENCED', 'IDENTICAL', 'UNPROVEN'];

console.log('\n' + '='.repeat(74));
console.log('  CAPABILITY / CONTENT PARITY      live=' + LIVE + '   candidate=' + CAND +
            (FILTER ? '   filter=/' + FILTER.source + '/i' : ''));
console.log('='.repeat(74));

const counts = {};
rows.forEach((r) => { counts[r.cls] = (counts[r.cls] || 0) + 1; });
ORDER.forEach((c) => { if (counts[c]) console.log('  ' + c.padEnd(24) + counts[c]); });

/* Detail only for the classes that can change what production serves. */
const DETAIL = ['LIVE-ONLY-REQUIRED', 'LIVE-ONLY-WIRED', 'DIVERGENT-BOTH'];
DETAIL.forEach((cls) => {
  const set = rows.filter((r) => r.cls === cls);
  if (!set.length) return;
  console.log('\n  ' + cls);
  if (cls === 'LIVE-ONLY-REQUIRED') console.log('    a candidate page references it and the candidate does not have it');
  if (cls === 'LIVE-ONLY-WIRED')    console.log('    live serves and references it; deploying the candidate REMOVES it');
  if (cls === 'DIVERGENT-BOTH')     console.log('    present on both, different content — needs a content review');
  set.forEach((r) => {
    console.log('   • ' + r.asset);
    if (r.cand.length) console.log('       candidate consumers: ' + r.cand.slice(0, 4).join(', ') +
                                   (r.cand.length > 4 ? ' (+' + (r.cand.length - 4) + ')' : ''));
    if (r.live.length) console.log('       live consumers     : ' + r.live.slice(0, 4).join(', ') +
                                   (r.live.length > 4 ? ' (+' + (r.live.length - 4) + ')' : ''));
    if (!r.cand.length && !r.live.length) console.log('       no SERVED consumer on either side');
    if (r.liveM.length || r.candM.length) console.log('       prose mentions only: ' + (r.liveM.length + r.candM.length) + ' file(s) — not a fetch');
  });
});

const blocking = rows.filter((r) => r.cls === 'LIVE-ONLY-REQUIRED' || r.cls === 'LIVE-ONLY-WIRED').length;
console.log('\n' + '='.repeat(74));
console.log('  assets examined : ' + rows.length);
console.log('  capability-removing or dangling : ' + blocking);
console.log('='.repeat(74));
console.log(blocking === 0
  ? '  RESULT: NO CAPABILITY REMOVED BY THIS CANDIDATE\n'
  : '  RESULT: CANDIDATE WOULD REMOVE OR BREAK SERVED CAPABILITY — ADJUDICATE\n');
process.exit(blocking === 0 ? 0 : 1);
