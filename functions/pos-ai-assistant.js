/* ================================================================
   SOKONI SmartPOS — AI Business Assistant  v1.0
   Firebase Gen2 Cloud Functions

   Exports
   ───────
   askPOSAssistant       — onCall  Natural-language Q&A over live POS data
   getAIQueryHistory     — onCall  Last 20 queries (manager+)
   clearAIQueryHistory   — onCall  Delete all queries for seller (owner)

   AI Model: claude-haiku-4-5-20251001 via Anthropic Messages API
   Assistant persona: KASS — SOKONI SmartPOS AI Business Assistant

   Security
   ─────────
   • enforceAppCheck on all functions
   • Auth required; role-based guards (manager+ / owner)
   • API key delivered via Secret Manager (never in env plaintext)
   • AI responses never include raw Firestore document IDs
   • Query history saved for audit; retention governed by owner

   Performance
   ────────────
   • Intent detection is pure string matching — zero latency before AI call
   • Firestore reads per intent are narrow (filter + limit)
   • Context string capped to avoid token bloat
   • Haiku max_tokens: 1024 — fast, cheap, accurate for structured data

   Firestore Collections Used
   ──────────────────────────
   posReorderQueue        — {sellerId, status, productId, productName, currentStock, reorderQty}
   posSales               — {sellerId, branchId, cashierUid, cashierName, totalAmount, createdAt}
   posStockValuation      — {sellerId, productId, currentStock, avgDailySales, costPrice}
   products               — {sellerId, name, stock, stockAlert, category, price}
   posBISnapshots         — {sellerId, branchId, revenue, transactions, date}
   posAIQueries           — audit log of every AI query
================================================================ */
'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret }       = require('firebase-functions/params');
const admin                  = require('firebase-admin');

if (!admin.apps.length) admin.initializeApp();
const db = admin.firestore();

/* ── Secret ──────────────────────────────────────────────────────────────── */
const ANTHROPIC_API_KEY = defineSecret('ANTHROPIC_API_KEY');

/* ── Runtime options ─────────────────────────────────────────────────────── */
const _CF       = { region: 'us-central1', enforceAppCheck: true };
const _AI_CF_OPTS = { region: 'us-central1', enforceAppCheck: true, secrets: [ANTHROPIC_API_KEY] };

/* ── Helpers ─────────────────────────────────────────────────────────────── */
const _TS = () => admin.firestore.FieldValue.serverTimestamp();

function _requireAuth(req) {
  if (!req.auth) throw new HttpsError('unauthenticated', 'Login required');
  return req.auth;
}

function _requireRole(auth, minRole) {
  const levels = { cashier: 0, supervisor: 1, manager: 2, owner: 3 };
  const userLevel  = levels[auth.token?.posRole || 'cashier'] ?? 0;
  const required   = levels[minRole] ?? 0;
  if (userLevel < required)
    throw new HttpsError('permission-denied', `Requires ${minRole} role`);
}

function _validateSellerId(sellerId) {
  if (!sellerId || typeof sellerId !== 'string' || sellerId.trim().length === 0)
    throw new HttpsError('invalid-argument', 'sellerId is required');
  return sellerId.trim();
}

function _validateQuestion(question) {
  if (!question || typeof question !== 'string' || question.trim().length === 0)
    throw new HttpsError('invalid-argument', 'question is required');
  if (question.trim().length > 500)
    throw new HttpsError('invalid-argument', 'question must be 500 characters or fewer');
  return question.trim();
}

/* ── Structured logger ───────────────────────────────────────────────────── */
function _log(severity, msg, extra = {}) {
  console[severity === 'ERROR' ? 'error' : severity === 'WARNING' ? 'warn' : 'log'](
    JSON.stringify({ severity, message: msg, service: 'pos-ai-assistant', ...extra })
  );
}

/* ══════════════════════════════════════════════════════════════════════════
   ANTHROPIC API HELPER
══════════════════════════════════════════════════════════════════════════ */

