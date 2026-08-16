'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const admin = require('firebase-admin');

const CF_OPTIONS = { region: 'us-central1', enforceAppCheck: true };
const db = admin.firestore();
const FieldValue = admin.firestore.FieldValue;
const { writeAudit } = require('./pos-audit');

function _requireAuth(auth) {
  if (!auth) throw new HttpsError('unauthenticated', 'Sign in required.');
}

function _requireRole(auth, minRole) {
  _requireAuth(auth);
  const LEVELS = { cashier: 0, supervisor: 1, manager: 2, owner: 3, admin: 4, super_admin: 5 };
  const r = auth.token.role;
  const level = typeof r === 'number' ? r : (LEVELS[r] ?? 0);
  if (level < minRole) throw new HttpsError('permission-denied', 'Insufficient role.');
}

function _isElevated(auth) {
  const r = auth?.token?.role;
  return r === 'admin' || r === 'super_admin' || r === 4 || r === 5;
}

function _ownerOrAdmin(auth, sellerId) {
  if (auth.uid !== sellerId && !_isElevated(auth))
    throw new HttpsError('permission-denied', 'Access denied.');
}

/* ── 1. createClickAndCollect ───────────────────────────────────────────────
   Called from marketplace checkout when buyer selects "Pick up at store".
   Atomically reserves stock and writes the C&C order to the seller's
   subcollection. Stock is already decremented at order time so the seller
   never oversells. Cancelled orders atomically restore stock.
   ─────────────────────────────────────────────────────────────────────────── */
exports.createClickAndCollect = onCall(CF_OPTIONS, async ({ auth, data }) => {
  _requireAuth(auth);

  const { sellerId, items, paymentMethod = 'counter', notes, pickupTime } = data;

  if (!sellerId) throw new HttpsError('invalid-argument', 'sellerId required.');
  if (!Array.isArray(items) || !items.length) throw new HttpsError('invalid-argument', 'items required.');
  if (!['counter', 'prepaid'].includes(paymentMethod))
    throw new HttpsError('invalid-argument', "paymentMethod must be 'counter' or 'prepaid'.");

  // Validate against the ONE canonical `products` collection. This previously read the
  // sellers/{uid}/products SUBCOLLECTION, which is empty — so C&C always failed AND would have
  // kept a stock pool separate from marketplace/POS. Now C&C shares the single products.stock.
  // Ownership is enforced so a shop can only sell its own items.
  const lineItems = [];
  let subtotal = 0;

  for (const { productId, qty } of items) {
    if (!productId || !qty || qty < 1) throw new HttpsError('invalid-argument', 'Invalid item entry.');
    const prodSnap = await db.collection('products').doc(String(productId)).get();
    if (!prodSnap.exists) throw new HttpsError('not-found', `Product ${productId} not found.`);
    const pd = prodSnap.data();
    if (String(pd.sellerUid || pd.uid || '') !== String(sellerId))
      throw new HttpsError('permission-denied', `Product ${productId} does not belong to this shop.`);
    if (pd.active === false || String(pd.status || '').toLowerCase() === 'inactive')
      throw new HttpsError('failed-precondition', `${pd.name} is not currently available.`);
    const _stk = Number(pd.stock ?? pd.stockQty ?? pd.quantity ?? 0);
    if (_stk < qty)
      throw new HttpsError('failed-precondition', `Insufficient stock for ${pd.name}. Available: ${_stk}`);
    lineItems.push({
      productId: String(productId),
      name: pd.name,
      price: pd.price,
      imageUrl: pd.imageUrl || pd.image || null,
      qty,
      lineTotal: pd.price * qty,
    });
    subtotal += pd.price * qty;
  }

  const orderId = db.collection('_').doc().id;

  await db.runTransaction(async (t) => {
    // TOCTOU-safe: re-read canonical stock inside the txn (all reads before any writes), floor
    // at zero, reject if a concurrent sale emptied it. Bumps inventoryVersion + stamps source so
    // the indexProductUpdate trigger records the movement to inventoryMovements.
    const refs  = lineItems.map((li) => db.collection('products').doc(li.productId));
    const snaps = await Promise.all(refs.map((r) => t.get(r)));
    for (let i = 0; i < lineItems.length; i++) {
      if (!snaps[i].exists) throw new HttpsError('not-found', `Product ${lineItems[i].productId} not found.`);
      const d = snaps[i].data();
      const cur = Number(d.stock ?? d.stockQty ?? d.quantity ?? 0);
      if (cur < lineItems[i].qty)
        throw new HttpsError('failed-precondition', `Insufficient stock for ${lineItems[i].name}. Available: ${cur}`);
    }
    for (let i = 0; i < lineItems.length; i++) {
      const d = snaps[i].data();
      const cur = Number(d.stock ?? d.stockQty ?? d.quantity ?? 0);
      t.update(refs[i], {
        stock:            Math.max(0, cur - lineItems[i].qty),
        sold:             FieldValue.increment(lineItems[i].qty),
        inventoryVersion: FieldValue.increment(1),
        updatedAt:        FieldValue.serverTimestamp(),
        lastSaleOrderId:  orderId,
        lastStockSource:  'click-and-collect',
      });
    }
    t.set(db.doc(`sellers/${sellerId}/clickAndCollect/${orderId}`), {
      orderId,
      sellerId,
      customerId:    auth.uid,
      customerName:  auth.token.name || 'Customer',
      customerPhone: auth.token.phone_number || null,
      customerEmail: auth.token.email || null,
      items:         lineItems,
      subtotal,
      total:         subtotal,
      paymentMethod,
      notes:         notes || null,
      pickupTime:    pickupTime || null,
      status:        'pending',
      createdAt:     FieldValue.serverTimestamp(),
      readyAt:       null,
      collectedAt:   null,
      cancelledAt:   null,
    });
  });

  return {
    orderId,
    total: subtotal,
    status: 'pending',
    message: 'Order placed. Your items are being prepared for pickup.',
  };
});

