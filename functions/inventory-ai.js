/**
 * SOKONI INVENTORY AI — Cloud Functions
 * AI-powered: natural language queries, demand forecasting,
 * auto-reorder suggestions, and product identification.
 * Uses Anthropic Claude via KASS agent pattern.
 */

'use strict';

const { onCall, HttpsError }  = require('firebase-functions/v2/https');
const { onSchedule }          = require('firebase-functions/v2/scheduler');
const { defineSecret }        = require('firebase-functions/params');
const admin  = require('firebase-admin');
const https  = require('https');

if (!admin.apps.length) admin.initializeApp();
const db = admin.firestore();

const ANTHROPIC_API_KEY = defineSecret('ANTHROPIC_API_KEY');
const AI_MODEL          = 'claude-haiku-4-5-20251001'; // Fast model for inventory queries

/* ─── HELPERS ────────────────────────────────────────────────────── */
function nowISO() { return new Date().toISOString(); }

function tenantCol(tenantId, path) {
  return db.collection(`tenants/${tenantId}/${path}`);
}

const { assertAuth } = require('./shared/errors');

function assertTenant(data) {
  if (!data.tenantId) throw new HttpsError('invalid-argument', 'tenantId required');
  return data.tenantId;
}

function callAnthropic(apiKey, messages, system, maxTokens = 800) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model:      AI_MODEL,
      max_tokens: maxTokens,
      system,
      messages,
    });

    const options = {
      hostname: 'api.anthropic.com',
      path:     '/v1/messages',
      method:   'POST',
      headers: {
        'Content-Type':    'application/json',
        'x-api-key':       apiKey,
        'anthropic-version':'2023-06-01',
        'Content-Length':  Buffer.byteLength(body),
      },
    };

    const req = https.request(options, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) return reject(new Error(parsed.error.message));
          resolve(parsed.content?.[0]?.text || '');
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/* ─── AI INVENTORY QUERY ─────────────────────────────────────────── */
exports.inventoryAiQuery = onCall(
  { secrets: [ANTHROPIC_API_KEY], timeoutSeconds: 60, memory: '256MiB' },
  async (req) => {
    const uid      = assertAuth(req);
    const data     = req.data;
    const tenantId = assertTenant(data);

    if (!data.question?.trim()) throw new HttpsError('invalid-argument', 'question required');

    const apiKey = ANTHROPIC_API_KEY.value();

    // Fetch relevant context
    const [productsSnap, levelsSnap, analyticsSnap] = await Promise.all([
      tenantCol(tenantId, 'inventory_products').where('active','==',true).limit(50).get(),
      tenantCol(tenantId, 'inventory_levels').limit(100).get(),
      tenantCol(tenantId, 'inventory_analytics').doc('30d').get(),
    ]);

    const products = productsSnap.docs.map(d => ({
      id: d.id, name: d.data().name, sku: d.data().sku,
      category: d.data().category, costPrice: d.data().costPrice,
      sellingPrice: d.data().sellingPrice, reorderPoint: d.data().reorderPoint,
    }));

    const levels = levelsSnap.docs.map(d => ({
      productId: d.data().productId, warehouseId: d.data().warehouseId,
      available: d.data().available, reserved: d.data().reserved,
    }));

    const analytics = analyticsSnap.exists ? analyticsSnap.data() : {};

    const context = JSON.stringify({
      summary: {
        totalSKUs:       analytics.totalSKUs     || products.length,
        inventoryValue:  analytics.inventoryValue || 0,
        lowStockCount:   analytics.lowStockCount  || 0,
        outOfStockCount: analytics.outOfStockCount|| 0,
        movementsToday:  analytics.movementsToday || 0,
      },
      lowStockProducts: levels.filter(l => l.available <= 5).map(l => {
        const p = products.find(p2 => p2.id === l.productId);
        return { name: p?.name || l.productId, available: l.available, reorderPoint: p?.reorderPoint || 5 };
      }),
      products: products.slice(0, 20),
    }, null, 2);

    const system = `You are SOKONI's intelligent inventory management AI assistant.
You help business owners manage their inventory, optimize stock levels, reduce waste, and improve profitability.
Always respond in clear, actionable language. Format numbers with commas. Use KES for currency.
Keep answers concise and focused. If you suggest reorders, include quantities and priorities.

Current inventory context:
${context}`;

    const answer = await callAnthropic(apiKey, [{ role: 'user', content: data.question }], system);

    // Log query for analytics
    await tenantCol(tenantId, 'inventory_ai_logs').add({
      type: 'query', question: data.question, userId: uid, timestamp: nowISO(),
    });

    return { answer, timestamp: nowISO() };
  }
);

