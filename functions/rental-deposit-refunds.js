'use strict';
/**
 * Rental deposit refunds — executes rentalDepositRefunds/{bookingId} REQUESTS through the IntaSend refund rail
 * (owner 2026-10-03, confirmed directly: the deposit returns to the renter's M-PESA via IntaSend B2C, never a wallet).
 *
 * The rail's proven contract (ADR-032/033, 1af3029, field case EKOQ6P0):
 *   • a refund is a CHARGEBACK against the ORIGINAL payment's IntaSend invoice_id (never api_ref), paid out as M-PESA B2C;
 *   • 201 = PROVIDER_ACCEPTED (PENDING), NOT money returned — only an authoritative status read may say COMPLETED;
 *   • no provider idempotency key: an unanswered request MAY have been recorded, so it is RECONCILED by status, never re-sent;
 *   • below the (unknown) B2C minimum the payout fails and strands the chargeback PROCESSING — so nothing is sent until the
 *     owner configures the minimum (refundPolicy/b2c.minCents). No guessed number.
 *
 * State machine (one document, deterministic id = bookingId):
 *   REQUESTED ─claim(txn)→ SENDING ─→ PROVIDER_ACCEPTED | COMPLETED | REJECTED | OUTCOME_UNKNOWN
 *   PROVIDER_ACCEPTED / OUTCOME_UNKNOWN(with chargebackId) ─reconcile→ COMPLETED | CANCELLED | DISPUTED | OVERDUE | (unchanged)
 *   HELD_FOR_REVIEW — anything this module will not send (no invoice, amount mismatch, no minimum, blocked case, old adapter).
 * Only REQUESTED is ever claimed, so a document can be SENT at most once. REJECTED / UNKNOWN / HELD go to a review row; a
 * person decides — the executor never retries a send on its own.
 */

const BLOCKED_INVOICES = new Set(['EKOQ6P0']);   /* the open field case — never re-POST (docs/INTASEND_REFUND_OPEN_CASE_EKOQ6P0.md) */
const COL = 'rentalDepositRefunds';
const TERMINAL = new Set(['COMPLETED', 'REJECTED', 'CANCELLED', 'HELD_FOR_REVIEW']);

const OUTCOME_TO_STATE = {
  PROVIDER_ACCEPTED: 'PROVIDER_ACCEPTED', PROVIDER_COMPLETED: 'COMPLETED', PROVIDER_CANCELLED: 'CANCELLED',
  PROVIDER_DISPUTED: 'DISPUTED', PROVIDER_OVERDUE: 'OVERDUE', PROVIDER_REJECTED: 'REJECTED', PROVIDER_UNKNOWN: 'OUTCOME_UNKNOWN',
};

/** The repaired adapter (1af3029) is the only one allowed: invoice-addressed, exact amounts, a status read. The pre-repair
    adapter (wrong endpoint, rounded amounts) has no getRefundStatus and its module exports no REFUND_OUTCOME — that is the
    observable difference, so both are required: deps.adapter (the instance) and deps.contract (the module's REFUND_OUTCOME). */
function isProvenAdapter(a, contract) {
  return !!a && typeof a.initiateRefund === 'function' && typeof a.getRefundStatus === 'function'
    && !!contract && contract.UNKNOWN === 'PROVIDER_UNKNOWN' && contract.ACCEPTED === 'PROVIDER_ACCEPTED';
}

async function _review(db, FV, id, reason, extra) {
  await db.collection('commissionReviewQueue').doc(`rental_deposit_${reason}_${id}`).set(Object.assign({
    kind: 'rental_deposit_refund', reason, bookingId: id, status: 'open', createdAt: FV.serverTimestamp() }, extra || {}), { merge: true });
}

/**
 * Execute ONE request. Safe to call from a trigger and a sweep concurrently: only the transaction that moves REQUESTED →
 * SENDING proceeds to the provider.
 * @param {{ adapter:object, minCents:number|null, FieldValue:object }} deps
 */
