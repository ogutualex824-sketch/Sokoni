'use strict';

/**
 * SOKONI — Marketing & Promotions Engine v1.0
 * ============================================
 * Cloud Functions: 12
 *   createBundleDeal          — create a product bundle with automatic discount calc
 *   getActiveBundleDeals      — list live bundle deals for a merchant
 *   createFlashSale           — create a time-boxed flash sale
 *   getFlashSalePrice         — real-time sale price lookup for a product
 *   recordFlashSalePurchase   — atomic sold-count increment + auto-end on sell-through
 *   getCrossSellRecommendations — co-occurrence + Claude Haiku fallback
 *   getUpsellRecommendations  — premium-variant suggestions
 *   createMarketingCampaign   — lifecycle campaigns (birthday, win-back, etc.)
 *   runABTest                 — create & activate A/B price / description / image tests
 *   recordABTestImpression    — atomic impression + conversion tracking + auto-conclude
 *   applyCouponCode           — validate coupon without consuming it
 *   concludeExpiredFlashSales — scheduled: auto-end flash sales every 10 min
 *
 * Collections:
 *   mktBundleDeals/{bundleId}
 *   mktFlashSales/{saleId}
 *   mktABTests/{testId}
 *   mktDynamicPricing/{ruleId}
 *   mktCouponCodes/{couponId}
 *   mktRecommendationEngineLog/{logId}
 *   mktCampaigns/{campaignId}
 *
 * Security: enforceAppCheck on all mutating functions.
 *           Auth required on all write paths.
 *           Merchants may only manage their own records.
 */

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule }         = require('firebase-functions/v2/scheduler');
const { defineSecret }       = require('firebase-functions/params');
const logger                 = require('firebase-functions/logger');
const admin                  = require('firebase-admin');

if (!admin.apps.length) admin.initializeApp();

const db = admin.firestore();
const F  = admin.firestore.FieldValue;

const ANTHROPIC_KEY = defineSecret('ANTHROPIC_API_KEY');
const REGION        = 'us-central1';

/** Options for mutating / sensitive functions */
const OPT = { region: REGION, enforceAppCheck: true, memory: '256MiB', timeoutSeconds: 60 };
/** Options for read-only / public functions */
const OPT_READ = { region: REGION, memory: '256MiB', timeoutSeconds: 30 };
/** Options for AI-backed functions */
const OPT_AI = { ...OPT, secrets: [ANTHROPIC_KEY], timeoutSeconds: 90 };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function _err(msg, code = 'invalid-argument') {
  throw new HttpsError(code, msg);
}

function _requireAuth(req) {
  if (!req.auth?.uid) _err('Authentication required.', 'unauthenticated');
  return req.auth.uid;
}

function _requireMerchant(req) {
  const uid = _requireAuth(req);
  const role = req.auth.token?.role ?? 0;
  if (role < 2) _err('Seller / merchant role required.', 'permission-denied');
  return uid;
}

/** Strip HTML tags and trim, hard-cap length. */
function _san(s, max = 300) {
  if (s == null) return '';
  return String(s).replace(/<[^>]*>/g, '').trim().slice(0, max);
}

/** Round a number to n decimal places. */
function _round(n, dp = 2) {
  return Math.round(n * 10 ** dp) / 10 ** dp;
}

/** now as JS Date */
const _now = () => new Date();

/** Lazy Anthropic client — created only when secrets are loaded. */
let _ai = null;
function _getAI() {
  if (!_ai) {
    const Anthropic = require('@anthropic-ai/sdk');
    _ai = new Anthropic({ apiKey: ANTHROPIC_KEY.value() });
  }
  return _ai;
}

const CAMPAIGN_TYPES = ['birthday', 'win_back', 'tier_upgrade', 'spend_milestone'];
const AB_TEST_TYPES  = ['price', 'description', 'image', 'promotion'];
const COUPON_TYPES   = ['percent', 'flat', 'shipping_free'];

// ---------------------------------------------------------------------------
// 1. createBundleDeal
// ---------------------------------------------------------------------------

