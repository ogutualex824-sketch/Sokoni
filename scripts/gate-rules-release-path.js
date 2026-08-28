#!/usr/bin/env node
/* SOURCE -> BUILD -> ARTIFACT -> DEPLOY CONFIG, verified as a chain.
 *
 *   node scripts/gate-rules-release-path.js
 *
 * WHY THIS EXISTS
 * `firebase.json` deployed `firestore.rules` — the documented SOURCE, 261,298 bytes,
 * 99.7% of the 256 KiB ceiling. Per scripts/build-firestore-rules.js the last ruleset that
 * actually RELEASED was 255,359 bytes; above that the Rules API accepts POST /rulesets and
 * then refuses the release with a 400 that the CLI reports as a misleading 409. So a rules
 * change could compile, upload, and never reach production — silently.
 *
 * Deployment now consumes the built artifact. That introduces a NEW failure mode: the
 * artifact can drift from the source, and a stale artifact would deploy OLD authorization
 * while the source shows the new rule. Checking that "a small file exists" would pass in
 * exactly that case.
 *
 * This workstream has already produced two false greens — a probe that agreed with
 * expectation, and a suite measured on an unprovisioned rig — so every link is checked
 * against the one before it, and the gate FAILS CLOSED.
 *
 * It deploys nothing and leaves the working tree byte-identical.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SOURCE = 'firestore.rules';
const ARTIFACT = 'firestore.rules.build';
const CEILING = 256 * 1024;          /* hard API limit                       */
const RELEASED_MAX = 255359;         /* largest ruleset observed to RELEASE   */

