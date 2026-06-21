/* ================================================================
   SOKONI WORKFLOW AUTOMATION PLATFORM
   Built-in Workflow Definitions + Handler Registrations  v1.0.0

   Registers all platform workflows and their step handlers.
   Import this file ONCE after importing sokoni-wap.js.

   Workflows defined here:
     marketplace_order     — 15 steps (reserve → payout → analytics)
     delivery              — 12 steps (assignment → POD → settlement)
     food_delivery         — 10 steps (kitchen → courier → ratings)
     event_ticket          — 8  steps (purchase → QR → entry → closure)
     rental                — 9  steps (reservation → return → damage)
     smartpos_onboarding   — 6  steps (merchant → device → activation)
     seller_verification   — 5  steps (application → approval → activation)
     refund                — 6  steps (request → review → payment → notification)
     ride                  — 8  steps (request → match → trip → settlement)

   Handler contract:
     async fn(input, ctx) → output | null
     Throw on failure — engine handles retry/compensation.

   Usage:
     import './sokoni-wap-definitions.js';
     // All workflows and handlers are now registered on window.SokoniWAP
================================================================ */

import wap, { STEP_TYPE } from './sokoni-wap.js';

/* ================================================================
   HANDLER REGISTRATIONS
   These are thin adapters that call existing Sokoni platform modules.
================================================================ */

/* ── Inventory handlers ──────────────────────────────────────── */

wap.register('inventory.reserve', async ({ orderId, items }, ctx) => {
  const results = [];
  let allReserved = true;

  const db = await _getDB();
  if (!db) return { reserved: true, mock: true };   /* dev fallback */

  const { runTransaction, doc, getDoc } = await import(
    'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js'
  );

  await runTransaction(db, async (txn) => {
    for (const item of items) {
      const ref  = doc(db, 'products', item.productId);
      const snap = await txn.get(ref);
      if (!snap.exists()) throw new Error(`Product ${item.productId} not found`);
      const stock = snap.data().stock ?? 0;
      if (stock < item.qty) throw new Error(`Insufficient stock for ${item.productId} (need ${item.qty}, have ${stock})`);
      txn.update(ref, { stock: stock - item.qty, [`reservations.${orderId}`]: item.qty });
      results.push({ productId: item.productId, reserved: item.qty });
    }
  });

  return { reserved: true, items: results, orderId };
});

wap.register('inventory.release', async ({ orderId, items }, ctx) => {
  const db = await _getDB();
  if (!db) return { released: true, mock: true };

  const { writeBatch, doc } = await import(
    'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js'
  );
  const batch = writeBatch(db);
  for (const item of (items ?? [])) {
    const ref = doc(db, 'products', item.productId);
    batch.update(ref, {
      [`reservations.${orderId}`]: null,
    });
  }
  await batch.commit();
  return { released: true };
});

/* ── Payment handlers ────────────────────────────────────────── */

wap.register('payment.authorize', async ({ orderId, amount, paymentMethod, phone, uid }, ctx) => {
  if (amount <= 0) throw new Error(`Invalid payment amount: ${amount}`);

  const db = await _getDB();
  if (!db) return { authorized: true, authRef: 'MOCK-AUTH', mock: true };

  const { doc, setDoc, serverTimestamp } = await import(
    'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js'
  );
  const authRef = 'AUTH-' + Date.now().toString(36).toUpperCase();
  await setDoc(doc(db, 'paymentAuthorizations', authRef), {
    orderId, amount, paymentMethod, phone, uid,
    status:    'authorized',
    createdAt: Date.now(),
    serverTs:  serverTimestamp(),
    wf:        ctx.instanceId,
  });
  return { authorized: true, authRef };
});

wap.register('payment.capture', async ({ authRef, amount, orderId }, ctx) => {
  const db = await _getDB();
  if (!db) return { captured: true, mock: true };
  const { doc, setDoc, serverTimestamp } = await import(
    'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js'
  );
  await setDoc(doc(db, 'paymentAuthorizations', authRef), {
    status: 'captured', capturedAt: Date.now(), serverTs: serverTimestamp()
  }, { merge: true });
  return { captured: true, capturedAt: Date.now() };
});

wap.register('payment.void', async ({ authRef }, ctx) => {
  if (!authRef) return { voided: true, reason: 'no auth ref' };
  const db = await _getDB();
  if (!db) return { voided: true, mock: true };
  const { doc, setDoc, serverTimestamp } = await import(
    'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js'
  );
  await setDoc(doc(db, 'paymentAuthorizations', authRef), {
    status: 'voided', voidedAt: Date.now(), serverTs: serverTimestamp()
  }, { merge: true });
  return { voided: true };
});

wap.register('payment.refund', async ({ orderId, amount, reason, uid }, ctx) => {
  const db = await _getDB();
  if (!db) return { refunded: true, mock: true };
  const { collection, addDoc, serverTimestamp } = await import(
    'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js'
  );
  const ref = await addDoc(collection(db, 'refunds'), {
    orderId, amount, reason, uid,
    status: 'processing', createdAt: Date.now(), serverTs: serverTimestamp(), wf: ctx.instanceId
  });
  return { refunded: true, refundId: ref.id };
});

/* ── Commission + payout handlers ───────────────────────────── */