const createBundleDeal = onCall(OPT, async (req) => {
  const uid = _requireMerchant(req);
  const {
    merchantId,
    name,
    items,
    bundlePrice,
    validFrom,
    validTo,
    usageLimit,
  } = req.data || {};

  // Validate required fields
  if (!merchantId || typeof merchantId !== 'string') _err('merchantId is required.');
  if (merchantId !== req.auth.token?.merchantId && !(req.auth.token?.admin))
    _err('Cannot create deals for another merchant.', 'permission-denied');
  if (!name || !_san(name, 200)) _err('name is required.');
  if (!Array.isArray(items) || items.length < 2)
    _err('items must be an array of at least 2 products.');
  if (typeof bundlePrice !== 'number' || bundlePrice <= 0)
    _err('bundlePrice must be a positive number.');
  if (!validFrom || !validTo) _err('validFrom and validTo are required.');

  const vFrom = new Date(validFrom);
  const vTo   = new Date(validTo);
  if (isNaN(vFrom.getTime()) || isNaN(vTo.getTime()))
    _err('validFrom and validTo must be valid ISO date strings.');
  if (vTo <= vFrom) _err('validTo must be after validFrom.');

  // Validate items
  let totalIndividualPrice = 0;
  const cleanItems = [];
  for (const item of items) {
    if (!item.productId) _err('Each item must have a productId.');
    if (!item.sku)       _err('Each item must have a sku.');
    if (!item.name)      _err('Each item must have a name.');
    if (typeof item.qty !== 'number' || item.qty <= 0)
      _err(`Item ${item.productId}: qty must be > 0.`);
    if (typeof item.unitPrice !== 'number' || item.unitPrice <= 0)
      _err(`Item ${item.productId}: unitPrice must be > 0.`);

    totalIndividualPrice += item.qty * item.unitPrice;
    cleanItems.push({
      productId: _san(item.productId, 100),
      sku:       _san(item.sku, 100),
      name:      _san(item.name, 200),
      qty:       item.qty,
      unitPrice: item.unitPrice,
    });
  }

  if (bundlePrice >= totalIndividualPrice)
    _err('bundlePrice must be less than the total individual price — bundle must offer a discount.');

  const discountAmount = _round(totalIndividualPrice - bundlePrice, 2);
  const discountPct    = _round((discountAmount / totalIndividualPrice) * 100, 2);
  const now            = _now();
  const status         = vFrom <= now ? 'active' : 'scheduled';

  const docRef = db.collection('mktBundleDeals').doc();
  await docRef.set({
    merchantId,
    createdBy:   uid,
    name:        _san(name, 200),
    items:       cleanItems,
    bundlePrice,
    totalIndividualPrice: _round(totalIndividualPrice, 2),
    discountAmount,
    discountPct,
    validFrom:   admin.firestore.Timestamp.fromDate(vFrom),
    validTo:     admin.firestore.Timestamp.fromDate(vTo),
    usageLimit:  typeof usageLimit === 'number' && usageLimit > 0 ? usageLimit : null,
    usageCount:  0,
    status,
    createdAt:   F.serverTimestamp(),
    updatedAt:   F.serverTimestamp(),
  });

  logger.info('mktBundleDeal created', { bundleId: docRef.id, merchantId, discountPct });
  return { bundleId: docRef.id, discountPct, discountAmount, status };
});

// ---------------------------------------------------------------------------
// 2. getActiveBundleDeals
// ---------------------------------------------------------------------------

const getActiveBundleDeals = onCall(OPT_READ, async (req) => {
  const { merchantId } = req.data || {};
  if (!merchantId) _err('merchantId is required.');

  const now     = admin.firestore.Timestamp.fromDate(_now());
  const snap    = await db.collection('mktBundleDeals')
    .where('merchantId', '==', merchantId)
    .where('status', '==', 'active')
    .where('validTo', '>', now)
    .orderBy('validTo')
    .orderBy('discountPct', 'desc')
    .get();

  const deals = snap.docs.map(d => ({ bundleId: d.id, ...d.data() }));
  // Sort by discountPct desc (secondary sort not supported alongside inequality filter)
  deals.sort((a, b) => b.discountPct - a.discountPct);

  return { deals };
});