/* ── 2. getPendingClickAndCollect ───────────────────────────────────────────
   POS screen fetches open C&C orders for this seller.
   Uses subcollection so only a single-field 'status' filter is needed
   — no composite index required.
   ─────────────────────────────────────────────────────────────────────────── */
exports.getPendingClickAndCollect = onCall(CF_OPTIONS, async ({ auth, data }) => {
  _requireRole(auth, 0);
  const { sellerId, status = 'pending' } = data;
  _ownerOrAdmin(auth, sellerId);

  const VALID = ['pending', 'ready', 'collected', 'cancelled'];
  if (!VALID.includes(status)) throw new HttpsError('invalid-argument', 'Invalid status.');

  const snap = await db
    .collection(`sellers/${sellerId}/clickAndCollect`)
    .where('status', '==', status)
    .orderBy('createdAt', 'asc')
    .limit(100)
    .get();

  return {
    orders: snap.docs.map((d) => {
      const o = d.data();
      return {
        ...o,
        id: d.id,
        createdAt:   o.createdAt?.toDate?.()?.toISOString() ?? null,
        readyAt:     o.readyAt?.toDate?.()?.toISOString() ?? null,
        collectedAt: o.collectedAt?.toDate?.()?.toISOString() ?? null,
      };
    }),
    count: snap.size,
  };
});

/* ── 3. updateClickAndCollectStatus ─────────────────────────────────────────
   Cashier marks order ready → collected, or cancels.
   Cancellation restores stock atomically.
   Valid transitions: pending→ready, pending→cancelled, ready→collected,
                      ready→cancelled.
   ─────────────────────────────────────────────────────────────────────────── */
