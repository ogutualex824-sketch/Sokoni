'use strict';
/**
 * SOKONI — Event ticket fiscalisation (KRA eTIMS), on the ONE existing eTIMS authority.
 * ============================================================================================
 * Every PAID event sale (online, cashier M-PESA, cash, card-on-terminal) gets ONE fiscal record,
 * written in the sale's own transaction:
 *
 *   eventFiscal/{saleKey}   saleKey = the payment reference (online / cashier M-PESA) or the
 *                           sale id (cash / card). Tickets carry both, so a ticket resolves its
 *                           record as paymentRef || saleId — no second identifier is stored.
 *
 * Submission goes through functions/etims.js generateForOrder — the SAME invoice path marketplace
 * orders use — with the organizer as the seller (invoiceAuthority "seller"). It is queued
 * (submitNow:false) and etimsProcessQueue, which holds the eTIMS secrets, transmits and retries.
 *
 * STATES ARE SEPARATE. Payment, ticket, admission and fiscal never gate each other: a ticket is
 * valid when it is PAID, whatever KRA says. The fiscal view a ticket shows is DERIVED at read time
 * from the eTIMS invoice itself, so it can never drift:
 *
 *   CONFIRMED        KRA accepted the invoice — receipt number, and the KRA-supplied QR /
 *                    verification link, exactly as KRA returned them
 *   PENDING          recorded / queued / being retried — "Pending fiscal confirmation"
 *   FAILED           submission errored or KRA rejected after retries → AdminOS reconciliation
 *   NOT_REGISTERED   the organizer has no active eTIMS profile — no fiscal receipt exists
 *   NOT_APPLICABLE   a free ticket (nothing sold)
 *
 * NOTHING IS FABRICATED. No KRA QR, receipt number, control-unit number or signature is ever
 * produced here; SOKONI's own ticket QR is a different thing and is never labelled KRA.
 * A refund marks the record CREDIT_NOTE_REQUIRED when an invoice exists — the credit note itself is
 * issued through the existing eTIMS lifecycle, never faked.
 */
const logger = require('firebase-functions/logger');
const { getFirestore, FieldValue, Timestamp } = require('firebase-admin/firestore');

const _db = () => getFirestore();
let _now = () => Date.now();

const COL = Object.freeze({ FISCAL: 'eventFiscal', INVOICES: 'etimsInvoices' });
const REC = Object.freeze({
  PENDING: 'PENDING', SUBMITTED: 'SUBMITTED', NOT_REGISTERED: 'NOT_REGISTERED',
  SUBMISSION_ERROR: 'SUBMISSION_ERROR', NOT_APPLICABLE: 'NOT_APPLICABLE',
});
const VIEW = Object.freeze({
  CONFIRMED: 'CONFIRMED', PENDING: 'PENDING', FAILED: 'FAILED', NOT_REGISTERED: 'NOT_REGISTERED',
  NOT_APPLICABLE: 'NOT_APPLICABLE', NOT_RECORDED: 'NOT_RECORDED',
});
const CLAIM_MS = 5 * 60 * 1000;         /* a submission in flight is not started twice */
const SWEEP_AFTER_MS = 10 * 60 * 1000;  /* a record left unsubmitted (crash after commit) is picked up */
const MAX_ATTEMPTS = 5;

