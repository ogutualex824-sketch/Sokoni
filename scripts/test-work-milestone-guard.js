#!/usr/bin/env node
'use strict';
require('./lib/net-firewall').install();   /* money suite: FAIL CLOSED on any call to a payment host (b2 2026-10-04) */
/* Work/Job Engine milestone refund guard on the commercial line (ported from sokoni-b2 a1234da; review by sokoni-2f)
     G1  a PAID (paid_held) work_milestone: customer cancel / provider cancel / decline / no-show → WORK_MILESTONE_HELD, booking untouched
     G2  an UNPAID work_milestone can still be cancelled (the guard only bites once money is held)
     G3  an ordinary paid service booking is NOT affected by the guard (no kind) — its existing policy still applies
   Executes the REAL functions/provider-ops.js against scripts/lib/inmem-firestore.js (byte-identical with b2's line).
   NODE_PATH=<functions/node_modules> node scripts/test-work-milestone-guard.js */
const path = require('path');
const FN = path.join(path.resolve(__dirname, '..'), 'functions');
const H = require('./lib/inmem-firestore').install({ admins: ['admin1'] });
const { call } = require('./lib/inmem-firestore');
const { DOCS } = H;
let pass = 0, fail = 0;
const ck = (id, ok, m, got) => { console.log('  ' + (ok ? 'PASS' : 'FAIL') + ' ' + id + ' ' + m + (ok || got === undefined ? '' : '   [got ' + JSON.stringify(got).slice(0, 300) + ']')); ok ? pass++ : fail++; };
const PO = require(path.join(FN, 'provider-ops.js'))._h;
const base = (over) => Object.assign({ providerId: 'mk', customerUid: 'cust', kind: 'work_milestone', workProjectId: 'P1', milestoneId: 'm1', workCommissionCategory: 'marketing_services',
  price: 2000000, fee: 0, deposit: 0, status: 'confirmed', paymentStatus: 'paid_held' }, over || {});
const B = (id) => DOCS.get('providerBookings/' + id);

(async () => {
  H.reset();
  ['mk', 'cust'].forEach((u) => DOCS.set('users/' + u, { displayName: u }));
  DOCS.set('providerBookings/wm1', base());
  const r = [await call(PO.providerCancelBooking, 'cust', { bookingId: 'wm1' }), await call(PO.providerCancelBooking, 'mk', { bookingId: 'wm1' }),
    await call(PO.providerDeclineBooking, 'mk', { bookingId: 'wm1' }), await call(PO.providerMarkNoShow, 'mk', { bookingId: 'wm1' })];
  ck('G1', r.every((x) => x.det && x.det.code === 'WORK_MILESTONE_HELD') && B('wm1').status === 'confirmed' && B('wm1').paymentStatus === 'paid_held',
    'paid milestone: customer cancel / provider cancel / decline / no-show all refused WORK_MILESTONE_HELD; booking untouched', r.map((x) => x.det || x.code || x.ok));
  DOCS.set('providerBookings/wm2', base({ paymentStatus: 'pending' }));
  const u = await call(PO.providerCancelBooking, 'cust', { bookingId: 'wm2' });
  ck('G2', !(u.det && u.det.code === 'WORK_MILESTONE_HELD') && B('wm2').status === 'cancelled', 'an unpaid milestone can still be cancelled', u);
  DOCS.set('providerBookings/sb1', base({ kind: undefined, workProjectId: undefined, milestoneId: undefined }));
  const o = await call(PO.providerDeclineBooking, 'mk', { bookingId: 'sb1' });
  ck('G3', !(o.det && o.det.code === 'WORK_MILESTONE_HELD'), 'an ordinary paid service booking is not caught by the milestone guard', o);
  console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('CRASH', e && e.stack); process.exit(1); });
