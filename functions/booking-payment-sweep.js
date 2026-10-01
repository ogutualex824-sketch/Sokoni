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
const { bookingEvent, TYPES } = require('./booking-events');

const TTL_MS = 15 * 60 * 1000;

/** Pure: an unpaid booking that still holds a payable slot, past its hold window, is expired.
 *  A slot is held by either an unconfirmed `pending` booking OR an auto-confirmed one that
 *  still owes payment (price > 0) — both strand the slot if never paid. Free bookings
 *  (price 0) and any non-pending payment state are left untouched.
 *  Prefers the explicit `expiresAt` hold stamp (now = 5 min, set at create); falls back
 *  to createdAt + TTL for legacy bookings written before the hold window existed. */
function isExpired(booking, nowMs, ttlMs = TTL_MS) {
  if (!booking) return false;
  if (booking.paymentStatus && booking.paymentStatus !== 'pending') return false; /* paid/settled/refunded */
  const st = booking.status;
  const holdsSlot = st === 'pending' || (st === 'confirmed' && Number(booking.price) > 0); /* autoConfirm-unpaid too */
  if (!holdsSlot) return false;
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
      const ev = bookingEvent({
        bookingId, type: TYPES.PAYMENT_CONFIRMED, actor: 'intasend-webhook',
        providerId: b.providerId, customerUid: b.customerUid,
        previousStatus: b.status, newStatus: b.status, paymentRef: apiRef,
        data: { fromPayment: b.paymentStatus || 'pending', toPayment: 'paid_held', heldAmountCents: Math.round(amountKES * 100) },
        key: 'paid',
      });
      txn.set(ev.ref, ev.payload);
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
        /* AWAIT the provider's durable in-app notification so it is guaranteed written
           before the webhook returns — a fire-and-forget call was orphaned when the CF
           stopped after res.send(). awaitDelivery:false keeps push/email in the background
           so a slow FCM push never adds webhook latency. The customer's payment notice is
           already sent independently (payment-success.js → payment_success), so no
           booking_paid here would duplicate it. */
        if (b.providerId) {
          await notify({ uid: b.providerId, type: 'booking_new', title: 'New paid booking 📅',
            body: `A customer has paid for a booking${b.service ? ' — ' + b.service : ''}. Ref ${apiRef}.`,
            deepLink: '/provider-dashboard.html', dedupeKey: `booking_new_${apiRef}`, awaitDelivery: false })
            .catch((e) => console.error('[webhook] provider booking_new notify failed:', e.message));
        }
      } else if (res.outcome === 'refunded' && res.customerUid) {
        await notify({ uid: res.customerUid, type: 'booking_refund', title: 'Payment refunded ↩',
          body: `That time slot was no longer available, so your payment has been refunded to your SOKONI wallet. Ref ${apiRef}.`,
          dedupeKey: `booking_latepay_refund_${apiRef}`, awaitDelivery: false })
          .catch((e) => console.error('[webhook] booking_refund notify failed:', e.message));
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
        const ev = bookingEvent({
          bookingId: doc.id, type: TYPES.EXPIRED, actor: 'system',
          providerId: cur.providerId, customerUid: cur.customerUid,
          previousStatus: cur.status, newStatus: 'cancelled', paymentRef: cur.paymentRef || null,
          data: { reason: 'payment-expired' }, key: 'expired',
        });
        t.set(ev.ref, ev.payload);
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

/* ── Canonical service-booking hold release ───────────────────────────────────
   ONE release path for an unpaid slot HOLD, reused by every caller: the owner
   (bookingReleaseHold onCall — customer closed the payment sheet), the IntaSend
   webhook (terminal non-payment), and callable ad-hoc. Cancels the booking,
   deletes the slot lock, and cancels the payment intent in a single transaction.
   NEVER releases a paid hold. `ownerUid`, when given, restricts release to the
   booking's own customer; omit it for system-initiated release. Idempotent: a
   missing / paid / already-terminal booking is a clean no-op. */
const TERMINAL_STATUSES = ['cancelled', 'declined', 'no_show', 'completed'];
async function releaseServiceHold(db, adminSdk, opts) {
  db = db || admin.firestore();
  const FV = adminSdk.firestore.FieldValue;
  const bookingId = String((opts && opts.bookingId) || '');
  const { reason = 'released', by = 'system', ownerUid = null } = opts || {};
  if (!bookingId) return { released: false, reason: 'no-booking' };
  const bRef = db.collection('providerBookings').doc(bookingId);

  const res = await db.runTransaction(async (txn) => {
    const s = await txn.get(bRef);
    if (!s.exists) return { released: false, reason: 'not-found' };
    const b = s.data();
    if (ownerUid && b.customerUid !== ownerUid) return { released: false, reason: 'not-owner' };
    if ((b.paymentStatus || 'pending') !== 'pending') return { released: false, reason: 'already-paid' };
    if (TERMINAL_STATUSES.includes(b.status)) return { released: false, reason: 'already-released' };
    txn.update(bRef, {
      status: 'cancelled', cancelReason: reason, cancelledBy: by,
      cancelledAt: FV.serverTimestamp(), updatedAt: FV.serverTimestamp(), expiresAt: FV.delete(),
    });
    const lock = _slotLockRef(db, b.providerId, b);
    if (lock) txn.delete(lock);
    const ev = bookingEvent({
      bookingId, type: TYPES.RELEASED, actor: by,
      providerId: b.providerId, customerUid: b.customerUid,
      previousStatus: b.status, newStatus: 'cancelled', paymentRef: b.paymentRef || null,
      data: { reason }, key: 'released',
    });
    txn.set(ev.ref, ev.payload);
    return { released: true, paymentRef: b.paymentRef || null };
  });

  if (res.released && res.paymentRef) {
    await db.collection('paymentIntents').doc(res.paymentRef)
      .set({ status: 'cancelled', cancelledReason: reason }, { merge: true }).catch(() => {});
  }
  return res;
}
exports.releaseServiceHold = releaseServiceHold;

/* Called from the IntaSend webhook on a TERMINAL non-payment for a providerBooking
   intent (FAILED / CANCELLED / EXPIRED / REJECTED / TIMEOUT): free the slot NOW instead
   of waiting for the sweep. Maps intent → booking (server-minted intent, never client
   meta), then releases (system-initiated). Returns true when it recognised a booking
   intent so the webhook caller can ack and skip other logic. Replay-safe via the guards
   in releaseServiceHold (a paid/terminal booking is a no-op). */
async function releaseServiceBookingOnTerminalPayment(db, adminSdk, apiRef, intentRef, state) {
  let bookingId = null;
  try {
    const iSnap = await db.collection('paymentIntents').doc(intentRef || apiRef).get();
    if (iSnap.exists && iSnap.data().resourceType === 'providerBooking') bookingId = iSnap.data().resourceId || null;
  } catch (_) { return false; }
  if (!bookingId) return false;
  try {
    const res = await releaseServiceHold(db, adminSdk, {
      bookingId, reason: 'payment-' + String(state || 'failed').toLowerCase(), by: 'intasend-webhook',
    });
    console.log(`[webhook] service booking terminal-payment ${state}: ${apiRef} -> ${bookingId} released=${res.released} (${res.reason || 'ok'})`);
    if (res.released && bookingId) {
      try {
        const { notify } = require('./notify');
        const b = (await db.collection('providerBookings').doc(bookingId).get()).data() || {};
        if (b.customerUid) notify({ uid: b.customerUid, type: 'booking_released', title: 'Reservation released',
          body: 'Your payment didn’t go through, so the time slot has been released. You can book again anytime.',
          dedupeKey: `booking_released_${apiRef}` }).catch(() => {});
      } catch (_) { /* notify optional */ }
    }
  } catch (e) {
    console.error('[webhook] terminal-payment release failed (recoverable, sweep will retry):', e.message);
  }
  return true;   /* recognised a booking intent — caller acks + skips other handling */
}
exports.releaseServiceBookingOnTerminalPayment = releaseServiceBookingOnTerminalPayment;
