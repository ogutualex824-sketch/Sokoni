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

const { assertAuth } = require('./shared/errors');

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

  const auditRef  = tenantCol(tenantId, 'inventory_audit').doc(data.auditId);
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
  { schedule: 'every day 03:00', timeZone: 'Africa/Nairobi', memory: '512MiB', timeoutSeconds: 300 },
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

/* ─── DASHBOARD STATS (single-call aggregate for overview KPIs) ── */
exports.inventoryGetDashboardStats = onCall({ timeoutSeconds: 60, memory: '512MiB' }, async (req) => {
  assertAuth(req);
  const tenantId = assertTenant(req.data);

  const now   = new Date();
  const todayISO  = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
  const weekISO   = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 7).toISOString();
  const monthISO  = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  const cutoff30  = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 30).toISOString();
  const cutoff90  = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 90).toISOString();
  const expiring7 = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 7).toISOString();

  const col = (path) => db.collection(`tenants/${tenantId}/${path}`);

  const [
    productsSnap, levelsSnap, poSnap, transferSnap,
    todayMvSnap, weekMvSnap, monthMvSnap, expiringSnap,
  ] = await Promise.all([
    col('inventory_products').where('active', '==', true).select(['name','sellingPrice','costPrice','category']).get(),
    col('inventory_levels').get(),
    col('inventory_purchaseOrders').where('status', 'in', ['draft','approved','ordered','partial']).get(),
    col('inventory_transfers').where('status', 'in', ['pending','approved','in_transit']).get(),
    col('inventory_movements').where('ts', '>=', todayISO).get(),
    col('inventory_movements').where('type', '==', 'sale').where('ts', '>=', weekISO).get(),
    col('inventory_movements').where('type', '==', 'sale').where('ts', '>=', monthISO).get(),
    col('inventory_batches').where('expiryDate', '<=', expiring7).where('remaining', '>', 0).get(),
  ]);

  const products  = productsSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  const levels    = levelsSnap.docs.map(d => d.data());

  // Build product map for value calculations
  const prodMap = {};
  products.forEach(p => { prodMap[p.id] = p; });

  // SKU counts and value
  let totalValue = 0, lowStock = 0, outOfStock = 0, overstocked = 0;
  const mvmtByProduct = {}; // productId → total qty sold in 30 days

  levels.forEach(l => {
    const p = prodMap[l.productId];
    if (!p) return;
    const onHand     = (l.available || 0) + (l.reserved || 0);
    const cost       = p.costPrice || p.sellingPrice || 0;
    const reorder    = l.reorderPoint || 10;
    const max        = l.maxStock || reorder * 5;

    totalValue += onHand * cost;
    if (onHand <= 0)               outOfStock++;
    else if (onHand <= reorder)    lowStock++;
    else if (max > 0 && onHand > max) overstocked++;
  });

  // Sales calculations
  let dailySales = 0, weeklySales = 0, monthlySales = 0;
  todayMvSnap.docs.forEach(d => {
    const mv = d.data();
    if (mv.type === 'sale') dailySales += (mv.qty || 0) * (mv.unitPrice || 0);
  });
  weekMvSnap.docs.forEach(d => {
    const mv = d.data();
    weeklySales += (mv.qty || 0) * (mv.unitPrice || 0);
  });
  monthMvSnap.docs.forEach(d => {
    const mv = d.data();
    monthlySales += (mv.qty || 0) * (mv.unitPrice || 0);
    mvmtByProduct[mv.productId] = (mvmtByProduct[mv.productId] || 0) + (mv.qty || 0);
  });

  // Margin analysis
  const withMargin = products
    .filter(p => p.sellingPrice > 0 && p.costPrice > 0)
    .map(p => ({ id: p.id, name: p.name, margin: ((p.sellingPrice - p.costPrice) / p.sellingPrice) * 100 }))
    .sort((a, b) => b.margin - a.margin);

  const highMargin = withMargin.slice(0, 5);
  const lowMargin  = withMargin.slice(-5).reverse();

  // Fast / slow / dead stock (by 30-day movement)
  const sorted = products
    .map(p => ({ id: p.id, name: p.name, sold: mvmtByProduct[p.id] || 0 }))
    .sort((a, b) => b.sold - a.sold);
  const fastMoving = sorted.slice(0, 5);
  const slowMoving = sorted.filter(p => p.sold > 0 && p.sold < 3).slice(0, 5);
  const deadStock  = sorted.filter(p => p.sold === 0).slice(0, 10);

  // PO breakdown
  const incomingPOs      = poSnap.docs.length;
  const awaitingReceipt  = poSnap.docs.filter(d => ['ordered','partial'].includes(d.data().status)).length;

  return {
    totalSKUs       : products.length,
    totalValue,
    lowStock,
    outOfStock,
    overstocked,
    incomingPOs,
    awaitingReceipt,
    pendingTransfers: transferSnap.docs.length,
    todayMovements  : todayMvSnap.docs.length,
    dailySales,
    weeklySales,
    monthlySales,
    expiringBatches : expiringSnap.docs.length,
    fastMoving,
    slowMoving,
    deadStock,
    highMargin,
    lowMargin,
  };
});

