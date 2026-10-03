#!/usr/bin/env node
'use strict';
/* ============================================================================
   Rental PIN — ONE PIN at RETURN, on the ONE booking-PIN authority (owner 2026-10-03)
   ----------------------------------------------------------------------------
   Real booking-pin-core (source 'rentalBookings') on the in-memory fake.
     I  issued only once the payment authority has HELD the money; parties from SERVER data
     V  the renter re-views it; nobody else — the provider never sees it
     P  the seller verifies at return; wrong / foreign / closed PINs refused; no "too early" gate
     N  renewal after expiry kills the old PIN
     S  unknown sources refused; the service-booking default is untouched
   node scripts/test-rental-pin.js       (SABOTAGE=1 → the suite must FAIL: proves rows bite)
   ============================================================================ */
const path = require('path'), fs = require('fs'), os = require('os'), Module = require('module');
const ROOT = path.resolve(__dirname, '..');
const FN = path.join(ROOT, 'functions');
const { makeFakeFirestore } = require('./lib/fake-firestore-txn');
let pass = 0, fail = 0;
const ck = (l, ok, d) => { if (ok) { pass++; console.log('  PASS  ' + l); } else { fail++; console.log('  FAIL  ' + l + (d !== undefined ? '  -> ' + JSON.stringify(d).slice(0, 300) : '')); } };
const F = makeFakeFirestore();
const res = (r) => Module._resolveFilename(r, { id: path.join(FN, 'x.js'), filename: path.join(FN, 'x.js'), paths: Module._nodeModulePaths(FN) });
const f = res('firebase-admin/firestore'); require.cache[f] = { id: f, filename: f, loaded: true, exports: { getFirestore: () => F.db, FieldValue: F.FieldValue, Timestamp: F.Timestamp } };

/* SABOTAGE: take providerUid from the client-writable booking field instead of the shop — the suite must catch it */
let corePath = path.join(FN, 'booking-pin-core.js');
if (process.env.SABOTAGE === '1') {
  const src = fs.readFileSync(corePath, 'utf8');
  const a = "return 'ownerId' in shop ? (shop.ownerId || null) : String(b.shopId);";
  if (!src.includes(a)) { console.error('SABOTAGE anchor missing — harness cannot prove anything'); process.exit(2); }
  corePath = path.join(FN, '.sabotage-booking-pin-core.js');
  fs.writeFileSync(corePath, src.replace(a, () => "return b.providerUid || null;"));
  process.on('exit', () => { try { fs.unlinkSync(corePath); } catch (_) {} });
}
const core = require(corePath);
const C = core._internal;
const DAY = 24 * 3600e3;
let NOW = Date.UTC(2026, 9, 10, 8, 0, 0);
C._setClock(() => NOW);

const call = async (fn, req) => { try { return { ok: true, v: await fn(req) }; } catch (e) { return { ok: false, code: e.code, msg: e.message }; } };
async function rental(id, over) {
  const d = Object.assign({ rentalProductId: 'rp1', shopId: 'shopA', buyerId: 'renter1', status: 'requested', paymentStatus: 'unpaid',
    startDate: F.Timestamp.fromMillis(NOW + DAY), endDate: F.Timestamp.fromMillis(NOW + 3 * DAY), durationUnit: 'daily',
    totalAmount: 24000, depositAmount: 20000 }, over || {});
  await F.db.collection('rentalBookings').doc(id).set(d);
  return d;
}
const env = async (id) => { const s = await F.db.collection(C.COL.ENV).doc('rnt_' + id).get(); return s.exists ? s.data() : null; };
const viewPin = async (uid, id) => call(C.customerGetBookingPin, { auth: { uid }, data: { bookingId: id, source: 'rentalBookings' } });