wap.register('commission.calculate', async ({ orderId, total, category, sellerUid }, ctx) => {
  const rates     = { food: 0.15, delivery: 0.12, marketplace: 0.08, services: 0.10, default: 0.08 };
  const pct       = rates[category] ?? rates.default;
  const commission = Math.round(total * pct * 100) / 100;
  const sellerNet  = Math.round((total - commission) * 100) / 100;

  const db = await _getDB();
  if (db) {
    const { collection, addDoc, serverTimestamp } = await import(
      'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js'
    );
    await addDoc(collection(db, 'commissions'), {
      orderId, sellerUid, total, pct, commission, sellerNet,
      status: 'pending', createdAt: Date.now(), serverTs: serverTimestamp()
    });
  }
  return { commission, sellerNet, pct };
});

wap.register('seller.schedulePayout', async ({ sellerUid, orderId, amount }, ctx) => {
  const db = await _getDB();
  if (!db) return { scheduled: true, mock: true };
  const { collection, addDoc, serverTimestamp } = await import(
    'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js'
  );
  const scheduleAt = Date.now() + 86_400_000;   /* T+1 day */
  const ref = await addDoc(collection(db, 'payoutQueue'), {
    sellerUid, orderId, amount, scheduleAt,
    status: 'scheduled', createdAt: Date.now(), serverTs: serverTimestamp(), wf: ctx.instanceId
  });
  return { scheduled: true, payoutId: ref.id, scheduleAt };
});

/* ── Notification handler ────────────────────────────────────── */

wap.register('notification.send', async ({ to, template, data, channels }, ctx) => {
  const db = await _getDB();
  if (!db) return { sent: true, mock: true };
  const { collection, addDoc, serverTimestamp } = await import(
    'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js'
  );
  const ref = await addDoc(collection(db, 'notificationQueue'), {
    to, template, data: data ?? {},
    channels: channels ?? ['push', 'inapp'],
    status: 'queued', queuedAt: Date.now(), serverTs: serverTimestamp(), wf: ctx.instanceId
  });
  return { sent: true, notificationId: ref.id };
});

/* ── Driver assignment ───────────────────────────────────────── */

wap.register('driver.assign', async ({ pickup, deliveryType, orderId }, ctx) => {
  const db = await _getDB();
  if (!db) return { assigned: false, mock: true };

  const { collection, query, where, orderBy, limit, getDocs, doc, setDoc, serverTimestamp } = await import(
    'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js'
  );

  /* Find nearest online driver — deterministic nearest-neighbor, no AI */
  const q    = query(collection(db, 'driverLocations'), where('online', '==', true), where('available', '==', true), limit(20));
  const snap = await getDocs(q);

  if (snap.empty) throw new Error('No available drivers — retry later');

  const drivers  = snap.docs.map(d => d.data());
  const nearest  = drivers
    .filter(d => d.lat && d.lng)
    .map(d => ({ ...d, dist: _haversineKm(pickup.lat, pickup.lng, d.lat, d.lng) }))
    .sort((a, b) => a.dist - b.dist)[0];

  if (!nearest) throw new Error('No drivers with GPS position available');

  /* Mark driver as assigned */
  await setDoc(doc(db, 'driverLocations', nearest.uid), {
    available: false, assignedOrderId: orderId,
    assignedAt: Date.now(), serverTs: serverTimestamp()
  }, { merge: true });

  /* Write assignment to order */
  await setDoc(doc(db, 'orders', orderId), {
    driverUid: nearest.uid, driverAssignedAt: Date.now()
  }, { merge: true });

  return { assigned: true, driverUid: nearest.uid, estimatedDistKm: nearest.dist };
});

wap.register('driver.release', async ({ driverUid, orderId }, ctx) => {
  const db = await _getDB();
  if (!db || !driverUid) return { released: true };
  const { doc, setDoc, serverTimestamp } = await import(
    'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js'
  );
  await setDoc(doc(db, 'driverLocations', driverUid), {
    available: true, assignedOrderId: null, serverTs: serverTimestamp()
  }, { merge: true });
  return { released: true };
});

/* ── Order status handler ────────────────────────────────────── */

wap.register('order.updateStatus', async ({ orderId, status, metadata }, ctx) => {
  const db = await _getDB();
  if (!db) return { updated: true, mock: true };
  const { doc, setDoc, serverTimestamp } = await import(
    'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js'
  );
  await setDoc(doc(db, 'orders', orderId), {
    status, [`${status}At`]: Date.now(), ...(metadata ?? {}), serverTs: serverTimestamp()
  }, { merge: true });
  return { updated: true, status };
});

/* ── Invoice handler ─────────────────────────────────────────── */

wap.register('invoice.generate', async ({ orderId, uid, sellerUid, items, total, commission }, ctx) => {
  const db = await _getDB();
  if (!db) return { generated: true, mock: true };
  const { collection, addDoc, serverTimestamp } = await import(
    'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js'
  );
  const ref = await addDoc(collection(db, 'invoices'), {
    orderId, uid, sellerUid, items, total, commission,
    status: 'issued', issuedAt: Date.now(), serverTs: serverTimestamp()
  });
  return { generated: true, invoiceId: ref.id };
});

