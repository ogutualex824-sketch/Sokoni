/* test-event-admin.js — AdminOS › Events investigation, financial trace and staff oversight
 * (functions/event-admin.js, merged into adminOsDispatch). Transactional fake Firestore; no network.
 *
 * PROVES
 *   Guard        every eventAdmin* op refuses a signed-out caller, a buyer, the organizer and a
 *                cashier; all seven are registered on adminOsDispatch and whitelisted by the panel
 *   Search       by event · sale · cashier · ticket · ticket number · card reference · buyer · order
 *   Credentials  no response carries pin / pinHash / token / qrData; PINs never appear anywhere in
 *                a response body; phones and emails are masked
 *   PIN identity an admin finds a ticket by (event, PIN) through the event-bound HMAC index; the
 *                same PIN on another event finds nothing; malformed PINs refused; every lookup
 *                (hit AND miss) audited WITHOUT the PIN
 *   Trace        cash sale: payment n/a, commission + receivable + organizer proceeds observed ·
 *                online order: payment → commission → settlement → refund → payout all observed,
 *                amounts copied from their records, never computed · unreleased order: payout n/a ·
 *                missing payment record reported as `empty`, not invented
 *   Staff        admin lists staff/invites · revoke needs a reason · a revoked cashier cannot sell ·
 *                revocation audited
 *   Admissions   admitted ticket listed with its admitter; lockout counters listed
 *   Queues       refund requests / receivables filter by status; unknown status refused
 *
 *   node scripts/test-event-admin.js
 */
'use strict';
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:1';
process.env.GCLOUD_PROJECT = 'demo-event-admin';
delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
delete process.env.K_SERVICE; delete process.env.FUNCTION_TARGET;

const Path = require('path');
const FN = Path.resolve(__dirname, '..', 'functions');
const { makeFakeFirestore } = require('./lib/fake-firestore-txn');
let NOW = Date.now();
const F = makeFakeFirestore({ clock: () => NOW, strictReadOrder: true });
const db = F.db;
const authApi = { getUser: async (u) => ({ uid: u, customClaims: {} }) };
const resolveIn = (m) => require.resolve(m, { paths: [FN] });
const stub = (m, exp) => { require.cache[resolveIn(m)] = { id: m, filename: m, loaded: true, exports: exp }; };
stub('firebase-admin/firestore', { getFirestore: () => db, FieldValue: F.FieldValue, Timestamp: F.Timestamp, FieldPath: F.FieldPath });
stub('firebase-admin/auth', { getAuth: () => authApi });
stub('firebase-admin', { apps: [{}], initializeApp: () => ({}), firestore: Object.assign(() => db, { FieldValue: F.FieldValue, Timestamp: F.Timestamp }), auth: () => authApi });

const OPS = require(Path.join(FN, 'event-ops.js'));
const SALES = require(Path.join(FN, 'event-sales.js'));
const EA = require(Path.join(FN, 'event-admin.js'));
OPS._setClock(() => NOW); SALES._setClock(() => NOW);

let pass = 0, fail = 0;
const ck = (l, ok, d) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined && d !== '' ? '   [' + String(typeof d === 'object' ? JSON.stringify(d) : d).slice(0, 160) + ']' : '')); ok ? pass++ : fail++; };
const who = (uid, token = {}) => ({ auth: uid ? { uid, token } : null, rawRequest: { headers: {} } });
const op = (name, uid, data = {}) => (OPS._h[name] || SALES._h[name])({ ...who(uid, { email: uid + '@x.co', email_verified: true }), data });
const ADMIN = { isAdmin: true, email: 'ops@sokoni.test', email_verified: true };
const adm = (name, data = {}, token = ADMIN, uid = 'admin1') => EA._adminH[name]({ ...who(uid, token), data });
async function code(p) { try { await p; return null; } catch (e) { return e.code || e.message; } }
const H = 3600 * 1000;
let k = 0; const key = () => 'adm-key-' + (++k) + '-xyz';
const LEAK = /"(pin|pinHash|token|qrData|qrCode|secret)"\s*:/;

