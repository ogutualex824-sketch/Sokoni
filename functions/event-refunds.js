'use strict';
/**
 * SOKONI — Event refund policy, eligibility and the Refund Request Wizard's server side.
 * ============================================================================================
 * No one-click refunds. A buyer REQUESTS a refund: a controlled reason (shared/event-refund-reasons),
 * reason-specific answers, then an eligibility check computed HERE from canonical state —
 *   ticket.status · ticket.admissionStatus · ticket.refundStatus · event.refundPolicy · event status/dates
 * — never from what the client says happened. An ineligible request is refused with the reason and
 * cannot be forced. An eligible (or admin-review) request goes to the CANONICAL refund authority —
 * financial-os `fosSubmitRefund`'s own handler (buyer must own the payment, one request per
 * transaction, admin review before any provider call). No parallel refund rail, no executor here.
 *
 *   policy.mode        'none' (no buyer-side refunds) | 'before_cutoff'
 *   policy.cutoffAt    ISO time after which buyer-side refunds close
 *   policy.noShowRefund  a ticket that was NOT admitted may be refunded after the event
 * The organizer sets the policy BEFORE sales; it is locked once a ticket is sold (buyers bought
 * under it). publishEvent requires it.
 *
 * Ticket refund states: NONE → REQUESTED → REFUNDED, or back to NONE when the request is rejected.
 * A REQUESTED ticket cannot be admitted (event-ops); an ADMITTED ticket is never a no-show.
 * Penalty / fee retention: NOT implemented — an UNDECIDED owner + legal decision (published pages
 * promise full refunds). The request is for the full order.
 */
const { HttpsError } = require('firebase-functions/v2/https');
const logger = require('firebase-functions/logger');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const OPS = require('./event-ops');
const REASONS = require('./shared/event-refund-reasons');

const _db = () => getFirestore();
const fail = (code, msg) => { throw new HttpsError(code, msg); };
let _now = () => Date.now();
const _ms = (v) => { if (!v) return null; if (typeof v.toMillis === 'function') return v.toMillis(); const t = new Date(v).getTime(); return Number.isFinite(t) ? t : null; };

const MODES = Object.freeze(['none', 'before_cutoff']);
/* No-show refunds may be requested for this long after the event ends. */
const NO_SHOW_WINDOW_MS = 14 * 24 * 3600 * 1000;

/* ═══ policy ═══════════════════════════════════════════════════════════════════════════════ */
async function setPolicy(req) {
  const d = req.data || {};
  const actor = await OPS.resolveEventActor(req, d.eventId, OPS.CAPS.MANAGE_EVENT);
  const mode = String(d.mode || '');
  if (!MODES.includes(mode)) fail('invalid-argument', `Refund policy must be one of: ${MODES.join(', ')}.`);
  const startMs = _ms(actor.event.startDate);
  let cutoffMs = null;
  if (mode === 'before_cutoff') {
    cutoffMs = _ms(d.cutoffAt);
    if (cutoffMs == null) fail('invalid-argument', 'Set the refund deadline.');
    if (startMs != null && cutoffMs > startMs) fail('invalid-argument', 'The refund deadline must be before the event starts.');
  }
  const policy = { mode, cutoffAt: cutoffMs == null ? null : new Date(cutoffMs).toISOString(), noShowRefund: d.noShowRefund === true };
  const ref = _db().collection('events').doc(actor.event.id);
  await _db().runTransaction(async (txn) => {
    const ev = (await txn.get(ref)).data();
    if ((Number(ev.totalTicketsSold) || 0) > 0) fail('failed-precondition', 'The refund policy is locked: tickets have been sold under it.');
    txn.update(ref, { refundPolicy: { ...policy, version: ((ev.refundPolicy && ev.refundPolicy.version) || 0) + 1, setBy: actor.uid, setAt: new Date(_now()).toISOString() }, updatedAt: FieldValue.serverTimestamp() });
  });
  return { ok: true, policy };
}

