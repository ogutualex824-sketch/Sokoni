/* ================================================================
   SOKONI — Order State Machine  (sokoni-orders.js)

   The single source of truth for order lifecycle.
   Every status change flows through transitionOrder() which:
     1. Validates the transition is legal
     2. Writes the new status to Firestore orders/{id}
     3. Appends an immutable event to orderEvents/{orderId}/events
     4. Dispatches in-app notifications to buyer + seller + rider
     5. Updates escrow state

   Order statuses (in lifecycle order):
     pending_payment → paid → awaiting_confirmation →
     confirmed → rider_assigned → rider_en_route →
     picked_up → in_transit → delivered →
     completed | cancelled | refunded

   Exposes: window.SokoniOrders  +  ES default export
================================================================ */
import { db } from './firebase.js';
import {
  doc, collection, setDoc, updateDoc, addDoc,
  onSnapshot, query, where, orderBy, limit,
  serverTimestamp, arrayUnion, increment, getDoc,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

/* ── UID helper ── */
function _uid() {
  if (typeof window !== 'undefined' && window.firebaseAuth?.currentUser?.uid)
    return window.firebaseAuth.currentUser.uid;
  try { return JSON.parse(localStorage.getItem('sokoniUser')||'null')?.uid ?? null; }
  catch { return null; }
}

/* ─────────────────────────────────────────────────────────────
   STATE DEFINITIONS
───────────────────────────────────────────────────────────── */
export const ORDER_STATUS = {
  PENDING_PAYMENT:      'pending_payment',
  PAID:                 'paid',
  AWAITING_CONFIRM:     'awaiting_confirmation',
  CONFIRMED:            'confirmed',
  RIDER_ASSIGNED:       'rider_assigned',
  RIDER_EN_ROUTE:       'rider_en_route',
  PICKED_UP:            'picked_up',
  IN_TRANSIT:           'in_transit',
  DELIVERED:            'delivered',
  COMPLETED:            'completed',
  CANCELLED:            'cancelled',
  REFUNDED:             'refunded',
};

export const STATUS_META = {
  pending_payment:      { label:'Pending Payment',      icon:'💳', color:'#fbbf24' },
  paid:                 { label:'Paid',                  icon:'✅', color:'#71ff00' },
  awaiting_confirmation:{ label:'Awaiting Confirmation', icon:'⏳', color:'#fbbf24' },
  confirmed:            { label:'Confirmed',             icon:'🟢', color:'#71ff00' },
  rider_assigned:       { label:'Rider Assigned',        icon:'🏍️', color:'#00aaff' },
  rider_en_route:       { label:'Rider En Route',        icon:'🛵', color:'#00aaff' },
  picked_up:            { label:'Picked Up',             icon:'📦', color:'#00aaff' },
  in_transit:           { label:'In Transit',            icon:'🚗', color:'#00aaff' },
  delivered:            { label:'Delivered',             icon:'📬', color:'#71ff00' },
  completed:            { label:'Completed',             icon:'🎉', color:'#71ff00' },
  cancelled:            { label:'Cancelled',             icon:'❌', color:'#ff6b6b' },
  refunded:             { label:'Refunded',              icon:'↩️', color:'#f97316' },
};

/* Legal transitions: from → [allowed tos] */
const TRANSITIONS = {
  pending_payment:       ['paid', 'cancelled'],
  paid:                  ['awaiting_confirmation', 'refunded', 'cancelled'],
  awaiting_confirmation: ['confirmed', 'cancelled', 'refunded'],
  confirmed:             ['rider_assigned', 'cancelled'],
  rider_assigned:        ['rider_en_route', 'confirmed', 'cancelled'],
  rider_en_route:        ['picked_up', 'cancelled'],
  picked_up:             ['in_transit', 'cancelled'],
  in_transit:            ['delivered', 'cancelled'],
  delivered:             ['completed', 'refunded'],
  completed:             [],
  cancelled:             ['refunded'],
  refunded:              [],
};

/* Notification templates per transition — [buyer, seller, rider] */
const NOTIF_TEMPLATES = {
  paid: {
    buyer:  (o) => ({ icon:'✅', heading:'Payment received!',        sub:`Your order ${o.id} is confirmed. Waiting for seller.` }),
    seller: (o) => ({ icon:'🛒', heading:'New paid order!',           sub:`${o.buyerName} ordered ${_itemSummary(o)}. Confirm to proceed.` }),
  },
  awaiting_confirmation: {
    seller: (o) => ({ icon:'⏳', heading:'Action needed — confirm order', sub:`Order ${o.id} awaiting your confirmation. Tap to confirm.` }),
  },
  confirmed: {
    buyer:  (o) => ({ icon:'🎉', heading:'Seller confirmed your order!',  sub:`${o.sellerName} confirmed ${_itemSummary(o)}. Finding a rider…` }),
    seller: (o) => ({ icon:'✅', heading:'Order confirmed',               sub:`You confirmed order ${o.id}. A rider will be assigned shortly.` }),
  },
  rider_assigned: {
    buyer:  (o) => ({ icon:'🏍️', heading:'Rider assigned!',              sub:`${o.driverName} will pick up your order soon.` }),
    seller: (o) => ({ icon:'🏍️', heading:'Rider assigned to your order', sub:`${o.driverName} is heading to you. Get the package ready.` }),
    rider:  (o) => ({ icon:'📦', heading:'New delivery assigned!',        sub:`Pick up from ${o.sellerName}. Earn KES ${o.driverNet||0}.` }),
  },
  rider_en_route: {
    buyer:  (o) => ({ icon:'🛵', heading:'Rider is on the way!',          sub:`${o.driverName} is heading to the seller.` }),
    seller: (o) => ({ icon:'🛵', heading:'Rider is on the way to you!',   sub:`${o.driverName} is en route. ETA: ~${o.etaMin||'?'} min.` }),
  },
  picked_up: {
    buyer:  (o) => ({ icon:'📦', heading:'Item picked up!',               sub:`${o.driverName} has your package and is heading to you.` }),
    seller: (o) => ({ icon:'✅', heading:'Package picked up!',            sub:`${o.driverName} picked up your package for order ${o.id}.` }),
  },
  in_transit: {
    buyer:  (o) => ({ icon:'🚗', heading:'Your order is on the way!',     sub:`Track ${o.driverName} live on the map.`, link:`delivery-tracking.html?ref=${o.deliveryRef||o.id}` }),
  },
  delivered: {
    buyer:  (o) => ({ icon:'📬', heading:'Your order has arrived!',       sub:`Confirm receipt to complete the delivery.`, link:`delivery-tracking.html?ref=${o.deliveryRef||o.id}` }),
    seller: (o) => ({ icon:'💰', heading:'Order delivered!',              sub:`Order ${o.id} was delivered. Payment will be released shortly.` }),
    rider:  (o) => ({ icon:'💰', heading:'Delivery completed!',           sub:`You earned KES ${o.driverNet||0} for order ${o.id}.` }),
  },
  completed: {
    buyer:  (o) => ({ icon:'🎉', heading:'Order complete!',               sub:`Your order from ${o.sellerName} is complete. Thank you!` }),
    seller: (o) => ({ icon:'💸', heading:'Payment released!',             sub:`KES ${(o.sellerNet||0).toLocaleString()} will be sent to your M-Pesa.` }),
  },
  cancelled: {
    buyer:  (o) => ({ icon:'❌', heading:'Order cancelled',               sub:`Your order ${o.id} has been cancelled.` }),
    seller: (o) => ({ icon:'❌', heading:'Order cancelled',               sub:`Order ${o.id} has been cancelled by ${o.cancelledBy||'buyer'}.` }),
    rider:  (o) => ({ icon:'❌', heading:'Delivery cancelled',            sub:`Order ${o.id} was cancelled.` }),
  },
  refunded: {
    buyer:  (o) => ({ icon:'↩️', heading:'Refund initiated',              sub:`Your KES ${(o.orderTotal||0).toLocaleString()} refund is being processed.` }),
    seller: (o) => ({ icon:'↩️', heading:'Refund issued for order',       sub:`A refund has been issued for order ${o.id}.` }),
  },
};

function _itemSummary(order) {
  const items = order.items || [];
  if (!items.length) return 'your order';
  const first = items[0];
  return items.length === 1 ? (first.name || 'item') : `${items.length} items`;
}

/* ─────────────────────────────────────────────────────────────
   ESCROW STATE
   orders/{id}  →  escrow: { held, released, refunded, currency }
───────────────────────────────────────────────────────────── */
function _escrowUpdate(status, order) {
  const total = Number(order.orderTotal || 0);
  switch (status) {
    case 'paid':
      return { escrow: { held: total, released: 0, refunded: 0, currency: 'KES', heldAt: new Date().toISOString() } };
    case 'completed':
      return { escrow: { held: 0, released: order.sellerNet || 0, refunded: 0, releasedAt: new Date().toISOString() } };
    case 'refunded':
      return { escrow: { held: 0, released: 0, refunded: total, refundedAt: new Date().toISOString() } };
    case 'cancelled':
      return { escrow: { held: 0, released: 0, refunded: 0, cancelledAt: new Date().toISOString() } };
    default:
      return {};
  }
}

/* ─────────────────────────────────────────────────────────────
   NOTIFICATION DISPATCHER
   Writes to notifications/{NTF-xxx} for each party.
───────────────────────────────────────────────────────────── */
async function _dispatchNotifications(toStatus, order) {
  const templates = NOTIF_TEMPLATES[toStatus] || {};
  const parties = [
    { key: 'buyer',  uid: order.buyerUid  || order.uid },
    { key: 'seller', uid: order.sellerUid },
    { key: 'rider',  uid: order.assignedDriverUid || order.driverUid },
  ];
  const writes = [];
  for (const { key, uid } of parties) {
    if (!uid || !templates[key]) continue;
    const tmpl = templates[key](order);
    const id   = `NTF-${Date.now()}-${key}`;
    writes.push(
      setDoc(doc(db, 'notifications', id), {
        id,
        targetUid:  uid,
        type:       'order',
        orderId:    order.id,
        deliveryRef: order.deliveryRef || null,
        icon:       tmpl.icon,
        heading:    tmpl.heading,
        sub:        tmpl.sub,
        link:       tmpl.link || `delivery-tracking.html?ref=${order.deliveryRef || order.id}`,
        read:       false,
        party:      key,
        createdAt:  serverTimestamp(),
      }, { merge: true })
    );
  }
  await Promise.allSettled(writes);
}

/* ─────────────────────────────────────────────────────────────
   ORDER EVENTS  (audit trail)
   Subcollection: orderEvents/{orderId}/events/{auto-id}
───────────────────────────────────────────────────────────── */
async function _writeEvent(orderId, fromStatus, toStatus, actorUid, meta) {
  await addDoc(collection(db, 'orderEvents', orderId, 'events'), {
    fromStatus,
    toStatus,
    actorUid: actorUid || _uid() || 'system',
    meta:     meta || {},
    createdAt: serverTimestamp(),
  });
}

/* ─────────────────────────────────────────────────────────────
   PUBLIC API
───────────────────────────────────────────────────────────── */
const SokoniOrders = {

  ORDER_STATUS,
  STATUS_META,
  TRANSITIONS,

  /* ── createOrder(opts) ──
     Initial order creation — writes with status = pending_payment.
     opts: { id, buyerUid, buyerName, buyerPhone, sellerUid, sellerName,
             sellerPhone, items[], orderTotal, deliveryFee, category,
             pickupAddress, pickupCoords, deliveryAddress, deliveryCoords,
             commissionPct?, notes? }
  */
  async createOrder(opts) {
    const id = opts.id || ('ORD-' + Date.now().toString(36).toUpperCase().slice(-8));
    const now = new Date().toISOString();
    const commissionPct  = opts.commissionPct ?? 12;
    const commissionAmt  = Math.round((opts.orderTotal || 0) * commissionPct / 100);
    const deliveryFee    = opts.deliveryFee || 0;
    const deliveryComm   = Math.round(deliveryFee * commissionPct / 100);
    const sellerNet      = (opts.orderTotal || 0) - commissionAmt;
    const driverNet      = Math.round(deliveryFee * 0.88);

    const orderDoc = {
      id,
      /* Parties */
      buyerUid:      opts.buyerUid || _uid() || null,
      buyerName:     opts.buyerName  || 'Buyer',
      buyerPhone:    (opts.buyerPhone || '').replace(/\s/g, ''),
      sellerUid:     opts.sellerUid  || null,
      sellerName:    opts.sellerName || 'Seller',
      sellerPhone:   (opts.sellerPhone || '').replace(/\s/g, ''),
      /* Items */
      items:         opts.items || [],
      category:      opts.category || 'marketplace',
      notes:         opts.notes || '',
      /* Locations */
      pickupAddress:   opts.pickupAddress   || '',
      pickupCoords:    opts.pickupCoords    || null,
      deliveryAddress: opts.deliveryAddress || '',
      deliveryCoords:  opts.deliveryCoords  || null,
      /* Financials */
      orderTotal:    opts.orderTotal   || 0,
      deliveryFee,
      commissionPct,
      commissionAmt,
      deliveryComm,
      sokoniTotalCut: commissionAmt + deliveryComm,
      sellerNet,
      driverNet,
      /* Escrow */
      escrow: { held: 0, released: 0, refunded: 0, currency: 'KES' },
      /* Delivery */
      deliveryRef:   opts.deliveryRef  || null,
      assignedDriverId:   null,
      assignedDriverUid:  null,
      driverName:    null,
      driverPhone:   null,
      /* Status */
      status:        ORDER_STATUS.PENDING_PAYMENT,
      statusHistory: [{ status: ORDER_STATUS.PENDING_PAYMENT, at: now, by: 'system' }],
      createdAt:     now,
      updatedAt:     now,
    };

    await setDoc(doc(db, 'orders', id), { ...orderDoc, _createdAt: serverTimestamp() }, { merge: false });
    await _writeEvent(id, null, ORDER_STATUS.PENDING_PAYMENT, _uid(), { source: 'createOrder' });

    return id;
  },

  /* ── transitionOrder(orderId, toStatus, actorUid?, meta?) ──
     The ONLY way to change order status.
     Returns { ok, error }
  */
  async transitionOrder(orderId, toStatus, actorUid, meta) {
    const snap = await getDoc(doc(db, 'orders', orderId));
    if (!snap.exists()) return { ok: false, error: 'Order not found: ' + orderId };
    const order      = snap.data();
    const fromStatus = order.status;

    /* Validate transition */
    const allowed = TRANSITIONS[fromStatus] || [];
    if (!allowed.includes(toStatus)) {
      return { ok: false, error: `Illegal transition: ${fromStatus} → ${toStatus}` };
    }

    const now = new Date().toISOString();
    const actor = actorUid || _uid() || 'system';
    const historyEntry = { status: toStatus, at: now, by: actor, ...(meta || {}) };

    /* Build update patch */
    const patch = {
      status:        toStatus,
      updatedAt:     now,
      _updatedAt:    serverTimestamp(),
      statusHistory: arrayUnion(historyEntry),
      ...( meta || {} ),
      ..._escrowUpdate(toStatus, order),
    };

    /* Status-specific patches */
    if (toStatus === ORDER_STATUS.CANCELLED)  patch.cancelledAt  = now;
    if (toStatus === ORDER_STATUS.COMPLETED)  patch.completedAt  = now;
    if (toStatus === ORDER_STATUS.DELIVERED)  patch.deliveredAt  = now;
    if (toStatus === ORDER_STATUS.PICKED_UP)  patch.pickedUpAt   = now;
    if (toStatus === ORDER_STATUS.REFUNDED)   patch.refundedAt   = now;

    await updateDoc(doc(db, 'orders', orderId), patch);
    await _writeEvent(orderId, fromStatus, toStatus, actor, meta || {});

    /* Fetch updated order for notifications */
    const updatedOrder = { ...order, ...patch, id: orderId };
    await _dispatchNotifications(toStatus, updatedOrder);

    /* SokoniPay commission on completion */
    if (toStatus === ORDER_STATUS.COMPLETED && window.SokoniPay?.saveCommission) {
      SokoniPay.saveCommission({
        ref:          orderId,
        orderId,
        providerName:  order.sellerName  || 'Seller',
        sellerName:    order.sellerName  || 'Seller',
        category:     'marketplace_' + (order.category || 'general'),
        commissionPct: order.commissionPct || 12,
        sokoniCut:     order.commissionAmt || 0,
        deliveryComm:  order.deliveryComm  || 0,
        orderTotal:    order.orderTotal    || 0,
        sellerNet:     order.sellerNet     || 0,
        driverNet:     order.driverNet     || 0,
        status:        'completed',
        note:          `Marketplace order delivered: ${orderId}`,
        createdAt:     Date.now(),
      }).catch(() => {});
    }

    return { ok: true, fromStatus, toStatus };
  },

  /* ── markPaid(orderId, paymentMeta?) ── */
  async markPaid(orderId, paymentMeta) {
    return this.transitionOrder(orderId, ORDER_STATUS.PAID, _uid(), {
      paymentMethod: paymentMeta?.method || 'mpesa',
      paymentRef:    paymentMeta?.ref    || null,
      paidAt:        new Date().toISOString(),
    });
  },

  /* ── sellerConfirm(orderId, sellerUid) ── */
  async sellerConfirm(orderId, sellerUid) {
    return this.transitionOrder(orderId, ORDER_STATUS.CONFIRMED, sellerUid, {
      confirmedAt: new Date().toISOString(),
    });
  },

  /* ── assignRider(orderId, driver) ── */
  async assignRider(orderId, driver) {
    const patch = {
      assignedDriverId:  driver.driverId || driver._fsId || driver.id,
      assignedDriverUid: driver.uid || null,
      driverName:        driver.name || 'Rider',
      driverPhone:       driver.phone || null,
      driverPlate:       driver.plate || null,
      driverNet:         driver.driverNet || null,
      etaMin:            driver.etaMin   || null,
    };
    return this.transitionOrder(orderId, ORDER_STATUS.RIDER_ASSIGNED, 'system', patch);
  },

  /* ── riderAccept(orderId, driverUid) ── */
  async riderAccept(orderId, driverUid) {
    return this.transitionOrder(orderId, ORDER_STATUS.RIDER_EN_ROUTE, driverUid, {
      acceptedAt: new Date().toISOString(),
    });
  },

  /* ── riderReject(orderId, driverUid) ──
     Re-queues for a different driver (back to confirmed). */
  async riderReject(orderId, driverUid) {
    const r = await this.transitionOrder(orderId, ORDER_STATUS.CONFIRMED, driverUid, {
      rejectedDriverId:  driverUid,
      rejectedAt:        new Date().toISOString(),
    });
    return r;
  },

  /* ── riderPickedUp(orderId, driverUid) ── */
  async riderPickedUp(orderId, driverUid) {
    return this.transitionOrder(orderId, ORDER_STATUS.PICKED_UP, driverUid, {
      pickedUpAt: new Date().toISOString(),
    });
  },

  /* ── riderInTransit(orderId, driverUid) ── */
  async riderInTransit(orderId, driverUid) {
    return this.transitionOrder(orderId, ORDER_STATUS.IN_TRANSIT, driverUid, {
      inTransitAt: new Date().toISOString(),
    });
  },

  /* ── riderDelivered(orderId, driverUid, proofData?) ──
     proofData: { pin?, photoUrl?, signatureUrl?, note? } */
  async riderDelivered(orderId, driverUid, proofData) {
    return this.transitionOrder(orderId, ORDER_STATUS.DELIVERED, driverUid, {
      deliveredAt:  new Date().toISOString(),
      proofPin:     proofData?.pin       || null,
      proofPhoto:   proofData?.photoUrl  || null,
      proofSig:     proofData?.signatureUrl || null,
      proofNote:    proofData?.note      || 'Delivered',
    });
  },

  /* ── buyerConfirm(orderId, buyerUid) ──
     Buyer receipt confirmation → completed → escrow released. */
  async buyerConfirm(orderId, buyerUid) {
    return this.transitionOrder(orderId, ORDER_STATUS.COMPLETED, buyerUid, {
      buyerConfirmedAt: new Date().toISOString(),
      sellerPayoutReady: true,
    });
  },

  /* ── cancelOrder(orderId, cancelledByUid, reason?) ── */
  async cancelOrder(orderId, cancelledByUid, reason) {
    return this.transitionOrder(orderId, ORDER_STATUS.CANCELLED, cancelledByUid, {
      cancelledBy:  cancelledByUid,
      cancelReason: reason || '',
      cancelledAt:  new Date().toISOString(),
    });
  },

  /* ── refundOrder(orderId, adminUid, reason?) ── */
  async refundOrder(orderId, adminUid, reason) {
    return this.transitionOrder(orderId, ORDER_STATUS.REFUNDED, adminUid, {
      refundedBy:    adminUid,
      refundReason:  reason || '',
      refundedAt:    new Date().toISOString(),
    });
  },

  /* ── adminOverride(orderId, toStatus, adminUid, reason?) ──
     Admin can force any status — bypasses TRANSITIONS validation. */
  async adminOverride(orderId, toStatus, adminUid, reason) {
    const snap = await getDoc(doc(db, 'orders', orderId));
    if (!snap.exists()) return { ok: false, error: 'Order not found' };
    const order      = snap.data();
    const fromStatus = order.status;
    const now        = new Date().toISOString();
    const histEntry  = { status: toStatus, at: now, by: adminUid, override: true, reason: reason || '' };

    await updateDoc(doc(db, 'orders', orderId), {
      status:        toStatus,
      updatedAt:     now,
      _updatedAt:    serverTimestamp(),
      statusHistory: arrayUnion(histEntry),
      ..._escrowUpdate(toStatus, order),
    });
    await _writeEvent(orderId, fromStatus, toStatus, adminUid, { override: true, reason: reason || '' });
    await _dispatchNotifications(toStatus, { ...order, id: orderId });
    return { ok: true, fromStatus, toStatus };
  },

  /* ─────────────────────────────────────────
     LISTENERS
  ───────────────────────────────────────── */

  /* Single order */
  listenOrder(orderId, callback) {
    return onSnapshot(doc(db, 'orders', orderId),
      snap => { if (snap.exists()) callback({ _fsId: snap.id, ...snap.data() }); },
      err  => console.warn('[SokoniOrders] order:', err.message)
    );
  },

  /* Buyer's orders */
  listenBuyerOrders(buyerUid, callback, limitN) {
    let q = query(
      collection(db, 'orders'),
      where('buyerUid', '==', buyerUid),
      orderBy('createdAt', 'desc')
    );
    if (limitN) q = query(q, limit(limitN));
    return onSnapshot(q,
      snap => callback(snap.docs.map(d => ({ _fsId: d.id, ...d.data() }))),
      err  => console.warn('[SokoniOrders] buyerOrders:', err.message)
    );
  },

  /* Seller's incoming orders */
  listenSellerOrders(sellerUid, callback, statusFilter) {
    let q = query(
      collection(db, 'orders'),
      where('sellerUid', '==', sellerUid),
      orderBy('createdAt', 'desc')
    );
    if (statusFilter) q = query(collection(db, 'orders'),
      where('sellerUid', '==', sellerUid),
      where('status', '==', statusFilter),
      orderBy('createdAt', 'desc')
    );
    return onSnapshot(q,
      snap => callback(snap.docs.map(d => ({ _fsId: d.id, ...d.data() }))),
      err  => console.warn('[SokoniOrders] sellerOrders:', err.message)
    );
  },

  /* Rider's active orders */
  listenRiderOrders(driverUid, callback) {
    const q = query(
      collection(db, 'orders'),
      where('assignedDriverUid', '==', driverUid),
      where('status', 'in', [
        ORDER_STATUS.RIDER_ASSIGNED,
        ORDER_STATUS.RIDER_EN_ROUTE,
        ORDER_STATUS.PICKED_UP,
        ORDER_STATUS.IN_TRANSIT,
      ]),
      orderBy('createdAt', 'desc')
    );
    return onSnapshot(q,
      snap => callback(snap.docs.map(d => ({ _fsId: d.id, ...d.data() }))),
      err  => console.warn('[SokoniOrders] riderOrders:', err.message)
    );
  },

  /* Admin — all orders with optional status filter */
  listenAllOrders(callback, statusFilter, limitN) {
    /* Build query incrementally — prevents status filter being silently dropped when limit is also set */
    const constraints = [orderBy('createdAt', 'desc')];
    if (statusFilter) constraints.unshift(where('status', '==', statusFilter));
    if (limitN)       constraints.push(limit(limitN));
    const q = query(collection(db, 'orders'), ...constraints);
    return onSnapshot(q,
      snap => callback(snap.docs.map(d => ({ _fsId: d.id, ...d.data() }))),
      err  => console.warn('[SokoniOrders] allOrders:', err.message)
    );
  },

  /* Order events (audit trail) */
  listenOrderEvents(orderId, callback) {
    const q = query(
      collection(db, 'orderEvents', orderId, 'events'),
      orderBy('createdAt', 'asc')
    );
    return onSnapshot(q,
      snap => callback(snap.docs.map(d => ({ _fsId: d.id, ...d.data() }))),
      err  => console.warn('[SokoniOrders] orderEvents:', err.message)
    );
  },

  /* ── Disputes ── */
  async fileDispute(orderId, filedByUid, reason, evidence) {
    const id = 'DSP-' + Date.now().toString(36).toUpperCase();
    await setDoc(doc(db, 'disputes', id), {
      id,
      orderId,
      filedByUid,
      reason:   reason || '',
      evidence: evidence || '',
      status:   'open',
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    await updateDoc(doc(db, 'orders', orderId), {
      disputed: true, disputeId: id, updatedAt: new Date().toISOString(),
    }).catch(() => {});
    return id;
  },

  async resolveDispute(disputeId, adminUid, resolution, action) {
    await updateDoc(doc(db, 'disputes', disputeId), {
      status:     'resolved',
      resolution: resolution || '',
      action:     action || '',
      resolvedBy: adminUid,
      resolvedAt: serverTimestamp(),
      updatedAt:  serverTimestamp(),
    });
  },

  listenDisputes(callback, statusFilter) {
    let q = query(collection(db, 'disputes'), orderBy('createdAt', 'desc'));
    if (statusFilter) q = query(collection(db, 'disputes'), where('status', '==', statusFilter), orderBy('createdAt', 'desc'));
    return onSnapshot(q,
      snap => callback(snap.docs.map(d => ({ _fsId: d.id, ...d.data() }))),
      err  => console.warn('[SokoniOrders] disputes:', err.message)
    );
  },

  /* ── Escrow helpers ── */
  async getEscrowSummary() {
    /* Sum up all held escrow — intended for admin dashboard
       Returns { totalHeld, totalReleased, totalRefunded } */
    const snap = await getDocs ?
      import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js')
        .then(({ getDocs }) => getDocs(query(collection(db, 'orders'), where('escrow.held', '>', 0))))
        .catch(() => null) : null;
    if (!snap) return { totalHeld: 0, totalReleased: 0, totalRefunded: 0 };
    let held = 0, released = 0, refunded = 0;
    snap.docs.forEach(d => {
      const e = d.data().escrow || {};
      held     += Number(e.held     || 0);
      released += Number(e.released || 0);
      refunded += Number(e.refunded || 0);
    });
    return { totalHeld: held, totalReleased: released, totalRefunded: refunded };
  },

  /* ── Seller sales analytics ── */
  listenSellerAnalytics(sellerUid, callback) {
    const q = query(
      collection(db, 'orders'),
      where('sellerUid', '==', sellerUid),
      where('status', 'in', [ORDER_STATUS.COMPLETED, ORDER_STATUS.DELIVERED]),
      orderBy('createdAt', 'desc'),
      limit(100)
    );
    return onSnapshot(q, snap => {
      const orders = snap.docs.map(d => d.data());
      const today  = new Date(); today.setHours(0,0,0,0);
      const week   = new Date(today); week.setDate(week.getDate() - 7);
      const month  = new Date(today); month.setDate(1);

      const revenue    = { today: 0, week: 0, month: 0, total: 0 };
      const counts     = { today: 0, week: 0, month: 0, total: 0 };
      const statusMap  = {};

      orders.forEach(o => {
        const ts = o.createdAt ? new Date(o.createdAt) : new Date();
        const net = o.sellerNet || 0;
        revenue.total += net; counts.total++;
        (statusMap[o.status] = (statusMap[o.status] || 0) + 1);
        if (ts >= today)  { revenue.today += net; counts.today++; }
        if (ts >= week)   { revenue.week  += net; counts.week++;  }
        if (ts >= month)  { revenue.month += net; counts.month++; }
      });

      callback({ revenue, counts, statusMap, orders });
    }, err => console.warn('[SokoniOrders] analytics:', err.message));
  },

  /* ── Driver earnings ── */
  listenDriverEarnings(driverUid, callback) {
    const q = query(
      collection(db, 'orders'),
      where('assignedDriverUid', '==', driverUid),
      where('status', 'in', [ORDER_STATUS.DELIVERED, ORDER_STATUS.COMPLETED]),
      orderBy('createdAt', 'desc'),
      limit(200)
    );
    return onSnapshot(q, snap => {
      const orders   = snap.docs.map(d => d.data());
      const today    = new Date(); today.setHours(0,0,0,0);
      const week     = new Date(today); week.setDate(week.getDate() - 7);
      const month    = new Date(today); month.setDate(1);
      let todayE = 0, weekE = 0, monthE = 0, totalE = 0;
      orders.forEach(o => {
        const ts  = o.createdAt ? new Date(o.createdAt) : new Date();
        const net = o.driverNet || 0;
        totalE += net;
        if (ts >= today)  todayE += net;
        if (ts >= week)   weekE  += net;
        if (ts >= month)  monthE += net;
      });
      callback({ today: todayE, week: weekE, month: monthE, total: totalE, trips: orders.length, orders });
    }, err => console.warn('[SokoniOrders] driverEarnings:', err.message));
  },

  /* ── Helpers ── */
  getStatusMeta(status) {
    return STATUS_META[status] || { label: status, icon: '●', color: '#aaa' };
  },

  canTransition(fromStatus, toStatus) {
    return (TRANSITIONS[fromStatus] || []).includes(toStatus);
  },

  getNextStatuses(fromStatus) {
    return TRANSITIONS[fromStatus] || [];
  },
};

/* ── Global exposure ── */
if (typeof window !== 'undefined') {
  window.SokoniOrders = SokoniOrders;
  window.ORDER_STATUS = ORDER_STATUS;
  window.dispatchEvent(new CustomEvent('sokoniOrdersReady'));
}

export default SokoniOrders;
