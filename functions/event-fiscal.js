'use strict';
/**
 * SOKONI — Event ticket fiscalisation (KRA eTIMS): sale fiscal records and credit notes, on the
 * EXISTING eTIMS authorities. No second fiscal authority.
 * ============================================================================================
 * AUTHORITIES REUSED
 *   sale invoice   functions/etims.js generateForOrder (organizer = seller; queued, submitNow:false —
 *                  etimsProcessQueue holds the eTIMS secrets and transmits)
 *   credit note    functions/etims-lifecycle.js applyLifecycleOp('credit_note') → creditNotes/{id}
 *                  (tax engine, tamper-evident audit, etimsTransmissionQueue). KRA transmission of
 *                  lifecycle documents is NOT implemented platform-wide yet: etims-kra-adapter has
 *                  SPEC_LOADED=false, so every credit note queues as 'blocked_pending_spec'. That — and
 *                  real sandbox certification — is the external gate. Nothing here pretends otherwise.
 *
 * RECORDS
 *   eventFiscal/{saleKey}            ONE per PAID sale (saleKey = paymentRef, or the door sale id),
 *                                    written in the sale's own transaction. Once its invoice is
 *                                    accepted it is IMMUTABLE — a refund never writes to it.
 *   eventFiscalReversals/{execId}    ONE per (fiscal record, refund case): the credit-note lifecycle.
 *                                    execId = sha256("evtcn|<fiscalRecordId>|<refundCaseId>") — a
 *                                    deterministic identity, never a clock / random / client id.
 *
 * ONE VOCABULARY
 *   fiscalStatus   FISCAL_NOT_REQUIRED (reason ORGANIZER_NOT_REGISTERED | FREE_TICKET |
 *                  NO_FISCAL_RECORD) · FISCAL_PENDING · FISCAL_ACCEPTED · FISCAL_FAILED
 *   creditNote     CREDIT_NOTE_REQUIRED → CREDIT_NOTE_PENDING → CREDIT_NOTE_ACCEPTED
 *                                                          ↘ CREDIT_NOTE_FAILED (definitive rejection;
 *                                                            retry allowed)
 *                                                          ↘ CREDIT_NOTE_OUTCOME_UNKNOWN (timeout / 5xx /
 *                                                            accepted-without-reference: NO blind retry —
 *                                                            a super admin resolves it with evidence)
 *
 * NOTHING IS FABRICATED. A receipt number, credit-note reference, QR, control-unit number or signature
 * exists ONLY when the provider returned it (recordCreditNoteOutcome is the single ingress, and it is
 * server-side only). No AdminOS action can type one in or mark anything accepted.
 * STATES ARE SEPARATE. Payment, ticket, admission and fiscal never gate each other.
 */
const crypto = require('crypto');
const logger = require('firebase-functions/logger');
const { getFirestore, FieldValue, Timestamp } = require('firebase-admin/firestore');

const _db = () => getFirestore();
let _now = () => Date.now();

const COL = Object.freeze({ FISCAL: 'eventFiscal', INVOICES: 'etimsInvoices', REVERSALS: 'eventFiscalReversals',
  CREDIT_NOTES: 'creditNotes', TRANSMISSION: 'etimsTransmissionQueue', PROFILES: 'etimsProfiles' });
/* submission-record states (internal) */
const REC = Object.freeze({
  PENDING: 'PENDING', SUBMITTED: 'SUBMITTED', NOT_REGISTERED: 'NOT_REGISTERED',
  SUBMISSION_ERROR: 'SUBMISSION_ERROR', NOT_APPLICABLE: 'NOT_APPLICABLE',
});
/* the ONE external vocabulary */
const FS = Object.freeze({
  NOT_REQUIRED: 'FISCAL_NOT_REQUIRED', PENDING: 'FISCAL_PENDING', ACCEPTED: 'FISCAL_ACCEPTED', FAILED: 'FISCAL_FAILED',
  /* the invoice transmission's outcome is unknown (timeout / 5xx / accepted-without-receipt): held for
     evidence — never re-sent automatically (functions/etims.js processQueueOnce) */
  OUTCOME_UNKNOWN: 'FISCAL_OUTCOME_UNKNOWN',
});
const NOT_REQUIRED_REASON = Object.freeze({ ORGANIZER_NOT_REGISTERED: 'ORGANIZER_NOT_REGISTERED', FREE_TICKET: 'FREE_TICKET', NO_FISCAL_RECORD: 'NO_FISCAL_RECORD' });
const CN = Object.freeze({
  REQUIRED: 'CREDIT_NOTE_REQUIRED', PENDING: 'CREDIT_NOTE_PENDING', ACCEPTED: 'CREDIT_NOTE_ACCEPTED',
  FAILED: 'CREDIT_NOTE_FAILED', UNKNOWN: 'CREDIT_NOTE_OUTCOME_UNKNOWN',
});
const CLAIM_MS = 5 * 60 * 1000;
const SWEEP_AFTER_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 5;

