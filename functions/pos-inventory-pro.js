'use strict';

/**
 * pos-inventory-pro.js
 * SOKONI SmartPOS — Advanced Inventory Management Cloud Functions
 *
 * Sections:
 *   A. Batch / Lot Management          (createBatch, getBatches, consumeBatch)
 *   B. Serial Number Tracking          (registerSerial, getSerial, updateSerialStatus)
 *   C. Warehouse Management            (createWarehouse, getWarehouses, transferWarehouseStock)
 *   D. Purchase Orders                 (createPurchaseOrder, receivePurchaseOrder, updatePurchaseOrderStatus, getPurchaseOrders)
 *   E. Supplier Management             (upsertSupplier, getSuppliers, deleteSupplier)
 *   F. Reorder Workflows               (getReorderQueue, dismissReorderItem, createAutoReorderPO)
 *   G. Stock Valuation (AVCO)          (_updateAVCO [internal], getStockValuation)
 *   H. Inventory Forecasting           (getInventoryForecast)
 *   I. Scheduled: batchExpiryAlertSweep
 */

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const admin = require('firebase-admin');
if (!admin.apps.length) admin.initializeApp();
const db = admin.firestore();

// ─────────────────────────────────────────────
// Shared Config & Utilities
// ─────────────────────────────────────────────

const _CF = { region: 'us-central1', enforceAppCheck: true };
const _TS = () => admin.firestore.FieldValue.serverTimestamp();
const _INC = (n) => admin.firestore.FieldValue.increment(n);

/**
 * Assert authenticated caller.
 * @param {import('firebase-functions/v2/https').CallableRequest} req
 * @returns {import('firebase-functions/v2/https').CallableRequest['auth']}
 */
function _requireAuth(req) {
  if (!req.auth) throw new HttpsError('unauthenticated', 'Login required');
  return req.auth;
}

/**
 * Assert minimum POS role.
 * Role hierarchy: cashier < supervisor < manager < owner
 * @param {import('firebase-functions/v2/https').CallableRequest['auth']} auth
 * @param {'cashier'|'supervisor'|'manager'|'owner'} minRole
 */
function _requireRole(auth, minRole) {
  const levels = { cashier: 0, supervisor: 1, manager: 2, owner: 3 };
  const userLevel = levels[auth.token?.posRole || 'cashier'] ?? 0;
  if (userLevel < (levels[minRole] ?? 0)) {
    throw new HttpsError('permission-denied', `Requires ${minRole} role`);
  }
}

/**
 * Generate a zero-padded random numeric suffix.
 * @param {number} digits
 * @returns {string}
 */
function _randDigits(digits) {
  const max = Math.pow(10, digits);
  return String(Math.floor(Math.random() * max)).padStart(digits, '0');
}

/**
 * Format today as YYYYMMDD string.
 * @returns {string}
 */
function _dateTag() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dy = String(d.getDate()).padStart(2, '0');
  return `${y}${m}${dy}`;
}

/**
 * Validate that a string is non-empty after trimming.
 * @param {unknown} val
 * @param {string} name
 * @returns {string}
 */
function _requireString(val, name) {
  if (typeof val !== 'string' || !val.trim()) {
    throw new HttpsError('invalid-argument', `${name} must be a non-empty string`);
  }
  return val.trim();
}

/**
 * Validate that a value is a positive finite number.
 * @param {unknown} val
 * @param {string} name
 * @returns {number}
 */
function _requirePositiveNumber(val, name) {
  const n = Number(val);
  if (!isFinite(n) || n <= 0) {
    throw new HttpsError('invalid-argument', `${name} must be a positive number`);
  }
  return n;
}

/**
 * Validate that a value is a non-negative finite number.
 * @param {unknown} val
 * @param {string} name
 * @returns {number}
 */
function _requireNonNegativeNumber(val, name) {
  const n = Number(val);
  if (!isFinite(n) || n < 0) {
    throw new HttpsError('invalid-argument', `${name} must be a non-negative number`);
  }
  return n;
}

// ─────────────────────────────────────────────
// G. (Internal) AVCO — Average Cost Update
// ─────────────────────────────────────────────

/**
 * Update the Average Cost (AVCO) valuation for a product.
 * Uses a Firestore transaction for atomic read-modify-write.
 *
 * Formula:
 *   newTotalCost = oldTotalCost + (incomingQty * incomingCost)
 *   newQty       = oldQty + incomingQty
 *   newAvgCost   = newTotalCost / newQty
 *
 * @param {string} sellerId
 * @param {string} productId
 * @param {number} incomingQty   — units being added
 * @param {number} incomingCost  — cost per unit being added
 */
async function _updateAVCO(sellerId, productId, incomingQty, incomingCost) {
  const docId = `${sellerId}_${productId}`;
  const ref = db.collection('posStockValuation').doc(docId);

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);

    let currentQty = 0;
    let totalCost = 0;

    if (snap.exists) {
      currentQty = snap.data().currentQty || 0;
      totalCost = snap.data().totalCost || 0;
    }

    const newQty = currentQty + incomingQty;
    const newTotalCost = totalCost + incomingQty * incomingCost;
    const newAvgCost = newQty > 0 ? newTotalCost / newQty : 0;

    tx.set(
      ref,
      {
        sellerId,
        productId,
        currentQty: newQty,
        totalCost: newTotalCost,
        avgCost: newAvgCost,
        lastUpdated: _TS(),
      },
      { merge: true }
    );
  });
}

// ─────────────────────────────────────────────
// A. Batch / Lot Management
// ─────────────────────────────────────────────

/**
 * Create a new inventory batch / lot.
 * Role: manager+
 *
 * Input:
 *   sellerId, productId, lotNumber, quantity, unitCost, expiryDate (ISO string, optional),
 *   supplierId, warehouseId (optional, default 'main')
 *
 * Writes to: posBatches/{batchId}
 */
