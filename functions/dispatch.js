/* ================================================================
   SOKONI — Dispatch Cloud Functions  v2.0 (Gen2)
   8 CFs: intelligent dispatch, cascade timeouts, proof of delivery,
   failed delivery workflows, GPS fraud detection, analytics rollups.
================================================================ */
'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule }         = require('firebase-functions/v2/scheduler');
const { onDocumentUpdated }  = require('firebase-functions/v2/firestore');
const logger                 = require('firebase-functions/logger');
const admin                  = require('firebase-admin');
const SokoniDispatch         = require('./sokoni-dispatch');
const SokoniLogistics        = require('./sokoni-logistics');

const REGION = 'us-central1'; /* match the rest of the platform */

/* ─────────────────────────────────────────────────────────────
   HELPERS
──────────────────────────────────────────────────────────────*/
function _db()   { return admin.firestore(); }
function _now()  { return admin.firestore.FieldValue.serverTimestamp(); }
function _nowMs(){ return Date.now(); }

function _uid(request) { return request.auth?.uid || null; }
function _assertAuth(request) {
  if (!_uid(request)) throw new HttpsError('unauthenticated', 'Login required');
}

async function _sendPush(token, title, body, data) {
  if (!token) return;
  try { await admin.messaging().send({ token, notification: { title, body }, data: data || {} }); }
  catch(e) { console.warn('[dispatch] FCM push failed', e.message); }
}

async function _sendSMS(phone, message) {
  if (!phone) return;
  try { await _db().collection('smsQueue').add({ phone, message, createdAt: _now(), status: 'pending' }); }
  catch(e) { console.warn('[dispatch] SMS queue write failed', e.message); }
}

async function _sendEmail(to, subject, body) {
  if (!to) return;
  try {
    await _db().collection('emailQueue').add({ to, subject, body, createdAt: _now(), status: 'pending' });
  } catch(e) { console.warn('[dispatch] Email queue write failed', e.message); }
}

function _whatsappLink(phone, message) {
  if (!phone) return null;
  const cleaned = String(phone).replace(/\D/g,'').replace(/^0/,'254');
  return 'https://wa.me/'+cleaned+'?text='+encodeURIComponent(message);
}

async function _sendNotification(stage, delivery, deliveryRef) {
  const notif = SokoniLogistics.renderNotification(stage, {
    riderName:   delivery.driverName  || 'Your rider',
    riderPhone:  delivery.driverPhone || '',
    etaMin:      delivery.etaMin      || 20,
    otp:         delivery.deliveryOTP || '',
    trackUrl:    `https://mysokoni.co.ke/delivery-tracking.html?ref=${deliveryRef}`,
    orderId:     delivery.orderId     || deliveryRef,
    deliveryRef,
    failReason:  delivery.failReason  || '',
  });
  if (!notif) return;
  const { buyerFcmToken, buyerPhone, buyerEmail } = delivery;
  if (notif.push   && buyerFcmToken) await _sendPush(buyerFcmToken, notif.push.title, notif.push.body);
  if (notif.sms    && buyerPhone)    await _sendSMS(buyerPhone, notif.sms);
  if (notif.email  && buyerEmail)    await _sendEmail(buyerEmail, notif.email.subject, notif.email.body);
  /* WhatsApp: queue a deep-link record for the customer to tap */
  if (notif.whatsapp && buyerPhone) {
    await _db().collection('whatsappQueue').add({
      phone: buyerPhone, link: _whatsappLink(buyerPhone, notif.whatsapp),
      message: notif.whatsapp, deliveryRef, stage, createdAt: _now(), status: 'pending',
    }).catch(() => {});
  }
}

