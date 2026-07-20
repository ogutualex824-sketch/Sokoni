/**
 * SOKONI Subscription Manager  v3.0  (Production — OMEGA Certified)
 *
 * All subscription state is Firestore-backed and Cloud Function-validated.
 * Users CANNOT self-upgrade via DevTools — all plan changes require a real
 * IntaSend-confirmed payment before the Cloud Function activates the plan.
 *
 * v3.0 additions (OMEGA certification):
 *   • Real-time onSnapshot listener on subscriptions/{uid} — no page reload needed
 *   • Dispatches 'sokoni:subscription:changed' CustomEvent on any plan change
 *   • activateSubscription() re-reads from Firestore after CF call (never trusts client arg)
 *   • _fetchFromFirestore() now also checks status === 'cancelled'
 *   • Auth-state listener auto-starts/stops the snapshot on sign-in/sign-out
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
 *   window event 'sokoni:subscription:changed'       → { detail: { plan, listings } }
 */

(function (window) {
  'use strict';

  const log = window.SokoniLogger || { log:()=>{}, warn:()=>{}, error:()=>{} };

  /* Cache TTL: 5 minutes. */
  const CACHE_TTL_MS  = 5 * 60 * 1000;
  let _cache          = null; /* { plan, ts } */
  let _snapshotUnsub  = null; /* Firestore onSnapshot unsubscribe handle */

  /* ── Plan definitions (read-only; mirrors sokoni-pay.js PLANS) ── */
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

  /* Dispatch a window event when the active plan changes. */
  function _dispatchPlanChange(plan) {
    try {
      window.dispatchEvent(new CustomEvent('sokoni:subscription:changed', {
        detail: { plan, listings: (PLANS[plan] || PLANS.free).listings },
        bubbles: false,
      }));
    } catch (_) {}
  }

  /* ══════════════════════════════════════════════════════════════
     READ SUBSCRIPTION FROM FIRESTORE  (one-shot)
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

      /* Cancelled subscription — treat as free immediately */
      if (data.status === 'cancelled' || data.status === 'CANCELLED') {
        log.log('[SokoniSubscriptions] Subscription cancelled — returning free');
        return { plan: 'free', cancelled: true };
      }

      /* Validate expiry on the client — server is authoritative but this prevents
         showing expired features in the UI before the next auth token refresh */
      const expiresMs = data.expiresAt?.toMillis ? data.expiresAt.toMillis() : (data.expiresAt || 0);
      if (expiresMs && expiresMs < now) {
        log.log('[SokoniSubscriptions] Subscription expired:', data.plan);
        return { plan: 'free', expired: true };
      }

      return { plan: data.plan || 'free', status: data.status, expiresAt: expiresMs };
    } catch (err) {
      log.warn('[SokoniSubscriptions] Firestore fetch failed:', err.message);
      return null;
    }
  }

  /* ══════════════════════════════════════════════════════════════
     REAL-TIME LISTENER
     Sets up onSnapshot on subscriptions/{uid}.  Auto-started by
     DOMContentLoaded → onAuthStateChanged.  Updates cache and
     dispatches 'sokoni:subscription:changed' on every server write.
  ══════════════════════════════════════════════════════════════ */
  async function _setupRealtimeListener(uid) {
    /* Tear down any stale listener first (e.g. uid changed) */
    if (_snapshotUnsub) {
      try { _snapshotUnsub(); } catch (_) {}
      _snapshotUnsub = null;
    }
    if (!uid) return;

    const db = window.firebaseDB;
    if (!db) return;

    try {
      const { doc, onSnapshot } = await import(
        'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js'
      );
      _snapshotUnsub = onSnapshot(
        doc(db, 'subscriptions', uid),
        (snap) => {
          if (!snap.exists()) {
            _cache = { plan: 'free', ts: Date.now() };
            _dispatchPlanChange('free');
            return;
          }
          const data = snap.data();
          const now  = Date.now();

          /* Cancelled → downgrade to free */
          if (data.status === 'cancelled' || data.status === 'CANCELLED') {
            _cache = { plan: 'free', ts: Date.now() };
            _dispatchPlanChange('free');
            return;
          }
          /* Expired → downgrade to free */
          const exp = data.expiresAt?.toMillis ? data.expiresAt.toMillis() : (data.expiresAt || 0);
          if (exp && exp < now) {
            _cache = { plan: 'free', ts: Date.now() };
            _dispatchPlanChange('free');
            return;
          }

          const plan     = data.plan || 'free';
          const prevPlan = _cache?.plan;
          /* Always refresh the cache TTL on every snapshot */
          _cache = { plan, ts: Date.now() };
          /* Only dispatch if the plan value actually changed */
          if (plan !== prevPlan) {
            log.log('[SokoniSubscriptions] Plan changed via snapshot:', prevPlan, '→', plan);
            _dispatchPlanChange(plan);
          }
        },
        (err) => {
          log.warn('[SokoniSubscriptions] Snapshot error — will retry on next getMyPlan():', err.message);
        }
      );
      log.log('[SokoniSubscriptions] Real-time listener active, uid:', uid);
    } catch (err) {
      log.warn('[SokoniSubscriptions] Could not start real-time listener:', err.message);
    }
  }

  /* ══════════════════════════════════════════════════════════════
     PUBLIC: getMyPlan()
     Returns the authenticated user's current plan.
     Falls back to 'free' if unauthenticated or Firestore unreachable.
  ══════════════════════════════════════════════════════════════ */
  async function getMyPlan() {
    /* Use cache if fresh (real-time listener also keeps this updated) */
    if (_cache && Date.now() - _cache.ts < CACHE_TTL_MS) {
      return _cache.plan;
    }

    const auth = window.firebaseAuth;
    if (!auth?.currentUser) return 'free';

    const sub  = await _fetchFromFirestore(auth.currentUser.uid);
    const plan = (sub && sub.plan) || 'free';

    _cache = { plan, ts: Date.now() };
    log.log('[SokoniSubscriptions] Plan fetched:', plan);
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
      /* Respect cancelled status */
      if (data.status === 'cancelled' || data.status === 'CANCELLED') return 'free';
      const now = Date.now();
      const exp = data.expiresAt?.toMillis ? data.expiresAt.toMillis() : 0;
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

  /* Synchronous version using cached plan (may be stale for up to 5 min).
     The real-time listener keeps the cache fresh, so stale reads are rare. */
  function isFeatureAllowed(featureName) {
    const plan    = _cache ? _cache.plan : 'free';
    const reqPlan = FEATURE_REQUIREMENTS[featureName];
    if (!reqPlan) return true;
    return _planLevel(plan) >= _planLevel(reqPlan);
  }

  /* ══════════════════════════════════════════════════════════════
     PUBLIC: activateSubscription(plan, paymentRef)
     Calls the activateSubscription Cloud Function, then re-reads
     Firestore to verify the plan — never trusts the client-supplied
     plan argument as the source of truth.
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

      /* Invalidate stale cache and re-read from Firestore.
         The real-time listener will also fire when Firestore updates,
         but we dispatch immediately to minimise visible latency. */
      invalidateCache();
      const freshPlan = await getMyPlan();
      _dispatchPlanChange(freshPlan);
      log.log('[SokoniSubscriptions] Activated — Firestore confirmed plan:', freshPlan);
      return result.data;
    } catch (err) {
      log.error('[SokoniSubscriptions] Activation failed:', err.message);
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

  /* Invalidate cache (forces next getMyPlan() to re-read Firestore) */
  function invalidateCache() { _cache = null; }

  /* ══════════════════════════════════════════════════════════════
     BACKWARDS COMPAT — replaces sokoni-pay.js getProviderPlan / savePlanSubscription
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

  /* ── DOMContentLoaded: patch legacy SokoniPay API + start real-time listener ── */
  document.addEventListener('DOMContentLoaded', function () {
    /* Override legacy sokoni-pay.js stubs */
    if (window.SokoniPay) {
      window.SokoniPay.getProviderPlan      = getProviderPlan;
      window.SokoniPay.savePlanSubscription = function () {
        log.warn('[SokoniSubscriptions] savePlanSubscription() is disabled — use activateSubscription() CF.');
      };
    }

    /* Start real-time Firestore listener when user is authenticated.
       Tears down automatically on sign-out and restarts on sign-in. */
    const auth = window.firebaseAuth;
    if (auth && typeof auth.onAuthStateChanged === 'function') {
      auth.onAuthStateChanged(function (user) {
        if (user) {
          _setupRealtimeListener(user.uid);
        } else {
          /* User signed out — tear down listener and clear cache */
          if (_snapshotUnsub) {
            try { _snapshotUnsub(); } catch (_) {}
            _snapshotUnsub = null;
          }
          invalidateCache();
        }
      });
    }
  });

})(window);
