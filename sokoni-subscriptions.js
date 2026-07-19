/**
 * SOKONI Subscription Manager  v2.0  (Production)
 *
 * All subscription state is Firestore-backed and Cloud Function-validated.
 * Users CANNOT self-upgrade via DevTools — all plan changes require a real
 * IntaSend-confirmed payment before the Cloud Function activates the plan.
 *
 * Firestore schema:
 *   /subscriptions/{uid}  {
 *     plan:       'free'|'starter'|'pro'|'business',
 *     activatedAt: Timestamp,
 *     expiresAt:   Timestamp,
 *     paymentRef:  string,
 *     providerId:  string,
 *     status:      'active'|'expired'|'cancelled',
 *   }
 *
 * Public API:
 *   await SokoniSubscriptions.getMyPlan()          → 'free'|'starter'|'pro'|'business'
 *   await SokoniSubscriptions.checkFeature(feature) → true|false
 *   SokoniSubscriptions.isFeatureAllowed(feature)   → true|false (sync, cached)
 *   SokoniSubscriptions.PLANS                        → plan definitions
 */

(function (window) {
  'use strict';

  const log = window.SokoniLogger || { log:()=>{}, warn:()=>{}, error:()=>{} };

  /* Cache TTL: 5 minutes.  Role changes need a page reload to reflect anyway. */
  const CACHE_TTL_MS = 5 * 60 * 1000;
  let _cache = null; /* { plan, ts } */

  /* ── Plan definitions (read-only; same as sokoni-pay.js PLANS) ── */
  const PLANS = {
    free:     { level:0, listings:3,   badge:false, featured:false, leads:5   },
    starter:  { level:1, listings:20,  badge:true,  featured:false, leads:30  },
    pro:      { level:2, listings:999, badge:true,  featured:true,  leads:999 },
    business: { level:3, listings:999, badge:true,  featured:true,  leads:999 },
  };

  /* Features locked behind paid plans */
  const FEATURE_REQUIREMENTS = {
    listMore:       'starter',   /* More than 3 listings */
    reducedFee:     'starter',   /* Commission < 15% */
    verifiedBadge:  'starter',   /* Verified seller badge */
    featuredSearch: 'pro',       /* Appear in featured search */
    unlimitedLeads: 'pro',       /* Unlimited leads */
    homepageSlot:   'business',  /* Homepage featured slot */
    prioritySupport:'business',  /* Priority support channel */
    apiAccess:      'business',  /* Platform API access */
  };

  function _planLevel(planName) {
    return (PLANS[planName] || PLANS.free).level;
  }

  /* ══════════════════════════════════════════════════════════════
     READ SUBSCRIPTION FROM FIRESTORE
  ══════════════════════════════════════════════════════════════ */
  async function _fetchFromFirestore(uid) {
    const db = window.firebaseDB;
    if (!db || !uid) return null;

    try {
      const { doc, getDoc } = await import(
        'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js'
      );
      const snap = await getDoc(doc(db, 'subscriptions', uid));
      if (!snap.exists()) return null;

      const data = snap.data();
      const now  = Date.now();

      /* Validate expiry on the client — server is authoritative but this prevents
         showing expired features in the UI */
      const expiresMs = data.expiresAt?.toMillis ? data.expiresAt.toMillis() : (data.expiresAt || 0);
      if (expiresMs && expiresMs < now) {
        log.log('Subscription expired:', data.plan);
        return { plan: 'free', expired: true };
      }

      return { plan: data.plan || 'free', status: data.status, expiresAt: expiresMs };
    } catch (err) {
      log.warn('Subscription fetch failed:', err.message);
      return null;
    }
  }

  /* ══════════════════════════════════════════════════════════════
     PUBLIC: getMyPlan()
     Returns the authenticated user's current plan.
     Falls back to 'free' if unauthenticated or Firestore unreachable.
  ══════════════════════════════════════════════════════════════ */
  async function getMyPlan() {
    /* Use cache if fresh */
    if (_cache && Date.now() - _cache.ts < CACHE_TTL_MS) {
      return _cache.plan;
    }

    const auth = window.firebaseAuth;
    if (!auth?.currentUser) return 'free';

    const sub = await _fetchFromFirestore(auth.currentUser.uid);
    const plan = (sub && sub.plan) || 'free';

    _cache = { plan, ts: Date.now() };
    log.log('Subscription plan:', plan);
    return plan;
  }

  /* ══════════════════════════════════════════════════════════════
     PUBLIC: getProviderPlan(providerId)
     For backwards compatibility with sokoni-pay.js getProviderPlan().
     Reads from Firestore by provider UID.
  ══════════════════════════════════════════════════════════════ */
  async function getProviderPlan(providerId) {
    if (!providerId) return 'free';
    const db = window.firebaseDB;
    if (!db) return 'free';

    try {
      const { doc, getDoc } = await import(
        'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js'
      );
      const snap = await getDoc(doc(db, 'subscriptions', providerId));
      if (!snap.exists()) return 'free';
      const data = snap.data();
      const now  = Date.now();
      const exp  = data.expiresAt?.toMillis ? data.expiresAt.toMillis() : 0;
      if (exp && exp < now) return 'free';
      return data.plan || 'free';
    } catch (_) { return 'free'; }
  }

  /* ══════════════════════════════════════════════════════════════
     PUBLIC: checkFeature(featureName)
     Returns true if the current user's plan unlocks the feature.
  ══════════════════════════════════════════════════════════════ */
  async function checkFeature(featureName) {
    const plan    = await getMyPlan();
    const reqPlan = FEATURE_REQUIREMENTS[featureName];
    if (!reqPlan) return true; /* Unknown features are not gated */
    return _planLevel(plan) >= _planLevel(reqPlan);
  }

  /* Synchronous version using cached plan (may be stale for up to 5 min) */
  function isFeatureAllowed(featureName) {
    const plan    = _cache ? _cache.plan : 'free';
    const reqPlan = FEATURE_REQUIREMENTS[featureName];
    if (!reqPlan) return true;
    return _planLevel(plan) >= _planLevel(reqPlan);
  }

  /* ══════════════════════════════════════════════════════════════
     PUBLIC: activateSubscription(plan, paymentRef)
     Called by Cloud Function webhook — not directly by client.
     Client calls the CF, which writes to Firestore, which triggers
     this to refresh the cache.
  ══════════════════════════════════════════════════════════════ */
  async function activateSubscription(plan, paymentRef) {
    const auth = window.firebaseAuth;
    if (!auth?.currentUser) throw new Error('Not authenticated');

    try {
      const { getFunctions, httpsCallable } = await import(
        'https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js'
      );
      const fns = getFunctions(window.firebaseApp, 'us-central1');
      const fn  = httpsCallable(fns, 'activateSubscription');
      const result = await fn({ plan, paymentRef });

      /* Refresh local cache after activation */
      _cache = { plan, ts: Date.now() };
      log.log('Subscription activated:', plan, 'ref:', paymentRef);
      return result.data;
    } catch (err) {
      log.error('Subscription activation failed:', err.message);
      throw err;
    }
  }

  /* ══════════════════════════════════════════════════════════════
     PUBLIC: showUpgradePrompt(requiredPlan)
     Shows a UI prompt when a feature requires a higher plan.
  ══════════════════════════════════════════════════════════════ */
  function showUpgradePrompt(requiredPlan) {
    const planDef = PLANS[requiredPlan];
    if (!planDef) return;

    const existing = document.getElementById('_sokoniUpgradePrompt');
    if (existing) existing.remove();

    const modal = document.createElement('div');
    modal.id = '_sokoniUpgradePrompt';
    modal.style.cssText = `
      position:fixed;inset:0;z-index:var(--sk-z-sheet,100010);background:rgba(0,0,0,0.7);
      display:flex;align-items:center;justify-content:center;padding:20px;
    `;
    const planLabel = requiredPlan.charAt(0).toUpperCase() + requiredPlan.slice(1);
    modal.innerHTML = `
      <div style="background:#111;border:1px solid rgba(113,255,0,0.2);border-radius:20px;
                  padding:28px 24px;max-width:340px;width:100%;text-align:center;">
        <div style="font-size:48px;margin-bottom:12px;">&#128274;</div>
        <h3 style="color:white;font-size:18px;font-weight:900;margin:0 0 8px;">
          ${planLabel} Plan Required
        </h3>
        <p style="color:rgba(255,255,255,0.5);font-size:13px;line-height:1.6;margin:0 0 20px;">
          Upgrade to unlock this feature and grow your business on SOKONI.
        </p>
        <button onclick="window.location.href='subscriptions.html'"
          style="width:100%;padding:13px;background:linear-gradient(135deg,#71ff00,#4fc800);
                 color:black;font-weight:900;font-size:14px;border:none;border-radius:12px;
                 cursor:pointer;font-family:inherit;margin-bottom:10px;">
          &#128640; Upgrade to ${planLabel}
        </button>
        <button id="_sokoniUpgradeClose"
          style="width:100%;padding:11px;background:transparent;border:1px solid rgba(255,255,255,0.1);
                 color:rgba(255,255,255,0.4);font-size:13px;font-weight:700;border-radius:12px;
                 cursor:pointer;font-family:inherit;">
          Not Now
        </button>
      </div>`;
    document.body.appendChild(modal);
    modal.querySelector('#_sokoniUpgradeClose').onclick = () => modal.remove();
    modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
  }

  /* Invalidate cache (e.g., after plan upgrade) */
  function invalidateCache() { _cache = null; }

  /* ══════════════════════════════════════════════════════════════
     BACKWARDS COMPAT — replaces sokoni-pay.js getProviderPlan/savePlanSubscription
  ══════════════════════════════════════════════════════════════ */
  window.SokoniSubscriptions = {
    PLANS,
    FEATURE_REQUIREMENTS,
    getMyPlan,
    getProviderPlan,
    checkFeature,
    isFeatureAllowed,
    activateSubscription,
    showUpgradePrompt,
    invalidateCache,
  };

  /* Override the legacy sokoni-pay.js functions if SokoniPay is already loaded */
  document.addEventListener('DOMContentLoaded', function () {
    if (window.SokoniPay) {
      window.SokoniPay.getProviderPlan  = getProviderPlan;
      window.SokoniPay.savePlanSubscription = function (providerId, plan) {
        log.warn('savePlanSubscription() via localStorage is disabled in production. Use activateSubscription().');
      };
    }
  });

})(window);
