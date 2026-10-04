/* ════════════════════════════════════════════════════════════════════════════════════════════════════════
   Invoice allocation — the ONLY code that makes a canonical invoice (partially) paid (owner 2026-10-04).
   ────────────────────────────────────────────────────────────────────────────────────────────────────────
   NOT a callable. Server modules only: the verified-payment path (sokoni-5b's IntaSend webhook, after it has verified
   the provider's server-to-server confirmation) calls applyVerifiedPayment; the refund executor calls refundAllocation.
   No browser, merchant or admin client can reach this file; `invoices` and its subcollections are write:false in rules.

     applyVerifiedPayment(db, { invoiceId, paymentId, amountCents, currency, provider, providerRef, FieldValue })
       → ONE allocation per verified payment: invoices/{id}/allocations/{paymentId} via create() — a duplicate / replayed
         webhook is a no-op (replay:true). Recomputes paidCents / balanceCents / status in the SAME transaction.
         Returns a receipt payload for the caller to record AFTER commit (one receipt per payment).
     refundAllocation(db, { invoiceId, paymentId, refundId, refundCents, FieldValue })
       → one refund per refundId (allocations/{paymentId}/refunds/{refundId} via create()); recomputes the invoice.
   Refused (never partially applied): unknown / non-canonical invoice, draft or void invoice, currency mismatch,
   non-integer or non-positive amounts, a refund larger than what that payment still holds.

   OVERPAYMENT (owner 2026-10-04): the verified amount RECEIVED is split into the amount APPLIED to the invoice
   (≤ its balance) and an EXCESS that is HELD separately (invoiceExcessHolds/{paymentId}, status 'held') and flagged for
   review — never credited to the merchant. The receipt payload carries receivedCents / appliedCents / excessHeldCents so
   no receipt represents more money than was resolved. Settlement (commission + wallet) is on appliedCents only.
   An admin resolves a hold (refund or an approved alternative) — auditable and idempotent, outside this module.
   ════════════════════════════════════════════════════════════════════════════════════════════════════════ */
'use strict';

const M = require('./shared/invoice-model');

const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
class AllocationError extends Error { constructor(code, msg) { super(msg); this.code = code; } }
const bad = (code, msg) => { throw new AllocationError(code, msg); };

async function applyVerifiedPayment(db, p) {
  const { invoiceId, paymentId, amountCents, currency, provider, providerRef, FieldValue } = p || {};
  if (!ID_RE.test(String(invoiceId || ''))) bad('invalid', 'invoiceId');
  if (!ID_RE.test(String(paymentId || ''))) bad('invalid', 'paymentId');
  if (!Number.isInteger(amountCents) || amountCents <= 0) bad('invalid', 'amountCents must be a positive integer');
  const invRef = db.collection('invoices').doc(String(invoiceId));
  const allocRef = invRef.collection('allocations').doc(String(paymentId));
  return db.runTransaction(async (t) => {
    const [inv, alloc] = await Promise.all([t.get(invRef), t.get(allocRef)]);
    if (!inv.exists) bad('not_found', 'invoice not found');
    const x = inv.data() || {};
    if (alloc.exists) return { ok: true, replay: true, invoiceId, paymentId, status: x.status };
    if (!M.SOURCES.includes(x.source)) bad('not_canonical', 'invoice is not canonical (no source) — migrate it first');
    if (x.status === 'void' || x.status === 'draft') bad('not_payable', 'a ' + x.status + ' invoice cannot take a payment');
    if (currency && x.currency && String(currency).toUpperCase() !== String(x.currency).toUpperCase()) bad('currency', 'currency mismatch');
    const totalCents = Number.isInteger(x.totalCents) ? x.totalCents : M.toCents(x.total);
    if (!Number.isInteger(totalCents)) bad('invalid_invoice', 'invoice total unreadable');
    const prevPaid = Number.isInteger(x.paidCents) ? x.paidCents : 0;
    const balanceBefore = Math.max(0, totalCents - prevPaid);
    const appliedCents = Math.min(amountCents, balanceBefore);
    const excessCents = amountCents - appliedCents;
    const totals = M.totalsOf(totalCents, [{ status: 'succeeded', amountCents: prevPaid + appliedCents }]);
    const status = M.statusOf(x.status, totals);
    const cur = x.currency || currency || 'KES';
    t.create(allocRef, { paymentId: String(paymentId), status: 'succeeded', receivedCents: amountCents, amountCents: appliedCents, excessHeldCents: excessCents,
      refundedCents: 0, currency: cur, provider: provider || 'intasend', providerRef: providerRef || null, verified: true, createdAt: FieldValue.serverTimestamp() });
    if (excessCents > 0) {
      t.create(db.collection('invoiceExcessHolds').doc(String(paymentId)), { paymentId: String(paymentId), invoiceId: String(invoiceId), excessCents, currency: cur,
        status: 'held', reason: 'overpayment', provider: provider || 'intasend', providerRef: providerRef || null, createdAt: FieldValue.serverTimestamp() });
    }
    t.update(invRef, { totalCents, paidCents: totals.paidCents, balanceCents: totals.balanceCents, overpaidCents: 0,
      status, paymentStatus: 'succeeded', lastVerifiedPaymentAt: FieldValue.serverTimestamp(), allocationCount: FieldValue.increment(1),
      ...(excessCents > 0 ? { excessHeldCents: FieldValue.increment(excessCents), reviewFlag: 'overpaid' } : {}),
      ...(status === 'paid' && x.status !== 'paid' ? { paidAt: FieldValue.serverTimestamp() } : {}), updatedAt: FieldValue.serverTimestamp() });
    return { ok: true, replay: false, invoiceId, paymentId, status, paidCents: totals.paidCents, balanceCents: totals.balanceCents,
      receivedCents: amountCents, appliedCents, excessHeldCents: excessCents,
      /* settle (commission + wallet) on appliedCents ONLY; the excess stays held */
      receipt: { kind: 'invoice_payment', invoiceId, paymentId, receivedCents: amountCents, appliedCents, excessHeldCents: excessCents, currency: cur, invoiceNumber: x.invoiceNumber || null } };
  });
}

