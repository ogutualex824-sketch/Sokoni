'use strict';
/**
 * Provider-booking hooks onto the platform transaction receipt — sokoni-2f contract v2 (commercial-fn 65e85d1,
 * docs/TRANSACTION_RECEIPTS_2026-10-03.md). Owner decision 2026-10-03: every paid booking / accepted quote has an
 * invoice/receipt through the SHARED billing system — no Legal (or any hub) receipt system.
 *
 * Guarantees:
 *   · runs AFTER the money step committed; NEVER throws (not even if the receipts module cannot load) and never blocks
 *     or reverses money;
 *   · every write goes through receipts.safely(db, label, fn, replay) WITH a replay descriptor, so a failure is queued and
 *     replayed by the 6-hour sweep / Super Admin retry — deterministic ids make exactly one receipt / event;
 *   · releases are BALANCED (contract v2): amount = held (price + fee) = platform fee (commission) + provider settlement
 *     (net + fee). A quote-converted booking is ONE receipt of kind 'quote' (sourceId = quoteId) linking quote + booking.
 *
 *   paid(db, bookingId, apiRef) · released(db, bookingId, m) · refunded(db, bookingId, amountCents, opKey, reason)
 *   forfeitReleased(db, bookingId, forfeitC, commissionC, netC)
 */
function _R() { try { return require('../transaction-receipts'); } catch (_) { return null; } }

function _ident(bookingId, b) {
  const q = b && (b.quoteId || b.leadId);
  return q ? { kind: 'quote', sourceId: String(q), links: { quoteId: String(q), bookingId: String(bookingId) } }
    : { kind: 'service_booking', sourceId: String(bookingId), links: { bookingId: String(bookingId) } };
}
function kindOf(b) { return _ident('x', b).kind; }
const _held = (b) => Math.round(Number(b.heldAmount) || 0) || (Math.round(Number(b.price) || 0) + Math.round(Number(b.fee) || 0));
async function _booking(db, bookingId) { const s = await db.collection('providerBookings').doc(String(bookingId)).get(); return s.exists ? s.data() : null; }

/* taxTreatment is RECORDED, never computed: an active provider eTIMS registration (profile + credentials) means the
   provider issues the fiscal invoice; anything else is 'unknown'. No VAT figure is ever inferred here. */
async function _taxTreatment(db, providerId) {
  if (!providerId) return 'unknown';
  const [p, c] = await Promise.all([db.collection('etimsProfiles').doc(String(providerId)).get(), db.collection('etimsCredentials').doc(String(providerId)).get()]);
  return p.exists && c.exists && (p.data() || {}).active !== false ? 'provider_fiscal_invoice' : 'unknown';
}

/* never-throwing envelope around the READS that build the args (the write itself is protected by receipts.safely) */
async function _guard(label, fn) { try { return await fn(); } catch (e) { return { ok: false, reason: 'receipt_hook_error', label, error: String(e && e.message || e).slice(0, 200) }; } }

async function paid(db, bookingId, apiRef, deps) {
  return _guard('receipt.paid', async () => {
    const R = _R(); if (!R) return { ok: false, reason: 'receipts_unavailable' };
    const b = await _booking(db, bookingId);
    if (!b || (b.paymentStatus !== 'paid_held' && b.paymentStatus !== 'refunded')) return { ok: false, reason: 'not_paid' };
    const [pay, prov, taxTreatment] = await Promise.all([
      db.collection('payments').doc(String(apiRef)).get().catch(() => null),
      db.collection('providers').doc(String(b.providerId)).get().catch(() => null),
      _taxTreatment(db, b.providerId).catch(() => 'unknown'),
    ]);
    const p = prov && prov.exists ? prov.data() : {};
    const id = _ident(bookingId, b);
    const args = {
      kind: id.kind, sourceId: id.sourceId, links: id.links, clientUid: b.customerUid, counterpartyId: b.providerId,
      counterpartyName: p.businessName || p.name || null, serviceLabel: b.service || null,
      quotedCents: Math.round(Number(b.price) || 0) + Math.round(Number(b.fee) || 0), paidCents: _held(b),
      paymentRef: String(apiRef), providerRef: (pay && pay.exists && (pay.data() || {}).invoiceId) || null,
      /* IntaSend's own method string as the webhook stored it (5b 525fd9f); null = not reported (UI "—") — never guessed */
      method: (pay && pay.exists && (pay.data() || {}).providerMethod) || null,
      taxTreatment,
    };
    return R.safely(db, 'receipt.paid:' + bookingId, () => R.recordPaid(db, args, deps), { op: 'paid', args });
  });
}

async function _event(db, bookingId, mk, label, deps) {
  return _guard(label, async () => {
    const R = _R(); if (!R) return { ok: false, reason: 'receipts_unavailable' };
    const b = await _booking(db, bookingId);
    if (!b) return { ok: false, reason: 'no_booking' };
    const args = mk(b); if (!args) return { ok: true, skipped: true };
    const id = _ident(bookingId, b);
    const receiptId = R.receiptIdFor(id.kind, id.sourceId);
    return R.safely(db, label + ':' + bookingId, () => R.recordEvent(db, receiptId, args, deps), { op: 'event', receiptId, args });
  });
}

/* PIN release / show-up: the whole hold leaves escrow — SOKONI's commission + the provider's settlement (net + fee). */
function released(db, bookingId, m, deps) {
  return _event(db, bookingId, (b) => {
    const commission = Math.round(Number(m.commission) || 0), settle = Math.round(Number(m.settleCents) || 0);
    return { type: 'released', amountCents: commission + settle, platformFeeCents: commission, providerNetCents: settle, opKey: String(bookingId) };
  }, 'receipt.released', deps);
}
function refunded(db, bookingId, amountCents, opKey, reason, deps) {
  const amt = Math.round(Number(amountCents) || 0);
  if (amt <= 0) return Promise.resolve({ ok: true, skipped: 'nothing_refunded' });
  return _event(db, bookingId, () => ({ type: 'refunded', amountCents: amt, opKey: String(opKey), reason: reason || null }), 'receipt.refunded', deps);
}
/* no-show / late-cancel: the forfeited deposit is released — SOKONI's commission on it + the provider's net (balanced). */
function forfeitReleased(db, bookingId, forfeitC, commissionC, netC, deps) {
  if (!(Number(forfeitC) > 0)) return Promise.resolve({ ok: true, skipped: 'no_forfeit' });
  return _event(db, bookingId, () => ({ type: 'released', amountCents: Math.round(forfeitC), platformFeeCents: Math.round(Number(commissionC) || 0),
    providerNetCents: Math.round(Number(netC) || 0), opKey: String(bookingId) + '_forfeit' }), 'receipt.forfeit', deps);
}

module.exports = { kindOf, paid, released, refunded, forfeitReleased, _taxTreatment, _ident };
