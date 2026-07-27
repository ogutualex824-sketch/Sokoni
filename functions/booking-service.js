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

  /* ── Server-authoritative service lookup: price + duration come from the rate
     card, NEVER the client (the client cannot manipulate the amount). ── */
  const svcSnap = await db.collection('providerServices').doc(serviceId).get();
  if (!svcSnap.exists) throw new HttpsError('not-found', 'Service not found.');
  const svc = svcSnap.data();
  if (svc.providerId !== providerId) throw new HttpsError('failed-precondition', 'Service does not belong to this provider.');
  if (svc.active === false) throw new HttpsError('failed-precondition', 'This service is not available.');
  const durationMins = Math.max(15, Number(svc.durationMins) || 30);
  const price       = Math.max(0, Math.round(Number(svc.price) || 0)); /* cents, server-owned */
  const serviceName = _san(svc.name, 200);

  const startMins = _mins(startTime);
  const endMins   = startMins + durationMins;
  const endTime   = _minsToTime(endMins);
  const dayStart  = new Date(date + 'T00:00:00+03:00').getTime();
  const startTs   = dayStart + startMins * 60000;
  const endTs     = dayStart + endMins * 60000;

  /* Provider config: working hours, buffers, caps, blackout override, vacation. */
  const cfgRef = db.collection('providerAvailability').doc(providerId);
  const [cfgSnap, overrideSnap, userSnap] = await Promise.all([
    cfgRef.get(),
    cfgRef.collection('overrides').doc(date).get(),
    db.collection('users').doc(customerUid).get(),
  ]);
  const cfg = cfgSnap.data() || {};
  const appt = cfg.appt || {};
  const bufMs = rc.minsToMs(appt.bufferMins);
  const maxPerCustomer = Number(appt.maxPerCustomer || 0);
  const customerName = _san((userSnap.data() || {}).name || (userSnap.data() || {}).displayName || '', 200);

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

  /* Minimum notice + same-day policy. */
  const minNoticeMs = Math.max(0, Number(appt.minNoticeHours || 0)) * 3600000;
  if (startTs < Date.now() + minNoticeMs) throw new HttpsError('failed-precondition', 'Too close to the start time to book.');
  if (appt.allowSameDay === false && new Date(date + 'T00:00:00+03:00').toISOString().slice(0, 10) === new Date().toISOString().slice(0, 10)) {
    throw new HttpsError('failed-precondition', 'Same-day booking is not available for this provider.');
  }

  const slotKey     = rc.slotKey(date, startTs, endTs);
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
      date, startTime, endTime, startTs, endTs, durationMins,
      scheduledAt: admin.firestore.Timestamp.fromMillis(startTs),
      price, currency: 'KES',        /* server-authoritative from the rate card */
      paymentStatus: 'pending',
      status,                        /* server-authoritative */
      note: _san(d.note, 300),
      hubType: _san(d.hubType, 40) || 'services',
      idempotencyKey,
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

module.exports = { _h };
