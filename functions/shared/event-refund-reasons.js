/* SOKONI — the Event refund reason catalogue (one vocabulary for the wizard and the server).
 * ============================================================================================
 * A refund is never a casual button. The requester picks a CONTROLLED reason; each reason decides
 * which follow-up questions are asked and HOW eligibility is determined:
 *
 *   basis 'organizer'  the event side failed (cancelled, postponed, changed, venue, organizer could
 *                      not deliver). A CANCELLED event is eligible outright; the others need an admin
 *                      review of the evidence — they are never refused by the buyer-side policy.
 *   basis 'policy'     the buyer changed their mind or made a mistake. Eligible only if the event's
 *                      refund policy allows buyer refunds AND the cutoff has not passed.
 *   basis 'no_show'    the ticket was not used. Eligible only if the policy permits no-show refunds,
 *                      the event is over, and EVERY ticket is NOT_ADMITTED. Admission is the source of
 *                      truth (a PIN admission counts; absence of a QR scan alone does not decide it).
 *   basis 'payment'    something went wrong with the money. Always reviewed by an admin.
 *
 * Free text is never a reason on its own. 'other' (and every basis that needs it) requires a
 * meaningful explanation — refused when empty, too short, or a placeholder ("test", "refund", ".").
 * Penalty / fee retention is NOT modelled here: it is an UNDECIDED owner + legal decision
 * (published pages promise full refunds; see docs/ENTERTAINMENT_HUB.md).
 *
 * UMD: server requires it; the browser loads the synced copy /sokoni-event-refund-reasons.js.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SokoniEventRefundReasons = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const Q = Object.freeze({
    OTHER_ORDER:   { id: 'otherOrderId',   label: 'Which order is the duplicate you want refunded?', type: 'order', required: true },
    INTENDED:      { id: 'intendedEvent',  label: 'Which event did you mean to buy for?',           type: 'text',  required: true },
    ATTENDED:      { id: 'attended',       label: 'Did you attend the event?',                       type: 'yes_no', required: true, mustBe: 'no' },
    UNUSED:        { id: 'confirmUnused',  label: 'I confirm none of these tickets was used',        type: 'confirm', required: true },
    WHAT_WRONG:    { id: 'whatWentWrong',  label: 'What went wrong with the payment?',              type: 'text',  required: true },
    EXPECTED:      { id: 'expectedAmount', label: 'What amount did you expect to pay (KES)?',       type: 'number', required: true },
  });

  const REASONS = Object.freeze([
    /* event-related */
    { code: 'event_cancelled',        group: 'Event-related', label: 'Event cancelled',                            basis: 'organizer', questions: [],              explain: false },
    { code: 'event_postponed',        group: 'Event-related', label: 'Event postponed',                            basis: 'organizer', questions: [],              explain: true },
    { code: 'event_time_changed',     group: 'Event-related', label: 'Event date/time materially changed',         basis: 'organizer', questions: [],              explain: true },
    { code: 'venue_changed',          group: 'Event-related', label: 'Venue materially changed',                   basis: 'organizer', questions: [],              explain: true },
    { code: 'organizer_failed',       group: 'Event-related', label: 'Event organizer unable to deliver',          basis: 'organizer', questions: [],              explain: true },
    { code: 'offering_changed',       group: 'Event-related', label: 'Ticket type / event offering materially changed', basis: 'organizer', questions: [],       explain: true },
    /* buyer-related */
    { code: 'cannot_attend',          group: 'Buyer-related', label: 'I can no longer attend',                     basis: 'policy',    questions: [],              explain: false },
    { code: 'wrong_ticket',           group: 'Buyer-related', label: 'I purchased the wrong ticket',               basis: 'policy',    questions: [],              explain: true },
    { code: 'duplicate_purchase',     group: 'Buyer-related', label: 'Duplicate purchase',                         basis: 'payment',   questions: [Q.OTHER_ORDER], explain: false },
    { code: 'accidental_purchase',    group: 'Buyer-related', label: 'Accidental purchase',                        basis: 'policy',    questions: [],              explain: true },
    { code: 'wrong_event',            group: 'Buyer-related', label: 'Purchased for the wrong event',              basis: 'policy',    questions: [Q.INTENDED],    explain: false },
    { code: 'wrong_quantity',         group: 'Buyer-related', label: 'Purchased the wrong quantity',               basis: 'policy',    questions: [],              explain: true },
    /* no-show */
    { code: 'did_not_attend',         group: 'No-show',       label: 'I did not attend / the ticket was unused',   basis: 'no_show',   questions: [Q.ATTENDED, Q.UNUSED], explain: false },
    /* payment-related */
    { code: 'charged_more',           group: 'Payment-related', label: 'Charged more than expected',               basis: 'payment',   questions: [Q.EXPECTED, Q.WHAT_WRONG], explain: false },
    { code: 'duplicate_payment',      group: 'Payment-related', label: 'Duplicate payment',                        basis: 'payment',   questions: [Q.WHAT_WRONG],  explain: false },
    { code: 'payment_issue',          group: 'Payment-related', label: 'Payment issue',                            basis: 'payment',   questions: [Q.WHAT_WRONG],  explain: false },
    { code: 'paid_not_delivered',     group: 'Payment-related', label: 'Payment completed but ticket not delivered', basis: 'payment', questions: [],              explain: true },
    /* other */
    { code: 'other',                  group: 'Other',         label: 'Other reason',                               basis: 'payment',   questions: [],              explain: true },
  ].map((r) => Object.freeze(r)));

  const BY_CODE = Object.freeze(Object.fromEntries(REASONS.map((r) => [r.code, r])));
  const PLACEHOLDERS = new Set(['test', 'testing', 'none', 'refund', 'n/a', 'na', 'nothing', 'no', 'yes', 'ok', 'x', 'xx', 'xxx', 'asdf', 'qwerty', '-', '.', '..', '...', 'other', 'reason', 'because']);
  const MIN_EXPLANATION = 15;

  function get(code) { return BY_CODE[String(code || '')] || null; }

  /** A meaningful explanation: not empty, not a placeholder, at least 15 chars and 3 words of letters. */
  function explanationProblem(text) {
    const t = String(text == null ? '' : text).trim();
    if (!t) return 'Please explain what happened.';
    if (PLACEHOLDERS.has(t.toLowerCase().replace(/[!?.\s]+$/g, '')) || /^(.)\1+$/.test(t)) return 'Please give a real explanation.';
    if (t.length < MIN_EXPLANATION) return `Please explain in at least ${MIN_EXPLANATION} characters.`;
    if ((t.match(/[A-Za-zÀ-ɏ]{2,}/g) || []).length < 3) return 'Please explain in a few words.';
    return null;
  }

  /** Validate the answers a reason requires. Returns the first problem, or null. */
  function answersProblem(code, answers = {}, explanation = '') {
    const r = get(code);
    if (!r) return 'Choose a reason from the list.';
    for (const q of r.questions) {
      const v = answers[q.id];
      if (q.required && (v == null || String(v).trim() === '')) return `Please answer: ${q.label}`;
      if (q.mustBe && String(v).toLowerCase() !== q.mustBe) return q.id === 'attended' ? 'A ticket that was used to attend is not eligible for a no-show refund.' : `Please answer: ${q.label}`;
      if (q.type === 'confirm' && v !== true && v !== 'true') return `Please confirm: ${q.label}`;
      if (q.type === 'number' && !(Number(v) > 0)) return `Please answer: ${q.label}`;
      if (q.type === 'text' && String(v).trim().length < 3) return `Please answer: ${q.label}`;
    }
    if (r.explain) return explanationProblem(explanation);
    return null;
  }

  function groups() {
    const out = {};
    for (const r of REASONS) (out[r.group] = out[r.group] || []).push({ code: r.code, label: r.label });
    return out;
  }

  return { REASONS, QUESTIONS: Q, get, groups, explanationProblem, answersProblem, MIN_EXPLANATION };
}));