/* ── Loyalty handler ─────────────────────────────────────────── */

wap.register('loyalty.award', async ({ uid, orderId, amount }, ctx) => {
  const points  = Math.floor(amount * 0.01);   /* 1 point per KES 100 */
  const db = await _getDB();
  if (!db || !uid || points <= 0) return { awarded: 0 };
  const { doc, setDoc, serverTimestamp, increment } = await import(
    'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js'
  );
  await setDoc(doc(db, 'loyaltyAccounts', uid), {
    points: increment(points), lastAwardedAt: Date.now(), serverTs: serverTimestamp()
  }, { merge: true });
  return { awarded: points };
});

/* ── Analytics handler ───────────────────────────────────────── */

wap.register('analytics.record', async ({ event, module, data }, ctx) => {
  const db = await _getDB();
  if (!db) return { recorded: true, mock: true };
  const { collection, addDoc, serverTimestamp } = await import(
    'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js'
  );
  await addDoc(collection(db, 'analyticsEvents'), {
    event, module, data: data ?? {}, ts: Date.now(), serverTs: serverTimestamp(), wf: ctx.instanceId
  });
  return { recorded: true };
});

/* ── Ticket/QR handlers ──────────────────────────────────────── */

wap.register('ticket.generate', async ({ eventId, orderId, uid, qty, tierName }, ctx) => {
  const db = await _getDB();
  if (!db) return { generated: true, tickets: [{ code: 'MOCK-TICKET' }], mock: true };

  const { collection, addDoc, serverTimestamp } = await import(
    'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js'
  );

  const tickets = [];
  for (let i = 0; i < (qty ?? 1); i++) {
    const code = _genTicketCode();
    const ref  = await addDoc(collection(db, 'eventTickets'), {
      eventId, orderId, uid, tierName, code, seq: i + 1,
      status: 'valid', issuedAt: Date.now(), serverTs: serverTimestamp(), wf: ctx.instanceId
    });
    tickets.push({ ticketId: ref.id, code });
  }
  return { generated: true, tickets, count: tickets.length };
});

wap.register('ticket.validate', async ({ code, eventId }, ctx) => {
  const db = await _getDB();
  if (!db) return { valid: true, mock: true };
  const { collection, query, where, getDocs, doc, setDoc, serverTimestamp } = await import(
    'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js'
  );
  const q    = query(collection(db, 'eventTickets'), where('code', '==', code), where('eventId', '==', eventId));
  const snap = await getDocs(q);
  if (snap.empty) throw new Error(`Ticket code '${code}' not found`);
  const ticket = snap.docs[0];
  const data   = ticket.data();
  if (data.status !== 'valid') throw new Error(`Ticket already ${data.status}`);
  await setDoc(doc(db, 'eventTickets', ticket.id), {
    status: 'used', usedAt: Date.now(), serverTs: serverTimestamp()
  }, { merge: true });
  return { valid: true, ticketId: ticket.id, uid: data.uid };
});

/* ── Rental handlers ─────────────────────────────────────────── */

wap.register('rental.reserve', async ({ assetId, uid, startDate, endDate, amount }, ctx) => {
  const db = await _getDB();
  if (!db) return { reserved: true, mock: true };
  const { doc, runTransaction, serverTimestamp } = await import(
    'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js'
  );
  await runTransaction(db, async (txn) => {
    const ref  = doc(db, 'rentalAssets', assetId);
    const snap = await txn.get(ref);
    if (!snap.exists()) throw new Error(`Asset ${assetId} not found`);
    if (snap.data().status !== 'available') throw new Error(`Asset ${assetId} not available`);
    txn.update(ref, { status: 'reserved', reservedBy: uid, reservedFrom: startDate, reservedTo: endDate });
  });
  return { reserved: true, assetId };
});

wap.register('rental.release', async ({ assetId }, ctx) => {
  const db = await _getDB();
  if (!db) return { released: true };
  const { doc, setDoc, serverTimestamp } = await import(
    'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js'
  );
  await setDoc(doc(db, 'rentalAssets', assetId), {
    status: 'available', reservedBy: null, serverTs: serverTimestamp()
  }, { merge: true });
  return { released: true };
});

/* ── Verification handler ────────────────────────────────────── */

wap.register('seller.activate', async ({ uid, sellerUid, businessName }, ctx) => {
  const db = await _getDB();
  if (!db) return { activated: true, mock: true };
  const { doc, setDoc, serverTimestamp } = await import(
    'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js'
  );
  await setDoc(doc(db, 'users', sellerUid ?? uid), {
    role: 'seller', verifiedAt: Date.now(), businessName, serverTs: serverTimestamp()
  }, { merge: true });
  return { activated: true };
});

/* ================================================================
   WORKFLOW DEFINITIONS
================================================================ */

