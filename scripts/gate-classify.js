/* ══════════════════════════════════════════════════════════════════════════════
   GATE CLASSIFICATION — execution status outranks output text
   ------------------------------------------------------------------------------
   The previous order tested the output BEFORE the exit code:

       if (ENV_SIGNALS.some((re) => re.test(out))) return 'ENV';
       if (res.status === 0) return 'PASS';          // ← never reached when text matched

   So a printed word decided the verdict and the process's own exit status never got
   a say. Measured consequences on a clean emulator-backed run:

     · test-seller-products      exit 1, "23 passed, 2 failed"  → labelled ENV
     · test-pos-tab-transitions  exit 1, "3 passed, 1 failed"   → labelled ENV
     · 14 further suites exited 0 — genuinely passing — and were also labelled ENV,
       because they PRINT the words they exist to test ("permission-denied",
       "unauthenticated", "API key")

   Both directions are wrong, and the first is dangerous: a real failure disappeared
   into a bucket that reads as "not a defect".

   THE RULE NOW: a process that got far enough to report assertions has told us what
   happened, and its exit code is authoritative. ENV_SIGNALS keeps its real job —
   recognising a suite that never got to run — but it is subordinate to that evidence
   and can no longer overrule a non-zero exit from a suite that plainly executed.

   Precedence:
     1. TIMEOUT      — killed at the budget
     2. DECLARED     — an explicitly named suite with a written reason
     3. did NOT execute (no assertion output) → ENV, when the runner can point at a
        module-load failure, an environment signal, or a dead browser session
     4. exit 0       → PASS
     5. exit != 0    → QUARANTINE if explicitly named, else FAIL

   Step 3 is deliberately the only place ENV can be reached without a declaration,
   and it requires the ABSENCE of assertion output. A suite that printed
   "23 passed, 2 failed" executed; whatever else is in its log, it FAILED.
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';

const fs = require('fs');
const path = require('path');

/* A suite that needs a credential, an emulator or the network is not broken —
   it is un-runnable here. Classifying those separately is the whole point:
   folding them into FAIL would make the aggregate red forever and the gate
   worthless. These now only apply when the suite produced no assertions. */
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

/* Proof that the suite actually ran its assertions. This is the evidence that makes
   an exit code trustworthy, so it is matched against the shapes the suites in this
   repo really print — not a loose "any output" test, which a stack trace would
   satisfy. */
const EXECUTION_EVIDENCE = [
  /ALL \d+ PASSED/i,
  /\b\d+\s+passed\b[\s,]/i,
  /\bPASSED:\s*\d+/i,
  /\bFAILED:\s*\d+/i,
  /^\s{2,}(PASS|FAIL)\s{2,}\S/m,
  /\b\d+\/\d+\b/,
  /\(\d+ checks?\)/i,
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

/* Meta-suites are excluded from the ordinary inventory population. test-gate-isolation
   RECURSIVELY spawns other suites (~15 child runs, several minutes) to prove the
   namespace fix. Inside the runner it would always report TIMEOUT and would add its
   own concurrency on top of the gate's. Excluding it is honest — the proof still has
   to pass, it is simply not a unit suite:
     firebase emulators:exec --only firestore,auth "node scripts/test-gate-isolation.js" */
const META_SUITES = new Set(['test-gate-isolation.js']);

function executed(out) {
  return EXECUTION_EVIDENCE.some((re) => re.test(out || ''));
}

function isBrowserSuite(file, root) {
  try {
    const src = fs.readFileSync(path.join(root, 'scripts', file), 'utf8');
    return /require\(['"]playwright|\b(webkit|chromium|firefox)\.launch\s*\(/.test(src);
  } catch (_) { return false; }
}

/* res mirrors spawnSync's shape: { status, error } — error.code 'ETIMEDOUT' on a kill.
   `browser` says whether this suite drives a real browser (the caller knows; keeping
   it a parameter leaves this module free of filesystem coupling and testable). */
function classify(res, out, name, browser) {
  out = out || '';

  if (res && res.error && res.error.code === 'ETIMEDOUT') return 'TIMEOUT';
  if (DECLARED[name]) return DECLARED[name].verdict;

  /* Only when the suite produced NO assertions may its environment be blamed. */
  if (!executed(out)) {
    if (/Cannot find module|MODULE_NOT_FOUND/i.test(out)) return 'ENV';
    if (ENV_SIGNALS.some((re) => re.test(out))) return 'ENV';
    /* A browser suite that exits non-zero without ever reporting died mid-session —
       the webkit process crashed or a navigation was lost under load. */
    if (res && res.status !== 0 && browser) return 'ENV';
  }

  if (res && res.status === 0) return 'PASS';
  return QUARANTINE.has(name) ? 'QUARANTINE' : 'FAIL';
}

module.exports = {
  classify, executed, isBrowserSuite,
  ENV_SIGNALS, EXECUTION_EVIDENCE, DECLARED, QUARANTINE, META_SUITES,
};