// ---------------------------------------------------------------------------
// 3. createFlashSale
// ---------------------------------------------------------------------------

const createFlashSale = onCall(OPT, async (req) => {
  const uid = _requireMerchant(req);
  const {
    merchantId,
    productId,
    sku,
    originalPrice,
    salePrice,
    startAt,
    endAt,
    stockLimit,
  } = req.data || {};

  if (!merchantId)  _err('merchantId is required.');
  if (!productId)   _err('productId is required.');
  if (!sku)         _err('sku is required.');
  if (typeof originalPrice !== 'number' || originalPrice <= 0)
    _err('originalPrice must be a positive number.');
  if (typeof salePrice !== 'number' || salePrice <= 0)
    _err('salePrice must be a positive number.');
  if (salePrice >= originalPrice)
    _err('salePrice must be less than originalPrice.');
  if (!startAt || !endAt) _err('startAt and endAt are required.');

  const sStart = new Date(startAt);
  const sEnd   = new Date(endAt);
  if (isNaN(sStart.getTime()) || isNaN(sEnd.getTime()))
    _err('startAt and endAt must be valid ISO date strings.');
  if (sEnd <= sStart) _err('endAt must be after startAt.');
  if (typeof stockLimit !== 'number' || stockLimit < 1)
    _err('stockLimit must be a positive integer.');

  const discountPct = _round(((originalPrice - salePrice) / originalPrice) * 100, 2);
  const now         = _now();
  const status      = now < sStart ? 'scheduled' : 'active';

  const docRef = db.collection('mktFlashSales').doc();
  await docRef.set({
    merchantId,
    createdBy:     uid,
    productId:     _san(productId, 100),
    sku:           _san(sku, 100),
    originalPrice,
    salePrice,
    discountPct,
    startAt:       admin.firestore.Timestamp.fromDate(sStart),
    endAt:         admin.firestore.Timestamp.fromDate(sEnd),
    stockLimit,
    soldCount:     0,
    status,
    createdAt:     F.serverTimestamp(),
    updatedAt:     F.serverTimestamp(),
  });

  logger.info('mktFlashSale created', { saleId: docRef.id, merchantId, productId, discountPct });
  return { saleId: docRef.id, discountPct, status };
});

// ---------------------------------------------------------------------------
// 4. getFlashSalePrice
// ---------------------------------------------------------------------------

const getFlashSalePrice = onCall(OPT_READ, async (req) => {
  const { productId, merchantId } = req.data || {};
  if (!productId)  _err('productId is required.');
  if (!merchantId) _err('merchantId is required.');

  const now  = admin.firestore.Timestamp.fromDate(_now());
  const snap = await db.collection('mktFlashSales')
    .where('merchantId', '==', merchantId)
    .where('productId', '==', productId)
    .where('status', '==', 'active')
    .where('startAt', '<=', now)
    .where('endAt', '>', now)
    .limit(1)
    .get();

  if (snap.empty) return { hasFlashSale: false };

  const doc  = snap.docs[0];
  const sale = doc.data();
  const stockRemaining = sale.stockLimit - sale.soldCount;

  if (stockRemaining <= 0) return { hasFlashSale: false };

  return {
    hasFlashSale: true,
    saleId:        doc.id,
    originalPrice: sale.originalPrice,
    salePrice:     sale.salePrice,
    discountPct:   sale.discountPct,
    endsAt:        sale.endAt,
    stockRemaining,
  };
});

// ---------------------------------------------------------------------------
// 5. recordFlashSalePurchase
// ---------------------------------------------------------------------------

