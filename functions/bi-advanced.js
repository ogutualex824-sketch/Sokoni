/* ================================================================
   SOKONI ADVANCED BUSINESS INTELLIGENCE  v1.0.0
   functions/bi-advanced.js  |  2026-06-29

   Advanced BI module — Branch Comparison and Marketing ROI.
   Provides cross-branch performance analytics, marketing campaign
   ROI attribution, customer segment revenue breakdown, and
   multi-channel revenue analysis for merchant dashboards.

   5 Cloud Functions:
     getMultiBranchRevenue          — revenue comparison across up to 10 branches
     getBranchPerformanceComparison — single-metric drill-down per branch
     getMarketingROI                — campaign / flash-sale / bundle ROI
     getCustomerSegmentRevenue      — tier-based loyalty segment revenue
     getRevenueByChannel            — web / pos / app / whatsapp / delivery split

   Firestore collections read:
     orders               — revenue, channel, promoCode, campaignId
     posProducts          — qty, reorderPoint (inventory health)
     mktCampaigns         — campaign spend estimates
     mktBundleDeals       — bundle usage counts
     mktFlashSales        — flash-sale sold counts
     loyaltyAccounts      — tier assignment per customer

   Region: us-central1  |  Runtime: Node.js 22
   Platform: Firebase Gen2 Cloud Functions
================================================================ */
'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const admin = require('firebase-admin');
const db    = admin.firestore();
const F     = admin.firestore.FieldValue;

/* ── CF Options ──────────────────────────────────────────────── */
const REGION = 'us-central1';
const OPT    = {
  region:          REGION,
  enforceAppCheck: true,
  timeoutSeconds:  120,
  memory:          '256MiB',
};

/* ── Structured logger ───────────────────────────────────────── */
function _log(severity, message, extra = {}) {
  const fn = severity === 'ERROR'   ? console.error
           : severity === 'WARNING' ? console.warn
           : console.log;
  fn(JSON.stringify({ severity, message, service: 'bi-advanced', ...extra }));
}

/* ================================================================
   AUTH GUARDS
================================================================ */

/**
 * Assert caller is authenticated.  Returns uid.
 * @param {object} req  CF v2 request object
 * @returns {string}    uid
 */
function _assertAuth(req) {
  if (!req.auth?.uid) {
    throw new HttpsError('unauthenticated', 'Authentication required.');
  }
  return req.auth.uid;
}

/**
 * Assert caller owns the merchantId or is an admin.
 * Returns uid.
 */
function _assertMerchantOrAdmin(req, merchantId) {
  const uid = _assertAuth(req);
  const isAdmin = req.auth.token?.admin || req.auth.token?.superAdmin;
  /* Merchants may only query their own data */
  if (!isAdmin && uid !== merchantId) {
    throw new HttpsError('permission-denied', 'Access denied — you may only query your own merchant data.');
  }
  return uid;
}

/* ================================================================
   PERIOD UTILITIES
================================================================ */

/**
 * Derive start/end Firestore Timestamps for a named period.
 *
 * @param {'day'|'week'|'month'|'quarter'} period
 * @returns {{ start: Timestamp, end: Timestamp }}
 */
function _periodBounds(period) {
  const now  = new Date();
  let start;

  switch (period) {
    case 'day':
      start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      break;
    case 'week': {
      const d = new Date(now);
      d.setDate(d.getDate() - 6);
      d.setHours(0, 0, 0, 0);
      start = d;
      break;
    }
    case 'month':
      start = new Date(now.getFullYear(), now.getMonth(), 1);
      break;
    case 'quarter': {
      const q = Math.floor(now.getMonth() / 3);
      start   = new Date(now.getFullYear(), q * 3, 1);
      break;
    }
    default:
      start = new Date(now.getFullYear(), now.getMonth(), 1); // fallback: month
  }

  return {
    start: admin.firestore.Timestamp.fromDate(start),
    end:   admin.firestore.Timestamp.fromDate(now),
  };
}

/**
 * Human-readable label for a period.
 * @param {'day'|'week'|'month'|'quarter'} period
 * @returns {string}
 */
function _periodLabel(period) {
  const labels = {
    day:     'Today',
    week:    'Last 7 Days',
    month:   'This Month',
    quarter: 'This Quarter',
  };
  return labels[period] || period;
}

