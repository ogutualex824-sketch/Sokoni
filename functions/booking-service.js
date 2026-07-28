/* ============================================================================
   SOKONI — Service Appointment Engine  functions/booking-service.js
   Convergence Phase B (docs/BOOKING_CONVERGENCE.md).

   The AUTHORITATIVE create path for service appointments. Writes the canonical
   `providerBookings` collection (the one provider-ops.js's confirm/complete/
   commission lifecycle reads), using the shared reservation-core primitives so it
   inherits the venue engine's integrity guarantees. Closes the open loop:
   customer "Book Now" → this CF → providerBookings → provider dashboard.

   SERVER-AUTHORITATIVE: status, price, currency, timestamps, and paymentStatus are
   set here from the provider's own rate card + config — NEVER from client input.
   Commission/settlement fields are populated only at completion (provider-ops.js).
   Merged into providerDispatch. ============================================== */
'use strict';
const admin = require('firebase-admin');
const { HttpsError } = require('firebase-functions/v2/https');
const db = admin.firestore();
const rc = require('./reservation-core');

const _uid = (req) => { const u = req.auth && req.auth.uid; if (!u) throw new HttpsError('unauthenticated', 'Sign in required.'); return u; };
const _ts  = () => admin.firestore.FieldValue.serverTimestamp();
const _san = (s, n = 300) => String(s == null ? '' : s).replace(/[<>]/g, '').slice(0, n);
const _mins = (t) => { const p = String(t || '0:0').split(':'); return (Number(p[0]) || 0) * 60 + (Number(p[1]) || 0); };
const _minsToTime = (m) => String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
const DOW = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/* Provenance versions — bump when the create semantics or the price source change.
   Stamped on every booking so records stay reproducible without migration. */
const ENGINE_VERSION  = '1.0.0';   /* this create engine */
const PRICING_VERSION = '1.1.0';   /* v1.1 (D3): booking now carries declared fee + deposit alongside price (all cents) */

/* ── Shared availability gate ────────────────────────────────────────────────
   Validates a candidate slot against the provider's config (working hours,
   blackout override, vacation, min-notice, same-day) and returns the computed
   slot. Used by BOTH the create path and providerRescheduleBooking so there is
   ONE authoritative availability validation (D2 adds the breaks check here, once).
   Pure of any write; the caller runs the slot-lock CAS + capacity in its txn. */
async function _prepareSlot(db, { providerId, date, startTime, durationMins }) {
  const startMins = _mins(startTime);
  const endMins   = startMins + durationMins;
  const endTime   = _minsToTime(endMins);
  const dayStart  = new Date(date + 'T00:00:00+03:00').getTime();
  const startTs   = dayStart + startMins * 60000;
  const endTs     = dayStart + endMins * 60000;

  const cfgRef = db.collection('providerAvailability').doc(providerId);
  const [cfgSnap, overrideSnap] = await Promise.all([
    cfgRef.get(),
    cfgRef.collection('overrides').doc(date).get(),
  ]);
  const cfg  = cfgSnap.data() || {};
  const appt = cfg.appt || {};
  const bufMs = rc.minsToMs(appt.bufferMins);

  /* Blackout (the reserveSlot gap): an override marking the date closed blocks it. */
  if (overrideSnap.exists && overrideSnap.data().closed === true) {
    throw new HttpsError('failed-precondition', 'The provider is closed on this date.');
  }
  if (cfg.isOnVacation === true) throw new HttpsError('failed-precondition', 'The provider is currently unavailable.');

  /* Working-hours validation (mirrors reserveSlot). */
  const dow = DOW[new Date(date + 'T00:00:00+03:00').getDay()];
  const day = cfg.schedule && cfg.schedule[dow];
  const withinHours = (cfg.modes && cfg.modes.includes('open_24_7')) || appt.allowAfterHours ||
    (day && !day.closed && (day.periods || []).some(p =>
      p && p.open && p.close && _mins(p.open) <= startMins && endMins <= _mins(p.close)));
  if (!withinHours) throw new HttpsError('out-of-range', "That time is outside the provider's working hours.");

  /* Breaks (D2): the slot must not overlap any of the day's breaks. Overlap iff
     start < break.end && end > break.start. Applies to create AND reschedule (shared gate). */
  const onBreak = day && (day.breaks || []).some(b =>
    b && b.start && b.end && startMins < _mins(b.end) && endMins > _mins(b.start));
  if (onBreak) throw new HttpsError('failed-precondition', "That time falls within the provider's break.");

  /* Minimum notice + same-day policy. */
  const minNoticeMs = Math.max(0, Number(appt.minNoticeHours || 0)) * 3600000;
  if (startTs < Date.now() + minNoticeMs) throw new HttpsError('failed-precondition', 'Too close to the start time to book.');
  if (appt.allowSameDay === false && new Date(date + 'T00:00:00+03:00').toISOString().slice(0, 10) === new Date().toISOString().slice(0, 10)) {
    throw new HttpsError('failed-precondition', 'Same-day booking is not available for this provider.');
  }

  const slotKey = rc.slotKey(date, startTs, endTs);
  return { startMins, endMins, endTime, startTs, endTs, slotKey, cfg, appt, bufMs, cfgRef };
}