async function refundAllocation(db, p) {
  const { invoiceId, paymentId, refundId, refundCents, FieldValue } = p || {};
  if (!ID_RE.test(String(invoiceId || '')) || !ID_RE.test(String(paymentId || '')) || !ID_RE.test(String(refundId || ''))) bad('invalid', 'ids');
  if (!Number.isInteger(refundCents) || refundCents <= 0) bad('invalid', 'refundCents must be a positive integer');
  const invRef = db.collection('invoices').doc(String(invoiceId));
  const allocRef = invRef.collection('allocations').doc(String(paymentId));
  const refRef = allocRef.collection('refunds').doc(String(refundId));
  return db.runTransaction(async (t) => {
    const [inv, alloc, rf] = await Promise.all([t.get(invRef), t.get(allocRef), t.get(refRef)]);
    if (rf.exists) return { ok: true, replay: true };
    if (!inv.exists || !alloc.exists) bad('not_found', 'invoice or allocation not found');
    const a = alloc.data() || {}, x = inv.data() || {};
    if (a.status !== 'succeeded' && a.status !== 'refunded') bad('not_refundable', 'allocation is ' + a.status);
    const already = Number.isInteger(a.refundedCents) ? a.refundedCents : 0;
    if (refundCents > a.amountCents - already) bad('too_much', 'refund exceeds what this payment still holds');
    const newRefunded = already + refundCents;
    const paid = (Number.isInteger(x.paidCents) ? x.paidCents : 0) - refundCents;
    const totalCents = Number.isInteger(x.totalCents) ? x.totalCents : M.toCents(x.total);
    const totals = M.totalsOf(totalCents, [{ status: 'succeeded', amountCents: Math.max(0, paid) }]);
    /* a refunded invoice re-opens: paid → partially_paid / issued (statusOf from facts) */
    const reopened = x.status === 'void' ? 'void' : (x.status === 'paid' || x.status === 'partially_paid' ? 'issued' : x.status);
    const status = M.statusOf(reopened, totals);
    t.create(refRef, { refundId: String(refundId), refundCents, createdAt: FieldValue.serverTimestamp() });
    t.update(allocRef, { refundedCents: newRefunded, status: newRefunded >= a.amountCents ? 'refunded' : 'succeeded', updatedAt: FieldValue.serverTimestamp() });
    t.update(invRef, { paidCents: totals.paidCents, balanceCents: totals.balanceCents, overpaidCents: totals.overpaidCents, status,
      paymentStatus: totals.paidCents === 0 ? 'refunded' : 'succeeded', updatedAt: FieldValue.serverTimestamp() });
    return { ok: true, replay: false, status, paidCents: totals.paidCents, balanceCents: totals.balanceCents };
  });
}

module.exports = { applyVerifiedPayment, refundAllocation, AllocationError };
