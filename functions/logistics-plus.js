'use strict';
/**
 * SOKONI Logistics+ — Sprint 4.4
 * Fleet Management | Route Planning | Warehouse Management |
 * Delivery Zones | Cargo & Freight | Logistics Reports
 * 30 Cloud Functions
 */

const { onCall } = require('firebase-functions/v2/https');
const admin      = require('firebase-admin');
const { defineSecret } = require('firebase-functions/params');

// ── helpers ──────────────────────────────────────────────────────────────────
function _db()  { return admin.firestore(); }
function _fv()  { return admin.firestore.FieldValue; }
function _ts()  { return admin.firestore.FieldValue.serverTimestamp(); }
function _id()  { return _db().collection('_').doc().id; }
function _mills(ts) { return ts ? (ts.toMillis ? ts.toMillis() : new Date(ts).getTime()) : 0; }
function _clamp(v, lo, hi, def) { const n = parseInt(v); return isNaN(n) ? def : Math.min(hi, Math.max(lo, n)); }

function _uid(req) {
  if (!req.auth || !req.auth.uid) throw new Error('unauthenticated');
  return req.auth.uid;
}

async function _assertRole(uid, shopId, minRole) {
  if (!shopId) throw new Error('shopId required');
  const shopSnap = await _db().collection('shops').doc(shopId).get();
  if (!shopSnap.exists) throw new Error('shop not found');
  if (shopSnap.data().ownerId === uid) return 'owner';
  const uSnap = await _db().collection('users').doc(uid).get();
  if (uSnap.exists && uSnap.data().role === 'admin') return 'admin';
  if (minRole === 'owner') throw new Error('owner access required');
  const empSnap = await _db().collection('shopEmployees')
    .where('shopId', '==', shopId).where('userId', '==', uid).limit(1).get();
  if (empSnap.empty) throw new Error('forbidden');
  return empSnap.docs[0].data().role || 'employee';
}

// Haversine distance in km
function _haversine(lat1, lng1, lat2, lng2) {
  const R = 6371, rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad, dLng = (lng2 - lng1) * rad;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Nearest-neighbor TSP heuristic
function _nearestNeighbor(stops) {
  if (!stops || stops.length <= 2) return stops;
  const rem = stops.map((s, i) => ({ ...s, _orig: i }));
  const route = [rem.shift()];
  while (rem.length) {
    const last = route[route.length - 1];
    let best = 0, bestDist = Infinity;
    for (let i = 0; i < rem.length; i++) {
      const d = _haversine(last.lat, last.lng, rem[i].lat, rem[i].lng);
      if (d < bestDist) { bestDist = d; best = i; }
    }
    route.push(rem.splice(best, 1)[0]);
  }
  return route;
}

// Point-in-polygon ray casting
function _pointInPolygon(polygon, lat, lng) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].lng, yi = polygon[i].lat;
    const xj = polygon[j].lng, yj = polygon[j].lat;
    const intersect = yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

const _CALL = { region: 'us-central1', enforceAppCheck: true };

// ─────────────────────────────────────────────────────────────────────────────
// FLEET MANAGEMENT  (6 CFs)
// Collections: vehicles/{id}, vehicleLogs/{id}
// ─────────────────────────────────────────────────────────────────────────────

const _VEHICLE_TYPES = ['bike', 'car', 'van', 'truck', 'tuk_tuk', 'bicycle'];

exports.fleetVehicleCreate = onCall(_CALL, async (req) => {
  const uid = _uid(req);
  const { shopId, make, model, plate, type, capacityKg, capacityM3, year } = req.data;
  await _assertRole(uid, shopId, 'manager');
  if (!plate || !type) throw new Error('plate and type required');
  if (!_VEHICLE_TYPES.includes(type)) throw new Error('invalid vehicle type');
  // Ensure plate is unique within shop
  const existing = await _db().collection('vehicles').where('plate', '==', plate.toUpperCase()).limit(1).get();
  if (!existing.empty) throw new Error('vehicle with this plate already registered');
  const id = _id();
  await _db().collection('vehicles').doc(id).set({
    id, shopId, make: make || '', model: model || '', year: year || null,
    plate: plate.toUpperCase(), type,
    capacityKg: capacityKg || null, capacityM3: capacityM3 || null,
    status: 'active',
    odometer: 0, lastServiceOdometer: 0,
    assignedDriverId: null, assignedDriverName: null,
    createdBy: uid, createdAt: _ts(), updatedAt: _ts(),
  });
  return { vehicleId: id };
});

exports.fleetVehicleUpdate = onCall(_CALL, async (req) => {
  const uid = _uid(req);
  const { shopId, vehicleId, status, assignedDriverId, assignedDriverName, odometer } = req.data;
  await _assertRole(uid, shopId, 'manager');
  const snap = await _db().collection('vehicles').doc(vehicleId).get();
  if (!snap.exists || snap.data().shopId !== shopId) throw new Error('vehicle not found');
  const upd = { updatedAt: _ts() };
  if (status)               upd.status             = status;
  if (assignedDriverId)     upd.assignedDriverId   = assignedDriverId;
  if (assignedDriverName)   upd.assignedDriverName = assignedDriverName;
  if (odometer > 0)         upd.odometer           = odometer;
  if (req.data.capacityKg)  upd.capacityKg         = req.data.capacityKg;
  await _db().collection('vehicles').doc(vehicleId).update(upd);
  return { success: true };
});

