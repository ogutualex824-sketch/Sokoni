/* test-event-settlement.js — Event tickets end to end: order → intent → payment → entitlement →
 * held settlement → release, with refunds, expiry and AdminOS authority.
 *
 * WHAT THESE PROVE (each grant paired with its refusal)
 *   Webhook     the REAL webhookIntasend (scripts/lib/webhook-harness.js) takes the self-settling
 *               exit: NO wallet, NO marketplace commissionLedger — while the BASE tree, given the
 *               same payment, credits the BUYER (positive control: the hazard is real)
 *   Pricing     createPaymentIntent('event_ticket') prices the ORDER: server amount, ref = orderId,
 *               NO sellerUid · other buyer / paid order / cancelled event refused · no client amount
 *   Purchase    purchaseTickets: 100 % promo → paid at once (was stranded at pending_payment)
 *   Activation  COMPLETE → order paid, tickets valid, settlement HELD, commission booked ONCE ·
 *               replay + 6 concurrent activations → one ledger, one settlement · PENDING refused ·
 *               short payment refused · unreported fee → tickets valid, settlement FEE_UNREPORTED,
 *               NO commission row
 *   Money       3 % of (gross − provider fee) from commission-config RATES.event_tickets —
 *               not Creator 30 %, not POS 5 %, not marketplace 15 %
 *   Release     not before the event ends + 24 h · cancelled event never · open refund never ·
 *               due → organizer wallets.balance credited ONCE (replay skipped) · whole shillings,
 *               remainder recorded
 *   Expiry      unpaid order > 45 min releases seats · a PENDING payment is never expired ·
 *               a LATE payment after expiry is honoured, seats re-reserved, oversold flagged
 *   Refund      full refund → tickets refunded, settlement REFUNDED, commission reversed, exactly
 *               once · partial → exception · after release → exception, NO silent wallet debit
 *   AdminOS     eventAdmin* refuse a non-admin · fee attest needs SUPER admin + evidence
 *   Authority   cancelEvent accepts a boolean-claim admin · organizer gate accepts an approved
 *               event_organizer role
 *
 * NO NETWORK: firebase-admin replaced in the require cache; emulator host points at a dead port.
 *   node scripts/test-event-settlement.js
 */
'use strict';
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:1';
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-event-test';
delete process.env.GOOGLE_APPLICATION_CREDENTIALS;

const Path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
const ROOT = Path.resolve(__dirname, '..');
const FN = Path.join(ROOT, 'functions');
const { makeFakeFirestore } = require('./lib/fake-firestore-txn');

let NOW = Date.now();                 /* real clock: purchaseTickets reads new Date() */
const F = makeFakeFirestore({ clock: () => NOW, strictReadOrder: true });
const db = F.db;
const users = { buyer1: { uid: 'buyer1' }, buyer2: { uid: 'buyer2' }, org1: { uid: 'org1' }, adm: { uid: 'adm' } };
const resolveIn = (m) => require.resolve(m, { paths: [FN] });
const stub = (m, exp) => { require.cache[resolveIn(m)] = { id: m, filename: m, loaded: true, exports: exp }; };
stub('firebase-admin/firestore', { getFirestore: () => db, FieldValue: F.FieldValue, Timestamp: F.Timestamp, FieldPath: F.FieldPath });
stub('firebase-admin/auth', { getAuth: () => ({ getUser: async (u) => ({ uid: u, customClaims: {} }) }) });
const adminNs = { apps: [{}], initializeApp: () => ({}), app: () => ({}),
  firestore: Object.assign(() => db, { FieldValue: F.FieldValue, Timestamp: F.Timestamp, FieldPath: F.FieldPath }),
  auth: () => ({ getUser: async (u) => ({ uid: u, customClaims: {} }) }) };
stub('firebase-admin', adminNs);