const _ms = (v) => { if (!v) return null; if (typeof v.toMillis === 'function') return v.toMillis(); const t = new Date(v).getTime(); return Number.isFinite(t) ? t : null; };
const _https = (u) => (typeof u === 'string' && /^https:\/\/[^\s"'<>]+$/.test(u) ? u : null);
const _hist = (from, to, by, note) => FieldValue.arrayUnion({ at: _now(), from: from || null, to, by: by || 'system', note: note ? String(note).slice(0, 200) : null });

/* ═══ SALE FISCAL RECORD ═══════════════════════════════════════════════════════════════════ */

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
    status: REC.PENDING, invoiceId: null, invoiceNumber: null, attempts: 0,
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

/* ═══ VIEWS (derived — never stored, so they cannot drift) ═════════════════════════════════ */

/** A reversal as it may be shown: provider data ONLY when accepted. Pure. */
function creditNoteView(r) {
  if (!r) return null;
  const accepted = r.status === CN.ACCEPTED;
  return {
    executionId: r.executionId, status: r.status, refundCaseId: r.refundCaseId || null,
    refundCents: r.refundCents, penaltyCents: r.penaltyCents || 0,
    creditNoteReference: accepted ? (r.creditNoteReference || null) : null,
    creditNoteQr: accepted ? _https(r.creditNoteQr) : null,
    verificationUrl: accepted ? _https(r.verificationUrl) : null,
    failureReason: r.status === CN.FAILED || r.status === CN.UNKNOWN ? (r.failureReason || null) : null,
    waitingFor: r.waitingFor || null, transmission: r.transmission || null,
    createdAt: _ms(r.createdAt), updatedAt: _ms(r.updatedAt),
  };
}

/** The fiscal state a ticket / sale shows — derived from the record AND the eTIMS invoice. Pure. */
function view(f, inv, reversals) {
  const cns = (reversals || []).map(creditNoteView);
  if (!f) return { status: FS.NOT_REQUIRED, fiscalStatus: FS.NOT_REQUIRED, reason: NOT_REQUIRED_REASON.NO_FISCAL_RECORD, creditNotes: cns };
  const base = { saleKey: f.saleKey, creditNotes: cns };
  const out = (st, extra) => ({ ...base, status: st, fiscalStatus: st, ...(extra || {}) });
  if (f.status === REC.NOT_APPLICABLE) return out(FS.NOT_REQUIRED, { reason: NOT_REQUIRED_REASON.FREE_TICKET });
  if (f.status === REC.NOT_REGISTERED) return out(FS.NOT_REQUIRED, { reason: NOT_REQUIRED_REASON.ORGANIZER_NOT_REGISTERED });
  if (f.status === REC.SUBMISSION_ERROR) return out(FS.FAILED, { reason: 'submission_error' });
  if (!f.invoiceId || !inv) return out(FS.PENDING);
  if (inv.status === 'accepted') {
    /* Exactly what KRA returned — nothing derived, nothing invented. */
    return out(FS.ACCEPTED, { invoiceNumber: inv.invoiceNumber || f.invoiceNumber || null,
      receiptNumber: inv.receiptNumber || null, controlUnitNumber: inv.controlUnitNumber || null,
      kraQrImage: _https(inv.qrCode), verificationUrl: _https(inv.verificationUrl), acceptedAt: inv.acceptedAt || null });
  }
  if (inv.status === 'failed') return out(FS.FAILED, { reason: 'kra_rejected', invoiceNumber: inv.invoiceNumber || null });
  if (inv.status === 'outcome_unknown') return out(FS.OUTCOME_UNKNOWN, { reason: 'provider_outcome_unknown', invoiceNumber: inv.invoiceNumber || null });
  return out(FS.PENDING, { invoiceNumber: inv.invoiceNumber || f.invoiceNumber || null });
}

/** Fiscal views for several sale keys (records, their invoices, and their credit notes). */
async function viewsFor(saleKeys) {
  const keys = [...new Set((saleKeys || []).filter(Boolean).map(String))];
  const out = {};
  if (!keys.length) return out;
  const db = _db();
  const recs = await Promise.all(keys.map((k) => db.collection(COL.FISCAL).doc(k).get()));
  const invIds = recs.map((r) => (r.exists && r.data().invoiceId) || null);
  const [invs, revs] = await Promise.all([
    Promise.all(invIds.map((id) => (id ? db.collection(COL.INVOICES).doc(id).get() : null))),
    Promise.all(keys.map((k) => db.collection(COL.REVERSALS).where('fiscalRecordId', '==', k).limit(20).get())),
  ]);
  keys.forEach((k, i) => { out[k] = view(recs[i].exists ? recs[i].data() : null, invs[i] && invs[i].exists ? invs[i].data() : null, revs[i].docs.map((d) => d.data())); });
  return out;
}
const keyOfTicket = (t) => (t && (t.paymentRef || t.saleId)) || null;

/* ═══ CREDIT-NOTE LIFECYCLE ════════════════════════════════════════════════════════════════ */

/** The deterministic financial idempotency identity of one credit note. */
function executionIdFor(fiscalRecordId, refundCaseId) {
  return crypto.createHash('sha256').update(`evtcn|${String(fiscalRecordId)}|${String(refundCaseId)}`).digest('hex').slice(0, 40);
}

/**
 * A refund settled for a sale: create its credit-note REQUIREMENT, linked to the original fiscal
 * record — exactly once per (fiscal record, refund case). Nothing is created when fiscalisation
 * does not apply (no record, free ticket, organizer not on eTIMS): no fake credit note.
 */
async function requireCreditNote({ fiscalRecordId, refundCaseId, refundCents, penaltyCents = 0, reason = null, refundId = null }) {
  const db = _db();
  const fKey = String(fiscalRecordId || '');
  if (!fKey || !refundCaseId) return { skipped: 'no_reference' };
  const fSnap = await db.collection(COL.FISCAL).doc(fKey).get();
  if (!fSnap.exists) return { skipped: NOT_REQUIRED_REASON.NO_FISCAL_RECORD };
  const f = fSnap.data();
  if (f.status === REC.NOT_APPLICABLE) return { skipped: NOT_REQUIRED_REASON.FREE_TICKET };
  if (f.status === REC.NOT_REGISTERED) return { skipped: NOT_REQUIRED_REASON.ORGANIZER_NOT_REGISTERED };
  const amount = Math.round(Number(refundCents) || 0);
  if (!(amount > 0) || amount > Number(f.grossCents)) return { skipped: 'invalid_amount' };
  const executionId = executionIdFor(fKey, refundCaseId);
  const ref = db.collection(COL.REVERSALS).doc(executionId);
  const created = await db.runTransaction(async (txn) => {
    const s = await txn.get(ref);
    if (s.exists) return false;
    txn.create(ref, {
      executionId, fiscalRecordId: fKey, refundCaseId: String(refundCaseId), refundId: refundId || null,
      eventId: f.eventId || null, organizerUid: f.organizerUid || null, saleKey: f.saleKey, orderId: f.orderId || null, saleId: f.saleId || null,
      originalGrossCents: f.grossCents, refundCents: amount, penaltyCents: Math.max(0, Math.round(Number(penaltyCents) || 0)),
      reason: reason ? String(reason).slice(0, 120) : null, originalInvoiceId: f.invoiceId || null,
      status: CN.REQUIRED, creditNoteDocId: null, creditNoteReference: null, creditNoteQr: null, verificationUrl: null,
      providerData: null, failureReason: null, waitingFor: null, transmission: null, attempts: 0, claimedAt: null, evidence: null,
      history: [{ at: _now(), from: null, to: CN.REQUIRED, by: 'refund_settled', note: refundId ? `refund ${refundId}` : null }],
      createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
    });
    return true;
  });
  return { executionId, created };
}

/**
 * Execute one credit note: REQUIRED → (claim) → etims-lifecycle credit_note (idempotencyKey =
 * executionId, so the creditNotes doc id is deterministic) → PENDING (queued for transmission).
 * Waits (stays REQUIRED) while the ORIGINAL invoice is not accepted: a credit note can only reverse an
 * accepted invoice. Two concurrent executions: one claims, the other skips. Never throws.
 */
async function executeCreditNote(executionId) {
  const db = _db();
  const ref = db.collection(COL.REVERSALS).doc(String(executionId || '_'));
  let r;
  try {
    r = await db.runTransaction(async (txn) => {
      const s = await txn.get(ref);
      if (!s.exists) return null;
      const d = s.data();
      if (d.status !== CN.REQUIRED) return null;
      const c = _ms(d.claimedAt);
      if (c != null && _now() - c < CLAIM_MS) return null;
      txn.update(ref, { claimedAt: Timestamp.fromMillis(_now()), updatedAt: FieldValue.serverTimestamp() });
      return d;
    });
  } catch (e) { logger.error('[eventFiscal] credit-note claim failed', { executionId, err: e.message }); return { error: 'claim_failed' }; }
  if (!r) return { skipped: 'not_claimable' };
  try {
    const fSnap = await db.collection(COL.FISCAL).doc(r.fiscalRecordId).get();
    const f = fSnap.exists ? fSnap.data() : null;
    const invSnap = f && f.invoiceId ? await db.collection(COL.INVOICES).doc(f.invoiceId).get() : null;
    const inv = invSnap && invSnap.exists ? { id: invSnap.id, invoiceId: invSnap.id, ...invSnap.data() } : null;
    if (!inv || inv.status !== 'accepted') {
      await ref.update({ waitingFor: 'ORIGINAL_INVOICE_ACCEPTANCE', claimedAt: null, updatedAt: FieldValue.serverTimestamp() });
      return { waiting: 'original_not_accepted' };
    }
    const prof = await db.collection(COL.PROFILES).doc(String(r.organizerUid || '_')).get();
    const vatStatus = (prof.exists && prof.data().vatStatus) || 'registered';
    /* Reverse exactly the APPROVED principal: the original lines for a full refund; one line for a
       partial one (the penalty kept is not reversed). */
    const items = r.refundCents === f.grossCents
      ? f.lines.map((l) => ({ name: l.name, quantity: l.qty, unitPrice: l.unitCents / 100 }))
      : [{ name: `Refund — ${String(f.eventTitle || 'event tickets').slice(0, 90)}`, quantity: 1, unitPrice: r.refundCents / 100 }];
    const Lifecycle = require('./etims-lifecycle');
    const res = await Lifecycle.applyLifecycleOp(db, { op: 'credit_note', originalInvoice: inv, items, vatStatus,
      reason: `Event ticket refund ${r.refundCaseId}${r.reason ? ' (' + r.reason + ')' : ''}`.slice(0, 200), actor: 'event-fiscal', idempotencyKey: r.executionId });
    const transmittable = !!(res.doc && res.doc.transmittable);
    await ref.update({ status: CN.PENDING, creditNoteDocId: res.id, originalInvoiceId: inv.id, waitingFor: null,
      transmission: transmittable ? 'queued' : 'blocked_pending_spec', attempts: FieldValue.increment(1), claimedAt: null,
      history: _hist(CN.REQUIRED, CN.PENDING, 'event-fiscal', res.deduplicated ? 'credit note already built (idempotent)' : 'credit note built'),
      updatedAt: FieldValue.serverTimestamp() });
    return { pending: true, creditNoteDocId: res.id, deduplicated: !!res.deduplicated };
  } catch (e) {
    /* a LOCAL failure (build / persist) — not a provider outcome; stays REQUIRED, retried (bounded) */
    logger.warn('[eventFiscal] credit-note build failed', { executionId, err: e.message });
    await ref.update({ lastError: String(e.message || e).slice(0, 300), attempts: FieldValue.increment(1), claimedAt: null,
      updatedAt: FieldValue.serverTimestamp() }).catch(() => {});
    return { error: 'build_failed' };
  }
}

/**
 * Classify a provider (KRA eTIMS) answer for a credit-note transmission. Pure.
 *   ACCEPTED   HTTP 200, resultCd "000" AND a returned credit-note / receipt number
 *   REJECTED   a definitive answer: HTTP 4xx, or HTTP 200 with a non-"000" resultCd
 *   UNKNOWN    timeout, network error, HTTP 5xx, or "000" WITHOUT a reference — never assumed either way
 */
function classifyProviderResult(p) {
  /* ONE implementation of provider-outcome semantics: etims-kra-adapter.classifyResponse. This only
     shapes its answer for the credit-note record (https-only QR / verification link). */
  const c = require('./etims-kra-adapter').classifyResponse(p);
  if (c.outcome !== 'ACCEPTED') return { outcome: c.outcome, reason: c.reason };
  const data = c.data || {};
  return { outcome: 'ACCEPTED', reference: c.reference, qr: _https(data.qrCodeUrl), verificationUrl: _https(data.vsdcRcptUrl),
    providerData: { resultCd: '000', rcptNo: c.reference, intrlData: data.intrlData || null, rcptSgn: data.rcptSgn || null } };
}

/**
 * THE single ingress for a provider answer about a credit note (server-side only — called by the
 * eTIMS transmission drainer; not a callable, never reachable from a client or an AdminOS form).
 * Only a PENDING credit note moves; ACCEPTED is terminal, so a replayed answer changes nothing.
 */
async function recordCreditNoteOutcome(executionId, providerResult, { source = 'transmission' } = {}) {
  const c = classifyProviderResult(providerResult);
  const ref = _db().collection(COL.REVERSALS).doc(String(executionId || '_'));
  return _db().runTransaction(async (txn) => {
    const s = await txn.get(ref);
    if (!s.exists) return { skipped: 'missing' };
    const d = s.data();
    if (d.status !== CN.PENDING) return { skipped: `status_${d.status}`, outcome: c.outcome };
    if (c.outcome === 'ACCEPTED') {
      txn.update(ref, { status: CN.ACCEPTED, creditNoteReference: c.reference, creditNoteQr: c.qr, verificationUrl: c.verificationUrl,
        providerData: c.providerData, failureReason: null, acceptedAt: FieldValue.serverTimestamp(),
        history: _hist(CN.PENDING, CN.ACCEPTED, source, `provider reference ${c.reference}`), updatedAt: FieldValue.serverTimestamp() });
    } else if (c.outcome === 'REJECTED') {
      txn.update(ref, { status: CN.FAILED, failureReason: c.reason, history: _hist(CN.PENDING, CN.FAILED, source, c.reason), updatedAt: FieldValue.serverTimestamp() });
    } else {
      txn.update(ref, { status: CN.UNKNOWN, failureReason: c.reason, history: _hist(CN.PENDING, CN.UNKNOWN, source, c.reason), updatedAt: FieldValue.serverTimestamp() });
    }
    return { outcome: c.outcome };
  });
}

/**
 * AdminOS retry. FAILED (a definitive rejection) → PENDING again, re-queued on the SAME credit-note
 * document (no second credit note). REQUIRED → execute. UNKNOWN is refused: it must first be resolved
 * with evidence (resolveUnknownCreditNote). ACCEPTED / PENDING: nothing to retry.
 */
async function retryCreditNote(executionId, actorUid) {
  const db = _db();
  const ref = db.collection(COL.REVERSALS).doc(String(executionId || '_'));
  const out = await db.runTransaction(async (txn) => {
    const s = await txn.get(ref);
    if (!s.exists) return { error: 'missing' };
    const d = s.data();
    if (d.status === CN.UNKNOWN) return { error: 'outcome_unknown_needs_evidence' };
    if (d.status === CN.REQUIRED) return { execute: true };
    if (d.status !== CN.FAILED) return { error: `nothing_to_retry_${d.status}` };
    let tq = null;
    if (d.creditNoteDocId) {
      tq = db.collection(COL.TRANSMISSION).doc(d.creditNoteDocId);
      const q = await txn.get(tq);
      if (q.exists) txn.update(tq, { status: q.data().status === 'blocked_pending_spec' ? 'blocked_pending_spec' : 'pending', nextRetryAt: new Date(_now()).toISOString() });
    }
    txn.update(ref, { status: CN.PENDING, failureReason: null, attempts: FieldValue.increment(1),
      history: _hist(CN.FAILED, CN.PENDING, actorUid, 'retry after a definitive rejection (same credit note)'), updatedAt: FieldValue.serverTimestamp() });
    return { requeued: true };
  });
  if (out.execute) return executeCreditNote(executionId);
  return out;
}

/**
 * An ambiguous outcome is resolved ONLY with evidence, and only in the direction evidence can prove
 * without the provider's own data: "the provider did NOT receive / accept it" (e.g. a KRA support
 * reference) → FAILED, which may then be retried. "It was accepted" can never be asserted here — the
 * reference must come from the provider through recordCreditNoteOutcome.
 */
async function resolveUnknownCreditNote(executionId, { resolution, evidence }, actorUid) {
  if (resolution !== 'NOT_ACCEPTED') return { error: 'only_not_accepted' };
  const ev = String(evidence || '').trim();
  if (ev.length < 10) return { error: 'evidence_required' };
  const ref = _db().collection(COL.REVERSALS).doc(String(executionId || '_'));
  return _db().runTransaction(async (txn) => {
    const s = await txn.get(ref);
    if (!s.exists) return { error: 'missing' };
    if (s.data().status !== CN.UNKNOWN) return { error: `not_unknown_${s.data().status}` };
    txn.update(ref, { status: CN.FAILED, failureReason: 'resolved: provider did not accept (evidence)', evidence: { text: ev.slice(0, 300), by: actorUid, at: _now() },
      history: _hist(CN.UNKNOWN, CN.FAILED, actorUid, 'resolved with evidence'), updatedAt: FieldValue.serverTimestamp() });
    return { resolved: true };
  });
}

/* ═══ SWEEP (existing 15-minute schedule — no new function) ═══════════════════════════════════ */
async function sweep(nowMs) {
  const now = Number.isFinite(nowMs) ? nowMs : _now();
  const db = _db();
  const [pend, errs, cnReq] = await Promise.all([
    db.collection(COL.FISCAL).where('status', '==', REC.PENDING).limit(50).get(),
    db.collection(COL.FISCAL).where('status', '==', REC.SUBMISSION_ERROR).limit(50).get(),
    db.collection(COL.REVERSALS).where('status', '==', CN.REQUIRED).limit(50).get(),
  ]);
  const due = pend.docs.filter((d) => !d.data().invoiceId && (_ms(d.data().createdAt) || 0) <= now - SWEEP_AFTER_MS)
    .concat(errs.docs.filter((d) => (Number(d.data().attempts) || 0) < MAX_ATTEMPTS));
  let submitted = 0; let creditNotes = 0;
  for (const d of due) { const r = await submit(d.id); if (r.invoiceId) submitted++; } // eslint-disable-line no-await-in-loop
  for (const d of cnReq.docs.filter((x) => (Number(x.data().attempts) || 0) < MAX_ATTEMPTS * 4)) { // eslint-disable-line no-await-in-loop
    const r = await executeCreditNote(d.id); if (r.pending) creditNotes++;
  }
  return { due: due.length, submitted, creditNotes };
}

module.exports = { COL, REC, FS, CN, NOT_REQUIRED_REASON, MAX_ATTEMPTS, recordSale, submit, view, creditNoteView, viewsFor, keyOfTicket,
  executionIdFor, requireCreditNote, executeCreditNote, classifyProviderResult, recordCreditNoteOutcome, retryCreditNote,
  resolveUnknownCreditNote, sweep, _setClock: (fn) => { _now = fn || (() => Date.now()); } };