exports.createBatch = onCall(_CF, async (req) => {
  const auth = _requireAuth(req);
  _requireRole(auth, 'manager');

  const {
    sellerId,
    productId,
    lotNumber,
    quantity,
    unitCost,
    expiryDate,
    supplierId,
    warehouseId = 'main',
  } = req.data || {};

  _requireString(sellerId, 'sellerId');
  _requireString(productId, 'productId');
  _requireString(lotNumber, 'lotNumber');
  const qty = _requirePositiveNumber(quantity, 'quantity');
  const cost = _requireNonNegativeNumber(unitCost, 'unitCost');
  if (supplierId !== undefined && supplierId !== null) {
    _requireString(supplierId, 'supplierId');
  }
  _requireString(warehouseId, 'warehouseId');

  // Validate expiryDate if provided
  let expiryTs = null;
  if (expiryDate) {
    const d = new Date(expiryDate);
    if (isNaN(d.getTime())) {
      throw new HttpsError('invalid-argument', 'expiryDate must be a valid ISO date string');
    }
    expiryTs = admin.firestore.Timestamp.fromDate(d);
  }

  // Generate sequential-safe batchNumber: BN-{YYYYMMDD}-{4 random digits}
  const batchNumber = `BN-${_dateTag()}-${_randDigits(4)}`;
  const totalCost = qty * cost;

  const batchData = {
    sellerId,
    productId,
    lotNumber: lotNumber.trim(),
    batchNumber,
    quantity: qty,
    remaining: qty,
    unitCost: cost,
    totalCost,
    expiryDate: expiryTs,
    supplierId: supplierId || null,
    warehouseId,
    status: 'active',
    expiryAlert: false,
    expired: false,
    createdBy: auth.uid,
    createdAt: _TS(),
    updatedAt: _TS(),
  };

  const batchRef = await db.collection('posBatches').add(batchData);

  // Update AVCO with incoming stock
  await _updateAVCO(sellerId, productId, qty, cost);

  return { batchId: batchRef.id, batchNumber, success: true };
});

/**
 * Get batches for a seller, optionally filtered by productId and/or status.
 * Results ordered by expiryDate asc (null last), limit 100.
 *
 * Input: sellerId, productId (optional), status (optional)
 */
exports.getBatches = onCall(_CF, async (req) => {
  _requireAuth(req);

  const { sellerId, productId, status } = req.data || {};
  _requireString(sellerId, 'sellerId');

  // Build query — Firestore does not support ordering nulls last natively,
  // so we split into two queries: non-null expiry (asc) then null expiry.
  let q = db.collection('posBatches').where('sellerId', '==', sellerId);

  if (productId) q = q.where('productId', '==', productId);
  if (status) q = q.where('status', '==', status);

  // Fetch with expiryDate ascending (non-null entries naturally come first)
  const [withExpiry, withoutExpiry] = await Promise.all([
    q.where('expiryDate', '!=', null).orderBy('expiryDate', 'asc').limit(100).get(),
    q.where('expiryDate', '==', null).limit(100).get(),
  ]);

  const batches = [];

  withExpiry.forEach((doc) => batches.push({ id: doc.id, ...doc.data() }));
  // Append null-expiry batches after so FEFO ordering is correct
  const nullCount = Math.max(0, 100 - withExpiry.size);
  let added = 0;
  withoutExpiry.forEach((doc) => {
    if (added < nullCount) {
      batches.push({ id: doc.id, ...doc.data() });
      added++;
    }
  });

  return { batches, count: batches.length };
});

/**
 * Consume stock using FEFO (First Expired, First Out).
 * Deducts from active batches in expiry-ascending order (nulls last).
 *
 * Input: sellerId, productId, quantity
 * Returns: array of {batchId, lotNumber, took}
 */
exports.consumeBatch = onCall(_CF, async (req) => {
  _requireAuth(req);

  const { sellerId, productId, quantity } = req.data || {};
  _requireString(sellerId, 'sellerId');
  _requireString(productId, 'productId');
  const requested = _requirePositiveNumber(quantity, 'quantity');

  // Fetch active batches — FEFO: non-null expiry asc, then null expiry
  const [withExpiry, withoutExpiry] = await Promise.all([
    db
      .collection('posBatches')
      .where('sellerId', '==', sellerId)
      .where('productId', '==', productId)
      .where('status', '==', 'active')
      .where('expiryDate', '!=', null)
      .orderBy('expiryDate', 'asc')
      .get(),
    db
      .collection('posBatches')
      .where('sellerId', '==', sellerId)
      .where('productId', '==', productId)
      .where('status', '==', 'active')
      .where('expiryDate', '==', null)
      .get(),
  ]);

  const batches = [];
  withExpiry.forEach((d) => batches.push({ id: d.id, ...d.data() }));
  withoutExpiry.forEach((d) => batches.push({ id: d.id, ...d.data() }));

  // Check total available
  const totalAvailable = batches.reduce((sum, b) => sum + (b.remaining || 0), 0);
  if (totalAvailable < requested) {
    throw new HttpsError(
      'failed-precondition',
      `Insufficient stock. Available: ${totalAvailable}, requested: ${requested}`
    );
  }

  // Deduct in FEFO order via transaction
  const consumed = [];
  let remaining = requested;

  const batch = db.batch();

  for (const b of batches) {
    if (remaining <= 0) break;
    const take = Math.min(b.remaining, remaining);
    const newRemaining = b.remaining - take;
    const ref = db.collection('posBatches').doc(b.id);

    batch.update(ref, {
      remaining: newRemaining,
      status: newRemaining === 0 ? 'depleted' : 'active',
      updatedAt: _TS(),
    });

    consumed.push({ batchId: b.id, lotNumber: b.lotNumber, took: take });
    remaining -= take;
  }

  await batch.commit();

  return { consumed, totalConsumed: requested, success: true };
});