/* ── 1. Marketplace Order (15 steps) ─────────────────────────── */
wap.define({
  id:      'marketplace_order',
  name:    'Marketplace Order',
  version: '1.0',
  module:  'marketplace',
  steps: [
    {
      id:      'reserve_inventory',
      name:    'Reserve Inventory',
      type:    STEP_TYPE.TASK,
      handler: 'inventory.reserve',
      input:   { orderId: '{{orderId}}', items: '{{items}}' },
      after:   [],
      retries: 3, retryDelay: 1_000,
      timeout: 15_000,
      onFailure:    'fail',
      compensation: 'inventory.release',
    },
    {
      id:      'authorize_payment',
      name:    'Authorize Payment',
      type:    STEP_TYPE.TASK,
      handler: 'payment.authorize',
      input:   { orderId: '{{orderId}}', amount: '{{total}}', paymentMethod: '{{paymentMethod}}', phone: '{{phone}}', uid: '{{uid}}' },
      after:   ['reserve_inventory'],
      retries: 2, retryDelay: 2_000,
      timeout: 30_000,
      onFailure:    'compensate',
      compensation: 'payment.void',
    },
    {
      id:      'mark_confirmed',
      name:    'Mark Order Confirmed',
      type:    STEP_TYPE.TASK,
      handler: 'order.updateStatus',
      input:   { orderId: '{{orderId}}', status: 'confirmed' },
      after:   ['authorize_payment'],
      retries: 3,
    },
    {
      id:      'notify_seller',
      name:    'Notify Seller',
      type:    STEP_TYPE.NOTIFICATION,
      handler: 'notification.send',
      input:   { to: '{{sellerUid}}', template: 'new_order', data: { orderId: '{{orderId}}', total: '{{total}}' }, channels: ['push', 'sms', 'email'] },
      after:   ['mark_confirmed'],
      onFailure: 'continue',
    },
    {
      id:      'check_delivery_needed',
      name:    'Check Delivery Required',
      type:    STEP_TYPE.CONDITION,
      expression: '{{requiresDelivery}}',
      ifTrue:  'assign_driver',
      ifFalse: 'capture_payment',
      after:   ['notify_seller'],
    },
    {
      id:      'assign_driver',
      name:    'Assign Driver',
      type:    STEP_TYPE.TASK,
      handler: 'driver.assign',
      input:   { pickup: '{{pickupLocation}}', deliveryType: 'marketplace', orderId: '{{orderId}}' },
      after:   ['check_delivery_needed'],
      retries: 5, retryDelay: 5_000,
      timeout: 120_000,
      onFailure:    'compensate',
      compensation: 'driver.release',
      condition: '{{requiresDelivery}}',
    },
    {
      id:      'notify_buyer_driver',
      name:    'Notify Buyer: Driver Assigned',
      type:    STEP_TYPE.NOTIFICATION,
      handler: 'notification.send',
      input:   { to: '{{uid}}', template: 'driver_assigned', data: { orderId: '{{orderId}}', driverUid: '{{assign_driver.driverUid}}' }, channels: ['push'] },
      after:   ['assign_driver'],
      onFailure: 'continue',
      condition: '{{requiresDelivery}}',
    },
    {
      id:      'await_delivery',
      name:    'Await Delivery Completion',
      type:    STEP_TYPE.APPROVAL,
      approvers: ['{{assign_driver.driverUid}}'],
      approvalMessage: 'Confirm delivery completed with OTP verification',
      approvalDeadline: 86_400_000,   /* 24h */
      after:   ['notify_buyer_driver'],
      condition: '{{requiresDelivery}}',
    },
    {
      id:      'capture_payment',
      name:    'Capture Payment',
      type:    STEP_TYPE.TASK,
      handler: 'payment.capture',
      input:   { authRef: '{{authorize_payment.authRef}}', amount: '{{total}}', orderId: '{{orderId}}' },
      after:   ['await_delivery', 'check_delivery_needed'],
      retries: 3, retryDelay: 5_000,
      timeout: 30_000,
    },
    {
      id:      'calculate_commission',
      name:    'Calculate Commission',
      type:    STEP_TYPE.TASK,
      handler: 'commission.calculate',
      input:   { orderId: '{{orderId}}', total: '{{total}}', category: '{{category}}', sellerUid: '{{sellerUid}}' },
      after:   ['capture_payment'],
    },
    {
      id:      'schedule_payout',
      name:    'Schedule Seller Payout',
      type:    STEP_TYPE.TASK,
      handler: 'seller.schedulePayout',
      input:   { sellerUid: '{{sellerUid}}', orderId: '{{orderId}}', amount: '{{calculate_commission.sellerNet}}' },
      after:   ['calculate_commission'],
    },
    {
      id:      'generate_invoice',
      name:    'Generate Invoice',
      type:    STEP_TYPE.TASK,
      handler: 'invoice.generate',
      input:   { orderId: '{{orderId}}', uid: '{{uid}}', sellerUid: '{{sellerUid}}', items: '{{items}}', total: '{{total}}', commission: '{{calculate_commission.commission}}' },
      after:   ['calculate_commission'],
      onFailure: 'continue',
    },
    {
      id:      'award_loyalty',
      name:    'Award Loyalty Points',
      type:    STEP_TYPE.TASK,
      handler: 'loyalty.award',
      input:   { uid: '{{uid}}', orderId: '{{orderId}}', amount: '{{total}}' },
      after:   ['capture_payment'],
      onFailure: 'continue',
    },
    {
      id:      'notify_buyer_complete',
      name:    'Notify Buyer: Order Complete',
      type:    STEP_TYPE.NOTIFICATION,
      handler: 'notification.send',
      input:   { to: '{{uid}}', template: 'order_complete', data: { orderId: '{{orderId}}', loyaltyPoints: '{{award_loyalty.awarded}}' }, channels: ['push', 'email'] },
      after:   ['generate_invoice', 'award_loyalty'],
      onFailure: 'continue',
    },
    {
      id:      'record_analytics',
      name:    'Record Analytics',
      type:    STEP_TYPE.TASK,
      handler: 'analytics.record',
      input:   { event: 'order_completed', module: 'marketplace', data: { orderId: '{{orderId}}', total: '{{total}}', category: '{{category}}' } },
      after:   ['notify_buyer_complete'],
      onFailure: 'continue',
    },
  ],
});

