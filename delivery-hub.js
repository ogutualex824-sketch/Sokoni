/* ================================================================
   SOKONI — Delivery Hub  (delivery-hub.js)

   Standalone logistics platform — direct sender-created deliveries.
   Complements sokoni-delivery.js (marketplace → delivery flow).

   Firestore collections:
     deliveries        — all delivery records
     deliveryRiders    — rider profiles & availability
     deliveryLocations — real-time GPS positions
     deliveryProofs    — proof-of-delivery records

   Exposes: window.DeliveryHub (also ES module default export)
================================================================ */

import { db } from './firebase.js';
import {
  collection, doc, addDoc, setDoc, getDoc, updateDoc,
  onSnapshot, query, where, orderBy, limit, serverTimestamp,
  arrayUnion, getDocs,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

/* ── Vehicle catalogue ── */
const VEHICLES = {
  boda:    { label:'Boda Boda',       icon:'🏍️', base:150,  perKm:35,  maxKm:25,  capacity:'Up to 5 kg'      },
  bicycle: { label:'Bicycle Courier', icon:'🚲', base:100,  perKm:20,  maxKm:10,  capacity:'Up to 3 kg'      },
  car:     { label:'Car / Saloon',    icon:'🚗', base:400,  perKm:60,  maxKm:80,  capacity:'Up to 50 kg'     },
  pickup:  { label:'Pickup (1T)',     icon:'🛻', base:1500, perKm:90,  maxKm:200, capacity:'Up to 1 tonne'   },
  van:     { label:'Van / Canter',    icon:'🚐', base:2500, perKm:110, maxKm:300, capacity:'Up to 3 tonnes'  },
  truck:   { label:'Lorry (5T+)',     icon:'🚛', base:5000, perKm:150, maxKm:500, capacity:'5+ tonnes'       },
  ref:     { label:'Refrigerated',    icon:'🧊', base:3000, perKm:130, maxKm:300, capacity:'Perishables'     },
  flatbed: { label:'Flatbed',         icon:'🚚', base:6000, perKm:170, maxKm:500, capacity:'Oversized cargo' },
};

/* ── Pricing constants ── */
const WEIGHT_SURCHARGE = { light:0, medium:0.1, heavy:0.25, bulk:0.4 };
const URGENCY_MULT     = { standard:1, express:1.3, urgent:1.6 };
const DRIVER_SHARE     = 0.88;
const PLATFORM_SHARE   = 0.12;

/* ── Delivery status definitions ── */
const STATUS_LABELS = {
  pending:        { label:'Pending',        icon:'⏳', color:'#fbbf24' },
  rider_assigned: { label:'Rider Assigned', icon:'🏍️', color:'#00aaff' },
  rider_en_route: { label:'Rider En Route', icon:'🛵', color:'#00aaff' },
  picked_up:      { label:'Picked Up',      icon:'📦', color:'#c8ff80' },
  in_transit:     { label:'In Transit',     icon:'🚗', color:'#00aaff' },
  delivered:      { label:'Delivered',      icon:'📬', color:'#71ff00' },
  completed:      { label:'Completed',      icon:'✅', color:'#71ff00' },
  cancelled:      { label:'Cancelled',      icon:'❌', color:'#ef4444' },
};

/* ── Internal helpers ── */
function _delRef() {
  return 'DEL-' + Date.now().toString(36).toUpperCase().slice(-8);
}

function _pin4() {
  const arr = new Uint32Array(1);
  crypto.getRandomValues(arr);
  return String(1000 + (arr[0] % 9000));
}

function _haversine(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/* ── Courier quote — ADR-012 ───────────────────────────────────────────────
   The DISTANCE component is the merchant delivery engine's `distance` mode
   (base + km x perKm), so there is one implementation of distance pricing on
   the platform rather than one per surface.

   The multipliers stay HERE. vehicle, weight and urgency are chosen per parcel
   at dispatch; merchant configuration is set once, in advance, by the merchant.
   Pushing them into the shared engine would put courier fleet economics inside
   the function that prices a bookshop's flat KES 150 delivery. The dependency
   runs one way: logistics composes merchant pricing, never the reverse.

   Equivalence with the previous inline formula was proven across 768
   combinations (8 vehicles x 4 weights x 3 urgencies x 8 distances) before this
   replaced it. It holds because Math.round(n + x) === n + Math.round(x) for
   integer n, and every vehicle `base` is an integer. */
function _calcFee(distKm, vehicleType, weight, urgency) {
  const v = VEHICLES[vehicleType] || VEHICLES.boda;

  const engine = (typeof window !== 'undefined') && window.SokoniDeliveryEngine;
  if (!engine) {
    /* Refuse rather than fall back to a second formula. A duplicated
       calculation that silently disagrees is worse than a visible failure —
       it is how four implementations of one price came about. */
    console.error('[delivery-hub] SokoniDeliveryEngine not loaded; cannot quote.');
    return null;
  }

  const leg = engine.calculateDelivery(
    { enabled: true, mode: 'distance', baseFee: v.base, perKm: v.perKm },
    { distanceKm: distKm }
  );
  if (!leg.deliverable) return null;      /* e.g. distance unknown */

  const wSur = Math.round(leg.fee * (WEIGHT_SURCHARGE[weight] || 0));
  return Math.round((leg.fee + wSur) * (URGENCY_MULT[urgency] || 1));
}

/* Timestamp field → Date (or null). Accepts a Firestore Timestamp (new,
   server-stamped docs), a millis number, or an ISO string (legacy docs) so reads
   survive the mixed-type window — new Date(Timestamp) is Invalid Date. */
function _tsDate(v) {
  if (v == null) return null;
  if (typeof v.toDate === 'function')   return v.toDate();
  if (typeof v.toMillis === 'function') return new Date(v.toMillis());
  if (typeof v === 'number')            return new Date(v);
  const t = Date.parse(v); return isNaN(t) ? null : new Date(t);
}

async function _timelineUpdate(fsId, status, by, extra) {
  /* entry.at stays a client ISO string: it lives inside the timeline arrayUnion,
     where the serverTimestamp() sentinel is illegal. It is a display mirror.
     statusUpdatedAt is the authoritative scalar (feeds payoutDue/SLA) and is
     server-generated. Any timestamp fields in `extra` are already serverTimestamp
     (see the callers) and land as scalars, not in the array. */
  const entry = { status, at: new Date().toISOString(), by: String(by || 'system') };
  await updateDoc(doc(db, 'deliveries', fsId), {
    status,
    statusUpdatedAt: serverTimestamp(),
    timeline: arrayUnion(entry),
    updatedAt: serverTimestamp(),
    ...(extra || {}),
  });
  return entry;
}

async function _findNearestRider(fromLat, fromLng, vehicleType) {
  try {
    const filters = [
      where('isOnline',    '==', true),
      where('isAvailable', '==', true),
      where('status',      '==', 'active'),
    ];
    let q = query(collection(db, 'deliveryRiders'), ...filters);
    if (vehicleType && VEHICLES[vehicleType]) {
      q = query(collection(db, 'deliveryRiders'), ...filters, where('vehicle', '==', vehicleType));
    }
    const snap   = await getDocs(q);
    const riders = snap.docs.map(d => ({ _fsId:d.id, ...d.data() })).filter(r => r.lat && r.lng);
    if (!riders.length) {
      /* Widen: ignore vehicle type */
      if (vehicleType) return _findNearestRider(fromLat, fromLng, null);
      return null;
    }
    riders.sort((a, b) =>
      _haversine(fromLat, fromLng, a.lat, a.lng) -
      _haversine(fromLat, fromLng, b.lat, b.lng)
    );
    return riders[0];
  } catch(e) {
    console.warn('[DeliveryHub] _findNearestRider:', e.message);
    return null;
  }
}

/* ════════════════════════════════════════════════════════════
   PUBLIC API
════════════════════════════════════════════════════════════ */
const DeliveryHub = {

  VEHICLES,
  STATUS_LABELS,

  /* ────────────────────────────────────────────────────────
     Pricing utility — exposed for UI previews
  ──────────────────────────────────────────────────────── */
  calcFee: _calcFee,

  /* ────────────────────────────────────────────────────────
     1. createDelivery(opts) → { deliveryRef, fsId, deliveryFee, distanceKm, proofPIN, trackingUrl }
        Supports: instant | scheduled | same_day | multi_stop
  ──────────────────────────────────────────────────────── */
  async createDelivery(opts) {
    const {
      uid,
      senderName      = '',
      senderPhone     = '',
      deliveryType    = 'instant',
      scheduledTime   = null,
      category        = 'general',
      /* Standard pickup/dropoff */
      pickupAddress   = '',
      pickupCoords    = null,
      deliveryAddress = '',
      deliveryCoords  = null,
      /* Multi-stop array: [{ type, address, coords, contactName, contactPhone, notes }] */
      stops           = [],
      /* Recipient */
      recipientName   = '',
      recipientPhone  = '',
      /* Package */
      packageType     = 'parcel',
      weight          = 'light',
      vehicleType     = 'boda',
      notes           = '',
      urgency         = 'standard',
      paymentMethod   = 'mpesa',
      paymentRef      = '',
    } = opts;

    /* Distance */
    let distanceKm = 5;
    if (pickupCoords?.lat && deliveryCoords?.lat) {
      distanceKm = Math.round(_haversine(
        pickupCoords.lat, pickupCoords.lng,
        deliveryCoords.lat, deliveryCoords.lng
      ) * 1.3 * 10) / 10 || 0.5;
    } else if (stops.length >= 2) {
      let total = 0;
      for (let i = 0; i < stops.length - 1; i++) {
        if (stops[i].coords?.lat && stops[i+1].coords?.lat) {
          total += _haversine(stops[i].coords.lat, stops[i].coords.lng,
                              stops[i+1].coords.lat, stops[i+1].coords.lng);
        }
      }
      distanceKm = Math.round(total * 1.3 * 10) / 10 || 5;
    }

    /* OSRM routing refinement */
    if (window.SokoniRouting && pickupCoords?.lat && deliveryCoords?.lat) {
      try {
        const route = await window.SokoniRouting.getRoute(
          pickupCoords.lat, pickupCoords.lng,
          deliveryCoords.lat, deliveryCoords.lng
        );
        if (route?.distanceKm) distanceKm = route.distanceKm;
      } catch(e) { /* fall through */ }
    }

    const deliveryFee = _calcFee(distanceKm, vehicleType, weight, urgency);
    /* A delivery without a fee is not a cheaper delivery — it is an unpriced
       financial record. Refuse to create one. */
    if (deliveryFee == null || !isFinite(deliveryFee)) {
      throw new Error('Could not price this delivery. Please refresh and try again.');
    }
    const deliveryRef = _delRef();
    const proofPIN    = _pin4();
    const now         = new Date().toISOString();

    const deliveryDoc = {
      /* Ownership — uid MUST match auth.uid for Firestore rules */
      uid,
      senderUid:   uid,
      senderName,
      senderPhone: (senderPhone || '').replace(/\s/g,''),
      deliveryRef,
      /* Type */
      deliveryType,
      scheduledTime: scheduledTime || null,
      category,
      /* Locations */
      pickupAddress,
      pickupCoords:   pickupCoords || null,
      deliveryAddress,
      deliveryCoords: deliveryCoords || null,
      /* Multi-stop */
      stops: stops.map((s, i) => ({
        id:          'stop_' + i,
        sequence:    i,
        type:        s.type || (i === 0 ? 'pickup' : 'dropoff'),
        address:     s.address || '',
        coords:      s.coords || null,
        contactName: s.contactName || '',
        contactPhone:(s.contactPhone || '').replace(/\s/g,''),
        notes:       s.notes || '',
        status:      'pending',
      })),
      /* Recipient */
      recipientName,
      recipientPhone: (recipientPhone || '').replace(/\s/g,''),
      /* Package */
      packageType,
      weight,
      vehicleType,
      notes,
      urgency,
      /* Pricing */
      distanceKm,
      deliveryFee,
      driverNet:     Math.round(deliveryFee * DRIVER_SHARE),
      platformCut:   Math.round(deliveryFee * PLATFORM_SHARE),
      commissionPct: Math.round(PLATFORM_SHARE * 100),
      /* Payment */
      paymentMethod,
      paymentRef:    paymentRef || '',
      paymentStatus: 'pending',
      /* Rider */
      assignedRiderId: null,
      riderName:       null,
      riderPhone:      null,
      riderPlate:      null,
      riderVehicle:    null,
      riderLat:        null,
      riderLng:        null,
      etaMin:          null,
      /* Status */
      status:          'pending',
      statusUpdatedAt: serverTimestamp(),
      /* Proof */
      proofPIN,
      proofVerified:   false,
      proofPhotoUrl:   null,
      proofGps:        null,
      proofTimestamp:  null,
      proofNote:       null,
      /* Timeline — at:now is a client mirror (arrays cannot hold serverTimestamp) */
      timeline: [{ status:'pending', at:now, by:'sender' }],
      /* Payout */
      payoutDue: false,
      /* Timestamps — server-generated authoritative event times */
      createdAt:  serverTimestamp(),
      updatedAt:  serverTimestamp(),
      /* Tracking */
      trackingUrl: 'https://mysokoni.co.ke/delivery-tracking.html?ref=' + deliveryRef,
    };

    const docRef  = await addDoc(collection(db, 'deliveries'), deliveryDoc);
    const fsId    = docRef.id;

    /* Immediate rider assignment for instant deliveries */
    if (deliveryType === 'instant' && pickupCoords?.lat) {
      this.assignNearestRider(fsId, deliveryDoc).catch(() => {});
    }

    /* Commission record */
    if (window.SokoniPay?.saveCommission && deliveryFee > 0) {
      window.SokoniPay.saveCommission({
        ref:         deliveryRef,
        providerName:'SOKONI Rider',
        category:    'delivery_' + category,
        commissionPct: Math.round(PLATFORM_SHARE * 100),
        sokoniCut:   deliveryDoc.platformCut,
        providerNet: deliveryDoc.driverNet,
        serviceTotal: deliveryFee,
        status:      'pending',
        note:        pickupAddress + ' → ' + deliveryAddress,
        createdAt:   Date.now(),
      }).catch(() => {});
    }

    /* Notify sender */
    this.notify(uid, '🚀 Delivery Booked!',
      `Ref: ${deliveryRef} · Rider search started`, deliveryDoc.trackingUrl);

    return { deliveryRef, fsId, deliveryFee, distanceKm, proofPIN,
             trackingUrl: deliveryDoc.trackingUrl };
  },

  /* ────────────────────────────────────────────────────────
     2. assignNearestRider(fsId, deliveryData?)
        Finds closest available rider and assigns them.
        Returns: { riderId, riderName, etaMin } or { error }
  ──────────────────────────────────────────────────────── */
  async assignNearestRider(fsId, deliveryData) {
    const d = deliveryData ||
      (await getDoc(doc(db, 'deliveries', fsId))).data();
    if (!d) return { error:'Delivery not found' };

    const coords = d.pickupCoords;
    if (!coords?.lat) return { error:'No pickup coordinates' };

    const rider = await _findNearestRider(coords.lat, coords.lng, d.vehicleType);
    if (!rider) return { error:'No riders available' };

    const etaMin = Math.ceil(_haversine(coords.lat, coords.lng, rider.lat, rider.lng) * 3.5);
    const now    = new Date().toISOString();

    await updateDoc(doc(db, 'deliveries', fsId), {
      status:          'rider_assigned',
      statusUpdatedAt: serverTimestamp(),
      assignedRiderId: rider._fsId,
      riderName:       rider.name || 'SOKONI Rider',
      riderPhone:      rider.phone || null,
      riderPlate:      rider.plate || '—',
      riderVehicle:    rider.vehicle || d.vehicleType,
      riderLat:        rider.lat,
      riderLng:        rider.lng,
      etaMin,
      /* timeline at stays client — arrayUnion cannot hold the sentinel */
      timeline: arrayUnion({ status:'rider_assigned', at:now, by:'system' }),
      updatedAt: serverTimestamp(),
    });

    /* Mark rider as unavailable */
    await updateDoc(doc(db, 'deliveryRiders', rider._fsId), {
      isAvailable:      false,
      activeDeliveryId: fsId,
      updatedAt:        serverTimestamp(),
    }).catch(() => {});

    /* Notify sender */
    this.notify(d.senderUid, '🏍️ Rider Assigned!',
      `${rider.name || 'Your rider'} is heading to pick up your package. ETA ~${etaMin} min`,
      d.trackingUrl || 'https://mysokoni.co.ke/delivery-tracking.html?ref=' + d.deliveryRef);

    return { riderId:rider._fsId, riderName:rider.name, etaMin };
  },

  /* ────────────────────────────────────────────────────────
     3. riderAccept(fsId, riderId) — rider accepted the job
  ──────────────────────────────────────────────────────── */
  async riderAccept(fsId, riderId) {
    await _timelineUpdate(fsId, 'rider_en_route', riderId, {
      acceptedAt: serverTimestamp(),
    });

    /* Read delivery for notification */
    const snap = await getDoc(doc(db, 'deliveries', fsId)).catch(() => null);
    const d    = snap?.data();
    if (d?.senderUid) {
      this.notify(d.senderUid, '🛵 Rider En Route!',
        `${d.riderName || 'Your rider'} is on the way to pick up your package`,
        d.trackingUrl);
    }
  },

  /* ────────────────────────────────────────────────────────
     4. riderReject(fsId, riderId) — rider passed the job
  ──────────────────────────────────────────────────────── */
  async riderReject(fsId, riderId) {
    await updateDoc(doc(db, 'deliveries', fsId), {
      status:          'pending',
      statusUpdatedAt: serverTimestamp(),
      assignedRiderId: null,
      riderName:       null,
      riderPhone:      null,
      riderPlate:      null,
      /* timeline at stays client — arrayUnion cannot hold the sentinel */
      timeline: arrayUnion({ status:'pending', at:new Date().toISOString(), by:riderId }),
      updatedAt: serverTimestamp(),
    });

    /* Free rider */
    await updateDoc(doc(db, 'deliveryRiders', riderId), {
      isAvailable:      true,
      activeDeliveryId: null,
      updatedAt:        serverTimestamp(),
    }).catch(() => {});

    /* Re-assign after 3 s */
    setTimeout(() => this.assignNearestRider(fsId).catch(() => {}), 3000);
  },

  /* ────────────────────────────────────────────────────────
     5. riderAtPickup(fsId, riderId) — arrived at pickup
  ──────────────────────────────────────────────────────── */
  async riderAtPickup(fsId, riderId) {
    await _timelineUpdate(fsId, 'picked_up', riderId, {
      pickedUpAt: serverTimestamp(),
    });
  },

  /* ────────────────────────────────────────────────────────
     6. riderInTransit(fsId, riderId) — heading to dropoff
  ──────────────────────────────────────────────────────── */
  async riderInTransit(fsId, riderId) {
    const snap = await getDoc(doc(db, 'deliveries', fsId)).catch(() => null);
    const d    = snap?.data();
    await _timelineUpdate(fsId, 'in_transit', riderId, {
      inTransitAt: serverTimestamp(),
    });
    if (d?.senderUid) {
      this.notify(d.senderUid, '🚗 Package In Transit!',
        `Your package has been picked up and is on the way to ${d.deliveryAddress || 'destination'}`,
        d.trackingUrl);
    }
  },

  /* ────────────────────────────────────────────────────────
     7. submitProof(fsId, riderId, proofData)
        Verifies PIN + records photo/GPS proof.
        Returns: { ok, driverNet?, error? }
  ──────────────────────────────────────────────────────── */
  async submitProof(fsId, riderId, proofData) {
    const { pin, photoData, gps, notes } = proofData || {};

    const snap = await getDoc(doc(db, 'deliveries', fsId));
    if (!snap.exists()) return { ok:false, error:'Delivery not found' };
    const d = snap.data();

    /* PIN check */
    if (d.proofPIN && String(pin || '').trim() !== String(d.proofPIN)) {
      return { ok:false, error:'Wrong delivery PIN — ask the recipient for the 4-digit code' };
    }

    const now  = new Date().toISOString();
    const dNet = Math.round((d.deliveryFee || 0) * DRIVER_SHARE);

    /* Write proof record */
    await addDoc(collection(db, 'deliveryProofs'), {
      uid:         riderId,
      deliveryId:  fsId,
      deliveryRef: d.deliveryRef || '',
      riderName:   d.riderName  || '',
      pinEntered:  pin  || '',
      pinVerified: true,
      photoData:   photoData || null,
      gps:         gps || null,
      notes:       notes || 'Delivered — PIN verified',
      createdAt:   serverTimestamp(),
    });

    /* Update delivery — deliveredAt gates the rider payout, so it is the server
       clock. `now` (client) is returned below only for optimistic UI display. */
    await _timelineUpdate(fsId, 'delivered', riderId, {
      deliveredAt:   serverTimestamp(),
      proofVerified: true,
      proofTimestamp:serverTimestamp(),
      proofGps:      gps  || null,
      proofNote:     notes || 'Delivered — PIN verified',
      payoutDue:     true,
    });

    /* Free rider */
    await updateDoc(doc(db, 'deliveryRiders', riderId), {
      isAvailable:      true,
      activeDeliveryId: null,
      updatedAt:        serverTimestamp(),
    }).catch(() => {});

    /* Notify sender */
    this.notify(d.senderUid, '📬 Package Delivered!',
      `Your delivery (${d.deliveryRef}) has been delivered. Tap to confirm receipt.`,
      d.trackingUrl);

    /* Commission */
    if (window.SokoniPay?.saveCommission && d.deliveryFee > 0) {
      window.SokoniPay.saveCommission({
        ref:         d.deliveryRef || fsId,
        providerName:d.riderName || 'Rider',
        category:    'delivery_' + (d.category || 'general'),
        commissionPct: Math.round(PLATFORM_SHARE * 100),
        sokoniCut:   d.platformCut || 0,
        providerNet: dNet,
        serviceTotal:d.deliveryFee,
        status:      'completed',
        note:        (d.pickupAddress || '') + ' → ' + (d.deliveryAddress || ''),
        createdAt:   Date.now(),
      }).catch(() => {});
    }

    return { ok:true, driverNet:dNet, deliveredAt:now };
  },

  /* ────────────────────────────────────────────────────────
     8. confirmReceipt(fsId, senderUid) — sender confirms receipt
  ──────────────────────────────────────────────────────── */
  async confirmReceipt(fsId, senderUid) {
    await _timelineUpdate(fsId, 'completed', senderUid, {
      completedAt:       serverTimestamp(),
      sellerPayoutReady: true,
    });
  },

  /* ────────────────────────────────────────────────────────
     9. cancelDelivery(fsId, cancelledBy, reason)
  ──────────────────────────────────────────────────────── */
  async cancelDelivery(fsId, cancelledBy, reason) {
    const snap = await getDoc(doc(db, 'deliveries', fsId)).catch(() => null);
    const d    = snap?.data() || {};
    await _timelineUpdate(fsId, 'cancelled', cancelledBy, {
      cancelledAt:  serverTimestamp(),
      cancelledBy:  cancelledBy || 'user',
      cancelReason: reason || '',
    });
    if (d.assignedRiderId) {
      await updateDoc(doc(db, 'deliveryRiders', d.assignedRiderId), {
        isAvailable: true, activeDeliveryId:null, updatedAt:serverTimestamp(),
      }).catch(() => {});
    }
  },

  /* ────────────────────────────────────────────────────────
     10. updateRiderLocation(riderId, lat, lng, extras?)
         Called every 5 s from rider's GPS tracker.
  ──────────────────────────────────────────────────────── */
  async updateRiderLocation(riderId, lat, lng, extras) {
    const data = { uid:riderId, riderId, lat, lng, updatedAt:serverTimestamp(), ...(extras||{}) };
    await setDoc(doc(db, 'deliveryLocations', riderId), data, { merge:true });
    await updateDoc(doc(db, 'deliveryRiders', riderId), { lat, lng, updatedAt:serverTimestamp() }).catch(()=>{});
  },

  /* ────────────────────────────────────────────────────────
     11. listenRiderLocation(riderId, callback) → unsub fn
  ──────────────────────────────────────────────────────── */
  listenRiderLocation(riderId, callback) {
    return onSnapshot(
      doc(db, 'deliveryLocations', riderId),
      snap  => callback(snap.exists() ? snap.data() : null),
      err   => console.warn('[DeliveryHub] listenRiderLocation:', err.message)
    );
  },

  /* ────────────────────────────────────────────────────────
     12. listenDelivery(fsId, callback) → unsub fn
  ──────────────────────────────────────────────────────── */
  listenDelivery(fsId, callback) {
    return onSnapshot(
      doc(db, 'deliveries', fsId),
      snap => callback(snap.exists() ? { _fsId:snap.id, ...snap.data() } : null),
      err  => console.warn('[DeliveryHub] listenDelivery:', err.message)
    );
  },

  /* listenDeliveryByRef — resolves from deliveryRef string */
  listenDeliveryByRef(deliveryRef, callback) {
    const q = query(
      collection(db, 'deliveries'),
      where('deliveryRef', '==', deliveryRef),
      limit(1)
    );
    return onSnapshot(q,
      snap => callback(snap.empty ? null : { _fsId:snap.docs[0].id, ...snap.docs[0].data() }),
      err  => console.warn('[DeliveryHub] listenDeliveryByRef:', err.message)
    );
  },

  /* ────────────────────────────────────────────────────────
     13. listenSenderDeliveries(senderUid, callback) → unsub fn
  ──────────────────────────────────────────────────────── */
  listenSenderDeliveries(senderUid, callback) {
    const q = query(
      collection(db, 'deliveries'),
      where('senderUid', '==', senderUid),
      orderBy('createdAt', 'desc')
    );
    return onSnapshot(q,
      snap => callback(snap.docs.map(d => ({ _fsId:d.id, ...d.data() }))),
      err  => console.warn('[DeliveryHub] listenSenderDeliveries:', err.message)
    );
  },

  /* ────────────────────────────────────────────────────────
     14. listenRiderDeliveries(riderId, callback) → unsub fn
         Active deliveries assigned to this rider.
  ──────────────────────────────────────────────────────── */
  listenRiderDeliveries(riderId, callback) {
    const q = query(
      collection(db, 'deliveries'),
      where('assignedRiderId', '==', riderId),
      where('status', 'in', ['rider_assigned','rider_en_route','picked_up','in_transit']),
      orderBy('createdAt', 'desc')
    );
    return onSnapshot(q,
      snap => callback(snap.docs.map(d => ({ _fsId:d.id, ...d.data() }))),
      err  => console.warn('[DeliveryHub] listenRiderDeliveries:', err.message)
    );
  },

  /* ────────────────────────────────────────────────────────
     15. listenPendingDeliveries(callback) → unsub fn  (admin/dispatch)
  ──────────────────────────────────────────────────────── */
  listenPendingDeliveries(callback) {
    const q = query(
      collection(db, 'deliveries'),
      where('status', '==', 'pending'),
      orderBy('createdAt', 'desc')
    );
    return onSnapshot(q,
      snap => callback(snap.docs.map(d => ({ _fsId:d.id, ...d.data() }))),
      err  => console.warn('[DeliveryHub] listenPendingDeliveries:', err.message)
    );
  },

  /* ────────────────────────────────────────────────────────
     16. registerRider(riderData, uid) — upsert rider profile
  ──────────────────────────────────────────────────────── */
  async registerRider(riderData, uid) {
    const data = {
      uid,
      riderId:       uid,
      name:          riderData.name          || '',
      phone:         riderData.phone         || '',
      plate:         riderData.plate         || '',
      vehicle:       riderData.vehicle       || 'boda',
      vehicleLabel:  VEHICLES[riderData.vehicle]?.label || riderData.vehicle || 'Boda Boda',
      zone:          riderData.zone          || '',
      isOnline:      false,
      isAvailable:   true,
      status:        'pending',
      rating:        5.0,
      ratingCount:   0,
      tripsCompleted:0,
      earnings:      0,
      todayEarnings: 0,
      weekEarnings:  0,
      lat:           null,
      lng:           null,
      createdAt:     new Date().toISOString(),
      updatedAt:     serverTimestamp(),
    };
    await setDoc(doc(db, 'deliveryRiders', uid), data, { merge:true });
    return uid;
  },

  /* ────────────────────────────────────────────────────────
     17. toggleRiderOnline(riderId, isOnline, lat?, lng?)
  ──────────────────────────────────────────────────────── */
  async toggleRiderOnline(riderId, isOnline, lat, lng) {
    const update = { isOnline, isAvailable:isOnline, updatedAt:serverTimestamp() };
    if (lat != null) update.lat = lat;
    if (lng != null) update.lng = lng;
    await setDoc(doc(db, 'deliveryRiders', riderId), update, { merge:true });
  },

  /* ────────────────────────────────────────────────────────
     18. listenRiderProfile(riderId, callback) → unsub fn
  ──────────────────────────────────────────────────────── */
  listenRiderProfile(riderId, callback) {
    return onSnapshot(
      doc(db, 'deliveryRiders', riderId),
      snap => callback(snap.exists() ? { _fsId:snap.id, ...snap.data() } : null),
      err  => console.warn('[DeliveryHub] listenRiderProfile:', err.message)
    );
  },

  /* ────────────────────────────────────────────────────────
     19. getSenderAnalytics(senderUid) → stats object
  ──────────────────────────────────────────────────────── */
  async getSenderAnalytics(senderUid) {
    const q    = query(collection(db, 'deliveries'), where('senderUid', '==', senderUid));
    const snap = await getDocs(q);
    const all  = snap.docs.map(d => d.data());
    const active    = ['rider_assigned','rider_en_route','picked_up','in_transit'];
    const completed = ['delivered','completed'];
    return {
      total:     all.length,
      active:    all.filter(d => active.includes(d.status)).length,
      completed: all.filter(d => completed.includes(d.status)).length,
      pending:   all.filter(d => d.status === 'pending').length,
      cancelled: all.filter(d => d.status === 'cancelled').length,
      spent:     all.filter(d => d.status !== 'cancelled').reduce((s,d) => s+(d.deliveryFee||0), 0),
    };
  },

  /* ────────────────────────────────────────────────────────
     20. getRiderAnalytics(riderId) → rider stats
  ──────────────────────────────────────────────────────── */
  async getRiderAnalytics(riderId) {
    const q    = query(
      collection(db, 'deliveries'),
      where('assignedRiderId', '==', riderId),
      where('status', 'in', ['delivered','completed'])
    );
    const snap  = await getDocs(q);
    const all   = snap.docs.map(d => d.data());
    const today = new Date().toDateString();
    const totalEarnings = all.reduce((s,d) => s+(d.driverNet||0), 0);
    const todayEarnings = all
      .filter(d => { const dt = _tsDate(d.deliveredAt || d.createdAt); return dt && dt.toDateString() === today; })
      .reduce((s,d) => s+(d.driverNet||0), 0);
    return { trips:all.length, totalEarnings, todayEarnings };
  },

  /* ────────────────────────────────────────────────────────
     21. notify(targetUid, heading, sub, url?) — in-app notification
  ──────────────────────────────────────────────────────── */
  async notify(targetUid, heading, sub, url) {
    if (!targetUid) return;
    try {
      await addDoc(collection(db, 'notifications'), {
        targetUid,
        heading: heading || 'SOKONI Delivery',
        sub:     sub     || '',
        url:     url     || '/delivery-tracking.html',
        type:    'delivery',
        read:    false,
        createdAt: new Date().toISOString(),
      });
    } catch(e) { /* non-critical */ }
  },
};

if (typeof window !== 'undefined') {
  window.DeliveryHub = DeliveryHub;
  window.dispatchEvent(new CustomEvent('deliveryHubReady'));
}

export default DeliveryHub;
