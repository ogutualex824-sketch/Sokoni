/* ═══════════════════════════════════════════════════════════════════
   SOKONI INVENTORY V2 — Business Simulation Engine
   AI-powered scenario modeling with Claude Haiku.
   Scenarios: demand changes, price changes, supplier delays,
   product discontinuation, seasonal spikes, bulk promotions.
   ═══════════════════════════════════════════════════════════════════ */
'use strict';

const { onCall }     = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const admin  = require('firebase-admin');
const https  = require('https');

if (!admin.apps.length) admin.initializeApp();
const db = admin.firestore();

const ANTHROPIC_API_KEY = defineSecret('ANTHROPIC_API_KEY');
const CF_OPTS = { region: 'us-central1', memory: '1GiB', timeoutSeconds: 180, secrets: [ANTHROPIC_API_KEY] };
const AI_MODEL = 'claude-haiku-4-5-20251001';

function callAnthropic(apiKey, messages, system, maxTokens = 1200) {
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
      res.on('end', () => {
        try { resolve(JSON.parse(raw).content?.[0]?.text || ''); }
        catch { resolve(''); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/* ── Gather inventory context for simulation ────────────────────── */
async function _gatherContext(tenantId) {
  const [products, levels, movements, purchaseOrders] = await Promise.all([
    db.collection(`tenants/${tenantId}/inventory_products`).where('active', '==', true).limit(100).get(),
    db.collection(`tenants/${tenantId}/inventory_levels`).limit(200).get(),
    db.collection(`tenants/${tenantId}/inventory_movements`)
      .where('ts', '>=', new Date(Date.now() - 90 * 86_400_000))
      .limit(500).get(),
    db.collection(`tenants/${tenantId}/inventory_purchaseOrders`)
      .where('status', 'in', ['sent', 'approved']).limit(20).get(),
  ]);

  return {
    products     : products.docs.map(d => ({ id: d.id, ...d.data() })).map(p => ({
      id: p.id, name: p.name, category: p.category, price: p.sellingPrice,
      cost: p.costPrice, reorderPoint: p.reorderPoint, unit: p.unit,
    })),
    levels       : levels.docs.map(d => d.data()).map(l => ({ productId: l.productId, available: l.available, reserved: l.reserved, warehouseId: l.warehouseId })),
    movements    : movements.docs.map(d => d.data()).map(m => ({ type: m.type, qty: m.qty, ts: m.ts?.toDate?.()?.toISOString() })),
    pendingPOs   : purchaseOrders.docs.map(d => d.data()).map(po => ({ supplierId: po.supplierId, totalValue: po.totalValue, expectedAt: po.expectedAt?.toDate?.()?.toISOString() })),
  };
}

/* ── Build system prompt for simulation ─────────────────────────── */
function _buildSimulationPrompt(scenario) {
  return `You are a world-class inventory management AI and business simulation engine for SOKONI, a Kenyan commerce platform.

Your role is to analyze inventory data and simulate business scenarios with precision.

Return ONLY a valid JSON object with this exact structure (no markdown, no explanation):
{
  "scenario": "<scenario type>",
  "summary": "<2-3 sentence executive summary>",
  "projections": {
    "revenue": { "current": 0, "projected": 0, "delta": 0, "deltaPercent": 0 },
    "stockouts": { "count": 0, "products": [], "estimatedLossKES": 0 },
    "inventory": { "currentValue": 0, "projectedValue": 0, "turnoverDays": 0 },
    "cashFlow": { "impact": 0, "description": "" }
  },
  "risks": [
    { "risk": "", "likelihood": "HIGH|MEDIUM|LOW", "mitigationSteps": [""] }
  ],
  "recommendations": [
    { "action": "", "priority": "URGENT|HIGH|MEDIUM|LOW", "estimatedImpact": "" }
  ],
  "timelineWeeks": [
    { "week": 1, "keyEvents": [""], "stockoutRisk": "HIGH|MEDIUM|LOW" }
  ],
  "confidenceScore": 0,
  "assumptions": [""]
}`;
}

/* ── Run Simulation ─────────────────────────────────────────────── */
exports.inventorySimulate = onCall(CF_OPTS, async req => {
  if (!req.auth) throw new Error('Unauthenticated');
  const { tenantId, scenario } = req.data;
  const resolvedTenant = tenantId || req.auth.uid;

  const apiKey = ANTHROPIC_API_KEY.value();
  const ctx    = await _gatherContext(resolvedTenant);

  const scenarioDescriptions = {
    demand_increase    : `Demand increases by ${scenario.params?.factor ? (scenario.params.factor * 100 - 100).toFixed(0) : 50}% for the next ${scenario.params?.days || 30} days`,
    demand_decrease    : `Demand drops by ${scenario.params?.factor ? ((1 - scenario.params.factor) * 100).toFixed(0) : 30}% for the next ${scenario.params?.days || 30} days`,
    price_change       : `All prices ${scenario.params?.factor > 1 ? 'increase' : 'decrease'} by ${Math.abs((scenario.params?.factor || 1) * 100 - 100).toFixed(0)}%`,
    supplier_delay     : `Primary supplier delivery delayed by ${scenario.params?.delayDays || 14} days`,
    product_discontinue: `Discontinuing product: ${scenario.params?.productName || 'specified product'}`,
    seasonal_spike     : `Seasonal demand spike of ${scenario.params?.spikeFactor || 2}× for ${scenario.params?.days || 14} days`,
    promotion          : `${scenario.params?.discountPercent || 20}% promotion on ${scenario.params?.category || 'all categories'} for ${scenario.params?.days || 7} days`,
    custom             : scenario.params?.description || 'Custom scenario',
  };

  const description = scenarioDescriptions[scenario.type] || scenarioDescriptions.custom;

  const message = `Scenario: ${description}

Current Inventory Context:
Products: ${ctx.products.length} active SKUs
Sample products: ${JSON.stringify(ctx.products.slice(0, 15))}
Current stock levels: ${JSON.stringify(ctx.levels.slice(0, 30))}
Movement summary (last 90 days): ${ctx.movements.length} movements
Pending POs: ${JSON.stringify(ctx.pendingPOs)}

Analyze this scenario and return detailed projections as JSON.`;

  let result;
  try {
    const raw = await callAnthropic(apiKey, [{ role: 'user', content: message }], _buildSimulationPrompt(scenario), 1500);
    result = JSON.parse(raw);
  } catch {
    result = _fallbackSimulation(scenario, ctx);
  }

  /* Persist simulation */
  await db.collection(`tenants/${resolvedTenant}/inventory_simulations`).add({
    scenario,
    result,
    tenantId   : resolvedTenant,
    userId     : req.auth.uid,
    createdAt  : admin.firestore.FieldValue.serverTimestamp(),
  });

  return { ...result, scenario, context: { products: ctx.products.length, levels: ctx.levels.length } };
});

/* ── Get Simulation History ──────────────────────────────────────── */
exports.inventoryGetSimulations = onCall({ region: 'us-central1', memory: '256MiB' }, async req => {
  if (!req.auth) throw new Error('Unauthenticated');
  const { tenantId, limit = 10 } = req.data;
  const resolvedTenant = tenantId || req.auth.uid;

  const snap = await db.collection(`tenants/${resolvedTenant}/inventory_simulations`)
    .orderBy('createdAt', 'desc').limit(limit).get();

  return { simulations: snap.docs.map(d => ({ id: d.id, scenario: d.data().scenario, summary: d.data().result?.summary, createdAt: d.data().createdAt })) };
});

function _fallbackSimulation(scenario, ctx) {
  const prodCount = ctx.products.length;
  const totalValue = ctx.levels.reduce((s, l) => {
    const p = ctx.products.find(x => x.id === l.productId);
    return s + (l.available || 0) * (p?.cost || 0);
  }, 0);

  return {
    scenario    : scenario.type,
    summary     : `Rule-based simulation for ${scenario.type}. ${prodCount} products analyzed.`,
    projections : {
      revenue      : { current: 0, projected: 0, delta: 0, deltaPercent: 0 },
      stockouts    : { count: 0, products: [], estimatedLossKES: 0 },
      inventory    : { currentValue: totalValue, projectedValue: totalValue, turnoverDays: 30 },
      cashFlow     : { impact: 0, description: 'Insufficient data for precise projection' },
    },
    risks           : [{ risk: 'Data insufficient for high-confidence simulation', likelihood: 'MEDIUM', mitigationSteps: ['Add more transaction history', 'Set accurate cost prices'] }],
    recommendations : [{ action: 'Ensure all products have cost prices and accurate stock levels', priority: 'HIGH', estimatedImpact: 'Improves simulation accuracy significantly' }],
    timelineWeeks   : [{ week: 1, keyEvents: ['Monitor closely'], stockoutRisk: 'MEDIUM' }],
    confidenceScore : 40,
    assumptions     : ['Based on limited historical data'],
  };
}
