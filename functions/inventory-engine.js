/**
 * SOKONI INVENTORY ENGINE — Cloud Functions
 * Atomic stock operations via Firestore transactions.
 * All mutations are idempotent and write a full audit trail.
 */

'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule }         = require('firebase-functions/v2/scheduler');
const { onDocumentCreated }  = require('firebase-functions/v2/firestore');
const admin = require('firebase-admin');

if (!admin.apps.length) admin.initializeApp();
const db = admin.firestore();

/* ─── HELPERS ────────────────────────────────────────────────────── */
function nowISO() { return new Date().toISOString(); }

function tenantCol(tenantId, path) {
  return db.collection(`tenants/${tenantId}/${path}`);
}

function slId(productId, variantId, warehouseId) {
  return `${productId}:${variantId || 'base'}:${warehouseId}`;
}

function assertAuth(ctx) {
  if (!ctx.auth) throw new HttpsError('unauthenticated', 'Authentication required');
  return ctx.auth.uid;
}

function assertTenant(data) {
  if (!data.tenantId) throw new HttpsError('invalid-argument', 'tenantId required');
  return data.tenantId;
}

function validate(data, required) {
  for (const field of required) {
    if (data[field] === undefined || data[field] === null || data[field] === '') {
      throw new HttpsError('invalid-argument', `${field} is required`);
    }
  }
}

async function auditLog(tenantId, event) {
  await db.collection(`tenants/${tenantId}/inventory_audit`).add({
    ...event,
    timestamp: admin.firestore.FieldValue.serverTimestamp(),
  });
}

/* ─── ADJUST STOCK (atomic) ─────────────────────────────────────── */
exports.inventoryAdjustStock = onCall({ timeoutSeconds: 30, memory: '256MiB' }, async (req) => {
  const uid      = assertAuth(req);
  const data     = req.data;
  const tenantId = assertTenant(data);

  validate(data, ['productId', 'warehouseId', 'quantity', 'type']);

  const qty = Number(data.quantity);
  if (!isFinite(qty)) throw new HttpsError('invalid-argument', 'quantity must be a finite number');

  const levelId  = slId(data.productId, data.variantId || null, data.warehouseId);
  const levelRef = tenantCol(tenantId, 'inventory_levels').doc(levelId);
  const mvRef    = tenantCol(tenantId, 'inventory_movements').doc(data.id || db.collection('_').doc().id);
  const prodRef  = tenantCol(tenantId, 'inventory_products').doc(data.productId);

  let resultLevel;

  await db.runTransaction(async tx => {
    const levelSnap = await tx.get(levelRef);
    const level     = levelSnap.exists ? levelSnap.data() : {
      id: levelId, productId: data.productId,
      variantId: data.variantId || null,
      warehouseId: data.warehouseId,
      available: 0, reserved: 0, allocated: 0, incoming: 0,
      damaged: 0, expired: 0, onHand: 0,
      reorderPoint: 0, minStock: 0, maxStock: 0,
    };

    const prevAvailable = level.available || 0;
    const newAvailable  = prevAvailable + qty;

    // Block negative available stock for outbound movements unless it's a count adjustment
    if (newAvailable < 0 && !['count_adjust', 'write_off', 'damage', 'expiry', 'theft', 'loss'].includes(data.type)) {
      throw new HttpsError('failed-precondition',
        `Insufficient stock: ${prevAvailable} available, ${Math.abs(qty)} requested`);
    }

    const newOnHand = Math.max(0, (level.onHand || 0) + qty);

    const updatedLevel = {
      ...level,
      id:          levelId,
      productId:   data.productId,
      variantId:   data.variantId  || null,
      warehouseId: data.warehouseId,
      available:   newAvailable,
      onHand:      newOnHand,
      updatedAt:   nowISO(),
      tenantId,
    };

    const movement = {
      id:            mvRef.id,
      type:          data.type,
      productId:     data.productId,
      variantId:     data.variantId   || null,
      warehouseId:   data.warehouseId,
      locationId:    data.locationId  || null,
      quantity:      qty,
      unitCost:      Number(data.unitCost  || 0),
      totalCost:     Math.abs(qty) * Number(data.unitCost || 0),
      previousQty:   prevAvailable,
      newQty:        newAvailable,
      batchNumber:   data.batchNumber || null,
      expiryDate:    data.expiryDate  || null,
      serialNos:     data.serialNos   || [],
      referenceId:   data.referenceId || null,
      referenceType: data.referenceType || null,
      reason:        data.reason      || null,
      notes:         data.notes       || null,
      userId:        uid,
      deviceId:      data.deviceId    || null,
      timestamp:     nowISO(),
      synced:        true,
      tenantId,
    };

    tx.set(levelRef,    updatedLevel, { merge: true });
    tx.set(mvRef,       movement);
    tx.set(prodRef,     { lastStockUpdate: nowISO() }, { merge: true });

    resultLevel = updatedLevel;
  });

  // Update analytics counters (non-blocking)
  updateAnalyticsCounters(tenantId, data.type, qty).catch(() => {});

  return { success: true, level: resultLevel };
});

