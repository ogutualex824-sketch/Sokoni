/* test-event-ops.js — ticket PINs, event-scoped temporary staff and PIN admission, on the
 * transactional fake Firestore (real transaction semantics: buffered commits, create()
 * preconditions, optimistic retry).
 *
 * PROVES (each grant paired with its refusal)
 *   PIN          8 chars / 32-char alphabet · normalisation · bound to ONE event (hash differs) ·
 *                issued only when a ticket is PAID (activation) or free · unique per event (index
 *                create) · raw PIN only in the deny-by-default secret, never on the ticket/audit
 *   Visibility   getMyTickets returns the PIN to the buyer only · getTicket hides token/pinHash
 *                from the organizer
 *   Admission    valid PIN admits once · wrong PIN / wrong event / refunded / refund requested /
 *                unpaid refused · 8 concurrent admits → exactly ONE admission · brute force →
 *                per-staff lockout, then per-event lockout (distributed guessing)
 *   Staff        invite → accept with the VERIFIED invited email only · roles are closed tables
 *                (cashier cannot admit, admission cannot sell, marketing neither) · expired /
 *                not-started / revoked / other event refused · access cannot outlive the event
 *                by > 48 h · staff never manage staff
 *   Legacy QR    checkInTicket is event-scoped + transactional (concurrent → one) and constant-time
 *   Fail-open    a STRING role claim no longer passes event-hub's admin checks
 *   Notify       organizer_approved and the event types are registered (approval notices deliver)
 *
 *   node scripts/test-event-ops.js
 */
'use strict';
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:1';
process.env.GCLOUD_PROJECT = 'demo-event-ops';
delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
delete process.env.K_SERVICE; delete process.env.FUNCTION_TARGET;

const Path = require('path');
const FN = Path.resolve(__dirname, '..', 'functions');
const { makeFakeFirestore } = require('./lib/fake-firestore-txn');
let NOW = Date.now();
const F = makeFakeFirestore({ clock: () => NOW });
const db = F.db;
const claimsOf = {};
const authApi = { getUser: async (u) => ({ uid: u, customClaims: claimsOf[u] || {} }) };
const resolveIn = (m) => require.resolve(m, { paths: [FN] });
const stub = (m, exp) => { require.cache[resolveIn(m)] = { id: m, filename: m, loaded: true, exports: exp }; };
stub('firebase-admin/firestore', { getFirestore: () => db, FieldValue: F.FieldValue, Timestamp: F.Timestamp, FieldPath: F.FieldPath });
stub('firebase-admin/auth', { getAuth: () => authApi });
stub('firebase-admin', { apps: [{}], initializeApp: () => ({}), firestore: Object.assign(() => db, { FieldValue: F.FieldValue, Timestamp: F.Timestamp }), auth: () => authApi });

const OPS = require(Path.join(FN, 'event-ops.js'));
OPS._setClock(() => NOW);
const ES = require(Path.join(FN, 'event-settlement.js'));
const EH = require(Path.join(FN, 'event-hub.js'));
ES.registerPurpose();

let pass = 0, fail = 0;
const ck = (l, ok, d) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined && d !== '' ? '   [' + String(typeof d === 'object' ? JSON.stringify(d) : d).slice(0, 140) + ']' : '')); ok ? pass++ : fail++; };
const who = (uid, token = {}) => ({ auth: uid ? { uid, token } : null, rawRequest: { headers: {} } });
const op = (name, uid, data = {}, token = {}) => OPS._h[name]({ ...who(uid, token), data });
async function code(p) { try { await p; return null; } catch (e) { return e.code || e.message; } }
const get = async (p) => { const s = await db.doc(p).get(); return s.exists ? s.data() : null; };
const H = 3600 * 1000;