exports.fleetVehicleList = onCall(_CALL, async (req) => {
  const uid = _uid(req);
  const { shopId, status } = req.data;
  await _assertRole(uid, shopId, 'employee');
  const snap = await _db().collection('vehicles').where('shopId', '==', shopId).limit(100).get();
  let vehicles = snap.docs.map(d => d.data());
  if (status) vehicles = vehicles.filter(v => v.status === status);
  return { vehicles };
});

exports.fleetLogMaintenance = onCall(_CALL, async (req) => {
  const uid = _uid(req);
  const { shopId, vehicleId, type, description, cost, odometerAtService, nextServiceKm } = req.data;
  await _assertRole(uid, shopId, 'employee');
  if (!description) throw new Error('description required');
  const snap = await _db().collection('vehicles').doc(vehicleId).get();
  if (!snap.exists || snap.data().shopId !== shopId) throw new Error('vehicle not found');
  const logId = _id();
  const batch = _db().batch();
  batch.set(_db().collection('vehicleLogs').doc(logId), {
    id: logId, vehicleId, shopId, logType: 'maintenance',
    maintenanceType: type || 'general',
    description, cost: cost || null,
    odometerAtService: odometerAtService || snap.data().odometer || 0,
    nextServiceKm: nextServiceKm || null,
    loggedBy: uid, at: _ts(),
  });
  const vUpd = { updatedAt: _ts() };
  if (odometerAtService) vUpd.lastServiceOdometer = odometerAtService;
  if (odometerAtService) vUpd.odometer = odometerAtService;
  if (type === 'under_repair') vUpd.status = 'maintenance';
  else if (type === 'completed') vUpd.status = 'active';
  batch.update(_db().collection('vehicles').doc(vehicleId), vUpd);
  await batch.commit();
  return { logId };
});

exports.fleetLogFuel = onCall(_CALL, async (req) => {
  const uid = _uid(req);
  const { shopId, vehicleId, litres, costPerLitre, odometer, fuelType, station } = req.data;
  await _assertRole(uid, shopId, 'employee');
  if (!litres || litres <= 0) throw new Error('litres required');
  const snap = await _db().collection('vehicles').doc(vehicleId).get();
  if (!snap.exists || snap.data().shopId !== shopId) throw new Error('vehicle not found');
  const totalCost = litres * (costPerLitre || 0);
  const logId = _id();
  const batch = _db().batch();
  batch.set(_db().collection('vehicleLogs').doc(logId), {
    id: logId, vehicleId, shopId, logType: 'fuel',
    litres, costPerLitre: costPerLitre || null, totalCost,
    fuelType: fuelType || 'petrol', station: station || null,
    odometer: odometer || snap.data().odometer || 0,
    loggedBy: uid, at: _ts(),
  });
  if (odometer > 0) {
    batch.update(_db().collection('vehicles').doc(vehicleId), { odometer, updatedAt: _ts() });
  }
  await batch.commit();
  return { logId, totalCost };
});

exports.fleetGetVehicleStats = onCall(_CALL, async (req) => {
  const uid = _uid(req);
  const { shopId, vehicleId } = req.data;
  await _assertRole(uid, shopId, 'employee');
  const vSnap = await _db().collection('vehicles').doc(vehicleId).get();
  if (!vSnap.exists || vSnap.data().shopId !== shopId) throw new Error('vehicle not found');
  const logsSnap = await _db().collection('vehicleLogs')
    .where('vehicleId', '==', vehicleId).limit(200).get();
  const logs = logsSnap.docs.map(d => d.data());
  const fuelLogs = logs.filter(l => l.logType === 'fuel');
  const maintLogs = logs.filter(l => l.logType === 'maintenance');
  const totalFuelCost = fuelLogs.reduce((s, l) => s + (l.totalCost || 0), 0);
  const totalMaintCost = maintLogs.reduce((s, l) => s + (l.cost || 0), 0);
  const totalLitres = fuelLogs.reduce((s, l) => s + (l.litres || 0), 0);
  return {
    vehicle: vSnap.data(),
    stats: {
      totalFuelCost, totalMaintCost, totalLitres,
      fuelFills: fuelLogs.length, maintenanceEvents: maintLogs.length,
    },
    recentLogs: logs.sort((a, b) => _mills(b.at) - _mills(a.at)).slice(0, 20),
  };
});

// ─────────────────────────────────────────────────────────────────────────────
// ROUTE PLANNING  (5 CFs)
// Collections: deliveryRoutes/{id}
// ─────────────────────────────────────────────────────────────────────────────