const _ms = (v) => { if (!v) return null; if (typeof v.toMillis === 'function') return v.toMillis(); const t = new Date(v).getTime(); return Number.isFinite(t) ? t : null; };
const _https = (u) => (typeof u === 'string' && /^https:\/\/[^\s"'<>]+$/.test(u) ? u : null);

/**
 * Record one PAID sale for fiscalisation — call inside the sale's own transaction (a write only).
 * Free sales (grossCents 0) record nothing: there is nothing to fiscalise.
 */
function recordSale(txn, { saleKey, event, channel, orderId = null, saleId = null, lines, grossCents, paymentMethod }) {
  if (!(Number(grossCents) > 0)) return false;
  const clean = (lines || []).map((l) => ({ name: String(l.name || 'Event ticket').slice(0, 120), qty: Math.max(1, Math.floor(Number(l.qty) || 1)), unitCents: Math.max(0, Math.round(Number(l.unitCents) || 0)) }));
  /* KRA line totals must equal the sale: if the lines do not (a discount), one line carries the total. */
  const sum = clean.reduce((a, l) => a + l.qty * l.unitCents, 0);
  const qty = clean.reduce((a, l) => a + l.qty, 0) || 1;
  const fiscalLines = sum === grossCents ? clean
    : [{ name: `${String((event && event.title) || 'Event')} — ${qty} ticket${qty === 1 ? '' : 's'}`.slice(0, 120), qty: 1, unitCents: grossCents }];
  txn.create(_db().collection(COL.FISCAL).doc(String(saleKey)), {
    saleKey: String(saleKey), eventId: (event && event.id) || null, eventTitle: (event && event.title) || null,
    organizerUid: (event && event.organizerUid) || null, channel, orderId, saleId,
    lines: fiscalLines, grossCents, currency: 'KES', paymentMethod: paymentMethod || null,
    status: REC.PENDING, invoiceId: null, invoiceNumber: null, attempts: 0, reversal: null,
    createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
  });
  return true;
}

/* Claim the right to submit (one submission in flight per record). */
async function _claim(ref) {
  return _db().runTransaction(async (txn) => {
    const s = await txn.get(ref);
    if (!s.exists) return null;
    const f = s.data();
    if (f.invoiceId || f.status === REC.NOT_APPLICABLE || f.status === REC.SUBMITTED) return null;
    const c = _ms(f.claimedAt);
    if (c != null && _now() - c < CLAIM_MS) return null;
    txn.update(ref, { claimedAt: Timestamp.fromMillis(_now()), updatedAt: FieldValue.serverTimestamp() });
    return f;
  });
}

/**
 * Hand one recorded sale to eTIMS. Idempotent: an existing invoice is never created twice (the claim,
 * and etims' own idempotency key `${organizer}-order-evt_${saleKey}`). Never throws.
 */
async function submit(saleKey) {
  const ref = _db().collection(COL.FISCAL).doc(String(saleKey || '_'));
  let f;
  try { f = await _claim(ref); } catch (e) { logger.error('[eventFiscal] claim failed', { saleKey, err: e.message }); return { error: 'claim_failed' }; }
  if (!f) return { skipped: 'not_claimable' };
  if (!f.organizerUid) {
    await ref.update({ status: REC.SUBMISSION_ERROR, error: 'Sale has no organizer to invoice as.', attempts: FieldValue.increment(1), claimedAt: null, updatedAt: FieldValue.serverTimestamp() });
    return { error: 'no_organizer' };
  }
  try {
    const r = await require('./etims').generateForOrder({
      sellerUid: f.organizerUid, orderId: `evt_${f.saleKey}`, buyer: null, submitNow: false,
      order: { items: f.lines.map((l) => ({ name: l.name, quantity: l.qty, price: l.unitCents / 100 })),
        totalAmount: f.grossCents / 100, paymentMethod: f.paymentMethod },
    });
    if (r && r.skipped) {
      await ref.update({ status: REC.NOT_REGISTERED, reason: String(r.reason || 'eTIMS not active').slice(0, 120), claimedAt: null, checkedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
      return { notRegistered: true };
    }
    await ref.update({ status: REC.SUBMITTED, invoiceId: r.invoiceId, invoiceNumber: r.invoiceNumber || null, error: null,
      attempts: FieldValue.increment(1), claimedAt: null, submittedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
    return { invoiceId: r.invoiceId };
  } catch (e) {
    logger.warn('[eventFiscal] submission failed', { saleKey: f.saleKey, err: e.message });
    await ref.update({ status: REC.SUBMISSION_ERROR, error: String(e.message || e).slice(0, 300), attempts: FieldValue.increment(1),
      claimedAt: null, updatedAt: FieldValue.serverTimestamp() }).catch(() => {});
    return { error: 'submission_failed' };
  }
}

/** The fiscal state a ticket / sale shows — derived from the record AND the eTIMS invoice. Pure. */
function view(f, inv) {
  if (!f) return { status: VIEW.NOT_RECORDED };
  const base = { saleKey: f.saleKey, reversal: f.reversal || null };
  if (f.status === REC.NOT_APPLICABLE) return { ...base, status: VIEW.NOT_APPLICABLE };
  if (f.status === REC.NOT_REGISTERED) return { ...base, status: VIEW.NOT_REGISTERED };
  if (f.status === REC.SUBMISSION_ERROR) return { ...base, status: VIEW.FAILED, reason: 'submission_error' };
  if (!f.invoiceId || !inv) return { ...base, status: VIEW.PENDING };
  if (inv.status === 'accepted') {
    /* Exactly what KRA returned — nothing derived, nothing invented. */
    return { ...base, status: VIEW.CONFIRMED, invoiceNumber: inv.invoiceNumber || f.invoiceNumber || null,
      receiptNumber: inv.receiptNumber || null, controlUnitNumber: inv.controlUnitNumber || null,
      kraQrImage: _https(inv.qrCode), verificationUrl: _https(inv.verificationUrl), acceptedAt: inv.acceptedAt || null };
  }
  if (inv.status === 'failed') return { ...base, status: VIEW.FAILED, reason: 'kra_rejected', invoiceNumber: inv.invoiceNumber || null };
  return { ...base, status: VIEW.PENDING, invoiceNumber: inv.invoiceNumber || f.invoiceNumber || null };
}

/** Fiscal views for several sale keys (records + their invoices, two reads batches). */
async function viewsFor(saleKeys) {
  const keys = [...new Set((saleKeys || []).filter(Boolean).map(String))];
  const out = {};
  if (!keys.length) return out;
  const db = _db();
  const recs = await Promise.all(keys.map((k) => db.collection(COL.FISCAL).doc(k).get()));
  const invIds = recs.map((r) => (r.exists && r.data().invoiceId) || null);
  const invs = await Promise.all(invIds.map((id) => (id ? db.collection(COL.INVOICES).doc(id).get() : null)));
  keys.forEach((k, i) => { out[k] = view(recs[i].exists ? recs[i].data() : null, invs[i] && invs[i].exists ? invs[i].data() : null); });
  return out;
}
const keyOfTicket = (t) => (t && (t.paymentRef || t.saleId)) || null;

/** A refund settled for this sale: a credit note is owed wherever an invoice exists. */
async function markRefunded(saleKey, { refundId = null } = {}) {
  const ref = _db().collection(COL.FISCAL).doc(String(saleKey || '_'));
  return _db().runTransaction(async (txn) => {
    const s = await txn.get(ref);
    if (!s.exists) return { skipped: 'no_record' };
    const f = s.data();
    if (f.reversal) return { already: true };
    const owed = !!f.invoiceId;
    txn.update(ref, { reversal: { status: owed ? 'CREDIT_NOTE_REQUIRED' : 'NOT_REQUIRED', refundId, at: Timestamp.fromMillis(_now()) },
      updatedAt: FieldValue.serverTimestamp() });
    return { reversal: owed ? 'CREDIT_NOTE_REQUIRED' : 'NOT_REQUIRED' };
  });
}

/** Pick up records a crash left unsubmitted, and retry submission errors (bounded). */
async function sweep(nowMs) {
  const now = Number.isFinite(nowMs) ? nowMs : _now();
  const db = _db();
  const [pend, errs] = await Promise.all([
    db.collection(COL.FISCAL).where('status', '==', REC.PENDING).limit(50).get(),
    db.collection(COL.FISCAL).where('status', '==', REC.SUBMISSION_ERROR).limit(50).get(),
  ]);
  const due = pend.docs.filter((d) => !d.data().invoiceId && (_ms(d.data().createdAt) || 0) <= now - SWEEP_AFTER_MS)
    .concat(errs.docs.filter((d) => (Number(d.data().attempts) || 0) < MAX_ATTEMPTS));
  let submitted = 0;
  for (const d of due) { const r = await submit(d.id); if (r.invoiceId) submitted++; } // eslint-disable-line no-await-in-loop
  return { due: due.length, submitted };
}

module.exports = { COL, REC, VIEW, MAX_ATTEMPTS, recordSale, submit, view, viewsFor, keyOfTicket, markRefunded, sweep,
  _setClock: (fn) => { _now = fn || (() => Date.now()); } };
