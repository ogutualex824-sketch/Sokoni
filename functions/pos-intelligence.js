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

/* ================================================================
   SmartPOS AI Assistance Layer
   5 CFs powering the "fastest, smartest POS in Africa" spec:
   - posSmartSearch        : AI product search + typo correction
   - posDetectAnomaly      : transaction anomaly flagging
   - posGetCustomerInsights: purchase patterns for cashier panel
   - posGetInventoryAlerts : expiry + low-stock summary at session start
   - posGetReorderSuggestions: ranked reorder list with supplier hints
================================================================ */

const { defineSecret } = require('firebase-functions/params');
const Anthropic = defineSecret('ANTHROPIC_API_KEY');

/* ----------------------------------------------------------------
   posSmartSearch
   Accepts a fuzzy/incomplete query; corrects it and returns
   matching products from the seller's catalogue.

   Input:  { query, merchantId, branchId?, limit? }
   Output: { products: [...], correctedQuery?, confidence }
---------------------------------------------------------------- */
exports.posSmartSearch = onCall({ ...(_CF), secrets: [Anthropic] }, async (req) => {
  _requireAuth(req);
  const { query, merchantId, branchId, limit = 12 } = req.data || {};
  _requireString(query, 'query');
  _requireString(merchantId, 'merchantId');
  if (query.trim().length < 2) return { products: [], confidence: 0 };

  const q = query.trim().toLowerCase();

  /* ── Step 1: fast exact + prefix Firestore search ────────────── */
  let snap = await db.collection('products')
    .where('sellerId', '==', merchantId)
    .where('status', '==', 'active')
    .where('nameLower', '>=', q)
    .where('nameLower', '<=', q + '')
    .limit(limit)
    .get();

  if (!snap.empty) {
    return {
      products:       snap.docs.map(d => ({ id: d.id, ...d.data() })),
      correctedQuery: null,
      confidence:     1.0,
      source:         'exact',
    };
  }

  /* ── Step 2: AI spelling correction + semantic match ─────────── */
  let corrected = q;
  try {
    const anthropic = new (require('@anthropic-ai/sdk'))({ apiKey: Anthropic.value() });
    const msg = await anthropic.messages.create({
      model:     'claude-haiku-4-5-20251001',
      max_tokens: 64,
      messages: [{
        role:    'user',
        content: `You are a POS search assistant for a Kenyan market. A cashier typed: "${q}"\n` +
                 `Respond with ONLY the corrected product search term (1-4 words), fixing any spelling mistakes. ` +
                 `No explanation, no punctuation — just the corrected term.`,
      }],
    });
    corrected = (msg.content[0]?.text || q).trim().toLowerCase().slice(0, 60);
  } catch (_) { /* fall through with original query */ }

  /* ── Step 3: search with corrected term ─────────────────────── */
  const [byName, bySku] = await Promise.all([
    db.collection('products')
      .where('sellerId', '==', merchantId)
      .where('status', '==', 'active')
      .where('nameLower', '>=', corrected)
      .where('nameLower', '<=', corrected + '')
      .limit(limit)
      .get(),
    corrected.length >= 3
      ? db.collection('products')
          .where('sellerId', '==', merchantId)
          .where('skuLower', '>=', corrected)
          .where('skuLower', '<=', corrected + '')
          .limit(6)
          .get()
      : Promise.resolve({ docs: [] }),
  ]);

  const seen = new Set();
  const products = [];
  [...byName.docs, ...bySku.docs].forEach(d => {
    if (!seen.has(d.id)) { seen.add(d.id); products.push({ id: d.id, ...d.data() }); }
  });

  return {
    products:       products.slice(0, limit),
    correctedQuery: corrected !== q ? corrected : null,
    confidence:     products.length > 0 ? 0.85 : 0.3,
    source:         'ai_corrected',
  };
});

