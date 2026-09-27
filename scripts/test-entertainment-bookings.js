/* test-entertainment-bookings.js — the ONE canonical Entertainment booking identity (Slice A).
 *
 * The REAL modules (entertainment-bookings, messages, booking, provider-ops, provider-hub,
 * commission-config, financial-os guard) on the transactional fake Firestore. No network.
 *
 * PROVES
 *   Identity      an ARTIST / SERVICE / VENUE / EVENT booking gets ONE envelope, a category reference
 *                 (BK-ART / BK-SVC / BK-VEN, the SK-EVT ticket numbers), the SERVER-derived buyer and
 *                 provider; non-Entertainment, unpaid, walk-in and owner-forged sources get none
 *   PIN           "PIN YAKO NI BOOKING YAKO": 4 digits from the server, HMAC-bound to the booking; the
 *                 buyer sees it, the provider sees ••••; only the booking's provider can verify; wrong
 *                 PINs are counted, audited and lock out with a security event; a PIN never verifies
 *                 another booking, a ticket PIN never verifies a booking; used once; invalid once
 *                 cancelled / refunded; EVENT orders carry no booking PIN (the ticket PIN is the credential)
 *   Protected     a venue check-in and an Entertainment service start require the verified PIN; the
 *                 customer can no longer check themselves in
 *   Conversation  created by the SERVER with the booking's own parties; clients cannot create one;
 *                 system events for creation, payment, status, refund, verification
 *   Notifications canonical notify() types for buyer + provider
 *   Money         Entertainment classification from the DECIDED application (a self-edited profile
 *                 cannot choose the 5 % lane); the lane is 5 %, non-Entertainment unchanged; a declined
 *                 paid booking refunds the customer; fosSubmitRefund refuses service-booking payments
 *   AdminOS       search + full trace (payment, money, conversation METADATA, PIN state, audit);
 *                 conversation content only for a super admin with a reason, audited
 *
 *   node scripts/test-entertainment-bookings.js
 */
'use strict';
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:1';
process.env.GCLOUD_PROJECT = 'demo-ent-bookings';
delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
delete process.env.K_SERVICE; delete process.env.FUNCTION_TARGET;

const Path = require('path');
const fs = require('fs');
const ROOT = Path.resolve(__dirname, '..');
const FN = Path.join(ROOT, 'functions');
const { makeFakeFirestore } = require('./lib/fake-firestore-txn');
let NOW = Date.now();
const F = makeFakeFirestore({ clock: () => NOW });
const db = F.db;
const say = console.log;
console.log = console.info = console.warn = console.debug = () => {};
const H = 3600e3;
const resolveIn = (m) => require.resolve(m, { paths: [FN] });
const stub = (m, exp) => { const p = m.startsWith('./') ? Path.join(FN, m + '.js') : resolveIn(m); require.cache[p] = { id: p, filename: p, loaded: true, exports: exp }; };
const authApi = { getUser: async (u) => ({ uid: u, customClaims: {} }) };
const FV = Object.assign({}, F.FieldValue);
stub('firebase-admin/firestore', { getFirestore: () => db, FieldValue: F.FieldValue, Timestamp: F.Timestamp, FieldPath: F.FieldPath });
stub('firebase-admin/auth', { getAuth: () => authApi });
stub('firebase-admin', { apps: [{}], initializeApp: () => ({}), app: () => ({}),
  firestore: Object.assign(() => db, { FieldValue: FV, Timestamp: F.Timestamp, FieldPath: F.FieldPath }), auth: () => authApi });
const notices = [];
stub('./notify', { notify: async (n) => { notices.push(n); return { ok: true }; }, TYPES: {} });

const EB = require(Path.join(FN, 'entertainment-bookings.js'));
const ID = require(Path.join(FN, 'shared', 'ent-booking-identity.js'));
const M = require(Path.join(FN, 'messages.js'));
EB._setClock(() => NOW);

