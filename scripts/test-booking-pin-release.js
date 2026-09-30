#!/usr/bin/env node
'use strict';
/* ============================================================================
   PIN YAKO NI BOOKING YAKO — live providerDispatch lineage, Firestore emulator, real modules
   ----------------------------------------------------------------------------
   booking-pin-core (issue / window / renew / verify) + provider-ops.providerCompleteBooking (the
   existing single provider credit point) + finos-utils commission.
     A  payment held → PIN issued, buyer-only, order mirror escrow.held
     B  complete without PIN refused, nothing moves;  C  wrong PIN refused + counted
     D  PIN expires 12 h after the booking end → verify refused, money still held; buyer renews;
        OLD PIN dead; NEW PIN completes → provider BUSINESS wallet credited net of commission,
        providerPayouts commission, buyer wallet untouched, order mirror released
     E  replay pays nothing twice;  F  too early: verify + renew refused before the booking window
     G  renewal cap;  H  provider cannot read or renew the buyer's PIN
   firebase emulators:exec --config firebase.emu.json --only firestore --project sokoni-e2e "node scripts/test-booking-pin-release.js"
   ============================================================================ */
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const HOST = process.env.FIRESTORE_EMULATOR_HOST;
if (!HOST || !/^(127\.0\.0\.1|localhost):\d+$/.test(HOST)) { console.error('refusing: FIRESTORE_EMULATOR_HOST must be a local emulator'); process.exit(3); }
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'sokoni-e2e';
const admin = require(path.join(ROOT, 'functions', 'node_modules', 'firebase-admin'));
if (!admin.apps.length) admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT });
const db = admin.firestore();
const CORE = require(path.join(ROOT, 'functions', 'booking-pin-core'));
const P = require(path.join(ROOT, 'functions', 'provider-ops'));
const X = CORE._internal;

let pass = 0, fail = 0;
const ck = (l, ok, d) => { if (ok) { pass++; console.log('  PASS  ' + l); } else { fail++; console.log('  FAIL  ' + l + (d !== undefined ? '  -> ' + JSON.stringify(d).slice(0, 300) : '')); } };
const call = async (fn, uid, data) => { try { return { ok: true, r: await fn({ auth: { uid, token: {} }, data }) }; } catch (e) { return { ok: false, code: e.code, msg: e.message }; } };
const bal = async (uid) => ((await db.collection('wallets').doc(uid).get()).data() || {}).balance || 0;

