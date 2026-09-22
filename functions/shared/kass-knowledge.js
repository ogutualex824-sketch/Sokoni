'use strict';
/**
 * Kass AI — the knowledge classification and guardrail layer.
 * ============================================================================================
 * Kass explains SOKONI. It is an INFORMATION layer, never a system authority.
 *
 * ── THE TWO FAILURES THIS PREVENTS ─────────────────────────────────────────────────────────
 *
 * 1. PRESENTING A PLAN AS A CAPABILITY. This repository's documentation is full of things that
 *    are designed, frozen, planned or forecast — and an assistant that reads them all into one
 *    undifferentiated corpus will tell a merchant that SOKONI places calls. It does not: no
 *    call has ever been placed. Every fact Kass states must carry the status of the source it
 *    came from, and a forecast must be labelled as analysis rather than fact.
 *
 * 2. BECOMING A SECOND AUTHORITY. An assistant that can be talked into marking someone
 *    verified, releasing a payment or choosing who to ring has become the weakest authority on
 *    the platform — weakest because it can be argued with. Kass may explain every one of those
 *    things and perform none of them. `mayPerform` returns false for all of them, by
 *    whitelist, so a new capability is denied until someone deliberately permits it.
 *
 * ── PURITY ─────────────────────────────────────────────────────────────────────────────────
 * No Firestore, no clock, no network, no require, no model call. This is the classification
 * and the refusal; retrieval and generation happen elsewhere and consult this.
 */

/* ── Knowledge status ─────────────────────────────────────────────────────────────────────
 * The categories are ordered by how much weight an answer may put on them. They are NOT
 * interchangeable and must never be merged — the whole point is that an answer knows which
 * one it is standing on. */
const KNOWLEDGE_STATUS = Object.freeze({
  current: Object.freeze({
    describe: 'True of SOKONI as it stands now',
    assertable: true,
    label: 'Current',
  }),
  recent: Object.freeze({
    describe: 'Changed recently; true now, and worth flagging as new',
    assertable: true,
    label: 'Recent change',
  }),
  historical: Object.freeze({
    describe: 'Was true; is not now',
    /* Assertable ABOUT THE PAST only. Stating it without the past tense is how an old design
       gets described as the live one. */
    assertable: true,
    label: 'Historical',
    requiresPastTense: true,
  }),
  planned: Object.freeze({
    describe: 'Decided and not built',
    /* NOT assertable as a capability. "SOKONI supports X" is false when X is planned. */
    assertable: false,
    label: 'Planned',
  }),
  forecast: Object.freeze({
    describe: 'An inference from the current state — analysis, not a commitment',
    assertable: false,
    label: 'Forecast',
    requiresDisclaimer: true,
  }),
});

const STATUSES = Object.freeze(Object.keys(KNOWLEDGE_STATUS));

/** Statuses a plain capability claim may rest on. */
const ASSERTABLE = Object.freeze(STATUSES.filter((s) => KNOWLEDGE_STATUS[s].assertable));

/* ── Guardrails ───────────────────────────────────────────────────────────────────────────
 * A WHITELIST of what Kass may do. Everything absent is refused, so a capability nobody has
 * considered is denied rather than permitted by omission. */
const PERMITTED_ACTIONS = Object.freeze([
  'explain_platform',
  'explain_product',
  'explain_policy',
  'explain_order_status',
  'explain_account',
  'summarise_communication_history',
  'summarise_support_cases',
  'guide_to_communication_channel',
  'explain_provider_failure',
  'answer_operational_question',
]);

/* Named explicitly rather than left to the whitelist's silence, because these are the ones
   somebody will eventually ask for, and the refusal should state WHY rather than "unknown
   action". */
const FORBIDDEN_ACTIONS = Object.freeze({
  authorize_payment: 'money moves through the payment authority, never through an assistant',
  release_funds: 'same as authorize_payment',
  issue_refund: 'a refund is requested and approved by people, with a server-set fee',
  modify_order: 'orders are changed by their owner through the order authority',
  modify_financial_record: 'ledgers are server-written and never conversational',
  set_verification: 'verification requires a passed identity check, a face check AND a human review',
  declare_verified: 'same as set_verification',
  modify_permissions: 'roles and claims are decided by the admin authority',
  set_custom_claims: 'same as modify_permissions',
  alter_connect_state: 'a session moves only through canTransition, and never by being asked',
  place_call: 'a call is opened against a business anchor by the person making it',
  choose_recipient: 'the recipient is DERIVED from the anchor; naming one is the defect Connect exists to prevent',
  send_communication: 'sending goes through the communication engine with an operator behind it',
});

