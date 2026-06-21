/* ================================================================
   SOKONI — AI Subscriptions Engine  v1.0.0

   Manages AI feature access, usage metering, credits, and billing
   across every Sokoni module that uses AI capabilities.

   Plans (separate from marketplace subscriptions):
     ai_free       KES 0/mo  — individuals, new sellers
     ai_starter    KES 499/mo (KES 4,990/yr)  — growing businesses
     ai_pro        KES 1,499/mo (KES 14,990/yr) — active merchants
     ai_enterprise KES 9,999/mo (KES 99,990/yr) — organisations

   Key guarantees:
   • AI subscriptions are separate from marketplace commissions.
   • Commissions apply only to successful transactions (sokoni-pay.js).
   • Users never pay twice for the same service.
   • Features degrade gracefully (warn → soft-block → buy credits).
   • Plans can be upgraded, downgraded, monthly or annual.

   Pattern : IIFE → window.SokoniAISubs
   Requires: window.firebaseDB, window.firebaseAuth,
             window.SokoniPay (sokoni-pay.js)
================================================================ */
(function (global) {
  'use strict';

  const VERSION = '1.0.0';

  /* ─── Billing period helpers ──────────────────────────────── */
  function currentPeriod() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  }

  function periodEnd(billing = 'monthly') {
    const now = new Date();
    if (billing === 'annual') {
      return new Date(now.getFullYear() + 1, now.getMonth(), now.getDate()).getTime();
    }
    return new Date(now.getFullYear(), now.getMonth() + 1, now.getDate()).getTime();
  }

  /* ================================================================
     PLAN DEFINITIONS
     -1 in any quota field = unlimited.
     storageGB and aiCreditsIncluded are per billing period.
  ================================================================ */
  const PLANS = {
    ai_free: {
      id:          'ai_free',
      name:        'Free',
      tagline:     'Start creating with AI',
      price:       0,
      annualPrice: 0,
      badge:       null,
      quotas: {
        removeBackground:   10,
        enhanceProduct:     20,
        smartCrop:          -1,   /* unlimited */
        generateBanner:      0,
        generatePoster:      0,
        createStory:         2,
        processLogo:         0,
        productTitles:       5,
        productDescriptions: 5,
        bulkUploadFiles:     5,
        bulkEditImages:      0,
        seoOptimization:     0,
        marketingCopy:       0,
        campaignCreation:    0,
        multilingualContent: 0,
        apiCalls:            0,
      },
      teamMembers:       1,
      storageGB:         0.5,
      aiCreditsIncluded: 0,
      features: {
        priorityProcessing: false,
        teamCollaboration:  false,
        apiAccess:          false,
        customBrandAI:      false,
        whiteLabel:         false,
        workflowApprovals:  false,
        advancedAnalytics:  false,
        enterpriseSLA:      false,
        dedicatedSupport:   false,
      },
    },

    ai_starter: {
      id:          'ai_starter',
      name:        'Starter',
      tagline:     'For growing businesses',
      price:       499,
      annualPrice: 4990,   /* 2 months free */
      badge:       'Popular',
      quotas: {
        removeBackground:   100,
        enhanceProduct:     200,
        smartCrop:          -1,
        generateBanner:      10,
        generatePoster:      10,
        createStory:         20,
        processLogo:         20,
        productTitles:       -1,
        productDescriptions: 50,
        bulkUploadFiles:     50,
        bulkEditImages:      50,
        seoOptimization:     30,
        marketingCopy:        0,
        campaignCreation:     0,
        multilingualContent:  0,
        apiCalls:             0,
      },
      teamMembers:       1,
      storageGB:         5,
      aiCreditsIncluded: 50,
      features: {
        priorityProcessing: true,
        teamCollaboration:  false,
        apiAccess:          false,
        customBrandAI:      false,
        whiteLabel:         false,
        workflowApprovals:  false,
        advancedAnalytics:  true,
        enterpriseSLA:      false,
        dedicatedSupport:   false,
      },
    },

    ai_pro: {
      id:          'ai_pro',
      name:        'Professional',
      tagline:     'For active merchants & brands',
      price:       1499,
      annualPrice: 14990,  /* 2 months free */
      badge:       'Best Value',
      quotas: {
        removeBackground:   -1,
        enhanceProduct:     -1,
        smartCrop:          -1,
        generateBanner:      50,
        generatePoster:      50,
        createStory:        100,
        processLogo:        -1,
        productTitles:      -1,
        productDescriptions:-1,
        bulkUploadFiles:   500,
        bulkEditImages:    500,
        seoOptimization:   -1,
        marketingCopy:     100,
        campaignCreation:   20,
        multilingualContent:50,
        apiCalls:            0,
      },
      teamMembers:       3,
      storageGB:         50,
      aiCreditsIncluded: 200,
      features: {
        priorityProcessing: true,
        teamCollaboration:  true,
        apiAccess:          false,
        customBrandAI:      false,
        whiteLabel:         false,
        workflowApprovals:  false,
        advancedAnalytics:  true,
        enterpriseSLA:      false,
        dedicatedSupport:   true,
      },
    },

    ai_enterprise: {
      id:          'ai_enterprise',
      name:        'Enterprise',
      tagline:     'For organisations & franchises',
      price:       9999,
      annualPrice: 99990,  /* 2 months free */
      badge:       'Enterprise',
      quotas: {
        removeBackground:   -1,
        enhanceProduct:     -1,
        smartCrop:          -1,
        generateBanner:     -1,
        generatePoster:     -1,
        createStory:        -1,
        processLogo:        -1,
        productTitles:      -1,
        productDescriptions:-1,
        bulkUploadFiles:    -1,
        bulkEditImages:     -1,
        seoOptimization:    -1,
        marketingCopy:      -1,
        campaignCreation:   -1,
        multilingualContent:-1,
        apiCalls:       50000,
      },
      teamMembers:       -1,   /* unlimited */
      storageGB:         500,
      aiCreditsIncluded: 1000,
      features: {
        priorityProcessing: true,
        teamCollaboration:  true,
        apiAccess:          true,
        customBrandAI:      true,
        whiteLabel:         true,
        workflowApprovals:  true,
        advancedAnalytics:  true,
        enterpriseSLA:      true,
        dedicatedSupport:   true,
      },
    },
  };

  /* ================================================================
     AI CREDIT COSTS — consumed for compute-intensive operations
     (separate from monthly quota; deducted from credit balance)
  ================================================================ */
  const CREDIT_COSTS = {
    aiImageGeneration:  10,
    aiVideoGeneration:  50,
    aiVoiceoverPerMin:   5,
    videoEditingPerMin: 20,
    generativeDesign:   15,
    productMetadataAI:   1,   /* when over monthly limit */
    removeBackgroundCredit: 2, /* when over monthly plan quota */
  };

  /* ================================================================
     CREDIT PACKS — pay-as-you-go top-ups
  ================================================================ */
  const CREDIT_PACKS = [
    { id: 'credits_100',  credits: 100,  price: 500,   label: '100 Credits',  tag: null },
    { id: 'credits_500',  credits: 500,  price: 2000,  label: '500 Credits',  tag: '20% off' },
    { id: 'credits_1000', credits: 1000, price: 3500,  label: '1,000 Credits', tag: '30% off' },
    { id: 'credits_5000', credits: 5000, price: 15000, label: '5,000 Credits', tag: '40% off' },
  ];

  /* ================================================================
     AI MARKETPLACE BOOSTS — optional growth add-ons
  ================================================================ */
  const AI_BOOSTS = {
    listingOptimization: { price: 299, label: 'AI Listing Optimiser',    desc: 'Auto-rewrite title, description & tags for higher search rank', duration: 30 },
    searchRankSuggester: { price: 199, label: 'Search Rank Advisor',     desc: 'AI suggestions for keywords, tags, and pricing to improve rank', duration: 30 },
    adGeneration:        { price: 499, label: 'AI Ad Creator',           desc: 'Auto-generate banners, copy, and targeting for your listings',  duration: 30 },
    campaignManager:     { price: 799, label: 'AI Campaign Manager',     desc: 'Full AI-managed ad campaigns with spend optimisation',          duration: 30 },
    pricingInsights:     { price: 299, label: 'AI Pricing Intelligence', desc: 'Real-time pricing recommendations based on market data',        duration: 30 },
    competitorAnalysis:  { price: 499, label: 'Competitor Intelligence', desc: 'Monitor competitor listings, prices, and promotions',           duration: 30 },
    demandForecasting:   { price: 399, label: 'Demand Forecasting',      desc: 'AI predictions for inventory demand and seasonal trends',       duration: 30 },
  };

  /* ================================================================
     STORAGE PACKAGES
  ================================================================ */
  const STORAGE_PACKAGES = [
    { id: 'storage_personal',     gb: 10,   price: 99,   label: '10 GB Personal',     backup: '30 days', versions: 5  },
    { id: 'storage_business',     gb: 100,  price: 299,  label: '100 GB Business',    backup: '90 days', versions: 20 },
    { id: 'storage_professional', gb: 500,  price: 799,  label: '500 GB Professional',backup: '180 days',versions: 50 },
    { id: 'storage_enterprise',   gb: 2000, price: 2499, label: '2 TB Enterprise',    backup: '365 days',versions: -1 },
  ];

  /* ================================================================
     Firestore helpers
  ================================================================ */
  let _fs = null;
  async function fsdk() {
    if (_fs) return _fs;
    _fs = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js');
    return _fs;
  }

  function db()  { return global.firebaseDB; }
  function uid() { return global.firebaseAuth?.currentUser?.uid || null; }

  /* ================================================================
     Session cache — 5-minute TTL for subscription state
  ================================================================ */
  let _subCache = null;
  let _subCacheTs = 0;
  const CACHE_TTL = 5 * 60 * 1000;

  let _usageCache = null;
  let _usageCacheTs = 0;

  function _invalidate() { _subCache = null; _subCacheTs = 0; _usageCache = null; _usageCacheTs = 0; }

  /* ================================================================
     getSubscription()
     Returns the user's active AI subscription document.
     Defaults to free plan if none exists.
  ================================================================ */
  async function getSubscription(targetUid) {
    const u = targetUid || uid();
    if (!u) return _defaultSub();

    if (!targetUid && _subCache && Date.now() - _subCacheTs < CACHE_TTL) return _subCache;

    try {
      const { doc, getDoc } = await fsdk();
      const snap = await getDoc(doc(db(), 'aiSubscriptions', u));
      const sub  = snap.exists() ? snap.data() : _defaultSub(u);

      /* Validate expiry */
      if (sub.status === 'active' && sub.currentPeriodEnd && sub.currentPeriodEnd < Date.now()) {
        sub.status = 'expired';
        try {
          const { doc: d2, updateDoc } = await fsdk();
          await updateDoc(d2(db(), 'aiSubscriptions', u), { status: 'expired' });
        } catch { /* best-effort */ }
      }

      if (!targetUid) { _subCache = sub; _subCacheTs = Date.now(); }
      return sub;
    } catch { return _defaultSub(u); }
  }

  function _defaultSub(u) {
    return {
      uid:               u || uid() || '',
      plan:              'ai_free',
      status:            'active',
      billing:           'monthly',
      activatedAt:       Date.now(),
      currentPeriodEnd:  periodEnd('monthly'),
      aiCreditsBalance:  0,
      storageAddonGB:    0,
    };
  }

  /* ================================================================
     getPlan()
     Returns the PLANS definition for the user's current plan.
     Admin override: pass a planId to preview any plan.
  ================================================================ */
  async function getPlan(planIdOverride) {
    if (planIdOverride) return PLANS[planIdOverride] || PLANS.ai_free;
    const sub = await getSubscription();
    const planId = sub.status === 'active' || sub.status === 'trial'
      ? (sub.plan || 'ai_free')
      : 'ai_free';
    return PLANS[planId] || PLANS.ai_free;
  }

  /* ================================================================
     getUsage()
     Returns this billing period's usage for the current user.
  ================================================================ */
  async function getUsage() {
    const u = uid();
    if (!u) return {};
    if (_usageCache && Date.now() - _usageCacheTs < CACHE_TTL) return _usageCache;
    try {
      const period = currentPeriod();
      const { doc, getDoc } = await fsdk();
      const snap = await getDoc(doc(db(), 'aiUsage', `${u}_${period}`));
      const usage = snap.exists() ? snap.data() : { uid: u, period, counters: {} };
      _usageCache = usage;
      _usageCacheTs = Date.now();
      return usage;
    } catch { return { uid: u, period: currentPeriod(), counters: {} }; }
  }

  /* ================================================================
     canUse(feature)
     The primary feature gate. Returns:
       { allowed: true,  remaining: N, plan, source: 'quota'|'unlimited' }
       { allowed: false, remaining: 0, plan, reason: string, creditCost: N|null }
  ================================================================ */
  async function canUse(feature) {
    const sub   = await getSubscription();
    const plan  = PLANS[sub.plan] || PLANS.ai_free;
    const usage = await getUsage();

    /* Degraded service for expired subscriptions */
    if (sub.status === 'expired' || sub.status === 'cancelled') {
      const freePlan = PLANS.ai_free;
      return _checkQuota(feature, freePlan, usage, 'ai_free');
    }

    return _checkQuota(feature, plan, usage, sub.plan);
  }

  function _checkQuota(feature, plan, usage, planId) {
    const limit = plan.quotas[feature];
    if (limit === undefined) {
      return { allowed: true, remaining: -1, plan: planId, source: 'feature-not-metered' };
    }
    if (limit === -1) {
      return { allowed: true, remaining: -1, plan: planId, source: 'unlimited' };
    }
    if (limit === 0) {
      const creditCost = CREDIT_COSTS[`${feature}Credit`] || CREDIT_COSTS[feature] || null;
      return {
        allowed: false, remaining: 0, plan: planId,
        reason:  `${feature} is not available on the ${PLANS[planId]?.name || planId} plan.`,
        upgradeRequired: _nextPlanWith(feature),
        creditCost,
      };
    }

    const used      = usage.counters?.[feature] || 0;
    const remaining = Math.max(0, limit - used);
    if (remaining <= 0) {
      const creditCost = CREDIT_COSTS[`${feature}Credit`] || CREDIT_COSTS[feature] || null;
      return {
        allowed: false, remaining: 0, plan: planId,
        reason:  `Monthly limit of ${limit} reached for ${feature}.`,
        upgradeRequired: _nextPlanWith(feature, limit + 1),
        creditCost,
      };
    }
    return { allowed: true, remaining, plan: planId, source: 'quota', used, limit };
  }

  function _nextPlanWith(feature, neededLimit = 1) {
    const order = ['ai_free', 'ai_starter', 'ai_pro', 'ai_enterprise'];
    for (const id of order) {
      const q = PLANS[id].quotas[feature];
      if (q === -1 || q >= neededLimit) return id;
    }
    return 'ai_enterprise';
  }

  /* ================================================================
     track(feature)
     Increments usage counter ONLY when canUse() returned { allowed: true }.
     Call this immediately after the AI operation succeeds.
  ================================================================ */
  async function track(feature) {
    const u = uid();
    if (!u) return;
    const period = currentPeriod();
    try {
      const { doc, setDoc, increment } = await fsdk();
      await setDoc(
        doc(db(), 'aiUsage', `${u}_${period}`),
        {
          uid: u, period,
          counters: { [feature]: increment(1) },
          lastUpdated: Date.now(),
        },
        { merge: true }
      );
      /* Optimistic local update */
      if (_usageCache) {
        _usageCache.counters = _usageCache.counters || {};
        _usageCache.counters[feature] = (_usageCache.counters[feature] || 0) + 1;
      }
    } catch { /* non-critical; will resync on next getUsage() call */ }
  }

  /* ================================================================
     Credits
  ================================================================ */
  async function getCredits() {
    const u = uid();
    if (!u) return { balance: 0, totalPurchased: 0, totalConsumed: 0 };
    try {
      const { doc, getDoc } = await fsdk();
      const snap = await getDoc(doc(db(), 'aiCredits', u));
      return snap.exists()
        ? snap.data()
        : { uid: u, balance: 0, totalPurchased: 0, totalConsumed: 0 };
    } catch { return { uid: u, balance: 0, totalPurchased: 0, totalConsumed: 0 }; }
  }

  async function consumeCredits(amount, reason) {
    const u = uid();
    if (!u) throw new Error('Authentication required.');
    const cred = await getCredits();
    if (cred.balance < amount) {
      throw new Error(`Insufficient credits. Balance: ${cred.balance}, Required: ${amount}`);
    }
    const { doc, setDoc, increment } = await fsdk();
    await setDoc(
      doc(db(), 'aiCredits', u),
      {
        uid:           u,
        balance:       increment(-amount),
        totalConsumed: increment(amount),
        lastConsumed:  Date.now(),
      },
      { merge: true }
    );
    _trackCreditEvent('consume', { amount, reason });
    return { newBalance: cred.balance - amount };
  }

  /* Called from Cloud Function after payment confirmation */
  async function _applyTopup(packId) {
    const pack = CREDIT_PACKS.find(p => p.id === packId);
    if (!pack) throw new Error('Invalid credit pack');
    const u = uid();
    if (!u) throw new Error('Authentication required.');
    const { doc, setDoc, increment } = await fsdk();
    await setDoc(
      doc(db(), 'aiCredits', u),
      {
        uid:            u,
        balance:        increment(pack.credits),
        totalPurchased: increment(pack.credits),
        lastTopup:      Date.now(),
      },
      { merge: true }
    );
    _trackCreditEvent('topup', { packId, credits: pack.credits, price: pack.price });
  }

  async function _trackCreditEvent(type, data) {
    const u = uid();
    if (!u) return;
    try {
      const { collection, addDoc } = await fsdk();
      await addDoc(collection(db(), 'aiCreditLedger'), {
        uid: u, type, ...data, ts: Date.now(),
      });
    } catch { /* non-critical */ }
  }

  /* ================================================================
     Payment flows
     All billing is via IntaSend (M-Pesa STK push).
     The Cloud Function activateAIPlan is called after payment confirms.
  ================================================================ */
  async function subscribe(planId, billing = 'monthly') {
    const plan = PLANS[planId];
    if (!plan) throw new Error(`Unknown plan: ${planId}`);
    if (plan.price === 0) {
      /* Free plan — activate immediately without payment */
      return _activateFree();
    }

    const price = billing === 'annual' ? plan.annualPrice : plan.price;
    const ref   = `AI_SUB_${planId.toUpperCase()}_${Date.now()}`;
    const user  = global.firebaseAuth?.currentUser;
    if (!user) throw new Error('Authentication required.');

    return new Promise((resolve, reject) => {
      if (!global.SokoniPay?.showGateway) {
        reject(new Error('Payment gateway (SokoniPay) not loaded.'));
        return;
      }
      global.SokoniPay.showGateway({
        amount:       price,
        description:  `SOKONI AI ${plan.name} Plan — ${billing === 'annual' ? 'Annual' : 'Monthly'}`,
        ref,
        category:     'ai_subscription',
        onSuccess: async (receipt) => {
          try {
            await _callActivateCF(planId, billing, receipt.ref || ref);
            _invalidate();
            resolve({ plan: planId, billing, ref: receipt.ref || ref });
          } catch (e) { reject(e); }
        },
        onCancel: () => reject(new Error('Payment cancelled.')),
      });
    });
  }

  async function _activateFree() {
    const u = uid();
    if (!u) throw new Error('Authentication required.');
    const { doc, setDoc } = await fsdk();
    const now = Date.now();
    await setDoc(doc(db(), 'aiSubscriptions', u), {
      uid: u, plan: 'ai_free', status: 'active', billing: 'monthly',
      activatedAt: now, currentPeriodStart: now, currentPeriodEnd: periodEnd('monthly'),
    }, { merge: true });
    _invalidate();
    return { plan: 'ai_free', billing: 'monthly' };
  }

  async function _callActivateCF(planId, billing, paymentRef) {
    try {
      const { getFunctions, httpsCallable } = await import(
        'https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js'
      );
      const fn = httpsCallable(
        getFunctions(global.firebaseApp, 'us-central1'),
        'activateAIPlan'
      );
      await fn({ planId, billing, paymentRef });
    } catch (e) {
      /* Fallback: write subscription locally (CF will reconcile on next call) */
      const u = uid();
      const { doc, setDoc } = await fsdk();
      const now = Date.now();
      await setDoc(doc(db(), 'aiSubscriptions', u), {
        uid: u, plan: planId, status: 'active', billing,
        paymentRef, activatedAt: now,
        currentPeriodStart: now, currentPeriodEnd: periodEnd(billing),
      }, { merge: true });
    }
  }

  async function purchaseCredits(packId) {
    const pack = CREDIT_PACKS.find(p => p.id === packId);
    if (!pack) throw new Error(`Unknown credit pack: ${packId}`);
    const ref  = `AI_CRED_${packId.toUpperCase()}_${Date.now()}`;
    if (!global.SokoniPay?.showGateway) throw new Error('Payment gateway not loaded.');

    return new Promise((resolve, reject) => {
      global.SokoniPay.showGateway({
        amount:       pack.price,
        description:  `SOKONI AI Credits — ${pack.label}`,
        ref,
        category:     'ai_credits',
        onSuccess: async (receipt) => {
          try {
            await _applyTopup(packId);
            resolve({ credits: pack.credits, packId, ref: receipt.ref || ref });
          } catch (e) { reject(e); }
        },
        onCancel: () => reject(new Error('Payment cancelled.')),
      });
    });
  }

  async function purchaseBoost(boostId) {
    const boost = AI_BOOSTS[boostId];
    if (!boost) throw new Error(`Unknown boost: ${boostId}`);
    const ref   = `AI_BOOST_${boostId.toUpperCase()}_${Date.now()}`;
    const u     = uid();
    if (!u) throw new Error('Authentication required.');
    if (!global.SokoniPay?.showGateway) throw new Error('Payment gateway not loaded.');

    return new Promise((resolve, reject) => {
      global.SokoniPay.showGateway({
        amount:       boost.price,
        description:  `SOKONI ${boost.label} — ${boost.duration}-day boost`,
        ref,
        category:     'ai_boost',
        onSuccess: async (receipt) => {
          try {
            const { doc, setDoc } = await fsdk();
            await setDoc(doc(db(), 'aiBoosts', `${u}_${boostId}`), {
              uid: u, boostId,
              activatedAt: Date.now(),
              expiresAt:   Date.now() + boost.duration * 86400000,
              paymentRef:  receipt.ref || ref,
              label:       boost.label,
              status:      'active',
            }, { merge: true });
            resolve({ boostId, expiresIn: boost.duration + ' days' });
          } catch (e) { reject(e); }
        },
        onCancel: () => reject(new Error('Payment cancelled.')),
      });
    });
  }

  async function purchaseStorage(packageId) {
    const pkg = STORAGE_PACKAGES.find(p => p.id === packageId);
    if (!pkg) throw new Error(`Unknown storage package: ${packageId}`);
    const ref = `STORAGE_${packageId.toUpperCase()}_${Date.now()}`;
    const u   = uid();
    if (!u) throw new Error('Authentication required.');
    if (!global.SokoniPay?.showGateway) throw new Error('Payment gateway not loaded.');

    return new Promise((resolve, reject) => {
      global.SokoniPay.showGateway({
        amount:       pkg.price,
        description:  `SOKONI Storage — ${pkg.label}`,
        ref,
        category:     'ai_storage',
        onSuccess: async (receipt) => {
          try {
            const { doc, setDoc, increment } = await fsdk();
            await setDoc(doc(db(), 'aiSubscriptions', u), {
              storageAddonGB: increment(pkg.gb),
              storagePackage: packageId,
              storageActivatedAt: Date.now(),
              storageExpiresAt:   Date.now() + 365 * 86400000,
            }, { merge: true });
            _invalidate();
            resolve({ packageId, gb: pkg.gb });
          } catch (e) { reject(e); }
        },
        onCancel: () => reject(new Error('Payment cancelled.')),
      });
    });
  }

  /* ================================================================
     Upgrade prompt modal
     Shows a contextual upgrade prompt when a feature limit is hit.
  ================================================================ */
  function showUpgradePrompt(result) {
    const needed     = result.upgradeRequired || 'ai_pro';
    const plan       = PLANS[needed] || PLANS.ai_pro;
    const creditCost = result.creditCost;

    document.getElementById('_aiprompt')?.remove();

    const el = document.createElement('div');
    el.id    = '_aiprompt';
    el.innerHTML = `
<style>
#_aiprompt{position:fixed;inset:0;background:rgba(0,0,0,.85);z-index:100001;display:flex;align-items:center;justify-content:center;padding:16px;font-family:system-ui,sans-serif}
#_aipm{background:#111;border:1px solid rgba(113,255,0,.2);border-radius:16px;width:100%;max-width:400px;padding:28px;color:#fff;text-align:center}
#_aipm h3{font-size:18px;font-weight:800;color:#71ff00;margin-bottom:8px}
#_aipm p{font-size:13px;color:rgba(255,255,255,.55);line-height:1.6;margin-bottom:20px}
#_aipm .price{font-size:28px;font-weight:800;color:#fff;margin-bottom:6px}
#_aipm .price span{font-size:14px;color:rgba(255,255,255,.4)}
._aibtn{display:block;width:100%;padding:13px;border-radius:10px;border:none;cursor:pointer;font-size:14px;font-weight:800;margin-top:10px;transition:.15s}
._aibtn-primary{background:#71ff00;color:#000}
._aibtn-primary:hover{background:#5de600}
._aibtn-sec{background:rgba(255,255,255,.07);color:rgba(255,255,255,.7)}
._aibtn-sec:hover{background:rgba(255,255,255,.12)}
._aibtn-credit{background:rgba(113,255,0,.12);color:#71ff00;border:1px solid rgba(113,255,0,.25)}
</style>
<div id="_aipm">
  <div style="font-size:36px;margin-bottom:12px">⚡</div>
  <h3>Upgrade to ${plan.name}</h3>
  <p>${result.reason || 'Unlock this AI feature and much more.'}</p>
  <div class="price">KES ${(plan.price).toLocaleString()}<span>/mo</span></div>
  <div style="font-size:11px;color:rgba(255,255,255,.35);margin-bottom:16px">or KES ${(plan.annualPrice).toLocaleString()}/yr — 2 months free</div>
  <button class="_aibtn _aibtn-primary" id="_aipm-upgrade">Upgrade Now</button>
  ${creditCost ? `<button class="_aibtn _aibtn-credit" id="_aipm-credits">Use ${creditCost} Credits instead</button>` : ''}
  <button class="_aibtn _aibtn-sec" id="_aipm-close">Not now</button>
</div>`;
    document.body.appendChild(el);

    const close = () => el.remove();
    document.getElementById('_aipm-close').onclick = close;
    el.addEventListener('click', e => { if (e.target === el) close(); });

    document.getElementById('_aipm-upgrade').onclick = () => {
      close();
      if (global.location) global.location.href = `/ai-subscriptions.html?plan=${needed}`;
    };
    const credBtn = document.getElementById('_aipm-credits');
    if (credBtn) {
      credBtn.onclick = async () => {
        close();
        try {
          await consumeCredits(creditCost, result.reason || 'feature unlock');
          _emitEvent('credit-consumed', { amount: creditCost });
        } catch (e) { alert(e.message); }
      };
    }
  }

  /* ================================================================
     checkAndGate(feature, label)
     Convenience wrapper: checks canUse(), shows upgrade prompt if
     not allowed, returns boolean. Use this in all AI feature entry points.
  ================================================================ */
  async function checkAndGate(feature, label) {
    const result = await canUse(feature);
    if (!result.allowed) {
      showUpgradePrompt({ ...result, reason: result.reason || `${label || feature} requires a higher plan.` });
      return false;
    }
    await track(feature);
    return true;
  }

  /* ================================================================
     getActiveBoosts()
  ================================================================ */
  async function getActiveBoosts() {
    const u = uid();
    if (!u) return [];
    try {
      const { collection, query, where, getDocs } = await fsdk();
      const now  = Date.now();
      const snap = await getDocs(
        query(collection(db(), 'aiBoosts'), where('uid', '==', u), where('expiresAt', '>', now))
      );
      return snap.docs.map(d => ({ id: d.id, ...d.data() }));
    } catch { return []; }
  }

  /* ================================================================
     Admin helpers
  ================================================================ */
  async function adminGetStats() {
    const u = uid();
    if (!u) throw new Error('Authentication required.');
    const user = global.firebaseAuth?.currentUser;
    const token = await user?.getIdTokenResult();
    if (!token?.claims?.admin) throw new Error('Admin access required.');

    try {
      const { collection, query, where, getDocs, orderBy, limit } = await fsdk();
      const [activeSubs, trialSubs] = await Promise.all([
        getDocs(query(collection(db(), 'aiSubscriptions'), where('status', '==', 'active'))),
        getDocs(query(collection(db(), 'aiSubscriptions'), where('status', '==', 'trial'))),
      ]);

      const stats = { planCounts: {}, mrr: 0, arr: 0, totalActive: 0, totalTrial: 0 };
      activeSubs.forEach(d => {
        const sub  = d.data();
        const plan = PLANS[sub.plan];
        if (!plan) return;
        const price = sub.billing === 'annual' ? plan.annualPrice / 12 : plan.price;
        stats.mrr += price;
        stats.planCounts[sub.plan] = (stats.planCounts[sub.plan] || 0) + 1;
        stats.totalActive++;
      });
      stats.totalTrial = trialSubs.size;
      stats.arr = Math.round(stats.mrr * 12);
      return stats;
    } catch (e) { throw new Error('Failed to load stats: ' + e.message); }
  }

  async function adminListSubscribers(limit = 50) {
    try {
      const { collection, query, orderBy: ob, limit: lim, getDocs } = await fsdk();
      const snap = await getDocs(
        query(collection(db(), 'aiSubscriptions'), ob('activatedAt', 'desc'), lim(limit))
      );
      return snap.docs.map(d => ({ id: d.id, ...d.data() }));
    } catch { return []; }
  }

  async function adminUpdatePlanConfig(planId, config) {
    if (!PLANS[planId]) throw new Error(`Unknown plan: ${planId}`);
    const { doc, setDoc } = await fsdk();
    await setDoc(doc(db(), 'aiPlanOverrides', planId), {
      ...config, planId, updatedAt: Date.now(),
    }, { merge: true });
    /* Merge into in-memory plan */
    Object.assign(PLANS[planId], config);
  }

  /* ================================================================
     Event bus
  ================================================================ */
  const _listeners = {};
  function on(ev, fn) { (_listeners[ev] = _listeners[ev] || []).push(fn); }
  function off(ev, fn) { _listeners[ev] = (_listeners[ev] || []).filter(f => f !== fn); }
  function _emitEvent(ev, data) {
    (_listeners[ev] || []).forEach(f => { try { f(data); } catch { /* ignore */ } });
    global.dispatchEvent(new CustomEvent(`sokoniAISubs:${ev}`, { detail: data }));
  }

  /* ================================================================
     Public API
  ================================================================ */
  const SokoniAISubs = {
    version:          VERSION,
    PLANS,
    CREDIT_COSTS,
    CREDIT_PACKS,
    AI_BOOSTS,
    STORAGE_PACKAGES,
    getSubscription,
    getPlan,
    getUsage,
    canUse,
    track,
    checkAndGate,
    getCredits,
    consumeCredits,
    purchaseCredits,
    subscribe,
    purchaseBoost,
    purchaseStorage,
    getActiveBoosts,
    showUpgradePrompt,
    invalidateCache: _invalidate,
    on,
    off,
    /* Admin */
    admin: {
      getStats:             adminGetStats,
      listSubscribers:      adminListSubscribers,
      updatePlanConfig:     adminUpdatePlanConfig,
    },
  };

  global.SokoniAISubs = SokoniAISubs;
  global.dispatchEvent(new CustomEvent('sokoniAISubsReady'));

})(window);
