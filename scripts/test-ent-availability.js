/* test-ent-availability.js — the ONE Entertainment availability authority (2026-09-27).
 *
 * The REAL modules (ent-availability, its pure core, booking-service, booking.js, provider-ops,
 * booking-payment-sweep, venue-payments, availability.js, venue-booking.js, provider-hub,
 * subscription-core) on the transactional fake Firestore (optimistic retry, strict read order).
 * No network, no provider, no production.
 *
 * PROVES
 *   Decisions     buffers close the time around a booking; BOOKING_NOT_OPEN ≠ UNAVAILABLE; the public
 *                 sees only { start, end, state } — never who, why, a label or a reference
 *   Concurrency   12 buyers race the SAME slot → exactly 1 booking; 12 race OVERLAPPING windows → 1;
 *                 venue engine the same; no duplicate hold, envelope or PIN
 *   Lifecycle     hold → (payment confirmed) BOOKED → (canonical cancel) AVAILABLE; a refund REQUEST
 *                 never reopens; cooldown policy → UNAVAILABLE; a payment in flight keeps the slot
 *   Reschedule    atomic: the new time is taken and the old opens in one commit; a refused move
 *                 changes nothing
 *   Isolation     one provider's booking never blocks another's calendar
 *   Gates         unverified / suspended / pending providers take no public bookings; Premium settings
 *                 are refused without the plan and ignored if written directly; the horizon is enforced
 *   Legacy        reserveSlot / venueCreateBooking / bookingHoldSlot retired; holds are owner-only
 *   AdminOS       inspection (labels only for a super admin); interventions need a super admin + reason
 *
 *   node scripts/test-ent-availability.js
 */
'use strict';
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:1';
process.env.GCLOUD_PROJECT = 'demo-ent-availability';
delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
delete process.env.K_SERVICE; delete process.env.FUNCTION_TARGET;

const Path = require('path');
const ROOT = Path.resolve(__dirname, '..');
const FN = Path.join(ROOT, 'functions');
const { makeFakeFirestore } = require('./lib/fake-firestore-txn');
const REAL_NOW = Date.now();
let NOW = REAL_NOW;
const F = makeFakeFirestore({ clock: () => NOW, strictReadOrder: true });
const db = F.db;
const say = console.log;
console.log = console.info = console.warn = console.debug = () => {};
const resolveIn = (m) => require.resolve(m, { paths: [FN] });
const stub = (m, exp) => { const p = m.startsWith('./') ? Path.join(FN, m + '.js') : resolveIn(m); require.cache[p] = { id: p, filename: p, loaded: true, exports: exp }; };
const authApi = { getUser: async (u) => ({ uid: u, customClaims: {} }) };
const ADMIN = { apps: [{}], initializeApp: () => ({}), app: () => ({}),
  firestore: Object.assign(() => db, { FieldValue: F.FieldValue, Timestamp: F.Timestamp, FieldPath: F.FieldPath }), auth: () => authApi, storage: () => ({ bucket: () => ({}) }) };
stub('firebase-admin/firestore', { getFirestore: () => db, FieldValue: F.FieldValue, Timestamp: F.Timestamp, FieldPath: F.FieldPath });
stub('firebase-admin/auth', { getAuth: () => authApi });
stub('firebase-admin', ADMIN);
stub('./notify', { notify: async () => ({ ok: true }), TYPES: {} });

const CORE = require(Path.join(FN, 'shared', 'ent-availability-core.js'));
const AV = require(Path.join(FN, 'ent-availability.js'));
const BS = require(Path.join(FN, 'booking-service.js'));
const PO = require(Path.join(FN, 'provider-ops.js'));
const SW = require(Path.join(FN, 'booking-payment-sweep.js'));
const BK = require(Path.join(FN, 'booking.js'));
const AVL = require(Path.join(FN, 'availability.js'));
const VBK = require(Path.join(FN, 'venue-booking.js'));
const VP = require(Path.join(FN, 'venue-payments.js'));
AV._setClock(() => NOW);