/* ─── AI DEMAND FORECAST ─────────────────────────────────────────── */
exports.inventoryAiForecast = onCall(
  { secrets: [ANTHROPIC_API_KEY], timeoutSeconds: 60, memory: '256MiB' },
  async (req) => {
    const uid      = assertAuth(req);
    const data     = req.data;
    const tenantId = assertTenant(data);

    if (!data.productId) throw new HttpsError('invalid-argument', 'productId required');

    const apiKey = ANTHROPIC_API_KEY.value();
    const days   = Math.min(Number(data.days) || 30, 90);

    // Fetch last 90 days of movements for this product
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 90);

    const [mvSnap, prodSnap, levelSnap] = await Promise.all([
      tenantCol(tenantId, 'inventory_movements')
        .where('productId', '==', data.productId)
        .where('timestamp', '>=', cutoff.toISOString())
        .orderBy('timestamp', 'asc').get(),
      tenantCol(tenantId, 'inventory_products').doc(data.productId).get(),
      tenantCol(tenantId, 'inventory_levels').where('productId', '==', data.productId).get(),
    ]);

    if (!prodSnap.exists) throw new HttpsError('not-found', 'Product not found');

    const product  = prodSnap.data();
    const movements= mvSnap.docs.map(d => d.data());
    const levels   = levelSnap.docs.map(d => d.data());
    const currentQty = levels.reduce((s, l) => s + (l.available || 0), 0);

    // Build daily sales summary
    const dailySales = {};
    movements.filter(m => m.type === 'sale' || m.quantity < 0).forEach(m => {
      const day = m.timestamp?.split('T')[0];
      if (day) dailySales[day] = (dailySales[day] || 0) + Math.abs(m.quantity);
    });

    const salesValues = Object.values(dailySales);
    const avgDailySales = salesValues.length
      ? salesValues.reduce((a,b) => a+b, 0) / salesValues.length : 0;

    const context = `Product: ${product.name} (${product.sku || data.productId})
Category: ${product.category || 'General'}
Current Stock: ${currentQty} ${product.unit || 'units'}
Reorder Point: ${product.reorderPoint || 0}
Average Daily Sales (90 days): ${avgDailySales.toFixed(2)} ${product.unit || 'units'}/day
Total movements analysed: ${movements.length}
Daily sales pattern: ${JSON.stringify(Object.entries(dailySales).slice(-14))}`;

    const system = `You are SOKONI's demand forecasting AI. Analyse inventory movement patterns
and produce a concise demand forecast. Include:
1. Predicted demand for the next ${days} days
2. Recommended reorder quantity
3. Expected stockout date if no reorder
4. Confidence level (Low/Medium/High)
5. Key factors influencing the forecast
Keep it short and actionable. Use ${product.unit || 'units'} as the unit.`;

    const forecastText = await callAnthropic(apiKey,
      [{ role: 'user', content: `Forecast demand for the next ${days} days:\n${context}` }],
      system, 600);

    // Save forecast
    await tenantCol(tenantId, 'inventory_forecasts').doc(`${data.productId}_${days}d`).set({
      productId:    data.productId,
      days,
      avgDailySales,
      currentQty,
      forecast:     forecastText,
      createdAt:    nowISO(),
      createdBy:    uid,
      tenantId,
    }, { merge: true });

    return {
      productId:    data.productId,
      productName:  product.name,
      currentQty,
      avgDailySales,
      daysOfStock:  avgDailySales > 0 ? Math.floor(currentQty / avgDailySales) : null,
      forecastText,
      days,
      timestamp:    nowISO(),
    };
  }
);

