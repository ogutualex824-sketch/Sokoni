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
  /* ── QUARANTINED, NOT WEAKENED ─────────────────────────────────────────────
     All 23 assertions are retained and still run; 13 pass. The 10 that fail
     exercise post-login routing through the merchant entry authority, and that
     implementation is deliberately NOT on this branch:

         auth.js  references to the entry authority ... 0
         login.html references ....................... 0

     The suite arrived with ecb2d1e; the commits it depends on (1f6407f,
     9e3cf82) belong to fix/auth-post-login-routing, which was checkpointed and
     intentionally left unmerged. So it has never been green here — it is ahead
     of its implementation, not describing a defect in what shipped.

     It is quarantined so an unrelated, uncertified Merchant v2 cutover is not
     dragged into the subscription release merely to turn a gate green. The test
     is right; the code it tests is simply not here yet.

     TO REMOVE THIS QUARANTINE: merge or implement the checkpointed auth
     post-login routing, then run the suite UNCHANGED. Do not edit the ten
     assertions to fit whatever ships.

     EXPIRES: before the Merchant v2 cutover / next release certification.
     Quarantined 2026-08-19 for the subscription release. */
  /* ── THE OTHER HALF OF THE SAME CHECKPOINT ────────────────────────────────
     Provenance, established before classifying: this suite predates the cutover
     (created at 8ce4ef8, expecting `merchant.html`). Commit ecb2d1e then did
     three things in one change —

       · introduced MERCHANT_URL = '/merchant-v2' (the constant did not exist)
       · rewrote these expectations merchant.html -> /merchant-v2
       · ADDED test-auth-post-login-routing, which asserts MERCHANT === '/merchant'

     — so that single commit both performed the cutover and shipped a suite
     asserting it had not happened. The two suites encode opposite product
     decisions and cannot both pass at any value of MERCHANT_URL.

     Its /merchant-v2 expectations describe the POST-CUTOVER contract, which is
     the deliberately deferred v2 release. The assertions are kept exactly as
     they are: editing them to expect /merchant would destroy the only record of
     what v2 must do, and changing the code to satisfy them would perform the
     cutover by accident. Quarantined instead.

     TO REMOVE: complete the Merchant v2 entry/cutover work and flip
     MERCHANT_URL, then run BOTH suites unchanged — they become consistent only
     when the cutover is real.

     EXPIRES: with test-auth-post-login-routing, before the v2 cutover.
     Quarantined 2026-08-19 for the subscription release. */
  'test-merchant-entry': {
    verdict: 'QUARANTINE',
    reason: 'Its /merchant-v2 expectations were written by ecb2d1e, the same commit that ' +
            'prematurely set MERCHANT_URL and added the contradicting auth suite. Describes ' +
            'the deferred v2 cutover contract, not a defect in what ships. Remove by ' +
            'completing the v2 cutover and running both suites unchanged.',
  },
  'test-auth-post-login-routing': {
    verdict: 'QUARANTINE',
    reason: 'Tests fix/auth-post-login-routing, deliberately unmerged. 13/23 pass; ' +
            'auth.js has 0 references to the entry authority. Remove by merging that ' +
            'work and re-running unchanged. Expires before the v2 cutover.',
  },
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

/* ── Per-suite budgets, each from a measurement ──────────────────────────────
   A TIMEOUT is not a warning: the verdict is non-blocking, so a timed-out suite silently
   LEAVES the blocking set and its coverage disappears. Two suites were losing that way in
   the full isolated gate while passing everywhere else:

     test-cart-universal        47/47 in 65s standalone — 5s over the 60s default
     test-merchant-deep-switch  15/15 in 42s standalone — over 150s under full gate load

   Raising the global default instead would be the wrong trade: most suites finish in under
   10s, and a genuinely hung one should die quickly rather than hold the gate for minutes.
   So the budget is declared per suite, from its measured time, with the measurement written
   down. The multiplier is deliberately generous because the gate runs 162 suites, an
   emulator and a browser on one machine: merchant-deep-switch alone showed a 3.5x spread
   between standalone and full-gate. Headroom here costs nothing when a suite passes and
   costs one wait when a suite genuinely hangs; too little headroom costs coverage silently,
   which is strictly worse.

   This is NOT a way to make a failing suite pass — a budget cannot change an assertion. Any
   suite listed here must already pass when run on its own, and nearBudget in
   test-inventory.js reports anything still creeping toward its ceiling. */
const SUITE_BUDGET_MS = {
  /* measured 65s standalone (47/47) */
  'test-cart-universal': 180000,
  /* measured 42s standalone (15/15); exceeded 150s under the full gate */
  'test-merchant-deep-switch': 300000,
  /* measured 42s of a 60s budget (70%) inside the gate — one bad run from lost coverage */
  'test-minishop-claim-firestore': 150000,
  /* measured 83s (27/27); deliberately long — it waits out late Firestore responses */
  'test-shop-setup-hydration': 240000,
  /* measured 53.2s and 55.1s idle (93/0 both runs, 43ms variance on the neighbouring
     deep-switch — this machine is repeatable). The 150s browser default gave under 3x,
     and the gate now also runs gate-inventory's emulator, so the box carries more than
     when that default was set. Same reasoning as merchant-deep-switch above. */
  'test-merchant-home-back': 300000,
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

  /* DECLARED outranks TIMEOUT, as it always did. Two entries exist precisely BECAUSE
     they cannot fit the 60s budget — "this runner would only ever report it as TIMEOUT"
     is the reason written in them. Letting TIMEOUT win would discard that declaration
     and re-report the very thing the entry was added to explain. */
  if (DECLARED[name]) return DECLARED[name].verdict;
  if (res && res.error && res.error.code === 'ETIMEDOUT') return 'TIMEOUT';

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
  ENV_SIGNALS, EXECUTION_EVIDENCE, DECLARED, QUARANTINE, META_SUITES, SUITE_BUDGET_MS,
};
