'use strict';
/**
 * SOKONI Navigation & Intelligent Dispatch — Cloud Functions v1.0
 * 14 functions: dispatch, trip lifecycle, geofencing, PoD, SOS, fleet, tracking.
 * All queries use single-field filters to respect the 200/200 composite index cap.
 */

const { onCall, HttpsError }   = require('firebase-functions/v2/https');
const { onSchedule }           = require('firebase-functions/v2/scheduler');
const { onDocumentCreated }    = require('firebase-functions/v2/firestore');
const { defineSecret }         = require('firebase-functions/params');
const admin  = require('firebase-admin');
const crypto = require('crypto');

const db         = admin.firestore();
const FieldValue = admin.firestore.FieldValue;

/* ── Secrets ────────────────────────────────────────────────────────────── */
const AFRICASTALKING_API_KEY  = defineSecret('AFRICASTALKING_API_KEY');
const AFRICASTALKING_USERNAME = defineSecret('AFRICASTALKING_USERNAME');

/* Central SMS module — the ONLY Africa's Talking client in the codebase.
   navigation.js used to build its own, pointed at the production endpoint while the
   rest of the platform honoured AT_ENV. One client, one credential resolver. */
const { atSendSMS } = require('./sokoni-at');

/* Branded OTP body. Kept here as one function so the wording, expiry and warning are
   identical everywhere — a user who sees two different OTP formats from the same brand
   is being trained to trust a phishing SMS. */
function _smsBody(otp) {
  return [
    'SOKONI',
    '',
    `Your verification code is: ${otp}`,
    '',
    'Expires in 30 minutes.',
    'Never share this code with anyone.',
    '',
    'mysokoni.co.ke',
  ].join('\n');
}

/* ── Constants ─────────────────────────────────────────────────────────── */
const TRIP_STATUSES  = ['pending','assigned','en_route_pickup','arrived_pickup','en_route_delivery','arrived_delivery','completed','cancelled'];
const VALID_VEHICLES = ['motorcycle','car','bicycle','tuktuk','van','pickup','truck'];
const POD_TYPES      = ['pin','qr','signature','photo','otp','none'];

