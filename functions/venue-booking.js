'use strict';

/**
 * Venue, Facility & Resource Booking Engine  v1.0  (2026-07-07)
 * functions/venue-booking.js
 *
 * Extension of the Universal Availability & Scheduling Engine.
 * Supports any bookable resource: sports courts, event halls, conference rooms,
 * studios, co-working spaces, equipment rentals, and future resource types.
 *
 * Firestore layout:
 *   venues/{venueId}                         — venue profile & config
 *   venues/{venueId}/bookings/{slotKey}       — slot locks (slotKey = YYYY-MM-DD_HHmm_shortId)
 *   venues/{venueId}/blockouts/{blockId}      — maintenance / holiday blocks
 *   venueBookings/{bookingId}                 — top-level mirror for customer queries
 *
 * New composite indexes required (add to firestore.indexes.json):
 *   Collection: venueBookings  |  customerId ASC, createdAt DESC
 *
 * All onCall CFs enforce App Check.
 * Public read CFs (venueGetPublic, venueGetAvailability, venueCalculatePrice)
 *   set enforceAppCheck: false so unauthenticated listing pages work.
 */

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const admin = require('firebase-admin');

if (!admin.apps.length) admin.initializeApp();
const db = admin.firestore();
const FV = admin.firestore.FieldValue;
const FP = admin.firestore.FieldPath;

/* ── Options ──────────────────────────────────────────────────────────────── */

const CF_OPTS = { region: 'us-central1', enforceAppCheck: true };
const CF_PUB  = { region: 'us-central1', enforceAppCheck: false }; // public reads

exports._h = {}; // handler registry — consumed by booking-dispatch.js

/* ── Constants ────────────────────────────────────────────────────────────── */

const DAYS = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];

const VENUE_TYPES = new Set([
  'sports_court','gym','swimming_pool','indoor_arena','event_venue',
  'conference_hall','meeting_room','wedding_venue','studio',
  'coworking_space','training_center','classroom','photography_location',
  'performance_stage','community_hall','equipment_rental','other',
]);

const BOOKING_MODELS = new Set([
  'hourly','half_day','full_day','multi_day',
  'weekly_recurring','monthly_recurring','seasonal','exclusive','shared',
]);

const STATUS = {
  PENDING:   'pending_payment',
  CONFIRMED: 'confirmed',
  CHECKIN:   'checked_in',
  COMPLETE:  'completed',
  CANCELLED: 'cancelled',
  NO_SHOW:   'no_show',
};

const TERMINAL_STATUSES = new Set([STATUS.CANCELLED, STATUS.COMPLETE, STATUS.NO_SHOW]);

/* ── Pure helpers ─────────────────────────────────────────────────────────── */

function _mins(t) {
  const [h, m] = String(t).split(':').map(Number);
  return h * 60 + (m || 0);
}

function _timeStr(m) {
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

function _nairobiDateOffset(offsetDays) {
  const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'Africa/Nairobi' }));
  d.setDate(d.getDate() + (offsetDays || 0));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function _dayOfWeek(dateStr) {
  return DAYS[new Date(dateStr + 'T12:00:00').getDay()];
}

function _isWeekend(dateStr) {
  const d = new Date(dateStr + 'T12:00:00').getDay();
  return d === 0 || d === 6;
}

function _clamp(v, min, max, def) {
  const n = Number(v);
  return isNaN(n) ? def : Math.min(Math.max(n, min), max);
}

function _shortId() {
  return Math.random().toString(36).slice(2, 10);
}

function _round2(n) { return Math.round(n * 100) / 100; }

/* ── Auth helpers ─────────────────────────────────────────────────────────── */

function _uid(request) {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Login required.');
  return request.auth.uid;
}

function _isAdmin(request) {
  return !!(request.auth?.token?.admin || request.auth?.token?.superAdmin);
}

function _assertOwnerOrAdmin(venue, uid, request) {
  if (venue.ownerId !== uid && !_isAdmin(request)) {
    throw new HttpsError('permission-denied', 'Venue owner or admin access required.');
  }
}

/* ── Firestore helpers ────────────────────────────────────────────────────── */

async function _venueOrThrow(venueId) {
  if (!venueId || typeof venueId !== 'string') {
    throw new HttpsError('invalid-argument', 'venueId is required.');
  }
  const snap = await db.collection('venues').doc(venueId).get();
  if (!snap.exists) throw new HttpsError('not-found', `Venue not found: ${venueId}`);
  return { id: snap.id, ...snap.data() };
}

async function _bookingOrThrow(bookingId) {
  if (!bookingId || typeof bookingId !== 'string') {
    throw new HttpsError('invalid-argument', 'bookingId is required.');
  }
  const snap = await db.collection('venueBookings').doc(bookingId).get();
  if (!snap.exists) throw new HttpsError('not-found', `Booking not found: ${bookingId}`);
  return { id: snap.id, ...snap.data() };
}

/* ── Slot generation ──────────────────────────────────────────────────────── */

/**
 * Generate time slots for one day, removing intervals occupied by active bookings.
 * Returns [{ startTime, endTime, available, durationMins }]
 */
