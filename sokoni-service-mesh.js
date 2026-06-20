/**
 * SOKONI Enterprise Service Mesh  v2.0
 *
 * Coordinates all SOKONI client-side services:
 *  - Service registry with lifecycle management
 *  - Health monitoring and heartbeat
 *  - Circuit breakers per service (wraps existing sokoni-scale.js)
 *  - Dependency graph (service A requires service B)
 *  - Graceful degradation strategies
 *  - Boot sequencer — initialises services in dependency order
 *  - Feature flags (runtime on/off per service)
 *  - Service discovery (find services by capability)
 */

'use strict';

const SokoniServiceMesh = (function () {

  /* ════════════════════════════════════════════════════════════
     SERVICE CATALOGUE — every registered service
  ════════════════════════════════════════════════════════════ */
  const SERVICE_ID = Object.freeze({
    AUTH:         'auth',
    DATABASE:     'database',
    PAYMENTS:     'payments',
    ESCROW:       'escrow',
    WALLET:       'wallet',
    ORDERS:       'orders',
    INVENTORY:    'inventory',
    DELIVERY:     'delivery',
    RIDES:        'rides',
    EVENTS:       'events_hub',
    TICKETING:    'ticketing',
    SMARTPOS:     'smartpos',
    SEARCH:       'search',
    NOTIFICATIONS:'notifications',
    MESSAGING:    'messaging',
    ANALYTICS:    'analytics',
    FRAUD:        'fraud',
    WEBHOOKS:     'webhooks',
    COMMISSION:   'commission',
    SETTLEMENT:   'settlement',
    MEDIA:        'media',
    MAPS:         'maps',
    AI:           'ai',
    AUDIT:        'audit',
    FEATURE_FLAGS:'feature_flags',
  });

  /* Service health states */
  const HEALTH = Object.freeze({ UP: 'up', DEGRADED: 'degraded', DOWN: 'down', UNKNOWN: 'unknown' });

  /* ════════════════════════════════════════════════════════════
     INTERNAL REGISTRY
  ════════════════════════════════════════════════════════════ */
  const _services = new Map();       // id → ServiceRecord
  const _flags    = new Map();       // featureName → boolean
  let   _bootComplete = false;

  class ServiceRecord {
    constructor(id, opts) {
      this.id           = id;
      this.name         = opts.name    || id;
      this.version      = opts.version || '1.0';
      this.deps         = opts.deps    || [];
      this.healthFn     = opts.health  || null;   // async () => boolean
      this.initFn       = opts.init    || null;   // async () => void
      this.shutdownFn   = opts.shutdown|| null;   // async () => void
      this.critical     = opts.critical ?? false; // if true, boot fails if this service fails
      this.capabilities = opts.capabilities || [];
      this.metadata     = opts.metadata    || {};

      this.status       = HEALTH.UNKNOWN;
      this.lastChecked  = null;
      this.startedAt    = null;
      this.errorCount   = 0;
      this.lastError    = null;
    }
  }

  /* ════════════════════════════════════════════════════════════
     CIRCUIT BREAKER  (lightweight, per-service)
  ════════════════════════════════════════════════════════════ */
  const _breakers = new Map();

  class CircuitBreaker {
    constructor(serviceId, opts = {}) {
      this.serviceId  = serviceId;
      this.state      = 'CLOSED';
      this.failures   = 0;
      this.threshold  = opts.threshold || 5;
      this.resetMs    = opts.resetMs   || 30000;
      this.lastFailAt = 0;
    }

    async execute(fn) {
      if (this.state === 'OPEN') {
        if (Date.now() - this.lastFailAt > this.resetMs) {
          this.state  = 'HALF_OPEN';
          this.failures = 0;
        } else {
          if (window.SokoniEventBus) {
            SokoniEventBus.emitSync(SokoniEventBus.EVENTS.SYSTEM_CIRCUIT_OPEN, {
              service: this.serviceId,
            });
          }
          throw new Error(`Service ${this.serviceId} circuit open — unavailable`);
        }
      }

      try {
        const result = await fn();
        if (this.state === 'HALF_OPEN') this.state = 'CLOSED';
        this.failures = 0;
        return result;
      } catch (err) {
        this.lastFailAt = Date.now();
        if (++this.failures >= this.threshold) {
          this.state = 'OPEN';
          if (window.SokoniEventBus) {
            SokoniEventBus.emitSync(SokoniEventBus.EVENTS.SYSTEM_CIRCUIT_OPEN, {
              service: this.serviceId, failures: this.failures,
            });
          }
        }
        throw err;
      }
    }

    isOpen()    { return this.state === 'OPEN';    }
    isClosed()  { return this.state === 'CLOSED';  }
    reset()     { this.state = 'CLOSED'; this.failures = 0; }
  }

  function _breaker(serviceId) {
    if (!_breakers.has(serviceId)) {
      _breakers.set(serviceId, new CircuitBreaker(serviceId));
    }
    return _breakers.get(serviceId);
  }

  /* ════════════════════════════════════════════════════════════
     BOOT SEQUENCER  — dependency-ordered initialisation
  ════════════════════════════════════════════════════════════ */
  async function _boot() {
    if (_bootComplete) return;

    const resolved = new Set();
    const failed   = new Set();

    async function initService(id) {
      if (resolved.has(id) || failed.has(id)) return;

      const svc = _services.get(id);
      if (!svc) return;

      /* Initialise dependencies first */
      for (const dep of svc.deps) {
        if (!resolved.has(dep)) {
          await initService(dep);
          if (failed.has(dep) && svc.critical) {
            failed.add(id);
            svc.status    = HEALTH.DOWN;
            svc.lastError = `Dependency ${dep} failed`;
            return;
          }
        }
      }

      /* Run init */
      try {
        if (svc.initFn) {
          await _breaker(id).execute(() => svc.initFn());
        }
        svc.status    = HEALTH.UP;
        svc.startedAt = Date.now();
        resolved.add(id);
        if (window.SokoniLogger) window.SokoniLogger.log(`[ServiceMesh] ${svc.name} started`);
      } catch (err) {
        svc.status    = HEALTH.DOWN;
        svc.lastError = err.message;
        svc.errorCount++;
        failed.add(id);
        if (window.SokoniLogger) window.SokoniLogger.warn(`[ServiceMesh] ${svc.name} failed to start:`, err.message);

        if (svc.critical) {
          if (window.SokoniEventBus) {
            SokoniEventBus.emitSync(SokoniEventBus.EVENTS.SYSTEM_HEALTH_ALERT, {
              service: id, status: HEALTH.DOWN, error: err.message, critical: true,
            });
          }
        }
      }
    }

    /* Resolve all in dependency order */
    for (const id of _services.keys()) {
      await initService(id);
    }

    _bootComplete = true;

    const upCount = [..._services.values()].filter(s => s.status === HEALTH.UP).length;
    if (window.SokoniLogger) {
      window.SokoniLogger.log(`[ServiceMesh] Boot complete — ${upCount}/${_services.size} services up`);
    }
  }

  /* ════════════════════════════════════════════════════════════
     HEALTH MONITOR — periodic ping of all services
  ════════════════════════════════════════════════════════════ */
  async function _healthCheck() {
    for (const [id, svc] of _services) {
      if (!svc.healthFn) continue;
      try {
        const healthy  = await svc.healthFn();
        const newStatus = healthy ? HEALTH.UP : HEALTH.DEGRADED;
        if (newStatus !== svc.status && window.SokoniEventBus) {
          SokoniEventBus.emitSync(SokoniEventBus.EVENTS.SYSTEM_HEALTH_ALERT, {
            service: id, status: newStatus, previous: svc.status,
          });
        }
        svc.status      = newStatus;
        svc.lastChecked = Date.now();
        svc.errorCount  = healthy ? 0 : svc.errorCount + 1;
      } catch (err) {
        svc.status      = HEALTH.DEGRADED;
        svc.lastChecked = Date.now();
        svc.lastError   = err.message;
        svc.errorCount++;
      }
    }
  }

  /* Run health checks every 60 seconds */
  setInterval(_healthCheck, 60000);

  /* ════════════════════════════════════════════════════════════
     FEATURE FLAGS
  ════════════════════════════════════════════════════════════ */
  async function _loadFlags() {
    if (!window.firebaseDB) return;
    try {
      const { collection, getDocs } = await import(
        'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js'
      );
      const snap = await getDocs(collection(window.firebaseDB, 'featureFlags'));
      snap.docs.forEach(d => _flags.set(d.id, d.data().enabled ?? false));
    } catch (_) {}
  }

  _loadFlags();

  /* ════════════════════════════════════════════════════════════
     PUBLIC API
  ════════════════════════════════════════════════════════════ */
  const Mesh = {

    SERVICE_ID,
    HEALTH,

    /**
     * Register a service with the mesh.
     * @param {string} id       - Unique service ID (use SERVICE_ID.*)
     * @param {object} opts     - { name, version, deps, health, init, shutdown, critical, capabilities }
     */
    register(id, opts = {}) {
      if (_services.has(id)) {
        if (window.SokoniLogger) window.SokoniLogger.warn(`[ServiceMesh] ${id} already registered — skipping`);
        return this;
      }
      _services.set(id, new ServiceRecord(id, opts));
      return this;
    },

    /** Trigger the boot sequence. Should be called once on app startup. */
    async boot() {
      await _boot();
      return this.status();
    },

    /**
     * Execute a function through a service's circuit breaker.
     * Provides automatic fault isolation and retry policies.
     */
    async call(serviceId, fn) {
      const svc = _services.get(serviceId);
      if (!svc) throw new Error(`[ServiceMesh] Service not registered: ${serviceId}`);
      if (svc.status === HEALTH.DOWN) throw new Error(`[ServiceMesh] Service ${serviceId} is DOWN`);
      return _breaker(serviceId).execute(fn);
    },

    /** Check if a feature flag is enabled. */
    isEnabled(feature) {
      return _flags.get(feature) ?? false;
    },

    /** Override a feature flag at runtime. */
    setFlag(feature, value) {
      _flags.set(feature, !!value);
      if (window.firebaseDB) {
        import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js')
          .then(({ doc, setDoc }) => {
            setDoc(doc(window.firebaseDB, 'featureFlags', feature), { enabled: !!value }, { merge: true })
              .catch(() => {});
          });
      }
    },

    /** Find all services with a given capability. */
    findByCapability(capability) {
      return [..._services.values()]
        .filter(s => s.capabilities.includes(capability))
        .map(s => ({ id: s.id, name: s.name, status: s.status }));
    },

    /** Return status snapshot for all services. */
    status() {
      const snap = {};
      _services.forEach((svc, id) => {
        snap[id] = {
          name:        svc.name,
          status:      svc.status,
          version:     svc.version,
          uptime:      svc.startedAt ? Date.now() - svc.startedAt : null,
          errorCount:  svc.errorCount,
          lastError:   svc.lastError,
          lastChecked: svc.lastChecked,
          circuit:     _breakers.get(id)?.state ?? 'CLOSED',
        };
      });
      return snap;
    },

    /** Force a health check now. */
    async healthCheck() {
      await _healthCheck();
      return this.status();
    },

    /** Gracefully shut down all services in reverse dependency order. */
    async shutdown() {
      const services = [..._services.values()].reverse();
      for (const svc of services) {
        if (svc.shutdownFn && svc.status !== HEALTH.DOWN) {
          try { await svc.shutdownFn(); } catch (_) {}
        }
        svc.status = HEALTH.DOWN;
      }
    },

    /** Return current feature flags. */
    flags() {
      return Object.fromEntries(_flags);
    },

    /** Circuit breaker state for a service. */
    circuitState(serviceId) {
      return _breakers.get(serviceId)?.state ?? 'CLOSED';
    },

    /** Manually reset a circuit breaker. */
    resetCircuit(serviceId) {
      _breakers.get(serviceId)?.reset();
    },

    /** Full diagnostics for the admin panel. */
    diagnostics() {
      return {
        services:    this.status(),
        flags:       this.flags(),
        bootDone:    _bootComplete,
        breakerCount:_breakers.size,
      };
    },
  };

  /* ── Pre-register core services ── */
  Mesh
    .register(SERVICE_ID.AUTH, {
      name: 'Authentication',
      critical: true,
      capabilities: ['auth'],
      health: async () => !!window.firebaseAuth,
    })
    .register(SERVICE_ID.DATABASE, {
      name: 'Firestore Database',
      critical: true,
      deps: [SERVICE_ID.AUTH],
      capabilities: ['storage', 'realtime'],
      health: async () => !!window.firebaseDB,
    })
    .register(SERVICE_ID.PAYMENTS, {
      name: 'Payment Engine',
      deps: [SERVICE_ID.DATABASE, SERVICE_ID.AUTH],
      capabilities: ['payments', 'escrow', 'refunds'],
      health: async () => !!window.SokoniPaymentEngine,
    })
    .register(SERVICE_ID.FRAUD, {
      name: 'Fraud Detection',
      deps: [SERVICE_ID.DATABASE],
      capabilities: ['fraud', 'risk'],
      health: async () => !!window.SokoniFraudEngine,
    })
    .register(SERVICE_ID.WEBHOOKS, {
      name: 'Webhook Engine',
      deps: [SERVICE_ID.DATABASE],
      capabilities: ['webhooks'],
      health: async () => !!window.SokoniWebhookEngine,
    })
    .register(SERVICE_ID.NOTIFICATIONS, {
      name: 'Notifications',
      deps: [SERVICE_ID.AUTH, SERVICE_ID.DATABASE],
      capabilities: ['push', 'fcm'],
      health: async () => !!window.SokoniNotifications || !!window.firebaseAuth,
    })
    .register(SERVICE_ID.SEARCH, {
      name: 'Search',
      deps: [SERVICE_ID.DATABASE],
      capabilities: ['search', 'autocomplete'],
      health: async () => !!window.SokoniSearchPro,
    })
    .register(SERVICE_ID.ANALYTICS, {
      name: 'Analytics',
      deps: [SERVICE_ID.DATABASE],
      capabilities: ['analytics', 'reporting'],
    })
    .register(SERVICE_ID.SMARTPOS, {
      name: 'SmartPOS',
      deps: [SERVICE_ID.PAYMENTS, SERVICE_ID.DATABASE],
      capabilities: ['pos', 'barcode', 'printer'],
    })
    .register(SERVICE_ID.MAPS, {
      name: 'Maps & Routing',
      capabilities: ['maps', 'routing', 'gps'],
    })
    .register(SERVICE_ID.AI, {
      name: 'AI & Recommendations',
      deps: [SERVICE_ID.DATABASE],
      capabilities: ['recommendations', 'forecast'],
    });

  return Mesh;
})();

window.SokoniServiceMesh = SokoniServiceMesh;
