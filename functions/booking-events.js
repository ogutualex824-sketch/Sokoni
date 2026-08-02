'use strict';
/* ============================================================================
   SOKONI — Booking lifecycle events  functions/booking-events.js

   ONE structured, append-only audit trail for the service-booking lifecycle,
   written to the canonical `bookingEvents` collection (same schema the booking
   resolution engine already uses). Every transition emits an event so an
   investigation can reconstruct exactly what happened without reading logs:

     HELD → RESUMED* → PAYMENT_CONFIRMED → CONFIRMED → …            (happy path)
     HELD → RELEASED | EXPIRED                                      (abandoned)

   Each event denormalises providerId/customerUid (so rules can scope reads) and
   records previousStatus → newStatus, the actor (customer/provider/system/
   webhook), and the paymentRef when known.

   IDEMPOTENCY: pass `key` for a transition that must occur at most once per
   booking (released/expired/paid/confirmed). The event id becomes
   `${bookingId}_${key}`, so a retried/duplicate delivery (payment providers
   retry webhooks) OVERWRITES the same event doc instead of appending a
   duplicate. Omit `key` for repeatable transitions (e.g. RESUMED). Admin-SDK
   writes bypass the append-only client rule, so a deterministic overwrite is
   allowed server-side.

   The builder returns { ref, payload } so callers can write it INSIDE the same
   transaction as the state change — the event is then atomic with the booking
   update, never a separate best-effort write that could drift.
   ========================================================================== */
const admin = require('firebase-admin');
const db = admin.firestore();

/** Canonical lifecycle event types. */
const TYPES = Object.freeze({
  HELD:              'BOOKING_HELD',
  RESUMED:           'BOOKING_RESUMED',
  RELEASED:          'BOOKING_RELEASED',
  EXPIRED:           'BOOKING_EXPIRED',
  PAYMENT_CONFIRMED: 'PAYMENT_CONFIRMED',
  CONFIRMED:         'BOOKING_CONFIRMED',
});

/**
 * Build a bookingEvents record. Returns { ref, payload } for txn.set(ref, payload)
 * (atomic with the state change) or a plain db.set for best-effort logging.
 * @param {object} o
 * @param {string} o.bookingId
 * @param {string} o.type          one of TYPES
 * @param {string} [o.actor]       'customer' | 'provider' | 'system' | 'intasend-webhook'
 * @param {string} [o.providerId]
 * @param {string} [o.customerUid]
 * @param {string} [o.previousStatus]
 * @param {string} [o.newStatus]
 * @param {string} [o.paymentRef]
 * @param {object} [o.data]        extra context (never secrets)
 * @param {string} [o.key]         deterministic-id discriminator → idempotent
 */
function bookingEvent(o) {
  const bookingId = String((o && o.bookingId) || '');
  const ref = o && o.key
    ? db.collection('bookingEvents').doc(`${bookingId}_${o.key}`)
    : db.collection('bookingEvents').doc();
  const payload = {
    bookingId,
    type:           o.type,
    actor:          o.actor || 'system',
    providerId:     o.providerId || null,
    customerUid:    o.customerUid || null,
    previousStatus: o.previousStatus || null,
    newStatus:      o.newStatus || null,
    paymentRef:     o.paymentRef || null,
    data:           o.data || {},
    at:             admin.firestore.FieldValue.serverTimestamp(),
    ts:             Date.now(),
  };
  return { ref, payload };
}

module.exports = { bookingEvent, TYPES };