/* ─────────────────────────────────────────────────────────────
   1. dispatchDelivery (callable)
   Called by seller / system when order becomes ready_for_pickup.
──────────────────────────────────────────────────────────────*/
exports.dispatchDelivery = onCall(
  { region: REGION, timeoutSeconds: 60, memory: '256MiB', invoker: 'private', enforceAppCheck: true },
  async (request) => {
    _assertAuth(request);
    const { deliveryRef } = request.data;
    if (!deliveryRef) throw new HttpsError('invalid-argument', 'deliveryRef required');

    const firestore = _db();
    const deliverySnap = await firestore.collection('packageRequests').doc(deliveryRef).get();
    if (!deliverySnap.exists) throw new HttpsError('not-found', 'Delivery not found');
    const delivery = Object.assign({ id: deliveryRef }, deliverySnap.data());

    if (!['ready_for_pickup', 'pending'].includes(delivery.status)) {
      throw new HttpsError('failed-precondition', `Delivery status is "${delivery.status}", expected ready_for_pickup`);
    }

    const existingCascade = await firestore.collection('dispatchQueue').doc(deliveryRef).get();
    if (existingCascade.exists) {
      const st = existingCascade.data().status;
      if (st === 'offered' || st === 'accepted') return { status: st, cached: true };
    }

    const ridersSnap = await firestore.collection('rideDrivers').where('isOnline', '==', true).limit(100).get();
    const riders  = ridersSnap.docs.map(d => Object.assign({ uid: d.id }, d.data()));
    const ranked  = SokoniDispatch.rankRiders(riders, delivery);

    if (!ranked.length) {
      await firestore.collection('dispatchQueue').doc(deliveryRef).set({
        deliveryRef, rankedRiders: [], currentIndex: 0, attempts: [],
        status: 'exhausted', createdAt: _now(), updatedAt: _now(), exhaustedAt: _now(),
      });
      if (delivery.sellerFcmToken) {
        await _sendPush(delivery.sellerFcmToken, 'No Riders Available',
          "We could not find a rider for your delivery. We'll keep trying.");
      }
      return { status: 'exhausted', ranked: 0 };
    }

    const slimRanked = ranked.slice(0, 20).map(r => ({
      riderId: r.riderId, riderName: r.riderName, riderPhone: r.riderPhone,
      vehicleType: r.vehicleType, score: r.score, distKm: r.distKm, etaMin: r.etaMin,
    }));
    const cascade = SokoniDispatch.createCascadeState(slimRanked, deliveryRef);
    SokoniDispatch.recordOffer(cascade);

    await firestore.collection('dispatchQueue').doc(deliveryRef).set({
      ...cascade, createdAt: _now(), updatedAt: _now(),
      timeoutAt: new Date(_nowMs() + SokoniDispatch.CFG.dispatchTimeoutSec * 1000),
    });
    await firestore.collection('packageRequests').doc(deliveryRef).update({
      status: 'driver_assigned', assignedRiderId: ranked[0].riderId,
      assignedRiderName: ranked[0].riderName, assignedRiderPhone: ranked[0].riderPhone,
      dispatchScore: ranked[0].score, dispatchEtaMin: ranked[0].etaMin,
      dispatchDistKm: ranked[0].distKm, driverAssignedAt: _now(), updatedAt: _now(),
    });

    const riderDoc  = await firestore.collection('rideDrivers').doc(ranked[0].riderId).get();
    const riderData = riderDoc.data() || {};
    if (riderData.fcmToken) {
      await _sendPush(riderData.fcmToken, 'New Delivery Request',
        `Pickup: ${delivery.pickupAddress || 'Seller'}. Fee: KES ${delivery.deliveryFee || 0}. ${ranked[0].etaMin} min away.`,
        { deliveryRef, action: 'dispatch_offer' });
    }
    if (riderData.phone) {
      await _sendSMS(riderData.phone,
        `SOKONI: New delivery! Pickup: ${delivery.pickupAddress || 'N/A'}. Fee: KES ${delivery.deliveryFee || 0}. Accept in 90s on your app.`);
    }
    /* Multi-channel buyer notification: push + SMS + email + WhatsApp */
    await _sendNotification('driver_assigned', {
      ...delivery,
      driverName:   ranked[0].riderName,
      driverPhone:  ranked[0].riderPhone,
      etaMin:       ranked[0].etaMin,
    }, deliveryRef).catch(() => {});

    logger.info('[dispatch] Dispatch initiated', { deliveryRef, riderId: ranked[0].riderId, score: ranked[0].score });
    return { status: 'offered', riderId: ranked[0].riderId, etaMin: ranked[0].etaMin, ranked: ranked.length };
  }
);