let pass = 0, fail = 0;
const ck = (l, ok, d) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined ? '   [' + String(d).slice(0, 84) + ']' : ''));
  ok ? pass++ : fail++;
  return ok;
};
const rd = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);
const paths = (s) => Array.from(new Set((s.match(/match\s+\/[^\s{]*/g) || []).map((x) => x.replace(/\s+/g, ' '))));

console.log('\nRULES RELEASE PATH\n');

/* ── 1. DEPLOY CONFIG — what would actually be sent ──────────────────────── */
console.log('1. DEPLOY CONFIG\n');
const fb = JSON.parse(rd('firebase.json'));
const dbs = fb.firestore || [];
const def = dbs.find((d) => d.database === '(default)');
ck('firebase.json declares the (default) database', !!def);
ck('the (default) database deploys the BUILT ARTIFACT', def && def.rules === ARTIFACT, def && def.rules);
ck('it does NOT deploy the oversized source', def && def.rules !== SOURCE);
const ops = dbs.find((d) => d.database === 'sokoni-ops');
ck('the sokoni-ops database is untouched', !ops || ops.rules === 'firestore.rules.sokoni-ops', ops && ops.rules);
ck('indexes are unchanged', def && def.indexes === 'firestore.indexes.json', def && def.indexes);
const ignore = (fb.hosting && (fb.hosting.ignore || (fb.hosting[0] && fb.hosting[0].ignore))) || [];
ck('hosting never publishes rules files', ignore.indexOf('firestore.rules*') !== -1);

/* ── 2. ARTIFACT EXISTS AND IS SANE ──────────────────────────────────────── */
console.log('\n2. ARTIFACT\n');
if (!fs.existsSync(path.join(ROOT, ARTIFACT))) {
  ck('the artifact exists', false, ARTIFACT + ' is missing — run scripts/build-firestore-rules.js');
  console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(1);
}
const src0 = rd(SOURCE);
const art0 = rd(ARTIFACT);
const bytes = Buffer.byteLength(art0, 'utf8');
ck('artifact is below the hard 256 KiB ceiling', bytes < CEILING, bytes + ' bytes');
ck('artifact is within the size that has actually RELEASED', bytes <= RELEASED_MAX,
   bytes + ' <= ' + RELEASED_MAX);
ck('artifact braces balance', (art0.match(/\{/g) || []).length === (art0.match(/\}/g) || []).length,
   (art0.match(/\{/g) || []).length + ' open');
ck('artifact is not trivially small', bytes > 50000, bytes + ' bytes');

/* ── 3. SOURCE -> BUILD is REPRODUCIBLE, and the artifact is CURRENT ─────── */
console.log('\n3. BUILD (the artifact really comes from THIS source)\n');
const committed = sha(art0);
let build1 = null, build2 = null, buildErr = null;
try {
  execFileSync('node', [path.join(ROOT, 'scripts', 'build-firestore-rules.js')], { cwd: ROOT, stdio: 'pipe' });
  build1 = rd(ARTIFACT);
  execFileSync('node', [path.join(ROOT, 'scripts', 'build-firestore-rules.js')], { cwd: ROOT, stdio: 'pipe' });
  build2 = rd(ARTIFACT);
} catch (e) { buildErr = String((e && e.message) || e); }
finally { fs.writeFileSync(path.join(ROOT, ARTIFACT), art0); }   /* leave the tree untouched */

ck('the build runs', buildErr === null, buildErr || 'ok');
if (build1 !== null) {
  ck('the build is DETERMINISTIC', sha(build1) === sha(build2), sha(build1) + ' vs ' + sha(build2));
  ck('the committed artifact MATCHES a fresh build of the current source',
     sha(build1) === committed,
     sha(build1) === committed ? committed : 'STALE: committed ' + committed + ' vs fresh ' + sha(build1));
  ck('the working tree was left byte-identical', sha(rd(ARTIFACT)) === committed);
}

/* ── 4. THE ARTIFACT STILL CARRIES THE AUTHORIZATION ─────────────────────── */
console.log('\n4. AUTHORIZATION SURVIVED THE BUILD (size must not come from weakening rules)\n');
const srcPaths = paths(src0), artPaths = paths(art0);
const lost = srcPaths.filter((p) => artPaths.indexOf(p) === -1);
ck('every distinct match path in the source is in the artifact', lost.length === 0,
   lost.length ? 'LOST: ' + lost.slice(0, 5).join(', ') : srcPaths.length + ' paths');

/* Count against the COMMENT-FREE source. The source documents rules in prose — CLAUDE.md
   requires those comments — and 7 of them contain the literal text "allow read:" etc.
   Comparing raw source to artifact therefore reports 1673 vs 1666 and fails a correct
   build. The comparison must measure executable statements on both sides, which is also
   what lets this be EQUALITY rather than a permissive >=. */
const noComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const allowSrc = (noComments(src0).match(/allow\s+\w/g) || []).length;
const allowArt = (art0.match(/allow\s+\w/g) || []).length;
ck('the artifact keeps EVERY executable allow statement', allowArt === allowSrc,
   allowArt + ' vs comment-free source ' + allowSrc);

/* The specific rule this workstream added — a stale artifact would silently drop it. */
const IMMUTABLE = 'request.resource.data.shopOwnerId == resource.data.shopOwnerId';
ck('shopEmployees ownership anchor is IMMUTABLE on update, in the ARTIFACT',
   art0.indexOf(IMMUTABLE) !== -1, IMMUTABLE);
ck('  ...and in the source it was built from', src0.indexOf(IMMUTABLE) !== -1);

/* A few load-bearing blocks, named so a wholesale truncation cannot pass quietly. */
for (const m of ['match /shopEmployees/', 'match /users/', 'match /orders/', 'match /products/']) {
  ck('artifact retains ' + m, art0.indexOf(m) !== -1);
}
ck('the artifact grants nothing unconditionally at the top level',
   !/match\s+\/\{document=\*\*\}\s*\{[^}]*allow\s+(read|write)\s*:\s*if\s+true/.test(art0));

/* ── 5. NOT A DEPLOY ─────────────────────────────────────────────────────── */
console.log('\n5. SCOPE\n');
ck('this gate deploys nothing', true, 'verification only — firebase deploy is a separate, approved step');

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
if (fail) {
  console.log('  The rules release path is NOT safe to deploy. Fix the failing link above.');
  console.log('  A stale artifact is the dangerous case: the source would show the new rule');
  console.log('  while production received the old one.\n');
}
process.exit(fail ? 1 : 0);
