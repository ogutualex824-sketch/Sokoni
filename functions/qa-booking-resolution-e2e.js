'use strict';
/* On-demand emulator test for the booking resolution engine (Slice 2 step 1).
   Runs the REAL providerRaiseAffectedBookings / providerListAffectedBookings against a live
   Firestore emulator. Refuses to run without FIRESTORE_EMULATOR_HOST. */
if (!process.env.FIRESTORE_EMULATOR_HOST) { console.error('REFUSING: set FIRESTORE_EMULATOR_HOST'); process.exit(2); }
const admin = require('firebase-admin');
admin.initializeApp({ projectId: 'sokoni-aeb26-qa' });
const db = admin.firestore();
const FV = admin.firestore.FieldValue;
const { _h, RES } = require('./booking-resolution');

const results = [];
const check = (name, cond, detail) => results.push({ name, ok: !!cond, detail: detail || '' });

async function seedBooking(id, over) {
  await db.collection('providerBookings').doc(id).set(Object.assign({
    providerId: 'provP', customerUid: 'custC', status: 'confirmed', paymentStatus: 'paid_held',
    service: 'DJ Set', date: '2026-08-10', startTime: '14:00', endTime: '16:00',
    startTs: new Date('2026-08-10T14:00:00+03:00').getTime(), price: 500000, createdAt: FV.serverTimestamp(),
  }, over || {}));
}
const req = (uid, data) => ({ auth: { uid }, data });

async function run() {
  // ── raise a confirmed booking ──
  await seedBooking('bk1');
  const r1 = await _h.providerRaiseAffectedBookings(req('provP', { bookingIds: ['bk1'], reason: 'sick' }));
  const b1 = (await db.collection('providerBookings').doc('bk1').get()).data();
  const af1 = await db.collection('affectedBookings').doc('bk1').get();
  const ev1 = await db.collection('bookingEvents').where('bookingId', '==', 'bk1').get();
  const evTypes = ev1.docs.map(d => d.data().type).sort();
  check('R1 raisedCount=1', r1.raisedCount === 1, JSON.stringify(r1));
  check('R2 resolution.status=ACTION_REQUIRED', b1.resolution && b1.resolution.status === RES.ACTION_REQUIRED);
  check('R3 reason stored', b1.resolution && b1.resolution.reason === 'sick');
  check('R4 CORE status UNTOUCHED (still confirmed)', b1.status === 'confirmed', 'status=' + b1.status);
  check('R5 HELD PAYMENT UNTOUCHED (paid_held)', b1.paymentStatus === 'paid_held', 'pay=' + b1.paymentStatus);
  check('R6 affectedBookings row created', af1.exists && af1.data().resolutionStatus === RES.ACTION_REQUIRED);
  check('R7 three immutable events emitted', ev1.size === 3, 'types=' + evTypes.join(','));
  check('R8 events carry both participants', ev1.docs.every(d => d.data().providerId === 'provP' && d.data().customerUid === 'custC'));

  // ── idempotent: raising again is a no-op, no duplicate events ──
  const r2 = await _h.providerRaiseAffectedBookings(req('provP', { bookingIds: ['bk1'], reason: 'sick' }));
  const ev2 = await db.collection('bookingEvents').where('bookingId', '==', 'bk1').get();
  check('R9 idempotent (raisedCount=0, skipped already)', r2.raisedCount === 0 && r2.skipped[0] && r2.skipped[0].reason === 'already', JSON.stringify(r2));
  check('R10 no duplicate events after replay', ev2.size === 3, 'size=' + ev2.size);

  // ── ownership: a different provider cannot raise someone else's booking ──
  await seedBooking('bk2');
  const r3 = await _h.providerRaiseAffectedBookings(req('provOTHER', { bookingIds: ['bk2'], reason: 'weather' }));
  const b2 = (await db.collection('providerBookings').doc('bk2').get()).data();
  check('R11 ownership enforced (skipped not-owner)', r3.raisedCount === 0 && r3.skipped[0].reason === 'not-owner');
  check('R12 non-owner attempt left booking clean', !b2.resolution);

  // ── terminal booking is skipped ──
  await seedBooking('bk3', { status: 'completed' });
  const r4 = await _h.providerRaiseAffectedBookings(req('provP', { bookingIds: ['bk3'], reason: 'sick' }));
  check('R13 terminal booking skipped', r4.raisedCount === 0 && r4.skipped[0].reason === 'terminal');

  // ── invalid reason rejected ──
  let rejected = false;
  try { await _h.providerRaiseAffectedBookings(req('provP', { bookingIds: ['bk1'], reason: 'because' })); }
  catch (e) { rejected = /valid reason/i.test(e.message); }
  check('R14 invalid reason rejected', rejected);

  // ── provider queue lists ACTION_REQUIRED ──
  const list = await _h.providerListAffectedBookings(req('provP', {}));
  check('R15 provider queue lists the raised booking', list.count === 1 && list.items[0].id === 'bk1', 'count=' + list.count);

  const pass = results.filter(r => r.ok).length, fail = results.length - pass;
  console.log('\n──── BOOKING RESOLUTION ENGINE (emulator) ────');
  results.forEach(r => console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? '   [' + r.detail + ']' : ''}`));
  console.log(`  ${pass}/${results.length} passed${fail ? '  — ' + fail + ' FAILED' : ''}\n`);
  process.exit(fail ? 1 : 0);
}
run().catch(e => { console.error('HARNESS ERROR:', e); process.exit(3); });
