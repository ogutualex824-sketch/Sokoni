/* test-event-sales.js — event-day cashier Quick Sale: cash, external card, cashier-assisted
 * IntaSend; door-sale commission receivables and their netting at settlement release.
 * Transactional fake Firestore; no network.
 *
 * PROVES
 *   Cash        server prices (a client price is ignored) · cash < total refused · change computed ·
 *               tickets issued with PINs, walk-in, attributed to the cashier · 3 % (not POS 5 %)
 *               recorded as a RECEIVABLE · inventory decremented in the same transaction
 *   Inventory   6 concurrent cashier sales for the last 3 seats → exactly 3 · capacity enforced ·
 *               sold-out refused
 *   Replay      same sale key → the same sale, no second ticket · another cashier cannot reuse it
 *   Card        no reference → PENDING_EXTERNAL (seats held, NO tickets) · wrong amount / provider
 *               refused · duplicate reference refused (cross-sale) · confirm issues tickets ·
 *               pending expiry and cancel release the seats
 *   IntaSend    cashier sale → order → REAL createPaymentIntent → activation: tickets + PINs,
 *               walk-in (no buyerUid), sale COMPLETED, settlement HELD (3 % net of fee)
 *   Netting     release pays the organizer net of outstanding door-sale commission (oldest first);
 *               receivable COLLECTED; partial when the settlement is smaller
 *   Scope       admission staff / marketing cannot sell · expired cashier refused · a cashier sees
 *               only their own sales and PINs · organizer sees all by tender
 *   End to end  a cash ticket's PIN admits at the gate
 *
 *   node scripts/test-event-sales.js
 */
'use strict';
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:1';
process.env.GCLOUD_PROJECT = 'demo-event-sales';
delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
delete process.env.K_SERVICE; delete process.env.FUNCTION_TARGET;

const Path = require('path');
const FN = Path.resolve(__dirname, '..', 'functions');
/* Ticket commission READ from the policy the server uses (→ commission-config.RATES.event_tickets). The owner schedule
   of 2026-09-28 moved it 3% → 5%; every expected amount below is derived from it, never typed. */
const TPCT = require(Path.join(FN, 'shared', 'commercial-policy.js')).policyFor({ policyKey: 'event_ticket' }).pct;
const TBPS = Math.round(TPCT * 100);
const tc = (cents) => Math.floor(cents * TBPS / 10000);   /* commercial-policy.commissionCents floors toward the payer */
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
const ES = require(Path.join(FN, 'event-settlement.js'));
OPS._setClock(() => NOW); SALES._setClock(() => NOW);
ES.registerPurpose();
let intents = null;
try { intents = require(Path.join(FN, 'payment-intents.js')); } catch (e) { console.log('  (payment-intents not loadable: ' + e.message.split('\n')[0] + ')'); }

let pass = 0, fail = 0;
const ck = (l, ok, d) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined && d !== '' ? '   [' + String(typeof d === 'object' ? JSON.stringify(d) : d).slice(0, 150) + ']' : '')); ok ? pass++ : fail++; };
const who = (uid, token = {}) => ({ auth: uid ? { uid, token } : null, rawRequest: { headers: {} } });
/* Admission needs the confirmed ticket number (event-ops, owner decision 2026-09-27). This helper plays a
   staff member who checked the attendee's ticket: it confirms the number of the PIN's own ticket. Tests of
   the confirmation itself pass confirmTicketNumber explicitly. */
async function _confirmed(data) {
  if (!data || 'confirmTicketNumber' in data) return data;
  const hit = await OPS.lookupPin(data.eventId, data.pin).catch(() => null);
  const t = hit ? (await F.db.doc('eventTickets/' + hit.ticketId).get()).data() : null;
  return { ...data, confirmTicketNumber: (t && t.ticketNumber) || 'SK-EVT-0000-000000' };
}
const op = async (name, uid, data = {}) => (OPS._h[name] || SALES._h[name])({ ...who(uid, { email: uid + '@x.co', email_verified: true }), data: name === 'eventAdmitTicket' ? await _confirmed(data) : data });
async function code(p) { try { await p; return null; } catch (e) { return e.code || e.message; } }
const get = async (p) => { const s = await db.doc(p).get(); return s.exists ? s.data() : null; };
const H = 3600 * 1000;
let k = 0; const key = () => 'sale-key-' + (++k) + '-xyz';

