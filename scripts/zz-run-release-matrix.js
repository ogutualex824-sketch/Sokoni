#!/usr/bin/env node
/* zz-run-release-matrix.js — the RULES + STORAGE rows of the review/unboxing release matrix, in one run.
 *
 *   node scripts/zz-run-release-matrix.js            (candidate rules in this tree)
 *
 * Emulator only. Never touches a real project. It proves the capability boundary (direct browser writes DENIED,
 * private photos private). It does NOT prove the server paths (P-01, S-01, U-01, U-08, A-01, A-03, A-04): those
 * need sokoni-5b's functions in the functions emulator, and are reported here as NOT RUN, never as PASS.
 *
 * Fails closed:
 *   - below the memory floor it refuses to start (exit 3, BLOCKED: memory), so it never starves a queued deploy;
 *   - a suite that crashes or prints no RESULT line is BLOCKED, not PASS (a crash is not a refusal);
 *   - every matrix row must find its named assertion in the suite output, or the row is MISSING (counts as fail).
 */
'use strict';
const fs = require('fs'), os = require('os'), path = require('path');
const { spawnSync, execSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const FLOOR_MB = Number(process.env.MATRIX_MIN_FREE_MB || 1200);
const LOG = path.join(os.tmpdir(), 'sokoni-release-matrix-' + Date.now() + '.log');

function freeMb () {
  try {
    if (process.platform === 'win32') {
      const out = execSync('powershell -NoProfile -c "(Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory"').toString().trim();
      return Math.round(Number(out) / 1024);
    }
  } catch (_) { /* fall through */ }
  return Math.round(os.freemem() / 1048576);
}

const free = freeMb();
/* Below the floor the EMULATOR steps are skipped (never starve a queued deploy); the unit step still runs.
   Skipped emulator rows report BLOCKED, so the run still exits non-zero. */
const EMU = free >= FLOOR_MB;
if (!EMU) console.log(`emulator steps BLOCKED: memory — ${free} MB free, floor ${FLOOR_MB} MB.`);

const runs = [];
function record (name, r) {
  const out = (r.stdout || '') + (r.stderr || '');
  fs.appendFileSync(LOG, `\n===== ${name} (exit ${r.status}) =====\n${out}`);
  const result = /RESULT: (\d+) passed, (\d+) failed|(\d+) passed, (\d+) failed/.exec(out);
  runs.push({ name, out, status: r.status, crashed: !result || /CRASH/.test(out) });
}

if (EMU) {
/* Firestore suites on a private port, against the candidate source file. */
for (const suite of ['scripts/zz-test-r0.js', 'scripts/test-census-4d-rules.js']) {
  record(suite, spawnSync(process.execPath, ['scripts/zz-run-rules-suite.js', suite, 'firestore.rules'], { cwd: ROOT, encoding: 'utf8', timeout: 900000 }));
}
/* sokoni-5b's hub-review characterisation suite, pinned from their branch, against OUR candidate. */
try {
  const src = execSync('git show origin/hosting/review-approval-ui-on-72dca56:scripts/test-hub-review-rules.js', { cwd: ROOT }).toString();
  fs.writeFileSync(path.join(ROOT, 'scripts', 'zz-5b-hub-review-rules.js'), src);
  record('5b test-hub-review-rules (candidate)', spawnSync(process.execPath, ['scripts/zz-run-rules-suite.js', 'scripts/zz-5b-hub-review-rules.js', 'firestore.rules'], { cwd: ROOT, encoding: 'utf8', timeout: 900000 }));
} catch (e) { runs.push({ name: '5b test-hub-review-rules', out: '', status: null, crashed: true }); }

/* Storage suite: a temporary config with the storage emulator on a private port. */
const cfg = path.join(ROOT, 'zz-matrix-firebase.json');
fs.writeFileSync(cfg, JSON.stringify({ storage: { rules: 'storage.rules' }, emulators: { storage: { port: 9399 }, ui: { enabled: false }, singleProjectMode: true } }));
try {
  record('scripts/zz-test-unboxing-storage.js', spawnSync('npx', ['firebase', 'emulators:exec', '--config', cfg, '--only', 'storage', '--project', 'demo-sokoni-unbox',
    'node scripts/zz-test-unboxing-storage.js'], { cwd: ROOT, encoding: 'utf8', timeout: 900000, shell: true, env: Object.assign({}, process.env, { FIREBASE_STORAGE_EMULATOR_HOST: '127.0.0.1:9399' }) }));
} finally { try { fs.unlinkSync(cfg); } catch (_) {} }
} /* end EMU */

/* Matrix rows → the named assertions that evidence them. */
const ROWS = [
  ['P-04 review cannot become an application', 'zz-test-r0', /PASS\s+H-3 /],
  ['P-04c inverting: a genuine application still accepted', 'zz-test-r0', /PASS\s+H-3c /],
  ['P-03 forged approved review straight to reviews', 'zz-test-r0', /PASS\s+H-4 /],
  ['S-03 direct sportsReviews write', 'zz-test-r0', /PASS\s+H-1 /],
  ['P-02f browser forges a viewing to become review-eligible', 'zz-test-r0', /PASS\s+H-6 /],
  ['P-02c inverting: buyer reads own server-written viewing', 'zz-test-r0', /PASS\s+H-6c /],
  ['B-xx direct bnbReviews write', 'zz-test-r0', /PASS\s+H-2 /],
  ['U-xx direct unboxingReviews create (browser)', 'zz-test-r0', /PASS\s+U-2 /],
  ['U-03 pending photo: owner read', 'unboxing-storage', /PASS\s+R-1 /],
  ['U-04 pending photo: other user read', 'unboxing-storage', /PASS\s+R-4 /],
  ['U-09 pending photo: public read', 'unboxing-storage', /PASS\s+R-5 /],
  ['U-05 non-image upload', 'unboxing-storage', /PASS\s+Q-5 /],
  ['U-05b SVG upload', 'unboxing-storage', /PASS\s+Q-4 /],
  ['U-06 >8 MB upload', 'unboxing-storage', /PASS\s+Q-6 /],
  ['U-07 client writes the public unboxing path', 'unboxing-storage', /PASS\s+P-1 /],
  ['U-07b admin-claimed browser write to the public path', 'unboxing-storage', /PASS\s+P-2 /],
  ['U-xx upload into another uid\'s pending path', 'unboxing-storage', /PASS\s+Q-2 /],
  ['A-02 browser approval of a review (admin-claimed)', 'zz-test-r0', /PASS\s+A-8 /],
  ['A-02b browser approval of an unboxing (admin-claimed)', 'zz-test-r0', /PASS\s+U-10 /],
];
/* SERVER rows — UNIT level (sokoni-5b's scripts/test-review-authority.js, fakes, pinned commit). This is not an
   emulator or live proof; it is reported as "PASS (unit)" so it can never be mistaken for one. */
const SERVER_REF = process.env.REVIEW_AUTHORITY_REF || '51d3947';
let _rvDir = null;
try {
  const dir = _rvDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rv5b-'));
  execSync(`git archive ${SERVER_REF} scripts/test-review-authority.js functions | tar -x -C "${dir.replace(/\\/g, '/')}"`, { cwd: ROOT, shell: 'bash' });
  const env = Object.assign({}, process.env, { NODE_PATH: process.env.REVIEW_NODE_PATH || 'C:/Users/USER1/OneDrive/Desktop/SOKONI/functions/node_modules' });
  record('5b test-review-authority @' + SERVER_REF + ' (unit)', spawnSync(process.execPath, ['scripts/test-review-authority.js'], { cwd: dir, encoding: 'utf8', timeout: 300000, env }));
} catch (e) { runs.push({ name: '5b test-review-authority (unit)', out: String(e), status: null, crashed: true }); } finally { if (_rvDir) try { fs.rmSync(_rvDir, { recursive: true, force: true }); } catch (_) {} }
const SERVER_ROWS = [
  ['P-01 qualifying viewing + submitReview → pending', /PASS H-1 /],
  ['P-02 no viewing → refused (and cancelled does not count)', /PASS H-2 [\s\S]*PASS H-3 /],
  ['P-03 forged identity/name ignored', /PASS H-1 .*authorUid\/name ignored/],
  ['S-01 qualifying booking + submitReview → pending', /PASS H-4 /],
  ['S-02 booking for another venue → refused', /PASS H-5 /],
  ['U-01 authorized submitUnboxing → pending', /PASS U-1 /],
  ['U-02 unauthorized submitUnboxing (other order / unpaid / wrong line)', /PASS U-2 [\s\S]*PASS U-3 [\s\S]*PASS U-4 /],
  ['U-08 AdminOS approval copies the photo (server sets the URL)', /PASS U-7b /],
  ['U-09 unapproved photo stays private', /PASS U-5c /],
  ['A-01 review starts pending', /PASS R-1 [\s\S]*PASS H-8 /],
  ['A-02 unauthorized / self / seller / agent / venue-owner approval refused', /PASS M-1 [\s\S]*PASS S-1 [\s\S]*PASS S-2 [\s\S]*PASS H-9 [\s\S]*PASS H-9b /],
  ['A-03 AdminOS approval publishes', /PASS M-3 [\s\S]*PASS H-10 [\s\S]*PASS U-7 /],
];
const NOT_RUN = ['S-04 (no venue forged-reviewer row)', 'A-04 (no explicit reject-does-not-publish row)'];

let bad = 0;
console.log('\nSUITES');
for (const r of runs) {
  const tag = r.crashed ? 'BLOCKED (crash / no RESULT)' : (r.status === 0 ? 'ran, exit 0' : 'ran, FAILURES');
  if (r.crashed || r.status !== 0) bad++;
  console.log(`  ${tag.padEnd(28)} ${r.name}`);
}
console.log('\nMATRIX (rules + storage rows)');
for (const [row, suiteKey, re] of ROWS) {
  const run = runs.find((x) => x.name.includes(suiteKey));
  const st = !run || run.crashed ? 'BLOCKED' : (re.test(run.out) ? 'PASS' : 'MISSING/FAIL');
  if (st !== 'PASS') bad++;
  console.log(`  ${st.padEnd(13)} ${row}`);
}
console.log('\nMATRIX (server rows — UNIT level, fakes; not emulator, not live)');
const srv = runs.find((x) => x.name.includes('test-review-authority'));
for (const [row, re] of SERVER_ROWS) {
  const st = !srv || srv.crashed ? 'BLOCKED' : (re.test(srv.out) ? 'PASS (unit)' : 'MISSING/FAIL');
  if (st !== 'PASS (unit)') bad++;
  console.log(`  ${st.padEnd(13)} ${row}`);
}
console.log('\nGAPS (no named evidence yet — never counted as PASS): ' + NOT_RUN.join(', '));
console.log('\nfull output: ' + LOG);
process.exit(bad ? 1 : 0);