let pass = 0, fail = 0;
const ck = (l, ok, d) => { say('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined && d !== '' ? '   [' + String(typeof d === 'object' ? JSON.stringify(d) : d).slice(0, 170) + ']' : '')); ok ? pass++ : fail++; };
const who = (uid, token = {}) => ({ auth: uid ? { uid, token } : null, rawRequest: { headers: {} } });
async function code(p) { try { await p; return null; } catch (e) { return e.code || e.message; } }
async function err(p) { try { await p; return null; } catch (e) { return e; } }
/* the refusal's code (details.code, else the error code); null when the call SUCCEEDED — never a crash */
async function errCode(p) { const e = await err(p); return e ? ((e.details && e.details.code) || e.code || 'error') : null; }
const get = async (p) => { const s = await db.doc(p).get(); return s.exists ? s.data() : null; };
const H = 3600e3; const M = 60e3;
const today = CORE.dateOf(REAL_NOW);
const D10 = CORE.addDays(today, 10);           /* a date well inside every horizon */
const WEEK = {}; ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'].forEach((d) => { WEEK[d] = { closed: false, periods: [{ open: '08:00', close: '20:00' }], breaks: [] }; });
const cfgDoc = (extra) => Object.assign({ uid: 'x', modes: ['fixed_hours'], schedule: WEEK,
  appt: { enabled: true, durationMins: 60, bufferMins: 0, travelMins: 0, maxDaysAhead: 90, minNoticeHours: 1, allowSameDay: true }, cap: {} }, extra || {});
const at = (date, hhmm) => CORE.dayStartMs(date) + CORE.toMins(hhmm) * M;
const itemsOf = async (calKey, month) => ((await get(`entAvailability/${calKey}/months/${month}`)) || { items: [] }).items;

async function seedProvider(uid, opts) {
  const o = opts || {};
  await db.doc(`providers/${uid}`).set({ name: uid, status: o.status || 'active', approvedAt: 1, category: o.category || 'photographer', acceptsBookings: true });
  if (o.decided !== false) await db.doc(`applications/app_${uid}`).set({ uid, status: 'approved', role: 'provider', category: o.category || 'photographer' });
  await db.doc(`providerAvailability/${uid}`).set(cfgDoc(o.cfg));
  await db.doc(`providerServices/svc_${uid}`).set({ providerId: uid, name: 'Portrait session', price: 500000, fee: 0, deposit: 0, durationMins: 60, active: true });
  await db.doc(`providerServices/svc2_${uid}`).set({ providerId: uid, name: 'Half-day coverage', price: 2000000, fee: 0, deposit: 0, durationMins: 120, active: true });
  await db.doc(`users/${uid}`).set({ displayName: uid });
}
const book = (buyer, provider, svc, date, time, extra) => BS._h.bookingCreateService({ ...who(buyer), data: Object.assign({ providerId: provider, serviceId: svc, date, startTime: time }, extra || {}) });

(async () => {
  for (let i = 0; i < 16; i++) await db.doc(`users/b${i}`).set({ displayName: 'Buyer ' + i });

  /* ═══ 1. pure decisions ═══ */
  say('\n── the pure decisions (functions/shared/ent-availability-core.js) ──');
  {
    const cfg = CORE.normalizeConfig({ weekly: Array(7).fill([{ open: '08:00', close: '20:00' }]), durationMins: 60, stepMins: 30, bufferBeforeMins: 30, bufferAfterMins: 30, minNoticeMins: 0, horizonDays: 90 });
    const item = CORE.makeItem(cfg, { id: 'pb_x', kind: 'B', startMs: at(D10, '14:00'), endMs: at(D10, '16:00'), ref: 'providerBookings/x' });
    const slots = CORE.publicSlots(cfg, D10, [item], REAL_NOW);
    const st = (t) => (slots.find((s) => s.start === t) || {}).state;
    ck('a 14:00–16:00 booking closes 14:00, 15:00 AND 15:30 (every overlapping slot)', st('14:00') === 'BOOKED' && st('15:00') === 'BOOKED' && st('15:30') === 'BOOKED', { a: st('14:00'), b: st('15:00'), c: st('15:30') });
    ck('its 30-minute buffer closes 13:00 (ends inside the buffer) — shown as UNAVAILABLE, never "buffer"', st('13:00') === 'UNAVAILABLE' && st('13:30') === 'BOOKED', { a: st('13:00'), b: st('13:30') });
    ck('…and 16:30 opens again (the buffers meet, never overlap a booking)', st('16:30') === 'AVAILABLE', st('16:30'));
    ck('a public slot is exactly { start, end, state } — no id, no reason, no reference', slots.every((s) => Object.keys(s).sort().join(',') === 'end,start,state'));
    const block = CORE.makeItem(cfg, { id: 'blk_1', kind: 'X', startMs: at(D10, '09:00'), endMs: at(D10, '10:00'), label: 'Private wedding' });
    const pub = CORE.publicSlots(cfg, D10, [block], REAL_NOW);
    ck('a private block is UNAVAILABLE to the public and its label never appears', pub.find((s) => s.start === '09:00').state === 'UNAVAILABLE' && !JSON.stringify(pub).includes('wedding'));
    const priv = CORE.privateSlots(cfg, D10, [block], REAL_NOW);
    ck('…while the provider sees BLOCKED with their own label', priv.find((s) => s.start === '09:00').state === 'BLOCKED' && priv.find((s) => s.start === '09:00').items[0].label === 'Private wedding');
    const far = CORE.addDays(today, 120);
    ck('beyond the horizon is BOOKING_NOT_OPEN — a different state from UNAVAILABLE',
      CORE.dayState(cfg, far, CORE.publicSlots(cfg, far, [], REAL_NOW), REAL_NOW) === 'BOOKING_NOT_OPEN' && CORE.dayState(cfg, D10, CORE.publicSlots(cfg, D10, [], REAL_NOW), REAL_NOW) === 'AVAILABLE');
    const hold = CORE.makeItem(cfg, { id: 'pb_h', kind: 'H', startMs: at(D10, '11:00'), endMs: at(D10, '12:00') });
    ck('an unpaid hold is TEMPORARILY_HELD — not BOOKED, not AVAILABLE', CORE.publicSlots(cfg, D10, [hold], REAL_NOW).find((s) => s.start === '11:00').state === 'TEMPORARILY_HELD');
    const cfg2 = Object.assign({}, cfg, { capacity: 2 });
    ck('capacity 2 (multiple staff): one booking → LIMITED, not BOOKED', CORE.publicSlots(cfg2, D10, [item], REAL_NOW).find((s) => s.start === '14:00').state === 'LIMITED');
    ck('a refusal message never names the reason behind UNAVAILABLE', !/buffer|travel|block|private|wedding/i.test(CORE.refusalMessage('SLOT_UNAVAILABLE') + CORE.refusalMessage('OUTSIDE_HOURS')));
  }

  /* ═══ 2. views + gates ═══ */
  say('\n── public views and bookability gates ──');
  await seedProvider('ph1');                                       /* verified photographer */
  await seedProvider('ph2');                                       /* another provider — isolation */
  await seedProvider('dj0', { category: 'dj', decided: false });   /* presents as an artist, never approved */
  await seedProvider('sus', { status: 'suspended' });
  const mv = await AV._h.entAvailMonth({ ...who(null), data: { providerId: 'ph1', serviceId: 'svc_ph1', month: CORE.monthOf(D10) } });
  ck('a signed-out buyer gets the month as day states only', mv.bookable === true && mv.days[D10] === 'AVAILABLE' && Object.values(mv.days).every((s) => CORE.PUBLIC_STATE[s]));
  const next = `${Number(today.slice(0, 4)) + 1}-03`;
  const nv = await AV._h.entAvailMonth({ ...who(null), data: { providerId: 'ph1', month: next } });
  ck('next year is navigable; beyond a 90-day horizon it is BOOKING_NOT_OPEN, not UNAVAILABLE', Object.values(nv.days).every((s) => s === 'BOOKING_NOT_OPEN'));
  ck('three years ahead is refused (bounded navigation)', (await code(AV._h.entAvailMonth({ ...who(null), data: { providerId: 'ph1', month: `${Number(today.slice(0, 4)) + 3}-01` } }))) === 'invalid-argument');
  const un = await AV._h.entAvailMonth({ ...who(null), data: { providerId: 'dj0', month: CORE.monthOf(D10) } });
  ck('an UNVERIFIED artist takes no public bookings: every day UNAVAILABLE, and no reason given', un.bookable === false && Object.values(un.days).every((s) => s === 'UNAVAILABLE') && !JSON.stringify(un).includes('VERIFIED'));
  ck('…and cannot be booked directly either', (await code(book('b1', 'dj0', 'svc_dj0', D10, '10:00'))) === 'failed-precondition');
  ck('a SUSPENDED provider cannot be booked', (await code(book('b1', 'sus', 'svc_sus', D10, '10:00'))) === 'failed-precondition');
  await db.doc('applications/app_dj0').set({ uid: 'dj0', status: 'approved', role: 'provider', category: 'dj' });
  ck('after the application is APPROVED the artist becomes bookable', (await AV._h.entAvailMonth({ ...who(null), data: { providerId: 'dj0', month: CORE.monthOf(D10) } })).bookable === true);

  /* ═══ 3. the race ═══ */
  say('\n── 12+ buyers, one slot ──');
  const race = await Promise.allSettled(Array.from({ length: 12 }, (_, i) => book('b' + i, 'ph1', 'svc_ph1', D10, '10:00')));
  const won = race.filter((r) => r.status === 'fulfilled');
  const lost = race.filter((r) => r.status === 'rejected');
  ck('12 simultaneous customers, same provider · service · date · slot → exactly ONE booking', won.length === 1, { won: won.length });
  ck('…every other one is refused as already booked / unavailable', lost.length === 11 && lost.every((r) => r.reason.code === 'already-exists'), lost.map((r) => r.reason.code).slice(0, 3));
  const pbs = db._dump('providerBookings/').filter((b) => b.providerId === 'ph1' && b.date === D10 && b.status !== 'cancelled');
  const month = CORE.monthOf(D10);
  const it1 = (await itemsOf('svc_ph1', month)).filter((it) => it.k === 'H' || it.k === 'B');
  ck('no duplicate booking and no duplicate hold in the authority', pbs.length === 1 && it1.length === 1 && it1[0].k === 'H', { bookings: pbs.length, items: it1.length });
  const bookingId = won[0].value.bookingId;
  const b0 = await get('providerBookings/' + bookingId);
  ck('the booking carries its availability record (calKey · itemId · months)', b0.availability && b0.availability.calKey === 'svc_ph1' && b0.availability.itemId === 'pb_' + bookingId);
  const race2 = await Promise.allSettled([
    ...Array.from({ length: 6 }, (_, i) => book('b' + (i + 1), 'ph1', 'svc2_ph1', D10, '13:00')),
    ...Array.from({ length: 6 }, (_, i) => book('b' + (i + 7), 'ph1', 'svc_ph1', D10, '14:00'))]);
  ck('12 buyers race OVERLAPPING windows (13:00–15:00 vs 14:00–15:00) → exactly ONE wins (the slot lock alone could not)',
    race2.filter((r) => r.status === 'fulfilled').length === 1, race2.map((r) => r.status === 'fulfilled' ? 'ok' : r.reason.code).join(','));
  const dv = await AV._h.entAvailDay({ ...who(null), data: { providerId: 'ph1', serviceId: 'svc_ph1', date: D10 } });
  const s10 = dv.slots.find((s) => s.start === '10:00').state;
  ck('Buyer B now sees 10:00 as TEMPORARILY_HELD (payment in progress) — not AVAILABLE', s10 === 'TEMPORARILY_HELD', s10);
  ck('provider isolation: the other provider\'s 10:00 is still AVAILABLE', (await AV._h.entAvailDay({ ...who(null), data: { providerId: 'ph2', serviceId: 'svc_ph2', date: D10 } })).slots.find((s) => s.start === '10:00').state === 'AVAILABLE');
  ck('…and another buyer can book it', !!(await book('b3', 'ph2', 'svc_ph2', D10, '10:00')).bookingId);

  /* ═══ 4. payment → BOOKED ═══ */
  say('\n── payment confirmed → BOOKED ──');
  const winner = b0.customerUid;
  await db.doc('paymentIntents/SKNPAY001').set({ ref: 'SKNPAY001', resourceType: 'providerBooking', resourceId: bookingId, uid: winner, amount: 5000 });
  await SW.holdServiceBookingPayment(db, ADMIN, 'SKNPAY001', 'SKNPAY001', 5000);
  ck('the webhook\'s confirmation turns the hold into a BOOKING', (await itemsOf('svc_ph1', month)).find((it) => it.id === 'pb_' + bookingId).k === 'B');
  ck('Buyer B\'s view updates to BOOKED', (await AV._h.entAvailDay({ ...who(null), data: { providerId: 'ph1', serviceId: 'svc_ph1', date: D10 } })).slots.find((s) => s.start === '10:00').state === 'BOOKED');
  const PP = require(Path.join(FN, 'payment-purposes.js'));
  const svcPurpose = (PP.PURPOSES || PP.purposes || {}).service_booking;
  ck('no duplicate payment attempt: a paid booking cannot be priced again', !!svcPurpose && (await code(svcPurpose.price(winner, { bookingId }))) === 'already-exists');
  const pubDoc = await get(`entAvailabilityPublic/svc_ph1_${month}`);
  ck('the realtime signal moved, and it carries a counter — nothing else', pubDoc && pubDoc.rev >= 2 && Object.keys(pubDoc).sort().join(',') === 'calKey,month,rev,updatedAt', pubDoc && Object.keys(pubDoc));

  /* ═══ 5. cancel / refund ═══ */
  say('\n── the slot reopens ONLY on the canonical cancelled state ──');
  ck('another customer cannot cancel this booking', (await code(PO._h.providerCancelBooking({ ...who('b15'), data: { bookingId } }))) === 'permission-denied');
  ck('…still BOOKED', (await itemsOf('svc_ph1', month)).some((it) => it.id === 'pb_' + bookingId));
  await PO._h.providerCancelBooking({ ...who(winner), data: { bookingId, reason: 'plans changed' } });
  ck('the customer\'s canonical cancel → booking cancelled AND the time AVAILABLE again', (await get('providerBookings/' + bookingId)).status === 'cancelled' &&
    (await AV._h.entAvailDay({ ...who(null), data: { providerId: 'ph1', serviceId: 'svc_ph1', date: D10 } })).slots.find((s) => s.start === '10:00').state === 'AVAILABLE');
  /* cooldown policy */
  await db.doc('providerAvailability/ph2').set({ reopenAfterCancel: false }, { merge: true });
  const b2 = await book('b4', 'ph2', 'svc_ph2', D10, '15:00');
  await PO._h.providerCancelBooking({ ...who('ph2'), data: { bookingId: b2.bookingId } });
  ck('a provider whose policy is "no reopen after cancel" → the time shows UNAVAILABLE, not AVAILABLE',
    (await AV._h.entAvailDay({ ...who(null), data: { providerId: 'ph2', serviceId: 'svc_ph2', date: D10 } })).slots.find((s) => s.start === '15:00').state === 'UNAVAILABLE');

  /* ═══ 6. payment in flight keeps the slot ═══ */
  say('\n── a payment that may have succeeded keeps the slot ──');
  const b3 = await book('b5', 'ph1', 'svc_ph1', D10, '16:00');
  await db.doc('paymentIntents/SKNFLY01').set({ ref: 'SKNFLY01', resourceType: 'providerBooking', resourceId: b3.bookingId, uid: 'b5', status: 'created' });
  await db.doc('payments/SKNFLY01').set({ ref: 'SKNFLY01', uid: 'b5', status: 'PENDING' });
  const rel = await SW.releaseServiceHold(db, ADMIN, { bookingId: b3.bookingId, by: 'customer', ownerUid: 'b5', reason: 'customer-abandoned' });
  ck('the customer closing the sheet does NOT release a hold whose STK push is unanswered', rel.released === false && rel.reason === 'payment-in-flight');
  await db.doc('providerBookings/' + b3.bookingId).set({ expiresAt: F.Timestamp.fromMillis(REAL_NOW - 1) }, { merge: true });
  await SW.expireUnpaidServiceBookings(db);
  ck('the expiry timer does not reopen it either (flagged ambiguous instead)', (await get('providerBookings/' + b3.bookingId)).status !== 'cancelled' && !!(await get('providerBookings/' + b3.bookingId)).paymentAmbiguousSince &&
    (await itemsOf('svc_ph1', month)).some((it) => it.id === 'pb_' + b3.bookingId));
  await db.doc('payments/SKNFLY01').set({ status: 'FAILED' }, { merge: true });
  await SW.releaseServiceBookingOnTerminalPayment(db, ADMIN, 'SKNFLY01', 'SKNFLY01', 'FAILED');
  ck('the payment authority\'s terminal FAILED answer releases it → AVAILABLE', (await get('providerBookings/' + b3.bookingId)).status === 'cancelled' && !(await itemsOf('svc_ph1', month)).some((it) => it.id === 'pb_' + b3.bookingId));

  /* ═══ 7. reschedule ═══ */
  say('\n── atomic reschedule ──');
  const r1 = await book('b6', 'ph1', 'svc_ph1', D10, '08:00');
  const r2 = await book('b7', 'ph1', 'svc_ph1', D10, '12:00');
  ck('a move onto a BOOKED time is refused — and nothing moved', (await code(PO._h.providerRescheduleBooking({ ...who('b6'), data: { bookingId: r1.bookingId, date: D10, startTime: '12:00' } }))) === 'already-exists' &&
    (await itemsOf('svc_ph1', month)).find((it) => it.id === 'pb_' + r1.bookingId).s === at(D10, '08:00'));
  await PO._h.providerRescheduleBooking({ ...who('b6'), data: { bookingId: r1.bookingId, date: D10, startTime: '18:00' } });
  const afterMove = await AV._h.entAvailDay({ ...who(null), data: { providerId: 'ph1', serviceId: 'svc_ph1', date: D10 } });
  ck('a move to a free time: old 08:00 AVAILABLE, new 18:00 held — in one commit (one item, same id)', afterMove.slots.find((s) => s.start === '08:00').state === 'AVAILABLE' && afterMove.slots.find((s) => s.start === '18:00').state === 'TEMPORARILY_HELD' &&
    (await itemsOf('svc_ph1', month)).filter((it) => it.id === 'pb_' + r1.bookingId).length === 1);
  void r2;

  /* ═══ 8. provider blocks + private view ═══ */
  say('\n── provider controls (audited) ──');
  const bl = await AV._h.entAvailBlock({ ...who('ph1'), data: { date: D10, start: '09:00', end: '10:00', label: 'Private wedding — Westlands' } });
  ck('the provider blocks time with a PRIVATE label', !!bl.blockId);
  const pubAfter = await AV._h.entAvailDay({ ...who(null), data: { providerId: 'ph1', serviceId: 'svc_ph1', date: D10 } });
  ck('the public sees 09:00 UNAVAILABLE; nothing in the response says wedding, Westlands, a block or a booking', pubAfter.slots.find((s) => s.start === '09:00').state === 'UNAVAILABLE' && !/wedding|westlands|blk_|pb_|b6|b7/i.test(JSON.stringify(pubAfter)));
  ck('another provider cannot block (or read) this calendar', (await code(AV._h.entAvailBlock({ ...who('ph2'), data: { providerId: 'ph1', date: D10, start: '11:00', end: '12:00' } }))) === 'permission-denied' &&
    (await code(AV._h.entAvailProviderMonth({ ...who('ph2'), data: { providerId: 'ph1', month } }))) === 'permission-denied');
  ck('a block cannot be laid over a live booking (cancel it through its own authority)', (await code(AV._h.entAvailBlock({ ...who('ph1'), data: { date: D10, start: '12:00', end: '13:00' } }))) === 'failed-precondition');
  const pm = await AV._h.entAvailProviderMonth({ ...who('ph1'), data: { month } });
  ck('the provider\'s own month shows BOOKED / PENDING / BLOCKED with their label and booking references', pm.items.some((i) => i.kind === 'BLOCKED' && /wedding/.test(i.label)) && pm.items.some((i) => i.kind === 'PENDING' && /^providerBookings\//.test(i.ref)));
  await AV._h.entAvailUnblock({ ...who('ph1'), data: { blockId: bl.blockId, date: D10 } });
  ck('opening the time again → AVAILABLE', (await AV._h.entAvailDay({ ...who(null), data: { providerId: 'ph1', serviceId: 'svc_ph1', date: D10 } })).slots.find((s) => s.start === '09:00').state === 'AVAILABLE');
  ck('every change was audited', db._dump('entAvailabilityAudit/').filter((a) => a.calKey === 'svc_ph1' && ['block', 'open'].includes(a.action)).length === 2);

  /* ═══ 9. Premium ═══ */
  say('\n── Premium / Equipped settings are server-enforced ──');
  ck('without the plan, capacity 2 (multiple staff) is refused', (await errCode(AV._h.entAvailSetConfig({ ...who('ph2'), data: { config: { capacity: 2 } } }))) === 'PLAN_REQUIRED');
  ck('…and a 730-day horizon is refused (extended horizon)', (await errCode(AV._h.entAvailSetConfig({ ...who('ph2'), data: { config: { horizonDays: 730 } } }))) === 'PLAN_REQUIRED');
  await db.doc('providerAvailability/ph2').set({ cap: { maxSimultaneous: 3 }, appt: { maxDaysAhead: 700 } }, { merge: true });
  const clamped = await AV.loadCalendar('svc_ph2');
  ck('a Premium setting written DIRECTLY without the plan is ignored where it is used (capacity 1, base horizon)', clamped.cfg.capacity === 1 && clamped.cfg.horizonDays <= 365, { cap: clamped.cfg.capacity, h: clamped.cfg.horizonDays });
  await db.doc('providerSubscriptions/ph2').set({ plan: 'premium', status: 'active', expiryDate: new Date(REAL_NOW + 30 * 86400e3).toISOString() });
  AV._resetPolicy();
  ck('with the Premium plan the same settings are honoured', (await AV._h.entAvailSetConfig({ ...who('ph2'), data: { config: { capacity: 2, horizonDays: 500 } } })).ok === true && (await AV.loadCalendar('svc_ph2')).cfg.capacity === 2);
  await seedProvider('eq1');
  await db.doc('providerSubscriptions/eq1').set({ plan: 'equipped', status: 'active', expiryDate: new Date(REAL_NOW + 30 * 86400e3).toISOString() });
  ck('the EQUIPPED plan unlocks the same advanced settings (server-resolved, not a client flag)', (await AV._h.entAvailSetConfig({ ...who('eq1'), data: { config: { capacity: 3, horizonDays: 600, bufferBeforeMins: 15, bufferAfterMins: 45 } } })).ok === true &&
    (await AV.loadCalendar('svc_eq1')).cfg.capacity === 3 && (await AV.loadCalendar('svc_eq1')).cfg.bufferAfterMins === 45);
  await db.doc('providerSubscriptions/eq1').set({ status: 'cancelled' }, { merge: true });
  ck('…and a lapsed plan loses them at once (capacity back to 1, one buffer)', (await AV.loadCalendar('svc_eq1')).cfg.capacity === 1 && (await AV.loadCalendar('svc_eq1')).cfg.bufferBeforeMins === 45);
  /* CREATOR: film access needs no calendar; consultations / appearances use the SAME authority after approval */
  await db.doc('creators/cr1').set({ uid: 'cr1', state: 'ACTIVE', displayName: 'Kibera Films' });
  const crCfg = await AV._h.entAvailGetConfig({ ...who('cr1'), data: {} });
  ck('a creator who is not an approved provider has no public booking calendar (NOT_APPROVED — never a separate creator calendar)', crCfg.bookable.ok === false && crCfg.calKey === 'svc_cr1');
  await seedProvider('cr1', { category: 'influencer' });
  ck('once approved as an Entertainment provider, the creator\'s consultations are bookable on the one authority', (await AV.loadCalendar('svc_cr1')).bookable.ok === true && !!(await book('b2', 'cr1', 'svc_cr1', D10, '10:00')).bookingId);
  ck('per-service availability is Premium too', (await errCode(AV._h.entAvailSetServiceAvailability({ ...who('ph1'), data: { serviceId: 'svc_ph1', availability: { days: [1, 2] } } }))) === 'PLAN_REQUIRED');

  /* ═══ 10. horizon at booking ═══ */
  ck('a booking beyond the provider\'s horizon is refused as BOOKING_NOT_OPEN', (await errCode(book('b8', 'ph1', 'svc_ph1', CORE.addDays(today, 120), '10:00'))) === 'BOOKING_NOT_OPEN');

  /* ═══ 11. price race ═══ */
  say('\n── checkout: the price the buyer confirmed ──');
  const pr = await err(book('b9', 'ph1', 'svc_ph1', D10, '17:00', { expectedTotalCents: 400000 }));
  ck('a stale client total → "Price changed" with the authoritative total; nothing reserved', pr && pr.code === 'aborted' && pr.details.code === 'PRICE_CHANGED' && pr.details.totalCents === 500000 &&
    !(await itemsOf('svc_ph1', month)).some((it) => it.s === at(D10, '17:00')));
  ck('the confirmed authoritative total books', !!(await book('b9', 'ph1', 'svc_ph1', D10, '17:00', { expectedTotalCents: 500000 })).bookingId);

  /* ═══ 12. venue engine ═══ */
  say('\n── the venue engine uses the SAME authority ──');
  await db.doc('users/vo1').set({ displayName: 'Venue Owner' });
  const VOH = {}; ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].forEach((d) => { VOH[d] = { open: '08:00', close: '23:00', closed: false }; });
  await db.doc('venues/V1').set({ name: 'Karura Hall', ownerId: 'vo1', status: 'active', openingHours: VOH, slotDurationMins: 60, bookingHorizonDays: 730, pricing: { hourlyRate: 2000 }, totalBookings: 0 });
  await db.doc('venues/V0').set({ name: 'Pending Hall', ownerId: 'vo1', status: 'pending', openingHours: VOH, slotDurationMins: 60, pricing: {} });
  const vbook = (buyer, venueId, date, s, e) => BK._h.bookingCreate({ ...who(buyer), data: { venueId, date, startTime: s, endTime: e } });
  ck('a venue that is not approved (pending) takes no booking', (await code(vbook('b1', 'V0', D10, '10:00', '12:00'))) === 'failed-precondition');
  const vr = await Promise.allSettled(Array.from({ length: 12 }, (_, i) => vbook('b' + i, 'V1', D10, i % 2 ? '10:00' : '11:00', i % 2 ? '12:00' : '13:00')));
  ck('12 buyers race overlapping venue windows → exactly ONE booking', vr.filter((r) => r.status === 'fulfilled').length === 1, vr.map((r) => r.status === 'fulfilled' ? 'ok' : r.reason.code).join(','));
  const vb = vr.find((r) => r.status === 'fulfilled').value;
  const vDoc = await get('bookings/' + vb.bookingId);
  ck('venue times are Africa/Nairobi (the calendar\'s zone)', CORE.minsOf(vDoc.startTs) === CORE.toMins(vDoc.startTime) && CORE.dateOf(vDoc.startTs) === D10);
  ck('the venue\'s public day shows the booked hours TEMPORARILY_HELD (unpaid), safe fields only', (await BK._h.bookingGetAvailability({ ...who(null), data: { venueId: 'V1', date: D10 } })).slots.filter((s) => s.state === 'TEMPORARILY_HELD').length >= 2);
  const vfree = await vbook('b14', 'V1', D10, '15:00', '16:00');
  const vwin = (await get('bookings/' + vb.bookingId));
  ck('a venue reschedule onto an OVERLAPPING booked window is refused (no identical lock to hit — the authority decides)',
    (await code(BK._h.bookingReschedule({ ...who('b14'), data: { bookingId: vfree.bookingId, newDate: D10, newStartTime: CORE.hhmm(CORE.toMins(vwin.startTime) + 30), newEndTime: CORE.hhmm(CORE.toMins(vwin.startTime) + 90) } }))) === 'already-exists' &&
    (await get('bookings/' + vfree.bookingId)).startTime === '15:00');
  await BK._h.bookingReschedule({ ...who('b14'), data: { bookingId: vfree.bookingId, newDate: D10, newStartTime: '18:00', newEndTime: '19:00' } });
  const vday = await BK._h.bookingGetAvailability({ ...who(null), data: { venueId: 'V1', date: D10 } });
  ck('venue reschedule is atomic: 15:00 AVAILABLE, 18:00 held (and the slot lock moved)', vday.slots.find((s) => s.startTime === '15:00').state === 'AVAILABLE' && vday.slots.find((s) => s.startTime === '18:00').state === 'TEMPORARILY_HELD' &&
    !!(await get(`venues/V1/slotLocks/${D10}_${at(D10, '18:00')}_${at(D10, '19:00')}`)));
  await db.doc('bookings/' + vb.bookingId).set({ paymentStatus: 'paid' }, { merge: true });
  ck('a PAID venue booking cannot be cancelled directly (it goes through the refund authority)', (await errCode(BK._h.bookingCancel({ ...who(vDoc.customerId), data: { bookingId: vb.bookingId } }))) === 'USE_REFUND');
  ck('…and the time stays BOOKED/held — a refund REQUEST never reopens it', (await itemsOf('ven_V1', month)).some((it) => it.id === 'vb_' + vb.bookingId));
  await BK._h.bookingCancel({ ...who('b14'), data: { bookingId: vfree.bookingId } });
  ck('an unpaid venue booking\'s cancel reopens its time', !(await itemsOf('ven_V1', month)).some((it) => it.id === 'vb_' + vfree.bookingId));
  const sv = await BK._h.bookingSaveVenue({ ...who('vo2'), data: { name: 'New Place', status: 'active' } });
  ck('a NEW venue starts pending — the owner cannot self-publish', (await get('venues/' + sv.venueId)).status === 'pending');
  await BK._h.bookingSaveVenue({ ...who('vo2'), data: { id: sv.venueId, name: 'New Place 2', status: 'active' } });
  ck('…and an edit never changes its status', (await get('venues/' + sv.venueId)).status === 'pending');
  const blk = await BK._h.bookingBlockSlots({ ...who('vo1'), data: { venueId: 'V1', startTs: at(D10, '20:00'), endTs: at(D10, '22:00'), reason: 'private', note: 'CEO party' } });
  const vpub = await BK._h.bookingGetAvailability({ ...who(null), data: { venueId: 'V1', date: D10 } });
  ck('a venue block is in the authority: public UNAVAILABLE, the note never public', vpub.slots.find((s) => s.startTime === '20:00').state === 'UNAVAILABLE' && !/CEO|party|private/i.test(JSON.stringify(vpub)) && /^blk_/.test(blk.blockoutId));

  /* ═══ 13. retired paths ═══ */
  say('\n── retired paths (they could double-book) ──');
  ck('reserveSlot (confirmed with no payment, a store nothing reads) is retired', (await errCode(AVL._h.reserveSlot({ ...who('b1'), data: { providerId: 'ph1', date: D10, startTime: '10:00', endTime: '11:00' } }))) === 'RETIRED');
  ck('venueCreateBooking (no lock; its overlap query matched nothing) is retired', (await errCode(VBK._h.venueCreateBooking({ ...who('b1'), data: { venueId: 'V1', date: D10, startTime: '09:00' } }))) === 'RETIRED');
  ck('bookingHoldSlot (any user could hold any venue\'s time) is retired', (await errCode(BK._h.bookingHoldSlot({ ...who('b1'), data: { venueId: 'V1', startTs: 1, endTs: 2 } }))) === 'RETIRED');
  await db.doc('bookingHolds/hX').set({ userId: 'b2', venueId: 'V1', expiresAt: REAL_NOW + H });
  ck('a user cannot release someone else\'s hold', (await code(BK._h.bookingReleaseHold({ ...who('b1'), data: { holdId: 'hX' } }))) === 'permission-denied');
  const gs = await AVL._h.getAvailabilitySlots({ ...who(null), data: { providerId: 'ph1', serviceId: 'svc_ph1', startDate: D10, days: 1 } });
  ck('the legacy slot view now answers from the authority in safe states (no "break" / "too_soon" reasons)', gs.results[0].slots.length > 0 && gs.results[0].slots.every((s) => !['break', 'too_soon', 'past', 'beyond_horizon'].includes(s.reason)) && gs.results[0].slots.find((s) => s.startTime === '10:00').available === true);
  ck('…and wrote nothing on that public read', !(await get('providerAvailability/ph1')).autoConfiguredAt);

  /* ═══ 14. summary for cards / marketing ═══ */
  const sm = await AV._h.entAvailSummary({ ...who(null), data: { calendars: [{ providerId: 'ph1' }, { providerId: 'dj0' }, { providerId: 'sus' }, { venueId: 'V1' }] } });
  ck('marketplace / marketing summary: open providers BOOKINGS_OPEN with the next date; suspended NOT_BOOKABLE', sm.results.svc_ph1.state !== 'NOT_BOOKABLE' && !!sm.results.svc_ph1.next && sm.results.svc_sus.state === 'NOT_BOOKABLE' && sm.results.ven_V1.state !== 'NOT_BOOKABLE');
  ck('…and the summary carries no schedule detail', Object.values(sm.results).every((r) => Object.keys(r).sort().join(',') === 'calKey,next,state'));

  /* ═══ 15. AdminOS ═══ */
  say('\n── AdminOS › Entertainment › Availability ──');
  await AV._h.entAvailBlock({ ...who('ph1'), data: { date: D10, start: '19:00', end: '20:00', label: 'Travel to Mombasa' } });
  ck('a non-admin cannot inspect', (await code(AV._adminH.entAdminAvailability({ ...who('b1'), data: { providerId: 'ph1', month } }))) === 'permission-denied');
  const ad = await AV._adminH.entAdminAvailability({ ...who('adm', { admin: true }), data: { providerId: 'ph1', month } });
  ck('an admin sees states, times and booking references — not the provider\'s private labels', ad.items.length > 0 && ad.items.every((i) => i.label === undefined) && ad.items.some((i) => /^providerBookings\//.test(i.bookingRef || '')) && !JSON.stringify(ad).includes('Mombasa'));
  const sad = await AV._adminH.entAdminAvailability({ ...who('sadm', { superAdmin: true }), data: { providerId: 'ph1', month } });
  ck('a super admin sees the label (an intervention may need it)', JSON.stringify(sad).includes('Mombasa'));
  ck('an intervention needs a super admin', (await code(AV._adminH.entAdminAvailabilityIntervene({ ...who('adm', { admin: true }), data: { providerId: 'ph1', action: 'block', reason: 'storm closure', startMs: at(D10, '08:00'), endMs: at(D10, '08:30') } }))) === 'permission-denied');
  ck('…and a reason', (await code(AV._adminH.entAdminAvailabilityIntervene({ ...who('sadm', { superAdmin: true }), data: { providerId: 'ph1', action: 'block', reason: '', startMs: at(D10, '08:00'), endMs: at(D10, '08:30') } }))) === 'invalid-argument');
  const live = (await itemsOf('svc_ph1', month)).find((it) => it.k === 'B' || it.k === 'H');
  ck('release_orphan refuses a LIVE booking (it opens only through its own cancellation)', (await code(AV._adminH.entAdminAvailabilityIntervene({ ...who('sadm', { superAdmin: true }), data: { providerId: 'ph1', action: 'release_orphan', itemId: live.id, month, reason: 'cleanup attempt' } }))) === 'failed-precondition');
  await db.doc('entAvailability/svc_ph1/months/' + month).set({ items: [...(await itemsOf('svc_ph1', month)), { id: 'pb_ghost', k: 'H', s: at(D10, '19:30'), e: at(D10, '19:45'), u: 1, ref: 'providerBookings/ghost' }] }, { merge: true });
  const orphan = await AV._adminH.entAdminAvailabilityIntervene({ ...who('sadm', { superAdmin: true }), data: { providerId: 'ph1', action: 'release_orphan', itemId: 'pb_ghost', month, reason: 'booking record missing' } });
  ck('…but releases an orphan whose booking does not exist — audited with the reason', orphan.ok === true && db._dump('entAvailabilityAudit/').some((a) => a.action === 'admin_release_orphan' && a.reason === 'booking record missing'));

  /* ═══ 16. one-time backfill of bookings made before the authority ═══ */
  say('\n── backfill (scripts/migrate-ent-availability.js) ──');
  const MIG = require(Path.join(ROOT, 'scripts', 'migrate-ent-availability.js'));
  await seedProvider('old1');
  const D20 = CORE.addDays(today, 20);
  await db.doc('providerBookings/legacyA').set({ providerId: 'old1', customerUid: 'b1', status: 'confirmed', paymentStatus: 'paid_held', price: 500000, fee: 0, date: D20, startTs: at(D20, '10:00'), endTs: at(D20, '12:00') });
  await db.doc('providerBookings/legacyB').set({ providerId: 'old1', customerUid: 'b2', status: 'confirmed', paymentStatus: 'paid_held', price: 500000, fee: 0, date: D20, startTs: at(D20, '11:00'), endTs: at(D20, '13:00') });
  const dry = await MIG.backfill(db, AV, { apply: false });
  ck('the DRY RUN reports what it would claim and writes nothing', dry.claimed >= 2 && !(await get('providerBookings/legacyA')).availability && !(await itemsOf('svc_old1', CORE.monthOf(D20))).length);
  const app = await MIG.backfill(db, AV, { apply: true });
  ck('--apply claims a live legacy booking as BOOKED and links it', (await itemsOf('svc_old1', CORE.monthOf(D20))).some((it) => it.id === 'pb_legacyA' && it.k === 'B') && !!(await get('providerBookings/legacyA')).availability);
  ck('…and REPORTS two legacy bookings that overlap — never forces the second in', app.conflicts.some((c) => c.ref === 'providerBookings/legacyB') && !(await itemsOf('svc_old1', CORE.monthOf(D20))).some((it) => it.id === 'pb_legacyB'));
  ck('…running it again changes nothing (already tracked)', (await MIG.backfill(db, AV, { apply: true })).alreadyTracked >= 1);

  say(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { say('CRASH ' + (e && e.stack || e)); process.exit(2); });