/**
 * mayPerform(action) -> { allowed, reason }
 *
 * FAILS CLOSED. An unrecognised action is denied — a capability nobody has considered must
 * not be permitted by the mere absence of a rule against it.
 */
function mayPerform(action) {
  const a = String(action || '');
  if (PERMITTED_ACTIONS.includes(a)) return { allowed: true, reason: 'informational' };
  if (Object.hasOwn(FORBIDDEN_ACTIONS, a)) {
    return { allowed: false, reason: FORBIDDEN_ACTIONS[a] };
  }
  return { allowed: false, reason: 'not_a_permitted_assistant_action' };
}

/** Is this a state-changing action? Used to keep the two lists honest: nothing may be in both. */
function isForbidden(action) {
  return Object.hasOwn(FORBIDDEN_ACTIONS, String(action || ''));
}

/**
 * classify(source) -> status
 *
 * `source` describes where a fact came from: `{ status }` if the corpus recorded one, plus
 * `effectiveTo` which — when set and past — makes a fact historical whatever it claims.
 *
 * DEFAULTS TO `planned`, NOT `current`. An unclassified document is the dangerous case: this
 * repository's docs describe frozen contracts, gates and roadmaps, and reading an unlabelled
 * one as current is exactly how "SOKONI places calls" gets said. Unknown provenance is treated
 * as not-yet-true, which is the safe direction to be wrong in.
 */
function classify(source) {
  const s = source || {};
  const declared = String(s.status || '');
  if (STATUSES.includes(declared)) {
    /* An expiry overrides a declaration: a document that says `current` and expired last year
       is historical, and the document is not the authority on that. */
    if (s.expired === true && declared !== 'historical') return 'historical';
    return declared;
  }
  return 'planned';
}

/**
 * describeAnswer({ status, text }) -> { label, text, assertable, disclaimer }
 *
 * The wrapper an answer must carry. It does not rewrite the text — that is the model's job —
 * it states what the text is allowed to be read as.
 */
function describeAnswer(input) {
  const i = input || {};
  const status = STATUSES.includes(String(i.status)) ? String(i.status) : 'planned';
  const spec = KNOWLEDGE_STATUS[status];
  const out = {
    status,
    label: spec.label,
    text: String(i.text || ''),
    assertable: spec.assertable === true,
    disclaimer: null,
  };
  if (spec.requiresDisclaimer) {
    out.disclaimer = 'This is analysis based on the current state, not a commitment or a date.';
  }
  if (!spec.assertable && status === 'planned') {
    out.disclaimer = 'This is planned and not built. It is not something SOKONI does today.';
  }
  if (spec.requiresPastTense) {
    out.disclaimer = 'This describes how SOKONI used to work. It is not current.';
  }
  return out;
}

/**
 * capabilityClaimAllowed({ status }) -> boolean
 *
 * The narrow question behind the first failure mode: may an answer say "SOKONI does X" on the
 * strength of this source? Only for statuses that are true NOW.
 */
function capabilityClaimAllowed(status) {
  const s = String(status || '');
  return s === 'current' || s === 'recent';
}

/**
 * recipientFromAnchorOnly(request) -> { allowed, reason }
 *
 * Kass may point someone at a conversation; it may not choose who. A request naming a uid, a
 * phone number or an email address is refused outright — the recipient is DERIVED from the
 * business anchor by the communication authority, and an assistant that can name one has
 * reintroduced the exact defect Connect was built to prevent.
 */
function recipientFromAnchorOnly(request) {
  const r = request || {};
  const named = ['calleeUid', 'recipientUid', 'participantUids', 'phone', 'phoneNumber', 'email']
    .filter((k) => r[k] !== undefined && r[k] !== null && r[k] !== '');
  if (named.length) {
    return { allowed: false, reason: 'assistant_named_a_recipient:' + named.join(',') };
  }
  if (!r.anchorType || !r.anchorId) {
    return { allowed: false, reason: 'no_business_anchor' };
  }
  return { allowed: true, reason: 'anchor_only' };
}

module.exports = {
  KNOWLEDGE_STATUS,
  STATUSES,
  ASSERTABLE,
  PERMITTED_ACTIONS,
  FORBIDDEN_ACTIONS,
  mayPerform,
  isForbidden,
  classify,
  describeAnswer,
  capabilityClaimAllowed,
  recipientFromAnchorOnly,
};
