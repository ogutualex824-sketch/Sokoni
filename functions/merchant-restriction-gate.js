'use strict';

/**
 * SOKONI MERCHANT RESTRICTION GATE
 * ────────────────────────────────────────────────────────────────────────────
 * Whether a merchant who owes commission may perform a protected operation.
 *
 * ── IT IS NOT A SECOND RESTRICTION AUTHORITY ─────────────────────────────────
 * The decision belongs to `sellerRestrictions/{uid}.restricted` — the same document
 * `getSellerRestriction` and `getCommissionBalance` already report, written only by
 * `settleConfirmedPayment` (which clears it) and by whatever sets it. This module reads
 * that document and applies it. It computes no balance, sums no ledger row, and knows no
 * commission rate: a gate that worked out for itself whether a merchant owed money would
 * be a second opinion about a debt, and the first time it disagreed the merchant would be
 * locked out over a number nobody could reproduce.
 *
 * ── THREE STATES, BECAUSE TWO WOULD LIE ──────────────────────────────────────
 *   CLEAR       the platform has looked, and this merchant is not restricted
 *   RESTRICTED  the platform has looked, and they are
 *   UNKNOWN     the platform could not look
 *
 * A missing document is CLEAR, not UNKNOWN: almost no merchant has ever been restricted,
 * so treating absence as suspicion would lock out the entire platform. `getSellerRestriction`
 * already answers `restricted: false` for a missing record, and disagreeing with it here
 * would be the second opinion this module exists to avoid.
 *
 * A FAILED LOOKUP is neither. `resolveEntitlements` states the surrounding contract: an
 * entitlement failure "must not take a shop offline" and "must never hand out a LARGER
 * allowance than the merchant is owed". Those pull opposite ways for a restriction, so the
 * uncertainty is reported rather than resolved by guessing, and each operation answers for
 * itself: money leaving the platform refuses on UNKNOWN, everything else continues.
 *
 * ── WHAT ENFORCEMENT MEANS ───────────────────────────────────────────────────
 * Refusing the operation on the server. A hidden button is a suggestion — the callable is
 * still there, and a restricted merchant with the network tab open is not restricted at
 * all. The UI may explain the refusal; it may not BE the refusal.
 *
 * ── AND WHAT MUST NEVER BE GATED ─────────────────────────────────────────────
 * Seeing the debt, and paying it. A merchant locked out of the screen that explains why
 * they are locked out cannot get themselves unlocked, and a platform that blocks the
 * remediation path is not enforcing a debt, it is stranding a customer.
 */

const STATE = Object.freeze({
  CLEAR: 'CLEAR',
  RESTRICTED: 'RESTRICTED',
  UNKNOWN: 'UNKNOWN',
});

/** The canonical document. Same collection and field the commission reads use. */
const RESTRICTION = 'sellerRestrictions';

/**
 * OPERATIONS THAT A RESTRICTED MERCHANT MAY NOT PERFORM.
 *
 * Money leaving the platform, and nothing else for now. A merchant who owes commission
 * drawing their takings out ahead of settling is the concrete harm; blocking them from
 * trading would stop the sales that produce the money to settle with.
 */
const PROTECTED = Object.freeze(['WITHDRAW_FUNDS']);

/**
 * OPERATIONS THAT STAY OPEN WHATEVER THE STATE.
 *
 * The debt must be visible and payable, or the restriction has no exit.
 */
const ALWAYS_ALLOWED = Object.freeze(['VIEW_COMMISSION_BALANCE', 'PAY_COMMISSION', 'VIEW_RESTRICTION']);

/**
 * THE DECISION, from a document. Pure — no database, no clock, no arithmetic.
 *
 * @param {object|null} doc  the sellerRestrictions document, or null when absent
 * @param {boolean} lookupFailed  true when the read itself failed
 */