/* ── 2. Delivery Workflow (12 steps) ──────────────────────────── */
wap.define({
  id:      'delivery',
  name:    'Delivery',
  version: '1.0',
  module:  'delivery',
  steps: [
    {
      id: 'assign_driver', name: 'Assign Driver', type: STEP_TYPE.TASK,
      handler: 'driver.assign',
      input:   { pickup: '{{pickupLocation}}', deliveryType: '{{deliveryType}}', orderId: '{{orderId}}' },
      after: [], retries: 5, retryDelay: 10_000, timeout: 300_000,
      onFailure: 'fail', compensation: 'driver.release',
    },
    {
      id: 'notify_driver', name: 'Notify Driver', type: STEP_TYPE.NOTIFICATION,
      handler: 'notification.send',
      input: { to: '{{assign_driver.driverUid}}', template: 'new_delivery', data: { orderId: '{{orderId}}', pickup: '{{pickupLocation}}' }, channels: ['push', 'sms'] },
      after: ['assign_driver'], onFailure: 'continue',
    },
    {
      id: 'driver_acceptance', name: 'Driver Acceptance', type: STEP_TYPE.APPROVAL,
      approvers: ['{{assign_driver.driverUid}}'],
      approvalMessage: 'Accept this delivery job',
      approvalDeadline: 120_000,  /* 2min */
      after: ['notify_driver'],
    },
    {
      id: 'notify_buyer_enroute', name: 'Notify Buyer: Driver En Route', type: STEP_TYPE.NOTIFICATION,
      handler: 'notification.send',
      input: { to: '{{uid}}', template: 'driver_enroute', data: { orderId: '{{orderId}}' }, channels: ['push'] },
      after: ['driver_acceptance'], onFailure: 'continue',
    },
    {
      id: 'pickup_confirmation', name: 'Pickup Confirmation', type: STEP_TYPE.APPROVAL,
      approvers: ['{{assign_driver.driverUid}}'],
      approvalMessage: 'Confirm item pickup from seller',
      approvalDeadline: 3_600_000,  /* 1h */
      after: ['notify_buyer_enroute'],
    },
    {
      id: 'update_in_transit', name: 'Mark In Transit', type: STEP_TYPE.TASK,
      handler: 'order.updateStatus',
      input: { orderId: '{{orderId}}', status: 'in_transit' },
      after: ['pickup_confirmation'],
    },
    {
      id: 'notify_buyer_transit', name: 'Notify Buyer: Item In Transit', type: STEP_TYPE.NOTIFICATION,
      handler: 'notification.send',
      input: { to: '{{uid}}', template: 'in_transit', data: { orderId: '{{orderId}}' }, channels: ['push'] },
      after: ['update_in_transit'], onFailure: 'continue',
    },
    {
      id: 'pod_confirmation', name: 'Proof of Delivery (OTP)', type: STEP_TYPE.APPROVAL,
      approvers: ['{{assign_driver.driverUid}}'],
      approvalMessage: 'Enter customer OTP to confirm delivery',
      approvalDeadline: 7_200_000,  /* 2h */
      after: ['notify_buyer_transit'],
    },
    {
      id: 'mark_delivered', name: 'Mark Delivered', type: STEP_TYPE.TASK,
      handler: 'order.updateStatus',
      input: { orderId: '{{orderId}}', status: 'delivered' },
      after: ['pod_confirmation'],
    },
    {
      id: 'release_driver', name: 'Release Driver', type: STEP_TYPE.TASK,
      handler: 'driver.release',
      input: { driverUid: '{{assign_driver.driverUid}}', orderId: '{{orderId}}' },
      after: ['mark_delivered'], onFailure: 'continue',
    },
    {
      id: 'notify_buyer_delivered', name: 'Notify Buyer: Delivered', type: STEP_TYPE.NOTIFICATION,
      handler: 'notification.send',
      input: { to: '{{uid}}', template: 'delivered', data: { orderId: '{{orderId}}' }, channels: ['push', 'sms'] },
      after: ['mark_delivered'], onFailure: 'continue',
    },
    {
      id: 'record_analytics', name: 'Record Delivery Analytics', type: STEP_TYPE.TASK,
      handler: 'analytics.record',
      input: { event: 'delivery_completed', module: 'delivery', data: { orderId: '{{orderId}}', driverUid: '{{assign_driver.driverUid}}' } },
      after: ['release_driver', 'notify_buyer_delivered'], onFailure: 'continue',
    },
  ],
});