/* ─────────────────────────────────────────────────────────────
   2. respondToDispatch (callable) — rider accepts / declines
──────────────────────────────────────────────────────────────*/
exports.respondToDispatch = onCall(
  { region: REGION, timeoutSeconds: 30, memory: '128MiB', invoker: 'private', enforceAppCheck: true },
  async (request) => {
    _assertAuth(request);
    const riderId = _uid(request);
    const { deliveryRef, accept } = request.data;
    if (!deliveryRef) throw new HttpsError('invalid-argument', 'deliveryRef required');

    const firestore   = _db();
    const cascadeRef  = firestore.collection('dispatchQueue').doc(deliveryRef);
    const cascadeSnap = await cascadeRef.get();
    if (!cascadeSnap.exists) throw new HttpsError('not-found', 'Dispatch queue entry not found');

    const cascade = cascadeSnap.data();
    if (cascade.status !== 'offered') throw new HttpsError('failed-precondition', `Dispatch already ${cascade.status}`);

    const current = SokoniDispatch.getCurrentCandidate(cascade);
    if (!current || current.riderId !== riderId) throw new HttpsError('permission-denied', 'You are not the current dispatch candidate');

    if (accept) {
      SokoniDispatch.acceptCascade(cascade, riderId);
      await cascadeRef.update({ ...cascade, updatedAt: _now() });
      await firestore.collection('packageRequests').doc(deliveryRef).update({
        status: 'driver_accepted', riderId, riderAcceptedAt: _now(), updatedAt: _now(),
      });
      await firestore.collection('rideDrivers').doc(riderId).update({
        activeDeliveries: admin.firestore.FieldValue.increment(1), updatedAt: _now(),
      });
      const deliverySnap = await firestore.collection('packageRequests').doc(deliveryRef).get();
      const delivery = deliverySnap.data() || {};
      if (delivery.buyerFcmToken) {
        await _sendPush(delivery.buyerFcmToken, 'Rider Accepted!', 'Your rider has accepted the delivery and is on their way.');
      }
      logger.info('[dispatch] Rider accepted', { deliveryRef, riderId });
      return { status: 'accepted' };
    } else {
      SokoniDispatch.advanceCascade(cascade, 'declined');
      if (cascade.status === 'exhausted') {
        await cascadeRef.update({ ...cascade, updatedAt: _now(), exhaustedAt: _now() });
        logger.warn('[dispatch] Cascade exhausted after decline', { deliveryRef });
        return { status: 'exhausted' };
      }
      SokoniDispatch.recordOffer(cascade);
      await cascadeRef.update({
        ...cascade, updatedAt: _now(),
        timeoutAt: new Date(_nowMs() + SokoniDispatch.CFG.dispatchTimeoutSec * 1000),
      });
      const nextRider = SokoniDispatch.getCurrentCandidate(cascade);
      if (nextRider) {
        const riderDoc  = await firestore.collection('rideDrivers').doc(nextRider.riderId).get();
        const riderData = riderDoc.data() || {};
        if (riderData.fcmToken) {
          const delivery = (await firestore.collection('packageRequests').doc(deliveryRef).get()).data() || {};
          await _sendPush(riderData.fcmToken, 'New Delivery Request',
            `Pickup: ${delivery.pickupAddress || 'Seller'}. Fee: KES ${delivery.deliveryFee || 0}.`,
            { deliveryRef, action: 'dispatch_offer' });
        }
      }
      logger.info('[dispatch] Rider declined, advanced', { deliveryRef, riderId, newIndex: cascade.currentIndex });
      return { status: 'advanced', nextRider: nextRider?.riderId || null };
    }
  }
);

