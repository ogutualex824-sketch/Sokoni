/* test-ent-journeys.js — every Entertainment provider journey END TO END through the REAL authorities
 * (availability → checkout → reservation → payment → booking identity + PIN → conversation → show-up
 * verification → settlement to the BUSINESS wallet), on the transactional fake Firestore.
 *
 *   ARTIST   Marketplace badge → service → calendar → slot → checkout → pay → BK-ART + PIN → messages → show-up → wallet
 *   SERVICE  same on a non-artist entertainment service (BK-SVC)
 *   VENUE    venue calendar → slot → booking → pay (venue_booking) → BK-VEN + PIN → messages → show-up → wallet
 *   CREATOR  approved creator-provider consultation on the SAME authority
 *   EVENT    stays on ticket inventory (the calendar authority refuses an event key)
 *   PRODUCT  no calendar at all (the authority refuses a product key)
 *
 *   node scripts/test-ent-journeys.js
 */
'use strict';
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:1';
process.env.GCLOUD_PROJECT = 'demo-ent-journeys';
delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
delete process.env.K_SERVICE; delete process.env.FUNCTION_TARGET;

const Path = require('path');
const ROOT = Path.resolve(__dirname, '..');
const FN = Path.join(ROOT, 'functions');
const { makeFakeFirestore } = require('./lib/fake-firestore-txn');
const REAL_NOW = Date.now();
const F = makeFakeFirestore({ clock: () => Date.now(), strictReadOrder: true });
const db = F.db;
const say = console.log;
console.log = console.info = console.warn = console.debug = () => {};
const resolveIn = (m) => require.resolve(m, { paths: [FN] });
const stub = (m, exp) => { const p = m.startsWith('./') ? Path.join(FN, m + '.js') : resolveIn(m); require.cache[p] = { id: p, filename: p, loaded: true, exports: exp }; };
const authApi = { getUser: async (u) => ({ uid: u, customClaims: {} }) };
const ADMIN = { apps: [{}], initializeApp: () => ({}), app: () => ({}), firestore: Object.assign(() => db, { FieldValue: F.FieldValue, Timestamp: F.Timestamp, FieldPath: F.FieldPath }), auth: () => authApi, storage: () => ({ bucket: () => ({}) }) };
stub('firebase-admin/firestore', { getFirestore: () => db, FieldValue: F.FieldValue, Timestamp: F.Timestamp, FieldPath: F.FieldPath });
stub('firebase-admin/auth', { getAuth: () => authApi });
stub('firebase-admin', ADMIN);
const notices = [];
stub('./notify', { notify: async (n) => { notices.push(n); return { ok: true }; }, TYPES: {} });

const CORE = require(Path.join(FN, 'shared', 'ent-availability-core.js'));
const AV = require(Path.join(FN, 'ent-availability.js'));
const RC = require(Path.join(FN, 'ent-rate-cards.js'));
const BS = require(Path.join(FN, 'booking-service.js'));
const SW = require(Path.join(FN, 'booking-payment-sweep.js'));
const BK = require(Path.join(FN, 'booking.js'));
const VP = require(Path.join(FN, 'venue-payments.js'));
const EB = require(Path.join(FN, 'entertainment-bookings.js'));
const PO = require(Path.join(FN, 'provider-ops.js'));