/* ----------------------------------------------------------------
   posDetectAnomaly
   Checks a proposed sale against recent baselines for this cashier
   and merchant. Returns anomaly flags before finalization.

   Input:  { merchantId, branchId, cashierId, items, total, paymentMethod }
   Output: { anomalies: [{ type, severity, message }], safe: boolean }
---------------------------------------------------------------- */
exports.posDetectAnomaly = onCall({ ...(_CF), secrets: [Anthropic] }, async (req) => {
  _requireAuth(req);
  const { merchantId, branchId, cashierId, items = [], total = 0, paymentMethod } = req.data || {};
  _requireString(merchantId, 'merchantId');

  const now          = new Date();
  const thirtyAgo    = new Date(now.getTime() - 30 * 86400_000);
  const thirtyAgoTs  = admin.firestore.Timestamp.fromDate(thirtyAgo);

  const anomalies = [];

  /* ── Parallel checks ────────────────────────────────────────── */
  const [recentSalesSnap, pricesSnap] = await Promise.all([
    db.collection('posRetailSales')
      .where('merchantId', '==', merchantId)
      .where('createdAt', '>=', thirtyAgoTs)
      .orderBy('createdAt', 'desc')
      .limit(200)
      .get(),
    db.collection('products')
      .where('sellerId', '==', merchantId)
      .where(admin.firestore.FieldPath.documentId(), 'in', items.slice(0, 10).map(i => i.productId || i.id).filter(Boolean))
      .get(),
  ]);

  /* ── 1. Unusually large transaction ────────────────────────── */
  const totals = recentSalesSnap.docs.map(d => d.data().grandTotal || 0).filter(Boolean);
  if (totals.length >= 10) {
    const avg = totals.reduce((s, t) => s + t, 0) / totals.length;
    const std = Math.sqrt(totals.reduce((s, t) => s + (t - avg) ** 2, 0) / totals.length);
    if (total > avg + 3 * std && total > 10_000) {
      anomalies.push({ type: 'large_transaction', severity: 'warning',
        message: `Transaction KES ${total.toFixed(0)} is unusually large (avg: KES ${avg.toFixed(0)})` });
    }
  }

  /* ── 2. Pricing error — item sold below cost ────────────────── */
  const priceMap = {};
  pricesSnap.forEach(d => { priceMap[d.id] = d.data(); });
  items.forEach(item => {
    const ref = priceMap[item.productId];
    if (!ref) return;
    const costPrice = ref.costPrice || 0;
    if (costPrice > 0 && item.unitPrice < costPrice * 0.8) {
      anomalies.push({ type: 'below_cost', severity: 'error',
        message: `${item.name}: sold at KES ${item.unitPrice} — possible pricing error (cost: KES ${costPrice})` });
    }
    /* Price deviation > 20% from catalogue */
    const expected = ref.salePrice || ref.price || 0;
    if (expected > 0 && Math.abs(item.unitPrice - expected) / expected > 0.20) {
      anomalies.push({ type: 'price_deviation', severity: 'warning',
        message: `${item.name}: charged KES ${item.unitPrice}, catalogue price is KES ${expected}` });
    }
  });

  /* ── 3. Unusual item count ──────────────────────────────────── */
  const itemCounts = recentSalesSnap.docs.map(d => (d.data().items || []).length).filter(Boolean);
  if (itemCounts.length >= 10) {
    const avgItems = itemCounts.reduce((s, c) => s + c, 0) / itemCounts.length;
    if (items.length > avgItems * 4 && items.length > 20) {
      anomalies.push({ type: 'item_count', severity: 'info',
        message: `${items.length} items — unusually large basket` });
    }
  }

  /* ── 4. High-value cash payment ────────────────────────────── */
  if (paymentMethod === 'cash' && total > 50_000) {
    anomalies.push({ type: 'high_cash', severity: 'warning',
      message: `Cash payment of KES ${total.toFixed(0)} — confirm banknotes` });
  }

  return {
    anomalies,
    safe:        anomalies.filter(a => a.severity === 'error').length === 0,
    checkedAt:   now.toISOString(),
  };
});

