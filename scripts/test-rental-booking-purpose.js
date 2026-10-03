#!/usr/bin/env node
'use strict';
/* rental_booking payment purpose (equipment rental → held payment) — contract with sokoni-f3 2026-10-03 (rentalBook shape)
     R1  amount = totalAmount + depositAmount read from the server-only booking; the client amount is ignored
     R2  commission base = rent ONLY (construction_equipment_rental 10%); the deposit is carried separately as refundable
     R3  payee = shops/{shopId}.ownerId, else shopId (f3's shop identity model); business wallet
     R4  ONE intent per booking: deterministic preferredRef RENT-<bookingId>
     R5  refused: another user · pending (not confirmed) · cancelled / completed · already paid · zero / NaN rent ·
         negative deposit · no shop · paying for your own equipment · bad bookingId
     R7  pricing moves accepted|confirmed → payment_pending in one txn (retry-safe); never writes a payment method
     R6  rental_booking is self-settling (HELD until completion — no generic credit at payment time)
   NODE_PATH=<functions/node_modules> node scripts/test-rental-booking-purpose.js */
const path = require('path'), Module = require('module');
const FN = path.join(path.resolve(__dirname, '..'), 'functions');
let pass = 0, fail = 0;
const ck = (l, ok, d) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (ok || d === undefined ? '' : '  -> ' + JSON.stringify(d).slice(0, 220))); ok ? pass++ : fail++; };
class HttpsError extends Error { constructor (code, message) { super(message); this.code = code; } }
let DOCS = {};
const snapOf = (k) => { const d = DOCS[k]; return { exists: !!d, data: () => d && JSON.parse(JSON.stringify(d)) }; };
const db = { collection: (c) => ({ doc: (id) => ({ _k: c + '/' + id, get: async () => snapOf(c + '/' + id) }) }),
  runTransaction: async (fn) => { if (BEFORE_TXN) { BEFORE_TXN(); BEFORE_TXN = null; } return fn({ get: async (ref) => snapOf(ref._k), update: (ref, patch) => { Object.assign(DOCS[ref._k], patch); } }); } };
let BEFORE_TXN = null;   /* simulates a concurrent write landing between the pricer's first read and its transaction */
const orig = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === 'firebase-admin/firestore') return { getFirestore: () => db, FieldPath: { documentId: () => '__name__' } };
  if (id === 'firebase-functions/v2/https') return { HttpsError, onCall: (o, h) => h };
  if (id === 'firebase-functions/logger') return { info () {}, warn () {}, error () {} };
  return orig.apply(this, arguments);
};
const P = require(path.join(FN, 'payment-purposes.js'));
Module.prototype.require = orig;
const SS = require(path.join(FN, 'shared/self-settling-purposes.js'));
const CC = require(path.join(FN, 'commission-config.js'));
const price = (uid, data) => P.PURPOSES.rental_booking.price(uid, data).then((r) => ({ ok: true, r }), (e) => ({ ok: false, code: e.code, msg: e.message }));
function reset (over, shop) {
  DOCS = { 'rentalBookings/RB00001': Object.assign({ rentalProductId: 'RP1', shopId: 'shop1', buyerId: 'renter1', durationUnit: 'daily',
    totalAmount: 4500, depositAmount: 2000, paymentMethod: 'none', paymentStatus: 'unpaid', status: 'accepted' }, over || {}) };
  if (shop !== null) DOCS['shops/shop1'] = shop || { ownerId: 'owner1' };
}