/* ═══ eligibility ══════════════════════════════════════════════════════════════════════════ */
function describePolicy(p) {
  if (!p || p.mode === 'none') return p && p.noShowRefund ? 'No refunds, except no-show refunds after the event' : 'No refunds';
  return `Refunds until ${new Date(p.cutoffAt).toLocaleString('en-KE')}${p.noShowRefund ? ', and no-show refunds after the event' : ''}`;
}

/**
 * The eligibility decision. Pure over its inputs — the suite drives it directly.
 * @returns {{ eligible:'YES'|'NO'|'REVIEW', why:string }}
 */
function decide({ reason, event, order, tickets, nowMs, answers = {}, otherOrder = null }) {
  const p = event.refundPolicy || { mode: 'none', noShowRefund: false };
  const valid = tickets.filter((t) => t.status === 'valid');
  const admitted = valid.filter((t) => (t.admissionStatus || 'NOT_ADMITTED') === 'ADMITTED');
  const endMs = OPS.eventEndMs(event);
  if (!['paid', 'pending_refund'].includes(order.status)) return { eligible: 'NO', why: `This order is ${order.status}.` };
  if (!valid.length) return { eligible: 'NO', why: 'None of these tickets is refundable (already refunded or not issued).' };
  if (tickets.some((t) => ['REQUESTED', 'APPROVED', 'REFUNDED'].includes(t.refundStatus))) return { eligible: 'NO', why: 'A refund has already been requested for this order.' };

  if (reason.basis === 'organizer') {
    if (event.status === 'cancelled') return { eligible: 'YES', why: 'The event was cancelled.' };
    if (reason.code === 'event_cancelled') return { eligible: 'NO', why: 'This event has not been cancelled.' };
    return { eligible: 'REVIEW', why: 'An administrator will review the change to the event.' };
  }
  if (reason.basis === 'policy') {
    if (admitted.length) return { eligible: 'NO', why: 'A ticket in this order was already used to enter the event.' };
    if (p.mode !== 'before_cutoff') return { eligible: 'NO', why: 'This event does not offer refunds for a change of plans.' };
    if (nowMs >= _ms(p.cutoffAt)) return { eligible: 'NO', why: `The refund deadline passed on ${new Date(p.cutoffAt).toLocaleString('en-KE')}.` };
    return { eligible: 'YES', why: 'Within the event\'s refund deadline.' };
  }
  if (reason.basis === 'no_show') {
    if (!p.noShowRefund) return { eligible: 'NO', why: 'This event does not offer no-show refunds.' };
    if (endMs == null || nowMs < endMs) return { eligible: 'NO', why: 'No-show refunds open after the event has ended.' };
    if (nowMs > endMs + NO_SHOW_WINDOW_MS) return { eligible: 'NO', why: 'The no-show refund window (14 days after the event) has closed.' };
    if (admitted.length) return { eligible: 'NO', why: 'A ticket in this order was used to enter the event — it is not a no-show.' };
    return { eligible: 'YES', why: 'No ticket in this order was admitted, and the event allows no-show refunds.' };
  }
  /* payment basis */
  if (reason.code === 'duplicate_purchase') {
    if (!otherOrder || otherOrder.buyerUid !== order.buyerUid || otherOrder.eventId !== order.eventId || otherOrder.status !== 'paid' || otherOrder.orderId === order.orderId) {
      return { eligible: 'NO', why: 'We could not find a matching earlier order of yours for this event.' };
    }
    return { eligible: 'REVIEW', why: 'Duplicate orders are checked by an administrator.' };
  }
  return { eligible: 'REVIEW', why: 'An administrator will review this request.' };
}