const _h = {};

_h.bookingCreateService = async (req) => {
  const customerUid = _uid(req);
  const d = req.data || {};
  const providerId = _san(d.providerId, 128);
  const serviceId  = _san(d.serviceId, 128);
  const date       = _san(d.date, 10);      /* YYYY-MM-DD */
  const startTime  = _san(d.startTime, 5);  /* HH:MM */
  const idempotencyKey = _san(d.idempotencyKey, 128) || null;
  if (!providerId || !serviceId || !date || !startTime) {
    throw new HttpsError('invalid-argument', 'providerId, serviceId, date, startTime required.');
  }
  if (customerUid === providerId) throw new HttpsError('failed-precondition', 'You cannot book your own service.');

  /* Provider activation gate (trust & safety): a booking may be created ONLY for a
     provider whose canonical registry doc is active and still accepting bookings.
     WITHOUT this, suspending/disabling a provider had no effect while their services
     + availability stayed published (the registry read is the platform's bookability
     source of truth — providers/{uid}, written active at publish). Fail-closed:
     a missing doc (never published / unapproved) is NOT bookable. Server-side only. */
  const provSnap = await db.collection('providers').doc(providerId).get();
  const prov = provSnap.exists ? provSnap.data() : null;
  const ACTIVE_PROVIDER_STATES = ['active', 'approved'];
  if (!prov || !ACTIVE_PROVIDER_STATES.includes(prov.status) || prov.acceptsBookings === false) {
    throw new HttpsError('failed-precondition', 'This provider isn’t currently available for bookings.');
  }

  /* ── Server-authoritative service lookup: price + duration come from the rate
     card, NEVER the client (the client cannot manipulate the amount). ── */
  const svcSnap = await db.collection('providerServices').doc(serviceId).get();
  if (!svcSnap.exists) throw new HttpsError('not-found', 'Service not found.');
  const svc = svcSnap.data();
  if (svc.providerId !== providerId) throw new HttpsError('failed-precondition', 'Service does not belong to this provider.');
  if (svc.active === false) throw new HttpsError('failed-precondition', 'This service is not available.');
  const durationMins = Math.max(15, Number(svc.durationMins) || 30);
  const price       = Math.max(0, Math.round(Number(svc.price) || 0)); /* cents, server-owned */
  const fee         = Math.max(0, Math.round(Number(svc.fee) || 0));     /* cents — declared per-service fee (D3) */
  const deposit     = Math.max(0, Math.round(Number(svc.deposit) || 0)); /* cents — declared upfront hold (collected in Phase E) */
  const serviceName = _san(svc.name, 200);

  /* Validate the slot through the shared availability gate (same path reschedule uses). */
  const slot = await _prepareSlot(db, { providerId, date, startTime, durationMins });
  const { endTime, startTs, endTs, slotKey, cfg, appt, bufMs, cfgRef } = slot;
  const maxPerCustomer = Number(appt.maxPerCustomer || 0);

  const userSnap = await db.collection('users').doc(customerUid).get();
  const customerName = _san((userSnap.data() || {}).name || (userSnap.data() || {}).displayName || '', 200);

  const bookingId   = `${providerId}_${slotKey}`;   /* deterministic → natural lock + idempotency */
  const slotLockRef = cfgRef.collection('slotLocks').doc(slotKey);
  const bookingRef  = db.collection('providerBookings').doc(bookingId);
  const idemRef     = idempotencyKey ? db.collection('_serviceBookingIdem').doc(idempotencyKey) : null;

  /* Prefetch active bookings for buffered overlap + caps (the slot-lock CAS below
     is the authoritative guard against the concurrent-same-slot race). */
  const activeSnap = await db.collection('providerBookings')
    .where('providerId', '==', providerId).where('date', '==', date)
    .where('status', 'in', rc.ACTIVE_STATUSES).get();
  const existing = activeSnap.docs.map(s => s.data());
  let custActive = 0;
  if (maxPerCustomer > 0) {
    const cs = await db.collection('providerBookings')
      .where('providerId', '==', providerId).where('customerUid', '==', customerUid)
      .where('status', 'in', rc.ACTIVE_STATUSES).get();
    custActive = cs.size;
  }

  let outcome = null;
  await db.runTransaction(async (txn) => {
    outcome = null;
    if (idemRef) { const i = await txn.get(idemRef); if (i.exists) { outcome = { bookingId: i.data().bookingId, idempotent: true }; return; } }
    const lock = await txn.get(slotLockRef);
    if (lock.exists) { outcome = { conflict: 'already-exists' }; return; }
    /* Daily total cap (all bookings that day). */
    const maxPerDay = Number(cfg.cap && cfg.cap.maxPerDay || 0);
    if (maxPerDay > 0 && existing.length >= maxPerDay) { outcome = { conflict: 'resource-exhausted' }; return; }
    /* Per-customer cap. */
    if (rc.customerCapExceeded(custActive, maxPerCustomer)) { outcome = { conflict: 'failed-precondition' }; return; }
    /* Concurrent capacity = how many buffered bookings may OVERLAP this window.
       Defaults to 1 (no double-book); >1 = a shared resource (e.g. a class). This
       counts only OVERLAPPING bookings, not the whole day — the correct semantic. */
    const maxConcurrent = Math.max(1, Number(cfg.cap && cfg.cap.maxSimultaneous || 1));
    const overlapCount = existing.filter(b => rc.pairOverlaps(startTs, endTs, b.startTs, b.endTs, bufMs, bufMs)).length;
    if (overlapCount >= maxConcurrent) { outcome = { conflict: 'already-exists' }; return; }

    /* Provider approves by default (status:pending); auto-confirm only if configured.
       Commission/settlement fields are DELIBERATELY absent — set at completion. */
    const status = appt.autoConfirm === true ? 'confirmed' : 'pending';
    txn.set(bookingRef, {
      providerId, customerUid, customerName,
      serviceId, service: serviceName,
      date, startTime, endTime, startTs, endTs, durationMins, slotKey,
      scheduledAt: admin.firestore.Timestamp.fromMillis(startTs),
      price, fee, deposit, currency: 'KES',   /* all cents; server-authoritative from the rate card.
                                                 fee/deposit are DECLARED amounts — Phase E collects them. */
      paymentStatus: 'pending',
      status,                        /* server-authoritative */
      note: _san(d.note, 300),
      hubType: _san(d.hubType, 40) || 'services',
      idempotencyKey,
      /* Provenance — which path/engine/rev priced & reserved this booking, so a
         record is reproducible and future engine/pricing revisions need no
         migration (investigating a booking months later reads these). */
      bookingSource:      'service-appointment',
      engineVersion:      'booking-service@' + ENGINE_VERSION,
      reservationVersion: 'reservation-core@' + rc.VERSION,
      pricingVersion:     'rate-card@' + PRICING_VERSION,
      createdAt: _ts(), updatedAt: _ts(),
    });
    txn.set(slotLockRef, { bookingId, providerId, customerUid, date, startTime, endTime, startTs, endTs, createdAt: _ts() });
    if (idemRef) txn.set(idemRef, { bookingId, providerId, customerUid, createdAt: _ts() });
    outcome = { bookingId, status };
  });

  if (outcome && outcome.idempotent) return { success: true, bookingId: outcome.bookingId, idempotent: true };
  if (outcome && outcome.conflict) throw new HttpsError(
    outcome.conflict,
    outcome.conflict === 'resource-exhausted' ? 'The provider is fully booked for that time.'
      : outcome.conflict === 'failed-precondition' ? 'You have reached your booking limit with this provider.'
        : 'That slot was just taken. Please choose another time.');

  /* Convergence telemetry (WS4a) — a genuinely NEW canonical booking (idempotent
     replays returned above). Best-effort: never affects the booking. */
  try { require('./booking-convergence').bumpBookingConvergence(db, 'canonical'); } catch (e) { /* ignore */ }

  /* Notify the provider (best-effort — must not fail the booking). */
  try {
    await db.collection('notifications').add({
      targetUid: providerId, type: 'booking', heading: 'New booking request',
      sub: `${serviceName} · ${date} ${startTime}`, link: 'provider-dashboard.html',
      createdAt: _ts(), read: false,
    });
  } catch (e) { /* ignore */ }

  return { success: true, bookingId: outcome.bookingId, status: outcome.status, price };
};