/**
 * Calls claude-haiku-4-5-20251001 via the Anthropic Messages API.
 * @param {string} systemPrompt
 * @param {string} userMessage
 * @param {string} apiKey
 * @returns {Promise<string>} The assistant's text response
 */
async function _callHaiku(systemPrompt, userMessage, apiKey) {
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key':         apiKey,
      'anthropic-version': '2023-06-01',
      'content-type':      'application/json',
    },
    body: JSON.stringify({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      system:     systemPrompt,
      messages:   [{ role: 'user', content: userMessage }],
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    _log('ERROR', 'Anthropic API error', { status: resp.status, body: errText });
    throw new HttpsError('internal', `AI service unavailable (${resp.status})`);
  }

  const data = await resp.json();

  if (!data.content || !data.content[0] || data.content[0].type !== 'text') {
    throw new HttpsError('internal', 'Unexpected AI response format');
  }

  return data.content[0].text;
}

/* ══════════════════════════════════════════════════════════════════════════
   INTENT DETECTION
   Pure string matching — no AI cost, no latency.
══════════════════════════════════════════════════════════════════════════ */

const INTENT_KEYWORDS = {
  reorder_check:            ['reorder', 'run out', 'stock low', 'need to order', 'order more', 'running low', 'replenish'],
  top_cashier:              ['cashier', 'best seller', 'most sales', 'top performer', 'who sold', 'best performing staff', 'top staff'],
  revenue_decline:          ['revenue down', 'sales decreased', 'why less', 'lower sales', 'sales drop', 'revenue drop', 'declining', 'fell', 'fell down', 'dropped'],
  stockout_forecast:        ['run out tomorrow', 'will run out', 'forecast', 'out of stock soon', 'days of stock', 'stock forecast', 'days left'],
  branch_performance:       ['branch', 'store', 'underperform', 'which location', 'location', 'outlet', 'branch compare'],
  promotion_recommendation: ['promotion', 'offer', 'discount', 'campaign', 'recommend', 'slow mover', 'overstocked', 'dead stock', 'clearance'],
};

/**
 * Detects business intent from a natural-language question.
 * @param {string} question
 * @returns {string} intent key
 */
function _detectIntent(question) {
  const q = question.toLowerCase();
  for (const [intent, keywords] of Object.entries(INTENT_KEYWORDS)) {
    if (keywords.some(kw => q.includes(kw))) return intent;
  }
  return 'general';
}

/* ══════════════════════════════════════════════════════════════════════════
   DATA FETCHERS — one per intent
   Each returns { summary: string, rawData: object }
══════════════════════════════════════════════════════════════════════════ */

/** Reorder check: items pending reorder */
async function _fetchReorderCheck(sellerId) {
  const snap = await db.collection('posReorderQueue')
    .where('sellerId', '==', sellerId)
    .where('status', '==', 'pending')
    .orderBy('currentStock', 'asc')
    .limit(20)
    .get();

  const items = snap.docs.map(d => {
    const { productName, currentStock, reorderQty, supplierName } = d.data();
    return { productName: productName || 'Unknown', currentStock: currentStock ?? 0, reorderQty: reorderQty ?? 0, supplierName: supplierName || 'N/A' };
  });

  const summary = items.length === 0
    ? 'No items currently pending reorder.'
    : `${items.length} item(s) pending reorder:\n` + items.map(i =>
        `  • ${i.productName}: current stock ${i.currentStock} units, reorder qty ${i.reorderQty} (supplier: ${i.supplierName})`
      ).join('\n');

  return { summary, rawData: { pendingReorders: items.length, items } };
}