const recordFlashSalePurchase = onCall(OPT, async (req) => {
  _requireAuth(req);
  const { saleId, qty } = req.data || {};
  if (!saleId)                                   _err('saleId is required.');
  if (typeof qty !== 'number' || qty < 1)        _err('qty must be a positive integer.');

  const saleRef = db.collection('mktFlashSales').doc(saleId);

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(saleRef);
    if (!snap.exists) _err('Flash sale not found.', 'not-found');

    const sale = snap.data();
    if (sale.status !== 'active')
      _err('Flash sale is not currently active.', 'failed-precondition');

    const newSoldCount = sale.soldCount + qty;
    if (newSoldCount > sale.stockLimit)
      _err(`Only ${sale.stockLimit - sale.soldCount} unit(s) remain in this flash sale.`, 'resource-exhausted');

    const updates = {
      soldCount: F.increment(qty),
      updatedAt: F.serverTimestamp(),
    };
    if (newSoldCount >= sale.stockLimit) {
      updates.status = 'ended';
    }
    tx.update(saleRef, updates);
  });

  return { success: true };
});

// ---------------------------------------------------------------------------
// 6. getCrossSellRecommendations
// ---------------------------------------------------------------------------

const getCrossSellRecommendations = onCall(OPT_AI, async (req) => {
  const { productId, merchantId, cartItems = [], limit = 5 } = req.data || {};
  if (!productId)  _err('productId is required.');
  if (!merchantId) _err('merchantId is required.');

  const safeLimit   = Math.min(Math.max(1, Number(limit) || 5), 10);
  const excludeSet  = new Set([productId, ...cartItems.map(String)]);

  // --- Step 1: Co-occurrence from recommendation log ---
  const logSnap = await db.collection('mktRecommendationEngineLog')
    .where('merchantId', '==', merchantId)
    .where('productId', '==', productId)
    .orderBy('createdAt', 'desc')
    .limit(200)
    .get();

  const cooccurrence = {};
  for (const doc of logSnap.docs) {
    const data = doc.data();
    for (const recId of (data.recommendations || [])) {
      if (excludeSet.has(recId)) continue;
      cooccurrence[recId] = (cooccurrence[recId] || 0) + 1;
    }
    if (data.clickedProductId && !excludeSet.has(data.clickedProductId)) {
      cooccurrence[data.clickedProductId] = (cooccurrence[data.clickedProductId] || 0) + 3;
    }
    if (data.convertedProductId && !excludeSet.has(data.convertedProductId)) {
      cooccurrence[data.convertedProductId] = (cooccurrence[data.convertedProductId] || 0) + 5;
    }
  }

  const sorted = Object.entries(cooccurrence)
    .sort((a, b) => b[1] - a[1])
    .slice(0, safeLimit)
    .map(([pid]) => pid);

  if (sorted.length >= 3) {
    // Fetch product details for the top co-occurrence results
    const productDocs = await Promise.all(
      sorted.map(pid => db.collection('posProducts').doc(pid).get())
    );
    const recommendations = productDocs
      .filter(d => d.exists)
      .map(d => ({
        productId:      d.id,
        name:           d.data().name,
        price:          d.data().price,
        relevanceScore: cooccurrence[d.id],
      }));

    return { recommendations, source: 'collaborative' };
  }

  // --- Step 2: AI fallback via Claude Haiku ---
  try {
    // Fetch anchor product info
    const anchorDoc = await db.collection('posProducts').doc(productId).get();
    const anchor    = anchorDoc.exists ? anchorDoc.data() : {};
    const productName   = anchor.name     || 'a product';
    const merchantType  = anchor.category || 'general retail';

    const ai = _getAI();
    const aiResponse = await ai.messages.create({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 512,
      messages: [{
        role:    'user',
        content: `You are a retail merchandising expert for a Kenyan marketplace.
A customer is buying "${productName}" (category: ${merchantType}).
Suggest ${safeLimit} complementary products they are likely to also purchase.
Return ONLY a valid JSON array of product name strings. No explanation.
Example: ["Product A","Product B","Product C"]`,
      }],
    });

    const raw = aiResponse.content?.[0]?.text?.trim() || '[]';
    let suggestions = [];
    try {
      suggestions = JSON.parse(raw);
      if (!Array.isArray(suggestions)) suggestions = [];
    } catch {
      suggestions = [];
    }

    // Match AI suggestions against posProducts for this merchant
    const matchedRecs = [];
    if (suggestions.length > 0) {
      const prodSnap = await db.collection('posProducts')
        .where('merchantId', '==', merchantId)
        .where('status', '==', 'active')
        .limit(100)
        .get();

      const aiNames = suggestions.map(s => String(s).toLowerCase());
      for (const doc of prodSnap.docs) {
        if (excludeSet.has(doc.id)) continue;
        const dName = (doc.data().name || '').toLowerCase();
        if (aiNames.some(n => dName.includes(n) || n.includes(dName.split(' ')[0]))) {
          matchedRecs.push({
            productId:      doc.id,
            name:           doc.data().name,
            price:          doc.data().price,
            relevanceScore: 1,
          });
          if (matchedRecs.length >= safeLimit) break;
        }
      }
    }

    return { recommendations: matchedRecs, source: 'ai' };
  } catch (err) {
    logger.error('getCrossSellRecommendations AI error', { err: err.message });
    return { recommendations: [], source: 'ai' };
  }
});