async function _load(uid, orderId) {
  if (!/^[A-Za-z0-9_-]{6,128}$/.test(String(orderId || ''))) fail('invalid-argument', 'orderId is invalid.');
  const oSnap = await _db().collection('eventOrders').doc(String(orderId)).get();
  if (!oSnap.exists) fail('not-found', 'Order not found.');
  const order = { orderId: oSnap.id, ...oSnap.data() };
  if (order.buyerUid !== uid || order.channel === 'cashier') fail('permission-denied', 'This order is not yours to refund.');
  if (!order.paymentRef) fail('failed-precondition', 'This order has no online payment to refund.');
  const [evSnap, tSnap] = await Promise.all([
    _db().collection('events').doc(String(order.eventId)).get(),
    _db().collection('eventTickets').where('orderId', '==', order.orderId).limit(100).get(),
  ]);
  if (!evSnap.exists) fail('not-found', 'Event not found.');
  return { order, event: { id: evSnap.id, ...evSnap.data() }, tickets: tSnap.docs.map((d) => ({ ticketId: d.id, ...d.data() })) };
}

async function _decideFor(uid, d) {
  const reason = REASONS.get(d.reasonCode);
  if (!reason) fail('invalid-argument', 'Choose a reason from the list.');
  const ctx = await _load(uid, d.orderId);
  let otherOrder = null;
  if (reason.code === 'duplicate_purchase' && d.answers && d.answers.otherOrderId) {
    const s = await _db().collection('eventOrders').doc(String(d.answers.otherOrderId).slice(0, 128) || '_').get();
    otherOrder = s.exists ? { orderId: s.id, ...s.data() } : null;
  }
  const verdict = decide({ reason, ...ctx, nowMs: _now(), answers: d.answers || {}, otherOrder });
  return { reason, ...ctx, verdict };
}

/* ═══ wizard: quote ═════════════════════════════════════════════════════════════════════════ */
async function quote(req) {
  if (!req.auth || !req.auth.uid) fail('unauthenticated', 'Sign in required.');
  const d = req.data || {};
  const { reason, order, event, tickets, verdict } = await _decideFor(req.auth.uid, d);
  const p = event.refundPolicy || { mode: 'none' };
  return {
    orderId: order.orderId, reason: { code: reason.code, label: reason.label, questions: reason.questions, explain: reason.explain },
    amountKes: Number(order.totalAmount) || 0, ticketCount: tickets.length,
    policy: describePolicy(p), eventTitle: event.title || null, eventDate: event.startDate || null,
    refundDeadline: p.cutoffAt || null, eventStatus: event.status,
    tickets: tickets.map((t) => ({ ticketNumber: t.ticketNumber || null, status: t.status, admissionStatus: t.admissionStatus || 'NOT_ADMITTED', refundStatus: t.refundStatus || 'NONE' })),
    eligible: verdict.eligible, why: verdict.why,
  };
}