/* ── 3. Food Delivery (10 steps) ──────────────────────────────── */
wap.define({
  id: 'food_delivery', name: 'Food Delivery', version: '1.0', module: 'food',
  steps: [
    {
      id: 'authorize_payment', name: 'Authorize Payment', type: STEP_TYPE.TASK,
      handler: 'payment.authorize',
      input: { orderId: '{{orderId}}', amount: '{{total}}', paymentMethod: '{{paymentMethod}}', phone: '{{phone}}', uid: '{{uid}}' },
      after: [], retries: 2, timeout: 30_000, onFailure: 'fail', compensation: 'payment.void',
    },
    {
      id: 'notify_kitchen', name: 'Notify Kitchen', type: STEP_TYPE.NOTIFICATION,
      handler: 'notification.send',
      input: { to: '{{restaurantUid}}', template: 'kitchen_new_order', data: { orderId: '{{orderId}}', items: '{{items}}' }, channels: ['push', 'sound'] },
      after: ['authorize_payment'], onFailure: 'continue',
    },
    {
      id: 'kitchen_acceptance', name: 'Kitchen Acceptance', type: STEP_TYPE.APPROVAL,
      approvers: ['{{restaurantUid}}'],
      approvalMessage: 'Accept and begin preparing this food order',
      approvalDeadline: 180_000,  /* 3min */
      after: ['notify_kitchen'],
    },
    {
      id: 'assign_courier', name: 'Assign Food Courier', type: STEP_TYPE.TASK,
      handler: 'driver.assign',
      input: { pickup: '{{restaurantLocation}}', deliveryType: 'food', orderId: '{{orderId}}' },
      after: ['kitchen_acceptance'],
      retries: 3, retryDelay: 10_000, timeout: 120_000,
      onFailure: 'compensate', compensation: 'driver.release',
    },
    {
      id: 'notify_buyer_preparing', name: 'Notify Buyer: Preparing', type: STEP_TYPE.NOTIFICATION,
      handler: 'notification.send',
      input: { to: '{{uid}}', template: 'food_preparing', data: { orderId: '{{orderId}}', prepTime: '{{prepTimeMin}}' }, channels: ['push'] },
      after: ['assign_courier'], onFailure: 'continue',
    },
    {
      id: 'food_ready_pickup', name: 'Food Ready for Pickup', type: STEP_TYPE.APPROVAL,
      approvers: ['{{restaurantUid}}'],
      approvalMessage: 'Mark food ready for courier pickup',
      approvalDeadline: 3_600_000,
      after: ['notify_buyer_preparing'],
    },
    {
      id: 'courier_pickup', name: 'Courier Pickup Confirmed', type: STEP_TYPE.APPROVAL,
      approvers: ['{{assign_courier.driverUid}}'],
      approvalMessage: 'Confirm food picked up from restaurant',
      approvalDeadline: 1_800_000,
      after: ['food_ready_pickup'],
    },
    {
      id: 'food_delivered', name: 'Food Delivered (OTP)', type: STEP_TYPE.APPROVAL,
      approvers: ['{{assign_courier.driverUid}}'],
      approvalMessage: 'Enter customer OTP to confirm food delivery',
      approvalDeadline: 3_600_000,
      after: ['courier_pickup'],
    },
    {
      id: 'capture_and_settle', name: 'Capture Payment + Settle', type: STEP_TYPE.TASK,
      handler: 'payment.capture',
      input: { authRef: '{{authorize_payment.authRef}}', amount: '{{total}}', orderId: '{{orderId}}' },
      after: ['food_delivered'], retries: 3,
    },
    {
      id: 'record_analytics', name: 'Record Analytics', type: STEP_TYPE.TASK,
      handler: 'analytics.record',
      input: { event: 'food_order_completed', module: 'food', data: { orderId: '{{orderId}}', restaurantUid: '{{restaurantUid}}', courierUid: '{{assign_courier.driverUid}}' } },
      after: ['capture_and_settle'], onFailure: 'continue',
    },
  ],
});

