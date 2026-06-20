/* ═══════════════════════════════════════════════════════════════════
   SOKONI INVENTORY V2 — AI Pricing Engine
   Recommends optimal prices using: inventory levels, movement history,
   cost price, margin targets, expiry, competitor signals, demand trends.
   ═══════════════════════════════════════════════════════════════════ */
'use strict';

const { onCall }       = require('firebase-functions/v2/https');
const { onSchedule }   = require('firebase-functions/v2/scheduler');
const { defineSecret } = require('firebase-functions/params');
const admin  = require('firebase-admin');
const https  = require('https');

if (!admin.apps.length) admin.initializeApp();
const db = admin.firestore();

const ANTHROPIC_API_KEY = defineSecret('ANTHROPIC_API_KEY');
const CF_OPTS = { region: 'us-central1', memory: '512MiB', timeoutSeconds: 180, secrets: [ANTHROPIC_API_KEY] };
const AI_MODEL = 'claude-haiku-4-5-20251001';

function callAnthropic(apiKey, messages, system, maxTokens = 1000) {
  return new Promise((resolve, reject) => {
    const body    = JSON.stringify({ model: AI_MODEL, max_tokens: maxTokens, system, messages });
    const options = {
      hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey,
        'anthropic-version': '2023-06-01', 'Content-Length': Buffer.byteLength(body) },
    };
    const req = https.request(options, res => {
      let raw = '';
      res.on('data', c => { raw += c; });
      res.on('end', () => { try { resolve(JSON.parse(raw).content?.[0]?.text || ''); } catch { resolve(''); } });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/* ── Get pricing recommendations for a product ───────────────────── */
exports.inventoryGetPricingRecommendations = onCall(CF_OPTS, async req => {
  if (!req.auth) throw new Error('Unauthenticated');
  const { productId, tenantId } = req.data;
  const resolvedTenant = tenantId || req.auth.uid;

  const [prodDoc, levelsSnap, movSnap, ruleDoc] = await Promise.all([
    db.collection(`tenants/${resolvedTenant}/inventory_products`).doc(productId).get(),
    db.collection(`tenants/${resolvedTenant}/inventory_levels`).where('productId', '==', productId).get(),
    db.collection(`tenants/${resolvedTenant}/inventory_movements`)
      .where('productId', '==', productId).where('type', '==', 'sale')
      .orderBy('ts', 'desc').limit(90).get(),
    db.collection(`tenants/${resolvedTenant}/inventory_pricing_rules`).doc(productId).get(),
  ]);

  if (!prodDoc.exists) throw new Error('Product not found');
  const prod  = { id: productId, ...prodDoc.data() };
  const stock = levelsSnap.docs.reduce((s, d) => s + (d.data().available || 0), 0);
  const sales = movSnap.docs.map(d => d.data());
  const rule  = ruleDoc.exists ? ruleDoc.data() : {};

  /* Compute sales velocity */
  const last30 = sales.filter(m => (m.ts?.toMillis?.() || 0) > Date.now() - 30 * 86_400_000);
  const dailySales = last30.reduce((s, m) => s + Math.abs(m.qty), 0) / 30;
  const daysOfStock = dailySales > 0 ? stock / dailySales : 999;

  /* Expiry check */
  const batchSnap = await db.collection(`tenants/${resolvedTenant}/inventory_batches`)
    .where('productId', '==', productId).where('available', '>', 0)
    .orderBy('available').orderBy('expiryDate', 'asc').limit(5).get();
  const nearExpiry = batchSnap.docs.filter(d => {
    const exp = d.data().expiryDate?.toMillis?.();
    return exp && exp < Date.now() + 30 * 86_400_000;
  });

  const apiKey = ANTHROPIC_API_KEY.value();
  const system = `You are a pricing strategist for a Kenyan inventory management system.
Return ONLY valid JSON with this structure:
{
  "recommendedPrice": 0,
  "minPrice": 0,
  "maxPrice": 0,
  "currentPrice": 0,
  "strategy": "penetration|competitive|skimming|clearance|dynamic",
  "rationale": "2-3 sentence explanation",
  "priceChangePercent": 0,
  "urgency": "HIGH|MEDIUM|LOW",
  "warnings": [],
  "alternatives": [{ "scenario": "", "price": 0, "expectedOutcome": "" }],
  "confidenceScore": 0
}`;

  const prompt = `Product: ${prod.name}
Category: ${prod.category}
Current price: KES ${prod.sellingPrice}
Cost price: KES ${prod.costPrice || 0}
Current margin: ${prod.costPrice ? Math.round(((prod.sellingPrice - prod.costPrice) / prod.sellingPrice) * 100) : 'unknown'}%
Current stock: ${stock} ${prod.unit || 'units'}
Days of stock remaining: ${daysOfStock.toFixed(1)}
Daily sales velocity: ${dailySales.toFixed(2)} per day
Near-expiry batches: ${nearExpiry.length}
Pricing rules: ${JSON.stringify(rule)}
Target margin: ${rule.targetMarginPercent || 30}%

Recommend optimal pricing for this Kenyan market product.`;

  let result;
  try {
    const raw = await callAnthropic(apiKey, [{ role: 'user', content: prompt }], system);
    result = JSON.parse(raw);
  } catch {
    /* Rule-based fallback */
    const cost        = prod.costPrice || 0;
    const margin      = rule.targetMarginPercent || 30;
    const recommended = cost > 0 ? Math.round(cost * (1 + margin / 100)) : prod.sellingPrice;
    result = {
      recommendedPrice   : recommended,
      minPrice           : cost > 0 ? Math.round(cost * 1.05) : prod.sellingPrice * 0.85,
      maxPrice           : Math.round(prod.sellingPrice * 1.3),
      currentPrice       : prod.sellingPrice,
      strategy           : nearExpiry.length > 0 ? 'clearance' : 'competitive',
      rationale          : nearExpiry.length > 0 ? 'Near-expiry stock detected — clearance pricing recommended' : `Target ${margin}% margin on cost price`,
      priceChangePercent : cost > 0 ? Math.round((recommended - prod.sellingPrice) / prod.sellingPrice * 100) : 0,
      urgency            : nearExpiry.length > 0 ? 'HIGH' : daysOfStock < 7 ? 'HIGH' : 'LOW',
      warnings           : nearExpiry.length > 0 ? [`${nearExpiry.length} batch(es) expire within 30 days`] : [],
      alternatives       : [],
      confidenceScore    : 65,
    };
  }

  /* Cache recommendation */
  await db.doc(`tenants/${resolvedTenant}/inventory_price_recommendations/${productId}`).set({
    ...result, productId, updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  return { ...result, productId, daysOfStock: Math.round(daysOfStock), dailySales };
});

/* ── Set pricing rule ────────────────────────────────────────────── */
exports.inventorySetPricingRule = onCall({ region: 'us-central1', memory: '256MiB' }, async req => {
  if (!req.auth) throw new Error('Unauthenticated');
  const { productId, tenantId, rule } = req.data;
  const resolvedTenant = tenantId || req.auth.uid;
  await db.doc(`tenants/${resolvedTenant}/inventory_pricing_rules/${productId}`).set({
    ...rule, productId, updatedBy: req.auth.uid,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });
  return { productId, rule };
});

/* ── Simulate price change impact ────────────────────────────────── */
exports.inventorySimulatePriceChange = onCall(CF_OPTS, async req => {
  if (!req.auth) throw new Error('Unauthenticated');
  const { productId, newPrice, tenantId } = req.data;
  const resolvedTenant = tenantId || req.auth.uid;

  const [prodDoc, movSnap, levSnap] = await Promise.all([
    db.collection(`tenants/${resolvedTenant}/inventory_products`).doc(productId).get(),
    db.collection(`tenants/${resolvedTenant}/inventory_movements`)
      .where('productId', '==', productId).where('type', '==', 'sale')
      .orderBy('ts', 'desc').limit(60).get(),
    db.collection(`tenants/${resolvedTenant}/inventory_levels`).where('productId', '==', productId).get(),
  ]);

  if (!prodDoc.exists) throw new Error('Product not found');
  const prod      = prodDoc.data();
  const oldPrice  = prod.sellingPrice || 0;
  const stock     = levSnap.docs.reduce((s, d) => s + (d.data().available || 0), 0);
  const monthlySales = movSnap.docs.reduce((s, d) => s + Math.abs(d.data().qty || 0), 0);
  const priceChangePct = oldPrice ? ((newPrice - oldPrice) / oldPrice) * 100 : 0;

  /* Price elasticity estimation (simplified) */
  const elasticity = -1.2;
  const demandChangePct = elasticity * priceChangePct;
  const newMonthlySales = Math.max(0, monthlySales * (1 + demandChangePct / 100));

  const oldMonthlyRevenue = monthlySales * oldPrice;
  const newMonthlyRevenue = newMonthlySales * newPrice;
  const oldGrossProfit = monthlySales * (oldPrice - (prod.costPrice || 0));
  const newGrossProfit = newMonthlySales * (newPrice - (prod.costPrice || 0));
  const newDaysOfStock = newMonthlySales > 0 ? (stock / (newMonthlySales / 30)) : 999;

  return {
    productId, oldPrice, newPrice, priceChangePct: Math.round(priceChangePct),
    monthlySales: Math.round(monthlySales),
    projectedMonthlySales  : Math.round(newMonthlySales),
    oldMonthlyRevenue      : Math.round(oldMonthlyRevenue),
    projectedMonthlyRevenue: Math.round(newMonthlyRevenue),
    revenueDelta           : Math.round(newMonthlyRevenue - oldMonthlyRevenue),
    oldGrossProfit         : Math.round(oldGrossProfit),
    projectedGrossProfit   : Math.round(newGrossProfit),
    profitDelta            : Math.round(newGrossProfit - oldGrossProfit),
    stockDaysAtNewRate     : Math.round(newDaysOfStock),
    elasticityUsed         : elasticity,
    warnings               : [
      ...(newGrossProfit < 0    ? ['Projected gross loss at this price'] : []),
      ...(newDaysOfStock > 90   ? ['Slow inventory turnover projected'] : []),
      ...(newDaysOfStock < 3    ? ['Risk of stockout within 3 days'] : []),
    ],
  };
});

/* ── Scheduled: daily pricing recommendations for near-expiry ─────── */
exports.inventoryPricingScheduler = onSchedule({
  ...CF_OPTS,
  schedule: 'every day 07:00',
  timeZone: 'Africa/Nairobi',
}, async () => {
  const soon = new Date(Date.now() + 30 * 86_400_000);
  const batchSnap = await db.collectionGroup('inventory_batches')
    .where('expiryDate', '<=', admin.firestore.Timestamp.fromDate(soon))
    .where('available', '>', 0).limit(100).get();

  for (const doc of batchSnap.docs) {
    const batch    = doc.data();
    const tenantId = doc.ref.path.split('/')[1];
    const daysLeft = Math.round((batch.expiryDate?.toMillis?.() - Date.now()) / 86_400_000);
    await db.collection(`tenants/${tenantId}/inventory_alerts`).add({
      type     : 'expiry_near',
      severity : daysLeft <= 7 ? 'HIGH' : 'MEDIUM',
      title    : `${batch.productName || batch.productId} expires in ${daysLeft} days`,
      body     : `Batch ${batch.batchNumber || doc.id}: ${batch.available} units remaining`,
      productId: batch.productId,
      batchId  : doc.id,
      daysLeft,
      resolved : false,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    }).catch(() => {});
  }
});
