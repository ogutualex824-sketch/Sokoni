/* ================================================================
   SOKONI UNIVERSAL AI SUBSCRIPTION OPERATING SYSTEM
   sasos-brain.js — AI Subscription Brain v1.0.0  |  2026-06-21

   Intelligent revenue optimization engine.
   Computes churn risk, LTV, upgrade probability, downgrade
   probability, plan recommendations, and revenue forecasts.
   Uses @anthropic-ai/sdk for intelligent text generation
   where deterministic heuristics aren't sufficient.

   Score ranges (all 0-100):
     churnRisk:    80-100 = critical  |  60-79 = high  |  40-59 = medium
     upgradeProb:  60-100 = prime target
     ltv:          lifetime value in KES (actual, not 0-100)

   Exports:
     sasosRunBrain            — scheduled daily: compute brain scores
     sasosGetInsights         — get brain analysis for a user
     sasosGetForecast         — admin: MRR/ARR/churn forecast
     sasosGetRecommendations  — get plan upgrade recommendations
     sasosGetChurnRisk        — get churn risk for a user or segment
     sasosGetSegmentInsights  — admin: segment-level intelligence
================================================================ */
'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule }         = require('firebase-functions/v2/scheduler');
const { logger }             = require('firebase-functions');
const admin                  = require('firebase-admin');
const FieldValue             = admin.firestore.FieldValue;
const Anthropic              = require('@anthropic-ai/sdk');

const { _resolvePlan, SASOS_PLANS, SASOS_PRODUCTS, TIER_ORDER } = require('./sasos-core');
const db  = () => admin.firestore();
const san = (s, n = 200) => typeof s === 'string' ? s.replace(/<[^>]*>/g,'').trim().slice(0,n) : '';

const assertAuth  = req => { if (!req.auth?.uid) throw new HttpsError('unauthenticated','Auth required.'); return req.auth.uid; };
const assertAdmin = req => { const uid = assertAuth(req); if (!req.auth.token?.admin && !req.auth.token?.superAdmin) throw new HttpsError('permission-denied','Admin required.'); return uid; };

