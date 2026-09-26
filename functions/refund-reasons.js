'use strict';
/**
 * SOKONI — THE ONE REASON AUTHORITY for disputes, returns and refunds.
 * functions/refund-reasons.js
 *
 * ── THE DEFECT ──────────────────────────────────────────────────────────────────────────
 * Four vocabularies for "why": disputes.js (8 codes), returns-engine.js (6 codes, overlapping and
 * differing), returns.html (a third set — Title-Case display strings used as values), and the merchant
 * dispute labels (including `late_delivery`, a reason the server never accepted). The same complaint
 * could be `overcharged` in one place and absent in another; `damaged` and `damaged_in_transit` split
 * one situation in two.
 *
 * ── WHAT THIS IS, AND WHAT IT IS NOT ────────────────────────────────────────────────────
 * ONE list of reason codes and labels, and which surfaces accept which. Built only from reasons that
 * already existed, plus the two refund causes named in the approved refund policy (seller cancelled,
 * seller failed to dispatch) — nothing invented.
 * It deliberately carries NO fault or money classification. Whether `damaged` is the seller's, the
 * rider's or nobody's fault is an INVESTIGATION finding from evidence, decided by the refund/liability
 * authority (H2) — never by the label a buyer picked.
 *
 * ── COMPATIBILITY ───────────────────────────────────────────────────────────────────────
 * Production holds no dispute, return or refund-request documents (measured 2026-09-26), so nothing
 * stored uses an old spelling. Old spellings are still accepted as INPUT ALIASES — a stale client keeps
 * working — and are always STORED as the canonical code:
 *     overcharged → billing_error · changed_mind → buyer_request · damaged_in_transit → damaged
 * Which surface accepts which reason is PRESERVED EXACTLY from before: this repair unifies spelling,
 * it does not widen or narrow what a buyer may raise where.
 *
 * sokoni-refund-reasons.js (repo root) is the browser mirror of this list; scripts/test-refund-reasons.js
 * fails if the two differ by a single code, label or flag.
 */

const REASONS = Object.freeze([
  { code: 'not_received',              label: 'Item never arrived',                        dispute: true,  return: false, refund: true },
  { code: 'not_as_described',          label: 'Significantly different from the listing',  dispute: true,  return: true,  refund: true },
  { code: 'counterfeit',               label: 'Counterfeit or not authentic',              dispute: true,  return: false, refund: true },
  { code: 'wrong_item',                label: 'Wrong item sent',                           dispute: true,  return: true,  refund: true },
  { code: 'damaged',                   label: 'Arrived damaged',                           dispute: true,  return: true,  refund: true },
  { code: 'defective',                 label: 'Defective or not working',                  dispute: true,  return: true,  refund: true },
  { code: 'billing_error',             label: 'Charged the wrong amount',                  dispute: true,  return: false, refund: true },
  { code: 'buyer_request',             label: 'Changed my mind',                           dispute: false, return: true,  refund: true },
  { code: 'seller_cancelled',          label: 'Cancelled by the seller',                   dispute: false, return: false, refund: true },
  { code: 'seller_failed_to_dispatch', label: 'Seller did not dispatch',                   dispute: false, return: false, refund: true },
  { code: 'other',                     label: 'Other',                                     dispute: true,  return: true,  refund: true },
].map(Object.freeze));

const ALIASES = Object.freeze({
  overcharged:        'billing_error',
  changed_mind:       'buyer_request',
  damaged_in_transit: 'damaged',
});

const CONTEXTS = Object.freeze(['dispute', 'return', 'refund']);
const BY_CODE = Object.freeze(REASONS.reduce((a, r) => (a[r.code] = r, a), {}));
const CODE = Object.freeze(REASONS.reduce((a, r) => (a[r.code.toUpperCase()] = r.code, a), {}));

/** The canonical code for an input (itself or an alias), or null if it is not a reason at all. */
function canonical(input) {
  const s = typeof input === 'string' ? input.trim() : '';
  if (BY_CODE[s]) return s;
  if (ALIASES[s]) return ALIASES[s];
  return null;
}

/** Codes a surface accepts. */
function allowedFor(context) {
  if (!CONTEXTS.includes(context)) throw new Error('unknown reason context: ' + context);
  return REASONS.filter((r) => r[context]).map((r) => r.code);
}

/** Validate an input for a surface: { ok, code } with the CANONICAL code, or { ok:false, message }. */
function resolve(context, input) {
  const code = canonical(input);
  if (!code) return { ok: false, message: `Unknown reason "${input}". Allowed: ${allowedFor(context).join(', ')}.` };
  if (!BY_CODE[code][context]) return { ok: false, message: `"${code}" is not a ${context} reason. Allowed: ${allowedFor(context).join(', ')}.` };
  return { ok: true, code };
}

function labelOf(code) { const r = BY_CODE[canonical(code)]; return r ? r.label : null; }

module.exports = { REASONS, ALIASES, CONTEXTS, CODE, canonical, allowedFor, resolve, labelOf };
