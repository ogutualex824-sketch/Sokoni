'use strict';
/* ============================================================================
   SOKONI — Service-booking payment expiry  functions/booking-payment-sweep.js
   Phase E WS1 (docs/BOOKING_PAYMENT_CONTRACT.md invariant 4).

   A `providerBookings` doc is created (pending, slot-locked) so the customer can
   pay. If it is NOT paid within its hold window (`expiresAt`, now 5 min; legacy docs
   fall back to createdAt + 15-min TTL), it must self-clean:
   release the slot lock, cancel the booking (reason: payment-expired), and
   invalidate the payment intent — so a stale unpaid booking never lingers or
   holds a slot other customers could book. Terminal + idempotent.

   The pure decision (is this booking expired?) is exported for unit testing; the
   scheduled function applies it transactionally.
   ========================================================================== */
const admin = require('firebase-admin');
const rc = require('./reservation-core');

const TTL_MS = 15 * 60 * 1000;

/** Pure: an unpaid pending booking past its hold window is expired.
 *  Prefers the explicit `expiresAt` hold stamp (now = 5 min, set at create); falls back
 *  to createdAt + TTL for legacy bookings written before the hold window existed. */
function isExpired(booking, nowMs, ttlMs = TTL_MS) {
  if (!booking) return false;
  if (booking.status !== 'pending') return false;                 /* only pending holds a payable slot */
  if (booking.paymentStatus && booking.paymentStatus !== 'pending') return false; /* paid/settled/refunded */
  const expMs = booking.expiresAt && booking.expiresAt.toMillis ? booking.expiresAt.toMillis() : 0;
  if (expMs > 0) return nowMs >= expMs;                           /* explicit hold window */
  const createdMs = booking.createdAt && booking.createdAt.toMillis ? booking.createdAt.toMillis() : 0;
  return createdMs > 0 && createdMs <= (nowMs - ttlMs);           /* legacy fallback (unchanged) */
}

function _slotLockRef(db, providerId, b) {
  const key = b.slotKey || ((b.date && b.startTs && b.endTs) ? rc.slotKey(b.date, b.startTs, b.endTs) : null);
  return key ? db.collection('providerAvailability').doc(providerId).collection('slotLocks').doc(String(key)) : null;
}

exports.isExpired = isExpired;

/* ── Webhook hold (called from BOTH IntaSend COMPLETE handlers) ────────────────
   A service-booking payment is HELD until completion; the provider is credited
   ONLY by Phase C settlement (contract invariant 1). Marks the booking `paid_held`
   and moves NO money. Returns true when it handled the payment (caller must then
   respond 200 + return, skipping ALL credit logic). Anti-tamper: bookingId from the
   SERVER-MINTED intent, never client meta. Replay-safe: guarded on the booking's own
   paymentStatus, so a duplicate or post-settlement delivery is a complete no-op. */