// ─────────────────────────────────────────────
// B. Serial Number Tracking
// ─────────────────────────────────────────────

/**
 * Register a new serial number for a product unit.
 * Role: manager+
 *
 * Input: sellerId, productId, serialNumber, batchId (optional), warehouseId (optional)
 * Writes to: posSerials/{serialId}
 */
exports.registerSerial = onCall(_CF, async (req) => {
  const auth = _requireAuth(req);
  _requireRole(auth, 'manager');

  const {
    sellerId,
    productId,
    serialNumber,
    batchId = null,
    warehouseId = 'main',
  } = req.data || {};

  _requireString(sellerId, 'sellerId');
  _requireString(productId, 'productId');
  _requireString(serialNumber, 'serialNumber');
  _requireString(warehouseId, 'warehouseId');

  // Check uniqueness: sellerId + serialNumber
  const existing = await db
    .collection('posSerials')
    .where('sellerId', '==', sellerId)
    .where('serialNumber', '==', serialNumber.trim())
    .limit(1)
    .get();

  if (!existing.empty) {
    throw new HttpsError(
      'already-exists',
      `Serial number ${serialNumber} is already registered for this seller`
    );
  }

  const serialData = {
    sellerId,
    productId,
    serialNumber: serialNumber.trim(),
    batchId,
    warehouseId,
    status: 'in_stock',
    saleId: null,
    customerId: null,
    history: [
      {
        status: 'in_stock',
        ts: new Date().toISOString(),
        by: auth.uid,
        note: 'Initial registration',
      },
    ],
    createdBy: auth.uid,
    createdAt: _TS(),
    updatedAt: _TS(),
  };

  const ref = await db.collection('posSerials').add(serialData);
  return { serialId: ref.id, success: true };
});

/**
 * Look up a serial number record by sellerId + serialNumber.
 *
 * Input: sellerId, serialNumber
 */
exports.getSerial = onCall(_CF, async (req) => {
  _requireAuth(req);

  const { sellerId, serialNumber } = req.data || {};
  _requireString(sellerId, 'sellerId');
  _requireString(serialNumber, 'serialNumber');

  const snap = await db
    .collection('posSerials')
    .where('sellerId', '==', sellerId)
    .where('serialNumber', '==', serialNumber.trim())
    .limit(1)
    .get();

  if (snap.empty) {
    throw new HttpsError('not-found', `Serial number ${serialNumber} not found`);
  }

  const doc = snap.docs[0];
  return { serialId: doc.id, ...doc.data() };
});

/**
 * Update the status of a serial number unit.
 * Role: supervisor+
 * Allowed statuses: in_stock | sold | returned | defective | transferred | scrapped
 *
 * Input: serialId, status, note (optional), saleId (optional), customerId (optional)
 */
exports.updateSerialStatus = onCall(_CF, async (req) => {
  const auth = _requireAuth(req);
  _requireRole(auth, 'supervisor');

  const ALLOWED_STATUSES = ['in_stock', 'sold', 'returned', 'defective', 'transferred', 'scrapped'];
  const { serialId, status, note = '', saleId, customerId } = req.data || {};

  _requireString(serialId, 'serialId');
  _requireString(status, 'status');

  if (!ALLOWED_STATUSES.includes(status)) {
    throw new HttpsError(
      'invalid-argument',
      `status must be one of: ${ALLOWED_STATUSES.join(', ')}`
    );
  }

  const ref = db.collection('posSerials').doc(serialId);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Serial record not found');

  const historyEntry = {
    status,
    ts: new Date().toISOString(),
    by: auth.uid,
    note: note ? String(note).slice(0, 500) : '',
  };

  const updateData = {
    status,
    updatedAt: _TS(),
    history: admin.firestore.FieldValue.arrayUnion(historyEntry),
  };

  if (saleId !== undefined) updateData.saleId = saleId || null;
  if (customerId !== undefined) updateData.customerId = customerId || null;

  await ref.update(updateData);
  return { success: true };
});

// ─────────────────────────────────────────────
// C. Warehouse Management
// ─────────────────────────────────────────────

/**
 * Create a new warehouse / storage location.
 * Role: manager+
 *
 * Input: sellerId, name, location, type (main|branch|transit|returns)
 * Writes to: posWarehouses/{id}
 */
exports.createWarehouse = onCall(_CF, async (req) => {
  const auth = _requireAuth(req);
  _requireRole(auth, 'manager');

  const WAREHOUSE_TYPES = ['main', 'branch', 'transit', 'returns'];
  const { sellerId, name, location, type } = req.data || {};

  _requireString(sellerId, 'sellerId');
  _requireString(name, 'name');
  _requireString(location, 'location');
  _requireString(type, 'type');

  if (!WAREHOUSE_TYPES.includes(type)) {
    throw new HttpsError('invalid-argument', `type must be one of: ${WAREHOUSE_TYPES.join(', ')}`);
  }

  const warehouseData = {
    sellerId,
    name: name.trim(),
    location: location.trim(),
    type,
    isActive: true,
    createdBy: auth.uid,
    createdAt: _TS(),
    updatedAt: _TS(),
  };

  const ref = await db.collection('posWarehouses').add(warehouseData);
  return { warehouseId: ref.id, success: true };
});

/**
 * Get all active warehouses for a seller.
 *
 * Input: sellerId
 */
exports.getWarehouses = onCall(_CF, async (req) => {
  _requireAuth(req);

  const { sellerId } = req.data || {};
  _requireString(sellerId, 'sellerId');

  const snap = await db
    .collection('posWarehouses')
    .where('sellerId', '==', sellerId)
    .where('isActive', '==', true)
    .get();

  const warehouses = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  return { warehouses, count: warehouses.length };
});