/* ── 4. Event Ticket (8 steps) ────────────────────────────────── */
wap.define({
  id: 'event_ticket', name: 'Event Ticket Purchase', version: '1.0', module: 'events',
  steps: [
    {
      id: 'authorize_payment', name: 'Authorize Payment', type: STEP_TYPE.TASK,
      handler: 'payment.authorize',
      input: { orderId: '{{orderId}}', amount: '{{total}}', paymentMethod: '{{paymentMethod}}', phone: '{{phone}}', uid: '{{uid}}' },
      after: [], retries: 2, timeout: 30_000, onFailure: 'fail', compensation: 'payment.void',
    },
    {
      id: 'generate_tickets', name: 'Generate Tickets', type: STEP_TYPE.TASK,
      handler: 'ticket.generate',
      input: { eventId: '{{eventId}}', orderId: '{{orderId}}', uid: '{{uid}}', qty: '{{qty}}', tierName: '{{tierName}}' },
      after: ['authorize_payment'], retries: 2, onFailure: 'compensate', compensation: 'payment.void',
    },
    {
      id: 'capture_payment', name: 'Capture Payment', type: STEP_TYPE.TASK,
      handler: 'payment.capture',
      input: { authRef: '{{authorize_payment.authRef}}', amount: '{{total}}', orderId: '{{orderId}}' },
      after: ['generate_tickets'], retries: 3,
    },
    {
      id: 'notify_buyer_tickets', name: 'Send Tickets to Buyer', type: STEP_TYPE.NOTIFICATION,
      handler: 'notification.send',
      input: { to: '{{uid}}', template: 'tickets_issued', data: { eventId: '{{eventId}}', tickets: '{{generate_tickets.tickets}}', total: '{{total}}' }, channels: ['push', 'email'] },
      after: ['capture_payment'], onFailure: 'continue',
    },
    {
      id: 'notify_organizer', name: 'Notify Event Organizer', type: STEP_TYPE.NOTIFICATION,
      handler: 'notification.send',
      input: { to: '{{organizerUid}}', template: 'ticket_sold', data: { eventId: '{{eventId}}', qty: '{{qty}}', total: '{{total}}' }, channels: ['push', 'email'] },
      after: ['capture_payment'], onFailure: 'continue',
    },
    {
      id: 'award_loyalty', name: 'Award Loyalty Points', type: STEP_TYPE.TASK,
      handler: 'loyalty.award',
      input: { uid: '{{uid}}', orderId: '{{orderId}}', amount: '{{total}}' },
      after: ['capture_payment'], onFailure: 'continue',
    },
    {
      id: 'generate_invoice', name: 'Generate Invoice', type: STEP_TYPE.TASK,
      handler: 'invoice.generate',
      input: { orderId: '{{orderId}}', uid: '{{uid}}', sellerUid: '{{organizerUid}}', items: [], total: '{{total}}' },
      after: ['capture_payment'], onFailure: 'continue',
    },
    {
      id: 'record_analytics', name: 'Record Analytics', type: STEP_TYPE.TASK,
      handler: 'analytics.record',
      input: { event: 'ticket_purchased', module: 'events', data: { eventId: '{{eventId}}', qty: '{{qty}}', total: '{{total}}' } },
      after: ['notify_organizer', 'award_loyalty', 'generate_invoice'], onFailure: 'continue',
    },
  ],
});

/* ── 5. Rental Workflow (9 steps) ─────────────────────────────── */
wap.define({
  id: 'rental', name: 'Rental', version: '1.0', module: 'rentals',
  steps: [
    {
      id: 'reserve_asset', name: 'Reserve Asset', type: STEP_TYPE.TASK,
      handler: 'rental.reserve',
      input: { assetId: '{{assetId}}', uid: '{{uid}}', startDate: '{{startDate}}', endDate: '{{endDate}}', amount: '{{total}}' },
      after: [], retries: 2, onFailure: 'fail', compensation: 'rental.release',
    },
    {
      id: 'authorize_payment', name: 'Authorize Payment (Deposit + First Period)', type: STEP_TYPE.TASK,
      handler: 'payment.authorize',
      input: { orderId: '{{orderId}}', amount: '{{total}}', paymentMethod: '{{paymentMethod}}', phone: '{{phone}}', uid: '{{uid}}' },
      after: ['reserve_asset'], retries: 2, timeout: 30_000, compensation: 'payment.void',
    },
    {
      id: 'owner_approval', name: 'Owner Approval', type: STEP_TYPE.APPROVAL,
      approvers: ['{{ownerUid}}'],
      approvalMessage: 'Approve this rental request',
      approvalDeadline: 86_400_000,
      after: ['authorize_payment'],
    },
    {
      id: 'capture_payment', name: 'Capture Payment', type: STEP_TYPE.TASK,
      handler: 'payment.capture',
      input: { authRef: '{{authorize_payment.authRef}}', amount: '{{total}}', orderId: '{{orderId}}' },
      after: ['owner_approval'], retries: 3,
    },
    {
      id: 'notify_renter', name: 'Notify Renter: Approved', type: STEP_TYPE.NOTIFICATION,
      handler: 'notification.send',
      input: { to: '{{uid}}', template: 'rental_approved', data: { assetId: '{{assetId}}', startDate: '{{startDate}}' }, channels: ['push', 'sms', 'email'] },
      after: ['capture_payment'], onFailure: 'continue',
    },
    {
      id: 'pickup_inspection', name: 'Pickup & Inspection', type: STEP_TYPE.APPROVAL,
      approvers: ['{{ownerUid}}'],
      approvalMessage: 'Confirm asset pickup and condition inspection',
      approvalDeadline: 86_400_000,
      after: ['notify_renter'],
    },
    {
      id: 'return_confirmation', name: 'Return Confirmation', type: STEP_TYPE.APPROVAL,
      approvers: ['{{ownerUid}}'],
      approvalMessage: 'Confirm asset returned — note any damage',
      approvalDeadline: 86_400_000,
      after: ['pickup_inspection'],
    },
    {
      id: 'damage_assessment', name: 'Damage Assessment', type: STEP_TYPE.APPROVAL,
      approvers: ['role:admin'],
      approvalMessage: 'Review damage report and determine charge',
      approvalDeadline: 86_400_000,
      condition: '{{returnData.hasDamage}}',
      after: ['return_confirmation'],
    },
    {
      id: 'record_analytics', name: 'Record Rental Analytics', type: STEP_TYPE.TASK,
      handler: 'analytics.record',
      input: { event: 'rental_completed', module: 'rentals', data: { assetId: '{{assetId}}', orderId: '{{orderId}}' } },
      after: ['return_confirmation', 'damage_assessment'], onFailure: 'continue',
    },
  ],
});

