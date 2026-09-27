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
const { bookingEvent, TYPES } = require('./booking-events');

const _uid = (req) => { const u = req.auth && req.auth.uid; if (!u) throw new HttpsError('unauthenticated', 'Sign in required.'); return u; };
const _ts  = () => admin.firestore.FieldValue.serverTimestamp();
const _san = (s, n = 300) => String(s == null ? '' : s).replace(/[<>]/g, '').slice(0, n);
const _mins = (t) => { const p = String(t || '0:0').split(':'); return (Number(p[0]) || 0) * 60 + (Number(p[1]) || 0); };
const _minsToTime = (m) => String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
const DOW = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/* Provenance versions — bump when the create semantics or the price source change.
   Stamped on every booking so records stay reproducible without migration. */
const ENGINE_VERSION  = '1.0.0';   /* this create engine */
const PRICING_VERSION = '2.0.0';   /* v2.0: advanced rate cards — server computes the authoritative total via
                                      service-pricing.computePrice (packages/surcharges/travel/extra-hours/add-ons/
                                      deposit) and persists a pricingSnapshot. Back-compat: services without a
                                      `pricing` config still price at svc.price (v1.1 behavior). */

/* Pre-payment slot-hold window. On create the booking is `pending` + slot-locked and
   stamped with `expiresAt = now + HOLD_MS` so the customer can pay. If they don't, the
   hold is released — proactively by bookingReleaseHold (customer abandons/fails payment)
   or by the expiry sweep once `expiresAt` passes (booking-payment-sweep.js). This is the
   held→paid_held→confirmed lifecycle: a slot is never booked until payment lands. */
