/* ================================================================
   SOKONI — Logistics Engine  v1.0
   Hub registry management, delivery batch state, analytics
   rollups, and proof-of-delivery helpers.

   Exposes: window.SokoniLogistics  +  module.exports (CF use)
================================================================ */
(function (g) {
  'use strict';

  /* ─────────────────────────────────────────────────────────────
     HUB REGISTRY
  ──────────────────────────────────────────────────────────────*/
  /* Hub types: pickup_hub, distribution_hub, dark_store, cross_dock */
  var HUB_TYPES = {
    pickup_hub:       { label:'Pickup Hub',        icon:'📦', description:'Seller drop-off point for parcels' },
    distribution_hub: { label:'Distribution Hub',  icon:'🏭', description:'Sorts parcels for onward delivery' },
    dark_store:       { label:'Dark Store',         icon:'🌙', description:'Inventory-holding micro-warehouse' },
    cross_dock:       { label:'Cross-Dock',         icon:'🔄', description:'In-transit transfer between zones' },
  };

  /*
   * registerHub(hub) → void
   * Adds to in-memory hub registry (used client-side).
   * hub: { id, type, name, lat, lng, zone, active, capacity }
   */
  var _hubRegistry = {};
  function registerHub(hub) {
    if (!hub || !hub.id) return;
    _hubRegistry[hub.id] = Object.assign({ active: true, capacity: 1000 }, hub);
  }

  function getHub(hubId) {
    return _hubRegistry[hubId] || null;
  }

  function getActiveHubs(type) {
    return Object.values(_hubRegistry).filter(function (h) {
      return h.active && (!type || h.type === type);
    });
  }

  function loadHubsFromFirestore(db) {
    if (!db) return Promise.resolve([]);
    return db.collection('deliveryHubs')
             .where('active', '==', true)
             .get()
             .then(function (snap) {
               snap.docs.forEach(function (d) { registerHub(Object.assign({ id: d.id }, d.data())); });
               return getActiveHubs();
             });
  }

  /* ─────────────────────────────────────────────────────────────
     BATCH DELIVERY STATE
  ──────────────────────────────────────────────────────────────*/
  /*
   * createBatch(riderId, deliveries[]) → BatchState
   * deliveries: [{ id, pickupLat, pickupLng, dropoffLat, dropoffLng,
   *               pickupAddress, dropoffAddress, customerName, customerPhone }]
   */
  function createBatch(riderId, deliveries) {
    var stops = [];
    deliveries.forEach(function (d) {
      stops.push({ id: d.id + '_pickup',  type:'pickup',  lat:d.pickupLat,  lng:d.pickupLng,
                   deliveryId:d.id, label:d.pickupAddress  || 'Pickup',  phone:null });
      stops.push({ id: d.id + '_dropoff', type:'dropoff', lat:d.dropoffLat, lng:d.dropoffLng,
                   deliveryId:d.id, label:d.dropoffAddress || 'Dropoff', phone:d.customerPhone,
                   customerName:d.customerName });
    });
    return {
      batchId:     'batch_' + Date.now(),
      riderId:     riderId,
      deliveries:  deliveries.map(function (d) { return d.id; }),
      stops:       stops,
      currentStop: 0,
      completedStops: [],
      status:      'active',
      createdAt:   Date.now(),
    };
  }

  function getCurrentStop(batch) {
    if (!batch || batch.currentStop >= batch.stops.length) return null;
    return batch.stops[batch.currentStop];
  }

  function advanceBatchStop(batch, stopId) {
    batch.completedStops.push({ stopId, completedAt: Date.now() });
    batch.currentStop++;
    if (batch.currentStop >= batch.stops.length) {
      batch.status = 'completed';
    }
    return batch;
  }

  /* ─────────────────────────────────────────────────────────────
     PROOF OF DELIVERY
  ──────────────────────────────────────────────────────────────*/
  /* OTP generation: 6-digit numeric, never starts with 0 */
  function generateOTP() {
    return String(100000 + Math.floor(Math.random() * 900000));
  }

  /*
   * validateProof(proof, expected) → { valid, error? }
   * proof:    { otp?, photoUrl?, gpsLat?, gpsLng?, signatureDataUrl? }
   * expected: { otp, dropoffLat, dropoffLng, requiredMethods: ['otp'|'photo'|'gps'|'signature'] }
   */
  function validateProof(proof, expected) {
    var errors = [];
    var methods = expected.requiredMethods || ['otp'];

    if (methods.includes('otp')) {
      if (!proof.otp) { errors.push('OTP required'); }
      else if (String(proof.otp).trim() !== String(expected.otp)) { errors.push('Incorrect OTP'); }
    }

    if (methods.includes('photo')) {
      if (!proof.photoUrl) errors.push('Delivery photo required');
    }

    if (methods.includes('gps')) {
      if (!proof.gpsLat || !proof.gpsLng) {
        errors.push('GPS location required');
      } else {
        /* Must be within 500 m of dropoff */
        var haversine = g.SokoniDispatch ? g.SokoniDispatch.haversine : _haversine;
        var distKm = haversine(proof.gpsLat, proof.gpsLng, expected.dropoffLat, expected.dropoffLng);
        if (distKm > 0.5) errors.push('GPS location too far from delivery address (' + Math.round(distKm * 1000) + ' m away)');
      }
    }

    if (methods.includes('signature')) {
      if (!proof.signatureDataUrl) errors.push('Signature required');
    }

    return errors.length ? { valid: false, error: errors.join('; ') } : { valid: true };
  }

  /* Fallback haversine if SokoniDispatch not loaded */
  function _haversine(lat1, lng1, lat2, lng2) {
    var R = 6371;
    var dL = (lat2-lat1)*Math.PI/180, dG = (lng2-lng1)*Math.PI/180;
    var a = Math.sin(dL/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dG/2)**2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  }

  /*
   * buildProofRecord(deliveryRef, riderId, proof, validatedAt)
   * Returns the Firestore document to save in deliveryProofs/{deliveryRef}
   */
  function buildProofRecord(deliveryRef, riderId, proof) {
    return {
      deliveryRef:    deliveryRef,
      riderId:        riderId,
      otp:            proof.otp            || null,
      photoUrl:       proof.photoUrl       || null,
      signatureUrl:   proof.signatureDataUrl || null,
      gpsLat:         proof.gpsLat         || null,
      gpsLng:         proof.gpsLng         || null,
      gpsAccuracyM:   proof.gpsAccuracyM   || null,
      capturedAt:     Date.now(),
      deviceInfo:     {
        ua:        (typeof navigator !== 'undefined' ? navigator.userAgent : 'CF').slice(0, 200),
        platform:  (typeof navigator !== 'undefined' ? navigator.platform  : 'server'),
      },
    };
  }

  /* ─────────────────────────────────────────────────────────────
     DELIVERY ANALYTICS
  ──────────────────────────────────────────────────────────────*/
  /*
   * buildDailyRollup(date, deliveries[]) → DailyRollup
   * deliveries: array of packageRequests docs for that date
   */
  function buildDailyRollup(date, deliveries) {
    var total     = deliveries.length;
    var completed = deliveries.filter(function (d) { return d.status === 'delivered' || d.status === 'buyer_confirmed'; }).length;
    var failed    = deliveries.filter(function (d) { return d.status === 'failed' || d.status === 'returned'; }).length;
    var revenue   = deliveries.reduce(function (s, d) { return s + (d.deliveryFee || 0); }, 0);
    var riderPay  = deliveries.reduce(function (s, d) { return s + (d.driverNet || 0); }, 0);
    var times     = deliveries
                      .filter(function (d) { return d.createdAt && d.deliveredAt; })
                      .map(function (d) {
                        var c = d.createdAt.toDate ? d.createdAt.toDate() : new Date(d.createdAt);
                        var e = d.deliveredAt.toDate ? d.deliveredAt.toDate() : new Date(d.deliveredAt);
                        return (e - c) / 60000;
                      });
    var avgTimeMin = times.length ? (times.reduce(function (a, b) { return a + b; }, 0) / times.length) : 0;

    /* By vehicle type */
    var byVehicle = {};
    deliveries.forEach(function (d) {
      var v = d.vehicleType || 'moto';
      if (!byVehicle[v]) byVehicle[v] = { count: 0, revenue: 0 };
      byVehicle[v].count++;
      byVehicle[v].revenue += (d.deliveryFee || 0);
    });

    /* By zone/area (if available) */
    var byZone = {};
    deliveries.forEach(function (d) {
      var z = d.zone || d.deliveryZone || 'unknown';
      if (!byZone[z]) byZone[z] = 0;
      byZone[z]++;
    });

    return {
      date:           date,
      total:          total,
      completed:      completed,
      failed:         failed,
      successRate:    total ? Math.round((completed / total) * 100) : 0,
      revenue:        Math.round(revenue),
      riderPay:       Math.round(riderPay),
      platformCut:    Math.round(revenue - riderPay),
      avgTimeMin:     Math.round(avgTimeMin),
      byVehicle:      byVehicle,
      byZone:         byZone,
      createdAt:      Date.now(),
    };
  }

  /*
   * computeRiderMetrics(riderId, deliveries[]) → RiderMetrics
   */
  function computeRiderMetrics(riderId, deliveries) {
    var mine      = deliveries.filter(function (d) { return d.riderId === riderId || d.driverId === riderId; });
    var completed = mine.filter(function (d) { return d.status === 'delivered' || d.status === 'buyer_confirmed'; });
    var cancelled = mine.filter(function (d) { return d.status === 'cancelled'; });
    var failed    = mine.filter(function (d) { return d.status === 'failed'; });
    var earnings  = mine.reduce(function (s, d) { return s + (d.driverNet || 0); }, 0);
    var ratings   = mine.filter(function (d) { return d.riderRating; }).map(function (d) { return d.riderRating; });
    var avgRating = ratings.length ? (ratings.reduce(function (a,b){ return a+b; },0) / ratings.length) : 5.0;

    return {
      riderId:        riderId,
      total:          mine.length,
      completed:      completed.length,
      cancelled:      cancelled.length,
      failed:         failed.length,
      completionRate: mine.length ? Math.round((completed.length / mine.length) * 100) / 100 : 1,
      cancellationRate:mine.length ? Math.round((cancelled.length / mine.length) * 100) / 100 : 0,
      earnings:       Math.round(earnings),
      avgRating:      Math.round(avgRating * 10) / 10,
      updatedAt:      Date.now(),
    };
  }

  /* ─────────────────────────────────────────────────────────────
     INCENTIVES ENGINE
  ──────────────────────────────────────────────────────────────*/
  var INCENTIVE_TIERS = [
    { deliveries: 5,  bonus: 100, label:'5 deliveries'  },
    { deliveries: 10, bonus: 250, label:'10 deliveries' },
    { deliveries: 20, bonus: 600, label:'20 deliveries' },
    { deliveries: 30, bonus: 1000,label:'30 deliveries' },
  ];

  /*
   * computeIncentives(todayDeliveries, todayEarnings) → IncentiveStatus
   */
  function computeIncentives(todayDeliveries, todayEarnings) {
    var earned = [];
    var next   = null;
    INCENTIVE_TIERS.forEach(function (tier) {
      if (todayDeliveries >= tier.deliveries) {
        earned.push(tier);
      } else if (!next) {
        next = Object.assign({ remaining: tier.deliveries - todayDeliveries }, tier);
      }
    });
    var totalBonus = earned.reduce(function (s, t) { return s + t.bonus; }, 0);
    return {
      todayDeliveries: todayDeliveries,
      todayEarnings:   todayEarnings,
      totalBonus:      totalBonus,
      totalWithBonus:  todayEarnings + totalBonus,
      earnedTiers:     earned,
      nextTier:        next,
    };
  }

  /* ─────────────────────────────────────────────────────────────
     STATUS NOTIFICATION TEMPLATES
  ──────────────────────────────────────────────────────────────*/
  var NOTIFICATION_TEMPLATES = {
    driver_assigned: {
      push:     function (d) { return { title: 'Rider Assigned', body: d.riderName + ' is on the way to collect your order. ETA: ' + d.etaMin + ' min.' }; },
      sms:      function (d) { return 'SOKONI: ' + d.riderName + ' is picking up your order. Track: ' + d.trackUrl; },
      email:    function (d) { return { subject: 'Rider Assigned — Order #' + d.orderId, body: 'Your rider ' + d.riderName + ' (' + d.riderPhone + ') is on the way. ETA: ~' + d.etaMin + ' minutes.\n\nTrack live: ' + d.trackUrl }; },
      whatsapp: function (d) { return 'Hi! Your SOKONI delivery has a rider assigned. ' + d.riderName + ' will collect your order soon. ETA: ~' + d.etaMin + ' min. Track here: ' + d.trackUrl; },
    },
    driver_at_seller: {
      push:     function (d) { return { title: 'Parcel Collected', body: d.riderName + ' has collected your parcel and is heading to you.' }; },
      sms:      function ()  { return 'SOKONI: Your parcel has been picked up and is on its way!'; },
      whatsapp: function (d) { return 'Great news! Your SOKONI order has been collected by ' + d.riderName + ' and is heading your way!'; },
    },
    in_transit: {
      push:     function (d) { return { title: 'Out for Delivery', body: 'Your order is on the way. ETA: ' + d.etaMin + ' min.' }; },
      sms:      function (d) { return 'SOKONI: Your order is out for delivery. ETA ~' + d.etaMin + ' min. Track: ' + d.trackUrl; },
      email:    function (d) { return { subject: 'Your Order is Out for Delivery', body: 'Your order is on its way! Estimated arrival: ~' + d.etaMin + ' minutes.\n\nTrack live: ' + d.trackUrl }; },
      whatsapp: function (d) { return 'Your SOKONI order is out for delivery! Estimated arrival: ~' + d.etaMin + ' min. Track here: ' + d.trackUrl; },
    },
    arriving: {
      push:     function ()  { return { title: 'Almost There!', body: 'Your rider is arriving now. Please be ready to receive your order.' }; },
      sms:      function ()  { return 'SOKONI: Your rider is arriving! Please be ready.'; },
      whatsapp: function ()  { return 'Your SOKONI rider is almost at your door! Please be ready to receive your order.'; },
    },
    delivered: {
      push:     function (d) { return { title: 'Order Delivered!', body: 'Your order has been delivered. Use OTP ' + d.otp + ' to confirm receipt.' }; },
      sms:      function (d) { return 'SOKONI: Your order is delivered! Confirm receipt with OTP: ' + d.otp + '. Do NOT share this code with anyone else.'; },
      email:    function (d) { return { subject: 'Your Order Has Been Delivered!', body: 'Your SOKONI order has been delivered. Please confirm receipt using OTP: ' + d.otp + '\n\nDo NOT share this code. It confirms your delivery.' }; },
      whatsapp: function (d) { return 'Your SOKONI order has been delivered! Please give your rider this OTP to confirm receipt: *' + d.otp + '*\n\nKeep this code private.'; },
    },
    failed_delivery: {
      push:     function (d) { return { title: 'Delivery Attempt Failed', body: d.failReason + '. We will contact you shortly.' }; },
      sms:      function (d) { return 'SOKONI: Delivery attempt failed (' + d.failReason + '). Our team will assist. Ref: ' + d.deliveryRef; },
      email:    function (d) { return { subject: 'Delivery Attempt Failed — Action Required', body: 'We could not complete your delivery. Reason: ' + d.failReason + '\n\nRef: ' + d.deliveryRef + '\n\nOur support team will contact you.' }; },
      whatsapp: function (d) { return 'SOKONI: We were unable to deliver your order. Reason: ' + d.failReason + '. Ref: ' + d.deliveryRef + '. Our team will contact you shortly to resolve this.'; },
    },
    return_initiated: {
      push:     function (d) { return { title: 'Order Being Returned', body: 'Your order is being returned to the seller. A refund will be processed.' }; },
      sms:      function (d) { return 'SOKONI: Your order ' + d.deliveryRef + ' is being returned. Refund will follow.'; },
    },
    refund_initiated: {
      push:     function ()  { return { title: 'Refund Initiated', body: 'A refund has been initiated for your order. You will receive it within 3-5 business days.' }; },
      sms:      function (d) { return 'SOKONI: Refund initiated for order ' + d.deliveryRef + '. Allow 3-5 business days for M-Pesa reversal.'; },
    },
  };

  /*
   * renderNotification(stage, data) → { push?, sms?, email?, whatsapp? }
   */
  function renderNotification(stage, data) {
    var tpl = NOTIFICATION_TEMPLATES[stage];
    if (!tpl) return null;
    return {
      push:     tpl.push     ? tpl.push(data)     : null,
      sms:      tpl.sms      ? tpl.sms(data)      : null,
      email:    tpl.email    ? tpl.email(data)    : null,
      whatsapp: tpl.whatsapp ? tpl.whatsapp(data) : null,
    };
  }

  /*
   * whatsappDeepLink(phone, message) → URL
   * Opens WhatsApp chat with pre-filled message (wa.me deep link).
   */
  function whatsappDeepLink(phone, message) {
    var cleaned = String(phone || '').replace(/\D/g, '');
    /* Normalize Kenyan number to international format */
    if (cleaned.startsWith('0') && cleaned.length === 10) cleaned = '254' + cleaned.slice(1);
    return 'https://wa.me/' + cleaned + '?text=' + encodeURIComponent(message || '');
  }

  /* ─────────────────────────────────────────────────────────────
     PUBLIC API
  ──────────────────────────────────────────────────────────────*/
  var SokoniLogistics = {
    /* Hub */
    HUB_TYPES:             HUB_TYPES,
    registerHub:           registerHub,
    getHub:                getHub,
    getActiveHubs:         getActiveHubs,
    loadHubsFromFirestore: loadHubsFromFirestore,
    /* Batch */
    createBatch:           createBatch,
    getCurrentStop:        getCurrentStop,
    advanceBatchStop:      advanceBatchStop,
    /* Proof of delivery */
    generateOTP:           generateOTP,
    validateProof:         validateProof,
    buildProofRecord:      buildProofRecord,
    /* Analytics */
    buildDailyRollup:      buildDailyRollup,
    computeRiderMetrics:   computeRiderMetrics,
    /* Incentives */
    INCENTIVE_TIERS:       INCENTIVE_TIERS,
    computeIncentives:     computeIncentives,
    /* Notifications */
    NOTIFICATION_TEMPLATES:NOTIFICATION_TEMPLATES,
    renderNotification:    renderNotification,
    whatsappDeepLink:      whatsappDeepLink,
  };

  g.SokoniLogistics = SokoniLogistics;
  if (typeof module !== 'undefined') module.exports = SokoniLogistics;

})(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : this));