/**
 * Transfer stock between two warehouses atomically.
 * Role: manager+
 *
 * Input: sellerId, productId, fromWarehouse, toWarehouse, quantity
 * Uses posWarehouseStock docs keyed: {sellerId}_{warehouseId}_{productId}
 * Also writes a record to: inventoryTransfers/{id}
 */
exports.transferWarehouseStock = onCall(_CF, async (req) => {
  const auth = _requireAuth(req);
  _requireRole(auth, 'manager');

  const { sellerId, productId, fromWarehouse, toWarehouse, quantity } = req.data || {};

  _requireString(sellerId, 'sellerId');
  _requireString(productId, 'productId');
  _requireString(fromWarehouse, 'fromWarehouse');
  _requireString(toWarehouse, 'toWarehouse');
  const qty = _requirePositiveNumber(quantity, 'quantity');

  if (fromWarehouse === toWarehouse) {
    throw new HttpsError(
      'invalid-argument',
      'fromWarehouse and toWarehouse must be different'
    );
  }

  const sourceId = `${sellerId}_${fromWarehouse}_${productId}`;
  const destId = `${sellerId}_${toWarehouse}_${productId}`;
  const sourceRef = db.collection('posWarehouseStock').doc(sourceId);
  const destRef = db.collection('posWarehouseStock').doc(destId);
  const transferRef = db.collection('inventoryTransfers').doc();

  await db.runTransaction(async (tx) => {
    const sourceSnap = await tx.get(sourceRef);

    const sourceQty = sourceSnap.exists ? sourceSnap.data().quantity || 0 : 0;

    if (sourceQty < qty) {
      throw new HttpsError(
        'failed-precondition',
        `Insufficient stock in source warehouse. Available: ${sourceQty}, requested: ${qty}`
      );
    }

    // Decrement source
    if (sourceSnap.exists) {
      tx.update(sourceRef, {
        quantity: _INC(-qty),
        updatedAt: _TS(),
      });
    } else {
      tx.set(sourceRef, {
        sellerId,
        productId,
        warehouseId: fromWarehouse,
        quantity: -qty, // should not reach negative but handled by check above
        updatedAt: _TS(),
        createdAt: _TS(),
      });
    }

    // Increment destination
    const destSnap = await tx.get(destRef);
    if (destSnap.exists) {
      tx.update(destRef, {
        quantity: _INC(qty),
        updatedAt: _TS(),
      });
    } else {
      tx.set(destRef, {
        sellerId,
        productId,
        warehouseId: toWarehouse,
        quantity: qty,
        updatedAt: _TS(),
        createdAt: _TS(),
      });
    }

    // Record transfer
    tx.set(transferRef, {
      sellerId,
      productId,
      fromWarehouse,
      toWarehouse,
      quantity: qty,
      transferredBy: auth.uid,
      status: 'completed',
      createdAt: _TS(),
    });
  });

  return { transferId: transferRef.id, success: true };
});

// ─────────────────────────────────────────────
// D. Purchase Orders
// ─────────────────────────────────────────────

/**
 * Create a new Purchase Order in draft status.
 * Role: manager+
 *
 * Input: sellerId, supplierId, items[{productId,productName,quantity,unitCost}],
 *        expectedDelivery (ISO string, optional), notes (optional)
 * Writes to: posPurchaseOrders/{id}
 */
exports.createPurchaseOrder = onCall(_CF, async (req) => {
  const auth = _requireAuth(req);
  _requireRole(auth, 'manager');

  const { sellerId, supplierId, items, expectedDelivery, notes = '' } = req.data || {};

  _requireString(sellerId, 'sellerId');
  _requireString(supplierId, 'supplierId');

  if (!Array.isArray(items) || items.length === 0) {
    throw new HttpsError('invalid-argument', 'items must be a non-empty array');
  }

  // Validate and normalise line items
  const lineItems = items.map((item, i) => {
    const productId = _requireString(item.productId, `items[${i}].productId`);
    const productName = _requireString(item.productName, `items[${i}].productName`);
    const qty = _requirePositiveNumber(item.quantity, `items[${i}].quantity`);
    const cost = _requireNonNegativeNumber(item.unitCost, `items[${i}].unitCost`);
    return {
      productId,
      productName,
      quantity: qty,
      unitCost: cost,
      lineTotal: qty * cost,
      received: 0,
    };
  });

  const totalAmount = lineItems.reduce((sum, li) => sum + li.lineTotal, 0);

  // Generate PO number: PO-YYYYMMDD-XXXX
  const poNumber = `PO-${_dateTag()}-${_randDigits(4)}`;

  let expectedTs = null;
  if (expectedDelivery) {
    const d = new Date(expectedDelivery);
    if (isNaN(d.getTime())) {
      throw new HttpsError('invalid-argument', 'expectedDelivery must be a valid ISO date string');
    }
    expectedTs = admin.firestore.Timestamp.fromDate(d);
  }

  const poData = {
    sellerId,
    supplierId,
    poNumber,
    items: lineItems,
    totalAmount,
    expectedDelivery: expectedTs,
    notes: notes ? String(notes).slice(0, 1000) : '',
    status: 'draft',
    createdBy: auth.uid,
    createdAt: _TS(),
    updatedAt: _TS(),
  };

  const ref = await db.collection('posPurchaseOrders').add(poData);
  return { poId: ref.id, poNumber, totalAmount, success: true };
});

/**
 * Receive goods against a Purchase Order.
 * Role: manager+
 *
 * Creates posBatches for each received line, updates AVCO, updates PO status.
 *
 * Input: poId, receivedItems[{productId, quantity, unitCost, lotNumber, expiryDate (optional), warehouseId}]
 */
