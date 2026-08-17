'use strict';
/**
 * SOKONI — SmartPOS Completeness Engine (Sprint 4.1)
 * Gift Cards • Layaway • Park & Suspend Sales • KDS • Cycle Count • Multi-Currency
 * 25 Cloud Functions — enforceAppCheck: true on all onCall CFs
 */
const { onCall } = require('firebase-functions/v2/https');
const admin = require('firebase-admin');
/* Server-side product ownership predicate — Admin SDK writes bypass firestore.rules.
   Placed in the HANDLER body, not the export, because these handlers are reachable
   both as their own onCall AND through smartpos-dispatch.js. */
const _productAuthority = require('./shared/product-authority');

exports._h = {}; // handler registry — consumed by smartpos-dispatch.js

// ─── Helpers ─────────────────────────────────────────────────────────────────

function _db() { return admin.firestore(); }
function _fv() { return admin.firestore.FieldValue; }
function _ts() { return admin.firestore.FieldValue.serverTimestamp(); }

function _genId() {
  return _db().collection('_').doc().id;
}

// 16-char gift card code: XXXX-XXXX-XXXX-XXXX (no ambiguous chars)
function _genGiftCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 16; i++) {
    if (i > 0 && i % 4 === 0) code += '-';
    const rand = Math.floor(admin.firestore.Timestamp.now().seconds % 1000 + Math.random() * 1000) % chars.length;
    code += chars[rand];
  }
  return code;
}

async function _assertPOS(auth, shopId) {
  if (!auth || !auth.uid) throw new Error('unauthenticated');
  if (!shopId) throw new Error('shopId-required');
  const shopSnap = await _db().collection('shops').doc(shopId).get();
  if (!shopSnap.exists) throw new Error('shop-not-found');
  const shop = shopSnap.data();
  const uid = auth.uid;
  const role = (auth.token && auth.token.role) || '';
  if (['admin', 'super_admin'].includes(role)) return shop;
  if (shop.ownerId === uid) return shop;
  // Check employee
  const empSnap = await _db().collection('shopEmployees')
    .where('shopId', '==', shopId).where('uid', '==', uid).limit(1).get();
  if (empSnap.empty) throw new Error('forbidden');
  return shop;
}

async function _assertAdmin(auth) {
  if (!auth || !auth.uid) throw new Error('unauthenticated');
  const role = (auth.token && auth.token.role) || '';
  if (!['admin', 'super_admin'].includes(role)) throw new Error('forbidden');
}

// ─── GIFT CARDS ──────────────────────────────────────────────────────────────
// Collections: giftCards/{code}

exports.giftCardIssue = onCall({ enforceAppCheck: true }, exports._h.giftCardIssue = async (req) => {
  const { shopId, amount, pin, recipientName } = req.data;
  await _assertPOS(req.auth, shopId);
  if (!amount || amount <= 0 || amount > 100000) throw new Error('invalid-amount');

  // Generate a unique code with collision check
  let code, attempts = 0;
  do {
    code = _genGiftCode();
    const exists = (await _db().collection('giftCards').doc(code).get()).exists;
    if (!exists) break;
    attempts++;
  } while (attempts < 10);
  if (attempts >= 10) throw new Error('code-generation-failed');

  const expiryDate = new Date();
  expiryDate.setFullYear(expiryDate.getFullYear() + 2);

  await _db().collection('giftCards').doc(code).set({
    code,
    shopId,
    initialBalance: amount,
    balance: amount,
    pin: pin || null,
    recipientName: recipientName || null,
    issuedBy: req.auth.uid,
    issuedAt: _ts(),
    expiryDate: admin.firestore.Timestamp.fromDate(expiryDate),
    status: 'active',       // active | redeemed | void
    redemptions: [],
  });

  return { code, amount, expiryDate: expiryDate.toISOString() };
});