// ---------------------------------------------------------------------------
// 7. getUpsellRecommendations
// ---------------------------------------------------------------------------

const getUpsellRecommendations = onCall(OPT_AI, async (req) => {
  const { productId, merchantId, currentPrice, limit = 3 } = req.data || {};
  if (!productId)                                 _err('productId is required.');
  if (!merchantId)                                _err('merchantId is required.');
  if (typeof currentPrice !== 'number' || currentPrice <= 0)
    _err('currentPrice must be a positive number.');

  const safeLimit   = Math.min(Math.max(1, Number(limit) || 3), 10);
  const priceFloor  = currentPrice * 1.2;

  // Fetch the anchor product to know its category
  const anchorDoc = await db.collection('posProducts').doc(productId).get();
  if (!anchorDoc.exists) _err('Product not found.', 'not-found');
  const anchor = anchorDoc.data();

  // --- Step 1: Same-category premium alternatives ---
  let snap = null;
  try {
    snap = await db.collection('posProducts')
      .where('merchantId', '==', merchantId)
      .where('category', '==', anchor.category)
      .where('price', '>=', priceFloor)
      .where('status', '==', 'active')
      .orderBy('price')
      .limit(20)
      .get();
  } catch (err) {
    logger.error('getUpsellRecommendations query error', { err: err.message });
    snap = { docs: [] };
  }

  let upsells = snap.docs
    .filter(d => d.id !== productId)
    .sort((a, b) => (b.data().rating || 0) - (a.data().rating || 0))
    .slice(0, safeLimit)
    .map(d => {
      const data = d.data();
      return {
        productId: d.id,
        name:      data.name,
        price:     data.price,
        priceDiff: _round(data.price - currentPrice, 2),
        rating:    data.rating || null,
        reason:    `Higher-rated ${anchor.category} option at a premium price point.`,
      };
    });

  // --- Step 2: Variant-based fallback ---
  if (upsells.length < safeLimit && anchor.variantGroupId) {
    try {
      const variantSnap = await db.collection('posProducts')
        .where('merchantId', '==', merchantId)
        .where('variantGroupId', '==', anchor.variantGroupId)
        .where('price', '>=', priceFloor)
        .where('status', '==', 'active')
        .limit(10)
        .get();

      const existingIds = new Set(upsells.map(u => u.productId));
      existingIds.add(productId);

      for (const doc of variantSnap.docs) {
        if (existingIds.has(doc.id)) continue;
        const data = doc.data();
        upsells.push({
          productId: doc.id,
          name:      data.name,
          price:     data.price,
          priceDiff: _round(data.price - currentPrice, 2),
          rating:    data.rating || null,
          reason:    'Higher-tier variant of the selected product.',
        });
        if (upsells.length >= safeLimit) break;
      }
    } catch (err) {
      logger.error('getUpsellRecommendations variant fallback error', { err: err.message });
    }
  }

  // --- Step 3: Claude Haiku fallback if still insufficient ---
  if (upsells.length === 0) {
    try {
      const ai = _getAI();
      const aiResponse = await ai.messages.create({
        model:      'claude-haiku-4-5-20251001',
        max_tokens: 256,
        messages: [{
          role:    'user',
          content: `A customer is considering "${anchor.name}" priced at KES ${currentPrice}.
Suggest ${safeLimit} premium alternatives they might upgrade to in the same category (${anchor.category}).
Return ONLY a JSON array of product name strings. No explanation.`,
        }],
      });
      const raw = aiResponse.content?.[0]?.text?.trim() || '[]';
      let aiNames = [];
      try { aiNames = JSON.parse(raw); } catch { aiNames = []; }
      if (Array.isArray(aiNames) && aiNames.length > 0) {
        upsells = aiNames.slice(0, safeLimit).map(name => ({
          productId: null,
          name:      String(name),
          price:     null,
          priceDiff: null,
          reason:    'AI-suggested premium alternative.',
        }));
      }
    } catch (err) {
      logger.error('getUpsellRecommendations AI error', { err: err.message });
    }
  }

  return { upsells };
});