/* ─── CLEANUP OLD MOVEMENTS (monthly) ──────────────────────────── */
exports.inventoryCleanupOldMovements = onSchedule(
  { schedule: 'every monday 02:00', timeZone: 'Africa/Nairobi', memory: '256MiB', timeoutSeconds: 300 },
  async () => {
    const cutoff = new Date();
    cutoff.setFullYear(cutoff.getFullYear() - 7); // KRA Tax Procedures Act: 7-year retention
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

/* ─── getPOSInventoryIntelligence ────────────────────────────────────
   Required by pos-inventory-intelligence.html.
   Returns aggregated intelligence data: low stock, expiry, fast movers,
   slow movers, dead stock, overstock, and pending reorders.
   Uses the POS seller path: sellers/{sellerId}/...
   ─────────────────────────────────────────────────────────────────── */
exports.getPOSInventoryIntelligence = onCall(
  { region: 'us-central1', memory: '512MiB', timeoutSeconds: 60 },
  async (req) => {
    const uid = assertAuth(req);
    const sellerId  = req.data?.sellerId || uid;
    const branchId  = req.data?.branchId || 'default';
    const DAYS_SLOW = 30; // no sales in 30 days = slow mover

    const productsSnap  = await db.collection(`sellers/${sellerId}/products`)
      .where('active','==',true).limit(500).get();
    const inventorySnap = await db.collection(`sellers/${sellerId}/inventory`)
      .where('branchId','==',branchId).get();
    const batchesSnap   = await db.collection(`sellers/${sellerId}/batches`)
      .orderBy('expiryDate','asc').limit(200).get();
    const movementsSnap = await db.collection(`sellers/${sellerId}/movements`)
      .orderBy('createdAt','desc').limit(1000).get();

    const products  = {};
    productsSnap.docs.forEach(d => { products[d.id] = { id: d.id, ...d.data() }; });

    const inventory = {};
    inventorySnap.docs.forEach(d => { inventory[d.data().productId] = d.data(); });

    const now    = new Date();
    const alert  = new Date(now.getTime() + 7  * 86400000);
    const warn   = new Date(now.getTime() + 30 * 86400000);
    const slowCutoff = new Date(now.getTime() - DAYS_SLOW * 86400000);

    /* Build per-product sales counts in last 30 days */
    const salesCount = {};
    movementsSnap.docs.forEach(d => {
      const mv = d.data();
      if (mv.type === 'sale' && mv.createdAt?.toDate() >= slowCutoff) {
        salesCount[mv.productId] = (salesCount[mv.productId] || 0) + (mv.qty || 0);
      }
    });

    /* Last sale date per product */
    const lastSaleDate = {};
    movementsSnap.docs.forEach(d => {
      const mv = d.data();
      if (mv.type === 'sale' && mv.productId) {
        if (!lastSaleDate[mv.productId]) lastSaleDate[mv.productId] = mv.createdAt;
      }
    });

    const result = {
      lowStock:     [],
      expiry:       [],
      fastMovers:   [],
      slowMovers:   [],
      deadStock:    [],
      overstock:    [],
      reorderQueue: [],
    };

    for (const [id, prod] of Object.entries(products)) {
      const inv  = inventory[id] || { qty: 0 };
      const qty  = inv.qty || 0;
      const rp   = prod.reorderPoint || 5;
      const max  = prod.maxStock || 0;
      const sold = salesCount[id] || 0;
      const last = lastSaleDate[id]?.toDate();
      const daysSinceLastSale = last ? Math.round((now - last) / 86400000) : 999;

      const base = { id, name: prod.name, sku: prod.sku||'', category: prod.category||'', qty, reorderPoint: rp, maxStock: max, unitPrice: prod.sellingPrice||0, supplierId: prod.supplierId||null };

      if (qty === 0 || (qty > 0 && qty <= rp))     result.lowStock.push({ ...base, urgency: qty === 0 ? 'critical' : 'warning' });
      if (qty > 0 && max > 0 && qty > max * 1.5)   result.overstock.push({ ...base, excess: qty - max });
      if (qty <= rp)                                result.reorderQueue.push({ ...base, suggestedQty: Math.max(rp * 2, max || rp * 3) });
      if (sold >= 10)                               result.fastMovers.push({ ...base, soldLast30: sold });
      if (sold === 0 && daysSinceLastSale > 90)     result.deadStock.push({ ...base, daysSinceLastSale });
      else if (sold < 3 && daysSinceLastSale > 30)  result.slowMovers.push({ ...base, soldLast30: sold, daysSinceLastSale });
    }

    /* Expiry from batches */
    batchesSnap.docs.forEach(d => {
      const b   = d.data();
      const exp = b.expiryDate?.toDate();
      if (!exp) return;
      const daysLeft = Math.round((exp - now) / 86400000);
      if (daysLeft <= 30) {
        const prod = products[b.productId] || {};
        result.expiry.push({
          id: b.productId, batchId: d.id, name: prod.name||b.productId,
          sku: prod.sku||'', qty: b.qty||0, expiryDate: b.expiryDate, daysLeft,
          urgency: daysLeft <= 0 ? 'expired' : daysLeft <= 7 ? 'critical' : 'warning',
        });
      }
    });

    /* Sort results */
    result.fastMovers.sort((a,b) => b.soldLast30 - a.soldLast30);
    result.slowMovers.sort((a,b) => a.soldLast30 - b.soldLast30);
    result.deadStock.sort((a,b) => b.daysSinceLastSale - a.daysSinceLastSale);
    result.expiry.sort((a,b) => a.daysLeft - b.daysLeft);

    const summary = {
      criticalLowStock:    result.lowStock.filter(i => i.urgency === 'critical').length,
      expiringWithin7Days: result.expiry.filter(i => i.daysLeft <= 7 && i.daysLeft >= 0).length,
      fastMovers:          result.fastMovers.length,
      deadStock:           result.deadStock.length,
      overstocked:         result.overstock.length,
      pendingReorders:     result.reorderQueue.length,
      sellingProducts:     Object.values(salesCount).filter(v => v > 0).length,
    };

    return { summary, ...result, generatedAt: nowISO() };
  }
);