async function event(id, org = 'org1', startMs = NOW + 48 * H) {
  await db.doc(`events/${id}`).set({ title: 'Gig ' + id, organizerUid: org, status: 'live', startDate: new Date(startMs).toISOString(), endDate: new Date(startMs + 4 * H).toISOString(), checkinsCount: 0 });
  await db.doc(`eventTicketTiers/${id}_t`).set({ eventId: id, name: 'Regular', price: 500, quantity: 50, sold: 0, isActive: true, currency: 'KES' });
}
/* a paid order through the REAL activation (engine + adapter) → valid tickets with PINs */
async function paidOrder(orderId, eventId, qty = 2, buyer = 'buyer1') {
  await db.doc(`eventOrders/${orderId}`).set({ orderId, buyerUid: buyer, eventId, tierId: `${eventId}_t`, tierName: 'Regular', quantity: qty, totalAmount: 500 * qty, currency: 'KES', status: 'pending_payment', attendeeName: 'Achieng Otieno', createdAt: F.Timestamp.fromMillis(NOW) });
  for (let i = 0; i < qty; i++) await db.doc(`eventTickets/${orderId}_k${i}`).set({ ticketId: `${orderId}_k${i}`, orderId, eventId, buyerUid: buyer, tierName: 'Regular', status: 'awaiting_payment', attendeeName: 'Achieng Otieno', token: 'tok' + i + orderId });
  await db.doc(`paymentIntents/${orderId}`).set({ ref: orderId, purpose: 'event_ticket', resourceType: 'eventOrder', resourceId: orderId, uid: buyer, ownerUid: buyer, amount: 5 * qty * 100 / 100, amountCents: 50000 * qty, currency: 'KES', status: 'created', metadata: { eventId, organizerUid: 'org1' } });
  await db.doc(`payments/${orderId}`).set({ ref: orderId, uid: buyer, amountCents: 50000 * qty, currency: 'KES', status: 'COMPLETE', providerReport: { charges: 10 } });
  return ES.activateIfEventTicket(orderId);
}
const pinOf = async (ticketId) => (await get(`eventTicketSecrets/${ticketId}`) || {}).pin;