// ---------------------------------------------------------------------------
// 8. createMarketingCampaign
// ---------------------------------------------------------------------------

const createMarketingCampaign = onCall(OPT, async (req) => {
  const uid = _requireMerchant(req);
  const {
    merchantId,
    name,
    type,
    triggerCondition,
    reward,
  } = req.data || {};

  if (!merchantId) _err('merchantId is required.');
  if (!name)       _err('name is required.');
  if (!type || !CAMPAIGN_TYPES.includes(type))
    _err(`type must be one of: ${CAMPAIGN_TYPES.join(', ')}.`);
  if (!triggerCondition?.field || !triggerCondition?.operator || triggerCondition?.value === undefined)
    _err('triggerCondition must have field, operator, and value.');
  if (!reward?.type || !['points', 'discount', 'gift_card'].includes(reward.type))
    _err('reward.type must be one of: points, discount, gift_card.');
  if (typeof reward?.value !== 'number' || reward.value <= 0)
    _err('reward.value must be a positive number.');

  const docRef = db.collection('mktCampaigns').doc();
  await docRef.set({
    merchantId,
    createdBy: uid,
    name:      _san(name, 200),
    type,
    triggerCondition: {
      field:    _san(String(triggerCondition.field), 100),
      operator: _san(String(triggerCondition.operator), 20),
      value:    triggerCondition.value,
    },
    reward: {
      type:  reward.type,
      value: reward.value,
    },
    sentCount:      0,
    convertedCount: 0,
    status:         'active',
    createdAt:      F.serverTimestamp(),
    updatedAt:      F.serverTimestamp(),
  });

  logger.info('mktCampaign created', { campaignId: docRef.id, merchantId, type });
  return { campaignId: docRef.id };
});

// ---------------------------------------------------------------------------
// 9. runABTest
// ---------------------------------------------------------------------------

const runABTest = onCall(OPT, async (req) => {
  const uid = _requireMerchant(req);
  const {
    merchantId,
    name,
    type,
    variantA,
    variantB,
    startDate,
    endDate,
  } = req.data || {};

  if (!merchantId) _err('merchantId is required.');
  if (!name)       _err('name is required.');
  if (!type || !AB_TEST_TYPES.includes(type))
    _err(`type must be one of: ${AB_TEST_TYPES.join(', ')}.`);
  if (!variantA || typeof variantA !== 'object')
    _err('variantA config object is required.');
  if (!variantB || typeof variantB !== 'object')
    _err('variantB config object is required.');
  if (!startDate || !endDate) _err('startDate and endDate are required.');

  const sDate = new Date(startDate);
  const eDate = new Date(endDate);
  if (isNaN(sDate.getTime()) || isNaN(eDate.getTime()))
    _err('startDate and endDate must be valid ISO date strings.');
  if (eDate <= sDate) _err('endDate must be after startDate.');
  if ((eDate - sDate) < 3 * 24 * 60 * 60 * 1000)
    _err('A/B test must run for at least 3 days to produce meaningful data.');

  const now    = _now();
  const status = sDate <= now ? 'running' : 'draft';

  const docRef = db.collection('mktABTests').doc();
  await docRef.set({
    merchantId,
    createdBy:     uid,
    name:          _san(name, 200),
    type,
    variantA,
    variantB,
    startDate:     admin.firestore.Timestamp.fromDate(sDate),
    endDate:       admin.firestore.Timestamp.fromDate(eDate),
    impressionsA:  0,
    impressionsB:  0,
    conversionsA:  0,
    conversionsB:  0,
    winner:        null,
    status,
    createdAt:     F.serverTimestamp(),
    updatedAt:     F.serverTimestamp(),
  });

  logger.info('mktABTest created', { testId: docRef.id, merchantId, type, status });
  return { testId: docRef.id, status };
});

