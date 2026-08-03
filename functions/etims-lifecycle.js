'use strict';
/**
 * SOKONI eTIMS — Invoice Lifecycle Operations (canonical INTERNAL model)
 * ===========================================================================
 * The internal state model for post-issue invoice operations:
 *
 *   Invoice ──┬── Credit Note   (reduce / return value)
 *             ├── Debit Note    (increase value)
 *             ├── Cancellation  (void a pre-/just-issued invoice)
 *             ├── Amendment     (corrected re-issue)
 *             └── Reversal      (undo a settled invoice)
 *
 * Every op REUSES the platform's canonical pieces — nothing is duplicated:
 *   - Tax math      → etims-tax-engine (computeCreditNote / computeInvoice)
 *   - Audit trail   → etims-audit (immutable, hash-chained, on the ORIGINAL invoice)
 *   - Idempotency   → deterministic doc id from (op, invoiceId, idempotencyKey)
 *   - KRA payload   → etims-kra-adapter ONLY (PENDING until the spec is mapped)
 *   - Transmission  → etimsTransmissionQueue (drained once the adapter is ready)
 *
 * This module builds the INTERNAL documents; it never invents KRA fields. When the
 * spec arrives you implement the mappings in etims-kra-adapter.js alone.
 *
 * @module etims-lifecycle
 * @version 1.0.0
 */
const crypto     = require('crypto');
const TaxEngine  = require('./etims-tax-engine');
const Audit      = require('./etims-audit');
const KraAdapter = require('./etims-kra-adapter');

const LIFECYCLE_OPS = Object.freeze({
  CREDIT_NOTE: 'credit_note', DEBIT_NOTE: 'debit_note',
  CANCELLATION: 'cancellation', AMENDMENT: 'amendment', REVERSAL: 'reversal',
});

/* Canonical collection per op (data model). */
const COLL = Object.freeze({
  credit_note: 'creditNotes', debit_note: 'debitNotes',
  cancellation: 'invoiceCancellations', amendment: 'invoiceAmendments', reversal: 'invoiceReversals',
});

/* Internal state machine — which ops are valid from a given invoice status. KRA-specific
   timing windows (e.g. "within N days of issue") are an ADAPTER/config concern and are
   deliberately NOT invented here. */
const VALID_FROM = Object.freeze({
  credit_note:  ['accepted'],
  debit_note:   ['accepted'],
  cancellation: ['pending_submission', 'queued', 'accepted'],
  amendment:    ['accepted'],
  reversal:     ['accepted'],
});
function canApply(op, invoiceStatus) { return (VALID_FROM[op] || []).includes(invoiceStatus); }

/* ── PURE builders — construct the canonical internal doc (no Firestore, no KRA) ── */
function _base(docType, orig, reason, extra) {
  return {
    docType,
    origInvoiceId:     orig.id || orig.invoiceId || null,
    origInvoiceNumber: orig.invoiceNumber || null,
    sellerUid:         orig.sellerUid || null,
    hubId:             orig.hubId || null,
    reason:            reason ? String(reason).slice(0, 300) : null,
    status:            'pending_submission',
    ...extra,
  };
}
function buildCreditNote({ originalInvoice, items, reason, vatStatus = 'registered', config }) {
  const cn = TaxEngine.computeCreditNote({ items, vatStatus, config });   // negated sale
  return _base('credit_note', originalInvoice, reason, { lines: cn.lines, totals: cn.totals, taxSummary: cn.taxSummary });
}
function buildDebitNote({ originalInvoice, items, reason, vatStatus = 'registered', config }) {
  const inv = TaxEngine.computeInvoice({ items, vatStatus, config });     // positive adjustment
  return _base('debit_note', originalInvoice, reason, { lines: inv.lines, totals: inv.totals, taxSummary: inv.taxSummary });
}
function buildAmendment({ originalInvoice, items, reason, vatStatus = 'registered', config }) {
  const inv = TaxEngine.computeInvoice({ items, vatStatus, config });     // corrected re-issue
  return _base('amendment', originalInvoice, reason, { lines: inv.lines, totals: inv.totals, taxSummary: inv.taxSummary });
}
function buildCancellation({ originalInvoice, reason }) { return _base('cancellation', originalInvoice, reason, {}); }
function buildReversal({ originalInvoice, reason })     { return _base('reversal', originalInvoice, reason, {}); }

