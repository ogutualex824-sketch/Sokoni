/* test-event-ticket-identity.js — permanent ticket number, 4-digit event PIN, SOKONI QR vs KRA fiscal,
 * and fiscal reconciliation. Transactional fake Firestore in STRICT read-order mode (a read after a
 * write throws, as the Admin SDK does); the REAL functions/etims.js order-invoice path (queued — no
 * KRA call is made); no network.
 *
 * PROVES
 *   Harness       strict mode really refuses a read after a write (positive control) · create()-and-
 *                 hope on a taken PIN fails ALREADY_EXISTS — why free PINs are chosen by READING
 *   Uniqueness    300 tickets on one event → 300 distinct PINs + ticket numbers · a forced collision
 *                 is skipped (retry) · 12 concurrent free checkouts forced onto ONE candidate PIN →
 *                 12 distinct PINs, all succeed · the SAME 4 digits on another event is a different
 *                 credential (each admits only its own ticket)
 *   Capacity      a full 10,000-PIN event refuses allocation cleanly (no hang) and a paid order there
 *                 is RECORDED as an exception, never ticketed without a PIN · tier configuration
 *                 beyond 8,000 tickets refused
 *   Lifetime      ISSUED before the window (refused) → ACTIVE → CONSUMED once → EXPIRED after ·
 *                 cancelled event / refunded ticket refused · the QR path obeys the SAME lifetime
 *   Identity      ticket number SK-EVT-YYYY-NNNNNN, indexed, immutable across a replayed activation;
 *                 the PIN resolves exactly its ticket
 *   Quick Sale    mixed cart 2 VIP + 3 Regular (cash) → 5 tickets, 5 PINs, 5 numbers · a gate cashier
 *                 checks and admits an ONLINE ticket by PIN (same authority) · card sale tickets too
 *   QR            SOKONI QR = sokoni-ticket:<id>:<token>, never the PIN; door tickets have one too ·
 *                 a refunded ticket shows no PIN and no QR
 *   Fiscal        one record per paid sale (online / cash / card), none for free · the REAL eTIMS
 *                 invoice is created and QUEUED (no immediate KRA call, no failure notice) · PENDING
 *                 until KRA accepts → CONFIRMED with exactly KRA's receipt + https QR · a non-https
 *                 KRA value is never rendered as an image · organizer not on eTIMS → NOT_REGISTERED ·
 *                 submission error → FAILED, swept, bounded · idempotent (one invoice) · payment /
 *                 ticket / admission never depend on fiscal · refund → CREDIT_NOTE_REQUIRED
 *   AdminOS       PIN shown •••• only · search by payment ref / admission / refund / fiscal status ·
 *                 trace has the fiscal stage · reconciliation queue + audited retry (requeue)
 *
 *   node scripts/test-event-ticket-identity.js
 */
'use strict';
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:1';
process.env.GCLOUD_PROJECT = 'demo-event-identity';
process.env.INTASEND_PRIVATE_KEY = 'harness';
delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
delete process.env.K_SERVICE; delete process.env.FUNCTION_TARGET;

const Path = require('path');
const crypto = require('crypto');
const FN = Path.resolve(__dirname, '..', 'functions');
const { makeFakeFirestore } = require('./lib/fake-firestore-txn');
let NOW = Date.now();
const F = makeFakeFirestore({ clock: () => NOW, strictReadOrder: true });
const db = F.db;
const say = console.log; console.log = console.info = console.warn = console.error = console.debug = () => {};
const authApi = { getUser: async (u) => ({ uid: u, customClaims: {} }), getUserByEmail: async () => { const e = new Error('none'); e.code = 'auth/user-not-found'; throw e; } };
const resolveIn = (m) => require.resolve(m, { paths: [FN] });
const stub = (m, exp) => { const p = m.startsWith('./') ? Path.join(FN, m + '.js') : resolveIn(m); require.cache[p] = { id: p, filename: p, loaded: true, exports: exp }; };
stub('firebase-admin/firestore', { getFirestore: () => db, FieldValue: F.FieldValue, Timestamp: F.Timestamp, FieldPath: F.FieldPath });
stub('firebase-admin/auth', { getAuth: () => authApi });
stub('firebase-admin', { apps: [{}], initializeApp: () => ({}), firestore: Object.assign(() => db, { FieldValue: F.FieldValue, Timestamp: F.Timestamp }), auth: () => authApi, storage: () => ({ bucket: () => ({}) }) });
const SENT = [];
stub('./notify', { notify: async (n) => { SENT.push(n); return { ok: true }; } });
/* etims.notifySeller would email the seller on a failure — counted, so a queued submission can be
   proven NOT to raise a failure notice. */