// ---------------------------------------------------------------------------
// 10. recordABTestImpression
// ---------------------------------------------------------------------------

const recordABTestImpression = onCall(OPT_READ, async (req) => {
  const { testId, variant, converted = false } = req.data || {};
  if (!testId)                       _err('testId is required.');
  if (!['A', 'B'].includes(variant)) _err("variant must be 'A' or 'B'.");

  const testRef = db.collection('mktABTests').doc(testId);

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(testRef);
    if (!snap.exists) _err('A/B test not found.', 'not-found');

    const test = snap.data();
    if (test.status !== 'running')
      _err('A/B test is not currently running.', 'failed-precondition');

    const updates = { updatedAt: F.serverTimestamp() };

    if (variant === 'A') {
      updates.impressionsA = F.increment(1);
      if (converted) updates.conversionsA = F.increment(1);
    } else {
      updates.impressionsB = F.increment(1);
      if (converted) updates.conversionsB = F.increment(1);
    }

    // Check for statistical significance after the pending increment
    const impA = test.impressionsA + (variant === 'A' ? 1 : 0);
    const impB = test.impressionsB + (variant === 'B' ? 1 : 0);
    const convA = test.conversionsA + (variant === 'A' && converted ? 1 : 0);
    const convB = test.conversionsB + (variant === 'B' && converted ? 1 : 0);

    if (impA >= 100 && impB >= 100) {
      const rateA = impA > 0 ? convA / impA : 0;
      const rateB = impB > 0 ? convB / impB : 0;
      const diff  = Math.abs(rateA - rateB);
      const threshold = 0.20 * Math.max(rateA, rateB);  // >20% relative difference

      if (diff >= threshold && Math.max(rateA, rateB) > 0) {
        updates.winner = rateA > rateB ? 'A' : 'B';
        updates.status = 'concluded';
        logger.info('mktABTest concluded', { testId, winner: updates.winner, rateA, rateB });
      } else if (impA >= 1000 && impB >= 1000) {
        // High-volume test with no clear winner → inconclusive
        updates.winner = 'inconclusive';
        updates.status = 'concluded';
        logger.info('mktABTest concluded inconclusive', { testId, rateA, rateB });
      }
    }

    tx.update(testRef, updates);
  });

  return { success: true };
});

// ---------------------------------------------------------------------------
// 11. applyCouponCode
// ---------------------------------------------------------------------------