function _generateDaySlots(venue, dateStr, activeBookings) {
  const dow      = _dayOfWeek(dateStr);
  const schedule = venue.schedule?.[dow];
  if (!schedule || schedule.closed) return [];

  const openMins   = _mins(schedule.open  || '08:00');
  const closeMins  = _mins(schedule.close || '22:00');
  const slotMins   = venue.slotDurationMins || 60;
  const bufferMins = venue.bufferMins || 0;

  if (openMins >= closeMins) return [];

  // Build occupied intervals: [start, end + buffer]
  const occupied = activeBookings.map(b => ({
    start: _mins(b.startTime),
    end:   _mins(b.endTime) + bufferMins,
  }));

  const slots = [];
  for (let t = openMins; t + slotMins <= closeMins; t += slotMins) {
    const end      = t + slotMins;
    const blocked  = occupied.some(o => t < o.end && end > o.start);
    slots.push({
      startTime:    _timeStr(t),
      endTime:      _timeStr(end),
      available:    !blocked,
      durationMins: slotMins,
    });
  }
  return slots;
}

/* ── Dynamic pricing ──────────────────────────────────────────────────────── */

function _calcPrice(venue, dateStr, startTime, durationMins, isMember) {
  const p           = venue.pricing || {};
  const hours       = durationMins / 60;
  const ratePerHour = p.baseRatePerHour || 0;
  const isWknd      = _isWeekend(dateStr);
  const wkndMult    = isWknd ? _clamp(p.weekendMultiplier, 1.0, 10.0, 1.0) : 1.0;
  const base        = ratePerHour * hours * wkndMult;

  // Peak-hour surcharge (proportional to overlap)
  const startM = _mins(startTime);
  const endM   = startM + durationMins;
  let peakSurcharge = 0;
  (p.peakHours || []).forEach(ph => {
    const overlap = Math.max(0, Math.min(endM, _mins(ph.end)) - Math.max(startM, _mins(ph.start)));
    if (overlap > 0) {
      peakSurcharge += ratePerHour * (overlap / 60) * (_clamp(ph.multiplier, 1.0, 5.0, 1.0) - 1.0);
    }
  });

  const subtotal  = base + peakSurcharge;
  const discount  = isMember ? subtotal * _clamp(p.memberDiscount, 0, 0.5, 0) : 0;
  const total     = _round2(subtotal - discount);
  const deposit   = _round2(total * _clamp(p.depositPercent, 0, 1.0, 1.0));

  return {
    base:           _round2(base),
    weekendPremium: isWknd,
    peakSurcharge:  _round2(peakSurcharge),
    memberDiscount: _round2(discount),
    subtotal:       _round2(subtotal),
    total,
    deposit,
    currency: p.currency || 'KES',
  };
}

/* ── Sanitizers ───────────────────────────────────────────────────────────── */

function _sanitizePricing(p) {
  p = p || {};
  return {
    baseRatePerHour:   Math.max(0, Number(p.baseRatePerHour)  || 0),
    baseRatePerDay:    Math.max(0, Number(p.baseRatePerDay)   || 0),
    halfDayRate:       Math.max(0, Number(p.halfDayRate)      || 0),
    weekendMultiplier: _clamp(p.weekendMultiplier, 1.0, 10.0, 1.0),
    peakHours: Array.isArray(p.peakHours)
      ? p.peakHours.slice(0, 8).map(ph => ({
          start:      String(ph.start || '17:00'),
          end:        String(ph.end   || '21:00'),
          multiplier: _clamp(ph.multiplier, 1.0, 5.0, 1.3),
        }))
      : [],
    holidayMultiplier: _clamp(p.holidayMultiplier, 1.0, 10.0, 1.0),
    memberDiscount:    _clamp(p.memberDiscount, 0, 0.5, 0),
    depositPercent:    _clamp(p.depositPercent, 0, 1.0, 1.0),
    cancellationPolicy: {
      freeCancellationHours:      _clamp(p.cancellationPolicy?.freeCancellationHours,      0, 168, 24),
      lateCancellationFeePercent: _clamp(p.cancellationPolicy?.lateCancellationFeePercent, 0, 100,  0),
      noShowFeePercent:           _clamp(p.cancellationPolicy?.noShowFeePercent,           0, 100, 100),
    },
    currency: p.currency || 'KES',
  };
}

function _sanitizeCapacity(c) {
  c = c || {};
  return {
    maxOccupancy:          _clamp(c.maxOccupancy,          1, 1_000_000, 50),
    maxConcurrentBookings: _clamp(c.maxConcurrentBookings, 1, 10_000,     1),
    teamSizeLimit:         c.teamSizeLimit   ? _clamp(c.teamSizeLimit,   1, 1_000_000, null) : null,
    spectatorLimit:        c.spectatorLimit  ? _clamp(c.spectatorLimit,  1, 1_000_000, null) : null,
    parkingCapacity:       _clamp(c.parkingCapacity, 0, 100_000, 0),
  };
}

