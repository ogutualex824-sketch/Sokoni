/**
 * SOKONI Subscription Client SDK  v1.0
 * ─────────────────────────────────────
 * Lightweight browser library for feature-flag checks and quota lookups.
 * Reads from user.subscription.{hubType} on the Firestore user profile
 * (mirrored there by subActivate CF on every activation).
 *
 * Usage:
 *   await SokoniSub.init('seller');           // start real-time listener
 *   SokoniSub.has('analytics');               // → true / false
 *   SokoniSub.quota('listings_limit');        // → number (-1 = unlimited)
 *   SokoniSub.plan();                         // → { planId, tier, status }
 *   SokoniSub.isActive();                     // → true if ACTIVE or TRIALING
 *   SokoniSub.on('change', cb);              // subscribe to plan changes
 *   SokoniSub.subscribe('seller_pro','monthly'); // open checkout flow
 */
(function (root) {
  'use strict';

  const CACHE_KEY   = 'sokoni_sub_cache';
  const ACTIVE_STATUSES = new Set(['active', 'trialing', 'grace']);

  /* ── Default free features (fallback when no subscription loaded) ── */
  const FREE_DEFAULTS = {
    listings_limit: 10, photos_per_listing: 3, featured_listings: 0,
    analytics: false, bulk_import: false, priority_support: false,
    ai_assistant: false, team_members: 1, storage_gb: 1,
    services_limit: 3, menu_items: 20, job_posts: 3,
  };

  let _uid        = null;
  let _hubType    = null;
  let _sub        = null;       /* current subscription snapshot */
  let _unsub      = null;       /* Firestore listener unsubscribe */
  let _listeners  = {};         /* event → [callback] */
  let _db         = null;
  let _fns        = null;
  let _initialized = false;

  /* ── Internal helpers ── */
  function _emit(event, data) {
    (_listeners[event] || []).forEach(fn => { try { fn(data); } catch(e) {} });
  }

  function _load() {
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      if (raw) _sub = JSON.parse(raw);
    } catch(e) {}
  }

  function _save(sub) {
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(sub)); } catch(e) {}
  }

  function _features() {
    return (_sub && _sub.features) ? _sub.features : FREE_DEFAULTS;
  }

  function _getDb() {
    if (!_db) _db = firebase.firestore();
    return _db;
  }
  function _getFns() {
    if (!_fns) _fns = firebase.functions();
    return _fns;
  }

  function _stopListener() {
    if (_unsub) { try { _unsub(); } catch(e) {} _unsub = null; }
  }

  /* ── Start real-time listener on user profile subscription field ── */
  function _startListener(uid, hubType) {
    _stopListener();
    _unsub = _getDb().collection('users').doc(uid).onSnapshot(snap => {
      if (!snap.exists) return;
      const d = snap.data();
      const subData = (d.subscription && d.subscription[hubType]) || null;

      if (subData) {
        _sub = subData;
        _save(subData);
        _emit('change', subData);

        /* Reflect on UI elements */
        _applyToDOM(subData);
      }
    }, err => {
      console.warn('[SokoniSub] listener error', err);
    });
  }

  /* Update DOM elements marked with data-sub-feature, data-sub-quota, data-sub-plan */
  function _applyToDOM(sub) {
    const features = sub?.features || FREE_DEFAULTS;
    const tier     = sub?.tier || 'free';
    const isActive = ACTIVE_STATUSES.has(sub?.status || '');

    /* data-sub-feature="analytics" — show/hide based on feature flag */
    document.querySelectorAll('[data-sub-feature]').forEach(el => {
      const feat = el.dataset.subFeature;
      const has  = !!features[feat];
      el.style.display = has ? '' : 'none';
    });

    /* data-sub-lock="analytics" — add/remove .sub-locked class */
    document.querySelectorAll('[data-sub-lock]').forEach(el => {
      const feat = el.dataset.subLock;
      const has  = !!features[feat];
      el.classList.toggle('sub-locked', !has);
    });

    /* data-sub-quota="listings_limit" — fill textContent with quota value */
    document.querySelectorAll('[data-sub-quota]').forEach(el => {
      const key = el.dataset.subQuota;
      const val = features[key];
      el.textContent = val === -1 ? 'Unlimited' : (val ?? '—');
    });

    /* data-sub-plan — fill with current plan tier */
    document.querySelectorAll('[data-sub-plan]').forEach(el => {
      el.textContent = tier.charAt(0).toUpperCase() + tier.slice(1);
    });

    /* data-sub-status — fill with status badge */
    document.querySelectorAll('[data-sub-status]').forEach(el => {
      el.textContent = sub?.status || 'free';
      el.className   = el.className.replace(/\bstatus-\S+/g, '') + ` status-${sub?.status || 'free'}`;
    });

    /* data-sub-active — show only when active/trialing */
    document.querySelectorAll('[data-sub-active]').forEach(el => {
      el.style.display = isActive ? '' : 'none';
    });

    /* data-sub-inactive — show only when NOT active */
    document.querySelectorAll('[data-sub-inactive]').forEach(el => {
      el.style.display = isActive ? 'none' : '';
    });
  }

  /* ══════════════════════════════════════════════════════
     Public API
  ══════════════════════════════════════════════════════ */
  const SokoniSub = {

    /**
     * init(hubType) — call once after Firebase Auth is ready.
     * @param {string} hubType  e.g. 'seller', 'restaurant', 'driver'
     * @returns Promise<void>
     */
    init(hubType) {
      _hubType = hubType || 'seller';
      _load(); /* restore cached sub immediately for instant UI */

      return new Promise((resolve) => {
        firebase.auth().onAuthStateChanged(user => {
          if (!user) { _uid = null; _sub = null; _stopListener(); resolve(); return; }
          _uid = user.uid;

          if (!_initialized) {
            _initialized = true;
            _startListener(_uid, _hubType);
          }

          /* Also do a one-time fetch for freshness */
          _getDb().collection('users').doc(_uid).get().then(snap => {
            if (!snap.exists) { resolve(); return; }
            const subData = (snap.data().subscription || {})[_hubType] || null;
            if (subData) { _sub = subData; _save(subData); _applyToDOM(subData); _emit('change', subData); }
            resolve();
          }).catch(() => resolve());
        });
      });
    },

    /** Check if the current user's plan includes a feature flag */
    has(feature) { return !!_features()[feature]; },

    /** Get quota limit. Returns -1 for unlimited, 0 if no plan. */
    quota(resource) {
      const val = _features()[resource];
      return val === undefined ? 0 : val;
    },

    /** Returns true if quota allows N more of this resource (pass current count) */
    withinQuota(resource, currentCount) {
      const limit = this.quota(resource);
      return limit === -1 || currentCount < limit;
    },

    /** Current plan info */
    plan() {
      return {
        planId:  _sub?.planId  || `${_hubType}_free`,
        tier:    _sub?.tier    || 'free',
        status:  _sub?.status  || 'free',
        name:    _sub?.planName|| 'Free',
        expiresAt: _sub?.expiresAt || null,
      };
    },

    /** True if subscription is ACTIVE or TRIALING */
    isActive() { return ACTIVE_STATUSES.has(_sub?.status || ''); },

    /** True if status is 'grace' — still has access but needs payment */
    inGrace()  { return _sub?.status === 'grace'; },

    /** True if expired or cancelled */
    isExpired() { return ['expired', 'cancelled'].includes(_sub?.status); },

    /** Subscribe to SDK events: 'change' */
    on(event, fn) {
      if (!_listeners[event]) _listeners[event] = [];
      _listeners[event].push(fn);
      return () => { _listeners[event] = _listeners[event].filter(f => f !== fn); };
    },

    /** Fetch all plans for the current hub type from the CF */
    async getPlans() {
      const fn = _getFns().httpsCallable('subGetPlans');
      const r  = await fn({ hubType: _hubType });
      return r.data.plans;
    },

    /**
     * Activate a subscription after M-PESA payment is confirmed.
     * Pass the IntaSend trackingId as paymentRef.
     */
    async activate({ planId, billingCycle, paymentRef, isTrial }) {
      const fn = _getFns().httpsCallable('subActivate');
      const r  = await fn({ planId, billingCycle, paymentRef, isTrial });
      /* Update local cache immediately */
      if (r.data.features) {
        _sub = { ..._sub, planId: r.data.planId, status: r.data.status, features: r.data.features };
        _save(_sub); _applyToDOM(_sub); _emit('change', _sub);
      }
      return r.data;
    },

    /** Start a trial for a plan */
    async startTrial(planId) {
      return this.activate({ planId, billingCycle: 'monthly', isTrial: true });
    },

    /** Cancel subscription */
    async cancel(subscriptionId, immediate = false) {
      const fn = _getFns().httpsCallable('subCancel');
      return (await fn({ subscriptionId, immediate })).data;
    },

    /** Reactivate a pending-cancellation */
    async reactivate(subscriptionId) {
      const fn = _getFns().httpsCallable('subReactivate');
      return (await fn({ subscriptionId })).data;
    },

    /** Get billing history */
    async getBillingHistory(limit = 10) {
      const fn = _getFns().httpsCallable('subGetBillingHistory');
      return (await fn({ limit })).data.history;
    },

    /** Get full subscription status from server */
    async getStatus() {
      const fn = _getFns().httpsCallable('subGetStatus');
      return (await fn({})).data;
    },

    /**
     * Enforce a feature gate — shows upgrade modal if feature is not included.
     * Returns true if allowed, false if blocked.
     */
    require(feature, options = {}) {
      if (this.has(feature)) return true;
      this.showUpgradePrompt({ feature, ...options });
      return false;
    },

    /** Enforce quota — shows upgrade modal if over limit */
    requireQuota(resource, currentCount, options = {}) {
      if (this.withinQuota(resource, currentCount)) return true;
      this.showUpgradePrompt({ resource, currentCount, ...options });
      return false;
    },

    /** Show upgrade prompt modal */
    showUpgradePrompt({ feature, resource, message } = {}) {
      const existing = document.getElementById('sokoni-upgrade-modal');
      if (existing) existing.remove();

      const plan = this.plan();
      const msg  = message
        || (feature  ? `This feature requires a higher plan.`
          : resource ? `You've reached your ${resource.replace(/_/g,' ')} limit.`
          :             'Upgrade your plan to unlock more features.');

      const modal = document.createElement('div');
      modal.id    = 'sokoni-upgrade-modal';
      modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.75);z-index:9999;display:flex;align-items:center;justify-content:center;font-family:Inter,sans-serif';
      modal.innerHTML = `
        <div style="background:#111;border:1px solid #2a2a2a;border-radius:16px;padding:28px 32px;max-width:400px;width:90%;text-align:center">
          <div style="font-size:32px;margin-bottom:12px">⚡</div>
          <h2 style="color:#71ff00;font-size:20px;font-weight:900;margin-bottom:8px">Upgrade Required</h2>
          <p style="color:#9ca3af;font-size:13px;line-height:1.6;margin-bottom:20px">${msg}</p>
          <p style="font-size:11px;color:#4b5563;margin-bottom:20px">Current plan: <strong style="color:#9ca3af">${plan.name}</strong></p>
          <a href="pricing.html?hub=${_hubType || ''}" style="display:block;background:#71ff00;color:#000;font-weight:900;font-size:14px;padding:12px;border-radius:10px;text-decoration:none;margin-bottom:10px">View Plans →</a>
          <button onclick="document.getElementById('sokoni-upgrade-modal').remove()" style="background:none;border:none;color:#4b5563;font-size:12px;cursor:pointer">Maybe later</button>
        </div>`;
      document.body.appendChild(modal);
      modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
    },

    /** Re-apply DOM bindings (call after dynamic content inserts) */
    refresh() { if (_sub) _applyToDOM(_sub); },

    /** Destroy listeners and clear state */
    destroy() { _stopListener(); _initialized = false; _uid = null; _sub = null; },
  };

  /* Export */
  if (typeof module !== 'undefined' && module.exports) { module.exports = SokoniSub; }
  else { root.SokoniSub = SokoniSub; }

}(typeof window !== 'undefined' ? window : global));