/** Top cashier: best performer today by total sales amount */
async function _fetchTopCashier(sellerId) {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);

  const snap = await db.collection('posSales')
    .where('sellerId', '==', sellerId)
    .where('createdAt', '>=', admin.firestore.Timestamp.fromDate(startOfDay))
    .limit(500)
    .get();

  const cashierMap = {};
  for (const doc of snap.docs) {
    const { cashierUid, cashierName, totalAmount } = doc.data();
    if (!cashierUid) continue;
    if (!cashierMap[cashierUid]) {
      cashierMap[cashierUid] = { cashierUid, cashierName: cashierName || 'Unknown', totalSales: 0, txCount: 0 };
    }
    cashierMap[cashierUid].totalSales += totalAmount || 0;
    cashierMap[cashierUid].txCount++;
  }

  const rankings = Object.values(cashierMap).sort((a, b) => b.totalSales - a.totalSales);

  const summary = rankings.length === 0
    ? 'No sales recorded today yet.'
    : `Today\'s cashier performance (${rankings.length} active):\n` + rankings.slice(0, 5).map((c, i) =>
        `  ${i + 1}. ${c.cashierName}: KES ${c.totalSales.toFixed(2)} across ${c.txCount} transaction(s)`
      ).join('\n');

  return { summary, rawData: { totalSalesToday: snap.size, rankings: rankings.slice(0, 5) } };
}

/** Revenue decline: last 7 days vs prior 7 days */
async function _fetchRevenueDecline(sellerId) {
  const now   = new Date();
  const day7  = new Date(now); day7.setDate(now.getDate() - 7);
  const day14 = new Date(now); day14.setDate(now.getDate() - 14);

  const [recentSnap, priorSnap] = await Promise.all([
    db.collection('posSales')
      .where('sellerId', '==', sellerId)
      .where('createdAt', '>=', admin.firestore.Timestamp.fromDate(day7))
      .limit(2000)
      .get(),
    db.collection('posSales')
      .where('sellerId', '==', sellerId)
      .where('createdAt', '>=', admin.firestore.Timestamp.fromDate(day14))
      .where('createdAt', '<',  admin.firestore.Timestamp.fromDate(day7))
      .limit(2000)
      .get(),
  ]);

  const sumRevenue = snap => snap.docs.reduce((acc, d) => acc + (d.data().totalAmount || 0), 0);

  const recentRevenue = sumRevenue(recentSnap);
  const priorRevenue  = sumRevenue(priorSnap);
  const change        = recentRevenue - priorRevenue;
  const changePct     = priorRevenue > 0 ? ((change / priorRevenue) * 100).toFixed(1) : 'N/A';

  const direction = change >= 0 ? 'increased' : 'decreased';
  const summary = `Revenue comparison:\n` +
    `  • Last 7 days:  KES ${recentRevenue.toFixed(2)} (${recentSnap.size} transactions)\n` +
    `  • Prior 7 days: KES ${priorRevenue.toFixed(2)} (${priorSnap.size} transactions)\n` +
    `  • Revenue ${direction} by KES ${Math.abs(change).toFixed(2)} (${changePct === 'N/A' ? 'N/A' : changePct + '%'})`;

  return { summary, rawData: { recentRevenue, priorRevenue, change, changePct, direction } };
}

/** Stockout forecast: days of stock remaining per product */
async function _fetchStockoutForecast(sellerId) {
  const snap = await db.collection('posStockValuation')
    .where('sellerId', '==', sellerId)
    .limit(100)
    .get();

  const forecasts = [];
  for (const doc of snap.docs) {
    const { productId, productName, currentStock, avgDailySales } = doc.data();
    if (!avgDailySales || avgDailySales <= 0) continue;
    const daysLeft = (currentStock || 0) / avgDailySales;
    if (daysLeft <= 14) { // only show products at risk within 2 weeks
      forecasts.push({
        productName: productName || productId || 'Unknown',
        currentStock: currentStock || 0,
        avgDailySales: Number(avgDailySales.toFixed(2)),
        daysLeft: Number(daysLeft.toFixed(1)),
      });
    }
  }

  forecasts.sort((a, b) => a.daysLeft - b.daysLeft);

  const summary = forecasts.length === 0
    ? 'No products forecast to stock out within 14 days.'
    : `Products at risk of stockout (within 14 days):\n` + forecasts.slice(0, 10).map(f =>
        `  • ${f.productName}: ${f.currentStock} units, ~${f.daysLeft} days remaining (${f.avgDailySales}/day avg)`
      ).join('\n');

  return { summary, rawData: { atRiskCount: forecasts.length, forecasts: forecasts.slice(0, 10) } };
}