function _defaultSchedule() {
  const sched = {};
  ['monday','tuesday','wednesday','thursday','friday'].forEach(d => {
    sched[d] = { open: '08:00', close: '22:00', closed: false };
  });
  ['saturday','sunday'].forEach(d => {
    sched[d] = { open: '09:00', close: '18:00', closed: false };
  });
  return sched;
}

/* ═══════════════════════════════════════════════════════════════════════════
   CF 1 — venueCreate
   Owner or admin creates a new venue / bookable resource.
═══════════════════════════════════════════════════════════════════════════ */
exports.venueCreate = onCall(CF_OPTS, exports._h.venueCreate = async (request) => {
  const uid = _uid(request);
  const d   = request.data || {};

  const name = String(d.name || '').trim();
  if (!name) throw new HttpsError('invalid-argument', 'name is required.');
  if (!VENUE_TYPES.has(d.type)) {
    throw new HttpsError('invalid-argument', `type must be one of: ${[...VENUE_TYPES].join(', ')}.`);
  }

  const venueId = db.collection('venues').doc().id;
  const now     = admin.firestore.Timestamp.now();

  const doc = {
    id:      venueId,
    ownerId: uid,
    name,
    type:        d.type,
    description: String(d.description || '').slice(0, 3000),
    photos:      Array.isArray(d.photos) ? d.photos.slice(0, 20) : [],
    virtualTour: d.virtualTour || null,
    location: {
      address: String(d.location?.address || '').trim(),
      city:    String(d.location?.city    || '').trim(),
      country: d.location?.country || 'KE',
      lat:     typeof d.location?.lat === 'number' ? d.location.lat : null,
      lng:     typeof d.location?.lng === 'number' ? d.location.lng : null,
    },
    capacity:         _sanitizeCapacity(d.capacity),
    amenities:        Array.isArray(d.amenities)     ? d.amenities.slice(0, 50) : [],
    accessibility:    Array.isArray(d.accessibility) ? d.accessibility.slice(0, 20) : [],
    rules:            String(d.rules || '').slice(0, 5000),
    isShared:         !!d.isShared,
    bookingModels:    Array.isArray(d.bookingModels)
      ? d.bookingModels.filter(m => BOOKING_MODELS.has(m))
      : ['hourly'],
    slotDurationMins: _clamp(d.slotDurationMins, 15, 1440, 60),
    bufferMins:       _clamp(d.bufferMins, 0, 240, 15),
    /* Phase-1 booking additions. Granular buffer (setup before / cleanup after)
       and a per-customer active-booking cap. All DEFAULT 0 so existing venues
       behave exactly as before — owners opt in. bufferMins stays for back-compat
       but the booking engine reads the granular fields. */
    bufferBeforeMins:       _clamp(d.bufferBeforeMins, 0, 240, 0),
    bufferAfterMins:        _clamp(d.bufferAfterMins,  0, 240, 0),
    maxBookingsPerCustomer: _clamp(d.maxBookingsPerCustomer, 0, 1000, 0),
    /* Phase-2 booking addition. DEFAULT false → the venue has no waitlist and
       bookingJoinWaitlist rejects, so existing venues are unchanged. */
    waitlistEnabled:        !!d.waitlistEnabled,
    requiresApproval: !!d.requiresApproval,
    afterHoursBooking: !!d.afterHoursBooking,
    schedule:         d.schedule || _defaultSchedule(),
    pricing:          _sanitizePricing(d.pricing),
    status:           'active',
    rating:           0,
    reviewCount:      0,
    createdAt:        now,
    updatedAt:        now,
  };

  await db.collection('venues').doc(venueId).set(doc);
  console.log('venueCreate', { venueId, ownerId: uid, name, type: d.type });
  return { venueId, name };
});

/* ═══════════════════════════════════════════════════════════════════════════
   CF 2 — venueUpdate
   Owner updates venue config. Only allowed keys are patched.
═══════════════════════════════════════════════════════════════════════════ */
exports.venueUpdate = onCall(CF_OPTS, exports._h.venueUpdate = async (request) => {
  const uid   = _uid(request);
  const d     = request.data || {};
  const venue = await _venueOrThrow(d.venueId);
  _assertOwnerOrAdmin(venue, uid, request);

  const allowed = [
    'name','description','photos','virtualTour','location',
    'capacity','amenities','accessibility','rules','isShared',
    'bookingModels','slotDurationMins','bufferMins',
    'bufferBeforeMins','bufferAfterMins','maxBookingsPerCustomer','waitlistEnabled',
    'requiresApproval','afterHoursBooking','schedule','pricing','status',
  ];

  const updates = { updatedAt: admin.firestore.Timestamp.now() };
  allowed.forEach(k => { if (d[k] !== undefined) updates[k] = d[k]; });
  if (updates.waitlistEnabled !== undefined) updates.waitlistEnabled = !!updates.waitlistEnabled;

  if (updates.pricing)          updates.pricing          = _sanitizePricing(updates.pricing);
  if (updates.capacity)         updates.capacity         = _sanitizeCapacity(updates.capacity);
  if (updates.slotDurationMins) updates.slotDurationMins = _clamp(updates.slotDurationMins, 15, 1440, 60);
  if (updates.bufferMins !== undefined) updates.bufferMins = _clamp(updates.bufferMins, 0, 240, 0);
  if (updates.bufferBeforeMins !== undefined) updates.bufferBeforeMins = _clamp(updates.bufferBeforeMins, 0, 240, 0);
  if (updates.bufferAfterMins !== undefined)  updates.bufferAfterMins  = _clamp(updates.bufferAfterMins, 0, 240, 0);
  if (updates.maxBookingsPerCustomer !== undefined) updates.maxBookingsPerCustomer = _clamp(updates.maxBookingsPerCustomer, 0, 1000, 0);
  if (updates.name) updates.name = String(updates.name).trim().slice(0, 200);

  await db.collection('venues').doc(d.venueId).update(updates);
  return { updated: true };
});

