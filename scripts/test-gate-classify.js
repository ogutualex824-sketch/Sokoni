#!/usr/bin/env node
/* ══════════════════════════════════════════════════════════════════════════════
   GATE CLASSIFICATION SEMANTICS
   ------------------------------------------------------------------------------
   The gate used to test output text BEFORE the exit code, so a printed word decided
   the verdict. Measured on a clean emulator-backed run, that mislabelled:

     · test-seller-products      exit 1, "23 passed, 2 failed"  → ENV
     · test-pos-tab-transitions  exit 1, "3 passed, 1 failed"   → ENV
     · 14 suites that exited 0   → ENV, because they PRINT the words they test

   A real failure must never become ENV because its log contains "permission-denied".

   These are pure unit tests over classify() — no emulator, no network, no spawning.
   Section F is the mutation control: it re-implements the OLD precedence and asserts
   the very cases below come out WRONG under it. Without that, this file could pass
   against a classifier that had quietly reverted.

     node scripts/test-gate-classify.js
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';

const { classify, executed, ENV_SIGNALS, QUARANTINE, DECLARED, META_SUITES } = require('./gate-classify');
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

let pass = 0, fail = 0;
/* Shorter than this suite's runner budget (150000ms) ON PURPOSE. Without one, a hang is
   SIGKILLed by the runner and recorded as TIMEOUT -- not a defect verdict -- so the suite leaves
   the blocking set silently. Measured cost of this suite is far below the value chosen, so this
   fires only when the runner was going to kill it anyway. */
const _wd = setTimeout(() => { console.log('\n  WATCHDOG — suite exceeded 135s'); process.exit(1); }, 135000);
/* unref: the watchdog must never be the reason the process stays alive. A suite that
   finishes normally exits immediately; one that is genuinely stuck still has a live event
   loop, so the timer still fires and self-reports instead of being SIGKILLed silently. */
if (_wd && _wd.unref) _wd.unref();
const failures = [];
const ok = (label, cond, detail) => {
  if (cond) { pass++; console.log('  PASS  ' + label); return true; }
  fail++; failures.push(label + (detail ? '  → ' + detail : ''));
  console.log('  FAIL  ' + label + (detail ? '   → ' + detail : ''));
  return false;
};
const head = (t) => console.log('\n\x1b[1m' + t + '\x1b[0m');

const exit = (n) => ({ status: n, error: null });
const timeout = { status: null, error: { code: 'ETIMEDOUT' } };

/* Real output shapes, copied from the suites this defect actually mislabelled. */
const SELLER_PRODUCTS_OUT =
  '  FAIL  seller cannot read another seller\'s products   [permission-denied expected]\n' +
  '  23 passed, 2 failed\n';
const POS_TABS_OUT =
  'booting the POS against the emulator\n' +
  '  3 passed, 1 failed\n';
const ADMIN_CLAIM_OUT =
  '  PASS  a request without a token is unauthenticated\n' +
  '  32 passed, 0 failed\n';
const NEVER_RAN_OUT =
  'Error: connect ECONNREFUSED 127.0.0.1:8080\n' +
  '    at TCPConnectWrap.afterConnect\n';
const MODULE_MISSING_OUT = "Error: Cannot find module 'firebase-admin'\n";