(async () => {
  console.log('Rental PIN — ONE PIN at RETURN\n');
  await F.db.collection('shops').doc('shopA').set({ ownerId: 'ownerA', name: 'Yard A' });
  await F.db.collection('shops').doc('legacyU').set({ name: 'Legacy yard' });          /* no ownerId: the id IS the owner */
  await F.db.collection('shopEmployees').doc('staff1').set({ shopId: 'shopA' });

  /* I — issue */
  let b = await rental('r1', { status: 'payment_pending', paymentStatus: 'unpaid' });
  let r = await C.onSourceWritten('rentalBookings', 'r1', b);
  ck('I1 no PIN while the rental is unpaid (payment_pending)', !(await env('r1')), r);
  b = await rental('r1', { status: 'paid_held', paymentStatus: 'held', providerUid: 'attacker' });
  r = await C.onSourceWritten('rentalBookings', 'r1', b);
  let e = await env('r1');
  ck('I2 the PIN is issued once the payment is HELD', !!(e && e.pin && e.pin.hash), r);
  ck('I3 provider = the SHOP OWNER from shops/{shopId} — a client providerUid field is ignored', e && e.providerUid === 'ownerA', e && e.providerUid);
  ck('I4 buyer = the renter (buyerId); envelope id rnt_<id>; reference BK-RNT-YYYY-NNNNNN', e && e.buyerUid === 'renter1' && e.envId === 'rnt_r1' && /^BK-RNT-\d{4}-\d{6}$/.test(e.bookingRef), e);
  ck('I5 category RENTAL; status CONFIRMED; payment CONFIRMED (held); amount 44,000 KES in cents', e && e.category === 'RENTAL' && e.status === 'CONFIRMED' && e.payment.state === 'CONFIRMED' && e.payment.amountCents === 4400000, e && { c: e.category, s: e.status, p: e.payment });
  const sec = (await F.db.collection(C.COL.SECRETS).doc('rnt_r1').get()).data();
  ck('I6 PIN at rest is ciphertext only (same encryption as service bookings)', sec && sec.pinEnc && sec.pinEnc.v === 1 && !('pin' in sec), sec);
  r = await C.onSourceWritten('rentalBookings', 'r1', b);
  const e2 = await env('r1');
  ck('I7 a second held write does not re-issue (same PIN hash)', e2 && e2.pin.hash === e.pin.hash, r);
  b = await rental('rL', { shopId: 'legacyU', status: 'paid_held', paymentStatus: 'held' });
  await C.onSourceWritten('rentalBookings', 'rL', b);
  ck('I8 legacy shop with no ownerId → the shop id is the owner (same model as _assertSeller)', ((await env('rL')) || {}).providerUid === 'legacyU');
  b = await rental('rX', { shopId: 'noSuchShop', status: 'paid_held', paymentStatus: 'held' });
  r = await C.onSourceWritten('rentalBookings', 'rX', b);
  ck('I9 a rental whose shop does not exist gets NO PIN (fail closed — nobody could verify it)', !(await env('rX')) && r.skipped === 'no_provider', r);

  /* V — view */
  let v = await viewPin('renter1', 'r1');
  const pin1 = v.ok && v.v.pin;
  ck('V1 the renter re-views their 4-digit PIN', v.ok && /^\d{4}$/.test(String(pin1)) && v.v.phrase === 'PIN YAKO NI BOOKING YAKO', v);
  v = await viewPin('ownerA', 'r1');
  ck('V2 the shop owner can NOT view the PIN (never shown to the provider)', !v.ok && v.code === 'permission-denied', v);
  v = await viewPin('stranger', 'r1');
  ck('V3 a stranger can NOT view it', !v.ok && v.code === 'permission-denied', v);
  v = await call(C.customerGetBookingPin, { auth: { uid: 'renter1' }, data: { bookingId: 'r1' } });
  ck('V4 without source the call reads a SERVICE booking (default unchanged) — the rental PIN is not returned', v.ok && v.v.issued === false, v);

  /* P — verify at return */
  const wrong = String((Number(pin1) + 1) % 10000).padStart(4, '0');
  r = await C.verify({ source: 'rentalBookings', bookingId: 'r1', providerUid: 'ownerA', actorUid: 'staff1', pin: wrong });
  ck('P1 a wrong PIN is refused', !r.ok && /does not match/.test(r.reason), r);
  const att = await F.db.collection(C.COL.ATTEMPTS).doc('rnt_r1_staff1').get();
  ck('P2 the failed attempt is charged to the person typing (staff1), not to the owner', att.exists && att.data().fails === 1, att.exists && att.data());
  r = await C.verify({ source: 'rentalBookings', bookingId: 'r1', providerUid: 'attacker', pin: pin1 });
  ck('P3 the right PIN from someone who is not the shop owner of record is refused', !r.ok && r.reason === 'Not your booking.', r);
  r = await C.verify({ source: 'rentalBookings', bookingId: 'r1', providerUid: 'ownerA', actorUid: 'staff1' });
  ck('P4 no PIN entered → the rental wording asks for the renter\'s PIN', !r.ok && /rental PIN/.test(r.reason), r);
  r = await C.verify({ source: 'rentalBookings', bookingId: 'r1', providerUid: 'ownerA', actorUid: 'staff1', pin: pin1 });
  ck('P5 the right PIN BEFORE the rental start is accepted (an early return — no "too early" gate)', r.ok === true && NOW < Date.UTC(2026, 9, 11), r);
  ck('P6 the envelope is VERIFIED, by the actor', (await env('r1')).verification.state === 'VERIFIED' && (await env('r1')).verification.by === 'staff1');
  r = await C.verify({ source: 'rentalBookings', bookingId: 'r1', providerUid: 'ownerA', pin: '0000' });
  ck('P7 a retry after verification is idempotent', r.ok === true && r.alreadyVerified === true, r);
  r = await C.verify({ source: 'providerBookings', bookingId: 'r1', providerUid: 'ownerA', pin: pin1 });
  ck('P8 the rental PIN cannot verify a service booking of the same id (separate envelope)', !r.ok && /no PIN yet/.test(r.reason), r);

  b = await rental('r2', { status: 'paid_held', paymentStatus: 'held' });
  await C.onSourceWritten('rentalBookings', 'r2', b);
  const pin2 = (await viewPin('renter1', 'r2')).v.pin;
  b = await rental('r2', { status: 'refunded', paymentStatus: 'refunded' });
  r = await C.onSourceWritten('rentalBookings', 'r2', b);
  ck('P9 a refund keeps the envelope current (CANCELLED / REFUNDED)', r.synced === true && (await env('r2')).status === 'CANCELLED' && (await env('r2')).payment.state === 'REFUNDED', r);
  r = await C.verify({ source: 'rentalBookings', bookingId: 'r2', providerUid: 'ownerA', pin: pin2 });
  ck('P10 a REFUNDED rental\'s PIN can never verify', !r.ok, r);
  b = await rental('r3', { status: 'cancelled', paymentStatus: 'unpaid' });
  r = await C.onSourceWritten('rentalBookings', 'r3', b);
  ck('P11 a non-held write never creates an envelope', r.skipped === 'no_envelope' && !(await env('r3')), r);

  /* N — renewal */
  b = await rental('r4', { status: 'paid_held', paymentStatus: 'held' });
  await C.onSourceWritten('rentalBookings', 'r4', b);
  const oldPin = (await viewPin('renter1', 'r4')).v.pin;
  await F.db.collection('rentalBookings').doc('r4').update({ status: 'return_pending' });
  NOW += 4 * DAY;                                     /* a late return: past endDate + 12h TTL */
  v = await viewPin('renter1', 'r4');
  ck('N1 after expiry the PIN is hidden and renewal is offered', v.ok && v.v.expired === true && v.v.pin === null && v.v.canRenew === true, v);
  r = await C.verify({ source: 'rentalBookings', bookingId: 'r4', providerUid: 'ownerA', pin: oldPin });
  ck('N2 the expired PIN does not verify', !r.ok && /expired/.test(r.reason), r);
  r = await call(C.customerRenewBookingPin, { auth: { uid: 'ownerA' }, data: { bookingId: 'r4', source: 'rentalBookings' } });
  ck('N3 only the renter can renew', !r.ok && r.code === 'permission-denied', r);
  r = await call(C.customerRenewBookingPin, { auth: { uid: 'renter1' }, data: { bookingId: 'r4', source: 'rentalBookings' } });
  const newPin = r.ok && r.v.pin;
  ck('N4 the renter renews a held rental and gets a new PIN', r.ok && /^\d{4}$/.test(String(newPin)), r);
  r = await C.verify({ source: 'rentalBookings', bookingId: 'r4', providerUid: 'ownerA', pin: newPin });
  ck('N5 the renewed PIN verifies the return', r.ok === true, r);
  b = await rental('r5', { status: 'paid_held', paymentStatus: 'released' });
  await C.onSourceWritten('rentalBookings', 'r5', b);
  r = await call(C.customerRenewBookingPin, { auth: { uid: 'renter1' }, data: { bookingId: 'r5', source: 'rentalBookings' } });
  ck('N6 no renewal once the money is released', !r.ok && r.code === 'failed-precondition', r);

  /* S — sources */
  r = await call(C.customerGetBookingPin, { auth: { uid: 'renter1' }, data: { bookingId: 'r1', source: 'eventOrders' } });
  ck('S1 a source that is not a PIN source (eventOrders) is refused', !r.ok && r.code === 'invalid-argument', r);
  r = await call(C.customerGetBookingPin, { auth: { uid: 'renter1' }, data: { bookingId: 'r1', source: '__proto__' } });
  ck('S2 prototype keys are not sources', !r.ok && r.code === 'invalid-argument', r);
  ck('S3 the PIN sources are exactly providerBookings + rentalBookings', JSON.stringify(core.SOURCES) === JSON.stringify(['providerBookings', 'rentalBookings']), core.SOURCES);

  console.log(`\n${pass} passed, ${fail} failed${process.env.SABOTAGE === '1' ? '   (SABOTAGE run — failures EXPECTED)' : ''}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR:', e.stack || e.message); process.exit(2); });
