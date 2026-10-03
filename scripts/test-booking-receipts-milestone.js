#!/usr/bin/env node
/* BOOKING RECEIPTS — Work/Job Engine milestone identity (b2 WE2, sokoni-2f receipt contract 87ce8eb).
 * Executes the REAL functions/shared/booking-receipts.js paid() hook in-process with a recording receipts module, and its
 * pure _ident. A work_milestone booking → kind 'service_booking' (sourceId = bookingId, so receipt-reconciliation's
 * service_booking_<id> still matches), subtype 'work_milestone', links {bookingId, workProjectId, milestoneId}; ordinary
 * bookings and quote bookings are unchanged.
 *   node scripts/test-booking-receipts-milestone.js */
'use strict';
const path = require('path'), Module = require('module');
const H = require('./lib/inmem-firestore').install({ admins: ['admin1'] });
let pass = 0, fail = 0;
const ck = (id, ok, m, got) => { console.log('  ' + (ok ? 'PASS' : 'FAIL') + ' ' + id + ' ' + m + (ok || got === undefined ? '' : '   [got ' + JSON.stringify(got).slice(0, 300) + ']')); ok ? pass++ : fail++; };
console.log('\nBooking receipts — work_milestone identity\n');

/* a recording stand-in for the RECEIPT STORE only (transaction-receipts.js is sokoni-2f's; its subtype allowlist is tested there) */
const recorded = [];
const REC = { recordPaid: async (db, args) => { recorded.push(args); return { ok: true }; }, recordEvent: async () => ({ ok: true }), receiptIdFor: (k, s) => k + '_' + s,
  safely: async (db, label, fn) => fn() };
const origLoad = Module._load;
Module._load = function (req, parent) { if (/transaction-receipts(\.js)?$/.test(req)) return REC; return origLoad.apply(this, arguments); };

(async () => {
  const BR = require(path.join(__dirname, '..', 'functions', 'shared', 'booking-receipts.js'));
  const m = BR._ident('wm_P1_m1_2', { kind: 'work_milestone', workProjectId: 'P1', milestoneId: 'm1', leadId: 'L1' });
  const o = BR._ident('b9', { price: 1 }), q = BR._ident('b8', { leadId: 'L7' });
  ck('R1', m.kind === 'service_booking' && m.sourceId === 'wm_P1_m1_2' && m.subtype === 'work_milestone' && m.links.workProjectId === 'P1' && m.links.milestoneId === 'm1' && m.links.bookingId === 'wm_P1_m1_2',
    'a milestone booking → service_booking receipt keyed on the booking id, subtype work_milestone, project + milestone links (a leadId never turns it into a quote receipt)', m);
  ck('R2', o.kind === 'service_booking' && !o.subtype && q.kind === 'quote' && q.sourceId === 'L7' && !q.subtype, 'ordinary and quote bookings are unchanged (no subtype)', { o, q });

  H.DOCS.set('providerBookings/wm_P1_m1_2', { kind: 'work_milestone', workProjectId: 'P1', milestoneId: 'm1', providerId: 'mk', customerUid: 'cust', service: 'Month 1', price: 2000000, fee: 0, paymentStatus: 'paid_held' });
  H.DOCS.set('payments/API1', { invoiceId: 'INV1', providerMethod: 'M-PESA' });
  const r = await BR.paid(H.db, 'wm_P1_m1_2', 'API1');
  const a = recorded[0] || {};
  ck('R3', r && r.ok !== false && a.kind === 'service_booking' && a.subtype === 'work_milestone' && a.links && a.links.workProjectId === 'P1' && a.paidCents === 2000000 && a.method === 'M-PESA' && a.clientUid === 'cust' && a.counterpartyId === 'mk',
    'the REAL paid() hook records ONE receipt for the milestone: subtype + links passed through, amount from the booking, the actual IntaSend method', a);
  console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); console.log('\nRESULT: ' + pass + ' passed, ' + (fail + 1) + ' failed'); process.exit(1); });
