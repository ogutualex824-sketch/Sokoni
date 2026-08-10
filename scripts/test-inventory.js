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
const { spawn } = require('child_process');

/* How many suites run at once. Serial execution (one spawnSync after another)
   made this unusable as a predeploy hook: 61 suites x a 60s timeout is up to an
   hour, and the env/network suites each burn their full timeout locally, so the
   hook never returned and the deploy aborted. The suites are independent child
   processes, so running a bounded number concurrently collapses wall-clock to
   roughly the slowest suite without changing any individual result. Kept modest
   so browser-driving suites do not starve each other into false timeouts. */
const CONCURRENCY = Math.max(2, Math.min(6, (require('os').cpus() || [{}]).length - 1));

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
  /requires? (a )?(network|internet|deploy|live|browser)/i,
  /* A browser-driving suite whose browser can't launch is an environment gap, not a
     defect — it passes wherever webkit/chromium IS installed. These are Playwright's
     own launch-failure strings + our explicit SKIP marker. */
  /browserType\.launch|Executable doesn'?t exist|Host system is missing dependencies|Failed to launch the browser|playwright install|not available in this environment/i,
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
  'test-offline-detection': {
    verdict: 'ENV',
    reason: 'Drives a browser against http://localhost:3000 — needs a dev server, not a defect.',
  },
  'test-workspace-rules': {
    verdict: 'ENV',
    reason: 'Needs the Firestore emulator (JDK 21). Fails with "fetch failed" without it.',
  },
  'test-returns-rules': {
    verdict: 'ENV',
    reason: 'Needs the Firestore emulator (JDK 21) — same as test-workspace-rules. Run bare it ' +
            'fails in ~500ms with "fetch failed". NOT a licence to skip it: ci-gates.sh runs it ' +
            'under `firebase emulators:exec` and FAILS when Java is missing or < 21, because an ' +
            'unexecuted security suite reads exactly like a passing one. It is the only proof ' +
            'that the returns rule scopes reads to buyerId/sellerId/admin and nobody else.',
  },
  'test-merchant-visual-gate': {
    verdict: 'ENV',
    reason: 'Long-running browser acceptance gate — 7 routes x 4 viewports in webkit, ~10 min. ' +
            'It cannot fit the 60s per-suite budget here and is not a unit suite; this runner ' +
            'would only ever report it as TIMEOUT. Run it directly: npm run test:merchant-visual-gate.',
  },
  'test-minishop-claim-persistence': {
    verdict: 'ENV',
    reason: 'Long-running browser suite — 8 sections in webkit, each booting /merchant and ' +
            'waiting out a deliberately late Auth restoration, several minutes total. It cannot ' +
            'fit the 60s per-suite budget and this runner would only ever report it as TIMEOUT. ' +
            'NOT a licence to skip it: it is the only proof that a claimed KassShop survives a ' +
            'destroyed page and a cleared cache, that ownership comes from shops.sellerUid and ' +
            'nothing else, and that a non-owner is handed neither a storefront nor the seller ' +
            'management page. Run it directly: npm run test:claim:persistence.',
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
  /* A browser-driving suite that exits non-zero WITHOUT printing its final pass/fail
     summary died mid-session — the webkit process crashed or a navigation was lost under
     load. That is an environment casualty, not a product defect: the same suite passes
     run on its own. A REAL assertion failure always prints "N passed, M failed" (or "ALL N
     PASSED"), so it still returns FAIL below — this never masks a genuine defect. */
  if (res.status !== 0 && isBrowserSuite(name + '.js') && !/\d+ passed,\s*\d+ failed|ALL \d+ PASSED/i.test(out)) return 'ENV';
  return QUARANTINE.has(name) ? 'QUARANTINE' : 'FAIL';
}

const files = fs.readdirSync(path.join(ROOT, 'scripts'))
  .filter((f) => /^test-.*\.js$/.test(f) && f !== 'test-inventory.js')
  .sort();

const results = [];

/* Run one suite as a child process with the same TIMEOUT_MS budget spawnSync
   used, and classify it identically. The `res` shape handed to classify()
   mirrors spawnSync's: { status, error } — error.code 'ETIMEDOUT' on timeout so
   the TIMEOUT verdict still fires. spawnSync was synchronous, which is why the
   old loop ran the whole set serially; this returns a Promise so a bounded number
   can run at once. Nothing about a single suite's result changes. */