/* ═══════════════════════════════════════════════════════════════════════════
   CF 3 — venueGetPublic
   Public read of venue profile (no owner fields exposed).
═══════════════════════════════════════════════════════════════════════════ */
exports.venueGetPublic = onCall(CF_PUB, exports._h.venueGetPublic = async (request) => {
  const venue = await _venueOrThrow(request.data?.venueId);
  const { ownerId: _o, ...pub } = venue; // strip private field
  return pub;
});

/* ═══════════════════════════════════════════════════════════════════════════
   CF 4 — venueGetAvailability
   Generate slot grids for a date range without requiring auth.
   Reads blockouts + existing bookings via sub-collection doc-ID prefix ranges
   (no composite indexes needed).
═══════════════════════════════════════════════════════════════════════════ */
exports.venueGetAvailability = onCall(CF_PUB, exports._h.venueGetAvailability = async (request) => {
  const d         = request.data || {};
  const { venueId, startDate, days = 7 } = d;
  const venue     = await _venueOrThrow(venueId);
  const today     = _nairobiDateOffset(0);
  const fromDate  = startDate || today;
  const maxDays   = _clamp(days, 1, 60, 7);

  if (!/^\d{4}-\d{2}-\d{2}$/.test(fromDate)) {
    throw new HttpsError('invalid-argument', 'startDate must be YYYY-MM-DD.');
  }

  // Fetch blockouts that might overlap the requested range
  const blockSnap = await db.collection('venues').doc(venueId)
    .collection('blockouts')
    .where('endDate', '>=', fromDate)
    .limit(100).get();
  const blockouts = blockSnap.docs.map(s => s.data());

  const results = [];

  for (let i = 0; i < maxDays; i++) {
    const dt = new Date(fromDate + 'T12:00:00');
    dt.setDate(dt.getDate() + i);
    const dateStr = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;

    // Blockout check
    const isBlocked = blockouts.some(b => dateStr >= b.startDate && dateStr <= b.endDate);
    if (isBlocked) {
      results.push({ date: dateStr, available: false, reason: 'blocked', slots: [] });
      continue;
    }

    // Schedule check
    const dow = _dayOfWeek(dateStr);
    const sch = venue.schedule?.[dow];
    if (!sch || sch.closed) {
      results.push({ date: dateStr, available: false, reason: 'closed', slots: [] });
      continue;
    }

    // Fetch bookings for this date (doc-ID prefix range — no composite index)
    const bookSnap = await db.collection('venues').doc(venueId).collection('bookings')
      .orderBy(FP.documentId())
      .startAt(dateStr + '_')
      .endAt(dateStr + '_')
      .get();

    const activeBookings = bookSnap.docs.map(s => s.data())
      .filter(b => !TERMINAL_STATUSES.has(b.status));

    const slots  = _generateDaySlots(venue, dateStr, activeBookings);
    const hasAny = slots.some(s => s.available);

    results.push({ date: dateStr, available: hasAny, slots });
  }

  return { venueId, results };
});

/* ═══════════════════════════════════════════════════════════════════════════
   CF 5 — venueCalculatePrice
   Dynamic price breakdown for a proposed booking.
═══════════════════════════════════════════════════════════════════════════ */
exports.venueCalculatePrice = onCall(CF_PUB, exports._h.venueCalculatePrice = async (request) => {
  const d = request.data || {};
  if (!d.venueId || !d.date || !d.startTime || !d.durationMins) {
    throw new HttpsError('invalid-argument', 'venueId, date, startTime, durationMins required.');
  }
  const venue = await _venueOrThrow(d.venueId);
  return _calcPrice(venue, d.date, d.startTime, Number(d.durationMins), !!d.isMember);
});

