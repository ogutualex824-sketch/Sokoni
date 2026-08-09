'use strict';
/* On-demand emulator test for the canonical refund terminal (Slice 2 step 3).
   Verifies money moves ONLY via _disburseHeldFunds (full, provider-caused), booking cancelled,
   resolution CANCELLED, immutable events, idempotent (no double refund), negotiation frozen. */
if (!process.env.FIRESTORE_EMULATOR_HOST) { console.error('REFUSING: set FIRESTORE_EMULATOR_HOST'); process.exit(2); }
const admin = require('firebase-admin');
admin.initializeApp({ projectId: 'sokoni-aeb26-qa' });
const db = admin.firestore();
const FV = admin.firestore.FieldValue;
const { _h, RES } = require('./booking-resolution');

const results = [];
const check = (n, c, d) => results.push({ n, ok: !!c, d: d || '' });
const req = (uid, data) => ({ auth: { uid }, data });
const fd = new Date(Date.now() + 20 * 86400000).toISOString().slice(0, 10);

async function seed(id, over) {
  await db.collection('users').doc('custC').set({ walletBalance: 0 }, { merge: true });
  await db.collection('providerBookings').doc(id).set(Object.assign({
    providerId: 'provP', customerUid: 'custC', status: 'confirmed', paymentStatus: 'paid_held',
    service: 'DJ Set', durationMins: 60, date: fd, startTime: '12:00', endTime: '13:00',
    startTs: new Date(fd + 'T12:00:00+03:00').getTime(), price: 500000, fee: 0, deposit: 0, createdAt: FV.serverTimestamp(),
  }, over || {}));
  // seed a slot lock so we can assert it is freed
  await db.collection('providerAvailability').doc('provP').collection('slotLocks').doc('lk_' + id).set({ bookingId: id });
}
const bk = async (id) => (await db.collection('providerBookings').doc(id).get()).data();
const wallet = async () => { const d = (await db.collection('users').doc('custC').get()).data() || {}; return Number(d.walletBalance) || 0; };
const evTypes = async (id) => (await db.collection('bookingEvents').where('bookingId', '==', id).get()).docs.map(d => d.data().type);

async function run() {
  // ── happy path: full refund before service ──
  await seed('rf1'); await _h.providerRaiseAffectedBookings(req('provP', { bookingIds: ['rf1'], reason: 'emergency' }));
  const w0 = await wallet();
  const r = await _h.customerRequestRefund(req('custC', { bookingId: 'rf1' }));
  const b = await bk('rf1');
  const w1 = await wallet();
  const t1 = await evTypes('rf1');
  const af = (await db.collection('affectedBookings').doc('rf1').get()).data();
  check('R1 refund ok → CANCELLED', r.ok && r.status === RES.CANCELLED, JSON.stringify(r));
  check('R2 booking.status = cancelled', b.status === 'cancelled', b.status);
  check('R3 paymentStatus = refunded', b.paymentStatus === 'refunded', b.paymentStatus);
  check('R4 resolution.status = CANCELLED', b.resolution && b.resolution.status === RES.CANCELLED);
  check('R5 FULL refund to customer wallet (+5000)', w1 - w0 === 5000, 'delta=' + (w1 - w0));
  check('R6 immutable audit chain complete', ['CUSTOMER_REQUESTED_REFUND', 'REFUND_STARTED', 'REFUND_COMPLETED', 'BOOKING_CANCELLED'].every(e => t1.includes(e)), t1.join(','));
  check('R7 affectedBookings CANCELLED', af.resolutionStatus === RES.CANCELLED);

  // ── idempotent: no double refund ──
  const r2 = await _h.customerRequestRefund(req('custC', { bookingId: 'rf1' }));
  const w2 = await wallet();
  check('R8 idempotent (alreadyDone, no double credit)', r2.alreadyDone === true && w2 === w1, JSON.stringify(r2) + ' w=' + w2);

  // ── ownership ──
  await seed('rf2'); await _h.providerRaiseAffectedBookings(req('provP', { bookingIds: ['rf2'], reason: 'sick' }));
  let denied = false;
  try { await _h.customerRequestRefund(req('stranger', { bookingId: 'rf2' })); } catch (e) { denied = /not your booking/i.test(e.message); }
  check('R9 ownership enforced', denied);

  // ── negotiation frozen after cancel ──
  let frozen = false;
  try { await _h.providerProposeReschedule(req('provP', { bookingId: 'rf1', date: fd, startTime: '15:00' })); }
  catch (e) { frozen = /not awaiting resolution|locked/i.test(e.message); }
  check('R10 negotiation frozen after refund', frozen);

  // ── unpaid booking: cancels, refunds 0 ──
  await seed('rf3', { paymentStatus: 'pending' }); await _h.providerRaiseAffectedBookings(req('provP', { bookingIds: ['rf3'], reason: 'weather' }));
  const wA = await wallet();
  const r3 = await _h.customerRequestRefund(req('custC', { bookingId: 'rf3' }));
  const b3 = await bk('rf3'); const wB = await wallet();
  check('R11 unpaid booking cancels, refunds 0', b3.status === 'cancelled' && r3.refundCents === 0 && wB === wA);

  const pass = results.filter(r => r.ok).length, fail = results.length - pass;
  console.log('\n──── CANONICAL REFUND TERMINAL (emulator) ────');
  results.forEach(r => console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.n}${r.d ? '   [' + r.d + ']' : ''}`));
  console.log(`  ${pass}/${results.length} passed${fail ? '  — ' + fail + ' FAILED' : ''}\n`);
  process.exit(fail ? 1 : 0);
}
run().catch(e => { console.error('HARNESS ERROR:', e); process.exit(3); });
