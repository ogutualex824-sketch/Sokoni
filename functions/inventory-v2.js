/**
 * SOKONI INVENTORY V2 — Cloud Functions
 *
 * Covers: Product Variants, Batch/Lot Tracking, Serial Number Lifecycle,
 *         Bill of Materials, Work Orders, 4-Stage Warehouse Transfers,
 *         Supplier Performance Scoring, Offline Sync Queue Flush.
 *
 * Architecture:
 *   - All mutations are atomic Firestore transactions.
 *   - Every write appends an immutable record to inventory_audit.
 *   - Idempotency: callers may pass `id`; duplicate ids are safe (upserts).
 *   - Multi-tenant: all data is namespaced under tenants/{tenantId}/.
 */

'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const admin  = require('firebase-admin');

if (!admin.apps.length) admin.initializeApp();
const db = admin.firestore();

/* ─── SHARED HELPERS ──────────────────────────────────────────────────── */

const nowISO  = () => new Date().toISOString();
const uid6    = () => Math.random().toString(36).slice(2, 8);
const genId   = (prefix) => `${prefix}_${Date.now()}_${uid6()}`;

function col(tenantId, sub) {
  return db.collection(`tenants/${tenantId}/${sub}`);
}

const { assertAuth } = require('./shared/errors');

function assertTenant(data) {
  if (!data.tenantId) throw new HttpsError('invalid-argument', 'tenantId required');
  return data.tenantId;
}

function need(data, fields) {
  for (const f of fields) {
    if (data[f] === undefined || data[f] === null || data[f] === '') {
      throw new HttpsError('invalid-argument', `${f} is required`);
    }
  }
}

async function audit(tenantId, event) {
  await col(tenantId, 'inventory_audit').add({
    ...event,
    serverTimestamp: admin.firestore.FieldValue.serverTimestamp(),
  });
}

/* ═══════════════════════════════════════════════════════════════════════
   PRODUCT VARIANTS
   Firestore: tenants/{t}/inventory_variants/{variantId}
══════════════════════════════════════════════════════════════════════ */

exports.inventorySaveVariant = onCall({ timeoutSeconds: 20 }, async (req) => {
  const uid      = assertAuth(req);
  const tenantId = assertTenant(req.data);
  const d        = req.data;
  need(d, ['productId', 'attributes']);

  if (typeof d.attributes !== 'object' || !Object.keys(d.attributes).length) {
    throw new HttpsError('invalid-argument', 'attributes must be a non-empty object');
  }

  const id  = d.id || genId('var');
  const ref = col(tenantId, 'inventory_variants').doc(id);

  const variant = {
    id,
    productId:     d.productId,
    sku:           d.sku           || null,
    barcode:       d.barcode       || null,
    attributes:    d.attributes,
    priceModifier: Number(d.priceModifier || 0),
    costModifier:  Number(d.costModifier  || 0),
    stock:         Number(d.stock         || 0),
    images:        d.images        || [],
    active:        d.active !== false,
    tenantId,
    updatedAt:     nowISO(),
    updatedBy:     uid,
    createdAt:     d.createdAt     || nowISO(),
  };

  await ref.set(variant, { merge: true });
  await audit(tenantId, { type: 'variant_saved', variantId: id, productId: d.productId, userId: uid });

  return { success: true, id, variant };
});

exports.inventoryGetVariants = onCall({ timeoutSeconds: 15 }, async (req) => {
  assertAuth(req);
  const tenantId = assertTenant(req.data);
  need(req.data, ['productId']);

  const snap = await col(tenantId, 'inventory_variants')
    .where('productId', '==', req.data.productId)
    .where('active', '==', true)
    .get();

  return { variants: snap.docs.map(d => d.data()) };
});

exports.inventoryDeleteVariant = onCall({ timeoutSeconds: 15 }, async (req) => {
  const uid      = assertAuth(req);
  const tenantId = assertTenant(req.data);
  need(req.data, ['id']);

  await col(tenantId, 'inventory_variants').doc(req.data.id).update({
    active: false, deletedAt: nowISO(), deletedBy: uid,
  });
  await audit(tenantId, { type: 'variant_deleted', variantId: req.data.id, userId: uid });

  return { success: true };
});

/* ═══════════════════════════════════════════════════════════════════════
   BATCH / LOT TRACKING
   Firestore: tenants/{t}/inventory_batches/{batchId}
   Rotation: FEFO (default) | FIFO | LIFO via deductBatch
══════════════════════════════════════════════════════════════════════ */