/* ═══════════════════════════════════════════════════════════════════════════
   CF 6 — venueCreateBooking
   Atomic slot reservation — uses runTransaction() to prevent double-booking.
   Creates booking in sub-collection (slot lock) + top-level (customer queries).
═══════════════════════════════════════════════════════════════════════════ */
exports.venueCreateBooking = onCall(CF_OPTS, exports._h.venueCreateBooking = async (request) => {
  const uid = _uid(request);
  const d   = request.data || {};

  const { venueId, date, startTime, durationMins, bookingModel = 'hourly',
          notes = '', idempotencyKey } = d;

  // Input validation
  if (!venueId || !date || !startTime || !durationMins) {
    throw new HttpsError('invalid-argument', 'venueId, date, startTime, durationMins are required.');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new HttpsError('invalid-argument', 'date must be YYYY-MM-DD.');
  }
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(startTime)) {
    throw new HttpsError('invalid-argument', 'startTime must be HH:mm.');
  }
  const durMins = Number(durationMins);
  if (isNaN(durMins) || durMins < 15 || durMins > 1440) {
    throw new HttpsError('invalid-argument', 'durationMins must be 15–1440.');
  }

  const venue = await _venueOrThrow(venueId);

  const pricing    = _calcPrice(venue, date, startTime, durMins, false);
  const bookingId  = db.collection('venueBookings').doc().id;
  const slotKey    = `${date}_${startTime.replace(':', '')}_${_shortId()}`;
  const endTime    = _timeStr(_mins(startTime) + durMins);
  const now        = admin.firestore.Timestamp.now();
  const autoStatus = venue.requiresApproval ? STATUS.PENDING : STATUS.CONFIRMED;

  /* Idempotency record keyed by document ID for atomic tx.get() lookup.
     Two concurrent requests with the same key: one commits and writes this
     doc; the other retries, sees it exists, and returns the cached booking. */
  const idemRef = idempotencyKey
    ? db.collection('_venueBkgIdempotency').doc(String(idempotencyKey))
    : null;

  let isReplay   = false;
  let replayData = null;

  const bookingData = {
    bookingId,
    venueId,
    venueName:   venue.name,
    venueType:   venue.type,
    customerId:  uid,
    date,
    startTime,
    endTime,
    durationMins: durMins,
    bookingModel: BOOKING_MODELS.has(bookingModel) ? bookingModel : 'hourly',
    status:      autoStatus,
    pricing,
    payment:     { status: 'pending', transactionId: null, paidAt: null },
    notes:       String(notes).slice(0, 500),
    idempotencyKey: idempotencyKey || null,
    checkinAt:   null,
    checkoutAt:  null,
    slotKey,
    createdAt:   now,
    updatedAt:   now,
  };

  await db.runTransaction(async (tx) => {
    /* Reset on each retry */
    isReplay = false;

    /* ── Idempotency guard (atomic doc read) ────────────────────────────────
       Must be inside the transaction: read + write of the idempotency record
       are atomic — no window for a concurrent request to slip through.
    ── */
    if (idemRef) {
      const idemSnap = await tx.get(idemRef);
      if (idemSnap.exists) {
        isReplay   = true;
        replayData = idemSnap.data();
        return; /* no writes — idempotent */
      }
    }

    /* ── Overlap check (transactional read of the venue sub-collection) ─── */
    const daySnap = await tx.get(
      db.collection('venues').doc(venueId).collection('bookings')
        .orderBy(FP.documentId())
        .startAt(date + '_')
        .endAt(date + '_'),
    );

    const active = daySnap.docs.map(s => s.data())
      .filter(b => !TERMINAL_STATUSES.has(b.status));

    const newStart = _mins(startTime);
    const newEnd   = newStart + durMins;

    if (!venue.isShared) {
      // Exclusive venue: zero overlap allowed
      const conflict = active.some(b => {
        const bs = _mins(b.startTime), be = _mins(b.endTime);
        return newStart < be && newEnd > bs;
      });
      if (conflict) throw new HttpsError('already-exists', 'This time slot is already booked.');
    } else {
      // Shared venue: check concurrent booking limit
      const maxConcurrent = venue.capacity?.maxConcurrentBookings || 1;
      const concurrent = active.filter(b => {
        const bs = _mins(b.startTime), be = _mins(b.endTime);
        return newStart < be && newEnd > bs;
      }).length;
      if (concurrent >= maxConcurrent) {
        throw new HttpsError('resource-exhausted', `Venue capacity full (max ${maxConcurrent} concurrent bookings).`);
      }
    }

    /* Slot lock to sub-collection — the overlap check reads this */
    tx.set(
      db.collection('venues').doc(venueId).collection('bookings').doc(slotKey),
      bookingData,
    );
    /* Customer-queryable mirror */
    tx.set(db.collection('venueBookings').doc(bookingId), bookingData);
    /* Idempotency record written atomically */
    if (idemRef) {
      tx.set(idemRef, { bookingId, uid, venueId, date, startTime, status: autoStatus, createdAt: Date.now() });
    }
  });

  if (isReplay) {
    return { bookingId: replayData.bookingId, idempotent: true, status: replayData.status, pricing };
  }

  console.log('venueCreateBooking', { bookingId, venueId, uid, date, startTime, status: autoStatus });
  return { bookingId, status: autoStatus, pricing, requiresApproval: venue.requiresApproval };
});

