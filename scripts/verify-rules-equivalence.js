#!/usr/bin/env node
/* DIFFERENTIAL AUTHORIZATION EQUIVALENCE — served vs candidate.
 *
 * The consolidation claim is that a candidate grants and denies EXACTLY what the served
 * ruleset does. Inspection cannot establish that: the whole reason same-scope unions are
 * dangerous is that reading a block tells you the wrong answer. So the same request corpus
 * is evaluated against both sources by the Firebase Rules test API — server-side, the same
 * engine that enforces production — and every verdict must match.
 *
 * WHY THIS IS NOT THE EMULATOR
 * No emulator, no JDK, no local state. `projects:test` evaluates a source against
 * synthetic requests and returns SUCCESS (allowed) or FAILURE (denied) per case. It needs
 * no ruleset to be created and nothing to be released, so it touches no production
 * resource at all.
 *
 * THE CORPUS IS BUILT TO ALLOW, NOT ONLY TO DENY
 * A corpus that denies everything would compare identically across any two rulesets,
 * including one with a granting rule deleted — a vacuous pass. Each path is therefore
 * exercised with personas and resource data chosen to SATISFY common ownership
 * conditions (uid/ownerId/sellerId/... equal to the caller), plus admin and superAdmin
 * tokens, so a meaningful number of cases genuinely resolve to ALLOW. The harness reports
 * how many did, and refuses to certify if that number is zero.
 *
 * THE SABOTAGE CONTROL
 * `--sabotage` weakens one granting rule in the candidate before comparing. The harness
 * MUST report a difference. A comparison that cannot fail is not evidence, and this is the
 * control that proves it can.
 *
 *   node scripts/verify-rules-equivalence.js <served> <candidate> [--sabotage] [--limit N]
 */
'use strict';
const fs = require('fs');
const { spawnSync } = require('child_process');
const NL = String.fromCharCode(10);

const PROJECT = 'sokoni-aeb26';
const PY = 'C:/Users/USER1/AppData/Local/Google/Cloud SDK/google-cloud-sdk/platform/bundledpython/python.exe';
const ARGS = process.argv.slice(2).filter((a) => a.indexOf('--') !== 0);
const SERVED = ARGS[0] || 'firestore.rules.served-59af870d';
const CANDIDATE = ARGS[1];
const SABOTAGE = process.argv.indexOf('--sabotage') > -1;
const LIMIT = (() => {
  const i = process.argv.indexOf('--limit');
  return i > -1 ? Number(process.argv[i + 1]) : 0;
})();
const BATCH = 100;

if (!CANDIDATE) { console.log('  usage: verify-rules-equivalence.js <served> <candidate>'); process.exit(1); }

let TOKEN = '';
function post (body) {
  const tmp = require('path').join(process.env.TEMP || '.', 'ruleseq-' + process.pid + '.json');
  fs.writeFileSync(tmp, JSON.stringify(body));
  const r = spawnSync('curl', ['-s', '-X', 'POST',
    '-H', 'Authorization: Bearer ' + TOKEN,
    '-H', 'x-goog-user-project: ' + PROJECT,
    '-H', 'Content-Type: application/json',
    '--data-binary', '@' + tmp,
    'https://firebaserules.googleapis.com/v1/projects/' + PROJECT + ':test'],
    { encoding: 'utf8', maxBuffer: 1024 * 1024 * 128 });
  try { fs.unlinkSync(tmp); } catch (_) {}
  try { return JSON.parse(String(r.stdout || '')); }
  catch (_) { return { __raw: String(r.stdout || '').slice(0, 300) }; }
}

