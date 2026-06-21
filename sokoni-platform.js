/* ================================================================
   SOKONI UNIVERSAL PLATFORM BOOTSTRAP  v1.0.0  |  2026-06-21
   sokoni-platform.js

   Single entrypoint that initialises ALL platform services on
   any SOKONI page. Include this once; it auto-wires:

     ✓ Firebase Auth
     ✓ SASOS Entitlement Service (zero-trust feature gates)
     ✓ sokoni-event-bus.js (client-side typed event bus)
     ✓ sokoni-service-mesh.js (service registry + circuit breakers)
     ✓ sokoni-fraud-engine.js (fraud signal reporting)
     ✓ sokoni-observability.js (APM + distributed tracing)
     ✓ sokoni-gateway.js (rate limiting + API management)
     ✓ SASOS Risk Profile (trust score monitoring)
     ✓ Server-side Platform Registry (self-registration)
     ✓ Server-side Event Bus (publish/subscribe)

   Usage (add to every HTML page AFTER firebase SDKs):
     <script src="/sokoni-platform.js"></script>
     <script>
       SokoniPlatform.init({ serviceId: 'marketplace', product: 'marketplace' });
     </script>

   Or with full options:
     SokoniPlatform.init({
       serviceId:     'marketplace',      // required — registry key
       name:          'Marketplace',      // display name
       product:       'marketplace',      // SASOS product key
       type:          'product',          // platform | product | integration
       version:       '1.0.0',
       uses:          ['subscriptions','billing','fraud_detection','search'],
       publishesEvents: ['Order.Created','Order.Paid'],
       subscribesEvents: ['Payment.Failed','Fraud.Detected'],
       dependsOn:     ['sasos','wap'],
       onReady:       () => console.log('Platform ready'),
     });

   After init, use the unified API:
     await SokoniPlatform.checkFeature('ai', 'aiChat');
     await SokoniPlatform.recordUsage('marketplace', 'listings', 1);
     await SokoniPlatform.publish('Order.Created', { orderId: '...' });
     SokoniPlatform.subscribe('Payment.Failed', payload => { ... });
     SokoniPlatform.getUser()  → { uid, displayName, plan, trustScore }
================================================================ */
(function (window) {
  'use strict';

  /* ── Internal state ──────────────────────────────────────── */
  let _initialized    = false;
  let _serviceId      = null;
  let _product        = null;
  let _user           = null;
  let _trustScore     = 100;
  let _riskAction     = 'allow';
  let _eventBus       = null;
  let _eventListeners = {};      /* local listeners registered before init */
  let _unsubscribers  = [];      /* Firestore real-time listener cleanup */
  let _heartbeatTimer = null;

  const _featureCache = new Map();   /* feature:product → { result, expiry } */
  const FEATURE_TTL   = 30000;       /* 30s cache for feature checks */

  /* ── CF caller ───────────────────────────────────────────── */
  function _callCF(name, data) {
    if (!window.firebase?.functions) return Promise.reject(new Error('Firebase Functions not loaded'));
    return firebase.functions().httpsCallable(name)(data).then(r => r.data);
  }

  /* ── Event Bus bridge ────────────────────────────────────── */
  function _getEventBus() {
    /* Use existing sokoni-event-bus.js if loaded */
    if (window.SokoniEventBus) return window.SokoniEventBus;
    return null;
  }

  /* ── Minimal fallback event bus (if sokoni-event-bus.js not loaded) ─── */
  const _localBus = (() => {
    const _subs = {};
    return {
      on:  (type, fn) => { (_subs[type] ||= []).push(fn); },
      off: (type, fn) => { if (_subs[type]) _subs[type] = _subs[type].filter(f => f !== fn); },
      emit:(type, payload) => { (_subs[type] || []).forEach(fn => { try { fn(payload); } catch (_) {} }); (_subs['*'] || []).forEach(fn => { try { fn({ type, payload }); } catch (_) {} }); },
    };
  })();

  function _emit(type, payload) {
    const eb = _getEventBus();
    if (eb?.emit) eb.emit(type, payload);
    _localBus.emit(type, payload);
  }

  function _on(type, fn) {
    const eb = _getEventBus();
    if (eb?.on) eb.on(type, fn);
    _localBus.on(type, fn);
  }

  /* ── Risk monitoring ─────────────────────────────────────── */
  async function _refreshRiskProfile() {
    if (!_user) return;
    try {
      const r = await _callCF('sasosGetRiskProfile', {});
      _trustScore = r.trustScore || 100;
      _riskAction = r.action || 'allow';

      if (_riskAction === 'suspend') {
        _emit('Platform.AccountSuspended', { trustScore: _trustScore });
        console.warn('[SokoniPlatform] Account suspended — fraud risk.');
      } else if (_riskAction === 'restrict') {
        _emit('Platform.AccountRestricted', { trustScore: _trustScore });
      }
    } catch (_) { /* non-fatal */ }
  }

  /* ── Self-registration ───────────────────────────────────── */
  async function _registerService(opts) {
    if (!_serviceId || !_user) return;
    try {
      await _callCF('platformRegisterService', {
        serviceId:       opts.serviceId,
        name:            opts.name || opts.serviceId,
        type:            opts.type || 'product',
        version:         opts.version || '1.0.0',
        description:     opts.description || '',
        url:             window.location.pathname,
        uses:            opts.uses || [],
        publishesEvents: opts.publishesEvents || [],
        subscribesEvents: opts.subscribesEvents || [],
        dependsOn:       opts.dependsOn || [],
      });
    } catch (_) { /* registration is best-effort */ }
  }

  /* ── Health heartbeat ────────────────────────────────────── */
  async function _heartbeat() {
    if (!_serviceId || !_user) return;
    const start = Date.now();
    try {
      await _callCF('platformUpdateHealth', {
        serviceId: _serviceId,
        status:    'healthy',
        latencyMs: Date.now() - start,
        errorRate: 0,
        message:   'Client heartbeat',
      });
    } catch (_) { /* non-fatal */ }
  }

  /* ── Observe server-side event stream (Firestore real-time) ─ */
  function _subscribeToServerEvents(domains) {
    if (!window.firebase?.firestore || !domains?.length) return;
    try {
      const since = Date.now() - 5000;  /* events from last 5s onwards */
      const q = firebase.firestore().collection('platformEvents')
        .where('domain', 'in', domains.slice(0, 10))
        .where('publishedAt', '>=', since)
        .orderBy('publishedAt', 'desc').limit(20);

      const unsub = q.onSnapshot(snap => {
        snap.docChanges().forEach(change => {
          if (change.type !== 'added') return;
          const evt = change.doc.data();
          _emit(evt.type, evt.payload);
        });
      });

      _unsubscribers.push(unsub);
    } catch (_) { /* non-fatal if rules prevent */ }
  }

  /* ── Initialize Service Mesh ─────────────────────────────── */
  function _initServiceMesh(opts) {
    const mesh = window.SokoniServiceMesh;
    if (!mesh) return;
    try {
      if (mesh.registerService && _serviceId) {
        mesh.registerService(_serviceId, {
          name:       opts.name || _serviceId,
          version:    opts.version || '1.0.0',
          health:     () => Promise.resolve({ status: 'healthy' }),
        });
      }
    } catch (_) { /* non-fatal */ }
  }

  /* ── Initialize Observability ───────────────────────────── */
  function _initObservability(opts) {
    const obs = window.SokoniObservability;
    if (!obs) return;
    try {
      if (obs.startTransaction) obs.startTransaction(`page_load_${_serviceId || 'unknown'}`);
    } catch (_) { /* non-fatal */ }
  }

  /* ── Initialize Gateway ──────────────────────────────────── */
  function _initGateway() {
    const gw = window.SokoniGateway;
    if (!gw?.init) return;
    try { gw.init(); } catch (_) { /* non-fatal */ }
  }

  /* ── Public API ──────────────────────────────────────────── */
  const SokoniPlatform = {

    /* ── Core initialization ─────────────────────────────── */
    async init(opts = {}) {
      if (_initialized) {
        console.warn('[SokoniPlatform] Already initialized. Call destroy() first to re-init.');
        return this;
      }

      _serviceId = opts.serviceId || null;
      _product   = opts.product   || opts.serviceId || null;

      /* 1. Wait for Firebase Auth state */
      await new Promise(resolve => {
        if (!window.firebase?.auth) { resolve(); return; }
        const unsub = firebase.auth().onAuthStateChanged(user => {
          _user = user;
          unsub();
          resolve();
        });
        /* Timeout after 3s — proceed even if auth is slow */
        setTimeout(resolve, 3000);
      });

      /* 2. Initialize platform subsystems (non-blocking) */
      _initServiceMesh(opts);
      _initObservability(opts);
      _initGateway();

      /* 3. If user is logged in, run auth-dependent init in parallel */
      if (_user) {
        await Promise.allSettled([
          _refreshRiskProfile(),
          opts.serviceId ? _registerService(opts) : Promise.resolve(),
        ]);

        /* 4. Subscribe to server-side event stream for declared domains */
        const domains = (opts.subscribesEvents || [])
          .map(e => e.split('.')[0])
          .filter((d, i, a) => a.indexOf(d) === i);  /* unique */
        if (domains.length) _subscribeToServerEvents(domains);

        /* 5. Start heartbeat (every 2 minutes) */
        if (_serviceId) {
          _heartbeatTimer = setInterval(() => _heartbeat(), 120000);
        }

        /* 6. Refresh risk profile every 5 minutes */
        setInterval(() => _refreshRiskProfile(), 300000);
      }

      /* 7. Flush any pre-init subscriptions */
      Object.entries(_eventListeners).forEach(([type, fns]) => {
        fns.forEach(fn => _on(type, fn));
      });
      _eventListeners = {};

      _initialized = true;
      _emit('Platform.Ready', { serviceId: _serviceId, product: _product, uid: _user?.uid });

      if (opts.onReady) { try { opts.onReady({ user: _user, trustScore: _trustScore }); } catch (_) {} }
      return this;
    },

    destroy() {
      _unsubscribers.forEach(fn => { try { fn(); } catch (_) {} });
      _unsubscribers = [];
      if (_heartbeatTimer) clearInterval(_heartbeatTimer);
      _initialized = false;
      _user = null;
      _featureCache.clear();
    },

    /* ── Auth ──────────────────────────────────────────────── */
    getUser() {
      return _user ? {
        uid:         _user.uid,
        displayName: _user.displayName || '',
        email:       _user.email || '',
        photoURL:    _user.photoURL || '',
        trustScore:  _trustScore,
        riskAction:  _riskAction,
        isRestricted: _riskAction === 'restrict' || _riskAction === 'suspend',
      } : null;
    },

    isSignedIn() { return !!_user; },

    requireAuth(redirectPath) {
      if (!_user) {
        const redir = encodeURIComponent(window.location.href);
        window.location.href = (redirectPath || '/login.html') + `?redirect=${redir}`;
        return false;
      }
      return true;
    },

    /* ── Entitlement (SASOS zero-trust) ──────────────────── */
    async checkFeature(product, featureKey, opts = {}) {
      const cacheKey = `${product}:${featureKey}`;
      const cached   = _featureCache.get(cacheKey);
      if (cached && Date.now() < cached.expiry) return cached.result;

      try {
        const r = await _callCF('sasosCheckFeature', { product, featureKey });
        _featureCache.set(cacheKey, { result: r.allowed === true, expiry: Date.now() + FEATURE_TTL });
        if (!r.allowed) {
          _emit('Platform.FeatureGated', { product, featureKey, requiredPlan: r.requiredPlan });
          /* Delegate gate UI to sokoni-sasos.js if loaded */
          if (opts.showGate !== false && window.SokoniSASOS?.renderGate) {
            window.SokoniSASOS.renderGate({ product, feature: r.featureLabel || featureKey, planName: r.requiredPlan || 'Pro' });
          }
        }
        return r.allowed === true;
      } catch (_) {
        return false; /* fail closed */
      }
    },

    /* Invalidate feature cache for a product (e.g. after upgrade) */
    invalidateFeatureCache(product) {
      for (const key of _featureCache.keys()) {
        if (key.startsWith(product + ':')) _featureCache.delete(key);
      }
    },

    /* ── Usage Metering ──────────────────────────────────── */
    async recordUsage(product, counterKey, amount = 1, meta = {}) {
      try {
        return await _callCF('sasosRecordUsage', { product, counterKey, amount, meta });
      } catch (_) {
        return { allowed: false };
      }
    },

    async checkQuota(product, counterKey, amount = 1) {
      try {
        return await _callCF('sasosCheckQuota', { product, counterKey, amount });
      } catch (_) {
        return { allowed: false };
      }
    },

    /* ── Credits ─────────────────────────────────────────── */
    async deductCredits(product, amount, description) {
      return window.SokoniSASOS
        ? window.SokoniSASOS.deductCredits(product, amount, description)
        : _callCF('sasosDeductCredits', { product, amount, description }).catch(() => ({ success: false }));
    },

    /* ── Event Bus ───────────────────────────────────────── */
    async publish(eventType, payload = {}, opts = {}) {
      /* Always emit locally first (instant) */
      _emit(eventType, payload);

      /* Persist to server if significant */
      if (opts.persist !== false && _user) {
        _callCF('platformPublishEvent', {
          type:           eventType,
          payload,
          sourceService:  _serviceId || '',
          correlationId:  opts.correlationId || null,
          idempotencyKey: opts.idempotencyKey || null,
        }).catch(() => { /* best-effort */ });
      }
    },

    subscribe(eventType, handler) {
      if (!_initialized) {
        /* Queue until init completes */
        (_eventListeners[eventType] ||= []).push(handler);
      } else {
        _on(eventType, handler);
      }
      /* Return unsubscribe function */
      return () => {
        const eb = _getEventBus();
        if (eb?.off) eb.off(eventType, handler);
        _localBus.off(eventType, handler);
      };
    },

    /* Wildcard — receives ALL events as { type, payload } */
    subscribeAll(handler) {
      return this.subscribe('*', handler);
    },

    /* ── Risk & Fraud ────────────────────────────────────── */
    async reportSignal(signalType, context = {}) {
      if (!_user) return;
      _callCF('sasosUpdateRiskScore', {
        signals: [signalType],
        context: {
          userAgent: navigator.userAgent || '',
          page:      window.location.pathname,
          ...context,
        },
      }).catch(() => {});
    },

    getTrustScore()  { return _trustScore; },
    getRiskAction()  { return _riskAction; },
    isRestricted()   { return _riskAction === 'restrict' || _riskAction === 'suspend'; },

    /* ── Workflow ─────────────────────────────────────────── */
    async triggerWorkflow(workflowId, input = {}) {
      try {
        return await _callCF('wapTriggerWorkflow', { workflowId, input, sourceService: _serviceId });
      } catch (e) {
        this.publish('Platform.WorkflowError', { workflowId, error: e.message });
        throw e;
      }
    },

    /* ── Platform Registry ────────────────────────────────── */
    async getRegistry(opts = {}) {
      return _callCF('platformGetRegistry', opts).catch(() => ({ services: [] }));
    },

    async getHealth() {
      return _callCF('platformGetHealth', {}).catch(() => ({ services: [], overallStatus: 'unknown' }));
    },

    async getCapabilityMatrix() {
      return _callCF('platformGetCapabilityMatrix', {}).catch(() => ({ matrix: {}, missingIntegrations: {} }));
    },

    /* ── Search ──────────────────────────────────────────── */
    async search(query, opts = {}) {
      if (window.SokoniSearch?.query) return window.SokoniSearch.query(query, opts);
      if (window.SokoniSearchEngine?.search) return window.SokoniSearchEngine.search(query, opts);
      return { results: [], total: 0 };
    },

    /* ── Analytics ───────────────────────────────────────── */
    track(eventName, properties = {}) {
      const obs = window.SokoniObservability;
      if (obs?.record) {
        obs.record(eventName, { ...properties, serviceId: _serviceId, uid: _user?.uid });
      }
      /* Also publish as a platform event (fire and forget) */
      this.publish(`Analytics.${eventName}`, { ...properties, serviceId: _serviceId }, { persist: false });
    },

    /* ── Notifications ───────────────────────────────────── */
    async sendNotification(userId, title, body, url) {
      return _callCF('sendNotification', { userId, title, body, url }).catch(() => {});
    },

    /* ── AI ──────────────────────────────────────────────── */
    async getInsights() {
      return window.SokoniSASOS?.getInsights
        ? window.SokoniSASOS.getInsights()
        : _callCF('sasosGetInsights', {}).catch(() => ({ scores: {} }));
    },

    async getRecommendations(product) {
      return _callCF('sasosGetRecommendations', { product }).catch(() => ({ recommendations: [] }));
    },

    /* ── Feature Flags ───────────────────────────────────── */
    async getFlag(flagKey, defaultValue = false) {
      if (window.SokoniFeatureFlags?.isEnabled) {
        return window.SokoniFeatureFlags.isEnabled(flagKey);
      }
      /* Fallback: check via EIP */
      try {
        const r = await _callCF('eipGetFlag', { flagKey });
        return r.enabled ?? defaultValue;
      } catch (_) {
        return defaultValue;
      }
    },

    /* ── State ──────────────────────────────────────────── */
    isInitialized: () => _initialized,
    getServiceId:  () => _serviceId,
    getProduct:    () => _product,

    /* ── Debug ──────────────────────────────────────────── */
    _debug() {
      return {
        initialized: _initialized,
        serviceId: _serviceId, product: _product,
        uid: _user?.uid, trustScore: _trustScore, riskAction: _riskAction,
        featureCacheSize: _featureCache.size,
        unsubscribers: _unsubscribers.length,
        eventBusConnected: !!_getEventBus(),
      };
    },
  };

  /* ── Auto-init from data attributes ───────────────────── */
  window.addEventListener('DOMContentLoaded', () => {
    const el = document.querySelector('[data-sokoni-service]');
    if (!el) return;
    const serviceId = el.dataset.sokoniService;
    const product   = el.dataset.sokoniProduct || serviceId;
    if (serviceId && !_initialized) {
      SokoniPlatform.init({
        serviceId,
        product,
        name:    el.dataset.sokoniName || serviceId,
        version: el.dataset.sokoniVersion || '1.0.0',
      });
    }
  });

  /* ── Expose globally ─────────────────────────────────── */
  window.SokoniPlatform = SokoniPlatform;

})(window);