exports.updateClickAndCollectStatus = onCall(CF_OPTIONS, async ({ auth, data }) => {
  _requireRole(auth, 0);
  const { sellerId, orderId, status } = data;
  _ownerOrAdmin(auth, sellerId);

  if (!orderId || !status) throw new HttpsError('invalid-argument', 'orderId and status required.');
  if (!['ready', 'collected', 'cancelled'].includes(status))
    throw new HttpsError('invalid-argument', "status must be 'ready', 'collected', or 'cancelled'.");

  const ref = db.doc(`sellers/${sellerId}/clickAndCollect/${orderId}`);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Order not found.');

  const order = snap.data();
  const TRANSITIONS = { pending: ['ready', 'cancelled'], ready: ['collected', 'cancelled'] };
  if (!(TRANSITIONS[order.status] ?? []).includes(status))
    throw new HttpsError(
      'failed-precondition',
      `Cannot transition from '${order.status}' to '${status}'.`
    );

  const now = FieldValue.serverTimestamp();
  const update = { status, updatedAt: now, updatedBy: auth.uid };
  if (status === 'ready')     update.readyAt = now;
  if (status === 'collected') update.collectedAt = now;
  if (status === 'cancelled') update.cancelledAt = now;

  if (status === 'cancelled') {
    await db.runTransaction(async (t) => {
      // Restore stock to the SAME canonical products.stock the order deducted (was the empty
      // sellers/{uid}/products subcollection). Bumps inventoryVersion + stamps source so the
      // indexProductUpdate trigger records a 'restock' movement.
      for (const item of order.items ?? []) {
        t.update(db.collection('products').doc(String(item.productId)), {
          stock:            FieldValue.increment(item.qty),
          inventoryVersion: FieldValue.increment(1),
          updatedAt:        FieldValue.serverTimestamp(),
          lastStockSource:  'click-and-collect-cancel',
        });
      }
      t.update(ref, update);
    });
  } else {
    await ref.update(update);
  }

  /* ── Audit (canonical schema) — authoritative, server-written record of this dispatch action.
     RBAC is already enforced above (_requireRole + _ownerOrAdmin); this is the tamper-evident trail. */
  writeAudit(db, {
    action:     'pos.dispatch.status',
    actorUid:   auth.uid,
    actorRole:  (auth.token && auth.token.role) || null,
    branchId:   order.branchId || 'default',
    objectType: 'order',
    objectId:   orderId,
    before:     { status: order.status },
    after:      { status },
    metadata:   { sellerId, fulfillmentType: order.fulfillmentType || 'delivery' },
  });

  /* ── Ready-for-Dispatch: decouple dispatch from printing ──────────────────────
     Marking a DELIVERY order ready creates the rider-visible dispatch job
     (packageRequests, status awaiting_rider) and notifies the buyer. Pickup just
     notifies. Best-effort — a dispatch/notify hiccup never blocks the status write. */
  if (status === 'ready') {
    try {
      const isPickup = (order.fulfillmentType || 'delivery') === 'pickup';
      const buyerUid = order.buyerUid || order.uid || null;
      const nowIso   = new Date().toISOString();

      if (!isPickup) {
        const delId  = `DEL${orderId}`;
        const pin    = String(Math.floor(1000 + Math.random() * 9000));
        const fee    = Number(order.deliveryFee || order.delivery || 0);
        await db.doc(`packageRequests/${delId}`).set({
          ref: delId, deliveryRef: delId, orderId, orderRef: orderId,
          buyerName:  order.customerName || order.buyerName || '',
          buyerPhone: order.customerPhone || order.buyerPhone || '', buyerUid,
          sellerName: order.sellerName || 'SOKONI', sellerUid: sellerId,
          pickupAddress:   order.sellerName || 'Shop',
          deliveryAddress: order.deliveryAddress || order.address || '',
          items: (order.items || []).map(i => ({ productId: i.productId || i.id, name: i.name, qty: i.qty || 1 })),
          orderTotal: Number(order.total || 0), deliveryFee: fee,
          driverNet: Math.round(fee * 0.8), commissionPct: 5,
          vehicleType: 'moto', speed: 'same_day', category: 'general',
          /* proofPin is NOT stored on the packageRequest — the assigned rider can
             read this document under firestore.rules, so a plaintext PIN here is
             readable by the party it defends against. It verifies nothing
             server-side; completeDeliveryWithPin checks deliveryPinHash. Moved to
             the CF-only deliveryPins doc, which has no rule and is deny-by-default. */
          status: 'awaiting_rider',
          timeline: [{ status: 'awaiting_rider', at: nowIso, by: 'merchant_ready' }],
          source: 'merchant_ready', createdAt: now,
        }, { merge: true });
        await db.doc(`deliveryPins/${orderId}`).set({
          orderId, deliveryRef: delId, proofPin: pin, buyerUid,
          issuedAt: now,
        }, { merge: true });
        await ref.update({ dispatchStatus: 'awaiting_rider', deliveryRef: delId });
        try { await db.doc(`orders/${orderId}`).set({ status: 'awaiting_rider', deliveryRef: delId, readyAt: now, updatedAt: now }, { merge: true }); } catch (_) {}
      } else {
        try { await db.doc(`orders/${orderId}`).set({ status: 'ready_for_pickup', readyAt: now, updatedAt: now }, { merge: true }); } catch (_) {}
      }

      if (buyerUid) {
        const { notify } = require('./notify');
        await notify({
          uid: buyerUid,
          type: isPickup ? 'order_ready_pickup' : 'order_dispatching',
          title: isPickup ? 'Ready for pickup 🏪' : 'Order being dispatched 🛵',
          body: isPickup
            ? `Your order ${orderId} is ready — collect it at ${order.sellerName || 'the shop'}.`
            : `Your order ${orderId} is prepared and awaiting a rider. We'll notify you when one is assigned.`,
          dedupeKey: `order_ready_${orderId}`,
          data: { orderId },
        }).catch(() => {});
      }
    } catch (e) { console.error('[C&C ready] dispatch/notify failed (recoverable):', e.message); }
  }

  return { orderId, status };
});