/* ═══ wizard: request ═══════════════════════════════════════════════════════════════════════ */
async function request(req) {
  if (!req.auth || !req.auth.uid) fail('unauthenticated', 'Sign in required.');
  const uid = req.auth.uid;
  const d = req.data || {};
  const problem = REASONS.answersProblem(d.reasonCode, d.answers || {}, d.explanation);
  if (problem) fail('invalid-argument', problem);
  const { reason, order, event, tickets, verdict } = await _decideFor(uid, d);
  if (verdict.eligible === 'NO') fail('failed-precondition', verdict.why);

  const db = _db();
  const reqRef = db.collection('eventRefundRequests').doc(order.orderId);
  const explanation = String(d.explanation || '').trim().slice(0, 1000);
  const answers = Object.fromEntries(Object.entries(d.answers || {}).slice(0, 10).map(([k, v]) => [String(k).slice(0, 40), String(v).slice(0, 300)]));
  const setSnap = await db.collection('eventSettlements').doc(String(order.paymentRef)).get();
  const settlement = setSnap.exists ? setSnap.data() : {};

  /* Claim the request and mark the tickets REQUESTED together — a second request, or a gate
     admission, sees it at once. */
  await db.runTransaction(async (txn) => {
    const existing = await txn.get(reqRef);
    const tRefs = tickets.map((t) => db.collection('eventTickets').doc(t.ticketId));
    const fresh = await Promise.all(tRefs.map((r) => txn.get(r)));
    if (existing.exists) fail('already-exists', 'A refund has already been requested for this order.');
    if (fresh.some((s) => (s.data().admissionStatus === 'ADMITTED' && reason.basis !== 'organizer') || ['REQUESTED', 'APPROVED', 'REFUNDED'].includes(s.data().refundStatus))) {
      fail('failed-precondition', 'This order changed while you were requesting — please start again.');
    }
    txn.create(reqRef, {
      orderId: order.orderId, eventId: event.id, organizerUid: event.organizerUid || null, buyerUid: uid,
      paymentRef: order.paymentRef, ticketIds: tickets.map((t) => t.ticketId),
      reasonCode: reason.code, reasonLabel: reason.label, reasonBasis: reason.basis, answers, explanation: explanation || null,
      eligibility: verdict.eligible, eligibilityWhy: verdict.why, policySnapshot: event.refundPolicy || { mode: 'none' },
      originalAmountKes: Number(order.totalAmount) || 0, requestedAmountKes: Number(order.totalAmount) || 0,
      commissionCents: settlement.commissionCents == null ? null : settlement.commissionCents,
      providerFeeCents: settlement.providerFeeCents == null ? null : settlement.providerFeeCents,
      status: 'SUBMITTING', requestedBy: uid, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
    });
    fresh.forEach((s) => txn.update(s.ref, { refundStatus: 'REQUESTED', refundRequestedAt: FieldValue.serverTimestamp() }));
  });

  /* Hand to the canonical refund authority AS THE BUYER (its own checks run). */
  const text = `[${reason.code}] ${reason.label}${explanation ? ' — ' + explanation : ''}`.slice(0, 500);
  let fos;
  try {
    fos = await require('./financial-os')._internal.submitRefund({
      ...req, data: { payRef: order.paymentRef, amountKES: Number(order.totalAmount), reason: text, refundType: 'full' },
    });
  } catch (e) {
    /* Compensate: the request never reached the authority — nothing may stay marked REQUESTED. */
    await db.runTransaction(async (txn) => {
      const snaps = await Promise.all(tickets.map((t) => txn.get(db.collection('eventTickets').doc(t.ticketId))));
      txn.delete(reqRef);
      snaps.forEach((s) => { if (s.data().refundStatus === 'REQUESTED') txn.update(s.ref, { refundStatus: 'NONE' }); });
    });
    logger.warn('[eventRefunds] submit refused by the refund authority', { orderId: order.orderId, err: e.message });
    throw e;
  }
  await reqRef.update({ status: fos.existing ? 'DUPLICATE' : 'PENDING_REVIEW', fosRefundId: fos.refundId || null, fosStatus: fos.status || null, updatedAt: FieldValue.serverTimestamp() });
  try {
    await require('./notify').notify({ uid, type: 'event_refund_update', title: 'Refund request received',
      body: `We received your refund request for ${event.title || 'your event'}. An administrator will review it.`,
      dedupeKey: `evt_refund_req:${order.orderId}`, data: { orderId: order.orderId, eventId: event.id } });
  } catch (_) { /* a notice failure never undoes a request */ }
  return { ok: true, orderId: order.orderId, eligibility: verdict.eligible, why: verdict.why, status: 'PENDING_REVIEW' };
}

/* The buyer's own refund requests (wizard history). */
async function myRequests(req) {
  if (!req.auth || !req.auth.uid) fail('unauthenticated', 'Sign in required.');
  const snap = await _db().collection('eventRefundRequests').where('buyerUid', '==', req.auth.uid).limit(50).get();
  return { requests: snap.docs.map((x) => { const r = x.data(); return { orderId: x.id, eventId: r.eventId, reasonLabel: r.reasonLabel, status: r.status, eligibility: r.eligibility, amountKes: r.requestedAmountKes, createdAt: _ms(r.createdAt) }; }) };
}

const _h = { eventSetRefundPolicy: setPolicy, eventRefundQuote: quote, eventRequestRefund: request, eventMyRefundRequests: myRequests };

module.exports = { MODES, NO_SHOW_WINDOW_MS, decide, describePolicy, _h, _setClock: (fn) => { _now = fn || (() => Date.now()); } };