/* ─────────────────────────────────────────────────────────────
   3. processCascadeTimeouts (scheduled — every 1 minute)
──────────────────────────────────────────────────────────────*/
exports.processCascadeTimeouts = onSchedule(
  { schedule: 'every 1 minutes', region: REGION, timeoutSeconds: 120, memory: '256MiB' },
  async () => {
    const firestore = _db();
    const now  = new Date();
    const snap = await firestore.collection('dispatchQueue')
      .where('status', '==', 'offered').where('timeoutAt', '<=', now).limit(50).get();
    if (snap.empty) return;

    const batch         = firestore.batch();
    const notifications = [];

    for (const doc of snap.docs) {
      const cascade = doc.data();
      SokoniDispatch.advanceCascade(cascade, 'timeout');
      if (cascade.status === 'exhausted') {
        batch.update(doc.ref, { ...cascade, updatedAt: _now(), exhaustedAt: _now() });
        notifications.push({ deliveryRef: cascade.deliveryRef, action: 'exhausted' });
      } else {
        SokoniDispatch.recordOffer(cascade);
        batch.update(doc.ref, {
          ...cascade, updatedAt: _now(),
          timeoutAt: new Date(Date.now() + SokoniDispatch.CFG.dispatchTimeoutSec * 1000),
        });
        notifications.push({ deliveryRef: cascade.deliveryRef, action: 'next_rider', nextRider: SokoniDispatch.getCurrentCandidate(cascade) });
      }
    }
    await batch.commit();

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
        } catch(e) { console.warn('[dispatch] Timeout notification error', e.message); }
      }
    }
    logger.info('[dispatch] Processed cascade timeouts', { count: snap.size });
  }
);

/* ─────────────────────────────────────────────────────────────
   4. captureProofOfDelivery (callable) — OTP + photo + GPS
──────────────────────────────────────────────────────────────*/
exports.captureProofOfDelivery = onCall(
  { region: REGION, timeoutSeconds: 30, memory: '128MiB', invoker: 'private', enforceAppCheck: true },
  async (request) => {
    _assertAuth(request);
    const riderId = _uid(request);
    const { deliveryRef, otp, qrVerified, photoUrl, signatureDataUrl, gpsLat, gpsLng, gpsAccuracyM } = request.data;
    if (!deliveryRef) throw new HttpsError('invalid-argument', 'deliveryRef required');

    const firestore    = _db();
    const deliverySnap = await firestore.collection('packageRequests').doc(deliveryRef).get();
    if (!deliverySnap.exists) throw new HttpsError('not-found', 'Delivery not found');
    const delivery = deliverySnap.data();

    if (delivery.riderId !== riderId && delivery.driverId !== riderId) {
      throw new HttpsError('permission-denied', 'You are not assigned to this delivery');
    }

    /* Accept QR verified as equivalent to OTP verified for proof requirements */
    const proofOtp = (qrVerified === true) ? (delivery.deliveryOTP || otp || '') : otp;
    const requiredMethods = delivery.proofRequirements || ['otp'];
    const proofResult = SokoniLogistics.validateProof(
      { otp: proofOtp, photoUrl, gpsLat, gpsLng, signatureDataUrl },
      {
        otp:        delivery.deliveryOTP,
        dropoffLat: delivery.dropoffLat || delivery.deliveryCoords?.lat,
        dropoffLng: delivery.dropoffLng || delivery.deliveryCoords?.lng,
        requiredMethods,
      }
    );
    if (!proofResult.valid) throw new HttpsError('failed-precondition', proofResult.error);

    const proofRecord = SokoniLogistics.buildProofRecord(deliveryRef, riderId, {
      otp, photoUrl, gpsLat, gpsLng, gpsAccuracyM, signatureDataUrl: signatureDataUrl || null,
      qrVerified: qrVerified === true,
    });
    const batchOp = firestore.batch();
    batchOp.set(firestore.collection('deliveryProofs').doc(deliveryRef), { ...proofRecord, createdAt: _now() });
    batchOp.update(firestore.collection('packageRequests').doc(deliveryRef), {
      status:           'delivered',
      deliveredAt:      _now(),
      proofCaptured:    true,
      proofPhotoUrl:    photoUrl       || null,
      proofSignatureUrl:signatureDataUrl || null,
      proofQrVerified:  qrVerified === true,
      proofGpsLat:      gpsLat         || null,
      proofGpsLng:      gpsLng         || null,
      sellerPayoutReady:true,
      updatedAt:        _now(),
    });
    batchOp.update(firestore.collection('rideDrivers').doc(riderId), {
      activeDeliveries: admin.firestore.FieldValue.increment(-1),
      totalDeliveries:  admin.firestore.FieldValue.increment(1),
      totalEarnings:    admin.firestore.FieldValue.increment(delivery.driverNet || 0),
      updatedAt:        _now(),
    });
    await batchOp.commit();

    /* Unified multi-channel notification (push + SMS + email + WhatsApp) */
    await _sendNotification('delivered', delivery, deliveryRef);

    logger.info('[dispatch] Proof captured, delivery complete', { deliveryRef, riderId, qrVerified: !!qrVerified, hasSig: !!signatureDataUrl });
    return { status: 'delivered' };
  }
);

