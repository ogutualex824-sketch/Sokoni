/* Does cert-daraja-sell-authority.js actually detect a broken guard?
 *
 * A 45/0 green is worthless until the suite is shown to go RED for the specific defect it claims
 * to cover. Every mutation below CHANGES BEHAVIOUR — a sabotage that only rewrites a comment is a
 * broken probe that scores "not caught" and teaches nothing.
 *
 * The verdict is the EXIT CODE of the certification run, not its wording: each mutation must
 * produce a NON-ZERO exit. Zero mutations caught means the suite is decorative.
 *
 * functions/index.js is restored from an in-memory copy and the restoration is verified by hash
 * before this script exits, including on error.
 *
 * Run:  node scripts/sabotage-daraja-authority.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TARGET = path.join(ROOT, 'functions', 'index.js');
const ORIGINAL = fs.readFileSync(TARGET, 'utf8');
const ORIGINAL_HASH = crypto.createHash('sha256').update(ORIGINAL).digest('hex');

const GUARD_CALL =
  "    await _assertDarajaSellAuthority(request.auth, String(sellerUid),\n" +
  "      'initiate an M-Pesa payment for this merchant');";
const GUARD_REQUIRE =
  "    const { _assertSellAuthority: _assertDarajaSellAuthority } =\n" +
  "      require('./pos-zero-friction')._internal;";

const MUTATIONS = [
  {
    name: 'S1  guard deleted outright — the pre-fix state',
    expect: 'every cross-tenant denial should reach the credential stage instead of being refused',
    apply: (s) => s.replace(GUARD_CALL, '    /* SABOTAGE: guard removed */'),
  },
  {
    name: 'S2  guard binds the caller to THEMSELVES, not to the named merchant',
    expect: 'a real merchant naming another merchant should slip through; outsiders still refused',
    apply: (s) => s.replace(
      'await _assertDarajaSellAuthority(request.auth, String(sellerUid),',
      'await _assertDarajaSellAuthority(request.auth, String(request.auth.uid),'),
  },
  {
    name: 'S3  a SECOND, local authority replaces the shared one',
    expect: 'the shared-authority assertion and every denial should fail',
    apply: (s) => s.replace(GUARD_REQUIRE,
      "    async function _assertDarajaSellAuthority(a) { return a && a.uid; } /* SABOTAGE: local copy */"),
  },
  {
    name: 'S4  guard moved AFTER the merchant-attributed pricing work',
    expect: 'the ordering assertion should fail even though the denial messages stay correct',
    apply: (s) => s
      .replace(GUARD_CALL, '    /* SABOTAGE: moved */')
      .replace('    if (!Number.isFinite(authoritativeAmount) || authoritativeAmount < 1) {',
               GUARD_CALL + '\n\n    if (!Number.isFinite(authoritativeAmount) || authoritativeAmount < 1) {'),
  },
];

/* Environment goes through the `env` option, NOT an inline `VAR=x cmd` prefix: execSync spawns
   cmd.exe on Windows, where that prefix is a syntax error and every run would fail identically —
   which a sabotage harness would happily score as four catches. */
const CERT = 'npx firebase --config scripts/emulators.cert.json emulators:exec ' +
  '--only firestore,auth --project sokoni-daraja-sabotage ' +
  '"node scripts/cert-daraja-sell-authority.js"';
const CERT_ENV = Object.assign({}, process.env, {
  FIRESTORE_EMU_PORT: '8099',
  FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9199',
  NODE_PATH: ROOT + '/functions/node_modules;' + ROOT + '/node_modules',
});

/* The CLI itself has been observed to exit non-zero on emulator shutdown while the script under it
   exited 0. Reading the CLI's code alone would score that noise as "caught". The verdict is taken
   from the certification's OWN summary line, and a run whose summary is missing entirely is
   reported as INCONCLUSIVE rather than counted as a catch. */
function runCert() {
  let out = '';
  try { out = execSync(CERT, { cwd: ROOT, env: CERT_ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 420000 }); }
  catch (e) { out = String((e.stdout || '') + (e.stderr || '')); }
  const m = out.match(/PASS (\d+)\s+FAIL (\d+)\s+INCONCLUSIVE (\d+)/);
  if (!m) return { verdict: 'INCONCLUSIVE', detail: 'no summary line — the suite did not complete' };
  const p = Number(m[1]), f = Number(m[2]);
  return { verdict: f > 0 ? 'CAUGHT' : 'MISSED', detail: 'PASS ' + p + ' FAIL ' + f, fail: f, pass: p };
}

let caught = 0, missed = 0, inconclusive = 0;
const rows = [];

try {
  console.log('BASELINE — the unmutated tree must be GREEN, or every "catch" below is meaningless');
  const base = runCert();
  console.log('  baseline: ' + base.verdict + '  [' + base.detail + ']');
  if (base.fail !== 0) {
    console.log('\nABORT: baseline is not green. A red baseline makes every mutation look caught.');
    process.exit(1);
  }
  console.log('  baseline green (0 failures on the real tree)\n');

  for (const mut of MUTATIONS) {
    const mutated = mut.apply(ORIGINAL);
    if (mutated === ORIGINAL) {
      console.log(mut.name + '\n  BROKEN PROBE: the mutation changed nothing — anchor text not found.');
      missed++; rows.push([mut.name, 'BROKEN PROBE (no-op mutation)']);
      continue;
    }
    fs.writeFileSync(TARGET, mutated);
    const r = runCert();
    fs.writeFileSync(TARGET, ORIGINAL);

    console.log(mut.name);
    console.log('  expected: ' + mut.expect);
    console.log('  result:   ' + r.verdict + '  [' + r.detail + ']\n');
    if (r.verdict === 'CAUGHT') caught++;
    else if (r.verdict === 'INCONCLUSIVE') inconclusive++;
    else missed++;
    rows.push([mut.name, r.verdict + ' (' + r.detail + ')']);
  }
} finally {
  fs.writeFileSync(TARGET, ORIGINAL);
  const back = crypto.createHash('sha256').update(fs.readFileSync(TARGET, 'utf8')).digest('hex');
  console.log('restore verified: ' + (back === ORIGINAL_HASH ? 'YES' : 'NO — functions/index.js IS STILL MUTATED'));
  if (back !== ORIGINAL_HASH) process.exit(2);
}

console.log('\n' + '='.repeat(72));
rows.forEach((r) => console.log('  ' + r[1].padEnd(28) + r[0]));
console.log('  CAUGHT ' + caught + ' / ' + MUTATIONS.length +
            '   MISSED ' + missed + '   INCONCLUSIVE ' + inconclusive);
console.log('='.repeat(72));
process.exit(missed === 0 && caught === MUTATIONS.length ? 0 : 1);
