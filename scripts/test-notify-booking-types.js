/* Regression guard: every notification type the booking flow passes to notify() must be
 * registered in notify.js TYPES. An UNregistered type makes notify() throw
 * "Unknown notification type", and booking callers wrap it in .catch() — so the
 * notification vanishes silently (this is exactly why providers were never pinged when a
 * booking was paid). This test fails loudly if a booking notify type is missing.
 *
 *   node scripts/test-notify-booking-types.js
 */
'use strict';
const path = require('path');
const fs = require('fs');
const admin = require(path.resolve('functions/node_modules/firebase-admin'));
try { admin.initializeApp({ projectId: 'sokoni-test' }); } catch (_) { /* already */ }
const { TYPES } = require(path.resolve('functions/notify.js'));

let pass = 0, fail = 0;
const t = (n, v) => { v ? (pass++, console.log('  PASS  ' + n)) : (fail++, console.log('  FAIL  ' + n)); };

console.log('\n=== booking notification types are registered ===');
['booking_new', 'booking_paid', 'booking_refund', 'booking_released'].forEach((ty) => {
  t(`TYPES has "${ty}"`, !!TYPES[ty] && typeof TYPES[ty].category === 'string' && typeof TYPES[ty].priority === 'string');
});

console.log('\n=== every notify({type:...}) in the booking payment/release path resolves to a registered type ===');
/* Scan the files that call notify() in the booking flow and extract the type literal from
   each notify(...) call, then assert it is registered. Catches a future caller adding an
   unregistered type. (Deliberately matches notify( calls only, not bookingEvent types.) */
const files = ['functions/booking-payment-sweep.js', 'functions/booking-service.js'];
const seen = new Set();
for (const f of files) {
  const src = fs.readFileSync(path.resolve(f), 'utf8');
  const re = /notify\(\s*\{[^}]*?type:\s*'([^']+)'/g;
  let m;
  while ((m = re.exec(src)) !== null) seen.add(m[1]);
}
if (!seen.size) console.log('  (no notify() calls found to scan)');
[...seen].forEach((ty) => t(`notify type "${ty}" is registered`, !!TYPES[ty]));

console.log('\n=== notify() exposes the awaitDelivery seam (durable write vs background delivery) ===');
const notifySrc = fs.readFileSync(path.resolve('functions/notify.js'), 'utf8');
t('awaitDelivery param exists', /awaitDelivery\s*=\s*true/.test(notifySrc));
t('background delivery path exists', /runDelivery\(\)\.catch/.test(notifySrc));

console.log('\n' + (fail ? fail + ' FAILED of ' + (pass + fail) : 'ALL ' + pass + ' PASSED'));
process.exitCode = fail ? 1 : 0;
