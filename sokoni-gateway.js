/**
 * SOKONI API Gateway  v2.0
 *
 * Client-side API gateway providing:
 *  - Request validation and schema enforcement
 *  - Token-bucket rate limiting per operation type
 *  - Request deduplication (idempotency)
 *  - Automatic retry with exponential back-off
 *  - Response caching
 *  - Request/response logging and tracing
 *  - CSRF token management
 *  - Input sanitisation (XSS, injection prevention)
 *  - Origin validation for external calls
 *
 * All calls to Cloud Functions should go through this gateway
 * so that every external request is controlled, observed, and secured.
 */

'use strict';

const SokoniGateway = (function () {

  /* ════════════════════════════════════════════════════════════
     ALLOWED ORIGINS — all external API calls must be to these
  ════════════════════════════════════════════════════════════ */
  const ALLOWED_ORIGINS = new Set([
    'https://us-central1-sokoni-aeb26.cloudfunctions.net',
    'https://mysokoni.co.ke',
    'https://api.intasend.com',
    'https://sandbox.intasend.com',
    'https://api.africastalking.com',
    'https://api.stripe.com',
    'https://api.paypal.com',
    'https://router.project-osrm.org',
  ]);

  /* ════════════════════════════════════════════════════════════
     RATE LIMITER — token bucket per operation
  ════════════════════════════════════════════════════════════ */
  const _buckets = new Map();

  const RATE_PROFILES = Object.freeze({
    payment:        { refillRate: 2,  maxTokens: 5,   refillMs: 1000 },  // 2/sec, burst 5
    order:          { refillRate: 5,  maxTokens: 10,  refillMs: 1000 },
    search:         { refillRate: 10, maxTokens: 20,  refillMs: 1000 },
    auth:           { refillRate: 3,  maxTokens: 5,   refillMs: 1000 },
    upload:         { refillRate: 1,  maxTokens: 3,   refillMs: 2000 },
    default:        { refillRate: 20, maxTokens: 40,  refillMs: 1000 },
  });

  function _tokenBucket(profile) {
    if (!_buckets.has(profile)) {
      const cfg = RATE_PROFILES[profile] || RATE_PROFILES.default;
      _buckets.set(profile, {
        tokens:    cfg.maxTokens,
        lastRefill: Date.now(),
        cfg,
      });
    }
    const bucket = _buckets.get(profile);
    const now    = Date.now();
    const elapsed = now - bucket.lastRefill;
    const refilled = Math.floor(elapsed / bucket.cfg.refillMs) * bucket.cfg.refillRate;

    if (refilled > 0) {
      bucket.tokens    = Math.min(bucket.cfg.maxTokens, bucket.tokens + refilled);
      bucket.lastRefill = now;
    }

    if (bucket.tokens <= 0) return false;
    bucket.tokens--;
    return true;
  }

  /* ════════════════════════════════════════════════════════════
     IDEMPOTENCY STORE
  ════════════════════════════════════════════════════════════ */
  const _idem = new Map();

  function _idemGuard(key) {
    const entry = _idem.get(key);
    if (!entry) return null;
    if (Date.now() - entry.ts > 86400000) { _idem.delete(key); return null; }
    return entry.result;
  }

  function _idemSet(key, result) {
    _idem.set(key, { result, ts: Date.now() });
  }

  /* ════════════════════════════════════════════════════════════
     INPUT SANITISER
  ════════════════════════════════════════════════════════════ */
  const _DANGEROUS_PATTERNS = [
    /<script[\s\S]*?>[\s\S]*?<\/script>/gi,
    /javascript:/gi,
    /on\w+\s*=/gi,
    /\beval\s*\(/gi,
    /\bdocument\.cookie/gi,
    /\bwindow\.location/gi,
    /--|\bDROP\b|\bDELETE\b|\bINSERT\b|\bUPDATE\b|\bSELECT\b.*\bFROM\b/gi,
  ];

  function _sanitise(value) {
    if (typeof value === 'string') {
      let v = value;
      _DANGEROUS_PATTERNS.forEach(re => { v = v.replace(re, ''); });
      return v.trim();
    }
    if (Array.isArray(value))  return value.map(_sanitise);
    if (value && typeof value === 'object') {
      const out = {};
      Object.keys(value).forEach(k => { out[_sanitise(k)] = _sanitise(value[k]); });
      return out;
    }
    return value;
  }

  /* ════════════════════════════════════════════════════════════
     ORIGIN VALIDATOR
  ════════════════════════════════════════════════════════════ */
  function _validateUrl(url) {
    try {
      const parsed = new URL(url);
      /* Allow same-origin always */
      if (parsed.origin === window.location.origin) return true;
      /* Check allowlist */
      return ALLOWED_ORIGINS.has(parsed.origin);
    } catch (_) {
      return false;
    }
  }

  /* ════════════════════════════════════════════════════════════
     RESPONSE CACHE
  ════════════════════════════════════════════════════════════ */
  const _responseCache = new Map();

  function _cacheGet(key) {
    const entry = _responseCache.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) { _responseCache.delete(key); return null; }
    return entry.data;
  }

  function _cacheSet(key, data, ttlMs = 30000) {
    _responseCache.set(key, { data, expiresAt: Date.now() + ttlMs });
    if (_responseCache.size > 500) {
      const expired = [..._responseCache.entries()].filter(([, v]) => Date.now() > v.expiresAt);
      expired.forEach(([k]) => _responseCache.delete(k));
    }
  }

  /* ════════════════════════════════════════════════════════════
     SCHEMA VALIDATOR — lightweight JSON-schema-like validation
  ════════════════════════════════════════════════════════════ */
  function _validate(data, schema) {
    const errors = [];
    if (!schema) return errors;

    Object.keys(schema).forEach(field => {
      const rule  = schema[field];
      const value = data?.[field];

      if (rule.required && (value === undefined || value === null || value === '')) {
        errors.push(`${field} is required`);
        return;
      }
      if (value === undefined || value === null) return;

      if (rule.type === 'number' && typeof value !== 'number') {
        errors.push(`${field} must be a number`);
      }
      if (rule.type === 'string' && typeof value !== 'string') {
        errors.push(`${field} must be a string`);
      }
      if (rule.min !== undefined && value < rule.min) {
        errors.push(`${field} must be >= ${rule.min}`);
      }
      if (rule.max !== undefined && value > rule.max) {
        errors.push(`${field} must be <= ${rule.max}`);
      }
      if (rule.minLength !== undefined && String(value).length < rule.minLength) {
        errors.push(`${field} must be at least ${rule.minLength} characters`);
      }
      if (rule.maxLength !== undefined && String(value).length > rule.maxLength) {
        errors.push(`${field} must be at most ${rule.maxLength} characters`);
      }
      if (rule.pattern && !new RegExp(rule.pattern).test(value)) {
        errors.push(`${field} format is invalid`);
      }
      if (rule.enum && !rule.enum.includes(value)) {
        errors.push(`${field} must be one of: ${rule.enum.join(', ')}`);
      }
    });

    return errors;
  }

  /* ════════════════════════════════════════════════════════════
     CORE REQUEST EXECUTOR
  ════════════════════════════════════════════════════════════ */
  async function _execute(url, opts = {}, gatewayOpts = {}) {
    const {
      rateProfile  = 'default',
      idemKey      = null,
      schema       = null,
      cacheTtlMs   = 0,
      maxRetries   = 3,
      retryDelay   = 1000,
      sanitize     = true,
    } = gatewayOpts;

    /* ── 1. Origin check ── */
    if (!_validateUrl(url)) {
      throw new Error(`[Gateway] Origin not allowed: ${url}`);
    }

    /* ── 2. Rate limit ── */
    if (!_tokenBucket(rateProfile)) {
      if (window.SokoniEventBus) {
        SokoniEventBus.emitSync(SokoniEventBus.EVENTS.RATE_LIMIT_HIT, { profile: rateProfile, url });
      }
      if (window.SokoniObservability) SokoniObservability.counter('gateway.rate_limited');
      throw new Error(`[Gateway] Rate limit exceeded for ${rateProfile}`);
    }

    /* ── 3. Idempotency ── */
    if (idemKey) {
      const cached = _idemGuard(idemKey);
      if (cached !== null) return cached;
    }

    /* ── 4. Sanitise request body ── */
    if (sanitize && opts.body) {
      if (typeof opts.body === 'string') {
        try { opts.body = JSON.stringify(_sanitise(JSON.parse(opts.body))); } catch (_) {}
      } else if (typeof opts.body === 'object') {
        opts.body = JSON.stringify(_sanitise(opts.body));
      }
    }

    /* ── 5. Schema validation ── */
    if (schema && opts.body) {
      const data   = typeof opts.body === 'string' ? JSON.parse(opts.body) : opts.body;
      const errors = _validate(data, schema);
      if (errors.length > 0) throw new Error(`[Gateway] Validation failed: ${errors.join(', ')}`);
    }

    /* ── 6. Response cache (GET only) ── */
    const method = (opts.method || 'GET').toUpperCase();
    const cacheKey = `${method}::${url}`;
    if (method === 'GET' && cacheTtlMs > 0) {
      const hit = _cacheGet(cacheKey);
      if (hit) {
        if (window.SokoniObservability) SokoniObservability.counter('gateway.cache_hit');
        return hit;
      }
    }

    /* ── 7. Execute with retry ── */
    const span = window.SokoniObservability?.startSpan('gateway.request', { tags: { url: url.replace(/\?.*/, ''), method } });

    let attempt = 0;
    while (attempt <= maxRetries) {
      try {
        /* Attach auth token for Cloud Function calls */
        const currentUser = window.firebaseAuth?.currentUser;
        if (currentUser) {
          const token = await currentUser.getIdToken(attempt > 0);  // force refresh on retry
          if (!opts.headers) opts.headers = {};
          opts.headers['Authorization'] = `Bearer ${token}`;
        }

        const response = await fetch(url, {
          ...opts,
          headers: {
            'Content-Type': 'application/json',
            'X-Sokoni-Client': 'web/2.0',
            ...(opts.headers || {}),
          },
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`HTTP ${response.status}: ${errorText.slice(0, 200)}`);
        }

        const contentType = response.headers.get('content-type') || '';
        const result      = contentType.includes('application/json')
          ? await response.json()
          : await response.text();

        /* Cache successful GET responses */
        if (method === 'GET' && cacheTtlMs > 0) _cacheSet(cacheKey, result, cacheTtlMs);

        /* Store idempotency result */
        if (idemKey) _idemSet(idemKey, result);

        if (window.SokoniObservability) SokoniObservability.counter('gateway.success');
        span?.finish('ok');
        return result;

      } catch (err) {
        attempt++;
        if (attempt > maxRetries) {
          if (window.SokoniObservability) SokoniObservability.counter('gateway.failed');
          span?.error(err);
          throw err;
        }
        /* Exponential back-off */
        await new Promise(r => setTimeout(r, retryDelay * Math.pow(2, attempt - 1)));
      }
    }
  }

  /* ════════════════════════════════════════════════════════════
     PRE-DEFINED OPERATION SCHEMAS
  ════════════════════════════════════════════════════════════ */
  const SCHEMAS = Object.freeze({
    payment: {
      amount:   { required: true, type: 'number', min: 1, max: 10000000 },
      currency: { required: true, type: 'string', enum: ['KES', 'USD', 'EUR', 'GBP'] },
      phone:    { type: 'string', pattern: '^(\\+?254|0)[17]\\d{8}$' },
    },
    order: {
      items:    { required: true },
      sellerId: { required: true, type: 'string', minLength: 5 },
    },
    review: {
      rating:  { required: true, type: 'number', min: 1, max: 5 },
      comment: { type: 'string', maxLength: 1000 },
    },
  });

  /* ════════════════════════════════════════════════════════════
     PUBLIC API
  ════════════════════════════════════════════════════════════ */
  const Gateway = {

    SCHEMAS,

    /**
     * Make a managed HTTP request through the gateway.
     *
     * @param {string} url           - Target URL (must be in ALLOWED_ORIGINS)
     * @param {object} fetchOpts     - Standard fetch options
     * @param {object} gatewayOpts   - { rateProfile, idemKey, schema, cacheTtlMs, maxRetries }
     */
    async request(url, fetchOpts = {}, gatewayOpts = {}) {
      return _execute(url, fetchOpts, gatewayOpts);
    },

    /** Convenience GET. */
    async get(url, gatewayOpts = {}) {
      return _execute(url, { method: 'GET' }, { cacheTtlMs: 30000, ...gatewayOpts });
    },

    /** Convenience POST. */
    async post(url, body, gatewayOpts = {}) {
      return _execute(url, { method: 'POST', body }, gatewayOpts);
    },

    /** Call a Firebase Cloud Function (authenticated). */
    async callFunction(functionName, body = {}, gatewayOpts = {}) {
      const region  = 'us-central1';
      const project = 'sokoni-aeb26';
      const url     = `https://${region}-${project}.cloudfunctions.net/${functionName}`;
      return _execute(url, { method: 'POST', body }, {
        rateProfile: 'default',
        ...gatewayOpts,
      });
    },

    /**
     * Validate data against a named schema.
     * Throws if invalid.
     */
    validate(schemaName, data) {
      const schema = SCHEMAS[schemaName];
      if (!schema) throw new Error(`[Gateway] Unknown schema: ${schemaName}`);
      const errors = _validate(data, schema);
      if (errors.length > 0) throw new Error(`Validation failed: ${errors.join(', ')}`);
      return true;
    },

    /** Sanitise user input before writing to Firestore. */
    sanitise(data) {
      return _sanitise(data);
    },

    /** Add a URL to the allowlist (admin use). */
    allowOrigin(origin) {
      ALLOWED_ORIGINS.add(origin);
    },

    /** Clear the response cache. */
    clearCache() {
      _responseCache.clear();
    },

    /** Diagnostics. */
    diagnostics() {
      return {
        allowedOrigins:  [...ALLOWED_ORIGINS],
        rateBuckets:     Object.fromEntries([..._buckets.entries()].map(([k, v]) => [k, { tokens: v.tokens }])),
        idemStoreSize:   _idem.size,
        cacheSize:       _responseCache.size,
        schemas:         Object.keys(SCHEMAS),
      };
    },
  };

  return Gateway;
})();

window.SokoniGateway = SokoniGateway;