/* ─────────────────────────────────────────────────────────────
   5. handleFailedDelivery (callable) — retry / return / refund
──────────────────────────────────────────────────────────────*/
exports.handleFailedDelivery = onCall(
  { region: REGION, timeoutSeconds: 30, memory: '128MiB', invoker: 'private', enforceAppCheck: true },
  async (request) => {
    _assertAuth(request);
    const { deliveryRef, reason, note } = request.data;
    if (!deliveryRef || !reason) throw new HttpsError('invalid-argument', 'deliveryRef and reason required');

    const firestore    = _db();
    const deliverySnap = await firestore.collection('packageRequests').doc(deliveryRef).get();
    if (!deliverySnap.exists) throw new HttpsError('not-found', 'Delivery not found');
    const delivery = deliverySnap.data();

    const attemptsSnap = await firestore.collection('deliveryAttempts').where('deliveryRef', '==', deliveryRef).get();
    const attemptCount = attemptsSnap.size;

    await firestore.collection('deliveryAttempts').add({
      deliveryRef, reason, note: note || null,
      riderId: delivery.riderId || null,
      attemptAt: _now(), attemptNumber: attemptCount + 1,
    });

    const action  = SokoniDispatch.getFailedDeliveryAction(reason, attemptCount);
    const updates = { failReason: reason, failNote: note || null, lastFailedAt: _now(), failAction: action.action, updatedAt: _now() };

    if (action.action === 'retry')      { updates.status = 'retry_scheduled'; updates.retryAfter = new Date(Date.now() + (action.retryAfterMin || 30) * 60000); updates.retryCount = admin.firestore.FieldValue.increment(1); }
    else if (action.action === 'reassign') { updates.status = 'ready_for_pickup'; updates.riderId = null; updates.driverId = null; }
    else if (action.action === 'return')   { updates.status = 'return_in_progress'; }
    else if (action.action === 'refund')   { updates.status = 'refund_initiated'; }
    else { updates.status = 'support_required'; updates.escalated = true; }

    await firestore.collection('packageRequests').doc(deliveryRef).update(updates);

    if (action.action === 'reassign' && delivery.riderId) {
      await firestore.collection('rideDrivers').doc(delivery.riderId).update({
        activeDeliveries: admin.firestore.FieldValue.increment(-1), updatedAt: _now(),
      });
    }

    /* Multi-channel customer notification */
    await _sendNotification('failed_delivery', { ...delivery, failReason: reason }, deliveryRef).catch(() => {});

    /* ── Excessive cancellation detection ── */
    const riderId = delivery.riderId || delivery.driverId;
    if (riderId && reason === 'rider_breakdown') {
      /* Count cancellations for this rider in last 24h */
      const since24h = new Date(Date.now() - 86400000);
      const recentSnap = await firestore.collection('deliveryAttempts')
        .where('riderId', '==', riderId)
        .where('attemptAt', '>=', since24h)
        .get()
        .catch(() => null);
      if (recentSnap && recentSnap.size >= 5) {
        /* Flag for excessive cancellations */
        await firestore.collection('fraudAlerts').add({
          type:      'excessive_cancellations',
          riderId,
          count:     recentSnap.size,
          windowH:   24,
          threshold: 5,
          severity:  recentSnap.size >= 10 ? 'critical' : 'high',
          status:    'open',
          reason:    `${recentSnap.size} cancellations in last 24h (threshold: 5)`,
          createdAt: _now(),
        });
        /* Auto-suspend if 10+ in 24h */
        if (recentSnap.size >= 10) {
          await firestore.collection('rideDrivers').doc(riderId).update({
            isOnline: false, status: 'suspended',
            suspendedAt: _now(), suspendReason: 'auto_excessive_cancellations',
          }).catch(() => {});
          logger.warn('[dispatch] Rider auto-suspended for excessive cancellations', { riderId, count: recentSnap.size });
        }
      }
    }

    /* Return/refund notifications */
    if (action.action === 'return')  await _sendNotification('return_initiated',  delivery, deliveryRef).catch(() => {});
    if (action.action === 'refund')  await _sendNotification('refund_initiated',  delivery, deliveryRef).catch(() => {});

    logger.warn('[dispatch] Failed delivery handled', { deliveryRef, reason, action: action.action, attempt: attemptCount + 1 });
    return { action: action.action, attemptsLeft: action.attemptsLeft || 0 };
  }
);

