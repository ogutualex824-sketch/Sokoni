/* Authorization tests for bookingCreate payment verification.
 *
 * bookingCreate previously set paymentStatus from the TRUTHINESS of a
 * client-supplied paymentId, so any authenticated caller could send
 * { paymentId: 'x' } and receive a paid booking. These tests assert the server
 * now re-derives payment state from Firestore and refuses every forgery route:
 * a made-up reference, another customer's real payment, an unpaid one, a
 * refunded one, and a genuine payment for a cheaper slot replayed against an
 * expensive one.
 *
 * The verification block is extracted from functions/booking.js and executed
 * against a stubbed Firestore, so this runs with no credentials and asserts the
 * shipped logic rather than a restatement of it.
 *
 *   node scripts/test-booking-payment-auth.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.resolve('functions/booking.js'), 'utf8');

/* Pull the real block out of the source so the test cannot drift from it. */
const start = SRC.indexOf('let verifiedPaymentId = null;');
const end   = SRC.indexOf('/* Fetch user profile outside the transaction', start);
if (start < 0 || end < 0) {
  console.error('FAIL: could not locate the verification block in functions/booking.js');
  process.exitCode = 2;
  return;
}
const BLOCK = SRC.slice(start, end);

function run({ paymentId, payments = {}, uid = 'buyer1', total = 5000 }) {
  const db = {
    collection: () => ({
      doc: (id) => ({
        get: async () => ({ exists: Object.hasOwn(payments, id), data: () => payments[id] }),
      }),
    }),
  };
  const console_ = { warn() {}, error() {} };
  const fn = new Function('db', 'uid', 'paymentId', 'pricingBreakdown', 'console',
    `return (async () => { ${BLOCK} return { verifiedPaymentId, paymentStatus, paymentNote }; })();`);
  return fn(db, uid, paymentId, { total }, console_);
}

let pass = 0, fail = 0;
const t = (n, v) => { v ? (pass++, console.log('  PASS  ' + n)) : (fail++, console.log('  FAIL  ' + n)); };

(async () => {
  const GOOD = { status: 'COMPLETE', uid: 'buyer1', amount: 5000 };

  console.log('\n=== forgery attempts must NOT produce a paid booking ===');
  let r = await run({ paymentId: 'totally-made-up', payments: {} });
  t('invented reference rejected', r.paymentStatus === 'awaiting' && r.paymentNote === 'payment_not_found');
  t('invented reference not stored as paymentId', r.verifiedPaymentId === null);

  r = await run({ paymentId: 'p1', payments: { p1: { ...GOOD, uid: 'someone_else' } } });
  t("another customer's payment rejected", r.paymentStatus === 'awaiting' && r.paymentNote === 'ownership_mismatch');

  r = await run({ paymentId: 'p1', payments: { p1: { ...GOOD, status: 'PENDING' } } });
  t('unpaid payment rejected', r.paymentNote === 'payment_not_terminal');

  r = await run({ paymentId: 'p1', payments: { p1: { ...GOOD, status: 'REFUNDED' } } });
  t('refunded payment rejected', r.paymentNote === 'payment_reversed');

  r = await run({ paymentId: 'p1', payments: { p1: { ...GOOD, amount: 500 } }, total: 5000 });
  t('cheaper payment replayed on expensive slot rejected', r.paymentNote === 'amount_short');

  console.log('\n=== a genuine payment must still succeed (no false negative) ===');
  r = await run({ paymentId: 'p1', payments: { p1: GOOD } });
  t('valid payment accepted', r.paymentStatus === 'paid' && r.verifiedPaymentId === 'p1');

  r = await run({ paymentId: 'p1', payments: { p1: { ...GOOD, amountCents: 500000, amount: undefined } } });
  t('amountCents honoured', r.paymentStatus === 'paid');

  r = await run({ paymentId: 'p1', payments: { p1: { ...GOOD, amount: 9999 } } });
  t('overpayment accepted', r.paymentStatus === 'paid');

  console.log('\n=== no payment supplied ===');
  r = await run({ paymentId: null, payments: {} });
  t('no paymentId -> awaiting, no note', r.paymentStatus === 'awaiting' && r.paymentNote === null);

  console.log('\n' + (fail ? fail + ' FAILED of ' + (pass + fail) : 'ALL ' + pass + ' PASSED'));
  process.exitCode = fail ? 1 : 0;
})();
