/* ================================================================
   SOKONI — Dispatch Cloud Functions  v1.0
   8 CFs handling server-side intelligent dispatch, cascade
   timeouts, proof of delivery, failed delivery workflows,
   GPS fraud detection, and analytics rollups.
================================================================ */
'use strict';

const functions      = require('firebase-functions');
const admin          = require('firebase-admin');
const SokoniDispatch = require('../sokoni-dispatch');
const SokoniLogistics = require('../sokoni-logistics');

const db = admin.firestore;   /* lazy accessor to avoid init-order issues */

/* ─────────────────────────────────────────────────────────────
   HELPERS
──────────────────────────────────────────────────────────────*/
function _db() { return admin.firestore(); }
function _uid(ctx) { return ctx && ctx.auth ? ctx.auth.uid : null; }
function _assertAuth(ctx) {
  if (!_uid(ctx)) throw new functions.https.HttpsError('unauthenticated', 'Login required');
}

function _now() { return admin.firestore.FieldValue.serverTimestamp(); }
function _nowMs() { return Date.now(); }

/* Send FCM push to a single FCM token */
async function _sendPush(token, title, body, data) {
  if (!token) return;
  try {
    await admin.messaging().send({ token, notification: { title, body }, data: data || {} });
  } catch (e) {
    console.warn('[dispatch] FCM push failed', e.message);
  }
}

/* Send SMS via stored function (re-use existing sendSMS pattern) */
async function _sendSMS(phone, message) {
  if (!phone) return;
  try {
    await _db().collection('smsQueue').add({ phone, message, createdAt: _now(), status: 'pending' });
  } catch (e) {
    console.warn('[dispatch] SMS queue write failed', e.message);
  }
}

/* ─────────────────────────────────────────────────────────────
   1. dispatchDelivery (callable)
   Called by seller / system when order becomes ready_for_pickup.
   Scores all online riders, writes dispatchQueue doc, offers #1.
──────────────────────────────────────────────────────────────*/
exports.dispatchDelivery = functions
  .region('europe-west1')
  .runWith({ timeoutSeconds: 60, memory: '256MB' })
  .https.onCall(async (data, ctx) => {
    _assertAuth(ctx);
    const { deliveryRef } = data;
    if (!deliveryRef) throw new functions.https.HttpsError('invalid-argument', 'deliveryRef required');

    const firestore = _db();

    /* Fetch delivery doc */
    const deliverySnap = await firestore.collection('packageRequests').doc(deliveryRef).get();
    if (!deliverySnap.exists) throw new functions.https.HttpsError('not-found', 'Delivery not found');
    const delivery = Object.assign({ id: deliveryRef }, deliverySnap.data());

    /* Guard: only dispatch when status is ready_for_pickup */
    if (!['ready_for_pickup', 'pending'].includes(delivery.status)) {
      throw new functions.https.HttpsError('failed-precondition', `Delivery status is "${delivery.status}", expected ready_for_pickup`);
    }

    /* Idempotency: if cascade already exists and is offered/accepted, return */
    const existingCascade = await firestore.collection('dispatchQueue').doc(deliveryRef).get();
    if (existingCascade.exists) {
      const st = existingCascade.data().status;
      if (st === 'offered' || st === 'accepted') return { status: st, cached: true };
    }

    /* Fetch online riders */
    const ridersSnap = await firestore.collection('rideDrivers')
      .where('isOnline', '==', true)
      .limit(100)
      .get();

    const riders = ridersSnap.docs.map(d => Object.assign({ uid: d.id }, d.data()));

    /* Rank riders */
    const ranked = SokoniDispatch.rankRiders(riders, delivery);

    if (!ranked.length) {
      /* No eligible riders: write exhausted cascade so seller sees "no riders" */
      await firestore.collection('dispatchQueue').doc(deliveryRef).set({
        deliveryRef,
        rankedRiders:  [],
        currentIndex:  0,
        attempts:      [],
        status:        'exhausted',
        createdAt:     _now(),
        updatedAt:     _now(),
        exhaustedAt:   _now(),
      });
      /* Notify seller */
      if (delivery.sellerFcmToken) {
        await _sendPush(delivery.sellerFcmToken, 'No Riders Available',
          'We could not find a rider for your delivery. We\'ll keep trying.');
      }
      return { status: 'exhausted', ranked: 0 };
    }

    /* Build cascade state */
    const slimRanked = ranked.slice(0, 20).map(r => ({
      riderId:    r.riderId,
      riderName:  r.riderName,
      riderPhone: r.riderPhone,
      vehicleType:r.vehicleType,
      score:      r.score,
      distKm:     r.distKm,
      etaMin:     r.etaMin,
    }));

    const cascade = SokoniDispatch.createCascadeState(slimRanked, deliveryRef);
    SokoniDispatch.recordOffer(cascade);

    await firestore.collection('dispatchQueue').doc(deliveryRef).set({
      ...cascade,
      createdAt:  _now(),
      updatedAt:  _now(),
      timeoutAt:  new Date(_nowMs() + SokoniDispatch.CFG.dispatchTimeoutSec * 1000),
    });

    /* Update delivery status → driver_assigned */
    await firestore.collection('packageRequests').doc(deliveryRef).update({
      status:          'driver_assigned',
      assignedRiderId: ranked[0].riderId,
      assignedRiderName: ranked[0].riderName,
      assignedRiderPhone: ranked[0].riderPhone,
      dispatchScore:   ranked[0].score,
      dispatchEtaMin:  ranked[0].etaMin,
      dispatchDistKm:  ranked[0].distKm,
      driverAssignedAt:_now(),
      updatedAt:       _now(),
    });

    /* Send push/SMS to assigned rider */
    const riderDoc = await firestore.collection('rideDrivers').doc(ranked[0].riderId).get();
    const riderData = riderDoc.data() || {};
    if (riderData.fcmToken) {
      await _sendPush(riderData.fcmToken, 'New Delivery Request',
        `Pickup: ${delivery.pickupAddress || 'Seller'}. Fee: KES ${delivery.deliveryFee || 0}. ${ranked[0].etaMin} min away.`,
        { deliveryRef, action: 'dispatch_offer' });
    }
    if (riderData.phone) {
      await _sendSMS(riderData.phone,
        `SOKONI: New delivery request! Pickup: ${delivery.pickupAddress || 'N/A'}. Fee: KES ${delivery.deliveryFee || 0}. Accept in 90s on your app.`);
    }

    /* Notify buyer */
    if (delivery.buyerFcmToken) {
      await _sendPush(delivery.buyerFcmToken, 'Rider Assigned!',
        `${ranked[0].riderName} is on the way to pick up your order. ETA: ~${ranked[0].etaMin} min.`);
    }

    functions.logger.info('[dispatch] Dispatch initiated', { deliveryRef, riderId: ranked[0].riderId, score: ranked[0].score });
    return { status: 'offered', riderId: ranked[0].riderId, etaMin: ranked[0].etaMin, ranked: ranked.length };
  });