/** Branch performance: revenue by branch last 30 days */
async function _fetchBranchPerformance(sellerId) {
  // Try BI snapshots first (pre-aggregated)
  const snapBI = await db.collection('posBISnapshots')
    .where('sellerId', '==', sellerId)
    .orderBy('date', 'desc')
    .limit(60) // up to 2 snapshots per branch per day × 30 days
    .get();

  const branchMap = {};

  if (!snapBI.empty) {
    for (const doc of snapBI.docs) {
      const { branchId, branchName, revenue, transactions } = doc.data();
      const key = branchId || 'default';
      if (!branchMap[key]) {
        branchMap[key] = { branchId: key, branchName: branchName || key, revenue: 0, transactions: 0 };
      }
      branchMap[key].revenue      += revenue || 0;
      branchMap[key].transactions += transactions || 0;
    }
  } else {
    // Fallback: aggregate from posSales last 30 days
    const day30 = new Date(); day30.setDate(day30.getDate() - 30);
    const salesSnap = await db.collection('posSales')
      .where('sellerId', '==', sellerId)
      .where('createdAt', '>=', admin.firestore.Timestamp.fromDate(day30))
      .limit(2000)
      .get();

    for (const doc of salesSnap.docs) {
      const { branchId, branchName, totalAmount } = doc.data();
      const key = branchId || 'default';
      if (!branchMap[key]) {
        branchMap[key] = { branchId: key, branchName: branchName || key, revenue: 0, transactions: 0 };
      }
      branchMap[key].revenue += totalAmount || 0;
      branchMap[key].transactions++;
    }
  }

  const branches = Object.values(branchMap).sort((a, b) => b.revenue - a.revenue);

  const summary = branches.length === 0
    ? 'No branch data available.'
    : `Branch performance (last 30 days):\n` + branches.map((b, i) =>
        `  ${i + 1}. ${b.branchName}: KES ${b.revenue.toFixed(2)} (${b.transactions} transactions)`
      ).join('\n');

  return { summary, rawData: { branchCount: branches.length, branches } };
}

/** Promotion recommendations: slow movers and overstocked items */
async function _fetchPromotionRecommendations(sellerId) {
  const stockSnap = await db.collection('posStockValuation')
    .where('sellerId', '==', sellerId)
    .limit(100)
    .get();

  const slowMovers  = [];
  const overstocked = [];

  for (const doc of stockSnap.docs) {
    const { productName, currentStock, avgDailySales, reorderPoint, price } = doc.data();
    const name = productName || 'Unknown';

    if (avgDailySales !== undefined && avgDailySales < 0.5 && currentStock > 10) {
      // Selling less than 0.5 units/day with meaningful stock = slow mover
      slowMovers.push({ name, currentStock, avgDailySales: Number((avgDailySales || 0).toFixed(2)), price: price || 0 });
    }

    if (reorderPoint && currentStock > reorderPoint * 3) {
      // Stock more than 3x reorder point = overstocked
      overstocked.push({ name, currentStock, reorderPoint, price: price || 0 });
    }
  }

  const parts = [];
  if (slowMovers.length > 0) {
    parts.push(`Slow movers (consider promotions):\n` + slowMovers.slice(0, 5).map(p =>
      `  • ${p.name}: ${p.currentStock} units, ${p.avgDailySales}/day avg, KES ${p.price}`
    ).join('\n'));
  }
  if (overstocked.length > 0) {
    parts.push(`Overstocked items:\n` + overstocked.slice(0, 5).map(p =>
      `  • ${p.name}: ${p.currentStock} units (reorder point: ${p.reorderPoint})`
    ).join('\n'));
  }

  const summary = parts.length === 0
    ? 'No significant slow movers or overstocked items detected.'
    : parts.join('\n\n');

  return { summary, rawData: { slowMovers: slowMovers.length, overstocked: overstocked.length } };
}