/* ── 4. getUnifiedSalesReport ───────────────────────────────────────────────
   Manager-level report combining POS direct sales, marketplace orders,
   and click-and-collect into one view. C&C date filtering done client-side
   to avoid adding a composite index (already at 200/200 Firestore limit).
   ─────────────────────────────────────────────────────────────────────────── */
exports.getUnifiedSalesReport = onCall(CF_OPTIONS, async ({ auth, data }) => {
  _requireRole(auth, 2);
  const { sellerId, startDate, endDate } = data;
  _ownerOrAdmin(auth, sellerId);

  if (!startDate || !endDate)
    throw new HttpsError('invalid-argument', 'startDate and endDate required.');

  const start = new Date(startDate);
  const end   = new Date(endDate);
  if (isNaN(start) || isNaN(end)) throw new HttpsError('invalid-argument', 'Invalid date format.');

  const [posResult, mktResult, ccResult] = await Promise.allSettled([
    db.collection('posAuditLog')
      .where('sellerId', '==', sellerId)
      .where('type', '==', 'SALE')
      .where('createdAt', '>=', start)
      .where('createdAt', '<=', end)
      .orderBy('createdAt')
      .limit(500)
      .get(),
    db.collection('orders')
      .where('sellerId', '==', sellerId)
      .where('status', '==', 'completed')
      .where('createdAt', '>=', start)
      .where('createdAt', '<=', end)
      .orderBy('createdAt')
      .limit(500)
      .get(),
    db.collection(`sellers/${sellerId}/clickAndCollect`)
      .where('status', '==', 'collected')
      .limit(500)
      .get(),
  ]);

  const posDocs = posResult.status === 'fulfilled' ? posResult.value.docs.map((d) => d.data()) : [];
  const mktDocs = mktResult.status === 'fulfilled' ? mktResult.value.docs.map((d) => d.data()) : [];
  const ccDocs  = ccResult.status === 'fulfilled'
    ? ccResult.value.docs
        .map((d) => d.data())
        .filter((o) => {
          const ts = o.collectedAt?.toDate?.() ?? new Date(0);
          return ts >= start && ts <= end;
        })
    : [];

  function aggregate(docs, totalField = 'total') {
    return docs.reduce(
      (acc, d) => {
        acc.revenue += d[totalField] ?? 0;
        acc.count++;
        acc.items += (d.items ?? []).reduce((s, i) => s + (i.qty ?? 1), 0);
        return acc;
      },
      { revenue: 0, count: 0, items: 0 }
    );
  }

  const pos = aggregate(posDocs);
  const mkt = aggregate(mktDocs);
  const cc  = aggregate(ccDocs);
  const totalRevenue = pos.revenue + mkt.revenue + cc.revenue;

  // Top 10 products across all channels
  const productMap = {};
  [...posDocs, ...mktDocs, ...ccDocs].forEach((doc) => {
    (doc.items ?? []).forEach((item) => {
      const key = item.productId ?? item.name ?? 'unknown';
      if (!productMap[key])
        productMap[key] = { name: item.name ?? key, qty: 0, revenue: 0 };
      productMap[key].qty     += item.qty ?? 1;
      productMap[key].revenue += (item.price ?? 0) * (item.qty ?? 1);
    });
  });
  const topProducts = Object.values(productMap)
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 10);

  // Daily trend
  const dailyMap = {};
  const addDaily = (docs, channel) => {
    docs.forEach((d) => {
      const ts = d.createdAt?.toDate?.() ?? new Date();
      const day = ts.toISOString().slice(0, 10);
      if (!dailyMap[day]) dailyMap[day] = { pos: 0, marketplace: 0, clickAndCollect: 0 };
      dailyMap[day][channel] += d.total ?? 0;
    });
  };
  addDaily(posDocs, 'pos');
  addDaily(mktDocs, 'marketplace');
  addDaily(ccDocs,  'clickAndCollect');

  const dailyTrend = Object.entries(dailyMap)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, v]) => ({
      date,
      pos: v.pos,
      marketplace: v.marketplace,
      clickAndCollect: v.clickAndCollect,
      total: v.pos + v.marketplace + v.clickAndCollect,
    }));

  return {
    period: { start: startDate, end: endDate },
    channels: { pos, marketplace: mkt, clickAndCollect: cc },
    totals: {
      revenue: totalRevenue,
      posShare: totalRevenue ? Math.round((pos.revenue / totalRevenue) * 100) : 0,
      mktShare: totalRevenue ? Math.round((mkt.revenue / totalRevenue) * 100) : 0,
      ccShare:  totalRevenue ? Math.round((cc.revenue / totalRevenue)  * 100) : 0,
    },
    topProducts,
    dailyTrend,
  };
});

