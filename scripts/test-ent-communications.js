/* test-ent-communications.js — Entertainment messaging controls, enquiries, call requests, rate cards,
 * quotes and discounts (2026-09-27).
 *
 * The REAL modules (ent-enquiries, ent-rate-cards, ent-availability, messages, booking-service,
 * booking-payment-sweep, entertainment-bookings, provider-hub) on the transactional fake Firestore.
 *
 * PROVES
 *   Public enquiry   allowed · disabled · NOBODY · who-can-message · blocked · rate-limited · cooldown ·
 *                    duplicate-suppressed · max open · unverified provider; the SERVER creates the
 *                    conversation (a client cannot); state moves are the server's
 *   Sending          a closed / blocked / flooding / duplicate enquiry message is REFUSED (never
 *                    silently dropped); a PRIVATE booking conversation is never gated by any of it
 *   Templates        an automated message may not claim payment / booking / refund outcomes
 *   Calls            REQUEST CALL only when enabled (public) or with an active booking (private);
 *                    accept / decline / schedule; nobody else can answer; one open request per pair
 *   Rate cards       PUBLIC shows a price · ENQUIRY_ONLY and BOOKING_ONLY do not · PRIVATE and
 *                    segments only to eligible buyers; versions are immutable; a price change never
 *                    re-prices a booking; a booking stores rateCardId + version + price + authority
 *   Quotes           enquiry → quote → accept → reserve → pay → CONVERTED; accepting is not paying
 *   Discounts        server-computed from the Marketing store; limits, expiry, service scope; a
 *                    browser "discount" is never an input
 *   Security         cross-provider rate cards / enquiries / conversations; fake discount; fake price
 *   AdminOS          metadata only; content only for a super admin with a reason (audited)
 *
 *   node scripts/test-ent-communications.js
 */
'use strict';
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:1';
process.env.GCLOUD_PROJECT = 'demo-ent-comms';
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
const notices = [];
stub('./notify', { notify: async (n) => { notices.push(n); return { ok: true }; }, TYPES: {} });

const CORE = require(Path.join(FN, 'shared', 'ent-availability-core.js'));
const AV = require(Path.join(FN, 'ent-availability.js'));
const EQ = require(Path.join(FN, 'ent-enquiries.js'));
const RC = require(Path.join(FN, 'ent-rate-cards.js'));
const MSG = require(Path.join(FN, 'messages.js'));
const BS = require(Path.join(FN, 'booking-service.js'));
const SW = require(Path.join(FN, 'booking-payment-sweep.js'));
const EB = require(Path.join(FN, 'entertainment-bookings.js'));
AV._setClock(() => NOW); EQ._setClock(() => NOW); RC._setClock(() => NOW); EB._setClock(() => NOW);

