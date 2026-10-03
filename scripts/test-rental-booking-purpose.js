#!/usr/bin/env node
'use strict';
/* rental_booking payment purpose (equipment rental → held payment) — contract with sokoni-f3 2026-10-03 (rentalBook shape)
     R1  amount = totalAmount + depositAmount read from the server-only booking; the client amount is ignored
     R2  commission base = rent ONLY (construction_equipment_rental 10%); the deposit is carried separately as refundable
     R3  payee = shops/{shopId}.ownerId, else shopId (f3's shop identity model); business wallet
     R4  ONE intent per booking: deterministic preferredRef RENT-<bookingId>
     R5  refused: another user · pending (not confirmed) · cancelled / completed · already paid · zero / NaN rent ·
         negative deposit · no shop · paying for your own equipment · bad bookingId
     R6  rental_booking is self-settling (HELD until completion — no generic credit at payment time)
   NODE_PATH=<functions/node_modules> node scripts/test-rental-booking-purpose.js */
const path = require('path'), Module = require('module');
const FN = path.join(path.resolve(__dirname, '..'), 'functions');
let pass = 0, fail = 0;
const ck = (l, ok, d) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (ok || d === undefined ? '' : '  -> ' + JSON.stringify(d).slice(0, 220))); ok ? pass++ : fail++; };
class HttpsError extends Error { constructor (code, message) { super(message); this.code = code; } }
let DOCS = {};
const db = { collection: (c) => ({ doc: (id) => ({ get: async () => { const d = DOCS[c + '/' + id]; return { exists: !!d, data: () => d && JSON.parse(JSON.stringify(d)) }; } }) }) };
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
    totalAmount: 4500, depositAmount: 2000, paymentMethod: 'none', paymentStatus: 'unpaid', status: 'confirmed' }, over || {}) };
  if (shop !== null) DOCS['shops/shop1'] = shop || { ownerId: 'owner1' };
}

(async () => {
  reset();
  let x = await price('renter1', { bookingId: 'RB00001', amount: 1, totalAmount: 1 });
  ck('R1 amount = rent 4,500 + deposit 2,000 from the booking; client amount ignored', x.ok && x.r.amountCents === 650000, x);
  ck('R2 commission base = rent only, category construction_equipment_rental (10%); deposit separate + refundable', x.ok && x.r.metadata.commissionBaseCents === 450000
    && x.r.metadata.depositCents === 200000 && x.r.metadata.depositRefundable === true && CC.resolveRate(x.r.metadata.commissionCategory).pct === 10);
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
  await tryCase('pending (shop not confirmed)', () => reset({ status: 'pending' }));
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
  ck('R6 rental_booking is self-settling (held; no generic credit at payment)', SS.isSelfSettling('rental_booking'));
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('CRASH', e && e.stack); process.exit(1); });