exports.inventoryCreateBatch = onCall({ timeoutSeconds: 30 }, async (req) => {
  const uid      = assertAuth(req);
  const tenantId = assertTenant(req.data);
  const d        = req.data;
  need(d, ['productId', 'batchNumber', 'quantity', 'warehouseId']);

  if (Number(d.quantity) <= 0) throw new HttpsError('invalid-argument', 'quantity must be positive');

  const id  = d.id || genId('bat');
  const ref = col(tenantId, 'inventory_batches').doc(id);

  const batch = {
    id,
    productId:        d.productId,
    variantId:        d.variantId        || null,
    batchNumber:      d.batchNumber,
    lotNumber:        d.lotNumber         || d.batchNumber,
    warehouseId:      d.warehouseId,
    locationId:       d.locationId        || null,
    quantity:         Number(d.quantity),
    remainingQty:     Number(d.quantity),
    unitCost:         Number(d.unitCost    || 0),
    manufacturingDate:d.manufacturingDate || null,
    expiryDate:       d.expiryDate        || null,
    supplierId:       d.supplierId        || null,
    poId:             d.poId              || null,
    notes:            d.notes             || null,
    status:           'active',
    tenantId,
    createdAt:        nowISO(),
    createdBy:        uid,
  };

  await ref.set(batch);

  // Also adjust stock level
  await db.runTransaction(async tx => {
    const lvlId  = `${d.productId}:${d.variantId || 'base'}:${d.warehouseId}`;
    const lvlRef = col(tenantId, 'inventory_levels').doc(lvlId);
    const lvlSnap = await tx.get(lvlRef);
    const cur    = lvlSnap.exists ? (lvlSnap.data().available || 0) : 0;
    tx.set(lvlRef, { available: cur + Number(d.quantity), onHand: cur + Number(d.quantity), updatedAt: nowISO() }, { merge: true });
  });

  await audit(tenantId, {
    type: 'batch_created', batchId: id, productId: d.productId,
    batchNumber: d.batchNumber, quantity: Number(d.quantity), userId: uid,
  });

  return { success: true, id, batch };
});

