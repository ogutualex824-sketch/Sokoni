#!/usr/bin/env node
'use strict';
/* Rental payments — webhook half (rental-payment-hold.js). In-memory store with a transaction; IntaSend confirmation injected. */
const fs = require('fs'); const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const RH = require(path.join(ROOT, 'functions', 'rental-payment-hold.js'));
let pass = 0, fail = 0;
const ck = (id, ok, msg, got) => { console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + id + '  ' + msg + (ok ? '' : '  got=' + JSON.stringify(got))); ok ? pass++ : fail++; };

let D = {};
const clone = (o) => (o === undefined ? undefined : JSON.parse(JSON.stringify(o)));
const apply = (k, d, merge) => { const out = Object.assign({}, merge && D[k] ? D[k] : {}); for (const [f, v] of Object.entries(d)) out[f] = v && v.__ts ? 'TS' : v; D[k] = out; };
const ref = (c, id) => ({ _k: c + '/' + id, get: async () => ({ exists: (c + '/' + id) in D, data: () => clone(D[c + '/' + id]) }),
  set: async (d, o) => apply(c + '/' + id, d, o && o.merge), update: async (d) => apply(c + '/' + id, d, true),
  collection: (sub) => ({ doc: (sid) => ref(c + '/' + id + '/' + sub, sid) }) });
