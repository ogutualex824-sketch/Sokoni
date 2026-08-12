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

let pass = 0, fail = 0;
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
  ok('DECLARED still holds exactly its five entries', Object.keys(DECLARED).length === 5,
     Object.keys(DECLARED).join(', '));
  ok('every DECLARED entry carries a written reason',
     Object.values(DECLARED).every((d) => d.reason && d.reason.length > 40));
  ok('neither seller-products nor pos-tab-transitions was added to either registry',
     !DECLARED['test-seller-products'] && !DECLARED['test-pos-tab-transitions'] &&
     !QUARANTINE.has('test-seller-products') && !QUARANTINE.has('test-pos-tab-transitions'));
  ok('test-gate-isolation is excluded from auto-discovery as a meta-suite',
     META_SUITES.has('test-gate-isolation.js'));

  console.log('\n' + '─'.repeat(66));
  if (fail) { console.log('\x1b[31mFAILURES\x1b[0m'); failures.forEach((f) => console.log('  ✗ ' + f)); }
  console.log((fail ? '\x1b[31m' : '\x1b[32m') + 'gate classification: ' + pass + '/' + (pass + fail) + '\x1b[0m\n');
  process.exit(fail ? 1 : 0);
})();