exports.giftCardRedeem = onCall({ enforceAppCheck: true }, exports._h.giftCardRedeem = async (req) => {
  const { shopId, code, pin, amount } = req.data;
  await _assertPOS(req.auth, shopId);
  if (!code || !amount || amount <= 0) throw new Error('invalid-input');

  const cardRef = _db().collection('giftCards')
    .doc(code.replace(/[\s-]/g, '').toUpperCase().match(/.{1,4}/g).join('-'));

  return _db().runTransaction(async (tx) => {
    const snap = await tx.get(cardRef);
    if (!snap.exists) throw new Error('card-not-found');
    const card = snap.data();
    if (card.shopId !== shopId) throw new Error('card-not-valid-for-shop');
    if (card.status !== 'active') throw new Error(`card-${card.status}`);
    if (card.pin && card.pin !== String(pin)) throw new Error('invalid-pin');
    if (card.expiryDate && card.expiryDate.toDate() < new Date()) throw new Error('card-expired');
    if (card.balance < amount) throw new Error('insufficient-balance');

    const newBalance = parseFloat((card.balance - amount).toFixed(2));
    const redemption = { amount, by: req.auth.uid, at: new Date().toISOString() };

    tx.update(cardRef, {
      balance: newBalance,
      status: newBalance <= 0 ? 'redeemed' : 'active',
      redemptions: _fv().arrayUnion(redemption),
      updatedAt: _ts(),
    });

    return { newBalance, amountRedeemed: amount, fullyRedeemed: newBalance <= 0 };
  });
});

exports.giftCardBalance = onCall({ enforceAppCheck: true }, exports._h.giftCardBalance = async (req) => {
  const { code } = req.data;
  if (!code || !req.auth) throw new Error('invalid-input');
  const snap = await _db().collection('giftCards')
    .doc(code.replace(/[\s-]/g, '').toUpperCase().match(/.{1,4}/g).join('-')).get();
  if (!snap.exists) throw new Error('card-not-found');
  const c = snap.data();
  return {
    balance: c.balance,
    initialBalance: c.initialBalance,
    status: c.status,
    recipientName: c.recipientName,
    expiryDate: c.expiryDate,
    redemptionCount: (c.redemptions || []).length,
  };
});

exports.giftCardVoid = onCall({ enforceAppCheck: true }, exports._h.giftCardVoid = async (req) => {
  const { shopId, code, reason } = req.data;
  await _assertPOS(req.auth, shopId);
  const ref = _db().collection('giftCards')
    .doc(code.replace(/[\s-]/g, '').toUpperCase().match(/.{1,4}/g).join('-'));
  const snap = await ref.get();
  if (!snap.exists) throw new Error('card-not-found');
  if (snap.data().shopId !== shopId) throw new Error('forbidden');
  if (snap.data().status === 'void') throw new Error('already-voided');
  await ref.update({
    status: 'void',
    balance: 0,
    voidedBy: req.auth.uid,
    voidedAt: _ts(),
    voidReason: reason || '',
  });
  return { success: true };
});

exports.giftCardList = onCall({ enforceAppCheck: true }, exports._h.giftCardList = async (req) => {
  const { shopId, status } = req.data;
  await _assertPOS(req.auth, shopId);
  const snap = await _db().collection('giftCards')
    .where('shopId', '==', shopId).limit(100).get();
  let cards = snap.docs.map(d => ({ code: d.id, ...d.data() }));
  if (status) cards = cards.filter(c => c.status === status);
  cards.sort((a, b) => {
    const aT = a.issuedAt && a.issuedAt.toMillis ? a.issuedAt.toMillis() : 0;
    const bT = b.issuedAt && b.issuedAt.toMillis ? b.issuedAt.toMillis() : 0;
    return bT - aT;
  });
  return { cards };
});

// ─── LAYAWAY ─────────────────────────────────────────────────────────────────
// Collections: layaways/{id}
// Payments stored as array in doc (avoids subcollection + no extra index)

exports.layawayCreate = onCall({ enforceAppCheck: true }, exports._h.layawayCreate = async (req) => {
  const {
    shopId, customerName, customerPhone, items,
    depositAmount, totalAmount, depositMethod, dueDate, notes,
  } = req.data;
  await _assertPOS(req.auth, shopId);
  if (!items || items.length === 0) throw new Error('no-items');
  if (!totalAmount || totalAmount <= 0) throw new Error('invalid-total');
  if (depositAmount < 0 || depositAmount > totalAmount) throw new Error('invalid-deposit');
  if (!customerName || !customerPhone) throw new Error('customer-info-required');

  const id = _genId();
  const firstPayment = depositAmount > 0 ? [{
    amount: depositAmount,
    method: depositMethod || 'cash',
    paidAt: new Date().toISOString(),
    receivedBy: req.auth.uid,
  }] : [];

  await _db().collection('layaways').doc(id).set({
    shopId,
    cashierId: req.auth.uid,
    customerName,
    customerPhone,
    items,
    totalAmount,
    depositAmount,
    balanceDue: parseFloat((totalAmount - depositAmount).toFixed(2)),
    payments: firstPayment,
    status: 'active',         // active | fulfilled | cancelled
    dueDate: dueDate ? new Date(dueDate) : null,
    notes: notes || '',
    createdAt: _ts(),
    updatedAt: _ts(),
  });

  return { layawayId: id, balanceDue: totalAmount - depositAmount };
});

