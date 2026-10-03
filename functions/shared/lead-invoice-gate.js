/* ============================================================================
   B2B LEAD INVOICE GATE PREDICATE — the ONE definition of "overdue" (owner 2026-10-03)
   ----------------------------------------------------------------------------
   An ISSUED lead invoice (b2bLeadMonths, status 'issued', outstandingKES > 0) unpaid for more than 2 days after its
   successful issue (issuedAtMs) is overdue. Consumed by:
     • b2b-leads.leadInvoiceGate  (commercial line — the producer's public name)
     • pos-commission-rail.evaluateMerchantGate (gated POS line — the second reason inside the one till gate)
   This file is carried BYTE-IDENTICAL on both lines so neither depends on a module the other line lacks (the deploy
   require-closure gate refuses a missing module, even an optional one). The assembly check compares the two copies.
   Pure read; never writes. `enforce` is always false here — enforcement is the consumer's switch, turned on only in
   the certified lead-invoice Pay Now unit.
   ============================================================================ */
'use strict';

const MONTHS = 'b2bLeadMonths';
const OVERDUE_MS = 2 * 86400000;
const _r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

async function evaluate(db, uid, nowMs) {
  const now = Number(nowMs) || Date.now();
  const snap = await db.collection(MONTHS).where('billToUid', '==', String(uid)).where('status', '==', 'issued').limit(100).get();
  const over = snap.docs.map((d) => Object.assign({ invoiceKey: d.id }, d.data() || {}))
    .filter((m) => Number(m.outstandingKES) > 0 && Number(m.issuedAtMs) > 0 && now - Number(m.issuedAtMs) > OVERDUE_MS)
    .sort((a, b) => Number(a.issuedAtMs) - Number(b.issuedAtMs));
  return {
    overdue: over.length > 0,
    overdueKES: _r2(over.reduce((t, m) => t + _r2(m.outstandingKES), 0)),
    invoiceKeys: over.map((m) => m.invoiceKey),
    since: over.length ? Number(over[0].issuedAtMs) + OVERDUE_MS : null,
    enforce: false,
  };
}

module.exports = { evaluate, OVERDUE_MS, MONTHS };
