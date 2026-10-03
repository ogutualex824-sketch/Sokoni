#!/usr/bin/env node
'use strict';
require('./lib/net-firewall').install();   /* money suite: FAIL CLOSED on any call to a payment host (b2 2026-10-04) */
/* Provider money view (functions/provider-ledger.js) — read-only projection for b2's merchant-v2 provider screens
     L1  available = wallet balance (shillings); pending = paid_held bookings only (incl. a work milestone), with links
     L2  totals come from the caller's PROVIDER receipts only (counterpartyId) — a receipt where they are the CLIENT is excluded
     L3  entries newest first with booking/payment links; payouts are the caller's own, newest first
     L4  no wallet doc → a KNOWN 0 (nothing credited yet); an UNREADABLE source → null + reason, never 0
     L5  read-only: the projection writes nothing
     L6  eligibility is stated by the server (min KES 100) and names the frozen request path; nobody else's data leaks
   NODE_PATH=<functions/node_modules> node scripts/test-provider-ledger.js */
const path = require('path');
const FN = path.join(path.resolve(__dirname, '..'), 'functions');
let pass = 0, fail = 0;
const ck = (l, ok, d) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (ok || d === undefined ? '' : '  -> ' + JSON.stringify(d).slice(0, 260))); ok ? pass++ : fail++; };
let NO_INDEX = false;
function fakeDb (docs, broken) {
  let writes = 0;
  const snap = (k) => ({ id: k.split('/').pop(), exists: docs.has(k), data: () => docs.get(k) && JSON.parse(JSON.stringify(docs.get(k))) });
  const q = (c, f) => ({ where: (fld, op, v) => q(c, f.concat([[fld, v]])), limit: () => q(c, f),
    orderBy: () => { if (NO_INDEX) { const e = new Error('FAILED_PRECONDITION: The query requires an index'); e.code = 9; throw e; } return q(c, f); },
    get: async () => { if (broken === c) throw new Error('PERMISSION_DENIED'); return { docs: [...docs.keys()].filter((k) => k.startsWith(c + '/') && k.split('/').length === 2 && f.every(([fld, v]) => (docs.get(k) || {})[fld] === v)).map(snap) }; } });
  return { writes: () => writes, collection: (c) => Object.assign({ doc: (id) => ({ get: async () => { if (broken === c) throw new Error('PERMISSION_DENIED'); return snap(c + '/' + id); },
    set: async () => { writes++; }, update: async () => { writes++; } }) }, q(c, [])) };
}
const L = require(path.join(FN, 'provider-ledger.js'));
const D = () => new Map([
  ['wallets/p1', { balance: 1234 }],
  ['providerBookings/b1', { providerId: 'p1', paymentStatus: 'paid_held', price: 500000, fee: 0, service: 'Logo' }],
  ['providerBookings/wm1', { providerId: 'p1', paymentStatus: 'paid_held', kind: 'work_milestone', price: 2000000, fee: 0, workProjectId: 'P1', milestoneId: 'm1' }],
  ['providerBookings/b2', { providerId: 'p1', paymentStatus: 'settled', price: 900000 }],
  ['providerBookings/x1', { providerId: 'p2', paymentStatus: 'paid_held', price: 777700 }],
  ['transactionReceipts/r1', { counterpartyId: 'p1', clientUid: 'c1', paidCents: 1000000, platformFeeCents: 100000, providerNetCents: 900000, releasedCents: 1000000, refundedCents: 0, heldCents: 0 }],
  ['transactionReceipts/r2', { counterpartyId: 'p1', clientUid: 'c2', paidCents: 500000, platformFeeCents: 0, providerNetCents: 0, releasedCents: 0, refundedCents: 200000, heldCents: 300000, deductionsCents: 20000 }],
  ['transactionReceipts/r3', { counterpartyId: 'z', clientUid: 'p1', paidCents: 999900 }],
  ['walletTransactions/t1', { uid: 'p1', type: 'service_booking_earning', amount: 9000, bookingId: 'b2', paymentRef: 'API_1', createdAt: 1000 }],
  ['walletTransactions/t2', { uid: 'p1', type: 'venue_booking_earning', amount: 50, bookingId: 'VB1', paymentRef: 'VB-VB1', createdAt: 3000 }],
  ['walletTransactions/t3', { uid: 'p2', type: 'x', amount: 1, createdAt: 9999 }],
  ['payoutRequests/q1', { sellerUid: 'p1', amount: 500, status: 'paid', createdAt: 2000 }],
  ['payoutRequests/q2', { sellerUid: 'p2', amount: 7, status: 'paid', createdAt: 5000 }],
]);

(async () => {
  const db = fakeDb(D());
  const r = await L.ledgerFor(db, 'p1');
  ck('L1 available = 1234 KES; pending = the 2 paid_held bookings (25,000) incl. the work milestone with its links; settled + other providers excluded',
    r.availableKES === 1234 && r.pending.count === 2 && r.pending.amountCents === 2500000 && r.pending.bookings.some((b) => b.kind === 'work_milestone' && b.workProjectId === 'P1' && b.milestoneId === 'm1'), r.pending);
  ck('L2 totals from PROVIDER receipts only: gross 15,000, fee 1,000, net 9,000, refunded 2,000, deductions 200, held 3,000 (the client-side receipt excluded)',
    r.totals.grossCents === 1500000 && r.totals.platformFeeCents === 100000 && r.totals.providerNetCents === 900000 && r.totals.refundedCents === 200000
    && r.totals.deductionsCents === 20000 && r.totals.heldCents === 300000 && r.totals.source === 'transactionReceipts' && r.totals.window.truncated === false, r.totals);
  ck('L3 entries newest first with links; payouts are the caller\'s own', r.entries.map((e) => e.id).join() === 't2,t1' && r.entries[0].bookingId === 'VB1' && r.entries[0].paymentRef === 'VB-VB1'
    && r.payouts.length === 1 && r.payouts[0].id === 'q1', { e: r.entries, p: r.payouts });
  const d2 = D(); d2.delete('wallets/p1');
  const r2 = await L.ledgerFor(fakeDb(d2), 'p1');
  const r3 = await L.ledgerFor(fakeDb(D(), 'wallets'), 'p1');
  const r4 = await L.ledgerFor(fakeDb(D(), 'transactionReceipts'), 'p1');
  ck('L4 no wallet doc → known 0; unreadable wallet → null + reason (eligibility null); unreadable receipts → totals null, never 0',
    r2.availableKES === 0 && r3.availableKES === null && r3.reasons.includes('wallet_unreadable') && r3.payoutEligibility === null && r4.totals === null && r4.reasons.includes('receipts_unreadable') && r4.availableKES === 1234);
  ck('L5 the projection writes nothing', db.writes() === 0);
  ck('L6 eligibility stated by the server (min 100, eligible at 1234) naming the frozen request path; no other provider\'s data present',
    r.payoutEligibility.eligible === true && r.payoutEligibility.minimumKES === 100 && r.payoutEligibility.requestPath === 'requestSellerPayout'
    && !JSON.stringify(r).includes('777700') && !JSON.stringify(r).includes('9999') && !JSON.stringify(r).includes('q2'));
  NO_INDEX = true;
  const r5 = await L.ledgerFor(fakeDb(D()), 'p1');
  ck('L7 walletTransactions index not built yet → falls back (still newest first), never fails the screen', r5.entries && r5.entries.map((e) => e.id).join() === 't2,t1' && !r5.reasons.length, r5.reasons);
  NO_INDEX = false;
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('CRASH', e && e.stack); process.exit(1); });