async function holdServiceBookingPayment(db, adminSdk, apiRef, intentRef, amountKES) {
  let bookingId = null;
  try {
    const iSnap = await db.collection('paymentIntents').doc(intentRef || apiRef).get();
    if (iSnap.exists && iSnap.data().resourceType === 'providerBooking') bookingId = iSnap.data().resourceId || null;
  } catch (_) { return false; }
  if (!bookingId) return false;
  /* Terminal lifecycle states: the booking has died and released its slot; a payment
     landing now can NEVER become a valid held booking. Consult the booking STATE MACHINE,
     not just paymentStatus — the two can disagree in the expiry→webhook race (expiry sets
     status:'cancelled' but leaves paymentStatus:'pending'). */
  const TERMINAL = ['cancelled', 'declined', 'no_show'];
  const FV = adminSdk.firestore.FieldValue;
  try {
    const bRef = db.collection('providerBookings').doc(bookingId);
    /* outcome: 'held' | 'refunded' | 'noop' | 'no-booking' — drives intent status + notify. */
    const res = await db.runTransaction(async (txn) => {
      const bSnap = await txn.get(bRef);
      if (!bSnap.exists) return { outcome: 'no-booking' };
      const b = bSnap.data();
      if (['paid_held', 'settled', 'refunded'].includes(b.paymentStatus)) return { outcome: 'noop' };  /* replay-safe no-op */

      /* Race fix: payment arrived AFTER the booking became terminal (e.g. TTL expiry cancelled
         it). Do NOT revive it — the slot is gone and no settlement will run. A system/expiry
         cancellation is a FULL refund (no forfeit): return the payment to the customer wallet,
         the platform's established refund destination (matches _disburseHeldFunds). */
      if (TERMINAL.includes(b.status)) {
        const shillings = Math.max(0, Math.floor(Number(amountKES) || 0));
        if (shillings >= 1 && b.customerUid) {
          txn.set(db.collection('users').doc(b.customerUid), { walletBalance: FV.increment(shillings) }, { merge: true });
          /* deterministic ledger id → double-credit-proof even under txn retry (belt & suspenders
             on top of the paymentStatus guard, which already makes a replay a no-op). */
          txn.set(db.collection('ledger').doc(`${b.customerUid}_${apiRef}_latepay_refund`), {
            uid: b.customerUid, type: 'booking_refund', credit: shillings, bookingId,
            reason: 'paid-after-' + b.status, createdAt: FV.serverTimestamp(),
          });
        }
        txn.update(bRef, {
          paymentStatus: 'refunded',
          refundedCents: Math.round((Number(amountKES) || 0) * 100),
          refundReason:  'paid-after-' + b.status,   /* audit: why a cancelled booking is 'refunded' */
          paymentRef:    apiRef,
          updatedAt:     FV.serverTimestamp(),
        });
        return { outcome: 'refunded', shillings, customerUid: b.customerUid, status: b.status };
      }

      /* Active booking → hold as before. Clear the pre-payment expiry stamp so the
         sweep never treats a paid booking as an abandoned hold. */
      txn.update(bRef, {
        paymentStatus: 'paid_held',
        heldAmount:    Math.round(amountKES * 100),   /* cents held (price + fee) */
        paymentRef:    apiRef,
        paidAt:        FV.serverTimestamp(),
        expiresAt:     FV.delete(),
        updatedAt:     FV.serverTimestamp(),
      });
      return { outcome: 'held' };
    });

    /* Intent status mirrors the outcome so a re-read of the intent is truthful. */
    const intentStatus = res.outcome === 'refunded' ? 'refunded' : res.outcome === 'held' ? 'paid' : null;
    if (intentStatus) {
      await db.collection('paymentIntents').doc(intentRef || apiRef)
        .set({ status: intentStatus, paidRef: apiRef, paidAt: FV.serverTimestamp() }, { merge: true }).catch(() => {});
    }

    try {
      const { notify } = require('./notify');
      if (res.outcome === 'held') {
        const b = (await bRef.get()).data() || {};
        if (b.customerUid) notify({ uid: b.customerUid, type: 'booking_paid', title: 'Payment received ✅',
          body: `Your booking is paid and held. The provider will confirm shortly. Ref ${apiRef}.`, dedupeKey: `booking_paid_${apiRef}` }).catch(() => {});
        if (b.providerId) notify({ uid: b.providerId, type: 'booking_new', title: 'New paid booking 📅',
          body: `A customer has paid for a booking${b.service ? ' — ' + b.service : ''}. Ref ${apiRef}.`, dedupeKey: `booking_new_${apiRef}` }).catch(() => {});
      } else if (res.outcome === 'refunded' && res.customerUid) {
        notify({ uid: res.customerUid, type: 'booking_refund', title: 'Payment refunded ↩',
          body: `That time slot was no longer available, so your payment has been refunded to your SOKONI wallet. Ref ${apiRef}.`, dedupeKey: `booking_latepay_refund_${apiRef}` }).catch(() => {});
      }
    } catch (_) { /* notify optional */ }

    console.log(`[webhook] service booking ${res.outcome} (${res.outcome === 'refunded' ? 'refunded to wallet, slot had expired' : 'no wallet credit'}): ${apiRef} -> ${bookingId}`);
  } catch (e) {
    console.error('[webhook] service-booking hold failed (recoverable, payment stands):', e.message);
  }
  return true;   /* handled — caller must skip all credit logic */
}
exports.holdServiceBookingPayment = holdServiceBookingPayment;

/* Reap unpaid service bookings past the TTL. A PLAIN function (no scheduler) — it is
   invoked from the EXISTING every-5-min `bookingCleanupHolds` scheduled maintenance job
   so no new Cloud Run service is added. Returns the count expired. */
async function expireUnpaidServiceBookings(db) {
  db = db || admin.firestore();
  const now = Date.now();
  /* Single-field query (auto-indexed): all unpaid-pending service bookings; createdAt/TTL
     is filtered in memory to avoid a composite index. */
  const snap = await db.collection('providerBookings')
    .where('paymentStatus', '==', 'pending').limit(400).get().catch(() => null);
  if (!snap || snap.empty) return 0;

  let expired = 0;
  for (const doc of snap.docs) {
    if (!isExpired(doc.data(), now)) continue;
    try {
      const ok = await db.runTransaction(async (t) => {
        const s = await t.get(doc.ref);
        if (!s.exists || !isExpired(s.data(), Date.now())) return false;   /* raced → skip */
        const cur = s.data();
        t.update(doc.ref, {
          status: 'cancelled', cancelReason: 'payment-expired', cancelledBy: 'system',
          cancelledAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        const lock = _slotLockRef(db, cur.providerId, cur);
        if (lock) t.delete(lock);
        return true;
      });
      if (ok) {
        const pref = doc.data().paymentRef;
        if (pref) await db.collection('paymentIntents').doc(pref).set({ status: 'expired' }, { merge: true }).catch(() => {});
        expired++;
      }
    } catch (e) { console.error('[expireUnpaidServiceBookings] failed', doc.id, e.message); }
  }
  if (expired) console.log(`[expireUnpaidServiceBookings] expired ${expired} unpaid pending booking(s)`);
  return expired;
}
exports.expireUnpaidServiceBookings = expireUnpaidServiceBookings;