/* ----------------------------------------------------------------
   posGetCustomerInsights
   Returns purchase history + predictions for the cashier panel.
   Called when a customer is identified at checkout.

   Input:  { merchantId, customerId }
   Output: { recentPurchases, topItems, totalSpend, visitCount,
             avgBasket, suggestion, daysSinceLast }
---------------------------------------------------------------- */
exports.posGetCustomerInsights = onCall({ ...(_CF), secrets: [Anthropic] }, async (req) => {
  _requireAuth(req);
  const { merchantId, customerId } = req.data || {};
  _requireString(merchantId, 'merchantId');
  _requireString(customerId, 'customerId');

  const now       = new Date();
  const ninetyAgo = admin.firestore.Timestamp.fromDate(new Date(now.getTime() - 90 * 86400_000));

  const salesSnap = await db.collection('posRetailSales')
    .where('merchantId', '==', merchantId)
    .where('customerId', '==', customerId)
    .where('createdAt', '>=', ninetyAgo)
    .orderBy('createdAt', 'desc')
    .limit(50)
    .get();

  if (salesSnap.empty) {
    return { recentPurchases: [], topItems: [], totalSpend: 0, visitCount: 0,
             avgBasket: 0, daysSinceLast: null, suggestion: null };
  }

  const sales = salesSnap.docs.map(d => d.data());

  /* Aggregate */
  const totalSpend  = sales.reduce((s, x) => s + (x.grandTotal || 0), 0);
  const visitCount  = sales.length;
  const avgBasket   = totalSpend / visitCount;
  const itemFreq    = {};
  sales.forEach(s => {
    (s.items || []).forEach(i => {
      itemFreq[i.productId || i.name] = (itemFreq[i.productId || i.name] || { name: i.name, count: 0 });
      itemFreq[i.productId || i.name].count++;
    });
  });
  const topItems = Object.values(itemFreq).sort((a, b) => b.count - a.count).slice(0, 5);

  const lastTs = sales[0].createdAt?.toDate?.() || null;
  const daysSinceLast = lastTs ? Math.round((now - lastTs) / 86400_000) : null;

  const recentPurchases = sales.slice(0, 5).map(s => ({
    receiptNo:  s.receiptNo || '',
    total:      s.grandTotal || 0,
    items:      (s.items || []).slice(0, 3).map(i => ({ name: i.name, qty: i.qty })),
    date:       s.createdAt?.toDate?.().toISOString() || '',
  }));

  /* AI-generated upsell suggestion */
  let suggestion = null;
  try {
    const anthropic = new (require('@anthropic-ai/sdk'))({ apiKey: Anthropic.value() });
    const topNames  = topItems.map(i => i.name).join(', ');
    const msg = await anthropic.messages.create({
      model:     'claude-haiku-4-5-20251001',
      max_tokens: 80,
      messages: [{
        role:    'user',
        content: `A returning customer at a Kenyan retail shop usually buys: ${topNames}. ` +
                 `Suggest ONE complementary product the cashier could offer them today. ` +
                 `Keep it under 12 words. No preamble, just the suggestion.`,
      }],
    });
    suggestion = msg.content[0]?.text?.trim() || null;
  } catch (_) {}

  return { recentPurchases, topItems, totalSpend, visitCount, avgBasket, daysSinceLast, suggestion };
});

/* ----------------------------------------------------------------
   posGetInventoryAlerts
   Session-start summary of critical stock issues:
   - Items expiring within 7 days
   - Items at zero / critically low stock
   - Pending reorder recommendations

   Input:  { merchantId, branchId }
   Output: { expiring: [...], lowStock: [...], reorders: [...], alertCount }
---------------------------------------------------------------- */
exports.posGetInventoryAlerts = onCall(_CF, async (req) => {
  _requireAuth(req);
  const { merchantId, branchId } = req.data || {};
  _requireString(merchantId, 'merchantId');

  const now         = new Date();
  const sevenDays   = admin.firestore.Timestamp.fromDate(new Date(now.getTime() + 7 * 86400_000));
  const thirtyDays  = admin.firestore.Timestamp.fromDate(new Date(now.getTime() + 30 * 86400_000));

  const baseQuery = (col) => {
    let q = db.collection(col).where('merchantId', '==', merchantId);
    if (branchId) q = q.where('branchId', '==', branchId);
    return q;
  };

  const [batchSnap, stockSnap] = await Promise.all([
    db.collection('posBatches')
      .where('merchantId', '==', merchantId)
      .where('status', '==', 'active')
      .where('expiryDate', '<=', sevenDays)
      .orderBy('expiryDate', 'asc')
      .limit(30)
      .get(),
    baseQuery('posStock')
      .where('stockQty', '<=', 5)
      .limit(50)
      .get(),
  ]);

  const expiring = batchSnap.docs.map(d => {
    const data = d.data();
    const exp  = data.expiryDate?.toDate?.();
    const daysLeft = exp ? Math.round((exp - now) / 86400_000) : 0;
    return {
      batchId:   d.id,
      productId: data.productId,
      name:      data.productName || 'Unknown',
      qty:       data.qty || 0,
      expiryDate: exp?.toISOString() || '',
      daysLeft,
      severity:  daysLeft <= 0 ? 'expired' : daysLeft <= 3 ? 'critical' : 'warning',
    };
  }).filter(e => e.qty > 0);

  const lowStock = stockSnap.docs.map(d => {
    const data = d.data();
    return {
      productId: data.productId,
      name:      data.productName || data.name || 'Unknown',
      stockQty:  data.stockQty,
      minLevel:  data.minStockLevel || 0,
      severity:  data.stockQty === 0 ? 'out' : data.stockQty <= 2 ? 'critical' : 'warning',
    };
  });

  return {
    expiring,
    lowStock,
    alertCount: expiring.length + lowStock.length,
    checkedAt:  now.toISOString(),
  };
});