(function run() {
  console.log('\nGATE CLASSIFICATION — execution status outranks output text\n' + '='.repeat(66));

  /* ══ A. the five required cases ══ */
  head('A · required cases');
  ok('exit 0 + ENV-looking output → PASS',
     classify(exit(0), ADMIN_CLAIM_OUT, 'test-admin-claim', false) === 'PASS',
     classify(exit(0), ADMIN_CLAIM_OUT, 'test-admin-claim', false));
  ok('exit 1 + ENV-looking output → FAIL',
     classify(exit(1), SELLER_PRODUCTS_OUT, 'test-seller-products', false) === 'FAIL',
     classify(exit(1), SELLER_PRODUCTS_OUT, 'test-seller-products', false));
  ok('genuine environment failure (never executed) → ENV',
     classify(exit(1), NEVER_RAN_OUT, 'test-something', false) === 'ENV',
     classify(exit(1), NEVER_RAN_OUT, 'test-something', false));
  ok('explicit DECLARED → its declared verdict',
     classify(exit(1), 'anything at all', 'test-returns-rules', false) === 'ENV');
  ok('explicit QUARANTINE → QUARANTINE',
     classify(exit(1), '  4 passed, 1 failed\n', 'test-icons', false) === 'QUARANTINE',
     classify(exit(1), '  4 passed, 1 failed\n', 'test-icons', false));

  /* ══ B. the two suites the old order actually hid ══ */
  head('B · the suites the old precedence mislabelled');
  ok('test-seller-products (23 passed, 2 failed) is FAIL, not ENV',
     classify(exit(1), SELLER_PRODUCTS_OUT, 'test-seller-products', false) === 'FAIL');
  ok('test-pos-tab-transitions (3 passed, 1 failed) is FAIL, not ENV',
     classify(exit(1), POS_TABS_OUT, 'test-pos-tab-transitions', false) === 'FAIL',
     classify(exit(1), POS_TABS_OUT, 'test-pos-tab-transitions', false));
  ok('...even though both logs DO match an ENV signal',
     ENV_SIGNALS.some((re) => re.test(SELLER_PRODUCTS_OUT)) &&
     ENV_SIGNALS.some((re) => re.test(POS_TABS_OUT)));

  /* ══ C. every ENV_SIGNAL word is powerless against a reported failure ══ */
  head('C · no printed word can overrule a reported failure');
  const WORDS = ['permission-denied', 'emulator', 'unauthenticated', 'API key',
                 'GOOGLE_APPLICATION_CREDENTIALS', 'ECONNREFUSED',
                 'could not load the default credentials', 'requires a network'];
  let overruled = [];
  WORDS.forEach((w) => {
    const out = w + '\n  10 passed, 1 failed\n';
    if (classify(exit(1), out, 'test-x', false) !== 'FAIL') overruled.push(w);
  });
  ok('all ' + WORDS.length + ' env words still yield FAIL when assertions were reported',
     overruled.length === 0, 'overruled by: ' + overruled.join(', '));
  let downgraded = [];
  WORDS.forEach((w) => {
    const out = w + '\n  ALL 12 PASSED\n';
    if (classify(exit(0), out, 'test-x', false) !== 'PASS') downgraded.push(w);
  });
  ok('...and PASS when the suite exited 0', downgraded.length === 0,
     'downgraded by: ' + downgraded.join(', '));

  /* ══ D. ENV keeps its real job ══ */
  head('D · ENV_SIGNALS retains its purpose for suites that never ran');
  ok('module-load failure → ENV',
     classify(exit(1), MODULE_MISSING_OUT, 'test-x', false) === 'ENV');
  ok('connection refused with no assertions → ENV',
     classify(exit(2), NEVER_RAN_OUT, 'test-x', false) === 'ENV');
  ok('a browser suite that died without reporting → ENV',
     classify(exit(1), 'page crashed\n', 'test-x', true) === 'ENV');
  ok('...but a browser suite that DID report is FAIL',
     classify(exit(1), 'page crashed\n  2 passed, 3 failed\n', 'test-x', true) === 'FAIL');
  ok('TIMEOUT outranks everything except a declaration',
     classify(timeout, ADMIN_CLAIM_OUT, 'test-x', false) === 'TIMEOUT');
  ok('DECLARED outranks a non-zero exit',
     classify(exit(1), NEVER_RAN_OUT, 'test-workspace-rules', false) === 'ENV');
  /* Two DECLARED entries exist BECAUSE they cannot fit the 60s budget — their written
     reason is "this runner would only ever report it as TIMEOUT". If TIMEOUT won, the
     declaration would be discarded and the gate would re-report the very thing the
     entry was added to explain. Measured: reordering these flipped both to TIMEOUT. */
  ok('DECLARED outranks TIMEOUT (test-merchant-visual-gate stays ENV)',
     classify(timeout, '', 'test-merchant-visual-gate', true) === 'ENV',
     classify(timeout, '', 'test-merchant-visual-gate', true));
  ok('DECLARED outranks TIMEOUT (test-minishop-claim-persistence stays ENV)',
     classify(timeout, '', 'test-minishop-claim-persistence', true) === 'ENV',
     classify(timeout, '', 'test-minishop-claim-persistence', true));

  /* ══ E. execution evidence ══ */
  head('E · execution evidence recognises the shapes suites really print');
  [['ALL 33 PASSED', true], ['  23 passed, 2 failed', true], ['PASSED:  28', true],
   ['FAILED:  0', true], ['  PASS  something', true], ['gate isolation: 24/24', true],
   ['SMS static analysis PASSED (11 checks)', true],
   ['Error: connect ECONNREFUSED', false], ['', false],
   ['    at TCPConnectWrap.afterConnect (node:net:1637:16)', false]].forEach(([s, want]) => {
    ok('executed(' + JSON.stringify(s.slice(0, 34)) + ') === ' + want, executed(s) === want);
  });

  /* ══ F. MUTATION CONTROL ══
     Re-implement the OLD precedence and assert these same cases come out wrong.
     If this section stops failing under the old order, the tests above are vacuous. */
  head('F · MUTATION CONTROL — the old precedence must break these cases');
  function classifyOld(res, out, name) {
    if (res.error && res.error.code === 'ETIMEDOUT') return 'TIMEOUT';
    if (DECLARED[name]) return DECLARED[name].verdict;
    if (ENV_SIGNALS.some((re) => re.test(out))) return 'ENV';   /* text before status */
    if (res.status === 0) return 'PASS';
    return QUARANTINE.has(name) ? 'QUARANTINE' : 'FAIL';
  }
  const oldSeller = classifyOld(exit(1), SELLER_PRODUCTS_OUT, 'test-seller-products');
  const oldTabs = classifyOld(exit(1), POS_TABS_OUT, 'test-pos-tab-transitions');
  const oldAdmin = classifyOld(exit(0), ADMIN_CLAIM_OUT, 'test-admin-claim');
  console.log('    old order → seller-products=' + oldSeller +
              '  pos-tab-transitions=' + oldTabs + '  admin-claim=' + oldAdmin);
  ok('old order hides the seller-products failure as ENV', oldSeller === 'ENV', oldSeller);
  ok('old order hides the pos-tab-transitions failure as ENV', oldTabs === 'ENV', oldTabs);
  ok('old order hides a PASSING suite as ENV', oldAdmin === 'ENV', oldAdmin);
  ok('the new order disagrees with the old on all three',
     classify(exit(1), SELLER_PRODUCTS_OUT, 'test-seller-products', false) !== oldSeller &&
     classify(exit(1), POS_TABS_OUT, 'test-pos-tab-transitions', false) !== oldTabs &&
     classify(exit(0), ADMIN_CLAIM_OUT, 'test-admin-claim', false) !== oldAdmin);

  /* ══ G. registries unchanged ══ */
  head('G · registries were not quietly edited');
  ok('QUARANTINE still holds exactly its four untriaged suites',
     QUARANTINE.size === 4 &&
     ['test-auth-email', 'test-icons', 'test-overlays', 'test-search-pipeline']
       .every((n) => QUARANTINE.has(n)), [...QUARANTINE].join(', '));
  /* Six since 2026-08-19: test-auth-post-login-routing was quarantined for the
     subscription release — it tests fix/auth-post-login-routing, which is
     deliberately unmerged. This guard did its job and refused the addition until
     it was declared here, which is the point of it: a registry may grow, but never
     quietly. Raising this number is the ONLY sanctioned way to add an entry. */
  ok('DECLARED still holds exactly its six entries', Object.keys(DECLARED).length === 6,
     Object.keys(DECLARED).join(', '));
  ok('the quarantined suite names WHY and HOW it is removed',
     /deliberately unmerged/.test(DECLARED['test-auth-post-login-routing'].reason) &&
     /Remove by merging/.test(DECLARED['test-auth-post-login-routing'].reason));
  ok('...and it is QUARANTINE, never PASS',
     DECLARED['test-auth-post-login-routing'].verdict === 'QUARANTINE');
  ok('every DECLARED entry carries a written reason',
     Object.values(DECLARED).every((d) => d.reason && d.reason.length > 40));
  ok('neither seller-products nor pos-tab-transitions was added to either registry',
     !DECLARED['test-seller-products'] && !DECLARED['test-pos-tab-transitions'] &&
     !QUARANTINE.has('test-seller-products') && !QUARANTINE.has('test-pos-tab-transitions'));
  ok('test-gate-isolation is excluded from auto-discovery as a meta-suite',
     META_SUITES.has('test-gate-isolation.js'));

  /* ══ H. the invariant test-inventory.js relies on to SKIP declared suites ══
     The runner no longer spawns a DECLARED suite: it records the declared verdict
     and moves on. That is only sound while a declaration is genuinely independent
     of what the process does — the moment classify() consults the exit code or the
     output ahead of DECLARED, skipping execution would start reporting a verdict
     the run did not earn.

     This mattered concretely: test-merchant-visual-gate is a ~10-minute webkit
     acceptance run that was being launched and SIGKILLed at the budget on every
     gate, immediately before the browser suites that were themselves losing their
     budgets. Pin the property so the optimisation cannot outlive its justification. */
  head('H · a declaration does not depend on the run (why skipping is sound)');
  const DECLARED_INPUTS = [
    ['timed out',        timeout,             ''],
    ['exit 0, silent',   exit(0),             ''],
    ['exit 1, silent',   exit(1),             ''],
    ['exit 0, asserted', exit(0),             '  ALL 12 PASSED\n'],
    ['exit 1, asserted', exit(1),             '  2 passed, 3 failed\n'],
    ['exit 1, env text', exit(1),             'ECONNREFUSED 127.0.0.1:8080\n'],
    ['spawn error',      exit(null),          'Error: spawn ENOENT\n'],
  ];
  Object.keys(DECLARED).forEach((name) => {
    const want = DECLARED[name].verdict;
    const got = DECLARED_INPUTS.map(([, res, out]) => classify(res, out, name, true));
    const stable = got.every((v) => v === want);
    ok(name + ' → ' + want + ' for every possible run outcome', stable,
       stable ? DECLARED_INPUTS.length + ' outcomes, all ' + want
              : DECLARED_INPUTS.map(([l], i) => l + '=' + got[i]).join('  '));
  });
  /* The same property must NOT hold for an undeclared suite, or the check above
     would pass trivially against a classify() that ignored its arguments. */
  ok('an UNDECLARED suite still varies with the run (control)',
     classify(exit(0), '  ALL 3 PASSED\n', 'test-not-declared', true) === 'PASS' &&
     classify(exit(1), '  1 passed, 2 failed\n', 'test-not-declared', true) === 'FAIL' &&
     classify(timeout, '', 'test-not-declared', true) === 'TIMEOUT');

  /* ══ I. a per-suite budget must not be a way to launder a failure ══
     SUITE_BUDGET_MS exists because a TIMEOUT silently drops a suite from the blocking set,
     so a suite that genuinely needs 65s was losing its coverage to a 60s default. That is a
     legitimate fix and an obvious loophole: "give it more time" must never become "make it
     pass". A budget only decides how long a suite may run — classify() never sees it. */
  head('I · a budget changes how long a suite may run, never its verdict');
  const { SUITE_BUDGET_MS } = require('./gate-classify');
  ok('classify() takes no budget argument (it cannot be influenced by one)',
     classify.length === 4, 'arity ' + classify.length);
  Object.keys(SUITE_BUDGET_MS).forEach((name) => {
    /* A budgeted suite that exits non-zero is still FAIL, and still TIMEOUT if it is killed. */
    ok(name + ' still FAILs on a non-zero exit',
       classify(exit(1), '  40 passed, 2 failed\n', name, false) === 'FAIL',
       classify(exit(1), '  40 passed, 2 failed\n', name, false));
    ok(name + ' still TIMEOUTs when killed at its (larger) budget',
       classify(timeout, '', name, false) === 'TIMEOUT');
  });
  ok('every budgeted suite is a real file',
     Object.keys(SUITE_BUDGET_MS).every((n) => fs.existsSync(path.join(ROOT, 'scripts', n + '.js'))),
     Object.keys(SUITE_BUDGET_MS).join(', '));
  /* A budget below the class default would be a silent coverage cut wearing the same clothes. */
  ok('no budget is smaller than the 60s default it overrides',
     Object.values(SUITE_BUDGET_MS).every((ms) => ms >= 60000),
     JSON.stringify(SUITE_BUDGET_MS));

  console.log('\n' + '─'.repeat(66));
  if (fail) { console.log('\x1b[31mFAILURES\x1b[0m'); failures.forEach((f) => console.log('  ✗ ' + f)); }
  console.log((fail ? '\x1b[31m' : '\x1b[32m') + 'gate classification: ' + pass + '/' + (pass + fail) + '\x1b[0m\n');
  process.exit(fail ? 1 : 0);
})();