let pass = 0, fail = 0;
const ck = (l, ok, d) => { say('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined && d !== '' ? '   [' + String(typeof d === 'object' ? JSON.stringify(d) : d).slice(0, 170) + ']' : '')); ok ? pass++ : fail++; };
const who = (uid, token = {}) => ({ auth: uid ? { uid, token } : null, rawRequest: { headers: {} } });
async function code(p) { try { await p; return null; } catch (e) { return e.code || e.message; } }
const get = async (p) => { const s = await db.doc(p).get(); return s.exists ? s.data() : null; };
const h = (op, uid, data = {}, token) => EB._h[op]({ ...who(uid, token), data });

(async () => {
  await db.doc('users/buyer1').set({ displayName: 'Achieng Otieno' });
  await db.doc('users/djK').set({ displayName: 'DJ Kaka' });
  await db.doc('users/owner1').set({ displayName: 'Garden Owner' });
  await db.doc('providers/djK').set({ name: 'DJ Kaka', status: 'active' });

  /* ═══ classification: the DECIDED application, never the self-edited profile ═══ */
  say('\n── classification (5 % lane) ──');
  const PH = require(Path.join(FN, 'provider-hub.js'));
  await db.doc('applications/A1').set({ uid: 'djK', role: 'provider', category: 'DJ', status: 'approved' });
  await db.doc('applications/A2').set({ uid: 'plumb', role: 'provider', category: 'Plumbing', status: 'approved' });
  await db.doc('providerProfiles/plumb').set({ category: 'DJ', subcategory: 'DJ' });            /* self-edited profile */
  await db.doc('applications/A3').set({ uid: 'maybe', role: 'provider', category: 'DJ', status: 'pending' });
  await db.doc('applications/A4').set({ uid: 'photo', role: 'provider', category: 'Creative & Media', subcategory: 'Photographer', status: 'approved' });
  const c1 = await PH.resolveProviderClassification(db, 'djK');
  ck('a decided DJ application → hub entertainment, ARTIST', c1.hub === 'entertainment' && c1.entClass === 'ARTIST', c1);
  ck('a photographer → entertainment SERVICE', (await PH.resolveProviderClassification(db, 'photo')).entClass === 'SERVICE');
  ck('a plumber who edited their PROFILE to "DJ" stays on the provider plan rate (no self-chosen lane)', (await PH.resolveProviderClassification(db, 'plumb')).hub === 'provider');
  ck('an UNDECIDED application cannot move a provider into the lane', (await PH.resolveProviderClassification(db, 'maybe')).hub === 'provider');
  const CC = require(Path.join(FN, 'commission-config.js'));
  ck('the lane is 5 % (RATES.entertainment_bookings); the generic services rate is untouched (15 %)', CC.resolveRate('entertainment_bookings').pct === 5 && CC.resolveRate('services').pct === 15);
  ck('settlement args: entertainment → 5 % category, NO plan-rate override', JSON.stringify(PH.commissionArgsForHub('entertainment')) === JSON.stringify({ category: 'entertainment_bookings', hubId: 'entertainment', skipMinimum: true }) && PH.commissionArgsForHub('provider').subscriptionRole === 'provider');
  const bsSrc = fs.readFileSync(Path.join(FN, 'booking-service.js'), 'utf8');
  ck('booking creation stamps entClass server-side next to commissionHub', /entClass: entClass \|\| null,/.test(bsSrc) && /resolveProviderClassification\(db, providerId\)/.test(bsSrc));

  /* ═══ ARTIST booking ═══ */
  say('\n── artist booking identity ──');
  const pb = { providerId: 'djK', customerUid: 'buyer1', customerName: 'Achieng', service: 'Wedding DJ set', status: 'confirmed', paymentStatus: 'paid_held', paymentRef: 'PAYART1',
    price: 2000000, fee: 0, commissionHub: 'entertainment', entClass: 'ARTIST', startTs: NOW + 48 * H, endTs: NOW + 52 * H, durationMins: 240 };
  await db.doc('providerBookings/pbA').set(pb);
  const r = await EB.onSourceWritten('providerBookings', 'pbA', pb);
  const env = await get('entBookings/svc_pbA');
  ck('one envelope, BK-ART reference, category ARTIST', r.created && env && ID.REF_RE.test(env.bookingRef) && env.bookingRef.startsWith('BK-ART-') && env.category === 'ARTIST', env && env.bookingRef);
  ck('parties derived from the SOURCE record (buyer = customerUid, provider = providerId)', env.buyerUid === 'buyer1' && env.providerUid === 'djK' && env.providerKind === 'artist');
  const sec = await get('entBookingSecrets/svc_pbA');
  ck('a 4-digit booking PIN issued by the server; the envelope holds only its hash', /^\d{4}$/.test(sec.pin) && env.pin.hash && env.pin.hash.length === 64 && !JSON.stringify(env).includes(`"${sec.pin}"`));
  ck('the reference is reserved (entBookingRefs) → unique', (await get(`entBookingRefs/${env.bookingRef}`)).envId === 'svc_pbA');
  const again = await EB.onSourceWritten('providerBookings', 'pbA', pb);
  ck('a re-fired trigger creates nothing new (one identity per booking)', again.changed === false && db._dump('entBookings/').length === 1);
  const conv = await get('conversations/ent_booking_svc_pbA');
  ck('the conversation exists, created by the SERVER, parties = the booking\'s buyer + provider', !!conv && conv.serverAnchored === true && JSON.stringify(conv.participants.slice().sort()) === JSON.stringify(['buyer1', 'djK']) && (await get('entBookings/svc_pbA')).conversationId === 'ent_booking_svc_pbA');
  ck('both parties see it in their inbox (userConversations)', !!(await get('userConversations/buyer1/items/ent_booking_svc_pbA')) && !!(await get('userConversations/djK/items/ent_booking_svc_pbA')));
  ck('title "Artist booking — BK-ART-…"', conv.transactionTitle === `Artist booking — ${env.bookingRef}`);
  const sys = db._dump('conversations/ent_booking_svc_pbA/messages/');
  ck('a SYSTEM event "Artist booking created" was posted', sys.some((m) => m.senderId === 'system' && /Artist booking created/.test(m.text)));
  ck('buyer and provider notified with canonical types, anchored to the booking', notices.some((n) => n.uid === 'buyer1' && n.type === 'ent_booking_created' && n.anchorType === 'booking') && notices.some((n) => n.uid === 'djK' && n.type === 'ent_booking_created'));
  /* the reference itself contains digits: strip it, then the PIN must not appear as a 4-digit token */
  const noticeText = notices.map((n) => `${n.title} ${n.body} ${JSON.stringify(n.data || {})}`.split(env.bookingRef).join('')).join(' ');
  ck('no notification carries the PIN (title, body or data)', !new RegExp(`(^|\\D)${sec.pin}(\\D|$)`).test(noticeText) && !notices.some((n) => n.data && 'pin' in n.data));

  /* ═══ views ═══ */
  say('\n── views ──');
  const bv = (await h('entBookingGet', 'buyer1', { bookingRef: env.bookingRef })).booking;
  ck('BUYER sees the PIN and "PIN YAKO NI BOOKING YAKO"', bv.pin === sec.pin && bv.phrase === 'PIN YAKO NI BOOKING YAKO' && bv.role === 'buyer');
  const pv = (await h('entBookingGet', 'djK', { bookingRef: env.bookingRef })).booking;
  ck('PROVIDER sees •••• and the buyer\'s initials only (no uid, phone or email)', pv.pin === '••••' && pv.buyer.initials === 'AO' && !JSON.stringify(pv).includes('buyer1'));
  ck('a stranger learns nothing (not-found, same as a missing booking)', (await code(h('entBookingGet', 'mallory', { bookingRef: env.bookingRef }))) === 'not-found' && (await code(h('entBookingGet', 'mallory', { bookingRef: 'BK-ART-2026-000000' }))) === 'not-found');
  ck('"my bookings" lists it for the buyer and for the provider', (await h('entBookingMine', 'buyer1')).bookings.length === 1 && (await h('entBookingMine', 'djK', { as: 'provider' })).bookings.length === 1);
  const oc = await h('entBookingOpenConversation', 'buyer1', { bookingRef: env.bookingRef });
  ck('"Message" opens the booking\'s conversation (chat.html?id=…)', oc.conversationId === 'ent_booking_svc_pbA' && oc.url === '/chat.html?id=ent_booking_svc_pbA');
  ck('a stranger cannot open it', (await code(h('entBookingOpenConversation', 'mallory', { bookingRef: env.bookingRef }))) === 'not-found');

  /* ═══ PIN verification ═══ */
  say('\n── booking PIN verification ──');
  ck('the protected action (service start) is refused BEFORE the PIN is verified', (await code(EB.assertVerified('providerBookings', 'pbA'))) === 'failed-precondition');
  ck('only the booking\'s provider can verify (another provider refused)', (await code(h('entBookingVerifyPin', 'otherProv', { bookingRef: env.bookingRef, pin: sec.pin }))) === 'permission-denied');
  ck('the buyer cannot verify their own booking', (await code(h('entBookingVerifyPin', 'buyer1', { bookingRef: env.bookingRef, pin: sec.pin }))) === 'permission-denied');
  const wrong = sec.pin === '1111' ? '2222' : '1111';
  const w1 = await h('entBookingVerifyPin', 'djK', { bookingRef: env.bookingRef, pin: wrong });
  ck('a wrong PIN is refused and counted; audited WITHOUT the PIN', w1.verified === false && (await get('entBookingPinAttempts/svc_pbA_djK')).fails === 1 && db._dump('entBookingAudit/').some((a) => a.action === 'ent_booking_pin_failed' && !JSON.stringify(a).includes(wrong)));
  /* a second booking for the same provider: its PIN must not verify the first */
  const pb2 = { ...pb, paymentRef: 'PAYART2', startTs: NOW + 72 * H, endTs: NOW + 76 * H };
  await db.doc('providerBookings/pbB').set(pb2);
  await EB.onSourceWritten('providerBookings', 'pbB', pb2);
  const sec2 = await get('entBookingSecrets/svc_pbB');
  const env2 = await get('entBookings/svc_pbB');
  if (sec2.pin !== sec.pin) {
    const cross = await h('entBookingVerifyPin', 'djK', { bookingRef: env.bookingRef, pin: sec2.pin });
    ck('booking B\'s PIN never verifies booking A (HMAC-bound to the booking)', cross.verified === false);
  } else ck('booking B\'s PIN never verifies booking A (identical draw — hashes still differ)', env.pin.hash !== env2.pin.hash);
  /* FORCED identical draw: two bookings receive the SAME digits; the binding to the booking is what keeps them
     apart. Without this, a PIN hash that drops the booking id passes whenever the random draws differ. */
  EB._setRandom((n) => (n === 10000 ? 4242 : require('crypto').randomInt(0, n)));
  const pbSameC = { ...pb, paymentRef: 'PAYART3', startTs: NOW + 96 * H, endTs: NOW + 100 * H };
  const pbSameD = { ...pb, paymentRef: 'PAYART4', startTs: NOW + 120 * H, endTs: NOW + 124 * H };
  await db.doc('providerBookings/pbSame1').set(pbSameC); await EB.onSourceWritten('providerBookings', 'pbSame1', pbSameC);
  await db.doc('providerBookings/pbSame2').set(pbSameD); await EB.onSourceWritten('providerBookings', 'pbSame2', pbSameD);
  EB._setRandom(null);
  const secC = await get('entBookingSecrets/svc_pbSame1'); const secD = await get('entBookingSecrets/svc_pbSame2');
  ck('booking B\'s PIN never verifies booking A — FORCED same digits, the stored hashes still differ (bound to the booking)',
    !!(secC && secD) && secC.pin === '4242' && secD.pin === '4242' && (await get('entBookings/svc_pbSame1')).pin.hash !== (await get('entBookings/svc_pbSame2')).pin.hash);
  const OPS = require(Path.join(FN, 'event-ops.js'));
  ck('a TICKET PIN hash never equals a BOOKING PIN hash for the same digits (separate domains)', OPS.pinHash('svc_pbA', sec.pin) !== env.pin.hash);
  const early = await h('entBookingVerifyPin', 'djK', { bookingRef: env.bookingRef, pin: sec.pin });
  ck('the RIGHT PIN is refused TOO EARLY (days before the booking) — no early settlement', early.verified === false && early.state === 'NOT_YET' && (await get('providerBookings/pbA')).paymentStatus === 'paid_held', early);
  NOW = pb.startTs - 1 * H;                                       /* the buyer shows up */
  const djWallet0 = ((await get('wallets/djK')) || {}).balance || 0;
  const ok = await h('entBookingVerifyPin', 'djK', { bookingRef: env.bookingRef, pin: sec.pin });
  ck('the right PIN verifies the booking', ok.verified === true && (await get('entBookings/svc_pbA')).verification.state === 'VERIFIED');
  ck('…the protected action is now allowed', (await EB.assertVerified('providerBookings', 'pbA')).verified === true);
  /* SHOW-UP SETTLES THE BOOKING (owner decision 2026-09-27) */
  const po = await get('providerPayouts/pbA');
  const pbAfter = await get('providerBookings/pbA');
  ck('show-up settled the booking: SOKONI 5 % (KES 1,000 of 20,000), provider net to the PROVIDER\'s business wallet',
    ok.settled === true && po && po.settledTrigger === 'show_up' && po.commission === 100000 && ((((await get('wallets/djK')) || {}).balance || 0) - djWallet0) === 19000 && pbAfter.paymentStatus === 'settled' && pbAfter.status === 'in_progress', po && { commission: po.commission, net: po.net });
  ck('…never the buyer\'s wallet', !((await get('wallets/buyer1')) || {}).balance && !(((await get('users/buyer1')) || {}).walletBalance > 0));
  ck('…the provider is told the amount; the commission ledger row is the 5 % lane', notices.some((n) => n.uid === 'djK' && /credited to your business wallet/.test(n.body)) && po.category === 'entertainment_bookings');
  const POps = require(Path.join(FN, 'provider-ops.js'));
  const comp = await POps._h.providerCompleteBooking({ ...who('djK'), data: { bookingId: 'pbA' } });
  const poAfter = (await get('providerPayouts/pbA')) || {};
  ck('completion afterwards closes the booking WITHOUT paying again', comp.success && comp.settledAtShowUp === true && (await get('providerBookings/pbA')).status === 'completed' && ((((await get('wallets/djK')) || {}).balance || 0) - djWallet0) === 19000);
  ck('…the show-up payout record survives completion unchanged (not re-settled)', poAfter.settledTrigger === 'show_up' && poAfter.commission === po.commission && poAfter.net === po.net && poAfter.status === po.status, { before: po.status, after: poAfter.status, trigger: poAfter.settledTrigger });
  ck('…a system event and a buyer notification record it', db._dump('conversations/ent_booking_svc_pbA/messages/').some((m) => /verified with the buyer's PIN/.test(m.text)) && notices.some((n) => n.type === 'ent_booking_verified' && n.uid === 'buyer1'));
  const twice = await h('entBookingVerifyPin', 'djK', { bookingRef: env.bookingRef, pin: sec.pin });
  ck('the PIN is used ONCE (a replay is refused as used)', twice.verified === false && twice.state === 'USED');
  /* lockout on booking B */
  let locked = null;
  for (let i = 0; i < 6 && !locked; i++) { const c = await code(h('entBookingVerifyPin', 'djK', { bookingRef: env2.bookingRef, pin: sec2.pin === '9999' ? '8888' : '9999' })); if (c === 'resource-exhausted') locked = true; }
  ck('5 wrong PINs → locked out; a security event is recorded', locked === true && db._dump('securityEvents/').some((e) => e.type === 'ent_booking_pin_lockout'));
  ck('…even the RIGHT PIN is refused while locked', (await code(h('entBookingVerifyPin', 'djK', { bookingRef: env2.bookingRef, pin: sec2.pin }))) === 'resource-exhausted');

  /* ═══ lifecycle sync ═══ */
  say('\n── lifecycle ──');
  await db.doc('providerBookings/pbB').set({ status: 'cancelled', paymentStatus: 'refunded' }, { merge: true });
  await EB.onSourceWritten('providerBookings', 'pbB', await get('providerBookings/pbB'));
  const envB = await get('entBookings/svc_pbB');
  ck('source cancelled + refunded → envelope CANCELLED, refund COMPLETED, PIN INVALID', envB.status === 'CANCELLED' && envB.refund.state === 'COMPLETED' && ID.pinState(envB, NOW) === 'INVALID');
  ck('the conversation received "Refund completed" and a notification went out', db._dump('conversations/ent_booking_svc_pbB/messages/').some((m) => /REFUND COMPLETED/i.test(m.text)) && notices.some((n) => n.type === 'ent_booking_refund_update'));
  /* a fresh booking (no lockout), cancelled, then its RIGHT PIN */
  const pbC = { ...pb, paymentRef: 'PAYART3', startTs: NOW + 120 * H, endTs: NOW + 124 * H };
  await db.doc('providerBookings/pbC').set(pbC); await EB.onSourceWritten('providerBookings', 'pbC', pbC);
  await db.doc('providerBookings/pbC').set({ status: 'cancelled' }, { merge: true }); await EB.onSourceWritten('providerBookings', 'pbC', await get('providerBookings/pbC'));
  const vc = await h('entBookingVerifyPin', 'djK', { bookingRef: (await get('entBookings/svc_pbC')).bookingRef, pin: (await get('entBookingSecrets/svc_pbC')).pin });
  ck('the RIGHT PIN on a cancelled booking is refused (INVALID), not verified', vc.verified === false && vc.state === 'INVALID', vc);

  /* ═══ skips ═══ */
  say('\n── what gets NO identity ──');
  const plain = { ...pb, providerId: 'plumb', commissionHub: 'provider', entClass: null };
  ck('a non-Entertainment provider booking', (await EB.onSourceWritten('providerBookings', 'pbP', plain)).skipped === 'not_entertainment');
  ck('an unpaid hold', (await EB.onSourceWritten('providerBookings', 'pbH', { ...pb, status: 'pending', paymentStatus: 'pending' })).skipped === 'not_paid');

  /* ═══ VENUE ═══ */
  say('\n── venue booking ──');
  await db.doc('venues/v1').set({ ownerId: 'owner1', name: 'Karura Garden', status: 'active', city: 'Nairobi' });
  const vb = { venueId: 'v1', venueName: 'Karura Garden', ownerId: 'owner1', customerId: 'buyer1', status: 'confirmed', paymentStatus: 'unpaid', startTs: NOW + 1 * H, endTs: NOW + 5 * H, date: '2026-10-01', startTime: '10:00', endTime: '14:00', pricingBreakdown: { total: 0 } };
  await db.doc('bookings/vbk1').set(vb);
  await EB.onSourceWritten('bookings', 'vbk1', vb);
  const envV = await get('entBookings/ven_vbk1');
  ck('venue booking → BK-VEN, provider = the VENUE\'s owner', envV && envV.bookingRef.startsWith('BK-VEN-') && envV.providerUid === 'owner1' && envV.category === 'VENUE');
  ck('a booking whose ownerId does not match the venue\'s owner gets no identity (forged provider)', (await EB.onSourceWritten('bookings', 'vbk9', { ...vb, ownerId: 'mallory' })).skipped === 'owner_mismatch');
  ck('a legacy service doc in the shared collection is not taken for a venue', (await EB.onSourceWritten('bookings', 'vbk8', { customerUid: 'x', providerId: 'y', status: 'confirmed' })).skipped === 'not_venue_core');
  ck('a CLIENT-written venue booking (no server pricing) gets no identity, PIN or conversation', (await EB.onSourceWritten('bookings', 'vbk7', { ...vb, pricingBreakdown: undefined })).skipped === 'not_server_written');
  const BK = require(Path.join(FN, 'booking.js'));
  ck('the CUSTOMER can no longer check themselves in', (await code(BK._h.bookingCheckIn({ ...who('buyer1'), data: { bookingId: 'vbk1' } }))) === 'permission-denied');
  ck('the venue cannot check in BEFORE verifying the booking PIN', (await code(BK._h.bookingCheckIn({ ...who('owner1'), data: { bookingId: 'vbk1' } }))) === 'failed-precondition');
  const secV = await get('entBookingSecrets/ven_vbk1');
  await h('entBookingVerifyPin', 'owner1', { bookingRef: envV.bookingRef, pin: secV.pin });
  const ci = await BK._h.bookingCheckIn({ ...who('owner1'), data: { bookingId: 'vbk1', time: 1 } });
  const vAfter = await get('bookings/vbk1');
  ck('after the PIN, the venue checks in; the time is the SERVER\'s', ci.checkedIn && vAfter.status === 'active' && vAfter.checkIn.time !== 1);

  /* ═══ EVENT ═══ */
  say('\n── event order ──');
  await db.doc('events/evX').set({ title: 'Nairobi Jazz', organizerUid: 'org1', startDate: new Date(NOW + 24 * H).toISOString(), endDate: new Date(NOW + 28 * H).toISOString(), venue: 'KICC' });
  await db.doc('eventTickets/EO1_k0').set({ orderId: 'EO1', ticketNumber: 'SK-EVT-2026-000222' });
  await db.doc('eventTickets/EO1_k1').set({ orderId: 'EO1', ticketNumber: 'SK-EVT-2026-000111' });
  const eo = { orderId: 'EO1', buyerUid: 'buyer1', eventId: 'evX', status: 'paid', totalAmount: 4000, quantity: 2, paymentRef: 'EO1', tierName: 'Regular' };
  await db.doc('eventOrders/EO1').set(eo);
  await EB.onSourceWritten('eventOrders', 'EO1', eo);
  const envE = await get('entBookings/evt_EO1');
  ck('a paid event order → EVENT identity keyed on its ticket numbers, organizer = the event\'s', envE && envE.category === 'EVENT' && envE.bookingRef === 'SK-EVT-2026-000111' && envE.providerUid === 'org1');
  ck('an event order carries NO booking PIN (the ticket PIN is the credential) and says "PIN YAKO NI TICKET YAKO"', envE.pin === null && !(await get('entBookingSecrets/evt_EO1')) && ID.phraseFor('EVENT') === 'PIN YAKO NI TICKET YAKO');
  ck('its conversation is "Event booking — SK-EVT-…" between buyer and organizer', (await get('conversations/ent_booking_evt_EO1')).transactionTitle === 'Event booking — SK-EVT-2026-000111');
  ck('an unpaid order and a walk-in (cashier) order get none', (await EB.onSourceWritten('eventOrders', 'EO2', { ...eo, status: 'pending_payment' })).skipped === 'not_paid' && (await EB.onSourceWritten('eventOrders', 'EO3', { ...eo, channel: 'cashier' })).skipped === 'walk_in');
  await db.doc('eventRefundRequests/EO1').set({ status: 'PENDING_REVIEW' });
  await EB.onSourceWritten('eventOrders', 'EO1', eo);
  ck('the refund wizard\'s request → envelope refund UNDER_REVIEW + conversation event', (await get('entBookings/evt_EO1')).refund.state === 'UNDER_REVIEW' && db._dump('conversations/ent_booking_evt_EO1/messages/').some((m) => /REFUND UNDER REVIEW/i.test(m.text)));

  /* ═══ conversations: server-only ═══ */
  say('\n── conversations are server-anchored ──');
  ck('a client cannot create an ent_booking conversation (participant substitution)', (await code(M._h.createConversation({ ...who('mallory'), data: { transactionType: 'ent_booking', transactionId: 'svc_pbA', participantUids: ['mallory', 'djK'] } }))) === 'permission-denied');

  /* ═══ money guards ═══ */
  say('\n── money guards ──');
  const PO = require(Path.join(FN, 'provider-ops.js'));
  await db.doc('providerBookings/pbD').set({ providerId: 'djK', customerUid: 'buyer1', status: 'confirmed', paymentStatus: 'paid_held', price: 500000, fee: 0, deposit: 0, startTs: NOW + 96 * H, commissionHub: 'entertainment', entClass: 'ARTIST' });
  const bal0 = ((await get('users/buyer1')) || {}).walletBalance || 0;
  await PO._h.providerDeclineBooking({ ...who('djK'), data: { bookingId: 'pbD', reason: 'double booked' } });
  ck('a provider DECLINING a paid booking refunds the customer in full (the money was stuck)', (await get('providerBookings/pbD')).paymentStatus === 'refunded' && ((await get('users/buyer1')).walletBalance - bal0) === 5000);
  const fosSrc = fs.readFileSync(Path.join(FN, 'financial-os.js'), 'utf8');
  ck('fosSubmitRefund refuses a service-booking payment (no double refund beside the booking\'s own)', /_fi\.data\(\)\.purpose === 'service_booking'\) \{\s*throw new HttpsError\('failed-precondition'/.test(fosSrc));

  /* ═══ AdminOS ═══ */
  say('\n── AdminOS ──');
  ck('a non-admin cannot search', (await code(EB._adminH.entAdminBookings({ ...who('buyer1'), data: { by: 'ref', value: env.bookingRef } }))) === 'permission-denied');
  const found = await EB._adminH.entAdminBookings({ ...who('adm', { admin: true }), data: { by: 'ref', value: env.bookingRef } });
  ck('admin finds the booking by reference — no PIN hash in the result', found.bookings.length === 1 && !JSON.stringify(found).includes(env.pin.hash));
  const tr = await EB._adminH.entAdminBookingTrace({ ...who('adm', { admin: true }), data: { bookingRef: env.bookingRef } });
  ck('trace: booking → payment → conversation METADATA (count, not content) → PIN state → audit', tr.booking.bookingRef === env.bookingRef && tr.conversation.messageCount >= 2 && tr.conversation.content.startsWith('withheld') && tr.pin.state === 'USED' && tr.audit.some((a) => a.action === 'ent_booking_verified'));
  ck('an ordinary admin cannot read the conversation content', (await code(EB._adminH.entAdminBookingConversation({ ...who('adm', { admin: true }), data: { bookingRef: env.bookingRef, reason: 'dispute investigation' } }))) === 'permission-denied');
  ck('a super admin must state a reason', (await code(EB._adminH.entAdminBookingConversation({ ...who('root', { superAdmin: true }), data: { bookingRef: env.bookingRef, reason: 'x' } }))) === 'invalid-argument');
  const cr = await EB._adminH.entAdminBookingConversation({ ...who('root', { superAdmin: true }), data: { bookingRef: env.bookingRef, reason: 'buyer dispute DSP-44' } });
  ck('super admin + reason reads it, and the read is AUDITED', cr.messages.length >= 2 && db._dump('adminAudit/').some((a) => a.action === 'ent_conversation_read' && a.reason === 'buyer dispute DSP-44'));
  ck('a forged isSuperAdmin in the request DATA grants nothing', (await code(EB._adminH.entAdminBookingConversation({ ...who('adm', { admin: true }), data: { bookingRef: env.bookingRef, reason: 'buyer dispute DSP-44', isSuperAdmin: true, superAdmin: true } }))) === 'permission-denied');

  /* ═══ VENUE RAIL: paid online, settled at show-up, venue refund policy ═══ */
  say('\n── venue rail ──');
  const VP = require(Path.join(FN, 'venue-payments.js'));
  VP._setClock(() => NOW);
  await db.doc('venues/v2').set({ ownerId: 'owner2', name: 'Rooftop 88', status: 'active', pricing: { cancellationWindow: 48 } });
  const vpay = { venueId: 'v2', venueName: 'Rooftop 88', ownerId: 'owner2', customerId: 'buyer1', status: 'confirmed', paymentStatus: 'awaiting', requiresPayment: true, paymentDueBy: NOW + 30 * 60e3,
    startTs: NOW + 72 * H, endTs: NOW + 76 * H, pricingBreakdown: { total: 10000 }, cancellationWindowHours: 48, cancellationFeeRate: 0.2 };
  await db.doc('bookings/VB1').set(vpay);
  ck('a stranger cannot price / pay someone else\'s booking', (await code(VP.priceVenueBooking('mallory', { bookingId: 'VB1' }))) === 'permission-denied');
  const pr = await VP.priceVenueBooking('buyer1', { bookingId: 'VB1' });
  ck('priced from the booking\'s SERVER total (KES 10,000), one payment identity per booking', pr.amountCents === 1000000 && pr.preferredRef === 'VB-VB1' && pr.metadata.ownerUid === 'owner2');
  const SSP = require(Path.join(FN, 'shared', 'self-settling-purposes.js'));
  ck('venue_booking is SELF-SETTLING: the generic webhook never credits the payer', SSP.isSelfSettling('venue_booking'));
  await db.doc('paymentIntents/VB-VB1').set({ ref: 'VB-VB1', purpose: 'venue_booking', resourceType: 'venueBooking', resourceId: 'VB1', uid: 'buyer1', ownerUid: 'buyer1', amount: 10000, amountCents: 1000000, currency: 'KES', status: 'created', metadata: pr.metadata });
  await db.doc('payments/VB-VB1').set({ ref: 'VB-VB1', uid: 'buyer1', amount: 10000, amountCents: 1000000, currency: 'KES', status: 'COMPLETE', providerReport: { charges: 100 } });
  const act = await VP.activateIfVenueBooking('VB-VB1');
  const vs = await get('venueSettlements/VB-VB1');
  ck('payment → booking paid; settlement HELD: 5 % (500) + provider fee (100) → net 9,400', act.activated && (await get('bookings/VB1')).paymentStatus === 'paid' && vs.status === 'HELD' && vs.commissionCents === 50000 && vs.netCents === 940000, vs && { c: vs.commissionCents, n: vs.netCents });
  ck('a replayed activation changes nothing (exactly once)', (await VP.activateIfVenueBooking('VB-VB1')).alreadyActive === true);
  await EB.onSourceWritten('bookings', 'VB1', await get('bookings/VB1'));
  const envVB = await get('entBookings/ven_VB1');
  ck('the envelope shows payment CONFIRMED', envVB.payment.state === 'CONFIRMED');
  /* refund policy quotes */
  const vb1 = await get('bookings/VB1');
  ck('buyer cancels ≥ 48 h before → FULL refund', VP.refundQuote(vb1, null, NOW, 'buyer').refundKes === 10000);
  ck('buyer cancels inside the window → refund less the venue\'s 20 % fee', (() => { const q = VP.refundQuote(vb1, null, vb1.startTs - 24 * H, 'buyer'); return q.refundKes === 8000 && q.feeKes === 2000; })());
  ck('after the start → NO automatic refund', VP.refundQuote(vb1, null, vb1.startTs + 1, 'buyer').eligible === false);
  ck('the venue cancels → FULL refund whatever the timing', VP.refundQuote(vb1, null, vb1.startTs - 1 * H, 'owner').refundKes === 10000);
  const FOS = require(Path.join(FN, 'financial-os.js'));
  ck('a DIRECT fosSubmitRefund for a venue payment is refused (the venue policy prices it)', (await code(FOS.fosSubmitRefund.run({ ...who('buyer1'), data: { payRef: 'VB-VB1', amountKES: 10000, reason: 'direct' } }))) === 'failed-precondition');
  NOW = vb1.startTs - 24 * H;
  const rq = await VP.requestRefund({ ...who('buyer1'), data: { bookingId: 'VB1', reason: 'plans changed' } });
  const q = await get('fosRefundQueue/ref_VB-VB1');
  ck('buyer refund request → the CANONICAL refund queue, priced by the policy (8,000), pending review', rq.refundKes === 8000 && q && q.amountKES === 8000 && q.status === 'pending' && q.buyerUid === 'buyer1', q && q.amountKES);
  ck('a second request is refused', (await code(VP.requestRefund({ ...who('buyer1'), data: { bookingId: 'VB1', reason: 'again please' } }))) === 'already-exists');
  const ow0 = ((await get('wallets/owner2')) || {}).balance || 0;
  await db.doc('fosRefundQueue/ref_VB-VB1').set({ status: 'processed' }, { merge: true });   /* the refund authority executed it */
  await VP.onVenueRefundProcessed({ payRef: 'VB-VB1', amountCents: 800000 });
  const vs2 = await get('venueSettlements/VB-VB1');
  ck('refund executed (8,000) → the kept 2,000 fee is released to the VENUE (less 5 % and the provider fee)', vs2.status === 'RELEASED' && vs2.releasedBy === 'cancellation_fee' && ((((await get('wallets/owner2')) || {}).balance || 0) - ow0) === Math.floor(vs2.netCents / 100) && (await get('bookings/VB1')).status === 'cancelled');
  /* show-up release on a second paid booking */
  NOW = Date.now();
  const vpay2 = { ...vpay, startTs: NOW + 1 * H, endTs: NOW + 5 * H };
  await db.doc('bookings/VB2').set(vpay2);
  await db.doc('paymentIntents/VB-VB2').set({ ref: 'VB-VB2', purpose: 'venue_booking', resourceType: 'venueBooking', resourceId: 'VB2', uid: 'buyer1', ownerUid: 'buyer1', amount: 10000, amountCents: 1000000, currency: 'KES', status: 'created', metadata: { type: 'venue_booking', bookingId: 'VB2', ownerUid: 'owner2' } });
  await db.doc('payments/VB-VB2').set({ ref: 'VB-VB2', uid: 'buyer1', amount: 10000, amountCents: 1000000, currency: 'KES', status: 'COMPLETE', providerReport: { charges: 100 } });
  await VP.activateIfVenueBooking('VB-VB2');
  await EB.onSourceWritten('bookings', 'VB2', await get('bookings/VB2'));
  const e2v = await get('entBookings/ven_VB2'); const s2v = await get('entBookingSecrets/ven_VB2');
  const ow1 = ((await get('wallets/owner2')) || {}).balance || 0;
  const vv = await h('entBookingVerifyPin', 'owner2', { bookingRef: e2v.bookingRef, pin: s2v.pin });
  ck('SHOW-UP: the venue verifies the PIN → the owner\'s business wallet is credited the net (9,400), SOKONI 5 % collected',
    vv.verified && vv.settled && ((((await get('wallets/owner2')) || {}).balance || 0) - ow1) === 9400 && (await get('venueSettlements/VB-VB2')).releasedBy === 'show_up' && (await get('commissionLedger/ven_VB-VB2')).status === 'collected');
  ck('…never the buyer\'s wallet', !((await get('wallets/buyer1')) || {}).balance);
  ck('a used booking cannot then be refunded automatically', (await code(VP.requestRefund({ ...who('buyer1'), data: { bookingId: 'VB2', reason: 'changed my mind' } }))) === 'failed-precondition');
  /* no-show release */
  const vpay3 = { ...vpay, startTs: NOW + 1 * H, endTs: NOW + 2 * H };
  await db.doc('bookings/VB3').set(vpay3);
  await db.doc('paymentIntents/VB-VB3').set({ ref: 'VB-VB3', purpose: 'venue_booking', resourceType: 'venueBooking', resourceId: 'VB3', uid: 'buyer1', ownerUid: 'buyer1', amount: 10000, amountCents: 1000000, currency: 'KES', status: 'created', metadata: {} });
  await db.doc('payments/VB-VB3').set({ ref: 'VB-VB3', uid: 'buyer1', amount: 10000, amountCents: 1000000, currency: 'KES', status: 'COMPLETE', providerReport: { charges: 100 } });
  await VP.activateIfVenueBooking('VB-VB3');
  ck('a no-show is NOT paid before end + 24 h (the buyer\'s dispute window)', (await VP.releaseNoShow('VB-VB3', NOW + 3 * H)).skipped === 'not_due');
  ck('…after it, the venue is paid (the slot was reserved)', (await VP.releaseNoShow('VB-VB3', NOW + 27 * H)).released === true && (await get('venueSettlements/VB-VB3')).releasedBy === 'no_show');
  /* unpaid expiry */
  await db.doc('bookings/VB4').set({ ...vpay, paymentDueBy: NOW - 1 });
  const sw = await VP.sweep(NOW);
  ck('an unpaid booking past its 30-minute window is cancelled (slot released)', sw.expired >= 1 && (await get('bookings/VB4')).status === 'cancelled');
  const bkSrc = fs.readFileSync(Path.join(FN, 'booking.js'), 'utf8');
  ck('client add-on prices are no longer accepted by bookingCreate', /const addOns = \[\];/.test(bkSrc));

  /* ═══ wiring ═══ */
  say('\n── wiring ──');
  const idx = fs.readFileSync(Path.join(FN, 'index.js'), 'utf8');
  ck('the four source triggers are exported BY NAME', ['entBookingOnEventOrder', 'entBookingOnEventRefund', 'entBookingOnProviderBooking', 'entBookingOnVenueBooking'].every((n) => new RegExp(`exports\\.${n}\\s*=`).test(idx)));
  ck('booking ops ride the existing eventOpsDispatch; admin ops the existing adminOsDispatch', /require\('\.\/entertainment-bookings'\)\._h\[op\]/.test(fs.readFileSync(Path.join(FN, 'event-ops.js'), 'utf8')) && /entBk\._adminH/.test(fs.readFileSync(Path.join(FN, 'admin-os-dispatch.js'), 'utf8')));
  const CCALLS = fs.readFileSync(Path.join(FN, 'connect-calls.js'), 'utf8');
  ck('Connect knows the entBooking anchor (parties from the envelope, kind booking)', /entBooking: _anchorEntBooking/.test(CCALLS) && /parties: \{ buyer: String\(b\.buyerUid\), provider: String\(b\.providerUid\) \}/.test(CCALLS));
  const NOT = fs.readFileSync(Path.join(FN, 'notify.js'), 'utf8');
  ck('notify types registered (incl. the four booking types that were silently dropped)', ['ent_booking_created', 'ent_booking_update', 'ent_booking_refund_update', 'ent_booking_verified', 'booking_confirmed', 'booking_cancelled', 'booking_refund_completed', 'booking_reschedule_proposed'].every((t) => new RegExp(`\\b${t}:\\s*\\{`).test(NOT)));

  say(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { say('CRASH ' + (e && e.stack || e)); process.exit(2); });