exports.routeCreate = onCall(_CALL, async (req) => {
  const uid = _uid(req);
  const { shopId, name, stops, vehicleId, date } = req.data;
  await _assertRole(uid, shopId, 'employee');
  if (!Array.isArray(stops) || stops.length < 2) throw new Error('minimum 2 stops required');
  if (stops.length > 50) throw new Error('max 50 stops per route');
  const validatedStops = stops.map((s, i) => ({
    index: i, orderId: s.orderId || null,
    address: s.address || '', lat: parseFloat(s.lat) || 0, lng: parseFloat(s.lng) || 0,
    customerName: s.customerName || '', customerPhone: s.customerPhone || '',
    timeWindowStart: s.timeWindowStart || null, timeWindowEnd: s.timeWindowEnd || null,
    notes: s.notes || '', status: 'pending',
    arrivedAt: null, completedAt: null, failureReason: null,
  }));
  const id = _id();
  await _db().collection('deliveryRoutes').doc(id).set({
    id, shopId, name: name || ('Route ' + new Date().toLocaleDateString('en-KE')),
    stops: validatedStops, vehicleId: vehicleId || null,
    assignedDriverId: null, assignedDriverName: null,
    date: date ? new Date(date).toISOString() : new Date().toISOString(),
    status: 'draft', optimized: false,
    totalStops: validatedStops.length, completedStops: 0,
    estimatedDistanceKm: 0,
    createdBy: uid, createdAt: _ts(), updatedAt: _ts(),
  });
  return { routeId: id };
});

exports.routeOptimize = onCall(_CALL, async (req) => {
  const uid = _uid(req);
  const { shopId, routeId, keepFirst } = req.data;
  await _assertRole(uid, shopId, 'employee');
  const ref  = _db().collection('deliveryRoutes').doc(routeId);
  const snap = await ref.get();
  if (!snap.exists || snap.data().shopId !== shopId) throw new Error('route not found');
  if (snap.data().status === 'active' || snap.data().status === 'completed') throw new Error('cannot optimize active/completed route');

  const stops = snap.data().stops || [];
  if (stops.length <= 2) return { success: true, message: 'Route too short to optimize' };

  // Separate first stop if keepFirst
  const first = keepFirst ? [stops[0]] : [];
  const toOptimize = keepFirst ? stops.slice(1) : stops;
  const optimized = [...first, ..._nearestNeighbor(toOptimize)];

  // Recalculate estimated distance
  let totalDist = 0;
  for (let i = 1; i < optimized.length; i++) {
    totalDist += _haversine(optimized[i - 1].lat, optimized[i - 1].lng, optimized[i].lat, optimized[i].lng);
  }
  const reindexed = optimized.map((s, i) => ({ ...s, index: i }));
  await ref.update({ stops: reindexed, optimized: true, estimatedDistanceKm: Math.round(totalDist * 10) / 10, updatedAt: _ts() });
  return { success: true, estimatedDistanceKm: Math.round(totalDist * 10) / 10, stopsCount: reindexed.length };
});

exports.routeAssignDriver = onCall(_CALL, async (req) => {
  const uid = _uid(req);
  const { shopId, routeId, driverId, driverName } = req.data;
  await _assertRole(uid, shopId, 'manager');
  if (!driverId) throw new Error('driverId required');
  const ref  = _db().collection('deliveryRoutes').doc(routeId);
  const snap = await ref.get();
  if (!snap.exists || snap.data().shopId !== shopId) throw new Error('route not found');
  await ref.update({
    assignedDriverId: driverId, assignedDriverName: driverName || '',
    status: 'assigned', updatedAt: _ts(),
  });
  return { success: true };
});

exports.routeUpdateStop = onCall(_CALL, async (req) => {
  const uid = _uid(req);
  const { shopId, routeId, stopIndex, status, failureReason } = req.data;
  await _assertRole(uid, shopId, 'employee');
  if (!['arrived', 'delivered', 'failed', 'skipped'].includes(status)) throw new Error('invalid stop status');
  await _db().runTransaction(async tx => {
    const ref  = _db().collection('deliveryRoutes').doc(routeId);
    const snap = await tx.get(ref);
    if (!snap.exists || snap.data().shopId !== shopId) throw new Error('route not found');
    const stops = snap.data().stops || [];
    if (stopIndex < 0 || stopIndex >= stops.length) throw new Error('invalid stopIndex');
    stops[stopIndex] = {
      ...stops[stopIndex], status,
      arrivedAt:   status === 'arrived'   ? new Date().toISOString() : stops[stopIndex].arrivedAt,
      completedAt: ['delivered', 'failed', 'skipped'].includes(status) ? new Date().toISOString() : stops[stopIndex].completedAt,
      failureReason: failureReason || stops[stopIndex].failureReason,
    };
    const completedStops = stops.filter(s => ['delivered', 'failed', 'skipped'].includes(s.status)).length;
    const allDone = completedStops === stops.length;
    const upd = { stops, completedStops, updatedAt: _ts() };
    if (status === 'arrived' && snap.data().status === 'assigned') upd.status = 'active';
    if (allDone) upd.status = 'completed';
    tx.update(ref, upd);
  });
  return { success: true };
});