exports.receivePurchaseOrder = onCall(_CF, async (req) => {
  const auth = _requireAuth(req);
  _requireRole(auth, 'manager');

  const { poId, receivedItems } = req.data || {};
  _requireString(poId, 'poId');

  if (!Array.isArray(receivedItems) || receivedItems.length === 0) {
    throw new HttpsError('invalid-argument', 'receivedItems must be a non-empty array');
  }

  const poRef = db.collection('posPurchaseOrders').doc(poId);
  const poSnap = await poRef.get();
  if (!poSnap.exists) throw new HttpsError('not-found', 'Purchase order not found');

  const po = poSnap.data();
  if (['cancelled', 'received'].includes(po.status)) {
    throw new HttpsError(
      'failed-precondition',
      `Cannot receive goods for a PO with status '${po.status}'`
    );
  }

  const batchRefs = [];
  const avcoUpdates = [];

  const updatedItems = po.items.map((poItem) => ({ ...poItem }));

  for (let i = 0; i < receivedItems.length; i++) {
    const ri = receivedItems[i];
    const productId = _requireString(ri.productId, `receivedItems[${i}].productId`);
    const qty = _requirePositiveNumber(ri.quantity, `receivedItems[${i}].quantity`);
    const cost = _requireNonNegativeNumber(ri.unitCost, `receivedItems[${i}].unitCost`);
    const lotNumber = _requireString(ri.lotNumber, `receivedItems[${i}].lotNumber`);
    const warehouseId = ri.warehouseId ? String(ri.warehouseId).trim() : 'main';

    let expiryTs = null;
    if (ri.expiryDate) {
      const d = new Date(ri.expiryDate);
      if (isNaN(d.getTime())) {
        throw new HttpsError(
          'invalid-argument',
          `receivedItems[${i}].expiryDate is not a valid ISO date string`
        );
      }
      expiryTs = admin.firestore.Timestamp.fromDate(d);
    }

    const batchNumber = `BN-${_dateTag()}-${_randDigits(4)}`;
    const batchData = {
      sellerId: po.sellerId,
      productId,
      lotNumber: lotNumber.trim(),
      batchNumber,
      quantity: qty,
      remaining: qty,
      unitCost: cost,
      totalCost: qty * cost,
      expiryDate: expiryTs,
      supplierId: po.supplierId,
      warehouseId,
      purchaseOrderId: poId,
      poNumber: po.poNumber,
      status: 'active',
      expiryAlert: false,
      expired: false,
      createdBy: auth.uid,
      createdAt: _TS(),
      updatedAt: _TS(),
    };

    const batchRef = db.collection('posBatches').doc();
    batchRefs.push({ ref: batchRef, data: batchData });
    avcoUpdates.push({ productId, qty, cost, sellerId: po.sellerId });

    // Update received count on the matching PO line item
    const lineIdx = updatedItems.findIndex((li) => li.productId === productId);
    if (lineIdx !== -1) {
      updatedItems[lineIdx].received = (updatedItems[lineIdx].received || 0) + qty;
    }
  }

  // Determine new PO status
  const fullyReceived = updatedItems.every((li) => li.received >= li.quantity);
  const anyReceived = updatedItems.some((li) => (li.received || 0) > 0);
  const newStatus = fullyReceived ? 'received' : anyReceived ? 'partial' : po.status;

  // Batch write batches + PO update
  const writeBatch = db.batch();
  for (const { ref, data } of batchRefs) {
    writeBatch.set(ref, data);
  }
  writeBatch.update(poRef, {
    items: updatedItems,
    status: newStatus,
    lastReceivedAt: _TS(),
    updatedAt: _TS(),
  });
  await writeBatch.commit();

  // Update AVCO after writes
  await Promise.all(
    avcoUpdates.map(({ sellerId, productId, qty, cost }) =>
      _updateAVCO(sellerId, productId, qty, cost)
    )
  );

  return {
    poId,
    poNumber: po.poNumber,
    status: newStatus,
    batchesCreated: batchRefs.length,
    success: true,
  };
});

/**
 * Update the status of a Purchase Order.
 * Role: manager+
 * Allowed transitions: draft→sent, draft→cancelled, sent→cancelled
 *
 * Input: poId, status
 */
exports.updatePurchaseOrderStatus = onCall(_CF, async (req) => {
  const auth = _requireAuth(req);
  _requireRole(auth, 'manager');

  const ALLOWED_TRANSITIONS = {
    draft: ['sent', 'cancelled'],
    sent: ['cancelled'],
    partial: [],
    received: [],
    cancelled: [],
  };

  const { poId, status } = req.data || {};
  _requireString(poId, 'poId');
  _requireString(status, 'status');

  const ref = db.collection('posPurchaseOrders').doc(poId);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Purchase order not found');

  const currentStatus = snap.data().status;
  const allowed = ALLOWED_TRANSITIONS[currentStatus] || [];

  if (!allowed.includes(status)) {
    throw new HttpsError(
      'failed-precondition',
      `Cannot transition from '${currentStatus}' to '${status}'. Allowed: ${allowed.join(', ') || 'none'}`
    );
  }

  await ref.update({
    status,
    statusUpdatedBy: auth.uid,
    updatedAt: _TS(),
  });

  return { poId, status, success: true };
});

/**
 * List purchase orders for a seller.
 *
 * Input: sellerId, status (optional), supplierId (optional)
 * Returns: list ordered by createdAt desc, limit 50
 */
exports.getPurchaseOrders = onCall(_CF, async (req) => {
  _requireAuth(req);

  const { sellerId, status, supplierId } = req.data || {};
  _requireString(sellerId, 'sellerId');

  let q = db.collection('posPurchaseOrders').where('sellerId', '==', sellerId);

  if (status) q = q.where('status', '==', status);
  if (supplierId) q = q.where('supplierId', '==', supplierId);

  q = q.orderBy('createdAt', 'desc').limit(50);

  const snap = await q.get();
  const orders = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  return { orders, count: orders.length };
});

