/* test-event-notifications.js — the Events notices and the large-event cancellation path.
 * Transactional fake Firestore with Firestore's 500-writes-per-batch limit enforced; notify() captured.
 *
 * PROVES
 *   Confirmed   a paid online order → ONE event_ticket_confirmed to its buyer, after the first
 *               activation only (a replayed activation sends nothing) · the notice carries NO PIN
 *               (checked against every PIN issued) · a cashier-assisted (walk-in) order → no notice ·
 *               a free order → confirmed at issue
 *   Cancelled   an event with 450 paid orders (a single batch would need 451 writes) cancels:
 *               every order pending_refund · one event_cancelled per ONLINE buyer, none for cashier
 *               orders · a second cancel is refused · two concurrent cancels → exactly one succeeds
 *               COUNTERPROOF: the fake really refuses a 501-write batch
 *   Staff       invite to an email with an account → event_staff_invite to that uid; to an email
 *               with no account → no notice and the SAME response shape (no account probing)
 *
 *   node scripts/test-event-notifications.js
 */
'use strict';
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:1';
process.env.GCLOUD_PROJECT = 'demo-event-notify';
process.env.INTASEND_PRIVATE_KEY = 'harness';
delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
delete process.env.K_SERVICE; delete process.env.FUNCTION_TARGET;

const Path = require('path');
const FN = Path.resolve(__dirname, '..', 'functions');
const { makeFakeFirestore } = require('./lib/fake-firestore-txn');
const F = makeFakeFirestore({ clock: () => Date.now(), strictReadOrder: true });
const db = F.db;
/* Firestore refuses a batch of more than 500 writes; the fake did not. */
const _batch = db.batch.bind(db);
db.batch = () => {
  const b = _batch(); let n = 0;
  const wrap = (fn) => (...a) => { n++; return fn(...a); };
  return { set: wrap(b.set), update: wrap(b.update), create: wrap(b.create), delete: wrap(b.delete),
    commit: async () => { if (n > 500) { const e = new Error('INVALID_ARGUMENT: maximum 500 writes allowed per request'); e.code = 3; throw e; } return b.commit(); } };
};
const ACCOUNTS = { 'known@x.co': 'known1' };
const authApi = {
  getUser: async (u) => ({ uid: u, customClaims: {} }),
  getUserByEmail: async (e) => { if (!ACCOUNTS[e]) { const x = new Error('no user'); x.code = 'auth/user-not-found'; throw x; } return { uid: ACCOUNTS[e] }; },
};
const say = console.log; console.log = console.info = console.warn = console.error = console.debug = () => {};
const resolveIn = (m) => require.resolve(m, { paths: [FN] });
const stub = (m, exp) => { const p = m.startsWith('./') ? Path.join(FN, m + '.js') : resolveIn(m); require.cache[p] = { id: p, filename: p, loaded: true, exports: exp }; };
stub('firebase-admin/firestore', { getFirestore: () => db, FieldValue: F.FieldValue, Timestamp: F.Timestamp, FieldPath: F.FieldPath });
stub('firebase-admin/auth', { getAuth: () => authApi });
stub('firebase-admin', { apps: [{}], initializeApp: () => ({}), firestore: Object.assign(() => db, { FieldValue: F.FieldValue, Timestamp: F.Timestamp }), auth: () => authApi });
const SENT = [];
stub('./notify', { notify: async (n) => { SENT.push(n); return { ok: true }; } });

const OPS = require(Path.join(FN, 'event-ops.js'));
const ES = require(Path.join(FN, 'event-settlement.js'));
const EH = require(Path.join(FN, 'event-hub.js'));
ES.registerPurpose();