/* ================================================================
   CF: getMultiBranchRevenue
   Revenue comparison across up to 10 branches for a single merchant.

   Input:
     merchantId   string                                 — owner
     branchIds    string[]  (max 10)                     — branch filter
     period       'day'|'week'|'month'|'quarter'         — time window
     compareMode  'absolute'|'percent'                   — value display

   Output:
     { branches:[{branchId,rank,revenue,orderCount,avgOrderValue,share,topProduct}],
       total, period, generatedAt }

   Security: merchant or admin
================================================================ */
const getMultiBranchRevenue = onCall(OPT, async (req) => {
  const {
    merchantId,
    branchIds    = [],
    period       = 'month',
    compareMode  = 'absolute',
  } = req.data || {};

  /* ── Validation ──────────────────────────────────────────── */
  if (!merchantId || typeof merchantId !== 'string') {
    throw new HttpsError('invalid-argument', 'merchantId is required.');
  }
  if (!Array.isArray(branchIds) || branchIds.length === 0) {
    throw new HttpsError('invalid-argument', 'branchIds must be a non-empty array.');
  }
  if (branchIds.length > 10) {
    throw new HttpsError('invalid-argument', 'branchIds may contain at most 10 entries.');
  }
  if (!['day', 'week', 'month', 'quarter'].includes(period)) {
    throw new HttpsError('invalid-argument', 'period must be day | week | month | quarter.');
  }
  if (!['absolute', 'percent'].includes(compareMode)) {
    throw new HttpsError('invalid-argument', 'compareMode must be absolute | percent.');
  }

  _assertMerchantOrAdmin(req, merchantId);

  const { start, end } = _periodBounds(period);

  _log('INFO', '[BI] getMultiBranchRevenue called', { merchantId, period, branchCount: branchIds.length });

  /* ── Query orders per branch concurrently ────────────────── */
  const VALID_STATUSES = ['completed', 'confirmed'];

  const branchResults = await Promise.all(
    branchIds.map(async (branchId) => {
      try {
        const snap = await db.collection('orders')
          .where('merchantId', '==', merchantId)
          .where('branchId',   '==', branchId)
          .where('status',     'in', VALID_STATUSES)
          .where('createdAt',  '>=', start)
          .where('createdAt',  '<=', end)
          .get();

        let revenue        = 0;
        let orderCount     = 0;
        const productTally = {};

        snap.forEach(doc => {
          const d = doc.data();
          revenue    += (d.total || d.totalAmount || d.amountCents / 100 || 0);
          orderCount += 1;

          /* Tally product occurrences for topProduct */
          if (d.items && Array.isArray(d.items)) {
            d.items.forEach(item => {
              const key  = item.productId || item.name || 'unknown';
              const name = item.name || item.productId || 'Unknown';
              productTally[key] = productTally[key] || { name, count: 0, revenue: 0 };
              productTally[key].count   += item.qty || 1;
              productTally[key].revenue += (item.price || 0) * (item.qty || 1);
            });
          }
        });

        const avgOrderValue = orderCount > 0 ? revenue / orderCount : 0;

        /* Find top product by revenue contribution */
        let topProduct = null;
        let maxRev     = 0;
        for (const [, p] of Object.entries(productTally)) {
          if (p.revenue > maxRev) { maxRev = p.revenue; topProduct = p.name; }
        }

        return { branchId, revenue, orderCount, avgOrderValue, topProduct, error: null };
      } catch (err) {
        _log('WARNING', `[BI] Branch query failed for ${branchId}`, { error: err.message });
        return { branchId, revenue: 0, orderCount: 0, avgOrderValue: 0, topProduct: null, error: err.message };
      }
    }),
  );

  /* ── Aggregate totals ────────────────────────────────────── */
  const totalRevenue = branchResults.reduce((s, b) => s + b.revenue, 0);
  const totalOrders  = branchResults.reduce((s, b) => s + b.orderCount, 0);

  /* ── Rank branches by revenue (desc) ────────────────────── */
  const sorted = [...branchResults].sort((a, b) => b.revenue - a.revenue);
  const ranked = sorted.map((branch, idx) => {
    const share = totalRevenue > 0 ? (branch.revenue / totalRevenue) * 100 : 0;
    return {
      branchId:      branch.branchId,
      rank:          idx + 1,
      revenue:       compareMode === 'percent' ? parseFloat(share.toFixed(2)) : Math.round(branch.revenue * 100) / 100,
      revenueKES:    Math.round(branch.revenue * 100) / 100,   // always include raw KES
      orderCount:    branch.orderCount,
      avgOrderValue: Math.round(branch.avgOrderValue * 100) / 100,
      share:         parseFloat(share.toFixed(2)),
      topProduct:    branch.topProduct,
      error:         branch.error,
    };
  });

  return {
    branches:    ranked,
    total: {
      revenue:    Math.round(totalRevenue * 100) / 100,
      orderCount: totalOrders,
      avgOrderValue: totalOrders > 0 ? Math.round((totalRevenue / totalOrders) * 100) / 100 : 0,
    },
    period:      _periodLabel(period),
    compareMode,
    generatedAt: new Date().toISOString(),
  };
});