/* ── corpus ───────────────────────────────────────────────────────────────── */
function decomment (src) {
  let inB = false;
  return src.split(NL).map((l) => {
    let t = l;
    if (inB) { const e = t.indexOf('*/'); if (e < 0) return ''; inB = false; t = t.slice(e + 2); }
    t = t.replace(/\/\*[\s\S]*?\*\//g, '');
    const o = t.indexOf('/*'); if (o > -1) { inB = true; t = t.slice(0, o); }
    return t.replace(/\/\/.*$/, '');
  });
}

const RE_MATCH = /match\s+(\/[^{\s]*(?:\{[^}]*\}[^{\s]*)*)/;

/* concrete document paths, one per declared scope */
function collectPaths (file) {
  const lines = decomment(fs.readFileSync(file, 'utf8'));
  const stack = [];
  const out = new Set();
  lines.forEach((l) => {
    const t = l.trim();
    const mm = t.match(RE_MATCH);
    const structural = mm ? t.replace(mm[1], '') : t;
    let used = false;
    for (const ch of structural) {
      if (ch === '{') {
        if (mm && !used) { used = true; stack.push(mm[1]); out.add(stack.join('')); }
        else stack.push('?');
      } else if (ch === '}') { if (stack.length) stack.pop(); }
    }
  });
  return Array.from(out);
}

const U = 'uid_alpha';
const OTHER = 'uid_beta';
const OWNED = {
  uid: U, userId: U, ownerId: U, sellerId: U, customerId: U, buyerId: U,
  createdBy: U, driverId: U, senderId: U, shopOwnerId: U, sellerUid: U,
  flaggedBy: U, targetId: 'tgt', reason: 'r', status: 'active', label: 'l'
};
const PERSONAS = [
  { tag: 'anon',   auth: null },
  { tag: 'user',   auth: { uid: U, token: { email_verified: true } } },
  { tag: 'other',  auth: { uid: OTHER, token: { email_verified: true } } },
  { tag: 'admin',  auth: { uid: U, token: { admin: true, email_verified: true } } },
  { tag: 'super',  auth: { uid: U, token: { superAdmin: true, admin: true, email_verified: true } } },
  { tag: 'mod',    auth: { uid: U, token: { moderator: true, email_verified: true } } }
];
const METHODS = ['get', 'list', 'create', 'update', 'delete'];

function concrete (scopeKey) {
  /* '?/databases/{database}/documents/foo/{id}' -> '/databases/(default)/documents/foo/id_1' */
  let p = scopeKey.replace(/^\?+/, '');
  p = p.replace('/databases/{database}/documents', '/databases/(default)/documents');
  let n = 0;
  p = p.replace(/\{([^}]*)\}/g, (m0, v) => {
    if (/=\*\*$/.test(v)) return 'wild_' + (++n);
    return 'id_' + (++n);
  });
  return p;
}

function buildCorpus (scopeKeys) {
  const cases = [];
  scopeKeys.forEach((k) => {
    const path = concrete(k);
    if (path.indexOf('/databases/(default)/documents') !== 0) return;
    PERSONAS.forEach((p) => {
      METHODS.forEach((m) => {
        const req = { path, method: m };
        if (p.auth) req.auth = p.auth;
        if (m === 'create' || m === 'update') req.resource = { data: OWNED };
        cases.push({ key: k, tag: p.tag, method: m, testCase: {
          expectation: 'ALLOW', request: req, pathEncoding: 'PLAIN', expressionReportLevel: 'NONE'
        } });
      });
    });
  });
  return cases;
}

/* ── evaluation ───────────────────────────────────────────────────────────── */
function evaluate (label, content, corpus) {
  const verdicts = new Array(corpus.length);
  let allowed = 0, errored = 0;
  for (let i = 0; i < corpus.length; i += BATCH) {
    const slice = corpus.slice(i, i + BATCH);
    const res = post({
      source: { files: [{ name: 'firestore.rules', content }] },
      testSuite: { testCases: slice.map((c) => c.testCase) }
    });
    if (!res.testResults) {
      throw new Error(label + ': test call failed at batch ' + (i / BATCH) + ' :: ' +
        JSON.stringify(res).slice(0, 300));
    }
    res.testResults.forEach((r, j) => {
      const v = r.state === 'SUCCESS' ? 'ALLOW' : 'DENY';
      if (r.errorPosition) { errored++; }
      if (v === 'ALLOW') allowed++;
      verdicts[i + j] = v;
    });
    process.stdout.write('\r    ' + label + '  ' + Math.min(i + BATCH, corpus.length) +
                         '/' + corpus.length + '   allow ' + allowed + '   ');
  }
  process.stdout.write(NL);
  return { verdicts, allowed, errored };
}

/* ── sabotage: weaken exactly one granting rule ───────────────────────────── */
function sabotage (src) {
  const re = /allow\s+read\s*:\s*if\s+isAdmin\(\)\s*;/;
  if (!re.test(src)) throw new Error('sabotage: no `allow read: if isAdmin();` to weaken');
  return src.replace(re, 'allow read: if true;');
}

/* ── run ──────────────────────────────────────────────────────────────────── */
const tk = spawnSync('gcloud', ['auth', 'print-access-token'],
  { encoding: 'utf8', shell: true, env: Object.assign({}, process.env, { CLOUDSDK_PYTHON: PY }) });
TOKEN = String(tk.stdout || '').trim();
if (!TOKEN) { console.log('  no access token'); process.exit(1); }

const servedSrc = fs.readFileSync(SERVED, 'utf8');
let candSrc = fs.readFileSync(CANDIDATE, 'utf8');
if (SABOTAGE) { candSrc = sabotage(candSrc); }

let scopes = collectPaths(SERVED);
if (LIMIT) scopes = scopes.slice(0, LIMIT);
const corpus = buildCorpus(scopes);

console.log('');
console.log('  served     ' + SERVED + '  (' + servedSrc.length + ' ch)');
console.log('  candidate  ' + CANDIDATE + '  (' + candSrc.length + ' ch)' + (SABOTAGE ? '   *** SABOTAGED ***' : ''));
console.log('  scopes     ' + scopes.length + '   corpus ' + corpus.length + ' cases');
console.log('');

let A, B;
try {
  A = evaluate('served   ', servedSrc, corpus);
  B = evaluate('candidate', candSrc, corpus);
} catch (e) {
  console.log('');
  console.log('  EVALUATION FAILED: ' + e.message);
  process.exit(1);
}

const diffs = [];
for (let i = 0; i < corpus.length; i++) {
  if (A.verdicts[i] !== B.verdicts[i]) diffs.push({ c: corpus[i], a: A.verdicts[i], b: B.verdicts[i] });
}

console.log('');
console.log('  served    ALLOW ' + A.allowed + ' / ' + corpus.length);
console.log('  candidate ALLOW ' + B.allowed + ' / ' + corpus.length);
console.log('  divergences     ' + diffs.length);

if (diffs.length) {
  console.log('');
  diffs.slice(0, 25).forEach((d) => console.log('    ' + d.a + ' -> ' + d.b + '   ' +
    d.c.tag + ' ' + d.c.method + '  ' + concrete(d.c.key)));
  if (diffs.length > 25) console.log('    ... and ' + (diffs.length - 25) + ' more');
}

console.log('');
/* a corpus that never allows compares identically across anything */
if (A.allowed === 0) {
  console.log('  VACUOUS — the corpus produced no ALLOW at all, so an identical result');
  console.log('  proves nothing. Fix the corpus before trusting any equivalence claim.');
  process.exit(1);
}

if (SABOTAGE) {
  if (diffs.length > 0) {
    console.log('  SABOTAGE CONTROL PASSED — the harness detected the weakened rule.');
    console.log('  ' + diffs.length + ' divergence(s) from one altered condition.');
    process.exit(0);
  }
  console.log('  SABOTAGE CONTROL FAILED — a weakened granting rule produced NO divergence.');
  console.log('  The harness cannot detect an authorization change and must not be used.');
  process.exit(1);
}

if (diffs.length === 0) {
  console.log('  EQUIVALENT — identical verdict on all ' + corpus.length + ' cases,');
  console.log('  including ' + A.allowed + ' that genuinely resolved to ALLOW.');
  process.exit(0);
}
console.log('  NOT EQUIVALENT — the candidate changes authorization. Rejected.');
process.exit(1);