exports.routeGetActive = onCall(_CALL, async (req) => {
  const uid = _uid(req);
  const { shopId, driverId } = req.data;
  await _assertRole(uid, shopId, 'employee');
  let q = _db().collection('deliveryRoutes').where('shopId', '==', shopId);
  const snap = await q.limit(50).get();
  let routes = snap.docs.map(d => d.data());
  routes = routes.filter(r => ['draft', 'assigned', 'active'].includes(r.status));
  if (driverId) routes = routes.filter(r => r.assignedDriverId === driverId);
  routes.sort((a, b) => _mills(b.createdAt) - _mills(a.createdAt));
  return { routes };
});

// ─────────────────────────────────────────────────────────────────────────────
// WAREHOUSE MANAGEMENT  (7 CFs)
// Collections: warehouseStock/{id}, warehouseReceipts/{id}, pickLists/{id}
// ─────────────────────────────────────────────────────────────────────────────

exports.warehouseReceive = onCall(_CALL, async (req) => {
  const uid = _uid(req);
  const { shopId, supplierId, supplierName, items, purchaseOrderRef } = req.data;
  await _assertRole(uid, shopId, 'employee');
  if (!Array.isArray(items) || !items.length) throw new Error('items required');
  const receiptId = _id();
  const batch = _db().batch();
  const validItems = items.map(item => ({
    productId: item.productId || '', productName: item.productName || '',
    sku: item.sku || '', quantityReceived: parseInt(item.quantityReceived) || 0,
    quantityExpected: parseInt(item.quantityExpected) || 0,
    unitCost: parseFloat(item.unitCost) || 0,
    expiryDate: item.expiryDate || null, batchNumber: item.batchNumber || null,
    binLocation: item.binLocation || null, putaway: false,
  }));
  batch.set(_db().collection('warehouseReceipts').doc(receiptId), {
    id: receiptId, shopId,
    supplierId: supplierId || null, supplierName: supplierName || '',
    purchaseOrderRef: purchaseOrderRef || null,
    items: validItems, itemCount: validItems.length,
    totalItems: validItems.reduce((s, i) => s + i.quantityReceived, 0),
    status: 'received', receivedBy: uid, receivedAt: _ts(), updatedAt: _ts(),
  });
  await batch.commit();
  return { receiptId, itemCount: validItems.length };
});

exports.warehousePutaway = onCall(_CALL, async (req) => {
  const uid = _uid(req);
  const { shopId, receiptId, itemIndex, binLocation } = req.data;
  await _assertRole(uid, shopId, 'employee');
  if (!binLocation) throw new Error('binLocation required');
  await _db().runTransaction(async tx => {
    const rRef  = _db().collection('warehouseReceipts').doc(receiptId);
    const rSnap = await tx.get(rRef);
    if (!rSnap.exists || rSnap.data().shopId !== shopId) throw new Error('receipt not found');
    const items = rSnap.data().items || [];
    if (itemIndex < 0 || itemIndex >= items.length) throw new Error('invalid itemIndex');
    const item = items[itemIndex];
    items[itemIndex] = { ...item, binLocation, putaway: true };
    // Upsert stock
    const stockKey = shopId + '_' + (item.productId || item.sku) + '_' + binLocation;
    const stockRef = _db().collection('warehouseStock').doc(stockKey);
    const stockSnap = await tx.get(stockRef);
    if (stockSnap.exists) {
      tx.update(stockRef, { quantity: _fv().increment(item.quantityReceived), updatedAt: _ts() });
    } else {
      tx.set(stockRef, {
        id: stockKey, shopId, productId: item.productId || '',
        productName: item.productName || '', sku: item.sku || '',
        binLocation, quantity: item.quantityReceived,
        unitCost: item.unitCost || 0, expiryDate: item.expiryDate || null,
        updatedAt: _ts(),
      });
    }
    const allPutaway = items.every(i => i.putaway);
    tx.update(rRef, { items, status: allPutaway ? 'putaway' : 'partial_putaway', updatedAt: _ts() });
  });
  return { success: true };
});

exports.warehouseGeneratePickList = onCall(_CALL, async (req) => {
  const uid = _uid(req);
  const { shopId, orderId, orderItems } = req.data;
  await _assertRole(uid, shopId, 'employee');
  if (!orderId) throw new Error('orderId required');
  if (!Array.isArray(orderItems) || !orderItems.length) throw new Error('orderItems required');
  // Check for available stock
  const pickItems = [];
  for (const oi of orderItems) {
    const stockSnap = await _db().collection('warehouseStock')
      .where('shopId', '==', shopId).where('productId', '==', oi.productId).limit(10).get();
    let remaining = oi.quantity || 1;
    const pickFrom = [];
    for (const doc of stockSnap.docs) {
      if (remaining <= 0) break;
      const s = doc.data();
      if ((s.quantity || 0) <= 0) continue;
      const take = Math.min(remaining, s.quantity);
      pickFrom.push({ stockDocId: doc.id, binLocation: s.binLocation, pickQty: take });
      remaining -= take;
    }
    pickItems.push({
      productId: oi.productId, productName: oi.productName || '', sku: oi.sku || '',
      quantityRequired: oi.quantity || 1, quantityAvailable: (oi.quantity || 1) - remaining,
      shortfall: remaining, pickLocations: pickFrom, picked: false,
    });
  }
  const id = _id();
  await _db().collection('pickLists').doc(id).set({
    id, shopId, orderId, items: pickItems,
    status: pickItems.every(i => i.shortfall === 0) ? 'ready' : 'partial',
    createdBy: uid, createdAt: _ts(), updatedAt: _ts(),
  });
  return { pickListId: id, hasShortfall: pickItems.some(i => i.shortfall > 0), items: pickItems };
});

