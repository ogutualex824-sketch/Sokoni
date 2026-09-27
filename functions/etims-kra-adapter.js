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

/* ── What is missing before a credit note can be transmitted (2026-09-27) ──────────────────────
   Recorded explicitly instead of guessed. None of these are in the repository; each must come
   from KRA's official eTIMS OSCU/VSCU Third-Party Integrator specification (see
   docs/ETIMS_REQUIREMENTS_MATRIX.md rows A5, B1–B5 and docs/ETIMS_CERTIFICATION_READINESS.md §7):
     1. the endpoint for a credit note / refund receipt (the sale path's /saveTrnsSalesSdcInfo is
        itself unverified — a credit note may or may not share it);
     2. the receipt-type code for a refund / credit note and the linkage field to the original
        receipt (e.g. whether and how `orgInvcNo` references it);
     3. the line / tax field semantics for a negative (credit) document;
     4. the real `cmcKey` device-initialisation and per-request signing flow (the current transport
        signs with a home-grown HMAC — docs: "home-grown HMAC ≠ KRA OSCU cmcKey").
   Until they are loaded, buildCreditNotePayload returns PENDING and nothing is ever sent. */
const MISSING_SPEC = Object.freeze([
  'credit-note / refund-receipt endpoint',
  'refund receipt-type code and original-receipt linkage field',
  'credit-note line and tax field semantics',
  'cmcKey device initialisation and request signing',
]);

/**
 * Classify a provider answer. The ONE place outcome semantics live — the sale-invoice worker and the
 * credit-note path both use it. It relies only on what the existing eTIMS integration already treats
 * as success (HTTP 200 with resultCd "000", functions/etims.js submitToKra) and on transport facts.
 *   ACCEPTED   HTTP 200, resultCd "000" AND a returned receipt number (data.rcptNo)
 *   REJECTED   a definitive answer: HTTP 4xx, or HTTP 200 with a resultCd other than "000"
 *   UNKNOWN    timeout, network error, HTTP 5xx / no status, or "000" WITHOUT a receipt number —
 *              the provider may or may not have recorded it: never assumed, never blindly re-sent.
 * @param {{kind:'response', httpStatus:number, body:object}|{kind:'timeout'|'network_error', message?:string}} p
 */
function classifyResponse(p) {
  if (!p || p.kind === 'timeout' || p.kind === 'network_error') return { outcome: 'UNKNOWN', reason: p && p.kind === 'timeout' ? 'provider_timeout' : 'provider_unreachable' };
  const code = Number(p.httpStatus);
  if (!Number.isFinite(code) || code >= 500) return { outcome: 'UNKNOWN', reason: `provider_http_${Number.isFinite(code) ? code : 'none'}` };
  const body = (p.body && typeof p.body === 'object') ? p.body : {};
  if (code >= 400) return { outcome: 'REJECTED', reason: String(body.resultMsg || `HTTP ${code}`).slice(0, 200) };
  if (String(body.resultCd) !== '000') return { outcome: 'REJECTED', reason: String(body.resultMsg || `resultCd ${body.resultCd}`).slice(0, 200) };
  const data = body.data || {};
  const rcptNo = data.rcptNo != null && String(data.rcptNo).trim() ? String(data.rcptNo).trim() : null;
  if (!rcptNo) return { outcome: 'UNKNOWN', reason: 'accepted_without_reference' };
  return { outcome: 'ACCEPTED', reference: rcptNo, data };
}

/* True once a payload is a real KRA payload (never, until SPEC_LOADED + builders done). */
function isTransmittable(payload) { return !!(payload && payload.ready === true); }

module.exports = {
  SPEC_LOADED, MISSING_SPEC,
  buildPayload, isTransmittable, classifyResponse,
  buildInvoicePayload, buildCreditNotePayload, buildDebitNotePayload,
  buildCancellationPayload, buildAmendmentPayload, buildReversalPayload,
};