function _build(op, args) {
  switch (op) {
    case 'credit_note':  return buildCreditNote(args);
    case 'debit_note':   return buildDebitNote(args);
    case 'amendment':    return buildAmendment(args);
    case 'cancellation': return buildCancellation(args);
    case 'reversal':     return buildReversal(args);
    default: { const e = new Error(`unknown lifecycle op: ${op}`); e.code = 'UNKNOWN_OP'; throw e; }
  }
}

/* Deterministic id → idempotency: same op + invoice + key ⇒ same doc (no duplicates). */
function docId(op, origInvoiceId, idempotencyKey) {
  const h = crypto.createHash('sha256').update(`${op}|${origInvoiceId}|${idempotencyKey || ''}`).digest('hex').slice(0, 24);
  return `${op}_${h}`;
}

/**
 * Apply a lifecycle op: validate state → build canonical doc (tax engine) → persist →
 * immutable audit → enqueue for KRA transmission. Idempotent. Firestore side.
 * @returns {Promise<{id, deduplicated, doc}>}
 */
async function applyLifecycleOp(db, { op, originalInvoice, items, reason, vatStatus, config, actor = 'system', idempotencyKey }) {
  if (!originalInvoice || !(originalInvoice.id || originalInvoice.invoiceId)) {
    const e = new Error('originalInvoice with id is required'); e.code = 'INVALID_ARG'; throw e;
  }
  if (!canApply(op, originalInvoice.status)) {
    const e = new Error(`Cannot apply ${op} to an invoice in status '${originalInvoice.status}'`); e.code = 'INVALID_STATE'; throw e;
  }
  const doc = _build(op, { originalInvoice, items, reason, vatStatus, config });

  const admin = require('firebase-admin');
  const now = admin.firestore.Timestamp.now();
  const id  = docId(op, doc.origInvoiceId, idempotencyKey);
  const ref = db.collection(COLL[op]).doc(id);

  const existing = await ref.get();
  if (existing.exists) return { id, deduplicated: true, doc: existing.data() };

  const kraPayload    = KraAdapter.buildPayload(op, doc);   // isolated — PENDING until spec
  const transmittable = KraAdapter.isTransmittable(kraPayload);
  const record = { ...doc, id, idempotencyKey: idempotencyKey || null, kraPayload, transmittable, createdAt: now, updatedAt: now, actor };
  await ref.set(record);

  await Audit.recordAuditEvent(db, {
    entityType: 'invoice', entityId: doc.origInvoiceId, event: op, newStatus: doc.status,
    sellerUid: doc.sellerUid, hubId: doc.hubId, actor,
    detail: `${op} ${id}${doc.totals ? ' total=' + doc.totals.totAmt : ''}`,
  });

  await db.collection('etimsTransmissionQueue').doc(id).set({
    docId: id, docType: op, collection: COLL[op], origInvoiceId: doc.origInvoiceId,
    sellerUid: doc.sellerUid || null, hubId: doc.hubId || null,
    status: transmittable ? 'pending' : 'blocked_pending_spec',
    createdAt: now, nextRetryAt: now.toDate().toISOString(),
  });

  return { id, deduplicated: false, doc: record };
}

module.exports = {
  LIFECYCLE_OPS, COLL, VALID_FROM, canApply, docId,
  buildCreditNote, buildDebitNote, buildAmendment, buildCancellation, buildReversal,
  applyLifecycleOp,
};