const HOLD_MS = 5 * 60 * 1000;

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
  /* Same pure default the availability authority applies to an approved provider that has not set
     hours yet (availability.withDefaults) — the view and this gate must agree. */
  const cfg  = require('./availability').withDefaults(cfgSnap.data() || {});
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
  /* Commercial inputs are IDS and a CODE — never an amount (ent-rate-cards.js decides). */
  const rateCardId = d.rateCardId ? _san(d.rateCardId, 128) : null;
  const quoteId    = d.quoteId ? _san(d.quoteId, 128) : null;
  const couponCode = d.couponCode ? _san(d.couponCode, 32) : null;
  const expectedTotalCents = d.expectedTotalCents != null && Number.isFinite(Number(d.expectedTotalCents)) ? Math.round(Number(d.expectedTotalCents)) : null;
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
  /* The ONE availability authority (functions/ent-availability.js) decides bookability too: an
     Entertainment provider whose category requires verification needs a decided application;
     a suspended provider takes no public bookings. */
  const AV = require('./ent-availability');
  const cal = await AV.loadCalendar({ providerId });
  if (!cal.bookable.ok) throw new HttpsError('failed-precondition', 'This provider isn’t currently available for bookings.', { code: 'NOT_BOOKABLE' });

  /* ── Server-authoritative service lookup: price + duration come from the rate
     card, NEVER the client (the client cannot manipulate the amount). ── */
  const svcSnap = await db.collection('providerServices').doc(serviceId).get();
  if (!svcSnap.exists) throw new HttpsError('not-found', 'Service not found.');
  const svc = svcSnap.data();
  if (svc.providerId !== providerId) throw new HttpsError('failed-precondition', 'Service does not belong to this provider.');
  if (svc.active === false || svc.removedAt) throw new HttpsError('failed-precondition', 'This service is not available.');
  const serviceName = _san(svc.name, 200);
  const fee         = Math.max(0, Math.round(Number(svc.fee) || 0));     /* cents — declared per-service fee (D3) */

  /* ── Canonical pricing (Slice B): the SERVER computes the authoritative total from the
     provider's rate card + the customer's SELECTION (packageId / add-ons / duration). The client
     never sends an amount. Back-compat: a service with no `pricing` config prices at svc.price
     exactly as before. The computed breakdown is snapshotted on the booking so a later rate-card
     edit never changes an existing booking (payment/settlement/commission/refund read the snapshot). */
  const selection = {
    packageId: _san(d.packageId, 128) || null,
    addOns: Array.isArray(d.addOns) ? d.addOns.slice(0, 30).map(function (a) {
      return { id: _san((a && a.id) || a, 128), qty: Math.max(1, Math.min(Number(a && a.qty) || 1, 99)) };
    }) : [],
    durationMins: d.durationMins != null ? Math.max(0, Math.round(Number(d.durationMins) || 0)) : undefined,
  };
  let durationMins, price, deposit, pricingSnapshot = null;
  if (svc.pricing && typeof svc.pricing === 'object') {
    const br = require('./service-pricing').computePrice(svc.pricing, selection, {
      date: date, startTime: startTime, durationMins: selection.durationMins, distanceKm: Number(d.distanceKm) || 0,
    });
    price       = Math.max(0, Math.round(Number(br.totalCents) || 0));
    deposit     = Math.max(0, Math.round(Number(br.depositCents) || 0));
    durationMins = Math.max(15, Number(br.durationMins) || Number(svc.durationMins) || 30);
    const _pkg  = br.breakdown.filter(function (x) { return x.type === 'package'; })[0];
    pricingSnapshot = {
      pricingVersion: PRICING_VERSION, currency: br.currency,
      packageId: br.packageId || null, packageName: (_pkg && _pkg.label) || null,
      baseCents: br.baseCents, surchargeCents: br.surchargeCents, extraHoursCents: br.extraHoursCents,
      travelCents: br.travelCents, addOnsCents: br.addOnsCents, subtotalCents: br.subtotalCents,
      totalCents: br.totalCents, depositCents: br.depositCents, depositMode: br.depositMode,
      balanceDue: br.balanceDue, addOns: br.addOns, breakdown: br.breakdown,
    };
  } else {
    durationMins = Math.max(15, Number(svc.durationMins) || 30);
    price        = Math.max(0, Math.round(Number(svc.price) || 0));   /* legacy — unchanged behavior */
    deposit      = Math.max(0, Math.round(Number(svc.deposit) || 0));
  }

  /* Rate card / custom quote (ent-rate-cards.js): a versioned price or an accepted quote replaces the
     base price, and the booking records which version priced it — never re-priced later. */
  const RCARDS = require('./ent-rate-cards');
  const terms = await RCARDS.resolveTerms({ calKey: cal.calKey, ownerUid: providerId, serviceId, buyerUid: customerUid, rateCardId, quoteId,
    base: { priceCents: price, durationMins, authority: 'rate-card@' + PRICING_VERSION } });
  if (terms.rateCard || terms.quote) {
    price = Math.max(0, Math.round(Number(terms.priceCents) || 0));
    if (terms.durationMins) durationMins = Math.max(15, Number(terms.durationMins));
    deposit = terms.depositCents != null ? Math.min(price, terms.depositCents) : Math.min(price, deposit);
    pricingSnapshot = { pricingVersion: terms.pricingAuthority, currency: 'KES', totalCents: price, depositCents: deposit,
      rateCardId: terms.rateCard ? terms.rateCard.id : null, rateCardVersion: terms.rateCard ? terms.rateCard.version : null, quoteId: terms.quote ? terms.quote.id : null };
    if (terms.quote && terms.quote.date && (terms.quote.date !== date || (terms.quote.startTime && terms.quote.startTime !== startTime))) {
      throw new HttpsError('failed-precondition', 'This quote is for ' + terms.quote.date + (terms.quote.startTime ? ' at ' + terms.quote.startTime : '') + '.');
    }
  }
  const coupon = couponCode ? await RCARDS.findCoupon(providerId, couponCode) : null;
  if (couponCode && !coupon) throw new HttpsError('not-found', 'That discount code is not valid here.');

  /* Validate the slot through the shared availability gate (same path reschedule uses). */
  const slot = await _prepareSlot(db, { providerId, date, startTime, durationMins });
  const { endTime, startTs, endTs, slotKey, cfg, appt, bufMs, cfgRef } = slot;
  const maxPerCustomer = Number(appt.maxPerCustomer || 0);

  const userSnap = await db.collection('users').doc(customerUid).get();
  const customerName = _san((userSnap.data() || {}).name || (userSnap.data() || {}).displayName || '', 200);

  const bookingId   = `${providerId}_${slotKey}`;   /* deterministic → natural lock + idempotency */
  /* Occupancy through the ONE availability authority: claimed INSIDE the transaction below, so
     any overlapping window (not only the identical one the slot lock covers) is refused. */
  const svcForPlan = Object.assign({ id: serviceId }, svc, { availability: Object.assign({}, svc.availability || {}, terms.availability || {}, { durationMins }) });
  const plan = await AV.planReservation({ cal, service: svcForPlan, startMs: startTs, endMs: endTs, itemId: 'pb_' + bookingId, ref: 'providerBookings/' + bookingId });
  const quoteRef = terms.quote ? db.collection('entQuotes').doc(terms.quote.id) : null;
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

  const holdExpiresMs = Date.now() + HOLD_MS;   /* server clock; stamped on booking + lock so the hold self-expires */

  /* ── Commercial hub, resolved SERVER-SIDE and snapshotted (ADR-015) ──────────────────
     Which hub a booking is priced under is a money input, so it is treated like price/fee/
     deposit: resolved from an authority the customer and the provider cannot set, stamped
     once here, and read unchanged at settlement. See functions/provider-hub.js for why it
     comes from the provider's DECIDED application role rather than the self-declared
     `providers/{uid}.category`, and why it is NOT the client-supplied `hubType` below. */
  const _cls = await require('./provider-hub').resolveProviderClassification(db, providerId);
  const commissionHub = _cls.hub;
  /* Entertainment class (ARTIST / SERVICE), resolved and stamped the same way — the booking identity
     (entertainment-bookings.js) reads it; null for every non-Entertainment provider. */
  const entClass = _cls.entClass;

  let outcome = null;
  await db.runTransaction(async (txn) => {
    outcome = null;
    if (idemRef) { const i = await txn.get(idemRef); if (i.exists) { outcome = { bookingId: i.data().bookingId, idempotent: true }; return; } }
    const lock = await txn.get(slotLockRef);
    const held = await txn.get(bookingRef);
    const cSnap = coupon ? await txn.get(coupon.ref) : null;
    const qSnap = quoteRef ? await txn.get(quoteRef) : null;
    const qPrevRef = qSnap && qSnap.exists && qSnap.data().activeBookingId && qSnap.data().activeBookingId !== bookingId ? db.collection('providerBookings').doc(qSnap.data().activeBookingId) : null;
    const qPrev = qPrevRef ? await txn.get(qPrevRef) : null;
    const avState = await AV.readPlan(txn, plan);
    if (lock.exists) {
      /* The slot is held. If it is THIS customer's own still-unpaid hold, let them
         RESUME payment (refresh the 5-min window) instead of seeing "just taken" — the
         common case of returning to a payment sheet they closed. Deterministic booking id
         means the lock points at `bookingRef`. Anyone else's hold = a real conflict. */
      let heldBy = 'unknown';
      if (held.exists) {
        const hb = held.data();
        if (hb.customerUid === customerUid && hb.status === 'pending' && (hb.paymentStatus || 'pending') === 'pending') {
          txn.update(bookingRef, { expiresAt: admin.firestore.Timestamp.fromMillis(holdExpiresMs), updatedAt: _ts() });
          const rev = bookingEvent({
            bookingId, type: TYPES.RESUMED, actor: 'customer', providerId, customerUid,
            previousStatus: 'pending', newStatus: 'pending', data: { expiresAt: holdExpiresMs },
          });
          txn.set(rev.ref, rev.payload);
          outcome = { bookingId, status: 'pending', resumed: true, expiresAt: holdExpiresMs };
          return;
        }
        /* Classify WHY it's taken so the caller can give an accurate reason, not a
           generic "just taken": someone else PAID (paid_held/settled/confirmed) vs
           someone else is still COMPLETING an unpaid hold (may free up shortly). */
        heldBy = (hb.paymentStatus === 'paid_held' || hb.paymentStatus === 'settled' || hb.status === 'confirmed')
          ? 'paid' : 'pending';
      }
      outcome = { conflict: 'already-exists', heldBy };
      return;
    }
    /* Daily total cap (all bookings that day). */
    const maxPerDay = Number(cfg.cap && cfg.cap.maxPerDay || 0);
    if (maxPerDay > 0 && existing.length >= maxPerDay) { outcome = { conflict: 'resource-exhausted' }; return; }
    /* Per-customer cap. */
    if (rc.customerCapExceeded(custActive, maxPerCustomer)) { outcome = { conflict: 'failed-precondition' }; return; }
    /* Concurrent capacity = how many buffered bookings may OVERLAP this window.
       Defaults to 1 (no double-book); >1 = a shared resource (e.g. a class). This
       counts only OVERLAPPING bookings, not the whole day — the correct semantic. */
    const maxConcurrent = Math.max(1, Number(cfg.cap && cfg.cap.maxSimultaneous || 1));
    /* ONE buffer rule — the availability core's (shared/ent-availability-core.js, the atomic claim above is the
       authority): an appointment may not overlap another appointment's BUFFER, but two buffers may overlap each
       other. `rc.pairOverlaps(…, bufMs, bufMs)` padded BOTH windows, doubling the gap, so a slot the public
       calendar showed AVAILABLE was refused here (CHANGELOG 234). With equal buffers either side, "the new
       appointment overlaps the existing one's buffered window" is exactly the core's test. */
    const overlapCount = existing.filter(b => startTs < Number(b.endTs) + bufMs && endTs > Number(b.startTs) - bufMs).length;
    if (overlapCount >= maxConcurrent) { outcome = { conflict: 'already-exists' }; return; }
    /* Quote still usable (not withdrawn, not already booked by a live booking). */
    if (quoteRef) {
      const q = qSnap && qSnap.exists ? qSnap.data() : null;
      if (!q || q.status !== 'ACCEPTED') { outcome = { conflict: 'quote' }; return; }
      if (qPrev && qPrev.exists && !['cancelled', 'declined', 'no_show'].includes(qPrev.data().status)) { outcome = { conflict: 'quote' }; return; }
    }
    /* Discount (Marketing authority) — decided and counted inside the transaction. */
    let discountCents = 0;
    if (coupon) {
      const cd = RCARDS.couponDiscount(cSnap && cSnap.exists ? cSnap.data() : null, { priceCents: price, serviceId, nowMs: Date.now() });
      if (!cd.ok) { outcome = { conflict: 'coupon', reason: cd.reason }; return; }
      discountCents = cd.discountCents;
    }
    const finalPrice = price - discountCents;
    const finalDeposit = Math.min(finalPrice, deposit);
    /* The buyer confirmed a total; if the authoritative total moved, nothing is reserved or charged. */
    if (expectedTotalCents != null && expectedTotalCents !== finalPrice + fee) { outcome = { conflict: 'price', totalCents: finalPrice + fee }; return; }
    /* Atomic reservation through the availability authority. */
    const claimed = AV.claim(txn, plan, avState, { kind: (finalPrice + fee) > 0 ? 'H' : 'B', until: holdExpiresMs });
    if (!claimed.ok) { outcome = { conflict: 'avail', code: claimed.code }; return; }

    /* Provider approves by default (status:pending); auto-confirm only if configured.
       Commission/settlement fields are DELIBERATELY absent — set at completion. */
    const status = appt.autoConfirm === true ? 'confirmed' : 'pending';
    txn.set(bookingRef, {
      providerId, customerUid, customerName,
      serviceId, service: serviceName,
      date, startTime, endTime, startTs, endTs, durationMins, slotKey,
      scheduledAt: admin.firestore.Timestamp.fromMillis(startTs),
      price: finalPrice, fee, deposit: finalDeposit, currency: 'KES',   /* all cents; server-authoritative. `price` is THE total —
                                                 payment/held/settlement/commission/refund consume it (or the
                                                 snapshot) and NEVER recompute. */
      ...(pricingSnapshot ? { pricingSnapshot } : {}),   /* immutable price breakdown → rate-card edits can't change this booking */
      listPriceCents: price, discountCents, couponId: coupon ? coupon.id : null,
      rateCardId: terms.rateCard ? terms.rateCard.id : null, rateCardVersion: terms.rateCard ? terms.rateCard.version : null,
      quoteId: terms.quote ? terms.quote.id : null, enquiryId: (qSnap && qSnap.exists && qSnap.data().enquiryId) || null,
      pricingAuthority: terms.pricingAuthority,
      availability: claimed.record,                 /* the authority's item — every later transition releases / moves it */
      paymentStatus: 'pending',
      status,                        /* server-authoritative */
      expiresAt: admin.firestore.Timestamp.fromMillis(holdExpiresMs),   /* pre-payment hold window; cleared on paid_held */
      note: _san(d.note, 300),
      hubType: _san(d.hubType, 40) || 'services',   /* CLIENT-SUPPLIED, descriptive only — never price on this */
      commissionHub,                                /* SERVER-RESOLVED, immutable — the settlement rate selector */
      entClass: entClass || null,                   /* SERVER-RESOLVED, immutable — ARTIST / SERVICE / null */
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
    txn.set(slotLockRef, { bookingId, providerId, customerUid, date, startTime, endTime, startTs, endTs, createdAt: _ts(), expiresAt: admin.firestore.Timestamp.fromMillis(holdExpiresMs) });
    if (idemRef) txn.set(idemRef, { bookingId, providerId, customerUid, createdAt: _ts() });
    if (coupon) {
      txn.update(coupon.ref, { usedCount: admin.firestore.FieldValue.increment(1) });
      txn.create(db.collection('mktCouponRedemptions').doc(`${coupon.id}_${bookingId}`), { couponId: coupon.id, bookingId, uid: customerUid, discountCents, createdAt: _ts() });
    }
    if (quoteRef) txn.update(quoteRef, { activeBookingId: bookingId, updatedAt: _ts() });
    const hev = bookingEvent({
      bookingId, type: TYPES.HELD, actor: 'customer', providerId, customerUid,
      previousStatus: null, newStatus: status, data: { expiresAt: holdExpiresMs, priceCents: finalPrice, serviceId },
      key: 'held',
    });
    txn.set(hev.ref, hev.payload);
    outcome = { bookingId, status, expiresAt: holdExpiresMs, totalCents: finalPrice + fee };
  });

  if (outcome && outcome.idempotent) return { success: true, bookingId: outcome.bookingId, idempotent: true };
  /* Owner resumed their own live hold — not a new booking; skip notify/convergence. */
  if (outcome && outcome.resumed) return { success: true, bookingId: outcome.bookingId, status: 'pending', resumed: true, expiresAt: outcome.expiresAt };
  if (outcome && outcome.conflict === 'already-exists') {
    /* Accurate, lifecycle-specific reason instead of a blanket "just taken". */
    const msg = outcome.heldBy === 'paid'
      ? 'Someone else just booked and paid for this time. Please choose another slot.'
      : outcome.heldBy === 'pending'
        ? 'Another customer is completing payment for this time. It may free up in a few minutes — or pick another slot.'
        : 'That time overlaps another booking. Please choose another slot.';   /* overlap/unknown */
    throw new HttpsError('already-exists', msg);
  }
  if (outcome && outcome.conflict === 'avail') throw AV.refusalError(outcome.code);
  if (outcome && outcome.conflict === 'price') throw new HttpsError('aborted', 'Price changed. Please review the new total.', { code: 'PRICE_CHANGED', totalCents: outcome.totalCents });
  if (outcome && outcome.conflict === 'coupon') throw new HttpsError('failed-precondition', outcome.reason || 'That discount code cannot be used.', { code: 'COUPON' });
  if (outcome && outcome.conflict === 'quote') throw new HttpsError('failed-precondition', 'This quote can no longer be booked.', { code: 'QUOTE' });
  if (outcome && outcome.conflict) throw new HttpsError(
    outcome.conflict,
    outcome.conflict === 'resource-exhausted' ? 'The provider is fully booked for that time.'
      : outcome.conflict === 'failed-precondition' ? 'You have reached your booking limit with this provider.'
        : 'That slot is no longer available. Please choose another time.');

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

  return { success: true, bookingId: outcome.bookingId, status: outcome.status, price: outcome.totalCents - fee, totalCents: outcome.totalCents, expiresAt: outcome.expiresAt };
};

/* ── bookingReleaseHold (P3) ──────────────────────────────────────────────────
   Proactive hold release. The client calls this the instant the customer abandons
   payment — closes the sheet, cancels, or the STK push fails/times out — so the slot
   is freed IMMEDIATELY instead of waiting for the expiry sweep. Rules:
     · Owner-only — a caller may release only their OWN reservation.
     · Never releases a slot that has already been paid (paymentStatus !== 'pending')
       — a paid hold is protected; releasing it would strand the payment.
     · Idempotent — a missing/already-terminal booking is a clean no-op (safe to call
       from a beforeunload handler that may fire more than once).
   Deletes the slot lock + cancels the booking in ONE transaction, and cancels any open
   payment intent so a late STK callback can't revive it. */
_h.bookingReleaseHold = async (req) => {
  const uid = _uid(req);
  const bookingId = _san((req.data || {}).bookingId, 256);
  if (!bookingId) throw new HttpsError('invalid-argument', 'bookingId required.');
  /* Delegate to the ONE canonical release path (shared with the webhook + sweep),
     scoped to the owner. Ownership failure surfaces as a permission error. */
  const res = await require('./booking-payment-sweep').releaseServiceHold(db, admin, {
    bookingId, reason: 'customer-abandoned', by: 'customer', ownerUid: uid,
  });
  if (res.reason === 'not-owner') throw new HttpsError('permission-denied', 'Not your reservation.');
  return { success: true, ...res };
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
  /* 2026-09-27 (provider reputation): delegates to THE review writer, functions/reputation.js — same
     eligibility (the customer's own COMPLETED booking, one review per booking, replay-safe), and the
     aggregate is now written to the PUBLIC providers/{uid} doc the profile reads (it used to update only
     the owner-private providerProfiles, while the public page showed a rating nothing maintained). */
  return require('./reputation').submitReview(req, 'providerBookings');
};

module.exports = { _h, _prepareSlot };