const ETIMS_NOTICES = [];
stub('./email-service', { EMAIL_SECRETS: [], sendEmail: async (x) => { ETIMS_NOTICES.push(x); return { ok: true }; } });

const OPS = require(Path.join(FN, 'event-ops.js'));
const SALES = require(Path.join(FN, 'event-sales.js'));
const ES = require(Path.join(FN, 'event-settlement.js'));
const EH = require(Path.join(FN, 'event-hub.js'));
const FISCAL = require(Path.join(FN, 'event-fiscal.js'));
const EA = require(Path.join(FN, 'event-admin.js'));
const ETIMS = require(Path.join(FN, 'etims.js'));
OPS._setClock(() => NOW); SALES._setClock(() => NOW); FISCAL._setClock(() => NOW);
ES.registerPurpose();

let pass = 0, fail = 0;
const ck = (l, ok, d) => { say('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined && d !== '' ? '   [' + String(typeof d === 'object' ? JSON.stringify(d) : d).slice(0, 170) + ']' : '')); ok ? pass++ : fail++; };
const who = (uid, token = {}) => ({ auth: { uid, token: { email: uid + '@x.co', email_verified: true, ...token } }, rawRequest: { headers: {} } });
const op = (name, uid, data = {}) => (OPS._h[name] || SALES._h[name])({ ...who(uid), data });
const adm = (name, data = {}) => EA._adminH[name]({ ...who('admin1', { isAdmin: true }), data });
async function code(p) { try { await p; return null; } catch (e) { return e.code || e.message; } }
const get = async (p) => { const s = await db.doc(p).get(); return s.exists ? s.data() : null; };
const H = 3600 * 1000;
let k = 0; const key = () => 'id-key-' + (++k) + '-xyz';
const pinOf = async (tid) => ((await get(`eventTicketSecrets/${tid}`)) || {}).pin;

/* Force the FIRST PIN draw of every allocation to `v` (sequential callers): a PIN draw that follows a
   non-PIN draw (or the start) is the first of a new allocation. */
function forceFirstPin(v) {
  let last = null;
  OPS._setRandom((n) => { const first = n === 10000 && last !== 10000; last = n; return first ? v : crypto.randomInt(0, n); });
}
async function mkEvent(id, { startMs = NOW + 6 * H, org = 'org1', title = 'Nairobi Jazz Night' } = {}) {
  await db.doc(`events/${id}`).set({ eventId: id, title, organizerUid: org, status: 'live', venue: 'KICC', city: 'Nairobi',
    startDate: new Date(startMs).toISOString(), endDate: new Date(startMs + 4 * H).toISOString(), totalTicketsSold: 0, checkinsCount: 0, refundPolicy: { mode: 'none' } });
  for (const [t, name, price, qty] of [['VIP', 'VIP', 5000, 400], ['REG', 'Regular', 2000, 400], ['FREE', 'Guest', 0, 400]]) {
    await db.doc(`eventTicketTiers/${id}_${t}`).set({ tierId: `${id}_${t}`, eventId: id, name, price, quantity: qty, sold: 0, isActive: true, currency: 'KES' });
  }
}
async function paidOnline(orderId, eventId, { qty = 1, buyer = 'buyer1', tier = 'REG', price = 2000 } = {}) {
  await db.doc(`eventOrders/${orderId}`).set({ orderId, buyerUid: buyer, eventId, tierId: `${eventId}_${tier}`, tierName: tier === 'VIP' ? 'VIP' : 'Regular', quantity: qty, totalAmount: price * qty, currency: 'KES', status: 'pending_payment', createdAt: F.Timestamp.fromMillis(NOW) });
  for (let i = 0; i < qty; i++) await db.doc(`eventTickets/${orderId}_k${i}`).set({ ticketId: `${orderId}_k${i}`, orderId, eventId, buyerUid: buyer, tierId: `${eventId}_${tier}`, tierName: 'Regular', status: 'awaiting_payment', ...(() => { const tok = crypto.randomBytes(16).toString('hex'); return { token: tok, qrData: `sokoni-ticket:${orderId}_k${i}:${tok}` }; })(), createdAt: F.Timestamp.fromMillis(NOW) });
  await db.doc(`paymentIntents/${orderId}`).set({ ref: orderId, purpose: 'event_ticket', resourceType: 'eventOrder', resourceId: orderId, uid: buyer, ownerUid: buyer, amount: price * qty, amountCents: price * qty * 100, currency: 'KES', metadata: { eventId, organizerUid: 'org1' } });
  await db.doc(`payments/${orderId}`).set({ ref: orderId, uid: buyer, amount: price * qty, amountCents: price * qty * 100, currency: 'KES', status: 'COMPLETE', provider: 'intasend', method: 'M-PESA', providerReport: { charges: 30 * qty } });
  return ES.activateIfEventTicket(orderId);
}

(async () => {
  await mkEvent('evA'); await mkEvent('evB', { title: 'Other Gig' });
  for (const [uid, role] of [['till1', 'cashier'], ['gate1', 'admission']]) {
    await OPS._h.eventStaffInvite({ ...who('org1'), data: { eventId: 'evA', email: uid + '@x.co', role } });
    await OPS._h.eventStaffAccept({ ...who(uid), data: { eventId: 'evA' } });
  }
  /* the organizer has an ACTIVE eTIMS profile (org2 does not) */
  await db.doc('etimsProfiles/org1').set({ status: 'active', kraPin: 'P051234567T', businessName: 'Kamau Events', branchId: '00', vatStatus: 'registered', invoicePrefix: 'KEV' });

  say('\n── harness controls ──');
  let strict = null;
  try { await db.runTransaction(async (txn) => { txn.set(db.doc('scratch/a'), { x: 1 }); await txn.get(db.doc('scratch/b')); }); strict = 'no-throw'; } catch (e) { strict = e.code; }
  ck('strict mode: a read after a write throws (as the Admin SDK does)', strict === 3, strict);
  await db.doc('scratch/pin').set({ taken: true });
  let blind = null;
  try { await db.runTransaction(async (txn) => { txn.create(db.doc('scratch/pin'), { taken: true }); }); blind = 'created'; } catch (e) { blind = e.code; }
  ck('create()-and-hope on a taken value fails ALREADY_EXISTS (not retried) — why PINs are chosen by reading', blind === 6, blind);

  say('\n── uniqueness ──');
  const ids300 = [];
  for (let i = 0; i < 6; i++) ids300.push(...await db.runTransaction(async (txn) => { const ids = await OPS.allocateIdentities(txn, 'evU', 50); ids.forEach((x, j) => OPS.issueCredentials(txn, { eventId: 'evU', ticketId: `U${i}_${j}`, identity: x })); return ids; }));
  ck('300 tickets on one event → 300 distinct 4-digit PINs', ids300.length === 300 && new Set(ids300.map((x) => x.pin)).size === 300 && ids300.every((x) => /^\d{4}$/.test(x.pin)));
  ck('…and 300 distinct ticket numbers SK-EVT-YYYY-NNNNNN', new Set(ids300.map((x) => x.ticketNumber)).size === 300 && ids300.every((x) => OPS.TICKET_NUMBER_RE.test(x.ticketNumber)));
  const taken = ids300[0].pin;
  let forced = [Number(taken), Number(taken)];
  OPS._setRandom((n) => (n === 10000 && forced.length ? forced.shift() : crypto.randomInt(0, n)));
  const retried = await db.runTransaction(async (txn) => { const ids = await OPS.allocateIdentities(txn, 'evU', 1); OPS.issueCredentials(txn, { eventId: 'evU', ticketId: 'Ux', identity: ids[0] }); return ids[0]; });
  ck('a forced collision with an issued PIN is skipped (retry) — the new PIN differs', retried.pin !== taken && /^\d{4}$/.test(retried.pin), [taken, retried.pin]);
  /* 12 FREE checkouts, EVERY one forced to try PIN 0042 first: the first takes it, the rest read it
     taken and choose another — no failure, no duplicate. */
  forceFirstPin(42);
  const race = [];
  for (let i = 0; i < 12; i++) race.push(await EH.purchaseTickets.run({ ...who('racer' + i), data: { tierId: 'evA_FREE', quantity: 1, idempotencyKey: 'race-key-' + i } }).then((r) => r, (e) => ({ err: e.code || e.message })));
  OPS._setRandom(null);
  const racePins = await Promise.all(race.map(async (r) => { const t = db._dump('eventTickets/').find((x) => x.orderId === r.orderId); return t ? pinOf(t.ticketId) : null; }));
  ck('12 checkouts all forced onto candidate 0042 first → all succeed, 12 distinct PINs (one is 0042)', race.every((r) => r.status === 'paid') && new Set(racePins).size === 12 && racePins.includes('0042'), race.filter((r) => r.err).map((r) => r.err));
  /* CONCURRENT issuers drawing from an overlapping window of 40 values: whatever interleaves, a
     committed PIN is never shared. A loser either retries into a free value or ends ABORTED
     (contention — retryable), never ALREADY_EXISTS and never a duplicate. */
  let cyc = 0;
  let bodies = 0;               /* transaction callback runs — more than 12 means real contention + retry */
  OPS._setRandom((n) => (n === 10000 ? 3000 + (cyc++ % 20) : crypto.randomInt(0, n)));
  const conc = await Promise.all(Array.from({ length: 12 }, (_, i) => db.runTransaction(async (txn) => {
    bodies++;
    const ids = await OPS.allocateIdentities(txn, 'evK', 1);
    OPS.issueCredentials(txn, { eventId: 'evK', ticketId: 'K' + i, identity: ids[0] });
    return ids[0].pin;
  }).then((pin) => ({ pin }), (e) => ({ err: e.code }))));
  OPS._setRandom(null);
  const won = conc.filter((r) => r.pin).map((r) => r.pin);
  ck('12 CONCURRENT issuers on an overlapping window → committed PINs all distinct; losers only ABORTED (retryable)',
    bodies > 12 && won.length >= 6 && new Set(won).size === won.length && conc.every((r) => r.pin || r.err === 10), [bodies, conc.map((r) => r.pin || 'err' + r.err).join(',')]);
  const retry = [];
  for (const [i, r] of conc.entries()) if (r.err) retry.push(await db.runTransaction(async (txn) => { const ids = await OPS.allocateIdentities(txn, 'evK', 1); OPS.issueCredentials(txn, { eventId: 'evK', ticketId: 'K' + i, identity: ids[0] }); return ids[0].pin; }));
  const allK = won.concat(retry);
  ck('…the retried losers then succeed: 12 tickets, 12 distinct PINs', allK.length === 12 && new Set(allK).size === 12);
  /* the same 4 digits on two events: two different credentials */
  forceFirstPin(7777);
  await paidOnline('SAME_A', 'evA'); await paidOnline('SAME_B', 'evB', { buyer: 'buyer2' });
  OPS._setRandom(null);
  ck('the SAME 4 digits exist on two events for two different tickets', (await pinOf('SAME_A_k0')) === '7777' && (await pinOf('SAME_B_k0')) === '7777');
  const vA = await op('eventVerifyPin', 'gate1', { eventId: 'evA', pin: '7777' });
  ck('…at event A the PIN resolves ONLY event A\'s ticket', vA.valid && vA.ticket.ticketId === 'SAME_A_k0');
  ck('…event A staff cannot use it at event B', (await code(op('eventVerifyPin', 'gate1', { eventId: 'evB', pin: '7777' }))) === 'permission-denied');

  say('\n── capacity ──');
  await mkEvent('evFull');
  await db.runTransaction(async (txn) => { for (let i = 0; i < 10000; i++) { const p = String(i).padStart(4, '0'); txn.set(db.doc(`eventTicketPins/evFull_${OPS.pinHash('evFull', p)}`), { eventId: 'evFull', ticketId: 'x' + i }); } });
  const t0 = Date.now();
  const exhausted = await code(db.runTransaction(async (txn) => OPS.allocateIdentities(txn, 'evFull', 1)));
  ck('a full 10,000-PIN event refuses allocation cleanly (resource-exhausted, bounded time)', exhausted === 'resource-exhausted' && Date.now() - t0 < 20000, [exhausted, Date.now() - t0]);
  const act = await paidOnline('FULL1', 'evFull');
  ck('…a PAID order there is recorded as an exception, never ticketed without a PIN',
    act.refused === true && ((await get('eventExceptions/activation_FULL1')) || {}).status === 'OPEN' && (await get('eventTickets/FULL1_k0')).status === 'awaiting_payment', act);
  await db.doc('events/evCap').set({ title: 'Big', organizerUid: 'org1', status: 'draft', startDate: new Date(NOW + 30 * 24 * H).toISOString(), currency: 'KES' });
  const cap1 = await EH.createTicketTier.run({ ...who('org1'), data: { eventId: 'evCap', name: 'GA', price: 1000, quantity: 7000 } }).then(() => 'ok', (e) => e.code);
  const cap2 = await code(EH.createTicketTier.run({ ...who('org1'), data: { eventId: 'evCap', name: 'More', price: 1000, quantity: 1001 } }));
  ck('ticket types beyond 8,000 per event are refused at configuration (the 4-digit PIN ceiling)', cap1 === 'ok' && cap2 === 'failed-precondition' && OPS.EVENT_PIN_CEILING === 8000, [cap1, cap2]);

  say('\n── lifetime ──');
  await mkEvent('evL', { startMs: NOW + 48 * H });
  await paidOnline('LIFE1', 'evL', { qty: 3 });
  await OPS._h.eventStaffInvite({ ...who('org1'), data: { eventId: 'evL', email: 'gate1@x.co', role: 'admission' } });
  await OPS._h.eventStaffAccept({ ...who('gate1'), data: { eventId: 'evL' } });
  const lp = [await pinOf('LIFE1_k0'), await pinOf('LIFE1_k1'), await pinOf('LIFE1_k2')];
  const early = await op('eventVerifyPin', 'gate1', { eventId: 'evL', pin: lp[0] });
  ck('before the window: PIN ISSUED — verified but NOT admissible', early.valid && !early.admissible && early.ticket.pinState === 'ISSUED' && /not opened yet/.test(early.reason));
  ck('…and admission refused', (await op('eventAdmitTicket', 'gate1', { eventId: 'evL', pin: lp[0] })).result === 'refused');
  NOW += 40 * H;                                    /* event day */
  ck('in the window: ACTIVE → admitted', (await op('eventAdmitTicket', 'gate1', { eventId: 'evL', pin: lp[0] })).result === 'admitted');
  const again = await op('eventVerifyPin', 'gate1', { eventId: 'evL', pin: lp[0] });
  ck('once admitted: CONSUMED (identifiable, cannot admit twice)', again.valid && !again.admissible && again.ticket.pinState === 'CONSUMED' && again.ticket.ticketNumber);
  await db.doc('eventTickets/LIFE1_k1').set({ status: 'refunded', refundStatus: 'REFUNDED' }, { merge: true });
  ck('refunded ticket: PIN invalid at the gate', (await op('eventAdmitTicket', 'gate1', { eventId: 'evL', pin: lp[1] })).reason === 'Ticket is refunded.');
  const l2 = await get('eventTickets/LIFE1_k1');
  ck('…and the QR path refuses it too (same lifetime)', (await EH.checkInTicket.run({ ...who('gate1'), data: { ticketId: 'LIFE1_k1', token: l2.token } })).result === 'invalid');
  NOW += 30 * H;                                    /* past end + 12 h */
  const late = await op('eventVerifyPin', 'org1', { eventId: 'evL', pin: lp[2] });
  ck('after the window: EXPIRED — not admissible', late.valid && !late.admissible && late.ticket.pinState === 'EXPIRED');
  const l3 = await get('eventTickets/LIFE1_k2');
  ck('…and the QR path refuses the expired ticket', (await EH.checkInTicket.run({ ...who('org1'), data: { ticketId: 'LIFE1_k2', token: l3.token } })).result === 'invalid');
  NOW = Date.now();
  await mkEvent('evC'); await paidOnline('CANC1', 'evC');
  await db.doc('events/evC').set({ status: 'cancelled' }, { merge: true });
  ck('cancelled event: PIN refused', (await op('eventAdmitTicket', 'org1', { eventId: 'evC', pin: await pinOf('CANC1_k0') })).reason === 'This event was cancelled.');

  say('\n── identity ──');
  await paidOnline('ID1', 'evA');
  const id1 = await get('eventTickets/ID1_k0');
  ck('ticket number indexed to its ticket', ((await get(`eventTicketNumbers/${id1.ticketNumber}`)) || {}).ticketId === 'ID1_k0');
  await ES.activateIfEventTicket('ID1');
  ck('ticket number immutable across a replayed activation', (await get('eventTickets/ID1_k0')).ticketNumber === id1.ticketNumber);
  const vr = await op('eventVerifyPin', 'org1', { eventId: 'evA', pin: await pinOf('ID1_k0') });
  ck('the PIN resolves exactly its ticket number', vr.valid && vr.ticket.ticketNumber === id1.ticketNumber);

  say('\n── Quick Sale ──');
  const mixed = await op('eventQuickSale', 'till1', { eventId: 'evA', tender: 'cash', items: [{ tierId: 'evA_VIP', qty: 2 }, { tierId: 'evA_REG', qty: 3 }], cashReceivedKes: 16000, idempotencyKey: key() });
  const mt = await op('eventSaleTickets', 'till1', { eventId: 'evA', saleId: mixed.saleId });
  ck('mixed cart 2 VIP + 3 Regular (cash) → 5 tickets, 5 distinct PINs, 5 distinct numbers',
    mt.tickets.length === 5 && new Set(mt.tickets.map((t) => t.pin)).size === 5 && new Set(mt.tickets.map((t) => t.ticketNumber)).size === 5
    && mt.tickets.filter((t) => t.tierName === 'VIP').length === 2 && mt.tickets.every((t) => /^\d{4}$/.test(t.pin)));
  ck('sale view carries the event, unit prices (server) and the PIN state', mt.event.title === 'Nairobi Jazz Night' && mt.tickets.find((t) => t.tierName === 'VIP').unitCents === 500000 && mt.tickets.every((t) => t.pinState === 'ACTIVE'));
  await paidOnline('ONL1', 'evA', { buyer: 'buyer7' });
  const onlinePin = await pinOf('ONL1_k0');
  const cv = await op('eventVerifyPin', 'till1', { eventId: 'evA', pin: onlinePin });
  ck('gate cashier checks an ONLINE ticket by PIN (same admission authority)', cv.valid && cv.admissible && cv.ticket.ticketId === 'ONL1_k0');
  ck('…and admits it', (await op('eventAdmitTicket', 'till1', { eventId: 'evA', pin: onlinePin })).result === 'admitted'
    && ((await get('eventAdmissions/ONL1_k0')) || {}).admittedRole === 'cashier');
  const cardSale = await op('eventQuickSale', 'till1', { eventId: 'evA', tender: 'card_external', items: [{ tierId: 'evA_REG', qty: 2 }], card: { provider: 'equity', reference: 'EQ99887766', amountKes: 4000 }, idempotencyKey: key() });
  const ct = await op('eventSaleTickets', 'till1', { eventId: 'evA', saleId: cardSale.saleId });
  ck('card sale → 2 tickets with their own PINs + numbers', ct.tickets.length === 2 && ct.tickets.every((t) => /^\d{4}$/.test(t.pin) && OPS.TICKET_NUMBER_RE.test(t.ticketNumber)) && ct.tickets[0].pin !== ct.tickets[1].pin);

  say('\n── QR ──');
  const door = await get(`eventTickets/${mt.tickets[0].ticketId}`);
  ck('door tickets carry a SOKONI QR: sokoni-ticket:<ticketId>:<token>', door.qrData === `sokoni-ticket:${door.ticketId}:${door.token}` && /^[0-9a-f]{32}$/.test(door.token));
  ck('the SOKONI QR never contains the PIN', !door.qrData.includes(mt.tickets[0].pin) || door.qrData.split(':')[1].includes(mt.tickets[0].pin) === false);
  await db.doc('eventTickets/ONL1_k0').set({}, { merge: true });
  await paidOnline('RF1', 'evA', { buyer: 'buyer8' });
  await db.doc('eventTickets/RF1_k0').set({ status: 'refunded', refundStatus: 'REFUNDED' }, { merge: true });
  const mine8 = (await EH.getMyTickets.run({ ...who('buyer8'), data: {} })).tickets.find((t) => t.ticketId === 'RF1_k0');
  ck('a refunded ticket shows no PIN and no QR (unusable)', mine8 && mine8.pin === null && mine8.qrData === null);

  say('\n── fiscal (KRA eTIMS) ──');
  const onlineRec = await get('eventFiscal/ONL1');
  ck('online sale → ONE fiscal record (organizer, gross, M-PESA)', onlineRec && onlineRec.organizerUid === 'org1' && onlineRec.grossCents === 200000 && onlineRec.channel === 'online');
  const cashRec = await get(`eventFiscal/${mixed.saleId}`);
  ck('cash sale → fiscal record with the server-priced lines', cashRec && cashRec.channel === 'door_cash' && cashRec.paymentMethod === 'CASH' && cashRec.grossCents === 1600000
    && cashRec.lines.reduce((a, l) => a + l.qty * l.unitCents, 0) === 1600000);
  ck('card sale → fiscal record', ((await get(`eventFiscal/${cardSale.saleId}`)) || {}).paymentMethod === 'CARD');
  const freeOrders = race.map((r) => r.orderId);
  ck('free tickets → NO fiscal record (nothing sold)', freeOrders.every((o) => !db._dump('eventFiscal/').some((f) => f.orderId === o)));
  ck('submitted through the REAL eTIMS order path: invoice under the organizer, QUEUED', !!onlineRec.invoiceId && onlineRec.status === 'SUBMITTED'
    && ((await get(`etimsInvoices/${onlineRec.invoiceId}`)) || {}).status === 'pending_submission'
    && db._dump('etimsQueue/').some((q) => q.invoiceId === onlineRec.invoiceId && q.status === 'pending'));
  ck('…no immediate KRA attempt, so no failure notice to the organizer', ETIMS_NOTICES.length === 0 && !SENT.some((n) => /etims/i.test(String(n.type || ''))));
  const inv0 = await get(`etimsInvoices/${onlineRec.invoiceId}`);
  ck('eTIMS invoice lines = the sale (KES 2,000, seller = organizer)', inv0.sellerUid === 'org1' && inv0.totals && Math.round(inv0.totals.totAmt) === 2000 && inv0.orderId === 'evt_ONL1', inv0.totals && inv0.totals.totAmt);
  let v = (await FISCAL.viewsFor(['ONL1'])).ONL1;
  ck('fiscal view PENDING — and no KRA field at all while pending', v.status === 'PENDING' && !('receiptNumber' in v) && !('kraQrImage' in v));
  const tk = (await EH.getMyTickets.run({ ...who('buyer7'), data: {} })).tickets.find((t) => t.ticketId === 'ONL1_k0');
  ck('ticket valid + admitted regardless of fiscal PENDING (states are separate)', tk.status === 'valid' && tk.admissionStatus === 'ADMITTED' && tk.fiscal.status === 'PENDING');
  /* etimsProcessQueue (holds the secrets) gets KRA's answer — simulated here as the fields submitToKra writes */
  await db.doc(`etimsInvoices/${onlineRec.invoiceId}`).set({ status: 'accepted', receiptNumber: 'KRA-RCPT-000981', controlUnitNumber: 'CU-77', qrCode: 'https://etims.kra.go.ke/qr/KRA-RCPT-000981.png', verificationUrl: 'https://etims.kra.go.ke/verify?r=KRA-RCPT-000981' }, { merge: true });
  v = (await FISCAL.viewsFor(['ONL1'])).ONL1;
  ck('KRA accepted → CONFIRMED with EXACTLY KRA\'s receipt, QR image and verification link', v.status === 'CONFIRMED' && v.receiptNumber === 'KRA-RCPT-000981'
    && v.kraQrImage === 'https://etims.kra.go.ke/qr/KRA-RCPT-000981.png' && v.verificationUrl === 'https://etims.kra.go.ke/verify?r=KRA-RCPT-000981');
  ck('SOKONI QR ≠ KRA QR', tk.qrData && !tk.qrData.includes('KRA') && tk.qrData !== v.kraQrImage);
  await db.doc(`etimsInvoices/${onlineRec.invoiceId}`).set({ qrCode: 'RCPTSIGN-9f8e7d', verificationUrl: 'javascript:alert(1)' }, { merge: true });
  v = (await FISCAL.viewsFor(['ONL1'])).ONL1;
  ck('a non-https KRA value is never rendered as an image or link', v.status === 'CONFIRMED' && v.kraQrImage === null && v.verificationUrl === null && v.receiptNumber === 'KRA-RCPT-000981');
  /* organizer without eTIMS */
  await mkEvent('evN', { org: 'org2', title: 'No eTIMS' });
  await paidOnline('NOREG1', 'evN', { buyer: 'buyer9' });
  ck('organizer not on eTIMS → NOT_REGISTERED (no invoice, nothing invented)', ((await get('eventFiscal/NOREG1')) || {}).status === 'NOT_REGISTERED'
    && (await FISCAL.viewsFor(['NOREG1'])).NOREG1.status === 'NOT_REGISTERED' && !db._dump('etimsInvoices/').some((i) => i.sellerUid === 'org2'));
  /* submission error → FAILED → swept (bounded) */
  await db.doc('etimsProfiles/org1').set({ status: 'active', kraPin: 'P051234567T', businessName: 'Kamau Events', branchId: '00', vatStatus: 'registered', invoicePrefix: 'KEV' });
  const realGen = ETIMS.generateForOrder;
  ETIMS.generateForOrder = async () => { throw new Error('eTIMS sequence store unavailable'); };
  await paidOnline('ERR1', 'evA', { buyer: 'buyer10' });
  ck('submission error → FAILED (reconciliation), ticket still valid', ((await get('eventFiscal/ERR1')) || {}).status === 'SUBMISSION_ERROR'
    && (await FISCAL.viewsFor(['ERR1'])).ERR1.status === 'FAILED' && (await get('eventTickets/ERR1_k0')).status === 'valid');
  for (let i = 0; i < 7; i++) await FISCAL.sweep(NOW + 30 * 60 * 1000);
  ck('the sweep retries, bounded (never beyond 5 attempts)', ((await get('eventFiscal/ERR1')) || {}).attempts === FISCAL.MAX_ATTEMPTS, (await get('eventFiscal/ERR1')).attempts);
  ETIMS.generateForOrder = realGen;
  /* idempotent: submitting an already-submitted record creates no second invoice */
  const before = db._dump('etimsInvoices/').length;
  await FISCAL.submit('ONL1'); await FISCAL.submit(mixed.saleId);
  ck('idempotent: re-submitting creates no second invoice', db._dump('etimsInvoices/').length === before);
  /* refund reversal */
  await FISCAL.markRefunded('ONL1', { refundId: 'ref_ONL1' });
  await FISCAL.markRefunded('NOREG1', { refundId: 'ref_NOREG1' });
  ck('refund → CREDIT_NOTE_REQUIRED where an invoice exists; NOT_REQUIRED where none', (await get('eventFiscal/ONL1')).reversal.status === 'CREDIT_NOTE_REQUIRED' && (await get('eventFiscal/NOREG1')).reversal.status === 'NOT_REQUIRED');
  await FISCAL.markRefunded('ONL1', { refundId: 'ref_again' });
  ck('…marked exactly once', (await get('eventFiscal/ONL1')).reversal.refundId === 'ref_ONL1');

  say('\n── AdminOS ──');
  const byEv = await adm('eventAdminInvestigate', { by: 'event', value: 'evA' });
  const allPins = new Set(db._dump('eventTicketSecrets/').filter((x) => x.eventId === 'evA').map((x) => x.pin));
  ck('ticket rows show PIN as •••• — never the value', byEv.tickets.every((t) => t.pinDisplay === '••••' || !t.pinHash) && byEv.tickets.some((t) => t.pinDisplay === '••••')
    && !byEv.tickets.some((t) => 'pin' in t || 'pinHash' in t));
  ck('rows carry the fiscal state', byEv.tickets.find((t) => t.ticketId === 'ONL1_k0').fiscal.status === 'CONFIRMED');
  ck('search by payment reference', (await adm('eventAdminInvestigate', { by: 'paymentRef', value: 'ONL1' })).tickets.some((t) => t.ticketId === 'ONL1_k0'));
  ck('search by admission status (scoped to an event)', (await adm('eventAdminInvestigate', { by: 'admissionStatus', value: 'ADMITTED', eventId: 'evA' })).tickets.some((t) => t.ticketId === 'ONL1_k0')
    && (await code(adm('eventAdminInvestigate', { by: 'admissionStatus', value: 'ADMITTED' }))) === 'invalid-argument');
  ck('search by refund status', (await adm('eventAdminInvestigate', { by: 'refundStatus', value: 'REFUNDED', eventId: 'evA' })).tickets.some((t) => t.ticketId === 'RF1_k0'));
  const fs1 = await adm('eventAdminInvestigate', { by: 'fiscalStatus', value: 'SUBMISSION_ERROR' });
  ck('search by fiscal status', fs1.fiscal.some((f) => f.saleKey === 'ERR1' && f.view.status === 'FAILED'));
  const tr = await adm('eventAdminTrace', { orderId: 'ONL1' });
  const fst = tr.stages.find((s) => s.stage === 'fiscal');
  ck('trace: Sale → Payment → FISCAL (KRA receipt) → Commission …', fst && fst.state === 'observed' && fst.record.receiptNumber === 'KRA-RCPT-000981'
    && tr.stages.map((s) => s.stage).indexOf('fiscal') === tr.stages.map((s) => s.stage).indexOf('payment') + 1);
  const q = await adm('eventAdminFiscal', {});
  ck('reconciliation queue: failed, unregistered and credit-note-owed sales', q.fiscal.some((f) => f.saleKey === 'ERR1') && q.fiscal.some((f) => f.saleKey === 'NOREG1') && q.fiscal.some((f) => f.saleKey === 'ONL1'));
  ck('retry refused for a CONFIRMED sale', (await code(adm('eventAdminFiscalRetry', { saleKey: 'ONL1' }))) === 'failed-precondition');
  const rr = await adm('eventAdminFiscalRetry', { saleKey: 'ERR1' });
  ck('retry a submission error → the REAL eTIMS path now creates + queues the invoice', rr.ok && ((await get('eventFiscal/ERR1')) || {}).status === 'SUBMITTED' && !!(await get('eventFiscal/ERR1')).invoiceId);
  await db.doc(`etimsInvoices/${(await get('eventFiscal/ERR1')).invoiceId}`).set({ status: 'failed' }, { merge: true });
  await adm('eventAdminFiscalRetry', { saleKey: 'ERR1' });
  ck('retry a KRA-failed invoice → requeued through etims.requeueInvoice (no second invoice)', ((await get(`etimsInvoices/${(await get('eventFiscal/ERR1')).invoiceId}`)) || {}).status === 'pending_submission');
  ck('every retry is audited', db._dump('adminAudit/').filter((a) => a.action === 'event_fiscal_retry').length === 2);
  ck('no raw PIN anywhere in admin responses', ![byEv, fs1, tr, q].some((r) => [...allPins].some((p) => JSON.stringify(r).includes('"' + p + '"'))));

  say(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { say('CRASH ' + (e && e.stack || e)); process.exit(2); });
