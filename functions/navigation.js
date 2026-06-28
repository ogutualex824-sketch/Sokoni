'use strict';
/**
 * SOKONI Navigation & Intelligent Dispatch — Cloud Functions v1.0
 * 14 functions: dispatch, trip lifecycle, geofencing, PoD, SOS, fleet, tracking.
 * All queries use single-field filters to respect the 200/200 composite index cap.
 */

const { onCall, HttpsError }   = require('firebase-functions/v2/https');
const { onSchedule }           = require('firebase-functions/v2/scheduler');
const { onDocumentCreated }    = require('firebase-functions/v2/firestore');
const admin  = require('firebase-admin');
const crypto = require('crypto');

const db         = admin.firestore();
const FieldValue = admin.firestore.FieldValue;

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
exports.navDispatchRider = onCall({ enforceAppCheck: false }, async request => {
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

    const ridersSnap = await db.collection('riderLocations').where('status', '==', 'active').get();
    let bestScore = -1, bestId = null, bestDist = 0;

    for (const doc of ridersSnap.docs) {
      const loc = doc.data();
      // Fetch rider stats
      const statsSnap = await db.collection('drivers').doc(doc.id).get().catch(() => null);
      const stats = statsSnap && statsSnap.exists ? statsSnap.data() : {};
      if (!stats.available) continue;
      const { score, distKm } = _scoreRider(loc, stats, pickupLat, pickupLng, vehicleRequired);
      if (score > bestScore) { bestScore = score; bestId = doc.id; bestDist = distKm; }
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
exports.navUpdateTripStatus = onCall({ enforceAppCheck: false }, async request => {
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
exports.navRecordArrival = onCall({ enforceAppCheck: false }, async request => {
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
exports.navSubmitPOD = onCall({ enforceAppCheck: false }, async request => {
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
exports.navTriggerSOS = onCall({ enforceAppCheck: false }, async request => {
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
exports.navGetActiveTrip = onCall({ enforceAppCheck: false }, async request => {
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
exports.navGetCustomerTracking = onCall({ enforceAppCheck: false }, async request => {
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
exports.navGetFleetStatus = onCall({ enforceAppCheck: false }, async request => {
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
exports.navCompleteTrip = onCall({ enforceAppCheck: false }, async request => {
  _requireAuth(request.auth);
  const uid = request.auth.uid;
  const { tripId, earnings } = request.data;
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
    earnings:    earnings || null,
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

  // Update driver stats
  batch.update(db.collection('drivers').doc(trip.riderId), {
    activeDeliveries: FieldValue.increment(-1),
    tripsCompleted:   FieldValue.increment(1),
    totalEarnings:    FieldValue.increment(earnings || 0),
    currentTripId:    null,
  });

  await batch.commit();

  // Queue earnings payout via FinOS
  if (earnings && earnings > 0) {
    await db.collection('driverEarningQueue').add({
      riderId:   trip.riderId,
      tripId,
      orderId:   trip.orderId,
      amount:    earnings,
      status:    'pending',
      createdAt: FieldValue.serverTimestamp(),
    }).catch(() => {});
  }

  return { ok: true };
});

/* ═══════════════════════════════════════════════════════════════════════
   10. navGetRiderHistory — past trips for a rider
═══════════════════════════════════════════════════════════════════════ */
exports.navGetRiderHistory = onCall({ enforceAppCheck: false }, async request => {
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
exports.navGetMerchantTracking = onCall({ enforceAppCheck: false }, async request => {
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
exports.navCancelStop = onCall({ enforceAppCheck: false }, async request => {
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
exports.navAssignTrip = onCall({ enforceAppCheck: false }, async request => {
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
exports.navResolveFleetEvent = onCall({ enforceAppCheck: false }, async request => {
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

  const batch = db.batch();

  // Credit wallet
  const walletRef = db.collection('wallets').doc(riderId);
  batch.set(walletRef, {
    balance:   FieldValue.increment(amount),
    currency:  'KES',
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });

  // Wallet transaction record
  const txRef = db.collection('walletTransactions').doc();
  batch.set(txRef, {
    userId:      riderId,
    type:        'credit',
    amount,
    currency:    'KES',
    description: `Delivery earning — Order ${(orderId || '').slice(0, 8).toUpperCase()}`,
    source:      'delivery_earning',
    orderId:     orderId || null,
    tripId:      tripId  || null,
    status:      'completed',
    createdAt:   FieldValue.serverTimestamp(),
  });

  // Mark queue doc processed
  batch.update(snap.ref, {
    processed:   true,
    processedAt: FieldValue.serverTimestamp(),
  });

  await batch.commit();
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
