/* ================================================================
   SOKONI — Commerce-to-Delivery Workflow  (sokoni-delivery.js)

   Complete flow:
     Buyer purchases product
     → Order created in Firestore
     → Buyer requests delivery (manual or auto)
     → Seller confirms item ready
     → Nearest rider matched via rideDrivers
     → Rider accepts → GPS tracking starts
     → Rider picks up from seller → In transit
     → Proof of delivery captured
     → Order marked delivered
     → Seller paid, commission recorded

   Supports: marketplace products, food, pharmacy, property docs,
             general packages  ·  same-day / scheduled / express

   Exposes: window.SokoniDelivery  (also ES module export)
================================================================ */
import { db } from './firebase.js';
import {
  doc, collection, onSnapshot, query, where, orderBy,
  updateDoc, arrayUnion, serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import SokoniDB from './sokoni-db.js';

/* ── Delivery speed tiers ── */
const SPEED_TIERS = {
  express:   { label:'Express (1-2 hrs)', multiplier:1.6, icon:'⚡' },
  same_day:  { label:'Same-Day',          multiplier:1.0, icon:'📅' },
  scheduled: { label:'Scheduled',         multiplier:0.9, icon:'🗓️' },
};

/* ── Order category configs ── */
const CATEGORY_CONFIG = {
  marketplace: { label:'Marketplace Product', icon:'🛒', defaultSpeed:'same_day' },
  food:        { label:'Food Order',           icon:'🍱', defaultSpeed:'express'  },
  pharmacy:    { label:'Pharmacy Order',       icon:'💊', defaultSpeed:'express'  },
  property:    { label:'Property Document',    icon:'📑', defaultSpeed:'same_day' },
  general:     { label:'General Package',      icon:'📦', defaultSpeed:'same_day' },
};

/* ── Commission ── */
const COMMISSION_PCT = 12;

/* ── Fallback pricing (used only if SokoniDeliveryPricing not loaded) ── */
const _FALLBACK_BASE   = 100;
const _FALLBACK_PER_KM = 18;

/* ─────────────────────────────────────────────────────────────
   INTERNAL helpers
───────────────────────────────────────────────────────────── */
function haversine(lat1,lng1,lat2,lng2){
  const R=6371,dLat=(lat2-lat1)*Math.PI/180,dLng=(lng2-lng1)*Math.PI/180,
    a=Math.sin(dLat/2)**2+Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLng/2)**2;
  return R*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a));
}

/*
 * _calcPricing(opts) → PricingResult
 * Uses SokoniDeliveryPricing engine when loaded; falls back to flat rate.
 */
function _calcPricing(opts) {
  if (window.SokoniDeliveryPricing) {
    return window.SokoniDeliveryPricing.calculate(opts);
  }
  /* Fallback: flat base + perKm */
  const speedMult = { express:1.55, same_day:1.00, scheduled:0.85 };
  const sm = speedMult[opts.speedTier] || 1.0;
  const fee = Math.round((_FALLBACK_BASE + (opts.distanceKm || 3) * _FALLBACK_PER_KM) * sm);
  const riderPayout = Math.max(180, Math.round(fee * 0.82));
  return {
    customerPaysFee: fee,
    customerFee:     fee,
    riderPayout:     riderPayout,
    platformCut:     fee - riderPayout,
    subsidyKES:      0,
    riderSharePct:   Math.round((riderPayout / fee) * 100),
    reasons:         [],
    primaryReason:   null,
    riderMinEarning: 180,
    meetsRiderMinimum: riderPayout >= 180,
    components:      {},
  };
}

function _delRef() {
  return 'DEL-' + Date.now().toString(36).toUpperCase().slice(-7);
}