(async () => {
  console.log(`PIN YAKO NI BOOKING YAKO on the live provider line (emulator ${HOST})\n`);
  const T0 = Date.now();
  X._setClock(() => T0);
  const PROVIDER = 'prov_' + T0, BUYER = 'buyer_' + T0, BID = 'bk_' + T0;
  await db.collection('users').doc(BUYER).set({ uid: BUYER, walletBalance: 0 });
  await db.collection('payments').doc('pay_' + BID).set({ status: 'COMPLETE', amount: 2000, netAmount: 1970, uid: BUYER });
  const booking = { providerId: PROVIDER, customerUid: BUYER, service: 'Home cleaning', commissionHub: 'provider', price: 200000, fee: 0,
    status: 'confirmed', paymentStatus: 'paid_held', heldAmount: 200000, paymentRef: 'pay_' + BID,
    startTs: T0 + 30 * 60e3, endTs: T0 + 90 * 60e3, createdAt: admin.firestore.Timestamp.now() };
  await db.collection('providerBookings').doc(BID).set(booking);

  console.log('A. payment held → PIN issued');
  await X.onBookingWritten(BID, booking);
  const env = (await db.collection('entBookings').doc('svc_' + BID).get()).data();
  ck('A1 envelope svc_<id> with a PIN hash only (compatible with the full module)', !!env && !!env.pin.hash && !env.pin.pin && env.verification.state === 'NOT_VERIFIED', env && env.pin);
  const g1 = await call(X.customerGetBookingPin, BUYER, { bookingId: BID });
  ck('A2 buyer reads the 4-digit PIN, phrase, and the booking window', g1.ok && /^\d{4}$/.test(g1.r.pin) && g1.r.phrase === 'PIN YAKO NI BOOKING YAKO' && g1.r.expiresAtMs === booking.endTs + 12 * 3600e3 && g1.r.opensAtMs === booking.startTs - 2 * 3600e3, g1);
  const PIN1 = g1.r.pin;
  const o0 = (await db.collection('orders').doc(BID).get()).data();
  ck('A3 orders mirror: service_booking, escrow.held KES 2,000', o0 && o0.type === 'service_booking' && o0.escrow.held === 2000, o0 && o0.escrow);

  console.log('\nB/C. no PIN, wrong PIN');
  const b1 = await call(P._h.providerCompleteBooking, PROVIDER, { bookingId: BID });
  ck('B1 complete without PIN refused with the instruction; still paid_held; wallet 0', !b1.ok && /PIN YAKO NI BOOKING YAKO/.test(b1.msg) && (await db.collection('providerBookings').doc(BID).get()).data().paymentStatus === 'paid_held' && (await bal(PROVIDER)) === 0, b1);
  const wrong = String((Number(PIN1) + 1) % 10000).padStart(4, '0');
  const c1 = await call(P._h.providerCompleteBooking, PROVIDER, { bookingId: BID, pin: wrong });
  ck('C1 wrong PIN refused; nothing moved', !c1.ok && /does not match/.test(c1.msg) && (await bal(PROVIDER)) === 0, c1);

  console.log('\nD. PIN expires with the booking → renew → complete');
  X._setClock(() => booking.endTs + 13 * 3600e3);
  const d1 = await call(P._h.providerCompleteBooking, PROVIDER, { bookingId: BID, pin: PIN1 });
  ck('D1 13 h after the end: the right PIN is refused as EXPIRED, money still held', !d1.ok && /expired/i.test(d1.msg) && (await db.collection('providerBookings').doc(BID).get()).data().paymentStatus === 'paid_held', d1);
  const g2 = await call(X.customerGetBookingPin, BUYER, { bookingId: BID });
  ck('D2 buyer sees expired, no PIN shown, canRenew true', g2.ok && g2.r.expired === true && g2.r.pin === null && g2.r.canRenew === true, g2);
  const rn = await call(X.customerRenewBookingPin, BUYER, { bookingId: BID });
  ck('D3 buyer renews: a new 4-digit PIN, valid 12 h from now, 4 renewals left', rn.ok && /^\d{4}$/.test(rn.r.pin) && rn.r.renewalsLeft === 4, rn);
  const PIN2 = rn.r.pin;
  if (PIN2 !== PIN1) {
    const d4 = await call(P._h.providerCompleteBooking, PROVIDER, { bookingId: BID, pin: PIN1 });
    ck('D4 the OLD PIN no longer works', !d4.ok && /does not match/.test(d4.msg), d4);
  } else { pass++; console.log('  PASS  D4 (new PIN coincided with the old one — 1 in 10,000; old/new identical, nothing to distinguish)'); }
  const d5 = await call(P._h.providerCompleteBooking, PROVIDER, { bookingId: BID, pin: PIN2 });
  const b5 = (await db.collection('providerBookings').doc(BID).get()).data();
  const payout = (await db.collection('providerPayouts').doc(BID).get()).data() || {};
  const buyer = (await db.collection('users').doc(BUYER).get()).data() || {};
  ck('D5 the NEW PIN completes: status completed, paymentStatus settled, viaPin', d5.ok && d5.r.viaPin === true && b5.status === 'completed' && b5.paymentStatus === 'settled', { d5, status: b5.status, ps: b5.paymentStatus });
  const credited = await bal(PROVIDER);
  ck(`D6 provider BUSINESS wallet credited net of SOKONI commission (KES ${credited} of 2,000; commission ${payout.commission} cents)`, credited > 0 && credited < 2000 && payout.commission > 0 && credited === Math.floor((200000 - payout.commission) / 100), { credited, payout: { commission: payout.commission, status: payout.status } });
  ck('D7 buyer wallet untouched', !buyer.walletBalance, buyer.walletBalance);
  await X.onBookingWritten(BID, b5);
  const o1 = (await db.collection('orders').doc(BID).get()).data();
  ck('D8 orders mirror: escrow released = provider net, commission recorded, IntaSend charge KES 30', o1.escrow.held === 0 && o1.escrow.released === credited && o1.commissionKES === Math.round(payout.commission / 100) && o1.gatewayChargesKES === 30, o1 && { escrow: o1.escrow, c: o1.commissionKES, gw: o1.gatewayChargesKES });

  console.log('\nE. replay');
  const e1 = await call(P._h.providerCompleteBooking, PROVIDER, { bookingId: BID, pin: PIN2 });
  ck('E1 complete again: alreadyDone, wallet unchanged', e1.ok && e1.r.alreadyDone === true && (await bal(PROVIDER)) === credited, e1);
  const e2 = await call(X.customerRenewBookingPin, BUYER, { bookingId: BID });
  ck('E2 no renewal after the money is released', !e2.ok, e2);

  console.log('\nF. too early');
  X._setClock(() => T0);
  const BID2 = 'bk2_' + T0;
  const bk2 = { ...booking, startTs: T0 + 24 * 3600e3, endTs: T0 + 25 * 3600e3, paymentRef: 'pay_' + BID };
  await db.collection('providerBookings').doc(BID2).set(bk2);
  await X.onBookingWritten(BID2, bk2);
  const f0 = await call(X.customerGetBookingPin, BUYER, { bookingId: BID2 });
  const f1 = await call(P._h.providerCompleteBooking, PROVIDER, { bookingId: BID2, pin: f0.r.pin });
  ck('F1 a booking tomorrow: the right PIN is refused as too early', !f1.ok && /Too early/.test(f1.msg), f1);
  const f2 = await call(X.customerRenewBookingPin, BUYER, { bookingId: BID2 });
  ck('F2 renewal refused before the booking window opens', !f2.ok && /2 hours before/.test(f2.msg), f2);
  ck('F3 canRenew false before the window', f0.ok && f0.r.canRenew === false, f0.r && { canRenew: f0.r.canRenew });

  console.log('\nG/H. cap and ownership');
  X._setClock(() => bk2.startTs);
  let last = null; for (let i = 0; i < 5; i++) last = await call(X.customerRenewBookingPin, BUYER, { bookingId: BID2 });
  const g6 = await call(X.customerRenewBookingPin, BUYER, { bookingId: BID2 });
  ck('G1 five renewals allowed, the sixth refused (cap)', last.ok && last.r.renewalsLeft === 0 && !g6.ok && /renewal limit/.test(g6.msg), { last, g6 });
  const h1 = await call(X.customerGetBookingPin, PROVIDER, { bookingId: BID2 });
  const h2 = await call(X.customerRenewBookingPin, PROVIDER, { bookingId: BID2 });
  ck('H1 the provider can neither read nor renew the buyer\'s PIN', !h1.ok && h1.code === 'permission-denied' && !h2.ok && h2.code === 'permission-denied', { h1, h2 });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('  CRASH', e); process.exit(2); });