exports.warehouseConfirmPick = onCall(_CALL, async (req) => {
  const uid = _uid(req);
  const { shopId, pickListId, itemIndex } = req.data;
  await _assertRole(uid, shopId, 'employee');
  await _db().runTransaction(async tx => {
    const plRef  = _db().collection('pickLists').doc(pickListId);
    const plSnap = await tx.get(plRef);
    if (!plSnap.exists || plSnap.data().shopId !== shopId) throw new Error('pick list not found');
    const items = plSnap.data().items || [];
    if (itemIndex < 0 || itemIndex >= items.length) throw new Error('invalid itemIndex');
    const item = items[itemIndex];
    // Deduct from stock locations
    for (const loc of item.pickLocations) {
      const sRef = _db().collection('warehouseStock').doc(loc.stockDocId);
      tx.update(sRef, { quantity: _fv().increment(-loc.pickQty), updatedAt: _ts() });
    }
    items[itemIndex] = { ...item, picked: true, pickedBy: uid, pickedAt: new Date().toISOString() };
    const allPicked = items.every(i => i.picked);
    tx.update(plRef, { items, status: allPicked ? 'picked' : 'picking', updatedAt: _ts() });
  });
  return { success: true };
});

exports.warehouseShipOrder = onCall(_CALL, async (req) => {
  const uid = _uid(req);
  const { shopId, pickListId, trackingNumber, courier } = req.data;
  await _assertRole(uid, shopId, 'employee');
  const ref  = _db().collection('pickLists').doc(pickListId);
  const snap = await ref.get();
  if (!snap.exists || snap.data().shopId !== shopId) throw new Error('pick list not found');
  if (!['picked', 'ready', 'partial'].includes(snap.data().status)) throw new Error('pick list not ready to ship');
  await ref.update({
    status: 'shipped', shippedBy: uid, shippedAt: _ts(),
    trackingNumber: trackingNumber || null, courier: courier || null, updatedAt: _ts(),
  });
  return { success: true };
});

exports.warehouseGetInventory = onCall(_CALL, async (req) => {
  const uid = _uid(req);
  const { shopId, binLocation, lowStockThreshold } = req.data;
  await _assertRole(uid, shopId, 'employee');
  const snap = await _db().collection('warehouseStock').where('shopId', '==', shopId).limit(500).get();
  let stock = snap.docs.map(d => d.data());
  if (binLocation) stock = stock.filter(s => s.binLocation === binLocation);
  const threshold = parseInt(lowStockThreshold) || 5;
  stock.forEach(s => { s.isLowStock = (s.quantity || 0) <= threshold; });
  stock.sort((a, b) => (a.binLocation || '').localeCompare(b.binLocation || ''));
  const summary = {
    totalSKUs: stock.length,
    lowStockItems: stock.filter(s => s.isLowStock).length,
    zeroStockItems: stock.filter(s => (s.quantity || 0) === 0).length,
    totalUnits: stock.reduce((n, s) => n + (s.quantity || 0), 0),
  };
  return { stock, summary };
});

exports.warehouseGetDashboard = onCall(_CALL, async (req) => {
  const uid = _uid(req);
  const { shopId } = req.data;
  await _assertRole(uid, shopId, 'employee');
  const [receiptsSnap, pickSnap, stockSnap] = await Promise.all([
    _db().collection('warehouseReceipts').where('shopId', '==', shopId).limit(10).get(),
    _db().collection('pickLists').where('shopId', '==', shopId).limit(50).get(),
    _db().collection('warehouseStock').where('shopId', '==', shopId).limit(500).get(),
  ]);
  const picks = pickSnap.docs.map(d => d.data());
  const stock = stockSnap.docs.map(d => d.data());
  return {
    pendingPicks: picks.filter(p => ['ready', 'partial', 'picking'].includes(p.status)).length,
    shippedToday: picks.filter(p => {
      if (p.status !== 'shipped') return false;
      const t = p.shippedAt ? (p.shippedAt.toDate ? p.shippedAt.toDate() : new Date(p.shippedAt)) : null;
      return t && t.toDateString() === new Date().toDateString();
    }).length,
    recentReceipts: receiptsSnap.docs.map(d => d.data()).sort((a, b) => _mills(b.receivedAt) - _mills(a.receivedAt)).slice(0, 5),
    stockSummary: {
      totalSKUs: stock.length,
      lowStockItems: stock.filter(s => (s.quantity || 0) <= 5).length,
      totalUnits: stock.reduce((n, s) => n + (s.quantity || 0), 0),
    },
  };
});

