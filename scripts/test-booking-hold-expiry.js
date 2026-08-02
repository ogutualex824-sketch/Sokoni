/* Unit tests for the service-booking hold-expiry decision (P2/P3/P4 hold lifecycle).
 *
 * isExpired() is the pure predicate the every-1-min sweep applies transactionally to
 * release abandoned pre-payment holds. It must:
 *   - expire an unpaid `pending` booking once its `expiresAt` (5-min hold) has passed,
 *   - keep it while the hold window is still open,
 *   - never touch a paid/settled/refunded booking or a non-pending one,
 *   - fall back to createdAt + 15-min TTL for legacy bookings written before `expiresAt`.
 *
 *   node scripts/test-booking-hold-expiry.js
 */
'use strict';
const path = require('path');
const { isExpired } = require(path.resolve('functions/booking-payment-sweep.js'));

/* Firestore Timestamp stub: only .toMillis() is used by isExpired. */
const ts = (ms) => ({ toMillis: () => ms });
const NOW = 1_700_000_000_000;        /* fixed clock — Date.now() is never called by isExpired */
const MIN = 60 * 1000;

let pass = 0, fail = 0;
const t = (n, v) => { v ? (pass++, console.log('  PASS  ' + n)) : (fail++, console.log('  FAIL  ' + n)); };

console.log('\n=== explicit expiresAt hold window (5 min) ===');
t('unpaid pending, expiresAt 1min PAST -> expired',
  isExpired({ status: 'pending', paymentStatus: 'pending', expiresAt: ts(NOW - MIN) }, NOW) === true);
t('unpaid pending, expiresAt exactly now -> expired',
  isExpired({ status: 'pending', paymentStatus: 'pending', expiresAt: ts(NOW) }, NOW) === true);
t('unpaid pending, expiresAt 1min FUTURE -> not expired',
  isExpired({ status: 'pending', paymentStatus: 'pending', expiresAt: ts(NOW + MIN) }, NOW) === false);

console.log('\n=== paid / terminal bookings are never swept ===');
t('paid_held with past expiresAt -> not expired',
  isExpired({ status: 'pending', paymentStatus: 'paid_held', expiresAt: ts(NOW - MIN) }, NOW) === false);
t('settled -> not expired',
  isExpired({ status: 'confirmed', paymentStatus: 'settled', expiresAt: ts(NOW - MIN) }, NOW) === false);
t('cancelled (non-pending status) -> not expired',
  isExpired({ status: 'cancelled', paymentStatus: 'pending', expiresAt: ts(NOW - MIN) }, NOW) === false);

console.log('\n=== autoConfirm-unpaid holds (Slice 3): a confirmed booking that still owes payment IS swept ===');
t('confirmed + unpaid + price>0 + expired -> expired',
  isExpired({ status: 'confirmed', paymentStatus: 'pending', price: 5000, expiresAt: ts(NOW - MIN) }, NOW) === true);
t('confirmed + unpaid + price>0 + not yet expired -> not expired',
  isExpired({ status: 'confirmed', paymentStatus: 'pending', price: 5000, expiresAt: ts(NOW + MIN) }, NOW) === false);
t('confirmed + unpaid + FREE (price 0) -> not expired (nothing to pay)',
  isExpired({ status: 'confirmed', paymentStatus: 'pending', price: 0, expiresAt: ts(NOW - MIN) }, NOW) === false);
t('confirmed + unpaid + no price field -> not expired (not a payable hold)',
  isExpired({ status: 'confirmed', paymentStatus: 'pending', expiresAt: ts(NOW - MIN) }, NOW) === false);

console.log('\n=== legacy fallback: no expiresAt -> createdAt + 15-min TTL ===');
t('legacy unpaid pending, createdAt 16min ago -> expired',
  isExpired({ status: 'pending', paymentStatus: 'pending', createdAt: ts(NOW - 16 * MIN) }, NOW) === true);
t('legacy unpaid pending, createdAt 5min ago -> not expired (15-min TTL)',
  isExpired({ status: 'pending', paymentStatus: 'pending', createdAt: ts(NOW - 5 * MIN) }, NOW) === false);
t('expiresAt takes precedence over createdAt when both present',
  isExpired({ status: 'pending', paymentStatus: 'pending', expiresAt: ts(NOW + MIN), createdAt: ts(NOW - 60 * MIN) }, NOW) === false);

console.log('\n=== defensive ===');
t('null booking -> not expired', isExpired(null, NOW) === false);
t('no timestamps at all -> not expired', isExpired({ status: 'pending', paymentStatus: 'pending' }, NOW) === false);

console.log('\n' + (fail ? fail + ' FAILED of ' + (pass + fail) : 'ALL ' + pass + ' PASSED'));
process.exitCode = fail ? 1 : 0;