let pass = 0, fail = 0;
const ck = (l, ok, d) => { say('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined && d !== '' ? '   [' + String(typeof d === 'object' ? JSON.stringify(d) : d).slice(0, 170) + ']' : '')); ok ? pass++ : fail++; };
const who = (uid) => ({ auth: uid ? { uid, token: { email_verified: true } } : null, rawRequest: { headers: {} } });
async function code(p) { try { await p; return null; } catch (e) { return (e.details && e.details.code) || e.code || e.message; } }
const get = async (p) => { const s = await db.doc(p).get(); return s.exists ? s.data() : null; };
const today = CORE.dateOf(REAL_NOW);
const D = CORE.addDays(today, 5);
const at = (date, hhmm) => CORE.dayStartMs(date) + CORE.toMins(hhmm) * 60000;
const WEEK = {}; ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'].forEach((d) => { WEEK[d] = { closed: false, periods: [{ open: '08:00', close: '22:00' }], breaks: [] }; });

async function provider(uid, category, svcName, priceCents) {
  await db.doc(`users/${uid}`).set({ displayName: uid });
  await db.doc(`providers/${uid}`).set({ name: uid, status: 'active', category, acceptsBookings: true });
  await db.doc(`applications/app_${uid}`).set({ uid, status: 'approved', role: 'provider', category });
  await db.doc(`providerAvailability/${uid}`).set({ uid, modes: ['fixed_hours'], schedule: WEEK, appt: { enabled: true, durationMins: 120, maxDaysAhead: 90, minNoticeHours: 1, allowSameDay: true }, cap: {} });
  await db.doc(`providerServices/svc_${uid}`).set({ providerId: uid, name: svcName, price: priceCents, fee: 0, deposit: 0, durationMins: 120, active: true });
}

/* ARTIST / SERVICE / CREATOR — the service-appointment engine */
async function serviceJourney(label, uid, category, svcName, refPrefix) {
  say(`\n── ${label} ──`);
  await provider(uid, category, svcName, 1000000);
  const buyer = 'buyer_' + uid;
  await db.doc(`users/${buyer}`).set({ displayName: 'Achieng Otieno' });
  const badge = await AV._h.entAvailSummary({ ...who(null), data: { calendars: [{ providerId: uid }] } });
  ck(`${label}: marketplace badge from the authority (bookings open + next date)`, ['BOOKINGS_OPEN', 'LIMITED'].includes(badge.results['svc_' + uid].state) && !!badge.results['svc_' + uid].next);
  const services = await AV._h.entServicesPublic({ ...who(null), data: { providerId: uid } });
  ck(`${label}: storefront lists the service (public fields only)`, services.services.length === 1 && services.services[0].name === svcName && Object.keys(services.services[0]).sort().join() === 'durationMins,id,name,priceCents,quote');
  const month = await AV._h.entAvailMonth({ ...who(null), data: { providerId: uid, serviceId: 'svc_' + uid, month: CORE.monthOf(D) } });
  const day = await AV._h.entAvailDay({ ...who(null), data: { providerId: uid, serviceId: 'svc_' + uid, date: D } });
  ck(`${label}: calendar → date → 14:00 AVAILABLE`, month.days[D] === 'AVAILABLE' && day.slots.find((s) => s.start === '14:00').state === 'AVAILABLE');
  const q = await RC._h.entCheckoutQuote({ ...who(buyer), data: { providerId: uid, serviceId: 'svc_' + uid, date: D, startTime: '14:00' } });
  ck(`${label}: checkout — service, time, base, final, payment method, refund policy`, q.serviceName === svcName && q.start === '14:00' && q.end === '16:00' && q.totalCents === 1000000 && /M-PESA/.test(q.paymentMethod) && !!q.refundPolicy && q.slotState === 'AVAILABLE');
  const bk = await BS._h.bookingCreateService({ ...who(buyer), data: { providerId: uid, serviceId: 'svc_' + uid, date: D, startTime: '14:00', expectedTotalCents: q.totalCents } });
  ck(`${label}: CONFIRM & PAY reserves atomically (hold) — 14:00 and 15:00 both close`, (await AV._h.entAvailDay({ ...who(null), data: { providerId: uid, serviceId: 'svc_' + uid, date: D } })).slots.filter((s) => ['14:00', '15:00'].includes(s.start)).every((s) => s.state === 'TEMPORARILY_HELD'));
  await EB.onSourceWritten('providerBookings', bk.bookingId, await get('providerBookings/' + bk.bookingId));
  const ref = 'SKNJ_' + uid;
  await db.doc('paymentIntents/' + ref).set({ ref, resourceType: 'providerBooking', resourceId: bk.bookingId, uid: buyer });
  await SW.holdServiceBookingPayment(db, ADMIN, ref, ref, 10000);
  await EB.onSourceWritten('providerBookings', bk.bookingId, await get('providerBookings/' + bk.bookingId));
  ck(`${label}: payment confirmed → BOOKED`, (await AV._h.entAvailDay({ ...who(null), data: { providerId: uid, serviceId: 'svc_' + uid, date: D } })).slots.find((s) => s.start === '14:00').state === 'BOOKED');
  const envId = 'svc_' + bk.bookingId;
  const env = await get('entBookings/' + envId);
  const secret = await get('entBookingSecrets/' + envId);
  ck(`${label}: one booking identity (${refPrefix}) with a server PIN for the buyer`, env && env.bookingRef.startsWith(refPrefix) && /^\d{4}$/.test(secret.pin) && secret.buyerUid === buyer);
  const msgs = db._dump(`conversations/${env.conversationId}/messages/`).map((m) => m.text).join(' | ');
  ck(`${label}: the private conversation — PAYMENT CONFIRMED and PIN ISSUED (system, not provider-authored)`, /PAYMENT CONFIRMED/.test(msgs) && /PIN ISSUED/.test(msgs) && (await get('conversations/' + env.conversationId)).participants.sort().join() === [buyer, uid].sort().join());
  /* the provider accepts the paid booking — the booking authority's own transition */
  await PO._h.providerConfirmBooking({ ...who(uid), data: { bookingId: bk.bookingId } });
  await EB.onSourceWritten('providerBookings', bk.bookingId, await get('providerBookings/' + bk.bookingId));
  ck(`${label}: the provider confirms → BOOKING CONFIRMED in the conversation`, db._dump(`conversations/${env.conversationId}/messages/`).some((m) => /BOOKING CONFIRMED/.test(m.text)));
  const view = (await EB._h.entBookingGet({ ...who(buyer), data: { bookingRef: env.bookingRef } })).booking;
  ck(`${label}: "PIN YAKO NI BOOKING YAKO" — the buyer sees the PIN, the provider does not`, view.pin === secret.pin && (await EB._h.entBookingGet({ ...who(uid), data: { bookingRef: env.bookingRef } })).booking.pin === '••••');
  const w0 = ((await get('wallets/' + uid)) || {}).balance || 0;
  EB._setClock(() => at(D, '13:00'));
  const v = await EB._h.entBookingVerifyPin({ ...who(uid), data: { bookingRef: env.bookingRef, pin: secret.pin } });
  EB._setClock(null);
  const w1 = ((await get('wallets/' + uid)) || {}).balance || 0;
  ck(`${label}: show-up PIN verified → SOKONI 5 % → the provider's BUSINESS wallet (never the buyer)`, v.verified === true && v.settled === true && w1 - w0 === 9500 && !((await get('wallets/' + buyer)) || {}).balance, { w: w1 - w0, v, st: (await get('providerBookings/' + bk.bookingId)).status });
  ck(`${label}: the PIN is used once`, (await EB._h.entBookingVerifyPin({ ...who(uid), data: { bookingRef: env.bookingRef, pin: secret.pin } })).verified === false);
  ck(`${label}: the slot stays BOOKED after settlement`, (await AV._h.entAvailDay({ ...who(null), data: { providerId: uid, serviceId: 'svc_' + uid, date: D } })).slots.find((s) => s.start === '14:00').state === 'BOOKED');
}

(async () => {
  await serviceJourney('ARTIST', 'djK', 'dj', 'Wedding DJ set', 'BK-ART-');
  await serviceJourney('SERVICE', 'decoK', 'decorator', 'Event decoration', 'BK-SVC-');
  await serviceJourney('CREATOR (consultation, as an approved provider)', 'crK', 'influencer', 'Creator consultation', 'BK-');

  /* VENUE — the venue engine on the SAME authority */
  say('\n── VENUE ──');
  const VOH = {}; ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].forEach((d) => { VOH[d] = { open: '08:00', close: '23:00', closed: false }; });
  await db.doc('users/vown').set({ displayName: 'Venue owner' }); await db.doc('users/vbuy').set({ displayName: 'Wanjiku M' });
  await db.doc('venues/KH').set({ name: 'Karura Hall', ownerId: 'vown', status: 'active', openingHours: VOH, slotDurationMins: 60, bookingHorizonDays: 730, pricing: { hourlyRate: 5000 }, totalBookings: 0 });
  const vbadge = await AV._h.entAvailSummary({ ...who(null), data: { calendars: [{ venueId: 'KH' }] } });
  ck('VENUE: marketplace badge from the authority', vbadge.results.ven_KH.state !== 'NOT_BOOKABLE' && !!vbadge.results.ven_KH.next);
  const nextYear = `${Number(today.slice(0, 4)) + 1}-06`;
  ck('VENUE: a 730-day horizon → next year is bookable (not BOOKING_NOT_OPEN)', Object.values((await AV._h.entAvailMonth({ ...who(null), data: { venueId: 'KH', month: nextYear } })).days).some((s) => s === 'AVAILABLE'));
  const vq = await RC._h.entCheckoutQuote({ ...who('vbuy'), data: { venueId: 'KH', date: D, startTime: '18:00', durationMins: 120 } });
  ck('VENUE: checkout priced by the server (2 h × KES 5,000)', vq.totalCents === 1000000 && vq.slotState === 'AVAILABLE');
  const vb = await BK._h.bookingCreate({ ...who('vbuy'), data: { venueId: 'KH', date: D, startTime: '18:00', endTime: '20:00', expectedTotalCents: vq.totalCents } });
  ck('VENUE: reserved as a hold until payment', (await AV._h.entAvailDay({ ...who(null), data: { venueId: 'KH', date: D } })).slots.find((s) => s.start === '18:00').state === 'TEMPORARILY_HELD');
  const pr = await VP.priceVenueBooking('vbuy', { bookingId: vb.bookingId });
  await db.doc('paymentIntents/' + pr.preferredRef).set({ ref: pr.preferredRef, purpose: 'venue_booking', resourceType: 'venueBooking', resourceId: vb.bookingId, uid: 'vbuy', ownerUid: 'vbuy', amount: pr.amountCents / 100, amountCents: pr.amountCents, currency: 'KES', status: 'created', metadata: pr.metadata });
  await db.doc('payments/' + pr.preferredRef).set({ ref: pr.preferredRef, uid: 'vbuy', amount: pr.amountCents / 100, amountCents: pr.amountCents, currency: 'KES', status: 'COMPLETE', providerReport: { charges: 100 } });
  const act = await VP.activateIfVenueBooking(pr.preferredRef);
  ck('VENUE: venue_booking payment activated once → BOOKED', act.activated && (await AV._h.entAvailDay({ ...who(null), data: { venueId: 'KH', date: D } })).slots.find((s) => s.start === '18:00').state === 'BOOKED');
  await EB.onSourceWritten('bookings', vb.bookingId, await get('bookings/' + vb.bookingId));
  const venv = await get('entBookings/ven_' + vb.bookingId);
  const vsec = await get('entBookingSecrets/ven_' + vb.bookingId);
  ck('VENUE: BK-VEN identity + buyer PIN + conversation with the VENUE OWNER', venv.bookingRef.startsWith('BK-VEN-') && /^\d{4}$/.test(vsec.pin) && (await get('conversations/' + venv.conversationId)).participants.sort().join() === 'vbuy,vown');
  const vw0 = ((await get('wallets/vown')) || {}).balance || 0;
  EB._setClock(() => at(D, '17:00')); VP._setClock(() => at(D, '17:00'));
  const vv = await EB._h.entBookingVerifyPin({ ...who('vown'), data: { bookingRef: venv.bookingRef, pin: vsec.pin } });
  EB._setClock(null); VP._setClock(null);
  ck('VENUE: show-up → 5 % to SOKONI, net to the venue owner\'s BUSINESS wallet', vv.verified && vv.settled && (((await get('wallets/vown')) || {}).balance || 0) > vw0 && !((await get('wallets/vbuy')) || {}).balance);

  /* EVENT / PRODUCT — not appointment calendars */
  say('\n── EVENT & PRODUCT stay on their own authorities ──');
  ck('EVENT: the calendar authority has no event key (ticket inventory stays with events)', AV.calKeyFor({ eventId: 'ev1' }) === null && (await code(AV._h.entAvailMonth({ ...who(null), data: { eventId: 'ev1', month: CORE.monthOf(D) } }))) === 'invalid-argument');
  ck('PRODUCT: no calendar for a product (orders keep their identity)', AV.calKeyFor({ productId: 'p1' }) === null && (await code(AV._h.entAvailDay({ ...who(null), data: { productId: 'p1', date: D } }))) === 'invalid-argument');
  ck('ticket PINs and booking PINs never share a domain (events keep PIN YAKO NI TICKET YAKO)', require(Path.join(FN, 'shared', 'ent-booking-identity.js')).PHRASE.EVENT === 'PIN YAKO NI TICKET YAKO');

  say(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { say('CRASH ' + (e && e.stack || e)); process.exit(2); });
