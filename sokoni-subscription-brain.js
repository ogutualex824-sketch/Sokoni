/* ================================================================
   SOKONI — AI Subscription Brain  v1.0.0

   Analyses subscription usage patterns to predict and act on:
     • Churn risk (0-100 score with tier labels)
     • Upgrade probability (feature-limit pressure)
     • Package recommendations (upgrade / downgrade / topup)
     • Resource demand forecasting (AI ops, storage, bandwidth)
     • Retention campaign triggers
     • Dynamic resource allocation signals

   Local heuristics run instantly (no CF).
   Deep analysis is fetched from `runSubscriptionBrain` CF (cached).

   Pattern: IIFE → window.SokoniSubsBrain
   Requires: window.firebaseDB, window.firebaseAuth, window.SokoniAISubs
================================================================ */
(function (global) {
  'use strict';

  const VERSION = '1.0.0';

  /* ── Helpers ─────────────────────────────────────────────────── */
  let _fs = null;
  async function fsdk() {
    if (_fs) return _fs;
    _fs = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js');
    return _fs;
  }
  const db  = () => global.firebaseDB;
  const uid = () => global.firebaseAuth?.currentUser?.uid || null;

  async function _call(name, data) {
    const { getFunctions, httpsCallable } = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js');
    const fn = httpsCallable(getFunctions(global.firebaseApp, 'us-central1'), name, { timeout: 30000 });
    return (await fn(data)).data;
  }

  function _esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  /* ── Insight cache (10-minute TTL) ──────────────────────────── */
  let _cache   = null;
  let _cacheTs = 0;
  const CACHE_TTL = 10 * 60 * 1000;

  /* ================================================================
     CHURN RISK SCORE — local heuristics (instant, no network call)
     Input: usage object, sub object, credits object
     Returns: 0–100 integer + tier label
  ================================================================ */
  function _churnRisk(usage, sub, credits) {
    const plan         = global.SokoniAISubs?.PLANS?.[sub?.plan] || {};
    const quotas       = plan.quotas || {};
    const counters     = usage?.counters || {};

    /* Plan utilization */
    let totalQuota = 0, totalUsed = 0;
    Object.entries(quotas).forEach(([k, v]) => {
      if (v > 0 && v !== -1) { totalQuota += v; totalUsed += (counters[k] || 0); }
    });
    const utilization = totalQuota > 0 ? totalUsed / totalQuota : 0;

    let risk = 0;

    /* Under-utilization — strongest churn signal */
    if (utilization < 0.05)      risk += 40;
    else if (utilization < 0.15) risk += 25;
    else if (utilization < 0.30) risk += 12;

    /* Free plan — higher baseline churn */
    if (!sub?.plan || sub.plan === 'ai_free' || sub.plan === 'free') risk += 18;

    /* Subscription age < 14 days — highest-risk onboarding window */
    const ageMs = sub?.activatedAt ? Date.now() - sub.activatedAt : 9999 * 86400000;
    if (ageMs < 7  * 86400000) risk += 15;
    else if (ageMs < 14 * 86400000) risk += 8;

    /* Zero credit consumption on paid plan — not engaging with AI tools */
    if (sub?.plan && sub.plan !== 'ai_free' && (credits?.totalConsumed || 0) === 0) risk += 14;

    /* Near renewal + low usage */
    const daysLeft = sub?.currentPeriodEnd
      ? Math.max(0, (sub.currentPeriodEnd - Date.now()) / 86400000) : 30;
    if (daysLeft < 3 && utilization < 0.2) risk += 20;
    else if (daysLeft < 7 && utilization < 0.15) risk += 10;

    const score = Math.min(100, Math.round(risk));
    const tier  = score >= 70 ? 'critical' : score >= 45 ? 'at_risk' : score >= 20 ? 'monitor' : 'healthy';
    return { score, tier };
  }

  /* ================================================================
     UPGRADE PROBABILITY SCORE — feature-limit pressure analysis
     Returns: 0–100 integer
  ================================================================ */
  function _upgradeProb(usage, sub) {
    const plan    = global.SokoniAISubs?.PLANS?.[sub?.plan] || {};
    const quotas  = plan.quotas || {};
    const counters = usage?.counters || {};

    /* Period fraction: how far through the billing cycle are we? */
    const periodStart = sub?.currentPeriodStart || (Date.now() - 30 * 86400000);
    const periodFrac  = Math.min(1, (Date.now() - periodStart) / (30 * 86400000));

    let score = 0;
    let limitHits = 0;

    Object.entries(quotas).forEach(([feat, limit]) => {
      if (limit <= 0 || limit === -1) return;
      const used = counters[feat] || 0;
      const pct  = used / limit;
      if (pct >= 1.0) {
        limitHits++;
        score += 20;
      } else if (pct >= 0.85) {
        score += 12;
      } else if (pct >= 0.70 && periodFrac < 0.5) {
        /* Hitting 70% in the first half of the cycle → will definitely hit limit */
        score += 8;
      }
    });

    /* Bonus: multiple features simultaneously pressured */
    if (limitHits >= 3) score += 15;
    else if (limitHits >= 2) score += 8;

    return Math.min(100, Math.round(score));
  }

  /* ================================================================
     PACKAGE RECOMMENDATION ENGINE
     Returns a recommendation object or null (no action needed).
  ================================================================ */
  function _recommend(usage, sub, credits, churnScore, upgradeScore) {
    const subs        = global.SokoniAISubs;
    if (!subs) return null;
    const currentPlan = sub?.plan || 'ai_free';
    const plan        = subs.PLANS[currentPlan];
    if (!plan) return null;

    const planOrder = ['ai_free', 'ai_starter', 'ai_pro', 'ai_enterprise'];
    const idx       = planOrder.indexOf(currentPlan);

    /* ── UPGRADE: feature pressure ── */
    if (upgradeScore >= 55 && idx < planOrder.length - 1) {
      const nextId   = planOrder[idx + 1];
      const nextPlan = subs.PLANS[nextId];
      return {
        action:   'upgrade',
        planId:   nextId,
        planName: nextPlan.name,
        reason:   `You're approaching your monthly limits. Upgrading to ${nextPlan.name} gives you more capacity and prevents interruptions.`,
        urgency:  upgradeScore >= 80 ? 'high' : 'medium',
        savings:  null,
        url:      `/ai-subscriptions.html?plan=${nextId}`,
      };
    }

    /* ── DOWNGRADE: low utilization, save money, retain customer ── */
    if (churnScore >= 50 && idx > 0) {
      const lowerId   = planOrder[idx - 1];
      const lowerPlan = subs.PLANS[lowerId];
      const savings   = plan.price - lowerPlan.price;
      if (savings > 0) {
        return {
          action:   'downgrade',
          planId:   lowerId,
          planName: lowerPlan.name,
          reason:   `Your usage fits a lower plan. Switch to ${lowerPlan.name} and save KES ${savings.toLocaleString()}/mo.`,
          urgency:  'low',
          savings,
          url:      `/ai-subscriptions.html?plan=${lowerId}`,
        };
      }
    }

    /* ── CREDIT TOP-UP: low balance, high historical consumption ── */
    if ((credits?.balance || 0) < 15 && (credits?.totalConsumed || 0) > 30) {
      return {
        action:   'topup',
        planId:   null,
        planName: null,
        reason:   'Your AI credit balance is running low. Top up to keep compute-heavy tools available.',
        urgency:  'medium',
        savings:  null,
        url:      '/ai-subscriptions.html#credits',
      };
    }

    /* ── STORAGE: approaching quota ── */
    const storageGB = plan.storageGB || 0;
    if (storageGB > 0 && (sub?.storageUsedGB || 0) / storageGB > 0.80) {
      return {
        action:  'storage',
        planId:  null,
        reason:  'Your storage is over 80% full. Add more storage to avoid upload failures.',
        urgency: 'medium',
        url:     '/ai-subscriptions.html#storage',
      };
    }

    return null;
  }

  /* ================================================================
     RESOURCE DEMAND FORECAST
     Extrapolates current-period usage to predict next month's demand.
  ================================================================ */
  function _resourceForecast(usage, sub) {
    const periodStart = sub?.currentPeriodStart || (Date.now() - 30 * 86400000);
    const periodFrac  = Math.max(0.01, Math.min(1, (Date.now() - periodStart) / (30 * 86400000)));

    const totalUsed   = Object.values(usage?.counters || {}).reduce((a, b) => a + b, 0);
    const runRate     = totalUsed / periodFrac;          // ops per 30 days at current pace
    const nextMonthEst = Math.round(runRate * 1.08);     // 8% growth assumption

    return {
      opsThisMonth:    totalUsed,
      opsRunRate:      Math.round(runRate),
      opsNextMonthEst: nextMonthEst,
      periodFracPct:   Math.round(periodFrac * 100),
    };
  }

  /* ================================================================
     RETENTION CAMPAIGN TRIGGER
     Returns a campaign action if the user should receive outreach.
  ================================================================ */
  function _retentionTrigger(churn, upgrade, sub) {
    if (churn.tier === 'critical') {
      return {
        campaign: 'win_back',
        offer:    '30% off annual billing',
        channel:  ['push', 'email'],
        message:  "We noticed you haven't been using your AI tools. Upgrade to annual billing and save 30%.",
      };
    }
    if (churn.tier === 'at_risk' && upgrade.score < 30) {
      return {
        campaign:  'engagement',
        offer:     'Free 50 credits',
        channel:   ['push'],
        message:   'Get 50 bonus AI credits when you try our AI Product Assistant today.',
      };
    }
    if (upgrade.score >= 80) {
      return {
        campaign: 'upsell',
        offer:    'First month free on upgrade',
        channel:  ['push', 'email'],
        message:  "You've used up your limits! Upgrade now and get your first month free.",
      };
    }
    return null;
  }

  /* ================================================================
     getInsights()
     Full brain analysis for the signed-in user.
     Merges local heuristics with server scores (if cached in Firestore).
  ================================================================ */
  async function getInsights() {
    const u = uid();
    if (!u) return null;
    if (_cache && Date.now() - _cacheTs < CACHE_TTL) return _cache;

    try {
      const subs = global.SokoniAISubs;
      if (!subs) return null;

      const [sub, usage, credits] = await Promise.all([
        subs.getSubscription(), subs.getUsage(), subs.getCredits(),
      ]);

      const churn          = _churnRisk(usage, sub, credits);
      const upgrade        = { score: _upgradeProb(usage, sub) };
      const recommendation = _recommend(usage, sub, credits, churn.score, upgrade.score);
      const resources      = _resourceForecast(usage, sub);
      const retention      = _retentionTrigger(churn, upgrade, sub);

      /* Merge server-side deep scores from Firestore (background-updated by CF) */
      let serverScores = null;
      try {
        const { doc, getDoc } = await fsdk();
        const snap = await getDoc(doc(db(), 'subscriptionBrain', u));
        if (snap.exists()) serverScores = snap.data();
      } catch { /* non-critical */ }

      const insights = {
        uid:             u,
        plan:            sub?.plan || 'ai_free',
        churnRisk:       serverScores?.churnRisk    ?? churn.score,
        churnTier:       serverScores?.churnTier    ?? churn.tier,
        upgradeProb:     serverScores?.upgradeProb  ?? upgrade.score,
        ltv:             serverScores?.ltv           ?? null,
        retentionTier:   serverScores?.retentionTier ?? churn.tier,
        recommendation,
        resources,
        retention,
        source:          serverScores ? 'server+local' : 'local',
        generatedAt:     Date.now(),
      };

      _cache   = insights;
      _cacheTs = Date.now();
      return insights;
    } catch { return null; }
  }

  /* ================================================================
     showInsightWidget(containerEl)
     Renders a compact AI intelligence widget.
     Called by seller dashboard, creative studio, admin panel, etc.
  ================================================================ */
  async function showInsightWidget(container) {
    if (!container) return;
    container.innerHTML = `<div style="color:rgba(255,255,255,.4);font-size:13px;padding:12px">Loading AI insights…</div>`;

    const ins = await getInsights();
    if (!ins) { container.innerHTML = ''; return; }

    const riskColor = ins.churnRisk > 65 ? '#ff4444' : ins.churnRisk > 35 ? '#ff9500' : '#71ff00';
    const rec       = ins.recommendation;
    const recHtml   = rec ? `
<div style="background:rgba(113,255,0,.05);border:1px solid rgba(113,255,0,.12);border-radius:10px;padding:12px;margin-top:12px">
  <div style="font-size:12px;font-weight:800;color:#71ff00;margin-bottom:4px">
    ${rec.action === 'upgrade' ? '⬆ Upgrade Recommended' : rec.action === 'downgrade' ? '⬇ Save Money' : rec.action === 'topup' ? '⚡ Top Up Credits' : '💾 Add Storage'}
  </div>
  <div style="font-size:12px;color:rgba(255,255,255,.65);line-height:1.6">${_esc(rec.reason)}</div>
  <a href="${_esc(rec.url)}" style="display:inline-block;margin-top:8px;font-size:12px;font-weight:700;color:#71ff00;text-decoration:none">Take Action →</a>
</div>` : '';

    container.innerHTML = `
<div style="background:#111;border:1px solid rgba(255,255,255,.07);border-radius:14px;padding:18px;font-family:system-ui,-apple-system">
  <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px">
    <div style="font-size:11px;font-weight:800;color:rgba(255,255,255,.35);letter-spacing:.8px;text-transform:uppercase">Subscription Intelligence</div>
    <div style="font-size:10px;color:rgba(255,255,255,.2)">${_esc(ins.source)}</div>
  </div>
  <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-bottom:0">
    <div style="background:#181818;border-radius:9px;padding:10px;text-align:center">
      <div style="font-size:22px;font-weight:800;color:${riskColor}">${ins.churnRisk}</div>
      <div style="font-size:10px;color:rgba(255,255,255,.4);margin-top:2px">Churn Risk</div>
    </div>
    <div style="background:#181818;border-radius:9px;padding:10px;text-align:center">
      <div style="font-size:22px;font-weight:800;color:#71ff00">${ins.upgradeProb}%</div>
      <div style="font-size:10px;color:rgba(255,255,255,.4);margin-top:2px">Upgrade Signal</div>
    </div>
    <div style="background:#181818;border-radius:9px;padding:10px;text-align:center">
      <div style="font-size:18px;font-weight:800;color:#fff">${ins.resources.opsThisMonth}</div>
      <div style="font-size:10px;color:rgba(255,255,255,.4);margin-top:2px">AI Ops/mo</div>
    </div>
  </div>
  ${recHtml}
</div>`;
  }

  /* ── Admin: get brain report for any user ────────────────────── */
  async function adminGetBrainReport(targetUid) {
    return _call('runSubscriptionBrain', { adminQuery: true, targetUid });
  }

  /* ── Admin: get all at-risk users ────────────────────────────── */
  async function adminGetAtRiskUsers(tier = 'at_risk') {
    try {
      const { collection, query, where, orderBy, limit, getDocs } = await fsdk();
      const snap = await getDocs(
        query(collection(db(), 'subscriptionBrain'),
          where('retentionTier', 'in', tier === 'critical' ? ['critical'] : ['critical', 'at_risk']),
          orderBy('churnRisk', 'desc'),
          limit(100)
        )
      );
      return snap.docs.map(d => ({ id: d.id, ...d.data() }));
    } catch { return []; }
  }

  /* ── Admin: revenue forecast ─────────────────────────────────── */
  async function adminForecastRevenue(months = 3) {
    return _call('forecastRevenue', { months });
  }

  /* ── Invalidate cache ────────────────────────────────────────── */
  function invalidateCache() { _cache = null; _cacheTs = 0; }

  /* ── Public API ─────────────────────────────────────────────── */
  global.SokoniSubsBrain = {
    VERSION,
    /* User-facing */
    getInsights,
    showInsightWidget,
    invalidateCache,
    /* Score utilities (can be used standalone) */
    scoreChurnRisk:       (u, s, c) => _churnRisk(u, s, c),
    scoreUpgradeProb:     (u, s)    => _upgradeProb(u, s),
    getRecommendation:    (u, s, c, ch, up) => _recommend(u, s, c, ch, up),
    forecastResources:    (u, s)    => _resourceForecast(u, s),
    /* Admin */
    admin: {
      getBrainReport:   adminGetBrainReport,
      getAtRiskUsers:   adminGetAtRiskUsers,
      forecastRevenue:  adminForecastRevenue,
    },
  };

  global.dispatchEvent(new CustomEvent('sokoniSubsBrainReady'));

})(window);
