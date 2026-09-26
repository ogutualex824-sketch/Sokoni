/* Payment purposes — car_hub and accommodation pricers.

   WHAT THESE PROVE, AND WHY THEY ARE SHAPED THIS WAY

   The registry's whole security property is that the SERVER derives the price.
   A test that only asserted "a quote came back" would pass against a pricer
   that read `data.amount`, so every case here either pins the DERIVED FIGURE
   against the stored document or proves a REFUSAL.

   Both halves are required. A suite that only sends hostile input passes a
   pricer that refuses everybody, so each vertical has a legitimate path that
   MUST succeed alongside the refusals. And each refusal is paired with the
   same call minus the offending field, so a "refused" result cannot be an
   artefact of the harness failing to build a valid request.

   Firestore is stubbed at `firebase-admin/firestore` — the module takes
   `getFirestore` from there, not from the `admin.firestore` prototype getter,
   so an ordinary require-cache injection is sound here. The stub COUNTS reads,
   which is how the "never reads the client amount" assertions are made: a
   pricer that ignored the document would show zero reads.
*/
'use strict';
const path = require('path');
const Module = require('module');

let pass = 0, fail = 0;
const ck = (l, ok, d) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d ? '   [' + String(d).slice(0, 80) + ']' : ''));
  ok ? pass++ : fail++;
};

/* ── Firestore stub ──────────────────────────────────────────────────────── */
const DOCS = Object.create(null);
let reads = 0;

function makeDb() {
  return {
    collection(name) {
      return {
        doc(id) {
          return {
            async get() {
              reads++;
              const key = name + '/' + id;
              const data = DOCS[key];
              return { exists: data !== undefined, data: () => data, id };
            },
          };
        },
      };
    },
  };
}

const realResolve = Module._resolveFilename;
const stubPath = 'firebase-admin/firestore';
require.cache[stubPath] = {
  id: stubPath, filename: stubPath, loaded: true, exports: {
    getFirestore: makeDb,
    FieldPath: { documentId: () => '__name__' },
  },
};
Module._resolveFilename = function (request, ...rest) {
  if (request === stubPath) return stubPath;
  return realResolve.call(this, request, ...rest);
};

/* HttpsError must not need a live functions runtime. */
const purposes = require(path.join(__dirname, '..', 'functions', 'payment-purposes'));

/* ── Helpers ─────────────────────────────────────────────────────────────── */
const BUYER = 'uid_buyer_1';
const OTHER = 'uid_someone_else';

async function quote(purpose, uid, data) {
  try { return { ok: true, q: await purposes.priceFor(purpose, uid, data) }; }
  catch (e) { return { ok: false, code: e.code || e.message, msg: e.message }; }
}

function setDoc(key, data) { DOCS[key] = data; }
function delDoc(key) { delete DOCS[key]; }

