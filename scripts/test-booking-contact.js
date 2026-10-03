#!/usr/bin/env node
/* TECH HUB SLICE 4M — calling. SOKONI has no voice / masking provider; calling is a booking-bound phone reveal, logged.
 * Executes the REAL providerContactCustomer and bookingContactProvider on an in-memory Firestore.
 *   node scripts/test-booking-contact.js        BASE=6168a5c node scripts/test-booking-contact.js */
'use strict';
const path = require('path'), fs = require('fs'), os = require('os'), { execSync } = require('child_process');
const H = require('./lib/inmem-firestore').install({ admins: ['admin1'] });
const { call } = require('./lib/inmem-firestore');
const ROOT = path.join(__dirname, '..');
let FN = path.join(ROOT, 'functions');
if (process.env.BASE) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-'));
  execSync('git archive ' + process.env.BASE + ' functions | tar -x -C "' + d.replace(/\\/g, '/') + '"', { cwd: ROOT, shell: 'bash' });
  FN = path.join(d, 'functions');
}
let pass = 0, fail = 0;
const ck = (id, ok, m, got) => { console.log('  ' + (ok ? 'PASS' : 'FAIL') + ' ' + id + ' ' + m + (ok || got === undefined ? '' : '   [got ' + JSON.stringify(got).slice(0, 240) + ']')); ok ? pass++ : fail++; };
console.log('\nBooking-bound calling (Tech Hub slice 4M)   ' + (process.env.BASE ? 'BASE=' + process.env.BASE : 'this tree') + '\n');
const { DOCS } = H;
const reveals = () => [...DOCS.entries()].filter(([k]) => k.startsWith('contactReveals/')).map(([, v]) => v);

(async () => {
  const BS = require(path.join(FN, 'booking-service.js'))._h;
  const PO = require(path.join(FN, 'provider-ops.js'))._h;
  const PD = fs.readFileSync(path.join(FN, 'provider-dispatch.js'), 'utf8');
  const seed = (paymentStatus, status) => { H.reset();
    DOCS.set('providers/prov', { uid: 'prov', name: 'Fix Ltd', phone: '+254700000001', status: 'active' });
    DOCS.set('users/cust', { phoneNumber: '+254700000009', displayName: 'Cust' });
    DOCS.set('providerBookings/b1', { providerId: 'prov', customerUid: 'cust', customerName: 'Cust', status, paymentStatus }); };

  if (!BS.bookingContactProvider) { ck('C-0', false, 'bookingContactProvider exists'); return done(); }
  seed('pending', 'pending');
  let r = await call(BS.bookingContactProvider, 'cust', { bookingId: 'b1' });
  ck('C-1', r.code === 'failed-precondition' && reveals().length === 0, 'an UNPAID hold reveals no provider phone (no harvesting by creating holds)', r);

  seed('paid_held', 'pending');
  r = await call(BS.bookingContactProvider, 'cust', { bookingId: 'b1' });
  const rv = reveals();
  ck('C-2', !!r.ok && r.ok.provider.phone === '+254700000001' && rv.length === 1 && rv[0].byRole === 'customer' && rv[0].target === 'prov',
    'the booking\'s customer gets the provider\'s phone once PAID, and the reveal is logged', { r: r.ok || r, rv });

  seed('paid_held', 'confirmed');
  r = await call(BS.bookingContactProvider, 'stranger', { bookingId: 'b1' });
  ck('C-3', r.code === 'permission-denied' && reveals().length === 0, 'a stranger gets nothing and nothing is logged', r);

  seed('pending', 'pending');
  r = await call(PO.providerContactCustomer, 'prov', { bookingId: 'b1' });
  const rv2 = reveals();
  const x = await call(PO.providerContactCustomer, 'other', { bookingId: 'b1' });
  ck('C-4', !!r.ok && r.ok.customer.phone === '+254700000009' && rv2.length === 1 && rv2[0].byRole === 'provider' && x.code === 'permission-denied',
    'the provider of the booking reaches the customer (logged); another provider is refused', { r: r.ok || r, rv2, other: x.code });

  ck('C-5', PD.includes("'bookingContactProvider'"), 'bookingContactProvider is a providerDispatch route');
  done();
})().catch((e) => { console.log('CRASH (no verdict): ' + (e && e.stack || e)); process.exit(2); });
function done() { console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed'); process.exit(fail ? 1 : 0); }