/* ═══════════════════════════════════════════════════════════════════════════
   CF 7 — venueCancelBooking
   Cancel with cancellation fee applied per policy.
═══════════════════════════════════════════════════════════════════════════ */
exports.venueCancelBooking = onCall(CF_OPTS, exports._h.venueCancelBooking = async (request) => {
  const uid     = _uid(request);
  const d       = request.data || {};
  const booking = await _bookingOrThrow(d.bookingId);

  if (TERMINAL_STATUSES.has(booking.status)) {
    throw new HttpsError('failed-precondition', `Booking is already ${booking.status}.`);
  }

  // Access check: customer (own booking), venue owner, or admin
  if (booking.customerId !== uid && !_isAdmin(request)) {
    const venue = await _venueOrThrow(booking.venueId);
    if (venue.ownerId !== uid) throw new HttpsError('permission-denied', 'Access denied.');
  }

  // Cancellation fee calculation
  const venue  = await _venueOrThrow(booking.venueId);
  const policy = venue.pricing?.cancellationPolicy || {};
  const bStart = new Date(`${booking.date}T${booking.startTime}:00`);
  const hoursUntil = (bStart - new Date()) / 3_600_000;
  const freeBefore = policy.freeCancellationHours || 24;
  const latePct    = hoursUntil < freeBefore ? (policy.lateCancellationFeePercent || 0) : 0;
  const fee        = _round2(booking.pricing.total * latePct / 100);

  const now = admin.firestore.Timestamp.now();
  const upd = {
    status:          STATUS.CANCELLED,
    cancelledAt:     now,
    cancelReason:    String(d.reason || '').slice(0, 500),
    cancellationFee: fee,
    updatedAt:       now,
  };

  await db.runTransaction(async (tx) => {
    tx.update(db.collection('venues').doc(booking.venueId).collection('bookings').doc(booking.slotKey), upd);
    tx.update(db.collection('venueBookings').doc(d.bookingId), upd);
  });

  console.log('venueCancelBooking', { bookingId: d.bookingId, uid, fee });
  return { cancelled: true, cancellationFee: fee, currency: booking.pricing.currency };
});

/* ═══════════════════════════════════════════════════════════════════════════
   CF 8 — venueConfirmBooking
   Venue owner or admin confirms a pending booking.
═══════════════════════════════════════════════════════════════════════════ */
exports.venueConfirmBooking = onCall(CF_OPTS, exports._h.venueConfirmBooking = async (request) => {
  const uid     = _uid(request);
  const d       = request.data || {};
  const booking = await _bookingOrThrow(d.bookingId);
  const venue   = await _venueOrThrow(booking.venueId);
  _assertOwnerOrAdmin(venue, uid, request);

  if (booking.status !== STATUS.PENDING) {
    throw new HttpsError('failed-precondition', `Booking status is '${booking.status}', expected 'pending_payment'.`);
  }

  const now = admin.firestore.Timestamp.now();
  const upd = { status: STATUS.CONFIRMED, confirmedAt: now, updatedAt: now };

  await db.runTransaction(async (tx) => {
    tx.update(db.collection('venues').doc(booking.venueId).collection('bookings').doc(booking.slotKey), upd);
    tx.update(db.collection('venueBookings').doc(d.bookingId), upd);
  });

  return { confirmed: true };
});

/* ═══════════════════════════════════════════════════════════════════════════
   CF 9 — venueCheckIn
   Mark a confirmed booking as checked-in.
═══════════════════════════════════════════════════════════════════════════ */
exports.venueCheckIn = onCall(CF_OPTS, exports._h.venueCheckIn = async (request) => {
  const uid     = _uid(request);
  const d       = request.data || {};
  const booking = await _bookingOrThrow(d.bookingId);
  const venue   = await _venueOrThrow(booking.venueId);
  _assertOwnerOrAdmin(venue, uid, request);

  if (booking.status !== STATUS.CONFIRMED) {
    throw new HttpsError('failed-precondition', 'Booking must be confirmed before check-in.');
  }

  const now = admin.firestore.Timestamp.now();
  const upd = { status: STATUS.CHECKIN, checkinAt: now, updatedAt: now };

  await db.runTransaction(async (tx) => {
    tx.update(db.collection('venues').doc(booking.venueId).collection('bookings').doc(booking.slotKey), upd);
    tx.update(db.collection('venueBookings').doc(d.bookingId), upd);
  });

  return { checkedIn: true };
});

/* ═══════════════════════════════════════════════════════════════════════════
   CF 10 — venueCheckOut
   Complete a booking — marks the slot as available again.
═══════════════════════════════════════════════════════════════════════════ */
exports.venueCheckOut = onCall(CF_OPTS, exports._h.venueCheckOut = async (request) => {
  const uid     = _uid(request);
  const d       = request.data || {};
  const booking = await _bookingOrThrow(d.bookingId);
  const venue   = await _venueOrThrow(booking.venueId);
  _assertOwnerOrAdmin(venue, uid, request);

  if (booking.status !== STATUS.CHECKIN) {
    throw new HttpsError('failed-precondition', 'Booking is not currently checked in.');
  }

  const now = admin.firestore.Timestamp.now();
  const upd = { status: STATUS.COMPLETE, checkoutAt: now, updatedAt: now };

  await db.runTransaction(async (tx) => {
    tx.update(db.collection('venues').doc(booking.venueId).collection('bookings').doc(booking.slotKey), upd);
    tx.update(db.collection('venueBookings').doc(d.bookingId), upd);
  });

  return { completed: true };
});