/* ================================================================
   CF: getBranchPerformanceComparison
   Single-metric focused comparison across branches.

   Input:
     merchantId  string
     branchIds   string[]
     metric      'revenue'|'orders'|'avgOrderValue'|'customerCount'|'inventoryHealth'

   Output:
     { branches:[{branchId,metricValue,rank}], metric, generatedAt }
================================================================ */
const getBranchPerformanceComparison = onCall(OPT, async (req) => {
  const {
    merchantId,
    branchIds = [],
    metric    = 'revenue',
  } = req.data || {};

  /* ── Validation ──────────────────────────────────────────── */
  if (!merchantId || typeof merchantId !== 'string') {
    throw new HttpsError('invalid-argument', 'merchantId is required.');
  }
  if (!Array.isArray(branchIds) || branchIds.length === 0) {
    throw new HttpsError('invalid-argument', 'branchIds must be a non-empty array.');
  }
  if (branchIds.length > 10) {
    throw new HttpsError('invalid-argument', 'branchIds may contain at most 10 entries.');
  }

  const VALID_METRICS = ['revenue', 'orders', 'avgOrderValue', 'customerCount', 'inventoryHealth'];
  if (!VALID_METRICS.includes(metric)) {
    throw new HttpsError('invalid-argument', `metric must be one of: ${VALID_METRICS.join(', ')}.`);
  }

  _assertMerchantOrAdmin(req, merchantId);

  _log('INFO', '[BI] getBranchPerformanceComparison called', { merchantId, metric, branchCount: branchIds.length });

  const { start, end } = _periodBounds('month');

  /* ── inventoryHealth: read posProducts instead of orders ─── */
  if (metric === 'inventoryHealth') {
    const branchMetrics = await Promise.all(
      branchIds.map(async (branchId) => {
        try {
          const snap = await db.collection('posProducts')
            .where('merchantId', '==', merchantId)
            .where('branchId',   '==', branchId)
            .get();

          const total        = snap.size;
          let   lowStockCount = 0;

          snap.forEach(doc => {
            const d = doc.data();
            const qty          = d.qty           ?? d.quantity         ?? 0;
            const reorderPoint = d.reorderPoint  ?? d.reorder_point    ?? 0;
            if (qty <= reorderPoint) lowStockCount++;
          });

          /* inventoryHealth = healthy SKU % */
          const healthPct = total > 0 ? ((total - lowStockCount) / total) * 100 : 100;
          return { branchId, metricValue: parseFloat(healthPct.toFixed(1)), total, lowStockCount, error: null };
        } catch (err) {
          _log('WARNING', `[BI] Inventory check failed for branch ${branchId}`, { error: err.message });
          return { branchId, metricValue: 0, total: 0, lowStockCount: 0, error: err.message };
        }
      }),
    );

    const sorted = [...branchMetrics].sort((a, b) => b.metricValue - a.metricValue);
    return {
      branches:    sorted.map((b, i) => ({ ...b, rank: i + 1 })),
      metric,
      unit:        '% healthy SKUs',
      generatedAt: new Date().toISOString(),
    };
  }

  /* ── Order-based metrics ─────────────────────────────────── */
  const branchMetrics = await Promise.all(
    branchIds.map(async (branchId) => {
      try {
        const snap = await db.collection('orders')
          .where('merchantId', '==', merchantId)
          .where('branchId',   '==', branchId)
          .where('status',     'in', ['completed', 'confirmed'])
          .where('createdAt',  '>=', start)
          .where('createdAt',  '<=', end)
          .get();

        let revenue      = 0;
        let orderCount   = 0;
        const uniqueUIDs = new Set();

        snap.forEach(doc => {
          const d = doc.data();
          revenue    += (d.total || d.totalAmount || d.amountCents / 100 || 0);
          orderCount += 1;
          if (d.uid)       uniqueUIDs.add(d.uid);
          if (d.customerId) uniqueUIDs.add(d.customerId);
        });

        let metricValue;
        switch (metric) {
          case 'revenue':        metricValue = Math.round(revenue * 100) / 100; break;
          case 'orders':         metricValue = orderCount; break;
          case 'avgOrderValue':  metricValue = orderCount > 0 ? Math.round((revenue / orderCount) * 100) / 100 : 0; break;
          case 'customerCount':  metricValue = uniqueUIDs.size; break;
          default:               metricValue = 0;
        }

        return { branchId, metricValue, error: null };
      } catch (err) {
        _log('WARNING', `[BI] Order metric query failed for branch ${branchId}`, { error: err.message });
        return { branchId, metricValue: 0, error: err.message };
      }
    }),
  );

  const units = { revenue: 'KES', orders: 'orders', avgOrderValue: 'KES', customerCount: 'customers' };
  const sorted = [...branchMetrics].sort((a, b) => b.metricValue - a.metricValue);

  return {
    branches:    sorted.map((b, i) => ({ ...b, rank: i + 1 })),
    metric,
    unit:        units[metric] || '',
    period:      _periodLabel('month'),
    generatedAt: new Date().toISOString(),
  };
});

