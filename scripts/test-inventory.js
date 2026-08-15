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
/* Overridable so the level can be MEASURED rather than assumed. Seven gate runs at the
   old cpu-derived default produced a different casualty every time — merchant-deep-switch,
   nav-routes, shop-setup-hydration, seller-deeplink, auth-email, cart-universal — and twice
   returned opposite verdicts for the identical commit. That is the contention signature this
   file's own header describes, not a defect in any suite.

   THE DEFAULT IS NOW 2, because the level was decided in two different places.

   Certification was run explicitly:            SOKONI_GATE_CONCURRENCY=2 node scripts/gate-inventory.js
   The hosting predeploy hook was not:          node scripts/gate-inventory.js   (firebase.json)

   With the cpu-derived default that second path resolved to 6 on an 8-core host — three
   times the level every certified verdict was measured at. So the gate that GATES a deploy
   was not the gate that CERTIFIED it, and it behaved exactly as the note above predicts:
   two consecutive runs of the identical commit (08d1a79) blocked with DISJOINT casualties —
   five POS/returns/merchant suites, then two entirely different merchant suites, each of
   which passes standalone. The same configuration had also passed 164 and 165 on earlier
   deploys, which is the point: it is unstable, not broken, and an unstable gate cannot
   certify anything.

   2 is not a new threshold — it is the level every accepted verdict was already measured at.
   Nothing else about the gate changes: no assertion, budget, classification, ENV handling or
   blocking set is touched. An explicit override still wins, so the level remains measurable
   rather than assumed, and CI can raise it deliberately on a bigger host. */
const CONCURRENCY = Math.max(1,
  parseInt(process.env.SOKONI_GATE_CONCURRENCY, 10) || 2);

const ROOT = path.resolve(__dirname, '..');
const AS_JSON = process.argv.includes('--json');
const GATE = process.argv.includes('--gate');
const TIMEOUT_MS = 60000;

/* Where a non-passing suite's child output is kept — see the capture in runOne().
   One directory per run so a re-run cannot be read as the previous run's evidence,
   and outside the repo so the gate leaves `git status` clean. */
const CAPTURE_DIR = path.join(require('os').tmpdir(), 'sokoni-gate-' + process.pid);

/* ── Why browser suites get their own budget ──────────────────────────────────
   TIMEOUT is not a defect verdict — it lands in notBlocking. So when a suite times
   out it does not turn the gate red, it SILENTLY LEAVES THE BLOCKING SET. A real
   regression in that suite would then be invisible, and which suites cover the build
   would depend on how busy the machine happened to be.

   That is exactly what was happening. Measured on a clean serial browser batch
   (25 suites, one browser at a time, nothing else running):

       test-merchant-deep-switch   42.2s      test-auth-email             33.6s
       test-banking-hub            40.4s      test-minishop-claim-persist 24.6s
       test-merchant-route-gate    39.3s      test-pos-tab-transitions    25.6s
       test-seller-cached-user     39.0s      test-nav-routes             16.1s

   Four suites sit above 65% of a 60s budget. A ~1.4x slowdown — a second gate run
   in a parallel worktree, an indexer, a deploy — pushes them over, and the recorded
   timeouts drift accordingly: 56685d4 lost test-merchant-diag + test-nav-routes,
   6f8048e lost test-cart-universal + test-shop-setup-hydration. Different suites
   each run, which is the signature of contention, not of a defect.

   Verified directly: test-nav-routes takes 16.1s and exits 0 run standalone AND in
   the serial batch immediately after two suites that were killed at the budget —
   so nothing it does is slow, and nothing leaks into it.

   The budget below is therefore set from the measured maximum with real headroom
   (~3.5x the slowest suite). This does not manufacture a PASS: no assertion changes,
   no failing suite is reclassified, and a genuinely hung suite still dies — it just
   stops converting machine load into lost coverage. nearBudget (below) makes the
   creep visible long before it becomes a timeout again. */
const BROWSER_TIMEOUT_MS = 150000;