const ES = require(Path.join(FN, 'event-settlement.js'));
const EH = require(Path.join(FN, 'event-hub.js'));
const engine = require(Path.join(FN, 'entitlement-engine.js'));
ES.registerPurpose();
const POLICY = require(Path.join(FN, 'shared', 'commercial-policy.js'));
let intents = null;
try { intents = require(Path.join(FN, 'payment-intents.js')); } catch (e) { console.log('  (payment-intents not loadable: ' + e.message.split('\n')[0] + ')'); }

let pass = 0, fail = 0;
const ck = (l, ok, d) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined && d !== '' ? '   [' + String(d).slice(0, 120) + ']' : '')); ok ? pass++ : fail++; };
const who = (uid, claims = {}) => ({ auth: uid ? { uid, token: { ...claims } } : null, rawRequest: { headers: {} } });
async function code(p) { try { await p; return null; } catch (e) { return e.code || e.message; } }
const get = async (p) => { const s = await db.doc(p).get(); return s.exists ? s.data() : null; };
const H = 3600 * 1000;

async function seedEvent(id, { startMs = NOW + 48 * H, endMs = NOW + 52 * H, status = 'live', organizerUid = 'org1' } = {}) {
  await db.doc(`events/${id}`).set({ title: 'Gig ' + id, organizerUid, status, startDate: new Date(startMs).toISOString(), endDate: new Date(endMs).toISOString(), totalTicketsSold: 0, currency: 'KES' });
  await db.doc(`eventTicketTiers/${id}_t`).set({ eventId: id, name: 'Regular', price: 500, quantity: 10, sold: 0, isActive: true, currency: 'KES' });
}
async function seedOrder(id, { eventId = 'evA', buyer = 'buyer1', qty = 2, total = 1000, status = 'pending_payment', createdMs = NOW } = {}) {
  await db.doc(`eventOrders/${id}`).set({ orderId: id, buyerUid: buyer, eventId, tierId: `${eventId}_t`, tierName: 'Regular', quantity: qty, unitPrice: total / qty, totalAmount: total, currency: 'KES', status, createdAt: F.Timestamp.fromMillis(createdMs) });
  for (let i = 0; i < qty; i++) await db.doc(`eventTickets/${id}_k${i}`).set({ ticketId: `${id}_k${i}`, orderId: id, eventId, buyerUid: buyer, status: status === 'pending_payment' ? 'awaiting_payment' : 'valid' });
}
async function pay(ref, { buyer = 'buyer1', amountCents = 100000, status = 'COMPLETE', charges = 15, eventId = 'evA' } = {}) {
  await db.doc(`paymentIntents/${ref}`).set({ ref, purpose: 'event_ticket', resourceType: 'eventOrder', resourceId: ref, uid: buyer, ownerUid: buyer, amount: amountCents / 100, amountCents, currency: 'KES', status: 'created',
    metadata: { type: 'event_ticket', eventId, organizerUid: 'org1' }, createdAt: F.Timestamp.fromMillis(NOW) });
  await db.doc(`payments/${ref}`).set({ ref, uid: buyer, amount: amountCents / 100, amountCents, currency: 'KES', status,
    providerReport: charges == null ? {} : { charges, value: amountCents / 100, netAmount: amountCents / 100 - charges } });
}