/* ================================================================
   CF: getMarketingROI
   Campaign / flash-sale / bundle ROI attribution.

   Input:
     merchantId  string
     startDate   ISO string   — query window start
     endDate     ISO string   — query window end

   Output:
     { totalROI, totalRevenue, totalCost, campaigns:[], flashSales:[], bundles:[], period }
================================================================ */
const getMarketingROI = onCall(OPT, async (req) => {
  const { merchantId, startDate, endDate } = req.data || {};

  /* ── Validation ──────────────────────────────────────────── */
  if (!merchantId || typeof merchantId !== 'string') {
    throw new HttpsError('invalid-argument', 'merchantId is required.');
  }
  if (!startDate || !endDate) {
    throw new HttpsError('invalid-argument', 'startDate and endDate are required ISO strings.');
  }

  const startMs = Date.parse(startDate);
  const endMs   = Date.parse(endDate);
  if (isNaN(startMs) || isNaN(endMs)) {
    throw new HttpsError('invalid-argument', 'startDate and endDate must be valid ISO date strings.');
  }
  if (endMs <= startMs) {
    throw new HttpsError('invalid-argument', 'endDate must be after startDate.');
  }
  /* Safety: cap max window at 365 days */
  if (endMs - startMs > 365 * 24 * 60 * 60 * 1000) {
    throw new HttpsError('invalid-argument', 'Date range may not exceed 365 days.');
  }

  _assertMerchantOrAdmin(req, merchantId);

  const tsStart = admin.firestore.Timestamp.fromMillis(startMs);
  const tsEnd   = admin.firestore.Timestamp.fromMillis(endMs);

  _log('INFO', '[BI] getMarketingROI called', { merchantId, startDate, endDate });

  const DEFAULT_CAMPAIGN_COST_KES = 5000;

  /* ── Query campaigns ─────────────────────────────────────── */
  const [campaignsSnap, flashSalesSnap, bundlesSnap] = await Promise.all([
    db.collection('mktCampaigns')
      .where('merchantId', '==', merchantId)
      .where('createdAt',  '>=', tsStart)
      .where('createdAt',  '<=', tsEnd)
      .get()
      .catch(() => ({ docs: [] })),
    db.collection('mktFlashSales')
      .where('merchantId', '==', merchantId)
      .where('createdAt',  '>=', tsStart)
      .where('createdAt',  '<=', tsEnd)
      .get()
      .catch(() => ({ docs: [] })),
    db.collection('mktBundleDeals')
      .where('merchantId', '==', merchantId)
      .where('createdAt',  '>=', tsStart)
      .where('createdAt',  '<=', tsEnd)
      .get()
      .catch(() => ({ docs: [] })),
  ]);

  /* ── Query campaign-attributed orders ────────────────────── */
  let attributedOrdersSnap = { docs: [] };
  try {
    attributedOrdersSnap = await db.collection('orders')
      .where('merchantId', '==', merchantId)
      .where('status',     'in', ['completed', 'confirmed'])
      .where('createdAt',  '>=', tsStart)
      .where('createdAt',  '<=', tsEnd)
      .where('campaignId', '!=', null)
      .get();
  } catch (_) {
    /* campaignId index may not exist; attempt promo-code fallback below */
    try {
      attributedOrdersSnap = await db.collection('orders')
        .where('merchantId', '==', merchantId)
        .where('status',     'in', ['completed', 'confirmed'])
        .where('createdAt',  '>=', tsStart)
        .where('createdAt',  '<=', tsEnd)
        .get();
      /* Filter in-memory */
      const attributed = attributedOrdersSnap.docs.filter(d => {
        const o = d.data();
        return o.campaignId || o.promoCode;
      });
      attributedOrdersSnap = { docs: attributed };
    } catch (fallbackErr) {
      _log('WARNING', '[BI] Could not query attributed orders', { error: fallbackErr.message });
    }
  }

  /* Build campaign revenue map from attributed orders */
  const campaignRevenueMap = {};
  attributedOrdersSnap.docs.forEach(doc => {
    const o          = doc.data();
    const campaignId = o.campaignId || o.promoCode || 'unknown';
    campaignRevenueMap[campaignId] = (campaignRevenueMap[campaignId] || 0) +
      (o.total || o.totalAmount || (o.amountCents || 0) / 100 || 0);
  });

  /* ── Build campaign breakdown ────────────────────────────── */
  const campaigns = campaignsSnap.docs.map(doc => {
    const c              = doc.data();
    const id             = doc.id;
    const estimatedCost  = c.estimatedBudget || c.budget || DEFAULT_CAMPAIGN_COST_KES;
    const rev            = campaignRevenueMap[id] || campaignRevenueMap[c.name] || 0;
    const roi            = estimatedCost > 0 ? ((rev - estimatedCost) / estimatedCost) * 100 : 0;
    return {
      campaignId:     id,
      name:           c.name || c.title || 'Unnamed Campaign',
      type:           c.type || c.campaignType || 'general',
      ordersGenerated: 0, /* aggregated below if matched */
      revenueGenerated: Math.round(rev * 100) / 100,
      estimatedCost:  Math.round(estimatedCost * 100) / 100,
      roi:            parseFloat(roi.toFixed(2)),
    };
  });

  /* Attach order counts to campaigns */
  attributedOrdersSnap.docs.forEach(doc => {
    const o          = doc.data();
    const campaignId = o.campaignId || o.promoCode;
    const campaign   = campaigns.find(c => c.campaignId === campaignId || c.name === campaignId);
    if (campaign) campaign.ordersGenerated++;
  });

  /* ── Flash sales ROI ─────────────────────────────────────── */
  const flashSales = flashSalesSnap.docs.map(doc => {
    const fs            = doc.data();
    const soldCount     = fs.soldCount || fs.unitsSold || 0;
    const discountedRev = soldCount * (fs.salePrice || fs.discountedPrice || 0);
    const originalRev   = soldCount * (fs.originalPrice || fs.salePrice || 0);
    const estimatedCost = (originalRev - discountedRev) > 0 ? originalRev - discountedRev : DEFAULT_CAMPAIGN_COST_KES;
    const roi           = estimatedCost > 0 ? ((discountedRev - estimatedCost) / estimatedCost) * 100 : 0;
    return {
      flashSaleId:       doc.id,
      name:              fs.name || fs.title || 'Flash Sale',
      soldCount,
      discountedRevenue: Math.round(discountedRev * 100) / 100,
      estimatedCost:     Math.round(estimatedCost * 100) / 100,
      roi:               parseFloat(roi.toFixed(2)),
    };
  });

  /* ── Bundle deals ROI ────────────────────────────────────── */
  const bundles = bundlesSnap.docs.map(doc => {
    const bd           = doc.data();
    const usageCount   = bd.usageCount || bd.redemptions || 0;
    const bundleRev    = usageCount * (bd.bundlePrice || bd.price || 0);
    const estimatedCost = DEFAULT_CAMPAIGN_COST_KES;
    const roi           = estimatedCost > 0 ? ((bundleRev - estimatedCost) / estimatedCost) * 100 : 0;
    return {
      bundleId:     doc.id,
      name:         bd.name || bd.title || 'Bundle Deal',
      usageCount,
      revenueGenerated: Math.round(bundleRev * 100) / 100,
      estimatedCost:   Math.round(estimatedCost * 100) / 100,
      roi:             parseFloat(roi.toFixed(2)),
    };
  });

  /* ── Aggregate totals ────────────────────────────────────── */
  const totalRevenue = [
    ...campaigns.map(c => c.revenueGenerated),
    ...flashSales.map(fs => fs.discountedRevenue),
    ...bundles.map(b => b.revenueGenerated),
  ].reduce((s, v) => s + v, 0);

  const totalCost = [
    ...campaigns.map(c => c.estimatedCost),
    ...flashSales.map(fs => fs.estimatedCost),
    ...bundles.map(b => b.estimatedCost),
  ].reduce((s, v) => s + v, 0);

  const totalROI = totalCost > 0 ? ((totalRevenue - totalCost) / totalCost) * 100 : 0;

  return {
    totalROI:     parseFloat(totalROI.toFixed(2)),
    totalRevenue: Math.round(totalRevenue * 100) / 100,
    totalCost:    Math.round(totalCost * 100) / 100,
    campaigns,
    flashSales,
    bundles,
    period: { startDate, endDate },
    generatedAt: new Date().toISOString(),
  };
});