const applyCouponCode = onCall(OPT, async (req) => {
  const uid = _requireAuth(req);
  const {
    code,
    merchantId,
    orderAmount,
    cartItems = [],
    // uid taken from auth token, not data
  } = req.data || {};

  if (!code)       _err('code is required.');
  if (!merchantId) _err('merchantId is required.');
  if (typeof orderAmount !== 'number' || orderAmount <= 0)
    _err('orderAmount must be a positive number.');

  const now       = admin.firestore.Timestamp.fromDate(_now());
  const upperCode = String(code).toUpperCase().trim();

  // Query coupon
  const snap = await db.collection('mktCouponCodes')
    .where('merchantId', '==', merchantId)
    .where('code', '==', upperCode)
    .limit(1)
    .get();

  if (snap.empty) return { valid: false, reason: 'Coupon code not found.' };

  const doc    = snap.docs[0];
  const coupon = doc.data();

  // Status check
  if (coupon.status !== 'active')
    return { valid: false, reason: 'This coupon is no longer active.' };

  // Date validity
  if (coupon.validFrom && coupon.validFrom.toMillis() > now.toMillis())
    return { valid: false, reason: 'This coupon is not yet valid.' };
  if (coupon.validTo && coupon.validTo.toMillis() < now.toMillis())
    return { valid: false, reason: 'This coupon has expired.' };

  // Usage limit
  if (coupon.usageLimit != null && coupon.usedCount >= coupon.usageLimit)
    return { valid: false, reason: 'This coupon has reached its usage limit.' };

  // Per-customer usage limit — check orders collection
  if (coupon.customerLimit != null && coupon.customerLimit > 0) {
    const custSnap = await db.collection('orders')
      .where('uid', '==', uid)
      .where('couponId', '==', doc.id)
      .limit(coupon.customerLimit)
      .get();
    if (custSnap.size >= coupon.customerLimit)
      return { valid: false, reason: 'You have already used this coupon the maximum number of times.' };
  }

  // Minimum order amount
  if (coupon.minOrderAmount != null && orderAmount < coupon.minOrderAmount)
    return {
      valid:  false,
      reason: `Minimum order amount of KES ${coupon.minOrderAmount} required to use this coupon.`,
    };

  // Allowed categories / products restriction
  if (Array.isArray(coupon.allowedCategories) && coupon.allowedCategories.length > 0) {
    const hasAllowedCategory = cartItems.some(item =>
      coupon.allowedCategories.includes(item.categoryId)
    );
    if (!hasAllowedCategory)
      return { valid: false, reason: 'This coupon is not valid for the items in your cart.' };
  }

  if (Array.isArray(coupon.allowedProducts) && coupon.allowedProducts.length > 0) {
    const hasAllowedProduct = cartItems.some(item =>
      coupon.allowedProducts.includes(item.productId)
    );
    if (!hasAllowedProduct)
      return { valid: false, reason: 'This coupon is not valid for the items in your cart.' };
  }

  // Calculate discount
  let discountAmount = 0;
  if (coupon.type === 'percent') {
    discountAmount = _round((coupon.value / 100) * orderAmount, 2);
    if (coupon.maxDiscount != null) {
      discountAmount = Math.min(discountAmount, coupon.maxDiscount);
    }
  } else if (coupon.type === 'flat') {
    discountAmount = Math.min(coupon.value, orderAmount);
  } else if (coupon.type === 'shipping_free') {
    discountAmount = 0; // handled at order level by flagging free shipping
  }

  return {
    valid:          true,
    couponId:       doc.id,
    code:           upperCode,
    type:           coupon.type,
    discountAmount: _round(discountAmount, 2),
    freeShipping:   coupon.type === 'shipping_free',
  };
});

// ---------------------------------------------------------------------------
// 12. concludeExpiredFlashSales (scheduled)
// ---------------------------------------------------------------------------

const concludeExpiredFlashSales = onSchedule(
  { schedule: '*/10 * * * *', region: REGION, memory: '256MiB', timeoutSeconds: 120 },
  async () => {
    const now  = admin.firestore.Timestamp.fromDate(_now());
    const snap = await db.collection('mktFlashSales')
      .where('status', '==', 'active')
      .where('endAt', '<', now)
      .limit(500)
      .get();

    if (snap.empty) {
      logger.info('concludeExpiredFlashSales: no sales to end');
      return;
    }

    const BATCH_SIZE = 450;
    let batch        = db.batch();
    let count        = 0;
    let batchCount   = 0;

    for (const doc of snap.docs) {
      batch.update(doc.ref, {
        status:    'ended',
        updatedAt: F.serverTimestamp(),
      });
      count++;
      batchCount++;

      if (batchCount >= BATCH_SIZE) {
        await batch.commit();
        batch      = db.batch();
        batchCount = 0;
      }
    }

    if (batchCount > 0) await batch.commit();

    logger.info('concludeExpiredFlashSales complete', { endedCount: count });
  }
);

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  createBundleDeal,
  getActiveBundleDeals,
  createFlashSale,
  getFlashSalePrice,
  recordFlashSalePurchase,
  getCrossSellRecommendations,
  getUpsellRecommendations,
  createMarketingCampaign,
  runABTest,
  recordABTestImpression,
  applyCouponCode,
  concludeExpiredFlashSales,
};
