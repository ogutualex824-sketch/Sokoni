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
const { suiteEnv } = require('./gate-namespace');

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

/* Classification lives in gate-classify.js so it can be tested directly. Execution
   status outranks output text there: a suite that printed assertions and exited
   non-zero is a FAIL, whatever words its log happens to contain. */
const { classify, DECLARED, QUARANTINE, META_SUITES } = require('./gate-classify');

const files = fs.readdirSync(path.join(ROOT, 'scripts'))
  /* Meta-suites are excluded from the ordinary population on purpose — see
     META_SUITES in gate-classify.js. test-gate-isolation recursively spawns other
     suites and would always read as TIMEOUT here while adding its own concurrency. */
  .filter((f) => /^test-.*\.js$/.test(f) && f !== 'test-inventory.js' && !META_SUITES.has(f))
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
    /* Each suite gets its own emulator project namespace. Without this the CLI's
       injected GCLOUD_PROJECT overrides every suite's own declaration and all of
       them share one database — which, under CONCURRENCY, is a race rather than a
       cleanup problem. See scripts/gate-namespace.js. */
    const child = spawn(process.execPath, [path.join(ROOT, 'scripts', f)], {
      cwd: ROOT, env: suiteEnv(f, process.env),
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
      const verdict = classify(res, out, f.replace(/.js$/, ''), isBrowserSuite(f));
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
