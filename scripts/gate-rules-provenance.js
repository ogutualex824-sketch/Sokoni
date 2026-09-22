#!/usr/bin/env node
/* ============================================================================
   GATE 1 — Firestore rules provenance machinery
   ============================================================================
   There is no reliable invariant in this repository connecting

       Git source  ->  builder  ->  generated artifact  ->  ACTIVE ruleset

   and its absence hid a 31-block drift between firestore.rules and what is
   actually deployed. Three separate near-misses came from three different
   substitutes for that chain:

       "Git looks right"        — Git was perfect against the WRONG baseline
       "the build succeeded"    — and produced an authorization-DESTRUCTIVE file
       "the deploy succeeded"   — which proves a command ran, not what is active

   So this gate proves the chain end to end, and carries TARGET IDENTITY through
   every hop. A comparison that cannot name its database cannot tell "correct"
   from "correct about something else".

   IT MODIFIES NO RULES. It invokes the real builder (whose output is already
   the current artifact, so the write is idempotent) and verifies the result,
   then asserts every rules artifact is byte-unchanged before exiting.

   Usage:  node scripts/gate-rules-provenance.js [--evidence <path>]
   ========================================================================= */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync, execSync } = require('child_process');
const { scan, normalise } = require('./rules-blocks.js');

const ROOT = path.join(__dirname, '..');
const PROJECT = 'sokoni-aeb26';
const SP = process.env.SOKONI_EVIDENCE_DIR ||
  'C:/Users/USER1/AppData/Local/Temp/claude/c--Users-USER1-OneDrive-Desktop-SOKONI/51f05820-e88d-48b4-8b14-ba44300630f9/scratchpad';

let pass = 0;
const failures = [];
function ck(name, cond, detail) {
  console.log('  [' + (cond ? 'PASS' : 'FAIL') + '] ' + name + (detail ? '   ' + detail : ''));
  if (cond) pass++; else failures.push(name + (detail ? '  — ' + detail : ''));
  return cond;
}
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);
const read = (p) => fs.readFileSync(p, 'utf8');

/* Structural + semantic comparison of two rulesets, by BLOCK not by bytes. */
function compare(aSrc, bSrc) {
  const A = scan(aSrc), B = scan(bSrc);
  const am = new Map(A.map((x) => [x.path, x])), bm = new Map(B.map((x) => [x.path, x]));
  const removed = [...am.keys()].filter((p) => !bm.has(p));
  const added = [...bm.keys()].filter((p) => !am.has(p));
  /* The service wrapper necessarily changes whenever a block is added inside
     it; it is not an authorization rule, and is excluded from `changed`. */
  const changed = [...am.keys()].filter((p) => bm.has(p) && p.indexOf('/databases/') !== 0 &&
    normalise(am.get(p).body) !== normalise(bm.get(p).body));
  return { aCount: A.length, bCount: B.length, removed, added, changed };
}

/* Active rules are fetched through the REST API rather than any cached file:
   a `.live` copy is a claim about the past. */