async function setup() {
  await db.doc('events/evA').set({ title: 'Fest', organizerUid: 'org1', status: 'live', startDate: new Date(NOW + 2 * H).toISOString(), endDate: new Date(NOW + 8 * H).toISOString(), totalTicketsSold: 0, capacity: 1000 });
  await db.doc('eventTicketTiers/VIP').set({ eventId: 'evA', name: 'VIP', price: 5000, quantity: 100, sold: 0, isActive: true, currency: 'KES' });
  await db.doc('eventTicketTiers/REG').set({ eventId: 'evA', name: 'Regular', price: 2000, quantity: 500, sold: 0, isActive: true, currency: 'KES' });
  await db.doc('eventTicketTiers/LAST').set({ eventId: 'evA', name: 'Last', price: 1000, quantity: 3, sold: 0, isActive: true, currency: 'KES' });
  await db.doc('events/evB').set({ title: 'Other', organizerUid: 'org2', status: 'live', startDate: new Date(NOW + 2 * H).toISOString(), endDate: new Date(NOW + 8 * H).toISOString(), totalTicketsSold: 0 });
  await db.doc('eventTicketTiers/B1').set({ eventId: 'evB', name: 'Gen', price: 800, quantity: 10, sold: 0, isActive: true, currency: 'KES' });
  for (const [uid, role] of [['till1', 'cashier'], ['till2', 'cashier'], ['gate1', 'admission'], ['promo1', 'marketing']]) {
    await OPS._h.eventStaffInvite({ ...who('org1'), data: { eventId: 'evA', email: uid + '@x.co', role } });
    await OPS._h.eventStaffAccept({ ...who(uid, { email: uid + '@x.co', email_verified: true }), data: { eventId: 'evA' } });
  }
}

