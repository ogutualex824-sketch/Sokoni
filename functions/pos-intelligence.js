/* ================================================================
   SOKONI SmartPOS 2.1 — Inventory Intelligence Engine
   Cloud Functions for unified inventory analysis:
     - Fast / slow / dead stock classification
     - Overstock detection
     - Expiry alert aggregation
     - Actionable recommendations
     - Product sales trend comparison
================================================================ */

'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const admin = require('firebase-admin');

const db = admin.firestore();
const _CF = { region: 'us-central1', enforceAppCheck: true };

function _requireAuth(req) {
  if (!req.auth?.uid) throw new HttpsError('unauthenticated', 'Authentication required');
  return req.auth;
}

function _requireString(val, name) {
  if (!val || typeof val !== 'string' || !val.trim()) {
    throw new HttpsError('invalid-argument', `${name} is required`);
  }
}

/* ----------------------------------------------------------------
   getPOSInventoryIntelligence
   Unified endpoint: velocity + overstock + expiry + reorder queue
   → actionable recommendations with severity levels.

   Input:  { sellerId, branchId? }
   Output: IntelligenceReport
---------------------------------------------------------------- */
exports.getPOSInventoryIntelligence = onCall(_CF, async (req) => {
  _requireAuth(req);
  const { sellerId, branchId } = req.data || {};
  _requireString(sellerId, 'sellerId');

  const now = new Date();
  const thirtyDaysAgo    = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const sevenDaysFromNow  = new Date(now.getTime() +  7 * 24 * 60 * 60 * 1000);
  const thirtyDaysFromNow = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

  const thirtyDaysAgoTs    = admin.firestore.Timestamp.fromDate(thirtyDaysAgo);
  const thirtyDaysFromNowTs = admin.firestore.Timestamp.fromDate(thirtyDaysFromNow);

  // ── Parallel Firestore reads ──────────────────────────────────────────────
  let salesQ = db.collection('posSales')
    .where('sellerId', '==', sellerId)
    .where('createdAt', '>=', thirtyDaysAgoTs);
  if (branchId) salesQ = salesQ.where('branchId', '==', branchId);

  const [salesSnap, productsSnap, expirySnap, reorderSnap] = await Promise.all([
    salesQ.get(),
    db.collection('products').where('sellerId', '==', sellerId).get(),
    db.collection('posBatches')
      .where('sellerId', '==', sellerId)
      .where('status', '==', 'active')
      .where('expiryDate', '!=', null)
      .where('expiryDate', '<=', thirtyDaysFromNowTs)
      .orderBy('expiryDate', 'asc')
      .limit(200)
      .get(),
    db.collection('posReorderQueue')
      .where('sellerId', '==', sellerId)
      .where('status', '==', 'pending')
      .orderBy('priority', 'desc')
      .limit(50)
      .get(),
  ]);

  // ── Velocity calculation (qty sold per product in 30 days) ────────────────
  const velocityMap = {}; // productId → total qty sold
  salesSnap.forEach((doc) => {
    const items = Array.isArray(doc.data().items) ? doc.data().items : [];
    items.forEach((item) => {
      if (!item.productId) return;
      velocityMap[item.productId] = (velocityMap[item.productId] || 0) + (Number(item.quantity) || 0);
    });
  });

  const dailyVelocity = {};
  for (const [pid, total] of Object.entries(velocityMap)) {
    dailyVelocity[pid] = total / 30;
  }

  // Average daily velocity across products that actually sold
  const allVelocities = Object.values(dailyVelocity).filter(v => v > 0);
  const avgVelocity = allVelocities.length > 0
    ? allVelocities.reduce((a, b) => a + b, 0) / allVelocities.length
    : 0;

  // ── Product classification ────────────────────────────────────────────────
  const fast = [], slow = [], dead = [], overstock = [], lowStock = [];

  productsSnap.forEach((doc) => {
    const p = doc.data();
    const pid = doc.id;
    const stock        = Number(p.stock)        || 0;
    const reorderPoint = Number(p.reorderPoint) || 0;
    const unitCost     = Number(p.costPrice)    || 0;
    const dv           = dailyVelocity[pid]     || 0;
    const totalSold    = velocityMap[pid]        || 0;
    const daysOfStock  = dv > 0 ? Math.round(stock / dv) : null;

    const base = {
      productId: pid,
      name: p.name || pid,
      sku: p.sku || '',
      category: p.category || '',
      stock,
      dailyVelocity: Math.round(dv * 100) / 100,
      totalSold30d: totalSold,
      daysOfStock,
      reorderPoint,
      unitCost,
      supplierId: p.supplierId || null,
      supplierName: p.supplierName || '',
    };

    // Fast mover: velocity ≥ 2× average
    if (dv > 0 && avgVelocity > 0 && dv >= avgVelocity * 2) {
      fast.push({ ...base, velocityMultiple: Math.round((dv / avgVelocity) * 10) / 10 });
    }

    // Slow mover: selling, but < 20% of average; has stock
    if (stock > 0 && dv > 0 && avgVelocity > 0 && dv < avgVelocity * 0.2) {
      slow.push({ ...base, velocityRatio: Math.round((dv / avgVelocity) * 100) });
    }

    // Dead stock: no sales in 30 days, still in stock
    if (stock > 0 && totalSold === 0) {
      dead.push({ ...base, tiedUpValue: Math.round(stock * unitCost) });
    }

    // Overstock: > 90 days supply with positive velocity, or > 150 units with no velocity
    if (
      (daysOfStock !== null && daysOfStock > 90 && stock > 0) ||
      (dv === 0 && stock > 150)
    ) {
      const excessDays = daysOfStock !== null ? daysOfStock - 30 : null;
      overstock.push({ ...base, excessDays });
    }

    // Low stock: below reorder point, or < 7 days supply (with velocity)
    const belowReorder  = reorderPoint > 0 && stock <= reorderPoint;
    const criticalDays  = daysOfStock !== null && daysOfStock < 7;
    const nearZero      = stock > 0 && stock <= 5;
    if (belowReorder || criticalDays || nearZero) {
      const urgency = (criticalDays && daysOfStock !== null && daysOfStock < 3) || stock === 0
        ? 'critical'
        : 'low';
      lowStock.push({ ...base, urgency, belowReorder, criticalDays, nearZero });
    }
  });

  // Sort
  fast.sort((a, b) => b.dailyVelocity - a.dailyVelocity);
  slow.sort((a, b) => a.velocityRatio - b.velocityRatio);
  dead.sort((a, b) => b.tiedUpValue - a.tiedUpValue);
  overstock.sort((a, b) => (b.excessDays ?? 0) - (a.excessDays ?? 0));
  lowStock.sort((a, b) => {
    if (a.urgency === 'critical' && b.urgency !== 'critical') return -1;
    if (b.urgency === 'critical' && a.urgency !== 'critical') return 1;
    return (a.daysOfStock ?? 99) - (b.daysOfStock ?? 99);
  });

  // ── Expiry classification ─────────────────────────────────────────────────
  const expiringCritical = [], expiringWarning = [];
  expirySnap.forEach((doc) => {
    const b = doc.data();
    const expiryDate = b.expiryDate?.toDate?.() || null;
    if (!expiryDate) return;
    const daysLeft = Math.round((expiryDate.getTime() - now.getTime()) / (24 * 60 * 60 * 1000));
    const entry = {
      batchId: doc.id,
      productId: b.productId,
      productName: b.productName || b.productId,
      lotNumber: b.lotNumber || '',
      quantity: Number(b.quantity) || 0,
      expiryDate: expiryDate.toISOString(),
      daysLeft,
      urgency: daysLeft <= 0 ? 'expired' : daysLeft <= 7 ? 'critical' : 'warning',
    };
    if (daysLeft <= 7) expiringCritical.push(entry);
    else expiringWarning.push(entry);
  });

  // ── Reorder queue ─────────────────────────────────────────────────────────
  const reorderQueue = reorderSnap.docs.map((d) => {
    const r = d.data();
    return {
      id: d.id,
      productId: r.productId,
      productName: r.productName || r.productId,
      supplierId: r.supplierId,
      supplierName: r.supplierName || '',
      currentQty: Number(r.currentQty) || 0,
      reorderQty: Number(r.reorderQty) || 0,
      priority: r.priority || 0,
    };
  });

  // ── Actionable recommendations ────────────────────────────────────────────
  const recommendations = [];
  const criticalLow = lowStock.filter(i => i.urgency === 'critical');
  const expired     = expiringCritical.filter(e => e.urgency === 'expired');
  const nearExpiry  = expiringCritical.filter(e => e.urgency === 'critical');

  if (criticalLow.length > 0) {
    recommendations.push({
      severity: 'urgent',
      icon: 'warning',
      title: `${criticalLow.length} product${criticalLow.length > 1 ? 's' : ''} will stock out in under 3 days`,
      detail: criticalLow.slice(0, 3).map(p => p.name).join(', ') + (criticalLow.length > 3 ? `…` : ''),
      action: 'Create Purchase Order',
      actionType: 'create_po',
    });
  }

  if (expired.length > 0) {
    recommendations.push({
      severity: 'urgent',
      icon: 'block',
      title: `${expired.length} expired batch${expired.length > 1 ? 'es' : ''} — remove from sale immediately`,
      detail: expired.slice(0, 3).map(e => e.productName).join(', '),
      action: 'Review Expired',
      actionType: 'view_expiry',
    });
  }

  if (nearExpiry.length > 0) {
    recommendations.push({
      severity: 'warning',
      icon: 'schedule',
      title: `${nearExpiry.length} batch${nearExpiry.length > 1 ? 'es' : ''} expiring within 7 days`,
      detail: 'Consider markdowns or promotions to move stock before expiry',
      action: 'Apply Discount',
      actionType: 'apply_discount',
    });
  }

  if (fast.length > 0) {
    const top = fast[0];
    recommendations.push({
      severity: 'opportunity',
      icon: 'trending_up',
      title: `"${top.name}" selling ${top.dailyVelocity.toFixed(1)} units/day — ensure you won't stock out`,
      detail: top.daysOfStock !== null
        ? `Current stock lasts ${top.daysOfStock} days`
        : 'Monitor stock closely',
      action: 'Reorder Now',
      actionType: 'reorder_product',
      productId: top.productId,
    });
  }

  if (dead.length > 0) {
    const totalValue = dead.reduce((s, d) => s + (d.tiedUpValue || 0), 0);
    recommendations.push({
      severity: 'info',
      icon: 'inventory_2',
      title: `${dead.length} unsold products tying up KES ${totalValue.toLocaleString()} in stock`,
      detail: 'No sales in 30 days — run a clearance promotion or return to supplier',
      action: 'Run Promotion',
      actionType: 'create_promotion',
    });
  }

  if (overstock.length > 0) {
    recommendations.push({
      severity: 'info',
      icon: 'warehouse',
      title: `${overstock.length} overstocked items with 90+ days of supply on hand`,
      detail: 'Consider bundle offers, supplier returns, or inter-branch transfers',
      action: 'View Overstock',
      actionType: 'view_overstock',
    });
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  const summary = {
    totalProducts: productsSnap.size,
    productsWithSales: Object.keys(velocityMap).length,
    fastMovers: fast.length,
    slowMovers: slow.length,
    deadStock: dead.length,
    overstocked: overstock.length,
    lowStock: lowStock.length,
    criticalLowStock: criticalLow.length,
    expiringCritical: expiringCritical.length,
    expiringWarning: expiringWarning.length,
    pendingReorders: reorderQueue.length,
    avgDailyVelocity: Math.round(avgVelocity * 100) / 100,
    alertCount: recommendations.filter(r => r.severity === 'urgent').length,
  };

  return {
    summary,
    recommendations,
    fast: fast.slice(0, 20),
    slow: slow.slice(0, 20),
    dead: dead.slice(0, 20),
    overstock: overstock.slice(0, 20),
    lowStock: lowStock.slice(0, 30),
    expiringCritical,
    expiringWarning: expiringWarning.slice(0, 20),
    reorderQueue,
    generatedAt: now.toISOString(),
  };
});

/* ----------------------------------------------------------------
   getProductSalesTrend
   Rolling 7-day vs prior-7-day velocity comparison for a list of products.

   Input:  { sellerId, productIds: string[] (max 50) }
   Output: { trends: [{ productId, current7d, previous7d, changePercent }] }
---------------------------------------------------------------- */
exports.getProductSalesTrend = onCall(_CF, async (req) => {
  _requireAuth(req);
  const { sellerId, productIds } = req.data || {};
  _requireString(sellerId, 'sellerId');

  if (!Array.isArray(productIds) || productIds.length === 0) {
    throw new HttpsError('invalid-argument', 'productIds must be a non-empty array');
  }
  if (productIds.length > 50) {
    throw new HttpsError('invalid-argument', 'productIds max 50');
  }

  const now  = new Date();
  const day7  = new Date(now.getTime() -  7 * 24 * 60 * 60 * 1000);
  const day14 = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);

  const [currSnap, prevSnap] = await Promise.all([
    db.collection('posSales')
      .where('sellerId', '==', sellerId)
      .where('createdAt', '>=', admin.firestore.Timestamp.fromDate(day7))
      .get(),
    db.collection('posSales')
      .where('sellerId', '==', sellerId)
      .where('createdAt', '>=', admin.firestore.Timestamp.fromDate(day14))
      .where('createdAt', '<',  admin.firestore.Timestamp.fromDate(day7))
      .get(),
  ]);

  const agg = (snap) => {
    const map = {};
    snap.forEach((doc) => {
      const items = Array.isArray(doc.data().items) ? doc.data().items : [];
      items.forEach((item) => {
        if (!productIds.includes(item.productId)) return;
        map[item.productId] = (map[item.productId] || 0) + (Number(item.quantity) || 0);
      });
    });
    return map;
  };

  const curr = agg(currSnap);
  const prev = agg(prevSnap);

  const trends = productIds.map((pid) => {
    const c = curr[pid] || 0;
    const p = prev[pid] || 0;
    const change = p > 0 ? ((c - p) / p) * 100 : c > 0 ? 100 : 0;
    return {
      productId: pid,
      current7d: c,
      previous7d: p,
      changePercent: Math.round(change),
      direction: change > 5 ? 'up' : change < -5 ? 'down' : 'flat',
    };
  });

  return { trends, generatedAt: now.toISOString() };
});