let RECEIPT_FAILS = false;
const db = { collection: (c) => ({ doc: (id) => ref(c, id), add: async (d) => { const k = c + '/auto' + Object.keys(D).length; apply(k, d, false); return { id: k }; } }),
  runTransaction: async (fn) => { const w = []; const r = await fn({ get: (x) => x.get(), update: (x, d) => w.push(() => apply(x._k, d, true)), set: (x, d, o) => w.push(() => apply(x._k, d, o && o.merge)),
    create: (x, d) => w.push(() => { if (RECEIPT_FAILS && /^transactionReceipts\//.test(x._k)) throw new Error('receipt store down'); if (x._k in D) throw new Error('ALREADY_EXISTS'); apply(x._k, d, false); }) }); w.forEach((f) => f()); return r; } };
const adminSdk = { firestore: { FieldValue: { serverTimestamp: () => ({ __ts: true }) } } };
const OK = async () => ({ ok: true });
const RCPT = { nextNumber: async () => 'RCT-TEST-1', serverTs: () => 'TS' };   /* receipt numbering injected (financial-engine in prod) */
const seed = (bk, intentX) => { D = {
  'paymentIntents/RENT-b1': Object.assign({ resourceType: 'rentalBooking', resourceId: 'b1', amountCents: 650000, currency: 'KES', uid: 'renter1', metadata: { type: 'rental_booking', bookingId: 'b1', depositCents: 200000 } }, intentX || {}),
  'rentalBookings/b1': Object.assign({ buyerId: 'renter1', shopId: 's1', status: 'payment_pending', paymentStatus: 'unpaid' }, bk || {}) }; };
const hold = (o) => RH.holdRentalBookingPayment(db, adminSdk, Object.assign({ apiRef: 'API1', intentRef: 'RENT-b1', grossAmount: 6500, providerMethod: 'M-PESA', invoiceId: 'INV-9', confirm: OK, receiptDeps: RCPT }, o || {}));
const B = () => D['rentalBookings/b1'] || {};

(async () => {
  seed(); let r = await hold();
  ck('R-1', r.outcome === 'held' && B().status === 'paid_held' && B().paymentStatus === 'held' && B().heldAmountCents === 650000 && B().depositCents === 200000 && B().paymentRef === 'API1' && B().intentRef === 'RENT-b1' && B().invoiceId === 'INV-9' && B().providerMethod === 'M-PESA'
    && D['paymentIntents/RENT-b1'].status === 'paid', 'an exact, IntaSend-confirmed payment HOLDS the rental (paid_held/held, rent + deposit, ref, method)', [r, B()]);
  r = await hold();
  ck('R-2', r.outcome === 'noop' && B().status === 'paid_held', 'a replayed callback is a no-op', r);
  const RC = D['transactionReceipts/rental_booking_b1'] || {};
  ck('R-2r', RC.kind === 'rental_booking' && RC.paidCents === 650000 && RC.heldCents === 650000 && RC.clientUid === 'renter1' && RC.paymentRef === 'API1' && RC.providerRef === 'INV-9' && RC.method === 'M-PESA'
    && D['transactionReceipts/rental_booking_b1/events/paid_API1'] && Object.keys(D).filter((k) => /^transactionReceipts\/[^/]+$/.test(k)).length === 1,
    'the hold records ONE rental_booking receipt (paid = held = rent + deposit, IntaSend invoice + method) — f3\'s release event needs it', RC);
  seed(); RECEIPT_FAILS = true; r = await hold(); RECEIPT_FAILS = false;
  ck('R-2f', r.outcome === 'held' && B().paymentStatus === 'held' && r.receipt && r.receipt.reason === 'queued_for_retry' && Object.keys(D).some((k) => k.startsWith('transactionReceiptFailures/') || /Failures\//.test(k)),
    'a receipt failure never undoes the hold — it is queued for retry', [r, Object.keys(D)]);
  seed({ status: 'cancelled' }); r = await hold();
  ck('R-2n', !D['transactionReceipts/rental_booking_b1'], 'a refund_due payment (dead rental) gets NO paid receipt', Object.keys(D));
  for (const st of ['accepted', 'confirmed']) { seed({ status: st }); r = await hold(); ck('R-3 ' + st, r.outcome === 'held', 'a ' + st + ' rental (2f PAYABLE) is held', r); }

  seed(); r = await hold({ grossAmount: 1 });
  ck('R-4', r.outcome === 'parked' && r.reason === 'amount_mismatch' && B().paymentStatus === 'unpaid' && D['commissionReviewQueue/rental_amount_mismatch_API1'], 'KES 1 for a KES 6,500 rental → PARKED, never held', [r, B()]);
  seed(); r = await hold({ grossAmount: 65000 });
  ck('R-5', r.outcome === 'parked' && B().paymentStatus === 'unpaid', 'OVERPAYMENT is not exact either → parked', r);
  seed(); r = await hold({ confirm: async () => ({ ok: false, reason: 'provider_not_complete' }) });
  ck('R-6', r.outcome === 'parked' && r.reason === 'provider_not_complete' && B().paymentStatus === 'unpaid', 'IntaSend does not confirm → parked (the callback body is a claim)', r);
  seed(); r = await hold({ confirm: async () => { throw new Error('ECONNRESET'); } });
  ck('R-7', r.outcome === 'parked' && r.reason === 'provider_unreachable', 'IntaSend unreachable → parked, never held', r);
  seed({}, { uid: 'someoneElse' }); r = await hold();
  ck('R-8', r.outcome === 'parked' && r.reason === 'payer_not_renter' && B().paymentStatus === 'unpaid', 'a payer who is not the renter → parked', r);
  seed({}, { amountCents: undefined }); r = await hold();
  ck('R-9', r.outcome === 'parked' && r.reason === 'missing_evidence', 'an intent with no server amount → parked (no fallback)', r);

  for (const st of ['cancelled', 'declined', 'refunded', 'completed']) {
    seed({ status: st }); r = await hold();
    ck('R-10 ' + st, r.outcome === 'refund_due' && B().status === st && B().paymentStatus === 'refund_due' && B().refundDueCents === 650000 && D['commissionReviewQueue/rental_refund_API1']
      && D['paymentIntents/RENT-b1'].status === 'refund_due', 'a payment for a ' + st + ' rental is NEVER held — refund_due + a review row', [r, B()]);
  }
  seed({ status: 'requested' }); r = await hold();
  ck('R-11', r.outcome === 'refund_due' && B().status === 'requested', 'a rental the shop has not accepted is never held', r);
  seed({ paymentStatus: 'refund_due', status: 'cancelled' }); r = await hold();
  ck('R-12', r.outcome === 'noop', 'a replay after refund_due is a no-op (no second review row churn)', r);
  D = { 'paymentIntents/X': { resourceType: 'providerBooking', resourceId: 'p1' } };
  r = await RH.holdRentalBookingPayment(db, adminSdk, { apiRef: 'X', intentRef: 'X', grossAmount: 10, confirm: OK });
  ck('R-13', r === false, 'a NON-rental intent falls through (false) — other purposes unchanged', r);
  seed(); delete D['rentalBookings/b1']; r = await hold();
  ck('R-14', r.outcome === 'parked' && r.reason === 'no_booking', 'a missing rental → parked', r);

  /* wiring (source): webhookIntasend calls it after the service hold, before attribution; the retired intasendWebhook is untouched */
  const IDX = fs.readFileSync(path.join(ROOT, 'functions', 'index.js'), 'utf8');
  const w0 = IDX.indexOf('exports.webhookIntasend = onRequest('), legacy = IDX.indexOf('exports.intasendWebhook = onRequest(');
  const at = IDX.indexOf('holdRentalBookingPayment(db, admin', w0), sh = IDX.indexOf('_holdServiceBookingPayment(db, admin', w0), d1 = IDX.indexOf('resolveFinancialAttribution } = require', w0);
  ck('W-1', w0 > 0 && at > sh && at < d1, 'webhookIntasend holds rentals after the service hold and BEFORE any attribution / credit step', { w0, sh, at, d1 });
  ck('W-2', IDX.split('holdRentalBookingPayment(db, admin').length === 2 && !(at > legacy && at < w0 && legacy < w0), 'wired exactly once, and not into the retired intasendWebhook', null);
  console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('CRASH (no verdict): ' + (e && e.stack || e)); process.exit(2); });