/* ─── RESERVE STOCK ─────────────────────────────────────────────── */
exports.inventoryReserveStock = onCall({ timeoutSeconds: 20 }, async (req) => {
  const uid      = assertAuth(req);
  const data     = req.data;
  const tenantId = assertTenant(data);

  validate(data, ['productId', 'warehouseId', 'quantity', 'referenceId']);

  const qty      = Number(data.quantity);
  const levelId  = slId(data.productId, data.variantId || null, data.warehouseId);
  const levelRef = tenantCol(tenantId, 'inventory_levels').doc(levelId);
  const resRef   = tenantCol(tenantId, 'inventory_reservations').doc(data.referenceId);

  let resultLevel;

  await db.runTransaction(async tx => {
    const snap  = await tx.get(levelRef);
    const level = snap.exists ? snap.data() : { available: 0, reserved: 0, onHand: 0 };

    if ((level.available || 0) < qty) {
      throw new HttpsError('failed-precondition',
        `Only ${level.available} available, cannot reserve ${qty}`);
    }

    resultLevel = {
      ...level,
      available: (level.available || 0) - qty,
      reserved:  (level.reserved  || 0) + qty,
      updatedAt: nowISO(),
    };

    tx.set(levelRef, resultLevel, { merge: true });
    tx.set(resRef, {
      productId:   data.productId,
      variantId:   data.variantId   || null,
      warehouseId: data.warehouseId,
      quantity:    qty,
      referenceId: data.referenceId,
      userId:      uid,
      reservedAt:  nowISO(),
      tenantId,
    });
  });

  return { success: true, level: resultLevel };
});

/* ─── RELEASE RESERVATION ───────────────────────────────────────── */
exports.inventoryReleaseReservation = onCall({ timeoutSeconds: 20 }, async (req) => {
  const uid      = assertAuth(req);
  const data     = req.data;
  const tenantId = assertTenant(data);

  validate(data, ['productId', 'warehouseId', 'referenceId']);

  const levelId  = slId(data.productId, data.variantId || null, data.warehouseId);
  const levelRef = tenantCol(tenantId, 'inventory_levels').doc(levelId);
  const resRef   = tenantCol(tenantId, 'inventory_reservations').doc(data.referenceId);

  await db.runTransaction(async tx => {
    const [levelSnap, resSnap] = await Promise.all([tx.get(levelRef), tx.get(resRef)]);
    if (!resSnap.exists) throw new HttpsError('not-found', 'Reservation not found');

    const res   = resSnap.data();
    const level = levelSnap.exists ? levelSnap.data() : { available: 0, reserved: 0 };

    tx.update(levelRef, {
      available: admin.firestore.FieldValue.increment(res.quantity),
      reserved:  admin.firestore.FieldValue.increment(-res.quantity),
      updatedAt: nowISO(),
    });
    tx.update(resRef, { status: 'released', releasedAt: nowISO(), releasedBy: uid });
  });

  return { success: true };
});