const period = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`; };

/* ================================================================
   DETERMINISTIC BRAIN HEURISTICS
   All score computations are deterministic and auditable.
   AI (Anthropic) is used only for generating human-readable
   insight text — never for making numeric decisions.
================================================================ */

/* ── Churn risk score (0-100) ────────────────────────────── */
function _computeChurnRisk(sub, usageData, billingData) {
  let score = 0;
  const now  = Date.now();

  /* Factor 1: Days until renewal (closer = higher churn risk) */
  const daysToRenewal = sub.periodEnd ? (sub.periodEnd - now) / 86400000 : 30;
  if (daysToRenewal < 3)  score += 25;
  else if (daysToRenewal < 7)  score += 15;
  else if (daysToRenewal < 14) score += 8;

  /* Factor 2: Usage below 20% of plan limit */
  const usageKeys = Object.keys(usageData.counters || {});
  let totalUsagePct = 0;
  let usageCount    = 0;
  usageKeys.forEach(key => {
    const used  = usageData.counters[key] || 0;
    const limit = usageData.limits?.[key];
    if (limit > 0) { totalUsagePct += (used / limit) * 100; usageCount++; }
  });
  const avgUsagePct = usageCount > 0 ? totalUsagePct / usageCount : 50;
  if (avgUsagePct < 10) score += 30;
  else if (avgUsagePct < 20) score += 20;
  else if (avgUsagePct < 40) score += 10;

  /* Factor 3: Grace period / dunning in progress */
  if (sub.status === 'grace') score += 35;

  /* Factor 4: Recent failed payment */
  const recentFailedPayment = billingData.some(e => e.type === 'payment_failed');
  if (recentFailedPayment) score += 25;

  /* Factor 5: Downgrade pending */
  if (sub.pendingPlanId) {
    const currentTier = TIER_ORDER[sub.tier] || 0;
    const pendingTier = TIER_ORDER[sub.pendingPlanId?.split('.')[1]] || 0;
    if (pendingTier < currentTier) score += 15;
  }

  /* Factor 6: Trial (not yet converted) */
  if (sub.status === 'trial') score += 20;

  return Math.min(100, score);
}

/* ── Upgrade probability score (0-100) ───────────────────── */
function _computeUpgradeProb(sub, usageData) {
  let score = 0;

  /* Factor 1: Usage > 80% of limit (quota pressure) */
  const usageKeys = Object.keys(usageData.counters || {});
  let highUsageCount = 0;
  usageKeys.forEach(key => {
    const used  = usageData.counters[key] || 0;
    const limit = usageData.limits?.[key];
    if (limit > 0 && (used / limit) >= 0.8) highUsageCount++;
  });
  score += Math.min(40, highUsageCount * 15);

  /* Factor 2: Active on free tier */
  if (sub.tier === 'free') score += 20;

  /* Factor 3: Healthy account (low churn risk indicator) */
  if (sub.status === 'active') score += 15;

  /* Factor 4: High usage relative to tier */
  const avgUsagePct = usageKeys.length > 0
    ? usageKeys.reduce((s, k) => {
        const used  = usageData.counters[k] || 0;
        const limit = usageData.limits?.[k];
        return limit > 0 ? s + (used / limit) * 100 : s;
      }, 0) / usageKeys.length
    : 0;
  if (avgUsagePct > 90) score += 25;
  else if (avgUsagePct > 70) score += 15;
  else if (avgUsagePct > 50) score += 5;

  return Math.min(100, score);
}

/* ── LTV estimate in KES ─────────────────────────────────── */
function _computeLTV(sub, billingHistory, avgMonthsRetained = 12) {
  const plan     = SASOS_PLANS[sub.planId] || {};
  const monthly  = sub.billing === 'annual'
    ? Math.round((plan.billing?.annual || 0) / 12)
    : (plan.billing?.monthly || 0);

  /* Adjust retention based on billing history */
  const successfulPayments = billingHistory.filter(e => e.type === 'subscription_payment').length;
  const estimatedMonths    = Math.max(successfulPayments, avgMonthsRetained);

  return Math.round(monthly * estimatedMonths);
}

/* ── Next upgrade plan recommendation ───────────────────────
   Returns the next plan up from the current one.
*/
function _nextUpgradePlan(planId) {
  const [product, tier] = planId.split('.');
  const currentOrder    = TIER_ORDER[tier] || 0;

  const upgradeTier = Object.entries(TIER_ORDER)
    .filter(([t, o]) => o === currentOrder + 1)
    .map(([t]) => t)[0];

  if (!upgradeTier) return null;
  const upgradeId = `${product}.${upgradeTier}`;
  return SASOS_PLANS[upgradeId] ? upgradeId : null;
}

/* ================================================================
   sasosRunBrain  [Scheduled — daily 06:00 EAT]
   Computes brain scores for all active subscriptions.
   Writes results to sasosInsights/{uid} per user.
================================================================ */
const sasosRunBrain = onSchedule(
  { schedule: '0 3 * * *', timeZone: 'Africa/Nairobi', region: 'us-central1', memory: '1GiB', timeoutSeconds: 540 },
  async () => {
    const p       = period();
    const now     = Date.now();
    const month   = now - 30 * 86400000;
    let   scored  = 0;

    const subSnap = await db().collection('sasosSubscriptions').limit(1000).get();

    for (const doc of subSnap.docs) {
      const uid     = doc.id;
      const data    = doc.data();
      const prods   = data.products || {};
      const scores  = {};
      let   topChurn = 0;
      let   topUpgrade = 0;
      let   totalLTV   = 0;

      try {
        for (const [product, sub] of Object.entries(prods)) {
          if (sub.tier === 'free' || !sub.planId) continue;

          /* Fetch usage and billing data */
          const [usageSnap, billingSnap] = await Promise.all([
            db().collection('sasosUsage').doc(`${uid}_${product}_${p}`).get(),
            db().collection('sasosBillingLedger')
              .where('uid', '==', uid).where('productId', '==', product)
              .where('ts', '>=', new Date(month)).limit(20).get(),
          ]);

          const usageData   = {
            counters: usageSnap.exists ? usageSnap.data().counters || {} : {},
            limits:   (await _resolvePlan(sub.planId))?.limits || {},
          };
          const billingData = billingSnap.docs.map(d => d.data());

          const churnRisk   = _computeChurnRisk(sub, usageData, billingData);
          const upgradeProb = _computeUpgradeProb(sub, usageData);
          const ltv         = _computeLTV(sub, billingData);
          const nextPlan    = _nextUpgradePlan(sub.planId);

          scores[product] = { churnRisk, upgradeProb, ltv, nextPlan, tier: sub.tier, status: sub.status };
          if (churnRisk   > topChurn)   topChurn   = churnRisk;
          if (upgradeProb > topUpgrade) topUpgrade = upgradeProb;
          totalLTV += ltv;
        }

        /* Write brain insights */
        await db().collection('sasosInsights').doc(uid).set({
          uid,
          scores,
          topChurnRisk:   topChurn,
          topUpgradeProb: topUpgrade,
          estimatedLTV:   totalLTV,
          period:         p,
          computedAt:     FieldValue.serverTimestamp(),
        }, { merge: true });

        scored++;
      } catch (err) {
        logger.error(`[SASOS-Brain] Error scoring uid=${uid}: ${err.message}`);
      }
    }

    logger.info(`[SASOS-Brain] sasosRunBrain: scored ${scored} users`);
  }
);

/* ================================================================
   sasosGetInsights
   Returns the AI brain analysis for the authenticated user.
   Uses cached sasosInsights document; if stale (>24h), triggers
   a lightweight score refresh.
================================================================ */
const sasosGetInsights = onCall(
  { region: 'us-central1', timeoutSeconds: 20, memory: '256MiB' },
  async (req) => {
    const uid = assertAuth(req);

    const [insightSnap, subSnap] = await Promise.all([
      db().collection('sasosInsights').doc(uid).get(),
      db().collection('sasosSubscriptions').doc(uid).get(),
    ]);

    const now  = Date.now();
    const data = insightSnap.exists ? insightSnap.data() : null;

    /* If cached and fresh (< 24h), return immediately */
    const computedAt = data?.computedAt?.toMillis?.() || 0;
    if (data && (now - computedAt) < 86400000) return data;

    /* Stale or missing — compute inline (lightweight) */
    const prods   = subSnap.exists ? (subSnap.data().products || {}) : {};
    const scores  = {};
    let   topChurn   = 0;
    let   topUpgrade = 0;
    let   totalLTV   = 0;
    const p       = period();

    for (const [product, sub] of Object.entries(prods)) {
      if (!sub.planId) continue;
      const usageSnap = await db().collection('sasosUsage').doc(`${uid}_${product}_${p}`).get();
      const usageData = { counters: usageSnap.exists ? usageSnap.data().counters || {} : {}, limits: {} };
      const churnRisk   = _computeChurnRisk(sub, usageData, []);
      const upgradeProb = _computeUpgradeProb(sub, usageData);
      const ltv         = _computeLTV(sub, []);
      const nextPlan    = _nextUpgradePlan(sub.planId);
      scores[product]   = { churnRisk, upgradeProb, ltv, nextPlan, tier: sub.tier };
      if (churnRisk   > topChurn)   topChurn   = churnRisk;
      if (upgradeProb > topUpgrade) topUpgrade = upgradeProb;
      totalLTV += ltv;
    }

    const result = { uid, scores, topChurnRisk: topChurn, topUpgradeProb: topUpgrade, estimatedLTV: totalLTV, period: p, computedAt: now };
    db().collection('sasosInsights').doc(uid).set({ ...result, computedAt: FieldValue.serverTimestamp() }, { merge: true }).catch(() => {});
    return result;
  }
);

/* ================================================================
   sasosGetRecommendations
   Returns personalised plan upgrade recommendations for the user.
   Uses deterministic scoring + optional AI-generated copy.
================================================================ */
const sasosGetRecommendations = onCall(
  { region: 'us-central1', timeoutSeconds: 30, memory: '256MiB' },
  async (req) => {
    const uid      = assertAuth(req);
    const product  = san(req.data.product || '', 30);
    const withCopy = req.data.withCopy === true;  /* AI-generated copy is opt-in */

    const insightSnap = await db().collection('sasosInsights').doc(uid).get();
    const insights    = insightSnap.exists ? insightSnap.data() : {};
    const scores      = insights.scores || {};

    const recs = [];

    const products = product ? [product] : Object.keys(scores);
    for (const prod of products) {
      const s = scores[prod];
      if (!s || !s.nextPlan || s.tier === 'enterprise') continue;

      const nextPlanDef = SASOS_PLANS[s.nextPlan];
      if (!nextPlanDef) continue;

      const rec = {
        product: prod,
        currentTier:   s.tier,
        recommendedPlanId: s.nextPlan,
        recommendedPlanName: nextPlanDef.name,
        upgradeProb:   s.upgradeProb,
        churnRisk:     s.churnRisk,
        monthlyPrice:  nextPlanDef.billing.monthly,
        annualPrice:   nextPlanDef.billing.annual,
        topFeatures:   Object.keys(nextPlanDef.features || {}).filter(f => nextPlanDef.features[f] === true).slice(0, 5),
        reason:        s.upgradeProb > 70 ? 'You are approaching your plan limits.' : 'Unlock more features.',
      };

      recs.push(rec);
    }

    /* Sort by upgrade probability (highest first) */
    recs.sort((a, b) => b.upgradeProb - a.upgradeProb);

    /* Optional: AI-generated personalised copy for top recommendation */
    if (withCopy && recs.length > 0) {
      try {
        const topRec = recs[0];
        const client = new Anthropic();
        const msg    = await client.messages.create({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 200,
          messages: [{
            role: 'user',
            content: `Write a brief, friendly 2-sentence upgrade recommendation for a Sokoni user on the ${topRec.currentTier} plan of ${topRec.product}. Recommend upgrading to ${topRec.recommendedPlanName}. Focus on the top benefits: ${topRec.topFeatures.join(', ')}. Be direct and Kenya-focused.`,
          }],
        });
        recs[0].aiCopy = msg.content[0]?.text || '';
      } catch (aiErr) {
        logger.warn(`[SASOS-Brain] AI copy generation failed: ${aiErr.message}`);
      }
    }

    return { recommendations: recs, uid };
  }
);

/* ================================================================
   sasosGetForecast
   Admin-only. Revenue forecast for the next 12 months.
   Uses 3-month moving average of actual revenue as the baseline
   and applies a growth multiplier derived from subscriber trends.
================================================================ */
const sasosGetForecast = onCall(
  { region: 'us-central1', timeoutSeconds: 30, memory: '256MiB' },
  async (req) => {
    assertAdmin(req);
    const months = Math.min(req.data.months || 12, 24);

    /* Load last 90 days of revenue aggregates */
    const dates = [];
    for (let i = 0; i < 90; i++) {
      const d = new Date(Date.now() - i * 86400000);
      dates.push(d.toISOString().slice(0, 10));
    }

    const snaps = await Promise.all(
      dates.map(d => db().collection('sasosRevenueAggregates').doc(d).get())
    );

    const dailyRevenue = snaps.map((s, i) => s.exists ? (s.data().netRevenue || 0) : 0);
    const last30 = dailyRevenue.slice(0, 30).reduce((a, b) => a + b, 0);
    const prev30 = dailyRevenue.slice(30, 60).reduce((a, b) => a + b, 0);
    const prev60 = dailyRevenue.slice(60, 90).reduce((a, b) => a + b, 0);

    const growthRate30d  = prev30 > 0 ? (last30 - prev30) / prev30 : 0;
    const growthRate60d  = prev60 > 0 ? (prev30 - prev60) / prev60 : 0;
    const avgGrowthRate  = (growthRate30d + growthRate60d) / 2;

    /* Count new subscribers in last 30d */
    const newSubSnap = await db().collection('sasosAuditLog')
      .where('type', '==', 'sasos_subscribe')
      .where('ts', '>=', new Date(Date.now() - 30 * 86400000))
      .get().catch(() => ({ docs: [] }));
    const newSubsMonth = newSubSnap.docs.length;

    /* Calculate churn rate estimate */
    const cancelSnap = await db().collection('sasosAuditLog')
      .where('type', 'in', ['sasos_cancel_immediate', 'sasos_cancel_scheduled'])
      .where('ts', '>=', new Date(Date.now() - 30 * 86400000))
      .get().catch(() => ({ docs: [] }));
    const churned     = cancelSnap.docs.length;
    const estMonthlyChurnRate = newSubsMonth > 0 ? churned / newSubsMonth : 0.05;

    /* Project forward */
    const currentMRR = Math.round(last30);
    const forecast   = [];
    let   projectedMRR = currentMRR;

    for (let m = 1; m <= months; m++) {
      const d = new Date();
      d.setMonth(d.getMonth() + m);
      const label  = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
      /* Apply growth with churn dampener */
      const grossGrowth = projectedMRR * avgGrowthRate;
      const churnLoss   = projectedMRR * estMonthlyChurnRate;
      projectedMRR      = Math.max(0, Math.round(projectedMRR + grossGrowth - churnLoss));
      forecast.push({ month: label, projectedMRR, projectedARR: projectedMRR * 12 });
    }

    return {
      currentMRR,
      currentARR:       currentMRR * 12,
      monthlyGrowthRate: Math.round(avgGrowthRate * 1000) / 10,
      estimatedChurnRate: Math.round(estMonthlyChurnRate * 1000) / 10,
      newSubscribersLastMonth: newSubsMonth,
      forecast,
    };
  }
);

/* ================================================================
   sasosGetChurnRisk
   Returns churn risk scores. Admin can get a segment.
   User can get their own churn risk per product.
================================================================ */
const sasosGetChurnRisk = onCall(
  { region: 'us-central1', timeoutSeconds: 15, memory: '128MiB' },
  async (req) => {
    const callerUid = assertAuth(req);
    const isAdmin   = req.auth.token?.admin || req.auth.token?.superAdmin;
    const targetUid = san(req.data.uid || '', 128) || callerUid;

    if (targetUid !== callerUid && !isAdmin)
      throw new HttpsError('permission-denied', 'Cannot view another user\'s churn risk.');

    /* Single user */
    const snap = await db().collection('sasosInsights').doc(targetUid).get();
    if (!snap.exists) return { uid: targetUid, topChurnRisk: 0, scores: {} };

    const data = snap.data();
    return {
      uid: targetUid,
      topChurnRisk:  data.topChurnRisk || 0,
      topUpgradeProb: data.topUpgradeProb || 0,
      scores: data.scores || {},
    };
  }
);

/* ================================================================
   sasosGetSegmentInsights
   Admin-only. Returns aggregated brain insights by tier/product.
================================================================ */
const sasosGetSegmentInsights = onCall(
  { region: 'us-central1', timeoutSeconds: 30, memory: '512MiB' },
  async (req) => {
    assertAdmin(req);
    const product = san(req.data.product || '', 30);

    const snap = await db().collection('sasosInsights').limit(1000).get();
    const byTier    = {};
    const byProduct = {};
    let   totalLTV  = 0;
    let   count     = 0;

    snap.docs.forEach(doc => {
      const d = doc.data();
      const scores = d.scores || {};
      Object.entries(scores).forEach(([prod, s]) => {
        if (product && prod !== product) return;
        const tier = s.tier || 'free';
        if (!byTier[tier]) byTier[tier] = { count: 0, avgChurn: 0, avgUpgrade: 0, totalLTV: 0 };
        if (!byProduct[prod]) byProduct[prod] = { count: 0, avgChurn: 0, avgUpgrade: 0, totalLTV: 0 };
        byTier[tier].count++;
        byTier[tier].avgChurn   += s.churnRisk   || 0;
        byTier[tier].avgUpgrade += s.upgradeProb || 0;
        byTier[tier].totalLTV   += s.ltv          || 0;
        byProduct[prod].count++;
        byProduct[prod].avgChurn   += s.churnRisk   || 0;
        byProduct[prod].avgUpgrade += s.upgradeProb || 0;
        byProduct[prod].totalLTV   += s.ltv          || 0;
      });
      totalLTV += d.estimatedLTV || 0;
      count++;
    });

    /* Average the sums */
    Object.values(byTier).forEach(v => { if (v.count > 0) { v.avgChurn = Math.round(v.avgChurn / v.count); v.avgUpgrade = Math.round(v.avgUpgrade / v.count); } });
    Object.values(byProduct).forEach(v => { if (v.count > 0) { v.avgChurn = Math.round(v.avgChurn / v.count); v.avgUpgrade = Math.round(v.avgUpgrade / v.count); } });

    return { byTier, byProduct, totalUsersAnalysed: count, totalPlatformLTV: totalLTV };
  }
);

/* ── Exports ─────────────────────────────────────────────── */
module.exports = {
  sasosRunBrain,
  sasosGetInsights,
  sasosGetRecommendations,
  sasosGetForecast,
  sasosGetChurnRisk,
  sasosGetSegmentInsights,
};