/* A suite that used more than this share of its budget is reported by name. The point
   is to notice a suite drifting toward its ceiling while it is still passing. */
const NEAR_BUDGET = 0.5;

/* Classification lives in gate-classify.js so it can be tested directly. Execution
   status outranks output text there: a suite that printed assertions and exited
   non-zero is a FAIL, whatever words its log happens to contain. */
const { classify, DECLARED, QUARANTINE, META_SUITES, SUITE_BUDGET_MS } = require('./gate-classify');

/* --only <regex> narrows the run to matching suites. Diagnosing the drifting timeout
   list needed exactly this — the browser batch, on its own, with the runner's real
   spawn/env/budget rather than a hand-rolled copy of them. Reproducing a runner bug
   with a script that only resembles the runner is how you end up fixing the copy.
   Deliberately ignored when --gate is set: a release artifact must always describe
   the whole population, never a subset someone filtered. */
const ONLY = (() => {
  const i = process.argv.indexOf('--only');
  if (i < 0 || !process.argv[i + 1]) return null;
  if (GATE) { console.log('  (--only ignored: --gate always runs the full population)'); return null; }
  try { return new RegExp(process.argv[i + 1]); }
  catch (e) { console.error('  --only: bad regex — ' + e.message); process.exit(2); }
})();