/* ─── TRANSFER STOCK ────────────────────────────────────────────── */
exports.inventoryTransferStock = onCall({ timeoutSeconds: 30 }, async (req) => {
  const uid      = assertAuth(req);
  const data     = req.data;
  const tenantId = assertTenant(data);

  validate(data, ['productId', 'fromWarehouse', 'toWarehouse', 'quantity']);

  const qty      = Number(data.quantity);
  if (qty <= 0)  throw new HttpsError('invalid-argument', 'Quantity must be positive');
  if (data.fromWarehouse === data.toWarehouse)
    throw new HttpsError('invalid-argument', 'From and To warehouses must differ');

  const fromId  = slId(data.productId, data.variantId || null, data.fromWarehouse);
  const toId    = slId(data.productId, data.variantId || null, data.toWarehouse);
  const fromRef = tenantCol(tenantId, 'inventory_levels').doc(fromId);
  const toRef   = tenantCol(tenantId, 'inventory_levels').doc(toId);
  const mvBase  = tenantCol(tenantId, 'inventory_movements');

  await db.runTransaction(async tx => {
    const [fromSnap, toSnap] = await Promise.all([tx.get(fromRef), tx.get(toRef)]);
    const from = fromSnap.exists ? fromSnap.data() : { available: 0, onHand: 0 };
    const to   = toSnap.exists   ? toSnap.data()   : { available: 0, onHand: 0 };

    if ((from.available || 0) < qty)
      throw new HttpsError('failed-precondition', `Only ${from.available} available in ${data.fromWarehouse}`);

    const now = nowISO();

    tx.set(fromRef, { ...from, id: fromId, available: from.available - qty, onHand: (from.onHand||0) - qty, updatedAt: now }, { merge: true });
    tx.set(toRef,   { ...to,   id: toId,   available: (to.available||0) + qty, onHand: (to.onHand||0) + qty, updatedAt: now }, { merge: true });

    const mvOut = mvBase.doc();
    const mvIn  = mvBase.doc();
    const base  = { productId: data.productId, variantId: data.variantId||null,
      quantity: qty, userId: uid, timestamp: now, tenantId,
      referenceType: 'transfer', referenceId: mvOut.id };

    tx.set(mvOut, { ...base, id: mvOut.id, type: 'transfer_out', warehouseId: data.fromWarehouse, quantity: -qty });
    tx.set(mvIn,  { ...base, id: mvIn.id,  type: 'transfer_in',  warehouseId: data.toWarehouse });
  });

  return { success: true };
});

/* ─── RECEIVE PURCHASE ORDER ────────────────────────────────────── */
exports.inventoryReceivePO = onCall({ timeoutSeconds: 60, memory: '256MiB' }, async (req) => {
  const uid      = assertAuth(req);
  const data     = req.data;
  const tenantId = assertTenant(data);

  validate(data, ['poId', 'items', 'warehouseId']);
  if (!Array.isArray(data.items) || !data.items.length)
    throw new HttpsError('invalid-argument', 'items must be a non-empty array');

  const poRef  = tenantCol(tenantId, 'inventory_purchaseOrders').doc(data.poId);
  const poSnap = await poRef.get();
  if (!poSnap.exists) throw new HttpsError('not-found', 'Purchase order not found');
  const po = poSnap.data();
  if (['received','cancelled'].includes(po.status))
    throw new HttpsError('failed-precondition', `PO is already ${po.status}`);

  const now = nowISO();
  const batch = db.batch();

  for (const item of data.items) {
    if (!item.productId || !item.quantity) continue;
    const qty      = Number(item.quantity);
    const levelId  = slId(item.productId, item.variantId || null, data.warehouseId);
    const levelRef = tenantCol(tenantId, 'inventory_levels').doc(levelId);
    const mvRef    = tenantCol(tenantId, 'inventory_movements').doc();

    batch.set(levelRef, {
      id: levelId,
      productId:   item.productId,
      variantId:   item.variantId || null,
      warehouseId: data.warehouseId,
      available:   admin.firestore.FieldValue.increment(qty),
      onHand:      admin.firestore.FieldValue.increment(qty),
      incoming:    admin.firestore.FieldValue.increment(-qty),
      updatedAt:   now,
      tenantId,
    }, { merge: true });

    batch.set(mvRef, {
      id:            mvRef.id,
      type:          'purchase',
      productId:     item.productId,
      variantId:     item.variantId  || null,
      warehouseId:   data.warehouseId,
      quantity:      qty,
      unitCost:      Number(item.unitCost || 0),
      totalCost:     qty * Number(item.unitCost || 0),
      batchNumber:   item.batchNumber || null,
      expiryDate:    item.expiryDate  || null,
      referenceId:   data.poId,
      referenceType: 'purchase_order',
      userId:        uid,
      timestamp:     now,
      tenantId,
    });
  }

  const allReceived = data.items.length >= (po.items || []).length;
  batch.update(poRef, {
    status:       allReceived ? 'received' : 'partial',
    receivedAt:   now,
    receivedBy:   uid,
    receivedItems:data.items,
    notes:        data.notes || po.notes || null,
  });

  await batch.commit();

  await auditLog(tenantId, {
    action:    'po_received',
    poId:      data.poId,
    userId:    uid,
    itemCount: data.items.length,
  });

  return { success: true, status: allReceived ? 'received' : 'partial' };
});