/* ═══════════════════════════════════════════════════════════════════════════
   CF 11 — venueMarkNoShow
   Owner marks a no-show (booking started but customer never arrived).
═══════════════════════════════════════════════════════════════════════════ */
exports.venueMarkNoShow = onCall(CF_OPTS, exports._h.venueMarkNoShow = async (request) => {
  const uid     = _uid(request);
  const d       = request.data || {};
  const booking = await _bookingOrThrow(d.bookingId);
  const venue   = await _venueOrThrow(booking.venueId);
  _assertOwnerOrAdmin(venue, uid, request);

  if (TERMINAL_STATUSES.has(booking.status)) {
    throw new HttpsError('failed-precondition', `Booking already ${booking.status}.`);
  }

  const policy  = venue.pricing?.cancellationPolicy || {};
  const noShowFee = _round2(booking.pricing.total * (policy.noShowFeePercent || 100) / 100);

  const now = admin.firestore.Timestamp.now();
  const upd = { status: STATUS.NO_SHOW, noShowAt: now, noShowFee, updatedAt: now };

  await db.runTransaction(async (tx) => {
    tx.update(db.collection('venues').doc(booking.venueId).collection('bookings').doc(booking.slotKey), upd);
    tx.update(db.collection('venueBookings').doc(d.bookingId), upd);
  });

  return { noShow: true, noShowFee, currency: booking.pricing.currency };
});

/* ═══════════════════════════════════════════════════════════════════════════
   CF 12 — venueGetBooking
   Fetch a single booking — customer (own) or venue owner or admin.
═══════════════════════════════════════════════════════════════════════════ */
exports.venueGetBooking = onCall(CF_OPTS, exports._h.venueGetBooking = async (request) => {
  const uid     = _uid(request);
  const booking = await _bookingOrThrow(request.data?.bookingId);

  if (booking.customerId !== uid && !_isAdmin(request)) {
    const venue = await _venueOrThrow(booking.venueId);
    if (venue.ownerId !== uid) throw new HttpsError('permission-denied', 'Access denied.');
  }
  return booking;
});

/* ═══════════════════════════════════════════════════════════════════════════
   CF 13 — venueGetMyBookings
   Customer's booking history — paginated, most-recent first.
   Uses composite index: venueBookings { customerId ASC, createdAt DESC }
═══════════════════════════════════════════════════════════════════════════ */
exports.venueGetMyBookings = onCall(CF_OPTS, exports._h.venueGetMyBookings = async (request) => {
  const uid  = _uid(request);
  const d    = request.data || {};
  const lim  = _clamp(d.limit, 1, 50, 20);

  let query = db.collection('venueBookings')
    .where('customerId', '==', uid)
    .orderBy('createdAt', 'desc')
    .limit(lim + 1); // fetch +1 to detect next page

  if (d.cursor) {
    const cs = await db.collection('venueBookings').doc(d.cursor).get();
    if (cs.exists) query = query.startAfter(cs);
  }

  const snap     = await query.get();
  let items      = snap.docs.map(s => ({ id: s.id, ...s.data() }));
  const hasMore  = items.length > lim;
  if (hasMore) items = items.slice(0, lim);
  const nextCursor = hasMore ? items[items.length - 1].id : null;

  // Client-side status filter (avoids extra composite index)
  if (d.status) items = items.filter(b => b.status === d.status);

  return { bookings: items, nextCursor };
});

/* ═══════════════════════════════════════════════════════════════════════════
   CF 14 — venueGetCalendar
   Owner calendar view — returns bookings and blockouts for a date range.
   Uses doc-ID prefix range queries — no composite indexes needed.
═══════════════════════════════════════════════════════════════════════════ */
exports.venueGetCalendar = onCall(CF_OPTS, exports._h.venueGetCalendar = async (request) => {
  const uid   = _uid(request);
  const d     = request.data || {};
  const venue = await _venueOrThrow(d.venueId);
  _assertOwnerOrAdmin(venue, uid, request);

  const { startDate, endDate } = d;
  if (!startDate || !endDate || startDate > endDate) {
    throw new HttpsError('invalid-argument', 'startDate and endDate required (startDate ≤ endDate).');
  }

  const [bookSnap, blockSnap] = await Promise.all([
    db.collection('venues').doc(d.venueId).collection('bookings')
      .orderBy(FP.documentId())
      .startAt(startDate + '_')
      .endAt(endDate + '_')
      .limit(500)
      .get(),
    db.collection('venues').doc(d.venueId).collection('blockouts')
      .where('endDate', '>=', startDate)
      .limit(50)
      .get(),
  ]);

  const bookings = bookSnap.docs.map(s => ({ slotKey: s.id, ...s.data() }));
  const blockouts = blockSnap.docs.map(s => ({ id: s.id, ...s.data() }))
    .filter(b => b.startDate <= endDate); // trim to range

  return { venueId: d.venueId, startDate, endDate, bookings, blockouts };
});

