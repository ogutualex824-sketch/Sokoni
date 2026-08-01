'use strict';
/* ============================================================================
   SOKONI — Booking Availability Guard   functions/booking-availability-guard.js

   PRINCIPLE (owner-ratified): an availability change must NEVER silently invalidate
   a confirmed customer booking. Availability config (providerAvailability) and bookings
   (providerBookings) are already separate stores, so a schedule/vacation/blackout edit
   does not mutate a booking — but the provider gets no WARNING that their change
   conflicts with existing confirmed bookings.

   This module adds the read-only "impact pre-check": before a provider applies a change
   (vacation, blackout/holiday, day closed, reduced hours) the UI asks which confirmed
   bookings fall in the newly-unavailable window, so the provider can decide (keep / later
   reschedule / cancel) instead of blindly changing state. Slice 1 = detection + awareness;
   the resolution + emergency + audit + customer-choice workflows are separate slices.

   Routed through providerDispatch (op: 'providerCheckAvailabilityImpact'). Read-only:
   NO writes, so it can never itself harm a booking or a held payment.
   ========================================================================== */
const admin = require('firebase-admin');
if (!admin.apps.length) admin.initializeApp();
const db = admin.firestore();
const { HttpsError } = require('firebase-functions/v2/https');

const DOW = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const ACTIVE_BOOKING_STATES = ['pending', 'requested', 'confirmed', 'in_progress'];

function _uid(req) {
  const uid = req.auth && req.auth.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Authentication required.');
  return uid;
}
function _mins(t) {
  if (!t) return null;
  const parts = String(t).split(':').map(Number);
  return (parts[0] || 0) * 60 + (parts[1] || 0);
}

/* Is a booking STILL servable under the proposed availability config? Mirrors the gate in
   booking-service._prepareSlot (vacation / day-closed / working-hours), applied to the
   PROPOSED config the provider is about to save. Returns false ⇒ the change would strand it.
   Exported for unit testing. */
function _servable(b, cfg, blackoutDates) {
  cfg = cfg || {};
  /* blackout / holiday for the booking's date */
  if (Array.isArray(blackoutDates) && blackoutDates.indexOf(b.date) > -1) return false;

  /* vacation — if a date range is supplied, only bookings inside it are affected; else all */
  const vac = cfg.vacation || {};
  if (vac.active === true || cfg.isOnVacation === true) {
    const s = vac.startDate ? new Date(vac.startDate + 'T00:00:00+03:00').getTime() : -Infinity;
    const e = vac.endDate ? new Date(vac.endDate + 'T23:59:59+03:00').getTime() : Infinity;
    const ts = Number(b.startTs);
    if (ts >= s && ts <= e) return false;
  }

  /* 24/7 or explicit after-hours acceptance never strands a booking on working-hours grounds */
  const afterHours = (cfg.modes && cfg.modes.indexOf('open_24_7') > -1) || (cfg.appt && cfg.appt.allowAfterHours);
  if (afterHours) return true;

  /* weekly schedule for the booking's weekday: day closed, or time now outside open periods.
     If the proposed config supplies NO schedule for this day, we cannot conclude the booking
     is stranded (e.g. a vacation-only change carries no schedule) → do not spuriously warn. */
  const dow = DOW[new Date(b.date + 'T00:00:00+03:00').getDay()];
  const day = cfg.schedule && cfg.schedule[dow];
  if (!day) return true;
  if (day.closed === true) return false;
  const sm = _mins(b.startTime), em = _mins(b.endTime);
  const within = (day.periods || []).some(function (p) {
    return p && p.open && p.close && _mins(p.open) <= sm && em <= _mins(p.close);
  });
  if (!within) return false;

  return true;
}

const _h = {};

/* providerCheckAvailabilityImpact — READ-ONLY. Returns the provider's own future confirmed/
   active bookings that would fall in a newly-unavailable window under the proposed change.
   Input:  { proposed: <availability config as the manager UI builds it>, blackoutDates?: [YYYY-MM-DD] }
   Output: { affectedCount, totalFuture, affected: [ {id, customerName, service, date, startTime,
             endTime, startTs, status, paymentStatus, price} ] } */
_h.providerCheckAvailabilityImpact = async (req) => {
  const uid = _uid(req);
  const d = req.data || {};
  const proposed = d.proposed || {};
  const blackoutDates = Array.isArray(d.blackoutDates) ? d.blackoutDates : [];
  const now = Date.now();

  /* Single-field query (providerId) → no composite index dependency; filter in memory.
     A provider's booking set is bounded, so this is cheap and index-free. */
  const snap = await db.collection('providerBookings').where('providerId', '==', uid).get();
  const future = snap.docs
    .map(function (doc) { return Object.assign({ id: doc.id }, doc.data()); })
    .filter(function (b) { return ACTIVE_BOOKING_STATES.indexOf(b.status) > -1 && Number(b.startTs) >= now; });

  function _slim(b) {
    return {
      id: b.id, customerName: b.customerName || 'Customer', service: b.service || b.serviceName || '',
      date: b.date || null, startTime: b.startTime || null, endTime: b.endTime || null,
      startTs: Number(b.startTs) || null, status: b.status || null,
      paymentStatus: b.paymentStatus || null, price: Number(b.price) || 0,
    };
  }
  const strandedAll = future
    .filter(function (b) { return !_servable(b, proposed, blackoutDates); })
    .sort(function (a, b) { return Number(a.startTs) - Number(b.startTs); });

  /* Step 4 — FREEZE: bookings already mid-resolution (resolution.status === ACTION_REQUIRED) are
     LOCKED. The caller must NOT apply an availability change that affects them — that would move
     the negotiation target while the customer is deciding. They are reported separately so the UI
     can block the save until the provider resolves them (reschedule/refund). */
  function _isLocked(b) { return b.resolution && b.resolution.status === 'ACTION_REQUIRED'; }
  const locked = strandedAll.filter(_isLocked);
  const affected = strandedAll.filter(function (b) { return !_isLocked(b); });

  return {
    affectedCount: affected.length,
    lockedCount: locked.length,
    totalFuture: future.length,
    affected: affected.map(_slim),
    locked: locked.map(_slim),
  };
};

module.exports = { _h, _servable };