/* ================================================================
   CF: getCustomerSegmentRevenue
   Revenue breakdown by loyalty tier for a merchant.

   Input:
     merchantId  string
     period      'month'|'quarter'

   Output:
     { segments:[{tier,memberCount,revenue,avgRevenue,share}], total }
================================================================ */
const getCustomerSegmentRevenue = onCall(OPT, async (req) => {
  const {
    merchantId,
    period = 'month',
  } = req.data || {};

  /* ── Validation ──────────────────────────────────────────── */
  if (!merchantId || typeof merchantId !== 'string') {
    throw new HttpsError('invalid-argument', 'merchantId is required.');
  }
  if (!['month', 'quarter'].includes(period)) {
    throw new HttpsError('invalid-argument', 'period must be month | quarter.');
  }

  _assertMerchantOrAdmin(req, merchantId);

  _log('INFO', '[BI] getCustomerSegmentRevenue called', { merchantId, period });

  const { start, end } = _periodBounds(period);

  const TIERS = ['Bronze', 'Silver', 'Gold', 'Platinum', 'Diamond'];

  /* ── Fetch loyalty accounts for merchant's customers ─────── */
  let loyaltySnap = { docs: [] };
  try {
    loyaltySnap = await db.collection('loyaltyAccounts')
      .where('merchantId', '==', merchantId)
      .get();
  } catch (err) {
    _log('WARNING', '[BI] Could not query loyaltyAccounts', { error: err.message });
  }

  /* Map uid → tier */
  const uidTierMap = {};
  loyaltySnap.docs.forEach(doc => {
    const la  = doc.data();
    const uid = la.uid || la.userId || doc.id;
    const tier = la.tier || la.loyaltyTier || 'Bronze';
    uidTierMap[uid] = tier;
  });

  /* ── Query orders for the period ────────────────────────────
     Query in batches if needed (Firestore 'in' array limit = 30) */
  let ordersSnap = { docs: [] };
  try {
    ordersSnap = await db.collection('orders')
      .where('merchantId', '==', merchantId)
      .where('status',     'in', ['completed', 'confirmed'])
      .where('createdAt',  '>=', start)
      .where('createdAt',  '<=', end)
      .get();
  } catch (err) {
    _log('WARNING', '[BI] Could not query orders for customer segments', { error: err.message });
  }

  /* Aggregate revenue per tier */
  const tierData = {};
  TIERS.forEach(t => { tierData[t] = { tier: t, memberCount: 0, revenue: 0, uids: new Set() }; });

  /* Count distinct members per tier from loyalty accounts */
  Object.entries(uidTierMap).forEach(([uid, tier]) => {
    const t = TIERS.includes(tier) ? tier : 'Bronze';
    tierData[t].uids.add(uid);
  });

  /* Sum order revenue per tier */
  ordersSnap.docs.forEach(doc => {
    const o    = doc.data();
    const uid  = o.uid || o.customerId || o.userId;
    const tier = uid ? (uidTierMap[uid] || 'Bronze') : 'Bronze';
    const t    = TIERS.includes(tier) ? tier : 'Bronze';
    tierData[t].revenue += (o.total || o.totalAmount || (o.amountCents || 0) / 100 || 0);
  });

  const totalRevenue = Object.values(tierData).reduce((s, t) => s + t.revenue, 0);

  const segments = TIERS.map(tier => {
    const t           = tierData[tier];
    const memberCount = t.uids.size;
    const revenue     = Math.round(t.revenue * 100) / 100;
    const avgRevenue  = memberCount > 0 ? Math.round((t.revenue / memberCount) * 100) / 100 : 0;
    const share       = totalRevenue > 0 ? parseFloat(((t.revenue / totalRevenue) * 100).toFixed(2)) : 0;
    return { tier, memberCount, revenue, avgRevenue, share };
  });

  return {
    segments,
    total: {
      revenue:     Math.round(totalRevenue * 100) / 100,
      memberCount: Object.values(tierData).reduce((s, t) => s + t.uids.size, 0),
    },
    period: _periodLabel(period),
    generatedAt: new Date().toISOString(),
  };
});

