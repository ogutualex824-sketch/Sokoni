'use strict';
/**
 * INTASEND PAYMENT-METHOD CAPABILITY — the one authority for "which methods may
 * a buyer be offered on the hosted checkout".
 *
 * WHY A RECORD AND NOT A LIST IN CODE: which methods the SOKONI IntaSend account
 * can take is an ACCOUNT fact, not a documentation fact. IntaSend exposes no
 * read-only "list my enabled methods" endpoint (developers.intasend.com
 * llms.txt, checked 2026-09-26). The evidence that exists is:
 *   - a COMPLETE invoice on the account whose `provider` is the method
 *     (GET /api/v1/invoices/ — read-only, secret key), or
 *   - a checkout session the account accepted for that method
 *     (scripts/probe-intasend-capability.js — CREATES real invoices), or
 *   - IntaSend's written confirmation for the account.
 * A Super Admin records that evidence from AdminOS; this module validates it and
 * answers the questions every caller asks. Nothing is offered on the strength of
 * a method's name appearing in code.
 *
 * Record: config/intasendCapability
 *   { methods: { [METHOD]: { status, evidence?: {type, reference}, note,
 *                            recordedBy, recordedAtMs } }, updatedAt }
 *
 * This record describes the HOSTED CHECKOUT page. M-PESA by STK push is a
 * separate rail (initiateSTKPush) and is not governed here.
 */

/* IntaSend's own identifiers (Create Checkout reference, `method` enum) — the
   methods KNOWN today. Not a ceiling: a method IntaSend adds later is recorded by
   its identifier (METHOD_ID format) and, once LIVE_AND_PROVEN with evidence, is
   offered with NO code change. The record controls availability, not this list. */
const METHODS = Object.freeze(['M-PESA', 'PESALINK', 'CARD-PAYMENT', 'GOOGLE-PAY', 'APPLE-PAY', 'BITCOIN', 'BANK-ACH', 'COOP_B2B']);
const METHOD_ID = /^[A-Z][A-Z0-9]*(?:[-_][A-Z0-9]+){0,4}$/;
const isMethodId = (m) => typeof m === 'string' && m.length <= 32 && METHOD_ID.test(m);
const labelOf = (m) => LABELS[m] || m;

const LABELS = Object.freeze({
  'M-PESA': 'M-PESA', PESALINK: 'PesaLink', 'CARD-PAYMENT': 'Card', 'GOOGLE-PAY': 'Google Pay',
  'APPLE-PAY': 'Apple Pay', BITCOIN: 'Bitcoin', 'BANK-ACH': 'Bank (ACH)', COOP_B2B: 'Co-op Bank B2B',
});

const STATUS = Object.freeze({
  LIVE_AND_PROVEN:             'LIVE_AND_PROVEN',
  COMMITTED_BUT_UNPROVEN:      'COMMITTED_BUT_UNPROVEN',
  PRESENT_BUT_DISABLED:        'PRESENT_BUT_DISABLED',
  PROVIDER_CAPABILITY_UNKNOWN: 'PROVIDER_CAPABILITY_UNKNOWN',
  UNSUPPORTED:                 'UNSUPPORTED',
  BLOCKED:                     'BLOCKED',
});

/* Evidence that can PROVE a method (or prove it unsupported). */
const EVIDENCE_TYPES = Object.freeze({
  completed_invoice:     'A COMPLETE invoice on the live account whose provider is this method (GET /api/v1/invoices/)',
  live_probe_session:    'A checkout session the live account accepted for this method (probe-intasend-capability --live)',
  provider_confirmation: 'IntaSend written confirmation for the SOKONI account (ticket / email reference)',
  provider_refusal:      'The live account answered 4xx for this method (probe) — UNSUPPORTED only',
});
const NEEDS_EVIDENCE = new Set([STATUS.LIVE_AND_PROVEN, STATUS.UNSUPPORTED]);

/**
 * Validate one capability entry a Super Admin wants to record.
 * @returns {{ok:true, entry:object}|{ok:false, error:string}}
 */
function validateEntry({ method, status, evidence, note }) {
  const m = String(method || '').trim().toUpperCase();
  if (!isMethodId(m)) return { ok: false, error: 'Not an IntaSend method identifier (e.g. CARD-PAYMENT).' };
  /* a spelling that only LOOKS new: the underscore forms IntaSend does not use */
  if (['GOOGLE_PAY', 'APPLE_PAY', 'CARD_PAYMENT', 'BANK_ACH'].includes(m)) return { ok: false, error: 'Use IntaSend\'s spelling: ' + m.replace('_', '-') + '.' };
  if (!Object.values(STATUS).includes(status)) return { ok: false, error: 'Unknown capability status.' };
  const n = String(note || '').replace(/<[^>]*>/g, '').trim().slice(0, 1000);
  if (n.length < 20) return { ok: false, error: 'Describe what was checked (at least 20 characters).' };
  const entry = { status, note: n };
  if (NEEDS_EVIDENCE.has(status)) {
    const e = evidence && typeof evidence === 'object' ? evidence : {};
    const type = String(e.type || '');
    if (!EVIDENCE_TYPES[type]) return { ok: false, error: 'Evidence type is required for ' + status + '.' };
    if (status === STATUS.LIVE_AND_PROVEN && type === 'provider_refusal') return { ok: false, error: 'A refusal cannot prove a method.' };
    if (status === STATUS.UNSUPPORTED && type !== 'provider_refusal' && type !== 'provider_confirmation') {
      return { ok: false, error: 'UNSUPPORTED needs a provider refusal or confirmation.' };
    }
    const ref = String(e.reference || '').trim();
    if (!/^[A-Za-z0-9._:\/#-]{4,120}$/.test(ref)) return { ok: false, error: 'Evidence reference is required.' };
    entry.evidence = { type, reference: ref };
  }
  return { ok: true, entry: { method: m, ...entry } };
}

/** Status of every known method; absent = PROVIDER_CAPABILITY_UNKNOWN. */
function classify(record) {
  const methods = (record && record.methods) || {};
  /* every known method, plus any other identifier the record holds */
  const ids = METHODS.concat(Object.keys(methods).filter((k) => !METHODS.includes(k) && isMethodId(k)).sort());
  return ids.map((m) => {
    const e = methods[m];
    const status = e && Object.values(STATUS).includes(e.status) ? e.status : STATUS.PROVIDER_CAPABILITY_UNKNOWN;
    return { method: m, label: labelOf(m), known: METHODS.includes(m), status, evidence: (e && e.evidence) || null, note: (e && e.note) || null,
      recordedBy: (e && e.recordedBy) || null, recordedAtMs: (e && e.recordedAtMs) || null };
  });
}

/** Methods that may be offered on the hosted checkout — LIVE_AND_PROVEN, with evidence. */
function provenHostedMethods(record) {
  return classify(record).filter((c) => c.status === STATUS.LIVE_AND_PROVEN && c.evidence).map((c) => c.method);
}

module.exports = { METHODS, LABELS, STATUS, EVIDENCE_TYPES, validateEntry, classify, provenHostedMethods, isMethodId, labelOf, RECORD: 'intasendCapability' };
