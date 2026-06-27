/* ================================================================
   SOKONI — Intelligent Dispatch Engine  v1.0
   Weighted rider scoring, cascade state machine, multi-order
   batch compatibility, hub routing decisions, fraud detection.

   Exposes: window.SokoniDispatch  +  module.exports (CF use)
================================================================ */
(function (g) {
  'use strict';

  /* ─────────────────────────────────────────────────────────────
     CONFIGURATION
  ──────────────────────────────────────────────────────────────*/
  var CFG = {
    maxDispatchRadiusKm:  15,    /* Won't offer delivery if rider > this far from pickup */
    maxEtaMin:            35,    /* Worst acceptable rider ETA */
    maxConcurrentPerRider: 3,    /* Rider can carry up to this many active deliveries */
    dispatchTimeoutSec:   90,    /* Seconds before cascade skips to next rider */
    maxBatchSize:          3,    /* Max deliveries per rider at once */
    batchMaxDetourKm:     3.0,   /* Max extra km to justify adding a batch stop */
    fraudMaxSpeedKmH:    120,    /* Above this → GPS fraud flag */
    avgSpeedKmH:          25,    /* Nairobi moto average speed (for ETA estimates) */
  };

  /* ── Scoring weights (must sum to 1.0) ── */
  var WEIGHTS = {
    distance:        0.20,  /* haversine km to pickup — closest preferred */
    eta:             0.17,  /* dist / 25km/h — fastest preferred */
    workload:        0.11,  /* current active deliveries (0 = best) */
    vehicleMatch:    0.11,  /* exact vehicle type match */
    rating:          0.11,  /* customer rating /5 */
    acceptanceRate:  0.09,  /* % of offers accepted */
    completionRate:  0.12,  /* % of accepted deliveries completed */
    cancellationScore:0.09, /* 1 − cancellationRate (penalises high cancel rate) */
  };  /* sum = 1.00 */

  /* ── Vehicle capacity registry ── */
  var VEHICLE_CAPACITY = {
    moto:    { maxWeightKg:  15, sizeRank: 2 }, /* size rank: small=0 medium=1 large=2 xl=3 */
    bicycle: { maxWeightKg:   8, sizeRank: 1 },
    ebike:   { maxWeightKg:  12, sizeRank: 2 },
    tuktuk:  { maxWeightKg:  30, sizeRank: 2 },
    car:     { maxWeightKg:  50, sizeRank: 3 },
    van:     { maxWeightKg: 200, sizeRank: 3 },
    truck:   { maxWeightKg:1000, sizeRank: 3 },
  };

  var SIZE_RANK = { small:0, medium:1, large:2, extra_large:3 };

  /* ── Failed-delivery action table ── */
  var FAIL_ACTIONS = {
    customer_unavailable: { label:'Customer Unavailable',  retryable:true,  maxRetries:2, retryAfterMin:30, afterAllRetries:'return'  },
    wrong_address:        { label:'Wrong Address',          retryable:false, action:'refund'                                           },
    payment_failure:      { label:'Payment Failed',         retryable:false, action:'refund'                                           },
    rejected_order:       { label:'Order Rejected',         retryable:false, action:'refund'                                           },
    rider_breakdown:      { label:'Rider Breakdown',        retryable:true,  maxRetries:3, retryAfterMin:5,  reassign:true             },
    seller_delay:         { label:'Seller Delay',           retryable:true,  maxRetries:2, retryAfterMin:20                            },
    no_riders_available:  { label:'No Riders Available',    retryable:true,  maxRetries:6, retryAfterMin:10                            },
  };

  /* ─────────────────────────────────────────────────────────────
     INTERNAL HELPERS
  ──────────────────────────────────────────────────────────────*/
  function haversine(lat1, lng1, lat2, lng2) {
    var R = 6371;
    var dL = (lat2 - lat1) * Math.PI / 180;
    var dG = (lng2 - lng1) * Math.PI / 180;
    var a  = Math.sin(dL/2) * Math.sin(dL/2)
           + Math.cos(lat1 * Math.PI/180) * Math.cos(lat2 * Math.PI/180)
           * Math.sin(dG/2) * Math.sin(dG/2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  function _sizeRankOf(size) {
    return SIZE_RANK[size] != null ? SIZE_RANK[size] : 0;
  }

  function _vehCap(type) {
    return VEHICLE_CAPACITY[type] || VEHICLE_CAPACITY.moto;
  }

  /* ─────────────────────────────────────────────────────────────
     SCORING
  ──────────────────────────────────────────────────────────────*/
  /*
   * scoreRider(rider, delivery) → ScoredRider | null
   *
   * rider = {
   *   uid | id, name, phone, lat, lng, isOnline, vehicleType,
   *   rating, acceptanceRate, completionRate, activeDeliveries,
   *   battery?, networkStrength?, hubId?
   * }
   * delivery = {
   *   pickupLat, pickupLng, weightKg, parcelSize, vehicleType
   * }
   */
  function scoreRider(rider, delivery) {
    if (!rider.lat || !rider.lng)               return null;
    if (!rider.isOnline && !rider.online)        return null;
    if (rider.status === 'break')               return null; /* Rider on break */

    var distKm = haversine(rider.lat, rider.lng, delivery.pickupLat, delivery.pickupLng);
    if (distKm > CFG.maxDispatchRadiusKm)       return null;

    var cap = _vehCap(rider.vehicleType || 'moto');
    if ((delivery.weightKg || 1) > cap.maxWeightKg)  return null;
    if (_sizeRankOf(delivery.parcelSize) > cap.sizeRank) return null;

    var active = rider.activeDeliveries || 0;
    if (active >= CFG.maxConcurrentPerRider)    return null;

    /* Hub-affinity bonus: if rider is assigned to pickup hub, prefer them */
    var hubBonus = (delivery.hubId && rider.hubId === delivery.hubId) ? 0.05 : 0;

    /* Battery/signal penalties */
    var batteryPenalty = (rider.battery != null && rider.battery < 20) ? 0.1 : 0;
    var signalPenalty  = (rider.networkStrength != null && rider.networkStrength < 2) ? 0.05 : 0;

    /* ── Component scores (0–1) ── */
    var distScore   = 1 - (distKm / CFG.maxDispatchRadiusKm);
    var etaMin      = distKm / (CFG.avgSpeedKmH / 60);
    var etaScore    = Math.max(0, 1 - etaMin / CFG.maxEtaMin);
    var workScore   = 1 - (active / CFG.maxConcurrentPerRider);
    var vehScore    = (rider.vehicleType || 'moto') === (delivery.vehicleType || 'moto') ? 1.0
                    : cap.sizeRank >= _sizeRankOf(delivery.parcelSize) ? 0.7 : 0.3;
    var ratingScore      = Math.min(1, (rider.rating || 4.0) / 5.0);
    var accScore         = rider.acceptanceRate   != null ? rider.acceptanceRate   : 0.80;
    var compScore        = rider.completionRate   != null ? rider.completionRate   : 0.90;
    var cancScore        = rider.cancellationRate != null ? Math.max(0, 1 - rider.cancellationRate) : 0.90;

    /* Automatic disqualification: excessive cancellations (> 30% in recent window) */
    if (rider.cancellationRate != null && rider.cancellationRate > 0.30) return null;

    var raw = WEIGHTS.distance         * distScore
            + WEIGHTS.eta              * etaScore
            + WEIGHTS.workload         * workScore
            + WEIGHTS.vehicleMatch     * vehScore
            + WEIGHTS.rating           * ratingScore
            + WEIGHTS.acceptanceRate   * accScore
            + WEIGHTS.completionRate   * compScore
            + WEIGHTS.cancellationScore* cancScore;

    var final = Math.min(1, Math.max(0, raw + hubBonus - batteryPenalty - signalPenalty));

    return {
      riderId:    rider.uid || rider.id,
      riderName:  rider.name || rider.displayName || 'Rider',
      riderPhone: rider.phone || '',
      riderPlate: rider.plate || '',
      vehicleType:rider.vehicleType || 'moto',
      score:      Math.round(final * 1000) / 1000,
      distKm:     Math.round(distKm * 10) / 10,
      etaMin:     Math.round(etaMin),
      components: {
        distScore, etaScore, workScore, vehScore, ratingScore, accScore,
        compScore, cancScore, hubBonus, batteryPenalty, signalPenalty,
      },
    };
  }

  /*
   * rankRiders(riders, delivery) → ScoredRider[]  (sorted best first)
   */
  function rankRiders(riders, delivery) {
    var scored = [];
    for (var i = 0; i < riders.length; i++) {
      var s = scoreRider(riders[i], delivery);
      if (s) scored.push(s);
    }
    return scored.sort(function (a, b) { return b.score - a.score; });
  }

  /* ─────────────────────────────────────────────────────────────
     CASCADE STATE MACHINE
  ──────────────────────────────────────────────────────────────*/
  /*
   * Stored in Firestore at dispatchQueue/{deliveryRef}
   * {
   *   deliveryRef, rankedRiders: [{riderId,score,distKm,etaMin},...],
   *   currentIndex, attempts: [{riderId,offeredAt,response,respondedAt},...],
   *   status: 'pending'|'offered'|'accepted'|'exhausted'|'cancelled',
   *   createdAt, offeredAt?, acceptedRiderId?
   * }
   */
  function createCascadeState(rankedRiders, deliveryRef) {
    return {
      deliveryRef:  deliveryRef,
      rankedRiders: rankedRiders,
      currentIndex: 0,
      attempts:     [],
      status:       'pending',
      createdAt:    Date.now(),
    };
  }

  function getCurrentCandidate(state) {
    if (!state || state.status === 'exhausted' || state.status === 'accepted') return null;
    return state.rankedRiders[state.currentIndex] || null;
  }

  function recordOffer(state) {
    var candidate = getCurrentCandidate(state);
    if (!candidate) return state;
    state.status    = 'offered';
    state.offeredAt = Date.now();
    state.attempts.push({ riderId: candidate.riderId, offeredAt: state.offeredAt });
    return state;
  }

  function advanceCascade(state, response) {
    /* response: 'declined' | 'timeout' */
    var last = state.attempts[state.attempts.length - 1];
    if (last) { last.response = response; last.respondedAt = Date.now(); }
    state.currentIndex++;
    if (state.currentIndex >= state.rankedRiders.length) {
      state.status = 'exhausted';
    } else {
      state.status = 'pending';
    }
    return state;
  }

  function acceptCascade(state, riderId) {
    var last = state.attempts[state.attempts.length - 1];
    if (last) { last.response = 'accepted'; last.respondedAt = Date.now(); }
    state.status          = 'accepted';
    state.acceptedRiderId = riderId;
    state.acceptedAt      = Date.now();
    return state;
  }

  /* ─────────────────────────────────────────────────────────────
     MULTI-ORDER BATCH
  ──────────────────────────────────────────────────────────────*/
  /*
   * isBatchCompatible(riderRoute, newDelivery) → bool
   *
   * riderRoute = {
   *   currentLat, currentLng,
   *   dropoffLat, dropoffLng,  (current final destination)
   *   activeCount,             (currently active deliveries)
   *   vehicleType,
   * }
   * newDelivery = {
   *   pickupLat, pickupLng,
   *   dropoffLat, dropoffLng,
   *   weightKg, parcelSize,
   * }
   */
  function isBatchCompatible(riderRoute, newDelivery) {
    if (!riderRoute || !riderRoute.currentLat) return false;
    if ((riderRoute.activeCount || 0) >= CFG.maxBatchSize) return false;

    /* Vehicle must still fit the parcel */
    var cap = _vehCap(riderRoute.vehicleType || 'moto');
    if ((newDelivery.weightKg || 1) > cap.maxWeightKg) return false;
    if (_sizeRankOf(newDelivery.parcelSize) > cap.sizeRank) return false;

    /* Detour calculation */
    var directKm  = haversine(riderRoute.currentLat, riderRoute.currentLng,
                              riderRoute.dropoffLat,  riderRoute.dropoffLng);
    var detourKm  = haversine(riderRoute.currentLat,    riderRoute.currentLng,
                              newDelivery.pickupLat,    newDelivery.pickupLng)
                  + haversine(newDelivery.pickupLat,    newDelivery.pickupLng,
                              newDelivery.dropoffLat,   newDelivery.dropoffLng)
                  + haversine(newDelivery.dropoffLat,   newDelivery.dropoffLng,
                              riderRoute.dropoffLat,    riderRoute.dropoffLng);

    return (detourKm - directKm) <= CFG.batchMaxDetourKm;
  }

  /*
   * optimizeStopOrder(startLat, startLng, stops) → stops[]
   * Greedy nearest-neighbour TSP for multi-stop route ordering.
   * stops: [{ id, lat, lng, type:'pickup'|'dropoff', deliveryId, label }]
   */
  function optimizeStopOrder(startLat, startLng, stops) {
    var remaining = stops.slice();
    var ordered   = [];
    var curLat    = startLat;
    var curLng    = startLng;
    while (remaining.length) {
      var best = -1, bestDist = Infinity;
      for (var i = 0; i < remaining.length; i++) {
        /* Constraint: a delivery's pickup must precede its dropoff */
        if (remaining[i].type === 'dropoff') {
          var pickupOrdered = ordered.some(function (s) {
            return s.deliveryId === remaining[i].deliveryId && s.type === 'pickup';
          });
          if (!pickupOrdered) continue;
        }
        var d = haversine(curLat, curLng, remaining[i].lat, remaining[i].lng);
        if (d < bestDist) { bestDist = d; best = i; }
      }
      if (best === -1) break; /* All remaining blocked by constraint — append as-is */
      ordered.push(remaining[best]);
      curLat = remaining[best].lat;
      curLng = remaining[best].lng;
      remaining.splice(best, 1);
    }
    return ordered.concat(remaining); /* Append any that fell through constraint */
  }

  /* ─────────────────────────────────────────────────────────────
     HUB ROUTING
  ──────────────────────────────────────────────────────────────*/
  var NAIROBI_KEYWORDS = ['nairobi','westlands','karen','parklands','langata','kilimani',
                          'lavington','kileleshwa','upperhill','hurlingham','kasarani',
                          'kahawa','thika','ruiru','kiambu','athi','mlolongo','syokimau'];

  function _isNairobi(addr) {
    var a = (addr || '').toLowerCase();
    return NAIROBI_KEYWORDS.some(function (k) { return a.includes(k); });
  }

  /*
   * needsHubRouting(delivery) → bool
   * True when order is better routed via a hub than direct.
   */
  function needsHubRouting(delivery) {
    if ((delivery.distanceKm || 0) > 25) return true;
    if (delivery.isRural)               return true;
    if (!_isNairobi(delivery.pickupAddress) || !_isNairobi(delivery.deliveryAddress)) return true;
    return false;
  }

  /*
   * findBestHub(delivery, hubs) → hub | null
   * Finds the hub closest to the route midpoint.
   */
  function findBestHub(delivery, hubs) {
    if (!hubs || !hubs.length) return null;
    var pickLat  = delivery.pickupLat    || delivery.pickupCoords?.lat    || 0;
    var pickLng  = delivery.pickupLng    || delivery.pickupCoords?.lng    || 0;
    var dropLat  = delivery.dropoffLat   || delivery.deliveryCoords?.lat  || 0;
    var dropLng  = delivery.dropoffLng   || delivery.deliveryCoords?.lng  || 0;
    var midLat   = (pickLat + dropLat) / 2;
    var midLng   = (pickLng + dropLng) / 2;
    var best = null, bestDist = Infinity;
    hubs.forEach(function (h) {
      if (!h.lat || !h.lng) return;
      var d = haversine(midLat, midLng, h.lat, h.lng);
      if (d < bestDist) { bestDist = d; best = h; }
    });
    return best;
  }

  /* ─────────────────────────────────────────────────────────────
     FRAUD DETECTION
  ──────────────────────────────────────────────────────────────*/
  /*
   * checkGPSFraud(prev, curr) → { fraud, reason?, speedKmH }
   * prev/curr = { lat, lng, ts }  (ts in ms)
   */
  function checkGPSFraud(prev, curr) {
    if (!prev || !prev.lat) return { fraud: false };

    /* Outside Kenya bounding box */
    if (curr.lat < -5 || curr.lat > 5 || curr.lng < 33.9 || curr.lng > 42.0) {
      return { fraud: true, reason: 'Coordinates outside Kenya', speedKmH: 0 };
    }

    var distKm   = haversine(prev.lat, prev.lng, curr.lat, curr.lng);
    var elapsedS = ((curr.ts || Date.now()) - (prev.ts || 0)) / 1000;

    if (elapsedS <= 0) {
      return distKm > 0.01
        ? { fraud: true, reason: 'Position changed with no elapsed time' }
        : { fraud: false };
    }

    var speedKmH = (distKm / elapsedS) * 3600;
    if (speedKmH > CFG.fraudMaxSpeedKmH) {
      return {
        fraud:    true,
        reason:   'Impossible speed: ' + Math.round(speedKmH) + ' km/h',
        speedKmH: Math.round(speedKmH),
        distKm:   Math.round(distKm * 10) / 10,
      };
    }
    return { fraud: false, speedKmH: Math.round(speedKmH) };
  }

  /*
   * checkExcessiveCancellations(stats) → bool
   * stats = { cancellations, completions, totalInWindow }
   */
  function checkExcessiveCancellations(stats) {
    if (!stats || stats.totalInWindow < 5) return false;
    var cancRate = (stats.cancellations || 0) / (stats.totalInWindow || 1);
    return cancRate > 0.20; /* > 20% cancellation rate */
  }

  /* ─────────────────────────────────────────────────────────────
     FAILED DELIVERY WORKFLOW
  ──────────────────────────────────────────────────────────────*/
  /*
   * getFailedDeliveryAction(reason, attemptCount) → ActionResult
   * { action: 'retry'|'reassign'|'return'|'refund'|'support',
   *   reason, retryAfterMin?, escalate? }
   */
  function getFailedDeliveryAction(reason, attemptCount) {
    var cfg = FAIL_ACTIONS[reason];
    if (!cfg) return { action: 'support', reason: reason || 'Unknown failure', escalate: true };

    if (cfg.reassign) return { action: 'reassign', reason: cfg.label };

    if (cfg.retryable && (attemptCount || 0) < (cfg.maxRetries || 2)) {
      return {
        action:        'retry',
        reason:        cfg.label,
        retryAfterMin: cfg.retryAfterMin || 30,
        attemptsLeft:  cfg.maxRetries - attemptCount - 1,
      };
    }

    var afterAll = cfg.afterAllRetries || cfg.action || 'support';
    return { action: afterAll, reason: cfg.label, escalate: afterAll === 'support' };
  }

  /* ─────────────────────────────────────────────────────────────
     DELIVERY ANALYTICS HELPERS
  ──────────────────────────────────────────────────────────────*/
  /*
   * computeAnalyticsSummary(deliveries[]) → AnalyticsSummary
   */
  function computeAnalyticsSummary(deliveries) {
    if (!deliveries || !deliveries.length) {
      return { count:0, successRate:0, avgTimeMin:0, totalRevenue:0, avgFee:0 };
    }
    var total    = deliveries.length;
    var success  = deliveries.filter(function (d) { return d.status === 'delivered' || d.status === 'buyer_confirmed'; }).length;
    var times    = deliveries.filter(function (d) { return d.createdAt && d.deliveredAt; })
                             .map(function (d) { return (new Date(d.deliveredAt) - new Date(d.createdAt)) / 60000; });
    var revenue  = deliveries.reduce(function (s, d) { return s + (d.deliveryFee || 0); }, 0);
    return {
      count:       total,
      successRate: Math.round((success / total) * 100),
      avgTimeMin:  times.length ? Math.round(times.reduce(function (a,b){ return a+b; },0)/times.length) : 0,
      totalRevenue:Math.round(revenue),
      avgFee:      Math.round(revenue / total),
    };
  }

  /* ─────────────────────────────────────────────────────────────
     PUBLIC API
  ──────────────────────────────────────────────────────────────*/
  var SokoniDispatch = {
    /* Scoring */
    scoreRider:                scoreRider,
    rankRiders:                rankRiders,
    /* Cascade */
    createCascadeState:        createCascadeState,
    getCurrentCandidate:       getCurrentCandidate,
    recordOffer:               recordOffer,
    advanceCascade:            advanceCascade,
    acceptCascade:             acceptCascade,
    /* Batch */
    isBatchCompatible:         isBatchCompatible,
    optimizeStopOrder:         optimizeStopOrder,
    /* Hub routing */
    needsHubRouting:           needsHubRouting,
    findBestHub:               findBestHub,
    /* Fraud */
    checkGPSFraud:             checkGPSFraud,
    checkExcessiveCancellations: checkExcessiveCancellations,
    /* Failed delivery */
    getFailedDeliveryAction:   getFailedDeliveryAction,
    FAIL_ACTIONS:              FAIL_ACTIONS,
    /* Analytics */
    computeAnalyticsSummary:   computeAnalyticsSummary,
    /* Utilities */
    haversine:                 haversine,
    /* Config (read-only reference) */
    CFG:                       CFG,
    WEIGHTS:                   WEIGHTS,
    VEHICLE_CAPACITY:          VEHICLE_CAPACITY,
  };

  g.SokoniDispatch = SokoniDispatch;
  if (typeof module !== 'undefined') module.exports = SokoniDispatch;

})(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : this));