// ─────────────────────────────────────────────────────────────────────────────
// DELIVERY ZONES  (4 CFs)
// Collections: deliveryZones/{id}
// ─────────────────────────────────────────────────────────────────────────────

exports.deliveryZoneCreate = onCall(_CALL, async (req) => {
  const uid = _uid(req);
  const { shopId, name, type, center, radiusKm, polygon, basePrice, pricePerKm, minOrderAmount, currency } = req.data;
  await _assertRole(uid, shopId, 'manager');
  if (!name || !type) throw new Error('name and type required');
  if (!['radius', 'polygon'].includes(type)) throw new Error('type must be radius or polygon');
  if (type === 'radius' && (!center || !radiusKm)) throw new Error('center and radiusKm required for radius zone');
  if (type === 'polygon' && (!polygon || polygon.length < 3)) throw new Error('polygon with ≥3 points required');
  const id = _id();
  await _db().collection('deliveryZones').doc(id).set({
    id, shopId, name, type,
    center: type === 'radius' ? { lat: center.lat, lng: center.lng } : null,
    radiusKm: type === 'radius' ? radiusKm : null,
    polygon: type === 'polygon' ? polygon : null,
    basePrice: basePrice || 0, pricePerKm: pricePerKm || 0,
    minOrderAmount: minOrderAmount || 0,
    currency: currency || 'KES',
    status: 'active', createdBy: uid, createdAt: _ts(), updatedAt: _ts(),
  });
  return { zoneId: id };
});

exports.deliveryZoneUpdate = onCall(_CALL, async (req) => {
  const uid = _uid(req);
  const { shopId, zoneId } = req.data;
  await _assertRole(uid, shopId, 'manager');
  const snap = await _db().collection('deliveryZones').doc(zoneId).get();
  if (!snap.exists || snap.data().shopId !== shopId) throw new Error('zone not found');
  const upd = { updatedAt: _ts() };
  ['name', 'basePrice', 'pricePerKm', 'minOrderAmount', 'status', 'radiusKm'].forEach(k => {
    if (req.data[k] !== undefined) upd[k] = req.data[k];
  });
  await _db().collection('deliveryZones').doc(zoneId).update(upd);
  return { success: true };
});

exports.deliveryZoneList = onCall(_CALL, async (req) => {
  const uid = _uid(req);
  const { shopId } = req.data;
  await _assertRole(uid, shopId, 'employee');
  const snap = await _db().collection('deliveryZones').where('shopId', '==', shopId).limit(50).get();
  return { zones: snap.docs.map(d => d.data()) };
});

exports.deliveryZoneCheckCoverage = onCall(_CALL, async (req) => {
  const uid = _uid(req);
  const { shopId, lat, lng } = req.data;
  await _assertRole(uid, shopId, 'employee');
  if (lat == null || lng == null) throw new Error('lat and lng required');
  const snap = await _db().collection('deliveryZones')
    .where('shopId', '==', shopId).where('status', '==', 'active').limit(50).get();
  const zones = snap.docs.map(d => d.data());
  const covered = zones.filter(z => {
    if (z.type === 'radius' && z.center) {
      return _haversine(z.center.lat, z.center.lng, lat, lng) <= (z.radiusKm || 0);
    }
    if (z.type === 'polygon' && z.polygon) return _pointInPolygon(z.polygon, lat, lng);
    return false;
  });
  return {
    covered: covered.length > 0, zones: covered,
    cheapestZone: covered.length ? covered.reduce((a, b) => a.basePrice < b.basePrice ? a : b) : null,
  };
});

// ─────────────────────────────────────────────────────────────────────────────
// CARGO & FREIGHT  (4 CFs)
// Collections: cargoManifests/{id}
// ─────────────────────────────────────────────────────────────────────────────

// Kenya freight rates (KES/kg) by tier
const _FREIGHT_RATES = [
  { maxKg: 5,   rate: 200 },
  { maxKg: 20,  rate: 120 },
  { maxKg: 50,  rate: 90  },
  { maxKg: 100, rate: 70  },
  { maxKg: 500, rate: 55  },
  { maxKg: Infinity, rate: 40 },
];

function _freightRate(kg) {
  return (_FREIGHT_RATES.find(t => kg <= t.maxKg) || _FREIGHT_RATES.at(-1)).rate;
}

