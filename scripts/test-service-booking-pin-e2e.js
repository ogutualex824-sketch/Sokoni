#!/usr/bin/env node
'use strict';
/* ============================================================================
   PIN YAKO NI BOOKING YAKO — held booking money is released ONLY by the buyer's PIN
   ----------------------------------------------------------------------------
   Firestore emulator, real modules (entertainment-bookings envelope + PIN, provider-ops settlement,
   finos-utils commission). Proves, for a NON-entertainment service booking:
     A  a paid (paid_held) booking gets an envelope, a 4-digit PIN readable ONLY by the buyer,
        and an orders/{bookingId} mirror of type service_booking with escrow.held
     B  the provider cannot complete a held booking without the PIN (refused, nothing moves)
     C  a wrong PIN moves nothing and is counted
     D  the correct PIN: provider BUSINESS wallet (wallets/{providerId}) credited net of SOKONI
        commission; providerPayouts records the commission; booking completed + settled;
        the BUYER's wallet is untouched
     E  replay (same PIN again / complete again) pays nothing twice
     F  the orders mirror now shows escrow.released and the commission
   firebase emulators:exec --config firebase.emu.json --only firestore --project sokoni-e2e "node scripts/test-service-booking-pin-e2e.js"
   ============================================================================ */
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const HOST = process.env.FIRESTORE_EMULATOR_HOST;
if (!HOST || !/^(127\.0\.0\.1|localhost):\d+$/.test(HOST)) { console.error('refusing: FIRESTORE_EMULATOR_HOST must be a local emulator'); process.exit(3); }
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'sokoni-e2e';
process.env.FUNCTIONS_EMULATOR = 'true';
process.env.ENT_BOOKING_PIN_SECRET = process.env.ENT_BOOKING_PIN_SECRET || 'emulator-only-secret';
const admin = require(path.join(ROOT, 'functions', 'node_modules', 'firebase-admin'));
if (!admin.apps.length) admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT });
const db = admin.firestore();

const E = require(path.join(ROOT, 'functions', 'entertainment-bookings'));
const P = require(path.join(ROOT, 'functions', 'provider-ops'));
const CC = require(path.join(ROOT, 'functions', 'commission-config'));

let pass = 0, fail = 0;
const ck = (l, ok, d) => { if (ok) { pass++; console.log('  PASS  ' + l); } else { fail++; console.log('  FAIL  ' + l + (d !== undefined ? '  -> ' + JSON.stringify(d) : '')); } };
const call = async (fn, uid, data) => { try { return { ok: true, r: await fn({ auth: { uid, token: {} }, data }) }; } catch (e) { return { ok: false, code: e.code, msg: e.message }; } };