(async () => {
  await setup();

  /* ═══ cash is refused (owner decision 2026-09-27) ═══ */
  console.log('\n── cash refused ──');
  const salesBefore = db._dump('eventSales/').length;
  const cashTry = await code(op('eventQuickSale', 'till1', { eventId: 'evA', tender: 'cash', items: [{ tierId: 'REG', qty: 1 }], cashReceivedKes: 5000, idempotencyKey: key() }));
  ck('CASH is refused outright for event ticket sales — no sale, no ticket, no seat held', cashTry === 'failed-precondition' && db._dump('eventSales/').length === salesBefore && (await get('eventTicketTiers/REG')).sold === 0, cashTry);

  /* ═══ door sale on the organizer's card terminal (the remaining door route) ═══ */
  console.log('\n── door card sale ──');
  const cashReq = { eventId: 'evA', tender: 'card_external', items: [{ tierId: 'VIP', qty: 1, price: 1 }, { tierId: 'REG', qty: 2 }], card: { provider: 'equity', reference: 'DOOR000001', amountKes: 9000 }, idempotencyKey: key(), attendeeName: 'Wanjiru Kamau' };
  const cs = await op('eventQuickSale', 'till1', cashReq);
  const sale = await get(`eventSales/${cs.saleId}`);
  ck('server total = 5,000 + 2 × 2,000 = 9,000 (the client "price: 1" is ignored)', sale.grossCents === 900000 && sale.status === 'COMPLETED', sale.grossCents);
  ck('the terminal reference is recorded; the payment is attested, not verified', sale.card && sale.card.reference === 'DOOR000001' && sale.paymentVerified === false);
  ck('sale attributed to the cashier (uid, role, device)', sale.cashierUid === 'till1' && sale.cashierRole === 'cashier');
  const tix = db._dump('eventTickets/').filter((t) => t.saleId === cs.saleId);
  ck('3 tickets issued, valid, walk-in, soldBy the cashier, each with a PIN', tix.length === 3 && tix.every((t) => t.status === 'valid' && t.walkIn && t.soldBy === 'till1' && !t.buyerUid && t.pinHash && /^SK-EVT-/.test(t.ticketNumber)));
  const rec = await get(`eventCommissionReceivables/${cs.saleId}`);
  ck(`SOKONI ticket rate (${TPCT} %) recorded as a RECEIVABLE — the ticket policy, not the POS lane`, rec && rec.amountCents === tc(900000) && rec.status === 'OUTSTANDING', rec && rec.amountCents);
  const st = await get(`eventSettlements/${cs.saleId}`);
  ck('settlement row ORGANIZER_COLLECTED (the organizer\'s terminal took it; nothing to release — never withdrawable)', st.status === 'ORGANIZER_COLLECTED' && st.channel === 'CARD_EXTERNAL' && st.organizerNetCents === 900000 - tc(900000));
  ck(`commission ledger row is a receivable at the ticket rate (${TPCT} %)`, (await get(`commissionLedger/evt_${cs.saleId}`)).status === 'receivable' && (await get(`commissionLedger/evt_${cs.saleId}`)).commissionPct === TPCT);
  ck('inventory decremented (VIP 1, Regular 2, event 3)', (await get('eventTicketTiers/VIP')).sold === 1 && (await get('eventTicketTiers/REG')).sold === 2 && (await get('events/evA')).totalTicketsSold === 3);

  /* ═══ replay ═══ */
  console.log('\n── replay ──');
  const rp = await op('eventQuickSale', 'till1', cashReq);
  ck('same key → the SAME sale, no second ticket', rp.replay && rp.saleId === cs.saleId && db._dump('eventTickets/').filter((t) => t.saleId === cs.saleId).length === 3 && (await get('eventTicketTiers/VIP')).sold === 1);
  ck('another cashier cannot reuse the key', (await code(op('eventQuickSale', 'till2', cashReq))) === 'permission-denied');

  /* ═══ inventory ═══ */
  console.log('\n── inventory ──');
  const race = await Promise.all(Array.from({ length: 6 }, (_, i) => op('eventQuickSale', i % 2 ? 'till1' : 'till2', { eventId: 'evA', tender: 'card_external', items: [{ tierId: 'LAST', qty: 1 }], card: { provider: 'equity', reference: `RACE00000${i}`, amountKes: 1000 }, idempotencyKey: key() }).catch((e) => ({ err: e.code }))));
  ck('6 concurrent sales for the last 3 seats → exactly 3 succeed', race.filter((r) => r.status === 'COMPLETED').length === 3 && (await get('eventTicketTiers/LAST')).sold === 3, race.map((r) => r.status || r.err).join(','));
  ck('sold out → refused', (await code(op('eventQuickSale', 'till1', { eventId: 'evA', tender: 'card_external', items: [{ tierId: 'LAST', qty: 1 }], card: { provider: 'equity', reference: 'SOLDOUT001', amountKes: 1000 }, idempotencyKey: key() }))) === 'resource-exhausted');
  await db.doc('events/evA').set({ capacity: (await get('events/evA')).totalTicketsSold + 1 }, { merge: true });
  ck('event capacity enforced across tiers', (await code(op('eventQuickSale', 'till1', { eventId: 'evA', tender: 'card_external', items: [{ tierId: 'REG', qty: 2 }], card: { provider: 'equity', reference: 'CAPACITY01', amountKes: 4000 }, idempotencyKey: key() }))) === 'resource-exhausted');
  await db.doc('events/evA').set({ capacity: 1000 }, { merge: true });

  /* ═══ card (external terminal) ═══ */
  console.log('\n── card ──');
  const pend = await op('eventQuickSale', 'till1', { eventId: 'evA', tender: 'card_external', items: [{ tierId: 'REG', qty: 1 }], idempotencyKey: key() });
  ck('card without a reference → PENDING_EXTERNAL, NO tickets, seats held', pend.status === 'PENDING_EXTERNAL' && !db._dump('eventTickets/').some((t) => t.saleId === pend.saleId) && (await get('eventTicketTiers/REG')).sold === 3);
  ck('confirm with the WRONG amount refused', (await code(op('eventConfirmExternalCard', 'till1', { eventId: 'evA', saleId: pend.saleId, provider: 'kcb', reference: 'TRX778899', amountKes: 1999 }))) === 'invalid-argument');
  ck('another cashier cannot confirm it', (await code(op('eventConfirmExternalCard', 'till2', { eventId: 'evA', saleId: pend.saleId, provider: 'kcb', reference: 'TRX778899', amountKes: 2000 }))) === 'permission-denied');
  const conf = await op('eventConfirmExternalCard', 'till1', { eventId: 'evA', saleId: pend.saleId, provider: 'kcb', reference: 'trx-778899', amountKes: 2000 });
  const ps = await get(`eventSales/${pend.saleId}`);
  ck('confirmed → COMPLETED, tickets issued, attested (not verified), reference normalised', conf.status === 'COMPLETED' && ps.paymentVerified === false && ps.attestation.by === 'till1' && ps.card.reference === 'TRX-778899');
  ck('duplicate card reference refused on a NEW sale', (await code(op('eventQuickSale', 'till2', { eventId: 'evA', tender: 'card_external', items: [{ tierId: 'REG', qty: 1 }], card: { provider: 'kcb', reference: 'TRX-778899', amountKes: 2000 }, idempotencyKey: key() }))) === 'already-exists');
  ck('card with reference but wrong amount refused', (await code(op('eventQuickSale', 'till1', { eventId: 'evA', tender: 'card_external', items: [{ tierId: 'REG', qty: 1 }], card: { provider: 'kcb', reference: 'NEWREF123', amountKes: 1500 }, idempotencyKey: key() }))) === 'invalid-argument');
  ck('unknown terminal provider refused', (await code(op('eventQuickSale', 'till1', { eventId: 'evA', tender: 'card_external', items: [{ tierId: 'REG', qty: 1 }], card: { provider: 'magic', reference: 'NEWREF123', amountKes: 2000 }, idempotencyKey: key() }))) === 'invalid-argument');
  const direct = await op('eventQuickSale', 'till1', { eventId: 'evA', tender: 'card_external', items: [{ tierId: 'REG', qty: 1 }], card: { provider: 'equity', reference: 'EQ12345678', amountKes: 2000 }, idempotencyKey: key() });
  ck(`card with a valid reference completes at once, receivable at the ticket rate (${TPCT} %)`, direct.status === 'COMPLETED' && (await get(`eventCommissionReceivables/${direct.saleId}`)).amountCents === tc(200000));
  const p2 = await op('eventQuickSale', 'till1', { eventId: 'evA', tender: 'card_external', items: [{ tierId: 'VIP', qty: 2 }], idempotencyKey: key() });
  const vipHeld = (await get('eventTicketTiers/VIP')).sold;
  await op('eventCancelPendingSale', 'till1', { eventId: 'evA', saleId: p2.saleId });
  ck('cancel a pending card sale → seats released, nothing issued', (await get(`eventSales/${p2.saleId}`)).status === 'CANCELLED' && (await get('eventTicketTiers/VIP')).sold === vipHeld - 2);
  const p3 = await op('eventQuickSale', 'till1', { eventId: 'evA', tender: 'card_external', items: [{ tierId: 'VIP', qty: 1 }], idempotencyKey: key() });
  NOW += 31 * 60 * 1000;
  const n = await SALES.expirePendingSales(NOW);
  ck('pending card sale expires after 30 min → seats released', n >= 1 && (await get(`eventSales/${p3.saleId}`)).status === 'EXPIRED');
  ck('an expired pending sale cannot be confirmed', (await code(op('eventConfirmExternalCard', 'till1', { eventId: 'evA', saleId: p3.saleId, provider: 'kcb', reference: 'LATE000001', amountKes: 5000 }))) === 'failed-precondition');

  /* ═══ cashier-assisted IntaSend ═══ */
  console.log('\n── cashier IntaSend ──');
  const is = await op('eventQuickSale', 'till1', { eventId: 'evA', tender: 'intasend', items: [{ tierId: 'REG', qty: 2 }], idempotencyKey: key() });
  ck('IntaSend at the till → an ORDER for the canonical payment path (no second rail)', is.status === 'AWAITING_PAYMENT' && is.payment.purpose === 'event_ticket' && (await get(`eventOrders/${is.saleId}`)).channel === 'cashier');
  ck('no ticket is valid before payment', db._dump('eventTickets/').filter((t) => t.saleId === is.saleId).every((t) => t.status === 'awaiting_payment' && !t.pinHash));
  if (intents) {
    const intent = await intents.createPaymentIntent.run({ ...who('till1'), data: { purpose: 'event_ticket', orderId: is.saleId, phone: '254712345678' } });
    ck('REAL createPaymentIntent prices the cashier order (4,000)', intent.amount === 4000, intent.amount);
  }
  await db.doc(`payments/${is.saleId}`).set({ ref: is.saleId, uid: 'till1', amountCents: 400000, currency: 'KES', status: 'COMPLETE', providerReport: { charges: 20 } });
  if (!intents) await db.doc(`paymentIntents/${is.saleId}`).set({ purpose: 'event_ticket', resourceType: 'eventOrder', resourceId: is.saleId, uid: 'till1', ownerUid: 'till1', amountCents: 400000, amount: 4000, currency: 'KES', metadata: { organizerUid: 'org1' } });
  const act = await ES.activateIfEventTicket(is.saleId);
  const itix = db._dump('eventTickets/').filter((t) => t.saleId === is.saleId);
  ck('activation issues PINs; tickets stay WALK-IN (no buyerUid)', act.activated && itix.length === 2 && itix.every((t) => t.status === 'valid' && t.pinHash && !t.buyerUid));
  ck('the cashier sale is COMPLETED by the activation', (await get(`eventSales/${is.saleId}`)).status === 'COMPLETED');
  const ist = await get(`eventSettlements/${is.saleId}`);
  ck(`online settlement HELD at the ticket rate (${TPCT} %) of (gross − fee)`, ist.status === 'HELD' && ist.commissionCents === Math.floor((400000 - 2000) * TBPS / 10000));

  /* ═══ PIN visibility + scope ═══ */
  console.log('\n── scope ──');
  const mine = await op('eventSaleTickets', 'till1', { eventId: 'evA', saleId: cs.saleId });
  ck('the selling cashier gets the walk-in PINs to hand over', mine.tickets.length === 3 && mine.tickets.every((t) => /^\d{4}$/.test(t.pin) && OPS.TICKET_NUMBER_RE.test(t.ticketNumber)));
  ck("another cashier cannot read that sale's PINs", (await code(op('eventSaleTickets', 'till2', { eventId: 'evA', saleId: cs.saleId }))) === 'permission-denied');
  ck('organizer can', (await op('eventSaleTickets', 'org1', { eventId: 'evA', saleId: cs.saleId })).tickets.every((t) => !!t.pin));
  ck('admission staff cannot sell', (await code(op('eventQuickSale', 'gate1', { ...cashReq, idempotencyKey: key() }))) === 'permission-denied');
  ck('marketing staff cannot sell', (await code(op('eventQuickSale', 'promo1', { ...cashReq, idempotencyKey: key() }))) === 'permission-denied');
  ck('a cashier of event A cannot sell for event B', (await code(op('eventQuickSale', 'till1', { eventId: 'evB', tender: 'card_external', items: [{ tierId: 'B1', qty: 1 }], card: { provider: 'equity', reference: 'EVB0000001', amountKes: 800 }, idempotencyKey: key() }))) === 'permission-denied');
  const l1 = await op('eventListSales', 'till1', { eventId: 'evA' });
  ck('a cashier lists ONLY their own sales', l1.scope === 'mine' && l1.sales.every((s) => s.cashierUid === 'till1'));
  const lo = await op('eventListSales', 'org1', { eventId: 'evA' });
  ck('organizer lists all sales with the tender breakdown — and no cash tender exists', lo.scope === 'event' && !lo.byTender.cash && lo.byTender.card_external && lo.byTender.intasend, JSON.stringify(Object.keys(lo.byTender)));

  /* ═══ end to end: a door-card ticket admits by PIN ═══ */
  const pinCash = mine.tickets[0].pin;
  ck('a door-card ticket is admitted at the gate by its PIN', (await op('eventAdmitTicket', 'gate1', { eventId: 'evA', pin: pinCash })).result === 'admitted');

  /* ═══ netting at release ═══ */
  console.log('\n── netting ──');
  const outstanding = db._dump('eventCommissionReceivables/').filter((r) => r.status === 'OUTSTANDING').reduce((a, r) => a + r.amountCents, 0);
  NOW = Date.parse((await get('events/evA')).endDate) + 25 * H;
  await db.doc('events/evA').set({ status: 'ended' }, { merge: true });
  const beforeBal = ((await get('wallets/org1')) || {}).balance || 0;
  const rel = await ES.releaseOne(is.saleId, { nowMs: NOW });
  const after = await get(`eventSettlements/${is.saleId}`);
  const netted = after.doorCommissionNettedCents;
  ck('release nets outstanding door-sale commission before paying the organizer', rel.released && netted === Math.min(outstanding, ist.organizerNetCents), `${netted} of ${outstanding}`);
  ck('organizer credited net of the netting (whole shillings)', (await get('wallets/org1')).balance - beforeBal === Math.floor((ist.organizerNetCents - netted) / 100));
  ck('the door card-sale receivable is COLLECTED', (await get(`eventCommissionReceivables/${cs.saleId}`)).status === 'COLLECTED');
  ck('its commission ledger row is marked collected', (await get(`commissionLedger/evt_${cs.saleId}`)).status === 'collected');

  /* partial: a small settlement against a larger receivable */
  await db.doc('eventCommissionReceivables/BIG').set({ organizerUid: 'org1', eventId: 'evA', source: 'cash', amountCents: 10000000, collectedCents: 0, status: 'OUTSTANDING', createdAt: F.Timestamp.fromMillis(NOW) });
  await db.doc('eventSettlements/SMALL').set({ paymentRef: 'SMALL', orderId: 'SMALLO', eventId: 'evA', organizerUid: 'org1', status: 'HELD', organizerNetCents: 5000, releaseAfter: F.Timestamp.fromMillis(NOW - 1) });
  await db.doc('eventOrders/SMALLO').set({ status: 'paid' });
  const bal2 = (await get('wallets/org1')).balance;
  await ES.releaseOne('SMALL', { nowMs: NOW });
  const big = await get('eventCommissionReceivables/BIG');
  ck('a smaller settlement collects PART of a larger receivable; the organizer gets 0', big.status === 'OUTSTANDING' && big.collectedCents === 5000 && (await get('wallets/org1')).balance === bal2);

  /* expiry of staff */
  NOW = Date.parse((await get('events/evA')).endDate) + 13 * H;
  ck('the cashier cannot sell after their window', (await code(op('eventQuickSale', 'till1', { ...cashReq, idempotencyKey: key() }))) === 'permission-denied');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASH', e && e.stack || e); process.exit(3); });