/* ── Helpers ────────────────────────────────────────────────────────────── */
function _requireAuth(auth)       { if (!auth) throw new HttpsError('unauthenticated', 'Login required'); }
function _requireAdmin(token)     { if (!token.admin && !token.superAdmin) throw new HttpsError('permission-denied', 'Admin only'); }
function _requireDriver(token)    { if (!token.isDriver && !token.admin && !token.superAdmin) throw new HttpsError('permission-denied', 'Driver access required'); }
function _san(v, max)             { return String(v || '').replace(/[<>"'&]/g, c => ({'<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#x27;','&':'&amp;'}[c])).slice(0, max || 500); }
function _tracking()              { return crypto.randomBytes(4).toString('hex').toUpperCase(); } // 8-char public code

function _hav(lat1, lng1, lat2, lng2) {
  const R = 6371000, dLat = (lat2 - lat1) * Math.PI / 180, dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/* ── Rider scoring for dispatch ─────────────────────────────────────────── */
function _scoreRider(rider, stats, pickupLat, pickupLng, vehicleRequired) {
  let score = 0;

  // Distance (0–40): ≤1km = 40, ≤3km = 30, ≤5km = 20, ≤10km = 10, >10km = 0
  const distM  = _hav(rider.lat || 0, rider.lng || 0, pickupLat, pickupLng);
  const distKm = distM / 1000;
  if (distKm <= 1)       score += 40;
  else if (distKm <= 3)  score += 30;
  else if (distKm <= 5)  score += 20;
  else if (distKm <= 10) score += 10;

  // Workload (0–20): 0 active = 20, 1 active = 12, 2 = 5, 3+ = 0
  const active = stats.activeDeliveries || 0;
  if (active === 0)      score += 20;
  else if (active === 1) score += 12;
  else if (active === 2) score += 5;

  // Vehicle match (0–15)
  if (!vehicleRequired || rider.vehicle === vehicleRequired) score += 15;
  else if (vehicleRequired === 'motorcycle' && (rider.vehicle === 'car' || rider.vehicle === 'van')) score += 8;

  // Performance (0–15): acceptance rate × 0.10 + completion rate × 0.05
  const acc  = stats.acceptanceRate  || 0;
  const comp = stats.completionRate  || 0;
  score += Math.min(10, acc  / 10);
  score += Math.min(5,  comp / 20);

  // Availability flag (0–10)
  if (rider.available) score += 10;

  return { score, distKm: parseFloat(distKm.toFixed(2)) };
}

/* ═══════════════════════════════════════════════════════════════════════
   1. navDispatchRider — find and assign best available rider
═══════════════════════════════════════════════════════════════════════ */
exports.navDispatchRider = onCall({ enforceAppCheck: true }, async request => {
  _requireAuth(request.auth);
  const { orderId, vehicleRequired, manualRiderId } = request.data;
  if (!orderId) throw new HttpsError('invalid-argument', 'orderId required');

  // Load order
  const orderSnap = await db.collection('orders').doc(orderId).get();
  if (!orderSnap.exists) throw new HttpsError('not-found', 'Order not found');
  const order = orderSnap.data();

  // Build stops from order
  const stops = [];
  if (order.pickupLat && order.pickupLng) {
    stops.push({
      type:    'pickup',
      name:    _san(order.pickupName || order.vendorName || 'Pickup', 120),
      lat:     order.pickupLat,
      lng:     order.pickupLng,
      orderId: orderId,
      phone:   order.vendorPhone || null,
      status:  'pending',
    });
  }
  stops.push({
    type:    'delivery',
    name:    _san(order.deliveryAddress || 'Delivery', 120),
    lat:     order.deliveryLat || order.lat,
    lng:     order.deliveryLng || order.lng,
    orderId: orderId,
    phone:   order.buyerPhone  || order.customerPhone || null,
    status:  'pending',
    buyerId: order.buyerId     || order.userId || null,
  });

  // Manual assignment (admin override)
  let assignedRiderId = null;
  let assignedScore   = 0;
  let assignedDistKm  = 0;

  if (manualRiderId) {
    assignedRiderId = manualRiderId;
  } else {
    // Auto-dispatch: find best available rider
    const pickupLat = stops[0]?.lat || stops[stops.length - 1].lat;
    const pickupLng = stops[0]?.lng || stops[stops.length - 1].lng;

    const ridersSnap = await db.collection('riderLocations')
      .where('status', '==', 'active')
      .limit(100)
      .get();
    let bestScore = -1, bestId = null, bestDist = 0;

    if (!ridersSnap.empty) {
      // Batch-fetch all driver docs in a single Firestore call instead of N serial gets
      const driverRefs = ridersSnap.docs.map(d => db.collection('drivers').doc(d.id));
      const driverSnaps = await db.getAll(...driverRefs);
      const driverMap = {};
      for (const s of driverSnaps) { if (s.exists) driverMap[s.id] = s.data(); }

      for (const doc of ridersSnap.docs) {
        const loc   = doc.data();
        const stats = driverMap[doc.id] || {};
        if (!stats.available) continue;
        const { score, distKm } = _scoreRider(loc, stats, pickupLat, pickupLng, vehicleRequired);
        if (score > bestScore) { bestScore = score; bestId = doc.id; bestDist = distKm; }
      }
    }

    if (!bestId) throw new HttpsError('not-found', 'No available riders at this time');
    assignedRiderId = bestId;
    assignedScore   = bestScore;
    assignedDistKm  = bestDist;
  }

  // Create trip
  const trackingCode = _tracking();
  const tripRef      = db.collection('trips').doc();
  const batch        = db.batch();

  batch.set(tripRef, {
    orderId,
    riderId:        assignedRiderId,
    status:         'assigned',
    stops,
    currentStopIdx: 0,
    trackingCode,
    dispatchScore:  assignedScore,
    dispatchDistKm: assignedDistKm,
    vehicleRequired: vehicleRequired || null,
    startedAt:      null,
    completedAt:    null,
    earnings:       null,
    proofOfDelivery:null,
    createdAt:      FieldValue.serverTimestamp(),
    updatedAt:      FieldValue.serverTimestamp(),
  });

  // Update order
  batch.update(db.collection('orders').doc(orderId), {
    status:   'driver_assigned',
    riderId:  assignedRiderId,
    tripId:   tripRef.id,
    trackingCode,
    updatedAt: FieldValue.serverTimestamp(),
  });

  // Mark rider as having active delivery
  batch.update(db.collection('drivers').doc(assignedRiderId), {
    activeDeliveries: FieldValue.increment(1),
    currentTripId:    tripRef.id,
  });

  await batch.commit();

  // Notify rider via notification
  await db.collection('notifications').add({
    targetUid: assignedRiderId,
    type:      'new_delivery',
    title:     '📦 New Delivery',
    body:      'You have a new delivery assigned. Tap to navigate.',
    data:      { tripId: tripRef.id, orderId },
    read:      false,
    createdAt: FieldValue.serverTimestamp(),
  });

  return { tripId: tripRef.id, riderId: assignedRiderId, trackingCode };
});

/* ═══════════════════════════════════════════════════════════════════════
   2. navUpdateTripStatus — trip state machine
═══════════════════════════════════════════════════════════════════════ */
exports.navUpdateTripStatus = onCall({ enforceAppCheck: true }, async request => {
  _requireAuth(request.auth);
  const uid = request.auth.uid;
  const { tripId, status, stopIdx } = request.data;
  if (!tripId || !status) throw new HttpsError('invalid-argument', 'tripId, status required');
  if (!TRIP_STATUSES.includes(status)) throw new HttpsError('invalid-argument', 'Invalid status');

  const snap = await db.collection('trips').doc(tripId).get();
  if (!snap.exists) throw new HttpsError('not-found', 'Trip not found');
  const trip = snap.data();
  const t    = request.auth.token;
  if (trip.riderId !== uid && !t.admin && !t.superAdmin)
    throw new HttpsError('permission-denied', 'Not your trip');

  const updates = {
    status,
    updatedAt: FieldValue.serverTimestamp(),
  };
  if (stopIdx != null) updates.currentStopIdx = stopIdx;
  if (status === 'en_route_pickup' || status === 'en_route_delivery') updates.startedAt = FieldValue.serverTimestamp();
  if (status === 'completed') updates.completedAt = FieldValue.serverTimestamp();

  await snap.ref.update(updates);

  // Update linked order status
  const orderStatusMap = {
    en_route_pickup:      'driver_en_route',
    arrived_pickup:       'driver_at_pickup',
    en_route_delivery:    'out_for_delivery',
    arrived_delivery:     'driver_at_door',
    completed:            'delivered',
  };
  if (orderStatusMap[status] && trip.orderId) {
    await db.collection('orders').doc(trip.orderId).update({
      status:    orderStatusMap[status],
      updatedAt: FieldValue.serverTimestamp(),
    }).catch(() => {});
  }

  // Notify buyer when en_route_delivery
  if (status === 'en_route_delivery' && trip.stops) {
    const delivery = trip.stops.find(s => s.type === 'delivery');
    if (delivery && delivery.buyerId) {
      const trackingUrl = `https://mysokoni.co.ke/track.html?code=${trip.trackingCode}`;
      await db.collection('notifications').add({
        targetUid: delivery.buyerId,
        type:      'rider_on_way',
        title:     '🏍 Rider on the way!',
        body:      `Your delivery is on the way. Track live in the app.\nTrack your delivery: ${trackingUrl}`,
        url:       trackingUrl,
        data:      { tripId, orderId: trip.orderId, trackingCode: trip.trackingCode },
        read:      false,
        createdAt: FieldValue.serverTimestamp(),
      });
    }
  }

  return { ok: true };
});

/* ═══════════════════════════════════════════════════════════════════════
   3. navRecordArrival — geofence arrival event
═══════════════════════════════════════════════════════════════════════ */
exports.navRecordArrival = onCall({ enforceAppCheck: true }, async request => {
  _requireAuth(request.auth);
  const { tripId, stopIdx, lat, lng } = request.data;
  if (!tripId || stopIdx == null) throw new HttpsError('invalid-argument', 'tripId, stopIdx required');

  const snap = await db.collection('trips').doc(tripId).get();
  if (!snap.exists) throw new HttpsError('not-found', 'Trip not found');
  const trip = snap.data();
  if (trip.riderId !== request.auth.uid) throw new HttpsError('permission-denied', 'Not your trip');

  const stop     = (trip.stops || [])[stopIdx];
  const newStatus = stop?.type === 'pickup' ? 'arrived_pickup' : 'arrived_delivery';

  // Update stop in array
  const stops    = [...(trip.stops || [])];
  stops[stopIdx] = { ...stops[stopIdx], arrivedAt: new Date().toISOString(), arrivalLat: lat, arrivalLng: lng };

  await snap.ref.update({
    stops,
    status:    newStatus,
    updatedAt: FieldValue.serverTimestamp(),
  });

  // Notify merchant on pickup arrival
  if (stop?.type === 'pickup' && stop.merchantId) {
    await db.collection('notifications').add({
      targetUid: stop.merchantId,
      type:      'rider_at_pickup',
      title:     '🏍 Rider at your location',
      body:      'Your rider has arrived for pickup. Please have the order ready.',
      data:      { tripId, orderId: trip.orderId },
      read:      false,
      createdAt: FieldValue.serverTimestamp(),
    });
  }

  // Notify buyer on delivery arrival
  if (stop?.type === 'delivery' && stop.buyerId) {
    await db.collection('notifications').add({
      targetUid: stop.buyerId,
      type:      'rider_at_door',
      title:     '📦 Your delivery is here!',
      body:      'The rider has arrived. Please collect your order.',
      data:      { tripId, orderId: trip.orderId },
      read:      false,
      createdAt: FieldValue.serverTimestamp(),
    });
  }

  return { ok: true, status: newStatus };
});

/* ═══════════════════════════════════════════════════════════════════════
   4. navSubmitPOD — proof of delivery
═══════════════════════════════════════════════════════════════════════ */
exports.navSubmitPOD = onCall({ enforceAppCheck: true }, async request => {
  _requireAuth(request.auth);
  const { tripId, stopIdx, podType, value, lat, lng } = request.data;
  if (!tripId || stopIdx == null || !podType)
    throw new HttpsError('invalid-argument', 'tripId, stopIdx, podType required');
  if (!POD_TYPES.includes(podType))
    throw new HttpsError('invalid-argument', 'Invalid PoD type');

  const snap = await db.collection('trips').doc(tripId).get();
  if (!snap.exists) throw new HttpsError('not-found', 'Trip not found');
  const trip = snap.data();
  if (trip.riderId !== request.auth.uid) throw new HttpsError('permission-denied', 'Not your trip');

  const stops    = [...(trip.stops || [])];
  const pod = {
    type:        podType,
    value:       _san(value || '', 2000),
    lat:         lat  || null,
    lng:         lng  || null,
    completedAt: new Date().toISOString(),
    completedBy: request.auth.uid,
  };
  stops[stopIdx] = { ...stops[stopIdx], status: 'completed', pod, completedAt: pod.completedAt };

  // Check if all stops completed
  const allDone = stops.every(s => s.status === 'completed' || s.status === 'cancelled');
  const updates = {
    stops,
    proofOfDelivery: pod,
    updatedAt: FieldValue.serverTimestamp(),
  };
  if (allDone) {
    updates.status      = 'completed';
    updates.completedAt = FieldValue.serverTimestamp();
  } else {
    updates.currentStopIdx = stopIdx + 1;
  }

  await snap.ref.update(updates);

  if (allDone && trip.orderId) {
    await db.collection('orders').doc(trip.orderId).update({
      status:    'delivered',
      deliveredAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    }).catch(() => {});

    // Trigger FinOS earnings credit
    await db.collection('driverEarningQueue').add({
      riderId:  trip.riderId,
      tripId,
      orderId:  trip.orderId,
      status:   'pending',
      createdAt: FieldValue.serverTimestamp(),
    }).catch(() => {});

    // Update driver stats
    await db.collection('drivers').doc(trip.riderId).update({
      activeDeliveries: FieldValue.increment(-1),
      tripsCompleted:   FieldValue.increment(1),
      currentTripId:    null,
    }).catch(() => {});
  }

  return { ok: true, allCompleted: allDone };
});

/* ═══════════════════════════════════════════════════════════════════════
   5. navTriggerSOS — rider emergency alert
═══════════════════════════════════════════════════════════════════════ */
exports.navTriggerSOS = onCall({ enforceAppCheck: true }, async request => {
  _requireAuth(request.auth);
  const uid = request.auth.uid;
  const { tripId, lat, lng } = request.data;

  const event = {
    type:      'sos',
    riderId:   uid,
    tripId:    tripId || null,
    lat:       lat    || null,
    lng:       lng    || null,
    severity:  'critical',
    resolved:  false,
    createdAt: FieldValue.serverTimestamp(),
  };
  const ref = await db.collection('fleetEvents').add(event);

  // Critical admin notification
  await db.collection('notifications').add({
    targetRole: 'admin',
    type:       'rider_sos',
    title:      '🆘 RIDER SOS ALERT',
    body:       'A rider has triggered an emergency. Immediate action required.',
    data:       { eventId: ref.id, riderId: uid, tripId: tripId || null, lat, lng },
    read:       false,
    priority:   'critical',
    createdAt:  FieldValue.serverTimestamp(),
  });

  return { ok: true, eventId: ref.id };
});

/* ═══════════════════════════════════════════════════════════════════════
   6. navGetActiveTrip — rider's current assigned trip
═══════════════════════════════════════════════════════════════════════ */
exports.navGetActiveTrip = onCall({ enforceAppCheck: true }, async request => {
  _requireAuth(request.auth);
  const uid = request.auth.uid;
  // Single-field query: riderId + in-memory filter on status (no composite index)
  const snap = await db.collection('trips').where('riderId', '==', uid).get();
  const active = snap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .filter(t => t.status !== 'completed' && t.status !== 'cancelled')
    .sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));
  return { trip: active[0] || null };
});

/* ═══════════════════════════════════════════════════════════════════════
   7. navGetCustomerTracking — public tracking (no auth required)
═══════════════════════════════════════════════════════════════════════ */
exports.navGetCustomerTracking = onCall({ enforceAppCheck: true }, async request => {
  const { trackingCode } = request.data || {};
  if (!trackingCode || trackingCode.length !== 8)
    throw new HttpsError('invalid-argument', 'Invalid tracking code');

  // Find trip by tracking code (single-field query)
  const tripSnap = await db.collection('trips').where('trackingCode', '==', trackingCode.toUpperCase()).get();
  if (tripSnap.empty) throw new HttpsError('not-found', 'Tracking not found');
  const trip    = { id: tripSnap.docs[0].id, ...tripSnap.docs[0].data() };

  // Get rider's current location
  let riderLocation = null;
  if (trip.riderId) {
    const locSnap = await db.collection('riderLocations').doc(trip.riderId).get();
    if (locSnap.exists) {
      const loc = locSnap.data();
      // Only expose location if trip is active
      if (trip.status !== 'completed' && trip.status !== 'cancelled') {
        riderLocation = { lat: loc.lat, lng: loc.lng, bearing: loc.bearing, updatedAt: loc.updatedAt };
      }
    }
  }

  // Get rider display info (first name + rating only — no PII)
  let riderInfo = null;
  if (trip.riderId) {
    const driverSnap = await db.collection('drivers').doc(trip.riderId).get().catch(() => null);
    if (driverSnap && driverSnap.exists) {
      const d = driverSnap.data();
      riderInfo = {
        firstName: (d.name || '').split(' ')[0],
        rating:    d.rating || null,
        vehicle:   d.vehicleModel || d.vehicle || null,
        photo:     d.photoUrl || null,
      };
    }
  }

  // Sanitize stops — don't expose other stop addresses to buyer
  const sanitizedStops = (trip.stops || []).map(s => ({
    type:   s.type,
    status: s.status,
    name:   s.type === 'delivery' ? s.name : null, // hide pickup address
  }));

  return {
    status:       trip.status,
    orderId:      trip.orderId,
    trackingCode: trip.trackingCode,
    stops:        sanitizedStops,
    riderLocation,
    riderInfo,
    startedAt:    trip.startedAt,
    completedAt:  trip.completedAt,
  };
});

/* ═══════════════════════════════════════════════════════════════════════
   8. navGetFleetStatus — admin live fleet overview
═══════════════════════════════════════════════════════════════════════ */
exports.navGetFleetStatus = onCall({ enforceAppCheck: true }, async request => {
  _requireAuth(request.auth);
  _requireAdmin(request.auth.token);

  // All active rider locations
  const locSnap = await db.collection('riderLocations').where('status', '==', 'active').get();
  // All unresolved fleet events
  const eventSnap = await db.collection('fleetEvents').where('resolved', '==', false).get();
  // Active trips
  const tripSnap  = await db.collection('trips').where('status', 'in', ['assigned', 'en_route_pickup', 'arrived_pickup', 'en_route_delivery', 'arrived_delivery']).get();

  const riders = locSnap.docs.map(d => ({ riderId: d.id, ...d.data() }));
  const events = eventSnap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => {
    const sev = { critical: 0, high: 1, medium: 2, low: 3 };
    return (sev[a.severity] || 9) - (sev[b.severity] || 9);
  });
  const trips  = tripSnap.docs.map(d => ({ id: d.id, ...d.data() }));

  // Stats
  const stats = {
    activeRiders:     riders.length,
    activeDeliveries: trips.length,
    alerts:           events.length,
    idleRiders:       riders.filter(r => !r.tripId).length,
    sos:              events.filter(e => e.type === 'sos').length,
  };

  return { riders, events, trips, stats };
});

/* ═══════════════════════════════════════════════════════════════════════
   9. navCompleteTrip — mark entire trip done, trigger payout
═══════════════════════════════════════════════════════════════════════ */
exports.navCompleteTrip = onCall({ enforceAppCheck: true }, async request => {
  _requireAuth(request.auth);
  const uid = request.auth.uid;
  /* NOTE: any client-supplied `earnings` is intentionally IGNORED — never trust the client
     for a payout amount. The rider is credited server-authoritatively by onOrderStatusChange
     when the order flips to `delivered` below (the ONE proven, exactly-once delivery-payout
     rail). We do not enqueue a client amount here. */
  const { tripId } = request.data;
  if (!tripId) throw new HttpsError('invalid-argument', 'tripId required');

  const snap = await db.collection('trips').doc(tripId).get();
  if (!snap.exists) throw new HttpsError('not-found', 'Trip not found');
  const trip = snap.data();

  const t = request.auth.token;
  if (trip.riderId !== uid && !t.admin && !t.superAdmin)
    throw new HttpsError('permission-denied', 'Not authorised');
  if (trip.status === 'completed')
    throw new HttpsError('already-exists', 'Trip already completed');

  const batch = db.batch();
  batch.update(snap.ref, {
    status:      'completed',
    completedAt: FieldValue.serverTimestamp(),
    updatedAt:   FieldValue.serverTimestamp(),
  });

  // Update order to delivered
  if (trip.orderId) {
    batch.update(db.collection('orders').doc(trip.orderId), {
      status:    'delivered',
      deliveredAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
  }

  // Update driver stats (activity counters only — earnings are NOT taken from the client)
  batch.update(db.collection('drivers').doc(trip.riderId), {
    activeDeliveries: FieldValue.increment(-1),
    tripsCompleted:   FieldValue.increment(1),
    currentTripId:    null,
  });

  await batch.commit();

  /* No driverEarningQueue enqueue here. Flipping the order to `delivered` above fires
     onOrderStatusChange, which credits the rider the server-computed delivery-fee split
     exactly-once (walletTransactions/{rider}_{order}_delivery). Enqueuing a client-supplied
     amount was a double-pay + client-trust vector; removed. If order-less trip payouts are
     ever needed, add a SERVER-derived amount here — never request.data. */

  return { ok: true };
});

/* ═══════════════════════════════════════════════════════════════════════
   10. navGetRiderHistory — past trips for a rider
═══════════════════════════════════════════════════════════════════════ */
exports.navGetRiderHistory = onCall({ enforceAppCheck: true }, async request => {
  _requireAuth(request.auth);
  const uid   = request.auth.uid;
  const limit = Math.min(parseInt(request.data?.limit) || 20, 50);

  const snap = await db.collection('trips').where('riderId', '==', uid).get();
  const trips = snap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .filter(t => t.status === 'completed')
    .sort((a, b) => (b.completedAt?.seconds || 0) - (a.completedAt?.seconds || 0))
    .slice(0, limit);

  return { trips };
});

/* ═══════════════════════════════════════════════════════════════════════
   11. navGetMerchantTracking — merchant view (pickup ETA + status)
═══════════════════════════════════════════════════════════════════════ */
exports.navGetMerchantTracking = onCall({ enforceAppCheck: true }, async request => {
  _requireAuth(request.auth);
  const uid = request.auth.uid;
  const { orderId } = request.data;
  if (!orderId) throw new HttpsError('invalid-argument', 'orderId required');

  const tripSnap = await db.collection('trips').where('orderId', '==', orderId).get();
  if (tripSnap.empty) throw new HttpsError('not-found', 'No trip for this order');

  const trip = { id: tripSnap.docs[0].id, ...tripSnap.docs[0].data() };

  // Verify merchant owns one of the pickup stops
  const myStop = (trip.stops || []).find(s => s.type === 'pickup' && s.merchantId === uid);
  if (!myStop && !request.auth.token.admin)
    throw new HttpsError('permission-denied', 'Not your order');

  let riderLocation = null;
  if (trip.riderId && trip.status !== 'completed') {
    const locSnap = await db.collection('riderLocations').doc(trip.riderId).get();
    if (locSnap.exists) {
      const l = locSnap.data();
      riderLocation = { lat: l.lat, lng: l.lng };
    }
  }

  return {
    status:        trip.status,
    riderLocation,
    pickupStatus:  myStop?.status || 'pending',
    arrivedAt:     myStop?.arrivedAt || null,
    completedAt:   myStop?.completedAt || null,
    trackingCode:  trip.trackingCode,
  };
});

/* ═══════════════════════════════════════════════════════════════════════
   12. navCancelStop — remove one stop from active trip
═══════════════════════════════════════════════════════════════════════ */
exports.navCancelStop = onCall({ enforceAppCheck: true }, async request => {
  _requireAuth(request.auth);
  const { tripId, stopIdx, reason } = request.data;
  if (!tripId || stopIdx == null) throw new HttpsError('invalid-argument', 'tripId, stopIdx required');

  const snap = await db.collection('trips').doc(tripId).get();
  if (!snap.exists) throw new HttpsError('not-found', 'Trip not found');
  const trip = snap.data();
  const t    = request.auth.token;
  if (trip.riderId !== request.auth.uid && !t.admin && !t.superAdmin)
    throw new HttpsError('permission-denied', 'Not authorised');

  const stops    = [...(trip.stops || [])];
  stops[stopIdx] = { ...stops[stopIdx], status: 'cancelled', cancelReason: _san(reason || '', 200), cancelledAt: new Date().toISOString() };

  await snap.ref.update({ stops, updatedAt: FieldValue.serverTimestamp() });
  return { ok: true };
});

/* ═══════════════════════════════════════════════════════════════════════
   13. navAssignTrip — admin manually creates a trip with custom stops
═══════════════════════════════════════════════════════════════════════ */
exports.navAssignTrip = onCall({ enforceAppCheck: true }, async request => {
  _requireAuth(request.auth);
  _requireAdmin(request.auth.token);

  const { riderId, stops, orderId, vehicleRequired } = request.data;
  if (!riderId || !stops || !stops.length)
    throw new HttpsError('invalid-argument', 'riderId, stops required');

  const trackingCode = _tracking();
  const tripRef      = db.collection('trips').doc();

  await tripRef.set({
    orderId:         orderId || null,
    riderId,
    status:          'assigned',
    stops:           stops.map((s, i) => ({
      type:    s.type || 'delivery',
      name:    _san(s.name || '', 120),
      lat:     s.lat, lng: s.lng,
      phone:   s.phone || null,
      orderId: s.orderId || null,
      status:  'pending',
      _idx:    i,
    })),
    currentStopIdx:  0,
    trackingCode,
    vehicleRequired: vehicleRequired || null,
    createdBy:       request.auth.uid,
    startedAt:       null,
    completedAt:     null,
    createdAt:       FieldValue.serverTimestamp(),
    updatedAt:       FieldValue.serverTimestamp(),
  });

  await db.collection('notifications').add({
    targetUid: riderId,
    type:      'new_delivery',
    title:     '📦 New Assignment',
    body:      'You have been assigned a new trip. Tap to navigate.',
    data:      { tripId: tripRef.id },
    read:      false,
    createdAt: FieldValue.serverTimestamp(),
  });

  return { tripId: tripRef.id, trackingCode };
});

/* ═══════════════════════════════════════════════════════════════════════
   14. navResolveFleetEvent — admin resolves a SOS / alert
═══════════════════════════════════════════════════════════════════════ */
exports.navResolveFleetEvent = onCall({ enforceAppCheck: true }, async request => {
  _requireAuth(request.auth);
  _requireAdmin(request.auth.token);
  const { eventId, note } = request.data;
  if (!eventId) throw new HttpsError('invalid-argument', 'eventId required');
  await db.collection('fleetEvents').doc(eventId).update({
    resolved:   true,
    resolvedBy: request.auth.uid,
    resolvedAt: FieldValue.serverTimestamp(),
    resolveNote:_san(note || '', 500),
  });
  return { ok: true };
});

/* ═══════════════════════════════════════════════════════════════════════
   15. processDriverEarning — credit wallet on driverEarningQueue write
═══════════════════════════════════════════════════════════════════════ */
exports.processDriverEarning = onDocumentCreated('driverEarningQueue/{docId}', async (event) => {
  const snap = event.data;
  if (!snap) return;
  const data = snap.data();
  const { riderId, amount, orderId, tripId, source } = data;
  if (!riderId || !amount) return;

  /* P0-5: Firestore triggers are AT-LEAST-ONCE — this handler can fire twice for the
     same driverEarningQueue doc. The previous code used a batch (atomic, but NOT
     idempotent):
       • wallets.balance: FieldValue.increment(amount)   → a redelivery PAID THE DRIVER TWICE
       • walletTransactions.doc()                        → AUTO-ID: a second credit record
     It already wrote `processed: true` on the queue doc — but never READ it, so the
     guard existed in the data and was simply unused.

     Fix: the queue doc's `processed` flag is now the idempotency marker, checked and
     set inside ONE transaction, and the wallet-transaction id is derived
     deterministically from the queue doc id (one credit record per queue entry, by
     construction). Exactly-once with respect to money. */
  const docId     = event.params.docId;
  const walletRef = db.collection('wallets').doc(riderId);
  /* Cross-rail exactly-once. When this earning is tied to an order, share the SAME
     idempotency key the delivered-trigger payout uses: onOrderStatusChange writes
     walletTransactions/{rider}_{order}_delivery when orders.status flips to `delivered`.
     A trip completion flips its order to `delivered` (→ that rail) AND could enqueue here
     (→ this rail); with different keys each rail would credit once = double-pay. Sharing
     the key makes the two rails mutually exclusive — whichever fires first pays, the other
     no-ops. Order-less trips (no orderId) fall back to the queue-doc id. */
  const canonicalId = orderId ? `${riderId}_${orderId}_delivery` : docId;
  const txRef       = db.collection('walletTransactions').doc(canonicalId);

  const applied = await db.runTransaction(async (txn) => {
    const q = await txn.get(snap.ref);
    if (!q.exists || q.data().processed === true) return false;       // redelivery — already paid
    const paid = await txn.get(txRef);
    if (paid.exists) {                                                // the delivered-trigger rail already credited
      txn.update(snap.ref, { processed: true, processedAt: FieldValue.serverTimestamp(), skippedReason: 'already_paid_delivered_trigger' });
      return false;
    }

    txn.set(txRef, {
      userId:      riderId,
      uid:         riderId,
      type:        'delivery_earning',
      amount,
      currency:    'KES',
      description: `Delivery earning — Order ${(orderId || '').slice(0, 8).toUpperCase()}`,
      source:      'delivery_earning',
      sourceType:  'delivery',
      orderId:     orderId || null,
      tripId:      tripId  || null,
      status:      'completed',
      createdAt:   FieldValue.serverTimestamp(),
    });

    /* Safe here: runs at most once, guarded by the `processed` + shared-key checks above. */
    txn.set(walletRef, {
      balance:   FieldValue.increment(amount),
      currency:  'KES',
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });

    txn.update(snap.ref, {
      processed:   true,
      processedAt: FieldValue.serverTimestamp(),
    });

    return true;
  });

  if (!applied) {
    console.log(`Driver earning: duplicate trigger delivery ignored (queue=${docId})`);
    return;
  }

  console.log(`Driver earning processed: ${riderId} +KES ${amount} for order ${orderId}`);
});

/* ═══════════════════════════════════════════════════════════════════════
   Scheduled: clean up stale riderLocations (offline > 2h)
═══════════════════════════════════════════════════════════════════════ */
exports.navCleanupStaleLocations = onSchedule('every 2 hours', async () => {
  const cutoff = new Date(Date.now() - 2 * 3600 * 1000);
  const snap   = await db.collection('riderLocations').where('status', '==', 'offline').get();
  const batch  = db.batch();
  snap.docs.forEach(d => {
    const ts = d.data().updatedAt;
    if (ts && ts.toDate && ts.toDate() < cutoff) batch.delete(d.ref);
  });
  await batch.commit();
});

/* ═══════════════════════════════════════════════════════════════════════
   16. navGenerateDeliveryOTP — generate & SMS a 6-digit stop OTP
   Driver-only. Persists OTP to deliveryOTPs/{tripId}_{stopIndex} and
   sends it via Africa's Talking SMS. SMS failure is non-fatal.
═══════════════════════════════════════════════════════════════════════ */
exports.navGenerateDeliveryOTP = onCall(
  { enforceAppCheck: true, secrets: [AFRICASTALKING_API_KEY, AFRICASTALKING_USERNAME] },
  async request => {
    _requireAuth(request.auth);
    _requireDriver(request.auth.token);
    const uid       = request.auth.uid;
    const tripId    = _san(request.data.tripId    || '', 64);
    const stopIndex = request.data.stopIndex;

    if (!tripId)
      throw new HttpsError('invalid-argument', 'tripId required (max 64 chars)');
    if (!Number.isInteger(stopIndex) || stopIndex < 0)
      throw new HttpsError('invalid-argument', 'stopIndex must be a non-negative integer');

    // Verify trip exists and belongs to this rider
    const tripSnap = await db.collection('trips').doc(tripId).get();
    if (!tripSnap.exists) throw new HttpsError('not-found', 'Trip not found');
    const trip = tripSnap.data();
    if (trip.riderId !== uid)
      throw new HttpsError('permission-denied', 'Not your trip');

    const stop = (trip.stops || [])[stopIndex];
    if (!stop)
      throw new HttpsError('invalid-argument', 'stopIndex out of range');
    if (stop.pod?.type !== 'otp')
      throw new HttpsError('invalid-argument', 'This stop does not require an OTP');

    // Generate and persist OTP (30-min TTL)
    const otp       = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = admin.firestore.Timestamp.fromDate(new Date(Date.now() + 30 * 60 * 1000));

    await db.collection('deliveryOTPs').doc(`${tripId}_${stopIndex}`).set({
      otp,
      tripId,
      stopIndex,
      createdAt: FieldValue.serverTimestamp(),
      expiresAt,
      usedAt:    null,
    });

    // SMS via Africa's Talking REST API — wrap in try/catch so OTP is always returned
    let smsSent    = false;
    let maskedPhone = null;
    const phone    = stop.customer?.phone || stop.phone || null;

    if (phone) {
      maskedPhone = String(phone).slice(-4);
      try {
        /* Route through the CENTRAL SMS module (sokoni-at.js) — do not build a second
           Africa's Talking client here.

           This block previously POSTed straight to the PRODUCTION endpoint
           (api.africastalking.com) while the central module honours AT_ENV. With
           AT_ENV=sandbox and a sandbox key, that meant every delivery-OTP SMS hit the
           production API with a sandbox credential and returned 401 — silently, because
           the failure was only console.error'd. Rider/customer delivery OTPs were not
           being delivered.

           Using atSendSMS() means one client, one credential resolver, one environment
           switch, and one place to add a new provider. */
        const message = _smsBody(otp);
        const result  = await atSendSMS(phone, message);
        smsSent = !!(result && result.ok !== false);
        if (!smsSent) {
          console.error('navGenerateDeliveryOTP: SMS send failed', result && result.error);
        }
      } catch (smsErr) {
        console.error('navGenerateDeliveryOTP: SMS error', smsErr.message);
      }
    }

    return { success: true, smsSent, maskedPhone };
  }
);

/* ═══════════════════════════════════════════════════════════════════════
   17. navGetRiderDashboard — today / week / month performance stats
   Admins can pass riderId to view any rider; otherwise uses auth uid.
   All date filtering is in-memory to avoid composite indexes.
═══════════════════════════════════════════════════════════════════════ */
exports.navGetRiderDashboard = onCall({ enforceAppCheck: true }, async request => {
  _requireAuth(request.auth);
  const uid = request.auth.uid;

  let riderId = uid;
  if (request.data.riderId && request.data.riderId !== uid) {
    _requireAdmin(request.auth.token);
    riderId = _san(request.data.riderId, 128);
  }

  // Parallel fetches — single-field queries only
  const [snap1, snap2, tripsSnap, earningSnap] = await Promise.all([
    db.collection('riders').doc(riderId).get(),
    db.collection('driverProfiles').doc(riderId).get(),
    // Single-field filter: riderId only; status filtered in memory
    db.collection('trips').where('riderId', '==', riderId).limit(500).get(),
    db.collection('riderEarnings').doc(riderId).get(),
  ]);

  const riderDoc = snap1.exists ? snap1.data() : (snap2.exists ? snap2.data() : {});

  // Timestamp → ms helper
  function _tsMs(ts) {
    if (!ts) return 0;
    if (ts.toDate)  return ts.toDate().getTime();
    if (ts.seconds) return ts.seconds * 1000;
    return 0;
  }

  // Filter to only completed/cancelled for stat windows
  const allTrips  = tripsSnap.docs.map(d => ({ id: d.id, ...d.data() }))
    .filter(t => t.status === 'completed' || t.status === 'cancelled');

  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
  const weekStart  = new Date(); weekStart.setDate(weekStart.getDate() - 7); weekStart.setHours(0, 0, 0, 0);
  const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);

  // Aggregate stats for a slice of trips
  function _bucket(list) {
    const done     = list.filter(t => t.status === 'completed');
    const earnings = done.reduce((s, t) => s + (t.earnings || 0), 0);
    const distance = done.reduce((s, t) => s + (t.distanceKm || 0), 0);
    return {
      deliveries: done.length,
      earnings:   Math.round(earnings * 100) / 100,
      distance:   Math.round(distance * 100) / 100,
      cancelled:  list.filter(t => t.status === 'cancelled').length,
    };
  }

  const todayTrips = allTrips.filter(t => _tsMs(t.createdAt) >= todayStart.getTime());
  const weekTrips  = allTrips.filter(t => _tsMs(t.createdAt) >= weekStart.getTime());
  const monthTrips = allTrips.filter(t => _tsMs(t.createdAt) >= monthStart.getTime());

  const completed  = allTrips.filter(t => t.status === 'completed');
  const onTimeAll  = completed.filter(t => {
    const arrived = _tsMs(t.arrivedAt); const est = _tsMs(t.estimatedArrival);
    return arrived > 0 && est > 0 && arrived <= est;
  }).length;
  const onTimeRate     = completed.length ? Math.round((onTimeAll / completed.length) * 100) : 0;

  const accepted       = riderDoc.acceptedCount || 0;
  const declined       = riderDoc.declinedCount || 0;
  const acceptanceRate = (accepted + declined) > 0
    ? Math.round((accepted / (accepted + declined)) * 100)
    : 0;

  const totalEarnings  = earningSnap.exists
    ? (earningSnap.data().totalEarnings || 0)
    : completed.reduce((s, t) => s + (t.earnings || 0), 0);

  return {
    riderId,
    today:   _bucket(todayTrips),
    week:    _bucket(weekTrips),
    month:   _bucket(monthTrips),
    overall: {
      totalDeliveries: completed.length,
      totalEarnings:   Math.round(totalEarnings * 100) / 100,
      avgRating:       riderDoc.rating || 0,
      acceptanceRate,
      onTimeRate,
    },
    rider: {
      name:     riderDoc.name     || riderDoc.displayName || null,
      vehicle:  riderDoc.vehicle  || riderDoc.vehicleType || null,
      status:   riderDoc.status   || (riderDoc.available  ? 'active' : 'offline'),
      rating:   riderDoc.rating   || null,
      photoUrl: riderDoc.photoUrl || riderDoc.photo       || null,
    },
  };
});

/* ═══════════════════════════════════════════════════════════════════════
   18. navBatchSyncLocations — offline-buffered GPS batch upload
   Writes the latest position to riderLocations/{uid} and up to 50
   history points to riderLocationHistory/{uid}/points/{timestamp}.
═══════════════════════════════════════════════════════════════════════ */
exports.navBatchSyncLocations = onCall({ enforceAppCheck: true }, async request => {
  _requireAuth(request.auth);
  _requireDriver(request.auth.token);
  const uid       = request.auth.uid;
  const tripId    = _san(request.data.tripId || '', 64);
  const locations = request.data.locations;

  if (!tripId)
    throw new HttpsError('invalid-argument', 'tripId required');
  if (!Array.isArray(locations) || locations.length === 0)
    throw new HttpsError('invalid-argument', 'locations must be a non-empty array');
  if (locations.length > 100)
    throw new HttpsError('invalid-argument', 'Maximum 100 locations per batch');

  // Verify trip belongs to this rider (single-field doc fetch — no query)
  const tripSnap = await db.collection('trips').doc(tripId).get();
  if (!tripSnap.exists) throw new HttpsError('not-found', 'Trip not found');
  if (tripSnap.data().riderId !== uid)
    throw new HttpsError('permission-denied', 'Not your trip');

  // Validate every location entry before writing anything
  for (const [i, loc] of locations.entries()) {
    if (typeof loc.lat !== 'number' || loc.lat < -90  || loc.lat > 90)
      throw new HttpsError('invalid-argument', `locations[${i}].lat out of range (-90 to 90)`);
    if (typeof loc.lng !== 'number' || loc.lng < -180 || loc.lng > 180)
      throw new HttpsError('invalid-argument', `locations[${i}].lng out of range (-180 to 180)`);
    if (typeof loc.timestamp !== 'number')
      throw new HttpsError('invalid-argument', `locations[${i}].timestamp must be a number`);
  }

  const last    = locations[locations.length - 1];
  const toStore = locations.slice(-50); // cap history writes at 50 to stay well under batch limit

  const batch = db.batch();

  // Live position — queried by customers and fleet monitor
  batch.set(db.collection('riderLocations').doc(uid), {
    lat:       last.lat,
    lng:       last.lng,
    bearing:   last.bearing   ?? null,
    speed:     last.speed     ?? null,
    updatedAt: FieldValue.serverTimestamp(),
    tripId,
    status:    'active',
  }, { merge: true });

  // History subcollection — analytics only, not customer-facing
  const histRef = db.collection('riderLocationHistory').doc(uid).collection('points');
  for (const loc of toStore) {
    batch.set(histRef.doc(String(loc.timestamp)), {
      lat:      loc.lat,
      lng:      loc.lng,
      bearing:  loc.bearing  ?? null,
      speed:    loc.speed    ?? null,
      accuracy: loc.accuracy ?? null,
      ts:       loc.timestamp,
    });
  }

  await batch.commit();
  return {
    synced:       locations.length,
    lastLocation: { lat: last.lat, lng: last.lng, timestamp: last.timestamp },
  };
});

/* ═══════════════════════════════════════════════════════════════════════
   19. navGetDeliveryAnalytics — admin delivery performance report
   Admin-only. Queries last N days (1–90, default 30). All date and
   grouping logic runs in-memory to avoid composite indexes.
═══════════════════════════════════════════════════════════════════════ */
exports.navGetDeliveryAnalytics = onCall({ enforceAppCheck: true }, async request => {
  _requireAuth(request.auth);
  _requireAdmin(request.auth.token);

  const daysBack = Math.min(Math.max(Number(request.data.days) || 30, 1), 90);
  const cutoff   = new Date(Date.now() - daysBack * 24 * 3600 * 1000);

  // Single-field query: status only
  const snap = await db.collection('trips')
    .where('status', 'in', ['completed', 'cancelled'])
    .limit(1000)
    .get();

  function _tsMs(ts) {
    if (!ts) return 0;
    if (ts.toDate)  return ts.toDate().getTime();
    if (ts.seconds) return ts.seconds * 1000;
    return 0;
  }

  // Filter to the requested date window in memory
  const trips     = snap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .filter(t => _tsMs(t.createdAt) >= cutoff.getTime());

  const completed = trips.filter(t => t.status === 'completed');
  const cancelled = trips.filter(t => t.status === 'cancelled');

  // Average delivery time: assignedAt → completedAt (minutes)
  let sumMins = 0, countMins = 0;
  for (const t of completed) {
    const a = _tsMs(t.assignedAt); const c = _tsMs(t.completedAt);
    if (a > 0 && c > a) { sumMins += (c - a) / 60000; countMins++; }
  }
  const avgDeliveryTimeMinutes = countMins > 0 ? Math.round((sumMins / countMins) * 10) / 10 : 0;

  // On-time rate: arrivedAt ≤ estimatedArrival
  const onTime    = completed.filter(t => {
    const arrived = _tsMs(t.arrivedAt); const est = _tsMs(t.estimatedArrival);
    return arrived > 0 && est > 0 && arrived <= est;
  }).length;
  const onTimeRate = completed.length > 0 ? Math.round((onTime / completed.length) * 100) : 0;

  // Pre-seed a slot for every day in range so gaps appear as zeros
  const dailyMap = {};
  for (let i = 0; i < daysBack; i++) {
    const d = new Date(Date.now() - i * 24 * 3600 * 1000); d.setHours(0, 0, 0, 0);
    dailyMap[d.toISOString().slice(0, 10)] = { completed: 0, cancelled: 0, revenue: 0 };
  }
  for (const t of trips) {
    const key = new Date(_tsMs(t.createdAt)).toISOString().slice(0, 10);
    if (!dailyMap[key]) continue;
    if (t.status === 'completed') { dailyMap[key].completed++; dailyMap[key].revenue += (t.earnings || 0); }
    else                          { dailyMap[key].cancelled++; }
  }
  const dailyStats = Object.entries(dailyMap)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, s]) => ({
      date,
      completed: s.completed,
      cancelled: s.cancelled,
      revenue:   Math.round(s.revenue * 100) / 100,
    }));

  // Top 5 riders by completed delivery count
  const riderCount = {};
  for (const t of completed) {
    const rid = t.riderId;
    if (rid) riderCount[rid] = (riderCount[rid] || 0) + 1;
  }
  const topRiders = Object.entries(riderCount)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 5)
    .map(([riderId, completedTrips]) => ({ riderId, completedTrips }));

  // Average stops per trip
  const totalStops    = trips.reduce((s, t) => s + ((t.stops || []).length), 0);
  const avgStopsPerTrip = trips.length > 0 ? Math.round((totalStops / trips.length) * 10) / 10 : 0;

  // Cancellation breakdown by reason
  const reasonMap = {};
  for (const t of cancelled) {
    const r = _san(t.cancelReason || 'unknown', 100);
    reasonMap[r] = (reasonMap[r] || 0) + 1;
  }
  const cancellationByReason = Object.entries(reasonMap)
    .map(([reason, count]) => ({ reason, count }));

  return {
    daysBack,
    totalCompleted: completed.length,
    totalCancelled: cancelled.length,
    avgDeliveryTimeMinutes,
    onTimeRate,
    dailyStats,
    topRiders,
    avgStopsPerTrip,
    cancellationByReason,
  };
});