/* ─────────────────────────────────────────────────────────────
   2. respondToDispatch (callable)
   Rider accepts or declines a dispatch offer.
──────────────────────────────────────────────────────────────*/
exports.respondToDispatch = functions
  .region('europe-west1')
  .runWith({ timeoutSeconds: 30, memory: '128MB' })
  .https.onCall(async (data, ctx) => {
    _assertAuth(ctx);
    const riderId = _uid(ctx);
    const { deliveryRef, accept } = data;
    if (!deliveryRef) throw new functions.https.HttpsError('invalid-argument', 'deliveryRef required');

    const firestore = _db();
    const cascadeRef = firestore.collection('dispatchQueue').doc(deliveryRef);
    const cascadeSnap = await cascadeRef.get();
    if (!cascadeSnap.exists) throw new functions.https.HttpsError('not-found', 'Dispatch queue entry not found');

    const cascade = cascadeSnap.data();
    if (cascade.status !== 'offered') {
      throw new functions.https.HttpsError('failed-precondition', `Dispatch already ${cascade.status}`);
    }

    const current = SokoniDispatch.getCurrentCandidate(cascade);
    if (!current || current.riderId !== riderId) {
      throw new functions.https.HttpsError('permission-denied', 'You are not the current dispatch candidate');
    }

    if (accept) {
      SokoniDispatch.acceptCascade(cascade, riderId);
      await cascadeRef.update({ ...cascade, updatedAt: _now() });

      /* Update delivery doc */
      await firestore.collection('packageRequests').doc(deliveryRef).update({
        status:          'driver_accepted',
        riderId:         riderId,
        riderAcceptedAt: _now(),
        updatedAt:       _now(),
      });

      /* Increment rider activeDeliveries */
      await firestore.collection('rideDrivers').doc(riderId).update({
        activeDeliveries: admin.firestore.FieldValue.increment(1),
        updatedAt:        _now(),
      });

      const deliverySnap = await firestore.collection('packageRequests').doc(deliveryRef).get();
      const delivery = deliverySnap.data() || {};
      if (delivery.buyerFcmToken) {
        await _sendPush(delivery.buyerFcmToken, 'Rider Accepted!', 'Your rider has accepted the delivery and is on their way.');
      }

      functions.logger.info('[dispatch] Rider accepted', { deliveryRef, riderId });
      return { status: 'accepted' };
    } else {
      /* Declined — advance cascade */
      SokoniDispatch.advanceCascade(cascade, 'declined');

      if (cascade.status === 'exhausted') {
        await cascadeRef.update({ ...cascade, updatedAt: _now(), exhaustedAt: _now() });
        functions.logger.warn('[dispatch] Cascade exhausted after decline', { deliveryRef });
        return { status: 'exhausted' };
      }

      /* Offer to next rider */
      SokoniDispatch.recordOffer(cascade);
      await cascadeRef.update({
        ...cascade,
        updatedAt: _now(),
        timeoutAt: new Date(_nowMs() + SokoniDispatch.CFG.dispatchTimeoutSec * 1000),
      });

      const nextRider = SokoniDispatch.getCurrentCandidate(cascade);
      if (nextRider) {
        const riderDoc = await firestore.collection('rideDrivers').doc(nextRider.riderId).get();
        const riderData = riderDoc.data() || {};
        if (riderData.fcmToken) {
          const delivery = (await firestore.collection('packageRequests').doc(deliveryRef).get()).data() || {};
          await _sendPush(riderData.fcmToken, 'New Delivery Request',
            `Pickup: ${delivery.pickupAddress || 'Seller'}. Fee: KES ${delivery.deliveryFee || 0}.`,
            { deliveryRef, action: 'dispatch_offer' });
        }
      }

      functions.logger.info('[dispatch] Rider declined, advanced cascade', { deliveryRef, riderId, newIndex: cascade.currentIndex });
      return { status: 'advanced', nextRider: nextRider?.riderId || null };
    }
  });

