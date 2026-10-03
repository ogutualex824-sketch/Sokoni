/* ════════════════════════════════════════════════════════════════════════════════════════════════════════
   THE canonical invoice model (owner 2026-10-04: `invoices`, restructured, is the ONE invoice).  PURE — no I/O.
   Carried byte-identical on every line that writes or reads canonical invoices (admin-invoices, finance-os,
   invoice-allocation, the migration).
   ────────────────────────────────────────────────────────────────────────────────────────────────────────
   Two separate state machines (owner):
     invoice.status   draft → issued → partially_paid → paid ;  issued|partially_paid → void (only with nothing paid)
                      "overdue" is DERIVED (issued|partially_paid past the due date), never stored as truth
     payment.status   pending | processing | succeeded | failed | refunded   (per allocation, from the payment authority)
   Money truth: an invoice's paid amount is the sum of its VERIFIED allocations (one per verified payment event).
   A merchant / client reference is a CLAIM (paymentClaim, status 'unverified') and never moves money.
   Amounts are integer CENTS in the model (paidCents / balanceCents); legacy `total` (KES float) is converted once.
   ════════════════════════════════════════════════════════════════════════════════════════════════════════ */
'use strict';

const SOURCES = Object.freeze(['order', 'booking', 'quote', 'subscription', 'commission', 'manual']);
const INVOICE_STATUS = Object.freeze(['draft', 'issued', 'partially_paid', 'paid', 'void']);
const PAYMENT_STATUS = Object.freeze(['pending', 'processing', 'succeeded', 'failed', 'refunded']);
const MODEL_VERSION = 1;

const toCents = (v) => { const n = Number(v); return Number.isFinite(n) ? Math.round(n * 100) : null; };
const isInt = (n) => Number.isInteger(n);

/** The canonical totals of an invoice from its total and its VERIFIED allocations (succeeded − refunded). */
function totalsOf(totalCents, allocations) {
  if (!isInt(totalCents) || totalCents < 0) return null;
  let paid = 0;
  for (const a of Array.isArray(allocations) ? allocations : []) {
    if (!a || !isInt(a.amountCents) || a.amountCents < 0) continue;
    const refunded = isInt(a.refundedCents) && a.refundedCents > 0 ? Math.min(a.refundedCents, a.amountCents) : 0;
    if (a.status === 'succeeded' || a.status === 'refunded') paid += a.amountCents - refunded;
  }
  return { totalCents, paidCents: paid, balanceCents: Math.max(0, totalCents - paid), overpaidCents: Math.max(0, paid - totalCents) };
}

/** Stored status from facts only. A void invoice stays void; a draft stays draft until issued. */
function statusOf(prev, totals) {
  if (prev === 'void') return 'void';
  if (prev === 'draft') return 'draft';
  if (!totals) return prev || 'issued';
  if (totals.totalCents > 0 && totals.paidCents >= totals.totalCents) return 'paid';
  if (totals.paidCents > 0) return 'partially_paid';
  return 'issued';
}

/** Display status: overdue is derived, never stored. */
function displayOf(inv, nowMs) {
  const st = String((inv && inv.status) || '');
  const due = inv && inv.dueDate ? Date.parse(inv.dueDate) : NaN;
  if ((st === 'issued' || st === 'partially_paid') && Number.isFinite(due) && due < nowMs) return { display: 'overdue', daysOverdue: Math.floor((nowMs - due) / 86400000), base: st };
  return { display: st || 'unknown', base: st };
}

/** Legal transitions for a client-callable action (the payment authority writes allocations, not statuses). */
function canTransition(from, to, totals) {
  if (from === to) return true;
  if (from === 'draft') return to === 'issued' || to === 'void';
  if (from === 'issued') return to === 'void' ? !(totals && totals.paidCents > 0) : false;
  if (from === 'partially_paid') return false;          /* money exists: only allocations / refunds move it */
  return false;                                         /* paid / void are terminal for client actions */
}

/**
 * Classify a LEGACY `invoices` doc (three shapes shared one collection):
 *   A merchant manual   shopId + clientName (finance-os invoiceCreate)          → manual
 *   B commission bill   sellerUid + period (generateMonthlyInvoices)             → commission
 *   C order invoice     orderId, or doc id == orderId (WAP invoice.generate)     → order
 * Anything else → null (UNKNOWN: excluded from authoritative totals, flagged for review).
 */
function classifyLegacy(id, d) {
  const x = d || {};
  if (SOURCES.includes(x.source)) return { source: x.source, transactionRef: x.transactionRef || null, already: true };
  if (typeof x.shopId === 'string' && x.shopId && (x.clientName || x.invoiceNumber)) return { source: 'manual', transactionRef: null };
  if (typeof x.sellerUid === 'string' && x.sellerUid && x.period) return { source: 'commission', transactionRef: { kind: 'commissionPeriod', id: String(x.period), sellerUid: x.sellerUid } };
  if (typeof x.orderId === 'string' && x.orderId) return { source: 'order', transactionRef: { kind: 'order', id: x.orderId } };
  return null;
}

module.exports = { SOURCES, INVOICE_STATUS, PAYMENT_STATUS, MODEL_VERSION, toCents, totalsOf, statusOf, displayOf, canTransition, classifyLegacy };