exports.layawayAddPayment = onCall({ enforceAppCheck: true }, exports._h.layawayAddPayment = async (req) => {
  const { layawayId, shopId, amount, method } = req.data;
  await _assertPOS(req.auth, shopId);
  if (!amount || amount <= 0) throw new Error('invalid-amount');

  const ref = _db().collection('layaways').doc(layawayId);
  return _db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new Error('not-found');
    const lay = snap.data();
    if (lay.shopId !== shopId) throw new Error('forbidden');
    if (lay.status !== 'active') throw new Error('layaway-not-active');
    if (amount > lay.balanceDue + 0.01) throw new Error('amount-exceeds-balance');

    const newBalance = parseFloat(Math.max(0, lay.balanceDue - amount).toFixed(2));
    const payment = { amount, method: method || 'cash', paidAt: new Date().toISOString(), receivedBy: req.auth.uid };

    tx.update(ref, {
      balanceDue: newBalance,
      payments: _fv().arrayUnion(payment),
      updatedAt: _ts(),
    });

    return { balanceDue: newBalance };
  });
});

exports.layawayFulfill = onCall({ enforceAppCheck: true }, exports._h.layawayFulfill = async (req) => {
  const { layawayId, shopId, finalAmount, finalMethod } = req.data;
  await _assertPOS(req.auth, shopId);

  const ref = _db().collection('layaways').doc(layawayId);
  return _db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new Error('not-found');
    const lay = snap.data();
    if (lay.shopId !== shopId) throw new Error('forbidden');
    if (lay.status !== 'active') throw new Error('layaway-not-active');

    let balanceDue = lay.balanceDue;
    const payments = [...lay.payments];

    if (finalAmount && finalAmount > 0) {
      if (finalAmount < balanceDue - 0.01) throw new Error('insufficient-final-payment');
      payments.push({ amount: finalAmount, method: finalMethod || 'cash', paidAt: new Date().toISOString(), receivedBy: req.auth.uid });
      balanceDue = 0;
    }
    if (balanceDue > 0.01) throw new Error('balance-not-cleared');

    const orderId = _genId();
    tx.update(ref, {
      status: 'fulfilled',
      fulfilledAt: _ts(),
      fulfilledBy: req.auth.uid,
      orderId,
      balanceDue: 0,
      payments,
      updatedAt: _ts(),
    });

    return { success: true, orderId };
  });
});

exports.layawayCancel = onCall({ enforceAppCheck: true }, exports._h.layawayCancel = async (req) => {
  const { layawayId, shopId, reason } = req.data;
  await _assertPOS(req.auth, shopId);

  const ref = _db().collection('layaways').doc(layawayId);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('not-found');
  const lay = snap.data();
  if (lay.shopId !== shopId) throw new Error('forbidden');
  if (lay.status !== 'active') throw new Error('already-closed');

  const amountPaid = (lay.payments || []).reduce((s, p) => s + p.amount, 0);

  await ref.update({
    status: 'cancelled',
    cancelledAt: _ts(),
    cancelledBy: req.auth.uid,
    cancelReason: reason || '',
    refundablePaid: amountPaid,
    updatedAt: _ts(),
  });

  return { success: true, refundablePaid: amountPaid };
});

exports.layawayList = onCall({ enforceAppCheck: true }, exports._h.layawayList = async (req) => {
  const { shopId, status } = req.data;
  await _assertPOS(req.auth, shopId);
  const snap = await _db().collection('layaways')
    .where('shopId', '==', shopId).limit(100).get();
  let items = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  if (status) items = items.filter(l => l.status === status);
  items.sort((a, b) => {
    const aT = a.createdAt && a.createdAt.toMillis ? a.createdAt.toMillis() : 0;
    const bT = b.createdAt && b.createdAt.toMillis ? b.createdAt.toMillis() : 0;
    return bT - aT;
  });
  return { layaways: items };
});

