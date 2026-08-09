'use strict';
/* On-demand emulator test for the resolution NEGOTIATION state machine (Slice 2 step 2).
   Runs the REAL propose/accept/decline/suggest/approve ops (which reuse _prepareSlot +
   providerRescheduleBooking) against a live Firestore emulator. */
if (!process.env.FIRESTORE_EMULATOR_HOST) { console.error('REFUSING: set FIRESTORE_EMULATOR_HOST'); process.exit(2); }
const admin = require('firebase-admin');
admin.initializeApp({ projectId: 'sokoni-aeb26-qa' });
const db = admin.firestore();
const FV = admin.firestore.FieldValue;
const { _h, RES } = require('./booking-resolution');

const results = [];
const check = (n, c, d) => results.push({ n, ok: !!c, d: d || '' });
const req = (uid, data) => ({ auth: { uid }, data });
const futureDate = (days) => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);

async function seedAvailability(pid) {
  // permissive config so _prepareSlot accepts any future time (open 24/7, same-day allowed, no notice)
  await db.collection('providerAvailability').doc(pid).set({
    uid: pid, modes: ['open_24_7'],
    appt: { durationMins: 60, bufferMins: 0, minNoticeHours: 0, allowSameDay: true, allowAfterHours: true, maxDaysAhead: 365 },
    cap: {}, schedule: {},
  });
}
async function seedBooking(id, over) {
  await db.collection('providerBookings').doc(id).set(Object.assign({
    providerId: 'provP', customerUid: 'custC', status: 'confirmed', paymentStatus: 'paid_held',
    service: 'DJ Set', durationMins: 60, date: futureDate(20), startTime: '12:00', endTime: '13:00',
    startTs: new Date(futureDate(20) + 'T12:00:00+03:00').getTime(), price: 500000, createdAt: FV.serverTimestamp(),
  }, over || {}));
}
async function raise(id) { return _h.providerRaiseAffectedBookings(req('provP', { bookingIds: [id], reason: 'sick' })); }
async function evTypes(id) { const s = await db.collection('bookingEvents').where('bookingId', '==', id).get(); return s.docs.map(d => d.data().type); }
async function bk(id) { return (await db.collection('providerBookings').doc(id).get()).data(); }

async function run() {
  await seedAvailability('provP');

  // ── provider proposes ──
  await seedBooking('n1'); await raise('n1');
  const p1 = await _h.providerProposeReschedule(req('provP', { bookingId: 'n1', date: futureDate(25), startTime: '15:00' }));
  const b1 = await bk('n1');
  check('N1 proposal set (pending_customer)', b1.resolution.proposal && b1.resolution.proposal.status === 'pending_customer' && b1.resolution.proposal.by === 'provider', JSON.stringify(p1));
  check('N2 PROVIDER_PROPOSED_RESCHEDULE emitted', (await evTypes('n1')).includes('PROVIDER_PROPOSED_RESCHEDULE'));

  // ── single active proposal ──
  let dup = false;
  try { await _h.providerProposeReschedule(req('provP', { bookingId: 'n1', date: futureDate(26), startTime: '16:00' })); }
  catch (e) { dup = /already pending/i.test(e.message); }
  check('N3 single active proposal enforced', dup);

  // ── ownership: customer cannot use the provider op; stranger cannot respond ──
  let owned = false;
  try { await _h.providerProposeReschedule(req('custC', { bookingId: 'n1', date: futureDate(26), startTime: '16:00' })); }
  catch (e) { owned = /not your booking/i.test(e.message); }
  check('N4 ownership: customer blocked from provider-propose', owned);
  let wrongResp = false;
  try { await _h.customerRespondToProposal(req('someoneElse', { bookingId: 'n1', action: 'accept' })); }
  catch (e) { wrongResp = /not your booking/i.test(e.message); }
  check('N5 ownership: stranger cannot respond', wrongResp);

  // ── customer declines → proposal cleared, back to ACTION_REQUIRED ──
  const dec = await _h.customerRespondToProposal(req('custC', { bookingId: 'n1', action: 'decline' }));
  const b1d = await bk('n1');
  check('N6 decline clears proposal', !b1d.resolution.proposal && dec.status === RES.ACTION_REQUIRED);
  check('N7 CUSTOMER_DECLINED emitted', (await evTypes('n1')).includes('CUSTOMER_DECLINED'));

  // ── re-propose then customer ACCEPTS → reschedule via canonical engine ──
  await _h.providerProposeReschedule(req('provP', { bookingId: 'n1', date: futureDate(28), startTime: '09:00' }));
  const acc = await _h.customerRespondToProposal(req('custC', { bookingId: 'n1', action: 'accept' }));
  const b1a = await bk('n1');
  check('N8 accepted → resolution RESCHEDULED', acc.status === RES.RESCHEDULED && b1a.resolution.status === RES.RESCHEDULED);
  check('N9 booking MOVED to accepted time', b1a.date === futureDate(28) && b1a.startTime === '09:00', b1a.date + ' ' + b1a.startTime);
  check('N10 CORE status still confirmed', b1a.status === 'confirmed', b1a.status);
  check('N11 HELD PAYMENT still paid_held', b1a.paymentStatus === 'paid_held', b1a.paymentStatus);
  const t1 = await evTypes('n1');
  check('N12 CUSTOMER_ACCEPTED + BOOKING_RESCHEDULED emitted', t1.includes('CUSTOMER_ACCEPTED') && t1.includes('BOOKING_RESCHEDULED'));
  const af1 = (await db.collection('affectedBookings').doc('n1').get()).data();
  check('N13 affectedBookings marked RESCHEDULED', af1.resolutionStatus === RES.RESCHEDULED && !af1.proposal);

  // ── customer SUGGESTS, provider APPROVES → reschedule ──
  await seedBooking('n2'); await raise('n2');
  await _h.customerProposeTime(req('custC', { bookingId: 'n2', date: futureDate(22), startTime: '14:00' }));
  const b2 = await bk('n2');
  check('N14 customer proposal pending_provider', b2.resolution.proposal.status === 'pending_provider' && b2.resolution.proposal.by === 'customer');
  const apr = await _h.providerRespondToCustomerProposal(req('provP', { bookingId: 'n2', action: 'accept' }));
  const b2a = await bk('n2');
  check('N15 provider approved → RESCHEDULED + moved', apr.status === RES.RESCHEDULED && b2a.date === futureDate(22) && b2a.startTime === '14:00');
  const t2 = await evTypes('n2');
  check('N16 PROVIDER_ACCEPTED_TIME + BOOKING_RESCHEDULED emitted', t2.includes('PROVIDER_ACCEPTED_TIME') && t2.includes('BOOKING_RESCHEDULED'));

  const pass = results.filter(r => r.ok).length, fail = results.length - pass;
  console.log('\n──── BOOKING NEGOTIATION STATE MACHINE (emulator) ────');
  results.forEach(r => console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.n}${r.d ? '   [' + r.d + ']' : ''}`));
  console.log(`  ${pass}/${results.length} passed${fail ? '  — ' + fail + ' FAILED' : ''}\n`);
  process.exit(fail ? 1 : 0);
}
run().catch(e => { console.error('HARNESS ERROR:', e); process.exit(3); });