/* ─────────────────────────────────────────────────────────────
   6. detectGPSFraud (Firestore trigger on rideDrivers updates)
──────────────────────────────────────────────────────────────*/
exports.detectGPSFraud = onDocumentUpdated(
  { document: 'rideDrivers/{riderId}', region: REGION, timeoutSeconds: 30, memory: '128MiB' },
  async (event) => {
    const before  = event.data.before.data() || {};
    const after   = event.data.after.data()  || {};
    const riderId = event.params.riderId;

    if (before.lat === after.lat && before.lng === after.lng) return null;

    const prev = { lat: before.lat, lng: before.lng, ts: before.updatedAt?.toMillis?.() || 0 };
    const curr = { lat: after.lat,  lng: after.lng,  ts: after.updatedAt?.toMillis?.()  || Date.now() };
    if (!curr.lat || !curr.lng) return null;

    const result = SokoniDispatch.checkGPSFraud(prev, curr);
    if (result.fraud) {
      await _db().collection('fraudAlerts').add({
        type: 'gps_fraud', riderId, reason: result.reason, speedKmH: result.speedKmH || null,
        prevLat: prev.lat, prevLng: prev.lng, currLat: curr.lat, currLng: curr.lng,
        severity: result.speedKmH > 200 ? 'critical' : 'high',
        status: 'open', createdAt: _now(),
      });
      logger.warn('[dispatch] GPS fraud detected', { riderId, reason: result.reason, speedKmH: result.speedKmH });
    }
    return null;
  }
);