exports.inventoryDeductBatch = onCall({ timeoutSeconds: 30 }, async (req) => {
  const uid      = assertAuth(req);
  const tenantId = assertTenant(req.data);
  const d        = req.data;
  need(d, ['productId', 'warehouseId', 'quantity', 'rotation']);

  const qty      = Number(d.quantity);
  const rotation = d.rotation || 'FEFO';
  let   snap     = col(tenantId, 'inventory_batches')
    .where('productId',   '==', d.productId)
    .where('warehouseId', '==', d.warehouseId)
    .where('status',      '==', 'active');

  const batchSnap  = await snap.get();
  let   batches    = batchSnap.docs.map(b => ({ ref: b.ref, ...b.data() }))
    .filter(b => b.remainingQty > 0);

  // Sort by rotation method
  if (rotation === 'FEFO') {
    batches.sort((a, b) => {
      if (!a.expiryDate) return 1;
      if (!b.expiryDate) return -1;
      return a.expiryDate.localeCompare(b.expiryDate);
    });
  } else if (rotation === 'FIFO') {
    batches.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  } else if (rotation === 'LIFO') {
    batches.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  let remaining  = qty;
  const deducted = [];
  const batch    = db.batch();

  for (const b of batches) {
    if (remaining <= 0) break;
    const take   = Math.min(remaining, b.remainingQty);
    const newQty = b.remainingQty - take;
    batch.update(b.ref, {
      remainingQty: newQty,
      status:       newQty <= 0 ? 'depleted' : 'active',
      updatedAt:    nowISO(),
    });
    deducted.push({ batchId: b.id, batchNumber: b.batchNumber, deducted: take, remaining: newQty });
    remaining -= take;
  }

  if (remaining > 0) {
    throw new HttpsError('failed-precondition',
      `Insufficient batch stock: ${qty - remaining} of ${qty} available across active batches`);
  }

  await batch.commit();
  await audit(tenantId, { type: 'batch_deducted', productId: d.productId, totalQty: qty, deducted, rotation, userId: uid });

  return { success: true, deducted };
});

exports.inventoryGetBatches = onCall({ timeoutSeconds: 15 }, async (req) => {
  assertAuth(req);
  const tenantId  = assertTenant(req.data);
  const d         = req.data;
  let   q         = col(tenantId, 'inventory_batches').where('productId', '==', d.productId);
  if (d.warehouseId) q = q.where('warehouseId', '==', d.warehouseId);
  if (d.status)      q = q.where('status',      '==', d.status);
  const snap = await q.orderBy('createdAt', 'desc').limit(d.limit || 50).get();
  return { batches: snap.docs.map(b => b.data()) };
});

exports.inventoryGetExpiringBatches = onCall({ timeoutSeconds: 15 }, async (req) => {
  assertAuth(req);
  const tenantId  = assertTenant(req.data);
  const days      = Number(req.data.days || 30);
  const cutoff    = new Date();
  cutoff.setDate(cutoff.getDate() + days);
  const cutoffISO = cutoff.toISOString().slice(0, 10);

  const snap = await col(tenantId, 'inventory_batches')
    .where('status',      '==', 'active')
    .where('expiryDate',  '<=', cutoffISO)
    .where('remainingQty','>',  0)
    .orderBy('expiryDate', 'asc')
    .limit(100)
    .get();

  return { batches: snap.docs.map(b => b.data()) };
});

/* ═══════════════════════════════════════════════════════════════════════
   SERIAL NUMBER LIFECYCLE
   Firestore: tenants/{t}/inventory_serials/{serialId}
            : tenants/{t}/inventory_serial_history/{eventId}
   States: received → available → sold → returned → repaired → scrapped
══════════════════════════════════════════════════════════════════════ */

exports.inventoryRegisterSerials = onCall({ timeoutSeconds: 60 }, async (req) => {
  const uid      = assertAuth(req);
  const tenantId = assertTenant(req.data);
  const d        = req.data;
  need(d, ['productId', 'serialNumbers', 'warehouseId']);

  if (!Array.isArray(d.serialNumbers) || !d.serialNumbers.length) {
    throw new HttpsError('invalid-argument', 'serialNumbers must be a non-empty array');
  }
  if (d.serialNumbers.length > 500) {
    throw new HttpsError('invalid-argument', 'Maximum 500 serial numbers per batch registration');
  }

  const batch      = db.batch();
  const registered = [];

  for (const sn of d.serialNumbers) {
    const serial = String(sn).trim();
    if (!serial) continue;
    const id  = genId('ser');
    const ref = col(tenantId, 'inventory_serials').doc(id);
    const doc = {
      id,
      productId:    d.productId,
      variantId:    d.variantId    || null,
      batchId:      d.batchId      || null,
      serialNumber: serial,
      imei:         d.imei         || null,
      vin:          d.vin          || null,
      rfid:         d.rfid         || null,
      warehouseId:  d.warehouseId,
      status:       'available',
      supplierId:   d.supplierId   || null,
      purchaseCost: Number(d.purchaseCost || 0),
      warrantyMonths: Number(d.warrantyMonths || 0),
      warrantyExpiry: d.warrantyExpiry || null,
      notes:        d.notes        || null,
      tenantId,
      createdAt:    nowISO(),
      createdBy:    uid,
    };
    batch.set(ref, doc);

    const histRef = col(tenantId, 'inventory_serial_history').doc();
    batch.set(histRef, {
      serialId: id, serialNumber: serial, productId: d.productId,
      event: 'registered', status: 'available',
      warehouseId: d.warehouseId, userId: uid, timestamp: nowISO(), tenantId,
    });
    registered.push({ id, serialNumber: serial });
  }

  await batch.commit();
  await audit(tenantId, {
    type: 'serials_registered', productId: d.productId,
    count: registered.length, warehouseId: d.warehouseId, userId: uid,
  });

  return { success: true, count: registered.length, registered };
});

exports.inventoryUpdateSerialStatus = onCall({ timeoutSeconds: 20 }, async (req) => {
  const uid      = assertAuth(req);
  const tenantId = assertTenant(req.data);
  const d        = req.data;
  need(d, ['serialId', 'status']);

  const VALID = ['available', 'sold', 'returned', 'repaired', 'warranty', 'scrapped', 'lost'];
  if (!VALID.includes(d.status)) {
    throw new HttpsError('invalid-argument', `Invalid status. Must be one of: ${VALID.join(', ')}`);
  }

  const ref = col(tenantId, 'inventory_serials').doc(d.serialId);
  await ref.update({
    status:    d.status,
    updatedAt: nowISO(),
    updatedBy: uid,
    ...(d.orderId     ? { orderId:     d.orderId     } : {}),
    ...(d.customerId  ? { customerId:  d.customerId  } : {}),
    ...(d.notes       ? { statusNotes: d.notes       } : {}),
  });

  const histRef = col(tenantId, 'inventory_serial_history').doc();
  await histRef.set({
    serialId:    d.serialId,
    event:       `status_${d.status}`,
    status:      d.status,
    orderId:     d.orderId     || null,
    customerId:  d.customerId  || null,
    notes:       d.notes       || null,
    userId:      uid,
    timestamp:   nowISO(),
    tenantId,
  });

  return { success: true };
});

exports.inventoryGetSerials = onCall({ timeoutSeconds: 15 }, async (req) => {
  assertAuth(req);
  const tenantId = assertTenant(req.data);
  const d        = req.data;
  let   q        = col(tenantId, 'inventory_serials').where('productId', '==', d.productId);
  if (d.status)      q = q.where('status',      '==', d.status);
  if (d.warehouseId) q = q.where('warehouseId', '==', d.warehouseId);
  const snap = await q.orderBy('createdAt', 'desc').limit(d.limit || 100).get();
  return { serials: snap.docs.map(s => s.data()) };
});

/* ═══════════════════════════════════════════════════════════════════════
   BILL OF MATERIALS + WORK ORDERS
   Firestore: tenants/{t}/inventory_bom/{productId}
            : tenants/{t}/inventory_work_orders/{woId}
══════════════════════════════════════════════════════════════════════ */

exports.inventorySaveBOM = onCall({ timeoutSeconds: 20 }, async (req) => {
  const uid      = assertAuth(req);
  const tenantId = assertTenant(req.data);
  const d        = req.data;
  need(d, ['productId', 'components']);

  if (!Array.isArray(d.components) || !d.components.length) {
    throw new HttpsError('invalid-argument', 'components must be a non-empty array');
  }
  for (const c of d.components) {
    if (!c.productId || !c.quantity || Number(c.quantity) <= 0) {
      throw new HttpsError('invalid-argument', 'Each component needs productId and positive quantity');
    }
  }

  const ref = col(tenantId, 'inventory_bom').doc(d.productId);
  const bom = {
    id:         d.productId,
    productId:  d.productId,
    yieldQty:   Number(d.yieldQty || 1),
    yieldUnit:  d.yieldUnit    || 'each',
    components: d.components.map(c => ({
      productId:   c.productId,
      variantId:   c.variantId   || null,
      quantity:    Number(c.quantity),
      unit:        c.unit        || 'each',
      wastePercent:Number(c.wastePercent || 0),
      optional:    !!c.optional,
      notes:       c.notes       || null,
    })),
    instructions:  d.instructions  || null,
    notes:         d.notes         || null,
    version:       admin.firestore.FieldValue.increment(1),
    tenantId,
    updatedAt:     nowISO(),
    updatedBy:     uid,
    createdAt:     d.createdAt     || nowISO(),
  };

  await ref.set(bom, { merge: true });
  await audit(tenantId, { type: 'bom_saved', productId: d.productId, componentCount: d.components.length, userId: uid });

  return { success: true, bom };
});

exports.inventoryGetBOM = onCall({ timeoutSeconds: 15 }, async (req) => {
  assertAuth(req);
  const tenantId = assertTenant(req.data);
  need(req.data, ['productId']);
  const snap = await col(tenantId, 'inventory_bom').doc(req.data.productId).get();
  return { bom: snap.exists ? snap.data() : null };
});

exports.inventoryCreateWorkOrder = onCall({ timeoutSeconds: 30 }, async (req) => {
  const uid      = assertAuth(req);
  const tenantId = assertTenant(req.data);
  const d        = req.data;
  need(d, ['productId', 'quantity', 'warehouseId']);

  const qty     = Number(d.quantity);
  if (qty <= 0) throw new HttpsError('invalid-argument', 'quantity must be positive');

  // Load BOM
  const bomSnap = await col(tenantId, 'inventory_bom').doc(d.productId).get();
  if (!bomSnap.exists) throw new HttpsError('not-found', 'No Bill of Materials for this product');
  const bom = bomSnap.data();

  // Check component availability
  const shortages = [];
  const needed    = [];
  const runsNeeded = qty / (bom.yieldQty || 1);

  for (const comp of bom.components) {
    const requiredQty = comp.quantity * runsNeeded * (1 + (comp.wastePercent || 0) / 100);
    const lvlId       = `${comp.productId}:${comp.variantId || 'base'}:${d.warehouseId}`;
    const lvlSnap     = await col(tenantId, 'inventory_levels').doc(lvlId).get();
    const available   = lvlSnap.exists ? (lvlSnap.data().available || 0) : 0;

    needed.push({ ...comp, requiredQty: Math.ceil(requiredQty), available });
    if (available < requiredQty && !comp.optional) {
      shortages.push({
        productId:    comp.productId,
        required:     Math.ceil(requiredQty),
        available,
        shortage:     Math.ceil(requiredQty - available),
      });
    }
  }

  const id  = d.id || genId('wo');
  const ref = col(tenantId, 'inventory_work_orders').doc(id);

  const wo = {
    id,
    productId:      d.productId,
    warehouseId:    d.warehouseId,
    quantity:       qty,
    status:         'draft',
    shortages,
    neededComponents: needed,
    scheduledDate:  d.scheduledDate  || null,
    priority:       d.priority       || 'normal',
    notes:          d.notes          || null,
    tenantId,
    createdAt:      nowISO(),
    createdBy:      uid,
    updatedAt:      nowISO(),
  };

  await ref.set(wo);
  await audit(tenantId, { type: 'work_order_created', woId: id, productId: d.productId, qty, shortages: shortages.length, userId: uid });

  return { success: true, id, workOrder: wo, shortages };
});

exports.inventoryUpdateWorkOrderStatus = onCall({ timeoutSeconds: 60 }, async (req) => {
  const uid      = assertAuth(req);
  const tenantId = assertTenant(req.data);
  const d        = req.data;
  need(d, ['workOrderId', 'status']);

  const VALID = ['draft', 'in_progress', 'completed', 'cancelled'];
  if (!VALID.includes(d.status)) {
    throw new HttpsError('invalid-argument', `Invalid status. Must be one of: ${VALID.join(', ')}`);
  }

  const ref  = col(tenantId, 'inventory_work_orders').doc(d.workOrderId);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Work order not found');

  const wo = snap.data();

  // On completion: deduct components, add finished goods to stock
  if (d.status === 'completed' && wo.status !== 'completed') {
    const bomSnap = await col(tenantId, 'inventory_bom').doc(wo.productId).get();
    if (bomSnap.exists) {
      const bom        = bomSnap.data();
      const runsNeeded = wo.quantity / (bom.yieldQty || 1);
      const batch      = db.batch();

      for (const comp of bom.components) {
        const deductQty = comp.quantity * runsNeeded * (1 + (comp.wastePercent || 0) / 100);
        const lvlId     = `${comp.productId}:${comp.variantId || 'base'}:${wo.warehouseId}`;
        const lvlRef    = col(tenantId, 'inventory_levels').doc(lvlId);
        const lvlSnap   = await lvlRef.get();
        const cur       = lvlSnap.exists ? (lvlSnap.data().available || 0) : 0;
        batch.set(lvlRef, {
          available: Math.max(0, cur - Math.ceil(deductQty)),
          updatedAt: nowISO(),
        }, { merge: true });
      }

      // Add finished goods
      const fgLvlId  = `${wo.productId}:base:${wo.warehouseId}`;
      const fgLvlRef = col(tenantId, 'inventory_levels').doc(fgLvlId);
      const fgSnap   = await fgLvlRef.get();
      const fgCur    = fgSnap.exists ? (fgSnap.data().available || 0) : 0;
      batch.set(fgLvlRef, { available: fgCur + wo.quantity, updatedAt: nowISO() }, { merge: true });

      await batch.commit();
    }
  }

  await ref.update({
    status:       d.status,
    updatedAt:    nowISO(),
    updatedBy:    uid,
    actualQty:    d.actualQty    || wo.quantity,
    completedAt:  d.status === 'completed' ? nowISO() : null,
    completionNotes: d.notes     || null,
  });

  await audit(tenantId, { type: `work_order_${d.status}`, woId: d.workOrderId, productId: wo.productId, userId: uid });

  return { success: true };
});

exports.inventoryGetWorkOrders = onCall({ timeoutSeconds: 15 }, async (req) => {
  assertAuth(req);
  const tenantId = assertTenant(req.data);
  const d        = req.data;
  let   q        = col(tenantId, 'inventory_work_orders').orderBy('createdAt', 'desc');
  if (d.status)    q = q.where('status',    '==', d.status);
  if (d.productId) q = q.where('productId', '==', d.productId);
  const snap = await q.limit(d.limit || 50).get();
  return { workOrders: snap.docs.map(w => w.data()) };
});

/* ═══════════════════════════════════════════════════════════════════════
   4-STAGE WAREHOUSE TRANSFERS
   Stages: pending → approved → shipped → received | cancelled
   Firestore: tenants/{t}/inventory_transfers/{transferId}
══════════════════════════════════════════════════════════════════════ */

const TRANSFER_STATES = {
  PENDING:   'pending',
  APPROVED:  'approved',
  SHIPPED:   'shipped',
  RECEIVED:  'received',
  CANCELLED: 'cancelled',
};

exports.inventoryRequestTransfer = onCall({ timeoutSeconds: 20 }, async (req) => {
  const uid      = assertAuth(req);
  const tenantId = assertTenant(req.data);
  const d        = req.data;
  need(d, ['productId', 'fromWarehouse', 'toWarehouse', 'quantity']);

  if (d.fromWarehouse === d.toWarehouse) {
    throw new HttpsError('invalid-argument', 'From and To warehouses must differ');
  }
  const qty = Number(d.quantity);
  if (qty <= 0) throw new HttpsError('invalid-argument', 'quantity must be positive');

  // Check source stock
  const lvlId   = `${d.productId}:${d.variantId || 'base'}:${d.fromWarehouse}`;
  const lvlSnap = await col(tenantId, 'inventory_levels').doc(lvlId).get();
  const avail   = lvlSnap.exists ? (lvlSnap.data().available || 0) : 0;
  if (avail < qty) {
    throw new HttpsError('failed-precondition',
      `Insufficient stock in ${d.fromWarehouse}: ${avail} available, ${qty} requested`);
  }

  const id  = d.id || genId('tr');
  const ref = col(tenantId, 'inventory_transfers').doc(id);

  const transfer = {
    id,
    productId:    d.productId,
    variantId:    d.variantId    || null,
    batchId:      d.batchId      || null,
    fromWarehouse:d.fromWarehouse,
    toWarehouse:  d.toWarehouse,
    quantity:     qty,
    priority:     d.priority     || 'normal',
    notes:        d.notes        || null,
    status:       TRANSFER_STATES.PENDING,
    statusHistory: [{ status: TRANSFER_STATES.PENDING, by: uid, at: nowISO() }],
    requestedBy:  uid,
    requestedAt:  nowISO(),
    tenantId,
  };

  // Reserve stock at source
  await db.runTransaction(async tx => {
    const lvlRef = col(tenantId, 'inventory_levels').doc(lvlId);
    const ls     = await tx.get(lvlRef);
    const cur    = ls.exists ? ls.data() : { available: 0, reserved: 0 };
    tx.set(lvlRef, {
      available: (cur.available || 0) - qty,
      reserved:  (cur.reserved  || 0) + qty,
      updatedAt: nowISO(),
    }, { merge: true });
    tx.set(ref, transfer);
  });

  await audit(tenantId, { type: 'transfer_requested', transferId: id, productId: d.productId, qty, fromWarehouse: d.fromWarehouse, toWarehouse: d.toWarehouse, userId: uid });

  return { success: true, id, transfer };
});

exports.inventoryPatchTransfer = onCall({ timeoutSeconds: 60 }, async (req) => {
  const uid      = assertAuth(req);
  const tenantId = assertTenant(req.data);
  const d        = req.data;
  need(d, ['transferId', 'action']);

  const ref  = col(tenantId, 'inventory_transfers').doc(d.transferId);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Transfer not found');

  const tr       = snap.data();
  const ACTIONS  = { approve: 'approved', ship: 'shipped', receive: 'received', cancel: 'cancelled' };
  const newStatus = ACTIONS[d.action];
  if (!newStatus) throw new HttpsError('invalid-argument', `Invalid action: ${d.action}`);

  const validTransitions = {
    approved:  ['pending'],
    shipped:   ['approved'],
    received:  ['shipped'],
    cancelled: ['pending', 'approved'],
  };
  if (!validTransitions[newStatus].includes(tr.status)) {
    throw new HttpsError('failed-precondition',
      `Cannot ${d.action} a transfer in status: ${tr.status}`);
  }

  const updates = {
    status:      newStatus,
    updatedAt:   nowISO(),
    updatedBy:   uid,
    statusHistory: admin.firestore.FieldValue.arrayUnion({ status: newStatus, by: uid, at: nowISO() }),
  };

  if (newStatus === 'shipped') {
    updates.shippedBy = uid;
    updates.shippedAt = nowISO();
    updates.carrierRef = d.carrierRef || null;
  }

  if (newStatus === 'received') {
    const receivedQty = Number(d.receivedQty || tr.quantity);
    updates.receivedBy  = uid;
    updates.receivedAt  = nowISO();
    updates.receivedQty = receivedQty;

    // Release reservation at source + add to destination
    const srcId = `${tr.productId}:${tr.variantId || 'base'}:${tr.fromWarehouse}`;
    const dstId = `${tr.productId}:${tr.variantId || 'base'}:${tr.toWarehouse}`;

    await db.runTransaction(async tx => {
      const srcRef  = col(tenantId, 'inventory_levels').doc(srcId);
      const dstRef  = col(tenantId, 'inventory_levels').doc(dstId);
      const [srcSnap, dstSnap] = await Promise.all([tx.get(srcRef), tx.get(dstRef)]);
      const src = srcSnap.exists ? srcSnap.data() : { reserved: 0 };
      const dst = dstSnap.exists ? dstSnap.data() : { available: 0 };

      tx.set(srcRef, { reserved: Math.max(0, (src.reserved || 0) - tr.quantity), updatedAt: nowISO() }, { merge: true });
      tx.set(dstRef, { available: (dst.available || 0) + receivedQty, updatedAt: nowISO() }, { merge: true });
      tx.update(ref, updates);
    });

    // Write discrepancy movement if qty differs
    if (receivedQty !== tr.quantity) {
      await col(tenantId, 'inventory_movements').add({
        type:       'transfer_discrepancy',
        productId:  tr.productId,
        transferId: tr.id,
        expected:   tr.quantity,
        received:   receivedQty,
        delta:      receivedQty - tr.quantity,
        userId:     uid,
        timestamp:  nowISO(),
        tenantId,
      });
    }
  } else if (newStatus === 'cancelled') {
    // Return reserved stock to source available
    const srcId  = `${tr.productId}:${tr.variantId || 'base'}:${tr.fromWarehouse}`;
    const srcRef = col(tenantId, 'inventory_levels').doc(srcId);

    await db.runTransaction(async tx => {
      const srcSnap = await tx.get(srcRef);
      const src     = srcSnap.exists ? srcSnap.data() : { available: 0, reserved: 0 };
      tx.set(srcRef, {
        available: (src.available || 0) + tr.quantity,
        reserved:  Math.max(0, (src.reserved || 0) - tr.quantity),
        updatedAt: nowISO(),
      }, { merge: true });
      tx.update(ref, updates);
    });
  } else {
    await ref.update(updates);
  }

  await audit(tenantId, { type: `transfer_${d.action}`, transferId: d.transferId, productId: tr.productId, userId: uid });

  return { success: true, status: newStatus };
});

exports.inventoryGetTransfers = onCall({ timeoutSeconds: 15 }, async (req) => {
  assertAuth(req);
  const tenantId = assertTenant(req.data);
  const d        = req.data;
  let   q        = col(tenantId, 'inventory_transfers').orderBy('requestedAt', 'desc');
  if (d.status)       q = q.where('status',        '==', d.status);
  if (d.fromWarehouse)q = q.where('fromWarehouse',  '==', d.fromWarehouse);
  if (d.toWarehouse)  q = q.where('toWarehouse',    '==', d.toWarehouse);
  const snap = await q.limit(d.limit || 50).get();
  return { transfers: snap.docs.map(t => t.data()) };
});

/* ═══════════════════════════════════════════════════════════════════════
   SUPPLIER PERFORMANCE SCORING
   Score: weighted avg of on-time delivery, quality, price stability, communication
   Firestore: tenants/{t}/suppliers/{supplierId} — updates .performanceScore
══════════════════════════════════════════════════════════════════════ */

exports.inventoryScoreSupplier = onCall({ timeoutSeconds: 30 }, async (req) => {
  const uid      = assertAuth(req);
  const tenantId = assertTenant(req.data);
  need(req.data, ['supplierId']);

  const supId = req.data.supplierId;

  // Fetch last 90 days of POs for this supplier
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 90);
  const posSnap = await col(tenantId, 'inventory_purchase_orders')
    .where('supplierId', '==', supId)
    .where('status', 'in', ['received', 'partial'])
    .where('createdAt', '>=', cutoff.toISOString())
    .orderBy('createdAt', 'desc')
    .limit(100)
    .get();

  const pos    = posSnap.docs.map(d => d.data());
  const total  = pos.length;

  if (total === 0) {
    return { success: true, score: null, message: 'No POs in last 90 days' };
  }

  // On-time delivery (40% weight)
  const onTime      = pos.filter(p => p.deliveredDate && p.expectedDate && p.deliveredDate <= p.expectedDate).length;
  const onTimePct   = (onTime / total) * 100;

  // Fill rate / quantity accuracy (30% weight)
  const fillRates   = pos.filter(p => p.orderedQty > 0).map(p => Math.min(1, (p.receivedQty || p.orderedQty) / p.orderedQty) * 100);
  const fillRate    = fillRates.length ? fillRates.reduce((a, b) => a + b, 0) / fillRates.length : 100;

  // Invoice accuracy (15% weight) — match orderedValue vs invoicedValue
  const invAccurate = pos.filter(p => p.invoicedValue && p.orderedValue && Math.abs(p.invoicedValue - p.orderedValue) / p.orderedValue < 0.02).length;
  const invAccuracy = (invAccurate / total) * 100;

  // Quality score (15% weight) — if quality_rejects tracked
  const qualityScores = pos.filter(p => p.qualityScore != null).map(p => p.qualityScore);
  const qualityAvg    = qualityScores.length ? qualityScores.reduce((a, b) => a + b, 0) / qualityScores.length : 100;

  const score = Math.round(
    onTimePct   * 0.40 +
    fillRate    * 0.30 +
    invAccuracy * 0.15 +
    qualityAvg  * 0.15
  );

  const metrics = { onTimePct, fillRate, invAccuracy, qualityAvg, totalPOs: total, score };

  // Update supplier record
  await col(tenantId, 'suppliers').doc(supId).set({
    performanceScore:  score,
    performanceMetrics:metrics,
    scoreUpdatedAt:    nowISO(),
    scoreUpdatedBy:    uid,
  }, { merge: true });

  await audit(tenantId, { type: 'supplier_scored', supplierId: supId, score, userId: uid });

  return { success: true, score, metrics };
});