/* ═══════════════════════════════════════════════════════════════════════════
   CF 15 — venueBlockDates
   Block a date range for maintenance, private events, holidays, or cleaning.
═══════════════════════════════════════════════════════════════════════════ */
exports.venueBlockDates = onCall(CF_OPTS, exports._h.venueBlockDates = async (request) => {
  const uid   = _uid(request);
  const d     = request.data || {};
  const venue = await _venueOrThrow(d.venueId);
  _assertOwnerOrAdmin(venue, uid, request);

  const { startDate, endDate, reason = 'maintenance', note = '' } = d;
  if (!startDate || !endDate) {
    throw new HttpsError('invalid-argument', 'startDate and endDate required.');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
    throw new HttpsError('invalid-argument', 'Dates must be YYYY-MM-DD.');
  }
  if (startDate > endDate) {
    throw new HttpsError('invalid-argument', 'startDate must be ≤ endDate.');
  }

  const REASONS = new Set(['maintenance','private_event','holiday','cleaning','other']);
  const blockId  = db.collection('venues').doc(d.venueId).collection('blockouts').doc().id;

  await db.collection('venues').doc(d.venueId).collection('blockouts').doc(blockId).set({
    blockId,
    startDate,
    endDate,
    reason: REASONS.has(reason) ? reason : 'other',
    note:   String(note).slice(0, 500),
    createdBy: uid,
    createdAt: admin.firestore.Timestamp.now(),
  });

  console.log('venueBlockDates', { blockId, venueId: d.venueId, startDate, endDate, reason });
  return { blockId, startDate, endDate };
});

/* ═══════════════════════════════════════════════════════════════════════════
   CF 16 — venueRemoveBlock
   Remove a blockout. Automatically makes those dates bookable again.
═══════════════════════════════════════════════════════════════════════════ */
exports.venueRemoveBlock = onCall(CF_OPTS, exports._h.venueRemoveBlock = async (request) => {
  const uid   = _uid(request);
  const d     = request.data || {};
  const venue = await _venueOrThrow(d.venueId);
  _assertOwnerOrAdmin(venue, uid, request);

  if (!d.blockId) throw new HttpsError('invalid-argument', 'blockId required.');

  await db.collection('venues').doc(d.venueId).collection('blockouts').doc(d.blockId).delete();
  return { removed: true };
});

/* ═══════════════════════════════════════════════════════════════════════════
   CF 17 — venueGetStats
   30-day analytics for the venue owner: revenue, utilisation, peak hours.
═══════════════════════════════════════════════════════════════════════════ */
exports.venueGetStats = onCall(CF_OPTS, exports._h.venueGetStats = async (request) => {
  const uid   = _uid(request);
  const d     = request.data || {};
  const venue = await _venueOrThrow(d.venueId);
  _assertOwnerOrAdmin(venue, uid, request);

  const today   = _nairobiDateOffset(0);
  const d30     = new Date(today + 'T00:00:00');
  d30.setDate(d30.getDate() - 30);
  const from30  = `${d30.getFullYear()}-${String(d30.getMonth() + 1).padStart(2, '0')}-${String(d30.getDate()).padStart(2, '0')}`;

  const snap = await db.collection('venues').doc(d.venueId).collection('bookings')
    .orderBy(FP.documentId())
    .startAt(from30 + '_')
    .endAt(today + '_')
    .limit(2000)
    .get();

  const all        = snap.docs.map(s => s.data());
  const active     = all.filter(b => !TERMINAL_STATUSES.has(b.status));
  const cancelled  = all.filter(b => b.status === STATUS.CANCELLED).length;
  const noShows    = all.filter(b => b.status === STATUS.NO_SHOW).length;

  const totalRevenue    = _round2(active.reduce((s, b) => s + (b.pricing?.total || 0), 0));
  const totalBookings   = active.length;
  const avgValue        = totalBookings > 0 ? _round2(totalRevenue / totalBookings) : 0;
  const cancelRate      = all.length > 0 ? Math.round(cancelled / all.length * 100) : 0;

  // Hour distribution
  const hourMap = {};
  active.forEach(b => {
    const h = b.startTime?.split(':')[0];
    if (h) hourMap[h] = (hourMap[h] || 0) + 1;
  });
  const peakHour = Object.entries(hourMap).sort((a, b) => b[1] - a[1])[0]?.[0];

  // Day distribution
  const dayMap = {};
  active.forEach(b => {
    if (b.date) dayMap[b.date] = (dayMap[b.date] || 0) + 1;
  });
  const busiestDay = Object.entries(dayMap).sort((a, b) => b[1] - a[1])[0]?.[0];

  return {
    venueId:      d.venueId,
    period:       { from: from30, to: today },
    totalRevenue,
    totalBookings,
    cancelledCount:   cancelled,
    noShowCount:      noShows,
    cancellationRate: cancelRate,
    avgBookingValue:  avgValue,
    peakHour:     peakHour  ? `${peakHour}:00` : null,
    busiestDay,
    currency:     venue.pricing?.currency || 'KES',
  };
});
