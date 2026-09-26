/* test-event-refunds.js — Event refund policy, reason catalogue, eligibility and the Refund Request
 * Wizard, end to end through the REAL financial-os refund-request handler. Fake Firestore; no network.
 *
 * PROVES
 *   Policy      organizer sets it; stranger refused; deadline must precede the event; LOCKED once a
 *               ticket sells; publishEvent requires it
 *   Catalogue   controlled reasons; "Other" + blank / "test" / "." refused; required answers enforced;
 *               "did you attend? yes" refuses a no-show claim
 *   Matrix      attended ≠ no-show · no-show only after the event, within 14 days, when allowed ·
 *               cutoff enforced · cancelled event eligible · "event cancelled" on a live event refused ·
 *               organizer-side changes → REVIEW · duplicate needs a real earlier order · payment → REVIEW ·
 *               already requested → refused
 *   Request     eligible → canonical fosRefundQueue request (buyer, pending admin review, reason code
 *               recorded) + tickets REQUESTED + request record (reason, answers, policy, commission,
 *               fee) · the gate refuses a REQUESTED ticket · second request refused · someone else's
 *               order refused · a walk-in (cashier) order refused · INELIGIBLE → nothing submitted
 *   Outcome     refund processed → tickets REFUNDED, request REFUNDED, cannot be admitted, cannot be
 *               refunded twice · rejected → tickets back to NONE (admissible), request REJECTED
 *   Safety      if the refund authority refuses, the wizard compensates (no ticket left REQUESTED)
 *
 *   node scripts/test-event-refunds.js
 */
'use strict';
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:1';
process.env.GCLOUD_PROJECT = 'demo-event-refunds';
process.env.INTASEND_PRIVATE_KEY = 'harness';
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
const stub = (m, exp) => { const p = m.startsWith('./') ? Path.join(FN, m + '.js') : resolveIn(m); require.cache[p] = { id: p, filename: p, loaded: true, exports: exp }; };
stub('firebase-admin/firestore', { getFirestore: () => db, FieldValue: F.FieldValue, Timestamp: F.Timestamp, FieldPath: F.FieldPath });
stub('firebase-admin/auth', { getAuth: () => authApi });
stub('firebase-admin', { apps: [{}], initializeApp: () => ({}), firestore: Object.assign(() => db, { FieldValue: F.FieldValue, Timestamp: F.Timestamp }), auth: () => authApi });
const notices = [];
stub('./notify', { notify: async (n) => { notices.push(n); return { ok: true }; } });

const OPS = require(Path.join(FN, 'event-ops.js'));
const RF = require(Path.join(FN, 'event-refunds.js'));
const ES = require(Path.join(FN, 'event-settlement.js'));
const EH = require(Path.join(FN, 'event-hub.js'));
const RS = require(Path.join(FN, 'shared', 'event-refund-reasons.js'));
OPS._setClock(() => NOW); RF._setClock(() => NOW);
ES.registerPurpose();

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
const op = (name, uid, data = {}) => RF._h[name]({ ...who(uid), data });
const admitAs = async (uid, data) => OPS._h.eventAdmitTicket({ ...who(uid), data: await _confirmed(data) });
async function code(p) { try { await p; return null; } catch (e) { return e.code || e.message; } }
async function msg(p) { try { await p; return null; } catch (e) { return e.message; } }
const get = async (p) => { const s = await db.doc(p).get(); return s.exists ? s.data() : null; };
const H = 3600 * 1000;

async function event(id, { policy, startMs = NOW + 72 * H, status = 'live' } = {}) {
  await db.doc(`events/${id}`).set({ title: 'Show ' + id, organizerUid: 'org1', status, startDate: new Date(startMs).toISOString(), endDate: new Date(startMs + 4 * H).toISOString(), totalTicketsSold: 0, ...(policy ? { refundPolicy: policy } : {}) });
  await db.doc(`eventTicketTiers/${id}_t`).set({ eventId: id, name: 'Regular', price: 1000, quantity: 100, sold: 0, isActive: true, currency: 'KES' });
}
async function paid(orderId, eventId, buyer = 'buyer1', qty = 2) {
  await db.doc(`eventOrders/${orderId}`).set({ orderId, buyerUid: buyer, eventId, tierId: `${eventId}_t`, tierName: 'Regular', quantity: qty, totalAmount: 1000 * qty, currency: 'KES', status: 'pending_payment', createdAt: F.Timestamp.fromMillis(NOW) });
  for (let i = 0; i < qty; i++) await db.doc(`eventTickets/${orderId}_k${i}`).set({ ticketId: `${orderId}_k${i}`, orderId, eventId, buyerUid: buyer, tierName: 'Regular', status: 'awaiting_payment' });
  await db.doc(`paymentIntents/${orderId}`).set({ ref: orderId, purpose: 'event_ticket', resourceType: 'eventOrder', resourceId: orderId, uid: buyer, ownerUid: buyer, amount: 1000 * qty, amountCents: 100000 * qty, currency: 'KES', status: 'created', metadata: { eventId, organizerUid: 'org1' } });
  await db.doc(`payments/${orderId}`).set({ ref: orderId, uid: buyer, amount: 1000 * qty, amountCents: 100000 * qty, currency: 'KES', status: 'COMPLETE', provider: 'intasend', providerReport: { charges: 30 } });
  await ES.activateIfEventTicket(orderId);
}
const reason = (c) => RS.get(c);