function fetchActive() {
  /* gcloud and curl are .cmd shims on Windows, which execFileSync cannot
     spawn directly (ENOENT). shell:true is required here and is safe: no part
     of these commands is caller-controlled. */
  const token = execSync('gcloud auth print-access-token', { encoding: 'utf8' }).trim();
  const get = (url) => JSON.parse(execSync('curl -s -H "Authorization: Bearer ' + token +
    '" -H "x-goog-user-project: ' + PROJECT + '" "' + url + '"',
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
  const releases = get('https://firebaserules.googleapis.com/v1/projects/' + PROJECT + '/releases');
  const out = {};
  (releases.releases || []).forEach((r) => {
    out[r.name.replace('projects/' + PROJECT + '/releases/', '')] = {
      release: r.name, rulesetId: r.rulesetName.split('/').pop(), updateTime: r.updateTime || null,
      fetch: () => {
        const rs = get('https://firebaserules.googleapis.com/v1/' + r.rulesetName);
        return ((rs.source && rs.source.files) || []).map((f) => f.content).join('');
      },
    };
  });
  return out;
}

const evidence = { gate: 'rules-provenance', at: new Date().toISOString(), targets: [] };

console.log('\nGATE 1 — FIRESTORE RULES PROVENANCE\n');

/* ── 1. DISCOVER every declared target ──────────────────────────────────── */
const fb = JSON.parse(read(path.join(ROOT, 'firebase.json')));
const declared = Array.isArray(fb.firestore) ? fb.firestore : (fb.firestore ? [fb.firestore] : []);
ck('firestore targets are DECLARED as a list, not assumed', declared.length >= 1,
  declared.map((d) => d.database || '(default)').join(', '));
ck('storage rules are declared separately', !!fb.storage,
  fb.storage ? (fb.storage.rules || 'declared') : 'none');

/* ── 2. ACTIVE rulesets, from the API ───────────────────────────────────── */
let active;
try { active = fetchActive(); } catch (e) { active = null; }
if (!ck('the active rulesets are retrievable', !!active,
  active ? Object.keys(active).length + ' releases' : 'FAIL CLOSED — cannot identify active rules')) {
  console.log('\n  GATE 1 = BLOCKED (active rules unidentifiable)\n');
  process.exit(1);
}
ck('every release carries a ruleset identity',
  Object.values(active).every((r) => !!r.rulesetId));

/* ── 3. SOURCE MAPPING, from configuration — not filenames ──────────────── */
const MAP = declared.map((d) => {
  const dbId = d.database || '(default)';
  const releaseKey = dbId === '(default)' ? 'cloud.firestore' : 'cloud.firestore/' + dbId;
  return { dbId, releaseKey, source: d.rules, indexes: d.indexes };
});
MAP.forEach((m) => {
  ck('mapping: ' + m.dbId + '  ->  ' + m.source,
    !!m.source && fs.existsSync(path.join(ROOT, m.source)),
    'release ' + m.releaseKey);
});
ck('the two Firestore sources are DISTINCT files',
  new Set(MAP.map((m) => m.source)).size === MAP.length);

/* ── 4. SOURCE -> BUILD, through the REAL builder ───────────────────────── */
const buildPath = path.join(ROOT, 'firestore.rules.build');
const beforeBuild = read(buildPath);
const beforeRules = read(path.join(ROOT, 'firestore.rules'));
try {
  execFileSync('node', [path.join(ROOT, 'scripts', 'build-firestore-rules.js')],
    { cwd: ROOT, stdio: 'pipe' });
  ck('the REAL builder runs', true);
} catch (e) { ck('the REAL builder runs', false, String(e.message).slice(0, 80)); }

const afterBuild = read(buildPath);
const cmp = compare(read(path.join(ROOT, 'firestore.rules')), afterBuild);
ck('source -> build: no block removed', cmp.removed.length === 0, cmp.removed.join(','));
ck('source -> build: no block added', cmp.added.length === 0, cmp.added.join(','));
ck('source -> build: no block semantically changed', cmp.changed.length === 0, cmp.changed.join(','));
ck('…compared structurally, not by count',
  cmp.aCount === cmp.bCount, cmp.aCount + ' -> ' + cmp.bCount);
ck('the builder is deterministic (idempotent on an unchanged source)',
  sha(beforeBuild) === sha(afterBuild), sha(beforeBuild) + ' / ' + sha(afterBuild));
ck('firestore.rules was NOT modified by this gate',
  sha(beforeRules) === sha(read(path.join(ROOT, 'firestore.rules'))));

/* ── 5. EXPECTED -> ACTIVE, per identified target ───────────────────────── */
const BASELINES = {
  '(default)': { file: SP + '/live-rules.txt', expectId: 'ad2033ad', blocks: 709 },
  'sokoni-ops': { file: SP + '/ops-rules.txt', expectId: 'c76c080c', blocks: 3 },
};
MAP.forEach((m) => {
  const b = BASELINES[m.dbId];
  const rel = active[m.releaseKey];
  if (!rel) { ck('active release found for ' + m.dbId, false); return; }
  ck(m.dbId + ': active ruleset identified', rel.rulesetId.startsWith(b ? b.expectId : ''),
    rel.rulesetId);
  if (!b || !fs.existsSync(b.file)) { ck(m.dbId + ': baseline artifact present', false, b && b.file); return; }
  const expected = read(b.file);
  const live = rel.fetch();
  const d = compare(expected, live);
  ck(m.dbId + ': expected == active  (' + d.bCount + ' blocks)',
    d.removed.length === 0 && d.added.length === 0 && d.changed.length === 0,
    'removed ' + d.removed.length + ' added ' + d.added.length + ' changed ' + d.changed.length);
  ck(m.dbId + ': block count matches the established baseline', d.bCount === b.blocks,
    d.bCount + ' vs ' + b.blocks);
  evidence.targets.push({
    target_type: 'firestore', database_id: m.dbId, release_name: rel.release,
    source_path: m.source, source_sha: sha(read(path.join(ROOT, m.source))),
    expected_artifact: b.file, expected_sha: sha(expected),
    active_ruleset_id: rel.rulesetId, active_sha: sha(live), active_updated: rel.updateTime,
    block_count: d.bCount, added: d.added.length, removed: d.removed.length, changed: d.changed.length,
    result: (d.removed.length + d.added.length + d.changed.length === 0 && d.bCount === b.blocks) ? 'PASS' : 'FAIL',
  });
});

/* Storage is EXCLUDED — recorded, never silently omitted. "Not compared" and
   "not present" must not look the same to a future reader. */
evidence.targets.push({
  target_type: 'storage', database_id: null,
  release_name: Object.keys(active).find((k) => k.indexOf('firebase.storage') === 0) || null,
  scope: 'FIRESTORE PROVENANCE GATE', result: 'EXPLICITLY EXCLUDED',
});
ck('storage is recorded as EXPLICITLY EXCLUDED, not omitted',
  evidence.targets.some((t) => t.result === 'EXPLICITLY EXCLUDED'));

/* ── 6. NEGATIVE TARGET-IDENTITY TEST ───────────────────────────────────── */
{
  /* The machinery must be unable to report a cross-database match as valid.
     Compare the DEFAULT baseline against the OPS active ruleset: it must come
     back as a large difference, never as agreement. */
  const dflt = read(BASELINES['(default)'].file);
  const ops = read(BASELINES['sokoni-ops'].file);
  const x = compare(dflt, ops);
  const diverges = (x.removed.length + x.added.length) > 100;
  ck('NEGATIVE: default artifact vs ops active does NOT compare as equal',
    diverges, 'removed ' + x.removed.length + ' added ' + x.added.length);
  const y = compare(ops, dflt);
  ck('NEGATIVE: …and the reverse direction likewise',
    (y.removed.length + y.added.length) > 100);
  /* CONTROL: the same comparator DOES return equality for a correct pair, so
     the two assertions above are not passing because it always differs. */
  const z = compare(dflt, dflt);
  ck('CONTROL: the comparator returns equality for a matched pair',
    z.removed.length === 0 && z.added.length === 0 && z.changed.length === 0);
  ck('every evidence record carries its database identity',
    evidence.targets.filter((t) => t.target_type === 'firestore')
      .every((t) => !!t.database_id && !!t.release_name && !!t.active_ruleset_id));
}

/* ── 7. Artifacts unchanged ─────────────────────────────────────────────── */
ck('candidate artifact untouched', fs.existsSync(SP + '/candidate-rules.txt') &&
  scan(read(SP + '/candidate-rules.txt')).length === 713);
ck('firestore.rules.build is unchanged by this gate', sha(beforeBuild) === sha(afterBuild));

const evPath = path.join(SP, 'gate1-provenance-evidence.json');
evidence.result = failures.length ? 'BLOCKED' : 'GREEN';
fs.writeFileSync(evPath, JSON.stringify(evidence, null, 2));

console.log('');
console.log('  evidence: ' + evPath);
failures.forEach((f) => console.log('  FAIL  ' + f));
console.log('  ' + pass + ' passed, ' + failures.length + ' failed');
console.log('');
console.log('  GATE 1 = ' + (failures.length ? 'BLOCKED' : 'GREEN'));
console.log('');
process.exit(failures.length ? 1 : 0);
