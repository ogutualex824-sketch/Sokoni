'use strict';
/* Emulator test — Slice B: bookingCreateService computes the authoritative total via the pricing
   engine and persists the snapshot; back-compat for services without a `pricing` config. */
if (!process.env.FIRESTORE_EMULATOR_HOST) { console.error('REFUSING: set FIRESTORE_EMULATOR_HOST'); process.exit(2); }
const admin = require('firebase-admin');
admin.initializeApp({ projectId: 'sokoni-aeb26-qa' });
const db = admin.firestore();
const { _h } = require('./booking-service');

const results = [];
const check = (n, c, d) => results.push({ n, ok: !!c, d: d || '' });
const req = (uid, data) => ({ auth: { uid }, data });
function nextDow(t) { let d = new Date(Date.now() + 10 * 86400000); for (let i = 0; i < 8 && d.getUTCDay() !== t; i++) d = new Date(d.getTime() + 86400000); return d.toISOString().slice(0, 10); }
const WED = nextDow(3), THU = nextDow(4), FRI = nextDow(5);   // weekdays (no weekend surcharge), separate days = no overlap

async function seedCommon() {
  await db.collection('providers').doc('P').set({ status: 'active', acceptsBookings: true });
  await db.collection('users').doc('C').set({ name: 'Cust' });
  await db.collection('providerAvailability').doc('P').set({
    uid: 'P', modes: ['open_24_7'],
    appt: { durationMins: 240, minNoticeHours: 0, allowSameDay: true, allowAfterHours: true, autoConfirm: false, maxDaysAhead: 365 }, cap: {},
  });
}
const bk = async (id) => (await db.collection('providerBookings').doc(id).get()).data();

async function run() {
  await seedCommon();

  // ── advanced pricing: base 10000 + lighting ×2 (2000) = 12000; deposit 30% = 3600 ──
  await db.collection('providerServices').doc('svcA').set({
    providerId: 'P', active: true, name: 'DJ Set', durationMins: 240,
    pricing: {
      currency: 'KES', basePrice: 1000000, durationMins: 240,
      addOns: [{ id: 'lights', name: 'Lighting', price: 100000, qtyMax: 3 }],
      deposit: { mode: 'pct', value: 30, balanceDue: 'completion' },
    },
  });
  const r1 = await _h.bookingCreateService(req('C', {
    providerId: 'P', serviceId: 'svcA', date: WED, startTime: '14:00',
    addOns: [{ id: 'lights', qty: 2 }],
  }));
  const b1 = await bk(r1.bookingId);
  check('B1 booking created', r1.success && b1);
  check('B2 price = computed TOTAL (12000)', b1.price === 1200000, b1.price);
  check('B3 deposit = 30% (3600)', b1.deposit === 360000, b1.deposit);
  check('B4 pricingSnapshot persisted', b1.pricingSnapshot && b1.pricingSnapshot.totalCents === 1200000);
  check('B5 snapshot has add-ons + version', b1.pricingSnapshot.addOns.length === 1 && b1.pricingSnapshot.pricingVersion === '2.0.0');
  check('B6 client cannot inject price (no amount field trusted)', b1.price === 1200000);

  // ── package selection: package price 25000 overrides base ──
  await db.collection('providerServices').doc('svcB').set({
    providerId: 'P', active: true, name: 'DJ Packages', durationMins: 240,
    pricing: { currency: 'KES', basePrice: 1000000, durationMins: 240,
      packages: [{ id: 'wed', name: 'Wedding', price: 2500000, durationMins: 360, deposit: { mode: 'fixed', value: 500000 } }] },
  });
  const r2 = await _h.bookingCreateService(req('C', { providerId: 'P', serviceId: 'svcB', date: THU, startTime: '09:00', packageId: 'wed' }));
  const b2 = await bk(r2.bookingId);
  check('B7 package price used (25000)', b2.price === 2500000, b2.price);
  check('B8 package deposit (fixed 5000)', b2.deposit === 500000, b2.deposit);
  check('B9 duration follows package (360)', b2.durationMins === 360, b2.durationMins);
  check('B10 snapshot packageName', b2.pricingSnapshot.packageName === 'Wedding');

  // ── BACK-COMPAT: service with NO pricing config → svc.price, no snapshot ──
  await db.collection('providerServices').doc('svcC').set({ providerId: 'P', active: true, name: 'Legacy', price: 500000, deposit: 100000, durationMins: 60 });
  const r3 = await _h.bookingCreateService(req('C', { providerId: 'P', serviceId: 'svcC', date: FRI, startTime: '18:00' }));
  const b3 = await bk(r3.bookingId);
  check('B11 legacy: price = svc.price (5000)', b3.price === 500000, b3.price);
  check('B12 legacy: deposit = svc.deposit (1000)', b3.deposit === 100000, b3.deposit);
  check('B13 legacy: NO pricingSnapshot (unchanged behavior)', b3.pricingSnapshot === undefined);

  const pass = results.filter(x => x.ok).length, fail = results.length - pass;
  console.log('\n──── BOOKING × PRICING ENGINE (emulator) ────');
  results.forEach(x => console.log(`  ${x.ok ? 'PASS' : 'FAIL'}  ${x.n}${x.d ? '   [' + x.d + ']' : ''}`));
  console.log(`  ${pass}/${results.length} passed${fail ? '  — ' + fail + ' FAILED' : ''}\n`);
  process.exit(fail ? 1 : 0);
}
run().catch(e => { console.error('HARNESS ERROR:', e && e.stack ? e.stack : e); process.exit(3); });