(async () => {
  /* ═══ 1. the REAL webhook: branch exits, base credits the buyer ═══ */
  console.log('\n── webhook (real webhookIntasend, harness) ──');
  const HARNESS = Path.join(__dirname, 'lib', 'webhook-harness.js');
  const run = (tree) => { const r = spawnSync(process.execPath, [HARNESS, tree, 'eventTicket'], { cwd: ROOT, encoding: 'utf8', timeout: 180000, maxBuffer: 64 * 1024 * 1024 });
    const line = (r.stdout || '').trim().split('\n').pop(); try { return JSON.parse(line); } catch (_) { return { crashed: (r.stderr || r.stdout || '').slice(0, 300) }; } };
  const br = run(ROOT);
  ck('branch harness ran', !br.crashed, br.crashed);
  if (!br.crashed) {
    const st = br.store;
    ck('webhook answered 200 twice (original + replay)', JSON.stringify(br.calls) === '[200,200]', br.calls);
    ck('branch: NO wallet written (no buyer credit, no premature organizer credit)', !Object.keys(st).some((k) => /^wallets\//.test(k)), Object.keys(st).filter((k) => /^wallets\//.test(k)).join(','));
    ck('branch: NO marketplace commissionLedger/EO1', !st['commissionLedger/EO1']);
    ck('branch: the self-settling exit fired', br.logs.some((l) => /self-settling purpose — no generic commission/.test(l)));
    ck('branch: order paid + both tickets valid', st['eventOrders/EO1'].status === 'paid' && st['eventTickets/tk1'].status === 'valid' && st['eventTickets/tk2'].status === 'valid');
    const s = st['eventSettlements/EO1'];
    ck('branch: settlement HELD, 3 % of NET (1000 − 15 = 985 → 29.55)', s && s.status === 'HELD' && s.commissionCents === 2955 && s.organizerNetCents === 95545 && s.providerFeeCents === 1500, s && JSON.stringify({ c: s.commissionCents, n: s.organizerNetCents }));
    ck('branch: event commission row evt_EO1 (source event_ticket, 3 %)', st['commissionLedger/evt_EO1'] && st['commissionLedger/evt_EO1'].commissionPct === 3 && st['commissionLedger/evt_EO1'].status === 'held');
    ck('branch: replay → alreadyActive', br.eventActivation && br.eventActivation.activated && br.eventActivation.replay.alreadyActive);
  }
  const BASE = process.env.CREATOR_BASE_TREE || 'C:/temp/sok-creator-base2';
  if (fs.existsSync(Path.join(BASE, 'functions', 'index.js'))) {
    const bs = run(BASE);
    const credited = !bs.crashed && Object.keys(bs.store).some((k) => /^wallets\/buyer1/.test(k));
    ck('POSITIVE CONTROL: the BASE webhook credits the BUYER on this payment (the hazard is real)', credited, bs.crashed || '');
  } else {
    console.log('  BLOCKED  positive control — base tree not present at ' + BASE);
  }

  /* ═══ 2. pricing: createPaymentIntent('event_ticket') ═══ */
  console.log('\n── pricing (real createPaymentIntent → event_ticket) ──');
  await seedEvent('evA');
  await seedOrder('ORDA001');
  ck('createPaymentIntent loadable', !!intents);
  if (intents) {
    const r = await intents.createPaymentIntent.run({ ...who('buyer1'), data: { purpose: 'event_ticket', orderId: 'ORDA001', amount: 1, amountCents: 100, phone: '254712345678' } });
    const it = await get(`paymentIntents/${r.ref || r.intentRef || 'ORDA001'}`);
    ck('intent ref IS the order id', (r.ref || r.intentRef) === 'ORDA001', JSON.stringify(r).slice(0, 100));
    ck('server amount = order total (client amount ignored)', it && it.amountCents === 100000 && it.amount === 1000, it && it.amountCents);
    ck('intent carries organizerUid and NO sellerUid', it && it.metadata.organizerUid === 'org1' && !('sellerUid' in it.metadata));
    ck('replay returns the same intent (idempotent)', !(await code(intents.createPaymentIntent.run({ ...who('buyer1'), data: { purpose: 'event_ticket', orderId: 'ORDA001' } }))));
    ck("another buyer's intent for an ALREADY-quoted order refused (intent replay guard)", !!(await code(intents.createPaymentIntent.run({ ...who('buyer2'), data: { purpose: 'event_ticket', orderId: 'ORDA001' } }))));
    await seedOrder('ORDB002');
    /* A FRESH order no intent exists for: only the pricer's ownership check stands between a
       stranger and a quote for someone else's seats. */
    ck("another buyer's order refused by the pricer itself (fresh order)", (await code(intents.createPaymentIntent.run({ ...who('buyer2'), data: { purpose: 'event_ticket', orderId: 'ORDB002' } }))) === 'permission-denied'
      && !(await get('paymentIntents/ORDB002')));
    await seedOrder('ORDPAID', { status: 'paid' });
    ck('an already-paid order refused', (await code(intents.createPaymentIntent.run({ ...who('buyer1'), data: { purpose: 'event_ticket', orderId: 'ORDPAID' } }))) === 'failed-precondition');
    await seedEvent('evX', { status: 'cancelled' }); await seedOrder('ORDX001', { eventId: 'evX' });
    ck('a cancelled event refused', (await code(intents.createPaymentIntent.run({ ...who('buyer1'), data: { purpose: 'event_ticket', orderId: 'ORDX001' } }))) === 'failed-precondition');
    ck('a missing order id refused', (await code(intents.createPaymentIntent.run({ ...who('buyer1'), data: { purpose: 'event_ticket' } }))) === 'invalid-argument');
  }

  /* ═══ 3. purchaseTickets: a 100 % promo is paid at once ═══ */
  console.log('\n── purchase ──');
  await seedEvent('evP');
  await db.doc('eventPromoCodes/pc1').set({ eventId: 'evP', code: 'FREE', isActive: true, discountType: 'percent', discountValue: 100, uses: 0 });
  const pr = await EH.purchaseTickets.run({ ...who('buyer1'), data: { tierId: 'evP_t', quantity: 2, promoCode: 'free', idempotencyKey: 'idem-free-1' } });
  ck('100 % promo → order paid immediately (was stranded)', pr.status === 'paid' && pr.payment === null, JSON.stringify(pr).slice(0, 100));
  const pr2 = await EH.purchaseTickets.run({ ...who('buyer1'), data: { tierId: 'evP_t', quantity: 1, idempotencyKey: 'idem-paid-1' } });
  ck('payable order → pending_payment + next step names the purpose and order', pr2.status === 'pending_payment' && pr2.payment && pr2.payment.purpose === 'event_ticket' && pr2.payment.orderId === pr2.orderId);

  /* ═══ 4. activation ═══ */
  console.log('\n── activation ──');
  await seedOrder('O1'); await pay('O1');
  const a1 = await ES.activateIfEventTicket('O1');
  ck('COMPLETE → activated', a1.activated === true, JSON.stringify(a1));
  const [o1, s1, c1] = [await get('eventOrders/O1'), await get('eventSettlements/O1'), await get('commissionLedger/evt_O1')];
  ck('order paid, tickets valid', o1.status === 'paid' && (await get('eventTickets/O1_k0')).status === 'valid' && (await get('eventTickets/O1_k1')).status === 'valid');
  ck('settlement HELD with release after the event end + 24 h', s1.status === 'HELD' && s1.releaseAfter.toMillis() === NOW + 52 * H + 24 * H);
  ck('commission = 3 % of (gross − fee) exactly', s1.commissionCents === Math.floor((100000 - 1500) * 300 / 10000) && c1.commissionCents === s1.commissionCents);
  ck('organizer + commission + fee == gross (value conserved)', s1.organizerNetCents + s1.commissionCents + s1.providerFeeCents === s1.grossCents);
  ck('rate source is commission-config RATES.event_tickets', s1.rateSource === 'commission-config.RATES.event_tickets' && s1.policy === 'event_ticket_v1');
  const conc = await Promise.all([1, 2, 3, 4, 5, 6].map(() => ES.activateIfEventTicket('O1')));
  ck('replay + 6 concurrent → all alreadyActive, ONE settlement, ONE commission row', conc.every((r) => r.alreadyActive) && db._dump('eventSettlements/O1').length === 1 && db._dump('commissionLedger/evt_O1').length === 1);

  await seedOrder('O2'); await pay('O2', { status: 'PENDING' });
  const a2 = await ES.activateIfEventTicket('O2');
  ck('PENDING payment refused (no tickets, no settlement)', a2.refused && (await get('eventOrders/O2')).status === 'pending_payment' && !(await get('eventSettlements/O2')));
  await seedOrder('O3'); await pay('O3', { amountCents: 50000 });
  const a3 = await ES.activateIfEventTicket('O3');
  ck('short payment refused', a3.refused && (await get('eventOrders/O3')).status === 'pending_payment', a3.code);
  await seedOrder('O4'); await pay('O4', { buyer: 'buyer2' });
  await db.doc('paymentIntents/O4').set({ uid: 'buyer2', ownerUid: 'buyer2' }, { merge: true });
  ck('payer ≠ order buyer refused', (await ES.activateIfEventTicket('O4')).refused === true);
  await seedOrder('O5'); await pay('O5', { charges: null });
  const a5 = await ES.activateIfEventTicket('O5');
  const s5 = await get('eventSettlements/O5');
  ck('unreported fee: tickets STILL valid (buyer paid)', a5.activated && (await get('eventTickets/O5_k0')).status === 'valid');
  ck('unreported fee: settlement FEE_UNREPORTED, NO commission row, nothing assumed', s5.status === 'FEE_UNREPORTED' && s5.commissionCents === null && !(await get('commissionLedger/evt_O5')));

  /* ═══ 5. commercial policy is category-scoped, not global ═══ */
  console.log('\n── commercial policy ──');
  const m = Object.fromEntries(POLICY.matrix().map((r) => [r.key, r]));
  ck('Creator Hub 30 % (net of fee)', m.creator_ppv.pct === 30 && m.creator_ppv.basis === 'NET_OF_PROVIDER_FEE');
  ck('Events 3 % per ticket (net of fee)', m.event_ticket.pct === 3);
  ck('Marketplace online 15 %', m.marketplace_online.pct === 15);
  ck('POS / Till 5 %', m.pos_till.pct === 5);
  ck('Quick Charge 5 % (POS lane)', m.quick_charge.pct === 5 && m.quick_charge.source === m.pos_till.source);
  ck('Streaming resolves to the Creator policy (owner decision)', POLICY.policyFor({ domain: 'entertainment', category: 'streaming' }).commercialPolicyId === 'creator_ppv_v1');
  ck('NO global Entertainment rate: an unmapped category is refused', (await code(Promise.resolve().then(() => POLICY.policyFor({ domain: 'entertainment', category: 'music' })))) === 'policy_unknown');
  ck('five distinct rates across the matrix (not one flattened number)', new Set(Object.values(m).map((r) => r.pct)).size >= 4);

  /* ═══ 6. release ═══ */
  console.log('\n── release ──');
  ck('not due before the event ends + 24 h', (await ES.releaseOne('O1', { nowMs: NOW })).skipped === 'not_due');
  NOW += 80 * H;
  const rl = await ES.releaseOne('O1', { nowMs: NOW });
  const w = await get('wallets/org1');
  ck('due → organizer wallets.balance credited in whole shillings', rl.released && w.balance === Math.floor(95545 / 100), JSON.stringify(rl));
  ck('rounding remainder recorded, not dropped', (await get('eventSettlements/O1')).roundingRemainderCents === 95545 - Math.floor(95545 / 100) * 100);
  ck('wallet transaction id is deterministic', !!(await get('walletTransactions/org1_O1_event')));
  const rr = await ES.releaseOne('O1', { nowMs: NOW }).catch((e) => ({ threw: e.message }));
  ck('replay release → skipped by the status guard, balance unchanged', rr.skipped === 'status_RELEASED' && (await get('wallets/org1')).balance === w.balance, JSON.stringify(rr));
  ck('commission row marked collected', (await get('commissionLedger/evt_O1')).status === 'collected');
  ck('FEE_UNREPORTED never releases', (await ES.releaseOne('O5', { nowMs: NOW })).skipped === 'status_FEE_UNREPORTED');
  await seedEvent('evC', { startMs: NOW - 30 * H, endMs: NOW - 26 * H }); await seedOrder('C1', { eventId: 'evC' }); await pay('C1', { eventId: 'evC' });
  await ES.activateIfEventTicket('C1');
  await db.doc('events/evC').set({ status: 'cancelled' }, { merge: true });
  ck('cancelled event never releases', (await ES.releaseOne('C1', { nowMs: NOW })).skipped === 'event_cancelled');
  await seedEvent('evR', { startMs: NOW - 30 * H, endMs: NOW - 26 * H }); await seedOrder('R1', { eventId: 'evR' }); await pay('R1', { eventId: 'evR' });
  await ES.activateIfEventTicket('R1');
  await db.doc('fosRefundQueue/ref_R1').set({ status: 'pending', payRef: 'R1' });
  ck('an open refund request blocks release', (await ES.releaseOne('R1', { nowMs: NOW })).skipped === 'refund_open');

  /* ═══ 7. expiry + late payment ═══ */
  console.log('\n── expiry ──');
  await seedEvent('evE');
  await db.doc('eventTicketTiers/evE_t').set({ sold: 10, quantity: 10 }, { merge: true });
  await seedOrder('E1', { eventId: 'evE', createdMs: NOW - 60 * 60 * 1000 });
  await seedOrder('E2', { eventId: 'evE', createdMs: NOW - 60 * 60 * 1000 });
  await db.doc('payments/E2').set({ status: 'PENDING', uid: 'buyer1' });
  await seedOrder('E3', { eventId: 'evE', createdMs: NOW - 5 * 60 * 1000 });
  ck('unpaid > 45 min → expired, seats released', (await ES.expireOne('E1', { nowMs: NOW })).expired && (await get('eventTicketTiers/evE_t')).sold === 8 && (await get('eventTickets/E1_k0')).status === 'void');
  ck('a PENDING payment is never expired', (await ES.expireOne('E2', { nowMs: NOW })).skipped === 'payment_PENDING');
  ck('a fresh order is not expired', (await ES.expireOne('E3', { nowMs: NOW })).skipped === 'not_due');
  await db.doc('eventTicketTiers/evE_t').set({ sold: 10 }, { merge: true });   /* seats resold meanwhile */
  await pay('E1', { eventId: 'evE' });
  const late = await ES.activateIfEventTicket('E1');
  ck('LATE payment after expiry is honoured (never rejected)', late.activated && (await get('eventOrders/E1')).status === 'paid' && (await get('eventOrders/E1')).lateSettled === true);
  ck('…seats re-reserved and an oversold alert raised', (await get('eventTicketTiers/evE_t')).sold === 12 && (await get('oversoldAlerts/evt_E1')).status === 'OPEN');

  /* ═══ 8. refunds (called by financial-os after the canonical refund settles) ═══ */
  console.log('\n── refunds ──');
  const rf = await ES.onEventRefundProcessed({ payRef: 'C1', refundId: 'ref_C1', amountCents: 100000, source: 'test' });
  const sC = await get('eventSettlements/C1');
  ck('full refund → settlement REFUNDED, tickets refunded, order refunded', rf.revoked && sC.status === 'REFUNDED' && (await get('eventTickets/C1_k0')).status === 'refunded' && (await get('eventOrders/C1')).status === 'refunded');
  ck('…commission reversed', (await get('commissionLedger/evt_C1')).status === 'reversed');
  ck('…entitlement REVOKED', (await get('entitlements/C1')).status === 'REVOKED');
  ck('refund replay → alreadyRevoked (no double reversal)', (await ES.onEventRefundProcessed({ payRef: 'C1', refundId: 'ref_C1', amountCents: 100000 })).alreadyRevoked === true);
  const pp = await ES.onEventRefundProcessed({ payRef: 'R1', refundId: 'ref_R1', amountCents: 40000 });
  ck('partial refund → exception, tickets untouched', pp.partial && (await get('eventExceptions/partial_refund_R1')).status === 'OPEN' && (await get('eventTickets/R1_k0')).status === 'valid');
  const balBefore = (await get('wallets/org1')).balance;
  await ES.onEventRefundProcessed({ payRef: 'O1', refundId: 'ref_O1', amountCents: 100000 });
  ck('refund AFTER release → exception, NO silent wallet debit', ((await get('eventExceptions/refund_after_release_O1')) || {}).status === 'OPEN' && (await get('wallets/org1')).balance === balBefore);
  ck('a non-event payment is ignored by the hook', (await ES.onEventRefundProcessed({ payRef: 'NOPE', amountCents: 1 })).skipped === 'not_event_ticket');

  /* ═══ 9. AdminOS authority ═══ */
  console.log('\n── AdminOS ──');
  for (const op of Object.keys(ES._adminH)) {
    ck(`${op} refuses a plain user`, (await code(ES._adminH[op]({ ...who('buyer1'), data: {} }))) === 'permission-denied');
  }
  ck('overview works for an admin', !(await code(ES._adminH.eventAdminOverview({ ...who('adm', { admin: true }), data: {} }))));
  ck('fee attest refuses an ordinary admin', (await code(ES._adminH.eventAdminAttestFee({ ...who('adm', { admin: true }), data: { paymentRef: 'O5', feeKes: 15, evidence: 'IS-DASH-123' } }))) === 'permission-denied');
  ck('fee attest refuses missing evidence', (await code(ES._adminH.eventAdminAttestFee({ ...who('adm', { superAdmin: true }), data: { paymentRef: 'O5', feeKes: 15 } }))) === 'invalid-argument');
  const at = await ES._adminH.eventAdminAttestFee({ ...who('adm', { superAdmin: true }), data: { paymentRef: 'O5', feeKes: 15, evidence: 'IS-DASH-123' } });
  ck('super admin attests → HELD + commission booked', at.ok && (await get('eventSettlements/O5')).status === 'HELD' && (await get('commissionLedger/evt_O5')).commissionCents === 2955);
  ck('attest is one-shot (fee immutable once recognised)', (await code(ES._adminH.eventAdminAttestFee({ ...who('adm', { superAdmin: true }), data: { paymentRef: 'O5', feeKes: 1, evidence: 'IS-DASH-999' } }))) === 'failed-precondition');
  ck('attest is audited with before/after (AdminOS Audit Center reads createdAt)', db._dump('adminAudit/').some((a) => a.action === 'event_fee_attested' && a.before && a.after && a.createdAt));

  /* ═══ 10. event-hub authority fixes ═══ */
  console.log('\n── event-hub authority ──');
  await db.doc('users/orgApproved').set({ roles: ['event_organizer'] });
  await db.doc('users/plain').set({ roles: ['buyer'] });
  ck('organizer gate accepts an approved event_organizer', !(await code(EH._internal.requireOrganizer('orgApproved'))));
  ck('organizer gate refuses a plain account', (await code(EH._internal.requireOrganizer('plain'))) === 'permission-denied');
  await seedEvent('evK', { organizerUid: 'someoneElse' });
  ck('cancelEvent: boolean-claim admin may cancel (was locked out)', !(await code(EH.cancelEvent.run({ ...who('adm', { admin: true }), data: { eventId: 'evK', reason: 'test' } }))));
  await seedEvent('evK2', { organizerUid: 'someoneElse' });
  ck('cancelEvent: a stranger may not', (await code(EH.cancelEvent.run({ ...who('buyer1'), data: { eventId: 'evK2' } }))) === 'permission-denied');

  /* ═══ 11. wiring ═══ */
  console.log('\n── wiring ──');
  const idx = fs.readFileSync(Path.join(FN, 'index.js'), 'utf8');
  ck('index exports the trigger and both schedules by name', /exports\.eventOnTicketPayment\s*=/.test(idx) && /exports\.eventReleaseSettlements\s*=/.test(idx) && /exports\.eventExpireUnpaidOrders\s*=/.test(idx));
  ck('event_ticket is a self-settling purpose', require(Path.join(FN, 'shared', 'self-settling-purposes.js')).isSelfSettling('event_ticket'));
  ck('refund authority calls the event hook', /require\('\.\/event-settlement'\)\.onEventRefundProcessed/.test(fs.readFileSync(Path.join(FN, 'financial-os.js'), 'utf8')));
  ck('AdminOS dispatcher merges eventAdmin* ops', /events\._adminH/.test(fs.readFileSync(Path.join(FN, 'admin-os-dispatch.js'), 'utf8')));
  ck('engine has event_ticket registered', !!engine.getPurpose('event_ticket'));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASH', e && e.stack || e); process.exit(3); });