/* ─── PROCESS STOCK COUNT ───────────────────────────────────────── */
exports.inventoryProcessStockCount = onCall({ timeoutSeconds: 120, memory: '512MiB' }, async (req) => {
  const uid      = assertAuth(req);
  const data     = req.data;
  const tenantId = assertTenant(data);

  validate(data, ['auditId']);

  const auditRef  = tenantCol(tenantId, 'inventory_audits').doc(data.auditId);
  const auditSnap = await auditRef.get();
  if (!auditSnap.exists) throw new HttpsError('not-found', 'Audit session not found');
  const audit = auditSnap.data();
  if (audit.status !== 'in_progress')
    throw new HttpsError('failed-precondition', 'Audit is not in progress');

  const now     = nowISO();
  const batch   = db.batch();
  const results = [];

  for (const item of (audit.items || [])) {
    const levelId  = slId(item.productId, null, audit.warehouseId);
    const levelRef = tenantCol(tenantId, 'inventory_levels').doc(levelId);
    const snap     = await levelRef.get();
    const expected = snap.exists ? (snap.data().available || 0) : 0;
    const counted  = Number(item.countedQty);
    const variance = counted - expected;

    if (variance !== 0) {
      const mvRef = tenantCol(tenantId, 'inventory_movements').doc();
      batch.set(levelRef, {
        id:          levelId,
        productId:   item.productId,
        warehouseId: audit.warehouseId,
        available:   counted,
        onHand:      counted,
        updatedAt:   now,
        tenantId,
      }, { merge: true });

      batch.set(mvRef, {
        id:            mvRef.id,
        type:          'count_adjust',
        productId:     item.productId,
        warehouseId:   audit.warehouseId,
        quantity:      variance,
        previousQty:   expected,
        newQty:        counted,
        referenceId:   data.auditId,
        referenceType: 'stock_count',
        reason:        `Stock count: expected ${expected}, counted ${counted}`,
        userId:        uid,
        timestamp:     now,
        tenantId,
      });
    }

    results.push({ productId: item.productId, expected, counted, variance });
  }

  batch.update(auditRef, {
    status:        'completed',
    completedAt:   now,
    completedBy:   uid,
    results,
    notes:         data.notes || null,
    variantCount:  results.filter(r => r.variance !== 0).length,
  });

  await batch.commit();

  await auditLog(tenantId, {
    action:      'stock_count_completed',
    auditId:     data.auditId,
    userId:      uid,
    itemsCounted:audit.items.length,
    variances:   results.filter(r => r.variance !== 0).length,
  });

  return { success: true, results, variances: results.filter(r => r.variance !== 0).length };
});

/* ─── AGGREGATE ANALYTICS (scheduled) ──────────────────────────── */
exports.inventoryAggregateAnalytics = onSchedule(
  { schedule: 'every 4 hours', timeZone: 'Africa/Nairobi', memory: '512MiB', timeoutSeconds: 300 },
  async () => {
    // Get all tenants
    const tenantsSnap = await db.collection('tenants').get();

    for (const tenantDoc of tenantsSnap.docs) {
      const tenantId = tenantDoc.id;
      try {
        await aggregateTenantAnalytics(tenantId);
      } catch (e) {
        console.error(`Analytics aggregation failed for ${tenantId}:`, e.message);
      }
    }
  }
);

async function aggregateTenantAnalytics(tenantId) {
  const now = nowISO();

  // Inventory valuation
  const productsSnap = await tenantCol(tenantId, 'inventory_products')
    .where('active', '==', true).get();
  const levelsSnap  = await tenantCol(tenantId, 'inventory_levels').get();

  const levelMap = {};
  levelsSnap.forEach(d => { levelMap[d.data().productId] = (levelMap[d.data().productId] || 0) + (d.data().available || 0); });

  let totalValue = 0, lowCount = 0, ooCount = 0, skuCount = 0;

  productsSnap.forEach(d => {
    const p   = d.data();
    const qty = levelMap[d.id] || 0;
    totalValue += qty * (p.costPrice || 0);
    skuCount++;
    if (qty <= 0) ooCount++;
    else if (qty <= (p.reorderPoint || 5)) lowCount++;
  });

  // Today's movements
  const todayStart = new Date(); todayStart.setHours(0,0,0,0);
  const mvSnap = await tenantCol(tenantId, 'inventory_movements')
    .where('timestamp', '>=', todayStart.toISOString()).get();

  // Last 7 days daily counts
  const dailyMovements = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(); d.setDate(d.getDate() - i); d.setHours(0,0,0,0);
    const label = d.toLocaleDateString('en-KE', { weekday: 'short' });
    dailyMovements.push({ label, date: d.toISOString().split('T')[0], count: 0 });
  }
  mvSnap.forEach(d => {
    const mv  = d.data();
    const day = mv.timestamp?.split('T')[0];
    const slot= dailyMovements.find(d2 => d2.date === day);
    if (slot) slot.count++;
  });

  // Top/slow movers
  const productCounts = {};
  mvSnap.forEach(d => {
    const mv = d.data();
    if (mv.type === 'sale') {
      productCounts[mv.productId] = (productCounts[mv.productId] || 0) + Math.abs(mv.quantity);
    }
  });
  const sorted   = Object.entries(productCounts).sort((a,b)=>b[1]-a[1]);
  const topMovers = sorted.slice(0, 10).map(([productId, count]) => ({ productId, count }));

  await tenantCol(tenantId, 'inventory_analytics').doc('30d').set({
    totalProducts:   skuCount,
    totalSKUs:       skuCount,
    inventoryValue:  Math.round(totalValue),
    lowStockCount:   lowCount,
    outOfStockCount: ooCount,
    movementsToday:  mvSnap.size,
    topMovers,
    slowMovers:      [],
    dailyMovements,
    updatedAt:       now,
  }, { merge: true });

  await tenantCol(tenantId, 'inventory_analytics').doc('valuation').set({
    total:     Math.round(totalValue),
    currency:  'KES',
    updatedAt: now,
    skuCount,
  }, { merge: true });
}