/* ─────────────────────────────────────────────────────────────
   3. processCascadeTimeouts (scheduled — every 1 min)
   Advances any offers that have exceeded the timeout window.
──────────────────────────────────────────────────────────────*/
exports.processCascadeTimeouts = functions
  .region('europe-west1')
  .runWith({ timeoutSeconds: 120, memory: '256MB' })
  .pubsub.schedule('every 1 minutes')
  .onRun(async () => {
    const firestore = _db();
    const now = new Date();

    const snap = await firestore.collection('dispatchQueue')
      .where('status', '==', 'offered')
      .where('timeoutAt', '<=', now)
      .limit(50)
      .get();

    if (snap.empty) return null;

    const batch = firestore.batch();
    const notifications = [];

    for (const doc of snap.docs) {
      const cascade = doc.data();
      SokoniDispatch.advanceCascade(cascade, 'timeout');

      if (cascade.status === 'exhausted') {
        batch.update(doc.ref, {
          ...cascade,
          updatedAt:   admin.firestore.FieldValue.serverTimestamp(),
          exhaustedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        notifications.push({ deliveryRef: cascade.deliveryRef, action: 'exhausted' });
      } else {
        SokoniDispatch.recordOffer(cascade);
        batch.update(doc.ref, {
          ...cascade,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          timeoutAt: new Date(Date.now() + SokoniDispatch.CFG.dispatchTimeoutSec * 1000),
        });
        notifications.push({
          deliveryRef: cascade.deliveryRef,
          action:      'next_rider',
          nextRider:   SokoniDispatch.getCurrentCandidate(cascade),
        });
      }
    }

    await batch.commit();

    /* Notify next riders outside batch */
    for (const n of notifications) {
      if (n.action === 'next_rider' && n.nextRider) {
        try {
          const riderDoc = await firestore.collection('rideDrivers').doc(n.nextRider.riderId).get();
          const fcm = (riderDoc.data() || {}).fcmToken;
          if (fcm) {
            const delivery = (await firestore.collection('packageRequests').doc(n.deliveryRef).get()).data() || {};
            await _sendPush(fcm, 'New Delivery Request',
              `Pickup: ${delivery.pickupAddress || 'Seller'}. Fee: KES ${delivery.deliveryFee || 0}.`,
              { deliveryRef: n.deliveryRef, action: 'dispatch_offer' });
          }
        } catch (e) {
          console.warn('[dispatch] Timeout notification error', e.message);
        }
      }
    }

    functions.logger.info('[dispatch] Processed cascade timeouts', { count: snap.size });
    return null;
  });

/* ─────────────────────────────────────────────────────────────
   4. captureProofOfDelivery (callable)
   Validates OTP + photo + GPS, marks delivery as delivered.
──────────────────────────────────────────────────────────────*/
exports.captureProofOfDelivery = functions
  .region('europe-west1')
  .runWith({ timeoutSeconds: 30, memory: '128MB' })
  .https.onCall(async (data, ctx) => {
    _assertAuth(ctx);
    const riderId = _uid(ctx);
    const { deliveryRef, otp, photoUrl, gpsLat, gpsLng, gpsAccuracyM } = data;

    if (!deliveryRef) throw new functions.https.HttpsError('invalid-argument', 'deliveryRef required');

    const firestore = _db();
    const deliverySnap = await firestore.collection('packageRequests').doc(deliveryRef).get();
    if (!deliverySnap.exists) throw new functions.https.HttpsError('not-found', 'Delivery not found');

    const delivery = deliverySnap.data();

    /* Verify rider owns this delivery */
    if (delivery.riderId !== riderId && delivery.driverId !== riderId) {
      throw new functions.https.HttpsError('permission-denied', 'You are not assigned to this delivery');
    }

    /* Determine required proof methods */
    const requiredMethods = delivery.proofRequirements || ['otp'];

    /* Validate proof */
    const proofResult = SokoniLogistics.validateProof(
      { otp, photoUrl, gpsLat, gpsLng },
      {
        otp:           delivery.deliveryOTP,
        dropoffLat:    delivery.dropoffLat  || delivery.deliveryCoords?.lat,
        dropoffLng:    delivery.dropoffLng  || delivery.deliveryCoords?.lng,
        requiredMethods,
      }
    );

    if (!proofResult.valid) {
      throw new functions.https.HttpsError('failed-precondition', proofResult.error);
    }

    const proofRecord = SokoniLogistics.buildProofRecord(deliveryRef, riderId, {
      otp, photoUrl, gpsLat, gpsLng, gpsAccuracyM,
    });

    const batchOp = firestore.batch();

    /* Save proof */
    batchOp.set(firestore.collection('deliveryProofs').doc(deliveryRef), {
      ...proofRecord,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    /* Mark delivered */
    batchOp.update(firestore.collection('packageRequests').doc(deliveryRef), {
      status:          'delivered',
      deliveredAt:     admin.firestore.FieldValue.serverTimestamp(),
      proofCaptured:   true,
      proofPhotoUrl:   photoUrl || null,
      proofGpsLat:     gpsLat || null,
      proofGpsLng:     gpsLng || null,
      sellerPayoutReady: true,
      updatedAt:       admin.firestore.FieldValue.serverTimestamp(),
    });

    /* Decrement rider activeDeliveries */
    batchOp.update(firestore.collection('rideDrivers').doc(riderId), {
      activeDeliveries:   admin.firestore.FieldValue.increment(-1),
      totalDeliveries:    admin.firestore.FieldValue.increment(1),
      totalEarnings:      admin.firestore.FieldValue.increment(delivery.driverNet || 0),
      updatedAt:          admin.firestore.FieldValue.serverTimestamp(),
    });

    await batchOp.commit();

    /* Notify buyer */
    if (delivery.buyerFcmToken) {
      await _sendPush(delivery.buyerFcmToken, 'Order Delivered!', 'Your order has been delivered. Enjoy!');
    }
    if (delivery.buyerPhone) {
      await _sendSMS(delivery.buyerPhone, `SOKONI: Your order has been delivered! Thank you for shopping on SOKONI. Ref: ${deliveryRef}`);
    }

    functions.logger.info('[dispatch] Proof captured, delivery complete', { deliveryRef, riderId });
    return { status: 'delivered' };
  });

/* ─────────────────────────────────────────────────────────────
   5. handleFailedDelivery (callable)
   Initiates retry / return / refund workflow.
──────────────────────────────────────────────────────────────*/
exports.handleFailedDelivery = functions
  .region('europe-west1')
  .runWith({ timeoutSeconds: 30, memory: '128MB' })
  .https.onCall(async (data, ctx) => {
    _assertAuth(ctx);
    const { deliveryRef, reason, note } = data;
    if (!deliveryRef || !reason) throw new functions.https.HttpsError('invalid-argument', 'deliveryRef and reason required');

    const firestore = _db();
    const deliverySnap = await firestore.collection('packageRequests').doc(deliveryRef).get();
    if (!deliverySnap.exists) throw new functions.https.HttpsError('not-found', 'Delivery not found');
    const delivery = deliverySnap.data();

    /* Get attempt count */
    const attemptsSnap = await firestore.collection('deliveryAttempts')
      .where('deliveryRef', '==', deliveryRef)
      .get();
    const attemptCount = attemptsSnap.size;

    /* Log the attempt */
    await firestore.collection('deliveryAttempts').add({
      deliveryRef,
      reason,
      note:     note || null,
      riderId:  delivery.riderId || null,
      attemptAt: admin.firestore.FieldValue.serverTimestamp(),
      attemptNumber: attemptCount + 1,
    });

    const action = SokoniDispatch.getFailedDeliveryAction(reason, attemptCount);

    /* Update delivery doc */
    const updates = {
      failReason:      reason,
      failNote:        note || null,
      lastFailedAt:    admin.firestore.FieldValue.serverTimestamp(),
      failAction:      action.action,
      updatedAt:       admin.firestore.FieldValue.serverTimestamp(),
    };

    if (action.action === 'retry') {
      updates.status       = 'retry_scheduled';
      updates.retryAfter   = new Date(Date.now() + (action.retryAfterMin || 30) * 60000);
      updates.retryCount   = admin.firestore.FieldValue.increment(1);
    } else if (action.action === 'reassign') {
      updates.status       = 'ready_for_pickup'; /* re-enter dispatch queue */
      updates.riderId      = null;
      updates.driverId     = null;
    } else if (action.action === 'return') {
      updates.status = 'return_in_progress';
    } else if (action.action === 'refund') {
      updates.status = 'refund_initiated';
    } else {
      updates.status = 'support_required';
      updates.escalated = true;
    }

    await firestore.collection('packageRequests').doc(deliveryRef).update(updates);

    /* Release rider if reassigning */
    if (action.action === 'reassign' && delivery.riderId) {
      await firestore.collection('rideDrivers').doc(delivery.riderId).update({
        activeDeliveries: admin.firestore.FieldValue.increment(-1),
        updatedAt:        admin.firestore.FieldValue.serverTimestamp(),
      });
    }

    /* Notify buyer */
    if (delivery.buyerFcmToken) {
      const notif = SokoniLogistics.renderNotification('failed_delivery', {
        failReason:  reason,
        deliveryRef,
      });
      if (notif?.push) await _sendPush(delivery.buyerFcmToken, notif.push.title, notif.push.body);
    }

    functions.logger.warn('[dispatch] Failed delivery handled', { deliveryRef, reason, action: action.action, attempt: attemptCount + 1 });
    return { action: action.action, attemptsLeft: action.attemptsLeft || 0 };
  });

/* ─────────────────────────────────────────────────────────────
   6. detectGPSFraud (Firestore trigger)
   Flags suspicious GPS updates from rideDrivers.
──────────────────────────────────────────────────────────────*/
exports.detectGPSFraud = functions
  .region('europe-west1')
  .runWith({ timeoutSeconds: 30, memory: '128MB' })
  .firestore.document('rideDrivers/{riderId}')
  .onUpdate(async (change, ctx) => {
    const before = change.before.data() || {};
    const after  = change.after.data()  || {};
    const riderId = ctx.params.riderId;

    /* Only check if GPS changed */
    if (before.lat === after.lat && before.lng === after.lng) return null;

    const prev = { lat: before.lat, lng: before.lng, ts: before.updatedAt?.toMillis?.() || 0 };
    const curr = { lat: after.lat,  lng: after.lng,  ts: after.updatedAt?.toMillis?.()  || Date.now() };

    if (!curr.lat || !curr.lng) return null;

    const result = SokoniDispatch.checkGPSFraud(prev, curr);

    if (result.fraud) {
      const firestore = _db();
      await firestore.collection('fraudAlerts').add({
        type:        'gps_fraud',
        riderId,
        reason:      result.reason,
        speedKmH:    result.speedKmH || null,
        prevLat:     prev.lat,
        prevLng:     prev.lng,
        currLat:     curr.lat,
        currLng:     curr.lng,
        severity:    result.speedKmH > 200 ? 'critical' : 'high',
        status:      'open',
        createdAt:   admin.firestore.FieldValue.serverTimestamp(),
      });

      functions.logger.warn('[dispatch] GPS fraud detected', { riderId, reason: result.reason, speedKmH: result.speedKmH });
    }

    return null;
  });

/* ─────────────────────────────────────────────────────────────
   7. optimizeBatchRoute (callable)
   Returns TSP-optimized stop order for multi-delivery batching.
──────────────────────────────────────────────────────────────*/
exports.optimizeBatchRoute = functions
  .region('europe-west1')
  .runWith({ timeoutSeconds: 30, memory: '128MB' })
  .https.onCall(async (data, ctx) => {
    _assertAuth(ctx);
    const { riderLat, riderLng, deliveryRefs } = data;

    if (!riderLat || !riderLng || !deliveryRefs?.length) {
      throw new functions.https.HttpsError('invalid-argument', 'riderLat, riderLng, and deliveryRefs required');
    }
    if (deliveryRefs.length > SokoniDispatch.CFG.maxBatchSize) {
      throw new functions.https.HttpsError('invalid-argument', `Max batch size is ${SokoniDispatch.CFG.maxBatchSize}`);
    }

    const firestore = _db();
    const deliveries = await Promise.all(
      deliveryRefs.map(ref => firestore.collection('packageRequests').doc(ref).get()
        .then(s => s.exists ? Object.assign({ id: ref }, s.data()) : null))
    );
    const valid = deliveries.filter(Boolean);

    /* Build stops */
    const stops = [];
    valid.forEach(d => {
      stops.push({ id: d.id+'_pickup',  type:'pickup',  deliveryId:d.id,
                   lat:d.pickupLat||0,  lng:d.pickupLng||0,  label:d.pickupAddress||'Pickup' });
      stops.push({ id: d.id+'_dropoff', type:'dropoff', deliveryId:d.id,
                   lat:d.dropoffLat||(d.deliveryCoords?.lat||0), lng:d.dropoffLng||(d.deliveryCoords?.lng||0),
                   label:d.dropoffAddress||d.deliveryAddress||'Dropoff',
                   customerName:d.buyerName, customerPhone:d.buyerPhone });
    });

    const optimized = SokoniDispatch.optimizeStopOrder(riderLat, riderLng, stops);

    /* Compute total distance */
    let totalKm = 0;
    let prevLat = riderLat, prevLng = riderLng;
    optimized.forEach(s => {
      totalKm += SokoniDispatch.haversine(prevLat, prevLng, s.lat, s.lng);
      prevLat = s.lat; prevLng = s.lng;
    });

    return { stops: optimized, totalKm: Math.round(totalKm * 10) / 10 };
  });

/* ─────────────────────────────────────────────────────────────
   8. aggregateDeliveryAnalytics (scheduled — daily at 01:00)
   Rolls up yesterday's delivery data into analyticsRollup.
──────────────────────────────────────────────────────────────*/
exports.aggregateDeliveryAnalytics = functions
  .region('europe-west1')
  .runWith({ timeoutSeconds: 300, memory: '512MB' })
  .pubsub.schedule('0 1 * * *')
  .timeZone('Africa/Nairobi')
  .onRun(async () => {
    const firestore = _db();
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const dateStr = yesterday.toISOString().split('T')[0];
    const dayStart = new Date(dateStr + 'T00:00:00.000+03:00');
    const dayEnd   = new Date(dateStr + 'T23:59:59.999+03:00');

    const snap = await firestore.collection('packageRequests')
      .where('createdAt', '>=', dayStart)
      .where('createdAt', '<=', dayEnd)
      .get();

    const deliveries = snap.docs.map(d => d.data());
    const rollup = SokoniLogistics.buildDailyRollup(dateStr, deliveries);

    await firestore.collection('analyticsRollup').doc('delivery_' + dateStr).set({
      ...rollup,
      type:       'delivery',
      createdAt:  admin.firestore.FieldValue.serverTimestamp(),
    });

    /* Per-rider metrics for active riders today */
    const riderIds = [...new Set(deliveries.map(d => d.riderId || d.driverId).filter(Boolean))];
    const riderBatch = firestore.batch();
    riderIds.forEach(riderId => {
      const metrics = SokoniLogistics.computeRiderMetrics(riderId, deliveries);
      riderBatch.set(
        firestore.collection('riderMetrics').doc(riderId + '_' + dateStr),
        { ...metrics, date: dateStr, createdAt: admin.firestore.FieldValue.serverTimestamp() }
      );
    });
    if (riderIds.length) await riderBatch.commit();

    functions.logger.info('[dispatch] Daily delivery analytics aggregated', { date: dateStr, total: deliveries.length });
    return null;
  });