(async () => {
  console.log(`PIN YAKO NI BOOKING YAKO — held booking money released only by the PIN (emulator ${HOST})\n`);
  const PROVIDER = 'prov_pin_' + Date.now(), BUYER = 'buyer_pin_' + Date.now(), BID = 'bk_pin_' + Date.now();
  const now = Date.now();
  await db.collection('providers').doc(PROVIDER).set({ name: 'Mama Safi Cleaning', uid: PROVIDER });
  await db.collection('users').doc(BUYER).set({ uid: BUYER, walletBalance: 0 });
  await db.collection('payments').doc('pay_' + BID).set({ status: 'COMPLETE', amount: 2000, netAmount: 1970, uid: BUYER });
  const booking = {
    providerId: PROVIDER, customerUid: BUYER, service: 'Home cleaning', commissionHub: 'provider',
    price: 200000, fee: 0, deposit: 0, status: 'confirmed', paymentStatus: 'paid_held', heldAmount: 200000,
    paymentRef: 'pay_' + BID, startTs: now - 3600e3, endTs: now - 600e3, createdAt: admin.firestore.Timestamp.now(),
  };
  await db.collection('providerBookings').doc(BID).set(booking);

  console.log('A. paid booking → envelope, PIN (buyer only), orders mirror');
  await E.onSourceWritten('providerBookings', BID, booking);
  const envId = 'SVC_' + BID;
  const envSnap = (await db.collection('entBookings').where('source.id', '==', BID).limit(1).get()).docs[0];
  ck('A1 a non-entertainment service booking now gets an envelope with a PIN hash (no raw PIN on the envelope)', !!envSnap && !!envSnap.data().pin && !!envSnap.data().pin.hash && envSnap.data().pin.pin === undefined, envSnap && envSnap.data().pin);
  const bRes = await call(E._h.customerGetBookingPin, BUYER, { bookingId: BID });
  ck('A2 the BUYER reads a 4-digit PIN with the phrase PIN YAKO NI BOOKING YAKO', bRes.ok && bRes.r.issued && /^\d{4}$/.test(bRes.r.pin) && bRes.r.phrase === 'PIN YAKO NI BOOKING YAKO', bRes);
  const pRes = await call(E._h.customerGetBookingPin, PROVIDER, { bookingId: BID });
  ck('A3 the PROVIDER cannot read the PIN (permission-denied)', !pRes.ok && pRes.code === 'permission-denied', pRes);
  const order0 = (await db.collection('orders').doc(BID).get()).data();
  ck('A4 orders/{bookingId} mirror: type service_booking, buyer + provider, escrow.held KES 2,000', order0 && order0.type === 'service_booking' && order0.buyerUid === BUYER && order0.sellerUid === PROVIDER && order0.escrow.held === 2000 && order0.escrow.released === 0, order0 && { type: order0.type, escrow: order0.escrow });
  const PIN = bRes.r.pin;

  console.log('\nB. completing a held booking without the PIN');
  const noPin = await call(P._h.providerCompleteBooking, PROVIDER, { bookingId: BID });
  const b1 = (await db.collection('providerBookings').doc(BID).get()).data();
  const w1 = await db.collection('wallets').doc(PROVIDER).get();
  ck('B1 refused with the PIN instruction; booking still paid_held; provider wallet not credited', !noPin.ok && /PIN YAKO NI BOOKING YAKO/.test(noPin.msg) && b1.paymentStatus === 'paid_held' && (!w1.exists || !w1.data().balance), { noPin, ps: b1.paymentStatus });

  console.log('\nC. a wrong PIN');
  const wrong = String((Number(PIN) + 1) % 10000).padStart(4, '0');
  const bad = await call(P._h.providerCompleteBooking, PROVIDER, { bookingId: BID, pin: wrong });
  const b2 = (await db.collection('providerBookings').doc(BID).get()).data();
  ck('C1 wrong PIN refused, nothing moved, booking still paid_held', !bad.ok && b2.paymentStatus === 'paid_held', bad);
  const attempts = await db.collection('entBookingPinAttempts').get();
  ck('C2 the failed attempt is counted', attempts.docs.some((d) => (d.data().fails || 0) >= 1));

  console.log('\nD. the correct PIN releases the money');
  const good = await call(P._h.providerCompleteBooking, PROVIDER, { bookingId: BID, pin: PIN });
  const b3 = (await db.collection('providerBookings').doc(BID).get()).data();
  const wallet = (await db.collection('wallets').doc(PROVIDER).get()).data() || {};
  const payout = (await db.collection('providerPayouts').doc(BID).get()).data() || {};
  const buyer = (await db.collection('users').doc(BUYER).get()).data() || {};
  const ratePct = CC.resolveRate('services').pct;                 /* owner 2026-10-03: every service booking flat 5 % (RATES.services), plan ladder retired for bookings */
  const commissionC = Math.round(200000 * ratePct / 100);
  const netKES = Math.floor((200000 - commissionC) / 100);
  ck('D1 completed via PIN: booking status completed, paymentStatus settled, trigger pin_release', good.ok && good.r.viaPin && b3.status === 'completed' && b3.paymentStatus === 'settled' && b3.settledTrigger === 'pin_release', { good, status: b3.status, ps: b3.paymentStatus, trig: b3.settledTrigger });
  ck(`D2 provider BUSINESS wallet credited net of SOKONI commission: KES ${netKES} (KES 2,000 − ${ratePct}%)`, wallet.balance === netKES, wallet);
  ck(`D3 providerPayouts records SOKONI commission ${commissionC} cents at ${ratePct}% (what AdminOS / super admin aggregate)`, payout.commission === commissionC && payout.status === 'settled' && payout.walletCredited === true && payout.settledTrigger === 'pin_release', payout);
  ck('D4 the BUYER wallet is untouched (money never routed to the buyer on release)', !buyer.walletBalance, buyer.walletBalance);

  console.log('\nE. replay');
  const again = await call(P._h.providerCompleteBooking, PROVIDER, { bookingId: BID, pin: PIN });
  const wallet2 = (await db.collection('wallets').doc(PROVIDER).get()).data() || {};
  ck('E1 complete again: alreadyDone, wallet unchanged (no double credit)', again.ok && again.r.alreadyDone === true && wallet2.balance === netKES, { again, bal: wallet2.balance });
  const reuse = await call(E._h.providerVerifyBookingPin, PROVIDER, { bookingId: BID, pin: PIN });
  const wallet3 = (await db.collection('wallets').doc(PROVIDER).get()).data() || {};
  ck('E2 the same PIN again: not verified (USED), wallet unchanged', reuse.ok && reuse.r.verified === false && wallet3.balance === netKES, reuse);

  console.log('\nF. orders mirror after release');
  await E.onSourceWritten('providerBookings', BID, (await db.collection('providerBookings').doc(BID).get()).data());
  const order1 = (await db.collection('orders').doc(BID).get()).data();
  ck(`F1 order mirror: escrow.held 0, escrow.released KES ${netKES}, commissionKES ${commissionC / 100}, paymentStatus settled, gateway charges KES 30 recorded`, order1.escrow.held === 0 && order1.escrow.released === netKES && order1.commissionKES === commissionC / 100 && order1.paymentStatus === 'settled' && order1.gatewayChargesKES === 30, order1 && { escrow: order1.escrow, commissionKES: order1.commissionKES, ps: order1.paymentStatus, gw: order1.gatewayChargesKES });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('  CRASH', e); process.exit(2); });