/* _generatePIN() REMOVED with its only caller.

   A possession PIN minted in the browser was never an authorisation: the client
   that generates it also writes it, and the document it landed on is readable in
   FULL by the assigned rider — verified against the served ruleset, where
   packageRequests grants `resource.data.assignedDriverId == request.auth.uid` a
   document read, and Firestore cannot project fields away.

   It was also weak on its own terms: Math.random() is not a CSPRNG, and
   1000..9999 is 9,000 possibilities. The server issues a 6-digit crypto.randomInt
   PIN in deliveryPinOnAccept, keeps the HMAC hash on the delivery document and the
   plaintext in deliveryPins/{orderId} — a collection with NO match block, and
   therefore deny-by-default for every client. The buyer obtains it through
   getMyDeliveryPin, which proves buyer identity first.

   The helper is deleted rather than left unused, so the next writer cannot reach
   for it. */

/* Await first snapshot from a packageRequest document */
async function _readDelivery(deliveryRef, timeoutMs) {
  return new Promise(resolve => {
    let unsub;
    const timer = setTimeout(() => { try { unsub?.(); } catch(e){} resolve(null); }, timeoutMs || 5000);
    unsub = SokoniDB.listenPackageRequest(deliveryRef, data => {
      clearTimeout(timer); unsub(); resolve(data);
    });
  });
}

async function _findNearestDriver(fromLat, fromLng, vehicleType) {
  try {
    const drivers = await SokoniDB.getOnlineDrivers(vehicleType || null);
    const withGPS = drivers.filter(d => d.lat && d.lng);
    if (!withGPS.length) return null;
    withGPS.sort((a,b) =>
      haversine(fromLat,fromLng,a.lat,a.lng) -
      haversine(fromLat,fromLng,b.lat,b.lng)
    );
    return withGPS[0];
  } catch(e) {
    console.warn('[SokoniDelivery] findNearestDriver:', e.message);
    return null;
  }
}

/* Write a status update + append to timeline array in Firestore */
async function _updateDelivery(deliveryRef, data, by) {
  const entry = {
    status: data.status || '',
    at:     new Date().toISOString(),
    by:     String(by || 'system'),
  };
  await updateDoc(doc(db, 'packageRequests', deliveryRef), {
    ...data,
    timeline:           arrayUnion(entry),
    _lastTimelineEntry: entry,
    updatedAt:          serverTimestamp(),
  });
}