exports.cargoCalculateFreight = onCall(_CALL, async (req) => {
  const uid = _uid(req);
  const { shopId, weightKg, lengthCm, widthCm, heightCm, distanceKm } = req.data;
  await _assertRole(uid, shopId, 'employee');
  if (!weightKg) throw new Error('weightKg required');
  // Volumetric weight (divide by 5000 for air, 4000 for road)
  const volWeight = (lengthCm || 0) * (widthCm || 0) * (heightCm || 0) / 4000;
  const chargeableWeight = Math.max(weightKg, volWeight);
  const rate = _freightRate(chargeableWeight);
  const baseCharge = chargeableWeight * rate;
  const distCharge = distanceKm > 50 ? (distanceKm - 50) * 8 : 0; // KES 8/km beyond 50km
  const handling = 500; // standard handling
  const total = Math.round(baseCharge + distCharge + handling);
  return {
    actualWeightKg: weightKg,
    volumetricWeightKg: Math.round(volWeight * 10) / 10,
    chargeableWeightKg: Math.round(chargeableWeight * 10) / 10,
    ratePerKg: rate, baseCharge, distanceCharge: distCharge, handling, total, currency: 'KES',
  };
});

exports.cargoManifestCreate = onCall(_CALL, async (req) => {
  const uid = _uid(req);
  const { shopId, consigneeName, consigneePhone, consigneeAddress, courier, pickupDate, notes } = req.data;
  await _assertRole(uid, shopId, 'employee');
  if (!consigneeName) throw new Error('consigneeName required');
  const id = _id();
  const manifestNumber = 'CGO-' + shopId.slice(0, 4).toUpperCase() + '-' + Date.now().toString(36).toUpperCase().slice(-6);
  await _db().collection('cargoManifests').doc(id).set({
    id, shopId, manifestNumber,
    consigneeName, consigneePhone: consigneePhone || null, consigneeAddress: consigneeAddress || null,
    courier: courier || null, pickupDate: pickupDate ? new Date(pickupDate).toISOString() : null,
    notes: notes || null, items: [], itemCount: 0,
    totalWeightKg: 0, totalVolumeCm3: 0, totalFreightKES: 0,
    status: 'draft', createdBy: uid, createdAt: _ts(), updatedAt: _ts(),
  });
  return { manifestId: id, manifestNumber };
});

exports.cargoManifestAddItem = onCall(_CALL, async (req) => {
  const uid = _uid(req);
  const { shopId, manifestId, description, weightKg, lengthCm, widthCm, heightCm, quantity, declaredValue } = req.data;
  await _assertRole(uid, shopId, 'employee');
  if (!description || !weightKg) throw new Error('description and weightKg required');
  await _db().runTransaction(async tx => {
    const ref  = _db().collection('cargoManifests').doc(manifestId);
    const snap = await tx.get(ref);
    if (!snap.exists || snap.data().shopId !== shopId) throw new Error('manifest not found');
    if (snap.data().status !== 'draft') throw new Error('can only add items to draft manifests');
    const qty = parseInt(quantity) || 1;
    const vol = (lengthCm || 0) * (widthCm || 0) * (heightCm || 0);
    const newItem = {
      description, weightKg: weightKg * qty, lengthCm: lengthCm || 0, widthCm: widthCm || 0,
      heightCm: heightCm || 0, volumeCm3: vol * qty, quantity: qty,
      declaredValue: (declaredValue || 0) * qty,
    };
    const items = [...(snap.data().items || []), newItem];
    const totalWeight = items.reduce((s, i) => s + i.weightKg, 0);
    const totalVol    = items.reduce((s, i) => s + i.volumeCm3, 0);
    tx.update(ref, {
      items, itemCount: items.length,
      totalWeightKg: Math.round(totalWeight * 100) / 100,
      totalVolumeCm3: totalVol, updatedAt: _ts(),
    });
  });
  return { success: true };
});

exports.cargoManifestList = onCall(_CALL, async (req) => {
  const uid = _uid(req);
  const { shopId, status } = req.data;
  await _assertRole(uid, shopId, 'employee');
  const snap = await _db().collection('cargoManifests').where('shopId', '==', shopId).limit(100).get();
  let manifests = snap.docs.map(d => d.data());
  if (status) manifests = manifests.filter(m => m.status === status);
  manifests.sort((a, b) => _mills(b.createdAt) - _mills(a.createdAt));
  return { manifests };
});

// ─────────────────────────────────────────────────────────────────────────────
// LOGISTICS REPORTS  (4 CFs)
// Derived from existing deliveries/trips/riderLocations collections
// ─────────────────────────────────────────────────────────────────────────────

