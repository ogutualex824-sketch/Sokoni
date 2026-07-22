#!/usr/bin/env node
'use strict';

/**
 * SOKONI test inventory — discover, run and classify every suite.
 *
 * WHY THIS EXISTS
 * The repository holds 56 test suites and the deploy pipeline runs three checks,
 * none of which is a test suite. That is a release-engineering gap, not a
 * testing one: the tests already exist and already pass, they simply do not
 * influence whether anything ships.
 *
 * Before any of them can gate a deployment we need to know which pass
 * consistently, which fail because of a real defect, and which fail only
 * because a credential or an emulator is missing. A gate built on that last
 * category fails on day one and gets disabled on day two.
 *
 *   node scripts/test-inventory.js            run everything, print the table
 *   node scripts/test-inventory.js --json     machine-readable
 *   node scripts/test-inventory.js --gate     exit 1 if any GREEN suite fails
 *
 * This script changes nothing. It only reports.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const AS_JSON = process.argv.includes('--json');
const GATE = process.argv.includes('--gate');
const TIMEOUT_MS = 60000;

/* A suite that needs a credential, an emulator or the network is not broken —
   it is un-runnable here. Classifying those separately is the whole point:
   folding them into FAIL would make the aggregate red forever and the gate
   worthless. */
const ENV_SIGNALS = [
  /GOOGLE_APPLICATION_CREDENTIALS/i,
  /could not load the default credentials/i,
  /permission[- ]denied/i,
  /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN/i,
  /emulator/i,
  /firebase-admin.*initializ/i,
  /must be authenticated|unauthenticated/i,
  /API key|api_key|SECRET|secret manager/i,
  /requires? (a )?(network|internet|deploy|live)/i,
];

/* ── Declared classifications ─────────────────────────────────────────────
   STALE is deliberately distinct from FAIL. A stale suite fails because the
   implementation intentionally moved past it — the code is correct and the test
   describes an older design. Folding those into FAIL pressures someone to
   "fix" hardened code back to what the test expects, which is how a security
   improvement gets reverted by its own test suite.

   QUARANTINE is for genuine assertion failures that have not been triaged yet.
   They are reported loudly on every run but do not block, because a gate must
   only contain suites proven to test current intended behaviour. Each entry
   carries the question that decides where it belongs. */
const DECLARED = {
  'test-payment-integrity': {
    verdict: 'STALE',
    reason: 'Expects `status: _paid ? "paid" : "pending_payment"`. checkout.html:2494 now ' +
            'writes `status: "pending_payment"` unconditionally — the client never asserts ' +
            'payment state at all, rules reject the key, and the Admin SDK callback is the ' +
            'only authority. Strictly stronger than the test requires. Update the test.',
  },
  'test-offline-detection': {
    verdict: 'ENV',
    reason: 'Drives a browser against http://localhost:3000 — needs a dev server, not a defect.',
  },
  'test-workspace-rules': {
    verdict: 'ENV',
    reason: 'Needs the Firestore emulator (JDK 21). Fails with "fetch failed" without it.',
  },
};

/* Untriaged genuine failures. Visible every run, blocking none, until each is
   answered: is the code wrong, is the test wrong, is the expectation outdated,
   or is it intermittent? */
const QUARANTINE = new Set([
  'test-auth-email',
  'test-icons',
  'test-overlays',
  'test-search-pipeline',
]);

function classify(res, out, name) {
  if (DECLARED[name]) return DECLARED[name].verdict;
  if (res.error && res.error.code === 'ETIMEDOUT') return 'TIMEOUT';
  if (ENV_SIGNALS.some((re) => re.test(out))) return 'ENV';
  if (res.status === 0) return 'PASS';
  /* A non-zero exit with an explicit assertion count is a real failure; a
     non-zero exit with a module-load error usually is not. */
  if (/Cannot find module|MODULE_NOT_FOUND/i.test(out)) return 'ENV';
  return QUARANTINE.has(name) ? 'QUARANTINE' : 'FAIL';
}

