'use strict';
/**
 * SOKONI eTIMS — KRA Document Adapter (the ONLY place that knows KRA payload formats)
 * ===========================================================================
 * Isolation boundary between SOKONI's canonical INTERNAL invoice-lifecycle model and
 * the KRA wire format. The rest of the codebase builds/records lifecycle documents
 * with SOKONI's own fields; ONLY this adapter maps them to KRA payloads.
 *
 * Until the official KRA eTIMS Third-Party Integrator specification is loaded
 * (docs/kra-etims-spec-v2.0.pdf), every builder returns a PENDING marker — it does
 * NOT invent field names, codes, or structures. When the spec arrives, you implement
 * the mappings HERE ONLY; no business/lifecycle code changes. `SPEC_LOADED` stays
 * false until then, so callers can detect that a document is not yet transmittable.
 *
 * @module etims-kra-adapter
 * @version 0.1.0 (pre-spec)
 */

/* Flip to true (and implement the builders) once the KRA spec is mapped. */
const SPEC_LOADED = false;

/* A PENDING marker — a document is fully formed internally but not yet mappable to KRA. */
function pending(docType, doc) {
  return {
    ready: false,
    reason: 'KRA_SPEC_PENDING',
    docType,
    note: 'KRA payload mapping is not implemented yet. Fill in functions/etims-kra-adapter.js from docs/kra-etims-spec-v2.0.pdf — no other code changes required.',
    /* Echo the canonical internal fields so, on submission attempt, callers can log
       exactly what WOULD be mapped (aids the eventual line-by-line mapping). */
    canonical: doc ? { docType: doc.docType, origInvoiceId: doc.origInvoiceId || null, totals: doc.totals || null } : null,
  };
}

/* One builder per lifecycle document type. Each is a stub returning PENDING until the
   spec is mapped. Signature is stable so the lifecycle layer never changes. */
const buildInvoicePayload      = (doc) => pending('invoice', doc);
const buildCreditNotePayload   = (doc) => pending('credit_note', doc);
const buildDebitNotePayload    = (doc) => pending('debit_note', doc);
const buildCancellationPayload = (doc) => pending('cancellation', doc);
const buildAmendmentPayload    = (doc) => pending('amendment', doc);
const buildReversalPayload     = (doc) => pending('reversal', doc);

/* Route by docType — the lifecycle layer calls this generically. */
function buildPayload(docType, doc) {
  switch (docType) {
    case 'invoice':      return buildInvoicePayload(doc);
    case 'credit_note':  return buildCreditNotePayload(doc);
    case 'debit_note':   return buildDebitNotePayload(doc);
    case 'cancellation': return buildCancellationPayload(doc);
    case 'amendment':    return buildAmendmentPayload(doc);
    case 'reversal':     return buildReversalPayload(doc);
    default: return pending(String(docType), doc);
  }
}

/* True once a payload is a real KRA payload (never, until SPEC_LOADED + builders done). */
function isTransmittable(payload) { return !!(payload && payload.ready === true); }

module.exports = {
  SPEC_LOADED,
  buildPayload, isTransmittable,
  buildInvoicePayload, buildCreditNotePayload, buildDebitNotePayload,
  buildCancellationPayload, buildAmendmentPayload, buildReversalPayload,
};