async function executeDepositRefund(db, bookingId, deps) {
  const FV = deps.FieldValue;
  const id = String(bookingId || '');
  if (!id || /[/]/.test(id)) return { outcome: 'invalid_id' };
  const ref = db.collection(COL).doc(id);
  const bRef = db.collection('rentalBookings').doc(id);

  const claim = await db.runTransaction(async (t) => {
    const [s, bs] = await Promise.all([t.get(ref), t.get(bRef)]);
    if (!s.exists) return { go: false, outcome: 'no_request' };
    const r = s.data() || {};
    if (r.state !== 'REQUESTED') return { go: false, outcome: 'not_requested', state: r.state || null };   /* sent at most once */
    const b = bs.exists ? (bs.data() || {}) : null;
    const st = b && b.settlement ? b.settlement : null;
    const hold = (reason) => { t.update(ref, { state: 'HELD_FOR_REVIEW', heldReason: reason, updatedAt: FV.serverTimestamp() }); return { go: false, outcome: 'held', reason }; };
    if (!Number.isInteger(r.amountCents) || r.amountCents <= 0) return hold('amount_invalid');
    if (!b || b.paymentStatus !== 'released' || !st || st.depositCents !== r.amountCents || st.depositRefund !== 'requested') return hold('booking_not_settled_for_this_amount');
    if (Number.isInteger(b.heldAmountCents) && r.amountCents > b.heldAmountCents) return hold('exceeds_held_amount');
    if (!r.invoiceId || String(r.invoiceId) !== String(b.invoiceId || '')) return hold('invoice_missing_or_mismatch');
    if (BLOCKED_INVOICES.has(String(r.invoiceId))) return hold('blocked_open_case');
    if (!isProvenAdapter(deps.adapter, deps.contract)) return hold('refund_adapter_unproven');
    if (!Number.isInteger(deps.minCents) || deps.minCents <= 0) return hold('b2c_minimum_not_configured');
    if (r.amountCents < deps.minCents) return hold('below_b2c_minimum');
    t.update(ref, { state: 'SENDING', claimedAt: FV.serverTimestamp(), attempt: 1, updatedAt: FV.serverTimestamp() });
    return { go: true, r };
  });
  if (!claim.go) {
    if (claim.outcome === 'held') await _review(db, FV, id, claim.reason);
    return claim;
  }

  const r = claim.r;
  let res;
  try {
    res = await deps.adapter.initiateRefund({ invoiceId: r.invoiceId, amountCents: r.amountCents, reason: 'Rental deposit return', reasonDetails: `SOKONI rental ${id}` });
  } catch (e) {
    /* the adapter throws only BEFORE sending (bad invoice / unrepresentable amount) — nothing reached the provider */
    await ref.update({ state: 'HELD_FOR_REVIEW', heldReason: 'adapter_refused', error: String(e && e.message || e).slice(0, 200), updatedAt: FV.serverTimestamp() });
    await _review(db, FV, id, 'adapter_refused');
    return { outcome: 'held', reason: 'adapter_refused' };
  }
  const state = OUTCOME_TO_STATE[res && res.outcome] || 'OUTCOME_UNKNOWN';
  await ref.update({ state, chargebackId: (res && res.chargebackId) || null, providerStatus: (res && res.providerStatus) || null,
    error: (res && res.error) || null, sentAt: FV.serverTimestamp(), updatedAt: FV.serverTimestamp() });
  if (state === 'REJECTED' || state === 'OUTCOME_UNKNOWN') await _review(db, FV, id, state.toLowerCase(), { chargebackId: (res && res.chargebackId) || null });
  return { outcome: state, chargebackId: (res && res.chargebackId) || null };
}

/** Ask the provider about a sent refund. Never re-sends. A request with no chargebackId cannot be asked — it stays for a person. */
async function reconcileDepositRefund(db, bookingId, deps) {
  const FV = deps.FieldValue;
  const ref = db.collection(COL).doc(String(bookingId));
  const s = await ref.get();
  if (!s.exists) return { outcome: 'no_request' };
  const r = s.data() || {};
  if (!['PROVIDER_ACCEPTED', 'OUTCOME_UNKNOWN', 'OVERDUE', 'DISPUTED'].includes(r.state)) return { outcome: 'nothing_to_reconcile', state: r.state || null };
  if (!r.chargebackId) return { outcome: 'needs_person', state: r.state };
  if (!isProvenAdapter(deps.adapter, deps.contract)) return { outcome: 'refund_adapter_unproven' };
  const st = await deps.adapter.getRefundStatus(r.chargebackId);
  const next = OUTCOME_TO_STATE[st && st.outcome];
  if (!next || next === 'OUTCOME_UNKNOWN' || next === r.state) return { outcome: 'unchanged', state: r.state };
  await ref.update({ state: next, providerStatus: (st && st.providerStatus) || null, reconciledAt: FV.serverTimestamp(), updatedAt: FV.serverTimestamp() });
  if (next === 'COMPLETED') await db.collection('rentalBookings').doc(String(bookingId)).set({ settlement: { depositRefund: 'returned' }, updatedAt: FV.serverTimestamp() }, { merge: true });
  return { outcome: next };
}

module.exports = { executeDepositRefund, reconcileDepositRefund, isProvenAdapter, BLOCKED_INVOICES, TERMINAL, COL };
