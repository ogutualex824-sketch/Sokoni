#!/usr/bin/env node
/* Release gate — refuse to ship a functions tree whose local requires do not resolve
 * FROM A CLEAN CHECKOUT.
 *
 * WHY THIS EXISTS
 * `functions/index.js` has carried unconditional `require('./order-claim')` and
 * `require('./manual-till-orders')` since fa5082b, for modules committed nowhere in this
 * repository. A clean checkout of the branch cannot load index.js. That was known — the commit
 * message names all four hazard files and declares "NEVER deploy FULL index.js" — but the
 * mitigation was a sentence in a commit message, not a mechanism. Nothing enforced it.
 * `predeploy-syntax-gate.js` runs `node --check`, which parses a file and never resolves a
 * `require()`, so it cannot catch this class at all.
 *
 * THE MEASUREMENT ERROR THIS GATE EXISTS TO PREVENT
 * Scanning the FILESYSTEM says the graph is closed, because other workstreams' untracked files
 * are sitting on disk. A deploy uses a checkout, not somebody's disk. This gate reads the GIT
 * TREE — `git ls-tree` for the file set, `git show` for the sources — so a module that exists
 * only as an untracked working file is reported as MISSING, which is what it is.
 * **Presence on disk is not closure.**
 *
 * WHAT IT MEASURES, AND WHY THAT SHAPE
 * The BLOCKING check is the transitive require graph rooted at `functions/index.js` — exactly
 * what a functions deploy loads. A test or probe file under `functions/` with a broken require
 * is a real defect but does not stop a deploy, so it is reported separately and does not fail
 * the gate. Conflating the two would either cry wolf or hide the thing that actually breaks.
 *
 * EXHAUSTIVE AND SELF-EXPLANATORY
 * Four missing modules are not four instances of one defect. One needs attribution, two are
 * deliberately gated behind documented prerequisites, and one needs its foreign-port lineage
 * reconciled — four decisions with four owners. Collapsing them into the word "missing" loses
 * exactly the information the reader needs and invites the wrong remedy (deletion) for the
 * wrong reason. So the gate reads a governance ledger,
 * docs/DEPLOY_TREE_DISPOSITIONS.json, and reports each blocker as:
 *
 *     RESOLVED | GATED | UNRESOLVED | FOREIGN_PORT | UNDECLARED
 *     + owner (or an explicit UNKNOWN) + the path to resolution + what is forbidden
 *
 * UNDECLARED is the alarming state, not the friendly one: a dependency nobody has
 * dispositioned has drifted into the deploy graph unnoticed, and must never inherit a
 * reassuring label by default. A module declared RESOLVED but absent from the tree is
 * reported as a REGRESSION — a closed dependency was reverted or dropped.
 *
 * WHAT IT DOES NOT DO — AND MUST NEVER DO
 * It NEVER auto-removes, auto-copies, or auto-admits a module, and it never writes to the
 * repository at all. It does not judge whether a missing module SHOULD be committed: that is a
 * governance decision belonging to that module's owner. It only refuses to let the question go
 * unanswered silently.
 *
 * A ROW IN THE LEDGER DOES NOT MAKE ANYTHING DEPLOYABLE. Closure is decided by `git ls-tree`,
 * never by JSON or Markdown. A recorded disposition is a decision RECORDED, not a dependency
 * RESOLVED — only committed deploy-tree content, or an explicit tested removal of the
 * require/export, turns this gate green.
 *
 * USAGE
 *   node scripts/gate-functions-require-closure.js            # scan HEAD
 *   node scripts/gate-functions-require-closure.js --ref X    # scan another ref
 *   node scripts/gate-functions-require-closure.js --json     # machine-readable
 * Exit 0 = the deploy entrypoint graph closes. Exit 1 = it does not. Exit 2 = gate error.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const args = process.argv.slice(2);
const REF  = (() => { const i = args.indexOf('--ref'); return i >= 0 ? args[i + 1] : 'HEAD'; })();
const JSON_OUT = args.indexOf('--json') >= 0;
const ENTRY = 'functions/index.js';
const LEDGER = 'docs/DEPLOY_TREE_DISPOSITIONS.json';

/* EVERY git call and every disk check is anchored to the repository root, never to the
   caller's cwd. Firebase runs a functions predeploy hook with cwd = the functions directory,
   and `git ls-tree -r HEAD` from there lists paths relative to THAT directory — so
   `functions/index.js` was not found and the gate exited 2 on every deploy. It failed closed,
   which is the right direction, but for the wrong reason, and a gate that always errors is a
   gate that gets removed. */
const REPO = (() => {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch (_) {
    console.error('GATE ERROR: not inside a git repository — cannot verify the deploy tree.');
    process.exit(2);
  }
})();

