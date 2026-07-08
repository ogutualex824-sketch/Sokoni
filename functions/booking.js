/* ================================================================
   SOKONI Universal Venue & Resource Booking — Cloud Functions v1.0
   14 functions — server-authoritative, Firestore-transactional
================================================================ */
const functions  = require('firebase-functions/v2');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const admin      = require('firebase-admin');
if (!admin.apps.length) admin.initializeApp();

const db   = admin.firestore();
const FieldValue = admin.firestore.FieldValue;

/* ─── Helpers ───────────────────────────────────────────── */
function _uid()      { return db.collection('_').doc().id; }
function _kes(n)     { return 'KES ' + Number(n||0).toFixed(2); }
function _sanitize(s){ return String(s||'').replace(/[<>"'`]/g,''); }
function _dayKey(ts) { return new Date(ts).toISOString().slice(0,10); }
function _pad2(n)    { return String(n).padStart(2,'0'); }
function _timeToMins(t){ const [h,m]=String(t||'00:00').split(':').map(Number); return h*60+(m||0); }
function _minsToTime(m){ return _pad2(Math.floor(m/60))+':'+_pad2(m%60); }
function _dayOfWeek(dateStr){ return ['sun','mon','tue','wed','thu','fri','sat'][new Date(dateStr).getDay()]; }

function _authRequired(req) {
  if (!req.auth) throw new HttpsError('unauthenticated','Sign in required');
  return req.auth.uid;
}

/* ── Pricing (mirrors client engine) ─────────────────────── */
function _calculatePrice(venue, startMins, endMins, dateStr, opts={}) {
  const p = venue.pricing || {};
  const duration = endMins - startMins;
  if (duration <= 0) return { base:0, surcharge:0, discount:0, addOns:0, deposit:p.deposit||0, total:p.deposit||0 };

  let base = 0;
  const HALF=240, FULL=480;
  if (duration >= FULL && p.fullDay) {
    base = p.fullDay * Math.ceil(duration/FULL);
  } else if (duration >= HALF && p.halfDay) {
    base = p.halfDay;
  } else {
    base = (p.hourly||0) * (duration/60);
  }

  const dow = _dayOfWeek(dateStr);
  let surcharge = 0;
  if ((dow==='sat'||dow==='sun') && p.weekend) surcharge += p.weekend;

  for (const [ps,pe] of (p.peak?.hours||[])) {
    const psM=ps*60, peM=pe*60;
    const ol = Math.max(0,Math.min(endMins,peM)-Math.max(startMins,psM));
    if (ol>0 && p.peak?.rate) surcharge += (p.peak.rate-(p.hourly||0))*(ol/60);
  }
  if (opts.isHoliday && p.holiday) surcharge += p.holiday;

  let discount=0;
  if (opts.isMember && p.member?.discount) discount=(base+surcharge)*p.member.discount;
  if (opts.promoDiscount) discount+=(base+surcharge)*opts.promoDiscount;

  const addOns=(opts.addOns||[]).reduce((t,a)=>t+(a.price||0),0);
  const subtotal=base+surcharge-discount+addOns;
  return { base, surcharge, discount, addOns, subtotal, deposit:p.deposit||0, total:subtotal+(p.deposit||0), duration };
}

/* ── Check for booking overlap ───────────────────────────── */
async function _hasOverlap(venueId, startTs, endTs, excludeBookingId=null) {
  /* Check existing bookings */
  const snap = await db.collection('bookings')
    .where('venueId',  '==', venueId)
    .where('endTs',    '>',  startTs)
    .where('status',   'in', ['pending','confirmed','active'])
    .get();

  for (const doc of snap.docs) {
    if (doc.id === excludeBookingId) continue;
    const b = doc.data();
    if (b.startTs < endTs && b.endTs > startTs) return true;
  }

  /* Check active holds */
  const holdSnap = await db.collection('bookingHolds')
    .where('venueId',   '==', venueId)
    .where('expiresAt', '>',  Date.now())
    .get();

  for (const doc of holdSnap.docs) {
    const h = doc.data();
    if (h.startTs < endTs && h.endTs > startTs) return true;
  }

  /* Check blockouts */
  const blockSnap = await db.collection('venueBlockouts')
    .where('venueId', '==', venueId)
    .get();

  for (const doc of blockSnap.docs) {
    const bl = doc.data();
    if (bl.startTs < endTs && bl.endTs > startTs) return true;
  }

  return false;
}

/* ═══════════════════════════════════════════════════════════
   1. SEARCH VENUES
═══════════════════════════════════════════════════════════ */
exports.bookingSearchVenues = onCall(
  { region: 'us-central1', maxInstances: 80, cors: true, enforceAppCheck: true },
  async (req) => {
    const { type, city, area, date, minCapacity, maxPrice, amenities, indoor, limit = 24, offset = 0 } = req.data || {};

    let query = db.collection('venues').where('status', '==', 'active');
    if (type)        query = query.where('type',    '==', type);
    if (city)        query = query.where('city',    '==', city);
    if (area)        query = query.where('area',    '==', area);
    if (minCapacity) query = query.where('capacity.max', '>=', minCapacity);
    if (indoor !== undefined) query = query.where('indoor', '==', indoor);

    const snap = await query.orderBy('rating', 'desc').limit(limit + offset).get();
    let venues = snap.docs.slice(offset).map(d => ({ id: d.id, ...d.data() }));

    /* Filter by price (cannot do in Firestore without composite index) */
    if (maxPrice) venues = venues.filter(v => (v.pricing?.hourly || 0) <= maxPrice);
    /* Filter by amenities */
    if (amenities?.length) venues = venues.filter(v => amenities.every(a => (v.amenities||[]).includes(a)));

    /* Enrich with live status */
    const today = date || _dayKey(Date.now());
    return venues.map(v => ({ ...v, liveStatus: _getLiveStatus(v, today) }));
  }
);

function _getLiveStatus(venue, dateStr) {
  const dow = _dayOfWeek(dateStr);
  const h   = (venue.openingHours||{})[dow];
  if (!h || h.closed || venue.status==='maintenance') return 'closed';
  const now = new Date(); const mins = now.getHours()*60 + now.getMinutes();
  const o = _timeToMins(h.open), c = _timeToMins(h.close);
  if (mins < o-30) return 'opens_soon';
  if (mins < o)    return 'opens_soon';
  if (mins > c)    return 'closed';
  if (mins > c-30) return 'closing_soon';
  return 'available';
}

/* ═══════════════════════════════════════════════════════════
   2. GET VENUE DETAIL
═══════════════════════════════════════════════════════════ */
exports.bookingGetVenue = onCall(
  { region: 'us-central1', maxInstances: 50, cors: true, enforceAppCheck: true },
  async (req) => {
    const { venueId } = req.data || {};
    if (!venueId) throw new HttpsError('invalid-argument','venueId required');
    const snap = await db.collection('venues').doc(venueId).get();
    if (!snap.exists) throw new HttpsError('not-found','Venue not found');
    return { id: snap.id, ...snap.data() };
  }
);

/* ═══════════════════════════════════════════════════════════
   3. GET AVAILABILITY (slots for a specific date)
═══════════════════════════════════════════════════════════ */
exports.bookingGetAvailability = onCall(
  { region: 'us-central1', maxInstances: 100, cors: true, enforceAppCheck: true },
  async (req) => {
    const { venueId, date } = req.data || {};
    if (!venueId || !date) throw new HttpsError('invalid-argument','venueId and date required');

    const venueSnap = await db.collection('venues').doc(venueId).get();
    if (!venueSnap.exists) throw new HttpsError('not-found','Venue not found');
    const venue = venueSnap.data();

    const dow   = _dayOfWeek(date);
    const hours = (venue.openingHours||{})[dow];
    if (!hours || hours.closed) return { date, slots: [], status: 'closed' };
    if (venue.status === 'maintenance') return { date, slots: [], status: 'maintenance' };

    /* Get day start/end timestamps */
    const dayStart = new Date(date + 'T00:00:00').getTime();
    const dayEnd   = dayStart + 86400000;

    /* Fetch confirmed bookings for this day */
    const bookingsSnap = await db.collection('bookings')
      .where('venueId',  '==', venueId)
      .where('startTs',  '>=', dayStart)
      .where('startTs',  '<',  dayEnd)
      .where('status',   'in', ['pending','confirmed','active'])
      .get();

    const existingBookings = bookingsSnap.docs.map(d => ({
      startTime: d.data().startTime,
      endTime:   d.data().endTime,
    }));

    /* Fetch active holds */
    const holdsSnap = await db.collection('bookingHolds')
      .where('venueId',   '==', venueId)
      .where('expiresAt', '>',  Date.now())
      .get();

    const holds = holdsSnap.docs
      .filter(d => { const s = d.data().startTs; return s >= dayStart && s < dayEnd; })
      .map(d => ({ startTime: d.data().startTime, endTime: d.data().endTime }));

    /* Fetch blockouts */
    const blockSnap = await db.collection('venueBlockouts')
      .where('venueId', '==', venueId)
      .get();

    for (const doc of blockSnap.docs) {
      const bl = doc.data();
      if (bl.startTs < dayEnd && bl.endTs > dayStart) {
        existingBookings.push({
          startTime: _minsToTime(Math.max(0, Math.floor((bl.startTs - dayStart) / 60000))),
          endTime:   _minsToTime(Math.min(24*60, Math.ceil((bl.endTs - dayStart) / 60000))),
        });
      }
    }

    /* Generate slots using same logic as client engine */
    const openM  = _timeToMins(hours.open  || '08:00');
    const closeM = _timeToMins(hours.close || '22:00');
    const buffer = venue.config?.cleaningBuffer || 0;
    const step   = 30;

    const blocked = [...existingBookings, ...holds].map(b => [_timeToMins(b.startTime), _timeToMins(b.endTime)+buffer]);

    const now   = new Date();
    const nowM  = now.getHours()*60+now.getMinutes();
    const today = _dayKey(Date.now());

    const slots = [];
    for (let s = openM; s+step <= closeM; s += step) {
      if (date === today && s <= nowM+15) continue;
      const overlap = blocked.some(([bs,be])=> s<be && s+step>bs);
      slots.push({
        id:        `${date}_${_minsToTime(s)}`,
        startTime: _minsToTime(s),
        endTime:   _minsToTime(s+step),
        startMins: s,
        endMins:   s+step,
        available: !overlap,
      });
    }

    /* Capacity: check concurrent booking count */
    const concurrent = venue.capacity?.concurrent || 1;
    if (concurrent > 1) {
      /* Mark all slots available (shared venue handles concurrent) */
      for (const slot of slots) slot.concurrent = true;
    }

    return { date, slots, openTime: hours.open, closeTime: hours.close, venue: { name: venue.name, type: venue.type } };
  }
);

/* ═══════════════════════════════════════════════════════════
   4. HOLD SLOT (2-minute atomic lock)
═══════════════════════════════════════════════════════════ */
exports.bookingHoldSlot = onCall(
  { region: 'us-central1', maxInstances: 100, cors: true, enforceAppCheck: true },
  async (req) => {
    const uid = _authRequired(req);
    const { venueId, startTs, endTs, holdId } = req.data || {};
    if (!venueId || !startTs || !endTs) throw new HttpsError('invalid-argument','venueId, startTs, endTs required');
    if (endTs <= startTs) throw new HttpsError('invalid-argument','endTs must be after startTs');

    /* Atomic: check + write in transaction */
    const held = await db.runTransaction(async txn => {
      /* Check for overlap */
      const bSnap = await db.collection('bookings')
        .where('venueId','==',venueId)
        .where('endTs','>',startTs)
        .where('status','in',['pending','confirmed','active'])
        .get();

      for (const doc of bSnap.docs) {
        const b = doc.data();
        if (b.startTs < endTs && b.endTs > startTs) return false;
      }

      /* Check existing holds */
      const hSnap = await db.collection('bookingHolds')
        .where('venueId','==',venueId)
        .where('expiresAt','>',Date.now())
        .get();

      for (const doc of hSnap.docs) {
        const h = doc.data();
        if (h.startTs < endTs && h.endTs > startTs && h.userId !== uid) return false;
      }

      /* Write hold */
      const date     = _dayKey(startTs);
      const startMins = Math.round((startTs - new Date(date+'T00:00:00').getTime()) / 60000);
      const endMins   = Math.round((endTs   - new Date(date+'T00:00:00').getTime()) / 60000);
      const id = holdId || _uid();
      txn.set(db.collection('bookingHolds').doc(id), {
        venueId, userId: uid, startTs, endTs,
        date,
        startTime: _minsToTime(startMins), endTime: _minsToTime(endMins),
        expiresAt: Date.now() + 2 * 60 * 1000,
        createdAt: Date.now(),
      });
      return id;
    });

    if (!held) throw new HttpsError('already-exists','Slot is no longer available');
    return { held: true, holdId: held, expiresAt: Date.now() + 2*60*1000 };
  }
);

/* ═══════════════════════════════════════════════════════════
   5. RELEASE HOLD
═══════════════════════════════════════════════════════════ */
exports.bookingReleaseHold = onCall(
  { region: 'us-central1', maxInstances: 50, cors: true, enforceAppCheck: true },
  async (req) => {
    _authRequired(req);
    const { holdId } = req.data || {};
    if (!holdId) throw new HttpsError('invalid-argument','holdId required');
    await db.collection('bookingHolds').doc(holdId).delete();
    return { released: true };
  }
);

/* ═══════════════════════════════════════════════════════════
   6. CREATE BOOKING (server-authoritative, idempotent)
═══════════════════════════════════════════════════════════ */
exports.bookingCreate = onCall(
  { region: 'us-central1', maxInstances: 50, cors: true, enforceAppCheck: true },
  async (req) => {
    const uid = _authRequired(req);
    const { venueId, holdId, date, startTime, endTime, addOns = [], notes, paymentId, idempotencyKey } = req.data || {};
    if (!venueId || !date || !startTime || !endTime) {
      throw new HttpsError('invalid-argument','venueId, date, startTime, endTime required');
    }

    /* Fetch venue outside the transaction — venue config rarely changes mid-booking */
    const venueSnap = await db.collection('venues').doc(venueId).get();
    if (!venueSnap.exists) throw new HttpsError('not-found','Venue not found');
    const venue = venueSnap.data();

    /* Calculate timestamps */
    const dayStart = new Date(date + 'T00:00:00').getTime();
    const startMins = _timeToMins(startTime);
    const endMins   = _timeToMins(endTime);
    const startTs   = dayStart + startMins * 60000;
    const endTs     = dayStart + endMins   * 60000;
    const duration  = endMins - startMins;

    if (duration <= 0) throw new HttpsError('invalid-argument','endTime must be after startTime');

    const pricingBreakdown = _calculatePrice(venue, startMins, endMins, date, { addOns });

    /* Fetch user profile outside the transaction — read-only, no conflict risk */
    const userSnap = await db.collection('users').doc(uid).get();
    const user = userSnap.data() || {};

    /* Pre-fetch active bookings for the day for overlap + capacity checks.
       The slotLockRef inside the transaction provides the final CAS guarantee
       against concurrent requests for the same slot. */
    const existingSnap = await db.collection('bookings')
      .where('venueId', '==', venueId)
      .where('date',    '==', date)
      .where('status',  'in', ['pending', 'confirmed', 'active'])
      .get();
    const existingBookings = existingSnap.docs.map(d => d.data());

    const requiresApproval = venue.config?.approvalRequired || false;
    const bookingId = _uid();

    /* Slot-lock document: keyed on the exact time window.
       Writing this atomically inside the transaction prevents two concurrent
       requests for the identical slot from both committing. */
    const slotKey    = `${date}_${startTs}_${endTs}`;
    const slotLockRef = db.collection('venues').doc(venueId).collection('slotLocks').doc(slotKey);

    /* Idempotency record keyed by client-supplied key (document lookup — tx-safe) */
    const idemRef = idempotencyKey
      ? db.collection('_bookingIdempotency').doc(String(idempotencyKey))
      : null;

    let isReplay    = false;
    let replayData  = null;
    let isConflict  = false;
    let conflictCode = 'already-exists';

    await db.runTransaction(async txn => {
      /* Reset per-attempt so transaction retries start clean */
      isReplay = false; isConflict = false;

      /* ── 1. Idempotency guard (atomic document read) ───────────────────────
         Two concurrent requests with the same key: one commits, the other
         retries and sees idemSnap.exists = true → returns the existing booking.
      ── */
      if (idemRef) {
        const idemSnap = await txn.get(idemRef);
        if (idemSnap.exists) {
          isReplay   = true;
          replayData = idemSnap.data();
          return; /* no writes — idempotent */
        }
      }

      /* ── 2. Slot-lock CAS ──────────────────────────────────────────────────
         If the exact slot is already locked (another transaction committed
         first), bail. Firestore's optimistic concurrency also retries THIS
         transaction if a concurrent write touches slotLockRef.
      ── */
      const slotSnap = await txn.get(slotLockRef);
      if (slotSnap.exists) {
        isConflict   = true;
        conflictCode = 'already-exists';
        return;
      }

      /* ── 3. Capacity check (against pre-fetched snapshot) ─────────────────
         Slightly optimistic but acceptable — the slot-lock above prevents
         the most dangerous same-slot race condition.
      ── */
      if (venue.capacity?.max) {
        const concurrent = venue.capacity.concurrent || 1;
        if (existingBookings.length >= concurrent) {
          isConflict   = true;
          conflictCode = 'resource-exhausted';
          return;
        }
      }

      /* ── 4. Overlap check (against pre-fetched snapshot) ──────────────────  */
      const hasOverlap = existingBookings.some(b => b.startTs < endTs && b.endTs > startTs);
      if (hasOverlap) {
        isConflict   = true;
        conflictCode = 'already-exists';
        return;
      }

      /* ── 5. Validate hold ownership ────────────────────────────────────── */
      if (holdId) {
        const holdDoc = await txn.get(db.collection('bookingHolds').doc(holdId));
        if (!holdDoc.exists || holdDoc.data().userId !== uid || holdDoc.data().expiresAt < Date.now()) {
          isConflict   = true;
          conflictCode = 'already-exists';
          return;
        }
        txn.delete(db.collection('bookingHolds').doc(holdId));
      }

      /* ── 6. Atomic writes ─────────────────────────────────────────────── */
      const booking = {
        venueId, venueName: venue.name, venueType: venue.type,
        ownerId: venue.ownerId,
        customerId: uid,
        customerName:  _sanitize(user.name  || user.displayName || ''),
        customerPhone: _sanitize(user.phone || ''),
        customerEmail: _sanitize(user.email || ''),
        date, startTime, endTime, startTs, endTs, duration,
        addOns: (addOns||[]).map(a=>({name:_sanitize(a.name),price:Number(a.price)||0})),
        notes: _sanitize(notes || ''),
        pricingBreakdown,
        status:   requiresApproval ? 'pending' : 'confirmed',
        paymentId: paymentId || null,
        paymentStatus: paymentId ? 'paid' : 'awaiting',
        idempotencyKey: idempotencyKey || null,
        cancellationWindowHours: venue.pricing?.cancellationWindow || 24,
        cancellationFeeRate:     venue.pricing?.cancellationFeeRate || 0,
        reminders: [
          { minutesBefore: 1440, sent: false },
          { minutesBefore:   60, sent: false },
        ],
        checkIn:  null,
        checkOut: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      txn.set(db.collection('bookings').doc(bookingId), booking);

      /* Slot lock — prevents same-slot concurrent write from committing */
      txn.set(slotLockRef, { bookingId, uid, venueId, date, startTime, endTime, createdAt: Date.now() });

      /* Venue booking counter */
      txn.update(db.collection('venues').doc(venueId), {
        totalBookings: FieldValue.increment(1),
        updatedAt:     Date.now(),
      });

      /* Idempotency record written atomically — durable across retries */
      if (idemRef) {
        txn.set(idemRef, { bookingId, uid, venueId, date, startTime, endTime, createdAt: Date.now() });
      }
    });

    /* Resolve outcomes */
    if (isReplay)   return { bookingId: replayData.bookingId, idempotent: true };
    if (isConflict) throw new HttpsError(
      conflictCode,
      conflictCode === 'resource-exhausted' ? 'Venue is fully booked for this time' : 'Slot is no longer available'
    );

    /* Send confirmation notification */
    await db.collection('notifications').add({
      userId:   uid,
      type:     'booking_confirmed',
      title:    `Booking confirmed — ${venue.name}`,
      body:     `${date} · ${startTime}–${endTime} · ${_kes(pricingBreakdown.total)}`,
      data:     { bookingId, venueId },
      priority: 'high',
      category: 'bookings',
      read:     false,
      createdAt: Date.now(),
    });

    /* Notify venue owner */
    if (venue.ownerId) {
      await db.collection('notifications').add({
        userId:   venue.ownerId,
        type:     'new_booking',
        title:    `New booking — ${venue.name}`,
        body:     `${date} · ${startTime}–${endTime}`,
        data:     { bookingId, venueId },
        priority: 'normal',
        category: 'bookings',
        read:     false,
        createdAt: Date.now(),
      });
    }

    return { bookingId, status: (venue.config?.approvalRequired ? 'pending' : 'confirmed'), total: pricingBreakdown.total };
  }
);

/* ═══════════════════════════════════════════════════════════
   7. CANCEL BOOKING
═══════════════════════════════════════════════════════════ */
exports.bookingCancel = onCall(
  { region: 'us-central1', maxInstances: 30, cors: true, enforceAppCheck: true },
  async (req) => {
    const uid = _authRequired(req);
    const { bookingId, reason } = req.data || {};
    if (!bookingId) throw new HttpsError('invalid-argument','bookingId required');

    const bookingRef = db.collection('bookings').doc(bookingId);
    const snap = await bookingRef.get();
    if (!snap.exists) throw new HttpsError('not-found','Booking not found');
    const booking = snap.data();

    /* Only customer or venue owner can cancel */
    const isOwner    = booking.ownerId === uid;
    const isCustomer = booking.customerId === uid;
    if (!isOwner && !isCustomer) {
      throw new HttpsError('permission-denied','Cannot cancel this booking');
    }
    if (['cancelled','completed'].includes(booking.status)) {
      throw new HttpsError('failed-precondition',`Booking is already ${booking.status}`);
    }

    /* Calculate cancellation fee */
    const hoursLeft = (booking.startTs - Date.now()) / 3600000;
    const window    = booking.cancellationWindowHours || 24;
    const feeRate   = booking.cancellationFeeRate || 0;
    const fee       = hoursLeft < window ? (booking.pricingBreakdown?.total || 0) * feeRate : 0;

    await bookingRef.update({
      status:          'cancelled',
      cancelledAt:     Date.now(),
      cancelledBy:     uid,
      cancellationReason: _sanitize(reason || ''),
      cancellationFee: fee,
      updatedAt:       Date.now(),
    });

    /* Notify */
    const notifyUid = isCustomer ? booking.ownerId : booking.customerId;
    if (notifyUid) {
      await db.collection('notifications').add({
        userId: notifyUid, type: 'booking_cancelled',
        title: `Booking cancelled — ${booking.venueName}`,
        body:  `${booking.date} · ${booking.startTime}–${booking.endTime}`,
        data:  { bookingId }, priority: 'high', category: 'bookings', read: false, createdAt: Date.now(),
      });
    }

    return { cancelled: true, cancellationFee: fee };
  }
);

/* ═══════════════════════════════════════════════════════════
   8. RESCHEDULE BOOKING
═══════════════════════════════════════════════════════════ */
exports.bookingReschedule = onCall(
  { region: 'us-central1', maxInstances: 20, cors: true, enforceAppCheck: true },
  async (req) => {
    const uid = _authRequired(req);
    const { bookingId, newDate, newStartTime, newEndTime } = req.data || {};
    if (!bookingId || !newDate || !newStartTime || !newEndTime) {
      throw new HttpsError('invalid-argument','bookingId, newDate, newStartTime, newEndTime required');
    }

    const bookingRef = db.collection('bookings').doc(bookingId);
    const snap = await bookingRef.get();
    if (!snap.exists) throw new HttpsError('not-found','Booking not found');
    const booking = snap.data();

    if (booking.customerId !== uid && booking.ownerId !== uid) {
      throw new HttpsError('permission-denied','Cannot reschedule this booking');
    }
    if (!['pending','confirmed'].includes(booking.status)) {
      throw new HttpsError('failed-precondition','Booking cannot be rescheduled');
    }

    const dayStart   = new Date(newDate+'T00:00:00').getTime();
    const newStartTs = dayStart + _timeToMins(newStartTime) * 60000;
    const newEndTs   = dayStart + _timeToMins(newEndTime)   * 60000;

    /* Check availability at new time (excluding this booking) */
    const overlap = await _hasOverlap(booking.venueId, newStartTs, newEndTs, bookingId);
    if (overlap) throw new HttpsError('already-exists','New time slot is not available');

    await bookingRef.update({
      date: newDate, startTime: newStartTime, endTime: newEndTime,
      startTs: newStartTs, endTs: newEndTs,
      duration: _timeToMins(newEndTime) - _timeToMins(newStartTime),
      updatedAt: Date.now(),
    });

    return { rescheduled: true, newDate, newStartTime, newEndTime };
  }
);

/* ═══════════════════════════════════════════════════════════
   9. CHECK IN
═══════════════════════════════════════════════════════════ */
exports.bookingCheckIn = onCall(
  { region: 'us-central1', maxInstances: 30, cors: true, enforceAppCheck: true },
  async (req) => {
    const uid = _authRequired(req);
    const { bookingId, method, time } = req.data || {};
    const bookingRef = db.collection('bookings').doc(bookingId);
    const snap = await bookingRef.get();
    if (!snap.exists) throw new HttpsError('not-found','Booking not found');
    const booking = snap.data();
    if (booking.customerId !== uid && booking.ownerId !== uid) {
      throw new HttpsError('permission-denied','Not authorised');
    }
    await bookingRef.update({
      status:    'active',
      checkIn:   { time: time || Date.now(), method: method || 'manual', by: uid },
      updatedAt: Date.now(),
    });
    return { checkedIn: true };
  }
);

/* ═══════════════════════════════════════════════════════════
   10. CHECK OUT
═══════════════════════════════════════════════════════════ */
exports.bookingCheckOut = onCall(
  { region: 'us-central1', maxInstances: 30, cors: true, enforceAppCheck: true },
  async (req) => {
    const uid = _authRequired(req);
    const { bookingId, time } = req.data || {};
    const bookingRef = db.collection('bookings').doc(bookingId);
    const snap = await bookingRef.get();
    if (!snap.exists) throw new HttpsError('not-found','Booking not found');
    const booking = snap.data();
    if (booking.customerId !== uid && booking.ownerId !== uid) {
      throw new HttpsError('permission-denied','Not authorised');
    }
    await bookingRef.update({
      status:    'completed',
      checkOut:  { time: time || Date.now(), by: uid },
      updatedAt: Date.now(),
    });
    return { checkedOut: true };
  }
);

/* ═══════════════════════════════════════════════════════════
   11. GET MY BOOKINGS
═══════════════════════════════════════════════════════════ */
exports.bookingGetMyBookings = onCall(
  { region: 'us-central1', maxInstances: 50, cors: true, enforceAppCheck: true },
  async (req) => {
    const uid = _authRequired(req);
    const { status } = req.data || {};
    let query = db.collection('bookings').where('customerId','==',uid).orderBy('startTs','desc').limit(50);
    if (status) query = db.collection('bookings').where('customerId','==',uid).where('status','==',status).orderBy('startTs','desc').limit(50);
    const snap = await query.get();
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  }
);

/* ═══════════════════════════════════════════════════════════
   12. GET VENUE CALENDAR (owner view)
═══════════════════════════════════════════════════════════ */
exports.bookingGetCalendar = onCall(
  { region: 'us-central1', maxInstances: 30, cors: true, enforceAppCheck: true },
  async (req) => {
    const uid = _authRequired(req);
    const { venueId, from, until } = req.data || {};
    if (!venueId || !from || !until) throw new HttpsError('invalid-argument','venueId, from, until required');

    const venueSnap = await db.collection('venues').doc(venueId).get();
    if (!venueSnap.exists) throw new HttpsError('not-found','Venue not found');
    const venue = venueSnap.data();
    if (venue.ownerId !== uid) throw new HttpsError('permission-denied','Not the venue owner');

    const snap = await db.collection('bookings')
      .where('venueId', '==', venueId)
      .where('startTs', '>=', from)
      .where('startTs', '<=', until)
      .orderBy('startTs', 'asc')
      .get();

    const blockSnap = await db.collection('venueBlockouts')
      .where('venueId', '==', venueId)
      .get();

    const bookings  = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    const blockouts = blockSnap.docs
      .filter(d => { const b=d.data(); return b.startTs<until && b.endTs>from; })
      .map(d => ({ id: d.id, ...d.data() }));

    return { bookings, blockouts, venue: { name: venue.name, openingHours: venue.openingHours } };
  }
);

/* ═══════════════════════════════════════════════════════════
   13. BLOCK VENUE SLOTS (maintenance / closure)
═══════════════════════════════════════════════════════════ */
exports.bookingBlockSlots = onCall(
  { region: 'us-central1', maxInstances: 10, cors: true, enforceAppCheck: true },
  async (req) => {
    const uid = _authRequired(req);
    const { venueId, startTs, endTs, reason, note } = req.data || {};
    if (!venueId || !startTs || !endTs) throw new HttpsError('invalid-argument','venueId, startTs, endTs required');

    const venueSnap = await db.collection('venues').doc(venueId).get();
    if (!venueSnap.exists) throw new HttpsError('not-found','Venue not found');
    if (venueSnap.data().ownerId !== uid) throw new HttpsError('permission-denied','Not the venue owner');

    const docRef = await db.collection('venueBlockouts').add({
      venueId, startTs, endTs,
      reason:    _sanitize(reason || 'maintenance'),
      note:      _sanitize(note   || ''),
      createdBy: uid,
      createdAt: Date.now(),
    });
    return { blockoutId: docRef.id };
  }
);

/* ═══════════════════════════════════════════════════════════
   14. SAVE VENUE (create or update)
═══════════════════════════════════════════════════════════ */
exports.bookingSaveVenue = onCall(
  { region: 'us-central1', maxInstances: 10, cors: true, enforceAppCheck: true },
  async (req) => {
    const uid = _authRequired(req);
    const { id, ...data } = req.data || {};

    /* Sanitize key fields */
    const venueData = {
      name:         _sanitize(data.name       || ''),
      type:         _sanitize(data.type       || ''),
      description:  _sanitize(data.description|| ''),
      city:         _sanitize(data.city       || ''),
      area:         _sanitize(data.area       || ''),
      address:      _sanitize(data.address    || ''),
      indoor:       Boolean(data.indoor),
      amenities:    (data.amenities  || []).map(_sanitize),
      photos:       (data.photos     || []).slice(0, 20),
      openingHours: data.openingHours || {},
      capacity:     data.capacity    || {},
      pricing:      data.pricing     || {},
      config:       data.config      || {},
      status:       data.status || 'active',
      ownerId:      uid,
      updatedAt:    Date.now(),
    };

    if (!venueData.name) throw new HttpsError('invalid-argument','Venue name required');

    if (id) {
      /* Update — verify ownership */
      const snap = await db.collection('venues').doc(id).get();
      if (!snap.exists) throw new HttpsError('not-found','Venue not found');
      if (snap.data().ownerId !== uid) throw new HttpsError('permission-denied','Not the venue owner');
      await db.collection('venues').doc(id).update(venueData);
      return { venueId: id, created: false };
    } else {
      venueData.createdAt    = Date.now();
      venueData.totalBookings = 0;
      venueData.rating       = 0;
      venueData.reviewCount  = 0;
      const ref = await db.collection('venues').add(venueData);
      return { venueId: ref.id, created: true };
    }
  }
);

/* ═══════════════════════════════════════════════════════════
   15. APPROVE / REJECT (for approval-required venues)
═══════════════════════════════════════════════════════════ */
exports.bookingApprove = onCall(
  { region: 'us-central1', maxInstances: 10, cors: true, enforceAppCheck: true },
  async (req) => {
    const uid = _authRequired(req);
    const { bookingId } = req.data || {};
    const snap = await db.collection('bookings').doc(bookingId).get();
    if (!snap.exists) throw new HttpsError('not-found','Booking not found');
    const booking = snap.data();
    if (booking.ownerId !== uid) throw new HttpsError('permission-denied','Not the venue owner');
    await db.collection('bookings').doc(bookingId).update({ status:'confirmed', approvedAt: Date.now(), updatedAt: Date.now() });
    await db.collection('notifications').add({
      userId: booking.customerId, type: 'booking_approved',
      title: `Booking approved — ${booking.venueName}`,
      body:  `${booking.date} · ${booking.startTime}–${booking.endTime}`,
      data:  { bookingId }, priority: 'high', category: 'bookings', read: false, createdAt: Date.now(),
    });
    return { approved: true };
  }
);

exports.bookingReject = onCall(
  { region: 'us-central1', maxInstances: 10, cors: true, enforceAppCheck: true },
  async (req) => {
    const uid = _authRequired(req);
    const { bookingId, reason } = req.data || {};
    const snap = await db.collection('bookings').doc(bookingId).get();
    if (!snap.exists) throw new HttpsError('not-found','Booking not found');
    const booking = snap.data();
    if (booking.ownerId !== uid) throw new HttpsError('permission-denied','Not the venue owner');
    await db.collection('bookings').doc(bookingId).update({ status:'cancelled', rejectedAt: Date.now(), rejectionReason: _sanitize(reason||''), updatedAt: Date.now() });
    await db.collection('notifications').add({
      userId: booking.customerId, type: 'booking_rejected',
      title: `Booking declined — ${booking.venueName}`,
      body:  _sanitize(reason || 'Your booking was declined by the venue.'),
      data:  { bookingId }, priority: 'high', category: 'bookings', read: false, createdAt: Date.now(),
    });
    return { rejected: true };
  }
);

/* ═══════════════════════════════════════════════════════════
   16. SCHEDULED — Send Booking Reminders (every 30 minutes)
═══════════════════════════════════════════════════════════ */
exports.bookingSendReminders = functions.scheduler.onSchedule(
  { schedule: 'every 30 minutes', timeZone: 'Africa/Nairobi', region: 'us-central1' },
  async () => {
    const now    = Date.now();
    const window = 35 * 60 * 1000; // 35-min lookahead

    const snap = await db.collection('bookings')
      .where('status', 'in', ['confirmed'])
      .where('startTs', '>', now)
      .where('startTs', '<', now + 26 * 3600000)
      .get();

    const batch = db.batch();
    for (const doc of snap.docs) {
      const b = doc.data();
      const reminders = b.reminders || [];
      let changed = false;
      for (let i = 0; i < reminders.length; i++) {
        const r = reminders[i];
        if (r.sent) continue;
        const fireAt = b.startTs - r.minutesBefore * 60000;
        if (fireAt <= now + window && fireAt > now - window) {
          /* Create notification */
          batch.set(db.collection('notifications').doc(), {
            userId: b.customerId, type: 'booking_reminder',
            title:  `Reminder: ${b.venueName} in ${r.minutesBefore >= 60 ? Math.round(r.minutesBefore/60)+'h' : r.minutesBefore+'min'}`,
            body:   `${b.date} · ${b.startTime}–${b.endTime}`,
            data:   { bookingId: doc.id, venueId: b.venueId },
            priority: 'normal', category: 'bookings', read: false, createdAt: now,
          });
          reminders[i] = { ...r, sent: true };
          changed = true;
        }
      }
      if (changed) batch.update(doc.ref, { reminders, updatedAt: now });
    }
    await batch.commit();
    return null;
  }
);

/* ═══════════════════════════════════════════════════════════
   17. SCHEDULED — Clean Up Expired Holds (every 5 minutes)
═══════════════════════════════════════════════════════════ */
exports.bookingCleanupHolds = functions.scheduler.onSchedule(
  { schedule: 'every 5 minutes', timeZone: 'Africa/Nairobi', region: 'us-central1' },
  async () => {
    const snap = await db.collection('bookingHolds').where('expiresAt', '<', Date.now()).get();
    const batch = db.batch();
    snap.docs.forEach(d => batch.delete(d.ref));
    if (!snap.empty) await batch.commit();
    return null;
  }
);

/* ═══════════════════════════════════════════════════════════
   18. SCHEDULED — Auto-complete past bookings (daily)
═══════════════════════════════════════════════════════════ */
exports.bookingAutoComplete = functions.scheduler.onSchedule(
  { schedule: '0 1 * * *', timeZone: 'Africa/Nairobi', region: 'us-central1' },
  async () => {
    const yesterday = Date.now() - 86400000;
    const snap = await db.collection('bookings')
      .where('status',  'in', ['confirmed','active'])
      .where('endTs',   '<',  yesterday)
      .get();
    const batch = db.batch();
    snap.docs.forEach(d => batch.update(d.ref, { status: 'completed', autoCompletedAt: Date.now() }));
    if (!snap.empty) await batch.commit();
    return null;
  }
);