// ─── PARK & SUSPEND SALES ────────────────────────────────────────────────────
// Collections: parkedSales/{id}
// Multi-cashier: stored in Firestore so any cashier can retrieve
// Offline fallback: caller can cache in IndexedDB if CF fails

exports.salePark = onCall({ enforceAppCheck: true }, exports._h.salePark = async (req) => {
  const { shopId, slotName, cart, total, discount, customerId, customerName, notes } = req.data;
  await _assertPOS(req.auth, shopId);
  if (!cart || cart.length === 0) throw new Error('empty-cart');

  // Enforce shop limit of 20 parked sales
  const existing = await _db().collection('parkedSales')
    .where('shopId', '==', shopId).limit(21).get();
  if (existing.size >= 20) throw new Error('max-parked-sales-reached');

  const id = _genId();
  await _db().collection('parkedSales').doc(id).set({
    shopId,
    cashierId: req.auth.uid,
    slotName: slotName || 'Parked Sale',
    cart,
    total: total || 0,
    discount: discount || 0,
    customerId: customerId || null,
    customerName: customerName || null,
    notes: notes || '',
    parkedAt: _ts(),
  });

  return { parkId: id };
});

exports.saleRetrieve = onCall({ enforceAppCheck: true }, exports._h.saleRetrieve = async (req) => {
  const { parkId, shopId } = req.data;
  await _assertPOS(req.auth, shopId);

  const ref = _db().collection('parkedSales').doc(parkId);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('not-found');
  const sale = snap.data();
  if (sale.shopId !== shopId) throw new Error('forbidden');

  await ref.delete();

  return {
    cart: sale.cart,
    total: sale.total,
    discount: sale.discount,
    slotName: sale.slotName,
    notes: sale.notes,
    customerId: sale.customerId,
    customerName: sale.customerName,
  };
});

exports.saleListParked = onCall({ enforceAppCheck: true }, exports._h.saleListParked = async (req) => {
  const { shopId } = req.data;
  await _assertPOS(req.auth, shopId);
  const snap = await _db().collection('parkedSales')
    .where('shopId', '==', shopId).limit(20).get();
  const sales = snap.docs.map(d => ({
    parkId: d.id,
    slotName: d.data().slotName,
    total: d.data().total,
    itemCount: (d.data().cart || []).length,
    cashierId: d.data().cashierId,
    parkedAt: d.data().parkedAt,
    customerName: d.data().customerName,
    notes: d.data().notes,
  }));
  sales.sort((a, b) => {
    const aT = a.parkedAt && a.parkedAt.toMillis ? a.parkedAt.toMillis() : 0;
    const bT = b.parkedAt && b.parkedAt.toMillis ? b.parkedAt.toMillis() : 0;
    return bT - aT;
  });
  return { parkedSales: sales };
});

exports.saleDiscardParked = onCall({ enforceAppCheck: true }, exports._h.saleDiscardParked = async (req) => {
  const { parkId, shopId } = req.data;
  await _assertPOS(req.auth, shopId);
  const ref = _db().collection('parkedSales').doc(parkId);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('not-found');
  if (snap.data().shopId !== shopId) throw new Error('forbidden');
  await ref.delete();
  return { success: true };
});

// ─── KITCHEN DISPLAY SYSTEM ──────────────────────────────────────────────────
// Collections: kdsOrders/{id}
// Real-time via onSnapshot on shopId (single-field index — no composite needed)
// Status flow: pending → preparing → ready → bumped

exports.kdsSubmitOrder = onCall({ enforceAppCheck: true }, exports._h.kdsSubmitOrder = async (req) => {
  const { shopId, stationId, items, orderId, orderRef, customerName, tableNumber, notes, priority } = req.data;
  await _assertPOS(req.auth, shopId);
  if (!items || items.length === 0) throw new Error('no-items');

  const id = _genId();
  await _db().collection('kdsOrders').doc(id).set({
    shopId,
    stationId: stationId || 'default',
    orderId: orderId || null,
    orderRef: orderRef || null,
    customerName: customerName || 'Walk-in',
    tableNumber: tableNumber || null,
    notes: notes || '',
    priority: priority || 'normal',   // normal | urgent
    items: items.map(item => ({ ...item, itemStatus: 'pending' })),
    status: 'pending',                 // pending | preparing | ready | bumped
    createdAt: _ts(),
    startedAt: null,
    completedAt: null,
  });

  return { kdsOrderId: id };
});