// ─────────────────────────────────────────────
// E. Supplier Management
// ─────────────────────────────────────────────

/**
 * Create or update a supplier record.
 * Role: manager+
 *
 * If supplierId is provided and doc exists, updates it; otherwise creates new.
 *
 * Input: sellerId, name, phone, email, address, taxPin, paymentTerms (default 30),
 *        notes, supplierId (optional for update)
 * Writes to: posSuppliers/{id}
 */
exports.upsertSupplier = onCall(_CF, async (req) => {
  const auth = _requireAuth(req);
  _requireRole(auth, 'manager');

  const {
    sellerId,
    name,
    phone,
    email,
    address,
    taxPin = '',
    paymentTerms = 30,
    notes = '',
    supplierId,
  } = req.data || {};

  _requireString(sellerId, 'sellerId');
  _requireString(name, 'name');
  _requireString(phone, 'phone');
  _requireString(email, 'email');
  _requireString(address, 'address');

  const terms = Number(paymentTerms);
  if (!isFinite(terms) || terms < 0) {
    throw new HttpsError('invalid-argument', 'paymentTerms must be a non-negative number');
  }

  // Basic email validation
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
    throw new HttpsError('invalid-argument', 'email is not a valid email address');
  }

  const supplierData = {
    sellerId,
    name: name.trim(),
    phone: phone.trim(),
    email: email.trim().toLowerCase(),
    address: address.trim(),
    taxPin: taxPin ? String(taxPin).trim() : '',
    paymentTerms: terms,
    notes: notes ? String(notes).slice(0, 1000) : '',
    isActive: true,
    updatedBy: auth.uid,
    updatedAt: _TS(),
  };

  let id;

  if (supplierId) {
    const ref = db.collection('posSuppliers').doc(supplierId);
    const snap = await ref.get();
    if (!snap.exists) throw new HttpsError('not-found', 'Supplier not found');
    if (snap.data().sellerId !== sellerId) {
      throw new HttpsError('permission-denied', 'Supplier does not belong to this seller');
    }
    await ref.update(supplierData);
    id = supplierId;
  } else {
    supplierData.createdBy = auth.uid;
    supplierData.createdAt = _TS();
    const ref = await db.collection('posSuppliers').add(supplierData);
    id = ref.id;
  }

  return { supplierId: id, success: true };
});

/**
 * Get all active suppliers for a seller, ordered by name.
 *
 * Input: sellerId
 */
exports.getSuppliers = onCall(_CF, async (req) => {
  _requireAuth(req);

  const { sellerId } = req.data || {};
  _requireString(sellerId, 'sellerId');

  const snap = await db
    .collection('posSuppliers')
    .where('sellerId', '==', sellerId)
    .where('isActive', '==', true)
    .orderBy('name', 'asc')
    .get();

  const suppliers = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  return { suppliers, count: suppliers.length };
});

/**
 * Soft-delete a supplier (isActive = false).
 * Role: manager+
 *
 * Input: sellerId, supplierId
 */
exports.deleteSupplier = onCall(_CF, async (req) => {
  const auth = _requireAuth(req);
  _requireRole(auth, 'manager');

  const { sellerId, supplierId } = req.data || {};
  _requireString(sellerId, 'sellerId');
  _requireString(supplierId, 'supplierId');

  const ref = db.collection('posSuppliers').doc(supplierId);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Supplier not found');
  if (snap.data().sellerId !== sellerId) {
    throw new HttpsError('permission-denied', 'Supplier does not belong to this seller');
  }
  if (!snap.data().isActive) {
    return { supplierId, success: true, message: 'Supplier was already inactive' };
  }

  await ref.update({
    isActive: false,
    deletedBy: auth.uid,
    deletedAt: _TS(),
    updatedAt: _TS(),
  });

  return { supplierId, success: true };
});

// ─────────────────────────────────────────────
// F. Reorder Workflows
// ─────────────────────────────────────────────

/**
 * Get pending reorder queue items for a seller.
 * Ordered by priority desc, limit 50.
 *
 * Input: sellerId
 */
exports.getReorderQueue = onCall(_CF, async (req) => {
  _requireAuth(req);

  const { sellerId } = req.data || {};
  _requireString(sellerId, 'sellerId');

  const snap = await db
    .collection('posReorderQueue')
    .where('sellerId', '==', sellerId)
    .where('status', '==', 'pending')
    .orderBy('priority', 'desc')
    .limit(50)
    .get();

  const items = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  return { items, count: items.length };
});

/**
 * Dismiss a reorder queue item.
 * Role: manager+
 *
 * Input: sellerId, reorderItemId
 */
exports.dismissReorderItem = onCall(_CF, async (req) => {
  const auth = _requireAuth(req);
  _requireRole(auth, 'manager');

  const { sellerId, reorderItemId } = req.data || {};
  _requireString(sellerId, 'sellerId');
  _requireString(reorderItemId, 'reorderItemId');

  const ref = db.collection('posReorderQueue').doc(reorderItemId);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Reorder item not found');
  if (snap.data().sellerId !== sellerId) {
    throw new HttpsError('permission-denied', 'Reorder item does not belong to this seller');
  }

  await ref.update({
    status: 'dismissed',
    dismissedBy: auth.uid,
    dismissedAt: _TS(),
    updatedAt: _TS(),
  });

  return { reorderItemId, success: true };
});

/**
 * Create an automatic Purchase Order from all pending reorder items for a supplier.
 * Role: manager+
 *
 * Fetches pending items for sellerId+supplierId, creates a PO, marks items as 'ordered'.
 *
 * Input: sellerId, supplierId
 * Returns: { poId, poNumber, itemCount }
 */