exports.logisticsGetDeliveryReport = onCall(_CALL, async (req) => {
  const uid = _uid(req);
  const { shopId, startDate, endDate } = req.data;
  await _assertRole(uid, shopId, 'manager');
  if (!startDate || !endDate) throw new Error('startDate and endDate required');
  const start = new Date(startDate), end = new Date(endDate);
  end.setHours(23, 59, 59, 999);

  const snap = await _db().collection('deliveries').where('shopId', '==', shopId).limit(2000).get();
  const deliveries = snap.docs.map(d => d.data()).filter(d => {
    const t = d.createdAt ? (d.createdAt.toDate ? d.createdAt.toDate() : new Date(d.createdAt)) : null;
    return t && t >= start && t <= end;
  });

  const total      = deliveries.length;
  const delivered  = deliveries.filter(d => d.status === 'delivered').length;
  const failed     = deliveries.filter(d => d.status === 'failed').length;
  const pending    = deliveries.filter(d => !['delivered', 'failed', 'cancelled'].includes(d.status)).length;
  const cancelled  = deliveries.filter(d => d.status === 'cancelled').length;
  const onTime     = deliveries.filter(d => d.deliveredOnTime === true).length;
  const avgRating  = deliveries.filter(d => d.rating).reduce((s, d) => s + d.rating, 0) / (deliveries.filter(d => d.rating).length || 1);

  return {
    period: { startDate, endDate }, total, delivered, failed, pending, cancelled,
    deliveryRate: total ? Math.round((delivered / total) * 100) : 0,
    onTimeRate: delivered ? Math.round((onTime / delivered) * 100) : 0,
    averageRating: Math.round(avgRating * 10) / 10,
    currency: 'KES',
  };
});

exports.logisticsGetRiderLeaderboard = onCall(_CALL, async (req) => {
  const uid = _uid(req);
  const { shopId, limit: lim } = req.data;
  await _assertRole(uid, shopId, 'manager');
  const snap = await _db().collection('deliveries').where('shopId', '==', shopId).limit(3000).get();
  const riderMap = {};
  snap.docs.forEach(d => {
    const del = d.data();
    if (!del.riderId) return;
    if (!riderMap[del.riderId]) {
      riderMap[del.riderId] = {
        riderId: del.riderId, riderName: del.riderName || 'Rider',
        deliveries: 0, delivered: 0, failed: 0, totalRating: 0, ratingCount: 0,
      };
    }
    const r = riderMap[del.riderId];
    r.deliveries++;
    if (del.status === 'delivered') r.delivered++;
    if (del.status === 'failed')    r.failed++;
    if (del.rating) { r.totalRating += del.rating; r.ratingCount++; }
  });
  const riders = Object.values(riderMap).map(r => ({
    ...r,
    successRate: r.deliveries ? Math.round((r.delivered / r.deliveries) * 100) : 0,
    avgRating:   r.ratingCount ? Math.round((r.totalRating / r.ratingCount) * 10) / 10 : 0,
  })).sort((a, b) => b.delivered - a.delivered).slice(0, _clamp(lim, 1, 50, 10));
  return { riders };
});

exports.logisticsGetZonePerformance = onCall(_CALL, async (req) => {
  const uid = _uid(req);
  const { shopId } = req.data;
  await _assertRole(uid, shopId, 'manager');
  const zonesSnap = await _db().collection('deliveryZones').where('shopId', '==', shopId).limit(50).get();
  const zones = zonesSnap.docs.map(d => d.data());
  const delSnap = await _db().collection('deliveries').where('shopId', '==', shopId).limit(2000).get();
  const deliveries = delSnap.docs.map(d => d.data());
  const zoneStats = zones.map(z => {
    const zDeliveries = deliveries.filter(d => d.zoneId === z.id);
    const delivered = zDeliveries.filter(d => d.status === 'delivered').length;
    return {
      zoneId: z.id, zoneName: z.name, total: zDeliveries.length, delivered,
      deliveryRate: zDeliveries.length ? Math.round((delivered / zDeliveries.length) * 100) : 0,
      revenue: zDeliveries.filter(d => d.status === 'delivered').reduce((s, d) => s + (d.deliveryFee || 0), 0),
    };
  });
  return { zones: zoneStats.sort((a, b) => b.total - a.total) };
});

exports.logisticsGetOnTimeRate = onCall(_CALL, async (req) => {
  const uid = _uid(req);
  const { shopId, daysBack } = req.data;
  await _assertRole(uid, shopId, 'manager');
  const days = _clamp(daysBack, 1, 90, 7);
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const snap = await _db().collection('deliveries').where('shopId', '==', shopId).limit(2000).get();
  const deliveries = snap.docs.map(d => d.data()).filter(d => {
    const t = d.deliveredAt ? (d.deliveredAt.toDate ? d.deliveredAt.toDate() : new Date(d.deliveredAt)) : null;
    return t && t >= cutoff && d.status === 'delivered';
  });
  const onTime = deliveries.filter(d => d.deliveredOnTime === true).length;
  // Break down by day
  const byDay = {};
  deliveries.forEach(d => {
    const t = d.deliveredAt ? (d.deliveredAt.toDate ? d.deliveredAt.toDate() : new Date(d.deliveredAt)) : null;
    if (!t) return;
    const key = t.toISOString().split('T')[0];
    if (!byDay[key]) byDay[key] = { date: key, total: 0, onTime: 0 };
    byDay[key].total++;
    if (d.deliveredOnTime) byDay[key].onTime++;
  });
  return {
    period: days + ' days', totalDeliveries: deliveries.length, onTime,
    onTimeRate: deliveries.length ? Math.round((onTime / deliveries.length) * 100) : 0,
    byDay: Object.values(byDay).sort((a, b) => a.date.localeCompare(b.date)),
  };
});