let pass = 0, fail = 0;
const ck = (l, ok, d) => { say('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined && d !== '' ? '   [' + String(typeof d === 'object' ? JSON.stringify(d) : d).slice(0, 160) + ']' : '')); ok ? pass++ : fail++; };
const who = (uid, token = {}) => ({ auth: { uid, token: { email: uid + '@x.co', email_verified: true, ...token } }, rawRequest: { headers: {} } });
async function code(p) { try { await p; return null; } catch (e) { return e.code || e.message; } }
const get = async (p) => { const s = await db.doc(p).get(); return s.exists ? s.data() : null; };
const H = 3600e3;

async function paidOrder(oid, { buyer = 'buyer1', channel } = {}) {
  const NOW = Date.now();
  await db.doc(`eventOrders/${oid}`).set({ orderId: oid, buyerUid: buyer, eventId: 'evA', tierId: 'REG', tierName: 'Regular', quantity: 2, totalAmount: 4000, currency: 'KES', status: 'pending_payment', ...(channel ? { channel } : {}), createdAt: F.Timestamp.fromMillis(NOW) });
  for (let i = 0; i < 2; i++) await db.doc(`eventTickets/${oid}_k${i}`).set({ ticketId: `${oid}_k${i}`, orderId: oid, eventId: 'evA', buyerUid: buyer, tierName: 'Regular', status: 'awaiting_payment', createdAt: F.Timestamp.fromMillis(NOW) });
  await db.doc(`paymentIntents/${oid}`).set({ ref: oid, purpose: 'event_ticket', resourceType: 'eventOrder', resourceId: oid, uid: buyer, ownerUid: buyer, amount: 4000, amountCents: 400000, currency: 'KES', metadata: { eventId: 'evA', organizerUid: 'org1' } });
  await db.doc(`payments/${oid}`).set({ ref: oid, uid: buyer, amount: 4000, amountCents: 400000, currency: 'KES', status: 'COMPLETE', provider: 'intasend', providerReport: { charges: 60 } });
  return ES.activateIfEventTicket(oid);
}

(async () => {
  const NOW = Date.now();
  await db.doc('events/evA').set({ eventId: 'evA', title: 'Nairobi Jazz Night', organizerUid: 'org1', status: 'live', startDate: new Date(NOW + 48 * H).toISOString(), endDate: new Date(NOW + 52 * H).toISOString(), totalTicketsSold: 0, refundPolicy: { mode: 'none' } });
  await db.doc('eventTicketTiers/REG').set({ tierId: 'REG', eventId: 'evA', name: 'Regular', price: 2000, quantity: 5000, sold: 0, isActive: true, currency: 'KES' });
  await db.doc('eventTicketTiers/FREE').set({ tierId: 'FREE', eventId: 'evA', name: 'Community', price: 0, quantity: 50, sold: 0, isActive: true, currency: 'KES' });

  say('\n── counterproof ──');
  const big = db.batch(); for (let i = 0; i < 501; i++) big.set(db.doc(`scratch/x${i}`), { i });
  ck('the fake refuses a 501-write batch (the limit the fix must respect)', (await code(big.commit())) === 3);

  say('\n── ticket confirmed ──');
  const a1 = await paidOrder('ORDONL1');
  const conf = SENT.filter((n) => n.type === 'event_ticket_confirmed');
  ck('activation → exactly one confirmation to the buyer', a1.activated && conf.length === 1 && conf[0].uid === 'buyer1', a1);
  const pins = db._dump('eventTicketSecrets/').map((s) => s.pin);
  const text = JSON.stringify(conf);
  ck('the notice carries no PIN (every issued PIN checked)', pins.length === 2 && pins.every((p) => !text.includes(p) && !text.includes(p.replace('-', ''))));
  ck('the notice names the event and points to My Tickets', /Nairobi Jazz Night/.test(conf[0].body) && /My Tickets/.test(conf[0].body) && conf[0].dedupeKey === 'evt_confirmed:ORDONL1');
  const again = await ES.activateIfEventTicket('ORDONL1');
  ck('replayed activation → no second notice', again.alreadyActive === true && SENT.filter((n) => n.type === 'event_ticket_confirmed').length === 1, again);
  await paidOrder('ORDCSH1', { buyer: 'till1', channel: 'cashier' });
  ck('cashier-assisted (walk-in) order → no notice to the cashier', !SENT.some((n) => n.type === 'event_ticket_confirmed' && n.data.orderId === 'ORDCSH1'));
  const free = await EH.purchaseTickets.run({ ...who('buyer9'), data: { tierId: 'FREE', quantity: 1, idempotencyKey: 'free-key-000001', attendeeName: 'Otieno' } });
  ck('free order → confirmed at issue', free.status === 'paid' && SENT.some((n) => n.type === 'event_ticket_confirmed' && n.uid === 'buyer9' && /1 ticket for/.test(n.body)), free);

  say('\n── cancellation at scale ──');
  /* 450 paid orders (+ the 2 above): one batch would be 453 writes today, and the old code grew
     one write per order with no ceiling. Seeded directly as paid. */
  for (let i = 0; i < 450; i++) {
    await db.doc(`eventOrders/BULK${String(i).padStart(4, '0')}`).set({ orderId: `BULK${String(i).padStart(4, '0')}`, buyerUid: `b${i}`, eventId: 'evA', quantity: 1, totalAmount: 2000, status: 'paid', ...(i % 10 === 0 ? { channel: 'cashier' } : {}) });
  }
  for (let i = 450; i < 520; i++) {
    await db.doc(`eventOrders/BULK${String(i).padStart(4, '0')}`).set({ orderId: `BULK${String(i).padStart(4, '0')}`, buyerUid: `b${i}`, eventId: 'evA', quantity: 1, totalAmount: 2000, status: 'paid' });
  }
  const paidBefore = db._dump('eventOrders/').filter((o) => o.eventId === 'evA' && o.status === 'paid');
  SENT.length = 0;
  const race = await Promise.all([1, 2].map(() => EH.cancelEvent.run({ ...who('org1'), data: { eventId: 'evA', reason: 'Venue flooded — cannot proceed' } }).then((r) => ({ ok: r }), (e) => ({ err: e.code }))));
  const okOnes = race.filter((r) => r.ok);
  ck('two concurrent cancels → exactly one succeeds', okOnes.length === 1 && race.some((r) => r.err === 'failed-precondition'), race.map((r) => r.err || 'ok'));
  ck(`a ${paidBefore.length}-order event cancels (more than one batch can hold)`, paidBefore.length > 500 && okOnes[0] && okOnes[0].ok.ordersMarkedForRefund === paidBefore.length, [paidBefore.length, okOnes[0] && okOnes[0].ok]);
  const after = db._dump('eventOrders/').filter((o) => o.eventId === 'evA');
  ck('every paid order is now pending_refund', paidBefore.every((p) => after.find((o) => o.orderId === p.orderId).status === 'pending_refund'));
  ck('event is cancelled with its reason', (await get('events/evA')).status === 'cancelled' && /Venue flooded/.test((await get('events/evA')).cancellationReason));
  const cn = SENT.filter((n) => n.type === 'event_cancelled');
  const online = paidBefore.filter((o) => o.channel !== 'cashier');
  ck('one event_cancelled per ONLINE buyer', cn.length === online.length && new Set(cn.map((n) => n.dedupeKey)).size === online.length, [cn.length, online.length]);
  ck('no notice to cashier-sold orders', !cn.some((n) => paidBefore.find((o) => o.orderId === n.data.orderId).channel === 'cashier'));
  ck('the notice says refund, carries no PIN', /cancelled/.test(cn[0].body) && /refund/.test(cn[0].body) && pins.every((p) => !JSON.stringify(cn).includes(p)));
  ck('cancelling again is refused', (await code(EH.cancelEvent.run({ ...who('org1'), data: { eventId: 'evA', reason: 'again' } }))) === 'failed-precondition');

  say('\n── staff invitation ──');
  await db.doc('events/evS').set({ eventId: 'evS', title: 'Staff Night', organizerUid: 'org1', status: 'live', startDate: new Date(NOW + 48 * H).toISOString(), endDate: new Date(NOW + 52 * H).toISOString() });
  SENT.length = 0;
  const r1 = await OPS._h.eventStaffInvite({ ...who('org1'), data: { eventId: 'evS', email: 'known@x.co', role: 'cashier' } });
  const r2 = await OPS._h.eventStaffInvite({ ...who('org1'), data: { eventId: 'evS', email: 'nobody@x.co', role: 'cashier' } });
  const inv = SENT.filter((n) => n.type === 'event_staff_invite');
  ck('existing account → in-app invitation to that uid', inv.length === 1 && inv[0].uid === 'known1' && /Staff Night/.test(inv[0].body) && /cashier/.test(inv[0].body));
  ck('no account → no notice, and the response has the same shape (no probing)', JSON.stringify(Object.keys(r1).sort()) === JSON.stringify(Object.keys(r2).sort()) && r1.ok && r2.ok);

  say(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { say('CRASH ' + (e && e.stack || e)); process.exit(2); });