exports.createAutoReorderPO = onCall(_CF, async (req) => {
  const auth = _requireAuth(req);
  _requireRole(auth, 'manager');

  const { sellerId, supplierId } = req.data || {};
  _requireString(sellerId, 'sellerId');
  _requireString(supplierId, 'supplierId');

  // Fetch all pending reorder items for this seller + supplier
  const snap = await db
    .collection('posReorderQueue')
    .where('sellerId', '==', sellerId)
    .where('supplierId', '==', supplierId)
    .where('status', '==', 'pending')
    .get();

  if (snap.empty) {
    throw new HttpsError(
      'not-found',
      'No pending reorder items found for this seller and supplier'
    );
  }

  // Build line items from reorder queue
  const lineItems = snap.docs.map((d) => {
    const data = d.data();
    const qty = data.reorderQuantity || data.quantity || 1;
    const cost = data.lastUnitCost || 0;
    return {
      productId: data.productId,
      productName: data.productName || data.productId,
      quantity: qty,
      unitCost: cost,
      lineTotal: qty * cost,
      received: 0,
      reorderQueueId: d.id,
    };
  });

  const totalAmount = lineItems.reduce((sum, li) => sum + li.lineTotal, 0);
  const poNumber = `PO-${_dateTag()}-${_randDigits(4)}`;

  const poData = {
    sellerId,
    supplierId,
    poNumber,
    items: lineItems.map(({ reorderQueueId: _rqId, ...rest }) => rest), // strip internal field
    totalAmount,
    expectedDelivery: null,
    notes: `Auto-generated from reorder queue — ${snap.size} item(s)`,
    status: 'draft',
    autoGenerated: true,
    createdBy: auth.uid,
    createdAt: _TS(),
    updatedAt: _TS(),
  };

  const poRef = await db.collection('posPurchaseOrders').add(poData);

  // Mark reorder items as ordered
  const writeBatch = db.batch();
  snap.docs.forEach((d) => {
    writeBatch.update(d.ref, {
      status: 'ordered',
      purchaseOrderId: poRef.id,
      orderedAt: _TS(),
      updatedAt: _TS(),
    });
  });
  await writeBatch.commit();

  return { poId: poRef.id, poNumber, itemCount: snap.size, totalAmount, success: true };
});

// ─────────────────────────────────────────────
// G. Stock Valuation — Public Read
// ─────────────────────────────────────────────

/**
 * Get AVCO stock valuation for a seller.
 * If productId provided: single product valuation.
 * Otherwise: all valuations for seller + aggregate totalInventoryValue.
 *
 * Input: sellerId, productId (optional)
 */
exports.getStockValuation = onCall(_CF, async (req) => {
  _requireAuth(req);

  const { sellerId, productId } = req.data || {};
  _requireString(sellerId, 'sellerId');

  if (productId) {
    _requireString(productId, 'productId');
    const docId = `${sellerId}_${productId}`;
    const snap = await db.collection('posStockValuation').doc(docId).get();
    if (!snap.exists) {
      return {
        sellerId,
        productId,
        currentQty: 0,
        totalCost: 0,
        avgCost: 0,
        found: false,
      };
    }
    return { id: snap.id, ...snap.data(), found: true };
  }

  // All valuations for seller
  const snap = await db
    .collection('posStockValuation')
    .where('sellerId', '==', sellerId)
    .get();

  const valuations = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  const totalInventoryValue = valuations.reduce((sum, v) => sum + (v.totalCost || 0), 0);

  return { valuations, count: valuations.length, totalInventoryValue };
});

// ─────────────────────────────────────────────
// H. Inventory Forecasting
// ─────────────────────────────────────────────

/**
 * Forecast stock-out dates based on sales velocity over the last 30 days.
 *
 * Input: sellerId
 * Returns: array of products with: productId, currentQty, dailyVelocity,
 *          daysOfStock, stockoutDate, urgency (critical|low|ok)
 *          Sorted by urgency (critical first) then daysOfStock asc.
 */