(async () => {
  reset();
  let x = await price('renter1', { bookingId: 'RB00001', amount: 1, totalAmount: 1 });
  ck('R1 amount = rent 4,500 + deposit 2,000 from the booking; client amount ignored', x.ok && x.r.amountCents === 650000, x);
  ck('R2 commission base = rent only, category construction_equipment_rental (10%); deposit separate + refundable', x.ok && x.r.metadata.commissionBaseCents === 450000
    && x.r.metadata.depositCents === 200000 && x.r.metadata.depositRefundable === true && CC.resolveRate(x.r.metadata.commissionCategory).pct === 10);
  ck('R7 pricing moves accepted → payment_pending; paymentStatus stays unpaid; no payment method written', DOCS['rentalBookings/RB00001'].status === 'payment_pending'
    && DOCS['rentalBookings/RB00001'].paymentStatus === 'unpaid' && DOCS['rentalBookings/RB00001'].paymentMethod === 'none');
  x = await price('renter1', { bookingId: 'RB00001' });
  ck('R7b a retry at payment_pending prices again (same ref, same amount)', x.ok && x.r.preferredRef === 'RENT-RB00001' && x.r.amountCents === 650000);
  for (const legacy of ['confirmed']) { reset({ status: legacy }); const z = await price('renter1', { bookingId: 'RB00001' }); ck('R7c legacy confirmed (= accepted) is payable', z.ok); }
  reset(); x = await price('renter1', { bookingId: 'RB00001' });
  ck('R3 payee = shop owner, business wallet', x.ok && x.r.metadata.sellerUid === 'owner1' && x.r.metadata.payeeWallet === 'business');
  reset({}, null);
  const y = await price('renter1', { bookingId: 'RB00001' });
  ck('R3b no shop doc → shopId IS the owner uid', y.ok && y.r.metadata.sellerUid === 'shop1');
  ck('R4 one intent per booking: preferredRef RENT-RB00001', x.ok && x.r.preferredRef === 'RENT-RB00001');
  reset({ depositAmount: 0 });
  x = await price('renter1', { bookingId: 'RB00001' });
  ck('R1b no deposit → amount = rent only', x.ok && x.r.amountCents === 450000 && x.r.metadata.depositCents === 0);
  const refusals = [];
  const tryCase = async (label, setup, uid, id) => { setup(); const r = await price(uid || 'renter1', { bookingId: id || 'RB00001' }); refusals.push([label, r.ok ? 'PRICED' : r.code]); };
  await tryCase('another user', () => reset(), 'mallory');
  await tryCase('pending (legacy requested)', () => reset({ status: 'pending' }));
  await tryCase('requested', () => reset({ status: 'requested' }));
  await tryCase('declined', () => reset({ status: 'declined' }));
  await tryCase('paid_held', () => reset({ status: 'paid_held', paymentStatus: 'held' }));
  await tryCase('refunded', () => reset({ status: 'refunded' }));
  await tryCase('cancelled', () => reset({ status: 'cancelled' }));
  await tryCase('completed', () => reset({ status: 'completed' }));
  await tryCase('already paid', () => reset({ paymentStatus: 'paid' }));
  await tryCase('zero rent', () => reset({ totalAmount: 0 }));
  await tryCase('NaN rent', () => reset({ totalAmount: 'abc' }));
  await tryCase('negative deposit', () => reset({ depositAmount: -5 }));
  await tryCase('no shop', () => reset({ shopId: '' }));
  await tryCase('own equipment (owner pays)', () => reset({ buyerId: 'owner1' }), 'owner1');
  await tryCase('bad bookingId', () => reset(), 'renter1', 'x');
  await tryCase('missing booking', () => reset(), 'renter1', 'RB99999');
  ck('R5 every unsafe case is refused (never priced)', refusals.every(([, c]) => c !== 'PRICED'), refusals);
  reset(); BEFORE_TXN = () => { DOCS['rentalBookings/RB00001'].status = 'cancelled'; };
  x = await price('renter1', { bookingId: 'RB00001' });
  ck('R8 RACE: a cancel landing between the first read and the txn is refused inside the txn — no intent, booking stays cancelled (never payment_pending)',
    !x.ok && x.code === 'failed-precondition' && DOCS['rentalBookings/RB00001'].status === 'cancelled', x);
  reset(); BEFORE_TXN = () => { DOCS['rentalBookings/RB00001'].totalAmount = 9999; };
  x = await price('renter1', { bookingId: 'RB00001' });
  ck('R8b RACE: an amount change between read and txn aborts (no stale-priced intent)', !x.ok && x.code === 'aborted' && DOCS['rentalBookings/RB00001'].status === 'accepted', x);
  ck('R6 rental_booking is self-settling (held; no generic credit at payment)', SS.isSelfSettling('rental_booking'));
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('CRASH', e && e.stack); process.exit(1); });