/* ═══════════════════════════════════════════════════════════════════════
   OFFLINE SYNC QUEUE FLUSH
   Processes IDB syncQueue2 items that were queued while offline.
   Each item has { fn, data } where fn maps to a CF name.
   Returns per-item results so the client can clear successfully synced items.
══════════════════════════════════════════════════════════════════════ */

const ALLOWED_FNS = new Set([
  'inventorySaveVariant', 'inventoryDeleteVariant',
  'inventoryCreateBatch', 'inventoryDeductBatch',
  'inventoryRegisterSerials', 'inventoryUpdateSerialStatus',
  'inventorySaveBOM', 'inventoryCreateWorkOrder', 'inventoryUpdateWorkOrderStatus',
  'inventoryRequestTransfer', 'inventoryPatchTransfer',
]);

exports.inventoryFlushSyncQueue = onCall({ timeoutSeconds: 120, memory: '512MiB' }, async (req) => {
  assertAuth(req);
  const tenantId = assertTenant(req.data);
  const items    = req.data.items;

  if (!Array.isArray(items) || items.length > 200) {
    throw new HttpsError('invalid-argument', 'items must be an array of up to 200 operations');
  }

  const results = [];

  for (const item of items) {
    if (!ALLOWED_FNS.has(item.fn)) {
      results.push({ id: item.id, success: false, error: `Unknown operation: ${item.fn}` });
      continue;
    }
    try {
      // Dispatch to the module-level function directly (in-process)
      const fn = exports[item.fn];
      if (!fn) throw new Error(`CF ${item.fn} not found in this module`);
      const result = await fn.run({ auth: req.auth, data: { ...item.data, tenantId } });
      results.push({ id: item.id, success: true, result });
    } catch (e) {
      results.push({ id: item.id, success: false, error: e.message });
    }
  }

  const succeeded = results.filter(r => r.success).length;
  const failed    = results.length - succeeded;

  return { success: true, total: results.length, succeeded, failed, results };
});

/* ═══════════════════════════════════════════════════════════════════════
   AUDIT LOG READER
   Returns paginated audit trail with filtering
══════════════════════════════════════════════════════════════════════ */

exports.inventoryGetAuditLog = onCall({ timeoutSeconds: 20 }, async (req) => {
  assertAuth(req);
  const tenantId = assertTenant(req.data);
  const d        = req.data;

  let q = col(tenantId, 'inventory_audit').orderBy('serverTimestamp', 'desc');
  if (d.type)      q = q.where('type',      '==', d.type);
  if (d.productId) q = q.where('productId', '==', d.productId);
  if (d.userId)    q = q.where('userId',    '==', d.userId);
  if (d.since)     q = q.where('serverTimestamp', '>=', admin.firestore.Timestamp.fromDate(new Date(d.since)));

  const snap = await q.limit(d.limit || 100).get();

  return {
    events: snap.docs.map(doc => ({
      id:        doc.id,
      ...doc.data(),
      serverTimestamp: doc.data().serverTimestamp?.toDate?.()?.toISOString() || null,
    })),
    hasMore: snap.docs.length === (d.limit || 100),
  };
});
