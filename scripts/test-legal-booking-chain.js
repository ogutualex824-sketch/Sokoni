#!/usr/bin/env node
/* LEGAL HUB L4 — a Legal consultation is a CANONICAL provider booking, end to end on the server, in-process:
 *   register → AdminOS approve → LSK verified (Mode B) → projection opens providers/{uid} + legal_consult rate card
 *   → bookingCreateService (server price) → [paid_held: FIXTURE of the verified IntaSend webhook's effect]
 *   → settleOnPinRelease → ONE commission (5%) → provider wallet net → second release is a no-op
 *   → AdminOS suspend closes booking; retired bookLegalConsultation writes nothing; fee edit re-prices the rate card.
 *   node scripts/test-legal-booking-chain.js        BASE=<ref> (pre-L4 must FAIL) */
'use strict';
const path = require('path'), fs = require('fs'), os = require('os'), cp = require('child_process');
const H = require('./lib/inmem-firestore').install({ admins: ['admin1'] });
const { call } = require('./lib/inmem-firestore');
const ROOT = path.join(__dirname, '..');
let FN = process.env.FN_DIR || path.join(ROOT, 'functions');
if (process.env.BASE) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'lgb-'));
  cp.execSync('git archive ' + process.env.BASE + ' functions | tar -x -C "' + d.split(path.sep).join('/') + '"', { cwd: ROOT, shell: 'bash' });
  FN = path.join(d, 'functions');
}
let pass = 0, fail = 0;
const ck = (id, ok, m, got) => { console.log('  ' + (ok ? 'PASS' : 'FAIL') + ' ' + id + ' ' + m + (ok || got === undefined ? '' : '   [got ' + JSON.stringify(got).slice(0, 320) + ']')); ok ? pass++ : fail++; };
const { DOCS } = H;
const run = (exp) => (r) => exp.run(r);
const tomorrow = () => new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10);
console.log('\nLegal Hub L4 — Legal consultation on the canonical booking + settlement rails   ' + (process.env.BASE ? 'BASE=' + process.env.BASE : 'this tree') + '\n');