function git (a, quiet) {
  return execFileSync('git', a, {
    cwd: REPO,
    encoding: 'utf8', maxBuffer: 256e6, stdio: ['ignore', 'pipe', quiet ? 'ignore' : 'inherit'],
  });
}

/* A require inside a comment is not a require. Strip before scanning — the lesson this
   repository has now paid for five times over in detector regexes. */
function stripComments (s) {
  return s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

/* Only STATIC, LOCAL requires. A computed path cannot be resolved statically and is reported
   separately rather than guessed at. */
const STATIC_RE = /require\(\s*(['"])(\.[^'"]*)\1\s*\)/g;

/* Resolve a relative specifier against the requiring file, over the WHOLE repo tree — a
   require may legitimately escape functions/ (a root-level module, a JSON file), and scoping
   the candidate set to functions/ would report those as missing when they are not. */
function normalise (fromFile, spec) {
  const parts = fromFile.split('/');
  parts.pop();
  for (const seg of spec.split('/')) {
    if (seg === '.' || seg === '') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return parts.join('/');
}

function main () {
  let all;
  try {
    all = git(['ls-tree', '-r', '--name-only', REF], true).trim();
  } catch (e) {
    console.error('GATE ERROR: cannot read tree at ' + REF);
    process.exit(2);
  }
  const inTree = new Set(all ? all.split('\n').filter(Boolean) : []);
  if (!inTree.has(ENTRY)) {
    console.error('GATE ERROR: ' + ENTRY + ' is not in the tree at ' + REF + ' — refusing to pass vacuously.');
    process.exit(2);
  }

  const resolveTo = (base) => {
    for (const cand of [base, base + '.js', base + '.json', base + '.cjs', base + '/index.js']) {
      if (inTree.has(cand)) return cand;
    }
    return null;
  };

  /* Blobs are read in ONE `git cat-file --batch` pass, not one `git show` per file. The
     per-file form spawned ~330 processes and took 30s, which is how a gate gets bypassed —
     "deliberately fast" is a correctness property for a predeploy hook, not a nicety. */
  const srcCache = new Map();
  (function preload () {
    let listing;
    try { listing = git(['ls-tree', '-r', REF], true); } catch (_) { return; }
    const wanted = [];
    for (const line of listing.split('\n')) {
      if (!line) continue;
      const tab = line.indexOf('\t');
      if (tab < 0) continue;
      const p = line.slice(tab + 1);
      /* Only the functions tree. Preloading every blob in the repository read 23MB to use a
         tenth of it. */
      if (!p.startsWith('functions/') || !/\.(js|cjs)$/.test(p)) continue;
      const oid = line.slice(0, tab).split(/\s+/)[2];
      if (oid) wanted.push([oid, p]);
    }
    if (!wanted.length) return;
    /* input MUST be a Buffer and encoding MUST be left unset. `encoding: 'buffer'` is not a
       valid encoding for the INPUT string, so execFileSync threw, the catch below swallowed
       it, and every file silently fell back to a `git show` spawn — 383 of them, turning a
       0.2s read into 17s. A swallowed error that only costs time is still a swallowed error. */
    let buf;
    try {
      buf = execFileSync('git', ['cat-file', '--batch'], {
        cwd: REPO,
        input: Buffer.from(wanted.map((w) => w[0]).join('\n') + '\n'),
        maxBuffer: 1024e6, stdio: ['pipe', 'pipe', 'ignore'],
      });
    } catch (e) {
      console.error('GATE WARNING: blob preload failed (' + String(e.message).split('\n')[0] +
                    '); falling back to per-file reads, this will be slow.');
      return;
    }
    /* Each record: "<oid> blob <size>\n" + <size bytes> + "\n" — sizes are BYTES, so walk the
       buffer, never a decoded string, or multi-byte characters shift every later offset. */
    let off = 0, i = 0;
    while (off < buf.length && i < wanted.length) {
      const nl = buf.indexOf(0x0a, off);
      if (nl < 0) break;
      const header = buf.slice(off, nl).toString('utf8').split(' ');
      const size = parseInt(header[2], 10);
      if (!isFinite(size)) break;
      const body = buf.slice(nl + 1, nl + 1 + size).toString('utf8');
      srcCache.set(wanted[i][1], stripComments(body));
      off = nl + 1 + size + 1;
      i++;
    }
  })();

  const readSrc = (p) => {
    if (!srcCache.has(p)) srcCache.set(p, stripComments(git(['show', REF + ':' + p], true)));
    return srcCache.get(p);
  };

  /* ── the blocking check: transitive closure from the deploy entrypoint ── */
  const missing = new Map();   /* unresolved target -> Set(requiring file) */
  const seen = new Set();
  const queue = [ENTRY];
  let visited = 0;

  while (queue.length) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    seen.add(file);
    if (!/\.(js|cjs)$/.test(file)) continue;
    visited++;
    let src;
    try { src = readSrc(file); } catch (_) { continue; }
    STATIC_RE.lastIndex = 0;
    let m;
    while ((m = STATIC_RE.exec(src))) {
      const target = normalise(file, m[2]);
      const hit = resolveTo(target);
      if (hit) queue.push(hit);
      else {
        if (!missing.has(target)) missing.set(target, new Set());
        missing.get(target).add(file);
      }
    }
  }

  /* ── informational: broken requires in functions/ files the entrypoint never loads ── */
  const others = [];
  for (const f of [...inTree].filter((p) => p.startsWith('functions/') && p.endsWith('.js') && !seen.has(p))) {
    let src;
    try { src = readSrc(f); } catch (_) { continue; }
    STATIC_RE.lastIndex = 0;
    let m;
    while ((m = STATIC_RE.exec(src))) {
      const t = normalise(f, m[2]);
      if (!resolveTo(t)) others.push({ file: f, target: t });
    }
  }

  /* Provenance for every missing module in ONE `git log --all` pass. Per-path it cost ~3.4s
     against 164 refs, so four lookups dominated the whole gate. Newest-first output means the
     first commit naming a path is that path's newest. */
  const provenance = new Map();
  if (missing.size) {
    const paths = [...missing.keys()].map((t) => t + '.js');
    try {
      const log = git(['log', '--all', '--format=%h', '--name-only', '--'].concat(paths), true);
      let commit = null;
      for (const line of log.split('\n')) {
        const s = line.trim();
        if (!s) continue;
        if (/^[0-9a-f]{7,40}$/.test(s) && s.indexOf('/') === -1) { commit = s; continue; }
        if (!provenance.has(s) && commit) provenance.set(s, commit);
      }
    } catch (_) { /* provenance is informative, not load-bearing */ }
  }

  /* ── the governance ledger ────────────────────────────────────────────────
     Four missing modules are not four instances of one defect. One needs attribution, two are
     deliberately gated behind documented prerequisites, one needs its foreign-port lineage
     reconciled — four decisions, four owners. Collapsing them into "missing" loses exactly the
     information the reader needs, and invites the wrong remedy (deletion) for the wrong reason.

     This gate READS the ledger. It never writes it, and a row in it never makes anything
     deployable: closure is decided by `git ls-tree`, not by Markdown or JSON. */
  let ledger = { dispositions: {} };
  let ledgerError = null;
  try {
    ledger = JSON.parse(fs.readFileSync(path.join(REPO, LEDGER), 'utf8'));
  } catch (e) {
    ledgerError = String(e.message).split('\n')[0];
  }
  const dispositionOf = (mod) => (ledger.dispositions || {})[mod] || null;

  /* A module declared RESOLVED that is NOT in the tree has regressed — someone reverted or
     dropped a dependency that governance already closed. That is a louder problem than an
     undeclared one and must not be reported as a routine block. */
  const regressed = Object.keys(ledger.dispositions || {}).filter((m) =>
    (ledger.dispositions[m].status === 'RESOLVED') && !resolveTo(m));

  const detail = [...missing.keys()].sort().map((t) => {
    let onDisk = 'absent';
    /* Resolved against the repo root, not the caller's cwd: run as a predeploy hook this
       reported "absent" for files that were plainly present, which is the opposite of the
       diagnostic's purpose. */
    try {
      if (fs.existsSync(path.join(REPO, t)) || fs.existsSync(path.join(REPO, t + '.js'))) {
        onDisk = 'present-UNTRACKED';
      }
    } catch (_) {}
    const elsewhere = provenance.get(t + '.js') || null;
    const d = dispositionOf(t);
    return {
      module: t,
      requiredBy: [...missing.get(t)].sort(),
      workingTree: onDisk,
      committedElsewhere: elsewhere,
      /* UNDECLARED is the alarming state, not the friendly one: a dependency nobody has
         dispositioned has drifted into the deploy graph unnoticed. It must never inherit a
         reassuring label by default. */
      status: d ? d.status : 'UNDECLARED',
      summary: d ? d.summary : null,
      owner: d ? (d.owner || null) : null,
      ownerNote: d ? (d.ownerNote || null) : null,
      resolutionPath: d ? d.path : null,
      forbidden: d ? (d.forbidden || null) : null,
      evidence: d ? (d.evidence || []) : [],
    };
  });

  if (JSON_OUT) {
    console.log(JSON.stringify({
      ref: REF, entry: ENTRY, reachableModules: visited,
      ok: !detail.length, blocking: detail, nonBlocking: others,
      ledger: LEDGER, ledgerError: ledgerError, regressed: regressed,
      byStatus: detail.reduce((m, d) => { m[d.status] = (m[d.status] || 0) + 1; return m; }, {}),
    }, null, 2));
    process.exit(detail.length ? 1 : 0);
  }

  console.log('\nFUNCTIONS REQUIRE-CLOSURE GATE');
  console.log('  ref               : ' + REF + '   (git tree, NOT the filesystem)');
  console.log('  entrypoint        : ' + ENTRY);
  console.log('  modules reachable : ' + visited);
  if (others.length) {
    console.log('  non-blocking (files the entrypoint never loads): ' + others.length);
    others.slice(0, 6).forEach((o) => console.log('      ' + o.file + '  ->  ' + o.target));
  }

  if (!detail.length) {
    console.log('  unresolved        : NONE\n');
    console.log('  PASS — the deploy entrypoint graph closes from a clean checkout of ' + REF + '.\n');
    process.exit(0);
  }

  const byStatus = {};
  detail.forEach((d) => { (byStatus[d.status] = byStatus[d.status] || []).push(d); });
  console.log('  unresolved        : ' + detail.length + '  (' +
    Object.keys(byStatus).sort().map((s) => s + ' ' + byStatus[s].length).join(', ') + ')');
  if (ledgerError) {
    console.log('  LEDGER UNREADABLE : ' + LEDGER + ' — ' + ledgerError);
    console.log('                      every module below is reported UNDECLARED as a result.');
  }
  console.log('');

  for (const d of detail) {
    console.log('  [' + d.status + ']  ' + d.module);
    if (d.summary) console.log('      ' + d.summary);
    console.log('      required by         : ' + d.requiredBy.join(', '));
    console.log('      in working tree     : ' + d.workingTree +
      (d.workingTree === 'present-UNTRACKED'
        ? '   <- NOT CLOSURE: a deploy uses a checkout, not this disk'
        : ''));
    console.log('      committed on any ref: ' + (d.committedElsewhere || 'NEVER — no provenance anywhere'));
    console.log('      owner               : ' + (d.owner || 'UNKNOWN' +
      (d.ownerNote ? ' — ' + d.ownerNote : '')));
    if (d.resolutionPath) console.log('      to resolve          : ' + d.resolutionPath);
    if (d.forbidden)      console.log('      FORBIDDEN           : ' + d.forbidden);
    if (d.evidence && d.evidence.length) console.log('      evidence            : ' + d.evidence.join(' · '));
    if (d.status === 'UNDECLARED') {
      console.log('      ** No disposition recorded. This dependency drifted into the deploy');
      console.log('         graph without a governance decision. Do NOT guess: establish its');
      console.log('         provenance and owner, then record it in ' + LEDGER + '.');
    }
    console.log('');
  }

  if (regressed.length) {
    console.log('  ** REGRESSION — declared RESOLVED but absent from the tree:');
    regressed.forEach((m) => console.log('       ' + m + '  (a closed dependency was reverted or dropped)'));
    console.log('');
  }
  /* The person reading this is, most likely, an agent or engineer whose deploy just stopped.
     Tell them here what is happening and why, because this is the one place they are
     guaranteed to look — a notice they have to go and find is a notice nobody reads. */
  console.log('\n  FAIL — a clean checkout of ' + REF + ' cannot load ' + ENTRY + '.');
  console.log('');
  console.log('  THIS IS DELIBERATE FAIL-CLOSED BEHAVIOUR, NOT A DEPLOYMENT OUTAGE.');
  console.log('  ' + ENTRY + ' has required these modules since fa5082b; most are committed on');
  console.log('  no ref anywhere. They exist on this disk only as untracked working files, which');
  console.log('  is NOT deployable provenance: a deploy uses a checkout, not your disk.');
  console.log('');
  console.log('  DO NOT introduce a bypass for convenience. Do not remove or reorder this gate,');
  console.log('  do not commit a guessed implementation, and do not commit a module merely');
  console.log('  because a copy exists in another worktree.');
  console.log('');
  console.log('  Each module needs its provenance resolved by its OWNER, or an explicit');
  console.log('  release-gate disposition. Two clean outcomes per module:');
  console.log('     obtain the authoritative owner/spec -> certify -> commit');
  console.log('     or, if obsolete: remove its require/export -> certify the graph -> commit');
  console.log('');
  console.log('  Per-file dispositions : docs/UNTRACKED_FUNCTIONS_PROVENANCE_CENSUS.md');
  console.log('  Unowned blocker       : docs/ESCALATION_ORDER_CLAIM_PROVENANCE.md');
  console.log('  Release position      : docs/SUPPLY_A_TO_M_RELEASE_RECORD.md\n');
  process.exit(1);
}

/* Run as a gate; export the pure helpers so they can be certified directly rather than
   inferred from end-to-end output. */
if (require.main === module) main();

module.exports = { stripComments, normalise, STATIC_RE, ENTRY };