exports.getInventoryForecast = onCall(_CF, async (req) => {
  _requireAuth(req);

  const { sellerId } = req.data || {};
  _requireString(sellerId, 'sellerId');

  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  const thirtyDaysAgoTs = admin.firestore.Timestamp.fromDate(thirtyDaysAgo);

  // Fetch recent sales
  const salesSnap = await db
    .collection('posSales')
    .where('sellerId', '==', sellerId)
    .where('createdAt', '>=', thirtyDaysAgoTs)
    .get();

  // Aggregate qty sold per productId from sale line items
  const velocityMap = {};

  salesSnap.forEach((doc) => {
    const sale = doc.data();
    const saleItems = Array.isArray(sale.items) ? sale.items : [];
    saleItems.forEach((item) => {
      if (!item.productId) return;
      if (!velocityMap[item.productId]) velocityMap[item.productId] = 0;
      velocityMap[item.productId] += Number(item.quantity) || 0;
    });
  });

  // Daily velocity: total sold / 30
  const dailyVelocityMap = {};
  for (const [pid, total] of Object.entries(velocityMap)) {
    dailyVelocityMap[pid] = total / 30;
  }

  // Get all products with stock > 0 for this seller
  const productsSnap = await db
    .collection('products')
    .where('sellerId', '==', sellerId)
    .where('stock', '>', 0)
    .get();

  const forecasts = [];
  const now = new Date();

  productsSnap.forEach((doc) => {
    const product = doc.data();
    const productId = doc.id;
    const currentQty = Number(product.stock) || 0;
    const dailyVelocity = dailyVelocityMap[productId] || 0;

    let daysOfStock = null;
    let stockoutDate = null;
    let urgency = 'ok';

    if (dailyVelocity > 0) {
      daysOfStock = currentQty / dailyVelocity;
      const stockoutMs = now.getTime() + daysOfStock * 24 * 60 * 60 * 1000;
      stockoutDate = new Date(stockoutMs).toISOString();

      if (daysOfStock < 7) {
        urgency = 'critical';
      } else if (daysOfStock < 14) {
        urgency = 'low';
      } else {
        urgency = 'ok';
      }
    } else {
      // No recent sales — no urgency signal
      urgency = 'ok';
    }

    forecasts.push({
      productId,
      productName: product.name || productId,
      currentQty,
      dailyVelocity: Math.round(dailyVelocity * 100) / 100,
      daysOfStock: daysOfStock !== null ? Math.round(daysOfStock * 10) / 10 : null,
      stockoutDate,
      urgency,
    });
  });

  // Sort: critical first, then low, then ok; within same urgency sort by daysOfStock asc
  const urgencyOrder = { critical: 0, low: 1, ok: 2 };
  forecasts.sort((a, b) => {
    const uDiff = urgencyOrder[a.urgency] - urgencyOrder[b.urgency];
    if (uDiff !== 0) return uDiff;
    const aDays = a.daysOfStock === null ? Infinity : a.daysOfStock;
    const bDays = b.daysOfStock === null ? Infinity : b.daysOfStock;
    return aDays - bDays;
  });

  const criticalCount = forecasts.filter((f) => f.urgency === 'critical').length;
  const lowCount = forecasts.filter((f) => f.urgency === 'low').length;

  return {
    forecasts,
    count: forecasts.length,
    criticalCount,
    lowCount,
    generatedAt: new Date().toISOString(),
  };
});

// ─────────────────────────────────────────────
// I. Scheduled: Batch Expiry Alert Sweep
// ─────────────────────────────────────────────

/**
 * batchExpiryAlertSweep
 *
 * Runs every 24 hours.
 *
 * - Finds all active posBatches with expiryDate within the next 30 days.
 * - Sets expiryAlert=true on those batches.
 * - Sets expired=true and status='expired' on batches where expiryDate has passed.
 * - Adds expiry-driven items to posReorderQueue.
 *
 * Uses Firestore batch writes (max 500 ops per batch).
 */
exports.batchExpiryAlertSweep = onSchedule(
  {
    schedule: 'every 24 hours',
    region: 'us-central1',
    timeoutSeconds: 540,
    memory: '512MiB',
  },
  async (_event) => {
    const now = new Date();
    const in30Days = new Date();
    in30Days.setDate(in30Days.getDate() + 30);

    const nowTs = admin.firestore.Timestamp.fromDate(now);
    const in30DaysTs = admin.firestore.Timestamp.fromDate(in30Days);

    // Fetch active batches with expiryDate <= now+30 days
    const snap = await db
      .collection('posBatches')
      .where('status', '==', 'active')
      .where('expiryDate', '<=', in30DaysTs)
      .where('expiryDate', '!=', null)
      .get();

    if (snap.empty) {
      console.log('[batchExpiryAlertSweep] No batches approaching expiry.');
      return;
    }

    console.log(`[batchExpiryAlertSweep] Processing ${snap.size} batches.`);

    // We may have >500 docs — chunk into Firestore batches of 400 ops each
    const CHUNK_SIZE = 400;
    const docs = snap.docs;
    let processedCount = 0;
    let expiredCount = 0;
    let alertCount = 0;
    let reorderCount = 0;

    for (let i = 0; i < docs.length; i += CHUNK_SIZE) {
      const chunk = docs.slice(i, i + CHUNK_SIZE);
      const writeBatch = db.batch();

      for (const doc of chunk) {
        const data = doc.data();
        const expiryDate = data.expiryDate; // Firestore Timestamp

        const isExpired = expiryDate && expiryDate.toDate() <= now;
        const isApproaching = !isExpired && expiryDate && expiryDate.toDate() <= in30Days;

        const updateData = {
          updatedAt: _TS(),
        };

        if (isExpired) {
          updateData.status = 'expired';
          updateData.expired = true;
          updateData.expiryAlert = true;
          expiredCount++;
        } else if (isApproaching) {
          updateData.expiryAlert = true;
          alertCount++;
        }

        writeBatch.update(doc.ref, updateData);

        // Add to reorder queue if not already there
        if (isExpired || isApproaching) {
          const queueDocId = `${data.sellerId}_${data.productId}`;
          const queueRef = db.collection('posReorderQueue').doc(queueDocId);

          const daysUntilExpiry = isExpired
            ? 0
            : Math.ceil((expiryDate.toDate().getTime() - now.getTime()) / (1000 * 60 * 60 * 24));

          writeBatch.set(
            queueRef,
            {
              sellerId: data.sellerId,
              productId: data.productId,
              productName: data.productName || data.productId || '',
              supplierId: data.supplierId || null,
              reason: 'expiry',
              status: 'pending',
              priority: isExpired ? 10 : daysUntilExpiry <= 7 ? 8 : 5,
              daysUntilExpiry,
              batchId: doc.id,
              batchNumber: data.batchNumber || '',
              lotNumber: data.lotNumber || '',
              expiryDate: data.expiryDate,
              reorderQuantity: data.remaining || 0,
              lastUnitCost: data.unitCost || 0,
              updatedAt: _TS(),
            },
            { merge: true }
          );

          reorderCount++;
        }

        processedCount++;
      }

      await writeBatch.commit();
    }

    console.log(
      `[batchExpiryAlertSweep] Done. ` +
        `Processed: ${processedCount}, ` +
        `Expired: ${expiredCount}, ` +
        `Alert set: ${alertCount}, ` +
        `Reorder queue upserts: ${reorderCount}`
    );
  }
);