exports.kdsUpdateItem = onCall({ enforceAppCheck: true }, exports._h.kdsUpdateItem = async (req) => {
  const { kdsOrderId, shopId, itemIndex, itemStatus } = req.data;
  await _assertPOS(req.auth, shopId);
  const VALID = ['preparing', 'ready'];
  if (!VALID.includes(itemStatus)) throw new Error('invalid-status');

  const ref = _db().collection('kdsOrders').doc(kdsOrderId);
  return _db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new Error('not-found');
    const order = snap.data();
    if (order.shopId !== shopId) throw new Error('forbidden');
    if (itemIndex < 0 || itemIndex >= order.items.length) throw new Error('invalid-index');

    const items = order.items.map((item, i) =>
      i === itemIndex ? { ...item, itemStatus } : item
    );

    const allReady = items.every(i => i.itemStatus === 'ready');
    const anyPreparing = items.some(i => i.itemStatus === 'preparing');
    const orderStatus = allReady ? 'ready' : anyPreparing ? 'preparing' : order.status;

    const updates = { items, status: orderStatus, updatedAt: _ts() };
    if (orderStatus === 'preparing' && !order.startedAt) {
      updates.startedAt = _ts();
    }

    tx.update(ref, updates);
    return { orderStatus, allReady };
  });
});

exports.kdsGetQueue = onCall({ enforceAppCheck: true }, exports._h.kdsGetQueue = async (req) => {
  const { shopId, stationId } = req.data;
  await _assertPOS(req.auth, shopId);
  const snap = await _db().collection('kdsOrders')
    .where('shopId', '==', shopId).limit(60).get();
  let orders = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  orders = orders.filter(o => o.status !== 'bumped');
  if (stationId) orders = orders.filter(o => o.stationId === stationId);
  // Sort: urgent first, then oldest first
  orders.sort((a, b) => {
    if (a.priority === 'urgent' && b.priority !== 'urgent') return -1;
    if (b.priority === 'urgent' && a.priority !== 'urgent') return 1;
    const aT = a.createdAt && a.createdAt.toMillis ? a.createdAt.toMillis() : 0;
    const bT = b.createdAt && b.createdAt.toMillis ? b.createdAt.toMillis() : 0;
    return aT - bT;
  });
  return { orders };
});

exports.kdsBump = onCall({ enforceAppCheck: true }, exports._h.kdsBump = async (req) => {
  const { kdsOrderId, shopId } = req.data;
  await _assertPOS(req.auth, shopId);
  const ref = _db().collection('kdsOrders').doc(kdsOrderId);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('not-found');
  if (snap.data().shopId !== shopId) throw new Error('forbidden');
  await ref.update({
    status: 'bumped',
    completedAt: _ts(),
    bumpedBy: req.auth.uid,
  });
  return { success: true };
});

// ─── CYCLE COUNT ─────────────────────────────────────────────────────────────
// Collections: cycleCounts/{id}, inventoryAdjustments/{id}
// All product fetches single-field only (shopId)

exports.cycleCountCreate = onCall({ enforceAppCheck: true }, exports._h.cycleCountCreate = async (req) => {
  const { shopId, warehouseId, productIds, notes } = req.data;
  await _assertPOS(req.auth, shopId);

  let products = [];
  if (productIds && productIds.length > 0) {
    const ids = productIds.slice(0, 200);
    const snaps = await Promise.all(
      ids.map(id => _db().collection('products').doc(id).get())
    );
    products = snaps
      .filter(s => s.exists && s.data().shopId === shopId)
      .map(s => ({ id: s.id, ...s.data() }));
  } else {
    const snap = await _db().collection('products')
      .where('shopId', '==', shopId).limit(200).get();
    products = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  }

  if (products.length === 0) throw new Error('no-products-found');

  const items = products.map(p => ({
    productId: p.id,
    productName: p.name || '',
    sku: p.sku || '',
    barcode: p.barcode || '',
    expectedQty: p.stock || 0,
    countedQty: null,
    variance: null,
  }));

  const id = _genId();
  await _db().collection('cycleCounts').doc(id).set({
    shopId,
    warehouseId: warehouseId || 'main',
    items,
    notes: notes || '',
    status: 'open',           // open | completed | cancelled
    createdBy: req.auth.uid,
    createdAt: _ts(),
    completedAt: null,
    adjustmentsMade: false,
  });

  return { cycleCountId: id, itemCount: items.length };
});