/* ================================================================
   CF: getRevenueByChannel
   Revenue breakdown by order channel (web, pos, app, whatsapp, delivery).

   Input:
     merchantId  string
     period      'day'|'week'|'month'

   Output:
     { channels:[{channel,revenue,orders,share}], generatedAt }
================================================================ */
const getRevenueByChannel = onCall(OPT, async (req) => {
  const {
    merchantId,
    period = 'month',
  } = req.data || {};

  /* ── Validation ──────────────────────────────────────────── */
  if (!merchantId || typeof merchantId !== 'string') {
    throw new HttpsError('invalid-argument', 'merchantId is required.');
  }
  if (!['day', 'week', 'month'].includes(period)) {
    throw new HttpsError('invalid-argument', 'period must be day | week | month.');
  }

  _assertMerchantOrAdmin(req, merchantId);

  _log('INFO', '[BI] getRevenueByChannel called', { merchantId, period });

  const { start, end } = _periodBounds(period);

  const CHANNELS = ['web', 'pos', 'app', 'whatsapp', 'delivery'];

  /* ── Query all completed orders for the period ───────────── */
  let ordersSnap = { docs: [] };
  try {
    ordersSnap = await db.collection('orders')
      .where('merchantId', '==', merchantId)
      .where('status',     'in', ['completed', 'confirmed'])
      .where('createdAt',  '>=', start)
      .where('createdAt',  '<=', end)
      .get();
  } catch (err) {
    _log('WARNING', '[BI] Could not query orders for channel breakdown', { error: err.message });
    throw new HttpsError('internal', `Failed to retrieve orders: ${err.message}`);
  }

  /* Aggregate by channel */
  const channelData = {};
  CHANNELS.forEach(c => { channelData[c] = { channel: c, revenue: 0, orders: 0 }; });
  channelData['other'] = { channel: 'other', revenue: 0, orders: 0 };

  ordersSnap.docs.forEach(doc => {
    const o       = doc.data();
    const channel = (o.channel || o.orderChannel || o.source || 'web').toLowerCase();
    const key     = CHANNELS.includes(channel) ? channel : 'other';
    channelData[key].revenue += (o.total || o.totalAmount || (o.amountCents || 0) / 100 || 0);
    channelData[key].orders  += 1;
  });

  const totalRevenue = Object.values(channelData).reduce((s, c) => s + c.revenue, 0);

  const channels = Object.values(channelData)
    .map(c => ({
      channel: c.channel,
      revenue: Math.round(c.revenue * 100) / 100,
      orders:  c.orders,
      share:   totalRevenue > 0 ? parseFloat(((c.revenue / totalRevenue) * 100).toFixed(2)) : 0,
    }))
    .filter(c => c.orders > 0)
    .sort((a, b) => b.revenue - a.revenue);

  return {
    channels,
    total: {
      revenue: Math.round(totalRevenue * 100) / 100,
      orders:  ordersSnap.docs.length,
    },
    period:      _periodLabel(period),
    generatedAt: new Date().toISOString(),
  };
});

/* ================================================================
   MODULE EXPORTS
   5 Cloud Functions, all using OPT (enforceAppCheck: true,
   region: us-central1).
================================================================ */
module.exports = {
  getMultiBranchRevenue,
  getBranchPerformanceComparison,
  getMarketingROI,
  getCustomerSegmentRevenue,
  getRevenueByChannel,
};