/* ─── AI REORDER SUGGESTIONS ─────────────────────────────────────── */
exports.inventoryAiReorderSuggestions = onCall(
  { secrets: [ANTHROPIC_API_KEY], timeoutSeconds: 90, memory: '512MiB' },
  async (req) => {
    const uid      = assertAuth(req);
    const data     = req.data;
    const tenantId = assertTenant(data);

    const apiKey = ANTHROPIC_API_KEY.value();

    // Fetch all low-stock items with product details
    const levelsSnap = await tenantCol(tenantId, 'inventory_levels')
      .where('available', '<=', 20).orderBy('available', 'asc').limit(50).get();

    if (levelsSnap.empty) return { items: [], message: 'All stock levels are healthy', timestamp: nowISO() };

    const productIds = [...new Set(levelsSnap.docs.map(d => d.data().productId))];

    // Fetch products and their suppliers
    const productDocs = await Promise.all(
      productIds.map(id => tenantCol(tenantId, 'inventory_products').doc(id).get())
    );

    const suppliersSnap = await tenantCol(tenantId, 'inventory_suppliers')
      .where('active','==',true).get();
    const suppliers = {};
    suppliersSnap.forEach(d => { suppliers[d.id] = d.data(); });

    // Build stock data
    const stockData = levelsSnap.docs.map(levelDoc => {
      const level   = levelDoc.data();
      const prodDoc = productDocs.find(d => d.id === level.productId);
      const product = prodDoc?.exists ? prodDoc.data() : null;
      const supplierIds = product?.suppliers?.map(s => s.supplierId) || [];
      const supplier= supplierIds.map(id => suppliers[id]).filter(Boolean)[0];
      return {
        productId:    level.productId,
        productName:  product?.name || level.productId,
        sku:          product?.sku  || '',
        category:     product?.category || '',
        available:    level.available,
        reorderPoint: product?.reorderPoint || 5,
        maxStock:     product?.maxStock  || 100,
        costPrice:    product?.costPrice || 0,
        supplierName: supplier?.name || null,
        leadTimeDays: supplier?.leadTimeDays || 7,
      };
    });

    // Call AI
    const system = `You are SOKONI's inventory replenishment AI.
Analyse the low-stock items and generate smart reorder suggestions.
For each item provide: productId, productName, suggestedQty, priority (high/medium/low), reason, supplierName.
Return ONLY valid JSON with format: {"items": [...]}`;

    const prompt = `Generate reorder suggestions for these low-stock items:\n${JSON.stringify(stockData, null, 2)}`;

    let suggestions = { items: [] };
    try {
      const raw = await callAnthropic(apiKey, [{ role: 'user', content: prompt }], system, 1000);
      const match = raw.match(/\{[\s\S]*\}/);
      if (match) suggestions = JSON.parse(match[0]);
    } catch (_) {
      // Fallback: generate rule-based suggestions
      suggestions.items = stockData.map(s => ({
        productId:    s.productId,
        productName:  s.productName,
        suggestedQty: Math.max(s.maxStock - s.available, s.reorderPoint * 2),
        priority:     s.available <= 0 ? 'high' : s.available <= s.reorderPoint / 2 ? 'medium' : 'low',
        reason:       s.available <= 0 ? 'Out of stock' : `Below reorder point (${s.reorderPoint})`,
        supplierName: s.supplierName || 'Not specified',
      }));
    }

    // Enrich with cost estimates
    suggestions.items = suggestions.items.map(item => {
      const stock = stockData.find(s => s.productId === item.productId);
      return {
        ...item,
        estimatedCost: stock ? (item.suggestedQty * stock.costPrice) : null,
        leadTimeDays:  stock?.leadTimeDays || 7,
        supplierName:  item.supplierName || stock?.supplierName || 'Not specified',
      };
    });

    // Log query
    await tenantCol(tenantId, 'inventory_ai_logs').add({
      type: 'reorder_suggestions', userId: uid,
      itemCount: suggestions.items.length, timestamp: nowISO(),
    });

    return { ...suggestions, timestamp: nowISO() };
  }
);

