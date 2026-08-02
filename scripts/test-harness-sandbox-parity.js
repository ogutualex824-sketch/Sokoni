/* Regression guard for "extract-and-eval" harness drift.
 *
 * Some suites assert shipped logic by pulling a real block out of a production
 * file and running it inside a new Function(...) sandbox. If production later
 * gains a CommonJS dependency (require/module/__dirname/…) that the sandbox
 * does not expose, the suite dies with a cryptic "ReferenceError: X is not
 * defined" and fail-closes the deploy gate. This test guards the guard: it
 * proves the drift detector works AND checks the live booking harness against
 * the current functions/booking.js block, so a newly-added import is caught
 * here with a clear message the moment it lands.
 *
 *   node scripts/test-harness-sandbox-parity.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { missingSandboxDeps, assertSandboxProvides } = require('./harness-sandbox');

let pass = 0, fail = 0;
const t = (n, v) => { v ? (pass++, console.log('  PASS  ' + n)) : (fail++, console.log('  FAIL  ' + n)); };

console.log('\n=== detector: flags a missing dependency the block uses ===');
t('require in block, none provided -> flagged',
  JSON.stringify(missingSandboxDeps("const { X } = require('./y');", [])) === JSON.stringify(['require']));
t('require in block, require provided -> clean',
  missingSandboxDeps("const { X } = require('./y');", ['require']).length === 0);
t('__dirname in block, none provided -> flagged',
  missingSandboxDeps('const p = __dirname + "/x";', []).includes('__dirname'));

console.log('\n=== detector: no false positives on ordinary JS globals ===');
/* console/process/Buffer/setTimeout are real globals inside new Function(). */
t('console/process not flagged',
  missingSandboxDeps('console.log(process.env.X); setTimeout(()=>{},1);', []).length === 0);
t("bare word 'reexports' does not trip exports probe",
  missingSandboxDeps('const reexports = 1;', []).length === 0);

console.log('\n=== assertSandboxProvides: clear, actionable failure ===');
let threw = null;
try { assertSandboxProvides("x = require('y');", [], 'demo'); } catch (e) { threw = e; }
t('throws when a dependency is missing', !!threw);
t('message names the class (HARNESS DRIFT)', !!threw && /HARNESS DRIFT/.test(threw.message));
t('message names the missing binding (require)', !!threw && /require/.test(threw.message));
t('does NOT throw when the dependency is provided', (() => {
  try { assertSandboxProvides("x = require('y');", ['require'], 'demo'); return true; }
  catch (_) { return false; }
})());

console.log('\n=== live: booking-payment-auth sandbox mirrors functions/booking.js ===');
/* Kept in sync with the parameter list in scripts/test-booking-payment-auth.js.
   If that harness changes what it provides, update this list too. */
const BOOKING_PROVIDED = ['db', 'uid', 'paymentId', 'pricingBreakdown', 'console', 'require'];
const SRC = fs.readFileSync(path.resolve('functions/booking.js'), 'utf8');
const start = SRC.indexOf('let verifiedPaymentId = null;');
const end = SRC.indexOf('/* Fetch user profile outside the transaction', start);
t('verification block still locatable in functions/booking.js', start >= 0 && end > start);
if (start >= 0 && end > start) {
  const BLOCK = SRC.slice(start, end);
  const missing = missingSandboxDeps(BLOCK, BOOKING_PROVIDED);
  t('booking harness provides every dependency the live block uses'
    + (missing.length ? ' (missing: ' + missing.join(', ') + ')' : ''),
    missing.length === 0);
}

console.log('\n' + (fail ? fail + ' FAILED of ' + (pass + fail) : 'ALL ' + pass + ' PASSED'));
process.exitCode = fail ? 1 : 0;
