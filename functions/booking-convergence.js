'use strict';
/* ============================================================================
   SOKONI — Service-booking convergence telemetry  functions/booking-convergence.js
   WS4a (docs/BOOKING_CONVERGENCE.md). The evidence base for the Phase F retirement
   decision: measure what share of provider-service bookings flow through the
   canonical path (bookingCreateService → providerBookings) versus the legacy path
   (SokoniPay.bookNow → webhookIntasend → top-level `bookings`).

   Mirrors the availabilityConvergence pattern (systemHealth/{doc} + best-effort
   FieldValue.increment) so it is consistent with the rest of the platform and adds
   NO new scheduler / Cloud Run service. Two layers so adoption is a computable
   TREND, not a cumulative total needing manual interpretation:
     • cumulative totals   — canonicalTotal / legacyTotal (all-time)
     • per-day buckets      — daily[YYYY-MM-DD].{canonical,legacy} (Africa/Nairobi)
   Every write is best-effort: a telemetry failure MUST NEVER affect a booking. ==== */
const admin = require('firebase-admin');
const FV = admin.firestore.FieldValue;

/* Africa/Nairobi (UTC+3, no DST) day bucket — matches the platform's calendar TZ
   so a "day" here is the same day the provider calendar and reports use. */
function nairobiDate() {
  return new Date(Date.now() + 3 * 3600 * 1000).toISOString().slice(0, 10);
}

/* Increment one convergence counter. kind: 'canonical' | 'legacy'.
   Records the cumulative total AND today's per-day bucket in one merge write. */
async function bumpBookingConvergence(db, kind) {
  if (kind !== 'canonical' && kind !== 'legacy') return;
  try {
    await db.collection('systemHealth').doc('bookingConvergence').set({
      [kind + 'Total']: FV.increment(1),
      daily: { [nairobiDate()]: { [kind]: FV.increment(1) } },
      updatedAt: FV.serverTimestamp(),
    }, { merge: true });
  } catch (_) { /* best-effort — never fails the booking */ }
}

/* Read-only summary for the platform-metrics fold + dashboards. Pure read; safe to
   call from aggregatePlatformMetrics. `canonicalShare` is null until the first
   booking so a zero-data platform never reports a misleading 0%. */
async function computeBookingConvergence(db) {
  const snap = await db.collection('systemHealth').doc('bookingConvergence').get();
  const d = snap.exists ? snap.data() : {};
  const canonicalTotal = Number(d.canonicalTotal) || 0;
  const legacyTotal = Number(d.legacyTotal) || 0;
  const total = canonicalTotal + legacyTotal;
  const date = nairobiDate();
  const today = (d.daily && d.daily[date]) || {};
  return {
    canonicalTotal, legacyTotal, total,
    canonicalShare: total ? canonicalTotal / total : null,   /* cumulative adoption */
    today: { date, canonical: Number(today.canonical) || 0, legacy: Number(today.legacy) || 0 },
    legacyRetired: total > 0 && legacyTotal === 0,            /* informational only */
  };
}

module.exports = { bumpBookingConvergence, computeBookingConvergence, nairobiDate };