/* ─── AI PRODUCT IDENTIFICATION ──────────────────────────────────── */
exports.inventoryAiIdentifyProduct = onCall(
  { secrets: [ANTHROPIC_API_KEY], timeoutSeconds: 30, memory: '256MiB' },
  async (req) => {
    const uid      = assertAuth(req);
    const data     = req.data;
    const tenantId = assertTenant(data);

    if (!data.image) throw new HttpsError('invalid-argument', 'image required');

    const apiKey = ANTHROPIC_API_KEY.value();

    const system = `You are a product identification AI for SOKONI, an East African marketplace.
Analyse the product image and extract:
- Product name
- Brand
- Category
- Estimated unit of measure
- Visible barcode or SKU (if any)
- Any other relevant product details

Return ONLY valid JSON: {"name":"","brand":"","category":"","unit":"","barcode":"","description":"","confidence":"high|medium|low"}`;

    const messages = [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: data.image.replace(/^data:image\/\w+;base64,/, '') } },
        { type: 'text',  text: 'Identify this product and return JSON as specified.' },
      ],
    }];

    let product = { name: '', brand: '', category: '', unit: 'each', barcode: '', description: '', confidence: 'low' };
    try {
      const raw   = await callAnthropic(apiKey, messages, system, 400);
      const match = raw.match(/\{[\s\S]*\}/);
      if (match) product = { ...product, ...JSON.parse(match[0]) };
    } catch (e) {
      throw new HttpsError('internal', 'AI identification failed: ' + e.message);
    }

    return { product, timestamp: nowISO() };
  }
);

/* ─── SCHEDULED: Generate daily forecasts for all products ──────── */
exports.inventoryDailyForecasts = onSchedule(
  { schedule: 'every day 01:00', timeZone: 'Africa/Nairobi', memory: '512MiB',
    secrets: [ANTHROPIC_API_KEY], timeoutSeconds: 300 },
  async () => {
    const apiKey = ANTHROPIC_API_KEY.value();
    const tenantsSnap = await db.collection('tenants').get();

    for (const tenantDoc of tenantsSnap.docs) {
      const tenantId = tenantDoc.id;
      try {
        // Only forecast low-stock products to save API costs
        const levelsSnap = await tenantCol(tenantId, 'inventory_levels')
          .where('available', '<=', 15).limit(20).get();

        for (const levelDoc of levelsSnap.docs) {
          const level = levelDoc.data();
          if (!level.productId) continue;

          const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 30);
          const mvSnap = await tenantCol(tenantId, 'inventory_movements')
            .where('productId', '==', level.productId)
            .where('type', '==', 'sale')
            .where('timestamp', '>=', cutoff.toISOString()).get();

          const totalSold = mvSnap.docs.reduce((s, d) => s + Math.abs(d.data().quantity || 0), 0);
          const avgDaily  = totalSold / 30;
          const daysLeft  = avgDaily > 0 ? Math.floor(level.available / avgDaily) : null;

          await tenantCol(tenantId, 'inventory_forecasts')
            .doc(`${level.productId}_auto`).set({
              productId:   level.productId,
              avgDailySales: avgDaily,
              currentQty:  level.available,
              daysOfStockLeft: daysLeft,
              criticalIn3Days: daysLeft !== null && daysLeft <= 3,
              updatedAt:   nowISO(),
              tenantId,
            }, { merge: true });
        }
      } catch (e) {
        console.error(`Daily forecasts failed for ${tenantId}:`, e.message);
      }
    }
  }
);