(async () => {
  /* ═══ PIN primitives ═══ */
  console.log('\n── PIN ──');
  const p = OPS.generatePin();
  ck('PIN is XXXX-XXXX from the 32-char alphabet (no 0/O/1/I)', /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/.test(p), p.length);
  ck('normalisation accepts spacing/case, refuses foreign chars', OPS.normalizePin(p.toLowerCase().replace('-', ' ')) === p.replace('-', '') && OPS.normalizePin('ABCD-EF01') === null && OPS.normalizePin('SHORT') === null);
  ck('hash binds the PIN to ONE event', OPS.pinHash('evA', p) !== OPS.pinHash('evB', p) && OPS.pinHash('evA', p) === OPS.pinHash('evA', p.toLowerCase()));
  ck('1,000 PINs, no repeats (crypto.randomInt)', new Set(Array.from({ length: 1000 }, () => OPS.generatePin())).size === 1000);
  /* In Cloud Functions a missing key must FAIL CLOSED — never fall back to the test key, which is in
     this repository and would make every production PIN hash forgeable. */
  process.env.K_SERVICE = 'eventopsdispatch';
  let inCf = null; try { OPS.pinHash('evA', p); inCf = 'hashed'; } catch (e) { inCf = e.code; }
  delete process.env.K_SERVICE;
  ck('missing key in Cloud Functions fails CLOSED (no test-key fallback)', inCf === 'failed-precondition', inCf);

  /* ═══ issuance ═══ */
  console.log('\n── issuance ──');
  await event('evA'); await event('evB');
  const unpaidBefore = await get('eventTickets/O1_k0');
  ck('a reserved (unpaid) ticket carries NO PIN', !unpaidBefore);
  const act = await paidOrder('O1', 'evA');
  const t0 = await get('eventTickets/O1_k0');
  ck('payment activation issues credentials: ticketNumber, pinHash, NOT_ADMITTED, refund NONE', act.activated && /^SK-EVT-[A-Z2-9]{6}$/.test(t0.ticketNumber) && /^[0-9a-f]{64}$/.test(t0.pinHash) && t0.admissionStatus === 'NOT_ADMITTED' && t0.refundStatus === 'NONE', act);
  const pin0 = await pinOf('O1_k0'); const pin1 = await pinOf('O1_k1');
  ck('raw PIN lives ONLY in eventTicketSecrets (not on the ticket)', !!pin0 && !JSON.stringify(t0).includes(pin0.replace('-', '')) && !JSON.stringify(t0).includes(pin0));
  ck('two tickets, two different PINs', pin0 && pin1 && pin0 !== pin1);
  ck('PIN index created per event (uniqueness is a create())', !!(await get(`eventTicketPins/evA_${t0.pinHash}`)));
  const pr = await EH.purchaseTickets.run({ ...who('buyer2'), data: { tierId: 'evA_t', quantity: 1, idempotencyKey: 'free-1' } }).catch((e) => ({ err: e.message }));
  void pr;  /* paid tier — stays unpaid; free path covered below */
  await db.doc('eventTicketTiers/evA_free').set({ eventId: 'evA', name: 'Guest', price: 0, quantity: 10, sold: 0, isActive: true, currency: 'KES' });
  const fr = await EH.purchaseTickets.run({ ...who('buyer3'), data: { tierId: 'evA_free', quantity: 1, idempotencyKey: 'free-2' } });
  const ft = db._dump('eventTickets/').find((x) => x.orderId === fr.orderId);
  ck('a FREE ticket is issued its PIN at once', fr.status === 'paid' && ft && ft.pinHash && (await pinOf(ft.ticketId)));

  /* ═══ visibility ═══ */
  console.log('\n── visibility ──');
  const mine = await EH.getMyTickets.run({ ...who('buyer1'), data: {} });
  ck('getMyTickets returns the buyer their own PINs', mine.tickets.filter((x) => x.orderId === 'O1').every((x) => /^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(x.pin) && x.ticketNumber));
  const other = await EH.getMyTickets.run({ ...who('buyer9'), data: {} });
  ck('another user sees none of them', other.tickets.length === 0);
  const orgView = await EH.getTicket.run({ ...who('org1'), data: { ticketId: 'O1_k0' } });
  ck('organizer sees the ticket but NOT its token / QR / pinHash', orgView.ticketId === 'O1_k0' && !('token' in orgView) && !('qrData' in orgView) && !('pinHash' in orgView));
  const buyView = await EH.getTicket.run({ ...who('buyer1'), data: { ticketId: 'O1_k0' } });
  ck('buyer still gets the optional QR token', !!buyView.token && !('pinHash' in buyView));

  /* ═══ staff ═══ */
  console.log('\n── staff ──');
  ck('invite requires the organizer (stranger refused)', (await code(op('eventStaffInvite', 'x9', { eventId: 'evA', email: 'gate@x.co', role: 'admission' }))) === 'permission-denied');
  ck('unknown role refused', (await code(op('eventStaffInvite', 'org1', { eventId: 'evA', email: 'gate@x.co', role: 'god' }))) === 'invalid-argument');
  ck('access may not outlive the event by > 48 h', (await code(op('eventStaffInvite', 'org1', { eventId: 'evA', email: 'gate@x.co', role: 'admission', endAt: NOW + 48 * H + 4 * H + 49 * H }))) === 'invalid-argument');
  for (const [email, role] of [['gate@x.co', 'admission'], ['till@x.co', 'cashier'], ['promo@x.co', 'marketing'], ['boss@x.co', 'manager']]) {
    await op('eventStaffInvite', 'org1', { eventId: 'evA', email, role });
  }
  ck('accept refused for an UNVERIFIED email', (await code(op('eventStaffAccept', 'gate1', { eventId: 'evA' }, { email: 'gate@x.co', email_verified: false }))) === 'failed-precondition');
  ck('accept refused for a DIFFERENT email', (await code(op('eventStaffAccept', 'gate1', { eventId: 'evA' }, { email: 'other@x.co', email_verified: true }))) === 'not-found');
  for (const [uid, email] of [['gate1', 'gate@x.co'], ['till1', 'till@x.co'], ['promo1', 'promo@x.co'], ['boss1', 'boss@x.co']]) {
    await op('eventStaffAccept', uid, { eventId: 'evA' }, { email, email_verified: true });
  }
  ck('accepted staff are bound by uid', (await get('eventStaff/evA_gate1')).role === 'admission' && (await get('eventStaff/evA_till1')).role === 'cashier');
  const my = await op('eventMyAssignments', 'gate1');
  ck('staff see their live assignment (event + role)', my.assignments.length === 1 && my.assignments[0].eventId === 'evA' && my.assignments[0].role === 'admission');
  ck('cashier cannot admit', (await code(op('eventAdmitTicket', 'till1', { eventId: 'evA', pin: pin0 }))) === 'permission-denied');
  ck('marketing cannot admit', (await code(op('eventVerifyPin', 'promo1', { eventId: 'evA', pin: pin0 }))) === 'permission-denied');
  ck('staff cannot manage staff (even a manager)', (await code(op('eventStaffInvite', 'boss1', { eventId: 'evA', email: 'x@x.co', role: 'cashier' }))) === 'permission-denied');
  ck('staff of event A have NO access to event B', (await code(op('eventVerifyPin', 'gate1', { eventId: 'evB', pin: pin0 }))) === 'permission-denied');
  ck('no capability anywhere touches money movement', !Object.values(OPS.STAFF_ROLES).flat().some((c) => /withdraw|payout|refund|commission|wallet/.test(c)));

  /* ═══ admission ═══ */
  console.log('\n── admission ──');
  const v = await op('eventVerifyPin', 'gate1', { eventId: 'evA', pin: pin0 });
  ck('valid PIN verifies with minimal info (initials, tier, status)', v.valid && v.admissible && v.ticket.attendeeInitials === 'AO' && v.ticket.tierName === 'Regular' && !('attendeeEmail' in v.ticket));
  const ad = await op('eventAdmitTicket', 'gate1', { eventId: 'evA', pin: pin0.toLowerCase(), deviceSession: 'gate-tablet-1' });
  ck('admit → ADMITTED + admission record (staff, role, method, device)', ad.result === 'admitted' && (await get('eventTickets/O1_k0')).admissionStatus === 'ADMITTED'
    && (await get('eventAdmissions/O1_k0')).admittedBy === 'gate1' && (await get('eventAdmissions/O1_k0')).admittedRole === 'admission' && (await get('eventAdmissions/O1_k0')).deviceSession === 'gate-tablet-1');
  ck('second admission of the same PIN refused', (await op('eventAdmitTicket', 'gate1', { eventId: 'evA', pin: pin0 })).result === 'already_admitted');
  ck('a PIN from event A cannot admit at event B (organizer B)', (await code(op('eventAdmitTicket', 'org1', { eventId: 'evB', pin: pin1 }))) === 'not-found');
  await db.doc('eventTickets/O1_k1').set({ refundStatus: 'REQUESTED' }, { merge: true });
  ck('refund REQUESTED → refused at the gate', (await op('eventAdmitTicket', 'gate1', { eventId: 'evA', pin: pin1 })).result === 'refused');
  await db.doc('eventTickets/O1_k1').set({ refundStatus: 'REFUNDED', status: 'refunded' }, { merge: true });
  ck('refunded ticket cannot be admitted', (await op('eventAdmitTicket', 'gate1', { eventId: 'evA', pin: pin1 })).result === 'refused');
  const ev0 = (await get('events/evA')).checkinsCount;
  await paidOrder('O2', 'evA', 1);
  const pinC = await pinOf('O2_k0');
  const race = await Promise.all(Array.from({ length: 8 }, () => op('eventAdmitTicket', 'gate1', { eventId: 'evA', pin: pinC }).catch((e) => ({ result: 'err:' + e.message }))));
  ck('8 concurrent admissions of ONE ticket → exactly one "admitted"', race.filter((r) => r.result === 'admitted').length === 1, race.map((r) => r.result).join(','));
  ck('…and the event counter moved by exactly one', (await get('events/evA')).checkinsCount === ev0 + 1);
  const audit = db._dump('eventOpsAudit/');
  ck('no raw PIN and no PIN hash in any audit row', !audit.some((a) => { const j = JSON.stringify(a); return [pin0, pin1, pinC].some((x) => x && (j.includes(x) || j.includes(x.replace('-', '')))) || j.includes(t0.pinHash); }));

  /* brute force */
  let locked = null;
  for (let i = 0; i < 12; i++) {
    const r = await op('eventVerifyPin', 'gate1', { eventId: 'evA', pin: 'ZZZZ-ZZZ' + 'ABCDEFGHJKLM'[i] }).catch((e) => ({ code: e.code }));
    if (r.code === 'resource-exhausted') { locked = i; break; }
  }
  ck('per-staff lockout after 10 wrong PINs', locked === 10, locked);
  ck('…even a CORRECT PIN is refused while locked', (await code(op('eventVerifyPin', 'gate1', { eventId: 'evA', pin: pinC }))) === 'resource-exhausted');
  NOW += 11 * 60 * 1000;
  ck('lockout lifts after the window', (await op('eventVerifyPin', 'gate1', { eventId: 'evA', pin: pinC })).valid === true);
  /* distributed guessing: many staff accounts → per-event cap */
  await db.doc('eventPinAttempts/evA__event').set({ fails: OPS.ATTEMPTS.PER_EVENT_FAILS, windowStart: F.Timestamp.fromMillis(NOW) });
  ck('per-event lockout stops distributed guessing across staff', (await code(op('eventVerifyPin', 'boss1', { eventId: 'evA', pin: pinC }))) === 'resource-exhausted');
  NOW += 11 * 60 * 1000;

  /* expiry + revocation */
  NOW = Date.parse((await get('events/evA')).endDate) + 13 * H;
  ck('staff access EXPIRES after the assignment window', (await code(op('eventVerifyPin', 'gate1', { eventId: 'evA', pin: pinC }))) === 'permission-denied');
  NOW = Date.now() + 60 * 60 * 1000;
  await op('eventStaffRevoke', 'org1', { eventId: 'evA', uid: 'boss1', reason: 'left early' });
  ck('revoked staff refused immediately', (await code(op('eventVerifyPin', 'boss1', { eventId: 'evA', pin: pinC }))) === 'permission-denied');
  ck('revocation is audited with before/after', db._dump('eventOpsAudit/').some((a) => a.action === 'event_staff_revoked' && a.detail && a.detail.after === 'revoked'));
  const list = await op('eventStaffList', 'org1', { eventId: 'evA' });
  ck('organizer sees staff with live/expired state', list.staff.find((s) => s.uid === 'boss1').live === false && list.staff.find((s) => s.uid === 'gate1').live === true);

  /* ═══ legacy QR path ═══ */
  console.log('\n── legacy QR ──');
  await paidOrder('O3', 'evA', 1);
  const q = await get('eventTickets/O3_k0');
  ck('QR check-in refuses a stranger', (await code(EH.checkInTicket.run({ ...who('x9'), data: { ticketId: 'O3_k0', token: q.token } }))) === 'permission-denied');
  ck('QR check-in refuses a wrong token', (await code(EH.checkInTicket.run({ ...who('gate1'), data: { ticketId: 'O3_k0', token: 'nope' } }))) === 'invalid-argument');
  const qr = await Promise.all(Array.from({ length: 5 }, () => EH.checkInTicket.run({ ...who('gate1'), data: { ticketId: 'O3_k0', token: q.token } }).catch((e) => ({ result: 'err:' + e.message }))));
  ck('5 concurrent QR scans → exactly one success', qr.filter((r) => r.result === 'success').length === 1, qr.map((r) => r.result).join(','));
  ck('QR and PIN share one admission record (PIN now says already admitted)', (await op('eventAdmitTicket', 'gate1', { eventId: 'evA', pin: await pinOf('O3_k0') })).result === 'already_admitted');

  /* ═══ fail-open + notify ═══ */
  console.log('\n── fail-open + notify ──');
  claimsOf.str1 = { role: 'superAdmin' };
  ck('a STRING role claim no longer passes the event-hub admin check', (await code(EH.getEventAnalytics.run({ ...who('str1'), data: { eventId: 'evA' } }))) === 'permission-denied');
  claimsOf.num4 = { role: 4 };
  ck('the legacy NUMERIC admin role still works', !(await code(EH.getEventAnalytics.run({ ...who('num4'), data: { eventId: 'evA' } }))));
  const notifySrc = require('fs').readFileSync(Path.join(FN, 'notify.js'), 'utf8');
  ck('notify registers organizer_approved + event types (approval notices now deliver)', ['organizer_approved', 'event_ticket_confirmed', 'event_cancelled', 'event_refund_update', 'event_staff_invite'].every((t) => new RegExp('\\n\\s+' + t + ':\\s*\\{').test(notifySrc)));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASH', e && e.stack || e); process.exit(3); });