exports.cycleCountUpdateItem = onCall({ enforceAppCheck: true }, exports._h.cycleCountUpdateItem = async (req) => {
  const { cycleCountId, shopId, productId, countedQty } = req.data;
  await _assertPOS(req.auth, shopId);
  if (countedQty == null || countedQty < 0) throw new Error('invalid-qty');

  const ref = _db().collection('cycleCounts').doc(cycleCountId);
  return _db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new Error('not-found');
    const cc = snap.data();
    if (cc.shopId !== shopId) throw new Error('forbidden');
    if (cc.status !== 'open') throw new Error('count-closed');

    const items = cc.items.map(item => {
      if (item.productId !== productId) return item;
      const variance = countedQty - item.expectedQty;
      return { ...item, countedQty, variance };
    });

    tx.update(ref, { items, updatedAt: _ts() });
    const updated = items.find(i => i.productId === productId);
    return { variance: updated ? updated.variance : 0 };
  });
});

exports.cycleCountComplete = onCall({ enforceAppCheck: true }, exports._h.cycleCountComplete = async (req) => {
  const { cycleCountId, shopId, adjustInventory } = req.data;
  const _shop = await _assertPOS(req.auth, shopId);

  const ref = _db().collection('cycleCounts').doc(cycleCountId);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('not-found');
  const cc = snap.data();
  if (cc.shopId !== shopId) throw new Error('forbidden');
  if (cc.status !== 'open') throw new Error('count-closed');

  const counted = cc.items.filter(i => i.countedQty !== null);
  if (counted.length === 0) throw new Error('no-items-counted');

  const adjustments = [];

  if (adjustInventory) {
    /* ── OWNERSHIP (Stage E1 / C2) ──────────────────────────────────────────
       _assertPOS bounds the CALLER to a shop, but nothing bound the PRODUCTS to
       that shop: `stock` was set to an arbitrary countedQty on any productId the
       cycle-count document happened to carry. Because this writes through the
       Admin SDK it never reaches firestore.rules, so a POS user authorised for
       shop A could rewrite shop B's stock.

       The relationship proved here is caller -> authorised shop -> shop's seller
       -> product.sellerUid. The seller comes from the shop document _assertPOS
       already loaded (no second read), via sellerUid/uid — NOT `ownerId`, which no
       shop document carries. That dead `ownerId` branch inside _assertPOS is a
       separate finding and is left visible rather than quietly repaired here.

       Resolved before the batch, so a count referencing one foreign product
       commits nothing. */
    const _sellerUid = _productAuthority.shopSellerUidFrom(_shop, shopId);
    const _elevated = _productAuthority.isElevated(req.auth);
    const { found: _owned } = await _productAuthority.resolveOwnedProducts(
      _db(),
      counted.filter((i) => i.variance !== 0).map((i) => i.productId),
      _sellerUid,
      { elevated: _elevated }
    );

    const batch = _db().batch();
    for (const item of counted) {
      if (item.variance === 0) continue;
      /* Unknown product — nothing to adjust. Previously the batch.update would
         have failed the entire commit on a missing document. */
      if (!_owned.has(String(item.productId))) continue;
      // Adjust product stock
      batch.update(_db().collection('products').doc(item.productId), {
        stock: item.countedQty,
        lastStockAdjustment: _ts(),
      });
      // Create audit record
      const adjRef = _db().collection('inventoryAdjustments').doc(_genId());
      batch.set(adjRef, {
        shopId,
        productId: item.productId,
        productName: item.productName,
        adjustmentType: 'cycle_count',
        previousQty: item.expectedQty,
        newQty: item.countedQty,
        variance: item.variance,
        cycleCountId,
        adjustedBy: req.auth.uid,
        adjustedAt: _ts(),
      });
      adjustments.push({
        productId: item.productId,
        productName: item.productName,
        variance: item.variance,
      });
    }
    await batch.commit();
  }

  await ref.update({
    status: 'completed',
    completedAt: _ts(),
    completedBy: req.auth.uid,
    adjustmentsMade: adjustInventory || false,
    adjustmentSummary: adjustments,
  });

  const totalVariance = counted.reduce((s, i) => s + (i.variance || 0), 0);
  return {
    success: true,
    itemsCounted: counted.length,
    adjustmentsMade: adjustments.length,
    totalVariance,
  };
});