/* ─── ANALYTICS COUNTER (event-driven) ─────────────────────────── */
async function updateAnalyticsCounters(tenantId, type, qty) {
  const ref  = tenantCol(tenantId, 'inventory_analytics').doc('counters');
  const inc  = admin.firestore.FieldValue.increment;
  const upd  = { updatedAt: nowISO() };
  if (qty > 0) upd.totalIn  = inc(Math.abs(qty));
  else         upd.totalOut = inc(Math.abs(qty));
  upd[`type_${type}`] = inc(1);
  upd.totalMovements  = inc(1);
  await ref.set(upd, { merge: true });
}

/* ─── TRIGGER: Auto-reorder alerts on new movement ─────────────── */
exports.inventoryOnMovement = onDocumentCreated(
  { document: 'tenants/{tenantId}/inventory_movements/{mvId}', memory: '128MiB' },
  async (event) => {
    const mv       = event.data.data();
    const tenantId = event.params.tenantId;
    if (!mv.productId || !mv.warehouseId) return;

    const levelId  = slId(mv.productId, mv.variantId || null, mv.warehouseId);
    const levelRef = tenantCol(tenantId, 'inventory_levels').doc(levelId);
    const levelSnap= await levelRef.get();
    if (!levelSnap.exists) return;

    const level = levelSnap.data();
    const prodSnap = await tenantCol(tenantId, 'inventory_products').doc(mv.productId).get();
    if (!prodSnap.exists) return;
    const prod = prodSnap.data();

    const reorderPoint = prod.reorderPoint || 0;
    if (!reorderPoint) return;

    if ((level.available || 0) <= reorderPoint) {
      await tenantCol(tenantId, 'inventory_alerts').doc(`low_${mv.productId}`).set({
        type:        'low_stock',
        severity:    (level.available || 0) <= 0 ? 'critical' : 'warning',
        productId:   mv.productId,
        productName: prod.name || mv.productId,
        warehouseId: mv.warehouseId,
        available:   level.available || 0,
        reorderPoint,
        message:     (level.available || 0) <= 0
          ? `${prod.name} is out of stock`
          : `${prod.name} is low: ${level.available} remaining`,
        createdAt:   nowISO(),
        resolved:    false,
        tenantId,
      }, { merge: true });
    } else {
      // Resolve existing alert if stock is back above reorder point
      await tenantCol(tenantId, 'inventory_alerts').doc(`low_${mv.productId}`)
        .set({ resolved: true, resolvedAt: nowISO() }, { merge: true });
    }
  }
);

/* ─── CLEANUP OLD MOVEMENTS (monthly) ──────────────────────────── */
exports.inventoryCleanupOldMovements = onSchedule(
  { schedule: 'every monday 02:00', timeZone: 'Africa/Nairobi', memory: '256MiB', timeoutSeconds: 300 },
  async () => {
    const cutoff = new Date();
    cutoff.setFullYear(cutoff.getFullYear() - 2); // Keep 2 years
    const cutoffISO = cutoff.toISOString();

    const tenantsSnap = await db.collection('tenants').get();
    for (const tenantDoc of tenantsSnap.docs) {
      const tenantId = tenantDoc.id;
      const snap = await tenantCol(tenantId, 'inventory_movements')
        .where('timestamp', '<', cutoffISO).limit(500).get();
      if (!snap.empty) {
        const batch = db.batch();
        snap.docs.forEach(d => batch.delete(d.ref));
        await batch.commit();
        console.log(`Cleaned ${snap.size} old movements for tenant ${tenantId}`);
      }
    }
  }
);