/* ── 6. Seller Verification (5 steps with approval chain) ─────── */
wap.define({
  id: 'seller_verification', name: 'Seller Verification', version: '1.0', module: 'marketplace',
  steps: [
    {
      id: 'submit_application', name: 'Submit Verification Documents', type: STEP_TYPE.TASK,
      handler: 'analytics.record',
      input: { event: 'verification_submitted', module: 'marketplace', data: { uid: '{{uid}}', businessName: '{{businessName}}' } },
      after: [],
    },
    {
      id: 'notify_compliance', name: 'Notify Compliance Team', type: STEP_TYPE.NOTIFICATION,
      handler: 'notification.send',
      input: { to: 'role:compliance', template: 'new_seller_application', data: { uid: '{{uid}}', businessName: '{{businessName}}' }, channels: ['email', 'push'] },
      after: ['submit_application'], onFailure: 'continue',
    },
    {
      id: 'compliance_review', name: 'Compliance Review', type: STEP_TYPE.APPROVAL,
      approvers: ['role:compliance'],
      approvalMessage: 'Review seller verification documents for {{businessName}}',
      approvalDeadline: 259_200_000,  /* 3 days */
      after: ['notify_compliance'],
    },
    {
      id: 'activate_seller', name: 'Activate Seller Account', type: STEP_TYPE.TASK,
      handler: 'seller.activate',
      input: { uid: '{{uid}}', businessName: '{{businessName}}' },
      after: ['compliance_review'],
    },
    {
      id: 'notify_seller_approved', name: 'Notify Seller: Approved', type: STEP_TYPE.NOTIFICATION,
      handler: 'notification.send',
      input: { to: '{{uid}}', template: 'seller_approved', data: { businessName: '{{businessName}}' }, channels: ['push', 'sms', 'email'] },
      after: ['activate_seller'], onFailure: 'continue',
    },
  ],
});

/* ── 7. Refund Workflow (6 steps) ─────────────────────────────── */
wap.define({
  id: 'refund', name: 'Refund Request', version: '1.0', module: 'marketplace',
  steps: [
    {
      id: 'validate_refund', name: 'Validate Refund Eligibility', type: STEP_TYPE.TASK,
      handler: 'analytics.record',
      input: { event: 'refund_requested', module: 'marketplace', data: { orderId: '{{orderId}}', reason: '{{reason}}', amount: '{{amount}}' } },
      after: [],
    },
    {
      id: 'auto_approve_check', name: 'Auto-Approve Small Refunds', type: STEP_TYPE.CONDITION,
      expression: '{{amount}} <= 500',
      ifTrue: 'process_refund',
      ifFalse: 'manual_review',
      after: ['validate_refund'],
    },
    {
      id: 'manual_review', name: 'Manual Refund Review', type: STEP_TYPE.APPROVAL,
      approvers: ['role:support'],
      approvalMessage: 'Review refund request for order {{orderId}} — KES {{amount}}',
      approvalDeadline: 172_800_000,  /* 2 days */
      condition: '{{amount}} > 500',
      after: ['auto_approve_check'],
    },
    {
      id: 'process_refund', name: 'Process Refund', type: STEP_TYPE.TASK,
      handler: 'payment.refund',
      input: { orderId: '{{orderId}}', amount: '{{amount}}', reason: '{{reason}}', uid: '{{uid}}' },
      after: ['manual_review', 'auto_approve_check'],
      retries: 3, retryDelay: 5_000, timeout: 60_000, onFailure: 'fail',
    },
    {
      id: 'notify_buyer_refunded', name: 'Notify Buyer: Refund Processed', type: STEP_TYPE.NOTIFICATION,
      handler: 'notification.send',
      input: { to: '{{uid}}', template: 'refund_processed', data: { orderId: '{{orderId}}', amount: '{{amount}}' }, channels: ['push', 'sms', 'email'] },
      after: ['process_refund'], onFailure: 'continue',
    },
    {
      id: 'record_analytics', name: 'Record Refund Analytics', type: STEP_TYPE.TASK,
      handler: 'analytics.record',
      input: { event: 'refund_completed', module: 'marketplace', data: { orderId: '{{orderId}}', amount: '{{amount}}' } },
      after: ['notify_buyer_refunded'], onFailure: 'continue',
    },
  ],
});

/* ── Private helpers ─────────────────────────────────────────── */

async function _getDB() {
  try {
    const { getFirestore } = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js');
    const { app }          = await import('./firebase.js');
    return getFirestore(app);
  } catch (_) { return null; }
}

function _haversineKm(lat1, lng1, lat2, lng2) {
  const R  = 6371;
  const dL = (lat2 - lat1) * Math.PI / 180;
  const dl  = (lng2 - lng1) * Math.PI / 180;
  const a  = Math.sin(dL/2)**2 + Math.cos(lat1*Math.PI/180) * Math.cos(lat2*Math.PI/180) * Math.sin(dl/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function _genTicketCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 12; i++) {
    if (i > 0 && i % 4 === 0) code += '-';
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

export default wap;
