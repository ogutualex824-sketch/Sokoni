/* ================================================================
   SOKONI Universal Venue & Resource Booking Engine v1.0
   Client-side SDK — slot generation, pricing, holds, booking state
   Works offline for browsing; server CFs authoritative for writes
================================================================ */
window.SokoniBooking = (() => {
  'use strict';

  /* ── Constants ── */
  const HOLD_DURATION_MS  = 2 * 60 * 1000;   // 2-minute slot hold
  const SLOT_STEP_MINS    = 30;               // granularity for hourly slots
  const HALF_DAY_MINS     = 4 * 60;
  const FULL_DAY_MINS     = 8 * 60;
  const CF_BASE           = typeof sokoniConfig !== 'undefined' && sokoniConfig.functionsBase
    ? sokoniConfig.functionsBase : 'https://us-central1-sokoni-aeb26.cloudfunctions.net';

  /* ── Helpers ── */
  const _e   = s  => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const KES  = n  => 'KES ' + Number(n||0).toFixed(2);
  const pad2 = n  => String(n).padStart(2,'0');

  function _timeToMins(t) { /* "HH:MM" → minutes from midnight */
    const [h, m] = String(t||'00:00').split(':').map(Number);
    return h * 60 + (m || 0);
  }
  function _minsToTime(m) { return pad2(Math.floor(m/60)) + ':' + pad2(m % 60); }
  function _dayKey(ts)    { return new Date(ts).toISOString().slice(0, 10); }
  function _dayOfWeek(dateStr) {
    const days = ['sun','mon','tue','wed','thu','fri','sat'];
    return days[new Date(dateStr).getDay()];
  }
  function _nowMins() { const n = new Date(); return n.getHours()*60 + n.getMinutes(); }
  function _uid()     { return Date.now().toString(36) + Math.random().toString(36).slice(2,8); }

  /* ── Firebase callable wrapper — routes all ops through bookingDispatch ── */
  let _dispatchFn = null;
  function _call(name, data) {
    if (typeof firebase === 'undefined' || !firebase.functions) {
      return Promise.reject(new Error('Firebase SDK not loaded'));
    }
    if (!_dispatchFn) _dispatchFn = firebase.functions().httpsCallable('bookingDispatch');
    return _dispatchFn(Object.assign({}, data || {}, { op: name })).then(r => r.data);
  }

  /* ═══════════════════════════════════════════════════════
     PRICING ENGINE
     All computation is deterministic — same result on client
     and server. Server re-validates before charging.
  ═══════════════════════════════════════════════════════ */
  function calculatePrice(venue, startMins, endMins, dateStr, opts = {}) {
    const pricing  = venue.pricing || {};
    const duration = endMins - startMins; // minutes
    if (duration <= 0) return { base: 0, surcharge: 0, discount: 0, addOns: 0, deposit: pricing.deposit || 0, total: 0, breakdown: [] };

    const breakdown = [];
    let base = 0;

    /* ── Base rate by duration ── */
    if (duration >= FULL_DAY_MINS && pricing.fullDay) {
      const days = Math.ceil(duration / FULL_DAY_MINS);
      base = pricing.fullDay * days;
      breakdown.push({ label: `Full day ×${days}`, amount: base });
    } else if (duration >= HALF_DAY_MINS && pricing.halfDay) {
      base = pricing.halfDay;
      breakdown.push({ label: 'Half day', amount: base });
    } else {
      const hours = duration / 60;
      const rate  = pricing.hourly || 0;
      base = rate * hours;
      breakdown.push({ label: `${hours.toFixed(1)}h × ${KES(rate)}/h`, amount: base });
    }

    /* ── Weekend surcharge ── */
    const dow = _dayOfWeek(dateStr);
    let surcharge = 0;
    if ((dow === 'sat' || dow === 'sun') && pricing.weekend) {
      surcharge = pricing.weekend;
      breakdown.push({ label: 'Weekend rate', amount: surcharge });
    }

    /* ── Peak hour surcharge ── */
    const peakSlots = pricing.peak?.hours || [];
    let peakMins = 0;
    for (const [ps, pe] of peakSlots) {
      const psM = ps * 60, peM = pe * 60;
      const overlap = Math.max(0, Math.min(endMins, peM) - Math.max(startMins, psM));
      peakMins += overlap;
    }
    if (peakMins > 0 && pricing.peak?.rate) {
      const pkSurcharge = (pricing.peak.rate - (pricing.hourly || 0)) * (peakMins / 60);
      surcharge += pkSurcharge;
      breakdown.push({ label: `Peak hours (${peakMins}min)`, amount: pkSurcharge });
    }

    /* ── Holiday surcharge ── */
    if (opts.isHoliday && pricing.holiday) {
      const holSurcharge = pricing.holiday;
      surcharge += holSurcharge;
      breakdown.push({ label: 'Holiday rate', amount: holSurcharge });
    }

    /* ── Member discount ── */
    let discount = 0;
    if (opts.isMember && pricing.member?.discount) {
      discount = (base + surcharge) * pricing.member.discount;
      breakdown.push({ label: `Member discount (${(pricing.member.discount*100).toFixed(0)}%)`, amount: -discount });
    }

    /* ── Promo discount ── */
    if (opts.promoDiscount) {
      const promoAmt = (base + surcharge) * opts.promoDiscount;
      discount += promoAmt;
      breakdown.push({ label: `Promo (${(opts.promoDiscount*100).toFixed(0)}%)`, amount: -promoAmt });
    }

    /* ── Add-ons ── */
    const addOnTotal = (opts.addOns || []).reduce((t, a) => {
      breakdown.push({ label: a.name, amount: a.price });
      return t + (a.price || 0);
    }, 0);

    const subtotal = base + surcharge - discount + addOnTotal;
    const deposit  = pricing.deposit || 0;

    return {
      base, surcharge, discount, addOns: addOnTotal,
      subtotal, deposit,
      total:     subtotal + deposit,
      breakdown,
      currency: 'KES',
      duration,
    };
  }

  /* ═══════════════════════════════════════════════════════
     SLOT GENERATION
     Produces candidate slots for a given venue + date.
     Server re-validates before confirming any booking.
  ═══════════════════════════════════════════════════════ */
  function generateSlots(venue, dateStr, existingBookings = [], holds = []) {
    const dow     = _dayOfWeek(dateStr);
    const hours   = (venue.openingHours || {})[dow];
    if (!hours || hours.closed) return [];

    const openM   = _timeToMins(hours.open  || '08:00');
    const closeM  = _timeToMins(hours.close || '22:00');
    const buffer  = (venue.config?.cleaningBuffer || 0); // minutes between bookings
    const step    = SLOT_STEP_MINS;

    /* Build blocked ranges from existing bookings + holds */
    const blocked = [];
    const isToday = dateStr === _dayKey(Date.now());

    for (const b of [...existingBookings, ...holds]) {
      const s = _timeToMins(b.startTime);
      const e = _timeToMins(b.endTime) + buffer;
      blocked.push([s, e]);
    }

    /* Generate slots */
    const slots = [];
    for (let s = openM; s + step <= closeM; s += step) {
      const e = s + step;
      /* Skip past slots */
      if (isToday && s <= _nowMins() + 15) continue;
      /* Check overlap */
      const overlap = blocked.some(([bs, be]) => s < be && e > bs);
      if (!overlap) {
        slots.push({
          id:        `${dateStr}_${_minsToTime(s)}`,
          date:      dateStr,
          startTime: _minsToTime(s),
          endTime:   _minsToTime(e),
          startMins: s,
          endMins:   e,
          duration:  step,
          available: true,
        });
      }
    }
    return slots;
  }

  /* ── Contiguous slot groups (for multi-hour booking UI) ── */
  function getBookableRanges(slots, minDuration = 30, maxDuration = 12 * 60) {
    if (!slots.length) return [];
    const ranges = [];
    let i = 0;
    while (i < slots.length) {
      let j = i;
      /* Extend while slots are contiguous */
      while (j + 1 < slots.length && slots[j + 1].startMins === slots[j].endMins) j++;
      const totalMins = slots[j].endMins - slots[i].startMins;
      if (totalMins >= minDuration) {
        ranges.push({
          startTime: slots[i].startTime,
          endTime:   slots[j].endTime,
          startMins: slots[i].startMins,
          endMins:   slots[j].endMins,
          slots:     slots.slice(i, j + 1),
        });
      }
      i = j + 1;
    }
    return ranges;
  }

  /* ═══════════════════════════════════════════════════════
     LIVE STATUS
  ═══════════════════════════════════════════════════════ */
  function getVenueStatus(venue, dateStr) {
    const dow   = _dayOfWeek(dateStr);
    const hours = (venue.openingHours || {})[dow];
    if (!hours || hours.closed) return { status: 'closed', label: 'Closed Today', color: 'muted' };
    if (venue.status === 'maintenance') return { status: 'maintenance', label: 'Under Maintenance', color: 'yellow' };
    const now   = _nowMins();
    const openM = _timeToMins(hours.open);
    const cls   = _timeToMins(hours.close);
    if (now < openM - 30)  return { status: 'opens_soon', label: `Opens at ${hours.open}`, color: 'blue' };
    if (now < openM)       return { status: 'opens_soon', label: `Opens Soon`, color: 'blue' };
    if (now > cls)         return { status: 'closed', label: 'Closed Now', color: 'muted' };
    if (now > cls - 30)    return { status: 'closing_soon', label: `Closes at ${hours.close}`, color: 'yellow' };
    return { status: 'open', label: 'Available Now', color: 'green' };
  }

  /* ═══════════════════════════════════════════════════════
     CANCELLATION FEE
  ═══════════════════════════════════════════════════════ */
  function calculateCancellationFee(booking) {
    const pricing   = booking.pricingBreakdown || {};
    const windowH   = booking.cancellationWindowHours || 24;
    const feeRate   = booking.cancellationFeeRate || 0;
    const hoursLeft = (booking.startTs - Date.now()) / 3600000;
    if (hoursLeft > windowH) return 0;
    return (pricing.total || 0) * feeRate;
  }

  /* ═══════════════════════════════════════════════════════
     PUBLIC API — wraps Cloud Functions
  ═══════════════════════════════════════════════════════ */

  async function searchVenues(params) {
    return _call('bookingSearchVenues', params);
  }

  async function getVenue(venueId) {
    return _call('bookingGetVenue', { venueId });
  }

  async function getAvailability(venueId, dateStr) {
    return _call('bookingGetAvailability', { venueId, date: dateStr });
  }

  async function holdSlot(venueId, startTs, endTs) {
    const holdId = _uid();
    const result = await _call('bookingHoldSlot', { venueId, startTs, endTs, holdId });
    /* Store hold locally so UI can countdown */
    if (result.held) {
      _state.currentHold = { holdId, venueId, startTs, endTs, expiresAt: Date.now() + HOLD_DURATION_MS };
      _state.holdTimer = setTimeout(() => { _state.currentHold = null; _emit('hold:expired', {}); }, HOLD_DURATION_MS);
    }
    return result;
  }

  async function releaseHold(holdId) {
    clearTimeout(_state.holdTimer);
    _state.currentHold = null;
    return _call('bookingReleaseHold', { holdId });
  }

  async function createBooking(params) {
    /* params: { venueId, holdId, date, startTime, endTime, duration, addOns, notes, paymentId } */
    const idempotencyKey = params.idempotencyKey || _uid();
    return _call('bookingCreate', { ...params, idempotencyKey });
  }

  async function cancelBooking(bookingId, reason) {
    return _call('bookingCancel', { bookingId, reason });
  }

  async function rescheduleBooking(bookingId, newDate, newStartTime, newEndTime) {
    return _call('bookingReschedule', { bookingId, newDate, newStartTime, newEndTime });
  }

  async function checkIn(bookingId, method = 'manual') {
    return _call('bookingCheckIn', { bookingId, method, time: Date.now() });
  }

  async function checkOut(bookingId) {
    return _call('bookingCheckOut', { bookingId, time: Date.now() });
  }

  async function getMyBookings(status) {
    return _call('bookingGetMyBookings', { status });
  }

  async function getVenueCalendar(venueId, from, until) {
    return _call('bookingGetCalendar', { venueId, from, until });
  }

  async function blockVenueSlots(venueId, startTs, endTs, reason, note) {
    return _call('bookingBlockSlots', { venueId, startTs, endTs, reason, note });
  }

  async function saveVenue(venueData) {
    return _call('bookingSaveVenue', venueData);
  }

  async function approveBooking(bookingId) {
    return _call('bookingApprove', { bookingId });
  }

  async function rejectBooking(bookingId, reason) {
    return _call('bookingReject', { bookingId, reason });
  }

  /* ═══════════════════════════════════════════════════════
     EVENT BUS
  ═══════════════════════════════════════════════════════ */
  const _listeners = {};
  const _state     = { currentHold: null, holdTimer: null };

  function on(event, fn)  { (_listeners[event] = _listeners[event] || []).push(fn); }
  function off(event, fn) { if (_listeners[event]) _listeners[event] = _listeners[event].filter(f => f !== fn); }
  function _emit(event, data) { (_listeners[event] || []).forEach(fn => { try { fn(data); } catch(e) {} }); }

  /* ═══════════════════════════════════════════════════════
     BOOKING TYPE LABELS
  ═══════════════════════════════════════════════════════ */
  const BOOKING_TYPES = [
    { id: 'hourly',     label: 'Hourly',           minMins: 30,        maxMins: 12 * 60 },
    { id: 'half_day',   label: 'Half Day (4h)',     minMins: 4 * 60,    maxMins: 4 * 60  },
    { id: 'full_day',   label: 'Full Day (8h)',     minMins: 8 * 60,    maxMins: 8 * 60  },
    { id: 'multi_day',  label: 'Multi-Day',         minMins: 24 * 60,   maxMins: null    },
    { id: 'weekly',     label: 'Weekly Recurring',  minMins: 8 * 60,    maxMins: null    },
    { id: 'monthly',    label: 'Monthly Recurring', minMins: 8 * 60,    maxMins: null    },
    { id: 'exclusive',  label: 'Exclusive Hire',    minMins: 8 * 60,    maxMins: null    },
  ];

  const RESOURCE_TYPES = [
    'Football Ground', 'Basketball Court', 'Tennis Court', 'Swimming Pool',
    'Gym', 'Indoor Arena', 'Event Venue', 'Conference Hall', 'Meeting Room',
    'Wedding Venue', 'Studio', 'Co-working Space', 'Training Center',
    'Classroom', 'Photography Location', 'Performance Stage', 'Community Hall',
    'Equipment Rental', 'Squash Court', 'Cricket Ground', 'Rugby Pitch',
    'Athletics Track', 'Rooftop Space', 'Outdoor Terrace', 'Boardroom',
    'Auditorium', 'Exhibition Space', 'Workshop', 'Dance Studio', 'Yoga Studio',
  ];

  const STATUS_CONFIG = {
    pending:    { label: 'Pending',     color: 'yellow', icon: '⏳' },
    confirmed:  { label: 'Confirmed',   color: 'green',  icon: '✅' },
    active:     { label: 'Active',      color: 'blue',   icon: '🔵' },
    completed:  { label: 'Completed',   color: 'gray',   icon: '✔️' },
    cancelled:  { label: 'Cancelled',   color: 'red',    icon: '❌' },
    no_show:    { label: 'No Show',     color: 'red',    icon: '🚫' },
  };

  return {
    /* Pricing & slot helpers */
    calculatePrice, generateSlots, getBookableRanges, getVenueStatus,
    calculateCancellationFee,
    /* CF wrappers */
    searchVenues, getVenue, getAvailability,
    holdSlot, releaseHold,
    createBooking, cancelBooking, rescheduleBooking,
    checkIn, checkOut, getMyBookings,
    getVenueCalendar, blockVenueSlots, saveVenue,
    approveBooking, rejectBooking,
    /* Event bus */
    on, off,
    /* Constants */
    BOOKING_TYPES, RESOURCE_TYPES, STATUS_CONFIG,
    /* Helpers */
    KES, _e, _timeToMins, _minsToTime, _dayKey, _dayOfWeek,
  };
})();
