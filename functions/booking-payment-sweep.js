'use strict';
/* ============================================================================
   SOKONI — Service-booking payment expiry  functions/booking-payment-sweep.js
   Phase E WS1 (docs/BOOKING_PAYMENT_CONTRACT.md invariant 4).

   A `providerBookings` doc is created (pending, slot-locked) so the customer can
   pay. If it is NOT paid within the intent TTL (15 min), it must self-clean:
   release the slot lock, cancel the booking (reason: payment-expired), and
   invalidate the payment intent — so a stale unpaid booking never lingers or
   holds a slot other customers could book. Terminal + idempotent.

   The pure decision (is this booking expired?) is exported for unit testing; the
   scheduled function applies it transactionally.
   ========================================================================== */
const admin = require('firebase-admin');
const rc = require('./reservation-core');

const TTL_MS = 15 * 60 * 1000;

/** Pure: an unpaid pending booking past the TTL is expired. */
function isExpired(booking, nowMs, ttlMs = TTL_MS) {
  if (!booking) return false;
  if (booking.status !== 'pending') return false;                 /* only pending holds a payable slot */
  if (booking.paymentStatus && booking.paymentStatus !== 'pending') return false; /* paid/settled/refunded */
  const createdMs = booking.createdAt && booking.createdAt.toMillis ? booking.createdAt.toMillis() : 0;
  return createdMs > 0 && createdMs <= (nowMs - ttlMs);
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
  try {
    const bRef = db.collection('providerBookings').doc(bookingId);
    const held = await db.runTransaction(async (txn) => {
      const bSnap = await txn.get(bRef);
      if (!bSnap.exists) return false;
      const b = bSnap.data();
      if (['paid_held', 'settled', 'refunded'].includes(b.paymentStatus)) return false;  /* replay-safe no-op */
      txn.update(bRef, {
        paymentStatus: 'paid_held',
        heldAmount:    Math.round(amountKES * 100),   /* cents held (price + fee) */
        paymentRef:    apiRef,
        paidAt:        adminSdk.firestore.FieldValue.serverTimestamp(),
        updatedAt:     adminSdk.firestore.FieldValue.serverTimestamp(),
      });
      return true;
    });
    await db.collection('paymentIntents').doc(intentRef || apiRef)
      .set({ status: 'paid', paidRef: apiRef, paidAt: adminSdk.firestore.FieldValue.serverTimestamp() }, { merge: true }).catch(() => {});
    if (held) {
      try {
        const { notify } = require('./notify');
        const b = (await bRef.get()).data() || {};
        if (b.customerUid) notify({ uid: b.customerUid, type: 'booking_paid', title: 'Payment received ✅',
          body: `Your booking is paid and held. The provider will confirm shortly. Ref ${apiRef}.`, dedupeKey: `booking_paid_${apiRef}` }).catch(() => {});
        if (b.providerId) notify({ uid: b.providerId, type: 'booking_new', title: 'New paid booking 📅',
          body: `A customer has paid for a booking${b.service ? ' — ' + b.service : ''}. Ref ${apiRef}.`, dedupeKey: `booking_new_${apiRef}` }).catch(() => {});
      } catch (_) { /* notify optional */ }
    }
    console.log(`[webhook] service booking ${held ? 'HELD' : 'already processed'} (no wallet credit): ${apiRef} -> ${bookingId}`);
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