let pass = 0, fail = 0;
const ck = (l, ok, d) => { say('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined && d !== '' ? '   [' + String(typeof d === 'object' ? JSON.stringify(d) : d).slice(0, 170) + ']' : '')); ok ? pass++ : fail++; };
const who = (uid, token = {}) => ({ auth: uid ? { uid, token: Object.assign({ email_verified: true }, token) } : null, rawRequest: { headers: {} } });
async function err(p) { try { await p; return null; } catch (e) { return e; } }
const codeOf = async (p) => { const e = await err(p); return e ? (e.details && e.details.code) || e.code : null; };
const get = async (p) => { const s = await db.doc(p).get(); return s.exists ? s.data() : null; };
const q = (uid, op, data, token) => (EQ._h[op] || RC._h[op])({ ...who(uid, token), data: data || {} });
const today = CORE.dateOf(REAL_NOW);
const D12 = CORE.addDays(today, 12);
const WEEK = {}; ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'].forEach((d) => { WEEK[d] = { closed: false, periods: [{ open: '08:00', close: '20:00' }], breaks: [] }; });

async function seedProvider(uid, opts) {
  const o = opts || {};
  await db.doc(`providers/${uid}`).set({ name: uid, status: o.status || 'active', category: o.category || 'photographer', acceptsBookings: true });
  if (o.decided !== false) await db.doc(`applications/app_${uid}`).set({ uid, status: 'approved', role: 'provider', category: o.category || 'photographer' });
  await db.doc(`providerAvailability/${uid}`).set({ uid, modes: ['fixed_hours'], schedule: WEEK, appt: { enabled: true, durationMins: 60, maxDaysAhead: 90, minNoticeHours: 1, allowSameDay: true }, cap: {} });
  await db.doc(`providerServices/svc_${uid}`).set({ providerId: uid, name: 'Wedding Photography', price: 3000000, fee: 0, deposit: 0, durationMins: 240, active: true });
  await db.doc(`users/${uid}`).set({ displayName: uid });
}
const send = (buyer, providerId, extra) => q(buyer, 'entEnquirySend', Object.assign({ providerId, category: 'AVAILABILITY', question: 'Are you free for a wedding on that date?' }, extra || {}));

(async () => {
  for (const u of ['buyer1', 'buyer2', 'buyer3', 'spam1', 'mallory']) await db.doc(`users/${u}`).set({ displayName: u });
  await seedProvider('jane');
  await seedProvider('otto');
  await seedProvider('newbie', { category: 'dj', decided: false });

  /* ═══ public enquiry ═══ */
  say('\n── public enquiry ──');
  const pub = await EQ._h.entMessagingPublic({ ...who(null), data: { providerId: 'jane' } });
  ck('the storefront learns what it may show — never an "online" claim without business hours', pub.enquiriesOpen === true && pub.openNow === null && pub.bookable === true);
  const e1 = await send('buyer1', 'jane', { serviceId: 'svc_jane', desiredDate: D12, budgetCents: 2500000 });
  const enq = await get('entEnquiries/' + e1.enquiryId);
  ck('a structured enquiry is created OPEN with category, service, date and budget', enq.status === 'OPEN' && enq.category === 'AVAILABILITY' && enq.serviceId === 'svc_jane' && enq.desiredDate === D12 && enq.budgetCents === 2500000);
  const conv = await get('conversations/' + e1.conversationId);
  ck('the SERVER created its conversation: exactly buyer + provider, PUBLIC mode, server-anchored', conv && conv.participants.sort().join() === 'buyer1,jane' && conv.transactionType === 'ent_enquiry' && conv.serverAnchored === true && conv.metadata.mode === 'PUBLIC');
  ck('…the first message is the structured summary (system), and the provider is notified', db._dump(`conversations/${e1.conversationId}/messages/`).some((m) => m.type === 'system' && /ENQUIRY/.test(m.text) && /Budget/.test(m.text)) && notices.some((n) => n.type === 'ent_enquiry_new' && n.uid === 'jane'));
  ck('a client cannot create an enquiry conversation itself', (await codeOf(MSG._h.createConversation({ ...who('buyer2'), data: { transactionType: 'ent_enquiry', transactionId: 'x', participantUids: ['jane'] } }))) === 'permission-denied');
  ck('the exact same enquiry again → suppressed as a DUPLICATE', (await codeOf(send('buyer1', 'jane', { serviceId: 'svc_jane', desiredDate: D12, budgetCents: 2500000 }))) === 'DUPLICATE');
  ck('a different enquiry straight away → COOLDOWN', (await codeOf(send('buyer1', 'jane', { question: 'Do you also do video coverage for weddings?' }))) === 'COOLDOWN');
  NOW += 3 * 60e3;
  await send('buyer1', 'jane', { question: 'Do you also do video coverage for weddings?' });
  NOW += 3 * 60e3;
  await send('buyer1', 'jane', { question: 'What is your travel policy outside Nairobi?' });
  NOW += 3 * 60e3;
  ck('a fourth OPEN enquiry with the same provider → refused (continue in the open ones)', (await codeOf(send('buyer1', 'jane', { question: 'And your cancellation terms please?' }))) === 'TOO_MANY_OPEN');
  for (let i = 0; i < 10; i++) { NOW += 3 * 60e3; await seedProvider('p' + i); await send('spam1', 'p' + i, { question: 'Hello provider number ' + i + ', are you free?' }).catch(() => null); }
  NOW += 3 * 60e3;
  ck('the 11th enquiry of the day from one user → RATE_LIMITED (server-side, not the browser)', (await codeOf(send('spam1', 'otto', { question: 'One more enquiry for you today?' }))) === 'RATE_LIMITED');
  ck('an UNVERIFIED artist takes no public enquiries', (await codeOf(send('buyer2', 'newbie'))) === 'failed-precondition');
  await q('otto', 'entMessagingSetSettings', { settings: { enquiriesEnabled: false } });
  ck('a provider who DISABLED public enquiries receives none', (await codeOf(send('buyer2', 'otto'))) === 'ENQUIRIES_DISABLED' && (await EQ._h.entMessagingPublic({ ...who('buyer2'), data: { providerId: 'otto' } })).enquiriesOpen === false);
  await q('otto', 'entMessagingSetSettings', { settings: { enquiriesEnabled: true, whoCanMessage: 'ACTIVE_BOOKING' } });
  ck('"customers with an active booking" only → a stranger is refused', (await codeOf(send('buyer2', 'otto'))) === 'NOT_ALLOWED');
  await q('jane', 'entMessagingSetSettings', { settings: { whoCanMessage: 'ENQUIRY' } });
  NOW += 3 * 60e3;
  ck('"customers with an enquiry": a buyer with enquiry history may enquire again (after closing one), a newcomer may not',
    (await codeOf(send('buyer3', 'jane', { question: 'First time asking about your rates?' }))) === 'NOT_ALLOWED' &&
    (await q('buyer1', 'entEnquiryClose', { enquiryId: db._dump('entEnquiries/').find((x) => x.buyerUid === 'buyer1' && x.providerUid === 'jane' && x.enquiryId !== e1.enquiryId && x.status === 'OPEN').enquiryId }).then(() => send('buyer1', 'jane', { question: 'Following up on my earlier question please?' })).then((r) => !!r.enquiryId)));
  await q('jane', 'entMessagingSetSettings', { settings: { whoCanMessage: 'ANYONE' } });
  ck('"followers" is not offered (follows are not keyed by account)', (await codeOf(q('jane', 'entMessagingSetSettings', { settings: { whoCanMessage: 'FOLLOWERS' } }))) === 'invalid-argument');
  await q('otto', 'entMessagingSetSettings', { settings: { whoCanMessage: 'ANYONE', businessHours: { weekly: Array(7).fill([]) }, outsideHoursAcceptEnquiries: false } });
  const op = await EQ._h.entMessagingPublic({ ...who(null), data: { providerId: 'otto' } });
  ck('outside business hours: "Provider is currently unavailable." — never an online claim', op.openNow === false && op.availabilityNote === 'Provider is currently unavailable.');
  ck('…and, by the provider\'s choice, no enquiry outside hours', (await codeOf(send('buyer2', 'otto'))) === 'OUTSIDE_HOURS');
  await q('otto', 'entMessagingSetSettings', { settings: { businessHours: null } });

  /* ═══ sending inside an enquiry ═══ */
  say('\n── sending in an enquiry vs a booking ──');
  const sendMsg = (uid, conversationId, text) => MSG._h.sendMessage({ ...who(uid), data: { conversationId, type: 'text', text } });
  await sendMsg('jane', e1.conversationId, 'Yes, I have that date open.');
  ck('the provider\'s first reply marks the enquiry RESPONDED (server)', (await get('entEnquiries/' + e1.enquiryId)).status === 'RESPONDED');
  await sendMsg('buyer1', e1.conversationId, 'Great, what would it cost?');
  ck('the same message twice within a minute → refused as DUPLICATE (not silently dropped)', (await codeOf(sendMsg('buyer1', e1.conversationId, 'Great, what would it cost?'))) === 'DUPLICATE');
  ck('a stranger cannot post in the enquiry', (await codeOf(sendMsg('mallory', e1.conversationId, 'hi'))) === 'permission-denied');
  ck('a provider reading ANOTHER provider\'s enquiry learns nothing', (await codeOf(q('otto', 'entEnquiryGet', { enquiryId: e1.enquiryId }))) === 'not-found');
  ck('a client cannot move the enquiry state (no client write path; only the server transitions)', !!EQ.transition && (await codeOf(EQ.transition(e1.enquiryId, 'CONVERTED', { by: 'buyer1' }))) === 'failed-precondition');

  /* ═══ templates ═══ */
  say('\n── structured responses ──');
  ck('a template that CLAIMS a payment is complete is refused', (await codeOf(q('jane', 'entMessagingSetSettings', { settings: { templates: { WELCOME: 'Thanks! Your payment has been received.' } } }))) === 'TEMPLATE_CLAIM');
  ck('…as is one claiming a booking is confirmed or a refund completed', (await codeOf(q('jane', 'entMessagingSetSettings', { settings: { templates: { FAQ: 'Your booking is confirmed.' } } }))) === 'TEMPLATE_CLAIM' &&
    (await codeOf(q('jane', 'entMessagingSetSettings', { settings: { templates: { REFUND_POLICY: 'You have been refunded.' } } }))) === 'TEMPLATE_CLAIM');
  await q('jane', 'entMessagingSetSettings', { settings: { templates: { LOCATION: 'I work across Nairobi and travel on request.' }, responseTime: 'WITHIN_1_HOUR', publicInfo: { cancellationPolicy: 'Full refund up to 7 days before.', faqs: [{ q: 'Do you travel?', a: 'Yes.' }] } } });
  await q('jane', 'entEnquiryReply', { enquiryId: e1.enquiryId, template: 'LOCATION' });
  ck('an honest template is posted into the enquiry', db._dump(`conversations/${e1.conversationId}/messages/`).some((m) => /travel on request/.test(m.text || '')));
  ck('the storefront shows response time + public info before "Send enquiry"', (await EQ._h.entMessagingPublic({ ...who(null), data: { providerId: 'jane' } })).responseTime === 'WITHIN_1_HOUR');

  /* ═══ rate cards ═══ */
  say('\n── rate cards ──');
  const rcPub = await q('jane', 'entRateCardCreate', { name: 'Wedding — full day', serviceId: 'svc_jane', visibility: 'PUBLIC', version: { priceCents: 2000000, unit: 'booking', durationMins: 480 } });
  const rcQuote = await q('jane', 'entRateCardCreate', { name: 'Destination wedding', serviceId: 'svc_jane', visibility: 'ENQUIRY_ONLY', version: { priceCents: 9000000 } });
  const rcBook = await q('jane', 'entRateCardCreate', { name: 'Portrait', serviceId: 'svc_jane', visibility: 'BOOKING_ONLY', version: { priceCents: 800000, durationMins: 60 } });
  const rcPriv = await q('jane', 'entRateCardCreate', { name: 'VIP rate', serviceId: 'svc_jane', visibility: 'PRIVATE', version: { priceCents: 500000, durationMins: 480 } });
  const rcCorp = await q('jane', 'entRateCardCreate', { name: 'Corporate', serviceId: 'svc_jane', visibility: 'PUBLIC', segment: 'CORPORATE', version: { priceCents: 1500000, durationMins: 480 } });
  const view = await RC._h.entRateCardsPublic({ ...who('buyer2'), data: { providerId: 'jane' } });
  const byName = (n) => view.cards.find((c) => c.name === n);
  ck('PUBLIC shows its price', byName('Wedding — full day').priceCents === 2000000);
  ck('ENQUIRY_ONLY shows "request a quote" and NO price', byName('Destination wedding').quote === true && byName('Destination wedding').priceCents === undefined);
  ck('BOOKING_ONLY shows no price (it appears at checkout)', byName('Portrait').priceAtCheckout === true && byName('Portrait').priceCents === undefined);
  ck('PRIVATE and a CORPORATE segment are invisible to an ineligible buyer', !byName('VIP rate') && !byName('Corporate'));
  ck('the public API never returns versions, owner or eligibility', !JSON.stringify(view).match(/versions|ownerUid|eligib/));
  ck('another provider cannot list Jane\'s rate cards', (await codeOf(q('otto', 'entRateCardList', { providerId: 'jane' }))) === 'permission-denied');
  ck('a buyer cannot book the CORPORATE rate without eligibility (the server decides, not the buyer)', (await codeOf(BS._h.bookingCreateService({ ...who('buyer2'), data: { providerId: 'jane', serviceId: 'svc_jane', date: D12, startTime: '08:00', rateCardId: rcCorp.cardId } }))) === 'permission-denied');
  ck('…nor the PRIVATE one', (await codeOf(BS._h.bookingCreateService({ ...who('buyer2'), data: { providerId: 'jane', serviceId: 'svc_jane', date: D12, startTime: '08:00', rateCardId: rcPriv.cardId } }))) === 'permission-denied');
  ck('an ENQUIRY_ONLY card cannot be booked at a price', (await codeOf(BS._h.bookingCreateService({ ...who('buyer2'), data: { providerId: 'jane', serviceId: 'svc_jane', date: D12, startTime: '08:00', rateCardId: rcQuote.cardId } }))) === 'failed-precondition');
  const bk1 = await BS._h.bookingCreateService({ ...who('buyer2'), data: { providerId: 'jane', serviceId: 'svc_jane', date: D12, startTime: '08:00', rateCardId: rcPub.cardId, expectedTotalCents: 2000000 } });
  const pb1 = await get('providerBookings/' + bk1.bookingId);
  ck('a booking on a rate card stores rateCardId + version + price + currency + authority, and the card\'s duration', pb1.rateCardId === rcPub.cardId && pb1.rateCardVersion === 1 && pb1.price === 2000000 && pb1.currency === 'KES' && /ent-rate-cards/.test(pb1.pricingAuthority) && pb1.durationMins === 480);
  await q('jane', 'entRateCardNewVersion', { cardId: rcPub.cardId, version: { priceCents: 2500000, unit: 'booking', durationMins: 480 } });
  ck('KES 20,000 → 25,000 is a NEW version; version 1 is closed, not edited', (await get(`entRateCards/${rcPub.cardId}/versions/1`)).priceCents === 2000000 && !!(await get(`entRateCards/${rcPub.cardId}/versions/1`)).effectiveTo && (await get(`entRateCards/${rcPub.cardId}/versions/2`)).priceCents === 2500000);
  ck('the existing booking keeps KES 20,000 (never re-priced)', (await get('providerBookings/' + bk1.bookingId)).price === 2000000);
  const stale = await err(BS._h.bookingCreateService({ ...who('buyer3'), data: { providerId: 'jane', serviceId: 'svc_jane', date: CORE.addDays(D12, 1), startTime: '08:00', rateCardId: rcPub.cardId, expectedTotalCents: 2000000 } }));
  ck('a buyer whose checkout showed the OLD price gets "Price changed" with the new total — never charged the old one', stale && stale.details.code === 'PRICE_CHANGED' && stale.details.totalCents === 2500000);
  await q('jane', 'entRateCardGrant', { cardId: rcCorp.cardId, uid: 'buyer3' });
  ck('once the provider grants eligibility, the CORPORATE rate is visible and bookable for that buyer only', (await RC._h.entRateCardsPublic({ ...who('buyer3'), data: { providerId: 'jane' } })).cards.some((c) => c.name === 'Corporate') &&
    !!(await BS._h.bookingCreateService({ ...who('buyer3'), data: { providerId: 'jane', serviceId: 'svc_jane', date: CORE.addDays(D12, 2), startTime: '08:00', rateCardId: rcCorp.cardId } })).bookingId);
  ck('a stranger cannot grant themselves eligibility', (await codeOf(q('mallory', 'entRateCardGrant', { cardId: rcCorp.cardId, uid: 'mallory' }))) === 'permission-denied');
  ck('a stranger cannot change a PRIVATE rate to PUBLIC', (await codeOf(q('mallory', 'entRateCardUpdate', { cardId: rcPriv.cardId, visibility: 'PUBLIC' }))) === 'permission-denied');
  void rcBook;

  /* ═══ discounts ═══ */
  say('\n── discounts (Marketing store, server-computed) ──');
  await q('jane', 'entDiscountCreate', { code: 'OCT10', campaign: 'October availability', type: 'percent', value: 10, maxDiscount: 1500, usageLimit: 1, validFrom: REAL_NOW - 60e3, validTo: REAL_NOW + 30 * 86400e3, allowedServices: ['svc_jane'] });
  const dD = CORE.addDays(D12, 3);
  const withCode = await BS._h.bookingCreateService({ ...who('buyer1'), data: { providerId: 'jane', serviceId: 'svc_jane', date: dD, startTime: '08:00', couponCode: 'oct10', discount: 5000000, discountCents: 5000000, price: 1 } });
  const pbD = await get('providerBookings/' + withCode.bookingId);
  ck('the SERVER computes the discount (10 % capped at KES 1,500); a browser "discount" / "price" is ignored', pbD.discountCents === 150000 && pbD.price === 3000000 - 150000 && pbD.listPriceCents === 3000000, { d: pbD.discountCents, p: pbD.price });
  ck('…and the redemption is recorded once', !!(await get(`mktCouponRedemptions/${pbD.couponId}_${withCode.bookingId}`)) && (await get('mktCouponCodes/' + pbD.couponId)).usedCount === 1);
  ck('the usage limit holds (a second use is refused)', (await codeOf(BS._h.bookingCreateService({ ...who('buyer3'), data: { providerId: 'jane', serviceId: 'svc_jane', date: CORE.addDays(dD, 1), startTime: '08:00', couponCode: 'OCT10' } }))) === 'COUPON');
  ck('another provider\'s code is not valid here', (await codeOf(BS._h.bookingCreateService({ ...who('buyer3'), data: { providerId: 'otto', serviceId: 'svc_otto', date: dD, startTime: '08:00', couponCode: 'OCT10' } }))) === 'not-found');
  ck('coupon codes are not listable by other users (merchant + admin only in rules; no public list op)', !RC._h.entDiscountListPublic);

  /* ═══ quotes ═══ */
  say('\n── enquiry → quote → booking ──');
  NOW += 3 * 60e3;
  const e2 = await send('buyer2', 'otto', { category: 'CUSTOM_REQUEST', question: 'Could you cover a two-day corporate retreat?', desiredDate: D12 });
  const qt = await RC._h.entQuoteCreate({ ...who('otto'), data: { enquiryId: e2.enquiryId, buyerUid: 'buyer2', serviceId: 'svc_otto', description: 'Retreat coverage', date: D12, startTime: '10:00', durationMins: 180, priceCents: 4000000, discountCents: 500000, validDays: 3 } });
  ck('the provider\'s quote moves the enquiry to PROPOSAL_SENT', (await get('entEnquiries/' + e2.enquiryId)).status === 'PROPOSAL_SENT' && qt.finalCents === 3500000);
  ck('an unaccepted quote cannot be booked', (await codeOf(BS._h.bookingCreateService({ ...who('buyer2'), data: { providerId: 'otto', serviceId: 'svc_otto', date: D12, startTime: '10:00', quoteId: qt.quoteId } }))) === 'failed-precondition');
  ck('another buyer cannot accept it', (await codeOf(RC._h.entQuoteRespond({ ...who('mallory'), data: { quoteId: qt.quoteId, accept: true } }))) === 'permission-denied');
  await RC._h.entQuoteRespond({ ...who('buyer2'), data: { quoteId: qt.quoteId, accept: true } });
  ck('accepting is NOT paying: quote ACCEPTED, enquiry BOOKING_PENDING, nothing reserved yet', (await get('entQuotes/' + qt.quoteId)).status === 'ACCEPTED' && (await get('entEnquiries/' + e2.enquiryId)).status === 'BOOKING_PENDING' &&
    !db._dump('providerBookings/').some((b) => b.quoteId === qt.quoteId));
  ck('a quote for another date cannot be used for a different time', (await codeOf(BS._h.bookingCreateService({ ...who('buyer2'), data: { providerId: 'otto', serviceId: 'svc_otto', date: D12, startTime: '14:00', quoteId: qt.quoteId } }))) === 'failed-precondition');
  const qb = await BS._h.bookingCreateService({ ...who('buyer2'), data: { providerId: 'otto', serviceId: 'svc_otto', date: D12, startTime: '10:00', quoteId: qt.quoteId, expectedTotalCents: 3500000 } });
  const qpb = await get('providerBookings/' + qb.bookingId);
  ck('reserve at the QUOTED price (server), linked to quote + enquiry', qpb.price === 3500000 && qpb.quoteId === qt.quoteId && qpb.enquiryId === e2.enquiryId && qpb.durationMins === 180);
  ck('re-submitting the same quote for the same slot resumes the SAME hold (no second booking)', (await BS._h.bookingCreateService({ ...who('buyer2'), data: { providerId: 'otto', serviceId: 'svc_otto', date: D12, startTime: '10:00', quoteId: qt.quoteId } })).resumed === true &&
    db._dump('providerBookings/').filter((b) => b.quoteId === qt.quoteId).length === 1);
  /* the booking identity trigger fires on create (pending) and again on payment — as in production */
  await EB.onSourceWritten('providerBookings', qb.bookingId, await get('providerBookings/' + qb.bookingId));
  await db.doc('paymentIntents/SKNQT1').set({ ref: 'SKNQT1', resourceType: 'providerBooking', resourceId: qb.bookingId, uid: 'buyer2' });
  await SW.holdServiceBookingPayment(db, ADMIN, 'SKNQT1', 'SKNQT1', 35000);
  await EB.onSourceWritten('providerBookings', qb.bookingId, await get('providerBookings/' + qb.bookingId));
  ck('payment confirmed → quote CONVERTED and enquiry CONVERTED (no restart for the buyer)', (await get('entQuotes/' + qt.quoteId)).status === 'CONVERTED' && (await get('entEnquiries/' + e2.enquiryId)).status === 'CONVERTED');
  ck('a CONVERTED quote cannot book anything else', (await codeOf(BS._h.bookingCreateService({ ...who('buyer2'), data: { providerId: 'otto', serviceId: 'svc_otto', date: D12, startTime: '10:00', quoteId: qt.quoteId } }))) !== null);

  /* ═══ private booking messaging ═══ */
  say('\n── private booking conversation ──');
  const env = await get('entBookings/svc_' + qb.bookingId);
  ck('the paid booking has its PRIVATE conversation with exactly its two parties', env && env.conversationId && (await get('conversations/' + env.conversationId)).participants.sort().join() === 'buyer2,otto');
  ck('the conversation shows BOOKING / PAYMENT CONFIRMED and PIN ISSUED as system events', db._dump(`conversations/${env.conversationId}/messages/`).some((m) => /PAYMENT CONFIRMED/.test(m.text)) && db._dump(`conversations/${env.conversationId}/messages/`).some((m) => /PIN ISSUED/.test(m.text)));
  ck('…and is tagged for the BOOKINGS / PAYMENTS inbox tabs', ((await get('conversations/' + env.conversationId)).entTags || []).includes('payment'));
  ck('a wrong participant is refused', (await codeOf(sendMsg('mallory', env.conversationId, 'hello'))) === 'permission-denied');
  await EQ._h.entEnquiryBlockUser({ ...who('otto'), data: { uid: 'buyer2', reason: 'test' } });
  ck('a provider BLOCK does not strand a paying buyer: the booking conversation still works', !(await err(sendMsg('buyer2', env.conversationId, 'See you on the day!'))));
  ck('…while public enquiries from that user are refused', (await codeOf(send('buyer2', 'otto', { question: 'Another question for you please?' }))) === 'BLOCKED');
  await EQ._h.entEnquiryBlockUser({ ...who('otto'), data: { uid: 'buyer2', unblock: true } });

  /* ═══ call requests ═══ */
  say('\n── call requests ──');
  ck('public REQUEST CALL is refused while the provider has calls disabled', (await codeOf(q('buyer1', 'entCallRequest', { context: { type: 'enquiry', id: e1.enquiryId } }))) === 'CALLS_DISABLED');
  await q('jane', 'entMessagingSetSettings', { settings: { callRequests: 'ENABLED' } });
  const cr = await q('buyer1', 'entCallRequest', { context: { type: 'enquiry', id: e1.enquiryId }, note: 'Quick chat about packages' });
  ck('with calls enabled a REQUEST is created — nobody is rung', cr.status === 'REQUESTED');
  ck('one open request per pair', (await codeOf(q('buyer1', 'entCallRequest', { context: { type: 'enquiry', id: e1.enquiryId } }))) === 'OPEN_REQUEST');
  ck('only the provider asked can answer it', (await codeOf(q('mallory', 'entCallRespond', { requestId: cr.requestId, action: 'accept' }))) === 'permission-denied' &&
    (await codeOf(q('buyer1', 'entCallRespond', { requestId: cr.requestId, action: 'accept' }))) === 'permission-denied');
  const sched = await q('jane', 'entCallRespond', { requestId: cr.requestId, action: 'schedule', atMs: REAL_NOW + 2 * 86400e3 });
  ck('the provider can SCHEDULE it (inside business hours)', sched.status === 'SCHEDULED');
  ck('an enquiry call is authorised only inside its window, only for its two parties', (await EQ.authorizeEnquiryCall(cr.requestId, 'mallory')) === null && (await EQ.authorizeEnquiryCall(cr.requestId, 'buyer1')) === null);
  NOW = REAL_NOW + 2 * 86400e3; EQ._setClock(() => NOW);
  ck('…and IS authorised at the scheduled time for buyer + provider', !!(await EQ.authorizeEnquiryCall(cr.requestId, 'buyer1')) && !!(await EQ.authorizeEnquiryCall(cr.requestId, 'jane')));
  NOW = REAL_NOW + 10 * 60e3;
  ck('a PRIVATE (booking) call request needs no provider setting — the booking is the relationship', (await q('buyer2', 'entCallRequest', { context: { type: 'booking', id: 'svc_' + qb.bookingId } })).status === 'REQUESTED');
  ck('a stranger cannot request a call on someone else\'s booking', (await codeOf(q('mallory', 'entCallRequest', { context: { type: 'booking', id: 'svc_' + qb.bookingId } }))) === 'not-found');

  /* ═══ AdminOS ═══ */
  say('\n── AdminOS › Entertainment › Communications / Rate Cards ──');
  ck('a non-admin cannot inspect communications', (await codeOf(EQ._adminH.entAdminCommunications({ ...who('buyer1'), data: {} }))) === 'permission-denied');
  const ac = await EQ._adminH.entAdminCommunications({ ...who('adm', { admin: true }), data: { providerUid: 'jane' } });
  ck('an admin sees enquiry METADATA and the provider\'s messaging policy — never the question or messages', ac.enquiries.length >= 3 && !JSON.stringify(ac).includes('wedding on that date') && ac.policy && ac.policy.callRequests === 'ENABLED');
  ck('message content needs a super admin', (await codeOf(EQ._adminH.entAdminEnquiryConversation({ ...who('adm', { admin: true }), data: { enquiryId: e1.enquiryId, reason: 'abuse report 991' } }))) === 'permission-denied');
  const content = await EQ._adminH.entAdminEnquiryConversation({ ...who('sadm', { superAdmin: true }), data: { enquiryId: e1.enquiryId, reason: 'abuse report 991' } });
  ck('…with a reason, and the read is audited', content.messages.length > 0 && db._dump('adminAudit/').some((a) => a.action === 'ent_enquiry_conversation_read' && a.reason === 'abuse report 991'));
  const ar = await RC._adminH.entAdminRateCards({ ...who('adm', { admin: true }), data: { ownerUid: 'jane' } });
  ck('AdminOS › Rate Cards: provider · visibility · version history · effective dates', ar.cards.length >= 5 && ar.cards.find((c) => c.id === rcPub.cardId).versions.length === 2);
  ck('suspending a rate card is super admin + reason', (await codeOf(RC._adminH.entAdminRateCardSuspend({ ...who('adm', { admin: true }), data: { cardId: rcPub.cardId, reason: 'misleading price' } }))) === 'permission-denied');

  say(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { say('CRASH ' + (e && e.stack || e)); process.exit(2); });
