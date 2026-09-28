/* test-event-credit-notes.js — the Event fiscal state machine, refund → credit-note linkage, idempotency,
 * provider-outcome handling and the security boundaries. Transactional fake Firestore in STRICT
 * read-order mode; the REAL functions/etims.js (sale invoices, queued) and REAL
 * functions/etims-lifecycle.js (credit notes); the REAL event refund wizard handing to the REAL
 * financial-os refund-request handler; no network, no KRA call.
 *
 * The provider is represented ONLY at the single server ingress for its answers
 * (recordCreditNoteOutcome / the eTIMS invoice fields etimsProcessQueue writes). The KRA transmission
 * of credit notes is NOT implemented platform-wide (etims-kra-adapter SPEC_LOADED=false), so every
 * credit note built here is 'blocked_pending_spec' — asserted, not hidden.
 *
 *   node scripts/test-event-credit-notes.js
 */
'use strict';
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:1';
process.env.GCLOUD_PROJECT = 'demo-event-credit-notes';
process.env.INTASEND_PRIVATE_KEY = 'harness';
delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
delete process.env.K_SERVICE; delete process.env.FUNCTION_TARGET;

const Path = require('path');
const fs = require('fs');
const FN = Path.resolve(__dirname, '..', 'functions');
/* Ticket commission READ from the policy the server uses (→ commission-config.RATES.event_tickets). The owner schedule
   of 2026-09-28 moved it 3% → 5%; every expected amount below is derived from it, never typed. */
const TPCT = require(Path.join(FN, 'shared', 'commercial-policy.js')).policyFor({ policyKey: 'event_ticket' }).pct;
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
stub('./notify', { notify: async () => ({ ok: true }) });
stub('./email-service', { EMAIL_SECRETS: [], sendEmail: async () => ({ ok: true }) });

const OPS = require(Path.join(FN, 'event-ops.js'));
const SALES = require(Path.join(FN, 'event-sales.js'));
const RF = require(Path.join(FN, 'event-refunds.js'));
const ES = require(Path.join(FN, 'event-settlement.js'));
const EH = require(Path.join(FN, 'event-hub.js'));
const EA = require(Path.join(FN, 'event-admin.js'));
const FISCAL = require(Path.join(FN, 'event-fiscal.js'));
OPS._setClock(() => NOW); RF._setClock(() => NOW); FISCAL._setClock(() => NOW); SALES._setClock(() => NOW);
ES.registerPurpose();
global.window = globalThis;
require(Path.resolve(__dirname, '..', 'sokoni-event-ticket.js'));
const TICKET = globalThis.SokoniEventTicket;