function decide(doc, lookupFailed) {
  if (lookupFailed === true) return { state: STATE.UNKNOWN, reason: 'LOOKUP_FAILED' };
  if (!doc) return { state: STATE.CLEAR, reason: 'NO_RECORD' };
  if (doc.restricted === true) {
    return {
      state: STATE.RESTRICTED,
      reason: doc.reason || 'COMMISSION_OUTSTANDING',
      /* Carried for the message a merchant reads, never to decide anything. The figure is
         the server's; this module does not check it against the flag, because a gate that
         second-guessed the authority would need its own idea of what is owed. */
      outstandingKES: typeof doc.outstandingKES === 'number' ? doc.outstandingKES : null,
    };
  }
  return { state: STATE.CLEAR, reason: 'NOT_RESTRICTED' };
}

/**
 * MAY THIS OPERATION PROCEED?
 *
 * @param {string} operation  one of PROTECTED / ALWAYS_ALLOWED
 * @param {object} decision   from decide()
 */
function mayPerform(operation, decision) {
  const op = String(operation || '');
  const d = decision || { state: STATE.UNKNOWN };

  /* Seeing and settling the debt are never gated, in any state. */
  if (ALWAYS_ALLOWED.indexOf(op) !== -1) return { allowed: true, reason: 'ALWAYS_ALLOWED' };

  /* An operation nobody declared is not silently permitted. A new money path added next
     month must be classified deliberately, not default to open because this list was not
     updated with it. */
  if (PROTECTED.indexOf(op) === -1) return { allowed: false, reason: 'UNDECLARED_OPERATION' };

  if (d.state === STATE.RESTRICTED) {
    return { allowed: false, reason: 'RESTRICTED', outstandingKES: d.outstandingKES == null ? null : d.outstandingKES };
  }
  if (d.state === STATE.UNKNOWN) {
    /* Money leaving the platform, against a restriction the platform could not read. The
       surrounding contract forbids handing out more than is owed; refusing a withdrawal
       delays it, while allowing it cannot be undone. */
    return { allowed: false, reason: 'RESTRICTION_UNKNOWN' };
  }
  return { allowed: true, reason: 'CLEAR' };
}

/**
 * Read the canonical document and decide. Never throws — a lookup failure is a state, not
 * an exception, and a caller that had to try/catch this would end up choosing its own
 * answer for the failure case.
 */
async function resolveRestriction(uid, db) {
  const id = String(uid || '').trim();
  if (!id) return { state: STATE.UNKNOWN, reason: 'NO_UID' };
  if (!db) return { state: STATE.UNKNOWN, reason: 'NO_HANDLE' };
  try {
    const snap = await db.collection(RESTRICTION).doc(id).get();
    return decide(snap && snap.exists ? (snap.data() || {}) : null, false);
  } catch (_) {
    return decide(null, true);
  }
}

/** Resolve and decide in one call, for a caller that only wants the verdict. */
async function assertMayPerform(operation, uid, db) {
  const decision = await resolveRestriction(uid, db);
  const verdict = mayPerform(operation, decision);
  return Object.assign({}, verdict, { state: decision.state });
}

/** What a refused merchant should be told. Explains; never invents a settlement. */
function refusalMessage(verdict) {
  const v = verdict || {};
  if (v.reason === 'RESTRICTED') {
    return v.outstandingKES != null
      ? 'Your account is restricted because SOKONI commission of KES ' +
        v.outstandingKES.toFixed(2) + ' is outstanding. Settle it to withdraw again.'
      : 'Your account is restricted because SOKONI commission is outstanding. ' +
        'Settle it to withdraw again.';
  }
  if (v.reason === 'RESTRICTION_UNKNOWN') {
    return 'Your account status could not be checked just now, so withdrawals are paused. ' +
           'Please try again shortly.';
  }
  return 'This operation is not available on your account.';
}

module.exports = {
  STATE, RESTRICTION, PROTECTED, ALWAYS_ALLOWED,
  decide, mayPerform, resolveRestriction, assertMayPerform, refusalMessage,
};