exports.cycleCountList = onCall({ enforceAppCheck: true }, exports._h.cycleCountList = async (req) => {
  const { shopId } = req.data;
  await _assertPOS(req.auth, shopId);
  const snap = await _db().collection('cycleCounts')
    .where('shopId', '==', shopId).limit(30).get();
  const counts = snap.docs.map(d => {
    const data = d.data();
    return {
      id: d.id,
      status: data.status,
      createdAt: data.createdAt,
      completedAt: data.completedAt,
      itemCount: (data.items || []).length,
      countedCount: (data.items || []).filter(i => i.countedQty !== null).length,
      adjustmentsMade: data.adjustmentsMade,
      warehouseId: data.warehouseId,
      notes: data.notes,
    };
  });
  counts.sort((a, b) => {
    const aT = a.createdAt && a.createdAt.toMillis ? a.createdAt.toMillis() : 0;
    const bT = b.createdAt && b.createdAt.toMillis ? b.createdAt.toMillis() : 0;
    return bT - aT;
  });
  return { cycleCounts: counts };
});

exports.cycleCountGet = onCall({ enforceAppCheck: true }, exports._h.cycleCountGet = async (req) => {
  const { cycleCountId, shopId } = req.data;
  await _assertPOS(req.auth, shopId);
  const snap = await _db().collection('cycleCounts').doc(cycleCountId).get();
  if (!snap.exists) throw new Error('not-found');
  const cc = snap.data();
  if (cc.shopId !== shopId) throw new Error('forbidden');
  return { id: cycleCountId, ...cc };
});

// ─── MULTI-CURRENCY ───────────────────────────────────────────────────────────
// Collections: currencyRates/{shopId}
// Base currency: KES. Rates stored as units-of-currency-per-KES.
// e.g. USD: 0.0078 means 1 KES = 0.0078 USD → 1 USD = 128 KES

const SUPPORTED_CURRENCIES = ['USD', 'EUR', 'GBP', 'UGX', 'TZS', 'RWF', 'ETB', 'ZAR', 'NGN', 'AED'];

// Conservative fallback rates (KES base) — merchants set accurate rates
const DEFAULT_RATES_TO_KES = {
  USD: 128, EUR: 139, GBP: 162,
  UGX: 0.034, TZS: 0.049, RWF: 0.088,
  ETB: 2.24, ZAR: 6.8, NGN: 0.08, AED: 34.8,
};

/* currencyGetRates: standalone onCall only. Dispatcher handler removed — clients
   call the canonical currency-engine CF directly (verified: pos-completeness.html
   uses direct httpsCallable). Was a dead cross-domain name collision. */
exports.currencyGetRates = onCall({ enforceAppCheck: true }, async (req) => {
  const { shopId } = req.data;
  if (!req.auth) throw new Error('unauthenticated');
  const snap = await _db().collection('currencyRates').doc(shopId).get();
  const rates = snap.exists ? snap.data().rates : DEFAULT_RATES_TO_KES;
  return {
    rates,
    baseCurrency: 'KES',
    updatedAt: snap.exists ? snap.data().updatedAt : null,
    currencies: SUPPORTED_CURRENCIES,
  };
});

exports.currencySetRate = onCall({ enforceAppCheck: true }, exports._h.currencySetRate = async (req) => {
  const { shopId, currency, rateToKES } = req.data;
  await _assertPOS(req.auth, shopId);
  if (!SUPPORTED_CURRENCIES.includes(currency)) throw new Error('unsupported-currency');
  if (!rateToKES || rateToKES <= 0) throw new Error('invalid-rate');
  await _db().collection('currencyRates').doc(shopId).set({
    [`rates.${currency}`]: rateToKES,
    updatedAt: _ts(),
    updatedBy: req.auth.uid,
  }, { merge: true });
  return { success: true };
});