let pass = 0, fail = 0;
const ck = (l, ok, d) => { say('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined && d !== '' ? '   [' + String(typeof d === 'object' ? JSON.stringify(d) : d).slice(0, 170) + ']' : '')); ok ? pass++ : fail++; };
const who = (uid, token = {}) => ({ auth: { uid, token: { email: uid + '@x.co', email_verified: true, ...token } }, rawRequest: { headers: {} } });
const rf = (name, uid, data = {}) => RF._h[name]({ ...who(uid), data });
const adm = (name, data = {}, token = { isAdmin: true }) => EA._adminH[name]({ ...who('admin1', token), data });
const SUPER = { isAdmin: true, isSuperAdmin: true, superAdmin: true };
async function code(p) { try { await p; return null; } catch (e) { return e.code || e.message; } }
const get = async (p) => { const s = await db.doc(p).get(); return s.exists ? s.data() : null; };
const H = 3600 * 1000;
const view = async (k) => (await FISCAL.viewsFor([k]))[k];
const revsOf = (k) => db._dump('eventFiscalReversals/').filter((r) => r.fiscalRecordId === k);
const creditNotesOf = (invoiceId) => db._dump('creditNotes/').filter((c) => c.origInvoiceId === invoiceId);
const snap = async (orderId) => { const f = await get(`eventFiscal/${orderId}`); return JSON.stringify({ f, inv: f && f.invoiceId ? await get(`etimsInvoices/${f.invoiceId}`) : null }); };

async function mkEvent(id, { org = 'org1', policy = { mode: 'before_cutoff', cutoffAt: new Date(NOW + 48 * H).toISOString(), noShowRefund: true, penalty: { type: 'none' }, version: 1 }, startMs = NOW + 72 * H, status = 'live' } = {}) {
  await db.doc(`events/${id}`).set({ eventId: id, title: 'Show ' + id, organizerUid: org, status, startDate: new Date(startMs).toISOString(), endDate: new Date(startMs + 4 * H).toISOString(), totalTicketsSold: 0, refundPolicy: policy });
  await db.doc(`eventTicketTiers/${id}_t`).set({ tierId: `${id}_t`, eventId: id, name: 'Regular', price: 1000, quantity: 500, sold: 0, isActive: true, currency: 'KES' });
}
async function paid(orderId, eventId, { buyer = 'buyer1', qty = 2, org = 'org1' } = {}) {
  await db.doc(`eventOrders/${orderId}`).set({ orderId, buyerUid: buyer, eventId, tierId: `${eventId}_t`, tierName: 'Regular', quantity: qty, totalAmount: 1000 * qty, currency: 'KES', status: 'pending_payment', createdAt: F.Timestamp.fromMillis(NOW) });
  for (let i = 0; i < qty; i++) await db.doc(`eventTickets/${orderId}_k${i}`).set({ ticketId: `${orderId}_k${i}`, orderId, eventId, buyerUid: buyer, tierId: `${eventId}_t`, tierName: 'Regular', status: 'awaiting_payment', token: 'tok' + i + orderId, qrData: `sokoni-ticket:${orderId}_k${i}:tok${i}${orderId}` });
  await db.doc(`paymentIntents/${orderId}`).set({ ref: orderId, purpose: 'event_ticket', resourceType: 'eventOrder', resourceId: orderId, uid: buyer, ownerUid: buyer, amount: 1000 * qty, amountCents: 100000 * qty, currency: 'KES', metadata: { eventId, organizerUid: org } });
  await db.doc(`payments/${orderId}`).set({ ref: orderId, uid: buyer, amount: 1000 * qty, amountCents: 100000 * qty, currency: 'KES', status: 'COMPLETE', provider: 'intasend', providerReport: { charges: 30 } });
  return ES.activateIfEventTicket(orderId);
}
/* what etimsProcessQueue writes when KRA accepts the SALE invoice (submitToKra's own field mapping) */
async function kraAcceptsSale(orderId, rcpt) {
  const f = await get(`eventFiscal/${orderId}`);
  await db.doc(`etimsInvoices/${f.invoiceId}`).set({ status: 'accepted', receiptNumber: rcpt, controlUnitNumber: 'CU-' + rcpt, qrCode: `https://etims.kra.go.ke/qr/${rcpt}.png`, verificationUrl: `https://etims.kra.go.ke/verify?r=${rcpt}`, acceptedAt: new Date(NOW).toISOString() }, { merge: true });
}
const settle = (orderId, amountCents) => ES.onEventRefundProcessed({ payRef: orderId, refundId: 'ref_' + orderId, amountCents, source: 'canonical-refund-authority' });
const ok = (rcpt) => ({ kind: 'response', httpStatus: 200, body: { resultCd: '000', resultMsg: 'Successful', data: { rcptNo: rcpt, qrCodeUrl: `https://etims.kra.go.ke/cn/${rcpt}.png`, vsdcRcptUrl: `https://etims.kra.go.ke/verify?r=${rcpt}`, intrlData: 'CU-CN', rcptSgn: 'SIG' } } });

(async () => {
  await db.doc('etimsProfiles/org1').set({ status: 'active', kraPin: 'P051234567T', businessName: 'Kamau Events', branchId: '00', vatStatus: 'registered', invoicePrefix: 'KEV' });

  say('\n── fiscal state machine ──');
  await mkEvent('evR');
  await paid('ORDFS1', 'evR');
  let v = await view('ORDFS1');
  ck('paid + registered organizer → FISCAL_PENDING (real eTIMS invoice queued, no KRA call)', v.fiscalStatus === 'FISCAL_PENDING' && ((await get(`etimsInvoices/${(await get('eventFiscal/ORDFS1')).invoiceId}`)) || {}).status === 'pending_submission');
  await kraAcceptsSale('ORDFS1', 'RCPT-ORDFS1');
  v = await view('ORDFS1');
  ck('provider acceptance → FISCAL_ACCEPTED with exactly the provider receipt', v.fiscalStatus === 'FISCAL_ACCEPTED' && v.receiptNumber === 'RCPT-ORDFS1');
  await paid('ORDFS2', 'evR');
  await db.doc(`etimsInvoices/${(await get('eventFiscal/ORDFS2')).invoiceId}`).set({ status: 'failed', errorMessage: 'KRA rejected' }, { merge: true });
  v = await view('ORDFS2');
  ck('provider rejection → FISCAL_FAILED (no receipt)', v.fiscalStatus === 'FISCAL_FAILED' && !('receiptNumber' in v));
  await mkEvent('evU', { org: 'org2' });
  await paid('ORDFS3', 'evU', { org: 'org2' });
  v = await view('ORDFS3');
  ck('paid + unregistered organizer → FISCAL_NOT_REQUIRED / ORGANIZER_NOT_REGISTERED (no invoice under SOKONI)', v.fiscalStatus === 'FISCAL_NOT_REQUIRED' && v.reason === 'ORGANIZER_NOT_REGISTERED' && !db._dump('etimsInvoices/').some((i) => i.sellerUid !== 'org1'));
  ck('ticket still valid whatever the fiscal state (FAILED / NOT_REQUIRED)', (await get('eventTickets/ORDFS2_k0')).status === 'valid' && (await get('eventTickets/ORDFS3_k0')).status === 'valid');

  say('\n── A. full refund (with fiscal record) ──');
  await paid('ORDRA1', 'evR'); await kraAcceptsSale('ORDRA1', 'RCPT-ORDRA1');
  const origRA1 = await snap('ORDRA1');
  const qa = await rf('eventRefundQuote', 'buyer1', { orderId: 'ORDRA1', reasonCode: 'cannot_attend', answers: {} });
  ck('quote: gross 2,000, penalty 0, refund 2,000, policy version', qa.eligible === 'YES' && qa.grossKes === 2000 && qa.penaltyKes === 0 && qa.refundKes === 2000 && qa.policyVersion === 1);
  await rf('eventRequestRefund', 'buyer1', { orderId: 'ORDRA1', reasonCode: 'cannot_attend', answers: {} });
  const caseA = await get('eventRefundRequests/ORDRA1');
  ck('refund case references sale, tickets, payment, fiscal record, amounts, reason, policy version, admission + fiscal status',
    caseA.saleKey === 'ORDRA1' && caseA.paymentRef === 'ORDRA1' && caseA.ticketIds.length === 2 && caseA.grossCents === 200000 && caseA.penaltyCents === 0 && caseA.refundCents === 200000
    && caseA.reasonCode === 'cannot_attend' && caseA.policyVersion === 1 && caseA.admissionStatuses.every((x) => x === 'NOT_ADMITTED') && caseA.fiscalStatusAtRequest === 'FISCAL_ACCEPTED', caseA);
  ck('request not yet approved → NO credit note', revsOf('ORDRA1').length === 0 && ((await get('fosRefundQueue/ref_ORDRA1')) || {}).amountCents === 200000);
  await settle('ORDRA1', 200000);
  const exA = FISCAL.executionIdFor('ORDRA1', 'ORDRA1');
  const rA = await get(`eventFiscalReversals/${exA}`);
  ck('refund settled → ONE credit note, deterministic id = hash(fiscal record, refund case)', revsOf('ORDRA1').length === 1 && rA && rA.executionId === exA && /^[0-9a-f]{40}$/.test(exA));
  ck('credit note BUILT on the existing eTIMS lifecycle for the full principal → CREDIT_NOTE_PENDING', rA.status === 'CREDIT_NOTE_PENDING' && rA.refundCents === 200000
    && creditNotesOf((await get('eventFiscal/ORDRA1')).invoiceId).length === 1 && Math.abs(creditNotesOf((await get('eventFiscal/ORDRA1')).invoiceId)[0].totals.totAmt) === 2000);
  ck('honest transmission state: blocked — KRA credit-note mapping pending (no provider call)', rA.transmission === 'blocked_pending_spec' && ((await get(`etimsTransmissionQueue/${rA.creditNoteDocId}`)) || {}).status === 'blocked_pending_spec');
  ck('PENDING credit note carries NO reference and NO QR', rA.creditNoteReference === null && rA.creditNoteQr === null && (await view('ORDRA1')).creditNotes[0].creditNoteReference === null);
  ck('the ORIGINAL fiscal record + receipt are unchanged by the refund', (await snap('ORDRA1')) === origRA1);
  ck('tickets refunded (unusable), settlement reversed', (await get('eventTickets/ORDRA1_k0')).status === 'refunded' && (await get('eventSettlements/ORDRA1')).status === 'REFUNDED');

  say('\n── B / C. fixed + percentage penalty ──');
  await mkEvent('evF', { policy: { mode: 'before_cutoff', cutoffAt: new Date(NOW + 48 * H).toISOString(), noShowRefund: false, penalty: { type: 'fixed', value: 300 }, version: 1 } });
  await paid('ORDRB1', 'evF'); await kraAcceptsSale('ORDRB1', 'RCPT-ORDRB1');
  const qb = await rf('eventRefundQuote', 'buyer1', { orderId: 'ORDRB1', reasonCode: 'cannot_attend', answers: {} });
  ck('B quote: fixed KES 300 penalty → refund 1,700', qb.penaltyKes === 300 && qb.refundKes === 1700 && /KES 300 cancellation fee/.test(qb.policy), qb);
  await rf('eventRequestRefund', 'buyer1', { orderId: 'ORDRB1', reasonCode: 'cannot_attend', answers: {}, amountKES: 1, refundCents: 1 });
  ck('B the canonical refund authority is asked for the PRINCIPAL (1,700) — a forged client amount is ignored', ((await get('fosRefundQueue/ref_ORDRB1')) || {}).amountCents === 170000 && (await get('eventRefundRequests/ORDRB1')).refundCents === 170000);
  const setB0 = await get('eventSettlements/ORDRB1');
  await settle('ORDRB1', 170000);
  const setB = await get('eventSettlements/ORDRB1');
  ck('B the approved partial is honoured (not an exception): tickets refunded', (await get('eventTickets/ORDRB1_k0')).status === 'refunded' && !(await get('eventExceptions/partial_refund_ORDRB1')));
  ck(`B the penalty stays the organizer's: settlement recomputed on KES 300, ticket-rate (${TPCT} %) commission re-based`, setB.status === 'HELD' && setB.grossCents === 30000 && setB.originalGrossCents === setB0.grossCents
    && setB.retainedPenaltyCents === 30000 && setB.commissionCents === Math.round((30000 - Math.min(30000, setB0.providerFeeCents)) * TPCT / 100), setB);
  const rB = await get(`eventFiscalReversals/${FISCAL.executionIdFor('ORDRB1', 'ORDRB1')}`);
  ck('B credit note reverses the APPROVED principal only (1,700) — not the penalty, gross, commission or fee',
    rB.refundCents === 170000 && rB.penaltyCents === 30000 && Math.abs(creditNotesOf((await get('eventFiscal/ORDRB1')).invoiceId)[0].totals.totAmt) === 1700);
  await mkEvent('evPct', { policy: { mode: 'before_cutoff', cutoffAt: new Date(NOW + 48 * H).toISOString(), noShowRefund: false, penalty: { type: 'percent', value: 20 }, version: 1 } });
  await paid('ORDRC1', 'evPct'); await kraAcceptsSale('ORDRC1', 'RCPT-ORDRC1');
  const qc = await rf('eventRefundQuote', 'buyer1', { orderId: 'ORDRC1', reasonCode: 'cannot_attend', answers: {} });
  ck('C quote: 20 % penalty → 400 kept, 1,600 refunded', qc.penaltyKes === 400 && qc.refundKes === 1600);
  await rf('eventRequestRefund', 'buyer1', { orderId: 'ORDRC1', reasonCode: 'cannot_attend', answers: {} }); await settle('ORDRC1', 160000);
  ck('C credit note for 1,600 linked to the original', (await get(`eventFiscalReversals/${FISCAL.executionIdFor('ORDRC1', 'ORDRC1')}`)).refundCents === 160000);
  ck('an organizer-side reason never carries a penalty (event cancelled → full)', RF.amountsFor({ penalty: { type: 'percent', value: 20 } }, { basis: 'organizer' }, 200000).penaltyCents === 0
    && RF.amountsFor({ penalty: { type: 'fixed', value: 300 } }, { basis: 'payment' }, 200000).penaltyCents === 0);
  ck('policy validation: percent 1–50, fixed > 0, unknown type refused', (await code(rf('eventSetRefundPolicy', 'org1', { eventId: 'evR', mode: 'none', penalty: { type: 'percent', value: 80 } }))) !== null
    && (await code(rf('eventSetRefundPolicy', 'org1', { eventId: 'evR', mode: 'none', penalty: { type: 'bribe', value: 1 } }))) !== null);

  say('\n── D. no-show ──');
  await mkEvent('evNS', { policy: { mode: 'none', noShowRefund: true, penalty: { type: 'percent', value: 10 }, version: 2 }, startMs: NOW - 30 * H });
  await paid('ORDRD1', 'evNS'); await kraAcceptsSale('ORDRD1', 'RCPT-ORDRD1');
  const qd = await rf('eventRefundQuote', 'buyer1', { orderId: 'ORDRD1', reasonCode: 'did_not_attend', answers: { attended: 'no', confirmUnused: true } });
  ck('D no-show eligible (not admitted, window open) with the 10 % penalty', qd.eligible === 'YES' && qd.refundKes === 1800 && qd.policyVersion === 2);
  await rf('eventRequestRefund', 'buyer1', { orderId: 'ORDRD1', reasonCode: 'did_not_attend', answers: { attended: 'no', confirmUnused: true } }); await settle('ORDRD1', 180000);
  ck('D credit note for the no-show principal', (await get(`eventFiscalReversals/${FISCAL.executionIdFor('ORDRD1', 'ORDRD1')}`)).refundCents === 180000);

  say('\n── E. event cancellation (bulk) ──');
  await mkEvent('evC', { policy: { mode: 'none', noShowRefund: false, penalty: { type: 'fixed', value: 500 }, version: 1 } });
  await paid('ORDRE1', 'evC', { buyer: 'b1' }); await kraAcceptsSale('ORDRE1', 'RCPT-ORDRE1');
  await paid('ORDRE2', 'evC', { buyer: 'b2' });                      /* its invoice is still queued */
  await EH.cancelEvent.run({ ...who('org1'), data: { eventId: 'evC', reason: 'Venue flooded — cannot proceed' } });
  await settle('ORDRE1', 200000); await settle('ORDRE2', 200000);
  const cE1 = await get('eventRefundRequests/ORDRE1');
  ck('E an AdminOS (cancellation) refund gets a refund case: event_cancelled, organizer basis, NO penalty, full principal', cE1 && cE1.reasonCode === 'event_cancelled' && cE1.penaltyCents === 0 && cE1.refundCents === 200000 && cE1.source === 'admin_refund');
  ck('E each cancelled order → its own credit note linked to its own original', (await get(`eventFiscalReversals/${FISCAL.executionIdFor('ORDRE1', 'ORDRE1')}`)).status === 'CREDIT_NOTE_PENDING'
    && (await get(`eventFiscalReversals/${FISCAL.executionIdFor('ORDRE2', 'ORDRE2')}`)).fiscalRecordId === 'ORDRE2');
  const rE2 = await get(`eventFiscalReversals/${FISCAL.executionIdFor('ORDRE2', 'ORDRE2')}`);
  ck('E an original not yet accepted by KRA: the credit note WAITS (REQUIRED), nothing reversed against nothing', rE2.status === 'CREDIT_NOTE_REQUIRED' && rE2.waitingFor === 'ORIGINAL_INVOICE_ACCEPTANCE' && !rE2.creditNoteDocId);
  await kraAcceptsSale('ORDRE2', 'RCPT-ORDRE2');
  NOW += 20 * 60 * 1000; await FISCAL.sweep(NOW);
  ck('E once the original is accepted, the sweep executes it', (await get(`eventFiscalReversals/${FISCAL.executionIdFor('ORDRE2', 'ORDRE2')}`)).status === 'CREDIT_NOTE_PENDING');

  say('\n── F. refund after admission ──');
  await mkEvent('evA', { startMs: NOW + 3 * H });
  await paid('ORDRF1', 'evA'); await kraAcceptsSale('ORDRF1', 'RCPT-ORDRF1');
  await db.doc('eventTickets/ORDRF1_k0').set({ admissionStatus: 'ADMITTED' }, { merge: true });
  ck('F change of plans after admission → refused by the policy; NO credit note', (await code(rf('eventRequestRefund', 'buyer1', { orderId: 'ORDRF1', reasonCode: 'cannot_attend', answers: {} }))) === 'failed-precondition' && revsOf('ORDRF1').length === 0);

  say('\n── G. refund after the organizer was paid ──');
  await mkEvent('evG', { policy: { mode: 'none', noShowRefund: false, penalty: { type: 'none' }, version: 1 }, startMs: NOW - 60 * H });
  await paid('ORDRG1', 'evG'); await kraAcceptsSale('ORDRG1', 'RCPT-ORDRG1');
  const rel = await ES.releaseOne('ORDRG1', { nowMs: NOW + 1 * H });
  await settle('ORDRG1', 200000);
  ck('G settlement already RELEASED → a human exception (no silent wallet debit) — and the credit note is still owed', rel.released === true
    && ((await get('eventExceptions/refund_after_release_ORDRG1')) || {}).status === 'OPEN' && (await get(`eventFiscalReversals/${FISCAL.executionIdFor('ORDRG1', 'ORDRG1')}`)).status === 'CREDIT_NOTE_PENDING');

  say('\n── I. no fake credit notes ──');
  await paid('ORDRI1', 'evU', { org: 'org2' }); await settle('ORDRI1', 200000);
  ck('I organizer not on eTIMS → refund settles, NO credit note', (await get('eventTickets/ORDRI1_k0')).status === 'refunded' && revsOf('ORDRI1').length === 0);
  await paid('ORDRI2', 'evR'); await db.doc('eventFiscal/ORDRI2').delete(); await settle('ORDRI2', 200000);
  ck('I fiscal record never existed → NO credit note (NO_FISCAL_RECORD)', revsOf('ORDRI2').length === 0 && (await FISCAL.requireCreditNote({ fiscalRecordId: 'ORDRI2', refundCaseId: 'ORDRI2', refundCents: 1 })).skipped === 'NO_FISCAL_RECORD');
  await db.doc('eventOrders/ORDRI3').set({ orderId: 'ORDRI3', buyerUid: 'buyer1', eventId: 'evR', quantity: 1, totalAmount: 1000, status: 'pending_payment', paymentRef: null });
  ck('I unpaid ticket → cannot be refunded, NO fiscal record, NO credit note', (await code(rf('eventRequestRefund', 'buyer1', { orderId: 'ORDRI3', reasonCode: 'cannot_attend', answers: {} }))) !== null && !(await get('eventFiscal/ORDRI3')) && revsOf('ORDRI3').length === 0);
  await db.doc('eventOrders/ORDRI4').set({ orderId: 'ORDRI4', buyerUid: 'buyer1', eventId: 'evR', tierId: 'evR_t', quantity: 1, totalAmount: 1000, status: 'pending_payment', createdAt: F.Timestamp.fromMillis(NOW - 2 * H) });
  await ES.expireOne('ORDRI4', { nowMs: NOW });
  ck('I cancelled (expired) before payment → NO fiscal record, NO credit note', !(await get('eventFiscal/ORDRI4')) && revsOf('ORDRI4').length === 0);
  await paid('ORDRI5', 'evR'); await kraAcceptsSale('ORDRI5', 'RCPT-ORDRI5');
  await rf('eventRequestRefund', 'buyer1', { orderId: 'ORDRI5', reasonCode: 'cannot_attend', answers: {} });
  await ES.onEventRefundRejected({ payRef: 'ORDRI5', refundId: 'ref_ORDRI5', reason: 'Not eligible after review' });
  ck('I refund rejected → NO credit note; ticket usable again', revsOf('ORDRI5').length === 0 && (await get('eventTickets/ORDRI5_k0')).refundStatus === 'NONE');
  ck('I a mismatched partial (not the approved principal) is an exception: no revoke, NO credit note',
    await (async () => { await paid('ORDRI6', 'evR'); await kraAcceptsSale('ORDRI6', 'RCPT-ORDRI6'); await settle('ORDRI6', 50000); return !!(await get('eventExceptions/partial_refund_ORDRI6')) && revsOf('ORDRI6').length === 0 && (await get('eventTickets/ORDRI6_k0')).status === 'valid'; })());

  say('\n── idempotency ──');
  await settle('ORDRA1', 200000);
  ck('replayed refund-settled hook → still ONE credit note, ONE lifecycle document', revsOf('ORDRA1').length === 1 && creditNotesOf((await get('eventFiscal/ORDRA1')).invoiceId).length === 1);
  await paid('ORDID1', 'evR'); await kraAcceptsSale('ORDID1', 'RCPT-ORDID1');
  const cnReq = await FISCAL.requireCreditNote({ fiscalRecordId: 'ORDID1', refundCaseId: 'ORDID1', refundCents: 200000 });
  const race = await Promise.all([FISCAL.executeCreditNote(cnReq.executionId), FISCAL.executeCreditNote(cnReq.executionId), FISCAL.executeCreditNote(cnReq.executionId)]);
  const idInv = (await get('eventFiscal/ORDID1')).invoiceId;
  ck('3 concurrent executions → ONE execution, ONE credit note, ONE transmission entry', race.filter((r) => r.pending).length === 1 && creditNotesOf(idInv).length === 1
    && db._dump('etimsTransmissionQueue/').filter((q) => q.origInvoiceId === idInv).length === 1, race);
  ck('re-execution after PENDING does nothing (browser refresh / replay)', (await FISCAL.executeCreditNote(cnReq.executionId)).skipped === 'not_claimable' && creditNotesOf(idInv).length === 1);
  ck('a second refund request for the same order is refused (no duplicate case)', (await code(rf('eventRequestRefund', 'buyer1', { orderId: 'ORDRB1', reasonCode: 'cannot_attend', answers: {} }))) !== null);
  const exSrc = fs.readFileSync(Path.join(FN, 'event-fiscal.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  ck('the execution identity is derived — never a clock, random or client id', /createHash\('sha256'\)\.update\(`evtcn\|/.test(exSrc) && !/executionId\s*=\s*[^;]*(Date\.now|Math\.random|randomBytes)/.test(exSrc));

  say('\n── provider outcomes (single server ingress) ──');
  const exId = cnReq.executionId;
  ck('timeout → CREDIT_NOTE_OUTCOME_UNKNOWN (never assumed)', (await FISCAL.recordCreditNoteOutcome(exId, { kind: 'timeout' })).outcome === 'UNKNOWN' && (await get(`eventFiscalReversals/${exId}`)).status === 'CREDIT_NOTE_OUTCOME_UNKNOWN');
  ck('an unknown outcome is NOT retried blindly (AdminOS retry refused)', (await code(adm('eventAdminCreditNoteRetry', { executionId: exId }))) === 'failed-precondition' && creditNotesOf(idInv).length === 1);
  ck('…an ordinary admin cannot resolve it', (await code(adm('eventAdminCreditNoteResolve', { executionId: exId, resolution: 'NOT_ACCEPTED', evidence: 'KRA ticket 12345 says nothing received' }))) === 'permission-denied');
  ck('…nobody can resolve it as ACCEPTED (acceptance comes from KRA alone)', (await code(adm('eventAdminCreditNoteResolve', { executionId: exId, resolution: 'ACCEPTED', evidence: 'trust me, it went through', creditNoteReference: 'FAKE-1' }, SUPER))) === 'invalid-argument');
  ck('…nor without evidence', (await code(adm('eventAdminCreditNoteResolve', { executionId: exId, resolution: 'NOT_ACCEPTED', evidence: '' }, SUPER))) === 'invalid-argument');
  await adm('eventAdminCreditNoteResolve', { executionId: exId, resolution: 'NOT_ACCEPTED', evidence: 'KRA support ticket KRA-SR-7781: no credit note received' }, SUPER);
  ck('super admin + evidence → FAILED (retryable), evidence recorded + audited', (await get(`eventFiscalReversals/${exId}`)).status === 'CREDIT_NOTE_FAILED'
    && (await get(`eventFiscalReversals/${exId}`)).evidence.text.includes('KRA-SR-7781') && db._dump('adminAudit/').some((a) => a.action === 'event_credit_note_resolved'));
  await adm('eventAdminCreditNoteRetry', { executionId: exId, creditNoteReference: 'FAKE-CN-1', status: 'CREDIT_NOTE_ACCEPTED' });
  const afterRetry = await get(`eventFiscalReversals/${exId}`);
  ck('AdminOS retry after failure → PENDING on the SAME credit note; forged reference / status ignored', afterRetry.status === 'CREDIT_NOTE_PENDING' && afterRetry.creditNoteReference === null && creditNotesOf(idInv).length === 1);
  ck('HTTP 5xx → UNKNOWN', (await FISCAL.recordCreditNoteOutcome(exId, { kind: 'response', httpStatus: 503, body: {} })).outcome === 'UNKNOWN');
  await adm('eventAdminCreditNoteResolve', { executionId: exId, resolution: 'NOT_ACCEPTED', evidence: 'KRA support ticket KRA-SR-7782: nothing received' }, SUPER);
  await adm('eventAdminCreditNoteRetry', { executionId: exId });
  ck('definitive rejection (resultCd ≠ 000) → CREDIT_NOTE_FAILED with the provider reason', (await FISCAL.recordCreditNoteOutcome(exId, { kind: 'response', httpStatus: 200, body: { resultCd: '901', resultMsg: 'Original invoice not found' } })).outcome === 'REJECTED'
    && (await get(`eventFiscalReversals/${exId}`)).failureReason === 'Original invoice not found');
  await adm('eventAdminCreditNoteRetry', { executionId: exId });
  ck('"000" WITHOUT a reference → UNKNOWN (no invented number)', (await FISCAL.recordCreditNoteOutcome(exId, { kind: 'response', httpStatus: 200, body: { resultCd: '000', data: {} } })).outcome === 'UNKNOWN' && (await get(`eventFiscalReversals/${exId}`)).creditNoteReference === null);
  await adm('eventAdminCreditNoteResolve', { executionId: exId, resolution: 'NOT_ACCEPTED', evidence: 'KRA support ticket KRA-SR-7783: nothing received' }, SUPER);
  await adm('eventAdminCreditNoteRetry', { executionId: exId });
  await FISCAL.recordCreditNoteOutcome(exId, ok('CN-KRA-000777'));
  const acc = await get(`eventFiscalReversals/${exId}`);
  ck('accepted → CREDIT_NOTE_ACCEPTED with ONLY the provider-returned reference + https QR', acc.status === 'CREDIT_NOTE_ACCEPTED' && acc.creditNoteReference === 'CN-KRA-000777' && acc.creditNoteQr === 'https://etims.kra.go.ke/cn/CN-KRA-000777.png');
  ck('ACCEPTED is terminal: a later (replayed / contradictory) answer changes nothing', (await FISCAL.recordCreditNoteOutcome(exId, { kind: 'timeout' })).skipped === 'status_CREDIT_NOTE_ACCEPTED' && (await get(`eventFiscalReversals/${exId}`)).status === 'CREDIT_NOTE_ACCEPTED');
  ck('every transition is in the audit history', acc.history.map((h) => h.to).join('>') === 'CREDIT_NOTE_REQUIRED>CREDIT_NOTE_PENDING>CREDIT_NOTE_OUTCOME_UNKNOWN>CREDIT_NOTE_FAILED>CREDIT_NOTE_PENDING>CREDIT_NOTE_OUTCOME_UNKNOWN>CREDIT_NOTE_FAILED>CREDIT_NOTE_PENDING>CREDIT_NOTE_FAILED>CREDIT_NOTE_PENDING>CREDIT_NOTE_OUTCOME_UNKNOWN>CREDIT_NOTE_FAILED>CREDIT_NOTE_PENDING>CREDIT_NOTE_ACCEPTED', acc.history.map((h) => h.to).join('>'));
  ck('the original receipt is still the original (credit note never replaces it)', (await view('ORDID1')).receiptNumber === 'RCPT-ORDID1' && (await view('ORDID1')).creditNotes[0].creditNoteReference === 'CN-KRA-000777');

  say('\n── security boundaries ──');
  const clientOps = Object.keys(OPS._h).concat(Object.keys(SALES._h), Object.keys(RF._h));
  ck('no client (event-day / buyer) operation can touch fiscal state, receipts or credit notes', !clientOps.some((n) => /fiscal|credit|receipt|kra|etims/i.test(n)), clientOps.join(','));
  ck('no AdminOS operation can set a receipt / reference or mark anything accepted',
    !/creditNoteReference\s*:\s*d\.|receiptNumber\s*:\s*d\.|CREDIT_NOTE_ACCEPTED|FISCAL_ACCEPTED'\s*\}/.test(fs.readFileSync(Path.join(FN, 'event-admin.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/'FISCAL_ACCEPTED'\s*\|\||v\.fiscalStatus === 'FISCAL_ACCEPTED'|c\.status !== 'CREDIT_NOTE_ACCEPTED'|v\.fiscalStatus !== 'FISCAL_ACCEPTED'/g, '')));
  const fsSaleBefore = await snap('ORDFS1');
  await adm('eventAdminFiscalRetry', { saleKey: 'ORDFS2', receiptNumber: 'FAKE-RCPT', status: 'accepted' }).catch(() => null);
  const fs2inv = await get(`etimsInvoices/${(await get('eventFiscal/ORDFS2')).invoiceId}`);
  ck('forged receipt number through the fiscal retry → ignored (requeue only; receipt still null)', fs2inv.receiptNumber === null && fs2inv.status === 'pending_submission');
  ck('fiscal retry refused for an ACCEPTED sale (no re-submission of an accepted invoice)', (await code(adm('eventAdminFiscalRetry', { saleKey: 'ORDFS1' }))) === 'failed-precondition' && (await snap('ORDFS1')) === fsSaleBefore);
  ck('fiscal retry refused while the invoice is still queued (no double transmission)', (await code(adm('eventAdminFiscalRetry', { saleKey: 'ORDFS2' }))) === 'failed-precondition');
  const fisSrc = fs.readFileSync(Path.join(FN, 'event-fiscal.js'), 'utf8');
  ck('event-fiscal makes NO provider call (no http client) — transmission belongs to the eTIMS queue', !/require\(['"]https?['"]\)|fetch\(|axios/.test(fisSrc));
  ck('recordCreditNoteOutcome is not exposed as an operation anywhere', !Object.keys(EA._adminH).concat(clientOps).some((n) => /outcome/i.test(n)));

  say('\n── display + trace ──');
  const mt = (await EH.getMyTickets.run({ ...who('buyer1'), data: {} })).tickets.find((t) => t.ticketId === 'ORDRA1_k0');
  ck('refunded ticket: no PIN, no QR; the ORIGINAL receipt still shown; the credit note separately', mt.pin === null && mt.qrData === null && mt.fiscal.receiptNumber === 'RCPT-ORDRA1' && mt.fiscal.creditNotes.length === 1);
  const html = TICKET.fiscalHtml(mt.fiscal);
  ck('ticket HTML: original KRA receipt + a SEPARATE "KRA CREDIT NOTE" block, no invented reference', /KRA receipt: <b>RCPT-ORDRA1<\/b>/.test(html) && /KRA CREDIT NOTE/.test(html) && /KRA credit note pending/.test(html) && !/Credit note: <b>/.test(html));
  const htmlAcc = TICKET.fiscalHtml((await FISCAL.viewsFor(['ORDID1'])).ORDID1);
  ck('accepted credit note shown with the provider reference', /Credit note: <b>CN-KRA-000777<\/b>/.test(htmlAcc) && /KRA receipt: <b>RCPT-ORDID1<\/b>/.test(htmlAcc));
  ck('unregistered organizer → "Organizer is not registered for eTIMS"', /Organizer is not registered for eTIMS/.test(TICKET.fiscalHtml(await view('ORDFS3'))));
  await db.doc(`etimsInvoices/${(await get('eventFiscal/ORDFS2')).invoiceId}`).set({ status: 'failed' }, { merge: true });   /* the retry above re-queued it */
  ck('failed fiscal → neutral words, no receipt', /reconciling/.test(TICKET.fiscalHtml(await view('ORDFS2'))) && !/KRA receipt/.test(TICKET.fiscalHtml(await view('ORDFS2'))));
  const tr = await adm('eventAdminTrace', { orderId: 'ORDRB1' });
  const st = (n) => tr.stages.find((x) => x.stage === n);
  ck('AdminOS trace: payment → fiscal (original receipt) → proceeds (penalty kept) → fiscal_reversal (credit note) → refund (case w/ penalty + policy version)',
    st('payment').state === 'observed' && st('fiscal').record.receiptNumber === 'RCPT-ORDRB1' && st('organizer_proceeds').record.retainedPenaltyCents === 30000
    && st('fiscal_reversal').state === 'observed' && st('fiscal_reversal').record[0].refundCents === 170000 && st('refund').record.request.penaltyCents === 30000 && st('refund').record.request.policyVersion === 1);
  const q = await adm('eventAdminFiscal', { view: 'CREDIT_NOTE_PENDING' });
  ck('AdminOS fiscal queue filters by credit-note state', q.fiscal.some((r) => r.saleKey === 'ORDRA1') && !q.fiscal.some((r) => r.saleKey === 'ORDID1'));
  const qs = await adm('eventAdminInvestigate', { by: 'fiscalStatus', value: 'CREDIT_NOTE_ACCEPTED' });
  ck('AdminOS search by credit-note state', qs.fiscal.some((r) => r.saleKey === 'ORDID1'));

  say(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { say('CRASH ' + (e && e.stack || e)); process.exit(2); });