/* ─────────────────────────────────────────────────────────────
   7. optimizeBatchRoute (callable) — TSP stop ordering
──────────────────────────────────────────────────────────────*/
exports.optimizeBatchRoute = onCall(
  { region: REGION, timeoutSeconds: 30, memory: '128MiB', invoker: 'private', enforceAppCheck: true },
  async (request) => {
    _assertAuth(request);
    const { riderLat, riderLng, deliveryRefs } = request.data;
    if (!riderLat || !riderLng || !deliveryRefs?.length) {
      throw new HttpsError('invalid-argument', 'riderLat, riderLng, and deliveryRefs required');
    }
    if (deliveryRefs.length > SokoniDispatch.CFG.maxBatchSize) {
      throw new HttpsError('invalid-argument', `Max batch size is ${SokoniDispatch.CFG.maxBatchSize}`);
    }

    const firestore  = _db();
    const deliveries = await Promise.all(
      deliveryRefs.map(ref => firestore.collection('packageRequests').doc(ref).get()
        .then(s => s.exists ? Object.assign({ id: ref }, s.data()) : null))
    );
    const valid = deliveries.filter(Boolean);
    const stops = [];
    valid.forEach(d => {
      stops.push({ id: d.id + '_pickup',  type: 'pickup',  deliveryId: d.id, lat: d.pickupLat || 0,  lng: d.pickupLng || 0,  label: d.pickupAddress || 'Pickup' });
      stops.push({ id: d.id + '_dropoff', type: 'dropoff', deliveryId: d.id, lat: d.dropoffLat || (d.deliveryCoords?.lat || 0), lng: d.dropoffLng || (d.deliveryCoords?.lng || 0), label: d.dropoffAddress || d.deliveryAddress || 'Dropoff', customerName: d.buyerName, customerPhone: d.buyerPhone });
    });
    const optimized = SokoniDispatch.optimizeStopOrder(riderLat, riderLng, stops);
    let totalKm = 0, prevLat = riderLat, prevLng = riderLng;
    optimized.forEach(s => { totalKm += SokoniDispatch.haversine(prevLat, prevLng, s.lat, s.lng); prevLat = s.lat; prevLng = s.lng; });
    return { stops: optimized, totalKm: Math.round(totalKm * 10) / 10 };
  }
);

/* ─────────────────────────────────────────────────────────────
   8. aggregateDeliveryAnalytics (scheduled — daily 01:00 EAT)
──────────────────────────────────────────────────────────────*/
exports.aggregateDeliveryAnalytics = onSchedule(
  { schedule: '0 1 * * *', timeZone: 'Africa/Nairobi', region: REGION, timeoutSeconds: 300, memory: '512MiB' },
  async () => {
    const firestore = _db();
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const dateStr  = yesterday.toISOString().split('T')[0];
    const dayStart = new Date(dateStr + 'T00:00:00.000+03:00');
    const dayEnd   = new Date(dateStr + 'T23:59:59.999+03:00');

    const snap = await firestore.collection('packageRequests')
      .where('createdAt', '>=', dayStart).where('createdAt', '<=', dayEnd).get();
    const deliveries = snap.docs.map(d => d.data());
    const rollup     = SokoniLogistics.buildDailyRollup(dateStr, deliveries);

    await firestore.collection('analyticsRollup').doc('delivery_' + dateStr).set({
      ...rollup, type: 'delivery', createdAt: _now(),
    });

    const riderIds   = [...new Set(deliveries.map(d => d.riderId || d.driverId).filter(Boolean))];
    const riderBatch = firestore.batch();
    riderIds.forEach(riderId => {
      const metrics = SokoniLogistics.computeRiderMetrics(riderId, deliveries);
      riderBatch.set(
        firestore.collection('riderMetrics').doc(riderId + '_' + dateStr),
        { ...metrics, date: dateStr, createdAt: _now() }
      );
    });
    if (riderIds.length) await riderBatch.commit();
    logger.info('[dispatch] Daily analytics aggregated', { date: dateStr, total: deliveries.length });
  }
);