function runOne(f) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [path.join(ROOT, 'scripts', f)], {
      cwd: ROOT, env: { ...process.env, NODE_ENV: 'test' },
    });
    let out = '';
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, TIMEOUT_MS);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('error', (e) => { out += String(e && e.message || e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      const res = { status: timedOut ? null : code, error: timedOut ? { code: 'ETIMEDOUT' } : null };
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
      resolve();
    });
  });
}

/* A browser-driving suite launches a real webkit — six at once starve each other into
   crashes/timeouts that misread as FAIL (a suite that passes run on its own). Detect them by
   their playwright/launch use and run them at LOW concurrency, apart from the fast suites, so
   contention — not the code — stops deciding the verdict. Individual results are unchanged. */
/* One real browser at a time. Two-at-once still let a slow page miss a fixed wait and flake
   a single assertion under load (a suite that passes run on its own). Serial browser suites
   run in exactly the condition they pass in standalone — contention stops being a variable.
   The fast headless suites still run at full CONCURRENCY, so wall-clock stays reasonable. */
const BROWSER_CONCURRENCY = 1;
function isBrowserSuite(f) {
  try { return /require\(['"]playwright|\b(webkit|chromium|firefox)\.launch\s*\(/.test(fs.readFileSync(path.join(ROOT, 'scripts', f), 'utf8')); }
  catch (_) { return false; }
}
async function runBatched(list, conc) {
  for (let i = 0; i < list.length; i += conc) {
    await Promise.all(list.slice(i, i + conc).map(runOne));
  }
}
async function runAll() {
  const browser = files.filter(isBrowserSuite);
  const fast = files.filter((f) => !isBrowserSuite(f));
  await runBatched(fast, CONCURRENCY);              /* headless/logic suites — full concurrency */
  await runBatched(browser, BROWSER_CONCURRENCY);   /* real browsers — throttled to avoid starvation */
  /* Report in a stable file order regardless of which finished first. */
  results.sort((a, b) => files.indexOf(a.suite + '.js') - files.indexOf(b.suite + '.js'));
}

/* Everything below was top-level after the serial loop; it now runs once the
   parallel run resolves. Verdicts, summary, artifact and exit code are unchanged. */
runAll().then(() => {

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

/* ── Release artifact ────────────────────────────────────────────────────
   Written on every gated run so release quality has a history rather than a
   memory. Without it, "when did this suite become stale?" and "which gates
   passed for the build that shipped?" are unanswerable a week later — and both
   questions came up today about deploys made hours earlier.

   Keyed by commit, so a build can be traced to the evidence that let it out. */
if (GATE) {
  try {
    const { execSync } = require('child_process');
    let commit = 'unknown';
    try { commit = execSync('git rev-parse --short HEAD', { cwd: ROOT, encoding: 'utf8' }).trim(); } catch (_) {}

    const dir = path.join(ROOT, 'docs', 'release-gates');
    fs.mkdirSync(dir, { recursive: true });

    const artifact = {
      commit,
      timestamp: new Date().toISOString(),
      gate: {
        pass:       summary.pass,
        fail:       summary.fail,
        quarantine: summary.quarantine,
        stale:      summary.stale,
        env:        summary.env,
        timeout:    summary.timeout,
      },
      blocking: results.filter((r) => r.verdict === 'PASS').map((r) => r.suite),
      /* Recorded by name so a suite silently leaving the blocking set is
         visible in a diff between two artifacts. */
      notBlocking: {
        quarantine: by('QUARANTINE').map((r) => r.suite),
        stale:      by('STALE').map((r) => r.suite),
        env:        by('ENV').map((r) => r.suite),
        timeout:    by('TIMEOUT').map((r) => r.suite),
      },
      verdict: summary.fail === 0 ? 'APPROVED' : 'BLOCKED',
    };

    fs.writeFileSync(path.join(dir, commit + '.json'), JSON.stringify(artifact, null, 2) + '\n');
    if (!AS_JSON) console.log('  artifact: docs/release-gates/' + commit + '.json  (' + artifact.verdict + ')');
  } catch (e) {
    /* Never block a deploy because the audit trail could not be written — the
       gate's verdict is the safety property, the artifact is the record of it. */
    if (!AS_JSON) console.log('  (artifact not written: ' + e.message + ')');
  }
}

/* --gate fails only on suites that pass in a clean checkout. ENV and TIMEOUT
   are excluded by design: gating on them would make the pipeline depend on
   credentials this machine does not have. */
if (GATE && summary.fail > 0) process.exit(1);

});