/** General: last 7 days high-level summary */
async function _fetchGeneralSummary(sellerId) {
  const day7 = new Date(); day7.setDate(day7.getDate() - 7);

  const snap = await db.collection('posSales')
    .where('sellerId', '==', sellerId)
    .where('createdAt', '>=', admin.firestore.Timestamp.fromDate(day7))
    .limit(2000)
    .get();

  const totalRevenue = snap.docs.reduce((acc, d) => acc + (d.data().totalAmount || 0), 0);
  const txCount      = snap.size;
  const avgTx        = txCount > 0 ? totalRevenue / txCount : 0;

  const summary = `Last 7 days summary:\n` +
    `  • Total revenue: KES ${totalRevenue.toFixed(2)}\n` +
    `  • Total transactions: ${txCount}\n` +
    `  • Average transaction value: KES ${avgTx.toFixed(2)}`;

  return { summary, rawData: { totalRevenue, txCount, avgTx: Number(avgTx.toFixed(2)) } };
}

/* ── Intent → data fetcher dispatch map ────────────────────────────────── */
const INTENT_FETCHERS = {
  reorder_check:            _fetchReorderCheck,
  top_cashier:              _fetchTopCashier,
  revenue_decline:          _fetchRevenueDecline,
  stockout_forecast:        _fetchStockoutForecast,
  branch_performance:       _fetchBranchPerformance,
  promotion_recommendation: _fetchPromotionRecommendations,
  general:                  _fetchGeneralSummary,
};

/* ══════════════════════════════════════════════════════════════════════════
   SYSTEM PROMPT
══════════════════════════════════════════════════════════════════════════ */
const KASS_SYSTEM_PROMPT =
  'You are KASS, the SOKONI SmartPOS AI Business Assistant. ' +
  'You help retail business owners in Kenya understand their data and make smart decisions. ' +
  'Platform: SOKONI. Currency: KES (Kenyan Shillings). ' +
  'Be concise, practical, and action-oriented. ' +
  'Format responses with bullet points where helpful. ' +
  'Always ground your answer in the provided data context. ' +
  'If the data shows concerning trends, flag them clearly. ' +
  'Do not hallucinate numbers — only reference figures present in the data context.';

/* ══════════════════════════════════════════════════════════════════════════
   EXPORT 1: askPOSAssistant
   Natural-language Q&A over live POS data powered by Claude Haiku.
══════════════════════════════════════════════════════════════════════════ */
exports.askPOSAssistant = onCall(_AI_CF_OPTS, async (req) => {
  const auth     = _requireAuth(req);
  const sellerId = _validateSellerId(req.data?.sellerId);
  const question = _validateQuestion(req.data?.question);

  // Sellers and above can ask questions; cashiers cannot call AI queries
  _requireRole(auth, 'supervisor');

  // Optional: verify caller belongs to this seller
  if (auth.token?.sellerId && auth.token.sellerId !== sellerId) {
    throw new HttpsError('permission-denied', 'Not authorised for this seller account');
  }

  _log('INFO', 'AI query received', { sellerId, uid: auth.uid, questionLength: question.length });

  /* 1. Detect intent */
  const intent = _detectIntent(question);
  _log('INFO', 'Intent detected', { intent, sellerId });

  /* 2. Fetch relevant data */
  const fetcher = INTENT_FETCHERS[intent] || INTENT_FETCHERS.general;
  let dataResult;
  try {
    dataResult = await fetcher(sellerId);
  } catch (err) {
    _log('ERROR', 'Data fetch failed', { intent, sellerId, error: err.message });
    // Degrade gracefully — let AI answer without live data
    dataResult = {
      summary: 'Live data temporarily unavailable.',
      rawData: {},
    };
  }

  /* 3. Build user message with context */
  const userMessage =
    `Business question: ${question}\n\n` +
    `Relevant data from your SOKONI POS system:\n${dataResult.summary}\n\n` +
    `Please answer the question based on the data above. Be specific and actionable.`;

  /* 4. Call Haiku */
  const apiKey = ANTHROPIC_API_KEY.value();
  let answer;
  try {
    answer = await _callHaiku(KASS_SYSTEM_PROMPT, userMessage, apiKey);
  } catch (err) {
    _log('ERROR', 'Haiku call failed', { sellerId, error: err.message });
    throw new HttpsError('internal', 'AI assistant is temporarily unavailable. Please try again shortly.');
  }

  /* 5. Save audit record */
  const queryDoc = {
    sellerId,
    uid:        auth.uid,
    question,
    intent,
    answer,
    dataContext: JSON.stringify(dataResult.rawData).slice(0, 2000), // cap size
    createdAt:  _TS(),
  };

  let queryId;
  try {
    const ref = await db.collection('posAIQueries').add(queryDoc);
    queryId = ref.id;
  } catch (err) {
    // Audit failure is non-fatal
    _log('WARNING', 'Failed to save AI query audit record', { sellerId, error: err.message });
  }

  _log('INFO', 'AI query answered', { sellerId, intent, queryId });

  return {
    answer,
    intent,
    dataContext: dataResult.summary,
    timestamp:  new Date().toISOString(),
  };
});

