'use strict';
/**
 * Provider-booking hooks onto the platform transaction receipt (functions/transaction-receipts.js, sokoni-2f contract
 * 5d799e6, docs/TRANSACTION_RECEIPTS_2026-10-03.md). Owner decision 2026-10-03: every paid booking / accepted quote has
 * an invoice/receipt through the SHARED billing system — no Legal (or any hub) receipt system.
 *
 * Every hook runs AFTER the money step has committed and goes through receipts.safely(): it never throws and never
 * blocks or reverses money; a failure is queued for the receipts sweep. Exactly-once comes from the receipt module
 * (paid: one receipt per source; events: deterministic opKey).
 *
 *   paid(db, bookingId, apiRef)                    webhook → paid_held
 *   released(db, bookingId, m, opKey?)             PIN release / show-up settlement (m = provider-ops _settlementMath)
 *   refunded(db, bookingId, amountCents, opKey, reason)
 *   forfeitReleased(db, bookingId, forfeitC, commissionC, netC)   no-show / late-cancel deposit kept by the provider
 */
const R = require('../transaction-receipts');

/* A booking converted from an accepted quote is receipted as a 'quote'; every other provider booking as 'service_booking'. */
function kindOf(b) { return b && (b.leadId || b.quoteId) ? 'quote' : 'service_booking'; }
async function _booking(db, bookingId) { const s = await db.collection('providerBookings').doc(String(bookingId)).get(); return s.exists ? s.data() : null; }

/* taxTreatment is RECORDED, never computed: an active provider eTIMS registration (profile + credentials) means the
   provider issues the fiscal invoice; anything else is 'unknown'. No VAT figure is ever inferred here. */
async function _taxTreatment(db, providerId) {
  if (!providerId) return 'unknown';
  const [p, c] = await Promise.all([db.collection('etimsProfiles').doc(String(providerId)).get(), db.collection('etimsCredentials').doc(String(providerId)).get()]);
  return p.exists && c.exists && (p.data() || {}).active !== false ? 'provider_fiscal_invoice' : 'unknown';
}

async function paid(db, bookingId, apiRef, deps) {
  return R.safely(db, 'receipt.paid:' + bookingId, async () => {
    const b = await _booking(db, bookingId);
    if (!b || b.paymentStatus !== 'paid_held' && b.paymentStatus !== 'refunded') return { ok: false, reason: 'not_paid' };
    const [pay, prov, taxTreatment] = await Promise.all([
      db.collection('payments').doc(String(apiRef)).get().catch(() => null),
      db.collection('providers').doc(String(b.providerId)).get().catch(() => null),
      _taxTreatment(db, b.providerId),
    ]);
    const p = prov && prov.exists ? prov.data() : {};
    const heldCents = Math.round(Number(b.heldAmount) || 0) || (Math.round(Number(b.price) || 0) + Math.round(Number(b.fee) || 0));
    return R.recordPaid(db, {
      kind: kindOf(b), sourceId: String(bookingId), clientUid: b.customerUid, counterpartyId: b.providerId,
      counterpartyName: p.businessName || p.name || null, serviceLabel: b.service || null,
      quotedCents: Math.round(Number(b.price) || 0) + Math.round(Number(b.fee) || 0), paidCents: heldCents,
      paymentRef: String(apiRef), providerRef: (pay && pay.exists && (pay.data() || {}).invoiceId) || null,
      /* IntaSend's own method string as the webhook stored it (5b 525fd9f); null = not reported — never guessed */
      method: (pay && pay.exists && (pay.data() || {}).providerMethod) || null,
      taxTreatment,
    }, deps);
  });
}

async function released(db, bookingId, m, opKey, deps) {
  return R.safely(db, 'receipt.released:' + bookingId, async () => {
    const b = await _booking(db, bookingId);
    if (!b) return { ok: false, reason: 'no_booking' };
    return R.recordEvent(db, R.receiptIdFor(kindOf(b), bookingId), {
      type: 'released', amountCents: Math.round(Number(m.settleCents) || 0) + Math.round(Number(m.commission) || 0),
      platformFeeCents: Math.round(Number(m.commission) || 0), providerNetCents: Math.round(Number(m.net) || 0),
      opKey: opKey || String(bookingId),
    }, deps);
  });
}

async function refunded(db, bookingId, amountCents, opKey, reason, deps) {
  return R.safely(db, 'receipt.refunded:' + bookingId, async () => {
    const amt = Math.round(Number(amountCents) || 0);
    if (amt <= 0) return { ok: true, skipped: 'nothing_refunded' };
    const b = await _booking(db, bookingId);
    if (!b) return { ok: false, reason: 'no_booking' };
    return R.recordEvent(db, R.receiptIdFor(kindOf(b), bookingId), { type: 'refunded', amountCents: amt, opKey: String(opKey), reason: reason || null }, deps);
  });
}

async function forfeitReleased(db, bookingId, forfeitC, commissionC, netC, deps) {
  return R.safely(db, 'receipt.forfeit:' + bookingId, async () => {
    if (!(Number(forfeitC) > 0)) return { ok: true, skipped: 'no_forfeit' };
    const b = await _booking(db, bookingId);
    if (!b) return { ok: false, reason: 'no_booking' };
    return R.recordEvent(db, R.receiptIdFor(kindOf(b), bookingId), { type: 'released', amountCents: Math.round(forfeitC),
      platformFeeCents: Math.round(Number(commissionC) || 0), providerNetCents: Math.round(Number(netC) || 0), opKey: String(bookingId) + '_forfeit' }, deps);
  });
}

module.exports = { kindOf, paid, released, refunded, forfeitReleased, _taxTreatment };