/* ── 5. syncPromotionToPOS ──────────────────────────────────────────────────
   Manager enables/disables a marketplace promotion at the POS register.
   The POS checkout page reads this flag via getActivePOSPromotions.
   ─────────────────────────────────────────────────────────────────────────── */
exports.syncPromotionToPOS = onCall(CF_OPTIONS, async ({ auth, data }) => {
  _requireRole(auth, 2);
  const { sellerId, promotionId, applyAtPOS } = data;
  _ownerOrAdmin(auth, sellerId);

  if (!promotionId) throw new HttpsError('invalid-argument', 'promotionId required.');

  const ref = db.doc(`sellers/${sellerId}/promotions/${promotionId}`);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Promotion not found.');

  await ref.update({ applyAtPOS: !!applyAtPOS, updatedAt: FieldValue.serverTimestamp() });
  return { promotionId, applyAtPOS: !!applyAtPOS };
});

/* ── 6. getActivePOSPromotions ──────────────────────────────────────────────
   Called at POS checkout to load promotions that apply at the register.
   ValidUntil filtering done client-side to avoid composite index.
   ─────────────────────────────────────────────────────────────────────────── */
exports.getActivePOSPromotions = onCall(CF_OPTIONS, async ({ auth, data }) => {
  _requireRole(auth, 0);
  const { sellerId } = data;
  _ownerOrAdmin(auth, sellerId);

  const snap = await db.collection(`sellers/${sellerId}/promotions`)
    .where('active', '==', true)
    .where('applyAtPOS', '==', true)
    .limit(50)
    .get();

  const now = new Date();
  const promotions = snap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .filter((p) => !p.validUntil || (p.validUntil.toDate?.() ?? new Date(0)) > now);

  return { promotions };
});

/* ── 7. getInventoryReserveStatus ───────────────────────────────────────────
   Shows manager which products have stock reserved for pending/ready C&C orders.
   Useful for understanding real available-to-sell quantity.
   ─────────────────────────────────────────────────────────────────────────── */
exports.getInventoryReserveStatus = onCall(CF_OPTIONS, async ({ auth, data }) => {
  _requireRole(auth, 2);
  const { sellerId } = data;
  _ownerOrAdmin(auth, sellerId);

  const [pendingSnap, readySnap] = await Promise.all([
    db.collection(`sellers/${sellerId}/clickAndCollect`)
      .where('status', '==', 'pending').limit(200).get(),
    db.collection(`sellers/${sellerId}/clickAndCollect`)
      .where('status', '==', 'ready').limit(200).get(),
  ]);

  const reservedMap = {};
  const tally = (docs) => {
    docs.forEach((d) => {
      const order = d.data();
      (order.items ?? []).forEach((item) => {
        if (!reservedMap[item.productId])
          reservedMap[item.productId] = {
            name: item.name,
            reserved: 0,
            orderRefs: [],
          };
        reservedMap[item.productId].reserved += item.qty;
        reservedMap[item.productId].orderRefs.push({
          orderId: order.orderId,
          qty: item.qty,
          status: order.status,
          customerName: order.customerName,
        });
      });
    });
  };
  tally(pendingSnap.docs);
  tally(readySnap.docs);

  if (!Object.keys(reservedMap).length)
    return { reserves: [], totalReservedValue: 0, pendingCount: 0 };

  const refs = Object.keys(reservedMap).map((pid) =>
    db.collection('products').doc(pid)   /* canonical products — the same stock C&C now reserves */
  );
  const productSnaps = await db.getAll(...refs);

  let totalReservedValue = 0;
  const reserves = productSnaps.map((s) => {
    const pid = s.id;
    const pd  = s.data() ?? {};
    const info = reservedMap[pid];
    const reservedValue = (pd.price ?? 0) * info.reserved;
    totalReservedValue += reservedValue;
    return {
      productId:     pid,
      name:          info.name,
      currentStock:  Number(pd.stock ?? pd.stockQty ?? pd.quantity ?? 0),
      reserved:      info.reserved,
      reservedValue,
      orders:        info.orderRefs,
    };
  });

  return {
    reserves,
    totalReservedValue,
    pendingCount: pendingSnap.size + readySnap.size,
  };
});