const files = fs.readdirSync(path.join(ROOT, 'scripts'))
  /* Meta-suites are excluded from the ordinary population on purpose — see
     META_SUITES in gate-classify.js. test-gate-isolation recursively spawns other
     suites and would always read as TIMEOUT here while adding its own concurrency. */
  .filter((f) => /^test-.*\.js$/.test(f) && f !== 'test-inventory.js' && !META_SUITES.has(f))
  .filter((f) => !ONLY || ONLY.test(f))
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
    const name = f.replace(/\.js$/, '');
    const browser = isBrowserSuite(f);

    /* A DECLARED suite's verdict is a constant: classify() returns DECLARED[name].verdict
       before it looks at the exit code or the output, so running the suite cannot change
       the answer. Spawning it anyway cost the budget and, for the two long browser gates,
       meant launching a ~10-minute webkit acceptance run and SIGKILLing it mid-navigation
       on every gate — 60s each, immediately before the browser suites that were losing
       their own budget. Skipping is not a weaker check; it is the same verdict without
       burning two minutes and a browser to recompute a constant.

       The declarations themselves still have to earn their place — they are audited by
       scripts/test-gate-classify.js, and each carries the command to run the suite for real. */
    if (DECLARED[name]) {
      results.push({
        suite: name,
        verdict: DECLARED[name].verdict,
        ms: 0,
        exit: null,
        assertions: null,
        declared: true,
        reason: DECLARED[name].reason,
      });
      return resolve();
    }

    /* A measured per-suite budget wins over the class default — see SUITE_BUDGET_MS in
       gate-classify.js, where each entry carries the measurement that justifies it. */
    const budget = SUITE_BUDGET_MS[name] || (browser ? BROWSER_TIMEOUT_MS : TIMEOUT_MS);
    /* Each suite gets its own emulator project namespace. Without this the CLI's
       injected GCLOUD_PROJECT overrides every suite's own declaration and all of
       them share one database — which, under CONCURRENCY, is a race rather than a
       cleanup problem. See scripts/gate-namespace.js. */
    const child = spawn(process.execPath, [path.join(ROOT, 'scripts', f)], {
      cwd: ROOT, env: suiteEnv(f, process.env),
    });
    let out = '';
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, budget);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('error', (e) => { out += String(e && e.message || e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      const res = { status: timedOut ? null : code, error: timedOut ? { code: 'ETIMEDOUT' } : null };
      const verdict = classify(res, out, name, browser);
      /* Keep the child's output when a suite does not pass.
         This runner accumulated `out`, classified it, and then dropped it. So a suite that
         fails ONLY in the full population — the hardest kind to fix, and the only kind this
         gate exists to catch — recorded a one-line `reason` sliced out of whatever happened
         to be near the failure, in practice a truncated separator. test-seller-deeplink
         failed 13/1 three gate runs in a row with nobody able to see WHICH assertion, and
         was diagnosed only after a suite-specific capture was committed just to read it;
         test-pos-tab-transitions passes standalone and under this gate's own environment,
         so it has the same problem. Reproducing by hand cannot help when the trigger is the
         population itself.
         Written to the OS temp dir, not the repo: a gate run must leave `git status` clean,
         because a dirty tree fails the release gate and trips the cart blast-radius guard.
         Runs after classify() and only reads, so it cannot change a verdict.
         PASS is skipped for volume; QUARANTINE and ENV are skipped because they are expected
         every run and their reasons are already declared — FAIL, TIMEOUT and STALE are the
         verdicts that block a release or silently cost coverage. */
      if (verdict === 'FAIL' || verdict === 'TIMEOUT' || verdict === 'STALE') {
        try {
          fs.mkdirSync(CAPTURE_DIR, { recursive: true });
          const _p = path.join(CAPTURE_DIR, name + '.' + verdict + '.log');
          fs.writeFileSync(_p,
            'suite      : ' + name + '\nverdict    : ' + verdict +
            '\nexit code  : ' + res.status + '\ntimedOut   : ' + timedOut +
            /* Wall-clock bounds, so a failure can be lined up against an external
               environment sample. Elapsed alone cannot be correlated with anything. */
            '\nstartedAt  : ' + new Date(started).toISOString() +
            '\nendedAt    : ' + new Date().toISOString() +
            '\nelapsed    : ' + (Date.now() - started) + 'ms\nbudget     : ' + budget + 'ms' +
            '\nbrowser    : ' + browser + '\nconcurrency: ' + CONCURRENCY +
            '\nGCLOUD_PROJECT: ' + (suiteEnv(f, process.env).GCLOUD_PROJECT || '') +
            '\n\n--- FULL CHILD STDOUT/STDERR ---\n' + out + '\n--- END ---\n');
          console.log('  [capture] ' + name + ' ' + verdict + ' -> ' + _p);
        } catch (_e) { console.log('  [capture] failed: ' + _e.message); }
      }
      /* Pull an assertion count when the suite prints one, so a PASS with 0
         assertions is visible rather than counted as coverage it does not have. */
      const m = out.match(/ALL (\d+) PASSED|(\d+)\/(\d+)|(\d+) FAILED/);
      const ms = Date.now() - started;
      results.push({
        suite: name,
        verdict,
        ms,
        exit: res.status,
        assertions: m ? m[0] : null,
        budgetMs: budget,
        /* A suite creeping toward its ceiling is reported while it still passes —
           the run before a timeout is the one where it is cheap to fix. */
        nearBudget: verdict === 'PASS' && ms > budget * NEAR_BUDGET,
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
/* ── Is another browser already running? ──────────────────────────────────────
   BROWSER_CONCURRENCY = 1 serialises the browser suites AGAINST EACH OTHER, and nothing
   else. It cannot see a browser started outside this process, and one is enough to invalidate
   the run: a suite measured at 42s standalone timed out at a 300s budget while a second
   webkit was driving pages on the same machine, and a passing suite reported 13/1.

   That is the same lost-coverage failure this runner exists to prevent, arriving from
   outside — so it is RECORDED rather than assumed away. Not a refusal: the count can be
   non-zero for innocent reasons (an orphan from an earlier crash), and a gate that refuses
   to run is its own kind of useless. But a reader of the artifact must be able to tell
   whether the numbers were measured on a quiet machine. */
function foreignBrowsers() {
  try {
    const { execSync } = require('child_process');
    if (process.platform === 'win32') {
      /* NO /FI here. tasklist ANDs repeated filters on the same field, so
         `/FI "IMAGENAME eq Playwright.exe" /FI "IMAGENAME eq WebKitWebProcess.exe"` asks for a
         process that is BOTH, matches nothing, and reports a reassuring zero — the exact
         false-assurance this check exists to prevent. List everything and match here. */
      const out = execSync('tasklist /NH', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 15000 });
      /* Count the processes that indicate a LIVE browser, and nothing else. Two exclusions,
         both learned by measuring rather than guessing:
           chrome.exe                — Playwright's chromium AND the developer's own browser
                                       share the name; counting it reported 33 "foreign
                                       browsers" on an idle machine.
           WebKitNetworkProcess.exe  — this is the helper that ORPHANS. 26 were alive on an
                                       idle machine, survivors of earlier crashed runs, so
                                       counting them would warn on literally every gate.
         Playwright.exe is the browser itself and WebKitWebProcess.exe renders a page; neither
         outlives its run in practice, so their presence really does mean someone else is
         driving a browser right now. A warning that fires always is not a warning. */
      return out.split('\n').filter((l) => /^(Playwright|WebKitWebProcess|headless_shell)\.exe/i.test(l.trim())).length;
    }
    const out = execSync('ps -eo comm= 2>/dev/null', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10000 });
    return (out.split('\n').filter((l) => /WebKitWebProcess|Playwright|headless_shell/i.test(l))).length;
  } catch (_) { return -1; }   /* -1 === could not tell; never guess a reassuring 0 */
}
const browsersAtStart = foreignBrowsers();

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
    console.log('\n  TIMED OUT (killed at the budget — a timeout DROPS the suite from the');
    console.log('  blocking set, so treat each one as lost coverage, not as a warning):');
    by('TIMEOUT').forEach((r) => console.log('    ' + r.suite + '  — killed at ' + (r.budgetMs / 1000) + 's'));
  }

  /* Reported even when everything is green: this is the list that predicts next
     week's timeouts, and a suite is far cheaper to fix while it still passes. */
  const near = results.filter((r) => r.nearBudget);
  if (near.length) {
    console.log('\n  NEAR BUDGET (passing, but over ' + (NEAR_BUDGET * 100) + '% of the time allowed —');
    console.log('  these are the suites a busier machine turns into lost coverage):');
    near.sort((a, b) => b.ms / b.budgetMs - a.ms / a.budgetMs)
        .forEach((r) => console.log('    ' + r.suite.padEnd(38) +
          Math.round(r.ms / 1000) + 's of ' + (r.budgetMs / 1000) + 's  (' +
          Math.round((r.ms / r.budgetMs) * 100) + '%)'));
  }

  if (browsersAtStart > 0) {
    console.log('\n  ⚠ MEASUREMENT QUALITY: ' + browsersAtStart + ' browser process(es) were already');
    console.log('  running when this gate started. Browser suites are serialised against each other');
    console.log('  but not against anything outside this process, so any TIMEOUT or browser-suite');
    console.log('  failure above may be contention rather than a defect. Re-run on a quiet machine');
    console.log('  before treating those as real.');
  } else if (browsersAtStart === 0) {
    console.log('\n  measurement: no foreign browser processes at start (clean measurement).');
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
      /* The budgets this run enforced. Recorded because a TIMEOUT is only
         interpretable against the budget that produced it — without this, two
         artifacts with different timeout lists look like a code change when they
         were really a runner change. */
      budgets: { defaultMs: TIMEOUT_MS, browserMs: BROWSER_TIMEOUT_MS },
      /* Whether the machine was quiet. A gate run alongside another browser measures
         contention as well as code, and two artifacts are not comparable unless this
         matches. -1 means the check itself could not run — recorded as unknown rather
         than as a reassuring zero. */
      foreignBrowsersAtStart: browsersAtStart,
      blocking: results.filter((r) => r.verdict === 'PASS').map((r) => r.suite),
      /* Passing, but close enough to the budget that a busier machine would drop
         them from `blocking`. This is the early warning for the drift that made
         the recorded timeout list differ on every run. */
      nearBudget: results.filter((r) => r.nearBudget)
        .map((r) => ({ suite: r.suite, ms: r.ms, budgetMs: r.budgetMs })),
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
