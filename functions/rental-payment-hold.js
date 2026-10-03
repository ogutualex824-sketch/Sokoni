'use strict';
/**
 * Rental payments — the webhook half of the rental_booking contract (2f b2b8158 intent · f3 rentals lifecycle).
 *
 * A verified rental_booking payment is HELD, never credited here: the shop owner is paid only when the renter's
 * ONE PIN at RETURN completes the rental (owner rule 2026-10-03; f3 rentalConfirmReturn → settlement). This module:
 *   • applies only to an intent with resourceType 'rentalBooking' (returns false otherwise — the webhook falls through);
 *   • requires the callback's gross to equal the intent's amountCents (rent + deposit) to the cent, AND IntaSend's own
 *     server-to-server confirmation (injected `confirm`) — a callback body is a claim, not evidence;
 *   • the payer on the intent must be the booking's renter (buyerId);
 *   • moves an accepted / confirmed / payment_pending rental to status 'paid_held', paymentStatus 'held',
 *     heldAmountCents, depositCents, paymentRef, paidAt, providerMethod — in ONE transaction, replay-safe;
 *   • a payment for a rental that is already cancelled / declined / closed is NEVER held: paymentStatus 'refund_due'
 *     and a review row (commissionReviewQueue/rental_refund_{ref}). No wallet is credited (wallet FROZEN) — a person
 *     refunds through the IntaSend refund path;
 *   • anything it cannot prove is PARKED for review (commissionReviewQueue/rental_{reason}_{ref}) and returns true,
 *     so no later webhook step can credit it.
 */

const PAYABLE  = ['accepted', 'confirmed', 'payment_pending'];
const SETTLED  = ['held', 'released', 'refunded', 'refund_due'];

/**
 * @param {*} db
 * @param {*} adminSdk
 * @param {{ apiRef:string, intentRef?:string, grossAmount:any, providerMethod?:string|null,
 *           confirm:(expectedCents:number)=>Promise<{ok:boolean, reason?:string}> }} p
 * @returns {Promise<false|{outcome:string, reason?:string}>}
 */
async function holdRentalBookingPayment(db, adminSdk, p) {
  const FV = adminSdk.firestore.FieldValue;
  const apiRef = String(p.apiRef || '');
  const intentId = String(p.intentRef || apiRef);
  let intent;
  try {
    const iSnap = await db.collection('paymentIntents').doc(intentId).get();
    intent = iSnap.exists ? (iSnap.data() || {}) : null;
  } catch (_) { return false; }
  if (!intent || intent.resourceType !== 'rentalBooking') return false;

  const bookingId = String(intent.resourceId || (intent.metadata && intent.metadata.bookingId) || '');
  const park = async (reason, extra) => {
    await db.collection('commissionReviewQueue').doc(`rental_${reason}_${apiRef}`).set(Object.assign({
      kind: 'rental_payment', reason, paymentRef: apiRef, intentRef: intentId, bookingId: bookingId || null,
      expectedAmountCents: Number.isInteger(intent.amountCents) ? intent.amountCents : null,
      status: 'open', createdAt: FV.serverTimestamp(),
    }, extra || {}), { merge: true });
    return { outcome: 'parked', reason };
  };

  if (!bookingId || /[/]/.test(bookingId)) return park('no_booking_ref');
  const expected = intent.amountCents;
  if (!Number.isInteger(expected) || expected <= 0) return park('missing_evidence');
  const grossCents = Math.round(Number(p.grossAmount) * 100);
  if (!Number.isFinite(grossCents) || grossCents !== expected) return park('amount_mismatch', { confirmedGrossCents: Number.isFinite(grossCents) ? grossCents : null });
  if (intent.currency && String(intent.currency).toUpperCase() !== 'KES') return park('currency_mismatch');

  let pc;
  try { pc = await p.confirm(expected); } catch (_) { pc = { ok: false, reason: 'provider_unreachable' }; }
  if (!pc || pc.ok !== true) return park((pc && pc.reason) || 'provider_unconfirmed');

  const bRef = db.collection('rentalBookings').doc(bookingId);
  const meta = intent.metadata || {};
  const res = await db.runTransaction(async (txn) => {
    const bSnap = await txn.get(bRef);
    if (!bSnap.exists) return { outcome: 'park', reason: 'no_booking' };
    const b = bSnap.data() || {};
    if (SETTLED.includes(String(b.paymentStatus || ''))) return { outcome: 'noop' };            /* replay-safe */
    const payer = intent.uid || intent.ownerUid || null;
    if (!payer || !b.buyerId || payer !== b.buyerId) return { outcome: 'park', reason: 'payer_not_renter' };

    if (!PAYABLE.includes(String(b.status || ''))) {
      /* paid AFTER the rental died (cancelled / declined / closed) — never revive it; a refund is owed */
      txn.update(bRef, { paymentStatus: 'refund_due', refundDueCents: grossCents, refundReason: 'paid-after-' + (b.status || 'unknown'),
        paymentRef: apiRef, providerMethod: p.providerMethod || null, updatedAt: FV.serverTimestamp() });
      txn.set(db.collection('commissionReviewQueue').doc(`rental_refund_${apiRef}`), {
        kind: 'rental_refund_due', reason: 'paid-after-' + (b.status || 'unknown'), paymentRef: apiRef, intentRef: intentId, bookingId,
        refundDueCents: grossCents, renterUid: b.buyerId, status: 'open', createdAt: FV.serverTimestamp() });
      return { outcome: 'refund_due', status: b.status || null };
    }
    txn.update(bRef, {
      status: 'paid_held', paymentStatus: 'held',
      heldAmountCents: grossCents,
      depositCents: Number.isInteger(meta.depositCents) ? meta.depositCents : (Number.isInteger(b.depositCents) ? b.depositCents : null),
      paymentRef: apiRef, intentRef: intentId, providerMethod: p.providerMethod || null,
      invoiceId: p.invoiceId ? String(p.invoiceId) : null,   /* IntaSend's id for THIS payment — a refund (deposit) is raised against it, never api_ref */   /* intentRef: settlement prices from the SERVER intent */
      paidAt: FV.serverTimestamp(), updatedAt: FV.serverTimestamp(),
    });
    return { outcome: 'held' };
  });
  if (res.outcome === 'park') return park(res.reason);

  const intentStatus = res.outcome === 'held' ? 'paid' : res.outcome === 'refund_due' ? 'refund_due' : null;
  if (intentStatus) {
    await db.collection('paymentIntents').doc(intentId).set({ status: intentStatus, paymentRef: apiRef, updatedAt: FV.serverTimestamp() }, { merge: true })
      .catch(() => {});   /* the booking is the authority; the intent mirror never undoes it */
  }
  return res;
}

module.exports = { holdRentalBookingPayment, PAYABLE };
