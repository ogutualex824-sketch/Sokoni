/* ============================================================================
   SOKONI — Reservation Core  functions/reservation-core.js

   The ONE definition of the slot-reservation primitives, shared by the venue
   booking engine (booking.js) and the service-appointment engine (Phase B's
   bookingCreateService). Extracted from booking.js so both call identical logic
   and can never drift — the same reason search-terms.js / pricing-schema.js exist.

   Pure functions only (no Firestore). The caller runs the transaction and owns
   the record shape; these decide slot identity, buffered overlap, capacity, and
   per-customer limits. Design: docs/BOOKING_CONVERGENCE.md (Phase A).

   Buffered-overlap semantics (unchanged from booking.js): a new booking occupies
   [start - bufferBefore, end + bufferAfter]; it conflicts with an existing booking
   if the windows intersect. Back-to-back with zero buffer is allowed.
   ============================================================================ */
'use strict';

/* Bumped when the reservation semantics change (overlap/capacity math, slot-key
   format). Stamped onto every booking as `reservationVersion` so a record's
   guarantees are reproducible and future revisions need no migration. */
const VERSION = '1.0.0';

/* Bookings in these statuses hold a slot; terminal ones (completed/cancelled/
   declined/no_show) free it. Shared so every engine counts the same set. */
const ACTIVE_STATUSES = ['pending', 'confirmed', 'active'];

/* Deterministic slot-lock key. A single doc at this key, written inside the
   reservation transaction, is the CAS that stops two concurrent bookings for the
   identical window from both committing. Matches booking.js's existing format. */
function slotKey(date, startTs, endTs) {
  return `${date}_${startTs}_${endTs}`;
}

/* True iff [startTs, endTs] (widened by the provider buffer) overlaps `existing`
   — the exact formula booking.js's bookingCreate + bookingHoldSlot use. `existing`
   is an array of { startTs, endTs }. bufBeforeMs/bufAfterMs are milliseconds. */
function bufferedOverlaps(startTs, endTs, existing, bufBeforeMs, bufAfterMs) {
  const bb = Math.max(0, Number(bufBeforeMs) || 0);
  const ba = Math.max(0, Number(bufAfterMs) || 0);
  return (existing || []).some(b =>
    (startTs - bb) < (Number(b.endTs) + ba) &&
    (endTs   + ba) > (Number(b.startTs) - bb));
}

/* Two-booking overlap (buffer-aware) — the primitive bufferedOverlaps is built on.
   Exposed for callers that check one pair at a time. */
function pairOverlaps(aStartTs, aEndTs, bStartTs, bEndTs, bufBeforeMs, bufAfterMs) {
  return bufferedOverlaps(aStartTs, aEndTs, [{ startTs: bStartTs, endTs: bEndTs }], bufBeforeMs, bufAfterMs);
}

/* Venue/provider concurrency cap. concurrentMax 0/absent = unlimited (no cap).
   `activeCount` = current active bookings overlapping the window. */
function capacityExceeded(activeCount, concurrentMax) {
  const max = Number(concurrentMax) || 0;
  return max > 0 && Number(activeCount) >= max;
}

/* Per-customer active-booking cap. maxPerCustomer 0/absent = unlimited. */
function customerCapExceeded(customerActiveCount, maxPerCustomer) {
  const max = Number(maxPerCustomer) || 0;
  return max > 0 && Number(customerActiveCount) >= max;
}

/* Minutes → ms helper for buffer config (bufferBeforeMins → ms). */
function minsToMs(mins) {
  return Math.max(0, Number(mins) || 0) * 60000;
}

module.exports = {
  VERSION,
  ACTIVE_STATUSES,
  slotKey,
  bufferedOverlaps,
  pairOverlaps,
  capacityExceeded,
  customerCapExceeded,
  minsToMs,
};