/* ── WS3 · bookingSubmitReview ────────────────────────────────────────────────
   The AUTHORITATIVE customer review path (docs/BOOKING_CONVERGENCE.md, row E).
   Gate: a review may be created ONLY by the booking's customer, and ONLY once the
   booking has reached the canonical terminal state status:'completed' (the same
   state providerCompleteBooking sets). Writes the `providerReviews` collection —
   the one the provider dashboard (providerGetReviews) already reads — and updates
   the denormalized providerProfiles aggregate (rating/reviewCount) the PUBLIC
   profile reads, in the SAME transaction, so both surfaces converge on one write.

   Identity: providerReviews/{bookingId} → deterministic → replay-safe, one review
   per completed booking, no separate uniqueness index. A repeat submission is an
   idempotent no-op ({ alreadyReviewed:true }), never a partial write.
   Rules: providerReviews is CF-only (write:false) + public read — no rule change. */
_h.bookingSubmitReview = async (req) => {
  const customerUid = _uid(req);
  const d = req.data || {};
  const bookingId = _san(d.bookingId, 200);
  const rating    = Math.round(Number(d.rating));
  const text      = _san(d.text, 1000).trim();
  if (!bookingId) throw new HttpsError('invalid-argument', 'bookingId is required.');
  if (!(rating >= 1 && rating <= 5)) throw new HttpsError('invalid-argument', 'rating must be an integer 1–5.');

  const bookingRef = db.collection('providerBookings').doc(bookingId);
  const reviewRef  = db.collection('providerReviews').doc(bookingId);   /* deterministic: one review / booking */

  let outcome = null;
  await db.runTransaction(async (txn) => {
    outcome = null;
    /* ── all reads before any write ── */
    const bSnap = await txn.get(bookingRef);
    if (!bSnap.exists) throw new HttpsError('not-found', 'Booking not found.');
    const b = bSnap.data();
    /* Ownership + eligibility gate — server is authoritative, not the client. */
    if (b.customerUid !== customerUid) throw new HttpsError('permission-denied', 'Not your booking.');
    if (b.status !== 'completed')      throw new HttpsError('failed-precondition', 'You can review a booking only after it is completed.');

    const rSnap = await txn.get(reviewRef);
    if (rSnap.exists) { outcome = { alreadyReviewed: true }; return; }   /* idempotent no-op — replay safe */

    const providerId = b.providerId;
    const profileRef = db.collection('providerProfiles').doc(providerId);
    const pSnap = await txn.get(profileRef);
    const p = pSnap.exists ? pSnap.data() : {};
    const prevCount = Math.max(0, Number(p.reviewCount) || 0);
    /* ratingSum is drift-free; derive it from the stored avg when the field is absent (back-compat). */
    const prevSum   = Number.isFinite(Number(p.ratingSum)) ? Number(p.ratingSum)
                       : Math.round((Number(p.rating) || 0) * prevCount);
    const newCount  = prevCount + 1;
    const newSum    = prevSum + rating;
    const newAvg    = newSum / newCount;

    /* 1 — the review (schema providerGetReviews reads: providerId/customerName/rating/text). */
    txn.set(reviewRef, {
      providerId, customerUid,
      customerName: _san(b.customerName, 120) || 'Customer',   /* from the booking snapshot, never client input */
      bookingId,
      serviceId: b.serviceId || null, service: b.service || null,
      rating, text,
      bookingStatusAtReview: 'completed',   /* immutable eligibility state at review time (audit/analytics) */
      reply: null,
      status: 'published',
      createdAt: _ts(), updatedAt: _ts(),
    });
    /* 2 — converge the provider aggregate the PUBLIC profile reads. */
    txn.set(profileRef, { rating: newAvg, reviewCount: newCount, ratingSum: newSum, updatedAt: _ts() }, { merge: true });
    /* 3 — stamp the booking so the UI knows it's reviewed (idempotency signal for the client too). */
    txn.update(bookingRef, { reviewedAt: _ts(), reviewRating: rating, updatedAt: _ts() });

    outcome = { created: true, providerId };
  });

  if (outcome && outcome.alreadyReviewed) return { success: true, alreadyReviewed: true };

  /* Notify the provider of the new review (best-effort — must not fail the review). */
  try {
    await db.collection('notifications').add({
      targetUid: outcome.providerId, type: 'review', heading: 'New review',
      sub: `${rating}★ from a customer`, link: 'provider-dashboard.html',
      createdAt: _ts(), read: false,
    });
  } catch (e) { /* ignore */ }

  return { success: true, created: true, rating };
};

module.exports = { _h, _prepareSlot };