(async () => {
  /* ═══ policy ═══ */
  console.log('\n── policy ──');
  await event('evP', { status: 'draft' });
  ck('stranger cannot set the policy', (await code(op('eventSetRefundPolicy', 'x9', { eventId: 'evP', mode: 'none' }))) === 'permission-denied');
  ck('deadline after the event start refused', (await code(op('eventSetRefundPolicy', 'org1', { eventId: 'evP', mode: 'before_cutoff', cutoffAt: new Date(NOW + 80 * H).toISOString() }))) === 'invalid-argument');
  ck('publish without a policy refused', /refund policy/.test(await msg(EH.publishEvent.run({ ...who('org1'), data: { eventId: 'evP' } })) || ''));
  const setp = await op('eventSetRefundPolicy', 'org1', { eventId: 'evP', mode: 'before_cutoff', cutoffAt: new Date(NOW + 48 * H).toISOString(), noShowRefund: true });
  ck('organizer sets: refunds until the deadline + no-show refunds', setp.ok && (await get('events/evP')).refundPolicy.mode === 'before_cutoff' && (await get('events/evP')).refundPolicy.noShowRefund === true);
  await db.doc('events/evP').set({ totalTicketsSold: 1 }, { merge: true });
  ck('LOCKED once a ticket has been sold', (await code(op('eventSetRefundPolicy', 'org1', { eventId: 'evP', mode: 'none' }))) === 'failed-precondition');

  /* ═══ catalogue ═══ */
  console.log('\n── catalogue ──');
  ck('18 controlled reasons in 5 groups', RS.REASONS.length === 18 && Object.keys(RS.groups()).length === 5);
  ck('"Other" with a blank explanation refused', !!RS.answersProblem('other', {}, ''));
  for (const bad of ['test', 'refund', '.', 'none', 'aaaaaaaaaaaaaaaaaaaa', 'short one']) ck(`"Other" with "${bad}" refused`, !!RS.answersProblem('other', {}, bad));
  ck('"Other" with a real explanation accepted', RS.answersProblem('other', {}, 'The organiser moved the gates and I could not get in') === null);
  ck('wrong event requires the intended event', !!RS.answersProblem('wrong_event', {}, '') && RS.answersProblem('wrong_event', { intendedEvent: 'Blankets & Wine' }, '') === null);
  ck('no-show: "did you attend? yes" refuses the claim', /not eligible/.test(RS.answersProblem('did_not_attend', { attended: 'yes', confirmUnused: true }, '') || ''));
  ck('no-show requires confirming the tickets were unused', !!RS.answersProblem('did_not_attend', { attended: 'no' }, ''));
  ck('unknown reason code refused', RS.answersProblem('free_money', {}, '') === 'Choose a reason from the list.');

  /* ═══ eligibility matrix (pure) ═══ */
  console.log('\n── eligibility matrix ──');
  const baseEv = { status: 'live', startDate: new Date(NOW + 72 * H).toISOString(), endDate: new Date(NOW + 76 * H).toISOString(), refundPolicy: { mode: 'before_cutoff', cutoffAt: new Date(NOW + 48 * H).toISOString(), noShowRefund: true } };
  const ord = { orderId: 'Oq', buyerUid: 'b', eventId: 'e', status: 'paid' };
  const T = (adm = 'NOT_ADMITTED', rs = 'NONE') => [{ status: 'valid', admissionStatus: adm, refundStatus: rs }];
  const dec = (r, ev, tk, now = NOW, extra = {}) => RF.decide({ reason: reason(r), event: ev, order: ord, tickets: tk, nowMs: now, ...extra }).eligible;
  ck('change of plans before the deadline → YES', dec('cannot_attend', baseEv, T()) === 'YES');
  ck('change of plans after the deadline → NO', dec('cannot_attend', baseEv, T(), NOW + 50 * H) === 'NO');
  ck('change of plans when the policy is "no refunds" → NO', dec('cannot_attend', { ...baseEv, refundPolicy: { mode: 'none' } }, T()) === 'NO');
  ck('ADMITTED ticket, change of plans → NO', dec('cannot_attend', baseEv, T('ADMITTED')) === 'NO');
  ck('no-show BEFORE the event ends → NO', dec('did_not_attend', baseEv, T(), NOW + 74 * H) === 'NO');
  ck('no-show after the event, not admitted → YES', dec('did_not_attend', baseEv, T(), NOW + 80 * H) === 'YES');
  ck('ADMITTED is never a no-show → NO', dec('did_not_attend', baseEv, T('ADMITTED'), NOW + 80 * H) === 'NO');
  ck('no-show when the event does not allow it → NO', dec('did_not_attend', { ...baseEv, refundPolicy: { ...baseEv.refundPolicy, noShowRefund: false } }, T(), NOW + 80 * H) === 'NO');
  ck('no-show 15 days after the event → NO (window closed)', dec('did_not_attend', baseEv, T(), NOW + 76 * H + 15 * 24 * H) === 'NO');
  ck('event cancelled → YES (even with "no refunds")', dec('event_cancelled', { ...baseEv, status: 'cancelled', refundPolicy: { mode: 'none' } }, T()) === 'YES');
  ck('"event cancelled" claimed on a LIVE event → NO', dec('event_cancelled', baseEv, T()) === 'NO');
  ck('venue changed → REVIEW (admin checks the evidence)', dec('venue_changed', baseEv, T()) === 'REVIEW');
  ck('payment issue → REVIEW', dec('payment_issue', baseEv, T()) === 'REVIEW');
  ck('duplicate purchase without a real earlier order → NO', dec('duplicate_purchase', baseEv, T(), NOW, { otherOrder: null }) === 'NO');
  ck('duplicate purchase with a matching paid order → REVIEW', dec('duplicate_purchase', baseEv, T(), NOW, { otherOrder: { orderId: 'Other', buyerUid: 'b', eventId: 'e', status: 'paid' } }) === 'REVIEW');
  ck('refund already requested → NO', dec('cannot_attend', baseEv, T('NOT_ADMITTED', 'REQUESTED')) === 'NO');
  ck('already REFUNDED → NO (cannot be refunded twice)', dec('event_cancelled', { ...baseEv, status: 'cancelled' }, [{ status: 'refunded', refundStatus: 'REFUNDED' }]) === 'NO');

  /* ═══ the wizard, end to end ═══ */
  console.log('\n── wizard ──');
  await event('evA', { policy: { mode: 'before_cutoff', cutoffAt: new Date(NOW + 48 * H).toISOString(), noShowRefund: true } });
  await paid('ORD0A1', 'evA');
  const q = await op('eventRefundQuote', 'buyer1', { orderId: 'ORD0A1', reasonCode: 'cannot_attend' });
  ck('quote shows amount, policy, deadline, ticket + admission status, and YES', q.amountKes === 2000 && q.eligible === 'YES' && q.refundDeadline && q.tickets.length === 2 && q.tickets.every((t) => t.admissionStatus === 'NOT_ADMITTED'), q.eligible);
  ck("someone else's order refused", (await code(op('eventRefundQuote', 'buyer2', { orderId: 'ORD0A1', reasonCode: 'cannot_attend' }))) === 'permission-denied');
  const rq = await op('eventRequestRefund', 'buyer1', { orderId: 'ORD0A1', reasonCode: 'cannot_attend', answers: {} });
  const fq = await get('fosRefundQueue/ref_ORD0A1');
  ck('eligible → ONE canonical refund request, pending ADMIN review (no provider call)', rq.ok && fq && fq.status === 'pending' && fq.buyerUid === 'buyer1' && /\[cannot_attend\]/.test(fq.reason), fq && fq.status);
  const rr = await get('eventRefundRequests/ORD0A1');
  ck('request record: reason, eligibility, policy snapshot, amount, commission, provider fee', rr.reasonCode === 'cannot_attend' && rr.eligibility === 'YES' && rr.policySnapshot.mode === 'before_cutoff' && rr.originalAmountKes === 2000 && rr.commissionCents != null && rr.providerFeeCents === 3000 && rr.status === 'PENDING_REVIEW');
  ck('tickets marked REQUESTED', (await get('eventTickets/ORD0A1_k0')).refundStatus === 'REQUESTED' && (await get('eventTickets/ORD0A1_k1')).refundStatus === 'REQUESTED');
  ck('the buyer was told (no PIN in the notice)', notices.some((n) => n.type === 'event_refund_update' && n.uid === 'buyer1'));
  const pinA = (await get('eventTicketSecrets/ORD0A1_k0')).pin;
  ck('the gate refuses a ticket with a refund REQUESTED', (await admitAs('org1', { eventId: 'evA', pin: pinA })).result === 'refused');
  ck('a second request for the same order refused', (await code(op('eventRequestRefund', 'buyer1', { orderId: 'ORD0A1', reasonCode: 'cannot_attend', answers: {} }))) === 'failed-precondition');
  /* rejected → tickets back to NONE, admissible again */
  await ES.onEventRefundRejected({ payRef: 'ORD0A1', refundId: 'ref_ORD0A1', reason: 'Not eligible after review' });
  ck('rejected → tickets NONE again, request REJECTED', (await get('eventTickets/ORD0A1_k0')).refundStatus === 'NONE' && (await get('eventRefundRequests/ORD0A1')).status === 'REJECTED');
  ck('…but not before the admission window opens (the PIN is ISSUED, not yet ACTIVE)', /not opened yet/.test((await admitAs('org1', { eventId: 'evA', pin: pinA })).reason || ''));
  { const keep = NOW; NOW = Date.parse((await get('events/evA')).startDate) - H;   /* event day */
    ck('…and on event day the ticket can be admitted again', (await admitAs('org1', { eventId: 'evA', pin: pinA })).result === 'admitted');
    NOW = keep; }

  /* processed → REFUNDED */
  await paid('ORD0B1', 'evA');
  await op('eventRequestRefund', 'buyer1', { orderId: 'ORD0B1', reasonCode: 'accidental_purchase', answers: {}, explanation: 'I tapped buy twice by mistake on my phone' });
  await ES.onEventRefundProcessed({ payRef: 'ORD0B1', refundId: 'ref_ORD0B1', amountCents: 200000, source: 'test' });
  ck('refund processed → tickets REFUNDED, request REFUNDED', (await get('eventTickets/ORD0B1_k0')).refundStatus === 'REFUNDED' && (await get('eventTickets/ORD0B1_k0')).status === 'refunded' && (await get('eventRefundRequests/ORD0B1')).status === 'REFUNDED');
  ck('a refunded ticket cannot be admitted', (await admitAs('org1', { eventId: 'evA', pin: (await get('eventTicketSecrets/ORD0B1_k0')).pin })).result === 'refused');
  ck('a refunded order cannot be refunded again', (await code(op('eventRefundQuote', 'buyer1', { orderId: 'ORD0B1', reasonCode: 'event_cancelled' }))) === null && (await op('eventRefundQuote', 'buyer1', { orderId: 'ORD0B1', reasonCode: 'cannot_attend' })).eligible === 'NO');

  /* ineligible → nothing submitted */
  await event('evN', { policy: { mode: 'none', noShowRefund: false } });
  await paid('ORD0N1', 'evN');
  ck('ineligible request refused with the reason; nothing reaches the refund queue', /does not offer refunds/.test(await msg(op('eventRequestRefund', 'buyer1', { orderId: 'ORD0N1', reasonCode: 'cannot_attend', answers: {} })) || '') && !(await get('fosRefundQueue/ref_ORD0N1')) && (await get('eventTickets/ORD0N1_k0')).refundStatus === 'NONE');

  /* no-show, end to end */
  await event('evS', { policy: { mode: 'none', noShowRefund: true }, startMs: NOW + 1 * H });
  await paid('ORD0S1', 'evS');
  NOW += 10 * H;
  const ns = await op('eventRequestRefund', 'buyer1', { orderId: 'ORD0S1', reasonCode: 'did_not_attend', answers: { attended: 'no', confirmUnused: true } });
  ck('no-show after the event with no admission → eligible, submitted', ns.eligibility === 'YES' && !!(await get('fosRefundQueue/ref_ORD0S1')));

  /* compensation: the authority refuses → nothing stays REQUESTED */
  await event('evC', { policy: { mode: 'before_cutoff', cutoffAt: new Date(NOW + 48 * H).toISOString() } });
  await paid('ORD0C1', 'evC');
  await db.doc('payments/ORD0C1').set({ uid: 'someoneElse' }, { merge: true });   /* authority's buyer check will refuse */
  const cc = await code(op('eventRequestRefund', 'buyer1', { orderId: 'ORD0C1', reasonCode: 'cannot_attend', answers: {} }));
  ck('authority refused → wizard compensates (request removed, tickets NONE)', !!cc && !(await get('eventRefundRequests/ORD0C1')) && (await get('eventTickets/ORD0C1_k0')).refundStatus === 'NONE', cc);

  /* walk-in (cashier) orders are not the requester's to refund */
  await db.doc('eventOrders/ORD0W1').set({ orderId: 'ORD0W1', buyerUid: 'till1', channel: 'cashier', eventId: 'evA', status: 'paid', paymentRef: 'ORD0W1' });
  ck('a cashier-sold walk-in order cannot be refunded through the buyer wizard', (await code(op('eventRefundQuote', 'till1', { orderId: 'ORD0W1', reasonCode: 'cannot_attend' }))) === 'permission-denied');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASH', e && e.stack || e); process.exit(3); });