/* ----------------------------------------------------------------
   posGetReorderSuggestions
   AI-ranked list of products to reorder based on velocity,
   current stock, and supplier lead times.

   Input:  { merchantId, branchId? }
   Output: { suggestions: [{ productId, name, currentStock, reorderQty,
             urgency, estimatedStockoutDays, supplier? }] }
---------------------------------------------------------------- */
exports.posGetReorderSuggestions = onCall({ ...(_CF), secrets: [Anthropic] }, async (req) => {
  _requireAuth(req);
  const { merchantId, branchId } = req.data || {};
  _requireString(merchantId, 'merchantId');

  const now        = new Date();
  const thirtyAgo  = admin.firestore.Timestamp.fromDate(new Date(now.getTime() - 30 * 86400_000));

  let stockQ = db.collection('posStock').where('merchantId', '==', merchantId);
  if (branchId) stockQ = stockQ.where('branchId', '==', branchId);

  let salesQ = db.collection('posRetailSales')
    .where('merchantId', '==', merchantId)
    .where('createdAt', '>=', thirtyAgo);
  if (branchId) salesQ = salesQ.where('branchId', '==', branchId);

  const [stockSnap, salesSnap] = await Promise.all([
    stockQ.where('stockQty', '<=', 20).limit(80).get(),
    salesQ.limit(300).get(),
  ]);

  /* Velocity map (units sold per day in last 30d) */
  const velocityMap = {};
  salesSnap.docs.forEach(d => {
    (d.data().items || []).forEach(item => {
      velocityMap[item.productId] = (velocityMap[item.productId] || 0) + (item.qty || 1);
    });
  });
  Object.keys(velocityMap).forEach(pid => { velocityMap[pid] /= 30; }); // per day

  const suggestions = stockSnap.docs.map(d => {
    const data        = d.data();
    const pid         = data.productId || d.id;
    const stockQty    = data.stockQty || 0;
    const velocity    = velocityMap[pid] || 0;
    const daysLeft    = velocity > 0 ? Math.floor(stockQty / velocity) : 999;
    const minLevel    = data.minStockLevel || 5;
    const reorderQty  = Math.max(minLevel, Math.round(velocity * 14)); // 2-week supply
    return {
      productId:            pid,
      name:                 data.productName || data.name || 'Unknown',
      currentStock:         stockQty,
      reorderQty,
      estimatedStockoutDays: daysLeft,
      supplier:             data.supplierName || null,
      unitCost:             data.costPrice || 0,
      estimatedCost:        (data.costPrice || 0) * reorderQty,
      urgency:              daysLeft === 0 ? 'critical' : daysLeft <= 3 ? 'high' : daysLeft <= 7 ? 'medium' : 'low',
    };
  }).filter(s => s.urgency !== 'low' || s.currentStock === 0)
    .sort((a, b) => {
      const order = { critical: 0, high: 1, medium: 2, low: 3 };
      return (order[a.urgency] - order[b.urgency]) || (a.estimatedStockoutDays - b.estimatedStockoutDays);
    })
    .slice(0, 30);

  return { suggestions, generatedAt: now.toISOString(), totalItems: suggestions.length };
});