(async () => {

  /* ══ Registration ═══════════════════════════════════════════════════════ */
  console.log('\n── Registration ──');
  ck('car_hub is registered', purposes.isRegistered('car_hub'));
  ck('accommodation is registered', purposes.isRegistered('accommodation'));
  ck('an unregistered purpose is REFUSED, not defaulted',
     !(await quote('talent_booking', BUYER, {})).ok);
  ck('the pre-existing purposes are untouched',
     ['digital_download', 'event_ticket', 'service_booking', 'healthcare_subscription',
      'pos_till_sale', 'product_order', 'hub_registration']
       .every((p) => purposes.isRegistered(p)),
     purposes.registered().length + ' registered');

  /* ══ car_hub ════════════════════════════════════════════════════════════ */
  console.log('\n── car_hub: the legitimate path MUST succeed ──');
  setDoc('rentalBookings/RB1', {
    buyerId: BUYER, status: 'pending', totalAmount: 4500, depositAmount: 10000,
    rentalProductId: 'RP9', shopId: 'SHOP7', durationUnit: 'daily',
  });
  {
    reads = 0;
    const r = await quote('car_hub', BUYER, { bookingId: 'RB1' });
    ck('a pending rental prices successfully', r.ok, r.ok ? '' : r.msg);
    ck('amount is the STORED totalAmount in cents', r.ok && r.q.amountCents === 450000,
       r.ok ? r.q.amountCents : '-');
    ck('KES figure is 4500', r.ok && r.q.amount === 4500, r.ok ? r.q.amount : '-');
    ck('the booking document WAS read (positive control on the stub)', reads > 0, reads + ' reads');
    ck('resourceId is the bookingId', r.ok && r.q.resourceId === 'RB1');
    ck('resourceType is rentalBooking', r.ok && r.q.resourceType === 'rentalBooking');
  }

  console.log('\n── car_hub: the client amount is IGNORED ──');
  {
    const r = await quote('car_hub', BUYER, { bookingId: 'RB1', amount: 1, amountCents: 100, totalAmount: 1 });
    ck('a client-supplied amount does not change the charge',
       r.ok && r.q.amountCents === 450000, r.ok ? r.q.amountCents : r.msg);
  }

  console.log('\n── car_hub: the security deposit is NOT charged ──');
  {
    const r = await quote('car_hub', BUYER, { bookingId: 'RB1' });
    ck('depositAmount is excluded from amountCents',
       r.ok && r.q.amountCents === 450000, 'total 4500, deposit 10000');
    ck('deposit is surfaced as metadata in cents',
       r.ok && r.q.metadata.securityDepositUncollected === 1000000,
       r.ok ? r.q.metadata.securityDepositUncollected : '-');
    /* The inverting control: if the pricer DID add the deposit the figure would
       be 1,450,000 cents. Asserting the absence alone would also pass against a
       pricer that returned zero. */
    ck('the charge is NOT total+deposit', r.ok && r.q.amountCents !== 1450000);
  }

  console.log('\n── car_hub: refusals (each paired with the passing case above) ──');
  {
    const r = await quote('car_hub', OTHER, { bookingId: 'RB1' });
    ck('another user cannot price my booking', !r.ok && r.code === 'permission-denied', r.code);
  }
  {
    const r = await quote('car_hub', BUYER, {});
    ck('a missing bookingId is refused', !r.ok && r.code === 'invalid-argument', r.code);
  }
  {
    const r = await quote('car_hub', BUYER, { bookingId: 'NOPE' });
    ck('an unknown booking is refused', !r.ok && r.code === 'not-found', r.code);
  }
  for (const st of ['active', 'completed', 'cancelled']) {
    setDoc('rentalBookings/RB_' + st, { buyerId: BUYER, status: st, totalAmount: 4500 });
    const r = await quote('car_hub', BUYER, { bookingId: 'RB_' + st });
    ck('status "' + st + '" cannot be paid', !r.ok && r.code === 'failed-precondition', r.code);
  }
  {
    setDoc('rentalBookings/RB_conf', { buyerId: BUYER, status: 'confirmed', totalAmount: 4500 });
    const r = await quote('car_hub', BUYER, { bookingId: 'RB_conf' });
    ck('status "confirmed" IS payable (guard is not refuse-all)', r.ok, r.ok ? '' : r.msg);
  }
  {
    setDoc('rentalBookings/RB_paid', { buyerId: BUYER, status: 'pending', paymentStatus: 'paid', totalAmount: 4500 });
    const r = await quote('car_hub', BUYER, { bookingId: 'RB_paid' });
    ck('an already-paid rental is refused', !r.ok && r.code === 'already-exists', r.code);
  }
  {
    setDoc('rentalBookings/RB_absent', { buyerId: BUYER, status: 'pending', totalAmount: 4500 });
    const r = await quote('car_hub', BUYER, { bookingId: 'RB_absent' });
    ck('an ABSENT paymentStatus is treated as unpaid, not as paid', r.ok, r.ok ? '' : r.msg);
  }
  {
    setDoc('rentalBookings/RB_zero', { buyerId: BUYER, status: 'pending', totalAmount: 0 });
    const r = await quote('car_hub', BUYER, { bookingId: 'RB_zero' });
    ck('a zero-value rental is refused', !r.ok, r.code);
  }

  /* ══ accommodation ══════════════════════════════════════════════════════ */
  console.log('\n── accommodation: the legitimate path MUST succeed ──');
  setDoc('venueBookings/VB1', {
    customerId: BUYER, status: 'pending_payment', payment: { status: 'pending' },
    pricing: { total: 12500.5, deposit: 2500.1, currency: 'KES' },
    venueId: 'V3', date: '2026-10-02', slotKey: 'k1', bookingModel: 'hourly',
  });
  {
    reads = 0;
    const r = await quote('accommodation', BUYER, { bookingId: 'VB1' });
    ck('a pending_payment booking prices successfully', r.ok, r.ok ? '' : r.msg);
    ck('amount is pricing.total in cents, 2dp exact', r.ok && r.q.amountCents === 1250050,
       r.ok ? r.q.amountCents : '-');
    ck('the booking document WAS read', reads > 0, reads + ' reads');
    ck('resourceType is venueBooking', r.ok && r.q.resourceType === 'venueBooking');
    ck('venueId travels in metadata', r.ok && r.q.metadata.venueId === 'V3');
  }

  console.log('\n── accommodation: deposit is a PORTION, so total is charged ──');
  {
    const r = await quote('accommodation', BUYER, { bookingId: 'VB1' });
    ck('the charge equals total, not total+deposit',
       r.ok && r.q.amountCents === 1250050, r.ok ? r.q.amountCents : '-');
    ck('deposit is reported separately in cents',
       r.ok && r.q.metadata.deposit === 250010, r.ok ? r.q.metadata.deposit : '-');
  }

  console.log('\n── accommodation: refusals ──');
  {
    const r = await quote('accommodation', OTHER, { bookingId: 'VB1' });
    ck('another user cannot price my booking', !r.ok && r.code === 'permission-denied', r.code);
  }
  {
    const r = await quote('accommodation', BUYER, { bookingId: 'NOPE' });
    ck('an unknown booking is refused', !r.ok && r.code === 'not-found', r.code);
  }
  for (const st of ['checked_in', 'completed', 'cancelled', 'no_show']) {
    setDoc('venueBookings/VB_' + st, {
      customerId: BUYER, status: st, payment: { status: 'pending' },
      pricing: { total: 100, currency: 'KES' },
    });
    const r = await quote('accommodation', BUYER, { bookingId: 'VB_' + st });
    ck('status "' + st + '" cannot be paid', !r.ok && r.code === 'failed-precondition', r.code);
  }
  {
    setDoc('venueBookings/VB_conf', {
      customerId: BUYER, status: 'confirmed', payment: { status: 'pending' },
      pricing: { total: 100, currency: 'KES' },
    });
    const r = await quote('accommodation', BUYER, { bookingId: 'VB_conf' });
    ck('status "confirmed" IS payable (guard is not refuse-all)', r.ok, r.ok ? '' : r.msg);
  }
  {
    setDoc('venueBookings/VB_paid', {
      customerId: BUYER, status: 'confirmed', payment: { status: 'paid' },
      pricing: { total: 100, currency: 'KES' },
    });
    const r = await quote('accommodation', BUYER, { bookingId: 'VB_paid' });
    ck('an already-paid booking is refused', !r.ok && r.code === 'already-exists', r.code);
  }
  {
    setDoc('venueBookings/VB_nopricing', {
      customerId: BUYER, status: 'confirmed', payment: { status: 'pending' },
    });
    const r = await quote('accommodation', BUYER, { bookingId: 'VB_nopricing' });
    ck('a booking with no pricing snapshot is refused', !r.ok, r.code);
  }

  /* ══ Shared registry contract ═══════════════════════════════════════════ */
  console.log('\n── Registry bounds apply to the new purposes ──');
  {
    setDoc('rentalBookings/RB_huge', { buyerId: BUYER, status: 'pending', totalAmount: 200000 });
    const r = await quote('car_hub', BUYER, { bookingId: 'RB_huge' });
    ck('above MAX_KES is refused', !r.ok && r.code === 'failed-precondition',
       r.code + ' (max ' + purposes.MAX_KES + ')');
  }
  {
    setDoc('venueBookings/VB_tiny', {
      customerId: BUYER, status: 'confirmed', payment: { status: 'pending' },
      pricing: { total: 0.004, currency: 'KES' },
    });
    const r = await quote('accommodation', BUYER, { bookingId: 'VB_tiny' });
    ck('below MIN_KES is refused', !r.ok, r.code + ' (min ' + purposes.MIN_KES + ')');
  }

  console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  /* A crash is NOT a refusal and must never read as a pass. */
  console.error('\n  HARNESS CRASHED — this is a FAILURE, not a refusal:\n', e);
  process.exit(2);
});