/* ══════════════════════════════════════════════════════════════════════════
   EXPORT 2: getAIQueryHistory
   Returns the last 20 AI queries for a seller. Role: manager+
══════════════════════════════════════════════════════════════════════════ */
exports.getAIQueryHistory = onCall(_CF, async (req) => {
  const auth     = _requireAuth(req);
  const sellerId = _validateSellerId(req.data?.sellerId);

  _requireRole(auth, 'manager');

  if (auth.token?.sellerId && auth.token.sellerId !== sellerId) {
    throw new HttpsError('permission-denied', 'Not authorised for this seller account');
  }

  const snap = await db.collection('posAIQueries')
    .where('sellerId', '==', sellerId)
    .orderBy('createdAt', 'desc')
    .limit(20)
    .get();

  const queries = snap.docs.map(doc => {
    const { question, intent, answer, dataContext, createdAt } = doc.data();
    return {
      id: doc.id,
      question,
      intent,
      answer,
      dataContext,
      createdAt: createdAt?.toDate?.()?.toISOString() ?? null,
    };
  });

  return { queries, count: queries.length };
});

/* ══════════════════════════════════════════════════════════════════════════
   EXPORT 3: clearAIQueryHistory
   Deletes all AI query records for a seller. Role: owner only.
══════════════════════════════════════════════════════════════════════════ */
exports.clearAIQueryHistory = onCall(_CF, async (req) => {
  const auth     = _requireAuth(req);
  const sellerId = _validateSellerId(req.data?.sellerId);

  _requireRole(auth, 'owner');

  if (auth.token?.sellerId && auth.token.sellerId !== sellerId) {
    throw new HttpsError('permission-denied', 'Not authorised for this seller account');
  }

  // Firestore deletes must be done in batches (max 500 per batch)
  let totalDeleted = 0;
  let hasMore      = true;

  while (hasMore) {
    const snap = await db.collection('posAIQueries')
      .where('sellerId', '==', sellerId)
      .limit(400)
      .get();

    if (snap.empty) {
      hasMore = false;
      break;
    }

    const batch = db.batch();
    snap.docs.forEach(doc => batch.delete(doc.ref));
    await batch.commit();

    totalDeleted += snap.size;

    if (snap.size < 400) hasMore = false;
  }

  _log('INFO', 'AI query history cleared', { sellerId, uid: auth.uid, totalDeleted });

  // Audit the deletion itself
  await db.collection('posAuditLog').add({
    sellerId,
    uid:       auth.uid,
    eventType: 'ai_query_history_cleared',
    details:   { totalDeleted },
    createdAt: _TS(),
  }).catch(() => {}); // non-fatal

  return { deleted: totalDeleted };
});