(async () => {
  await db.doc('events/evA').set({ title: 'Fest', organizerUid: 'org1', status: 'live', startDate: new Date(NOW + 2 * H).toISOString(), endDate: new Date(NOW + 8 * H).toISOString(), totalTicketsSold: 0, capacity: 1000, refundPolicy: { mode: 'none' } });
  await db.doc('events/evB').set({ title: 'Other', organizerUid: 'org2', status: 'live', startDate: new Date(NOW + 2 * H).toISOString(), endDate: new Date(NOW + 8 * H).toISOString() });
  await db.doc('eventTicketTiers/REG').set({ eventId: 'evA', name: 'Regular', price: 2000, quantity: 500, sold: 0, isActive: true, currency: 'KES' });
  for (const [uid, role] of [['till1', 'cashier'], ['gate1', 'admission']]) {
    await OPS._h.eventStaffInvite({ ...who('org1'), data: { eventId: 'evA', email: uid + '@x.co', role } });
    await OPS._h.eventStaffAccept({ ...who(uid, { email: uid + '@x.co', email_verified: true }), data: { eventId: 'evA' } });
  }
  const cs = await op('eventQuickSale', 'till1', { eventId: 'evA', tender: 'cash', items: [{ tierId: 'REG', qty: 2 }], cashReceivedKes: 4000, idempotencyKey: key(), attendeeName: 'Achieng' });
  const card = await op('eventQuickSale', 'till1', { eventId: 'evA', tender: 'card_external', items: [{ tierId: 'REG', qty: 1 }], card: { provider: 'equity', reference: 'EQ55667788', amountKes: 2000 }, idempotencyKey: key() });
  const pins = (await op('eventSaleTickets', 'till1', { eventId: 'evA', saleId: cs.saleId })).tickets.map((t) => t.pin);

  /* An online order with its full money chain, seeded as the owning modules write it. */
  await db.doc('eventOrders/ORD001').set({ orderId: 'ORD001', eventId: 'evA', buyerUid: 'buyer1', buyerPhone: '254712345678', buyerEmail: 'buyer1@mail.co', paymentRef: 'PAYREF1', quantity: 1, totalAmount: 2000, status: 'refunded', tierId: 'REG' });
  await db.doc('eventTickets/TK1').set({ ticketId: 'TK1', orderId: 'ORD001', eventId: 'evA', buyerUid: 'buyer1', ticketNumber: 'SK-EVT-ABCDEF', pinHash: 'deadbeef', token: 'tok-secret', qrData: 'qr-secret', status: 'refunded', refundStatus: 'REFUNDED' });
  await db.doc('payments/PAYREF1').set({ ref: 'PAYREF1', status: 'COMPLETED', amountKES: 2000, phone: '254712345678', provider: 'intasend', purpose: 'event_ticket' });
  await db.doc('eventSettlements/PAYREF1').set({ paymentRef: 'PAYREF1', orderId: 'ORD001', eventId: 'evA', organizerUid: 'org1', grossCents: 200000, providerFeeCents: 6000, commissionCents: 5820, organizerNetCents: 188180, status: 'REFUNDED' });
  await db.doc('commissionLedger/evt_PAYREF1').set({ ref: 'PAYREF1', commissionCents: 5820, status: 'reversed' });
  await db.doc('eventRefundRequests/ORD001').set({ orderId: 'ORD001', eventId: 'evA', buyerUid: 'buyer1', status: 'REFUNDED', reasonCode: 'event_cancelled', fosRefundId: 'ref_PAYREF1' });
  await db.doc('fosRefundQueue/ref_PAYREF1').set({ payRef: 'PAYREF1', amountCents: 200000, status: 'completed' });
  /* A released order whose wallet credit exists. */
  await db.doc('eventOrders/ORD002').set({ orderId: 'ORD002', eventId: 'evA', buyerUid: 'buyer2', paymentRef: 'PAYREF2', quantity: 1, totalAmount: 2000, status: 'paid' });
  await db.doc('payments/PAYREF2').set({ ref: 'PAYREF2', status: 'COMPLETED', amountKES: 2000 });
  await db.doc('eventSettlements/PAYREF2').set({ paymentRef: 'PAYREF2', orderId: 'ORD002', eventId: 'evA', organizerUid: 'org1', grossCents: 200000, commissionCents: 5820, organizerNetCents: 188180, status: 'RELEASED', walletTxId: 'org1_PAYREF2_event', creditedKES: 1881 });
  await db.doc('walletTransactions/org1_PAYREF2_event').set({ uid: 'org1', type: 'event_ticket_earning', amount: 1881, paymentRef: 'PAYREF2' });
  /* An order whose payment record is missing. */
  await db.doc('eventOrders/ORD003').set({ orderId: 'ORD003', eventId: 'evA', buyerUid: 'buyer3', paymentRef: 'PAYREF3', quantity: 1, totalAmount: 2000, status: 'paid' });

  console.log('\n── guard ──');
  const NAMES = Object.keys(EA._adminH);
  ck('nine eventAdmin ops (incl. fiscal reconciliation + retry)', NAMES.length === 9 && NAMES.every((n) => /^eventAdmin/.test(n)), NAMES);
  for (const n of NAMES) {
    const res = await Promise.all([
      code(EA._adminH[n]({ ...who(null), data: {} })),
      code(adm(n, { eventId: 'evA', by: 'event', value: 'evA' }, { email: 'b@x.co' }, 'buyer1')),
      code(adm(n, { eventId: 'evA', by: 'event', value: 'evA' }, {}, 'org1')),
      code(adm(n, { eventId: 'evA', by: 'event', value: 'evA' }, {}, 'till1')),
    ]);
    ck(`${n}: signed-out / buyer / organizer / cashier refused`, res[0] === 'unauthenticated' && res.slice(1).every((c) => c === 'permission-denied'), res);
  }
  const src = require('fs').readFileSync(Path.join(FN, 'admin-os-dispatch.js'), 'utf8');
  ck('merged into adminOsDispatch', /require\('\.\/event-admin'\)/.test(src) && /eventInv\._adminH/.test(src));
  ck('adminOsDispatch binds the PIN key (else the lookup fails closed in production)', /secrets:\s*\[require\('\.\/event-ops'\)\.SOKONI_HMAC_KEY\]/.test(src));
  global.window = {};
  require(Path.resolve(__dirname, '..', 'sokoni-aos-entertainment.js'));
  const panelOps = global.window.SokoniAOSEntertainment.OPS;
  ck('panel whitelists every op', NAMES.every((n) => panelOps.includes(n)), NAMES.filter((n) => !panelOps.includes(n)));

  console.log('\n── search ──');
  const byEvent = await adm('eventAdminInvestigate', { by: 'event', value: 'evA' });
  ck('by event: tickets, orders and sales', byEvent.tickets.length >= 4 && byEvent.orders.length === 3 && byEvent.sales.length === 2, [byEvent.tickets.length, byEvent.orders.length, byEvent.sales.length]);
  const bySale = await adm('eventAdminInvestigate', { by: 'sale', value: cs.saleId });
  ck('by sale: the sale and its 2 tickets', bySale.sales.length === 1 && bySale.tickets.length === 2);
  const byCashier = await adm('eventAdminInvestigate', { by: 'cashier', value: 'till1' });
  ck('by cashier: both sales and the 3 tickets they sold', byCashier.sales.length === 2 && byCashier.tickets.length === 3, [byCashier.sales.length, byCashier.tickets.length]);
  const num = bySale.tickets[0].ticketNumber;
  const byNum = await adm('eventAdminInvestigate', { by: 'ticketNumber', value: num.toLowerCase() });
  ck('by ticket number (case-insensitive)', byNum.tickets.length === 1 && byNum.tickets[0].ticketNumber === num);
  ck('malformed ticket number refused', (await code(adm('eventAdminInvestigate', { by: 'ticketNumber', value: 'ABC' }))) === 'invalid-argument');
  const byCard = await adm('eventAdminInvestigate', { by: 'cardRef', value: 'eq55667788' });
  ck('by card terminal reference', byCard.sales.length === 1 && byCard.sales[0].id === card.saleId);
  const byBuyer = await adm('eventAdminInvestigate', { by: 'buyer', value: 'buyer1' });
  ck('by buyer: order + ticket', byBuyer.orders.length === 1 && byBuyer.tickets.length === 1);
  const byOrder = await adm('eventAdminInvestigate', { by: 'order', value: 'ORD001' });
  ck('by order', byOrder.orders.length === 1 && byOrder.tickets.length === 1);
  const byTicket = await adm('eventAdminInvestigate', { by: 'ticket', value: 'TK1' });
  ck('by ticket id', byTicket.tickets.length === 1);
  ck('unknown search dimension refused', (await code(adm('eventAdminInvestigate', { by: 'phone', value: '0712' }))) === 'invalid-argument');
  ck('injection-shaped id refused', (await code(adm('eventAdminInvestigate', { by: 'order', value: '../users/x' }))) === 'invalid-argument');

  console.log('\n── credentials ──');
  const all = JSON.stringify([byEvent, bySale, byCashier, byNum, byCard, byBuyer, byOrder, byTicket]);
  ck('no pin / pinHash / token / qrData field in any search response', !LEAK.test(all), (all.match(LEAK) || [])[0]);
  ck('no raw PIN value in any search response', pins.every((p) => !all.includes(p) && !all.includes(p.replace('-', ''))));
  ck('buyer phone masked', /"buyerPhone":"2547\*\*\*678"/.test(all) && !all.includes('254712345678'));
  ck('buyer email masked', /"buyerEmail":"b\*\*\*@mail\.co"/.test(all) && !all.includes('buyer1@mail.co'));

  console.log('\n── PIN identity ──');
  const pinHit = await adm('eventAdminInvestigate', { by: 'pin', eventId: 'evA', value: pins[0].toLowerCase().replace('-', ' ') });
  ck('admin finds the ticket from (event, PIN)', pinHit.tickets.length === 1 && pinHit.tickets[0].saleId === cs.saleId);
  ck('the PIN is not echoed', !JSON.stringify(pinHit).includes(pins[0]) && !JSON.stringify(pinHit).includes(pins[0].replace('-', '')) && !LEAK.test(JSON.stringify(pinHit)));
  const pinOther = await adm('eventAdminInvestigate', { by: 'pin', eventId: 'evB', value: pins[0] });
  ck('the same PIN on another event finds nothing (event-bound HMAC)', pinOther.tickets.length === 0);
  ck('malformed PIN refused', (await code(adm('eventAdminInvestigate', { by: 'pin', eventId: 'evA', value: 'O0I1-2345' }))) === 'invalid-argument');
  ck('PIN lookup requires the event', (await code(adm('eventAdminInvestigate', { by: 'pin', value: pins[0] }))) === 'invalid-argument');
  const audits = (await db.collection('adminAudit').where('action', '==', 'event_admin_pin_lookup').get()).docs.map((d) => d.data());
  const auditText = JSON.stringify(audits);
  ck('hit AND miss both audited', audits.length === 2 && audits.some((a) => a.after.found) && audits.some((a) => !a.after.found), audits.length);
  ck('audit rows never contain the PIN', pins.every((p) => !auditText.includes(p) && !auditText.includes(p.replace('-', ''))));
  ck('lookups never touch eventTicketSecrets', !/eventTicketSecrets/.test(require('fs').readFileSync(Path.join(FN, 'event-admin.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')));

  console.log('\n── trace ──');
  const tCash = await adm('eventAdminTrace', { saleId: cs.saleId });
  const st = (t, n) => t.stages.find((s) => s.stage === n);
  ck('cash sale: channel cash, payment n/a', tCash.channel === 'cash' && st(tCash, 'payment').state === 'n/a');
  ck('cash sale: commission + receivable + proceeds observed', ['commission', 'receivable', 'organizer_proceeds'].every((n) => st(tCash, n).state === 'observed'));
  ck('cash sale: proceeds are organizer-collected, receivable = the commission record', st(tCash, 'organizer_proceeds').record.status === 'ORGANIZER_COLLECTED' && st(tCash, 'receivable').record.amountCents === st(tCash, 'commission').record.commissionCents);
  ck('cash sale: refund n/a (offline), payout n/a', st(tCash, 'refund').state === 'n/a' && st(tCash, 'payout').state === 'n/a');
  ck('stage order is the brief\'s chain', tCash.stages.map((s) => s.stage).join('>') === 'event>tickets>sale>payment>fiscal>commission>receivable>organizer_proceeds>refund>payout');
  const tOnline = await adm('eventAdminTrace', { ticketId: 'TK1' });
  ck('online (via ticket): resolves the order and payment', tOnline.orderId === 'ORD001' && tOnline.paymentRef === 'PAYREF1' && tOnline.channel === 'online');
  ck('online: payment, commission, proceeds, refund observed', ['payment', 'commission', 'organizer_proceeds', 'refund'].every((n) => st(tOnline, n).state === 'observed'));
  ck('online: amounts copied from the records', st(tOnline, 'organizer_proceeds').record.commissionCents === 5820 && st(tOnline, 'refund').record.refund.amountCents === 200000);
  ck('online: sale n/a, receivable n/a', st(tOnline, 'sale').state === 'n/a' && st(tOnline, 'receivable').state === 'n/a');
  ck('online: payment phone masked, ticket credentials stripped', st(tOnline, 'payment').record.phone === '2547***678' && !LEAK.test(JSON.stringify(tOnline)));
  const tRel = await adm('eventAdminTrace', { orderId: 'ORD002' });
  ck('released: payout observed = the wallet transaction', st(tRel, 'payout').state === 'observed' && st(tRel, 'payout').record.amount === 1881);
  ck('released: no refund requested → empty', st(tRel, 'refund').state === 'empty');
  const tMissing = await adm('eventAdminTrace', { orderId: 'ORD003' });
  ck('missing payment record → empty (not invented)', st(tMissing, 'payment').state === 'empty' && st(tMissing, 'payment').record === null);
  ck('missing settlement → empty; payout n/a', st(tMissing, 'organizer_proceeds').state === 'empty' && st(tMissing, 'payout').state === 'n/a');
  ck('trace needs a reference', (await code(adm('eventAdminTrace', {}))) === 'invalid-argument');
  ck('unknown order → not-found', (await code(adm('eventAdminTrace', { orderId: 'NOPE99' }))) === 'not-found');

  console.log('\n── staff ──');
  const sl = await adm('eventAdminStaff', { eventId: 'evA' });
  ck('staff + invites listed, active now computed', sl.staff.length === 2 && sl.invites.length === 2 && sl.staff.every((s) => s.activeNow === true));
  ck('staff emails masked', sl.staff.every((s) => /\*\*\*@/.test(s.email)));
  ck('revoke needs a reason', (await code(adm('eventAdminRevokeStaff', { eventId: 'evA', uid: 'till1', reason: '' }))) === 'invalid-argument');
  ck('revoke unknown staff → not-found', (await code(adm('eventAdminRevokeStaff', { eventId: 'evA', uid: 'ghost', reason: 'suspected fraud' }))) === 'not-found');
  await adm('eventAdminRevokeStaff', { eventId: 'evA', uid: 'till1', reason: 'suspected fraud at the door' });
  ck('revoked cashier cannot sell', (await code(op('eventQuickSale', 'till1', { eventId: 'evA', tender: 'cash', items: [{ tierId: 'REG', qty: 1 }], cashReceivedKes: 2000, idempotencyKey: key() }))) === 'permission-denied');
  const ra = (await db.collection('adminAudit').where('action', '==', 'event_staff_revoked_by_admin').get()).docs.map((d) => d.data());
  ck('revocation audited with actor and reason', ra.length === 1 && ra[0].performedBy === 'admin1' && ra[0].after.reason === 'suspected fraud at the door');

  console.log('\n── admissions ──');
  await op('eventAdmitTicket', 'gate1', { eventId: 'evA', pin: pins[1] });
  await code(op('eventAdmitTicket', 'gate1', { eventId: 'evA', pin: 'ZZZZ-ZZZZ' }));
  const ad = await adm('eventAdminAdmissions', { eventId: 'evA' });
  ck('admission listed with its admitter', ad.admissions.length === 1 && ad.admissions[0].admittedBy === 'gate1');
  ck('PIN failure counters listed', ad.attempts.length >= 1 && ad.attempts.some((a) => a.fails >= 1));

  console.log('\n── queues ──');
  const rq = await adm('eventAdminRefundRequests', { status: 'REFUNDED' });
  ck('refund requests filtered by status', rq.requests.length === 1 && rq.requests[0].id === 'ORD001');
  ck('unknown refund status refused', (await code(adm('eventAdminRefundRequests', { status: 'PAID' }))) === 'invalid-argument');
  const rv = await adm('eventAdminReceivables', { status: 'OUTSTANDING' });
  ck('outstanding door-sale receivables listed', rv.receivables.length === 2);
  ck('unknown receivable status refused', (await code(adm('eventAdminReceivables', { status: 'X' }))) === 'invalid-argument');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