/* ═══════════════════════════════════════════════════════════
   PUBLIC API
═══════════════════════════════════════════════════════════ */
const SokoniDelivery = {

  SPEED_TIERS,
  CATEGORY_CONFIG,

  /* ─────────────────────────────────────────
     1. createOrderDelivery(opts)
        Called immediately after buyer places an order.
        Returns: { deliveryRef, deliveryFee, distanceKm, status }
  ───────────────────────────────────────── */
  async createOrderDelivery(opts) {
    const {
      orderId          = null,
      orderRef         = null,
      buyerName,
      buyerPhone,
      buyerUid         = null,
      sellerName,
      sellerPhone,
      sellerUid        = null,
      pickupAddress,
      pickupCoords     = null,
      deliveryAddress,
      deliveryCoords   = null,
      items            = [],
      orderTotal       = 0,
      category         = 'general',
      speed            = 'same_day',
      scheduledTime    = null,
      notes            = '',
      /* New intelligent pricing fields */
      vehicleType      = 'moto',
      weightKg         = 1,
      parcelSize       = 'small',
      isRural          = false,
      demandMultiplier = 1.0,
      subsidyKES       = 0,
    } = opts;

    /* Road-distance estimate via haversine × 1.35 road factor */
    let distanceKm  = 5;
    let durationMin = 20;
    if (pickupCoords && deliveryCoords) {
      distanceKm = Math.round(
        haversine(pickupCoords.lat, pickupCoords.lng, deliveryCoords.lat, deliveryCoords.lng)
        * 1.35 * 10
      ) / 10;
      if (distanceKm < 0.3) distanceKm = 0.3;
      durationMin = Math.round(distanceKm * 3);
    }

    /* Try OSRM for accurate road distance + duration */
    if (window.SokoniRouting && pickupCoords && deliveryCoords) {
      try {
        const route = await SokoniRouting.getRoute(
          pickupCoords.lat, pickupCoords.lng,
          deliveryCoords.lat, deliveryCoords.lng
        );
        if (route) { distanceKm = route.distanceKm; durationMin = route.durationMin; }
      } catch(e) { /* use haversine estimate */ }
    }

    /* Intelligent pricing */
    const pricing = _calcPricing({
      vehicleType,
      distanceKm,
      durationMin,
      weightKg,
      parcelSize,
      speedTier:       speed,
      demandMultiplier,
      isRural,
      subsidyKES,
      timestamp:       Date.now(),
    });

    const deliveryFee   = pricing.customerPaysFee;
    const commissionAmt = Math.round(orderTotal * COMMISSION_PCT / 100);
    const deliveryComm  = Math.round(deliveryFee * COMMISSION_PCT / 100);
    const deliveryRef   = _delRef();
    const now           = new Date().toISOString();
    const timelineEntry = { status:'order_placed', at:now, by:'buyer' };

    const deliveryDoc = {
      ref:            deliveryRef,
      deliveryRef,
      orderId,
      orderRef,
      /* Parties */
      buyerName,
      buyerPhone:     buyerPhone.replace(/\s/g,''),
      buyerUid,
      sellerName,
      sellerPhone:    sellerPhone.replace(/\s/g,''),
      sellerUid,
      /* Locations */
      pickupAddress,
      pickupCoords,
      deliveryAddress,
      deliveryCoords,
      distanceKm,
      durationMin,
      /* Order details */
      items,
      orderTotal,
      category:         CATEGORY_CONFIG[category] ? category : 'general',
      /* Delivery config */
      speed:            SPEED_TIERS[speed] ? speed : 'same_day',
      vehicleType,
      weightKg,
      parcelSize,
      scheduledTime,
      /* Pricing */
      deliveryFee,
      pricingBreakdown: pricing.components || null,
      pricingSurgeReasons: pricing.reasons || [],
      isPeakHour:       pricing.isPeakHour || false,
      isSurging:        pricing.isSurging  || false,
      /* Financials */
      commissionPct:    COMMISSION_PCT,
      commissionAmt,
      deliveryComm,
      sokoniTotalCut:   commissionAmt + deliveryComm,
      sellerNet:        orderTotal - commissionAmt,
      driverNet:        pricing.riderPayout,
      riderSharePct:    pricing.riderSharePct,
      subsidyKES:       pricing.subsidyKES || 0,
      /* Status */
      status:           'order_placed',
      notes,
      /* NO proofPin HERE — deliberately, and this absence is asserted by
         scripts/test-delivery-pin-client-writer.js. Issuance belongs to
         deliveryPinOnAccept, which fires when a rider is assigned. Writing one at
         creation both duplicated the server and exposed it: a sweep of historical
         records is pointless while this line keeps refilling them. */
      timeline:         [timelineEntry],
      _lastTimelineEntry: timelineEntry,
      createdAt:        now,
    };

    await SokoniDB.savePackageRequest(deliveryDoc);

    if (orderId) {
      await SokoniDB.updateOrder(orderId, {
        deliveryRef,
        deliveryStatus: 'order_placed',
        deliveryFee,
      }).catch(() => {});
    }

    return {
      deliveryRef,
      deliveryFee,
      distanceKm,
      durationMin,
      riderPayout: pricing.riderPayout,
      pricing,
      status: 'order_placed',
    };
  },

  /* ─────────────────────────────────────────
     2. sellerConfirmReady(deliveryRef, sellerUid)
        Seller taps "Item Ready for Pickup".
        Auto-triggers nearest-driver matching.
  ───────────────────────────────────────── */
  async sellerConfirmReady(deliveryRef, sellerUid) {
    await _updateDelivery(deliveryRef, { status:'ready_for_pickup' }, sellerUid || 'seller');
    return this.assignNearestDriver(deliveryRef);
  },

  /* ─────────────────────────────────────────
     3. assignNearestDriver(deliveryRef)
        Finds closest online driver and assigns them.
        Returns { driverId, driverName, etaMin } or { error }
  ───────────────────────────────────────── */
  async assignNearestDriver(deliveryRef) {
    const delivery = await _readDelivery(deliveryRef, 5000);
    if (!delivery) return { error: 'Delivery not found: ' + deliveryRef };

    const origin = delivery.pickupCoords;
    if (!origin?.lat) return { error: 'No pickup coordinates on delivery' };

    const driver = await _findNearestDriver(origin.lat, origin.lng, null);
    if (!driver) return { error: 'No drivers online' };

    const etaMin = Math.ceil(haversine(origin.lat, origin.lng, driver.lat, driver.lng) * 3.5);

    await _updateDelivery(deliveryRef, {
      status:           'driver_assigned',
      assignedDriverId: driver.driverId || driver._fsId,
      driverName:       driver.name || 'SOKONI Rider',
      driverPhone:      driver.phone || null,
      driverPlate:      driver.plate || '—',
      driverLat:        driver.lat,
      driverLng:        driver.lng,
      etaMin,
    }, 'system');

    return {
      driverId:    driver.driverId || driver._fsId,
      driverName:  driver.name,
      driverPhone: driver.phone,
      etaMin,
    };
  },

  /* ─────────────────────────────────────────
     3b. updateDriverPosition(deliveryRef, lat, lng, extras?)

     Mirrors the rider's live GPS onto the CANONICAL delivery record.

     Why this exists: the rider's GPS stream lands in driverLocations /
     deliveryLocations, whose security rules only admit the rider themselves,
     admins, or a uid listed in a `viewers` array that nothing ever writes. A
     buyer therefore could never read the rider's position and their map stayed
     empty. The buyer IS authorised to read this delivery document and is already
     subscribed to it, so mirroring the position here — the one record the seller,
     rider and buyer all share — makes tracking work without a second location
     collection and without loosening a single read rule.

     Deliberately does NOT go through _updateDelivery: a position ping must not
     append a timeline entry. Writes only keys the rider is already permitted to
     set on packageRequests.
  ───────────────────────────────────────── */
  async updateDriverPosition(deliveryRef, lat, lng, extras) {
    const a = Number(lat), b = Number(lng);
    if (!deliveryRef) return;
    /* Reject unusable fixes rather than plotting a marker in the Gulf of Guinea. */
    if (!Number.isFinite(a) || !Number.isFinite(b) ||
        Math.abs(a) > 90 || Math.abs(b) > 180 || (a === 0 && b === 0)) return;
    const speed = Number.isFinite(Number(extras?.speed)) ? { driverSpeed: Number(extras.speed) } : {};
    try {
      await updateDoc(doc(db, 'packageRequests', deliveryRef), {
        driverLat:          a,
        driverLng:          b,
        driverLocUpdatedAt: new Date().toISOString(),
        ...speed,
        updatedAt:          serverTimestamp(),
      });
    } catch (e) {
      /* driverLocUpdatedAt is a NEW key in the rider's permitted set. Until the
         matching rules release lands, the whole update is refused because
         affectedKeys().hasOnly() sees an unknown key — which would take the live
         rider marker down with it. driverLat/driverLng/updatedAt have always been
         permitted, so retry without the optional field: the buyer still gets a
         moving marker, and freshness falls back to updatedAt (the tracking page
         already reads either). Remove this fallback once the rules are released. */
      if (e?.code !== 'permission-denied') throw e;
      console.warn('[SokoniDelivery] position write refused; retrying without driverLocUpdatedAt');
      await updateDoc(doc(db, 'packageRequests', deliveryRef), {
        driverLat: a, driverLng: b, ...speed, updatedAt: serverTimestamp(),
      });
    }
  },

  /* ─────────────────────────────────────────
     4. driverAcceptDelivery(deliveryRef, driverId)
  ───────────────────────────────────────── */
  async driverAcceptDelivery(deliveryRef, driverId) {
    await _updateDelivery(deliveryRef, {
      status:     'driver_accepted',
      acceptedAt: new Date().toISOString(),
    }, driverId);
  },

  /* ─────────────────────────────────────────
     5. driverRejectDelivery(deliveryRef, driverId)
        Re-queues the delivery for another driver.
  ───────────────────────────────────────── */
  async driverRejectDelivery(deliveryRef, driverId) {
    await _updateDelivery(deliveryRef, {
      status:           'ready_for_pickup',
      assignedDriverId: null,
    }, driverId);
    /* Try re-assigning a different driver after short delay */
    setTimeout(() => this.assignNearestDriver(deliveryRef), 4000);
  },

  /* ─────────────────────────────────────────
     6. driverArrivedAtSeller(deliveryRef, driverId)
  ───────────────────────────────────────── */
  async driverArrivedAtSeller(deliveryRef, driverId) {
    await _updateDelivery(deliveryRef, {
      status:            'driver_at_seller', /* "Parcel Picked Up" stage */
      arrivedAtSellerAt: new Date().toISOString(),
    }, driverId);
  },

  /* ─────────────────────────────────────────
     7. driverPickedUp(deliveryRef, driverId)
  ───────────────────────────────────────── */
  async driverPickedUp(deliveryRef, driverId) {
    await _updateDelivery(deliveryRef, {
      status:     'in_transit',
      pickedUpAt: new Date().toISOString(),
    }, driverId);
  },

  /* ─────────────────────────────────────────
     8. driverDelivered(deliveryRef, driverId, proofNote?)
        Marks delivered, records commission, flags payout.
  ───────────────────────────────────────── */
  async driverDelivered(deliveryRef, driverId, proofNote) {
    const delivery = await _readDelivery(deliveryRef, 5000);
    const now = new Date().toISOString();

    await _updateDelivery(deliveryRef, {
      status:      'delivered',
      deliveredAt: now,
      proofNote:   proofNote || 'Delivered',
      payoutDue:   true,
    }, driverId);

    if (delivery?.orderId) {
      await SokoniDB.updateOrder(delivery.orderId, {
        status:         'delivered',
        deliveryStatus: 'delivered',
        deliveredAt:    now,
      }).catch(() => {});
    }

    /* Record commission via SokoniPay if loaded */
    if (window.SokoniPay?.saveCommission && delivery) {
      await SokoniPay.saveCommission({
        ref:          deliveryRef,
        orderId:      delivery.orderId || null,
        providerName: delivery.driverName || 'Driver',
        sellerName:   delivery.sellerName || 'Seller',
        category:     'delivery_' + (delivery.category || 'general'),
        commissionPct: COMMISSION_PCT,
        sokoniCut:    delivery.sokoniTotalCut || 0,
        deliveryFee:  delivery.deliveryFee   || 0,
        orderTotal:   delivery.orderTotal    || 0,
        driverNet:    delivery.driverNet     || 0,
        sellerNet:    delivery.sellerNet     || 0,
        status:       'completed',
        note:         (delivery.pickupAddress || '') + ' → ' + (delivery.deliveryAddress || ''),
        createdAt:    Date.now(),
      }).catch(() => {});
    }

    return { status:'delivered', deliveredAt:now };
  },

  /* ─────────────────────────────────────────
     9. buyerConfirmReceipt(deliveryRef, buyerUid)
        Buyer taps "I received it" → seller payout released.
  ───────────────────────────────────────── */
  async buyerConfirmReceipt(deliveryRef, buyerUid) {
    await _updateDelivery(deliveryRef, {
      status:            'buyer_confirmed',
      buyerConfirmedAt:  new Date().toISOString(),
      sellerPayoutReady: true,
    }, buyerUid || 'buyer');
  },

  /* ─────────────────────────────────────────
     10. cancelDelivery(deliveryRef, cancelledBy, reason?)
  ───────────────────────────────────────── */
  async cancelDelivery(deliveryRef, cancelledBy, reason) {
    await _updateDelivery(deliveryRef, {
      status:       'cancelled',
      cancelledBy:  cancelledBy || 'user',
      cancelReason: reason || '',
      cancelledAt:  new Date().toISOString(),
    }, cancelledBy);
  },

  /* ─────────────────────────────────────────
     11. listenDelivery(deliveryRef, callback) → unsub fn
         Real-time listener for all parties.
  ───────────────────────────────────────── */
  listenDelivery(deliveryRef, callback) {
    return SokoniDB.listenPackageRequest(deliveryRef, callback);
  },

  /* ─────────────────────────────────────────
     12. listenBuyerDeliveries(buyerUid, callback) → unsub fn
  ───────────────────────────────────────── */
  listenBuyerDeliveries(buyerUid, callback) {
    return SokoniDB.listenUserPackageHistory(buyerUid, callback);
  },

  /* ─────────────────────────────────────────
     13. listenSellerDeliveries(sellerUid, callback) → unsub fn
         Queries packageRequests where sellerUid matches.
         Requires Firestore composite index: sellerUid + createdAt desc.
  ───────────────────────────────────────── */
  listenSellerDeliveries(sellerUid, callback) {
    const q = query(
      collection(db, 'packageRequests'),
      where('sellerUid', '==', sellerUid),
      orderBy('createdAt', 'desc')
    );
    return onSnapshot(q,
      snap => callback(snap.docs.map(d => ({ _fsId:d.id, ...d.data() }))),
      err  => console.warn('[SokoniDelivery] sellerDeliveries:', err.message)
    );
  },

  /* ─────────────────────────────────────────
     14. listenDriverDeliveries(driverId, callback) → unsub fn
         Active and recent deliveries for a given driver.
         Requires Firestore composite index: assignedDriverId + createdAt desc.
  ───────────────────────────────────────── */
  listenDriverDeliveries(driverId, callback) {
    const q = query(
      collection(db, 'packageRequests'),
      where('assignedDriverId', '==', driverId),
      orderBy('createdAt', 'desc')
    );
    return onSnapshot(q,
      snap => callback(snap.docs.map(d => ({ _fsId:d.id, ...d.data() }))),
      err  => console.warn('[SokoniDelivery] driverDeliveries:', err.message)
    );
  },

  /* ─────────────────────────────────────────
     15. calcDeliveryFee(opts) → integer KES
         Exposed for UI fee previews before order creation.
         opts: { distanceKm, speedTier, vehicleType, weightKg,
                 parcelSize, durationMin, isRural, demandMultiplier }
  ───────────────────────────────────────── */
  calcDeliveryFee(opts) {
    if (typeof opts === 'number') {
      /* Legacy call: calcDeliveryFee(distanceKm, speed) */
      return _calcPricing({ distanceKm: opts, speedTier: arguments[1] || 'same_day' }).customerPaysFee;
    }
    return _calcPricing(opts || {}).customerPaysFee;
  },

  /* ─────────────────────────────────────────
     15b. calcPricing(opts) → full PricingResult
  ───────────────────────────────────────── */
  calcPricing: _calcPricing,

  /* ─────────────────────────────────────────
     16. buildStatusTimeline(status)
         Returns 9-stage step data for timeline UI.
         Stages: Order Confirmed → Preparing (optional) →
         Ready for Pickup → Rider Assigned → Rider En Route →
         Parcel Picked Up → Heading to You → Arriving → Delivered
  ───────────────────────────────────────── */
  buildStatusTimeline(status) {
    const steps = [
      { key:'order_placed',    icon:'🛒', label:'Order Confirmed'          },
      { key:'preparing',       icon:'👨‍🍳', label:'Preparing',    optional:true },
      { key:'ready_for_pickup',icon:'✅', label:'Ready for Pickup'         },
      { key:'driver_assigned', icon:'🏍️', label:'Rider Assigned'           },
      { key:'driver_accepted', icon:'🛵', label:'Rider En Route to Seller' },
      { key:'driver_at_seller',icon:'📍', label:'Parcel Picked Up'         },
      { key:'in_transit',      icon:'🚗', label:'Heading to You'           },
      { key:'arriving',        icon:'📲', label:'Arriving',    computed:true },
      { key:'delivered',       icon:'📦', label:'Delivered'                },
      { key:'buyer_confirmed', icon:'🎉', label:'Complete',    hideIfPending:true },
    ];
    const idx = steps.findIndex(s => s.key === status);
    return {
      steps,
      currentIdx: idx,
      current:    steps[idx] || { icon:'❓', label:status },
    };
  },
};

/* ── Expose globally for inline scripts ── */
if (typeof window !== 'undefined') {
  window.SokoniDelivery = SokoniDelivery;
  window.dispatchEvent(new CustomEvent('sokoniDeliveryReady'));
}

export default SokoniDelivery;
