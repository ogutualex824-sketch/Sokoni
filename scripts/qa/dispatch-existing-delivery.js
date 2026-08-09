/* dispatch-existing-delivery.js — backfill packageRequests for PAID delivery orders
   that predate the webhook auto-dispatch, so they appear in riders' "Available
   Deliveries" (driver.html) to accept + track.
   USAGE: node scripts/qa/dispatch-existing-delivery.js [orderId]   (default: recent delivery orders w/o deliveryRef) */
'use strict';
const admin = require('../../functions/node_modules/firebase-admin');
admin.initializeApp({ projectId: 'sokoni-aeb26' });
const db = admin.firestore();
db.settings({ ignoreUndefinedProperties: true });
const only = process.argv[2] || null;

async function dispatchOne(o, id) {
  const delRef = 'DEL' + id;
  const ref = db.collection('packageRequests').doc(delRef);
  if ((await ref.get()).exists) { console.log('  already dispatched:', id); return false; }
  const pin = String(Math.floor(1000 + Math.random() * 9000));
  const fee = Number(o.deliveryFee || o.pricing?.deliveryFee || 0);
  await ref.set({
    ref: delRef, deliveryRef: delRef, orderId: id, orderRef: id,
    buyerName: o.buyerName || '', buyerPhone: o.buyerPhone || o.phone || '', buyerUid: o.buyerUid || o.uid || null,
    sellerName: o.sellerName || 'SOKONI', sellerUid: o.sellerUid || null, sellerPhone: o.sellerPhone || '',
    pickupAddress: o.sellerName || 'Shop', pickupCoords: null,
    deliveryAddress: o.deliveryAddress || o.address || '', deliveryCoords: null,
    items: (o.lineItems || o.items || []).map(i => ({ productId: i.productId || i.id, name: i.name, qty: i.qty || 1 })),
    orderTotal: Number(o.total || o.orderTotal || 0), deliveryFee: fee,
    driverNet: Math.round(fee * 0.8), commissionPct: 5,
    vehicleType: 'moto', speed: 'same_day', category: 'general',
    status: 'order_placed', proofPin: pin,
    timeline: [{ status: 'order_placed', at: new Date().toISOString(), by: 'backfill' }],
    source: 'backfill', createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  await db.collection('orders').doc(id).set({ deliveryRef: delRef }, { merge: true });
  console.log('  DISPATCHED:', id, '| buyer:', o.buyerName, '| addr:', (o.deliveryAddress || o.address || '(none)'), '| pin:', pin);
  return true;
}

(async () => {
  let targets = [];
  if (only) {
    const d = await db.collection('orders').doc(only).get();
    if (d.exists) targets = [[only, d.data()]];
  } else {
    const snap = await db.collection('orders').where('status', '==', 'paid').limit(60).get();
    targets = snap.docs.map(d => [d.id, d.data()])
      .filter(([, o]) => (o.fulfillmentType || 'delivery') !== 'pickup' && !o.deliveryRef)
      .sort((a, b) => (b[1].paidAt?.toMillis?.() || 0) - (a[1].paidAt?.toMillis?.() || 0))
      .slice(0, 5);
  }
  console.log('delivery orders to dispatch:', targets.length);
  let n = 0;
  for (const [id, o] of targets) if (await dispatchOne(o, id)) n++;
  console.log(`Done. ${n} delivery(ies) now in riders' Available Deliveries.`);
})().then(() => process.exit(0)).catch((e) => { console.error(e.message); process.exit(1); });