(async () => {
  const LH = require(path.join(FN, 'legal-hub.js'));
  const LV = require(path.join(FN, 'legal-verification.js'));
  const BS = require(path.join(FN, 'booking-service.js'))._h;
  const PO = require(path.join(FN, 'provider-ops.js'));
  H.reset();
  DOCS.set('users/cust', { displayName: 'Client' });
  DOCS.set('users/adv', { displayName: 'Wanjiru Kamau' });
  DOCS.set('providerAvailability/adv', { modes: ['open_24_7'], appt: {} });

  let r = await call(run(LH.registerLegalProvider), 'adv', { name: 'Wanjiru Kamau', licenseNumber: 'P.105/1234/15', practiceAreas: ['family-law'], consultationFee: 5000, county: 'Nairobi' });
  ck('C0', !!r.ok, 'advocate registers (pending review)', r);

  await LV.applyAdminDecision(H.db, { uid: 'adv', app: DOCS.get('applications/legal_adv'), appId: 'legal_adv', status: 'approved', decidedBy: 'admin1' });
  const prov1 = DOCS.get('providers/adv') || {};
  const b0 = await call(BS.bookingCreateService, 'cust', { providerId: 'adv', serviceId: 'legal_consult_adv', date: tomorrow(), startTime: '10:00', idempotencyKey: 'k0' });
  ck('C1', prov1.acceptsBookings === false && prov1.searchable === false && b0.code === 'failed-precondition' && !Object.keys(Object.fromEntries(DOCS)).some((k) => k.startsWith('providerBookings/')),
    'admin approval ALONE does not open booking (LSK pending): identity linked but closed, booking refused, nothing written', { prov1, b0: b0.code });

  r = await call(LV._adminH.legalAdminRecordLsk, 'admin1', { uid: 'adv', p105Number: 'P.105/1234/15', practiceStatus: 'Active', verifiedName: 'Wanjiru Kamau', evidenceRef: 'LSK search screenshot #1', checkedAt: Date.now() - 3600000 }, { admin: true });
  const prov2 = DOCS.get('providers/adv') || {}, svc = DOCS.get('providerServices/legal_consult_adv') || {};
  const BCAT = require(path.join(FN, 'business-category.js'));
  const pe2 = BCAT.publicEligibility(DOCS.get('providers/adv'));
  ck('C2', !!r.ok && prov2.acceptsBookings === true && prov2.searchable === true && prov2.status === 'active' && svc.active === true && svc.price === 500000 && svc.priceType === 'fixed',
    'admin approval + current LSK Active → providers/{uid} bookable & discoverable; consultation rate card active at the advocate fee (KES 5,000 = 500000 cents)', { r: r.code || 'ok', prov2, svc });

  const bk = await call(BS.bookingCreateService, 'cust', { providerId: 'adv', serviceId: 'legal_consult_adv', date: tomorrow(), startTime: '10:00', idempotencyKey: 'k1', price: 100, amount: 100, totalCents: 100 });
  const bid = bk.ok && (bk.ok.bookingId || bk.ok.id);
  const B = bid ? DOCS.get('providerBookings/' + bid) : null;
  ck('C3', !!B && B.providerId === 'adv' && B.customerUid === 'cust' && Number(B.price) === 500000 && B.paymentStatus !== 'paid_held' && B.paymentStatus !== 'paid',
    'client books via bookingCreateService: providerBookings row at the SERVER price (client price 100 ignored), not paid', { bk, B });

  /* The REAL webhook hold step (booking-payment-sweep.holdServiceBookingPayment, called by both IntaSend COMPLETE
     handlers). FIXTURE, honestly scoped: the server-minted intent (createPaymentIntent's output) and the payment record the
     verified webhook stores (incl. IntaSend's own method, 5b 525fd9f). The IntaSend HTTP leg itself is NOT exercised here. */
  if (!bid) { ck('C4', false, 'no booking to settle (C3 failed) — fail closed'); return done(); }
  DOCS.set('paymentIntents/INT_' + bid, { resourceType: 'providerBooking', resourceId: bid, amountCents: 500000, status: 'pending' });
  DOCS.set('payments/API_' + bid, { apiRef: 'API_' + bid, providerMethod: 'M-PESA', invoiceId: 'INV-IS-1', status: 'COMPLETE' });
  const SW = require(path.join(FN, 'booking-payment-sweep.js'));
  const held = await SW.holdServiceBookingPayment(H.db, require('firebase-admin'), 'API_' + bid, 'INT_' + bid, 5000);
  DOCS.set('providerBookings/' + bid, Object.assign({}, DOCS.get('providerBookings/' + bid), { status: 'confirmed' }));   /* provider confirms (state, not money) */
  const RC = () => DOCS.get('transactionReceipts/service_booking_' + bid) || null;
  const rc1 = RC();
  const held2 = await SW.holdServiceBookingPayment(H.db, require('firebase-admin'), 'API_' + bid, 'INT_' + bid, 5000);
  const evs = (pre) => [...DOCS.keys()].filter((k) => k.startsWith('transactionReceipts/service_booking_' + bid + '/events/' + pre));
  ck('C12', DOCS.get('providerBookings/' + bid).paymentStatus === 'paid_held' && !!rc1 && rc1.paidCents === 500000 && rc1.heldCents === 500000 && rc1.status === 'paid_held'
    && rc1.method === 'M-PESA' && rc1.taxTreatment === 'unknown' && rc1.clientUid === 'cust' && rc1.counterpartyId === 'adv' && !!rc1.receiptNo
    && rc1.confirmation && rc1.confirmation.source === 'intasend_webhook' && evs('paid_').length === 1,
    'webhook hold → ONE receipt: paid KES 5,000 held, IntaSend\'s own method recorded, tax treatment recorded (never inferred), numbered; a replayed webhook adds nothing', { held, held2, rc1 });
  const s1 = await PO.settleOnPinRelease(bid, 'cust');
  const B2 = DOCS.get('providerBookings/' + bid);
  const wtx = [...DOCS.keys()].filter((k) => /^walletTransactions\//.test(k)).map((k) => DOCS.get(k)).filter((t) => JSON.stringify(t).includes(bid));
  const PAY = DOCS.get('providerPayouts/' + bid) || {}, W = DOCS.get('wallets/adv') || {};
  ck('C4', s1 && s1.credited === 4750 && B2.status === 'completed' && B2.paymentStatus === 'settled' && PAY.gross === 500000 && PAY.commission === 25000 && PAY.net === 475000 && W.balance === 4750 && wtx.length === 1,
    'PIN release settles ONCE through the shared pipeline: KES 5,000 → SOKONI 5% = 250 → provider 4,750 net: payout record gross/commission/net in cents, provider wallet +KES 4,750, one wallet transaction, booking settled', { s1, PAY, W, B2: { status: B2.status, paymentStatus: B2.paymentStatus }, wtx: wtx.length });
  const s2 = await PO.settleOnPinRelease(bid, 'cust');
  ck('C5', s2 && s2.skipped && s2.credited === undefined, 'a second PIN release is a no-op — no double commission, no double credit', s2);
  const rc2 = RC();
  ck('C13', !!rc2 && rc2.status === 'released' && rc2.heldCents === 0 && rc2.releasedCents === 500000 && rc2.platformFeeCents === 25000
    && rc2.providerNetCents === PAY.settlementCents && rc2.platformFeeCents + rc2.providerNetCents === rc2.releasedCents && evs('released_').length === 1,
    'PIN release → the receipt records ONE BALANCED release (contract v2): released KES 5,000 = SOKONI fee 250 + provider settlement 4,750 (= providerPayouts.settlementCents)', { rc2, settlementCents: PAY.settlementCents });

  /* C14 — refund before settlement (provider cancels a paid booking) → the receipt records the refund ONCE */
  const bk2 = await call(BS.bookingCreateService, 'cust', { providerId: 'adv', serviceId: 'legal_consult_adv', date: tomorrow(), startTime: '15:00', idempotencyKey: 'k2' });
  const bid2 = bk2.ok && (bk2.ok.bookingId || bk2.ok.id);
  let rc3 = null, ev3 = 0, rep3 = 0;
  if (bid2) {
    DOCS.set('paymentIntents/INT_' + bid2, { resourceType: 'providerBooking', resourceId: bid2, amountCents: 500000, status: 'pending' });
    DOCS.set('payments/API_' + bid2, { apiRef: 'API_' + bid2, providerMethod: 'CARD-PAYMENT', status: 'COMPLETE' });
    await SW.holdServiceBookingPayment(H.db, require('firebase-admin'), 'API_' + bid2, 'INT_' + bid2, 5000);
    const ref2 = H.db.collection('providerBookings').doc(bid2);
    await PO._disburseHeldFunds(DOCS.get('providerBookings/' + bid2), ref2, { by: 'provider', isNoShow: false });
    await PO._disburseHeldFunds(DOCS.get('providerBookings/' + bid2), ref2, { by: 'provider', isNoShow: false });
    rc3 = DOCS.get('transactionReceipts/service_booking_' + bid2) || null;
    ev3 = [...DOCS.keys()].filter((k) => k.startsWith('transactionReceipts/service_booking_' + bid2 + '/events/refunded_')).length;
  }
  ck('C14', !!rc3 && rc3.method === 'CARD-PAYMENT' && rc3.status === 'refunded' && rc3.refundedCents === 500000 && rc3.heldCents === 0 && rc3.releasedCents === 0 && ev3 === 1,
    'provider cancels a paid booking → full refund recorded ONCE on the receipt (no release, no fee); a repeat cancel adds nothing', { rc3, ev3 });
  /* C15 — refund AFTER settlement (the owner-decided reversal) → refund recorded on the released receipt, once */
  const rv1 = await PO.reverseServiceSettlement(bid, { decision: 'refund_full', actor: 'admin1' });
  const rv2 = await PO.reverseServiceSettlement(bid, { decision: 'refund_full', actor: 'admin1' });
  const rc4 = RC();
  ck('C15', rv1 && rv1.reversed && rv2 && rv2.alreadyReversed && !!rc4 && rc4.status === 'refunded' && rc4.refundedCents === 500000 && rc4.releasedCents === 500000 && evs('refunded_').length === 1,
    'refund after settlement → the released receipt records the full refund ONCE (released stays as history; status refunded)', { rv1, rc4 });
  /* C16 — the receipt system can FAIL without touching money: the hold still lands, the failure is queued WITH a replay */
  const TR = require(path.join(FN, 'transaction-receipts.js'));
  const origPaid = TR.recordPaid;
  const bk3 = await call(BS.bookingCreateService, 'cust', { providerId: 'adv', serviceId: 'legal_consult_adv', date: tomorrow(), startTime: '17:00', idempotencyKey: 'k3x' });
  const bid3 = bk3.ok && (bk3.ok.bookingId || bk3.ok.id);
  let c16 = { bid3 };
  if (bid3) {
    DOCS.set('paymentIntents/INT_' + bid3, { resourceType: 'providerBooking', resourceId: bid3, amountCents: 500000, status: 'pending' });
    DOCS.set('payments/API_' + bid3, { apiRef: 'API_' + bid3, providerMethod: null, status: 'COMPLETE' });
    TR.recordPaid = async () => { throw new Error('receipts store unavailable (test)'); };
    let threw = false;
    try { await SW.holdServiceBookingPayment(H.db, require('firebase-admin'), 'API_' + bid3, 'INT_' + bid3, 5000); } catch (_) { threw = true; }
    TR.recordPaid = origPaid;
    const fails = [...DOCS.keys()].filter((k) => k.startsWith(TR.FAILURES + '/')).map((k) => DOCS.get(k)).filter((f) => f.replay && f.replay.op === 'paid' && f.replay.args && f.replay.args.sourceId === bid3);
    c16 = { threw, status: DOCS.get('providerBookings/' + bid3).paymentStatus, receipt: DOCS.has('transactionReceipts/service_booking_' + bid3), fails: fails.length };
  }
  ck('C16', c16.threw === false && c16.status === 'paid_held' && c16.receipt === false && c16.fails === 1,
    'a receipts failure never blocks or reverses money: the payment is still held, and the failure is queued WITH a replay descriptor for the retry sweep', c16);
  /* C17 — receipt security (2f / owner rows): scope, other provider, unpaid release, duplicate refund */
  const ids = async (uid) => (await TR.receiptsFor(H.db, uid, {})).map((r) => r.receiptId + ':' + r.role).sort();
  const asClient = await ids('cust'), asProv = await ids('adv'), stranger = await ids('stranger'), otherProv = await ids('tech');
  const bk4 = await call(BS.bookingCreateService, 'cust', { providerId: 'adv', serviceId: 'legal_consult_adv', date: tomorrow(), startTime: '18:00', idempotencyKey: 'k4' });
  const bid4 = bk4.ok && (bk4.ok.bookingId || bk4.ok.id);
  const rel4 = bid4 ? await PO.settleOnPinRelease(bid4, 'cust') : null;
  const ref2b = bid2 ? H.db.collection('providerBookings').doc(bid2) : null;
  const dupRefund = ref2b ? await PO._disburseHeldFunds(DOCS.get('providerBookings/' + bid2), ref2b, { by: 'provider', isNoShow: false }) : 'x';
  ck('C17', asClient.indexOf('service_booking_' + bid + ':client') > -1 && asProv.indexOf('service_booking_' + bid + ':provider') > -1
    && stranger.length === 0 && otherProv.length === 0
    && rel4 && rel4.skipped && !DOCS.has('transactionReceipts/service_booking_' + bid4)
    && dupRefund === null && (DOCS.get('transactionReceipts/service_booking_' + bid2) || {}).refundedCents === 500000,
    'receipts are scoped to the buyer and the provider only (a stranger or another provider sees none); releasing an UNPAID booking does nothing and creates no receipt; a duplicate refund changes nothing',
    { asClient, asProv, stranger, otherProv, rel4, dupRefund });
  /* C10 — Legal rate cards name a taxonomy practice area; only a server-classified lawyer may set one (L6) */
  /* NO plan fixture (owner 10-03 + 2f 965c46d): on the FREE plan, the SOKONI-created consultation card does not count, so the advocate's own first rate card is allowed. */
  DOCS.set('providers/plumb', { status: 'active', category: 'plumbing', business: { category: 'plumbing', source: 'application' } });
  const sA = await call(PO._h.providerAddService, 'adv', { name: 'Term sheet review', price: 1500000, priceType: 'fixed', durationMins: 90, legalArea: 'term-sheets' });
  const sB = await call(PO._h.providerAddService, 'adv', { name: 'Bogus', price: 1000, legalArea: 'astrology' });
  const before = [...DOCS.keys()].filter((k) => k.startsWith('providerServices/')).length;
  const sC = await call(PO._h.providerAddService, 'plumb', { name: 'Pipe law', price: 1000, legalArea: 'mediation' });
  const after = [...DOCS.keys()].filter((k) => k.startsWith('providerServices/')).length;
  const newSvc = sA.ok && DOCS.get('providerServices/' + sA.ok.serviceId);
  const sD = sA.ok ? await call(PO._h.providerUpdateService, 'adv', { serviceId: sA.ok.serviceId, legalArea: null }) : { code: 'skip' };
  ck('C10', !!newSvc && newSvc.legalArea === 'term-sheets' && sB.det && sB.det.code === 'LEGAL_AREA_UNKNOWN'
    && sC.det && sC.det.code === 'LEGAL_AREA_NOT_LEGAL_PROVIDER' && before === after && !!sD.ok && DOCS.get('providerServices/' + sA.ok.serviceId).legalArea === undefined,
    'Legal rate card carries a taxonomy practice area; unknown area refused; a non-Legal provider cannot claim one (nothing written); null clears it', { sA, sB: sB.det, sC: sC.det, sD });
  /* C11 — a specialist area on a rate card only once SOKONI confirmed it (owner 10-03) */
  DOCS.set('providerSubscriptions/adv', { limits: { listings: -1 } });   /* fixture: a plan allowing a second advocate-created card */
  await call(require(path.join(FN, 'legal-dispatch.js')).legalDispatch.run.bind(null), 'adv', { op: 'legalUpdateProfile', specialistAreas: ['tax-law'] });
  const t1 = await call(PO._h.providerAddService, 'adv', { name: 'Tax dispute', price: 800000, priceType: 'fixed', legalArea: 'tax-law' });
  await call(LV._adminH.legalAdminConfirmSpecialist, 'admin1', { uid: 'adv', area: 'tax-law', confirm: true, reason: 'Verified tax practice' }, { admin: true });
  const t2 = await call(PO._h.providerAddService, 'adv', { name: 'Tax dispute', price: 800000, priceType: 'fixed', legalArea: 'tax-law' });
  ck('C11', t1.det && t1.det.code === 'LEGAL_SPECIALIST_NOT_CONFIRMED' && !!t2.ok && DOCS.get('providerServices/' + t2.ok.serviceId).legalArea === 'tax-law',
    'a specialist practice area (tax) is refused on a rate card until AdminOS confirms it, then allowed', { t1: t1.det, t2 });
  r = await call(run(LH.bookLegalConsultation), 'cust', { providerId: 'adv', dateTime: new Date(Date.now() + 86400000).toISOString(), matter: 'x', idempotencyKey: 'old1' });
  ck('C6', r.code === 'failed-precondition' && r.det && r.det.code === 'LEGAL_BOOKING_MOVED' && ![...DOCS.keys()].some((k) => k.startsWith('legalConsultations/')),
    'the retired Legal-only booking engine refuses and writes nothing (no legalConsultations, no money-less "booking")', r);

  r = await call(run(LH.registerLegalProvider), 'adv', {});
  const up = await call(require(path.join(FN, 'legal-dispatch.js')).legalDispatch.run.bind(null), 'adv', { op: 'legalUpdateProfile', consultationFee: 6000 });
  ck('C7', !!up.ok && DOCS.get('providerServices/legal_consult_adv').price === 600000 && DOCS.get('providerServices/legal_consult_adv').active === true,
    'advocate changes the fee → the consultation rate card is re-priced server-side (KES 6,000)', up);

  await LV.applyAdminDecision(H.db, { uid: 'adv', app: DOCS.get('applications/legal_adv'), appId: 'legal_adv_s', status: 'suspended', decidedBy: 'admin1' });
  const prov3 = DOCS.get('providers/adv') || {}, svc3 = DOCS.get('providerServices/legal_consult_adv') || {};
  const b3 = await call(BS.bookingCreateService, 'cust', { providerId: 'adv', serviceId: 'legal_consult_adv', date: tomorrow(), startTime: '12:00', idempotencyKey: 'k3' });
  ck('C8', prov3.acceptsBookings === false && prov3.searchable === false && svc3.active === false && b3.code === 'failed-precondition',
    'AdminOS suspension re-projects: not bookable, not discoverable, rate card off, new booking refused', { prov3, svc3: svc3.active, b3: b3.code });
  const pe3 = BCAT.publicEligibility(DOCS.get('providers/adv'));
  ck('C9', pe2.eligible === true && pe2.category === 'lawyer' && pe3.eligible === false && pe3.reasons.includes('SUSPENDED'),
    'search: the eligible lawyer is publicly discoverable through the canonical providers gate (C1 category lawyer); suspension removes it (owner 09-28: legacy lawyers registry stays de-indexed)', { pe2, pe3 });
  done();
})().catch((e) => { console.log('CRASH (fail closed): ' + (e && e.stack || e)); process.exit(2); });
function done() {
  console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed');
  console.log('NOT proven here: createPaymentIntent(service_booking) + IntaSend webhook for a Legal booking (fixture above); rules/emulator; browser.');
  process.exit(fail ? 1 : 0);
}