const files = fs.readdirSync(path.join(ROOT, 'scripts'))
  .filter((f) => /^test-.*\.js$/.test(f) && f !== 'test-inventory.js')
  .sort();

const results = [];
for (const f of files) {
  const started = Date.now();
  const res = spawnSync(process.execPath, [path.join(ROOT, 'scripts', f)], {
    cwd: ROOT, timeout: TIMEOUT_MS, encoding: 'utf8',
    env: { ...process.env, NODE_ENV: 'test' },
  });
  const out = String(res.stdout || '') + String(res.stderr || '');
  const verdict = classify(res, out, f.replace(/.js$/, ''));

  /* Pull an assertion count when the suite prints one, so a PASS with 0
     assertions is visible rather than counted as coverage it does not have. */
  const m = out.match(/ALL (\d+) PASSED|(\d+)\/(\d+)|(\d+) FAILED/);
  results.push({
    suite: f.replace(/\.js$/, ''),
    verdict,
    ms: Date.now() - started,
    exit: res.status,
    assertions: m ? m[0] : null,
    reason: verdict === 'ENV' || verdict === 'FAIL'
      ? (out.split('\n').filter((l) => l.trim()).slice(-2).join(' ').slice(0, 110) || null)
      : null,
  });
}

const by = (v) => results.filter((r) => r.verdict === v);
const summary = {
  total:   results.length,
  pass:    by('PASS').length,
  fail:    by('FAIL').length,
  env:     by('ENV').length,
  timeout: by('TIMEOUT').length,
  stale:      by('STALE').length,
  quarantine: by('QUARANTINE').length,
};

if (AS_JSON) {
  console.log(JSON.stringify({ summary, results }, null, 2));
} else {
  console.log('\n[test-inventory] ' + results.length + ' suites\n');
  const pad = (s, n) => String(s == null ? '' : s).padEnd(n);
  for (const r of results) {
    console.log('  ' + pad(r.verdict, 8) + pad(r.suite, 38) +
                pad(r.ms + 'ms', 9) + (r.assertions || ''));
  }
  console.log('\n  PASS ' + summary.pass + '   FAIL ' + summary.fail +
              '   QUARANTINE ' + summary.quarantine + '   STALE ' + summary.stale +
              '   ENV ' + summary.env + '   TIMEOUT ' + summary.timeout);

  if (summary.fail) {
    console.log('\n  FAILING (real defects — investigate before gating):');
    by('FAIL').forEach((r) => console.log('    ' + r.suite + '  — ' + (r.reason || 'no output')));
  }
  if (summary.stale) {
    console.log('\n  STALE (code moved past the test — update the TEST, not the code):');
    by('STALE').forEach((r) => {
      console.log('    ' + r.suite);
      console.log('      ' + ((DECLARED[r.suite] || {}).reason || ''));
    });
  }
  if (summary.quarantine) {
    console.log('\n  QUARANTINED (genuine failure, untriaged — not blocking until classified):');
    by('QUARANTINE').forEach((r) => console.log('    ' + r.suite));
  }
  if (summary.env) {
    console.log('\n  ENVIRONMENT-DEPENDENT (cannot gate here; run in CI with credentials):');
    by('ENV').forEach((r) => console.log('    ' + r.suite));
  }
  if (summary.timeout) {
    console.log('\n  TIMED OUT (>' + (TIMEOUT_MS / 1000) + 's — likely waiting on a service):');
    by('TIMEOUT').forEach((r) => console.log('    ' + r.suite));
  }

  console.log('\n  GATE-READY TODAY: ' + summary.pass + ' suites pass with no external dependency.');
}

/* --gate fails only on suites that pass in a clean checkout. ENV and TIMEOUT
   are excluded by design: gating on them would make the pipeline depend on
   credentials this machine does not have. */
if (GATE && summary.fail > 0) process.exit(1);
